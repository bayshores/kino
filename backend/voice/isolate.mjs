// Voice isolation: splits the sound of a video or audio file into a "voice" stem (the dialogue)
// and a "background" stem (everything else), on this computer only. An agent can then clean up
// dialogue or turn the music down under it.
//
// What happens, in order:
//   1. The file's bytes and the settings make a cache key; a finished result for that key is
//      returned at once.
//   2. FFmpeg decodes the first sound track to 48 kHz mono 32-bit float (input.wav).
//   3. One engine keeps the voice (raw.wav), in its own process so cancelling kills it:
//        dpdfnet  DPDFNet model through sherpa-onnx (best; 10.6 MB model downloaded once),
//        apple    Apple's sound isolation audio unit through the kino-voice helper (macOS 13+),
//        rnnoise  FFmpeg's arnndn filter with the RNNoise model bundled in assets/voice (offline).
//   4. Engines can return their output late; the delay is measured by cross-correlation and cut.
//   5. FFmpeg writes two 24-bit FLAC stems: voice = amount × isolated + (1 − amount) × original
//      (mono), and background = original − voice (the original's channels, at most two), so the
//      two stems added together give back the original.
//   6. stem.json records how the stems were made. The folder is renamed into place last, so a
//      half-written result is never found.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, release } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegCommand, runMediaTool } from "../media-probe.mjs";
import { measureLag } from "./lag.mjs";
import { DPDFNET_MODEL, ensureVoiceModel, sha256File, voiceModelReady } from "./model.mjs";
import { readSamples, readWavInfo } from "./wav.mjs";

export const VOICE_ENGINES = Object.freeze(["auto", "dpdfnet", "apple", "rnnoise"]);
export const STEM_KINDS = Object.freeze(["voice", "background"]);

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SAMPLE_RATE = 48000;
// Bump when the stems a given input produces would change, so old cache entries are not reused.
const STEM_FORMAT = 1;
const RUNNER = fileURLToPath(new URL("./dpdfnet-runner.mjs", import.meta.url));
const RNNOISE_MODEL = fileURLToPath(new URL("../../assets/voice/std.rnnn", import.meta.url));
const RNNOISE_MODEL_SHA256 = "6b8943dc4a9b6b24425873992a44f29c0577503276456af46a8854774faeb294";
// The longest delay looked for when lining an engine's output up with its input.
const MAX_LAG = { dpdfnet: 4800, apple: 24000, rnnoise: 4800 };
// Used only when a delay cannot be measured (the output is silent) and none was measured before:
// DPDFNet through sherpa-onnx is not late, and RNNoise works in 480-sample frames at 48 kHz.
const DEFAULT_LAG = { dpdfnet: 0, apple: 0, rnnoise: 480 };
const LAG_WINDOW = 1 << 19;
const MAX_ERROR = 4000;

function abortError(signal) {
  const error = new Error("Voice isolation was cancelled.", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}

function engineError(message, code = "VOICE_ENGINE_UNAVAILABLE") {
  return Object.assign(new Error(message), { code });
}

function defaultModelDir() {
  return join(process.env.MOTION_DATA_DIR || join(ROOT, ".local", "data"), "models");
}

/** The kino-voice helper (Apple sound isolation), or null when this computer does not have it. */
export function voiceHelperPath() {
  const candidates = [
    process.env.KINO_VOICE_HELPER,
    process.resourcesPath && join(process.resourcesPath, "bin", "kino-voice"),
    join(ROOT, ".local", "macos-tools", "dist", "bin", "kino-voice"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function appleUnavailableReason() {
  if (process.platform !== "darwin") return "Apple voice isolation is only on macOS.";
  if (Number(release().split(".")[0]) < 22) return "Apple voice isolation needs macOS 13 or later.";
  if (!voiceHelperPath()) return "The kino-voice helper is not built; run npm run desktop:tools, or set KINO_VOICE_HELPER.";
  return null;
}

function sherpaUnavailableReason() {
  const platform = process.platform === "win32" ? "win" : process.platform;
  try {
    const require = createRequire(import.meta.url);
    require.resolve("sherpa-onnx-node");
    require.resolve(`sherpa-onnx-${platform}-${process.arch}/sherpa-onnx.node`);
    return null;
  } catch {
    return `The sherpa-onnx-node package for ${platform}-${process.arch} is not installed (it is an optional dependency).`;
  }
}

/**
 * Which engines this computer can use: [{ engine, available, reason, modelDownloaded? }].
 * "auto" is not listed; it picks the first available of dpdfnet, apple, rnnoise.
 */
export async function voiceEngines({ modelDir = defaultModelDir() } = {}) {
  const sherpa = sherpaUnavailableReason();
  const apple = appleUnavailableReason();
  return [
    { engine: "dpdfnet", available: !sherpa, reason: sherpa, modelDownloaded: await voiceModelReady(modelDir) },
    { engine: "apple", available: !apple, reason: apple },
    { engine: "rnnoise", available: true, reason: null },
  ];
}

/** Runs a program; calls onLine for each line it prints. Cancelling kills it. */
function runProcess(command, args, { cwd, env, signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "", pending = "", killTimer;
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      // Lines already on their way are dropped after a cancel, so no progress follows it.
      for (const line of lines) if (!signal?.aborted) onLine?.(line.trim());
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_ERROR); });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error.code === "ENOENT" ? engineError(`${basename(command)} was not found.`) : error);
    });
    child.once("close", (code, terminatingSignal) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (pending.trim() && !signal?.aborted) onLine?.(pending.trim());
      if (signal?.aborted) reject(abortError(signal));
      else if (code === 0) resolve();
      else reject(Object.assign(new Error(`${basename(command)} failed (${code ?? terminatingSignal}): ${stderr.trim() || "no message"}`),
        { exitCode: code }));
    });
  });
}

function progressLine(line, report) {
  const match = /^progress ([0-9.]+)$/.exec(line);
  if (match) report(Math.min(1, Number(match[1])));
}

async function runDpdfnet({ input, output, model, signal, onFraction }) {
  // Inside the Mac app the service is an Electron process; ELECTRON_RUN_AS_NODE makes the app's
  // executable behave as plain Node for the runner.
  const electron = Boolean(process.versions.electron);
  const command = electron ? process.env.KINO_ELECTRON_EXECUTABLE || process.execPath : process.execPath;
  const env = { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
  const threads = Math.max(1, Math.min(4, availableParallelism() - 1));
  try {
    await runProcess(command, [RUNNER, input, output, model, String(threads)], { env, signal,
      onLine: (line) => progressLine(line, onFraction) });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw engineError(`DPDFNet could not run: ${error.message}`, "VOICE_ENGINE_FAILED");
  }
  return { variant: `${DPDFNET_MODEL.file}@${DPDFNET_MODEL.sha256.slice(0, 12)}` };
}

async function runApple({ input, output, signal, onFraction }) {
  let result = null;
  try {
    await runProcess(voiceHelperPath(), [input, output, "--mode", "high-quality"], { signal, onLine: (line) => {
      progressLine(line, onFraction);
      // A garbled line is ignored here (throwing inside a stream event would escape the promise);
      // a missing result is reported below.
      if (line.startsWith("result ")) try { result = JSON.parse(line.slice("result ".length)); } catch { result = null; }
    } });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw engineError(`Apple voice isolation could not run: ${error.message}`, "VOICE_ENGINE_FAILED");
  }
  if (!result) throw engineError("kino-voice finished without reporting a result.", "VOICE_ENGINE_FAILED");
  return { variant: `${result.mode} ${result.macOS}`, details: { mode: result.mode, macOS: result.macOS } };
}

async function runRnnoise({ input, output, work, frames, signal, onFraction }) {
  // FFmpeg reads the model from the work folder by a plain relative name, so the path needs no
  // filter-graph escaping (and the copy can be read out of the Mac app's archive).
  await writeFile(join(work, "std.rnnn"), await readFile(RNNOISE_MODEL));
  // mix=1 is arnndn's documented default, but Ubuntu 24.04's FFmpeg 6.1.1 passes the sound through
  // almost unchanged with float output unless it is written out.
  await runProcess(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-progress", "pipe:1", "-i", basename(input),
    "-af", "arnndn=m=std.rnnn:mix=1", "-c:a", "pcm_f32le", "-f", "wav", basename(output)], { cwd: work, signal, onLine: (line) => {
    const match = /^out_time_us=(\d+)$/.exec(line);
    if (match && frames > 0) onFraction(Math.min(1, Number(match[1]) / 1e6 / (frames / SAMPLE_RATE)));
  } });
  return { variant: `std.rnnn@${RNNOISE_MODEL_SHA256.slice(0, 12)}` };
}

/**
 * How many samples `rawPath` runs behind `inputPath`, measured on the loudest 11 seconds of the
 * engine output (where the voice is). Returns { lag, strength }.
 */
function findLag(inputPath, rawPath, maxLag) {
  const inputInfo = readWavInfo(inputPath);
  const rawInfo = readWavInfo(rawPath);
  if (rawInfo.sampleRate !== SAMPLE_RATE || rawInfo.channels !== 1)
    throw engineError(`The isolation engine returned ${rawInfo.sampleRate} Hz, ${rawInfo.channels}-channel sound instead of 48 kHz mono.`, "VOICE_ENGINE_FAILED");
  const window = Math.min(LAG_WINDOW, inputInfo.frames);
  const inputFile = openSync(inputPath, "r");
  const rawFile = openSync(rawPath, "r");
  try {
    // Pick the loudest stretch of the output, in one-second steps, so the voice is in it.
    const energies = [];
    for (let from = 0; from < inputInfo.frames; from += SAMPLE_RATE) {
      const block = readSamples(rawFile, rawInfo, from, SAMPLE_RATE);
      let energy = 0;
      for (const sample of block) energy += sample * sample;
      energies.push(energy);
    }
    const blocks = Math.max(1, Math.ceil(window / SAMPLE_RATE));
    let best = 0, bestEnergy = -1;
    for (let first = 0; first + blocks <= Math.max(blocks, energies.length); first += 1) {
      let energy = 0;
      for (let i = first; i < first + blocks && i < energies.length; i += 1) energy += energies[i];
      if (energy > bestEnergy) { bestEnergy = energy; best = first; }
    }
    const start = Math.max(0, Math.min(best * SAMPLE_RATE, inputInfo.frames - window));
    const reference = readSamples(inputFile, inputInfo, start, window);
    const late = readSamples(rawFile, rawInfo, start, window + maxLag);
    return measureLag(reference, late, { maxLag, window });
  } finally {
    closeSync(inputFile);
    closeSync(rawFile);
  }
}

async function rememberedLags(cacheDir) {
  try { return JSON.parse(await readFile(join(cacheDir, "engine-lags.json"), "utf8")); }
  catch { return {}; }
}

/**
 * The original sound as the background stem keeps it: 48 kHz float, mono or stereo (more channels
 * are mixed down to stereo). The engines get the average of its channels, so a voice in the centre
 * of a stereo mix is exactly as loud in the mono copy as in each channel, and subtracting the
 * isolated voice from each channel removes it. (FFmpeg's own stereo-to-mono mix adds the channels
 * at 71% each, which would make the voice 41% too loud.)
 */
function originalChain(channels) {
  return `aresample=${SAMPLE_RATE},aformat=sample_fmts=flt:channel_layouts=${channels === 1 ? "mono" : "stereo"}`;
}

/**
 * The FFmpeg filter graph that lines up the engine output and makes the two stems.
 * Inputs: 0 = the source file, 1 = input.wav (the decoded mono sound), 2 = raw.wav (engine output).
 * The sums are done by `amerge` (which puts the inputs side by side as channels) and `pan` (which
 * adds and subtracts channels). FFmpeg's `amix` filter is not used because it ignores negative
 * weights (FFmpeg 9.0.2 adds instead of subtracting).
 */
function stemGraph({ lag, frames, amount, channels }) {
  const wet = amount.toFixed(6), dry = (1 - amount).toFixed(6);
  // After merging the original (one or two channels) with the voice, the voice is the last channel.
  const subtract = channels === 1 ? "mono|c0=c0-c1" : "stereo|c0=c0-c2|c1=c1-c2";
  return [
    `[2:a]atrim=start_sample=${lag},asetpts=N/SR/TB,apad=whole_len=${frames},atrim=end_sample=${frames}[isolated]`,
    `[1:a]atrim=end_sample=${frames},asetpts=N/SR/TB[dry]`,
    `[isolated][dry]amerge=inputs=2,pan=mono|c0=${wet}*c0+${dry}*c1,asplit=2[voice][voicecopy]`,
    `[0:a:0]${originalChain(channels)},asetpts=N/SR/TB[original]`,
    `[original][voicecopy]amerge=inputs=2,pan=${subtract}[background]`,
  ].join(";");
}

async function probeSound(source, signal) {
  const text = await runMediaTool("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries",
    "stream=channels", "-of", "json", source], { signal });
  const probe = JSON.parse(text);
  const stream = probe.streams?.[0];
  if (!stream) throw Object.assign(new Error(`${basename(source)} has no sound to isolate.`), { code: "VOICE_NO_SOUND" });
  return { channels: Math.max(1, Math.min(2, Number(stream.channels) || 1)) };
}

function checkOptions({ source, engine, amount, keep, cacheDir }) {
  if (typeof source !== "string" || !source) throw new TypeError("isolateVoice needs a source file path.");
  if (typeof cacheDir !== "string" || !cacheDir) throw new TypeError("isolateVoice needs a cacheDir.");
  if (!VOICE_ENGINES.includes(engine)) throw new RangeError(`engine must be one of ${VOICE_ENGINES.join(", ")}.`);
  if (!STEM_KINDS.includes(keep)) throw new RangeError(`keep must be "voice" or "background".`);
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1)
    throw new RangeError("amount must be a number from 0 to 1.");
}

async function cachedResult(folder, keep) {
  try {
    const stem = JSON.parse(await readFile(join(folder, "stem.json"), "utf8"));
    const voice = join(folder, "voice.flac"), background = join(folder, "background.flac");
    await Promise.all([stat(voice), stat(background)]);
    return { stem, voice, background, path: keep === "voice" ? voice : background };
  } catch {
    return null;
  }
}

/**
 * Splits the sound of `source` into voice and background stems.
 *
 * Options:
 *   source      path of a video or audio file (its first sound track is used)
 *   engine      "auto" (default), "dpdfnet", "apple" or "rnnoise"
 *   amount      0 to 1 (default 1): how much of the non-voice sound the voice stem loses;
 *               1 keeps only the voice, 0.75 turns the rest down by about 12 dB
 *   keep        "voice" (default) or "background": which stem `path` points at
 *   cacheDir    folder for results, one subfolder per cache key
 *   modelDir    folder for the DPDFNet model (default <MOTION_DATA_DIR>/models)
 *   download    false stops the one-time model download (default true)
 *   signal      AbortSignal; cancelling kills the running engine and removes partial files
 *   onProgress  called with { stage, fraction }; stage is "download" (fraction of the model
 *               download), "decode", "isolate" or "stems" (fraction of the whole job)
 *
 * Resolves with { path, voice, background, engine, seconds, duration, cached, key, note }:
 * `path` is the kept stem, `engine` the engine that ran, `seconds` how long this call took,
 * `duration` the sound's length in seconds, and `note` (or null) says why "auto" skipped an engine.
 */
export async function isolateVoice({
  source, engine = "auto", amount = 1, keep = "voice", cacheDir, modelDir = defaultModelDir(),
  download = true, signal, onProgress,
} = {}) {
  const started = performance.now();
  checkOptions({ source, engine, amount, keep, cacheDir });
  if (signal?.aborted) throw abortError(signal);
  const report = (stage, fraction) => onProgress?.({ stage, fraction: Math.max(0, Math.min(1, fraction)) });
  let sourceHash;
  try {
    sourceHash = await sha256File(source, signal);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }

  // "auto" tries the engines best first and says in `note` why it skipped one.
  const candidates = engine === "auto" ? ["dpdfnet", "apple", "rnnoise"] : [engine];
  const skipped = [];
  let lastError = null;
  for (const name of candidates) {
    const unavailable = name === "dpdfnet" ? sherpaUnavailableReason() : name === "apple" ? appleUnavailableReason() : null;
    if (unavailable) {
      if (engine !== "auto") throw engineError(unavailable);
      skipped.push(`${name}: ${unavailable}`);
      continue;
    }
    try {
      const result = await isolateWith(name, { source, sourceHash, amount, keep, cacheDir, modelDir, download, signal, report });
      return { ...result, seconds: (performance.now() - started) / 1000,
        note: skipped.length ? `Skipped ${skipped.join(" ")}` : null };
    } catch (error) {
      const recoverable = ["VOICE_MODEL_UNAVAILABLE", "VOICE_ENGINE_UNAVAILABLE", "VOICE_ENGINE_FAILED"].includes(error?.code);
      if (engine !== "auto" || !recoverable || signal?.aborted) throw error;
      skipped.push(`${name}: ${error.message}`);
      lastError = error;
    }
  }
  throw lastError ?? engineError(`No voice isolation engine is available. ${skipped.join(" ")}`);
}

async function isolateWith(engine, { source, sourceHash, amount, keep, cacheDir, modelDir, download, signal, report }) {
  let model = null;
  if (engine === "dpdfnet") model = await ensureVoiceModel({ modelDir, download, signal, onProgress: (f) => report("download", f) });
  const engineId = engine === "dpdfnet" ? `${DPDFNET_MODEL.file}@${DPDFNET_MODEL.sha256}`
    // Apple's audio unit can change with macOS, so a new macOS version makes new stems.
    : engine === "apple" ? `kino-voice high-quality darwin ${release().split(".")[0]}` : `std.rnnn@${RNNOISE_MODEL_SHA256}`;
  const key = createHash("sha256")
    .update(JSON.stringify({ format: STEM_FORMAT, source: sourceHash, engine, engineId, amount }))
    .digest("hex").slice(0, 32);
  const folder = join(cacheDir, key);
  const hit = await cachedResult(folder, keep);
  if (hit) {
    report("stems", 1);
    return { path: hit.path, voice: hit.voice, background: hit.background, engine, duration: hit.stem.duration,
      cached: true, key };
  }

  await mkdir(cacheDir, { recursive: true });
  const work = await mkdtemp(join(cacheDir, ".work-"));
  try {
    report("decode", 0);
    const { channels } = await probeSound(source, signal);
    const input = join(work, "input.wav");
    const raw = join(work, "raw.wav");
    await runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-i", source, "-map", "0:a:0", "-vn",
      "-af", `${originalChain(channels)}${channels === 1 ? "" : ",pan=mono|c0=0.5*c0+0.5*c1"}`,
      "-c:a", "pcm_f32le", "-f", "wav", input], { signal });
    const { frames } = readWavInfo(input);
    if (frames === 0) throw Object.assign(new Error(`${basename(source)} has no sound to isolate.`), { code: "VOICE_NO_SOUND" });
    report("decode", 0.05);

    const onFraction = (fraction) => report("isolate", 0.05 + 0.85 * fraction);
    const run = engine === "dpdfnet" ? await runDpdfnet({ input, output: raw, model, signal, onFraction })
      : engine === "apple" ? await runApple({ input, output: raw, signal, onFraction })
        : await runRnnoise({ input, output: raw, work, frames, signal, onFraction });
    if (signal?.aborted) throw abortError(signal);

    // Line the engine output up with the input. A silent output has nothing to measure, so the
    // last delay measured for this engine on this computer (or a known default) is used instead.
    const lags = await rememberedLags(cacheDir);
    const lagKey = `${engine} ${run.variant}`;
    const measuredLag = findLag(input, raw, MAX_LAG[engine]);
    const measured = measuredLag.strength >= 0.2;
    const lag = measured ? measuredLag.lag : lags[lagKey] ?? DEFAULT_LAG[engine];
    if (measured && lags[lagKey] !== lag)
      await writeFile(join(cacheDir, "engine-lags.json"), `${JSON.stringify({ ...lags, [lagKey]: lag }, null, 2)}\n`).catch(() => {});
    report("stems", 0.9);

    const flac = ["-c:a", "flac", "-sample_fmt", "s32"];
    await runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-i", source, "-i", input, "-i", raw,
      "-filter_complex", stemGraph({ lag, frames, amount, channels }),
      "-map", "[voice]", ...flac, join(work, "voice.flac"),
      "-map", "[background]", ...flac, join(work, "background.flac")], { signal });
    const duration = frames / SAMPLE_RATE;
    const stem = {
      format: STEM_FORMAT, engine, engineDetails: run.details ?? null, amount, sampleRate: SAMPLE_RATE, duration,
      source: { name: basename(source), sha256: sourceHash },
      voice: { file: "voice.flac", channels: 1 }, background: { file: "background.flac", channels },
      alignment: { lag, measured, strength: Number(measuredLag.strength.toFixed(3)) },
      createdAt: new Date().toISOString(),
      credit: engine === "dpdfnet" ? "DPDFNet by Ceva (Apache-2.0) through sherpa-onnx by k2-fsa (Apache-2.0)"
        : engine === "apple" ? "Apple AUSoundIsolation (macOS)" : "RNNoise by Xiph.Org and Mozilla (BSD-3-Clause) through FFmpeg arnndn",
    };
    await Promise.all([rm(input, { force: true }), rm(raw, { force: true }), rm(join(work, "std.rnnn"), { force: true })]);
    await writeFile(join(work, "stem.json"), `${JSON.stringify(stem, null, 2)}\n`);
    try {
      await rename(work, folder);
    } catch (error) {
      // Another call finished the same stems first; theirs are identical.
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      await rm(work, { recursive: true, force: true });
      const other = await cachedResult(folder, keep);
      if (!other) throw error;
      report("stems", 1);
      return { path: other.path, voice: other.voice, background: other.background, engine, duration, cached: true, key };
    }
    report("stems", 1);
    const voice = join(folder, "voice.flac"), background = join(folder, "background.flac");
    return { path: keep === "voice" ? voice : background, voice, background, engine, duration, cached: false, key };
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }
}
