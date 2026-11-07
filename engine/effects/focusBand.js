// Focus band: depth of field on a flat layer. A band (a line across the layer, or a rectangle)
// stays sharp and the blur rises smoothly outside it, up to maxBlur, over `falloff`. The band is
// in the layer's own coordinates, so on a tilted plane (rotateX/rotateY) it tilts with the plane,
// and on a split_image group it runs across every piece. It is a value effect: animate centerY
// (or centerX) to follow a typing line or rack focus from one row to another.
//
// How it is drawn: three or four copies of the layer, each blurred a step more (0, 6 and 12 px for
// the default 12 px blur), each masked by its share in the layer's coordinates and added together:
// where the blur should be between two steps, the two nearest copies are mixed in proportion (a
// tent per copy, the shares adding up to 1), so a see-through layer (text, split_image pieces with
// gaps) mixes exactly too. There are no hard edges: a share is a gray gradient with many stops
// along a smoothstep, never a cut. A rect's share is the darker of an x and a y gradient.
// resvg (unit tests, captures without Chromium) cannot add pictures: there the copies are stacked,
// blurriest at the bottom, which is exact for opaque layers only.
import { copiesEffect, copySource, filterEffect } from "./svg.js";
import { layerPixelScale } from "./motionBlurs.js";
import { inverse, point } from "../geometry.js";

// Copies, the sharp one included: 3, or 4 past 24 px of blur as drawn (two blurs mixed 12 px apart
// show no steps). Each one costs a blur of the layer: an app still on ui-plane (drawn about 2x,
// linked as in an export) took 0.15 to 0.4 s a 1080p frame without the band and 0.55 to 0.8 s with
// 3 copies (6 copies stacked, blurred over the whole layer, took 3 s). Each copy above the bottom
// one is blurred only where it shows (slabBox).
const MIN_LEVELS = 3;
const MAX_LEVELS = 4;
const STEP_PIXELS = 12;
const RAMP_STOPS = 12; // gradient stops along each side's falloff

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });

export const FOCUS_BAND_EFFECT = {
  key: "focus-band", label: "Focus Band", group: "Blur", kind: "value", render: renderFocusBand,
  parameters: {
    shape: { type: "enum", label: "Shape", default: "line", options: [["line", "Line"], ["rect", "Rectangle"]] },
    centerX: number("Center X", 0.5, -1, 2, 0.01, "layer fraction"),
    centerY: number("Center Y", 0.5, -1, 2, 0.01, "layer fraction"),
    angle: number("Angle", 0, -180, 180, 1, "°"),
    width: number("Width", 0.12, 0, 2, 0.01, "layer fraction"),
    height: number("Height", 0.25, 0, 2, 0.01, "layer fraction"),
    maxBlur: number("Max Blur", 12, 0, 100, 0.5, "px", { neutral: 0 }),
    falloff: number("Falloff", 0.25, 0.01, 2, 0.01, "layer fraction"),
  },
};

const DEFAULTS = Object.fromEntries(Object.entries(FOCUS_BAND_EFFECT.parameters).map(([key, field]) => [key, field.default]));

function read(frame, key) {
  const field = FOCUS_BAND_EFFECT.parameters[key];
  const value = frame.parameters?.[key] ?? DEFAULTS[key];
  if (field.type === "enum") {
    if (!field.options.some(([option]) => option === value)) throw new RangeError(`focus-band.${key} must be line or rect.`);
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < field.min || value > field.max)
    throw new RangeError(`focus-band.${key} must be a number from ${field.min} to ${field.max}.`);
  return value;
}

const fmt = (value) => { const rounded = Number(value.toFixed(4)); return Object.is(rounded, -0) ? "0" : String(rounded); };
const smoothstep = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/**
 * One axis of the band: a center (layer units), a unit normal across it, its half width and its
 * falloff (layer units). `blurAt(distance)` is the blur from 0 to 1 at a signed distance from the
 * center along the normal.
 */
export function bandAxes(frame) {
  const { width: w, height: h } = frame.bounds;
  const cx = frame.bounds.x + w * read(frame, "centerX"), cy = frame.bounds.y + h * read(frame, "centerY");
  if (read(frame, "shape") === "rect") {
    const reach = h; // falloff is a fraction of the layer's height for both sides of a rect
    return [
      { cx, cy, nx: 1, ny: 0, half: w * read(frame, "width") / 2, falloff: reach * read(frame, "falloff") },
      { cx, cy, nx: 0, ny: 1, half: h * read(frame, "height") / 2, falloff: reach * read(frame, "falloff") },
    ];
  }
  // A line: angle 0 is a horizontal band, so its normal points down; width and falloff are
  // fractions of the layer's size measured across the band.
  const radians = read(frame, "angle") * Math.PI / 180, nx = -Math.sin(radians), ny = Math.cos(radians);
  const across = Math.abs(ny) * h + Math.abs(nx) * w;
  return [{ cx, cy, nx, ny, half: across * read(frame, "width") / 2, falloff: across * read(frame, "falloff") }];
}

/** Blur from 0 (sharp) to 1 (maxBlur) at a signed distance from the band's middle. */
export function bandBlur(axis, distance) {
  return smoothstep((Math.abs(distance) - axis.half) / axis.falloff);
}

const GRID = 24;
function snapOut(box) {
  const x = Math.floor(box.x / GRID) * GRID, y = Math.floor(box.y / GRID) * GRID;
  return { x, y, width: Math.ceil((box.x + box.width) / GRID) * GRID - x, height: Math.ceil((box.y + box.height) / GRID) * GRID - y };
}

function cornersOf(box) {
  return [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]];
}

// The lowest and highest blur (0..1) the box reaches along an axis.
function blurRange(axis, box) {
  const distances = cornersOf(box).map(([x, y]) => (x - axis.cx) * axis.nx + (y - axis.cy) * axis.ny);
  const low = Math.min(...distances), high = Math.max(...distances);
  const nearest = low <= 0 && high >= 0 ? 0 : Math.min(Math.abs(low), Math.abs(high));
  return [bandBlur(axis, nearest), Math.max(bandBlur(axis, low), bandBlur(axis, high))];
}

// A gray gradient across one axis: how much of copies 0..k shows (of `levels` steps), white
// where the blur is at most k steps, falling to black at k + 1 steps.
function cumulativeGradient(frame, axis, level, levels) {
  const id = frame.helpers.id("focus-gradient");
  const reach = axis.half + axis.falloff;
  const stops = [];
  for (let index = 0; index <= 2 * RAMP_STOPS + 1; index += 1) {
    // Stops from -reach to -half (the near side's falloff), then half to reach.
    const side = index <= RAMP_STOPS ? -1 : 1;
    const step = side < 0 ? RAMP_STOPS - index : index - RAMP_STOPS - 1;
    const distance = side * (axis.half + axis.falloff * step / RAMP_STOPS);
    const offset = (distance + reach) / (2 * reach);
    const steps = bandBlur(axis, distance) * (levels - 1);
    const gray = Math.round(255 * Math.max(0, Math.min(1, level + 1 - steps)));
    stops.push(`<stop offset="${fmt(offset)}" stop-color="rgb(${gray},${gray},${gray})"/>`);
  }
  frame.helpers.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(axis.cx - axis.nx * reach)}" y1="${fmt(axis.cy - axis.ny * reach)}" x2="${fmt(axis.cx + axis.nx * reach)}" y2="${fmt(axis.cy + axis.ny * reach)}">${stops.join("")}</linearGradient>`);
  return id;
}

// Mask content (luminance) for copies 0..k together: a rect's blur is the larger of its two axes'
// blurs, so its share is the smaller of the two axes' shares (darken keeps the darker gray).
function cumulativeShare(frame, axes, level, levels, box) {
  if (level < 0) return "";
  const rects = axes.map((axis, index) =>
    `<rect ${box} fill="url(#${cumulativeGradient(frame, axis, level, levels)})"${index ? ' style="mix-blend-mode:darken"' : ""}/>`);
  return rects.length === 1 ? rects[0] : `<g style="isolation:isolate">${rects.join("")}</g>`;
}

// Masks copy `level` by its share. exact: its own share alone (copies 0..k less copies 0..k-1, by
// difference, for copies added together); otherwise copies 0..k together, for copies stacked over
// each other. The bottom copy of a stack is not masked.
function masked(frame, markup, axes, level, levels, region, { exact, bottom }) {
  if (bottom && !exact) return markup;
  const id = frame.helpers.id("focus-mask");
  const box = `x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.width)}" height="${fmt(region.height)}"`;
  const upTo = bottom ? `<rect ${box} fill="#fff"/>` : cumulativeShare(frame, axes, level, levels, box);
  const below = exact ? cumulativeShare(frame, axes, level - 1, levels, box) : "";
  const content = below ? `<g style="isolation:isolate"><rect ${box} fill="#000"/>${upTo}<g style="mix-blend-mode:difference">${below}</g></g>` : upTo;
  frame.helpers.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" ${box}>${content}</mask>`);
  return `<g mask="url(#${id})">${markup}</g>`;
}

// The smoothstep's inverse: the t in 0..1 where smoothstep(t) is y.
function unsmooth(y) {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  return 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3);
}

// The part of `box` within `reach` of the band's middle along an axis, as a box (null if none):
// the box's corners clipped to the slab between the two lines (Sutherland-Hodgman).
export function slabBox(axis, reach, box) {
  const along = ([x, y]) => (x - axis.cx) * axis.nx + (y - axis.cy) * axis.ny;
  let points = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]];
  for (const sign of [1, -1]) {
    const outside = (p) => sign * along(p) - reach;
    const next = [];
    points.forEach((current, index) => {
      const previous = points.at(index - 1);
      const [dp, dc] = [outside(previous), outside(current)];
      const crossing = () => { const t = dp / (dp - dc); return [previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]; };
      if (dc <= 0) { if (dp > 0) next.push(crossing()); next.push(current); } else if (dp <= 0) next.push(crossing());
    });
    points = next;
    if (!points.length) return null;
  }
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

// True when the layer's box covers the whole scene (helpers.scene: its size and the layer's matrix).
function coversFrame(frame) {
  const scene = frame.helpers.scene;
  if (!scene?.matrix || scene.tilted || !(scene.width > 0 && scene.height > 0)) return false;
  const back = inverse(scene.matrix);
  if (!back) return false;
  const { x, y, width, height } = frame.bounds;
  return [[0, 0], [scene.width, 0], [0, scene.height], [scene.width, scene.height]].every(([sx, sy]) => {
    const local = point(back, sx, sy);
    return local.x >= x - 0.5 && local.y >= y - 0.5 && local.x <= x + width + 0.5 && local.y <= y + height + 0.5;
  });
}

// The copy and its eight mirror images around the layer's box (render.js mirroredEdges).
function mirrored(frame, source) {
  const { x, y, width, height } = frame.bounds;
  // Per axis: as it is, flipped about the left (top) edge, or about the right (bottom) edge.
  const across = [[1, 0], [-1, 2 * x], [-1, 2 * (x + width)]], down = [[1, 0], [-1, 2 * y], [-1, 2 * (y + height)]];
  const flips = across.flatMap(([sx, ex]) => down.map(([sy, ey]) => [sx, sy, ex, ey]))
    .filter(([sx, sy]) => sx !== 1 || sy !== 1)
    .map(([sx, sy, ex, ey]) => `<g transform="matrix(${sx} 0 0 ${sy} ${fmt(ex)} ${fmt(ey)})">${source}</g>`);
  return `<g>${source}${flips.join("")}</g>`;
}

export function renderFocusBand(frame) {
  const maxBlur = read(frame, "maxBlur");
  const pixels = maxBlur * layerPixelScale(frame);
  if (pixels < 0.5) return frame.content;
  const paint = frame.paintBounds ?? frame.bounds;
  const axes = bandAxes(frame);
  const ranges = axes.map((axis) => blurRange(axis, paint));
  // A rect's blur is the larger of its two axes' blurs.
  const low = Math.max(...ranges.map(([from]) => from)), high = Math.max(...ranges.map(([, to]) => to));
  if (high <= 0) return frame.content;
  const levels = Math.max(MIN_LEVELS, Math.min(MAX_LEVELS, Math.ceil(pixels / STEP_PIXELS) + 1));
  // Only the steps this layer reaches: below `first` nothing shows, above `last` nothing is needed.
  const first = Math.min(levels - 1, Math.floor(low * (levels - 1)));
  const last = Math.min(levels - 1, Math.ceil(high * (levels - 1)));
  // maxBlur is in the px of a layer's blur property (a Gaussian of half that deviation): 12 leaves
  // the far rows of a UI unreadable but their shapes clear, as in calm launch films.
  const padding = 1.5 * maxBlur;
  // The masks' box is snapped out to a 24-unit grid: Chromium drew the whole masked layer half a
  // pixel off (softening the sharp band) when the box's edge fell on half a pixel of the output, as
  // a padding of 18 does in a quarter-size look frame. 24 units are whole pixels at 1/4, 1/3, 1/2,
  // 2/3 and full size.
  const region = snapOut({ x: paint.x - padding, y: paint.y - padding, width: paint.width + 2 * padding, height: paint.height + 2 * padding });
  const source = copySource(frame, { home: frame.drawnBounds ?? paint });
  // A picture that fills the frame is blurred from a mirror image around its box and kept in its
  // box, as a plain blur on footage is, so the frame's edges do not darken.
  const fills = coversFrame(frame);
  const blurSource = fills ? mirrored(frame, source) : source;
  const exact = !frame.helpers.raster;
  const parts = [];
  for (let level = last; level >= first; level -= 1) {
    const sigma = maxBlur / 2 * level / (levels - 1);
    // The bottom copy shows everywhere; each one above it only where the blur is under one step
    // more, so it is blurred and masked only there: the filter's work follows the band.
    let shown = paint;
    if (level < last) for (const axis of axes)
      shown = shown && slabBox(axis, axis.half + axis.falloff * unsmooth((level + 1) / (levels - 1)), shown);
    if (!shown || !(shown.width > 0) || !(shown.height > 0)) continue;
    let copy = sigma > 0
      ? filterEffect({ ...frame, content: blurSource, paintBounds: shown }, `<feGaussianBlur stdDeviation="${fmt(sigma)}"/>`, { padding, contain: fills })
      : source;
    // Every mask covers the whole layer and more: Chromium let the sharp copy through along the
    // right and bottom edges of a mask that ended inside the picture (a bright hairline).
    parts.push(masked(frame, copy, axes, level, levels, region, { exact, bottom: level === last }));
  }
  frame.helpers.includeBounds?.(region);
  // Added together (plus-lighter in an isolated group), each copy weighted by its own share, so a
  // see-through layer mixes exactly. resvg has no plus-lighter: there the copies are stacked.
  const stack = exact
    ? `<g style="isolation:isolate">${parts.map((part, index) => index ? `<g style="mix-blend-mode:plus-lighter">${part}</g>` : part).join("")}</g>`
    : parts.join("");
  return copiesEffect(frame, `<g data-focus-band="${levels}">${stack}</g>`);
}
