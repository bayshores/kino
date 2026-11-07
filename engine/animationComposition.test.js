import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TIME, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { composeAnimations, duplicateAnimations, ungroupAnimations } from "./animationComposition.js";
import { animationTreeEntries, flattenAnimations, scaleAnimationTimes } from "./animationTree.js";
import { enabledAnimations } from "./animationEnabled.js";
import { evaluateLayer } from "./animation.js";
import { editSceneAnimations } from "./sceneAnimationEdit.js";
import { copyAnimations, pasteAnimations } from "./layerClipboard.js";
import { selectedAnimationEntries } from "./animationSelection.js";

const operation = (id, start, duration, from, to) => ({ id, name: id, kind: "custom", start, duration, easing: "linear", from, to, unit: "layer", stagger: 0, order: "forward" });
function fixture(type = "rectangle") {
  return parseDocument(createDocument({ id: "composition", scenes: [createScene({ id: "main", duration: 10, layers: [
    createLayer(type, { id: "one", x: 0, text: "Text", animations: [operation("move", 1, 1, { x: 0 }, { x: 100 }), operation("fade", 2, 2, { opacity: 0 }, { opacity: 1 })] }),
    createLayer(type, { id: "two", x: 300, text: "Words" }),
  ] })] }));
}
const layerOf = (document) => document.scenes[0].layers[0];
const pose = (layer, time) => { const state = evaluateLayer(layer, time); return [state.x, state.y, state.opacity, state.rotation, state.visible]; };

test("group, nested duration edits, and ungroup preserve clocks and evaluated motion", () => {
  const source = fixture(), snapshot = structuredClone(source);
  const grouped = composeAnimations(source, "main", ["move", "fade"]);
  const group = layerOf(grouped.document).animations[0];
  assert.equal(group.kind, "composed");
  assert.equal(group.start, 1);
  assert.equal(Object.hasOwn(group, "duration"), false);
  assert.deepEqual(group.animations.map((item) => item.start), [0, 1]);
  for (const time of [0, 1, 1.5, 2, 3, 4, 6]) assert.deepEqual(pose(layerOf(grouped.document), time), pose(layerOf(source), time));
  const stretched = editSceneAnimations(grouped.document, "main", [{ layerId: "one", animationId: group.id, patch: { duration: 6 } }]);
  assert.deepEqual(flattenAnimations(layerOf(stretched).animations).map(({ start, duration }) => [start, duration]), [[1, 2], [3, 4]]);
  const ungrouped = ungroupAnimations(stretched, "main", [group.id]);
  assert.deepEqual(ungrouped.animationIds, ["move", "fade"]);
  for (const time of [0, 1, 2, 3, 5, 7]) assert.deepEqual(pose(layerOf(ungrouped.document), time), pose(layerOf(stretched), time));
  assert.deepEqual(source, snapshot);
  // Stretching a member stretches its per-word delays too.
  assert.deepEqual(scaleAnimationTimes({ start: 1, duration: 1, delays: [0, 0.4] }, 2), { start: 2, duration: 2, delays: [0, 0.8] });
});

test("child edits use absolute scene time and moving before a group shifts its origin", () => {
  const grouped = composeAnimations(fixture(), "main", ["move", "fade"]);
  const edited = editSceneAnimations(grouped.document, "main", [{ layerId: "one", animationId: "fade", patch: { start: 0.5 } }]);
  const group = layerOf(edited).animations[0];
  assert.equal(group.start, 0.5);
  assert.deepEqual(flattenAnimations([group]).map(({ id, start }) => [id, start]), [["move", 1], ["fade", 0.5]]);
  assert.equal(group.animations[0].start, 0.5);
});

test("duplication refreshes every nested ID and inserts after its original", () => {
  const grouped = composeAnimations(fixture(), "main", ["move", "fade"]);
  const duplicate = duplicateAnimations(grouped.document, "main", grouped.animationIds);
  const list = layerOf(duplicate.document).animations;
  assert.equal(list.length, 2);
  assert.equal(list[0].id, grouped.animationIds[0]);
  assert.equal(list[1].id, duplicate.animationIds[0]);
  const ids = animationTreeEntries(list).map(({ animation }) => animation.id);
  assert.equal(new Set(ids).size, 6);
  assert.deepEqual(flattenAnimations([list[1]]).map(({ start, duration }) => [start, duration]), [[1, 1], [2, 2]]);
});

test("composed partial Shadow tracks retain channels and evaluated values through duplicate and ungroup", () => {
  const source = fixture(), layer = layerOf(source);
  const rest = { color: "#ff000080", x: 0, y: 4, blur: 3 };
  layer.shadow = rest;
  layer.animations = [
    { ...operation("geometry", 0.5, 1.5, { shadow: rest }, { shadow: { ...rest, x: 30, blur: 9 } }), shadowChannels: ["x", "blur"] },
    { ...operation("color", 1, 1, { shadow: rest }, { shadow: { ...rest, color: "#0000ffff" } }), shadowChannels: ["color"] },
  ];
  const original = parseDocument(source);
  assert.deepEqual(evaluateLayer(layerOf(original), 1.5).shadow, { color: "#80008080", x: 20, y: 4, blur: 7 });
  const grouped = composeAnimations(original, "main", ["geometry", "color"]);
  const duplicated = duplicateAnimations(grouped.document, "main", grouped.animationIds);
  const ungrouped = ungroupAnimations(duplicated.document, "main", [...grouped.animationIds, ...duplicated.animationIds]);
  assert.deepEqual(layerOf(ungrouped.document).animations.map((item) => item.shadowChannels), [["x", "blur"], ["color"], ["x", "blur"], ["color"]]);
  for (const time of [0, 0.5, 0.75, 1, 1.5, 2, 3]) {
    const expected = evaluateLayer(layerOf(original), time).shadow;
    for (const result of [grouped, duplicated, ungrouped])
      assert.deepEqual(evaluateLayer(layerOf(result.document), time).shadow, expected, `Shadow at ${time}`);
  }
});

test("copying a group rebases every member and copying its child uses the scene clock", () => {
  const grouped = composeAnimations(fixture(), "main", ["move", "fade"]);
  const copied = copyAnimations(grouped.document, "main", grouped.animationIds);
  const pasted = pasteAnimations(grouped.document, "main", ["two"], copied, 4);
  const destination = pasted.document.scenes[0].layers[1];
  const members = flattenAnimations(destination.animations);
  assert.deepEqual(members.map(({ start }) => start), [4, 5]);
  assert.deepEqual(members[0].from, { x: 300 });
  assert.deepEqual(members[0].to, { x: 400 });
  assert.notEqual(members[0].id, "move");
  assert.equal(copyAnimations(grouped.document, "main", ["fade"]).animations[0].start, 2);
});

test("disabled groups suppress descendants and ungroup retains that state", () => {
  const grouped = composeAnimations(fixture(), "main", ["move", "fade"]);
  const group = layerOf(grouped.document).animations[0]; group.enabled = false;
  assert.deepEqual(enabledAnimations([group]), []);
  const result = ungroupAnimations(grouped.document, "main", [group.id]);
  assert.ok(layerOf(result.document).animations.every((item) => item.enabled === false));
  assert.deepEqual(selectedAnimationEntries([layerOf(grouped.document)], [group.id, "move"]).map(({ animation }) => animation.id), [group.id]);
});

test("group validation rejects duplicate IDs, unsupported fields, deep groups and absolute overrun", () => {
  const base = fixture();
  const withGroup = (group) => ({ ...base, scenes: [{ ...base.scenes[0], layers: [{ ...layerOf(base), animations: [group] }] }] });
  const group = { id: "group", name: "Composed", kind: "composed", start: 0, animations: layerOf(base).animations };
  assert.throws(() => parseDocument(withGroup({ ...group, duration: 2 })), /not a Composed group field/);
  assert.throws(() => parseDocument(withGroup({ ...group, animations: [group.animations[0], group.animations[0]] })), /duplicate animation ID/);
  assert.throws(() => parseDocument(withGroup({ ...group, start: MAX_TIME - 1 })), /absolute start plus duration/);
  let deep = group;
  for (let i = 0; i < 9; i++) deep = { ...group, id: `group-${i}`, animations: [deep] };
  assert.throws(() => parseDocument(withGroup(deep)), /8 levels/);
  assert.throws(() => composeAnimations(base, "main", ["move", "missing"]), /not found/);
});
