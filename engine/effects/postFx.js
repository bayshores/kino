import { effectMapImage } from "./mapImage.js";
import { cachedMap, fractalNoise } from "./maps.js";
import { filterEffect } from "./svg.js";
import { clamp, smoothstep } from "../numbers.js";
import { renderFunctionLut } from "./colorGrading.js";
import { hexRgb01, keepOf, levelsFor, luma as lumaOf, normalizeLuma, withKeep } from "./relight.js";

const LUMA = [0.2126, 0.7152, 0.0722];
const fmt = (value) => {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

function number(frame, key, fallback, min, max, { integer = false } = {}) {
  const supplied = frame?.parameters?.[key];
  const value = clamp(Number.isFinite(supplied) ? supplied : fallback, min, max);
  return integer ? Math.round(value) : value;
}

function boolean(frame, key, fallback) {
  const supplied = frame?.parameters?.[key];
  return typeof supplied === "boolean" ? supplied : fallback;
}

function color(value, fallback) {
  const match = typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  const fallbackMatch = typeof fallback === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fallback);
  const selected = match ?? fallbackMatch;
  if (!selected) return [0, 0, 0];
  const hex = selected[1].length === 3 ? [...selected[1]].map((digit) => digit + digit).join("") : selected[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function rgb(colorValue) {
  return `rgb(${colorValue.join(",")})`;
}

function grayMatrix({ opaque = false } = {}) {
  const [red, green, blue] = LUMA;
  return [
    `${red} ${green} ${blue} 0 0`,
    `${red} ${green} ${blue} 0 0`,
    `${red} ${green} ${blue} 0 0`,
    opaque ? "0 0 0 0 1" : "0 0 0 1 0",
  ].join(" ");
}

function contrastTransfer(input, contrast, result) {
  const slope = fmt(contrast), intercept = fmt((1 - contrast) / 2);
  return `<feComponentTransfer in="${input}" result="${result}"><feFuncR type="linear" slope="${slope}" intercept="${intercept}"/><feFuncG type="linear" slope="${slope}" intercept="${intercept}"/><feFuncB type="linear" slope="${slope}" intercept="${intercept}"/></feComponentTransfer>`;
}

function table(values) {
  return values.map((value) => fmt(clamp(value, 0, 1))).join(" ");
}

function smoothMaskValues(threshold, softness, { invert = false, samples = 129 } = {}) {
  return Array.from({ length: samples }, (_, index) => {
    const luma = index / (samples - 1);
    let selected;
    if (softness <= 0) selected = luma < threshold ? 1 : 0;
    else selected = 1 - smoothstep((luma - (threshold - softness / 2)) / softness);
    return invert ? 1 - selected : selected;
  });
}

function grayFor(frame, { opaque = false } = {}) {
  return `<feColorMatrix in="SourceGraphic" type="matrix" values="${grayMatrix({ opaque })}" result="postFxGray"/>`;
}

function colorRamp(frame, { shadow, highlight, midpoint = 0.5, contrast = 1, levels = null, input = "SourceGraphic", result = "postFxColorRamp" }) {
  // A stretched luma range needs a finer table; 33 entries keep older drawings exact.
  const size = levels ? 65 : 33;
  const channels = [shadow[0], shadow[1], shadow[2]].map((start, channelIndex) => {
    const end = highlight[channelIndex];
    return Array.from({ length: size }, (_, index) => {
      const luma = normalizeLuma(index / (size - 1), levels);
      const adjusted = clamp((luma - midpoint) * contrast + midpoint, 0, 1);
      return (start + (end - start) * adjusted) / 255;
    });
  });
  return [
    `<feColorMatrix in="${input}" type="matrix" values="${grayMatrix()}" result="postFxRampLuma"/>`,
    `<feComponentTransfer in="postFxRampLuma" result="${result}"><feFuncR type="table" tableValues="${table(channels[0])}"/><feFuncG type="table" tableValues="${table(channels[1])}"/><feFuncB type="table" tableValues="${table(channels[2])}"/></feComponentTransfer>`,
  ];
}

function imagePrimitive(frame, uri, result) {
  const { x, y, width, height } = frame.bounds;
  return `<feImage href="${uri}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none" result="${result}"/>`;
}

function binaryMaskPrimitives(lumaInput, thresholdMap, { invert = false } = {}) {
  const primitives = [];
  const comparisonInput = invert ? "postFxInvertedLuma" : lumaInput;
  if (invert) primitives.push(`<feComponentTransfer in="${lumaInput}" result="${comparisonInput}"><feFuncR type="linear" slope="-1" intercept="1"/><feFuncG type="linear" slope="-1" intercept="1"/><feFuncB type="linear" slope="-1" intercept="1"/></feComponentTransfer>`);
  primitives.push(
    // Opaque inputs keep arithmetic alpha at one: 1 + luma - threshold.
    // A steep transfer cuts at one (ties classify as light) without creating a
    // half-alpha intermediate that would unpremultiply the comparison colors.
    // Since the map and Rec.709 value are 8-bit, the exact threshold tie may
    // vary by one byte across rasterizers.
    `<feComposite in="${comparisonInput}" in2="${thresholdMap}" operator="arithmetic" k1="0" k2="1" k3="-1" k4="1" result="postFxCenteredCompare"/>`,
    '<feComponentTransfer in="postFxCenteredCompare" result="postFxBinaryCompare"><feFuncR type="linear" slope="1000" intercept="-999"/><feFuncG type="linear" slope="1000" intercept="-999"/><feFuncB type="linear" slope="1000" intercept="-999"/><feFuncA type="table" tableValues="1 1"/></feComponentTransfer>',
    '<feColorMatrix in="postFxBinaryCompare" type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0" result="postFxLightMask"/>',
  );
  return primitives;
}

function selectedLumaMask(threshold, softness, contrast, { invert = false, result = "postFxSelection" } = {}) {
  const values = smoothMaskValues(threshold, softness, { invert });
  const slope = fmt(contrast), intercept = fmt((1 - contrast) / 2);
  const [red, green, blue] = LUMA;
  const matrix = [
    `${red} ${green} ${blue} 0 0`,
    `${red} ${green} ${blue} 0 0`,
    `${red} ${green} ${blue} 0 0`,
    "0 0 0 0 1",
  ].join(" ");
  const maskMatrix = [
    "0 0 0 0 0", "0 0 0 0 0", "0 0 0 0 0", "1 0 0 0 0",
  ].join(" ");
  return [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${matrix}" result="postFxSelectionLuma"/>`,
    `<feComponentTransfer in="postFxSelectionLuma" result="postFxSelectionContrast"><feFuncR type="linear" slope="${slope}" intercept="${intercept}"/><feFuncG type="linear" slope="${slope}" intercept="${intercept}"/><feFuncB type="linear" slope="${slope}" intercept="${intercept}"/></feComponentTransfer>`,
    `<feColorMatrix in="postFxSelectionContrast" type="matrix" values="${maskMatrix}" result="postFxSelectionInput"/>`,
    `<feComponentTransfer in="postFxSelectionInput" result="${result}"><feFuncA type="table" tableValues="${table(values)}"/></feComponentTransfer>`,
  ];
}

function compositeReplacement(primitives, selectionResult, replacementColor, result = "postFxReplaced") {
  const keepResult = `${result}KeepMask`;
  const inverseResult = `${result}InverseMask`;
  const replacementResult = `${result}Flood`;
  const selectedResult = `${result}Selected`;
  primitives.push(
    `<feComponentTransfer in="${selectionResult}" result="${inverseResult}"><feFuncA type="linear" slope="-1" intercept="1"/></feComponentTransfer>`,
    `<feComposite in="SourceGraphic" in2="${inverseResult}" operator="in" result="${keepResult}"/>`,
    `<feFlood flood-color="${rgb(replacementColor)}" result="${replacementResult}"/>`,
    `<feComposite in="${replacementResult}" in2="${selectionResult}" operator="in" result="${selectedResult}"/>`,
    `<feComposite in="${selectedResult}" in2="SourceAlpha" operator="in" result="${result}AlphaSafe"/>`,
    `<feComposite in="${keepResult}" in2="${result}AlphaSafe" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${result}"/>`,
  );
  return result;
}

function bayer8(x, y) {
  // Canonical 8x8 ordered threshold ranks, repeated over the layer-local grid.
  const rows = [
    [0, 48, 12, 60, 3, 51, 15, 63],
    [32, 16, 44, 28, 35, 19, 47, 31],
    [8, 56, 4, 52, 11, 59, 7, 55],
    [40, 24, 36, 20, 43, 27, 39, 23],
    [2, 50, 14, 62, 1, 49, 13, 61],
    [34, 18, 46, 30, 33, 17, 45, 29],
    [10, 58, 6, 54, 9, 57, 5, 53],
    [42, 26, 38, 22, 41, 25, 37, 21],
  ];
  return rows[((y % 8) + 8) % 8][((x % 8) + 8) % 8];
}

function luminanceMap(frame, key, valueAt) {
  return effectMapImage(frame, key, (x, y, width, height) => {
    const value = clamp(valueAt(x, y, width, height), 0, 1);
    const byte = Math.round(value * 255);
    return [byte, byte, byte, 255];
  }, { outside: [0, 0, 0, 255] });
}

function displacementChannel(value) {
  // Match periodicDisplacement's narrower, color-safe vector range. Chrome
  // reads X from alpha and Y from neutral grayscale; resvg needs opaque RG.
  return Math.round(127.5 + clamp(value, -1, 1) * 63.75);
}

function pixelateNeedsAffinePrewarp(bounds, matrix) {
  if (!Array.isArray(matrix) || matrix.length < 6 || !matrix.slice(0, 6).every(Number.isFinite)) return false;
  const [a, b, c, d, e, f] = matrix;
  const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = corners.map(([x]) => x), ys = corners.map(([, y]) => y);
  const region = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  const canKeepCellTile = a > 0 && d > 0 && Math.abs(b) + Math.abs(c) < 1e-12 &&
    region.every((value) => Math.abs(value - Math.round(value)) < 1e-9);
  return !canKeepCellTile;
}

/**
 * Original Bayer halftone. Subdivisions is the number of grid cells across the
 * longer layer side; each cell cycles an 8x8 rank matrix. Contrast pivots at
 * middle gray. The selected two-color result is explicitly masked by SourceAlpha
 * so antialiased and translucent edges keep their original coverage.
 */
export function renderDithering(frame) {
  const darkColor = color(frame?.parameters?.darkColor, "#000000");
  const lightColor = color(frame?.parameters?.lightColor, "#FFFFFF");
  const subdivisions = number(frame, "subdivisions", 200, 1, 2048, { integer: true });
  const contrast = number(frame, "contrast", 1.2, 0, 4);
  const { width, height } = frame.bounds;
  const cellSize = Math.max(width, height) / subdivisions;
  const thresholdUri = luminanceMap(frame,
    JSON.stringify(["postfx-bayer8-v1", subdivisions, width, height]),
    (x, y, mapWidth, mapHeight) => {
      const localX = (x + 0.5) * width / mapWidth;
      const localY = (y + 0.5) * height / mapHeight;
      const rank = bayer8(Math.floor(localX / cellSize), Math.floor(localY / cellSize));
      return (rank + 0.5) / 64;
    });
  const primitives = [
    grayFor(frame, { opaque: true }),
    contrastTransfer("postFxGray", contrast, "postFxDitherLuma"),
    imagePrimitive(frame, thresholdUri, "postFxThresholdMap"),
    ...binaryMaskPrimitives("postFxDitherLuma", "postFxThresholdMap"),
    '<feComponentTransfer in="postFxLightMask" result="postFxDarkMask"><feFuncA type="linear" slope="-1" intercept="1"/></feComponentTransfer>',
    '<feComposite in="postFxLightMask" in2="SourceAlpha" operator="in" result="postFxLightAlpha"/>',
    '<feComposite in="postFxDarkMask" in2="SourceAlpha" operator="in" result="postFxDarkAlpha"/>',
    `<feFlood flood-color="${rgb(lightColor)}" result="postFxLightFlood"/>`,
    '<feComposite in="postFxLightFlood" in2="postFxLightAlpha" operator="in" result="postFxLightLayer"/>',
    `<feFlood flood-color="${rgb(darkColor)}" result="postFxDarkFlood"/>`,
    '<feComposite in="postFxDarkFlood" in2="postFxDarkAlpha" operator="in" result="postFxDarkLayer"/>',
    '<feMerge><feMergeNode in="postFxDarkLayer"/><feMergeNode in="postFxLightLayer"/></feMerge>',
  ];
  return filterEffect(frame, primitives, { padding: 0, contain: true });
}

/**
 * Original circular halftone. Grid Repetition counts cells across the longer
 * layer side; Dot Scale is a fraction of the cell diameter in eighths. Luma
 * controls dot radius, while the independent color ramp interpolates shadow to
 * highlight. The alpha mask avoids turning transparent source pixels opaque.
 */
export function renderDotGrid(frame) {
  if (boolean(frame, "keepPicture", false)) return renderShadowHalftone(frame);
  const repetition = number(frame, "gridRepetition", 40, 1, 512, { integer: true });
  const dotScale = number(frame, "dotScale", 4, 0, 8);
  const contrast = number(frame, "contrast", 1.4, 0, 4);
  const invert = boolean(frame, "invertDetection", false);
  const shadow = color(frame?.parameters?.shadowColor, "#2A2A30");
  const highlight = color(frame?.parameters?.highlightColor, "#F5EFE4");
  const { width, height } = frame.bounds;
  const cellSize = Math.max(width, height) / repetition;
  const maxRadius = cellSize * dotScale / 16;
  const thresholdUri = luminanceMap(frame,
    JSON.stringify(["postfx-dotgrid-v1", repetition, dotScale, width, height]),
    (x, y, mapWidth, mapHeight) => {
      const localX = (x + 0.5) * width / mapWidth;
      const localY = (y + 0.5) * height / mapHeight;
      const centerX = (Math.floor(localX / cellSize) + 0.5) * cellSize;
      const centerY = (Math.floor(localY / cellSize) + 0.5) * cellSize;
      const radius = maxRadius > 0 ? Math.hypot(localX - centerX, localY - centerY) / maxRadius : Infinity;
      // Luma is compared with normalized radius: brighter cells create larger
      // disks, while an inverted detection map reverses that relationship.
      return maxRadius > 0 ? clamp(radius, 0, 1) : 1;
    });
  const primitives = [
    grayFor(frame, { opaque: true }),
    contrastTransfer("postFxGray", contrast, "postFxDotLuma"),
    imagePrimitive(frame, thresholdUri, "postFxDotThreshold"),
    ...binaryMaskPrimitives("postFxDotLuma", "postFxDotThreshold", { invert }),
    ...colorRamp(frame, { shadow, highlight, input: "SourceGraphic", result: "postFxDotColor" }),
    '<feComposite in="postFxDotColor" in2="postFxLightMask" operator="in"/>',
  ];
  return filterEffect(frame, primitives, { padding: 0, contain: true });
}

// Halftone over the picture (dot-grid keepPicture): fine round dots only where the picture is
// darker than `threshold` (where "highlights": lighter), the picture kept everywhere else. The
// defaults are measured on the recreate test's contest-a frame 848 (960 x 540), which has dots
// only in the dark magenta shadows of a light picture:
// - pitch: 5.7 px between dot centers at 540 high (FFT peak of three crops of the dotted shirt),
//   so 1.06% of the layer's height when dotPitch is 0 (auto);
// - angle: the dot rows ran at 30 to 39 degrees there; 45 is the usual print screen angle (a guess
//   between the two);
// - threshold 0.42: the dotted shirt reads luma 0.31 (0.35 between dots), the undotted pink 0.51
//   and the white 0.78; dots grow from nothing at the threshold to dotScale's full size a quarter
//   of the threshold darker (the ramp is a guess fitted to the shirt's dot size);
// - color: dots are the picture multiplied by itself (204,14,135 measured on dots over a 228,38,159
//   shadow; a multiply gives 204,6,99), so they take each shadow's own hue. dotColor sets one color.
export const DOT_GRID_WHERE = Object.freeze(["shadows", "highlights"]);
const HALFTONE_PITCH_SHARE = 5.7 / 540;

/**
 * The dot grid's repeating tile: a rotated square grid repeats along x and y only when its
 * angle has tan = b / a for whole a and b; it then repeats every pitch x sqrt(a² + b²). The
 * angle snaps to the nearest such direction with a and b up to 4 (45 stays 45, 35 becomes 33.7)
 * and the pitch to a whole-pixel tile (5.7 at 45 degrees: tile 8, pitch 5.66).
 */
export function halftoneTile(pitch, degrees) {
  const turn = ((degrees % 90) + 90) % 90;
  let best = { a: 1, b: 0, error: Infinity };
  for (let a = 0; a <= 4; a += 1) for (let b = 0; b <= 4; b += 1) {
    if (!a && !b) continue;
    const at = Math.atan2(b, a) * 180 / Math.PI;
    const error = Math.min(Math.abs(at - turn), 90 - Math.abs(at - turn));
    if (error < best.error - 1e-9) best = { a, b, error };
  }
  const length = Math.hypot(best.a, best.b);
  const tile = Math.max(2, Math.round(pitch * length));
  return { tile, pitch: tile / length, cos: best.a / length, sin: best.b / length };
}

function renderShadowHalftone(frame) {
  const { x, y, width, height } = frame.bounds;
  const given = number(frame, "dotPitch", 0, 0, 512);
  // One exact tile repeated over the layer (feTile, as pixelate does): a whole-layer map is at
  // most 256 px wide, which drew 5.7 px dots as clumped square pixels with a moire beat (the
  // first proof measured 5.7 px in one crop, 12 in another).
  const { tile, pitch, cos, sin } = halftoneTile(Math.max(2, given > 0 ? given : height * HALFTONE_PITCH_SHARE),
    number(frame, "angle", 45, -360, 360));
  const dotScale = number(frame, "dotScale", 7, 0, 8);
  const threshold = number(frame, "threshold", 0.42, 0, 1);
  const highlights = frame?.parameters?.where === "highlights";
  const maxRadius = pitch * dotScale / 16;
  const cellBounds = { x, y, width: tile, height: tile };
  const fullField = Boolean(frame.helpers?.raster) && pixelateNeedsAffinePrewarp(cellBounds, frame.helpers?.transform);
  const radiusAt = (pixelX, pixelY, mapWidth, mapHeight) => {
    const localX = (pixelX + 0.5) * tile / mapWidth, localY = (pixelY + 0.5) * tile / mapHeight;
    const u = localX * cos + localY * sin, v = -localX * sin + localY * cos;
    const du = u - (Math.floor(u / pitch) + 0.5) * pitch, dv = v - (Math.floor(v / pitch) + 0.5) * pitch;
    // At least 0.03: a tone of 0 (ties count as a dot) draws no pixel at the cell centers.
    const value = maxRadius > 0 ? clamp(Math.hypot(du, dv) / maxRadius, 0.03, 1) : 1;
    const byte = Math.round(value * 255);
    return [byte, byte, byte, 255];
  };
  const key = JSON.stringify(["postfx-halftone-v2", fullField ? "full-field" : "tile", tile, fmt(cos), dotScale, width, height]);
  const tileMap = effectMapImage({ ...frame, bounds: fullField ? frame.bounds : cellBounds }, key, radiusAt,
    { outside: [255, 255, 255, 255], ...(fullField ? { repeatBounds: cellBounds } : {}) });
  const radiusField = fullField ? [imagePrimitive(frame, tileMap, "postFxDotRadius")] : [
    `<feImage href="${tileMap}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(tile)}" height="${fmt(tile)}" preserveAspectRatio="none" result="postFxDotCell"/>`,
    `<feTile in="postFxDotCell" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" result="postFxDotRadius"/>`,
  ];
  // Tone: 0 (no dot) at the threshold, up to 0.7 of dotScale's radius: the reference's dots are
  // about half the pitch across in its darkest shadow (looked at 4x; a first proof at 0.98 merged
  // a dark blob into one solid patch at 540 high).
  const span = Math.max(0.02, (highlights ? 1 - threshold : threshold) * 0.25);
  const tone = Array.from({ length: 129 }, (_, index) => {
    const luma = index / 128;
    return Math.min(0.7, clamp((highlights ? luma - threshold : threshold - luma) / span, 0, 1));
  });
  const dotColor = typeof frame?.parameters?.dotColor === "string" && frame.parameters.dotColor
    ? `<feFlood flood-color="${rgb(color(frame.parameters.dotColor, "#000000"))}" result="postFxInk"/>`
    : '<feBlend in="SourceGraphic" in2="SourceGraphic" mode="multiply" result="postFxInk"/>';
  const primitives = [
    grayFor(frame, { opaque: true }),
    `<feComponentTransfer in="postFxGray" result="postFxTone"><feFuncR type="table" tableValues="${table(tone)}"/><feFuncG type="table" tableValues="${table(tone)}"/><feFuncB type="table" tableValues="${table(tone)}"/></feComponentTransfer>`,
    ...radiusField,
    ...binaryMaskPrimitives("postFxTone", "postFxDotRadius"),
    dotColor,
    // A half-pixel soft edge so dots a few pixels wide read round, not as stair steps (a guess).
    '<feGaussianBlur in="postFxLightMask" stdDeviation="0.5" result="postFxSoftDots"/>',
    '<feComposite in="postFxInk" in2="postFxSoftDots" operator="in" result="postFxDots"/>',
    '<feMerge result="postFxHalftone"><feMergeNode in="SourceGraphic"/><feMergeNode in="postFxDots"/></feMerge>',
    '<feComposite in="postFxHalftone" in2="SourceAlpha" operator="in"/>',
  ];
  return filterEffect(frame, primitives, { padding: 0, contain: true });
}

/** A Rec.709 luminance ramp between two supplied colors, centered at Midpoint. */
export function renderDuotone(frame) {
  const midpoint = number(frame, "midpoint", 0.5, 0, 1);
  const contrast = number(frame, "contrast", 0.9, 0, 4);
  const shadow = color(frame?.parameters?.shadowColor, "#1400FF");
  const highlight = color(frame?.parameters?.highlightColor, "#FFE4E4");
  const levels = levelsFor(frame, { whenMissing: false });
  const keep = keepOf(frame?.parameters, hexRgb01);
  if (keep) {
    const tables = [0, 1, 2].map((channel) => Array.from({ length: 65 }, (_, index) => {
      const adjusted = clamp((index / 64 - midpoint) * contrast + midpoint, 0, 1);
      return (shadow[channel] + (highlight[channel] - shadow[channel]) * adjusted) / 255;
    }));
    return keptGrade(frame, "duotone-keep", tables, levels, keep);
  }
  return filterEffect(frame, colorRamp(frame, { shadow, highlight, midpoint, contrast, levels }), { padding: 0, contain: true });
}

// A luma grade given as three 65-entry tables (normalized luma -> 0..1 color), drawn as a 3D LUT
// so pixels in the keep range stay partly in their own color (relight.js).
function tableAt(column, value) {
  const at = clamp(value, 0, 1) * (column.length - 1);
  const index = Math.min(column.length - 2, Math.floor(at));
  return column[index] + (column[index + 1] - column[index]) * (at - index);
}

function keptGradeColor(r, g, b, { tables, levels, keep }) {
  const source = [r, g, b];
  const normalized = normalizeLuma(lumaOf(source), levels);
  return withKeep(source, tables.map((column) => tableAt(column, normalized)), keep, normalized);
}

function keptGrade(frame, name, tables, levels, keep) {
  return renderFunctionLut(frame, { name, color: keptGradeColor, parameters: { tables, levels, keep }, size: 33 });
}

/**
 * Original low-luma highlight overlay. Luma Threshold selects darker values;
 * Fuzz Width is a smooth transition in normalized sRGB luma and Fuzz Intensity
 * is the blend amount toward Color (white by default). Partitioned source/flood pixels are added with an
 * arithmetic composite so source alpha is preserved exactly.
 */
export function renderLumaHighlight(frame) {
  const threshold = number(frame, "lumaThreshold", 0.3, 0, 1);
  const fuzzWidth = number(frame, "fuzzWidth", 0.1, 0, 1);
  const intensity = number(frame, "fuzzIntensity", 0.9, 0, 1);
  if (intensity === 0) return frame.content;
  const primitives = selectedLumaMask(threshold, fuzzWidth, 1, { result: "postFxLumaSelection" });
  primitives.push(
    `<feComponentTransfer in="postFxLumaSelection" result="postFxBrightenSelection"><feFuncA type="linear" slope="${fmt(intensity)}"/></feComponentTransfer>`,
  );
  compositeReplacement(primitives, "postFxBrightenSelection", color(frame?.parameters?.color, "#FFFFFF"));
  return filterEffect(frame, primitives, { padding: 0, contain: true });
}

// Noise Mask's gray noise (in red) becomes alpha, then the threshold table keeps cells at or
// above Threshold, with an Edge Softness ramp.
const NOISE_TO_ALPHA = ["0 0 0 0 0", "0 0 0 0 0", "0 0 0 0 0", "1 0 0 0 0"].join(" ");

/**
 * Original fractal-noise alpha mask. Scale is roughly the number of broad noise
 * cycles across the layer; Seed selects a deterministic field; Edge Softness is
 * the threshold transition width. Cell Size above 0 switches to square cells of
 * that many pixels (see renderNoiseCells). The cached map is independent of the
 * animated threshold, so playback changes only the SVG transfer table.
 */
export function renderNoiseMask(frame) {
  const threshold = number(frame, "threshold", 0, 0, 1);
  const scale = number(frame, "scale", 0.55, 0.01, 16);
  const seed = number(frame, "seed", 0, -2_147_483_648, 2_147_483_647, { integer: true });
  const octaves = number(frame, "octaves", 4, 1, 8, { integer: true });
  const softness = number(frame, "edgeSoftness", 0.06, 0, 1);
  const cellSize = number(frame, "cellSize", 0, 0, 64, { integer: true });
  const values = smoothMaskValues(threshold, softness, { invert: true });
  if (cellSize > 0) return renderNoiseCells(frame, { cellSize, seed, octaves, values });
  const { width, height } = frame.bounds;
  const noiseUri = luminanceMap(frame,
    JSON.stringify(["postfx-noise-mask-v1", scale, seed, octaves, width, height]),
    (x, y, mapWidth, mapHeight) => {
      const u = (x + 0.5) / mapWidth, v = (y + 0.5) / mapHeight;
      return (fractalNoise(u * scale * 8, v * scale * 8, octaves, seed) + 1) / 2;
    });
  return filterEffect(frame, [
    imagePrimitive(frame, noiseUri, "postFxNoiseImage"),
    `<feColorMatrix in="postFxNoiseImage" type="matrix" values="${NOISE_TO_ALPHA}" result="postFxNoiseAlpha"/>`,
    `<feComponentTransfer in="postFxNoiseAlpha" result="postFxNoiseMask"><feFuncA type="table" tableValues="${table(values)}"/></feComponentTransfer>`,
    '<feComposite in="SourceGraphic" in2="postFxNoiseMask" operator="in"/>',
  ], { padding: 0, contain: true });
}

// Cell Size mode draws one seamless noise tile. Its map is at most 512 px (the largest map).
const NOISE_TILE_MAP_SIDE = 512;
const NOISE_TILE_MIN_CELLS = 16;

/**
 * How many cells the tile holds per side, and how many map pixels it uses per cell.
 * The tile grows (in powers of two, so a small size change keeps the same tile) until it
 * covers the layer's longer side, so the grain does not repeat on the layer. A cell needs at
 * least 2 map pixels (1 for 1 px cells) to keep the finer Octaves detail, so the tile holds at
 * most 256 cells (512 for 1 px cells): only layers longer than that see the grain repeat.
 * Each cell then gets as many map pixels as fit, for smooth large cells, but never more than
 * one per layer pixel.
 */
export function noiseTileSize(cellSize, bounds) {
  const longerSide = Math.max(bounds.width, bounds.height);
  const maxCells = NOISE_TILE_MAP_SIDE / Math.min(cellSize, 2);
  let cells = NOISE_TILE_MIN_CELLS;
  while (cells * cellSize < longerSide && cells < maxCells) cells *= 2;
  const pixelsPerCell = Math.min(cellSize, NOISE_TILE_MAP_SIDE / cells);
  return { cells, mapSide: cells * pixelsPerCell, side: cells * cellSize };
}

/**
 * Square noise cells `cellSize` layer pixels wide, whatever the layer's size. A whole-layer map
 * (at most 512 px wide) cannot hold 1 px film grain on a 1080×1920 layer, so a seamless tile
 * fills the layer as an SVG pattern instead. The browser and the native export both repeat,
 * scale and rotate a pattern themselves, so the cells stay square and fine on every layer.
 * The pattern fills an alpha mask; a filter on it applies the same threshold table as above.
 */
function renderNoiseCells(frame, { cellSize, seed, octaves, values }) {
  const { cells, mapSide, side } = noiseTileSize(cellSize, frame.bounds);
  const tileUri = cachedMap(JSON.stringify(["postfx-noise-cells-v2", cells, mapSide, seed, octaves]), mapSide, mapSide,
    (pixelX, pixelY) => {
      // Sample at pixel corners: a 1 px cell is then exactly one random value, where pixel
      // centers would average four neighbouring values and blur the grain.
      const noise = fractalNoise(pixelX * cells / mapSide, pixelY * cells / mapSide, octaves, seed, cells);
      const byte = Math.round(clamp((noise + 1) / 2, 0, 1) * 255);
      return [byte, byte, byte, 255];
    });
  const { x, y, width, height } = frame.bounds;
  const area = `x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}"`;
  const patternId = frame.helpers.id("noise-cells"), filterId = frame.helpers.id("noise-threshold");
  const maskId = frame.helpers.id("noise-mask");
  frame.helpers.defs.push(
    `<pattern id="${patternId}" patternUnits="userSpaceOnUse" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(side)}" height="${fmt(side)}"><image href="${tileUri}" width="${fmt(side)}" height="${fmt(side)}" preserveAspectRatio="none"/></pattern>`,
    `<filter id="${filterId}" ${area} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${NOISE_TO_ALPHA}"/><feComponentTransfer><feFuncA type="table" tableValues="${table(values)}"/></feComponentTransfer></filter>`,
    // resvg 2.6.2 reads mask-type only as an attribute; from a style it falls back to luminance.
    `<mask id="${maskId}" mask-type="alpha" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ${area}><rect ${area} fill="url(#${patternId})" filter="url(#${filterId})"/></mask>`,
  );
  // Like filterEffect's contain: nothing outside the layer box is painted.
  frame.helpers.includeBounds?.(frame.bounds);
  return `<g mask="url(#${maskId})">${frame.helpers.clipSentinel?.() ?? ""}${frame.content}</g>`;
}

/**
 * Original nearest-cell mosaic. Pixel Size is snapped to Pixel Size Step. The
 * browser tiles a static single-cell map; native export prewarps a full periodic
 * field when an affine transform makes a single transformed cell unsafe to tile.
 * Optional noise gates whole cells, with Noise Scale controlling the field.
 */
export function renderPixelate(frame) {
  const requestedSize = number(frame, "pixelSize", 1, 1, 128);
  const step = number(frame, "pixelSizeStep", 1, 1, 128);
  const cellSize = Math.max(1, Math.round(requestedSize / step) * step);
  const useNoise = boolean(frame, "noiseEnabled", false);
  const seed = number(frame, "seed", 17, 0, 1_000_000, { integer: true });
  const noiseScale = number(frame, "noiseScale", 1, 0.01, 16);
  const noiseThreshold = number(frame, "noiseThreshold", 0.5, 0, 1);
  if (cellSize <= 1) return frame.content;
  const maxShift = cellSize / 2;
  const { x, y, width, height } = frame.bounds;
  const rasterMap = Boolean(frame.helpers?.raster);
  const cellBounds = { x, y, width: cellSize, height: cellSize };
  const fullField = rasterMap && pixelateNeedsAffinePrewarp(cellBounds, frame.helpers?.transform);
  const layout = fullField ? "full-field" : "cell-tile";
  const cacheKey = JSON.stringify(["postfx-pixelate-v5", layout, rasterMap ? "opaque-rg" : "gray-alpha", cellSize, useNoise, noiseScale, noiseThreshold, width, height, seed]);
  const mapBounds = fullField ? frame.bounds : cellBounds;
  const cellMap = effectMapImage({ ...frame, bounds: mapBounds }, `${cacheKey}|cell`, (pixelX, pixelY, mapWidth, mapHeight) => {
    const localX = (pixelX + 0.5) * cellSize / mapWidth;
    const localY = (pixelY + 0.5) * cellSize / mapHeight;
    const center = cellSize / 2;
    const dx = clamp((center - localX) / maxShift, -1, 1);
    const dy = clamp((center - localY) / maxShift, -1, 1);
    const encodedX = displacementChannel(dx), encodedY = displacementChannel(dy);
    return rasterMap
      ? [encodedX, encodedY, 128, 255]
      : [encodedY, encodedY, encodedY, encodedX];
  }, {
    outside: rasterMap ? [128, 128, 128, 255] : [128, 128, 128, 128],
    ...(fullField ? { repeatBounds: cellBounds } : {}),
  });
  const primitives = fullField ? [
    `<feImage href="${cellMap}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none" result="postFxPixelField"/>`,
  ] : [
    `<feImage href="${cellMap}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(cellSize)}" height="${fmt(cellSize)}" preserveAspectRatio="none" result="postFxPixelCell"/>`,
    `<feTile in="postFxPixelCell" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" result="postFxPixelTile"/>`,
  ];
  let displacementMap = fullField ? "postFxPixelField" : "postFxPixelTile";
  if (useNoise) {
    const gate = effectMapImage(frame, `${cacheKey}|gate`, (pixelX, pixelY, mapWidth, mapHeight) => {
      const localX = (pixelX + 0.5) * width / mapWidth;
      const localY = (pixelY + 0.5) * height / mapHeight;
      const cellX = Math.floor(localX / cellSize), cellY = Math.floor(localY / cellSize);
      const value = (fractalNoise(cellX * noiseScale, cellY * noiseScale, 3, seed) + 1) / 2;
      const byte = value > noiseThreshold ? 255 : 0;
      return [byte, byte, byte, 255];
    }, { outside: [0, 0, 0, 255] });
    primitives.push(
      imagePrimitive(frame, gate, "postFxPixelNoiseGate"),
      `<feComposite in="${displacementMap}" in2="postFxPixelNoiseGate" operator="arithmetic" k1="1" k2="0" k3="-0.5" k4="0.5" result="postFxPixelGateMix"/>`,
      '<feComponentTransfer in="postFxPixelGateMix" result="postFxPixelGateMap"><feFuncA type="table" tableValues="1 1"/></feComponentTransfer>',
    );
    displacementMap = "postFxPixelGateMap";
  }
  let scale = 4 * maxShift;
  let xChannelSelector = rasterMap ? "R" : "A";
  let yChannelSelector = rasterMap ? "G" : "R";
  if (rasterMap && Array.isArray(frame.helpers.transform)) {
    const [a, b, c, d] = frame.helpers.transform;
    const sx = Math.hypot(a, c), sy = Math.hypot(b, d);
    const ax = sx > 1e-12 ? a / sx : 0, cx = sx > 1e-12 ? c / sx : 0;
    const by = sy > 1e-12 ? b / sy : 0, dy = sy > 1e-12 ? d / sy : 0;
    const factor = Math.max(1, Math.abs(ax) + Math.abs(cx), Math.abs(by) + Math.abs(dy));
    const ar = ax / factor, cr = cx / factor, br = by / factor, dr = dy / factor;
    if (Math.abs(ar - 1) + Math.abs(cr) + Math.abs(br) + Math.abs(dr - 1) > 1e-12) {
      primitives.push(`<feColorMatrix in="${displacementMap}" type="matrix" values="${ar} ${cr} 0 0 ${0.5 * (1 - ar - cr)} ${br} ${dr} 0 0 ${0.5 * (1 - br - dr)} 0 0 1 0 0 0 0 0 1 0" result="postFxPixelTransformedMap"/>`);
      displacementMap = "postFxPixelTransformedMap";
      scale *= factor;
    }
  }
  primitives.push(`<feDisplacementMap in="SourceGraphic" in2="${displacementMap}" scale="${fmt(scale)}" xChannelSelector="${xChannelSelector}" yChannelSelector="${yChannelSelector}"/>`);
  return filterEffect(frame, primitives, { padding: maxShift + 1 });
}

/**
 * Original one-sided luminance recolor. Contrast pivots at middle gray, the
 * threshold selects the lower or upper side, and Softness controls the blend
 * band. Complementary color contributions are added to preserve source alpha.
 */
export function renderThresholdColor(frame) {
  const contrast = number(frame, "contrast", 1.25, 0, 4);
  const threshold = number(frame, "colorThreshold", 0.5, 0, 1);
  const softness = number(frame, "softness", 0, 0, 1);
  const invertLuma = boolean(frame, "invertLuma", true);
  const replacement = color(frame?.parameters?.defaultColor, "#6F6645");
  const primitives = selectedLumaMask(threshold, softness, contrast, {
    invert: !invertLuma, result: "postFxThresholdSelection",
  });
  compositeReplacement(primitives, "postFxThresholdSelection", replacement);
  return filterEffect(frame, primitives, { padding: 0, contain: true });
}

function tritoneAt(value, stops, softness) {
  const [first, second] = stops;
  const gap = Math.max(1e-6, second - first);
  const width = Math.min(softness, gap);
  const half = width / 2;
  const start1 = first - half, end1 = first + half;
  const start2 = second - half, end2 = second + half;
  if (value <= start1) return 0;
  if (value < end1) return smoothstep((value - start1) / width) / 2;
  if (value <= start2) return 0.5;
  if (value < end2) return 0.5 + smoothstep((value - start2) / width) / 2;
  return 1;
}

/** Original three-stop Rec.709 luminance grade with two bounded soft transitions. */
export function renderTritone(frame) {
  const threshold1 = number(frame, "threshold1", 0.33, 0, 1);
  const threshold2 = number(frame, "threshold2", 0.66, 0, 1);
  const contrast = number(frame, "contrast", 1, 0, 4);
  const softness = number(frame, "softness", 0.35, 0, 1);
  const shadow = color(frame?.parameters?.shadowColor, "#1A1033");
  const midtone = color(frame?.parameters?.midtoneColor, "#E94F64");
  const highlight = color(frame?.parameters?.highlightColor, "#FFE9B0");
  const [low, high] = threshold1 <= threshold2 ? [threshold1, threshold2] : [threshold2, threshold1];
  const colors = [shadow, midtone, highlight];
  const levels = levelsFor(frame, { whenMissing: false });
  const keep = keepOf(frame?.parameters, hexRgb01);
  const tables = [0, 1, 2].map((channel) => Array.from({ length: 65 }, (_, index) => {
    // Kept grades normalize inside their 3D LUT (keptGradeColor), so their tables stay plain.
    const input = keep ? index / 64 : normalizeLuma(index / 64, levels);
    const adjusted = clamp((input - 0.5) * contrast + 0.5, 0, 1);
    const mix = tritoneAt(adjusted, [low, high], softness);
    const firstStart = low - Math.min(softness, high - low) / 2;
    const firstEnd = low + Math.min(softness, high - low) / 2;
    const secondStart = high - Math.min(softness, high - low) / 2;
    let value;
    if (adjusted <= firstStart) value = colors[0][channel];
    else if (adjusted < firstEnd) value = colors[0][channel] + (colors[1][channel] - colors[0][channel]) * smoothstep((adjusted - firstStart) / Math.max(1e-6, firstEnd - firstStart));
    else if (adjusted <= secondStart) value = colors[1][channel];
    else value = colors[1][channel] + (colors[2][channel] - colors[1][channel]) * (mix - 0.5) * 2;
    return value / 255;
  }));
  if (keep) return keptGrade(frame, "tritone-keep", tables, levels, keep);
  return filterEffect(frame, [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${grayMatrix()}" result="postFxTritoneLuma"/>`,
    `<feComponentTransfer in="postFxTritoneLuma"><feFuncR type="table" tableValues="${table(tables[0])}"/><feFuncG type="table" tableValues="${table(tables[1])}"/><feFuncB type="table" tableValues="${table(tables[2])}"/></feComponentTransfer>`,
  ], { padding: 0, contain: true });
}

function rasterOffset(frame, dx, dy) {
  if (!frame.helpers?.raster || !Array.isArray(frame.helpers.transform)) return { dx, dy };
  const [a, b, c, d] = frame.helpers.transform;
  const xScale = Math.hypot(a, c), yScale = Math.hypot(b, d);
  return {
    dx: xScale > 1e-12 ? (a * dx + c * dy) / xScale : 0,
    dy: yScale > 1e-12 ? (b * dx + d * dy) / yScale : 0,
  };
}

/**
 * Original RGB channel split. Amount is a normalized value multiplied by 10%
 * of the shorter layer side; Direction is degrees (the reference semantics are
 * unverified). Red and blue move in opposite directions, green stays in place.
 * Overflow off clips explicitly to the layer box because resvg ignores the
 * filter primitive subregion for feOffset.
 */
export function renderRgbShift(frame) {
  const amount = number(frame, "amount", 0.25, 0, 1);
  const direction = number(frame, "direction", 0, -360, 360) * Math.PI / 180;
  const overflow = boolean(frame, "overflow", false);
  const { width, height } = frame.bounds;
  const distance = amount * Math.min(width, height) * 0.1;
  if (distance === 0) return frame.content;
  let dx = distance * Math.cos(direction), dy = distance * Math.sin(direction);
  ({ dx, dy } = rasterOffset(frame, dx, dy));
  const padding = Math.hypot(dx, dy) + 1;
  const paintBounds = frame.paintBounds ?? frame.bounds;
  const primitiveRegion = {
    x: paintBounds.x - padding,
    y: paintBounds.y - padding,
    width: paintBounds.width + 2 * padding,
    height: paintBounds.height + 2 * padding,
  };
  const extent = `x="${fmt(primitiveRegion.x)}" y="${fmt(primitiveRegion.y)}" width="${fmt(primitiveRegion.width)}" height="${fmt(primitiveRegion.height)}"`;
  const channelMatrix = (channel) => [
    channel === 0 ? "1 0 0 0 0" : "0 0 0 0 0",
    channel === 1 ? "0 1 0 0 0" : "0 0 0 0 0",
    channel === 2 ? "0 0 1 0 0" : "0 0 0 0 0",
    "0 0 0 1 0",
  ].join(" ");
  const alphaGrayMatrix = [
    "0 0 0 1 0", "0 0 0 1 0", "0 0 0 1 0", "0 0 0 0 1",
  ].join(" ");
  const blackFromRedAlpha = ["0 0 0 0 0", "0 0 0 0 0", "0 0 0 0 0", "1 0 0 0 0"].join(" ");
  const blackFromSourceAlpha = ["0 0 0 0 0", "0 0 0 0 0", "0 0 0 0 0", "0 0 0 1 0"].join(" ");
  // Each channel moves along the direction (1), against it (-1) or stays (0). red-blue is the
  // split from before `colors` existed (its markup is unchanged).
  const moves = RGB_SHIFT_COLORS[RGB_SHIFT_COLORS[frame.parameters?.colors] ? frame.parameters.colors : "red-blue"];
  const names = ["Red", "Green", "Blue"].map((name, index) => moves[index] ? `postFx${name}Shift` : `postFx${name}Channel`);
  const primitives = [];
  ["Red", "Green", "Blue"].forEach((name, index) => {
    primitives.push(`<feColorMatrix in="SourceGraphic" type="matrix" values="${channelMatrix(index)}" result="postFx${name}Channel"/>`);
    if (moves[index]) primitives.push(`<feOffset in="postFx${name}Channel" ${extent} dx="${fmt(moves[index] * dx)}" dy="${fmt(moves[index] * dy)}" result="postFx${name}Shift"/>`);
  });
  const edges = frame.parameters?.where === "edges";
  // Pixel layers (video, image) go on past their box, so the band the shift uncovers along the
  // box keeps the picture unshifted there. Without it the shift painted a cyan and a yellow bar at
  // the frame edges (GAPS item 10, contest-a p875: saturation 82 against 128).
  const pixelLayer = ["video", "image"].includes(frame.helpers?.layerType);
  const finish = edges || pixelLayer ? ' result="postFxShifted"' : "";
  primitives.push(
    `<feComposite in="${names[0]}" in2="${names[1]}" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="postFxRedGreen"/>`,
    `<feComposite in="postFxRedGreen" in2="${names[2]}" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="postFxRgbSum"/>`,
    ...names.map((input, index) => `<feColorMatrix in="${input}" type="matrix" values="${alphaGrayMatrix}" result="postFx${["Red", "Green", "Blue"][index]}AlphaGray"/>`),
    '<feBlend in="postFxRedAlphaGray" in2="postFxGreenAlphaGray" mode="lighten" result="postFxMaxRedGreenAlpha"/>',
    '<feBlend in="postFxMaxRedGreenAlpha" in2="postFxBlueAlphaGray" mode="lighten" result="postFxMaxAlphaGray"/>',
    `<feColorMatrix in="postFxMaxAlphaGray" type="matrix" values="${blackFromRedAlpha}" result="postFxMaxAlphaMask"/>`,
    `<feColorMatrix in="postFxRgbSum" type="matrix" values="${blackFromSourceAlpha}" result="postFxSumAlphaMask"/>`,
    '<feComposite in="postFxSumAlphaMask" in2="postFxMaxAlphaMask" operator="arithmetic" k1="0" k2="1" k3="-1" k4="0" result="postFxBlackExcess"/>',
    `<feComposite in="postFxRgbSum" in2="postFxBlackExcess" operator="arithmetic" k1="0" k2="1" k3="-1" k4="0"${finish}/>`,
  );
  let stage = "postFxShifted", reach = Math.hypot(dx, dy);
  if (edges) {
    // Only where the picture has an edge: the range of luma and of alpha within `edgeWidth` of
    // each point (dilate minus erode), above `edgeThreshold`, softened, picks the shifted
    // picture; elsewhere the layer stays as it was. Alpha counts so that text and shapes fringe
    // along their outlines. edgeWidth 0 follows the shift, so the band covers the whole fringe.
    const threshold = number(frame, "edgeThreshold", 0.1, 0, 1);
    const radius = number(frame, "edgeWidth", 0, 0, 64) || Math.max(1, distance);
    // Full fringe 0.2 above the threshold (a guess; edgeThreshold moves the whole ramp).
    const slope = 5;
    reach = Math.max(reach, radius * 1.7);
    let shifted = "postFxShifted";
    if (!pixelLayer) {
      // A layer over transparency (text, shapes) has no picture behind it to split, so dark type
      // fringed only as a black doubling with no color (film-trailer r2-040, checked 2026-11-11).
      // Where a channel's copy covers and another's does not, that missing channel is filled
      // with 1 minus the brightest luma nearby: dark type gets the complement colors a split of
      // a light card behind it would show (cyan and yellow for red-blue), light type keeps the
      // channel colors (red and blue). Inside the shape every copy covers, so it stays as it was.
      shifted = "postFxShiftedTinted";
      primitives.push(
        '<feFlood flood-color="#000000" flood-opacity="1" result="postFxBlack"/>',
        '<feComposite in="postFxShifted" in2="postFxBlack" operator="over" result="postFxShiftedOnBlack"/>',
        ...["Red", "Green", "Blue"].map((name) => `<feBlend in="postFxMaxAlphaGray" in2="postFx${name}AlphaGray" mode="difference" result="postFx${name}Missing"/>`),
        ...["Red", "Green", "Blue"].map((name, index) => `<feColorMatrix in="postFx${name}Missing" type="matrix" values="${channelMatrix(index).replace(/0 0 0 1 0$/, "0 0 0 0 1")}" result="postFx${name}MissingOnly"/>`),
        '<feBlend in="postFxRedMissingOnly" in2="postFxGreenMissingOnly" mode="lighten" result="postFxRedGreenMissing"/>',
        '<feBlend in="postFxRedGreenMissing" in2="postFxBlueMissingOnly" mode="lighten" result="postFxMissing"/>',
        '<feComposite in="SourceGraphic" in2="postFxBlack" operator="over" result="postFxSourceOnBlack"/>',
        '<feColorMatrix in="postFxSourceOnBlack" type="matrix" values="-0.2126 -0.7152 -0.0722 0 1 -0.2126 -0.7152 -0.0722 0 1 -0.2126 -0.7152 -0.0722 0 1 0 0 0 0 1" result="postFxDarkness"/>',
        `<feMorphology in="postFxDarkness" operator="erode" radius="${fmt(radius)}" result="postFxComplement"/>`,
        '<feBlend in="postFxMissing" in2="postFxComplement" mode="multiply" result="postFxFill"/>',
        '<feComposite in="postFxShiftedOnBlack" in2="postFxFill" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="postFxTintedOpaque"/>',
        `<feComposite in="postFxTintedOpaque" in2="postFxMaxAlphaMask" operator="in" result="${shifted}"/>`,
      );
    }
    primitives.push(
      '<feColorMatrix in="SourceGraphic" type="matrix" values="0.2126 0.7152 0.0722 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 1" result="postFxEdgeLuma"/>',
      `<feMorphology in="postFxEdgeLuma" operator="dilate" radius="${fmt(radius)}" result="postFxEdgeHigh"/>`,
      `<feMorphology in="postFxEdgeLuma" operator="erode" radius="${fmt(radius)}" result="postFxEdgeLow"/>`,
      '<feColorMatrix in="postFxEdgeLow" type="matrix" values="-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0" result="postFxEdgeLowInverse"/>',
      '<feComposite in="postFxEdgeHigh" in2="postFxEdgeLowInverse" operator="arithmetic" k1="0" k2="1" k3="1" k4="-1" result="postFxEdgeRange"/>',
      `<feColorMatrix in="postFxEdgeRange" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${slope} ${slope} 0 0 ${fmt(-slope * threshold)}" result="postFxEdgeMask"/>`,
      `<feGaussianBlur in="postFxEdgeMask" stdDeviation="${fmt(radius * 0.35)}" result="postFxEdgeSoft"/>`,
      `<feComposite in="${shifted}" in2="postFxEdgeSoft" operator="in" result="postFxEdgeFringe"/>`,
      '<feComposite in="SourceGraphic" in2="postFxEdgeSoft" operator="out" result="postFxEdgeRest"/>',
      `<feComposite in="postFxEdgeFringe" in2="postFxEdgeRest" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"${pixelLayer ? ' result="postFxEdged"' : ""}/>`,
    );
    stage = "postFxEdged";
  }
  if (pixelLayer) primitives.push(
    `<feMorphology in="SourceAlpha" operator="erode" radius="${fmt(reach + 1)}" result="postFxInset"/>`,
    `<feComposite in="${stage}" in2="postFxInset" operator="in" result="postFxInner"/>`,
    '<feComposite in="SourceGraphic" in2="postFxInset" operator="out" result="postFxOuter"/>',
    '<feComposite in="postFxInner" in2="postFxOuter" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>',
  );
  return filterEffect(frame, primitives, { padding, contain: !overflow });
}

// Which channels move with the direction (1), against it (-1) or stay (0). The pair names the
// two fringe colors: green-magenta is the green and purple line fringe of GAPS item 10
// (contest-a p875); red-blue (red and blue apart, green still) gives the cyan-left,
// orange-right fringe on title letters (film-trailer r2-040).
export const RGB_SHIFT_COLORS = Object.freeze({
  "red-blue": [1, 0, -1], "green-magenta": [-1, 1, -1], "red-cyan": [1, -1, -1], "blue-yellow": [-1, -1, 1],
});
