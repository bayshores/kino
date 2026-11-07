// The Color animation (preset "color") through every editing path: the preset, evaluation, the
// SVG renderer the canvas and raster exports share, apply_operations, the clipboard and Duplicate.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { PRESETS, evaluateLayer, presetAnimation } from "./animation.js";
import { applyOperations } from "./operations.js";
import { copyAnimation, copyLayers, pasteAnimations, pasteLayers } from "./layerClipboard.js";
import { duplicateSelection } from "./duplicate.js";
import { FILL_LAYER_TYPES, isFillEnabled } from "./paints.js";
import { renderSceneSvg } from "./render.js";

const GRADIENT = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };

function documentWith(layers, duration = 4) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 100, height: 60, duration, layers })] }));
}

const layerOf = (document, id) => document.scenes[0].layers.find((layer) => layer.id === id);

function linearColor(layer, from, to) {
  return { id: "color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: from }, to: { fill: to }, unit: "layer", stagger: 0, order: "forward", ...layer };
}

test("the Color preset is offered with the Custom animations and starts from the layer's own fill", () => {
  assert.deepEqual(PRESETS.find((preset) => preset.id === "color"), { id: "color", name: "Color", kind: "custom" });
  for (const type of FILL_LAYER_TYPES) {
    const layer = createLayer(type, { fill: "#ff0000" });
    const animation = presetAnimation("color", layer, 0.25);
    assert.equal(animation.name, "Color");
    assert.equal(animation.start, 0.25);
    assert.equal(animation.duration, 0.6);
    assert.deepEqual(animation.from, { fill: "#ff0000" });
    assert.deepEqual(animation.to, { fill: "#00ffff" }, `${type}: To is a visibly different color`);
  }
  const gradientLayer = createLayer("text", { fill: GRADIENT });
  const fromGradient = presetAnimation("color", gradientLayer, 0);
  assert.deepEqual(fromGradient.from.fill, GRADIENT);
  assert.notEqual(fromGradient.from.fill, gradientLayer.fill, "From is a copy of the layer's gradient");
  assert.equal(fromGradient.to.fill.type, "linear");
  assert.deepEqual(fromGradient.to.fill.stops.map((stop) => stop.color), ["#00ffff", "#ffff00"]);
  for (const type of ["image", "video", "audio"])
    assert.throws(() => presetAnimation("color", createLayer(type), 0), /Color preset requires a rectangle, ellipse, star, path, text, or group layer/);
});

test("a Color animation mixes the fill over time and the renderer draws the mixed gradient", () => {
  const box = createLayer("rectangle", { id: "box", width: 40, height: 20, fill: "#00ff00", animations: [linearColor({}, "#00ff00", GRADIENT)] });
  assert.equal(evaluateLayer(box, 0).fill, "#00ff00");
  assert.deepEqual(evaluateLayer(box, 0.5).fill, {
    type: "linear", angle: 0, stops: [{ offset: 0, color: "#808000" }, { offset: 1, color: "#008080" }],
  });
  assert.deepEqual(evaluateLayer(box, 1).fill, GRADIENT);
  assert.deepEqual(evaluateLayer(box, 3).fill, GRADIENT, "the end paint holds after the animation");

  const scene = documentWith([box]).scenes[0];
  const svg = renderSceneSvg(scene, 0.5);
  assert.match(svg, /<linearGradient[^>]*>/);
  assert.match(svg, /stop-color="#808000"/);
  assert.match(svg, /stop-color="#008080"/);
  assert.doesNotMatch(renderSceneSvg(scene, 0), /<linearGradient/, "the start is the solid color");
});

test("a Color animation never turns a disabled Fill on", () => {
  const box = createLayer("rectangle", { id: "box", fillEnabled: false, fill: "#00ff00", animations: [linearColor({}, "#00ff00", GRADIENT)] });
  for (const time of [0, 0.5, 1]) assert.equal(isFillEnabled(evaluateLayer(box, time)), false);
  const scene = documentWith([box]).scenes[0];
  for (const time of [0, 0.5, 1]) {
    const svg = renderSceneSvg(scene, time);
    assert.doesNotMatch(svg, /Gradient|#00ff00|#808000/, `nothing of the fill is drawn at ${time} s`);
  }
});

test("apply_operations adds a Color preset, sets any paint, and refuses paints it cannot draw", () => {
  const source = documentWith([createLayer("ellipse", { id: "dot", fill: "#ff0000" }), createLayer("image", { id: "picture" })]);
  const added = applyOperations(source, [
    { type: "add_animation", sceneId: "main", layerId: "dot", preset: "color", start: 0.5 },
  ]);
  const animation = layerOf(added, "dot").animations[0];
  assert.deepEqual([animation.name, animation.from, animation.to], ["Color", { fill: "#ff0000" }, { fill: "#00ffff" }]);

  const radial = { type: "radial", angle: 0, stops: [{ offset: 0, color: "#ffffff80" }, { offset: 0.4, color: "#000" }, { offset: 1, color: "#123456" }] };
  const updated = applyOperations(added, [
    { type: "update_animation", sceneId: "main", layerId: "dot", animationId: animation.id, properties: { to: { fill: radial } } },
  ]);
  assert.deepEqual(layerOf(updated, "dot").animations[0].to.fill, radial);

  const update = (fill) => [{ type: "update_animation", sceneId: "main", layerId: "dot", animationId: animation.id, properties: { to: { fill } } }];
  assert.throws(() => applyOperations(added, update("red")), /must be a hex color/);
  assert.throws(() => applyOperations(added, update({ type: "conic", angle: 0, stops: GRADIENT.stops })), /must be linear or radial/);
  // A radial gradient has no direction: its angle may be left out (0). A linear one needs it.
  const { angle: _unused, ...noAngle } = radial;
  assert.equal(layerOf(applyOperations(added, update(noAngle)), "dot").animations[0].to.fill.angle, 0);
  assert.throws(() => applyOperations(added, update({ ...noAngle, type: "linear" })), /angle: must be a finite number/);
  assert.throws(() => applyOperations(added, update({ ...GRADIENT, stops: [GRADIENT.stops[0]] })), /at least two color stops/);
  assert.throws(() => applyOperations(added, update({ ...GRADIENT, stops: [...GRADIENT.stops].reverse() })), /ordered by offset/);
  assert.throws(() => applyOperations(added, update({ ...GRADIENT, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1.5, color: "#0000ff" }] })), /offset/);

  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "picture", preset: "color" }]),
    /Color preset requires a rectangle, ellipse, star, path, text, or group layer/);
  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "picture", animation: linearColor({}, "#000000", GRADIENT) }]),
    /A Color \(fill\) animation needs a rectangle, ellipse, star, path, text, group layer; image layer picture has no Fill/);
});

test("every path that stores an animation refuses a Color animation on a layer without a Fill", () => {
  const source = documentWith([createLayer("rectangle", { id: "box" }), createLayer("image", { id: "folder" })]);
  const noFill = /A Color \(fill\) animation needs a rectangle, ellipse, star, path, text, group layer; (image|video|audio|component) layer \w+ has no Fill/;
  for (const type of ["image", "video", "audio"]) {
    assert.throws(() => applyOperations(source, [
      { type: "add_layer", sceneId: "main", layerType: type, properties: { id: "other", animations: [linearColor({ id: "c1" }, "#ff0000", "#0000ff")] } },
    ]), noFill, `add_layer ${type}`);
  }
  assert.throws(() => applyOperations(source, [
    { type: "update_layer", sceneId: "main", layerId: "folder", properties: { animations: [linearColor({ id: "c1" }, "#ff0000", GRADIENT)] } },
  ]), noFill, "update_layer on an image");
  // A fill on only one side is still a fill animation.
  assert.throws(() => applyOperations(source, [
    { type: "update_layer", sceneId: "main", layerId: "folder", properties: { animations: [{ ...linearColor({ id: "c1" }, "#ff0000", "#0000ff"), from: { opacity: 0, fill: "#ff0000" }, to: { opacity: 1 } }] } },
  ]), noFill, "a mixed opacity and fill animation on an image");
  // The same animation on a layer with a Fill is still accepted.
  const kept = applyOperations(source, [
    { type: "update_layer", sceneId: "main", layerId: "box", properties: { animations: [linearColor({ id: "c1" }, "#ff0000", GRADIENT)] } },
  ]);
  assert.deepEqual(layerOf(kept, "box").animations[0].to.fill, GRADIENT);
});

test("copying, pasting and duplicating keep a Color animation's paints", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "box", fill: "#00ff00", animations: [linearColor({}, "#00ff00", GRADIENT)] }),
    createLayer("text", { id: "words", text: "Hi" }),
    createLayer("image", { id: "picture" }),
  ]);
  const envelope = JSON.parse(JSON.stringify(copyAnimation(document, "main", "box", "color")));
  const { document: pasted, skipped } = pasteAnimations(document, "main", ["words", "picture"], envelope, 1);
  const copy = layerOf(pasted, "words").animations[0];
  assert.deepEqual([copy.start, copy.from.fill, copy.to.fill], [1, "#00ff00", GRADIENT]);
  assert.deepEqual(skipped.map(({ layerId, reason }) => [layerId, reason]), [["picture", "Paste a Color animation onto a shape, path, text, or group layer."]]);

  const { document: layerPasted } = pasteLayers(document, "main", copyLayers(document, "main", ["box"]));
  const pastedBox = layerPasted.scenes[0].layers.find((layer) => !["box", "words", "picture"].includes(layer.id));
  assert.deepEqual(pastedBox.animations[0].to.fill, GRADIENT);

  const { document: duplicated, rootIds } = duplicateSelection(document, "main", ["box"]);
  const duplicate = layerOf(parseDocument(duplicated), rootIds[0]);
  assert.deepEqual(evaluateLayer(duplicate, 0.5).fill, evaluateLayer(layerOf(document, "box"), 0.5).fill);
});

test("a saved document keeps Color animations of every paint kind", () => {
  const document = documentWith([
    createLayer("star", { id: "star", animations: [linearColor({}, GRADIENT, { ...GRADIENT, type: "radial" })] }),
  ]);
  const reloaded = parseDocument(JSON.parse(JSON.stringify(document)));
  assert.deepEqual(layerOf(reloaded, "star").animations[0].to.fill, { ...GRADIENT, type: "radial" });
  assert.equal(evaluateLayer(layerOf(reloaded, "star"), 0.75).fill.type, "radial");
});

// Older versions accepted a Color animation on any layer (an MCP add_animation on a group, for
// example). Such a document must still open, and every edit, save and export must still work.
test("a saved document with an older Color animation on a group still opens, edits and draws", () => {
  const saved = JSON.parse(JSON.stringify(documentWith([
    createLayer("group", { id: "g1", x: 0, y: 0, width: 40, height: 20 }),
    createLayer("rectangle", { id: "r1", parentId: "g1", x: 0, y: 0, width: 40, height: 20, fill: "#123456" }),
  ])));
  saved.version = 3;
  saved.scenes[0].layers[0].fillEnabled = true;
  saved.scenes[0].layers[0].animations = [{ id: "a1", name: "Fill", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#00ff00" } }];
  const opened = parseDocument(saved);
  assert.deepEqual(layerOf(opened, "g1").animations[0].to, { fill: "#00ff00" });

  // An edit to a different layer works, and so do the animation's own name and timing.
  const renamed = applyOperations(opened, [{ type: "update_layer", sceneId: "main", layerId: "r1", properties: { name: "Renamed" } }]);
  assert.equal(layerOf(renamed, "r1").name, "Renamed");
  const retimed = applyOperations(renamed, [
    { type: "update_animation", sceneId: "main", layerId: "g1", animationId: "a1", properties: { name: "Old fill", start: 0.5, easing: "ease-in" } },
    { type: "update_animations", sceneId: "main", animationIds: ["a1"], properties: { duration: 2 } },
  ]);
  // update_layer may set the whole list again when the older animation keeps its fill values.
  const listed = applyOperations(retimed, [
    { type: "update_layer", sceneId: "main", layerId: "g1", properties: { name: "Folder", animations: structuredClone(layerOf(retimed, "g1").animations) } },
  ]);
  assert.deepEqual(
    [layerOf(listed, "g1").name, ...["name", "start", "duration", "easing"].map((key) => layerOf(listed, "g1").animations[0][key])],
    ["Folder", "Old fill", 0.5, 2, "ease-in"],
  );
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(retimed))).scenes[0].layers[0].animations[0].from, { fill: "#ff0000" }, "it saves and reopens");

  // Groups now support Color edits, but editing an animation does not turn the legacy fill on.
  const recolored = applyOperations(retimed, [
    { type: "update_animation", sceneId: "main", layerId: "g1", animationId: "a1", properties: { to: { fill: "#0000ff" } } },
    { type: "update_animations", sceneId: "main", animationIds: ["a1"], properties: { from: { fill: "#0000ff" } } },
    { type: "update_layer", sceneId: "main", layerId: "g1", properties: { animations: [...layerOf(retimed, "g1").animations, linearColor({ id: "c2" }, "#000000", "#ffffff")] } },
  ]);
  assert.equal(layerOf(recolored, "g1").animations.length, 2);
  assert.equal(isFillEnabled(evaluateLayer(layerOf(recolored, "g1"), 1)), false);
  // Taking the fill out of it is an edit like any other.
  const opacity = applyOperations(retimed, [
    { type: "update_animation", sceneId: "main", layerId: "g1", animationId: "a1", properties: { from: { opacity: 0 }, to: { opacity: 1 } } },
  ]);
  assert.deepEqual(layerOf(opacity, "g1").animations[0].to, { opacity: 1 });

  // The migrated group's inactive Fill changes nothing on the canvas or in raster exports.
  const scene = retimed.scenes[0];
  const still = renderSceneSvg({ ...scene, layers: scene.layers.map((layer) => ({ ...layer, animations: [] })) }, 1.5);
  assert.equal(renderSceneSvg(scene, 1.5), still);
  assert.match(renderSceneSvg(scene, 1.5), /#123456/);
  assert.doesNotMatch(renderSceneSvg(scene, 1.5), /#ff0000|#00ff00/);

  // Copying the group keeps its animations, and Duplicate does too.
  const { document: layerPasted } = pasteLayers(retimed, "main", copyLayers(retimed, "main", ["g1"]));
  assert.equal(layerPasted.scenes[0].layers.filter((layer) => layer.type === "group").length, 2);
  const { document: duplicated } = duplicateSelection(retimed, "main", ["g1"]);
  assert.equal(parseDocument(duplicated).scenes[0].layers.filter((layer) => layer.animations.some((item) => item.from.fill)).length, 2);
});
