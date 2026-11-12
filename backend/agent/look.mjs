// `look`: rendered frames for the agent. Every image comes from the export renderer, so the
// agent sees the same pixels a final render has. Frames are cached by content (the scene
// after components are expanded, the fonts it is missing, the time, the size and the renderer
// version), in memory and on disk, so asking again costs milliseconds.
//
// Modes: frame (one frame), sheet (a contact sheet of one scene), zoom (a crop around a layer),
// strip (6 tiles across one animation, or every frame), frames (every frame of a stretch, or up to
// 60 chosen `times` as labeled pages, cropped to a `layer`; timesPlan lays them out), compare (an earlier revision beside the current one,
// only where they differ), changed (only the frames that changed since the last look), source
// (a video layer's whole source frame with a grid, its crop and subject boxes, beside the result),
// board (the storyboard, a row per shot: backend/agent/board-look.mjs) and review (the moments
// that matter at full size, 2×2 a page: backend/agent/review.mjs picks them).
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas";
import { evaluateLayer } from "../../engine/animation.js";
import { layerMatrix, multiply, parentMatrix, point, worldMatrix } from "../../engine/geometry.js";
import { inkBox } from "../../engine/quality/kinoTimeline.js";
import { hasTextChanges } from "../../engine/textChange.js";
import { shownTextAt } from "../../engine/textChangeDraw.js";
import { resizeTextLayer } from "../../engine/textLayout.js";
import { missingDocumentFonts } from "../../engine/fontRecovery.js";
import { frameRateFraction } from "../../engine/frameRate.js";
import { exportScene, renderStills } from "../export.mjs";
import { sceneShutterOptions, shutterFps } from "../../engine/previewBlur.js";
import { PREVIEW_FPS, PREVIEW_QUALITY, previewSize } from "../preview-segments.mjs";
import { renderContentKey } from "../render-segment-cache.mjs";
import { graphicsCacheInput } from "../render-devices.mjs";
import { sec } from "./describe.mjs";
import { coverImage } from "./judge.mjs";
import { CLIPS_GAP, CLIPS_HEADER } from "./clips-sheet.mjs";

// Bump when rendering changes so cached frames are not reused.
export const RENDERER_VERSION = "a6.2";
export const SHEET_FRAMES = 12;
export const TILE_LONG_EDGE = 240;
// look zoom draws a crop at most this many px on its long edge, at up to 2x: a 950x250 headline
// crop comes back 1024 px wide (look frame's default is 480 px across the whole scene).
export const ZOOM_EDGE = 1024;
export const STRIP_TILES = 6;
// look frames (and strip every:true): every output frame at FRAME_RATE, at most FRAMES_MOST a
// call, 6 to a row (a row is 0.2 s).
export const FRAME_RATE = 30;
export const FRAMES_MOST = 36;
// look frames with chosen times or every:<n> (GAPS friction 3: 28 to 57 one-frame looks a build):
// up to TIMES_MOST times in one call, laid out as pages of labeled tiles. A page is at most
// PAGE_WIDTH px wide (1,568 px is the edge Claude reads without scaling an image down) and
// PAGE_PIXELS px in all (a guess: about 1,700 image tokens, near the board page's 1,521), and a
// call draws at most PAGES_MOST pages, so the answer stays near 5,000 image tokens however many
// times were asked; the times left over come back as a ready call.
export const TIMES_MOST = 60;
export const PAGE_WIDTH = 1568;
export const PAGE_PIXELS = 1_300_000;
export const PAGES_MOST = 3;
const TILE_GAP = 4;
// look review's seam strips: 5 frames across each cut (SEAM_OFFSETS seconds), SEAM_EDGE px each.
export const SEAM_OFFSETS = [-0.2, -0.1, 0, 0.1, 0.2];
export const SEAM_EDGE = 200;
// A layer shown or hidden this close to a cut (seconds) shares its seam strip.
export const SEAM_MERGE = 0.1;
// The long edge of each picture in look versus (6 pairs stay near a sheet's image size).
export const VERSUS_EDGE = 320;
// look review: each frame's long edge (px), the grid of a page and how many finding lines a
// frame's strip shows.
export const REVIEW_EDGE = 1280;
export const REVIEW_ROWS = 2;
// A review page is at most this wide (Claude's largest image edge), so 1280 px frames sit 2
// across and 560 px ones 4 across.
export const REVIEW_PAGE_WIDTH = 2576;
const REVIEW_GAP = 8;
// The line around each review tile (the frame's edge on the dark page), drawn in a margin this
// wide so the tiles at the page's edges are outlined on every side too.
const REVIEW_OUTLINE = "#8a8f99";
const REVIEW_MARGIN = 2;
// The grey thumbnail that finds near-duplicate frames (16:9 at 48 x 27 cells).
export const REVIEW_THUMB = { width: 48, height: 27 };
/** How many review frames `width` px wide fit across one page. */
export const reviewColumns = (width) => Math.max(1, Math.floor((REVIEW_PAGE_WIDTH - 2 * REVIEW_MARGIN + REVIEW_GAP) / (width + REVIEW_GAP)));
const REVIEW_NOTE_LINES = 3;
const MEMORY_FRAMES = 160;
const DISK_FRAMES = 4000;
// A pixel counts as changed when a color channel moves more than 20% (the plan's 0.2 threshold);
// a frame counts as changed when at least this many pixels do.
const PIXEL_THRESHOLD = Math.round(0.2 * 255);
const CHANGED_PIXELS = 8;
// look source: the source panel's long edge (px), by default and at the least and most.
export const SOURCE_EDGE = 640;
export const SOURCE_EDGE_RANGE = [320, 1280];
// look source's drawing: tag colours by who drew a box (the tag's word says it too).
const BOX_COLOURS = { agent: "#ffd23f", vision: "#2ec4b6" };
// look board: the page is BOARD_WIDTH px wide and each shot a BOARD_ROW px row (4 rows make a
// 1092 px square, 1,521 image tokens: one per 28 × 28 patch). A row holds the source frame in a
// 439 × 239 box, the cropped still in a 200 × 239 box and a column of words.
export const BOARD_WIDTH = 1092;
export const BOARD_ROW = 273;
const BOARD_SOURCE = { width: 439, height: 239 };
const BOARD_STILL = { width: 200, height: 239 };
// The colors of the board's words: plain lines, kino's flags and the agent's reason.
export const BOARD_INK = { line: "#ffffff", flag: "#ffd23f", why: "#b8bcc4" };

const labelFont = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts/Inter-600.ttf");
let labelFontReady = false;
function ensureLabelFont() {
  if (labelFontReady) return;
  try { GlobalFonts.registerFromPath(labelFont, "kino-label"); } catch { /* the canvas falls back to its default font */ }
  labelFontReady = true;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function createFrameCache(directory) {
  const memory = new Map();
  let writes = 0;
  // The most bytes the disk cache may hold (set from the dashboard's compute settings).
  let maxBytes = Infinity;
  const file = (key) => path.join(directory, `${key}.png`);

  async function get(key) {
    if (memory.has(key)) {
      const value = memory.get(key);
      memory.delete(key);
      memory.set(key, value);
      return value;
    }
    try {
      const buffer = await readFile(file(key));
      remember(key, buffer);
      return buffer;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function remember(key, buffer) {
    memory.set(key, buffer);
    while (memory.size > MEMORY_FRAMES) memory.delete(memory.keys().next().value);
  }

  async function set(key, buffer) {
    remember(key, buffer);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file(key), buffer, { mode: 0o600 });
    if (++writes % 200 === 0) await prune().catch(() => {});
  }

  // Keeps the newest frames on disk: at most DISK_FRAMES files and at most maxBytes.
  async function prune() {
    const names = await frameFiles();
    if (names.length <= DISK_FRAMES && maxBytes === Infinity) return;
    const dated = await Promise.all(names.map(async (name) => {
      const info = await stat(path.join(directory, name)).catch(() => ({ mtimeMs: 0, size: 0 }));
      return { name, time: info.mtimeMs, size: info.size };
    }));
    dated.sort((a, b) => a.time - b.time);
    let count = dated.length;
    let bytes = dated.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of dated) {
      if (count <= DISK_FRAMES && bytes <= maxBytes) break;
      await rm(path.join(directory, entry.name), { force: true });
      count -= 1;
      bytes -= entry.size;
    }
  }

  async function frameFiles() {
    try { return (await readdir(directory)).filter((name) => name.endsWith(".png")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  // How many frames the disk cache holds and their total size.
  async function usage() {
    const names = await frameFiles();
    let bytes = 0;
    for (const name of names) bytes += (await stat(path.join(directory, name)).catch(() => ({ size: 0 }))).size;
    return { frames: names.length, bytes, limitBytes: Number.isFinite(maxBytes) ? maxBytes : null };
  }

  // Removes every cached frame (they are made again when needed).
  async function clear() {
    memory.clear();
    for (const name of await frameFiles()) await rm(path.join(directory, name), { force: true });
  }

  // Sets the size limit in bytes (0 or less: no limit) and trims the cache to it.
  async function limit(bytes) {
    maxBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : Infinity;
    await prune();
  }

  return { get, set, prune, usage, clear, limit };
}

// What a rendered scene depends on besides its JSON: fonts it would draw with a fallback.
export function sceneKey(scene, fonts) {
  const missing = missingDocumentFonts({ scenes: [scene] }, fonts).map((entry) => `${entry.fontFamily}/${entry.fontWeight}/${entry.fontStyle}`);
  return hash(`${RENDERER_VERSION}\n${JSON.stringify(scene)}\n${missing.join(",")}`).slice(0, 32);
}

// The tile size for a scene: its long edge is `longEdge` pixels.
export function tileSize(scene, longEdge = TILE_LONG_EDGE) {
  const scale = longEdge / Math.max(scene.width, scene.height);
  return { width: Math.max(2, Math.round(scene.width * scale)), height: Math.max(2, Math.round(scene.height * scale)), scale };
}

export function evenTimes(start, end, count) {
  if (count <= 1 || end <= start) return [sec(start)];
  return Array.from({ length: count }, (_, index) => sec(start + ((end - start) * index) / (count - 1)));
}

// Every output frame from `start` to `end` (seconds), at most FRAMES_MOST; `rest` is the time of
// the first frame left out (null when all fit).
// `fps` is the project's rate (frameRate.js projectFps); frame times come from its exact fraction,
// so frame 36 at 23.976 is 1.5015 s, not 1.5.
export function everyFrame(start, end, most = FRAMES_MOST, fps = FRAME_RATE) {
  const { num, den } = frameRateFraction(fps);
  const first = Math.floor((start * num) / den + 1e-6), last = Math.floor((end * num) / den + 1e-6);
  const count = Math.max(1, last - first + 1);
  const times = Array.from({ length: Math.min(count, most) }, (_, index) => ((first + index) * den) / num);
  return { times, rest: count > most ? sec(((first + most) * den) / num) : null };
}

// Every `every`-th output frame from `start` to `end` (seconds), at most `most`; `rest` is the
// time of the first frame left out (null when all fit). every 1 is everyFrame.
export function everyNth(start, end, every, most = TIMES_MOST, rate = FRAME_RATE) {
  const step = Math.max(1, Math.round(every));
  const first = Math.floor(start * rate + 1e-6), last = Math.floor(end * rate + 1e-6);
  const count = Math.max(1, Math.floor((last - first) / step) + 1);
  const times = Array.from({ length: Math.min(count, most) }, (_, index) => (first + index * step) / rate);
  return { times, rest: count > most ? sec((first + most * step) / rate) : null };
}

// How chosen times lay out as pages of `tile` sized tiles: { columns, perPage (tiles on the
// fullest page), pages, shown (how many of `count` this call draws) }. Pages are balanced, so 40
// tiles that fit 36 a page come as two of 20, not 36 and 4.
export function timesPlan(count, tile, { pageWidth = PAGE_WIDTH, pagePixels = PAGE_PIXELS, pagesMost = PAGES_MOST } = {}) {
  const fit = Math.max(1, Math.floor((pageWidth + TILE_GAP) / (tile.width + TILE_GAP)));
  const width = fit * (tile.width + TILE_GAP) - TILE_GAP;
  const rows = Math.max(1, Math.floor((pagePixels / width + TILE_GAP) / (tile.height + TILE_GAP)));
  const shown = Math.max(0, Math.min(count, fit * rows * pagesMost));
  const pages = Math.max(1, Math.ceil(shown / (fit * rows)));
  const perPage = Math.max(1, Math.ceil(shown / pages));
  // Rows evenly filled, as columnsFor spreads a sheet: 4 tiles that fit 3 a row come 2 and 2.
  return { columns: Math.ceil(perPage / Math.ceil(perPage / fit)), perPage, pages, shown };
}

// The tile a times look draws for a scene (or a layer's `crop`): `width` px wide, else `longEdge`
// on its long edge. A whole frame is drawn at most at the scene's size; a crop at most 2x (as zoom
// draws it). Returns { tile, scale }.
export function timesTile(scene, crop, { longEdge = TILE_LONG_EDGE, width } = {}) {
  const box = crop ?? { width: scene.width, height: scene.height };
  const wanted = width ? width / box.width : longEdge / Math.max(box.width, box.height);
  const scale = Math.min(wanted, crop ? 2 : 1, 4096 / Math.max(scene.width, scene.height));
  return { tile: { width: Math.max(2, Math.round(box.width * scale)), height: Math.max(2, Math.round(box.height * scale)) }, scale };
}

// The default long edge of a times look's tiles when no width is asked: the largest of 480 down
// to 240 px (in 40 px steps) that still draws all `count` times on one page. A 1920 px frame's 60
// px headline is 7.5 px tall in a 240 px tile, too small to read letters (seen on the product-film
// proof sheet, 2026-11-11), so a few times get bigger tiles; 25 or more of a 16:9 frame stay at
// 240 (the frames look's tile). The steps are a guess.
export function timesEdge(count, scene, crop = null) {
  for (let edge = 480; edge > TILE_LONG_EDGE; edge -= 40) {
    const plan = timesPlan(count, timesTile(scene, crop, { longEdge: edge }).tile);
    if (plan.pages === 1 && plan.shown >= count) return edge;
  }
  return TILE_LONG_EDGE;
}

// The largest label of a times page, in px. Measured on a review sheet (2026-11-11): a title
// cropped to a 475x480 tile got a 43 px label whose 65 px bar hid the bottom of its last line,
// while the crop's own margin (24 scene px) was 31 px there. So a label is at most 18 px (a
// guess that still reads at full size) and, on a crop, its bar fits inside the margin.
export function timesLabel(scale, cropped) {
  return cropped ? Math.max(10, Math.min(18, Math.floor((24 * scale) / 1.5))) : 18;
}

// Sheet times: evenly spread, but never exactly at the end (the last frame is just before it).
export function sheetTimes(duration, count = SHEET_FRAMES) {
  const last = Math.max(0, duration - Math.min(0.05, duration / 100));
  return evenTimes(0, last, count);
}

// look changed (GAPS round 4): the probe times across a scene and the spans where two versions
// differ. `flags[i]` says the picture at `times[i]` differs; a run of them is one span, from its
// first probe to one probe step after its last (at most `last`). A probe step is the scene over
// CHANGED_PROBES (a guess: fine enough to see a 0.3 s change in a 14 s scene), never under 0.1 s.
export const CHANGED_PROBES = 60;
export function probeTimes(duration) {
  const last = Math.max(0, duration - Math.min(0.05, duration / 100));
  const step = Math.max(0.1, last / CHANGED_PROBES);
  return { times: evenTimes(0, last, Math.max(2, Math.ceil(last / step) + 1)), step, last };
}
export function spansOfFlags(times, flags, step, last) {
  const spans = [];
  let from = null;
  const close = (index) => { spans.push({ from: sec(times[from]), to: sec(Math.min(last, times[index] + step)) }); from = null; };
  flags.forEach((flag, index) => {
    if (flag && from == null) from = index;
    if (!flag && from != null) close(index - 1);
  });
  if (from != null) close(flags.length - 1);
  return spans;
}

// Which frames to draw for changed spans: at most `limit`. Every span gets one frame at its
// middle (the earliest `limit` spans when there are more), the rest go one at a time to the span
// with the most seconds per frame, never more than one frame per 0.1 s of a span. Spans that
// the limit cuts come back as `left`.
export function spanPicks(spans, limit) {
  const shown = spans.slice(0, limit);
  const counts = shown.map(() => 1);
  for (let spare = limit - shown.length; spare > 0; spare -= 1) {
    let best = -1;
    shown.forEach((span, index) => {
      if (counts[index] >= Math.max(1, Math.floor((span.to - span.from) / 0.1 + 1e-6))) return;
      if (best < 0 || (span.to - span.from) / counts[index] > (shown[best].to - shown[best].from) / counts[best]) best = index;
    });
    if (best < 0) break;
    counts[best] += 1;
  }
  const picks = [];
  shown.forEach((span, index) => {
    for (let n = 0; n < counts[index]; n += 1) picks.push({ ...span, time: sec(span.from + ((n + 0.5) * (span.to - span.from)) / counts[index]) });
  });
  return { picks, left: spans.slice(limit) };
}

async function decode(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
}

// Number of pixels whose color moved past the threshold. Different sizes count as all changed.
export async function changedPixels(first, second) {
  if (first.equals(second)) return 0;
  const [a, b] = await Promise.all([decode(first), decode(second)]);
  if (a.width !== b.width || a.height !== b.height) return a.width * a.height;
  let count = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    if (Math.abs(a.data[index] - b.data[index]) > PIXEL_THRESHOLD || Math.abs(a.data[index + 1] - b.data[index + 1]) > PIXEL_THRESHOLD ||
        Math.abs(a.data[index + 2] - b.data[index + 2]) > PIXEL_THRESHOLD || Math.abs(a.data[index + 3] - b.data[index + 3]) > PIXEL_THRESHOLD)
      count += 1;
  }
  return count;
}

// A word on a colored strip just above (x, y), or just below it when there is no room, kept
// inside `area` ({x, y, width, height}).
function drawTag(context, area, word, x, y, background) {
  context.font = "10px kino-label, sans-serif";
  const tagWidth = Math.ceil(context.measureText(word).width) + 8;
  const tagX = Math.min(Math.max(area.x, x), area.x + area.width - tagWidth);
  const tagY = Math.min(y - 14 >= area.y ? y - 14 : y, area.y + area.height - 14);
  context.fillStyle = background;
  context.fillRect(tagX, tagY, tagWidth, 14);
  context.fillStyle = "#000000";
  context.fillText(word, tagX + 4, tagY + 7);
}

// The marks on a source frame drawn in `panel` ({x, y, width, height}): the crop (`quad`, the
// scene's corners in % of the source) as white dashes over a dark line, the subject `boxes`
// ([{by, box}] in %) in their tag color, and `eyes` ({y, from, to} in %), the eye line, dashed.
// Each is tagged with a word (crop, the box's source, eyes), so no meaning is in color alone.
// look source and look board share it.
function drawMarks(context, panel, { quad, boxes = [], eyes = null }) {
  const at = ([x, y]) => [panel.x + (x / 100) * panel.width, panel.y + (y / 100) * panel.height];
  context.save();
  context.beginPath();
  context.rect(panel.x, panel.y, panel.width, panel.height);
  context.clip();
  // The crop: white dashes over a dark line, so it shows on light and dark footage.
  if (quad) {
    const corners = quad.map(at);
    const path = () => {
      context.beginPath();
      corners.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
      context.closePath();
    };
    path();
    context.setLineDash([]);
    context.lineWidth = 4;
    context.strokeStyle = "rgba(0,0,0,0.6)";
    context.stroke();
    path();
    context.setLineDash([8, 6]);
    context.lineWidth = 2;
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.setLineDash([]);
  }
  for (const entry of boxes) {
    const [x, y] = at([entry.box[0], entry.box[1]]);
    const [x1, y1] = at([entry.box[0] + entry.box[2], entry.box[1] + entry.box[3]]);
    context.lineWidth = 2;
    context.strokeStyle = BOX_COLOURS[entry.by] ?? "#ffffff";
    context.strokeRect(x + 1, y + 1, x1 - x - 2, y1 - y - 2);
  }
  if (eyes) {
    const [x0, y] = at([eyes.from, eyes.y]);
    const [x1] = at([eyes.to, eyes.y]);
    context.beginPath();
    context.moveTo(x0, Math.round(y) + 0.5);
    context.lineTo(x1, Math.round(y) + 0.5);
    context.setLineDash([4, 3]);
    context.lineWidth = 1;
    context.strokeStyle = BOX_COLOURS.agent;
    context.stroke();
    context.setLineDash([]);
  }
  context.restore();
  // Tags last, so a box never covers another's word. The crop's tag is inside its bottom-left
  // corner, away from the box tags (on the boxes' tops); the eye line's at its right end.
  if (quad) {
    const xs = quad.map(([x]) => x), ys = quad.map(([, y]) => y);
    const [x, y] = at([Math.max(0, Math.min(...xs)), Math.min(100, Math.max(...ys))]);
    drawTag(context, panel, "crop", x + 3, y - 3, "#ffffff");
  }
  for (const entry of boxes) {
    const [x, y] = at([entry.box[0], entry.box[1]]);
    drawTag(context, panel, entry.by, x, y, BOX_COLOURS[entry.by] ?? "#ffffff");
  }
  if (eyes) {
    context.font = "10px kino-label, sans-serif";
    const [x1, y] = at([eyes.to, eyes.y]);
    drawTag(context, panel, "eyes", x1 - Math.ceil(context.measureText("eyes").width) - 8, y, BOX_COLOURS.agent);
  }
}

// `text` broken at spaces into lines at most `width` px wide (in the context's font), at most
// `most` of them; a cut last line ends with "…".
function wrapText(context, text, width, most) {
  const lines = [];
  let line = "";
  const words = String(text).split(" ");
  for (const [index, word] of words.entries()) {
    const next = line ? `${line} ${word}` : word;
    if (!line || context.measureText(next).width <= width) { line = next; continue; }
    lines.push(line);
    line = word;
    if (lines.length === most) {
      // No room for the rest: the last line ends with an ellipsis.
      let last = lines.pop();
      const rest = `${last} ${words.slice(index).join(" ")}`;
      last = rest;
      while (last.length > 1 && context.measureText(`${last}…`).width > width) last = last.slice(0, -1);
      lines.push(`${last.trimEnd()}…`);
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The renderer behind every look. `cache` is a createFrameCache; `outDirectory` is where the
 * finished images are written so the agent (and you) can open them by path.
 */
// `renderSettings` (optional) answers the dashboard's machine settings now ({ graphics, … }): the
// card that draws a frame, which is also part of the frame's cache key (it can change pixels).
// The most stills one render draws (renderStills takes 1 to 600).
const STILLS_MOST = 600;

// The times and labels of seam rows: SEAM_OFFSETS frames across each cut ([{n, time}]).
function seamTimes(prepared, cuts) {
  const times = [], labels = [];
  for (const cut of cuts) for (const offset of SEAM_OFFSETS) {
    times.push(sec(Math.max(0, Math.min(prepared.scene.duration, cut.time + offset))));
    labels.push(offset ? `${cut.n} ${offset > 0 ? "+" : ""}${offset}s` : `${cut.n} cut ${cut.time}s`);
  }
  return { times, labels };
}

// The part of a layer that is on screen at `time` (after its own and its groups' move, scale and
// rotation), 24 px of margin around it, clipped to the scene: { left, top, right, bottom } (empty
// when right - left < 1), `at` (the layer's state then) and the corner points `xs`, `ys` before
// clipping. A text layer's part is its box and its letters, which can be drawn past the box (the
// quality model measures text by its letters too). look zoom and look frames with a layer use it.
export function layerBounds(prepared, layer, time) {
  const scene = prepared.scene;
  const evaluate = (item) => evaluateLayer(item, time);
  let at = evaluate(layer);
  let matrix = worldMatrix(layer, scene.layers, evaluate);
  let local = { x0: 0, y0: 0, x1: at.width ?? 0, y1: at.height ?? 0 };
  if (layer.type === "text") {
    try {
      // As the quality model and the renderer lay it out: the text shown then, resized.
      let state = evaluateLayer(layer, time, { unitIndex: 0, unitCount: 1, fonts: prepared.fonts });
      if (hasTextChanges(layer)) state = { ...state, text: shownTextAt(layer, time, prepared.fonts) };
      state = resizeTextLayer(state, prepared.fonts);
      const ink = inkBox(state, prepared.fonts);
      at = state;
      matrix = multiply(parentMatrix(layer, scene.layers, evaluate), layerMatrix(state));
      local = { x0: 0, y0: 0, x1: state.width ?? 0, y1: state.height ?? 0 };
      if (ink) local = { x0: Math.min(local.x0, ink.x0), y0: Math.min(local.y0, ink.y0), x1: Math.max(local.x1, ink.x1), y1: Math.max(local.y1, ink.y1) };
    } catch { /* the layer's box */ }
  }
  const corners = [[local.x0, local.y0], [local.x1, local.y0], [local.x0, local.y1], [local.x1, local.y1]].map(([x, y]) => point(matrix, x, y));
  const pad = 24;
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const box = { left: Math.min(...xs) - pad, top: Math.min(...ys) - pad, right: Math.max(...xs) + pad, bottom: Math.max(...ys) + pad };
  return { at, xs, ys, left: Math.max(0, box.left), top: Math.max(0, box.top), right: Math.min(scene.width, box.right), bottom: Math.min(scene.height, box.bottom) };
}

export function createLook({ cache, outDirectory, mediaRoot, renderSettings }) {
  // One frame at `width` pixels wide, from cache when possible. Returns { key, png }.
  // `height` too lets a frame be drawn larger than the scene (zoom draws small layers at 2×);
  // with only a width, export keeps the scene's own height as the limit.
  async function frameKey(prepared, time, width, height, render) {
    // The project's shutter (update_project {shutterAngle}) draws the real motion blur, bounded to
    // LOOK_MOTION_SAMPLES moments; without it look keeps the cheap smear (previewBlur.js).
    const shutter = sceneShutterOptions(prepared.scene);
    const options = { format: "png", time: Math.min(time, prepared.scene.duration), width, ...(height ? { height } : {}),
      ...(shutter.shutterAngle ? { ...shutter, fps: shutterFps(prepared.scene) } : {}) };
    const contentKey = await renderContentKey(prepared.scene, options, {
      fonts: prepared.fonts,
      mediaRoot,
      scope: prepared.scene.id,
      graphics: graphicsCacheInput(render.graphics),
    });
    return { options, key: hash(`${RENDERER_VERSION}\n${prepared.key}\n${contentKey}\npreview-blur`).slice(0, 40) };
  }

  // `signal` stops the drawing (the dashboard's stage no longer wants the frame).
  async function frame(prepared, time, width, height, { signal } = {}) {
    const render = renderSettings?.() ?? {};
    const { options, key } = await frameKey(prepared, time, width, height, render);
    const cached = await cache.get(key);
    if (cached) return { key, png: cached, cached: true };
    // Look shows the motion blur a final render has (previewBlur.js), drawn cheaply.
    const output = await exportScene(prepared.scene, options, { mediaRoot, fonts: prepared.fonts, render, previewBlur: true, signal });
    await cache.set(key, output.buffer);
    return { key, png: output.buffer, cached: false };
  }

  // The frames at several times of one scene, as frame() draws them, in order. The ones not in
  // the cache are drawn together (renderStills): one FFmpeg run per video stretch and one
  // Chromium for all of them, instead of one export each.
  // `height` (optional) draws the frames larger than the scene, as zoom does (a layer's crop).
  async function frames(prepared, times, width, height) {
    const render = renderSettings?.() ?? {};
    const found = [];
    const missing = new Map();
    for (const time of times) {
      const { options, key } = await frameKey(prepared, time, width, height, render);
      const png = missing.has(key) ? null : await cache.get(key);
      found.push({ key, png, cached: Boolean(png), time: options.time });
      if (!png && !missing.has(key)) missing.set(key, options.time);
    }
    if (missing.size === 1) {
      const [[key, time]] = missing;
      const drawn = await frame(prepared, time, width, height);
      for (const entry of found) if (entry.key === key) entry.png = drawn.png;
    } else if (missing.size) {
      const stills = await renderStills(prepared.scene, [...missing.values()], { width, ...(height ? { height } : {}), mediaRoot, fonts: prepared.fonts, render, previewBlur: true, shutter: sceneShutterOptions(prepared.scene) });
      const keys = [...missing.keys()];
      for (const [index, still] of stills.entries()) {
        await cache.set(keys[index], still.buffer);
        for (const entry of found) if (entry.key === keys[index]) entry.png = still.buffer;
      }
    }
    return found.map(({ key, png, cached }) => ({ key, png, cached }));
  }

  async function save(projectId, mode, buffer) {
    const directory = path.join(outDirectory, encodeURIComponent(projectId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${mode}-${hash(buffer).slice(0, 12)}.png`);
    await writeFile(file, buffer, { mode: 0o600 });
    return file;
  }

  // Lays tiles out in a grid with a number and time drawn on each.
  // `labelMost` caps the label's size in px (times pages: timesLabel).
  async function sheet(tiles, { columns, tile, labelMost = Infinity }) {
    ensureLabelFont();
    const gap = 4;
    const rows = Math.ceil(tiles.length / columns);
    const canvas = createCanvas(columns * tile.width + (columns - 1) * gap, rows * tile.height + (rows - 1) * gap);
    const context = canvas.getContext("2d");
    context.fillStyle = "#101114";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const labelSize = Math.max(10, Math.min(labelMost, Math.round(Math.min(tile.width, tile.height) / 11)));
    context.font = `${labelSize}px kino-label, sans-serif`;
    for (const [index, entry] of tiles.entries()) {
      const x = (index % columns) * (tile.width + gap);
      const y = Math.floor(index / columns) * (tile.height + gap);
      const image = await loadImage(entry.png);
      // `crop` ({x, y, width, height} in scene px) shows only that part of the frame (one layer).
      if (entry.crop) {
        const k = image.width / entry.crop.sceneWidth;
        context.drawImage(image, entry.crop.x * k, entry.crop.y * k, entry.crop.width * k, entry.crop.height * k, x, y, tile.width, tile.height);
      } else context.drawImage(image, x, y, tile.width, tile.height);
      const label = entry.label;
      const width = context.measureText(label).width + labelSize * 0.8;
      context.fillStyle = "rgba(0,0,0,0.72)";
      context.fillRect(x, y + tile.height - labelSize * 1.5, width, labelSize * 1.5);
      context.fillStyle = "#ffffff";
      context.fillText(label, x + labelSize * 0.4, y + tile.height - labelSize * 0.45);
    }
    return canvas.toBuffer("image/png");
  }

  // As many columns as fit (4 landscape, 6 portrait), spread so the rows are evenly filled.
  const columnsFor = (count, tile) => {
    const most = tile.height > tile.width ? 6 : 4;
    return Math.ceil(count / Math.ceil(count / most));
  };

  return {
    frame,
    frames,
    save,

    async frameImage(prepared, { time, width }) {
      const rendered = await frame(prepared, time, width);
      return { png: rendered.png, frames: [{ time, key: rendered.key, width }] };
    },

    async sheetImage(prepared, { times, longEdge = TILE_LONG_EDGE, labels, columns }) {
      const tile = tileSize(prepared.scene, longEdge);
      const drawn = await frames(prepared, times, tile.width);
      const tiles = times.map((time, index) => ({ ...drawn[index], time, label: labels?.[index] ?? `${index + 1} · ${time}s` }));
      const png = await sheet(tiles, { columns: columns ?? columnsFor(tiles.length, tile), tile });
      return { png, frames: tiles.map(({ time, key }) => ({ time, key, width: tile.width })), tile };
    },

    // look frames with `times` (or every:<n>): the frames at those times as pages of labeled tiles
    // (timesPlan says how many fit a page and how many pages one call draws). `width` is the
    // tile's width in px, else `longEdge` its long edge (default timesEdge); a `crop` ({x, y, width, height,
    // sceneWidth}: layerCrop) shows only that part of each frame, in tiles of its shape. Returns
    // { pages: [{png, frames}], tile, plan }; plan.shown of the times were drawn, in order.
    async timesImages(prepared, times, { longEdge, width, crop = null, labels } = {}) {
      const scene = prepared.scene;
      const edge = width || longEdge ? longEdge : timesEdge(times.length, scene, crop);
      const { tile, scale } = timesTile(scene, crop, { longEdge: edge, width });
      const plan = timesPlan(times.length, tile);
      const chosen = times.slice(0, plan.shown);
      const renderWidth = Math.max(2, Math.round(scene.width * scale));
      const renderHeight = crop ? Math.max(2, Math.round(scene.height * scale)) : undefined;
      const labelMost = timesLabel(scale, Boolean(crop));
      const drawn = await frames(prepared, chosen, renderWidth, renderHeight);
      const tiles = chosen.map((time, index) => ({ ...drawn[index], time, label: labels?.[index] ?? `${time}s`, ...(crop ? { crop } : {}) }));
      const pages = [];
      for (let first = 0; first < tiles.length; first += plan.perPage) {
        const chunk = tiles.slice(first, first + plan.perPage);
        const png = await sheet(chunk, { columns: Math.min(plan.columns, chunk.length), tile, labelMost });
        // A cropped frame keeps its crop, so look changed redraws the same part (changedImage).
        pages.push({ png, frames: chunk.map(({ time, key, label }) => ({ time, key, width: renderWidth, label, ...(crop ? { height: renderHeight, crop, tile, labelMost } : {}) })) });
      }
      return { pages, tile, plan };
    },

    // The part of `layer` on screen at any of `times` (layerBounds, joined), as the crop
    // timesImages takes; throws when the layer is off screen at all of them.
    layerCrop(prepared, layer, times) {
      let box = null;
      for (const time of times) {
        const bounds = layerBounds(prepared, layer, time);
        if (!(bounds.right - bounds.left >= 1 && bounds.bottom - bounds.top >= 1)) continue;
        box = box ? { left: Math.min(box.left, bounds.left), top: Math.min(box.top, bounds.top), right: Math.max(box.right, bounds.right), bottom: Math.max(box.bottom, bounds.bottom) } : bounds;
      }
      if (!box) throw new Error(`Layer ${layer.id} is outside the scene at every one of those times, so there is nothing to crop to. Look at the frames without layer.`);
      const x = Math.floor(box.left), y = Math.floor(box.top);
      return { x, y, width: Math.max(1, Math.ceil(box.right) - x), height: Math.max(1, Math.ceil(box.bottom) - y), sceneWidth: prepared.scene.width };
    },

    // sheetImage's grid for stills already drawn ([{png, label}], all `tile` big): a found
    // video's saved shot sheet (footage-finder/sheet.mjs) gets the same labels as a scene's sheet.
    async tilesImage(tiles, { tile, columns }) {
      return { png: await sheet(tiles, { columns: columns ?? columnsFor(tiles.length, tile), tile }), tile };
    },

    // look source with no layer: one page of clips-sheet.mjs layoutClips. `blocks[place.index]`
    // is { header, tiles: [{png, label}] }: the header above, the tiles in a row under it.
    async clipsImage(page, blocks) {
      ensureLabelFont();
      const canvas = createCanvas(page.width, Math.max(2, page.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#101114";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.textBaseline = "alphabetic";
      for (const place of page.places) {
        const block = blocks[place.index];
        context.font = "13px kino-label, sans-serif";
        let header = block.header;
        while (header.length > 4 && context.measureText(header).width > place.width) header = `${header.slice(0, -2)}…`;
        context.fillStyle = "#ffffff";
        context.fillText(header, place.x, place.y + 15);
        context.font = "11px kino-label, sans-serif";
        for (const [index, entry] of block.tiles.entries()) {
          const x = place.x + index * (place.tile.width + CLIPS_GAP);
          const y = place.y + CLIPS_HEADER;
          context.drawImage(await loadImage(entry.png), x, y, place.tile.width, place.tile.height);
          const width = context.measureText(entry.label).width + 8;
          context.fillStyle = "rgba(0,0,0,0.72)";
          context.fillRect(x, y + place.tile.height - 16, width, 16);
          context.fillStyle = "#ffffff";
          context.fillText(entry.label, x + 4, y + place.tile.height - 4);
        }
      }
      return canvas.toBuffer("image/png");
    },

    // Draws the frames of several sheets (or seam rows: `seams` true, `times` the cuts) in one
    // render, so each video is decoded once for all of them (one FFmpeg run per stretch, not one
    // per sheet, each from the keyframe before it) and the sheets read them from the cache.
    async drawAhead(prepared, times, { longEdge = TILE_LONG_EDGE, seams = false } = {}) {
      const all = seams ? seamTimes(prepared, times).times : times;
      const unique = [...new Set(all)];
      const width = tileSize(prepared.scene, seams ? SEAM_EDGE : longEdge).width;
      for (let index = 0; index < unique.length; index += STILLS_MOST) await frames(prepared, unique.slice(index, index + STILLS_MOST), width);
    },

    // look review's seams: one row of SEAM_OFFSETS frames across each cut ([{n, time}]), so a
    // pop, a flash or a jump across the cut shows side by side.
    async seamImage(prepared, cuts) {
      const { times, labels } = seamTimes(prepared, cuts);
      const tile = tileSize(prepared.scene, SEAM_EDGE);
      const drawn = await frames(prepared, times, tile.width);
      const png = await sheet(times.map((time, index) => ({ ...drawn[index], time, label: labels[index] })), { columns: SEAM_OFFSETS.length, tile });
      return { png, tile };
    },

    // One tile per entry, each from its own scene: { prepared, time, label }. Tiles take the
    // size of the first scene.
    // `columns` sets the grid (look variants: one row per variant).
    async scenesImage(entries, { longEdge = TILE_LONG_EDGE, columns } = {}) {
      const tile = tileSize(entries[0].prepared.scene, longEdge);
      const tiles = [];
      for (const entry of entries) {
        const rendered = await frame(entry.prepared, entry.time, tile.width);
        tiles.push({ ...rendered, time: entry.time, label: entry.label });
      }
      const png = await sheet(tiles, { columns: columns ?? columnsFor(tiles.length, tile), tile });
      return { png, frames: tiles.map(({ time, key }) => ({ time, key, width: tile.width })), tile };
    },

    // A crop around a layer at one time: the part of the layer that is on screen (after its own
    // and its groups' move, scale and rotation), clipped to the scene. A text layer's part is its
    // box and its letters, which can be drawn past the box (the quality model measures text by
    // its letters too). The crop is drawn `size` px on its long edge, at most 2× (a small layer)
    // and never in less detail than look frame's default width (`frameWidth` px across the
    // scene); the image is at most `maxEdge` px on its long side.
    async zoomImage(prepared, { layer, time, size = ZOOM_EDGE, frameWidth = 480, maxEdge = 1280 }) {
      const scene = prepared.scene;
      const { at, xs, ys, left, top, right, bottom } = layerBounds(prepared, layer, time);
      if (!(right - left >= 1 && bottom - top >= 1)) throw new Error(`Layer ${layer.id} is outside the scene at ${time}s, so there is nothing to zoom into. Look at a frame instead.`);
      const longEdge = Math.max(right - left, bottom - top);
      const detail = Math.max(size / longEdge, Math.min(frameWidth, scene.width) / scene.width);
      const scale = Math.min(2, detail, 4096 / Math.max(scene.width, scene.height), maxEdge / longEdge);
      const renderWidth = Math.max(2, Math.round(scene.width * scale));
      const rendered = await frame(prepared, time, renderWidth, Math.max(2, Math.round(scene.height * scale)));
      const image = await loadImage(rendered.png);
      const realScale = image.width / scene.width;
      const x = Math.max(0, Math.floor(left * realScale));
      const y = Math.max(0, Math.floor(top * realScale));
      const width = Math.max(1, Math.min(image.width, Math.ceil(right * realScale)) - x);
      const height = Math.max(1, Math.min(image.height, Math.ceil(bottom * realScale)) - y);
      const canvas = createCanvas(width, height);
      canvas.getContext("2d").drawImage(image, x, y, width, height, 0, 0, width, height);
      return { png: canvas.toBuffer("image/png"), frames: [{ time, key: rendered.key, width: renderWidth }],
        crop: { x: Math.round(x / realScale), y: Math.round(y / realScale), width: Math.round(width / realScale), height: Math.round(height / realScale), scale: Number(realScale.toFixed(2)) },
        layerSize: { width: Math.round(Math.abs((at.width ?? 0) * (at.scaleX ?? 1))), height: Math.round(Math.abs((at.height ?? 0) * (at.scaleY ?? 1))) },
        // Whether part of the layer itself (not the margin around it) is off screen, so the crop
        // shows only some of it.
        clipped: Math.min(...xs) < -0.5 || Math.min(...ys) < -0.5 || Math.max(...xs) > scene.width + 0.5 || Math.max(...ys) > scene.height + 0.5 };
    },

    // look versus: one row a pair, the edit's frame (left) beside a reference still (right), both
    // filling the edit's tile (the still cropped from the middle). Portrait tiles go two pairs a
    // row. rows: [{prepared, time, still (a file), editLabel, refLabel}].
    async versusImage(rows, { longEdge = VERSUS_EDGE } = {}) {
      const tile = tileSize(rows[0].prepared.scene, longEdge);
      const tiles = [];
      for (const row of rows) {
        const rendered = await frame(row.prepared, row.time, tile.width);
        tiles.push({ ...rendered, label: row.editLabel });
        // A shot with no fair match gets an empty tile, not an unrelated frame.
        tiles.push({ png: row.still ? await coverImage(row.still, tile, "image/png") : createCanvas(tile.width, tile.height).toBuffer("image/png"), label: row.refLabel });
      }
      const png = await sheet(tiles, { columns: tile.height > tile.width ? 4 : 2, tile });
      return { png, tile };
    },

    // The frames at `times` in two versions; returns only the times whose pixels differ, as
    // before/after pairs.
    async compareImage(before, after, { times, longEdge = TILE_LONG_EDGE, beforeLabel, afterLabel }) {
      const tile = tileSize(after.scene, longEdge);
      const tiles = [];
      const differing = [];
      for (const time of times) {
        const [old, current] = await Promise.all([frame(before, time, tile.width), frame(after, time, tile.width)]);
        if (old.key === current.key || (await changedPixels(old.png, current.png)) < CHANGED_PIXELS) continue;
        differing.push(time);
        tiles.push({ ...old, label: `${beforeLabel} · ${time}s` }, { ...current, label: `${afterLabel} · ${time}s` });
        if (differing.length === 6) break;
      }
      if (!tiles.length) return { png: null, differing };
      return { png: await sheet(tiles, { columns: 2, tile }), differing, tile };
    },

    // look source: the whole source frame of a video (`source`, a prepared one-layer scene the
    // file's size, drawn at time 0) `panel.width` × `panel.height` px, with a labeled 10% grid,
    // the crop (`quad`: the scene's corners on the source, in %) as a dashed box and the subject
    // `boxes` ([{by, box}] in %), and beside it the result: `result` (the layer's own scene) at
    // `time`, as tall as the panel. `vision({rgba, width, height})`, when given, finds more boxes
    // on the source frame's pixels; its answer comes back as `vision`.
    async sourceImage(source, result, { time, panel, header, quad, boxes = [], caption, vision }) {
      ensureLabelFont();
      const drawn = await frame(source, 0, panel.width, panel.height);
      const sourcePicture = await loadImage(drawn.png);
      let found = null;
      if (vision) {
        const pixels = await decode(drawn.png);
        found = await vision({ rgba: pixels.data, width: pixels.width, height: pixels.height });
      }
      const allBoxes = [...boxes, ...(found?.boxes ?? [])];
      const resultWidth = Math.max(2, Math.round((result.scene.width * panel.height) / result.scene.height));
      const shown = await frame(result, time, resultWidth, panel.height);
      const resultPicture = await loadImage(shown.png);

      const pad = 8, headerHeight = 20, left = 26, top = 16, gap = 12;
      const measure = createCanvas(1, 1).getContext("2d");
      measure.font = "12px kino-label, sans-serif";
      const captionWidth = measure.measureText(caption).width;
      const headerWidth = measure.measureText(header).width;
      const panelX = pad + left, panelY = pad + headerHeight + top;
      const resultX = panelX + panel.width + gap;
      const width = Math.ceil(Math.max(resultX + Math.max(resultPicture.width, captionWidth), pad + headerWidth) + pad);
      const height = panelY + panel.height + pad;
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#101114";
      context.fillRect(0, 0, width, height);

      context.font = "12px kino-label, sans-serif";
      context.fillStyle = "#ffffff";
      context.textBaseline = "middle";
      context.fillText(header, pad, pad + headerHeight / 2 - 2);

      context.drawImage(sourcePicture, panelX, panelY, panel.width, panel.height);
      // The grid every 10%, labeled along the top and the left.
      context.font = "10px kino-label, sans-serif";
      context.lineWidth = 1;
      context.strokeStyle = "rgba(255,255,255,0.28)";
      context.fillStyle = "rgba(255,255,255,0.75)";
      for (let tenth = 0; tenth <= 10; tenth += 1) {
        const x = Math.round(panelX + (panel.width * tenth) / 10) - (tenth === 10 ? 1 : 0) + 0.5;
        const y = Math.round(panelY + (panel.height * tenth) / 10) - (tenth === 10 ? 1 : 0) + 0.5;
        context.beginPath();
        context.moveTo(x, panelY);
        context.lineTo(x, panelY + panel.height);
        context.moveTo(panelX, y);
        context.lineTo(panelX + panel.width, y);
        context.stroke();
        const label = String(tenth * 10);
        context.textAlign = "center";
        context.fillText(label, Math.min(x, panelX + panel.width - context.measureText(label).width / 2), panelY - top / 2);
        context.textAlign = "right";
        context.fillText(label, panelX - 4, y);
      }
      context.textAlign = "left";

      drawMarks(context, { x: panelX, y: panelY, width: panel.width, height: panel.height }, { quad, boxes: allBoxes });

      context.font = "12px kino-label, sans-serif";
      context.fillStyle = "#ffffff";
      context.fillText(caption, resultX, panelY - top / 2);
      context.drawImage(resultPicture, resultX, panelY, resultPicture.width, resultPicture.height);
      return { png: canvas.toBuffer("image/png"), frames: [{ time: 0, key: drawn.key, width: panel.width }, { time, key: shown.key, width: resultWidth }], vision: found };
    },

    // look board: one row per shot ({header, source, note, quad, boxes, eyes, still, covered,
    // lines}). `source` is the prepared source frame (a scene the file's size, drawn at time 0),
    // marked as look source marks it but without the grid, or null with `note` in its place ("no
    // footage"); `still` the prepared still (a scene the video's size), with `covered` ({right,
    // bottom}, shares of its width and height) shaded where the phone app draws over it; `lines`
    // ([{text, ink, most}]) the words, each wrapped to at most `most` lines (1 by default).
    async boardImage(rows) {
      ensureLabelFont();
      const pad = 8, headerHeight = 18, gap = 12, lineHeight = 16;
      const sourceX = pad, stillX = sourceX + BOARD_SOURCE.width + gap, textX = stillX + BOARD_STILL.width + gap;
      const textWidth = BOARD_WIDTH - pad - textX;
      const canvas = createCanvas(BOARD_WIDTH, rows.length * BOARD_ROW);
      const context = canvas.getContext("2d");
      context.fillStyle = "#101114";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const frames = [];
      for (const [index, row] of rows.entries()) {
        const top = index * BOARD_ROW;
        if (index) {
          context.fillStyle = "#2a2d33";
          context.fillRect(0, top, BOARD_WIDTH, 1);
        }
        const panelY = top + 1 + pad + headerHeight;
        context.font = "12px kino-label, sans-serif";
        context.fillStyle = "#ffffff";
        context.textBaseline = "middle";
        context.textAlign = "left";
        context.fillText(row.header, pad, top + 1 + pad + headerHeight / 2 - 2);

        // The source frame, as large as fits its box, with the crop, the boxes and the eye line.
        if (row.source) {
          const fit = Math.min(BOARD_SOURCE.width / row.source.scene.width, BOARD_SOURCE.height / row.source.scene.height);
          const panel = { x: sourceX, y: panelY, width: Math.max(2, Math.round(row.source.scene.width * fit)), height: Math.max(2, Math.round(row.source.scene.height * fit)) };
          const drawn = await frame(row.source, 0, panel.width, panel.height);
          context.drawImage(await loadImage(drawn.png), panel.x, panel.y, panel.width, panel.height);
          drawMarks(context, panel, { quad: row.quad, boxes: row.boxes, eyes: row.eyes });
          frames.push({ time: 0, key: drawn.key, width: panel.width });
        } else {
          context.strokeStyle = "#2a2d33";
          context.lineWidth = 1;
          context.strokeRect(sourceX + 0.5, panelY + 0.5, BOARD_SOURCE.width - 1, BOARD_SOURCE.height - 1);
          context.font = "12px kino-label, sans-serif";
          context.fillStyle = "#b8bcc4";
          context.textAlign = "center";
          context.fillText(row.note ?? "no footage", sourceX + BOARD_SOURCE.width / 2, panelY + BOARD_SOURCE.height / 2);
          context.textAlign = "left";
        }

        // The still: the video's frame as the shot will show it, with the real font and text.
        const scene = row.still.scene;
        const fit = Math.min(BOARD_STILL.width / scene.width, BOARD_STILL.height / scene.height);
        const still = { x: stillX + Math.floor((BOARD_STILL.width - Math.round(scene.width * fit)) / 2), y: panelY, width: Math.max(2, Math.round(scene.width * fit)), height: Math.max(2, Math.round(scene.height * fit)) };
        const shown = await frame(row.still, 0, still.width, still.height);
        context.drawImage(await loadImage(shown.png), still.x, still.y, still.width, still.height);
        frames.push({ time: 0, key: shown.key, width: still.width });
        if (row.covered) {
          // One L-shaped area (the right strip and the bottom band), so where they meet is not
          // darkened twice; dashed and tagged "app".
          const right = still.x + still.width, bottom = still.y + still.height;
          const left = right - Math.round(still.width * row.covered.right);
          const band = bottom - Math.round(still.height * row.covered.bottom);
          context.beginPath();
          context.moveTo(left, still.y);
          context.lineTo(right, still.y);
          context.lineTo(right, bottom);
          context.lineTo(still.x, bottom);
          context.lineTo(still.x, band);
          context.lineTo(left, band);
          context.closePath();
          context.fillStyle = "rgba(0,0,0,0.45)";
          context.fill();
          context.setLineDash([4, 3]);
          context.lineWidth = 1;
          context.strokeStyle = "rgba(255,255,255,0.7)";
          context.stroke();
          context.setLineDash([]);
          drawTag(context, still, "app", still.x + 2, band + 16, "#ffffff");
        }

        // The words, wrapped to the column; the last line that fits says how many were left out.
        context.font = "12px kino-label, sans-serif";
        const most = Math.floor(BOARD_SOURCE.height / lineHeight);
        const wrapped = [];
        for (const line of row.lines) for (const text of wrapText(context, line.text, textWidth, line.most ?? 1)) wrapped.push({ text, ink: line.ink });
        if (wrapped.length > most) wrapped.splice(most - 1, wrapped.length, { text: `… ${wrapped.length - most + 1} more lines in the look's text`, ink: BOARD_INK.why });
        for (const [place, line] of wrapped.entries()) {
          context.fillStyle = BOARD_INK[line.ink] ?? BOARD_INK.line;
          context.fillText(line.text, textX, panelY + place * lineHeight + lineHeight / 2);
        }
      }
      return { png: canvas.toBuffer("image/png"), frames };
    },

    // look review: one moment's frame, `longEdge` px on its long side, and a tiny grey
    // thumbnail (REVIEW_THUMB) that tells two nearly identical frames apart cheaply.
    async reviewFrame(prepared, time, longEdge = REVIEW_EDGE) {
      const tile = tileSize(prepared.scene, Math.min(longEdge, Math.max(prepared.scene.width, prepared.scene.height)));
      const rendered = await frame(prepared, time, tile.width, tile.height);
      const thumbCanvas = createCanvas(REVIEW_THUMB.width, REVIEW_THUMB.height);
      const thumbContext = thumbCanvas.getContext("2d");
      thumbContext.drawImage(await loadImage(rendered.png), 0, 0, REVIEW_THUMB.width, REVIEW_THUMB.height);
      const rgba = thumbContext.getImageData(0, 0, REVIEW_THUMB.width, REVIEW_THUMB.height).data;
      const thumb = new Uint8Array(REVIEW_THUMB.width * REVIEW_THUMB.height);
      for (let index = 0; index < thumb.length; index += 1) thumb[index] = Math.round(0.299 * rgba[index * 4] + 0.587 * rgba[index * 4 + 1] + 0.114 * rgba[index * 4 + 2]);
      return { png: rendered.png, key: rendered.key, thumb, width: tile.width, height: tile.height, digest: hash(rendered.png).slice(0, 24) };
    },

    // look review: `entries` ([{time, label, notes, png?}]) as pages of frames `longEdge` px on
    // their long side (1280: the picture's real detail; smaller for the quiet moments), as many
    // across as fit REVIEW_PAGE_WIDTH and at most `rows` down. Under each frame a strip says its
    // number, time and what happens then (`label`), and the check findings at that time
    // (`notes`, in yellow). An entry's `png` is a frame reviewFrame already drew at that size.
    // Returns [{png, frames}], one per page.
    async reviewPages(prepared, entries, { longEdge = REVIEW_EDGE, rows: most = REVIEW_ROWS } = {}) {
      ensureLabelFont();
      const scene = prepared.scene;
      const tile = tileSize(scene, Math.min(longEdge, Math.max(scene.width, scene.height)));
      const perRow = reviewColumns(tile.width);
      const perPage = perRow * most;
      const gap = REVIEW_GAP, pad = 10, labelSize = 22, noteSize = 20, lineHeight = 28;
      const pages = [];
      for (let first = 0; first < entries.length; first += perPage) {
        const chunk = entries.slice(first, first + perPage);
        const columns = Math.min(perRow, chunk.length);
        const rows = Math.ceil(chunk.length / columns);
        const measure = createCanvas(1, 1).getContext("2d");
        // Each frame's strip: the label line and up to REVIEW_NOTE_LINES finding lines.
        const strips = chunk.map((entry) => {
          measure.font = `${labelSize}px kino-label, sans-serif`;
          const label = wrapText(measure, entry.label, tile.width - pad * 2, 2);
          measure.font = `${noteSize}px kino-label, sans-serif`;
          const notes = (entry.notes ?? []).slice(0, REVIEW_NOTE_LINES).flatMap((note) => wrapText(measure, note, tile.width - pad * 2, 1));
          return { label, notes };
        });
        const stripHeight = pad + lineHeight * Math.max(...strips.map((strip) => strip.label.length + strip.notes.length)) + pad / 2;
        const cell = { width: tile.width, height: tile.height + stripHeight };
        const canvas = createCanvas(columns * cell.width + (columns - 1) * gap + 2 * REVIEW_MARGIN, rows * cell.height + (rows - 1) * gap + 2 * REVIEW_MARGIN);
        const context = canvas.getContext("2d");
        context.fillStyle = "#101114";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.textBaseline = "middle";
        const frames = [];
        for (const [index, entry] of chunk.entries()) {
          const x = REVIEW_MARGIN + (index % columns) * (cell.width + gap);
          const y = REVIEW_MARGIN + Math.floor(index / columns) * (cell.height + gap);
          const rendered = entry.png ? { png: entry.png, key: entry.key } : await frame(prepared, entry.time, tile.width, tile.height);
          // A gray line just outside the tile: each tile is the whole frame, never a crop, and a
          // dark frame's edges still show on the dark page (a centered card reads as centered).
          context.strokeStyle = REVIEW_OUTLINE;
          context.lineWidth = 2;
          context.strokeRect(x - 1, y - 1, tile.width + 2, tile.height + 2);
          context.drawImage(await loadImage(rendered.png), x, y, tile.width, tile.height);
          frames.push({ time: entry.time, key: rendered.key, width: tile.width, label: entry.label });
          let line = 0;
          const lineY = () => y + tile.height + pad + lineHeight * line + lineHeight / 2 - 4;
          context.font = `${labelSize}px kino-label, sans-serif`;
          context.fillStyle = "#ffffff";
          for (const text of strips[index].label) { context.fillText(text, x + pad, lineY()); line += 1; }
          context.font = `${noteSize}px kino-label, sans-serif`;
          context.fillStyle = BOARD_INK.flag;
          for (const text of strips[index].notes) { context.fillText(text, x + pad, lineY()); line += 1; }
        }
        pages.push({ png: canvas.toBuffer("image/png"), frames });
      }
      return pages;
    },

    // How alike the scene's first frame (0 s) and last frame (0.05 s before its end) are, as the share
    // of pixels of two small frames (the look tile's size) that did not change past the same color
    // threshold look changed uses: 1 is the same picture. Null when a frame cannot be drawn.
    async endsLikeness(prepared) {
      const size = tileSize(prepared.scene, TILE_LONG_EDGE);
      const [first, last] = await frames(prepared, [0, Math.max(0, prepared.scene.duration - 0.05)], size.width);
      if (!first?.png || !last?.png) return null;
      const total = size.width * size.height;
      return Math.round((1 - Math.min(total, await changedPixels(first.png, last.png)) / total) * 100) / 100;
    },

    // Re-renders the frames of the last look and keeps the ones whose pixels changed.
    // `prepared` is one prepared scene, or a function giving the scene of a frame (a sheet of
    // every scene has frames from several); a frame whose scene is gone is skipped.
    // `before(entry)`, when given, gives the prepared scene of that frame's scene as the last look
    // saw it (null when it did not change or is gone): the scene is then scanned across its whole
    // length for spans that differ (probeTimes), so an edit that changed places the last look did
    // not draw still shows. When a span has none of the last look's changed frames in it, the
    // answer is frames spread over every span (spanPicks, at most the last look's frame count,
    // 12 to 36), each labeled with its span in seconds; `left` lists the spans the limit cut.
    // `sceneName(entry)` names a scene in a label when the look covers several.
    async changedImage(prepared, previous, { before, sceneName } = {}) {
      const preparedFor = typeof prepared === "function" ? prepared : async () => prepared;
      const changed = [];
      const remembered = [];
      let tile = null;
      for (const entry of previous.frames) {
        const current = await preparedFor(entry);
        if (!current) continue;
        // A layer-cropped look (look frames with layer) keeps its crop and tile shape.
        tile ??= entry.tile ?? tileSize(current.scene, TILE_LONG_EDGE);
        const rendered = await frame(current, entry.time, entry.width, entry.height);
        const old = rendered.key === entry.key ? null : await cache.get(entry.key);
        if (rendered.key === entry.key || (old && (await changedPixels(old, rendered.png)) < CHANGED_PIXELS)) { remembered.push(entry); continue; }
        const label = entry.label ?? `${entry.time}s`;
        changed.push({ ...rendered, time: entry.time, width: entry.width, label, scene: entry.scene, ...(entry.crop ? { crop: entry.crop } : {}) });
        remembered.push({ ...entry, key: rendered.key });
      }

      // The spans where the scene differs from the last look's version.
      const spans = [];
      if (before && !previous.frames.some((entry) => entry.crop)) {
        const groups = new Map();
        for (const entry of previous.frames) if (!groups.has(entry.scene ?? "")) groups.set(entry.scene ?? "", entry);
        for (const entry of groups.values()) {
          const [old, current] = await Promise.all([before(entry), preparedFor(entry)]);
          if (!old || !current) continue;
          const size = tileSize(current.scene, TILE_LONG_EDGE);
          const { times, step, last } = probeTimes(current.scene.duration);
          const [olds, news] = [await frames(old, times, size.width), await frames(current, times, size.width)];
          const flags = [];
          for (let index = 0; index < times.length; index += 1)
            flags.push(olds[index].key !== news[index].key && (await changedPixels(olds[index].png, news[index].png)) >= CHANGED_PIXELS);
          for (const span of spansOfFlags(times, flags, step, last)) spans.push({ ...span, entry, current, size });
        }
      }
      const inSpan = (item, span) => item.scene === span.entry.scene && item.time >= span.from - 1e-6 && item.time <= span.to + 1e-6;
      if (!spans.some((span) => !changed.some((item) => inSpan(item, span)))) {
        if (!changed.length) return { png: null, changed: [], labels: [], frames: remembered };
        const png = await sheet(changed, { columns: columnsFor(changed.length, tile), tile, labelMost: previous.frames[0]?.labelMost });
        return { png, changed: changed.map((entry) => entry.time), labels: changed.map((entry) => entry.label), frames: remembered };
      }

      // Frames spread over every changed span, in scene then time order.
      const order = [...new Set(previous.frames.map((entry) => entry.scene ?? ""))];
      const items = [
        ...spans,
        ...changed.filter((item) => !spans.some((span) => inSpan(item, span))).map((item) => ({ from: item.time, to: item.time, item, entry: { scene: item.scene } })),
      ].sort((a, b) => order.indexOf(a.entry.scene ?? "") - order.indexOf(b.entry.scene ?? "") || a.from - b.from);
      const limit = Math.min(FRAMES_MOST, Math.max(SHEET_FRAMES, previous.frames.filter((entry) => !entry.extra).length));
      const { picks, left } = spanPicks(items, limit);
      const tiles = [];
      const added = [];
      const byScene = new Map();
      for (const pick of picks) {
        if (pick.item) continue;
        const key = pick.entry.scene ?? "";
        if (!byScene.has(key)) byScene.set(key, []);
        byScene.get(key).push(pick);
      }
      for (const group of byScene.values()) {
        const { current, size } = group[0];
        const drawn = await frames(current, group.map((pick) => pick.time), size.width);
        group.forEach((pick, index) => {
          const name = sceneName?.(pick.entry);
          pick.drawn = drawn[index];
          pick.label = `${name ? `${name} · ` : ""}${pick.time}s in ${pick.from}-${pick.to}s`;
          pick.plain = `${name ? `${name} · ` : ""}${pick.time}s`;
          pick.width = size.width;
        });
      }
      for (const pick of picks) {
        if (pick.item) { tiles.push(pick.item); continue; }
        tiles.push({ ...pick.drawn, time: pick.time, width: pick.width, label: pick.label });
        added.push({ time: pick.time, key: pick.drawn.key, width: pick.width, label: pick.plain, extra: true, ...(pick.entry.scene !== undefined ? { scene: pick.entry.scene } : {}) });
      }
      const png = await sheet(tiles, { columns: columnsFor(tiles.length, tile), tile, labelMost: previous.frames[0]?.labelMost });
      return {
        png,
        changed: tiles.map((entry) => entry.time),
        labels: tiles.map((entry) => entry.label),
        frames: [...remembered.filter((entry) => !entry.extra), ...added],
        spans: items.map((item) => ({ from: item.from, to: item.to, scene: item.entry.scene })),
        left: left.map((item) => ({ from: item.from, to: item.to, scene: item.entry.scene })),
      };
    },

    // A stretch of a scene (`from` to `to` seconds) as a silent mp4 at the preview size and
    // frame rate, drawn as playback draws it (try rounds, tries.mjs).
    async clip(prepared, { from, to, outputPath, signal }) {
      const render = renderSettings?.() ?? {};
      const size = previewSize(prepared.scene);
      const first = Math.max(0, Math.round(from * PREVIEW_FPS));
      const count = Math.max(1, Math.round((to - from) * PREVIEW_FPS));
      await exportScene(prepared.scene, { format: "mp4", fps: PREVIEW_FPS, width: size.width, height: size.height, videoQuality: PREVIEW_QUALITY }, {
        mediaRoot, fonts: prepared.fonts, render, outputPath, silent: true, previewBlur: true, signal, frameRange: { first, count },
      });
      return { outputPath, ...size };
    },
  };
}
