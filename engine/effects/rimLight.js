// Rim light: a thin band of light along the edge of a layer's own shape (its alpha), with a soft
// glow around it. Works on anything with see-through parts: a cut-out subject, text, a shape.
//
// How the SVG filter works, step by step:
// 1. Outside: the area where the layer is see-through, limited to the scene frame (and, with
//    openEdges "box", to the layer's own box), so the frame border is never traced as an edge.
// 2. Band: with edge "inside", the layer's pixels that have outside within `width` px toward the
//    light (an offset of the outside by `angle`), or on every side ("auto": dilated outside);
//    with edge "outside", the outside pixels within `width` px of the layer (a ring alone).
// 3. Soften: a small blur, so stair-stepped cut-out edges read as one smooth line.
// 4. Brightness ("auto" angle only): the band is weighted by the layer's own blurred brightness,
//    so the rim is strongest on the side of the subject that is already lit.
// 5. Lobes (style "lobes"): the band times a slow noise, bright lobes and dim gaps that crawl.
// 6. Glow: the band blurred by `spread`, added to the band.
// 7. Color: `color`, or ("auto") the layer's own edge color, saturated and brightened.
// 8. The light is added on top of the layer (lightOnly: the light alone).
//
// Defaults come from the technique studies (.scratch/studies, grade-bloom-flash and glow-outline,
// the values that survived 5 or 6 rounds): width 8 and spread 20 match the rim beside cut-out
// subjects (a 4 to 6 px rim at 480p, glow reaching 20 to 45 px at 1080p); lobeSize 100 matches
// the reference lobes every 50 to 150 px. The auto color lift and the brightness weighting are
// guesses.
import { filterEffect } from "./svg.js";
import { numberParameter, booleanParameter } from "./periodicDisplacement.js";
import { hexColor } from "./glow.js";
import { inverse, point } from "../geometry.js";

export const RIM_EDGES = Object.freeze(["inside", "outside"]);
export const RIM_STYLES = Object.freeze(["even", "lobes"]);
export const RIM_OPEN_EDGES = Object.freeze(["frame", "box", "none"]);

const fmt = (value) => {
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/** The direction toward the light for `angle` degrees (0 from above, 90 from the right, clockwise). */
export function lightVector(angle) {
  const radians = angle * Math.PI / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/**
 * The area (layer-local) that counts as "outside" the layer: the scene frame mapped into the
 * layer (its bounding box when the layer is turned), cut to the layer box with openEdges "box",
 * or null for "none" (everything counts).
 */
export function openRegion(frame, openEdges) {
  if (openEdges === "none") return null;
  const box = frame.bounds;
  if (openEdges === "box") return box;
  const scene = frame.helpers?.scene;
  if (!scene?.matrix || !(scene.width > 0) || !(scene.height > 0)) return null;
  const local = inverse(scene.matrix);
  if (!local) return null;
  const corners = [[0, 0], [scene.width, 0], [0, scene.height], [scene.width, scene.height]].map(([x, y]) => point(local, x, y));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The "auto" color: the layer's own edge color saturated 1.8 times, then 1.3 times as bright plus
 * 0.08, with alpha made whole so the color fills the light (a guess, tuned on an acid
 * yellow-green subject whose study rim was #D4FF5A). One 4 x 5 matrix, so nothing clips between.
 */
export function autoColorMatrix(saturation = 1.8, gain = 1.3, lift = 0.08) {
  const luma = [0.213, 0.715, 0.072];
  const rows = [0, 1, 2].map((row) => luma.map((weight, column) =>
    gain * (weight * (1 - saturation) + (row === column ? saturation : 0))));
  return [...rows.flatMap((row) => [...row, 0, lift]), 0, 0, 0, 0, 1];
}

function choiceParameter(frame, key, options, fallback) {
  const value = frame?.parameters?.[key];
  return options.includes(value) ? value : fallback;
}

export function renderRimLight(frame) {
  const intensity = numberParameter(frame, "intensity", 1, 0, 4);
  if (intensity === 0) return frame.content;
  const width = numberParameter(frame, "width", 8, 0.5, 200);
  const spread = numberParameter(frame, "spread", 20, 0, 400);
  const edge = choiceParameter(frame, "edge", RIM_EDGES, "inside");
  const style = choiceParameter(frame, "style", RIM_STYLES, "even");
  const openEdges = choiceParameter(frame, "openEdges", RIM_OPEN_EDGES, "frame");
  const lobeSize = numberParameter(frame, "lobeSize", 100, 8, 1000);
  const crawl = numberParameter(frame, "crawl", 40, -1000, 1000);
  const seed = numberParameter(frame, "seed", 0, 0, 1_000_000, { integer: true });
  const fill = !booleanParameter(frame, "lightOnly", false);
  const rawAngle = frame?.parameters?.angle;
  const angle = Number.isFinite(rawAngle) ? rawAngle : "auto";
  const autoColor = !(typeof frame?.parameters?.color === "string" && /^#[0-9a-f]{6}$/i.test(frame.parameters.color));
  const region = openRegion(frame, openEdges);
  const area = region ? ` x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.width)}" height="${fmt(region.height)}"` : "";
  const steps = [
    // 1. Outside: see-through parts inside the open region.
    `<feFlood flood-color="#fff" flood-opacity="1"${area} result="rimRegion"/>`,
    `<feComposite in="rimRegion" in2="SourceAlpha" operator="out" result="rimOutside"/>`,
  ];
  const toLight = typeof angle === "number" ? lightVector(angle) : null;
  // 2. Band.
  if (edge === "inside") {
    steps.push(toLight
      ? `<feOffset in="rimOutside" dx="${fmt(-toLight.x * width)}" dy="${fmt(-toLight.y * width)}" result="rimReach"/>`
      : `<feMorphology in="rimOutside" operator="dilate" radius="${fmt(width)}" result="rimReach"/>`,
    `<feComposite in="rimReach" in2="SourceAlpha" operator="in" result="rimBand"/>`);
  } else {
    steps.push(toLight
      ? `<feOffset in="SourceAlpha" dx="${fmt(toLight.x * width)}" dy="${fmt(toLight.y * width)}" result="rimReach"/>`
      : `<feMorphology in="SourceAlpha" operator="dilate" radius="${fmt(width)}" result="rimReach"/>`,
    `<feComposite in="rimReach" in2="rimOutside" operator="in" result="rimBand"/>`);
  }
  // 3. Soften: about a third of the width, at least half a pixel (a guess that hides 6 to 10 px
  // matte steps at width 8 without blurring a thin line away).
  steps.push(`<feGaussianBlur in="rimBand" stdDeviation="${fmt(Math.max(0.5, width * 0.3))}" result="rimSoft"/>`);
  let band = "rimSoft";
  // Edge "outside" keeps the softened ring off the layer itself.
  if (edge === "outside") {
    steps.push(`<feComposite in="${band}" in2="SourceAlpha" operator="out" result="rimRing"/>`);
    band = "rimRing";
  }
  // 4. Brightness weight with the "auto" angle on the inside edge (guess: 0.35 on dark parts,
  // full on parts brighter than mid grey).
  if (!toLight && edge === "inside") {
    steps.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(Math.max(8, width * 3))}" result="rimLit"/>`,
      `<feColorMatrix in="rimLit" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2126 0.7152 0.0722 0 0" result="rimLuma"/>`,
      `<feComponentTransfer in="rimLuma" result="rimWeight"><feFuncA type="table" tableValues="0.35 0.7 1 1"/></feComponentTransfer>`,
      `<feComposite in="${band}" in2="rimWeight" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="rimWeighted"/>`);
    band = "rimWeighted";
  }
  // 5. Lobes: noise at lobeSize, sharpened into bright lobes and dim gaps, sliding by `crawl` px/s.
  if (style === "lobes") {
    const time = Number.isFinite(frame.time) ? frame.time : 0;
    // The slide wraps every 4000 px (at 40 px/s, once in 100 s).
    const shift = ((crawl * time) % 4000 + 4000) % 4000;
    const reach = frame.paintBounds ?? frame.bounds;
    const pad = spread * 2 + width;
    steps.push(`<feTurbulence type="fractalNoise" baseFrequency="${fmt(1 / lobeSize)}" numOctaves="2" seed="${seed}" x="${fmt(reach.x - pad - shift)}" y="${fmt(reach.y - pad - shift)}" width="${fmt(reach.width + 2 * pad + shift)}" height="${fmt(reach.height + 2 * pad + shift)}" result="rimNoise"/>`,
      `<feOffset in="rimNoise" dx="${fmt(shift)}" dy="${fmt(shift * 0.6)}" result="rimNoiseMoved"/>`,
      `<feColorMatrix in="rimNoiseMoved" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="rimNoiseAlpha"/>`,
      `<feComponentTransfer in="rimNoiseAlpha" result="rimLobes"><feFuncA type="table" tableValues="0.08 0.08 0.15 0.9 1 1"/></feComponentTransfer>`,
      `<feComposite in="${band}" in2="rimLobes" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="rimLobed"/>`);
    band = "rimLobed";
  }
  // 6. Glow: the band blurred by spread, added to it.
  const glow = spread > 0;
  if (glow) steps.push(`<feGaussianBlur in="${band}" stdDeviation="${fmt(spread / 2)}" result="rimGlow"/>`);
  steps.push(glow
    ? `<feComposite in="${band}" in2="rimGlow" operator="arithmetic" k1="0" k2="${fmt(intensity)}" k3="${fmt(intensity * 1.5)}" k4="0" result="rimLight"/>`
    : `<feComposite in="${band}" in2="${band}" operator="arithmetic" k1="0" k2="${fmt(intensity)}" k3="0" k4="0" result="rimLight"/>`);
  // 7. Color.
  if (autoColor) {
    steps.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(Math.max(4, width, spread))}" result="rimEdgeColor"/>`,
      `<feColorMatrix in="rimEdgeColor" type="matrix" values="${autoColorMatrix().map(fmt).join(" ")}" result="rimColor"/>`);
  } else {
    const rgb = hexColor(frame, "color", "#FFFFFF");
    steps.push(`<feFlood flood-color="rgb(${rgb.join(",")})" result="rimColor"/>`);
  }
  steps.push(`<feComposite in="rimColor" in2="rimLight" operator="in" result="rimPaint"/>`);
  // 8. Added on top of the layer, or alone (lightOnly; a parameter named fill would read as a Fill animation).
  steps.push(fill ? `<feComposite in="SourceGraphic" in2="rimPaint" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>`
    : `<feMerge><feMergeNode in="rimPaint"/></feMerge>`);
  return filterEffect(frame, steps, { padding: Math.ceil(width + 1.5 * spread) + 2 });
}
