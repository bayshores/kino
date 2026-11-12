// Measuring a video for its fingerprint (backend/measure/fingerprint.mjs), on this computer only.
//
// What happens, in order:
//   1. FFmpeg decodes the video at 12 frames a second, at most 640 pixels on the long side, to raw
//      BGRA bytes, one FFmpeg at a time. kino measures small copies only: Inspire's 360p download
//      or a draft render; the render check measures frames kino draws itself (measureRendered).
//   2. For each frame kino works out plain numbers itself (brightness, sharpness,
//      a color histogram) and sends the frame to the kino-measure helper (kino-measure.swift,
//      Apple Vision) with the jobs it wants for that frame:
//        every frame       optical flow from the frame before
//        4 a second        text recognition
//        shot middles      a feature print and where the eye goes (saliency boxes)
//   3. The helper answers one JSON line a frame; fingerprint.mjs turns it all into numbers.
//
// Without the helper (not a Mac, macOS too old, the helper not built, or KINO_MEASURE_HELPER=none)
// only kino's own numbers are measured; the fingerprint says which Vision numbers are missing and
// why, and never makes them up.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegCommand } from "../media-probe.mjs";
import { ffmpegArgs, lowerIfBackground } from "../render-activity.mjs";
import { fingerprint, pixelStats, shotPrints } from "./fingerprint.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = path.join(ROOT, "backend", "measure", "kino-measure.swift");
const HELPER_OFF = "none";

/** Frames a second kino samples, how often it reads text, and the longest side it measures at. */
export const SAMPLE_FPS = 12;
export const TEXT_EVERY = 3;
export const MEASURE_SIDE = 640;
/** At most this many shots get a feature print (a 90 s clip rarely has more). */
export const MAX_PRINTS = 150;
// Palette pixels taken from one frame a second.
const PALETTE_PIXELS = 64;
const JOBS = { flow: 1, text: 2, print: 4, saliency: 8 };
/** Live frames (onFrame) are the text frames, 4 a second; at most this many wait for the helper. */
const LIVE_WAITING = 24;

function abortError() {
  const error = new Error("Measuring was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * The kino-measure helper, or null. KINO_MEASURE_HELPER names one (or "none" turns Vision off);
 * then the Mac app's bundled one; then one built by npm run desktop:tools. In a checkout on a Mac
 * with the Swift compiler, kino builds it from kino-measure.swift once into the temporary folder
 * (named by the source's hash), so the browser development path measures too.
 */
export async function measureHelperPath({ build = true, fromSource = false } = {}) {
  if (process.env.KINO_MEASURE_HELPER === HELPER_OFF) return null;
  // A newer job than the bundled helper knows (people): this checkout's source, built once.
  if (fromSource) return process.platform === "darwin" && !process.env.KINO_MEASURE_HELPER && existsSync(SOURCE) ? buildFromSource() : null;
  const candidates = [
    process.env.KINO_MEASURE_HELPER,
    process.resourcesPath && path.join(process.resourcesPath, "bin", "kino-measure"),
    path.join(ROOT, ".local", "macos-tools", "dist", "bin", "kino-measure"),
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (found || !build || process.platform !== "darwin" || !existsSync(SOURCE)) return found ?? null;
  return buildFromSource();
}

let building = null;
async function buildFromSource() {
  building ??= (async () => {
    if (spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status !== 0) return null;
    const hash = createHash("sha256").update(await readFile(SOURCE)).digest("hex").slice(0, 16);
    const folder = path.join(os.tmpdir(), `kino-measure-helper-${hash}`);
    const binary = path.join(folder, "kino-measure");
    if (existsSync(binary)) return binary;
    await mkdir(folder, { recursive: true });
    const partial = `${binary}.${process.pid}`;
    const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;
    const made = spawnSync("xcrun", ["swiftc", "-O", "-target", target, SOURCE, "-o", partial], { stdio: "ignore" });
    if (made.status !== 0) return null;
    await chmod(partial, 0o755);
    await rename(partial, binary);
    return binary;
  })();
  return building;
}

const abilityCache = new Map();
/**
 * What this computer's Vision can do: {flow, text, print, saliency}, each true or the
 * reason it cannot (a sentence), plus {helper, macOS} when the helper ran.
 */
export async function measureAbilities() {
  const none = (reason) => ({ flow: reason, text: reason, print: reason, saliency: reason, people: reason, foreground: reason });
  if (process.env.KINO_MEASURE_HELPER === HELPER_OFF) return none("Apple Vision is turned off (KINO_MEASURE_HELPER=none)");
  if (process.platform !== "darwin" && !process.env.KINO_MEASURE_HELPER) return none("Apple Vision is only on macOS");
  const helper = await measureHelperPath();
  if (!helper) return none("the kino-measure helper is not built (npm run desktop:tools, or install the Xcode command line tools)");
  if (!abilityCache.has(helper)) {
    abilityCache.set(helper, new Promise((resolve) => {
      const child = spawn(helper, ["--abilities"], { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      child.once("error", (error) => resolve({ error: error.message }));
      child.once("close", (code) => { try { resolve(code === 0 ? JSON.parse(text) : { error: `exit ${code}` }); } catch { resolve({ error: "it printed something kino cannot read" }); } });
    }));
  }
  const info = await abilityCache.get(helper);
  if (info.error) return none(`the kino-measure helper could not start: ${info.error}`);
  return {
    flow: info.flow ? true : `optical flow needs macOS 11 or later (this Mac has ${info.macOS})`,
    text: info.text ? true : "text recognition is missing",
    print: info.print ? true : "feature prints are missing",
    saliency: info.saliency ? true : "saliency is missing",
    // false on macOS before 12; undefined from a helper built before people were found.
    people: info.people === true ? true : info.people,
    // The subject mask's boxes (foreground): false before macOS 14, undefined from an older helper.
    foreground: info.foreground === true ? true : info.foreground,
    // The sound classifier (--sounds): false before macOS 12, undefined from an older helper.
    sounds: info.sounds === true ? true : info.sounds,
    helper, macOS: info.macOS,
  };
}

/** The size kino measures a width × height picture at: the long side at most 640, even. */
export function measureSize(width, height, side = MEASURE_SIDE) {
  const scale = Math.min(1, side / Math.max(width, height));
  const even = (value) => Math.max(16, 2 * Math.round((value * scale) / 2));
  return { width: even(width), height: even(height) };
}

/**
 * A session with the helper: send(jobs, bgra) for each frame in order, then finish() resolves to
 * the helper's answers, one object a frame ({} for frames it was not asked about). Without a
 * helper, every answer is {}.
 */
export function helperSession(helper, { width, height, signal, onAnswer }) {
  if (!helper) return { send: async () => {}, finish: async () => ({ answers: [], error: null }) };
  const child = spawn(helper, ["--width", String(width), "--height", String(height)], { stdio: ["pipe", "pipe", "pipe"] });
  lowerIfBackground(child);
  const answers = [];
  let pending = "", stderr = "", failed = null;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let answer;
      try { answer = JSON.parse(line); answers[answer.i] = answer; } catch { failed ??= "the helper printed a line kino cannot read"; continue; }
      try { onAnswer?.(answer); } catch { /* a live view must never stop the measure */ }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => {
    child.once("error", (error) => { failed ??= error.message; resolve(); });
    child.once("close", (code) => { if (code !== 0 && !signal?.aborted) failed ??= stderr.trim().split("\n").at(-1) || `exit ${code}`; resolve(); });
  });
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    async send(jobs, bgra) {
      if (failed || child.exitCode != null) return;
      const first = child.stdin.write(Buffer.from([jobs]));
      const second = child.stdin.write(bgra);
      // The helper is behind: wait until it has taken what was sent (or has stopped).
      if (!(first && second)) await Promise.race([new Promise((resolve) => child.stdin.once("drain", resolve)), closed]);
    },
    async finish() {
      child.stdin.end();
      await closed;
      signal?.removeEventListener("abort", onAbort);
      return { answers, error: failed };
    },
  };
}

/**
 * The words Vision reads in one picture (PNG or JPEG bytes): [{box: [x, y, w, h] fractions from the
 * top left, s: the words, c: confidence}], or null when this computer has no text reader (not macOS,
 * no helper, Vision off). Used to confirm a saved type label's lettering box (font-like.mjs labelTypes).
 */
// GUESS: the long side a frame is read at, at least.
const READ_SIDE = 1280;
export async function readPictureText(bytes) {
  const abilities = await measureAbilities();
  if (abilities.text !== true) return null;
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(bytes);
  // A small frame (a 240 px strip frame) is drawn larger first: Vision's fast reader finds no line in it as it is.
  const scale = Math.max(1, READ_SIDE / Math.max(image.width, image.height));
  const width = 2 * Math.round((image.width * scale) / 2), height = 2 * Math.round((image.height * scale) / 2);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const bgra = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) { bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1]; bgra[i + 2] = rgba[i]; bgra[i + 3] = 255; }
  const session = helperSession(abilities.helper, { width, height });
  await session.send(JOBS.text, bgra);
  const { answers, error } = await session.finish();
  if (error) return null;
  return Array.isArray(answers[0]?.text) ? answers[0].text : [];
}

/** Folds the helper's answers into the records, and says which jobs could not run and why. */
function joinAnswers(records, answers, abilities, error) {
  const vision = {};
  for (const job of Object.keys(JOBS)) vision[job] = error ? `the kino-measure helper stopped: ${error}` : abilities[job];
  const failures = {};
  records.forEach((record, index) => {
    const answer = answers[index] ?? {};
    for (const job of Object.keys(JOBS)) if (answer[job] !== undefined) record[job] = answer[job];
    for (const [job, why] of Object.entries(answer.errors ?? {})) if (why !== "no previous picture") failures[job] ??= why;
  });
  // A job that failed on every frame it was asked for is missing; one that worked sometimes stays.
  for (const [job, why] of Object.entries(failures)) if (vision[job] === true && !records.some((record) => record[job] != null)) vision[job] = `Vision could not: ${why}`;
  return vision;
}

/**
 * Measures a video file: its first `seconds` at most. `cuts` are its hard cut times (from
 * backend/shot-detection.mjs); without them kino finds them first. Resolves to
 * {fingerprint, prints: [{t, q, k}] (one per shot), cuts}, and with `keepRecords` the measured
 * records too (to study a measure; they are large). `onFrame` is called for 4 frames a second, as
 * the helper answers for each: {t, seconds, width, height, bgra, flow, text} (flow and text are the
 * helper's answers, or null), so a screen can show what is being measured as it happens.
 */
export async function measureVideo(file, { seconds, cuts = null, width, height, signal, onProgress, onFrame, keepRecords = false } = {}) {
  if (signal?.aborted) throw abortError();
  if (!(width > 0 && height > 0) || !(seconds > 0)) {
    const { probeVideo } = await import("../cutout/cutout.mjs");
    const probed = await probeVideo(file, signal);
    width ||= probed.width; height ||= probed.height;
    seconds = Math.min(seconds || Infinity, probed.duration || seconds || 0);
  }
  if (!cuts) {
    const { findShots } = await import("../shot-detection.mjs");
    cuts = (await findShots(file, { duration: seconds, signal })).shots.slice(1).map((shot) => shot.start).filter((time) => time < seconds);
  }
  const size = measureSize(width, height);
  const abilities = await measureAbilities();
  const helper = Object.keys(JOBS).some((job) => abilities[job] === true) ? abilities.helper : null;
  // The frame nearest the middle of each shot gets a feature print (at most MAX_PRINTS shots).
  const edges = [0, ...cuts, seconds];
  const middles = new Set(edges.slice(0, -1).map((start, index) => Math.round(((start + edges[index + 1]) / 2) * SAMPLE_FPS)).slice(0, MAX_PRINTS));
  const records = [];
  // Live frames for the screen: a text frame waits here until the helper has answered for it.
  const live = new Map();
  const tell = (index, answer) => {
    try { onFrame?.({ t: index / SAMPLE_FPS, seconds, ...size, bgra: live.get(index), flow: answer?.flow ?? null, text: answer?.text ?? null }); }
    catch { /* a live view must never stop the measure */ }
    live.delete(index);
  };
  const session = helperSession(helper, { ...size, signal, onAnswer: (answer) => { if (live.has(answer.i)) tell(answer.i, answer); } });
  const frameBytes = size.width * size.height * 4;
  const decode = spawn(ffmpegCommand(), ffmpegArgs(["-hide_banner", "-nostdin", "-v", "error", "-t", String(seconds), "-i", file, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `fps=${SAMPLE_FPS},scale=${size.width}:${size.height}:flags=area,format=bgra`, "-f", "rawvideo", "pipe:1"]), { stdio: ["ignore", "pipe", "pipe"] });
  lowerIfBackground(decode);
  let decodeError = "";
  decode.stderr.setEncoding("utf8").on("data", (chunk) => { decodeError = (decodeError + chunk).slice(-1000); });
  const onAbort = () => decode.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let current = Buffer.alloc(frameBytes), filled = 0;
    for await (const chunk of decode.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - offset);
        chunk.copy(current, filled, offset, offset + take);
        filled += take; offset += take;
        if (filled < frameBytes) continue;
        const index = records.length;
        const stats = pixelStats(current, size.width, size.height, { palettePixels: index % SAMPLE_FPS === 0 ? PALETTE_PIXELS : 0 });
        records.push({ t: index / SAMPLE_FPS, ...(index > 0 ? { dt: 1 / SAMPLE_FPS } : {}), stats });
        let jobs = index > 0 ? JOBS.flow : 0;
        if (index % TEXT_EVERY === 0) jobs |= JOBS.text;
        if (middles.has(index)) jobs |= JOBS.print | JOBS.saliency;
        if (onFrame && index % TEXT_EVERY === 0) {
          live.set(index, current);
          if (!helper) tell(index, null);
          else if (live.size > LIVE_WAITING) live.delete(live.keys().next().value);
        }
        await session.send(jobs, current);
        current = Buffer.alloc(frameBytes); filled = 0;
        if (index % SAMPLE_FPS === 0) onProgress?.(Math.min(1, index / SAMPLE_FPS / seconds));
      }
    }
    const code = decode.exitCode ?? await new Promise((resolve) => decode.once("close", resolve));
    if (signal?.aborted) throw abortError();
    if (code !== 0 && !records.length) throw new Error(`FFmpeg could not decode the video: ${decodeError.trim().split("\n").at(-1) || `exit ${code}`}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const { answers, error } = await session.finish();
  if (signal?.aborted) throw abortError();
  const vision = joinAnswers(records, answers, abilities, error);
  const measured = Math.min(seconds, records.length / SAMPLE_FPS);
  return {
    fingerprint: fingerprint(records, { ...size, seconds: measured, cuts: cuts.filter((time) => time < measured), dense: true, vision }),
    prints: vision.print === true ? shotPrints(records) : [],
    cuts,
    ...(keepRecords ? { records, size, vision } : {}),
  };
}

/**
 * Measures frames kino renders itself (the reference_drift check). `pairTimes` is [[a, b]]: flow is
 * measured from a to b (b about 1/12 s later); text and a feature print are read on a (prints at
 * most one a second). `render(times)` resolves to [{time, pixels (RGBA), width, height}], and is
 * called a few pairs at a time so only a few frames are held at once. Resolves to
 * {fingerprint, prints}.
 */
export async function measureRendered(pairTimes, { render, seconds, signal, chunk = 12 } = {}) {
  if (!pairTimes.length) return null;
  const abilities = await measureAbilities();
  const helper = Object.keys(JOBS).some((job) => abilities[job] === true) ? abilities.helper : null;
  let session = null, size = null;
  const records = [];
  let lastPrint = -Infinity;
  for (let start = 0; start < pairTimes.length; start += chunk) {
    if (signal?.aborted) throw abortError();
    const part = pairTimes.slice(start, start + chunk);
    const frames = await render(part.flat());
    for (let index = 0; index < part.length; index += 1) {
      const a = frames[index * 2], b = frames[index * 2 + 1];
      size ??= { width: a.width, height: a.height };
      session ??= helperSession(helper, { ...size, signal });
      const printHere = a.time - lastPrint >= 1;
      if (printHere) lastPrint = a.time;
      records.push({ t: a.time, stats: pixelStats(a.pixels, a.width, a.height, { order: "rgba", palettePixels: printHere ? PALETTE_PIXELS : 0 }) });
      await session.send(JOBS.text | (printHere ? JOBS.print | JOBS.saliency : 0), Buffer.from(rgbaToBgra(a.pixels)));
      records.push({ t: b.time, dt: b.time - a.time, stats: pixelStats(b.pixels, b.width, b.height, { order: "rgba" }) });
      await session.send(JOBS.flow, Buffer.from(rgbaToBgra(b.pixels)));
    }
  }
  const { answers, error } = await session.finish();
  const vision = joinAnswers(records, answers, abilities, error);
  return {
    fingerprint: fingerprint(records, { ...size, seconds, cuts: [], dense: false, vision }),
    prints: vision.print === true ? shotPrints(records) : [],
  };
}

function rgbaToBgra(pixels) {
  const out = new Uint8Array(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    out[index] = pixels[index + 2]; out[index + 1] = pixels[index + 1]; out[index + 2] = pixels[index]; out[index + 3] = pixels[index + 3];
  }
  return out;
}
