import { copySource, copiesEffect } from "./svg.js";

const MAX_COORDINATE = 1_000_000;
const MAX_ANGLE = 3_600;
const ANGLE_EPSILON = 1e-8;
const MIN_PROJECTED_AREA_RATIO = 1e-7;
const MAX_TRIANGLES = 64;

function readFrame(frame) {
  if (!frame || typeof frame !== "object") throw new TypeError("Projection frame must be an object.");
  if (typeof frame.content !== "string") throw new TypeError("Projection frame content must be an SVG string.");
  const bounds = frame.bounds;
  if (!bounds || typeof bounds !== "object" || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width <= 0 || bounds.height <= 0 || [bounds.x, bounds.y, bounds.width, bounds.height].some((value) => Math.abs(value) > MAX_COORDINATE) ||
      Math.abs(bounds.x + bounds.width) > MAX_COORDINATE || Math.abs(bounds.y + bounds.height) > MAX_COORDINATE)
    throw new RangeError("Projection bounds must be finite, positive, and stay within one million SVG units.");
  if (!frame.helpers || typeof frame.helpers.id !== "function" || !Array.isArray(frame.helpers.defs))
    throw new TypeError("Projection helpers must provide id(kind) and a defs array.");
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function numberParameter(frame, name, fallback, min, max) {
  const value = frame.parameters?.[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Projection parameter ${name} must be a finite number from ${min} to ${max}.`);
  return value;
}

function booleanParameter(frame, name, fallback) {
  const value = frame.parameters?.[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`Projection parameter ${name} must be true or false.`);
  return value;
}

function angle(value) {
  const result = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(result, -0) ? 0 : result;
}


function radians(value) {
  return value * (Math.PI / 180);
}

function rotateVector(vector, angles) {
  const xAngle = radians(angles.x), yAngle = radians(angles.y), zAngle = radians(angles.z);
  const cx = Math.cos(xAngle), sx = Math.sin(xAngle);
  const cy = Math.cos(yAngle), sy = Math.sin(yAngle);
  const cz = Math.cos(zAngle), sz = Math.sin(zAngle);

  // Fixed XYZ order: rotate around X, then Y, then Z.
  const x1 = vector.x;
  const y1 = vector.y * cx - vector.z * sx;
  const z1 = vector.y * sx + vector.z * cx;
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  return {
    x: x2 * cz - y2 * sz,
    y: x2 * sz + y2 * cz,
    z: z2,
  };
}

function cameraStrength(frame, bounds, distanceMultiplier) {
  const perspective = numberParameter(frame, "perspective", 0.45, 0, 0.95);
  const distance = Math.max(bounds.width, bounds.height) * distanceMultiplier;
  return { perspective, distance };
}

function projectVertex(point, angles, pivot, bounds, camera) {
  const rotated = rotateVector({
    x: point.x - pivot.x,
    y: point.y - pivot.y,
    z: -pivot.z,
  }, angles);
  const world = {
    x: pivot.x + rotated.x,
    y: pivot.y + rotated.y,
    z: pivot.z + rotated.z,
  };
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const depth = camera.perspective === 0 ? 0 : camera.perspective * world.z;
  const denominator = camera.distance - depth;
  if (!Number.isFinite(denominator) || denominator <= camera.distance * 0.05) return null;
  const scale = camera.distance / denominator;
  const projected = {
    x: centerX + (world.x - centerX) * scale,
    y: centerY + (world.y - centerY) * scale,
    z: world.z,
  };
  if (![projected.x, projected.y, projected.z].every(Number.isFinite) ||
      Math.abs(projected.x) > MAX_COORDINATE || Math.abs(projected.y) > MAX_COORDINATE)
    return null;
  return projected;
}

function triangleArea(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function affineForTriangle(source, target) {
  const [p0, p1, p2] = source;
  const [q0, q1, q2] = target;
  const ux = p1.x - p0.x, uy = p1.y - p0.y;
  const vx = p2.x - p0.x, vy = p2.y - p0.y;
  const det = ux * vy - vx * uy;
  if (Math.abs(det) < 1e-12) return null;
  const tx1 = q1.x - q0.x, tx2 = q2.x - q0.x;
  const ty1 = q1.y - q0.y, ty2 = q2.y - q0.y;
  const a = (tx1 * vy - tx2 * uy) / det;
  const c = (tx2 * ux - tx1 * vx) / det;
  const b = (ty1 * vy - ty2 * uy) / det;
  const d = (ty2 * ux - ty1 * vx) / det;
  const e = q0.x - a * p0.x - c * p0.y;
  const f = q0.y - b * p0.x - d * p0.y;
  const matrix = [a, b, c, d, e, f];
  return matrix.every(Number.isFinite) && matrix.every((value) => Math.abs(value) <= 1e7) ? matrix : null;
}

function svgNumber(value) {
  const rounded = Math.round(value * 1e7) / 1e7;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function escapeXmlAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]);
}

function trianglePath(points) {
  return polygonPath(points);
}

function polygonPath(points) {
  return `M ${svgNumber(points[0].x)} ${svgNumber(points[0].y)} ${points.slice(1).map((point) => `L ${svgNumber(point.x)} ${svgNumber(point.y)}`).join(" ")} Z`;
}

function makeTriangleMarkup(frame, source, target, sourceMarkup) {
  const sourceArea = Math.abs(triangleArea(...source));
  const targetArea = Math.abs(triangleArea(...target));
  if (sourceArea <= 1e-12 || targetArea / sourceArea < MIN_PROJECTED_AREA_RATIO) return null;
  const matrix = affineForTriangle(source, target);
  if (!matrix) return null;

  const patternId = frame.helpers.id("projection-pattern");
  if (patternId === undefined || patternId === null || String(patternId).length === 0 || String(patternId).length > 4096)
    throw new TypeError("Projection helper IDs must be non-empty strings of at most 4096 characters.");
  const left = Math.min(...source.map((point) => point.x));
  const top = Math.min(...source.map((point) => point.y));
  const right = Math.max(...source.map((point) => point.x));
  const bottom = Math.max(...source.map((point) => point.y));
  const tileWidth = right - left, tileHeight = bottom - top;
  if (![left, top, tileWidth, tileHeight].every(Number.isFinite) || tileWidth <= 0 || tileHeight <= 0) return null;
  const patternBounds = [left, top, tileWidth, tileHeight].map(svgNumber).join(" ");
  frame.helpers.defs.push(
    `<pattern id="${escapeXmlAttribute(patternId)}" x="${svgNumber(left)}" y="${svgNumber(top)}" width="${svgNumber(tileWidth)}" height="${svgNumber(tileHeight)}" patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse" viewBox="${patternBounds}" preserveAspectRatio="none">${sourceMarkup}</pattern>`,
  );
  const transform = `matrix(${matrix.map(svgNumber).join(" ")})`;
  return {
    // A pattern limits each repeated source rendering to this triangle's source
    // AABB. The source stays in its original coordinates inside the viewBox, while
    // the affine transform maps the crisp triangle path into the projected mesh.
    markup: `<g transform="${transform}"><path shape-rendering="crispEdges" d="${trianglePath(source)}" fill="url(#${escapeXmlAttribute(patternId)})"/></g>`,
    z: (target[0].z + target[1].z + target[2].z) / 3,
    points: target,
  };
}

function makeSilhouetteClip(frame, projectedCorners) {
  const clipId = frame.helpers.id("projection-silhouette");
  if (clipId === undefined || clipId === null || String(clipId).length === 0 || String(clipId).length > 4096)
    throw new TypeError("Projection helper IDs must be non-empty strings of at most 4096 characters.");
  frame.helpers.defs.push(
    `<clipPath id="${escapeXmlAttribute(clipId)}" clipPathUnits="userSpaceOnUse"><path d="${polygonPath(projectedCorners)}"/></clipPath>`,
  );
  return clipId;
}

function gridSize(bounds, angles) {
  const xDepth = Math.abs(Math.sin(radians(angles.x))) > ANGLE_EPSILON;
  const yDepth = Math.abs(Math.sin(radians(angles.y))) > ANGLE_EPSILON;
  if (!xDepth && !yDepth) return { columns: 1, rows: 1 };
  if (xDepth) {
    return {
      columns: Math.max(1, Math.min(8, Math.ceil(bounds.width / 64))),
      rows: Math.max(1, Math.min(4, Math.ceil(bounds.height / 64))),
    };
  }
  return { columns: Math.max(1, Math.min(32, Math.ceil(bounds.width / 32))), rows: 1 };
}

function renderProjectedMesh(frame, { angles, pivot, camera, visibleFront, visibleBack }) {
  const bounds = readFrame(frame);
  const normal = rotateVector({ x: 0, y: 0, z: 1 }, angles);
  const facing = Math.abs(normal.z) < 1e-8 ? "edge" : normal.z > 0 ? "front" : "back";
  if (facing === "edge" || (facing === "front" && !visibleFront) || (facing === "back" && !visibleBack))
    return copiesEffect(frame, "");

  if (angles.x === 0 && angles.y === 0 && angles.z === 0) return frame.content;
  const { columns, rows } = gridSize(bounds, angles);
  const vertices = Array.from({ length: rows + 1 }, (_, row) =>
    Array.from({ length: columns + 1 }, (_, column) => {
      const source = {
        x: bounds.x + bounds.width * column / columns,
        y: bounds.y + bounds.height * row / rows,
      };
      return { source, projected: projectVertex(source, angles, pivot, bounds, camera) };
    }));

  const triangleSpecs = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const p00 = vertices[row][column], p10 = vertices[row][column + 1];
      const p01 = vertices[row + 1][column], p11 = vertices[row + 1][column + 1];
      for (const triangle of [[p00, p10, p11], [p00, p11, p01]]) {
        if (triangle.some((vertex) => !vertex.projected)) continue;
        triangleSpecs.push({
          source: triangle.map((vertex) => vertex.source),
          target: triangle.map((vertex) => vertex.projected),
          z: triangle.reduce((sum, vertex) => sum + vertex.projected.z, 0) / 3,
        });
      }
    }
  }
  if (triangleSpecs.length > MAX_TRIANGLES) throw new Error("Projection mesh exceeded its 64 triangle limit.");
  if (!triangleSpecs.length) return copiesEffect(frame, "");

  const projectedCorners = [vertices[0][0], vertices[0][columns], vertices[rows][columns], vertices[rows][0]];
  if (projectedCorners.some((vertex) => !vertex.projected)) return copiesEffect(frame, "");
  const sourceMarkup = copySource(frame);
  const pieces = triangleSpecs
    .map((triangle) => makeTriangleMarkup(frame, triangle.source, triangle.target, sourceMarkup))
    .filter(Boolean);
  if (!pieces.length) return copiesEffect(frame, "");

  // Internal pattern-filled triangle edges are crisp to avoid adjacent translucent
  // pieces accumulating alpha. One normal antialiased clip preserves the outer silhouette.
  pieces.sort((a, b) => a.z - b.z);
  const allPoints = pieces.flatMap((piece) => piece.points);
  const left = Math.min(...allPoints.map((point) => point.x));
  const top = Math.min(...allPoints.map((point) => point.y));
  const right = Math.max(...allPoints.map((point) => point.x));
  const bottom = Math.max(...allPoints.map((point) => point.y));
  if (![left, top, right, bottom].every(Number.isFinite) || Math.abs(left) > MAX_COORDINATE ||
      Math.abs(top) > MAX_COORDINATE || Math.abs(right) > MAX_COORDINATE || Math.abs(bottom) > MAX_COORDINATE)
    return copiesEffect(frame, "");
  frame.helpers.includeBounds?.({ x: left, y: top, width: Math.max(0.001, right - left), height: Math.max(0.001, bottom - top) });
  const silhouetteId = makeSilhouetteClip(frame, projectedCorners.map((vertex) => vertex.projected));
  return copiesEffect(frame,
    `<g clip-path="url(#${escapeXmlAttribute(silhouetteId)})">${frame.helpers.clipSentinel?.() ?? ""}${pieces.map((piece) => piece.markup).join("")}</g>`);
}

function readAngles(frame, names) {
  return {
    x: angle(numberParameter(frame, names.x, 0, -MAX_ANGLE, MAX_ANGLE)),
    y: angle(numberParameter(frame, names.y, 0, -MAX_ANGLE, MAX_ANGLE)),
    z: angle(numberParameter(frame, names.z, 0, -MAX_ANGLE, MAX_ANGLE)),
  };
}

/**
 * Original perspective Orbit renderer.
 * Angles are degrees. Pivot Z is a positive distance behind the layer, measured
 * in shorter-side lengths. Perspective is a 0..0.95 strength (0 is orthographic);
 * Camera Distance is a longer-side multiplier. These units are unverified.
 */
export function renderOrbit(frame) {
  const bounds = readFrame(frame);
  const angles = readAngles(frame, { x: "rotateX", y: "rotateY", z: "rotateZ" });
  const pivotDepth = numberParameter(frame, "pivotZ", 5, 0, 8) * Math.min(bounds.width, bounds.height);
  const cameraDistance = numberParameter(frame, "cameraDistance", 4.5, 0.5, 32);
  const showFront = booleanParameter(frame, "showFront", true);
  const showBack = booleanParameter(frame, "showBack", true);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return renderProjectedMesh(frame, {
    angles,
    pivot: { x: centerX, y: centerY, z: -pivotDepth },
    camera: cameraStrength(frame, bounds, cameraDistance),
    visibleFront: showFront,
    visibleBack: showBack,
  });
}

/**
 * Original perspective Card Flip renderer.
 * Angles are degrees. Pivot X/Y are offsets from layer center, normalized to the
 * layer width/height; zero means center. Perspective is a 0..0.95 strength. These
 * units and the XYZ rotation order are unverified.
 */
export function renderCardFlip(frame) {
  const bounds = readFrame(frame);
  const angles = readAngles(frame, { x: "rotationX", y: "rotationY", z: "rotationZ" });
  const pivotX = numberParameter(frame, "pivotX", 0, -2, 2) * bounds.width;
  const pivotY = numberParameter(frame, "pivotY", 0, -2, 2) * bounds.height;
  const frontFace = booleanParameter(frame, "frontFace", true);
  const backFace = booleanParameter(frame, "backFace", true);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return renderProjectedMesh(frame, {
    angles,
    pivot: { x: centerX + pivotX, y: centerY + pivotY, z: 0 },
    camera: cameraStrength(frame, bounds, 1),
    visibleFront: frontFace,
    visibleBack: backFace,
  });
}

export const PROJECTION_LIMITS = Object.freeze({
  maxTriangles: MAX_TRIANGLES,
  angle: Object.freeze([-MAX_ANGLE, MAX_ANGLE]),
  pivotOffset: Object.freeze([-2, 2]),
  orbitPivotZ: Object.freeze([0, 8]),
  perspective: Object.freeze([0, 0.95]),
  cameraDistance: Object.freeze([0.5, 32]),
});
