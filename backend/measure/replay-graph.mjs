// A reference's public "most replayed" graph: kept with the reference, read as humps, and lined
// up with what kino measured at those seconds. Facts only: nothing here feeds a check, a score,
// a default or a rule.
//   readReplay(heatmap)       yt-dlp's heatmap → {seconds, values} (100 numbers, 0 to 1), or null
//   replayHumps(replay)       the top 1 to 3 humps (and one at the start, apart) against the median
//   replayLines(ref)          the at most 2 lines the reference's printed text carries
//   replayStudy(refs, opts)   hand-run (scripts/replay-study.mjs): measures at humps vs random times
// No graph on a video (most videos have none) means nothing is stored and nothing is printed.

/** The fewest and most parts a graph may have (the page sends 100). */
const MIN_PARTS = 20;
const MAX_PARTS = 200;
/** A hump must stand this far above the graph's median to be named. A starting guess, printed. */
export const HUMP_RISE = 0.1;
/** At most this many humps are named (the start's, if any, comes apart from them). */
export const MAX_HUMPS = 3;

const round = (value, places) => Number(value.toFixed(places));

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Graph parts no lower than either neighbor and higher than one (a flat stretch has no peak), the
 * highest first. Shared with the footage finder's heatmapPeaks. A part is {value, ...anything}.
 */
export function peakParts(parts) {
  return parts
    .filter((part, index) => {
      const before = parts[index - 1]?.value ?? part.value;
      const after = parts[index + 1]?.value ?? part.value;
      return part.value >= before && part.value >= after && (part.value > before || part.value > after);
    })
    .sort((a, b) => b.value - a.value);
}

/**
 * yt-dlp's heatmap ([{start_time, end_time, value}], what a lookup of the video's page carries) as
 * {seconds: how long the graph spans, values: one 0..1 number a part, 3 decimals}. null when the
 * video has none, or it is not a graph of 20 to 200 parts from second 0 with values from 0 to 1.
 */
export function readReplay(heatmap) {
  if (!Array.isArray(heatmap) || heatmap.length < MIN_PARTS || heatmap.length > MAX_PARTS) return null;
  const values = [];
  for (const part of heatmap) {
    const value = Number(part?.value);
    if (!(value >= 0 && value <= 1) || !(Number(part?.end_time) > Number(part?.start_time))) return null;
    values.push(round(value, 3));
  }
  const seconds = Number(heatmap.at(-1).end_time);
  if (!(seconds > 0) || Number(heatmap[0].start_time) !== 0) return null;
  return { seconds: round(seconds, 2), values };
}

/** A saved graph that can still be read (a hand-edited or old record never breaks a read). */
const usable = (replay) => replay && replay.seconds > 0 && Array.isArray(replay.values) && replay.values.length >= MIN_PARTS && replay.values.every((value) => value >= 0 && value <= 1);

/**
 * The humps of a graph: {width (seconds a part spans), median, humps: [{start, end, top, at}],
 * opening: a hump that begins at second 0 (most videos start high), or null}. A hump is the stretch
 * around a peak that stays at least halfway from the graph's median up to the peak; it is named
 * when its top stands HUMP_RISE above the median. The highest MAX_HUMPS that do not overlap come
 * first; times are the graph's own seconds. null for no usable graph.
 */
export function replayHumps(replay) {
  if (!usable(replay)) return null;
  const count = replay.values.length;
  const width = replay.seconds / count;
  const mid = median(replay.values);
  const parts = replay.values.map((value, index) => ({ index, value }));
  const taken = [];
  for (const peak of peakParts(parts)) {
    if (peak.value - mid < HUMP_RISE) break;
    const edge = mid + (peak.value - mid) / 2;
    let from = peak.index;
    let to = peak.index;
    while (from > 0 && replay.values[from - 1] >= edge) from -= 1;
    while (to < count - 1 && replay.values[to + 1] >= edge) to += 1;
    if (taken.some((hump) => from <= hump.to && to >= hump.from)) continue;
    taken.push({ from, to, top: peak.value, at: peak.index });
  }
  const view = (hump) => ({ start: round(hump.from * width, 2), end: round((hump.to + 1) * width, 2), top: hump.top, at: round((hump.at + 0.5) * width, 2) });
  const opening = taken.find((hump) => hump.from === 0);
  const humps = taken.filter((hump) => hump !== opening).slice(0, MAX_HUMPS).sort((a, b) => a.from - b.from);
  return { width: round(width, 2), median: round(mid, 3), humps: humps.map(view), opening: opening ? view(opening) : null };
}

// ---- what kino measured at a hump -----------------------------------------------------------------

const shotsIn = (numbers, from, to) => {
  const edges = [0, ...(numbers.cuts ?? []), numbers.seconds];
  const lengths = [];
  for (let index = 0; index + 1 < edges.length; index += 1) {
    if (edges[index] < to && edges[index + 1] > from) lengths.push(edges[index + 1] - edges[index]);
  }
  return lengths;
};

/** The facts kino holds for the stretch [from, to] of a measured reference, as words ("" for none). */
function measuredThere(ref, from, to) {
  const numbers = ref.numbers;
  if (!numbers?.seconds || to > numbers.seconds) return "";
  const parts = [];
  const lengths = shotsIn(numbers, from, to);
  if (lengths.length) parts.push(`${lengths.length} shot${lengths.length === 1 ? "" : "s"}, median ${round(median(lengths), 2)} s`);
  const change = ref.heard?.change;
  if (change && change.at >= from && change.at <= to) parts.push(`the song's loudest change (${change.kind ?? "change"}) at ${round(change.at, 1)} s`);
  const said = (ref.heard?.lines ?? []).find((line) => line.at >= from && line.at <= to);
  if (said) parts.push(`a heard line "${String(said.text ?? "").slice(0, 40)}" at ${round(said.at, 1)} s`);
  return parts.join(", ");
}

const span = (hump) => `${round(hump.start, 1)}-${round(hump.end, 1)} s`;

/**
 * The lines a reference's printed text carries for its graph: [] without a graph; otherwise the
 * humps in seconds (each with what kino measured there, when the hump lies inside the measured
 * stretch), then a fixed caveat. ref: a reference summary {replay, duration, numbers, heard}.
 */
export function replayLines(ref) {
  const found = replayHumps(ref?.replay);
  if (!found) return [];
  const count = ref.replay.values.length;
  const head = `most replayed (viewers' public graph, ${count} parts of ${found.width} s, graph median ${found.median}${ref.duration && Math.abs(ref.replay.seconds - ref.duration) > 0.5 ? `, it spans ${ref.replay.seconds} s, the video ${ref.duration} s` : ""})`;
  const named = found.humps.map((hump) => {
    const there = measuredThere(ref, hump.start, hump.end);
    return `${span(hump)} top ${hump.top}${there ? ` (kino measured there: ${there})` : ""}`;
  });
  const opening = found.opening ? `at the start, apart: ${span(found.opening)} top ${found.opening.top}` : "";
  const body = [...named, opening].filter(Boolean).join(" · ") || `no part stands ${HUMP_RISE} above the median`;
  return [`${head}: ${body}`,
    "each video's graph is scaled to itself (not comparable across videos), nobody publishes how it is computed, and a hump can be a part people liked or one they did not understand."];
}

// ---- the hand-run study ---------------------------------------------------------------------------

/** Small seeded random numbers (mulberry32), so the study gives the same answer each run. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What kino measured at second t of a reference: each value a number, or null when not measured. */
export function measuresAt(ref, t) {
  const cuts = ref.numbers?.cuts;
  const curve = ref.fingerprint?.motion?.curve;
  const change = ref.heard?.change;
  const voice = ref.heard?.voice;
  return {
    cutsNear: cuts ? cuts.filter((cut) => Math.abs(cut - t) <= 1).length : null,
    shotSeconds: cuts ? (() => { const edges = [0, ...cuts, ref.numbers.seconds]; const i = edges.findIndex((edge, k) => edge <= t && t < (edges[k + 1] ?? Infinity)); return i >= 0 && edges[i + 1] ? edges[i + 1] - edges[i] : null; })() : null,
    motion: Array.isArray(curve) && Number.isFinite(curve[Math.floor(t)]) ? curve[Math.floor(t)] : null,
    nearSongChange: change ? (Math.abs(change.at - t) <= 2 ? 1 : 0) : null,
    voicePlaying: Array.isArray(voice) ? (voice.some(([from, to]) => t >= from && t <= to) ? 1 : 0) : null,
  };
}

export const MEASURES = {
  cutsNear: "cuts within 1 s",
  shotSeconds: "length of the shot (s)",
  motion: "motion that second",
  nearSongChange: "within 2 s of the song's loudest change",
  voicePlaying: "a voice playing",
};

/** The graph's top-hump seconds inside the measured stretch, and the stretch random times come from. */
function studyTimes(ref) {
  const found = replayHumps(ref.replay);
  const seconds = ref.numbers?.seconds;
  if (!found || !(seconds > 0)) return null;
  const humps = found.humps.filter((hump) => hump.at < seconds);
  const lowest = Math.min(3, seconds / 2);
  return humps.length && seconds > lowest ? { humps: humps.map((hump) => hump.at), lowest, seconds } : null;
}

/**
 * Compares what kino measured at the humps with the same measures at random times of the same
 * videos. refs: reference records (with replay, numbers, fingerprint, heard). Random times are
 * drawn as many per video as it has humps, between 3 s (the start is left out, as humps leave it
 * apart) and the end of the measured stretch; `draws` draws give how often chance gives a
 * difference as large as the one seen. Returns {n (videos), humps, rows: [{measure, label, n,
 * hump, random, difference, chance}], tooSmall}.
 */
export function replayStudy(refs, { seed = 20261112, draws = 5000, minimum = 15 } = {}) {
  const used = refs.map((ref) => ({ ref, times: studyTimes(ref) })).filter((entry) => entry.times);
  const random = seeded(seed);
  const rows = [];
  for (const measure of Object.keys(MEASURES)) {
    const at = (entry, t) => measuresAt(entry.ref, t)[measure];
    const seen = used.flatMap((entry) => entry.times.humps.map((t) => at(entry, t))).filter((value) => value !== null);
    if (!seen.length) { rows.push({ measure, label: MEASURES[measure], n: 0, hump: null, random: null, difference: null, chance: null }); continue; }
    const measured = used.filter((entry) => at(entry, entry.times.humps[0]) !== null);
    const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
    const observed = mean(seen);
    const nulls = [];
    for (let draw = 0; draw < draws; draw += 1) {
      const values = [];
      for (const entry of measured) {
        for (let k = 0; k < entry.times.humps.length; k += 1) {
          const t = entry.times.lowest + random() * (entry.times.seconds - entry.times.lowest);
          const value = at(entry, t);
          if (value !== null) values.push(value);
        }
      }
      nulls.push(values.length ? mean(values) : NaN);
    }
    const valid = nulls.filter(Number.isFinite);
    const base = mean(valid);
    const gap = Math.abs(observed - base);
    const asBig = valid.filter((value) => Math.abs(value - base) >= gap - 1e-12).length;
    rows.push({ measure, label: MEASURES[measure], n: measured.length, hump: round(observed, 3), random: round(base, 3), difference: round(observed - base, 3), chance: round(asBig / valid.length, 3) });
  }
  return { n: used.length, humps: used.reduce((sum, entry) => sum + entry.times.humps.length, 0), rows, tooSmall: used.length < minimum, minimum };
}
