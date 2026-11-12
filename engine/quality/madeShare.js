// How much of a scene is designed: the share of its runtime that carries a made element, as a fact
// beside the returns line (check). Never a rule, a warning or a target: the agent sees its own
// number, and the saved references' stored one where they have it.
//
// A made element is a cut-out, a drawn graphic or shape (referenceKinds' "made"), a particle
// overlay, or designed type: a reading text at 8% of the frame height or more that is not a
// caption or a spoken line. Read at the same half-second moments reference_kinds uses.
import { PARTICLE_LOOKS } from "../effects/particles.js";
import { designedTexts, drawnSize } from "./analysis.js";
import { frameAt } from "./model.js";
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
 * (library inspire seen). Only references with labels are listed: [{id, made, total}].
 */
export function referenceMade(refs) {
  return (refs ?? []).filter((ref) => Array.isArray(ref.seen) && ref.seen.length).map((ref) => ({ id: ref.id, made: ref.seen.filter((entry) => (entry.kinds ?? []).includes("made")).length, total: ref.seen.length }));
}

const percent = (made, total) => (total ? Math.round((made / total) * 100) : 0);

/**
 * One line: `made: 6 of 28 moments (21%) carry a made element (graphic 4, type 3) · deck: 6 of 8
 * cards unused (a, b, ...) · drawn graphic: yours 4 of 28 moments, your 2 references' made labels
 * 2 of 6, 5 of 6`. `deck` is {used, unused} (engine/deck.js deckUse), left out with none; `refs`
 * is referenceMade's list, set beside the edit's own graphic count (the same measure).
 */
export function madeLine(own, { refs = [], deck = null } = {}) {
  if (!own?.moments) return "";
  const kinds = Object.entries(own.parts).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`);
  const head = `made: ${own.made} of ${own.moments} moments (${percent(own.made, own.moments)}%) carry a made element${kinds.length ? ` (${kinds.join(", ")})` : " (cut-out, drawn graphic, shape, particle or designed type)"}`;
  const used = deck?.used ?? [], unused = deck?.unused ?? [];
  const cards = used.length + unused.length ? ` · deck: ${unused.length} of ${used.length + unused.length} cards unused${unused.length ? ` (${unused.slice(0, 8).join(", ")}${unused.length > 8 ? ", ..." : ""})` : ""}` : "";
  const beside = refs.length ? ` · drawn graphic: yours ${own.parts.graphic} of ${own.moments} moments, your ${refs.length} reference${refs.length === 1 ? "'s" : "s'"} made label${refs.length === 1 ? "" : "s"} ${refs.map((ref) => `${ref.made} of ${ref.total}`).join(", ")}` : "";
  return `${head}${cards}${beside}`;
}
