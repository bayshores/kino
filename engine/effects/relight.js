// Helpers for grades that relight instead of tint (duotone, tritone, the section-grade look):
// normalize (stretch the layer's own luma range to 0..1 before the colors are mapped) and keep
// (one hue range, skin by default, stays partly in its own color inside the grade).
//
// Why: in the technique studies a one-hue grade turned a face into one flat tone (olive face in
// .scratch/studies/streak-field r3 to r5, a blue wash over face and wall in type-on-feature),
// while the human edits keep a lit face, a scarf's own color and bright eyes inside the hue.
import { LUMA, hueAngle } from "./colorMath.js";
import { smoothstep } from "../numbers.js";

const clamp01 = (value) => Math.min(1, Math.max(0, value));
export const luma = ([r, g, b]) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;

/**
 * The layer's measured luma levels [low, high] (its 2nd and 98th percentile), or null when
 * normalize is off or nothing was measured. The renderer measures them once per layer over the
 * whole clip (backend/export.mjs layerLevels), so the mapping holds still from frame to frame;
 * the live preview and shapes have none and draw without normalizing.
 */
export function levelsFor(frame) {
  if (frame?.parameters?.normalize === false) return null;
  const levels = frame?.helpers?.levels;
  if (!Array.isArray(levels) || levels.length !== 2 || !levels.every(Number.isFinite)) return null;
  const [low, high] = levels;
  // A nearly flat picture (a solid card) is left alone rather than blown up.
  return high - low >= 0.04 ? [clamp01(low), clamp01(high)] : null;
}

/** Luma `value` 0..1 through levels [low, high] (identity without levels). */
export function normalizeLuma(value, levels) {
  if (!levels) return value;
  return clamp01((value - levels[0]) / (levels[1] - levels[0]));
}

// Named keep ranges on kino's color wheel (colorMath.js hueAngle: red 0, yellow 60). Skin: guess
// from common skin and drawn-skin tones (peach #F2C3A0 is about 26, tan #C68642 about 31, rosy
// #E8A090 about 10), centered at 24 with 22 degrees each side.
export const KEEP_RANGES = Object.freeze({ skin: Object.freeze({ hue: 24, range: 22 }) });
export const KEEP_NAMES = Object.freeze(["none", "skin", "color"]);

/** The keep fields every relighting grade takes (catalog fields built with `number`, `color`). */
export function keepFields(number, color, { keep = "none" } = {}) {
  return {
    keep: { type: "enum", label: "Keep", default: keep, options: [["none", "None"], ["skin", "Skin"], ["color", "Keep Color"]] },
    keepColor: color("Keep Color", "#E0A080"),
    // 0: the named range's own width (skin 22). Degrees to each side of the hue.
    keepRange: number("Keep Range", 0, 0, 90, 1, "°"),
    // Guess: 0.6 leaves the face clearly inside the grade's hue but no longer one flat tone.
    keepAmount: number("Keep Amount", 0.6, 0, 1, 0.01),
  };
}

/** {hue, range, amount} for the keep fields of `parameters`, or null when nothing is kept. */
export function keepOf(parameters, hexToRgb) {
  const keep = parameters?.keep;
  const amount = Number.isFinite(parameters?.keepAmount) ? clamp01(parameters.keepAmount) : 0.6;
  if (keep !== "skin" && keep !== "color" || amount === 0) return null;
  const named = keep === "skin" ? KEEP_RANGES.skin : { hue: hueAngle(hexToRgb(parameters.keepColor ?? "#E0A080")), range: 22 };
  const range = Number.isFinite(parameters?.keepRange) && parameters.keepRange > 0 ? parameters.keepRange : named.range;
  return { hue: Number(named.hue.toFixed(2)), range, amount };
}

/** How much of `rgb` (0..1) stays in its own color: 0..amount, soft at the hue edges, 0 for grays. */
export function keepWeight(rgb, keep) {
  if (!keep) return 0;
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  if (chroma < 0.01) return 0;
  let distance = Math.abs(hueAngle(rgb) - keep.hue) % 360;
  if (distance > 180) distance = 360 - distance;
  // 12 degrees of fade past the range (keep-color's default softness is 15; guess).
  const inside = 1 - smoothstep((distance - keep.range) / 12);
  // Pale colors count less, so a white wall with a warm cast is not kept (guess: full at 0.12).
  return keep.amount * inside * smoothstep(chroma / 0.12);
}

/**
 * The graded color mixed with the source color by keep. The kept color is the source moved to
 * the normalized brightness (hue and chroma kept), so a kept face is lit like the rest.
 */
export function withKeep(source, graded, keep, normalized) {
  const weight = keepWeight(source, keep);
  if (!weight) return graded;
  const shift = normalized - luma(source);
  return graded.map((value, channel) => clamp01(value + weight * (clamp01(source[channel] + shift) - value)));
}

export function hexRgb01(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!match) return [0, 0, 0];
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255);
}
