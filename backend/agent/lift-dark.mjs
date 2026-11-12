// lift_dark (edit op): renders a few frames of each named shot and of the scene's other shots, works
// out a lift curve from the shot's own tones toward a target mean (engine/quality/liftDark.js) and
// adds it as ordinary effects: a curves <layer>.lift and, for a lift of a stop or more, a grain
// <layer>.lift-grain. Calling it again replaces both; remove:true takes them off.
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { mainScene } from "../../engine/board.js";
import { gammaToMean, liftGrainId, liftId, liftShot, lumaStats } from "../../engine/quality/liftDark.js";
import { sceneShots } from "./exposure-match.mjs";

// 240 px wide: wider than match_references' 160, so the 2nd and 98th percentiles have pixels to stand on.
const MEASURE_WIDTH = 240;
// With no other shot to follow and no target: about the middle of a lit video's mean luma (a guess).
const FALLBACK_TARGET = 100;
const PER_SHOT = 3;

const levels255 = (value) => Math.round(value * 255);

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/** The lift effects in a scene on `layerIds`: [{layerId, id}]. */
export function liftEffects(scene, layerIds) {
  const ids = new Set(layerIds.flatMap((layerId) => [liftId(layerId), liftGrainId(layerId)]));
  return (scene?.layers ?? []).flatMap((layer) => (layer.animations ?? []).filter((animation) => ids.has(animation.id)).map((animation) => ({ layerId: layer.id, id: animation.id })));
}

// A small whole number from a layer id, so two lifted shots do not show the same grain.
const seedOf = (text) => [...String(text)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 100_000, 7);

/**
 * Runs the lift on `document`: {document, lines, lifted}. `target` is a mean luma 0 to 255 (left
 * out: the median of the scene's other shots), `grain` false leaves the grain off or a number sets
 * its amount. `render(scene, times, {width})` renders an expanded scene, `runOps(document, ops)`
 * applies ops as an edit would, `name(id)` the agent's name for an id.
 */
export async function liftDark(document, { sceneId = null, layerIds = [], target = null, grain = null, remove = false, fonts, render, runOps, name = (id) => id }) {
  const scene = sceneId ? document.scenes.find((entry) => entry.id === sceneId) : mainScene(document);
  if (!scene) return { document, lines: [], lifted: [] };
  const old = liftEffects(scene, layerIds);
  const base = old.length ? await runOps(document, old.map((effect) => ({ op: "delete_animation", animationId: effect.id }))) : document;
  if (remove) return { document: base, lines: [`lift_dark: took off ${old.length} lift effect${old.length === 1 ? "" : "s"}`], lifted: [] };
  const model = kinoTimeline(base, scene.id, { fonts });
  const shots = sceneShots(model);
  const baseScene = base.scenes.find((entry) => entry.id === scene.id);
  // A named layer that is never the top full-frame picture is measured over its own time.
  const own = layerIds.map((layerId) => shots.find((shot) => shot.layerId === layerId) ?? ownShot(baseScene, layerId)).filter(Boolean);
  const others = shots.filter((shot) => !layerIds.includes(shot.layerId));
  const all = [...own, ...others];
  const times = all.flatMap((shot) => shot.times);
  const width = Math.min(MEASURE_WIDTH, model.width);
  const frames = times.length ? await render(expandComponents(base, scene.id, { fonts }), times, { width }) : [];
  let offset = 0;
  for (const shot of all) {
    shot.frames = shot.times.map((_, index) => frames?.[offset + index]).filter(Boolean);
    shot.at = offset;
    offset += shot.times.length;
  }
  const otherMean = median(others.map((shot) => lumaStats(shot.frames)?.mean));
  const aim = Number.isFinite(target) ? target / 255 : otherMean ?? FALLBACK_TARGET / 255;
  const aimLine = Number.isFinite(target) ? `target ${target}` : otherMean !== null ? `target ${levels255(otherMean)} (median of ${others.length} other shot${others.length === 1 ? "" : "s"})` : `target ${FALLBACK_TARGET} (no other shot to follow; target:<0-255> sets it)`;
  const lifted = [], skipped = [];
  for (const shot of own) {
    const lift = liftShot(shot.frames, aim);
    if (!lift) { skipped.push(shot); continue; }
    const amount = grain === false ? null : Number.isFinite(grain) ? grain : lift.grain?.amount ?? null;
    lifted.push({ ...shot, ...lift, amount, size: lift.grain?.size ?? 1, gamma: gammaToMean(shot.frames, lift.after.mean) });
  }
  const ops = lifted.flatMap((entry) => [
    { op: "add_animation", layerId: entry.layerId, id: liftId(entry.layerId), effect: "curves", start: 0, duration: scene.duration, parameters: { master: entry.curve } },
    ...(entry.amount ? [{ op: "add_animation", layerId: entry.layerId, id: liftGrainId(entry.layerId), effect: "grain", start: 0, duration: scene.duration, parameters: { amount: entry.amount, size: entry.size, seed: seedOf(entry.layerId) } }] : []),
  ]);
  let after = base;
  if (ops.length) {
    after = await runOps(base, ops);
    // The receipt's "after" is the render (overlays and the frame finish included), not the model.
    const drawn = await render(expandComponents(after, scene.id, { fonts }), times, { width });
    for (const entry of lifted) entry.after = lumaStats(entry.times.map((_, index) => drawn?.[entry.at + index]).filter(Boolean)) ?? entry.after;
  }
  const shotLine = (entry) => `${name(entry.layerId)} mean ${levels255(entry.before.mean)} to ${levels255(entry.after.mean)}, contrast (p90-p10) ${levels255(entry.before.contrast)} to ${levels255(entry.after.contrast)}, black ${levels255(entry.before.p2)} to ${levels255(entry.after.p2)} (a plain gamma ${entry.gamma.gamma} to the same mean: contrast ${levels255(entry.gamma.stats.contrast)}, black ${levels255(entry.gamma.stats.p2)}); +${entry.stops} stops${entry.amount ? `, grain ${entry.amount}` : ""}`;
  const kept = skipped.length ? `; ${skipped.map((shot) => `${name(shot.layerId)} ${levels255(lumaStats(shot.frames)?.mean ?? 0)}`).join(", ")} already at or above it, left alone` : "";
  const lines = [lifted.length
    ? `lift_dark ${aimLine}: ${lifted.map(shotLine).join("; ")}${kept}. Effects <layer>.lift (curves) and <layer>.lift-grain; again replaces them, remove:true takes them off.`
    : `lift_dark ${aimLine}: nothing lifted${kept || ` (no frame of ${layerIds.map(name).join(", ")} measured)`}.`];
  return { document: after, lines, lifted };
}

// PER_SHOT scene times spread over a layer's own time in the scene, or null.
function ownShot(scene, layerId) {
  const layer = scene?.layers.find((entry) => entry.id === layerId);
  if (!layer) return null;
  const start = Math.max(0, Number(layer.start) || 0);
  const end = Math.min(Number(scene.duration) || 0, start + (Number(layer.duration) || Number(scene.duration) || 0));
  if (!(end > start)) return null;
  return { layerId, name: layer.name ?? layerId, times: Array.from({ length: PER_SHOT }, (_, step) => start + (end - start) * (step + 0.5) / PER_SHOT), first: start };
}
