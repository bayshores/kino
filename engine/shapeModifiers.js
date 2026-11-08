// Shape modifiers: a zig zag and an offset path change the outline of a rectangle, ellipse, star
// or path layer before its fill and stroke are drawn. The zig zag runs first, then the offset.
//
// Fields on the layer (absent means no modifier; the layer draws as before):
//   zigzagSize     px each point moves off the outline, -1000..1000 (0 = off); animates
//   zigzagCount    teeth on each segment of the outline (a side, a quarter of an ellipse), 1..100 (5); animates
//   zigzagPoints   "corner" (sharp teeth) or "smooth" (a wave) ("corner")
//   offsetAmount   px the outline grows (or shrinks, below 0), -1000..1000 (0 = off); animates
//   offsetJoin     how grown corners join: "miter", "round" or "bevel" ("miter")
// Peaks of the zig zag sit on the outline's corners and segment ends. Curves are offset as fine
// straight pieces; an outline shrunk past its middle disappears.
export const MODIFIER_LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path"]);
export const MODIFIER_REST = Object.freeze({ zigzagSize: 0, zigzagCount: 5, offsetAmount: 0 });
export const MODIFIER_KEYS = Object.keys(MODIFIER_REST);
export const MODIFIER_CHOICES = Object.freeze({ zigzagPoints: ["corner", "smooth"], offsetJoin: ["miter", "round", "bevel"] });
export const MODIFIER_CHOICE_KEYS = Object.keys(MODIFIER_CHOICES);
const RANGES = { zigzagSize: [-1000, 1000], zigzagCount: [1, 100], offsetAmount: [-1000, 1000] };
const MITER_LIMIT = 4;
const ROUND_STEP = Math.PI / 18;
const MAX_POINTS = 20_000;

/** The range a modifier number accepts: [min, max]. */
export const modifierRange = (key) => RANGES[key];

const finite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const clamp = (value, [min, max]) => Math.max(min, Math.min(max, value));
const number = (state, key) => clamp(finite(state[key], MODIFIER_REST[key]), RANGES[key]);

/** The modifiers of a layer state, or null when it has none. */
export function modifiersOf(state = {}) {
  if (!MODIFIER_LAYER_TYPES.has(state.type)) return null;
  const size = number(state, "zigzagSize"), amount = number(state, "offsetAmount");
  if (!size && !amount) return null;
  return {
    zigzag: size ? { size, count: Math.round(number(state, "zigzagCount")), smooth: state.zigzagPoints === "smooth" } : null,
    offset: amount ? { amount, join: MODIFIER_CHOICES.offsetJoin.includes(state.offsetJoin) ? state.offsetJoin : "miter" } : null,
  };
}

/** How far past the outline the modifiers can draw, in px. */
export function modifierReach(state) {
  const modifiers = modifiersOf(state);
  if (!modifiers) return 0;
  const zig = modifiers.zigzag ? Math.abs(modifiers.zigzag.size) * (modifiers.zigzag.smooth ? 1.5 : MITER_LIMIT) : 0;
  const grow = Math.max(0, modifiers.offset?.amount ?? 0) * (modifiers.offset?.join === "miter" ? MITER_LIMIT : 1);
  return zig + grow;
}

/** `contours` (vectorPath.js form) with the state's modifiers applied. */
export function modifyContours(contours, state) {
  const modifiers = modifiersOf(state);
  if (!modifiers) return contours;
  const sign = outwardSign(contours);
  let result = contours;
  if (modifiers.zigzag) result = result.map((contour) => zigzag(contour, modifiers.zigzag, sign));
  if (modifiers.offset) result = result.map((contour) => offset(contour, modifiers.offset, sign)).filter(Boolean);
  return result;
}

// --- curve helpers ---
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale = (a, s) => [a[0] * s, a[1] * s];
const length = (a) => Math.hypot(a[0], a[1]);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (a) => { const l = length(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; };

function cubicAt(p0, s, t) {
  const m = 1 - t, a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
  return [a * p0[0] + b * s.c1[0] + c * s.c2[0] + d * s.end[0], a * p0[1] + b * s.c1[1] + c * s.c2[1] + d * s.end[1]];
}

function tangentAt(p0, s, t) {
  const m = 1 - t;
  const d = (i) => 3 * m * m * (s.c1[i] - p0[i]) + 6 * m * t * (s.c2[i] - s.c1[i]) + 3 * t * t * (s.end[i] - s.c2[i]);
  const tangent = [d(0), d(1)];
  // A control point on an end gives no direction there; step inside the curve.
  if (length(tangent) > 1e-9) return unit(tangent);
  return unit(sub(cubicAt(p0, s, Math.min(1, t + 1e-3)), cubicAt(p0, s, Math.max(0, t - 1e-3))));
}

function isStraight(p0, s) {
  const chord = sub(s.end, p0), l = length(chord);
  if (l < 1e-9) return length(sub(s.c1, p0)) < 1e-9 && length(sub(s.c2, p0)) < 1e-9;
  const off = (p) => Math.abs(cross(chord, sub(p, p0))) / l;
  const along = (p) => dot(chord, sub(p, p0)) / (l * l);
  return off(s.c1) < 1e-6 * Math.max(1, l) && off(s.c2) < 1e-6 * Math.max(1, l) &&
    along(s.c1) >= -1e-9 && along(s.c1) <= 1 + 1e-9 && along(s.c2) >= -1e-9 && along(s.c2) <= 1 + 1e-9;
}

// Arc-length table of a cubic: [t, distance] pairs.
function lengthTable(p0, s, steps = 32) {
  const table = [[0, 0]];
  let previous = p0, total = 0;
  for (let i = 1; i <= steps; i += 1) {
    const point = cubicAt(p0, s, i / steps);
    total += length(sub(point, previous));
    table.push([i / steps, total]);
    previous = point;
  }
  return table;
}

function tAtDistance(table, distance) {
  for (let i = 1; i < table.length; i += 1) {
    if (table[i][1] >= distance) {
      const [t0, d0] = table[i - 1], [t1, d1] = table[i];
      return d1 > d0 ? t0 + ((distance - d0) / (d1 - d0)) * (t1 - t0) : t1;
    }
  }
  return 1;
}

const segmentsOf = (contour) => contour.segments.map((segment, index) =>
  ({ from: index ? contour.segments[index - 1].end : contour.start, segment }));

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) area += cross(points[i], points[(i + 1) % points.length]);
  return area / 2;
}

const contourPoints = (contour) => segmentsOf(contour).flatMap(({ from, segment }) =>
  [1, 2, 3, 4].map((step) => cubicAt(from, segment, step / 4)));

// +1 when (dy, -dx) points away from the fill, judged by the largest contour; holes run the
// other way, so the same rule grows the fill around them too.
function outwardSign(contours) {
  let best = 0;
  for (const contour of contours) {
    const area = signedArea(contourPoints(contour));
    if (Math.abs(area) > Math.abs(best)) best = area;
  }
  return best < 0 ? -1 : 1;
}

const normalOf = (direction, sign) => [direction[1] * sign, -direction[0] * sign];
const lineSegment = (from, to) => ({ c1: add(from, scale(sub(to, from), 1 / 3)), c2: add(from, scale(sub(to, from), 2 / 3)), end: [...to] });

function polylineContour(points, closed) {
  if (!points.length) return null;
  const segments = [];
  for (let i = 1; i < points.length; i += 1) segments.push(lineSegment(points[i - 1], points[i]));
  if (closed) segments.push(lineSegment(points.at(-1), points[0]));
  return { start: [...points[0]], segments, closed };
}

// Uniform Catmull-Rom curves through `points`.
function smoothContour(points, closed) {
  const n = points.length;
  if (n < 3) return polylineContour(points, closed);
  const at = (i) => closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))];
  const segments = [];
  for (let i = 0; i < (closed ? n : n - 1); i += 1) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    segments.push({ c1: add(p1, scale(sub(p2, p0), 1 / 6)), c2: sub(p2, scale(sub(p3, p1), 1 / 6)), end: [...p2] });
  }
  return { start: [...points[0]], segments, closed };
}

// --- zig zag ---
function zigzag(contour, { size, count, smooth }, sign) {
  const parts = segmentsOf(contour).map((part) => ({ ...part, table: lengthTable(part.from, part.segment) }))
    .filter((part) => part.table.at(-1)[1] > 1e-6);
  if (!parts.length) return contour;
  const steps = Math.min(count * 2, Math.floor(MAX_POINTS / parts.length / 2) * 2 || 2);
  const points = [];
  const corner = (incoming, outgoing) => {
    const sum = add(normalOf(incoming, sign), normalOf(outgoing, sign));
    return length(sum) > 1e-9 ? unit(sum) : normalOf(outgoing, sign);
  };
  parts.forEach((part, index) => {
    const { from, segment, table } = part, total = table.at(-1)[1];
    for (let k = 0; k < steps; k += 1) {
      const t = tAtDistance(table, (total * k) / steps);
      let normal = normalOf(tangentAt(from, segment, t), sign);
      if (k === 0 && (index > 0 || contour.closed)) {
        const before = parts[(index - 1 + parts.length) % parts.length];
        normal = corner(tangentAt(before.from, before.segment, 1), tangentAt(from, segment, 0));
      }
      points.push(add(cubicAt(from, segment, t), scale(normal, k % 2 ? -size : size)));
    }
  });
  if (!contour.closed) {
    const last = parts.at(-1);
    points.push(add(last.segment.end, scale(normalOf(tangentAt(last.from, last.segment, 1), sign), steps % 2 ? -size : size)));
  }
  return smooth ? smoothContour(points, contour.closed) : polylineContour(points, contour.closed);
}

// --- offset path ---
function flatten(contour) {
  const points = [];
  for (const { from, segment } of segmentsOf(contour)) {
    if (isStraight(from, segment)) { points.push(from); continue; }
    const total = lengthTable(from, segment, 16).at(-1)[1];
    const pieces = Math.max(4, Math.min(64, Math.ceil(total / 3)));
    for (let j = 0; j < pieces; j += 1) points.push(cubicAt(from, segment, j / pieces));
  }
  points.push(contour.segments.at(-1)?.end ?? contour.start);
  const clean = points.filter((point, index) => !index || length(sub(point, points[index - 1])) > 1e-9);
  if (contour.closed && clean.length > 1 && length(sub(clean[0], clean.at(-1))) < 1e-9) clean.pop();
  return clean;
}

function offset(contour, { amount, join }, sign) {
  const points = flatten(contour);
  const closed = contour.closed;
  if (points.length < 2) return closed ? null : contour;
  const edgeCount = closed ? points.length : points.length - 1;
  const directions = Array.from({ length: edgeCount }, (_, i) => unit(sub(points[(i + 1) % points.length], points[i])));
  const normals = directions.map((direction) => normalOf(direction, sign));
  const out = [], anchors = [];
  for (let j = 0; j < points.length; j += 1) {
    const point = points[j];
    if (!closed && (j === 0 || j === points.length - 1)) {
      out.push(add(point, scale(normals[j === 0 ? 0 : edgeCount - 1], amount)));
      continue;
    }
    const n1 = normals[(j - 1 + edgeCount) % edgeCount], n2 = normals[j % edgeCount];
    const a = add(point, scale(n1, amount)), b = add(point, scale(n2, amount));
    const cosine = dot(n1, n2);
    if (cosine > 1 - 1e-12) { out.push(a); anchors.push(a); continue; }
    if (1 + cosine < 1e-9) { out.push(a, b); anchors.push(a); continue; }
    const miter = add(point, scale(add(n1, n2), amount / (1 + cosine)));
    anchors.push(miter);
    const turn = Math.acos(Math.max(-1, Math.min(1, cosine)));
    const gap = cross(directions[(j - 1 + edgeCount) % edgeCount], directions[j % edgeCount]) * sign * amount > 0;
    // Gentle turns (fine pieces of a curve) and the inner side of a corner meet at the miter point.
    if (!gap || turn < ROUND_STEP) { out.push(miter); continue; }
    if (join === "miter" && Math.sqrt(2 / (1 + cosine)) <= MITER_LIMIT) out.push(miter);
    else if (join === "round") {
      const start = Math.atan2(n1[1], n1[0]), steps = Math.ceil(turn / ROUND_STEP);
      const direction = cross(n1, n2) >= 0 ? 1 : -1;
      for (let s = 0; s <= steps; s += 1) {
        const angle = start + (direction * turn * s) / steps;
        out.push(add(point, [Math.cos(angle) * amount, Math.sin(angle) * amount]));
      }
    } else out.push(a, b);
  }
  // A closed outline shrunk past its middle turns inside out (its winding flips, or most of its
  // edges run backward): it is gone.
  if (closed && insideOut(points, anchors, directions)) return null;
  return polylineContour(out, closed);
}

function insideOut(points, anchors, directions) {
  if (Math.sign(signedArea(anchors)) !== Math.sign(signedArea(points))) return true;
  let total = 0, backward = 0;
  directions.forEach((direction, i) => {
    const edge = length(sub(points[(i + 1) % points.length], points[i]));
    total += edge;
    if (dot(sub(anchors[(i + 1) % anchors.length], anchors[i]), direction) < 0) backward += edge;
  });
  return backward * 2 >= total;
}
