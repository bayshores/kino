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

/** The dominant hue of `layer`'s picture at scene time `time` (its file in mediaRoot). */
export async function shotColor(mediaRoot, layer, time) {
  const id = /^\/api\/media\/([A-Za-z0-9._-]+)$/.exec(String(layer?.src ?? ""))?.[1];
  if (!mediaRoot || !id || id.includes("..")) return null;
  const file = path.join(mediaRoot, id);
  let image;
  if (layer.type === "video") {
    const folder = await mkdtemp(path.join(tmpdir(), "kino-hue-"));
    try {
      const at = Math.max(0, mediaFrameState(layer, time).sourceTime ?? 0);
      const out = path.join(folder, "frame.png");
      await runMediaTool("ffmpeg", ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `scale=${WIDTH}:-2`, "-y", out], { timeoutMs: 20_000 });
      image = await loadImage(out);
    } catch { return null; } finally { await rm(folder, { recursive: true, force: true }); }
  } else {
    try { image = await loadImage(file); } catch { return null; }
  }
  const height = Math.max(1, Math.round((WIDTH * image.height) / Math.max(1, image.width)));
  const canvas = createCanvas(WIDTH, height);
  canvas.getContext("2d").drawImage(image, 0, 0, WIDTH, height);
  return dominantHue(canvas.getContext("2d").getImageData(0, 0, WIDTH, height).data);
}
