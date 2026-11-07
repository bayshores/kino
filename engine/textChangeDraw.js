// What a text layer with Change text operations (textChange.js) or a Counter (counter.js) draws
// at a time: one or two strings, each cut into units with its own state. render.js draws these states (the editor
// canvas, PNG, GIF and video), the Lottie export samples them per frame (backend/lottie-text.mjs)
// and the canvas outline and text clicks use the string shown (Stage.jsx).
//
// How one string's state is made, for each of its units:
// 1. The layer's own animations run on the layer showing that string (animation.js
//    evaluateLayer), so a Move, Rotate, Color or a letter-by-letter Fade In of the layer applies
//    to whichever string is drawn.
// 2. Auto-size text is measured again with that string (textLayout.js resizeTextLayer): each
//    string gets its own box, sized to its own text, kept at the layer's alignment anchor (the
//    left, center or right edge for Auto width, and the top, middle or bottom for the height).
//    While two strings overlap, both boxes share that anchor.
// 3. The string's In effect, then its Out effect, are applied on top (textChange.js
//    applyTextEffect), each with its own easing and stagger over its own units.
//
// A string is cut into the finest units any of these use: the layer's own text animations
// (render.js textUnitMode), the In effect and the Out effect. So a word-by-word In effect on a
// layer whose own animation runs letter by letter draws each letter, and the letters of a word
// share that word's effect timing.

import { easingAt, evaluateLayer } from "./animation.js";
import { resolvePlayback } from "./playback.js";
import { defaultFonts } from "./fonts.js";
import { layoutText, resizeTextLayer, textUnits } from "./textLayout.js";
import { enabledAnimations } from "./animationEnabled.js";
import { applyTextEffect, hasTextChanges, isStringDrawn, textChangeSchedule } from "./textChange.js";
import { textScheduleAt } from "./counterSchedule.js";
import { textRangeProgress, unitDelay } from "./textTiming.js";
import { textAnimationMode, textAnimationPlan, textAnimationUnitState } from "./textAnimation.js";

const UNIT_MODES = ["letters", "words", "lines"];
// Smaller is finer: letters are inside words, words inside lines, lines inside the layer.
const FINENESS = { letters: 0, words: 1, lines: 2, layer: 3 };

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** The unit the layer's own text animations run by: the first one by letters, words or lines. */
export function layerTextUnitMode(layer) {
  return enabledAnimations(layer?.animations).find((animation) => UNIT_MODES.includes(animation.unit))?.unit ?? "layer";
}

function finer(left, right) {
  return (FINENESS[right] ?? 3) < (FINENESS[left] ?? 3) ? right : left;
}

// The position in `units` (sorted by sourceStart) of the unit that holds text position `at`.
function containingUnit(units, at) {
  let low = 0;
  let high = units.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (units[middle].sourceStart <= at) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

// Maps a drawing unit to its unit in `mode` ({ count, of(drawingIndex) }).
function unitIndexer(layout, units, drawMode, mode) {
  if (!UNIT_MODES.includes(mode)) return { count: 1, of: () => 0 };
  if (mode === drawMode) return { count: Math.max(1, units.length), of: (index) => index };
  const coarse = textUnits(layout, mode);
  return { count: Math.max(1, coarse.length), of: (index) => containingUnit(coarse, units[index]?.sourceStart ?? 0) };
}

/**
 * How one string of the schedule is drawn: its units (textLayout.js textUnits of the layer's
 * own layout with that string) and which unit of the layer's animations, the In effect and the
 * Out effect each drawing unit belongs to.
 */
export function textStringPlan(layer, string, fonts = defaultFonts) {
  const layerMode = layerTextUnitMode(layer);
  let mode = textAnimationMode(layer);
  if (string.in) mode = finer(mode, string.in.effect.unit);
  if (string.out) mode = finer(mode, string.out.effect.unit);
  const textLayer = { ...layer, text: string.text };
  if (string.text !== layer.text) delete textLayer.textStyleRanges;
  const layout = layoutText(textLayer, fonts);
  const units = textUnits(layout, mode);
  return {
    ...string,
    mode,
    layerMode,
    textLayer,
    units,
    ownUnits: unitIndexer(layout, units, mode, layerMode),
    ownPlan: textAnimationPlan(textLayer, fonts, mode),
    inUnits: string.in ? unitIndexer(layout, units, mode, string.in.effect.unit) : null,
    outUnits: string.out ? unitIndexer(layout, units, mode, string.out.effect.unit) : null,
  };
}

/**
 * Every string a text layer shows over time (textChangeSchedule), each with its plan. A layer
 * with a Counter shows different strings at different times, so it uses textDrawnPlansAt.
 */
export function textStringPlans(layer, fonts = defaultFonts) {
  return textChangeSchedule(layer, fonts).map((string) => textStringPlan(layer, string, fonts));
}

/**
 * The plans of the strings drawn at `time` on the scene's clock, oldest first: the Change text
 * strings and the numbers of a Counter (counterSchedule.js textScheduleAt) shown then.
 */
export function textDrawnPlansAt(layer, time, fonts = defaultFonts) {
  const clock = resolvePlayback(layer, time).time;
  return textScheduleAt(layer, clock, fonts)
    .filter((string) => isStringDrawn(string, clock))
    .map((string) => textStringPlan(layer, string, fonts));
}

// How far an effect has played for one drawing unit at `clock`: 0 before the unit starts, 1 once
// it has finished, eased in between. The unit waits `stagger` seconds per unit before it, or a
// range selector gives each unit its own progress over the effect's whole duration.
function effectProgress(timing, indexer, drawingIndex, clock) {
  const { effect, start } = timing;
  const index = indexer.of(drawingIndex);
  const begin = start + unitDelay(effect, index, indexer.count);
  const duration = finite(effect.duration);
  const progress = duration <= 0 ? 1 : Math.max(0, Math.min(1, (clock - begin) / duration));
  const eased = easingAt(effect.easing ?? "linear", progress, effect.intensity);
  return effect.range ? textRangeProgress(effect.range, eased, index, indexer.count) : eased;
}

// The layer's own animations on the layer showing the plan's string, for one of its own units.
function ownState(layer, plan, drawingIndex, time, fonts) {
  if (plan.ownPlan) return textAnimationUnitState(plan.ownPlan, drawingIndex, time);
  const options = { unitIndex: plan.ownUnits.of(drawingIndex), unitCount: plan.ownUnits.count, fonts };
  if (plan.layerMode !== "layer") options.unit = plan.layerMode;
  const evaluated = evaluateLayer(plan.textLayer, time, options);
  return resizeTextLayer({ ...plan.textLayer, ...evaluated, text: plan.text }, fonts);
}

function withEffects(state, plan, drawingIndex, clock) {
  let next = state;
  if (plan.in) next = applyTextEffect(next, plan.in.effect, 1 - effectProgress(plan.in, plan.inUnits, drawingIndex, clock));
  if (plan.out) next = applyTextEffect(next, plan.out.effect, effectProgress(plan.out, plan.outUnits, drawingIndex, clock));
  return next;
}

/**
 * The state of one drawing unit of a string (a plan of textStringPlan) at `time` on the scene's
 * clock: the layer's own animations, the string's own box and its effects. `visible` is false
 * when the layer is hidden then (Hide, Play range); whether the string itself is drawn at that
 * time is isStringDrawnAt.
 */
export function textStringUnitState(layer, plan, drawingIndex, time, fonts = defaultFonts) {
  const clock = resolvePlayback(layer, time).time;
  return withEffects(ownState(layer, plan, drawingIndex, time, fonts), plan, drawingIndex, clock);
}

/** Whether a string of the schedule is drawn at `time` on the scene's clock. */
export function isStringDrawnAt(layer, string, time) {
  return isStringDrawn(string, resolvePlayback(layer, time).time);
}

/**
 * What a text layer with Change text draws at `time` on the scene's clock: the strings shown
 * then, oldest first, as [{ key, index, text, mode, units: [{ unit, state }] }]. While an Out
 * and an In effect overlap there are two. A layer without a Change text that is on returns [].
 */
export function textDrawingsAt(layer, time, fonts = defaultFonts) {
  if (!hasTextChanges(layer)) return [];
  const clock = resolvePlayback(layer, time).time;
  return textDrawnPlansAt(layer, time, fonts)
    .map((plan) => {
      // Units of the same unit of the layer's own animations share its state, so it is worked
      // out once (for the whole layer, once per string).
      const own = new Map();
      const units = plan.units.map((unit, index) => {
        const ownIndex = plan.ownPlan?.independent ? index : plan.ownUnits.of(index);
        if (!own.has(ownIndex)) own.set(ownIndex, ownState(layer, plan, index, time, fonts));
        return { unit, state: withEffects(own.get(ownIndex), plan, index, clock) };
      });
      return { key: plan.key, index: plan.index, text: plan.text, mode: plan.mode, units };
    });
}

/**
 * The text the layer shows at `time`: the newest string drawn then, or the layer's own text when
 * it has no Change text that is on. The canvas outline and text clicks follow this string's box.
 */
export function shownTextAt(layer, time, fonts = defaultFonts) {
  if (!hasTextChanges(layer)) return layer?.text;
  const clock = resolvePlayback(layer, time).time;
  const drawn = textScheduleAt(layer, clock, fonts).filter((string) => isStringDrawn(string, clock));
  return drawn.length ? drawn[drawn.length - 1].text : layer.text;
}
