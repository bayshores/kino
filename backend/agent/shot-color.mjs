// The dominant hue of a clip or picture at one scene time, for a move's color "auto"
// (backdrop-flash): one small frame (48 px wide) decoded by FFmpeg, or the picture read as is,
// then a 24-bin hue histogram weighted by saturation and brightness. Returns {h, s, l} of the
// strongest bin (h in degrees, s and l 0 to 1), or null when the file cannot be read.
import { mkdtemp, rm } from "node:fs/promises";
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

// `layer`'s picture at scene time `time` as RGBA bytes WIDTH wide (one FFmpeg frame for a video), or null.
async function frameData(mediaRoot, layer, time) {
  const id = /^\/api\/media\/([A-Za-z0-9._-]+)$/.exec(String(layer?.src ?? ""))?.[1];
  if (!mediaRoot || !id || id.includes("..")) return null;
  const file = path.join(mediaRoot, id);
  if (layer.type !== "video") {
    try { return imageData(await loadImage(file)); } catch { return null; }
  }
  const folder = await mkdtemp(path.join(tmpdir(), "kino-hue-"));
  try {
    const at = Math.max(0, mediaFrameState(layer, time).sourceTime ?? 0);
    const out = path.join(folder, "frame.png");
    await runMediaTool("ffmpeg", ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `scale=${WIDTH}:-2`, "-y", out], { timeoutMs: 20_000 });
    return imageData(await loadImage(out));
  } catch { return null; } finally { await rm(folder, { recursive: true, force: true }); }
}

/**
 * The mean color (#rrggbb) of `layer`'s picture under `box` ({x, y, width, height}, scene pixels)
 * at scene time `time`, read from the same small frame (WIDTH px wide, one FFmpeg frame for a video).
 * The picture is taken as drawn across the layer's own box (GUESS: a cover crop's trim is not mapped).
 * null when the file cannot be read or the box misses the layer.
 */
export async function boxColor(mediaRoot, layer, time, box) {
  const data = await frameData(mediaRoot, layer, time);
  if (!data) return null;
  const rows = Math.max(1, Math.round(data.length / 4 / WIDTH));
  const width = Math.abs((layer.width ?? 0) * (layer.scaleX ?? 1)), height = Math.abs((layer.height ?? 0) * (layer.scaleY ?? 1));
  if (!(width > 0 && height > 0)) return null;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const [left, right] = [clamp((box.x - layer.x) / width), clamp((box.x + box.width - layer.x) / width)];
  const [top, bottom] = [clamp((box.y - layer.y) / height), clamp((box.y + box.height - layer.y) / height)];
  if (right <= left || bottom <= top) return null;
  const sum = [0, 0, 0];
  let count = 0;
  for (let row = Math.floor(top * rows); row < Math.min(rows, Math.ceil(bottom * rows)); row += 1)
    for (let column = Math.floor(left * WIDTH); column < Math.min(WIDTH, Math.ceil(right * WIDTH)); column += 1) {
      const at = (row * WIDTH + column) * 4;
      if (data[at + 3] < 128) continue;
      sum[0] += data[at]; sum[1] += data[at + 1]; sum[2] += data[at + 2]; count += 1;
    }
  return count ? `#${sum.map((value) => Math.round(value / count).toString(16).padStart(2, "0")).join("")}` : null;
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

/** The main colors of an image file (a saved reference's strip frame), or null. */
export async function filePalette(file) {
  try { return palettePixels(imageData(await loadImage(file))); } catch { return null; }
}
