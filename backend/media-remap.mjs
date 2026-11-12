// Video frames for a clip on a time map: a clip with a speed, played backwards, with a choppy
// frame rate, or drawn with mediaInterpolation "blend" or "flow" (engine/mediaTime.js).
//
// A normal clip is sampled on a grid at the export's frame rate (export.mjs extractVideoFrames).
// A clip on a time map asks for source times that are on no grid (at 0.25× each file frame is
// asked for four times, a little later each time), so here each time is turned into the file's
// own frames instead:
//   nearest  the file frame on screen at that time (the one that started at or before it),
//   blend    the two file frames around it, mixed by how far between them the time is, so a time
//            halfway between two frames shows 50% of each,
//   flow     FFmpeg drops the file's repeated frames (mpdecimate), then its motion interpolation
//            (minterpolate, mi_mode=mci) makes in-between frames (a "proxy" video, kept in a
//            cache by the file's SHA-256), and those are
//            blended like "blend". It is slow (see docs/testing.md), so it runs once per clip.
// The file frames used are read with one FFmpeg run per stretch of the file (a select filter
// keeps only those frames), already sized for the layer. Blends are mixed here, pixel by pixel.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { encodeRenderPng } from "./render-png.mjs";
import { ffmpegCommand, pictureScale, probeFrameRate, probeMedia, videoGridArgs } from "./media-probe.mjs";
import { runExportProcess as runProcess } from "./export-process.mjs";
import { sha256File } from "./voice/model.mjs";
import { MEDIA_SAMPLE_TOLERANCE } from "../engine/playback.js";
import { mediaInterpolationOf } from "../engine/mediaTime.js";

// Bump when a flow proxy made from the same input would change, so old cache files are not used.
export const FLOW_FORMAT = 2;
// Flow makes at most this many frames per file frame (8 covers 0.125× at the file's own rate).
export const MAX_FLOW_FACTOR = 8;
// The FFmpeg filter that makes the in-between frames: motion-compensated, overlapped blocks,
// estimated both ways, with smoothed block motion. FFmpeg's own best settings for minterpolate.
// Its scene-cut check stays on: where the picture changes suddenly (a cut, or motion that starts
// all at once) it shows the nearer file frame instead of morphing one picture into the other.
export const FLOW_FILTER = "mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1";
// Before that, flow drops repeated frames: a 30 fps screen recording whose picture changes a few
// times a second holds each picture for several frames, and interpolating between two equal frames
// changes nothing. Dropped frames keep no time, so the interpolation fills each hold with motion
// toward the next new picture. A frame stays when an 8 × 8 block differs by more than 12 levels a
// pixel, or a third of the blocks by more than 5 (FFmpeg mpdecimate), so normal footage keeps all.
export const FLOW_DECIMATE = "mpdecimate=hi=64*12:lo=64*5:frac=0.33";
// One FFmpeg run reads at most this many separate stretches of frames,
const MAX_RUNS_PER_READ = 48;
// and a gap longer than this between two stretches starts a new run (seeking is quicker than decoding).
const MAX_GAP_SECONDS = 4;
// Blends written at the same time (their PNG compression runs on Node's worker threads).
const BLENDS_AT_ONCE = 4;

/**
 * Where a source time falls among frames that come `fps` a second from `first` seconds:
 * {index, part}. `index` is the frame on screen (started at or before the time, with 1 ms of
 * tolerance, as everywhere else in Play), `part` how far toward the next frame the time is (0 to 1).
 */
export function framePosition(time, fps, first = 0) {
  const position = (time - first) * fps;
  const index = Math.max(0, Math.floor(position + MEDIA_SAMPLE_TOLERANCE * fps));
  const part = position - index;
  return { index, part: part > MEDIA_SAMPLE_TOLERANCE * fps ? Math.min(1, part) : 0 };
}

/** Sorted frame numbers grouped into FFmpeg runs: [[{from, to}, …], …]. */
function readRuns(indices, fps) {
  const stretches = [];
  for (const index of indices) {
    const last = stretches.at(-1);
    if (last && index === last.to + 1) last.to = index;
    else stretches.push({ from: index, to: index });
  }
  const runs = [];
  for (const stretch of stretches) {
    const run = runs.at(-1);
    const gap = run ? (stretch.from - run.at(-1).to) / fps : Infinity;
    if (run && run.length < MAX_RUNS_PER_READ && gap <= MAX_GAP_SECONDS) run.push(stretch);
    else runs.push([stretch]);
  }
  return runs;
}

/**
 * Reads the frames numbered `indices` (frames come `fps` a second, numbered from 0 at the start of
 * `input`) as PNG files sized to fit width × height. Returns Map(index → path).
 */
async function readFrames(input, indices, fps, { folder, prefix, width, height, size, decoderArgs = [], signal, label }) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const paths = new Map();
  let runNumber = 0;
  for (const run of readRuns(sorted, fps)) {
    const base = run[0].from;
    const terms = run.map(({ from, to }) => (from === to ? `eq(n,${from - base})` : `between(n,${from - base},${to - base})`));
    const count = run.reduce((sum, { from, to }) => sum + to - from + 1, 0);
    const name = `${prefix}${runNumber++}-`;
    await runProcess(ffmpegCommand(), videoGridArgs({
      input,
      output: join(folder, `${name}%06d.png`),
      firstTime: base / fps,
      fps,
      count,
      decoderArgs,
      // The grid gives frame base, base + 1, … (repeating the last frame past the end, forever), so
      // trim ends it after the run's last frame; select keeps the ones used, in order.
      filters: [`trim=end_frame=${run.at(-1).to - base + 1}`, `select='${terms.join("+")}'`, pictureScale(width, height, size)],
      // Quick PNG compression (lossless either way): these pictures live only as long as the export.
      outputArgs: ["-an", "-sn", "-dn", "-compression_level", "1", "-start_number", "0"],
    }), signal);
    const pattern = new RegExp(`^${name}\\d{6}\\.png$`);
    const written = (await readdir(folder)).filter((file) => pattern.test(file)).length;
    if (written !== count) throw new Error(`${label} produced ${written} of ${count} frames.`);
    let file = 0;
    for (const { from, to } of run)
      for (let index = from; index <= to; index += 1) paths.set(index, join(folder, `${name}${String(file++).padStart(6, "0")}.png`));
  }
  return paths;
}

/** A picture file's straight RGBA pixels: {width, height, data}. */
async function picturePixels(path) {
  const image = await loadImage(readFileSync(path));
  const { width, height } = image;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return { width, height, data: context.getImageData(0, 0, width, height).data };
}

/**
 * Mixes two pictures: `part` of the second over 1 − `part` of the first, pixel by pixel, with
 * transparency weighted in (premultiplied), so 0.5 of black and white is mid grey. `decoded`
 * (a Map of path → pixels) keeps pictures already read: at 0.3× each file frame is in several
 * blends. The result is written with the export's own PNG writer (render-png.mjs: exact straight
 * alpha, quick compression), not through a canvas.
 */
export async function blendPictures(firstPath, secondPath, part, outputPath, decoded = new Map()) {
  const read = (path) => {
    if (!decoded.has(path)) decoded.set(path, picturePixels(path));
    return decoded.get(path);
  };
  const [first, second] = await Promise.all([read(firstPath), read(secondPath)]);
  const { width, height } = first;
  const [a, b] = [first.data, second.data];
  const out = new Uint8ClampedArray(a.length);
  const keep = 1 - part;
  for (let at = 0; at < a.length; at += 4) {
    const alphaA = a[at + 3], alphaB = b[at + 3];
    if (alphaA === 255 && alphaB === 255) {
      out[at] = a[at] * keep + b[at] * part;
      out[at + 1] = a[at + 1] * keep + b[at + 1] * part;
      out[at + 2] = a[at + 2] * keep + b[at + 2] * part;
      out[at + 3] = 255;
      continue;
    }
    const weightA = alphaA * keep, weightB = alphaB * part;
    const alpha = weightA + weightB;
    out[at + 3] = alpha;
    if (alpha > 0) for (let channel = 0; channel < 3; channel += 1)
      out[at + channel] = (a[at + channel] * weightA + b[at + channel] * weightB) / alpha;
  }
  await writeFile(outputPath, await encodeRenderPng(out, width, height), { mode: 0o600 });
}

/** The folder flow proxies are kept in: the data folder's cache/flow. */
export function defaultFlowCacheDir() {
  const root = new URL("..", import.meta.url).pathname;
  return join(process.env.MOTION_DATA_DIR || join(root, ".local", "data"), "cache", "flow");
}

/**
 * How many frames per file frame flow makes: enough that the slowest playing stretch gets a new
 * picture for every export frame (two times a second apart by 1/(4 × fps) need 4), at most 8.
 */
export function flowFactor(times, fileFps) {
  let smallest = Infinity;
  for (let index = 1; index < times.length; index += 1) {
    const step = Math.abs(times[index] - times[index - 1]);
    if (step > 1e-6) smallest = Math.min(smallest, step);
  }
  if (!Number.isFinite(smallest)) return 1;
  return Math.max(1, Math.min(MAX_FLOW_FACTOR, Math.ceil(1 / (smallest * fileFps) - 1e-6)));
}

/**
 * The flow proxy for file frames `first` … `last`: the frames sized to fit width × height, repeated
 * frames dropped, and `factor` frames per file frame made from those left by minterpolate. Frame j
 * of the proxy shows the file at first / fileFps + j / (fileFps × factor) seconds. Kept in `cacheDir` under a name made from the
 * file's SHA-256 and these settings; written to a temporary name and renamed when finished, so a
 * half-written proxy is never used. Returns {path, built (false when it came from the cache), seconds}.
 */
export async function flowProxy(videoPath, { first, last, fileFps, factor, width, height, decoderArgs = [], signal, cacheDir = defaultFlowCacheDir() }) {
  const fileHash = await sha256File(videoPath, signal);
  const key = createHash("sha256").update(JSON.stringify([FLOW_FORMAT, fileHash, first, last, fileFps, factor, width, height, FLOW_DECIMATE, FLOW_FILTER])).digest("hex");
  const path = join(cacheDir, `${key}.mkv`);
  try {
    await lstat(path);
    return { path, built: false, seconds: 0 };
  } catch {}
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const partial = join(cacheDir, `${key}.${randomUUID()}.part.mkv`);
  const started = performance.now();
  try {
    await runProcess(ffmpegCommand(), videoGridArgs({
      input: videoPath,
      output: partial,
      firstTime: first / fileFps,
      fps: fileFps,
      count: (last - first) * factor + 1,
      decoderArgs,
      filters: [
        // The file frames used and one more (the grid repeats the last frame forever), with exact
        // times from 0, so frame j of the proxy is at j / (fileFps × factor).
        `trim=end_frame=${last - first + 2}`,
        `setpts=N/(${fileFps}*TB)`,
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        FLOW_DECIMATE,
        // minterpolate makes the frames up to a file frame only once it has the frame after it:
        // two copies of the last frame kept, so a hold at the end still reaches its picture.
        "tpad=stop=2:stop_mode=clone",
        `minterpolate=fps=${fileFps * factor}:${FLOW_FILTER}`,
        // The hold at the end was dropped: repeat the last picture, so the proxy keeps its length.
        "tpad=stop=-1:stop_mode=clone",
      ],
      // Every frame a key frame (so reading any frame back is exact), full colour detail.
      outputArgs: ["-an", "-sn", "-dn", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p", "-f", "matroska"],
    }), signal);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { path, built: true, seconds: (performance.now() - started) / 1000 };
}

/**
 * The box a flow proxy is made in: the layer's box (width × height), or the file's own picture size
 * when the layer shows it larger. Motion interpolation costs about the same per pixel, so making
 * in-between frames for pixels the file does not have only adds time: a 1080 × 1920 phone clip on a
 * layer 1500 × 2667 pixels big took twice as long. The frames read from the proxy are scaled up
 * to the layer's box afterwards, as file frames are.
 */
export async function flowSize(videoPath, width, height, signal) {
  const { width: fileWidth, height: fileHeight } = await probeMedia(videoPath, { signal });
  // minterpolate needs at least 32 pixels a side; a tinier file keeps the layer's box, as before.
  const fits = fileWidth >= 32 && fileHeight >= 32 && fileWidth <= width && fileHeight <= height;
  return fits ? { width: fileWidth, height: fileHeight } : { width, height };
}

/**
 * Extracts the pictures a clip on a time map shows. `needed` is [{time (seconds into the file),
 * playing}] from export.mjs videoSourceTimes; `end` the file's length. Returns
 * {frameFor(sourceTime) → PNG path, mode (the interpolation used), flow?: {factor, built, seconds}}.
 */
export async function extractRemappedFrames(layer, videoPath, needed, options) {
  await mkdir(options.folder, { recursive: true, mode: 0o700 });
  return remappedPictures(await remappedSource(layer, videoPath, needed, options), needed, options);
}

/**
 * The first half of extractRemappedFrames, done once per layer: where its pictures are read
 * from (the file, or a flow proxy made for every time in `needed`) and how they are drawn.
 * A long export reads its pictures a window of frames at a time (export.mjs), each window with
 * remappedPictures, so the proxy and its frame factor are the same as for the whole export.
 */
export async function remappedSource(layer, videoPath, needed, { end = Infinity, width, height, fileSize, decoderArgs = [], design = false, signal, warnings, flowCacheDir }) {
  const label = `Video layer “${layer.name ?? layer.id}”`;
  const fileFps = await probeFrameRate(videoPath, { signal });
  // The last moment a frame starts: a time past the end shows the last frame.
  const clamp = (time) => Math.max(0, Math.min(time, end - 0.5 / fileFps));
  let mode = design ? "nearest" : mediaInterpolationOf(layer);
  if (mode === "flow" && decoderArgs.length) {
    // FFmpeg's motion interpolation drops the alpha channel of a see-through WebM.
    mode = "blend";
    warnings?.push({ code: "video-flow-unavailable", message: `${label} has a see-through picture, which flow cannot interpolate; it was blended instead.` });
  }
  // size: the pictures' own width and height (media-probe.mjs pictureScale keeps that size as it is).
  let source = { input: videoPath, fps: fileFps, first: 0, decoderArgs, size: fileSize ?? await probeMedia(videoPath, { signal }) };
  let flow = null;
  if (mode === "flow") {
    // Made at any speed, even 1: a file that repeats frames gets new in-between pictures (FLOW_DECIMATE).
    const factor = flowFactor(needed.filter((item) => item.playing).map((item) => clamp(item.time)), fileFps);
    // A loop, not Math.min(...times): a ten-minute export can ask for more times than a call takes.
    let [earliest, latest] = [Infinity, -Infinity];
    for (const item of needed) [earliest, latest] = [Math.min(earliest, clamp(item.time)), Math.max(latest, clamp(item.time))];
    const first = Math.max(0, Math.floor(earliest * fileFps + MEDIA_SAMPLE_TOLERANCE * fileFps));
    const last = Math.floor(latest * fileFps + MEDIA_SAMPLE_TOLERANCE * fileFps) + 1;
    const size = await flowSize(videoPath, width, height, signal);
    const proxy = await flowProxy(videoPath, { first, last, fileFps, factor, ...size, decoderArgs, signal, cacheDir: flowCacheDir });
    source = { input: proxy.path, fps: fileFps * factor, first: first / fileFps, decoderArgs: [], size };
    flow = { factor, built: proxy.built, seconds: Math.round(proxy.seconds * 10) / 10 };
    // Between two proxy frames (slower than the proxy has frames for), the two are mixed.
    mode = "blend";
  }
  return { label, clamp, mode, source, flow };
}

/**
 * The second half of extractRemappedFrames: reads the file frames that the times in `needed` show
 * (and mixes the blends) into `folder`, which must exist. Returns what extractRemappedFrames does.
 */
export async function remappedPictures({ label, clamp, mode, source, flow }, needed, { folder, width, height, signal }) {
  const times = needed.map((item) => clamp(item.time));
  const positions = times.map((time) => framePosition(time, source.fps, source.first));
  const indices = positions.flatMap(({ index, part }) => (mode === "blend" && part > 0 ? [index, index + 1] : [index]));
  const frames = await readFrames(source.input, indices, source.fps, { folder, prefix: "file-", width, height, size: source.size, decoderArgs: source.decoderArgs, signal, label });
  const pictures = new Map();
  let blends = 0;
  const keyOf = ({ index, part }) => (mode === "blend" && part > 0 ? `${index}@${Math.round(part * 1000)}` : `${index}`);
  // Decoded file frames, kept while the blends that use them are made (they come in time order),
  // and a few blends written at once (each PNG is compressed off the main thread).
  const decoded = new Map();
  const writing = [];
  for (const position of positions) {
    const key = keyOf(position);
    if (pictures.has(key)) continue;
    if (!key.includes("@")) { pictures.set(key, frames.get(position.index)); continue; }
    const output = join(folder, `blend-${blends++}.png`);
    for (const path of decoded.keys()) if (path !== frames.get(position.index) && path !== frames.get(position.index + 1) && decoded.size > 4) decoded.delete(path);
    const job = blendPictures(frames.get(position.index), frames.get(position.index + 1), Math.round(position.part * 1000) / 1000, output, decoded);
    job.catch(() => {}); // awaited below; this only stops an early failure counting as unhandled
    writing.push(job);
    if (writing.length >= BLENDS_AT_ONCE) await writing.shift();
    pictures.set(key, output);
  }
  await Promise.all(writing);
  const known = [...frames.keys()].sort((a, b) => a - b);
  return {
    mode: flow ? "flow" : mode,
    ...(flow ? { flow } : {}),
    frameFor(sourceTime) {
      const position = framePosition(clamp(sourceTime), source.fps, source.first);
      const found = pictures.get(keyOf(position)) ?? frames.get(position.index);
      if (found) return found;
      // A time no frame was read for (it should not happen): the closest frame read.
      const closest = known.reduce((best, index) => (Math.abs(index - position.index) < Math.abs(best - position.index) ? index : best), known[0]);
      return frames.get(closest);
    },
  };
}
