// Deblock: smooths the small level steps a video codec leaves on its block grid (8 or 16 source
// pixels a side), which a lift on dark footage turns into visible squares, and keeps real edges.
//
// How it is drawn (one SVG filter): a soft copy of the layer (a Gaussian blur of `radius` scene
// pixels), the difference between the layer and that copy (feBlend difference), and a mask that is
// 1 where the difference is at most `threshold` (a flat area with only block steps in it), falling
// to 0 at twice that (a real edge or texture). The soft copy is drawn through that mask over the
// layer, so flat areas take the smooth copy and edges keep the layer's own pixels.
// lift_dark (backend/agent/lift-dark.mjs) adds it before its curve when it measures block steps on
// the source's grid; the radius and threshold follow that measurement (engine/quality/liftDark.js).
import { filterEffect } from "./svg.js";
import { clamp } from "../numbers.js";

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });

export const DEBLOCK_EFFECT = {
  key: "deblock", label: "Deblock", group: "Utility", kind: "ranged", render: renderDeblock,
  parameters: {
    // Scene pixels: a quarter of a 16-pixel codec block on a 1:1 source.
    radius: number("Radius", 4, 0.5, 32, 0.1, "px"),
    // The difference from the soft copy (0 to 1 of the color range) still smoothed fully; 0 turns it off.
    threshold: number("Threshold", 0.016, 0, 0.25, 0.001),
  },
};

const fmt = (value) => {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

function read(frame, key) {
  const field = DEBLOCK_EFFECT.parameters[key];
  const value = frame?.parameters?.[key];
  return clamp(Number.isFinite(value) ? value : field.default, field.min, field.max);
}

// How many scene pixels one layer unit covers (as finish.js reads it for grain).
function sceneScale(frame) {
  const [a, b, c, d] = Array.isArray(frame.helpers?.scene?.matrix) ? frame.helpers.scene.matrix : [1, 0, 0, 1];
  const scale = Math.max(Math.hypot(a, b), Math.hypot(c, d));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function renderDeblock(frame) {
  const threshold = read(frame, "threshold");
  if (threshold === 0) return frame.content;
  const deviation = read(frame, "radius") / sceneScale(frame);
  // Alpha = 2 - (r + g + b) / (3 x threshold): 1 up to the threshold, 0 from twice it.
  const weight = -1 / (3 * threshold);
  return filterEffect(frame, [
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(deviation)}" edgeMode="duplicate" result="deblockSoft"/>`,
    '<feBlend in="SourceGraphic" in2="deblockSoft" mode="difference" result="deblockDifference"/>',
    `<feColorMatrix in="deblockDifference" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${fmt(weight)} ${fmt(weight)} ${fmt(weight)} 0 2" result="deblockFlat"/>`,
    '<feComposite in="deblockSoft" in2="deblockFlat" operator="in" result="deblockSmoothed"/>',
    '<feComposite in="deblockSmoothed" in2="SourceGraphic" operator="over" result="deblockMixed"/>',
    // Back to the layer's own shape and see-through parts.
    '<feComposite in="deblockMixed" in2="SourceGraphic" operator="in"/>',
  ]);
}
