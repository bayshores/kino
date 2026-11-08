// Shape modifiers change the outline of a rectangle, ellipse, star or path layer before its fill
// and stroke are drawn, in this order: round corners, pucker/bloat, twist, zig zag, offset path.
//
// Fields on the layer (absent means no modifier; the layer draws as before):
//   roundCorners   px radius for every sharp corner, 0..1000 (0 = off); animates
//   bloatAmount    -1..1 (0 = off): above 0 points move in and sides bow out (bloat),
//                  below 0 points move out and sides pinch in (pucker); animates
//   twistAngle     degrees the outline's farthest point turns around the center, -3600..3600
//                  (0 = off); nearer points turn less; animates
//   twistX, twistY the twist center, px from the layer's middle, -10000..10000 (0); animate
//   zigzagSize     px each point moves off the outline, -1000..1000 (0 = off); animates
//   zigzagCount    teeth on each segment of the outline (a side, a quarter of an ellipse), 1..100 (5); animates
//   zigzagPoints   "corner" (sharp teeth) or "smooth" (a wave) ("corner")
//   offsetAmount   px the outline grows (or shrinks, below 0), -1000..1000 (0 = off); animates
//   offsetJoin     how grown corners join: "miter", "round" or "bevel" ("miter")
// Peaks of the zig zag sit on the outline's corners and segment ends. Curves are offset and
// twisted as fine straight pieces; an outline shrunk past its middle disappears.
export const MODIFIER_LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path"]);
export const MODIFIER_REST = Object.freeze({ roundCorners: 0, bloatAmount: 0, twistAngle: 0, twistX: 0, twistY: 0, zigzagSize: 0, zigzagCount: 5, offsetAmount: 0 });
export const MODIFIER_KEYS = Object.keys(MODIFIER_REST);
export const MODIFIER_CHOICES = Object.freeze({ zigzagPoints: ["corner", "smooth"], offsetJoin: ["miter", "round", "bevel"] });
export const MODIFIER_CHOICE_KEYS = Object.keys(MODIFIER_CHOICES);
const RANGES = { roundCorners: [0, 1000], bloatAmount: [-1, 1], twistAngle: [-3600, 3600], twistX: [-10000, 10000], twistY: [-10000, 10000],
  zigzagSize: [-1000, 1000], zigzagCount: [1, 100], offsetAmount: [-1000, 1000] };
const MITER_LIMIT = 4;
const ROUND_STEP = Math.PI / 18;
const MAX_POINTS = 20_000;
const TWIST_STEP = 3;

/** The range a modifier number accepts: [min, max]. */
export const modifierRange = (key) => RANGES[key];

const finite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const clamp = (value, [min, max]) => Math.max(min, Math.min(max, value));
const number = (state, key) => clamp(finite(state[key], MODIFIER_REST[key]), RANGES[key]);

/** The modifiers of a layer state, or null when it has none. */
export function modifiersOf(state = {}) {
  if (!MODIFIER_LAYER_TYPES.has(state.type)) return null;
  const round = number(state, "roundCorners"), bloat = number(state, "bloatAmount"), twist = number(state, "twistAngle");
  const size = number(state, "zigzagSize"), amount = number(state, "offsetAmount");
  if (!round && !bloat && !twist && !size && !amount) return null;
  const width = Math.max(0, finite(state.width, 0)), height = Math.max(0, finite(state.height, 0));
  return {
    round: round || null,
    bloat: bloat || null,
    twist: twist ? { angle: (twist * Math.PI) / 180, center: [width / 2 + number(state, "twistX"), height / 2 + number(state, "twistY")] } : null,
    zigzag: size ? { size, count: Math.round(number(state, "zigzagCount")), smooth: state.zigzagPoints === "smooth" } : null,
    offset: amount ? { amount, join: MODIFIER_CHOICES.offsetJoin.includes(state.offsetJoin) ? state.offsetJoin : "miter" } : null,
  };
}

/** How far past the outline the modifiers can draw, in px. */
export function modifierReach(state) {
  const modifiers = modifiersOf(state);
  if (!modifiers) return 0;
  const width = Math.max(0, finite(state.width, 0)), height = Math.max(0, finite(state.height, 0));
  // A bloat moves points at most its amount times the box diagonal.
  let reach = Math.abs(modifiers.bloat ?? 0) * Math.hypot(width, height);
  if (modifiers.twist) {
    // Twisted points keep their distance from the center.
    const dx = Math.abs(modifiers.twist.center[0] - width / 2), dy = Math.abs(modifiers.twist.center[1] - height / 2);
    const far = Math.hypot(width / 2 + dx + reach, height / 2 + dy + reach);
    reach = Math.max(reach, dx + far - width / 2, dy + far - height / 2);
  }
  const zig = modifiers.zigzag ? Math.abs(modifiers.zigzag.size) * (modifiers.zigzag.smooth ? 1.5 : MITER_LIMIT) : 0;
  const grow = Math.max(0, modifiers.offset?.amount ?? 0) * (modifiers.offset?.join === "miter" ? MITER_LIMIT : 1);
  return reach + zig + grow;
}

/** `contours` (vectorPath.js form) with the state's modifiers applied. */
export function modifyContours(contours, state) {
  const modifiers = modifiersOf(state);
  if (!modifiers) return contours;
  const sign = outwardSign(contours);
  let result = contours.map(cleanContour);
  if (modifiers.round) result = result.map((contour) => roundCorners(contour, modifiers.round));
  if (modifiers.bloat) result = result.map((contour) => bloat(contour, modifiers.bloat));
  if (modifiers.twist) result = twist(result, modifiers.twist);
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

// Drops segments of no length and writes a closed contour's closing edge out.
function cleanContour(contour) {
  const near = (a, b) => length(sub(a, b)) < 1e-9;
  const segments = segmentsOf(contour).filter(({ from, segment }) => !(near(from, segment.end) && near(from, segment.c1) && near(from, segment.c2)))
    .map(({ segment }) => segment);
  const end = segments.at(-1)?.end ?? contour.start;
  if (contour.closed && segments.length && !near(end, contour.start)) segments.push(lineSegment(end, contour.start));
  return { start: [...contour.start], segments, closed: contour.closed };
}

// de Casteljau split of a cubic at t: the two halves.
function splitCubic(p0, s, t) {
  const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(p0, s.c1), b = lerp(s.c1, s.c2), c = lerp(s.c2, s.end);
  const d = lerp(a, b), e = lerp(b, c), f = lerp(d, e);
  return [{ c1: a, c2: d, end: f }, { c1: e, c2: c, end: [...s.end] }];
}

// The piece of a cubic from t0 to t1, as { from, segment }.
function subCubic(p0, s, t0, t1) {
  const left = t1 < 1 ? splitCubic(p0, s, t1)[0] : s;
  if (t0 <= 0) return { from: p0, segment: left };
  const [head, tail] = splitCubic(p0, left, t0 / t1);
  return { from: head.end, segment: tail };
}

// --- round corners ---
function roundCorners(contour, radius) {
  const parts = segmentsOf(contour).map((part) => ({ ...part, table: lengthTable(part.from, part.segment) }));
  const n = parts.length;
  if (n < 2 && !(contour.closed && n === 1)) return contour;
  // cut[j]: how far back each side of the corner at the start of part j is cut.
  const cut = parts.map((part, j) => {
    if (j === 0 && !contour.closed) return 0;
    const before = parts[(j - 1 + n) % n];
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(tangentAt(before.from, before.segment, 1), tangentAt(part.from, part.segment, 0)))));
    if (turn < Math.PI / 360 || turn > Math.PI * 0.995) return 0;
    return radius * Math.tan(turn / 2);
  });
  // Each side gives a corner at most half its length.
  const limit = parts.map((part) => part.table.at(-1)[1] / 2);
  const cutAt = cut.map((value, j) => Math.min(value, limit[j], limit[(j - 1 + n) % n]));
  const pieces = [];
  parts.forEach((part, j) => {
    const total = part.table.at(-1)[1];
    const head = cutAt[j], tail = cutAt[(j + 1) % n] * (j === n - 1 && !contour.closed ? 0 : 1);
    if (head > 1e-9) {
      const before = parts[(j - 1 + n) % n], beforeTotal = before.table.at(-1)[1];
      const tBefore = tAtDistance(before.table, beforeTotal - head), tHere = tAtDistance(part.table, head);
      const from = cubicAt(before.from, before.segment, tBefore), to = cubicAt(part.from, part.segment, tHere);
      const d1 = tangentAt(before.from, before.segment, tBefore), d2 = tangentAt(part.from, part.segment, tHere);
      const turn = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
      const chord = length(sub(to, from));
      // A circular arc's handle: 4/3 tan(turn/4) of its radius.
      const handle = turn > 1e-6 ? ((4 / 3) * Math.tan(turn / 4) * chord) / (2 * Math.sin(turn / 2)) : chord / 3;
      pieces.push({ from, segment: { c1: add(from, scale(d1, handle)), c2: sub(to, scale(d2, handle)), end: to } });
    }
    if (total - head - tail > 1e-9)
      pieces.push(subCubic(part.from, part.segment, head > 1e-9 ? tAtDistance(part.table, head) : 0, tail > 1e-9 ? tAtDistance(part.table, total - tail) : 1));
  });
  if (!pieces.length) return contour;
  return { start: [...pieces[0].from], segments: pieces.map(({ segment }) => segment), closed: contour.closed };
}

// --- pucker and bloat ---
// Points move toward the contour's middle by the amount and handles move away (bloat), or the
// other way round below 0 (pucker).
function bloat(contour, amount) {
  const parts = segmentsOf(contour);
  if (!parts.length) return contour;
  const anchors = contour.closed ? parts.map(({ from }) => from) : [...parts.map(({ from }) => from), parts.at(-1).segment.end];
  const center = scale(anchors.reduce(add, [0, 0]), 1 / anchors.length);
  const move = (point, by) => add(point, scale(sub(center, point), by));
  return {
    start: move(contour.start, amount), closed: contour.closed,
    segments: contour.segments.map((s) => ({ c1: move(s.c1, -amount), c2: move(s.c2, -amount), end: move(s.end, amount) })),
  };
}

// --- twist ---
// Fine points turn around the center by the angle times their distance over the farthest one's.
function twist(contours, { angle, center }) {
  const total = contours.reduce((sum, contour) => sum + segmentsOf(contour)
    .reduce((acc, { from, segment }) => acc + lengthTable(from, segment, 16).at(-1)[1], 0), 0);
  const step = Math.max(TWIST_STEP, total / MAX_POINTS);
  const sampled = contours.map((contour) => {
    const points = [];
    for (const { from, segment } of segmentsOf(contour)) {
      const pieces = Math.max(1, Math.ceil(lengthTable(from, segment, 16).at(-1)[1] / step));
      for (let j = 0; j < pieces; j += 1) points.push(cubicAt(from, segment, j / pieces));
    }
    if (!contour.closed || !contour.segments.length) points.push(contour.segments.at(-1)?.end ?? contour.start);
    return { points, closed: contour.closed };
  });
  const far = Math.max(0, ...sampled.flatMap(({ points }) => points.map((point) => length(sub(point, center)))));
  if (far < 1e-9) return contours;
  const turn = (point) => {
    const offset = sub(point, center), a = (angle * length(offset)) / far;
    const cos = Math.cos(a), sin = Math.sin(a);
    return add(center, [offset[0] * cos - offset[1] * sin, offset[0] * sin + offset[1] * cos]);
  };
  return sampled.map(({ points, closed }) => polylineContour(points.map(turn), closed)).filter(Boolean);
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
