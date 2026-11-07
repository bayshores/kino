// How a Shadow animation mixes one drop shadow into another.
//
// A drop shadow is { color, x, y, blur }, the same value as a layer's `shadow` (engine/schema.js):
// a hex color whose alpha is the shadow's opacity, the offset in pixels (x to the right, y down),
// and the blur in pixels. `null` means no shadow. animation.js calls
// interpolateShadow(from, to, progress) for the `shadow` key, and the editor canvas and every
// export draw the shadow it returns: engine/render.js for the canvas, PNG, GIF, video and PNG
// sequence, and backend/lottie-shadow.mjs for Lottie's Drop Shadow effect.
//
// The rules:
// - Two shadows: the color mixes like a solid fill does in a Color animation (red, green, blue
//   and alpha each move in a straight line, in sRGB without premultiplied alpha; see mixHexColor
//   in paintInterpolation.js), and x, y and blur each move in a straight line.
// - A shadow and no shadow: "no shadow" acts as the same shadow with 0 alpha (see
//   transparentShadow), so the shadow fades in or out in place without moving, growing or
//   changing color.
// - No shadow at both ends: no shadow at every time.
// - At progress 0 the result is a copy of `from` and at 1 a copy of `to`, so a "no shadow" end
//   is exactly no shadow. Easings that overshoot (Elastic, Overshoot) extrapolate x, y and blur;
//   color channels and alpha stay within 0..255 and blur never goes below 0.

import { formatHexColor, isSolidPaint, mixHexColor, parseHexColor } from "./paintInterpolation.js";

/** The shadow the Design tab's Drop shadow box turns on, and a new Shadow animation's To on a layer without one. */
export const DEFAULT_SHADOW = Object.freeze({ color: "#000000", x: 0, y: 4, blur: 12 });

/**
 * The largest shadow a document may store: x and y from -offset to offset px, blur from 0 to
 * blur px. engine/model.js refuses anything outside these, so the preset below and the Inspector's
 * Shadow fields use the same numbers.
 */
export const SHADOW_LIMITS = Object.freeze({ offset: 1_000_000, blur: 10_000 });

const finite = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mixNumber = (from, to, progress) => from + (to - from) * progress;

/** True for a shadow object ({ color, x, y, blur }); false for null and anything else. */
function isShadow(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof value.color === "string");
}

/** A plain copy of a shadow with only its four parts, or null when `value` is not a shadow. */
export function copyShadow(value) {
  if (!isShadow(value)) return null;
  return { color: value.color, x: finite(value.x), y: finite(value.y), blur: Math.max(0, finite(value.blur)) };
}

/** The same shadow with 0 alpha: what "no shadow" means next to `shadow` in an animation. */
export function transparentShadow(shadow) {
  const copy = copyShadow(shadow);
  if (!copy) return null;
  const parsed = parseHexColor(copy.color);
  return { ...copy, color: formatHexColor([...(parsed ? parsed.rgba.slice(0, 3) : [0, 0, 0]), 0], true) };
}

/**
 * The shadow between `from` (progress 0) and `to` (progress 1); either may be null (no shadow).
 * See the rules at the top of this file.
 */
export function interpolateShadow(from, to, progress) {
  const a = copyShadow(from);
  const b = copyShadow(to);
  if (!a && !b) return null;
  if (progress === 0) return a;
  if (progress === 1) return b;
  const start = a ?? transparentShadow(b);
  const end = b ?? transparentShadow(a);
  // Colors that are not hex (older files) do not mix: the From color is kept until the end.
  const color = mixHexColor(start.color, end.color, progress) ?? (progress >= 1 ? end.color : start.color);
  return {
    color,
    x: mixNumber(start.x, end.x, progress),
    y: mixNumber(start.y, end.y, progress),
    blur: Math.max(0, mixNumber(start.blur, end.blur, progress)),
  };
}

/** A shadow color's alpha from 0 to 1 (1 for a color written without alpha). */
export function shadowAlpha(color) {
  const parsed = parseHexColor(color);
  return parsed ? parsed.rgba[3] / 255 : 1;
}

/** `color` with its alpha set to `alpha` (0 to 1). Full alpha is written as #rrggbb. */
export function withShadowAlpha(color, alpha) {
  const parsed = parseHexColor(isSolidPaint(color) ? color : "#000000");
  const value = Math.max(0, Math.min(1, finite(alpha, 1)));
  return value >= 1
    ? formatHexColor(parsed.rgba, false)
    : formatHexColor([...parsed.rgba.slice(0, 3), value * 255], true);
}

/**
 * The From and To shadows of a new Shadow animation on a layer whose shadow is `layerShadow`.
 * From is the layer's own shadow (or no shadow), so the animation starts where the layer is.
 * To lifts the layer: an existing shadow keeps its color and doubles its offset and blur (a
 * shadow with no offset and no blur gets the default offset and blur), and a layer without a
 * shadow gets the Design tab's default shadow, so the shadow appears. A doubled value stops at
 * SHADOW_LIMITS, so a very large shadow still gives a To the document can save.
 */
export function shadowPresetValues(layerShadow) {
  const from = copyShadow(layerShadow);
  if (!from) return { from: null, to: { ...DEFAULT_SHADOW } };
  const flat = from.x === 0 && from.y === 0 && from.blur === 0;
  const { offset, blur } = SHADOW_LIMITS;
  const to = flat
    ? { color: from.color, x: DEFAULT_SHADOW.x, y: DEFAULT_SHADOW.y, blur: DEFAULT_SHADOW.blur }
    : {
        color: from.color,
        x: clamp(from.x * 2, -offset, offset),
        y: clamp(from.y * 2, -offset, offset),
        blur: clamp(from.blur * 2, 0, blur),
      };
  return { from, to };
}
