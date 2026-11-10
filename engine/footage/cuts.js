// Where compose {footage} cuts: on word edges for speech, on the music's beats for everything
// else. Plain math on numbers, so it is easy to test.
//
// Beats: every beat time comes from its index (first + index × period), never from adding a
// rounded beat length again and again, which drifts (2 frames in 32 beats at 128 BPM and 30 fps).
import { round as round3 } from "../numbers.js";

/**
 * The beat grid of a song from its analysed beats (backend/audio-analysis.mjs): {first, period,
 * bpm, bar} in file seconds. The period is the least-squares slope through all beats, so one
 * late beat does not move the grid. `bar` (0 to 3) is the index of the first downbeat: the beat
 * position in the bar where the onsets are strongest. Null when there is no steady beat.
 */
export function beatGrid(analysis) {
  const beats = analysis?.beats ?? [];
  if (beats.length < 4 || !(analysis.period > 0)) return null;
  const count = beats.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  beats.forEach((time, index) => { sumX += index; sumY += time; sumXY += index * time; sumXX += index * index; });
  const period = (count * sumXY - sumX * sumY) / (count * sumXX - sumX * sumX);
  const first = (sumY - period * sumX) / count;
  // The strongest of the four beat positions is the downbeat.
  const strength = [0, 0, 0, 0];
  for (const onset of analysis.onsets ?? []) {
    const index = Math.round((onset.time - first) / period);
    if (index < 0 || Math.abs(first + index * period - onset.time) > 0.07) continue;
    strength[index % 4] += onset.low ?? onset.strength ?? 1;
  }
  const bar = strength.indexOf(Math.max(...strength));
  return { first, period, bpm: Math.round((60 / period) * 100) / 100, bar };
}

/** The file time of beat `index` of the grid. */
export const beatAt = (grid, index) => grid.first + index * grid.period;

/** The index of the beat nearest to file time `time` (or the next one with `up`). */
export function beatIndex(grid, time, { up = false } = {}) {
  const exact = (time - grid.first) / grid.period;
  return up ? Math.ceil(exact - 1e-6) : Math.round(exact);
}

/** The file time of the downbeat (first beat of a bar) at or after `time`. */
export function barAtOrAfter(grid, time) {
  let index = beatIndex(grid, time, { up: true });
  while (((index - grid.bar) % 4 + 4) % 4 !== 0) index += 1;
  return beatAt(grid, index);
}

/**
 * The music laid under an edit: the song plays from file time `offset` at edit time `start`.
 * Edit-time beats: {at(index), next(time), nearest(time)}, all from beat indexes.
 */
export function editBeats(grid, { offset, start = 0 }) {
  const toEdit = (fileTime) => fileTime - offset + start;
  const toFile = (editTime) => editTime - start + offset;
  return {
    at: (index) => round3(toEdit(beatAt(grid, index))),
    index: (editTime, options) => beatIndex(grid, toFile(editTime), options),
    /** The first beat at or after edit time `time`. */
    next: (time) => round3(toEdit(beatAt(grid, beatIndex(grid, toFile(time), { up: true })))),
    /** The beat nearest edit time `time`. */
    nearest: (time) => round3(toEdit(beatAt(grid, beatIndex(grid, toFile(time))))),
    /** True when the beat index starts a bar. */
    isDownbeat: (index) => ((index - grid.bar) % 4 + 4) % 4 === 0,
    period: grid.period,
  };
}

// ---- cuts on footage impacts ------------------------------------------------------------------

// An impact this sure (footage/events.mjs confidence) may move a cut; the picture's impact may come
// this many frames before the hit, never after; the outgoing shot's in-point moves at most SLIDE s.
export const IMPACT_LEAST = 0.5;
const EARLY_FRAMES = 2;
const SLIDE = 1;

/**
 * Where a cut inside a section moves so the outgoing shot's impact lands on a song hit: cut on the
 * action in the shot, not on every hit. The impact frame shows on the hit (the shot's in-point
 * slides later by up to SLIDE s to put it there; when its moment cannot slide that far, the impact
 * may come up to 2 output frames early, never late), and the cut follows right after the impact: a
 * contact drawing held for its `hold` clip frames, or a 1 to 4 frame impact frame in full, counted
 * in the clip's own measured frames.
 *   cut       the planned cut (edit s); start, in: the outgoing shot's start (edit s) and in-point (file s)
 *   roomEnd   the file time the outgoing shot may play to (its clip's end or its next source cut)
 *   impacts   its clip's impacts [{t (file s), how, frames (clip frames), confidence}]
 *   hits      strong song hits [{at (edit s), strength}]
 *   low, high the cut's bounds (edit s); reach: how far it may move
 *   frame     one output frame (s): how early the picture may come is counted in these
 *   clipFrame one frame of the clip at its measured rate (s); hold: clip frames per drawing (1, 2, 3)
 *   carry     (newIn, at) => 1 when the motion carries across that cut, else 0: it only breaks ties
 * Returns {at, in, impact, hit, early} (early in output frames), or null when no sure impact fits.
 */
export function snapToImpact({ cut, start, in: inPoint, roomEnd, impacts = [], hits = [], low, high, reach, frame = 1 / 30, clipFrame = frame, hold = 1, carry = () => 0 }) {
  let best = null;
  for (const impact of impacts) {
    if (impact?.kind !== undefined && impact.kind !== "impact") continue;
    if (!(impact.confidence >= IMPACT_LEAST) || !Number.isFinite(impact.t)) continue;
    const frames = impact.how === "frame" ? Math.max(1, Math.min(4, impact.frames ?? 1)) : Math.max(1, Math.round(hold));
    for (const hit of hits) {
      const at = round3(hit.at + frames * clipFrame);
      if (at < low - 1e-6 || at > high + 1e-6 || Math.abs(at - cut) > reach + 1e-6) continue;
      // The in-point that shows the impact frame on the hit, kept within the moment (no earlier
      // than its in-point, at most SLIDE later): held back, the impact comes early.
      const wanted = impact.t - (hit.at - start);
      const newIn = round3(Math.min(Math.max(wanted, inPoint), inPoint + SLIDE));
      const early = round3((newIn - wanted) / frame);
      if (early < -1e-3 || early > EARLY_FRAMES + 1e-3) continue;
      if (newIn + (at - start) > roomEnd + 1e-6) continue;
      const score = Math.round(impact.confidence * (hit.strength ?? 1) * 20) / 20;
      const candidate = { at, in: newIn, impact: impact.t, hit: round3(hit.at), early: Math.max(0, Math.round(early * 10) / 10), score, carry: carry(newIn, at), move: Math.abs(at - cut) };
      if (!best || candidate.score > best.score || (candidate.score === best.score && (candidate.carry > best.carry || (candidate.carry === best.carry && candidate.move < best.move - 1e-6)))) best = candidate;
    }
  }
  if (!best) return null;
  const { at, in: newIn, impact, hit, early } = best;
  return { at, in: newIn, impact, hit, early };
}

// ---- words ---------------------------------------------------------------------------------

const END = /[.?!…]["”')\]]*$/;
const FILLERS = new Set(["um", "uh", "erm", "hmm", "mm", "ah", "er"]);
export const isFiller = (text) => FILLERS.has(String(text).toLowerCase().replace(/[^a-z]/g, ""));

/**
 * The sentences of a transcript's words ([{text, start, end}], unclear ones left out): a sentence
 * ends at . ? ! or … or at a pause of `gap` seconds. [{start, end, words, text, complete}].
 * complete: it ends with punctuation or a long pause, so it reads as a whole thought.
 */
export function sentences(words, { gap = 0.7 } = {}) {
  const list = (words ?? []).filter((word) => !word.unclear && String(word.text).trim());
  const found = [];
  let open = null;
  list.forEach((word, index) => {
    open ??= { start: word.start, end: word.end, words: [] };
    open.words.push(word);
    open.end = word.end;
    const next = list[index + 1];
    const pause = next ? next.start - word.end : Infinity;
    if (!next || END.test(word.text) || pause >= gap) {
      const text = open.words.map((entry) => entry.text).join(" ").replace(/\s+([,.?!…])/g, "$1").trim();
      found.push({ ...open, text, complete: END.test(word.text) || pause >= 1.2, pauseAfter: pause, pauseBefore: found.length ? open.start - found.at(-1).end : open.start });
      open = null;
    }
  });
  return found;
}

/**
 * The file seconds to play for a run of words: from just before the first word to just after the
 * last, padded 30 to 200 ms into the silence around them (never into a neighbor word, and at a
 * quiet point when the transcript names one: its `cut`). `all` is the whole word list.
 */
export function speechSpan(first, last, all, { before = 0.12, after = 0.16 } = {}) {
  const index = all.indexOf(first);
  const lastIndex = all.indexOf(last);
  const previous = index > 0 ? all[index - 1] : null;
  const next = lastIndex >= 0 && lastIndex < all.length - 1 ? all[lastIndex + 1] : null;
  const roomBefore = previous ? first.start - previous.end : before;
  const roomAfter = next ? next.start - last.end : after;
  // Half the gap at most, so the next word's first sound is never heard; at least 30 ms.
  let start = first.start - Math.max(0.03, Math.min(before, roomBefore / 2, 0.2));
  if (Number.isFinite(first.cut) && first.cut < first.start && first.cut >= first.start - 0.2 && (!previous || first.cut >= previous.end)) start = Math.min(start, first.cut);
  const end = last.end + Math.max(0.03, Math.min(after, roomAfter / 2, 0.2));
  return { in: round3(Math.max(0, start)), out: round3(end) };
}
