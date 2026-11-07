// The volume track of a sound clip whose layer has Volume animations. The export samples the
// layer's volume (engine/animation.js volumeAt, the evaluator the preview uses too) 1000 times a
// second over the clip and writes the samples as raw 32-bit floats. FFmpeg reads that file as one
// more sound input, resamples it to the clip's sample rate (which draws a smooth curve through the
// samples) and multiplies the clip by it (export.mjs audioMixGraph).
import { writeFile } from "node:fs/promises";
import { volumeAt } from "../engine/animation.js";

// Samples per second. One every millisecond is smooth for fades and ducks; the resampler fills in
// the samples between.
export const VOLUME_TRACK_RATE = 1000;
// The track runs this much longer than the clip so it never ends first: FFmpeg's amultiply stops
// when either input stops.
const TAIL_SECONDS = 0.05;

/**
 * Samples `layer`'s volume for a clip that starts at scene time `start` and plays for `length`
 * seconds, writes them to `path` (f32le, mono, VOLUME_TRACK_RATE per second) and returns
 * { path, samples, peak }: the samples as a Float32Array and the loudest of them.
 */
export async function writeVolumeTrack(path, layer, start, length) {
  const count = Math.ceil((length + TAIL_SECONDS) * VOLUME_TRACK_RATE) + 1;
  const samples = new Float32Array(count);
  const bytes = Buffer.alloc(count * 4);
  let peak = 0;
  for (let index = 0; index < count; index += 1) {
    const volume = volumeAt(layer, start + index / VOLUME_TRACK_RATE);
    samples[index] = volume;
    bytes.writeFloatLE(volume, index * 4);
    peak = Math.max(peak, volume);
  }
  await writeFile(path, bytes);
  return { path, samples, peak };
}

/** The clip's volume at scene `time`, read from its track and rounded for messages. */
export function trackVolumeAt(clip, time) {
  const { samples } = clip.volumeTrack;
  const index = Math.round((time - clip.start) * VOLUME_TRACK_RATE);
  return Math.round(samples[Math.max(0, Math.min(samples.length - 1, index))] * 100) / 100;
}

/** FFmpeg arguments that read a volume track as a sound input. */
export function volumeTrackInput(track) {
  return ["-f", "f32le", "-ar", String(VOLUME_TRACK_RATE), "-ac", "1", "-i", track.path];
}
