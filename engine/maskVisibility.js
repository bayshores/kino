// When a mask layer is switched off, so it masks nothing.
//
// A mask layer whose eye button is off masks nothing: the layer it masks (or, in a mask group,
// every layer above it) is drawn whole, as if there were no mask. A Hide operation works the same
// way: from the Hide until a Show, the mask is switched off and the masked layers show whole.
// (Without this rule a hidden mask would be an empty mask, which hides everything it masks.)
//
// Hide and Show are judged at the mask layer's own clock time, as evaluateLayer does, so a
// mask inside a component follows the component's timing. Other reasons a layer is not drawn
// (outside its component's range, or media outside its Play range) are left as they were.
//
// The data flow: render.js (the preview and PNG, GIF and video exports) and the Lottie export
// (backend/export.mjs) ask maskSwitchedOff for each mask layer before they use it as a mask.
import { resolvePlayback } from "./playback.js";
import { visibleByOperations } from "./visibilityOps.js";

/**
 * True when the mask layer masks nothing at `time` seconds: its eye button is off, or a Hide
 * operation (with no Show after it yet) hides it then. `design` is the editing view, which
 * ignores Hide and Show, as it ignores animations.
 */
export function maskSwitchedOff(layer, time, design = false) {
  if (!layer || layer.visible === false) return true;
  if (design) return false;
  return !visibleByOperations(Array.isArray(layer.animations) ? layer.animations : [], resolvePlayback(layer, time).time);
}
