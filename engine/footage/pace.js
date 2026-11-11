// Music-led pacing for compose {footage, pace}: shot lengths planned as runs, accents on the
// downbeats, and an energy arc. The numbers come from 354 social video templates and 26
// measured previews:
//   - runs: one shot length in whole beats, repeated 3 to 8 times, the rate changing at a phrase
//     line (9 of 17 multi-shot previews; 16 x 0.67 s, then 4 x 2.6 s, ...)
//   - promo: about 2 beats a shot, one hero hold up to 5.5 s; velocity: 1 beat a shot
//   - every cut on the beat grid, from beat indexes (promos that count frames drift off the song)
//   - a motion accent on each downbeat, cut or not (motion 9.9 on downbeats vs 6.9 on other beats);
//     off unless asked (accents:true): a template average is no reason for an accent on a shot
//   - a calm open and an ending at about twice the opening's motion (promo 4.1 first s, 8.9 last s)
// Plain data in, plain data out; plan.js uses it.

export const PACES = Object.freeze({
  promo: Object.freeze({ beats: 2, hero: 5.5, line: "promo pace: about 2 beats a shot, one hero hold up to 5.5 s" }),
  velocity: Object.freeze({ beats: 1, hero: 5.5, line: "velocity pace: 1 beat a shot" }),
});
export const PACE_NAMES = Object.freeze(Object.keys(PACES));
// Without music, a "beat" is this long, so the treatments' shot lengths still mean something.
export const FREE_BEAT = 0.6;
// A calm phrase holds at least this many shots (a run is 3 to 8 equal shots).
const RUN_LEAST = 3;

// Beats in a phrase (4 bars) and at most in the ending (2 bars).
const PHRASE = 16;
const ENDING = 8;

/**
 * The phrase plan of a stretch of `count` beats from a downbeat, as [{from, to, beats}] (beats
 * from the stretch's start; `beats` is the rate, beats a shot). The energy arc:
 *   - the ending, from the bar line 5 to 8 beats before the end, runs twice as fast (at least 1 beat)
 *   - the open, the first phrase (4 bars), is calm: twice the pace's rate, when that still makes a run of 3
 *   - between them, the pace's rate; a stretch under 3 bars stays at the pace
 * Each rate changes only on a bar line, so every run starts on a downbeat.
 */
export function phrasePlan(pace, count) {
  const base = PACES[pace]?.beats;
  if (!base || !(count > 0)) return [];
  const fast = Math.max(1, base / 2);
  const endFrom = count >= 12 ? Math.ceil((count - ENDING) / 4) * 4 : count;
  const calmTo = Math.min(PHRASE, endFrom);
  const phrases = [];
  const add = (from, to, beats) => {
    if (to <= from) return;
    const last = phrases.at(-1);
    if (last && last.beats === beats) last.to = to;
    else phrases.push({ from, to, beats });
  };
  add(0, calmTo, endFrom > PHRASE && calmTo / (base * 2) >= RUN_LEAST ? base * 2 : base);
  add(calmTo, endFrom, base);
  add(endFrom, count, fast);
  return phrases;
}

/** The rate (beats a shot) at beat `at` of the stretch, and the beat where its phrase ends. */
export function rateAt(phrases, at) {
  const phrase = phrases.find((entry) => at >= entry.from && at < entry.to) ?? phrases.at(-1);
  return phrase ? { beats: phrase.beats, until: phrase.to } : null;
}

/** Runs of equal shots in beats: [{beats, count}] (lengths within 1 ms of a whole beat count). */
export function runsOf(lengths, beat) {
  const runs = [];
  for (const length of lengths) {
    const beats = Math.round(length / beat);
    const whole = Math.abs(length - beats * beat) < 0.002 && beats > 0;
    const last = runs.at(-1);
    if (whole && last && last.beats === beats) last.count += 1;
    else runs.push({ beats: whole ? beats : null, count: 1 });
  }
  return runs;
}

// ---- seam-locked sections (a song's measured shape: backend/song-shape.mjs) --------------------
// Sections with no steady kick: their cuts may dissolve.
const SMOOTH_KINDS = new Set(["intro", "break", "outro"]);
// Seams a cut locks to besides the section edges (a dropout is held through, not cut).
const LOCKED_SEAMS = new Set(["return", "vocal-in", "switch"]);
// A dropout whose return comes within this many seconds is a rest: the picture holds through it.
const REST_MOST = 4;
// Section energy spreads over at least this many dB: sections closer in loudness than about a
// third of it stay in the middle range (a near-flat song is not cut fast and slow by a whisker).
const ENERGY_SPREAD = 12;

/** Shot lengths in beats for a section of `energy` (0 to 1): loud sections cut fast, quiet ones hold. */
export const sectionBeats = (energy) => (energy >= 2 / 3 ? [1, 2] : energy >= 1 / 3 ? [2, 4] : [4, 8]);

/**
 * The song's sections and seams in edit time, for a cut planner locked to them. shape:
 * {sections, seams} in file seconds (song-shape.mjs); offset: the file time at edit time 0; curve:
 * the song's loudness in dB every half second (file time); to: the edit's length; scale: the
 * request's pace on the ranges (0.5 halves every section's beats, 2 doubles them, at least 1 beat).
 * Returns null when the shape has nothing in the edit, else:
 *   seams     [{at, kind, weight}]: where cuts go, to the millisecond (section edges, returns,
 *             vocal entries, beat switches), never inside a rest
 *   rests     [{from, to}]: a dropout to whichever comes first, its return or the next section
 *             edge (a stop before a drop returns on the drop); no cut inside, the picture restarts at `to`
 *   sections  [{from, to, kind, energy, smooth, beats: [low, high]}]: energy 0 to 1 from the
 *             section's mean loudness, spread over the measured dB range (at least ENERGY_SPREAD,
 *             so close sections stay near 0.5); beats, the shot-length range
 */
export function songSections(shape, { offset, curve = [], to = Infinity, scale = 1 }) {
  const parts = (shape?.sections ?? []).filter((part) => Number.isFinite(part?.at) && typeof part.kind === "string").sort((a, b) => a.at - b.at);
  const marks = (shape?.seams ?? []).filter((seam) => Number.isFinite(seam?.at) && typeof seam.kind === "string").sort((a, b) => a.at - b.at);
  if (!parts.length && !marks.length) return null;
  const edit = (time) => Math.round((time - offset) * 1000) / 1000;
  const spans = (parts[0]?.at ?? Infinity) > 0 ? [{ at: 0, kind: "open" }, ...parts] : parts;
  const loudness = spans.map((part, index) => {
    const end = spans[index + 1]?.at ?? curve.length / 2;
    const values = curve.slice(Math.floor(part.at * 2), Math.max(Math.floor(part.at * 2) + 1, Math.ceil(end * 2)));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  });
  const known = loudness.filter(Number.isFinite);
  const low = Math.min(...known), high = Math.max(...known);
  const middle = (low + high) / 2, spread = Math.max(high - low, ENERGY_SPREAD);
  const sections = spans.map((part, index) => {
    const energy = Number.isFinite(loudness[index]) ? Math.round((0.5 + (loudness[index] - middle) / spread) * 100) / 100 : 0.5;
    const beats = sectionBeats(energy).map((count) => Math.max(1, Math.round(count * scale)));
    return { from: Math.max(0, edit(part.at)), to: Math.min(to, edit(spans[index + 1]?.at ?? Infinity)), kind: part.kind, energy, smooth: SMOOTH_KINDS.has(part.kind) || (part.kind === "open" && energy < 1 / 3), beats };
  }).filter((part) => part.to > part.from);
  // A rest ends on its return or on the next section edge, whichever comes first: song-shape.mjs
  // drops the return of a stop right before a drop (the drop's edge is that hit), so a later
  // return must never stretch the rest across the drop.
  const rests = [];
  marks.forEach((seam, index) => {
    if (seam.kind !== "dropout") return;
    const back = marks.slice(index + 1).find((entry) => entry.kind === "return")?.at ?? Infinity;
    const edge = parts.find((part) => part.at > seam.at + 1e-6)?.at ?? Infinity;
    const end = Math.min(back, edge);
    if (end - seam.at <= REST_MOST) rests.push({ from: edit(seam.at), to: edit(end) });
  });
  const inRest = (at) => rests.some((rest) => at > rest.from + 1e-6 && at < rest.to - 1e-6);
  // Section edges always stay (no rest spans one); other seams inside a rest are held through.
  const seams = [...parts.map((part) => ({ at: edit(part.at), kind: part.kind, ...(Number.isFinite(part.weight) ? { weight: part.weight } : {}) })),
    ...marks.filter((seam) => LOCKED_SEAMS.has(seam.kind)).map((seam) => ({ at: edit(seam.at), kind: seam.kind, ...(Number.isFinite(seam.weight) ? { weight: seam.weight } : {}) })).filter((seam) => !inRest(seam.at))]
    .filter((seam) => seam.at > 0 && seam.at < to).sort((a, b) => a.at - b.at);
  if (!seams.length && !rests.some((rest) => rest.to > 0 && rest.from < to)) return null;
  return { seams, rests: rests.filter((rest) => rest.to > 0 && rest.from < to), sections };
}

// ---- an optional burst: only over a measured onset-dense passage, zero bursts is normal ---------
// A beat holding DENSE_HITS strong hits or more (16th notes) is dense; a passage is a whole run of
// 1 to 2 bars of dense beats (a longer run is the section's texture, never a burst), BURST_RATIO
// times the edit's typical beat or more; its shots are at least BURST_SHOT.
const DENSE_HITS = 3;
const BURST_BEATS = [4, 8];
const BURST_RATIO = 1.75;
export const BURST_SHOT = 0.1;

/**
 * The onset-dense passages a burst of short shots may cut over, densest first:
 * [{from, to, cuts, density}] in edit seconds. hits: strong song hits (edit s, in order);
 * beatTimes: the edit's beats (edit s, in order); song: songSections' answer. A passage lies in one
 * driven section (not smooth, energy at least 1/3), is a whole run of dense beats (the beats on
 * either side are not dense), crosses no seam or rest, starts on a beat and
 * ends on the beat after its last dense beat (the hit it resolves on); `cuts` are its hits, at
 * least BURST_SHOT apart and from either end. A song with no such passage gives [].
 */
export function burstPassages(hits, beatTimes, { sections = [], seams = [], rests = [] } = {}) {
  if (beatTimes.length < 2 || !hits.length) return [];
  const counts = beatTimes.slice(0, -1).map((at, index) => hits.filter((hit) => hit >= at - 0.02 && hit < beatTimes[index + 1] - 0.02).length);
  const typical = [...counts].sort((a, b) => a - b)[Math.floor(counts.length / 2)];
  const passages = [];
  for (let index = 0; index < counts.length;) {
    if (counts[index] < DENSE_HITS) { index += 1; continue; }
    // The whole run of dense beats: one longer than 2 bars is the section's texture, not a fill.
    let last = index;
    while (last + 1 < counts.length && counts[last + 1] >= DENSE_HITS) last += 1;
    const from = beatTimes[index], to = beatTimes[last + 1];
    const length = last - index + 1;
    const density = counts.slice(index, last + 1).reduce((total, count) => total + count, 0) / length;
    const part = sections.find((entry) => from >= entry.from - 1e-6 && from < entry.to - 1e-6);
    const fits = length >= BURST_BEATS[0] && length <= BURST_BEATS[1] && density >= BURST_RATIO * Math.max(1, typical)
      && part && !part.smooth && part.energy >= 1 / 3 && to <= part.to + 1e-6
      && !seams.some((seam) => seam.at > from + 1e-6 && seam.at < to - 1e-6)
      && !rests.some((rest) => rest.from < to - 1e-6 && rest.to > from + 1e-6);
    if (fits) {
      const cuts = [];
      for (const hit of hits) {
        if (hit < (cuts.at(-1) ?? from) + BURST_SHOT - 1e-6 || hit > to - BURST_SHOT + 1e-6) continue;
        cuts.push(Math.round(hit * 1000) / 1000);
      }
      passages.push({ from, to, cuts, density: Math.round(density * 100) / 100 });
    }
    index = last + 1;
  }
  return passages.sort((a, b) => b.density - a.density);
}

/**
 * Times of the downbeat accents in [from, to): every downbeat in the ending (from `ending` on),
 * every other one before it (the calm open), none inside `quiet` spans ([{start, end}]: spoken
 * words, a title being read, a designed transition). `downbeats` is the list of downbeat times in
 * edit seconds, in order.
 */
export function accentTimes(downbeats, { from = 0, to = Infinity, ending = Infinity, quiet = [] } = {}) {
  const times = [];
  let bar = 0;
  for (const at of downbeats) {
    if (at < from - 1e-6 || at >= to - 1e-6) continue;
    const early = at < ending - 1e-6;
    bar += 1;
    if (early && bar % 2 === 0) continue;
    if (quiet.some((span) => at > span.start - 0.05 && at < span.end + 0.05)) continue;
    times.push(at);
  }
  return times;
}
