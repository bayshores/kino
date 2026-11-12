// A field an op does not have is ignored by the engine (duplicate_layers {times:[4,8]} makes one
// plain copy). This names it in the receipt's notes, with the closest field and the op's field
// sheet (signatureFor, the same line fields.md and every refusal show).
import { isBlockOperation } from "./blocks.mjs";
import { signatureFor } from "./op-examples.mjs";
import { nearMiss } from "./refs.mjs";

// The names a signature lists at its top level: {scene?, layers, at?:[s], vary?:{k:[a,b]}} gives
// scene, layers, at, vary. Names inside nested braces, lists and quotes are not fields of the op.
export function signatureFields(signature) {
  const names = new Set();
  let depth = 0;
  let quoted = false;
  let segment = "";
  const take = () => {
    // "csv or rows" lists both; "layers: …" and "offset?:24" list the name before the colon.
    const found = /^\s*([A-Za-z_]\w*)\??((?:\s+or\s+[A-Za-z_]\w*\??)*)\s*(?::|$)/.exec(segment);
    if (found) for (const name of [found[1], ...found[2].split(/\s+or\s+/)]) if (name) names.add(name.replace("?", ""));
    segment = "";
  };
  for (const character of signature.slice(signature.indexOf("{"))) {
    if (character === '"') quoted = !quoted;
    if (!quoted && (character === "{" || character === "[")) {
      depth += 1;
      if (depth > 1) segment += character;
    } else if (!quoted && (character === "}" || character === "]")) {
      depth -= 1;
      if (depth === 0) take();
      else segment += character;
    // "layer | layers" lists two fields; "layout?:line|grid|radial" lists one field's values.
    } else if (!quoted && depth === 1 && (character === "," || (character === "|" && !segment.includes(":")))) take();
    else if (depth >= 1) segment += character;
  }
  return names;
}

// Fields every op may carry, and the short and long spellings of the ones translate.mjs renames.
const ALWAYS = ["op", "type", "layer", "layerId", "layers", "layerIds", "scene", "sceneId", "parent", "parentId", "component", "componentSceneId"];
// Building-block ops (isBlockOperation) refuse an unknown field in blocks.mjs. Ops whose own checks already refuse or lift an unknown field, or that take their fields in properties.
const SKIPPED = new Set(["add_layer", "update_layer", "update_layers", "insert_component", "add_animation", "add_scene", "update_scene", "update_project"]);

const TIME_WORDS = /^(times?|starts?|when|moments?|seconds)$/i;

// type -> {text, known}: an op's field sheet and the field names in it, read once.
const SHEETS = new Map();

/**
 * The note for the fields of `raw` (an op as sent) that its type does not have, or null. `done` is
 * the op after translation: a field it renamed (layer to layerId, index to to) is gone from it.
 */
export function unknownFieldsNote(raw, done) {
  const type = raw?.op ?? raw?.type;
  if (typeof type !== "string" || SKIPPED.has(type) || isBlockOperation(type)) return null;
  if (!SHEETS.has(type)) {
    const text = signatureFor(type);
    SHEETS.set(type, text ? { text, known: signatureFields(text) } : null);
  }
  const sheet = SHEETS.get(type);
  if (!sheet || !sheet.known.size || sheet.known.has("properties")) return null;
  const { text: signature, known } = sheet;
  const allowed = new Set([...known, ...ALWAYS]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key) && raw[key] !== undefined && done?.[key] !== undefined);
  if (!unknown.length) return null;
  // A misspelling (offest) is its near miss; a word for when (times, time, start) is at, when the op has at.
  const meant = [...new Set(unknown.map((key) => nearMiss(key, [...known]) ?? (known.has("at") && TIME_WORDS.test(key) ? "at" : null)).filter(Boolean))];
  return `${type} has no field ${unknown.map((key) => `"${key}"`).join(", ")}, so ${unknown.length === 1 ? "it was" : "they were"} ignored.${meant.length ? ` Did you mean ${meant.join(", ")}?` : ""} Its fields: ${signature.slice(type.length + 1)}`;
}
