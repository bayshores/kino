// The outline of a subject as vector paths, for cut_out output "outline" (cutout-operation.mjs).
// The matte's frames are read back (every `step`-th one, small), the largest contour of each is
// traced and simplified to a few hundred points, and the points become a closed path in the
// layer's own pixels, ready for strokes, neon, taper and roughen like any drawn shape.
//
//   traceOutline(matte, width, height, { level, points })  the largest contour as [[x, y], ...] (matte pixels) or null
//   outlinePathData(points, scaleX, scaleY)                 "M x y L x y ... Z"
//   readMatteFrames({ folder, info, step, side })           { width, height, frames: [{ index, matte }] }
//   outlineOfMatte({ folder, info, step, points })          { width, height, step, frames: [{ index, points|null }] }
//
// Contours come from marching squares on the matte (a pixel is "in" at `level`, 128 of 255; the
// crossing is placed by linear interpolation, so a steady matte gives a steady line). Only the
// largest contour is kept (one closed path per frame, so the shapes morph into each other without
// any pairing of loops). The simplifying is Douglas-Peucker with the tolerance raised until the
// loop fits the point budget (default 240 points: a guess, a human outline of a figure needs
// about 100 to 300 to keep fingers and hair).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegCommand } from "../media-probe.mjs";
import { scaleMatte } from "./cutout.mjs";

export const OUTLINE_DEFAULTS = Object.freeze({ step: 4, points: 240, side: 640, level: 128 });

// Marching squares: for each cell, the pairs of its edges (0 top, 1 right, 2 bottom, 3 left) a
// line joins, indexed by which corners are in (top-left 8, top-right 4, bottom-right 2, bottom-left 1).
const CELL_LINES = [[], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [[0, 3], [1, 2]], [[0, 2]], [[0, 3]],
  [[0, 3]], [[0, 2]], [[0, 1], [2, 3]], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []];

/** The largest contour of a one-byte-a-pixel matte as [[x, y], ...], or null when nothing is in. */
export function traceOutline(matte, width, height, { level = OUTLINE_DEFAULTS.level, points = OUTLINE_DEFAULTS.points } = {}) {
  // One empty pixel all around, so every contour closes (a subject cut by the frame follows its border).
  const w = width + 2, h = height + 2;
  const grid = new Float32Array(w * h);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) grid[(y + 1) * w + x + 1] = matte[y * width + x];
  // An edge is named by its first corner and direction: horizontal 2 * i, vertical 2 * i + 1.
  const edgeId = (x, y, side) => (side === 0 ? 2 * (y * w + x) : side === 2 ? 2 * ((y + 1) * w + x) : side === 3 ? 2 * (y * w + x) + 1 : 2 * (y * w + x + 1) + 1);
  const links = new Map();
  const link = (a, b) => {
    (links.get(a) ?? links.set(a, []).get(a)).push(b);
    (links.get(b) ?? links.set(b, []).get(b)).push(a);
  };
  for (let y = 0; y < h - 1; y += 1) for (let x = 0; x < w - 1; x += 1) {
    const tl = grid[y * w + x] >= level, tr = grid[y * w + x + 1] >= level, br = grid[(y + 1) * w + x + 1] >= level, bl = grid[(y + 1) * w + x] >= level;
    const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
    for (const [from, to] of CELL_LINES[code]) link(edgeId(x, y, from), edgeId(x, y, to));
  }
  if (!links.size) return null;
  // Where an edge's crossing is, between its two corners, in matte pixel indexes (the padding is
  // one pixel, so index = grid index - 1; outlinePathData adds the half pixel to the centre).
  const at = (id) => {
    const vertical = id % 2 === 1, corner = (id - (vertical ? 1 : 0)) / 2, x = corner % w, y = Math.floor(corner / w);
    const a = grid[y * w + x], b = vertical ? grid[(y + 1) * w + x] : grid[y * w + x + 1];
    const t = b === a ? 0.5 : Math.min(1, Math.max(0, (level - a) / (b - a)));
    return vertical ? [x - 1, y - 1 + t] : [x - 1 + t, y - 1];
  };
  // Walk each loop once; keep the one enclosing the most area.
  const seen = new Set();
  let best = null, bestArea = 0;
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let previous = -1, current = start;
    while (!seen.has(current)) {
      seen.add(current);
      loop.push(at(current));
      const next = links.get(current).find((id) => id !== previous && !seen.has(id));
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    const area = Math.abs(loop.reduce((sum, [x, y], index) => { const [nx, ny] = loop[(index + 1) % loop.length]; return sum + x * ny - nx * y; }, 0) / 2);
    if (loop.length >= 3 && area > bestArea) { best = loop; bestArea = area; }
  }
  return best ? simplifyLoop(best, points) : null;
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function douglasPeucker(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let far = -1, farthest = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const distance = distanceToSegment(points[index], points[first], points[last]);
      if (distance > farthest) { far = index; farthest = distance; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([first, far], [far, last]); }
  }
  return points.filter((_, index) => keep[index]);
}

/** A closed loop with at most `limit` points: Douglas-Peucker with a tolerance raised until it fits. */
export function simplifyLoop(loop, limit) {
  if (loop.length <= limit) return loop;
  // Split at the point farthest from the first, so the closing edge is not a special case.
  let split = 1, farthest = 0;
  loop.forEach(([x, y], index) => { const distance = Math.hypot(x - loop[0][0], y - loop[0][1]); if (distance > farthest) { split = index; farthest = distance; } });
  const halves = [loop.slice(0, split + 1), [...loop.slice(split), loop[0]]];
  let tolerance = 0.25, result = loop;
  while (tolerance < 200) {
    const [a, b] = halves.map((half) => douglasPeucker(half, tolerance));
    result = [...a.slice(0, -1), ...b.slice(0, -1)];
    if (result.length <= limit) break;
    tolerance *= 1.3;
  }
  return result;
}

/** A closed polyline in the layer's pixels from matte-pixel points. */
export function outlinePathData(points, scaleX = 1, scaleY = 1) {
  const number = (value) => String(Math.round(value * 100) / 100);
  return `M${points.map(([x, y]) => `${number((x + 0.5) * scaleX)} ${number((y + 0.5) * scaleY)}`).join(" L")} Z`;
}

/** The matte's frames (every `step`-th, the first always) as small gray pictures. */
export async function readMatteFrames({ folder, info, step = OUTLINE_DEFAULTS.step, side = OUTLINE_DEFAULTS.side }) {
  const file = join(folder, info.file);
  const factor = Math.min(1, side / Math.max(info.width, info.height));
  const width = Math.max(2, Math.round(info.width * factor)), height = Math.max(2, Math.round(info.height * factor));
  // A still's matte is raw gray bytes (cutout.mjs matte.gray).
  if (info.kind === "image")
    return { width, height, frames: [{ index: 0, matte: scaleMatte(new Uint8Array(await readFile(file)), info.width, info.height, width, height) }] };
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vf", `select='not(mod(n\\,${step}))',scale=${width}:${height}:flags=area,format=gray`,
    "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"];
  const chunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg could not read the matte: ${error.trim().slice(0, 200)}`))));
  });
  const all = Buffer.concat(chunks), size = width * height, frames = [];
  for (let at = 0; at + size <= all.length; at += size) frames.push({ index: (at / size) * step, matte: new Uint8Array(all.subarray(at, at + size)) });
  return { width, height, frames };
}

/** The outline of every sampled frame of a matte: { width, height, step, frames: [{ index, points|null }] }. */
export async function outlineOfMatte({ folder, info, step = OUTLINE_DEFAULTS.step, points = OUTLINE_DEFAULTS.points }) {
  const read = await readMatteFrames({ folder, info, step });
  return { width: read.width, height: read.height, step, frames: read.frames.map(({ index, matte }) => ({ index, points: traceOutline(matte, read.width, read.height, { points }) })) };
}
