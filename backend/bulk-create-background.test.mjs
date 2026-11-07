import test from "node:test";
import assert from "node:assert/strict";
import { applyOperations } from "../engine/operations.js";
import { createDocument, createScene, parseDocument } from "../engine/model.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";
import { readImage } from "./media.test.support.mjs";

const SOLID = "#ff000080";
const GRADIENT = {
  type: "linear", angle: 0,
  stops: [{ offset: 0, color: "#ff000040" }, { offset: 1, color: "#0000ff80" }],
};
const COLOR = {
  id: "color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear",
  from: { fill: "#ff000040" }, to: { fill: "#0000ff80" },
};

function scenes(background, backgroundAnimations = []) {
  const before = parseDocument(createDocument({ scenes: [createScene({
    id: "base", name: "Base", width: 10, height: 10, duration: 1, background, backgroundAnimations,
  })] }));
  const document = parseDocument(applyOperations(before, [{ type: "bulk_create", sceneId: "base", rows: [["id"], ["one"]] }]));
  return document.scenes.map((scene) => expandComponents(document, scene.id));
}

function fills(value, found = []) {
  if (Array.isArray(value)) value.forEach((item) => fills(item, found));
  else if (value && typeof value === "object") {
    if (value.ty === "fl" || value.ty === "gf") found.push(value);
    Object.values(value).forEach((child) => fills(child, found));
  }
  return found;
}

test("bulk_create exports unchanged translucent solid and gradient backgrounds once in PNG", async () => {
  for (const background of [SOLID, GRADIENT]) {
    const [base, variant] = scenes(background);
    const original = await readImage((await exportScene(base, { format: "png" })).buffer);
    const copy = await readImage((await exportScene(variant, { format: "png" })).buffer);
    assert.ok(original.pixel(9, 9)[3] < 255);
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) assert.deepEqual(copy.pixel(x, y), original.pixel(x, y), `same exported pixel at ${x},${y}`);
    }
  }
});

test("bulk_create PNG exports preserve the copied translucent background Color animation", async () => {
  const [base, variant] = scenes(SOLID, [COLOR]);
  for (const time of [0, 0.5, 1]) {
    const original = await readImage((await exportScene(base, { format: "png", time })).buffer);
    const copy = await readImage((await exportScene(variant, { format: "png", time })).buffer);
    assert.deepEqual(copy.pixel(5, 5), original.pixel(5, 5), `same animated exported pixel at time ${time}`);
  }
});

test("bulk_create Lottie exports contain one background paint, preserving gradients and alpha keyframes", async () => {
  for (const [background, animations] of [[SOLID, []], [SOLID, [COLOR]], [GRADIENT, []]]) {
    const [base, variant] = scenes(background, animations);
    const original = JSON.parse((await exportScene(base, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
    const copy = JSON.parse((await exportScene(variant, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
    const originalFills = fills(original);
    const copyFills = fills(copy);
    const originalSolids = original.layers.filter((layer) => layer.ty === 1);
    const copySolids = copy.layers.filter((layer) => layer.ty === 1);
    assert.equal(copyFills.length + copySolids.length, 1, "the instance adds no second background paint");
    assert.deepEqual(copyFills, originalFills, "gradient stops and animated fill/alpha remain the same");
    assert.deepEqual(copySolids, originalSolids, "static solid background serialization remains the same");
    const transparent = JSON.parse((await exportScene(variant, { format: "lottie", fps: 4, transparent: true })).buffer.toString("utf8"));
    assert.deepEqual(fills(transparent), [], "transparent export has no linked background paint left behind");
    assert.deepEqual(transparent.layers.filter((layer) => layer.ty === 1), []);
  }
});
