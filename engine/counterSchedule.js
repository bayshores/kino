// When a Counter (counter.js) shows each of its numbers, and the strings a text layer with a
// Counter draws at a time, together with its Change text operations (textChange.js).
//
// A Counter can count a million steps in a second, so its numbers are never listed one by one.
// For a time, counterStateAt finds the number shown, when it appeared and when the next one
// comes, straight from the easing:
// - The value at a time is From plus the eased progress of the way to To, rounded down to whole
//   steps (counter.js counterIndexAt). For an easing that only goes up (Linear, Smooth, Ease In,
//   Ease Out, Natural, and a custom curve whose y values stay
//   from 0 to 1), the step count only goes up, so the moment a number appears is found by halving
//   the time between two moments with a different count until they meet.
// - Elastic, Bounce, Swing and other custom curves go up and down, so the count can go back. They
//   are cut into pieces that only go one way (easingPieces), and each piece is searched the same
//   way. At the end of the Counter the number is exactly To.
//
// The strings of a layer at a time (textScheduleAt) have the shape textChange.js
// textChangeSchedule gives: { key, index, text, appear, disappear, in, out }. Operations run in
// time order (by start, then list order). Each one takes over the string the one before it left:
// - A Change text works as described in textChange.js.
// - A Counter starts by showing From. When that is a different text from the string before it,
//   the old string plays the Counter's Out effect and From plays its In effect, both from the
//   start. At each step, the old number plays the Out effect and the new number the In effect,
//   both from the moment of the step. Each effect is made shorter (its duration and stagger in
//   proportion) when it would last longer than the time until the next step, so the numbers
//   never pile up; the last step's effects play in full. A string's key is
//   "<counter ID>#<number of steps>", the same at every time, so the Lottie export can follow it.
// - The next operation stops the Counter where it is: the number shown at its start stays, and
//   that operation plays its Out effect on it.
// The list holds only the strings that can be drawn at that time (and the ones before them, as
// placeholders for the operations' order); isStringDrawn picks the ones drawn.

import { easingAt, easingBreakpoints } from "./easing.js";
import { isAnimationEnabled } from "./animationEnabled.js";
import { flattenAnimations } from "./animationTree.js";
import { VISIBILITY_TIME_TOLERANCE } from "./visibilityOps.js";
import { counterFormatOf, counterIndexAt, counterSteps, counterTextAt, isCounter } from "./counter.js";
import { hasCounters, isTextChange, textChangeSchedule, textEffectLength, textUnitCount } from "./textChange.js";

// Easings whose value, once clamped from 0 to 1, never goes down.
const RISING_EASINGS = new Set(["linear", "smooth", "natural", "expo-out", "quart-out", "in-out", "ease-out", "ease-in"]);
// How finely an easing that goes up and down is sampled to find where it turns.
const TURN_SAMPLES = 1024;
// Halving steps of a search: far finer than a microsecond for any duration.
const SEARCH_STEPS = 60;
const SHORTEST_DURATION = 1e-6;
const UNIT_MODES = new Set(["letters", "words", "lines"]);

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clampedEasing = (easing, progress, intensity) => Math.max(0, Math.min(1, easingAt(easing, progress, intensity)));

// Where an easing that goes up and down turns, worked out once per easing.
const piecesByEasing = new Map();

// The progress (0 to 1) of the extreme value of `easing` between `low` and `high`: the highest
// when `highest`, the lowest otherwise (a golden-section search).
function turningPoint(easing, low, high, highest, intensity) {
  const ratio = (Math.sqrt(5) - 1) / 2;
  const score = (progress) => (highest ? 1 : -1) * clampedEasing(easing, progress, intensity);
  let a = low;
  let b = high;
  for (let step = 0; step < SEARCH_STEPS; step += 1) {
    const left = b - ratio * (b - a);
    const right = a + ratio * (b - a);
    if (score(left) < score(right)) a = left;
    else b = right;
  }
  return (a + b) / 2;
}

/**
 * The progress points (from 0 to 1, first 0 and last 1) that cut `easing`, clamped from 0 to 1,
 * into pieces that each only go up or only go down. [0, 1] for an easing that never goes down.
 */
export function easingPieces(easing, intensity = 50) {
  if (typeof easing === "string" && RISING_EASINGS.has(easing)) return [0, 1];
  // A custom curve whose middle points' y values are from 0 to 1 never goes down.
  if (Array.isArray(easing) && easing[1] >= 0 && easing[1] <= 1 && easing[3] >= 0 && easing[3] <= 1) return [0, 1];
  const key = JSON.stringify([easing, intensity]);
  if (piecesByEasing.has(key)) return piecesByEasing.get(key);
  const exact = easingBreakpoints(easing, intensity);
  if (exact) {
    if (piecesByEasing.size >= 256) piecesByEasing.delete(piecesByEasing.keys().next().value);
    piecesByEasing.set(key, exact);
    return exact;
  }
  const points = [0];
  let direction = 0;
  let previous = clampedEasing(easing, 0, intensity);
  for (let index = 1; index <= TURN_SAMPLES; index += 1) {
    const value = clampedEasing(easing, index / TURN_SAMPLES, intensity);
    const change = value - previous;
    previous = value;
    const now = change > 1e-12 ? 1 : change < -1e-12 ? -1 : 0;
    if (now === 0) continue;
    if (direction !== 0 && now !== direction) {
      const turn = turningPoint(easing, Math.max(0, (index - 2) / TURN_SAMPLES), index / TURN_SAMPLES, direction > 0, intensity);
      if (turn > points[points.length - 1]) points.push(turn);
    }
    direction = now;
  }
  points.push(1);
  if (piecesByEasing.size >= 256) piecesByEasing.delete(piecesByEasing.keys().next().value);
  piecesByEasing.set(key, points);
  return points;
}

// The piece of `pieces` that `progress` is in: the last one that starts at or before it.
function pieceOf(pieces, progress) {
  let index = 0;
  while (index < pieces.length - 2 && pieces[index + 1] <= progress) index += 1;
  return index;
}

/**
 * When a Counter shows what, at `time` seconds on the layer's clock (at or after its start):
 *   { index, since, previous, next }
 * `index` is the number of steps taken (counter.js counterValueAt gives the value), `since` when
 * that number appeared, `previous` the steps before it (null when it has shown since the start),
 * and `next` when the next number comes (Infinity when this one stays).
 */
export function counterStateAt(counter, time) {
  const steps = counterSteps(counter);
  const start = finite(counter.start);
  const duration = Math.max(SHORTEST_DURATION, finite(counter.duration, SHORTEST_DURATION));
  const pieces = easingPieces(counter.easing, counter.intensity);
  // The step count along the way, without the jump to To at the very end.
  const stepsAt = (progress) => counterIndexAt(counter, clampedEasing(counter.easing, progress, counter.intensity), steps);
  const seconds = (progress) => start + progress * duration;
  const progress = (time - start) / duration;

  // The moment the count became `index`, searching back from `end` (where the count is `index`).
  function appeared(end, index) {
    let piece = pieceOf(pieces, end);
    let upper = end;
    for (;;) {
      const lower = pieces[piece];
      if (stepsAt(lower) === index) {
        if (piece === 0) return { since: start, previous: null };
        upper = lower;
        piece -= 1;
        continue;
      }
      let before = lower;
      let after = upper;
      for (let step = 0; step < SEARCH_STEPS; step += 1) {
        const middle = (before + after) / 2;
        if (stepsAt(middle) === index) after = middle;
        else before = middle;
      }
      return { since: seconds(after), previous: stepsAt(before) };
    }
  }

  if (progress >= 1) {
    // At the end the count is exactly To: a last step right at the end when the eased count
    // stopped short of it (the distance is not a whole number of steps).
    const reached = stepsAt(1);
    const last = reached === steps.count ? appeared(1, steps.count) : { since: seconds(1), previous: reached };
    return { index: steps.count, ...last, next: Infinity };
  }
  const at = Math.max(0, progress);
  const index = stepsAt(at);
  const last = appeared(at, index);
  // The moment the count stops being `index`, searching forward.
  let piece = pieceOf(pieces, at);
  let lower = at;
  for (;;) {
    const upper = pieces[piece + 1];
    if (stepsAt(upper) === index) {
      if (upper >= 1) return { index, ...last, next: index === steps.count ? Infinity : seconds(1) };
      lower = upper;
      piece += 1;
      continue;
    }
    let before = lower;
    let after = upper;
    for (let step = 0; step < SEARCH_STEPS; step += 1) {
      const middle = (before + after) / 2;
      if (stepsAt(middle) === index) before = middle;
      else after = middle;
    }
    return { index, ...last, next: seconds(after) };
  }
}

/**
 * `effect` made to last at most `interval` seconds on a text of `count` units: its duration and
 * stagger shortened in proportion when it would take longer, and unchanged otherwise.
 */
export function fittedEffect(effect, interval, count) {
  const length = textEffectLength(effect, count);
  if (!(interval < length)) return effect;
  const factor = Math.max(0, interval) / length;
  return { ...effect, duration: finite(effect.duration) * factor, stagger: finite(effect.stagger) * factor };
}

// The layer's Change text and Counter operations that are on, in the order they run.
function textOperations(layer) {
  return flattenAnimations(layer?.animations)
    .map((animation, index) => ({ animation, index }))
    .filter(({ animation }) => (isTextChange(animation) || isCounter(animation)) && Number.isFinite(animation.start) && isAnimationEnabled(animation))
    .sort((left, right) => left.animation.start - right.animation.start || left.index - right.index)
    .map(({ animation }) => animation);
}

/**
 * The strings a text layer may draw at `clock` (its own clock time, playback.js resolvePlayback),
 * in drawing order, oldest first: the whole textChangeSchedule for a layer without a Counter, and
 * otherwise the strings around that time, as described at the top of this file. `fonts` counts
 * the units that stagger an effect.
 */
export function textScheduleAt(layer, clock, fonts) {
  if (!hasCounters(layer)) return textChangeSchedule(layer, fonts);
  // An operation that starts right after `clock` counts as started, as isStringDrawn does. The
  // number a Counter shows is the one at `clock` itself: counter.js counterIndexAt already
  // keeps floating-point error from losing a step, and a Counter can take many steps per
  // millisecond.
  const now = finite(clock);
  const at = now + VISIBILITY_TIME_TOLERANCE;
  const counts = new Map();
  // Units only matter for an effect with a stagger; laying the text out is then needed.
  const units = (text, effect) => {
    if (!(finite(effect?.stagger) > 0) || !UNIT_MODES.has(effect.unit)) return 1;
    const key = `${effect.unit}\n${text}`;
    if (!counts.has(key)) counts.set(key, textUnitCount(layer, text, effect.unit, fonts));
    return counts.get(key);
  };
  const strings = [{ key: "base", index: 0, text: String(layer?.text ?? ""), appear: -Infinity, disappear: Infinity, in: null, out: null }];
  const push = (string) => strings.push({ ...string, index: strings.length });
  const operations = textOperations(layer);

  // The string that a Counter shows from `state` (counterStateAt) on, whose In effect has until
  // `until` (the next step, or the next operation) to play.
  function counted(counter, texts, state, until, changesAtStart) {
    const text = texts(state.index);
    let into = null;
    if (counter.in) {
      // From shows without an effect when it is the text that was already there.
      if (state.previous === null && !changesAtStart) into = { effect: counter.in, start: -Infinity };
      else into = { effect: fittedEffect(counter.in, until - state.since, units(text, counter.in)), start: state.since };
    }
    // The Out effect waits for the next step; it is listed so the string keeps the same units
    // (a duration above 0 keeps it at its start, not finished).
    const out = counter.out ? { effect: { ...counter.out, duration: Math.max(finite(counter.out.duration), 1) }, start: Infinity } : null;
    return { key: `${counter.id}#${state.index}`, text, appear: state.since, disappear: Infinity, in: into, out };
  }

  // The number before the step of `state`, playing the Out effect from that step until `until`.
  function leaving(counter, texts, state, until) {
    const text = texts(state.previous);
    const effect = counter.out ? fittedEffect(counter.out, until - state.since, units(text, counter.out)) : null;
    return {
      key: `${counter.id}#${state.previous}`,
      text,
      appear: -Infinity,
      disappear: state.since + (effect ? textEffectLength(effect, units(text, effect)) : 0),
      in: counter.in ? { effect: counter.in, start: -Infinity } : null,
      out: effect ? { effect, start: state.since } : null,
    };
  }

  for (let position = 0; position < operations.length; position += 1) {
    const operation = operations[position];
    const next = operations[position + 1]?.start ?? Infinity;
    const previous = strings[strings.length - 1];
    if (isTextChange(operation)) {
      const outLength = operation.out ? textEffectLength(operation.out, units(previous.text, operation.out)) : 0;
      const inStart = operation.overlap ? operation.start : operation.start + outLength;
      previous.out = operation.out ? { effect: operation.out, start: operation.start } : null;
      previous.disappear = operation.start + outLength;
      if (operation.start > at) break;
      push({ key: operation.id, text: String(operation.text ?? ""), appear: inStart, disappear: Infinity, in: operation.in ? { effect: operation.in, start: inStart } : null, out: null });
      continue;
    }
    const counter = operation;
    const steps = counterSteps(counter);
    const format = counterFormatOf(layer, counter);
    const texts = (index) => counterTextAt(counter, format, index, steps);
    const start = counter.start;
    // The string before the Counter plays its Out effect when From is a different text.
    const changesAtStart = previous.text !== texts(0);
    const firstStep = Math.min(counterStateAt(counter, start).next, next);
    const startOut = changesAtStart && counter.out ? fittedEffect(counter.out, firstStep - start, units(previous.text, counter.out)) : null;
    previous.out = startOut ? { effect: startOut, start } : null;
    previous.disappear = start + (startOut ? textEffectLength(startOut, units(previous.text, startOut)) : 0);
    if (start > at) break;
    if (at >= next) {
      // The next operation has started: the number shown at its start stays.
      push(counted(counter, texts, counterStateAt(counter, next), next, changesAtStart));
      continue;
    }
    const state = counterStateAt(counter, now);
    const until = Math.min(state.next, next);
    if (state.previous !== null) push(leaving(counter, texts, state, until));
    push(counted(counter, texts, state, until, changesAtStart));
    // When more steps come before the next operation, that operation takes over the number
    // shown at its start, not this one.
    if (state.next < next && next < Infinity) push(counted(counter, texts, counterStateAt(counter, next), next, changesAtStart));
  }
  return strings;
}
