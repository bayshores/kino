// Sketch rounds: a try round (tries.mjs) whose options are 2 to 10 s sketches of the treatments
// the person was shown (treatments.mjs), each tied to one treatment by its letter. A sketch is the
// option's ops on a copy of the open document over one stretch (from, to), rendered with its
// sound (the song and lines over that stretch), so the person picks a direction by watching and
// hearing side by side instead of rating a finished edit alone. The pick becomes the treatment
// pick, by them, exactly as their typed pick does.
//
// This file holds the plain parts: reading the sketch fields, the cache key of a sketch, the
// numbers measured on each rendered clip (picture changes, median shot, lettering, loudness,
// colors) and the receipt lines that set the sketches side by side. Nothing here blocks or warns.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateScene } from "../../engine/animation.js";
import { palette, pixelStats } from "../measure/fingerprint.mjs";
import { ffmpegCommand } from "../media-probe.mjs";
import { KNOWN_LABEL, LABELS } from "./treatments.mjs";

// Seconds a sketch lasts: long enough to hear a phrase of the song, short enough to watch 3 in a row.
export const SKETCH_LEAST = 2;
export const SKETCH_MOST = 10;
// Characters of ops one sketch may carry (a plain try option keeps 4,000). Three real sketches of
// 6 s on a 14 s fan edit took 826 to 1,260 characters (4 to 6 add_layer ops each); the room above
// that is for sketches that also animate, a starting value.
export const SKETCH_OPS_MOST = 12000;
// Frames a second the clip is sampled at for its numbers, and the sampled frame's size.
export const MEASURE_FPS = 10;
const MEASURE_W = 64;
const MEASURE_H = 36;
// Two sampled frames whose 16 × 9 blocks differ this much in mean brightness (0 to 1) count as a
// picture change. A starting value, printed with the numbers: on the 14 s fan edit it found the 8
// shot starts of 6 to 12 s, and movement inside a shot stayed at or under 0.039.
export const CHANGE_AT = 0.05;
// Two colors this close (RGB distance) count as the same color when two sketches are compared.
const SAME_COLOR = 48;
// Sketch clips kept in the cache folder per project (the oldest go first).
const CACHE_KEPT = 24;

const sec = (value) => Math.round(value * 100) / 100;
const median = (values) => {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};

/** True when a try input asks for sketches: a stretch (from and to) or an option tied to a treatment. */
export const isSketchInput = (input) => input?.from !== undefined || input?.to !== undefined
  || (Array.isArray(input?.options) && input.options.some((option) => option?.treatment !== undefined));

/** The letters a sketch can name: the 3 shown (A to C), and D when the dropped one is listed. */
function shownLetters(treatments, known) {
  return [...LABELS.slice(0, treatments.shown.length), ...(known ? [KNOWN_LABEL] : [])];
}

/** The treatment entry behind a letter. */
export function treatmentOf(treatments, letter) {
  const index = letter === KNOWN_LABEL ? treatments.dropped : treatments.shown[LABELS.indexOf(letter)];
  return treatments.list[index];
}

/**
 * Reads the sketch part of a try input (throws its words when a field is wrong): {from, to,
 * treatments:[letter per option], names:[default name per option]}. `treatments` is the saved
 * brief.treatments; `known` true lets D (the dropped one the ask is known for) be named.
 */
export function readSketch(input, scene, treatments, known = false) {
  if (!treatments?.list) throw new Error('Sketches show the treatments: save the 5 first (notes brief fields:{treatments:[...]}), then sketch the 3 shown.');
  const from = Number(input.from);
  const to = Number(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > scene.duration + 1e-6 || to - from < SKETCH_LEAST - 1e-6 || to - from > SKETCH_MOST + 1e-6)
    throw new Error(`A sketch is one stretch of the scene: from and to in seconds, ${SKETCH_LEAST} to ${SKETCH_MOST} s long, inside 0 to ${sec(scene.duration)} s.`);
  const letters = shownLetters(treatments, known);
  const picked = input.options.map((option, index) => {
    const named = String(option?.treatment ?? "").trim();
    const letter = letters.find((entry) => entry === named.toUpperCase())
      ?? letters.find((entry) => { const item = treatmentOf(treatments, entry); return [item.idea, item.move].some((text) => text?.toLowerCase() === named.toLowerCase()); });
    if (!letter) throw new Error(`options[${index}].treatment is the letter of a shown treatment (${letters.join(", ")}), the one this sketch shows.`);
    if (JSON.stringify(option.ops ?? []).length > SKETCH_OPS_MOST) throw new Error(`options[${index}].ops is over ${SKETCH_OPS_MOST} characters: sketch the stretch with fewer layers.`);
    return letter;
  });
  if (new Set(picked).size !== picked.length) throw new Error("Each sketch shows its own treatment.");
  return { from: sec(from), to: sec(to), treatments: picked, names: picked.map((letter) => treatmentOf(treatments, letter).move.slice(0, 40)) };
}

/** The cache key of one sketch: the document before its ops, the ops, the scene and the stretch. */
export function sketchKey(document, ops, sceneId, from, to) {
  return createHash("sha256").update(JSON.stringify({ document, ops, sceneId, from, to, sound: true, measure: [MEASURE_FPS, CHANGE_AT] })).digest("hex").slice(0, 32);
}

/** The cache folder's clip and numbers of a key, and a way to keep the newest CACHE_KEPT. */
export function sketchCache(folder) {
  const clip = (key) => path.join(folder, `${key}.mp4`);
  const facts = (key) => path.join(folder, `${key}.json`);
  return {
    /** Copies a cached clip to `outputPath` and answers its saved numbers, or null when not cached. */
    async take(key, outputPath) {
      try {
        const saved = JSON.parse(await readFile(facts(key), "utf8"));
        await copyFile(clip(key), outputPath);
        return saved;
      } catch { return null; }
    },
    async keep(key, outputPath, saved) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await copyFile(outputPath, clip(key));
      await writeFile(facts(key), JSON.stringify(saved));
      const names = (await readdir(folder)).filter((name) => name.endsWith(".mp4"));
      if (names.length <= CACHE_KEPT) return;
      const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(folder, name))).mtimeMs })));
      for (const { name } of dated.sort((a, b) => a.at - b.at).slice(0, names.length - CACHE_KEPT)) {
        await rm(path.join(folder, name), { force: true });
        await rm(path.join(folder, name.replace(/\.mp4$/, ".json")), { force: true });
      }
    },
  };
}

/**
 * The share of sampled times (MEASURE_FPS) from `from` to `to` at which a text layer of the scene is
 * shown (visible, not see-through, inside shown groups): lettering on screen, from the document.
 */
export function letteringShare(scene, from, to) {
  if (!scene.layers.some((layer) => layer.type === "text")) return 0;
  const count = Math.max(1, Math.round((to - from) * MEASURE_FPS));
  let shown = 0;
  for (let index = 0; index < count; index += 1) {
    const evaluated = evaluateScene(scene, from + (index + 0.5) / MEASURE_FPS);
    const byId = new Map(evaluated.layers.map((layer) => [layer.id, layer]));
    const seen = (layer, depth = 0) => layer.visible !== false && (layer.opacity ?? 1) > 0.02
      && (!layer.parentId || !byId.has(layer.parentId) || depth > 32 || seen(byId.get(layer.parentId), depth + 1));
    if (evaluated.layers.some((layer) => layer.type === "text" && String(layer.text ?? "").trim() && seen(layer))) shown += 1;
  }
  return shown / count;
}

/** The mean brightness change between two frames' block grids (lumaGrid), 0 to 1. */
export const blockChange = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / Math.max(1, a.length);

/**
 * The numbers of one rendered sketch from its sampled frames ([{cells, pixels}], MEASURE_FPS) and
 * its loudness: picture changes (cuts, flashes and hard swaps alike), median shot seconds, the 3
 * biggest colors and the integrated loudness. `lettering` comes from letteringShare.
 */
export function clipFacts(frames, { seconds, lufs = null, lettering = null }) {
  const changes = [];
  let last = -2;
  for (let index = 1; index < frames.length; index += 1) {
    if (blockChange(frames[index - 1].cells, frames[index].cells) < CHANGE_AT) continue;
    // Two changed samples in a row are one change (a two-frame dissolve or a flash in and out).
    if (index - last > 1) changes.push(index / MEASURE_FPS);
    last = index;
  }
  const edges = [0, ...changes, seconds];
  const shots = edges.slice(1).map((time, index) => time - edges[index]).filter((length) => length > 0);
  const colors = palette(frames.flatMap((frame) => frame.pixels), 4).slice(0, 3);
  return { changes: changes.length, shot: sec(median(shots) ?? seconds), lettering: lettering === null ? null : Math.round(lettering * 100) / 100,
    lufs: Number.isFinite(lufs) ? Math.round(lufs * 10) / 10 : null, colors };
}

const rgb = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const near = (a, b) => Math.hypot(...rgb(a).map((value, index) => value - rgb(b)[index])) <= SAME_COLOR;

/** How many of a's colors have a near twin among b's. */
export const sharedColors = (a, b) => a.colors.filter((color) => b.colors.some((other) => near(color.hex, other.hex))).length;

// How far apart two sketches are, as one number for finding the closest pair: each fact's gap over
// its usual range, added up (a plain sum; the receipt prints the facts themselves).
function gap(a, b) {
  const part = (x, y, range) => (x === null || y === null ? 0 : Math.min(1, Math.abs(x - y) / range));
  return part(a.changes, b.changes, 6) + part(a.shot, b.shot, 2) + part(a.lettering, b.lettering, 0.5) + part(a.lufs, b.lufs, 6)
    + (1 - sharedColors(a, b) / Math.max(1, Math.min(a.colors.length, b.colors.length)));
}

const factText = (facts) => [
  `${facts.changes} picture change${facts.changes === 1 ? "" : "s"}`, `median shot ${facts.shot} s`,
  facts.lettering === null ? null : `lettering ${Math.round(facts.lettering * 100)}% of frames`,
  facts.lufs === null ? "no sound" : `${facts.lufs} LUFS`,
  facts.colors.length ? `colors ${facts.colors.map((color) => `${color.hex} ${Math.round(color.share * 100)}%`).join(", ")}` : null,
].filter(Boolean).join(", ");

/**
 * The receipt lines of a rendered sketch round: one per sketch (render seconds per sketch second,
 * measured, or cached) and the closest pair side by side. `options` [{letter, name, treatment,
 * renderSeconds, cached, facts, error}].
 */
export function sketchLines(round) {
  const length = Math.max(0.01, round.to - round.from);
  const lines = round.options.map((option) => {
    const head = `${option.letter} (treatment ${option.treatment}, ${option.name})`;
    if (option.error) return `${head}: could not be made: ${option.error}`;
    if (!option.facts) return `${head}: still rendering`;
    const made = option.cached ? "cached, not rendered again" : `rendered in ${sec(option.renderSeconds)} s, ${sec(option.renderSeconds / length)} s per sketch second (measured on this machine)`;
    return `${head}: ${made}; ${factText(option.facts)}`;
  });
  const done = round.options.filter((option) => option.facts);
  let closest = null;
  for (let i = 0; i < done.length; i += 1)
    for (let j = i + 1; j < done.length; j += 1) {
      const distance = gap(done[i].facts, done[j].facts);
      if (!closest || distance < closest.distance) closest = { a: done[i], b: done[j], distance };
    }
  if (closest) {
    const { a, b } = closest;
    const pair = (key, unit = "") => `${a.facts[key] ?? "none"}${unit} vs ${b.facts[key] ?? "none"}${unit}`;
    lines.push(`closest pair: ${a.letter} and ${b.letter}: picture changes ${pair("changes")}, median shot ${pair("shot", " s")}, lettering ${a.facts.lettering === null ? "?" : Math.round(a.facts.lettering * 100)}% vs ${b.facts.lettering === null ? "?" : Math.round(b.facts.lettering * 100)}%, loudness ${pair("lufs", " LUFS")}, ${sharedColors(a.facts, b.facts)} of ${Math.min(a.facts.colors.length, b.facts.colors.length)} colors shared`);
  }
  lines.push(`(a picture change: ${MEASURE_FPS} samples a second, mean block brightness moved ${CHANGE_AT} or more from the sample before, a starting value)`);
  return lines;
}

// ---- measuring a clip file ----------------------------------------------------------------------

function run(args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { err = (err + chunk).slice(-20000); });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve({ out: binary ? Buffer.concat(out) : Buffer.concat(out).toString("utf8"), err }) : reject(new Error(err.trim().split("\n").at(-1) || `ffmpeg exited ${code}`))));
  });
}

/** The numbers of the sketch rendered to `file` from `document` (scene `sceneId`, `from` to `to`). */
export async function measureSketch(document, sceneId, from, to, file) {
  const scene = document.scenes.find((entry) => entry.id === sceneId);
  const { frames, lufs } = await measureClipFile(file);
  let lettering = null;
  try { lettering = scene ? letteringShare(scene, from, to) : null; } catch { lettering = null; }
  return clipFacts(frames, { seconds: to - from, lufs, lettering });
}

/** The mean brightness (0 to 1) of each 4 × 4 pixel block of a MEASURE_W × MEASURE_H RGBA frame. */
export function lumaGrid(bytes) {
  const cols = MEASURE_W / 4, rows = MEASURE_H / 4;
  const grid = new Array(cols * rows).fill(0);
  for (let y = 0; y < MEASURE_H; y += 1)
    for (let x = 0; x < MEASURE_W; x += 1) {
      const at = (y * MEASURE_W + x) * 4;
      grid[Math.floor(y / 4) * cols + Math.floor(x / 4)] += (0.2126 * bytes[at] + 0.7152 * bytes[at + 1] + 0.0722 * bytes[at + 2]) / 255 / 16;
    }
  return grid;
}

/** The sampled frames ([{hist, pixels, cells}]) and integrated loudness (LUFS, null without sound) of a clip file. */
export async function measureClipFile(file) {
  const { out } = await run(["-v", "error", "-nostdin", "-i", file, "-vf", `fps=${MEASURE_FPS},scale=${MEASURE_W}:${MEASURE_H}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { binary: true });
  const size = MEASURE_W * MEASURE_H * 4;
  const frames = [];
  for (let at = 0; at + size <= out.length; at += size) {
    const stats = pixelStats(out.subarray(at, at + size), MEASURE_W, MEASURE_H, { order: "rgba", palettePixels: 36 });
    frames.push({ pixels: stats.pixels, cells: lumaGrid(out.subarray(at, at + size)) });
  }
  let lufs = null;
  try {
    const { err } = await run(["-hide_banner", "-nostats", "-nostdin", "-i", file, "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    const found = [...err.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].at(-1)?.[1];
    lufs = found && found !== "-inf" ? Number(found) : null;
  } catch { lufs = null; }
  return { frames, lufs };
}
