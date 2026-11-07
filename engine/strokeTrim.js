// Trim paths and dashed strokes (Lottie's "tm" and "d").
//
// A shape layer (rectangle, ellipse, star, path) may have:
//   strokeStart, strokeEnd  0..1: the part of each contour the stroke draws (default 0 and 1)
//   strokeOffset            turns of the contour that part is moved along (default 0; wraps)
//   dash                    [on, off, ...] in px, or null for a solid stroke
//   dashOffset              px the dash pattern is shifted along the contour
// Only the stroke is trimmed; the fill keeps the whole shape. Each contour is trimmed by the same
// fractions (Lottie's "simultaneously" mode), and the dash pattern restarts on each contour, as
// SVG and Lottie draw it.
//
// The renderer draws a trim as an SVG stroke-dasharray: trimDash measures nothing itself, it
// turns a contour's length and the fields into one dash list that covers the contour once.
import { parsePath, serializePath } from "./vectorPath.js";
import { clamp01 } from "./numbers.js";

export const TRIM_LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path"]);
export const TRIM_KEYS = ["strokeStart", "strokeEnd", "strokeOffset", "dash", "dashOffset"];

const finite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** The trim and dash fields of a state, with defaults filled in. */
export function trimOf(state = {}) {
  const dash = Array.isArray(state.dash) ? state.dash.map((value) => Math.max(0, finite(value, 0))) : [];
  return {
    start: clamp01(finite(state.strokeStart, 0)),
    end: clamp01(finite(state.strokeEnd, 1)),
    offset: finite(state.strokeOffset, 0),
    dash: dash.reduce((sum, value) => sum + value, 0) > 0 ? dash : [],
    dashOffset: finite(state.dashOffset, 0),
  };
}

/** True when the stroke is trimmed (not the whole contour). */
export function isTrimmed(state) {
  const { start, end } = trimOf(state);
  return Math.abs(end - start) < 1;
}

/** True when the state's stroke needs trim or dash drawing. */
export function hasStrokePattern(state) {
  return isTrimmed(state) || trimOf(state).dash.length > 0;
}

// ---- lengths -------------------------------------------------------------------------------
const STEPS = 32;
const lengthCache = new Map();
const CACHE_LIMIT = 256;

function cubicLength(p0, c1, c2, p3) {
  let length = 0;
  let [px, py] = p0;
  for (let step = 1; step <= STEPS; step += 1) {
    const t = step / STEPS;
    const u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1];
    length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return length;
}

/**
 * Each contour of SVG path data `d` as {d, length}: its own path data (M ... Z) and its length in
 * px, the closing line of a closed contour included. Remembered by `d`, so a still shape is
 * measured once, not on every frame.
 */
export function contourLengths(d) {
  const key = String(d ?? "");
  const known = lengthCache.get(key);
  if (known) return known;
  const contours = parsePath(key);
  const measured = contours.map((contour) => {
    let length = 0;
    let point = contour.start;
    for (const segment of contour.segments) {
      length += cubicLength(point, segment.c1, segment.c2, segment.end);
      point = segment.end;
    }
    if (contour.closed) length += Math.hypot(contour.start[0] - point[0], contour.start[1] - point[1]);
    return length;
  });
  const result = contours.length === 1 ? [{ d: key, length: measured[0] }]
    : contours.map((contour, index) => ({ d: serializePath([contour]), length: measured[index] }));
  if (lengthCache.size >= CACHE_LIMIT) lengthCache.delete(lengthCache.keys().next().value);
  lengthCache.set(key, result);
  return result;
}

// ---- dash lists ----------------------------------------------------------------------------
// The stretches [from, to] (px along a contour of `length`) the trim keeps: one, or two when
// the kept part wraps past the contour's end.
export function trimIntervals(length, trim) {
  const low = Math.min(trim.start, trim.end);
  const span = Math.abs(trim.end - trim.start);
  if (span >= 1) return [[0, length]];
  if (span <= 0 || length <= 0) return [];
  const from = (((low + trim.offset) % 1) + 1) % 1 * length;
  const to = from + span * length;
  return to <= length ? [[from, to]] : [[from, length], [0, to - length]].filter(([a, b]) => b > a);
}

// The stretches the dash pattern draws along [0, length].
function dashIntervals(length, dash, dashOffset) {
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash;
  const period = pattern.reduce((sum, value) => sum + value, 0);
  const intervals = [];
  let position = -(((dashOffset % period) + period) % period);
  let index = 0;
  // Guard against a pattern of hair-thin dashes on a long path.
  for (let count = 0; position < length && count < 20_000; count += 1) {
    const size = pattern[index];
    if (index % 2 === 0 && size > 0) {
      const from = Math.max(0, position);
      const to = Math.min(length, position + size);
      if (to > from) intervals.push([from, to]);
    }
    position += size;
    index = (index + 1) % pattern.length;
  }
  return intervals;
}

/**
 * The dash list that draws a contour of `length` px trimmed and dashed as `state` says.
 * Returns null for a plain stroke, [] for no stroke at all, or the list of on/off lengths (with
 * offset 0) for stroke-dasharray. A dash without a trim keeps its own pattern and offset.
 */
export function trimDash(length, state) {
  const trim = trimOf(state);
  const trimmed = Math.abs(trim.end - trim.start) < 1;
  if (!trimmed && !trim.dash.length) return null;
  if (!trimmed) return { array: trim.dash, offset: trim.dashOffset };
  let kept = trimIntervals(length, trim);
  if (trim.dash.length) {
    // The dashes run along the trimmed line, as Lottie draws them: the pattern
    // starts where the kept part starts (and goes on across a wrap), so it moves with the trim.
    let along = 0;
    kept = kept.flatMap(([a, b]) => {
      const dashes = dashIntervals(along + b - a, trim.dash, trim.dashOffset)
        .map(([c, d]) => [Math.max(c, along), d]).filter(([c, d]) => d > c)
        .map(([c, d]) => [a + c - along, a + d - along]);
      along += b - a;
      return dashes;
    });
  }
  kept.sort((left, right) => left[0] - right[0]);
  if (!kept.length) return { array: [], offset: 0 };
  const array = [];
  let cursor = 0;
  for (const [from, to] of kept) {
    if (!array.length) { if (from > 0) array.push(0, from); }
    else array.push(from - cursor);
    array.push(to - from);
    cursor = to;
  }
  // The last gap runs past the contour's end, so the pattern never starts again on it.
  array.push(length - cursor + length + 1);
  return { array, offset: 0 };
}
