import { serializePath } from "./vectorPath.js";

const CIRCLE_K = (4 / 3) * Math.tan(Math.PI / 8);
const TAU = Math.PI * 2;

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function layerSize(state) {
  if (!state || typeof state !== "object") {
    throw new TypeError("Shape state must be an object.");
  }
  return {
    width: finiteNonNegative(state.width ?? 0, "Shape width"),
    height: finiteNonNegative(state.height ?? 0, "Shape height"),
  };
}

function point(x, y) {
  return [x, y];
}

function line(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return {
    c1: [from[0] + dx / 3, from[1] + dy / 3],
    c2: [from[0] + (2 * dx) / 3, from[1] + (2 * dy) / 3],
    end: [...to],
  };
}

function makeContour(start, segments) {
  return { start, segments, closed: true };
}

function checkContour(contour) {
  for (const coordinate of contour.start) {
    if (!Number.isFinite(coordinate)) {
      throw new RangeError("Shape coordinates are outside the supported range.");
    }
  }
  for (const segment of contour.segments) {
    for (const coordinate of [...segment.c1, ...segment.c2, ...segment.end]) {
      if (!Number.isFinite(coordinate)) {
        throw new RangeError("Shape coordinates are outside the supported range.");
      }
    }
  }
  return contour;
}

function edgeScale(limit, first, second) {
  const total = first + second;
  if (total <= limit || total === 0) return 1;
  if (!Number.isFinite(total)) {
    const largest = Math.max(first, second);
    return (limit / largest) / (first / largest + second / largest);
  }
  return limit / total;
}

/** Return the effective TL, TR, BR, BL radii after local edge-overlap limits. */
export function resolvedCornerRadii(state = {}) {
  const { width, height } = layerSize(state);
  let radii;
  if (state.cornerRadii !== undefined && state.cornerRadii !== null) {
    if (
      !Array.isArray(state.cornerRadii) ||
      state.cornerRadii.length !== 4 ||
      !state.cornerRadii.every(Number.isFinite)
    ) {
      throw new RangeError("Corner radii must contain four finite values.");
    }
    // Valid endpoint values can cross zero under an overshooting easing.
    radii = state.cornerRadii.map((radius) => Math.max(0, radius));
  } else {
    const rawRadius = state.radius ?? 0;
    if (!Number.isFinite(rawRadius)) throw new RangeError("Corner radius must be finite.");
    const radius = Math.max(0, rawRadius);
    radii = [radius, radius, radius, radius];
  }

  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const scales = [
    Math.min(1, edgeScale(width, topLeft, topRight), edgeScale(height, topLeft, bottomLeft)),
    Math.min(1, edgeScale(width, topLeft, topRight), edgeScale(height, topRight, bottomRight)),
    Math.min(1, edgeScale(width, bottomLeft, bottomRight), edgeScale(height, topRight, bottomRight)),
    Math.min(1, edgeScale(width, bottomLeft, bottomRight), edgeScale(height, topLeft, bottomLeft)),
  ];
  return radii.map((radius, index) => radius * scales[index]);
}

function rectangle(state) {
  const { width, height } = layerSize(state);
  const [topLeft, topRight, bottomRight, bottomLeft] = resolvedCornerRadii({
    width,
    height,
    radius: state.radius,
    cornerRadii: state.cornerRadii,
  });

  const start = point(topLeft, 0);
  const segments = [];

  // Keep one edge and one quarter-arc for each corner, including square corners.
  segments.push(line(start, point(width - topRight, 0)));
  segments.push({
    c1: point(width - topRight + CIRCLE_K * topRight, 0),
    c2: point(width, topRight - CIRCLE_K * topRight),
    end: point(width, topRight),
  });
  segments.push(line(point(width, topRight), point(width, height - bottomRight)));
  segments.push({
    c1: point(width, height - bottomRight + CIRCLE_K * bottomRight),
    c2: point(width - bottomRight + CIRCLE_K * bottomRight, height),
    end: point(width - bottomRight, height),
  });
  segments.push(line(point(width - bottomRight, height), point(bottomLeft, height)));
  segments.push({
    c1: point(bottomLeft - CIRCLE_K * bottomLeft, height),
    c2: point(0, height - bottomLeft + CIRCLE_K * bottomLeft),
    end: point(0, height - bottomLeft),
  });
  segments.push(line(point(0, height - bottomLeft), point(0, topLeft)));
  segments.push({
    c1: point(0, topLeft - CIRCLE_K * topLeft),
    c2: point(topLeft - CIRCLE_K * topLeft, 0),
    end: start,
  });

  return [checkContour(makeContour(start, segments))];
}

function fraction(value, fallback, label) {
  const number = value ?? fallback;
  if (!Number.isFinite(number)) throw new RangeError(`${label} must be finite.`);
  return Math.max(0, Math.min(1, number));
}

function normalizedAngle(degrees) {
  if (!Number.isFinite(degrees)) throw new RangeError("Start angle must be finite.");
  const result = ((degrees % 360) + 360) % 360;
  return result === 0 ? 0 : (result * Math.PI) / 180;
}

function ellipsePoint(centerX, centerY, radiusX, radiusY, angle) {
  const cosine = snapTrig(Math.cos(angle));
  const sine = snapTrig(Math.sin(angle));
  return [
    centerX + radiusX * cosine,
    centerY + radiusY * sine,
  ];
}

function snapTrig(value) {
  if (Math.abs(value) < 1e-15) return 0;
  if (Math.abs(Math.abs(value) - 1) < 1e-15) return Math.sign(value);
  return value;
}

function ellipseTangent(radiusX, radiusY, angle) {
  const cosine = snapTrig(Math.cos(angle));
  const sine = snapTrig(Math.sin(angle));
  return [-radiusX * sine, radiusY * cosine];
}

function arc(centerX, centerY, radiusX, radiusY, startAngle, deltaAngle, lastPoint = null) {
  const start = ellipsePoint(centerX, centerY, radiusX, radiusY, startAngle);
  const count = Math.max(1, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 2)));
  const step = deltaAngle / count;
  const segments = [];
  for (let index = 0; index < count; index += 1) {
    const a0 = startAngle + step * index;
    const a1 = a0 + step;
    const p0 = index === 0 ? start : ellipsePoint(centerX, centerY, radiusX, radiusY, a0);
    const p1 =
      index === count - 1 && lastPoint
        ? [...lastPoint]
        : ellipsePoint(centerX, centerY, radiusX, radiusY, a1);
    const alpha = (4 / 3) * Math.tan((a1 - a0) / 4);
    const tangent0 = ellipseTangent(radiusX, radiusY, a0);
    const tangent1 = ellipseTangent(radiusX, radiusY, a1);
    segments.push({
      c1: [p0[0] + tangent0[0] * alpha, p0[1] + tangent0[1] * alpha],
      c2: [p1[0] - tangent1[0] * alpha, p1[1] - tangent1[1] * alpha],
      end: p1,
    });
  }
  return { start, segments };
}

function ellipse(state) {
  const { width, height } = layerSize(state);
  const donut = fraction(state.donut, 0, "Donut fraction");
  const sweep = fraction(state.sweep, 1, "Sweep fraction");
  if (sweep === 0 || donut === 1) return [];

  const startAngle = normalizedAngle(state.startAngle ?? 0);
  const angle = sweep * TAU;
  const full = sweep === 1;
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const outer = arc(
    centerX,
    centerY,
    radiusX,
    radiusY,
    startAngle,
    angle,
    full ? ellipsePoint(centerX, centerY, radiusX, radiusY, startAngle) : null,
  );

  if (full && donut === 0) {
    return [checkContour(makeContour(outer.start, outer.segments))];
  }

  if (full) {
    const inner = arc(
      centerX,
      centerY,
      radiusX * donut,
      radiusY * donut,
      startAngle,
      -TAU,
      ellipsePoint(centerX, centerY, radiusX * donut, radiusY * donut, startAngle),
    );
    return [
      checkContour(makeContour(outer.start, outer.segments)),
      checkContour(makeContour(inner.start, inner.segments)),
    ];
  }

  const outerEnd = outer.segments.at(-1).end;
  const segments = [...outer.segments];
  if (donut > 0) {
    const innerEnd = ellipsePoint(centerX, centerY, radiusX * donut, radiusY * donut, startAngle + angle);
    const innerStart = ellipsePoint(centerX, centerY, radiusX * donut, radiusY * donut, startAngle);
    segments.push(line(outerEnd, innerEnd));
    const inner = arc(
      centerX,
      centerY,
      radiusX * donut,
      radiusY * donut,
      startAngle + angle,
      -angle,
      innerStart,
    );
    segments.push(...inner.segments);
  } else {
    segments.push(line(outerEnd, point(width / 2, height / 2)));
  }
  return [checkContour(makeContour(outer.start, segments))];
}

function star(state) {
  const { width, height } = layerSize(state);
  const rawSpikes = state.spikes ?? 5;
  if (!Number.isFinite(rawSpikes)) throw new RangeError("Star spikes must be finite.");
  const spikes = Math.max(0, Math.min(1000, Math.round(rawSpikes)));
  if (spikes === 0) return [];
  const thickness = fraction(state.starThickness, 0.382, "Star thickness");
  const centerX = width / 2;
  const centerY = height / 2;
  const outerRadiusX = width / 2;
  const outerRadiusY = height / 2;
  const startAngle = -Math.PI / 2;
  const vertices = [];

  for (let index = 0; index < spikes * 2; index += 1) {
    const angle = startAngle + (index * Math.PI) / spikes;
    const radius = index % 2 === 0 ? 1 : thickness;
    vertices.push([
      centerX + outerRadiusX * radius * Math.cos(angle),
      centerY + outerRadiusY * radius * Math.sin(angle),
    ]);
  }

  const start = vertices[0];
  const segments = vertices.map((vertex, index) =>
    line(vertex, vertices[(index + 1) % vertices.length]),
  );
  return [checkContour(makeContour(start, segments))];
}

/** Build local vector contours for a rectangle, ellipse, or star layer. */
export function shapeContours(type, state = {}) {
  if (type === "rectangle") return rectangle(state);
  if (type === "ellipse") return ellipse(state);
  if (type === "star") return star(state);
  throw new TypeError(`Unsupported parametric shape: ${String(type)}.`);
}

/** Serialize a parametric shape as canonical cubic SVG path data. */
export function shapePath(type, state = {}) {
  return serializePath(shapeContours(type, state));
}
