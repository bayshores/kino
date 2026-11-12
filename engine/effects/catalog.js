// The one source of effect names, controls, validation limits and renderers. The controls and
// defaults follow common motion-tool conventions; the bounded ranges and SVG algorithms are our own.
import { renderBulge } from "./bulge.js";
import { renderDisplacement } from "./displacement.js";
import { renderFluidWarp } from "./fluidWarp.js";
import { renderFlutedGlass } from "./flutedGlass.js";
import { renderNoiseWarp } from "./noiseWarp.js";
import { renderRipple } from "./ripple.js";
import { renderDithering, renderDotGrid, renderDuotone, renderLumaHighlight, renderNoiseMask,
  renderPixelate, renderThresholdColor, renderTritone, renderRgbShift } from "./postFx.js";
import { renderOrbit, renderCardFlip } from "./projection.js";
import { renderColorGrade, renderColorRemover } from "./colorUtility.js";
import { renderColorWheels, renderCurves, renderHueSaturation, renderKeepColor, renderLut, renderWhiteBalance } from "./colorGrading.js";
import { colorRangesFields, renderColorRanges } from "./colorRanges.js";
import { colorLookFields, renderColorLook } from "./colorLook.js";
import { keepFields } from "./relight.js";
import { IDENTITY_CURVE, MAX_CURVE_POINTS, normalizeCurve } from "./colorMath.js";
import { UTILITY_COPY_EFFECTS } from "./utilityCopies.js";
import { BLUR_EFFECTS } from "./motionBlurs.js";
import { FOCUS_BAND_EFFECT } from "./focusBand.js";
import { EDGE_LINES_BACKGROUNDS, renderEdgeLines } from "./edgeLines.js";
import { EDGE_EFFECTS } from "./edges.js";
import { LIGHT_EFFECTS } from "./light.js";
import { PARTICLE_EFFECTS } from "./particles.js";
import { FINISH_EFFECTS } from "./finish.js";
import { OVERLAY_EFFECTS } from "./overlays.js";
import { FIELD_EFFECT } from "./field.js";
import { MOSAIC_EFFECT } from "./mosaic.js";
import { copyContent } from "./svg.js";
import { compileExpression, ExpressionError } from "../expression.js";

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const boolean = (label, value) => ({ type: "boolean", label, default: value });
// `created`: an optional field that createEffectAnimation stores with its default on every new
// effect, so new effects get it while documents saved before the field existed keep drawing the
// same (their effect has no value, and parametersAt leaves an absent optional field out).
const NORMALIZE_NEW = Object.freeze({ ...boolean("Normalize", true), optional: true, created: true });
// A noise seed: another whole number gives another pattern. It holds for the whole effect and,
// like mix, is stored only when given (its default is the pattern from before it existed).
const seed = (value) => number("Seed", value, 0, 1_000_000, 1, "", { integer: true, animatable: false, optional: true });
// How much of the effect shows over the layer as it was: 0 none, 1 all (every effect has it).
// Optional: stored and sampled only when given, so effects saved before it stay the same.
const MIX = Object.freeze(number("Mix", 1, 0, 1, 0.01, "", { optional: true }));
const color = (label, value) => ({ type: "color", label, default: value });
// A tone curve: 2 to 16 points [input, output] from 0 to 1 (colorMath.js normalizeCurve).
const curve = (label) => ({ type: "curve", label, default: IDENTITY_CURVE });
// An imported .cube file, by its src (/api/media/<id>.cube). It has no default: it must be given.
const lut = (label) => ({ type: "lut", label, default: null, required: true });
// The src of an imported .cube file. Shared addresses (?share=) are not stored in documents.
const LUT_SOURCE = /^\/api\/media\/[a-f0-9-]{1,128}\.cube$/;

export const EFFECT_GROUPS = Object.freeze(["Distortion", "Post FX", "Utility", "Color", "Blur", "Light", "Generate"]);
export const KEEP_STILL = Object.freeze([
  ["off", "Off"], ["start", "At start"], ["end", "At end"], ["both", "Both"],
]);

const definitions = [
  { key: "bulge", label: "Bulge", group: "Distortion", kind: "value", render: renderBulge,
    parameters: { amount: number("Bulge Amount", 1, -2, 2, 0.05, "", { neutral: 0 }) } },
  { key: "displacement", label: "Displacement", group: "Distortion", kind: "value", render: renderDisplacement,
    parameters: {
      amplitude: number("Amplitude", 10, -128, 128, 1, "px", { neutral: 0 }),
      offset: number("Offset", 1, -1000, 1000, 0.05, "cycles"),
      repeat: number("Repeat", 1, 0.25, 32, 0.1),
      direction: { type: "enum", label: "Direction", default: "horizontal",
        options: [["horizontal", "Horizontal"], ["vertical", "Vertical"], ["both", "Both"]] },
    } },
  { key: "fluid-warp", label: "Fluid Warp", group: "Distortion", kind: "ranged", render: renderFluidWarp,
    parameters: {
      amount: number("Amount", 10, 0, 128, 1, "px"),
      noiseScale: number("Noise Scale", 1, 0.1, 16, 0.05),
      octaves: number("Octaves", 2, 1, 8, 1, "", { integer: true }),
      speed: number("Speed", 1, -4, 4, 0.05, "cycles/s"), contain: boolean("Contain", false),
      seed: seed(0),
    } },
  { key: "fluted-glass", label: "Fluted Glass", group: "Distortion", kind: "ranged", render: renderFlutedGlass,
    parameters: {
      columns: number("Columns", 12, 1, 128, 1, "", { integer: true }),
      strength: number("Strength", 0.45, 0, 1, 0.01),
      glowStrength: number("Glow Strength", 0.01, 0, 1, 0.01),
      glowWidth: number("Glow Width", 0.4, 0.01, 2, 0.01),
    } },
  { key: "noise-warp", label: "Noise Warp", group: "Distortion", kind: "ranged", render: renderNoiseWarp,
    parameters: {
      amount: number("Amount", 26, 0, 128, 1, "px"),
      noiseScale: number("Noise Scale", 1, 0.1, 16, 0.05),
      speed: number("Speed", 1, -4, 4, 0.05, "cycles/s"), contain: boolean("Contain", true),
      seed: seed(0),
    } },
  { key: "ripple", label: "Ripple", group: "Distortion", kind: "ranged", render: renderRipple,
    parameters: {
      speed: number("Speed", 0.6, -4, 4, 0.05, "cycles/s"),
      strength: number("Strength", 0.03, 0, 0.5, 0.01),
      frequency: number("Frequency", 6, 0.1, 32, 0.1),
      centerX: number("Center X", 0.5, 0, 1, 0.01), centerY: number("Center Y", 0.5, 0, 1, 0.01),
      falloff: number("Falloff", 1.2, 0, 8, 0.1), sharpness: number("Sharpness", 1, 1, 16, 0.1),
    } },
  { key: "dithering", label: "Dithering", group: "Post FX", kind: "ranged", render: renderDithering,
    parameters: {
      darkColor: color("Dark Color", "#000000"), lightColor: color("Light Color", "#FFFFFF"),
      subdivisions: number("Subdivisions", 200, 1, 2048, 1, "", { integer: true }),
      contrast: number("Contrast", 1.2, 0, 4, 0.05),
    } },
  { key: "dot-grid", label: "Dot Grid", group: "Post FX", kind: "ranged", render: renderDotGrid,
    parameters: {
      gridRepetition: number("Grid Repetition", 40, 1, 512, 1, "", { integer: true }),
      dotScale: number("Dot Scale", 7, 0, 8, 0.1), contrast: number("Contrast", 1.1, 0, 4, 0.05),
      shadowColor: color("Shadow Color", "#2A2A30"), highlightColor: color("Highlight Color", "#F5EFE4"),
      invertDetection: boolean("Invert Detection", false),
    } },
  { key: "duotone", label: "Duotone", group: "Post FX", kind: "ranged", render: renderDuotone,
    parameters: {
      midpoint: number("Midpoint", 0.5, 0, 1, 0.01), contrast: number("Contrast", 0.9, 0, 4, 0.05),
      shadowColor: color("Shadow Color", "#1400FF"), highlightColor: color("Highlight Color", "#FFE4E4"),
      // Stretch the layer's own 2nd..98th percentile luma to 0..1 first; keep: a hue range that
      // stays partly in its own color (relight.js says where both come from). NORMALIZE_NEW is
      // stored on every new duotone; one saved before it existed has none and draws as it did.
      normalize: NORMALIZE_NEW, ...keepFields(number, color),
    } },
  { key: "luma-highlight", label: "Luma Highlight", group: "Post FX", kind: "ranged", render: renderLumaHighlight,
    parameters: {
      lumaThreshold: number("Luma Threshold", 0.25, 0, 1, 0.01, "", { initial: 0 }),
      fuzzWidth: number("Fuzz Width", 0.2, 0, 1, 0.01, "", { initial: 0.2 }),
      fuzzIntensity: number("Fuzz Intensity", 0.5, 0, 1, 0.01, "", { initial: 0.5 }),
      // The color the selected tones turn (white before this field existed).
      color: color("Color", "#FFFFFF"),
    } },
  { key: "noise-mask", label: "Noise Mask", group: "Post FX", kind: "ranged", render: renderNoiseMask,
    parameters: {
      threshold: number("Threshold", 0, 0, 1, 0.01, "", { initial: 1 }),
      scale: number("Scale", 0.55, 0.01, 16, 0.01),
      seed: number("Seed", 0, -2147483648, 2147483647, 1, "", { integer: true }),
      octaves: number("Octaves", 4, 1, 8, 1, "", { integer: true }),
      edgeSoftness: number("Edge Softness", 0.06, 0, 1, 0.01),
      // 0 keeps Scale's cells, which stretch with the layer. 1 or more makes square cells that
      // many pixels wide on any layer size (fine film grain is 1-2) and ignores Scale.
      cellSize: number("Cell Size", 0, 0, 64, 1, "px", { integer: true }),
    } },
  { key: "pixelate", label: "Pixelate", group: "Post FX", kind: "ranged", render: renderPixelate,
    parameters: {
      pixelSize: number("Pixel Size", 25, 1, 128, 1, "px", { initial: 1 }),
      pixelSizeStep: number("Pixel Size Step", 1, 1, 128, 1, "px"),
      noiseScale: number("Noise Scale", 1, 0.01, 16, 0.05),
      noiseThreshold: number("Noise Threshold", 0.5, 0, 1, 0.01),
      noiseEnabled: boolean("Noise", false),
      seed: seed(17),
    } },
  { key: "threshold-color", label: "Threshold Color", group: "Post FX", kind: "ranged", render: renderThresholdColor,
    parameters: {
      contrast: number("Contrast", 1.25, 0, 4, 0.05), defaultColor: color("Default Color", "#6F6645"),
      colorThreshold: number("Color Threshold", 0.5, 0, 1, 0.01), softness: number("Softness", 0, 0, 1, 0.01),
      invertLuma: boolean("Invert Luma", true),
    } },
  { key: "tritone", label: "Tritone", group: "Post FX", kind: "ranged", render: renderTritone,
    parameters: {
      threshold1: number("Threshold 1", 0.33, 0, 1, 0.01), threshold2: number("Threshold 2", 0.66, 0, 1, 0.01),
      softness: number("Softness", 0.35, 0, 1, 0.01), contrast: number("Contrast", 1, 0, 4, 0.05),
      shadowColor: color("Shadow Color", "#1A1033"), midtoneColor: color("Midtone Color", "#E94F64"),
      highlightColor: color("Highlight Color", "#FFE9B0"),
      normalize: NORMALIZE_NEW, ...keepFields(number, color),
    } },
  { key: "rgb-shift", label: "RGB Shift", group: "Post FX", kind: "ranged", render: renderRgbShift,
    parameters: {
      amount: number("Amount", 0.25, 0, 1, 0.01), direction: number("Direction", 0, -360, 360, 1, "°"),
      overflow: boolean("Overflow", false),
    } },
  // The layer's contours as thin lines (edgeLines.js says how, and where each default comes from).
  { key: "edge-lines", label: "Edge Lines", group: "Post FX", kind: "ranged", render: renderEdgeLines,
    parameters: {
      color: color("Color", "#FFFFFF"),
      width: number("Width", 3, 0.5, 12, 0.5, "px"),
      threshold: number("Threshold", 0.05, 0, 1, 0.01),
      // 1 lifts the dark end of the picture before the lines are found, so dark clips get lines
      // (edgeLines.js step 1b). Stored with 1 on a new effect only; effects saved before it have 0.
      adapt: number("Adapt", 1, 0, 1, 0.01, "", { optional: true, created: true }),
      background: { type: "enum", label: "Background", default: "keep", options: EDGE_LINES_BACKGROUNDS.map((value) => [value, value[0].toUpperCase() + value.slice(1)]) },
      smooth: number("Smooth", 1, 0, 8, 0.1, "px"),
      dim: number("Dim", 0.7, 0, 1, 0.01),
    } },
  // Film grain and vignette (finish.js).
  ...FINISH_EFFECTS,
  // Speed lines, impact lines, film burn and invert, drawn in code (overlays.js).
  ...OVERLAY_EFFECTS,
  { key: "3d-orbit", label: "3D Orbit", group: "Utility", kind: "ranged", render: renderOrbit,
    parameters: {
      rotateY: number("Rotate Y", 0, -3600, 3600, 1, "°", { initial: 360 }),
      rotateX: number("Rotate X", 0, -3600, 3600, 1, "°"), rotateZ: number("Rotate Z", 0, -3600, 3600, 1, "°"),
      pivotZ: number("Pivot Z", 5, 0, 8, 0.1), perspective: number("Perspective", 0.45, 0, 0.95, 0.01),
      cameraDistance: number("Camera Distance", 4.5, 0.5, 32, 0.1),
      showFront: boolean("Show Front", true), showBack: boolean("Show Back", true),
    } },
  { key: "card-flip", label: "Card Flip", group: "Utility", kind: "ranged", render: renderCardFlip,
    parameters: {
      rotationY: number("Rotation Y", 360, -3600, 3600, 1, "°", { initial: 0 }),
      rotationX: number("Rotation X", 0, -3600, 3600, 1, "°"), rotationZ: number("Rotation Z", 0, -3600, 3600, 1, "°"),
      pivotX: number("Pivot X", 0, -2, 2, 0.05), pivotY: number("Pivot Y", 0, -2, 2, 0.05),
      perspective: number("Perspective", 0.45, 0, 0.95, 0.01),
      frontFace: boolean("Front Face", true), backFace: boolean("Back Face", true),
    } },
  { key: "color-grade", label: "Color Grade", group: "Utility", kind: "ranged", render: renderColorGrade,
    parameters: {
      // Stops: exposure in linear light (1 is one stop brighter). Brightness multiplies sRGB. exposure
      // is the old sRGB multiplier, stored only when given, so grades saved before stops draw the same.
      stops: number("Exposure", 0, -5, 5, 0.05, "stops"),
      // Highlight roll-off for stops: 0 clips hard (as before it existed), 1 bends from 54% sRGB (colorUtility.js rollOff).
      shoulder: number("Shoulder", 0, 0, 1, 0.01, "", { optional: true }),
      exposure: number("Gain", 1, 0, 4, 0.05, "x", { optional: true }), brightness: number("Brightness", 1, 0, 4, 0.05),
      contrast: number("Contrast", 1, 0, 4, 0.05), saturation: number("Saturation", 1, 0, 4, 0.05),
    } },
  { key: "color-remover", label: "Color Remover", group: "Utility", kind: "ranged", render: renderColorRemover,
    parameters: { targetColor: color("Target Color", "#00FF00"), range: number("Range", 0.18, 0, 1, 0.01),
      softness: number("Softness", 0.18, 0, 1, 0.01) } },
  ...UTILITY_COPY_EFFECTS,
  // Overlay generators (embers, snow, fog...): src/effects/particles.js.
  ...PARTICLE_EFFECTS,
  // Colour grading. Every default changes nothing, except keep-color (which keeps reds) and
  // lut (which needs a file). colorGrading.js says how each one is drawn.
  { key: "curves", label: "Curves", group: "Color", kind: "ranged", render: renderCurves,
    parameters: { master: curve("Master"), red: curve("Red"), green: curve("Green"), blue: curve("Blue"),
      strength: number("Strength", 1, 0, 1, 0.01) } },
  { key: "lut", label: "LUT", group: "Color", kind: "ranged", render: renderLut,
    parameters: { lut: lut("LUT File"), strength: number("Strength", 1, 0, 1, 0.01) } },
  { key: "hue-saturation", label: "Hue/Saturation", group: "Color", kind: "ranged", render: renderHueSaturation,
    parameters: {
      hue: number("Hue", 0, -3600, 3600, 1, "°"), saturation: number("Saturation", 1, 0, 4, 0.05),
      lightness: number("Lightness", 0, -1, 1, 0.01), colorize: boolean("Colorize", false), tint: color("Tint", "#C8935A"),
    } },
  { key: "white-balance", label: "White Balance", group: "Color", kind: "ranged", render: renderWhiteBalance,
    parameters: { temperature: number("Temperature", 0, -100, 100, 1), tint: number("Tint", 0, -100, 100, 1) } },
  { key: "color-wheels", label: "Color Wheels", group: "Color", kind: "ranged", render: renderColorWheels,
    // One scale for every gain field: the multiplier of white (1 unchanged). A channel field adds
    // to gain for its channel (gain 1 with gainBlue 0.8 is blue white at 1.8, clamped to 0..4), so
    // its range is -4..4 like gain's reach; documents saved with -1..1 values draw the same.
    parameters: Object.fromEntries([["lift", 0, -1, 1, 1], ["gamma", 1, 0.1, 4, 1], ["gain", 1, 0, 4, 4]].flatMap(([wheel, value, min, max, reach]) => {
      const label = wheel[0].toUpperCase() + wheel.slice(1);
      return [[wheel, number(label, value, min, max, 0.01)],
        ...["Red", "Green", "Blue"].map((channel) => [`${wheel}${channel}`, number(`${label} ${channel}`, 0, -reach, reach, 0.01)])];
    })) },
  { key: "keep-color", label: "Keep Color", group: "Color", kind: "ranged", render: renderKeepColor,
    parameters: {
      targetColor: color("Target Color", "#FF0000"), hueRange: number("Hue Range", 25, 0, 90, 1, "°"),
      softness: number("Softness", 15, 0, 90, 1, "°"), amount: number("Amount", 1, 0, 1, 0.01),
    } },
  // Hue, saturation and lightness per hue range, plus highlights and shadows (colorRanges.js).
  { key: "color-ranges", label: "Color Ranges", group: "Color", kind: "ranged", render: renderColorRanges,
    parameters: colorRangesFields(number) },
  // Eight ready-made looks with an amount (colorLook.js).
  { key: "color-look", label: "Color Look", group: "Color", kind: "ranged", render: renderColorLook,
    parameters: colorLookFields(number, color, boolean) },
  // Directional, zoom and spin blur (motionBlurs.js); edge fill, mirror, kaleidoscope (edges.js).
  ...BLUR_EFFECTS, FOCUS_BAND_EFFECT, ...EDGE_EFFECTS,
  // A math expression per point that displaces, cuts or tints (field.js).
  FIELD_EFFECT,
  // Glow, light rays and lens flare (light.js).
  ...LIGHT_EFFECTS,
  // Flat-colored cells that build, merge and resolve to the picture (mosaic.js).
  MOSAIC_EFFECT,
];

// Mix below 1 draws the layer as it was under the effect's result: (1 - mix) of one plus mix of
// the other, added (plus-lighter), so an opaque picture is an exact cross-fade. Resvg has no
// plus-lighter, so there the result goes over the full original at mix opacity (the same for
// opaque pictures). The copy under it is decorative (copyContent drops its IDs).
export function mixMarkup(original, result, mix, { raster = false } = {}) {
  const amount = Math.round(mix * 10000) / 10000;
  const under = copyContent(original);
  return raster
    ? `<g>${under}<g opacity="${amount}">${result}</g></g>`
    : `<g style="isolation:isolate"><g opacity="${Math.round((1 - amount) * 10000) / 10000}">${under}</g><g opacity="${amount}" style="mix-blend-mode:plus-lighter">${result}</g></g>`;
}

function withMix(render) {
  return (frame) => {
    const mix = frame?.parameters?.mix;
    if (!Number.isFinite(mix) || mix >= 1) return render(frame);
    if (mix <= 0) return frame.content;
    const result = render(frame);
    return result === frame.content ? result : mixMarkup(frame.content, result, mix, { raster: Boolean(frame.helpers?.raster) });
  };
}

function freezeDefinition(definition) {
  if (Object.hasOwn(definition.parameters, "mix")) throw new TypeError(`Effect ${definition.key} cannot name a setting mix`);
  if (typeof definition.render !== "function") throw new TypeError(`Effect ${definition.key} needs a renderer`);
  for (const field of Object.values(definition.parameters)) {
    if (field.options) { field.options.forEach(Object.freeze); Object.freeze(field.options); }
    Object.freeze(field);
  }
  return Object.freeze({ duration: definition.kind === "value" ? 0.8 : null,
    easing: Object.values(definition.parameters).some((field) => Object.hasOwn(field, "initial")) ? "smooth" : "linear",
    ...definition, render: withMix(definition.render), parameters: Object.freeze({ ...definition.parameters, mix: MIX }) });
}
export const EFFECTS = Object.freeze(definitions.map(freezeDefinition));
const byKey = new Map(EFFECTS.map((effect) => [effect.key, effect]));

export function effectDefinition(key) {
  const effect = byKey.get(key);
  if (!effect) throw new RangeError(`Unknown effect "${String(key)}"; choose ${[...byKey.keys()].join(", ")}`);
  return effect;
}

export function effectDefaults(key, { neutral = false } = {}) {
  return Object.fromEntries(Object.entries(effectDefinition(key).parameters).filter(([, field]) => !field.optional).map(([name, field]) =>
    [name, neutral && Object.hasOwn(field, "neutral") ? field.neutral : field.default]));
}

// Only the observed From -> To controls start with an Initial value block.
export function effectInitialValues(key) {
  return Object.fromEntries(Object.entries(effectDefinition(key).parameters)
    .filter(([, field]) => Object.hasOwn(field, "initial")).map(([name, field]) => [name, field.initial]));
}

// A multiplier where 1 leaves the picture as it is (exposure gain, brightness, contrast,
// saturation: 0 to 4, default 1). Directors passed 0.5 meaning "half a stop up" and -0.7 meaning
// "less saturated" (ceiling studies a and c, FRICTION), so these fields also take a signed text.
export const isUnchangedAtOne = (field) => field?.type === "number" && field.default === 1 && field.min === 0 && field.max === 4;
const SIGNED_AMOUNT = /^\s*([+-]\d+(?:\.\d+)?)\s*(stops?)?\s*$/i;

/**
 * A clear relative form of a "1 = unchanged" setting, as the setting it means, or null:
 * "-0.7" is 1 - 0.7 = 0.3; "+0.5" is 1.5; "+0.5 stop" on color-grade exposure is stops 0.5, and on
 * another such setting (brightness) it is 2 to the power 0.5. Stored values stay numbers.
 */
export function relativeSetting(key, name, value) {
  const field = effectDefinition(key).parameters[name];
  const match = typeof value === "string" && isUnchangedAtOne(field) ? SIGNED_AMOUNT.exec(value) : null;
  if (!match) return null;
  const amount = Number(match[1]);
  const round = (number) => Math.round(number * 1e4) / 1e4;
  if (!match[2]) return { name, value: round(1 + amount) };
  if (key === "color-grade" && name === "exposure") return { name: "stops", value: amount };
  return { name, value: round(2 ** amount) };
}

// What a value of such a setting does, in plain words (the edit receipt says it).
export function unchangedAtOneWords(name, value) {
  if (value === 1) return "unchanged";
  const share = (below, above) => (value < 1 ? below : above);
  const times = value < 1 ? (value === 0.5 ? "half" : `${Math.round(value * 100)}%`) : `${Math.round(value * 100) / 100}x`;
  if (/exposure|brightness|gain/i.test(name)) return value === 0 ? "black" : `${times} as bright`;
  if (/contrast/i.test(name)) return share(`flatter (${times} of the contrast)`, `punchier (${times} the contrast)`);
  if (/saturation/i.test(name)) return value === 0 ? "gray, no color" : share(`less color (${times} of it)`, `more color (${times} of it)`);
  return share(`weaker (${times} of unchanged)`, `stronger (${times} of unchanged)`);
}

export function normalizeEffectParameters(key, given, { partial = false, path = "parameters" } = {}) {
  const { parameters } = effectDefinition(key);
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new TypeError(`${path} must be an object`);
  // A signed text such as "-0.7" or "+0.5 stop" on a "1 = unchanged" setting becomes its number.
  const values = {};
  for (const [name, value] of Object.entries(given)) {
    const relative = Object.hasOwn(parameters, name) ? relativeSetting(key, name, value) : null;
    if (relative) values[relative.name] = relative.value; else values[name] = value;
  }
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(parameters, name)) throw new TypeError(`${path}.${name} is not a parameter of ${key}`);
  }
  const output = partial ? {} : effectDefaults(key);
  for (const [name, value] of Object.entries(values)) {
    const field = parameters[name];
    const at = `${path}.${name}`;
    // A field marked auto also takes "auto": the effect works the value out from the layer.
    if (field.auto && value === "auto") {
      output[name] = value;
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < field.min || value > field.max || (field.integer && !Number.isInteger(value)))
        throw new RangeError(`${at} must be ${field.integer ? "an integer" : "a number"} from ${field.min} to ${field.max}${isUnchangedAtOne(field) ? ` where 1 is unchanged (write "+0.5" or "-0.3" as text for more or less than unchanged${name === "exposure" ? `, "+0.5 stop" for half a stop brighter` : ""})` : ""}`);
      output[name] = value;
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new TypeError(`${at} must be true or false`);
      output[name] = value;
    } else if (field.type === "enum") {
      if (!field.options.some(([option]) => option === value)) throw new RangeError(`${at} must be ${field.options.map(([option]) => option).join(", ")}`);
      output[name] = value;
    } else if (field.type === "color") {
      if (typeof value !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) throw new TypeError(`${at} must be a 3 or 6 digit hex color`);
      output[name] = (value.length === 4 ? `#${[...value.slice(1)].map((digit) => digit + digit).join("")}` : value).toUpperCase();
    } else if (field.type === "curve") {
      output[name] = normalizeCurve(value, at);
    } else if (field.type === "lut") {
      if (typeof value !== "string" || !LUT_SOURCE.test(value))
        throw new TypeError(`${at} must be the src of an imported .cube file, such as /api/media/<id>.cube (project {action:"import", file:"/absolute/look.cube"} gives it)`);
      output[name] = value;
    } else if (field.type === "expression") {
      if (typeof value !== "string") throw new TypeError(`${at} must be text: a math expression of ${field.inputs.join(", ")}`);
      if (!(field.empty && value.trim() === "")) {
        try { compileExpression(value, { inputs: field.inputs }); } catch (error) {
          if (error instanceof ExpressionError) throw new TypeError(`${at}: ${error.message}`);
          throw error;
        }
      }
      output[name] = value;
    } else throw new TypeError(`Unsupported effect parameter type ${field.type}`);
  }
  if (!partial) for (const [name, field] of Object.entries(parameters))
    if (field.required && output[name] == null)
      throw new TypeError(`${path}.${name} is required: the src of an imported .cube file (project {action:"import", file:"/absolute/look.cube"} gives it)`);
  return output;
}

/** The media sources (/api/media/...) an effect animation uses, such as a lut effect's .cube file. */
export function effectMediaSources(animation) {
  if (animation?.kind !== "effect" || !byKey.has(animation.effect)) return [];
  const sources = [];
  for (const [name, field] of Object.entries(byKey.get(animation.effect).parameters))
    if (field.type === "lut") for (const endpoint of [animation.to, animation.from])
      if (typeof endpoint?.[name] === "string") sources.push(endpoint[name]);
  return sources;
}

// What values a parameter takes, after its type: " 0..1500 integer px/s", " area/bottom/…", and so on.
export function fieldRange(field) {
  if (field.type === "number") return ` ${field.min}..${field.max}${field.integer ? " integer" : ""}${field.unit ? ` ${field.unit}` : ""}${field.auto ? " or \"auto\"" : ""}${isUnchangedAtOne(field) ? " (1 = unchanged)" : ""}`;
  if (field.type === "color" && field.auto) return " hex or \"auto\"";
  if (field.type === "enum") return ` ${field.options.map(([value]) => value).join("/")}`;
  if (field.type === "curve") return ` [[in,out],…] 2..${MAX_CURVE_POINTS} points 0..1`;
  if (field.type === "lut") return " (an imported .cube file's src)";
  if (field.type === "expression") return ` of ${field.inputs.join(" ")}${field.empty ? " or \"\"" : ""}`;
  return "";
}

// Kept generated so an MCP client sees the same names, types, defaults and limits as the UI.
// `group` limits it to one catalog group; `exceptGroup` leaves one group (or a list) out; `keys` keeps only those effects.
// Mix is on every effect, so the guide says it once (MIX_DOCUMENTATION) instead of once per effect.
export const MIX_DOCUMENTATION = "Every effect also takes mix number 0..1 default 1 (how much of the effect shows over the layer as it was)";
export function effectDocumentation({ group, exceptGroup, keys } = {}) {
  const left = [exceptGroup].flat();
  return EFFECTS.filter((effect) => (!group || effect.group === group) && !left.includes(effect.group) && (!keys || keys.includes(effect.key)))
    .map((effect) => `${effect.key} (${effect.label}; ${effect.kind}): ` +
    Object.entries(effect.parameters).filter(([key]) => key !== "mix").map(([key, field]) => `${key} ${field.type}${fieldRange(field)}` +
      (field.required ? " required" : ` default ${JSON.stringify(field.default)}`) +
      (Object.hasOwn(field, "initial") ? ` initial ${JSON.stringify(field.initial)}` : "")).join("; ")).join(". ");
}

// "a, b and c" (or "a, b or c").
function listOf(words, last = "and") {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

// The same facts as effectDocumentation for a group whose effects share most of their settings
// (the eight Generate looks), in about a quarter of the length: each setting once with its range,
// naming the effects where the range differs, which effects lack which settings, then a table with
// one row of defaults per effect for the settings whose default differs between them. It expects
// every setting to have a default (no required or initial values, unlike lut or the value effects).
// Example line: "size 0.5..48 px (embers), 4..400 px (bokeh)". Example row: "embers 150 8 …".
export function sharedEffectDocumentation({ group }) {
  const effects = EFFECTS.filter((effect) => effect.group === group);
  const keys = [...new Set(effects.flatMap((effect) => Object.keys(effect.parameters)))];
  const shown = (value) => typeof value === "string" ? value : JSON.stringify(value);
  const tableKeys = [];
  const lacking = new Map(); // "fog and light-leaks" → the settings they do not have
  const described = keys.map((key) => {
    const having = effects.filter((effect) => effect.parameters[key]);
    // Effects with the same range share one entry: "0..2000 integer (snow, dust, rain)".
    const ranges = new Map();
    for (const effect of having) {
      const field = effect.parameters[key];
      const range = field.type === "number" || field.type === "enum" ? fieldRange(field).trim() : field.type;
      ranges.set(range, [...(ranges.get(range) ?? []), effect.key]);
    }
    let text = ranges.size === 1 ? [...ranges.keys()][0] : [...ranges].map(([range, names]) => `${range} (${names.join(", ")})`).join(", ");
    const defaults = new Set(having.map((effect) => shown(effect.parameters[key].default)));
    if (defaults.size === 1) text += ` default ${[...defaults][0]}`;
    else tableKeys.push(key);
    const missing = effects.filter((effect) => !effect.parameters[key]).map((effect) => effect.key);
    if (missing.length) {
      const names = `${listOf(missing)} ${missing.length === 1 ? "has" : "have"} no`;
      lacking.set(names, [...(lacking.get(names) ?? []), key]);
    }
    return { keys: [key], text };
  });
  // Settings next to each other with the same description share one entry: "opacity, glow 0..1".
  const merged = [];
  for (const entry of described) {
    if (merged.at(-1)?.text === entry.text) merged.at(-1).keys.push(...entry.keys);
    else merged.push(entry);
  }
  const rows = effects.map((effect) =>
    [effect.key, ...tableKeys.map((key) => effect.parameters[key] ? shown(effect.parameters[key].default) : "-")].join(" "));
  return [
    `${merged.map((entry) => `${entry.keys.join(", ")} ${entry.text}`).join("; ")}.` +
      [...lacking].map(([names, missingKeys]) => ` ${names} ${listOf(missingKeys, "or")}.`).join(""),
    "Defaults (- where an effect has no such setting):", ["effect", ...tableKeys].join(" "), ...rows,
  ].join("\n");
}
