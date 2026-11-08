// Hide and Show: instant visibility operations.
//
// Hide / Show is one of the General custom animations: it instantly toggles layer visibility at
// a point on the timeline (no fade or easing). kino keeps each one in layer.animations, next to the timed animations, as
//   { id, name, kind: "hide" | "show", start }
// It is a point in time: it has no duration, easing, from or to values.
//
// How the operations combine (evaluated at a layer's own clock time, like its animations):
// - They apply in time order. Two at the same time apply in list order, so the later one wins.
// - A Hide at t hides the layer from t onward until a later Show; a Show at t shows it from t on.
// - Before the first operation the layer keeps its design visibility, except when the first
//   operation is a Show: then the layer is hidden until that Show. (A Show only does something
//   after the layer was hidden, so a layer that starts with a Show is meant to appear at it.)
// - The eye button (layer.visible === false) hides the layer at all times. The operations never
//   bring a layer back that the eye button hid.
// - A Hide or Show turned off for playback (the Timeline operation eye, animationEnabled.js) is
//   skipped, as if it were not there.

import { isAnimationEnabled } from "./animationEnabled.js";
import { flattenAnimations } from "./animationTree.js";

export const VISIBILITY_KINDS = Object.freeze(["hide", "show"]);

// Export frames are sampled with a rounded step (exportFrameStep), so frame n can fall up to
// about half a millisecond before n / fps (for example 0.999999 s for frame 30 at 30 fps). An
// operation counts as reached on any time within this tolerance of its own time, so the frame at
// an operation's time always shows the operation's result. This is the same tolerance media
// frame lookups use (MEDIA_SAMPLE_TOLERANCE in playback.js).
export const VISIBILITY_TIME_TOLERANCE = 1e-3;

// The fields a timed animation has and an instant operation must not have.
export const TIMED_ANIMATION_FIELDS = Object.freeze([
  "duration",
  "easing",
  "intensity",
  "from",
  "to",
  "unit",
  "stagger",
  "delays", // each text unit's own delay (textTiming.js unitDelay)
  "scatter", // each text unit's seeded offsets (textTiming.js scatteredAnimation)
  "range", // a range selector that times each text unit (textTiming.js textRangeProgress)
  "order",
  "orderSeed", // seeds order random (textTiming.js unitDelay)
  "smoothing",
  "smoothingIntensity",
  "textAnchor",
  "textClip",
  "anchor", // a Resize's anchor point (resizeAnchor.js)
  "motionPath",
  "shadowChannels",
  "behavior", // wiggle and loop (behavior.js)
  "keys", // a custom animation's 3+ keys (model.js readAnimationKeys)
]);

const NAMES = Object.freeze({ hide: "Hide", show: "Show" });

/** True for a Hide or Show operation. */
export function isVisibilityOperation(animation) {
  return animation?.kind === "hide" || animation?.kind === "show";
}

/** The default name of a Hide or Show operation ("Hide" or "Show"). */
export function visibilityOperationName(kind) {
  return NAMES[kind] ?? "";
}

/** A new Hide or Show operation at `start` seconds. `id` is required. */
export function createVisibilityOperation(kind, start, id) {
  if (!VISIBILITY_KINDS.includes(kind)) throw new RangeError(`unknown visibility operation "${String(kind)}"`);
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0)
    throw new RangeError("a visibility operation needs a start time of 0 seconds or later");
  return { id, name: NAMES[kind], kind, start };
}

/**
 * The Hide and Show operations of a list of animations, in the order they apply:
 * by start time, and by list position for equal times. Returns [{ kind, start, index }].
 * An operation turned off for playback (animationEnabled.js) is left out.
 */
export function orderedVisibilityOperations(animations) {
  if (!Array.isArray(animations)) return [];
  return flattenAnimations(animations)
    .map((animation, index) => ({ animation, index }))
    .filter(({ animation }) => isVisibilityOperation(animation) && Number.isFinite(animation.start) && isAnimationEnabled(animation))
    .map(({ animation, index }) => ({ kind: animation.kind, start: animation.start, index }))
    .sort((left, right) => left.start - right.start || left.index - right.index);
}

/**
 * Whether the Hide and Show operations in `animations` leave a layer visible at `time` seconds.
 * A layer without operations is visible (true). This does not look at the eye button; the caller
 * combines both.
 */
export function visibleByOperations(animations, time) {
  const operations = orderedVisibilityOperations(animations);
  if (operations.length === 0) return true;
  let visible = operations[0].kind !== "show";
  for (const operation of operations) {
    if (time + VISIBILITY_TIME_TOLERANCE < operation.start) break;
    visible = operation.kind === "show";
  }
  return visible;
}

/**
 * The time ranges in which the operations hide a layer, between 0 and `duration` seconds,
 * as [{ start, end }]. Used to shade the hidden part of a timeline row.
 */
export function hiddenRanges(animations, duration) {
  const operations = orderedVisibilityOperations(animations);
  if (operations.length === 0 || !(duration > 0)) return [];
  const ranges = [];
  let visible = operations[0].kind !== "show";
  let hiddenSince = visible ? null : 0;
  for (const operation of operations) {
    const nextVisible = operation.kind === "show";
    if (nextVisible === visible) continue;
    const at = Math.min(duration, Math.max(0, operation.start));
    if (nextVisible) {
      if (at > hiddenSince) ranges.push({ start: hiddenSince, end: at });
      hiddenSince = null;
    } else hiddenSince = at;
    visible = nextVisible;
  }
  if (hiddenSince !== null && hiddenSince < duration) ranges.push({ start: hiddenSince, end: duration });
  return ranges;
}

/**
 * Why a Hide or Show can't be at its time in a scene that lasts `sceneDuration` seconds, or ""
 * when it fits (or when `animation` is not a Hide or Show). Its time must be from 0 to the end
 * of the scene, so the operation is somewhere on the scene's timeline.
 */
export function visibilityTimeProblem(animation, sceneDuration) {
  if (!isVisibilityOperation(animation)) return "";
  const name = visibilityOperationName(animation.kind);
  const start = animation.start;
  if (typeof start !== "number" || !Number.isFinite(start)) return `${name} needs a start time in seconds.`;
  if (start < 0 || start > sceneDuration)
    return `${name} at ${start} s is outside the scene, which lasts ${sceneDuration} s. Use a start from 0 to ${sceneDuration} seconds.`;
  return "";
}

/**
 * Why an update that turns `before` into `after` leaves a Hide or Show outside a scene that lasts
 * `sceneDuration` seconds, or "" when it is fine. Only a new time is checked: an operation that
 * was already a Hide or Show and keeps its start is left alone. So when a scene is made shorter
 * than an operation's time (which update_scene allows), the operation can still be renamed or
 * switched between Hide and Show, and moving it must bring it back into the scene.
 */
export function visibilityUpdateProblem(before, after, sceneDuration) {
  if (isVisibilityOperation(before) && isVisibilityOperation(after) && before.start === after.start) return "";
  return visibilityTimeProblem(after, sceneDuration);
}
