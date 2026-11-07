// Light rays (god rays): streaks of light that radiate out from a centre point. They come either
// from the bright parts of the layer ("bright"), or from a light behind the layer that shines
// through its gaps ("behind": the layer's own shapes cast the shadows between the rays).
//
// The streaks are a radial blur: many copies of the light, each magnified a little more about
// the centre point, averaged with weights that fade along the streak (decay). An SVG filter
// cannot scale an image, but feDisplacementMap can move every pixel by its own amount; with a
// map whose red grows linearly left to right and green top to bottom, centred on the centre
// point, one displacement is a magnification about that point.
//
// Copies are made in stages, each a filter on its own <g> so Chromium draws the stage once and
// the next stage reads the finished picture: stage 1 makes n copies of the light, stage 2 makes
// n copies of stage 1's result spaced n times wider, and so on. Three stages of 8 give 512
// evenly spaced copies from 21 displacements. (Inside one filter, Chromium recomputes a shared
// result for every step that reads it, so the same plan in one filter costs n³ instead of 3n.)
//
// The rays are drawn over the layer with mix-blend-mode: plus-lighter, so they add light to the
// layer and to whatever is behind it, the way real light does.
import { copySource, filterEffect } from "./svg.js";
import { numberParameter } from "./periodicDisplacement.js";
import { cachedMapImage } from "./maps.js";
import { brightPassSteps, GLOW_DEFAULTS, hexColor } from "./glow.js";
import { inverse, point } from "../geometry.js";

// The zoom map's texels. The map is linear, so a few texels stretched smoothly over the region
// give the same ramp as a large image; 8-bit rounding sets the precision either way.
const MAP_TEXELS = 33;
export const MAX_RAY_STAGES = 3;
export const MAX_RAY_COPIES_PER_STAGE = 8;
/** The longest streak, as a fraction of the distance from the centre: copies up to 10× larger. */
export const MAX_RAY_LENGTH = 0.9;
/** How far, in layer sizes, rays may reach past the layer's box before they are cut off. */
const MAX_REACH = 1;
// The widest gap, in pixels, allowed between neighbouring copies at the far end of a streak.
// With 3 pixels, copies of a thin bright line (4 px) overlapped unevenly and the streak showed
// ripples of ±5 levels in a small render; 1.5 keeps them within ±2.
const COPY_GAP = 1.5;

const fmt = (value) => {
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/**
 * The zoom map: red grows from 0 to 1 left to right, green top to bottom. Texel centres sit at
 * 0, 1/(n − 1), … 1 of the square, so the smoothly stretched image is exactly linear across it.
 */
function zoomMap(square) {
  const texel = square.side / (MAP_TEXELS - 1);
  const { uri } = cachedMapImage("light-rays-zoom-v2", MAP_TEXELS, MAP_TEXELS, (x, y) =>
    [Math.round(x / (MAP_TEXELS - 1) * 255), Math.round(y / (MAP_TEXELS - 1) * 255), 128, 255]);
  return `<feImage href="${uri}" x="${fmt(square.x - texel / 2)}" y="${fmt(square.y - texel / 2)}" width="${fmt(square.side + texel)}" height="${fmt(square.side + texel)}" preserveAspectRatio="none" result="raysMap"/>`;
}

/** A soft round light: full in the middle, fading to nothing at the edge. */
function lightDiscUri() {
  return cachedMapImage("light-rays-disc-v1", 128, 128, (x, y, width, height) => {
    const r = Math.hypot((x + 0.5) / width * 2 - 1, (y + 0.5) / height * 2 - 1);
    const t = Math.max(0, Math.min(1, (1 - r) / 0.6));
    return [255, 255, 255, Math.round(255 * t * t * (3 - 2 * t))];
  }).uri;
}

/**
 * The copies' plan for a streak: copies per stage, enough stages that neighbouring copies are
 * at most COPY_GAP pixels apart at the far end of the longest streak.
 */
export function rayStages(farthest, length) {
  if (length <= 0) return [];
  const reach = farthest / (1 - length);
  const needed = Math.max(2, Math.ceil(reach * -Math.log(1 - length) / COPY_GAP) + 1);
  const stages = Math.min(MAX_RAY_STAGES, Math.max(1, Math.ceil(Math.log(needed) / Math.log(MAX_RAY_COPIES_PER_STAGE))));
  const count = Math.min(MAX_RAY_COPIES_PER_STAGE, Math.max(2, Math.ceil(needed ** (1 / stages))));
  return Array.from({ length: stages }, () => count);
}

/** The fade exponent for a decay of 0..1: the end of a streak keeps e^(−fade) of its light. */
export function rayFade(decay) {
  return 1 + 5 * decay;
}

export function renderLightRays(frame) {
  const strength = numberParameter(frame, "strength", 1, 0, 8);
  const length = numberParameter(frame, "length", 0.4, 0, MAX_RAY_LENGTH);
  if (strength === 0 || length === 0) return frame.content;
  const behind = frame.parameters?.source === "behind";
  const threshold = numberParameter(frame, "threshold", GLOW_DEFAULTS.threshold, 0, 1);
  const softness = numberParameter(frame, "softness", GLOW_DEFAULTS.softness, 0, 1);
  const decay = numberParameter(frame, "decay", 0.6, 0, 1);
  const colorMix = numberParameter(frame, "colorMix", 0, 0, 1);
  const rgb = hexColor(frame, "color", "#FFFFFF");
  const { width, height } = frame.bounds;
  const cx = numberParameter(frame, "centerX", 0.5, -1, 2) * width;
  const cy = numberParameter(frame, "centerY", 0.5, -1, 2) * height;
  // The light behind: a soft disc whose diameter is lightSize × the layer's longer side.
  const lightRadius = numberParameter(frame, "lightSize", 0.4, 0, 4) * Math.max(width, height) / 2;
  const paint = frame.paintBounds ?? frame.bounds;
  // Where the light can start: the painted layer, or (behind) the light disc as well.
  const box = behind ? union(paint, { x: cx - lightRadius, y: cy - lightRadius, width: 2 * lightRadius, height: 2 * lightRadius }) : paint;
  const farthest = Math.max(...corners(box).map(([x, y]) => Math.hypot(x - cx, y - cy)));
  const reach = Math.ceil(Math.min(MAX_REACH * Math.max(width, height), farthest * length / (1 - length))) + 2;
  let region = { x: box.x - reach, y: box.y - reach, width: box.width + 2 * reach, height: box.height + 2 * reach };
  // Rays past the edge of the picture are never seen: stop there (the scene, in layer units).
  const scene = sceneBoxInLayer(frame);
  if (scene) region = intersect(region, scene);
  if (!region) return frame.content;
  const subregion = `x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.width)}" height="${fmt(region.height)}"`;
  // The map covers a square over the region; `middle` is the square's centre.
  const square = { x: region.x, y: region.y, side: Math.max(region.width, region.height) };
  const middle = { x: square.x + square.side / 2, y: square.y + square.side / 2 };
  const map = zoomMap(square);

  const stages = rayStages(farthest, length);
  const total = stages.reduce((product, count) => product * count, 1);
  // Copy j of all `total` is magnified 1 / ratio^j, so the last one is 1 / (1 − length).
  const ratio = (1 - length) ** (1 / Math.max(1, total - 1));
  // How the light fades along a streak: copy j keeps e^(−k·j/(total − 1)) of it, so a streak
  // ends at e^(−k): 37% with decay 0 (long even streaks), under 1% with decay 1 (short glows).
  const keep = Math.exp(-rayFade(decay) / Math.max(1, total - 1));

  // The first stage starts from the light: the layer's bright parts, or the light disc behind it.
  const first = behind ? [
    `<feImage href="${lightDiscUri()}" x="${fmt(cx - lightRadius)}" y="${fmt(cy - lightRadius)}" width="${fmt(Math.max(0.001, 2 * lightRadius))}" height="${fmt(Math.max(0.001, 2 * lightRadius))}" preserveAspectRatio="none" result="raysDisc"/>`,
    `<feFlood flood-color="rgb(${rgb.join(",")})" ${subregion} result="raysFlood"/>`,
    `<feComposite in="raysFlood" in2="raysDisc" operator="in" ${subregion} result="raysLight"/>`,
    `<feComposite in="raysLight" in2="SourceAlpha" operator="out" ${subregion} result="raysSource"/>`,
  ] : brightPassSteps({ threshold, softness, rgb, colorMix, result: "raysSource", prefix: "rays" });

  let markup = copySource(frame), spacing = 1;
  stages.forEach((count, stage) => {
    const steps = stage === 0 ? [...first] : [];
    const source = stage === 0 ? "raysSource" : "SourceGraphic";
    steps.push(map);
    const weights = Array.from({ length: count }, (_, index) => keep ** (index * spacing));
    const sum = weights.reduce((accumulated, value) => accumulated + value, 0);
    // The last stage also scales the light by strength (one step, so 8-bit rounding happens once).
    const scale = stage === stages.length - 1 ? strength : 1;
    for (let index = 0; index < count; index += 1) {
      // Each copy samples the light at centre + zoom · (P − centre): the map magnifies about
      // the square's middle, and the shift first moves that magnification to the centre point.
      const zoom = ratio ** (index * spacing);
      const copy = index === 0 ? source : "raysCopy";
      if (index > 0) steps.push(`<feOffset in="${source}" dx="${fmt(-(1 - zoom) * (cx - middle.x))}" dy="${fmt(-(1 - zoom) * (cy - middle.y))}" ${subregion} result="raysShift"/>`,
        `<feDisplacementMap in="raysShift" in2="raysMap" scale="${fmt((zoom - 1) * square.side)}" xChannelSelector="R" yChannelSelector="G" ${subregion} result="raysCopy"/>`);
      const weight = fmt(weights[index] / sum * scale);
      if (index === 0) steps.push(`<feComposite in="${copy}" in2="${copy}" operator="arithmetic" k1="0" k2="${weight}" k3="0" k4="0" ${subregion} result="raysSum"/>`);
      else steps.push(`<feComposite in="raysSum" in2="${copy}" operator="arithmetic" k1="0" k2="1" k3="${weight}" k4="0" ${subregion} result="raysSum"/>`);
    }
    // Each displacement moves pixels in whole steps (8-bit map values, nearest-pixel sampling):
    // up to `jump` pixels at once. A blur of about that size smooths the steps into the streak.
    const jump = (1 - ratio ** ((count - 1) * spacing)) * square.side / 255;
    steps.push(`<feGaussianBlur in="raysSum" stdDeviation="${fmt(Math.max(0.5, Math.min(4, jump / 2)))}" ${subregion}/>`);
    markup = filterEffect({ ...frame, content: markup, paintBounds: region }, steps);
    spacing *= count;
  });
  // The see-through rectangle adds nothing, but it tells Chromium how large the blended group is:
  // without it Chromium works the size out from the nested filters, too small, and cuts rays off.
  const extent = `<rect x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.width)}" height="${fmt(region.height)}" fill="#000" fill-opacity="0"/>`;
  return `<g>${frame.content}<g aria-hidden="true" pointer-events="none" style="mix-blend-mode:plus-lighter">${extent}${markup}</g></g>`;
}

/**
 * The scene's rectangle in the layer's own units (the box around it, when the layer is turned),
 * from helpers.scene = { width, height, matrix: layer → scene }; null without that helper.
 */
export function sceneBoxInLayer(frame) {
  const scene = frame.helpers?.scene;
  if (!scene || !Array.isArray(scene.matrix)) return null;
  const toLayer = inverse(scene.matrix);
  if (!toLayer) return null;
  const points = corners({ x: 0, y: 0, width: scene.width, height: scene.height }).map(([x, y]) => point(toLayer, x, y));
  const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
  return { x, y, width: Math.max(...points.map((p) => p.x)) - x, height: Math.max(...points.map((p) => p.y)) - y };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null;
}

function corners(box) {
  return [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]];
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
