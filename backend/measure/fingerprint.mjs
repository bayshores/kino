// The motion fingerprint of a video: the math. backend/measure/measure.mjs decodes small frames
// and asks the kino-measure helper (Apple Vision) about them; this file turns those answers and
// a few plain pixel numbers into what an agent reads: how much moves, how the camera moves, how
// long it holds still, how shots hand off (hard cuts, blur dips, dissolves, fades), how much text
// is on screen, its case and how it appears, the palette and brightness, and a feature print per
// shot for "how alike".
//
// Everything here is plain math on numbers, with no files and no processes, so it is easy to test
// (backend/measure/fingerprint.test.mjs). Units:
//   - times in seconds;
//   - motion in frame diagonals a second (0.1 = a tenth of the frame's diagonal each second);
//   - shares from 0 to 1.
//
// One "record" is one sampled frame: {t, dt?, stats, flow?, text?, print?, saliency?}.
//   dt     seconds since the frame the flow was measured from (flow is only on records with dt)
//   stats  pixelStats(): brightness, sharpness and a color histogram
//   flow   the helper's 16 × 9 grid of arrows {cols, rows, u, v} in pixels of the frame
//   text   the helper's lines [{box: [x, y, w, h], s, c}] (null when text was not read)

// Below this much motion (frame diagonals a second) a frame pair is still.
export const STILL_SPEED = 0.015;
// A camera move: the whole-frame part of the motion is at least this fast and at least as big as
// the motion left over inside the picture.
export const CAMERA_SPEED = 0.02;
// A pan faster than this (diagonals a second) is a whip.
export const WHIP_SPEED = 1.2;
// A zoom faster than this (scale change a second, 0.1 = 10%) is not a slow push.
export const FAST_ZOOM = 0.25;
// A camera move whose direction holds (mean arrow over mean length, over half a second) at least
// this much is steady; under it, the camera shakes (handheld).
export const STEADY = 0.6;
// Text lines smaller than this (share of the frame's height) are small print (interface text,
// credits) and do not count as designed type.
export const BIG_TEXT = 0.035;
// How text appears is read from every line at least this tall (captions and subtitles too).
export const READABLE_TEXT = 0.02;
// A frame is a plain background when at least this share of its patches is flat.
export const PLAIN_SHARE = 0.7;
// A cut lands in motion when the motion around it (median of 3 pairs each side) is at least this.
export const MOVING_CUT = 0.06;

const round = (value, places = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null);
const median = (values) => {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};
const quantile = (values, q) => {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.max(0, Math.round(q * (list.length - 1))))];
};
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

// ---- pixels -----------------------------------------------------------------------------------

const SHARP_W = 160;
const SHARP_H = 90;
export const CELL_COLS = 16;
export const CELL_ROWS = 9;

/**
 * Plain numbers from one frame of BGRA (or RGBA, `order` "rgba") bytes: mean brightness (0–1),
 * sharpness (variance of a Laplacian on a 160 × 90 gray copy), a 4 × 4 × 4 color histogram
 * (to find dissolves), each patch of a 16 × 9 grid as its mean brightness and spread (to find what
 * stays in place across cuts), plus a few pixels for the palette when asked.
 */
export function pixelStats(bytes, width, height, { order = "bgra", palettePixels = 0 } = {}) {
  const [ri, gi, bi] = order === "rgba" ? [0, 1, 2] : [2, 1, 0];
  const sharpGray = new Float32Array(SHARP_W * SHARP_H);
  const sharpCount = new Uint16Array(SHARP_W * SHARP_H);
  const hist = new Float32Array(64);
  let total = 0, count = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 180));
  for (let y = 0; y < height; y += step) {
    const sy = Math.min(SHARP_H - 1, Math.floor((y * SHARP_H) / height));
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * 4;
      const r = bytes[at + ri], g = bytes[at + gi], b = bytes[at + bi];
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      total += luma; count += 1;
      const sc = sy * SHARP_W + Math.min(SHARP_W - 1, Math.floor((x * SHARP_W) / width));
      sharpGray[sc] += luma; sharpCount[sc] += 1;
      hist[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)] += 1;
    }
  }
  for (let index = 0; index < sharpGray.length; index += 1) sharpGray[index] /= Math.max(1, sharpCount[index]);
  for (let index = 0; index < hist.length; index += 1) hist[index] /= Math.max(1, count);
  // Laplacian variance: high for crisp edges, low for a blurred or flat picture.
  let lapSum = 0, lapSquares = 0, lapCount = 0;
  for (let y = 1; y < SHARP_H - 1; y += 1)
    for (let x = 1; x < SHARP_W - 1; x += 1) {
      const at = y * SHARP_W + x;
      const lap = sharpGray[at - 1] + sharpGray[at + 1] + sharpGray[at - SHARP_W] + sharpGray[at + SHARP_W] - 4 * sharpGray[at];
      lapSum += lap; lapSquares += lap * lap; lapCount += 1;
    }
  const lapMean = lapSum / lapCount;
  const pixels = [];
  if (palettePixels > 0) {
    // An even spread of pixels over the frame (a grid), for the palette.
    const side = Math.ceil(Math.sqrt(palettePixels));
    for (let gy = 0; gy < side; gy += 1)
      for (let gx = 0; gx < side; gx += 1) {
        const x = Math.floor(((gx + 0.5) * width) / side), y = Math.floor(((gy + 0.5) * height) / side);
        const at = (y * width + x) * 4;
        pixels.push([bytes[at + ri], bytes[at + gi], bytes[at + bi]]);
      }
  }
  // A 16 × 9 grid of patches: each one's mean brightness and spread, to find what stays in place
  // across cuts (a logo, a status line).
  const cells = new Float32Array(CELL_COLS * CELL_ROWS * 2);
  const cellW = SHARP_W / CELL_COLS, cellH = SHARP_H / CELL_ROWS;
  for (let row = 0; row < CELL_ROWS; row += 1)
    for (let col = 0; col < CELL_COLS; col += 1) {
      let sum = 0, squares = 0, n = 0;
      for (let y = row * cellH; y < (row + 1) * cellH; y += 1)
        for (let x = col * cellW; x < (col + 1) * cellW; x += 1) {
          const value = sharpGray[y * SHARP_W + x];
          sum += value; squares += value * value; n += 1;
        }
      const average = sum / n;
      cells[(row * CELL_COLS + col) * 2] = average;
      cells[(row * CELL_COLS + col) * 2 + 1] = Math.sqrt(Math.max(0, squares / n - average * average));
    }
  return { luma: total / Math.max(1, count), sharp: (lapSquares / lapCount - lapMean * lapMean) * 1e4, hist, cells, pixels };
}

/** How different two color histograms are: half the L1 distance, 0 (same) to 1 (nothing shared). */
export function histDistance(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index]);
  return sum / 2;
}

// ---- motion -----------------------------------------------------------------------------------

/**
 * Fits the whole-frame movement to a flow grid ({cols, rows, u, v}, arrows in pixels of a
 * width × height frame): a pan (tx, ty, pixels), a zoom (s: scale change, 0.01 = 1% bigger) and
 * a rotation (r: radians), the model u = tx + s·x − r·y, v = ty + r·x + s·y around the center.
 * It fits twice: the second time without the cells the first fit explains worst (a subject
 * moving across a still background should not read as a camera move).
 * Returns {tx, ty, s, r, residual (mean pixels left unexplained), magnitude (mean arrow length)}.
 */
export function fitGlobalMotion(grid, width, height) {
  const { cols, rows, u, v } = grid;
  const cells = [];
  for (let row = 0; row < rows; row += 1)
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      cells.push({ x: ((col + 0.5) / cols - 0.5) * width, y: ((row + 0.5) / rows - 0.5) * height, u: u[index], v: v[index] });
    }
  const fit = (list) => {
    // Least squares with the cells' center taken out, so the pan and the zoom/rotation separate.
    const n = list.length;
    const mx = list.reduce((sum, cell) => sum + cell.x, 0) / n;
    const my = list.reduce((sum, cell) => sum + cell.y, 0) / n;
    const mu = list.reduce((sum, cell) => sum + cell.u, 0) / n;
    const mv = list.reduce((sum, cell) => sum + cell.v, 0) / n;
    let sxx = 0, zoom = 0, turn = 0;
    for (const cell of list) {
      const x = cell.x - mx, y = cell.y - my, du = cell.u - mu, dv = cell.v - mv;
      sxx += x * x + y * y;
      zoom += du * x + dv * y;
      turn += dv * x - du * y;
    }
    const s = sxx > 0 ? zoom / sxx : 0;
    const r = sxx > 0 ? turn / sxx : 0;
    // The pan at the frame's center (x = y = 0), not at the cells' center.
    const tx = mu - s * mx + r * my;
    const ty = mv - r * mx - s * my;
    return { tx, ty, s, r };
  };
  const misses = (model) => cells.map((cell) => Math.hypot(cell.u - (model.tx + model.s * cell.x - model.r * cell.y), cell.v - (model.ty + model.r * cell.x + model.s * cell.y)));
  let model = fit(cells);
  const first = misses(model);
  const limit = Math.max(0.5, 2 * median(first));
  const kept = cells.filter((_, index) => first[index] <= limit);
  if (kept.length >= cells.length / 3 && kept.length < cells.length) model = fit(kept);
  const residual = mean(misses(model));
  const magnitude = mean(cells.map((cell) => Math.hypot(cell.u, cell.v)));
  return { ...model, residual, magnitude };
}

/**
 * One frame pair's motion in frame diagonals a second: speed (all motion), pan, zoom (scale
 * change a second: positive is in), rotate (radians a second), inside (motion the camera does not
 * explain), the camera's speed (pan, plus how fast the corners move from zoom and rotation), and
 * what kind of move it is: "still", "zoom-in", "zoom-out", "pan", "rotate" or "inside" (things
 * move but the frame does not).
 */
export function pairMotion(grid, width, height, dt) {
  const fit = fitGlobalMotion(grid, width, height);
  const diagonal = Math.hypot(width, height);
  const perSecond = (pixels) => pixels / diagonal / dt;
  const pan = perSecond(Math.hypot(fit.tx, fit.ty));
  const zoom = fit.s / dt;
  const rotate = fit.r / dt;
  // A corner is half a diagonal from the center: zoom and rotation move it that far times s or r.
  const parts = { pan, zoom: Math.abs(zoom) * 0.5, rotate: Math.abs(rotate) * 0.5 };
  const camera = parts.pan + parts.zoom + parts.rotate;
  const speed = perSecond(fit.magnitude);
  const inside = perSecond(fit.residual);
  let kind = "inside";
  if (speed < STILL_SPEED) kind = "still";
  else if (camera >= CAMERA_SPEED && camera >= inside) {
    const biggest = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
    kind = biggest === "zoom" ? (zoom > 0 ? "zoom-in" : "zoom-out") : biggest;
  }
  return { speed, pan, panX: perSecond(fit.tx), panY: perSecond(fit.ty), zoom, rotate, inside, camera, kind };
}

// Whether a camera move holds its direction over the pairs around it (steady), or not (shaky).
function steadiness(pairs, index) {
  const kind = pairs[index].kind;
  const near = pairs.slice(Math.max(0, index - 3), index + 4).filter((pair) => pair.kind !== "still" && pair.kind !== "cut");
  if (kind === "pan") {
    const x = mean(near.map((pair) => pair.panX)), y = mean(near.map((pair) => pair.panY));
    const length = mean(near.map((pair) => Math.hypot(pair.panX, pair.panY)));
    return length > 0 ? Math.hypot(x, y) / length : 0;
  }
  const key = kind === "rotate" ? "rotate" : "zoom";
  const average = mean(near.map((pair) => pair[key]));
  const size = mean(near.map((pair) => Math.abs(pair[key])));
  return size > 0 ? Math.abs(average) / size : 0;
}

// ---- text ------------------------------------------------------------------------------------

const normalize = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
const words = (text) => normalize(text).split(" ").filter(Boolean).length;
const centerOf = (box) => [box[0] + box[2] / 2, box[1] + box[3] / 2];

/** The lines at least `min` tall (share of the height) with at least two letters or digits. */
export function bigLines(lines, min = BIG_TEXT) {
  return (lines ?? []).filter((line) => line.box?.[3] >= min && normalize(line.s).replace(/ /g, "").length >= 2);
}

/** Whether a frame is mostly one flat color (a text card on a plain background). */
export function plainFrame(stats) {
  if (!stats?.cells) return false;
  let flat = 0;
  const count = stats.cells.length / 2;
  for (let cell = 0; cell < count; cell += 1) if (stats.cells[cell * 2 + 1] < 0.02) flat += 1;
  return flat / count >= PLAIN_SHARE;
}

const pairsOf = (text) => {
  const found = new Map();
  for (let index = 0; index + 1 < text.length; index += 1) found.set(text.slice(index, index + 2), (found.get(text.slice(index, index + 2)) ?? 0) + 1);
  return found;
};

/**
 * Whether two readings are the same line of text: one grows into the other (a reveal), or they
 * share most letter pairs (the same words, read a little differently, as OCR does from frame to
 * frame).
 */
export function sameLine(a, b) {
  const x = normalize(a).replace(/ /g, ""), y = normalize(b).replace(/ /g, "");
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // OCR often misreads the last letter of a line that is still appearing.
  if (long.startsWith(short) || (short.length >= 3 && long.startsWith(short.slice(0, -1)))) return true;
  const px = pairsOf(x), py = pairsOf(y);
  let shared = 0;
  for (const [pair, count] of px) shared += Math.min(count, py.get(pair) ?? 0);
  return (2 * shared) / Math.max(1, x.length - 1 + y.length - 1) >= 0.5;
}

/**
 * Follows text lines across the text samples (records with `text`), so kino can tell how text
 * appears. Two sightings are one line when they are in the same place on consecutive samples
 * (one missed sample is forgiven). Returns tracks: [{sightings: [{t, box, s}]}].
 */
export function trackText(samples) {
  const tracks = [];
  let open = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const lines = bigLines(sample.text, READABLE_TEXT);
    const claimed = new Set();
    const next = [];
    for (const line of lines) {
      const [cx, cy] = centerOf(line.box);
      let best = null, bestScore = Infinity;
      for (const track of open) {
        if (claimed.has(track)) continue;
        const last = track.sightings.at(-1);
        const [lx, ly] = centerOf(last.box);
        // Same row (centers within 6% of the height) and overlapping or near across.
        const dy = Math.abs(cy - ly);
        const overlap = Math.min(line.box[0] + line.box[2], last.box[0] + last.box[2]) - Math.max(line.box[0], last.box[0]);
        if (dy > 0.06 || (overlap < 0 && Math.abs(cx - lx) > 0.12)) continue;
        // Other words in the same place are a new line (captions that swap words), not this one.
        if (!sameLine(last.s, line.s)) continue;
        const score = dy + Math.abs(cx - lx);
        if (score < bestScore) { best = track; bestScore = score; }
      }
      const sighting = { t: sample.t, box: line.box, s: line.s };
      if (best) { claimed.add(best); best.sightings.push(sighting); best.seen = index; next.push(best); }
      else { const track = { sightings: [sighting], seen: index }; tracks.push(track); next.push(track); }
    }
    // A track not seen now stays open for one more sample.
    open = [...next, ...open.filter((track) => !claimed.has(track) && !next.includes(track) && index - track.seen < 2)];
  }
  return tracks.map(({ sightings }) => ({ sightings }));
}

/**
 * How one tracked line appeared: "words" (it grew a word at a time), "letters" (it grew letter by
 * letter), "slides" (same words, moving), "grows" (same words, getting bigger) or "whole" (all of
 * it at once, in place). null for a line seen once (classifyReveals looks at those in a row) and
 * for one that keeps moving after its first second (it rides on the footage).
 */
export function revealOf(track) {
  const seen = track.sightings;
  if (seen.length < 2) return null;
  const first = seen[0], last = seen.at(-1);
  const a = normalize(first.s), b = normalize(last.s);
  // Grew: the first reading is the start of a longer later one (OCR may drop a letter at the end).
  const grew = seen.some((sighting, index) => index > 0 && normalize(sighting.s).length > normalize(seen[index - 1].s).length + 1
    && normalize(sighting.s).startsWith(normalize(seen[index - 1].s).slice(0, -1)));
  if (grew && b.length > a.length) return words(b) > words(a) && /\s/.test(b.slice(Math.max(0, a.length - 1))) ? "words" : "letters";
  // An entrance happens in the first second. Text that keeps moving after that rides on moving
  // footage or a camera move: it says nothing about how the text was revealed.
  const entrance = seen.filter((sighting) => sighting.t - first.t <= 1);
  const after = seen.filter((sighting) => sighting.t - first.t > 1);
  if (after.length >= 2) {
    const [ax, ay] = centerOf(after[0].box), [bx, by] = centerOf(after.at(-1).box);
    if (Math.hypot(bx - ax, by - ay) > 0.04) return null;
  }
  const settled = entrance.at(-1);
  const [x0, y0] = centerOf(first.box), [x1, y1] = centerOf(settled.box);
  const moved = Math.hypot(x1 - x0, y1 - y0);
  const scaled = settled.box[3] / Math.max(1e-6, first.box[3]);
  if (scaled > 1.2 || scaled < 0.8) return "grows";
  if (moved > 0.04) return "slides";
  return "whole";
}

/**
 * How text appears over the whole video: counts of each reveal style, with up to 3 example times,
 * the dominant style, and the lowercase share. A run of 3 or more short lines (1 to 3 words) that
 * replace each other in one place counts as "words" too: captions shown a few words at a time.
 */
export function classifyReveals(tracks) {
  const counts = { whole: 0, words: 0, letters: 0, slides: 0, grows: 0 };
  const examples = { whole: [], words: [], letters: [], slides: [], grows: [] };
  const add = (style, t) => { counts[style] += 1; if (examples[style].length < 3) examples[style].push(round(t, 1)); };
  const ordered = [...tracks].sort((a, b) => a.sightings[0].t - b.sightings[0].t);
  const inRun = new Set();
  // Word swaps: short words (1 to 3, mostly letters, so a counter is not one), each starting as
  // or just after the one before ends, in the same place, and each one different.
  const wordLike = (track) => {
    const text = normalize(track.sightings.at(-1).s);
    const letterCount = (text.match(/\p{L}/gu) ?? []).length;
    return words(text) <= 3 && letterCount >= 2 && letterCount >= 0.6 * text.replace(/ /g, "").length;
  };
  for (let index = 0; index < ordered.length; index += 1) {
    if (!wordLike(ordered[index])) continue;
    const run = [ordered[index]];
    for (let next = index + 1; next < ordered.length; next += 1) {
      const before = run.at(-1), after = ordered[next];
      const gap = after.sightings[0].t - before.sightings.at(-1).t;
      if (gap < -0.01) continue;
      if (gap > 0.8) break;
      const [x0, y0] = centerOf(before.sightings.at(-1).box), [x1, y1] = centerOf(after.sightings[0].box);
      // Captions keep their center and their size as the words change.
      const sizeRatio = after.sightings[0].box[3] / Math.max(1e-6, before.sightings.at(-1).box[3]);
      if (Math.abs(y1 - y0) > 0.03 || Math.abs(x1 - x0) > 0.05 || sizeRatio > 1.3 || sizeRatio < 0.77) continue;
      if (!wordLike(after) || sameLine(after.sightings.at(-1).s, before.sightings.at(-1).s)) break;
      run.push(after);
    }
    if (run.length >= 3) {
      for (const track of run) if (!inRun.has(track)) { inRun.add(track); add("words", track.sightings[0].t); }
    }
  }
  let lower = 0, cased = 0;
  for (const track of ordered) {
    const text = track.sightings.at(-1).s;
    lower += (String(text).match(/\p{Ll}/gu) ?? []).length;
    cased += (String(text).match(/\p{Lu}|\p{Ll}/gu) ?? []).length;
    if (inRun.has(track)) continue;
    const style = revealOf(track);
    if (style) add(style, track.sightings[0].t);
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const dominant = total ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : null;
  return { counts, examples, dominant, lowercase: cased >= 8 ? round(lower / cased, 2) : null, lines: tracks.length };
}

// ---- color ----------------------------------------------------------------------------------

const hex = (rgb) => `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

/**
 * The main colors of a set of [r, g, b] pixels: k-means (k = 5) started from spread-out pixels
 * (the brightest, the darkest, then the farthest from those chosen), so the same pixels always
 * give the same palette. Returns [{hex, share}], biggest first.
 */
export function palette(pixels, k = 5) {
  if (!pixels.length) return [];
  const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const brightness = (p) => p[0] + p[1] + p[2];
  const sorted = [...pixels].sort((a, b) => brightness(a) - brightness(b));
  const centers = [sorted[0], sorted.at(-1)];
  while (centers.length < Math.min(k, pixels.length)) {
    let far = pixels[0], farthest = -1;
    for (const pixel of pixels) {
      const near = Math.min(...centers.map((center) => distance(pixel, center)));
      if (near > farthest) { farthest = near; far = pixel; }
    }
    if (farthest <= 0) break;
    centers.push(far);
  }
  let groups = [];
  for (let round = 0; round < 12; round += 1) {
    groups = centers.map(() => []);
    for (const pixel of pixels) {
      let best = 0;
      for (let index = 1; index < centers.length; index += 1) if (distance(pixel, centers[index]) < distance(pixel, centers[best])) best = index;
      groups[best].push(pixel);
    }
    for (let index = 0; index < centers.length; index += 1) {
      if (!groups[index].length) continue;
      centers[index] = [0, 1, 2].map((channel) => groups[index].reduce((sum, pixel) => sum + pixel[channel], 0) / groups[index].length);
    }
  }
  return centers.map((center, index) => ({ hex: hex(center), share: round(groups[index].length / pixels.length, 2) }))
    .filter((entry) => entry.share > 0).sort((a, b) => b.share - a.share);
}

// ---- feature prints ---------------------------------------------------------------------------

/** A helper's print ({type: "f32", b64}) as numbers. */
export function decodePrint(print) {
  const bytes = Buffer.from(print.b64, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = print.type === "f64" ? 8 : 4;
  const values = new Float32Array(Math.floor(bytes.length / size));
  for (let index = 0; index < values.length; index += 1) values[index] = size === 8 ? view.getFloat64(index * 8, true) : view.getFloat32(index * 4, true);
  return values;
}

/** Numbers packed small for saving: one byte each, with a scale. {q: base64, k}. */
export function packPrint(values) {
  const peak = Math.max(1e-9, ...Array.from(values, Math.abs));
  const scale = peak / 127;
  const bytes = Buffer.alloc(values.length);
  for (let index = 0; index < values.length; index += 1) bytes.writeInt8(Math.max(-127, Math.min(127, Math.round(values[index] / scale))), index);
  return { q: bytes.toString("base64"), k: scale };
}

// unpackPrint and printDistance live in engine/quality/referenceCompare.js (the check uses them).
export { printDistance, unpackPrint } from "../../engine/quality/referenceCompare.js";

// ---- transitions ------------------------------------------------------------------------------

/**
 * Shot changes that are not hard cuts, from records sampled densely (12 a second): blur dips
 * (the picture goes soft, then sharp again), fades through black, and dissolves (the colors
 * change a lot over a second but never in one jump). `cuts` are the hard cuts, left out.
 */
export function gradualTransitions(records, cuts = []) {
  const found = { blurDips: [], fades: [], dissolves: [] };
  if (records.length < 12) return found;
  const nearCut = (t, within) => cuts.some((cut) => Math.abs(cut - t) <= within);
  const add = (list, t) => { if (!list.length || t - list.at(-1) > 0.6) list.push(round(t, 2)); };
  const step = median(records.slice(1).map((record, index) => record.t - records[index].t)) || 1 / 12;
  const span = Math.max(2, Math.round(1 / step));
  const half = Math.max(1, Math.round(0.5 / step));
  for (let index = 1; index + 1 < records.length; index += 1) {
    const here = records[index];
    const around = records.slice(Math.max(0, index - span), index + span + 1);
    // Blur dip: much softer than the second around it, and sharp again on both sides.
    const base = median(around.map((record) => record.stats.sharp));
    if (base > 0 && here.stats.sharp < 0.4 * base && here.stats.sharp <= records[index - 1].stats.sharp && here.stats.sharp <= records[index + 1].stats.sharp
      && here.stats.luma > 0.05) {
      const before = records.slice(Math.max(0, index - half), index).some((record) => record.stats.sharp > 0.7 * base);
      const after = records.slice(index + 1, index + half + 1).some((record) => record.stats.sharp > 0.7 * base);
      if (before && after) add(found.blurDips, here.t);
    }
    // Fade through black: nearly black, with brighter pictures within a second either side.
    if (here.stats.luma < 0.04 && here.stats.luma <= records[index - 1].stats.luma && here.stats.luma <= records[index + 1].stats.luma) {
      const before = records.slice(Math.max(0, index - span), index).some((record) => record.stats.luma > 0.12);
      const after = records.slice(index + 1, index + span + 1).some((record) => record.stats.luma > 0.12);
      if (before && after) add(found.fades, here.t);
    }
  }
  // Dissolve: colors a second apart differ a lot, no single step does most of it, and it is not
  // a hard cut.
  for (let index = half; index + half < records.length; index += 1) {
    const a = records[index - half], b = records[index + half];
    const change = histDistance(a.stats.hist, b.stats.hist);
    if (change < 0.35 || nearCut(records[index].t, 0.5)) continue;
    let biggest = 0, moving = 0;
    for (let k = index - half + 1; k <= index + half; k += 1) {
      const stepChange = histDistance(records[k - 1].stats.hist, records[k].stats.hist);
      biggest = Math.max(biggest, stepChange);
      if (stepChange > 0.02) moving += 1;
    }
    if (biggest < 0.4 * change && moving >= Math.max(3, half)) add(found.dissolves, records[index].t);
  }
  return found;
}

// ---- what stays in place ----------------------------------------------------------------------

// A patch "stays" over a cut when its brightness and spread change by less than this (0–1).
const KEPT_CHANGE = 0.025;
// Only patches with some detail count (a plain background staying dark says nothing).
const DETAIL = 0.04;

/**
 * Things that stay in the same place across cuts while the picture around them changes: a logo,
 * a corner icon, a status line ("Claude is controlling..."). From records sampled densely:
 *   patches  grid patches with detail that look the same just before and just after at least 60%
 *            of the cuts (3 cuts at least), joined into boxes [x, y, w, h] (fractions of the frame)
 *   text     lines read in the same place in at least 3 shots and 30% of the text samples
 * Returns [{kind: "patch"|"text", box, share, text?}], at most 6.
 */
export function persistentElements(records, cuts = []) {
  const found = [];
  const step = median(records.slice(1).map((record, index) => record.t - records[index].t)) || 1 / 12;
  const at = (time) => records[Math.max(0, Math.min(records.length - 1, Math.round(time / step)))];
  // Patches: compare just before and just after each cut where the picture really changes.
  const kept = new Array(CELL_COLS * CELL_ROWS).fill(0);
  let counted = 0;
  for (const cut of cuts) {
    const before = at(cut - 2 * step), after = at(cut + 2 * step);
    if (!before?.stats.cells || !after?.stats.cells || before === after) continue;
    if (histDistance(before.stats.hist, after.stats.hist) < 0.15) continue;
    counted += 1;
    for (let cell = 0; cell < kept.length; cell += 1) {
      const [m0, s0, m1, s1] = [before.stats.cells[cell * 2], before.stats.cells[cell * 2 + 1], after.stats.cells[cell * 2], after.stats.cells[cell * 2 + 1]];
      if (s0 >= DETAIL && Math.abs(m0 - m1) < KEPT_CHANGE && Math.abs(s0 - s1) < KEPT_CHANGE) kept[cell] += 1;
    }
  }
  if (counted >= 3) {
    const on = kept.map((count) => count / counted >= 0.6);
    const seen = new Set();
    for (let start = 0; start < on.length; start += 1) {
      if (!on[start] || seen.has(start)) continue;
      // Join touching patches into one box.
      const stack = [start], group = [];
      seen.add(start);
      while (stack.length) {
        const cell = stack.pop();
        group.push(cell);
        const row = Math.floor(cell / CELL_COLS), col = cell % CELL_COLS;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const r = row + dr, c = col + dc, next = r * CELL_COLS + c;
          if (r >= 0 && r < CELL_ROWS && c >= 0 && c < CELL_COLS && on[next] && !seen.has(next)) { seen.add(next); stack.push(next); }
        }
      }
      const rows = group.map((cell) => Math.floor(cell / CELL_COLS)), cols = group.map((cell) => cell % CELL_COLS);
      const box = [Math.min(...cols) / CELL_COLS, Math.min(...rows) / CELL_ROWS, (Math.max(...cols) - Math.min(...cols) + 1) / CELL_COLS, (Math.max(...rows) - Math.min(...rows) + 1) / CELL_ROWS];
      found.push({ kind: "patch", box: box.map((value) => round(value, 2)), share: round(Math.max(...group.map((cell) => kept[cell])) / counted, 2) });
    }
  }
  // Text: lines that come back to one place across shots.
  const samples = records.filter((record) => Array.isArray(record.text));
  const shotOf = (time) => cuts.filter((cut) => cut <= time).length;
  const groups = [];
  for (const sample of samples) {
    for (const line of sample.text ?? []) {
      if (normalize(line.s).replace(/ /g, "").length < 3) continue;
      const [cx, cy] = centerOf(line.box);
      let group = groups.find((entry) => Math.abs(entry.cx - cx) < 0.03 && Math.abs(entry.cy - cy) < 0.03 && sameLine(entry.s, line.s));
      if (!group) { group = { cx, cy, s: line.s, box: line.box, times: new Set(), shots: new Set() }; groups.push(group); }
      group.times.add(sample.t);
      group.shots.add(shotOf(sample.t));
    }
  }
  for (const group of groups) {
    if (group.shots.size >= 3 && group.times.size / Math.max(1, samples.length) >= 0.3)
      found.push({ kind: "text", text: String(group.s).slice(0, 40), box: group.box.map((value) => round(value, 2)), share: round(group.times.size / samples.length, 2) });
  }
  return found.sort((a, b) => b.share - a.share).slice(0, 6);
}

// ---- the fingerprint --------------------------------------------------------------------------

/**
 * The fingerprint of measured records. options:
 *   width, height   the size the frames were measured at
 *   seconds         how long the measured stretch is
 *   cuts            hard cut times (from backend/shot-detection.mjs), or [] when unknown
 *   dense           true when frames were sampled 12 a second (transitions and text reveals need
 *                   that); false for sparse samples (a render check)
 *   vision          what the helper could do: {flow, text, print, saliency}, each
 *                   true or the reason it could not
 * Numbers that were not measured are null, never guessed.
 */
export function fingerprint(records, { width, height, seconds, cuts = [], dense = true, vision = {} } = {}) {
  const has = (job) => vision[job] === true;
  // Frame pairs that span a hard cut measure the cut, not motion: left out.
  const spansCut = (record) => cuts.some((cut) => cut > record.t - record.dt - 1e-6 && cut <= record.t + 1e-6);
  const pairs = [];
  for (const record of records) {
    if (!record.dt) continue;
    if (spansCut(record)) { pairs.push({ t: record.t, kind: "cut" }); continue; }
    if (has("flow") && record.flow) pairs.push({ t: record.t, dt: record.dt, ...pairMotion(record.flow, width, height, record.dt) });
  }
  const moving = pairs.filter((pair) => pair.kind !== "cut");
  const spacing = median(moving.slice(1).map((pair, index) => pair.t - moving[index].t)) ?? 1 / 12;

  let motion = null, camera = null;
  if (moving.length) {
    const speeds = moving.map((pair) => pair.speed);
    // The energy curve: mean motion in each second.
    const curve = [];
    for (let second = 0; second < Math.ceil(seconds); second += 1) {
      const inSecond = moving.filter((pair) => pair.t >= second && pair.t < second + 1).map((pair) => pair.speed);
      curve.push(inSecond.length ? round(mean(inSecond), 3) : null);
    }
    // Still stretches: consecutive still pairs (a cut ends one).
    let longest = { seconds: 0, at: null }, run = null, stillCount = 0;
    for (const pair of pairs) {
      if (pair.kind === "still") {
        stillCount += 1;
        run = run ? { ...run, end: pair.t } : { start: pair.t - (pair.dt ?? spacing), end: pair.t };
        const length = run.end - run.start;
        if (length > longest.seconds) longest = { seconds: length, at: run.start };
      } else run = null;
    }
    // Motion peaks: the fastest moments, at least 2 s apart, not at a cut.
    const peaks = [];
    for (const pair of [...moving].sort((a, b) => b.speed - a.speed)) {
      if (peaks.length >= 6 || pair.speed < 3 * STILL_SPEED) break;
      if (peaks.every((t) => Math.abs(t - pair.t) >= 2)) peaks.push(pair.t);
    }
    motion = {
      source: "optical flow",
      median: round(median(speeds)), p90: round(quantile(speeds, 0.9)), curve,
      stillShare: round(stillCount / moving.length, 2),
      longestStill: { seconds: round(longest.seconds, 1), at: longest.at == null ? null : round(longest.at, 1) },
      peaks: peaks.sort((a, b) => a - b).map((t) => round(t, 2)),
    };
    const kinds = ["zoom-in", "zoom-out", "pan", "rotate"];
    const cameraPairs = moving.map((pair, index) => ({ pair, index })).filter(({ pair }) => kinds.includes(pair.kind));
    const share = (kind) => round(moving.filter((pair) => pair.kind === kind).length / moving.length, 2);
    const examples = {};
    for (const kind of kinds) {
      const times = [];
      for (const { pair } of cameraPairs) if (pair.kind === kind && (!times.length || pair.t - times.at(-1) > 2) && times.length < 3) times.push(round(pair.t, 1));
      if (times.length) examples[kind] = times;
    }
    const steadyFlags = cameraPairs.map(({ index }) => steadiness(moving, index) >= STEADY);
    const zooms = cameraPairs.filter(({ pair }) => pair.kind.startsWith("zoom")).map(({ pair }) => Math.abs(pair.zoom));
    const pans = cameraPairs.filter(({ pair }) => pair.kind === "pan").map(({ pair }) => pair.pan);
    camera = {
      moving: round(cameraPairs.length / moving.length, 2),
      zoomIn: share("zoom-in"), zoomOut: share("zoom-out"), pan: share("pan"), rotate: share("rotate"),
      inside: share("inside"),
      shaky: cameraPairs.length ? round(steadyFlags.filter((flag) => !flag).length / cameraPairs.length, 2) : 0,
      zoomSpeed: round(median(zooms)), panSpeed: round(median(pans)),
      whips: pans.filter((speed) => speed >= WHIP_SPEED).length,
      examples,
    };
  }

  // How cuts hand off: in the middle of motion, or between held pictures.
  let handoff = null;
  if (moving.length && cuts.length) {
    let inMotion = 0;
    for (const cut of cuts) {
      const near = moving.filter((pair) => Math.abs(pair.t - cut) <= 3.5 * spacing).map((pair) => pair.speed);
      if (near.length && median(near) >= MOVING_CUT) inMotion += 1;
    }
    handoff = { cuts: cuts.length, inMotion, hard: cuts.length - inMotion };
  }

  // Text: the share of text samples with any text, and with big (designed) type.
  let text = null;
  if (has("text")) {
    const samples = records.filter((record) => Array.isArray(record.text));
    if (samples.length) {
      const any = samples.filter((record) => record.text.some((line) => normalize(line.s).replace(/ /g, "").length >= 2)).length;
      const big = samples.filter((record) => bigLines(record.text).length).length;
      const coverage = samples.map((record) => bigLines(record.text).reduce((sum, line) => sum + line.box[2] * line.box[3], 0));
      const withText = samples.filter((record) => bigLines(record.text, READABLE_TEXT).length);
      const textOnly = withText.filter((record) => plainFrame(record.stats)).length;
      text = {
        share: round(any / samples.length, 2), bigShare: round(big / samples.length, 2),
        // Text over a plain background (a text card), as a share of the samples with text.
        onPlain: withText.length ? round(textOnly / withText.length, 2) : 0,
        // Text alone on a plain background, as a share of all the samples (reference_drift).
        onlyShare: round(textOnly / samples.length, 2),
        area: round(median(coverage.filter((value) => value > 0)) ?? 0, 3), perSecond: round(samples.length / Math.max(1e-6, seconds), 1),
      };
      // Reveal styles need text read several times a second.
      if (dense) Object.assign(text, classifyReveals(trackText(samples)));
    }
  }

  const lumas = records.map((record) => record.stats.luma);
  const look = {
    brightness: round(median(lumas), 2),
    darkShare: round(lumas.filter((value) => value < 0.15).length / Math.max(1, lumas.length), 2),
    palette: palette(records.flatMap((record) => record.stats.pixels ?? [])),
  };

  const shotRecords = records.filter((record) => record.print || record.saliency);
  const areas = shotRecords.filter((record) => Array.isArray(record.saliency)).map((record) => Math.min(1, record.saliency.reduce((sum, box) => sum + box[2] * box[3], 0)));
  const shots = {
    count: cuts.length + 1,
    subjectArea: has("saliency") && areas.length ? round(median(areas), 2) : null,
  };

  return {
    version: 1,
    seconds: round(seconds, 1),
    sampled: dense ? "12 frames a second" : `${pairs.length} frame pairs`,
    vision: Object.fromEntries(Object.entries(vision).map(([job, value]) => [job, value === true ? true : String(value)])),
    motion, camera, handoff,
    transitions: dense ? gradualTransitions(records, cuts) : null,
    text, look, shots,
    persistent: dense ? persistentElements(records, cuts) : null,
  };
}

/** The packed feature prints of `records` that have one: [{t, q, k}]. */
export function shotPrints(records) {
  return records.filter((record) => record.print).map((record) => ({ t: round(record.t, 2), ...packPrint(decodePrint(record.print)) }));
}
