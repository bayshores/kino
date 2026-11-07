import { isRecord } from "./numbers.js";

const finiteNumber = (value) => Number.isFinite(value) ? value : 0;

/** Use the local box for collapsed centerline axes; retain other path coordinates and origins. */
export function pathGradientBounds(bounds, localBox) {
  return {
    x: bounds.width > 0 ? bounds.x : finiteNumber(localBox.x),
    y: bounds.height > 0 ? bounds.y : finiteNumber(localBox.y),
    width: bounds.width > 0 ? bounds.width : finiteNumber(localBox.width),
    height: bounds.height > 0 ? bounds.height : finiteNumber(localBox.height),
  };
}

/** Return absolute endpoints for a gradient inside its final layer-space bounds. */
export function gradientCoordinates(paint, bounds = {}) {
  if (!paint || !["linear", "radial"].includes(paint.type)) {
    throw new TypeError("Gradient coordinates require a linear or radial paint.");
  }

  const x = finiteNumber(bounds.x);
  const y = finiteNumber(bounds.y);
  const width = finiteNumber(bounds.width);
  const height = finiteNumber(bounds.height);
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  if (paint.type === "radial") {
    return {
      start: [centerX, centerY],
      end: [centerX, centerY - width / 2],
    };
  }

  const angle = finiteNumber(paint.angle) * Math.PI / 180;
  // The direction is an angle in local layer coordinates. Extend the line from the center
  // until it meets the box: on a square, 45° reaches the corners (not points inside the box).
  const cos = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle);
  const sin = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle);
  const distance = Math.min(
    cos === 0 ? Infinity : Math.abs(width / (2 * cos)),
    sin === 0 ? Infinity : Math.abs(height / (2 * sin)),
  );
  const dx = cos * distance;
  const dy = sin * distance;
  return {
    start: [centerX - dx, centerY - dy],
    end: [centerX + dx, centerY + dy],
  };
}

// Turning a layer's Fill off (the Design tab's "Enable fill" box, or fillEnabled: false through
// apply_operations) keeps its paint in `fill`, so turning it back on shows the same color,
// gradient, and alpha. Only drawing and exports read the flag: the SVG renderer (canvas, PNG,
// GIF, and video) paints "none" and the Lottie exporter adds no fill item when
// isFillEnabled() is false. Fill animations still change the stored paint while the fill is off,
// but nothing is drawn until it is turned back on.

/** Layer types that draw a Fill: the Design tab's Fill section and the Color animation. */
export const FILL_LAYER_TYPES = Object.freeze(["rectangle", "ellipse", "star", "path", "text", "group"]);

/**
 * Why `layer` can't hold a Color (fill) animation, or null when it can. apply_operations
 * (operations.js) refuses a new or changed fill animation with this text, through
 * fillAnimationProblem and fillAnimationEditProblem below (animationListCheck.js runs them on a
 * whole list).
 */
export function fillAnimationLayerProblem(layer) {
  if (FILL_LAYER_TYPES.includes(layer?.type)) return null;
  return `A Color (fill) animation needs a ${FILL_LAYER_TYPES.join(", ")} layer; ${layer?.type} layer ${layer?.id} has no Fill.`;
}

/** True when an animation changes a Fill: `fill` is in its from values, its to values, or both. */
export function animatesFill(animation) {
  return ["from", "to"].some((side) => isRecord(animation?.[side]) && Object.hasOwn(animation[side], "fill"));
}

/** Why `animation` can't be on `layer` because it animates a Fill the layer doesn't have, or null. */
export function fillAnimationProblem(layer, animation) {
  return animatesFill(animation) ? fillAnimationLayerProblem(layer) : null;
}

// The Fill ends of an animation (from.fill and to.fill), as text to compare two versions of it.
function fillParts(animation) {
  const end = (side) => (isRecord(animation?.[side]) && Object.hasOwn(animation[side], "fill") ? animation[side].fill : null);
  return JSON.stringify([end("from"), end("to")]);
}

/**
 * Why an edit that turned animation `before` into `after` can't be made on `layer`, or null.
 * Like fillAnimationProblem, but only when the edit adds or changes a Fill end (`before` is
 * undefined for a new animation). Older documents could hold a Color animation on an image,
 * video, audio or component instance: it still opens and plays (it draws nothing, as
 * the layer has no Fill), and its name, timing and easing can still change. Only new fill values
 * are refused. operations.js update_animation(s) uses it, like resizeEditProblem for a Resize.
 */
export function fillAnimationEditProblem(layer, before, after) {
  return fillParts(before) === fillParts(after) ? null : fillAnimationProblem(layer, after);
}

/** True unless the layer's Fill is turned off. Layers saved before the toggle have it on. */
export function isFillEnabled(layer) {
  return layer?.fillEnabled !== false;
}

/** A layer state ready to export: its `fill` is null (no fill) when the Fill is turned off. */
export function withVisibleFill(state) {
  return isFillEnabled(state) ? state : { ...state, fill: null };
}
