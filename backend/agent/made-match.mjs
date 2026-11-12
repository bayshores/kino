// match_references' made part (the edit op, made left out or true): places the made techniques the
// saved references' labels name (library inspire seen: "made, overlay: embers rise round him") on
// the scene's shots, the way their labels read through seen-names.mjs. With no labeled reference it
// places the deck's unused cards instead. Why: two test edits called match_references and got
// exposure grades only; their references were mostly made (24 to 89% of moments) and the edits 0 to
// 10% (.scratch/dm2 qc-2, five things row 5).
//
// Where: song cues first (fit_music's song-* markers, a drop before the rest), then shots whose
// subject is marked (mark_subject) or whose file has a face kino found, then the longest shots; one
// technique per shot, each shot once. How often: as many shots as the references show it at labeled
// moments (at least once). Every op is ordinary (add_animation, add_layer, move) with an id that
// starts match-made-, so the receipt prints its values, update_animation or update_layer changes
// them, sending the op again replaces them and remove:true takes them off.
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { plates } from "../../engine/quality/techniques.js";
import { madeShare, referenceMade } from "../../engine/quality/madeShare.js";
import { mainScene } from "../../engine/board.js";
import { madeNamesIn } from "../../engine/deck.js";
import { round } from "../../engine/numbers.js";
import { seenNameList } from "./seen-names.mjs";

export const MADE_PREFIX = "match-made-";
// The label kinds that name a made picture (spoken, plain and type labels do not).
const MADE_KINDS = new Set(["made", "overlay", "composite", "color", "frame"]);
// How long one placement lasts at most (s): an accent, not the whole shot. A guess.
const LONGEST = 2;
// Names read from one label: its first two that kino can place (a label lists its main look first).
const PER_LABEL = 2;

// What kino lays on a shot in one op, by name: an effect on the shot's layer (particles, light and
// drawn overlays), a path (splatter) or a move.
const EFFECTS = new Set(["glow", "embers", "sparks", "bokeh", "dust", "snow", "rain", "fog", "streaks", "light-leaks", "speed-lines", "impact-lines", "film-burn", "lightning", "edge-lines", "light-rays", "lens-flare", "vignette", "duotone", "tritone", "rgb-shift"]);
const MOVES = new Set(["light-sweep"]);
const LAYERS = new Set(["splatter"]);
// Techniques that need a subject cut-out first (up to a minute: CUTOUT_RUNNING would refuse the
// edit), so they get a ready call on a subject shot instead.
const CUTOUT = new Set(["cut_out", "energy-aura", "rim-light", "backdrop-flash"]);
const placeable = (name) => EFFECTS.has(name) || MOVES.has(name) || LAYERS.has(name);

/**
 * The made techniques the references' labels name: [{name, refs, labels, words}], most references
 * first. `refs` are saved references with `seen` labels ([{at, kinds, words}]).
 */
export function labelTechniques(refs = []) {
  const found = new Map();
  for (const ref of refs ?? []) {
    for (const entry of ref?.seen ?? []) {
      const kinds = entry?.kinds ?? [];
      if (!kinds.some((kind) => MADE_KINDS.has(kind))) continue;
      const names = seenNameList(entry.words ?? "").filter((name) => placeable(name) || CUTOUT.has(name));
      // A composite label most often is a subject cut out over another picture (deck.mjs KIND_NAMES).
      if (kinds.includes("composite") && !names.includes("cut_out")) names.push("cut_out");
      for (const name of names.slice(0, PER_LABEL)) {
        const item = found.get(name) ?? { name, refs: new Set(), labels: 0, words: String(entry.words ?? "") };
        item.refs.add(ref.id);
        item.labels += 1;
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
  return names.filter((name) => !shown.has(name)).map((name) => ({ name, refs: 0, labels: 1, words: "", deck: true }));
}

/** The top full-frame picture's runs in the scene: [{layerId, name, start, end}] in time order. */
export function shotSpans(model) {
  const pictures = plates(model).filter((item) => (item.kind === "video" || item.kind === "image") && item.source?.layerId && !item.source.componentPath);
  const spans = [];
  let open = null;
  model.times.forEach((time, index) => {
    let top = null;
    for (const item of pictures) if (item.samples.opacity[index] >= 0.9 && (!top || item.z > top.z)) top = item;
    if (open && open.item === top) { open.end = time; return; }
    if (open) spans.push(open);
    open = top ? { item: top, start: time, end: time } : null;
  });
  if (open) spans.push(open);
  const step = model.times.length > 1 ? model.times[1] - model.times[0] : 0;
  return spans.map((span) => ({ layerId: span.item.source.layerId, name: span.item.name ?? span.item.source.layerId, start: round(span.start), end: round(Math.min(model.duration, span.end + step)) }));
}

/**
 * The moments a technique may go on, best first: [{span, at, why}]. Song cues (a drop first), then
 * shots with a marked subject or a found face, then the longest shots.
 */
export function madeSlots(document, scene, spans, { faces = [] } = {}) {
  const layerOf = (id) => scene.layers.find((layer) => layer.id === id);
  const under = (time) => spans.find((span) => time >= span.start - 0.05 && time < span.end - 0.4);
  const cues = (document.cues ?? []).filter((cue) => cue.kind === "marker" && /^song-/.test(String(cue.name ?? "")) && Number.isFinite(cue.time))
    .sort((a, b) => Number(/drop/.test(b.name)) - Number(/drop/.test(a.name)) || a.time - b.time);
  const slots = [];
  for (const cue of cues) { const span = under(cue.time); if (span) slots.push({ span, at: round(cue.time), why: cue.name }); }
  const marked = (span) => (layerOf(span.layerId)?.subjectBoxes?.boxes?.length ? "marked subject" : faces.includes(span.layerId) ? "face found" : "");
  const lead = (span) => round(span.start + Math.min(0.5, (span.end - span.start) * 0.25));
  for (const span of spans) if (marked(span)) slots.push({ span, at: lead(span), why: marked(span) });
  for (const span of [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start))) slots.push({ span, at: lead(span), why: "longest shot" });
  return slots.filter((slot) => slot.span.end - slot.at >= 0.4);
}

// The op that places `name` at `slot`, with id `id`.
function opFor(name, slot, id, scene) {
  const duration = round(Math.min(LONGEST, slot.span.end - slot.at));
  if (EFFECTS.has(name)) return { op: "add_animation", layer: slot.span.name, id, effect: name, start: slot.at, duration };
  if (MOVES.has(name)) return { op: "move", name, id, layer: slot.span.name, at: slot.at };
  // A splatter shape a third of the frame tall, beside the middle (the subject usually sits there).
  const size = Math.round(Math.min(scene.width, scene.height) / 3);
  return { op: "add_layer", layerType: "path", name: id, properties: { id, x: Math.round(scene.width * 0.08), y: Math.round(scene.height * 0.1), width: size, height: size, fill: "#ffffff", splatter: { style: "splat", seed: Number(id.slice(MADE_PREFIX.length)) || 1 }, mediaStart: slot.at, mediaDuration: duration } };
}

// A shape's mediaStart and mediaDuration become its Show and Hide (operations.md, add_animation).
const valuesOf = (op) => (op.op === "add_layer"
  ? `${op.properties.id} (splatter ${op.properties.splatter.style}, fill ${op.properties.fill}, ${op.properties.width}x${op.properties.height} at ${op.properties.x},${op.properties.y}) at ${op.properties.mediaStart} s for ${op.properties.mediaDuration} s`
  : op.op === "move" ? `${op.name} on ${op.layer} at ${op.at} s (${op.id})` : `${op.effect} on ${op.layer} at ${op.start} s for ${op.duration} s (${op.id})`);

const percent = (made, total) => (total ? Math.round((made / total) * 100) : 0);

/** The ids this module placed in a scene: {layers, animations}. */
export function madeIds(scene) {
  const layers = (scene?.layers ?? []).filter((layer) => String(layer.id).startsWith(MADE_PREFIX)).map((layer) => layer.id);
  const animations = (scene?.layers ?? []).filter((layer) => !layers.includes(layer.id))
    .flatMap((layer) => (layer.animations ?? []).filter((animation) => String(animation.id ?? "").startsWith(MADE_PREFIX)).map((animation) => animation.id));
  return { layers, animations };
}

/**
 * Places the references' made techniques: {document, lines, placed}. `refs` the saved references
 * with labels, `deck` the project's deck (used with no labeled reference), `names` the agent's own
 * list (made:[...]) in place of both, `faces` layer ids whose file has a face kino found,
 * `runOps(document, ops)` applies ops as an edit would.
 */
export async function placeMade(document, { sceneId = null, refs = [], deck = null, names = null, faces = [], remove = false, fonts, runOps }) {
  const scene = sceneId ? document.scenes.find((entry) => entry.id === sceneId) : mainScene(document);
  if (!scene) return { document, lines: [], placed: [] };
  const old = madeIds(scene);
  const deletes = [...old.layers.map((layerId) => ({ op: "delete_layer", layerId })), ...old.animations.map((animationId) => ({ op: "delete_animation", animationId }))];
  const base = deletes.length ? await runOps(document, deletes) : document;
  if (remove) return { document: base, lines: old.layers.length + old.animations.length ? [`match_references: took off ${old.layers.length + old.animations.length} made element${old.layers.length + old.animations.length === 1 ? "" : "s"}`] : [], placed: [] };
  const baseScene = base.scenes.find((entry) => entry.id === scene.id);
  const labeled = (refs ?? []).filter((ref) => ref?.seen?.length);
  const from = Array.isArray(names) ? "your list" : labeled.length ? "your references' labels" : "your deck's unused cards";
  const techniques = Array.isArray(names) ? names.map((entry) => ({ name: entry, refs: 0, labels: 1, words: "" }))
    : labeled.length ? labelTechniques(labeled) : deckTechniques(deck, baseScene);
  const model = kinoTimeline(base, scene.id, { fonts });
  const before = madeShare(model);
  const spans = shotSpans(model);
  const slots = madeSlots(base, baseScene, spans, { faces });
  const taken = new Set();
  const ops = [], placed = [], left = [];
  let count = 0;
  const free = () => slots.find((slot) => !taken.has(slot.span));
  // Round by round, so every technique gets a shot before one gets a second.
  const rounds = Math.max(0, ...techniques.map((entry) => entry.labels));
  for (let turn = 0; turn < rounds; turn += 1) {
    for (const technique of techniques) {
      if (technique.labels <= turn || !placeable(technique.name)) continue;
      const slot = free();
      if (!slot) continue;
      taken.add(slot.span);
      count += 1;
      const op = opFor(technique.name, slot, `${MADE_PREFIX}${count}`, baseScene);
      ops.push(op);
      placed.push({ name: technique.name, op, why: slot.why, refs: technique.refs });
    }
  }
  for (const technique of techniques.filter((entry) => !placeable(entry.name))) {
    const subject = slots.find((slot) => slot.why === "marked subject" || slot.why === "face found") ?? slots[0];
    const call = CUTOUT.has(technique.name) && subject
      ? `edit {"ops":[${technique.name === "cut_out" ? `{"op":"cut_out","layer":"${subject.span.name}"}` : `{"op":"move","name":"${technique.name}","layer":"${subject.span.name}","at":${subject.at}}`}]}`
      : `library {topic:"search", search:"${technique.name.replace(/[-_]/g, " ")}"}`;
    left.push(`${technique.name} (${CUTOUT.has(technique.name) ? "a cut-out takes up to a minute, so it gets its own call" : "no one-op maker here"}): ${call}`);
  }
  const after = ops.length ? await runOps(base, ops) : base;
  const now = ops.length ? madeShare(kinoTimeline(after, scene.id, { fonts })) : before;
  const theirs = referenceMade(labeled);
  const share = `made share ${before.made} of ${before.moments} moments (${percent(before.made, before.moments)}%) before, ${now.made} of ${now.moments} (${percent(now.made, now.moments)}%) after${theirs.length ? `; your ${theirs.length} reference${theirs.length === 1 ? "'s" : "s'"} made labels ${theirs.map((ref) => `${ref.made} of ${ref.total} (${percent(ref.made, ref.total)}%)`).join(", ")}` : ""}`;
  const lines = [];
  if (!techniques.length) lines.push(`match_references made: nothing to follow (no labeled reference and no unused deck card); ${share}. made:["embers", "glow"] places your own list.`);
  else {
    if (placed.length) lines.push(`match_references made, from ${from}: ${placed.map((entry) => `${valuesOf(entry.op)} [${entry.why}${entry.refs ? `; ${entry.refs} reference${entry.refs === 1 ? "" : "s"}` : ""}]`).join(", ")}`);
    else lines.push(`match_references made, from ${from}: no shot left to place on (${slots.length} moments, ${spans.length} shots)`);
    if (left.length) lines.push(`not placed: ${left.join("; ")}`);
    lines.push(`${share}. Each is ${MADE_PREFIX}<n>: update_animation or update_layer changes a value; made:[names] places your own list, made:false none; sent again it replaces them; remove:true takes them off.`);
  }
  return { document: after, lines, placed: placed.map((entry) => ({ name: entry.name, why: entry.why, op: entry.op })), before, after: now };
}
