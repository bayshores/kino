// lift_dark on a dark clip encoded small at a low bitrate (its 16 px codec blocks show), drawn by
// the export renderer: the block step on the grid before, after the lift without deblock, and after
// the lift with the deblock lift_dark adds; the grain's size follows the source's pixels on the
// scene and holds still under reduced motion.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { blockStep, lumaStats } from "../engine/quality/liftDark.js";
import { kinoTimeline } from "../engine/quality/kinoTimeline.js";
import { runQuality } from "../engine/quality/index.js";
import { alone, liftDark } from "./agent/lift-dark.mjs";
import { deblockUpscaled, grainless } from "./agent/upscale-blocks.mjs";
import { upscaleBlocks, upscaleShot } from "../engine/quality/upscaleBlocks.js";
import { renderSceneFrames } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const fonts = await loadBundledFonts();
const [W, H, SCALE] = [128, 96, 2];

// A dark wall: a soft diagonal ramp from 8 to 40 of 255 with a faint slow ripple, 10 frames.
function wall() {
  const raw = Buffer.alloc(W * H * 3 * 10);
  for (let frame = 0; frame < 10; frame += 1) for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const level = 8 + 32 * (x + y) / (W + H) + 3 * Math.sin((x + frame) / 9) * Math.cos(y / 7);
    raw.fill(Math.round(level), ((frame * H + y) * W + x) * 3, ((frame * H + y) * W + x) * 3 + 3);
  }
  return raw;
}

// Effects as an edit stores them (to holds the parameters).
const runOps = async (document, ops) => {
  const next = structuredClone(document);
  for (const op of ops) for (const layer of next.scenes[0].layers) {
    if (op.op === "delete_animation") layer.animations = layer.animations.filter((animation) => animation.id !== op.animationId);
    if (op.op === "add_animation" && layer.id === op.layerId) layer.animations.push({ id: op.id, name: op.id, kind: "effect", effect: op.effect, start: op.start, duration: op.duration, easing: "linear", to: op.parameters, keepStill: "both" });
  }
  return parseDocument(next);
};

test("lift_dark measures the block step on the source's grid, deblocks before the curve and sizes a still grain from the source", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-lift-deblock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", "10", "-i", "pipe:0",
    "-c:v", "libx264", "-qp", "40", "-pix_fmt", "yuv420p", join(mediaRoot, "wall.mp4")], { input: wall() });
  // A 9:16 frame: the 4:3 clip's box fills it, so the clip is drawn whole and centered at twice
  // its size (one source pixel is 2 scene pixels) with bars above and below, under a caption.
  const [frameWidth, frameHeight, top] = [W * SCALE, 456, (456 - H * SCALE) / 2];
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "main", width: frameWidth, height: frameHeight, duration: 1, background: "#000000", layers: [
    createLayer("video", { id: "wall", name: "wall", src: "/api/media/wall.mp4", x: 0, y: 0, width: frameWidth, height: frameHeight, mediaStart: 0, mediaDuration: 1, mediaSourceDuration: 1 }),
    createLayer("text", { id: "caption", name: "caption", text: "STAIRS AT NIGHT", x: 8, y: top + 60, width: frameWidth - 16, height: 60, fontSize: 28, fill: "#FFFFFF" }),
  ] })] }));
  const render = (scene, times, { width }) => renderSceneFrames(scene, times, { mediaRoot, fonts, width });
  const sent = [];
  const sending = async (doc, ops) => { sent.push(...ops); return runOps(doc, ops); };
  const options = { layerIds: ["wall"], target: 90, fonts, render, runOps: sending, sourceSize: async () => ({ width: W, height: H }) };
  const lifted = await liftDark(document, { ...options, grain: false });
  const [entry] = lifted.lifted;
  assert.equal(entry.blocks.side, 16);
  assert.ok(Math.round(entry.before.p2 * 255) > 0, "the bars above and below the clip are not measured as its black");
  assert.ok(entry.blocks.ratio >= 1.5, `the clip's block grid stands out: ${JSON.stringify(entry.blocks)}`);
  assert.deepEqual(sent.slice(-2).map((op) => op.effect), ["deblock", "curves"], "the deblock goes before the curve");
  assert.equal((entry.firstDeblock ?? entry.deblock).radius, 8, "first a quarter of a 16 px block, at 2 scene pixels a source pixel");
  // The same lift without the deblock (the old lift), the clip drawn alone at full size.
  const old = structuredClone(lifted.document);
  old.scenes[0].layers[0].animations = old.scenes[0].layers[0].animations.filter((animation) => animation.effect !== "deblock");
  const grid = { x0: 0, y0: top, pitchX: SCALE, pitchY: SCALE, box: { x0: 0, y0: top, x1: frameWidth, y1: top + H * SCALE }, side: 16 };
  const oldStep = blockStep(await render(alone(expandComponents(parseDocument(old), "main", { fonts }), "wall"), entry.times, { width: frameWidth }), grid);
  t.diagnostic(`block step before ${entry.blocks.step.toFixed(2)} (ratio ${entry.blocks.ratio.toFixed(2)}), old lift ${oldStep.step.toFixed(2)} (ratio ${oldStep.ratio.toFixed(2)}), new lift ${entry.blocksAfter.step.toFixed(2)} (ratio ${entry.blocksAfter.ratio.toFixed(2)}); ${lifted.lines[0]}`);
  assert.ok(oldStep.step > entry.blocks.step, "the plain lift makes the block steps larger");
  assert.ok(entry.blocksAfter.step < oldStep.step * 0.6, `the deblocked lift keeps under 60% of them: ${entry.blocksAfter.step} vs ${oldStep.step}`);
  assert.match(lifted.lines[0], /block step \(16 px grid, levels on the grid lines over inside the blocks, grain off\) [\d.]+ to [\d.]+, deblock radius [\d.]+ threshold [\d.]+/);
  // The step after is measured and the deblock fitted again while it is over the bar (no bright shot here: a stated guess);
  // a stronger try is kept only when it drew less; still over it, the largest lift under it is a number; shadow levels do not fall.
  assert.match(lifted.lines[0], /, bar 0\.25 \(a starting guess: no bright shot measured\)/);
  if (entry.firstDeblock) assert.ok(entry.blocksAfter.step <= entry.firstDeblock.step, `${entry.blocksAfter.step} against the first fit's ${entry.firstDeblock.step}`);
  if (entry.blocksAfter.step > 0.25) assert.match(lifted.lines[0], /still over it: the largest lift that keeps the step under is about \+[\d.]+ stops \(mean about \d+; an estimate from the curve's slope at the shot's median\), the \+4 asked is applied/);
  const [, levelsBefore, levelsAfter] = lifted.lines[0].match(/shadow levels \(distinct, darker half\) (\d+) to (\d+)/).map(Number);
  assert.ok(levelsAfter >= levelsBefore, `shadow levels ${levelsBefore} to ${levelsAfter}`);
  // The target and the means are in one range (full, 0 to 255), and the rendered mean after the lift is within 2 levels of it.
  assert.match(lifted.lines[0], /^lift_dark target 90 \(full range 0-255; video range 16-235: 93\): wall mean \d+ to \d+ measured on the edit's render at 240 px wide \(6 frames/);
  // 90 needs more than the 4-stop cap (76 on the render). A reachable 60: the first fit draws 58 (the
  // caption's edge pixels are mixed into the small measured frames), the second lands within a level.
  const reach = await liftDark(document, { ...options, target: 60, grain: false });
  t.diagnostic(reach.lines[0].split(", contrast")[0]);
  assert.ok(Math.abs(reach.lifted[0].after.mean * 255 - 60) <= 1, `rendered mean ${(reach.lifted[0].after.mean * 255).toFixed(2)} against target 60`);
  assert.match(reach.lines[0], /\+[\d.]+ stops \(fitted twice: the first fit drew 58\)/);
  // Under reduced motion the grain holds still; its grains are the source's pixels (2 scene pixels).
  sent.length = 0;
  await liftDark(document, { ...options, reduced: true });
  const grain = sent.find((op) => op.effect === "grain");
  assert.deepEqual([grain.parameters.size, grain.parameters.animated], [2, false]);
});

// A flat dark blue night clip (6, 12, 44 of 255) at the scene's own size, under a grade already on it.
test("lift_dark on dark colored footage: check-size frames read as the full size, the grain is in the receipt and an earlier grade is named", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-lift-night-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  const [width, height] = [512, 288];
  const raw = Buffer.alloc(width * height * 3 * 5);
  for (let at = 0; at < raw.length; at += 3) raw.set([6, 12, 44], at);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", "5", "-i", "pipe:0",
    "-c:v", "libx264", "-qp", "20", "-pix_fmt", "yuv420p", join(mediaRoot, "night.mp4")], { input: raw });
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "main", width, height, duration: 1, background: "#000000", layers: [
    createLayer("video", { id: "night", name: "night", src: "/api/media/night.mp4", x: 0, y: 0, width, height, mediaStart: 0, mediaDuration: 1, mediaSourceDuration: 1,
      animations: [{ id: "night.grade", name: "night.grade", kind: "effect", effect: "color-grade", start: 0, duration: 1, easing: "linear", to: { stops: 0.5 }, keepStill: "both" }] }),
  ] })] }));
  const widths = [];
  const render = (scene, times, options) => { widths.push(options.width); return renderSceneFrames(scene, times, { mediaRoot, fonts, width: options.width }); };
  const mean = (frames) => lumaStats(frames).mean * 255;
  // The picture decoded for a 240 px check frame reads as at the scene's own 512 (the old scaler read 1.3 levels darker).
  const expanded = expandComponents(document, "main", { fonts });
  const bare = { ...expanded, layers: expanded.layers.map((layer) => ({ ...layer, animations: [] })) };
  const [small, full] = [await render(bare, [0.5], { width: 240 }), await render(bare, [0.5], { width })];
  assert.ok(Math.abs(mean(small) - mean(full)) <= 0.3, `240 px ${mean(small).toFixed(2)} against ${width} px ${mean(full).toFixed(2)}`);
  widths.length = 0;
  const lifted = await liftDark(document, { layerIds: ["night"], target: 60, fonts, render, runOps, sourceSize: async () => ({ width, height }) });
  const [entry] = lifted.lifted;
  // The receipt (default grain on) equals the full-size render of the edit at its frames within 1 level.
  const drawn = mean(await renderSceneFrames(expandComponents(lifted.document, "main", { fonts }), entry.times, { mediaRoot, fonts, width }));
  t.diagnostic(`${lifted.lines[0].split(", contrast")[0]}; full size ${drawn.toFixed(2)}; renders at ${widths.join(", ")}`);
  assert.ok(entry.amount > 0, "the default grain is on");
  assert.ok(Math.abs(entry.after.mean * 255 - drawn) <= 1, `receipt ${(entry.after.mean * 255).toFixed(2)} against the full-size render ${drawn.toFixed(2)}`);
  assert.match(lifted.lines[0], /night mean (\d+) to \d+ measured on the edit's render at 240 px wide \(6 frames over [\d.]+ to [\d.]+ s\), on top of night\.grade \(color-grade\) already there: (\d+) without it, \1 with/);
  // One small render before, one without the grade, one full-size render of the blocks, then the same after: 5.
  assert.deepEqual(widths, [240, 240, width, 240, width]);
});

// A punch-in on the same kind of clip (128x96 at a low bitrate, drawn 2.5x on a 256x192 frame): check
// names the file pixels across the frame and the block step on the source's grid, deblock_upscaled
// adds the deblock before the scale, and a layer under the ratio gets nothing.
test("a punch-in's block step is measured on the source grid, check says it and deblock_upscaled smooths it", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-upscale-blocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", "10", "-i", "pipe:0",
    "-c:v", "libx264", "-qp", "40", "-pix_fmt", "yuv420p", join(mediaRoot, "wall.mp4")], { input: wall() });
  const video = (id, box, animations = []) => createLayer("video", { id, name: id, src: "/api/media/wall.mp4", ...box, mediaStart: 0, mediaDuration: 1, mediaSourceDuration: 1, animations });
  // The punch carries a grain (as lift_dark leaves one): it adds a step at every pixel and would hide the blocks.
  const grain = { id: "punch.lift-grain", name: "grain", kind: "effect", effect: "grain", start: 0, duration: 1, easing: "linear", to: { amount: 0.3, size: 1, seed: 7 }, keepStill: "both" };
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 256, height: 192, duration: 1, background: "#000000", layers: [
    video("punch", { x: -32, y: -24, width: 320, height: 240 }, [grain]),
    video("plain", { x: 0, y: 0, width: 128, height: 96 }),
  ] })] }));
  const render = (scene, times, { width }) => renderSceneFrames(scene, times, { mediaRoot, fonts, width });
  const sourceSize = async () => ({ width: W, height: H });
  // check, with pixels: the soft_upscale finding carries the measured fact.
  const expanded = expandComponents(document, "main", { fonts });
  const model = kinoTimeline(document, "main", { fonts });
  const { findings } = await runQuality(model, { codes: ["soft_upscale"], context: {
    mediaSizes: { "/api/media/wall.mp4": { width: W, height: H } },
    renderFrames: (times, { width, solo, noGrain }) => render(solo ? (noGrain ? grainless(expanded, solo[0]) : alone(expanded, solo)) : expanded, times, { width }),
  } });
  const finding = findings.find((entry) => entry.rule === "soft_upscale");
  t.diagnostic(finding.measured);
  assert.match(finding.measured, /2\.5x at [\d.]+ s \(the file drawn 320x240 px; 102 of its 128 px across the 256 px frame\)/);
  assert.match(finding.measured, /block step \(16 px grid, levels on the grid lines over inside the blocks\) [\d.]+ \(ratio [\d.]+, deblock radius 10 threshold [\d.]+\)/);
  // Through the grain the same frames measure no blocks.
  const shot = upscaleShot(model, model.items.find((item) => item.source?.layerId === "punch"), { width: W, height: H });
  const grained = upscaleBlocks(await render(alone(expanded, "punch"), shot.times, { width: 256 }), shot);
  t.diagnostic(`with its grain: step ${grained?.blocks.step} ratio ${grained?.blocks.ratio}`);
  assert.equal(grained?.deblock ?? null, null);
  // The edit: one call adds the deblock over the stretch, prints the step before and after, and leaves the 1x layer alone.
  const sent = [];
  const result = await deblockUpscaled(document, { layerIds: ["punch", "plain"], fonts, render, sourceSize, runOps: async (doc, ops) => { sent.push(...ops); return runOps(doc, ops); } });
  const [punched] = result.shots;
  assert.deepEqual(sent.map((op) => [op.op, op.layerId, op.id, op.effect]), [["add_animation", "punch", "punch.upscale-deblock", "deblock"]]);
  assert.equal(punched.deblock.radius, 10, "a quarter of a 16 px block at 2.5 scene pixels a source pixel");
  assert.ok(punched.blocksAfter.step < punched.blocks.step * 0.7, `the deblock keeps under 70% of the step: ${punched.blocks.step} to ${punched.blocksAfter.step}`);
  // It runs before the grain: first in the layer's effects.
  assert.deepEqual(result.document.scenes[0].layers[0].animations.map((animation) => animation.id), ["punch.upscale-deblock", "punch.lift-grain"]);
  t.diagnostic(result.lines[0]);
  assert.match(result.lines[0], /punch drawn 2\.5x at [\d.]+ s \(102 of its 128 px file across the 256 px frame\), block step \(16 px grid, levels on the grid lines over inside the blocks\) [\d.]+ to [\d.]+ \(ratio/);
  assert.match(result.lines[0], /left alone: plain \(drawn at most 1x its file, not over 1\.3x\)/);
  // Again replaces the effect; remove takes it off.
  const removed = await deblockUpscaled(result.document, { layerIds: ["punch"], remove: true, fonts, render, sourceSize, runOps });
  assert.deepEqual(removed.document.scenes[0].layers[0].animations.map((animation) => animation.id), ["punch.lift-grain"]);
});
