// Hide and Show through the editing paths: apply_operations, the clipboard, and Duplicate.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { evaluateLayer } from "./animation.js";
import { copyAnimation, copyLayers, pasteAnimations, pasteLayers } from "./layerClipboard.js";
import { duplicateSelection } from "./duplicate.js";

const hide = (start, id = `hide-${start}`) => ({ id, name: "Hide", kind: "hide", start });
const show = (start, id = `show-${start}`) => ({ id, name: "Show", kind: "show", start });

function documentWith(layers, duration = 4) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", duration, layers })] }));
}

const layerOf = (document, id) => document.scenes[0].layers.find((layer) => layer.id === id);

test("add_animation adds Hide and Show from a preset or an animation object", () => {
  const source = documentWith([createLayer("rectangle", { id: "box" })]);
  const result = applyOperations(source, [
    { type: "add_animation", sceneId: "main", layerId: "box", preset: "hide", start: 1 },
    { type: "add_animation", sceneId: "main", layerId: "box", animation: { id: "back", name: "Back", kind: "show", start: 2.5 } },
  ]);
  const [added, back] = layerOf(result, "box").animations;
  assert.deepEqual({ ...added, id: "x" }, { id: "x", name: "Hide", kind: "hide", start: 1 });
  assert.deepEqual(back, { id: "back", name: "Back", kind: "show", start: 2.5 });
  const box = layerOf(result, "box");
  assert.deepEqual([0.5, 1, 2, 2.5].map((time) => evaluateLayer(box, time).visible), [true, false, false, true]);
});

test("apply_operations refuses a Hide or Show outside the scene, and timed fields on it", () => {
  const source = documentWith([createLayer("rectangle", { id: "box", animations: [hide(1, "h")] })], 4);
  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "box", preset: "show", start: 5 }]),
    /Show at 5 s is outside the scene, which lasts 4 s/);
  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "box", animation: { name: "Hide", kind: "hide", start: -0.5 } }]),
    /outside the scene/);
  assert.throws(() => applyOperations(source, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: "h", properties: { start: 4.01 } }]),
    /Hide at 4\.01 s is outside the scene/);
  assert.throws(() => applyOperations(source, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: "h", properties: { duration: 1 } }]),
    /instant and cannot have duration/);
  const moved = applyOperations(source, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: "h", properties: { start: 4, kind: "show" } }]);
  assert.deepEqual(layerOf(moved, "box").animations[0], { id: "h", name: "Hide", kind: "show", start: 4 });
  const deleted = applyOperations(source, [{ type: "delete_animation", sceneId: "main", layerId: "box", animationId: "h" }]);
  assert.deepEqual(layerOf(deleted, "box").animations, []);
});

test("copying a Hide or Show and pasting it keeps it instant, at the time cursor", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "box", x: 10, opacity: 0.5, animations: [hide(1, "h")] }),
    createLayer("ellipse", { id: "other", x: 200, opacity: 1 }),
  ]);
  // Through the clipboard as text, as a paste in another window receives it.
  const envelope = JSON.parse(JSON.stringify(copyAnimation(document, "main", "box", "h")));
  const { document: pasted, pasted: ids } = pasteAnimations(document, "main", ["other"], envelope, 2.5);
  const copy = layerOf(pasted, "other").animations[0];
  assert.equal(copy.id, ids[0].animationIds[0]);
  assert.notEqual(copy.id, "h");
  assert.deepEqual({ ...copy, id: "x" }, { id: "x", name: "Hide", kind: "hide", start: 2.5 });
});

test("copied, pasted and duplicated layers keep their Hide and Show operations with new IDs", () => {
  const document = documentWith([createLayer("rectangle", { id: "box", animations: [hide(1, "h"), show(2, "s")] })]);
  const { document: pasted } = pasteLayers(document, "main", copyLayers(document, "main", ["box"]));
  const copy = pasted.scenes[0].layers.find((layer) => layer.id !== "box");
  assert.deepEqual(copy.animations.map(({ kind, start }) => [kind, start]), [["hide", 1], ["show", 2]]);
  assert.ok(copy.animations.every((animation) => !["h", "s"].includes(animation.id)));

  const { document: duplicated, rootIds } = duplicateSelection(document, "main", ["box"]);
  const duplicate = layerOf(parseDocument(duplicated), rootIds[0]);
  assert.deepEqual(duplicate.animations.map(({ name, kind, start }) => [name, kind, start]), [["Hide", "hide", 1], ["Show", "show", 2]]);
  assert.deepEqual([0, 1, 2].map((time) => evaluateLayer(duplicate, time).visible), [true, false, true]);
});

test("after the scene gets shorter, a Hide or Show past its end can still be renamed or switched", () => {
  const source = documentWith([createLayer("rectangle", { id: "box", animations: [hide(1, "h"), show(1.5, "s")] })], 2);
  const shorter = applyOperations(source, [{ type: "update_scene", sceneId: "main", properties: { duration: 0.5 } }]);
  const edited = applyOperations(shorter, [
    { type: "update_animation", sceneId: "main", layerId: "box", animationId: "h", properties: { name: "Vanish" } },
    { type: "update_animation", sceneId: "main", layerId: "box", animationId: "h", properties: { kind: "show" } },
    { type: "update_animations", sceneId: "main", animationIds: ["h", "s"], properties: { name: "Toggle" } },
  ]);
  assert.deepEqual(layerOf(edited, "box").animations, [
    { id: "h", name: "Toggle", kind: "show", start: 1 },
    { id: "s", name: "Toggle", kind: "show", start: 1.5 },
  ]);
  // A new time is still checked, also one equal to another operation's time, and so is a timed
  // animation that becomes a Hide or Show where it is.
  const update = (properties, animationId = "h") => applyOperations(shorter, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId, properties }]);
  assert.throws(() => update({ start: 0.75 }), /Hide at 0\.75 s is outside the scene, which lasts 0\.5 s/);
  assert.throws(() => applyOperations(shorter, [{ type: "update_animations", sceneId: "main", animationIds: ["h", "s"], properties: { start: 1.5 } }]),
    /Hide at 1\.5 s is outside the scene/);
  assert.equal(layerOf(update({ start: 0.25 }), "box").animations[0].start, 0.25);
  const timed = applyOperations(shorter, [{ type: "add_animation", sceneId: "main", layerId: "box",
    animation: { id: "fade", name: "Fade", kind: "in", start: 0, duration: 0.25, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } } }]);
  const later = applyOperations(timed, [{ type: "update_scene", sceneId: "main", properties: { duration: 2 } },
    { type: "update_animation", sceneId: "main", layerId: "box", animationId: "fade", properties: { start: 1 } },
    { type: "update_scene", sceneId: "main", properties: { duration: 0.5 } }]);
  assert.throws(() => applyOperations(later, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: "fade",
    properties: { kind: "hide", duration: undefined, easing: undefined, from: undefined, to: undefined } }]), /Hide at 1 s is outside the scene/);
});
