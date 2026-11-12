// trace_image {layer or media, time?, region?:[x,y,w,h], colors?:4, smooth?:1, minArea?:16,
// background?:"auto", as?:"fill"|"outline", name?}: a region of a picture becomes a group of
// filled vector paths, one per flat color region, largest first, at the region's place and size in
// the scene (engine/traceImage.js traces; engine/svgImport.js makes the layers). From a layer, the
// region is in scene pixels and the picture is the layer's frame at scene time `time` (its own
// place and size, animations aside); from media (an imported "/api/media/<id>" src), the region is
// in the file's pixels and `time` is seconds into the file. GAPS item 2: directors hand-wrote one
// SVG polygon for a cel-shaded fist and set a wordmark in a stock font.
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { DOMParser } from "@xmldom/xmldom";
import { mediaFrameState } from "../../engine/playback.js";
import { importSvg, moveRootLayers } from "../../engine/svgImport.js";
import { parseDocument } from "../../engine/model.js";
import { traceImage, traceSvg } from "../../engine/traceImage.js";
import { runMediaTool } from "../media-probe.mjs";

// The traced grid's long side: twice the file's pixels (anti-aliased edges become smooth
// half-pixel steps), at most 640 (guess: the contest-b wordmark, 316 px wide in the file, kept its
// star cut and the open 6 at 632; 640 traces in well under a second).
const WORK_LONG = 640;
// Stroke width of as:"outline" paths, scene px (guess: a thin ink line on a 1080p frame).
const OUTLINE_WIDTH = 2;

const mediaId = (src) => /^\/api\/media\/([A-Za-z0-9._-]+)$/.exec(String(src ?? ""))?.[1] ?? null;

async function readPicture(file, isVideo, seconds) {
  if (!isVideo) return loadImage(file);
  const folder = await mkdtemp(path.join(tmpdir(), "kino-trace-"));
  try {
    const out = path.join(folder, "frame.png");
    await runMediaTool("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, seconds)), "-i", file, "-frames:v", "1", "-y", out], { timeoutMs: 30_000 });
    return await loadImage(out);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

function checkRegion(region, label) {
  if (region === undefined) return null;
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite) || region[2] <= 0 || region[3] <= 0)
    throw new Error(`region is [x, y, width, height] in ${label} pixels, width and height above 0.`);
  return region;
}

/** RGBA of the region at the traced size, and where the shapes go: {data, width, height, scale, place:[x,y,w,h]}. */
async function regionPixels(document, op, mediaRoot) {
  const scene = document.scenes.find((item) => item.id === op.sceneId);
  if (!scene) throw new Error("trace_image needs a scene.");
  let src, isVideo, seconds, box, place;
  if (op.layerId) {
    const layer = scene.layers.find((item) => item.id === op.layerId);
    if (!layer) throw new Error(`No layer "${op.layerId}" in this scene.`);
    if (layer.type !== "video" && layer.type !== "image") throw new Error(`trace_image reads a video or image layer, and "${layer.name}" is a ${layer.type} layer.`);
    src = layer.src; isVideo = layer.type === "video";
    const time = op.time ?? 0;
    seconds = isVideo ? (mediaFrameState(layer, time).sourceTime ?? 0) : 0;
    const want = checkRegion(op.region, "scene") ?? [layer.x, layer.y, layer.width, layer.height];
    const x0 = Math.max(want[0], layer.x), y0 = Math.max(want[1], layer.y);
    const x1 = Math.min(want[0] + want[2], layer.x + layer.width), y1 = Math.min(want[1] + want[3], layer.y + layer.height);
    if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error(`region [${want.join(", ")}] is outside "${layer.name}" (${[layer.x, layer.y, layer.width, layer.height].map(Math.round).join(", ")}).`);
    place = [x0, y0, x1 - x0, y1 - y0];
    // In the layer's own share, read off the file below.
    box = [(x0 - layer.x) / layer.width, (y0 - layer.y) / layer.height, (x1 - x0) / layer.width, (y1 - y0) / layer.height];
  } else {
    src = op.media; seconds = op.time ?? 0;
    isVideo = /\.(mp4|mov|webm|m4v|mkv)$/i.test(String(src));
  }
  const id = mediaId(src);
  const file = id && mediaRoot && !id.includes("..") ? path.join(mediaRoot, id) : null;
  if (!file || !existsSync(file)) throw new Error(`the picture ${JSON.stringify(src)} is not in kino's media library; import it with project {action:"import", file} and use its src.`);
  const image = await readPicture(file, isVideo, seconds);
  if (!box) {
    const want = checkRegion(op.region, "file") ?? [0, 0, image.width, image.height];
    const x0 = Math.max(0, want[0]), y0 = Math.max(0, want[1]);
    const x1 = Math.min(image.width, want[0] + want[2]), y1 = Math.min(image.height, want[1] + want[3]);
    if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error(`region [${want.join(", ")}] is outside the picture (${image.width}x${image.height}).`);
    place = [x0, y0, x1 - x0, y1 - y0];
    box = [x0 / image.width, y0 / image.height, (x1 - x0) / image.width, (y1 - y0) / image.height];
  }
  const sx = box[0] * image.width, sy = box[1] * image.height, sw = box[2] * image.width, sh = box[3] * image.height;
  const long = Math.min(WORK_LONG, Math.max(16, 2 * Math.max(sw, sh)));
  const width = Math.max(2, Math.round(sw >= sh ? long : (long * sw) / sh)), height = Math.max(2, Math.round(sh > sw ? long : (long * sh) / sw));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
  return { data: context.getImageData(0, 0, width, height).data, width, height, scale: place[2] / width, place };
}

/** Runs one translated trace_image op on `document`: {document, summary, warnings}. */
export async function applyTraceImage(document, op, { mediaRoot } = {}) {
  if (!op.layerId && !op.media) throw new Error("trace_image needs layer (a video or image layer) or media (an imported src).");
  if (op.colors !== undefined && !(Number.isInteger(op.colors) && op.colors >= 2 && op.colors <= 12)) throw new Error("colors is a whole number from 2 to 12.");
  if (op.smooth !== undefined && !(typeof op.smooth === "number" && op.smooth >= 0 && op.smooth <= 2)) throw new Error("smooth is from 0 (straight lines) to 2.");
  if (op.minArea !== undefined && !(typeof op.minArea === "number" && op.minArea >= 0)) throw new Error("minArea is a number of square pixels, 0 or more.");
  if (op.as !== undefined && !["fill", "outline"].includes(op.as)) throw new Error('as is "fill" or "outline".');
  if (op.background !== undefined && !(op.background === "auto" || op.background === "none" || /^#[0-9a-f]{6}$/i.test(op.background)))
    throw new Error('background is "auto" (the color on most of the region\'s border), "none" (keep every color) or "#rrggbb".');
  const pixels = await regionPixels(document, op, mediaRoot);
  const outline = op.as === "outline";
  const result = traceImage(pixels.data, pixels.width, pixels.height, { colors: op.colors ?? 4, smooth: op.smooth ?? 1, minArea: op.minArea ?? 16,
    background: op.background ?? "auto", scale: pixels.scale, outline });
  if (!result.paths.length) throw new Error(`nothing was left to trace in the region: every color region was the background (${result.background}) or smaller than minArea. Send background:"none" or a smaller minArea.`);
  const [x, y, w, h] = pixels.place;
  const name = op.name ?? "trace";
  const imported = importSvg(traceSvg(result, w, h, { name, outline, strokeWidth: OUTLINE_WIDTH }), { name, DOMParser });
  // The group gets the ID translate.mjs chose from its name, so later ops of the edit can name it;
  // its paths are "<name> 1", "<name> 2"... largest first.
  const group = imported.layers.find((layer) => layer.parentId === null);
  const oldId = group.id;
  if (op.groupId) group.id = op.groupId;
  group.name = name;
  let index = 0;
  const layers = moveRootLayers(imported.layers.map((layer) => {
    if (layer === group) return layer;
    index += 1;
    return { ...layer, name: `${name} ${index}`, parentId: layer.parentId === oldId ? group.id : layer.parentId };
  }), x, y);
  const scene = document.scenes.find((item) => item.id === op.sceneId);
  const next = parseDocument({ ...document, scenes: document.scenes.map((item) => item === scene ? { ...item, layers: [...item.layers, ...layers] } : item) });
  const warnings = [];
  if (result.suggest === "photo") warnings.push(`trace_image: the region looks photographic (mean color error ${result.error} at colors:${op.colors ?? 4}; flat art is under 16 at 12 colors or fewer): the shapes are posterized. Trace a flat graphic, or use cut_out for a photo subject.`);
  else if (result.suggest) warnings.push(`trace_image: colors:${op.colors ?? 4} leaves a mean color error of ${result.error}; colors:${result.suggest} traces this region as flat art.`);
  if (result.dropped) warnings.push(`trace_image: ${result.dropped} small shapes past the first 60 were left out; raise minArea or lower colors.`);
  const points = result.paths.reduce((sum, item) => sum + item.points, 0);
  return { document: next, warnings, summary: { kind: "trace_image", group: name, paths: result.paths.length, points,
    place: [x, y, w, h].map(Math.round), colors: [...new Set(result.paths.map((item) => item.color))], background: result.background,
    ...(result.tolerance > 0.7 ? { simplified: result.tolerance } : {}) } };
}
