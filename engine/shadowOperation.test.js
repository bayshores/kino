// The Shadow animation (preset "shadow") through every editing path: the preset, evaluation, the
// SVG renderer the canvas and raster exports share, apply_operations, the clipboard, Duplicate,
// and a saved document.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { PRESETS, evaluateLayer, presetAnimation } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { applyOperations } from "./operations.js";
import { copyAnimation, copyLayers, pasteAnimations, pasteLayers } from "./layerClipboard.js";
import { duplicateSelection } from "./duplicate.js";
import { renderSceneSvg } from "./render.js";
import { DEFAULT_SHADOW, withShadowAlpha } from "./shadowInterpolation.js";

const SOFT = { color: "#000000", x: 0, y: 4, blur: 8 };
const LIFTED = { color: "#3366ff80", x: 12, y: 24, blur: 40 };

function documentWith(layers, duration = 4) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 100, height: 60, duration, layers })] }));
}

const layerOf = (document, id) => document.scenes[0].layers.find((layer) => layer.id === id);

function linearShadow(from, to, extra = {}) {
  return { id: "shadow", name: "Shadow", kind: "custom", start: 0, duration: 1, easing: "linear", from: { shadow: from }, to: { shadow: to }, unit: "layer", stagger: 0, order: "forward", ...extra };
}

// The actual SVG filter values, including the separately encoded flood alpha.
function dropShadowsAt(scene, time) {
  return [...renderSceneSvg(scene, time).matchAll(/<filter\b[^>]*>([\s\S]*?)<\/filter>/g)]
    .filter((match) => match[1].includes('result="shadow-color"'))
    .map((match) => {
      const attribute = (tag, name) => match[1].match(new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`))?.[1];
      return { dx: Number(attribute("feOffset", "dx")), dy: Number(attribute("feOffset", "dy")),
        stdDeviation: Number(attribute("feGaussianBlur", "stdDeviation")),
        color: withShadowAlpha(attribute("feFlood", "flood-color"), Number(attribute("feFlood", "flood-opacity"))) };
    });
}
const dropShadowAt = (scene, time) => dropShadowsAt(scene, time)[0] ?? null;

test("the Shadow preset is a Custom animation that starts from the layer's own shadow", () => {
  assert.deepEqual(PRESETS.find((preset) => preset.id === "shadow"), { id: "shadow", name: "Shadow", kind: "custom" });
  for (const type of ["rectangle", "ellipse", "star", "path", "text", "image", "video", "group", "component"]) {
    const animation = presetAnimation("shadow", createLayer(type), 0.25);
    assert.deepEqual([animation.name, animation.kind, animation.start, animation.duration], ["Shadow", "custom", 0.25, 0.6], type);
    assert.deepEqual(animation.from, { shadow: null }, `${type}: no shadow yet, so it appears`);
    assert.deepEqual(animation.to, { shadow: DEFAULT_SHADOW });
  }
  const lifted = presetAnimation("shadow", createLayer("rectangle", { shadow: SOFT }), 0);
  assert.deepEqual(lifted.from, { shadow: SOFT });
  assert.deepEqual(lifted.to, { shadow: { color: "#000000", x: 0, y: 8, blur: 16 } });
  assert.throws(() => presetAnimation("shadow", createLayer("audio"), 0), /Shadow preset requires a layer that is drawn/);
});

test("a Shadow animation mixes every part over time and holds the end", () => {
  const box = createLayer("rectangle", { id: "box", shadow: SOFT, animations: [linearShadow(SOFT, LIFTED)] });
  assert.deepEqual(evaluateLayer(box, 0).shadow, SOFT);
  assert.deepEqual(evaluateLayer(box, 0.25).shadow, { color: "#0d1a40df", x: 3, y: 9, blur: 16 });
  assert.deepEqual(evaluateLayer(box, 0.5).shadow, { color: "#1a3380c0", x: 6, y: 14, blur: 24 });
  assert.deepEqual(evaluateLayer(box, 1).shadow, LIFTED);
  assert.deepEqual(evaluateLayer(box, 3).shadow, LIFTED, "the end shadow holds after the animation");
  assert.deepEqual(box.shadow, SOFT, "evaluating never changes the stored layer");
});

test("a Shadow animation from or to no shadow fades in place", () => {
  const appear = createLayer("ellipse", { id: "dot", animations: [linearShadow(null, LIFTED, { start: 1 })] });
  assert.equal(evaluateLayer(appear, 0).shadow, null, "no shadow before it starts");
  assert.equal(evaluateLayer(appear, 1).shadow, null);
  assert.deepEqual(evaluateLayer(appear, 1.5).shadow, { color: "#3366ff40", x: 12, y: 24, blur: 40 });
  assert.deepEqual(evaluateLayer(appear, 2).shadow, LIFTED);

  const vanish = createLayer("ellipse", { id: "dot", shadow: LIFTED, animations: [linearShadow(LIFTED, null)] });
  assert.deepEqual(evaluateLayer(vanish, 0.5).shadow, { color: "#3366ff40", x: 12, y: 24, blur: 40 });
  assert.equal(evaluateLayer(vanish, 1).shadow, null);
  assert.equal(evaluateLayer(vanish, 2).shadow, null);

  const nothing = createLayer("ellipse", { id: "dot", animations: [linearShadow(null, null)] });
  for (const time of [0, 0.5, 1]) assert.equal(evaluateLayer(nothing, time).shadow, null);
});

test("an In Shadow animation uses its From before it starts, and two animations chain", () => {
  const into = createLayer("rectangle", { id: "box", shadow: LIFTED, animations: [linearShadow(null, LIFTED, { kind: "in", start: 1 })] });
  assert.equal(evaluateLayer(into, 0).shadow, null, "an In animation shows its From before it starts");
  assert.deepEqual(evaluateLayer(into, 2).shadow, LIFTED);

  const chained = createLayer("rectangle", {
    id: "box",
    animations: [
      linearShadow(null, SOFT, { id: "first" }),
      linearShadow(SOFT, LIFTED, { id: "second", start: 2 }),
    ],
  });
  assert.deepEqual(evaluateLayer(chained, 1.5).shadow, SOFT, "the first end holds until the second starts");
  assert.deepEqual(evaluateLayer(chained, 2.5).shadow, { color: "#1a3380c0", x: 6, y: 14, blur: 24 });
  assert.deepEqual(evaluateLayer(chained, 3).shadow, LIFTED);
});

test("the renderer draws the animated shadow at every time", () => {
  const scene = documentWith([
    createLayer("rectangle", { id: "box", width: 40, height: 20, animations: [linearShadow(null, LIFTED)] }),
  ]).scenes[0];
  assert.equal(dropShadowAt(scene, 0), null, "no shadow at the start");
  assert.deepEqual(dropShadowAt(scene, 0.25), { dx: 12, dy: 24, stdDeviation: 20, color: "#3366ff20" });
  assert.deepEqual(dropShadowAt(scene, 0.5), { dx: 12, dy: 24, stdDeviation: 20, color: "#3366ff40" });
  assert.deepEqual(dropShadowAt(scene, 1), { dx: 12, dy: 24, stdDeviation: 20, color: "#3366ff80" });

  const moving = documentWith([
    createLayer("text", { id: "words", text: "Hi", shadow: SOFT, animations: [linearShadow(SOFT, LIFTED)] }),
  ]).scenes[0];
  assert.deepEqual(dropShadowAt(moving, 0), { dx: 0, dy: 4, stdDeviation: 4, color: "#000000" });
  assert.deepEqual(dropShadowAt(moving, 0.5), { dx: 6, dy: 14, stdDeviation: 12, color: "#1a3380c0" });
  assert.deepEqual(dropShadowAt(moving, 2), { dx: 12, dy: 24, stdDeviation: 20, color: "#3366ff80" });
});

test("apply_operations adds a Shadow preset, sets any shadow or none, and refuses what it cannot draw", () => {
  const source = documentWith([createLayer("star", { id: "star" }), createLayer("audio", { id: "sound" })]);
  const added = applyOperations(source, [
    { type: "add_animation", sceneId: "main", layerId: "star", preset: "shadow", start: 0.5 },
  ]);
  const animation = layerOf(added, "star").animations[0];
  assert.deepEqual([animation.name, animation.start, animation.from, animation.to], ["Shadow", 0.5, { shadow: null }, { shadow: DEFAULT_SHADOW }]);

  const update = (shadow) => [{ type: "update_animation", sceneId: "main", layerId: "star", animationId: animation.id, properties: { to: { shadow } } }];
  assert.deepEqual(layerOf(applyOperations(added, update(LIFTED)), "star").animations[0].to.shadow, LIFTED);
  assert.equal(layerOf(applyOperations(added, update(null)), "star").animations[0].to.shadow, null);
  assert.deepEqual(
    layerOf(applyOperations(added, update({ ...LIFTED, spread: 3 })), "star").animations[0].to.shadow,
    LIFTED,
    "only color, x, y and blur are kept",
  );
  assert.throws(() => applyOperations(added, update({ ...LIFTED, color: "red" })), /to\.shadow\.color: must be a hex color/);
  assert.throws(() => applyOperations(added, update({ ...LIFTED, blur: -1 })), /to\.shadow\.blur/);
  assert.throws(() => applyOperations(added, update({ ...LIFTED, x: "10" })), /to\.shadow\.x/);
  assert.throws(() => applyOperations(added, update("#000000")), /to\.shadow/);

  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "sound", preset: "shadow" }]),
    /Shadow preset requires a layer that is drawn/);
  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "sound", animation: linearShadow(null, LIFTED) }]),
    /a Shadow animation needs a layer that is drawn; audio layers have no shadow/);
});

test("a Shadow animation is not offered as compatible on audio", () => {
  assert.equal(isAnimationCompatible(createLayer("rectangle"), linearShadow(null, LIFTED)), true);
  assert.equal(isAnimationCompatible(createLayer("audio"), linearShadow(null, LIFTED)), false);
});

test("copying, pasting and duplicating keep a Shadow animation's shadows", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "box", shadow: SOFT, animations: [linearShadow(SOFT, LIFTED)] }),
    createLayer("image", { id: "picture", x: 50 }),
    createLayer("audio", { id: "sound" }),
  ]);
  const envelope = JSON.parse(JSON.stringify(copyAnimation(document, "main", "box", "shadow")));
  const { document: pasted, skipped } = pasteAnimations(document, "main", ["picture", "sound"], envelope, 1);
  const copy = layerOf(pasted, "picture").animations[0];
  assert.deepEqual([copy.start, copy.from.shadow, copy.to.shadow], [1, SOFT, LIFTED], "shadows are not moved with the layer's position");
  assert.deepEqual(skipped.map(({ layerId }) => layerId), ["sound"], "audio has no shadow to animate");

  const { document: layerPasted } = pasteLayers(document, "main", copyLayers(document, "main", ["box"]));
  const pastedBox = layerPasted.scenes[0].layers.find((layer) => !["box", "picture", "sound"].includes(layer.id));
  assert.deepEqual(pastedBox.animations[0].to.shadow, LIFTED);

  const { document: duplicated, rootIds } = duplicateSelection(document, "main", ["box"]);
  const duplicate = layerOf(parseDocument(duplicated), rootIds[0]);
  assert.deepEqual(evaluateLayer(duplicate, 0.5).shadow, evaluateLayer(layerOf(document, "box"), 0.5).shadow);
});

test("a saved document keeps Shadow animations, and a missing end is the layer's shadow", () => {
  const document = documentWith([
    createLayer("ellipse", { id: "dot", shadow: SOFT, animations: [{ ...linearShadow(null, LIFTED), from: {} }] }),
    createLayer("ellipse", { id: "plain", animations: [{ ...linearShadow(null, LIFTED, { id: "fade" }), from: {} }] }),
  ]);
  assert.deepEqual(layerOf(document, "dot").animations[0].from, { shadow: SOFT });
  assert.deepEqual(layerOf(document, "plain").animations[0].from, { shadow: null });
  const reloaded = parseDocument(JSON.parse(JSON.stringify(document)));
  assert.deepEqual(layerOf(reloaded, "dot").animations[0], layerOf(document, "dot").animations[0]);
  assert.deepEqual(evaluateLayer(layerOf(reloaded, "plain"), 0.5).shadow, { color: "#3366ff40", x: 12, y: 24, blur: 40 });
});

test("a Shadow animation by letters staggers each letter's shadow, and a group's shadow animates", () => {
  const shadow = { color: "#ff000080", x: 0, y: 4, blur: 8 };
  const scene = documentWith([
    createLayer("text", { id: "words", text: "Hi", animations: [{ ...linearShadow(null, shadow), unit: "letters", stagger: 0.5 }] }),
    createLayer("group", { id: "group", animations: [linearShadow(null, shadow, { id: "group-shadow" })] }),
    createLayer("rectangle", { id: "inside", parentId: "group" }),
  ]).scenes[0];
  const colors = (time) => dropShadowsAt(scene, time).map((shadow) => shadow.color);
  assert.deepEqual(colors(0.75), ["#ff000060", "#ff000020", "#ff000060"], "H, then i half a second later, then the group");
  assert.deepEqual(colors(2), ["#ff000080", "#ff000080", "#ff000080"]);
});

test("the Shadow preset keeps To within the saved limits on a layer with a very large shadow", () => {
  // A layer may have a blur up to 10000 and an offset up to 1,000,000 px; doubling them must not
  // give a To that the model then refuses to save.
  const big = { color: "#000000", x: 600_000, y: -700_000, blur: 6000 };
  const source = documentWith([createLayer("rectangle", { id: "big", shadow: big })]);
  const animation = presetAnimation("shadow", layerOf(source, "big"), 0);
  assert.deepEqual(animation.to.shadow, { color: "#000000", x: 1_000_000, y: -1_000_000, blur: 10_000 });
  const added = applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "big", preset: "shadow" }]);
  assert.deepEqual(layerOf(added, "big").animations[0].to.shadow, animation.to.shadow);
  assert.doesNotThrow(() => parseDocument(JSON.parse(JSON.stringify(added))), "the saved document is accepted");
});
