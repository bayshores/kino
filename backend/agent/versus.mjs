// Fair pairs for look {mode:"versus"}: like next to like. Each row is a moment of the edit beside
// a reference moment at the matching place in the video (pickRows, placeMoment):
//   the opening beside their opening, the loudest change (fit_music's heaviest song cue) beside
//   theirs (heard.change), the ending beside their ending, the rest by the same point of the story;
//   a shot whose board move pins a moment (move.ref "phone-film@3.13", judge.mjs pinnedPairs)
//   gets that moment on its own row only;
//   at that place a moment of the same kind wins over a closer one of another kind (KIND_COST);
//   no reference still fills more than ROWS_PER_STILL rows while another still can.
// Gap numbers are said only for pairs of the same kind (a street shot is never held to a UI shot);
// under each pair, the reference's labels of what is on screen there (seenAt) when it has them.
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
import { CONTRAST_GAP, CONTRAST_RATIO, cellContrast, frameContrast } from "../../engine/quality/motionPixels.js";
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
  let flat = 0, hero = 0;
  const means = [];
  const busyRows = new Set();
  for (let cell = 0; cell < count; cell += 1) {
    if (spread(cell) < FLAT) flat += 1; else busyRows.add(Math.floor(cell / CELL_COLS));
    if (spread(cell) >= FLAT || Math.abs(mean(cell) - background) >= 0.1) hero += 1;
    means.push(mean(cell));
  }
  let skin = 0, sampled = 0;
  for (let at = 0; at < rgba.length; at += 4 * 37) {
    const r = rgba[at], g = rgba[at + 1], b = rgba[at + 2];
    sampled += 1;
    if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15 && r - Math.min(g, b) > 15) skin += 1;
  }
  return { plain: busyRows.size <= PLAIN_ROWS || flat / count >= PLAIN_SHARE, skin: round(skin / Math.max(1, sampled)), flat: round(flat / count),
    sharp: Math.round(stats.sharp), fill: round(hero / count), contrast: cellContrast(means) };
}

/** A frame's kind from its stats: type (plain), footage (people) or app; "end" is decided by its place. */
export function pixelKind(stats) {
  if (stats.plain) return "type";
  if (stats.skin >= SKIN) return "footage";
  return stats.flat >= APP_FLAT || stats.sharp >= APP_SHARP ? "app" : "footage";
}

// An image file or buffer as RGBA pixels, at most 640 px wide: {pixels, width, height}.
async function decodeImage(source) {
  const image = await loadImage(source);
  const width = Math.min(640, image.width), height = Math.max(2, Math.round((image.height * width) / image.width));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return { pixels: context.getImageData(0, 0, width, height).data, width, height };
}

/** The contrast (0 to 1) of an image file, as the checks measure a frame (null when it cannot be read). */
export async function imageContrast(source) {
  try { return frameContrast(await decodeImage(source)); } catch { return null; }
}

/** The stats of an image file or buffer (`cache`, a Map, keeps a file's). */
export async function imageStats(source, cache = null) {
  const key = typeof source === "string" ? source : null;
  if (key && cache?.has(key)) return cache.get(key);
  const { pixels, width, height } = await decodeImage(source);
  const stats = frameStats(pixels, width, height);
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

// A reference still shows on at most this many rows while another still can take the row.
export const ROWS_PER_STILL = 2;
// Another kind at the place costs this share of the story: a same-kind moment up to this much
// farther from the place wins.
const KIND_COST = 0.2;
// A still used once costs this much more, so rows spread over the stills; past ROWS_PER_STILL, FULL.
const USED_COST = 0.5;
const FULL = 100;
// A label of what is on screen belongs to a still within this many seconds (stills are 1 s apart).
const SEEN_NEAR = 1;
// The words of a label said under a pair, at most this many characters.
const SEEN_WORDS = 40;
const SONG_CUE = /^song-(.+)-\d+$/;

/** The edit's loudest change in seconds: its heaviest song cue (fit_music's song-<kind>-<n>, not the intro, outro or ending), or null. */
export function editLoudest(cues) {
  let best = null;
  for (const cue of cues ?? []) {
    const kind = SONG_CUE.exec(String(cue?.name ?? ""))?.[1];
    if (!kind || ["intro", "outro", "ending", "fade"].includes(kind) || !Number.isFinite(cue.time) || !Number.isFinite(cue.weight)) continue;
    if (!best || cue.weight > best.weight || (cue.weight === best.weight && cue.time < best.time)) best = cue;
  }
  return best ? best.time : null;
}

const refLength = (ref) => ref.seconds || ref.moments?.at(-1)?.at || 1;
/** A reference's loudest change in seconds (heard.change.at, measured when saved), or null. */
export const refLoudest = (ref) => (Number.isFinite(ref?.heard?.change?.at) ? ref.heard.change.at : null);

/**
 * The rows to pair, at most `most` of the edit's `moments` ([{start, end, at}] in time order: board
 * shots, or points of the story): the first (role "opening"), the one holding the loudest change
 * `peak` (seconds; "peak"), the last ("ending"), the `keep` ones (pinned shots, "place"), then
 * the rest spread over the video (each the farthest from those taken). In time order.
 */
export function pickRows(moments, most, { peak = null, keep = [] } = {}) {
  const taken = new Map();
  const take = (moment, role) => { if (moment && taken.size < most && !taken.has(moment)) taken.set(moment, role); };
  take(moments[0], "opening");
  if (Number.isFinite(peak)) {
    const holding = moments.find((moment) => moment.start <= peak && peak < moment.end)
      ?? moments.reduce((best, moment) => (!best || Math.abs(moment.at - peak) < Math.abs(best.at - peak) ? moment : best), null);
    if (holding && !taken.has(holding)) take(holding, "peak");
  }
  if (moments.length > 1) take(moments.at(-1), "ending");
  for (const moment of keep) take(moment, "place");
  while (taken.size < Math.min(most, moments.length)) {
    let best = null, far = -1;
    for (const moment of moments) {
      if (taken.has(moment)) continue;
      const gap = Math.min(...[...taken.keys()].map((other) => Math.abs(other.at - moment.at)));
      if (gap > far) { best = moment; far = gap; }
    }
    take(best, "place");
  }
  return moments.filter((moment) => taken.has(moment)).map((moment) => ({ ...moment, role: taken.get(moment) }));
}

/**
 * The reference moment for one row of the edit ({kind, role, share}): the moment nearest the same
 * place in a reference (its opening, its loudest change, its ending, else the same share of the
 * story), a moment of the same kind first (KIND_COST), a still used on fewer rows first (`uses`, a
 * Map "id@at" to rows). `refs` carry `moments` (referenceMoments). {ref, moment, same, byPlace}
 * or null when no reference has a still; byPlace when a "peak" row's reference has no loudest change.
 */
export function placeMoment(refs, { kind, role = "place", share }, uses = new Map()) {
  let best = null;
  for (const ref of refs) {
    const length = refLength(ref);
    const loudest = refLoudest(ref);
    const target = role === "opening" ? 0 : role === "ending" ? 1 : role === "peak" && loudest !== null ? loudest / length : share;
    for (const moment of ref.moments ?? []) {
      const count = uses.get(`${ref.id}@${moment.at}`) ?? 0;
      const same = moment.kind === kind;
      // The still that shows the loudest change is the first at or after it.
      const off = role === "peak" && loudest !== null && moment.at < loudest ? (loudest - moment.at) / length + 0.01 : Math.abs(moment.at / length - target);
      const distance = off + (same ? 0 : KIND_COST) + (count >= ROWS_PER_STILL ? FULL : count * USED_COST);
      if (!best || distance < best.distance) best = { ref, moment, distance, same, byPlace: role === "peak" && loudest === null };
    }
  }
  return best;
}

/**
 * The pairs of look versus: each of the edit's rows (pickRows' rows with {kind, at, pin?}; `pin`, a
 * pinnedPairs pair, when its shot pins a moment) beside a reference moment of `refs` (which carry
 * `moments`), in a video `total` s long. Pins go first (at most ROWS_PER_STILL rows a still: a
 * further shot pinning it is placed like any row), then the opening, loudest change and ending,
 * then the rest. Each pair gets n, ref, refAt, still, match ("pinned", "kind" when the same kind,
 * "place" when another kind, "none" with no still), same, theirs (the still's stats) and seen.
 */
export function pairRows(slots, refs, total) {
  const uses = new Map();
  const use = (key) => uses.set(key, (uses.get(key) ?? 0) + 1);
  const order = (slot) => (slot.pin ? 0 : slot.role === "place" ? 2 : 1);
  const pairs = [];
  for (const slot of [...slots].sort((a, b) => order(a) - order(b) || a.at - b.at)) {
    const pinKey = slot.pin ? `${slot.pin.ref}@${slot.pin.refAt}` : null;
    if (pinKey && (uses.get(pinKey) ?? 0) < ROWS_PER_STILL) {
      use(pinKey);
      const ref = refs.find((entry) => entry.id === slot.pin.ref);
      const moment = ref?.moments?.find((entry) => entry.at === slot.pin.refAt);
      pairs.push({ ...slot, ref: slot.pin.ref, refAt: slot.pin.refAt, still: slot.pin.still, pinned: slot.pin.pinned, ...(slot.pin.far ? { far: slot.pin.far } : {}),
        match: "pinned", same: Boolean(moment && moment.kind === slot.kind), theirs: moment?.stats, seen: seenAt(ref, slot.pin.refAt) });
      continue;
    }
    const full = pinKey ? `${slot.pin.pinned} is on ${ROWS_PER_STILL} rows already, placed by position` : null;
    const found = placeMoment(refs, { kind: slot.kind, role: slot.role, share: slot.at / total }, uses);
    if (!found) { pairs.push({ ...slot, ref: null, refAt: null, still: null, match: "none", same: false, full }); continue; }
    use(`${found.ref.id}@${found.moment.at}`);
    pairs.push({ ...slot, ref: found.ref.id, refAt: found.moment.at, still: path.join(found.ref.folder, found.moment.file), theirs: found.moment.stats,
      match: found.same ? "kind" : "place", same: found.same, byPlace: found.byPlace, seen: seenAt(found.ref, found.moment.at), full });
  }
  pairs.sort((a, b) => a.at - b.at).forEach((pair, index) => { pair.n = index + 1; });
  return pairs;
}

/**
 * What the reference shows on screen near `at` seconds, from its saved labels (`seen`: [{at, kinds,
 * words}], absent on older references): "type, overlay \"WORDS\"", or null without a label there.
 */
export function seenAt(ref, at) {
  if (!Array.isArray(ref?.seen) || !Number.isFinite(at)) return null;
  let best = null;
  for (const entry of ref.seen) {
    if (!Number.isFinite(entry?.at) || Math.abs(entry.at - at) > SEEN_NEAR) continue;
    if (!best || Math.abs(entry.at - at) < Math.abs(best.at - at)) best = entry;
  }
  if (!best) return null;
  const kinds = (Array.isArray(best.kinds) ? best.kinds : []).filter((kind) => typeof kind === "string" && kind).map((kind) => (kind === "plain" ? "plain footage" : kind));
  const words = String(best.words ?? "").replace(/\s+/g, " ").trim().replaceAll('"', "'");
  const said = words ? `"${words.length > SEEN_WORDS ? `${words.slice(0, SEEN_WORDS - 3)}...` : words}"` : "";
  return [kinds.join(", "), said].filter(Boolean).join(" ") || null;
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
