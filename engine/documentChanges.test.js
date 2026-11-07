import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { CHANGE_LIST_LIMIT, documentChanges } from "./documentChanges.js";

test("an edit lists the IDs it created, changed and removed", () => {
  const before = applyOperations(createDocument({ name: "Promo" }), [
    { type: "add_scene", properties: { id: "intro", name: "Intro" } },
    { type: "add_layer", sceneId: "intro", layerType: "rectangle", properties: { id: "card" } },
    { type: "add_layer", sceneId: "intro", layerType: "text", properties: { id: "old-note", text: "Draft" } },
  ]);
  const after = applyOperations(before, [
    { type: "add_layer", sceneId: "intro", layerType: "text", properties: { id: "hero-title", text: "Plan the week" } },
    { type: "add_animation", sceneId: "intro", layerId: "hero-title", animation: {
      id: "hero-title.in", name: "In", kind: "in", start: 0, duration: 0.5, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 },
    } },
    { type: "update_layer", sceneId: "intro", layerId: "card", properties: { fill: "#ff7a45" } },
    { type: "delete_layer", sceneId: "intro", layerId: "old-note" },
  ]);
  assert.deepEqual(documentChanges(before, after), {
    created: ["hero-title", "hero-title.in"],
    changed: ["card"],
    removed: ["old-note"],
  });
});

test("an animation change is listed on the animation, not on its layer", () => {
  const before = applyOperations(createDocument({}), [
    { type: "add_scene", properties: { id: "s" } },
    { type: "add_layer", sceneId: "s", layerType: "rectangle", properties: { id: "box" } },
    { type: "add_animation", sceneId: "s", layerId: "box", animation: {
      id: "box.in", name: "In", kind: "in", start: 0, duration: 0.5, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 },
    } },
  ]);
  const after = applyOperations(before, [
    { type: "update_animation", sceneId: "s", layerId: "box", animationId: "box.in", properties: { start: 1 } },
    { type: "rename_project", name: "Renamed" },
  ]);
  assert.deepEqual(documentChanges(before, after), { created: [], changed: ["box.in"], removed: [], project: ["name"] });
});

test("long change lists are cut and the rest is counted", () => {
  const before = applyOperations(createDocument({}), [{ type: "add_scene", properties: { id: "s" } }]);
  const many = Array.from({ length: CHANGE_LIST_LIMIT + 5 }, (_, index) => ({
    type: "add_layer", sceneId: "s", layerType: "rectangle", properties: { id: `box-${index}` },
  }));
  const changes = documentChanges(before, applyOperations(before, many));
  assert.equal(changes.created.length, CHANGE_LIST_LIMIT);
  assert.equal(changes.createdMore, 5);
});
