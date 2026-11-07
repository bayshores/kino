export const MAX_MOTION_PATH_POINTS = 64;

const MAX_STORED_COORDINATE = 1_000_000;
const MAX_FLATTEN_DEPTH = 12;
const FLATTEN_RELATIVE_TOLERANCE = 1e-6;
const FLATTEN_ABSOLUTE_TOLERANCE = 1e-4;
const MAX_MEASURE_CACHE_ENTRIES = 32;
const MAX_MEASURE_CACHE_SAMPLES = 100_000;
const MAX_CACHE_ENTRY_SAMPLES = 25_000;
const EPSILON = 1e-12;
const DEFAULT_PATH = Object.freeze({ points: Object.freeze([]), bezierControls: true, alignToPath: false });
const measureCache = new Map();
let cachedMeasureSamples = 0;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${label} contains unsupported field "${key}".`);
  }
}

function coordinate(value, label, limit = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${label} must be a finite number.`);
  if (Math.abs(value) > limit) throw new RangeError(`${label} is outside the supported range.`);
  return value;
}

function normalizeOffset(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an {x, y} object.`);
  rejectUnknownKeys(value, ["x", "y"], label);
  return {
    x: Object.hasOwn(value, "x") ? coordinate(value.x, `${label}.x`, MAX_STORED_COORDINATE) : 0,
    y: Object.hasOwn(value, "y") ? coordinate(value.y, `${label}.y`, MAX_STORED_COORDINATE) : 0,
  };
}

function normalizePoint(value, index) {
  const label = `motionPath.points[${index}]`;
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  rejectUnknownKeys(value, ["x", "y", "in", "out"], label);
  if (!Object.hasOwn(value, "x") || !Object.hasOwn(value, "y"))
    throw new TypeError(`${label} must include x and y coordinates.`);
  return {
    x: coordinate(value.x, `${label}.x`, MAX_STORED_COORDINATE),
    y: coordinate(value.y, `${label}.y`, MAX_STORED_COORDINATE),
    in: Object.hasOwn(value, "in") ? normalizeOffset(value.in, `${label}.in`) : { x: 0, y: 0 },
    out: Object.hasOwn(value, "out") ? normalizeOffset(value.out, `${label}.out`) : { x: 0, y: 0 },
  };
}

/** Validate and clone a stored motion path. Missing and null values stay absent. */
export function normalizeMotionPath(value) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new TypeError("motionPath must be an object.");
  rejectUnknownKeys(value, ["points", "bezierControls", "alignToPath", "alignmentOffset"], "motionPath");

  let points = [];
  if (Object.hasOwn(value, "points")) {
    if (!Array.isArray(value.points)) throw new TypeError("motionPath.points must be an array.");
    if (value.points.length > MAX_MOTION_PATH_POINTS)
      throw new RangeError(`motionPath can have at most ${MAX_MOTION_PATH_POINTS} points.`);
    points = Array.from({ length: value.points.length }, (_, index) => {
      if (!Object.hasOwn(value.points, index)) throw new TypeError(`motionPath.points[${index}] is missing.`);
      return normalizePoint(value.points[index], index);
    });
  }

  const bezierControls = Object.hasOwn(value, "bezierControls") ? value.bezierControls : true;
  const alignToPath = Object.hasOwn(value, "alignToPath") ? value.alignToPath : false;
  if (typeof bezierControls !== "boolean") throw new TypeError("motionPath.bezierControls must be a boolean.");
  if (typeof alignToPath !== "boolean") throw new TypeError("motionPath.alignToPath must be a boolean.");
  const normalized = { points, bezierControls, alignToPath };
  if (Object.hasOwn(value, "alignmentOffset"))
    normalized.alignmentOffset = coordinate(value.alignmentOffset, "motionPath.alignmentOffset", 360_000);
  return normalized;
}

function ownKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

/** True for a custom operation whose endpoint properties are only position axes. */
export function isMoveAnimation(animation) {
  if (!animation || typeof animation !== "object" || animation.kind !== "custom") return false;
  const keys = new Set([...ownKeys(animation.from), ...ownKeys(animation.to)]);
  return keys.size > 0 && [...keys].every((key) => key === "x" || key === "y");
}

/** Resolve axis-only Move endpoints into two complete parent-space positions. */
export function motionEndpoints(layer, animation) {
  if (!layer || typeof layer !== "object") throw new TypeError("A layer is required to resolve motion endpoints.");
  if (!animation || typeof animation !== "object") throw new TypeError("An animation is required to resolve motion endpoints.");
  const design = {
    x: coordinate(layer.x ?? 0, "layer.x"),
    y: coordinate(layer.y ?? 0, "layer.y"),
  };
  const from = animation.from && typeof animation.from === "object" ? animation.from : {};
  const to = animation.to && typeof animation.to === "object" ? animation.to : {};
  const start = {
    x: Object.hasOwn(from, "x") ? coordinate(from.x, "animation.from.x") : design.x,
    y: Object.hasOwn(from, "y") ? coordinate(from.y, "animation.from.y") : design.y,
  };
  const end = {
    x: Object.hasOwn(to, "x") ? coordinate(to.x, "animation.to.x") : design.x,
    y: Object.hasOwn(to, "y") ? coordinate(to.y, "animation.to.y") : design.y,
  };
  return { start, end };
}

function point(x, y) {
  return { x, y };
}

function clonePoint(value) {
  return { x: value.x, y: value.y };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(a, amount) {
  return { x: a.x * amount, y: a.y * amount };
}

function lerpPoint(a, b, amount) {
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function cubicPoint(segment, t) {
  const inverse = 1 - t;
  const aa = inverse * inverse * inverse;
  const bb = 3 * inverse * inverse * t;
  const cc = 3 * inverse * t * t;
  const dd = t * t * t;
  return {
    x: aa * segment.start.x + bb * segment.c1.x + cc * segment.c2.x + dd * segment.end.x,
    y: aa * segment.start.y + bb * segment.c1.y + cc * segment.c2.y + dd * segment.end.y,
  };
}

function cubicDerivative(segment, t) {
  const inverse = 1 - t;
  return {
    x: 3 * inverse * inverse * (segment.c1.x - segment.start.x) +
      6 * inverse * t * (segment.c2.x - segment.c1.x) +
      3 * t * t * (segment.end.x - segment.c2.x),
    y: 3 * inverse * inverse * (segment.c1.y - segment.start.y) +
      6 * inverse * t * (segment.c2.y - segment.c1.y) +
      3 * t * t * (segment.end.y - segment.c2.y),
  };
}

function splitCubic(segment) {
  const p01 = lerpPoint(segment.start, segment.c1, 0.5);
  const p12 = lerpPoint(segment.c1, segment.c2, 0.5);
  const p23 = lerpPoint(segment.c2, segment.end, 0.5);
  const p012 = lerpPoint(p01, p12, 0.5);
  const p123 = lerpPoint(p12, p23, 0.5);
  const middle = lerpPoint(p012, p123, 0.5);
  return [
    { start: segment.start, c1: p01, c2: p012, end: middle },
    { start: middle, c1: p123, c2: p23, end: segment.end },
  ];
}

function canonicalPath(path) {
  return normalizeMotionPath(path) ?? DEFAULT_PATH;
}

/** Build cubic segments in parent coordinates; handle offsets are vectors from each node. */
export function motionPathSegments(start, end, path) {
  const first = normalizePosition(start, "motion start");
  const last = normalizePosition(end, "motion end");
  const checkedPath = canonicalPath(path);
  const nodes = [
    { position: first, in: null, out: null },
    ...checkedPath.points.map(({ x, y, in: incoming, out }) => ({
      position: point(x, y), in: incoming, out,
    })),
    { position: last, in: null, out: null },
  ];
  const segments = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    let c1;
    let c2;
    if (!checkedPath.bezierControls) {
      c1 = lerpPoint(from.position, to.position, 1 / 3);
      c2 = lerpPoint(from.position, to.position, 2 / 3);
    } else {
      c1 = index === 0
        ? lerpPoint(from.position, to.position, 1 / 3)
        : add(from.position, from.out);
      c2 = index + 1 === nodes.length - 1
        ? lerpPoint(to.position, from.position, 1 / 3)
        : add(to.position, to.in);
    }
    segments.push({ start: clonePoint(from.position), c1, c2, end: clonePoint(to.position) });
  }
  return segments;
}

function normalizePosition(value, label) {
  if (!value || typeof value !== "object") throw new TypeError(`${label} must be a point.`);
  return {
    x: coordinate(value.x, `${label}.x`),
    y: coordinate(value.y, `${label}.y`),
  };
}

function isFlat(segment, tolerance) {
  const chord = distance(segment.start, segment.end);
  const polygon = distance(segment.start, segment.c1) + distance(segment.c1, segment.c2) + distance(segment.c2, segment.end);
  // Chord distance alone considers every monotone collinear cubic flat, even when
  // its parameter moves unevenly along that line. Arc-length evaluation interpolates
  // between flattened parameter samples, so require the controls to also match the
  // one-third/two-thirds controls of a uniformly parameterized straight segment.
  const uniformC1 = lerpPoint(segment.start, segment.end, 1 / 3);
  const uniformC2 = lerpPoint(segment.start, segment.end, 2 / 3);
  return polygon - chord <= tolerance &&
    distance(segment.c1, uniformC1) <= tolerance &&
    distance(segment.c2, uniformC2) <= tolerance;
}

function flattenSegment(segment) {
  const initialPolygonLength = distance(segment.start, segment.c1) +
    distance(segment.c1, segment.c2) + distance(segment.c2, segment.end);
  const tolerance = Math.min(0.01,
    Math.max(FLATTEN_ABSOLUTE_TOLERANCE, initialPolygonLength * FLATTEN_RELATIVE_TOLERANCE));
  const samples = [{ t: 0, point: clonePoint(segment.start) }];
  const visit = (part, t0, t1, depth) => {
    if (depth >= MAX_FLATTEN_DEPTH || isFlat(part, tolerance)) {
      samples.push({ t: t1, point: clonePoint(part.end) });
      return;
    }
    const [left, right] = splitCubic(part);
    const middle = (t0 + t1) / 2;
    visit(left, t0, middle, depth + 1);
    visit(right, middle, t1, depth + 1);
  };
  visit(segment, 0, 1, 0);
  return samples;
}

function rawAngle(segment, t, localSamples, localIndex) {
  let tangent = cubicDerivative(segment, t);
  if (Math.hypot(tangent.x, tangent.y) <= EPSILON) {
    const before = localSamples[Math.max(0, localIndex - 1)]?.point;
    const after = localSamples[Math.min(localSamples.length - 1, localIndex + 1)]?.point;
    if (before && after) tangent = subtract(after, before);
  }
  if (Math.hypot(tangent.x, tangent.y) <= EPSILON) return null;
  return (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
}

function unwrapAngle(angle, reference) {
  return angle + 360 * Math.round((reference - angle) / 360);
}

function buildMeasure(segments) {
  const segmentSamples = segments.map(flattenSegment);
  const samples = [];
  let length = 0;
  for (let segmentIndex = 0; segmentIndex < segmentSamples.length; segmentIndex += 1) {
    const local = segmentSamples[segmentIndex];
    for (let index = 0; index < local.length; index += 1) {
      const item = local[index];
      if (samples.length > 0) length += distance(samples[samples.length - 1].point, item.point);
      samples.push({
        segmentIndex,
        t: item.t,
        point: item.point,
        length,
        rawAngle: rawAngle(segments[segmentIndex], item.t, local, index),
      });
    }
  }

  const nextAngles = new Array(samples.length);
  let nextAngle = null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].rawAngle !== null) nextAngle = samples[index].rawAngle;
    nextAngles[index] = nextAngle;
  }
  let previousAngle = null;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    let angle = sample.rawAngle;
    if (angle === null) angle = previousAngle ?? nextAngles[index] ?? 0;
    sample.angle = previousAngle === null ? angle : unwrapAngle(angle, previousAngle);
    previousAngle = sample.angle;
  }

  if (!Number.isFinite(length)) throw new RangeError("motion path length is outside the supported numeric range.");

  return { segments, segmentSamples, samples, length, start: clonePoint(segments[0].start), end: clonePoint(segments.at(-1).end) };
}

function measureFor(segments) {
  // Segment coordinates include the complete normalized endpoints and path geometry.
  // This avoids stale evaluations when either changes, while equivalent cloned paths
  // (such as per-letter layer states) can reuse the same adaptive samples.
  const key = JSON.stringify(segments);
  const cached = measureCache.get(key);
  if (cached) {
    measureCache.delete(key);
    measureCache.set(key, cached);
    return cached.measure;
  }

  const measure = buildMeasure(segments);
  const sampleCount = measure.samples.length;
  if (sampleCount > MAX_CACHE_ENTRY_SAMPLES) return measure;
  while (measureCache.size >= MAX_MEASURE_CACHE_ENTRIES || cachedMeasureSamples + sampleCount > MAX_MEASURE_CACHE_SAMPLES) {
    const oldestKey = measureCache.keys().next().value;
    const oldest = measureCache.get(oldestKey);
    measureCache.delete(oldestKey);
    cachedMeasureSamples -= oldest.sampleCount;
  }
  measureCache.set(key, { measure, sampleCount });
  cachedMeasureSamples += sampleCount;
  return measure;
}

function unitTangent(angle) {
  const radians = (angle * Math.PI) / 180;
  return { x: Math.cos(radians), y: Math.sin(radians) };
}

function angleAtSegmentT(measure, segmentIndex, t, reference = null) {
  const segment = measure.segments[segmentIndex];
  let tangent = cubicDerivative(segment, t);
  if (Math.hypot(tangent.x, tangent.y) <= EPSILON) {
    const local = measure.segmentSamples[segmentIndex];
    let nearest = 0;
    for (let index = 1; index < local.length; index += 1) {
      if (Math.abs(local[index].t - t) < Math.abs(local[nearest].t - t)) nearest = index;
    }
    const before = local[Math.max(0, nearest - 1)]?.point;
    const after = local[Math.min(local.length - 1, nearest + 1)]?.point;
    if (before && after) tangent = subtract(after, before);
  }
  if (Math.hypot(tangent.x, tangent.y) <= EPSILON) return reference ?? 0;
  const angle = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
  return reference === null ? angle : unwrapAngle(angle, reference);
}

function locateDistance(measure, targetLength) {
  const samples = measure.samples;
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1];
    const after = samples[index];
    const span = after.length - before.length;
    if (span <= EPSILON || targetLength > after.length) continue;
    const amount = Math.max(0, Math.min(1, (targetLength - before.length) / span));
    if (before.segmentIndex !== after.segmentIndex) continue;
    const t = before.t + (after.t - before.t) * amount;
    const reference = before.angle + (after.angle - before.angle) * amount;
    return { segmentIndex: after.segmentIndex, t, point: cubicPoint(measure.segments[after.segmentIndex], t), angle: angleAtSegmentT(measure, after.segmentIndex, t, reference) };
  }
  const last = samples.at(-1);
  return { segmentIndex: last.segmentIndex, t: last.t, point: clonePoint(measure.end), angle: last.angle };
}

/** Evaluate a path by approximate whole-curve arc length, preserving easing overshoot. */
export function motionPathAt(start, end, path, progress) {
  coordinate(progress, "motion progress");
  const segments = motionPathSegments(start, end, path);
  const measure = measureFor(segments);
  if (measure.length <= EPSILON) return { ...clonePoint(measure.start), angle: 0 };
  const startAngle = measure.samples[0]?.angle ?? 0;
  const endAngle = measure.samples.at(-1)?.angle ?? startAngle;
  if (progress === 0) return { ...clonePoint(measure.start), angle: startAngle };
  if (progress === 1) return { ...clonePoint(measure.end), angle: endAngle };
  if (progress < 0) {
    const offset = scale(unitTangent(startAngle), progress * measure.length);
    return { ...add(measure.start, offset), angle: startAngle };
  }
  if (progress > 1) {
    const offset = scale(unitTangent(endAngle), (progress - 1) * measure.length);
    return { ...add(measure.end, offset), angle: endAngle };
  }
  const located = locateDistance(measure, progress * measure.length);
  return { ...located.point, angle: located.angle };
}

/** Map stored positions and handle vectors separately so translations leave handles unchanged. */
export function mapMotionPath(path, mapPosition, mapVector) {
  if (path === undefined || path === null) return path;
  if (typeof mapPosition !== "function" || typeof mapVector !== "function")
    throw new TypeError("mapMotionPath requires position and vector mapping functions.");
  const checkedPath = normalizeMotionPath(path);
  const points = checkedPath.points.map((item) => {
    const position = mapPosition({ x: item.x, y: item.y });
    const incoming = mapVector(clonePoint(item.in));
    const outgoing = mapVector(clonePoint(item.out));
    return { ...position, in: incoming, out: outgoing };
  });
  return normalizeMotionPath({
    points,
    bezierControls: checkedPath.bezierControls,
    alignToPath: checkedPath.alignToPath,
    ...(Object.hasOwn(checkedPath, "alignmentOffset") ? { alignmentOffset: checkedPath.alignmentOffset } : {}),
  });
}
