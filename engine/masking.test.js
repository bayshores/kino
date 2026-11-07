import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, parseDocument } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { worldMatrix } from "./geometry.js";
import { groupLayers, maskOfGroup, maskTargets, ungroupLayers } from "./grouping.js";
import { createMask, removeMasks } from "./masking.js";
import { applyOperations } from "./operations.js";
import { renderSceneSvg } from "./render.js";

const TIMES = [0, 0.25, 0.5, 1];

function documentWith(layers, scene = {}) {
  const document = createDocument();
  Object.assign(document.scenes[0], { width: 100, height: 100, background: "#ffffff", ...scene });
  document.scenes[0].layers = layers;
  return document;
}

// The same document with a new layer list for its scene (so the scene ID stays the same).
function withLayers(document, layers) {
  return { ...document, scenes: [{ ...document.scenes[0], layers }] };
}

function box(type, id, values = {}) {
  return createLayer(type, { id, name: id, x: 0, y: 0, width: 100, height: 100, ...values });
}

// A scene of 100 × 100: red on the top half, blue on the bottom half, and a white square in
// the middle (25..75) that can become the mask.
function halves() {
  return [
    box("rectangle", "square", { x: 25, y: 25, width: 50, height: 50, fill: "#ffffff" }),
    box("rectangle", "red", { height: 50, fill: "#ff0000" }),
    box("rectangle", "blue", { y: 50, height: 50, fill: "#0000ff" }),
  ];
}

function pixelsOf(document) {
  const scene = document.scenes[0];
  const pixels = new Resvg(renderSceneSvg(scene, 0)).render().pixels;
  return (x, y) => [...pixels.subarray((y * scene.width + x) * 4, (y * scene.width + x) * 4 + 3)];
}

function assertSameWorld(before, after, ids) {
  for (const time of TIMES) {
    for (const id of ids) {
      const evaluate = (item) => evaluateLayer(item, time);
      const a = worldMatrix(before.find((layer) => layer.id === id), before, evaluate);
      const b = worldMatrix(after.find((layer) => layer.id === id), after, evaluate);
      a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 1e-6, `${id} at ${time}s moved`));
    }
  }
}

const WHITE = [255, 255, 255],
  RED = [255, 0, 0],
  BLUE = [0, 0, 255];

test("Create mask makes the bottom-most selected layer the mask of a new mask group", () => {
  const document = documentWith(halves());
  const sceneId = document.scenes[0].id;
  // Selection order does not matter: the bottom-most layer is the mask.
  const { layers, groupId, maskId } = createMask(document, sceneId, ["blue", "square", "red"], { id: "masked" });
  assert.equal(groupId, "masked");
  assert.equal(maskId, "square");
  assert.deepEqual(layers.map((layer) => layer.id), ["masked", "square", "red", "blue"]);
  const group = layers[0];
  assert.equal(group.type, "group");
  assert.equal(group.name, "Mask group");
  assert.equal(group.isMaskGroup, true);
  assert.deepEqual([group.x, group.y, group.width, group.height], [0, 0, 100, 100]);
  assert.equal(layers.find((layer) => layer.id === "square").isMask, true);
  assert.equal(maskOfGroup(group, layers).id, "square");
  assert.ok(layers.slice(1).every((layer) => layer.parentId === "masked" && (layer.id === "square" || !layer.isMask)));
  assertSameWorld(document.scenes[0].layers, layers, ["square", "red", "blue"]);
  // The result is a valid saved document, and the original is untouched.
  const saved = parseDocument(documentWith(layers));
  assert.equal(saved.scenes[0].layers[0].isMaskGroup, true);
  assert.equal(document.scenes[0].layers[0].isMask, false);
});

test("the mask hides every other layer of the group outside its shape in the rendered frame", () => {
  const document = documentWith(halves());
  const before = pixelsOf(document);
  assert.deepEqual(before(10, 10), RED);
  assert.deepEqual(before(10, 90), BLUE);

  const { layers } = createMask(document, document.scenes[0].id, ["square", "red", "blue"]);
  const after = pixelsOf(documentWith(layers));
  // Inside the white square both masked layers show; outside it only the background does.
  assert.deepEqual(after(30, 30), RED);
  assert.deepEqual(after(30, 70), BLUE);
  assert.deepEqual(after(10, 10), WHITE);
  assert.deepEqual(after(10, 90), WHITE);
  assert.deepEqual(after(90, 50), WHITE);
  // The square itself is not drawn on top: the red and blue layers keep their colors.
  assert.deepEqual(after(50, 45), RED);
  assert.deepEqual(after(50, 55), BLUE);
});

test("an animated mask moves its window over the masked layers", () => {
  const square = box("rectangle", "square", { x: 0, y: 0, width: 50, height: 100, fill: "#ffffff" });
  square.animations.push({ id: "slide", name: "Slide", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 50 } });
  const document = documentWith([square, box("rectangle", "red", { fill: "#ff0000" })], { duration: 1 });
  const { layers } = createMask(document, document.scenes[0].id, ["square", "red"]);
  const scene = { ...document.scenes[0], layers };
  const at = (time, x) => {
    const pixels = new Resvg(renderSceneSvg(scene, time)).render().pixels;
    return [...pixels.subarray((50 * 100 + x) * 4, (50 * 100 + x) * 4 + 3)];
  };
  assert.deepEqual(at(0, 10), RED);
  assert.deepEqual(at(0, 90), WHITE);
  assert.deepEqual(at(1, 10), WHITE);
  assert.deepEqual(at(1, 90), RED);
});

test("removing the mask (ungrouping the mask group) restores the original layers", () => {
  const original = halves();
  const document = documentWith(original);
  const sceneId = document.scenes[0].id;
  const masked = withLayers(document, createMask(document, sceneId, ["square", "red", "blue"], { id: "masked" }).layers);
  const removed = removeMasks(masked, sceneId, ["masked"]);
  assert.deepEqual(removed.childIds, ["square", "red", "blue"]);
  assert.deepEqual(removed.layers, original);
  // Plain ungroup does the same thing.
  assert.deepEqual(ungroupLayers(masked, sceneId, ["masked"]).layers, original);
  assert.deepEqual(pixelsOf(documentWith(removed.layers))(10, 10), RED);
  assert.throws(() => removeMasks(document, sceneId, ["red"]), /“red” is not a mask group/);
});

test("Create mask keeps rotated, scaled and animated layers in place, and removing it does too", () => {
  const mask = box("ellipse", "mask", { x: 140, y: 60, width: 120, height: 90, rotation: 30, fill: "#ffffff" });
  const photo = box("rectangle", "photo", { x: 100, y: 40, width: 220, height: 160, rotation: -12, scaleX: 1.4 });
  photo.animations.push({ id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing: "smooth", from: { x: 100, rotation: -12 }, to: { x: 260, rotation: 80 } });
  const parent = box("group", "parent", { x: 50, y: 30, width: 400, height: 300, rotation: 15, scaleX: 0.8, scaleY: 0.8 });
  const document = documentWith([parent, { ...mask, parentId: "parent" }, { ...photo, parentId: "parent" }], { width: 640, height: 360 });
  const sceneId = document.scenes[0].id;
  const { layers, groupId } = createMask(document, sceneId, ["photo", "mask"]);
  assert.equal(layers.find((layer) => layer.id === groupId).parentId, "parent");
  assertSameWorld(document.scenes[0].layers, layers, ["mask", "photo"]);
  const restored = ungroupLayers(withLayers(document, layers), sceneId, [groupId]).layers;
  assertSameWorld(document.scenes[0].layers, restored, ["mask", "photo"]);
  assert.equal(restored.find((layer) => layer.id === "mask").isMask, false);
});

test("Create mask explains what it can't do and changes nothing", () => {
  const sound = createLayer("audio", { id: "sound", name: "Sound" });
  const group = box("group", "group");
  const child = box("rectangle", "child", { parentId: "group" });
  const document = documentWith([sound, ...halves(), group, child]);
  const sceneId = document.scenes[0].id;
  assert.throws(() => createMask(document, sceneId, ["red"]), /select at least two layers. The bottom one becomes the mask/);
  assert.throws(() => createMask(document, sceneId, ["red", "red"]), /select at least two layers/);
  assert.throws(() => createMask(document, sceneId, ["group", "child"]), /two layers that are not inside each other/);
  assert.throws(() => createMask(document, sceneId, ["red", "blue"], { maskLayerId: "square" }), /must be one of the selected layers/);
  assert.throws(() => createMask(document, sceneId, ["sound", "red"], { maskLayerId: "sound" }), /“Sound” is an audio layer/);
  assert.throws(() => createMask(document, sceneId, ["group", "child", "red"], { maskLayerId: "child" }), /“child” is inside another selected layer/);
  assert.throws(() => createMask(document, sceneId, ["missing", "red"]), /Layer missing was not found/);
  // An audio layer at the bottom is masked along with the rest; the next layer is the mask.
  assert.equal(createMask(document, sceneId, ["sound", "square", "red"]).maskId, "square");
  assert.equal(document.scenes[0].layers.find((layer) => layer.id === "square").isMask, false);
});

test("masks that were already in the selection keep masking the same layer", () => {
  const document = documentWith([
    box("rectangle", "back", { fill: "#00ff00" }),
    box("ellipse", "spot", { name: "Spot", isMask: true, fill: "#ffffff" }),
    box("rectangle", "photo", { name: "Photo" }),
  ]);
  const sceneId = document.scenes[0].id;
  // back becomes the mask of the group; spot still masks photo inside it.
  const { layers } = createMask(document, sceneId, ["back", "spot", "photo"]);
  assert.equal(maskTargets(layers).get("spot"), "photo");
  // Choosing photo as the mask would leave spot with nothing to mask.
  assert.throws(() => createMask(document, sceneId, ["back", "spot", "photo"], { maskLayerId: "photo" }), /the mask “Spot” would stop masking “Photo”/);
  // A mask is made of the existing mask and the layer it masks: spot now masks the whole group.
  const pair = createMask(document, sceneId, ["spot", "photo"]);
  assert.equal(pair.maskId, "spot");
  assert.equal(maskOfGroup(pair.layers.find((layer) => layer.id === pair.groupId), pair.layers).id, "spot");
});

test("grouping inside a mask group keeps its layers masked, and moving layers in or out is refused", () => {
  const document = documentWith([...halves(), box("rectangle", "outside", { x: 200 })]);
  const sceneId = document.scenes[0].id;
  const masked = withLayers(document, createMask(document, sceneId, ["square", "red", "blue"], { id: "masked" }).layers);
  // Layers above the mask can be grouped: the mask covers the new group instead.
  const grouped = groupLayers(masked, sceneId, ["red", "blue"], { id: "pair" });
  assert.equal(grouped.layers.find((layer) => layer.id === "pair").parentId, "masked");
  const pixels = pixelsOf(documentWith(grouped.layers));
  assert.deepEqual(pixels(30, 30), RED);
  assert.deepEqual(pixels(10, 10), WHITE);
  // Ungrouping that group puts the layers back above the mask, still masked.
  const ungrouped = ungroupLayers(withLayers(document, grouped.layers), sceneId, ["pair"]).layers;
  assert.equal(maskOfGroup(ungrouped.find((layer) => layer.id === "masked"), ungrouped).id, "square");
  assert.deepEqual(pixelsOf(documentWith(ungrouped))(10, 10), WHITE);

  assert.throws(() => groupLayers(masked, sceneId, ["square"]), /“square” is the mask of the mask group “Mask group” and must stay its bottom layer/);
  assert.throws(() => groupLayers(masked, sceneId, ["square", "red"]), /must stay its bottom layer/);
  assert.throws(() => groupLayers(masked, sceneId, ["red", "outside"]), /“red” would leave “Mask group”, which is a mask group/);
  assert.throws(() => createMask(masked, sceneId, ["red", "outside"]), /^Error: Can't create a mask: “red” would leave “Mask group”, which is a mask group/);
});

test("a mask group refuses changes that would give it a different mask", () => {
  const layers = [
    box("group", "masked", { name: "Masked", isMaskGroup: true }),
    box("rectangle", "below", { parentId: "masked", fill: "#00ff00" }),
    box("group", "inner", { name: "Inner", parentId: "masked" }),
    box("ellipse", "spot", { name: "Spot", parentId: "inner", isMask: true }),
    box("rectangle", "photo", { parentId: "inner" }),
    box("ellipse", "mask", { name: "Mask", parentId: "masked", isMask: true }),
    box("rectangle", "above", { parentId: "masked" }),
  ];
  const document = documentWith(layers);
  const sceneId = document.scenes[0].id;
  // "inner" sits below the mask. Ungrouping it would make "Spot" the group's bottom-most mask,
  // so "Spot" would mask everything above it instead of only "photo".
  assert.throws(() => ungroupLayers(document, sceneId, ["inner"]), /Can't ungroup “Inner”: the mask “Spot” would stop masking “photo”/);
  // With both masks hidden nothing is masked yet, but showing "Spot" later would mask the whole
  // group, so the change is still refused.
  const hidden = withLayers(document, layers.map((layer) => (layer.isMask ? { ...layer, visible: false } : layer)));
  assert.throws(() => ungroupLayers(hidden, sceneId, ["inner"]), /the mask group “Masked” would use “Spot” as its mask instead of “Mask”/);
  // Layers below the mask can't be grouped with layers above it.
  assert.throws(() => groupLayers(document, sceneId, ["below", "above"]), /“below” is below the mask of “Masked”/);
  // Layers below the mask are drawn without it.
  assert.deepEqual(pixelsOf(document)(5, 5), [0, 255, 0]);
});

test("grouping never moves a layer across a mask group's mask, even out of or into a nested group", () => {
  const GREEN = [0, 255, 0];
  const masked = box("group", "masked", { name: "Masked", isMaskGroup: true });
  const mask = box("ellipse", "mask", { name: "Mask", parentId: "masked", x: 40, y: 40, width: 20, height: 20, isMask: true, fill: "#ffffff" });
  const square = (id, x, y, fill, parentId = "masked") => box("rectangle", id, { name: id.toUpperCase(), parentId, x, y, width: 20, height: 20, fill });
  const tryBoth = (document, ids, pattern) => {
    const sceneId = document.scenes[0].id;
    assert.throws(() => groupLayers(document, sceneId, ids), pattern);
    assert.throws(() => createMask(document, sceneId, ids), pattern);
  };

  // X is in a plain group below the mask, so it is drawn unmasked. Grouping it with A (above
  // the mask) would put it above the mask, where the mask would hide it.
  const nestedBelow = documentWith([masked, box("group", "low", { name: "Low", parentId: "masked", width: 20, height: 20 }), square("x", 0, 0, "#00ff00", "low"), mask, square("a", 80, 0, "#ff0000")]);
  assert.deepEqual(pixelsOf(nestedBelow)(10, 10), GREEN);
  tryBoth(nestedBelow, ["x", "a"], /“X” is below the mask of “Masked”/);

  // B is below the mask. Grouping it with Y, which is in a plain group above the mask, would
  // put it into that group, above the mask.
  const nestedAbove = documentWith([masked, square("b", 0, 80, "#00ff00"), mask, box("group", "high", { name: "High", parentId: "masked" }), square("y", 80, 80, "#ff0000", "high")]);
  assert.deepEqual(pixelsOf(nestedAbove)(10, 90), GREEN);
  tryBoth(nestedAbove, ["b", "y"], /“B” is below the mask of “Masked”/);

  // Layers that stay on their side of the mask can still be grouped into nested groups.
  const both = documentWith([
    masked,
    square("b", 0, 80, "#00ff00"),
    box("group", "low", { name: "Low", parentId: "masked", width: 20, height: 20 }),
    square("x", 0, 0, "#00ff00", "low"),
    mask,
    square("a", 80, 0, "#ff0000"),
    box("group", "high", { name: "High", parentId: "masked" }),
    square("y", 80, 80, "#ff0000", "high"),
  ]);
  const sceneId = both.scenes[0].id;
  const low = groupLayers(both, sceneId, ["b", "x"], { id: "pair" }).layers;
  assert.equal(low.find((layer) => layer.id === "pair").parentId, "low");
  assert.deepEqual(pixelsOf(documentWith(low))(10, 90), GREEN);
  const high = groupLayers(both, sceneId, ["a", "y"], { id: "pair" }).layers;
  assert.equal(high.find((layer) => layer.id === "pair").parentId, "high");
  assert.deepEqual(pixelsOf(documentWith(high))(90, 10), WHITE);
});

test("removing the mask of an animated or faded mask group keeps the group and turns the mask off", () => {
  const document = parseDocument(documentWith(halves()));
  const sceneId = document.scenes[0].id;
  const spin = { id: "spin", name: "Spin", kind: "custom", start: 0.5, duration: 0.5, easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } };
  for (const change of [
    { type: "add_animation", sceneId, layerId: "masked", animation: spin },
    { type: "update_layer", sceneId, layerId: "masked", properties: { opacity: 0.5 } },
  ]) {
    const masked = applyOperations(document, [{ type: "create_mask", sceneId, layerIds: ["square", "red", "blue"], groupId: "masked" }, change]);
    assert.throws(() => ungroupLayers(masked, sceneId, ["masked"]), /Can't ungroup “Mask group”/);
    const result = removeMasks(masked, sceneId, ["masked"]);
    assert.deepEqual(result.keptGroupIds, ["masked"]);
    assert.deepEqual(result.childIds, []);
    assert.match(result.notice, /Removed the mask\. “Mask group” stays a group/);
    // The group keeps its animation and effects; only the mask is turned off.
    const group = result.layers.find((layer) => layer.id === "masked");
    const before = masked.scenes[0].layers.find((layer) => layer.id === "masked");
    assert.deepEqual({ ...group, isMaskGroup: true }, before);
    assert.equal(group.isMaskGroup, false);
    assert.equal(result.layers.find((layer) => layer.id === "square").isMask, false);
    assert.deepEqual(result.layers.map((layer) => layer.id), ["masked", "square", "red", "blue"]);
    assertSameWorld(masked.scenes[0].layers, result.layers, ["masked", "square", "red", "blue"]);
    assert.doesNotThrow(() => parseDocument(withLayers(masked, result.layers)));
  }
  // With the animated group, the frame now shows the layers that were hidden outside the mask.
  const animated = applyOperations(document, [{ type: "create_mask", sceneId, layerIds: ["square", "red", "blue"], groupId: "masked" }, { type: "add_animation", sceneId, layerId: "masked", animation: spin }]);
  assert.deepEqual(pixelsOf(animated)(10, 10), WHITE);
  const pixels = pixelsOf(withLayers(animated, removeMasks(animated, sceneId, ["masked"]).layers));
  assert.deepEqual(pixels(10, 10), RED);
  assert.deepEqual(pixels(10, 90), BLUE);

  // A mask group that can be ungrouped is still ungrouped, and there is nothing to report.
  const plain = applyOperations(document, [{ type: "create_mask", sceneId, layerIds: ["square", "red", "blue"], groupId: "masked" }]);
  const ungrouped = removeMasks(plain, sceneId, ["masked"]);
  assert.deepEqual(ungrouped.keptGroupIds, []);
  assert.equal(ungrouped.notice, "");
  assert.deepEqual(ungrouped.layers, document.scenes[0].layers);
});

test("apply_operations remove_mask removes the mask the same way as the editor command", () => {
  const document = parseDocument(documentWith(halves()));
  const sceneId = document.scenes[0].id;
  const create = { type: "create_mask", sceneId, layerIds: ["square", "red", "blue"], groupId: "masked" };
  const removed = applyOperations(document, [create, { type: "remove_mask", sceneId, layerId: "masked" }]);
  assert.deepEqual(removed.scenes[0].layers, document.scenes[0].layers);
  const faded = applyOperations(document, [create, { type: "update_layer", sceneId, layerId: "masked", properties: { opacity: 0.5 } }, { type: "remove_mask", sceneId, layerId: "masked" }]);
  const group = faded.scenes[0].layers.find((layer) => layer.id === "masked");
  assert.equal(group.isMaskGroup, false);
  assert.equal(group.opacity, 0.5);
  assert.equal(faded.scenes[0].layers.find((layer) => layer.id === "square").isMask, false);
  assert.throws(() => applyOperations(document, [{ type: "remove_mask", sceneId, layerId: "red" }]), /“red” is not a mask group/);
  assert.throws(() => applyOperations(document, [{ type: "remove_mask", sceneId }]), /remove_mask needs layerId/);
});

test("a chosen mask stays at the bottom of the layers after its mask is removed", () => {
  // A white circle on top of a red square. Choosing the circle as the mask moves it below the
  // square, and removing the mask does not move it back: it is then drawn under the square.
  const document = parseDocument(documentWith([
    box("rectangle", "red", { fill: "#ff0000" }),
    box("ellipse", "white", { x: 25, y: 25, width: 50, height: 50, fill: "#ffffff" }),
  ], { background: "#000000" }));
  const sceneId = document.scenes[0].id;
  assert.deepEqual(pixelsOf(document)(50, 50), WHITE);
  const masked = applyOperations(document, [{ type: "create_mask", sceneId, layerIds: ["red", "white"], maskLayerId: "white", groupId: "masked" }]);
  assert.deepEqual(masked.scenes[0].layers.map((layer) => layer.id), ["masked", "white", "red"]);
  const removed = applyOperations(masked, [{ type: "remove_mask", sceneId, layerId: "masked" }]);
  assert.deepEqual(removed.scenes[0].layers.map((layer) => layer.id), ["white", "red"]);
  assert.equal(removed.scenes[0].layers[0].isMask, false);
  assert.deepEqual(pixelsOf(removed)(50, 50), RED);
});

test("Create mask names the layer another mask would start masking", () => {
  // Q masks nothing because the next layer is another mask. Making R the group's mask would
  // leave Q right under T, so Q would start masking T.
  const document = documentWith([
    box("ellipse", "q", { name: "Q", isMask: true }),
    box("ellipse", "r", { name: "R", isMask: true }),
    box("rectangle", "t", { name: "T" }),
  ]);
  assert.throws(
    () => createMask(document, document.scenes[0].id, ["q", "r", "t"], { maskLayerId: "r" }),
    /^Error: Can't create a mask: the mask “Q” would start masking “T”\. Choose a different mask layer\.$/,
  );
});

test("a hidden mask or an empty mask group draws without errors", () => {
  const document = documentWith(halves());
  const sceneId = document.scenes[0].id;
  const { layers } = createMask(document, sceneId, ["square", "red", "blue"]);
  const hiddenMask = layers.map((layer) => (layer.id === "square" ? { ...layer, visible: false } : layer));
  assert.deepEqual(pixelsOf(documentWith(hiddenMask))(10, 10), RED);
  const onlyMask = layers.filter((layer) => !["red", "blue"].includes(layer.id));
  assert.deepEqual(pixelsOf(documentWith(onlyMask))(50, 50), WHITE);
});

test("only groups can be mask groups, and older documents load without the flag", () => {
  const document = documentWith([box("rectangle", "red", { isMaskGroup: true })]);
  assert.throws(() => parseDocument(document), /isMaskGroup: only a group can be a mask group/);
  const old = documentWith([box("group", "group")]);
  delete old.scenes[0].layers[0].isMaskGroup;
  assert.equal(parseDocument(old).scenes[0].layers[0].isMaskGroup, false);
  assert.throws(() => parseDocument(documentWith([box("group", "group", { isMaskGroup: "yes" })])), /isMaskGroup/);
});

test("apply_operations create_mask makes the same mask group, and ungroup_layer removes it", () => {
  const document = parseDocument(documentWith(halves()));
  const sceneId = document.scenes[0].id;
  const op = (properties) => ({ type: "create_mask", sceneId, layerIds: ["red", "blue", "square"], ...properties });
  const masked = applyOperations(document, [op({ groupId: "masked", name: "Window" })]);
  const layers = masked.scenes[0].layers;
  assert.deepEqual(layers.map((layer) => layer.id), ["masked", "square", "red", "blue"]);
  assert.equal(layers[0].name, "Window");
  assert.equal(layers[0].isMaskGroup, true);
  assert.equal(layers[1].isMask, true);
  assert.deepEqual(pixelsOf(masked)(10, 10), WHITE);
  // Choosing the mask moves it to the bottom of the group.
  const chosen = applyOperations(document, [op({ maskLayerId: "blue", groupId: "chosen" })]).scenes[0].layers;
  assert.deepEqual(chosen.map((layer) => layer.id), ["chosen", "blue", "square", "red"]);
  assert.equal(chosen[1].isMask, true);
  const restored = applyOperations(masked, [{ type: "ungroup_layer", sceneId, layerId: "masked" }]);
  assert.deepEqual(restored.scenes[0].layers, document.scenes[0].layers);

  assert.throws(() => applyOperations(document, [op({ layerIds: ["red"] })]), /create_mask needs layerIds: an array of 2 to 5000 layer IDs/);
  assert.throws(() => applyOperations(document, [op({ layerIds: "red" })]), /create_mask needs layerIds/);
  assert.throws(() => applyOperations(document, [op({ maskLayerId: 4 })]), /create_mask maskLayerId must be the ID/);
  assert.throws(() => applyOperations(document, [op({ name: " " })]), /create_mask name must be text/);
  assert.throws(() => applyOperations(document, [op({ groupId: "a b" })]), /create_mask groupId must be/);
  assert.throws(() => applyOperations(document, [op({ groupId: "red" })]), /layer ID red is already used/);
});
