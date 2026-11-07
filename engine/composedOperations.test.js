import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { animationPlaybackLength } from "./playback.js";
import { animationTreeEntries } from "./animationTree.js";
import { applyOperations } from "./operations.js";

function move(id, start, duration, from, to) {
  return { id, name: id, kind: "custom", start, duration, easing: "linear", from: { x: from }, to: { x: to } };
}

function color(id, start, from, to) {
  return { id, name: id, kind: "custom", start, duration: 1, easing: "linear", from: { fill: from }, to: { fill: to } };
}

function fixture({ locked = false } = {}) {
  const layer = createLayer("rectangle", {
    id: "card", locked,
    animations: [move("first", 0.25, 0.75, 0, 100), move("second", 1.25, 0.5, 100, 200)],
  });
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", layers: [layer] })] }));
}

function layerOf(document) { return document.scenes[0].layers[0]; }
function valueAt(document, time) { return evaluateLayer(layerOf(document), time).x; }

test("apply_operations groups siblings, stretches the derived span, renames, and ungroups at the current times", () => {
  const source = fixture();
  const grouped = applyOperations(source, [{ type: "group_animations", sceneId: "main", animationIds: ["first", "second"] }]);
  const group = layerOf(grouped).animations[0];
  assert.equal(group.kind, "composed");
  assert.equal(group.name, "Composed");
  assert.equal(group.start, 0.25);
  assert.equal(Object.hasOwn(group, "duration"), false);
  assert.deepEqual(group.animations.map(({ id, start }) => [id, start]), [["first", 0], ["second", 1]]);
  for (const time of [0, 0.25, 0.5, 1, 1.25, 1.5, 1.75, 2])
    assert.equal(valueAt(grouped, time), valueAt(source, time), `grouping changed the value at ${time}s`);
  assert.equal(animationPlaybackLength(layerOf(grouped), group), 1.5);

  const stretched = applyOperations(grouped, [{ type: "update_animation", sceneId: "main", layerId: "card", animationId: group.id,
    properties: { duration: 3, name: "Intro" } }]);
  const stretchedGroup = layerOf(stretched).animations[0];
  assert.equal(stretchedGroup.name, "Intro");
  assert.equal(animationPlaybackLength(layerOf(stretched), stretchedGroup), 3);
  assert.deepEqual(stretchedGroup.animations.map(({ start, duration }) => [start, duration]), [[0, 1.5], [2, 1]]);

  const ungrouped = applyOperations(stretched, [{ type: "ungroup_animations", sceneId: "main", animationIds: [stretchedGroup.id] }]);
  assert.deepEqual(layerOf(ungrouped).animations.map(({ id, start, duration }) => [id, start, duration]),
    [["first", 0.25, 1.5], ["second", 2.25, 1]]);
  assert.deepEqual(source.scenes[0].layers[0].animations.map(({ start, duration }) => [start, duration]), [[0.25, 0.75], [1.25, 0.5]]);
});

test("duplicate_animations copies a composed row with fresh recursive IDs and identical playback", () => {
  const source = fixture();
  const grouped = applyOperations(source, [{ type: "group_animations", sceneId: "main", animationIds: ["first", "second"], name: "Pair" }]);
  const original = layerOf(grouped).animations[0];
  const copied = applyOperations(grouped, [{ type: "duplicate_animations", sceneId: "main", animationIds: [original.id] }]);
  const rows = layerOf(copied).animations;
  assert.equal(rows.length, 2);
  const duplicate = rows[1];
  assert.equal(duplicate.name, original.name);
  assert.equal(duplicate.start, original.start);
  assert.deepEqual(duplicate.animations.map(({ start, duration, from, to }) => ({ start, duration, from, to })),
    original.animations.map(({ start, duration, from, to }) => ({ start, duration, from, to })));
  const originalIds = new Set(animationTreeEntries([original]).map(({ animation }) => animation.id));
  const duplicateEntries = animationTreeEntries([duplicate]);
  assert.ok(duplicateEntries.every(({ animation }) => !originalIds.has(animation.id)));
  assert.equal(new Set(duplicateEntries.map(({ animation }) => animation.id)).size, duplicateEntries.length);
  for (const time of [0, 0.25, 0.5, 1, 1.25, 1.5, 1.75, 2])
    assert.equal(valueAt(copied, time), valueAt(grouped, time), `duplicate changed playback at ${time}s`);
});

test("group and ungroup preserve per-member enabled states and a disabled group state", () => {
  const source = applyOperations(fixture(), [{ type: "update_animation", sceneId: "main", layerId: "card", animationId: "first", properties: { enabled: false } }]);
  const grouped = applyOperations(source, [{ type: "group_animations", sceneId: "main", animationIds: ["first", "second"] }]);
  const group = layerOf(grouped).animations[0];
  assert.equal(group.animations[0].enabled, false);
  assert.equal(group.animations[1].enabled, undefined);
  const disabled = applyOperations(grouped, [{ type: "update_animation", sceneId: "main", layerId: "card", animationId: group.id, properties: { enabled: false } }]);
  const ungrouped = applyOperations(disabled, [{ type: "ungroup_animations", sceneId: "main", animationIds: [group.id] }]);
  assert.ok(layerOf(ungrouped).animations.every(({ enabled }) => enabled === false));
});

test("nested update_animation uses absolute scene time and delete_animation prunes empty groups", () => {
  const grouped = applyOperations(fixture(), [{ type: "group_animations", sceneId: "main", animationIds: ["first", "second"] }]);
  const group = layerOf(grouped).animations[0];
  assert.throws(() => applyOperations(grouped, [{ type: "update_animations", sceneId: "main", animationIds: [group.id, "first"], properties: { start: 1 } }]), /group and one of its members/);
  const moved = applyOperations(grouped, [{ type: "update_animations", sceneId: "main", animationIds: ["second"], properties: { start: 1.75 } }]);
  assert.equal(layerOf(moved).animations[0].animations[1].start, 1.5, "stored start remains relative to the group");
  assert.throws(() => applyOperations(grouped, [{ type: "update_animations", sceneId: "main", animationIds: [{ layerId: "other", animationId: "second" }], properties: { start: 1 } }]), /not found on layer/);
  const shifted = applyOperations(moved, [{ type: "update_animation", sceneId: "main", layerId: "card", animationId: "first", properties: { start: 0.1 } }]);
  assert.equal(layerOf(shifted).animations[0].start, 0.1, "the group origin follows a member moved before it");
  assert.deepEqual(layerOf(shifted).animations[0].animations.map(({ id, start }) => [id, start]), [["first", 0], ["second", 1.65]]);
  const deleted = applyOperations(shifted, [{ type: "delete_animation", sceneId: "main", layerId: "card", animationId: "second" }]);
  assert.equal(layerOf(deleted).animations[0].id, group.id);
  assert.deepEqual(layerOf(deleted).animations[0].animations.map(({ id, start }) => [id, start]), [["first", 0]]);
  const deletedLast = applyOperations(deleted, [{ type: "delete_animation", sceneId: "main", layerId: "card", animationId: "first" }]);
  assert.deepEqual(layerOf(deletedLast).animations, []);
});

test("stagger_animations edits nested members in absolute scene time and rejects parent plus child", () => {
  const grouped = applyOperations(fixture(), [{ type: "group_animations", sceneId: "main", animationIds: ["first", "second"] }]);
  const group = layerOf(grouped).animations[0];
  const staggered = applyOperations(grouped, [{ type: "stagger_animations", sceneId: "main", items: ["first", "second"], delay: 0.5, order: "selection" }]);
  assert.deepEqual(layerOf(staggered).animations[0].animations.map(({ id, start }) => [id, start]), [["first", 0], ["second", 0.5]]);
  assert.throws(() => applyOperations(grouped, [{ type: "stagger_animations", sceneId: "main", items: [group.id, "first"], delay: 0.25 }]), /more than once|group together/);
});

test("rename_animation targets nested rows and convert_to_actions splits a supported non-text preset", () => {
  const source = fixture();
  const presetDoc = applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "card", preset: "preset-blur-slide", start: 0.5 }]);
  const preset = layerOf(presetDoc).animations.find(({ preset: value }) => value);
  const converted = applyOperations(presetDoc, [{ type: "convert_to_actions", sceneId: "main", animationIds: [preset.id] }]);
  const composition = layerOf(converted).animations.find(({ id }) => id === preset.id);
  assert.equal(composition.kind, "composed");
  assert.equal(composition.start, preset.start);
  assert.ok(composition.animations.length >= 2);
  assert.ok(composition.animations.every(({ start }) => start === 0));
  const firstAction = composition.animations[0];
  const renamed = applyOperations(converted, [{ type: "rename_animation", sceneId: "main", layerId: "card", animationId: firstAction.id, name: "Travel" }]);
  assert.equal(layerOf(renamed).animations.find(({ id }) => id === preset.id).animations[0].name, "Travel");
});

test("same-owner Composed groups work for scene background Color animations", () => {
  const source = parseDocument(createDocument({ scenes: [createScene({ id: "main", backgroundAnimations: [
    color("background-a", 0, "#ffffff", "#ff0000"), color("background-b", 1, "#ff0000", "#0000ff"),
  ] })] }));
  const grouped = applyOperations(source, [{ type: "group_animations", sceneId: "main", animationIds: ["background-a", "background-b"], name: "Background" }]);
  const group = grouped.scenes[0].backgroundAnimations[0];
  assert.equal(group.kind, "composed");
  const renamed = applyOperations(grouped, [{ type: "rename_animation", sceneId: "main", animationId: group.id, name: "Colors" }]);
  assert.equal(renamed.scenes[0].backgroundAnimations[0].name, "Colors");
  const ungrouped = applyOperations(renamed, [{ type: "ungroup_animations", sceneId: "main", animationIds: [group.id] }]);
  assert.deepEqual(ungrouped.scenes[0].backgroundAnimations.map(({ id, start }) => [id, start]), [["background-a", 0], ["background-b", 1]]);
});

test("group operations reject malformed, missing, duplicate, cross-layer, and locked-owner selections atomically", () => {
  const source = fixture(), snapshot = structuredClone(source);
  const invalid = [
    { type: "group_animations", sceneId: "main", animationIds: [] },
    { type: "group_animations", sceneId: "main", animationIds: ["first", "first"] },
    { type: "group_animations", sceneId: "main", animationIds: ["missing", "first"] },
    { type: "group_animations", sceneId: "main", animationIds: ["first", 2] },
    { type: "group_animations", sceneId: "main", animationIds: ["first", "second"], name: "  " },
  ];
  for (const operation of invalid) assert.throws(() => applyOperations(source, [operation]));
  assert.throws(() => applyOperations(source, [{ type: "rename_animation", sceneId: "main", animationId: "first", name: "  " }]), /name must be text/);
  assert.throws(() => applyOperations(source, [{ type: "rename_animation", sceneId: "main", animationId: "has space", name: "Valid" }]), /valid animation ID/);
  const twoLayers = structuredClone(source);
  twoLayers.scenes[0].layers.push(createLayer("rectangle", { id: "other", animations: [move("other-move", 0, 1, 0, 1)] }));
  assert.throws(() => applyOperations(twoLayers, [{ type: "group_animations", sceneId: "main", animationIds: ["first", "other-move"] }]), /same layer/);
  assert.throws(() => applyOperations(fixture({ locked: true }), [{ type: "group_animations", sceneId: "main", animationIds: ["first", "second"] }]), /Unlock/);
  assert.throws(() => applyOperations(source, [
    { type: "rename_project", name: "Must not persist" },
    { type: "group_animations", sceneId: "main", animationIds: ["missing", "first"] },
  ]), /not found/);
  assert.deepEqual(source, snapshot);
});

test("grouping refuses to exceed the model's nesting limit without mutating the source", () => {
  let animations = [move("deep-a", 0, 1, 0, 1), move("deep-b", 1, 1, 1, 2)];
  for (let depth = 7; depth >= 0; depth -= 1)
    animations = [{ id: `group-${depth}`, name: "Composed", kind: "composed", start: 0, animations }];
  const layer = createLayer("rectangle", { id: "deep", animations });
  const source = parseDocument(createDocument({ scenes: [createScene({ id: "main", layers: [layer] })] }));
  const snapshot = structuredClone(source);
  assert.throws(() => applyOperations(source, [{ type: "group_animations", sceneId: "main", animationIds: ["deep-a", "deep-b"] }]), /nesting exceeds 8 levels/);
  assert.deepEqual(source, snapshot);
});

test("convert_to_actions refuses missing or unsupported operation IDs without saving earlier edits", () => {
  const source = fixture();
  assert.throws(() => applyOperations(source, [{ type: "convert_to_actions", sceneId: "main", animationIds: ["first"] }]), /preset/);
  assert.throws(() => applyOperations(source, [
    { type: "rename_project", name: "Must not persist" },
    { type: "convert_to_actions", sceneId: "main", animationIds: ["missing"] },
  ]), /not found/);
  assert.equal(source.name, "New file");
});

test("adding a Composed row still runs every nested animation compatibility check", () => {
  const layer = createLayer("group", { id: "group-layer" });
  const source = parseDocument(createDocument({ scenes: [createScene({ id: "main", layers: [layer] })] }));
  const composedResize = { id: "composed-resize", name: "Composed", kind: "composed", start: 0,
    animations: [{ id: "inner-resize", name: "Resize", kind: "custom", start: 0, duration: 1, easing: "linear", from: { width: 10 }, to: { width: 20 } }] };
  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "group-layer", animation: composedResize }]), /Resize.*can't be added/);
  assert.deepEqual(source.scenes[0].layers[0].animations, []);
});
