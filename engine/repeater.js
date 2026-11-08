// A repeater: a shape, path, text or group layer drawn as several copies, each moved, turned and
// scaled from the one before (a ring of dots, radial rays, a row of bars, a burst).
//
// Fields on the layer (all animatable; absent means no repeater, the layer draws as before):
//   repeatCopies         1..64 copies, the original included (1). A fraction fades the last copy in.
//   repeatX, repeatY     px each copy moves from the one before, in the layer's own axes (0)
//   repeatRotation       degrees each copy turns from the one before (0)
//   repeatScale          size of each copy against the one before, 1 = same (1)
//   repeatAnchorX, Y     the point copies turn and scale around, px from the layer's center (0)
//   repeatStartOpacity   opacity of the first copy, 0..1 (1)
//   repeatEndOpacity     opacity of the last copy, 0..1 (1); copies between go evenly
// Copy n is the step transform applied n times; later copies draw above earlier ones. The copies
// sit inside the layer, so the layer's own move, turn, effects and mask apply to all of them.
import { multiply } from "./geometry.js";
import { mappedBounds, mergeBounds } from "./effectBounds.js";

export const REPEAT_LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path", "text", "group"]);
export const REPEAT_MAX_COPIES = 64;
export const REPEAT_REST = Object.freeze({
  repeatCopies: 1, repeatX: 0, repeatY: 0, repeatRotation: 0, repeatScale: 1,
  repeatAnchorX: 0, repeatAnchorY: 0, repeatStartOpacity: 1, repeatEndOpacity: 1,
});
export const REPEAT_KEYS = Object.keys(REPEAT_REST);
export const REPEAT_FRACTION_KEYS = ["repeatScale", "repeatStartOpacity", "repeatEndOpacity"];
const RANGES = {
  repeatCopies: [1, REPEAT_MAX_COPIES], repeatX: [-100_000, 100_000], repeatY: [-100_000, 100_000],
  repeatRotation: [-3_600, 3_600], repeatScale: [0, 10], repeatAnchorX: [-100_000, 100_000],
  repeatAnchorY: [-100_000, 100_000], repeatStartOpacity: [0, 1], repeatEndOpacity: [0, 1],
};

/** The range a repeater field accepts: [min, max]. */
export const repeatRange = (key) => RANGES[key];

const finite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const clamp = (value, [min, max]) => Math.max(min, Math.min(max, value));

/** The repeater of a layer state, or null when it draws one copy. */
export function repeaterOf(state = {}) {
  if (!REPEAT_LAYER_TYPES.has(state.type)) return null;
  const value = (key) => clamp(finite(state[key], REPEAT_REST[key]), RANGES[key]);
  const copies = value("repeatCopies");
  if (!(copies > 1)) return null;
  const count = Math.ceil(copies - 1e-9);
  const width = finite(state.width, 0), height = finite(state.height, 0);
  const px = width / 2 + value("repeatAnchorX"), py = height / 2 + value("repeatAnchorY");
  const angle = (value("repeatRotation") * Math.PI) / 180, scale = value("repeatScale");
  const cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale;
  // translate(x y) translate(p) rotate scale translate(-p)
  const step = [cos, sin, -sin, cos, value("repeatX") + px - cos * px + sin * py, value("repeatY") + py - sin * px - cos * py];
  const start = value("repeatStartOpacity"), end = value("repeatEndOpacity");
  const last = copies - (count - 1);
  const copiesList = [];
  let matrix = [1, 0, 0, 1, 0, 0];
  for (let index = 0; index < count; index += 1) {
    const share = count > 1 ? index / (count - 1) : 0;
    const opacity = (start + (end - start) * share) * (index === count - 1 ? last : 1);
    copiesList.push({ matrix, opacity });
    matrix = multiply(matrix, step);
  }
  return { count, copies: copiesList };
}

/** Bounds (local units) of the copies of `bounds`. */
export function repeatBounds(bounds, state) {
  const repeater = bounds && repeaterOf(state);
  if (!repeater) return bounds;
  return mergeBounds(repeater.copies.map(({ matrix }) => mappedBounds(bounds, matrix)));
}

const fmt = (value) => String(Math.round(value * 10_000) / 10_000);

/** The markup of `content` drawn once per copy; `id` names the first copy for the others' <use>. */
export function repeatMarkup(content, state, id) {
  const repeater = repeaterOf(state);
  if (!repeater) return content;
  return repeater.copies.map(({ matrix, opacity }, index) => {
    const alpha = opacity < 1 ? ` opacity="${fmt(Math.max(0, opacity))}"` : "";
    if (index === 0) return `<g data-repeat-copy="0"${alpha}><g id="${id}">${content}</g></g>`;
    return `<use href="#${id}" data-repeat-copy="${index}" transform="matrix(${matrix.map(fmt).join(" ")})"${alpha}/>`;
  }).join("");
}
