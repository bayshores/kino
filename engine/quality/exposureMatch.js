// Exposure match: each shot's brightness brought inside the range of the project's saved
// references (edit {op:"match_references"}, compose {footage} by default, check {fix:"auto"} on a
// reference_range brightness finding). It matches exposure and contrast only, never a reference's
// color or look. Why: run 6 measured a median brightness of 66 of 255 and run 3 was darker than 8 of
// its 9 references (.scratch/ceiling), while reference_range only said so.
//
// The grade is an ordinary color-grade animation named <layer>.match-ref (stops with a soft
// highlight shoulder, and contrast when the shot is flatter than every reference), so
// delete_animation or match_references {remove:true} takes it off. Pure: the frames come from the
// caller (backend/agent/exposure-match.mjs renders them).
import { brightness, frameContrast } from "./motionPixels.js";
import { rollOff, toLinear, toSrgb } from "../effects/colorUtility.js";

export const MATCH_SUFFIX = ".match-ref";
/** The id of the match grade on a layer. */
export const matchId = (layerId) => `${layerId}${MATCH_SUFFIX}`;
// As reference_range (rules/reference.js RANGE_REFS): no bound moves on one reference's say-so.
export const MATCH_REFS = 2;
// A dark shot aims at the middle of the references' lower third, never above their median (the
// task's rule: "aim at the lower third of the range when the footage is dark"). 1/6 is the middle of
// that third: a guess that keeps a margin from the low bound without lifting toward the median.
const AIM = 1 / 6;
// Guesses: 3 stops is the reach of the overexpose move's wash plus one; contrast 1.3 is the
// largest step reference_range's own contrast hint suggests (1.1 to 1.5) kept short of crushing.
const MAX_STOPS = 3;
const MAX_CONTRAST = 1.3;
// The highlight roll-off: 1 bends from 54% sRGB, so a lift never clips skin and eyes to one white
// (colorUtility.js rollOff; the overexpose move uses the same).
export const MATCH_SHOULDER = 1;
// Highlights that must not reach white: the 99.5th percentile of the brightest channel.
const TOP_SHARE = 0.995;

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/**
 * The saved references' brightness and contrast (from their fingerprints' look, the numbers
 * reference_range reads): {brightness, contrast}, each {low, high, median, n} (0 to 1) or null with
 * fewer than MATCH_REFS measured references.
 */
export function referenceLevels(refs) {
  const span = (key) => {
    const values = (refs ?? []).map((ref) => ref?.fingerprint?.look?.[key]).filter(Number.isFinite).sort((a, b) => a - b);
    return values.length >= MATCH_REFS ? { low: values[0], high: values.at(-1), median: median(values), n: values.length } : null;
  };
  return { brightness: span("brightness"), contrast: span("contrast") };
}

/**
 * The level (0 to 1) to bring a shot at `level` to, or null when it is inside the range already.
 * A shot brighter than every reference is brought down only with `lower`: the owner called the
 * edits dark, and on the run 6 copy (references 18 to 41 of 255, one a near-black grade) bringing
 * shots down darkened 10 of 18 shots by up to 3 stops (.scratch/defaults/exposure-match/after.md).
 */
export function aimFor(level, range, { lower = false } = {}) {
  if (!range || !Number.isFinite(level) || (level >= range.low && level <= range.high)) return null;
  if (level > range.high && !lower) return null;
  const span = range.high - range.low;
  return level < range.low ? Math.min(range.low + span * AIM, range.median) : Math.max(range.high - span * AIM, range.median);
}

/** The 256-entry table a color-grade {stops, shoulder, contrast} draws each sRGB channel with (colorUtility.js renderColorGrade). */
export function gradeTable({ stops = 0, shoulder = MATCH_SHOULDER, contrast = 1 } = {}) {
  const table = new Uint8ClampedArray(256);
  const gain = 2 ** stops;
  for (let value = 0; value < 256; value += 1) {
    const exposed = stops === 0 ? value / 255 : toSrgb(rollOff(gain * toLinear(value / 255), shoulder));
    table[value] = Math.round(Math.min(1, Math.max(0, contrast * (exposed - 0.5) + 0.5)) * 255);
  }
  return table;
}

/** An RGBA frame {width, height, pixels} drawn through `table`. */
export function gradeFrame(frame, table) {
  const pixels = new Uint8ClampedArray(frame.pixels.length);
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = table[frame.pixels[at]];
    pixels[at + 1] = table[frame.pixels[at + 1]];
    pixels[at + 2] = table[frame.pixels[at + 2]];
    pixels[at + 3] = frame.pixels[at + 3];
  }
  return { width: frame.width, height: frame.height, pixels };
}

const levelOf = (frames) => median(frames.map((frame) => brightness(frame) / 255));
const contrastOf = (frames) => median(frames.map(frameContrast));
const graded = (frames, grade) => { const table = gradeTable(grade); return frames.map((frame) => gradeFrame(frame, table)); };

// The brightest channel's TOP_SHARE percentile (0 to 1) over the frames.
function topOf(frames) {
  const counts = new Array(256).fill(0);
  let total = 0;
  for (const frame of frames) for (let at = 0; at < frame.pixels.length; at += 4) {
    counts[Math.max(frame.pixels[at], frame.pixels[at + 1], frame.pixels[at + 2])] += 1;
    total += 1;
  }
  let seen = 0;
  for (let value = 0; value < 256; value += 1) { seen += counts[value]; if (seen >= total * TOP_SHARE) return value / 255; }
  return 1;
}

// The stops (to 0.05) that bring the frames' level nearest `target` with `contrast` (bisection: the level rises with stops).
function solveStops(frames, target, contrast) {
  let low = -MAX_STOPS, high = MAX_STOPS;
  for (let step = 0; step < 14; step += 1) {
    const middle = (low + high) / 2;
    if (levelOf(graded(frames, { stops: middle, contrast })) < target) low = middle; else high = middle;
  }
  return Math.round(((low + high) / 2) * 20) / 20;
}

/**
 * The grade that brings one shot's frames (RGBA, as the viewer sees them) inside the references'
 * `levels` (referenceLevels), or null when the shot is inside already (or brighter, without
 * `lower`) or nothing is measured.
 * Returns {before, after, target, stops, shoulder, contrast, contrastBefore, contrastAfter}: levels
 * 0 to 1 (`after` is worked out on the same frames, the next check measures the render).
 */
export function matchShot(frames, levels, { lower = false } = {}) {
  const usable = (frames ?? []).filter((frame) => frame?.pixels?.length);
  if (!usable.length || !levels?.brightness) return null;
  const before = levelOf(usable);
  const target = aimFor(before, levels.brightness, { lower });
  if (target === null) return null;
  let stops = solveStops(usable, target, 1);
  let contrast = 1;
  // Contrast only when the shot is flatter than every reference after its exposure, and only as
  // far as its highlights leave room (contrast pivots at middle gray, so a top value t reaches
  // white at 0.5 / (t - 0.5)).
  const range = levels.contrast;
  if (range) {
    const exposed = graded(usable, { stops });
    const flat = contrastOf(exposed);
    if (flat < range.low) {
      const top = topOf(exposed);
      const room = top > 0.5 ? 0.5 / (top - 0.5) : MAX_CONTRAST;
      contrast = Math.floor(Math.min(MAX_CONTRAST, room, range.low / Math.max(flat, 0.01)) * 20) / 20;
      if (contrast > 1) stops = solveStops(usable, target, contrast); else contrast = 1;
    }
  }
  if (stops === 0 && contrast === 1) return null;
  const result = graded(usable, { stops, contrast });
  return {
    before, after: levelOf(result), target, stops, shoulder: MATCH_SHOULDER, contrast,
    contrastBefore: contrastOf(usable), contrastAfter: contrastOf(result),
  };
}

/** The color-grade parameters of a match (contrast only when it changes). */
export function matchParameters(match) {
  return { stops: match.stops, shoulder: match.shoulder, ...(match.contrast !== 1 ? { contrast: match.contrast } : {}) };
}
