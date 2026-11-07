// av_offset: after a final render, are the sound and the picture in step? It compares where
// the audio and video streams start in the file (ffprobe). ITU-R BT.1359 puts the limits of
// what viewers notice at sound 45 ms early or 125 ms late.
import { runExportProcess } from "../export-process.mjs";

const EARLY_MS = 45;
const LATE_MS = 125;

const ffprobe = () => process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

/** Start times (seconds) of the first video and audio streams, or null for a missing stream. */
export async function streamStarts(file, { signal } = {}) {
  const output = await runExportProcess(ffprobe(), ["-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", file], signal);
  const streams = JSON.parse(output).streams ?? [];
  const start = (type) => {
    const stream = streams.find((entry) => entry.codec_type === type);
    if (!stream) return null;
    const value = Number(stream.start_time);
    return Number.isFinite(value) ? value : 0;
  };
  return { video: start("video"), audio: start("audio") };
}

/** Judges an offset in milliseconds (positive: the sound starts after the picture). */
export function judgeOffset(offsetMs) {
  const rounded = Math.round(offsetMs);
  const ok = offsetMs >= -EARLY_MS && offsetMs <= LATE_MS;
  const where = rounded === 0 ? "in step" : rounded < 0 ? `${-rounded} ms early` : `${rounded} ms late`;
  return {
    severity: ok ? "ok" : "error", rule: "av_offset", measured: rounded, required: `-${EARLY_MS} to +${LATE_MS} ms`,
    message: ok ? `sound ${where}` : `the sound is ${where}; viewers notice more than ${EARLY_MS} ms early or ${LATE_MS} ms late (ITU-R BT.1359).`,
    ...(ok ? {} : { fix: "Check the audio layer's start and the video layers' sound, render again, and report it if the offset stays." }),
  };
}

/** The av_offset finding for a rendered file, or null when it has no sound. */
export async function avOffsetFinding(file, options) {
  const starts = await streamStarts(file, options);
  if (starts.audio === null || starts.video === null) return null;
  return judgeOffset((starts.audio - starts.video) * 1000);
}
