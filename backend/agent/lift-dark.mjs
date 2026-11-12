// lift_dark (edit op): renders a few frames of each named shot and of the scene's other shots, works
// out a lift curve from the shot's own tones toward a target mean (engine/quality/liftDark.js) and
// adds it as ordinary effects: a curves <layer>.lift and, for a lift of a stop or more, a grain
// <layer>.lift-grain. Calling it again replaces both; remove:true takes them off.
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { enabledAnimations } from "../../engine/animationEnabled.js";
import { mainScene } from "../../engine/board.js";
import { coveredAt } from "../../engine/quality/techniques.js";
import { area, boxAt, intersection, visibleBoxAt } from "../../engine/quality/model.js";
import { blockiness, blockStep, cropFrame, deblockFor, gammaToMean, liftDeblockId, liftGrainId, liftId, liftShot, lumaStats, sourceGrid } from "../../engine/quality/liftDark.js";

// 240 px wide: wider than match_references' 160, so the 2nd and 98th percentiles have pixels to stand on.
const MEASURE_WIDTH = 240;
// With no other shot to follow and no target: about the middle of a lit video's mean luma (a guess).
const FALLBACK_TARGET = 100;
// Frames a shot's tones are read from: on six lifted night shots, 3 frames read up to 3.0 levels off
// 8 full-size frames across the shot, 6 frames up to 0.6 off 12. The block step reads BLOCK_FRAMES
// of them at full size.
const PER_SHOT = 6;
const BLOCK_FRAMES = 3;
// Another picture counts as a shot to follow when it covers a fifth of the frame or more: a 16:9 clip
// across a 9:16 frame covers 32%; a small inset or a logo does not set the brightness.
const OTHER_SHARE = 0.2;

const isPicture = (item) => item.kind === "video" || item.kind === "image";

// Effects that move a shot's tones: another one on the layer or its groups lifts or darkens the
// shot before (or after) the lift, so the receipt names it with the shot's mean without and with it.
const TONE_EFFECTS = new Set(["color-grade", "curves", "lut", "color-wheels", "color-look"]);

/**
 * The tone effects on `layerId` and the groups around it in an expanded scene, other than the
 * lift's own: [{id, effect}].
 */
export function otherGrades(scene, layerId) {
  const byId = new Map((scene?.layers ?? []).map((layer) => [layer.id, layer]));
  const own = new Set([liftDeblockId(layerId), liftId(layerId), liftGrainId(layerId)]);
  const found = [];
  for (let at = byId.get(layerId), seen = new Set(); at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : null) {
    seen.add(at.id);
    for (const animation of enabledAnimations(at.animations ?? [])) if (animation.kind === "effect" && TONE_EFFECTS.has(animation.effect) && !own.has(animation.id)) found.push({ id: animation.id, effect: animation.effect });
  }
  return found;
}

/**
 * The scene's pictures (video and image layers) as the viewer sees them: where each is shown whole
 * (opacity 0.9 or more) and not hidden under a full-frame picture above it, PER_SHOT times spread
 * over those samples, each with the part of the frame the picture covers then, so letterbox bars, a
 * backdrop or the frame around an inset are not measured as the shot ([{layerId, name, times, boxes, share, first}]).
 */
export function pictureShots(model) {
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const shots = [];
  for (const item of model.items) {
    if (!isPicture(item) || item.isMask || !item.source?.layerId || item.source.componentPath) continue;
    const shown = [];
    for (let index = 0; index < model.times.length; index += 1) {
      if (item.samples.opacity[index] < 0.9 || coveredAt(model, item, index)) continue;
      const box = intersection(visibleBoxAt(model, item, index), frame);
      if (area(box) > 0) shown.push({ time: model.times[index], box });
    }
    if (!shown.length) continue;
    const picked = [...new Set(Array.from({ length: PER_SHOT }, (_, step) => Math.min(shown.length - 1, Math.floor(((step + 0.5) / PER_SHOT) * shown.length))))].map((index) => shown[index]);
    const share = Math.max(...picked.map((entry) => area(entry.box))) / area(frame);
    // wholes: the picture's own box at each picked time (not cut by the frame edge), where its source
    // pixels sit; a picture that moves or zooms puts its codec grid somewhere else on each frame.
    shots.push({ layerId: item.source.layerId, name: item.name ?? item.source.layerId, times: picked.map((entry) => entry.time), boxes: picked.map((entry) => entry.box), wholes: picked.map((entry) => boxAt(item, model.times.indexOf(entry.time))), video: item.kind === "video", share, first: shown[0].time });
  }
  return shots.sort((a, b) => a.first - b.first);
}

const levels255 = (value) => Math.round(value * 255);

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/** The lift effects in a scene on `layerIds`: [{layerId, id}]. */
export function liftEffects(scene, layerIds) {
  const ids = new Set(layerIds.flatMap((layerId) => [liftDeblockId(layerId), liftId(layerId), liftGrainId(layerId)]));
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
export async function liftDark(document, { sceneId = null, layerIds = [], target = null, grain = null, remove = false, reduced = null, fonts, render, runOps, sourceSize = () => null, name = (id) => id }) {
  const scene = sceneId ? document.scenes.find((entry) => entry.id === sceneId) : mainScene(document);
  if (!scene) return { document, lines: [], lifted: [] };
  const old = liftEffects(scene, layerIds);
  const base = old.length ? await runOps(document, old.map((effect) => ({ op: "delete_animation", animationId: effect.id }))) : document;
  if (remove) return { document: base, lines: [`lift_dark: took off ${old.length} lift effect${old.length === 1 ? "" : "s"}`], lifted: [] };
  const model = kinoTimeline(base, scene.id, { fonts });
  const shots = pictureShots(model);
  const baseScene = base.scenes.find((entry) => entry.id === scene.id);
  // A named layer that is never shown whole is measured over its own time, on the whole frame.
  const own = layerIds.map((layerId) => shots.find((shot) => shot.layerId === layerId) ?? ownShot(baseScene, layerId)).filter(Boolean);
  const others = shots.filter((shot) => !layerIds.includes(shot.layerId) && shot.share >= OTHER_SHARE);
  const all = [...own, ...others];
  // A video's source pixels on the scene at each picked time, from its box and the file's size
  // (sourceGrid: drawn whole and centered in the box); none when either is unknown. Its frames are
  // then cut to the picture itself: the bars a contained clip leaves in its box (a 16:9 clip in a
  // 9:16 box) are neither its tones nor its blocks.
  const grids = new Map();
  for (const shot of all) {
    const size = shot.video && shot.wholes ? await sourceSize(shot.layerId) : null;
    const placed = (shot.wholes ?? []).map((whole, index) => {
      const grid = sourceGrid(whole, size);
      const picture = grid && { x0: grid.x0, y0: grid.y0, x1: grid.x0 + size.width * grid.pitchX, y1: grid.y0 + size.height * grid.pitchY };
      const box = grid && (shot.boxes?.[index] ? intersection(shot.boxes[index], picture) : picture);
      return grid && area(box) > 0 ? { ...grid, box } : null;
    });
    if (!placed.length || !placed.every(Boolean)) continue;
    shot.boxes = placed.map((entry) => entry.box);
    if (own.includes(shot)) grids.set(shot.layerId, placed);
  }
  const times = all.flatMap((shot) => shot.times);
  const width = Math.min(MEASURE_WIDTH, model.width);
  const scale = width / model.width;
  // Each shot's frames cut to the picture's own box (the whole frame when it fills it).
  const framesOf = (shot, frames) => shot.times.map((_, index) => cropFrame(frames?.[shot.at + index], shot.boxes?.[index], scale)).filter(Boolean);
  const expanded = expandComponents(base, scene.id, { fonts });
  const frames = times.length ? await render(expanded, times, { width }) : [];
  let offset = 0;
  for (const shot of all) {
    shot.at = offset;
    shot.frames = framesOf(shot, frames);
    offset += shot.times.length;
  }
  // Another grade already on a named shot (match_references' exposure, a hand grade, a group's
  // look): the shot's mean without those effects too, from one more render of those shots' frames.
  for (const shot of own) shot.grades = otherGrades(expanded, shot.layerId);
  const graded = own.filter((shot) => shot.grades.length && shot.frames.length);
  if (graded.length) {
    const drop = new Set(graded.flatMap((shot) => shot.grades.map((grade) => grade.id)));
    const bare = { ...expanded, layers: expanded.layers.map((layer) => ({ ...layer, animations: (layer.animations ?? []).filter((animation) => !drop.has(animation.id)) })) };
    const without = await render(bare, graded.flatMap((shot) => shot.times), { width });
    let at = 0;
    for (const shot of graded) {
      shot.bare = lumaStats(shot.times.map((_, index) => cropFrame(without[at + index], shot.boxes?.[index], scale)).filter(Boolean));
      at += shot.times.length;
    }
  }
  const otherMean = median(others.map((shot) => lumaStats(shot.frames)?.mean));
  const aim = Number.isFinite(target) ? target / 255 : otherMean ?? FALLBACK_TARGET / 255;
  // One range for the target and every mean: full range 0-255 (Rec. 709 luma of the rendered RGB),
  // with the target's video-range level (16-235, what a meter on the encoded file reads) beside it.
  const range = `full range 0-255; video range 16-235: ${Math.round(16 + aim * 219)}`;
  const aimLine = Number.isFinite(target) ? `target ${target} (${range})` : otherMean !== null ? `target ${levels255(otherMean)} (median of ${others.length} other shot${others.length === 1 ? "" : "s"}; ${range})` : `target ${FALLBACK_TARGET} (a starting guess, no other shot to follow; target:<0-255> sets it; ${range})`;
  const pitchOf = (layerId) => (grids.has(layerId) ? grids.get(layerId)[0].pitchX : 1);
  // Block steps are read at full scene size (a 240 px frame cannot show a 16 px block), inside the
  // shot's box, on the shot's layer drawn alone: text, other pictures and overlays on top add steps
  // of their own that hide the source's blocks (the stair shot: 1.97 alone, 0.93 under its caption).
  // The shots are drawn together in one full-size render (each at its own times) unless another
  // named shot shows over its box at one of them; such a shot gets a render of its own.
  const gridded = own.filter((shot) => grids.has(shot.layerId));
  const itemOf = (layerId) => model.items.find((item) => item.source?.layerId === layerId && !item.source.componentPath);
  // BLOCK_FRAMES of the shot's sampled times, spread over them (full-size frames are the slow part).
  const blockPicks = (shot) => [...new Set(Array.from({ length: Math.min(BLOCK_FRAMES, shot.times.length) }, (_, step) => Math.floor(((step + 0.5) / Math.min(BLOCK_FRAMES, shot.times.length)) * shot.times.length)))];
  const meets = (shot, other) => shot.times.some((time, index) => {
    const item = itemOf(other.layerId), at = model.times.indexOf(time);
    return item && at >= 0 && item.samples.opacity[at] > 0.001 && area(intersection(visibleBoxAt(model, item, at), shot.boxes[index])) > 0;
  });
  const together = gridded.filter((shot) => !gridded.some((other) => other !== shot && meets(shot, other)));
  const renderGroups = [...(together.length ? [together] : []), ...gridded.filter((shot) => !together.includes(shot)).map((shot) => [shot])];
  // sides: layer id → the block side to measure (null: find it), for the shots to measure.
  const blocksAll = async (document, sides) => {
    const found = new Map();
    const drawn = expandComponents(document, scene.id, { fonts });
    for (const group of renderGroups.map((shots) => shots.filter((shot) => sides.has(shot.layerId))).filter((shots) => shots.length)) {
      const frames = await render(alone(drawn, group.map((shot) => shot.layerId)), group.flatMap((shot) => blockPicks(shot).map((index) => shot.times[index])), { width: model.width });
      let at = 0;
      for (const shot of group) {
        const picks = blockPicks(shot), shotFrames = frames.slice(at, at + picks.length), grid = picks.map((index) => grids.get(shot.layerId)[index]), side = sides.get(shot.layerId);
        at += picks.length;
        found.set(shot.layerId, side ? blockStep(shotFrames, grid.map((entry) => ({ ...entry, side }))) : blockiness(shotFrames, grid));
      }
    }
    return found;
  };
  const blocksBefore = await blocksAll(base, new Map(gridded.map((shot) => [shot.layerId, null])));
  const still = reduced ?? Boolean(baseScene?.composition?.reduced);
  const lifted = [], skipped = [];
  for (const shot of own) {
    const lift = liftShot(shot.frames, aim, { sourceScale: pitchOf(shot.layerId) });
    if (!lift) { skipped.push(shot); continue; }
    const amount = grain === false ? null : Number.isFinite(grain) ? grain : lift.grain?.amount ?? null;
    const blocks = blocksBefore.get(shot.layerId) ?? null;
    lifted.push({ ...shot, ...lift, amount, size: lift.grain?.size ?? 1, gamma: gammaToMean(shot.frames, lift.after.mean), blocks, deblock: deblockFor(blocks, pitchOf(shot.layerId)) });
  }
  const ops = lifted.flatMap((entry) => [
    // Before the curve, so the steps are smoothed at the source's own levels.
    ...(entry.deblock ? [{ op: "add_animation", layerId: entry.layerId, id: liftDeblockId(entry.layerId), effect: "deblock", start: 0, duration: scene.duration, parameters: entry.deblock }] : []),
    { op: "add_animation", layerId: entry.layerId, id: liftId(entry.layerId), effect: "curves", start: 0, duration: scene.duration, parameters: { master: entry.curve } },
    ...(entry.amount ? [{ op: "add_animation", layerId: entry.layerId, id: liftGrainId(entry.layerId), effect: "grain", start: 0, duration: scene.duration, parameters: { amount: entry.amount, size: entry.size, seed: seedOf(entry.layerId), ...(still ? { animated: false } : {}) } }] : []),
  ]);
  let after = base;
  if (ops.length) {
    after = await runOps(base, ops);
    // The receipt's "after" is the render (overlays and the frame finish included), not the model.
    const drawn = await render(expandComponents(after, scene.id, { fonts }), times, { width });
    for (const entry of lifted) entry.after = lumaStats(framesOf(entry, drawn)) ?? entry.after;
    const blocksAfter = await blocksAll(after, new Map(lifted.filter((entry) => entry.blocks).map((entry) => [entry.layerId, entry.blocks.side])));
    for (const entry of lifted) if (blocksAfter.has(entry.layerId)) entry.blocksAfter = blocksAfter.get(entry.layerId);
  }
  const seconds = (value) => Math.round(value * 100) / 100;
  const span = (entry) => entry.times.length > 1 ? ` over ${seconds(entry.times[0])} to ${seconds(entry.times.at(-1))} s` : entry.times.length ? ` at ${seconds(entry.times[0])} s` : "";
  // Measured on the whole edit (overlays, the layer's other effects and its groups' included) at a
  // small width: video pictures are decoded alike at every width (media-probe.mjs pictureScale).
  const measured = (entry) => `measured on the edit's render at ${width} px wide (${entry.times.length} frame${entry.times.length === 1 ? "" : "s"}${span(entry)})`;
  const gradeNote = (entry) => entry.bare ? `, on top of ${entry.grades.map((grade) => `${grade.id} (${grade.effect})`).join(", ")} already there: ${levels255(entry.bare.mean)} without ${entry.grades.length === 1 ? "it" : "them"}, ${levels255(entry.before.mean)} with` : "";
  const level = (value) => Math.round(value * 100) / 100;
  const blockLine = (entry) => !entry.blocks ? ""
    : `, block step (${entry.blocks.side} px grid, levels on the grid lines over inside the blocks) ${level(entry.blocks.step)} to ${entry.blocksAfter ? level(entry.blocksAfter.step) : "?"}${entry.deblock ? `, deblock radius ${entry.deblock.radius} threshold ${entry.deblock.threshold}` : " (no deblock: under the 1.5x line)"}`;
  const shotLine = (entry) => `${name(entry.layerId)} mean ${levels255(entry.before.mean)} to ${levels255(entry.after.mean)} ${measured(entry)}${gradeNote(entry)}, contrast (p90-p10) ${levels255(entry.before.contrast)} to ${levels255(entry.after.contrast)}, black ${levels255(entry.before.p2)} to ${levels255(entry.after.p2)} (a plain gamma ${entry.gamma.gamma} to the same mean: contrast ${levels255(entry.gamma.stats.contrast)}, black ${levels255(entry.gamma.stats.p2)}); +${entry.stops} stops${entry.amount ? `, grain ${entry.amount} size ${entry.size}${still ? " still" : ""}` : ""}${blockLine(entry)}`;
  const keptGrade = (shot) => shot.bare ? ` (${levels255(shot.bare.mean)} without ${shot.grades.map((grade) => grade.id).join(", ")})` : "";
  const kept = skipped.length ? `; ${skipped.map((shot) => `${name(shot.layerId)} ${levels255(lumaStats(shot.frames)?.mean ?? 0)}${keptGrade(shot)}`).join(", ")} already at or above it, left alone` : "";
  const lines = [lifted.length
    ? `lift_dark ${aimLine}: ${lifted.map(shotLine).join("; ")}${kept}. Effects ${lifted.some((entry) => entry.deblock) ? "<layer>.lift-deblock (deblock), " : ""}<layer>.lift (curves) and <layer>.lift-grain; again replaces them, remove:true takes them off.`
    : `lift_dark ${aimLine}: nothing lifted${kept || ` (no frame of ${layerIds.map(name).join(", ")} measured)`}.`];
  return { document: after, lines, lifted };
}

// An expanded scene with only `layerId` (one id or a list) and the groups around it drawn (every
// other layer hidden), or the scene as it is when none is in it.
export function alone(scene, layerId) {
  const byId = new Map((scene?.layers ?? []).map((layer) => [layer.id, layer]));
  const keep = new Set();
  for (const id of [layerId].flat()) {
    const chain = new Set();
    for (let at = byId.get(id); at && !chain.has(at.id); at = at.parentId ? byId.get(at.parentId) : null) { chain.add(at.id); keep.add(at.id); }
  }
  if (!keep.size) return scene;
  return { ...scene, layers: scene.layers.map((layer) => (keep.has(layer.id) ? layer : { ...layer, visible: false })) };
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
