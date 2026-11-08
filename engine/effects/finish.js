// Film finishes laid over a layer's own pixels, each one small SVG filter:
// - grain: a noise tile kino draws once per seed and mode (kept in the map cache), repeated over
//   the layer and blended with hard light: lighter grains brighten (screen), darker ones darken
//   (multiply) and 50% gray changes nothing, so grain shows on dark and light pictures alike.
//   Animated, each step (rate steps a second) shows another of the tiles at another offset, so
//   playback only swaps the tile and its place; nothing new is drawn per frame.
// - vignette: a smooth map of how dark each point is (clear in the middle, `color` toward the
//   corners) put over the layer's pixels (atop), so nothing outside the layer is painted.
// Exports draw effects with Chromium (backend/raster-policy.mjs); resvg draws the same filter
// but repeats the grain tile without the layer's rotation.
import { effectMapImage } from "./mapImage.js";
import { cachedMap } from "./maps.js";
import { filterEffect } from "./svg.js";
import { clamp, smoothstep } from "../numbers.js";

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const boolean = (label, value) => ({ type: "boolean", label, default: value });
const color = (label, value) => ({ type: "color", label, default: value });

export const GRAIN_TILE = 256; // grains along each side of one tile
export const GRAIN_VARIANTS = 8; // tiles an animated grain steps through

export const FINISH_EFFECTS = [
  { key: "grain", label: "Grain", group: "Post FX", kind: "ranged", render: renderGrain,
    parameters: {
      amount: number("Amount", 0.35, 0, 1, 0.01),
      // Scene pixels per grain: 1 is fine 4K-like grain, 2 to 3 reads as 16 mm film.
      size: number("Size", 1.5, 0.5, 8, 0.1, "px"),
      seed: number("Seed", 0, 0, 1_000_000, 1, "", { integer: true, animatable: false }),
      monochrome: boolean("Monochrome", true),
      animated: boolean("Animated", true),
      // New grain this many times a second (30: every frame of a 30 fps export).
      rate: number("Rate", 30, 1, 60, 1, "changes/s", { integer: true, animatable: false }),
    } },
  { key: "vignette", label: "Vignette", group: "Post FX", kind: "ranged", render: renderVignette,
    parameters: {
      amount: number("Amount", 0.5, 0, 1, 0.01),
      // Where the edge is half dark, from the middle (0) to the corners (1).
      midpoint: number("Midpoint", 0.6, 0, 1, 0.01),
      // 0 follows the layer's shape (an oval on a wide layer), 1 is a circle, -1 a rounded rectangle.
      roundness: number("Roundness", 0, -1, 1, 0.01),
      // How wide the fade from clear to dark is (0 is a hard edge).
      feather: number("Feather", 0.6, 0, 1, 0.01),
      color: color("Color", "#000000"),
    } },
];

const FIELDS = new Map(FINISH_EFFECTS.map((effect) => [effect.key, effect.parameters]));

function read(frame, effectKey, key) {
  const field = FIELDS.get(effectKey)[key];
  const value = frame?.parameters?.[key];
  if (field.type === "boolean") return typeof value === "boolean" ? value : field.default;
  if (field.type === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : field.default;
  const number = clamp(Number.isFinite(value) ? value : field.default, field.min, field.max);
  return field.integer ? Math.round(number) : number;
}

const fmt = (value) => {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

// A whole-number hash of a few whole numbers, spread over 0..2^32-1.
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

// One grain value 0..1 around 0.5: four even randoms added, which bunches them near the middle
// like real grain instead of spreading them evenly.
function grainValue(seed, variant, x, y, channel) {
  let sum = 0;
  for (let draw = 0; draw < 4; draw += 1) sum += unit(seed, variant, x, y, channel * 4 + draw);
  return clamp(0.5 + (sum - 2) * 0.25, 0, 1);
}

/** The data URI of one grain tile: GRAIN_TILE square, gray or with each channel its own. */
export function grainTile(seed, variant, monochrome) {
  return cachedMap(JSON.stringify(["finish-grain-v1", seed, variant, monochrome]), GRAIN_TILE, GRAIN_TILE, (x, y) => {
    const red = Math.round(grainValue(seed, variant, x, y, 0) * 255);
    if (monochrome) return [red, red, red, 255];
    return [red, Math.round(grainValue(seed, variant, x, y, 1) * 255), Math.round(grainValue(seed, variant, x, y, 2) * 255), 255];
  });
}

// How many scene pixels one layer unit covers (the layer's scale on screen, not the output size).
function sceneScale(frame) {
  const [a, b, c, d] = Array.isArray(frame.helpers?.scene?.matrix) ? frame.helpers.scene.matrix : [1, 0, 0, 1];
  const scale = Math.max(Math.hypot(a, b), Math.hypot(c, d));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * The grain step at a time, which tile it shows and where the tile starts (layer units, inside
 * the filter region so the tile is never cut). Still grain is step 0 at every time.
 */
export function grainPlacement(frame) {
  const seed = read(frame, "grain", "seed");
  const rate = read(frame, "grain", "rate");
  const time = Number.isFinite(frame.time) ? Math.max(0, frame.time) : 0;
  const step = read(frame, "grain", "animated") ? Math.floor(time * rate + 1e-6) : 0;
  // 3 has no factor in common with 8, so the next step always shows another tile.
  const variant = (hash(seed) + step * 3) % GRAIN_VARIANTS;
  const side = GRAIN_TILE * read(frame, "grain", "size") / sceneScale(frame);
  const region = frame.paintBounds ?? frame.bounds;
  const offset = (room, salt) => room > 0 ? unit(seed, step, salt) * Math.min(side, room) : 0;
  return { step, variant, side,
    x: region.x + offset(region.width - side, 1), y: region.y + offset(region.height - side, 2) };
}

export function renderGrain(frame) {
  const amount = read(frame, "grain", "amount");
  if (amount === 0) return frame.content;
  const { variant, side, x, y } = grainPlacement(frame);
  const tile = grainTile(read(frame, "grain", "seed"), variant, read(frame, "grain", "monochrome"));
  const slope = fmt(amount), intercept = fmt(0.5 - 0.5 * amount);
  return filterEffect(frame, [
    // The layer's colors, opaque (unpremultiplied), so its soft edges keep their color.
    '<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1" result="grainOpaque"/>',
    `<feImage href="${tile}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(side)}" height="${fmt(side)}" preserveAspectRatio="none" result="grainTile"/>`,
    '<feTile in="grainTile" result="grainField"/>',
    // Amount pulls the grain toward 50% gray, which hard light leaves unchanged.
    `<feComponentTransfer in="grainField" result="grainScaled"><feFuncR type="linear" slope="${slope}" intercept="${intercept}"/><feFuncG type="linear" slope="${slope}" intercept="${intercept}"/><feFuncB type="linear" slope="${slope}" intercept="${intercept}"/></feComponentTransfer>`,
    '<feBlend in="grainScaled" in2="grainOpaque" mode="hard-light" result="grainBlend"/>',
    // Back to the layer's own shape and see-through parts.
    '<feComposite in="grainBlend" in2="SourceGraphic" operator="in"/>',
  ]);
}

/**
 * How dark the vignette is (0 clear, 1 full) at a point of the layer, u and v from -1 to 1
 * across it. Distances are measured so the corners are at 1.
 */
export function vignetteShade(u, v, { width, height, midpoint, roundness, feather }) {
  const longer = Math.max(width, height);
  // Roundness above 0 squeezes the long side toward a circle; below 0 a superellipse (power up to 8).
  const toward = Math.max(0, roundness);
  const sx = 1 + (width / longer - 1) * toward, sy = 1 + (height / longer - 1) * toward;
  const power = 2 + 6 * Math.max(0, -roundness);
  const distance = (x, y) => (Math.abs(x) ** power + Math.abs(y) ** power) ** (1 / power);
  const d = distance(u * sx, v * sy) / distance(sx, sy);
  if (feather <= 0) return d >= midpoint ? 1 : 0;
  return smoothstep(clamp((d - (midpoint - feather / 2)) / feather, 0, 1));
}

// The map's red is the shade; this matrix moves it into alpha, times amount.
const shadeToAlpha = (amount) => `0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${fmt(amount)} 0 0 0 0`;

export function renderVignette(frame) {
  const amount = read(frame, "vignette", "amount");
  if (amount === 0) return frame.content;
  const { x, y, width, height } = frame.bounds;
  if (!(width > 0) || !(height > 0)) return frame.content;
  const shape = { width, height, midpoint: read(frame, "vignette", "midpoint"),
    roundness: read(frame, "vignette", "roundness"), feather: read(frame, "vignette", "feather") };
  const map = effectMapImage(frame, JSON.stringify(["finish-vignette-v1", shape]), (px, py, mapWidth, mapHeight) => {
    const byte = Math.round(vignetteShade((px + 0.5) / mapWidth * 2 - 1, (py + 0.5) / mapHeight * 2 - 1, shape) * 255);
    return [byte, byte, byte, 255];
  }, { outside: [0, 0, 0, 255] });
  return filterEffect(frame, [
    `<feImage href="${map}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none" result="vignetteMap"/>`,
    `<feColorMatrix in="vignetteMap" type="matrix" values="${shadeToAlpha(amount)}" result="vignetteAlpha"/>`,
    `<feFlood flood-color="${read(frame, "vignette", "color")}" result="vignetteColor"/>`,
    '<feComposite in="vignetteColor" in2="vignetteAlpha" operator="in" result="vignetteShade"/>',
    '<feComposite in="vignetteShade" in2="SourceGraphic" operator="atop"/>',
  ]);
}
