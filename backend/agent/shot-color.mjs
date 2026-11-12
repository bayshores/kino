// The dominant hue of a clip or picture at one scene time, for a move's color "auto"
// (backdrop-flash): one small frame (48 px wide) decoded by FFmpeg, or the picture read as is,
// then a 24-bin hue histogram weighted by saturation and brightness. Returns {h, s, l} of the
// strongest bin (h in degrees, s and l 0 to 1), or null when the file cannot be read.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mediaFrameState } from "../../engine/playback.js";
import { runMediaTool } from "../media-probe.mjs";
import { palette } from "../measure/fingerprint.mjs";

const WIDTH = 48;
const BINS = 24;

/** {h, s, l} of the strongest hue in RGBA bytes, or null for a gray picture. */
export function dominantHue(data) {
  const weight = new Float64Array(BINS), sat = new Float64Array(BINS), light = new Float64Array(BINS);
  for (let index = 0; index + 3 < data.length; index += 4) {
    const r = data[index] / 255, g = data[index + 1] / 255, b = data[index + 2] / 255;
    const high = Math.max(r, g, b), low = Math.min(r, g, b), d = high - low, l = (high + low) / 2;
    if (d < 0.04) continue;
    const s = d / (1 - Math.abs(2 * l - 1) || 1);
    const h = high === r ? 60 * (((g - b) / d + 6) % 6) : high === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    const bin = Math.floor(h / (360 / BINS)) % BINS, w = s * high;
    weight[bin] += w; sat[bin] += s * w; light[bin] += l * w;
  }
  let best = -1;
  for (let bin = 0; bin < BINS; bin += 1) if (weight[bin] > 0 && (best < 0 || weight[bin] > weight[best])) best = bin;
  if (best < 0) return null;
  return { h: (best + 0.5) * (360 / BINS), s: sat[best] / weight[best], l: light[best] / weight[best] };
}

/**
 * Where the picture's luma splits into its darkest, middle and lightest thirds, for an
 * impact-accent hit's recolor (moves/impact.js recolorSplit): {at: [low, high], gaps: [g1, g2]},
 * luma 0 to 1 (Rec.709 on sRGB bytes of opaque pixels, as the tritone reads luma,
 * engine/effects/postFx.js). Each split is the boundary of a 256-level histogram whose share of
 * pixels below is nearest 1/3 (then 2/3, above the first), put in the middle of the empty luma
 * range there; its gap is that range's width. A flat area (a page's white, a dark UI's background)
 * is never cut in two: a percentile on a flat area would put half of it in each tone (measured
 * on a dark screenshot: its 33rd and 67th percentiles were 0.046 and 0.073, both on its background).
 * null for an empty picture.
 */
export function lumaSplit(data) {
  const bins = new Uint32Array(256);
  let total = 0;
  for (let index = 0; index + 3 < data.length; index += 4) {
    if (data[index + 3] < 128) continue;
    bins[Math.round(0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2])] += 1;
    total += 1;
  }
  if (!total) return null;
  // below[k]: the share of pixels in bins under k (boundary k sits between bins k - 1 and k).
  const below = new Float64Array(257);
  for (let k = 1; k <= 256; k += 1) below[k] = below[k - 1] + bins[k - 1] / total;
  const nearest = (share, from) => {
    let best = from;
    for (let k = from; k <= 256; k += 1) if (Math.abs(below[k] - share) < Math.abs(below[best] - share) - 1e-12) best = k;
    return best;
  };
  const split = (k) => {
    let a = k - 1, b = k;
    while (a >= 0 && !bins[a]) a -= 1;
    while (b <= 255 && !bins[b]) b += 1;
    const low = Math.max(0, a), high = Math.min(255, b);
    return { at: Math.round(((low + high) / 2 / 255) * 1000) / 1000, gap: Math.round(((high - low) / 255) * 1000) / 1000 };
  };
  const first = nearest(1 / 3, 1);
  const second = nearest(2 / 3, first + 1);
  const [one, two] = [split(first), split(Math.min(256, second))];
  return { at: [one.at, two.at], gaps: [one.gap, two.gap] };
}

/**
 * The dominant hue of `layer`'s picture at scene time `time` (its file in mediaRoot), with the
 * picture's luma split into thirds (`tones`, lumaSplit); a gray picture gives {h: null, s: 0, tones}.
 */
export async function shotColor(mediaRoot, layer, time) {
  const data = await frameData(mediaRoot, layer, time);
  return data ? { ...(dominantHue(data) ?? { h: null, s: 0, l: null }), tones: lumaSplit(data) } : null;
}

// RGBA bytes of a picture drawn WIDTH wide, or null.
function imageData(image) {
  const height = Math.max(1, Math.round((WIDTH * image.height) / Math.max(1, image.width)));
  const canvas = createCanvas(WIDTH, height);
  canvas.getContext("2d").drawImage(image, 0, 0, WIDTH, height);
  return canvas.getContext("2d").getImageData(0, 0, WIDTH, height).data;
}

/**
 * The longest side, in pixels, of a video a small frame is decoded from. FFmpeg decodes a frame at
 * the file's own size before it scales it down, so a larger file (4K) is never decoded here: its
 * readers fall back to their next source.
 */
export const DECODE_MOST = 1920;

/** The file's saved pixel size ({width, height}, the measurements kept beside it at import), or null when unknown. */
export async function savedSize(file) {
  try { const info = JSON.parse(await readFile(`${file}.json`, "utf8")); return info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null; } catch { return null; }
}

// `layer`'s picture at scene time `time` as RGBA bytes WIDTH wide (one FFmpeg frame for a video), or null.
async function frameData(mediaRoot, layer, time) {
  const id = /^\/api\/media\/([A-Za-z0-9._-]+)$/.exec(String(layer?.src ?? ""))?.[1];
  if (!mediaRoot || !id || id.includes("..")) return null;
  const file = path.join(mediaRoot, id);
  if (layer.type !== "video") {
    try { return imageData(await loadImage(file)); } catch { return null; }
  }
  const size = await savedSize(file);
  if (size && Math.max(size.width, size.height) > DECODE_MOST) return null;
  const folder = await mkdtemp(path.join(tmpdir(), "kino-hue-"));
  try {
    const at = Math.max(0, mediaFrameState(layer, time).sourceTime ?? 0);
    const out = path.join(folder, "frame.png");
    await runMediaTool("ffmpeg", ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `scale=${WIDTH}:-2`, "-y", out], { timeoutMs: 20_000 });
    return imageData(await loadImage(out));
  } catch { return null; } finally { await rm(folder, { recursive: true, force: true }); }
}

/** The main colors of RGBA bytes ([{hex, share}], biggest first; fingerprint.mjs palette, k 5). */
export function palettePixels(data) {
  const pixels = [];
  for (let index = 0; index + 3 < data.length; index += 4) if (data[index + 3] > 128) pixels.push([data[index], data[index + 1], data[index + 2]]);
  return palette(pixels);
}

/** The main colors of `layer`'s picture at scene time `time` ([{hex, share}]), or null. */
export async function shotPalette(mediaRoot, layer, time) {
  const data = await frameData(mediaRoot, layer, time);
  return data ? palettePixels(data) : null;
}

// Detail below this mean edge strength (0 to 255 per pixel) is a flat picture: no busy part.
const FLAT = 2;
// The busy part spans the middle of the picture's edge strength along each axis (15% to 85% of it).
const EDGE_SHARE = 0.15;

/**
 * Where the detail of RGBA bytes `width` wide sits: [x, y, w, h] in fractions of the picture, the
 * span holding the middle 70% of its edge strength (luma steps to the right and below) along each
 * axis, or null for a flat picture. A splatter goes beside it, where the picture has room.
 */
export function detailBox(data, width) {
  const height = Math.floor(data.length / 4 / width);
  if (width < 2 || height < 2) return null;
  const luma = new Float64Array(width * height);
  for (let index = 0; index < luma.length; index += 1) luma[index] = 0.2126 * data[index * 4] + 0.7152 * data[index * 4 + 1] + 0.0722 * data[index * 4 + 2];
  const columns = new Float64Array(width), rows = new Float64Array(height);
  let total = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const at = y * width + x, edge = Math.abs(luma[at + 1] - luma[at]) + Math.abs(luma[at + width] - luma[at]);
      columns[x] += edge; rows[y] += edge; total += edge;
    }
  }
  if (total / ((width - 1) * (height - 1)) < FLAT) return null;
  const span = (sums) => {
    let sum = 0, from = 0, to = sums.length - 1;
    for (let index = 0; index < sums.length; index += 1) { sum += sums[index]; if (sum >= total * EDGE_SHARE) { from = index; break; } }
    sum = 0;
    for (let index = sums.length - 1; index >= 0; index -= 1) { sum += sums[index]; if (sum >= total * EDGE_SHARE) { to = index; break; } }
    return [from / sums.length, (Math.max(from, to) + 1) / sums.length];
  };
  const [x0, x1] = span(columns), [y0, y1] = span(rows);
  const three = (value) => Math.round(value * 1000) / 1000;
  return [three(x0), three(y0), three(x1 - x0), three(y1 - y0)];
}

/** The busy part of `layer`'s picture at scene time `time` ({box: detailBox}, from one small frame), or null. */
export async function shotDetail(mediaRoot, layer, time) {
  const data = await frameData(mediaRoot, layer, time);
  const box = data ? detailBox(data, WIDTH) : null;
  // The small frame has the file's own shape: it places the box inside the layer as the renderer draws the picture.
  return box ? { box, source: { width: WIDTH, height: Math.floor(data.length / 4 / WIDTH) } } : null;
}

/** The main colors of an image file (a saved reference's strip frame), or null. */
export async function filePalette(file) {
  try { return palettePixels(imageData(await loadImage(file))); } catch { return null; }
}
