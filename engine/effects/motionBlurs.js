// Directional, zoom and spin blur: the layer smeared along a line, out from a centre, or around a
// centre, as if it moved while a camera's shutter was open. Each is a value effect, so a whip pan
// or a zoom or spin transition is a few keyframes: blur up to a strength, then back to 0.
//
// How they are drawn (the same SVG in the dashboard preview and in every export, which draws
// effects with Chromium):
// - directional-blur is one filter. Averaging the picture with a copy of itself moved by d, then
//   that result with itself moved by 2d, 4d, … gives 2^m evenly spaced copies after m steps (a box
//   blur). So a 1,000 px smear with a copy every pixel takes 10 steps, not 1,000 copies.
// - zoom-blur and spin-blur average copies of the layer, each scaled or turned a little more. A
//   filter cannot scale or turn a picture, so these draw one copy per sample; the copies are mixed
//   two at a time (plus-lighter at half opacity), which gives the exact mean of every copy.
// The number of samples follows how far the farthest pixel travels, about one per pixel of travel
// (at the size the layer is drawn on the scene), so the smear has no visible steps or ghost copies.
//
// Copies and their cost. Every copy is a <use> copy of the layer whose definition starts with a
// home rectangle as large as everything the layer draws (copySource in svg.js). Without it,
// Chromium (Electron 44) dropped most copies once there were more than about 30 copies of a layer
// with many parts reaching outside the frame, so the blur came out several times too dark. The
// copies are drawn as vectors, so a small zoom or spin keeps the layer as sharp as it is without
// the blur (copies that repeated one pattern tile of the layer, as before, were drawn from a
// smaller, blurred tile once it passed 2048 × 2048 pixels: a 0.05° spin of a 1080p frame exported
// at 4K was 0.60 levels off, now 0.05). Copying is expensive when the layer already holds copies or a filter, because
// Chromium draws the inner work again for every copy (a 400 px directional blur under 8 spin
// copies took 7 s a frame). So a zoom or spin blur over another zoom or spin blur keeps the total
// at 256 copies of the picture, and one over a filter (directional blur, glow, shadow…) uses at
// most 16 copies. Fewer copies can show steps at large values.
import { copiesEffect, copySource, filterEffect } from "./svg.js";

export const MAX_DIRECTIONAL_STEPS = 9; // 2^9 = 512 copies along the line.
export const MAX_BLUR_COPIES = 256; // zoom and spin: at most this many copies of the picture in all.
export const MAX_FILTERED_COPIES = 16; // zoom and spin over a layer that holds an SVG filter.

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const center = (axis) => number(`Center ${axis}`, 0.5, -1, 2, 0.01, "layer fraction");

export const BLUR_EFFECTS = [
  { key: "directional-blur", label: "Directional Blur", group: "Blur", kind: "value", render: renderDirectionalBlur,
    parameters: {
      length: number("Length", 80, 0, 4000, 1, "px", { neutral: 0 }),
      angle: number("Angle", 0, -360, 360, 1, "°"),
    } },
  { key: "zoom-blur", label: "Zoom Blur", group: "Blur", kind: "value", render: renderZoomBlur,
    parameters: {
      amount: number("Amount", 0.3, 0, 2, 0.01, "of the distance to the centre", { neutral: 0 }),
      centerX: center("X"), centerY: center("Y"),
    } },
  { key: "spin-blur", label: "Spin Blur", group: "Blur", kind: "value", render: renderSpinBlur,
    parameters: {
      angle: number("Angle", 20, 0, 360, 1, "°", { neutral: 0 }),
      centerX: center("X"), centerY: center("Y"),
    } },
];

const DEFAULTS = new Map(BLUR_EFFECTS.map((effect) => [effect.key,
  Object.fromEntries(Object.entries(effect.parameters).map(([key, field]) => [key, field.default]))]));
const LIMITS = new Map(BLUR_EFFECTS.map((effect) => [effect.key, effect.parameters]));

function read(frame, effectKey, key) {
  const value = frame.parameters?.[key] ?? DEFAULTS.get(effectKey)[key];
  const { min, max } = LIMITS.get(effectKey)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${effectKey}.${key} must be a number from ${min} to ${max}.`);
  return value;
}

function fmt(value) {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

// How many scene pixels one layer unit covers (the larger axis), from the layer's transform.
export function layerPixelScale(frame) {
  const [a, b, c, d] = Array.isArray(frame.helpers?.transform) ? frame.helpers.transform : [1, 0, 0, 1];
  const scale = Math.max(Math.hypot(a, b), Math.hypot(c, d));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function paintOf(frame) {
  const box = frame.paintBounds ?? frame.bounds;
  return { ...box, width: Math.max(0.001, box.width), height: Math.max(0.001, box.height) };
}

function corners(box) {
  return [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]];
}

/**
 * How far the active directional, zoom and spin blurs (`effectsAt` entries) smear a layer of this
 * size, in layer units: the length of the line, or how far the farthest corner travels. The
 * quality checker counts it as blur while a layer moves (a whip pan with a directional blur does
 * not judder).
 */
export function smearLength(active, { width = 0, height = 0 } = {}) {
  let smear = 0;
  for (const { effect, parameters = {} } of active) {
    if (!DEFAULTS.has(effect?.key)) continue;
    const value = (key) => (Number.isFinite(parameters[key]) ? parameters[key] : DEFAULTS.get(effect.key)[key]);
    if (effect.key === "directional-blur") { smear += Math.abs(value("length")); continue; }
    const reach = Math.hypot(Math.max(value("centerX"), 1 - value("centerX")) * width, Math.max(value("centerY"), 1 - value("centerY")) * height);
    smear += effect.key === "zoom-blur" ? Math.abs(value("amount")) * reach : Math.abs(value("angle")) * Math.PI / 180 * reach;
  }
  return smear;
}

/** The smallest power of two at or above one sample per pixel of travel, from 2 up to `max`. */
export function sampleCount(travelPixels, max) {
  if (!(travelPixels > 1)) return 2;
  return Math.min(max, 2 ** Math.ceil(Math.log2(travelPixels)));
}

/**
 * How many copies a zoom or spin blur may draw of `content`, and how: copies of the picture that
 * the content already draws (another zoom or spin blur, marked data-blur-copies) share one budget
 * of MAX_BLUR_COPIES; content with an SVG filter gets at most MAX_FILTERED_COPIES copies.
 */
export function copyBudget(content) {
  let inside = 1;
  for (const match of String(content).matchAll(/data-blur-copies="(\d+)"/g)) inside = Math.max(inside, Number(match[1]));
  const filtered = /\sfilter="url\(/.test(content);
  const room = Math.max(2, MAX_BLUR_COPIES / inside);
  const limit = 2 ** Math.floor(Math.log2(filtered ? Math.min(room, MAX_FILTERED_COPIES) : room));
  return { limit, inside };
}

// The mean of the copies, mixed two at a time. Each pair is an isolated group: the first copy at
// half opacity plus the second at half opacity (plus-lighter adds them), so every copy counts
// exactly 1/N. A flat stack of N copies at 1/N opacity drifts several levels in 8-bit colour.
// Resvg has no plus-lighter: there (unit tests, layer captures without Chromium) the second copy
// goes over the first at half opacity, which is the same mean for opaque pictures.
export function averageCopies(items, { raster = false } = {}) {
  if (items.length === 1) return items[0];
  const middle = items.length / 2;
  const left = averageCopies(items.slice(0, middle), { raster });
  const right = averageCopies(items.slice(middle), { raster });
  return raster
    ? `<g><g>${left}</g><g opacity="0.5">${right}</g></g>`
    : `<g style="isolation:isolate"><g opacity="0.5">${left}</g><g opacity="0.5" style="mix-blend-mode:plus-lighter">${right}</g></g>`;
}

export function renderDirectionalBlur(frame) {
  const length = read(frame, "directional-blur", "length");
  const angle = read(frame, "directional-blur", "angle");
  const travel = length * layerPixelScale(frame);
  if (travel < 0.5) return frame.content;
  const steps = Math.max(1, Math.min(MAX_DIRECTIONAL_STEPS, Math.ceil(Math.log2(Math.max(2, travel)))));
  const copies = 2 ** steps, spacing = length / copies;
  const radians = angle * Math.PI / 180, ux = Math.cos(radians), uy = Math.sin(radians);
  // The copies run from 0 to length - spacing past the start, so the picture is first moved back
  // half that far: the smear is centred on the layer, and every step's result stays inside the
  // filter area (a step that reached past it would be cut off there).
  const back = -(length - spacing) / 2;
  const primitives = [`<feOffset in="SourceGraphic" dx="${fmt(back * ux)}" dy="${fmt(back * uy)}" result="directionalStart"/>`];
  let input = "directionalStart";
  for (let step = 0, distance = spacing; step < steps; step += 1, distance *= 2) {
    primitives.push(`<feOffset in="${input}" dx="${fmt(distance * ux)}" dy="${fmt(distance * uy)}" result="directionalShift${step}"/>`);
    primitives.push(`<feComposite in="${input}" in2="directionalShift${step}" operator="arithmetic" k2="0.5" k3="0.5" result="directionalMean${step}"/>`);
    input = `directionalMean${step}`;
  }
  return filterEffect(frame, primitives, { padding: length / 2 + 1 });
}

function centerPoint(frame, effectKey) {
  const { x, y, width, height } = frame.bounds;
  return [x + width * read(frame, effectKey, "centerX"), y + height * read(frame, effectKey, "centerY")];
}

function transformedBounds(box, matrix) {
  const [a, b, c, d, e, f] = matrix;
  const points = corners(box).map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function unionBounds(boxes) {
  const left = Math.min(...boxes.map((box) => box.x)), top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: Math.max(0.001, right - left), height: Math.max(0.001, bottom - top) };
}

// The copies are <use> copies of one definition of the layer with a home rectangle (see the notes
// on copies at the top, and copySource in svg.js).
function copiesBlur(frame, matrices, budget) {
  const paint = paintOf(frame);
  const source = copySource(frame, { home: frame.drawnBounds ?? paint });
  const items = matrices.map((matrix) => `<g transform="matrix(${matrix.map(fmt).join(" ")})">${source}</g>`);
  frame.helpers.includeBounds?.(unionBounds(matrices.map((matrix) => transformedBounds(paint, matrix))));
  const copies = `<g data-blur-copies="${matrices.length * budget.inside}">${averageCopies(items, { raster: Boolean(frame.helpers.raster) })}</g>`;
  return copiesEffect(frame, copies);
}

function farthest(frame, cx, cy) {
  return Math.max(...corners(paintOf(frame)).map(([x, y]) => Math.hypot(x - cx, y - cy)));
}

// Zoom blur: copies scaled about the centre from 1 to 1 + amount (evenly in log scale, as a
// steady camera zoom during the shutter). Every copy is at least the layer's size, so a picture
// that fills the frame still fills it.
export function renderZoomBlur(frame) {
  const amount = read(frame, "zoom-blur", "amount");
  const [cx, cy] = centerPoint(frame, "zoom-blur");
  const travel = farthest(frame, cx, cy) * amount * layerPixelScale(frame);
  if (travel < 0.5) return frame.content;
  const budget = copyBudget(frame.content);
  const count = sampleCount(travel, budget.limit), range = Math.log1p(amount);
  const matrices = Array.from({ length: count }, (_, index) => {
    const scale = Math.exp(range * (index + 0.5) / count);
    return [scale, 0, 0, scale, cx - scale * cx, cy - scale * cy];
  });
  return copiesBlur(frame, matrices, budget);
}

// Spin blur: copies turned about the centre from -angle/2 to +angle/2.
export function renderSpinBlur(frame) {
  const angle = read(frame, "spin-blur", "angle");
  const [cx, cy] = centerPoint(frame, "spin-blur");
  const radians = angle * Math.PI / 180;
  const travel = farthest(frame, cx, cy) * radians * layerPixelScale(frame);
  if (travel < 0.5) return frame.content;
  const budget = copyBudget(frame.content);
  const count = sampleCount(travel, budget.limit);
  const matrices = Array.from({ length: count }, (_, index) => {
    const turn = radians * ((index + 0.5) / count - 0.5), cos = Math.cos(turn), sin = Math.sin(turn);
    return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
  });
  return copiesBlur(frame, matrices, budget);
}
