import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "./model.js";
import { isEffectivelyHidden, isEffectivelyLocked, unlockedLayerIds } from "./layerTree.js";

function sampleScene() {
  return createScene({
    id: "scene",
    layers: [
      createLayer("rectangle", { id: "back", name: "Back" }),
      createLayer("group", { id: "card", name: "Card" }),
      createLayer("text", { id: "title", name: "Title", parentId: "card" }),
      createLayer("group", { id: "icons", name: "Icons", parentId: "card" }),
      createLayer("star", { id: "star", name: "Star", parentId: "icons" }),
      createLayer("rectangle", { id: "front", name: "Front" }),
    ],
  });
}

test("a locked or hidden group locks or hides every layer inside it, at any depth", () => {
  const scene = sampleScene();
  scene.layers.find((layer) => layer.id === "card").locked = true;
  assert.equal(isEffectivelyLocked(scene.layers, "star"), true);
  assert.equal(isEffectivelyLocked(scene.layers, "title"), true);
  assert.equal(isEffectivelyLocked(scene.layers, "card"), true);
  assert.equal(isEffectivelyLocked(scene.layers, "front"), false);
  assert.equal(isEffectivelyLocked(scene.layers, "missing"), false);
  // The child's own flag is unchanged: unlocking the group unlocks it again.
  assert.equal(scene.layers.find((layer) => layer.id === "star").locked, false);
  assert.deepEqual(unlockedLayerIds(scene.layers, ["front", "star", "card", "back", "missing"]), ["front", "back"]);

  scene.layers.find((layer) => layer.id === "icons").visible = false;
  assert.equal(isEffectivelyHidden(scene.layers, "star"), true);
  assert.equal(isEffectivelyHidden(scene.layers, "icons"), true);
  assert.equal(isEffectivelyHidden(scene.layers, "title"), false);
});

test("a parent loop does not hang the lock check", () => {
  const layers = [createLayer("group", { id: "a", parentId: "b" }), createLayer("group", { id: "b", parentId: "a", locked: true })];
  assert.equal(isEffectivelyLocked(layers, "a"), true);
  assert.equal(isEffectivelyHidden(layers, "a"), false);
});
