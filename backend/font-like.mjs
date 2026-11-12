// library {topic:"fonts", like, region?}: the faces whose letters look most like the lettering in a
// picture (the region given, else the largest lettering box kino finds). kino measures the lettering in the crop (stroke weight, letter width, slant, corners,
// stroke contrast, edge roughness, dots) and the same measures on sample letters it draws in each
// candidate face, then ranks the faces by the distance between the two.
//
// Candidates: every installed face (bundled, uploaded, downloaded), plus a few catalog families of
// the class the measures point at (dotted, rough, condensed, heavy), downloaded and kept like any
// face set_font downloads. Each face's measures are kept in the catalog's measuresFile, so a face is
// drawn and measured once.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage, Path2D } from "@napi-rs/canvas";

// The height the lettering block is scaled to before measuring, so pixel measures compare across
// sizes. GUESS: big enough for a 2 px stroke on light faces, small enough to stay fast.
const NORMAL_HEIGHT = 64;
// Letters drawn for a face when the call gives no text. GUESS: capitals with round, straight and
// diagonal strokes (the lettering in the benchmark references was set in capitals).
export const SAMPLE_TEXT = "HAMBURGEFONS";
// Catalog families downloaded per call at most (each is one small file, kept for later calls). GUESS.
const MOST_DOWNLOADS = 12;
const SHOWN = 8;
// Raised whenever measureInk changes, so cached measures of an older version are measured again.
const MEASURE_VERSION = 2;

// How far apart two faces are on one measure before it counts as one step of difference. GUESS,
// set from the spread of the bundled faces (Inter, Montserrat, Noto Serif at 400 and 700).
const MEASURES = {
  weight: { scale: 0.025, more: "heavier", less: "lighter" },
  width: { scale: 0.12, more: "wider", less: "more condensed" },
  slant: { scale: 5, more: "more slanted", less: "more upright" },
  corners: { scale: 0.2, more: "squarer corners", less: "rounder corners" },
  contrast: { scale: 0.2, more: "more stroke contrast", less: "less stroke contrast" },
  rough: { scale: 0.06, more: "rougher edges", less: "cleaner edges" },
  // Dots compare as a class (see differences): the share itself is unreliable on small frames.
  dots: { scale: 0.25, more: "more dotted", less: "solid strokes" },
};
// Steps between a dotted and a solid lettering. GUESS: measured on the product-film crop, its round
// dots read 0.43 (JPEG blur joins some), Doto and Bitcount 1.0, solid faces 0 to 0.03; as a plain
// measure that put solid condensed faces first, so the class decides and 4 steps puts dotted ahead.
const DOT_CLASS_STEPS = 4;
// The dot share from which a lettering counts as dotted. GUESS, from the product-film crop (0.43)
// against solid faces (0 to 0.03).
const DOTTED = 0.4;

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

// Otsu's threshold of a gray histogram.
function otsu(gray) {
  const histogram = new Array(256).fill(0);
  for (const value of gray) histogram[value] += 1;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let below = 0, sumBelow = 0, best = 0, threshold = 128;
  for (let i = 0; i < 256; i += 1) {
    below += histogram[i];
    if (!below || below === gray.length) continue;
    sumBelow += i * histogram[i];
    const above = gray.length - below;
    const between = below * above * (sumBelow / below - (sum - sumBelow) / above) ** 2;
    if (between > best) { best = between; threshold = i; }
  }
  return threshold;
}

/**
 * Ink of an RGBA image: 1 where the lettering is. The lettering is the side of Otsu's threshold the
 * border pixels are not on (white letters on a dark plate and dark letters on paper both work).
 */
export function inkMask({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  const threshold = otsu(gray);
  let border = 0, bright = 0;
  for (let x = 0; x < width; x += 1) for (const y of [0, height - 1]) { border += 1; bright += gray[y * width + x] > threshold; }
  for (let y = 0; y < height; y += 1) for (const x of [0, width - 1]) { border += 1; bright += gray[y * width + x] > threshold; }
  const inkIsDark = bright * 2 >= border;
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i += 1) ink[i] = inkIsDark ? gray[i] <= threshold : gray[i] > threshold;
  return { ink, width, height };
}

function bounds({ ink, width, height }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (ink[y * width + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// The lettering of an image (canvas or picture) scaled so its ink block is NORMAL_HEIGHT x lines high.
function normalized(source, region, lines) {
  const [rx, ry, rw, rh] = region;
  const first = createCanvas(Math.max(1, Math.round(rw)), Math.max(1, Math.round(rh)));
  first.getContext("2d").drawImage(source, rx, ry, rw, rh, 0, 0, first.width, first.height);
  const mask = inkMask(first.getContext("2d").getImageData(0, 0, first.width, first.height));
  const box = bounds(mask);
  if (!box || box.height < 4) return null;
  // The ink as white on black, scaled with smoothing, then thresholded at half: polarity stays known.
  const ink = createCanvas(box.width, box.height);
  const inkContext = ink.getContext("2d");
  const pixels = inkContext.createImageData(box.width, box.height);
  for (let y = 0; y < box.height; y += 1) for (let x = 0; x < box.width; x += 1) {
    const value = mask.ink[(box.y + y) * mask.width + box.x + x] ? 255 : 0;
    const at = (y * box.width + x) * 4;
    pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = value;
    pixels.data[at + 3] = 255;
  }
  inkContext.putImageData(pixels, 0, 0);
  const scale = (NORMAL_HEIGHT * lines) / box.height;
  const pad = 4;
  const canvas = createCanvas(Math.max(8, Math.round(box.width * scale) + pad * 2), Math.round(box.height * scale) + pad * 2);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.drawImage(ink, 0, 0, box.width, box.height, pad, pad, box.width * scale, box.height * scale);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = data[i * 4] > 127 ? 1 : 0;
  return { ink: out, width, height };
}

// Connected pieces of ink (4-neighbors): [{area, x0, y0, x1, y1}].
function pieces({ ink, width, height }) {
  const label = new Int32Array(width * height);
  const found = [];
  const stack = [];
  for (let start = 0; start < ink.length; start += 1) {
    if (!ink[start] || label[start]) continue;
    const piece = { area: 0, x0: width, y0: height, x1: 0, y1: 0 };
    label[start] = found.length + 1;
    stack.push(start);
    while (stack.length) {
      const at = stack.pop();
      const x = at % width, y = (at - x) / width;
      piece.area += 1;
      if (x < piece.x0) piece.x0 = x; if (x > piece.x1) piece.x1 = x; if (y < piece.y0) piece.y0 = y; if (y > piece.y1) piece.y1 = y;
      for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, y > 0 ? at - width : -1, y < height - 1 ? at + width : -1])
        if (next >= 0 && ink[next] && !label[next]) { label[next] = found.length + 1; stack.push(next); }
    }
    found.push(piece);
  }
  return found;
}

// Letters as column runs: ink columns, joined across gaps under `join` of the height (the gaps
// between the dots of one dotted letter). GUESS: 0.1 for dotted lettering, from dot pitch about 1/6
// of the height on dot-matrix faces; 0 otherwise, since tightly set solid capitals sit closer than
// 0.1 of their height (measured on the film-trailer title: joining merged DANIELS into 4 runs and
// read a condensed face as extended).
function letterRuns({ ink, width, height }, join = 0) {
  const has = Array.from({ length: width }, (_, x) => { for (let y = 0; y < height; y += 1) if (ink[y * width + x]) return true; return false; });
  const runs = [];
  let x = 0;
  while (x < width) {
    if (!has[x]) { x += 1; continue; }
    let end = x;
    for (;;) {
      while (end + 1 < width && has[end + 1]) end += 1;
      let gap = end + 1;
      while (gap < width && !has[gap]) gap += 1;
      if (gap < width && gap - end - 1 < join * height) { end = gap; continue; }
      break;
    }
    runs.push([x, end]);
    x = end + 1;
  }
  return runs;
}

/** The measures of one ink mask (already normalized). `letters`: how many letters it holds, when known. */
export function measureInk(mask, { letters, lines = 1 } = {}) {
  const { ink, width, height } = mask;
  const lineHeight = height / lines;
  let area = 0, edge = 0;
  const at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? ink[y * width + x] : 0);
  // Edge pixels before and after a 3x3 majority smoothing: rough edges lose more of them.
  let smoothEdge = 0;
  const smooth = new Uint8Array(ink.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) count += at(x + dx, y + dy);
    smooth[y * width + x] = count >= 5;
  }
  const sAt = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? smooth[y * width + x] : 0);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (at(x, y)) { area += 1; if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) edge += 1; }
    if (sAt(x, y) && (!sAt(x - 1, y) || !sAt(x + 1, y) || !sAt(x, y - 1) || !sAt(x, y + 1))) smoothEdge += 1;
  }
  if (!area) return null;
  // Stroke thickness: ink area over half its outline.
  const stroke = (2 * area) / Math.max(1, edge);
  // Stem thickness (horizontal runs) against bar thickness (vertical runs).
  const runs = (horizontal) => {
    const found = [];
    const [outer, inner] = horizontal ? [height, width] : [width, height];
    for (let o = 0; o < outer; o += 1) {
      let run = 0;
      for (let i = 0; i <= inner; i += 1) {
        const value = i < inner && (horizontal ? at(i, o) : at(o, i));
        if (value) run += 1; else if (run) { found.push(run); run = 0; }
      }
    }
    return median(found);
  };
  const stems = runs(true), bars = runs(false);
  const contrast = stems && bars ? 1 - Math.min(stems, bars) / Math.max(stems, bars) : 0;
  // Dots: small, square-ish, filled pieces; their share of the ink.
  const all = pieces(mask);
  const dotPieces = all.filter((piece) => {
    const w = piece.x1 - piece.x0 + 1, h = piece.y1 - piece.y0 + 1;
    return w < 0.3 * lineHeight && h < 0.3 * lineHeight && w / h > 0.5 && w / h < 2 && piece.area / (w * h) > 0.55 && piece.area > 3;
  });
  const dots = dotPieces.reduce((sum, piece) => sum + piece.area, 0) / area;
  // Letters: given, else column runs. Width: the letters' ink width each, against the line height.
  const columnRuns = letterRuns(mask, dots >= DOTTED ? 0.1 : 0);
  const count = letters || columnRuns.length || 1;
  const inkWidth = columnRuns.reduce((sum, [a, b]) => sum + b - a + 1, 0);
  const widthRatio = inkWidth / lines / (count / lines) / lineHeight;
  // Slant: the shear that makes the column profile sharpest (stems stand upright), -30 to 30 degrees,
  // positive when the tops lean right.
  let slant = 0, sharpest = -1;
  // Nearest upright first, so a near tie keeps the smaller slant.
  for (const degrees of Array.from({ length: 61 }, (_, i) => (i % 2 ? (i + 1) / 2 : -i / 2))) {
    const shear = Math.tan((degrees * Math.PI) / 180);
    const profile = new Float64Array(width + 2 * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1)
      if (ink[y * width + x]) profile[Math.round(x + (y - height / 2) * shear + height)] += 1;
    let score = 0;
    for (const value of profile) score += value * value;
    if (score > sharpest * 1.001) { sharpest = score; slant = degrees; }
  }
  // Corners per letter run.
  const corners = [];
  for (const [a, b] of columnRuns) {
    let n = 0;
    for (let y = 0; y < height; y += 1) for (let x = a; x <= b; x += 1) n += at(x, y);
    if (n < 10) continue;
    let y0 = height, y1 = 0;
    for (let y = 0; y < height; y += 1) for (let x = a; x <= b; x += 1) if (at(x, y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const w = b - a + 1, h = y1 - y0 + 1;
    const side = Math.max(2, Math.round(0.2 * Math.min(w, h)));
    let inCorners = 0;
    for (const [cx, cy] of [[a, y0], [b - side + 1, y0], [a, y1 - side + 1], [b - side + 1, y1 - side + 1]])
      for (let y = cy; y < cy + side; y += 1) for (let x = cx; x < cx + side; x += 1) inCorners += at(x, y);
    const density = n / (w * h);
    corners.push(inCorners / (4 * side * side) / Math.max(0.05, density));
  }
  return {
    weight: round(stroke / lineHeight, 3),
    width: round(widthRatio, 3),
    slant,
    corners: round(Math.min(2, median(corners)) / 2, 3),
    contrast: round(contrast, 3),
    rough: round(smoothEdge ? Math.max(0, edge / smoothEdge - 1) : 0, 3),
    dots: round(dots, 3),
  };
}

/** Draws `text` in a fontkit font and measures it. */
export function measureFace(font, text = SAMPLE_TEXT) {
  const lines = String(text).split("\n");
  const size = 160;
  const scale = size / font.unitsPerEm;
  const laid = lines.map((line) => font.layout(line));
  const widths = laid.map((run) => run.positions.reduce((sum, position) => sum + position.xAdvance, 0) * scale);
  const canvas = createCanvas(Math.ceil(Math.max(...widths, 10) + size), Math.ceil(lines.length * size * 1.4 + size));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  laid.forEach((run, row) => {
    let x = size / 2;
    const baseline = size * 1.2 + row * size * 1.4;
    run.glyphs.forEach((glyph, index) => {
      const position = run.positions[index];
      const svg = glyph.path.toSVG();
      if (svg) {
        context.save();
        context.translate(x + position.xOffset * scale, baseline - position.yOffset * scale);
        context.scale(scale, -scale);
        context.fill(new Path2D(svg));
        context.restore();
      }
      x += position.xAdvance * scale;
    });
  });
  const mask = normalized(canvas, [0, 0, canvas.width, canvas.height], lines.length);
  return mask ? measureInk(mask, { letters: text.replace(/\s/g, "").length || undefined, lines: lines.length }) : null;
}

/** Each measure's difference in steps (candidate minus reference), largest first. */
export function differences(reference, candidate) {
  // Dots make every edge look rough, so rough edges do not count when either side is dotted
  // (measured on the product-film dot-matrix crop: JPEG round dots read rough 0.06, Doto drawn 0.23).
  const dotted = reference.dots >= DOTTED || candidate.dots >= DOTTED;
  return Object.entries(MEASURES).filter(([key]) => !(dotted && key === "rough")).map(([key, { scale }]) => {
    let step = (candidate[key] - reference[key]) / scale;
    if (key === "slant") step = (Math.abs(candidate[key]) - Math.abs(reference[key])) / scale;
    if (key === "dots") step = ((candidate.dots >= DOTTED) - (reference.dots >= DOTTED)) * DOT_CLASS_STEPS;
    return { key, step };
  }).sort((a, b) => Math.abs(b.step) - Math.abs(a.step));
}

export const distance = (reference, candidate) => {
  const steps = differences(reference, candidate);
  return round(Math.sqrt(steps.reduce((sum, { step }) => sum + step * step, 0) / steps.length), 2);
};

/** "heavier, more condensed": the measures that differ by a step or more, at most `most`. */
export function differenceWords(reference, candidate, most = 2) {
  const words = differences(reference, candidate).filter(({ step }) => Math.abs(step) >= 1).slice(0, most)
    .map(({ key, step }) => (step > 0 ? MEASURES[key].more : MEASURES[key].less));
  return words.join(", ") || "close on every measure";
}

/** The plain words for a lettering's class, used to pick catalog families to measure. */
export function classWords(measures) {
  const words = [];
  if (measures.dots >= DOTTED) words.push("dot-matrix");
  if (measures.rough >= 0.12 || Math.abs(measures.slant) >= 12) words.push("brush");
  if (measures.width < 0.6) words.push("condensed");
  if (measures.width > 0.95) words.push("extended");
  // Weight words filter the catalog by weights, which most brush and dotted families have one of.
  const shaped = words.length > 0 && (words[0] === "dot-matrix" || words.includes("brush"));
  if (measures.weight >= 0.16 && !shaped) words.push("heavy");
  if (measures.weight <= 0.07 && !shaped) words.push("light");
  if (measures.contrast >= 0.45) words.push("serif");
  if (measures.corners <= 0.25 && measures.dots < DOTTED) words.push("rounded");
  return words;
}

/** The CSS weight nearest a measured stroke: GUESS, from the bundled faces (Inter 400 0.11, 700 0.16 of the cap). */
export function cssWeight(stroke) {
  const steps = [[0.06, 200], [0.08, 300], [0.1, 400], [0.13, 500], [0.15, 600], [0.17, 700], [0.2, 800], [0.23, 900]];
  return steps.reduce((best, [value, weight]) => (Math.abs(value - stroke) < Math.abs(best[0] - stroke) ? [value, weight] : best))[1];
}

async function readMeasures(file) {
  if (!file) return {};
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; }
}
async function writeMeasures(file, value) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

// The longest side the picture is scaled to before kino looks for lettering boxes. GUESS: a
// 2688 px contact sheet becomes 1920 px, where a subtitle 12 px tall is still found (at 960 px
// the same sheet's subtitles were lost).
const SEARCH_SIDE = 1920;
// The strongest boxes kept, and how many the answer lists beside the one it measured.
const BOXES_KEPT = 8;
const OTHER_BOXES = 3;

/**
 * The boxes of the lines in a mask (1 where something stands out): its pixels joined along the line
 * (6 px each way) and a little across it (1 px), pieces at least 8 x 5 px, and pieces on one row
 * merged when the gap between them is under 1.5 line heights. [{x0, y0, x1, y1}].
 */
function lineBoxes(mask, width, height) {
  const joined = new Uint8Array(width * height);
  const reach = 6;
  for (let y = 0; y < height; y += 1) {
    let last = -1e9;
    for (let x = 0; x < width; x += 1) { if (mask[y * width + x]) last = x; if (x - last <= reach) joined[y * width + x] = 1; }
    last = 1e9;
    for (let x = width - 1; x >= 0; x -= 1) { if (mask[y * width + x]) last = x; if (last - x <= reach) joined[y * width + x] = 1; }
  }
  const tall = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1)
    if (joined[y * width + x]) { tall[y * width + x] = 1; if (y > 0) tall[(y - 1) * width + x] = 1; if (y < height - 1) tall[(y + 1) * width + x] = 1; }
  const boxes = pieces({ ink: tall, width, height }).map((piece) => ({ x0: piece.x0, y0: piece.y0, x1: piece.x1, y1: piece.y1 }))
    .filter((box) => box.y1 - box.y0 + 1 >= 5 && box.x1 - box.x0 + 1 >= 8);
  // Passes until nothing merges; a merged box keeps growing in place instead of starting the pass over
  // (restarting took 563 ms on 4,958 small marks in rows).
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      const ha = a.y1 - a.y0 + 1, hb = b.y1 - b.y0 + 1;
      const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
      const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) - 1;
      if (overlap >= 0.6 * Math.min(ha, hb) && gap < 1.5 * Math.max(ha, hb) && Math.max(ha, hb) < 3 * Math.min(ha, hb)) {
        boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), parts: [...(a.parts ?? [a]), ...(b.parts ?? [b])] };
        boxes.splice(j, 1);
        j = i;
        merged = true;
      }
    }
  }
  return boxes;
}

/**
 * The picture's lettering boxes, largest first: [{x, y, width, height}] in the picture's pixels.
 * Edges (a step of 40 gray levels) are joined along the line, boxes on one row are merged when the
 * gap between them is under 1.5 line heights, and a box counts as lettering when it is wider than tall
 * and under 45% of the picture high, its ink covers 8% to 75% of it, splits into 2 or more letters
 * (3 for a box over a tenth of the picture high) by empty columns that are typically a fifth of the
 * line high, and its edge pixels fill 9% or more of it (a photo's ink breaks into slivers and is smooth).
 * Near-white pixels make boxes too (white type over an edgy picture), and a merged box that fails has
 * its parts tried alone. GUESS: every number here, set on a drawn title and caption, a noisy picture
 * and three contact sheets of film frames (the sheets' captions, short words and a white word over hair
 * were found; a caption 8 px tall was not).
 */
export function letteringBoxes(image) {
  const factor = Math.min(1, SEARCH_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * factor)), height = Math.max(1, Math.round(image.height * factor));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  const edge = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const at = y * width + x;
    edge[at] = Math.abs(gray[at + 1] - gray[at - 1]) + Math.abs(gray[at + width] - gray[at - width]) >= 40 ? 1 : 0;
  }
  // Candidates from the edges, and from near-white pixels: white lettering over an edgy picture (a
  // title over hair) joins the picture's edges into one tall box, but its own white pixels stand alone.
  // GUESS: 225 of 255, set on a white blackletter word over drawn hair that the edges alone missed.
  const white = new Uint8Array(width * height);
  for (let i = 0; i < white.length; i += 1) white[i] = gray[i] >= 225 ? 1 : 0;
  const boxes = [...lineBoxes(edge, width, height), ...lineBoxes(white, width, height)];
  const found = [], kept = [];
  for (let at = 0; at < boxes.length; at += 1) {
    const box = boxes[at];
    // A merged box that is not lettering gets its parts tried one by one: two words side by side on a
    // sheet's neighboring frames merge into one box that holds the face between them.
    const tryParts = () => { if (box.parts) boxes.push(...box.parts); };
    const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
    // A line of lettering is wider than tall and under 45% of the picture high (a taller box is a run
    // of frames joined on a sheet; a title set across a single frame measured 34%).
    if (w < 1.2 * h || h > 0.45 * height) { tryParts(); continue; }
    const crop = createCanvas(w, h);
    crop.getContext("2d").drawImage(canvas, box.x0, box.y0, w, h, 0, 0, w, h);
    const mask = inkMask(crop.getContext("2d").getImageData(0, 0, w, h));
    let ink = 0;
    for (const value of mask.ink) ink += value;
    const share = ink / (w * h);
    if (share < 0.08 || share > 0.75) { tryParts(); continue; }
    // Letters: at least 2 columns of ink split by gaps, the typical one at least a fifth of the line
    // high (a photo's ink breaks into 1 px slivers), and the box edgy all through (photos are smooth).
    const letters = letterRuns(mask);
    if (letters.length < (h > height / 10 ? 3 : 2) || median(letters.map(([a, b]) => b - a + 1)) < 0.2 * h) { tryParts(); continue; }
    let edges = 0;
    for (let yy = box.y0; yy <= box.y1; yy += 1) for (let xx = box.x0; xx <= box.x1; xx += 1) edges += edge[yy * width + xx];
    if (edges / (w * h) < 0.09) { tryParts(); continue; }
    // The same line found from the edges and from its white pixels is listed once.
    const shared = (other) => Math.max(0, Math.min(box.x1, other.x1) - Math.max(box.x0, other.x0) + 1) * Math.max(0, Math.min(box.y1, other.y1) - Math.max(box.y0, other.y0) + 1);
    if (kept.some((other) => shared(other) > 0.5 * Math.min(w * h, (other.x1 - other.x0 + 1) * (other.y1 - other.y0 + 1)))) continue;
    kept.push(box);
    // Padded by a tenth of the line height, back in the picture's pixels.
    const pad = Math.max(1, Math.round(h * 0.1));
    const x = Math.max(0, box.x0 - pad), y = Math.max(0, box.y0 - pad);
    const right = Math.min(width, box.x1 + 1 + pad), bottom = Math.min(height, box.y1 + 1 + pad);
    found.push({ x: Math.round(x / factor), y: Math.round(y / factor), width: Math.round((right - x) / factor), height: Math.round((bottom - y) / factor) });
  }
  return found.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, BOXES_KEPT);
}

/**
 * The lettering to match: { image, region, boxes } from an image path or a saved reference moment.
 * `region` is [x, y, width, height] in pixels, or in fractions of the picture when every value is 1
 * or less. Without it kino finds the lettering boxes (letteringBoxes) and measures the largest;
 * `boxes` then holds { measured, others, found } ({ found: 0 } measures the whole picture).
 */
async function letteringSource({ like, t, region }, { referenceFrame }) {
  const text = String(like ?? "").trim();
  let image;
  if (/^yt:/.test(text)) {
    if (!referenceFrame) throw new Error("saved references are not available here.");
    image = await loadImage(await referenceFrame(text, Number(t)));
  } else {
    if (!path.isAbsolute(text)) throw new Error(`like takes an absolute path of a picture (PNG or JPEG) or a saved reference id with t (like:"yt:<id>", t:<seconds>); "${text}" is neither.`);
    image = await loadImage(await readFile(text));
  }
  const given = Array.isArray(region) && region.length === 4 && region.every(Number.isFinite);
  let box = given ? region : [0, 0, image.width, image.height];
  let boxes = null;
  if (!given) {
    const found = letteringBoxes(image);
    boxes = { found: found.length, measured: found[0] ?? null, others: found.slice(1, 1 + OTHER_BOXES) };
    if (found.length) box = [found[0].x, found[0].y, found[0].width, found[0].height];
  }
  if (given && box.every((value) => value <= 1)) box = [box[0] * image.width, box[1] * image.height, box[2] * image.width, box[3] * image.height];
  const [x, y] = [Math.max(0, box[0]), Math.max(0, box[1])];
  return { image, region: [x, y, Math.min(image.width - x, box[2]), Math.min(image.height - y, box[3])], boxes };
}

const asRegion = (box) => `[${box.x}, ${box.y}, ${box.width}, ${box.height}]`;

// Whether the text of `rejected` names the family: its words, not letters inside a longer word.
const names = (text, family) => new RegExp(`(^|[^a-z0-9])${family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(String(text).toLowerCase());

/**
 * What the project already knows about a face, as a fact for its line in the ranking (the face stays
 * listed): the person turned it down (`rejected`: the style's rejected texts that name it), or kino
 * rendered it in another project (`seen`: house memory type looks, [{family, name, rev}], newest first).
 */
export function faceNote(family, { rejected = [], seen = [] } = {}) {
  const turnedDown = rejected.find((text) => names(text, family));
  // style.rejected holds on-screen text the person turned down, not faces: the fact is that the text
  // names the family ("Cookie" is a family and a word), so the line quotes it and the agent judges.
  if (turnedDown) return `named in text the person turned down: "${String(turnedDown).slice(0, 60)}"`;
  const used = seen.find((entry) => String(entry.family).toLowerCase() === family.toLowerCase());
  return used ? `seen before: the type of "${used.name}" r${used.rev}` : null;
}

/**
 * library {topic:"fonts", like, region?, t?, text?, count?}: { text, fonts }. `fonts` is the
 * project's FontRegistry, `catalog` the font catalog (downloads the class's families), and
 * `lookFamilies(words)` the catalog families of a class, best first ([{id, family, weights}]).
 */
export async function fontsLikeText(input, { fonts, catalog, lookFamilies, referenceFrame, faceMarks }) {
  const { image, region, boxes } = await letteringSource(input, { referenceFrame });
  const words = typeof input.text === "string" && input.text.trim() ? input.text.trim() : null;
  const lines = words ? words.split("\n").length : 1;
  const mask = normalized(image, region, lines);
  const reference = mask && measureInk(mask, { letters: words ? words.replace(/\s/g, "").length : undefined, lines });
  if (!reference) throw new Error("no lettering found in that region: give region [x, y, width, height] around one line of the letters.");
  const sample = words ?? SAMPLE_TEXT;
  const count = Math.min(20, Math.max(1, Number(input.count) || SHOWN));
  const wanted = cssWeight(reference.weight);
  const kinds = classWords(reference);

  // The class's catalog families, downloaded at the nearest weight (offline: the cached ones only).
  let downloaded = 0, catalogNote = "";
  if (catalog && lookFamilies && kinds.length) {
    try {
      const installed = new Set(fonts.faces.map((face) => face.family.toLowerCase()));
      const families = (await lookFamilies(kinds)).filter((family) => !installed.has(family.family.toLowerCase())).slice(0, MOST_DOWNLOADS);
      for (const family of families) {
        const weight = [...family.weights].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0];
        try { await catalog.ensureFace({ id: family.id, weight, style: "normal", text: sample }); downloaded += 1; }
        catch (error) { catalogNote = error.message; }
      }
      if (downloaded) await catalog.loadInto(fonts);
    } catch (error) { catalogNote = error.message; }
  }

  // One face per family, weight and style that draws the sample's letters.
  const cache = await readMeasures(catalog?.measuresFile);
  let changed = false;
  const seen = new Map();
  for (const face of fonts.faces) {
    if (face.style !== "normal") continue;
    const key = `${face.family}|${face.weight}`;
    if (seen.has(key)) continue;
    if (![...sample.replace(/\s/g, "")].every((character) => face.font.hasGlyphForCodePoint(character.codePointAt(0)))) continue;
    seen.set(key, face);
  }
  const ranked = [];
  for (const face of seen.values()) {
    // The measure version leads the key, so a change to measureInk never reads older numbers.
    const cacheKey = `${MEASURE_VERSION}|${face.src ?? face.id}|${face.weight}|${sample}`;
    let measures = cache[cacheKey];
    if (!measures) {
      try { measures = measureFace(face.font, sample); } catch { measures = null; }
      if (!measures) continue;
      cache[cacheKey] = measures;
      changed = true;
    }
    ranked.push({ family: face.family, weight: face.weight, measures, distance: distance(reference, measures), differs: differenceWords(reference, measures) });
  }
  if (changed) await writeMeasures(catalog?.measuresFile, cache).catch(() => {});
  ranked.sort((a, b) => a.distance - b.distance);
  const shown = ranked.slice(0, count);
  // Faces the person turned down or kino used in other projects: a fact on the line, the face stays listed.
  const marks = faceMarks ? await faceMarks().catch(() => null) : null;
  for (const font of shown) { const note = marks ? faceNote(font.family, marks) : null; if (note) font.note = note; }
  const measured = Object.entries(reference).map(([key, value]) => `${key} ${value}`).join(", ");
  const lines_ = shown.map((font, index) => `${index + 1}. ${font.family} ${font.weight} (distance ${font.distance}: ${font.differs})${font.note ? ` [${font.note}]` : ""} set_font {layerIds:["<layer>"], family:${JSON.stringify(font.family)}, weight:${font.weight}}`);
  // Which box was measured, and the other boxes the call can name as region.
  const area = `[${region.map((value) => Math.round(value)).join(", ")}]`;
  const boxLine = !boxes ? ""
    : boxes.found
      ? `\nbox measured: ${area}, the largest of ${boxes.found} lettering box${boxes.found === 1 ? "" : "es"} kino found${boxes.others.length ? `; others, to measure one pass region: ${boxes.others.map(asRegion).join(", ")}` : ""}.`
      : `\nno lettering box found, so the whole picture was measured: pass region [x, y, width, height] around one line of the letters.`;
  return {
    text: [
      `fonts like the lettering in ${String(input.like)}${input.t != null ? ` @${input.t}s` : ""} ${area}: ${measured} (weight and width against the line height; corners 0 round to 1 square).${boxLine}`,
      ...lines_,
      `${ranked.length} faces measured on "${sample}"${kinds.length ? `; class: ${kinds.join(", ")}${downloaded ? ` (${downloaded} catalog families downloaded)` : ""}` : ""}${catalogNote && !downloaded ? `; catalog: ${catalogNote}` : ""}.${words ? "" : " text:\"<the words in the region>\" measures the same letters and ranks closer."}`,
    ].join("\n"),
    fonts: shown.map(({ family, weight, distance: gap, differs, note }) => ({ family, weight, distance: gap, differs, ...(note ? { note } : {}) })),
    measures: reference,
    region: region.map((value) => Math.round(value)),
    ...(boxes ? { box: { found: boxes.found, others: boxes.others.map((box) => [box.x, box.y, box.width, box.height]) } } : {}),
  };
}

// How many saved type labels the fonts answer measures, and how many faces it lists for each.
// GUESS: 2 labels keep the answer small and the downloads few; run 8 saved 3 type labels on 2 references.
const LABELS_MEASURED = 2;
const LABEL_FACES = 4;

/**
 * The fonts answer's first lines when references carry type labels (library inspire "seen ... type:"):
 * the `like:` ranking at each labeled moment, so the faces nearest the references' own lettering
 * come before any catalog search result (run 8: `like:` was offered and never called; the face used
 * was the first catalog result). `labels` is [{id, at, words}]. Resolves { text, found } or null
 * without labels; a label whose frame holds no measurable lettering says so and names the region call.
 */
export async function fontsLikeLabels(labels, deps) {
  if (!labels?.length) return null;
  const lines = [], found = [];
  for (const label of labels.slice(0, LABELS_MEASURED)) {
    const where = `${label.id} @${label.at}`;
    const words = String(label.words ?? "").slice(0, 60);
    try {
      const { fonts: ranked, region, box } = await fontsLikeText({ like: label.id, t: label.at, count: LABEL_FACES }, deps);
      found.push({ ref: label.id, at: label.at, fonts: ranked.map(({ family, weight, distance: gap }) => ({ family, weight, distance: gap })) });
      // The label has no region, so kino measures the frame's largest lettering box (the whole frame when
      // it finds none). When the faces sit this close the measure cannot tell them apart (run 8's @1.6
      // caption, 8 px tall in a 240 px frame: 3.19 to 3.46, 8% apart); the line says so and gives the
      // region call. GUESS: 10% between the first and last face listed.
      const close = ranked.length > 1 && (ranked.at(-1).distance - ranked[0].distance) / ranked[0].distance < 0.1;
      const measuredBox = box?.found ? `box [${region.join(", ")}] of ${box.found}` : "whole frame";
      lines.push(`like your label ${where} "${words}" (${measuredBox}${close ? `, too close to tell apart: like:"${label.id}", t:${label.at}, region:[x,y,w,h]` : ""}): ${ranked.map((font) => `${font.family} ${font.weight} (${font.distance})${font.note ? ` [${font.note}]` : ""}`).join(", ")}`);
    } catch (error) {
      lines.push(`your label ${where} "${words}" was not measured (${error.message.split(/[.:]/)[0]}): library {topic:"fonts", like:"${label.id}", t:${label.at}, region:[x,y,w,h]}`);
    }
  }
  const more = labels.length - LABELS_MEASURED;
  return { text: `${lines.join("\n")}\n(smaller distance = closer letters${more > 0 ? `; ${more} more label${more === 1 ? "" : "s"}: like:"<ref>", t` : ""}; region:[x,y,w,h] around the letters measures them alone)`, found };
}
