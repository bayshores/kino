// Change Text: an operation that swaps a text layer's string for another one at a point in time,
// with an optional Out effect on the old string and an optional In effect on the new one.
//
// Change Text is one of the text animations: it swaps the layer's string from one value to
// another, with optional In/Out text effects. The text exits (fade, slide, ...), then the new copy enters, and both can overlap if
// they are set to run at the same time. kino keeps it in layer.animations, next to the other
// operations, as
//   { id, name, kind: "change-text", start, text, overlap, out, in, enabled? }
// where `out` and `in` are each null (no effect) or a text effect
//   { preset, duration, easing, unit, stagger, order, distance? }
// - `preset` is one of the Out presets (for `out`) or In presets (for `in`) the Animate tab has.
// - `unit` ("layer", "letters", "words" or "lines"), `stagger` (seconds between units) and
//   `order` ("forward" or "reverse") work as on any text animation.
// - `distance` (pixels) is how far a Slide effect travels; only Slide effects have it.
//
// How the strings follow each other (textChangeSchedule):
// - Before the first Change text the layer shows its own text (layer.text, the Design tab text).
// - A Change text at `start` plays the Out effect on the string shown before it, from `start`.
//   That string disappears when its last unit has finished the Out effect.
// - The new string appears when the Out effect ends, or at `start` when `overlap` is true. It
//   plays its In effect from the moment it appears and then stays.
// - With no Out and no In effect, the swap is instant: at exactly `start` the new text shows.
// - Several Change text operations on a layer run in time order (by start, then by list order);
//   one turned off for playback (animationEnabled.js) is skipped, as if it were not there.
//
// This module only holds the data, the timing and the checks. textChangeDraw.js turns them into
// the states that render.js, the Lottie export and the canvas draw, because it needs
// animation.js, which imports playback.js, which imports this module.

import { displayText, layoutText, textGraphemes, textUnits } from "./textLayout.js";
import { TIMED_ANIMATION_FIELDS, VISIBILITY_TIME_TOLERANCE } from "./visibilityOps.js";
import { isAnimationEnabled } from "./animationEnabled.js";
import { totalUnitDelay } from "./textTiming.js";
import { flattenAnimations } from "./animationTree.js";

export const TEXT_CHANGE_KIND = "change-text";
const TEXT_CHANGE_NAME = "Change text";
// A Counter (counter.js) also changes the string a text layer shows, so a layer with one is drawn
// the same way as one with a Change text (textChangeDraw.js, counterSchedule.js).
export const COUNTER_KIND = "counter";

// The presets a text effect can use, with the names the Animate tab shows.
const TEXT_OUT_EFFECTS = Object.freeze(["fade-out", "shrink-out", "blur-out"]);
const TEXT_IN_EFFECTS = Object.freeze([
  "fade-in", "slide-up", "slide-down", "slide-left", "slide-right", "grow-in", "blur-in", "rotate-in",
]);
export const TEXT_EFFECT_UNITS = Object.freeze(["layer", "letters", "words", "lines"]);
export const TEXT_EFFECT_ORDERS = Object.freeze(["forward", "reverse"]);
// The settings a text effect may have; anything else is refused (model.js).
export const TEXT_EFFECT_FIELDS = Object.freeze(["preset", "duration", "easing", "intensity", "unit", "stagger", "order", "distance", "smoothing", "smoothingIntensity", "range"]);
// A Change text has no duration, from or to of its own: its effects have them.
export const TEXT_CHANGE_FORBIDDEN_FIELDS = TIMED_ANIMATION_FIELDS;

// A new effect plays for as long as a new preset animation (animation.js presetAnimation).
export const DEFAULT_TEXT_EFFECT_SECONDS = 0.6;
// How far a Slide effect travels when no distance is given: the travel a Slide preset uses in a
// scene whose size is unknown (animation.js sceneTravel).
export const DEFAULT_SLIDE_DISTANCE = 80;
export const MAX_TEXT_EFFECT_STAGGER = 60;
export const MAX_SLIDE_DISTANCE = 1_000_000;

const SLIDES = new Set(["slide-up", "slide-down", "slide-left", "slide-right"]);

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** True for a Change text operation. */
export function isTextChange(animation) {
  return animation?.kind === TEXT_CHANGE_KIND;
}

/** True for a Counter (counter.js). */
export function isCounter(animation) {
  return animation?.kind === COUNTER_KIND;
}

/** True for a Slide effect preset (only those have a distance). */
export function isSlideEffect(preset) {
  return SLIDES.has(preset);
}

/** The presets an effect on `side` ("in" or "out") can use. */
export function textEffectPresets(side) {
  return side === "out" ? TEXT_OUT_EFFECTS : TEXT_IN_EFFECTS;
}

/**
 * How far a Slide effect travels in `scene`: the same distance as the Slide Up, Down, Left or
 * Right preset animation (8% of the scene's height for up and down, or of its width for left and
 * right, from 40 to 240 pixels; 80 when the scene's size is unknown).
 */
export function slideDistance(scene, preset) {
  const size = finite(preset === "slide-left" || preset === "slide-right" ? scene?.width : scene?.height, 0);
  return Math.max(40, Math.min(240, size * 0.08 || DEFAULT_SLIDE_DISTANCE));
}

/** The easing a text effect starts with: smooth (0.5, 0, 0, 1), the presets' default, on both sides. */
export const textEffectEasing = () => "smooth";

/**
 * A new text effect on `side` ("in" or "out") using `preset`, with the settings of a new preset
 * animation: 0.6 s, the whole layer at once, smooth both ways.
 * `scene` sets a Slide's distance.
 */
export function createTextEffect(preset, side, scene) {
  if (!textEffectPresets(side).includes(preset))
    throw new RangeError(`"${String(preset)}" is not an ${side === "out" ? "Out" : "In"} text effect`);
  return {
    preset,
    duration: DEFAULT_TEXT_EFFECT_SECONDS,
    easing: textEffectEasing(side),
    unit: "layer",
    stagger: 0,
    order: "forward",
    ...(isSlideEffect(preset) ? { distance: slideDistance(scene, preset) } : {}),
  };
}

/**
 * A new Change text on a text layer at `start` seconds. Its new text starts as the layer's own
 * text, so it is ready to be typed over; the old text fades out and the new text fades in.
 */
export function createTextChange(layer, start, id, scene) {
  if (layer?.type !== "text") throw new TypeError("Change text needs a text layer");
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0)
    throw new RangeError("Change text needs a start time of 0 seconds or later");
  return {
    id,
    name: TEXT_CHANGE_NAME,
    kind: TEXT_CHANGE_KIND,
    start,
    text: typeof layer.text === "string" ? layer.text : "",
    overlap: false,
    out: createTextEffect("fade-out", "out", scene),
    in: createTextEffect("fade-in", "in", scene),
  };
}

/**
 * The seconds a Change text's effects take at most, without stagger: Out then In, or the longer
 * of the two when they overlap. Its start plus this must fit in a document (model.js), and its
 * Timeline block is at least this long.
 */
export function textChangeEffectSeconds(animation) {
  const out = animation?.out ? Math.max(0, finite(animation.out.duration)) : 0;
  const into = animation?.in ? Math.max(0, finite(animation.in.duration)) : 0;
  return animation?.overlap ? Math.max(out, into) : out + into;
}

// How many letters, words or lines a text has, counted from the text alone, for a font that
// isn't loaded (yet). Lines are then the text's paragraphs. stagger.js uses it too.
export function unitsWithoutFonts(layer, unit) {
  const paragraphs = displayText(layer).split("\n");
  if (unit === "letters") return paragraphs.reduce((sum, line) => sum + textGraphemes(line).length, 0);
  if (unit === "words") return paragraphs.reduce((sum, line) => sum + (line.match(/\S+\s*/gu)?.length ?? 0), 0);
  return paragraphs.length;
}

/** How many units of `unit` the layer has when it shows `text` (1 for the whole layer). */
export function textUnitCount(layer, text, unit, fonts) {
  if (unit !== "letters" && unit !== "words" && unit !== "lines") return 1;
  const textLayer = { ...layer, text };
  try {
    return Math.max(1, textUnits(layoutText(textLayer, fonts), unit).length);
  } catch {
    return Math.max(1, unitsWithoutFonts(textLayer, unit));
  }
}

/** How long a text effect plays on a text with `count` units: its duration plus the stagger. */
export function textEffectLength(effect, count) {
  if (!effect) return 0;
  return Math.max(0, finite(effect.duration)) + totalUnitDelay(effect, count);
}

// The layer's Change text operations in the order they run: by start, then by list position.
function orderedChanges(layer, includeOff) {
  const animations = flattenAnimations(layer?.animations);
  return animations
    .map((animation, index) => ({ animation, index }))
    .filter(({ animation }) => isTextChange(animation) && Number.isFinite(animation.start) && (includeOff || isAnimationEnabled(animation)))
    .sort((left, right) => left.animation.start - right.animation.start || left.index - right.index);
}

/** True when the layer has a Change text or a Counter that is used in playback. */
export function hasTextChanges(layer) {
  if (layer?.type !== "text") return false;
  return orderedChanges(layer, false).length > 0 || hasCounters(layer);
}

/** True when the text layer has a Counter (counter.js) that is used in playback. */
export function hasCounters(layer) {
  return layer?.type === "text" && flattenAnimations(layer.animations).some((animation) => isCounter(animation) && Number.isFinite(animation.start) && isAnimationEnabled(animation));
}

/**
 * The strings a text layer shows over time, in order: its own text first, then the text of each
 * Change text that is on. Each is
 *   { key, index, text, appear, disappear, in: { effect, start } | null, out: { effect, start } | null }
 * at the layer's own clock time (playback.js resolvePlayback). A string is drawn from `appear`
 * until just before `disappear` (isStringDrawn). `key` is "base" for the layer's own text and
 * the Change text's ID otherwise. `fonts` counts the units that stagger an effect.
 *
 * Some string is always drawn: string n is drawn from its `appear` until string n + 1's Change
 * text has finished its Out effect, which is never before string n + 1 appears.
 */
export function textChangeSchedule(layer, fonts) {
  const strings = [{ key: "base", index: 0, text: String(layer?.text ?? ""), appear: -Infinity, disappear: Infinity, in: null, out: null }];
  for (const { animation } of orderedChanges(layer, false)) {
    const previous = strings[strings.length - 1];
    const outLength = animation.out ? textEffectLength(animation.out, textUnitCount(layer, previous.text, animation.out.unit, fonts)) : 0;
    const inStart = animation.overlap ? animation.start : animation.start + outLength;
    previous.out = animation.out ? { effect: animation.out, start: animation.start } : null;
    previous.disappear = animation.start + outLength;
    strings.push({
      key: animation.id,
      index: strings.length,
      text: String(animation.text ?? ""),
      appear: inStart,
      disappear: Infinity,
      in: animation.in ? { effect: animation.in, start: inStart } : null,
      out: null,
    });
  }
  return strings;
}

/**
 * Whether a string of textChangeSchedule is drawn at `clock` (the layer's own clock time). The
 * same tolerance as a Hide or Show (visibilityOps.js) lets the export frame at a change's time
 * show the change's result, so an instant swap at a frame boundary shows the new text on it.
 */
export function isStringDrawn(string, clock) {
  return string.appear <= clock + VISIBILITY_TIME_TOLERANCE && clock + VISIBILITY_TIME_TOLERANCE < string.disappear;
}

/**
 * Where each Change text of the layer sits on its Timeline row, turned off or not:
 * a Map from its ID to { start, end, outEnd }. `end` is when its last effect finishes (its
 * start for an instant swap); `outEnd` is when the Out effect finishes (when the new text appears
 * unless the effects overlap). The Out effect's length counts the units of the text shown before
 * it, the In effect's those of its own text.
 */
export function textChangeSpans(layer, fonts) {
  const spans = new Map();
  let shown = String(layer?.text ?? "");
  for (const { animation } of orderedChanges(layer, true)) {
    const outLength = animation.out ? textEffectLength(animation.out, textUnitCount(layer, shown, animation.out.unit, fonts)) : 0;
    const text = String(animation.text ?? "");
    const inStart = animation.overlap ? animation.start : animation.start + outLength;
    const inLength = animation.in ? textEffectLength(animation.in, textUnitCount(layer, text, animation.in.unit, fonts)) : 0;
    spans.set(animation.id, { start: animation.start, end: Math.max(animation.start + outLength, inStart + inLength), outEnd: animation.start + outLength });
    if (isAnimationEnabled(animation)) shown = text;
  }
  return spans;
}

/** How long a Change text plays, in seconds, from its start to the end of its last effect. */
export function textChangeLength(layer, animation, fonts) {
  if (!isTextChange(animation)) return 0;
  // The operation as given, in its own place in the list (or last, when it isn't on the layer yet).
  const animations = flattenAnimations(layer?.animations);
  const listed = animations.some((item) => item?.id === animation.id);
  const list = listed ? animations.map((item) => (item?.id === animation.id ? animation : item)) : [...animations, animation];
  const span = textChangeSpans({ ...layer, animations: list }, fonts).get(animation.id);
  return span ? Math.max(0, span.end - span.start) : textChangeEffectSeconds(animation);
}

/**
 * A text effect's look at `amount` (0: none, 1: fully applied), on top of a unit's state. The
 * amounts are those of the preset animations (animation.js presetAnimation), but relative to
 * the state, so the layer's other animations still move, turn and fade the text:
 * Fade multiplies the opacity by 1 - amount; Slide moves by `distance` (Up starts below, Down
 * above, Left to the right and Right to the left); Grow and Shrink scale to 60%; Blur adds 16;
 * Rotate turns by -90 degrees.
 */
export function applyTextEffect(state, effect, amount) {
  const next = { ...state };
  const a = finite(amount);
  const distance = Math.max(0, finite(effect?.distance, DEFAULT_SLIDE_DISTANCE));
  switch (effect?.preset) {
    case "fade-in":
    case "fade-out":
      next.opacity = finite(state.opacity, 1) * (1 - a);
      break;
    case "slide-up":
      next.y = finite(state.y) + distance * a;
      break;
    case "slide-down":
      next.y = finite(state.y) - distance * a;
      break;
    case "slide-left":
      next.x = finite(state.x) + distance * a;
      break;
    case "slide-right":
      next.x = finite(state.x) - distance * a;
      break;
    case "grow-in":
    case "shrink-out":
      next.scaleX = finite(state.scaleX, 1) * (1 - 0.4 * a);
      next.scaleY = finite(state.scaleY, 1) * (1 - 0.4 * a);
      break;
    case "blur-in":
    case "blur-out":
      next.blur = Math.max(0, finite(state.blur) + 16 * a);
      break;
    case "rotate-in":
      next.rotation = finite(state.rotation) - 90 * a;
      break;
    default:
      break;
  }
  return next;
}

/**
 * Why a Change text can't be at its time in a scene that lasts `sceneDuration` seconds, or ""
 * when it fits (or when `animation` is not a Change text). Like a Hide or Show, its start must
 * be on the scene's timeline, from 0 to the scene's end.
 */
export function textChangeTimeProblem(animation, sceneDuration) {
  if (!isTextChange(animation)) return "";
  const start = animation.start;
  if (typeof start !== "number" || !Number.isFinite(start)) return "Change text needs a start time in seconds.";
  if (start < 0 || start > sceneDuration)
    return `Change text at ${start} s is outside the scene, which lasts ${sceneDuration} s. Use a start from 0 to ${sceneDuration} seconds.`;
  return "";
}

/**
 * Why an update that turns `before` into `after` leaves a Change text outside the scene, or ""
 * when it is fine. Only a new start is checked, so a Change text in a scene that was made
 * shorter can still be edited; moving it must bring it back into the scene.
 */
export function textChangeUpdateProblem(before, after, sceneDuration) {
  if (isTextChange(before) && isTextChange(after) && before.start === after.start) return "";
  return textChangeTimeProblem(after, sceneDuration);
}
