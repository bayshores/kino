import { createDocument, createLayer, parseDocument } from "./model.js";
import { pasteAnimations } from "./layerClipboard.js";

const NAME_LIMIT = 120;
const REST_FIELDS = Object.freeze([
  "x", "y", "rotation", "blur", "letterSpacing", "lineHeight",
  "scaleX", "scaleY", "opacity",
]);
const ANIMATION_FIELDS = Object.freeze([
  "duration", "easing", "intensity", "kind", "from", "to", "unit",
  "stagger", "delays", "scatter", "range", "order", "anchor", "motionPath", "shadowChannels", "preset",
  "discrete", "smoothing", "smoothingIntensity", "textAnchor", "textClip", "fromCurrent",
]);
const TRANSIENT_FIELDS = new Set(["id", "start", "name", "enabled"]);
const ANIMATION_FIELD_SET = new Set([...ANIMATION_FIELDS, ...TRANSIENT_FIELDS]);
const REST_FIELD_SET = new Set(REST_FIELDS);
const PAINT_FIELDS = new Set(["type", "angle", "stops"]);
const PAINT_STOP_FIELDS = new Set(["id", "offset", "color"]);
const SHADOW_FIELDS = new Set(["color", "x", "y", "blur"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function copyJson(value) {
  return structuredClone(value);
}

function checkedName(value) {
  if (typeof value !== "string") throw new TypeError("Saved text effect name must be a string.");
  const name = value.trim();
  if (!name || name.length > NAME_LIMIT)
    throw new RangeError(`Saved text effect name must be 1 to ${NAME_LIMIT} characters.`);
  return name;
}

function checkedRest(value = {}) {
  if (!isRecord(value)) throw new TypeError("Saved text effect rest must be an object.");
  const rest = {};
  for (const [key, number] of Object.entries(value)) {
    if (!REST_FIELD_SET.has(key)) throw new TypeError(`Saved text effect rest cannot contain ${key}.`);
    if (typeof number !== "number" || !Number.isFinite(number))
      throw new TypeError(`Saved text effect rest ${key} must be a finite number.`);
    rest[key] = number;
  }
  return rest;
}

function checkedAnimation(value) {
  if (!isRecord(value)) throw new TypeError("A saved text effect needs one animation object.");
  for (const key of Object.keys(value)) {
    if (!ANIMATION_FIELD_SET.has(key)) throw new TypeError(`Saved text effect animation cannot contain ${key}.`);
  }
  if (!["in", "out", "custom"].includes(value.kind))
    throw new TypeError("A saved text effect must be one timed in, out, or custom operation.");
  const animation = copyJson(value);
  for (const endpoint of ["from", "to"]) {
    const values = animation[endpoint];
    if (!isRecord(values)) continue; // parseDocument reports the required endpoint shape.
    for (const [property, paint] of Object.entries(values)) {
      if (property === "fill" || property === "stroke") checkPaint(paint, `${endpoint}.${property}`);
      if (property === "shadow" && paint !== null) checkFields(paint, SHADOW_FIELDS, `${endpoint}.shadow`);
      if (property === "reveal" && paint != null) checkFields(paint, new Set(["progress", "direction", "softness"]), `${endpoint}.reveal`);
    }
  }
  return animation;
}

function checkFields(value, allowed, label) {
  if (!isRecord(value)) return; // The model validator supplies the type-specific error.
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Saved text effect ${label} cannot contain ${key}.`);
  }
}

function checkPaint(paint, label) {
  if (typeof paint === "string") return;
  if (!isRecord(paint)) return; // Let parseDocument report malformed paint values.
  checkFields(paint, PAINT_FIELDS, `paint ${label}`);
  if (!Array.isArray(paint.stops)) return;
  for (const [index, stop] of paint.stops.entries())
    checkFields(stop, PAINT_STOP_FIELDS, `paint ${label}.stops[${index}]`);
}

function syntheticDocument(rest, animation) {
  const document = createDocument({ id: "saved-text-effect-document", name: "Saved text effect" });
  const layer = createLayer("text", {
    id: "saved-text-effect-layer",
    ...rest,
    animations: animation ? [animation] : [],
  });
  document.scenes[0].layers = [layer];
  return parseDocument(document);
}

function normalizedPortable(input) {
  const rest = checkedRest(input.rest);
  const source = checkedAnimation(input.animation);
  const temporary = {
    ...source,
    id: "saved-text-effect-animation",
    name: "Saved text effect",
    start: 0,
  };
  delete temporary.enabled;
  const document = syntheticDocument(rest, temporary);
  const layer = document.scenes[0].layers[0];
  const normalizedAnimation = layer.animations[0];
  const animation = {};
  for (const key of ANIMATION_FIELDS) {
    if (Object.hasOwn(normalizedAnimation, key)) animation[key] = copyJson(normalizedAnimation[key]);
  }
  const normalizedRest = Object.fromEntries(Object.keys(rest).map((key) => [key, layer[key]]));
  return { animation, rest: normalizedRest };
}

/** Make a portable copy of a text animation without its source layer, text, or identity. */
export function savedTextEffectInput(name, layer, animation) {
  if (layer?.type !== "text") throw new TypeError("Save a text animation from a text layer.");
  const rest = Object.fromEntries(REST_FIELDS
    .filter((key) => Number.isFinite(layer[key]))
    .map((key) => [key, layer[key]]));
  return normalizeSavedTextEffect({ name, animation, rest });
}

/** Validate and deeply copy an API/store item into its portable {name, animation, rest} form. */
export function normalizeSavedTextEffect(input) {
  if (!isRecord(input)) throw new TypeError("Saved text effect must be an object.");
  const unexpected = Object.keys(input).filter((key) => !["id", "name", "animation", "rest"].includes(key));
  if (unexpected.length) throw new TypeError(`Saved text effect cannot contain ${unexpected.join(", ")}.`);
  if (!Object.hasOwn(input, "name") || !Object.hasOwn(input, "animation"))
    throw new TypeError("Saved text effect needs a name and animation.");
  const name = checkedName(input.name);
  const { animation, rest } = normalizedPortable({ animation: input.animation, rest: input.rest === undefined ? {} : input.rest });
  return { name, animation, rest };
}

/** Apply a saved copy to unlocked text layers, rebasing its endpoints from saved rest values. */
export function applySavedTextEffect(document, sceneId, layerIds, item, time) {
  const scene = document?.scenes?.find((entry) => entry.id === sceneId);
  if (!scene) throw new Error("The scene for this text effect no longer exists.");
  if (!Array.isArray(layerIds) || layerIds.length === 0 || layerIds.some((id) => typeof id !== "string"))
    throw new TypeError("Select one or more text layers to apply this effect.");
  const ids = [...new Set(layerIds)];
  const targets = ids.map((id) => scene.layers.find((layer) => layer.id === id));
  if (targets.some((layer) => !layer)) throw new Error("One or more selected layers no longer exist in this scene.");
  if (targets.some((layer) => layer.type !== "text"))
    throw new Error("A saved text effect can only be applied to text layers.");
  if (targets.some((layer) => layer.locked))
    throw new Error("A saved text effect cannot be applied to a locked layer.");

  const saved = normalizeSavedTextEffect(item);
  const animation = {
    ...saved.animation,
    id: "saved-text-effect-copy",
    name: saved.name,
    start: 0,
  };
  return pasteAnimations(document, sceneId, ids, {
    kind: "animations",
    rest: saved.rest,
    rests: [saved.rest],
    animations: [animation],
  }, time);
}

