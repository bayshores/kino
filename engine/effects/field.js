// The field effect: a math expression (engine/expression.js) worked out at each point of a small
// grid over the layer, f(u, v, t, seed, a, b, c), used one of three ways:
// - displace: pixels move by amount px, x and y from expression and expressionY (each -1..1), or
//   with no expressionY toward the angle expression (radians);
// - alpha: the layer is cut where f < threshold (softness widens the edge);
// - color: the layer mixes toward color by f (0 none, 1 all).
// The grid is one map image (mapImage.js), so the preview and exports draw the same pixels. The
// map's cache key holds only the inputs the expression reads: one without t, a, b or c is drawn
// once, and threshold, softness, color and amount change only the filter, never the map.
import { compileExpression } from "../expression.js";
import { clamp, smoothstep } from "../numbers.js";
import { effectMapImage } from "./mapImage.js";
import { renderVectorDisplacementMix } from "./periodicDisplacement.js";
import { filterEffect } from "./svg.js";

export const FIELD_INPUTS = Object.freeze(["u", "v", "t", "seed", "a", "b", "c"]);

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
// Text in the expression language; it holds for the whole effect.
const expression = (label, value, extra = {}) =>
  ({ type: "expression", label, default: value, inputs: FIELD_INPUTS, animatable: false, ...extra });

export const FIELD_EFFECT = {
  key: "field", label: "Field", group: "Distortion", kind: "ranged", render: renderField,
  parameters: {
    use: { type: "enum", label: "Use", default: "alpha", animatable: false,
      options: [["displace", "Displace"], ["alpha", "Alpha"], ["color", "Color"]] },
    expression: expression("Expression", "noise(u*10, v*10)*0.7 + noise(u*40, v*40)*0.3"),
    // Empty: displace reads expression as an angle.
    expressionY: expression("Expression Y", "", { empty: true }),
    amount: number("Amount", 20, 0, 128, 1, "px"),
    threshold: number("Threshold", 0.5, 0, 1, 0.01),
    softness: number("Softness", 0.05, 0, 1, 0.01),
    color: { type: "color", label: "Color", default: "#000000" },
    a: number("A", 0, -1000, 1000, 0.01), b: number("B", 0, -1000, 1000, 0.01), c: number("C", 0, -1000, 1000, 0.01),
    seed: number("Seed", 0, 0, 1_000_000, 1, "", { integer: true, animatable: false }),
    // Points along the layer's longer side; the map is stretched smoothly between them.
    grid: number("Grid", 128, 16, 256, 1, "points", { integer: true, animatable: false }),
  },
};

const fields = FIELD_EFFECT.parameters;
const fmt = (value) => {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

function read(frame, key) {
  const field = fields[key], value = frame?.parameters?.[key];
  if (field.type === "enum") return field.options.some(([option]) => option === value) ? value : field.default;
  if (field.type === "expression") return typeof value === "string" ? value : field.default;
  if (field.type === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : field.default;
  const result = clamp(Number.isFinite(value) ? value : field.default, field.min, field.max);
  return field.integer ? Math.round(result) : result;
}

// Compiled expressions by seed and text (stored ones were checked when saved).
const compiled = new Map();
function compile(source, seed) {
  const key = `${seed}|${source}`;
  let program = compiled.get(key);
  if (!program) {
    program = compileExpression(source, { inputs: FIELD_INPUTS, seed });
    if (compiled.size >= 64) compiled.delete(compiled.keys().next().value);
    compiled.set(key, program);
  }
  return program;
}

/**
 * The expressions with their inputs at this frame: `at(program, u, v)` evaluates one at a point,
 * and `key` names every value they read, for the map cache.
 */
export function fieldPrograms(frame) {
  const seed = read(frame, "seed");
  const sources = [read(frame, "expression"), read(frame, "expressionY")].filter((source) => source.trim() !== "");
  const programs = sources.map((source) => compile(source, seed));
  const env = new Float64Array(FIELD_INPUTS.length);
  env[2] = Number.isFinite(frame?.time) ? Math.max(0, frame.time) : 0;
  env[3] = seed;
  env[4] = read(frame, "a"); env[5] = read(frame, "b"); env[6] = read(frame, "c");
  const used = new Set(programs.flatMap((program) => program.used));
  const values = FIELD_INPUTS.slice(2).filter((name) => used.has(name)).map((name) => [name, env[FIELD_INPUTS.indexOf(name)]]);
  const at = (program, u, v) => { env[0] = u; env[1] = v; return program.run(env); };
  return { programs, at, key: [sources, seed, values] };
}

// Alpha from f (0..1): threshold 0 keeps every point, 1 cuts every point; between, f < threshold
// is cut, with an edge softness wide.
export function fieldAlpha(f, threshold, softness) {
  if (softness <= 0) return f >= threshold ? 1 : 0;
  const edge = threshold * (1 + softness) - softness / 2;
  return smoothstep((f - (edge - softness / 2)) / softness);
}

function scalarMap(frame, use, grid, programs, at, key) {
  return effectMapImage(frame, JSON.stringify(["field-v1", use, grid, key, frame.bounds.width, frame.bounds.height]),
    (x, y, width, height) => {
      const byte = Math.round(clamp(at(programs[0], (x + 0.5) / width, (y + 0.5) / height), 0, 1) * 255);
      return [byte, byte, byte, 255];
    }, { outside: [0, 0, 0, 255], maxSide: grid });
}

export function renderField(frame) {
  const use = read(frame, "use"), grid = read(frame, "grid");
  const { programs, at, key } = fieldPrograms(frame);
  const { x, y, width, height } = frame.bounds;
  const image = (uri) => `<feImage href="${uri}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none" result="fieldMap"/>`;
  if (use === "displace") {
    const amount = read(frame, "amount");
    if (amount === 0) return frame.content;
    const [first, second] = programs;
    const vectorAt = second
      ? (u, v) => ({ x: clamp(at(first, u, v), -1, 1), y: clamp(at(second, u, v), -1, 1) })
      : (u, v) => { const angle = at(first, u, v); return { x: Math.cos(angle), y: Math.sin(angle) }; };
    return renderVectorDisplacementMix(frame, [{ key: JSON.stringify(["field-v1", grid, key]), weight: 1, mapSide: grid, vectorAt }],
      2 * amount, { padding: amount + 1 });
  }
  const map = image(scalarMap(frame, use, grid, programs, at, key));
  if (use === "color") {
    const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(read(frame, "color").slice(offset, offset + 2), 16) / 255);
    return filterEffect(frame, [map,
      `<feColorMatrix in="fieldMap" type="matrix" values="0 0 0 0 ${fmt(red)} 0 0 0 0 ${fmt(green)} 0 0 0 0 ${fmt(blue)} 1 0 0 0 0" result="fieldTint"/>`,
      '<feComposite in="fieldTint" in2="SourceGraphic" operator="atop"/>',
    ], { padding: 0, contain: true });
  }
  const threshold = read(frame, "threshold"), softness = read(frame, "softness");
  const table = Array.from({ length: 257 }, (_, index) => fmt(fieldAlpha(index / 256, threshold, softness))).join(" ");
  return filterEffect(frame, [map,
    '<feColorMatrix in="fieldMap" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="fieldAlpha"/>',
    `<feComponentTransfer in="fieldAlpha" result="fieldMask"><feFuncA type="table" tableValues="${table}"/></feComponentTransfer>`,
    '<feComposite in="SourceGraphic" in2="fieldMask" operator="in"/>',
  ], { padding: 0, contain: true });
}
