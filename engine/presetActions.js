import { MAX_TIME, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { normalizePreset } from "./presetCatalog.js";

const ACTION_FAMILIES = Object.freeze([
  { name: "Opacity", keys: ["opacity"], metadata: ["discrete"] },
  { name: "Layer Blur", keys: ["blur"] },
  { name: "Move", keys: ["x", "y"], metadata: ["motionPath"] },
  { name: "Scale", keys: ["scaleX", "scaleY"] },
  { name: "Rotate", keys: ["rotation"] },
  { name: "Fill", keys: ["fill"] },
  { name: "Shadow", keys: ["shadow"], metadata: ["shadowChannels"] },
  { name: "Resize", keys: ["width", "height"], metadata: ["anchor"] },
  { name: "Stroke", keys: ["stroke", "strokeWidth"] },
  { name: "Reveal", keys: ["reveal"] },
  { name: "Morph", keys: ["path"] },
  { name: "Corner Radius", keys: ["radius", "cornerRadii"] },
  { name: "Arc", keys: ["donut", "sweep", "startAngle"] },
  { name: "Star", keys: ["spikes", "starThickness"] },
]);

const FAMILY_BY_KEY = new Map(ACTION_FAMILIES.flatMap((family) => family.keys.map((key) => [key, family])));
const TIMED_KINDS = new Set(["in", "out", "custom"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function nextId(existing) {
  let value;
  do {
    const raw = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    value = `preset-action-${raw}`;
  } while (existing.has(value));
  existing.add(value);
  return value;
}

function validateAsStoredAnimation(layer, animation) {
  const target = createLayer(layer.type, {
    id: "preset-actions-target",
    name: "Preset action target",
    animations: [structuredClone(animation)],
    ...(layer.type === "component" ? { componentSceneId: "preset-actions-source" } : {}),
  });
  const scenes = [createScene({
    id: "preset-actions-scene",
    name: "Preset action validation",
    duration: MAX_TIME,
    layers: [target],
  })];
  if (layer.type === "component") {
    scenes.push(createScene({
      id: "preset-actions-source",
      name: "Preset action source",
      width: target.width,
      height: target.height,
      isComponent: true,
      layers: [],
    }));
  }
  parseDocument(createDocument({
    id: "preset-actions-validation",
    name: "Preset action validation",
    scenes,
  }));
}

/** Return why a stored non-text preset cannot be converted, or null when it can. */
export function presetActionProblem(layer, animation) {
  if (!isRecord(layer) || typeof layer.type !== "string") return "Select a layer with an animation.";
  if (layer.type === "text") return "Text animation presets cannot be converted to actions.";
  if (layer.type === "audio") return "Audio layers cannot be converted to animation actions.";
  if (!isRecord(animation)) return "Select a preset animation to convert.";
  if (!TIMED_KINDS.has(animation.kind))
    return "Only timed animation presets can be converted to actions.";
  if (!isRecord(animation.preset)) return "Only preset animations can be converted to actions.";

  let preset;
  try {
    preset = normalizePreset(animation.preset);
  } catch (error) {
    return error?.message || "This preset is invalid and cannot be converted.";
  }
  if (preset.text || preset.id === "custom-text")
    return "Text animation presets cannot be converted to actions.";
  if (animation.kind !== preset.mode)
    return "The preset mode and animation kind do not match.";
  if (!isRecord(animation.from) || !isRecord(animation.to))
    return "The preset needs valid From and To values before it can be converted.";

  const keys = [...new Set([...Object.keys(animation.from), ...Object.keys(animation.to)])];
  if (keys.length === 0) return "The preset does not contain any action values.";
  const unsupported = keys.find((key) => !FAMILY_BY_KEY.has(key));
  if (unsupported) return `The ${unsupported} property cannot be converted to an action.`;

  try {
    validateAsStoredAnimation(layer, animation);
  } catch (error) {
    return error?.message || "This preset is malformed and cannot be converted.";
  }
  return null;
}

/** Split exact saved endpoint tracks into independent, freshly identified custom actions. */
export function presetActions(layer, animation) {
  const problem = presetActionProblem(layer, animation);
  if (problem) throw new TypeError(problem);

  const keys = new Set([...Object.keys(animation.from), ...Object.keys(animation.to)]);
  const existingIds = new Set([animation.id]);
  return ACTION_FAMILIES.filter((family) => family.keys.some((key) => keys.has(key)))
    .map((family) => {
      const member = structuredClone(animation);
      member.id = nextId(existingIds);
      member.name = family.name;
      member.kind = animation.kind;
      member.start = 0;
      member.from = Object.fromEntries(family.keys
        .filter((key) => Object.hasOwn(animation.from, key))
        .map((key) => [key, structuredClone(animation.from[key])]));
      member.to = Object.fromEntries(family.keys
        .filter((key) => Object.hasOwn(animation.to, key))
        .map((key) => [key, structuredClone(animation.to[key])]));

      // The composition wrapper keeps the source preset's identity. Members are ordinary custom
      // actions with the exact stored endpoints, so later parameter edits cannot regenerate them.
      delete member.preset;
      for (const field of ["discrete", "anchor", "shadowChannels", "motionPath"])
        if (!family.metadata?.includes(field)) delete member[field];
      return member;
    });
}
