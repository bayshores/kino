// The colour maths behind the colour-grading effects (colorGrading.js) and their tests.
//
// Colour space: every function here works on display-referred sRGB values from 0 to 1, the
// values a PNG or video frame stores and the space kino's SVG filters run in
// (color-interpolation-filters="sRGB"). Brightness ("luma") uses the Rec.709 weights.
// White balance is the one step that converts to linear light and back, because a change
// of light colour multiplies linear values.

import { clamp01 } from "../numbers.js";

export const LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function luma([red, green, blue]) {
  return LUMA[0] * red + LUMA[1] * green + LUMA[2] * blue;
}

/** "#rgb" or "#rrggbb" as [red, green, blue] from 0 to 1. */
export function hexToRgb(value) {
  const match = typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) throw new TypeError(`${JSON.stringify(value)} is not a 3 or 6 digit hex colour`);
  const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

// ---- Curves ------------------------------------------------------------------------------

export const MAX_CURVE_POINTS = 16;
export const IDENTITY_CURVE = Object.freeze([Object.freeze([0, 0]), Object.freeze([1, 1])]);

/** Checks a curve: 2 to 16 points [input, output] in 0..1 whose inputs increase. */
export function normalizeCurve(value, path = "curve") {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_CURVE_POINTS)
    throw new TypeError(`${path} must be a list of 2 to ${MAX_CURVE_POINTS} points [input, output], such as [[0,0],[0.5,0.6],[1,1]]`);
  const points = value.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2 ||
        !point.every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1))
      throw new TypeError(`${path}[${index}] must be [input, output], two numbers from 0 to 1`);
    return [point[0], point[1]];
  });
  for (let index = 1; index < points.length; index += 1)
    if (points[index][0] <= points[index - 1][0])
      throw new RangeError(`${path} inputs must increase from point to point (point ${index} has input ${points[index][0]}, after ${points[index - 1][0]})`);
  return points;
}

export function isIdentityCurve(points) {
  return points.every(([input, output]) => Math.abs(input - output) < 1e-9);
}

/**
 * A smooth curve through the points that never overshoots them (monotone cubic, the
 * Fritsch–Carlson/PCHIP method): between two points it stays between their outputs, so a
 * rising curve keeps rising. Before the first point and after the last it stays flat.
 */
export function curveFunction(points) {
  const x = points.map((point) => point[0]), y = points.map((point) => point[1]);
  const count = points.length;
  const widths = [], slopes = [];
  for (let index = 0; index < count - 1; index += 1) {
    widths.push(x[index + 1] - x[index]);
    slopes.push((y[index + 1] - y[index]) / widths[index]);
  }
  const tangents = new Array(count).fill(0);
  if (count === 2) tangents.fill(slopes[0]);
  else {
    for (let index = 1; index < count - 1; index += 1) {
      const before = slopes[index - 1], after = slopes[index];
      if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) continue;
      const first = 2 * widths[index] + widths[index - 1], second = widths[index] + 2 * widths[index - 1];
      tangents[index] = (first + second) / (first / before + second / after);
    }
    const end = (width0, width1, slope0, slope1) => {
      let tangent = ((2 * width0 + width1) * slope0 - width0 * slope1) / (width0 + width1);
      if (Math.sign(tangent) !== Math.sign(slope0)) tangent = 0;
      else if (Math.sign(slope0) !== Math.sign(slope1) && Math.abs(tangent) > 3 * Math.abs(slope0)) tangent = 3 * slope0;
      return tangent;
    };
    tangents[0] = end(widths[0], widths[1], slopes[0], slopes[1]);
    tangents[count - 1] = end(widths[count - 2], widths[count - 3], slopes[count - 2], slopes[count - 3]);
  }
  return (value) => {
    if (value <= x[0]) return clamp01(y[0]);
    if (value >= x[count - 1]) return clamp01(y[count - 1]);
    let index = 0;
    while (value > x[index + 1]) index += 1;
    const width = widths[index], t = (value - x[index]) / width;
    const t2 = t * t, t3 = t2 * t;
    return clamp01((2 * t3 - 3 * t2 + 1) * y[index] + (t3 - 2 * t2 + t) * width * tangents[index] +
      (-2 * t3 + 3 * t2) * y[index + 1] + (t3 - t2) * width * tangents[index + 1]);
  };
}

/**
 * The curves effect as one lookup table per channel, sampled at the 256 values an 8-bit
 * channel can have. Each channel goes through its own curve first and then the master curve
 * (the order Photoshop uses); strength mixes the result with the original value.
 */
export function curvesTables({ master = IDENTITY_CURVE, red = IDENTITY_CURVE, green = IDENTITY_CURVE, blue = IDENTITY_CURVE }, strength = 1, size = 256) {
  const all = curveFunction(master);
  return [red, green, blue].map((points) => {
    const own = curveFunction(points);
    return Array.from({ length: size }, (_, index) => {
      const value = index / (size - 1);
      return value + strength * (all(own(value)) - value);
    });
  });
}

// ---- .cube LUTs (Adobe Cube LUT Specification 1.0) -----------------------------------------

export const MAX_LUT_3D_SIZE = 65;
export const MAX_LUT_1D_SIZE = 65536;
export const LUT_MIME = "application/x-cube-lut";

/**
 * Reads the text of a .cube file. Returns {title, type:"1d"|"3d", size, domainMin, domainMax,
 * table} where table is a Float64Array of red, green, blue triples with red changing fastest.
 * Throws an Error naming the line for anything the specification does not allow.
 */
export function parseCubeLut(text) {
  if (typeof text !== "string") throw new TypeError("A .cube LUT must be text.");
  if (text.includes("\0")) throw new Error("This is not a .cube LUT: it contains binary data, but a .cube file is plain text.");
  const fail = (line, message) => { throw new Error(`This .cube LUT can't be used: line ${line} ${message}`); };
  let title = "", type = null, size = 0, domainMin = [0, 0, 0], domainMax = [1, 1, 1];
  let table = null, filled = 0, lineNumber = 0;
  const seen = new Set();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    lineNumber += 1;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const words = line.split(/\s+/);
    const keyword = words[0];
    if (/^[A-Za-z_]/.test(keyword)) {
      if (table && filled > 0) fail(lineNumber, `has the keyword ${keyword} after the table started; keywords come first.`);
      if (seen.has(keyword)) fail(lineNumber, `repeats ${keyword}.`);
      seen.add(keyword);
      if (keyword === "TITLE") {
        const match = /^TITLE\s+"([^"]*)"\s*$/.exec(line);
        if (!match) fail(lineNumber, 'needs the title in double quotes, such as TITLE "Warm look".');
        title = match[1];
      } else if (keyword === "LUT_1D_SIZE" || keyword === "LUT_3D_SIZE") {
        if (type) fail(lineNumber, "gives a second LUT size; a file holds one 1D or one 3D table.");
        const value = Number(words[1]);
        const max = keyword === "LUT_1D_SIZE" ? MAX_LUT_1D_SIZE : MAX_LUT_3D_SIZE;
        if (words.length !== 2 || !Number.isInteger(value) || value < 2 || value > max)
          fail(lineNumber, `needs ${keyword} to be a whole number from 2 to ${max}.`);
        type = keyword === "LUT_1D_SIZE" ? "1d" : "3d";
        size = value;
        table = new Float64Array((type === "1d" ? size : size ** 3) * 3);
      } else if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
        const values = words.slice(1).map(Number);
        if (values.length !== 3 || !values.every(Number.isFinite)) fail(lineNumber, `needs ${keyword} followed by three numbers (red green blue).`);
        if (keyword === "DOMAIN_MIN") domainMin = values; else domainMax = values;
      } else if (keyword === "LUT_1D_INPUT_RANGE" || keyword === "LUT_3D_INPUT_RANGE") {
        // Some color tools write the input range this way; it means the same as DOMAIN_MIN/MAX.
        const values = words.slice(1).map(Number);
        if (values.length !== 2 || !values.every(Number.isFinite)) fail(lineNumber, `needs ${keyword} followed by two numbers (min max).`);
        domainMin = [values[0], values[0], values[0]];
        domainMax = [values[1], values[1], values[1]];
      } else fail(lineNumber, `has the keyword ${keyword}, which kino does not read. kino reads TITLE, LUT_1D_SIZE, LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX, LUT_1D_INPUT_RANGE and LUT_3D_INPUT_RANGE.`);
      continue;
    }
    if (!table) fail(lineNumber, "has table numbers before LUT_1D_SIZE or LUT_3D_SIZE.");
    const values = words.map(Number);
    if (values.length !== 3 || !values.every(Number.isFinite))
      fail(lineNumber, `has ${JSON.stringify(line.slice(0, 60))}; each table line needs three numbers (red green blue).`);
    if (filled >= table.length) fail(lineNumber, `is one table line too many: a ${type.toUpperCase()} LUT of size ${size} has ${table.length / 3} lines.`);
    table.set(values, filled);
    filled += 3;
  }
  if (!table) throw new Error("This .cube LUT can't be used: it has no LUT_1D_SIZE or LUT_3D_SIZE line.");
  if (filled !== table.length)
    throw new Error(`This .cube LUT can't be used: a ${type.toUpperCase()} LUT of size ${size} needs ${table.length / 3} table lines, but the file has ${filled / 3}.`);
  for (let channel = 0; channel < 3; channel += 1)
    if (!(domainMax[channel] > domainMin[channel]))
      throw new Error("This .cube LUT can't be used: each DOMAIN_MAX value must be larger than its DOMAIN_MIN value.");
  return { title, type, size, domainMin, domainMax, table };
}

/** Writes a LUT as .cube text (used to make test LUTs in code). `color(r, g, b)` gives [r, g, b]. */
export function cubeText({ size, title = "", type = "3d", color }) {
  const lines = [];
  if (title) lines.push(`TITLE "${title}"`);
  lines.push(`LUT_${type === "1d" ? "1D" : "3D"}_SIZE ${size}`);
  const node = (index) => index / (size - 1);
  const format = (value) => Number(value.toFixed(6)).toString();
  if (type === "1d") for (let index = 0; index < size; index += 1)
    lines.push(color(node(index), node(index), node(index)).map(format).join(" "));
  else for (let blue = 0; blue < size; blue += 1) for (let green = 0; green < size; green += 1) for (let red = 0; red < size; red += 1)
    lines.push(color(node(red), node(green), node(blue)).map(format).join(" "));
  return `${lines.join("\n")}\n`;
}

/** The table entry [r, g, b] at lattice index (red, green, blue) of a 3D LUT. */
export function lutEntry(lut, red, green, blue) {
  const at = 3 * (red + lut.size * (green + lut.size * blue));
  return [lut.table[at], lut.table[at + 1], lut.table[at + 2]];
}

/** Where a colour value falls in the LUT's input domain, from 0 to 1. */
export function domainPosition(lut, value, channel) {
  return clamp01((value - lut.domainMin[channel]) / (lut.domainMax[channel] - lut.domainMin[channel]));
}

/**
 * The LUT's output for an [r, g, b] colour: per channel linear interpolation for a 1D LUT,
 * trilinear interpolation for a 3D LUT. Output values are clamped to 0..1.
 */
export function sampleLut(lut, rgb) {
  const last = lut.size - 1;
  const cell = (position) => {
    const scaled = position * last;
    const index = Math.min(last - 1, Math.floor(scaled));
    return [index, scaled - index];
  };
  if (lut.type === "1d") return rgb.map((value, channel) => {
    const [index, fraction] = cell(domainPosition(lut, value, channel));
    const low = lut.table[3 * index + channel], high = lut.table[3 * (index + 1) + channel];
    return clamp01(low + (high - low) * fraction);
  });
  const [[red, redFraction], [green, greenFraction], [blue, blueFraction]] = rgb.map((value, channel) => cell(domainPosition(lut, value, channel)));
  const output = [0, 0, 0];
  for (const [blueStep, blueWeight] of [[0, 1 - blueFraction], [1, blueFraction]])
    for (const [greenStep, greenWeight] of [[0, 1 - greenFraction], [1, greenFraction]])
      for (const [redStep, redWeight] of [[0, 1 - redFraction], [1, redFraction]]) {
        const weight = redWeight * greenWeight * blueWeight;
        if (!weight) continue;
        const entry = lutEntry(lut, red + redStep, green + greenStep, blue + blueStep);
        for (let channel = 0; channel < 3; channel += 1) output[channel] += weight * entry[channel];
      }
  return output.map(clamp01);
}

/**
 * True when a 3D LUT changes each channel on its own (red out depends only on red in, and so
 * on), like an identity LUT or a per-channel curve. Such a LUT is drawn exactly with three
 * lookup tables instead of the full 3D construction.
 */
export function lutIsSeparable(lut, tolerance = 1e-6) {
  if (lut.type === "1d") return true;
  const { size } = lut;
  for (let blue = 0; blue < size; blue += 1) for (let green = 0; green < size; green += 1) for (let red = 0; red < size; red += 1) {
    const entry = lutEntry(lut, red, green, blue);
    if (Math.abs(entry[0] - lutEntry(lut, red, 0, 0)[0]) > tolerance ||
        Math.abs(entry[1] - lutEntry(lut, 0, green, 0)[1]) > tolerance ||
        Math.abs(entry[2] - lutEntry(lut, 0, 0, blue)[2]) > tolerance) return false;
  }
  return true;
}

// ---- Hue, saturation, lightness ------------------------------------------------------------

/**
 * Rotation of every colour around the grey axis (where red = green = blue) by `degrees`. It keeps
 * greys and the average of the three channels, and turns the colour wheel: 120° turns pure red
 * into pure green, green into blue and blue into red. Between those angles, saturated colours
 * come out a little darker than an HSL hue change would make them.
 */
export function hueRotationMatrix(degrees) {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const same = cos + (1 - cos) / 3;
  const next = (1 - cos) / 3 - sin / Math.sqrt(3);
  const previous = (1 - cos) / 3 + sin / Math.sqrt(3);
  return [[same, next, previous], [previous, same, next], [next, previous, same]];
}

/** Mixes each colour with its Rec.709 luma: 0 is grey, 1 unchanged, 2 twice as saturated. */
export function saturationMatrix(amount) {
  return [0, 1, 2].map((row) => LUMA.map((weight, column) => weight * (1 - amount) + (row === column ? amount : 0)));
}

const multiply3 = (a, b) => a.map((row) => [0, 1, 2].map((column) => row.reduce((sum, value, index) => sum + value * b[index][column], 0)));

/**
 * The hue-saturation effect as one 3×4 matrix: rows [r, g, b, offset] for red, green and blue
 * out. Order: hue rotation, then saturation, then lightness (positive lightness mixes toward
 * white, negative toward black, as Photoshop's Hue/Saturation does).
 */
export function hueSaturationMatrix({ hue = 0, saturation = 1, lightness = 0 } = {}) {
  const color = multiply3(saturationMatrix(saturation), hueRotationMatrix(hue));
  const scale = lightness >= 0 ? 1 - lightness : 1 + lightness;
  const offset = lightness >= 0 ? lightness : 0;
  return color.map((row) => [...row.map((value) => value * scale), offset]);
}

export function applyMatrix(matrix, rgb) {
  return matrix.map((row) => clamp01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2] + (row[3] ?? 0)));
}

/** HSL lightness, saturation and hue (degrees) of an [r, g, b] colour. */
export function rgbToHsl([red, green, blue]) {
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const lightness = (max + min) / 2, chroma = max - min;
  if (chroma === 0) return [0, 0, lightness];
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === red) hue = ((green - blue) / chroma) % 6;
  else if (max === green) hue = (blue - red) / chroma + 2;
  else hue = (red - green) / chroma + 4;
  return [((hue * 60) % 360 + 360) % 360, saturation, lightness];
}

export function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const part = (offset) => {
    const k = (offset + hue / 30) % 12;
    return lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [part(0), part(8), part(4)].map(clamp01);
}

/**
 * Colorize: each pixel becomes the tint colour's hue and saturation at the pixel's own
 * brightness (its Rec.709 luma used as HSL lightness). Returned as one table per channel,
 * indexed by luma.
 */
export function colorizeTables(tint, size = 256) {
  const [hue, saturation] = rgbToHsl(hexToRgb(tint));
  const columns = [[], [], []];
  for (let index = 0; index < size; index += 1) {
    const rgb = hslToRgb(hue, saturation, index / (size - 1));
    for (let channel = 0; channel < 3; channel += 1) columns[channel].push(rgb[channel]);
  }
  return columns;
}

// ---- White balance ---------------------------------------------------------------------------

export function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value) {
  const v = clamp01(value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * Linear-light gains for temperature and tint, each from -100 to 100. Temperature +100 makes
 * red 1.41× and blue 0.71× (half a stop each way, warmer); tint +100 makes green 0.71× and red
 * and blue 1.19× (magenta); negative values go the other way. The gains are then scaled so a
 * neutral grey keeps its brightness (Rec.709 luminance).
 */
export function whiteBalanceGains(temperature = 0, tint = 0) {
  const t = clamp(temperature, -100, 100) / 100, g = clamp(tint, -100, 100) / 100;
  const gains = [2 ** (0.5 * t + 0.25 * g), 2 ** (-0.5 * g), 2 ** (-0.5 * t + 0.25 * g)];
  const brightness = luma(gains);
  return gains.map((gain) => gain / brightness);
}

export function whiteBalanceTables(temperature, tint, size = 256) {
  const gains = whiteBalanceGains(temperature, tint);
  return gains.map((gain) => Array.from({ length: size }, (_, index) => linearToSrgb(gain * srgbToLinear(index / (size - 1)))));
}

// ---- Lift, gamma, gain -------------------------------------------------------------------------

/**
 * The usual lift/gamma/gain formula for one channel: out = (gain · (x + lift · (1 − x)))^(1/gamma).
 * Lift moves the blacks (0 stays 0 only at lift 0) and leaves white alone, gain scales toward
 * white, gamma bends the middle. lift 0, gamma 1, gain 1 changes nothing.
 */
export function liftGammaGain(value, lift = 0, gamma = 1, gain = 1) {
  const base = clamp01(gain * (value + lift * (1 - value)));
  return base ** (1 / Math.max(0.01, gamma));
}

/** The per-channel lift, gamma and gain of the color-wheels effect: master plus each channel's offset. */
export function colorWheelChannels(parameters) {
  const channel = (name) => {
    const suffix = name[0].toUpperCase() + name.slice(1);
    return {
      lift: clamp((parameters.lift ?? 0) + (parameters[`lift${suffix}`] ?? 0), -1, 1),
      gamma: clamp((parameters.gamma ?? 1) + (parameters[`gamma${suffix}`] ?? 0), 0.1, 4),
      gain: clamp((parameters.gain ?? 1) + (parameters[`gain${suffix}`] ?? 0), 0, 4),
    };
  };
  return ["red", "green", "blue"].map(channel);
}

export function colorWheelTables(parameters, size = 256) {
  return colorWheelChannels(parameters).map(({ lift, gamma, gain }) =>
    Array.from({ length: size }, (_, index) => liftGammaGain(index / (size - 1), lift, gamma, gain)));
}

// ---- Keep color ----------------------------------------------------------------------------------

// The colour wheel kino measures hue on: a = R − (G + B)/2, b = √3/2 · (G − B). Red is at 0°,
// yellow 60°, green 120°, cyan 180°, blue 240°, magenta 300°.
const SQRT3_2 = Math.sqrt(3) / 2;
export function opponent([red, green, blue]) {
  return [red - (green + blue) / 2, SQRT3_2 * (green - blue)];
}

export function hueAngle(rgb) {
  const [a, b] = opponent(rgb);
  return ((Math.atan2(b, a) * 180 / Math.PI) + 360) % 360;
}

// Below this share of the colour's strength the mask is 0, and the soft ramp starts there. It
// removes the faint keep that 8-bit rounding would otherwise leave just outside the hue range.
export const KEEP_COLOR_FLOOR = 0.02;

/**
 * The geometry of keep-color: the hue range is a wedge on the colour wheel around the target
 * hue, `hueRange + softness` degrees to each side (at most 90). For each edge of the wedge,
 * `rows` holds the factors of R, G and B that give a colour's signed distance inside that edge.
 * Dividing that distance by the colour's strength (max − min of its channels) gives about the
 * sine of its angle inside the edge, and the mask rises from 0 at the edge to 1 at `softness`
 * degrees inside it.
 */
export function keepColorGeometry({ targetColor = "#FF0000", hueRange = 25, softness = 15 } = {}) {
  const [targetA, targetB] = opponent(hexToRgb(targetColor));
  const target = Math.atan2(targetB, targetA);
  const outer = Math.min(90, Math.max(0, hueRange) + Math.max(0, softness)) * Math.PI / 180;
  const soft = Math.max(0.5, Math.min(Math.max(0, softness), outer * 180 / Math.PI)) * Math.PI / 180;
  // Distances inside the two edges: along the target direction d1 and across it d2.
  const row = (side) => {
    const ca = Math.cos(target), sa = Math.sin(target);
    // d1 = a·cos t + b·sin t, d2 = −a·sin t + b·cos t; inside edge = d1·sin W ∓ d2·cos W.
    const d1 = [ca, -ca / 2 + SQRT3_2 * sa, -ca / 2 - SQRT3_2 * sa];
    const d2 = [-sa, sa / 2 + SQRT3_2 * ca, sa / 2 - SQRT3_2 * ca];
    return d1.map((value, index) => value * Math.sin(outer) - side * d2[index] * Math.cos(outer));
  };
  return { rows: [row(1), row(-1)], softSine: Math.sin(soft), outer };
}

/** How much of a ratio (distance inside an edge ÷ colour strength) is kept, from 0 to 1. */
export function keepColorRamp(ratio, softSine) {
  const t = clamp01((ratio - KEEP_COLOR_FLOOR) / softSine);
  return t * t * (3 - 2 * t);
}

/** The keep mask for one colour (1 keeps it, 0 greys it), computed without 8-bit rounding. */
export function keepColorMask(rgb, parameters) {
  const { rows, softSine } = keepColorGeometry(parameters);
  const strength = Math.max(...rgb) - Math.min(...rgb);
  if (strength <= 0) return 0;
  return rows.map((row) => {
    const distance = Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
    return keepColorRamp(Math.min(1, distance / strength), softSine);
  }).reduce((product, value) => product * value, 1);
}

/** keep-color for one colour: colours outside the hue range move toward their luma by `amount`. */
export function keepColor(rgb, parameters) {
  const grey = luma(rgb);
  const weight = (parameters.amount ?? 1) * (1 - keepColorMask(rgb, parameters));
  return rgb.map((value) => clamp01(value + weight * (grey - value)));
}
