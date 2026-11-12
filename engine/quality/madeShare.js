// How much of a scene is designed, as a fact beside the returns line (check, status). Never a rule, a
// warning or a target: the agent sees its own number, and the saved references' labels where they have them.
//
// madeTime (the printed line) reads every sampled frame: the share of the time and of the frame area
// that the edit made. madeShare and madeMoments (match_references made) count half-second moments with a
// made element: a cut-out, a drawn graphic or shape (referenceKinds' "made"), a particle overlay, or
// designed type (a reading text at 8% of the frame height or more that is not a caption or a spoken line).
// Until 2026-11-12 the line printed that moment count: one caption pill or one cut-out over its own clip
// made a whole half second "made" (93% printed on a cut where 16% of the time was made).
import { PARTICLE_LOOKS } from "../effects/particles.js";
import { designedTexts, drawnSize, speechTimed } from "./analysis.js";
import { area, frameAt, intersection, visibleBoxAt } from "./model.js";
import { onscreenKinds } from "./rules/referenceKinds.js";

const SHOWN = 0.5;
// Type this large (share of the frame height) is designed, not a subtitle (typeSignature's "title" size).
const DESIGNED_TYPE = 0.08;
const PARTICLES = new Set(Object.keys(PARTICLE_LOOKS).filter((key) => key !== "light-leaks"));
const SUBTITLE_ROLES = new Set(["caption", "speech"]);
const on = (entry, time) => (entry.holdBefore || entry.start <= time) && (entry.holdAfter || time <= entry.end);

/**
 * { moments, made, parts: {cutout, graphic, particle, type} } for a quality model: `moments` half
 * seconds in all, `made` of them with a made element, and `parts` how many moments each kind shows.
 * `graphic` is the same measure as a reference's "made" label (library inspire seen).
 */
export function madeShare(model) {
  const { moments, made, parts } = madeMoments(model);
  return { moments: moments.length, made, parts };
}

/** madeShare with each moment: {moments: [{time, made}], made, parts}. */
export function madeMoments(model) {
  const moments = onscreenKinds(model);
  const flags = [];
  // designedTexts leaves out add_captions' text and its hook line; a role of caption or speech is a subtitle too.
  const designed = designedTexts(model).filter((item) => !SUBTITLE_ROLES.has(item.role) && drawnSize(model, item) >= DESIGNED_TYPE * model.height);
  const cutouts = model.items.filter((item) => item.cutoutOf && !item.isMask);
  const parts = { cutout: 0, graphic: 0, particle: 0, type: 0 };
  let made = 0;
  for (const moment of moments) {
    const index = frameAt(model, moment.time);
    const shown = (item) => (item.samples.opacity[index] ?? 0) >= SHOWN;
    const has = {
      cutout: cutouts.some(shown),
      graphic: moment.kinds.has("made"),
      particle: (model.effects ?? []).some((entry) => PARTICLES.has(entry.effect) && on(entry, moment.time) && (model.itemOf(entry.itemId)?.samples.opacity[index] ?? 0) > 0.05),
      type: designed.some(shown),
    };
    for (const key of Object.keys(parts)) if (has[key]) parts[key] += 1;
    const any = Object.values(has).some(Boolean);
    if (any) made += 1;
    flags.push({ time: moment.time, made: any });
  }
  return { moments: flags, made, parts };
}

/**
 * The saved references' own measure of the same thing: each labeled moment that names "made" counts
 * (library inspire seen). Only references with labels are listed: [{id, made, total}]. With
 * `composite`, a moment labeled composite (a cut-out, which madeShare counts as made) counts too.
 */
export function referenceMade(refs, { composite = false } = {}) {
  const counts = (entry) => (entry.kinds ?? []).includes("made") || (composite && (entry.kinds ?? []).includes("composite"));
  return (refs ?? []).filter((ref) => Array.isArray(ref.seen) && ref.seen.length).map((ref) => ({ id: ref.id, made: ref.seen.filter(counts).length, total: ref.seen.length }));
}

const percent = (made, total) => (total ? Math.round((made / total) * 100) : 0);

// By screen time and frame area (madeTime). The frame is read on a grid of cells; a layer covers the
// cells whose centers it holds (48 by 27 cells: 40 px at 1920 wide).
const GRID_X = 48, GRID_Y = 27;
// A guess, not measured: particles and drawn lines (speed lines, impact lines) ink about a quarter of the
// layer box they are drawn over. Their time counts in full; only their area is weighed by this.
const SPARSE_INK = 0.25;
// Effects that grade or clean a picture: a cut-out carrying only these still shows its source as it was.
const CLEANUP = new Set(["deblock", "grain", "sharpen", "denoise", "curves", "lut", "color-grade", "color-look", "white-balance", "hue-saturation", "color-wheels", "exposure"]);
const DRAWN = new Set(["speed-lines", "impact-lines", "film-burn", "lightning"]);
const BAR_EDGE = 2;
export const MADE_KINDS = Object.freeze(["type", "graphic", "cutout", "particle", "matte"]);

// The ids of caption texts (add_captions, keep_line, a caption or speech role) and the painted
// groups and plates around them (a caption pill counts as the caption, never as a made graphic).
function captionIds(model) {
  const ids = new Set(speechTimed(model));
  const byId = new Map(model.items.map((item) => [item.id, item]));
  for (const item of model.items) {
    if (item.kind !== "text" || !SUBTITLE_ROLES.has(item.role)) continue;
    for (let current = item; current && !ids.has(current.id); current = byId.get(current.parentId)) ids.add(current.id);
    ids.add(item.id);
  }
  return ids;
}

const isBar = (model, box) => {
  const wide = box.x1 - box.x0 >= 0.95 * model.width && (box.y0 <= BAR_EDGE || box.y1 >= model.height - BAR_EDGE);
  const tall = box.y1 - box.y0 >= 0.95 * model.height && (box.x0 <= BAR_EDGE || box.x1 >= model.width - BAR_EDGE);
  return wide || tall;
};

const subjectBoxAt = (item, index) => {
  const subject = item.samples.subject;
  return subject ? { x0: subject.x0[index], y0: subject.y0[index], x1: subject.x1[index], y1: subject.y1[index] } : null;
};

/**
 * The made share by screen time and frame area, read at every sampled frame: {frames, fps, time,
 * area, kinds: {type, graphic, cutout, particle, matte} (shares of the time), caption: {time, area}}.
 * Made: lettering that is not a caption, drawn shapes and paths (not a letterbox bar, not the
 * background), every layer a move placed (an impact plate, a word panel, an aura's tongues), a
 * cut-out on a new plate (its own clip hidden under it) or with a look on it, particles and drawn
 * overlays, and footage shown only through lettering (a matte). Imported footage and found clips
 * never count, whatever they show; a caption and its pill count under caption.
 */
export function madeTime(model) {
  const frames = model.times?.length ?? 0;
  const out = { frames, fps: model.fps, time: 0, area: 0, kinds: Object.fromEntries(MADE_KINDS.map((kind) => [kind, 0])), caption: { time: 0, area: 0 } };
  if (!frames) return out;
  const captions = captionIds(model);
  const effects = model.effects ?? [];
  const byId = new Map(model.items.map((item) => [item.id, item]));
  const cellW = model.width / GRID_X, cellH = model.height / GRID_Y;
  const made = new Float32Array(GRID_X * GRID_Y), said = new Float32Array(GRID_X * GRID_Y);
  const paint = (grid, box, weight) => {
    if (!box) return;
    const fromX = Math.max(0, Math.ceil(box.x0 / cellW - 0.5)), toX = Math.min(GRID_X - 1, Math.floor(box.x1 / cellW - 0.5));
    const fromY = Math.max(0, Math.ceil(box.y0 / cellH - 0.5)), toY = Math.min(GRID_Y - 1, Math.floor(box.y1 / cellH - 0.5));
    for (let y = fromY; y <= toY; y += 1) for (let x = fromX; x <= toX; x += 1) grid[y * GRID_X + x] = Math.max(grid[y * GRID_X + x], weight);
  };
  const sum = (grid) => grid.reduce((total, value) => total + value, 0) / grid.length;
  const counts = Object.fromEntries(MADE_KINDS.map((kind) => [kind, 0]));
  let madeFrames = 0, madeArea = 0, captionFrames = 0, captionArea = 0;
  for (let index = 0; index < frames; index += 1) {
    const time = model.times[index];
    made.fill(0); said.fill(0);
    const has = new Set();
    let captioned = false;
    const fxOn = (item) => effects.filter((entry) => entry.itemId === item.id && on(entry, time));
    for (const item of model.items) {
      if (item.isMask || item.sceneBackground || item.role === "background" || (item.samples.opacity[index] ?? 0) < SHOWN) continue;
      const box = visibleBoxAt(model, item, index);
      if (captions.has(item.id)) {
        if (item.kind === "text" || item.painted) { captioned = true; paint(said, box, 1); }
        continue;
      }
      const live = fxOn(item);
      const sparse = live.find((entry) => PARTICLES.has(entry.effect)) ? "particle" : live.find((entry) => DRAWN.has(entry.effect)) ? "graphic" : null;
      if (sparse) { has.add(sparse); paint(made, box, SPARSE_INK); }
      const placed = item.move && item.role === "decor";
      let kind = null, own = box;
      if (item.kind === "text") kind = "type";
      else if (item.kind === "video" || item.kind === "image") {
        if (item.cutoutOf) {
          const source = byId.get(item.cutoutOf);
          const newPlate = !source || (source.samples.opacity[index] ?? 0) <= 0.05;
          if (placed || newPlate || live.some((entry) => !CLEANUP.has(entry.effect))) { kind = "cutout"; own = subjectBoxAt(item, index) ?? box; }
        } else if (item.maskId && byId.get(item.maskId)?.kind === "text") kind = "matte";
      } else if (item.painted && (placed || (area(intersection(box, { x0: 0, y0: 0, x1: model.width, y1: model.height })) < 0.9 * model.width * model.height && !isBar(model, box)))) kind = "graphic";
      if (kind) { has.add(kind); paint(made, own, 1); }
    }
    if (has.size) madeFrames += 1;
    for (const kind of has) counts[kind] += 1;
    madeArea += sum(made);
    if (captioned) captionFrames += 1;
    captionArea += sum(said);
  }
  out.time = madeFrames / frames;
  out.area = madeArea / frames;
  for (const kind of MADE_KINDS) out.kinds[kind] = counts[kind] / frames;
  out.caption = { time: captionFrames / frames, area: captionArea / frames };
  return out;
}

const pct = (share) => `${Math.round(share * 100)}%`;

/**
 * One line: `made: 16% of the time, 4% of the frame area (420 frames at 30 fps; footage and found clips
 * never count; by time: cutout 10%, type 5%) · captions (not made): 51% of the time, 3% of the area ·
 * deck: 6 of 8 cards unused (a, b, ...) · your 2 references' made labels by eye: 2 of 6 moments (33%),
 * 5 of 6 (83%) (a time share, no area)`. `own` is madeTime's; `deck` is {used, unused} (engine/deck.js
 * deckUse), left out with none; `refs` is referenceMade's list.
 */
export function madeLine(own, { refs = [], deck = null } = {}) {
  if (!own?.frames) return "";
  const kinds = MADE_KINDS.filter((kind) => own.kinds[kind] > 0).map((kind) => `${kind} ${pct(own.kinds[kind])}`);
  const head = `made: ${pct(own.time)} of the time, ${pct(own.area)} of the frame area (${own.frames} frames at ${own.fps} fps; footage and found clips never count; ${kinds.length ? `by time: ${kinds.join(", ")}` : "no lettering, drawn graphic, cut-out on a new plate, particle or matte"})`;
  const said = own.caption.time > 0 ? ` · captions (not made): ${pct(own.caption.time)} of the time, ${pct(own.caption.area)} of the area` : "";
  const used = deck?.used ?? [], unused = deck?.unused ?? [];
  const cards = used.length + unused.length ? ` · deck: ${unused.length} of ${used.length + unused.length} cards unused${unused.length ? ` (${unused.slice(0, 8).join(", ")}${unused.length > 8 ? ", ..." : ""})` : ""}` : "";
  const beside = refs.length ? ` · your ${refs.length} reference${refs.length === 1 ? "'s" : "s'"} made labels by eye: ${refs.map((ref, at) => `${ref.made} of ${ref.total}${at ? "" : " moments"} (${percent(ref.made, ref.total)}%)`).join(", ")} (a time share, no area)` : "";
  return `${head}${said}${cards}${beside}`;
}
