// Resize animations: an animation of a layer's width and height with an anchor point (the
// Animate tab's Resize preset; see animation.js evaluateLayer).
//
// How a layer box is placed (render.js transformFor): x and y are the box's top-left corner
// before its own rotation, scale and skew, and those turn the box around its middle. So changing
// only the width keeps x and y and moves the middle: the box grows to the right and down, and on
// a rotated layer it also drifts. A Resize with an `anchor` moves x and y as well, so that one
// point of the box stays on the same spot of the canvas while the size changes:
//
//   top-left     top     top-right
//   left        center       right
//   bottom-left  bottom  bottom-right
//
// The math. A point of the box at fraction (u, v) of its width and height (u = 0 is the left
// edge, v = 0 the top edge) is drawn at
//   (x + w/2, y + h/2) + L · ((u - 0.5) · w, (v - 0.5) · h)
// where L is the layer's rotation × scale × skew (the same matrix as geometry.js layerMatrix).
// When the size changes by (dw, dh), the point stays put when x and y move by
//   -(dw/2, dh/2) - L · ((u - 0.5) · dw, (v - 0.5) · dh)
// (resizeAnchorShift). With no rotation and a scale of 1 that is 0 for the top-left corner,
// -(dw/2, dh/2) for the center and -(dw, dh) for the bottom-right corner.
//
// An animation without an anchor (one written before anchors existed, or by an MCP client that
// leaves it out) keeps the older rule: x and y stay where they are.

/** The nine anchor points, in the order of the Anchor point menu (Center first). */
export const RESIZE_ANCHORS = Object.freeze([
  Object.freeze({ id: "center", label: "Center", u: 0.5, v: 0.5 }),
  Object.freeze({ id: "top-left", label: "Top-Left", u: 0, v: 0 }),
  Object.freeze({ id: "top", label: "Top", u: 0.5, v: 0 }),
  Object.freeze({ id: "top-right", label: "Top-Right", u: 1, v: 0 }),
  Object.freeze({ id: "right", label: "Right", u: 1, v: 0.5 }),
  Object.freeze({ id: "bottom-right", label: "Bottom-Right", u: 1, v: 1 }),
  Object.freeze({ id: "bottom", label: "Bottom", u: 0.5, v: 1 }),
  Object.freeze({ id: "bottom-left", label: "Bottom-Left", u: 0, v: 1 }),
  Object.freeze({ id: "left", label: "Left", u: 0, v: 0.5 }),
]);

/** The anchor a new Resize gets. */
export const DEFAULT_RESIZE_ANCHOR = "center";

const ANCHOR_BY_ID = new Map(RESIZE_ANCHORS.map((anchor) => [anchor.id, anchor]));

/** True when `id` is one of the nine anchor names. */
export function isResizeAnchor(id) {
  return typeof id === "string" && ANCHOR_BY_ID.has(id);
}

/** The text listing the anchor names, for error messages. */
export const RESIZE_ANCHOR_LIST = RESIZE_ANCHORS.map((anchor) => anchor.id).join(", ");

function endpointHas(animation, key) {
  return ["from", "to"].some((side) => {
    const values = animation?.[side];
    return values !== null && typeof values === "object" && !Array.isArray(values) && Object.hasOwn(values, key);
  });
}

/** True when an animation changes the width or the height (a Resize). */
export function isResizeAnimation(animation) {
  return endpointHas(animation, "width") || endpointHas(animation, "height");
}

/**
 * Which sides of `layer` a Resize can change: { width, height }. Text that sizes itself follows
 * textLayout.js: Auto width ("width-height") text sets both sides from its words, and Auto height
 * ("height") text sets its height from the lines that fit its width, so only the width is free.
 * Groups, audio and component instances have no free side (see resizeProblem).
 */
export function resizableSides(layer) {
  if (!layer || ["group", "audio", "component"].includes(layer.type)) return { width: false, height: false };
  if (layer.type === "text" && layer.textResize === "width-height") return { width: false, height: false };
  if (layer.type === "text" && layer.textResize === "height") return { width: true, height: false };
  return { width: true, height: true };
}

/**
 * Why `animation` can't resize `layer`, or null when it can (or doesn't change the size).
 * operations.js refuses an MCP add_animation or update_animation with this message, the
 * clipboard skips such a layer when pasting, and the Inspector shows it instead of the fields.
 */
export function resizeProblem(layer, animation) {
  if (!isResizeAnimation(animation)) return null;
  const name = `${layer?.type ?? "unknown"} layer ${layer?.id ?? ""}`.trim();
  if (layer?.type === "group")
    return `A Resize (width or height) animation can't be added to ${name}: resizing a group resizes the layers inside it (Design tab), which an animation does not do. Animate the size of the layers inside the group instead.`;
  if (layer?.type === "audio") return `A Resize (width or height) animation needs a layer that is drawn; ${name} has no size on the canvas.`;
  if (layer?.type === "component")
    return `A Resize (width or height) animation can't be added to ${name}: a component instance takes its main component's size. Use a Scale animation instead.`;
  const sides = resizableSides(layer);
  if (!sides.width && !sides.height)
    return `A Resize (width or height) animation can't change ${name}: the text sizes itself (Text resize: Auto width), so an animated size would not be drawn. Set its textResize to "height" (Auto height) or "fixed" first.`;
  if (!sides.height && endpointHas(animation, "height"))
    return `A Resize animation can change only the width of ${name}: the text sets its own height from its lines (Text resize: Auto height). Leave height out, or set its textResize to "fixed".`;
  return null;
}

// The parts of an animation that make it a Resize: its width and height ends and its anchor.
function resizeParts(animation) {
  const end = (side) => {
    const values = animation?.[side];
    return values !== null && typeof values === "object" && !Array.isArray(values)
      ? { width: values.width, height: values.height }
      : {};
  };
  return JSON.stringify([end("from"), end("to"), animation?.anchor ?? null]);
}

/**
 * Why an edit that turned animation `before` into `after` can't be made on `layer`, or null.
 * Like resizeProblem, but only when the edit changes a width or height end or the anchor. An
 * older size animation that resizeProblem would refuse today (a group's reveal wipe saved
 * before Resize refused groups, for example) still loads and plays, so its name, timing and
 * easing can still change; only new sizes are refused. operations.js update_animation(s) uses it.
 */
export function resizeEditProblem(layer, before, after) {
  return resizeParts(before) === resizeParts(after) ? null : resizeProblem(layer, after);
}

function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * How far x and y move so that `anchor` stays on the same spot when the box's size changes by
 * `change` ({ width: dw, height: dh }, in pixels). `transform` is the layer's { rotation (degrees),
 * scaleX, scaleY, skewX, skewY (degrees), anchor? ([x%, y%] pivot, default center) }. Returns
 * { x, y }. An unknown anchor moves nothing.
 */
export function resizeAnchorShift(anchor, change, transform = {}) {
  const point = ANCHOR_BY_ID.get(anchor);
  const dw = finiteOr(change?.width, 0);
  const dh = finiteOr(change?.height, 0);
  if (!point || (dw === 0 && dh === 0)) return { x: 0, y: 0 };
  const rotation = (finiteOr(transform.rotation, 0) * Math.PI) / 180;
  const sx = finiteOr(transform.scaleX, 1);
  const sy = finiteOr(transform.scaleY, 1);
  const shear = Math.tan((finiteOr(transform.skewX, 0) * Math.PI) / 180);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // L = rotate · scale · skewX, as in render.js transformFor and geometry.js layerMatrix.
  let a = cos * sx;
  let b = sin * sx;
  const c = cos * sx * shear - sin * sy;
  const d = sin * sx * shear + cos * sy;
  const shearY = Math.tan((finiteOr(transform.skewY, 0) * Math.PI) / 180);
  if (shearY) { a += c * shearY; b += d * shearY; }
  // The pivot is a share of the box too, so it moves by that share of the change.
  const [pu, pv] = Array.isArray(transform.anchor) ? [transform.anchor[0] / 100, transform.anchor[1] / 100] : [0.5, 0.5];
  const px = (point.u - pu) * dw;
  const py = (point.v - pv) * dh;
  return {
    x: -pu * dw - (a * px + c * py) + 0,
    y: -pv * dh - (b * px + d * py) + 0,
  };
}

const MAX_SIZE = 65_536; // model.js MAX_DIMENSION

function grown(value) {
  const larger = Math.round(value * 1.5 * 100) / 100;
  return larger <= MAX_SIZE ? larger : Math.round(value * 0.5 * 100) / 100;
}

/**
 * The From and To values of a new Resize on `layer`: From is the layer's current size and To
 * is 1.5 times it (half of it when that would pass the largest size), so the change is easy to
 * see and keeps the layer's proportions. Only the sides resizableSides allows are included.
 * Throws a TypeError with resizeProblem's message when the layer can't be resized.
 */
export function resizePresetValues(layer) {
  const sides = resizableSides(layer);
  if (!sides.width && !sides.height) throw new TypeError(resizeProblem(layer, { to: { width: 0 } }));
  const from = {};
  const to = {};
  for (const key of ["width", "height"]) {
    if (!sides[key]) continue;
    const value = Math.max(0, finiteOr(layer[key], 0));
    from[key] = value;
    to[key] = grown(value);
  }
  return { from, to };
}
