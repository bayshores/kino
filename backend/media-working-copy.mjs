// A video or sound file over the upload limit is imported as a smaller working copy that kino
// makes itself (H.264 + AAC in an MP4, or AAC in an M4A), so an agent never re-encodes footage.
// The original file is left as it is. A file too long for any usable copy under the limit is
// refused with what to do.
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMediaTool } from "./media-probe.mjs";

const MB = 1024 * 1024;
// The copy aims under this share of the limit (the container and rate swings take the rest).
const FILL = 0.9;
const SOUND_RATE = 160_000;
// Below these bit rates a copy is too poor to edit with: the file is refused instead.
const LEAST_VIDEO_RATE = 600_000;
const LEAST_SOUND_RATE = 64_000;

const megabytes = (bytes) => `${bytes >= 10 * MB ? Math.round(bytes / MB) : Number((bytes / MB).toFixed(1))} MB`;

async function probe(file, signal) {
  const output = await runMediaTool("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type:stream_disposition=attached_pic", "-of", "json", file], { signal });
  const parsed = JSON.parse(output || "{}");
  const streams = parsed.streams ?? [];
  return {
    duration: Number(parsed.format?.duration) || 0,
    video: streams.some((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic),
    audio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/**
 * Makes the working copy of `file` ({actualPath, mime, size, name}). Resolves with
 * {path, mime, size, note, cleanup}; rejects with a message when no usable copy fits `maxBytes`.
 */
export async function makeWorkingCopy(file, { maxBytes, signal } = {}) {
  const kind = String(file.mime).split("/")[0];
  const over = `${file.name} is ${megabytes(file.size)}, over kino's ${megabytes(maxBytes)} upload limit`;
  if (kind !== "video" && kind !== "audio") throw new Error(`${over}. Make it smaller first (kino makes copies of video and sound only).`);
  let facts;
  try { facts = await probe(file.actualPath, signal); } catch { throw new Error(`${over}, and kino could not read it as ${kind} to make a smaller copy.`); }
  if (!(facts.duration > 0)) throw new Error(`${over}, and kino could not measure its length to make a smaller copy.`);
  const budget = (maxBytes * FILL * 8) / facts.duration;
  const video = kind === "video" && facts.video;
  const soundRate = Math.min(video ? SOUND_RATE : 256_000, budget);
  const videoRate = video ? Math.floor(budget - (facts.audio ? SOUND_RATE : 0)) : 0;
  if (video ? videoRate < LEAST_VIDEO_RATE : soundRate < LEAST_SOUND_RATE)
    throw new Error(`${over}, and at ${Math.round(facts.duration)} s it is too long for a usable copy under it. Import a shorter part of it.`);
  const folder = await mkdtemp(path.join(os.tmpdir(), "kino-working-copy-"));
  const cleanup = () => rm(folder, { recursive: true, force: true });
  const output = path.join(folder, video ? "copy.mp4" : "copy.m4a");
  // H.264 at a constant quality, capped at the rate that keeps the copy under the limit.
  const args = video
    ? ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-maxrate", String(videoRate), "-bufsize", String(videoRate * 2),
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", String(SOUND_RATE), "-movflags", "+faststart", "-f", "mp4"]
    : ["-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", String(Math.floor(soundRate)), "-movflags", "+faststart", "-f", "ipod"];
  try {
    await runMediaTool("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", file.actualPath, "-map_metadata", "0", ...args, output], { signal });
    const size = (await stat(output)).size;
    if (size > maxBytes) throw new Error(`${over}, and kino's smaller copy is still ${megabytes(size)}. Import a shorter part of it.`);
    const what = video ? "H.264" : "AAC";
    return {
      path: output, mime: video ? "video/mp4" : "audio/mp4", size, cleanup,
      note: `${over}, so kino imported its own working copy (${what}, ${megabytes(size)}); the original is unchanged. Do not re-encode it.`,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
