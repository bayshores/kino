// match_references' made part (the edit op, made:true or a list): places the made techniques the
// saved references' labels name (library inspire seen: "made, overlay: embers rise round him") on
// the scene's shots, the way their labels read through seen-names.mjs. With no labeled reference it
// places the deck's unused cards instead. Why: two test edits called match_references and got
// exposure grades only; their references were mostly made (24 to 89% of moments) and the edits 0 to
// 10% (.scratch/dm2 qc-2, five things row 5).
//
// Where: song cues first (fit_music's song-* markers, a drop before the rest), then shots whose
// subject is marked (mark_subject) or whose file has a face kino found, then the longest shots; a
// hand-off (overexpose, smear) goes on a cut between two shots, a song cue's cut first. How often:
// every technique once a round, as many rounds as the references show it; then, with labeled
// references, more particle and splatter placements until the made share reaches the references'
// own (the median of their labels' made share) or no shot is left.
// Values, each printed with where it came from: colors from the label's own color words, else the
// reference's strip frame nearest the label's time, else the shot under the element (its main and
// accent colors), else a starting guess; a splatter's size and place from the shot's marked subject
// box (beside, above or below it, on the side with the most room, never over it); a duration from
// the shot's cut or the next song cue, whichever comes first. Overexposes stay a second apart (the
// flashing check allows three flashes a second). A composite label puts a background under a cut-out
// that already exists; with none, it is a ready call (cut_out takes up to a minute).
// Every op is ordinary (add_animation, add_layer, move) with an id that starts match-made-, so
// update_animation or update_layer changes it, sending the op again replaces them and remove:true
// takes them off.
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { plates } from "../../engine/quality/techniques.js";
import { area, insideShare, visibleBoxAt } from "../../engine/quality/model.js";
import { madeMoments, referenceMade } from "../../engine/quality/madeShare.js";
import { mainScene } from "../../engine/board.js";
import { madeNamesIn } from "../../engine/deck.js";
import { round } from "../../engine/numbers.js";
import { mediaFrameState } from "../../engine/playback.js";
import { seenNameList } from "./seen-names.mjs";

export const MADE_PREFIX = "match-made-";
// The label kinds that name a made picture (spoken, plain and type labels do not).
const MADE_KINDS = new Set(["made", "overlay", "composite", "color", "frame"]);
// Names read from one label: its first two that kino can place (a label lists its main look first).
const PER_LABEL = 2;

// What kino lays on a shot in one op, by name: an effect on the shot's layer (particles, light and
// drawn overlays), a path (splatter), a move, or a duotone in the label's colors (recolor).
const EFFECTS = new Set(["glow", "embers", "sparks", "bokeh", "dust", "snow", "rain", "fog", "streaks", "light-leaks", "speed-lines", "impact-lines", "film-burn", "lightning", "edge-lines", "light-rays", "lens-flare", "vignette", "duotone", "tritone", "rgb-shift"]);
const MOVES = new Set(["light-sweep", "overexpose", "smear", "split-fields"]);
// Moves that hand one shot to the next: they go on a cut (overexpose may go on one shot alone).
const HANDOFFS = new Set(["overexpose", "smear"]);
const LAYERS = new Set(["splatter"]);
const RECOLOR = "recolor";
// Techniques that need a subject cut-out first (up to a minute: CUTOUT_RUNNING would refuse the
// edit), so they get a ready call on a subject shot instead.
const CUTOUT = new Set(["cut_out", "energy-aura", "rim-light", "backdrop-flash"]);
// The placements check's made: measure counts (particles and a drawn graphic): the ones that raise the share.
const COUNTED = new Set(["embers", "sparks", "bokeh", "dust", "snow", "rain", "fog", "streaks", "splatter"]);
const placeable = (name) => EFFECTS.has(name) || MOVES.has(name) || LAYERS.has(name) || name === RECOLOR;

// Color words a label may hold and the color each names (two-word names first, so "sky blue" is not "blue").
const COLOR_WORDS = [["sky blue", "#7EC8F2"], ["light blue", "#9AD1F5"], ["dark blue", "#1B2A6B"], ["navy", "#1B2A6B"], ["white", "#FFFFFF"], ["black", "#000000"],
  ["pink", "#FF6EB4"], ["magenta", "#E0308F"], ["purple", "#8A3FFC"], ["violet", "#8A3FFC"], ["cyan", "#22D3EE"], ["teal", "#14B8A6"], ["blues", "#2F6BFF"], ["blue", "#2F6BFF"],
  ["red", "#E5322D"], ["orange", "#FF8A1F"], ["yellow", "#FFD60A"], ["gold", "#E6B422"], ["green", "#34C759"]];
const NEUTRAL = new Set(["#FFFFFF", "#000000"]);

/** The colors a label's words name, in the order they appear: [{word, hex}] (each color once). */
export function labelColors(words) {
  const text = ` ${String(words ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const used = [], found = [];
  for (const [word, hex] of COLOR_WORDS) {
    let from = text.indexOf(` ${word} `);
    while (from >= 0) {
      const end = from + word.length + 1;
      if (!used.some(([a, b]) => from < b && end > a)) { used.push([from, end]); found.push({ word, hex, index: from }); }
      from = text.indexOf(` ${word} `, from + 1);
    }
  }
  const seen = new Set();
  return found.sort((a, b) => a.index - b.index).filter((entry) => !seen.has(entry.hex) && seen.add(entry.hex)).map(({ word, hex }) => ({ word, hex }));
}

/**
 * The made techniques the references' labels name: [{name, refs, labels, words, colors, sources}],
 * most references first. `refs` are saved references with `seen` labels ([{at, kinds, words}]);
 * `colors` are the first label's color words, `sources` [{ref, at}] the labels it came from.
 */
export function labelTechniques(refs = []) {
  const found = new Map();
  for (const ref of refs ?? []) {
    for (const entry of ref?.seen ?? []) {
      const kinds = entry?.kinds ?? [];
      if (!kinds.some((kind) => MADE_KINDS.has(kind))) continue;
      const words = String(entry.words ?? "");
      const colors = labelColors(words);
      const names = seenNameList(words).filter((name) => placeable(name) || CUTOUT.has(name));
      // A composite label most often is a subject cut out over another picture (deck.mjs KIND_NAMES).
      if (kinds.includes("composite") && !names.includes("cut_out")) names.push("cut_out");
      // A color label that names hues (not only white or black) is the shot recolored in them.
      if (kinds.includes("color") && colors.some((color) => !NEUTRAL.has(color.hex))) names.push(RECOLOR);
      for (const name of names.slice(0, PER_LABEL)) {
        const item = found.get(name) ?? { name, refs: new Set(), labels: 0, words, colors: [], sources: [] };
        item.refs.add(ref.id);
        item.labels += 1;
        item.sources.push({ ref: ref.id, at: entry.at });
        if (!item.colors.length && colors.length) { item.colors = colors; item.words = words; }
        found.set(name, item);
      }
    }
  }
  return [...found.values()].map((item) => ({ ...item, refs: item.refs.size }))
    .sort((a, b) => b.refs - a.refs || b.labels - a.labels || a.name.localeCompare(b.name));
}

/** The deck's cards the scene does not show yet (the card names deck_unused counts), as techniques. */
export function deckTechniques(deck, scene) {
  const shown = new Set([...(deck?.used ?? []), ...madeNamesIn(scene)]);
  const names = [...(deck?.cards ?? []).map((card) => card.tag), ...(deck?.setPiece ? [deck.setPiece.name] : [])];
  return names.filter((name) => !shown.has(name)).map((name) => ({ name, refs: 0, labels: 1, words: "", colors: [], sources: [], deck: true }));
}

// A picture counts as the shot while it fills this share of the frame or more: a 16:9 card over its
// blurred copy in a 9:16 frame fills about a third, so the card, not the copy under it, takes the effect.
const SHOT_SHARE = 0.25;
const frameShare = (model, item, index) => insideShare(model, visibleBoxAt(model, item, index)) * area(visibleBoxAt(model, item, index)) / (model.width * model.height);

/** The top picture's runs in the scene (the highest one filling a quarter of the frame or more): [{layerId, name, start, end}] in time order. */
export function shotSpans(model) {
  const full = new Set(plates(model));
  // A cut-out copy is not a shot: the clip under it is (check's cue line skips it the same way).
  const pictures = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && item.source?.layerId && !item.source.componentPath && !item.isMask && !item.cutoutOf);
  const spans = [];
  let open = null;
  model.times.forEach((time, index) => {
    let top = null;
    for (const item of pictures) if (item.samples.opacity[index] >= 0.9 && (!top || item.z > top.z) && (full.has(item) || frameShare(model, item, index) >= SHOT_SHARE)) top = item;
    if (open && open.item === top) { open.end = time; return; }
    if (open) spans.push(open);
    open = top ? { item: top, start: time, end: time } : null;
  });
  if (open) spans.push(open);
  const step = model.times.length > 1 ? model.times[1] - model.times[0] : 0;
  return spans.map((span) => ({ layerId: span.item.source.layerId, name: span.item.name ?? span.item.source.layerId, start: round(span.start), end: round(Math.min(model.duration, span.end + step)) }));
}

// The song-* markers, a drop first: [{name, time}].
const songCues = (document) => (document.cues ?? []).filter((cue) => cue.kind === "marker" && /^song-/.test(String(cue.name ?? "")) && Number.isFinite(cue.time))
  .sort((a, b) => Number(/drop/.test(b.name)) - Number(/drop/.test(a.name)) || a.time - b.time);

/**
 * The moments a technique may go on, best first: [{span, at, why}]. Song cues (a drop first), then
 * shots with a marked subject or a found face, then the longest shots.
 */
export function madeSlots(document, scene, spans, { faces = [] } = {}) {
  const layerOf = (id) => scene.layers.find((layer) => layer.id === id);
  const under = (time) => spans.find((span) => time >= span.start - 0.05 && time < span.end - 0.4);
  const slots = [];
  for (const cue of songCues(document)) { const span = under(cue.time); if (span) slots.push({ span, at: round(cue.time), why: cue.name }); }
  const marked = (span) => (layerOf(span.layerId)?.subjectBoxes?.boxes?.length ? "marked subject" : faces.includes(span.layerId) ? "face found" : "");
  const lead = (span) => round(span.start + Math.min(0.5, (span.end - span.start) * 0.25));
  for (const span of spans) if (marked(span)) slots.push({ span, at: lead(span), why: marked(span) });
  for (const span of [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start))) slots.push({ span, at: lead(span), why: "longest shot" });
  return slots.filter((slot) => slot.span.end - slot.at >= 0.4);
}

/** The cuts between two shots a hand-off may go on, a song cue's cut first: [{span, prev, at, why}]. */
export function cutSlots(document, spans) {
  const cues = songCues(document);
  const cuts = [];
  spans.forEach((span, index) => {
    const prev = spans[index - 1];
    if (!prev || prev.layerId === span.layerId || Math.abs(prev.end - span.start) > 0.05 || prev.end - prev.start < 0.6 || span.end - span.start < 0.6) return;
    const cue = cues.find((entry) => Math.abs(entry.time - span.start) <= 0.1);
    cuts.push({ span, prev, at: span.start, why: cue ? `cut on ${cue.name}` : "cut" });
  });
  return cuts.sort((a, b) => Number(b.why !== "cut") - Number(a.why !== "cut") || a.at - b.at);
}

// How long a placement lasts from `slot`: to the shot's cut or the next song cue after it, the first.
function until(slot, cues) {
  const cue = cues.map((entry) => entry.time).filter((time) => time >= slot.at + 0.4 && time < slot.span.end).sort((a, b) => a - b)[0];
  return cue === undefined ? { end: slot.span.end, why: `the cut at ${slot.span.end} s` } : { end: round(cue), why: `the song cue at ${round(cue)} s` };
}

// Color helpers: saturation 0 to 1 and light 0 to 1 of a hex color.
const rgbOf = (hex) => { const value = parseInt(String(hex).slice(1, 7), 16); return [(value >> 16) & 255, (value >> 8) & 255, value & 255]; };
const saturation = (hex) => { const [r, g, b] = rgbOf(hex); const high = Math.max(r, g, b), low = Math.min(r, g, b); return high ? (high - low) / high : 0; };
const light = (hex) => { const [r, g, b] = rgbOf(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const toward = (hex, share, end) => `#${rgbOf(hex).map((channel) => Math.round(channel * (1 - share) + end * share).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
// A palette's [main, accent]: the biggest color, then the most saturated of the rest.
const mainAndAccent = (colors) => {
  const list = (colors ?? []).filter((entry) => /^#[0-9a-f]{6}$/i.test(entry?.hex ?? "")).map((entry) => entry.hex.toUpperCase());
  if (!list.length) return [];
  const accent = [...list.slice(1)].sort((a, b) => saturation(b) - saturation(a))[0];
  return accent ? [list[0], accent] : [list[0]];
};

/**
 * The subject box of `layer` at scene time `time` in scene pixels ([x, y, w, h]), from its
 * mark_subject boxes nearest that moment of the file (the same marks place {around} reads), or null.
 */
export function subjectBoxAt(layer, time) {
  const boxes = layer?.subjectBoxes?.boxes ?? [];
  if (!boxes.length) return null;
  let source = time;
  try { source = mediaFrameState(layer, time).sourceTime ?? time; } catch { /* scene time */ }
  const near = boxes.reduce((best, entry) => (Math.abs(entry.at - source) < Math.abs(best.at - source) ? entry : best));
  const [x, y, w, h] = near.box;
  return [Math.round(layer.x + (layer.width * x) / 100), Math.round(layer.y + (layer.height * y) / 100), Math.round((layer.width * w) / 100), Math.round((layer.height * h) / 100)];
}

/**
 * A splatter's square beside `box` (scene px) on the side with the most room (left or right, else
 * above or below, as a 9:16 frame leaves it), never over it: {x, y, size, side} or null with no room.
 */
export function besideSubject(box, width, height) {
  const [bx, by, bw, bh] = box;
  const clamp = (value, most) => Math.round(Math.min(Math.max(0, value), most));
  const cap = Math.min(width, height) * 0.5;
  const sides = [
    { side: "right", room: width - (bx + bw), along: bh },
    { side: "left", room: bx, along: bh },
    { side: "below", room: height - (by + bh), along: bw },
    { side: "above", room: by, along: bw },
  ].map((entry) => ({ ...entry, size: Math.round(Math.min(entry.along, entry.room * 0.9, cap)) }));
  const best = sides.reduce((top, entry) => (entry.size > top.size ? entry : top));
  if (best.size < Math.min(width, height) / 10) return null;
  const { side, size, room } = best;
  if (side === "right" || side === "left") {
    const x = side === "left" ? Math.round((room - size) / 2) : Math.round(bx + bw + (room - size) / 2);
    return { x, y: clamp(by + bh / 2 - size / 2, height - size), size, side };
  }
  const y = side === "above" ? Math.round((room - size) / 2) : Math.round(by + bh + (room - size) / 2);
  return { x: clamp(bx + bw / 2 - size / 2, width - size), y, size, side };
}

// The colors for a technique at a slot (`count` of them) and where they came from: the label's color
// words, the reference's strip frame nearest the label's time, the shot at that moment, else a guess.
// One color is the accent (a splatter), or with `main` the biggest one (a background behind a cut-out).
async function colorsFor(technique, slot, count, { refColors, colorsAt, guess, main = false }) {
  // Hues before white and black when a label names enough of them ("white splat; pink and purple paint" recolors pink and purple).
  const all = technique.colors ?? [], hues = all.filter((entry) => !NEUTRAL.has(entry.hex));
  const words = technique.name === "splatter" || main ? all : hues.length >= count ? hues : count > 1 ? all : hues;
  if (words.length) {
    const picked = words.slice(0, count);
    return { hexes: picked.map((entry) => entry.hex), from: `the label's ${picked.map((entry) => `"${entry.word}"`).join(" and ")}` };
  }
  const one = (found) => (count === 1 ? [main ? found[0] : found.at(-1)] : found.slice(0, count));
  const source = technique.sources?.[0];
  if (source && refColors) {
    const found = mainAndAccent(await refColors(source.ref, source.at).catch(() => null));
    if (found.length >= Math.min(count, 2)) return { hexes: one(found), from: `${source.ref}'s frame at ${source.at} s` };
  }
  // A background is never the shot's own color (it would hide the cut-out's edge against nothing new).
  if (colorsAt && !main) {
    const found = mainAndAccent(await colorsAt(slot.span.layerId, slot.at).catch(() => null));
    if (found.length >= Math.min(count, 2)) return { hexes: one(found), from: `${slot.span.name} at ${slot.at} s` };
  }
  return { hexes: guess.slice(0, count), from: "a starting guess" };
}

// The op that places `technique` at `slot` with id `id`, and its printed values: {op, note}.
async function opFor(technique, slot, id, { scene, cues, measure }) {
  const name = technique.name;
  const stay = until(slot, cues);
  const duration = round(stay.end - slot.at);
  const timing = `at ${slot.at} s for ${duration} s (to ${stay.why})`;
  if (EFFECTS.has(name)) return { op: { op: "add_animation", layer: slot.span.name, id, effect: name, start: slot.at, duration }, note: `${name} on ${slot.span.name} ${timing} (${id})` };
  if (name === RECOLOR) {
    const { hexes, from } = await colorsFor(technique, slot, 2, { ...measure, guess: ["#1400FF", "#FFE4E4"] });
    const [dark, bright] = hexes.length > 1 ? [...hexes].sort((a, b) => light(a) - light(b)) : [toward(hexes[0], 0.78, 0), hexes[0]];
    return { op: { op: "add_animation", layer: slot.span.name, id, effect: "duotone", start: slot.at, duration, parameters: { shadowColor: dark, highlightColor: bright } },
      note: `recolor (duotone ${dark} to ${bright}, from ${from}${hexes.length > 1 ? "" : "; shadow 78% toward black"}) on ${slot.span.name} ${timing} (${id})` };
  }
  if (name === "overexpose") {
    // On a cut the peak lands on it (cards.js: 0.4 s, starting 0.2 s before); alone it washes one shot.
    if (slot.prev) return { op: { op: "move", name, id, layer: slot.prev.name, into: slot.span.name, at: round(slot.at - 0.2), dur: 0.4 }, note: `overexpose ${slot.prev.name} into ${slot.span.name} at ${round(slot.at - 0.2)} s for 0.4 s, peak on the cut at ${slot.at} s (${id})` };
    return { op: { op: "move", name, id, layer: slot.span.name, at: slot.at, dur: 0.4 }, note: `overexpose on ${slot.span.name} at ${slot.at} s for 0.4 s (${id})` };
  }
  if (name === "smear") return { op: { op: "move", name, id, from: slot.prev.name, to: slot.span.name, at: slot.at }, note: `smear ${slot.prev.name} to ${slot.span.name} at ${slot.at} s (${id})` };
  if (name === "split-fields") {
    const { hexes, from } = await colorsFor(technique, slot, 2, { ...measure, guess: ["#3BEA7A", "#E0308F"] });
    const colors = hexes.length > 1 ? hexes : [hexes[0], toward(hexes[0], 0.6, 255)];
    const dur = round(Math.min(1, duration));
    return { op: { op: "move", name, id, layer: slot.span.name, at: slot.at, dur, colors }, note: `split-fields on ${slot.span.name} at ${slot.at} s for ${dur} s, colors ${colors.join(", ")} (from ${from}) (${id})` };
  }
  if (MOVES.has(name)) return { op: { op: "move", name, id, layer: slot.span.name, at: slot.at }, note: `${name} on ${slot.span.name} at ${slot.at} s (${id})` };
  // A splatter beside the marked subject, never over it.
  const { hexes, from } = await colorsFor(technique, slot, 1, { ...measure, guess: ["#FFFFFF"] });
  const layer = scene.layers.find((entry) => entry.id === slot.span.layerId);
  const box = subjectBoxAt(layer, slot.at);
  const spot = box ? besideSubject(box, scene.width, scene.height) : null;
  const size = spot?.size ?? Math.round(Math.min(scene.width, scene.height) / 3);
  const x = spot?.x ?? Math.round(scene.width * 0.08), y = spot?.y ?? Math.round(scene.height * 0.1);
  const where = spot ? `${spot.side} of the subject box ${box.join(",")}` : box ? `a starting guess: no room beside the subject box ${box.join(",")}` : "a starting guess: no subject box (mark_subject sets one)";
  return { op: { op: "add_layer", layerType: "path", name: id, properties: { id, x, y, width: size, height: size, fill: hexes[0], splatter: { style: "splat", seed: Number(id.slice(MADE_PREFIX.length)) || 1 }, mediaStart: slot.at, mediaDuration: duration } },
    note: `${id} (splatter splat, fill ${hexes[0]} from ${from}, ${size}x${size} at ${x},${y}, ${where}) ${timing}`,
    span: [slot.at, stay.end] };
}

const percent = (made, total) => (total ? Math.round((made / total) * 100) : 0);
const median = (values) => { const list = [...values].sort((a, b) => a - b); const middle = Math.floor(list.length / 2); return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2; };

/** The ids this module placed in a scene: {moves, layers, animations} (a move's own layers and animations go with its move). */
export function madeIds(scene) {
  const moves = (scene?.moves ?? []).filter((entry) => String(entry.id).startsWith(MADE_PREFIX)).map((entry) => ({ id: entry.id, name: entry.name }));
  const moveIds = new Set(moves.map((entry) => entry.id));
  const ofMove = (id) => [...moveIds].some((moveId) => id === moveId || String(id).startsWith(`${moveId}.`));
  const layers = (scene?.layers ?? []).filter((layer) => String(layer.id).startsWith(MADE_PREFIX) && !moveIds.has(layer.move?.instance) && !ofMove(layer.id)).map((layer) => layer.id);
  const animations = (scene?.layers ?? []).filter((layer) => !layers.includes(layer.id) && !moveIds.has(layer.move?.instance))
    .flatMap((layer) => (layer.animations ?? []).filter((animation) => String(animation.id ?? "").startsWith(MADE_PREFIX) && !ofMove(animation.id)).map((animation) => animation.id));
  return { moves, layers, animations };
}

// Applies `ops` together, else one by one (an op the scene cannot take, such as a layer in a group,
// is left out and named, so the exposure match and the other placements still land): {document, failed}.
// An entry of `ops` is one op or a list that lands together (a background and the move under its cut-out).
async function applyEach(document, ops, runOps) {
  if (!ops.length) return { document, failed: [] };
  try { return { document: await runOps(document, ops.flat()), failed: [] }; } catch { /* one at a time below */ }
  let current = document;
  const failed = [];
  for (const op of ops) {
    try { current = await runOps(current, [op].flat()); } catch (error) { failed.push({ op, why: String(error?.message ?? error).split("\n")[0].slice(0, 120) }); }
  }
  return { document: current, failed };
}

// A made background behind the cut-out `subjectId` of the slot's shot: a frame-size rectangle in the
// label's color (else the reference's frame there, else a starting guess) moved right under the
// cut-out, so the subject stands on it: {ops, fill, from, stay}.
async function backgroundOps(technique, slot, subjectId, id, { scene, cues, measure }) {
  const { hexes, from } = await colorsFor(technique, slot, 1, { ...measure, guess: ["#FFFFFF"], main: true });
  const stay = until(slot, cues);
  const layer = { op: "add_layer", layerType: "rectangle", name: id, properties: { id, x: 0, y: 0, width: scene.width, height: scene.height, fill: hexes[0], mediaStart: slot.at, mediaDuration: round(stay.end - slot.at) } };
  return { ops: [layer, { op: "move_layers", layers: [id], position: "below", referenceId: subjectId }], fill: hexes[0], from, stay };
}

// The ready call for a cut-out technique on a subject shot: a composite (cut_out) also gets a made
// background between the clip and its subject.
async function cutoutCall(technique, subject, context) {
  const shot = subject.span.name;
  if (technique.name !== "cut_out") return `edit {"ops":[{"op":"move","name":"${technique.name}","layer":"${shot}","at":${subject.at}}]}`;
  const background = await backgroundOps(technique, subject, `${shot}-subject`, `${MADE_PREFIX}bg`, context);
  const ops = [{ op: "cut_out", layer: shot, name: `${shot}-subject` }, ...background.ops];
  return `edit ${JSON.stringify({ ops })} (background ${background.fill} from ${background.from}, to ${background.stay.why})`;
}

/**
 * Places the references' made techniques: {document, lines, placed}. `refs` the saved references
 * with labels, `deck` the project's deck (used with no labeled reference), `names` the agent's own
 * list (made:[...]) in place of both, `faces` layer ids whose file has a face kino found,
 * `runOps(document, ops)` applies ops as an edit would; `colorsAt(layerId, time)` and
 * `refColors(refId, at)` measure a palette ([{hex, share}]) of a shot or a reference's frame.
 */
export async function placeMade(document, { sceneId = null, refs = [], deck = null, names = null, faces = [], remove = false, fonts, runOps, colorsAt = null, refColors = null }) {
  const scene = sceneId ? document.scenes.find((entry) => entry.id === sceneId) : mainScene(document);
  if (!scene) return { document, lines: [], placed: [] };
  const old = madeIds(scene);
  // A move goes with its own remove (it puts back the clip timing it changed), then the rest.
  const deletes = [...old.moves.map((entry) => ({ op: "move", name: entry.name, id: entry.id, remove: true, scene: scene.id })),
    ...old.layers.map((layerId) => ({ op: "delete_layer", layerId })), ...old.animations.map((animationId) => ({ op: "delete_animation", animationId }))];
  const base = (await applyEach(document, deletes, runOps)).document;
  const gone = deletes.length;
  if (remove) return { document: base, lines: gone ? [`match_references: took off ${gone} made element${gone === 1 ? "" : "s"}`] : [], placed: [] };
  const baseScene = base.scenes.find((entry) => entry.id === scene.id);
  const labeled = (refs ?? []).filter((ref) => ref?.seen?.length);
  const from = Array.isArray(names) ? "your list" : labeled.length ? "your references' labels" : "your deck's unused cards";
  const techniques = Array.isArray(names) ? names.map((entry) => ({ name: entry, refs: 0, labels: 1, words: "", colors: [], sources: [] }))
    : labeled.length ? labelTechniques(labeled) : deckTechniques(deck, baseScene);
  const model = kinoTimeline(base, scene.id, { fonts });
  const start = madeMoments(model);
  const before = { moments: start.moments.length, made: start.made, parts: start.parts };
  const spans = shotSpans(model);
  const slots = madeSlots(base, baseScene, spans, { faces });
  const cuts = cutSlots(base, spans);
  const cues = songCues(base);
  const theirs = referenceMade(labeled);
  // The aim: the references' own made share (the median of their labels'), only with labeled references.
  const aim = theirs.length && !Array.isArray(names) ? median(theirs.map((ref) => ref.made / Math.max(1, ref.total))) : null;
  const covered = [];
  const predicted = () => start.moments.filter((moment) => moment.made || covered.some(([a, b]) => moment.time >= a && moment.time <= b)).length;
  const taken = new Set(), cutTaken = new Set();
  const ops = [], placed = [], left = [];
  const measure = { colorsAt, refColors };
  // Overexposes stay a second or more apart, so they add at most one flash a second (the flashing
  // check allows three).
  const flashes = [];
  const apart = (technique, at) => technique.name !== "overexpose" || flashes.every((time) => Math.abs(time - at) >= 1);
  // Shots whose cut-out got a made background: it hides the clip under the subject, so nothing else goes there.
  const backed = new Set();
  const open = (technique, span) => !taken.has(span) && !backed.has(span.layerId);
  let count = 0;
  const place = async (technique) => {
    let slot;
    if (HANDOFFS.has(technique.name)) {
      slot = cuts.find((entry) => !cutTaken.has(entry) && apart(technique, entry.at) && !backed.has(entry.span.layerId) && !backed.has(entry.prev.layerId));
      if (slot) cutTaken.add(slot);
      else if (technique.name === "overexpose") {
        slot = slots.find((entry) => open(technique, entry.span) && apart(technique, entry.at));
        if (slot) taken.add(slot.span);
      }
      if (!slot) return false;
      if (technique.name === "overexpose") flashes.push(slot.at);
    } else {
      slot = slots.find((entry) => open(technique, entry.span));
      if (!slot) return false;
      taken.add(slot.span);
    }
    count += 1;
    const made = await opFor(technique, slot, `${MADE_PREFIX}${count}`, { scene: baseScene, cues, measure });
    if (COUNTED.has(technique.name)) covered.push(made.span ?? [slot.at, until(slot, cues).end]);
    ops.push(made.op);
    placed.push({ name: technique.name, op: made.op, note: made.note, why: slot.why, refs: technique.refs });
    return true;
  };
  // A composite on a shot whose cut-out is already made gets its background first (no render).
  const composite = techniques.find((entry) => entry.name === "cut_out");
  if (composite) {
    const copyOf = (span) => baseScene.layers.find((layer) => layer.cutoutOf === span.layerId && layer.isMask !== true);
    for (const slot of slots) {
      const copy = copyOf(slot.span);
      if (backed.size >= composite.labels || !copy || backed.has(slot.span.layerId)) continue;
      backed.add(slot.span.layerId);
      count += 1;
      const id = `${MADE_PREFIX}${count}`;
      const bg = await backgroundOps(composite, slot, copy.id, id, { scene: baseScene, cues, measure });
      ops.push(bg.ops);
      placed.push({ name: "cut_out", op: bg.ops, refs: composite.refs, why: slot.why,
        note: `${id} (background ${bg.fill} from ${bg.from}, frame size, right under ${copy.name ?? copy.id}, the cut-out of ${slot.span.name}) at ${slot.at} s for ${round(bg.stay.end - slot.at)} s (to ${bg.stay.why})` });
    }
  }
  // Round by round, so every technique gets a shot before one gets a second.
  const rounds = Math.max(0, ...techniques.map((entry) => entry.labels));
  for (let turn = 0; turn < rounds; turn += 1) {
    for (const technique of techniques) if (technique.labels > turn && placeable(technique.name)) await place(technique);
  }
  // Then the counted techniques again until the share reaches the references' (or no shot is left).
  const counted = techniques.filter((entry) => COUNTED.has(entry.name));
  if (aim !== null && counted.length) {
    let index = 0;
    while (predicted() < aim * start.moments.length && (await place(counted[index % counted.length]))) index += 1;
  }
  for (const technique of techniques.filter((entry) => placeable(entry.name) && !placed.some((item) => item.name === entry.name))) {
    left.push(`${technique.name} (${HANDOFFS.has(technique.name) ? `no cut between two shots of 0.6 s or more left${technique.name === "overexpose" ? ", a second from another overexpose" : ""}` : "no shot left"})`);
  }
  for (const technique of techniques.filter((entry) => !placeable(entry.name) && !(entry.name === "cut_out" && backed.size))) {
    const subject = slots.find((slot) => slot.why === "marked subject" || slot.why === "face found") ?? slots[0];
    const call = CUTOUT.has(technique.name) && subject ? await cutoutCall(technique, subject, { scene: baseScene, cues, measure }) : `library {topic:"search", search:"${technique.name.replace(/[-_]/g, " ")}"}`;
    left.push(`${technique.name} (${CUTOUT.has(technique.name) ? "a cut-out takes up to a minute, so it gets its own call" : "no one-op maker here"}): ${call}`);
  }
  const { document: after, failed } = await applyEach(base, ops, runOps);
  for (const miss of failed) {
    const index = placed.findIndex((entry) => entry.op === miss.op);
    if (index >= 0) left.push(`${placed[index].name} (${miss.why}): ${JSON.stringify(miss.op)}`);
    if (index >= 0) placed.splice(index, 1);
  }
  const now = placed.length ? (({ moments, made, parts }) => ({ moments: moments.length, made, parts }))(madeMoments(kinoTimeline(after, scene.id, { fonts }))) : before;
  const share = `made share ${before.made} of ${before.moments} moments (${percent(before.made, before.moments)}%) before, ${now.made} of ${now.moments} (${percent(now.made, now.moments)}%) after${theirs.length ? `; your ${theirs.length} reference${theirs.length === 1 ? "'s" : "s'"} made labels ${theirs.map((ref) => `${ref.made} of ${ref.total} (${percent(ref.made, ref.total)}%)`).join(", ")}` : ""}${aim !== null ? ` (aim: their median ${Math.round(aim * 100)}%)` : ""}`;
  const lines = [];
  if (!techniques.length) lines.push(`match_references made: nothing to follow (no labeled reference and no unused deck card); ${share}. made:["embers", "glow"] places your own list.`);
  else {
    if (placed.length) lines.push(`match_references made, from ${from}: ${placed.map((entry) => `${entry.note} [${entry.why}${entry.refs ? `; ${entry.refs} reference${entry.refs === 1 ? "" : "s"}` : ""}]`).join(", ")}`);
    else if (!techniques.some((entry) => placeable(entry.name))) lines.push(`match_references made, from ${from}: none of them is one op (each has its call under "not placed")`);
    else lines.push(`match_references made, from ${from}: no shot left to place on (${slots.length} moments, ${spans.length} shots)`);
    if (left.length) lines.push(`not placed: ${left.join("; ")}`);
    lines.push(`${share}. Each is ${MADE_PREFIX}<n>: update_animation or update_layer changes a value; made:[names] places your own list, made:false none; sent again it replaces them; remove:true takes them off.`);
  }
  return { document: after, lines, placed: placed.map((entry) => ({ name: entry.name, why: entry.why, op: entry.op })), before, after: now };
}
