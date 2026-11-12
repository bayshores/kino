// Glow (bloom): the bright parts of a layer, blurred and added back on top of it.
//
// How the SVG filter works, step by step (readers new to SVG filters: each step reads one or
// two images and writes a new one; `result` names it so a later step can read it):
// 1. Brightness: Rec. 709 luma of every pixel goes into the alpha channel.
// 2. Threshold: a lookup table turns that luma into a soft mask, 0 below `threshold` and 1 a
//    little above it (`softness` sets how wide the ramp is).
// 3. The bright pass: the layer's own pixels where the mask lets them through.
// 4. Colour: mixed toward `color` by `colorMix` (0 keeps the picture's colours).
// 5. Blur: one Gaussian blur, or several at doubling radii ("deep glow"), added together.
// 6. The glow is added on top of the layer: out = layer + strength × glow, clipped at white.
//
// The filter runs in sRGB, like every kino effect, so the dashboard preview and the export draw
// the same pixels. Chromium keeps 8 bits per channel between steps, so a very faint, very wide
// glow can show bands on a dark background.
import { filterEffect } from "./svg.js";
import { numberParameter } from "./periodicDisplacement.js";
import { clamp } from "../numbers.js";

export const MAX_GLOW_PASSES = 6;
export const GLOW_DEFAULTS = Object.freeze({ threshold: 0.7, softness: 0.2 });
const LUMA = [0.2126, 0.7152, 0.0722];
const TABLE_SIZE = 64;

const fmt = (value) => {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

export function hexColor(frame, key, fallback) {
  const value = frame?.parameters?.[key];
  const hex = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

/**
 * The soft threshold as a lookup table over brightness 0..1: 0 at or below `threshold`, rising
 * smoothly to 1 at `threshold + softness` (or at pure white, when that is past 1).
 */
export function thresholdTable(threshold, softness) {
  const top = Math.max(Math.min(1, threshold + softness), threshold + 1e-6);
  return Array.from({ length: TABLE_SIZE + 1 }, (_, index) => {
    const luma = index / TABLE_SIZE;
    if (threshold <= 0 && softness <= 0) return 1;
    const t = clamp((luma - threshold) / (top - threshold), 0, 1);
    return t * t * (3 - 2 * t);
  });
}

/**
 * Filter steps for the bright pass of SourceGraphic, written to `result`: the layer's pixels
 * where their luma passes the threshold, mixed toward `rgb` (0..255) by colorMix.
 */
export function brightPassSteps({ threshold, softness, rgb, colorMix, result, prefix = "light" }) {
  const steps = [];
  if (threshold > 0 || softness > 0) {
    steps.push(`<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${LUMA.join(" ")} 0 0" result="${prefix}Luma"/>`,
      `<feComponentTransfer in="${prefix}Luma" result="${prefix}Mask"><feFuncA type="table" tableValues="${thresholdTable(threshold, softness).map(fmt).join(" ")}"/></feComponentTransfer>`,
      `<feComposite in="SourceGraphic" in2="${prefix}Mask" operator="in" result="${colorMix > 0 ? `${prefix}Bright` : result}"/>`);
  } else if (colorMix > 0) {
    steps.push(`<feMerge result="${prefix}Bright"><feMergeNode in="SourceGraphic"/></feMerge>`);
  } else {
    steps.push(`<feMerge result="${result}"><feMergeNode in="SourceGraphic"/></feMerge>`);
  }
  if (colorMix > 0) {
    steps.push(`<feFlood flood-color="rgb(${rgb.join(",")})" result="${prefix}Flood"/>`,
      `<feComposite in="${prefix}Flood" in2="${prefix}Bright" operator="in" result="${prefix}Tint"/>`,
      colorMix >= 1 ? `<feMerge result="${result}"><feMergeNode in="${prefix}Tint"/></feMerge>`
        : `<feComposite in="${prefix}Tint" in2="${prefix}Bright" operator="arithmetic" k1="0" k2="${fmt(colorMix)}" k3="${fmt(1 - colorMix)}" k4="0" result="${result}"/>`);
  }
  return steps;
}

/**
 * A cut-out's matte fades to nothing over 3% of its short side toward the source picture's border
 * (DEFAULT_OPEN_EDGES in backend/cutout/matte.mjs), so a subject cut by its frame has no straight
 * edge there. A glow or shadow made from that faded strip still drew the straight edge (the
 * cutout-composite re-run). These steps write `result`: a soft mask over the layer box (`width` x
 * `height`, layer units): 0 from the box border to the fade's width in (where the faded matte
 * crosses half, about half the fade in, an edge would be found), rising to 1 at twice the fade.
 */
export const CUTOUT_BORDER_FADE = 0.03;
export function cutoutBorderSteps(width, height, result) {
  const fade = CUTOUT_BORDER_FADE * Math.min(width, height);
  const inset = 1.5 * fade;
  if (!(fade > 0) || width <= 2 * inset || height <= 2 * inset) return [];
  return [`<feFlood flood-color="#fff" flood-opacity="1" x="${fmt(inset)}" y="${fmt(inset)}" width="${fmt(width - 2 * inset)}" height="${fmt(height - 2 * inset)}" result="${result}Inner"/>`,
    `<feGaussianBlur in="${result}Inner" stdDeviation="${fmt(fade / 3)}" result="${result}"/>`];
}

/** The blur radii (Gaussian standard deviations are half of each) for a glow's passes. */
export function glowRadii(radius, passes) {
  return Array.from({ length: passes }, (_, index) => radius * 2 ** index);
}

/**
 * Each pass's share of the glow: equal shares that add up to 1, so `strength` means the same
 * amount of light for any number of passes. Each pass spreads its share over a radius twice the
 * last, so the light falls off with distance roughly as real light does (the "deep glow" look):
 * bright near the source and a long faint tail.
 */
export function glowWeights(passes) {
  return Array.from({ length: passes }, () => 1 / passes);
}

export function renderGlow(frame) {
  const strength = numberParameter(frame, "strength", 1, 0, 8);
  const radius = numberParameter(frame, "radius", 24, 0, 400);
  if (strength === 0) return frame.content;
  const threshold = numberParameter(frame, "threshold", GLOW_DEFAULTS.threshold, 0, 1);
  const softness = numberParameter(frame, "softness", GLOW_DEFAULTS.softness, 0, 1);
  const colorMix = numberParameter(frame, "colorMix", 0, 0, 1);
  const passes = numberParameter(frame, "passes", 1, 1, MAX_GLOW_PASSES, { integer: true });
  const rgb = hexColor(frame, "color", "#FFFFFF");
  // Mode "behind": the halo comes from the whole layer (no threshold: an orange word glows
  // orange) and is drawn under it, so the fill keeps its own color instead of washing toward
  // white. Outside the layer's shape it adds the same light as "add".
  const behind = frame?.parameters?.mode === "behind";
  const steps = brightPassSteps({ threshold: behind ? 0 : threshold, softness: behind ? 0 : softness, rgb, colorMix, result: "glowSource", prefix: "glow" });
  const radii = radius > 0 ? glowRadii(radius, passes) : [0];
  // With several passes, strength goes into each pass's weight, so the sum is rounded to 8 bits
  // once at its final brightness (scaling an already rounded sum would widen its bands). Where
  // strength times the glow passes 1 the sum clips, but so would the layer plus the glow.
  const several = radii.length > 1;
  const weights = glowWeights(radii.length).map((weight) => weight * (several ? strength : 1));
  radii.forEach((value, index) => {
    const blurred = index === 0 ? "glowSum" : "glowPass";
    steps.push(value > 0 ? `<feGaussianBlur in="glowSource" stdDeviation="${fmt(value / 2)}" edgeMode="none" result="${blurred}"/>`
      : `<feMerge result="${blurred}"><feMergeNode in="glowSource"/></feMerge>`);
    if (index === 0) {
      if (several) steps.push(`<feComposite in="glowSum" in2="glowSum" operator="arithmetic" k1="0" k2="${fmt(weights[0])}" k3="0" k4="0" result="glowSum"/>`);
    } else {
      steps.push(`<feComposite in="glowSum" in2="glowPass" operator="arithmetic" k1="0" k2="1" k3="${fmt(weights[index])}" k4="0" result="glowSum"/>`);
    }
  });
  // On a cut-out the halo stays off the faded strip along its source picture's border.
  const border = frame?.helpers?.cutout && frame.bounds ? cutoutBorderSteps(frame.bounds.width, frame.bounds.height, "glowBorder") : [];
  if (border.length) steps.push(...border, `<feComposite in="glowSum" in2="glowBorder" operator="in" result="glowSum"/>`);
  if (behind) {
    steps.push(`<feComposite in="glowSum" in2="glowSum" operator="arithmetic" k1="0" k2="${fmt(several ? 1 : strength)}" k3="0" k4="0" result="glowHalo"/>`,
      `<feMerge><feMergeNode in="glowHalo"/><feMergeNode in="SourceGraphic"/></feMerge>`);
  } else {
    steps.push(`<feComposite in="SourceGraphic" in2="glowSum" operator="arithmetic" k1="0" k2="1" k3="${fmt(several ? 1 : strength)}" k4="0"/>`);
  }
  // Three standard deviations of the widest blur hold all but a trace of the glow.
  return filterEffect(frame, steps, { padding: Math.ceil(1.5 * radii[radii.length - 1]) + 1 });
}
