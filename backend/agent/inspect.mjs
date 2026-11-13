// `inspect`: full details for at most 10 layers or animations. A layer lists only the fields
// that differ from a new layer of its type, then one line per animation. Targets are names,
// short codes, or selectors:
//   text                      every text layer
//   text[fontSize>40]         text layers with fontSize over 40
//   *[name~=title]            any layer whose name contains "title"
//   animation[kind=in]        animations whose kind is "in"
//   s2 rectangle              rectangles in scene s2
//   msg-*, msg-2.*            layers by a name pattern, or the animations of those layers
// Comparisons: = != > < >= <= ~= (contains). `fields` limits the answer to those keys, with
// their exact JSON values (null for a field that is not set). A name that is not a field at all
// is said so, with the closest field names, instead of printing null as if it were unset.
import { createLayer } from "../../engine/model.js";
import { COUNTER_FORBIDDEN_FIELDS } from "../../engine/counter.js";
import { EFFECT_ANIMATION_FIELDS } from "../../engine/effects/animation.js";
import { TEXT_EFFECT_FIELDS } from "../../engine/textChange.js";
import { TIMED_ANIMATION_FIELDS } from "../../engine/visibilityOps.js";
import { LAYER_PROPERTY_NAMES } from "./translate.mjs";
import { animationLong, labelled, layerAnimations, refName } from "./describe.mjs";
import { isLayerFieldAlias, layerFieldAliases, layerFieldPair } from "./common-mistakes.mjs";
import { closest, ReferenceError } from "./refs.mjs";

export const MAX_INSPECT = 10;
const MAX_NAMED = 200;
const LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path", "text", "image", "video", "audio", "group", "component", "script"]);
const SELECTOR = /^(?:(\S+)\s+)?([a-z*]*)((?:\[[^\]]+\])*)$/i;
const CONDITION = /\[\s*([a-zA-Z.]+)\s*(!=|>=|<=|~=|=|>|<)\s*([^\]]*?)\s*\]/g;

// Every field a layer or an animation can have (engine/model.js normalizeAnimation, the effect,
// change-text and counter kinds).
const LAYER_FIELDS = new Set(["id", "type", "parentId", "animations", ...LAYER_PROPERTY_NAMES]);
const ANIMATION_FIELDS = new Set([...EFFECT_ANIMATION_FIELDS, ...TIMED_ANIMATION_FIELDS, ...COUNTER_FORBIDDEN_FIELDS, ...TEXT_EFFECT_FIELDS,
  "preset", "animations", "anchor", "motionPath", "fromCurrent", "discrete", "shadowChannels", "step", "in", "out", "text", "overlap"]);

/**
 * Whether inspect knows `key` as a field: a field of a layer or an animation, or a name edit
 * reads as one (color, size, position), alone or with a path after it (size.width, from.x). The
 * kino command line asks, to tell a field from a layer's name in `fields=x, tagline`.
 */
export function isInspectField(key) {
  const [first] = String(key).trim().split(".");
  return LAYER_FIELDS.has(first) || ANIMATION_FIELDS.has(first) || isLayerFieldAlias(first);
}
/** The layer and animation field names, to find the one a word that is not a field is close to. */
export const inspectFieldNames = () => [...new Set([...LAYER_FIELDS, ...ANIMATION_FIELDS])];
/** Whether `key` is one field an edit of a layer (or an animation) sets: not a path, an id or the animation list. */
export function editableField(kind, key) {
  if (!key || key.includes(".") || ["id", "type", "parentId", "animations"].includes(key)) return false;
  return kind === "animation" ? ANIMATION_FIELDS.has(key) : LAYER_FIELDS.has(key) || isLayerFieldAlias(key);
}

const defaultsCache = new Map();
function defaultsFor(type) {
  if (!defaultsCache.has(type)) {
    try { defaultsCache.set(type, createLayer(type)); } catch { defaultsCache.set(type, {}); }
  }
  return defaultsCache.get(type);
}

function readPath(object, key) {
  return key.split(".").reduce((value, part) => (value == null ? undefined : value[part]), object);
}

function matches(object, conditions) {
  return conditions.every(({ key, operator, value }) => {
    const actual = readPath(object, key);
    const number = Number(value);
    const numeric = typeof actual === "number" && value !== "" && Number.isFinite(number);
    const text = value.replace(/^["']|["']$/g, "");
    switch (operator) {
      case "=": return numeric ? actual === number : String(actual) === text;
      case "!=": return numeric ? actual !== number : String(actual) !== text;
      case ">": return numeric && actual > number;
      case "<": return numeric && actual < number;
      case ">=": return numeric && actual >= number;
      case "<=": return numeric && actual <= number;
      case "~=": return String(actual ?? "").toLowerCase().includes(text.toLowerCase());
      default: return false;
    }
  });
}

function parseSelector(target) {
  const match = SELECTOR.exec(target.trim());
  if (!match) return null;
  const [, sceneRef, kind, conditionText] = match;
  // "[x>=0]" is any layer with x 0 or more.
  if (!kind && !conditionText) return null;
  const lower = kind.toLowerCase() || "*";
  if (!(lower === "*" || lower === "layer" || lower === "animation" || LAYER_TYPES.has(lower))) return null;
  // A bare word like "title" is a name, not a selector; only known kinds or [conditions] make one.
  const conditions = [...conditionText.matchAll(CONDITION)].map(([, key, operator, value]) => ({ key, operator, value }));
  return { sceneRef, kind: lower, conditions, bracketed: Boolean(conditionText) };
}

// A name with * or ? in it ("msg-*", "a*", "msg-2.*"): the layers whose name or ID matches, or,
// with a dot, the animations of the matching layers whose kind or name matches the part after it.
function globMatches(resolver, target) {
  if (!/[*?]/.test(target) || /[[\s]/.test(target)) return null;
  const { objects } = resolver;
  const regex = (pattern) => new RegExp(`^${pattern.replace(/[.+^$()|[\]{}\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  const dot = target.lastIndexOf(".");
  const layerGlob = regex(dot > 0 ? target.slice(0, dot) : target);
  const layerMatches = (entry) => layerGlob.test(entry.id) || layerGlob.test(String(entry.layer.name ?? ""));
  if (dot <= 0) return objects.layers.filter(layerMatches).map((entry) => ({ kind: "layer", entry }));
  const jobGlob = regex(target.slice(dot + 1));
  const layers = new Set(objects.layers.filter(layerMatches).map((entry) => entry.id));
  return objects.animations
    .filter((entry) => layers.has(entry.layer?.id) && entry.parents.length === 0 && [entry.animation.kind, entry.animation.name, entry.animation.effect].some((word) => word && jobGlob.test(String(word))))
    .map((entry) => ({ kind: "animation", entry }));
}

const rounded = (value) => (typeof value === "number" && !Number.isInteger(value) ? Number(value.toFixed(3)) : value);
// A video layer's subject boxes (mark_subject) can be 600: inspect counts them, look source draws them.
function subjectBoxesText(value) {
  const boxes = Array.isArray(value?.boxes) ? value.boxes : [];
  const shown = (seconds) => Number(Number(seconds).toFixed(2));
  const span = boxes.length ? ` at file ${shown(boxes[0].at)}${boxes.length > 1 ? `–${shown(boxes.at(-1).at)}` : ""} s` : "";
  return `subjectBoxes: ${boxes.length} agent ${boxes.length === 1 ? "box" : "boxes"}${span} (look {mode:"source"} draws them)`;
}
function fieldText(key, value) {
  if (key === "subjectBoxes" && value) return subjectBoxesText(value);
  if (value && typeof value === "object") return `${key} ${JSON.stringify(value)}`;
  return `${key} ${JSON.stringify(rounded(value))}`;
}

// One `fields` line: the field's JSON value, or null when it is not set. A name edit reads as
// another layer field (color and colour are fill, font is fontFamily, trimStart is mediaOffset)
// gives that field and its value. A name that is not a field of a layer (or an animation) has no
// line: it goes in `unknown` (name -> {what, best}, the closest field names), which inspect
// answers once in one line, not once a layer.
function fieldLine(object, key, known, what, layerType, unknown) {
  const value = readPath(object, key);
  const [first, ...rest] = key.split(".");
  if (value !== undefined || Object.hasOwn(object, first) || known.has(first)) return fieldText(key, value ?? null);
  const shown = (fields) => fields.map((field) => fieldText(field, readPath(object, field) ?? null)).join(" · ");
  // position is x and y, size width and height, scale scaleX and scaleY, as edit reads them, on
  // text too: position.x is x, size.width width, scale.x scaleX. Only one number for size on a
  // text layer is another field (its fontSize).
  const pair = what === "a layer" ? layerFieldPair(first, layerType) : null;
  if (pair && rest.length) {
    if (!Object.hasOwn(pair.parts, rest[0])) {
      const [a, b] = Object.keys(pair.parts);
      return `${key}: ${first} is ${pair.fields.join(" and ")} (${first}.${a}, ${first}.${b}), not ${rest[0]}.`;
    }
    const field = [pair.parts[rest[0]], ...rest.slice(1)].join(".");
    return `${key}: the field is ${pair.parts[rest[0]]}. ${fieldText(field, readPath(object, field) ?? null)}`;
  }
  if (pair) {
    const other = pair.number.filter((field) => !pair.fields.includes(field));
    if (other.length)
      return `${key}: on a text layer one number is ${other.join(" and ")} and two are ${pair.fields.join(" and ")}. ${shown([...other, ...pair.fields])}`;
    return `${key}: the fields are ${pair.fields.join(" and ")}${pair.number.length ? "; one number sets both" : ""}. ${shown(pair.fields)}`;
  }
  const aliases = what === "a layer" ? layerFieldAliases(first, layerType) : [];
  if (aliases.length === 1) {
    const field = [aliases[0], ...rest].join(".");
    return `${key}: the field is ${aliases[0]}. ${fieldText(field, readPath(object, field) ?? null)}`;
  }
  if (!unknown.has(key)) unknown.set(key, { what, best: closest(first, [...known, ...Object.keys(object)].filter((name) => name !== "animations")) });
  return null;
}

// The one line for the names in `fields` that are no field: "fontsize: not a layer field. Did you
// mean fontSize, fontStyle?" for one, "not layer fields: trimEnd (mediaDuration?), foo" for more.
function unknownLines(unknown) {
  const byWhat = new Map();
  for (const [key, { what, best }] of unknown) byWhat.set(what, [...(byWhat.get(what) ?? []), { key, best }]);
  return [...byWhat].map(([what, names]) => {
    if (names.length === 1) return `${names[0].key}: not ${what} field.${names[0].best.length ? ` Did you mean ${names[0].best.join(", ")}?` : ""}`;
    return `not ${what.replace(/^an? /, "")} fields: ${names.map(({ key, best }) => `${key}${best.length ? ` (${best.join(", ")}?)` : ""}`).join(", ")}`;
  });
}

// A layer's fields that differ from a new layer of the same type.
export function layerDifferences(layer) {
  const defaults = defaultsFor(layer.type);
  const skip = new Set(["id", "type", "animations"]);
  return Object.keys(layer)
    .filter((key) => !skip.has(key) && JSON.stringify(layer[key]) !== JSON.stringify(defaults[key]))
    .map((key) => fieldText(key, layer[key]));
}

function describeLayer(entry, codes, fields, unknown) {
  const { layer, scene } = entry;
  const head = `${labelled(layer.id, codes)} ${layer.type} in ${refName(scene.id, codes)}${layer.parentId ? ` inside ${refName(layer.parentId, codes)}` : ""}`;
  if (fields?.length) return [head, ...fields.map((key) => fieldLine(layer, key, LAYER_FIELDS, "a layer", layer.type, unknown)).filter(Boolean).map((line) => `  ${line}`)].join("\n");
  const animations = layerAnimations(layer).map(({ animation, offset, depth }) => `  ${"  ".repeat(depth)}${animationLong(animation, codes, offset)}`);
  return [head, `  ${layerDifferences(layer).join(" · ") || "all fields at their defaults"}`, ...animations].join("\n");
}

function describeAnimation(entry, codes, fields, unknown) {
  const { animation, layer, scene, parents, offset } = entry;
  const owner = layer ? refName(layer.id, codes) : `${refName(scene.id, codes)} background`;
  const head = `${animationLong(animation, codes, offset)} on ${owner}${parents.length ? ` in group ${refName(parents.at(-1), codes)}` : ""}`;
  if (fields?.length) return [head, ...fields.map((key) => fieldLine(animation, key, ANIMATION_FIELDS, "an animation", undefined, unknown)).filter(Boolean).map((line) => `  ${line}`)].join("\n");
  const extra = Object.entries(animation)
    .filter(([key]) => !["id", "name", "kind", "start", "duration", "easing", "intensity", "from", "to", "unit", "stagger", "order", "preset", "animations", "enabled", "anchor"].includes(key))
    .map(([key, value]) => fieldText(key, value));
  return extra.length ? `${head}\n  ${extra.join(" · ")}` : head;
}

/**
 * Finds the targets and describes them. `resolver` comes from refs.createResolver.
 * Returns { text, count, matched, first } (first: what the first target found, { kind, name }
 * with kind layer, animation or scene, as the agent names it) and throws a ReferenceError for an
 * unknown name.
 */
export function inspectTargets(resolver, codes, { targets, fields }) {
  const { objects } = resolver;
  const picked = [];
  const seen = new Set();
  let first = null;
  const add = (kind, entry) => {
    const key = `${kind}:${entry.id}`;
    if (!seen.has(key)) { seen.add(key); picked.push({ kind, entry }); }
  };
  for (const raw of targets) {
    const target = String(raw).trim();
    const globbed = globMatches(resolver, target);
    if (globbed) {
      for (const { kind, entry } of globbed) add(kind, entry);
      if (picked.length) first ??= { kind: picked[0].kind, name: refName(picked[0].entry.id, codes) };
      continue;
    }
    const selector = parseSelector(target);
    // A bare "layer" is every layer unless something is named layer.
    const named = (name) => ["layer", "animation", "scene"].some((kind) => { try { resolver.resolve(name, kind); return true; } catch { return false; } });
    if (selector && (selector.conditions.length || selector.sceneRef || selector.kind !== "layer" || selector.bracketed || !named(target))) {
      const sceneId = selector.sceneRef ? resolver.resolve(selector.sceneRef, "scene") : null;
      if (selector.kind === "animation") {
        for (const entry of objects.animations)
          if ((!sceneId || entry.scene.id === sceneId) && matches(entry.animation, selector.conditions)) add("animation", entry);
      } else {
        for (const entry of objects.layers)
          if ((!sceneId || entry.scene.id === sceneId) && (selector.kind === "*" || selector.kind === "layer" || entry.layer.type === selector.kind) && matches(entry.layer, selector.conditions))
            add("layer", entry);
      }
      if (picked.length) first ??= { kind: picked[0].kind, name: refName(picked[0].entry.id, codes) };
      continue;
    }
    const name = target.replace(/^#/, "");
    let resolved = null;
    let ambiguous = null;
    const suggestions = [];
    for (const kind of ["layer", "animation", "scene"]) {
      try { resolved = { kind, id: resolver.resolve(name, kind) }; break; } catch (error) {
        if (error.ambiguous) ambiguous ??= error;
        suggestions.push(...(error.suggestions ?? []));
      }
    }
    // "dot2.custom" when dot2 has two custom animations: say which is which, as edit does.
    if (!resolved && ambiguous) throw ambiguous;
    // Not a layer, animation or scene: suggest the closest names of all three kinds.
    if (!resolved) {
      const best = closest(name, suggestions);
      throw new ReferenceError(`No layer, animation or scene "${name}".${best.length ? ` Did you mean ${best.join(", ")}?` : ""}`, { ref: name, kind: "layer", suggestions: best });
    }
    first ??= { kind: resolved.kind, name: refName(resolved.id, codes) };
    if (resolved.kind === "scene") {
      for (const entry of objects.layers) if (entry.scene.id === resolved.id) add("layer", entry);
      continue;
    }
    const list = resolved.kind === "layer" ? objects.layers : objects.animations;
    add(resolved.kind, list.find((entry) => entry.id === resolved.id));
  }
  const shown = picked.slice(0, MAX_INSPECT);
  const unknown = new Map();
  const parts = shown.map(({ kind, entry }) => (kind === "layer" ? describeLayer(entry, codes, fields, unknown) : describeAnimation(entry, codes, fields, unknown)));
  parts.push(...unknownLines(unknown));
  if (picked.length > MAX_INSPECT)
    // Every other match by name (up to MAX_NAMED), so one inspect "*" lists a whole scene's
    // layers: a script that rebuilds a section needs them all, and names are short.
    parts.push(`+${picked.length - MAX_INSPECT} more matched (${picked.slice(MAX_INSPECT, MAX_INSPECT + MAX_NAMED).map(({ entry }) => refName(entry.id, codes)).join(", ")}${picked.length > MAX_INSPECT + MAX_NAMED ? ", …" : ""}); narrow the selector or name them.`);
  if (!picked.length) parts.push("Nothing matched.");
  return { text: parts.join("\n"), count: shown.length, matched: picked.length, first };
}
