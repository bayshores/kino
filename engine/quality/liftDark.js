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

// The largest lift: 4 stops on the mids (16 times the light), a guess past the 3 match_references uses.
const MAX_STOPS = 4;
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
