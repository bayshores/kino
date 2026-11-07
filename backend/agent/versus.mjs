// Fair pairs for look {mode:"versus"}: each of the edit's shots sits beside a reference moment of
// the same kind, so the gaps compare craft and not content (a street shot is never held to a UI
// shot). The order, per shot:
//   1. the moment its board move pins (move.ref "phone-film@3.13", judge.mjs pinnedPairs);
//   2. else the reference moment of the same kind nearest the same point of the story;
//   3. else "no fair match": the shot is shown alone, with no gap numbers.
// Kinds: app (an app or UI recording), type (type on a plain frame), footage (people or camera
// footage), device (a phone in hand) and end (the end card or logo). A board shot's kind comes
// from what it holds (engine/movePicks.js shotKinds); a frame without a board, and every reference
// still, is read from its pixels (backend/measure/fingerprint.mjs pixelStats). Pixels cannot tell
// a phone in hand, so a device shot is matched only by a pin.
//
// The gaps a pair shows are the craft that transfers: how much of the frame the hero fills and
// the contrast. Type size, motion, holds and cuts come from the reference_drift rows; colors and
// what is on screen come from the footage and are not compared.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import path from "node:path";
import { mediaKind, shotKinds } from "../../engine/movePicks.js";
import { CELL_COLS, CELL_ROWS, pixelStats } from "../measure/fingerprint.mjs";

export const KIND_WORDS = Object.freeze({ app: "app recording", type: "type on a plain frame", footage: "footage", device: "phone in hand", end: "end card" });
// A cell is flat under this spread; a frame with at most PLAIN_ROWS rows of busy cells, or this
// share of flat cells, is a plain frame (type or a logo on a background).
const FLAT = 0.02;
const PLAIN_ROWS = 3;
const PLAIN_SHARE = 0.85;
// Skin-colored pixels past this share: people on screen. Flat cells past APP_FLAT, or edges this
// sharp (small interface text), with no people: an app or UI recording.
const SKIN = 0.2;
const APP_FLAT = 0.3;
const APP_SHARP = 700;
// A plain frame in the last share of the edit is its end card.
const END_SHARE = 0.85;
// Gaps worth saying: the hero's share of the frame apart by this much; contrast apart by this ratio and amount.
const FILL_GAP = 0.2;
const CONTRAST_RATIO = 1.5;
const CONTRAST_GAP = 0.05;

const round = (value) => Math.round(value * 100) / 100;
const percent = (value) => `${Math.round(value * 100)}%`;

/** Plain numbers from an image's RGBA pixels: {plain, skin, flat, sharp, fill, contrast}. */
export function frameStats(rgba, width, height) {
  const stats = pixelStats(rgba, width, height, { order: "rgba" });
  const count = CELL_COLS * CELL_ROWS;
  const mean = (cell) => stats.cells[cell * 2], spread = (cell) => stats.cells[cell * 2 + 1];
  const border = [];
  for (let cell = 0; cell < count; cell += 1) {
    const row = Math.floor(cell / CELL_COLS), col = cell % CELL_COLS;
    if (row === 0 || col === 0 || row === CELL_ROWS - 1 || col === CELL_COLS - 1) border.push(mean(cell));
  }
  border.sort((a, b) => a - b);
  const background = border[Math.floor(border.length / 2)];
  let flat = 0, hero = 0, sum = 0, squares = 0;
  const busyRows = new Set();
  for (let cell = 0; cell < count; cell += 1) {
    if (spread(cell) < FLAT) flat += 1; else busyRows.add(Math.floor(cell / CELL_COLS));
    if (spread(cell) >= FLAT || Math.abs(mean(cell) - background) >= 0.1) hero += 1;
    sum += mean(cell); squares += mean(cell) ** 2;
  }
  let skin = 0, sampled = 0;
  for (let at = 0; at < rgba.length; at += 4 * 37) {
    const r = rgba[at], g = rgba[at + 1], b = rgba[at + 2];
    sampled += 1;
    if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15 && r - Math.min(g, b) > 15) skin += 1;
  }
  const average = sum / count;
  return { plain: busyRows.size <= PLAIN_ROWS || flat / count >= PLAIN_SHARE, skin: round(skin / Math.max(1, sampled)), flat: round(flat / count),
    sharp: Math.round(stats.sharp), fill: round(hero / count), contrast: round(2 * Math.sqrt(Math.max(0, squares / count - average * average))) };
}

/** A frame's kind from its stats: type (plain), footage (people) or app; "end" is decided by its place. */
export function pixelKind(stats) {
  if (stats.plain) return "type";
  if (stats.skin >= SKIN) return "footage";
  return stats.flat >= APP_FLAT || stats.sharp >= APP_SHARP ? "app" : "footage";
}

/** The stats of an image file or buffer (`cache`, a Map, keeps a file's). */
export async function imageStats(source, cache = null) {
  const key = typeof source === "string" ? source : null;
  if (key && cache?.has(key)) return cache.get(key);
  const image = await loadImage(source);
  const width = Math.min(640, image.width), height = Math.max(2, Math.round((image.height * width) / image.width));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const stats = frameStats(context.getImageData(0, 0, width, height).data, width, height);
  if (key && cache) { if (cache.size > 4000) cache.clear(); cache.set(key, stats); }
  return stats;
}

/**
 * Each still of `ref` with its kind and stats ({at, file, kind, stats}): from its pixels, and the
 * plain stills that run to the end of the reference are its end card.
 */
export async function referenceMoments(ref, cache = null) {
  const moments = [];
  for (const still of ref.stills ?? []) {
    const stats = await imageStats(path.join(ref.folder, still.file), cache);
    moments.push({ ...still, stats, kind: pixelKind(stats) });
  }
  for (let index = moments.length - 1; index >= 0 && moments[index].kind === "type"; index -= 1) moments[index].kind = "end";
  return moments;
}

/** A board shot's kind from what it holds (shotKinds' context: name, prev, next, prevName, nextName, last). */
export function boardShotKind(shot, context = {}) {
  const media = mediaKind(shot?.media, context.name);
  if (media === "none") return context.last ? "end" : "type";
  const { kinds } = shotKinds(shot, context);
  if (kinds.includes("screen")) return "app";
  // A picture that is not an app (a logo, a wordmark): the end card when last, else a type frame.
  if (media === "still") return context.last ? "end" : kinds.includes("name") ? "type" : "footage";
  if (kinds.includes("device")) return "device";
  return "footage";
}

/** The kind of the edit's frame read from its pixels: a plain frame near the end is the end card. */
export const editPixelKind = (stats, share) => (stats.plain && share >= END_SHARE ? "end" : pixelKind(stats));

/**
 * The reference moment for one of the edit's moments: the same kind, nearest the same share of
 * the story, a still not used yet (`used`, a Set of "id@at") when there is one. `refs` carry
 * `moments` (referenceMoments). null when no saved reference has that kind.
 */
export function sameKindMoment(refs, kind, share, used = new Set()) {
  let best = null;
  for (const ref of refs) {
    const length = ref.seconds || ref.moments?.at(-1)?.at || 1;
    for (const moment of ref.moments ?? []) {
      if (moment.kind !== kind) continue;
      const distance = Math.abs(moment.at / length - share) + (used.has(`${ref.id}@${moment.at}`) ? 1 : 0);
      if (!best || distance < best.distance) best = { ref, moment, distance };
    }
  }
  return best;
}

/** The pair's gap lines: only where yours is clearly apart from theirs (hero fill, contrast). */
export function gapWords(yours, theirs) {
  const words = [];
  if (Math.abs(yours.fill - theirs.fill) >= FILL_GAP) words.push(`hero fills ${percent(yours.fill)} of the frame, theirs ${percent(theirs.fill)}`);
  const [low, high] = [Math.min(yours.contrast, theirs.contrast), Math.max(yours.contrast, theirs.contrast)];
  if (high - low >= CONTRAST_GAP && high >= low * CONTRAST_RATIO) words.push(`contrast ${yours.contrast}, theirs ${theirs.contrast}`);
  return words;
}

// The reference_drift rows that are craft that transfers (type size, motion, holds, cuts). Text
// share, text cards and shot likeness depend on what the footage shows, so versus leaves them out.
const CRAFT_ROWS = /^(big type on screen|text entrances word by word|camera still|camera moving|cuts in motion|longest still hold) /;
export const craftRow = (row) => CRAFT_ROWS.test(row);
