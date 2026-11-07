import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { multiply, point, worldMatrix } from "./geometry.js";
import { resizeGroup, UnevenStretchError } from "./groupResize.js";
import { reparentLayer } from "./reparent.js";
import { shiftAnimation } from "./animationShift.js";
import { duplicateSceneInDocument } from "./sceneDuplication.js";
import { copyScene, pasteScene } from "./sceneClipboard.js";
import { createComponentInstance, detachComponent } from "./linkedComponents.js";
import { planBulkCreate, applyBulkCreate } from "./bulkCreate.js";

const move = (id, start = 0.2) => ({
  id, name: id, kind: "custom", start, duration: 0.8,
  easing: "linear", from: { x: 10, y: 20 }, to: { x: 70, y: 60 },
});
const color = (id, start = 0.2) => ({
  id, name: id, kind: "custom", start, duration: 0.8,
  easing: "linear", from: { fill: "#000000" }, to: { fill: "#ffffff" },
});
const group = (id, start, animations) => ({ id, name: id, kind: "composed", start, animations });

function parsed(layers, { backgroundAnimations = [], scenes = [] } = {}) {
  return parseDocument(createDocument({ id: "doc", scenes: [
    createScene({ id: "main", duration: 6, backgroundAnimations, layers }), ...scenes,
  ] }));
}

function animationIds(document) {
  const ids = [];
  function visit(items) {
    for (const item of items ?? []) {
      ids.push(item.id);
      if (item.kind === "composed") visit(item.animations);
    }
  }
  for (const scene of document.scenes) {
    visit(scene.backgroundAnimations);
    for (const layer of scene.layers) visit(layer.animations);
  }
  return ids;
}

function timingTree(items) {
  return items.map((item) => ({
    start: item.start,
    children: item.kind === "composed" ? timingTree(item.animations) : undefined,
  }));
}

function assertUniqueAnimations(document) {
  const ids = animationIds(document);
  assert.equal(ids.length, new Set(ids).size, "animation IDs are unique across the document");
  assert.doesNotThrow(() => parseDocument(document));
}

function assertMatrixClose(actual, expected, message) {
  for (let index = 0; index < 6; index += 1)
    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-5,
      `${message}: matrix entry ${index} was ${actual[index]}, expected ${expected[index]}`);
}

test("reparenting transforms nested endpoints and keeps their rendered motion", () => {
  const original = createLayer("rectangle", {
    id: "shape", x: 10, y: 20, width: 30, height: 15,
    animations: [group("outer", 0.1, [group("inner", 0.15, [move("move", 0.2)])])],
  });
  const document = parsed([original]);
  const layer = document.scenes[0].layers[0];
  const offset = [1, 0, 0, 1, 75, -25];
  const after = { ...layer, ...reparentLayer(layer, offset) };
  const shifted = shiftAnimation(layer.animations[0], 75, -25);
  assert.equal(shifted.animations[0].start, layer.animations[0].animations[0].start);
  assert.equal(shifted.animations[0].animations[0].to.y, move("m").to.y - 25);

  for (const time of [0, 0.1, 0.45, 0.8, 1.25]) {
    const before = worldMatrix(layer, [layer], (item) => evaluateLayer(item, time));
    const expected = multiply(offset, before);
    const actual = worldMatrix(after, [after], (item) => evaluateLayer(item, time));
    assertMatrixClose(actual, expected, `reparent at ${time}s`);
  }
});

test("resizing a group transforms nested animation geometry at every sampled time", () => {
  const parent = createLayer("group", { id: "parent", x: 100, y: 50, width: 100, height: 100 });
  const child = createLayer("rectangle", {
    id: "child", parentId: "parent", x: 10, y: 20, width: 30, height: 20,
    animations: [group("outer", 0.1, [group("inner", 0.15, [
      { ...move("move", 0.2), from: { x: 10, y: 20 }, to: { x: 50, y: 40 } },
    ])])],
  });
  const before = parsed([parent, child]).scenes[0].layers;
  const changes = new Map(resizeGroup(before, "parent", { x: 100, y: 50, width: 200, height: 200 }).map((change) => [change.id, change]));
  const after = before.map((layer) => changes.has(layer.id) ? { ...layer, ...changes.get(layer.id) } : layer);
  const stretch = [2, 0, 0, 2, -100, -50];
  for (const time of [0, 0.2, 0.5, 0.9, 1.3]) {
    const wasLayer = evaluateLayer(before[1], time);
    const was = worldMatrix(before[1], before, (item) => evaluateLayer(item, time));
    const originalCorners = [[0, 0], [wasLayer.width, 0], [wasLayer.width, wasLayer.height], [0, wasLayer.height]]
      .map(([x, y]) => point(was, x, y));
    const nowLayer = after.find((item) => item.id === "child");
    const evaluatedNow = evaluateLayer(nowLayer, time);
    const now = worldMatrix(nowLayer, after, (item) => evaluateLayer(item, time));
    const currentCorners = [[0, 0], [evaluatedNow.width, 0], [evaluatedNow.width, evaluatedNow.height], [0, evaluatedNow.height]]
      .map(([x, y]) => point(now, x, y));
    for (let index = 0; index < originalCorners.length; index += 1) {
      const expected = point(stretch, originalCorners[index].x, originalCorners[index].y);
      assert.ok(Math.abs(currentCorners[index].x - expected.x) < 1e-5, `group resize x corner at ${time}s`);
      assert.ok(Math.abs(currentCorners[index].y - expected.y) < 1e-5, `group resize y corner at ${time}s`);
    }
  }
});

test("nested animated rotation prevents an unsafe uneven group stretch", () => {
  const parent = createLayer("group", { id: "parent", width: 100, height: 100 });
  const child = createLayer("rectangle", {
    id: "child", parentId: "parent", x: 10, y: 10, width: 20, height: 20,
    animations: [group("outer", 0, [group("inner", 0.1, [
      { id: "turn", name: "turn", kind: "custom", start: 0.2, duration: 0.5,
        easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } },
    ])])],
  });
  const layers = parsed([parent, child]).scenes[0].layers;
  assert.throws(() => resizeGroup(layers, "parent", { x: 0, y: 0, width: 200, height: 100 }), UnevenStretchError);
});

test("scene duplication and scene clipboard remap every nested background and layer ID", () => {
  const original = parsed([
    createLayer("rectangle", { id: "shape", animations: [group("layer-group", 0.4, [group("layer-subgroup", 0.2, [move("layer-move")])])] }),
  ], { backgroundAnimations: [group("background-group", 0.1, [group("background-subgroup", 0.3, [color("background-color")])])] });
  const duplicate = duplicateSceneInDocument(original, "main").document;
  assertUniqueAnimations(duplicate);
  const sourceScene = duplicate.scenes[0], copiedScene = duplicate.scenes[1];
  assert.deepEqual(timingTree(copiedScene.backgroundAnimations), timingTree(sourceScene.backgroundAnimations));
  assert.deepEqual(timingTree(copiedScene.layers[0].animations), timingTree(sourceScene.layers[0].animations));

  const pasted = pasteScene(original, "main", copyScene(original, "main")).document;
  assertUniqueAnimations(pasted);
  assert.deepEqual(timingTree(pasted.scenes[1].backgroundAnimations), timingTree(sourceScene.backgroundAnimations));
  assert.deepEqual(timingTree(pasted.scenes[1].layers[0].animations), timingTree(sourceScene.layers[0].animations));
});

test("component detachment refreshes nested IDs and offsets only the outer group clock", () => {
  const base = createScene({ id: "base", name: "Base", duration: 4, isComponent: true, layers: [
    createLayer("rectangle", { id: "shape", name: "Shape", animations: [group("outer", 0.4, [group("inner", 0.25, [move("move")])])] }),
  ] });
  const page = createScene({ id: "page", duration: 6, layers: [
    createComponentInstance(base, { id: "instance", componentStart: 0.75 }),
  ] });
  const before = parseDocument(createDocument({ id: "components", scenes: [base, page] }));
  const after = parseDocument(detachComponent(before, "page", "instance"));
  assertUniqueAnimations(after);
  const detached = after.scenes.find((scene) => scene.id === "page").layers.find((layer) => layer.name === "Shape");
  assert.equal(detached.animations[0].start, 1.15);
  assert.equal(detached.animations[0].animations[0].start, 0.25);
  assert.equal(detached.animations[0].animations[0].animations[0].start, 0.2);
});

test("bulk-created variants remap nested background IDs and retain relative timing", () => {
  const document = parsed([
    createLayer("text", { id: "title", name: "Title", text: "Base" }),
  ], { backgroundAnimations: [group("background", 0.1, [group("nested", 0.3, [color("color")])])] });
  const plan = planBulkCreate(document, "main", ["id", "Title"], [["one", "Variant"]]);
  const created = parseDocument(applyBulkCreate(document, plan));
  assertUniqueAnimations(created);
  assert.deepEqual(timingTree(created.scenes[1].backgroundAnimations), timingTree(created.scenes[0].backgroundAnimations));
  const originalIds = new Set(animationIds(document));
  assert.ok(animationIds(created.scenes[1] ? { scenes: [created.scenes[1]] } : created).every((id) => !originalIds.has(id)));
});
