// seen_before (warning): a moment of this scene with designed type or a logo repeats a moment kino
// already rendered in another project (house memory, backend/house-memory.mjs, given as ctx.house:
// [{projectId, name, rev, moments: [{t, sig}]}]). The same choice in every project is the tell.
// A saved reference of this project closer to the moment than the old one backs it
// (ctx.referenceSignatures, engine/quality/layoutSignature.js referenceSignature).
// ending_seen (warning): the same, in the closing stretch (the last 15% or the spine's end beat) of
// the video's scene (ctx.videoScene; another scene's tail stays seen_before).
// It keeps one of the 3 slots however close the mid-video hits are, and only the person's words
// waive it (backend/agent/translate.mjs VIEWER_WAIVERS): a repeated ending is what a viewer keeps.
// seen_before also warns once when the video's scene is built like another kino edit
// (structureSignature.js, saved as `structure` in the house file): the same cut rate per song
// section and 75% or more of the compared parts (first drop, burst, effect order, ending, title, colors).
// Parts that only follow the song (a steady pace, a plain cut on the drop, a plain ending) are not
// compared, and the hint never asks for an effect: a part changes only by a cue or event that motivates it.
// type_seen (warning): the video's type look (typeSignature.js: face, weight, case, size, how it comes
// in; saved as `type` in the house file) matches one of the last 3 projects'. kino has no default
// type look, so a reused one needs a reference or treatment that chose it; an agent waives it only
// with a reason naming the reference (translate.mjs).
import { hasDesigned, layoutDistance, layoutMoments, layoutSignature, SIGNATURE_VERSION, signatureDistance, withoutUnder } from "../layoutSignature.js";
import { partWords, sameStructure, STRUCTURE_VERSION, structureAlike, structureSignature } from "../structureSignature.js";
import { sameType, TYPE_PARTS, TYPE_VERSION, typeAlike, typeSignature } from "../typeSignature.js";

// Under this distance (layoutDistance: places and sizes, or the coarse shape) two moments read as
// the same layout. Calibrated on kino's own projects: one end card in two videos 0.1, a chart or
// footage with captions against it 0.6 to 0.8, under 3% of other moments warn.
export const SEEN_THRESHOLD = 0.12;
const MAX_FINDINGS = 3;
// The closing stretch: the last share of the video.
const CLOSING_SHARE = 0.15;
// Under this signature distance a layout is the same one still on (layoutMoments' own step).
const HELD = 0.03;
// How often a layout held into the closing stretch is sampled to see it never left (seconds).
const HELD_STEP = 0.5;

// One run's hits, shared by both rules (one house comparison per check).
const hitsByRun = new WeakMap();

function seenHits(model, ctx) {
  const cached = hitsByRun.get(ctx);
  if (cached?.model === model) return cached.hits;
  const house = (ctx.house ?? []).filter((entry) => Array.isArray(entry.moments) && entry.moments.length);
  const references = (ctx.referenceSignatures ?? []).filter(Boolean);
  const endBeats = (ctx.style?.spine ?? []).filter((beat) => beat?.role === "end" && Number.isFinite(beat.from));
  const closingFrom = model.duration * (1 - CLOSING_SHARE);
  const moments = house.length ? layoutMoments(model, { every: 1, max: 60 }) : [];
  // The layout on screen when the closing stretch begins is a closing moment too when it came in
  // before it (layoutMoments keeps one moment for a layout held unchanged): only the last moment
  // before the stretch, and only when it stayed on without a break until the stretch.
  const lastBefore = moments.filter((moment) => moment.t <= closingFrom).at(-1);
  const sameAt = (t) => signatureDistance(lastBefore.sig, layoutSignature(model, t)) < HELD;
  const steps = (moment) => Array.from({ length: Math.floor((closingFrom - moment.t) / HELD_STEP) }, (_, index) => moment.t + (index + 1) * HELD_STEP);
  const heldIn = (moment) => moment === lastBefore && sameAt(closingFrom) && steps(moment).every(sameAt);
  // Only the video's scene has an ending (quality.mjs videoScene: not a format variant or another scene).
  const closing = (moment) => ctx.videoScene === true && (moment.t >= closingFrom
    || endBeats.some((beat) => moment.t >= beat.from && moment.t <= (Number.isFinite(beat.to) ? beat.to : model.duration))
    || heldIn(moment));
  const found = [];
  for (const moment of moments) {
    if (!hasDesigned(moment.sig)) continue;
    // House files older than signature format 2 have no `o` (type under a cut-out): compare without it.
    const plain = withoutUnder(moment.sig);
    let best = null;
    for (const entry of house) for (const old of entry.moments) {
      const current = entry.sigVersion >= SIGNATURE_VERSION;
      const distance = layoutDistance(current ? moment.sig : plain, current ? old.sig : withoutUnder(old.sig));
      if (!best || distance < best.distance) best = { distance, entry, old };
    }
    if (!best || best.distance >= SEEN_THRESHOLD) continue;
    if (references.some((reference) => layoutDistance(moment.sig, reference) <= best.distance)) continue;
    // One finding per stretch: a moment next to one already found is the same repeat.
    if (found.some((finding) => Math.abs(finding.at - moment.t) <= 1.5)) continue;
    found.push({ at: moment.t, sig: moment.sig, closing: closing(moment), ...best });
  }
  const byDistance = (a, b) => a.distance - b.distance;
  // The closest closing hit is the ending (the latest of equals); the others are the same ending again.
  const ending = found.filter((hit) => hit.closing).sort((a, b) => byDistance(a, b) || b.at - a.at).slice(0, 1);
  const middle = found.filter((hit) => !hit.closing).sort(byDistance).slice(0, MAX_FINDINGS - ending.length);
  const hits = { ending, middle };
  hitsByRun.set(ctx, { model, hits });
  return hits;
}

const measured = (hit) => `layout distance ${hit.distance} to "${hit.entry.name}" r${hit.entry.rev} at ${hit.old.t} s`;
const REQUIRED = `${SEEN_THRESHOLD} or more from kino's other projects, unless a saved reference is closer`;

// The video's whole structure (structureSignature.js) against each other project's saved one: the
// closest that reads as the same structure, as one finding.
function structureHit(model, ctx) {
  if (ctx.videoScene !== true) return [];
  const house = (ctx.house ?? []).filter((entry) => entry.structure && entry.structVersion === STRUCTURE_VERSION);
  if (!house.length) return [];
  const mine = structureSignature(model, { markers: ctx.cues ?? [], beats: ctx.beatCues ?? [] });
  if (!mine) return [];
  const best = house.map((entry) => ({ entry, ...structureAlike(mine, entry.structure) })).filter(sameStructure)
    .sort((a, b) => b.alike.length / b.compared.length - a.alike.length / a.compared.length)[0];
  if (!best) return [];
  const { entry, alike, compared } = best;
  return [{
    rule: "seen_before", severity: "warn", at: 0, measured: `alike in ${alike.length} of ${compared.length} parts (${partWords(alike)}) to "${entry.name}" r${entry.rev}`,
    required: "under 75% of the compared parts alike to another kino edit (parts that only follow the song are not compared)",
    message: `${ctx.sceneName} is built like "${entry.name}" (r${entry.rev}): alike in ${partWords(alike)}. Two kino edits shaped the same read as made by a machine.`,
    fix: { kind: "hint", text: `Rebuild a part only from this song's cues or this footage's own events (a different seam, a real impact or light in the shot, the payoff shot), not from the last edit. Never add an effect or move a cut off a seam just to differ; removing a habit is fine. Waive it when the song makes the two edits alike.` },
  }];
}

export function seenBefore(model, ctx) {
  return [...seenHits(model, ctx).middle.map((hit) => ({
    rule: "seen_before", severity: "warn", at: hit.at, measured: measured(hit), required: REQUIRED,
    message: `${ctx.sceneName} at ${hit.at} s repeats a layout kino already made in "${hit.entry.name}" (r${hit.entry.rev}, ${hit.old.t} s): distance ${hit.distance}. The same choice in every project reads as made by a machine.`,
    fix: { kind: "hint", text: `Rebuild this moment from this video's own material, or from a reference's technique (look {mode:"versus"}); restyling the same arrangement does not count. Waive it when the repeat is wanted.` },
  })), ...structureHit(model, ctx)];
}

// The last projects whose type look type_seen compares against (newest first by savedAt).
export const TYPE_RECENT = 3;

export function typeSeen(model, ctx) {
  if (ctx.videoScene !== true) return [];
  const recent = (ctx.house ?? []).filter((entry) => entry.type && entry.typeVersion === TYPE_VERSION)
    .sort((a, b) => String(b.savedAt ?? "").localeCompare(String(a.savedAt ?? ""))).slice(0, TYPE_RECENT);
  if (!recent.length) return [];
  const mine = typeSignature(model);
  const match = mine ? recent.find((entry) => sameType(mine, entry.type)) : null;
  if (!match) return [];
  const alike = typeAlike(mine, match.type);
  const look = `${mine.family}, ${mine.weight}, ${mine.case}, ${mine.size}, ${mine.reveal} in`;
  return [{
    rule: "type_seen", severity: "warn", at: 0, measured: `type look (${look}) alike in ${alike.length} of ${TYPE_PARTS.length} parts (${alike.join(", ")}) to "${match.name}" r${match.rev}`,
    required: "a type look unlike the last projects' (face plus 4 of 5 parts: face, weight, case, size, reveal), unless a saved reference or the picked treatment chose it",
    message: `${ctx.sceneName}: the type (${look}) is the look of "${match.name}" (r${match.rev}), one of kino's last projects. The same type in every project reads as made by a machine, and kino has no default look.`,
    fix: { kind: "hint", text: `Take the type from this video's own references and footage: study how the references set their type (face, weight, case, size, how it comes in) and set this video's from one of them, or from the picked treatment's type direction. Keep it when a reference chose it: waive_check type_seen with a reason naming the reference (yt:<id>).` },
  }];
}

export function endingSeen(model, ctx) {
  return seenHits(model, ctx).ending.map((hit) => {
    // Was the old moment that project's ending too (in the last share of what it kept of that scene)?
    const kept = hit.entry.moments.filter((moment) => moment.scene === hit.old.scene).map((moment) => moment.t);
    const theirEnding = hit.old.t >= Math.max(...kept) * (1 - CLOSING_SHARE);
    const under = hit.sig.items.some((item) => item.o === 1) ? " (name under a cut-out subject)" : "";
    const payoff = (ctx.style?.spine ?? []).filter((beat) => beat?.role === "payoff").at(-1);
    const purpose = String(payoff?.purpose ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return {
      rule: "ending_seen", severity: "warn", at: hit.at, measured: measured(hit), required: REQUIRED,
      message: `${ctx.sceneName}: this ending's layout matches ${theirEnding ? "an earlier project's ending" : "a layout of an earlier project"}${under}, "${hit.entry.name}" r${hit.entry.rev} at ${hit.old.t} s. A repeated ending is what a viewer remembers as made by a machine.`,
      fix: { kind: "hint", text: `End on this video's own payoff material${payoff && purpose ? `: the payoff "${purpose}" (${payoff.from}s)` : ""}. Change it now (a different shot, place or reveal for the name, not a restyle); do not ask to keep it unless the person asked for this ending: only their own words waive it (waive_check with quote).` },
    };
  });
}
