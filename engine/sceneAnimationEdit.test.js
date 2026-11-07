import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { BACKGROUND_OWNER_ID } from "./sceneBackground.js";
import { editSceneAnimations } from "./sceneAnimationEdit.js";

const color = (id) => ({ id, name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#0000ff" } });
function fixture() {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", backgroundAnimations: [color("background")],
    layers: [createLayer("rectangle", { id: "card", animations: [color("layer-color")] })] })] }));
}

test("mixed layer and background edits and removals are pure, validated document changes", () => {
  const source = fixture(), snapshot = structuredClone(source);
  const next = editSceneAnimations(source, "main", [
    { layerId: "card", animationId: "layer-color", patch: { start: 0.5 } },
    { layerId: BACKGROUND_OWNER_ID, animationId: "background", patch: { start: 0.75, enabled: false } },
  ]);
  assert.equal(next.scenes[0].backgroundAnimations[0].start, 0.75);
  assert.equal(next.scenes[0].backgroundAnimations[0].enabled, false);
  assert.equal(next.scenes[0].layers[0].animations[0].start, 0.5);
  assert.deepEqual(source, snapshot);
  assert.equal(editSceneAnimations(source, "main", [{ layerId: "missing", animationId: "gone", patch: {} }]), null);
});

test("adding and editing backgrounds rejects non-Color changes without changing the source", () => {
  const source = fixture(), snapshot = structuredClone(source);
  assert.throws(() => editSceneAnimations(source, "main", [{ layerId: BACKGROUND_OWNER_ID, animationId: "background", patch: { to: { x: 20 } } }]), /only have Color animations/);
  assert.deepEqual(source, snapshot);
});
