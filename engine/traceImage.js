// Turns a picture (RGBA bytes) into flat-color vector shapes: the trace_image op's engine part.
// Plain JavaScript, no dependency. Steps:
//   1. quantize: k-means on a 5-bit color histogram (deterministic seeding: count x distance),
//   2. one 3x3 majority pass on the color labels (JPEG noise and anti-aliased fringes),
//   3. the background color (auto: the color on most of the region's border) is dropped,
//   4. connected regions (4-neighbors); regions under minArea join their most common neighbor,
//   5. each region's border is followed along pixel edges into closed loops (outer + holes),
//   6. loops become edge midpoints (no staircase), are simplified (Douglas-Peucker) and drawn as
//      smooth cubic curves (Catmull-Rom handles) with sharp corners kept.
// Output paths are in the caller's coordinates (the region's own pixels times `scale`).

const BITS = 5, SHIFT = 8 - BITS, SIDE = 1 << BITS;
// Mean color error (RGB distance, 0 to 441) under which a quantized picture reads as flat art.
// Guess from the contest-b fist and wordmark crops (JPEG frames of flat art measured 6 to 12 at
// 4 colors); a photo stays over 20 even at 12 colors.
export const FLAT_ERROR = 16;
// A turn sharper than this (degrees) keeps a corner instead of a curve. Guess: lettering corners
// are 80 to 100 degrees, sampled curves turn under 45 degrees between kept points.
const CORNER = 62;

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const bucketOf = (r, g, b) => ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);

function histogram(data) {
  const count = new Float64Array(SIDE ** 3), sum = new Float64Array(SIDE ** 3 * 3);
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const b = bucketOf(data[i], data[i + 1], data[i + 2]);
    count[b] += 1; sum[b * 3] += data[i]; sum[b * 3 + 1] += data[i + 1]; sum[b * 3 + 2] += data[i + 2];
  }
  const used = [];
  for (let b = 0; b < count.length; b += 1) if (count[b]) used.push({ n: count[b], c: [sum[b * 3] / count[b], sum[b * 3 + 1] / count[b], sum[b * 3 + 2] / count[b]], b });
  return used;
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** k-means on the histogram: {centers, error (mean RGB distance), nearest(bucket)}. */
export function quantize(used, k) {
  if (!used.length) return { centers: [[0, 0, 0]], error: 0, lookup: new Map() };
  const centers = [used.reduce((best, item) => (item.n > best.n ? item : best)).c.slice()];
  while (centers.length < k) {
    let best = null, score = 0;
    for (const item of used) {
      const d = Math.min(...centers.map((c) => dist2(c, item.c)));
      if (d * item.n > score) { score = d * item.n; best = item; }
    }
    if (!best || score === 0) break;
    centers.push(best.c.slice());
  }
  const owner = new Int32Array(used.length);
  for (let round = 0; round < 12; round += 1) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < used.length; i += 1) {
      let pick = 0, near = Infinity;
      for (let j = 0; j < centers.length; j += 1) { const d = dist2(centers[j], used[i].c); if (d < near) { near = d; pick = j; } }
      owner[i] = pick;
      const s = sums[pick], { n, c } = used[i];
      s[0] += c[0] * n; s[1] += c[1] * n; s[2] += c[2] * n; s[3] += n;
    }
    for (let j = 0; j < centers.length; j += 1) if (sums[j][3]) centers[j] = [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]];
  }
  let error = 0, total = 0;
  const lookup = new Map();
  for (let i = 0; i < used.length; i += 1) {
    error += Math.sqrt(dist2(centers[owner[i]], used[i].c)) * used[i].n; total += used[i].n;
    lookup.set(used[i].b, owner[i]);
  }
  return { centers, error: total ? error / total : 0, lookup };
}

function labelsOf(data, width, height, lookup) {
  const labels = new Int16Array(width * height).fill(-1);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    if (data[i + 3] >= 128) labels[p] = lookup.get(bucketOf(data[i], data[i + 1], data[i + 2])) ?? -1;
  }
  return labels;
}

// One 3x3 majority pass: a pixel takes the label most of its neighborhood has when that is 5+ of 9.
function majority(labels, width, height, k) {
  const out = labels.slice(), counts = new Int32Array(k + 1);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    counts.fill(0);
    let best = -1, top = 0;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const l = labels[(y + dy) * width + x + dx] + 1;
      counts[l] += 1;
      if (counts[l] > top) { top = counts[l]; best = l - 1; }
    }
    if (top >= 5) out[y * width + x] = best;
  }
  return out;
}

// The pixel indices of the region's four sides: top, bottom, left, right.
function sidesOf(width, height) {
  return [Array.from({ length: width }, (_, x) => x), Array.from({ length: width }, (_, x) => (height - 1) * width + x),
    Array.from({ length: height }, (_, y) => y * width), Array.from({ length: height }, (_, y) => y * width + width - 1)];
}

// Sides that are one color end to end while another side is not: a letterbox or pillar bar of the
// frame, not the ground the art sits on. Measured on the trailer title card (a whole 960x540 frame
// with 10 px black bars): counting the bars made black the ground, so the title words were dropped
// and the gray card became one big shape with letter holes.
function barSides(labels, sides) {
  const uniform = sides.map((side) => side.every((p) => labels[p] === labels[side[0]]));
  return uniform.every(Boolean) ? uniform.map(() => false) : uniform;
}

function borderLabel(labels, width, height, k) {
  const counts = new Int32Array(k + 1), sides = sidesOf(width, height), bars = barSides(labels, sides);
  sides.forEach((side, i) => { if (!bars[i]) for (const p of side) counts[labels[p] + 1] += 1; });
  let best = 0;
  for (let l = 1; l <= k; l += 1) if (counts[l] > counts[best]) best = l;
  return best - 1;
}

// Connected regions (4-neighbors) of the same label: {region per pixel, list of {label, pixels}}.
function regionsOf(labels, width, height) {
  const region = new Int32Array(width * height).fill(-1), list = [];
  const stack = new Int32Array(width * height);
  for (let start = 0; start < labels.length; start += 1) {
    if (region[start] !== -1) continue;
    const label = labels[start], id = list.length, pixels = [];
    let top = 0;
    stack[top++] = start; region[start] = id;
    while (top) {
      const p = stack[--top];
      pixels.push(p);
      const x = p % width, y = (p - x) / width;
      if (x > 0 && region[p - 1] === -1 && labels[p - 1] === label) { region[p - 1] = id; stack[top++] = p - 1; }
      if (x < width - 1 && region[p + 1] === -1 && labels[p + 1] === label) { region[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && region[p - width] === -1 && labels[p - width] === label) { region[p - width] = id; stack[top++] = p - width; }
      if (y < height - 1 && region[p + width] === -1 && labels[p + width] === label) { region[p + width] = id; stack[top++] = p + width; }
    }
    list.push({ label, pixels });
  }
  return { region, list };
}

// Thinner than this (2 x area / border length, in traced pixels) a region is the anti-aliased
// band along an edge between two colors, not a drawn line: the traced grid is twice the file's
// pixels, so 1.6 is under one file pixel (measured: a 1 px band on the test square reads 1.0, a
// 2 px ink line 3.9).
const THIN = 1.6;

// Regions under `min` pixels, or thin bands, take the label most of their outside neighbors have.
function mergeSmall(labels, width, height, min, k) {
  for (let round = 0; round < 3; round += 1) {
    const { region, list } = regionsOf(labels, width, height);
    let changed = false;
    for (let id = 0; id < list.length; id += 1) {
      const { pixels } = list[id];
      const counts = new Int32Array(k + 1);
      let border = 0;
      for (const p of pixels) {
        const x = p % width;
        for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width])
          if (q >= 0 && q < labels.length && region[q] !== id) { counts[labels[q] + 1] += 1; border += 1; }
      }
      if (pixels.length >= min && (border === 0 || (2 * pixels.length) / border >= THIN)) continue;
      let best = -1, top = 0;
      for (let l = 0; l <= k; l += 1) if (counts[l] > top) { top = counts[l]; best = l - 1; }
      if (top) { for (const p of pixels) labels[p] = best; changed = true; }
    }
    if (!changed) break;
  }
  return regionsOf(labels, width, height);
}

// The closed loops along the region's pixel edges, inside on the right (y down): outer loops have
// a positive area, holes a negative one. Each loop keeps the pixel just outside its first edge.
function loopsOf(pixels, id, region, width, height) {
  const edges = [], from = new Map();
  const add = (x0, y0, x1, y1, outside) => {
    const key = y0 * (width + 1) + x0;
    edges.push({ x0, y0, x1, y1, outside, used: false });
    if (!from.has(key)) from.set(key, []);
    from.get(key).push(edges.length - 1);
  };
  for (const p of pixels) {
    const x = p % width, y = (p - x) / width;
    if (y === 0 || region[p - width] !== id) add(x, y, x + 1, y, y === 0 ? -1 : p - width);
    if (x === width - 1 || region[p + 1] !== id) add(x + 1, y, x + 1, y + 1, x === width - 1 ? -1 : p + 1);
    if (y === height - 1 || region[p + width] !== id) add(x + 1, y + 1, x, y + 1, y === height - 1 ? -1 : p + width);
    if (x === 0 || region[p - 1] !== id) add(x, y + 1, x, y, x === 0 ? -1 : p - 1);
  }
  const loops = [];
  for (let first = 0; first < edges.length; first += 1) {
    if (edges[first].used) continue;
    const points = [];
    let edge = edges[first];
    while (edge && !edge.used) {
      edge.used = true;
      points.push([edge.x0, edge.y0]);
      const dx = edge.x1 - edge.x0, dy = edge.y1 - edge.y0;
      const options = (from.get(edge.y1 * (width + 1) + edge.x1) ?? []).map((index) => edges[index]).filter((item) => !item.used);
      // At a corner shared by two diagonal pixels, turn right first: the loop hugs one pixel, so
      // diagonal neighbors stay apart (4-neighbor regions).
      const rank = (item) => {
        const ex = item.x1 - item.x0, ey = item.y1 - item.y0;
        if (ex === -dy && ey === dx) return 0;
        if (ex === dx && ey === dy) return 1;
        return 2;
      };
      edge = options.sort((a, b) => rank(a) - rank(b))[0];
    }
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % points.length];
      area += x0 * y1 - x1 * y0;
    }
    if (points.length >= 4) loops.push({ points, area: area / 2, outside: edges[first].outside });
  }
  return loops;
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function simplifyOpen(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1, most = tolerance;
    for (let i = a + 1; i < b; i += 1) { const d = distanceToSegment(points[i], points[a], points[b]); if (d > most) { most = d; far = i; } }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Edge midpoints (a straight 45 degree run stays straight), then Douglas-Peucker on the closed loop.
function simplifyLoop(points, tolerance) {
  const mids = points.map(([x, y], i) => { const [nx, ny] = points[(i + 1) % points.length]; return [(x + nx) / 2, (y + ny) / 2]; });
  let far = 0, most = -1;
  for (let i = 1; i < mids.length; i += 1) { const d = Math.hypot(mids[i][0] - mids[0][0], mids[i][1] - mids[0][1]); if (d > most) { most = d; far = i; } }
  const first = simplifyOpen(mids.slice(0, far + 1), tolerance), second = simplifyOpen([...mids.slice(far), mids[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

const round = (v) => Math.round(v * 10) / 10;

// A closed loop as path data: lines at smooth 0, cubic curves through every point otherwise, with
// zero handles where the loop turns sharper than CORNER.
function loopPath(points, scale, smooth) {
  const n = points.length, p = points.map(([x, y]) => [x * scale, y * scale]);
  let d = `M${round(p[0][0])} ${round(p[0][1])}`;
  if (smooth <= 0 || n < 3) return `${d}${p.slice(1).map(([x, y]) => `L${round(x)} ${round(y)}`).join("")}Z`;
  const corner = p.map((point, i) => {
    const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
    const u = [point[0] - a[0], point[1] - a[1]], v = [b[0] - point[0], b[1] - point[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI > CORNER;
  });
  const handle = (i, sign) => {
    if (corner[i]) return p[i];
    const a = p[(i - 1 + n) % n], b = p[(i + 1) % n], k = (smooth / 6) * sign;
    return [p[i][0] + (b[0] - a[0]) * k, p[i][1] + (b[1] - a[1]) * k];
  };
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n, c1 = handle(i, 1), c2 = handle(j, -1);
    d += `C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p[j][0])} ${round(p[j][1])}`;
  }
  return `${d}Z`;
}

/**
 * Traces RGBA `data` (width x height) into flat-color shapes.
 * Options: colors (2 to 12, default 4), background ("auto" | "none" | "#rrggbb"), smooth (0 to 2,
 * default 1), minArea (in output px², default 16), scale (output px per input px, default 1),
 * outline (holes of every color kept, for strokes), maxPoints (default 4000), maxPaths (default 60).
 * Returns {paths:[{d, color, area, points}], background, error, suggest, regions, dropped, tolerance}.
 */
export function traceImage(data, width, height, options = {}) {
  const colors = Math.max(2, Math.min(12, Math.round(options.colors ?? 4)));
  const scale = options.scale ?? 1, smooth = Math.max(0, Math.min(2, options.smooth ?? 1));
  // 16 px² default: a speck of 4x4 scene pixels is JPEG noise, not a drawn shape (guess).
  const minPixels = Math.max(1, (options.minArea ?? 16) / (scale * scale));
  // Caps that keep one trace a few hundred kilobytes at most (guesses: a lettered word measured
  // 600 to 1,500 points at tolerance 0.7, a cel-shaded hand 25 regions).
  const maxPoints = options.maxPoints ?? 4000, maxPaths = options.maxPaths ?? 60;
  const used = histogram(data);
  const quantized = quantize(used, colors);
  let labels = majority(labelsOf(data, width, height, quantized.lookup), width, height, quantized.centers.length);
  const k = quantized.centers.length;
  let background = -1;
  if (options.background === undefined || options.background === "auto") background = borderLabel(labels, width, height, k);  else if (typeof options.background === "string" && /^#[0-9a-f]{6}$/i.test(options.background)) {
    const want = [1, 3, 5].map((i) => parseInt(options.background.slice(i, i + 2), 16));
    background = quantized.centers.reduce((best, c, i) => (dist2(c, want) < dist2(quantized.centers[best], want) ? i : best), 0);
  }
  const rawRegions = regionsOf(labels, width, height).list.length;
  const { region, list } = mergeSmall(labels, width, height, minPixels, k);
  // A suggestion when the picture does not read as flat at this colors value: the fewest colors
  // that do, or none (a photo).
  let suggest = null;
  if (quantized.error > FLAT_ERROR) {
    suggest = "photo";
    for (let n = 2; n <= 12; n += 1) if (n !== colors && quantize(used, n).error <= FLAT_ERROR) { suggest = n; break; }
  }
  // With the ground found automatically, a frame bar (a whole side of one color) is dropped too.
  const auto = options.background === undefined || options.background === "auto";
  const sides = sidesOf(width, height), barRegions = new Set();
  if (auto) barSides(labels, sides).forEach((bar, i) => { if (bar && sides[i].every((p) => region[p] === region[sides[i][0]])) barRegions.add(region[sides[i][0]]); });
  const shapes = [];
  for (let id = 0; id < list.length; id += 1) {
    const { label, pixels } = list[id];
    if (label === background || label < 0 || pixels.length < minPixels || barRegions.has(id)) continue;
    const loops = loopsOf(pixels, id, region, width, height);
    const outer = loops.filter((loop) => loop.area > 0);
    // A hole stays a hole where the background shows through it (or always, for outlines); a hole
    // filled by another color is covered by that smaller shape, drawn later, so no hairline gap.
    const holes = loops.filter((loop) => loop.area < 0 && (options.outline || loop.outside < 0 || labels[loop.outside] === background));
    shapes.push({ label, area: outer.reduce((sum, loop) => sum + loop.area, 0), loops: [...outer, ...holes] });
  }
  shapes.sort((a, b) => b.area - a.area);
  const dropped = Math.max(0, shapes.length - maxPaths);
  const kept = shapes.slice(0, maxPaths);
  // Tolerance 0.7 input px (guess: under one pixel keeps letter serifs); raised until under maxPoints.
  let tolerance = 0.7, simplified;
  for (let round = 0; round < 10; round += 1) {
    simplified = kept.map((shape) => shape.loops.map((loop) => simplifyLoop(loop.points, tolerance)).filter((loop) => loop.length >= 3));
    if (simplified.reduce((sum, loops) => sum + loops.reduce((s, loop) => s + loop.length, 0), 0) <= maxPoints) break;
    tolerance *= 1.5;
  }
  const paths = kept.map((shape, i) => ({
    d: simplified[i].map((loop) => loopPath(loop, scale, smooth)).join(""),
    color: hex(quantized.centers[shape.label]),
    area: Math.round(shape.area * scale * scale),
    points: simplified[i].reduce((sum, loop) => sum + loop.length, 0),
  })).filter((path) => path.points >= 3);
  return { paths, background: background >= 0 ? hex(quantized.centers[background]) : null, error: Math.round(quantized.error * 10) / 10,
    suggest, regions: rawRegions, dropped, tolerance: Math.round(tolerance * 100) / 100, palette: quantized.centers.map(hex) };
}

/** The traced shapes as one SVG document (a group named `name`), for engine/svgImport.js. */
export function traceSvg(result, width, height, { name = "trace", outline = false, strokeWidth = 2 } = {}) {
  const escape = (text) => String(text).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  const body = result.paths.map((path) => outline
    ? `<path d="${path.d}" fill="none" stroke="${path.color}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`
    : `<path d="${path.d}" fill="${path.color}" fill-rule="evenodd"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g id="${escape(name)}">${body}</g></svg>`;
}
