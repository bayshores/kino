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
//   roughenSize    px a rough, brush-like edge reaches off the outline, 0..500 (0 = off); animates
//   roughenDetail  0..1 (0.5): how fine and spiky the teeth are (0 = soft bumps, 1 = dense hairs)
//   roughenSeed    0..9999 (0): which edge; the same seed draws the same teeth every frame
//   roughenBoil    0..30 (0 = still): new teeth this many times a second (12 = "on twos" at 24 fps)
// Peaks of the zig zag sit on the outline's corners and segment ends. Curves are offset and
// twisted as fine straight pieces; an outline shrunk past its middle disappears. Each step keeps
// the outline under a point budget (fewer teeth or coarser pieces past it) so the path can draw.
// Roughen runs after the zig zag and before the offset path.
export const MODIFIER_LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path"]);
export const MODIFIER_REST = Object.freeze({ roundCorners: 0, bloatAmount: 0, twistAngle: 0, twistX: 0, twistY: 0, zigzagSize: 0, zigzagCount: 5, offsetAmount: 0,
  roughenSize: 0, roughenDetail: 0.5, roughenSeed: 0, roughenBoil: 0 });
export const MODIFIER_KEYS = Object.keys(MODIFIER_REST);
export const MODIFIER_CHOICES = Object.freeze({ zigzagPoints: ["corner", "smooth"], offsetJoin: ["miter", "round", "bevel"] });
export const MODIFIER_CHOICE_KEYS = Object.keys(MODIFIER_CHOICES);
const RANGES = { roundCorners: [0, 1000], bloatAmount: [-1, 1], twistAngle: [-3600, 3600], twistX: [-10000, 10000], twistY: [-10000, 10000],
  zigzagSize: [-1000, 1000], zigzagCount: [1, 100], offsetAmount: [-1000, 1000],
  roughenSize: [0, 500], roughenDetail: [0, 1], roughenSeed: [0, 9999], roughenBoil: [0, 30] };
const MITER_LIMIT = 4;
const ROUND_STEP = Math.PI / 18;
// Point budgets. vectorPath.js draws at most 10,000 segments and 1,000,000 characters (about
// 130 a segment), so the result stays at or under OUTLINE_LIMIT.
export const OUTLINE_LIMIT = 7000;
const TWIST_POINTS = 3000;
const ZIGZAG_POINTS = 3000;
const TWIST_STEP = 3;
const ROUGHEN_POINTS = 3000;
// Longest reach of a roughen point, times its size: 0.3 of a lobe plus the longest hair.
const ROUGHEN_REACH = 2.3;

/** The range a modifier number accepts: [min, max]. */
export const modifierRange = (key) => RANGES[key];

const finite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const clamp = (value, [min, max]) => Math.max(min, Math.min(max, value));
const number = (state, key) => clamp(finite(state[key], MODIFIER_REST[key]), RANGES[key]);

/** The modifiers of a layer state, or null when it has none. `time` (s) moves a boiling roughen. */
export function modifiersOf(state = {}, time = 0) {
  if (!MODIFIER_LAYER_TYPES.has(state.type)) return null;
  const round = number(state, "roundCorners"), bloat = number(state, "bloatAmount"), twist = number(state, "twistAngle");
  const size = number(state, "zigzagSize"), amount = number(state, "offsetAmount"), rough = number(state, "roughenSize");
  if (!round && !bloat && !twist && !size && !amount && !rough) return null;
  const boil = number(state, "roughenBoil");
  // A boiling edge draws a new seed each 1/boil s; the small step keeps 1/12 s steps exact.
  const step = boil > 0 ? Math.floor(finite(time, 0) * boil + 1e-6) : 0;
  const width = Math.max(0, finite(state.width, 0)), height = Math.max(0, finite(state.height, 0));
  return {
    round: round || null,
    bloat: bloat || null,
    twist: twist ? { angle: (twist * Math.PI) / 180, center: [width / 2 + number(state, "twistX"), height / 2 + number(state, "twistY")] } : null,
    zigzag: size ? { size, count: Math.round(number(state, "zigzagCount")), smooth: state.zigzagPoints === "smooth" } : null,
    offset: amount ? { amount, join: MODIFIER_CHOICES.offsetJoin.includes(state.offsetJoin) ? state.offsetJoin : "miter" } : null,
    roughen: rough ? { size: rough, detail: number(state, "roughenDetail"), seed: Math.round(number(state, "roughenSeed")) + step * 7919 } : null,
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
  const rough = (modifiers.roughen?.size ?? 0) * ROUGHEN_REACH;
  // Outer miters and inner corners move at most MITER_LIMIT x the amount.
  const grow = Math.abs(modifiers.offset?.amount ?? 0) * MITER_LIMIT;
  return reach + zig + rough + grow;
}

/** `contours` (vectorPath.js form) with the state's modifiers applied at `time` seconds. */
export function modifyContours(contours, state, time = 0) {
  const modifiers = modifiersOf(state, time);
  if (!modifiers) return contours;
  const sign = outwardSign(contours);
  let result = contours.map(cleanContour);
  if (modifiers.round) result = result.map((contour) => roundCorners(contour, modifiers.round));
  if (modifiers.bloat) result = result.map((contour) => bloat(contour, modifiers.bloat));
  if (modifiers.twist) result = twist(result, modifiers.twist);
  if (modifiers.zigzag) result = result.map((contour) => zigzag(contour, modifiers.zigzag, sign));
  if (modifiers.roughen) result = roughen(result, modifiers.roughen, sign);
  if (modifiers.offset) {
    const plans = result.map(flattenPlan);
    const total = plans.reduce((sum, plan) => sum + plan.count, 0) || 1;
    result = result.map((contour, i) => offset(contour, modifiers.offset, sign, Math.max(8, Math.floor((OUTLINE_LIMIT * plans[i].count) / total)), plans[i]))
      .filter(Boolean);
  }
  return withinLimit(result.map(({ start, segments, closed }) => ({ start, segments, closed })));
}

// Last resort for outlines still over the budget (say a path of thousands of segments): keep
// every k-th point as straight pieces.
function withinLimit(contours) {
  const total = contours.reduce((sum, contour) => sum + contour.segments.length, 0);
  if (total <= OUTLINE_LIMIT) return contours;
  const stride = Math.ceil(total / (OUTLINE_LIMIT - contours.length));
  return contours.map((contour) => {
    const ends = contour.segments.map((segment) => segment.end).filter((_, i) => (i + 1) % stride === 0);
    if (contour.closed && ends.length && length(sub(ends.at(-1), contour.start)) < 1e-9) ends.pop();
    return polylineContour([contour.start, ...ends], contour.closed);
  }).filter((contour) => contour && contour.segments.length);
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
  const step = Math.max(TWIST_STEP, total / TWIST_POINTS);
  const sampled = contours.map((contour) => {
    const points = [], spans = [];
    for (const { from, segment } of segmentsOf(contour)) {
      const pieces = Math.max(1, Math.ceil(lengthTable(from, segment, 16).at(-1)[1] / step));
      for (let j = 0; j < pieces; j += 1) points.push(cubicAt(from, segment, j / pieces));
      spans.push(pieces);
    }
    if (!contour.closed || !contour.segments.length) points.push(contour.segments.at(-1)?.end ?? contour.start);
    return { points, closed: contour.closed, spans: contour.segments.length ? spans : null };
  });
  const far = Math.max(0, ...sampled.flatMap(({ points }) => points.map((point) => length(sub(point, center)))));
  if (far < 1e-9) return contours;
  const turn = (point) => {
    const offset = sub(point, center), a = (angle * length(offset)) / far;
    const cos = Math.cos(a), sin = Math.sin(a);
    return add(center, [offset[0] * cos - offset[1] * sin, offset[0] * sin + offset[1] * cos]);
  };
  // spans: how many straight pieces each original segment became, so a zig zag after the twist
  // still puts its teeth per side.
  return sampled.map(({ points, closed, spans }) => {
    const contour = polylineContour(points.map(turn), closed);
    if (contour && spans) contour.spans = spans;
    return contour;
  }).filter(Boolean);
}

// --- zig zag ---
// Teeth go on each side: a segment, or the run of straight pieces a twist made of one. Past the
// point budget sides take fewer teeth, then neighbor sides share theirs.
function zigzag(contour, { size, count, smooth }, sign) {
  const parts = segmentsOf(contour).map((part) => ({ ...part, table: lengthTable(part.from, part.segment, contour.spans ? 1 : 32) }));
  let sides = [];
  if (contour.spans && contour.spans.reduce((sum, n) => sum + n, 0) === parts.length) {
    let at = 0;
    for (const n of contour.spans) { sides.push(parts.slice(at, at + n)); at += n; }
  } else sides = parts.map((part) => [part]);
  sides = sides.map((side) => side.filter((part) => part.table.at(-1)[1] > 1e-6)).filter((side) => side.length);
  if (!sides.length) return contour;
  if (sides.length * 2 > ZIGZAG_POINTS) {
    const per = Math.ceil((sides.length * 2) / ZIGZAG_POINTS), merged = [];
    for (let i = 0; i < sides.length; i += per) merged.push(sides.slice(i, i + per).flat());
    sides = merged;
  }
  const steps = Math.min(count * 2, Math.max(2, Math.floor(ZIGZAG_POINTS / sides.length / 2) * 2));
  const runs = sides.map((pieces) => {
    let total = 0;
    const starts = pieces.map((piece) => { const start = total; total += piece.table.at(-1)[1]; return start; });
    return { pieces, starts, total, first: pieces[0], last: pieces.at(-1) };
  });
  const along = (run, distance) => {
    let lo = 0, hi = run.pieces.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (run.starts[mid] <= distance) lo = mid; else hi = mid - 1; }
    const { from, segment, table } = run.pieces[lo], t = tAtDistance(table, distance - run.starts[lo]);
    return [cubicAt(from, segment, t), tangentAt(from, segment, t)];
  };
  const points = [];
  const corner = (incoming, outgoing) => {
    const sum = add(normalOf(incoming, sign), normalOf(outgoing, sign));
    return length(sum) > 1e-9 ? unit(sum) : normalOf(outgoing, sign);
  };
  runs.forEach((run, index) => {
    for (let k = 0; k < steps; k += 1) {
      const [point, tangent] = along(run, (run.total * k) / steps);
      let normal = normalOf(tangent, sign);
      if (k === 0 && (index > 0 || contour.closed)) {
        const { last } = runs[(index - 1 + runs.length) % runs.length];
        normal = corner(tangentAt(last.from, last.segment, 1), tangentAt(run.first.from, run.first.segment, 0));
      }
      points.push(add(point, scale(normal, k % 2 ? -size : size)));
    }
  });
  if (!contour.closed) {
    const { last } = runs.at(-1);
    points.push(add(last.segment.end, scale(normalOf(tangentAt(last.from, last.segment, 1), sign), steps % 2 ? -size : size)));
  }
  return smooth ? smoothContour(points, contour.closed) : polylineContour(points, contour.closed);
}

// --- roughen ---
// A dry-brush edge: points along the outline move along its normal by seeded parts, so no two
// teeth match (a zig zag's teeth all do): two smooth bumps (over about 4 and 1.2 sizes of
// outline: the lobes of the stroke), a little grain at every point, and now and then one point
// pulled far out (or, less often, in): a thin brush hair or drag streak. A random offset at every
// point read as saw teeth, so the grain stays small. `detail` sets how close the points sit and
// how many hairs there are. Guess (tuned by eye against one reference brush edge, not measured):
// spacing 0.45 to 0.15 sizes, hairs on 1 point in 20 (detail 0) to 1 in 4 (detail 1), 0.5 to 2 sizes long.
const hash = (seed, index, salt) => {
  let h = Math.imul((seed + 1) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + salt * 0x632be5ab + 1, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};
function bump(seed, x) {
  const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
  return (hash(seed, i, 1) * (1 - s) + hash(seed, i + 1, 1) * s) * 2 - 1;
}

function roughen(contours, { size, detail, seed }, sign) {
  const total = contours.reduce((sum, contour) => sum + segmentsOf(contour)
    .reduce((acc, { from, segment }) => acc + lengthTable(from, segment, 16).at(-1)[1], 0), 0);
  const spacing = Math.max(1.5, size * (0.45 - 0.3 * detail), total / ROUGHEN_POINTS);
  const hairs = 0.05 + 0.2 * detail;
  let index = 0, along = 0;
  return contours.map((contour, which) => {
    const parts = segmentsOf(contour).map((part) => ({ ...part, table: lengthTable(part.from, part.segment, 32) }))
      .filter((part) => part.table.at(-1)[1] > 1e-6);
    if (!parts.length) return contour;
    const points = [];
    const push = (point, normal, distance) => {
      index += 1;
      const lobe = 0.6 * bump(seed + which * 31, distance / (size * 4)) + 0.4 * bump(seed + which * 31 + 17, distance / (size * 1.2));
      let off = lobe + 0.12 * (hash(seed, index, 2) * 2 - 1);
      if (hash(seed, index, 3) < hairs) off = 0.3 * lobe + (hash(seed, index, 5) < 0.7 ? 1 : -1) * (0.5 + hash(seed, index, 4) * 1.5);
      points.push(add(point, scale(normal, off * size)));
    };
    parts.forEach((part, j) => {
      const len = part.table.at(-1)[1], pieces = Math.max(1, Math.round(len / spacing));
      for (let k = 0; k < pieces; k += 1) {
        const t = tAtDistance(part.table, (len * k) / pieces);
        let normal = normalOf(tangentAt(part.from, part.segment, t), sign);
        if (k === 0 && (j > 0 || contour.closed)) {
          const before = parts[(j - 1 + parts.length) % parts.length];
          const sum = add(normalOf(tangentAt(before.from, before.segment, 1), sign), normal);
          if (length(sum) > 1e-9) normal = unit(sum);
        }
        push(cubicAt(part.from, part.segment, t), normal, along + (len * k) / pieces);
      }
      along += len;
    });
    if (!contour.closed) {
      const last = parts.at(-1);
      push(last.segment.end, normalOf(tangentAt(last.from, last.segment, 1), sign), along);
    }
    return polylineContour(points, contour.closed);
  }).filter(Boolean);
}

// --- offset path ---
// Pieces per segment (1 when straight) and their sum.
function flattenPlan(contour) {
  const pieces = segmentsOf(contour).map(({ from, segment }) => isStraight(from, segment) ? 1
    : Math.max(4, Math.min(64, Math.ceil(lengthTable(from, segment, 16).at(-1)[1] / 3))));
  return { pieces, count: pieces.reduce((sum, n) => sum + n, 0) };
}

function flatten(contour, plan, most) {
  const points = [];
  const straight = plan.pieces.filter((n) => n === 1).length, curved = plan.count - straight;
  const share = plan.count > most && curved ? Math.max(0, most - straight) / curved : 1;
  segmentsOf(contour).forEach(({ from, segment }, i) => {
    if (plan.pieces[i] === 1) { points.push(from); return; }
    const pieces = Math.max(1, Math.floor(plan.pieces[i] * share));
    for (let j = 0; j < pieces; j += 1) points.push(cubicAt(from, segment, j / pieces));
  });
  points.push(contour.segments.at(-1)?.end ?? contour.start);
  const clean = points.filter((point, index) => !index || length(sub(point, points[index - 1])) > 1e-9);
  if (contour.closed && clean.length > 1 && length(sub(clean[0], clean.at(-1))) < 1e-9) clean.pop();
  return clean;
}

// room: the most points this contour may end with.
function offset(contour, { amount, join }, sign, room, plan) {
  const points = flatten(contour, plan, Math.floor(room / 2));
  const closed = contour.closed;
  if (points.length < 2) return closed ? null : contour;
  const edgeCount = closed ? points.length : points.length - 1;
  const directions = Array.from({ length: edgeCount }, (_, i) => unit(sub(points[(i + 1) % points.length], points[i])));
  const normals = directions.map((direction) => normalOf(direction, sign));
  const corners = points.map((point, j) => {
    if (!closed && (j === 0 || j === points.length - 1)) return null;
    const n1 = normals[(j - 1 + edgeCount) % edgeCount], n2 = normals[j % edgeCount], cosine = dot(n1, n2);
    const turn = Math.acos(Math.max(-1, Math.min(1, cosine)));
    const gap = cross(directions[(j - 1 + edgeCount) % edgeCount], directions[j % edgeCount]) * sign * amount > 0;
    return { n1, n2, cosine, turn, gap };
  });
  // Round joins share the points left in the room; past it their arcs get coarser.
  let arcStep = ROUND_STEP;
  if (join === "round") {
    const arcs = corners.filter((c) => c && c.gap && c.turn >= ROUND_STEP && c.cosine <= 1 - 1e-12 && 1 + c.cosine >= 1e-9);
    const turns = arcs.reduce((sum, c) => sum + c.turn, 0), spare = room - points.length - 2 * arcs.length;
    if (arcs.length && turns / ROUND_STEP > spare) arcStep = spare > 0 ? turns / spare : Infinity;
  }
  const out = [], anchors = [];
  for (let j = 0; j < points.length; j += 1) {
    const point = points[j];
    if (!corners[j]) {
      out.push(add(point, scale(normals[j === 0 ? 0 : edgeCount - 1], amount)));
      continue;
    }
    const { n1, n2, cosine, turn, gap } = corners[j];
    const a = add(point, scale(n1, amount)), b = add(point, scale(n2, amount));
    if (cosine > 1 - 1e-12) { out.push(a); anchors.push(a); continue; }
    if (1 + cosine < 1e-9) { out.push(a, b); anchors.push(a); continue; }
    const far = Math.sqrt(2 / (1 + cosine)) > MITER_LIMIT;
    // The inner side of a sharp corner (a cusp, a tight bend) stops MITER_LIMIT x the amount away.
    const miter = !gap && far ? add(point, scale(unit(add(n1, n2)), amount * MITER_LIMIT))
      : add(point, scale(add(n1, n2), amount / (1 + cosine)));
    anchors.push(miter);
    // Gentle turns (fine pieces of a curve) and the inner side of a corner meet at the miter point.
    if (!gap || turn < ROUND_STEP) { out.push(miter); continue; }
    if (join === "miter" && !far) out.push(miter);
    else if (join === "round") {
      const start = Math.atan2(n1[1], n1[0]), steps = Math.max(1, Math.ceil(turn / arcStep));
      const direction = cross(n1, n2) >= 0 ? 1 : -1;
      for (let s = 0; s <= steps; s += 1) {
        const angle = start + (direction * turn * s) / steps;
        out.push(add(point, [Math.cos(angle) * amount, Math.sin(angle) * amount]));
      }
    } else out.push(a, b);
  }
  // A closed outline shrunk past its middle turns inside out (its winding flips, or most of its
  // edges run backward): it is gone. An outline that grows (a hole that shrinks) cannot.
  const shrinks = (Math.sign(signedArea(points)) === sign) === amount < 0;
  if (closed && shrinks && insideOut(points, anchors, directions)) return null;
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
