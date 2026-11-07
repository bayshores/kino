// 2.5D tilt: a layer drawn on a flat plane turned in 3D (rotateX, rotateY in degrees) and seen
// through a perspective (the eye's distance from the plane, in px). The math follows CSS
// `perspective(p) rotateX(rx) rotateY(ry)` around the layer's center: positive rotateX tips the
// top edge away, positive rotateY turns the right edge away.
//
// SVG (and so every kino renderer: the app preview, Chromium exports, resvg) has only flat
// (affine) transforms. So the layer's drawing is cut into a grid of triangles, each drawn with
// its own affine transform and clipped to its projected triangle. Within a triangle an affine
// map is exact at the 3 corners; the grid is made fine enough that nothing strays more than
// TILT_TOLERANCE px from the true perspective (tiltGrid). Each clip triangle is grown a little
// past its edges so neighbors overlap and no hairline seam shows between them.

/** Tilt limits: a plane turned 90 degrees is seen edge-on. */
export const TILT_LIMIT = 89;
export const PERSPECTIVE_MIN = 100;
export const PERSPECTIVE_MAX = 100_000;
/** The eye's distance when a layer has no perspective of its own (px). */
export const DEFAULT_PERSPECTIVE = 1600;
/** The largest distance (px) a drawn point may stray from the true perspective. */
export const TILT_TOLERANCE = 0.3;
// The most grid cells along one side (each cell is two triangles).
const MAX_CELLS = 32;

const finiteOr = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** True when the layer state is turned in 3D (rotateX or rotateY is not 0). */
export function hasTilt(state) {
  return Math.abs(finiteOr(state?.rotateX, 0)) > 1e-6 || Math.abs(finiteOr(state?.rotateY, 0)) > 1e-6;
}

/**
 * The projection of a tilted plane: a function from a point (u, v) on the flat plane, relative to
 * the pivot, to where it shows on screen relative to the same pivot.
 */
export function tiltProjector(state) {
  const project = tiltDepthProjector(state);
  return (u, v) => { const [x, y] = project(u, v); return [x, y]; };
}

/**
 * As tiltProjector, with each point's depth too: [x, y, h, held]. Dividing by h is the
 * perspective, so a GPU that is given h interpolates across the plane exactly (frontend/liveTilt.js).
 * `held` is true for a point the eye clamp moved, where the projection is no longer exact.
 */
export function tiltDepthProjector(state) {
  const rx = Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, finiteOr(state?.rotateX, 0))) * Math.PI / 180;
  const ry = Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, finiteOr(state?.rotateY, 0))) * Math.PI / 180;
  const p = Math.max(PERSPECTIVE_MIN, Math.min(PERSPECTIVE_MAX, finiteOr(state?.perspective, DEFAULT_PERSPECTIVE)));
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  return (u, v) => {
    // rotateY first, then rotateX (CSS applies the rightmost function first).
    const x1 = u * cy, z1 = -u * sy;
    const y2 = v * cx - z1 * sx, z2 = v * sx + z1 * cx;
    // A point at or behind the eye is held just in front of it.
    const depth = Math.max(p - z2, p * 0.02);
    const w = p / depth;
    return [x1 * w, y2 * w, depth / p, depth !== p - z2];
  };
}

// How far the middle of each cell strays from the two triangles' affine maps, at worst.
function gridError(project, box, columns, rows) {
  let worst = 0;
  for (let row = 0; row < rows; row += 1) {
    const v0 = box.y + (box.height * row) / rows, v1 = box.y + (box.height * (row + 1)) / rows;
    for (let column = 0; column < columns; column += 1) {
      const u0 = box.x + (box.width * column) / columns, u1 = box.x + (box.width * (column + 1)) / columns;
      const [ax, ay] = project(u0, v0), [bx, by] = project(u1, v1), [mx, my] = project((u0 + u1) / 2, (v0 + v1) / 2);
      worst = Math.max(worst, Math.hypot(mx - (ax + bx) / 2, my - (ay + by) / 2));
    }
  }
  return worst;
}

/** The grid (columns, rows) that keeps the plane within TILT_TOLERANCE of the true perspective. */
export function tiltGrid(project, box, tolerance = TILT_TOLERANCE) {
  let columns = 1, rows = 1;
  let error = gridError(project, box, columns, rows);
  while (error > tolerance && (columns < MAX_CELLS || rows < MAX_CELLS)) {
    const wider = columns < MAX_CELLS ? gridError(project, box, Math.min(MAX_CELLS, columns + 1), rows) : Infinity;
    const taller = rows < MAX_CELLS ? gridError(project, box, columns, Math.min(MAX_CELLS, rows + 1)) : Infinity;
    if (wider <= taller) { columns += 1; error = wider; } else { rows += 1; error = taller; }
  }
  return { columns, rows, error };
}

// The affine matrix [a, b, c, d, e, f] that takes the source triangle s onto the target t.
export function triangleMatrix(s, t) {
  const [[x0, y0], [x1, y1], [x2, y2]] = s;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-12) return null;
  const solve = (r0, r1, r2) => {
    const p = ((r1 - r0) * (y2 - y0) - (r2 - r0) * (y1 - y0)) / det;
    const q = ((x1 - x0) * (r2 - r0) - (x2 - x0) * (r1 - r0)) / det;
    return [p, q, r0 - p * x0 - q * y0];
  };
  const [a, c, e] = solve(t[0][0], t[1][0], t[2][0]);
  const [b, d, f] = solve(t[0][1], t[1][1], t[2][1]);
  return [a, b, c, d, e, f];
}

/**
 * The triangles that draw `box` (a rectangle on the flat plane, relative to the pivot) tilted:
 * each { matrix, clip } with clip the target triangle. Neighbors share their edges exactly and are
 * drawn without anti-aliasing (render.js), so each pixel is painted once: grown, overlapping
 * triangles painted partly transparent paint twice along every edge (a bright seam). Also the
 * projected corners.
 */
export function tiltTriangles(state, box, tolerance = TILT_TOLERANCE) {
  const project = tiltProjector(state);
  const { columns, rows } = tiltGrid(project, box, tolerance);
  const point = (column, row) => [box.x + (box.width * column) / columns, box.y + (box.height * row) / rows];
  const triangles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = point(column, row), b = point(column + 1, row), c = point(column + 1, row + 1), d = point(column, row + 1);
      for (const source of [[a, b, c], [a, c, d]]) {
        const target = source.map(([u, v]) => project(u, v));
        const matrix = triangleMatrix(source, target);
        // The cell, with a margin, is all the triangle's paint needs.
        const cell = { x: a[0] - 2, y: a[1] - 2, width: c[0] - a[0] + 4, height: c[1] - a[1] + 4 };
        if (matrix) triangles.push({ matrix, clip: target, cell });
      }
    }
  }
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]]
    .map(([u, v]) => project(u, v));
  return { triangles, corners, columns, rows };
}

/** The bounding box of the projected `box` (relative to the pivot). */
export function tiltedBounds(state, box) {
  const project = tiltProjector(state);
  const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]]
    .map(([u, v]) => project(u, v));
  const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The layer's pivot in its parent: the middle of its box (rotation and scale turn around it too). */
export function tiltPivot(state) {
  return { x: finiteOr(state.x, 0) + finiteOr(state.width, 0) / 2, y: finiteOr(state.y, 0) + finiteOr(state.height, 0) / 2 };
}

// The plane-to-screen map as a 3x3 matrix (row-major): [x, y, h] ~ M · [u, v, 1], with the
// screen point x / h, y / h and h the depth over the perspective (tiltDepthProjector).
function tiltHomography(state) {
  const rx = Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, finiteOr(state?.rotateX, 0))) * Math.PI / 180;
  const ry = Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, finiteOr(state?.rotateY, 0))) * Math.PI / 180;
  const p = Math.max(PERSPECTIVE_MIN, Math.min(PERSPECTIVE_MAX, finiteOr(state?.perspective, DEFAULT_PERSPECTIVE)));
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  return [cy, 0, 0, sy * sx, cx, 0, (sy * cx) / p, -sx / p, 1];
}

// Keeps the part of `polygon` where inside(point) >= 0, cutting edges where it crosses 0.
function clipPolygon(polygon, inside, cut) {
  const kept = [];
  polygon.forEach((point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    const a = inside(point), b = inside(next);
    if (a >= 0) kept.push(point);
    if ((a >= 0) !== (b >= 0)) kept.push(cut(point, next, a / (a - b)));
  });
  return kept;
}

/**
 * The part of the tilted plane `box` (relative to the pivot) that is in front of the eye and on
 * `screen` (a convex polygon relative to the pivot, clockwise or not): {plane, points}, the
 * polygon's corners on the flat plane [u, v] and on screen [x, y, h]. Null when none shows.
 * The live picture draws only this part (render.js liveTiltTag), so a plane that reaches past
 * the eye or far off screen still gets its pixels where they show.
 */
export function tiltVisiblePart(state, box, screen) {
  const m = tiltHomography(state);
  const depth = ([u, v]) => m[6] * u + m[7] * v + m[8];
  const lerp = (a, b, t) => a.map((value, index) => value + (b[index] - value) * t);
  // In front of the eye: h above the eye clamp of tiltDepthProjector.
  let plane = clipPolygon([[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]],
    (point) => depth(point) - 0.021, lerp);
  if (plane.length < 3) return null;
  // On screen: each edge of the screen polygon cuts the plane polygon. On the plane the edge's
  // line is a line too (a homography keeps lines), so cut there, where depth stays positive.
  const area = screen.reduce((sum, [x, y], index) => { const [nx, ny] = screen[(index + 1) % screen.length]; return sum + x * ny - nx * y; }, 0);
  const turn = area > 0 ? 1 : -1;
  screen.forEach(([x0, y0], index) => {
    const [x1, y1] = screen[(index + 1) % screen.length];
    // Inside when on the polygon's side of the edge: turn·cross(edge, point − start) >= 0, times h.
    const side = ([u, v]) => {
      const h = depth([u, v]), x = m[0] * u + m[1] * v + m[2], y = m[3] * u + m[4] * v + m[5];
      return turn * ((x1 - x0) * (y - y0 * h) - (y1 - y0) * (x - x0 * h));
    };
    if (plane.length >= 3) plane = clipPolygon(plane, side, lerp);
  });
  if (plane.length < 3) return null;
  const points = plane.map(([u, v]) => { const h = depth([u, v]); return [(m[0] * u + m[1] * v + m[2]) / h, (m[3] * u + m[4] * v + m[5]) / h, h]; });
  return { plane, points };
}
