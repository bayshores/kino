// What isolate_voice changed, measured on the files themselves: the clip's own sound (its music or
// room) in the gaps between words, and the voice during the words, before (the original file) and
// after (the voice stem). Words and gaps are found on the voice stem's own level, in 100 ms
// windows over the stretch the layer plays: a word window is within WORD_DB of the stem's loudest
// window there, a gap window is GAP_DB or more under it (the stems study's split, 2026-11-12).
// Clip transcripts in some languages keep one span per line, so word times cannot split a line.

const WINDOW_S = 0.1;
export const WORD_DB = 10;
export const GAP_DB = 25;

const round1 = (value) => Math.round(value * 10) / 10;
const db = (power) => (power > 0 ? 10 * Math.log10(power) : -120);

// Mean power of each 100 ms window of `samples` from second `from` to `to`.
function windows(samples, rate, from, to) {
  const size = Math.max(1, Math.round(rate * WINDOW_S));
  const out = [];
  for (let at = Math.max(0, Math.round(from * rate)); at + size <= Math.min(samples.length, Math.round(to * rate)); at += size) {
    let sum = 0;
    for (let index = at; index < at + size; index += 1) sum += samples[index] * samples[index];
    out.push(sum / size);
  }
  return out;
}

const meanDb = (powers) => db(powers.reduce((sum, value) => sum + value, 0) / Math.max(1, powers.length));

/**
 * {from, to, wordSeconds, gapSeconds, words: {before, after}, gaps: {before, after} | null} in dBFS,
 * for file seconds `from` to `to`: `original` and `voice` are mono samples at `rate` of the source
 * file and its voice stem (same timing). gaps is null when the stretch has no gap windows.
 */
export function stemLevels({ original, voice, rate, from, to }) {
  const before = windows(original, rate, from, to);
  const after = windows(voice, rate, from, to);
  const count = Math.min(before.length, after.length);
  if (!count) return null;
  const loudest = Math.max(...after.slice(0, count).map(db));
  const word = [], gap = [];
  for (let index = 0; index < count; index += 1) {
    const level = db(after[index]);
    if (level >= loudest - WORD_DB) word.push(index);
    else if (level <= loudest - GAP_DB) gap.push(index);
  }
  const pick = (list, indexes) => indexes.map((index) => list[index]);
  return {
    from: round1(from), to: round1(to), wordSeconds: round1(word.length * WINDOW_S), gapSeconds: round1(gap.length * WINDOW_S),
    words: word.length ? { before: round1(meanDb(pick(before, word))), after: round1(meanDb(pick(after, word))) } : null,
    gaps: gap.length ? { before: round1(meanDb(pick(before, gap))), after: round1(meanDb(pick(after, gap))) } : null,
  };
}

/** The receipt's line for one measured stretch (stemLevels' answer). */
export function stemLevelsLine(levels) {
  if (!levels) return "levels not measured (no sound in the stretch the layer plays)";
  const at = `file ${levels.from}-${levels.to} s`;
  const gaps = levels.gaps
    ? `clip sound in the gaps ${levels.gaps.before} dBFS before, ${levels.gaps.after} after (${round1(levels.gaps.before - levels.gaps.after)} dB down, on ${levels.gapSeconds} s of gaps)`
    : "no gaps between words";
  const words = levels.words
    ? `voice in the words ${levels.words.before} dBFS before, ${levels.words.after} after (${round1(levels.words.after - levels.words.before)} dB, on ${levels.wordSeconds} s of words)`
    : "no words found";
  return `${at}: ${gaps}; ${words}`;
}

/**
 * The clip's own sound under a voice, on the original alone: {gapSeconds, gaps, words, under} where
 * under is how many dB the gaps sit under the words (dBFS each), or null without gaps or words.
 * Words and gaps come from `voice` when given (the stem), else from the original's own level.
 */
export function soundUnderVoice({ original, voice = null, rate, from, to }) {
  const levels = stemLevels({ original, voice: voice ?? original, rate, from, to });
  if (!levels?.words || !levels.gaps) return levels ? { ...levels, under: null } : null;
  return { ...levels, under: round1(levels.words.before - levels.gaps.before) };
}
