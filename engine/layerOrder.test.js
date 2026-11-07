import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { worldMatrix } from "./geometry.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { applyOperations } from "./operations.js";
import { moveLayers, reorderLayers, setLayerFlags } from "./layerOrder.js";

function documentWith(layers) {
  const document = createDocument();
  document.scenes[0].layers = layers;
  return document;
}
const ids = (layers) => layers.map((layer) => layer.id);
const parents = (layers) => Object.fromEntries(layers.map((layer) => [layer.id, layer.parentId]));

// World matrix of each layer at a few times, with animations applied: what the canvas shows.
function assertSameLook(before, after, layerIds) {
  for (const time of [0, 0.3, 0.8]) {
    for (const id of layerIds) {
      const was = worldMatrix(before.find((layer) => layer.id === id), before, (item) => evaluateLayer(item, time));
      const now = worldMatrix(after.find((layer) => layer.id === id), after, (item) => evaluateLayer(item, time));
      was.forEach((value, index) => assert.ok(Math.abs(value - now[index]) < 1e-6, `${id} at ${time}s moved: ${was} became ${now}`));
    }
  }
}

// Drawing order (bottom first): a, b, c at the top level, and a turned, scaled group g with x, y inside.
function sample() {
  return documentWith([
    createLayer("rectangle", { id: "a", name: "A", x: 10, y: 10, width: 40, height: 30 }),
    createLayer("rectangle", { id: "b", name: "B", x: 80, y: 20, width: 40, height: 30 }),
    createLayer("group", { id: "g", name: "G", x: 200, y: 100, width: 200, height: 160, rotation: 30, scaleX: 1.5, scaleY: 0.8 }),
    createLayer("ellipse", { id: "x", name: "X", parentId: "g", x: 10, y: 20, width: 30, height: 30 }),
    createLayer("ellipse", { id: "y", name: "Y", parentId: "g", x: 60, y: 40, width: 20, height: 20 }),
    createLayer("rectangle", { id: "c", name: "C", x: 300, y: 300, width: 40, height: 30 }),
  ]);
}
const sceneId = (document) => document.scenes[0].id;

test("moving a layer above or below another in the same group only changes the order", () => {
  const document = sample();
  const before = document.scenes[0].layers;
  const above = moveLayers(document, sceneId(document), ["a"], { side: "above", referenceId: "c" });
  assert.deepEqual(ids(above.layers), ["b", "g", "x", "y", "c", "a"]);
  assert.deepEqual(above.movedIds, ["a"]);
  assert.equal(above.layers.find((layer) => layer.id === "a"), before[0], "a layer that stays in its group is not changed");
  const below = moveLayers(document, sceneId(document), ["c"], { side: "below", referenceId: "a" });
  assert.deepEqual(ids(below.layers), ["c", "a", "b", "g", "x", "y"]);
  assert.equal(moveLayers(document, sceneId(document), ["b"], { side: "above", referenceId: "a" }), null, "already there");
});

test("moving into a turned and scaled group keeps the layer's look, animations included", () => {
  const document = sample();
  const layers = document.scenes[0].layers;
  const a = layers[0];
  a.rotation = 12;
  a.animations.push({ ...presetAnimation("move", a, 0), id: "move" });
  const moved = moveLayers(document, sceneId(document), ["a"], { side: "top", parentId: "g" });
  assert.deepEqual(ids(moved.layers), ["b", "g", "x", "y", "a", "c"], "the top of the group: after its last layer");
  assert.equal(moved.layers.find((layer) => layer.id === "a").parentId, "g");
  assertSameLook(layers, moved.layers, ["a"]);
  // And back out, below the group.
  const next = documentWith(moved.layers);
  const out = moveLayers(next, sceneId(next), ["a"], { side: "below", referenceId: "g" });
  assert.deepEqual(ids(out.layers), ["b", "a", "g", "x", "y", "c"]);
  assert.equal(out.layers.find((layer) => layer.id === "a").parentId, null);
  assertSameLook(layers, out.layers, ["a"]);
  parseDocument({ ...next, scenes: [{ ...next.scenes[0], layers: out.layers }] });
});

test("several layers move together and keep their order; a group's own layers come with it", () => {
  const document = sample();
  const moved = moveLayers(document, sceneId(document), ["c", "x", "a"], { side: "above", referenceId: "y" });
  assert.deepEqual(ids(moved.layers), ["b", "g", "y", "a", "x", "c"]);
  assert.deepEqual(moved.movedIds, ["a", "x", "c"], "bottom to top, as they were drawn");
  assert.deepEqual(parents(moved.layers), { b: null, g: null, y: "g", a: "g", x: "g", c: "g" });
  assertSameLook(document.scenes[0].layers, moved.layers, ["a", "x", "c"]);
  // A group and a layer inside it: only the group moves, its layers keep pointing at it.
  const group = moveLayers(document, sceneId(document), ["g", "x"], { side: "bottom", parentId: null });
  assert.deepEqual(ids(group.layers), ["g", "a", "b", "x", "y", "c"]);
  assert.deepEqual(group.movedIds, ["g"]);
  assert.equal(group.layers.find((layer) => layer.id === "x").parentId, "g");
});

test("a drop next to one of the moved layers puts them all where that layer was", () => {
  const document = sample();
  const moved = moveLayers(document, sceneId(document), ["a", "c"], { side: "above", referenceId: "a" });
  assert.deepEqual(ids(moved.layers), ["a", "c", "b", "g", "x", "y"]);
});

test("the top and bottom of the scene's top level and of an empty group", () => {
  const document = sample();
  document.scenes[0].layers.push(createLayer("group", { id: "empty", name: "Empty", x: 0, y: 0, width: 10, height: 10 }));
  const top = moveLayers(document, sceneId(document), ["x"], { side: "top", parentId: null });
  assert.equal(ids(top.layers).at(-1), "x");
  const empty = moveLayers(document, sceneId(document), ["a"], { side: "bottom", parentId: "empty" });
  assert.deepEqual(ids(empty.layers).slice(-2), ["empty", "a"]);
  assert.equal(empty.layers.find((layer) => layer.id === "a").parentId, "empty");
});

test("moves that can't work are refused with a reason", () => {
  const document = sample();
  const scene = sceneId(document);
  document.scenes[0].layers.push(createLayer("group", { id: "inner", name: "Inner", parentId: "g", width: 10, height: 10 }));
  assert.throws(() => moveLayers(document, scene, ["g"], { side: "top", parentId: "g" }), /“G” can't go into itself/);
  assert.throws(() => moveLayers(document, scene, ["g"], { side: "top", parentId: "inner" }), /“G” can't go into “Inner”, which is inside it/);
  assert.throws(() => moveLayers(document, scene, ["g"], { side: "above", referenceId: "x" }), /can't go into itself/);
  assert.throws(() => moveLayers(document, scene, ["a"], { side: "top", parentId: "b" }), /“B” is not a group/);
  assert.throws(() => moveLayers(document, scene, ["nope"], { side: "top", parentId: null }), /Layer nope was not found/);
  assert.throws(() => moveLayers(document, scene, ["a"], { side: "sideways" }), /above, below, top or bottom/);
  assert.throws(() => moveLayers(document, scene, [], { side: "top" }), /choose at least one layer/);
});

test("layers can't be moved into a component instance or out of one", () => {
  const document = createDocument();
  const main = createScene({ id: "main", name: "Button", isComponent: true, layers: [createLayer("rectangle", { id: "shape", name: "Shape" })] });
  const instance = createComponentInstance(main, { id: "instance", name: "Instance" });
  document.scenes = [createScene({ id: "page", layers: [instance, createLayer("rectangle", { id: "loose", name: "Loose" })] }), main];
  assert.throws(() => moveLayers(document, "page", ["loose"], { side: "top", parentId: "instance" }), /“Instance” is a component instance/);
  const inherited = expandComponents(document, "page").layers.find((layer) => layer.componentOwnerId && layer.id !== "instance");
  assert.ok(inherited, "the instance draws a layer from its main component");
  assert.throws(() => moveLayers(document, "page", [inherited.id], { side: "top", parentId: null }), /is part of the component instance “Instance”/);
});

test("a move that would change what a mask masks is refused", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "mask", name: "Mask", isMask: true }),
    createLayer("rectangle", { id: "target", name: "Target" }),
    createLayer("rectangle", { id: "other", name: "Other" }),
  ]);
  assert.throws(() => moveLayers(document, sceneId(document), ["target"], { side: "above", referenceId: "other" }), /would stop masking “Target”/);
  const together = moveLayers(document, sceneId(document), ["mask", "target"], { side: "above", referenceId: "other" });
  assert.deepEqual(ids(together.layers), ["other", "mask", "target"]);
  // mask: true lets a mask with nothing to mask start masking the moved layer, and only that.
  const waiting = documentWith([
    createLayer("group", { id: "g", name: "G", width: 100, height: 100 }),
    createLayer("rectangle", { id: "w", name: "Window", parentId: "g", isMask: true }),
    createLayer("rectangle", { id: "clip", name: "Clip" }),
  ]);
  assert.throws(() => moveLayers(waiting, sceneId(waiting), ["clip"], { side: "top", parentId: "g" }), /the mask “Window” would start masking “Clip”\. To mask it on purpose, send the same move with mask: true/);
  assert.deepEqual(ids(moveLayers(waiting, sceneId(waiting), ["clip"], { side: "top", parentId: "g" }, { mask: true }).layers), ["g", "w", "clip"]);
  assert.throws(() => moveLayers(document, sceneId(document), ["target"], { side: "above", referenceId: "other" }, { mask: true }), /would stop masking “Target”/);
});

test("a mask group keeps its mask: the mask can't be dragged out of it", () => {
  const document = documentWith([
    createLayer("group", { id: "mg", name: "Mask group", isMaskGroup: true, width: 100, height: 100 }),
    createLayer("rectangle", { id: "m", name: "M", parentId: "mg", isMask: true }),
    createLayer("rectangle", { id: "p", name: "Photo", parentId: "mg" }),
    createLayer("rectangle", { id: "q", name: "Q" }),
  ]);
  assert.throws(() => moveLayers(document, sceneId(document), ["m"], { side: "above", referenceId: "q" }), /would lose its mask “M”/);
  // A mask moved to the top, with nothing above it to mask, is refused with a clear reason.
  const standalone = documentWith([createLayer("rectangle", { id: "s", name: "S", isMask: true }), createLayer("rectangle", { id: "t", name: "T" }), createLayer("rectangle", { id: "u", name: "U", visible: false })]);
  assert.throws(() => moveLayers(standalone, sceneId(standalone), ["s"], { side: "above", referenceId: "u" }), /the mask “S” would stop masking “T”/);
  // A layer dropped at the top of a mask group is covered by its mask (it was asked to go there).
  const into = moveLayers(document, sceneId(document), ["q"], { side: "top", parentId: "mg" });
  assert.deepEqual(parents(into.layers), { mg: null, m: "mg", p: "mg", q: "mg" });
});

// A mask group: its mask "m" at the bottom covers the photos above it (render.js).
function maskGroup() {
  return documentWith([
    createLayer("group", { id: "mg", name: "Mask group", isMaskGroup: true, width: 100, height: 100 }),
    createLayer("rectangle", { id: "m", name: "M", parentId: "mg", isMask: true }),
    createLayer("rectangle", { id: "p", name: "Photo", parentId: "mg" }),
    createLayer("rectangle", { id: "p2", name: "Photo 2", parentId: "mg" }),
    createLayer("rectangle", { id: "q", name: "Q" }),
  ]);
}

test("a mask group's mask stays below the layers it masks", () => {
  const document = maskGroup();
  const layers = document.scenes[0].layers;
  const scene = sceneId(document);
  // The mask itself can't go up past the layers it masks: they would stop being masked.
  for (const to of ["front", "forward", 2]) {
    assert.throws(() => reorderLayers(layers, ["m"], to), /“M” is the mask of the mask group “Mask group”/, `mask to ${to}`);
  }
  assert.throws(() => moveLayers(document, scene, ["m"], { side: "above", referenceId: "p2" }), /“M” is the mask of the mask group/);
  // A masked layer can't go below the mask.
  assert.throws(() => reorderLayers(layers, ["p"], 0), /“Photo” would go below “M”, the mask of “Mask group”/);
  assert.throws(() => moveLayers(document, scene, ["p2"], { side: "below", referenceId: "m" }), /“Photo 2” would go below “M”/);
  // [ and ⇧⌘[ stop just above the mask: the layer is still masked.
  assert.equal(reorderLayers(layers, ["p"], "back"), null, "already the bottom masked layer");
  assert.equal(reorderLayers(layers, ["p"], "backward"), null);
  assert.deepEqual(ids(reorderLayers(layers, ["p2"], "backward")), ["mg", "m", "p2", "p", "q"]);
  assert.throws(() => applyOperations(document, [{ type: "reorder_layer", sceneId: scene, layerId: "m", to: "front" }]), /is the mask of the mask group/);
  // A layer joining the mask group goes above its mask, where the mask covers it.
  assert.throws(() => moveLayers(document, scene, ["q"], { side: "below", referenceId: "m" }), /“Q” would go below “M”, the mask of “Mask group”/);
  assert.throws(() => moveLayers(document, scene, ["q"], { side: "bottom", parentId: "mg" }), /“Q” would go below “M”/);
  // Moves above the mask still work, and so does leaving the mask group.
  assert.deepEqual(ids(reorderLayers(layers, ["p"], "front")), ["mg", "m", "p2", "p", "q"]);
  assert.deepEqual(ids(reorderLayers(layers, ["p2"], "back")), ["mg", "m", "p2", "p", "q"]);
  assert.equal(moveLayers(document, scene, ["p"], { side: "above", referenceId: "q" }).layers.find((layer) => layer.id === "p").parentId, null);
  assert.equal(moveLayers(document, scene, ["q"], { side: "above", referenceId: "m" }).layers.find((layer) => layer.id === "q").parentId, "mg");
});

test("layers below a mask group's mask stay below it, also inside nested groups", () => {
  const document = documentWith([
    createLayer("group", { id: "mg", name: "Mask group", isMaskGroup: true, width: 100, height: 100 }),
    createLayer("rectangle", { id: "under", name: "Under", parentId: "mg" }),
    createLayer("rectangle", { id: "m", name: "M", parentId: "mg", isMask: true }),
    createLayer("group", { id: "inner", name: "Inner", parentId: "mg", width: 50, height: 50 }),
    createLayer("rectangle", { id: "deep", name: "Deep", parentId: "inner" }),
  ]);
  const layers = document.scenes[0].layers;
  // ] keeps a layer below the mask under it; a place number past the mask is refused.
  assert.equal(reorderLayers(layers, ["under"], "front"), null);
  assert.throws(() => reorderLayers(layers, ["under"], 2), /“Under” would go above “M”, the mask of “Mask group”, and start being masked/);
  // Unless the move asks to mask it (move_layers {mask:true}): a new mask that takes over a group.
  assert.equal(moveLayers(document, sceneId(document), ["under"], { side: "above", referenceId: "m" }, { mask: true }).layers.find((layer) => layer.id === "under").parentId, "mg");
  assert.throws(
    () => moveLayers(document, sceneId(document), ["inner"], { side: "below", referenceId: "under" }),
    /“Inner” would go below “M”/,
    "the group is named, not the layer inside it",
  );
  assert.throws(() => moveLayers(document, sceneId(document), ["deep"], { side: "below", referenceId: "m" }), /“Deep” would go below “M”/);
  // Moving a masked layer out of a nested group but still above the mask keeps it masked.
  const out = moveLayers(document, sceneId(document), ["deep"], { side: "above", referenceId: "inner" });
  assert.equal(out.layers.find((layer) => layer.id === "deep").parentId, "mg");
});

// Group G turns from 0° to 90° in the first second; C is inside it, O is outside.
function animatedGroup() {
  const group = createLayer("group", { id: "g", name: "G", x: 300, y: 200, width: 300, height: 300 });
  group.animations.push({ id: "spin", kind: "custom", start: 0, duration: 1, easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } });
  return documentWith([
    createLayer("rectangle", { id: "o", name: "O", x: 0, y: 0, width: 40, height: 40 }),
    group,
    createLayer("rectangle", { id: "c", name: "C", parentId: "g", x: 200, y: 20, width: 40, height: 40 }),
  ]);
}

test("layers can't move into or out of a group whose place, size or turn is animated", () => {
  const document = animatedGroup();
  const scene = sceneId(document);
  assert.throws(
    () => moveLayers(document, scene, ["c"], { side: "above", referenceId: "o" }),
    /Can't move layers: “C” would leave “G”, which is animated/,
  );
  assert.throws(() => moveLayers(document, scene, ["o"], { side: "top", parentId: "g" }), /“O” would move into “G”, which is animated/);
  assert.throws(
    () => applyOperations(document, [{ type: "move_layers", sceneId: scene, layerIds: ["c"], position: "top", parentId: null }]),
    /would leave “G”, which is animated/,
  );
  // Moving within the animated group, or moving the animated group itself, is fine.
  document.scenes[0].layers.push(createLayer("rectangle", { id: "d", name: "D", parentId: "g", x: 10, y: 10, width: 20, height: 20 }));
  assert.deepEqual(ids(moveLayers(document, scene, ["c"], { side: "above", referenceId: "d" }).layers), ["o", "g", "d", "c"]);
  assert.deepEqual(ids(moveLayers(document, scene, ["g"], { side: "below", referenceId: "o" }).layers), ["g", "o", "c", "d"]);
  // The animated group carries its layers along, so they keep their look at every time.
  assertSameLook(document.scenes[0].layers, moveLayers(document, scene, ["g"], { side: "below", referenceId: "o" }).layers, ["c"]);
  // A group that only fades moves its layers nowhere, so they can still join it and take on the fade.
  const fading = animatedGroup();
  fading.scenes[0].layers[1].animations = [{ id: "fade", kind: "custom", start: 0, duration: 1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } }];
  const joined = moveLayers(fading, sceneId(fading), ["o"], { side: "top", parentId: "g" });
  assertSameLook(fading.scenes[0].layers, joined.layers, ["o"]);
});

test("front, back, forward and backward move the chosen layers within their own group", () => {
  const layers = ["a", "b", "c", "d", "e"].map((id) => createLayer("rectangle", { id, name: id.toUpperCase() }));
  assert.deepEqual(ids(reorderLayers(layers, ["b", "d"], "front")), ["a", "c", "e", "b", "d"]);
  assert.deepEqual(ids(reorderLayers(layers, ["b", "d"], "back")), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(ids(reorderLayers(layers, ["b", "c"], "forward")), ["a", "d", "b", "c", "e"]);
  assert.deepEqual(ids(reorderLayers(layers, ["b", "c"], "backward")), ["b", "c", "a", "d", "e"]);
  assert.equal(reorderLayers(layers, ["d", "e"], "forward"), null, "a block already at the top stays");
  assert.equal(reorderLayers(layers, ["e"], "front"), null, "already at the front");
  assert.equal(reorderLayers(layers, ["a"], "backward"), null, "already at the back");
  assert.deepEqual(ids(reorderLayers(layers, ["a"], 3)), ["b", "c", "d", "a", "e"], "place 3 counted from 0 at the bottom");
  assert.throws(() => reorderLayers(layers, ["a"], 5), /from 0 \(bottom\) to 4 \(top\)/);
  assert.throws(() => reorderLayers(layers, ["a", "b"], 1), /one layer at a time/);
  assert.throws(() => reorderLayers(layers, ["a"], "up"), /front, back, forward, backward/);
  assert.throws(() => reorderLayers(layers, ["zz"], "front"), /Layer zz was not found/);
});

test("reordering layers in different groups keeps each one in its own group", () => {
  const layers = [
    createLayer("rectangle", { id: "a" }),
    createLayer("group", { id: "g" }),
    createLayer("rectangle", { id: "x", parentId: "g" }),
    createLayer("rectangle", { id: "y", parentId: "g" }),
    createLayer("rectangle", { id: "b" }),
  ];
  const next = reorderLayers(layers, ["a", "x"], "front");
  assert.deepEqual(ids(next), ["g", "b", "y", "x", "a"]);
  assert.deepEqual(parents(next), parents(layers));
  // A layer whose group is chosen moves with the group.
  assert.deepEqual(ids(reorderLayers(layers, ["g", "x"], "front")), ["a", "b", "x", "y", "g"]);
});

test("reordering refuses to separate a mask from the layer it masks", () => {
  const layers = [
    createLayer("rectangle", { id: "mask", name: "Mask", isMask: true }),
    createLayer("rectangle", { id: "target", name: "Target" }),
    createLayer("rectangle", { id: "other", name: "Other" }),
  ];
  assert.throws(() => reorderLayers(layers, ["target"], "forward"), /would stop masking “Target”/);
  assert.deepEqual(ids(reorderLayers(layers, ["mask", "target"], "front")), ["other", "mask", "target"]);
});

test("eye and lock flags switch for many layers at once", () => {
  const layers = ["a", "b", "c"].map((id) => createLayer("rectangle", { id, name: id }));
  const hidden = setLayerFlags(layers, ["a", "c"], { visible: false });
  assert.deepEqual(hidden.map((layer) => layer.visible), [false, true, false]);
  assert.equal(hidden[1], layers[1], "unchanged layers are kept as they are");
  const locked = setLayerFlags(hidden, ["a", "b"], { locked: true, visible: true });
  assert.deepEqual(locked.map((layer) => [layer.locked, layer.visible]), [[true, true], [true, true], [false, false]]);
  assert.equal(setLayerFlags(layers, ["a"], { visible: true }), null, "already shown");
  assert.throws(() => setLayerFlags(layers, ["a"], { visible: "no" }), /visible must be true or false/);
  assert.throws(() => setLayerFlags(layers, ["a"], {}), /Choose visible, locked, or both/);
  assert.throws(() => setLayerFlags(layers, ["zz"], { locked: true }), /Layer zz was not found/);
});

test("hiding the only layer a mask masks is refused, since the scene could not be drawn", () => {
  const layers = [
    createLayer("rectangle", { id: "mask", name: "Mask", isMask: true }),
    createLayer("rectangle", { id: "target", name: "Target" }),
  ];
  assert.throws(() => setLayerFlags(layers, ["target"], { visible: false }), /the mask “Mask” would have no visible layer above it to mask\. Hide the mask too\./);
  assert.ok(setLayerFlags(layers, ["mask", "target"], { visible: false }), "hiding both is fine");
  const both = setLayerFlags(layers, ["mask", "target"], { visible: false });
  assert.throws(() => setLayerFlags(both, ["mask"], { visible: true }), /Show the layer above it first/);
});

test("the editing API reorders, moves, hides and locks layers", () => {
  const document = parseDocument(sample());
  const scene = sceneId(document);
  let next = applyOperations(document, [{ type: "reorder_layer", sceneId: scene, layerId: "a", to: "front" }]);
  // The top-level layers take the top-level places in the array; x and y stay where they are.
  assert.deepEqual(ids(next.scenes[0].layers), ["b", "g", "c", "x", "y", "a"]);
  next = applyOperations(next, [{ type: "reorder_layer", sceneId: scene, layerId: "a", to: 0 }]);
  assert.deepEqual(ids(next.scenes[0].layers), ["a", "b", "g", "x", "y", "c"]);
  next = applyOperations(next, [{ type: "move_layers", sceneId: scene, layerIds: ["a"], position: "top", parentId: "g" }]);
  assert.equal(next.scenes[0].layers.find((layer) => layer.id === "a").parentId, "g");
  assertSameLook(document.scenes[0].layers, next.scenes[0].layers, ["a"]);
  next = applyOperations(next, [{ type: "move_layers", sceneId: scene, layerIds: ["a"], position: "below", referenceId: "b" }]);
  assert.equal(next.scenes[0].layers.find((layer) => layer.id === "a").parentId, null);
  next = applyOperations(next, [{ type: "set_layer_flags", sceneId: scene, layerIds: ["g", "c"], locked: true, visible: false }]);
  assert.deepEqual(next.scenes[0].layers.filter((layer) => layer.locked).map((layer) => layer.id), ["g", "c"]);
  assert.deepEqual(next.scenes[0].layers.filter((layer) => !layer.visible).map((layer) => layer.id), ["g", "c"]);
  // Nothing to change is not an error.
  assert.ok(applyOperations(next, [{ type: "reorder_layer", sceneId: scene, layerId: "c", to: "front" }]));
});

test("the editing API explains wrong input", () => {
  const document = parseDocument(sample());
  const scene = sceneId(document);
  const fails = (operation, pattern) => assert.throws(() => applyOperations(document, [{ sceneId: scene, ...operation }]), pattern);
  fails({ type: "reorder_layer", to: "front" }, /reorder_layer needs layerId/);
  fails({ type: "reorder_layer", layerId: "a", to: "top" }, /reorder_layer needs to/);
  fails({ type: "reorder_layer", layerId: "a", to: 1.5 }, /reorder_layer needs to/);
  fails({ type: "set_layer_flags", layerIds: [] }, /set_layer_flags needs layerIds/);
  fails({ type: "set_layer_flags", layerIds: ["a"] }, /needs visible, locked, or both/);
  fails({ type: "set_layer_flags", layerIds: ["a"], locked: "yes" }, /locked must be true or false/);
  fails({ type: "move_layers", layerIds: ["a"], position: "inside" }, /move_layers needs position/);
  fails({ type: "move_layers", layerIds: ["a"], position: "above" }, /needs referenceId/);
  fails({ type: "move_layers", layerIds: ["a"], position: "top", parentId: 4 }, /parentId must be the ID of a group/);
  fails({ type: "move_layers", layerIds: ["g"], position: "top", parentId: "g" }, /can't go into itself/);
});
