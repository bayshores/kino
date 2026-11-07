// reference_drift (warning): how far the rendered scene is from the project's saved references,
// measured the same way (backend/measure: Apple Vision on a Mac). It runs only when the project has
// saved Inspire references with a fingerprint and kino can measure frames here
// (ctx.references and ctx.measureRender, given by backend/agent/quality.mjs).
//
// kino renders pairs of frames 1/12 s apart, every half second (at most 120 pairs, 640 px wide,
// the size references are measured at, so small captions read the same):
// flow within each pair (is the picture still or moving), text on the first frame of each pair,
// a feature print once a second. The comparison is referenceCompare.js. Text measures can raise
// the warning on their own; motion and closeness only advise, so they raise it only when at least
// two of them agree.
import { compareFingerprints } from "../referenceCompare.js";

export const PAIR_SPACING = 0.5;
export const MAX_PAIRS = 120;
export const MEASURE_WIDTH = 640;
const PAIR_GAP = 1 / 12;

/** The [a, b] frame times kino measures in a scene `duration` seconds long. */
export function pairTimes(duration) {
  const spacing = Math.max(PAIR_SPACING, duration / MAX_PAIRS);
  const pairs = [];
  for (let time = 0.25; time + PAIR_GAP < duration; time += spacing) pairs.push([Math.round(time * 1000) / 1000, Math.round((time + PAIR_GAP) * 1000) / 1000]);
  return pairs;
}

/** Whether the rows say the render has drifted: a text row off, or two advice rows off. */
export function drifted(rows) {
  const off = rows.filter((row) => row.off);
  return off.some((row) => row.drives) || off.filter((row) => !row.drives).length >= 2;
}

export async function referenceDrift(model, ctx) {
  const references = ctx.references ?? [];
  if (!references.length || !ctx.measureRender || !ctx.renderFrames) return [];
  const width = Math.min(MEASURE_WIDTH, model.width);
  // ctx.measureRender renders the frames itself at `width` (null while it measures in the background).
  const measured = await ctx.measureRender(pairTimes(model.duration), { seconds: model.duration, width });
  if (!measured?.fingerprint) return [];
  const rows = compareFingerprints(measured.fingerprint, references, { renderPrints: measured.prints });
  if (!drifted(rows)) return [];
  const names = references.map((reference) => reference.id).join(", ");
  const off = rows.filter((row) => row.off);
  return [{
    rule: "reference_drift", severity: "warn",
    measured: off.map((row) => row.line).join("; "),
    required: `near the saved references (${names})`,
    message: `${ctx.sceneName} is far from its references (${names}): ${rows.map((row) => `${row.off ? "OFF " : ""}${row.line}${row.drives ? "" : " (advice)"}`).join("; ")}.`,
    fix: { kind: "hint", text: `Look at how the references do it: look {mode:"reference", ref:"${references[0].id}"}, then change the scene toward them, or waive this if the difference is wanted.` },
  }];
}
