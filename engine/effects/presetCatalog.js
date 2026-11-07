// Observed controls/defaults; ranges and rendering are kino's own choices.
const number = (label, value, min, max, step = 1, unit = "", integer = false) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...(integer ? { integer } : {}) });
const choice = (label, value, options) => ({ type: "enum", label, default: value, options });
const directions = [["up", "Up"], ["down", "Down"], ["left", "Left"], ["right", "Right"]];
const variant = () => number("Variant", 2, -2147483648, 2147483647, 1, "", true);

export const EFFECT_PRESET_DEFINITIONS = Object.freeze(Object.fromEntries([
  ["dissolve", "Dissolve", "linear", {
    scale: number("Scale", 10, 1, 100, 1, "px"), sharpness: number("Sharpness", 100, 0, 100, 1, "%"), variant: variant(),
  }],
  ["pixel", "Pixel", "linear", { pixelSize: number("Pixel Size", 40, 1, 256, 1, "px"), variant: variant() }],
  ["pixel-wipe", "Pixel Wipe", "ease-in", {
    direction: choice("Direction", "right", directions), scale: number("Scale", 34, 1, 256, 1, "px"),
    spread: number("Spread", 25, 0, 512, 1, "px"), variant: variant(),
  }],
  ["luma-reveal", "Luma Reveal", "ease-in", {
    sharpness: number("Sharpness", 90, 0, 100, 1, "%"),
    direction: choice("Reveal", "light-to-dark", [["light-to-dark", "Light → Dark"], ["dark-to-light", "Dark → Light"]]),
  }],
  ["glitch", "Glitch", "ease-in", {
    sliceSize: number("Slice size", 30, 1, 256, 1, "px"), speed: number("Speed", 65, 0, 100, 1, "%"),
    colorShift: number("Color shift", 40, 0, 100, 1, "%"), variant: variant(),
  }],
  ["barrel", "Barrel", "ease-in", {
    intensity: number("Intensity", 0.5, 0, 2, 0.05),
    direction: choice("Direction", "inward", [["inward", "Inward"], ["outward", "Outward"]]),
  }],
  ["film-roll", "Film Roll", "natural", {
    direction: choice("Direction", "up", directions), copies: number("Copies", 6, 1, 12, 1, "", true),
    motionBlur: number("Motion Blur", 50, 0, 100, 1, "%"), stretch: number("Stretch", 50, 0, 100, 1, "%"),
  }],
].map(([id, name, easing, fields]) => [id, Object.freeze({ id, name, group: "Effects", easing, duration: 1,
  fields: Object.freeze(fields), parameters: Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.default]))) })])));

export const isEffectPreset = (value) => Boolean(value && Object.hasOwn(EFFECT_PRESET_DEFINITIONS, value.id));

export function normalizeEffectPresetParameters(id, values = {}) {
  const definition = EFFECT_PRESET_DEFINITIONS[id];
  if (!definition) throw new RangeError(`Unknown effect preset ${String(id)}`);
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new TypeError("Preset parameters must be an object");
  const result = { ...definition.parameters };
  for (const [key, value] of Object.entries(values)) {
    const field = definition.fields[key];
    if (!field) throw new TypeError(`Unknown ${id} preset parameter ${key}`);
    if (field.type === "enum") {
      if (!field.options.some(([option]) => option === value)) throw new RangeError(`${key} must be ${field.options.map(([option]) => option).join(", ")}`);
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < field.min || value > field.max || (field.integer && !Number.isInteger(value)))
      throw new RangeError(`${key} must be ${field.integer ? "an integer" : "a number"} from ${field.min} to ${field.max}`);
    result[key] = value;
  }
  return result;
}

// This is an ordinary animated channel so independent text units use the same
// timing/easing machinery as every other preset. Later presets replace this
// channel in timeline order, matching the existing Wipe/reveal behavior.
export function normalizeEffectPresetValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("effectPreset must be an object");
  for (const key of Object.keys(value)) if (!["id", "parameters", "progress"].includes(key)) throw new TypeError(`Unknown effectPreset field ${key}`);
  if (!isEffectPreset(value)) throw new RangeError(`Unknown effect preset ${String(value.id)}`);
  if (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1)
    throw new RangeError("effectPreset progress must be from 0 to 1");
  return { id: value.id, parameters: normalizeEffectPresetParameters(value.id, value.parameters), progress: value.progress };
}

export function effectPresetDocumentation() {
  return Object.values(EFFECT_PRESET_DEFINITIONS).map(({ id, easing, fields }) => `preset-${id} (1s, ${easing}): ` +
    Object.entries(fields).map(([key, field]) => `${key} ` + (field.type === "enum"
      ? field.options.map(([option]) => option).join("/") : `${field.min}..${field.max}${field.integer ? " integer" : ""}${field.unit ? ` ${field.unit}` : ""}`) +
      ` default ${JSON.stringify(field.default)}`).join("; ")).join(". ");
}
