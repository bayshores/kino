// What kino measures once in an uploaded picture, from a small gray copy of it (backend/index.mjs
// measureStillImage): how much of it is sharp edges (UI screenshots have many, photos few) and
// its busiest part, the region with the most local contrast on a coarse grid. Screen recipes
// push toward that region when the agent names none, and frozen_screen / screen_unreadable
// use both to tell a screenshot from a photo.

// A pixel is an edge when it differs from its right or lower neighbor by this much (0 to 255).
const EDGE = 28;
// The busy region is this share of the picture's width and height.
const REGION = 0.4;
// A pixel is flat when it differs from its neighbors by at most this much: UI is mostly flat
// fills between sharp edges, a photo has grain and gradients everywhere.
const FLAT = 3;
// Positions tried along each axis.
const STEPS = 7;

/**
 * Facts about a picture from its gray pixels (one byte a pixel, row by row, `width` x `height`,
 * about 96 px wide). Returns {edges, flat, busy}: the shares of edge and flat pixels (0 to 1), busy the
 * busiest region as [x, y, w, h] in % of the picture. `flatStep` overrides FLAT (video frames: 0).
 */
export function imageFacts(gray, width, height, { flatStep = FLAT } = {}) {
  const energy = new Float32Array(width * height);
  let edges = 0;
  let flat = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const at = y * width + x;
    const right = x + 1 < width ? Math.abs(gray[at] - gray[at + 1]) : 0;
    const down = y + 1 < height ? Math.abs(gray[at] - gray[at + width]) : 0;
    const step = Math.max(right, down);
    energy[at] = step;
    if (step >= EDGE) edges += 1;
    if (step <= flatStep) flat += 1;
  }
  // A summed table, so each window's total is four lookups.
  const sums = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1)
    sums[(y + 1) * (width + 1) + x + 1] = energy[y * width + x] + sums[y * (width + 1) + x + 1] + sums[(y + 1) * (width + 1) + x] - sums[y * (width + 1) + x];
  const total = (x0, y0, x1, y1) => sums[y1 * (width + 1) + x1] - sums[y0 * (width + 1) + x1] - sums[y1 * (width + 1) + x0] + sums[y0 * (width + 1) + x0];
  const [w, h] = [Math.max(1, Math.round(width * REGION)), Math.max(1, Math.round(height * REGION))];
  let best = null;
  for (let i = 0; i < STEPS; i += 1) for (let j = 0; j < STEPS; j += 1) {
    const x = Math.round(((width - w) * i) / (STEPS - 1));
    const y = Math.round(((height - h) * j) / (STEPS - 1));
    // Ties go to the window nearest the middle, so a flat picture pushes to its center.
    const score = total(x, y, x + w, y + h) - 1e-6 * (Math.abs(i - 3) + Math.abs(j - 3));
    if (!best || score > best.score) best = { score, x, y };
  }
  const percent = (value, size) => Math.round((1000 * value) / size) / 10;
  return { edges: Math.round((1000 * edges) / (width * height)) / 1000, flat: Math.round((1000 * flat) / (width * height)) / 1000, busy: [percent(best.x, width), percent(best.y, height), percent(w, width), percent(h, height)] };
}

/**
 * True when a picture reads as a screenshot: wider than tall or phone-shaped, mostly flat fills
 * (60% or more; photos measure under 50%) with sharp edges between them (3% or more).
 */
export function looksLikeScreen({ width, height, edges, flat }) {
  if (!(width > 0 && height > 0) || typeof edges !== "number" || typeof flat !== "number") return false;
  const shape = width / height;
  return edges >= 0.03 && flat >= 0.6 && (shape >= 1.05 || (shape >= 0.4 && shape <= 0.6));
}

// A video frame reads as a screen when, on a 384 px wide gray copy, 8% or more of its pixels are
// sharp edges (text) and 45% or more are exactly flat (UI fills). Measured on 16 clips: screen
// recordings 11-17% and 50-73%, camera footage under 35% flat (or under 7% edges when flatter).
export const CLIP_FACTS_WIDTH = 384;
export function looksLikeScreenClip({ width, height, edges, flat }) {
  if (!(width > 0 && height > 0) || typeof edges !== "number" || typeof flat !== "number") return false;
  const shape = width / height;
  return edges >= 0.08 && flat >= 0.45 && (shape >= 1.05 || (shape >= 0.4 && shape <= 0.75));
}
