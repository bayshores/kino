import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyBulkCreate, planBulkCreate } from "./bulkCreate.js";
import { expandComponents } from "./linkedComponents.js";
import { renderSceneSvg } from "./render.js";

const SOLID = "#ff000080";
const GRADIENT = {
  type: "linear", angle: 0,
  stops: [{ offset: 0, color: "#ff000040" }, { offset: 1, color: "#0000ff80" }],
};

function fixture(background, layers = [], extraScenes = []) {
  return parseDocument(createDocument({ scenes: [
    createScene({ id: "base", name: "Base", width: 10, height: 10, duration: 1, background, layers }),
    ...extraScenes,
  ] }));
}

function importVariant(document, header = ["id"], row = ["one"]) {
  const plan = planBulkCreate(document, "base", header, [row]);
  assert.deepEqual(plan.errors, []);
  return parseDocument(applyBulkCreate(document, plan));
}

function pixels(document, sceneId, time = 0) {
  return new Resvg(renderSceneSvg(expandComponents(document, sceneId), time)).render().pixels;
}

for (const [name, background] of [["solid", SOLID], ["gradient", GRADIENT]]) {
  for (const withText of [false, true]) {
    test(`bulk variants paint a translucent ${name} background once${withText ? " with a blank text cell" : " without layers"}`, () => {
      const layers = withText ? [createLayer("text", {
        id: "title", name: "Title", text: "Hi", x: 0, y: 0, width: 10, height: 5, fontSize: 4,
      })] : [];
      const document = importVariant(fixture(background, layers), withText ? ["id", "Title"] : ["id"], withText ? ["one", ""] : ["one"]);
      const [base, variant] = document.scenes;
      const original = pixels(document, base.id);
      const copy = pixels(document, variant.id);
      assert.ok(original[(9 * 10 + 9) * 4 + 3] < 255, "the uncovered background pixel remains translucent");
      if (name === "solid") assert.equal(original[(9 * 10 + 9) * 4 + 3], 128);
      assert.equal(copy[(9 * 10 + 9) * 4 + 3], original[(9 * 10 + 9) * 4 + 3], "the variant keeps the base pixel alpha");
      if (withText) {
        // Component clipping can round antialiased glyph edges by one 8-bit channel.
        for (let index = 0; index < copy.length; index += 1)
          assert.ok(Math.abs(copy[index] - original[index]) <= 1, `same artwork at channel ${index}`);
        assert.deepEqual(copy.subarray(5 * 10 * 4), original.subarray(5 * 10 * 4), "every uncovered background pixel matches exactly");
      } else assert.deepEqual(copy, original, "every RGBA pixel matches the unchanged base artwork");
      assert.deepEqual(variant.background, base.background, "the scene retains its own copied paint");
      assert.equal(variant.backgroundEnabled, base.backgroundEnabled);
      assert.equal(variant.layers[0].componentBackgroundEnabled, false);
    });
  }
}

test("bulk variants retain translucent background Color animations through save/readback and re-import", () => {
  const before = fixture(SOLID);
  before.scenes[0].backgroundAnimations = [{
    id: "color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear",
    from: { fill: "#ff000040" }, to: { fill: "#0000ff80" },
  }];
  const created = importVariant(before);
  const document = importVariant(parseDocument(JSON.parse(JSON.stringify(created))));
  const [base, variant] = document.scenes;
  assert.notEqual(variant.backgroundAnimations[0].id, base.backgroundAnimations[0].id);
  assert.deepEqual(variant.backgroundAnimations[0].from, base.backgroundAnimations[0].from);
  assert.deepEqual(variant.backgroundAnimations[0].to, base.backgroundAnimations[0].to);
  for (const time of [0, 0.5, 1]) {
    assert.deepEqual(pixels(document, variant.id, time), pixels(document, base.id, time), `same animated background at time ${time}`);
  }
  assert.equal(variant.layers[0].componentBackgroundEnabled, false);
});

test("only the root bulk instance suppresses its background; ordinary nested instances keep theirs", () => {
  const nested = createScene({ id: "nested", name: "Nested", width: 4, height: 4, duration: 1, isComponent: true, background: "#0000ff80" });
  const document = importVariant(fixture(SOLID, [createLayer("component", {
    id: "nested-instance", componentSceneId: nested.id, x: 2, y: 2, width: 4, height: 4,
  })], [nested]));
  const variant = document.scenes.find((scene) => scene.bulkVariant?.key === "one");
  const backgrounds = expandComponents(document, variant.id).layers.filter((layer) => layer.componentBackground);
  assert.deepEqual(backgrounds.map((layer) => layer.fillEnabled), [false, true]);
  assert.deepEqual(pixels(document, variant.id), pixels(document, "base"));
  document.scenes.push(createScene({ id: "ordinary", width: 10, height: 10, duration: 1, backgroundEnabled: false, layers: [
    createLayer("component", { id: "ordinary-instance", componentSceneId: "base", width: 10, height: 10 }),
  ] }));
  const ordinary = expandComponents(parseDocument(document), "ordinary");
  assert.deepEqual(ordinary.layers.filter((layer) => layer.componentBackground).map((layer) => layer.fillEnabled), [true, true]);
});
