// How a Color (fill) or Stroke animation mixes one paint into another.
//
// A paint is a hex color ("#rgb", "#rgba", "#rrggbb" or "#rrggbbaa") or a gradient
// { type: "linear" | "radial", angle, stops: [{ offset, color }] } with offsets from 0 to 1.
// animation.js calls interpolatePaint(from, to, progress) for the `fill` and `stroke` keys, and
// the editor canvas and every export draw the paint it returns, so they all show the same colors.
//
// The rules, for any two paints:
// - Solid to solid: red, green, blue and alpha each move in a straight line between the two
//   colors (0 to 255, rounded), in sRGB without premultiplied alpha. Alpha is written when either
//   color has it. This is the same mix the editor used before gradients could mix.
// - Solid to gradient (or back): the solid acts as a gradient of the other paint's type and angle
//   whose stops sit at the other paint's offsets and all have the solid's color.
// - Two gradients with the same number of stops: stop 1 mixes with stop 1, stop 2 with stop 2, and
//   so on, so stop positions move, colors mix as above, and the angle turns.
// - Two gradients with different numbers of stops: both are first "resampled" at every offset
//   either one has (the union), by reading each gradient's color at those offsets. The stops then
//   pair one to one at fixed positions, and only their colors mix. A hard edge (two stops at one
//   offset) stays a hard edge.
// - Linear to radial (or back): the stops mix as above for the whole animation, and the type
//   switches from the From type to the To type halfway (eased progress 0.5). The linear paint's
//   angle is kept the whole time, because a radial gradient has no visible angle.
// At progress 0 a gradient mix returns a copy of `from` and at 1 a copy of `to`. Easings that
// overshoot (Elastic, Overshoot) extrapolate; colors are clamped to 0..255, and stop offsets to
// 0..1 in order, which is what the SVG renderer does with such stops anyway.

const HEX_COLOR = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;
const GRADIENT_TYPES = new Set(["linear", "radial"]);
// Offsets closer than this are the same position (a hard edge).
const SAME_OFFSET = 1e-9;

/** True for a hex color string. */
export function isSolidPaint(paint) {
  return typeof paint === "string" && HEX_COLOR.test(paint);
}

/** True for a linear or radial gradient with at least two stops that have offsets and hex colors. */
export function isGradientPaint(paint) {
  return Boolean(
    paint &&
      typeof paint === "object" &&
      !Array.isArray(paint) &&
      GRADIENT_TYPES.has(paint.type) &&
      Array.isArray(paint.stops) &&
      paint.stops.length >= 2 &&
      paint.stops.every(
        (stop) => stop && Number.isFinite(stop.offset) && isSolidPaint(stop.color),
      ),
  );
}

/** A hex color as { rgba: [r, g, b, a] from 0 to 255, hasAlpha }, or null. */
export function parseHexColor(color) {
  if (!isSolidPaint(color)) return null;
  let digits = color.slice(1);
  if (digits.length === 3 || digits.length === 4)
    digits = [...digits].map((digit) => digit + digit).join("");
  const hasAlpha = digits.length === 8;
  const channel = (index) => Number.parseInt(digits.slice(index, index + 2), 16);
  return {
    rgba: [channel(0), channel(2), channel(4), hasAlpha ? channel(6) : 255],
    hasAlpha,
  };
}

/** Lowercase hex from 0..255 channels (rounded and clamped); alpha is written when `hasAlpha`. */
export function formatHexColor(rgba, hasAlpha) {
  const values = (hasAlpha ? rgba : rgba.slice(0, 3)).map((value) =>
    Math.max(0, Math.min(255, Math.round(value))),
  );
  return `#${values.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

const mixNumber = (from, to, progress) => from + (to - from) * progress;
const mixRgba = (from, to, progress) => from.map((value, index) => mixNumber(value, to[index], progress));
const clampOffset = (offset) => Math.max(0, Math.min(1, offset));

/** Mix two hex colors; `progress` 0 is `from` and 1 is `to`. Null when either is not a hex color. */
export function mixHexColor(from, to, progress) {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) return null;
  return formatHexColor(mixRgba(a.rgba, b.rgba, progress), a.hasAlpha || b.hasAlpha);
}

// A gradient's stops as numbers: offset, rgba channels, and whether the color was written with alpha.
function readStops(gradient) {
  return gradient.stops.map((stop) => {
    const color = parseHexColor(stop.color);
    return { offset: clampOffset(stop.offset), rgba: color.rgba, hasAlpha: color.hasAlpha };
  });
}

/**
 * The offsets of both stop lists together, in order. An offset that one list has twice (a hard
 * edge) is kept twice: each offset appears as often as the list that has it most often.
 */
export function unionOffsets(firstOffsets, secondOffsets) {
  const groups = (offsets) => {
    const result = [];
    for (const offset of [...offsets].sort((a, b) => a - b)) {
      const last = result.at(-1);
      if (last && Math.abs(last.offset - offset) <= SAME_OFFSET) last.count += 1;
      else result.push({ offset, count: 1 });
    }
    return result;
  };
  const merged = [...groups(firstOffsets), ...groups(secondOffsets)].sort((a, b) => a.offset - b.offset);
  const union = [];
  for (const group of merged) {
    const last = union.at(-1);
    if (last && Math.abs(last.offset - group.offset) <= SAME_OFFSET) last.count = Math.max(last.count, group.count);
    else union.push({ ...group });
  }
  return union.flatMap(({ offset, count }) => Array(count).fill(offset));
}

/**
 * The gradient's own colors read at `offsets` (sorted, from unionOffsets or another gradient), as
 * number stops. Between two stops the color is the straight-line mix the renderer draws; before
 * the first stop and after the last one it is that stop's color. When a gradient has several
 * stops at one offset, the copies of that offset take them in order, and extra copies repeat
 * the last one, so the gradient looks exactly the same.
 */
function resampleStops(stops, offsets) {
  const result = [];
  let index = 0;
  while (index < offsets.length) {
    const offset = offsets[index];
    let copies = 1;
    while (index + copies < offsets.length && Math.abs(offsets[index + copies] - offset) <= SAME_OFFSET) copies += 1;
    const here = stops.filter((stop) => Math.abs(stop.offset - offset) <= SAME_OFFSET);
    for (let copy = 0; copy < copies; copy += 1) {
      if (here.length) {
        const stop = here[Math.min(copy, here.length - 1)];
        result.push({ offset, rgba: [...stop.rgba], hasAlpha: stop.hasAlpha });
        continue;
      }
      const after = stops.findIndex((stop) => stop.offset > offset);
      if (after === 0 || after === -1) {
        const edge = after === 0 ? stops[0] : stops.at(-1);
        result.push({ offset, rgba: [...edge.rgba], hasAlpha: edge.hasAlpha });
        continue;
      }
      const left = stops[after - 1];
      const right = stops[after];
      const progress = (offset - left.offset) / (right.offset - left.offset);
      result.push({
        offset,
        rgba: mixRgba(left.rgba, right.rgba, progress),
        hasAlpha: left.hasAlpha || right.hasAlpha,
      });
    }
    index += copies;
  }
  return result;
}

const writeStops = (stops) =>
  stops.map((stop) => ({ offset: stop.offset, color: formatHexColor(stop.rgba, stop.hasAlpha) }));

/**
 * The same gradient with its stops at `offsets` (sorted, at least as many as it needs to keep its
 * look: every one of its own offsets, see unionOffsets). Colors are read from the gradient.
 */
export function resampleGradient(gradient, offsets) {
  if (!isGradientPaint(gradient)) throw new TypeError("resampleGradient needs a linear or radial gradient.");
  return {
    type: gradient.type,
    angle: Number.isFinite(gradient.angle) ? gradient.angle : 0,
    stops: writeStops(resampleStops(readStops(gradient), offsets.map(clampOffset))),
  };
}

/** A gradient of `geometry`'s type, angle and stop offsets whose stops all have `color`. */
export function solidAsGradient(color, geometry) {
  if (!isSolidPaint(color) || !isGradientPaint(geometry))
    throw new TypeError("solidAsGradient needs a hex color and a gradient.");
  return {
    type: geometry.type,
    angle: Number.isFinite(geometry.angle) ? geometry.angle : 0,
    stops: geometry.stops.map((stop) => ({ offset: clampOffset(stop.offset), color })),
  };
}

const clonePaint = (paint) => (typeof paint === "string" ? paint : structuredClone(paint));

// Stop offsets in order and within 0..1, as the renderer would draw them.
function orderedStops(stops) {
  let previous = 0;
  return stops.map((stop) => {
    previous = Math.max(previous, clampOffset(stop.offset));
    return { ...stop, offset: previous };
  });
}

function mixGradients(from, to, progress) {
  const fromStops = readStops(from);
  const toStops = readStops(to);
  let pairs;
  if (fromStops.length === toStops.length) {
    // Same stop count: stops pair by position in the list, so their offsets move too.
    pairs = fromStops.map((stop, index) => [stop, toStops[index]]);
  } else {
    const offsets = unionOffsets(fromStops.map((stop) => stop.offset), toStops.map((stop) => stop.offset));
    const a = resampleStops(fromStops, offsets);
    const b = resampleStops(toStops, offsets);
    pairs = a.map((stop, index) => [stop, b[index]]);
  }
  const stops = orderedStops(
    pairs.map(([a, b]) => ({
      offset: mixNumber(a.offset, b.offset, progress),
      color: formatHexColor(mixRgba(a.rgba, b.rgba, progress), a.hasAlpha || b.hasAlpha),
    })),
  );
  const fromAngle = Number.isFinite(from.angle) ? from.angle : 0;
  const toAngle = Number.isFinite(to.angle) ? to.angle : 0;
  if (from.type === to.type)
    return { type: from.type, angle: mixNumber(fromAngle, toAngle, progress), stops };
  // Linear and radial: the type switches halfway and the linear paint keeps its angle.
  const linearAngle = from.type === "linear" ? fromAngle : toAngle;
  return { type: progress < 0.5 ? from.type : to.type, angle: linearAngle, stops };
}

/**
 * The paint between `from` (progress 0) and `to` (progress 1); see the rules at the top of this
 * file. Paints that are neither hex colors nor gradients do not mix: `from` is kept until the end.
 */
export function interpolatePaint(from, to, progress) {
  if (isSolidPaint(from) && isSolidPaint(to)) return mixHexColor(from, to, progress);
  const fromGradient = isGradientPaint(from);
  const toGradient = isGradientPaint(to);
  const fromSolid = isSolidPaint(from);
  const toSolid = isSolidPaint(to);
  if (!(fromGradient || fromSolid) || !(toGradient || toSolid))
    return clonePaint(progress >= 1 ? to : from);
  if (progress === 0) return clonePaint(from);
  if (progress === 1) return clonePaint(to);
  const a = fromGradient ? from : solidAsGradient(from, to);
  const b = toGradient ? to : solidAsGradient(to, from);
  return mixGradients(a, b, progress);
}

// ---- A visibly different color, for the To side of a new Color operation ----

function rgbToHsl([r, g, b]) {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1 ? [chroma, second, 0]
      : section < 2 ? [second, chroma, 0]
        : section < 3 ? [0, chroma, second]
          : section < 4 ? [0, second, chroma]
            : section < 5 ? [second, 0, chroma]
              : [chroma, 0, second];
  const match = lightness - chroma / 2;
  return [r, g, b].map((value) => (value + match) * 255);
}

// The WCAG "relative luminance" of red, green and blue from 0 to 255: 0 is black and 1 is white.
function relativeLuminance([red, green, blue]) {
  const linear = (value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function luminanceContrast(a, b) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The WCAG contrast ratio of two hex colors' brightness, from 1 (equally bright) to 21 (black and
 * white). Alpha is ignored. Null when either is not a hex color.
 */
export function contrastRatio(a, b) {
  const first = parseHexColor(a);
  const second = parseHexColor(b);
  return first && second ? luminanceContrast(first.rgba, second.rgba) : null;
}

// contrastingColor's thresholds. Chroma is the largest channel minus the smallest, from 0 to 1.
const GRAY_CHROMA = 0.2; // below this a color looks gray: it has no clear hue to turn around
const VIVID_CHROMA = 0.5; // from this up, turning the hue moves a channel by half its range or more
const MIN_CONTRAST = 1.5; // a brightness ratio below this looks about as bright
const LIGHTNESS_STEP = 0.35;
const MIN_VISIBLE_ALPHA = 64; // alpha below a quarter of 255 is nearly invisible

/**
 * A color that is easy to tell apart from `color`, for the To side of a new Color animation:
 * - A grayish color (chroma below 0.2) has no hue to turn, so it gets 0.35 lighter (when dark) or
 *   darker (when light) in HSL lightness, keeping its slight tint.
 * - Any other color turns to the opposite hue. When that alone is subtle (chroma below 0.5 and a
 *   WCAG contrast ratio below 1.5, like a very dark red turning very dark teal), the lightness
 *   moves by 0.35 as well.
 * - Alpha is kept, except that a nearly invisible color (alpha below 64 of 255) becomes opaque.
 * A lightness move keeps the chroma, so a near-gray stays near-gray instead of turning vivid.
 */
export function contrastingColor(color) {
  const parsed = parseHexColor(color);
  if (!parsed) return "#ff6b3d";
  const [red, green, blue, alpha] = parsed.rgba;
  const [hue, saturation, lightness] = rgbToHsl([red, green, blue]);
  const chroma = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
  const movedLightness = lightness < 0.5 ? lightness + LIGHTNESS_STEP : lightness - LIGHTNESS_STEP;
  // The HSL saturation that keeps the same chroma at the moved lightness.
  const room = 1 - Math.abs(2 * movedLightness - 1);
  const movedSaturation = room > 0 ? Math.min(1, chroma / room) : 0;
  let next;
  if (chroma < GRAY_CHROMA) next = hslToRgb([hue, movedSaturation, movedLightness]);
  else {
    next = hslToRgb([hue + 180, saturation, lightness]);
    if (chroma < VIVID_CHROMA && luminanceContrast(next, parsed.rgba) < MIN_CONTRAST)
      next = hslToRgb([hue + 180, movedSaturation, movedLightness]);
  }
  const visibleAlpha = alpha < MIN_VISIBLE_ALPHA ? 255 : alpha;
  // A color that turned opaque needs no alpha digits; otherwise alpha is written as it was.
  return formatHexColor([...next, visibleAlpha], parsed.hasAlpha && visibleAlpha === alpha);
}

/** `paint` with every color replaced by contrastingColor; a gradient keeps its type, angle and offsets. */
export function contrastingPaint(paint) {
  if (isGradientPaint(paint))
    return {
      type: paint.type,
      angle: Number.isFinite(paint.angle) ? paint.angle : 0,
      stops: paint.stops.map((stop) => ({ offset: stop.offset, color: contrastingColor(stop.color) })),
    };
  return contrastingColor(isSolidPaint(paint) ? paint : "#000000");
}
