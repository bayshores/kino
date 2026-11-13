import { patchTextLayer } from "./textStyleEdits.js";
import { scriptPatch } from "./scriptLayer.js";
// Editing several selected layers at once in the Design tab.
//
// With several layers selected, the inspector shows the property fields shared across all of them,
// and a value typed there goes to every selected layer.
//
// How the data flows:
// 1. App.jsx passes the selected layers to the Inspector.
// 2. The Inspector asks sharedSections() which sections every selected layer has, and
//    sharedValue() / numberFieldState() what each field shows: the value all the layers share,
//    or "Mixed" when they differ.
// 3. Editing a field calls App.jsx changeLayers(edit). An edit is either a patch such as
//    { fill: "#ff0000" } that every layer gets, or a function that works out each layer's own
//    patch (numberEdit below does this for every number field).
// 4. editLayers() applies the edit to every selected layer that can take it, and App.jsx commits
//    the result as one undo step.

import { defaultFonts } from "./fonts.js";
import { resizeGroup } from "./groupResize.js";
import { MAX_PLAY_TIME, playFieldPatch } from "./mediaPlay.js";
import { hasMediaPlay } from "./playback.js";
import { MEDIA_TIMING_TYPES } from "./mediaTime.js";
import { resizeTextLayer } from "./textLayout.js";
import { sizeFieldPatch } from "./transformMath.js";
import { LETTER_SPACING_LIMIT } from "./letterSpacing.js";
import { DEFAULT_LINE_HEIGHT, LINE_HEIGHT_FIELD } from "./lineHeight.js";
import { boxStylePatch, CORNER_LAYER_TYPES, effectiveBoxStyle, STROKE_LAYER_TYPES } from "./boxStyles.js";
import { FILL_LAYER_TYPES as FILL_TYPE_LIST } from "./paints.js";

/** Layer types with a Fill section (the same list the single-layer Design tab uses). */
export const FILL_LAYER_TYPES = new Set(FILL_TYPE_LIST);
/** Layer types with a Stroke section. */
export { STROKE_LAYER_TYPES };

/**
 * What a field's `read` returns for a layer whose own value can't be shown as one value, such
 * as a rectangle with different corner radii in the single Corner radius field. A field with
 * such a layer in the selection shows "Mixed".
 */
export const MIXED = Symbol("mixed");

const VISUAL = (layer) => layer.type !== "audio";
const SIZED = (layer) => layer.type !== "audio" && layer.type !== "component";
const ofTypes = (...types) => (layer) => types.includes(layer.type);
const TEXT_PROPERTIES = [
  "text", "textStyleRanges", "fontFamily", "fontSource", "fontSize", "fontWeight", "fontStyle", "lineHeight",
  "letterSpacing", "textAlign", "verticalAlign", "textResize", "textCase", "kerning", "ligatures",
];

// The layers each property means something for. Other selected layers keep their value, so a
// component instance keeps its main component's size, an audio layer gets no position, and a
// text layer gets no corner radius. Properties not listed here (name, visible, locked) apply to
// every layer.
const PROPERTY_LAYERS = {
  x: VISUAL, y: VISUAL, rotation: VISUAL, scaleX: VISUAL, scaleY: VISUAL, skewX: VISUAL,
  opacity: VISUAL, blur: VISUAL, shadow: VISUAL, blendMode: VISUAL, isMask: VISUAL, maskInvert: VISUAL, maskMode: VISUAL,
  width: SIZED, height: SIZED, lockAspect: SIZED,
  fill: (layer) => FILL_LAYER_TYPES.has(layer.type),
  fillEnabled: (layer) => FILL_LAYER_TYPES.has(layer.type),
  stroke: (layer) => STROKE_LAYER_TYPES.has(layer.type),
  strokeWidth: (layer) => STROKE_LAYER_TYPES.has(layer.type),
  strokeAlign: (layer) => STROKE_LAYER_TYPES.has(layer.type) && layer.type !== "text",
  radius: (layer) => CORNER_LAYER_TYPES.has(layer.type),
  cornerRadii: (layer) => CORNER_LAYER_TYPES.has(layer.type),
  donut: ofTypes("ellipse"), sweep: ofTypes("ellipse"), startAngle: ofTypes("ellipse"),
  spikes: ofTypes("star"), starThickness: ofTypes("star"),
  path: ofTypes("path"),
  clipContent: ofTypes("component", "group"),
  isMaskGroup: ofTypes("group"),
  componentStart: ofTypes("component"), componentVisibility: ofTypes("component"),
  mediaStart: hasMediaPlay, mediaDuration: hasMediaPlay, mediaOffset: hasMediaPlay,
  mediaFreeze: hasMediaPlay, volume: ofTypes("video", "audio"), lowpass: ofTypes("video", "audio"),
  voiceCleanup: ofTypes("video", "audio"), morphIn: ofTypes("video"), log: ofTypes("video"),
  // Clip speed (mediaSpeed, mediaReverse, …) only on the layer types that play a file at a speed.
  ...Object.fromEntries(Object.entries(MEDIA_TIMING_TYPES).map(([key, types]) => [key, ofTypes(...types)])),
  ...Object.fromEntries(TEXT_PROPERTIES.map((key) => [key, ofTypes("text")])),
};
// What a layer is and where it sits are never changed by a property edit.
const PROTECTED = new Set(["id", "type", "parentId", "componentSceneId", "src"]);

/** True when an Inspector edit of `key` may change this layer (see PROPERTY_LAYERS). */
export function canEditProperty(layer, key) {
  if (PROTECTED.has(key)) return false;
  const test = PROPERTY_LAYERS[key];
  return test ? test(layer) : true;
}

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
// Number fields show four decimals, so values that look the same in the field count as shared.
const shown = (value) => (typeof value === "number" ? Math.round(value * 10000) / 10000 : value);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What one field shows for several layers: { value, mixed }. `value` is what every layer gives
 * `read`; when any two layers differ, or `read` returns MIXED for one of them, it is
 * { value: null, mixed: true }. Objects such as paints and shadows are compared by content.
 */
export function sharedValue(layers, read) {
  if (!layers.length) return { value: null, mixed: false };
  const values = layers.map((layer) => read(effectiveBoxStyle(layer)));
  if (values.some((value) => value === MIXED)) return { value: null, mixed: true };
  const first = shown(values[0]);
  return values.every((value) => sameValue(shown(value), first))
    ? { value: values[0], mixed: false }
    : { value: null, mixed: true };
}

// A component instance is drawn at its main component's size.
function layerSize(layer, scenes = []) {
  if (layer.type === "component") {
    const source = scenes.find((scene) => scene.id === layer.componentSceneId);
    if (source) return { width: source.width, height: source.height };
  }
  return { width: layer.width, height: layer.height };
}

// A rectangle's corner radius as one number, or MIXED when its corners differ.
function uniformRadius(layer) {
  layer = effectiveBoxStyle(layer);
  const radii = Array.isArray(layer.cornerRadii) && layer.cornerRadii.length === 4 ? layer.cornerRadii : null;
  if (radii && radii.some((radius) => radius !== radii[0])) return MIXED;
  return radii ? radii[0] : finite(layer.radius);
}

const paintAngle = (key) => ({
  read: (layer) => (layer[key]?.type === "linear" ? finite(layer[key].angle) : MIXED),
  write: (angle, layer) => ({ [key]: { ...layer[key], angle } }),
  applies: (layer) => layer[key]?.type === "linear",
  min: -36000, max: 36000,
});
const shadowNumber = (key, min, max) => ({
  read: (layer) => (layer.shadow ? finite(layer.shadow[key]) : MIXED),
  write: (value, layer) => ({ shadow: { ...layer.shadow, [key]: value } }),
  applies: (layer) => Boolean(layer.shadow),
  min, max,
});
const playNumber = (key, read, toStored = (value) => value) => ({
  read,
  // playFieldPatch keeps each layer's Play range inside its own source file and the time limit.
  write: (value, layer) => playFieldPatch(layer, key, toStored(value)),
  applies: (layer) => canEditProperty(layer, key),
  min: 0,
});
const percent = (key, fallback, min, max) => ({
  read: (layer) => finite(layer[key] ?? fallback) * 100,
  write: (value) => ({ [key]: value / 100 }),
  min, max,
});
const plain = (key, min, max, extra = {}) => ({
  read: (layer) => layer[key],
  write: (value) => ({ [key]: value }),
  min, max, ...extra,
});

/**
 * Every number field of the multi-layer Design panel. For one layer, `read` gives the number
 * the field shows (in the field's own units: percent for opacity, degrees for rotation) and
 * `write` the values to save for a number typed there. `applies` (default: every layer that
 * can take the written properties) says which layers the field changes. `min` and `max` are
 * the field's limits in its own units; `round` keeps whole numbers.
 */
export const NUMBER_FIELDS = {
  x: plain("x", -1000000, 1000000),
  y: plain("y", -1000000, 1000000),
  // A layer with its aspect-ratio lock on also gets the other side that keeps its proportions.
  width: {
    ...plain("width", 0.001, 65536),
    read: (layer, { scenes } = {}) => layerSize(layer, scenes).width,
    write: (width, layer) => sizeFieldPatch(layer, "width", width),
  },
  height: {
    ...plain("height", 0.001, 65536),
    read: (layer, { scenes } = {}) => layerSize(layer, scenes).height,
    write: (height, layer) => sizeFieldPatch(layer, "height", height),
  },
  rotation: plain("rotation", -360000, 360000),
  opacity: percent("opacity", 1, 0, 100),
  scaleX: plain("scaleX", -1000, 1000),
  scaleY: plain("scaleY", -1000, 1000),
  // One Scale field (percent) for both directions, as a component instance's Design tab has.
  scale: {
    read: (layer) => (layer.scaleX === layer.scaleY ? finite(layer.scaleX, 1) * 100 : MIXED),
    write: (value) => ({ scaleX: value / 100, scaleY: value / 100 }),
    min: 0.01, max: 100000,
  },
  radius: {
    read: uniformRadius,
    write: (radius) => ({ radius, cornerRadii: null }),
    min: 0, max: 65536,
  },
  strokeWidth: plain("strokeWidth", 0.1, 10000),
  fillAngle: paintAngle("fill"),
  strokeAngle: paintAngle("stroke"),
  donut: percent("donut", 0, 0, 100),
  sweep: percent("sweep", 1, 0, 100),
  startAngle: { ...plain("startAngle", -360000, 360000), read: (layer) => finite(layer.startAngle) },
  spikes: { ...plain("spikes", 0, 1000, { round: true }), read: (layer) => finite(layer.spikes ?? 5) },
  starThickness: percent("starThickness", 0.382, 0, 100),
  fontWeight: plain("fontWeight", 1, 1000),
  fontSize: plain("fontSize", 0.1, 10000),
  lineHeight: percent("lineHeight", DEFAULT_LINE_HEIGHT, LINE_HEIGHT_FIELD.min, LINE_HEIGHT_FIELD.max),
  // Percent of each layer's own font size (letterSpacing.js), so one value suits every size.
  letterSpacing: plain("letterSpacing", -LETTER_SPACING_LIMIT, LETTER_SPACING_LIMIT),
  blur: plain("blur", 0, 1000),
  shadowX: shadowNumber("x", -1000000, 1000000),
  shadowY: shadowNumber("y", -1000000, 1000000),
  shadowBlur: shadowNumber("blur", 0, 10000),
  mediaStart: { ...playNumber("mediaStart", (layer) => finite(layer.mediaStart)), max: MAX_PLAY_TIME },
  mediaOffset: playNumber("mediaOffset", (layer) => finite(layer.mediaOffset)),
  // null: Play lasts until the source ends (a stored duration of 0).
  mediaDuration: { ...playNumber("mediaDuration", (layer) => (layer.mediaDuration > 0 ? layer.mediaDuration : null)), max: MAX_PLAY_TIME },
  volume: { ...playNumber("volume", (layer) => finite(layer.volume, 1) * 100, (value) => value / 100), max: 100 },
};

/** "solid", "linear" or "radial": the kind of paint a fill or stroke is. */
function paintType(paint) {
  return paint && typeof paint === "object" ? paint.type || "solid" : "solid";
}

/**
 * What a Fill or Stroke control shows for the paint at `key`: { paint, type, mixed }. When every
 * layer has the same paint, `paint` is it. Otherwise `mixed` is true, and `type` is the kind of
 * paint they all have, or null when the kinds differ too.
 */
export function paintState(layers, key) {
  const paint = sharedValue(layers, (layer) => layer[key]);
  if (!paint.mixed) return { paint: paint.value, type: paintType(paint.value), mixed: false };
  const type = sharedValue(layers, (layer) => paintType(layer[key]));
  return { paint: null, type: type.mixed ? null : type.value, mixed: true };
}

/** The part of `patch` this layer can take (see canEditProperty), or null when nothing is left. */
export function editablePatch(layer, patch) {
  if (!patch || typeof patch !== "object") return null;
  const entries = Object.entries(patch).filter(([key]) => canEditProperty(layer, key));
  return entries.length ? Object.fromEntries(entries) : null;
}

// How deep a layer sits in groups: 0 at the scene's top level.
function depthOf(byId, layer) {
  let depth = 0;
  const visited = new Set([layer.id]);
  for (let parent = byId.get(layer.parentId); parent && !visited.has(parent.id); parent = byId.get(parent.parentId)) {
    visited.add(parent.id);
    depth += 1;
  }
  return depth;
}

// The changes ({ id, ...values }) that giving `layer` the values in `patch` makes, the same way
// the single-layer Design tab does (App.jsx changeLayer).
function layerChanges(layers, layer, patch, { scenes, fonts }) {
  // A group's width and height resize the layers inside it in proportion, as a corner drag does.
  if (layer.type === "group" && (Object.hasOwn(patch, "width") || Object.hasOwn(patch, "height"))) {
    const inside = resizeGroup(layers, layer.id, { ...layer, ...patch }, { scenes, fonts });
    return [{ id: layer.id, ...patch }, ...inside];
  }
  if (layer.type !== "text") return [{ id: layer.id, ...patch }];
  const proposed = patchTextLayer(layer, patch);
  if (["fontFamily", "fontStyle", "fontWeight"].some((key) => Object.hasOwn(patch, key))) {
    // A family without the layer's style (say, no italic) switches to a style it has.
    if (Object.hasOwn(patch, "fontFamily")) {
      const faces = fonts.entries().filter((face) => face.family === patch.fontFamily);
      if (faces.length && !faces.some((face) => face.style === proposed.fontStyle)) proposed.fontStyle = faces[0].style;
    }
    proposed.fontSource = fonts.resolve(proposed).src || "";
  }
  // Typing a width turns fluid-width text into a wrapping box; typing a height turns automatic
  // sizing off.
  if (!Object.hasOwn(patch, "textResize")) {
    if (Object.hasOwn(patch, "height")) proposed.textResize = "fixed";
    else if (Object.hasOwn(patch, "width") && layer.textResize === "width-height") proposed.textResize = "height";
  }
  return [resizeTextLayer(proposed, fonts)];
}

/**
 * Applies one Inspector edit to the layers `ids` of a scene and returns the scene's new list of
 * layers; `layers` is not changed. `edit` is a patch for every layer, or a function
 * (layer, { scenes, layers }) => patch | null that gives each layer its own. Each layer gets only
 * the properties it can take (canEditProperty). Groups are changed before the layers inside
 * them, so a selected layer's own new size wins over its group's resize. `scenes` (the
 * document's scenes) gives component instances their size, and `fonts` measures text. Returns
 * `layers` itself when nothing changes, and throws, changing nothing, when a layer can't take
 * the edit (for example a group whose rotated contents can't stretch unevenly).
 */
export function editLayers(layers, ids, edit, { scenes = [], fonts = defaultFonts } = {}) {
  const selected = new Set(ids);
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const order = layers
    .filter((layer) => selected.has(layer.id))
    .map((layer) => ({ id: layer.id, depth: depthOf(byId, layer) }))
    .sort((a, b) => a.depth - b.depth);
  let next = layers;
  for (const { id } of order) {
    const layer = next.find((item) => item.id === id);
    const displayedLayer = effectiveBoxStyle(layer);
    const displayedLayers = next.map(effectiveBoxStyle);
    const requested = typeof edit === "function"
      ? edit(displayedLayer, { scenes, layers: displayedLayers })
      : edit;
    const patch = boxStylePatch(layer, editablePatch(layer, requested));
    if (!patch || (Object.entries(patch).every(([key, value]) => sameValue(layer[key], value)) &&
        !layer.textStyleRanges?.some((range) => Object.keys(patch).some((key) => Object.hasOwn(range.style, key))))) continue;
    const changes = new Map(layerChanges(next, layer, patch, { scenes, fonts }).map((change) => [change.id, change]));
    next = next.map((item) => (changes.has(item.id) ? { ...item, ...changes.get(item.id), id: item.id, type: item.type } : item));
  }
  return next;
}

// What an agent's update_layers operation can't change: what a layer is and where it sits
// (move_layers changes a layer's group), and its animations, which have their own operations.
const NOT_SHARED_PROPERTIES = new Set([...PROTECTED, "animations"]);
// Play settings in the order they are kept inside each layer's source: a new offset can shorten
// the duration, and the latest start depends on the duration (mediaPlay.js playFieldPatch).
const PLAY_SETTINGS = ["mediaOffset", "mediaDuration", "mediaStart", "mediaFreeze", "volume"];
const PLAY_NUMBERS = new Set(["mediaOffset", "mediaDuration", "mediaStart", "volume"]);

/**
 * The edit (for editLayers) of an agent's update_layers operation, so an agent changes several
 * layers the same way the Design tab does with several layers selected. `layers` are the listed
 * layers and `properties` the stored values to give them (opacity 0 to 1, not percent). Each
 * layer takes only the properties it has (canEditProperty), and Play settings stay inside each
 * layer's own source as the Play fields keep them; a mediaDuration of 0 ("until the source
 * ends") is kept as given. editLayers then resizes the layers inside a group and refits text.
 * Throws when `properties` is empty, names a property update_layers can't change, names one
 * that none of the listed layers has (such as fontSize for rectangles only), or gives a Play
 * setting that isn't a number.
 */
export function updateLayersEdit(layers, properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !Object.keys(properties).length)
    throw new Error('update_layers needs properties: an object of layer properties, such as { "opacity": 0.5 }.');
  const keys = Object.keys(properties);
  const refused = keys.filter((key) => NOT_SHARED_PROPERTIES.has(key));
  if (refused.length)
    throw new Error(`update_layers can't change ${refused.join(", ")}. Use move_layers to change a layer's group, and the animation operations for animations.`);
  for (const key of keys) {
    if (!layers.some((layer) => canEditProperty(layer, key)))
      throw new Error(`None of the listed layers has ${key}.`);
    if (PLAY_NUMBERS.has(key) && !Number.isFinite(properties[key]))
      throw new Error(`update_layers ${key} must be a number.`);
  }
  return (layer) => {
    // A script layer's values merge into its current ones, as update_layer does.
    const own = editablePatch(layer, properties);
    const patch = own && scriptPatch(layer, own);
    if (!patch) return null;
    for (const key of PLAY_SETTINGS) {
      if (!Object.hasOwn(patch, key) || (key === "mediaDuration" && properties[key] === 0)) continue;
      Object.assign(patch, playFieldPatch({ ...layer, ...patch }, key, properties[key]));
    }
    return patch;
  };
}
