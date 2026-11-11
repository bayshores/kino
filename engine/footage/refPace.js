// How fast a video should cut by default, from the references it studied. A reference keeps its
// cut times; the mean cuts a second is skewed by one long shot, so the pace is read from the
// median shot (the usual one) and the longest shot (the longest hold). Plain data in, plain data
// out: backend/inspire.mjs measures with it and the planner can import it too.
import { clamp, round } from "../numbers.js";
import { FREE_BEAT, PACES } from "./pace.js";

// Shot lengths in beats a pace may name, and the range of a median shot in seconds without a song.
export const BEAT_STEPS = Object.freeze([1, 2, 4, 8]);
export const SHOT_SECONDS = Object.freeze({ least: 0.4, most: 8 });
// A beat needs this many beat times (two gaps) before a median gap means anything.
const BEATS_LEAST = 3;

/** The middle of a list (the mean of the two middle ones when the count is even); null when empty. */
export function medianOf(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Each shot's length in seconds: the gaps between the start, the cut times and the end. */
export function shotLengths(cuts, seconds) {
  const edges = [0, ...cuts.filter((time) => time > 0 && time < seconds), seconds].sort((a, b) => a - b);
  return edges.slice(1).map((edge, index) => edge - edges[index]);
}

/** One beat in seconds: the median gap between beat times; null with fewer than 3 beats. */
export function beatSecondsOf(beats) {
  const times = (beats ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < BEATS_LEAST) return null;
  return medianOf(times.slice(1).map((time, index) => time - times[index]));
}

/** The nearest of 1, 2, 4, 8 beats, judged by ratio (3 beats is nearer 4 than 2); below 1 is 1, above 8 is 8. */
export function nearestBeats(beats) {
  if (!(beats > 0)) return BEAT_STEPS[0];
  return BEAT_STEPS.reduce((best, step) => (Math.abs(Math.log(beats / step)) < Math.abs(Math.log(beats / best)) ? step : best));
}

/**
 * A measured video's shot statistics from its cut times: the median shot in seconds, and, when its
 * own beat is known (beatSeconds), the median in beats: exact is kept, near is exact rounded to
 * 1, 2, 4 or 8. The longest shot is measured elsewhere (inspire.mjs keeps it with where it is).
 */
export function shotStats(cuts, seconds, beatSeconds = null) {
  const median = medianOf(shotLengths(cuts ?? [], seconds));
  if (median === null) return { median: null, medianBeats: null };
  const exact = beatSeconds > 0 ? median / beatSeconds : null;
  return { median: round(median, 2), medianBeats: exact === null ? null : { exact: round(exact, 2), near: nearestBeats(exact), beatSeconds: round(beatSeconds, 3) } };
}

/**
 * A saved reference's numbers with the median filled in. References measured before it was kept
 * have only cuts; their saved tempo (bpm, from their own sound) still gives the median in beats.
 */
export function numbersWithMedian(numbers, bpm = null) {
  if (!numbers) return null;
  if (numbers.median != null) return numbers;
  return { ...numbers, ...shotStats(numbers.cuts, numbers.seconds, bpm > 0 ? 60 / bpm : null) };
}

const sourced = (value, source, ids = []) => ({ ...value, source, ids });

/**
 * The default pace of a video from the references it studied. refs: [{id, numbers}] (measured
 * ones only count). beatSeconds: one beat of the video's song, or null without a song of known tempo.
 *
 *   shot: {seconds, beats, exact, source, ids}
 *     with refs: the median of their median shots ("ref", the ids). With a song: in beats, from the
 *       references' own beat when kino measured it (else their seconds over the song's beat),
 *       rounded to 1, 2, 4 or 8 and shown in seconds at the song's tempo. Without a song: seconds,
 *       kept between 0.4 and 8 (exact is the value before that); beats is null.
 *     without refs ("today"): 2 beats with a song, else 0.6 s.
 *   hold: {seconds, exact, source, ids}: the longest of their longest shots ("ref"), kept at 8 s
 *     at most (a clip that is one long shot would otherwise hold the whole clip; exact keeps it),
 *     else 5.5 s ("today", also when no reference knows its longest shot).
 *
 * Ignores anything that is not a measured reference with a median above 0 (a zero-length measure
 * says nothing about pace).
 */
export function defaultPace(refs, { beatSeconds = null } = {}) {
  const song = beatSeconds > 0;
  const measured = (Array.isArray(refs) ? refs : []).filter(Boolean)
    .map((ref) => ({ id: ref.id, numbers: numbersWithMedian(ref.numbers, ref.bpm) })).filter((ref) => ref.numbers?.median > 0);
  const longestOf = (ref) => ref.numbers.longest?.seconds > 0 ? ref.numbers.longest.seconds : 0;
  const longest = Math.max(0, ...measured.map(longestOf));
  const hold = longest > 0
    ? sourced({ seconds: Math.min(longest, SHOT_SECONDS.most), exact: longest }, "ref", measured.filter((ref) => longestOf(ref) === longest).map((ref) => ref.id))
    : sourced({ seconds: PACES.promo.hero, exact: PACES.promo.hero }, "today");
  if (!measured.length) {
    return { shot: song ? sourced({ seconds: round(Math.min(PACES.promo.beats * beatSeconds, SHOT_SECONDS.most), 2), beats: PACES.promo.beats, exact: PACES.promo.beats }, "today") : sourced({ seconds: FREE_BEAT, beats: null, exact: FREE_BEAT }, "today"), hold };
  }
  if (!song) {
    const exact = round(medianOf(measured.map((ref) => ref.numbers.median)), 2);
    return { shot: sourced({ seconds: clamp(exact, SHOT_SECONDS.least, SHOT_SECONDS.most), beats: null, exact }, "ref", measured.map((ref) => ref.id)), hold };
  }
  // A reference with its own beat tells the pace in beats; the others only in seconds.
  const withBeat = measured.filter((ref) => ref.numbers.medianBeats);
  const used = withBeat.length ? withBeat : measured;
  const exact = round(withBeat.length ? medianOf(withBeat.map((ref) => ref.numbers.medianBeats.exact)) : medianOf(measured.map((ref) => ref.numbers.median)) / beatSeconds, 2);
  // Beats stay the nearest step, but a very slow song never makes a shot longer than 8 s.
  let beats = nearestBeats(exact);
  while (beats > 1 && beats * beatSeconds > SHOT_SECONDS.most) beats /= 2;
  return { shot: sourced({ seconds: round(Math.min(beats * beatSeconds, SHOT_SECONDS.most), 2), beats, exact }, "ref", used.map((ref) => ref.id)), hold };
}
