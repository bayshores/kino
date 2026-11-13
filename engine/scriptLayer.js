// Script layers: a layer whose picture a small JavaScript module draws. This file holds the
// document side only: the limits, the checks on `script`, `inputs` and `values`, the frame a
// draw call receives, and a cache key. Nothing here runs the script (the renderer does that in
// a sandbox). Plain JavaScript shared by the server and the dashboard: no Node or DOM APIs.

import { evaluateLayer } from "./animation.js";
import { hiddenRanges } from "./visibilityOps.js";

export const SCRIPT_LIMITS = Object.freeze({
  scriptLength: 65_536,
  inputs: 40,
  textLength: 2_000,
  labelLength: 80,
  minOptions: 2,
  maxOptions: 24,
  optionLength: 200,
});

export const SCRIPT_INPUT_TYPES = Object.freeze(["number", "color", "text", "boolean", "select", "image"]);
/** Input types an animation may move (numbers lerp, colors blend). */
export const ANIMATED_INPUT_TYPES = Object.freeze(["number", "color"]);

const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const COLOR_PATTERN = /^#(?:[\da-fA-F]{6}|[\da-fA-F]{8})$/;
const IMAGE_SOURCE = /^\/api\/media\/[a-zA-Z0-9._-]+$/;
const INPUT_FIELDS = ["key", "type", "label", "min", "max", "step", "options"];

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);

// ---------------------------------------------------------------- the module source

// `import` as a statement or a call (import.meta and words such as "important" do not count).
const IMPORT_PATTERN = /(^|[^\w$.])import\s*(?:\(|[\w${*"'])/m;
const DEFAULT_EXPORT = /\bexport\s+default\b/g;

// The source as a function body with the same lines: `export default` becomes `return`, any other
// `export` word is blanked. Parsed only, never called.
function asFunctionBody(source) {
  return source.replace(DEFAULT_EXPORT, (match) => "return" + " ".repeat(Math.max(0, match.length - 6)))
    .replace(/\bexport\s+(?=(?:const|let|var|function|class|async)\b)/g, (match) => " ".repeat(match.length));
}

// Compiles without running (an async function so a top-level await parses). Returns the
// SyntaxError message, "" when it parses, or null when the platform refuses to compile code
// (a page whose content policy forbids it): the check is then skipped, not failed.
let AsyncFunction = null;
function parseError(body) {
  try {
    AsyncFunction ??= Object.getPrototypeOf(async function () {}).constructor;
    AsyncFunction(body);
    return "";
  } catch (error) {
    if (error instanceof SyntaxError) return error.message;
    return null;
  }
}

// Where the first syntax error is, as {line, column} (1-based), found by parsing ever shorter
// prefixes: the shortest prefix that reports the same message ends at the problem. Each prefix
// ends in an open comment, so the closing brace the platform wraps the body in is never read
// as part of it (a cut-off prefix then fails as unfinished, not with the same message).
function errorPosition(body, message) {
  const sameError = (end) => parseError(`${body.slice(0, end)}\n/*`) === message;
  let low = 0, high = body.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sameError(middle)) high = middle; else low = middle + 1;
  }
  const before = body.slice(0, Math.max(0, low - 1));
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

const syntaxCache = new Map();
/**
 * Why `source` can't be a script layer's module, as one sentence, or "" when it can. Checks the
 * size, `import`, the default export and the syntax (with line and column). Never runs the code.
 */
export function scriptProblem(source) {
  if (typeof source !== "string") return "must be the module's source code as text";
  if (source.length > SCRIPT_LIMITS.scriptLength)
    return `is ${source.length} characters; a script may have at most ${SCRIPT_LIMITS.scriptLength}`;
  if (!source.trim()) return "is empty; write a module with export default function setup(layer) { return function draw(frame) {...} }";
  if (syntaxCache.has(source)) return syntaxCache.get(source);
  let problem = "";
  const lines = source.split("\n");
  const importLine = lines.findIndex((line) => IMPORT_PATTERN.test(line));
  const defaults = source.match(DEFAULT_EXPORT)?.length ?? 0;
  if (importLine >= 0)
    problem = `uses import on line ${importLine + 1}; a script can't load other files or modules yet, so put everything it needs in this one module`;
  else if (defaults === 0)
    problem = "has no export default; start the module with export default function setup(layer) { ... return function draw(frame) { ... }; }";
  else if (defaults > 1) problem = "has more than one export default; keep one, the setup function";
  else {
    const body = asFunctionBody(source);
    const message = parseError(body);
    if (message) {
      const { line, column } = errorPosition(body, message);
      problem = `has a syntax error at line ${line}, column ${column}: ${message}`;
    }
  }
  if (syntaxCache.size > 64) syntaxCache.clear();
  syntaxCache.set(source, problem);
  return problem;
}

// ---------------------------------------------------------------- inputs and values

/** The checked `inputs` list of a script layer; throws a sentence naming the field. */
export function normalizeScriptInputs(inputs, path = "inputs") {
  if (!Array.isArray(inputs)) fail(path, "must be a list of inputs such as [{key:\"reveal\", type:\"number\", min:0, max:1}]");
  if (inputs.length > SCRIPT_LIMITS.inputs) fail(path, `has ${inputs.length} inputs; a script layer may declare at most ${SCRIPT_LIMITS.inputs}`);
  const seen = new Set();
  return inputs.map((raw, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(raw)) fail(at, "must be an object {key, type, label?, min?, max?, step?, options?}");
    for (const field of Object.keys(raw))
      if (!INPUT_FIELDS.includes(field)) fail(`${at}.${field}`, `is not an input field; an input has ${INPUT_FIELDS.join(", ")}`);
    const { key, type } = raw;
    if (typeof key !== "string" || !KEY_PATTERN.test(key))
      fail(`${at}.key`, "must start with a lowercase letter and hold only letters and digits, such as reveal or barColor");
    if (seen.has(key)) fail(`${at}.key`, `"${key}" is declared twice; each input needs its own key`);
    seen.add(key);
    if (!SCRIPT_INPUT_TYPES.includes(type)) fail(`${at}.type`, `must be ${SCRIPT_INPUT_TYPES.join(", ")}`);
    const input = { key, type };
    if (raw.label != null) {
      if (typeof raw.label !== "string" || raw.label.length > SCRIPT_LIMITS.labelLength)
        fail(`${at}.label`, `must be text of at most ${SCRIPT_LIMITS.labelLength} characters`);
      input.label = raw.label;
    }
    for (const field of ["min", "max", "step"]) {
      if (raw[field] == null) continue;
      if (type !== "number") fail(`${at}.${field}`, `only a number input has ${field}; "${key}" is a ${type} input`);
      if (!finite(raw[field])) fail(`${at}.${field}`, "must be a number");
      input[field] = raw[field];
    }
    if (input.step !== undefined && !(input.step > 0)) fail(`${at}.step`, "must be more than 0");
    if (input.min !== undefined && input.max !== undefined && input.min > input.max)
      fail(`${at}.max`, `is ${input.max}, below min ${input.min}`);
    if (raw.options != null && type !== "select") fail(`${at}.options`, `only a select input has options; "${key}" is a ${type} input`);
    if (type === "select") {
      const options = raw.options;
      if (!Array.isArray(options) || options.length < SCRIPT_LIMITS.minOptions || options.length > SCRIPT_LIMITS.maxOptions)
        fail(`${at}.options`, `a select input needs ${SCRIPT_LIMITS.minOptions} to ${SCRIPT_LIMITS.maxOptions} options, as a list of text`);
      options.forEach((option, number) => {
        if (typeof option !== "string" || !option || option.length > SCRIPT_LIMITS.optionLength)
          fail(`${at}.options[${number}]`, `must be text of 1 to ${SCRIPT_LIMITS.optionLength} characters`);
      });
      if (new Set(options).size !== options.length) fail(`${at}.options`, "lists the same option twice");
      input.options = [...options];
    }
    return input;
  });
}

/** One input's value checked against its type and range; throws a sentence. */
export function normalizeInputValue(input, value, path) {
  const { key, type } = input;
  switch (type) {
    case "number": {
      if (!finite(value)) fail(path, `"${key}" is a number input; give it a number`);
      if (input.min !== undefined && value < input.min) fail(path, `${value} is below ${key}'s min ${input.min}`);
      if (input.max !== undefined && value > input.max) fail(path, `${value} is above ${key}'s max ${input.max}`);
      return value;
    }
    case "color":
      if (typeof value !== "string" || !COLOR_PATTERN.test(value))
        fail(path, `"${key}" is a color input; give it #RRGGBB or #RRGGBBAA, such as "#ff3366"`);
      return value.toLowerCase();
    case "text":
      if (typeof value !== "string") fail(path, `"${key}" is a text input; give it text`);
      if (value.length > SCRIPT_LIMITS.textLength) fail(path, `"${key}" has ${value.length} characters; a text input holds at most ${SCRIPT_LIMITS.textLength}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail(path, `"${key}" is a boolean input; give it true or false`);
      return value;
    case "select":
      if (!input.options.includes(value)) fail(path, `"${key}" must be one of ${input.options.map((option) => JSON.stringify(option)).join(", ")}`);
      return value;
    case "image":
      if (value !== "" && (typeof value !== "string" || !IMAGE_SOURCE.test(value)))
        fail(path, `"${key}" is an image input; give it an imported picture's src (/api/media/<file>) or "" for none`);
      return value;
    default:
      return fail(path, `unknown input type ${type}`);
  }
}

const undeclared = (inputs, key) => `"${key}" is not a declared input${inputs.length ? `; this layer's inputs are ${inputs.map((input) => input.key).join(", ")}` : "; declare it in inputs first"}`;

/** The checked `values` map: one value for every declared input, nothing else. */
export function normalizeScriptValues(inputs, values, path = "values") {
  if (!isRecord(values)) fail(path, "must be an object {key: value} with a value for every input");
  const byKey = new Map(inputs.map((input) => [input.key, input]));
  for (const key of Object.keys(values)) if (!byKey.has(key)) fail(`${path}.${key}`, undeclared(inputs, key));
  const output = {};
  for (const input of inputs) {
    if (!Object.hasOwn(values, input.key)) fail(`${path}.${input.key}`, `needs a value: every input has a current value (the ${input.type} input "${input.key}" has none)`);
    output[input.key] = normalizeInputValue(input, values[input.key], `${path}.${input.key}`);
  }
  return output;
}

/** The checked `values` of an animation's from, to or key: number and color inputs only. */
export function normalizeAnimatedValues(inputs, values, path = "values") {
  if (!isRecord(values)) fail(path, "must be an object {key: value} naming number or color inputs");
  const byKey = new Map((inputs ?? []).map((input) => [input.key, input]));
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    const input = byKey.get(key);
    if (!input) fail(`${path}.${key}`, undeclared(inputs ?? [], key));
    if (!ANIMATED_INPUT_TYPES.includes(input.type))
      fail(`${path}.${key}`, `"${key}" is a ${input.type} input; only number and color inputs animate. Change it with update_layer {properties:{values:{${key}: ...}}}`);
    output[key] = normalizeInputValue(input, value, `${path}.${key}`);
  }
  if (!Object.keys(output).length) fail(path, "must name at least one number or color input");
  return output;
}

/** The input keys animations of `layer` move, each with the animations' names. */
export function animatedInputs(layer) {
  const found = new Map();
  const visit = (animation) => {
    if (!animation || typeof animation !== "object") return;
    if (Array.isArray(animation.animations)) animation.animations.forEach(visit);
    const sides = [animation.from, animation.to, ...(Array.isArray(animation.keys) ? animation.keys.map((key) => key?.value) : [])];
    for (const side of sides) for (const key of Object.keys(side?.values ?? {})) {
      if (!found.has(key)) found.set(key, new Set());
      // Its name, with its id when the id is a readable one ("bars.grow"), not a random one.
      const readable = typeof animation.id === "string" && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(animation.id) && animation.id !== animation.name;
      found.get(key).add(animation.name ? `${animation.name}${readable ? ` (${animation.id})` : ""}` : animation.id);
    }
  };
  (layer?.animations ?? []).forEach(visit);
  return new Map([...found].map(([key, names]) => [key, [...names]]));
}

/**
 * update_layer's properties for a script layer: `values` merge into the current ones; new
 * `inputs` drop the values of removed keys, and are refused while an animation uses a removed key.
 * A new `script` keeps the inputs (it is just assigned). Other layers' properties pass unchanged.
 */
export function scriptPatch(layer, properties) {
  if (layer?.type !== "script" || !isRecord(properties)) return properties;
  const patch = { ...properties };
  let values = { ...(layer.values ?? {}) };
  if (Object.hasOwn(patch, "inputs") && Array.isArray(patch.inputs)) {
    const kept = new Set(patch.inputs.map((input) => input?.key));
    const used = animatedInputs(layer);
    for (const input of layer.inputs ?? []) {
      if (kept.has(input.key)) continue;
      if (used.has(input.key))
        throw new Error(`Input "${input.key}" can't be removed: the animation ${used.get(input.key).map((name) => `"${name}"`).join(", ")} still moves it. Delete that animation or take "${input.key}" out of it first.`);
      delete values[input.key];
    }
  }
  if (Object.hasOwn(patch, "values")) {
    if (!isRecord(patch.values)) throw new Error("values must be an object {key: value}; it merges into the layer's current values");
    values = { ...values, ...patch.values };
  }
  if (Object.hasOwn(patch, "values") || Object.hasOwn(patch, "inputs")) patch.values = values;
  return patch;
}

// ---------------------------------------------------------------- the frame a draw receives

/** A #RRGGBB or #RRGGBBAA color as {r, g, b, a, css}, channels 0..1. */
export function colorValue(hex) {
  const digits = String(hex).slice(1);
  const channel = (offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
  const [r, g, b] = [channel(0), channel(2), channel(4)];
  const a = digits.length === 8 ? channel(6) : 1;
  const byte = (value) => Math.round(value * 255);
  const alpha = Math.round(a * 1000) / 1000;
  return { r, g, b, a, css: `rgb(${byte(r)} ${byte(g)} ${byte(b)} / ${alpha})` };
}

// The visible stretch of the scene that holds `time`: Hide and Show operations split the scene.
function visibleStretch(layer, time, sceneDuration) {
  const hidden = hiddenRanges(layer.animations ?? [], sceneDuration);
  const stretches = [];
  let from = 0;
  for (const range of hidden) {
    if (range.start > from) stretches.push({ start: from, end: range.start });
    from = Math.max(from, range.end);
  }
  if (from < sceneDuration || !stretches.length) stretches.push({ start: from, end: Math.max(from, sceneDuration) });
  return stretches.find((stretch) => time >= stretch.start && time < stretch.end)
    ?? stretches.findLast((stretch) => stretch.start <= time) ?? stretches[0];
}

/**
 * What a script's draw(frame) receives at `sceneTime` (seconds in the scene), without the
 * pixel ratio the renderer adds: {time, duration, progress, values, width, height}. `time` counts
 * from the start of the visible stretch, `duration` is its length (the scene's when
 * `sceneDuration` is left out, it is taken as `sceneTime`). Colors come as {r, g, b, a, css};
 * image inputs stay their src text (the renderer loads them).
 */
export function frameFor(layer, sceneTime, { sceneDuration } = {}) {
  const total = finite(sceneDuration) && sceneDuration > 0 ? sceneDuration : Math.max(0, sceneTime);
  const stretch = visibleStretch(layer, sceneTime, total);
  const duration = Math.max(0, stretch.end - stretch.start);
  const time = Math.max(0, sceneTime - stretch.start);
  const progress = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 1;
  const evaluated = evaluateLayer(layer, sceneTime);
  const sampled = evaluated.values ?? {};
  const values = {};
  for (const input of layer.inputs ?? []) {
    const value = sampled[input.key];
    values[input.key] = input.type === "color" ? colorValue(value) : value;
  }
  return { time, duration, progress, values, width: evaluated.width, height: evaluated.height };
}

// ---------------------------------------------------------------- cache key

// A 53-bit string hash (two 32-bit multiply-xor lanes), stable across platforms.
function hash53(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** A stable key for caches: changes when the code or the input declarations change. */
export function scriptKey(layer) {
  return `script-${hash53(`${layer?.script ?? ""}\u0000${JSON.stringify(layer?.inputs ?? [])}`)}`;
}
