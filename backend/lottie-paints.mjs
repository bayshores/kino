// Gradient paint samples made ready for one Lottie gradient fill or stroke.
//
// The Lottie exporter samples a layer at every frame (export.mjs) and writes each paint property
// as keyframes. A Lottie gradient item has one type (linear or radial) and one stop count for the
// whole animation, but a Color or Stroke animation can mix a solid into a gradient, a linear
// gradient into a radial one, and gradients with different stop counts (engine/paintInterpolation.js).
// lottieGradientTracks turns the samples into that shape without changing what any frame shows:
// - A solid color frame becomes a gradient whose stops all have that color. It takes the type and
//   angle of the nearest gradient frame (a one-color gradient looks the same in any geometry).
// - A frame with no paint ("none": a stroke of weight 0) becomes the same gradient with clear
//   stops; the caller also gives it opacity 0, as before.
// - Every frame gets the largest stop count. A frame with fewer stops is resampled at the offsets
//   of the nearest frame that has the full count and all of its offsets (a Color animation's frames
//   use the union of its From and To offsets, so this is the usual case), otherwise at its own
//   offsets plus midpoints of its widest gaps. Either way its colors are read from the frame's own
//   gradient, so it looks the same up to color rounding (at most 1 of 255).
// - Lottie cannot change a gradient's type, so a paint that is linear in some frames and radial in
//   others becomes two tracks, one per type. Each track is visible only in the frames of its type;
//   the caller writes one Lottie item per track and switches them with hold keyframes.

import { isGradientPaint, resampleGradient, unionOffsets } from "../engine/paintInterpolation.js";

const SAME_OFFSET = 1e-9;
const CLEAR = "#00000000";

function nearestIndex(length, start, matches) {
  for (let distance = 0; distance < length; distance += 1) {
    if (start - distance >= 0 && matches(start - distance)) return start - distance;
    if (start + distance < length && matches(start + distance)) return start + distance;
  }
  return -1;
}

// True when `offsets` holds every one of `own` (as many times as `own` has it).
function containsOffsets(offsets, own) {
  return unionOffsets(offsets, own).length === offsets.length;
}

// `offsets` plus midpoints of the widest gaps until there are `count` of them.
function splitOffsets(offsets, count) {
  const result = [...offsets];
  while (result.length < count) {
    let widest = -1;
    let at = -1;
    for (let index = 0; index + 1 < result.length; index += 1) {
      const gap = result[index + 1] - result[index];
      if (gap > widest + SAME_OFFSET) {
        widest = gap;
        at = index;
      }
    }
    if (widest <= SAME_OFFSET) result.push(result.at(-1));
    else result.splice(at + 1, 0, (result[at] + result[at + 1]) / 2);
  }
  return result;
}

const uniform = (geometry, offsets, color) => ({
  type: geometry.type,
  angle: Number.isFinite(geometry.angle) ? geometry.angle : 0,
  stops: offsets.map((offset) => ({ offset, color })),
});

/**
 * `paints` holds one paint per sampled frame: null or "none" for no paint, a color string, or a
 * gradient. Returns null when no frame has a gradient. Otherwise returns { count, tracks }, where
 * `count` is the shared stop count and each track is { type, gradients, active }: one gradient per
 * frame (all of `type`, with `count` stops) and whether the track shows in that frame.
 */
export function lottieGradientTracks(paints) {
  const isGradient = (index) => isGradientPaint(paints[index]);
  const gradientIndexes = paints.map((_, index) => index).filter(isGradient);
  if (gradientIndexes.length === 0) return null;
  const count = Math.max(...gradientIndexes.map((index) => paints[index].stops.length));
  const isFull = (index) => isGradient(index) && paints[index].stops.length === count;
  const offsetsOf = (index) => paints[index].stops.map((stop) => stop.offset);

  const gradients = paints.map((paint, index) => {
    if (isFull(index)) return resampleGradient(paint, offsetsOf(index));
    if (isGradient(index)) {
      const own = offsetsOf(index);
      const source = nearestIndex(paints.length, index, (other) => isFull(other) && containsOffsets(offsetsOf(other), own));
      return resampleGradient(paint, source >= 0 ? offsetsOf(source) : splitOffsets(own, count));
    }
    const geometry = paints[nearestIndex(paints.length, index, isGradient)];
    const offsets = offsetsOf(nearestIndex(paints.length, index, isFull));
    const none = paint == null || (typeof paint === "string" && paint.trim().toLowerCase() === "none");
    return uniform(geometry, offsets, none ? CLEAR : paint);
  });

  const types = [...new Set(gradients.map((gradient) => gradient.type))];
  return {
    count,
    tracks: types.map((type) => ({
      type,
      gradients: gradients.map((gradient) => ({ ...gradient, type })),
      active: gradients.map((gradient) => gradient.type === type),
    })),
  };
}

/** Frame indexes after which `active` changes: where a track's item switches on or off. */
export function trackSwitchFrames(active) {
  const frames = new Set();
  for (let index = 0; index + 1 < active.length; index += 1) {
    if (active[index] !== active[index + 1]) frames.add(index);
  }
  return frames;
}
