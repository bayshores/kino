// deblock_upscaled (edit op): a punch-in blows the source's codec blocks up with the picture. For the
// named video and picture layers (left out: every one drawn over the ratio), this reads each shot's
// largest scale, measures the block step on the source's grid there (the measure lift_dark prints)
// and, when the steps on the grid lines stand out, adds an ordinary deblock effect
// <layer>.upscale-deblock over the stretch drawn over the ratio. The effect works in the layer's own
// units, so it smooths the blocks before the scale. Calling it again replaces the effects;
// remove:true takes them off. Nothing is added to a shot under the ratio or one with no blocks.
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { mainScene } from "../../engine/board.js";
import { UPSCALE_MAX, upscaledSamples } from "../../engine/quality/rules/footage.js";
import { blockFact, UPSCALE_DEBLOCK_SUFFIX, upscaleBlocks, upscaleDeblockId, upscaleShot } from "../../engine/quality/upscaleBlocks.js";
import { alone } from "./lift-dark.mjs";

const isPicture = (item) => item.kind === "video" || item.kind === "image";
const hundredth = (value) => Math.round(value * 100) / 100;

/**
 * Runs the deblock on `document`: {document, lines, shots}. `layerIds` names the layers (empty: every
 * picture drawn over `ratio` times its file), `render(scene, times, {width})` renders an expanded
 * scene, `runOps(document, ops)` applies ops as an edit would, `sourceSize(layerId)` the file's
 * {width, height} (null when unknown), `name(id)` the agent's name for an id.
 */
export async function deblockUpscaled(document, { sceneId = null, layerIds = [], ratio = UPSCALE_MAX, remove = false, fonts, render, runOps, sourceSize = async () => null, name = (id) => id }) {
  const scene = sceneId ? document.scenes.find((entry) => entry.id === sceneId) : mainScene(document);
  if (!scene) return { document, lines: [], shots: [] };
  const old = scene.layers.flatMap((layer) => (layer.animations ?? []).filter((animation) => String(animation.id).endsWith(UPSCALE_DEBLOCK_SUFFIX) && (!layerIds.length || layerIds.includes(layer.id))).map((animation) => animation.id));
  const base = old.length ? await runOps(document, old.map((animationId) => ({ op: "delete_animation", animationId }))) : document;
  if (remove) return { document: base, lines: [`deblock_upscaled: took off ${old.length} deblock effect${old.length === 1 ? "" : "s"}`], shots: [] };
  const model = kinoTimeline(base, scene.id, { fonts });
  const items = model.items.filter((item) => isPicture(item) && !item.isMask && item.source?.layerId && !item.source.componentPath && (!layerIds.length || layerIds.includes(item.source.layerId)));
  const drawn = expandComponents(base, scene.id, { fonts });
  const shots = [], left = [];
  for (const item of items) {
    const layerId = item.source.layerId;
    const size = await sourceSize(layerId);
    if (!size) { if (layerIds.length) left.push(`${name(layerId)} (its file's size is unknown)`); continue; }
    const shot = upscaleShot(model, item, size, ratio);
    if (!shot) {
      if (layerIds.length) {
        const largest = Math.max(0, ...upscaledSamples(model, item, size, 0).map((sample) => sample.magnified));
        left.push(`${name(layerId)} (drawn at most ${hundredth(largest)}x its file, not over ${ratio}x)`);
      }
      continue;
    }
    // The layer drawn alone at full size: text and other pictures on top add steps of their own.
    const found = upscaleBlocks((await render(alone(drawn, layerId), shot.times, { width: model.width })) ?? [], shot);
    shots.push({ ...shot, layerId, ...(found ?? { blocks: null, deblock: null }) });
  }
  const ops = shots.filter((shot) => shot.deblock).map((shot) => ({ op: "add_animation", layerId: shot.layerId, id: upscaleDeblockId(shot.layerId), effect: "deblock", start: hundredth(shot.from), duration: hundredth(Math.min(shot.to, scene.duration) - shot.from), parameters: shot.deblock }));
  const after = ops.length ? await runOps(base, ops) : base;
  if (ops.length) {
    const drawnAfter = expandComponents(after, scene.id, { fonts });
    for (const shot of shots.filter((entry) => entry.deblock)) shot.blocksAfter = upscaleBlocks((await render(alone(drawnAfter, shot.layerId), shot.times, { width: model.width })) ?? [], shot, shot.blocks.side)?.blocks ?? null;
  }
  const frames = (shot) => `${shot.times.length} full-size frame${shot.times.length === 1 ? "" : "s"}`;
  const shotLine = (shot) => `${name(shot.layerId)} drawn ${hundredth(shot.scale)}x at ${hundredth(shot.time)} s (${shot.across} of its ${shot.size.width} px file across the ${shot.frameWidth} px frame), ${shot.blocks ? `${blockFact(shot.blocks, shot.deblock, shot.blocksAfter)} on ${frames(shot)}` : "no block step measured"}${shot.deblock ? `, effect ${upscaleDeblockId(shot.layerId)} over ${hundredth(shot.from)} to ${hundredth(Math.min(shot.to, scene.duration))} s` : ""}`;
  const kept = left.length ? `; left alone: ${left.join(", ")}` : "";
  const lines = [shots.length
    ? `deblock_upscaled (shots drawn over ${ratio}x their file): ${shots.map(shotLine).join("; ")}${kept}. Again replaces the effects, remove:true takes them off.`
    : `deblock_upscaled: nothing drawn over ${ratio}x its file${layerIds.length ? "" : " in the scene"}${kept}.`];
  return { document: after, lines, shots };
}
