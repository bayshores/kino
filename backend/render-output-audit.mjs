import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { MAX_TIME } from "../engine/schema.js";

const THUMB_WIDTH = 32;
const THUMB_HEIGHT = 18;
const THUMB_BYTES = THUMB_WIDTH * THUMB_HEIGHT * 3;
// How FFmpeg turns a decoded frame into RGB (colour only: the frame keeps its size). Each pixel
// gets its own colour sample: without full_chroma_int, columns 2k and 2k+1 shared one taken
// between them, and on busy video (FFmpeg's testsrc2) every frame differed by about 20 levels
// from its reference although the file matched within 1.
const COLOUR_FLAGS = "neighbor+full_chroma_int";
// A lossless file (APNG) must read back exactly: its frames may differ from their references
// by at most 2 levels per pixel. full_chroma_inp and accurate_rnd keep FFmpeg's RGB maths exact:
// without them, when FFmpeg scaled the frame down to the thumbnail inside its RGB-to-YUV-to-RGB
// round trip, a saturated pixel beside a different colour came back up to 8 levels off on
// testsrc2 and 123 on mandelbrot. Lossy formats keep the flags above: their limits were measured
// with them.
const LOSSLESS_COLOUR_FLAGS = `${COLOUR_FLAGS}+full_chroma_inp+accurate_rnd`;
// Every frame of the longest scene (engine/schema.js MAX_TIME, ten minutes) at the highest export
// rate (120 fps): 72,000 thumbnails of 1,728 bytes, about 124 MB. A ten-minute 30 fps render
// keeps 18,000 (31 MB).
const MAX_REFERENCES = MAX_TIME * 120;
const MAX_STDERR_BYTES = 64 * 1024;
const SUPPORTED_FORMATS = new Set(["mp4", "webm", "mov", "apng"]);
const LOSSLESS_FORMATS = new Set(["apng"]);
// The shift check (see frameNeighbour and longestShiftRun). A decoded frame "looks like a
// neighbour" when the renderer frame just before or after its own is closer to it than its own
// frame, by at least neighbourMargin levels and under neighbourRatio times its own error.
// rendererMatch fails when shiftRunFrames or more frames in a row look like the same neighbour.
//
// How shiftRunFrames = 8 was chosen, from final renders measured through exportScene:
// - Correct files of slow fades and colour changes (27 renders: 1 to 10 s, mp4, mp4.alt, webm,
//   mov) do have frames that look like a neighbour. 8-bit colour rounding moves a flat colour
//   that changes by 1 or 2 levels a frame closer to the frame before or after. Those frames are
//   scattered and point both ways: the longest run in one direction was 4 frames.
// - Files that really run a frame early or late, or drop or repeat a frame (12 renders of busy
//   footage, film grain, a blended clip, a fractal, a fade and slow text), gave runs of 21 to 59.
// 8 is twice the longest run of a correct file and well under the shortest run of a broken one.
// A render shorter than 9 frames cannot reach a run of 8, so this check cannot fail it.
const SHIFT_LIMITS = Object.freeze({ neighbourRatio: 0.75, neighbourMargin: 0.5, shiftRunFrames: 8 });
const LOSSY_LIMITS = Object.freeze({ meanRgb: 10, pixelChannel: 32, badPixelRatio: 0.12, temporalRgb: 10, ...SHIFT_LIMITS });
const LOSSLESS_LIMITS = Object.freeze({ meanRgb: 0.5, pixelChannel: 2, badPixelRatio: 0, temporalRgb: 0.5, ...SHIFT_LIMITS });

function check(status, expected, actual, detail) {
  return { status, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}), ...(detail ? { detail } : {}) };
}

function report(checks, facts = {}, warnings = []) {
  return { ok: Object.values(checks).every(({ status }) => status !== "fail"), checks, facts, warnings };
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("Rendered-output inspection was cancelled."), { name: "AbortError" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function boundedCommand(kind) {
  if (kind === "ffmpeg") return process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
  return process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function byte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function isByteArray(value) {
  return value instanceof Uint8Array || value instanceof Uint8ClampedArray;
}

// Which source pixel thumbnail pixel `index` (of `count` along one side) shows, on a side `size`
// pixels long: the one under its centre, floor((index + 0.5) × size / count). frameReference
// uses it for rows and columns. Reading a decoded file, FFmpeg finds the rows with the same sum
// (stripGraph) and stripReader finds the columns with this function.
function sourcePosition(index, count, size) {
  return Math.min(size - 1, Math.floor((index + 0.5) * size / count));
}

// How the decoded file's thumbnails get the very pixels frameReference takes. FFmpeg's own 32×18
// scale (flags=neighbor) did not: it works in 16-bit fixed point, and where a row's centre falls
// exactly on a pixel edge it took the row above. At 96 px tall it took rows 7, 23, 39, 55, 71 and
// 87 where frameReference takes 8, 24, 40, 56, 72 and 88, so every frame of a correct final APNG
// at 160×96 failed rendererMatch (with FFmpeg 9.0.2, 244 of the heights from 1 to 2,200 took
// another row; no width from 1 to 1,000 took another column).
//
// Now FFmpeg turns each frame into RGB at its own size (colour only), keeps the thumbnail's 18
// rows with one crop each and stacks them into a strip as wide as the frame. stripReader then
// keeps the 32 columns. Each crop's row is floor((y + 0.5) × ih / 18) for the frame's own height:
// the sum sourcePosition does, in the same double-precision steps, so both get the same whole
// number (the true value is a fraction over 36: unless it is whole it is at least 1/36 from one,
// far more than any rounding). Columns are kept in JavaScript because 32 more crops and an hstack
// made FFmpeg take about 0.4 ms longer on every frame (a ten-minute 32×18 render: 1.2 s -> 9.8 s).
function stripGraph(colourFlags) {
  const rows = Array.from({ length: THUMB_HEIGHT }, (_, y) => y);
  return `[0:v:0]scale=flags=${colourFlags},format=rgb24,split=${THUMB_HEIGHT}${rows.map((y) => `[row${y}]`).join("")};`
    + rows.map((y) => `[row${y}]crop=w=iw:h=1:x=0:y=floor(${y + 0.5}*ih/${THUMB_HEIGHT})[kept${y}];`).join("")
    + `${rows.map((y) => `[kept${y}]`).join("")}vstack=inputs=${THUMB_HEIGHT}[strip]`;
}

// The header FFmpeg's PPM encoder writes before each strip's RGB bytes: "P6", the width and
// height, and the largest value. The header gives the strip's width, so the audit needs no
// separate probe of the file's size.
const STRIP_HEADER = /^P6\n([1-9]\d{0,5}) ([1-9]\d{0,5})\n255\n$/;
const MAX_STRIP_HEADER_BYTES = 32;

// Reads FFmpeg's strips as they arrive and keeps only each one's 32×18 thumbnail, so a long
// render needs 1,728 bytes a frame and not a strip (up to 442 KB at 8192 px wide). Keeps at most
// maxFrames thumbnails. read() takes each piece of FFmpeg's output; result() answers
// { thumbnails, frames, trailingBytes }, where trailingBytes counts the bytes of a strip FFmpeg
// stopped partway through.
function stripReader(maxFrames) {
  const thumbnails = Buffer.allocUnsafe(maxFrames * THUMB_BYTES);
  let frames = 0;
  let header = ""; // the header read so far, while reading one
  let lineEnds = 0; // how many of its three lines have ended
  let strip = null; // the strip's RGB bytes, once its header is read
  let filled = 0; // how many of them have arrived
  let width = 0;

  function startStrip() {
    const match = STRIP_HEADER.exec(header);
    if (!match || Number(match[2]) !== THUMB_HEIGHT)
      throw new Error(`FFmpeg sent a thumbnail strip this audit cannot read (header ${JSON.stringify(header)}).`);
    if (frames === maxFrames) throw Object.assign(new Error("FFmpeg output exceeded the bounded frame count."), { code: "OUTPUT_LIMIT" });
    width = Number(match[1]);
    if (strip?.length !== width * THUMB_HEIGHT * 3) strip = Buffer.allocUnsafe(width * THUMB_HEIGHT * 3);
    filled = 0;
  }

  function keepThumbnail() {
    const target = frames * THUMB_BYTES;
    for (let x = 0; x < THUMB_WIDTH; x += 1) {
      const sourceX = sourcePosition(x, THUMB_WIDTH, width);
      for (let y = 0; y < THUMB_HEIGHT; y += 1) {
        const source = (y * width + sourceX) * 3;
        strip.copy(thumbnails, target + (y * THUMB_WIDTH + x) * 3, source, source + 3);
      }
    }
    frames += 1;
  }

  return {
    read(chunk) {
      let position = 0;
      while (position < chunk.length) {
        if (lineEnds < 3) {
          // A header, one byte at a time, until its third line ends.
          const byte = chunk[position];
          position += 1;
          header += String.fromCharCode(byte);
          if (header.length > MAX_STRIP_HEADER_BYTES)
            throw new Error(`FFmpeg sent a thumbnail strip this audit cannot read (header ${JSON.stringify(header)}).`);
          if (byte === 10) lineEnds += 1;
          if (lineEnds === 3) startStrip();
          continue;
        }
        const amount = Math.min(chunk.length - position, strip.length - filled);
        chunk.copy(strip, filled, position, position + amount);
        filled += amount;
        position += amount;
        if (filled === strip.length) {
          keepThumbnail();
          header = "";
          lineEnds = 0;
          filled = 0;
        }
      }
    },
    result() {
      return { thumbnails: thumbnails.subarray(0, frames * THUMB_BYTES), frames, trailingBytes: header.length + filled };
    },
  };
}

/** Create a fixed-size, normalized-coordinate RGB reference for one rendered RGBA frame. */
export function frameReference(pixels, width, height, { premultiplied = false } = {}) {
  positiveInteger(width, "Frame width");
  positiveInteger(height, "Frame height");
  if (!Number.isSafeInteger(width * height * 4)) throw new RangeError("Frame pixel dimensions exceed the safe byte-size limit.");
  if (!isByteArray(pixels) || pixels.byteLength !== width * height * 4)
    throw new TypeError("Frame pixels must be RGBA Uint8Array or Uint8ClampedArray data matching width × height.");
  if (typeof premultiplied !== "boolean") throw new TypeError("premultiplied must be true or false.");

  const rgb = new Uint8Array(THUMB_BYTES);
  for (let y = 0; y < THUMB_HEIGHT; y += 1) {
    const sourceY = sourcePosition(y, THUMB_HEIGHT, height);
    for (let x = 0; x < THUMB_WIDTH; x += 1) {
      const sourceX = sourcePosition(x, THUMB_WIDTH, width);
      const source = (sourceY * width + sourceX) * 4;
      const target = (y * THUMB_WIDTH + x) * 3;
      const alpha = pixels[source + 3] / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = premultiplied
          ? (alpha > 0 ? pixels[source + channel] / alpha : 0)
          : pixels[source + channel];
        rgb[target + channel] = byte(value);
      }
    }
  }
  return rgb;
}

function referenceBytes(value, index) {
  let bytes = value;
  if (typeof value === "string") {
    if (value.length > Math.ceil(THUMB_BYTES * 4 / 3) + 4) throw new RangeError(`Frame reference ${index} exceeds the thumbnail size limit.`);
    bytes = Buffer.from(value, "base64");
  } else if (value && typeof value === "object" && !isByteArray(value)) {
    bytes = value.rgb ?? value.pixels ?? value.base64;
    return referenceBytes(bytes, index);
  }
  if (!isByteArray(bytes) || bytes.byteLength !== THUMB_BYTES)
    throw new TypeError(`Frame reference ${index} must contain exactly ${THUMB_BYTES} RGB bytes.`);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function normalizeReferences(references) {
  if (references == null) return null;
  if (!Array.isArray(references)) throw new TypeError("Frame references must be an array.");
  if (references.length === 0) throw new RangeError("At least one frame reference is required.");
  if (references.length > MAX_REFERENCES) throw new RangeError(`Frame references exceed the ${MAX_REFERENCES}-frame audit limit.`);
  return references.map(referenceBytes);
}

/**
 * Spawn a media tool while bounding its log tail, lifetime, and abort cleanup. Each piece of its
 * output goes to onStdout (without onStdout the output is ignored); an error onStdout throws
 * stops the tool and rejects with that error.
 */
function runBounded(command, args, { signal, onStdout, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    try { throwIfAborted(signal); } catch (error) { reject(error); return; }
    const child = spawn(command, args, { stdio: ["ignore", onStdout ? "pipe" : "ignore", "pipe"], shell: false });
    let stderr = "", spawnError, killTimer, timeout, stopReason, settled = false;
    if (onStdout) {
      child.stdout.on("data", (chunk) => {
        if (stopReason) return;
        try { onStdout(chunk); } catch (error) { stop(error); }
      });
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES); });

    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };
    const onAbort = () => stop(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => stop(new Error(`${basename(command)} exceeded the bounded inspection time.`)), timeoutMs);
      timeout.unref?.();
    }
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, terminatingSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (stopReason) { reject(stopReason); return; }
      if (spawnError) { reject(spawnError); return; }
      if (code !== 0) {
        reject(new Error(`${basename(command)} failed with exit code ${code ?? terminatingSignal}: ${stderr.trim() || "no diagnostic output"}`));
        return;
      }
      resolve({ stderr });
    });
  });
}

function frameMeanDifference(left, right, pixelThreshold = 0) {
  let sum = 0, changedPixels = 0, max = 0;
  for (let offset = 0; offset < THUMB_BYTES; offset += 3) {
    let pixelMax = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(left[offset + channel] - right[offset + channel]);
      sum += difference;
      max = Math.max(max, difference);
      pixelMax = Math.max(pixelMax, difference);
    }
    if (pixelMax > pixelThreshold) changedPixels += 1;
  }
  return { mean: sum / THUMB_BYTES, changedRatio: changedPixels / (THUMB_BYTES / 3), max };
}

function luma(bytes) {
  let sum = 0;
  for (let offset = 0; offset < THUMB_BYTES; offset += 3)
    sum += 0.2126 * bytes[offset] + 0.7152 * bytes[offset + 1] + 0.0722 * bytes[offset + 2];
  return sum / (THUMB_BYTES / 3);
}

// Motion facts of a decoded file: a still is STILL_SECONDS or more of frames that change under
// STILL_LEVELS on average; a brightness jump is more than JUMP_LEVELS of mean luma within
// JUMP_SECONDS where the same picture gets lighter or darker (a shade or a light popping), not
// a new picture: a cut, or footage that moves, changes pixels both ways. `planned` lists the
// scene's cut and transition times (export.mjs): a jump from PLANNED_BEFORE before one to
// PLANNED_AFTER after it is that change. Without the list, a jump from or to black (mean under
// DARK_LEVELS) is taken as a planned cut or fade.
const STILL_LEVELS = 0.3;
const STILL_SECONDS = 0.5;
const JUMP_LEVELS = 12;
const JUMP_SECONDS = 0.2;
const DARK_LEVELS = 16;
const PLANNED_BEFORE = 0.6;
const PLANNED_AFTER = 0.3;
// Pixels that change by more than PIXEL_LEVELS; at most ONE_WAY_SHARE of them the other way.
const PIXEL_LEVELS = 8;
const ONE_WAY_SHARE = 0.1;
const MOTION_LIST = 6;

/**
 * Brightness (mean luma, 0 to 255) and change (mean absolute difference from the frame before,
 * 0 to 255) of every decoded 32×18 frame, and the stills and brightness jumps found in them:
 * {luma[], diff[], stills: [{from, to}], jumps: [{at, until, from, to}]} (times in seconds).
 */
export function motionFacts(thumbnails, frameCount, fps, planned = null) {
  const frames = Math.min(frameCount, Math.floor(thumbnails.length / THUMB_BYTES));
  const frame = (index) => thumbnails.subarray(index * THUMB_BYTES, (index + 1) * THUMB_BYTES);
  const levels = Array.from({ length: frames }, (_, index) => luma(frame(index)));
  const diff = Array.from({ length: frames }, (_, index) => (index ? frameMeanDifference(frame(index - 1), frame(index)).mean : 0));
  // True when the pixels that change between two frames almost all change one way.
  const oneWay = (first, last) => {
    const a = frame(first), b = frame(last);
    let up = 0, down = 0;
    for (let offset = 0; offset < THUMB_BYTES; offset += 3) {
      const change = (0.2126 * (b[offset] - a[offset]) + 0.7152 * (b[offset + 1] - a[offset + 1]) + 0.0722 * (b[offset + 2] - a[offset + 2]));
      if (change > PIXEL_LEVELS) up += 1;
      else if (change < -PIXEL_LEVELS) down += 1;
    }
    return Math.min(up, down) <= ONE_WAY_SHARE * (up + down);
  };
  const stills = [];
  for (let index = 1, start = -1; index <= frames; index += 1) {
    if (index < frames && diff[index] < STILL_LEVELS) { if (start < 0) start = index - 1; continue; }
    if (start >= 0 && (index - 1 - start) / fps >= STILL_SECONDS) stills.push({ from: frameTime(start, fps), to: frameTime(index - 1, fps) });
    start = -1;
  }
  const jumps = [];
  const span = Math.max(1, Math.round(JUMP_SECONDS * fps));
  for (let index = 1; index < frames && jumps.length < MOTION_LIST; index += 1) {
    for (let back = 1; back <= span && index - back >= 0; back += 1) {
      const first = index - back;
      if (Math.abs(levels[index] - levels[first]) <= JUMP_LEVELS) continue;
      const onPlanned = planned
        ? planned.some((time) => frameTime(index, fps) >= time - PLANNED_BEFORE && frameTime(first, fps) <= time + PLANNED_AFTER)
        : Math.min(levels[index], levels[first]) < DARK_LEVELS;
      if (onPlanned || !oneWay(first, index)) break;
      jumps.push({ at: frameTime(first, fps), until: frameTime(index, fps), from: Math.round(levels[first]), to: Math.round(levels[index]) });
      // The next jump starts after this one.
      index += span;
      break;
    }
  }
  const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
  return { luma: levels.map((value) => round(value, 1)), diff: diff.map((value) => round(value, 2)), stills: stills.slice(0, MOTION_LIST), jumps };
}

function frameTime(index, fps) {
  return Number((index / fps).toFixed(3));
}

function frameLabel(indices, fps) {
  const shown = indices.slice(0, 20).map((index) => ({ frame: index, time: frameTime(index, fps) }));
  return { total: indices.length, frames: shown };
}

function videoLimits(format) {
  return LOSSLESS_FORMATS.has(format) ? LOSSLESS_LIMITS : LOSSY_LIMITS;
}

// Which renderer frame does decoded frame `index` look like? A file that is one frame early or
// late, or that drops or repeats a frame, can stay inside the mean and pixel limits: on FFmpeg's
// testsrc2 a file one frame early scores a mean error of about 4.4 against a limit of 10. But
// from the slip on, its frames are clearly closer to a neighbour's renderer frame than to their own.
// Answers one of:
// - "previous" or "next": that neighbour's renderer frame is clearly closer than its own.
// - "hold": a neighbour's renderer frame is exactly as close as its own. The two renderer frames
//   are the same picture (nothing moved), so this frame cannot show whether the file is shifted.
// - "own": anything else (usually its own renderer frame is the closest).
function frameNeighbour(decoded, references, index, ownError, limits) {
  const previous = index > 0 ? frameMeanDifference(decoded, references[index - 1]).mean : Infinity;
  const next = index + 1 < references.length ? frameMeanDifference(decoded, references[index + 1]).mean : Infinity;
  const closest = Math.min(previous, next);
  if (closest + limits.neighbourMargin < ownError && closest < ownError * limits.neighbourRatio)
    return next <= previous ? "next" : "previous";
  if (closest === ownError) return "hold";
  return "own";
}

// The longest stretch of frames that all look like the same neighbour ("previous" or "next").
// Hold frames are skipped: they neither extend nor end a stretch. A frame that looks like its own
// renderer frame, or like the other neighbour, ends it. Answers null when no frame looks like a
// neighbour, else { direction, start, end, frames }, where frames counts the frames that looked
// like the neighbour (holds inside the stretch are not counted).
function longestShiftRun(kinds) {
  let longest = null;
  let current = null;
  kinds.forEach((kind, index) => {
    if (kind === "hold") return;
    if (kind === "own") { current = null; return; }
    if (!current || current.direction !== kind) current = { direction: kind, start: index, end: index, frames: 0 };
    current.end = index;
    current.frames += 1;
    if (!longest || current.frames > longest.frames) longest = { ...current };
  });
  return longest;
}

// The sentence an agent reads when the file is shifted: where, how long, which way, and what to do.
// videoEncoder is the MP4 export's { family, ffmpegEncoder, quality } (mp4-encoders.mjs): a
// hardware encoder or "small" quality may drop enough detail that frames look like their neighbours.
function shiftDetail(run, fps, videoEncoder) {
  const early = run.direction === "next";
  const hardware = videoEncoder && videoEncoder.family !== "software";
  const lossy = hardware || videoEncoder?.quality === "small";
  const better = { small: 'videoQuality "standard" or "high"', standard: 'videoQuality "high"' }[videoEncoder?.quality];
  const tries = [better, hardware ? 'videoEncoder "software"' : ""].filter(Boolean).join(", or with ");
  return `From frame ${run.start} (${frameTime(run.start, fps)} s) to frame ${run.end} (${frameTime(run.end, fps)} s), `
    + `${run.frames} decoded frames look like the renderer frame just ${early ? "after" : "before"} their own: `
    + `the file runs a frame ${early ? "early" : "late"} there, as if a frame was ${early ? "dropped" : "repeated"}. `
    + (lossy
      ? `The video encoder (${videoEncoder.ffmpegEncoder}, ${videoEncoder.quality} quality) may have dropped detail there, so frames look like their neighbours. Render again with ${tries}.`
      : "This is a fault in encoding the file, not in your scene. Render again; if it fails again, report it with this message and the scene.");
}

// decoded is stripReader's result: the decoded file's thumbnails, one after another.
function compareVideoFrames(decoded, references, fps, format, videoEncoder) {
  const { thumbnails: raw, frames: frameCount, trailingBytes } = decoded;
  const limits = videoLimits(format);
  const mismatchIndices = [], blackIndices = [], frozenIndices = [], flickerIndices = [];
  const neighbourKinds = [];
  const perFrame = [];
  const actual = Array.from({ length: Math.min(frameCount, references.length) }, (_, index) =>
    raw.subarray(index * THUMB_BYTES, (index + 1) * THUMB_BYTES));

  for (let index = 0; index < actual.length; index += 1) {
    const diff = frameMeanDifference(actual[index], references[index], limits.pixelChannel);
    const mismatch = diff.mean > limits.meanRgb || diff.changedRatio > limits.badPixelRatio;
    if (mismatch) mismatchIndices.push(index);
    neighbourKinds.push(frameNeighbour(actual[index], references, index, diff.mean, limits));
    const expectedLuma = luma(references[index]), actualLuma = luma(actual[index]);
    if (expectedLuma > 16 && actualLuma < 2.5) blackIndices.push(index);
    perFrame.push({ frame: index, time: frameTime(index, fps), meanRgbError: Number(diff.mean.toFixed(3)), changedPixelRatio: Number(diff.changedRatio.toFixed(4)), maxChannelError: diff.max,
      ...(mismatch ? { mismatch: true } : {}) });

    if (index === 0 || index >= references.length) continue;
    const expectedChange = frameMeanDifference(references[index - 1], references[index]).mean;
    const actualChange = frameMeanDifference(actual[index - 1], actual[index]).mean;
    if (expectedChange > Math.max(8, limits.meanRgb * 1.5) && actualChange <= (LOSSLESS_FORMATS.has(format) ? 0.5 : 2.5))
      frozenIndices.push(index);
    if (expectedChange <= (LOSSLESS_FORMATS.has(format) ? 0 : 0.5) && actualChange > limits.temporalRgb)
      flickerIndices.push(index);
  }

  const countMatches = frameCount === references.length && trailingBytes === 0;
  const closerToPrevious = [], closerToNext = [];
  neighbourKinds.forEach((kind, index) => {
    if (kind === "previous") closerToPrevious.push(index);
    if (kind === "next") closerToNext.push(index);
  });
  const neighbourIndices = [...closerToPrevious, ...closerToNext].sort((left, right) => left - right);
  const shiftRun = longestShiftRun(neighbourKinds);
  const shifted = Boolean(shiftRun && shiftRun.frames >= limits.shiftRunFrames);
  const rendererMatches = mismatchIndices.length === 0 && !shifted;
  const mismatchDetail = [
    mismatchIndices.length ? `Decoded frames differ from their renderer references at ${mismatchIndices.length} frame(s).` : "",
    shifted ? shiftDetail(shiftRun, fps, videoEncoder) : "",
  ].filter(Boolean).join(" ") || undefined;
  const unexpectedBlackDetail = blackIndices.length ? `${blackIndices.length} decoded frame(s) are black although their renderer references are not.` : undefined;
  const frozenDetail = frozenIndices.length ? `${frozenIndices.length} decoded frame(s) repeat a prior frame where the renderer reference changes.` : undefined;
  const flickerDetail = flickerIndices.length ? `${flickerIndices.length} decoded frame(s) flicker during a reference hold.` : undefined;
  const checks = {
    decodedFrameCount: check(countMatches ? "pass" : "fail", references.length, { frames: frameCount, trailingBytes },
      countMatches ? undefined : "The decoded output frame count does not match the renderer references."),
    rendererMatch: check(rendererMatches ? "pass" : "fail",
      { meanRgbErrorAtMost: limits.meanRgb, changedPixelRatioAtMost: limits.badPixelRatio, framesInARowLikeANeighbourAtMost: limits.shiftRunFrames - 1 },
      { ...frameLabel(mismatchIndices, fps), ...(shiftRun ? { framesInARowLikeANeighbour: shiftRun.frames } : {}) },
      mismatchDetail),
    unexpectedBlackFrames: check(blackIndices.length ? "fail" : "pass", "no unexpected black frames", frameLabel(blackIndices, fps), unexpectedBlackDetail),
    frozenFrames: check(frozenIndices.length ? "fail" : "pass", "no repeated frame where references change", frameLabel(frozenIndices, fps), frozenDetail),
    holdFlicker: check(flickerIndices.length ? "fail" : "pass", "no visible change during identical reference holds", frameLabel(flickerIndices, fps), flickerDetail),
  };
  const observedMean = perFrame.length ? perFrame.reduce((sum, frame) => sum + frame.meanRgbError, 0) / perFrame.length : null;
  return {
    checks,
    facts: {
      decodedFrameCount: frameCount,
      referenceFrameCount: references.length,
      trailingBytes,
      frameSizeBytes: THUMB_BYTES,
      framesCompared: perFrame.length,
      meanRgbError: observedMean === null ? null : Number(observedMean.toFixed(3)),
      thresholds: limits,
      mismatchCount: mismatchIndices.length,
      mismatchFrames: mismatchIndices.slice(0, 20),
      closerToPreviousCount: closerToPrevious.length,
      closerToNextCount: closerToNext.length,
      closerToNeighbourFrames: neighbourIndices.slice(0, 20),
      longestShiftRun: shiftRun && { ...shiftRun, startTime: frameTime(shiftRun.start, fps), endTime: frameTime(shiftRun.end, fps) },
      unexpectedBlackCount: blackIndices.length,
      unexpectedBlackFrames: blackIndices.slice(0, 20),
      frozenCount: frozenIndices.length,
      frozenFrames: frozenIndices.slice(0, 20),
      holdFlickerCount: flickerIndices.length,
      holdFlickerFrames: flickerIndices.slice(0, 20),
    },
  };
}

function parseDb(log, expression) {
  const matches = [...log.matchAll(expression)];
  if (!matches.length) return null;
  const value = matches[matches.length - 1][1].trim().toLowerCase();
  if (value === "-inf" || value === "-infinity") return Number.NEGATIVE_INFINITY;
  if (value === "inf" || value === "+inf" || value === "infinity") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inspectAudioLog(log) {
  const integratedLufs = parseDb(log, /(?:^|\n)\s*I:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)|[+-]?inf)\s*LUFS/gim);
  const truePeakDbfs = parseDb(log, /(?:^|\n)\s*Peak:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)|[+-]?inf)\s*dBFS/gim);
  const samplePeakDbfs = parseDb(log, /Peak level dB:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)|[+-]?inf)/gim);
  const peakDbfs = truePeakDbfs ?? samplePeakDbfs;
  const silent = peakDbfs === Number.NEGATIVE_INFINITY && integratedLufs === Number.NEGATIVE_INFINITY;
  return {
    hasIntegratedLufs: integratedLufs !== null,
    hasPeak: peakDbfs !== null,
    integratedLufs: Number.isFinite(integratedLufs) ? Number(integratedLufs.toFixed(2)) : null,
    truePeakDbfs: Number.isFinite(truePeakDbfs) ? Number(truePeakDbfs.toFixed(2)) : null,
    samplePeakDbfs: Number.isFinite(samplePeakDbfs) ? Number(samplePeakDbfs.toFixed(2)) : null,
    peakDbfs: Number.isFinite(peakDbfs) ? Number(peakDbfs.toFixed(2)) : null,
    silent,
  };
}

async function inspectAudio(file, format, expectedHasAudio, fps, frameCount, signal, targetLufs, heldAt) {
  if (expectedHasAudio !== true) {
    const detail = expectedHasAudio === false ? "No audio was expected; loudness and clipping do not apply." : "Audio presence was not supplied.";
    return {
      checks: {
        audioLoudness: check("unsupported", undefined, undefined, detail),
        audioClipping: check("unsupported", undefined, undefined, detail),
      },
      facts: { audio: null },
      warnings: expectedHasAudio === false ? [] : ["Audio loudness and clipping were not measured because audio presence was not specified."],
    };
  }
  if (format === "apng") {
    const detail = "APNG does not carry an audio stream.";
    return { checks: {
      audioLoudness: check("fail", "audio measurements for an audio render", null, detail),
      audioClipping: check("fail", "no clipped audio", null, detail),
    }, facts: { audio: null }, warnings: [detail] };
  }

  const command = boundedCommand("ffmpeg");
  const expectedDuration = Number.isFinite(fps) && fps > 0 && Number.isFinite(frameCount) && frameCount > 0
    ? frameCount / fps : 600;
  const durationLimit = expectedDuration + Math.max(1, Number.isFinite(fps) && fps > 0 ? 1 / fps : 0);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "info", "-i", file,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", String(durationLimit),
    "-af", "astats=metadata=0:reset=0,ebur128=peak=true:framelog=quiet", "-f", "null", "-"];
  let log;
  try {
    ({ stderr: log } = await runBounded(command, args, { signal,
      timeoutMs: Math.min(15 * 60_000, Math.max(30_000, (durationLimit + 1) * 4_000)) }));
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    const detail = error?.code === "ENOENT"
      ? `${basename(command)} was not found; configure KINO_FFMPEG or OPEN_MOTION_FFMPEG.`
      : error?.message ?? "FFmpeg could not measure audio.";
    return { checks: {
      audioLoudness: check("fail", "measurable audio stream", null, detail),
      audioClipping: check("fail", "audio peak measurement", null, detail),
    }, facts: { audio: null }, warnings: [detail] };
  }
  const audio = inspectAudioLog(log);
  const missingLoudness = audio.hasIntegratedLufs ? undefined : "FFmpeg completed but returned no EBU R128 integrated-loudness summary.";
  const missingPeak = audio.hasPeak ? undefined : "FFmpeg completed but returned no astats or EBU R128 peak summary.";
  const atOrAboveFullScale = audio.peakDbfs !== null && audio.peakDbfs >= 0;
  const checks = {
    audioLoudness: check(audio.hasIntegratedLufs ? "pass" : "fail", "report integrated loudness in LUFS", audio.integratedLufs, missingLoudness),
    audioClipping: check(!audio.hasPeak ? "fail" : atOrAboveFullScale ? "warn" : "pass", "report whether the peak reaches full scale", audio.peakDbfs,
      missingPeak ?? (atOrAboveFullScale ? "The measured peak reaches full scale; this alone does not prove clipped samples." : undefined)),
  };
  // A render brought to a loudness target (render option loudness) is compared with it.
  const offTarget = Number.isFinite(targetLufs) && Number.isFinite(audio.integratedLufs) && Math.abs(audio.integratedLufs - targetLufs) > 1;
  const warnings = !Number.isFinite(targetLufs) ? ["Integrated loudness is informational; no target LUFS was supplied."]
    : offTarget ? [`Integrated loudness ${audio.integratedLufs} LUFS is more than 1 LU from the ${targetLufs} LUFS target.` +
      (Number.isFinite(heldAt) ? ` The peak at ${heldAt} s held the gain so the mix keeps its balance: lower that sound to reach the target.` : "")] : [];
  if (audio.silent) warnings.push("The audio stream is silent; loudness is reported at the encoder measurement floor.");
  if (missingLoudness) warnings.push(missingLoudness);
  if (missingPeak) warnings.push(missingPeak);
  if (atOrAboveFullScale) warnings.push("The audio peak reaches or exceeds 0 dBFS; confirm by listening because a full-scale peak alone does not prove clipping.");
  return { checks, facts: { audio }, warnings };
}

/** Compare bounded FFmpeg-decoded thumbnails with renderer references after encoding. */
export async function inspectRenderedOutput(file, expectedInput, { signal } = {}) {
  if (typeof file !== "string" || !file) throw new TypeError("A rendered output path is required.");
  if (!expectedInput || typeof expectedInput !== "object" || Array.isArray(expectedInput))
    throw new TypeError("Rendered-output expectations are required.");
  const format = String(expectedInput.format ?? "").toLowerCase();
  if (!format) throw new TypeError("A rendered output format is required.");
  if (expectedInput.hasAudio != null && typeof expectedInput.hasAudio !== "boolean") throw new TypeError("hasAudio must be true, false, or omitted.");
  throwIfAborted(signal);

  if (!SUPPORTED_FORMATS.has(format)) {
    const detail = format === "gif"
      ? "GIF frame coalescing makes one-to-one renderer-frame comparison unreliable."
      : `Rendered-frame comparison is not supported for ${format}.`;
    return report({ contentAudit: check("unsupported", undefined, undefined, detail) }, { method: "Format is outside the one-to-one decoded-frame audit." }, [detail]);
  }
  const fileInfo = await stat(file);
  if (!fileInfo.isFile() || fileInfo.size === 0) {
    return report({
      nonEmpty: check("fail", "non-empty rendered file", fileInfo.size),
      contentAudit: check("fail", "decoded frames matching references", null, "The rendered file is empty or not a regular file."),
    }, { sizeBytes: fileInfo.size, method: "FFmpeg decoded-frame and audio audit." });
  }

  const references = normalizeReferences(expectedInput.references);
  if (!references) {
    const warnings = ["No renderer frame references were supplied; dropped, frozen, black, and hold-flicker frames were not checked."];
    const audio = await inspectAudio(file, format, expectedInput.hasAudio, expectedInput.fps, 0, signal, expectedInput.targetLufs, expectedInput.heldAt);
    return report({ nonEmpty: check("pass", "non-empty rendered file", fileInfo.size),
      contentAudit: check("unsupported", undefined, undefined, "No per-frame references were supplied."), ...audio.checks },
    { sizeBytes: fileInfo.size, method: expectedInput.hasAudio === true ? "FFmpeg EBU R128/astats audio inspection; frame comparison unavailable without renderer references." : "FFmpeg audio inspection; frame comparison unavailable without renderer references.", ...audio.facts }, [...warnings, ...audio.warnings]);
  }
  const fps = expectedInput.fps;
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) throw new TypeError("Rendered-output FPS must be positive and finite when frame references are supplied.");
  throwIfAborted(signal);

  const command = boundedCommand("ffmpeg");
  const outputFrameLimit = references.length + 1;
  // Each frame comes out as a PPM strip of its 18 thumbnail rows (stripGraph), read by stripReader.
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file,
    "-filter_complex", stripGraph(LOSSLESS_FORMATS.has(format) ? LOSSLESS_COLOUR_FLAGS : COLOUR_FLAGS), "-map", "[strip]",
    "-fps_mode", "passthrough", "-frames:v", String(outputFrameLimit), "-pix_fmt", "rgb24", "-c:v", "ppm", "-f", "image2pipe", "pipe:1"];

  const strips = stripReader(outputFrameLimit);
  let decodeError = null;
  try {
    await runBounded(command, args, { signal, onStdout: strips.read,
      timeoutMs: Math.min(15 * 60_000, Math.max(30_000, (references.length / fps + 1) * 4_000)) });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    decodeError = error?.code === "ENOENT"
      ? `${basename(command)} was not found; configure KINO_FFMPEG or OPEN_MOTION_FFMPEG.`
      : error?.message ?? "FFmpeg could not decode the rendered video.";
    const audio = await inspectAudio(file, format, expectedInput.hasAudio, fps, references.length, signal, expectedInput.targetLufs, expectedInput.heldAt);
    return report({
      decodedFrames: check("fail", references.length, null, decodeError),
      contentAudit: check("fail", "decoded frames matching references", null, decodeError),
      ...audio.checks,
    }, { sizeBytes: fileInfo.size, referenceFrameCount: references.length, method: expectedInput.hasAudio === true ? "FFmpeg decoded 32×18 RGB thumbnails plus EBU R128/astats audio measurement." : "FFmpeg decoded 32×18 RGB thumbnails.", audio: audio.facts.audio }, [decodeError, ...audio.warnings]);
  }

  const decoded = strips.result();
  const compared = compareVideoFrames(decoded, references, fps, format, expectedInput.videoEncoder);
  const audio = await inspectAudio(file, format, expectedInput.hasAudio, fps, references.length, signal, expectedInput.targetLufs, expectedInput.heldAt);
  const motion = motionFacts(decoded.thumbnails, decoded.frames, fps, expectedInput.planned ?? null);
  return { motion, ...report({
    nonEmpty: check("pass", "non-empty rendered file", fileInfo.size),
    ...compared.checks,
    ...audio.checks,
    }, { sizeBytes: fileInfo.size, fps, method: expectedInput.hasAudio === true ? "FFmpeg decoded 32×18 RGB thumbnails and measured audio with EBU R128/astats." : "FFmpeg decoded 32×18 RGB thumbnails.", ...compared.facts, ...audio.facts }, audio.warnings) };
}
