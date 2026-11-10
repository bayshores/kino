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
