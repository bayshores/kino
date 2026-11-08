// The color-look effect: eight ready-made looks, each a few numbers (tone curve, split tint,
// saturation), drawn as a generated LUT (colorGrading.js renderFunctionLut). amount 0 is the layer
// as it was. The numbers are kino's own.
import { renderFunctionLut } from "./colorGrading.js";
import { numberParameter } from "./periodicDisplacement.js";
import { LUMA } from "./colorMath.js";
import { smoothstep } from "../numbers.js";

// saturation: chroma scale around luma. gamma: x^gamma (below 1 brightens the mids). contrast:
// -1..1 toward a flatter (below 0) or steeper (above 0) S curve around the middle. black, white:
// where 0 and 1 land. shadows, highlights: [hue in degrees, strength] tints toward that hue, with
// the brightness kept, in the dark or the bright tones.
export const COLOR_LOOKS = Object.freeze(Object.fromEntries(Object.entries({
  // Flat and soft: lifted blacks, dimmed whites, a little cool in the dark, a little warm in the light.
  matte: { saturation: 0.78, gamma: 0.95, contrast: -0.45, black: 0.09, white: 0.92, shadows: [205, 0.05], highlights: [40, 0.04] },
  // Hot and dense: red shadows, amber highlights, more color and contrast.
  ember: { saturation: 1.15, gamma: 1.12, contrast: 0.35, black: 0.01, white: 1, shadows: [8, 0.16], highlights: [38, 0.14] },
  // Bright and cold: cyan-blue in both ends, less color.
  frost: { saturation: 0.62, gamma: 0.82, contrast: 0.05, black: 0.05, white: 1, shadows: [215, 0.16], highlights: [190, 0.1] },
  // Nearly black and white with deep, slightly blue blacks.
  ink: { saturation: 0.08, gamma: 1.12, contrast: 0.6, black: 0, white: 0.97, shadows: [225, 0.06], highlights: [45, 0.02] },
  // Violet shadows under peach highlights.
  dusk: { saturation: 0.95, gamma: 1, contrast: 0.2, black: 0.04, white: 0.98, shadows: [280, 0.16], highlights: [22, 0.1] },
  // Green-leaning shadows, yellow light, soft contrast.
  meadow: { saturation: 1.05, gamma: 0.92, contrast: -0.05, black: 0.03, white: 0.98, shadows: [135, 0.15], highlights: [58, 0.12] },
  // Teal shadows, cream highlights, muted color.
  harbor: { saturation: 0.72, gamma: 1, contrast: 0.25, black: 0.03, white: 0.97, shadows: [182, 0.16], highlights: [35, 0.07] },
  // Clean and loud: no tint, much more color and contrast.
  punch: { saturation: 1.45, gamma: 0.94, contrast: 0.55, black: 0, white: 1, shadows: [0, 0], highlights: [0, 0] },
}).map(([name, look]) => [name, Object.freeze(look)])));
export const COLOR_LOOK_NAMES = Object.freeze(Object.keys(COLOR_LOOKS));

const luma = ([r, g, b]) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
const clamp01 = (value) => Math.min(1, Math.max(0, value));

// A pure hue's color minus its own luma, times strength: adds hue and keeps brightness.
function tint([hue, strength]) {
  if (!strength) return [0, 0, 0];
  const at = (n) => { const k = (n + hue / 60) % 6; return 1 - Math.max(0, Math.min(k, 4 - k, 1)); };
  const rgb = [at(5), at(3), at(1)];
  const y = luma(rgb);
  return rgb.map((c) => (c - y) * strength);
}

function tone(x, { gamma, contrast, black, white }) {
  const curved = x ** gamma;
  const s = curved * curved * (3 - 2 * curved);
  return black + (white - black) * (curved + contrast * (s - curved));
}

/** The pixel function: r, g, b 0..1 and one COLOR_LOOKS entry. */
export function colorLookColor(r, g, b, look) {
  let rgb = [r, g, b];
  const y0 = luma(rgb);
  if (look.saturation !== 1) {
    // Above 1, chroma grows only as far as 0..1 allows, so bright colors do not clip flat.
    const room = Math.min(...rgb.map((c) => c > y0 ? (1 - y0) / (c - y0) : c < y0 ? y0 / (y0 - c) : Infinity));
    const factor = look.saturation < 1 ? look.saturation : 1 + (look.saturation - 1) * Math.min(1, room - 1);
    rgb = rgb.map((c) => y0 + (c - y0) * factor);
  }
  rgb = rgb.map((c) => tone(clamp01(c), look));
  const y = luma(rgb);
  const low = 1 - smoothstep(y / 0.6);
  const high = smoothstep((y - 0.4) / 0.6);
  const [shadow, highlight] = [tint(look.shadows), tint(look.highlights)];
  return rgb.map((c, channel) => clamp01(c + low * shadow[channel] + high * highlight[channel]));
}

/** The effect's settings: look (one of the eight) and amount. */
export function colorLookFields(number) {
  return {
    look: { type: "enum", label: "Look", default: COLOR_LOOK_NAMES[0], options: COLOR_LOOK_NAMES.map((name) => [name, name[0].toUpperCase() + name.slice(1)]) },
    amount: number("Amount", 1, 0, 1, 0.01, "", { neutral: 0 }),
  };
}

export function renderColorLook(frame) {
  const amount = numberParameter(frame, "amount", 1, 0, 1);
  const name = Object.hasOwn(COLOR_LOOKS, frame.parameters?.look) ? frame.parameters.look : COLOR_LOOK_NAMES[0];
  if (amount === 0) return frame.content;
  // 33 points: tints clip at 0 and 1, and a kink draws closer on the finer grid.
  return renderFunctionLut(frame, { name: "color-look", color: colorLookColor, parameters: COLOR_LOOKS[name], size: 33, strength: amount });
}
