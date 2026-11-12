// lift_dark (edit op): brightens a dark shot with a curve read from the shot's own tones, not a
// gamma wash. Why: a director lifted stair shots at mean luma 30 to 35 of 255 with color-wheels
// gamma 1.8 to 63 to 73, and the picture went gray and low in contrast, with the source's
// compression blocks showing on the dark wall (.scratch/dm2/a/result.md, qc-2.md).
//
// The curve keeps the shot's black point (its 2nd percentile luma) where it is, fades the lift in
// over the deepest shadows (black point to 10th percentile), raises the mids as an exposure in
// linear light from the black point, and rolls the highlights off (colorUtility.js rollOff), so
// the brightest parts keep their separation instead of clipping. One strength is solved so the
// shot's mean reaches the target. When the mids gain a stop or more, a small grain matched to the
// curve's own slope goes on too, so the block edges the lift amplifies break up.
//
// Pure: the frames come from the caller (backend/agent/lift-dark.mjs renders them). Both effects
// are ordinary ones (curves, grain), so preview, look and render draw them the same way.
import { curvesTables } from "../effects/colorMath.js";
import { rollOff, toLinear, toSrgb } from "../effects/colorUtility.js";
import { smoothstep } from "../numbers.js";

export const LIFT_SUFFIX = ".lift";
export const LIFT_GRAIN_SUFFIX = ".lift-grain";
export const liftId = (layerId) => `${layerId}${LIFT_SUFFIX}`;
export const liftGrainId = (layerId) => `${layerId}${LIFT_GRAIN_SUFFIX}`;
export const LIFT_DEBLOCK_SUFFIX = ".lift-deblock";
export const liftDeblockId = (layerId) => `${layerId}${LIFT_DEBLOCK_SUFFIX}`;

// The largest lift: 4 stops on the mids (16 times the light), a guess past the 3 match_references uses.
export const MAX_STOPS = 4;
// Points on the curve between the black point and white (the curves effect takes 16 at most).
const CURVE_STEPS = 13;
// Grain goes on from a lift of 1 stop (the mids twice as bright); its amount is clamped to a fine
// texture (0.04) up to below the finish's heavy film (0.35).
const GRAIN_FROM_STOPS = 1;
const GRAIN_MIN = 0.04;
const GRAIN_MAX = 0.25;
// The grain effect's tile values have a spread of 0.144 around 0.5 (four even randoms, finish.js),
// and hard light moves a value v by about 2 x amount x (grain - 0.5) x v.
const GRAIN_SPREAD = 0.144;

// Video black (16 of 255, the limited-range floor): the highest level kept as black when the
// darkest level is a large flat area (a drawn fill, a flat card) rather than a toe of shadows.
const VIDEO_BLACK = 16 / 255;

const luma = (pixels, at) => 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];

/**
 * The level the lift keeps where it is: the 2nd percentile when the shadows spread above it (filmed
 * footage), but no higher than video black when a tenth of the picture or more sits on that one
 * level (drawn footage's flat dark fill), so the fill rises with the rest instead of staying dark.
 */
export function blackPoint(stats) {
  const black = Math.min(0.25, Math.max(0, stats.p2));
  return stats.p10 - black < 1 / 255 ? Math.min(black, VIDEO_BLACK) : black;
}

/**
 * The pixels of an RGBA frame wholly inside `box` ({x0, y0, x1, y1} in scene pixels; `scale` frame
 * pixels per scene pixel; an edge pixel half on a bar is left out), or the frame when none is.
 */
export function cropFrame(frame, box, scale = 1) {
  if (!frame?.pixels?.length || !box) return frame;
  const x0 = Math.max(0, Math.ceil(box.x0 * scale - 1e-6)), y0 = Math.max(0, Math.ceil(box.y0 * scale - 1e-6));
  const x1 = Math.min(frame.width, Math.floor(box.x1 * scale + 1e-6)), y1 = Math.min(frame.height, Math.floor(box.y1 * scale + 1e-6));
  if (x1 - x0 < 1 || y1 - y0 < 1 || (x0 === 0 && y0 === 0 && x1 === frame.width && y1 === frame.height)) return frame;
  const width = x1 - x0, pixels = new Uint8ClampedArray(width * (y1 - y0) * 4);
  for (let y = y0; y < y1; y += 1) pixels.set(frame.pixels.subarray((y * frame.width + x0) * 4, (y * frame.width + x1) * 4), (y - y0) * width * 4);
  return { width, height: y1 - y0, pixels };
}

/** {mean, p2, p10, p50, p90, p98, contrast} of RGBA frames' Rec. 709 luma, 0 to 1 (contrast is p90 - p10). */
export function lumaStats(frames) {
  const histogram = new Float64Array(256);
  let total = 0, sum = 0;
  for (const frame of frames ?? []) {
    const pixels = frame?.pixels;
    if (!pixels?.length) continue;
    for (let at = 0; at < pixels.length; at += 4) {
      const value = luma(pixels, at);
      histogram[Math.min(255, Math.round(value))] += 1;
      sum += value;
      total += 1;
    }
  }
  if (!total) return null;
  const at = (share) => {
    let seen = 0;
    for (let value = 0; value < 256; value += 1) { seen += histogram[value]; if (seen >= share * total) return value / 255; }
    return 1;
  };
  const [p2, p10, p50, p90, p98] = [0.02, 0.1, 0.5, 0.9, 0.98].map(at);
  return { mean: sum / total / 255, p2, p10, p50, p90, p98, contrast: p90 - p10 };
}

/**
 * The curve's output at `x` (0 to 1) for a shot with `stats` lifted by `stops`: unchanged up to the
 * black point, then an exposure in linear light measured from the black point with a highlight
 * roll-off, faded in between the black point and the 10th percentile.
 */
export function liftValue(x, stats, stops) {
  const black = blackPoint(stats);
  if (x <= black) return x;
  const u = (x - black) / (1 - black);
  // Divided by white's own value, so white stays white (the roll-off alone ends short of 1).
  const exposed = (value) => toSrgb(rollOff(2 ** stops * toLinear(value), 1));
  const lifted = black + (1 - black) * exposed(u) / exposed(1);
  // The toe ends at the 10th percentile, or halfway to the median when the shadows sit on the
  // black point (a picture with a large black area), so the levels just above black stay dark.
  const toe = Math.max(stats.p10, black + (stats.p50 - black) / 2, black + 0.03);
  const weight = smoothstep(Math.min(1, (x - black) / (toe - black)));
  return x + weight * (lifted - x);
}

/** The curves effect's master points for a lift (at most 16, inputs rising). */
export function liftCurve(stats, stops) {
  const black = blackPoint(stats);
  const points = [[0, 0]];
  if (black > 0.002) points.push([round4(black), round4(black)]);
  for (let step = 1; step <= CURVE_STEPS; step += 1) {
    // Denser near the black point, where the curve bends most.
    const x = black + (1 - black) * (step / CURVE_STEPS) ** 1.6;
    points.push([round4(x), round4(liftValue(x, stats, stops))]);
  }
  return points;
}

const round4 = (value) => Math.round(value * 10_000) / 10_000;

/** RGBA frames drawn through one 256-entry table per channel (values 0 to 1, as curvesTables gives). */
export function applyTables(frames, tables) {
  return frames.map((frame) => {
    const pixels = new Uint8ClampedArray(frame.pixels.length);
    for (let at = 0; at < pixels.length; at += 4) {
      pixels[at] = Math.round(tables[0][frame.pixels[at]] * 255);
      pixels[at + 1] = Math.round(tables[1][frame.pixels[at + 1]] * 255);
      pixels[at + 2] = Math.round(tables[2][frame.pixels[at + 2]] * 255);
      pixels[at + 3] = frame.pixels[at + 3];
    }
    return { width: frame.width, height: frame.height, pixels };
  });
}

const curved = (frames, stats, stops) => applyTables(frames, curvesTables({ master: liftCurve(stats, stops) }));

/** A plain gamma lift as tables (output = input ^ (1 / gamma)), for the receipt's comparison. */
export const gammaTables = (gamma) => [0, 1, 2].map(() => Array.from({ length: 256 }, (_, index) => (index / 255) ** (1 / gamma)));

// The value (to 0.01) in [low, high] that brings mean(value) nearest `target` (bisection: the mean rises with it).
function solve(mean, target, low, high) {
  for (let step = 0; step < 16; step += 1) {
    const middle = (low + high) / 2;
    if (mean(middle) < target) low = middle; else high = middle;
  }
  return Math.round(((low + high) / 2) * 100) / 100;
}

/** The gamma that brings `frames` to the mean `target`, and the stats it draws ({gamma, stats}). */
export function gammaToMean(frames, target) {
  const gamma = solve((value) => lumaStats(applyTables(frames, gammaTables(value))).mean, target, 1, 6);
  return { gamma, stats: lumaStats(applyTables(frames, gammaTables(gamma))) };
}

/**
 * The lift that brings one shot's frames (RGBA, as the viewer sees them) to the mean luma `target`
 * (0 to 1), or null when the shot is at or above it already. Returns {before, after, stops, curve,
 * grain}: before and after are lumaStats; grain is {amount, size} or null below GRAIN_FROM_STOPS.
 * `sourceScale` is scene pixels per source pixel (1 when unknown), the grain's size.
 */
export function liftShot(frames, target, { sourceScale = 1 } = {}) {
  const usable = (frames ?? []).filter((frame) => frame?.pixels?.length);
  const before = lumaStats(usable);
  if (!before || !Number.isFinite(target) || target <= before.mean + 1 / 255) return null;
  const stops = solve((value) => lumaStats(curved(usable, before, value)).mean, target, 0, MAX_STOPS);
  if (!(stops > 0)) return null;
  const curve = liftCurve(before, stops);
  const after = lumaStats(applyTables(usable, curvesTables({ master: curve })));
  // A curve that moves nothing (every pixel at or under the kept black) is no lift.
  if (after.mean - before.mean < 1 / 255) return null;
  return { before, after, stops, curve, grain: liftGrain(before, stops, { sourceScale }) };
}

// Codec block sides in source pixels: 8 (JPEG, MPEG-2, MPEG-4 part 2, 8x8 transforms) and 16
// (H.264 and later macroblocks).
const BLOCK_SIDES = [8, 16];
// A grid line within half a frame pixel of a pixel boundary counts as on it; a boundary 1.5 frame
// pixels or more from every grid line is inside a block (a scaled picture spreads a step over 2).
const ON_LINE = 0.5;
const OFF_LINE = 1.5;
// Deblock when the steps on the grid lines are 1.5 times or more those inside the blocks and at
// least 0.1 of a level larger (a guess: noise and real detail measure about 1, the stair shot that
// showed blocks measured 2.9 on its 16-pixel grid).
const BLOCKY_RATIO = 1.5;
const BLOCKY_STEP = 0.1;

/**
 * The level steps on a codec's block grid against those inside the blocks, over RGBA frames (Rec.
 * 709 luma, 0 to 255 levels). `grid` places the source on the frame: {x0, y0} the source's top
 * left in frame pixels, {pitchX, pitchY} frame pixels per source pixel, `box` the part of the frame
 * to measure ({x0, y0, x1, y1}, frame pixels) and `side` the block side in source pixels.
 * `grid` may also be a list, one per frame (a picture that moves or zooms), each with its own side.
 * Returns {side, edge, inside, step, ratio} (step = edge - inside) or null when nothing was measured.
 */
export function blockStep(frames, grid = {}) {
  let edge = 0, edgeCount = 0, inside = 0, insideCount = 0;
  const side = (Array.isArray(grid) ? grid[0]?.side : grid.side) ?? 8;
  // Frame pixels from the boundary at `at` (on the axis starting at `origin`) to the nearest grid line.
  const distance = (at, origin, pitch) => {
    const blocks = (at - origin) / (pitch * side);
    return Math.abs(blocks - Math.round(blocks)) * pitch * side;
  };
  for (const [index, frame] of (frames ?? []).entries()) {
    const pixels = frame?.pixels;
    const placed = Array.isArray(grid) ? grid[index] : grid;
    if (!pixels?.length || !placed) continue;
    const { x0 = 0, y0 = 0, pitchX = 1, pitchY = 1, box = null } = placed;
    const { width, height } = frame;
    const left = Math.max(0, Math.ceil(box?.x0 ?? 0)), top = Math.max(0, Math.ceil(box?.y0 ?? 0));
    const right = Math.min(width, Math.floor(box?.x1 ?? width)), bottom = Math.min(height, Math.floor(box?.y1 ?? height));
    const add = (step, near) => {
      if (near < ON_LINE) { edge += step; edgeCount += 1; } else if (near >= OFF_LINE) { inside += step; insideCount += 1; }
    };
    for (let x = left + 1; x < right; x += 1) {
      const near = distance(x, x0, pitchX);
      if (near >= ON_LINE && near < OFF_LINE) continue;
      for (let y = top; y < bottom; y += 1) add(Math.abs(luma(pixels, (y * width + x) * 4) - luma(pixels, (y * width + x - 1) * 4)), near);
    }
    for (let y = top + 1; y < bottom; y += 1) {
      const near = distance(y, y0, pitchY);
      if (near >= ON_LINE && near < OFF_LINE) continue;
      for (let x = left; x < right; x += 1) add(Math.abs(luma(pixels, (y * width + x) * 4) - luma(pixels, ((y - 1) * width + x) * 4)), near);
    }
  }
  if (!edgeCount || !insideCount) return null;
  const onLine = edge / edgeCount, within = inside / insideCount;
  return { side, edge: onLine, inside: within, step: onLine - within, ratio: within > 0 ? onLine / within : onLine > 0 ? Infinity : 1 };
}

/**
 * The blockiest of the codec grids (8 and 16 source pixels) on frames, as blockStep gives it, or
 * null when the grid is too fine to tell on these frames (a block under 4 frame pixels).
 */
export function blockiness(frames, grid) {
  const grids = Array.isArray(grid) ? grid : [grid];
  const pitch = Math.min(...grids.flatMap((entry) => [entry?.pitchX ?? 1, entry?.pitchY ?? 1]));
  const withSide = (side) => (Array.isArray(grid) ? grid.map((entry) => entry && { ...entry, side }) : { ...grid, side });
  const found = BLOCK_SIDES.filter((side) => side * pitch >= 4)
    .map((side) => blockStep(frames, withSide(side))).filter(Boolean);
  return found.length ? found.reduce((best, entry) => (entry.ratio > best.ratio ? entry : best)) : null;
}

/**
 * Where a video's source pixels sit on the scene: {x0, y0, pitchX, pitchY} for a layer box ({x0,
 * y0, x1, y1}, scene pixels) and the file's {width, height}. A video is drawn whole and centered in
 * its box (render.js: preserveAspectRatio meet), so a 16:9 clip in a 9:16 box gets bars above and
 * below and one scale on both axes. Null when either size is unknown.
 */
export function sourceGrid(box, size) {
  const boxWidth = (box?.x1 ?? 0) - (box?.x0 ?? 0), boxHeight = (box?.y1 ?? 0) - (box?.y0 ?? 0);
  if (!(boxWidth > 0 && boxHeight > 0 && size?.width > 0 && size?.height > 0)) return null;
  const pitch = Math.min(boxWidth / size.width, boxHeight / size.height);
  return { x0: box.x0 + (boxWidth - size.width * pitch) / 2, y0: box.y0 + (boxHeight - size.height * pitch) / 2, pitchX: pitch, pitchY: pitch };
}

/**
 * The deblock effect's parameters for a measured blockiness, or null when the steps on the grid
 * are not clearly larger than inside the blocks. Radius: a quarter of a block, in scene pixels
 * (`sourceScale` scene pixels per source pixel). Threshold: four times the mean step on the grid
 * lines, at least 1.5 and at most 6 levels, so a block step is smoothed and a real edge is not.
 */
export function deblockFor(measured, sourceScale = 1) {
  if (!measured || measured.ratio < BLOCKY_RATIO || measured.step < BLOCKY_STEP) return null;
  return {
    radius: Math.round(Math.min(32, Math.max(0.5, (measured.side / 4) * sourceScale)) * 10) / 10,
    threshold: Math.round(Math.min(6, Math.max(1.5, 4 * measured.edge)) / 255 * 1000) / 1000,
  };
}

/**
 * The grain for a lift, or null under GRAIN_FROM_STOPS: its spread matches one source level as the
 * curve draws it at the shot's median (the step a block edge makes), so a lift that amplifies the
 * blocks more gets more grain. Size: one grain per source pixel.
 */
export function liftGrain(stats, stops, { sourceScale = 1 } = {}) {
  if (stops < GRAIN_FROM_STOPS) return null;
  const middle = Math.min(0.98, Math.max(stats.p50, stats.p2 + 0.02));
  const output = liftValue(middle, stats, stops);
  const slope = (liftValue(middle + 1 / 255, stats, stops) - output) * 255;
  const amount = (slope / 255) / (2 * GRAIN_SPREAD * Math.max(0.05, output));
  return {
    amount: Math.round(Math.min(GRAIN_MAX, Math.max(GRAIN_MIN, amount)) * 100) / 100,
    size: Math.round(Math.min(4, Math.max(1, sourceScale)) * 10) / 10,
  };
}
