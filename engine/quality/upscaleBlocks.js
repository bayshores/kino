// Blocks in an upscaled picture: a picture or clip drawn bigger than its file (a punch-in) blows the
// source's codec blocks up with it, a harder fault than the softness soft_upscale names. This reads
// where the file's pixels sit on the scene at the punch's largest scale, measures the block step on
// the source's grid there (the same measure lift_dark prints, engine/quality/liftDark.js) and gives
// the deblock effect's parameters from it. Pure: the frames come from the caller `draw`, which
// renders the layer alone at full scene size (check: ctx.renderFrames with solo; the
// deblock_upscaled edit: backend/agent/upscale-blocks.mjs).
import { area, intersection, visibleBoxAt } from "./model.js";
import { blockiness, blockStep, deblockFor, sourceGrid } from "./liftDark.js";
import { sourceAcross, upscaledSamples, UPSCALE_MAX } from "./rules/footage.js";

export const UPSCALE_DEBLOCK_SUFFIX = ".upscale-deblock";
export const upscaleDeblockId = (layerId) => `${layerId}${UPSCALE_DEBLOCK_SUFFIX}`;

// Full-size frames read for one shot (the slow part), spread over the samples at the largest scale.
const BLOCK_FRAMES = 3;
// A sample counts as "at the largest scale" within this share of it (a punch holds, then eases).
const AT_PEAK = 0.97;
// Shots measured in one check (each is up to BLOCK_FRAMES full-size renders).
export const MAX_MEASURED = 6;

const spread = (list, count) => [...new Set(Array.from({ length: Math.min(count, list.length) }, (_, step) => Math.floor(((step + 0.5) / Math.min(count, list.length)) * list.length)))].map((index) => list[index]);

/**
 * The shot of one picture or clip item drawn over `ratio` times its file's pixels ({item, size,
 * ratio, from, to, scale, time, across, frameWidth, over, times, grids}), or null when it never is
 * for two samples. `from` and `to` bound the stretch drawn over the ratio. `scale` and `time` are
 * the largest scale; `across` the file pixels across the frame
 * there; `times` and `grids` the samples to read (at the largest scale) and where the file's
 * pixels sit on the scene at each, for liftDark's blockiness. `size` is the file's {width, height}.
 */
export function upscaleShot(model, item, size, ratio = UPSCALE_MAX) {
  if (!(size?.width > 0 && size?.height > 0)) return null;
  const samples = upscaledSamples(model, item, size, ratio);
  if (samples.length < Math.min(2, model.times.length)) return null;
  const peak = samples.reduce((best, sample) => (sample.magnified > best.magnified ? sample : best));
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const placed = spread(samples.filter((sample) => sample.magnified >= peak.magnified * AT_PEAK), BLOCK_FRAMES).map((sample) => {
    const grid = sourceGrid(sample.box, size);
    if (!grid) return null;
    const picture = { x0: grid.x0, y0: grid.y0, x1: grid.x0 + size.width * grid.pitchX, y1: grid.y0 + size.height * grid.pitchY };
    const box = intersection(intersection(visibleBoxAt(model, item, sample.index), frame), picture);
    return area(box) > 0 ? { time: sample.time, grid: { ...grid, box } } : null;
  }).filter(Boolean);
  if (!placed.length) return null;
  const times = samples.map((sample) => sample.time);
  return { item, size, ratio, from: Math.min(...times), to: Math.max(...times) + 1 / model.fps, scale: peak.magnified, time: peak.time, across: sourceAcross(model, peak.box, peak.magnified), frameWidth: model.width, over: samples.length, times: placed.map((entry) => entry.time), grids: placed.map((entry) => entry.grid) };
}

/**
 * The block step of a shot's frames (one per `shot.times`, drawn alone at full size): `side` null
 * finds the blockiest of the 8 and 16 pixel grids, else measures that grid. Null when nothing could
 * be measured. Also the deblock parameters the measure calls for (or null) at the largest scale.
 */
export function upscaleBlocks(frames, shot, side = null) {
  const usable = frames.map((frame, index) => (frame?.pixels?.length ? index : -1)).filter((index) => index >= 0);
  if (!usable.length) return null;
  const grids = usable.map((index) => shot.grids[index]);
  const pictures = usable.map((index) => frames[index]);
  const blocks = side ? blockStep(pictures, grids.map((grid) => ({ ...grid, side }))) : blockiness(pictures, grids);
  return blocks && { blocks, deblock: deblockFor(blocks, shot.scale) };
}

const level = (value) => Math.round(value * 100) / 100;

/** The measured fact about a shot's blocks, for a check line or a receipt (after: blocks measured again). */
export function blockFact(blocks, deblock, after = null) {
  const base = `block step (${blocks.side} px grid, levels on the grid lines over inside the blocks) ${level(blocks.step)}${after ? ` to ${level(after.step)}` : ""}`;
  return deblock ? `${base} (ratio ${level(blocks.ratio)}, deblock radius ${deblock.radius} threshold ${deblock.threshold})` : `${base} (ratio ${level(blocks.ratio)}, under the 1.5x line: no deblock)`;
}

/**
 * Adds the source pixels' block step to the soft_upscale findings of a pixel check (the first
 * MAX_MEASURED, one shot each): the layer drawn alone at full size at the punch's largest scale.
 * The finding's measured text gets the step and, when the blocks call for it, the deblock_upscaled
 * call that smooths them before the scale.
 */
export async function addUpscaleBlocks(model, ctx, findings) {
  if (!ctx.renderFrames || !ctx.mediaSizes) return;
  const wanted = findings.filter((finding) => finding.rule === "soft_upscale" && finding.itemId);
  let measured = 0;
  for (const finding of wanted) {
    const item = model.items.find((entry) => entry.id === finding.itemId);
    const shot = item && upscaleShot(model, item, ctx.mediaSizes[item.src]);
    if (!shot) continue;
    if (measured >= MAX_MEASURED) { ctx.note(`soft_upscale: block steps measured on the first ${MAX_MEASURED} shots; deblock_upscaled measures the rest.`); break; }
    measured += 1;
    const frames = await ctx.renderFrames(shot.times, { width: model.width, solo: [item.id], background: "#000000" });
    const found = upscaleBlocks(frames ?? [], shot);
    if (!found) continue;
    const where = `at ${Math.round(shot.time * 100) / 100} s, ${shot.times.length} full-size frame${shot.times.length === 1 ? "" : "s"}`;
    finding.measured = `${finding.measured}; ${blockFact(found.blocks, found.deblock)} ${where}`;
    if (found.deblock && finding.fix?.kind === "hint") finding.fix = { ...finding.fix, text: `${finding.fix.text} The blocks stand out: the edit op deblock_upscaled on ${ctx.name(item)} smooths them before the scale.` };
  }
}
