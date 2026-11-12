// The color-look effect: eight ready-made looks, each a few numbers (tone curve, split tint,
// saturation), drawn as a generated LUT (colorGrading.js renderFunctionLut). amount 0 is the layer
// as it was. The numbers are kino's own.
import { renderFunctionLut } from "./colorGrading.js";
import { numberParameter } from "./periodicDisplacement.js";
import { LUMA } from "./colorMath.js";
import { smoothstep } from "../numbers.js";
import { renderGlow } from "./glow.js";
import { hexRgb01, keepFields, keepOf, levelsFor, normalizeLuma, withKeep } from "./relight.js";

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
// section-grade is not a fixed table: it is built from its own fields (sectionGradeColor below).
export const COLOR_LOOK_NAMES = Object.freeze([...Object.keys(COLOR_LOOKS), "section-grade"]);

// section-grade: a one-hue grade that relights instead of tints, plus a soft bloom and a small
// black lift, in one effect. Defaults: bloom 0.3 and blackLift 0.04 from the treatments table of
// .scratch/studies/synthesis.md; hue 160 is the teal-green the streak-field reference measured
// (#0E3A30 shadows, #2A6B5A mids); keep skin from relight.js.
export const SECTION_GRADE = Object.freeze({ hue: 160, keep: "skin", keepAmount: 0.6, bloom: 0.3, blackLift: 0.04 });

function hsl(hue, saturation, lightness) {
  const k = (n) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  return [0, 8, 4].map((n) => lightness - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
}

// The three stops of the ramp for one hue (HSL degrees: red 0, green 120, blue 240). Shadow and
// mid lightness and saturation from the streak-field reference (#0E3A30 is about L 0.14, #2A6B5A
// about S 0.44 L 0.29; shadow taken deeper so the grade keeps a black). Highlights turn up to 30
// degrees toward yellow: the reference face highlight #D8F59A (hue 79, S 0.81, L 0.78) sits
// under a hue 165 backdrop (the 30 degree turn is a guess from two references). The light stop
// takes that highlight's S 0.8 and L 0.78, not white: at L 0.86 plus the bloom the lit brow of
// the streak-field re-run clipped to #FFFFFF where the reference stays #D8F59A.
export function sectionGradeStops(hue) {
  const h = ((hue % 360) + 360) % 360;
  const toward = ((60 - h + 540) % 360) - 180;
  const lightHue = h + Math.sign(toward) * Math.min(30, Math.abs(toward));
  // Mid S 0.4 rather than the backdrop's 0.44: the reference face mids are paler (#B3CB90, S 0.35).
  return [hsl(h, 0.65, 0.05), hsl(h, 0.4, 0.3), hsl(lightHue, 0.8, 0.78)];
}

/** The section-grade pixel function: r, g, b 0..1 and {stops, levels, keep, blackLift}. */
export function sectionGradeColor(r, g, b, { stops, levels, keep, blackLift }) {
  const source = [r, g, b];
  const normalized = normalizeLuma(luma(source), levels);
  // Two linear segments meeting at the mid stop, at normalized luma 0.4 (guess tuned on the
  // streak-field re-run: at 0.45 the lower face read #538B40 against the reference's #B3CB90, so
  // more of the range goes to the lighter segment).
  const [low, mid, high] = stops;
  const graded = normalized < 0.4
    ? low.map((value, channel) => value + (mid[channel] - value) * (normalized / 0.4))
    : mid.map((value, channel) => value + (high[channel] - value) * ((normalized - 0.4) / 0.6));
  const kept = withKeep(source, graded, keep, normalized);
  return kept.map((value) => blackLift + (1 - blackLift) * value);
}

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

/**
 * The effect's settings: look (one of the nine) and amount. The section-grade fields are optional
 * (stored only when given), so the eight table looks and older documents stay as they were.
 */
export function colorLookFields(number, color, boolean) {
  const optional = (field) => ({ ...field, optional: true });
  const fields = {
    look: { type: "enum", label: "Look", default: COLOR_LOOK_NAMES[0], options: COLOR_LOOK_NAMES.map((name) => [name, name[0].toUpperCase() + name.slice(1).replace("-", " ")]) },
    amount: number("Amount", 1, 0, 1, 0.01, "", { neutral: 0 }),
  };
  if (!color || !boolean) return fields;
  return { ...fields,
    hue: number("Hue", SECTION_GRADE.hue, 0, 360, 1, "°", { optional: true }),
    ...Object.fromEntries(Object.entries(keepFields(number, color, { keep: SECTION_GRADE.keep })).map(([key, field]) => [key, optional(field)])),
    bloom: number("Bloom", SECTION_GRADE.bloom, 0, 1, 0.01, "", { optional: true }),
    blackLift: number("Black Lift", SECTION_GRADE.blackLift, 0, 0.2, 0.005, "", { optional: true }),
    normalize: optional(boolean("Normalize", true)),
  };
}

function renderSectionGrade(frame, amount) {
  const parameters = frame.parameters ?? {};
  const hue = numberParameter(frame, "hue", SECTION_GRADE.hue, 0, 360);
  const stops = sectionGradeStops(hue);
  const keep = keepOf({ keep: SECTION_GRADE.keep, keepAmount: SECTION_GRADE.keepAmount, ...parameters }, hexRgb01);
  const graded = renderFunctionLut(frame, { name: "section-grade", color: sectionGradeColor, size: 33, strength: amount,
    parameters: { stops, levels: levelsFor(frame), keep, blackLift: numberParameter(frame, "blackLift", SECTION_GRADE.blackLift, 0, 0.2) } });
  const bloom = numberParameter(frame, "bloom", SECTION_GRADE.bloom, 0, 1) * amount;
  if (bloom === 0) return graded;
  // The soft bloom: a wide, low glow from the top highlights only, in the light stop's color.
  // Guesses tuned on the streak-field re-run: strength 2 x bloom from threshold 0.55 added up to
  // white over the whole lit brow, so strength equals bloom (0.3 at the default) and only luma
  // above about 0.7 feeds it; radius 24 keeps it a haze rather than a second outline.
  const light = `#${stops[2].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
  return renderGlow({ ...frame, content: graded,
    parameters: { strength: bloom, radius: 24, passes: 2, threshold: 0.7, softness: 0.25, color: light, colorMix: 0.5 } });
}

export function renderColorLook(frame) {
  const amount = numberParameter(frame, "amount", 1, 0, 1);
  if (amount === 0) return frame.content;
  if (frame.parameters?.look === "section-grade") return renderSectionGrade(frame, amount);
  const name = Object.hasOwn(COLOR_LOOKS, frame.parameters?.look) ? frame.parameters.look : COLOR_LOOK_NAMES[0];
  // 33 points: tints clip at 0 and 1, and a kink draws closer on the finer grid.
  return renderFunctionLut(frame, { name: "color-look", color: colorLookColor, parameters: COLOR_LOOKS[name], size: 33, strength: amount });
}
