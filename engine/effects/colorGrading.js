// The colour-grading effects: curves, lut, hue-saturation, white-balance, color-wheels and
// keep-color. Each one turns its parameters into SVG filter steps, so the dashboard preview
// (the browser draws the SVG) and every export (Chromium rasterizes the same SVG) make the same
// pixels. The maths lives in colorMath.js; this file only builds filter markup.
//
// Filter notes for readers new to SVG filters:
// - feColorMatrix and feComponentTransfer work on straight (not premultiplied) colour, so they
//   change colour without touching transparency.
// - feComposite operator="arithmetic" computes k1·A·B + k2·A + k3·B + k4 on every channel,
//   alpha included, so the steps below keep alpha at 1 until the last step puts the layer's
//   own alpha back with operator="in".
// - Chromium stores each step's result in 8 bits per channel.
import { filterEffect } from "./svg.js";
import { booleanParameter, numberParameter } from "./periodicDisplacement.js";
import {
  IDENTITY_CURVE, LUMA, colorWheelTables, colorizeTables, curvesTables, hexToRgb, hueSaturationMatrix,
  isIdentityCurve, keepColorGeometry, keepColorRamp, KEEP_COLOR_FLOOR, lutEntry, lutIsSeparable, normalizeCurve,
  sampleLut, whiteBalanceTables,
} from "./colorMath.js";
import { clamp01 } from "../numbers.js";

const TABLE_SIZE = 256;
// The largest grid kino draws a 3D LUT on, along green and blue (red uses every LUT entry).
// 17 is exact for 17-, 33- and 65-point LUTs; the drawing cost grows with its square.
export const LUT_RENDER_GRID = 17;
// Added to each multiply step of the 3D LUT. Chromium rounds each 8-bit result down; this
// small offset centres the rounding, measured on identity and test LUTs (mean error ±0.2/255).
const LUT_ROUNDING = 0.0012;

const number = (value) => Number(value.toFixed(6));
const tableNumber = (value) => Number(clamp01(value).toFixed(4));
const STRAIGHT = "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1";
const LUMA_TO_RGB = [0, 1, 2].map(() => `${LUMA.join(" ")} 0 0`).concat("0 0 0 1 0").join(" ");

function isIdentityTable(values) {
  return values.every((value, index) => Math.abs(value - index / (values.length - 1)) < 0.5 / 255);
}

/** One feComponentTransfer step from three per-channel tables (an identity table is left out). */
function transfer(tables, attributes = "") {
  const functions = ["R", "G", "B"].map((channel, index) => tables[index] && !isIdentityTable(tables[index])
    ? `<feFunc${channel} type="table" tableValues="${tables[index].map(tableNumber).join(" ")}"/>` : "").join("");
  return functions ? `<feComponentTransfer${attributes}>${functions}</feComponentTransfer>` : "";
}

function colorParameter(frame, key, fallback) {
  const value = frame?.parameters?.[key];
  try { return value === undefined ? fallback : (hexToRgb(value), value); } catch { return fallback; }
}

function curveParameter(frame, key) {
  const value = frame?.parameters?.[key];
  return value === undefined || value === null ? IDENTITY_CURVE : normalizeCurve(value, key);
}

// ---- curves -----------------------------------------------------------------------------------

export function renderCurves(frame) {
  const strength = numberParameter(frame, "strength", 1, 0, 1);
  const curves = { master: curveParameter(frame, "master"), red: curveParameter(frame, "red"),
    green: curveParameter(frame, "green"), blue: curveParameter(frame, "blue") };
  if (strength === 0 || Object.values(curves).every(isIdentityCurve)) return frame.content;
  const step = transfer(curvesTables(curves, strength, TABLE_SIZE));
  return step ? filterEffect(frame, step, { padding: 0 }) : frame.content;
}

// ---- lut ----------------------------------------------------------------------------------------

// The filter steps for one LUT at full strength, built once per loaded LUT.
const lutPlans = new WeakMap();

function lutPlan(lut) {
  let plan = lutPlans.get(lut);
  if (!plan) {
    plan = lutIsSeparable(lut) ? { separable: true } : { separable: false, steps: latticeSteps(lut) };
    lutPlans.set(lut, plan);
  }
  return plan;
}

// The colour matrix that copies one channel into red, green and blue, mapped from the LUT's
// input domain to 0..1 (the matrix output is clamped to 0..1).
function domainBroadcast(lut, channel) {
  const scale = 1 / (lut.domainMax[channel] - lut.domainMin[channel]);
  const offset = -lut.domainMin[channel] * scale;
  const row = [0, 0, 0, 0, number(offset)];
  row[channel] = number(scale);
  return [row, row, row].map((values) => values.join(" ")).concat("0 0 0 0 1").join(" ");
}

// A LUT output at red lattice index `red` and green/blue positions 0..1 (bilinear between the
// LUT's own green/blue entries; exact when the position falls on an entry).
function lutAt(lut, red, greenPosition, bluePosition) {
  const last = lut.size - 1;
  const cell = (position) => {
    const scaled = position * last, index = Math.min(last - 1, Math.floor(scaled + 1e-9));
    return [index, Math.max(0, scaled - index)];
  };
  const [green, greenFraction] = cell(greenPosition), [blue, blueFraction] = cell(bluePosition);
  const output = [0, 0, 0];
  for (const [greenStep, greenWeight] of [[0, 1 - greenFraction], [1, greenFraction]])
    for (const [blueStep, blueWeight] of [[0, 1 - blueFraction], [1, blueFraction]]) {
      const weight = greenWeight * blueWeight;
      if (weight < 1e-12) continue;
      const entry = lutEntry(lut, red, green + greenStep, blue + blueStep);
      for (let channel = 0; channel < 3; channel += 1) output[channel] += weight * entry[channel];
    }
  return output;
}

/**
 * A 3D LUT as SVG filter steps. Trilinear interpolation splits into sums of products of
 * one-channel functions:
 *   out(r, g, b) = Σk hatK(b) · Σj hatJ(g) · T_jk(r)
 * where hatJ is 1 at green grid point j and falls linearly to 0 at its neighbours, and T_jk is
 * the LUT along red at green point j and blue point k. Each hat and each T is a lookup table
 * (feComponentTransfer); each product and sum is an arithmetic feComposite. The result is the
 * same trilinear interpolation the .cube specification describes, up to 8-bit rounding.
 */
function latticeSteps(lut) {
  const grid = Math.min(lut.size, LUT_RENDER_GRID);
  const steps = [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${STRAIGHT}" result="source"/>`,
    ...[0, 1, 2].map((channel) => `<feColorMatrix in="source" type="matrix" values="${domainBroadcast(lut, channel)}" result="${"rgb"[channel]}"/>`),
  ];
  const hat = (index) => Array.from({ length: grid }, (_, at) => (at === index ? 1 : 0)).join(" ");
  for (let index = 0; index < grid; index += 1) {
    const values = hat(index);
    steps.push(`<feComponentTransfer in="g" result="g${index}"><feFuncR type="table" tableValues="${values}"/><feFuncG type="table" tableValues="${values}"/><feFuncB type="table" tableValues="${values}"/></feComponentTransfer>`);
    steps.push(`<feComponentTransfer in="b" result="b${index}"><feFuncR type="table" tableValues="${values}"/><feFuncG type="table" tableValues="${values}"/><feFuncB type="table" tableValues="${values}"/></feComponentTransfer>`);
  }
  for (let blue = 0; blue < grid; blue += 1) {
    for (let green = 0; green < grid; green += 1) {
      const columns = [[], [], []];
      for (let red = 0; red < lut.size; red += 1) {
        const entry = lutAt(lut, red, green / (grid - 1), blue / (grid - 1));
        for (let channel = 0; channel < 3; channel += 1) columns[channel].push(tableNumber(entry[channel]));
      }
      steps.push(`<feComponentTransfer in="r" result="t"><feFuncR type="table" tableValues="${columns[0].join(" ")}"/><feFuncG type="table" tableValues="${columns[1].join(" ")}"/><feFuncB type="table" tableValues="${columns[2].join(" ")}"/></feComponentTransfer>`);
      const product = `<feComposite in="t" in2="g${green}" operator="arithmetic" k1="1" k2="0" k3="0" k4="${LUT_ROUNDING}" result="${green === 0 ? `s${blue}` : "p"}"/>`;
      steps.push(product);
      if (green > 0) steps.push(`<feComposite in="s${blue}" in2="p" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="s${blue}"/>`);
    }
    steps.push(`<feComposite in="s${blue}" in2="b${blue}" operator="arithmetic" k1="1" k2="0" k3="0" k4="${LUT_ROUNDING}" result="${blue === 0 ? "lut" : "q"}"/>`);
    if (blue > 0) steps.push('<feComposite in="lut" in2="q" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="lut"/>');
  }
  return steps.join("");
}

/**
 * Per-channel tables for a LUT that changes each channel on its own (1D, or a separable 3D LUT).
 * `sample(value)` gives the output for grey `value`; by default it reads the LUT.
 */
function separableTables(lut, strength, sample = (value) => sampleLut(lut, [value, value, value])) {
  const columns = [[], [], []];
  for (let index = 0; index < TABLE_SIZE; index += 1) {
    const value = index / (TABLE_SIZE - 1);
    const output = sample(value);
    for (let channel = 0; channel < 3; channel += 1) columns[channel].push(value + strength * (output[channel] - value));
  }
  return columns;
}

/**
 * The lut effect. `frame.helpers.luts` maps each .cube src to its parsed LUT (parseCubeLut),
 * to null while the preview is still loading it, or to {error} when it could not be read.
 */
export function renderLut(frame) {
  const source = frame?.parameters?.lut;
  if (typeof source !== "string" || !source)
    throw new Error("The lut effect needs parameters.lut: the src of a .cube file imported with project {action:\"import\", file}.");
  const luts = frame.helpers?.luts;
  const lut = luts instanceof Map ? luts.get(source) : undefined;
  if (lut === null) return frame.content;
  if (lut === undefined) throw new Error(`The LUT ${source} was not loaded for this drawing.`);
  if (lut.error) throw new Error(lut.error);
  return drawLut(frame, lut, numberParameter(frame, "strength", 1, 0, 1));
}

/** Draws a parsed or generated LUT over frame.content, mixed with the layer by strength 0..1. */
function drawLut(frame, lut, strength, sample) {
  if (strength === 0) return frame.content;
  const plan = lutPlan(lut);
  if (plan.separable) {
    const step = transfer(separableTables(lut, strength, sample));
    return step ? filterEffect(frame, step, { padding: 0 }) : frame.content;
  }
  return filterEffect(frame, [
    plan.steps,
    `<feComposite in="lut" in2="source" operator="arithmetic" k1="0" k2="${number(strength)}" k3="${number(1 - strength)}" k4="0" result="mixed"/>`,
    '<feComposite in="mixed" in2="SourceAlpha" operator="in"/>',
  ], { padding: 0 });
}

// ---- generated LUTs ------------------------------------------------------------------------------

// LUTs built from a pixel function, kept by name, size and rounded parameters (oldest dropped first).
const FUNCTION_LUT_LIMIT = 48;
const functionLuts = new Map();

const roundParameters = (value) => typeof value === "number" ? Number(value.toFixed(4))
  : Array.isArray(value) ? value.map(roundParameters)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, roundParameters(value[key])]))
  : value;

/**
 * A 3D LUT (17 or 33 points a side) from `color(r, g, b, parameters)`, which takes and returns
 * 0..1 values. Numbers in `parameters` are rounded to 4 decimals; the rounded copy is what
 * `color` gets and what the cache is keyed by, so equal looks share one LUT and one filter plan.
 * Returns {lut, sample}; `sample` reads the function itself for a LUT that is separable.
 */
export function functionLut({ name, color, parameters = {}, size = 17 }) {
  if (typeof name !== "string" || !name) throw new Error("A generated LUT needs a name.");
  if (typeof color !== "function") throw new Error(`The generated LUT ${name} needs a color function.`);
  if (size !== 17 && size !== 33) throw new Error(`The generated LUT ${name} has size ${size}; use 17 or 33.`);
  const rounded = roundParameters(parameters);
  const key = `${name}|${size}|${JSON.stringify(rounded)}`;
  const cached = functionLuts.get(key);
  if (cached) {
    functionLuts.delete(key);
    functionLuts.set(key, cached);
    return cached;
  }
  const output = (r, g, b) => {
    const rgb = color(r, g, b, rounded);
    if (!Array.isArray(rgb) || rgb.length < 3 || !rgb.slice(0, 3).every(Number.isFinite))
      throw new Error(`The generated LUT ${name} gave ${JSON.stringify(rgb)} for (${r}, ${g}, ${b}); it must give three numbers.`);
    return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  };
  const table = new Float64Array(size ** 3 * 3);
  let at = 0;
  for (let blue = 0; blue < size; blue += 1) for (let green = 0; green < size; green += 1) for (let red = 0; red < size; red += 1) {
    table.set(output(red / (size - 1), green / (size - 1), blue / (size - 1)), at);
    at += 3;
  }
  const lut = { title: name, type: "3d", size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], table };
  const entry = { lut, sample: (value) => output(value, value, value) };
  functionLuts.set(key, entry);
  if (functionLuts.size > FUNCTION_LUT_LIMIT) functionLuts.delete(functionLuts.keys().next().value);
  return entry;
}

/**
 * Draws a generated LUT (see functionLut) the way the lut effect draws a .cube: per-channel
 * tables when each channel changes on its own, the 3D lattice otherwise. strength 0..1 mixes
 * with the layer.
 */
export function renderFunctionLut(frame, { strength = 1, ...lutOptions }) {
  const { lut, sample } = functionLut(lutOptions);
  return drawLut(frame, lut, clamp01(strength), sample);
}

// ---- hue-saturation -------------------------------------------------------------------------------

export function renderHueSaturation(frame) {
  const hue = numberParameter(frame, "hue", 0, -3600, 3600);
  const saturation = numberParameter(frame, "saturation", 1, 0, 4);
  const lightness = numberParameter(frame, "lightness", 0, -1, 1);
  const colorize = booleanParameter(frame, "colorize", false);
  const tint = colorParameter(frame, "tint", "#C8935A");
  const turn = ((hue % 360) + 360) % 360;
  const matrixIsIdentity = (turn < 1e-9 || 360 - turn < 1e-9) && saturation === 1 && lightness === 0;
  if (!colorize && matrixIsIdentity) return frame.content;
  const steps = [];
  if (colorize) {
    steps.push(`<feColorMatrix type="matrix" values="${LUMA_TO_RGB}"/>`);
    steps.push(transfer(colorizeTables(tint, TABLE_SIZE)));
  }
  if (!matrixIsIdentity) {
    const rows = hueSaturationMatrix({ hue, saturation, lightness });
    const values = rows.map(([red, green, blue, offset]) => `${number(red)} ${number(green)} ${number(blue)} 0 ${number(offset)}`)
      .concat("0 0 0 1 0").join(" ");
    steps.push(`<feColorMatrix type="matrix" values="${values}"/>`);
  }
  return filterEffect(frame, steps, { padding: 0 });
}

// ---- white-balance ----------------------------------------------------------------------------------

export function renderWhiteBalance(frame) {
  const temperature = numberParameter(frame, "temperature", 0, -100, 100);
  const tint = numberParameter(frame, "tint", 0, -100, 100);
  if (temperature === 0 && tint === 0) return frame.content;
  const step = transfer(whiteBalanceTables(temperature, tint, TABLE_SIZE));
  return step ? filterEffect(frame, step, { padding: 0 }) : frame.content;
}

// ---- color-wheels -------------------------------------------------------------------------------------

export function renderColorWheels(frame) {
  const parameters = {};
  for (const wheel of ["lift", "gamma", "gain"]) {
    const [fallback, min, max] = wheel === "lift" ? [0, -1, 1] : wheel === "gamma" ? [1, 0.1, 4] : [1, 0, 4];
    parameters[wheel] = numberParameter(frame, wheel, fallback, min, max);
    for (const channel of ["Red", "Green", "Blue"]) parameters[`${wheel}${channel}`] = numberParameter(frame, `${wheel}${channel}`, 0, -1, 1);
  }
  const step = transfer(colorWheelTables(parameters, TABLE_SIZE));
  return step ? filterEffect(frame, step, { padding: 0 }) : frame.content;
}

// ---- keep-color -----------------------------------------------------------------------------------------

// Natural-log tables used to divide one image by another: ln(a) − ln(b) is ln(a ÷ b).
// LOG maps v = 1/255..1 to 0..1 (and 0 to 0); 1 − LOG is stored for the divisor so the
// arithmetic step adds instead of subtracts and keeps alpha at 1.
const LN_255 = Math.log(255);
const LOG_TABLE = Array.from({ length: TABLE_SIZE }, (_, index) => (index === 0 ? 0 : 1 + Math.log(index / 255) / LN_255));
const INVERSE_LOG_TABLE = LOG_TABLE.map((value) => 1 - value);

function keepRampTable(softSine) {
  // The table input is d = (LOG(distance) + 1 − LOG(strength)) / 2, so distance ÷ strength = 255^(2d − 1).
  return Array.from({ length: TABLE_SIZE }, (_, index) => keepColorRamp(Math.min(1, 255 ** (2 * index / (TABLE_SIZE - 1) - 1)), softSine));
}

/**
 * keep-color keeps the colours whose hue is within hueRange degrees of targetColor's hue (fading
 * out over `softness` more degrees) and moves every other colour toward grey (its Rec.709 luma)
 * by `amount`. The hue test is the colour-wheel wedge from keepColorGeometry; the division by the
 * colour's strength is done with log tables, so it is accurate to about 4%.
 */
export function renderKeepColor(frame) {
  const amount = numberParameter(frame, "amount", 1, 0, 1);
  if (amount === 0) return frame.content;
  const parameters = {
    targetColor: colorParameter(frame, "targetColor", "#FF0000"),
    hueRange: numberParameter(frame, "hueRange", 25, 0, 90),
    softness: numberParameter(frame, "softness", 15, 0, 90),
  };
  const { rows, softSine } = keepColorGeometry(parameters);
  const edges = [...rows.map((row) => `${row.map(number).join(" ")} 0 0`), "0 0 0 0 0", "0 0 0 0 1"].join(" ");
  const broadcast = (channel) => [0, 1, 2].map(() => { const row = [0, 0, 0, 0, 0]; row[channel] = 1; return row.join(" "); }).concat("0 0 0 0 1").join(" ");
  const table = (values) => `tableValues="${values.map(tableNumber).join(" ")}"`;
  const ramp = keepRampTable(softSine);
  return filterEffect(frame, [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${STRAIGHT}" result="source"/>`,
    // Signed distance inside each edge of the hue wedge (red: first edge, green: second).
    `<feColorMatrix in="source" type="matrix" values="${edges}" result="edges"/>`,
    // The colour's strength: its largest channel minus its smallest.
    ...[0, 1, 2].map((channel) => `<feColorMatrix in="source" type="matrix" values="${broadcast(channel)}" result="${"rgb"[channel]}"/>`),
    '<feBlend in="r" in2="g" mode="lighten" result="high"/>',
    '<feBlend in="high" in2="b" mode="lighten" result="high"/>',
    '<feBlend in="r" in2="g" mode="darken" result="low"/>',
    '<feBlend in="low" in2="b" mode="darken" result="low"/>',
    '<feComponentTransfer in="low" result="lowInverse"><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>',
    '<feComposite in="high" in2="lowInverse" operator="arithmetic" k1="0" k2="1" k3="1" k4="-1" result="strength"/>',
    // distance ÷ strength through log tables, then the soft ramp: one mask per edge.
    `<feComponentTransfer in="edges" result="edgesLog"><feFuncR type="table" ${table(LOG_TABLE)}/><feFuncG type="table" ${table(LOG_TABLE)}/></feComponentTransfer>`,
    `<feComponentTransfer in="strength" result="strengthLog"><feFuncR type="table" ${table(INVERSE_LOG_TABLE)}/><feFuncG type="table" ${table(INVERSE_LOG_TABLE)}/></feComponentTransfer>`,
    '<feComposite in="edgesLog" in2="strengthLog" operator="arithmetic" k1="0" k2="0.5" k3="0.5" k4="0" result="ratio"/>',
    `<feComponentTransfer in="ratio" result="edgeMasks"><feFuncR type="table" ${table(ramp)}/><feFuncG type="table" ${table(ramp)}/></feComponentTransfer>`,
    `<feColorMatrix in="edgeMasks" type="matrix" values="${broadcast(0)}" result="firstMask"/>`,
    `<feColorMatrix in="edgeMasks" type="matrix" values="${broadcast(1)}" result="secondMask"/>`,
    '<feComposite in="firstMask" in2="secondMask" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="keep"/>',
    // grey share w = amount·(1 − keep); out = source·(1 − w) + luma·w.
    `<feComponentTransfer in="keep" result="colorShare"><feFuncR type="linear" slope="${number(amount)}" intercept="${number(1 - amount)}"/><feFuncG type="linear" slope="${number(amount)}" intercept="${number(1 - amount)}"/><feFuncB type="linear" slope="${number(amount)}" intercept="${number(1 - amount)}"/></feComponentTransfer>`,
    `<feComponentTransfer in="keep" result="greyShare"><feFuncR type="linear" slope="${number(-amount)}" intercept="${number(amount)}"/><feFuncG type="linear" slope="${number(-amount)}" intercept="${number(amount)}"/><feFuncB type="linear" slope="${number(-amount)}" intercept="${number(amount)}"/></feComponentTransfer>`,
    `<feColorMatrix in="source" type="matrix" values="${LUMA_TO_RGB}" result="grey"/>`,
    '<feComposite in="source" in2="colorShare" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="kept"/>',
    '<feComposite in="grey" in2="greyShare" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="greyed"/>',
    '<feComposite in="kept" in2="greyed" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="graded"/>',
    '<feComposite in="graded" in2="SourceAlpha" operator="in"/>',
  ], { padding: 0 });
}

// Exported for tests: the floor below which keep-color's mask is 0.
export { KEEP_COLOR_FLOOR };
