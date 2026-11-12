// The mistakes agents make most often on their first try, and what happens to each.
//
// A mistake whose meaning is clear is fixed here and named in the receipt's `fixed` list, so the
// agent learns the right form without spending a turn: a nested add_layer {layer:{…}}, a layer
// type such as "shape", an op such as add_text, a color:"#fff" on a layer, "48px", "2s",
// opacity 50, an animation without kind, or a property preset ("move") given the values to
// reach. A mistake whose meaning is not clear is refused with one short op that works
// (`example`), built from what the agent sent where possible.
//
// translate.mjs calls these before it renames short fields and resolves names:
// - reshapeOperation(raw): op names and add_layer shapes, and one op for several layers
// - fixOperation(operation): add_animation, update_scene, set_font, a missing layer, …
// - fixLayerProperties(properties): property names, units and words such as "bold"
// - timeFromText, gradientFromCss, bezierFromCss: values inside any operation
import { PRESETS, presetAnimation } from "../../engine/animation.js";
import { PRESET_DEFINITIONS, PRESET_MADE_FIELDS, resolvePreset } from "../../engine/presetCatalog.js";
import { createLayer } from "../../engine/model.js";
import { EFFECTS, isUnchangedAtOne, relativeSetting, unchangedAtOneWords } from "../../engine/effects/catalog.js";
import { seenNames } from "./seen-names.mjs";
import { EFFECT_ANIMATION_FIELDS } from "../../engine/effects/animation.js";
import { COUNTER_FORBIDDEN_FIELDS } from "../../engine/counter.js";
import { TEXT_EFFECT_FIELDS } from "../../engine/textChange.js";
import { TIMED_ANIMATION_FIELDS } from "../../engine/visibilityOps.js";
import { closest, nearMiss } from "./refs.mjs";
import { isRecord } from "../../engine/numbers.js";

export const LAYER_TYPES = Object.freeze(["rectangle", "ellipse", "star", "path", "text", "image", "video", "audio", "group"]);

/** An Error with the op that works instead, which the refusal sends as `example`. */
export function mistake(message, example, suggestions) {
  return Object.assign(new Error(message), { example, ...(suggestions?.length ? { suggestions } : {}) });
}

const quote = (value) => JSON.stringify(value);

// ---- op names and shapes --------------------------------------------------------------------
// Op names agents guess, and the op (and layer type) each stands for.
const OP_ALIASES = {
  add_text: ["add_layer", "text"], add_title: ["add_layer", "text"], add_label: ["add_layer", "text"],
  add_rectangle: ["add_layer", "rectangle"], add_rect: ["add_layer", "rectangle"], add_box: ["add_layer", "rectangle"],
  add_shape: ["add_layer", "rectangle"], add_square: ["add_layer", "rectangle"],
  add_ellipse: ["add_layer", "ellipse"], add_circle: ["add_layer", "ellipse"], add_oval: ["add_layer", "ellipse"],
  add_star: ["add_layer", "star"], add_path: ["add_layer", "path"], add_line: ["add_layer", "path"],
  add_image: ["add_layer", "image"], add_picture: ["add_layer", "image"], add_photo: ["add_layer", "image"], add_logo: ["add_layer", "image"],
  add_video: ["add_layer", "video"], add_audio: ["add_layer", "audio"], add_music: ["add_layer", "audio"], add_sound: ["add_layer", "audio"],
  add_group: ["add_layer", "group"], create_layer: ["add_layer"], new_layer: ["add_layer"],
  animate: ["add_animation"], add_anim: ["add_animation"], create_animation: ["add_animation"],
  edit_layer: ["update_layer"], modify_layer: ["update_layer"], change_layer: ["update_layer"], set_layer: ["update_layer"],
  set_text: ["update_layer"], update_text: ["update_layer"], edit_text: ["update_layer"],
  remove_layer: ["delete_layer"], delete_layers: ["delete_layer"], remove_layers: ["delete_layer"],
  edit_animation: ["update_animation"], modify_animation: ["update_animation"], remove_animation: ["delete_animation"],
  create_scene: ["add_scene"], new_scene: ["add_scene"], remove_scene: ["delete_scene"], edit_scene: ["update_scene"],
  cutout: ["cut_out"], remove_background: ["cut_out"], remove_bg: ["cut_out"], isolate_subject: ["cut_out"],
  generate_captions: ["add_captions"], auto_captions: ["add_captions"], add_subtitles: ["add_captions"], set_scene: ["update_scene"],
  duplicate_layer: ["duplicate_layers"], duplicate: ["duplicate_layers"], copy_layer: ["duplicate_layers"],
};

// Words agents use for a layer type.
const TYPE_WORDS = {
  rectangle: ["rect", "box", "square", "shape", "card", "panel", "block", "bar", "button", "background", "bg"],
  ellipse: ["circle", "oval", "dot", "ring", "disc", "disk"],
  text: ["txt", "textbox", "label", "title", "heading", "caption", "paragraph", "string"],
  image: ["img", "picture", "photo", "logo", "icon", "bitmap", "png", "jpg", "jpeg", "gif"],
  video: ["movie", "clip", "mp4", "film"],
  audio: ["sound", "music", "voice", "mp3", "wav", "song", "track"],
  group: ["frame", "container", "folder"],
  path: ["line", "vector", "curve", "bezier", "polyline"],
  star: ["polygon"],
};
const TYPE_BY_WORD = new Map(Object.entries(TYPE_WORDS).flatMap(([type, words]) => [[type, type], ...words.map((word) => [word, type])]));

/** The layer type a word stands for ("shape" → rectangle), or null. */
export function layerTypeFromWord(word) {
  return typeof word === "string" ? TYPE_BY_WORD.get(word.trim().toLowerCase()) ?? null : null;
}

// The layer type a media file's extension suggests.
function typeFromSource(src) {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(src ?? ""))?.[1]?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic"].includes(extension)) return "image";
  if (["mp4", "mov", "webm", "m4v", "mkv"].includes(extension)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"].includes(extension)) return "audio";
  return null;
}

// Ops that take one layer; given a list of layers, they become one op per layer.
const ONE_LAYER_OPS = new Set(["delete_layer", "add_animation", "convert_to_shape", "outline_text", "ungroup_layer", "remove_mask", "detach_component"]);
// Ops whose layers are a list.
const LIST_OPS = new Set(["place", "align", "distribute", "stack", "fit", "duplicate_layers", "multi_transform", "apply_text_effect",
  "copy_layers", "copy_animations", "update_layers", "set_layer_flags", "align_layers", "group_layers", "create_mask", "move_layers"]);

/**
 * The op a guessed name stands for, for `library {topic:"op", name}`: addLayer → add_layer,
 * add_text → add_layer (layerType text), move or fade (animation presets) → add_animation.
 * Returns {type, layerType?, preset?} or null.
 */
export function opFromWord(word, knownOps = []) {
  if (typeof word !== "string" || knownOps.includes(word)) return null;
  const snake = word.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_");
  if (OP_ALIASES[snake]) return { type: OP_ALIASES[snake][0], layerType: OP_ALIASES[snake][1] };
  if (knownOps.includes(snake)) return { type: snake };
  const preset = isPreset(word) ? { preset: word } : presetFromWord(word);
  return preset ? { type: "add_animation", preset: preset.preset } : null;
}

/**
 * Fixes the shape of one operation before anything else reads it. Returns the operation, or a
 * list of operations when one op was sent for several layers. Never throws.
 */
export function reshapeOperation(raw, fixes, knownOps = []) {
  if (!isRecord(raw)) return raw;
  let operation = { ...raw };
  const key = operation.op !== undefined ? "op" : "type";
  const name = operation[key];
  if (typeof name === "string" && !knownOps.includes(name)) {
    // addLayer, "add-layer" and "Add Layer" are add_layer.
    const snake = name.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_");
    const alias = OP_ALIASES[snake];
    if (alias) {
      operation[key] = alias[0];
      const layerType = alias[1];
      if (layerType && operation.layerType === undefined && (key === "type" || operation.type === undefined)) operation.layerType = layerType;
      fixes.push(`op ${name} → ${alias[0]}${layerType ? ` (layerType ${layerType})` : ""}`);
    } else if (snake !== name && knownOps.includes(snake)) {
      operation[key] = snake;
      fixes.push(`op ${name} → ${snake}`);
    }
    // move_layer {x, y} moves the layer on the canvas: that is update_layer.
    if (operation[key] === "move_layer" && ["x", "y", "properties"].some((field) => operation[field] !== undefined)) {
      operation[key] = "update_layer";
      fixes.push("op move_layer → update_layer");
    }
  }
  const type = operation.op ?? operation.type;
  if (type === "add_layer") operation = reshapeAddLayer(operation, fixes);
  if (type === "update_layer" && Array.isArray(operation.layers ?? operation.layerIds) && operation.layer === undefined && operation.layerId === undefined) {
    operation[operation.op !== undefined ? "op" : "type"] = "update_layers";
    fixes.push("update_layer with layers → update_layers");
  }
  // place {layer:"logo"}: ops that take a list of layers take a list of one.
  if (LIST_OPS.has(type) && typeof operation.layer === "string" && operation.layers === undefined && operation.layerIds === undefined) {
    operation.layers = [operation.layer];
    delete operation.layer;
    fixes.push("layer → layers [ … ]");
  }
  const list = operation.layers ?? operation.layerIds;
  if (ONE_LAYER_OPS.has(type) && Array.isArray(list) && list.length > 0 && operation.layer === undefined && operation.layerId === undefined
    && !(type === "add_animation" && (operation.id !== undefined || operation.animation?.id !== undefined))) {
    const { layers, layerIds, ...rest } = operation;
    fixes.push(`${type} {layers:[${list.length}]} → ${list.length} ${type} ops`);
    return list.map((layer) => ({ ...rest, layer }));
  }
  return operation;
}

function reshapeAddLayer(raw, fixes) {
  let operation = raw;
  // {op:"add_layer", layer:{type, name, properties}}: the layer's fields belong to the op.
  if (isRecord(operation.layer)) {
    const { layer, ...rest } = operation;
    const { type, layerType, properties, animations, ...fields } = layer;
    operation = { ...fields, ...rest };
    if (layerType ?? type) operation.layerType ??= layerType ?? type;
    if (properties !== undefined) operation.properties = { ...(isRecord(properties) ? properties : {}), ...(operation.properties ?? {}) };
    if (animations !== undefined && operation.animations === undefined) operation.animations = animations;
    fixes.push("layer:{…} → add_layer fields");
  } else if (typeof operation.layer === "string" && operation.name === undefined && operation.properties?.name === undefined) {
    // On add_layer, layer:"title" names the new layer.
    operation = { ...operation, name: operation.layer };
    delete operation.layer;
    fixes.push("layer → name");
  }
  // {op:"add_layer", type:"rect"}: here type is the layer type.
  if (operation.op !== undefined && operation.type !== undefined && operation.type !== operation.op && operation.layerType === undefined) {
    const word = layerTypeFromWord(operation.type);
    if (word) {
      operation = { ...operation, layerType: operation.type };
      delete operation.type;
      fixes.push("type → layerType");
    }
  }
  const word = layerTypeFromWord(operation.layerType);
  if (word && word !== operation.layerType) {
    fixes.push(`layerType ${quote(operation.layerType)} → ${word}`);
    operation = { ...operation, layerType: word };
  }
  // animations: {…} is a list of one; animation: {…} is the same.
  if (isRecord(operation.animations)) {
    operation = { ...operation, animations: [operation.animations] };
    fixes.push("animations {…} → [{…}]");
  }
  if (isRecord(operation.animation) && operation.animations === undefined) {
    const { animation, ...rest } = operation;
    operation = { ...rest, animations: [animation] };
    fixes.push("animation → animations [ … ]");
  }
  return operation;
}

// ---- layer properties -----------------------------------------------------------------------
const SAMPLE_LAYER = createLayer("rectangle");
// Layer fields that hold a number, such as x, fontSize and opacity.
const NUMBER_FIELDS = new Set(Object.keys(SAMPLE_LAYER).filter((key) => typeof SAMPLE_LAYER[key] === "number"));
const FONT_WEIGHTS = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
const TEXT_ALIGN = { middle: "center", centre: "center", centered: "center", centred: "center", mid: "center", start: "left", end: "right" };
const VERTICAL_ALIGN = { center: "middle", centre: "middle", centered: "middle", start: "top", end: "bottom" };
// Other names for layer fields: [the agent's name, the field, which layers (null: any)]. Each
// "color" name is also taken spelled "colour" (colour, textColour, …).
const COLOR_ALIASES = [
  ["color", "fill", null], ["textColor", "fill", null], ["fontColor", "fill", null], ["fillColor", "fill", null],
  ["backgroundColor", "fill", "shape"], ["bgColor", "fill", "shape"],
  ["borderColor", "stroke", null], ["strokeColor", "stroke", null]];
const PROPERTY_ALIASES = [
  ...COLOR_ALIASES, ...COLOR_ALIASES.map(([alias, field, which]) => [alias.replace("olor", "olour"), field, which]),
  ["borderWidth", "strokeWidth", null],
  // A rectangle's font or align draws nothing (and align there more likely means align_layers):
  // these are read only on text layers, and refused on others with what to send instead.
  ["font", "fontFamily", "text"], ["fontName", "fontFamily", "text"], ["family", "fontFamily", "text"], ["fontface", "fontFamily", "text"],
  ["weight", "fontWeight", "text"], ["align", "textAlign", "text"], ["textAlignment", "textAlign", "text"], ["lineSpacing", "lineHeight", "text"],
  ["content", "text", "text"], ["value", "text", "text"], ["label", "text", "text"], ["string", "text", "text"],
  ["angle", "rotation", null], ["rotate", "rotation", null], ["alpha", "opacity", null],
  // CSS and canvas words for the top-left corner (left 200 was "Did you mean text, log, axes?").
  ["left", "x", null], ["top", "y", null],
  ["url", "src", "media"], ["source", "src", "media"], ["file", "src", "media"], ["image", "src", "media"],
  // Play, in other editors' words: where in the file it starts (mediaOffset, file seconds), when
  // in the scene it starts (mediaStart, scene seconds) and how long it plays (mediaDuration).
  ["trimStart", "mediaOffset", "media"], ["trimIn", "mediaOffset", "media"], ["inPoint", "mediaOffset", "media"],
  ["sourceStart", "mediaOffset", "media"], ["sourceOffset", "mediaOffset", "media"], ["startFrom", "mediaOffset", "media"],
  ["startTime", "mediaStart", "media"], ["playStart", "mediaStart", "media"],
  ["playDuration", "mediaDuration", "media"], ["clipDuration", "mediaDuration", "media"],
];
const SHAPES = new Set(["rectangle", "ellipse", "star", "path"]);
const MEDIA = new Set(["image", "video", "audio"]);
const aliasFits = (which, layerType) => which === null || layerType === undefined
  || (which === "shape" ? SHAPES.has(layerType) : which === "media" ? MEDIA.has(layerType) : which === layerType);

// Names edit splits into two layer fields (fixLayerProperties), and the names of their parts in
// a {…} value: position [x, y] or {x, y} is x and y, scale [x, y] or {x, y} is scaleX and scaleY,
// and so on. One number: size on a text layer is its fontSize, and scale sets both.
const PAIR_ALIASES = {
  position: { fields: ["x", "y"], parts: { x: "x", y: "y" } },
  size: { fields: ["width", "height"], parts: { width: "width", height: "height" } },
  dimensions: { fields: ["width", "height"], parts: { width: "width", height: "height" } },
  scale: { fields: ["scaleX", "scaleY"], parts: { x: "scaleX", y: "scaleY", scaleX: "scaleX", scaleY: "scaleY" } },
};

/**
 * How edit reads `name` when it stands for two layer fields, or null: `fields` are the two
 * (size → [width, height]); `parts` maps each name a {…} value or inspect's name.part may use to
 * its field (size.width → width, scale.x → scaleX); `number` is what one number sets on a layer
 * of `layerType` (size on text → [fontSize], scale → [scaleX, scaleY]), empty when it is refused.
 * inspect's `fields` uses it, so name.part points where edit does.
 */
export function layerFieldPair(name, layerType) {
  if (!Object.hasOwn(PAIR_ALIASES, name)) return null;
  const { fields, parts } = PAIR_ALIASES[name];
  const number = name === "scale" ? fields : name === "size" && layerType === "text" ? ["fontSize"] : [];
  return { fields, parts, number };
}

/**
 * The layer fields another name stands for on a layer of `layerType`, as edit reads it:
 * color, colour → [fill]; font → [fontFamily]; position → [x, y]; size → [width, height] (see
 * layerFieldPair for one number). Empty when it is no other name. inspect's `fields` uses it, so
 * it points where edit does.
 */
export function layerFieldAliases(name, layerType) {
  const found = PROPERTY_ALIASES.find(([alias, , which]) => alias === name && aliasFits(which, layerType));
  if (found) return [found[1]];
  return layerFieldPair(name, layerType)?.fields ?? [];
}

/** Whether edit reads `name` as another name for a layer field on some kind of layer. */
export const isLayerFieldAlias = (name) => PROPERTY_ALIASES.some(([alias]) => alias === name) || Object.hasOwn(PAIR_ALIASES, name);

// The refusal for another name of a field that only text or media layers use, sent for a layer
// of another type: `align` on a rectangle saved textAlign, which draws nothing there.
function aliasMisfit(alias, field, which, { layerType, layerName }) {
  const kinds = which === "media" ? "image, video and audio layers" : `${which} layers`;
  const a = /^[aeiou]/.test(layerType) ? "an" : "a";
  const layer = `${layerName ? quote(layerName) : "this layer"} is ${a} ${layerType}`;
  const lineUp = field === "textAlign" ? ` To line a layer up with the scene (or several with each other), use align_layers: ${quote({ op: "align_layers", layers: [layerName ?? "<layer>"], align: "center" })}.` : "";
  const example = field === "textAlign" ? { op: "align_layers", layers: [layerName ?? "<layer>"], align: "center" } : null;
  // Without align_layers there is no op to show: the usual update_layer example sets a font size.
  return Object.assign(mistake(`${quote(alias)} is ${field}, which only ${kinds} use; ${layer}.${lineUp}`, example), example ? {} : { noExample: true });
}

/** A number of seconds written as text ("2s", "500ms", "1.5 seconds"), or null. */
export function timeFromText(value) {
  if (typeof value !== "string") return null;
  const match = /^\s*(-?\d*\.?\d+)\s*(ms|milliseconds?|s|secs?|seconds?)\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return /^m/i.test(match[2]) ? number / 1000 : number;
}

// A number written with a unit a layer field does not use ("48px", "45deg", "0.5turn").
function numberFromText(value, field) {
  if (typeof value !== "string") return null;
  const match = /^\s*(-?\d*\.?\d+)\s*(px|pt|deg|°|turns?|rad)?\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (unit.startsWith("turn")) return field === "rotation" ? number * 360 : null;
  if (unit === "rad") return field === "rotation" ? Math.round(number * 180 / Math.PI * 1000) / 1000 : null;
  return number;
}

/**
 * Fixes the names and values of layer properties in place: color → fill, "48px" → 48,
 * opacity 50 → 0.5, fontWeight "bold" → 700, position {x, y} → x and y, and so on. `scene` is
 * the operation's scene ({width, height}) when known; `layerType` the layer's type when known.
 * Throws a mistake (with an example) for a value whose meaning is not clear, such as x "50%".
 */
// /Users/…, ~/…, ./…, file://… and C:\… are files on this computer; /api/media/… and URLs are not.
const isLocalPath = (text) => /^(file:\/\/|~\/|\.\.?\/|[A-Za-z]:[\\/])/.test(text) || (text.startsWith("/") && !text.startsWith("/api/") && !text.startsWith("//"));

// The part names in a size, position or scale {…} that mean its first or second field: w and
// width, h and height (size {w:500, h:90} is width 500, height 90).
const STRAY_FIRST = /^(w|wide|width|horizontal|sx|left)$/i;
const STRAY_SECOND = /^(h|high|height|vertical|sy|top)$/i;

export function fixLayerProperties(properties, fixes, { layerType, scene, layerName, known, exampleOp } = {}) {
  if (!isRecord(properties)) return properties;
  const next = { ...properties };
  const set = (field, value, note) => {
    next[field] = value;
    fixes.push(note);
  };
  // CSS and snake_case spellings of a field: font-size, font_size, letter-spacing → fontSize, ….
  for (const key of Object.keys(next)) {
    if (!/[-_]/.test(key) || known?.has(key)) continue;
    const camel = key.toLowerCase().replace(/[-_]+([a-z0-9])/g, (_, letter) => letter.toUpperCase());
    if (camel === key || next[camel] !== undefined || !(known?.has(camel) || NUMBER_FIELDS.has(camel) || isLayerFieldAlias(camel))) continue;
    set(camel, next[key], `${key} → ${camel}`);
    delete next[key];
  }
  // "logo.png." or "/api/media/….png," (a sentence's full stop or comma): the address without it.
  if (typeof next.src === "string") {
    const trimmed = next.src.trim().replace(/[.,;:!?]+$/, "");
    if (trimmed !== next.src && (/\.[A-Za-z0-9]{2,5}$/.test(trimmed) || trimmed.startsWith("/api/media/")))
      set("src", trimmed, `src ${quote(next.src)} → ${quote(trimmed)}`);
  }
  // A file on this computer is imported first; src is the address import answers (/api/media/…).
  if (typeof next.src === "string" && isLocalPath(next.src)) {
    const file = next.src.replace(/^file:\/\//, "");
    throw mistake(`src is the address project import answers, not a file on this computer: send project {action:"import", file:${quote(file)}} first, then use the src it answers.`, null);
  }
  // Media layers draw only imported files (/api/media/…) and embedded images (data:…): a bare
  // file name or a web address would render empty. An empty src is refused in translate.mjs
  // (checkMediaSource), which says the layer needs a file.
  if (typeof next.src === "string" && next.src.trim() && MEDIA.has(layerType) && !/^(\/api\/media\/|data:)/i.test(next.src)) {
    const web = /^https?:\/\//i.test(next.src);
    throw mistake(web
      ? `src ${quote(next.src)} is on the web; kino draws only imported files. Save the file on this computer, send project {action:"import", file:"<its path>"}, then use the src it answers (/api/media/…).`
      : `src ${quote(next.src)} is not an imported file. Send project {action:"import", file:"<path to ${next.src}>"} first and use the src it answers (/api/media/…); library {topic:"media", search:${quote(next.src)}} lists files already imported.`, null);
  }
  // A star or path has no radius; its sharp corners round with roundCorners (shapeModifiers.js).
  if ((layerType === "star" || layerType === "path") && typeof next.radius === "number" && next.roundCorners === undefined) {
    set("roundCorners", next.radius, `radius → roundCorners (a ${layerType} rounds its corners with roundCorners)`);
    delete next.radius;
  }
  for (const [alias, field, which] of PROPERTY_ALIASES) {
    if (next[alias] === undefined || known?.has(alias)) continue;
    if (!aliasFits(which, layerType)) {
      if (which === "text" || which === "media") throw aliasMisfit(alias, field, which, { layerType, layerName });
      continue;
    }
    if (next[field] === undefined) set(field, next[alias], `${alias} → ${field}`);
    delete next[alias];
  }
  // position {x, y} or [x, y]; size {width, height} or [width, height]; scale {x, y} or [x, y]
  // (layerFieldPair). One number: size on text is its font size, and scale sets both.
  for (const alias of Object.keys(PAIR_ALIASES)) {
    if (next[alias] === undefined || known?.has(alias)) continue;
    const { fields: [a, b], parts, number } = layerFieldPair(alias, layerType);
    const value = next[alias];
    // The fields sent beside it with other values: {size:{width:500}, width:300} kept 300 and
    // said size was mapped. Two values for one field are refused, naming both.
    const clash = (values) => {
      const both = Object.entries(values).filter(([field, part]) => next[field] !== undefined && part !== undefined && quote(next[field]) !== quote(part));
      if (!both.length) return;
      const { [alias]: _alias, ...rest } = next;
      const names = both.map(([field, part]) => `${quote(alias)} sets ${field} ${quote(part)}, and ${field} ${quote(next[field])} was sent too`);
      const example = exampleOp?.({ ...values, ...rest });
      throw Object.assign(mistake(`${names.join("; ")}. One field takes one value, so nothing was saved: send ${both.map(([field]) => field).join(" and ")} once${example ? `, such as ${quote(example)}` : ""}.`, example ?? null), example ? {} : { noExample: true });
    };
    if (typeof value === "number" && number.length) {
      clash(Object.fromEntries(number.map((field) => [field, value])));
      for (const field of number) if (next[field] === undefined) next[field] = value;
      delete next[alias];
      fixes.push(`${alias} → ${number.join(", ")}`);
      continue;
    }
    // {w, h} named no part and was taken as "size → width, height", saving nothing.
    const stray = isRecord(value) ? Object.keys(value).filter((key) => !Object.hasOwn(parts, key)) : [];
    const values = Array.isArray(value) && value.length === 2 ? { [a]: value[0], [b]: value[1] }
      : isRecord(value) && Object.keys(value).length && !stray.length ? Object.fromEntries(Object.entries(value).map(([key, part]) => [parts[key], part])) : null;
    // size 60 on a rectangle was refused as "not a layer property. Did you mean fill, id, name?"
    if (!values) {
      const on = layerType ? ` on ${/^[aeiou]/.test(layerType) ? "an" : "a"} ${layerType}` : "";
      const both = a === "x" ? [100, 200] : alias === "scale" ? [1.2, 0.8] : [300, 120];
      const [first, second] = Object.keys(parts);
      const names = stray.map(quote);
      const strayText = stray.length ? ` ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are not parts` : `${names[0]} is not a part`} of it (${first} and ${second} are).` : "";
      // size {w:500, h:90}: the example sets the fields from the values sent (w is width, h height).
      const { [alias]: _alias, ...rest } = next;
      const mapped = Object.fromEntries(stray.map((key, index) => [STRAY_FIRST.test(key) ? a : STRAY_SECOND.test(key) ? b : stray.length === 2 ? [a, b][index] : null, value[key]])
        .filter(([field, part]) => field && typeof part === "number"));
      const example = Object.keys(mapped).length ? exampleOp?.({ ...rest, ...mapped }) : null;
      throw Object.assign(mistake(`${quote(alias)} is ${a} and ${b}${on}: give both, such as ${quote(alias)}:${quote(both)}${alias === "scale" ? " or one number for both" : ""}, or set ${a} and ${b} themselves${example ? ` (from what was sent: ${quote(mapped)})` : ""}.${strayText}${alias === "size" ? " On a text layer, one number is its fontSize." : ""}`, example ?? null), example ? {} : { noExample: true });
    }
    clash(values);
    delete next[alias];
    for (const field of [a, b]) if (values[field] !== undefined && next[field] === undefined) next[field] = values[field];
    fixes.push(`${alias} → ${a}, ${b}`);
  }
  if (next.bold !== undefined && !known?.has("bold")) {
    if (next.fontWeight === undefined) set("fontWeight", next.bold ? 700 : 400, `bold → fontWeight ${next.bold ? 700 : 400}`);
    delete next.bold;
  }
  if (next.italic !== undefined && !known?.has("italic")) {
    if (next.fontStyle === undefined) set("fontStyle", next.italic ? "italic" : "normal", `italic → fontStyle ${next.italic ? "italic" : "normal"}`);
    delete next.italic;
  }
  if (typeof next.fontWeight === "string" && FONT_WEIGHTS[next.fontWeight.toLowerCase().replace(/[\s_-]/g, "")] !== undefined) {
    const weight = FONT_WEIGHTS[next.fontWeight.toLowerCase().replace(/[\s_-]/g, "")];
    set("fontWeight", weight, `fontWeight ${quote(next.fontWeight)} → ${weight}`);
  }
  if (typeof next.textAlign === "string" && TEXT_ALIGN[next.textAlign.toLowerCase()])
    set("textAlign", TEXT_ALIGN[next.textAlign.toLowerCase()], `textAlign ${quote(next.textAlign)} → ${TEXT_ALIGN[next.textAlign.toLowerCase()]}`);
  if (typeof next.verticalAlign === "string" && VERTICAL_ALIGN[next.verticalAlign.toLowerCase()])
    set("verticalAlign", VERTICAL_ALIGN[next.verticalAlign.toLowerCase()], `verticalAlign ${quote(next.verticalAlign)} → ${VERTICAL_ALIGN[next.verticalAlign.toLowerCase()]}`);
  for (const field of Object.keys(next)) {
    if (!NUMBER_FIELDS.has(field)) continue;
    const value = next[field];
    if (typeof value === "string" && /%\s*$/.test(value)) {
      next[field] = percentValue(field, value, { scene, layerName });
      fixes.push(`${field} ${quote(value)} → ${next[field]}`);
      continue;
    }
    const number = numberFromText(value, field);
    if (number !== null) set(field, number, `${field} ${quote(value)} → ${number}`);
  }
  // A clip speed written "0.5x" or "2×".
  if (typeof next.mediaSpeed === "string" && /^\s*\d*\.?\d+\s*[x×]?\s*$/i.test(next.mediaSpeed)) {
    const speed = Number.parseFloat(next.mediaSpeed);
    set("mediaSpeed", speed, `mediaSpeed ${quote(next.mediaSpeed)} → ${speed}`);
  }
  // opacity is 0 to 1; 50 means 50 %.
  if (typeof next.opacity === "number" && next.opacity > 1 && next.opacity <= 100) set("opacity", next.opacity / 100, `opacity ${next.opacity} → ${next.opacity / 100}`);
  return next;
}

// "50%" of a field: opacity and scale are fractions, width and height a part of the scene. x and
// y are refused, because "50%" may mean the layer's left edge or its centre.
function percentValue(field, text, { scene, layerName }) {
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) throw mistake(`${field} ${quote(text)} is not a number.`, null);
  if (["opacity", "scaleX", "scaleY", "volume", "sweep", "donut"].includes(field)) return number / 100;
  const across = field === "width" || field === "x" ? scene?.width : field === "height" || field === "y" ? scene?.height : null;
  if ((field === "width" || field === "height") && across) return Math.round(across * number / 100);
  if ((field === "x" || field === "y") && across) {
    const pixels = Math.round(across * number / 100);
    throw mistake(`${field} is pixels from the scene's ${field === "x" ? "left" : "top"} edge to the layer's ${field === "x" ? "left" : "top"} edge (${number}% of this scene is ${pixels}). To center a layer, add it without ${field}, then place it:`,
      { op: "place", layers: [layerName ?? "title"], slot: "center" });
  }
  throw mistake(`${field} takes a number, not ${quote(text)}.`, null);
}

// ---- colors ---------------------------------------------------------------------------------
const byte = (value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");

/** The hex color for hsl()/hsla() text, or null. */
export function hexFromHsl(text) {
  const match = /^hsla?\(\s*(-?[\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(text.trim());
  if (!match) return null;
  const hue = ((Number(match[1]) % 360) + 360) % 360 / 360;
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const alpha = match[4] === undefined ? 1 : match[4].endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number(match[4]);
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (t) => {
    const k = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (k < 1 / 6) return p + (q - p) * 6 * k;
    if (k < 1 / 2) return q;
    if (k < 2 / 3) return p + (q - p) * (2 / 3 - k) * 6;
    return p;
  };
  return `#${byte(channel(hue + 1 / 3) * 255)}${byte(channel(hue) * 255)}${byte(channel(hue - 1 / 3) * 255)}${alpha >= 1 ? "" : byte(alpha * 255)}`;
}

const GRADIENT_EXAMPLE = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
const CSS_DIRECTIONS = { "to right": 90, "to left": 270, "to bottom": 180, "to top": 0, "to bottom right": 135, "to right bottom": 135,
  "to top right": 45, "to right top": 45, "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315 };

// Splits "a, b(c, d), e" at the top-level commas.
function splitTop(text) {
  const parts = [];
  let depth = 0, current = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * kino's gradient paint for CSS gradient text ("linear-gradient(90deg, #f00, #00f)"), or null
 * when the text is not a CSS gradient. `color` turns one CSS color into hex (or null). Throws a
 * mistake when the gradient cannot be read. kino measures a linear angle clockwise from
 * left-to-right, so CSS 90deg (to right) is 0 and CSS 180deg (to bottom) is 90.
 */
export function gradientFromCss(text, color, field = "fill") {
  const match = /^\s*(linear|radial)-gradient\((.*)\)\s*$/i.exec(text);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const parts = splitTop(match[2]);
  let angle = 0;
  const readStop = (part) => {
    const stop = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(part);
    const text = stop[1].trim();
    return { color: color(text) ?? (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(text) ? text.toLowerCase() : null), offset: stop[2] === undefined ? null : Number(stop[2]) / 100 };
  };
  if (type === "linear") {
    let cssAngle = 180; // CSS's default is "to bottom"
    const first = parts[0]?.toLowerCase().replace(/\s+/g, " ");
    const turned = /^-?[\d.]+(deg|turn|rad)?$/.test(first ?? "") ? numberFromText(first, "rotation") : null;
    if (turned !== null) { cssAngle = turned; parts.shift(); }
    else if (CSS_DIRECTIONS[first] !== undefined) { cssAngle = CSS_DIRECTIONS[first]; parts.shift(); }
    angle = (((cssAngle - 90) % 360) + 360) % 360;
  } else if (parts[0] && !readStop(parts[0]).color) parts.shift(); // "circle at center"
  const stops = parts.map(readStop);
  if (stops.length < 2 || stops.some((stop) => !stop.color))
    throw mistake(`${field} ${quote(text)}: a gradient is {type, angle, stops:[{offset, color}]} with hex colors.`, { op: "update_layer", layer: "card", properties: { [field]: GRADIENT_EXAMPLE } });
  stops.forEach((stop, index) => { stop.offset ??= Math.round(index / (stops.length - 1) * 1000) / 1000; });
  return { type, ...(type === "linear" ? { angle } : {}), stops: stops.map(({ offset, color: hex }) => ({ offset, color: hex })) };
}

/** [x1, y1, x2, y2] for CSS "cubic-bezier(a, b, c, d)", or null. */
export function bezierFromCss(text) {
  const match = /^\s*cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*$/i.exec(text);
  return match ? match.slice(1, 5).map(Number) : null;
}

// ---- animations -----------------------------------------------------------------------------
const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));
// Which layer type each property preset needs (the others work on a rectangle).
export const PRESET_LAYER = Object.freeze({ arc: "ellipse", "star-shape": "star", "letter-spacing": "text", "line-height": "text", speed: "video" });
// The values each property preset animates (move: x and y), read from the presets themselves.
export const PRESET_VALUE_KEYS = Object.freeze(Object.fromEntries(PRESETS
  .filter((preset) => preset.kind === "custom" && !["change-text", "counter"].includes(preset.id))
  .map((preset) => {
    const layer = createLayer(PRESET_LAYER[preset.id] ?? "rectangle");
    const animation = presetAnimation(preset.id, { ...layer, text: "Text" }, 0);
    return [preset.id, Object.freeze([...new Set([...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})])])];
  })));
// A value to reach for each property preset, for examples (a test checks they run).
export const PRESET_SAMPLE_TO = Object.freeze({
  move: { x: 1600 }, scale: { scaleX: 1.5, scaleY: 1.5 }, resize: { width: 800, height: 450 }, rotate: { rotation: 360 },
  opacity: { opacity: 0 }, blur: { blur: 20 }, color: { fill: "#ff5500" }, stroke: { strokeWidth: 8, stroke: "#ffffff" }, trim: { strokeEnd: 1 },
  corners: { cornerRadii: [40, 40, 40, 40] }, shadow: { shadow: { color: "#00000080", x: 0, y: 12, blur: 24 } },
  arc: { sweep: 0.5 }, "star-shape": { spikes: 8 }, "letter-spacing": { letterSpacing: 20 }, "line-height": { lineHeight: 1.6 },
  "background-blur": { backgroundBlur: { enabled: true, radius: 24 } }, glass: { glass: { enabled: true } }, speed: { speed: 0.25 },
  tilt: { rotateX: 30, rotateY: -20 }, repeat: { repeatCopies: 12 },
});
// Other names agents give those values.
const VALUE_ALIASES = { angle: "rotation", degrees: "rotation", rotate: "rotation", alpha: "opacity", color: "fill", left: "x", top: "y",
  radius: "cornerRadii", width: "width", height: "height", spacing: "letterSpacing", strokeColor: "stroke", borderWidth: "strokeWidth" };
// Catalog presets agents name in other ways.
const PRESET_WORDS = {
  fade: "preset-fade", "fade-up": "slide-up", "fade-in-up": "slide-up", "fade-in-down": "slide-down", "slide-in": "preset-slide",
  "slide-out": ["preset-slide", "out"], zoom: "preset-grow", "zoom-in": "preset-grow", "zoom-out": "shrink-out", pop: "preset-grow",
  "pop-in": "preset-grow", "scale-in": "preset-grow", "scale-up": "preset-grow", "scale-out": "shrink-out", grow: "preset-grow",
  shrink: "preset-shrink", reveal: "preset-mask", "mask-in": "preset-mask", "wipe-in": "preset-wipe", "type-on": "preset-custom-text",
  typewriter: "preset-custom-text", spin: "rotate", "spin-in": "rotate-in", appear: "preset-appear", "blur-in": "blur-in",
  // Other animation tools' and Lottie's words for a stroke drawing on (the trim preset; the move is draw-on).
  "trim-path": "trim", "trim-paths": "trim", "draw-on": "trim", "line-draw": "trim", "stroke-draw": "trim", "write-on": "trim",
  // A shape modifier's names for copies of a layer (the repeat preset).
  repeater: "repeat", "repeat-copies": "repeat", burst: "repeat",
};
const MODE_WORDS = { in: "in", out: "out", enter: "in", entrance: "in", entry: "in", intro: "in", appear: "in", show: "in",
  exit: "out", leave: "out", outro: "out", disappear: "out", hide: "out" };

function isPreset(id) {
  if (typeof id !== "string") return false;
  if (PRESET_BY_ID.has(id) || id.startsWith("effect:")) return true;
  return Boolean(catalogPreset(id));
}
// The catalog preset a name stands for, or null. preset-custom-text exists only for text
// (resolvePreset refuses it without text: true), so it is looked up as text too.
function catalogPreset(id) {
  for (const options of [{}, { text: true }]) {
    try { return resolvePreset(id, options); } catch { /* try the next */ }
  }
  return null;
}
const ALL_PRESETS = [...Object.keys(PRESET_DEFINITIONS).map((id) => `preset-${id}`), ...PRESETS.map((preset) => preset.id)];

/** The preset (and mode) a name stands for: "fadeIn" → fade-in, "fade" → preset-fade. Null if none. */
export function presetFromWord(word) {
  if (typeof word !== "string" || isPreset(word)) return null;
  const kebab = word.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[\s_]+/g, "-");
  if (isPreset(kebab)) return { preset: kebab };
  if (isPreset(`preset-${kebab}`)) return { preset: `preset-${kebab}` };
  const word2 = PRESET_WORDS[kebab];
  if (word2) return Array.isArray(word2) ? { preset: word2[0], mode: word2[1] } : { preset: word2 };
  const ending = /^(.*)-(in|out)$/.exec(kebab);
  if (ending && isPreset(`preset-${ending[1]}`)) return { preset: `preset-${ending[1]}`, mode: ending[2] };
  return null;
}

// Values of a property preset under its own names: {scale: 1.5} → {scaleX: 1.5, scaleY: 1.5}.
// A plain number is the preset's one value. Returns {values, unknown}.
function presetValues(presetId, given) {
  const keys = PRESET_VALUE_KEYS[presetId] ?? [];
  const values = {};
  const unknown = [];
  if (given === undefined || given === null) return { values, unknown };
  if (!isRecord(given)) {
    if (typeof given === "number" && presetId === "scale") return { values: { scaleX: given, scaleY: given }, unknown };
    if (typeof given === "number" && presetId === "corners") return { values: { cornerRadii: [given, given, given, given] }, unknown };
    if (keys.length === 1) return { values: { [keys[0]]: given }, unknown };
    return { values, unknown: [quote(given)] };
  }
  for (const [key, value] of Object.entries(given)) {
    if (keys.includes(key)) values[key] = value;
    else if (key === "scale" && keys.includes("scaleX")) Object.assign(values, { scaleX: value, scaleY: value });
    else if (VALUE_ALIASES[key] && keys.includes(VALUE_ALIASES[key]))
      values[VALUE_ALIASES[key]] = VALUE_ALIASES[key] === "cornerRadii" && typeof value === "number" ? [value, value, value, value] : value;
    else if (["value", "to", "amount"].includes(key) && keys.length === 1) values[keys[0]] = value;
    else unknown.push(key);
  }
  return { values, unknown };
}

// add_animation reads these fields; any other is refused, so nothing is dropped unseen.
const ANIMATION_FIELDS = new Set(["type", "sceneId", "layerId", "id", "animation", "effect", "preset", "start", "at", "mode", "parameters",
  "easing", "intensity", "unit", "stagger", "order", "orderSeed", "smoothing", "smoothingIntensity", "range", "motionPath", "shadowChannels", "fromCurrent", "textAnchor", "textClip",
  "duration", "keepStill", "from", "behavior", "anchor", "fill", "peak", "return"]);
const KINDS = ["in", "out", "custom", "hide", "show"];

const customExample = (layer, name = "Move", from = { x: 100 }, to = { x: 1600 }) =>
  ({ op: "add_animation", layer, animation: { kind: "custom", name, start: 0, duration: 1, from, to } });
const presetExample = (layer, preset = "preset-fade") => ({ op: "add_animation", layer, preset, start: 0, duration: 0.5 });

// The fields an in, out or custom animation keeps (engine/model.js normalizeAnimation). The model
// copies any other key into the saved animation and nothing reads it, so `ease`, `durration`,
// `repeat` or `yoyo` inside an animation was saved and did nothing. `ease` is easing (listed in
// fixed); any other key is refused with the closest fields.
const TIMED_FIELDS = ["id", "name", "kind", "enabled", "start", "fromCurrent", "preset", "discrete", ...TIMED_ANIMATION_FIELDS];
const TIMED_KINDS = ["in", "out", "custom"];
// The fields any kind of animation has (effects, Change text, Counter and Composed groups too).
const ANY_ANIMATION_FIELDS = [...new Set([...TIMED_FIELDS, ...EFFECT_ANIMATION_FIELDS, ...TEXT_EFFECT_FIELDS, ...COUNTER_FORBIDDEN_FIELDS,
  "animations", "step", "in", "out", "text", "overlap", "anchor", "motionPath"])];
// Words for playing an animation again: kino does it with behavior {loop} (engine/behavior.js).
const REPEAT_WORDS = new Set(["repeat", "repeats", "repeatcount", "repeatdelay", "yoyo", "loop", "loops", "iterations", "iterationcount",
  "alternate", "pingpong"]);

// ease → easing, in place (listed in fixed).
function fixEase(values, fixes, prefix) {
  if (!isRecord(values) || values.ease === undefined) return;
  if (values.easing !== undefined && quote(values.easing) !== quote(values.ease))
    throw mistake(`${prefix}ease ${quote(values.ease)} and ${prefix}easing ${quote(values.easing)} disagree: send easing only.`, null);
  values.easing ??= values.ease;
  delete values.ease;
  fixes.push(`${prefix}ease → easing`);
}

// Refuses the keys of `values` that are not in `fields`: they would be saved and do nothing.
// `what` names the thing ("a custom animation"), `example` is an op that works.
function refuseUnknownAnimationFields(values, fields, what, example) {
  const unknown = Object.keys(values).filter((key) => !fields.includes(key));
  if (!unknown.length) return;
  const repeats = unknown.filter((key) => REPEAT_WORDS.has(key.toLowerCase().replace(/[\s_-]/g, "")));
  const others = unknown.filter((key) => !repeats.includes(key));
  const suggestions = others.length ? closest(others[0], fields.filter((field) => !["type", "sceneId", "layerId"].includes(field))) : [];
  const parts = [`${unknown.map(quote).join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} of ${what}, so ${unknown.length === 1 ? "it" : "they"} would do nothing.`];
  if (others.length) parts.push(`Did you mean ${suggestions.join(", ")}?`);
  if (repeats.length) parts.push("To play it again and again, add behavior: {loop: {mode: \"cycle\"}} (or \"pingpong\" to play forward then backward).");
  throw Object.assign(mistake(parts.join(" "), example ?? undefined, suggestions), example === null ? { noExample: true } : {});
}

// The values whose keys are fields, with a key one letter or two off a field (durration) renamed
// to it when that field is not given too: what an example built from what was sent keeps.
function knownFields(values, fields) {
  const kept = Object.fromEntries(Object.entries(values).filter(([key]) => fields.includes(key)));
  for (const [key, value] of Object.entries(values)) {
    const near = fields.includes(key) ? null : nearMiss(key, fields);
    if (near && kept[near] === undefined) kept[near] = value;
  }
  return kept;
}

// The fields of an in, out or custom animation object, checked once its kind is known.
function checkAnimationObject(animation, fixes, layer, prefix) {
  fixEase(animation, fixes, prefix);
  if (!TIMED_KINDS.includes(animation.kind)) return;
  const kept = knownFields(animation, TIMED_FIELDS);
  const example = isRecord(kept.from) && isRecord(kept.to) ? { op: "add_animation", layer, animation: kept } : customExample(layer);
  refuseUnknownAnimationFields(animation, TIMED_FIELDS, `${animation.kind === "custom" ? "a" : "an"} ${animation.kind} animation`, example);
}

// `scale` in an animation's from or to is scaleX and scaleY (an animation has no scale value):
// from:{scale:1}, to:{scale:1.12} is from:{scaleX:1, scaleY:1}, to:{scaleX:1.12, scaleY:1.12}, and
// {x, y} pairs are scaleX and scaleY. In place; listed in fixed. Anything else is refused with a
// push that works.
function fixScaleValues(target, fixes, prefix, layer) {
  const moved = [];
  for (const end of ["from", "to"]) {
    const values = target[end];
    if (!isRecord(values) || values.scale === undefined) continue;
    const { scale, ...rest } = values;
    const pair = isRecord(scale) ? { scaleX: scale.x ?? scale.scaleX, scaleY: scale.y ?? scale.scaleY } : { scaleX: scale, scaleY: scale };
    if (![pair.scaleX, pair.scaleY].every((value) => typeof value === "number" || (typeof value === "string" && value.trim() !== "")))
      throw mistake(`an animation has no scale: animate scaleX and scaleY, such as from:{"scaleX":1,"scaleY":1}, to:{"scaleX":1.12,"scaleY":1.12}.`,
        customExample(layer, "Push", { scaleX: 1, scaleY: 1 }, { scaleX: 1.12, scaleY: 1.12 }));
    target[end] = { ...rest, scaleX: rest.scaleX ?? pair.scaleX, scaleY: rest.scaleY ?? pair.scaleY };
    moved.push(end);
  }
  if (moved.length) fixes.push(`${prefix}${moved.join("/")} scale → scaleX, scaleY`);
}

// start, duration, end and delay as numbers ("0.5s" → 0.5), in place; the field names are
// reported as given.
function fixTimes(target, fixes, prefix = "") {
  for (const field of ["start", "duration", "end", "delay", "time"]) {
    const seconds = timeFromText(target[field]);
    if (seconds === null) continue;
    fixes.push(`${prefix}${field} ${quote(target[field])} → ${seconds}`);
    target[field] = seconds;
  }
  // delay → start, time → start, end → duration.
  for (const field of ["delay", "time"]) {
    if (typeof target[field] !== "number") continue;
    if (target.start === undefined || (field === "delay" && typeof target.start === "number")) {
      const start = field === "delay" ? (target.start ?? 0) + target[field] : target[field];
      fixes.push(`${prefix}${field} → start ${start}`);
      target.start = start;
      delete target[field];
    }
  }
  if (typeof target.end === "number") {
    const start = typeof target.start === "number" ? target.start : 0;
    const duration = Math.round((target.end - start) * 1e6) / 1e6;
    if (target.duration === undefined && duration > 0) {
      fixes.push(`${prefix}end ${target.end} → duration ${duration}`);
      target.duration = duration;
      delete target.end;
    } else if (target.duration === duration) delete target.end;
    else throw mistake(`${prefix}end ${target.end} does not fit start ${start} and duration ${target.duration}; send duration only.`, null);
  }
}

/**
 * Fixes an add_animation in place (after short field names are renamed: layer is layerId).
 * `layerRef` is the layer as the agent wrote it, for examples.
 */
// ---- effect names -----------------------------------------------------------------------------
// Names agents use for a catalog effect (compared without dashes, spaces or capitals).
const EFFECT_KEYS = EFFECTS.map((effect) => effect.key);
const EFFECT_BY_FLAT = new Map(EFFECT_KEYS.map((key) => [key.replace(/-/g, ""), key]));
const EFFECT_ALIASES = { bloom: "glow", halation: "glow", flare: "lens-flare", godrays: "light-rays", godray: "light-rays",
  sunrays: "light-rays", lightray: "light-rays", lightleak: "light-leaks", ember: "embers", spark: "sparks", snowflakes: "snow",
  raindrops: "rain", chromaticaberration: "rgb-shift", chromatic: "rgb-shift", rgbsplit: "rgb-shift",
  depthoffield: "focus-band", dof: "focus-band", tiltshift: "focus-band", rackfocus: "focus-band",
  filmgrain: "grain", noisegrain: "grain", vignetting: "vignette", look: "color-look", filmlook: "color-look",
  expression: "field", mathfield: "field" };
// Names that could mean more than one thing, refused with what to use instead.
const BLURS = ["directional-blur", "zoom-blur", "spin-blur"];
const EFFECT_CHOICES = {
  motionblur: { suggestions: ["directional-blur"], message: "\"motion-blur\" is not an effect: blur from movement is a render option (shutterAngle, motionSamples; library {topic:\"rules\", name:\"blur\"}), and directional-blur smears a layer one way." },
  radialblur: { suggestions: ["zoom-blur", "spin-blur"], message: "\"radial-blur\" is zoom-blur (out from a centre) or spin-blur (around a centre)." },
  blur: { suggestions: BLURS, message: "\"blur\" is not an effect: a plain blur is the layer's blur property (update_layer properties {blur:8}, or a custom animation of blur); the blur effects are directional-blur, zoom-blur and spin-blur." },
  gaussianblur: { suggestions: BLURS, message: "\"gaussian-blur\" is not an effect: a plain blur is the layer's blur property (update_layer properties {blur:8}, or a custom animation of blur)." },
  particles: { suggestions: ["embers", "sparks", "snow", "dust", "rain", "bokeh"], message: "\"particles\" is a group: choose embers, sparks, snow, dust, rain or bokeh (library {topic:\"rules\", name:\"particles\"})." },
};

// The catalog key an effect name stands for, or null.
function effectKeyOf(word) {
  if (typeof word !== "string") return null;
  if (EFFECT_KEYS.includes(word)) return word;
  const flat = word.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return EFFECT_BY_FLAT.get(flat) ?? EFFECT_ALIASES[flat] ?? null;
}

// effect:"bloom" → glow (named in fixed); an unknown or unclear name is refused with suggestions.
function fixEffectName(word, fixes, field, layer, given) {
  const key = effectKeyOf(word);
  if (key) {
    if (key !== word) fixes.push(`${field} ${quote(word)} → ${key}`);
    return key;
  }
  const choice = EFFECT_CHOICES[String(word).trim().toLowerCase().replace(/[\s_-]+/g, "")];
  // The effects the plain words stand for (SEEN_AS, the map library search uses) come first,
  // then the spelling-closest names: "color-correct" and "brightness" lead to color-grade.
  const meant = seenNames(String(word), { limit: 8 }).map((line) => line.split(" ")[0]).filter((name) => EFFECT_KEYS.includes(name));
  const suggestions = choice?.suggestions ?? [...new Set([...meant, ...closest(String(word), EFFECT_KEYS)])].slice(0, 3);
  const first = EFFECTS.find((effect) => effect.key === suggestions[0]);
  // The settings of the first suggestion where 1 is unchanged, so 0.5 is not sent as "half a stop".
  const ones = first && !choice ? Object.entries(first.parameters).filter(([, field]) => isUnchangedAtOne(field)).map(([name]) => name) : [];
  const fields = ones.length ? ` In ${first.key}, ${ones.join(", ")}: 1 = unchanged.` : "";
  // The settings the op sent that the first suggestion has (effect:"brightness" with
  // {brightness:1.3}) ride along in the ready call, so the retry does what was asked.
  const kept = first && isRecord(given) ? Object.fromEntries(Object.entries(given).filter(([name]) => Object.hasOwn(first.parameters, name))) : {};
  const parameters = choice?.parameters ?? (Object.keys(kept).length ? kept : undefined);
  throw mistake(choice?.message ?? `unknown effect ${quote(word)}. Did you mean ${suggestions.join(", ")}?${fields}${fields ? "" : ' library {topic:"effects"} lists them all.'}`,
    { op: "add_animation", layer, effect: suggestions[0], ...(parameters ? { parameters } : {}) }, suggestions);
}

// An effect with start and end points (lightning: startX, startY, endX, endY, shares of the box)
// sent as from:[x,y] and to:[x,y], at the top or in parameters, the way a two-point call is
// usually written: the four fields (named in fixed). Points outside -0.5..1.5 are refused, since
// they read as pixels.
function fixEffectPoints(operation, fixes, layer) {
  const definition = EFFECTS.find((effect) => effect.key === operation.effect);
  if (!definition || !["startX", "startY", "endX", "endY"].every((key) => Object.hasOwn(definition.parameters, key))) return;
  const point = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  for (const [end, x, y] of [["from", "startX", "startY"], ["to", "endX", "endY"]]) {
    const parameters = isRecord(operation.parameters) ? operation.parameters : null;
    const where = point(parameters?.[end]) ? "parameters." : point(operation[end]) ? "" : null;
    if (where === null) continue;
    const value = where ? parameters[end] : operation[end];
    if (value.some((share) => share < -0.5 || share > 1.5))
      throw mistake(`${definition.key} ${where}${end} ${quote(value)}: points are shares 0..1 of the layer's box (${x}, ${y}), not pixels.`,
        { op: "add_animation", layer, effect: definition.key, start: operation.start ?? 0, duration: operation.duration ?? 0.3, parameters: { startX: 0.2, startY: 0.5, endX: 0.8, endY: 0.5 } });
    if (where) delete parameters[end];
    else delete operation[end];
    operation.parameters = { ...(isRecord(operation.parameters) ? operation.parameters : {}), [x]: value[0], [y]: value[1] };
    fixes.push(`${where}${end} ${quote(value)} → ${x}, ${y}`);
  }
}

// The receipt says in plain words what a "1 = unchanged" setting did (exposure 0.5: half as
// bright), and what a signed text such as "+0.5 stop" was taken to mean (ceiling studies a and c:
// 0.5 was meant as half a stop up and darkened the shot to near black).
function noteUnchangedValues(effect, values, resolver) {
  const definition = EFFECTS.find((entry) => entry.key === effect);
  if (!definition || !isRecord(values) || !resolver?.notes) return;
  for (const [name, value] of Object.entries(values)) {
    if (!isUnchangedAtOne(definition.parameters[name])) continue;
    const relative = relativeSetting(effect, name, value);
    if (relative?.name === "stops") resolver.notes.push(`${effect} ${name} ${quote(value)}: stops ${relative.value}, ${Math.abs(relative.value)} stop${Math.abs(relative.value) === 1 ? "" : "s"} ${relative.value < 0 ? "darker" : "brighter"} (0 = unchanged)`);
    else if (relative) resolver.notes.push(`${effect} ${name} ${quote(value)}: ${relative.value}, ${unchangedAtOneWords(name, relative.value)} (1 = unchanged)`);
    else if (typeof value === "number" && value !== 1)
      resolver.notes.push(`${effect} ${name} ${value}: ${unchangedAtOneWords(name, value)} (1 = unchanged${name === "exposure" ? `; for half a stop brighter write "+0.5 stop"` : ""})`);
  }
}

// keyframes:[{time, x, ...}] with times in scene seconds: a custom animation from the first
// time to the last, two frames as from/to, more as keys (t = share of the span). Anything
// else (no or falling times, start or duration beside them, per-frame easing, other
// properties per frame, another animation form) returns false and is refused.
function keyframesAsAnimation(operation, fixes) {
  const frames = operation.keyframes;
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > 64 || !frames.every(isRecord)) return false;
  if (["start", "at", "duration", "animation", "preset", "effect", "from", "to", "keys"].some((field) => operation[field] !== undefined)) return false;
  const times = frames.map((frame) => typeof frame.time === "number" ? frame.time : typeof frame.at === "number" && frame.time === undefined ? frame.at : NaN);
  if (!times.every((time, index) => Number.isFinite(time) && time >= 0 && (index === 0 || time > times[index - 1]))) return false;
  if (frames.some((frame) => ["t", "offset", "easing", "ease", "value"].some((field) => frame[field] !== undefined))) return false;
  const values = frames.map((frame) => Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "time" && key !== "at")));
  const names = (value) => Object.keys(value).sort().join();
  if (!names(values[0]) || values.some((value) => names(value) !== names(values[0]))) return false;
  const [first, span] = [times[0], times.at(-1) - times[0]];
  if (operation.kind !== undefined && !(operation.kind === "custom" || (frames.length === 2 && ["in", "out"].includes(operation.kind)))) return false;
  const kind = operation.kind ?? "custom";
  operation.animation = { kind, name: typeof operation.name === "string" && operation.name.trim() ? operation.name : "Animation",
    start: first, duration: span, ...(operation.easing !== undefined ? { easing: operation.easing } : {}),
    ...(frames.length === 2 ? { from: values[0], to: values[1] }
      : { keys: values.map((value, index) => ({ t: Math.round(((times[index] - first) / span) * 1e6) / 1e6, value })) }) };
  for (const field of ["keyframes", "kind", "easing"]) delete operation[field];
  fixes.push(`keyframes → animation {kind:"${kind}", start ${first}, duration ${Math.round(span * 1e6) / 1e6}, ${frames.length === 2 ? "from, to" : `${frames.length} keys`}}`);
  return true;
}

function fixAddAnimation(operation, fixes, { layerRef, resolver }) {
  const layer = typeof layerRef === "string" ? layerRef : "title";
  const layerType = () => { try { return resolver?.layerTypeOf(resolver.resolve(operation.layerId ?? layerRef, "layer")); } catch { return null; } };
  for (const field of ["target", "element", "object"]) {
    if (typeof operation[field] === "string" && operation.layerId === undefined) {
      operation.layerId = operation[field];
      delete operation[field];
      fixes.push(`${field} → layer`);
    }
  }
  if (operation.keyframes !== undefined && !keyframesAsAnimation(operation, fixes)) {
    const frames = Array.isArray(operation.keyframes) ? operation.keyframes.filter(isRecord) : [];
    const values = (frame) => Object.fromEntries(Object.entries(frame ?? {}).filter(([key]) => !["time", "t", "at", "offset", "easing"].includes(key)));
    const first = frames[0], last = frames.at(-1);
    let example = customExample(layer, "Move", first ? values(first) : { x: 100 }, last ? values(last) : { x: 1600 });
    if (first && typeof first.time === "number" && typeof last?.time === "number" && last.time > first.time)
      Object.assign(example.animation, { start: first.time, duration: last.time - first.time });
    if (frames.length > 2) {
      // The short form: keys at the top beside start and duration.
      const span = Math.max(1e-3, (typeof last?.time === "number" ? last.time : 1) - (typeof first?.time === "number" ? first.time : 0));
      example = { op: "add_animation", layer, start: example.animation.start, duration: example.animation.duration,
        keys: frames.slice(0, 64).map((frame, index) => ({
          t: typeof frame.time === "number" && typeof first.time === "number" ? Math.min(1, Math.max(0, (frame.time - first.time) / span)) : index / (frames.length - 1),
          value: values(frame) })) };
    }
    throw mistake("keyframes each need a rising time (scene seconds) and the same properties; or send keys:[{t, value, ease?}], t a share 0..1 of the duration.", example);
  }
  fixTimes(operation, fixes);
  fixEase(operation, fixes, "");
  // The name the op gives ({name:"Push", from, to}) is the animation's name too, not only its ID.
  const givenName = typeof operation.name === "string" && operation.name.trim() ? operation.name : undefined;
  if (typeof operation.effect === "string") operation.effect = fixEffectName(operation.effect, fixes, "effect", layer, operation.parameters);
  fixEffectPoints(operation, fixes, layer);
  if (typeof operation.preset === "string" && operation.preset.startsWith("effect:")) {
    const key = fixEffectName(operation.preset.slice("effect:".length), [], "effect", layer);
    if (`effect:${key}` !== operation.preset) fixes.push(`preset ${quote(operation.preset)} → effect:${key}`);
    operation.preset = `effect:${key}`;
  }
  if (isRecord(operation.animation) && typeof operation.animation.effect === "string")
    operation.animation = { ...operation.animation, effect: fixEffectName(operation.animation.effect, fixes, "animation.effect", layer) };
  noteUnchangedValues(typeof operation.effect === "string" ? operation.effect : typeof operation.preset === "string" && operation.preset.startsWith("effect:") ? operation.preset.slice("effect:".length) : null,
    operation.parameters, resolver);
  noteUnchangedValues(isRecord(operation.animation) ? operation.animation.effect : null, operation.animation?.to, resolver);
  if (typeof operation.mode === "string" && MODE_WORDS[operation.mode.toLowerCase()] && operation.mode !== MODE_WORDS[operation.mode.toLowerCase()]) {
    fixes.push(`mode ${quote(operation.mode)} → ${MODE_WORDS[operation.mode.toLowerCase()]}`);
    operation.mode = MODE_WORDS[operation.mode.toLowerCase()];
  }

  // animation: {…}
  if (isRecord(operation.animation)) {
    const animation = { ...operation.animation };
    fixTimes(animation, fixes, "animation.");
    fixEase(animation, fixes, "animation.");
    if (animation.kind === undefined && typeof animation.type === "string") {
      animation.kind = animation.type;
      delete animation.type;
      fixes.push("animation.type → kind");
    }
    // A preset inside the animation is a preset op, or (a property preset with values) a custom
    // animation. A custom animation that names a property preset takes its name.
    if (typeof animation.preset === "string" && animation.kind !== undefined && PRESET_VALUE_KEYS[animation.preset]) {
      animation.name ??= givenName ?? PRESET_BY_ID.get(animation.preset).name;
      delete animation.preset;
      fixes.push("animation.preset → name");
    }
    if (typeof animation.preset === "string") {
      const { preset, kind, ...rest } = animation;
      delete operation.animation;
      for (const [key, value] of Object.entries(rest)) if (operation[key] === undefined) operation[key] = value;
      operation.preset = preset;
      fixes.push("animation.preset → preset");
      // Its kind is read next to the preset below (kind "out" was dropped here, so an exit was
      // made as an entrance).
      if (kind !== undefined && operation.kind === undefined) operation.kind = kind;
    } else {
      const named = typeof animation.kind === "string" ? (presetFromWord(animation.kind)?.preset ?? animation.kind) : null;
      if (named && PRESET_VALUE_KEYS[named]) {
        fixes.push(`animation.kind ${quote(animation.kind)} → custom`);
        animation.name ??= givenName ?? PRESET_BY_ID.get(named).name;
        animation.kind = "custom";
      } else if (typeof animation.kind === "string" && MODE_WORDS[animation.kind.toLowerCase()] && !KINDS.includes(animation.kind)) {
        fixes.push(`animation.kind ${quote(animation.kind)} → ${MODE_WORDS[animation.kind.toLowerCase()]}`);
        animation.kind = MODE_WORDS[animation.kind.toLowerCase()];
      } else if (["tween", "keyframe", "keyframes", "animate", "property", "transition"].includes(String(animation.kind).toLowerCase())) {
        fixes.push(`animation.kind ${quote(animation.kind)} → custom`);
        animation.kind = "custom";
      }
      if (animation.kind === undefined && (animation.from !== undefined || animation.to !== undefined || Array.isArray(animation.keys))) {
        animation.kind = "custom";
        fixes.push(`animation.kind custom (it has ${Array.isArray(animation.keys) ? "keys" : "from/to"})`);
      }
      if (["in", "out", "custom"].includes(animation.kind)) {
        // Top-level timing belongs to the animation.
        for (const field of ["start", "duration", "easing"]) {
          if (animation[field] === undefined && operation[field] !== undefined) {
            animation[field] = operation[field];
            delete operation[field];
          }
        }
        animation.start ??= 0;
        animation.duration ??= 0.6;
        // A missing from starts where the layer is drawn at the animation's start (engine/operations.js
        // fillLeftOutFrom); a missing to ends at the layer's own values. This is documented, so
        // it is not listed in fixed.
        for (const end of ["from", "to"]) animation[end] ??= {};
        if (!isRecord(animation.from) || !isRecord(animation.to))
          throw mistake("animation from and to are objects of layer values, such as {\"x\":100}.", customExample(layer));
      }
      if (animation.kind === undefined)
        throw mistake("animation needs kind: \"custom\" with from and to (or use a preset).", customExample(layer));
      operation.animation = animation;
    }
  }

  // No preset and no animation, but from/to: a custom animation. keys at the top is the
  // documented short form of animation {kind:"custom", keys}, so it is not listed in fixed.
  const topKeys = Array.isArray(operation.keys);
  if (operation.animation === undefined && operation.preset === undefined && operation.effect === undefined
    && (isRecord(operation.to) || isRecord(operation.from) || topKeys)) {
    // kind beside from/to ({layer, kind:"out", from, to}) is the animation's kind.
    const kind = ["in", "out", "custom"].includes(operation.kind) ? operation.kind : "custom";
    if (operation.kind === kind) delete operation.kind;
    operation.animation = { kind, name: givenName ?? "Animation", start: typeof operation.start === "number" ? operation.start : 0,
      duration: operation.duration ?? 0.6, ...(operation.easing !== undefined ? { easing: operation.easing } : {}),
      from: operation.from ?? {}, to: operation.to ?? {}, ...(topKeys ? { keys: operation.keys } : {}) };
    for (const field of ["from", "to", "start", "duration", "easing", "keys"]) delete operation[field];
    if (!topKeys) fixes.push(`from/to → animation {kind:"${kind}"}`);
  }

  // preset:"glow" (no animation preset has that name): the glow effect.
  if (typeof operation.preset === "string" && operation.animation === undefined && operation.effect === undefined
    && !isPreset(operation.preset) && !presetFromWord(operation.preset) && effectKeyOf(operation.preset)) {
    operation.effect = effectKeyOf(operation.preset);
    fixes.push(`preset ${quote(operation.preset)} → effect ${operation.effect}`);
    delete operation.preset;
  }
  if (typeof operation.preset === "string" && operation.animation === undefined) {
    let word = presetFromWord(operation.preset);
    // On text, a write-on (or draw-on) is a type-on, not a stroke trim.
    if (word?.preset === "trim" && layerType() === "text") word = { preset: "preset-custom-text" };
    if (word) {
      fixes.push(`preset ${quote(operation.preset)} → ${word.preset}${word.mode && operation.mode === undefined ? ` (mode ${word.mode})` : ""}`);
      operation.preset = word.preset;
      if (word.mode && operation.mode === undefined) operation.mode = word.mode;
    }
    if (!isPreset(operation.preset)) {
      const suggestions = closest(operation.preset, ALL_PRESETS);
      throw mistake(`unknown animation preset ${quote(operation.preset)}. Did you mean ${suggestions.join(", ")}? library {topic:"presets"} lists them all.`,
        presetExample(layer, suggestions[0]), suggestions);
    }
    fixKindNextToPreset(operation, fixes, layer);
    const id = operation.preset;
    // A property preset given the values to reach: a custom animation of exactly those values.
    if (PRESET_VALUE_KEYS[id] && (operation.parameters !== undefined || operation.to !== undefined || operation.from !== undefined)) {
      const parameters = isRecord(operation.parameters) ? { ...operation.parameters } : operation.parameters;
      const nestedTo = isRecord(parameters) && parameters.to !== undefined && (isRecord(parameters.to) || parameters.from !== undefined) ? parameters.to : undefined;
      const nestedFrom = isRecord(parameters) && nestedTo !== undefined ? parameters.from : undefined;
      const to = presetValues(id, operation.to ?? nestedTo ?? (nestedTo === undefined ? parameters : undefined));
      const from = presetValues(id, operation.from ?? nestedFrom);
      const unknown = [...to.unknown, ...from.unknown];
      const name = givenName ?? PRESET_BY_ID.get(id).name;
      const keys = PRESET_VALUE_KEYS[id];
      if (unknown.length || (!Object.keys(to.values).length && !Object.keys(from.values).length))
        throw mistake(`${id} animates ${keys.join(", ")}${unknown.length ? `, not ${unknown.join(", ")}` : ""}: put the values to reach in to (from is optional; left out, it starts where the layer is drawn at its start).`,
          customExample(layer, name, {}, PRESET_SAMPLE_TO[id]));
      // A trim draws on: strokeEnd left out of from starts at the stroke's start (nothing drawn)
      // and holds there until it starts, as an In does; a trim to its start draws the line off.
      let drawsOff = false;
      if (id === "trim" && typeof to.values.strokeEnd === "number" && from.values.strokeEnd === undefined) {
        const startAt = from.values.strokeStart ?? to.values.strokeStart ?? 0;
        drawsOff = to.values.strokeEnd <= startAt;
        from.values.strokeEnd = drawsOff ? 1 : startAt;
      }
      const kind = ["in", "out"].includes(operation.mode) ? operation.mode : id !== "trim" ? "custom" : drawsOff ? "out" : "in";
      operation.animation = { kind, name, start: typeof operation.start === "number" ? operation.start : 0, duration: operation.duration ?? 0.6,
        ...(operation.easing !== undefined ? { easing: operation.easing } : {}), from: from.values, to: to.values };
      for (const field of ["preset", "parameters", "mode", "from", "to", "start", "duration", "easing"]) delete operation[field];
      if (typeof operation.animation.start !== "number") operation.animation.start = 0;
      fixes.push(`${id} with values → animation {kind:"${kind}", name:"${name}", from, to}`);
    } else if (!PRESET_VALUE_KEYS[id] && !id.startsWith("effect:")) {
      // A catalog preset's own settings at the top level (direction, distance, …) are its parameters.
      const definition = resolveCatalog(id);
      if (definition) {
        for (const key of Object.keys(definition.parameters)) {
          if (operation[key] === undefined) continue;
          operation.parameters = { ...(isRecord(operation.parameters) ? operation.parameters : {}), [key]: operation[key] };
          delete operation[key];
          fixes.push(`${key} → parameters.${key}`);
        }
      }
      if (operation.to !== undefined || (operation.from !== undefined && !id.startsWith("effect:")))
        throw mistake(`${id} takes parameters, not from/to. To animate chosen values, send a custom animation.`, customExample(layer));
    }
  }

  if (isRecord(operation.animation) && operation.animation.kind !== "effect" && operation.animation.effect === undefined) {
    operation.animation = { ...operation.animation };
    fixScaleValues(operation.animation, fixes, "animation.", layer);
  }

  if (operation.effect !== undefined || typeof operation.preset === "string") fixKindNextToPreset(operation, fixes, layer);

  // A name for a preset animation names it for later ops (as its ID).
  refuseUnknownAnimationFields(operation, [...ANIMATION_FIELDS, "name"], "add_animation",
    operation.animation ? customExample(layer) : presetExample(layer, typeof operation.preset === "string" ? operation.preset : undefined));
  if (isRecord(operation.animation)) checkAnimationObject(operation.animation, fixes, layer, "animation.");
}

// kind belongs to animation:{kind, from, to}. Next to a preset or an effect it is read as what
// it says, and listed in fixed: kind "in" is a preset's default (dropped), kind "out" is
// mode:"out", and a kind that names the preset or effect itself ("effect", "preset", "fade") is
// dropped. Anything else (kind "custom" with a preset, kind "out" with an effect) is refused
// with both ways written out. Before, every one was refused with '"kind" is not a field of
// add_animation. Did you mean id, at, easing?'.
function fixKindNextToPreset(operation, fixes, layer) {
  if (operation.kind === undefined) return;
  const { kind } = operation;
  delete operation.kind;
  const word = String(kind).trim().toLowerCase();
  const effect = operation.effect ?? (typeof operation.preset === "string" && operation.preset.startsWith("effect:") ? operation.preset.slice("effect:".length) : undefined);
  if (effect !== undefined) {
    if (word === "effect" || effectKeyOf(word) === effect) {
      fixes.push(`kind ${quote(kind)} dropped (an effect takes no kind)`);
      return;
    }
    throw mistake(`kind ${quote(kind)} does not go with an effect: an effect has no in or out and takes no kind. `
      + `Send {layer, effect:${quote(effect)}, start, duration}; to show or hide the layer around it, add a preset such as preset-fade (mode "out" for an exit).`,
      { op: "add_animation", layer, effect, start: 0, duration: 1 });
  }
  const preset = operation.preset;
  // The example keeps the times, easing and settings that were sent (an exit at 4 s stays at
  // 4 s), as the unknown-field refusal does.
  const sent = knownFields(operation, ["start", "at", "duration", "easing", "parameters", "intensity", "smoothing", "smoothingIntensity", "name"]);
  const base = presetExample(layer, preset);
  if (sent.at !== undefined && sent.start === undefined) delete base.start;
  const exitExample = { ...base, ...sent, mode: "out" };
  const mode = MODE_WORDS[word];
  if (mode) {
    if (operation.mode !== undefined && operation.mode !== mode)
      throw mistake(`kind ${quote(kind)} and mode ${quote(operation.mode)} disagree. A preset takes mode ("in", the default, or "out"), not kind.`, exitExample);
    if (mode === "out" && !PRESET_VALUE_KEYS[preset] && !resolveCatalog(preset))
      throw mistake(`${preset} has no in or out, so it takes neither kind nor mode. Send {layer, preset:${quote(preset)}, start}.`,
        { op: "add_animation", layer, preset, start: 0 });
    if (mode === "out") {
      operation.mode = "out";
      fixes.push(`kind ${quote(kind)} → mode "out"`);
    } else fixes.push(`kind ${quote(kind)} dropped (a preset is an entrance unless mode is "out")`);
    return;
  }
  if (word === "preset" || word === preset || (presetFromWord(word)?.preset ?? word) === preset) {
    fixes.push(`kind ${quote(kind)} dropped (a preset takes no kind)`);
    return;
  }
  throw mistake(`kind ${quote(kind)} does not go with a preset. A preset takes mode ("in", the default, or "out"), not kind (example: an exit). `
    + `For values you choose, send animation:{kind:"custom", from, to} without a preset.`, exitExample);
}

function resolveCatalog(id) {
  const preset = catalogPreset(id);
  return preset ? PRESET_DEFINITIONS[preset.id] : null;
}

// ---- other ops ------------------------------------------------------------------------------
const SCENE_FIELDS = ["name", "width", "height", "duration", "background", "backgroundEnabled", "backgroundAnimations", "aspectLocked",
  "canvasX", "canvasY", "componentPlayback", "rests", "drift", "finish", "letterbox"];
const ANIMATION_PROPERTY_FIELDS = new Set(["type", "sceneId", "layerId", "animationId", "animationIds", "properties"]);
// Ops that change one layer and need to know which.
const NEEDS_LAYER = new Set(["update_layer", "delete_layer", "add_animation", "convert_to_shape", "outline_text", "ungroup_layer", "remove_mask", "reorder_layer",
  "detach_component", "set_component_overrides", "reset_component_overrides", "replace_media", "style_text_range", "detect_beats", "duck_audio", "fit_music"]);

// The stored animations an update_animation(s) names, or null when one is not found (it may be
// made earlier in the same edit; the engine then checks it).
// update_animation {animation:"A1", properties:{gamma:0.6}} on a Color Wheels effect: gamma is
// one of the effect's settings, which live in to (the values it ends at) and from (where it
// starts). Refused with the op built from what was sent, settings moved into to, because a
// setting could mean to or from. A key that is neither a setting nor an animation field is
// matched against both: "Easing" and "dur" are easing and duration, "Gamma" is gamma. A `to`
// that was sent keeps its values. When nothing that was sent can go in the op, the refusal has
// no example, since an op that changes nothing would be accepted and lose the edit.
const EFFECT_FIELD_WORDS = { ease: "easing", delay: "start", length: "duration" };
const EDITABLE_EFFECT_FIELDS = [...EFFECT_ANIMATION_FIELDS].filter((field) => !["id", "kind", "effect", "from", "to"].includes(field));

// The effect animation field a mistyped key stands for, or null.
function effectFieldFor(key) {
  const lower = key.toLowerCase();
  const exact = EDITABLE_EFFECT_FIELDS.find((field) => field.toLowerCase() === lower);
  if (exact || EFFECT_FIELD_WORDS[lower]) return exact ?? EFFECT_FIELD_WORDS[lower];
  const prefixed = lower.length >= 3 ? EDITABLE_EFFECT_FIELDS.filter((field) => field.toLowerCase().startsWith(lower)) : [];
  return prefixed.length === 1 ? prefixed[0] : nearMiss(key, EDITABLE_EFFECT_FIELDS);
}

// The setting of `settings` a key names: exactly, in another case, or one letter off.
const settingFor = (key, settings) => settings.find((name) => name === key)
  ?? settings.find((name) => name.toLowerCase() === key.toLowerCase()) ?? nearMiss(key, settings);

// What the loose keys of an effect animation's properties stand for: settings moved into `to`,
// renamed animation fields, and keys that are neither, with the reason in sentences.
function sortLooseEffectKeys(properties, effectKey) {
  const loose = Object.keys(properties).filter((key) => !EFFECT_ANIMATION_FIELDS.has(key));
  const settings = Object.keys(EFFECTS.find((effect) => effect.key === effectKey)?.parameters ?? {});
  const kept = Object.fromEntries(Object.entries(properties).filter(([key]) => !loose.includes(key)));
  const moved = {};
  const parts = [];
  const exact = [];
  const list = (keys) => keys.join(keys.length === 2 ? " and " : ", ");
  for (const key of loose) {
    const setting = settingFor(key, settings);
    const field = setting ? null : effectFieldFor(key);
    if (setting) moved[setting] = properties[key];
    if (setting === key) exact.push(key);
    else if (setting) parts.push(`${key} is not a ${effectKey} setting or an animation field. Did you mean the setting ${setting}?`);
    else if (field) {
      if (kept[field] === undefined) kept[field] = properties[key];
      parts.push(`${key} is not an effect animation field. Did you mean ${field}?`);
    } else {
      parts.push(`${key} is neither a ${effectKey} setting nor an animation field (its settings: ${settings.join(", ")}; fields: ${EDITABLE_EFFECT_FIELDS.join(", ")}).`);
    }
  }
  if (exact.length) parts.unshift(`${list(exact)} ${exact.length > 1 ? "are" : "is a"} ${effectKey} setting${exact.length > 1 ? "s" : ""}, not ${exact.length > 1 ? "animation fields" : "an animation field"}.`);
  return { loose, kept, moved, parts, settingLike: Object.keys(moved).length > 0 || parts.some((part) => part.includes("neither")) };
}

const SETTINGS_GO_IN_TO = "An effect's settings go in properties.to (the values it ends at) and properties.from (where it starts).";

function refuseLooseEffectSettings(operation, properties, target, parameters) {
  const { loose, kept, moved, parts, settingLike } = sortLooseEffectKeys(properties, target.effect);
  if (!loose.length) return;
  // A `to` that was sent wins over a loose key with the same setting.
  const to = { ...(isRecord(parameters) ? parameters : {}), ...moved, ...(isRecord(kept.to) ? kept.to : {}) };
  const changes = { ...kept, ...(Object.keys(to).length ? { to } : {}) };
  const message = `${parts.join(" ")}${settingLike ? ` ${SETTINGS_GO_IN_TO}` : ""}`;
  if (!Object.keys(changes).length) throw Object.assign(mistake(message), { noExample: true });
  throw mistake(message, {
    op: "update_animation",
    ...(typeof operation.layerId === "string" ? { layer: operation.layerId } : {}),
    animation: operation.animationId,
    properties: changes,
  });
}

// update_animations {animationIds:["A1"], properties:{gamma:0.6}} on effects: the same mistake.
// Its fix is one update_animation for each effect, because update_animations replaces the whole
// of to (so the effect's other settings would go back to their defaults) and update_animation
// keeps the settings it does not name.
function refuseLooseEffectSettingsOnMany(operation, targets) {
  const properties = operation.properties;
  const effects = targets.map((target, index) => ({ target, ref: operation.animationIds[index] })).filter(({ target }) => target.kind === "effect");
  if (!effects.length) return;
  const sorted = effects.map((entry) => ({ ...entry, ...sortLooseEffectKeys(properties, entry.target.effect) }));
  const moving = sorted.filter((entry) => Object.keys(entry.moved).length);
  if (!moving.length) return;
  const ops = moving.map(({ ref, kept, moved }) => ({ op: "update_animation", animation: typeof ref === "string" ? ref : ref?.animationId,
    properties: { ...kept, to: { ...moved, ...(isRecord(kept.to) ? kept.to : {}) } } }));
  throw mistake(`${moving[0].parts.join(" ")} ${SETTINGS_GO_IN_TO} update_animations replaces all of to, so send one update_animation for each effect: it keeps the settings it does not name.`,
    ops.length === 1 ? ops[0] : ops);
}

// update_animation(s) properties that the animations it changes do not have (`loop`,
// `durration`) were saved and did nothing; they are refused. `parameters` on a preset animation
// is its preset.parameters (listed in fixed). When every target is known and is
// an in, out or custom animation, its own fields are the measure; otherwise (an effect is checked
// by refuseLooseEffectSettings, and one made in the same edit is not known yet) any animation's.
function refuseUnknownUpdateFields(operation, targets, fixes) {
  if (targets?.some((animation) => animation?.kind === "effect")) return;
  const timed = targets?.length && targets.every((animation) => TIMED_KINDS.includes(animation?.kind));
  // A preset's settings are its preset.parameters, as add_animation's parameters are.
  const { properties } = operation;
  // The keys sent that change the preset, for a refusal that names them.
  const presetKeys = isRecord(properties.preset) ? ["preset"] : [];
  if (timed && targets.every((animation) => isRecord(animation.preset)) && isRecord(properties.parameters) && properties.preset === undefined) {
    properties.preset = { parameters: properties.parameters };
    delete properties.parameters;
    fixes.push("properties.parameters → preset.parameters");
    presetKeys.push("parameters");
  }
  // So are its mode and its own settings sent beside the other fields: {mode:"in"} was refused
  // with "Did you mean id, name, order?" and {direction:"left"} with "Did you mean duration,
  // discrete, anchor?". A setting is moved only when every target's preset has it.
  if (timed && targets.every((animation) => isRecord(animation.preset)) && (properties.preset === undefined || isRecord(properties.preset))) {
    const settings = Object.keys(properties).filter((key) => !TIMED_FIELDS.includes(key)
      && targets.every((animation) => Object.hasOwn(PRESET_DEFINITIONS[animation.preset.id]?.parameters ?? {}, key)));
    const mode = properties.mode !== undefined && !TIMED_FIELDS.includes("mode");
    // {direction:"up", preset:{parameters:{direction:"left"}}} kept "left" and said direction was
    // moved: two values for one setting are refused, naming both, and nothing is saved.
    refuseTwoValues(operation, properties, mode ? ["mode", ...settings] : settings, presetKeys.includes("parameters") ? "parameters" : "preset.parameters");
    if (mode || settings.length) {
      const preset = { ...(properties.preset ?? {}) };
      if (mode) {
        preset.mode ??= properties.mode;
        delete properties.mode;
        fixes.push("mode → preset.mode");
        presetKeys.push("mode");
      }
      if (settings.length) {
        preset.parameters = { ...Object.fromEntries(settings.map((key) => [key, properties[key]])), ...(isRecord(preset.parameters) ? preset.parameters : {}) };
        for (const key of settings) {
          delete properties[key];
          fixes.push(`${key} → preset.parameters.${key}`);
        }
        presetKeys.push(...settings);
      }
      properties.preset = preset;
    }
  }
  readKindAsMode(operation, fixes);
  const fields = timed ? TIMED_FIELDS : ANY_ANIMATION_FIELDS;
  refusePresetWithValues(operation, presetKeys, fields);
  const kept = knownFields(operation.properties, fields);
  const which = operation.type === "update_animations" ? { animationIds: operation.animationIds } : { animation: operation.animationId };
  const example = Object.keys(kept).length ? { op: operation.type, ...which, properties: kept } : null;
  const kinds = timed ? [...new Set(targets.map((animation) => animation.kind))] : null;
  refuseUnknownAnimationFields(operation.properties, fields, kinds ? `${kinds.length === 1 ? (kinds[0] === "custom" ? "a custom" : `an ${kinds[0]}`) : "an in, out or custom"} animation` : "an animation", example);
}

// The value a loose preset setting or mode stands beside in the preset sent with it.
function refuseTwoValues(operation, properties, keys, parametersName) {
  const preset = isRecord(properties.preset) ? properties.preset : {};
  const nested = isRecord(preset.parameters) ? preset.parameters : {};
  const clashes = keys.map((key) => (key === "mode" ? ["mode", "preset.mode", preset.mode] : [key, `${parametersName}.${key}`, nested[key]]))
    .filter(([key, , value]) => value !== undefined && quote(value) !== quote(properties[key]));
  if (!clashes.length) return;
  const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]);
  const loose = new Set(clashes.map(([key]) => key));
  const kept = Object.fromEntries(Object.entries(properties).filter(([key]) => !loose.has(key)));
  const example = { op: operation.type, ...(typeof operation.layerId === "string" ? { layer: operation.layerId } : {}),
    ...(operation.type === "update_animations" ? { animationIds: operation.animationIds } : { animation: operation.animationId }), properties: kept };
  throw mistake(`${list(clashes.map(([key, where, value]) => `${key} ${quote(properties[key])} and ${where} ${quote(value)}`))} give one setting two values, so nothing was saved. `
    + `Send each value once, in the preset (example: the preset's values), or beside it without the preset.`, example);
}

// {preset:{mode:"out"}, kind:"out"}: a kind of "in" or "out" next to a preset is its mode, as
// the docs say. It was refused as a value the preset works out itself. A kind that disagrees with
// a mode sent with it is refused, naming both.
function readKindAsMode(operation, fixes) {
  const { properties } = operation;
  if (!isRecord(properties.preset) || !["in", "out"].includes(properties.kind)) return;
  const { kind } = properties;
  const { mode } = properties.preset;
  if (mode !== undefined && mode !== kind) {
    const { kind: _kind, ...kept } = properties;
    throw mistake(`kind ${quote(kind)} and preset.mode ${quote(mode)} disagree, so nothing was saved. Next to a preset, kind is read as its mode: send one of them (example: the mode).`,
      { op: operation.type, ...(typeof operation.layerId === "string" ? { layer: operation.layerId } : {}),
        ...(operation.type === "update_animations" ? { animationIds: operation.animationIds } : { animation: operation.animationId }), properties: kept });
  }
  properties.preset = { ...properties.preset, mode: kind };
  delete properties.kind;
  fixes.push(`kind ${quote(kind)} → preset.mode ${quote(kind)}`);
}

// update_animation {direction:"up", to:{y:100}} on a slide exit was saved with fixed ["direction
// → preset.parameters.direction"] and the to thrown away: a preset works out its from and to
// itself (engine/presetCatalog.js patchPresetAnimation). A preset change (preset, parameters, mode
// or one of the preset's settings) sent with from, to, kind, discrete, motionPath, anchor or
// fromCurrent is refused. Its example keeps the preset change; the reason also gives the op that
// keeps the values instead, which makes the animation a plain one. Both keep the other fields.
function refusePresetWithValues(operation, presetKeys, fields) {
  const { properties } = operation;
  if (!isRecord(properties.preset)) return;
  const values = PRESET_MADE_FIELDS.filter((key) => Object.hasOwn(properties, key));
  if (!values.length) return;
  // A key that is not an animation field is left out of both ops, and named.
  const unknown = Object.keys(properties).filter((key) => !fields.includes(key));
  const { preset, ...rest } = Object.fromEntries(Object.entries(properties).filter(([key]) => fields.includes(key)));
  const others = Object.fromEntries(Object.entries(rest).filter(([key]) => !values.includes(key)));
  const sent = Object.fromEntries(values.map((key) => [key, properties[key]]));
  // from, to, kind, discrete and motionPath make a preset a plain animation; anchor and
  // fromCurrent alone do not, so preset:null does it then.
  const detaches = values.some((key) => ["from", "to", "kind", "discrete", "motionPath"].includes(key));
  const op = (changes) => ({ op: operation.type, ...(typeof operation.layerId === "string" ? { layer: operation.layerId } : {}),
    ...(operation.type === "update_animations" ? { animationIds: operation.animationIds } : { animation: operation.animationId }), properties: changes });
  const list = (keys) => (keys.length > 1 ? `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}` : keys[0]);
  const named = presetKeys.length ? presetKeys : ["preset"];
  const plain = op({ ...others, ...(detaches ? {} : { preset: null }), ...sent });
  const settings = op({ ...others, preset });
  throw mistake(`${list(named.map(quote))} change${named.length === 1 ? "s" : ""} the preset, which works out the animation's from and to itself, so the ${list(values)} sent with ${named.length === 1 ? "it" : "them"} would be lost. `
    + `Send one of the two. The preset's settings alone: ${quote(settings)}. Or your ${list(values)} without the preset, which makes it a plain animation (a later preset change then needs the preset's id): ${quote(plain)}`
    + `${unknown.length ? `. ${list(unknown.map(quote))} ${unknown.length === 1 ? "is not a field" : "are not fields"} of an animation, so both leave ${unknown.length === 1 ? "it" : "them"} out.` : ""}`,
  settings);
}

// update_animation {preset:{parameters:{distance:80}}} on an animation whose from or to was set
// (which makes a preset a plain animation, though it keeps its name "Slide In ↑") was refused
// with "Unknown preset id undefined". Now the refusal says why, and its example gives the preset
// back: the id its name starts with, its kind as mode, and the direction and distance its from
// and to move by (a slide's distance is a share of the layer's height or width).
function refuseNoPreset(operation, targets, resolver) {
  const preset = operation.properties?.preset;
  if (!isRecord(preset) || preset.id !== undefined || !targets?.length) return;
  const index = targets.findIndex((animation) => TIMED_KINDS.includes(animation?.kind) && !isRecord(animation.preset));
  if (index < 0) return;
  const plain = targets[index];
  const ref = operation.animationId ?? operation.animationIds?.[index];
  const id = Object.values(PRESET_DEFINITIONS).map((definition) => definition.id)
    .filter((each) => typeof plain.name === "string" && ["In", "Out"].some((way) => `${plain.name} `.startsWith(`${PRESET_DEFINITIONS[each].name} ${way} `)))
    .sort((a, b) => PRESET_DEFINITIONS[b].name.length - PRESET_DEFINITIONS[a].name.length)[0];
  const sent = isRecord(preset.parameters) ? preset.parameters : {};
  const parameters = { ...(id ? slideSettings(id, plain, resolver) : {}), ...sent };
  const mode = preset.mode ?? (["in", "out"].includes(plain.kind) ? plain.kind : undefined);
  const whole = { id: id ?? "slide", ...(mode ? { mode } : {}), ...(Object.keys(parameters).length ? { parameters } : {}) };
  const named = typeof ref === "string" ? quote(ref) : "This animation";
  // A from or to sent beside the preset would be lost (refusePresetWithValues): the op that makes
  // it a preset again leaves them out, and the one that keeps them leaves out the preset.
  const { preset: _preset, ...rest } = operation.properties;
  const values = PRESET_MADE_FIELDS.filter((key) => Object.hasOwn(rest, key));
  const kept = Object.fromEntries(Object.entries(rest).filter(([key]) => !values.includes(key)));
  const which = { ...(typeof operation.layerId === "string" ? { layer: operation.layerId } : {}),
    ...(operation.type === "update_animations" ? { animationIds: operation.animationIds } : { animation: ref }) };
  // A custom animation, or one whose name is no preset's, never had a preset: the example that
  // gave it one ("slide") replaced its own move. Its from and to are what change it.
  if (plain.kind === "custom" || !id) {
    const timed = (entries) => Object.fromEntries(entries.filter(([key]) => key !== "preset" && TIMED_FIELDS.includes(key)));
    const current = Object.fromEntries(["from", "to"].filter((key) => isRecord(plain[key]) && Object.keys(plain[key]).length).map((key) => [key, plain[key]]));
    const changes = values.length ? timed(Object.entries(rest)) : { ...timed(Object.entries(kept)), ...current };
    const example = Object.keys(current).length || values.length ? { op: operation.type, ...which, properties: changes } : null;
    const now = Object.entries(current).map(([key, value]) => `${key} ${quote(value)}`).join(", ");
    const text = `${named} is a plain animation with no preset${typeof plain.name === "string" ? ` (named ${quote(plain.name)})` : ""}: it moves between the from and to it was given, so it has no preset settings to change. `
      + `To change how it moves, send its from or to with the values it should have${now ? ` (now ${now})` : ""}${example ? `: ${quote(example)}` : "."}`;
    if (!example || operation.type !== "update_animation") throw Object.assign(mistake(text), { noExample: true });
    throw mistake(text, example);
  }
  const message = `${named} is not a preset any more: setting its from or to made it a plain animation${typeof plain.name === "string" ? ` (it kept the name ${quote(plain.name)})` : ""}, so it has no preset settings to change. `
    + `To make it a preset again, give the preset's id: ${quote({ preset: whole })}; its from and to are then worked out from the layer's place.`
    + `${id ? "" : ` library {topic:"rules", name:"presets"} lists the ids.`}`
    + `${values.length ? ` To keep it plain with your ${values.join(" and ")}, leave out preset: ${quote({ op: operation.type, ...which, properties: rest })}` : ""}`;
  if (!id || operation.type !== "update_animation") throw Object.assign(mistake(message), { noExample: true });
  throw mistake(message, { op: "update_animation", ...which, properties: { ...kept, preset: whole } });
}

// The direction and distance a plain animation made from a slide (or blur & slide) moves by, as
// that preset's settings: an entrance moves into place, an exit away from it. {} for another
// preset, or when its from and to do not move one way.
function slideSettings(id, animation, resolver) {
  if (!["slide", "blur-slide"].includes(id)) return {};
  const step = (key) => (typeof animation.from?.[key] === "number" && typeof animation.to?.[key] === "number" ? animation.to[key] - animation.from[key] : 0);
  const [dx, dy] = [step("x"), step("y")];
  if ((dx !== 0) === (dy !== 0)) return {};
  // Into place: an entrance moves the way it is named, an exit the other way.
  const into = animation.kind === "out" ? -1 : 1;
  const direction = dy ? (dy * into < 0 ? "up" : "down") : (dx * into < 0 ? "left" : "right");
  const layer = resolver?.objects?.animations?.find((entry) => entry.animation === animation || entry.animation?.id === animation.id)?.layer;
  const size = layer && layer.type !== "text" ? Number(layer[dy ? "height" : "width"]) : NaN;
  const distance = Number.isFinite(size) && size > 0 ? Math.round(Math.abs(dy || dx) / size * 1000) / 10 : undefined;
  return { direction, ...(distance !== undefined && distance <= 1000 ? { distance } : {}) };
}

function targetAnimations(operation, resolver) {
  const refs = operation.animationId !== undefined ? [operation.animationId] : Array.isArray(operation.animationIds) ? operation.animationIds : [];
  if (!refs.length) return null;
  let layerId;
  try { if (typeof operation.layerId === "string") layerId = resolver.resolve(operation.layerId, "layer"); } catch { /* checked later */ }
  const found = refs.map((ref) => {
    try {
      const id = resolver.resolve(ref, "animation", { layerId });
      return resolver.objects.animations.find((entry) => entry.id === id)?.animation ?? null;
    } catch { return null; }
  });
  return found.every(Boolean) ? found : null;
}

// "1080x1920", "1080×1920", [1080, 1920] or {width, height}; or an aspect such as "9:16".
function sizeFromText(value) {
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return { width: value[0], height: value[1] };
  if (isRecord(value) && Number.isFinite(value.width) && Number.isFinite(value.height)) return { width: value.width, height: value.height };
  const pixels = /^\s*(\d+)\s*[x×*,]\s*(\d+)\s*$/i.exec(String(value ?? ""));
  if (pixels) return { width: Number(pixels[1]), height: Number(pixels[2]) };
  const aspect = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "4:3": [1440, 1080], "3:4": [1080, 1440] };
  const ratio = aspect[String(value ?? "").replace(/\s/g, "")];
  return ratio ? { width: ratio[0], height: ratio[1] } : null;
}

/**
 * Fixes one operation in place after its short field names are renamed and before its layer
 * properties are checked. `context`: {resolver, layerRef, raw}. Throws a mistake (with an example)
 * when what was meant is not clear.
 */
export function fixOperation(operation, fixes, context) {
  const { resolver } = context;
  const type = operation.type;
  const layerExists = (ref) => { try { resolver.resolve(ref, "layer"); return true; } catch { return false; } };

  if (type === "add_animation") fixAddAnimation(operation, fixes, context);

  if (type === "add_layer") {
    const properties = isRecord(operation.properties) ? operation.properties : {};
    if (operation.layerType === undefined) {
      const text = properties.text ?? operation.text;
      const fromSource = typeFromSource(properties.src ?? operation.src);
      const guess = typeof text === "string" ? "text" : fromSource;
      if (guess) {
        operation.layerType = guess;
        fixes.push(`layerType ${guess} (it has ${guess === "text" ? "text" : "src"})`);
      } else throw mistake(`add_layer needs layerType: ${LAYER_TYPES.join(", ")}.`, { op: "add_layer", layerType: "rectangle", name: "card",
        properties: { x: 160, y: 160, width: 400, height: 240, fill: "#ff5500" } });
    }
    if (!LAYER_TYPES.includes(operation.layerType)) {
      const suggestions = closest(String(operation.layerType), LAYER_TYPES);
      throw mistake(`layerType ${quote(operation.layerType)} is not a layer type: ${LAYER_TYPES.join(", ")}.${operation.layerType === "component" ? " A component is placed with insert_component." : ""}`,
        { op: "add_layer", layerType: suggestions[0], name: "card" }, suggestions);
    }
  }

  // update_layer {name:"box", properties} names the layer to change (properties.name renames it).
  if (["update_layer", "delete_layer", "convert_to_shape", "outline_text", "ungroup_layer", "reorder_layer"].includes(type) && operation.layerId === undefined) {
    for (const field of ["name", "id", "target", "element"]) {
      if (typeof operation[field] === "string" && layerExists(operation[field])) {
        operation.layerId = operation[field];
        delete operation[field];
        fixes.push(`${field} → layer`);
        break;
      }
    }
  }
  // reorder_layer {index: 0} means to: 0 (the layer's place in its group, 0 at the bottom).
  if (type === "reorder_layer" && operation.to === undefined && operation.index !== undefined) {
    operation.to = operation.index;
    delete operation.index;
    fixes.push("index → to");
  }
  if (NEEDS_LAYER.has(type) && operation.layerId === undefined && operation.layerIds === undefined) {
    const example = { update_layer: { op: "update_layer", layer: "title", properties: { x: 200 } }, delete_layer: { op: "delete_layer", layer: "title" },
      add_animation: presetExample("title") }[type] ?? null;
    throw mistake(`${type} needs layer: the layer's name or code (inspect lists them).`, example);
  }

  if (type === "update_scene" || type === "add_scene") {
    const loose = SCENE_FIELDS.filter((field) => operation[field] !== undefined);
    if (loose.length) {
      operation.properties = { ...(isRecord(operation.properties) ? operation.properties : {}) };
      for (const field of loose) {
        if (operation.properties[field] === undefined) operation.properties[field] = operation[field];
        delete operation[field];
        fixes.push(`${field} → properties.${field}`);
      }
    }
    const properties = isRecord(operation.properties) ? operation.properties : null;
    for (const field of ["size", "format", "aspect", "aspectRatio", "resolution", "dimensions"]) {
      const value = operation[field] ?? properties?.[field];
      if (value === undefined) continue;
      const size = sizeFromText(value);
      if (!size) throw mistake(`${field} ${quote(value)}: give width and height in pixels.`, { op: type, ...(type === "update_scene" ? {} : { name: "vertical" }), properties: { width: 1080, height: 1920 } });
      operation.properties = { ...(properties ?? {}), width: properties?.width ?? size.width, height: properties?.height ?? size.height };
      delete operation[field];
      delete operation.properties[field];
      fixes.push(`${field} ${quote(value)} → width ${size.width}, height ${size.height}`);
    }
  }

  // update_animation {animation, start: 1}: the changes go in properties.
  if (type === "update_animation" || type === "update_animations") {
    const loose = Object.keys(operation).filter((key) => !ANIMATION_PROPERTY_FIELDS.has(key));
    if (loose.length) {
      operation.properties = { ...(isRecord(operation.properties) ? operation.properties : {}) };
      for (const key of loose) {
        if (operation.properties[key] === undefined) operation.properties[key] = operation[key];
        delete operation[key];
      }
      fixes.push(`${loose.join(", ")} → properties`);
    }
    if (isRecord(operation.properties)) {
      fixTimes(operation.properties, fixes, "properties.");
      fixEase(operation.properties, fixes, "properties.");
      refuseNoPreset(operation, targetAnimations(operation, resolver), resolver);
      refuseUnknownUpdateFields(operation, targetAnimations(operation, resolver), fixes);
    }
    // scale in from/to is scaleX and scaleY, as in add_animation (an effect has no scale setting).
    if (isRecord(operation.properties) && operation.properties.effect === undefined) {
      const targets = targetAnimations(operation, resolver) ?? [];
      if (!targets.some((animation) => animation?.kind === "effect"))
        fixScaleValues(operation.properties, fixes, "properties.", typeof operation.layerId === "string" ? operation.layerId : "title");
    }
    // An effect's settings are its to (and from), not parameters as on add_animation; an edit of
    // to changes the settings it names and keeps the others (documented, so not listed in fixed).
    if (type === "update_animations" && isRecord(operation.properties) && Array.isArray(operation.animationIds)) {
      const targets = targetAnimations(operation, resolver);
      if (targets) refuseLooseEffectSettingsOnMany(operation, targets);
    }
    const [target] = type === "update_animation" && isRecord(operation.properties) ? targetAnimations(operation, resolver) ?? [] : [];
    if (target?.kind === "effect" && (operation.properties.effect === undefined || operation.properties.effect === target.effect)) {
      const { parameters, ...rest } = operation.properties;
      refuseLooseEffectSettings(operation, rest, target, parameters);
      if (isRecord(parameters)) fixes.push("parameters → to (an effect's settings)");
      if (isRecord(parameters) || isRecord(rest.to))
        operation.properties = { ...rest, to: { ...(isRecord(target.to) ? target.to : {}), ...(isRecord(parameters) ? parameters : {}), ...(isRecord(rest.to) ? rest.to : {}) } };
    }
  }

  if (type === "set_font") {
    for (const [alias, field] of [["font", "family"], ["fontFamily", "family"], ["name", "family"], ["fontWeight", "weight"], ["fontStyle", "style"]]) {
      if (operation[alias] === undefined || operation[field] !== undefined) continue;
      operation[field] = operation[alias];
      delete operation[alias];
      fixes.push(`${alias} → ${field}`);
    }
    if (typeof operation.weight === "string" && FONT_WEIGHTS[operation.weight.toLowerCase()] !== undefined) {
      fixes.push(`weight ${quote(operation.weight)} → ${FONT_WEIGHTS[operation.weight.toLowerCase()]}`);
      operation.weight = FONT_WEIGHTS[operation.weight.toLowerCase()];
    }
  }

  if (type === "stagger_animations") {
    if (operation.items === undefined && Array.isArray(operation.layerIds ?? operation.animationIds)) {
      operation.items = operation.layerIds ?? operation.animationIds;
      delete operation.layerIds;
      delete operation.animationIds;
      fixes.push("layers → items");
    }
    for (const alias of ["stagger", "gap", "interval", "offset", "step"]) {
      if (operation[alias] === undefined || operation.delay !== undefined) continue;
      operation.delay = operation[alias];
      delete operation[alias];
      fixes.push(`${alias} → delay`);
    }
  }
}
