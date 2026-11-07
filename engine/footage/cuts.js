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
