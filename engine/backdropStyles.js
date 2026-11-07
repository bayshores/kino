const backgroundBlur = Object.freeze({
  label: "Background blur",
  defaults: Object.freeze({ enabled: false, radius: 4, blend: 20 }),
  fields: Object.freeze([
    Object.freeze({ key: "radius", label: "Radius", min: 0, max: 100, step: 1, suffix: "px" }),
    Object.freeze({ key: "blend", label: "Blend", min: 0, max: 100, step: 1, suffix: "%" }),
  ]),
});

const glass = Object.freeze({
  label: "Glass",
  defaults: Object.freeze({
    enabled: false,
    refraction: 50,
    depth: 50,
    dispersion: 50,
    frost: 0,
    lightIntensity: 100,
    lightAngle: 0,
    blend: 0,
  }),
  fields: Object.freeze([
    Object.freeze({ key: "refraction", label: "Refraction", min: 0, max: 100, step: 1, suffix: "%" }),
    Object.freeze({ key: "depth", label: "Depth", min: 0, max: 100, step: 1, suffix: "%" }),
    Object.freeze({ key: "dispersion", label: "Dispersion", min: 0, max: 100, step: 1, suffix: "%" }),
    Object.freeze({ key: "frost", label: "Frost", min: 0, max: 100, step: 1 }),
    Object.freeze({ key: "lightIntensity", label: "Light intensity", min: 0, max: 200, step: 1, suffix: "%" }),
    Object.freeze({ key: "lightAngle", label: "Light angle", min: -360, max: 360, step: 1, suffix: "°" }),
    Object.freeze({ key: "blend", label: "Blend", min: 0, max: 100, step: 1, suffix: "%" }),
  ]),
});

export const BACKDROP_STYLE_DEFINITIONS = Object.freeze({ backgroundBlur, glass });
export const BACKDROP_STYLE_KEYS = Object.freeze(Object.keys(BACKDROP_STYLE_DEFINITIONS));

function definitionFor(styleKey) {
  const definition = BACKDROP_STYLE_DEFINITIONS[styleKey];
  if (!definition) throw new TypeError(`Unknown backdrop style "${String(styleKey)}"`);
  return definition;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function defaultBackdropStyle(styleKey) {
  return { ...definitionFor(styleKey).defaults };
}

/**
 * Validate and complete one optional layer style or animation endpoint. Missing style members
 * receive their published defaults; the caller decides whether `null` means deletion.
 */
export function normalizeBackdropStyle(styleKey, value, path = styleKey) {
  const definition = definitionFor(styleKey);
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  const numericFields = new Map(definition.fields.map((field) => [field.key, field]));
  const normalized = defaultBackdropStyle(styleKey);
  for (const key of Object.keys(value)) {
    if (key === "enabled") {
      if (typeof value.enabled !== "boolean") throw new TypeError(`${path}.enabled must be true or false`);
      normalized.enabled = value.enabled;
      continue;
    }
    const field = numericFields.get(key);
    if (!field) throw new TypeError(`${path}.${key} is not a ${definition.label} field`);
    const next = value[key];
    if (typeof next !== "number" || !Number.isFinite(next) || next < field.min || next > field.max)
      throw new RangeError(`${path}.${key} must be a finite number from ${field.min} to ${field.max}`);
    normalized[key] = next;
  }
  return normalized;
}

/** Read a layer style without adding a default object to the document. */
export function readBackdropStyle(layer, styleKey) {
  const value = layer?.[styleKey];
  return value == null
    ? defaultBackdropStyle(styleKey)
    : normalizeBackdropStyle(styleKey, value, `layer.${styleKey}`);
}
