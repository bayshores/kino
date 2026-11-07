import { lottieShadowTracks } from "./lottie-shadow.mjs";
import { shadowAlpha } from "../engine/shadowInterpolation.js";

const positive = (value) => Math.max(0, Number(value) || 0);

export function effectPadding(state) {
  const shadow = state.shadow;
  return positive(state.blur) + (shadow && shadowAlpha(shadow.color) > 0
    ? Math.hypot(Number(shadow.x) || 0, Number(shadow.y) || 0) + 2 * positive(shadow.blur)
    : 0);
}

/** Native SVG-player effects; values use Lottie's documented effect units. */
export function lottieEffects(states, { property, colorToRgba }) {
  const effects = [];
  // One sample per frame; see lottie-shadow.mjs for how x/y, "no shadow" and wraparound map.
  const shadow = states.some((state) => state.shadow && shadowAlpha(state.shadow.color) > 0)
    ? lottieShadowTracks(states.map((state) => state.shadow ?? null), colorToRgba) : null;
  if (shadow) {
    effects.push({ ty: 25, ef: [
      { ty: 2, nm: "Shadow Color", v: property(shadow.color, 3) },
      { ty: 0, nm: "Opacity", v: property(shadow.opacity) },
      { ty: 1, nm: "Direction", v: property(shadow.direction) },
      { ty: 0, nm: "Distance", v: property(shadow.distance) },
      { ty: 0, nm: "Softness", v: property(shadow.softness) },
    ] });
  }
  if (states.some((state) => positive(state.blur))) {
    effects.push({ ty: 29, ef: [
      { ty: 0, nm: "", v: property(states.map((state) => positive(state.blur) * 5 / 3)) },
      { ty: 7, nm: "", v: { a: 0, k: 1 } },
      { ty: 7, nm: "", v: { a: 0, k: 0 } },
    ] });
  }
  return effects;
}

export function transparentEffectBounds(width, height, frameCount, nextIndex) {
  return {
    ty: 4, ind: nextIndex(), nm: "Effect bounds", ip: 0, op: frameCount, st: 0,
    ks: { a: { a: 0, k: [0, 0, 0] }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    shapes: [
      { ty: "rc", p: { a: 0, k: [width / 2, height / 2] }, s: { a: 0, k: [width, height] }, r: { a: 0, k: 0 } },
      { ty: "fl", c: { a: 0, k: [0, 0, 0] }, o: { a: 0, k: 0 } },
    ],
  };
}
