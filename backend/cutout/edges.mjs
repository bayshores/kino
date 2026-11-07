// Edge clean-up for a video subject cut-out, after the matte is made (cutout.mjs writeVideoOutput).
// Apple Vision's matte is soft and a few pixels generous, and a fast move is motion-blurred, so the
// pixels along a cut-out's edge are partly the background it was filmed against. Over a new,
// darker background (a wash, a title behind the person) that shows as a bright halo, and a
// blurred hand or foot keeps patches of the old wall. Two steps fix it:
//
//   plate   For a shot whose camera holds still, the empty background: per pixel, the median of
//           sampled frames where the matte says no subject is there (createPlateBuilder). Shots
//           where those pixels move (a pan, handheld shake) get no plate.
//   refine  Near the edge only (a band a few percent of the frame wide): where a pixel matches
//           the plate it is background, so its matte is lowered (never raised); then every edge
//           pixel left partly see-through takes the colour of the solid subject next to it, so no
//           background colour is mixed into the edge (createEdgeRefiner).
//
// Frames are planar YUV 4:4:4 (one byte a sample: Y plane, U plane, V plane), the video's own
// colour numbers, so the cut-out keeps matching the footage under it exactly where it is solid.
// Plain JavaScript, tested on every computer.

const INFINITE = 1e20;

// The edge band, as a share of the frame's long side: wide enough for a motion-blurred limb.
export const BAND_SHARE = 0.02;
// A sample of a pixel this close to the plate (on every plane) is background; this far, subject.
export const PLATE_NEAR = 10;
export const PLATE_FAR = 28;
// A matte value below this counts as "no subject here" when the plate is sampled.
const PLATE_EMPTY = 24;
// The plate holds when 90% of its known pixels vary by at most this much between samples.
const PLATE_STEADY = 8;
// ...and when at least this share of the frame was seen empty.
const PLATE_KNOWN = 0.5;
// Solid subject: the matte at or above this value.
const SOLID = 250;

function distance1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INFINITE; z[1] = INFINITE;
  for (let q = 1; q < n; q += 1) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k -= 1; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k += 1; v[k] = q; z[k] = s; z[k + 1] = INFINITE;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Squared distance to the nearest seed inside the box [x0, x1] × [y0, y1] (seeds outside the box
// are not seen; the box is the subject's bounds plus the band, so none that matter are outside).
function boxDistance(seeds, width, x0, y0, x1, y1, grid, scratch) {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const { f, d, v, z } = scratch;
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = seeds[(y0 + y) * width + x0 + x] ? 0 : INFINITE;
    distance1d(f, h, d, v, z);
    for (let y = 0; y < h; y += 1) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) f[x] = grid[y * w + x];
    distance1d(f, w, d, v, z);
    for (let x = 0; x < w; x += 1) grid[y * w + x] = d[x];
  }
}

/**
 * Collects sampled frames (planar YUV 4:4:4 at `width` × `height`, with their matte) and finishes
 * as the empty background: { plate (planar YUV), known (1 where a pixel was seen empty often
 * enough), steady } or { steady: false } when the background moves or was rarely seen.
 */
export function createPlateBuilder({ width, height, most = 24 }) {
  const size = width * height;
  const frames = [];
  const mattes = [];
  return {
    add(yuv, matte) {
      if (frames.length >= most) return;
      frames.push(Uint8Array.from(yuv.subarray(0, size * 3)));
      mattes.push(Uint8Array.from(matte.subarray(0, size)));
    },
    finish() {
      const count = frames.length;
      if (count < 3) return { steady: false };
      const least = Math.max(3, Math.ceil(count / 4));
      const plate = new Uint8Array(size * 3);
      const known = new Uint8Array(size);
      const spreads = [];
      const values = new Uint8Array(count);
      let seen = 0;
      for (let i = 0; i < size; i += 1) {
        let spread = 0;
        let n = 0;
        for (let plane = 0; plane < 3; plane += 1) {
          n = 0;
          for (let f = 0; f < count; f += 1) if (mattes[f][i] < PLATE_EMPTY) values[n++] = frames[f][plane * size + i];
          if (n < least) break;
          const sorted = values.subarray(0, n).sort();
          const middle = sorted[n >> 1];
          plate[plane * size + i] = middle;
          for (let k = 0; k < n; k += 1) values[k] = Math.abs(sorted[k] - middle);
          spread = Math.max(spread, values.subarray(0, n).sort()[n >> 1]);
        }
        if (n < least) continue;
        known[i] = 1;
        seen += 1;
        spreads.push(spread);
      }
      if (seen < size * PLATE_KNOWN) return { steady: false };
      spreads.sort((a, b) => a - b);
      const p90 = spreads[Math.floor(spreads.length * 0.9)];
      return p90 <= PLATE_STEADY ? { steady: true, plate, known, width, height } : { steady: false };
    },
  };
}

/**
 * A refiner for frames of `width` × `height` (planar YUV 4:4:4 and a matte at the same size).
 * `plate` is createPlateBuilder's steady result (any size; it is sampled to this one) or null.
 * refine(yuv, matte) changes both in place and returns them.
 */
export function createEdgeRefiner({ width, height, plate = null, band = Math.max(4, Math.round(BAND_SHARE * Math.max(width, height))) }) {
  const size = width * height;
  const n = Math.max(width, height) + 2 * band + 2;
  const scratch = { f: new Float64Array(n), d: new Float64Array(n), v: new Int32Array(n), z: new Float64Array(n + 1) };
  const seeds = new Uint8Array(size);
  // The plate's pixel for each frame column and row (nearest sample).
  const plateX = plate ? Int32Array.from({ length: width }, (_, x) => Math.min(plate.width - 1, Math.floor(((x + 0.5) * plate.width) / width))) : null;
  const plateY = plate ? Int32Array.from({ length: height }, (_, y) => Math.min(plate.height - 1, Math.floor(((y + 0.5) * plate.height) / height))) : null;
  const plateSize = plate ? plate.width * plate.height : 0;
  // The solid subject's colour around each edge pixel: box sums over `reach`, from summed-area tables.
  const reach = Math.max(2, Math.round(band / 4));
  // Work space for the largest box, made once: a clip has hundreds of frames.
  const toOutsideAll = new Float64Array(size);
  const tables = Array.from({ length: 4 }, () => new Float64Array((width + 1) * (height + 1)));

  function bounds(matte) {
    let x0 = width, x1 = -1, y0 = height, y1 = -1;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) if (matte[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    if (x1 < 0) return null;
    return { x0: Math.max(0, x0 - band - 1), y0: Math.max(0, y0 - band - 1), x1: Math.min(width - 1, x1 + band + 1), y1: Math.min(height - 1, y1 + band + 1) };
  }

  function refine(yuv, matte) {
    const box = bounds(matte);
    if (!box) return { yuv, matte };
    const { x0, y0, x1, y1 } = box;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // Distance (inside the subject) to the nearest pixel outside it: the band is where it is small.
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) seeds[y * width + x] = matte[y * width + x] < 128 ? 1 : 0;
    const toOutside = toOutsideAll.subarray(0, w * h);
    boxDistance(seeds, width, x0, y0, x1, y1, toOutside, scratch);
    const limit = band * band;
    // 1. Where the plate shows through the edge, the matte drops (only near the edge).
    if (plate) {
      for (let y = 0; y < h; y += 1) {
        const py = plateY[y0 + y] * plate.width;
        for (let x = 0; x < w; x += 1) {
          const i = (y0 + y) * width + x0 + x;
          if (!matte[i] || toOutside[y * w + x] > limit) continue;
          const p = py + plateX[x0 + x];
          if (!plate.known[p]) continue;
          const gap = Math.max(Math.abs(yuv[i] - plate.plate[p]), Math.abs(yuv[size + i] - plate.plate[plateSize + p]), Math.abs(yuv[2 * size + i] - plate.plate[2 * plateSize + p]));
          if (gap >= PLATE_FAR) continue;
          const keep = gap <= PLATE_NEAR ? 0 : (gap - PLATE_NEAR) / (PLATE_FAR - PLATE_NEAR);
          matte[i] = Math.round(matte[i] * keep);
        }
      }
    }
    // 2. Partly see-through edge pixels take the solid subject's colour next to them.
    const tw = w + 1;
    const sums = tables;
    for (const table of sums) table.fill(0, 0, tw);
    for (let y = 0; y < h; y += 1) {
      for (const table of sums) table[(y + 1) * tw] = 0;
      let c = 0, s0 = 0, s1 = 0, s2 = 0;
      for (let x = 0; x < w; x += 1) {
        const i = (y0 + y) * width + x0 + x;
        if (matte[i] >= SOLID) { c += 1; s0 += yuv[i]; s1 += yuv[size + i]; s2 += yuv[2 * size + i]; }
        const at = (y + 1) * tw + x + 1, above = y * tw + x + 1;
        sums[0][at] = sums[0][above] + c; sums[1][at] = sums[1][above] + s0; sums[2][at] = sums[2][above] + s1; sums[3][at] = sums[3][above] + s2;
      }
    }
    const boxSum = (table, ax, ay, bx, by) => table[(by + 1) * tw + bx + 1] - table[ay * tw + bx + 1] - table[(by + 1) * tw + ax] + table[ay * tw + ax];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y0 + y) * width + x0 + x;
        const a = matte[i];
        if (!a || a >= SOLID) continue;
        // The nearest solid colour: a small box first, a box twice as wide when it holds none.
        for (const r of [reach, reach * 2, reach * 4]) {
          const ax = Math.max(0, x - r), ay = Math.max(0, y - r), bx = Math.min(w - 1, x + r), by = Math.min(h - 1, y + r);
          const count = boxSum(sums[0], ax, ay, bx, by);
          if (count < 1) continue;
          yuv[i] = Math.round(boxSum(sums[1], ax, ay, bx, by) / count);
          yuv[size + i] = Math.round(boxSum(sums[2], ax, ay, bx, by) / count);
          yuv[2 * size + i] = Math.round(boxSum(sums[3], ax, ay, bx, by) / count);
          break;
        }
      }
    }
    return { yuv, matte };
  }
  return { refine, band };
}
