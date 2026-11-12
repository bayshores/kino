// Fair pairs for look {mode:"versus"}: like next to like. Each row is a moment of the edit beside
// a reference moment at the matching place in the video (pickRows, placeMoment):
//   the opening beside their opening, the loudest change (fit_music's heaviest song cue) beside
//   theirs (heard.change), the ending beside their ending, the rest by the same point of the story;
//   a shot whose board move pins a moment (move.ref "phone-film@3.13", judge.mjs pinnedPairs)
//   gets that moment on its own row only;
//   at a "place" row a moment of the same kind wins over a closer one of another kind (KIND_COST);
//   the opening, loudest change and ending rows lean to place (ROLE_KIND_SECONDS): their own title card shows;
//   no reference still fills more than ROWS_PER_STILL rows while another still can.
// Gap numbers are said only for pairs of the same kind (a street shot is never held to a UI shot)
// and for pinned pairs (the agent chose that like for like);
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
import { mediaPlaybackRange } from "../../engine/playback.js";
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

// ---- softness and accent ------------------------------------------------------------------
// Both are read from one copy of the frame with a fixed pixel count (SOFT_AREA, 640 x 360 at 16:9,
// the frame's own shape kept; each copy pixel the box average of the source pixels it covers), so
// a 640 px edit frame and a 1280 px one read alike, and a tall frame is not squeezed. A source
// smaller than the copy is read at its own size (not enlarged: that would read as soft). The
// studies found our frames sharper and our accent brighter than the references.
//   edge    how much of the frame's edge contrast sits at the 1 px scale, 0 to about 0.7, on the
//           luma copy L (0 to 1): sum |L - box1(L)| / sum |L - box3(L)| over the pixels where
//           |L - box3(L)| >= EDGE_GATE (edges only, so flat areas and faint grain do not count);
//           box1 and box3 are 3x3 and 7x7 box averages. A hard edge keeps much of its contrast
//           within a pixel and reads high; the same edge blurred spreads it over several and
//           reads low. Unlike a mean gradient it does not rise with how busy the picture is (a
//           soft frame full of rain streaks read sharper than a crisp flat graphic that way).
//           It needs about 640 px: at 320 px a 1080p blur of a few pixels is under a pixel.
//   accent  share of copy pixels that are bright (max channel at least ACCENT_LEVEL) and
//           saturated ((max - min) / max at least ACCENT_SATURATION).
//   peak    the brightest saturated region: the copy is cut into 16 x 9 cells (9 x 16 when tall),
//           a cell with at least ACCENT_CELL of its pixels saturated (any brightness) is a region,
//           and its level is the mean max channel of those pixels; peak is the best cell, 0 to 255.
// The levels are guesses from the studies' frames (a neon accent near 0.8 and up), not measurements.
const SOFT_AREA = 640 * 360;
const EDGE_GATE = 0.03;
const ACCENT_LEVEL = 0.8;
const ACCENT_SATURATION = 0.5;
const ACCENT_CELL = 0.25;
/** The long edge an edit frame is drawn at for these two measures (versus draws its tiles smaller). */
export const SOFT_EDGE = 640;

// A separable box average of radius r (edges average the pixels inside the frame).
function boxAverage(source, w, h, r) {
  const across = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k += 1) { sum += source[y * w + k]; n += 1; }
    across[y * w + x] = sum / n;
  }
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k += 1) { sum += across[k * w + x]; n += 1; }
    out[y * w + x] = sum / n;
  }
  return out;
}

/** {edge, accent, peak} of an image's RGBA pixels (see above); resolution does not change them much. */
export function softAccent(rgba, width, height) {
  const scale = Math.min(1, Math.sqrt(SOFT_AREA / (width * height)));
  const W = Math.max(8, Math.round(width * scale)), H = Math.max(8, Math.round(height * scale));
  const luma = new Float32Array(W * H);
  let bright = 0;
  const cellCols = W >= H ? 16 : 9, cellRows = W >= H ? 9 : 16, cellW = W / cellCols, cellH = H / cellRows;
  const saturated = new Uint32Array(cellCols * cellRows), levels = new Float32Array(cellCols * cellRows);
  for (let y = 0; y < H; y += 1) {
    const y0 = Math.floor((y * height) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / H));
    for (let x = 0; x < W; x += 1) {
      const x0 = Math.floor((x * width) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < height; sy += 1)
        for (let sx = x0; sx < x1 && sx < width; sx += 1) { const at = (sy * width + sx) * 4; r += rgba[at]; g += rgba[at + 1]; b += rgba[at + 2]; n += 1; }
      if (!n) continue;
      r /= n * 255; g /= n * 255; b /= n * 255;
      luma[y * W + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const high = Math.max(r, g, b), spread = high - Math.min(r, g, b);
      if (high > 0.2 && spread / high >= ACCENT_SATURATION) {
        const cell = Math.min(cellRows - 1, Math.floor(y / cellH)) * cellCols + Math.min(cellCols - 1, Math.floor(x / cellW));
        saturated[cell] += 1; levels[cell] += high;
        if (high >= ACCENT_LEVEL) bright += 1;
      }
    }
  }
  const fine = boxAverage(luma, W, H, 1), coarse = boxAverage(luma, W, H, 3);
  let fineSum = 0, coarseSum = 0;
  // 4 px in from the border, so the copy's own edge is not an edge.
  for (let y = 4; y < H - 4; y += 1)
    for (let x = 4; x < W - 4; x += 1) {
      const at = y * W + x, wide = Math.abs(luma[at] - coarse[at]);
      if (wide < EDGE_GATE) continue;
      fineSum += Math.abs(luma[at] - fine[at]); coarseSum += wide;
    }
  let peak = 0;
  for (let cell = 0; cell < saturated.length; cell += 1) if (saturated[cell] >= ACCENT_CELL * cellW * cellH) peak = Math.max(peak, levels[cell] / saturated[cell]);
  // edge is null for a frame with no edges at all (a flat card): it says nothing about softness.
  return { edge: coarseSum > 0 ? Math.round((fineSum / coarseSum) * 1000) / 1000 : null,
    accent: Math.round((bright / (W * H)) * 10000) / 10000, peak: Math.round(peak * 255) };
}

/** softAccent of an image file or buffer (an edit frame drawn at SOFT_EDGE, or a reference still). */
export async function imageSoftAccent(source) {
  const { pixels, width, height } = await decodeImage(source);
  return softAccent(pixels, width, height);
}

// Outside the references' range by more than EDGE_GAP (edge share), ACCENT_GAP (0.5% of the frame)
// or PEAK_GAP (16 of 255) (guesses). EDGE_GAP 0.02: read from two studies' frames on this scale,
// ours 0.44 to 0.48 where the softer references read 0.29 to 0.45 (glow-outline), ours 0.33 to 0.41
// beside references 0.30 to 0.37 that looked about as crisp (grade-bloom-flash).
const EDGE_GAP = 0.02;
const ACCENT_GAP = 0.005;
// The calls the lines name. Scene finish halation was tried first and did not move edge in a look
// frame (white type on dark, halation 0.3 and 1: edge 0.34 both); a layer blur did (edge 0.34 at
// blur 0 and 2, 0.275 at 4, 0.22 at 8, 1080p scene read at 640 px), so blur 3 is the start (a guess between).
const SOFTEN_CALL = 'blur the main picture a little (footage or its group, not the words), edit {ops:[{op:"update_layer", layer:"<picture layer>", properties:{blur:3}}]} (scene px at 1080p), then look versus again.';
const DIM_GLOW_CALL = 'lower the glow\'s strength (about half), edit {ops:[{op:"update_animation", animation:"<layer>.effect", properties:{to:{strength:0.6}}}]}.';
// Only the region is brighter: the accent's own color is (a glow's halo is dimmer than its core).
const DIM_COLOR_CALL = 'a darker accent color (about 60% of its brightness), edit {ops:[{op:"update_layer", layer:"<accent layer>", properties:{fill:"<darker color>"}}]} (stroke for a line).';
const PEAK_GAP = 16;
const middle = (values) => { const list = values.filter(Number.isFinite).sort((a, b) => a - b); return list.length ? list[Math.floor(list.length / 2)] : null; };
const spanOf = (values) => ({ low: Math.min(...values), high: Math.max(...values) });
const spanText = (low, high, show) => (low === high ? show(low) : `${show(low)} to ${show(high)}`);

/**
 * The softness and accent lines of look versus: the edit's frames (`mine`, stats with edge, accent
 * and peak) against each reference's (`refs`: arrays of stats, one array per reference; its median
 * counts). Each line shows the edit's number next to the references' range. Only when the edit is
 * outside the range does the line name the one call that moves it (too sharp: SOFTEN_CALL; too
 * bright an accent: a lower glow strength). A measure, never a gate. [] when either side has no frames.
 */
export function softAccentLines(mine, refs) {
  const own = mine.filter((stats) => Number.isFinite(stats?.accent));
  const theirs = refs.map((list) => list.filter((stats) => Number.isFinite(stats?.accent))).filter((list) => list.length);
  if (!own.length || !theirs.length) return [];
  const pick = (list, key) => middle(list.map((stats) => stats[key]));
  const ours = { edge: pick(own, "edge"), accent: pick(own, "accent"), peak: pick(own, "peak") };
  // A reference whose stills have no edges at all (flat cards) has no softness to compare.
  const range = (key) => { const values = theirs.map((list) => pick(list, key)).filter(Number.isFinite); return values.length ? spanOf(values) : null; };
  const [edge, accent, peak] = [range("edge"), range("accent"), range("peak")];
  const n = theirs.length, whose = `${n} saved reference${n === 1 ? "" : "s"}`;
  const lines = [];
  if (edge && ours.edge !== null) {
    const sharper = ours.edge > edge.high + EDGE_GAP, softer = ours.edge < edge.low - EDGE_GAP;
    lines.push(`softness: edge sharpness ${ours.edge.toFixed(2)} (share of edge contrast within 1 px, 640x360 luma copy), your ${whose} ${spanText(edge.low, edge.high, (value) => value.toFixed(2))}${sharper ? `: sharper than theirs. One call: ${SOFTEN_CALL}`
      : softer ? ": softer than theirs." : ": inside their range."}`);
  } else lines.push(`softness: not compared, ${ours.edge === null ? "your frames have" : `your ${whose} have`} no edges (flat frames).`);
  const wider = ours.accent > accent.high + ACCENT_GAP, brighter = wider || ours.peak > peak.high + PEAK_GAP;
  const dimmer = ours.accent < accent.low - ACCENT_GAP && ours.peak < peak.low - PEAK_GAP;
  const pct = (value) => `${Math.round(value * 1000) / 10}%`;
  lines.push(`accent: ${pct(ours.accent)} of the frame bright and saturated, brightest saturated region ${ours.peak} of 255; your ${whose} ${spanText(accent.low, accent.high, pct)}, region ${spanText(peak.low, peak.high, String)}${brighter ? `: brighter than theirs. One call: ${wider ? DIM_GLOW_CALL : DIM_COLOR_CALL}`
    : dimmer ? ": quieter than theirs." : ": inside their range."}`);
  return lines;
}

/** Plain numbers from an image's RGBA pixels: {plain, skin, flat, sharp, fill, contrast, edge, accent, peak}. */
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
    sharp: Math.round(stats.sharp), fill: round(hero / count), contrast: cellContrast(means), ...softAccent(rgba, width, height) };
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
// Another kind at a "place" row costs this share of the story: a same-kind moment up to this much
// farther from the place wins. The opening, loudest change and ending cost only ROLE_KIND_SECONDS
// of the reference (at most this), so their own title card or end card is on the sheet.
const KIND_COST = 0.2;
const ROLE_KIND_SECONDS = 1.5;
// A still used once costs this much more, so rows spread over the stills (less than KIND_COST, so
// a same-kind still used once still beats another kind); past ROWS_PER_STILL, FULL.
const USED_COST = 0.1;
const FULL = 100;
// A label of what is on screen belongs to a still within this many seconds (stills are 1 s apart).
const SEEN_NEAR = 1;
// The words of a label said under a pair, at most this many characters.
const SEEN_WORDS = 40;
const SONG_CUE = /^song-(.+)-\d+$/;
// A loudest change inside the opening or ending shot is its own row when this far (s) from that shot's frame.
const PEAK_APART = 1;

/** The edit's loudest change in seconds: its heaviest song cue (fit_music's song-<kind>-<n>, not the intro or outro, as reference_range and heard.change), or null. */
export function editLoudest(cues) {
  let best = null;
  for (const cue of cues ?? []) {
    const kind = SONG_CUE.exec(String(cue?.name ?? ""))?.[1];
    if (!kind || ["intro", "outro"].includes(kind) || !Number.isFinite(cue.time) || !Number.isFinite(cue.weight)) continue;
    if (!best || cue.weight > best.weight || (cue.weight === best.weight && cue.time < best.time)) best = cue;
  }
  return best ? best.time : null;
}

/**
 * The loudest change of an edit cut without fit_music, in video seconds, or null: each music layer's
 * saved song shape (`shapeOf(layer)` gives {sections} or null) has its played section with the most
 * weight (not the intro or outro), as reference_range reads it (quality.mjs heardSpeech); the
 * earliest of those. `scenes` are in video order.
 */
export async function shapeLoudest(scenes, shapeOf) {
  let offset = 0, best = null;
  for (const scene of scenes) {
    for (const layer of scene.layers ?? []) {
      if ((layer.type !== "audio" && layer.type !== "video") || !layer.src || layer.enabled === false) continue;
      if (!(Number(layer.volume ?? 1) > 0 || (layer.animations ?? []).some((animation) => animation?.to && "volume" in animation.to))) continue;
      const shape = await Promise.resolve().then(() => shapeOf(layer)).catch(() => null);
      const range = shape ? mediaPlaybackRange(layer, scene.duration) : null;
      if (!range || range.remapped) continue;
      const top = (shape.sections ?? []).filter((part) => part.kind !== "intro" && part.kind !== "outro" && Number.isFinite(part.weight) && part.at > range.offset && part.at < range.offset + range.duration)
        .sort((a, b) => b.weight - a.weight || a.at - b.at)[0];
      const time = top ? offset + range.start + top.at - range.offset : null;
      if (time !== null && (best === null || time < best)) best = time;
    }
    offset += scene.duration;
  }
  return best === null ? null : round(best);
}

const refLength = (ref) => ref.seconds || ref.moments?.at(-1)?.at || 1;
/** A reference's loudest change in seconds (heard.change.at, measured when saved), or null. */
export const refLoudest = (ref) => (Number.isFinite(ref?.heard?.change?.at) ? ref.heard.change.at : null);

/**
 * The rows to pair, at most `most` of the edit's `moments` ([{start, end, at}] in time order: board
 * shots, or points of the story): the first (role "opening"), the one holding the loudest change
 * `peak` (seconds; "peak"), the last ("ending"), the `keep` ones (pinned shots, "place"), then
 * the rest spread over the video (each the farthest from those taken). In time order. The opening
 * and the ending always keep their row: a loudest change inside one of them is a further row of
 * the same moment ({extra: true}) when it is at least PEAK_APART s from the moment's own frame.
 */
export function pickRows(moments, most, { peak = null, keep = [] } = {}) {
  const taken = new Map();
  let limit = most;
  const take = (moment, role) => { if (moment && taken.size < limit && !taken.has(moment)) taken.set(moment, role); };
  take(moments[0], "opening");
  if (moments.length > 1) take(moments.at(-1), "ending");
  let extra = null;
  if (Number.isFinite(peak)) {
    const holding = moments.find((moment) => moment.start <= peak && peak < moment.end)
      ?? moments.reduce((best, moment) => (!best || Math.abs(moment.at - peak) < Math.abs(best.at - peak) ? moment : best), null);
    if (holding && !taken.has(holding)) take(holding, "peak");
    else if (holding && taken.size < most && Math.abs(holding.at - peak) >= PEAK_APART) { extra = { ...holding, role: "peak", extra: true }; limit = most - 1; }
  }
  for (const moment of keep) take(moment, "place");
  while (taken.size < Math.min(limit, moments.length)) {
    let best = null, far = -1;
    for (const moment of moments) {
      if (taken.has(moment)) continue;
      const gap = Math.min(...[...taken.keys()].map((other) => Math.abs(other.at - moment.at)));
      if (gap > far) { best = moment; far = gap; }
    }
    take(best, "place");
  }
  const rows = moments.filter((moment) => taken.has(moment)).map((moment) => ({ ...moment, role: taken.get(moment) }));
  return extra ? [...rows, extra].sort((a, b) => (a.extra ? peak : a.at) - (b.extra ? peak : b.at)) : rows;
}

/**
 * The reference moment for one row of the edit ({kind, role, share}): the moment nearest the same
 * place in a reference (its opening, its loudest change, its ending, else the same share of the
 * story), a moment of the same kind first (KIND_COST), a still used on fewer rows first (`uses`, a
 * Map "id@at" to rows). `refs` carry `moments` (referenceMoments). {ref, moment, same, byPlace}
 * or null when no reference has a still; byPlace when a "peak" row's reference has no loudest change.
 */
export function placeMoment(refs, { kind, role = "place", share }, uses = new Map()) {
  let best = null, kindStills = 0, kindOpen = 0;
  for (const ref of refs) {
    const length = refLength(ref);
    const loudest = refLoudest(ref);
    const target = role === "opening" ? 0 : role === "ending" ? 1 : role === "peak" && loudest !== null ? loudest / length : share;
    // Another kind costs little on the opening, loudest change and ending rows: place wins there.
    const kindCost = role === "place" ? KIND_COST : Math.min(KIND_COST, ROLE_KIND_SECONDS / length);
    for (const moment of ref.moments ?? []) {
      const count = uses.get(`${ref.id}@${moment.at}`) ?? 0;
      const same = moment.kind === kind;
      if (same) { kindStills += 1; if (count < ROWS_PER_STILL) kindOpen += 1; }
      // The still that shows the loudest change is the first at or after it.
      const off = role === "peak" && loudest !== null && moment.at < loudest ? (loudest - moment.at) / length + 0.01 : Math.abs(moment.at / length - target);
      const distance = off + (same ? 0 : kindCost) + (count >= ROWS_PER_STILL ? FULL : count * USED_COST);
      if (!best || distance < best.distance) best = { ref, moment, distance, same, byPlace: role === "peak" && loudest === null };
    }
  }
  // Why another kind was used: "none" (no reference has that kind), "full" (its stills are on
  // ROWS_PER_STILL rows already), else "far" (the nearest is farther than another kind).
  return best && { ...best, otherWhy: best.same ? null : !kindStills ? "none" : !kindOpen ? "full" : "far" };
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
      match: found.same ? "kind" : "place", same: found.same, otherWhy: found.otherWhy, byPlace: found.byPlace, seen: seenAt(found.ref, found.moment.at), full });
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
