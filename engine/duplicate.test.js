import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { worldMatrix } from "./geometry.js";
import { maskTargets, paintOrder } from "./grouping.js";
import { createMask } from "./masking.js";
import { renderSceneSvg } from "./render.js";
import { presetAnimation } from "./animation.js";
import { DUPLICATE_OFFSET, copyName, copyOffsets, duplicateRepeated, duplicateSelection } from "./duplicate.js";

function documentWith(layers) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", layers })] }));
}

const layersOf = (document) => document.scenes.find((scene) => scene.id === "main").layers;
const byName = (layers, name) => layers.find((layer) => layer.name === name);
// Layer names from the bottom of the canvas to the top (children are drawn in their group's place).
function drawnNames(layers) {
  const order = paintOrder(layers);
  return [...layers].sort((a, b) => order.get(a.id) - order.get(b.id)).map((layer) => layer.name);
}

test("a copy goes directly above its original, 24 pixels right and down, named “<name> copy”", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "a", name: "A", x: 10, y: 20 }),
    createLayer("rectangle", { id: "b", name: "B", x: 50, y: 60 }),
  ]);
  const before = structuredClone(document);
  const result = duplicateSelection(document, "main", ["a"]);
  const layers = layersOf(result.document);
  assert.deepEqual(layers.map((layer) => layer.name), ["A", "A copy", "B"], "above A, not on top of the scene");
  const copy = layers[1];
  assert.notEqual(copy.id, "a");
  assert.equal(copy.x, 10 + DUPLICATE_OFFSET);
  assert.equal(copy.y, 20 + DUPLICATE_OFFSET);
  assert.deepEqual(result.rootIds, [copy.id]);
  assert.deepEqual(document, before, "the document passed in is not changed");
  assert.doesNotThrow(() => parseDocument(result.document));
});

test("a duplicated group brings its children, and only the group moves", () => {
  const document = documentWith([
    createLayer("group", { id: "g", name: "Group", x: 100, y: 100, width: 200, height: 200 }),
    createLayer("rectangle", { id: "c", name: "Child", parentId: "g", x: 5, y: 6 }),
    createLayer("rectangle", { id: "top", name: "Top" }),
  ]);
  const result = duplicateSelection(document, "main", ["g"]);
  const layers = layersOf(result.document);
  assert.deepEqual(drawnNames(layers), ["Group", "Child", "Group copy", "Child copy", "Top"]);
  const group = byName(layers, "Group copy"), child = byName(layers, "Child copy");
  assert.equal(child.parentId, group.id, "the copied child is inside the copied group");
  assert.deepEqual([group.x, group.y], [124, 124]);
  assert.deepEqual([child.x, child.y], [5, 6], "children keep their place inside the group");
  assert.deepEqual(result.rootIds, [group.id]);
});

test("a copy inside a rotated group still moves right and down on the canvas", () => {
  const document = documentWith([
    createLayer("group", { id: "g", name: "Group", x: 100, y: 80, width: 200, height: 120, rotation: 30, scaleX: 2, scaleY: 2 }),
    createLayer("rectangle", { id: "c", name: "Child", parentId: "g", x: 20, y: 10, width: 40, height: 30 }),
  ]);
  const layers = layersOf(duplicateSelection(document, "main", ["c"]).document);
  const original = worldMatrix(byName(layers, "Child"), layers);
  const copy = worldMatrix(byName(layers, "Child copy"), layers);
  assert.equal(byName(layers, "Child copy").parentId, "g");
  assert.ok(Math.abs(copy[4] - original[4] - DUPLICATE_OFFSET) < 1e-6);
  assert.ok(Math.abs(copy[5] - original[5] - DUPLICATE_OFFSET) < 1e-6);
});

test("a copy's position animation moves with it, so it animates like the original, offset", () => {
  const layer = createLayer("rectangle", { id: "a", name: "A", x: 10, y: 20 });
  layer.animations = [presetAnimation("slide-up", layer, 0), presetAnimation("fade-in", layer, 0)];
  const document = documentWith([layer]);
  const [original, copy] = layersOf(duplicateSelection(document, "main", ["a"]).document);
  const [slide, fade] = copy.animations;
  assert.equal(slide.to.y, original.animations[0].to.y + DUPLICATE_OFFSET);
  assert.equal(slide.from.y, original.animations[0].from.y + DUPLICATE_OFFSET);
  assert.deepEqual(fade.from, original.animations[1].from, "other properties are kept");
  assert.notEqual(slide.id, original.animations[0].id, "animations get new IDs");
});

test("duplicating a plain mask copies the layer it masks too, and the scene still draws", () => {
  const document = documentWith([
    createLayer("ellipse", { id: "m", name: "Mask", isMask: true, x: 0, y: 0 }),
    createLayer("rectangle", { id: "t", name: "Masked", x: 0, y: 0 }),
    createLayer("rectangle", { id: "u", name: "Above" }),
  ]);
  for (const selection of [["m"], ["t"]]) {
    const result = duplicateSelection(document, "main", selection);
    const layers = layersOf(result.document);
    assert.deepEqual(layers.map((layer) => layer.name), ["Mask", "Masked", "Mask copy", "Masked copy", "Above"]);
    const targets = maskTargets(layers);
    assert.equal(targets.get("m"), "t", "the original mask still masks the original layer");
    assert.equal(targets.get(byName(layers, "Mask copy").id), byName(layers, "Masked copy").id, "the copied mask masks the copy");
    assert.deepEqual([byName(layers, "Mask copy").x, byName(layers, "Masked copy").x], [24, 24], "the pair moves together");
    assert.deepEqual(result.rootIds, [byName(layers, "Mask copy").id, byName(layers, "Masked copy").id]);
    assert.doesNotThrow(() => renderSceneSvg(result.document.scenes[0], 0));
  }
});

test("a mask group's mask can't be duplicated on its own; its group and other layers can", () => {
  const base = documentWith([
    createLayer("rectangle", { id: "square", name: "square" }),
    createLayer("rectangle", { id: "red", name: "red" }),
  ]);
  const { layers, groupId, maskId } = createMask(base, "main", ["square", "red"]);
  const document = parseDocument({ ...base, scenes: [{ ...base.scenes[0], layers }] });
  const before = structuredClone(document);
  // Its copy would sit above “red” in the group and mask it, which the original doesn't do.
  assert.throws(() => duplicateSelection(document, "main", [maskId]), /copied mask “square” would mask “red”/);
  assert.deepEqual(document, before);

  const group = duplicateSelection(document, "main", [groupId]);
  assert.deepEqual(drawnNames(layersOf(group.document)), ["Mask group", "square", "red", "Mask group copy", "square copy", "red copy"]);
  assert.doesNotThrow(() => renderSceneSvg(group.document.scenes[0], 0));

  const inside = duplicateSelection(document, "main", ["red"]);
  const insideLayers = layersOf(inside.document);
  assert.deepEqual(
    insideLayers.map((layer) => [layer.name, layer.parentId]),
    [["Mask group", null], ["square", groupId], ["red", groupId], ["red copy", groupId]],
    "the copy stays in the mask group, under its mask",
  );
  assert.doesNotThrow(() => renderSceneSvg(inside.document.scenes[0], 0));
});

test("copy names fit in a layer name, and a copy can't leave the supported position range", () => {
  assert.equal(copyName("Card"), "Card copy");
  const long = copyName("x".repeat(256));
  assert.equal(long.length, 256);
  assert.ok(long.endsWith(" copy"));
  const edge = documentWith([createLayer("rectangle", { id: "a", name: "Edge", x: 999_990 })]);
  assert.throws(() => duplicateSelection(edge, "main", ["a"]), /Can't duplicate “Edge”: its copy would be outside the supported position range/);
  const named = documentWith([createLayer("rectangle", { id: "a", name: "y".repeat(256) })]);
  assert.doesNotThrow(() => parseDocument(duplicateSelection(named, "main", ["a"]).document));
});

test("a copy keeps its original's aspect-ratio lock", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "a", name: "Locked", lockAspect: true }),
    createLayer("rectangle", { id: "b", name: "Free" }),
  ]);
  const layers = layersOf(duplicateSelection(document, "main", ["a", "b"]).document);
  assert.equal(byName(layers, "Locked copy").lockAspect, true);
  assert.equal(byName(layers, "Free copy").lockAspect, false);
});

test("count makes numbered copies in a line, grid or ring, each copy's animations staggered", () => {
  const document = documentWith([createLayer("rectangle", { id: "dot", name: "Dot", x: 100, y: 100, width: 20, height: 20,
    animations: [presetAnimation("fade-in", createLayer("rectangle", { id: "dot" }), 0.5)] })]);
  const places = (options) => {
    const layers = layersOf(duplicateRepeated(document, "main", ["dot"], options).document);
    return ["Dot", ...options.names].map((name) => [byName(layers, name).x, byName(layers, name).y]);
  };
  assert.deepEqual(places({ count: 2, layout: "line", names: ["Dot 2", "Dot 3"] }), [[100, 100], [144, 100], [188, 100]]);
  assert.deepEqual(places({ count: 3, layout: "grid", columns: 2, spacing: 30, names: ["Dot 2", "Dot 3", "Dot 4"] }),
    [[100, 100], [130, 100], [100, 130], [130, 130]]);
  assert.deepEqual(places({ count: 3, layout: "radial", radius: 50, names: ["Dot 2", "Dot 3", "Dot 4"] }),
    [[100, 100], [150, 150], [100, 200], [50, 150]], "the original sits at 12 o'clock, copies go clockwise");
  const staggered = layersOf(duplicateRepeated(document, "main", ["dot"], { count: 2, stagger: 0.25 }).document);
  assert.deepEqual(["Dot", "Dot 2", "Dot 3"].map((name) => byName(staggered, name).animations[0].start), [0.5, 0.75, 1]);
  assert.throws(() => duplicateRepeated(document, "main", ["dot"], { count: 51 }), /count must be a whole number from 1 to 50/);
  // Copies are listed in order, and counting again skips the numbers already taken.
  const once = duplicateRepeated(document, "main", ["dot"], { count: 2 }).document;
  const twice = duplicateRepeated(once, "main", ["dot"], { count: 2 }).document;
  assert.deepEqual(layersOf(once).map((layer) => layer.name), ["Dot", "Dot 2", "Dot 3"]);
  assert.deepEqual(layersOf(twice).map((layer) => layer.name), ["Dot", "Dot 4", "Dot 5", "Dot 2", "Dot 3"]);
  // A field the layout does not use is refused, not dropped.
  assert.throws(() => duplicateRepeated(document, "main", ["dot"], { count: 2, layout: "line", columns: 0 }), /columns works only with layout "grid", not "line"/);
  assert.throws(() => duplicateRepeated(document, "main", ["dot"], { count: 2, layout: "grid", offset: 10 }), /offset works only with no layout/);
  assert.throws(() => copyOffsets({ count: 1, layout: "spiral" }), /layout must be one of line, grid, radial/);
});
