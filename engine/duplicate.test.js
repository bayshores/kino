import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { worldMatrix } from "./geometry.js";
import { maskTargets, paintOrder } from "./grouping.js";
import { createMask } from "./masking.js";
import { renderSceneSvg } from "./render.js";
import { presetAnimation } from "./animation.js";
import { DUPLICATE_OFFSET, copyName, copyOffsets, duplicateRepeated, duplicateSelection } from "./duplicate.js";
import { returningDevices, returnsLine } from "./quality/returns.js";

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

test("at puts each copy of a made element at its own time, footage included, and vary steps a value per place", () => {
  const ring = createLayer("rectangle", { id: "ring", name: "Ring", parentId: "mark", width: 40, height: 40 });
  ring.animations = [{ id: "show", name: "Show", kind: "show", start: 1 }, presetAnimation("preset-grow", ring, 1)];
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "main", duration: 10, layers: [
    createLayer("group", { id: "mark", name: "Mark" }),
    ring,
    createLayer("video", { id: "clip", name: "Clip", parentId: "mark", src: "clip.mp4", mediaStart: 1, mediaDuration: 2 }),
  ] })] }));
  assert.throws(() => duplicateRepeated(document, "main", ["mark"], { at: [3, 12] }), /at 12 s is past the scene's end \(10 s\)/);
  const result = duplicateRepeated(document, "main", ["mark"], { at: [3, 6, 9], vary: { scaleX: [0.5, 2] } });
  const layers = layersOf(parseDocument(result.document));
  const rings = ["Ring", "Ring 2", "Ring 3", "Ring 4"].map((name) => byName(layers, name));
  assert.deepEqual(rings.map((layer) => layer.animations[0].start), [1, 3, 6, 9]);
  assert.deepEqual(["Clip 2", "Clip 3", "Clip 4"].map((name) => byName(layers, name).mediaStart), [3, 6, 9]);
  assert.deepEqual(["Mark", "Mark 2", "Mark 3", "Mark 4"].map((name) => byName(layers, name).scaleX), [0.5, 1, 1.5, 2]);
  assert.equal(byName(layers, "Mark 2").x, byName(layers, "Mark").x, "copies stay in place without an offset or layout");
  const devices = returningDevices(result.document.scenes[0]);
  assert.deepEqual(devices.map((device) => [device.label, device.places]), [["mark", [1, 3, 6, 9]]], "the shot inside the group is listed once, as the group");
  assert.deepEqual(devices[0].changes[0], { key: "scaleX", first: 0.5, last: 2 });
  assert.match(returnsLine(devices), /^returns: mark \(2 layers\) at 1 3 6 9 ×4 \(scaleX 0\.5 to 2\)/);
  assert.throws(() => duplicateRepeated(document, "main", ["mark"], { at: [3, 6], count: 3 }), /at lists 2 times, count says 3/);
  assert.throws(() => duplicateRepeated(document, "main", ["mark"], { at: [3], stagger: 1 }), /two timings/);
  assert.throws(() => duplicateRepeated(document, "main", ["mark"], { at: [3, 6], vary: { scaleX: [1, 2, 3, 4] } }), /or 3 values, one per place/);
  const short = parseDocument(createDocument({ scenes: [createScene({ id: "main", duration: 6, layers: [{ ...ring, parentId: null, animations: [...ring.animations, { id: "h", name: "Hide", kind: "hide", start: 3 }] }] })] }));
  const late = byName(layersOf(duplicateRepeated(short, "main", ["ring"], { at: [5] }).document), "Ring 2");
  assert.deepEqual(late.animations.map((animation) => animation.start), [5, 5, 6], "a Hide pushed past the scene's end stops at the end");
  const still = documentWith([createLayer("rectangle", { id: "bg", name: "Plate" })]);
  assert.throws(() => duplicateRepeated(still, "main", ["bg"], { at: [3] }), /give “Plate” a Show, an animation or a play time first/);
});

test("at reads the original by its Show, keeps whole-scene effects whole, and leaves a recorded move's flash on the original", () => {
  const clip = createLayer("video", { id: "s12", name: "shot", src: "clip.mp4", mediaStart: 12.28, mediaDuration: 2 });
  clip.animations = [
    { id: "a1", name: "Show", kind: "show", start: 12.28 }, { id: "a2", name: "Hide", kind: "hide", start: 13.35 },
    { id: "a3", name: "Deblock", kind: "effect", effect: "deblock", start: 0, duration: 15, easing: "linear", to: { radius: 4 } },
    { id: "a4", name: "Line mute", kind: "custom", start: 0, duration: 0.001, easing: "smooth", from: { volume: 1 }, to: { volume: 0 } },
    { id: "hit.flash", name: "Flash up", kind: "effect", effect: "color-grade", start: 12.25, duration: 0.03, easing: [0.7, 0, 0.84, 0], to: { stops: 1 } },
  ];
  const scene = createScene({ id: "main", duration: 15, layers: [clip] });
  scene.moves = [{ id: "hit", name: "impact-accent", settings: {} }];
  const document = createDocument({ scenes: [scene] });
  const plain = duplicateRepeated(document, "main", ["s12"], { at: [6.24] });
  const copy = byName(layersOf(plain.document), "shot 2");
  assert.equal(plain.first, 12.28, "the original is read at its Show, not at the custom animation at 0");
  assert.deepEqual(copy.animations.filter((a) => a.kind === "show" || a.kind === "hide").map((a) => a.start), [6.24, 7.31]);
  assert.equal(copy.mediaStart, 6.24);
  const deblock = copy.animations.find((a) => a.effect === "deblock");
  assert.deepEqual([deblock.start, deblock.duration], [0, 15], "a whole-scene effect stays whole");
  assert.equal(copy.animations.some((a) => a.name === "Flash up"), false, "a recorded move's flash stays on the original");
  assert.deepEqual(plain.report.left, ["Flash up"]);
  assert.deepEqual(plain.report.whole, ["Deblock"]);
  const withFlash = byName(layersOf(duplicateRepeated(document, "main", ["s12"], { at: [6.24], withMoves: true }).document), "shot 2");
  assert.equal(withFlash.animations.find((a) => a.name === "Flash up").start, 6.21, "withMoves copies it, moved with the Show");
  assert.throws(() => duplicateRepeated(document, "main", ["s12"], { count: 2, withMoves: true }), /withMoves is true or false and goes with at/);
  // A 7 s scene: the whole-scene effect is cut at the scene's end, and the copy's Hide pushed past it stops there.
  const short = createScene({ id: "main", duration: 7, layers: [clip] });
  const cut = duplicateRepeated(createDocument({ scenes: [short] }), "main", ["s12"], { at: [6.5] });
  assert.deepEqual(byName(layersOf(cut.document), "shot 2").animations.find((a) => a.effect === "deblock").duration, 7);
  assert.deepEqual([...cut.report.cut].sort(), ["Deblock to 7 s", "Hide to 7 s"]);
  // The report counts every copy: the last copy's Hide is cut at the end even when the first copy's is not.
  assert.deepEqual(duplicateRepeated(document, "main", ["s12"], { at: [1, 14.5] }).report.cut, ["Hide to 15 s"]);
});

test("returns: an image returns by its file, not its name, and a long run of places is cut short", () => {
  const shown = (start) => [{ id: `s${start}`, name: "Show", kind: "show", start }];
  const scene = layersOf(documentWith([
    createLayer("image", { id: "a", name: "image", src: "/m/logo.png", animations: shown(0.2) }),
    createLayer("image", { id: "b", name: "image 2", src: "/m/screen.png", animations: shown(3) }),
    createLayer("image", { id: "c", name: "image 3", src: "/m/logo.png", animations: shown(8) }),
  ]));
  assert.deepEqual(returningDevices({ layers: scene }).map((device) => [device.label, device.places]), [["image", [0.2, 8]]]);
  const many = { label: "dot", places: Array.from({ length: 12 }, (_, i) => i), changes: [] };
  assert.match(returnsLine([many]), /^returns: dot at 0 1 2 3 4 5 6 7 … \(12 places\) ·/);
});

test("returns: a group of 4 layers shown 3 times, and layers named tread-1 to tread-4, each count as one device", () => {
  let n = 0;
  const shown = (start) => [{ id: `show${n++}`, name: "Show", kind: "show", start }];
  const tread = [1, 2, 3, 4].map((i) => createLayer("rectangle", { id: `t${i}`, name: `tread-${i}`, parentId: "tread", width: 40, height: 10, animations: shown(1) }));
  const group = documentWith([createLayer("group", { id: "tread", name: "Tread" }), ...tread]);
  const copies = duplicateRepeated(group, "main", ["tread"], { at: [2, 3] }).document;
  const devices = returningDevices(copies.scenes[0]);
  assert.deepEqual(devices.map((device) => [device.label, device.places, device.layers]), [["tread", [1, 2, 3], 4]], "one device: the 12 child layers are not 12 separate things");
  assert.match(returnsLine(devices), /^returns: tread \(4 layers\) at 1 2 3 ×3 ·/);
  // Loose layers that share a stem and show one after another are one device with four places.
  const loose = [0.13, 3.5, 6, 10.95].map((start, i) => createLayer("rectangle", { id: `l${i}`, name: `tread-${i + 1}`, width: 40, height: 10, animations: shown(start) }));
  assert.match(returnsLine(returningDevices({ layers: loose })), /^returns: tread at 0\.13 3\.5 6 10\.95 ×4 ·/);
  // A line of many devices names the ones it leaves out, each with its count.
  const six = Array.from({ length: 6 }, (_, i) => ({ label: `d${i}`, places: [1, 2, 3 + i], layers: 1, changes: [] }));
  assert.match(returnsLine(six, {}, 4), /\+2 more \(d4 ×3, d5 ×3\)/);
});

test("vary rebases a grow, so each copy's grow ends at its own scale", () => {
  const dot = createLayer("ellipse", { id: "dot", name: "Dot" });
  dot.animations = [presetAnimation("preset-grow", dot, 1)];
  const result = duplicateRepeated(documentWith([dot]), "main", ["dot"], { at: [2], vary: { scaleX: [0.5, 1.5], scaleY: [0.5, 1.5] } });
  const layers = layersOf(result.document);
  for (const layer of layers) assert.equal(layer.animations[0].to.scaleX, layer.scaleX);
  assert.deepEqual(layers.map((layer) => layer.scaleX).sort(), [0.5, 1.5]);
});
