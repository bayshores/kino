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
