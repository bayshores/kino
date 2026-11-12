// Mosaic: a picture shown as a grid of flat-colored cells (each cell the picture's mean color
// there, blurred then sampled at the cell center), with gaps between the cells. Progress runs the
// reveal: cells arrive in an order (clusters, random, a sweep at an angle, center out), cells then
// merge into coarser blocks, and blocks resolve to the clean picture; at progress 1 the layer is
// drawn as it was. The move mosaic-reveal animates progress (0 to 1 to enter, 1 to 0 to leave).
// The colors are filters on the layer, so on a clip they follow the playing video.
//
// Where the defaults come from (.scratch/recreate/product-film, GAPS item 13, reference frames
// f122 to f222 at 25 fps, the reveal of a 708 x 928 photo):
//   cell 30 px    the reference pitch: 15 px at 960 wide (zoom of f185), so 30 at 1080p.
//   gap 9 px      squares about 20.6 px in a 30 px pitch (f185 zoom), so 9.4 px; merged blocks
//                 keep the same gap (about 9 px between 4 x 4 blocks).
//   radius 2 px   slightly rounded corners (about 1 px at 960 wide): measured by eye on the zoom.
//   dots 2        before a cell arrives its place shows 2 x 2 small dots in the picture's color
//                 (f160 zoom: dots 7 px apart at 960, so 2 a cell; about 5 px wide at 1080p).
//   merges 2      cells merge into 2 x 2 then 4 x 4 blocks (f185, f195); then blocks of 8 x 8
//                 cells resolve to the clean picture (the clean face block at f195 is 240 px).
//   timing        cells arrive over the first 55% (f175, at 53%, is nearly full); 2 x 2 merges from
//                 40%, 4 x 4 from 50% (MERGE_SPANS); clean blocks over 66% to 97% (f195 at 73%:
//                 about 3 of 12 blocks clean, f210 at 88%: about 9); clean blocks join without
//                 a gap, so by 97% the picture is whole. The shares are fitted to this one
//                 reference; other edits change them with the move's fields.
import { copiesEffect, copySource, filterEffect } from "./svg.js";
import { renderPixelate } from "./postFx.js";
import { clamp } from "../numbers.js";

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });

export const MOSAIC_ORDERS = Object.freeze(["clusters", "random", "sweep", "center"]);
// The largest cell a flat block may have (pixelate's own limit): coarser merges are left out.
const MAX_BLOCK = 128;
const BUILD_END = 0.55;
const DOT_LEAD = 0.12;
// A span may run past 1: blocks timed after their clean block never show merged, so only part of
// the grid merges, as in the reference (2 x 2 blocks hold about 7% of the cells at f175, a quarter
// at f195; 4 x 4 blocks about 16% at f195).
const MERGE_SPANS = [[0.4, 1.6], [0.5, 1.9]];
const CLEAN_SPAN = [0.66, 0.97];

export const MOSAIC_EFFECT = {
  key: "mosaic", label: "Mosaic", group: "Post FX", kind: "ranged", render: renderMosaic,
  parameters: {
    progress: number("Progress", 1, 0, 1, 0.01, "", { initial: 0 }),
    cell: number("Cell", 30, 4, 128, 1, "px", { integer: true, animatable: false }),
    gap: number("Gap", 9, 0, 64, 0.5, "px"),
    radius: number("Corner Radius", 2, 0, 64, 0.5, "px"),
    order: { type: "enum", label: "Order", default: "clusters", options: MOSAIC_ORDERS.map((value) => [value, value[0].toUpperCase() + value.slice(1)]) },
    angle: number("Sweep Angle", 0, -180, 180, 1, "°", { animatable: false }),
    merges: number("Merges", 2, 0, 2, 1, "", { integer: true, animatable: false }),
    dots: number("Dots", 2, 0, 4, 1, "", { integer: true, animatable: false }),
    outline: number("Outline", 0, 0, 1, 0.01),
    outlineColor: { type: "color", label: "Outline Color", default: "#000000" },
    seed: number("Seed", 1, 0, 1_000_000, 1, "", { integer: true, animatable: false }),
  },
};

function read(frame, key) {
  const field = MOSAIC_EFFECT.parameters[key];
  const value = frame?.parameters?.[key];
  if (field.type === "enum") return field.options.some(([option]) => option === value) ? value : field.default;
  if (field.type === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : field.default;
  const result = clamp(Number.isFinite(value) ? value : field.default, field.min, field.max);
  return field.integer ? Math.round(result) : result;
}

const fmt = (value) => { const rounded = Number(value.toFixed(3)); return Object.is(rounded, -0) ? "0" : String(rounded); };

function random(seed) {
  let state = (seed * 2654435761 + 1013904223) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Values to ranks 0..1 (ties by index), so arrivals spread evenly over their span.
function ranks(values) {
  const order = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Array(values.length);
  order.forEach(([, index], position) => { out[index] = values.length > 1 ? position / (values.length - 1) : 0; });
  return out;
}

// The cell order: one value per cell, smaller arrives first.
function cellValues(cols, rows, order, angle, next) {
  const values = [];
  const diagonal = Math.hypot(cols, rows) || 1;
  // clusters: a few seed points start at random times and grow outward, with jitter, so single
  // cells and small clumps appear first and fill in (the reference's build at f125 to f150).
  const seeds = order === "clusters" ? Array.from({ length: clamp(Math.round(Math.sqrt(cols * rows) / 3), 3, 12) },
    () => ({ x: next() * cols, y: next() * rows, start: next() * 0.6 })) : [];
  const radians = angle * Math.PI / 180, dx = Math.cos(radians), dy = Math.sin(radians);
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const jitter = next();
    if (order === "random") values.push(jitter);
    else if (order === "sweep") values.push(((col + 0.5) * dx + (row + 0.5) * dy) / diagonal + jitter * 0.15);
    else if (order === "center") values.push(Math.hypot(col + 0.5 - cols / 2, row + 0.5 - rows / 2) / diagonal + jitter * 0.15);
    else values.push(Math.min(...seeds.map((seed) => seed.start + 2 * Math.hypot(col + 0.5 - seed.x, row + 0.5 - seed.y) / diagonal)) + jitter * 0.35);
  }
  return ranks(values);
}

// Blocks of `size` cells: their switch time in [from, to], earlier where their cells arrived early.
function blockTimes(cellRank, cols, rows, size, [from, to], next) {
  const blockCols = Math.ceil(cols / size), blockRows = Math.ceil(rows / size);
  const values = [];
  for (let by = 0; by < blockRows; by += 1) for (let bx = 0; bx < blockCols; bx += 1) {
    let sum = 0, count = 0;
    for (let row = by * size; row < Math.min(rows, (by + 1) * size); row += 1)
      for (let col = bx * size; col < Math.min(cols, (bx + 1) * size); col += 1) { sum += cellRank[row * cols + col]; count += 1; }
    values.push(sum / count + next() * 0.3);
  }
  return { cols: blockCols, times: ranks(values).map((rank) => from + (to - from) * rank) };
}

const plans = new Map();
/** The reveal plan for a grid: arrival times per cell and switch times per merged and clean block. */
export function mosaicPlan({ width, height, cell, merges, order, angle, seed }) {
  const key = JSON.stringify([width, height, cell, merges, order, angle, seed]);
  if (plans.has(key)) return plans.get(key);
  const cols = Math.max(1, Math.ceil(width / cell - 1e-6)), rows = Math.max(1, Math.ceil(height / cell - 1e-6));
  const next = random(seed);
  const cellRank = cellValues(cols, rows, order, angle, next);
  const arrival = cellRank.map((rank) => rank * BUILD_END);
  const levels = [];
  for (let level = 1; level <= merges && cell * 2 ** level <= MAX_BLOCK; level += 1)
    levels.push({ size: 2 ** level, ...blockTimes(cellRank, cols, rows, 2 ** level, MERGE_SPANS[level - 1], next) });
  const cleanSize = 2 ** (levels.length + 1);
  const clean = { size: cleanSize, ...blockTimes(cellRank, cols, rows, cleanSize, CLEAN_SPAN, next) };
  const plan = { cols, rows, arrival, levels, clean };
  if (plans.size > 64) plans.clear();
  plans.set(key, plan);
  return plan;
}

/** Each cell's state at progress p: "none", "dots", 0 (a cell), 1.. (a merged level) or "clean". */
export function mosaicStates(plan, p) {
  const { cols, rows, arrival, levels, clean } = plan;
  const blockOf = (level, col, row) => Math.floor(row / level.size) * level.cols + Math.floor(col / level.size);
  const states = new Array(cols * rows);
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const index = row * cols + col;
    let state = "none";
    if (clean.times[blockOf(clean, col, row)] <= p) state = "clean";
    else {
      for (let level = levels.length; level >= 1 && state === "none"; level -= 1)
        if (levels[level - 1].times[blockOf(levels[level - 1], col, row)] <= p) state = level;
      if (state === "none" && arrival[index] < p) state = 0;
      else if (state === "none" && arrival[index] - DOT_LEAD < p) state = "dots";
    }
    states[index] = state;
  }
  return states;
}

export function renderMosaic(frame) {
  const p = read(frame, "progress");
  if (p >= 1) return frame.content;
  if (p <= 0) return copiesEffect(frame, "");
  const cell = read(frame, "cell"), gap = read(frame, "gap"), radius = read(frame, "radius");
  const dots = read(frame, "dots"), outline = read(frame, "outline");
  const { x, y, width, height } = frame.bounds;
  const plan = mosaicPlan({ width, height, cell, merges: read(frame, "merges"), order: read(frame, "order"), angle: read(frame, "angle"), seed: read(frame, "seed") });
  const states = mosaicStates(plan, p);
  const sizes = [1, ...plan.levels.map((level) => level.size)];
  const shapes = { clean: [], dots: [], outline: [] };
  sizes.forEach((_, level) => { shapes[level] = []; });
  const rx = Math.min(radius, Math.max(0, cell - gap) / 2);
  const block = (col, row, size, inset) => {
    const left = x + col * cell, top = y + row * cell;
    const right = Math.min(x + width, left + size * cell), bottom = Math.min(y + height, top + size * cell);
    const w = right - left - inset * 2, h = bottom - top - inset * 2;
    return w > 0 && h > 0 ? { left: left + inset, top: top + inset, w, h } : null;
  };
  const rect = (box, round = rx) => `<rect x="${fmt(box.left)}" y="${fmt(box.top)}" width="${fmt(box.w)}" height="${fmt(box.h)}"${round > 0 ? ` rx="${fmt(round)}"` : ""} fill="#fff"/>`;
  for (let row = 0; row < plan.rows; row += 1) for (let col = 0; col < plan.cols; col += 1) {
    const state = states[row * plan.cols + col];
    if (state === "none") continue;
    if (state === "dots") {
      if (!dots) continue;
      const step = cell / dots, r = Math.max(0.75, cell * 0.08);
      for (let i = 0; i < dots; i += 1) for (let j = 0; j < dots; j += 1) {
        const cx = x + col * cell + (i + 0.5) * step, cy = y + row * cell + (j + 0.5) * step;
        if (cx < x + width && cy < y + height) shapes.dots.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="#fff"/>`);
      }
      continue;
    }
    const size = state === "clean" ? plan.clean.size : sizes[state];
    // A block is drawn once, from its top-left cell.
    if (col % size || row % size) continue;
    if (state === "clean") {
      // Clean blocks join their clean neighbors and the layer's edge without a gap, so the picture
      // reads whole where it has resolved and the last frame does not jump (the reference's clean
      // area at f210 has no grid lines; the gap stays only where a clean block meets cells). Square
      // corners on clean blocks: a guess, rounded ones would notch where clean blocks meet.
      const bx = col / size, by = row / size;
      const clean = (dx, dy) => {
        const nx = bx + dx, ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= plan.clean.cols || ny * size >= plan.rows) return true;
        return plan.clean.times[ny * plan.clean.cols + nx] <= p;
      };
      const whole = block(col, row, size, 0);
      if (!whole) continue;
      // A flush side overlaps its neighbor by half a pixel so no antialiased seam shows between them.
      const half = gap / 2;
      const l = clean(-1, 0) ? -0.5 : half, r = clean(1, 0) ? -0.5 : half, t = clean(0, -1) ? -0.5 : half, b = clean(0, 1) ? -0.5 : half;
      const box = { left: whole.left + l, top: whole.top + t, w: whole.w - l - r, h: whole.h - t - b };
      if (box.w > 0 && box.h > 0) shapes.clean.push(rect(box, 0));
      if (outline > 0) shapes.outline.push(rect(whole, 0));
      continue;
    }
    const box = block(col, row, size, gap / 2);
    if (box) shapes[state].push(rect(box));
    if (outline > 0) { const whole = block(col, row, size, 0); if (whole) shapes.outline.push(rect(whole, 0)); }
  }
  const area = `x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}"`;
  const masked = (parts, content) => {
    if (!parts.length) return "";
    const id = frame.helpers.id("mosaic-mask");
    frame.helpers.defs.push(`<mask id="${id}" mask-type="alpha" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ${area}>${parts.join("")}</mask>`);
    return `<g mask="url(#${id})">${content}</g>`;
  };
  const source = copySource(frame);
  // Flat color of a block `size` cells wide: the picture blurred about a block (a mean, with the
  // alpha made whole again so the frame edge does not darken the outer cells), then pixelated.
  const flat = (size) => {
    const blurred = filterEffect({ ...frame, content: source }, [
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(cell * size * 0.3)}"/>`,
      '<feComponentTransfer><feFuncA type="table" tableValues="1 1"/></feComponentTransfer>',
    ], { padding: 0, contain: true });
    return renderPixelate({ ...frame, content: blurred, parameters: { pixelSize: cell * size } });
  };
  let markup = "";
  if (outline > 0 && shapes.outline.length) {
    markup += masked(shapes.outline, `<rect ${area} fill="${read(frame, "outlineColor")}" opacity="${fmt(outline)}"/>`);
  }
  const cellColors = shapes[0].length || shapes.dots.length ? flat(1) : "";
  markup += masked([...shapes[0], ...shapes.dots], cellColors);
  sizes.slice(1).forEach((size, index) => { markup += masked(shapes[index + 1], flat(size)); });
  markup += masked(shapes.clean, source);
  frame.helpers.includeBounds?.(frame.bounds);
  return copiesEffect(frame, markup);
}
