// The values of Lottie's Drop Shadow effect (ty 25) for one layer, one sample per exported frame.
//
// Lottie describes a drop shadow with five tracks (lottie-web's SVG drop shadow filter):
//   Shadow Color  red, green and blue from 0 to 1
//   Opacity       0 to 255
//   Direction     degrees clockwise from straight up (90 is right, 180 is down)
//   Distance      the length of the offset in pixels
//   Softness      lottie-web blurs by softness / 4 and the editor's shadow filter by blur / 2
//                 (engine/render.js), so softness is 2 × blur
// The editor stores the offset as x and y, so each frame's x and y become a direction and a
// distance. These rules keep the exported motion the same as the editor's:
// - A frame without a shadow (null) is written as the nearest frame's shadow with opacity 0. This
//   is the rule the editor uses ("no shadow" is the same shadow with zero alpha; see
//   engine/shadowInterpolation.js), so a shadow that appears fades in place instead of sliding out
//   from under the layer. When two frames are equally near, the earlier one is used.
// - A frame whose offset is 0 has no direction of its own. It takes the nearest frame's direction,
//   so the angle does not jump while the distance is 0.
// - Lottie interpolates between frames, so a direction that passes straight down, where the angle
//   wraps from 180 to -180, would spin the long way round. Each direction is moved by whole turns
//   to within half a turn of the frame before it. The first frame's direction is from -180 to 180,
//   as a still shadow's always was.

const finite = (value) => Number(value) || 0;
// Offsets shorter than this have no direction.
const NO_DIRECTION = 1e-9;

// The index of the nearest sample (earlier first on a tie) for which `has(index)` is true, or -1.
function nearestIndex(count, index, has) {
  for (let step = 1; step < count; step += 1) {
    if (index - step >= 0 && has(index - step)) return index - step;
    if (index + step < count && has(index + step)) return index + step;
  }
  return -1;
}

// Degrees clockwise from straight up for an offset in screen coordinates (y down).
const directionOf = ([x, y]) => (Math.atan2(y, x) * 180) / Math.PI + 90;

/**
 * The Drop Shadow tracks for `shadows` (one shadow or null per frame), or null when no frame has
 * a shadow. `colorToRgba` reads a color as [red, green, blue 0..255, alpha 0..1] or null.
 * Returns { color: [[r, g, b] 0..1], opacity: [0..255], direction: [degrees], distance: [px],
 * softness: [Lottie units] }, one entry per frame.
 */
export function lottieShadowTracks(shadows, colorToRgba) {
  const count = shadows.length;
  const present = shadows.map((shadow) => Boolean(shadow && typeof shadow === "object"));
  if (!present.some(Boolean)) return null;
  const frames = shadows.map((shadow, index) =>
    present[index]
      ? { shadow, transparent: false }
      : { shadow: shadows[nearestIndex(count, index, (other) => present[other])], transparent: true },
  );
  const colors = frames.map(({ shadow, transparent }) => {
    const rgba = colorToRgba(shadow.color);
    if (!rgba) throw new Error("The shadow color cannot be exported to Lottie.");
    return transparent ? [rgba[0], rgba[1], rgba[2], 0] : rgba;
  });
  const offsets = frames.map(({ shadow }) => [finite(shadow.x), finite(shadow.y)]);
  const distance = offsets.map(([x, y]) => Math.hypot(x, y));
  const hasDirection = (index) => distance[index] > NO_DIRECTION;
  const direction = [];
  offsets.forEach((offset, index) => {
    const source = hasDirection(index) ? index : nearestIndex(count, index, hasDirection);
    const degrees = directionOf(source < 0 ? offset : offsets[source]);
    if (index === 0) {
      direction.push(degrees > 180 ? degrees - 360 : degrees);
      return;
    }
    const previous = direction[index - 1];
    direction.push(degrees + 360 * Math.round((previous - degrees) / 360));
  });
  return {
    color: colors.map((rgba) => rgba.slice(0, 3).map((channel) => channel / 255)),
    opacity: colors.map((rgba) => Math.round(rgba[3] * 255)),
    direction,
    distance,
    softness: frames.map(({ shadow }) => 2 * Math.max(0, finite(shadow.blur))),
  };
}
