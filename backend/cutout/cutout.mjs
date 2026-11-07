// Subject cut-out: finds the subject of a video or still image (a person, an animal, a product)
// and writes it as a matte, on this computer only. The edit op cut_out (cutout-operation.mjs)
// turns the matte into a new layer: the subject on a transparent background, the matte itself
// (white subject on black, for create_mask), or a solid-colour silhouette (for outlines and glows).
//
// What happens, in order:
//   1. The file's bytes, the engine and this Mac's version make a cache key; a finished matte for
//      that key is used at once.
//   2. FFmpeg decodes the picture to raw BGRA at most 1920 pixels on the long side, on an even
//      frame grid (the file's own frame rate). A still image is decoded by @napi-rs/canvas instead,
//      which turns a phone photo upright as browsers do (FFmpeg ignores the EXIF orientation).
//   3. The kino-cutout helper (kino-cutout.swift, Apple Vision) writes one matte per picture:
//        subject  VNGenerateForegroundInstanceMaskRequest (macOS 14+): any subject that stands out
//        person   VNGeneratePersonSegmentationRequest (macOS 12+): people only
//      Nothing is downloaded: the models are part of macOS. No other engine is used (COMPATIBILITY.md
//      "Subject cut-out" says why there is no cross-platform model).
//   4. A five-frame temporal median steadies the edges (matte.mjs): a matte found frame by frame
//      flickers where the subject meets the background, and the median removes that flicker
//      without dragging an edge that really moves.
//   5. The steadied matte is kept losslessly (FFV1 in Matroska, or raw bytes for a still) with
//      matte.json, in a folder that is renamed into place last, so a half-written one is never found.
//   6. An output is made from the matte: grown or shrunk and feathered (matte.mjs), scaled up to
//      the file's size, and written as VP9 WebM with transparency (subject, silhouette), H.264 MP4
//      (matte) or PNG (stills). A clip's subject has its edge cleaned of the background first
//      (edges.mjs). media.mjs adds it to the media library.
//
// Memory stays small for long clips: frames stream through pipes, and only five mattes (about
// 2 MB each at 1080p) are held at a time.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegCommand, parseFrameRate, runMediaTool } from "../media-probe.mjs";
import { sha256File } from "../voice/model.mjs";
import { createEdgeRefiner, createPlateBuilder } from "./edges.mjs";
import { createSteadier, finishMatte } from "./matte.mjs";

export const CUTOUT_ENGINES = Object.freeze(["auto", "subject", "person"]);
export const CUTOUT_OUTPUTS = Object.freeze(["subject", "matte", "silhouette"]);

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Bump when the matte a given input produces would change, so old cache entries are not reused.
const MATTE_FORMAT = 1;
// The longest side Vision is given. Vision's own models work at a lower size, and the matte is
// scaled up to the file's size at the end; this keeps a 4K clip as quick as a 1080p one.
const ANALYSIS_SIDE = 1920;
// A matte with less than this share of its pixels at half or more has no subject in it.
const EMPTY_SHARE = 0.0005;
const MAX_ERROR = 4000;
// The steadying window: 2 × 2 + 1 = 5 frames (measured in COMPATIBILITY.md "Subject cut-out").
const STEADY_RADIUS = 2;

const require = createRequire(import.meta.url);

function abortError(signal) {
  const error = new Error("The cut-out was cancelled.", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}

const HELPER_OFF = "none";

export function cutoutError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * The kino-cutout helper (Apple Vision), or null when this computer does not have it.
 * KINO_CUTOUT_HELPER names one by hand; tests use it for a stand-in that speaks the same protocol
 * (backend/cutout.test.stand-in.mjs), which is also the only way a helper is used off macOS.
 * KINO_CUTOUT_HELPER=none turns Apple Vision off, even on a Mac that has the helper (the
 * look-source golden frames are drawn without Vision's boxes).
 */
export function cutoutHelperPath() {
  if (process.env.KINO_CUTOUT_HELPER === HELPER_OFF) return null;
  const candidates = [
    process.env.KINO_CUTOUT_HELPER,
    process.resourcesPath && join(process.resourcesPath, "bin", "kino-cutout"),
    join(ROOT, ".local", "macos-tools", "dist", "bin", "kino-cutout"),
    // npm run desktop:cutout builds only this helper (a few seconds), outside dist so the full
    // npm run desktop:tools build still finds its output folder empty.
    join(ROOT, ".local", "macos-tools", "helpers", "kino-cutout"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

// What the helper says this Mac can do ({version, macOS, subject, person}), asked once per helper.
const helperInfos = new Map();
function helperInfo(helper) {
  if (!helperInfos.has(helper)) {
    helperInfos.set(helper, new Promise((resolve) => {
      const child = spawn(helper, ["--engines"], { stdio: ["ignore", "pipe", "pipe"] });
      let text = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => resolve({ error: error.message }));
      child.once("close", (code) => {
        try { resolve(code === 0 ? JSON.parse(text) : { error: stderr.trim() || `exit ${code}` }); }
        catch { resolve({ error: `kino-cutout --engines printed ${JSON.stringify(text.slice(0, 80))}` }); }
      });
    }));
  }
  return helperInfos.get(helper);
}

function majorVersion(macOS) {
  return Number(String(macOS ?? "").split(".")[0]) || 0;
}

/**
 * Which engines this computer can use: [{ engine, available, reason }]. "auto" is not listed; it
 * picks subject, then person.
 */
export async function cutoutEngines() {
  const reasons = { subject: null, person: null };
  let info = null;
  if (process.env.KINO_CUTOUT_HELPER === HELPER_OFF) {
    reasons.subject = reasons.person = "Apple Vision is turned off (KINO_CUTOUT_HELPER=none).";
  } else if (process.platform !== "darwin" && !process.env.KINO_CUTOUT_HELPER) {
    reasons.subject = reasons.person = "Subject cut-out uses Apple Vision, which is only on macOS.";
  } else {
    const helper = cutoutHelperPath();
    if (!helper) reasons.subject = reasons.person = "The kino-cutout helper is not built; run npm run desktop:cutout (builds only it, a few seconds), or set KINO_CUTOUT_HELPER.";
    else {
      info = await helperInfo(helper);
      if (info.error) reasons.subject = reasons.person = `The kino-cutout helper could not start: ${info.error}`;
      else {
        if (!info.subject) reasons.subject = `The subject engine needs macOS 14 or later (this Mac has ${info.macOS}).`;
        if (!info.person) reasons.person = `The person engine needs macOS 12 or later (this Mac has ${info.macOS}).`;
      }
    }
  }
  return ["subject", "person"].map((engine) => ({ engine, available: !reasons[engine], reason: reasons[engine],
    ...(info && !info.error ? { macOS: info.macOS, helper: info.version } : {}) }));
}

/** The size Vision is given: the picture's size, scaled down to at most ANALYSIS_SIDE, even. */
export function analysisSize(width, height) {
  const scale = Math.min(1, ANALYSIS_SIDE / Math.max(width, height));
  const even = (value) => Math.max(2, 2 * Math.round((value * scale) / 2));
  return scale === 1 && width % 2 === 0 && height % 2 === 0 ? { width, height } : { width: even(width), height: even(height) };
}

/**
 * Facts about a video file's picture: { width, height } as shown (a rotated phone video is
 * upright), its frame `rate` as FFmpeg writes it ("30000/1001"), `fps`, `duration`, `lead` (how
 * many seconds after the file's start its first picture is) and its colour tags.
 */
export async function probeVideo(source, signal) {
  const text = await runMediaTool("ffprobe", ["-v", "error", "-select_streams", "V:0", "-show_entries",
    "stream=width,height,avg_frame_rate,r_frame_rate,start_time,duration,color_space,color_transfer,color_primaries:stream_side_data=rotation:stream_tags=rotate:format=start_time,duration",
    "-of", "json", source], { signal });
  const probe = JSON.parse(text);
  const stream = probe.streams?.[0];
  if (!stream) throw cutoutError(`${basename(source)} has no picture to cut out.`, "CUTOUT_NO_PICTURE");
  let width = Number(stream.width) || 0, height = Number(stream.height) || 0;
  const rotation = Number(stream.side_data_list?.find((item) => item.rotation != null)?.rotation ?? stream.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  if (!width || !height) throw cutoutError(`${basename(source)} has no picture size.`, "CUTOUT_NO_PICTURE");
  const valid = (rate) => parseFrameRate(rate) > 0 && parseFrameRate(rate) <= 240;
  const rate = valid(stream.avg_frame_rate) ? stream.avg_frame_rate : valid(stream.r_frame_rate) ? stream.r_frame_rate : "30";
  const start = Number(probe.format?.start_time), streamStart = Number(stream.start_time);
  const lead = Number.isFinite(streamStart) ? Math.max(0, streamStart - (Number.isFinite(start) ? start : 0)) : 0;
  const duration = Number(stream.duration) || Number(probe.format?.duration) || 0;
  const colour = {};
  for (const [field, flag] of [["color_space", "-colorspace"], ["color_transfer", "-color_trc"], ["color_primaries", "-color_primaries"]])
    if (typeof stream[field] === "string" && stream[field] !== "unknown" && /^[a-z0-9-]+$/.test(stream[field])) colour[flag] = stream[field];
  return { width, height, rate, fps: parseFrameRate(rate), duration, lead: lead > 0.0005 ? lead : 0, colour };
}

/** Runs a child process with its standard streams; resolves when it exits 0. */
function track(child, label, signal) {
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_ERROR); });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(error.code === "ENOENT" ? cutoutError(`${label} was not found.`, "CUTOUT_ENGINE_UNAVAILABLE") : error));
    child.once("close", (code, terminatingSignal) => {
      if (signal?.aborted) reject(abortError(signal));
      else if (code === 0) resolve();
      else reject(Object.assign(new Error(`${label} failed (${code ?? terminatingSignal}): ${stderr.trim() || "no message"}`), { exitCode: code, label }));
    });
  });
}

/**
 * Collects a byte stream into whole frames of `size` bytes and calls `onFrame(frame)` for each
 * one; returns a function that takes chunks.
 */
function frameCollector(size, onFrame) {
  let current = new Uint8Array(size), filled = 0;
  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(size - filled, chunk.length - offset);
      current.set(chunk.subarray(offset, offset + take), filled);
      filled += take; offset += take;
      if (filled === size) { onFrame(current); current = new Uint8Array(size); filled = 0; }
    }
  };
}

function killAll(children) {
  for (const child of children) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    timer.unref?.();
  }
}

/**
 * Streams a video through FFmpeg → kino-cutout → the steadier → FFV1. Returns { frames, empty }.
 */
async function analyseVideo({ source, video, size, engine, helper, matteFile, signal, onFraction }) {
  const { width, height } = size;
  const decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-i", source, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `fps=fps=${video.rate}:round=near,scale=${width}:${height}:flags=area,format=bgra`,
    "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgra", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  const cut = spawn(helper, ["--width", String(width), "--height", String(height), "--engine", engine], { stdio: ["pipe", "pipe", "pipe"] });
  const encode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
    "-s", `${width}x${height}`, "-r", video.rate, "-i", "pipe:0", "-c:v", "ffv1", "-level", "3", "-f", "matroska", matteFile],
  { stdio: ["pipe", "ignore", "pipe"] });
  const children = [decode, cut, encode];
  const onAbort = () => killAll(children);
  signal?.addEventListener("abort", onAbort, { once: true });
  // A process that stops early closes its pipe; the process feeding it then gets EPIPE, which is
  // reported through the stopped process's own error instead.
  for (const stream of [cut.stdin, encode.stdin, decode.stdout, cut.stdout]) stream.on("error", () => {});
  decode.stdout.pipe(cut.stdin);

  const expected = Math.max(1, Math.round(video.duration * video.fps));
  const steadier = createSteadier({ width, height, radius: STEADY_RADIUS });
  const pixels = width * height;
  let frames = 0, empty = 0;
  const write = (mattes) => {
    let ok = true;
    for (const matte of mattes) {
      let on = 0;
      for (let i = 0; i < pixels; i += 1) if (matte[i] >= 128) on += 1;
      if (on < pixels * EMPTY_SHARE) empty += 1;
      frames += 1;
      ok = encode.stdin.write(matte) && ok;
    }
    if (mattes.length) onFraction?.(Math.min(1, frames / expected));
    return ok;
  };
  const collect = frameCollector(pixels, (matte) => {
    if (!write(steadier.push(matte))) {
      cut.stdout.pause();
      encode.stdin.once("drain", () => cut.stdout.resume());
    }
  });
  cut.stdout.on("data", collect);
  cut.stdout.once("end", () => {
    write(steadier.finish());
    encode.stdin.end();
  });
  try {
    // When one process fails the others are stopped (FFmpeg would otherwise wait for ever to write
    // into a pipe nobody reads any more), and the first failure is the one reported.
    let first = null;
    const watch = (child, label) => track(child, label, signal).catch((error) => {
      first ??= { label, error };
      killAll(children);
      throw error;
    });
    await Promise.allSettled([watch(decode, "FFmpeg"), watch(cut, "kino-cutout"), watch(encode, "FFmpeg")]);
    if (signal?.aborted) throw abortError(signal);
    if (first?.label === "kino-cutout") throw cutoutError(`Apple Vision could not cut out the subject: ${first.error.message}`, "CUTOUT_ENGINE_FAILED");
    if (first) throw first.error;
  } catch (error) {
    killAll(children);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (frames === 0) throw cutoutError(`${basename(source)} has no picture to cut out.`, "CUTOUT_NO_PICTURE");
  return { frames, empty };
}

/** A still image as RGBA bytes at its own (upright) size and at `size`, read by @napi-rs/canvas. */
async function readImage(source, size) {
  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const image = await loadImage(await readFile(source));
  const draw = (width, height) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  };
  const full = draw(image.width, image.height);
  return { width: image.width, height: image.height, rgba: full,
    small: size ? draw(size.width, size.height) : null };
}

/** Runs the helper on one picture (BGRA bytes) and returns its matte. */
async function cutOnePicture({ helper, engine, size, bgra, signal }) {
  const child = spawn(helper, ["--width", String(size.width), "--height", String(size.height), "--engine", engine], { stdio: ["pipe", "pipe", "pipe"] });
  const onAbort = () => killAll([child]);
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin.on("error", () => {});
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end(bgra);
  try { await track(child, "kino-cutout", signal); }
  catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw cutoutError(`Apple Vision could not cut out the subject: ${error.message}`, "CUTOUT_ENGINE_FAILED");
  } finally { signal?.removeEventListener("abort", onAbort); }
  const matte = new Uint8Array(Buffer.concat(chunks));
  if (matte.length !== size.width * size.height) throw cutoutError("kino-cutout returned a matte of the wrong size.", "CUTOUT_ENGINE_FAILED");
  return matte;
}

function rgbaToBgra(rgba) {
  const out = Buffer.allocUnsafe(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) { out[i] = rgba[i + 2]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i]; out[i + 3] = 255; }
  return out;
}

/**
 * Where Apple Vision sees the subject in one picture (RGBA bytes, `width` × `height`), for look
 * {mode:"source"}: { boxes: [{ by: "vision", box: [x, y, w, h] }] } in % of the picture, or
 * { skipped: reason } when this computer has no engine (every computer but a Mac). The subject
 * engine is used, else the person engine; the box holds every matte pixel at half or more, and
 * a matte with almost none (EMPTY_SHARE) gives no box. A second opinion beside the agent's own
 * boxes, never needed for them.
 */
export async function visionBoxes({ rgba, width, height, signal } = {}) {
  const engines = await cutoutEngines();
  const engine = engines.find((entry) => entry.available)?.engine;
  if (!engine) return { skipped: engines[0].reason };
  const helper = cutoutHelperPath();
  const size = analysisSize(width, height);
  let pixels = rgba;
  if (size.width !== width || size.height !== height) {
    const { createCanvas } = require("@napi-rs/canvas");
    const full = createCanvas(width, height);
    const fullContext = full.getContext("2d");
    const data = fullContext.createImageData(width, height);
    data.data.set(rgba);
    fullContext.putImageData(data, 0, 0);
    const small = createCanvas(size.width, size.height);
    const context = small.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(full, 0, 0, size.width, size.height);
    pixels = context.getImageData(0, 0, size.width, size.height).data;
  }
  const matte = await cutOnePicture({ helper, engine, size, bgra: rgbaToBgra(pixels), signal });
  let on = 0, left = size.width, top = size.height, right = -1, bottom = -1;
  for (let y = 0, index = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1, index += 1) {
      if (matte[index] < 128) continue;
      on += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (on < matte.length * EMPTY_SHARE) return { boxes: [] };
  const percent = (value, whole) => Math.round((value / whole) * 1000) / 10;
  return { boxes: [{ by: "vision", box: [percent(left, size.width), percent(top, size.height), percent(right + 1 - left, size.width), percent(bottom + 1 - top, size.height)] }] };
}

async function cachedMatte(folder) {
  try {
    const info = JSON.parse(await readFile(join(folder, "matte.json"), "utf8"));
    await stat(join(folder, info.file));
    return info;
  } catch { return null; }
}

function checkOptions({ source, kind, engine, cacheDir }) {
  if (typeof source !== "string" || !source) throw new TypeError("makeMatte needs a source file path.");
  if (typeof cacheDir !== "string" || !cacheDir) throw new TypeError("makeMatte needs a cacheDir.");
  if (!["video", "image"].includes(kind)) throw new RangeError('kind must be "video" or "image".');
  if (!CUTOUT_ENGINES.includes(engine)) throw new RangeError(`engine must be one of ${CUTOUT_ENGINES.join(", ")}.`);
}

// Which engine `engine` means on this computer, and the cache folder of the matte it would make
// of `source`: { chosen, note, macOS, sourceHash, folder }. Throws CUTOUT_ENGINE_UNAVAILABLE when
// no engine can be used.
async function matteSlot({ source, kind, engine, cacheDir, signal }) {
  checkOptions({ source, kind, engine, cacheDir });
  if (signal?.aborted) throw abortError(signal);
  const engines = await cutoutEngines();
  const usable = engines.filter((entry) => entry.available).map((entry) => entry.engine);
  let chosen = engine, note = null;
  if (engine === "auto") {
    chosen = usable[0];
    if (!chosen) throw cutoutError(`No cut-out engine is available. ${engines[0].reason}`, "CUTOUT_ENGINE_UNAVAILABLE");
    if (chosen !== "subject") note = `auto used the person engine: ${engines[0].reason}`;
  } else {
    const entry = engines.find((item) => item.engine === engine);
    if (!entry.available) throw cutoutError(entry.reason, "CUTOUT_ENGINE_UNAVAILABLE");
  }
  const { macOS } = engines.find((entry) => entry.engine === chosen);

  let sourceHash;
  try { sourceHash = await sha256File(source, signal); }
  catch (error) { if (signal?.aborted) throw abortError(signal); throw error; }
  // Vision's models can change with macOS, so a new major version makes new mattes.
  const key = createHash("sha256")
    .update(JSON.stringify({ format: MATTE_FORMAT, source: sourceHash, kind, engine: chosen, macOS: majorVersion(macOS), side: ANALYSIS_SIDE, steady: STEADY_RADIUS }))
    .digest("hex").slice(0, 32);
  return { chosen, note, macOS, sourceHash, folder: join(cacheDir, key) };
}

/**
 * The matte makeMatte would give for these options when it is already in the cache
 * ({ folder, info, engine, cached: true, note }), or null when it still has to be made. It only
 * reads the file (for its hash) and the cache: nothing is decoded and the helper is not run.
 * Throws as makeMatte does when no engine can be used.
 */
export async function findMatte({ source, kind, engine = "auto", cacheDir, signal } = {}) {
  const { chosen, note, folder } = await matteSlot({ source, kind, engine, cacheDir, signal });
  const hit = await cachedMatte(folder);
  return hit ? { folder, info: hit, engine: chosen, cached: true, note } : null;
}

/**
 * Finds the subject of `source` and keeps its steadied matte in the cache.
 *
 * Options:
 *   source      path of a video file (its first picture track) or a still image
 *   kind        "video" or "image"
 *   engine      "auto" (default: subject, else person), "subject" or "person"
 *   cacheDir    folder for mattes, one subfolder per cache key
 *   signal      AbortSignal; cancelling stops the helper and FFmpeg and removes partial files
 *   onProgress  called with a fraction from 0 to 1 of the frames looked at
 *
 * Resolves with { folder, info, engine, cached, note }. `info` is matte.json: { file, kind,
 * width, height (the matte's), source: { width, height, rate?, lead?, colour? }, frames, empty
 * (frames with no subject), engine, macOS, seconds (how long finding it took) }.
 *
 * While a matte is being made its files are in a ".work-…" folder of cacheDir (media.mjs removes
 * the ones a stopped server left behind).
 */
export async function makeMatte({ source, kind, engine = "auto", cacheDir, signal, onProgress } = {}) {
  const { chosen, note, macOS, sourceHash, folder } = await matteSlot({ source, kind, engine, cacheDir, signal });
  const hit = await cachedMatte(folder);
  if (hit) {
    onProgress?.(1);
    return { folder, info: hit, engine: chosen, cached: true, note };
  }
  const helper = cutoutHelperPath();

  await mkdir(cacheDir, { recursive: true });
  const work = await mkdtemp(join(cacheDir, ".work-"));
  const started = performance.now();
  try {
    let info;
    if (kind === "video") {
      const video = await probeVideo(source, signal);
      const size = analysisSize(video.width, video.height);
      const { frames, empty } = await analyseVideo({ source, video, size, engine: chosen, helper, matteFile: join(work, "matte.mkv"),
        signal, onFraction: onProgress });
      info = { file: "matte.mkv", kind, width: size.width, height: size.height, frames, empty,
        source: { width: video.width, height: video.height, rate: video.rate, duration: video.duration, lead: video.lead, colour: video.colour } };
    } else {
      const probe = await readImage(source, null);
      const size = analysisSize(probe.width, probe.height);
      const image = size.width === probe.width && size.height === probe.height ? probe : await readImage(source, size);
      const matte = await cutOnePicture({ helper, engine: chosen, size, bgra: rgbaToBgra(image.small ?? image.rgba), signal });
      let on = 0;
      for (const value of matte) if (value >= 128) on += 1;
      await writeFile(join(work, "matte.gray"), matte);
      info = { file: "matte.gray", kind, width: size.width, height: size.height, frames: 1, empty: on < matte.length * EMPTY_SHARE ? 1 : 0,
        source: { width: probe.width, height: probe.height } };
      onProgress?.(1);
    }
    Object.assign(info, { format: MATTE_FORMAT, engine: chosen, macOS, seconds: Math.round((performance.now() - started) / 100) / 10,
      sourceFile: { name: basename(source), sha256: sourceHash }, createdAt: new Date().toISOString(),
      credit: chosen === "subject" ? "Apple Vision VNGenerateForegroundInstanceMaskRequest (macOS)" : "Apple Vision VNGeneratePersonSegmentationRequest (macOS)" });
    await writeFile(join(work, "matte.json"), `${JSON.stringify(info, null, 2)}\n`);
    try {
      await rename(work, folder);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      // Another call finished the same matte first; theirs is identical.
      const other = await cachedMatte(folder);
      if (other) {
        await rm(work, { recursive: true, force: true });
        return { folder, info: other, engine: chosen, cached: true, note };
      }
      // A damaged one (its matte file deleted, matte.json unreadable) is replaced by this one.
      await rm(folder, { recursive: true, force: true });
      await rename(work, folder);
    }
    return { folder, info, engine: chosen, cached: false, note };
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }
}

/** "#ff8800" or "#f80" → "0xff8800" for FFmpeg's colour source; RGB bytes for stills. */
function colourParts(color) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? ""));
  if (!match) throw new RangeError('color must be a hex colour such as "#ffffff".');
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return { ffmpeg: `0x${hex.toLowerCase()}`, rgb: [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) };
}

/** Bilinear scaling of a one-byte-a-pixel matte (pixel centres line up, as in FFmpeg and browsers). */
export function scaleMatte(matte, width, height, toWidth, toHeight) {
  if (width === toWidth && height === toHeight) return matte;
  const out = new Uint8Array(toWidth * toHeight);
  const sx = width / toWidth, sy = height / toHeight;
  for (let y = 0; y < toHeight; y += 1) {
    const fy = Math.max(0, Math.min(height - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < toWidth; x += 1) {
      const fx = Math.max(0, Math.min(width - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(width - 1, x0 + 1), wx = fx - x0;
      const top = matte[y0 * width + x0] * (1 - wx) + matte[y0 * width + x1] * wx;
      const bottom = matte[y1 * width + x0] * (1 - wx) + matte[y1 * width + x1] * wx;
      out[y * toWidth + x] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
  return out;
}

/**
 * The FFmpeg arguments that encode the output kind from filter output [out]. A key frame every
 * second (`keyEvery` frames): the dashboard seeks the clip and its cut-out separately to keep them
 * in step, and a seek decodes from the key frame before it (VP9 makes one in 128 frames or more).
 */
function encoderArgs(output, colour, keyEvery) {
  const tags = Object.entries(colour ?? {}).flat();
  const keys = ["-g", String(keyEvery), "-keyint_min", String(keyEvery)];
  if (output === "matte")
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", ...keys, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4"];
  // VP9 keeps transparency in WebM (alpha_mode 1); browsers, Electron and kino's export read it.
  // The realtime speed: on 10 s of grainy 1080p it took 0.42 s a second of video against 2.7 s for
  // "good" at cpu-used 4, with the same colour (40.8 dB) and alpha (62 dB) PSNR and a 17% larger file.
  return ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "18", "-b:v", "0", "-deadline", "realtime", "-cpu-used", "8",
    "-row-mt", "1", "-auto-alt-ref", "0", ...keys, ...(output === "subject" ? tags : []), "-f", "webm"];
}

/**
 * Writes one output of a video matte to `target`. grow and feather are in the file's pixels.
 * Returns the file's extension and MIME type.
 */
async function writeVideoOutput({ source, folder, info, output, grow = 0, feather = 0, color, invert, target, signal, onFraction }) {
  if (output === "subject") return writeSubjectVideo({ source, folder, info, grow, feather, target, signal, onFraction });
  const { width, height, rate, lead } = info.source;
  const scale = info.width / width;
  const growBy = grow * scale, featherBy = feather * scale;
  const finishing = growBy !== 0 || featherBy !== 0;
  const matteFile = join(folder, info.file);
  // H.264 needs an even size; the matte is stretched by at most one pixel to get one.
  const outWidth = output === "matte" ? width + (width % 2) : width, outHeight = output === "matte" ? height + (height % 2) : height;
  // Frame n of the matte goes with frame n of the picture. Both are timed from their frame number:
  // Matroska keeps times in whole milliseconds, so the matte file's own times (33, 67, 100 ms at
  // 30 fps) would pair every third frame with the matte before it.
  const frameTimes = `setpts=N/(${rate})/TB`;
  const matteChain = `${frameTimes},format=gray,scale=${outWidth}:${outHeight}:flags=bicubic${invert ? ",negate" : ""}`;
  // A picture that starts after the file does (lead seconds) gets that many copies of its first
  // frame in front, so the output lines up with the file from its start, as the layer plays it.
  const leadFrames = Math.round(lead * parseFrameRate(rate));
  const pad = leadFrames > 0 ? `,tpad=start=${leadFrames}:start_mode=clone,${frameTimes}` : "";
  // Exactly one output frame for each matte frame: alphamerge would otherwise repeat the last one.
  const total = info.frames + leadFrames;
  const inputs = [], graph = [];
  let matteInput;
  if (output === "subject") {
    inputs.push("-i", source);
    graph.push(`[0:V:0]fps=fps=${rate}:round=near,${frameTimes}[picture]`);
    matteInput = 1;
  } else matteInput = 0;
  inputs.push(...(finishing ? ["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${info.width}x${info.height}`, "-r", rate, "-i", "pipe:0"] : ["-i", matteFile]));
  graph.push(`[${matteInput}:v]${matteChain}[matte]`);
  if (output === "subject") graph.push(`[picture][matte]alphamerge,format=yuva420p${pad}[out]`);
  else if (output === "matte") graph.push(`[matte]format=yuv420p${pad}[out]`);
  else {
    graph.push(`color=c=${colourParts(color).ffmpeg}:s=${width}x${height}:r=${rate}[paint]`);
    graph.push(`[paint][matte]alphamerge,format=yuva420p${pad}[out]`);
  }
  const encode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-y", ...inputs, "-filter_complex", graph.join(";"),
    "-map", "[out]", "-an", "-sn", "-fps_mode", "passthrough", "-frames:v", String(total), ...encoderArgs(output, info.source.colour, Math.max(1, Math.round(parseFrameRate(rate)))), target],
  { stdio: [finishing ? "pipe" : "ignore", "ignore", "pipe"] });
  const children = [encode];
  let decode = null;
  if (finishing) {
    decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-i", matteFile, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] });
    children.push(decode);
    encode.stdin.on("error", () => {});
    decode.stdout.on("error", () => {});
    let done = 0;
    const collect = frameCollector(info.width * info.height, (matte) => {
      const finished = finishMatte(matte, info.width, info.height, { grow: growBy, feather: featherBy });
      done += 1;
      onFraction?.(Math.min(1, done / info.frames));
      if (!encode.stdin.write(finished)) {
        decode.stdout.pause();
        encode.stdin.once("drain", () => decode.stdout.resume());
      }
    });
    decode.stdout.on("data", collect);
    decode.stdout.once("end", () => encode.stdin.end());
  }
  const onAbort = () => killAll(children);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.all(children.map((child) => track(child, "FFmpeg", signal)));
  } catch (error) {
    killAll(children);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  onFraction?.(1);
  return output === "matte" ? { extension: "mp4", mime: "video/mp4" } : { extension: "webm", mime: "video/webm" };
}

/**
 * Runs `children` (already spawned) and reads two raw frame streams in step: frame n of `a`
 * (`aSize` bytes) and frame n of `b` go to onPair(aFrame, bFrame, n), which may return false to
 * hold both streams until `resume` (from the onPair's own write) is called. Resolves when all exit.
 */
async function pairFrames({ a, aSize, b, bSize, children, signal, onPair }) {
  const queues = [[], []];
  const ended = [false, false];
  let index = 0;
  let held = false;
  const resume = () => { held = false; drain(); };
  const drain = () => {
    while (!held && queues[0].length && queues[1].length) {
      if (onPair(queues[0].shift(), queues[1].shift(), index++, resume) === false) held = true;
    }
    // Neither side runs far ahead of the other; once one side has ended, frames the other has
    // beyond it have no partner and are let go, so its program can finish.
    const over = ended.some((done, side) => done && !queues[side].length);
    if (over) { queues[0].length = 0; queues[1].length = 0; }
    for (const [side, stream] of [[0, a.stdout], [1, b.stdout]]) {
      if (!over && (held || queues[side].length > 4)) stream.pause(); else stream.resume();
    }
  };
  a.stdout.once("end", () => { ended[0] = true; drain(); });
  b.stdout.once("end", () => { ended[1] = true; drain(); });
  a.stdout.on("data", frameCollector(aSize, (frame) => { queues[0].push(frame); drain(); }));
  b.stdout.on("data", frameCollector(bSize, (frame) => { queues[1].push(frame); drain(); }));
  for (const stream of [a.stdout, b.stdout]) stream.on("error", () => {});
  const onAbort = () => killAll(children);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.all(children.map((child) => track(child, "FFmpeg", signal)));
  } catch (error) {
    killAll(children);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return index;
}

/**
 * The subject on a transparent background (VP9 WebM): the picture and the matte are read frame by
 * frame, the matte grown or feathered and scaled to the picture, and the edge cleaned (edges.mjs:
 * where a still shot's empty background shows through the edge the matte drops, and edge pixels
 * take the subject's colour, so no background halo is left). Frames stay YUV 4:4:4, the video's
 * own colour numbers, so the solid subject matches the footage under it exactly.
 */
// A matte this much smaller than the last good one is a frame where Vision lost the subject.
const LOST_SHARE = 0.35;
// How many lost frames wait for the next good one (each is a full frame in memory).
const HOLD = 12;

async function writeSubjectVideo({ source, folder, info, grow = 0, feather = 0, target, signal, onFraction }) {
  const { width, height, rate, lead } = info.source;
  const scale = info.width / width;
  const growBy = grow * scale, featherBy = feather * scale;
  const matteFile = join(folder, info.file);
  const frameTimes = `setpts=N/(${rate})/TB`;
  const picture = (extra) => spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-i", source, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `fps=fps=${rate}:round=near,${frameTimes}${extra}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv444p", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  const matte = (extra) => spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-i", matteFile,
    "-vf", `${frameTimes}${extra}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  // 1. The empty background of a still shot, from up to 24 frames spread over the clip, small.
  const plateWidth = Math.min(width, 384), plateHeight = Math.max(2, Math.round((height * plateWidth) / width));
  const every = Math.max(1, Math.floor(info.frames / 24));
  const pick = `,select='not(mod(n\\,${every}))',scale=${plateWidth}:${plateHeight}:flags=area`;
  const builder = createPlateBuilder({ width: plateWidth, height: plateHeight });
  const smallPicture = picture(pick), smallMatte = matte(pick);
  await pairFrames({ a: smallPicture, aSize: plateWidth * plateHeight * 3, b: smallMatte, bSize: plateWidth * plateHeight,
    children: [smallPicture, smallMatte], signal, onPair: (yuv, mask) => { builder.add(yuv, mask); } });
  const plate = builder.finish();
  // 2. Every frame, cleaned, into the encoder.
  const leadFrames = Math.round(lead * parseFrameRate(rate));
  const pad = leadFrames > 0 ? `,tpad=start=${leadFrames}:start_mode=clone,${frameTimes}` : "";
  const total = info.frames + leadFrames;
  const encode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuva444p", "-s", `${width}x${height}`, "-r", rate, "-i", "pipe:0",
    "-filter_complex", `[0:v]format=yuva420p${pad}[out]`, "-map", "[out]", "-an", "-sn", "-fps_mode", "passthrough", "-frames:v", String(total),
    ...encoderArgs("subject", info.source.colour, Math.max(1, Math.round(parseFrameRate(rate)))), target], { stdio: ["pipe", "ignore", "pipe"] });
  encode.stdin.on("error", () => {});
  const refiner = createEdgeRefiner({ width, height, plate: plate.steady ? plate : null });
  const pixels = width * height;
  const full = picture(""), mattes = matte("");
  const area = (mask) => { let sum = 0; for (let i = 0; i < mask.length; i += 1) sum += mask[i]; return sum / 255; };
  // A frame where Vision lost the subject (a matte under LOST_SHARE of the last good one) waits,
  // up to HOLD frames, for the next good frame; then each takes the nearer good matte as its gate.
  let last = null;
  const waiting = [];
  let done = 0;
  let ok = true;
  const write = (yuv, mask) => {
    const out = Buffer.allocUnsafe(pixels * 4);
    out.set(yuv, 0);
    out.set(mask, pixels * 3);
    done += 1;
    onFraction?.(Math.min(1, done / info.frames));
    ok = encode.stdin.write(out) && ok;
  };
  const release = (next) => {
    while (waiting.length) {
      const held = waiting.shift();
      const gate = !last ? next?.mask : !next ? last.mask : held.index - last.index <= next.index - held.index ? last.mask : next.mask;
      refiner.refine(held.yuv, held.mask, gate ? { gate } : {});
      write(held.yuv, held.mask);
    }
  };
  await pairFrames({ a: full, aSize: pixels * 3, b: mattes, bSize: info.width * info.height, children: [full, mattes, encode], signal,
    onPair: (yuv, raw, index, resume) => {
      if (index >= info.frames) return true;
      let mask = finishMatte(raw, info.width, info.height, { grow: growBy, feather: featherBy });
      if (info.width !== width || info.height !== height) mask = scaleMatte(mask, info.width, info.height, width, height);
      else if (mask === raw) mask = Uint8Array.from(raw);
      const size = area(mask);
      if (last && size < last.area * LOST_SHARE || !last && size < pixels * 0.002) {
        waiting.push({ yuv, mask, index });
        if (waiting.length > HOLD) { const oldest = waiting.shift(); refiner.refine(oldest.yuv, oldest.mask, last ? { gate: last.mask } : {}); write(oldest.yuv, oldest.mask); }
      } else {
        const good = { mask: Uint8Array.from(mask), area: size, index };
        release(good);
        refiner.refine(yuv, mask);
        write(yuv, mask);
        last = good;
      }
      if (index === info.frames - 1) { release(null); encode.stdin.end(); }
      if (!ok) { ok = true; encode.stdin.once("drain", resume); return false; }
      return true;
    } }).finally(() => { if (waiting.length && !encode.stdin.writableEnded) release(null); if (!encode.stdin.writableEnded) encode.stdin.end(); });
  onFraction?.(1);
  return { extension: "webm", mime: "video/webm" };
}

/** Writes one output of a still image's matte to `target` as a PNG. */
async function writeImageOutput({ source, folder, info, output, grow = 0, feather = 0, color, invert, target, signal }) {
  const { width, height } = info.source;
  const scale = info.width / width;
  let matte = new Uint8Array(await readFile(join(folder, info.file)));
  matte = finishMatte(matte, info.width, info.height, { grow: grow * scale, feather: feather * scale });
  matte = scaleMatte(matte, info.width, info.height, width, height);
  const rgba = Buffer.alloc(width * height * 4);
  if (output === "subject") {
    const image = await readImage(source, null);
    if (image.width !== width || image.height !== height) throw cutoutError("The image changed size since its matte was made.", "CUTOUT_ENGINE_FAILED");
    for (let i = 0, p = 0; i < matte.length; i += 1, p += 4) {
      rgba[p] = image.rgba[p]; rgba[p + 1] = image.rgba[p + 1]; rgba[p + 2] = image.rgba[p + 2];
      rgba[p + 3] = Math.round((image.rgba[p + 3] * matte[i]) / 255);
    }
  } else if (output === "matte") {
    for (let i = 0, p = 0; i < matte.length; i += 1, p += 4) {
      const value = invert ? 255 - matte[i] : matte[i];
      rgba[p] = rgba[p + 1] = rgba[p + 2] = value; rgba[p + 3] = 255;
    }
  } else {
    const [red, green, blue] = colourParts(color).rgb;
    for (let i = 0, p = 0; i < matte.length; i += 1, p += 4) { rgba[p] = red; rgba[p + 1] = green; rgba[p + 2] = blue; rgba[p + 3] = matte[i]; }
  }
  const child = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-pix_fmt", output === "matte" ? "rgb24" : "rgba", "-f", "image2", target],
  { stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.on("error", () => {});
  child.stdin.end(rgba);
  await track(child, "FFmpeg", signal);
  return { extension: "png", mime: "image/png" };
}

/**
 * Writes an output of a matte made by makeMatte to `target`: output "subject", "matte" or
 * "silhouette"; grow and feather in the file's pixels; color for a silhouette; invert for a
 * matte. Returns { extension, mime }.
 */
export async function writeCutoutOutput({ source, folder, info, output, grow, feather, color, invert, target, signal, onFraction }) {
  if (!CUTOUT_OUTPUTS.includes(output)) throw new RangeError(`output must be one of ${CUTOUT_OUTPUTS.join(", ")}.`);
  const write = info.kind === "video" ? writeVideoOutput : writeImageOutput;
  return write({ source, folder, info, output, grow, feather, color, invert, target, signal, onFraction });
}
