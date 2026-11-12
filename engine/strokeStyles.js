// Stroke looks for one `strokes` entry beyond a plain line: a taper (the line narrows to a point
// at its start, its end or both) and the neon style (a thin light core inside a dim, wide, soft
// glow). Both are plain SVG: a taper is an outline polygon built from the path's points, and the
// glow is the same line blurred twice, so every renderer draws the same picture.
import { parsePath } from "./vectorPath.js";

// Neon defaults. Start points from the streak-field and cutout-composite studies (their final
// stair edge was a 3 px core over 12 px and 26 px bands plus a glow); the brightness numbers were
// then lowered until the line no longer outshone the reference's thin, dim edge (guesses tuned by
// eye against the reference frames, see the study's after-lines-streaks.jpg).
export const NEON_DEFAULTS = Object.freeze({ width: 3, glow: 24 });
const NEON = Object.freeze({
  // How much of the way to white the core is, and how opaque each part is.
  coreWhite: 0.3, coreOpacity: 0.85,
  haloWidth: 2.5, haloOpacity: 0.3, haloBlur: 0.6,
  glowOpacity: 0.14, glowBlur: 0.4,
});

const fmt = (value) => {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/** A color `amount` of the way to white (hex in, hex out; alpha digits kept). */
export function towardWhite(color, amount) {
  const digits = color.length <= 5 ? [...color.slice(1)].map((digit) => digit + digit).join("") : color.slice(1);
  const channels = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
  const lighter = channels.map((value) => Math.round(value + (255 - value) * amount).toString(16).padStart(2, "0"));
  return `#${lighter.join("")}${digits.slice(6)}`.toUpperCase();
}

const cubicAt = (p0, c1, c2, p3, t) => {
  const u = 1 - t;
  return [0, 1].map((axis) => u * u * u * p0[axis] + 3 * u * u * t * c1[axis] + 3 * u * t * t * c2[axis] + t * t * t * p3[axis]);
};

/** Each contour of `d` as a list of points about `step` apart (corners kept). */
export function contourPoints(d, step = 4) {
  return parsePath(d).map((contour) => {
    const points = [contour.start];
    let from = contour.start;
    const segments = contour.closed && (contour.segments.at(-1)?.end ?? from).some((value, axis) => value !== contour.start[axis])
      ? [...contour.segments, { c1: contour.segments.at(-1)?.end ?? from, c2: contour.start, end: contour.start }] : contour.segments;
    for (const segment of segments) {
      const rough = Math.hypot(segment.c1[0] - from[0], segment.c1[1] - from[1]) + Math.hypot(segment.c2[0] - segment.c1[0], segment.c2[1] - segment.c1[1])
        + Math.hypot(segment.end[0] - segment.c2[0], segment.end[1] - segment.c2[1]);
      const pieces = Math.max(1, Math.min(256, Math.ceil(rough / step)));
      for (let index = 1; index <= pieces; index += 1) points.push(cubicAt(from, segment.c1, segment.c2, segment.end, index / pieces));
      from = segment.end;
    }
    return points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 1e-6);
  }).filter((points) => points.length > 1);
}

/**
 * The outline of a line `width` wide along `d` that narrows to a point over the first
 * `taper.start` and the last `taper.end` share of each contour's length (0 keeps the width).
 */
export function taperedOutline(d, width, taper = {}) {
  const start = Math.max(0, Math.min(1, taper.start ?? 0)), end = Math.max(0, Math.min(1, taper.end ?? 0));
  return contourPoints(d, Math.max(1, width / 2)).map((points) => {
    const lengths = [0];
    for (let index = 1; index < points.length; index += 1)
      lengths.push(lengths[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
    const total = lengths.at(-1) || 1;
    const half = (at) => {
      const share = at / total;
      const rise = start > 0 ? Math.min(1, share / start) : 1, fall = end > 0 ? Math.min(1, (1 - share) / end) : 1;
      return (width / 2) * Math.min(rise, fall);
    };
    const direction = (a, b) => { const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / length, (b[1] - a[1]) / length]; };
    const left = [], right = [];
    points.forEach((point, index) => {
      const before = direction(points[Math.max(0, index - 1)], points[Math.max(1, index)]);
      const after = direction(points[Math.min(points.length - 2, index)], points[Math.min(points.length - 1, index + 1)]);
      let nx = -(before[1] + after[1]), ny = before[0] + after[0];
      const length = Math.hypot(nx, ny) || 1;
      nx /= length; ny /= length;
      // A miter at a corner: the offset grows as the corner sharpens (capped at twice the width).
      const cosine = Math.max(0.5, nx * -before[1] + ny * before[0]);
      const offset = half(lengths[index]) / cosine;
      left.push([point[0] + nx * offset, point[1] + ny * offset]);
      right.push([point[0] - nx * offset, point[1] - ny * offset]);
    });
    return `M${[...left, ...right.reverse()].map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}Z`;
  }).join("");
}

/**
 * The markup for one tapered or neon entry. `line(attributes)` draws the plain path with those
 * attributes; `pathData()` gives its path data (needed for a taper; without it the taper is
 * skipped). `blur(radius)` returns a filter attribute that softens by `radius` px.
 */
export function styledStroke(entry, { line, pathData, blur }) {
  const cap = entry.cap ?? (entry.style === "neon" ? "round" : "butt");
  const join = entry.join ?? (entry.style === "neon" ? "round" : "miter");
  const tapered = entry.taper && (entry.taper.start > 0 || entry.taper.end > 0) && pathData ? pathData() : null;
  const draw = (color, width, opacity, filter = "") => {
    const alpha = opacity < 1 ? ` opacity="${fmt(opacity)}"` : "";
    if (tapered) return `<path d="${taperedOutline(tapered, width, entry.taper)}" fill="${color}" stroke="none"${alpha}${filter}/>`;
    return line(`fill="none" stroke="${color}" stroke-width="${fmt(width)}"${alpha} stroke-linecap="${cap}" stroke-linejoin="${join}" stroke-miterlimit="10"${filter}`);
  };
  const opacity = entry.opacity ?? 1;
  if (entry.style !== "neon") return draw(entry.color, entry.width, opacity);
  const width = entry.width, glow = entry.glow ?? NEON_DEFAULTS.glow;
  const parts = [];
  if (glow > 0) parts.push(draw(entry.color, glow, NEON.glowOpacity, blur(glow * NEON.glowBlur)));
  parts.push(draw(entry.color, width * NEON.haloWidth, NEON.haloOpacity, blur(width * NEON.haloBlur)));
  parts.push(draw(towardWhite(entry.color, NEON.coreWhite), width, NEON.coreOpacity));
  return `<g${opacity < 1 ? ` opacity="${fmt(opacity)}"` : ""}>${parts.join("")}</g>`;
}
