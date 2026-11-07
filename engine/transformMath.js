// Resize math shared by multi_transform and the size fields: which point of a box stays put,
// the new box after a resize, and where to place it. Every function here is pure.
//
// - resizeBox() works out the new width and height: the moved corner or edge follows dx, dy;
//   fromCenter keeps the center put; keepAspect changes width and height by the same ratio.
// - fixedPoint() says which point stays put, and placeResized() works out the x and y that
//   keep that point where it was.
// - sizeFieldPatch() is the change for typing a width or height, keeping the aspect ratio when
//   the layer's lock is on.

import { layerMatrix, point } from "./geometry.js";

export const MAX_SIZE = 65_536;
/** The smallest width or height a resize gives a layer, in pixels. */
const MIN_DRAG_SIZE = 1;
/** The smallest width or height the Inspector accepts (model.js). */
const MIN_FIELD_SIZE = 0.001;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isSign = (value) => value === -1 || value === 0 || value === 1;
const positive = (value) => Number.isFinite(value) && value > 0;

function requireBox(box) {
  if (!box || !positive(box.width) || !positive(box.height)) {
    throw new RangeError("A layer needs a positive width and height to resize.");
  }
}

function requireHandle(h, v) {
  if (!isSign(h) || !isSign(v) || (h === 0 && v === 0)) {
    throw new TypeError("A handle is a corner or an edge: h and v are -1, 0 or 1, not both 0.");
  }
}

/**
 * Which point of the layer's box stays put while handle (h, v) is dragged, as fractions
 * { u, v } of its width and height (0 is the left or top side, 1 the right or bottom side).
 * h is -1 for a handle on the left side, 1 on the right and 0 for the top or bottom edge;
 * v is the same from top to bottom. The side opposite the handle stays put. With fromCenter,
 * the center does. On an edge handle, the other direction keeps its center when the size
 * changes that way too (keepAspect), and its top or left side otherwise (so auto-height text
 * grows downward).
 */
export function fixedPoint(h, v, { fromCenter = false, keepAspect = false } = {}) {
  requireHandle(h, v);
  const fraction = (sign) => {
    if (fromCenter) return 0.5;
    if (sign > 0) return 0;
    if (sign < 0) return 1;
    return keepAspect ? 0.5 : 0;
  };
  return { u: fraction(h), v: fraction(v) };
}

/**
 * The new { width, height } when handle (h, v) of a box of `start` size is dragged by
 * (dx, dy), measured in the box's own units. See the steps at the top of this file. A size
 * never goes below `min` (or below the start size, when that is smaller) or above `max`; with
 * keepAspect, both sides stop together so the proportions stay.
 */
export function resizeBox(start, { dx = 0, dy = 0, h, v, keepAspect = false, fromCenter = false, min = MIN_DRAG_SIZE, max = MAX_SIZE } = {}) {
  requireBox(start);
  requireHandle(h, v);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError("The resize distance must be finite.");
  const stretch = fromCenter ? 2 : 1;
  const width = h ? start.width + stretch * h * dx : start.width;
  const height = v ? start.height + stretch * v * dy : start.height;
  const minWidth = Math.min(min, start.width),
    minHeight = Math.min(min, start.height);
  if (!keepAspect) {
    return { width: clamp(width, minWidth, max), height: clamp(height, minHeight, max) };
  }
  const across = width / start.width,
    down = height / start.height;
  // An edge handle follows its own direction; a corner follows the side that moved most.
  let ratio = !v ? across : !h ? down : Math.abs(across - 1) >= Math.abs(down - 1) ? across : down;
  const lowest = Math.max(minWidth / start.width, minHeight / start.height);
  const highest = Math.max(lowest, Math.min(max / start.width, max / start.height));
  ratio = clamp(ratio, lowest, highest);
  return { width: start.width * ratio, height: start.height * ratio };
}

/**
 * The { x, y } that keep the fixed point `fixed` (from fixedPoint) of the layer where it was
 * when the drag began. `start` is the layer then; `next` is the layer with its new width and
 * height (its rotation, scale and skew are used as they are in `next`).
 */
export function placeResized(start, next, fixed) {
  const before = point(layerMatrix(start), fixed.u * start.width, fixed.v * start.height);
  const offset = point(layerMatrix({ ...next, x: 0, y: 0 }), fixed.u * next.width, fixed.v * next.height);
  return { x: before.x - offset.x, y: before.y - offset.y };
}

/**
 * The Inspector's change for typing `value` into the Width (`key` "width") or Height
 * ("height") field. With the layer's aspect-ratio lock on, the other side changes by the same
 * ratio, and both stay within `min` and `max`. Otherwise only the typed side changes.
 */
export function sizeFieldPatch(layer, key, value, { min = MIN_FIELD_SIZE, max = MAX_SIZE } = {}) {
  if (key !== "width" && key !== "height") throw new TypeError("sizeFieldPatch changes width or height.");
  if (!layer?.lockAspect || !positive(layer.width) || !positive(layer.height) || !Number.isFinite(value)) {
    return { [key]: value };
  }
  const other = key === "width" ? "height" : "width";
  // How many pixels of the other side go with one pixel of this side.
  const ratio = layer[other] / layer[key];
  let edited = clamp(value, min, max);
  let derived = edited * ratio;
  if (derived < min) {
    derived = min;
    edited = clamp(min / ratio, min, max);
  } else if (derived > max) {
    derived = max;
    edited = clamp(max / ratio, min, max);
  }
  return { [key]: edited, [other]: Math.round(derived * 1e6) / 1e6 };
}
