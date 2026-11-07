// seen_before (warning): a moment of this scene with designed type or a logo repeats a moment kino
// already rendered in another project (house memory, backend/house-memory.mjs, given as ctx.house:
// [{projectId, name, rev, moments: [{t, sig}]}]). The same choice in every project is the tell.
// A saved reference of this project closer to the moment than the old one backs it
// (ctx.referenceSignatures, engine/quality/layoutSignature.js referenceSignature).
import { hasDesigned, layoutDistance, layoutMoments } from "../layoutSignature.js";

// Under this distance two moments read as the same layout (calibrated on kino's own projects:
// copies of one video sit under 0.05; different videos' nearest moments mostly 0.13 to 0.3).
export const SEEN_THRESHOLD = 0.12;
const MAX_FINDINGS = 3;

export function seenBefore(model, ctx) {
  const house = (ctx.house ?? []).filter((entry) => Array.isArray(entry.moments) && entry.moments.length);
  if (!house.length) return [];
  const references = (ctx.referenceSignatures ?? []).filter(Boolean);
  const found = [];
  for (const moment of layoutMoments(model, { every: 1, max: 60 })) {
    if (!hasDesigned(moment.sig)) continue;
    let best = null;
    for (const entry of house) for (const old of entry.moments) {
      const distance = layoutDistance(moment.sig, old.sig);
      if (!best || distance < best.distance) best = { distance, entry, old };
    }
    if (!best || best.distance >= SEEN_THRESHOLD) continue;
    if (references.some((reference) => layoutDistance(moment.sig, reference) < best.distance)) continue;
    // One finding per stretch: a moment next to one already found is the same repeat.
    if (found.some((finding) => Math.abs(finding.at - moment.t) <= 1.5)) continue;
    found.push({ at: moment.t, distance: best.distance, ...best });
  }
  return found.sort((a, b) => a.distance - b.distance).slice(0, MAX_FINDINGS).map((hit) => ({
    rule: "seen_before", severity: "warn", at: hit.at,
    measured: `layout distance ${hit.distance} to "${hit.entry.name}" r${hit.entry.rev} at ${hit.old.t} s`,
    required: `${SEEN_THRESHOLD} or more from kino's other projects, unless a saved reference is closer`,
    message: `${ctx.sceneName} at ${hit.at} s repeats a layout kino already made in "${hit.entry.name}" (r${hit.entry.rev}, ${hit.old.t} s): distance ${hit.distance}. The same choice in every project reads as made by a machine.`,
    fix: { kind: "hint", text: `Rebuild this moment from this video's own material, or from a reference's technique (look {mode:"versus"}); restyling the same arrangement does not count. Waive it when the repeat is wanted.` },
  }));
}
