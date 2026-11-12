// Frame strips of a reference: 6 small frames (240 px wide) around each moment worth seeing (a
// cut, a motion peak, a text entrance), one JPEG a moment. Inspire keeps them after it deletes the
// downloaded copy, so an agent can look at how the reference moves and confirm a suggested style
// line (look {mode:"reference", ref, t}). Everything else about the footage is deleted.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas";
import { ffmpegCommand } from "../media-probe.mjs";
import { ffmpegArgs, lowerIfBackground } from "../render-activity.mjs";

/** Frames in a strip, their width, how far before the moment the strip starts, and the most kept. */
export const STRIP_FRAMES = 6;
export const STRIP_WIDTH = 240;
export const STRIP_LEAD = 0.25;
export const MAX_STRIPS = 24;
// Moments closer than this share one strip.
const JOIN = 0.6;
// Strips on one page of look {mode:"reference"}.
export const SHEET_ROWS = 6;

const round = (value) => Math.round(value * 100) / 100;

/** Up to `count` items spread evenly over a list. */
function spread(list, count) {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, index) => list[Math.round((index * (list.length - 1)) / Math.max(1, count - 1))]);
}

/**
 * The moments to keep strips of: cuts (at most 14, spread over the clip), motion peaks, and the
 * example times the fingerprint names (text entrances, camera moves, blur dips, dissolves, fades),
 * so every time a suggested line cites has a strip. Moments within 0.6 s share a strip. Returns
 * [{at, kinds}] sorted by time, at most MAX_STRIPS (cuts give way first).
 */
export function stripMoments(fingerprint, cuts = []) {
  const wanted = [
    ...spread(cuts, 14).map((at) => ({ at, kind: "cut" })),
    ...(fingerprint?.motion?.peaks ?? []).map((at) => ({ at, kind: "motion" })),
    // The times the suggested style lines name (suggest.mjs uses the first 3 of each list).
    ...Object.entries(fingerprint?.text?.examples ?? {}).flatMap(([style, times]) => times.slice(0, 2).map((at) => ({ at, kind: `text ${style}` }))),
    ...Object.entries(fingerprint?.camera?.examples ?? {}).flatMap(([kind, times]) => times.slice(0, 2).map((at) => ({ at, kind }))),
    ...Object.entries(fingerprint?.transitions ?? {}).flatMap(([kind, times]) => times.slice(0, 3).map((at) => ({ at, kind: kind.replace(/s$/, "").replace("blurDip", "blur dip") }))),
  ].filter((entry) => Number.isFinite(entry.at)).sort((a, b) => a.at - b.at);
  const moments = [];
  for (const entry of wanted) {
    const last = moments.at(-1);
    if (last && entry.at - last.at < JOIN) { if (!last.kinds.includes(entry.kind)) last.kinds.push(entry.kind); continue; }
    moments.push({ at: round(entry.at), kinds: [entry.kind] });
  }
  // Too many: keep every kind that is not a cut, then cuts spread out.
  if (moments.length <= MAX_STRIPS) return moments;
  const others = moments.filter((moment) => moment.kinds.some((kind) => kind !== "cut"));
  const onlyCuts = moments.filter((moment) => moment.kinds.every((kind) => kind === "cut"));
  return [...others.slice(0, MAX_STRIPS), ...spread(onlyCuts, Math.max(0, MAX_STRIPS - others.length))].sort((a, b) => a.at - b.at);
}

/** The FFmpeg arguments for one strip: 6 frames at 12 a second from STRIP_LEAD s before `at`. */
export function stripArgs(file, at, out) {
  const start = Math.max(0, at - STRIP_LEAD);
  return ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", String(round(start)), "-t", String(STRIP_FRAMES / 12 + 0.05), "-i", file, "-an", "-sn", "-dn",
    "-vf", `fps=12,scale=${STRIP_WIDTH}:-2:flags=area,tile=${STRIP_FRAMES}x1`, "-frames:v", "1", "-q:v", "6", out];
}

/** One frame (PNG bytes) of the kept strips: the strip nearest `t`, its frame nearest `t` (library fonts like). */
export async function referenceStripFrame(folder, strips, t) {
  if (!strips?.length) throw new Error("no frame strips are kept for that reference.");
  const strip = strips.reduce((best, item) => (Math.abs(item.at - t) < Math.abs(best.at - t) ? item : best));
  const image = await loadImage(path.join(folder, strip.file));
  const width = image.width / STRIP_FRAMES;
  const index = Math.min(STRIP_FRAMES - 1, Math.max(0, Math.round((t - Math.max(0, strip.at - STRIP_LEAD)) * 12)));
  const canvas = createCanvas(Math.round(width), image.height);
  canvas.getContext("2d").drawImage(image, index * width, 0, width, image.height, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/png");
}

function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand(), ffmpegArgs(args), { stdio: ["ignore", "ignore", "pipe"], signal });
    lowerIfBackground(child);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-500); });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg could not make a strip: ${stderr.trim().split("\n").at(-1) || code}`))));
  });
}

/**
 * Makes the strips of `moments` from a video file into `folder` (replacing what was there), one
 * FFmpeg at a time. A folder being written is renamed into place last. Returns
 * [{at, kinds, file}] for the strips made (a moment FFmpeg could not read is left out).
 */
export async function makeStrips(file, moments, folder, { signal } = {}) {
  const partial = `${folder}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true, mode: 0o700 });
  const made = [];
  try {
    for (const [index, moment] of moments.entries()) {
      const name = `${String(index + 1).padStart(2, "0")}.jpg`;
      try {
        await runFfmpeg(stripArgs(file, moment.at, path.join(partial, name)), signal);
        if (existsSync(path.join(partial, name))) made.push({ ...moment, file: name });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    await rm(folder, { recursive: true, force: true });
    await rename(partial, folder);
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return made;
}

const labelFont = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts/Inter-600.ttf");
let fontReady = false;

/**
 * One PNG of strips for look {mode:"reference"}: with `t`, the strip nearest t and its two
 * neighbors; without, page `page` of SHEET_ROWS strips. Each row is labeled with its time and
 * what happens there. Returns {png, shown: [{at, kinds}], pages}.
 */
export async function referenceSheet(folder, strips, { t = null, page = 1 } = {}) {
  if (!fontReady) { try { GlobalFonts.registerFromPath(labelFont, "kino-label"); } catch { /* default font */ } fontReady = true; }
  const pages = Math.max(1, Math.ceil(strips.length / SHEET_ROWS));
  let shown;
  if (Number.isFinite(t)) {
    const nearest = strips.reduce((best, strip, index) => (Math.abs(strip.at - t) < Math.abs(strips[best].at - t) ? index : best), 0);
    shown = strips.slice(Math.max(0, nearest - 1), nearest + 2);
  } else {
    const at = Math.min(pages, Math.max(1, page)) - 1;
    shown = strips.slice(at * SHEET_ROWS, at * SHEET_ROWS + SHEET_ROWS);
  }
  const images = [];
  for (const strip of shown) images.push(await loadImage(path.join(folder, strip.file)));
  const label = 22;
  const width = Math.max(...images.map((image) => image.width));
  const height = images.reduce((sum, image) => sum + image.height + label, 0);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#111214";
  context.fillRect(0, 0, width, height);
  let y = 0;
  shown.forEach((strip, index) => {
    const start = Math.max(0, strip.at - STRIP_LEAD);
    context.fillStyle = "#ffffff";
    context.font = "13px kino-label, sans-serif";
    context.fillText(`${strip.at.toFixed(2)} s: ${strip.kinds.join(", ")}   (frames ${start.toFixed(2)} s to ${(start + (STRIP_FRAMES - 1) / 12).toFixed(2)} s, 1/12 s apart)`, 6, y + 15);
    context.drawImage(images[index], 0, y + label);
    y += label + images[index].height;
  });
  return { png: canvas.toBuffer("image/png"), shown: shown.map(({ at, kinds }) => ({ at, kinds })), pages };
}
