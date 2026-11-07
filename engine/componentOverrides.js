// Component overrides: an instance's own changes to the layers of its main component.
//
// A main component is a scene with isComponent: true, and an instance is a layer of type
// "component" that draws that scene (linkedComponents.js). An instance can change a few
// properties of the layers it draws (swap an image, tweak a text, change a color) without
// changing the main component. Those changes are the instance's `componentOverrides`:
//
//   "componentOverrides": {
//     "title": { "text": "Hello", "fill": "#ff0000" },
//     "card/photo": { "src": "/api/media/….png" }
//   }
//
// Each key is a component path: the IDs of source layers, joined with "/". The first ID names a
// layer of the instance's main component. When that layer is itself an instance (a nested
// component), the next ID names a layer of *its* main component, and so on: every ID except the
// last names a "component" layer. Groups are not part of a path (a layer inside a group is named
// by its own ID). Layer IDs never contain "/", so a path is never ambiguous.
//
// Every property an override does not name follows the main component live: changing the main
// component's fill still changes an instance whose text is overridden. The field is left out
// when the instance has no overrides.
//
// The data-to-screen flow:
// 1. parseDocument (model.js) checks every instance's overrides with normalizeComponentOverrides
//    once all scenes are read: broken data is refused, and overrides that no longer mean
//    anything (the layer was deleted, the value is the main component's own) are dropped.
// 2. When an instance is drawn, linkedComponents.js applies them to the main component's layers
//    with applyComponentOverrides before it copies those layers, one level of nesting at a time
//    (overridesUnder, mergeOverrides). The canvas, PNG, video, GIF, Lottie and batch exports all
//    draw through that one resolver.
// 3. apply_operations (operations.js) edits them with set_component_overrides and
//    reset_component_overrides, through componentOverridesWithPatch and componentOverridesWithout.
// 4. overrideReferences lists the media files and fonts the overrides use, so the server allows
//    and remembers that media and the editor loads those fonts.
//
// This module is plain functions over plain objects and imports nothing from model.js.
import { FILL_LAYER_TYPES } from "./paints.js";
import { BACKDROP_STYLE_KEYS } from "./backdropStyles.js";
import { shiftAnimation } from "./animationShift.js";
import { boxStylePatch, CORNER_LAYER_TYPES, STROKE_LAYER_TYPES, effectiveBoxStyle, isLegacyStyleOverride } from "./boxStyles.js";

/** A path names at most this many layers: an instance and 16 levels of nested components. */
export const MAX_COMPONENT_PATH_SEGMENTS = 17;
export const MAX_OVERRIDES_PER_INSTANCE = 500;
export const MAX_OVERRIDES_PER_DOCUMENT = 10_000;
// The same pattern as a layer ID in model.js: letters, digits, dot, underscore, colon, hyphen.
const SEGMENT_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

// Which properties an instance may change on each type of layer. Everything else (the layer's
// ID, type, group, animations, timing, masks, non-group clipping, text sizing, scale and skew, its Play
// settings, and the size of groups, paths and nested instances) always comes from the main
// component.
const COMMON_KEYS = ["name", "visible", "x", "y", "rotation", "opacity", "blendMode", "blur", "shadow"];
const FILL_KEYS = ["fill", "fillEnabled"];
const CORNER_KEYS = ["radius", "cornerRadii"];
const SIZE_KEYS = ["width", "height"];
const SIZED_TYPES = new Set(["rectangle", "ellipse", "star", "image", "video"]);
const TEXT_KEYS = ["text", "textStyleRanges", "fontFamily", "fontSource", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "verticalAlign", "textCase"];
// mediaSourceDuration (the file's length) only goes with a new src.
const IMAGE_KEYS = ["src", "mediaSourceDuration"];
const SOUND_KEYS = ["volume"];
const LAYER_TYPES = ["rectangle", "ellipse", "star", "text", "image", "video", "path", "group", "audio", "component"];

function keysFor(type) {
  return Object.freeze([
    ...COMMON_KEYS,
    ...(type !== "audio" ? BACKDROP_STYLE_KEYS : []),
    ...(FILL_LAYER_TYPES.includes(type) ? FILL_KEYS : []),
    ...(STROKE_LAYER_TYPES.has(type) ? ["stroke", "strokeWidth", "strokeAlign"] : []),
    ...(CORNER_LAYER_TYPES.has(type) ? CORNER_KEYS : []),
    ...(type === "group" ? ["clipContent"] : []),
    ...(SIZED_TYPES.has(type) ? SIZE_KEYS : []),
    ...(type === "text" ? TEXT_KEYS : []),
    ...(type === "image" ? IMAGE_KEYS : []),
    ...(type === "video" || type === "audio" ? SOUND_KEYS : []),
  ]);
}
const KEYS_BY_TYPE = new Map(LAYER_TYPES.map((type) => [type, keysFor(type)]));

/** Every property some type of layer lets an instance override. */
export const COMPONENT_OVERRIDE_KEYS = Object.freeze([...new Set([...KEYS_BY_TYPE.values()].flat())]);

/** The properties an instance may override on `layer` (a layer of its main component). */
export function overridableKeys(layer) {
  return KEYS_BY_TYPE.get(layer?.type) ?? Object.freeze([...COMMON_KEYS]);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** The path of a layer one level further in: "card" + "photo" is "card/photo". */
export function joinComponentPath(prefix, layerId) {
  return prefix ? `${prefix}/${layerId}` : layerId;
}

/** Why `componentPath` can't be a component path, or null when its form is right. */
export function componentPathProblem(componentPath) {
  if (typeof componentPath !== "string" || componentPath === "") return "must be layer IDs joined with /";
  const segments = componentPath.split("/");
  if (segments.length > MAX_COMPONENT_PATH_SEGMENTS)
    return `names ${segments.length} layers; a path names at most ${MAX_COMPONENT_PATH_SEGMENTS}`;
  const bad = segments.find((segment) => !SEGMENT_PATTERN.test(segment));
  if (bad !== undefined)
    return `has ${bad === "" ? "an empty part" : `"${bad}"`}, which is not a layer ID (letters, numbers, dot, underscore, colon or hyphen)`;
  return null;
}

// A layer of `scene` by ID. `index` (optional) keeps a Map of each scene's layers by ID, so
// checking many paths doesn't search the same scene again and again.
function layerIn(scene, id, index) {
  if (!index) return (scene.layers ?? []).find((layer) => layer?.id === id) ?? null;
  let byId = index.get(scene);
  if (!byId) {
    byId = new Map((scene.layers ?? []).map((layer) => [layer?.id, layer]));
    index.set(scene, byId);
  }
  return byId.get(id) ?? null;
}

/**
 * Finds the layer a component path names inside `instance`. Returns null when the path doesn't
 * lead to a layer (a layer was deleted, or a part before the last isn't a component instance).
 * Otherwise returns { layer, inherited, chain }:
 *   - layer: the main component's own layer (as its scene stores it);
 *   - inherited: that layer as `instance` draws it without its own override for this path, so
 *     with the overrides of the nested instances on the way applied (the main component of
 *     "card/photo" may itself override "photo" through its instance "card");
 *   - chain: the nested instance layers on the way, outermost first.
 * `scenesById` maps scene IDs to scenes.
 */
export function resolveComponentPath(instance, scenesById, componentPath, index = null) {
  if (componentPathProblem(componentPath)) return null;
  const segments = componentPath.split("/");
  let scene = scenesById.get(instance?.componentSceneId);
  const chain = [];
  let layer = null;
  for (let position = 0; position < segments.length; position += 1) {
    if (!scene) return null;
    layer = layerIn(scene, segments[position], index);
    if (!layer) return null;
    if (position === segments.length - 1) break;
    if (layer.type !== "component") return null;
    chain.push(layer);
    scene = scenesById.get(layer.componentSceneId);
  }
  // The innermost instance applies its override first; an outer instance's value wins.
  let inherited = layer;
  for (let position = chain.length - 1; position >= 0; position -= 1) {
    const rest = segments.slice(position + 1).join("/");
    const overrides = chain[position].componentOverrides;
    if (isRecord(overrides) && Object.hasOwn(overrides, rest) && isRecord(overrides[rest]))
      inherited = applyComponentOverride(inherited, overrides[rest]);
  }
  return { layer, inherited, chain };
}

// Source replacement keeps the layer's box. Both overrides and Replace Media use this
// rule; the shared renderer fits the decoded source in that box for its media kind.
export function withReplacementSource(layer, src) {
  return { ...layer, src };
}

/**
 * `layer` with the properties of one override entry that apply to its type, or the same object
 * when nothing changes. An x or y override moves the layer's position animations by the same
 * amount, because animated x and y are absolute positions (animationShift.js): a Slide In then
 * ends at the overridden place. Other properties change only the resting value.
 */
export function applyComponentOverride(layer, entry) {
  if (!isRecord(layer) || !isRecord(entry)) return layer;
  let next = null;
  const applicable = Object.fromEntries(overridableKeys(layer).filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]]));
  const patch = boxStylePatch(layer, applicable);
  for (const key of Object.keys(patch)) {
    if (key === "mediaSourceDuration" && !Object.hasOwn(entry, "src")) continue;
    if (sameValue(patch[key], layer[key])) continue;
    if (key === "src") next = withReplacementSource(next ?? layer, patch[key]);
    else {
      next ??= { ...layer };
      next[key] = patch[key];
    }
  }
  if (!next) return layer;
  if (layer.type === "text" && next.text !== layer.text && !Object.hasOwn(patch, "textStyleRanges"))
    delete next.textStyleRanges;
  const dx = typeof next.x === "number" && typeof layer.x === "number" ? next.x - layer.x : 0;
  const dy = typeof next.y === "number" && typeof layer.y === "number" ? next.y - layer.y : 0;
  if ((dx || dy) && Array.isArray(layer.animations))
    next.animations = layer.animations.map((animation) => shiftAnimation(animation, dx, dy));
  return next;
}

/**
 * The layers of a main component with one level of overrides applied: only the entries whose
 * path is a single layer ID (deeper paths belong to nested instances; see overridesUnder).
 * Returns the same array when nothing changes, and new objects only for the layers that change,
 * so `result[i] !== layers[i]` tells which layers an override changed.
 */
export function applyComponentOverrides(layers, overrides) {
  if (!Array.isArray(layers) || !isRecord(overrides)) return layers;
  let changed = false;
  const result = layers.map((layer) => {
    if (!isRecord(layer) || typeof layer.id !== "string" || !Object.hasOwn(overrides, layer.id)) return layer;
    const next = applyComponentOverride(layer, overrides[layer.id]);
    if (next !== layer) changed = true;
    return next;
  });
  return changed ? result : layers;
}

/**
 * The overrides meant for the nested instance `layerId`, with that first ID taken off their
 * paths: { "card/photo": … } under "card" is { "photo": … }.
 */
export function overridesUnder(overrides, layerId) {
  const result = {};
  if (!isRecord(overrides)) return result;
  const prefix = `${layerId}/`;
  for (const [componentPath, entry] of Object.entries(overrides))
    if (componentPath.startsWith(prefix)) result[componentPath.slice(prefix.length)] = entry;
  return result;
}

/**
 * Two override maps for the same instance merged property by property. `outer` wins: the
 * overrides of an instance placed in another component beat the nested instance's own.
 */
export function mergeOverrides(inner, outer) {
  const result = {};
  for (const source of [inner, outer]) {
    if (!isRecord(source)) continue;
    for (const [componentPath, entry] of Object.entries(source)) {
      if (!isRecord(entry)) continue;
      result[componentPath] = Object.hasOwn(result, componentPath) ? { ...result[componentPath], ...entry } : { ...entry };
    }
  }
  return result;
}

/** True when an override map has at least one entry. */
export function hasOverrides(overrides) {
  return isRecord(overrides) && Object.keys(overrides).length > 0;
}

/**
 * Checks and cleans one instance's componentOverrides while parseDocument reads a document
 * (model.js calls it for every instance once all scenes are read, nested main components first).
 *
 * Refused, with a message that says where: a value that isn't an object; more than 500 paths on
 * one instance or 10,000 in the document; a path that isn't layer IDs joined with "/" or names
 * more than 17 layers; an entry that isn't an object or is empty; a property no layer type can
 * override (such as animations or id); and a value the layer can't have (`checkLayer` runs the
 * layer validator on the layer with the entry applied: opacity 2, a bad color, a text that is
 * too long).
 *
 * Dropped without a message, because they no longer mean anything: paths that don't lead to a
 * layer any more (the layer was deleted, or the instance now uses another main component),
 * properties that the layer's type doesn't have (text on a rectangle), values equal to what the
 * main component already shows (except a measurement tied to an overridden src), and then empty
 * entries. An instance left with no overrides has no componentOverrides field.
 *
 * `checkLayer(layer, path)` returns the validated layer or throws; `counters` is shared by every
 * instance of the document ({ entries: 0 } to start). `path` names the instance in messages.
 */
export function normalizeComponentOverrides(instance, scenesById, checkLayer, counters, path = `layer.${instance?.id}`) {
  const legacyStyles = instance.legacyStyleOverrides === true;
  delete instance.legacyStyleOverrides;
  if (!Object.hasOwn(instance, "componentOverrides")) return instance;
  const label = `${path}.componentOverrides`;
  const fail = (where, message) => {
    throw new Error(`${where}: ${message}`);
  };
  const raw = instance.componentOverrides;
  if (!isRecord(raw)) fail(label, "must be an object of component paths, each with the properties this instance overrides");
  const paths = Object.keys(raw);
  if (paths.length > MAX_OVERRIDES_PER_INSTANCE) fail(label, `cannot hold more than ${MAX_OVERRIDES_PER_INSTANCE} component paths`);
  counters.entries = (counters.entries ?? 0) + paths.length;
  if (counters.entries > MAX_OVERRIDES_PER_DOCUMENT)
    fail(label, `a document cannot hold more than ${MAX_OVERRIDES_PER_DOCUMENT} component overrides`);
  // The form of everything first, so broken data is always refused, also on stale paths.
  for (const componentPath of paths) {
    const where = `${label}[${JSON.stringify(componentPath)}]`;
    const problem = componentPathProblem(componentPath);
    if (problem) fail(where, `is not a component path: it ${problem}`);
    const entry = raw[componentPath];
    if (!isRecord(entry) || Object.keys(entry).length === 0)
      fail(where, "must be an object with at least one overridden property");
    for (const key of Object.keys(entry))
      if (!COMPONENT_OVERRIDE_KEYS.includes(key))
        fail(`${where}.${key}`, `can't be overridden on an instance; overridable properties are ${COMPONENT_OVERRIDE_KEYS.join(", ")}`);
  }
  counters.layerIndex ??= new Map();
  const result = {};
  for (const componentPath of paths) {
    const resolved = resolveComponentPath(instance, scenesById, componentPath, counters.layerIndex);
    if (!resolved) continue;
    const { inherited } = resolved;
    const entry = raw[componentPath];
    const applicable = overridableKeys(inherited).filter((key) => Object.hasOwn(entry, key) && !(legacyStyles && isLegacyStyleOverride(inherited, key)));
    if (!applicable.length) continue;
    const patch = Object.fromEntries(applicable.map((key) => [key, entry[key]]));
    const merged = { ...inherited, ...boxStylePatch(inherited, patch), animations: [] };
    if (inherited.type === "text" && merged.text !== inherited.text && !Object.hasOwn(patch, "textStyleRanges"))
      delete merged.textStyleRanges;
    const checked = checkLayer(merged, `${label}[${JSON.stringify(componentPath)}]`);
    const kept = {};
    const inheritedStyle = effectiveBoxStyle(inherited);
    for (const key of applicable) {
      const activates = boxStylePatch(inherited, { [key]: checked[key] }).inactiveBoxStyles;
      if (!sameValue(checked[key], inheritedStyle[key]) || activates !== undefined)
        kept[key] = checked[key];
    }
    // The measurement belongs to this source, even when it happens to equal the base's.
    // Keeping zero also prevents a later base-source edit from assigning another GIF's length.
    if (Object.hasOwn(kept, "src") && applicable.includes("mediaSourceDuration"))
      kept.mediaSourceDuration = checked.mediaSourceDuration;
    if (!Object.hasOwn(kept, "src")) delete kept.mediaSourceDuration;
    if (Object.keys(kept).length) result[componentPath] = kept;
  }
  if (Object.keys(result).length) instance.componentOverrides = result;
  else delete instance.componentOverrides;
  return instance;
}

/**
 * Overrides with every layer ID in their paths renamed, for a paste that gave a main component's
 * layers new IDs. `sceneId` is the instance's main component, `scenesById` the scenes the paths
 * were written for (their old IDs), and `idMaps` maps a scene ID to that scene's old → new layer
 * IDs; a scene without a map keeps its IDs (it was linked to a main component already in the
 * file), and so does everything inside it, because its nested instances are that file's own.
 * A part that no longer leads anywhere is kept as it is (parseDocument then drops it).
 */
export function remapComponentOverrides(overrides, sceneId, scenesById, idMaps) {
  if (!isRecord(overrides)) return overrides;
  const result = {};
  for (const [componentPath, entry] of Object.entries(overrides)) {
    let scene = scenesById.get(sceneId) ?? null;
    const segments = componentPath.split("/").map((segment) => {
      const ids = scene ? idMaps.get(scene.id) : null;
      if (!ids) {
        scene = null;
        return segment;
      }
      const layer = layerIn(scene, segment);
      scene = layer?.type === "component" ? scenesById.get(layer.componentSceneId) ?? null : null;
      return ids.get(segment) ?? segment;
    });
    result[segments.join("/")] = structuredClone(entry);
  }
  return result;
}

const REFERENCE_KEYS = ["src", "fontSource", "fontFamily", "fontStyle", "fontWeight", "textStyleRanges"];

/**
 * The media and fonts that the overrides of instances among `layers` use, as partial layers
 * { type, name, src, fontSource, fontFamily, fontStyle, fontWeight, mediaSourceDuration }: each one
 * is the overridden layer as that instance draws it, so a text whose family alone is overridden
 * still names its weight and style. `scenes` are the scenes the instances' paths lead through.
 * A path that leads nowhere still lists the src and font file it names, so access checks see them.
 */
export function overrideReferences(layers, scenes) {
  const scenesById = new Map((Array.isArray(scenes) ? scenes : []).filter(isRecord).map((scene) => [scene.id, scene]));
  const index = new Map();
  const found = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer?.type !== "component" || !isRecord(layer.componentOverrides)) continue;
    for (const [componentPath, entry] of Object.entries(layer.componentOverrides)) {
      if (!isRecord(entry) || !REFERENCE_KEYS.some((key) => Object.hasOwn(entry, key))) continue;
      const resolved = resolveComponentPath(layer, scenesById, componentPath, index);
      const drawn = resolved ? applyComponentOverride(resolved.inherited, entry) : {
        type: undefined, src: entry.src, fontSource: entry.fontSource, textStyleRanges: entry.textStyleRanges,
      };
      found.push({
        type: drawn.type,
        name: drawn.name,
        src: drawn.src,
        fontSource: drawn.fontSource,
        fontFamily: drawn.fontFamily,
        fontStyle: drawn.fontStyle,
        fontWeight: drawn.fontWeight,
        ...(drawn.textStyleRanges?.length ? { text: drawn.text, textCase: drawn.textCase, textStyleRanges: drawn.textStyleRanges } : {}),
        mediaSourceDuration: drawn.mediaSourceDuration,
      });
    }
  }
  return found;
}

/** overrideReferences for every instance in a document. */
export function overrideReferenceLayers(document) {
  const scenes = Array.isArray(document?.scenes) ? document.scenes : [];
  return overrideReferences(scenes.flatMap((scene) => (Array.isArray(scene?.layers) ? scene.layers : [])), scenes);
}

/**
 * The overrides of `instance` after set_component_overrides: `patch` maps component paths to the
 * properties to set. With `replace` true the result is exactly `patch`; otherwise each entry is
 * merged into the instance's entry for that path, property by property. Throws a message that
 * says what to fix for a path that doesn't lead to a layer of the main component, an entry that
 * isn't an object with properties, a property that layer can't override, and mediaSourceDuration
 * without src. Values are checked when the document is parsed afterwards.
 */
export function componentOverridesWithPatch(instance, scenesById, patch, { replace = false } = {}) {
  const what = "set_component_overrides";
  if (instance?.type !== "component") throw new Error(`${what} needs layerId: the ID of a component instance.`);
  if (!isRecord(patch))
    throw new Error(`${what} needs overrides: an object that maps component paths (source layer IDs of the main component joined with "/") to the properties to override, such as { "title": { "text": "Hello" } }.`);
  if (typeof replace !== "boolean") throw new Error(`${what} replace must be true or false.`);
  const paths = Object.keys(patch);
  if (paths.length > MAX_OVERRIDES_PER_INSTANCE) throw new Error(`${what} can set at most ${MAX_OVERRIDES_PER_INSTANCE} component paths at once.`);
  const source = scenesById.get(instance.componentSceneId);
  const result = replace || !isRecord(instance.componentOverrides) ? {} : structuredClone(instance.componentOverrides);
  for (const componentPath of paths) {
    const problem = componentPathProblem(componentPath);
    if (problem) throw new Error(`${what}: "${componentPath}" is not a component path: it ${problem}.`);
    const resolved = resolveComponentPath(instance, scenesById, componentPath);
    if (!resolved)
      throw new Error(`${what}: no layer at component path "${componentPath}" in the main component ${source ? `"${source.name}" (${source.id})` : instance.componentSceneId}. A path lists source layer IDs from the main component scene joined with "/", going through nested instances (groups are not part of it).`);
    const entry = patch[componentPath];
    if (!isRecord(entry) || Object.keys(entry).length === 0)
      throw new Error(`${what}: the overrides for "${componentPath}" must be an object with at least one property.`);
    const allowed = overridableKeys(resolved.layer);
    for (const key of Object.keys(entry))
      if (!allowed.includes(key))
        throw new Error(`${what}: "${key}" can't be overridden on the ${resolved.layer.type} layer "${componentPath}". It can override ${allowed.join(", ")}.`);
    const next = Object.hasOwn(result, componentPath) ? { ...result[componentPath], ...structuredClone(entry) } : structuredClone(entry);
    if (Object.hasOwn(next, "mediaSourceDuration") && !Object.hasOwn(next, "src"))
      throw new Error(`${what}: mediaSourceDuration can only be overridden together with src on "${componentPath}".`);
    result[componentPath] = next;
  }
  return result;
}

/**
 * The overrides without the listed component paths, and without every deeper path under them
 * ("card" also resets "card/photo"). `componentPaths` null resets everything.
 */
export function componentOverridesWithout(overrides, componentPaths = null) {
  if (!isRecord(overrides) || componentPaths === null) return {};
  const result = {};
  for (const [componentPath, entry] of Object.entries(overrides)) {
    const reset = componentPaths.some((item) => componentPath === item || componentPath.startsWith(`${item}/`));
    if (!reset) result[componentPath] = entry;
  }
  return result;
}

/** The overrides without some properties of one path's entry (src also takes mediaSourceDuration). */
export function componentOverridesWithoutKeys(overrides, componentPath, keys) {
  if (!isRecord(overrides) || !Object.hasOwn(overrides, componentPath) || !isRecord(overrides[componentPath])) return isRecord(overrides) ? { ...overrides } : {};
  const removed = new Set(keys);
  if (removed.has("src")) removed.add("mediaSourceDuration");
  const entry = Object.fromEntries(Object.entries(overrides[componentPath]).filter(([key]) => !removed.has(key)));
  const result = { ...overrides };
  if (Object.keys(entry).length) result[componentPath] = entry;
  else delete result[componentPath];
  return result;
}
