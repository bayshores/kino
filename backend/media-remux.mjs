// Turns a QuickTime (.mov) or .m4v upload, such as an iPhone video, into an MP4 that kino plays.
// The picture is copied as it is (no decoding, no new encoding): iPhones record H.264 or HEVC,
// and the desktop app and Chrome on a Mac play both inside an MP4, but not inside a .mov file.
// The sound is copied too when it is AAC or MP3; other sound (such as PCM from a camera) is
// encoded again as AAC, which is small work. Extra tracks (timecode, location, depth data)
// are left out. Any other picture codec (ProRes, for example) is refused with what to do.
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
