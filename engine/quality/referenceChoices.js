// Reference choices: four rules about taste measure against the project's own saved, studied
// references where kino has the measure, as reference_range does for brightness.
//
//   luma_jump     brightness jumps per 10 s against the references' flashes per 10 s (their lent
//                 rhythms, ctx.closeRefs: [{id, seconds, flashes}])
//   reading_time  how long a text is readable against the shortest time the references' lines
//                 stay on screen (fingerprint.text.limits.hold, seconds)
//   type_min      a text's drawn size against the references' smallest line height
//                 (fingerprint.text.limits.height, share of the frame height)
//   safe_zone     how close a text sits to the frame edge against the references' closest line
//                 (fingerprint.text.limits.edge, share of the frame side)
//
// When CHOICE_REFS or more references make the same choice at the same or greater strength, the
// finding stays listed, as advice (info) with the evidence, and its fix is no longer applied by
// check {fix:"auto"}. Where the edit goes past every reference, it keeps its level and says by how
// much. No measured references, no change. The photosensitivity gate (flashing) is never touched.
// Why: in five shot-for-shot rebuilds of human edits, check blocked choices the reference itself
// made (flash frames, type shown 0.3 to 0.47 s, 24 to 30 px labels, a caption near the edge):
// .scratch/recreate/GAPS.md, Friction 2.

/** Two references agreeing is a choice, not chance (the same count reference_range needs). */
export const CHOICE_REFS = 2;
export const CHOICE_RULES = Object.freeze(["luma_jump", "reading_time", "type_min", "safe_zone"]);

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const limitsOf = (ref) => ref?.fingerprint?.text?.limits ?? null;

// Per rule: the references that measured it [{id, value}], the edit's value for a finding, whether a
// reference value is as strong as the edit's (it goes as far or further), and how to say a value.
const MEASURES = {
  luma_jump: {
    refs: (ctx) => (ctx.closeRefs ?? []).filter((ref) => Number.isFinite(ref.flashes) && Number(ref.seconds) > 0)
      .map((ref) => ({ id: ref.id, value: (ref.flashes / ref.seconds) * 10, said: `${ref.flashes} flashes in ${round(ref.seconds, 1)} s` })),
    // One per distinct moment: two layers jumping on one frame are one flash.
    value: (finding, model, found) => (new Set(found.map((entry) => entry.at)).size / model.duration) * 10,
    asStrong: (ref, ours) => ref >= ours - 1e-9,
    show: (value) => `${round(value, 1)} per 10 s`,
    beyond: (bound, ours) => `${round(ours - bound, 1)} more per 10 s`,
  },
  reading_time: {
    refs: (ctx) => (ctx.choiceRefs ?? []).map((ref) => ({ id: ref.id, value: limitsOf(ref)?.hold })).filter((ref) => Number.isFinite(ref.value)),
    value: (finding) => Number(finding.measured),
    // Within half a frame at 12 samples a second (how the references were read).
    asStrong: (ref, ours) => ref <= ours + 1 / 24,
    show: (value) => `${round(value)} s`,
    beyond: (bound, ours) => `${round(bound - ours)} s shorter`,
    said: "their shortest text stays",
  },
  type_min: {
    refs: (ctx, model) => (ctx.choiceRefs ?? []).map((ref) => ({ id: ref.id, value: limitsOf(ref)?.height * model.height })).filter((ref) => Number.isFinite(ref.value)),
    value: (finding) => Number(finding.measured),
    // A reference's line box height is taken as its font size (a guess: a mixed-case line box
    // spans about one em), within a pixel.
    asStrong: (ref, ours) => ref <= ours + 1,
    show: (value) => `${Math.round(value)} px`,
    beyond: (bound, ours) => `${Math.round(bound - ours)} px smaller`,
    said: "their smallest text is",
  },
  safe_zone: {
    refs: (ctx) => (ctx.choiceRefs ?? []).map((ref) => ({ id: ref.id, value: limitsOf(ref)?.edge })).filter((ref) => Number.isFinite(ref.value)),
    // The share of the frame between the text and its nearest edge.
    value: (finding, model) => {
      const [x, y, w, h] = Array.isArray(finding.measured) ? finding.measured : [];
      if (![x, y, w, h].every(Number.isFinite)) return NaN;
      return Math.max(0, Math.min(x / model.width, y / model.height, (model.width - x - w) / model.width, (model.height - y - h) / model.height));
    },
    // Within 0.2% of the frame (2 px at 1080p).
    asStrong: (ref, ours) => ref <= ours + 0.002,
    show: (value) => `${round(value * 100, 1)}% from the edge`,
    beyond: (bound, ours) => `${round((bound - ours) * 100, 1)}% of the frame closer`,
    said: "their text sits as close as",
  },
};

/**
 * The findings of rule `code` with the references' evidence: advice where CHOICE_REFS or more
 * saved references go as far, a note of how far past them otherwise; unchanged without them.
 */
export function referenceChoices(code, found, model, ctx) {
  const measure = MEASURES[code];
  if (!measure || !Array.isArray(found) || !found.length) return found;
  const refs = measure.refs(ctx, model);
  if (refs.length < CHOICE_REFS) return found;
  return found.map((finding) => {
    if (finding.severity === "info" || finding.internal) return finding;
    const ours = measure.value(finding, model, found);
    if (!Number.isFinite(ours)) return finding;
    const backing = refs.filter((ref) => measure.asStrong(ref.value, ours));
    const evidence = (list) => list.map((ref) => `${ref.id} ${ref.said ?? measure.show(ref.value)}`).join("; ");
    if (backing.length >= CHOICE_REFS) {
      return {
        ...finding, severity: "info", reference: backing.map((ref) => ref.id),
        message: `${finding.message} Your references make the same choice (${measure.said ? `${measure.said} ` : ""}${evidence(backing)}), so it is advice.`,
        ...(finding.fix ? { fix: { ...finding.fix, auto: false } } : {}),
      };
    }
    // The strongest reference value: the bound the edit goes past.
    const bound = refs.map((ref) => ref.value).reduce((best, value) => (measure.asStrong(value, best) ? value : best));
    return { ...finding, message: `${finding.message} Your references go to ${measure.show(bound)} (${evidence(refs)}); this is ${measure.beyond(bound, ours)}.` };
  });
}
