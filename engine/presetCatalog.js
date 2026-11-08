// Presets keep their identity and controls alongside ordinary evaluated endpoints. Loading a
// document never regenerates those endpoints: moving/reparenting/copying old work remains exact.
// New explicit text presets evaluate only relative travel from the current line height;
// parameter edits regenerate complete endpoints, and endpoint edits detach the preset.
import { effectiveBoxStyle, CORNER_LAYER_TYPES, STROKE_LAYER_TYPES } from "./boxStyles.js";
import { FILL_LAYER_TYPES } from "./paints.js";
import { resizableSides } from "./resizeAnchor.js";
import { counterTextProblem } from "./counter.js";
import { resizeTextLayer } from "./textLayout.js";
import { lineHeightPixels } from "./lineHeight.js";
import { EFFECT_PRESET_DEFINITIONS, isEffectPreset, normalizeEffectPresetParameters } from "./effects/presetCatalog.js";
import { WIPE_RANGES, WIPE_SHAPES } from "./reveal.js";
import { retimeBehavior } from "./behavior.js";

const definitions = {
  appear: { name: "Appear", group: "Basic", parameters: {} },
  fade: { name: "Fade", group: "Basic", parameters: {} },
  slide: { name: "Slide", group: "Slide", parameters: { direction: "up", distance: 50 } },
  mask: { name: "Mask", group: "Mask", parameters: { direction: "up" } },
  grow: { name: "Grow", group: "Scale", parameters: { scale: 0 } },
  shrink: { name: "Shrink", group: "Scale", parameters: { scale: 200 } },
  blur: { name: "Blur", group: "Blur", parameters: { blur: 20 } },
  "blur-slide": { name: "Blur & Slide", group: "Blur", parameters: { blur: 20, direction: "up", distance: 50 } },
  // A fast slide that fades at its far end. The renderer smears it along its path while it moves
  // (render.js motionSmear), so one whip out and the next block's whip in hide the swap.
  whip: { name: "Whip", group: "Blur", parameters: { direction: "up", distance: 120 } },
  wipe: { name: "Wipe", group: "Effects", parameters: { direction: "right", softness: 20 } },
  blink: { name: "Blink", group: "Effects", parameters: { count: 3 } },
  ...EFFECT_PRESET_DEFINITIONS,
  rotate: { name: "Rotate", group: "Transform", parameters: { angle: -90 } },
  "custom-text": { name: "Custom text effect", group: "Custom", parameters: {
    moveX: null, moveY: 100, angle: null, scale: null, opacity: null, color: null, blur: null,
  } },
};
export const PRESET_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(definitions)
  .map(([id, value]) => [id, Object.freeze({ id, ...value, parameters: Object.freeze(value.parameters) })])));
export const PRESET_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);
const aliases = {
  "fade-in": ["fade", "in"], "fade-out": ["fade", "out"],
  "slide-up": ["slide", "in", { direction: "up" }], "slide-down": ["slide", "in", { direction: "down" }],
  "slide-left": ["slide", "in", { direction: "left" }], "slide-right": ["slide", "in", { direction: "right" }],
  "grow-in": ["grow", "in"], "shrink-out": ["grow", "out"],
  "blur-in": ["blur", "in"], "blur-out": ["blur", "out"], "rotate-in": ["rotate", "in"],
  "mask-up": ["mask", "in", { direction: "up" }], "mask-down": ["mask", "in", { direction: "down" }],
  appear: ["appear", "in"], wipe: ["wipe", "in"], blink: ["blink", "in"],
  "blur-slide": ["blur-slide", "in"], "whip-in": ["whip", "in"], "whip-out": ["whip", "out"],
};
// Optional wipe settings of wipe and (not text) mask: absent, today's straight wipe (reveal.js, wipe.js).
export const WIPE_PARAMETERS = Object.freeze(["shape", "angle", "centerX", "centerY", "edgeColor", "edgeWidth"]);
const ranges = { distance: [0, 1000], moveX: [-1000, 1000], moveY: [-1000, 1000], opacity: [0, 100], blur: [0, 1000], scale: [0, 1000], softness: [0, 100], count: [1, 20], angle: [-360000, 360000] };
function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`${name} must be an object`);
  return value;
}
function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name} has unknown field ${key}`);
}

export function normalizePreset(value) {
  record(value, "preset");
  onlyKeys(value, ["id", "mode", "parameters", "text"], "preset");
  const definition = PRESET_DEFINITIONS[value.id];
  if (typeof value.id !== "string" || !Object.hasOwn(PRESET_DEFINITIONS, value.id)) throw new RangeError(`Unknown preset id ${String(value.id)}`);
  const mode = value.mode ?? "in";
  if (mode !== "in" && mode !== "out") throw new TypeError("Preset mode must be in or out");
  if (value.text !== undefined && typeof value.text !== "boolean") throw new TypeError("Preset text must be true or false");
  if (value.id === "custom-text" && value.text !== true) throw new TypeError("Custom text effects require text: true");
  const parameters = { ...definition.parameters };
  if (value.text && value.id === "mask") parameters.distance = 100;
  const supplied = value.parameters === undefined ? {} : record(value.parameters, "preset.parameters");
  if (isEffectPreset(value)) return { id: value.id, mode, parameters: normalizeEffectPresetParameters(value.id, supplied),
    ...(value.text !== undefined ? { text: value.text } : {}) };
  const wipes = value.id === "wipe" || (value.id === "mask" && !value.text);
  onlyKeys(supplied, [...Object.keys(parameters), ...(wipes ? WIPE_PARAMETERS : [])], "preset.parameters");
  for (const [key, next] of Object.entries(supplied)) {
    if (value.id === "custom-text" && next === null) {
      parameters[key] = null;
      continue;
    }
    if (key === "shape") {
      if (!WIPE_SHAPES.includes(next)) throw new TypeError("Preset shape must be linear, radial, iris, or clock");
    } else if (key === "color" || key === "edgeColor") {
      if (typeof next !== "string" || !/^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/.test(next))
        throw new TypeError(`Preset ${key} must be a hex color${key === "color" ? " or null" : ""}`);
    } else if (key === "direction") {
      if (!PRESET_DIRECTIONS.includes(next)) throw new TypeError("Preset direction must be up, down, left, or right");
    } else {
      const [min, max] = (wipes && WIPE_RANGES[key]) || ranges[key];
      if (typeof next !== "number" || !Number.isFinite(next) || next < min || next > max || (key === "count" && !Number.isInteger(next)))
        throw new RangeError(`Preset ${key} must be ${key === "count" ? "an integer" : "a finite number"} from ${min} to ${max}`);
    }
    parameters[key] = next;
  }
  if (value.id === "custom-text" && Object.values(parameters).every((next) => next === null))
    throw new TypeError("A custom text effect needs at least one enabled property");
  return { id: value.id, mode, parameters, ...(value.text !== undefined ? { text: value.text } : {}) };
}

export function resolvePreset(id, { mode, parameters, text } = {}) {
  const alias = Object.hasOwn(aliases, id) ? aliases[id] : null;
  const canonical = typeof id === "string" && id.startsWith("preset-") ? id.slice(7) : null;
  if (!alias && !canonical) return null;
  return normalizePreset({ id: alias?.[0] ?? canonical, mode: mode ?? alias?.[1] ?? "in", ...(text !== undefined ? { text } : {}),
    parameters: { ...(alias?.[2] ?? {}), ...record(parameters === undefined ? {} : parameters, "preset.parameters") } });
}

const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
// The opacity a fade shows the layer at: its own, or full when it is stored hidden (opacity 0),
// so a fade on a layer kept invisible until its entrance still fades.
export const shownOpacity = (layer) => number(layer.opacity, 1) > 0 ? number(layer.opacity, 1) : 1;
export function presetLayerGeometry(layer, document, fonts) {
  const styled = effectiveBoxStyle(layer);
  if (styled.type === "component") {
    const source = document?.scenes?.find((scene) => scene.id === styled.componentSceneId);
    return source ? { ...styled, width: source.width, height: source.height } : styled;
  }
  if (styled.type !== "text") return styled;
  const measured = resizeTextLayer(styled, fonts);
  // Endpoints use stored x/y. The renderer applies auto-text anchor shifts after evaluation;
  // copying the measured x/y here would apply the same shift twice on centered/right text.
  return { ...styled, width: measured.width, height: measured.height };
}
export function presetValues(value, source) {
  const preset = normalizePreset(value);
  const layer = effectiveBoxStyle(source);
  if (!layer || layer.type === "audio") throw new TypeError("Presets need a layer that is drawn");
  if (preset.text && layer.type !== "text") throw new TypeError("Text presets need a text layer");
  const { id, mode, parameters: p } = preset;
  let rest, effect, discrete;
  const line = lineHeightPixels(layer.lineHeight, number(layer.fontSize, 40));
  if (isEffectPreset(preset)) {
    rest = { effectPreset: { id, parameters: p, progress: 1 } };
    effect = { effectPreset: { id, parameters: p, progress: 0 } };
  } else if (id === "custom-text") {
    rest = {}; effect = {};
    for (const [parameter, property] of [["moveX", "x"], ["moveY", "y"], ["angle", "rotation"], ["blur", "blur"]]) {
      if (p[parameter] === null) continue;
      rest[property] = number(layer[property]);
      const delta = p[parameter] * (["moveX", "moveY"].includes(parameter) ? line / 100 : 1);
      effect[property] = property === "blur" ? Math.min(1000, rest[property] + delta) : rest[property] + delta;
    }
    if (p.scale !== null) {
      for (const key of ["scaleX", "scaleY"]) { rest[key] = number(layer[key], 1); effect[key] = rest[key] * p.scale / 100; }
    }
    if (p.opacity !== null) { rest.opacity = shownOpacity(layer); effect.opacity = rest.opacity * p.opacity / 100; }
    if (p.color !== null) { rest.fill = layer.fill ?? "#000000"; effect.fill = p.color; }
  } else if (["appear", "fade", "blink"].includes(id)) {
    rest = { opacity: shownOpacity(layer) }; effect = { opacity: 0 };
    if (id === "appear") discrete = { type: "instant" };
    if (id === "blink") discrete = { type: "blink", count: p.count };
  } else if (["slide", "blur-slide", "whip"].includes(id) || (id === "mask" && preset.text)) {
    const vertical = p.direction === "up" || p.direction === "down";
    const key = vertical ? "y" : "x";
    const distance = (preset.text ? line : number(layer[vertical ? "height" : "width"])) * (p.distance ?? 100) / 100;
    // Direction names describe the movement into place. Out reverses that same movement.
    const sign = p.direction === "up" || p.direction === "left" ? 1 : -1;
    rest = { [key]: number(layer[key]) }; effect = { [key]: rest[key] + sign * distance };
    if (id === "blur-slide") { rest.blur = number(layer.blur); effect.blur = Math.min(1000, rest.blur + p.blur); }
    if (id === "whip") { rest.opacity = shownOpacity(layer); effect.opacity = 0; }
  } else if (id === "grow" || id === "shrink") {
    rest = { scaleX: number(layer.scaleX, 1), scaleY: number(layer.scaleY, 1) };
    effect = { scaleX: rest.scaleX * p.scale / 100, scaleY: rest.scaleY * p.scale / 100 };
  } else if (id === "blur") {
    rest = { blur: number(layer.blur) }; effect = { blur: Math.min(1000, rest.blur + p.blur) };
  } else if (id === "rotate") {
    rest = { rotation: number(layer.rotation) }; effect = { rotation: rest.rotation + p.angle };
  } else {
    const reveal = { direction: p.direction, softness: id === "wipe" ? p.softness : 0 };
    for (const key of WIPE_PARAMETERS) if (p[key] !== undefined) reveal[key] = p[key];
    rest = { reveal: { ...reveal, progress: 1 } }; effect = { reveal: { ...reveal, progress: 0 } };
  }
  return { kind: mode, from: mode === "in" ? effect : rest, to: mode === "in" ? rest : effect,
    ...(discrete ? { discrete } : {}) };
}

// The easing a preset starts with. Effect presets keep their own on purpose. Fades are linear and
// every other entrance or exit is smooth (0.5, 0, 0, 1): it lifts off gently, rushes through the
// middle and settles for the last half, the top curve in 404 public motion templates.
// expo-out ("snap") stays a choice. A whip keeps its fastest speed at
// the swap: it leaves ease-in and arrives expo-out.
const FADES = new Set(["appear", "fade", "blink"]);
const presetEasing = (preset) => EFFECT_PRESET_DEFINITIONS[preset.id]?.easing
  ?? (preset.id === "whip" ? (preset.mode === "out" ? "ease-in" : "expo-out") : FADES.has(preset.id) ? "linear" : "smooth");
// Seconds a preset lasts unless given (per-template medians): a fade 0.5, a scale 0.7,
// a rotation 1.05, a slide or other move 0.8.
const PRESET_SECONDS = { appear: 0.5, fade: 0.5, blink: 0.5, grow: 0.7, shrink: 0.7, rotate: 1.05, whip: 0.35 };

export function createCatalogAnimation(id, layer, start, options = {}, animationId) {
  const isText = layer.type === "text";
  if (!isText && (id === "preset-custom-text" || aliases[id]?.[0] === "custom-text"))
    throw new TypeError(`${id} animates the letters of a text layer; this layer is a ${layer.type}`);
  const preset = resolvePreset(id, { ...options, ...(isText ? { text: true } : {}) });
  if (!preset) return null;
  const customText = preset.id === "custom-text";
  const maskText = isText && preset.id === "mask";
  const visualEffect = EFFECT_PRESET_DEFINITIONS[preset.id];
  return { id: animationId, name: presetAnimationName(preset),
    start, duration: visualEffect?.duration ?? (customText || maskText ? 0.5 : PRESET_SECONDS[preset.id] ?? 0.8),
    easing: presetEasing(preset),
    unit: customText || maskText ? "letters" : "layer", stagger: customText ? 0.13 : maskText ? 0.15 : 0, order: "forward", preset,
    ...(isText ? { textAnchor: "layer" } : {}), ...(maskText ? { textClip: true, smoothing: "ease-out" } : {}),
    ...presetValues(preset, presetLayerGeometry(layer, options.document, options.fonts)) };
}

// The arrow shows the way the layer (or a wipe's edge) moves. A direction names the entrance's
// movement into place and an exit reverses it, so an exit's arrow points the other way: a slide
// out with direction up moves down and is "Slide Out ↓".
const ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };

export function presetAnimationName(preset, { directionArrow = false } = {}) {
  const given = preset.parameters?.direction;
  const way = preset.mode === "in" || directionArrow ? given : OPPOSITE[given];
  const arrow = ARROWS[way];
  return `${PRESET_DEFINITIONS[preset.id].name} ${preset.mode === "in" ? "In" : "Out"}${arrow ? ` ${arrow}` : ""}`;
}

// A name kino gave the preset, so a preset change may give it the new one. Exits saved before
// their arrow showed the movement have the direction's arrow ("Slide Out ↑" for direction up).
function isPresetName(name, preset) {
  return name === presetAnimationName(preset) || name === presetAnimationName(preset, { directionArrow: true });
}

// The fields a preset works out itself: a preset change replaces kind, from, to and discrete
// and removes motionPath, anchor and fromCurrent, so a patch never sends them with a preset.
export const PRESET_MADE_FIELDS = Object.freeze(["from", "to", "kind", "discrete", "motionPath", "anchor", "fromCurrent"]);

/** Apply editor and MCP patches identically. Timing/easing edits keep generated values. */
export function patchPresetAnimation(animation, patch, layer, { document, fonts } = {}) {
  // A keyed animation saves its first and last key as from and to (model.js readAnimationKeys).
  if (animation.keys && patch.keys === undefined && (Object.hasOwn(patch, "from") || Object.hasOwn(patch, "to")))
    throw new TypeError("This animation has keys, and its from and to are the first and last key: change keys, or send keys:null to use from and to");
  const next = { ...animation, ...patch, id: animation.id };
  // A new duration stretches a ramp's seconds with it (a behavior sent with it is kept as sent).
  if (animation.behavior && Object.hasOwn(patch, "duration") && !Object.hasOwn(patch, "behavior"))
    next.behavior = retimeBehavior(animation.behavior, animation.duration, patch.duration);
  if (patch.preset === null) { delete next.preset; return next; }
  if (Object.hasOwn(patch, "preset")) {
    let supplied = record(patch.preset, "preset");
    onlyKeys(supplied, ["id", "mode", "parameters", "text"], "preset");
    if (supplied.parameters !== undefined) record(supplied.parameters, "preset.parameters");
    // A kind of "in" or "out" next to a preset is its mode, unless a mode that disagrees is sent.
    const kindMode = ["in", "out"].includes(patch.kind) ? patch.kind : undefined;
    if (kindMode && supplied.mode !== undefined && supplied.mode !== kindMode)
      throw new TypeError(`kind "${kindMode}" and preset.mode "${supplied.mode}" disagree: send one of them`);
    if (kindMode) supplied = { ...supplied, mode: kindMode };
    // {preset:{parameters:{distance:50}}, to:{y:100}} saved the preset's own to in place of the
    // one sent. Either one is kept whole: the preset alone, or the values without preset.
    const made = PRESET_MADE_FIELDS.filter((key) => Object.hasOwn(patch, key) && !(key === "kind" && kindMode));
    if (made.length)
      throw new TypeError(`A preset works out ${made.join(", ")} itself, so they would be lost: send preset without ${made.join(", ")}, or ${made.join(", ")} without preset (which makes it a plain animation)`);
    // Setting from or to makes a preset a plain animation: it has no preset to take settings from.
    if (!supplied.id && !animation.preset)
      throw new TypeError("This animation is not a preset (setting its from or to made it a plain animation): give preset an id, such as {id:\"slide\", parameters:{direction:\"up\"}}");
    const same = !supplied.id || supplied.id === animation.preset?.id;
    const preset = normalizePreset({ ...(same ? animation.preset : {}), ...supplied,
      parameters: { ...(same ? animation.preset?.parameters : {}), ...(supplied.parameters ?? {}) } });
    next.preset = preset;
    if (!same && (isEffectPreset(preset) || isEffectPreset(animation.preset)) && !Object.hasOwn(patch, "easing")) {
      next.easing = presetEasing(preset);
      if (!Object.hasOwn(patch, "intensity")) delete next.intensity;
    } else if (!Object.hasOwn(patch, "easing") && animation.preset && preset.mode !== animation.preset.mode &&
        animation.easing === presetEasing(animation.preset)) {
      // An entrance turned exit (or back) with the default easing takes the new mode's default.
      next.easing = presetEasing(preset);
    }
    if (!Object.hasOwn(patch, "name") && animation.preset && isPresetName(animation.name, animation.preset))
      next.name = presetAnimationName(preset);
    delete next.discrete;
    delete next.motionPath;
    delete next.anchor;
    delete next.fromCurrent;
    Object.assign(next, presetValues(preset, presetLayerGeometry(layer, document, fonts)));
  } else if (animation.preset && ["from", "to", "kind", "discrete", "motionPath"].some((key) => Object.hasOwn(patch, key))) {
    delete next.preset;
  }
  return next;
}

export function normalizeDiscrete(value, keys) {
  record(value, "discrete");
  if (keys.some((key) => key !== "opacity")) throw new TypeError("Discrete transitions animate opacity only");
  if (value.type === "instant") { onlyKeys(value, ["type"], "discrete"); return { type: "instant" }; }
  if (value.type !== "blink") throw new TypeError("Discrete type must be instant or blink");
  onlyKeys(value, ["type", "count"], "discrete");
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > 20) throw new RangeError("Blink count must be an integer from 1 to 20");
  return { type: "blink", count: value.count };
}

export function discreteProgress(discrete, progress) {
  if (!discrete) return progress;
  if (discrete.type === "instant" || progress >= 1) return 1;
  // Arithmetic at an exact switch can land one ulp below its integer phase.
  return Math.floor(Math.max(0, progress) * (2 * discrete.count + 1) + 1e-12) % 2;
}

export function catalogEntries(layer) {
  if (!layer || layer.type === "audio") return [];
  const preset = (id, name, group, parameters) => ({ id, name, group, tab: "presets", ...(parameters ? { parameters } : {}) });
  const entries = [preset(layer.type === "text" ? "preset-custom-text" : "custom", "Custom", "Custom"), preset("appear", "Appear", "Basic"), preset("preset-fade", "Fade", "Basic"),
    ...PRESET_DIRECTIONS.map((direction) => preset(`slide-${direction}`, `Slide ${direction}`, "Slide")),
    preset("mask-up", "Mask up", "Mask"), preset("mask-down", "Mask down", "Mask"),
    preset("preset-grow", "Grow", "Scale"), preset("preset-shrink", "Shrink", "Scale"),
    preset("preset-blur", "Blur", "Blur"), preset("blur-slide", "Blur & Slide up", "Blur"),
    ...["dissolve", "wipe", "pixel", "pixel-wipe", "luma-reveal", "blink", "glitch", "barrel", "film-roll"]
      .map((id) => preset(id === "wipe" || id === "blink" ? id : `preset-${id}`, PRESET_DEFINITIONS[id].name, "Effects"))];
  const custom = [
    ["move", "Move", "Transform"], ["scale", "Scale", "Transform"], ["rotate", "Rotate", "Transform"], ["tilt", "Tilt 3D", "Transform"],
    ["opacity", "Opacity", "Style"], ["color", "Color", "Style", FILL_LAYER_TYPES], ["shadow", "Shadow", "Style"],
    ["blur", "Layer Blur", "Effects"], ["background-blur", "Background Blur", "Effects"], ["glass", "Glass", "Effects"],
    ["change-text", "Change Text", "Text", ["text"]],
    ["letter-spacing", "Letter Spacing", "Text", ["text"]], ["line-height", "Line Height", "Text", ["text"]], ["counter", "Counter", "Text", ["text"]],
    ["hide", "Hide", "Other"], ["show", "Show", "Other"], ["resize", "Resize", "Other"],
    ["stroke", "Stroke", "Other", [...STROKE_LAYER_TYPES]], ["trim", "Trim Paths", "Shape", ["rectangle", "ellipse", "star", "path"]], ["corners", "Corner Radius", "Other", [...CORNER_LAYER_TYPES]],
    ["arc", "Arc", "Shape", ["ellipse"]], ["star-shape", "Star", "Shape", ["star"]],
    ["repeat", "Repeater", "Shape", ["rectangle", "ellipse", "star", "path", "text", "group"]],
  ];
  for (const [id, name, group, types] of custom) {
    if (types && !types.includes(layer.type)) continue;
    if (id === "resize" && !resizableSides(layer).width && !resizableSides(layer).height) continue;
    entries.push({ id, name, group, tab: "custom", ...(id === "counter" && counterTextProblem(layer.text) ? { disabledReason: counterTextProblem(layer.text) } : {}) });
  }
  return entries;
}
