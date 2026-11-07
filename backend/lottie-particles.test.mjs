// Generators in Lottie (backend/lottie-particles.mjs): a looping generator becomes an embedded
// image sequence that stores each distinct frame once and matches kino's own PNG; the add blend
// and frames too large for the raster limit are refused before any frame is drawn.
import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { lottieParticleProblem } from "./lottie-particles.mjs";

function generatorScene(effect, parameters, { width = 160, height = 90, blendMode = "normal", duration = 2 } = {}) {
  const carrier = createLayer("rectangle", { id: "fx", name: effect, x: 0, y: 0, width, height, fillEnabled: false, strokeWidth: 0, blendMode });
  carrier.animations = [{ id: "gen", name: effect, kind: "effect", effect, start: 0, duration, easing: "linear", to: parameters, keepStill: "both" }];
  const scene = createScene({ id: "s", name: "s", width, height, duration, background: "#000000", layers: [carrier] });
  return parseDocument(createDocument({ id: "d", name: "d", scenes: [scene] })).scenes[0];
}

async function pixelsOf(buffer) {
  const bitmap = await loadImage(buffer);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height, data: canvas.getContext("2d").getImageData(0, 0, bitmap.width, bitmap.height).data };
}

test("a looping generator goes into Lottie as embedded frames, each distinct frame stored once, matching kino's PNG", async () => {
  // Snow with a 0.5 s loop at 12 fps: 24 frames over 2 s, 6 distinct pictures.
  const scene = generatorScene("snow", { count: 120, size: 6, speed: 60, loop: 0.5 });
  const result = await exportScene(scene, { format: "lottie", fps: 12, duration: 2, imageDPIRatio: "original" });
  const warning = result.warnings.find((item) => item.code === "lottie-effect-rasterized");
  assert.deepEqual(warning?.effects, ["Snow"]);
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const images = animation.assets.filter((asset) => asset.e === 1 && /^data:image\/png;base64,/.test(asset.p ?? ""));
  assert.equal(images.length, 6, "six distinct pictures in a 0.5 s loop at 12 fps");
  const sequence = animation.assets.find((asset) => asset.id.startsWith("effect_sequence_"));
  const frames = sequence.layers.filter((layer) => layer.ty === 2).sort((a, b) => a.ip - b.ip);
  const pictureAt = (frame) => frames.find((layer) => layer.ip <= frame && frame < layer.op).refId;
  for (let frame = 0; frame < 18; frame += 1) assert.equal(pictureAt(frame), pictureAt(frame + 6), `frame ${frame} repeats 6 frames later`);
  assert.notEqual(pictureAt(0), pictureAt(3));

  // The embedded picture at 0.25 s, laid over black, is kino's own PNG of that moment.
  const asset = images.find((item) => item.id === pictureAt(3));
  const embedded = await pixelsOf(Buffer.from(asset.p.slice(asset.p.indexOf(",") + 1), "base64"));
  const still = await pixelsOf((await exportScene(scene, { format: "png", time: 0.25 })).buffer);
  // The capture adds one pixel on each side of the layer box (render.js captureLayerSvg).
  let difference = 0, lit = 0;
  for (let y = 0; y < 90; y += 1) for (let x = 0; x < 160; x += 1) {
    const e = ((y + 1) * embedded.width + x + 1) * 4, s = (y * 160 + x) * 4;
    const alpha = embedded.data[e + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) difference += Math.abs(embedded.data[e + channel] * alpha - still.data[s + channel]);
    if (still.data[s] > 40) lit += 1;
  }
  assert.ok(lit > 200, `${lit} lit pixels`);
  assert.ok(difference / (160 * 90 * 3) < 1, `mean difference ${(difference / (160 * 90 * 3)).toFixed(3)} of 255`);
});

test("Lottie refuses a generator laid on with the add blend, with the reason and what to change", async () => {
  const scene = generatorScene("embers", { count: 40 }, { blendMode: "add" });
  await assert.rejects(exportScene(scene, { format: "lottie", fps: 12, duration: 1 }),
    /Lottie cannot show Embers on layer “embers” faithfully: the layer uses the add blend.*Set blendMode "normal" for the Lottie export, or export a video/);
  // Inside a group with the add blend, the group is named.
  const group = createLayer("group", { id: "g", name: "overlay", x: 0, y: 0, width: 160, height: 90, blendMode: "add" });
  const child = { ...generatorScene("embers", { count: 40 }).layers[0], parentId: "g" };
  const nested = parseDocument(createDocument({ id: "d", name: "d", scenes: [createScene({ id: "s", name: "s", width: 160, height: 90, duration: 1, layers: [group, child] })] })).scenes[0];
  await assert.rejects(exportScene(nested, { format: "lottie", fps: 12, duration: 1 }), /its group “overlay” uses the add blend/);
});

test("Lottie refuses generator frames over the raster limit before drawing any of them", async () => {
  // A full-HD layer at the default 3× resolution is 18.7 million pixels a frame; four distinct frames pass 64 million.
  const scene = generatorScene("dust", {}, { width: 1920, height: 1080 });
  const started = performance.now();
  await assert.rejects(exportScene(scene, { format: "lottie", fps: 2, duration: 2 }),
    /Lottie cannot hold Dust on layer “dust”: 4 distinct frames of 5766×3246 pixels \(2 fps, 3× resolution\) is more than the 64,000,000-pixel limit.*Give the generator a loop/);
  assert.ok(performance.now() - started < 3000, "refused before any frame is drawn");
  // The same layer at the original resolution fits.
  const fits = await exportScene(scene, { format: "lottie", fps: 2, duration: 2, imageDPIRatio: "original" });
  assert.ok(fits.warnings.some((item) => item.code === "lottie-effect-rasterized"));
});

test("the size the particles skill reference gives fits: a full-frame 1080p generator at original resolution, 30 fps, a 1 s loop", () => {
  // skills/kino/references/particles.md says so; this keeps that sentence true.
  const scene = generatorScene("snow", { loop: 1 }, { width: 1920, height: 1080, duration: 4 });
  const times = (fps) => Array.from({ length: 4 * fps + 1 }, (_, index) => index / fps);
  assert.equal(lottieParticleProblem(scene, { times: times(30), fps: 30, density: 1 }), null);
  assert.match(lottieParticleProblem(scene, { times: times(60), fps: 60, density: 1 }), /64,000,000-pixel limit/);
  assert.match(lottieParticleProblem(scene, { times: times(30), fps: 30, density: 3 }), /64,000,000-pixel limit/);
  const longer = generatorScene("snow", { loop: 2 }, { width: 1920, height: 1080, duration: 4 });
  assert.match(lottieParticleProblem(longer, { times: times(30), fps: 30, density: 1 }), /64,000,000-pixel limit/);
});
