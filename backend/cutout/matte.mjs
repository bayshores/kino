// Matte clean-up for the subject cut-out: steadying edges over time, growing or shrinking the
// subject, and feathering its edge. A matte is one byte a pixel, row by row: 0 is background,
// 255 is subject, values between are a soft edge. Everything here is plain JavaScript, so it
// works (and is tested) on every computer, not only where Vision runs.
//
//   createSteadier  a running temporal median over 2·radius + 1 frames. Edge pixels that flicker
//                   between frames (on, off, on) are steadied, while an edge that moves the same
//                   way through the window (a subject walking) keeps its place: the median of
//                   values that only go up, or only go down, is the middle frame's own value. So a
//                   moving edge does not lag or smear. A part that moves farther than about a
//                   quarter of its own size each frame (a fast hand, a thrown ball) is in too few
//                   frames of the window, so the median would drop it; where the median drops a
//                   piece three or more pixels thick and the frame has no more subject than the
//                   larger frame beside it (the piece moved there; it did not pop up), the frame
//                   keeps its own matte there. A fast subject found bigger in one frame than in
//                   both frames beside it can still lose a piece of its edge in that frame.
//   grow            moves the edge out (positive pixels) or in (negative), measured as a true
//                   distance, so corners stay round; the new edge is anti-aliased over one pixel.
//   feather         blurs the edge so it fades over about `feather` pixels (10% to 90%), with three
//                   box blurs (close to a Gaussian, sigma = feather / 2.56).
//   matteMeasure    numbers for tests and receipts: area, IoU with a truth matte, frame-to-frame change.

const INFINITE = 1e20;

function checkSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError("A matte needs a whole-number width and height.");
}

// Median of five values: seven compare-and-swap steps (the network in Devillard's "Fast median
// search", 1998), after which the third value is the median.
function median5(a, b, c, d, e) {
  let t;
  if (a > b) { t = a; a = b; b = t; }
  if (d > e) { t = d; d = e; e = t; }
  if (a > d) { t = a; a = d; d = t; }
  if (b > e) { t = b; b = e; e = t; }
  if (b > c) { t = b; b = c; c = t; }
  if (c > d) { t = c; c = d; d = t; }
  if (b > c) { t = b; b = c; c = t; }
  return c;
}

const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

// How thick a piece the median drops must be before it counts as a moved part rather than a
// flickering edge: at least SOLID of the (2·REACH + 1)² pixels around a pixel are dropped too. A
// band up to two pixels wide never is (at most 10 of 25); a piece three or more pixels thick is.
const REACH = 2;
const SOLID = 13;

/**
 * Sums of a one-byte-a-pixel bitmap over the (2·REACH + 1)² square around each pixel of the box
 * [left, right] × [top, bottom], via a summed-area table. Returns { at(x, y) }.
 */
function boxSums(bits, width, height, left, top, right, bottom) {
  const x0 = Math.max(0, left - REACH), y0 = Math.max(0, top - REACH);
  const x1 = Math.min(width - 1, right + REACH), y1 = Math.min(height - 1, bottom + REACH);
  const w = x1 - x0 + 2, h = y1 - y0 + 2;
  const table = new Int32Array(w * h);
  for (let y = y0; y <= y1; y += 1) {
    let run = 0;
    const row = (y - y0 + 1) * w, above = (y - y0) * w;
    for (let x = x0; x <= x1; x += 1) {
      run += bits[y * width + x];
      table[row + x - x0 + 1] = table[above + x - x0 + 1] + run;
    }
  }
  return {
    at(x, y) {
      const ax = Math.max(x0, x - REACH) - x0, bx = Math.min(x1, x + REACH) - x0 + 1;
      const ay = Math.max(y0, y - REACH) - y0, by = Math.min(y1, y + REACH) - y0 + 1;
      return table[by * w + bx] - table[ay * w + bx] - table[by * w + ax] + table[ay * w + ax];
    },
  };
}

/**
 * A temporal median over 2·radius + 1 frames (radius 0, 1 or 2). push(matte) takes frames in
 * order and returns the steadied frames that are ready (radius frames later); finish() returns the
 * rest. At the start and end of the clip the window repeats the first or last frame. Frames are
 * not copied: do not change a matte after pushing it.
 */
export function createSteadier({ width, height, radius = 2 }) {
  checkSize(width, height);
  if (![0, 1, 2].includes(radius)) throw new RangeError("The steadying radius must be 0, 1 or 2 frames.");
  const size = width * height;
  const frames = [];
  const areas = []; // pixels at half or more, for each frame in `frames`
  const dropped = new Uint8Array(size); // 1 where the median turned this frame's subject into background
  let next = 0; // index of the next frame to send out
  let total = 0;

  // frames holds a sliding window; an index is clamped to the frames the clip has.
  const slot = (index) => Math.max(0, Math.min(total - 1, index)) - (total - frames.length);
  const frameAt = (index) => frames[slot(index)];
  const areaAt = (index) => areas[slot(index)];

  // Gives back the solid pieces of frame `index` that the median dropped, when they moved there.
  function keepMovedPieces(out, index, count, box) {
    // A piece that popped up adds subject: this frame then has more than either frame beside it.
    const extra = areaAt(index) - Math.max(areaAt(index - 1), areaAt(index + 1));
    if (extra > count / 2) return;
    const { left, top, right, bottom } = box;
    const near = boxSums(dropped, width, height, left, top, right, bottom);
    const solid = new Uint8Array(size);
    let any = false;
    for (let y = top; y <= bottom; y += 1)
      for (let x = left; x <= right; x += 1)
        if (dropped[y * width + x] && near.at(x, y) >= SOLID) { solid[y * width + x] = 1; any = true; }
    if (!any) return;
    // The pixels within REACH of a solid one come back too, so a moved part keeps its edge and
    // stays joined to the rest of the subject.
    const own = frameAt(index);
    const keep = boxSums(solid, width, height, left, top, right, bottom);
    for (let y = Math.max(0, top - REACH); y <= Math.min(height - 1, bottom + REACH); y += 1)
      for (let x = Math.max(0, left - REACH); x <= Math.min(width - 1, right + REACH); x += 1) {
        const i = y * width + x;
        if (own[i] > out[i] && keep.at(x, y) > 0) out[i] = own[i];
      }
  }

  function steady(index) {
    if (radius === 0) return frameAt(index);
    const out = new Uint8Array(size);
    const c = frameAt(index);
    let count = 0, left = width, right = -1, top = height, bottom = -1;
    // Notes a subject pixel of this frame that the median turned into background.
    const drop = (i, x, y) => {
      dropped[i] = 1; count += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    };
    if (radius === 1) {
      const b = frameAt(index - 1), d = frameAt(index + 1);
      for (let y = 0, i = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1, i += 1) {
          out[i] = median3(b[i], c[i], d[i]);
          if (c[i] >= 128 && out[i] < 128) drop(i, x, y);
        }
    } else {
      const a = frameAt(index - 2), b = frameAt(index - 1), d = frameAt(index + 1), e = frameAt(index + 2);
      for (let y = 0, i = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1, i += 1) {
          const v = c[i];
          // Most pixels are the same in all five frames; the median is then that value.
          if (a[i] === v && b[i] === v && d[i] === v && e[i] === v) { out[i] = v; continue; }
          out[i] = median5(a[i], b[i], v, d[i], e[i]);
          if (v >= 128 && out[i] < 128) drop(i, x, y);
        }
    }
    if (count >= SOLID) keepMovedPieces(out, index, count, { left, top, right, bottom });
    // Clear the marks for the next frame (only inside the box they can be in).
    for (let y = top; y <= bottom; y += 1) dropped.fill(0, y * width + left, y * width + right + 1);
    return out;
  }

  function trim() {
    // Keep the frames the next output still needs (radius before it).
    while (frames.length && total - frames.length < next - radius) { frames.shift(); areas.shift(); }
  }

  return {
    push(matte) {
      if (!(matte instanceof Uint8Array) || matte.length !== size) throw new RangeError(`Each matte must be ${size} bytes.`);
      let area = 0;
      for (let i = 0; i < size; i += 1) if (matte[i] >= 128) area += 1;
      frames.push(matte);
      areas.push(area);
      total += 1;
      const ready = [];
      while (next + radius < total) { ready.push(steady(next)); next += 1; trim(); }
      return ready;
    },
    finish() {
      const ready = [];
      while (next < total) { ready.push(steady(next)); next += 1; trim(); }
      return ready;
    },
  };
}

// One-dimensional squared distance transform (Felzenszwalb and Huttenlocher, 2012) of `f`
// (0 where a pixel is a seed, INFINITE elsewhere), written into `d`.
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

/**
 * Squared distance from each pixel to the nearest seed pixel (`seeds[i]` is 1), but only where it
 * is at most `limit` pixels: anything farther is left at INFINITE or a larger value. Lines with no
 * seed, and rows with nothing within `limit`, are skipped, so a thin edge band costs little.
 */
function squaredDistance(seeds, width, height, limit) {
  const grid = new Float64Array(width * height).fill(INFINITE);
  const n = Math.max(width, height);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < width; x += 1) {
    let any = false;
    for (let y = 0; y < height; y += 1) if (seeds[y * width + x]) { any = true; break; }
    if (!any) continue;
    for (let y = 0; y < height; y += 1) f[y] = seeds[y * width + x] ? 0 : INFINITE;
    distance1d(f, height, d, v, z);
    for (let y = 0; y < height; y += 1) grid[y * width + x] = d[y];
  }
  // A row whose every value is already farther than `limit` stays that far after the row pass
  // (it only adds horizontal distance), so it is skipped.
  const far = (limit + 1) * (limit + 1);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let near = false;
    for (let x = 0; x < width; x += 1) if (grid[row + x] <= far) { near = true; break; }
    if (!near) continue;
    for (let x = 0; x < width; x += 1) f[x] = grid[row + x];
    distance1d(f, width, d, v, z);
    for (let x = 0; x < width; x += 1) grid[row + x] = d[x];
  }
  return grid;
}

/**
 * Moves the matte's edge by `pixels` (positive grows the subject, negative shrinks it). The edge
 * is where the matte crosses half; the result is solid inside and has a one-pixel anti-aliased
 * edge (soft detail such as hair is replaced by that edge). Returns a new matte.
 *
 * Growing, a background pixel at distance d (to the nearest subject pixel centre) gets coverage
 * 1 + pixels − d, and every subject pixel stays solid; shrinking, a subject pixel at distance d
 * from the nearest background pixel keeps pixels + d, and the background stays empty. So only
 * one distance transform is needed, and only within |pixels| + 1 of the edge.
 */
export function grow(matte, width, height, pixels) {
  checkSize(width, height);
  if (!Number.isFinite(pixels)) throw new RangeError("grow needs a number of pixels.");
  if (pixels === 0) return matte.slice();
  const growing = pixels > 0;
  const size = width * height;
  const seeds = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) seeds[i] = (matte[i] >= 128) === growing ? 1 : 0;
  const distance = squaredDistance(seeds, width, height, Math.abs(pixels) + 1);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    if (seeds[i]) { out[i] = growing ? 255 : 0; continue; }
    const d = Math.sqrt(distance[i]);
    const coverage = growing ? 1 + pixels - d : pixels + d;
    out[i] = coverage <= 0 ? 0 : coverage >= 1 ? 255 : Math.round(coverage * 255);
  }
  return out;
}

// One box blur of radius r along rows, from `src` to `dst` (the row's ends repeat outwards).
function boxRows(src, dst, width, height, r) {
  const span = 2 * r + 1;
  const last = width - 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += src[row + (k < 0 ? 0 : k > last ? last : k)];
    for (let x = 0; x < width; x += 1) {
      dst[row + x] = sum / span;
      const add = x + r + 1, remove = x - r;
      sum += src[row + (add > last ? last : add)] - src[row + (remove < 0 ? 0 : remove)];
    }
  }
}

// One box blur of radius r along columns, row by row (a running sum for every column), so the
// memory is read in order.
function boxColumns(src, dst, width, height, r, sums) {
  const span = 2 * r + 1;
  const last = height - 1;
  sums.fill(0);
  for (let k = -r; k <= r; k += 1) {
    const row = (k < 0 ? 0 : k > last ? last : k) * width;
    for (let x = 0; x < width; x += 1) sums[x] += src[row + x];
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const add = (y + r + 1 > last ? last : y + r + 1) * width, remove = (y - r < 0 ? 0 : y - r) * width;
    for (let x = 0; x < width; x += 1) {
      dst[row + x] = sums[x] / span;
      sums[x] += src[add + x] - src[remove + x];
    }
  }
}

/**
 * Softens the matte's edge so it fades over about `pixels` pixels (0 leaves it as it is). Three box
 * blurs in each direction approximate a Gaussian with sigma = pixels / 2.56 (a Gaussian edge
 * rises from 10% to 90% over 2.56 sigma). The image's borders repeat outwards, so a subject that
 * touches the frame's edge stays solid there. Returns a new matte.
 */
export function feather(matte, width, height, pixels) {
  checkSize(width, height);
  if (!Number.isFinite(pixels) || pixels < 0) throw new RangeError("feather needs 0 or more pixels.");
  if (pixels === 0) return matte.slice();
  const sigma = pixels / 2.56;
  // Box sizes whose three passes give that sigma (Kovesi's "fast almost-Gaussian filtering").
  const ideal = Math.sqrt(12 * sigma * sigma / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  const radii = [0, 1, 2].map((pass) => ((pass < m ? lower : upper) - 1) / 2);
  let a = Float32Array.from(matte);
  let b = new Float32Array(matte.length);
  const sums = new Float64Array(width);
  for (const r of radii) {
    if (r <= 0) continue;
    boxRows(a, b, width, height, r); [a, b] = [b, a];
    boxColumns(a, b, width, height, r, sums); [a, b] = [b, a];
  }
  const out = new Uint8Array(matte.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(0, Math.min(255, Math.round(a[i])));
  return out;
}

/**
 * grow, then feather: the clean-up a cut_out's settings ask for. Both change only pixels near
 * the subject, so they run on the subject's bounding box with room for the change around it
 * (everything outside stays empty); a subject that fills a third of the frame costs a third.
 */
export function finishMatte(matte, width, height, { grow: growBy = 0, feather: featherBy = 0 } = {}) {
  if (!growBy && !featherBy) return matte;
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let first = -1, last = -1;
    for (let x = 0; x < width; x += 1) if (matte[row + x]) { first = x; break; }
    if (first < 0) continue;
    for (let x = width - 1; x >= first; x -= 1) if (matte[row + x]) { last = x; break; }
    if (first < left) left = first;
    if (last > right) right = last;
    if (y < top) top = y;
    bottom = y;
  }
  if (right < 0) return new Uint8Array(matte.length);
  // A grown edge reaches growBy + 1 pixels out; a feathered one as far as its three boxes.
  const room = Math.ceil(Math.max(0, growBy)) + 2 + Math.ceil(1.5 * Math.max(0, featherBy)) + 3;
  left = Math.max(0, left - room); right = Math.min(width - 1, right + room);
  top = Math.max(0, top - room); bottom = Math.min(height - 1, bottom + room);
  const boxWidth = right - left + 1, boxHeight = bottom - top + 1;
  let box = new Uint8Array(boxWidth * boxHeight);
  for (let y = 0; y < boxHeight; y += 1) box.set(matte.subarray((top + y) * width + left, (top + y) * width + right + 1), y * boxWidth);
  if (growBy) box = grow(box, boxWidth, boxHeight, growBy);
  if (featherBy) box = feather(box, boxWidth, boxHeight, featherBy);
  const out = new Uint8Array(matte.length);
  for (let y = 0; y < boxHeight; y += 1) out.set(box.subarray(y * boxWidth, (y + 1) * boxWidth), (top + y) * width + left);
  return out;
}

// A matte value at or above SEEN is part of the subject; at or above FIRM it is solid.
const SEEN = 32, FIRM = 224;

/**
 * Counts toward how see-through a matte is: { seen } pixels of subject (SEEN or more) and how many
 * of them are { soft } (under FIRM). Added up over a clip, soft / seen is its see-through share:
 * a clean cut-out has only its edge soft; one whose body is half see-through has much more.
 */
export function softCounts(matte) {
  let seen = 0, soft = 0;
  for (let i = 0; i < matte.length; i += 1) {
    const value = matte[i];
    if (value >= SEEN) { seen += 1; if (value < FIRM) soft += 1; }
  }
  return { seen, soft };
}

/**
 * Numbers about a matte: { area } (fraction of the picture that is subject, counting soft pixels
 * by their value), with `truth` (one byte a pixel, 0 or 1) also { iou } (pixels at half or more
 * against the truth), and with `previous` (the matte of the frame before) { change }: how many
 * pixels' worth of matte changed, counted where `stable(i)` says the subject did not move there.
 */
export function matteMeasure(matte, { truth, previous, stable } = {}) {
  let area = 0, inter = 0, union = 0, change = 0;
  for (let i = 0; i < matte.length; i += 1) {
    area += matte[i];
    if (truth) {
      const on = matte[i] >= 128;
      if (on && truth[i]) inter += 1;
      if (on || truth[i]) union += 1;
    }
    if (previous && (!stable || stable(i))) change += Math.abs(matte[i] - previous[i]);
  }
  return {
    area: area / 255 / matte.length,
    ...(truth ? { iou: union ? inter / union : 1 } : {}),
    ...(previous ? { change: change / 255 } : {}),
  };
}

/**
 * How far a round subject's edge is from where it should be, along `rays` directions from its
 * true centre: [{ angle, error }] with error in pixels (positive: the matte reaches past the true
 * edge). The edge is where the matte, read with bilinear sampling, first drops below half going
 * outwards. Used to measure edge flicker: the change in each ray's error from one frame to the next.
 */
export function radialEdgeErrors(matte, width, height, { cx, cy, r }, rays = 64) {
  const sample = (x, y) => {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(x - 0.5))), y0 = Math.max(0, Math.min(height - 1, Math.floor(y - 0.5)));
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, x - 0.5 - x0)), fy = Math.max(0, Math.min(1, y - 0.5 - y0));
    const top = matte[y0 * width + x0] * (1 - fx) + matte[y0 * width + x1] * fx;
    const bottom = matte[y1 * width + x0] * (1 - fx) + matte[y1 * width + x1] * fx;
    return (top * (1 - fy) + bottom * fy) / 255;
  };
  const errors = [];
  for (let k = 0; k < rays; k += 1) {
    const angle = (2 * Math.PI * k) / rays;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let previous = sample(cx + dx * r * 0.5, cy + dy * r * 0.5), edge = null;
    for (let d = r * 0.5 + 0.1; d <= r * 1.6; d += 0.1) {
      const value = sample(cx + dx * d, cy + dy * d);
      if (previous >= 0.5 && value < 0.5) { edge = d - 0.1 + 0.1 * (previous - 0.5) / (previous - value); break; }
      previous = value;
    }
    errors.push({ angle, error: edge == null ? null : edge - r });
  }
  return errors;
}
