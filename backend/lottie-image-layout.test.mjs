import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exportScene } from "./export.mjs";
import { createLayer, createScene } from "../engine/model.js";
import { easingAt } from "../engine/animation.js";
import { Resvg } from "@resvg/resvg-js";
import { renderSceneSvg } from "../engine/render.js";

// Use a real uncompressed PNG so the source-file size optimization cannot hide
// the dimensions selected by the world-space sampler.
const { stdout: fixturePng } = await promisify(execFile)(
  process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg",
  ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=600x360:rate=1", "-frames:v", "1", "-c:v", "png", "-compression_level", "0", "-f", "image2pipe", "pipe:1"],
  { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 },
);
const source = `data:image/png;base64,${fixturePng.toString("base64")}`;
const image = (values = {}) => createLayer("image", { name: "Bitmap", width: 100, height: 60, src: source, ...values });
const animation = (values) => ({ id: "scale", kind: "custom", name: "Scale", start: 0, duration: 1, easing: "linear", unit: "layer", stagger: 0, order: "forward", ...values });
const bitmapAssets = (json) => json.assets.filter((asset) => asset.p);
async function exported(layers, options = {}) {
  const scene = createScene({ width: 640, height: 360, duration: 2, layers, background: "transparent" });
  return JSON.parse((await exportScene(scene, { format: "lottie", fps: 5, imageDPIRatio: "1x", ...options })).buffer);
}

test("Lottie bitmaps fill the layer with a centered crop when its aspect ratio differs", async () => {
  const value = await exported([image({ x: 20, y: 30, width: 100, height: 100 })]);
  const [asset] = bitmapAssets(value);
  const frame = value.layers.find((item) => item.nm === "Bitmap");
  const layer = value.assets.find((item) => item.id === frame.refId).layers[0];
  assert.equal(asset.w, 167);
  assert.equal(asset.h, 100);
  assert.deepEqual([frame.w, frame.h], [100, 100]);
  assert.equal(frame.hasMask, true);
  assert.deepEqual(frame.masksProperties[0].pt.k.v, [[0, 0], [100, 0], [100, 100], [0, 100]]);
  assert.deepEqual(layer.ks.a.k, [0, 0, 0]);
  assert.ok(Math.abs(layer.ks.p.k[0] + 100 / 3) < 1e-9);
  assert.equal(layer.ks.p.k[1], 0);
  assert.ok(Math.abs(layer.ks.s.k[0] * asset.w / 100 - 500 / 3) < 1e-9);
  assert.equal(layer.ks.s.k[1] * asset.h / 100, 100);
  const original = await exported([image({ x: 20, y: 30, width: 100, height: 100 })], { imageDPIRatio: "original" });
  const originalAsset = bitmapAssets(original)[0];
  const originalFrame = original.layers.find((item) => item.nm === "Bitmap");
  const originalLayer = original.assets.find((item) => item.id === originalFrame.refId).layers[0];
  assert.deepEqual(originalFrame.ks, frame.ks);
  assert.deepEqual(originalLayer.ks.p, layer.ks.p);
  assert.ok(Math.abs(originalLayer.ks.s.k[0] * originalAsset.w / 100 - 500 / 3) < 1e-9);
  assert.ok(Math.abs(originalLayer.ks.s.k[1] * originalAsset.h / 100 - 100) < 1e-9);
});

test("the shared renderer crops image pixels rather than adding letterboxing", () => {
  const bands = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><path fill="red" d="M0 0H20V20H0Z"/><path fill="lime" d="M20 0H40V20H20Z"/><path fill="blue" d="M40 0H60V20H40Z"/></svg>').render().asPng();
  const scene = createScene({ width: 40, height: 40, background: "transparent", layers: [image({ x: 10, y: 10, width: 20, height: 20, src: `data:image/png;base64,${bands.toString("base64")}` })] });
  const pixels = new Resvg(renderSceneSvg(scene, 0)).render().pixels;
  for (const [x, y] of [[10, 10], [20, 20], [29, 29]])
    assert.deepEqual([...pixels.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)], [0, 255, 0, 255]);
  for (const [x, y] of [[9, 20], [30, 20], [20, 9], [20, 30]])
    assert.equal(pixels[(y * 40 + x) * 4 + 3], 0, "The cover image must remain inside the layer bounds");
});

test("Lottie image resolution includes narrow parent-transform overshoot between exported frames", async () => {
  const group = createLayer("group", { id: "parent", width: 100, height: 60, animations: [animation({ start: 1.01, duration: 0.005, easing: "overshoot", from: { scaleX: 2, scaleY: 2 }, to: { scaleX: 3, scaleY: 3 } })] });
  const value = await exported([group, image({ parentId: group.id })]);
  const [asset] = bitmapAssets(value);
  const peakScale = Math.max(...Array.from({ length: 1001 }, (_, index) => 2 + easingAt("overshoot", index / 1000)));
  assert.equal(asset.w, Math.ceil(100 * peakScale));
  assert.equal(asset.h, Math.ceil(60 * peakScale));
  assert.ok(asset.w > 300, "The 1.015-second settled value must not hide the intervening peak");
});

test("Lottie image density uses transformed axes through nested nonuniform scale and rotation", async () => {
  const group = createLayer("group", { id: "stretched", width: 100, height: 60, scaleX: 2, scaleY: 1 });
  const value = await exported([group, image({ parentId: group.id, rotation: 90 })]);
  const [asset] = bitmapAssets(value);
  assert.equal(asset.w, 100);
  assert.equal(asset.h, 120);
});

test("Lottie image density covers the complete serialized frame interval", async () => {
  for (const duration of [0.001, 0.025]) {
    const frameEnd = Math.max(1, Math.ceil(duration * 60)) / 60;
    const value = await exported([image({ animations: [animation({
      start: duration, duration: frameEnd - duration, from: { scaleX: 1, scaleY: 1 },
      to: { scaleX: 4, scaleY: 4 },
    })] })], { duration, fps: 60 });
    assert.equal(value.op, Math.ceil(frameEnd * 60));
    const [asset] = bitmapAssets(value);
    assert.deepEqual([asset.w, asset.h], [400, 240], "The bitmap must cover transforms in the emitted final frame");
  }
});

test("Identical Lottie bitmaps share an asset sized for their largest use", async () => {
  const value = await exported([image({ id: "small", width: 50, height: 30 }), image({ id: "large", x: 200, width: 200, height: 120 })]);
  const assets = bitmapAssets(value);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].w, 200);
  assert.equal(assets[0].h, 120);
  const images = value.assets.flatMap((item) => item.layers ?? []).filter((item) => item.ty === 2);
  assert.equal(new Set(images.map((item) => item.refId)).size, 1);
  const widths = images.map((item) => item.ks.s.k[0] * assets[0].w / 100).sort((a, b) => a - b);
  assert.deepEqual(widths, [50, 200]);
});

test("Lottie omits media hidden by a parent without requiring its source file", async () => {
  const value = await exported([
    createLayer("group", { id: "hidden", visible: false }),
    image({ parentId: "hidden", src: "/api/media/missing.png" }),
    createLayer("video", { parentId: "hidden", src: "/api/media/missing.mp4" }),
  ]);
  assert.equal(bitmapAssets(value).length, 0);
  assert.equal(value.layers.some((layer) => layer.ty === 2), false);
});
