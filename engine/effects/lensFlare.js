// Lens flare: the shapes a bright light makes inside a camera lens, drawn over the layer.
//
// The light sits at (x, y) in the layer's box, so a flare on a small "sun" layer follows that
// layer wherever it moves. The flare itself is drawn in scene units (it spans the picture): the
// ghosts lie on the line from the light through the middle of the picture, like reflections
// between lens elements, and the flare fades out as the light leaves the picture.
//
// Three styles:
// - glint: a hot core with a soft halo and thin star spikes (a sparkle or a sun glint).
// - anamorphic: a long thin streak across the picture with stretched ghosts (a widescreen lens).
// - rings: discs and rings of colour along the line through the middle (a classic spherical lens).
//
// Every part is added as light (mix-blend-mode: plus-lighter), so it brightens what is behind
// it. Ghosts and rings are also laid under that as see-through colour, so they still show as
// tints on a light picture, where added light alone would only clip to white.
import { numberParameter } from "./periodicDisplacement.js";
import { hexColor } from "./glow.js";
import { inverse, point } from "../geometry.js";
import { sceneBoxInLayer } from "./lightRays.js";
import { clamp } from "../numbers.js";

export const FLARE_STYLES = Object.freeze(["glint", "anamorphic", "rings"]);

const fmt = (value) => {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** rgb (0..255) → [hue 0..360, saturation 0..1, lightness 0..1]. */
function toHsl([r, g, b]) {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === rr ? (gg - bb) / delta + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / delta + 2 : (rr - gg) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function hslHex([hue, saturation, lightness]) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const channel = (offset) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const value = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(clamp(value, 0, 1) * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(1 / 3)}${channel(0)}${channel(-1 / 3)}`.toUpperCase();
}

/** The flare colour turned round the colour wheel by `degrees`, kept bright and fairly saturated. */
function tint(rgb, degrees) {
  const [hue, saturation, lightness] = toHsl(rgb);
  return hslHex([hue + degrees, Math.max(0.45, saturation), clamp(lightness, 0.55, 0.75)]);
}

/** How much of the flare shows for a light at `source` (scene units): 1 inside, 0 well outside. */
export function flareVisibility(source, scene) {
  const outside = Math.max(0, -source.x, source.x - scene.width, -source.y, source.y - scene.height);
  return 1 - smoothstep(0, 0.12 * Math.hypot(scene.width, scene.height), outside);
}

export function renderLensFlare(frame) {
  const strength = numberParameter(frame, "strength", 1, 0, 4);
  if (strength === 0) return frame.content;
  const style = FLARE_STYLES.includes(frame.parameters?.style) ? frame.parameters.style : "glint";
  const size = numberParameter(frame, "size", 1, 0.05, 4);
  const angle = numberParameter(frame, "angle", 0, -360, 360);
  const rgb = hexColor(frame, "color", "#FFC890");
  const color = `rgb(${rgb.join(",")})`;
  const { width, height } = frame.bounds;
  // Without a scene (a lone effect frame), the layer's own box stands in for the picture.
  const scene = frame.helpers?.scene ?? { width, height, matrix: [1, 0, 0, 1, 0, 0] };
  const toLayer = inverse(scene.matrix);
  if (!toLayer) return frame.content;
  const source = point(scene.matrix, numberParameter(frame, "x", 0.3, -1, 2) * width, numberParameter(frame, "y", 0.3, -1, 2) * height);
  const visible = flareVisibility(source, scene) * Math.min(1, strength);
  if (visible <= 0.001) return frame.content;
  // Above 1, strength makes the light parts larger and hotter rather than only more opaque.
  const heat = Math.max(1, strength);
  const diagonal = Math.hypot(scene.width, scene.height) * size;
  const middle = { x: scene.width / 2, y: scene.height / 2 };
  const along = (t) => ({ x: source.x + t * (middle.x - source.x), y: source.y + t * (middle.y - source.y) });
  const gradient = (stops) => {
    const id = frame.helpers.id("flare-gradient");
    frame.helpers.defs.push(`<radialGradient id="${id}">${stops.map(([offset, stopColor, opacity]) =>
      `<stop offset="${offset}" stop-color="${stopColor}" stop-opacity="${fmt(clamp(opacity, 0, 1))}"/>`).join("")}</radialGradient>`);
    return `url(#${id})`;
  };
  const linear = (stops) => {
    const id = frame.helpers.id("flare-gradient");
    frame.helpers.defs.push(`<linearGradient id="${id}">${stops.map(([offset, stopColor, opacity]) =>
      `<stop offset="${offset}" stop-color="${stopColor}" stop-opacity="${fmt(clamp(opacity, 0, 1))}"/>`).join("")}</linearGradient>`);
    return `url(#${id})`;
  };
  const disc = (at, radius, fill) => `<circle cx="${fmt(at.x)}" cy="${fmt(at.y)}" r="${fmt(Math.max(0.5, radius))}" fill="${fill}"/>`;
  const streak = (at, length, thickness, degrees, fill) =>
    `<ellipse cx="${fmt(at.x)}" cy="${fmt(at.y)}" rx="${fmt(Math.max(1, length))}" ry="${fmt(Math.max(0.6, thickness))}" fill="${fill}" transform="rotate(${fmt(degrees)} ${fmt(at.x)} ${fmt(at.y)})"/>`;
  const ring = (at, radius, width, stroke, opacity) =>
    `<circle cx="${fmt(at.x)}" cy="${fmt(at.y)}" r="${fmt(Math.max(1, radius))}" fill="none" stroke="${stroke}" stroke-opacity="${fmt(opacity)}" stroke-width="${fmt(Math.max(0.5, width))}"/>`;

  const light = [], colour = [];
  const core = (radius) => {
    light.push(disc(source, diagonal * 0.16 * heat, gradient([[0, color, 0.35], [0.25, color, 0.12], [1, color, 0]])));
    light.push(disc(source, diagonal * radius * heat, gradient([[0, "#FFFFFF", 1], [0.3, "#FFFFFF", 0.9], [0.55, color, 0.45], [1, color, 0]])));
  };
  const spikeFill = linear([[0, color, 0], [0.42, color, 0.35], [0.5, "#FFFFFF", 1], [0.58, color, 0.35], [1, color, 0]]);

  if (style === "glint") {
    core(0.035);
    for (let index = 0; index < 4; index += 1) {
      const long = index % 2 === 0;
      light.push(streak(source, diagonal * (long ? 0.2 : 0.11) * heat, diagonal * (long ? 0.0018 : 0.0013), angle + index * 45, spikeFill));
    }
    light.push(ring(source, diagonal * 0.09, diagonal * 0.004, color, 0.07));
    for (const [t, radius, turn, opacity] of [[0.55, 0.012, 40, 0.5], [1.35, 0.022, -50, 0.35]])
      colour.push(disc(along(t), diagonal * radius, gradient([[0, tint(rgb, turn), opacity * 0.6], [0.8, tint(rgb, turn), opacity], [1, tint(rgb, turn), 0]])));
  } else if (style === "anamorphic") {
    core(0.028);
    const across = angle;
    light.push(streak(source, diagonal * 0.62 * heat, diagonal * 0.012, across,
      linear([[0, color, 0], [0.3, color, 0.08], [0.5, color, 0.3], [0.7, color, 0.08], [1, color, 0]])));
    light.push(streak(source, diagonal * 0.5 * heat, diagonal * 0.0022, across,
      linear([[0, color, 0], [0.25, color, 0.35], [0.47, "#FFFFFF", 0.9], [0.5, "#FFFFFF", 1], [0.53, "#FFFFFF", 0.9], [0.75, color, 0.35], [1, color, 0]])));
    for (const [t, radius, opacity] of [[0.45, 0.018, 0.22], [0.8, 0.01, 0.3], [1.3, 0.03, 0.16], [1.75, 0.016, 0.24]]) {
      const at = along(t);
      colour.push(streak(at, diagonal * radius * 2.6, diagonal * radius, across,
        gradient([[0, color, opacity * 0.5], [0.75, color, opacity], [1, color, 0]])));
    }
  } else {
    core(0.03);
    light.push(ring(source, diagonal * 0.2, diagonal * 0.012, color, 0.03));
    const ghosts = [[-0.22, 0.016, 30, "disc", 0.45], [0.32, 0.045, -40, "disc", 0.24], [0.52, 0.01, 180, "disc", 0.6],
      [0.7, 0.03, 90, "ring", 0.45], [1.12, 0.07, -25, "disc", 0.16], [1.4, 0.018, 200, "disc", 0.45],
      [1.7, 0.05, 60, "ring", 0.35], [2.05, 0.09, -70, "disc", 0.13]];
    for (const [t, radius, turn, kind, opacity] of ghosts) {
      const at = along(t), shade = tint(rgb, turn), r = diagonal * radius;
      colour.push(kind === "ring" ? ring(at, r, Math.max(1.5, r * 0.12), shade, opacity)
        : disc(at, r, gradient([[0, shade, opacity * 0.55], [0.82, shade, opacity], [0.92, shade, opacity * 1.3], [1, shade, 0]])));
    }
  }

  // The colour layer first (normal blending, a little weaker), then all the light added on top.
  const flare = `<g transform="matrix(${toLayer.map(fmt).join(" ")})"><g opacity="${fmt(visible * 0.45)}">${colour.join("")}</g><g style="mix-blend-mode:plus-lighter" opacity="${fmt(visible)}">${light.join("")}${colour.join("")}</g></g>`;
  // The flare can reach anywhere in the picture: include all of it (in layer units).
  const box = sceneBoxInLayer({ helpers: { scene } });
  const paint = frame.paintBounds ?? frame.bounds;
  if (box) frame.helpers.includeBounds?.(union(paint, box));
  return `<g>${frame.content}<g aria-hidden="true" pointer-events="none">${flare}</g></g>`;
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
