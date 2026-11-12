// A text layer's `jitter` {rotation?, baseline?, seed?}: every letter gets a small fixed tilt and
// a small fixed lift or drop, so lettering reads hand-set instead of typeset. Fixed per seed and
// letter position: it never animates (textLoop's jitter style is the moving one), so a frame,
// an export and a re-render always agree. It only turns and lifts the drawn letter; spacing and
// line breaks stay as they were. A textStyleRanges rotation or baselineShift adds to it.
//
//   rotation  most degrees a letter turns either way (0..45, default 3)
//   baseline  most percent of the font size a letter sits above or below the baseline (0..50, default 3)
//   seed      picks the pattern (whole number, 1 by default)
// The defaults are a guess at "visibly hand-set, still legible"; a call can change them freely.
import { noise } from "./textLoop.js";

export const LETTER_JITTER_DEFAULTS = Object.freeze({ rotation: 3, baseline: 3, seed: 1 });
const LIMITS = Object.freeze({ rotation: [0, 45], baseline: [0, 50], seed: [0, 4294967295] });
const FIELDS = Object.freeze(["rotation", "baseline", "seed"]);

/** The checked jitter, or throws a RangeError naming the field (model.js wraps it). */
export function normalizeLetterJitter(raw) {
  if (raw === true) return { ...LETTER_JITTER_DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RangeError("must be {rotation?, baseline?, seed?} or true");
  for (const key of Object.keys(raw)) if (!FIELDS.includes(key)) throw new RangeError(`.${key} is not ${FIELDS.join(", ")}`);
  const jitter = {};
  for (const key of FIELDS) {
    if (raw[key] == null) continue;
    const [low, high] = LIMITS[key];
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < low || raw[key] > high)
      throw new RangeError(`.${key} must be a number from ${low} to ${high}`);
    if (key === "seed" && !Number.isInteger(raw[key])) throw new RangeError(".seed must be a whole number");
    jitter[key] = raw[key];
  }
  return jitter;
}

/** The letter at `offset` of the text: {rotation, shift} (degrees, and percent of the font size up). */
export function letterJitterAt(jitter, offset) {
  const rotation = jitter.rotation ?? LETTER_JITTER_DEFAULTS.rotation;
  const baseline = jitter.baseline ?? LETTER_JITTER_DEFAULTS.baseline;
  const seed = Math.floor(jitter.seed ?? LETTER_JITTER_DEFAULTS.seed);
  return { rotation: rotation * noise(seed, offset, 0, 7), shift: baseline * noise(seed, offset, 0, 8) };
}
