// A song's bar lines, taken from the beat analysis's measured beat times.
//
// A song is not a perfect grid: the beat analysis (engine/beatDetection.js) places each beat on the
// song locally, so a tempo that drifts a few milliseconds a bar is followed. barLines keeps that:
// every 4th measured beat, counted from the downbeat, is a bar line. Past the first and last
// measured beat the local bar length carries the lines on, so every moment of the song is in a bar.
//
// downbeatPhase is the one place that decides which beat of 4 starts the bar. barGrid (fitMusic.js,
// the constant grid that planFitMusic snaps to) and barLines both use it, so they never disagree.

const BEATS_PER_BAR = 4;
const ONSET_REACH = 0.035; // an onset this close to a beat is on it (seconds)
const ONSET_SHARE = 0.5; // how much the heavy low onsets count next to the drop votes

const median = (list) => {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round3 = (value) => Math.round(value * 1000) / 1000;
const round4 = (value) => Math.round(value * 10_000) / 10_000;
const gaps = (times) => times.slice(1).map((time, index) => time - times[index]);

/** The index of the beat nearest `time`. */
function nearestIndex(times, time) {
  let best = 0;
  for (let i = 1; i < times.length; i += 1) if (Math.abs(times[i] - time) < Math.abs(times[best] - time)) best = i;
  return best;
}

/**
 * Which beat of 4 starts the bar: 0 to 3, the beat index modulo 4 of the downbeat. Two votes:
 * - every drop edge (sections of kind "drop", each counted by its weight) votes for the beat
 *   nearest it: a drop starts on a bar line. One drop that sits off its bar line is outvoted by
 *   the others;
 * - the heavy low onsets (beat analysis version 7 onsets with a weight) vote for the beat of 4
 *   that has the most kick on it, counted at half a drop's strength, so they decide when the
 *   drops split evenly and carry a song that has no drop.
 * Returns 0 when there is nothing to vote with.
 */
export function downbeatPhase(analysis, sections = []) {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats : [];
  if (beats.length < BEATS_PER_BAR) return 0;
  const drops = new Array(BEATS_PER_BAR).fill(0);
  for (const part of sections) {
    if (part?.kind !== "drop" || !Number.isFinite(part.at)) continue;
    drops[nearestIndex(beats, part.at) % BEATS_PER_BAR] += Math.max(0.1, Number.isFinite(part.weight) ? part.weight : 0.5);
  }
  const onsets = (Array.isArray(analysis?.onsets) ? analysis.onsets : []).filter((onset) => typeof onset.weight === "number");
  const kicks = new Array(BEATS_PER_BAR).fill(0);
  let cursor = 0;
  beats.forEach((time, index) => {
    while (cursor < onsets.length && onsets[cursor].time < time - ONSET_REACH) cursor += 1;
    for (let at = cursor; at < onsets.length && onsets[at].time <= time + ONSET_REACH; at += 1) kicks[index % BEATS_PER_BAR] += onsets[at].weight * (onsets[at].low ?? 0);
  });
  const share = (list) => { const total = list.reduce((sum, value) => sum + value, 0); return list.map((value) => (total > 0 ? value / total : 0)); };
  const [dropShare, kickShare] = [share(drops), share(kicks)];
  const score = dropShare.map((value, phase) => value + ONSET_SHARE * kickShare[phase]);
  const best = Math.max(...score);
  return best > 0 ? score.indexOf(best) : 0;
}

/**
 * The bar lines of a beat analysis {beats, period?, bpm?, duration}: {lines, bar, beat, downbeat}.
 * lines: every bar line's time in seconds (3 decimals), every 4th measured beat counted from the
 * downbeat, carried backward until a line is within half a beat of time 0 and forward to the last
 * bar that starts inside the song (before analysis.duration). bar and beat are the median lengths; downbeat is the time of
 * the first line the measured beats give. `sections` (the song's sections) help choose the
 * downbeat (see downbeatPhase). Returns null without a measured beat.
 */
export function barLines(analysis, sections = []) {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats.filter(Number.isFinite) : [];
  if (beats.length < BEATS_PER_BAR) return null;
  const phase = downbeatPhase(analysis, sections);
  const measured = beats.filter((_, index) => index % BEATS_PER_BAR === phase);
  const beat = median(gaps(beats));
  if (!(beat > 0)) return null;
  const barLength = (list) => median(gaps(list)) || beat * BEATS_PER_BAR;
  const lines = [...measured];
  // Backward: the first measured bars' own length, until a line is within half a beat of 0.
  const before = barLength(measured.slice(0, 8));
  while (lines[0] > beat / 2) lines.unshift(lines[0] - before);
  // Forward: the last measured bars' length, up to the last bar that starts inside the song.
  const after = barLength(measured.slice(-8));
  const duration = Number.isFinite(analysis.duration) ? analysis.duration : beats.at(-1);
  while (lines.at(-1) + after < duration) lines.push(lines.at(-1) + after);
  return { lines: lines.map(round3), bar: round4(median(gaps(lines))), beat: round4(beat), downbeat: round3(measured[0]) };
}

/** The index of the bar line nearest `time`. */
export function barIndexAt(lines, time) {
  let best = 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (Math.abs(lines[i] - time) < Math.abs(lines[best] - time)) best = i;
    else if (lines[i] > time) break;
  }
  return best;
}

/** The index of the bar that contains `time`: the last line at or before it (the first bar before the first line). */
export function barOf(lines, time) {
  let index = 0;
  for (let i = 1; i < lines.length && lines[i] <= time; i += 1) index = i;
  return index;
}
