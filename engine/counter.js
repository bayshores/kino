// Counter: an animation that counts the number in a text layer's text from one value to another.
//
// On a text layer whose text has a number, "From" is the number it starts at, "To" the number
// it ends at, and "Step" the interval it counts by, which controls the pace: more steps make the
// count smoother and slower, fewer steps make it snappier. It counts up or down and keeps the
// number's format (counterFormat.js). The number on the canvas is the starting state, an effect
// can be chosen for each step (In/Out), and the duration can be adjusted.
//
// kino keeps it in layer.animations, next to the other animations, as
//   { id, name, kind: "counter", start, duration, easing, from, to, step, out, in, enabled? }
// - `from`, `to` (numbers from -MAX_COUNTER_VALUE to MAX_COUNTER_VALUE) and `step` (a positive
//   number) are plain numbers. The Counter always counts toward `to`, whichever is larger.
// - `out` and `in` are each null (no effect) or a text effect, as a Change text has
//   (textChange.js): the old number plays the Out effect and the new number the In effect at
//   every step (counterSchedule.js).
//
// What the text shows (counterSchedule.js does the timing):
// - Before `start` the layer shows its own text (or what an earlier Change text or Counter left).
// - From `start` to `start + duration` it shows `from` plus the eased progress of the way to `to`,
//   rounded down to whole steps (toward `from`): counterIndexAt gives the number of steps taken,
//   and counterValueAt the value after them. The last step lands exactly on `to`, even when the
//   distance isn't a whole number of steps (0 to 10 by 3 counts 0, 3, 6, 9, 10).
// - From `start + duration` on it shows `to`.
// - Every number is written in the format of the number in the layer's own text (the Design
//   tab's text): its prefix and suffix, sign, zero padding and thousands separator, with as many
//   decimals as the most precise of the text, From, To and Step. A text without a number can't
//   get a new Counter (counterLayerProblem); one whose text lost its number later shows the
//   plain number (counterFormatOf).
//
// Plain functions without React or the DOM, so they can be tested. counterSchedule.js, which
// needs the easings of animation.js, turns these into the strings a layer draws.

import { COUNTER_KIND, isCounter, textEffectLength, textUnitCount } from "./textChange.js";
import { MAX_COUNTER_DECIMALS, decimalPlaces, formatCounterValue, parseCounterText, plainCounterFormat } from "./counterFormat.js";

export { COUNTER_KIND, isCounter };
export const COUNTER_NAME = "Counter";
// Fields of other animations that mean nothing for a Counter (its effects have their own units).
export const COUNTER_FORBIDDEN_FIELDS = Object.freeze(["unit", "stagger", "order", "orderSeed", "smoothing", "smoothingIntensity", "textAnchor", "textClip", "anchor", "motionPath", "shadowChannels", "text", "overlap"]);
// The largest number a Counter counts to (and the largest Step): the largest number a document
// stores (model.js).
export const MAX_COUNTER_VALUE = 1e12;
// The smallest step: one unit of the last of the MAX_COUNTER_DECIMALS decimals.
export const MIN_COUNTER_STEP = 10 ** -MAX_COUNTER_DECIMALS;
// The most steps one Counter takes from From to To: JavaScript numbers count whole numbers
// exactly up to 2^53 (about 9e15), so every step count is exact.
export const MAX_COUNTER_STEPS = 1e15;
// A new Counter counts for one second.
export const DEFAULT_COUNTER_SECONDS = 1;
// How far a new Counter counts from the number in the text (kino's choice).
export const DEFAULT_COUNTER_DISTANCE = 100;
// Steps closer than this to a whole number of steps are that whole number, so floating-point
// products such as 0.1 * 30 (3.0000000000000004) don't lose or gain a step.
const STEP_TOLERANCE = 1e-9;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** A short quote of a text for messages: at most 40 characters, on one line. */
function quoted(text) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  return `“${flat.length > 40 ? `${flat.slice(0, 39)}…` : flat}”`;
}

/** Why `text` can't be counted, or "" when it has a number. */
export function counterTextProblem(text) {
  if (parseCounterText(text)) return "";
  return `A Counter needs a number in the text, such as 0, 42%, or $1,234.50; ${quoted(text)} has no digits.`;
}

/** Why a Counter can't go on `layer`, or "": only text with a number in it has something to count. */
export function counterLayerProblem(layer, animation) {
  if (!isCounter(animation)) return "";
  if (layer?.type !== "text") return "A Counter needs a text layer; only text has a number to count.";
  return counterTextProblem(layer.text);
}

/**
 * Why an edit that turns `before` into `after` on `layer` can't be stored, or "". A new Counter
 * (or an animation that becomes one) needs a text layer with a number. An edit of an existing
 * Counter is not refused when the text lost its number later, so it can still be changed, turned
 * off or removed; it shows the plain number meanwhile.
 */
export function counterEditProblem(layer, before, after) {
  if (!isCounter(after) || isCounter(before)) return "";
  return counterLayerProblem(layer, after);
}

/**
 * Why `from`, `to` and `step` can't be a Counter's values, or "": From and To must be numbers
 * from -MAX_COUNTER_VALUE to MAX_COUNTER_VALUE, Step a number from MIN_COUNTER_STEP to
 * MAX_COUNTER_VALUE, and From to To at most MAX_COUNTER_STEPS steps.
 */
export function counterValueProblem({ from, to, step }) {
  for (const [name, value] of [["From", from], ["To", to]]) {
    if (typeof value !== "number" || !Number.isFinite(value)) return `A Counter's ${name} must be a number.`;
    if (Math.abs(value) > MAX_COUNTER_VALUE) return `A Counter's ${name} must be from -${MAX_COUNTER_VALUE} to ${MAX_COUNTER_VALUE}.`;
  }
  if (typeof step !== "number" || !Number.isFinite(step)) return "A Counter's Step must be a number.";
  if (step < MIN_COUNTER_STEP) return `A Counter's Step must be at least ${MIN_COUNTER_STEP}; it counts toward To, so it is never negative.`;
  if (step > MAX_COUNTER_VALUE) return `A Counter's Step must be at most ${MAX_COUNTER_VALUE}.`;
  if (Math.abs(to - from) / step > MAX_COUNTER_STEPS)
    return `A Counter can take at most ${MAX_COUNTER_STEPS} steps; use a larger Step.`;
  return "";
}

/** The To of a new Counter: DEFAULT_COUNTER_DISTANCE above From (below it near the largest value). */
export function defaultCounterTo(from) {
  const up = from + DEFAULT_COUNTER_DISTANCE;
  return up <= MAX_COUNTER_VALUE ? up : from - DEFAULT_COUNTER_DISTANCE;
}

/**
 * A new Counter on a text layer at `start` seconds: it counts from the number in the text (so
 * nothing changes when it starts) to 100 more, by 1, for one second with Smooth easing, without
 * effects. Throws a RangeError with counterLayerProblem's message on a layer without a number.
 */
export function createCounter(layer, start, id) {
  const problem = counterLayerProblem(layer, { kind: COUNTER_KIND });
  if (problem) throw new RangeError(problem);
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0)
    throw new RangeError("A Counter needs a start time of 0 seconds or later");
  const from = Math.max(-MAX_COUNTER_VALUE, Math.min(MAX_COUNTER_VALUE, parseCounterText(layer.text).value));
  return {
    id,
    name: COUNTER_NAME,
    kind: COUNTER_KIND,
    start,
    duration: DEFAULT_COUNTER_SECONDS,
    easing: "smooth",
    from,
    to: defaultCounterTo(from),
    step: 1,
    out: null,
    in: null,
  };
}

/**
 * How a Counter steps: { from, to, step, direction (1 up, -1 down), ratio (the distance in
 * steps, maybe not whole), count (the steps to reach To: 0 when From is To) }.
 */
export function counterSteps(counter) {
  const from = finite(counter?.from);
  const to = finite(counter?.to);
  const step = Math.max(MIN_COUNTER_STEP, finite(counter?.step, 1));
  const ratio = Math.abs(to - from) / step;
  const count = ratio === 0 ? 0 : Math.max(1, Math.ceil(ratio - STEP_TOLERANCE));
  return { from, to, step, direction: to >= from ? 1 : -1, ratio, count };
}

/**
 * How many steps a Counter has taken at `progress` (its eased progress, 0 at the start and 1 at
 * the end; values outside are clamped): the progress of the way to To rounded down to whole
 * steps, and never more than the steps to To.
 */
export function counterIndexAt(counter, progress, steps = counterSteps(counter)) {
  const amount = Math.max(0, Math.min(1, finite(progress)));
  return Math.min(steps.count, Math.max(0, Math.floor(amount * steps.ratio + STEP_TOLERANCE)));
}

/** The value after `index` steps: From plus the steps, and exactly To after the last one. */
export function counterValueAt(counter, index, steps = counterSteps(counter)) {
  if (index >= steps.count) return steps.to;
  if (index <= 0) return steps.from;
  return steps.from + steps.direction * index * steps.step;
}

/**
 * The format a Counter on `layer` writes its numbers in: the format of the number in the layer's
 * own text (the plain number when it has none), with as many decimals as the most precise of
 * the text, From, To and Step.
 */
export function counterFormatOf(layer, counter) {
  const format = parseCounterText(layer?.text) ?? plainCounterFormat();
  const decimals = Math.max(format.decimals, decimalPlaces(counter?.from), decimalPlaces(counter?.to), decimalPlaces(counter?.step));
  return { ...format, decimals: Math.min(MAX_COUNTER_DECIMALS, decimals) };
}

/** The text after `index` steps, in `format` (counterFormatOf). */
export function counterTextAt(counter, format, index, steps = counterSteps(counter)) {
  return formatCounterValue(format, counterValueAt(counter, index, steps), format.decimals);
}

/**
 * How long a Counter plays, in seconds: its duration, plus the effects of its last step, which
 * play in full after it (counterSchedule.js), counted with the units of the last two numbers.
 * `fonts` lays the text out to count letters, words or lines.
 */
export function counterPlaybackLength(layer, counter, fonts) {
  const duration = Math.max(0, finite(counter?.duration));
  if (!counter?.out && !counter?.in) return duration;
  const steps = counterSteps(counter);
  const format = counterFormatOf(layer, counter);
  const last = counterTextAt(counter, format, steps.count, steps);
  const before = counterTextAt(counter, format, Math.max(0, steps.count - 1), steps);
  const out = counter.out ? textEffectLength(counter.out, textUnitCount(layer, before, counter.out.unit, fonts)) : 0;
  const into = counter.in ? textEffectLength(counter.in, textUnitCount(layer, last, counter.in.unit, fonts)) : 0;
  return duration + Math.max(out, into);
}
