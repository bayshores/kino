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
import { readingTexts } from "../analysis.js";
import { backgroundLuma, plates, techniquesUsed, transitions } from "../techniques.js";

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

// ---------------------------------------------------------------- reference_closeness
//
// reference_closeness (warning) is reference_drift turned round for music edits: a reference lends
// principles (section statistics), never its arrangement. It warns when
//   - a run of COPY_RUN shots or more has a saved reference's shot lengths in order, at one scale
//     (each within a frame, the run not an even grid): the cut timing was copied;
//   - the scene shows every device of the pooled contest profile (POOLED_PROFILE: a black hole, a
//     flash on a seam, letterbox bars and word cards on a plain frame), or three of them in a row
//     in one of its orders (a drop stack lifted whole).
// ctx.closeRefs: the saved references' lent cuts [{id, seconds, cuts, fps}] (backend inspire
// savedRhythms). Pure: no pixels, so it runs in every check.

export const COPY_RUN = 6;
// Shot lengths that vary less than this (stdev / mean) are an even grid any beat edit can share.
const GRID_SPREAD = 0.15;
// The devices the contest entries studied for the anime plan share, and the orders they come in.
export const POOLED_PROFILE = Object.freeze({
  devices: ["black-hole", "seam-flash", "bars", "word-card"],
  orders: [["black-hole", "seam-flash", "word-card"], ["bars", "black-hole", "seam-flash"]],
});
const DEVICE_WORDS = { "black-hole": "a black hole before a hit", "seam-flash": "a flash on a seam", bars: "letterbox bars", "word-card": "word cards on a plain frame" };

/** The scene's shot change times (seconds, sorted): every plate change and every content cut. */
export function shotTimes(model) {
  const times = [...transitions(model).map((change) => change.at), ...(techniquesUsed(model).cut ?? []).map((entry) => entry.at)];
  const sorted = times.filter((time) => time > 0 && time < model.duration).sort((a, b) => a - b);
  // The same change found twice (one rounded to the hundredth) is one cut.
  return sorted.filter((time, index) => !index || time - sorted[index - 1] > 0.6 / model.fps);
}

const lengthsOf = (cuts, end) => [0, ...cuts, end].slice(1).map((time, index, list) => time - (index ? list[index - 1] : 0));
const spread = (values) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return mean > 0 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean : 0;
};

/**
 * The longest run of the scene's shot lengths that follows the reference's shot lengths in order at
 * one scale (0.5 to 2), each within `tolerance` seconds. Inner shots only (a cut on both sides).
 * Returns {run, at, scale} (at: the scene time the run starts) or null under 2 shots.
 */
export function copiedRun(sceneCuts, refCuts, { tolerance }) {
  const scene = sceneCuts.slice(1).map((time, index) => time - sceneCuts[index]);
  const ref = refCuts.slice(1).map((time, index) => time - refCuts[index]);
  let best = null;
  for (let i = 0; i < scene.length; i += 1) for (let j = 0; j < ref.length; j += 1) {
    const scale = scene[i] / ref[j];
    if (!(scale >= 0.5 && scale <= 2)) continue;
    let run = 0;
    while (i + run < scene.length && j + run < ref.length && Math.abs(scene[i + run] - ref[j + run] * scale) <= tolerance) run += 1;
    if (run >= 2 && (!best || run > best.run) && spread(ref.slice(j, j + run)) >= GRID_SPREAD) best = { run, at: sceneCuts[i], scale: Math.round(scale * 100) / 100 };
  }
  return best;
}

/** The pooled-profile devices the scene shows, as [{device, at}] by time. */
export function profileDevices(model) {
  const found = [];
  const used = techniquesUsed(model);
  const fps = model.fps;
  const shown = (item, index) => item.samples.opacity[index] >= 0.5;
  const plateAt = (index) => plates(model).some((plate) => shown(plate, index));
  const texts = readingTexts(model);
  // A black hole: 1 frame to 0.6 s with no picture and no words on a dark frame, between two shots.
  let run = 0;
  for (let index = 0; index < model.times.length; index += 1) {
    const dark = !plateAt(index) && backgroundLuma(model, index) < 0.1 && !texts.some((item) => shown(item, index));
    if (dark) { run += 1; continue; }
    if (run && run <= 0.6 * fps && index - run > 0) found.push({ device: "black-hole", at: model.times[index - run] });
    run = 0;
  }
  for (const entry of used["fade-black"] ?? []) found.push({ device: "black-hole", at: entry.at });
  // A flash on a seam: a flash transition, or a light plate within 0.1 s of a shot change.
  const changes = transitions(model).map((change) => change.at);
  for (const entry of used.flash ?? []) if (changes.some((time) => Math.abs(time - entry.at) <= 0.1)) found.push({ device: "seam-flash", at: entry.at });
  // Letterbox bars: dark shapes across the frame at the top or bottom, 4% to 20% of its height.
  for (const item of model.items) {
    if (item.kind === "text" || item.kind === "video" || item.kind === "image" || item.kind === "group" || item.isMask) continue;
    const index = item.samples.opacity.findIndex((value) => value >= 0.5);
    if (index < 0 || !(item.samples.luma?.[index] <= 0.15)) continue;
    const [x0, y0, x1, y1] = ["x0", "y0", "x1", "y1"].map((key) => item.samples[key][index]);
    const tall = (y1 - y0) / model.height;
    if (x1 - x0 >= 0.95 * model.width && tall >= 0.04 && tall <= 0.2 && (y0 <= 0.01 * model.height || y1 >= 0.99 * model.height)) found.push({ device: "bars", at: model.times[index] });
  }
  // Word cards: big type with no picture behind it.
  for (const entry of used["type-giant"] ?? []) {
    const index = Math.max(0, Math.min(model.times.length - 1, Math.round(entry.at * fps)));
    if (!plateAt(index)) found.push({ device: "word-card", at: entry.at });
  }
  return found.sort((a, b) => a.at - b.at);
}

// Three devices in a row in an order: each within 2 s of the one before.
function orderAt(devices, order) {
  for (const [start, first] of devices.entries()) {
    if (first.device !== order[0]) continue;
    let at = first.at, step = 1;
    for (const next of devices.slice(start + 1)) {
      if (next.at - at > 2) break;
      if (next.device === order[step]) { at = next.at; step += 1; if (step === order.length) return first.at; }
    }
  }
  return null;
}

export function referenceCloseness(model, ctx) {
  const findings = [];
  const tolerance = 1 / model.fps + 0.01;
  const cuts = shotTimes(model);
  for (const ref of ctx.closeRefs ?? []) {
    if (!Array.isArray(ref.cuts) || ref.cuts.length < COPY_RUN + 1) continue;
    const copied = copiedRun(cuts, ref.cuts, { tolerance });
    if (!copied || copied.run < COPY_RUN) continue;
    findings.push({
      rule: "reference_closeness", severity: "warn", at: copied.at,
      measured: `${copied.run} shots in a row from ${copied.at}s have ${ref.id}'s shot lengths in order (x${copied.scale})`,
      required: `under ${COPY_RUN} shots in a row timed like a reference`,
      message: `${ctx.sceneName} copies ${ref.id}'s cutting: ${copied.run} shots in a row from ${copied.at}s are its shot lengths in order, each within a frame. A reference lends its pace per section, not its arrangement.`,
      fix: { kind: "hint", text: `Cut on this song's seams and the footage's own action instead; borrow_rhythm {ref:"${ref.id}"} lends its section pace in a new order.` },
    });
  }
  const devices = profileDevices(model);
  const kinds = new Set(devices.map((entry) => entry.device));
  const order = POOLED_PROFILE.orders.map((list) => ({ list, at: orderAt(devices, list) })).find((entry) => entry.at !== null);
  if (POOLED_PROFILE.devices.every((device) => kinds.has(device)) || order) {
    const shownWords = (order ? order.list : POOLED_PROFILE.devices).map((device) => DEVICE_WORDS[device]);
    findings.push({
      rule: "reference_closeness", severity: "warn", ...(order ? { at: order.at } : {}),
      measured: order ? `${order.list.join(" then ")} from ${order.at}s` : `all of ${POOLED_PROFILE.devices.join(", ")}`,
      required: "not the pooled contest profile's device set or its order",
      message: `${ctx.sceneName} ${order ? `stacks ${shownWords.join(", then ")} within 2 s` : `uses every device of the pooled contest profile (${shownWords.join(", ")})`}: the set every entry shares reads as a copy. Keep the ones this song and footage motivate.`,
      fix: { kind: "hint", text: "Drop a device that no seam or footage event calls for; zero of any device is fine." },
    });
  }
  return findings;
}
