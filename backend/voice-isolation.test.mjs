// Voice isolation (backend/voice/): real speech (tests/fixtures/voice, CC BY 4.0) is mixed with
// synthetic music and hiss, every available engine pulls the speech back out, and the result is
// scored against the clean speech with SI-SDR. Tests that need something this computer may not
// have (the DPDFNet model, the sherpa-onnx package, macOS) are skipped with the reason shown.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateVoice, voiceEngines } from "./voice/isolate.mjs";
import { measureLag } from "./voice/lag.mjs";
import { DPDFNET_MODEL, ensureVoiceModel } from "./voice/model.mjs";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";
import { SAMPLE_RATE, SPEECH_CLIP, buildMixture, decodeSamples, siSdr, writeWav } from "../tests/voice-mix.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The tolerance for voice + background = original: both stems are 24-bit FLAC, so each sample
// can be off by about 6e-8; 1e-5 is 100 dB below full scale.
const SUM_TOLERANCE = 1e-5;

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-voice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

let mixtureCache = null;
async function mixture() {
  mixtureCache ??= buildMixture(await decodeSamples(SPEECH_CLIP));
  return mixtureCache;
}

async function mixtureFile(root, name = "mix.wav") {
  const file = join(root, name);
  await writeWav(file, (await mixture()).mixture);
  return file;
}

function maxDifference(voice, background, original, channels = 1) {
  let largest = 0;
  for (let i = 0; i < original.length; i += 1)
    largest = Math.max(largest, Math.abs(voice[Math.floor(i / channels)] + background[i] - original[i]));
  return largest;
}

/** Replaces an environment variable for one test. */
function setEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

// The DPDFNet tests run only when the model is already on this computer: KINO_VOICE_MODEL names
// it, or it is in the development data folder. Tests never download it.
const dpdfnetModel = [
  process.env.KINO_VOICE_MODEL,
  join(process.env.MOTION_DATA_DIR || join(ROOT, ".local", "data"), "models", DPDFNET_MODEL.file),
].find((file) => file && existsSync(file));
const sherpa = (await voiceEngines({ modelDir: tmpdir() })).find((entry) => entry.engine === "dpdfnet");
const skipWithoutDpdfnet = skipWithoutMediaTools
  || (!sherpa.available && `DPDFNet test skipped: ${sherpa.reason}`)
  || (!dpdfnetModel && `DPDFNet test skipped: the model is not on this computer. Set KINO_VOICE_MODEL to a copy of ${DPDFNET_MODEL.file} (${DPDFNET_MODEL.url}, SHA-256 ${DPDFNET_MODEL.sha256}).`);

test("measureLag finds how late one sound is behind another", () => {
  let seed = 7;
  const noise = Float32Array.from({ length: 100_000 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  });
  const late = new Float32Array(noise.length + 4000);
  late.set(noise.map((value) => 0.3 * value), 1234);
  const found = measureLag(noise, late, { maxLag: 4000 });
  assert.equal(found.lag, 1234);
  assert.ok(found.strength > 0.99, `strength ${found.strength}`);
  assert.equal(measureLag(noise, noise, { maxLag: 4000 }).lag, 0);
  assert.ok(measureLag(noise, new Float32Array(noise.length), { maxLag: 4000 }).strength === 0);
});

test("rnnoise cleans speech from music and hiss, the stems add up to the original, and a repeat is a cache hit", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const root = await folder(t);
  const source = await mixtureFile(root);
  const cacheDir = join(root, "cache");
  const { mixture: mixed, speech } = await mixture();
  const stages = [];
  const result = await isolateVoice({ source, engine: "rnnoise", cacheDir, onProgress: (step) => stages.push(step) });
  assert.equal(result.engine, "rnnoise");
  assert.equal(result.cached, false);
  assert.equal(result.path, result.voice);
  assert.ok(Math.abs(result.duration - mixed.length / SAMPLE_RATE) < 1e-6);
  const voice = await decodeSamples(result.voice);
  const background = await decodeSamples(result.background);
  assert.equal(voice.length, mixed.length);
  assert.equal(background.length, mixed.length);
  const gain = siSdr(speech, voice) - siSdr(speech, mixed);
  t.diagnostic(`rnnoise: SI-SDR ${siSdr(speech, mixed).toFixed(2)} dB -> ${siSdr(speech, voice).toFixed(2)} dB (gain ${gain.toFixed(2)} dB) in ${result.seconds.toFixed(2)} s`);
  assert.ok(gain >= 3, `rnnoise gain ${gain.toFixed(2)} dB`);
  assert.ok(maxDifference(voice, background, mixed) < SUM_TOLERANCE);
  assert.deepEqual([...new Set(stages.map((step) => step.stage))], ["decode", "isolate", "stems"]);
  assert.ok(stages.every((step, i) => i === 0 || step.fraction >= stages[i - 1].fraction), "progress only goes forward");

  const stem = JSON.parse(await readFile(join(cacheDir, result.key, "stem.json"), "utf8"));
  assert.equal(stem.engine, "rnnoise");
  assert.equal(stem.alignment.lag, 480, "RNNoise output is one 480-sample frame late, and kino measured it");
  assert.equal(stem.alignment.measured, true);
  assert.equal(stem.source.sha256, createHash("sha256").update(await readFile(source)).digest("hex"));
  assert.deepEqual((await readdir(cacheDir)).sort(), [result.key, "engine-lags.json"].sort(), "no work folder is left behind");

  const before = (await stat(result.voice)).mtimeMs;
  const repeatStages = [];
  const repeat = await isolateVoice({ source, engine: "rnnoise", keep: "background", cacheDir,
    onProgress: (step) => repeatStages.push(step.stage) });
  assert.equal(repeat.cached, true);
  assert.equal(repeat.path, result.background);
  assert.equal(repeat.key, result.key);
  assert.ok(!repeatStages.includes("isolate"), "the engine did not run again");
  assert.equal((await stat(result.voice)).mtimeMs, before);

  // A different amount is a different result; a stereo source keeps its two channels in the
  // background, and each channel still adds up.
  const stereo = new Float32Array(mixed.length * 2);
  for (let i = 0; i < mixed.length; i += 1) {
    stereo[2 * i] = mixed[i];
    stereo[2 * i + 1] = 0.5 * mixed[(i + 300) % mixed.length];
  }
  const stereoSource = join(root, "stereo.wav");
  await writeWav(stereoSource, stereo, 2);
  const half = await isolateVoice({ source: stereoSource, engine: "rnnoise", amount: 0.5, cacheDir });
  assert.notEqual(half.key, result.key);
  const halfVoice = await decodeSamples(half.voice);
  const halfBackground = await decodeSamples(half.background, 2);
  assert.equal(halfBackground.length, stereo.length);
  assert.ok(maxDifference(halfVoice, halfBackground, stereo, 2) < SUM_TOLERANCE);

  // Sound in the centre of a stereo mix is as loud in the mono voice stem as in each channel: with
  // amount 0 the voice stem is the whole sound and the background is silent.
  const centred = new Float32Array(mixed.length * 2);
  for (let i = 0; i < mixed.length; i += 1) centred[2 * i] = centred[2 * i + 1] = mixed[i];
  const centredSource = join(root, "centred.wav");
  await writeWav(centredSource, centred, 2);
  const none = await isolateVoice({ source: centredSource, engine: "rnnoise", amount: 0, cacheDir });
  assert.ok((await decodeSamples(none.background, 2)).every((sample) => Math.abs(sample) < SUM_TOLERANCE));
  const noneVoice = await decodeSamples(none.voice);
  assert.ok(noneVoice.every((sample, i) => Math.abs(sample - mixed[i]) < SUM_TOLERANCE));
});

test("DPDFNet raises speech SI-SDR by at least 10 dB, and its stems add up to the original", {
  skip: skipWithoutDpdfnet,
}, async (t) => {
  setEnv(t, "KINO_VOICE_MODEL", dpdfnetModel);
  const root = await folder(t);
  const source = await mixtureFile(root);
  const { mixture: mixed, speech } = await mixture();
  const result = await isolateVoice({ source, engine: "dpdfnet", cacheDir: join(root, "cache"), download: false });
  assert.equal(result.engine, "dpdfnet");
  const voice = await decodeSamples(result.voice);
  const background = await decodeSamples(result.background);
  const gain = siSdr(speech, voice) - siSdr(speech, mixed);
  t.diagnostic(`dpdfnet: SI-SDR ${siSdr(speech, mixed).toFixed(2)} dB -> ${siSdr(speech, voice).toFixed(2)} dB (gain ${gain.toFixed(2)} dB) in ${result.seconds.toFixed(2)} s`);
  assert.ok(gain >= 10, `dpdfnet gain ${gain.toFixed(2)} dB`);
  assert.ok(maxDifference(voice, background, mixed) < SUM_TOLERANCE);
  const stem = JSON.parse(await readFile(join(root, "cache", result.key, "stem.json"), "utf8"));
  assert.equal(stem.alignment.lag, 0);
  assert.match(stem.credit, /Ceva/);
});

/**
 * Starts a four-minute isolation, cancels it while the engine is running (cancelOn decides when),
 * and checks that the job stops at once and leaves nothing behind.
 */
async function cancelWhileRunning(t, engine, cancelOn) {
  const root = await folder(t);
  const { mixture: mixed } = await mixture();
  const long = new Float32Array(mixed.length * 36);
  for (let i = 0; i < 36; i += 1) long.set(mixed, i * mixed.length);
  const source = join(root, "long.wav");
  await writeWav(source, long);
  const cacheDir = join(root, "cache");
  const controller = new AbortController();
  let cancelledAt = 0, engineFraction = 0, progressAfterCancel = 0;
  const cancel = () => {
    if (cancelledAt) return;
    cancelledAt = performance.now();
    controller.abort();
  };
  const job = isolateVoice({ source, engine, cacheDir, download: false, signal: controller.signal, onProgress: (step) => {
    if (controller.signal.aborted) progressAfterCancel += 1;
    if (step.stage === "isolate") engineFraction = step.fraction;
    cancelOn(step, cancel);
  } });
  await assert.rejects(job, { name: "AbortError", message: "Voice isolation was cancelled." });
  assert.ok(cancelledAt > 0, "the job was cancelled while it ran");
  const stopSeconds = (performance.now() - cancelledAt) / 1000;
  t.diagnostic(`${engine}: stopped ${stopSeconds.toFixed(2)} s after cancelling, at ${(engineFraction * 100).toFixed(0)}% overall`);
  // A full run of four minutes takes several seconds even for the fastest engine.
  assert.ok(stopSeconds < 1.5, `the job stopped ${stopSeconds.toFixed(2)} s after cancelling`);
  assert.ok(engineFraction < 0.5, `the engine was stopped early (overall progress ${engineFraction})`);
  assert.equal(progressAfterCancel, 0);
  assert.deepEqual(await readdir(cacheDir), [], "the half-made result was removed");
}

test("cancelling stops the rnnoise engine at once and removes the partial result", {
  skip: skipWithoutMediaTools,
}, (t) => cancelWhileRunning(t, "rnnoise", (step, cancel) => {
  if (step.stage === "isolate") cancel();
}));

test("cancelling kills a running DPDFNet process at once and removes the partial result", {
  skip: skipWithoutDpdfnet,
}, (t) => {
  setEnv(t, "KINO_VOICE_MODEL", dpdfnetModel);
  // DPDFNet reports progress after every 30 seconds of sound, so cancel half a second after the
  // decode finishes, while the first piece is still being cleaned.
  return cancelWhileRunning(t, "dpdfnet", (step, cancel) => {
    if (step.stage === "decode" && step.fraction === 0.05) setTimeout(cancel, 500);
  });
});

/** Builds the kino-voice helper from its Swift source once per source version, in the temp folder. */
async function appleHelper() {
  const source = join(ROOT, "backend", "voice", "kino-voice.swift");
  const hash = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 16);
  const helperFolder = join(tmpdir(), `kino-voice-helper-${hash}`);
  const binary = join(helperFolder, "kino-voice");
  if (existsSync(binary)) return binary;
  await mkdir(helperFolder, { recursive: true });
  const partial = `${binary}.${process.pid}`;
  const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;
  await run("xcrun", ["swiftc", "-O", "-target", target, source, "-o", partial]);
  await chmod(partial, 0o755);
  await rename(partial, binary);
  return binary;
}

const skipWithoutApple = skipWithoutMediaTools
  || (process.platform !== "darwin" && "Apple sound isolation test skipped: it needs macOS")
  || (Number(release().split(".")[0]) < 22 && "Apple sound isolation test skipped: it needs macOS 13 or later")
  || (spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status !== 0
    && "Apple sound isolation test skipped: the Swift compiler (Xcode command line tools) is not installed");

test("Apple sound isolation output is late, and kino measures and trims the delay", {
  skip: skipWithoutApple,
}, async (t) => {
  setEnv(t, "KINO_VOICE_HELPER", await appleHelper());
  const root = await folder(t);
  const source = await mixtureFile(root);
  const { mixture: mixed, speech } = await mixture();
  const result = await isolateVoice({ source, engine: "apple", cacheDir: join(root, "cache") });
  assert.equal(result.engine, "apple");
  const stem = JSON.parse(await readFile(join(root, "cache", result.key, "stem.json"), "utf8"));
  t.diagnostic(`apple (${stem.engineDetails.mode}, macOS ${stem.engineDetails.macOS}): output was ${stem.alignment.lag} samples late (strength ${stem.alignment.strength})`);
  assert.equal(stem.alignment.measured, true);
  assert.ok(stem.alignment.lag > 0, "the audio unit output arrives late");
  const voice = await decodeSamples(result.voice);
  // After trimming, the voice lines up with the clean speech in both directions.
  assert.equal(measureLag(speech, voice, { maxLag: 24000 }).lag, 0);
  assert.equal(measureLag(voice, speech, { maxLag: 24000 }).lag, 0);
  const gain = siSdr(speech, voice) - siSdr(speech, mixed);
  t.diagnostic(`apple: SI-SDR gain ${gain.toFixed(2)} dB in ${result.seconds.toFixed(2)} s`);
  assert.ok(gain >= 3, `apple gain ${gain.toFixed(2)} dB`);
  assert.ok(maxDifference(voice, await decodeSamples(result.background), mixed) < SUM_TOLERANCE);
});

test("without the model and with downloads off, DPDFNet says what to do and auto uses another engine", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  setEnv(t, "KINO_VOICE_MODEL", undefined);
  const root = await folder(t);
  const modelDir = join(root, "models");
  await assert.rejects(ensureVoiceModel({ modelDir, download: false }), (error) => {
    assert.equal(error.code, "VOICE_MODEL_UNAVAILABLE");
    assert.match(error.message, /one-time 10\.6 MB model download/);
    assert.match(error.message, /use engine "rnnoise", which works offline/);
    return true;
  });
  // A damaged model file is never used.
  await mkdir(modelDir);
  await writeFile(join(modelDir, DPDFNET_MODEL.file), "not the model");
  await assert.rejects(ensureVoiceModel({ modelDir, download: false }), { code: "VOICE_MODEL_UNAVAILABLE" });

  const source = await mixtureFile(root);
  const cacheDir = join(root, "cache");
  if (sherpa.available) {
    await assert.rejects(isolateVoice({ source, engine: "dpdfnet", cacheDir, modelDir, download: false }),
      { code: "VOICE_MODEL_UNAVAILABLE" });
  }
  const result = await isolateVoice({ source, engine: "auto", cacheDir, modelDir, download: false });
  assert.ok(["apple", "rnnoise"].includes(result.engine), result.engine);
  assert.match(result.note, /^Skipped dpdfnet: /);
  t.diagnostic(`auto used ${result.engine}: ${result.note}`);
  assert.deepEqual((await readdir(cacheDir)).filter((name) => name.startsWith(".work-")), []);
});

test("when the Apple helper fails, apple says why and auto moves on to rnnoise", {
  skip: skipWithoutMediaTools
    || (process.platform !== "darwin" && "Apple helper failure test skipped: the apple engine is only offered on macOS")
    || (Number(release().split(".")[0]) < 22 && "Apple helper failure test skipped: the apple engine needs macOS 13 or later"),
}, async (t) => {
  const root = await folder(t);
  // A stand-in helper that fails the way a broken one would: a message and a non-zero exit.
  const broken = join(root, "kino-voice");
  await writeFile(broken, "#!/bin/sh\necho 'sound isolation audio unit not found' >&2\nexit 3\n");
  await chmod(broken, 0o755);
  setEnv(t, "KINO_VOICE_HELPER", broken);
  setEnv(t, "KINO_VOICE_MODEL", undefined);
  const source = await mixtureFile(root);
  const cacheDir = join(root, "cache");
  await assert.rejects(isolateVoice({ source, engine: "apple", cacheDir }), (error) => {
    assert.equal(error.code, "VOICE_ENGINE_FAILED");
    assert.match(error.message, /^Apple voice isolation could not run: .*sound isolation audio unit not found/);
    return true;
  });
  const result = await isolateVoice({ source, engine: "auto", cacheDir, modelDir: join(root, "models"), download: false });
  assert.equal(result.engine, "rnnoise");
  assert.match(result.note, /apple: Apple voice isolation could not run: /);
  assert.deepEqual((await readdir(cacheDir)).filter((name) => name.startsWith(".work-")), []);
});

test("a file without sound gets a plain error", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await folder(t);
  const video = join(root, "silent.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10:d=0.5", "-c:v", "mpeg4", video]);
  await assert.rejects(isolateVoice({ source: video, engine: "rnnoise", cacheDir: join(root, "cache") }),
    { code: "VOICE_NO_SOUND", message: "silent.mp4 has no sound to isolate." });
  assert.deepEqual(await readdir(join(root, "cache")), []);
});

