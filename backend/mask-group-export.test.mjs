import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer } from "../engine/model.js";
import { createMask } from "../engine/masking.js";
import { exportScene } from "./export.mjs";
import { readImage } from "./media.test.support.mjs";

// A mask group made by Create mask: a green layer below, then a white square mask (25..75)
// over a red top half and a blue bottom half.
function maskedScene() {
  const document = createDocument();
  const scene = Object.assign(document.scenes[0], { width: 100, height: 100, background: "#ffffff", duration: 1 });
  const box = (type, id, values) => createLayer(type, { id, name: id, x: 0, y: 0, width: 100, height: 100, ...values });
  scene.layers = [
    box("rectangle", "square", { x: 25, y: 25, width: 50, height: 50, fill: "#ffffff" }),
    box("rectangle", "red", { height: 50, fill: "#ff0000" }),
    box("rectangle", "blue", { y: 50, height: 50, fill: "#0000ff" }),
    box("rectangle", "outside", { x: 80, y: 80, width: 20, height: 20, fill: "#000000" }),
  ];
  const { layers } = createMask(document, scene.id, ["square", "red", "blue"], { id: "masked" });
  // A layer under the mask inside the group is drawn without the mask.
  const below = box("rectangle", "below", { parentId: "masked", width: 10, height: 10, fill: "#00ff00" });
  layers.splice(1, 0, below);
  return { ...scene, layers };
}

test("a PNG export of a mask group shows its layers only inside the mask", async () => {
  const image = await readImage((await exportScene(maskedScene(), { format: "png", time: 0 })).buffer);
  assert.deepEqual(image.pixel(30, 30), [255, 0, 0, 255]);
  assert.deepEqual(image.pixel(30, 70), [0, 0, 255, 255]);
  assert.deepEqual(image.pixel(20, 20), [255, 255, 255, 255], "red outside the mask is hidden");
  assert.deepEqual(image.pixel(20, 60), [255, 255, 255, 255], "blue outside the mask is hidden");
  assert.deepEqual(image.pixel(5, 5), [0, 255, 0, 255], "the layer below the mask is not masked");
  assert.deepEqual(image.pixel(90, 90), [0, 0, 0, 255], "the layer outside the group is not masked");
});

test("a Lottie export of a mask group uses the mask as one luminance matte for all layers above it", async () => {
  const data = JSON.parse((await exportScene(maskedScene(), { format: "lottie", fps: 4 })).buffer.toString());
  const group = data.layers.find((item) => item.nm === "Mask group");
  assert.equal(group.ty, 0);
  const content = data.assets.find((item) => item.id === group.refId).layers;
  // Lottie lists layers front to back, and a matte comes right before the layer it masks:
  // the mask, the masked layers (in one composition), then the layer below the mask.
  assert.deepEqual(content.map((item) => item.nm), ["square", "Masked layers", "below"]);
  const [matte, masked, below] = content;
  assert.equal(matte.td, 1);
  assert.equal(masked.tt, 3);
  assert.equal(masked.tp, matte.ind);
  assert.equal(Object.hasOwn(below, "tt"), false);
  assert.equal(Object.hasOwn(data.layers.find((item) => item.nm === "outside"), "tt"), false);
  const maskedLayers = data.assets.find((item) => item.id === masked.refId).layers;
  assert.deepEqual(maskedLayers.map((item) => item.nm), ["blue", "red"]);
  // Every layer index is unique, so the matte reference is unambiguous.
  const indexes = [data.layers, ...data.assets.map((asset) => asset.layers)].map((list) => list.map((item) => item.ind));
  for (const list of indexes) assert.equal(new Set(list).size, list.length);
});

test("a hidden mask leaves its mask group unmasked in exports", async () => {
  const scene = maskedScene();
  scene.layers = scene.layers.map((layer) => (layer.id === "square" ? { ...layer, visible: false } : layer));
  const image = await readImage((await exportScene(scene, { format: "png", time: 0 })).buffer);
  assert.deepEqual(image.pixel(20, 20), [255, 0, 0, 255]);
  const data = JSON.parse((await exportScene(scene, { format: "lottie", fps: 4 })).buffer.toString());
  const group = data.layers.find((item) => item.nm === "Mask group");
  const content = data.assets.find((item) => item.id === group.refId).layers;
  assert.deepEqual(content.map((item) => item.nm), ["blue", "red", "below"]);
  assert.ok(content.every((item) => !Object.hasOwn(item, "tt") && !Object.hasOwn(item, "td")));
});

test("a scaled-down mask group keeps what it draws past the frame in its own units", async () => {
  // At a quarter size, the group's y 230 lands at 95 on screen; a mask with no area of its own
  // stopped at 110 in the group's units (the frame plus 10%), so this red was cut off.
  const document = createDocument();
  const scene = Object.assign(document.scenes[0], { width: 100, height: 100, background: "#ffffff", duration: 1 });
  const layer = (type, id, values) => createLayer(type, { id, name: id, x: 0, y: 0, width: 100, height: 100, ...values });
  scene.layers = [
    layer("group", "phone", { isMaskGroup: true, scaleX: 0.25, scaleY: 0.25 }),
    layer("rectangle", "window", { parentId: "phone", y: -300, height: 700, fill: "#ffffff", isMask: true }),
    layer("rectangle", "map", { parentId: "phone", y: 150, height: 150, fill: "#ff0000" }),
  ];
  const image = await readImage((await exportScene(scene, { format: "png", time: 0 })).buffer);
  assert.deepEqual(image.pixel(50, 95), [255, 0, 0, 255]);
});
