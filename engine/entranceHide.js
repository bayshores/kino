// A preset entrance (slide, blur-slide, grow, rotate, blur) that does not fade leaves the layer
// drawn at its From values before its start: a blurred word sat at the frame edge for 18 frames
// before its entrance (recreate test GAPS item 7, fan-fast k12-29). An "in" preset added with
// add_animation therefore also gets a Show at its start, so the layer is hidden until the entrance
// begins. Only where it is safe: no Hide or Show on the layer yet (the person's own visibility
// choices win), a start after 0, and a From that does not already hide the layer (opacity 0, a
// wipe, an effect preset). Old documents keep their stored animations; only a new add does this.
import { orderedVisibilityOperations, createVisibilityOperation } from "./visibilityOps.js";
import { uid } from "./model.js";

const hidesItself = (from) => !from || from.opacity === 0 || from.reveal !== undefined || from.effectPreset !== undefined;

/** The Show operation to add beside `added` (a preset entrance on `layer`), or null when none is needed. */
export function showBeforeEntrance(layer, added) {
  if (!added?.preset || added.kind !== "in" || added.discrete) return null;
  if (!(added.start > 0) || hidesItself(added.from)) return null;
  if (orderedVisibilityOperations(layer.animations).length) return null;
  return createVisibilityOperation("show", added.start, uid());
}

/**
 * The Show keeps to its entrance: when the entrance `before` becomes `after` (a new start) or is
 * deleted (`after` null), the layer's one Show at the entrance's old start moves with it or goes.
 * Without this a later retime brought the ghost back (the layer drawn at its From values between
 * the Show and the entrance) or hid part of the entrance. `list` is the layer's top-level animations.
 * A layer with any other Hide or Show is left alone, as in showBeforeEntrance.
 */
export function followEntrance(list, before, after) {
  if (!before?.preset || before.kind !== "in" || (after && after.start === before.start)) return list;
  const visibility = orderedVisibilityOperations(list);
  if (visibility.length !== 1 || visibility[0].kind !== "show" || Math.abs(visibility[0].start - before.start) > 1e-6) return list;
  const show = list.find((item) => item?.kind === "show");
  if (!show) return list;
  if (!after || !(after.start > 0)) return list.filter((item) => item !== show);
  return list.map((item) => (item === show ? { ...item, start: after.start } : item));
}
