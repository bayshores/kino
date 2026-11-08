// Small pieces every move builds with: named easing curves, animation records in the shapes the
// document stores, a layer's box, and the math for scaling a layer about a point.
//
// Everything here is plain data in, plain data out. Times are seconds on the scene's clock,
// positions are scene pixels, and a layer scales and turns about the center of its box.
import { round } from "../../numbers.js";

/** Cubic-bezier curves the moves use. None is linear (the linear_motion gate). */
export const CURVES = Object.freeze({
  // Speeds up all the way: a camera pushing into something it will pass through.
  accelerate: Object.freeze([0.7, 0, 0.84, 0]),
  // Starts fast, lands soft: a shot arriving after a fast move.
  settle: Object.freeze([0.16, 1, 0.3, 1]),
  // Slow, fast, slow, with the speed peak in the middle: a whip or a flight across the frame.
  whip: Object.freeze([0.65, 0, 0.35, 1]),
  // A strong in-and-out for a layer flying to its place.
  fly: Object.freeze([0.76, 0, 0.24, 1]),
  // A quick, soft arrival for small things (words, labels).
  arrive: Object.freeze([0.22, 1, 0.36, 1]),
  // A gentle drift that never looks mechanical.
  drift: Object.freeze([0.37, 0, 0.63, 1]),
  // Leaving: slow start, gone fast.
  leave: Object.freeze([0.55, 0, 1, 0.45]),
  // A fade that is neither linear nor bouncy.
  fade: Object.freeze([0.33, 0, 0.67, 1]),
});

export { round };

/** A move or fade the document stores: kind is "in", "out" or "custom". */
export function motion({ name, kind = "custom", start, duration, easing, from, to }) {
  return { name, kind, start: round(start), duration: round(Math.max(0.001, duration)), easing: [...easing], unit: "layer", stagger: 0, order: "forward", from, to };
}

/** An effect animation (zoom-blur, rgb-shift, sparks, …). `to` holds its settings. */
export function effect({ name, effect: key, start, duration, easing, from, to, keepStill }) {
  return { name, kind: "effect", effect: key, start: round(start), duration: round(Math.max(0.001, duration)), easing: [...easing], ...(from ? { from } : {}), to, ...(keepStill ? { keepStill } : {}) };
}

/** An instant hide or show at `start`. */
export const hide = (start) => ({ name: "Hide", kind: "hide", start: round(start) });
export const show = (start) => ({ name: "Show", kind: "show", start: round(start) });

/** A change of a text layer's words at `start`: the old words blur out, the new ones slide up. */
export function changeText({ start, text, outSeconds = 0.14, inSeconds = 0.24, distance = 14 }) {
  return {
    name: "Change text", kind: "change-text", start: round(start), text, overlap: false,
    out: { preset: "blur-out", duration: round(outSeconds), easing: [...CURVES.leave], unit: "layer", stagger: 0, order: "forward" },
    in: { preset: "slide-up", duration: round(inSeconds), easing: [...CURVES.arrive], unit: "layer", stagger: 0, order: "forward", distance: Math.round(distance) },
  };
}

/** A layer's box. */
export const boxOf = (layer) => ({ x: layer.x, y: layer.y, width: layer.width, height: layer.height });
export const centerOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * Where a layer's top-left corner must be when it is scaled by `scale` (about its center) so
 * that the scene point `point` stays where it is: the camera pushes into that point.
 */
export function scaledAbout(box, point, scale) {
  const center = centerOf(box);
  return { x: round(box.x + (point.x - center.x) * (1 - scale), 1), y: round(box.y + (point.y - center.y) * (1 - scale), 1) };
}

/** A point given as [x, y] in percent of a box, in scene pixels (the box's center when missing). */
export function pointIn(box, percent) {
  if (!percent) return centerOf(box);
  return { x: box.x + (box.width * percent[0]) / 100, y: box.y + (box.height * percent[1]) / 100 };
}

/** How much of the frame a box covers (0 to 1), counting only the part inside the frame. */
export function frameShare(box, frame) {
  const width = Math.max(0, Math.min(frame.width, box.x + box.width) - Math.max(0, box.x));
  const height = Math.max(0, Math.min(frame.height, box.y + box.height) - Math.max(0, box.y));
  return (width * height) / (frame.width * frame.height);
}

/**
 * Whether a layer, as drawn at `time` (its own scale, about its center), lies flat and covers more
 * than 90% of the frame. Only then can its picture be mirrored past its edges without the copies
 * showing: a shrunk or tilted screen (ui-plane) would show mirrored copies around it.
 */
export function coversFrameAt(ctx, layerId, time) {
  const state = ctx.stateAt(layerId, time);
  if (state.rotation || state.rotateX || state.rotateY || state.skewX) return false;
  const width = state.width * Math.abs(state.scaleX ?? 1);
  const height = state.height * Math.abs(state.scaleY ?? 1);
  const box = { x: state.x + (state.width - width) / 2, y: state.y + (state.height - height) / 2, width, height };
  return frameShare(box, ctx.frame) > 0.9;
}

/** A color as #RRGGBB mixed toward another by `amount` (0 keeps the first). */
export function mix(color, other, amount) {
  const channel = (hex, index) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  const parts = [0, 1, 2].map((index) => Math.round(channel(color, index) + (channel(other, index) - channel(color, index)) * amount));
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Relative luminance of #RRGGBB (0 black to 1 white). */
export function luminance(color) {
  const linear = (value) => {
    const share = value / 255;
    return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 1, 2].map((index) => linear(parseInt(color.slice(1 + index * 2, 3 + index * 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two #RRGGBB colors (1 to 21). */
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The outline of a glyph (its `path` in font units, y up) as closed polygons of [x, y] points. */
function glyphPolygons(path) {
  const polygons = [];
  let points = [];
  let at = [0, 0];
  const tokens = path.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  let index = 0;
  const number = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const command = tokens[index++].toUpperCase();
    if (command === "M") {
      if (points.length) polygons.push(points);
      at = [number(), number()];
      points = [at];
    } else if (command === "L") {
      at = [number(), number()];
      points.push(at);
    } else if (command === "Q") {
      const control = [number(), number()];
      const end = [number(), number()];
      for (let step = 1; step <= 6; step += 1) {
        const t = step / 6;
        points.push([0, 1].map((axis) => (1 - t) ** 2 * at[axis] + 2 * (1 - t) * t * control[axis] + t ** 2 * end[axis]));
      }
      at = end;
    } else if (command === "C") {
      const first = [number(), number()];
      const second = [number(), number()];
      const end = [number(), number()];
      for (let step = 1; step <= 8; step += 1) {
        const t = step / 8;
        points.push([0, 1].map((axis) => (1 - t) ** 3 * at[axis] + 3 * (1 - t) ** 2 * t * first[axis] + 3 * (1 - t) * t ** 2 * second[axis] + t ** 3 * end[axis]));
      }
      at = end;
    } else if (command === "Z") {
      if (points.length) polygons.push(points);
      points = [];
    }
  }
  if (points.length) polygons.push(points);
  return polygons;
}

/** Where a straight line crosses the polygons' edges: x values along y = value (or y along x). */
function crossings(polygons, axis, value) {
  const other = 1 - axis;
  const found = [];
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      if ((a[axis] <= value) === (b[axis] <= value)) continue;
      found.push(a[other] + ((value - a[axis]) / (b[axis] - a[axis])) * (b[other] - a[other]));
    }
  }
  return found.sort((x, y) => x - y);
}

/** True when the point [x, y] (font units) is inside the ink: an odd number of edges to its right. */
function insideInk(polygons, x, y) {
  return crossings(polygons, 1, y).filter((value) => value > x).length % 2 === 1;
}

/**
 * The least scale at which a frame-shaped box centered on (x, y) lies wholly inside the ink
 * (inside(x, y) is true), checked at points around the box's edge: the push into the letter can
 * drop its mask at that scale without a gap showing. `unit` is the pixels per ink unit.
 */
export function coverScale(inside, x, y, frame, unit) {
  const fits = (scale) => {
    const halfWidth = frame.width / (2 * scale * unit);
    const halfHeight = frame.height / (2 * scale * unit);
    for (let step = 0; step <= 8; step += 1) {
      const along = -1 + step / 4;
      const points = [[x + along * halfWidth, y - halfHeight], [x + along * halfWidth, y + halfHeight], [x - halfWidth, y + along * halfHeight], [x + halfWidth, y + along * halfHeight]];
      if (!points.every(([px, py]) => inside(px, py))) return false;
    }
    return true;
  };
  let high = 4000;
  if (!fits(high)) return Infinity;
  let low = 1;
  for (let step = 0; step < 30; step += 1) {
    const middle = Math.sqrt(low * high);
    if (fits(middle)) high = middle; else low = middle;
  }
  return high;
}

/** Scans polygons for the point where a push fills the frame soonest: {x, middle, wide, tall, need} in their units. */
function scanInk(polygons, frame, unit) {
  const ys = polygons.flat().map((point) => point[1]);
  if (!ys.length) return null;
  const low = Math.min(...ys);
  const high = Math.max(...ys);
  const inside = (px, py) => insideInk(polygons, px, py);
  let best = null;
  for (let step = 2; step <= 18; step += 1) {
    const y = low + ((high - low) * step) / 20;
    const across = crossings(polygons, 1, y);
    for (let index = 0; index + 1 < across.length; index += 2) {
      const x = (across[index] + across[index + 1]) / 2;
      const wide = across[index + 1] - across[index];
      const down = crossings(polygons, 0, x);
      const pair = down.findIndex((value, at) => at % 2 === 0 && value <= y && down[at + 1] >= y);
      if (pair < 0) continue;
      const tall = down[pair + 1] - down[pair];
      // The middle of the ink down through x too, so the letter's edge is as far above as below.
      const middle = (down[pair] + down[pair + 1]) / 2;
      const need = coverScale(inside, x, middle, frame, unit);
      if (!Number.isFinite(need)) continue;
      if (!best || need < best.need) best = { x, middle, wide, tall, need };
    }
  }
  return best;
}

/**
 * A point inside the ink of a laid-out glyph (in its text layer's own pixels), where pushing in
 * fills the frame soonest, with the ink's width and height through that point (in pixels).
 * The point is the middle of the ink both across and down, and `need` is the scale at which the
 * whole frame, centered on it, is ink (so a mask shaped like the letter can go without a gap).
 * Returns null when the glyph has no outline. Inside/outside is even-odd, like the renderer.
 */
export function inkPoint(glyph, frame) {
  if (!glyph?.path) return null;
  const best = scanInk(glyphPolygons(glyph.path), frame, glyph.scale);
  return best && { x: glyph.x + best.x * glyph.scale, y: glyph.y - best.middle * glyph.scale, width: best.wide * glyph.scale, height: best.tall * glyph.scale, need: best.need };
}

/** Whether a point (font units) is inside a glyph's ink. */
export function glyphInside(glyph) {
  const polygons = glyph?.path ? glyphPolygons(glyph.path) : [];
  return (x, y) => polygons.length > 0 && insideInk(polygons, (x - glyph.x) / glyph.scale, (glyph.y - y) / glyph.scale);
}

/**
 * The same for closed outlines in pixels (y down), such as a path's or a shape's: the point
 * where a push fills the frame soonest, its `need` and an inside(x, y) test. Null with no ink.
 */
export function outlineInk(polygons, frame) {
  const best = scanInk(polygons, frame, 1);
  return { best: best && { x: best.x, y: best.middle, need: best.need }, inside: (x, y) => insideInk(polygons, x, y) };
}

/**
 * The same for a picture's alpha grid ({columns, rows, solid: 1 where a cell is mostly opaque})
 * stretched over a width × height box: every solid cell's middle is tried.
 */
export function gridInk(grid, width, height, frame) {
  const inside = (x, y) => {
    const column = Math.floor((x / width) * grid.columns);
    const row = Math.floor((y / height) * grid.rows);
    return column >= 0 && row >= 0 && column < grid.columns && row < grid.rows && grid.solid[row * grid.columns + column] === 1;
  };
  let best = null;
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      if (grid.solid[row * grid.columns + column] !== 1) continue;
      const x = ((column + 0.5) / grid.columns) * width;
      const y = ((row + 0.5) / grid.rows) * height;
      const need = coverScale(inside, x, y, frame, 1);
      if (Number.isFinite(need) && (!best || need < best.need)) best = { x, y, need };
    }
  }
  return { best, inside };
}
