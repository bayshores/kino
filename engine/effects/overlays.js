// Drawn overlays and a color flip, made in code (no downloaded textures):
// - speed-lines: thin tapered streaks running one way across the layer, sliding along it (the
//   "streamline" or speed-line look of comics and anime). Each line is a lens-shaped polygon:
//   pointed at both ends by `taper`, its widest point in the middle.
// - impact-lines: wedges pointing in from past the layer's edges toward a focus point, leaving a
//   clear middle (comic "focus" or "concentration" lines). Motion tools build the same look from
//   stretched noise lines bent around a point (Fractal Noise, then Polar Coordinates, Rect to
//   Polar); drawing the wedges directly gives the same picture with exact count and thickness.
//   `rate` redraws the set that many times a second (the flicker of drawn lines); 0 holds one set.
// - film-burn: a hot, uneven glow eating in from one edge, the look of film overexposed at a reel's
//   end. Built like the usual recipe: fractal (several octaves) noise, pushed toward an edge, run
//   through a dark-red, orange, yellow, white ramp and laid over the picture with screen (black
//   drops out, bright parts only lighten).
// - invert: every color flipped (1 - value), by amount; keepHue turns the hues back half a turn
//   afterwards so skin stays skin and only light and dark swap (the invert + hue-rotate 180 trick).
// Everything is the same for the same seed and time, and lands only inside the layer's box.
import { effectMapImage } from "./mapImage.js";
import { clipEffect, filterEffect } from "./svg.js";
import { clamp, smoothstep } from "../numbers.js";

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const boolean = (label, value) => ({ type: "boolean", label, default: value });
const color = (label, value) => ({ type: "color", label, default: value });
const choice = (label, value, options) => ({ type: "enum", label, default: value, options: options.map((option) => [option, option[0].toUpperCase() + option.slice(1)]) });
const seed = () => number("Seed", 0, 0, 1_000_000, 1, "", { integer: true, animatable: false });

// Line blends: how the lines sit on the picture (difference flips what is under them).
export const LINE_BLENDS = ["normal", "screen", "overlay", "multiply", "difference"];
export const BURN_BLENDS = ["screen", "add", "normal", "overlay"];

// Settings both line looks share. Thickness is at 1080p, in layer pixels.
const lineFields = (count, thickness, rate) => ({
  count: number("Count", count, 1, 400, 1, "", { integer: true }),
  thickness: number("Thickness", thickness, 0.5, 120, 0.5, "px"),
  // 0 keeps the width to the ends, 1 draws them to a point.
  taper: number("Taper", 1, 0, 1, 0.01),
  // How uneven the lines are (length, width and place): 0 all alike.
  variation: number("Variation", 0.6, 0, 1, 0.01),
  color: color("Color", "#FFFFFF"),
  opacity: number("Opacity", 0.85, 0, 1, 0.01),
  rate: number("Rate", rate, 0, 30, 1, "changes/s", { integer: true, animatable: false }),
  seed: seed(),
  blend: choice("Blend", "normal", LINE_BLENDS),
});

export const OVERLAY_EFFECTS = [
  { key: "speed-lines", label: "Speed Lines", group: "Post FX", kind: "ranged", keepStill: "off", render: (frame) => renderLines("speed-lines", frame),
    parameters: {
      ...lineFields(60, 4, 0),
      // The way the lines travel: 0 to the right, 90 down.
      angle: number("Angle", 180, -360, 360, 1, "°"),
      // A line's length as a share of the layer's diagonal (variation shortens some).
      length: number("Length", 0.35, 0.02, 1.5, 0.01),
      // Layer widths a second the lines slide along their angle.
      speed: number("Speed", 2.5, -20, 20, 0.05, "widths/s"),
      // How far each line fades from its head back to its tail: 0 even, 1 the tail fully clear
      // (a comet or falling code-rain line). Optional, so saved lines draw as before.
      fade: number("Fade", 0, 0, 1, 0.01, "", { optional: true }),
    } },
  { key: "impact-lines", label: "Impact Lines", group: "Post FX", kind: "ranged", keepStill: "off", render: (frame) => renderLines("impact-lines", frame),
    parameters: {
      ...lineFields(90, 14, 12),
      centerX: number("Center X", 0.5, -0.5, 1.5, 0.01), centerY: number("Center Y", 0.5, -0.5, 1.5, 0.01),
      // The clear middle's radius, as a share of the way from the focus to the farthest corner.
      inner: number("Inner", 0.45, 0, 0.95, 0.01),
    } },
  { key: "film-burn", label: "Film Burn", group: "Post FX", kind: "ranged", keepStill: "off", render: renderFilmBurn,
    parameters: {
      amount: number("Amount", 0.9, 0, 1, 0.01),
      edge: choice("Edge", "left", ["left", "right", "top", "bottom", "corner", "all"]),
      // How far in from the edge the burn reaches (share of the layer).
      reach: number("Reach", 0.5, 0, 1.5, 0.01),
      // The size of the blotches: 1 a few across the layer, higher smaller.
      scale: number("Scale", 1, 0.2, 8, 0.05),
      // How fast the blotches boil and drift.
      speed: number("Speed", 0.6, 0, 4, 0.05, "cycles/s"),
      rate: number("Rate", 24, 1, 60, 1, "changes/s", { integer: true, animatable: false }),
      deep: color("Deep", "#8C1406"), mid: color("Mid", "#FF6A13"), hot: color("Hot", "#FFE08A"),
      seed: seed(),
      blend: choice("Blend", "screen", BURN_BLENDS),
    } },
  { key: "invert", label: "Invert", group: "Color", kind: "ranged", keepStill: "off", render: renderInvert,
    parameters: {
      // No ramp in: a partly flipped picture is flat gray, so the flip is whole from its first frame.
      amount: number("Amount", 1, 0, 1, 0.01, ""),
      keepHue: boolean("Keep Hue", false),
    } },
];

const FIELDS = new Map(OVERLAY_EFFECTS.map((effect) => [effect.key, effect.parameters]));

function read(frame, effectKey, key) {
  const field = FIELDS.get(effectKey)[key];
  const value = frame?.parameters?.[key];
  if (field.type === "boolean") return typeof value === "boolean" ? value : field.default;
  if (field.type === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : field.default;
  if (field.type === "enum") return field.options.some(([option]) => option === value) ? value : field.default;
  const number = clamp(Number.isFinite(value) ? value : field.default, field.min, field.max);
  return field.integer ? Math.round(number) : number;
}

const fmt = (value) => {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

function hash(...values) {
  let state = 0x9e3779b9;
  for (const value of values) {
    state = Math.imul(state ^ (value | 0), 0x85ebca6b);
    state ^= state >>> 13;
    state = Math.imul(state, 0xc2b2ae35);
    state ^= state >>> 16;
  }
  return state >>> 0;
}
const unit = (...values) => hash(...values) / 0x100000000;

// Layer pixels per 1080p pixel: thickness reads the same on a 4K or a 720p layer.
const perPixel = (bounds) => Math.max(bounds.width, bounds.height) / 1920;

// A lens: pointed (by taper) at a and b, `width` wide in the middle.
function lens(ax, ay, bx, by, width, taper) {
  const length = Math.hypot(bx - ax, by - ay) || 1;
  const nx = -(by - ay) / length, ny = (bx - ax) / length;
  const half = width / 2, end = half * (1 - taper);
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const points = [[ax + nx * end, ay + ny * end], [mx + nx * half, my + ny * half], [bx + nx * end, by + ny * end],
    [bx - nx * end, by - ny * end], [mx - nx * half, my - ny * half], [ax - nx * end, ay - ny * end]];
  return `M${points.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}Z`;
}

/** The line shapes at a frame: [{d}] path data in layer units, for speed-lines or impact-lines. */
export function linePaths(key, frame) {
  const { x, y, width, height } = frame.bounds;
  if (!(width > 0) || !(height > 0)) return [];
  const get = (name) => read(frame, key, name);
  const count = get("count"), variation = get("variation"), taper = get("taper"), seedValue = get("seed");
  const thick = get("thickness") * perPixel(frame.bounds);
  const time = Number.isFinite(frame.time) ? Math.max(0, frame.time) : 0;
  const step = get("rate") > 0 ? Math.floor(time * get("rate") + 1e-6) : 0;
  const random = (index, salt) => unit(seedValue, step, index, salt);
  const paths = [];
  if (key === "speed-lines") {
    const turn = get("angle") * Math.PI / 180;
    const dx = Math.cos(turn), dy = Math.sin(turn);
    const diagonal = Math.hypot(width, height);
    const cx = x + width / 2, cy = y + height / 2;
    const longest = get("length") * diagonal;
    const span = diagonal + longest; // a line leaves one side fully before it comes back on the other
    const travel = get("speed") * width * time;
    for (let index = 0; index < count; index += 1) {
      const across = (random(index, 1) - 0.5) * diagonal;
      const length = longest * (1 - variation * random(index, 2));
      const along = (((random(index, 3) * span + travel) % span) + span) % span - span / 2;
      const ax = cx + dx * (along - length / 2) - dy * across, ay = cy + dy * (along - length / 2) + dx * across;
      const bx = ax + dx * length, by = ay + dy * length;
      paths.push(lens(ax, ay, bx, by, thick * (1 - 0.7 * variation * random(index, 4)), taper));
    }
  } else {
    const fx = x + get("centerX") * width, fy = y + get("centerY") * height;
    const far = Math.max(...[[x, y], [x + width, y], [x, y + height], [x + width, y + height]].map(([px, py]) => Math.hypot(px - fx, py - fy)));
    const inner = get("inner") * far;
    for (let index = 0; index < count; index += 1) {
      // Evenly spread, each nudged inside its own slice, so no side is bare.
      const turn = (index + 0.15 + 0.7 * random(index, 1)) / count * 2 * Math.PI;
      const near = inner + (far - inner) * 0.6 * variation * random(index, 2);
      const outer = far * 1.05;
      const ux = Math.cos(turn), uy = Math.sin(turn);
      const base = thick * (1 - 0.75 * variation * random(index, 3));
      // A wedge: its base past the edge, its point at `near` (taper 0 keeps a strip).
      const ax = fx + ux * outer, ay = fy + uy * outer, bx = fx + ux * near, by = fy + uy * near;
      const half = base / 2, tip = half * (1 - taper);
      paths.push(`M${fmt(ax - uy * half)} ${fmt(ay + ux * half)}L${fmt(bx - uy * tip)} ${fmt(by + ux * tip)}L${fmt(bx + uy * tip)} ${fmt(by - ux * tip)}L${fmt(ax + uy * half)} ${fmt(ay - ux * half)}Z`);
    }
  }
  return paths;
}

function renderLines(key, frame) {
  const opacity = read(frame, key, "opacity");
  if (opacity === 0) return frame.content;
  const paths = linePaths(key, frame);
  if (!paths.length) return frame.content;
  const blend = read(frame, key, "blend");
  const style = blend === "normal" ? "" : ` style="mix-blend-mode:${blend}"`;
  const fade = key === "speed-lines" ? read(frame, key, "fade") : 0;
  let shapes = `<path d="${paths.join("")}"/>`;
  if (fade > 0) {
    // One gradient along the travel direction in each line's own box: its tail end clear by `fade`.
    const turn = read(frame, key, "angle") * Math.PI / 180, dx = Math.cos(turn) / 2, dy = Math.sin(turn) / 2;
    const id = frame.helpers.id("line-fade");
    frame.helpers.defs.push(`<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${fmt(0.5 - dx)}" y1="${fmt(0.5 - dy)}" x2="${fmt(0.5 + dx)}" y2="${fmt(0.5 + dy)}"><stop offset="0" stop-color="${read(frame, key, "color")}" stop-opacity="${fmt(1 - fade)}"/><stop offset="1" stop-color="${read(frame, key, "color")}"/></linearGradient>`);
    shapes = paths.map((d) => `<path d="${d}" fill="url(#${id})"/>`).join("");
  }
  const lines = `<g aria-hidden="true" pointer-events="none" fill="${read(frame, key, "color")}" opacity="${fmt(opacity)}"${style}>${shapes}</g>`;
  return clipEffect(frame, `<g style="isolation:isolate">${frame.content}${lines}</g>`);
}

// ---- film burn ---------------------------------------------------------------------------------

function valueNoise(seedValue, px, py) {
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const at = (ix, iy) => unit(seedValue, ix, iy);
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

// Four octaves, each twice as fine and half as strong: 0..1.
function fractal(seedValue, px, py) {
  let sum = 0, weight = 0.5, total = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    const scale = 2 ** octave;
    sum += valueNoise(seedValue + octave * 7919, px * scale, py * scale) * weight;
    total += weight;
    weight /= 2;
  }
  return sum / total;
}

// How near a point (u, v from 0 to 1 across the layer) is to the burning edge: 1 at it, 0 far.
function edgeNearness(edge, u, v) {
  if (edge === "left") return 1 - u;
  if (edge === "right") return u;
  if (edge === "top") return 1 - v;
  if (edge === "bottom") return v;
  if (edge === "corner") return 1 - Math.hypot(u, v) / Math.SQRT2;
  return Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
}

const rgb = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
const lerp = (a, b, t) => a.map((value, index) => value + (b[index] - value) * t);

/** How hot the burn is (0 none, 1 white hot) at u, v for a frame: plain numbers, for tests. */
export function burnHeat(frame, u, v) {
  const get = (name) => read(frame, "film-burn", name);
  const step = Math.floor(Math.max(0, frame.time ?? 0) * get("rate") + 1e-6) / get("rate");
  const drift = step * get("speed");
  const scale = 2.5 * get("scale");
  const noise = fractal(get("seed"), u * scale + drift * 0.7, v * scale - drift * 0.45);
  const reach = get("reach");
  const toward = reach > 0 ? clamp(1 - (1 - edgeNearness(get("edge"), u, v)) / reach, 0, 1) : 0;
  return smoothstep(clamp((toward * 1.15 + (noise - 0.5) * 1.4 - 0.35) / 0.65, 0, 1));
}

function renderFilmBurn(frame) {
  const amount = read(frame, "film-burn", "amount");
  if (amount === 0 || read(frame, "film-burn", "reach") === 0) return frame.content;
  const { x, y, width, height } = frame.bounds;
  if (!(width > 0) || !(height > 0)) return frame.content;
  const ramp = [[0, 0, 0], rgb(read(frame, "film-burn", "deep")), rgb(read(frame, "film-burn", "mid")), rgb(read(frame, "film-burn", "hot")), [255, 255, 255]];
  const step = Math.floor(Math.max(0, frame.time ?? 0) * read(frame, "film-burn", "rate") + 1e-6);
  const key = JSON.stringify(["film-burn-v1", step, ...["edge", "reach", "scale", "speed", "rate", "deep", "mid", "hot", "seed"].map((name) => read(frame, "film-burn", name))]);
  const map = effectMapImage(frame, key, (px, py, mapWidth, mapHeight) => {
    const heat = burnHeat(frame, (px + 0.5) / mapWidth, (py + 0.5) / mapHeight);
    const position = heat * 0.7 * (ramp.length - 1), index = Math.min(ramp.length - 2, Math.floor(position));
    const [r, g, b] = lerp(ramp[index], ramp[index + 1], position - index).map(Math.round);
    return [r, g, b, Math.round(clamp(heat * 1.6, 0, 1) * 255)];
  }, { maxSide: 160 });
  const blend = read(frame, "film-burn", "blend");
  const join = blend === "add"
    ? '<feComposite in="burnLight" in2="SourceGraphic" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="burnJoined"/>'
    : blend === "normal" ? '<feComposite in="burnLight" in2="SourceGraphic" operator="over" result="burnJoined"/>'
      : `<feBlend in="burnLight" in2="SourceGraphic" mode="${blend}" result="burnJoined"/>`;
  return filterEffect(frame, [
    `<feImage href="${map}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none" result="burnMap"/>`,
    `<feColorMatrix in="burnMap" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${fmt(amount)} 0" result="burnLight"/>`,
    join,
    '<feComposite in="burnJoined" in2="SourceGraphic" operator="in"/>',
  ]);
}

// ---- invert ------------------------------------------------------------------------------------

function renderInvert(frame) {
  const amount = read(frame, "invert", "amount");
  if (amount === 0) return frame.content;
  const slope = fmt(1 - 2 * amount), intercept = fmt(amount);
  const channel = (name) => `<feFunc${name} type="linear" slope="${slope}" intercept="${intercept}"/>`;
  return filterEffect(frame, [
    `<feComponentTransfer in="SourceGraphic" result="inverted">${channel("R")}${channel("G")}${channel("B")}</feComponentTransfer>`,
    ...(read(frame, "invert", "keepHue") ? ['<feColorMatrix in="inverted" type="hueRotate" values="180"/>'] : []),
  ]);
}
