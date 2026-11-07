// Decodes the one still frame that a Lottie export embeds for a GIF or video layer.
// GIFs are decoded by engine/gifDecode.js (the decoder the editor and raster exports use), within its size
// limits and one of the server's shared GIF decode slots. Videos are decoded by FFmpeg.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, chmod, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ImageData, createCanvas, loadImage } from "@napi-rs/canvas";
import { encodeLottiePng } from "./lottie-png.mjs";
import { writePrivateFile } from "./lottie-images.mjs";
import { gifDecodeSlots } from "./gif-decode-slots.mjs";
import { PICTURE_COLOR_FILTERS, videoGridArgs } from "./media-probe.mjs";
import { composeGifFrames, parseGif, parseGifStart } from "../engine/gifDecode.js";
import { gifFrameIndex } from "../engine/playback.js";

const MAX_ERROR_LENGTH = 8000;
const SUPPORTED = new Map([
  ["image/gif", ".gif"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["video/x-m4v", ".m4v"],
]);

function aborted(signal) {
  const error = new Error("Lottie media frame decoding was cancelled", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw aborted(signal);
}

function commandFor(kind) {
  return kind === "ffprobe"
    ? process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe"
    : process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
}

function processError(command, kind, error) {
  if (error?.name === "AbortError") return error;
  if (error?.code === "ENOENT") {
    return new Error(
      `${kind} executable “${basename(command)}” was not found. Install FFmpeg with ffprobe, or configure KINO_FFMPEG and KINO_FFPROBE.`,
      { cause: error },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${kind} could not decode this Lottie media file. Check that it is valid and supported. ${detail}`, { cause: error });
}

function runSubprocess(command, args, signal, cwd) {
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stdoutSize = 0;
    let stderr = "";
    let killTimer;
    let settled = false;

    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(output);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_ERROR_LENGTH) stderr = stderr.slice(-MAX_ERROR_LENGTH);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, terminatingSignal) => {
      if (signal?.aborted) finish(aborted(signal));
      else if (code === 0) finish(null, Buffer.concat(stdout, stdoutSize).toString("utf8"));
      else finish(new Error(`${basename(command)} exited with ${code ?? terminatingSignal}: ${stderr.trim() || "no diagnostic output"}`));
    });
  });
}

async function execute(run, kind, args, signal, cwd) {
  const command = commandFor(kind);
  try {
    throwIfAborted(signal);
    const output = await run(command, args, signal, cwd);
    if (Buffer.isBuffer(output)) return output.toString("utf8");
    if (typeof output === "string") return output;
    if (typeof output?.stdout === "string") return output.stdout;
    if (Buffer.isBuffer(output?.stdout)) return output.stdout.toString("utf8");
    throw new TypeError(`${kind} returned no text output`);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw aborted(signal);
    throw processError(command, kind === "ffprobe" ? "ffprobe" : "FFmpeg", error);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`ffprobe returned invalid ${label} metadata`, { cause: error });
  }
}

async function webmDecoder(run, path, signal, cwd) {
  const text = await execute(run, "ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name:stream_tags=alpha_mode",
    "-of", "json",
    path,
  ], signal, cwd);
  const stream = parseJson(text, "WebM stream").streams?.[0];
  if (!stream) throw new Error("ffprobe found no video stream in this WebM file");
  const alphaMode = Object.entries(stream.tags ?? {}).find(([name]) => name.toLowerCase() === "alpha_mode")?.[1];
  if (String(alphaMode) !== "1") return null;
  if (stream.codec_name === "vp9") return "libvpx-vp9";
  if (stream.codec_name === "vp8") return "libvpx";
  return null;
}

async function videoDuration(run, path, signal, cwd) {
  const text = await execute(run, "ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    path,
  ], signal, cwd);
  const duration = Number(parseJson(text, "video duration").format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : Infinity;
}

// The video frame a Play range starts on; a time after the end of the video shows its last frame.
async function framePngAt(run, mime, inputPath, outputPath, time, signal, cwd) {
  const decoder = mime === "video/webm" ? await webmDecoder(run, inputPath, signal, cwd) : null;
  const end = await videoDuration(run, inputPath, signal, cwd);
  const args = videoGridArgs({
    input: inputPath,
    output: outputPath,
    firstTime: Math.min(time, end),
    fps: 60,
    count: 1,
    decoderArgs: decoder ? ["-c:v", decoder] : [],
    outputArgs: ["-an", "-sn", "-dn", "-pix_fmt", "rgba", "-f", "image2", "-update", "1"],
  });
  await execute(run, "ffmpeg", args, signal, cwd);
  throwIfAborted(signal);
}

async function firstFramePng(run, mime, inputPath, outputPath, signal, cwd) {
  let decoder = null;
  if (mime === "video/webm") decoder = await webmDecoder(run, inputPath, signal, cwd);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  if (decoder) args.push("-c:v", decoder);
  // Deliberately do not seek: the first decoded frame is the frame other Lottie exporters embed.
  // FFmpeg's default autorotation preserves the displayed orientation of videos.
  args.push(
    "-i", inputPath,
    "-map", "0:v:0",
    "-frames:v", "1",
    // No color tags, as in the raster pictures, so Skia draws the decoded values.
    "-vf", PICTURE_COLOR_FILTERS.join(","),
    "-an", "-sn", "-dn",
    "-pix_fmt", "rgba",
    "-f", "image2",
    "-update", "1",
    outputPath,
  );
  await execute(run, "ffmpeg", args, signal, cwd);
  throwIfAborted(signal);
}

// JPEG cannot store a side longer than this many pixels.
const MAX_JPEG_SIDE = 65_500;

/**
 * Encodes RGBA pixels (straight alpha) for embedding: JPEG at quality 80 when every pixel is opaque
 * and `requirePng` is false, otherwise PNG with transparency.
 */
async function encodePixels(pixels, width, height, { requirePng, signal }) {
  let opaque = true;
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset] !== 255) {
      opaque = false;
      break;
    }
  }
  // Pictures too wide or tall for JPEG stay PNG.
  if (requirePng || !opaque || width > MAX_JPEG_SIDE || height > MAX_JPEG_SIDE) {
    return { buffer: encodeLottiePng(pixels, width, height, { signal }), mime: "image/png" };
  }
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  const buffer = await canvas.encode("jpeg", 80);
  throwIfAborted(signal);
  return { buffer, mime: "image/jpeg" };
}

/** Reads the PNG picture FFmpeg wrote for a video frame and encodes it as PNG for embedding. */
async function encodeVideoFrame(png, signal) {
  let bitmap;
  try {
    bitmap = await loadImage(png);
  } catch (error) {
    throw new Error(`FFmpeg produced a frame image kino could not decode: ${error.message || String(error)}`, { cause: error });
  }
  throwIfAborted(signal);
  if (!Number.isSafeInteger(bitmap.width) || bitmap.width < 1 || !Number.isSafeInteger(bitmap.height) || bitmap.height < 1) {
    throw new Error("FFmpeg produced a frame with invalid dimensions");
  }
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return encodePixels(pixels, bitmap.width, bitmap.height, { requirePng: true, signal });
}

/**
 * Parses as much of the GIF as the frame at `time` needs, and returns that frame's index.
 * When that frame is the first one (time 0, a time inside the first frame's delay, or a GIF with one
 * frame), only the start of the file is read, with the larger still-picture limit (parseGifStart).
 * Otherwise the whole GIF is read with the limits for playing it.
 */
function gifAtTime(input, time) {
  if (time <= 0) return { gif: parseGifStart(input), index: 0 };
  let start = null;
  try {
    start = parseGifStart(input);
  } catch {
    // Reading the whole GIF below reports the problem, with the limits for playing it.
  }
  if (start && (!start.animated || time < start.durations[0])) return { gif: start, index: 0 };
  const gif = parseGif(input);
  return { gif, index: gifFrameIndex(gif.durations, time) };
}

/**
 * The GIF frame shown `time` seconds into the GIF (frames follow their delays and loop), composed with
 * browser rules. Only the frames up to that one are decoded, inside one of the shared GIF decode slots.
 * A GIF over the decoding limits, or one browsers cannot decode, throws before any pixel is decoded
 * (code GIF_TOO_LARGE or GIF_UNREADABLE, from engine/gifDecode.js).
 */
async function decodeGifFrame(input, time, { signal, slots, requirePng = false }) {
  const { gif, index } = gifAtTime(input, time);
  let frame;
  await slots.run(() => composeGifFrames(gif, {
    wanted: (frameIndex) => frameIndex === index,
    signal,
    onFrame: async (frameIndex, rgba) => {
      frame = await encodePixels(rgba, gif.width, gif.height, { requirePng, signal });
    },
  }), { signal });
  return { buffer: frame.buffer, mime: frame.mime, animated: gif.animated ?? gif.frames.length > 1 };
}

/**
 * Decode one real frame of an animated image or video for Lottie embedding.
 * `time` is the time inside the media file in seconds (0, the first frame, by default).
 * Resolves with { buffer, mime, animated }.
 * GIF errors keep their code (GIF_TOO_LARGE or GIF_UNREADABLE) and message, so the caller can name the layer.
 * `slots` is the GIF decode limit; tests pass their own.
 */
export async function decodeLottieMediaFrame(
  { buffer, mime },
  { directory, signal, runProcess: suppliedRun, time = 0, slots = gifDecodeSlots, requirePng = false } = {},
) {
  if (typeof mime !== "string") throw new TypeError("Lottie media MIME type is required");
  const normalizedMime = mime.split(";", 1)[0].trim().toLowerCase();
  const extension = SUPPORTED.get(normalizedMime);
  if (!extension) throw new TypeError(`Unsupported Lottie media MIME type: ${mime}`);
  const input = Buffer.isBuffer(buffer)
    ? buffer
    : buffer instanceof Uint8Array
      ? Buffer.from(buffer)
      : null;
  if (!input?.length) throw new TypeError("Lottie media bytes are required");
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("A private Lottie media temp directory is required");
  }
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
    throw new TypeError("Lottie media frame time must be a finite number of seconds, 0 or more");
  }

  throwIfAborted(signal);
  if (normalizedMime === "image/gif") {
    try {
      return await decodeGifFrame(input, time, { signal, slots, requirePng });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw aborted(signal);
      if (error?.code === "GIF_TOO_LARGE" || error?.code === "GIF_UNREADABLE") throw error;
      throw new Error(`Lottie media ${time > 0 ? "" : "first-"}frame decoding failed: ${error.message || String(error)}`, { cause: error });
    }
  }

  const cwd = resolve(directory);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const run = suppliedRun ?? runSubprocess;
  const inputPath = join(cwd, `lottie-media-${randomUUID()}${extension}`);
  const outputPath = join(cwd, `lottie-frame-${randomUUID()}.png`);
  let ownsInput = false;
  let ownsOutput = false;
  try {
    await writePrivateFile(inputPath, input);
    ownsInput = true;
    throwIfAborted(signal);

    await writePrivateFile(outputPath, Buffer.alloc(0));
    ownsOutput = true;
    if (time > 0) await framePngAt(run, normalizedMime, inputPath, outputPath, time, signal, cwd);
    else await firstFramePng(run, normalizedMime, inputPath, outputPath, signal, cwd);
    await chmod(outputPath, 0o600);
    const png = await readFile(outputPath);
    if (!png.length) throw new Error(`FFmpeg produced an empty ${time > 0 ? "" : "first-"}frame image`);
    const frame = await encodeVideoFrame(png, signal);
    return { buffer: frame.buffer, mime: frame.mime, animated: true };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw aborted(signal);
    if (error?.message?.startsWith("ffprobe could not decode") || error?.message?.startsWith("FFmpeg could not decode")) throw error;
    throw new Error(`Lottie media ${time > 0 ? "" : "first-"}frame decoding failed: ${error.message || String(error)}`, { cause: error });
  } finally {
    if (ownsOutput) await unlink(outputPath).catch(() => {});
    if (ownsInput) await unlink(inputPath).catch(() => {});
  }
}
