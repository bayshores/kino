import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, parseDocument } from "./model.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { layerMatrix, multiply, parentMatrix, worldMatrix } from "./geometry.js";
import { groupLayers, maskTargets, paintOrder, ungroupLayers } from "./grouping.js";
import { createComponentFromLayers } from "./createComponent.js";
import { reparentLayer } from "./reparent.js";
import { applyOperations } from "./operations.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { resizeTextLayer } from "./textLayout.js";

const TIMES = [0, 0.15, 0.3, 0.45, 0.6, 0.9, 1.4];

function documentWith(layers) {
  const document = createDocument();
  document.scenes[0].layers = layers;
  return document;
}

function animation(id, from, to, start = 0, duration = 1) {
  return { id, name: id, kind: "custom", start, duration, easing: "ease-in", from, to };
}

// World matrix of every layer at a time, with animations applied (what the renderer draws).
function worldAt(layers, time) {
  return new Map(layers.map((layer) => [layer.id, worldMatrix(layer, layers, (item) => evaluateLayer(item, time))]));
}

function assertSameLook(before, after, ids, message = "") {
  for (const time of TIMES) {
    const was = worldAt(before, time),
      now = worldAt(after, time);
    for (const id of ids) {
      const a = was.get(id),
        b = now.get(id);
      for (let index = 0; index < 6; index += 1) {
        assert.ok(
          Math.abs(a[index] - b[index]) < 1e-5,
          `${message} ${id} at ${time}s: [${a.map((v) => v.toFixed(4))}] became [${b.map((v) => v.toFixed(4))}]`,
        );
      }
    }
  }
}

function sceneLayers(document) {
  return document.scenes[0].layers;
}

test("grouping layers that share a parent moves their animated positions with them", () => {
  // The old group() subtracted the group's corner from x/y but left slide animations
  // pointing at the old absolute values, so the layers jumped while they played.
  const a = createLayer("rectangle", { id: "a", x: 100, y: 120, width: 40, height: 30 });
  const b = createLayer("ellipse", { id: "b", x: 260, y: 80, width: 50, height: 50, rotation: 25 });
  a.animations.push({ ...presetAnimation("slide-left", a, 0), id: "slide" });
  b.animations.push({ ...presetAnimation("move", b, 0.2), id: "move" }, animation("spin", { rotation: 0 }, { rotation: 180 }, 0.1));
  const document = documentWith([a, b]);
  const { layers, groupId } = groupLayers(document, document.scenes[0].id, ["a", "b"], { id: "g" });
  assert.equal(groupId, "g");
  assert.deepEqual(layers.map((layer) => layer.id), ["g", "a", "b"]);
  assert.ok(layers.slice(1).every((layer) => layer.parentId === "g"));
  assertSameLook(sceneLayers(document), layers, ["a", "b"]);
  parseDocument(documentWith(layers));
});

test("the group box covers rotated layers and takes the top-most layer's place", () => {
  const below = createLayer("rectangle", { id: "below", x: 0, y: 0, width: 10, height: 10 });
  const rotated = createLayer("rectangle", { id: "rotated", x: 100, y: 100, width: 100, height: 20, rotation: 90 });
  const middle = createLayer("rectangle", { id: "middle", x: 400, y: 400, width: 10, height: 10 });
  const top = createLayer("rectangle", { id: "top", x: 300, y: 50, width: 20, height: 20 });
  const document = documentWith([below, rotated, middle, top]);
  const { layers } = groupLayers(document, document.scenes[0].id, ["top", "rotated"], { id: "g" });
  // Stacking: the group sits where "top" was (above "middle"), "rotated" stays below "top".
  assert.deepEqual(layers.map((layer) => layer.id), ["below", "middle", "g", "rotated", "top"]);
  const group = layers.find((layer) => layer.id === "g");
  // A 100×20 box turned 90° about its center (150, 110) covers x 140…160, y 60…160.
  assert.deepEqual([group.x, group.y, group.width, group.height], [140, 50, 180, 110]);
  assertSameLook(sceneLayers(document), layers, ["rotated", "top"]);
});

test("one layer can be grouped on its own", () => {
  const layer = createLayer("text", { id: "t", x: 30, y: 40, width: 200, height: 60, rotation: -15, scaleX: 1.5, scaleY: 1.5 });
  layer.animations.push(animation("drift", { x: 30, y: 40 }, { x: 330, y: 240 }));
  const document = documentWith([layer]);
  const { layers } = groupLayers(document, document.scenes[0].id, ["t"], { id: "g", name: "Title" });
  assert.equal(layers[0].name, "Title");
  assert.equal(layers[1].parentId, "g");
  assertSameLook(sceneLayers(document), layers, ["t"]);
});

test("layers from different groups keep their look, including rotated and scaled groups", () => {
  const card = createLayer("group", { id: "card", x: 50, y: 60, width: 300, height: 200, rotation: 30, scaleX: 2, scaleY: 2 });
  const inside = createLayer("rectangle", { id: "inside", parentId: "card", x: 20, y: 30, width: 60, height: 40, rotation: 10 });
  inside.animations.push(
    animation("path", { x: 20, y: 30 }, { x: 140, y: 90 }, 0.1, 0.8),
    animation("spin", { rotation: 10 }, { rotation: 100 }, 0.2),
    animation("grow", { scaleX: 1, scaleY: 1 }, { scaleX: 1.6, scaleY: 0.5 }, 0.3),
  );
  const mirrored = createLayer("group", { id: "mirrored", x: 500, y: 100, width: 100, height: 100, rotation: -40, scaleX: -0.5, scaleY: 0.5 });
  const flipped = createLayer("star", { id: "flipped", parentId: "mirrored", x: 10, y: 10, width: 30, height: 30 });
  flipped.animations.push(animation("pop", { rotation: 0, scaleX: 0.2 }, { rotation: 45, scaleX: 1 }));
  const outside = createLayer("rectangle", { id: "outside", x: 700, y: 400, width: 50, height: 50 });
  const document = documentWith([card, inside, mirrored, flipped, outside]);
  const { layers } = groupLayers(document, document.scenes[0].id, ["inside", "flipped", "outside"], { id: "g" });
  const group = layers.find((layer) => layer.id === "g");
  assert.equal(group.parentId, null);
  assert.deepEqual(layers.filter((layer) => layer.parentId === "g").map((layer) => layer.id), ["inside", "flipped", "outside"]);
  assertSameLook(sceneLayers(document), layers, ["inside", "flipped", "outside"]);
  parseDocument(documentWith(layers));
});

test("a quarter-turned, unevenly stretched group keeps position and scale animations exact", () => {
  const tall = createLayer("group", { id: "tall", x: 0, y: 0, width: 200, height: 100, rotation: 90, scaleX: 2, scaleY: 0.5 });
  const child = createLayer("rectangle", { id: "child", parentId: "tall", x: 10, y: 10, width: 40, height: 20, rotation: 180 });
  child.animations.push(animation("slide", { x: 10 }, { x: 150 }), animation("squash", { scaleY: 1 }, { scaleY: 3 }, 0.4));
  const other = createLayer("rectangle", { id: "other", x: 300, y: 300, width: 10, height: 10 });
  const document = documentWith([tall, child, other]);
  const { layers } = groupLayers(document, document.scenes[0].id, ["child", "other"], { id: "g" });
  assertSameLook(sceneLayers(document), layers, ["child", "other"]);
});

test("an uneven stretch at an angle keeps x-only motion but refuses rotation animation", () => {
  const skewing = createLayer("group", { id: "skewing", x: 0, y: 0, width: 200, height: 100, rotation: 30, scaleX: 2, scaleY: 1 });
  const mover = createLayer("rectangle", { id: "mover", parentId: "skewing", x: 10, y: 10, width: 40, height: 20, rotation: 20 });
  mover.animations.push(animation("slide", { x: 10 }, { x: 150 }));
  const top = createLayer("rectangle", { id: "top", x: 300, y: 300, width: 10, height: 10 });
  const document = documentWith([skewing, mover, top]);
  const { layers } = groupLayers(document, document.scenes[0].id, ["mover", "top"], { id: "g" });
  assert.notEqual(layers.find((layer) => layer.id === "mover").skewX, 0);
  assertSameLook(sceneLayers(document), layers, ["mover", "top"]);

  mover.animations.push(animation("spin", { rotation: 0 }, { rotation: 90 }));
  assert.throws(() => groupLayers(document, document.scenes[0].id, ["mover", "top"]), /Can't group: “Rectangle” animates its rotation/);
  mover.animations.splice(1, 1, animation("drop", { y: 0 }, { y: 50 }, 0.5));
  assert.throws(() => groupLayers(document, document.scenes[0].id, ["mover", "top"]), /animates x and y in separate keyframes/);
});

test("refuses to pull a layer out of a group whose effects it would lose", () => {
  const faded = createLayer("group", { id: "faded", name: "Faded", x: 0, y: 0, width: 100, height: 100, opacity: 0.5 });
  const child = createLayer("rectangle", { id: "child", name: "Child", parentId: "faded" });
  const animated = createLayer("group", { id: "animated", name: "Animated", x: 0, y: 0, width: 100, height: 100 });
  animated.animations.push(animation("fade", { opacity: 0 }, { opacity: 1 }));
  const kid = createLayer("rectangle", { id: "kid", parentId: "animated" });
  const top = createLayer("rectangle", { id: "top" });
  const document = documentWith([faded, child, animated, kid, top]);
  const sceneId = document.scenes[0].id;
  assert.throws(() => groupLayers(document, sceneId, ["child", "top"]), /“Child” would leave “Faded”, which has opacity below 100%/);
  assert.throws(() => groupLayers(document, sceneId, ["kid", "top"]), /would leave “Animated”, which is animated/);
  // The top-most layer is inside "Animated", so "top" would move into it.
  document.scenes[0].layers = [top, faded, child, animated, kid];
  assert.throws(() => groupLayers(document, sceneId, ["top", "kid"]), /“Rectangle” would move into “Animated”, which is animated/);
  // Layers that share the animated group can still be grouped inside it.
  const sibling = createLayer("ellipse", { id: "sibling", parentId: "animated" });
  document.scenes[0].layers.push(sibling);
  const { layers } = groupLayers(document, sceneId, ["kid", "sibling"], { id: "g" });
  assert.equal(layers.find((layer) => layer.id === "g").parentId, "animated");
});

test("a mask and the layer it masks must be grouped together", () => {
  const mask = createLayer("ellipse", { id: "mask", name: "Mask", isMask: true });
  const photo = createLayer("rectangle", { id: "photo", name: "Photo" });
  const other = createLayer("rectangle", { id: "other", x: 500 });
  const document = documentWith([mask, photo, other]);
  const sceneId = document.scenes[0].id;
  assert.equal(maskTargets(sceneLayers(document)).get("mask"), "photo");
  assert.throws(() => groupLayers(document, sceneId, ["photo"]), /the mask “Mask” would stop masking “Photo”/);
  assert.throws(() => groupLayers(document, sceneId, ["mask", "other"]), /the mask “Mask” would stop masking “Photo”/);
  const { layers } = groupLayers(document, sceneId, ["mask", "photo"], { id: "g" });
  assert.equal(maskTargets(layers).get("mask"), "photo");
});

test("a selected group's own layers move with it, not on their own", () => {
  const outer = createLayer("group", { id: "outer", x: 20, y: 20, width: 100, height: 100, rotation: 12 });
  const child = createLayer("rectangle", { id: "child", parentId: "outer", x: 5, y: 5, width: 10, height: 10 });
  const document = documentWith([outer, child]);
  const { layers } = groupLayers(document, document.scenes[0].id, ["child", "outer"], { id: "g" });
  assert.equal(layers.find((layer) => layer.id === "outer").parentId, "g");
  assert.equal(layers.find((layer) => layer.id === "child").parentId, "outer");
  assert.deepEqual(layers.find((layer) => layer.id === "child"), child);
  assertSameLook(sceneLayers(document), layers, ["outer", "child"]);
});

test("layers drawn from a component instance can't be regrouped in the scene that uses it", () => {
  const document = createDocument();
  const main = document.scenes[0];
  main.isComponent = true;
  main.layers.push(createLayer("rectangle", { id: "button-bg", name: "Background" }));
  document.scenes.push({ ...structuredClone(main), id: "page", name: "Page", isComponent: false, layers: [] });
  const page = document.scenes[1];
  page.layers.push(createComponentInstance(main, { id: "button", name: "Button", x: 40, y: 40 }));
  page.layers.push(createLayer("rectangle", { id: "box", x: 400, y: 40 }));
  // Grouping the instance itself works like any layer and keeps the instance's look.
  const { layers } = groupLayers(document, "page", ["button", "box"], { id: "g" });
  assert.equal(layers.find((layer) => layer.id === "button").parentId, "g");
  const drawnId = expandComponents(document, "page").layers.find((layer) => layer.componentOwnerId === "button" && layer.id !== "button").id;
  assert.throws(() => groupLayers(document, "page", [drawnId]), /is part of the component instance “Button”. Edit the main component, or detach the instance first/);
  assert.throws(() => ungroupLayers(document, "page", ["button"]), /it is a component instance. Detach it first/);
  assert.throws(() => groupLayers(document, "page", ["nope"]), /Layer nope was not found/);
});

test("paint order lists layers from the bottom up, children right after their group", () => {
  const layers = [
    createLayer("rectangle", { id: "b", parentId: "g" }),
    createLayer("rectangle", { id: "top" }),
    createLayer("group", { id: "g" }),
    createLayer("rectangle", { id: "a", parentId: "g" }),
  ];
  // Roots in list order: top, g. g's children in list order: b, a.
  assert.deepEqual([...paintOrder(layers).keys()], ["top", "g", "b", "a"]);
});

test("ungrouping bakes a rotated, scaled group into animated children and keeps their stacking", () => {
  const below = createLayer("rectangle", { id: "below" });
  const group = createLayer("group", { id: "g", x: 100, y: 50, width: 300, height: 200, rotation: 45, scaleX: 1.5, scaleY: 1.5 });
  const first = createLayer("rectangle", { id: "first", parentId: "g", x: 10, y: 20, width: 50, height: 40, rotation: 5 });
  first.animations.push(animation("move", { x: 10, y: 20 }, { x: 200, y: 120 }), animation("turn", { rotation: 5 }, { rotation: 300 }, 0.3));
  const above = createLayer("rectangle", { id: "above" });
  const second = createLayer("ellipse", { id: "second", parentId: "g", x: 100, y: 100, width: 30, height: 30, scaleX: -1 });
  second.animations.push(animation("grow", { scaleX: -1, scaleY: 1 }, { scaleX: -2, scaleY: 2 }));
  const document = documentWith([below, group, first, above, second]);
  const { layers, childIds } = ungroupLayers(document, document.scenes[0].id, ["g"]);
  assert.deepEqual(childIds, ["first", "second"]);
  // The children take the group's place: above "below", below "above".
  assert.deepEqual(layers.map((layer) => layer.id), ["below", "first", "second", "above"]);
  assert.ok(layers.every((layer) => layer.parentId === null));
  assertSameLook(sceneLayers(document), layers, ["first", "second"]);
  parseDocument(documentWith(layers));
});

test("grouping then ungrouping returns layers to the same look", () => {
  const card = createLayer("group", { id: "card", x: 50, y: 60, width: 300, height: 200, rotation: -20, scaleX: 0.75, scaleY: 0.75 });
  const inside = createLayer("rectangle", { id: "inside", parentId: "card", x: 20, y: 30, width: 60, height: 40 });
  inside.animations.push(animation("path", { x: 20, y: 30 }, { x: 140, y: 90 }));
  const outside = createLayer("rectangle", { id: "outside", x: 700, y: 400, width: 50, height: 50, rotation: 33 });
  const document = documentWith([card, inside, outside]);
  const grouped = groupLayers(document, document.scenes[0].id, ["inside", "outside"], { id: "g" });
  const regrouped = documentWith(grouped.layers);
  const { layers } = ungroupLayers(regrouped, regrouped.scenes[0].id, ["g"]);
  assertSameLook(sceneLayers(document), layers, ["inside", "outside"]);
});

test("ungrouping refuses animated or styled groups and groups a mask uses", () => {
  const document = documentWith([
    createLayer("group", { id: "faded", name: "Faded", opacity: 0.4 }),
    createLayer("rectangle", { id: "a", parentId: "faded" }),
    createLayer("ellipse", { id: "mask", name: "Mask", isMask: true }),
    createLayer("group", { id: "masked", name: "Masked" }),
    createLayer("rectangle", { id: "b", parentId: "masked" }),
  ]);
  const sceneId = document.scenes[0].id;
  assert.throws(() => ungroupLayers(document, sceneId, ["faded"]), /Can't ungroup “Faded”: remove the group's animations and appearance effects/);
  assert.throws(() => ungroupLayers(document, sceneId, ["masked"]), /the mask “Mask” masks the whole group/);
  assert.throws(() => ungroupLayers(document, sceneId, ["a"]), /Can.t ungroup “Rectangle”: it is not a group/);
});

test("visible group Fill and Stroke are preserved by refusing ungroup and extraction across the group", () => {
  const styles = [
    [{ fillEnabled: true, fill: "#00ff00" }, "has a fill"],
    [{ fillEnabled: false, stroke: "#ff0000", strokeWidth: 4 }, "has a stroke"],
  ];
  for (const [style, effect] of styles) {
    const frame = createLayer("group", { id: "frame", name: "Frame", ...style });
    const inside = createLayer("rectangle", { id: "inside", parentId: "frame" });
    const outside = createLayer("rectangle", { id: "outside", x: 300 });
    const document = documentWith([frame, inside, outside]);
    const sceneId = document.scenes[0].id;
    assert.throws(() => ungroupLayers(document, sceneId, ["frame"]), /remove the group's animations and appearance effects .*fill or stroke/);
    assert.throws(() => groupLayers(document, sceneId, ["inside", "outside"]), new RegExp(`would leave “Frame”, which ${effect}`));
    assert.throws(() => createComponentFromLayers(document, sceneId, ["inside", "outside"]), new RegExp(`would leave “Frame”, which ${effect}`));
  }
});

test("inactive legacy group box styles do not block ungrouping or extraction", () => {
  const frame = createLayer("group", {
    id: "frame", name: "Frame", fillEnabled: true, fill: "#00ff00", stroke: "#ff0000", strokeWidth: 4,
    radius: 20, inactiveBoxStyles: ["fill", "stroke", "corners"],
  });
  const inside = createLayer("rectangle", { id: "inside", parentId: "frame" });
  const outside = createLayer("rectangle", { id: "outside", x: 300 });
  const document = documentWith([frame, inside, outside]);
  const sceneId = document.scenes[0].id;
  assert.deepEqual(ungroupLayers(document, sceneId, ["frame"]).layers.map((layer) => layer.id), ["inside", "outside"]);
  assert.equal(groupLayers(document, sceneId, ["inside", "outside"], { id: "joined" }).groupId, "joined");
  assert.equal(createComponentFromLayers(document, sceneId, ["inside", "outside"]).document.scenes.some((scene) => scene.isComponent), true);
});

test("ungrouping a hidden group with play ranges keeps its layers hidden and timed the same", () => {
  const group = createLayer("group", { id: "g", x: 0, y: 0, playbackWindows: [{ start: 1, end: 2, visibility: "during", hold: true }] });
  const child = createLayer("rectangle", { id: "c", parentId: "g", playbackWindows: [{ start: 0, end: 3, visibility: "both", hold: false }] });
  child.animations.push(animation("move", { x: 0 }, { x: 100 }, 1, 1));
  const document = documentWith([group, child]);
  const { layers } = ungroupLayers(document, document.scenes[0].id, ["g"]);
  assert.deepEqual(layers[0].playbackWindows, [
    { start: 1, end: 2, visibility: "during", hold: true },
    { start: 0, end: 3, visibility: "both", hold: false },
  ]);
  for (const time of [0.5, 1, 1.5, 2.5]) {
    const before = evaluateLayer({ ...child, playbackWindows: [...group.playbackWindows, ...child.playbackWindows] }, time);
    const after = evaluateLayer(layers[0], time);
    assert.equal(after.visible, before.visible, `visible at ${time}s`);
    assert.equal(after.x, before.x, `x at ${time}s`);
  }
  group.visible = false;
  assert.equal(ungroupLayers(document, document.scenes[0].id, ["g"]).layers[0].visible, false);
});

test("ungrouping a clipping group only when nothing it clips would show", () => {
  const group = createLayer("group", { id: "g", name: "Frame", x: 0, y: 0, width: 100, height: 100, clipContent: true });
  const child = createLayer("rectangle", { id: "c", parentId: "g", x: 10, y: 10, width: 50, height: 50 });
  const document = documentWith([group, child]);
  const sceneId = document.scenes[0].id;
  assert.equal(ungroupLayers(document, sceneId, ["g"]).layers[0].x, 10);
  child.x = 80;
  assert.throws(() => ungroupLayers(document, sceneId, ["g"]), /it clips layers that reach past its edges or move/);
  child.x = 10;
  child.animations.push(animation("move", { x: 10 }, { x: 40 }));
  assert.throws(() => ungroupLayers(document, sceneId, ["g"]), /it clips layers that reach past its edges or move/);
});

test("ungrouping refuses content clipped by a rounded group corner", () => {
  const rounded = createLayer("group", { id: "rounded", width: 100, height: 100, radius: 40, clipContent: true });
  const corner = createLayer("rectangle", { id: "corner", parentId: "rounded", x: 0, y: 0, width: 10, height: 10 });
  const clippedDocument = documentWith([rounded, corner]);
  assert.throws(() => ungroupLayers(clippedDocument, clippedDocument.scenes[0].id, ["rounded"]), /it clips layers that reach past its edges or move/);

  const safeGroup = { ...rounded, id: "safe" };
  const inside = createLayer("rectangle", { id: "inside", parentId: "safe", x: 40, y: 40, width: 10, height: 10 });
  const safeDocument = documentWith([safeGroup, inside]);
  assert.deepEqual(ungroupLayers(safeDocument, safeDocument.scenes[0].id, ["safe"]).layers.map((layer) => layer.id), ["inside"]);

  const legacy = createLayer("group", {
    id: "legacy", width: 100, height: 100, radius: 40, clipContent: true, inactiveBoxStyles: ["corners"],
  });
  const legacyCorner = createLayer("rectangle", { id: "legacyCorner", parentId: "legacy", x: 0, y: 0, width: 10, height: 10 });
  const legacyDocument = documentWith([legacy, legacyCorner]);
  assert.deepEqual(ungroupLayers(legacyDocument, legacyDocument.scenes[0].id, ["legacy"]).layers.map((layer) => layer.id), ["legacyCorner"]);
});

test("ungrouping keeps nested group paint clipped and ignores inactive media stroke margins", () => {
  const outer = createLayer("group", { id: "outer", x: 0, y: 0, width: 100, height: 100, clipContent: true });
  const nested = createLayer("group", { id: "nested", parentId: "outer", x: -10, y: 20, width: 40, height: 40, fillEnabled: true });
  const painted = documentWith([outer, nested]);
  assert.throws(() => ungroupLayers(painted, painted.scenes[0].id, ["outer"]), /it clips layers/);
  const dormant = createLayer("image", { id: "photo", parentId: "outer", x: 0, y: 0, width: 100, height: 100, strokeWidth: 20, inactiveBoxStyles: ["stroke"] });
  const old = documentWith([outer, dormant]);
  assert.deepEqual(ungroupLayers(old, old.scenes[0].id, ["outer"]).layers.map((layer) => layer.id), ["photo"]);
});

test("ungrouping a group and a group inside it at once", () => {
  const outer = createLayer("group", { id: "outer", x: 100, y: 100, width: 200, height: 200, rotation: 30 });
  const inner = createLayer("group", { id: "inner", parentId: "outer", x: 20, y: 20, width: 100, height: 100, rotation: 15, scaleX: 2, scaleY: 2 });
  const leaf = createLayer("rectangle", { id: "leaf", parentId: "inner", x: 5, y: 5, width: 20, height: 20 });
  leaf.animations.push(animation("move", { x: 5, y: 5 }, { x: 60, y: 30 }));
  const document = documentWith([outer, inner, leaf]);
  const { layers, childIds } = ungroupLayers(document, document.scenes[0].id, ["inner", "outer"]);
  assert.deepEqual(layers.map((layer) => layer.id), ["leaf"]);
  assert.deepEqual(childIds, ["leaf"]);
  assertSameLook(sceneLayers(document), layers, ["leaf"]);
});

test("reparentLayer keeps translation-only moves exact even when the size animates", () => {
  const layer = createLayer("rectangle", { id: "r", x: 10, y: 20, width: 40, height: 30 });
  layer.animations.push(animation("size", { width: 40, x: 10 }, { width: 400, x: 90 }));
  const moved = reparentLayer(layer, [1, 0, 0, 1, -5, 7]);
  assert.deepEqual([moved.x, moved.y], [5, 27]);
  assert.deepEqual(moved.animations[0].from, { width: 40, x: 5 });
  assert.deepEqual(moved.animations[0].to, { width: 400, x: 85 });
  assert.throws(() => reparentLayer(layer, [2, 0, 0, 2, 0, 0]), /animates its size/);
});

test("apply_operations group_layers and ungroup_layer use the same grouping as the editor", () => {
  const document = createDocument();
  const scene = document.scenes[0];
  const card = createLayer("group", { id: "card", x: 50, y: 60, width: 300, height: 200, rotation: 30 });
  const inside = createLayer("rectangle", { id: "inside", parentId: "card", x: 20, y: 30, width: 60, height: 40 });
  inside.animations.push(animation("path", { x: 20, y: 30 }, { x: 140, y: 90 }));
  const outside = createLayer("rectangle", { id: "outside", x: 700, y: 400, width: 50, height: 50 });
  scene.layers.push(card, inside, outside);
  const op = (properties) => ({ type: "group_layers", sceneId: scene.id, layerIds: ["inside", "outside"], ...properties });

  const grouped = applyOperations(document, [op({ name: "Pair", groupId: "pair" })]);
  const group = grouped.scenes[0].layers.find((layer) => layer.id === "pair");
  assert.equal(group.name, "Pair");
  assert.equal(group.type, "group");
  assertSameLook(scene.layers, grouped.scenes[0].layers, ["inside", "outside"]);
  assert.equal(document.scenes[0].layers.length, 3, "the source document is not changed");

  const ungrouped = applyOperations(grouped, [{ type: "ungroup_layer", sceneId: scene.id, layerId: "pair" }]);
  assert.equal(ungrouped.scenes[0].layers.some((layer) => layer.id === "pair"), false);
  assertSameLook(scene.layers, ungrouped.scenes[0].layers, ["inside", "outside"]);

  // Without a groupId the group gets a fresh ID and the default name.
  const named = applyOperations(document, [op({})]);
  assert.equal(named.scenes[0].layers.find((layer) => layer.type === "group" && layer.id !== "card").name, "Group");

  assert.throws(() => applyOperations(document, [op({ layerIds: [] })]), /group_layers needs layerIds/);
  assert.throws(() => applyOperations(document, [op({ layerIds: "inside" })]), /group_layers needs layerIds/);
  assert.throws(() => applyOperations(document, [op({ name: "" })]), /name must be text of 1 to 256 characters/);
  assert.throws(() => applyOperations(document, [op({ groupId: "has space" })]), /groupId must be 1 to 128/);
  assert.throws(() => applyOperations(document, [op({ groupId: "card" })]), /layer ID card is already used/);
  assert.throws(() => applyOperations(document, [op({ layerIds: ["missing"] })]), /Layer missing was not found/);
  assert.throws(() => applyOperations(document, [{ type: "ungroup_layer", sceneId: scene.id, layerId: "inside" }]), /it is not a group/);
  assert.throws(() => applyOperations(document, [{ type: "ungroup_layer", sceneId: scene.id }]), /ungroup_layer needs layerId/);
});

// Where auto-sized text is drawn at a time: render.js measures it again on every draw
// (resizeTextLayer), so its box comes from its words, not from its saved width and height.
function drawnTextBox(layers, id, time) {
  const evaluate = (item) => evaluateLayer(item, time);
  const layer = layers.find((item) => item.id === id);
  const drawn = resizeTextLayer(evaluate(layer));
  return multiply(multiply(parentMatrix(layer, layers, evaluate), layerMatrix(drawn)), [drawn.width, 0, 0, drawn.height, 0, 0]);
}

function assertSameText(before, after, id) {
  for (const time of TIMES) {
    const was = drawnTextBox(before, id, time),
      now = drawnTextBox(after, id, time);
    for (let index = 0; index < 6; index += 1) {
      assert.ok(
        Math.abs(was[index] - now[index]) < 1e-5,
        `${id} at ${time}s: [${was.map((v) => v.toFixed(4))}] became [${now.map((v) => v.toFixed(4))}]`,
      );
    }
  }
}

// A rotated card with short auto-sized text in it. A new text layer is saved as 320 × 180, so
// the saved box is much larger than the drawn one. Measuring keeps the text's alignment
// anchor in place, so left- or right-aligned text is drawn away from its saved box's center.
const TEXT_ALIGNMENTS = [
  { textAlign: "left", verticalAlign: "top" },
  { textAlign: "right", verticalAlign: "bottom" },
  { textAlign: "center", verticalAlign: "middle" },
];

function cardWithText(textResize = "width-height", alignment = TEXT_ALIGNMENTS[0]) {
  const card = createLayer("group", { id: "card", x: 100, y: 100, width: 300, height: 200, rotation: 45 });
  const text = createLayer("text", { id: "t", parentId: "card", text: "Hi", textResize, ...alignment, x: 20, y: 10, width: 320, height: 180 });
  text.animations.push(animation("drift", { x: 20, y: 10 }, { x: 60, y: -30 }, 0.2, 0.8));
  const other = createLayer("rectangle", { id: "o", x: 600, y: 80, width: 40, height: 40 });
  return [card, text, other];
}

test("auto-sized text keeps the place it is drawn in when it is grouped out of a rotated group", () => {
  for (const textResize of ["width-height", "height"]) {
    for (const alignment of TEXT_ALIGNMENTS) {
      const before = cardWithText(textResize, alignment);
      const drawn = resizeTextLayer(before[1]);
      assert.ok(drawn.width < 320 || drawn.height < 180, "the saved box is out of date");
      const document = documentWith(before);
      const { layers } = groupLayers(document, document.scenes[0].id, ["t", "o"], { id: "g" });
      assert.equal(layers.find((layer) => layer.id === "t").parentId, "g");
      assertSameText(before, layers, "t");
      assertSameLook(before, layers, ["o"]);
      parseDocument(documentWith(layers));
    }
  }
});

test("auto-sized text keeps the place it is drawn in when its rotated group is ungrouped", () => {
  for (const alignment of TEXT_ALIGNMENTS) {
    const before = cardWithText("width-height", alignment);
    const document = documentWith(before);
    const { layers } = ungroupLayers(document, document.scenes[0].id, ["card"]);
    const text = layers.find((layer) => layer.id === "t");
    assert.equal(text.parentId, null);
    assert.equal(text.textResize, "width-height", "the text still sizes itself");
    assertSameText(before, layers, "t");
    // Grouping it again and ungrouping it again changes nothing.
    const ungrouped = documentWith(layers);
    const regrouped = documentWith(groupLayers(ungrouped, ungrouped.scenes[0].id, ["t", "o"], { id: "g" }).layers);
    const back = ungroupLayers(regrouped, regrouped.scenes[0].id, ["g"]);
    assertSameText(before, back.layers, "t");
  }
});

test("a group made around auto-sized text fits the text as it is drawn", () => {
  const text = createLayer("text", { id: "t", text: "Hi", textResize: "width-height", textAlign: "right", verticalAlign: "middle", x: 40, y: 50, width: 320, height: 180 });
  const drawn = resizeTextLayer(text);
  const document = documentWith([text]);
  const { layers } = groupLayers(document, document.scenes[0].id, ["t"], { id: "g" });
  const group = layers.find((layer) => layer.id === "g");
  const round = (values) => values.map((value) => Math.round(value * 1e6) / 1e6);
  assert.deepEqual(round([group.x, group.y, group.width, group.height]), round([drawn.x, drawn.y, drawn.width, drawn.height]));
  assertSameText([text], layers, "t");
});

test("auto-sized text that animates its size can only be grouped where it just moves", () => {
  const before = cardWithText();
  before[1].animations.push(animation("wide", { width: 320 }, { width: 200 }));
  const document = documentWith(before);
  assert.throws(() => groupLayers(document, document.scenes[0].id, ["t", "o"]), /animates its size/);
  // Grouping without turning it keeps it exact at every time.
  const flat = before.map((layer) => (layer.id === "card" ? { ...layer, rotation: 0 } : layer));
  const flatDocument = documentWith(flat);
  const { layers } = groupLayers(flatDocument, flatDocument.scenes[0].id, ["t", "o"], { id: "g" });
  assertSameText(flat, layers, "t");
});
