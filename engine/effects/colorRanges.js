// The color-ranges effect: hue, saturation and lightness for 8 hue ranges, plus highlights and
// shadows, drawn as a generated LUT (colorGrading.js renderFunctionLut). All 0 changes nothing.
import { renderFunctionLut } from "./colorGrading.js";
import { numberParameter } from "./periodicDisplacement.js";
import { LUMA } from "./colorMath.js";
import { smoothstep } from "../numbers.js";

// Each range's center on the HSV hue wheel (degrees). A hue between two centers takes a smooth
// blend of both ranges' settings, so every hue belongs to its two nearest ranges.
export const COLOR_RANGES = Object.freeze([
  ["red", 0], ["orange", 30], ["yellow", 60], ["green", 120], ["aqua", 180], ["blue", 240], ["purple", 270], ["magenta", 300],
].map(([name, hue]) => Object.freeze({ name, hue })));
// Chroma (max - min of r, g, b) below GATE_LOW is left alone and above GATE_HIGH gets the full
// change, so greys stay grey. GATE_LOW is past one 17-point LUT step (1/16), so the lattice
// corners next to a grey are untouched too and greys draw exactly.
const GATE_LOW = 0.07;
const GATE_HIGH = 0.25;
// Highlights and shadows move luma by at most this share of their bump (keeps the curve rising).
const TONE = 0.7;

const luma = ([r, g, b]) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;

function hueOf(r, g, b, max, chroma) {
  const hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  return (hue * 60 + 360) % 360;
}

function fromHsv(hue, saturation, value) {
  const at = (n) => {
    const k = (n + hue / 60) % 6;
    return value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [at(5), at(3), at(1)];
}

/** Each range's weight (0..1, summing to 1) for a hue in degrees. */
export function rangeWeights(hue) {
  const weights = new Array(COLOR_RANGES.length).fill(0);
  const h = ((hue % 360) + 360) % 360;
  for (let index = 0; index < COLOR_RANGES.length; index += 1) {
    const start = COLOR_RANGES[index].hue;
    const end = index + 1 < COLOR_RANGES.length ? COLOR_RANGES[index + 1].hue : 360;
    if (h < start || h >= end) continue;
    const share = smoothstep((h - start) / (end - start));
    weights[index] += 1 - share;
    weights[(index + 1) % COLOR_RANGES.length] += share;
  }
  return weights;
}

// Moves luma to `target` keeping hue: toward white when brighter, toward black when darker.
function toLuma(rgb, target) {
  const y = luma(rgb);
  if (target > y && y < 1) return rgb.map((c) => c + (1 - c) * (target - y) / (1 - y));
  if (target < y && y > 0) return rgb.map((c) => c * Math.max(0, target) / y);
  return rgb;
}

/**
 * The pixel function: r, g, b 0..1 and {ranges: [[hue, saturation, lightness] x 8], highlights,
 * shadows}. Ranges pick by the input hue; highlights and shadows then work on the result's luma.
 */
export function colorRangesColor(r, g, b, { ranges, highlights = 0, shadows = 0 }) {
  let rgb = [r, g, b];
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  const gate = smoothstep((chroma - GATE_LOW) / (GATE_HIGH - GATE_LOW));
  if (gate > 0 && ranges) {
    const weights = rangeWeights(hueOf(r, g, b, max, chroma));
    let turn = 0, saturation = 0, lightness = 0;
    weights.forEach((weight, index) => {
      if (!weight) return;
      turn += weight * ranges[index][0];
      saturation += weight * ranges[index][1];
      lightness += weight * ranges[index][2];
    });
    if (turn) rgb = fromHsv(hueOf(r, g, b, max, chroma) + turn * gate, chroma / max, max);
    saturation *= gate;
    if (saturation) {
      const y = luma(rgb);
      // Up to double the chroma, never past the edge of 0..1; -1 is the grey of the same luma.
      const room = Math.min(...rgb.map((c) => c > y ? (1 - y) / (c - y) : c < y ? y / (y - c) : Infinity));
      const factor = saturation < 0 ? 1 + saturation : 1 + saturation * Math.min(1, room - 1);
      rgb = rgb.map((c) => y + (c - y) * factor);
    }
    lightness *= gate;
    if (lightness) rgb = rgb.map((c) => lightness < 0 ? c * (1 + lightness) : c + (1 - c) * lightness);
  }
  if (highlights || shadows) {
    const y = luma(rgb);
    const high = smoothstep((y - 0.25) / 0.75) * (1 - y);
    const low = (1 - smoothstep(y / 0.75)) * y;
    rgb = toLuma(rgb, y + TONE * (highlights * high + shadows * low));
  }
  return rgb;
}

const FIELDS = ["Hue", "Saturation", "Lightness"];
/** The effect's settings: redHue, redSaturation, redLightness ... magentaLightness, highlights, shadows. */
export function colorRangesFields(number) {
  return Object.fromEntries([
    ...COLOR_RANGES.flatMap(({ name }) => FIELDS.map((field) => {
      const label = `${name[0].toUpperCase()}${name.slice(1)} ${field}`;
      return [`${name}${field}`, field === "Hue" ? number(label, 0, -180, 180, 1, "°") : number(label, 0, -1, 1, 0.01)];
    })),
    ["highlights", number("Highlights", 0, -1, 1, 0.01)], ["shadows", number("Shadows", 0, -1, 1, 0.01)],
  ]);
}

export function renderColorRanges(frame) {
  const ranges = COLOR_RANGES.map(({ name }) => FIELDS.map((field) =>
    numberParameter(frame, `${name}${field}`, 0, field === "Hue" ? -180 : -1, field === "Hue" ? 180 : 1)));
  const highlights = numberParameter(frame, "highlights", 0, -1, 1);
  const shadows = numberParameter(frame, "shadows", 0, -1, 1);
  const anyRange = ranges.some((values) => values.some(Boolean));
  if (!anyRange && !highlights && !shadows) return frame.content;
  return renderFunctionLut(frame, { name: "color-ranges", color: colorRangesColor,
    parameters: { ranges: anyRange ? ranges : null, highlights, shadows } });
}
