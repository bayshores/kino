// How loud a sound file is around a time, from the waveform peaks kino already keeps beside each
// file (backend/audio-peaks.mjs: 100 peaks a second, scaled to the file's loudest). speech_cut uses
// it to tell a cut in a pause from a cut inside the voice, since transcript word times run early.
//
// The short-term level is the root mean square of the peaks over 50 ms, in dB. The file's quiet
// level is its 10th percentile (never under -60 dB, so digital silence does not make every breath
// "loud"). A stretch is loud when its median level is LOUD_OVER dB over the quiet level.

// dB over the file's quiet level that counts as sound (a voice, not room tone).
export const LOUD_OVER = 12;
// How much of the audio next to a cut is judged (seconds inside the cut).
export const EDGE_WINDOW = 0.12;
// A pause: this long, under PAUSE_OVER dB over the quiet level.
export const PAUSE_MIN = 0.15;
const PAUSE_OVER = 6;
const SHORT_TERM = 0.05;
const FLOOR_MIN = -60;

const memo = new WeakMap();

/**
 * The levels of a peaks record ({available, duration, secondsPerPeak, peaks}), or null without
 * one: {levels (dB per peak), step, duration, floor, loud, quiet}. Kept per record.
 */
export function soundLevels(data) {
  if (!data?.available || !Array.isArray(data.peaks) || !data.peaks.length || !(data.secondsPerPeak > 0)) return null;
  if (memo.has(data)) return memo.get(data);
  const { peaks, secondsPerPeak: step } = data;
  const half = Math.max(0, Math.round(SHORT_TERM / step / 2));
  const levels = new Float32Array(peaks.length);
  for (let index = 0; index < peaks.length; index += 1) {
    let sum = 0, count = 0;
    for (let at = Math.max(0, index - half); at <= Math.min(peaks.length - 1, index + half); at += 1) { sum += peaks[at] * peaks[at]; count += 1; }
    levels[index] = 10 * Math.log10(Math.max(1e-10, sum / count));
  }
  const sorted = Float32Array.from(levels).sort();
  const floor = Math.max(FLOOR_MIN, sorted[Math.floor(sorted.length * 0.1)]);
  const result = { levels, step, duration: data.duration > 0 ? data.duration : peaks.length * step, floor, loud: floor + LOUD_OVER, quiet: floor + PAUSE_OVER };
  memo.set(data, result);
  return result;
}

const indexAt = (sound, time) => Math.max(0, Math.min(sound.levels.length - 1, Math.floor(time / sound.step)));

/** The median level (dB) from `from` to `to` seconds in the file. */
export function levelBetween(sound, from, to) {
  const start = indexAt(sound, Math.max(0, from)), end = Math.max(start, indexAt(sound, Math.max(from, to) - 1e-6));
  const values = Array.from(sound.levels.subarray(start, end + 1)).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

/** The loudest short-term level (dB) from `from` to `to` seconds in the file. */
export function peakBetween(sound, from, to) {
  const start = indexAt(sound, Math.max(0, from)), end = Math.max(start, indexAt(sound, Math.max(from, to) - 1e-6));
  return Math.max(...sound.levels.subarray(start, end + 1));
}

// Under this level (dB under the file's loudest peak) all through, a stretch is silence: a word
// a transcript places there was not said (Whisper hears "um" over the silence of a TTS track).
export const SILENT_UNDER = -40;

/**
 * Whether a cut at `time` (seconds in the file) is inside sound. `side` is "out" (the clip ends
 * there: the audio just before is judged) or "in" (it starts there: the audio just after).
 * Answers {loud, over} with over in dB over the file's quiet level.
 */
export function loudAtCut(sound, time, side) {
  const level = side === "out" ? levelBetween(sound, time - EDGE_WINDOW, time) : levelBetween(sound, time, time + EDGE_WINDOW);
  return { loud: level >= sound.loud, over: Math.round(level - sound.floor) };
}

/** The nearest pause ({start, end} in file seconds) wholly before `time`, or after it, or null. */
export function pauseNear(sound, time, direction) {
  const minRun = Math.max(1, Math.round(PAUSE_MIN / sound.step));
  const quiet = (index) => sound.levels[index] < sound.quiet;
  const last = sound.levels.length - 1;
  if (direction === "before") {
    let run = 0;
    for (let index = Math.min(last, indexAt(sound, time)); index >= 0; index -= 1) {
      if (quiet(index)) { run += 1; continue; }
      if (run >= minRun) return { start: (index + 1) * sound.step, end: (index + 1 + run) * sound.step };
      run = 0;
    }
    return run >= minRun ? { start: 0, end: run * sound.step } : null;
  }
  let run = 0;
  for (let index = indexAt(sound, time); index <= last; index += 1) {
    if (quiet(index)) { run += 1; continue; }
    if (run >= minRun) return { start: (index - run) * sound.step, end: index * sound.step };
    run = 0;
  }
  return run >= minRun ? { start: (last + 1 - run) * sound.step, end: sound.duration } : null;
}
