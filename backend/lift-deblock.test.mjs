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
import { blockStep } from "../engine/quality/liftDark.js";
import { liftDark } from "./agent/lift-dark.mjs";
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
  // The clip drawn at twice its size: one source pixel is 2 scene pixels.
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "main", width: W * SCALE, height: H * SCALE, duration: 1, background: "#000000", layers: [
    createLayer("video", { id: "wall", name: "wall", src: "/api/media/wall.mp4", x: 0, y: 0, width: W * SCALE, height: H * SCALE, mediaStart: 0, mediaDuration: 1, mediaSourceDuration: 1 }),
  ] })] }));
  const render = (scene, times, { width }) => renderSceneFrames(scene, times, { mediaRoot, fonts, width });
  const sent = [];
  const sending = async (doc, ops) => { sent.push(...ops); return runOps(doc, ops); };
  const options = { layerIds: ["wall"], target: 90, fonts, render, runOps: sending, sourceSize: async () => ({ width: W, height: H }) };
  const lifted = await liftDark(document, { ...options, grain: false });
  const [entry] = lifted.lifted;
  assert.equal(entry.blocks.side, 16);
  assert.ok(entry.blocks.ratio >= 1.5, `the clip's block grid stands out: ${JSON.stringify(entry.blocks)}`);
  assert.deepEqual(sent.map((op) => op.effect), ["deblock", "curves"], "the deblock goes before the curve");
  assert.equal(entry.deblock.radius, 8, "a quarter of a 16 px block, at 2 scene pixels a source pixel");
  // The same lift without the deblock (the old lift), drawn at full size.
  const old = structuredClone(lifted.document);
  old.scenes[0].layers[0].animations = old.scenes[0].layers[0].animations.filter((animation) => animation.effect !== "deblock");
  const grid = { x0: 0, y0: 0, pitchX: SCALE, pitchY: SCALE, side: 16 };
  const oldStep = blockStep(await render(expandComponents(parseDocument(old), "main", { fonts }), entry.times, { width: W * SCALE }), grid);
  t.diagnostic(`block step before ${entry.blocks.step.toFixed(2)} (ratio ${entry.blocks.ratio.toFixed(2)}), old lift ${oldStep.step.toFixed(2)} (ratio ${oldStep.ratio.toFixed(2)}), new lift ${entry.blocksAfter.step.toFixed(2)} (ratio ${entry.blocksAfter.ratio.toFixed(2)}); ${lifted.lines[0]}`);
  assert.ok(oldStep.step > entry.blocks.step, "the plain lift makes the block steps larger");
  assert.ok(entry.blocksAfter.step < oldStep.step * 0.6, `the deblocked lift keeps under 60% of them: ${entry.blocksAfter.step} vs ${oldStep.step}`);
  assert.match(lifted.lines[0], /block step \(16 px grid, levels on the grid lines over inside the blocks\) [\d.]+ to [\d.]+, deblock radius 8 threshold [\d.]+/);
  // Under reduced motion the grain holds still; its grains are the source's pixels (2 scene pixels).
  sent.length = 0;
  await liftDark(document, { ...options, reduced: true });
  const grain = sent.find((op) => op.effect === "grain");
  assert.deepEqual([grain.parameters.size, grain.parameters.animated], [2, false]);
});
