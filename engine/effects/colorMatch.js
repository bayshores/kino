// Shot color match (the match_color op): the grade that makes one shot's color match a reference
// shot, written as kino's own color-wheels and hue-saturation effects so it stays an ordinary,
// editable grade.
//
// Ported from ArtCraft's FilmCraft (github.com/storytold, MIT OR Apache-2.0, © the ArtCraft
// authors), filmcraft/crates/render/src/color_match.rs: `oklab`, `tonal_weights`, `skin_weight`,
// `stats`, `residuals`, `solve` and `solve_linear`. The method:
//   1. Both frames are small (at most 96 px wide) and converted to Oklab (L lightness, a and b color).
//   2. Each pixel is weighted into shadows, midtones and highlights by its L; per range the mean
//      L, a and b, plus the mean chroma (saturation) of the whole frame.
//   3. Skin pixels count a fifth in the color means, so a face does not drive the cast; after the
//      solve the cast is scaled down until the shot's skin hue moves at most 8 degrees.
//   4. The grade is solved by Levenberg-Marquardt through the real grade, with a small penalty that
//      keeps it minimal when the shots already match.
// kino's changes: the unknowns are color-wheels' lift, gamma and gain for each channel and
// hue-saturation's saturation (FilmCraft solves Lumetri's wheels), graded on sRGB values as kino's
// filters are (engine/effects/colorMath.js).
import { liftGammaGain, saturationMatrix, srgbToLinear } from "./colorMath.js";

/** Wider frames are shrunk to this before matching (FilmCraft's 96 px). */
export const MATCH_WIDTH = 96;
// Unknowns: lift, gamma and gain offsets for red, green and blue, then saturation − 1.
const UNKNOWNS = 10;
const LIMIT = 0.5;
const REGULARIZE = 0.02;

/** Linear sRGB-primaries RGB → Oklab [L, a, b] (Björn Ottosson, 2020). FilmCraft `oklab`. */
export function oklab([red, green, blue]) {
  const [r, g, b] = [red, green, blue].map((value) => Math.max(0, value));
  const l = Math.cbrt(0.41222147 * r + 0.53633255 * g + 0.051445995 * b);
  const m = Math.cbrt(0.2119035 * r + 0.6806995 * g + 0.10739696 * b);
  const s = Math.cbrt(0.08830246 * r + 0.28171885 * g + 0.6299787 * b);
  return [
    0.21045426 * l + 0.7936178 * m - 0.004072047 * s,
    1.9779985 * l - 2.4285922 * m + 0.4505937 * s,
    0.025904037 * l + 0.78277177 * m - 0.80867577 * s,
  ];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Shadow, midtone and highlight weights of an Oklab lightness. FilmCraft `tonal_weights`. */
export function tonalWeights(lightness) {
  const shadows = smoothstep(0.55, 0.15, lightness), highlights = smoothstep(0.45, 0.85, lightness);
  return [shadows, Math.max(0, 1 - shadows - highlights), highlights];
}

/** How much an Oklab color looks like skin, 0 to 1. FilmCraft `skin_weight`. */
export function skinWeight([lightness, a, b]) {
  const chroma = Math.hypot(a, b);
  if (chroma < 0.02 || chroma > 0.2 || lightness < 0.25 || lightness > 0.92) return 0;
  const hue = Math.atan2(b, a) * 180 / Math.PI;
  const off = hue < 20 ? 20 - hue : hue > 75 ? hue - 75 : 0;
  return Math.min(1, Math.max(0, 1 - off / 10));
}

/**
 * The 8-bit sRGB values of frames ({width, height, data: RGBA bytes}), as one Uint8Array of
 * [r, g, b] triplets; transparent pixels are left out.
 */
export function framePixels(frames) {
  const list = [];
  for (const frame of frames) {
    for (let index = 0; index + 3 < frame.data.length; index += 4) {
      if (frame.data[index + 3] < 8) continue;
      list.push(frame.data[index], frame.data[index + 1], frame.data[index + 2]);
    }
  }
  return Uint8Array.from(list);
}

/** The grade of the unknowns `x` as 256-entry tables per channel and a saturation matrix. */
function gradeOf(x) {
  const tables = [0, 1, 2].map((channel) => {
    const table = new Float64Array(256);
    for (let value = 0; value < 256; value += 1) table[value] = liftGammaGain(value / 255, x[channel], 1 + x[3 + channel], 1 + x[6 + channel]);
    return table;
  });
  return { tables, matrix: saturationMatrix(1 + x[9]) };
}

const LINEAR = Float64Array.from({ length: 4096 }, (_, index) => srgbToLinear(index / 4095));
const toLinear = (value) => LINEAR[Math.round(Math.min(1, Math.max(0, value)) * 4095)];

/**
 * Statistics of pixels (framePixels), graded by `x` when given: per tonal range [weight, mean L,
 * mean a, mean b], the mean chroma, and the skin pixels' mean [a, b, weight]. FilmCraft `stats`.
 */
export function colorStats(pixels, x = null, { skinProtect = true } = {}) {
  const grade = x ? gradeOf(x) : null;
  const sums = [0, 1, 2].map(() => [0, 0, 0, 0, 0]);
  let chroma = 0, chromaWeight = 0;
  const skin = [0, 0, 0];
  const count = pixels.length / 3;
  for (let index = 0; index < pixels.length; index += 3) {
    let rgb = [pixels[index] / 255, pixels[index + 1] / 255, pixels[index + 2] / 255];
    if (grade) {
      const graded = [grade.tables[0][pixels[index]], grade.tables[1][pixels[index + 1]], grade.tables[2][pixels[index + 2]]];
      rgb = grade.matrix.map((row) => row[0] * graded[0] + row[1] * graded[1] + row[2] * graded[2]);
    }
    const lab = oklab(rgb.map(toLinear));
    const skinness = skinWeight(lab);
    const colorWeight = skinProtect ? 1 - 0.8 * skinness : 1;
    const weights = tonalWeights(lab[0]);
    for (let band = 0; band < 3; band += 1) {
      const weight = weights[band], sum = sums[band];
      sum[0] += weight; sum[1] += weight * lab[0];
      sum[2] += weight * colorWeight * lab[1]; sum[3] += weight * colorWeight * lab[2]; sum[4] += weight * colorWeight;
    }
    chroma += colorWeight * Math.hypot(lab[1], lab[2]); chromaWeight += colorWeight;
    skin[0] += skinness * lab[1]; skin[1] += skinness * lab[2]; skin[2] += skinness;
  }
  const total = Math.max(1, count);
  return {
    bands: sums.map(([weight, l, a, b, colorWeight]) => [weight / total, l / Math.max(1e-9, weight), a / Math.max(1e-9, colorWeight), b / Math.max(1e-9, colorWeight)]),
    chroma: chroma / Math.max(1e-9, chromaWeight),
    skin: [skin[0] / Math.max(1e-9, skin[2]), skin[1] / Math.max(1e-9, skin[2]), skin[2] / total],
  };
}

/** The differences to make zero, each range counted by how much of both frames it covers. FilmCraft `residuals`. */
function residuals(current, reference) {
  const list = [];
  for (let band = 0; band < 3; band += 1) {
    const weight = Math.sqrt(Math.min(1, Math.max(0, Math.min(current.bands[band][0], reference.bands[band][0]) * 3)));
    list.push((current.bands[band][1] - reference.bands[band][1]) * weight);
    list.push((current.bands[band][2] - reference.bands[band][2]) * weight * 2);
    list.push((current.bands[band][3] - reference.bands[band][3]) * weight * 2);
  }
  list.push((current.chroma - reference.chroma) * 2);
  return list;
}

/** Gaussian elimination with partial pivoting; null when singular. FilmCraft `solve_linear`. */
function solveLinear(matrix, vector) {
  const a = matrix.map((row) => [...row]), b = [...vector], size = b.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-14) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    [b[column], b[pivot]] = [b[pivot], b[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < size; k += 1) a[row][k] -= factor * a[column][k];
      b[row] -= factor * b[column];
    }
  }
  const x = new Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = 0;
    for (let k = row + 1; k < size; k += 1) sum += a[row][k] * x[k];
    x[row] = (b[row] - sum) / a[row][row];
  }
  return x;
}

const skinHue = (stats) => Math.atan2(stats.skin[1], stats.skin[0]) * 180 / Math.PI;
const hueDistance = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Solves the grade that matches `current` pixels (framePixels of the shot before its grade) to
 * `reference` pixels. Returns {x, before, after}: x the 10 unknowns, before and after the
 * statistics distance. FilmCraft `solve`.
 */
export function solveMatch(current, reference, { skinProtect = true } = {}) {
  const target = colorStats(reference, null, { skinProtect });
  const cost = (x) => {
    const r = residuals(colorStats(current, x, { skinProtect }), target);
    return { r, c: r.reduce((sum, value) => sum + value * value, 0) + REGULARIZE ** 2 * x.reduce((sum, value) => sum + value * value, 0) };
  };
  let x = new Array(UNKNOWNS).fill(0);
  let { r, c } = cost(x);
  const before = Math.sqrt(c);
  let damping = 1e-3;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const step = 1e-2;
    const jacobian = r.map(() => new Array(UNKNOWNS).fill(0));
    for (let j = 0; j < UNKNOWNS; j += 1) {
      const moved = [...x]; moved[j] += step;
      const { r: shifted } = cost(moved);
      for (let i = 0; i < r.length; i += 1) jacobian[i][j] = (shifted[i] - r[i]) / step;
    }
    const a = Array.from({ length: UNKNOWNS }, () => new Array(UNKNOWNS).fill(0));
    const g = new Array(UNKNOWNS).fill(0);
    jacobian.forEach((row, i) => {
      for (let p = 0; p < UNKNOWNS; p += 1) {
        g[p] += row[p] * r[i];
        for (let q = 0; q < UNKNOWNS; q += 1) a[p][q] += row[p] * row[q];
      }
    });
    for (let p = 0; p < UNKNOWNS; p += 1) {
      g[p] += REGULARIZE ** 2 * x[p];
      a[p][p] += REGULARIZE ** 2 + damping * (1 + a[p][p]);
    }
    const dx = solveLinear(a, g.map((value) => -value));
    if (!dx) break;
    const next = x.map((value, p) => Math.min(LIMIT, Math.max(-LIMIT, value + dx[p])));
    const tried = cost(next);
    if (tried.c < c) {
      const improved = c - tried.c;
      ({ r, c } = tried); x = next;
      damping = Math.max(1e-6, damping * 0.3);
      if (improved < 1e-7) break;
    } else {
      damping *= 10;
      if (damping > 1e4) break;
    }
  }
  if (skinProtect) {
    // The shot's skin hue moves at most 8°: the cast (each wheel's channels apart from their
    // mean) is scaled down until it does.
    const start = colorStats(current, null, { skinProtect: true });
    if (start.skin[2] > 0.002) {
      const scaled = (k) => x.map((value, index) => {
        if (index >= 9) return value;
        const group = Math.floor(index / 3) * 3, mean = (x[group] + x[group + 1] + x[group + 2]) / 3;
        return mean + k * (value - mean);
      });
      let k = 1;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (hueDistance(skinHue(colorStats(current, scaled(k), { skinProtect: true })), skinHue(start)) <= 8) break;
        k *= 0.7;
      }
      x = scaled(k);
      c = cost(x).c;
    }
  }
  return { x, before, after: Math.sqrt(c) };
}

const round3 = (value) => Math.round(value * 1000) / 1000 || 0;

/**
 * The solved unknowns as kino effect parameters: {wheels, saturation}. wheels is the
 * color-wheels parameters (liftRed, gammaGreen, gainBlue, ... as offsets from the masters).
 */
export function matchParameters(x) {
  const wheels = {};
  ["Red", "Green", "Blue"].forEach((channel, index) => {
    wheels[`lift${channel}`] = round3(x[index]);
    wheels[`gamma${channel}`] = round3(x[3 + index]);
    wheels[`gain${channel}`] = round3(x[6 + index]);
  });
  return { wheels, saturation: round3(1 + x[9]) };
}
