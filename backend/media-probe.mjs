// Reads facts about uploaded media files with ffprobe and decodes GIF frames.
// Media Play needs three things from the server:
//   - how long a file is and how big its picture is (probeMedia),
//   - how long each GIF frame stays on screen (probeGifTimeline),
//   - every GIF frame as a full PNG picture (decodeGifFrames).
// GIFs are read by engine/gifDecode.js, the same decoder the editor uses, with browser rules; never by FFmpeg.
// It also builds the FFmpeg arguments that sample a video on a fixed frame grid (videoGridArgs).
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ImageData, createCanvas } from "@napi-rs/canvas";
import { composeGifFrames, parseGif } from "../engine/gifDecode.js";
import { probeSlot } from "./process-slots.mjs";

const MAX_ERROR_LENGTH = 12000;
// Video frame lookups accept 1 ms of drift; this matches MEDIA_SAMPLE_TOLERANCE in src/playback.js.
const SAMPLE_TOLERANCE = 0.001;
// The grid starts decoding this many seconds before the first sample, so the frame that is
// already on screen at that time (it may have started earlier) is decoded too.
const SEEK_MARGIN = 1;
const STILL_IMAGE_FORMAT = /^(?:image2|apng|[a-z0-9]+_pipe)$/;

export function ffmpegCommand() {
  return process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
}

export function ffprobeCommand() {
  return process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";
}

function abortError(signal) {
  const error = new Error("Media processing was cancelled.", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}

// An ffprobe run that has not answered by then is stopped: a stuck read (a file on a sleeping
// network disk, a broken container) would otherwise keep its process for good.
export const PROBE_TIMEOUT_MS = 60_000;

/**
 * Runs ffmpeg or ffprobe and resolves with its standard output as text.
 * A missing executable becomes an error that says how to install or configure it.
 * ffprobe runs take a probe slot (at most three at once, process-slots.mjs) and stop after
 * `timeoutMs` (PROBE_TIMEOUT_MS); an ffmpeg run has no time limit unless `timeoutMs` is given.
 */
export function runMediaTool(kind, args, { signal, cwd, timeoutMs = kind === "ffprobe" ? PROBE_TIMEOUT_MS : null } = {}) {
  const run = () => runMediaToolNow(kind, args, { signal, cwd, timeoutMs });
  return kind === "ffprobe" ? probeSlot(run) : run();
}

function runMediaToolNow(kind, args, { signal, cwd, timeoutMs }) {
  const command = kind === "ffprobe" ? ffprobeCommand() : ffmpegCommand();
  const label = kind === "ffprobe" ? "ffprobe" : "FFmpeg";
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(abortError(signal));
      return;
    }
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killTimer;
    let timedOut = false;
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = timeoutMs > 0 ? setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs) : null;
    timeout?.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_ERROR_LENGTH) stderr = stderr.slice(-MAX_ERROR_LENGTH);
    });
    const cleanUp = () => {
      clearTimeout(killTimer);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanUp();
      if (error.code === "ENOENT") {
        rejectPromise(new Error(
          `${label} executable “${basename(command)}” was not found. Install FFmpeg with ffprobe, or configure KINO_FFMPEG and KINO_FFPROBE.`,
          { cause: error },
        ));
      } else rejectPromise(error);
    });
    child.once("close", (code, terminatingSignal) => {
      cleanUp();
      if (signal?.aborted) rejectPromise(abortError(signal));
      else if (timedOut) rejectPromise(new Error(`${basename(command)} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`));
      else if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${basename(command)} failed with exit code ${code ?? terminatingSignal}: ${stderr.trim() || "no diagnostic output"}`));
    });
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`ffprobe returned unreadable ${label} information.`, { cause: error });
  }
}

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/**
 * Reads how long each frame of a GIF stays on screen, in seconds, using the browser's delay rule.
 * Only the GIF's block structure is read; a GIF over the decoding limits throws (code GIF_TOO_LARGE).
 */
export async function probeGifTimeline(path) {
  return { durations: parseGif(await readFile(path)).durations };
}

function displaySize(stream) {
  let width = positive(stream?.width);
  let height = positive(stream?.height);
  const rotation = Number(stream?.side_data_list?.find((item) => item.rotation != null)?.rotation ?? stream?.tags?.rotate ?? 0);
  // FFmpeg and browsers show a rotated phone video upright, so its picture is taller than wide.
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return { width: Math.round(width), height: Math.round(height) };
}

// Probe answers kept by file (its path, size and change time) and tool: a look sheet or check
// renders the same videos many times, and each probe is a new ffprobe process.
const PROBES_KEPT = 512;
const probes = new Map();
// Probes running now, by the same key: a look sheet asks for one video from many layers at once,
// and they share one ffprobe run instead of each starting its own.
const probing = new Map();

async function remembered(kind, path, probe) {
  let info;
  try { info = await stat(path); } catch { return probe(); }
  const key = `${kind}\n${ffprobeCommand()}\n${path}\n${info.size}\n${info.mtimeMs}`;
  if (probes.has(key)) return structuredClone(probes.get(key));
  if (!probing.has(key)) probing.set(key, probe().finally(() => probing.delete(key)));
  const value = await probing.get(key);
  probes.set(key, value);
  if (probes.size > PROBES_KEPT) probes.delete(probes.keys().next().value);
  return structuredClone(value);
}

/**
 * Probes an image, GIF, video, or audio file.
 * Returns { duration, width, height, hasVideo, hasAudio } plus { frameCount, animated } for GIFs.
 * Duration is in seconds and is 0 for still images or when the file does not say.
 * The answer is kept for the file until it changes.
 */
export function probeMedia(path, options = {}) {
  return remembered("media", path, () => probeMediaNow(path, options));
}

async function probeMediaNow(path, { signal } = {}) {
  const text = await runMediaTool("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=format_name,duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate",
    "-of", "json",
    path,
  ], { signal });
  const info = parseJson(text, "media");
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const formatName = String(info.format?.format_name ?? "");
  // Album art inside an audio file is stored as a video stream; it is not a picture track.
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const result = {
    duration: 0,
    ...displaySize(video),
    hasVideo: Boolean(video),
    hasAudio,
  };
  if (formatName === "gif") {
    const { durations } = await probeGifTimeline(path);
    const total = durations.reduce((sum, value) => sum + value, 0);
    return { ...result, duration: Math.round(total * 1000) / 1000, frameCount: durations.length, animated: durations.length > 1 };
  }
  if (STILL_IMAGE_FORMAT.test(formatName)) return result;
  const streamDuration = Math.max(0, ...streams.map((stream) => positive(stream.duration)));
  return { ...result, duration: positive(info.format?.duration) || streamDuration };
}

/** A frame rate as ffprobe writes it ("30000/1001", "25/1", "0/0") in frames a second, or 0. */
export function parseFrameRate(text) {
  const [top, bottom = "1"] = String(text ?? "").split("/");
  const rate = Number(top) / Number(bottom);
  return Number.isFinite(rate) && rate > 0 && rate <= 1000 ? rate : 0;
}

/**
 * How many frames a second a video file's picture track has: its average rate, else the rate
 * its timestamps are based on, else 30. A clip with a speed (engine/mediaTime.js) is exported from
 * the file's own frames, so this tells which frame a source time falls in.
 */
export function probeFrameRate(path, options = {}) {
  return remembered("frame rate", path, () => probeFrameRateNow(path, options));
}

async function probeFrameRateNow(path, { signal } = {}) {
  const text = await runMediaTool("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json", path,
  ], { signal });
  const stream = parseJson(text, "frame rate").streams?.[0] ?? {};
  return parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate) || 30;
}

export function gifFrameFileName(index) {
  return `${String(index).padStart(6, "0")}.png`;
}

/**
 * Writes GIF frames as full-size RGBA PNG files (000000.png, 000001.png, ...) into `outDir`.
 * `gif` comes from parseGif. `frames` (a Set of frame numbers) limits which frames are written;
 * every frame is written when it is left out. Frames are composed with browser rules, and
 * PNG encoding runs off the main thread, so the server keeps answering requests meanwhile.
 * When the PNG files together would grow past `maxBytes`, writing stops with an error (code GIF_TOO_LARGE).
 * Resolves with the number of bytes written.
 */
export async function writeGifFrames(gif, outDir, { frames, signal, maxBytes = Infinity } = {}) {
  const canvas = createCanvas(gif.width, gif.height);
  const context = canvas.getContext("2d");
  let written = 0;
  await composeGifFrames(gif, {
    wanted: frames ? (index) => frames.has(index) : undefined,
    signal,
    onFrame: async (index, rgba) => {
      // putImageData copies the pixels, so the decoder may draw the next frame while this one encodes.
      context.putImageData(new ImageData(rgba, gif.width, gif.height), 0, 0);
      const png = await canvas.encode("png");
      written += png.length;
      if (written > maxBytes) {
        const error = new Error(`This GIF's decoded frames need more than ${maxBytes.toLocaleString("en-US")} bytes of disk space.`);
        error.code = "GIF_TOO_LARGE";
        throw error;
      }
      await writeFile(join(outDir, gifFrameFileName(index)), png, { mode: 0o600 });
    },
  });
  return written;
}

/**
 * Writes every GIF frame as a full-size RGBA PNG (000000.png, 000001.png, ...) into `outDir`.
 * Each PNG is the complete picture at that moment, with transparency and disposal applied.
 * Returns the timeline; the number of PNG files always equals the number of delays.
 * A GIF over the decoding limits throws (code GIF_TOO_LARGE) before any frame is decoded,
 * and one whose PNG files would need more than `maxBytes` throws the same code while decoding.
 */
export async function decodeGifFrames(path, outDir, { signal, maxBytes } = {}) {
  const gif = parseGif(await readFile(path));
  await writeGifFrames(gif, outDir, { signal, maxBytes });
  return { durations: gif.durations };
}

/** Number of grid samples from `firstTime` through `lastTime` (both included) at `fps`. */
export function videoGridCount(firstTime, lastTime, fps) {
  return Math.max(1, Math.ceil((Math.max(firstTime, lastTime) - firstTime) * fps - 1e-6) + 1);
}

// A PNG FFmpeg writes from tagged footage (BT.709, for example) carries cICP, cHRM and gAMA chunks.
// Chromium honors them and resvg does not, so the same video picture drew 8 levels of 255 darker
// whenever any layer of the scene (even one off screen) needed Chromium, and a check compared
// frames drawn by different renderers. The colors are made RGB first, with the footage's own
// matrix, and then the tags are dropped: both renderers draw the decoded values, as the movie keeps them.
export const PICTURE_COLOR_FILTERS = [
  "format=rgb24|rgba|rgb48be|rgba64be",
  "setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown",
];

/**
 * FFmpeg arguments that write `count` PNG pictures of a video, one per 1/fps seconds.
 * Picture k is the latest video frame whose start time is at or before firstTime + k / fps
 * (with 1 ms of tolerance). After the video ends the last frame repeats.
 * `decoderArgs` go before the input, for example ["-c:v", "libvpx-vp9"] for WebM with alpha.
 * `filters` run after sampling, for example a scale filter. `outputArgs` go just before `output`.
 * The pictures carry no color tags (PICTURE_COLOR_FILTERS), so every renderer draws the same pixels.
 */
export function videoGridArgs({ input, output, firstTime, fps, count, decoderArgs = [], filters = [], outputArgs = [] }) {
  const seek = Math.max(0, firstTime - SEEK_MARGIN);
  // Without -copyts the filters see times measured from the seek point.
  const startTime = (firstTime + SAMPLE_TOLERANCE - seek).toFixed(6);
  const graph = [
    // Repeating the last frame lets samples after the end still produce a picture.
    "tpad=stop=-1:stop_mode=clone",
    `fps=fps=${fps}:start_time=${startTime}:round=up`,
    ...filters,
    ...PICTURE_COLOR_FILTERS,
  ].join(",");
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    // Fast seeking starts at the keyframe before `seek`; the fps filter drops the extra frames.
    ...(seek > 0 ? ["-noaccurate_seek", "-ss", seek.toFixed(6)] : []),
    ...decoderArgs,
    "-i", input,
    "-map", "0:v:0",
    "-vf", graph,
    "-frames:v", String(count),
    "-fps_mode", "passthrough",
    ...outputArgs,
    output,
  ];
}
