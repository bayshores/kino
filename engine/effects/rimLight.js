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
// 5. Lobes (style "lobes"): the band times a slow noise, bright lobes and dark gaps that crawl,
//    thicker where a lobe is bright and thin where it fades, stepping on twos (lobeRate).
// 6. Glow: the band blurred by `spread`, added to the band; haze: the band blurred far wider
//    (`hazeSpread`), dim, added too, so one effect gives the core, the glow and the haze.
// 7. Color: `color`, or ("auto") the layer's own edge color with a brightness floor, saturated.
// 8. The light is added on top of the layer (lightOnly: the light alone).
//
// Defaults come from the technique studies (.scratch/studies, grade-bloom-flash and glow-outline,
// the values that survived 5 or 6 rounds): width 8 and spread 20 match the rim beside cut-out
// subjects (a 4 to 6 px rim at 480p, glow reaching 20 to 45 px at 1080p); lobeSize 100 matches
// the reference lobes every 50 to 150 px. Haze: measured across the glow-outline reference edge
// (ref c1-15.6, in px at 1080p) the light falls to 50% in 7 px and 10% in 20 px, then a tail at
// about 8% of the peak reaches 120 px; the first rim-light fell to 5% in 26 px with no tail.
// hazeSpread 140 and haze 0.8 were tuned on the rim-tune re-run to that tail. The auto color
// floor, the lobe gaps and the brightness weighting are guesses.
import { filterEffect } from "./svg.js";
import { numberParameter, booleanParameter } from "./periodicDisplacement.js";
import { cutoutBorderSteps, hexColor } from "./glow.js";
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

/**
 * The "auto" color's brightness floor, applied before autoColorMatrix: each channel raised to the
 * power 0.5, which lifts a dark subject's edge (a near-black violet #120A22 becomes a mid violet
 * about #7D4CC4 after the matrix) and barely changes a bright one. The first wave drew a dim,
 * near-black rim on the darkened glow-outline subject; 0.5 is a guess tuned on that re-run.
 */
export const AUTO_COLOR_FLOOR = 0.5;

/** The lobe lookup: noise below 0.4 is a dark gap, rising to a full lobe at 0.56 (smoothstep, a guess). */
export function lobeTable(size = 21, low = 0.4, high = 0.56) {
  return Array.from({ length: size }, (_, index) => {
    const t = Math.max(0, Math.min(1, (index / (size - 1) - low) / (high - low)));
    return t * t * (3 - 2 * t);
  });
}

/** A repeatable 0..1 number for an integer step (lobe flicker). */
function stepHash(step, seed) {
  const value = Math.sin((step + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * How far (blur radius, px) the layer's edge is smoothed before the rim follows it. "auto": 4 on
 * pixel layers (video, image: a cut-out matte steps in 6 to 12 px blocks at 1080p, seen in the
 * glow-outline and grade-bloom-flash studies; 4 rounds those off, a guess tuned on that re-run),
 * 0 on drawn layers (text, shapes), whose edges are already smooth and whose thin strokes a blur
 * would erase.
 */
export function smoothRadius(frame) {
  const value = frame?.parameters?.smooth;
  if (Number.isFinite(value)) return Math.max(0, Math.min(50, value));
  return ["video", "image"].includes(frame?.helpers?.layerType) ? 4 : 0;
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
  // lobeRate: lobe updates a second; 12 is "on twos" at 24 fps (the electric outline steps, it does
  // not glide); 0 moves every frame. flicker: how far (share of lobeSize) the lobes jump each step.
  const lobeRate = numberParameter(frame, "lobeRate", 12, 0, 120);
  const flicker = numberParameter(frame, "flicker", 0.3, 0, 2);
  const haze = numberParameter(frame, "haze", 0.8, 0, 4);
  const hazeSpread = numberParameter(frame, "hazeSpread", 140, 0, 800);
  const fill = !booleanParameter(frame, "lightOnly", false);
  const rawAngle = frame?.parameters?.angle;
  const angle = Number.isFinite(rawAngle) ? rawAngle : "auto";
  const autoColor = !(typeof frame?.parameters?.color === "string" && /^#[0-9a-f]{6}$/i.test(frame.parameters.color));
  const smooth = smoothRadius(frame);
  const core = numberParameter(frame, "core", 0.3, 0, 1);
  const region = openRegion(frame, openEdges);
  const area = region ? ` x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.width)}" height="${fmt(region.height)}"` : "";
  const steps = [`<feFlood flood-color="#fff" flood-opacity="1"${area} result="rimRegion"/>`];
  // 0. Shape: the layer's alpha, with stair-stepped matte edges rounded off (blur, then cut back
  // at half). In a strip 2 x smooth wide along the open region's border the alpha stays as it is:
  // a blur there would see the empty beyond and pull a subject cut by the frame off the border,
  // which would light the border.
  let shape = "SourceAlpha";
  if (smooth > 0) {
    steps.push(`<feGaussianBlur in="SourceAlpha" stdDeviation="${fmt(smooth)}" result="rimShapeBlur"/>`,
      `<feComponentTransfer in="rimShapeBlur" result="rimShape"><feFuncA type="linear" slope="4" intercept="-1.5"/></feComponentTransfer>`);
    shape = "rimShape";
    const margin = 2 * smooth;
    if (region && region.width > 2 * margin && region.height > 2 * margin) {
      steps.push(`<feFlood flood-color="#fff" flood-opacity="1" x="${fmt(region.x + margin)}" y="${fmt(region.y + margin)}" width="${fmt(region.width - 2 * margin)}" height="${fmt(region.height - 2 * margin)}" result="rimInner"/>`,
        `<feComposite in="rimShape" in2="rimInner" operator="in" result="rimShapeInner"/>`,
        `<feComposite in="SourceAlpha" in2="rimInner" operator="out" result="rimShapeBorder"/>`,
        `<feMerge result="rimShapeBoth"><feMergeNode in="rimShapeInner"/><feMergeNode in="rimShapeBorder"/></feMerge>`);
      shape = "rimShapeBoth";
    } else if (region) shape = "SourceAlpha";
  }
  // 1. Outside: see-through parts inside the open region.
  steps.push(`<feComposite in="rimRegion" in2="${shape}" operator="out" result="rimOutside"/>`);
  const toLight = typeof angle === "number" ? lightVector(angle) : null;
  // 2. Band.
  if (edge === "inside") {
    steps.push(toLight
      ? `<feOffset in="rimOutside" dx="${fmt(-toLight.x * width)}" dy="${fmt(-toLight.y * width)}" result="rimReach"/>`
      : `<feMorphology in="rimOutside" operator="dilate" radius="${fmt(width)}" result="rimReach"/>`,
    `<feComposite in="rimReach" in2="${shape}" operator="in" result="rimBand"/>`);
  } else {
    steps.push(toLight
      ? `<feOffset in="${shape}" dx="${fmt(toLight.x * width)}" dy="${fmt(toLight.y * width)}" result="rimReach"/>`
      : `<feMorphology in="${shape}" operator="dilate" radius="${fmt(width)}" result="rimReach"/>`,
    `<feComposite in="rimReach" in2="rimOutside" operator="in" result="rimBand"/>`);
  }
  // 3. Soften: about a third of the width, at least half a pixel (a guess that hides 6 to 10 px
  // matte steps at width 8 without blurring a thin line away).
  steps.push(`<feGaussianBlur in="rimBand" stdDeviation="${fmt(Math.max(0.5, width * 0.3))}" result="rimSoft"/>`);
  let band = "rimSoft";
  // Edge "outside" keeps the softened ring off the (smoothed) layer itself; where the smoothed
  // shape cuts a matte step, the ring covers that step.
  if (edge === "outside") {
    steps.push(`<feComposite in="${band}" in2="${shape}" operator="out" result="rimRing"/>`);
    band = "rimRing";
  }
  // 3b. A cut-out's matte fades out along its source picture's border (glow.js): no band there.
  const border = frame?.helpers?.cutout && openEdges !== "none" && frame.bounds ? cutoutBorderSteps(frame.bounds.width, frame.bounds.height, "rimBorder") : [];
  if (border.length) {
    steps.push(...border, `<feComposite in="${band}" in2="rimBorder" operator="in" result="rimKept"/>`);
    band = "rimKept";
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
    const raw = Number.isFinite(frame.time) ? frame.time : 0;
    const step = lobeRate > 0 ? Math.floor(raw * lobeRate + 1e-6) : 0;
    const time = lobeRate > 0 ? step / lobeRate : raw;
    // The slide wraps every 4000 px (at 40 px/s, once in 100 s); each step also jumps by up to
    // flicker x lobeSize, so the lobes flicker as they crawl.
    const jump = lobeRate > 0 ? flicker * lobeSize * stepHash(step, seed) : 0;
    const shift = ((crawl * time + jump) % 4000 + 4000) % 4000;
    const reach = frame.paintBounds ?? frame.bounds;
    const pad = Math.max(spread, haze > 0 ? hazeSpread : 0) * 2 + width;
    steps.push(`<feTurbulence type="fractalNoise" baseFrequency="${fmt(1 / lobeSize)}" numOctaves="2" seed="${seed}" x="${fmt(reach.x - pad - shift)}" y="${fmt(reach.y - pad - shift)}" width="${fmt(reach.width + 2 * pad + shift)}" height="${fmt(reach.height + 2 * pad + shift)}" result="rimNoise"/>`,
      `<feOffset in="rimNoise" dx="${fmt(shift)}" dy="${fmt(shift * 0.6)}" result="rimNoiseMoved"/>`,
      `<feColorMatrix in="rimNoiseMoved" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="rimNoiseAlpha"/>`,
      // Dark gaps between lobes: the reference's electric outline breaks up (glow-outline study);
      // the first wave's floor of 0.2 left an unbroken band.
      `<feComponentTransfer in="rimNoiseAlpha" result="rimLobes"><feFuncA type="table" tableValues="${lobeTable().map(fmt).join(" ")}"/></feComponentTransfer>`,
      `<feComposite in="${band}" in2="rimLobes" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="rimLobedFlat"/>`,
      // Uneven thickness: a steep alpha curve on the lobed band, so a bright lobe's soft band widens
      // and a fading one narrows instead of only dimming (slope and cut are guesses).
      `<feComponentTransfer in="rimLobedFlat" result="rimLobed"><feFuncA type="linear" slope="1.4" intercept="-0.1"/></feComponentTransfer>`);
    band = "rimLobed";
  }
  // 6. Glow: the band blurred by spread, added to it. A thin band blurred far spreads thin, so the
  // glow's gain grows with spread / width (its edge stays about half as bright as the line, at
  // least 1.5 and at most 6 times): width 4 with spread 30 gets a haze that reaches, not a faint
  // tint (seen in the glow-outline re-run; the 0.625 factor and the limits are guesses).
  const glow = spread > 0;
  const glowGain = Math.min(6, Math.max(1.5, 0.625 * spread / width));
  if (glow) steps.push(`<feGaussianBlur in="${band}" stdDeviation="${fmt(spread / 2)}" result="rimGlow"/>`);
  const hazed = haze > 0 && hazeSpread > 0;
  steps.push(glow
    ? `<feComposite in="${band}" in2="rimGlow" operator="arithmetic" k1="0" k2="${fmt(intensity)}" k3="${fmt(intensity * glowGain)}" k4="0" result="${hazed ? "rimNear" : "rimLight"}"/>`
    : `<feComposite in="${band}" in2="${band}" operator="arithmetic" k1="0" k2="${fmt(intensity)}" k3="0" k4="0" result="${hazed ? "rimNear" : "rimLight"}"/>`);
  // 6b. Haze: the same gain rule as the glow (a thin band blurred far spreads thin), capped at 16.
  if (hazed) {
    const hazeGain = haze * Math.min(16, Math.max(1.5, 0.625 * hazeSpread / width));
    steps.push(`<feGaussianBlur in="${band}" stdDeviation="${fmt(hazeSpread / 2)}" result="rimHaze"/>`,
      `<feComposite in="rimNear" in2="rimHaze" operator="arithmetic" k1="0" k2="1" k3="${fmt(intensity * hazeGain)}" k4="0" result="rimLight"/>`);
  }
  // 7. Color.
  if (autoColor) {
    steps.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(Math.max(4, width, spread))}" result="rimEdgeColor"/>`,
      `<feComponentTransfer in="rimEdgeColor" result="rimEdgeLifted"><feFuncR type="gamma" exponent="${AUTO_COLOR_FLOOR}"/><feFuncG type="gamma" exponent="${AUTO_COLOR_FLOOR}"/><feFuncB type="gamma" exponent="${AUTO_COLOR_FLOOR}"/></feComponentTransfer>`,
      // Saturation 2.4 after the floor (1.8 before it): the lift pulls channels together, and 2.4
      // gives back the acid yellow-green study rim's hue (a guess checked on #C0F040).
      `<feColorMatrix in="rimEdgeLifted" type="matrix" values="${autoColorMatrix(2.4).map(fmt).join(" ")}" result="rimColor"/>`);
  } else {
    const rgb = hexColor(frame, "color", "#FFFFFF");
    steps.push(`<feFlood flood-color="rgb(${rgb.join(",")})" result="rimColor"/>`);
  }
  steps.push(`<feComposite in="rimColor" in2="rimLight" operator="in" result="rimColored"/>`);
  // 7b. Core: the line itself (not its glow) mixed toward white, the pale core of a neon edge.
  // Default 0.3 is a guess from the glow-outline reference (core #e0c8ff inside a #7a2cff glow).
  if (core > 0) steps.push(`<feFlood flood-color="#fff" result="rimWhite"/>`,
    `<feComposite in="rimWhite" in2="${band}" operator="in" result="rimCore"/>`,
    `<feComposite in="rimColored" in2="rimCore" operator="arithmetic" k1="0" k2="1" k3="${fmt(core * Math.min(1, intensity))}" k4="0" result="rimPaint"/>`);
  else steps.push(`<feMerge result="rimPaint"><feMergeNode in="rimColored"/></feMerge>`);
  // 8. Added on top of the layer, or alone (lightOnly; a parameter named fill would read as a Fill animation).
  steps.push(fill ? `<feComposite in="SourceGraphic" in2="rimPaint" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>`
    : `<feMerge><feMergeNode in="rimPaint"/></feMerge>`);
  return filterEffect(frame, steps, { padding: Math.ceil(width + 1.5 * Math.max(spread, hazed ? hazeSpread : 0)) + 2 });
}
