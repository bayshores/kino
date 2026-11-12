// library {topic:"fonts", like, region}: the faces whose letters look most like the lettering in a
// picture. kino measures the lettering in the crop (stroke weight, letter width, slant, corners,
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

// How far apart two faces are on one measure before it counts as one step of difference. GUESS,
// set from the spread of the bundled faces (Inter, Montserrat, Noto Serif at 400 and 700).
const MEASURES = {
  weight: { scale: 0.025, more: "heavier", less: "lighter" },
  width: { scale: 0.12, more: "wider", less: "more condensed" },
  slant: { scale: 5, more: "more slanted", less: "more upright" },
  corners: { scale: 0.2, more: "squarer corners", less: "rounder corners" },
  contrast: { scale: 0.2, more: "more stroke contrast", less: "less stroke contrast" },
  rough: { scale: 0.06, more: "rougher edges", less: "cleaner edges" },
  dots: { scale: 0.25, more: "more dotted", less: "solid strokes" },
};

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

// Letters as column runs: ink columns, joined across gaps under 0.1 of the height (the gaps
// between the dots of one dotted letter); gaps over 0.25 of the height are word spaces. GUESS
// thresholds, from dot pitch about 1/6 of the height on dot-matrix faces.
function letterRuns({ ink, width, height }) {
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
      if (gap < width && gap - end - 1 < 0.1 * height) { end = gap; continue; }
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
  const columnRuns = letterRuns(mask);
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
  return Object.entries(MEASURES).map(([key, { scale }]) => {
    let step = (candidate[key] - reference[key]) / scale;
    if (key === "slant") step = (Math.abs(candidate[key]) - Math.abs(reference[key])) / scale;
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
  if (measures.dots >= 0.4) words.push("dot-matrix");
  if (measures.rough >= 0.12 || Math.abs(measures.slant) >= 12) words.push("brush");
  if (measures.width < 0.6) words.push("condensed");
  if (measures.width > 0.95) words.push("extended");
  // Weight words filter the catalog by weights, which most brush and dotted families have one of.
  const shaped = words.length > 0 && (words[0] === "dot-matrix" || words.includes("brush"));
  if (measures.weight >= 0.16 && !shaped) words.push("heavy");
  if (measures.weight <= 0.07 && !shaped) words.push("light");
  if (measures.contrast >= 0.45) words.push("serif");
  if (measures.corners <= 0.25 && measures.dots < 0.4) words.push("rounded");
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

/**
 * The lettering to match: { image, region } from an image path or a saved reference moment.
 * `region` is [x, y, width, height] in pixels, or in fractions of the picture when every value is 1
 * or less. Without it the whole picture is measured.
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
  let box = Array.isArray(region) && region.length === 4 && region.every(Number.isFinite) ? region : [0, 0, image.width, image.height];
  if (box.every((value) => value <= 1)) box = [box[0] * image.width, box[1] * image.height, box[2] * image.width, box[3] * image.height];
  const [x, y] = [Math.max(0, box[0]), Math.max(0, box[1])];
  return { image, region: [x, y, Math.min(image.width - x, box[2]), Math.min(image.height - y, box[3])] };
}

/**
 * library {topic:"fonts", like, region?, t?, text?, count?}: { text, fonts }. `fonts` is the
 * project's FontRegistry, `catalog` the font catalog (downloads the class's families), and
 * `lookFamilies(words)` the catalog families of a class, best first ([{id, family, weights}]).
 */
export async function fontsLikeText(input, { fonts, catalog, lookFamilies, referenceFrame }) {
  const { image, region } = await letteringSource(input, { referenceFrame });
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
    const cacheKey = `${face.src ?? face.id}|${face.weight}|${sample}`;
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
  const measured = Object.entries(reference).map(([key, value]) => `${key} ${value}`).join(", ");
  const lines_ = shown.map((font, index) => `${index + 1}. ${font.family} ${font.weight} (distance ${font.distance}: ${font.differs}) set_font {layerIds:["<layer>"], family:${JSON.stringify(font.family)}, weight:${font.weight}}`);
  return {
    text: [
      `fonts like the lettering in ${String(input.like)}${input.t != null ? ` @${input.t}s` : ""} [${region.map((value) => Math.round(value)).join(", ")}]: ${measured} (weight and width against the line height; corners 0 round to 1 square).`,
      ...lines_,
      `${ranked.length} faces measured on "${sample}"${kinds.length ? `; class: ${kinds.join(", ")}${downloaded ? ` (${downloaded} catalog families downloaded)` : ""}` : ""}${catalogNote && !downloaded ? `; catalog: ${catalogNote}` : ""}.${words ? "" : " text:\"<the words in the region>\" measures the same letters and ranks closer."}`,
    ].join("\n"),
    fonts: shown.map(({ family, weight, distance: gap, differs }) => ({ family, weight, distance: gap, differs })),
    measures: reference,
  };
}
