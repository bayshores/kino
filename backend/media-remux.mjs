// Turns a QuickTime (.mov) or .m4v upload, such as an iPhone video, into an MP4 that kino plays.
// The picture is copied as it is (no decoding, no new encoding): iPhones record H.264 or HEVC,
// and the desktop app and Chrome on a Mac play both inside an MP4, but not inside a .mov file.
// The sound is copied too when it is AAC or MP3; other sound (such as PCM from a camera) is
// encoded again as AAC, which is small work. Extra tracks (timecode, location, depth data)
// are left out. A .mov with an alpha channel (ProRes 4444) is converted to the transparent VP9
// WebM kino plays. Any other picture codec (ProRes without alpha, for example) is refused with what to do.
import { runMediaTool } from "./media-probe.mjs";

/** MIME types that are made into MP4 on upload. */
export const REMUX_MIMES = new Set(["video/quicktime", "video/x-m4v"]);

// Picture codecs copied as they are, with the MP4 tag the players expect: Safari and Chrome on
// a Mac play HEVC only when it is tagged hvc1 (iPhones already write hvc1; others may not).
const COPY_TAGS = { h264: "avc1", hevc: "hvc1" };
const COPY_SOUND = new Set(["aac", "mp3"]);

function refusal(message) {
  const error = new Error(message);
  error.status = 415;
  return error;
}

/** The codec names of the first picture and the first sound in a file: { video, audio }. */
export async function probeCodecs(filename, { signal } = {}) {
  const output = await runMediaTool("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_disposition=attached_pic", "-of", "json", filename,
  ], { signal });
  const streams = JSON.parse(output || "{}").streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return { video: video?.codec_name ?? null, audio: audio?.codec_name ?? null };
}

// Picture formats that carry a transparency channel (ProRes 4444 is yuva444p10le or similar).
const ALPHA_PIXEL_FORMAT = /^(?:yuva|ya\d|argb|abgr|rgba|bgra|gbra|ayuv)/;

/** The first picture's { codec, alpha, width, height, frames } (frames is null when the file does not say). */
export async function probePicture(filename, { signal } = {}) {
  const output = await runMediaTool("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_frames:stream_disposition=attached_pic", "-of", "json", filename,
  ], { signal });
  const stream = (JSON.parse(output || "{}").streams ?? [])[0];
  if (!stream || stream.disposition?.attached_pic) return null;
  const frames = Number.parseInt(stream.nb_frames, 10);
  return { codec: stream.codec_name, alpha: ALPHA_PIXEL_FORMAT.test(String(stream.pix_fmt ?? "")), width: stream.width, height: stream.height, frames: frames > 0 ? frames : null };
}

/**
 * Writes `input` (a .mov with an alpha channel, such as ProRes 4444) to `output` as a transparent
 * VP9 WebM, the transparent video kino already plays. Sound becomes Opus. Resolves with
 * { width, height, frames } and the line the import answer shows.
 */
export async function alphaToWebm(input, output, picture, { signal } = {}) {
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-v", "error", "-y", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0",
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "18", "-b:v", "0",
    "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
    "-c:a", "libopus", "-b:a", "192k", "-f", "webm", output,
  ], { signal });
  let frames = picture.frames;
  if (!frames) {
    const counted = await runMediaTool("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", output], { signal });
    frames = Number.parseInt(String(counted).trim(), 10) || 0;
  }
  return { width: picture.width, height: picture.height, frames, line: `converted to transparent webm: ${picture.width} x ${picture.height}, ${frames} frames` };
}

/**
 * Writes `input` (a .mov or .m4v) to `output` as an MP4 with the same picture.
 * Resolves with { video, audio, copiedSound }; rejects with status 415 when the picture cannot
 * be copied into an MP4 that plays.
 */
export async function remuxToMp4(input, output, { signal } = {}) {
  let codecs;
  try { codecs = await probeCodecs(input, { signal }); }
  catch { throw refusal("This file could not be read as a video. Check that it is a whole .mov or .m4v file."); }
  if (!codecs.video) throw refusal("This file has no video picture. Import sound as .m4a, .mp3 or .wav.");
  const tag = COPY_TAGS[codecs.video];
  if (!tag)
    throw refusal(`This video's picture is ${codecs.video}, which kino cannot play without encoding it again. ` +
      `kino copies H.264 and HEVC (what iPhones record). Convert it first, for example: ` +
      `ffmpeg -i in.mov -c:v libx264 -crf 18 -c:a aac out.mp4, then import out.mp4.`);
  const copiedSound = !codecs.audio || COPY_SOUND.has(codecs.audio);
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-v", "error", "-y", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0",
    "-c:v", "copy", "-tag:v", tag,
    ...(copiedSound ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]),
    "-movflags", "+faststart", "-f", "mp4", output,
  ], { signal });
  return { ...codecs, copiedSound };
}
