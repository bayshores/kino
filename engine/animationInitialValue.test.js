import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { evaluateLayer, presetAnimation, resolveAnimationInitialValue, resolveInitialAnimations } from "./animation.js";
import { composeAnimations, duplicateAnimations, ungroupAnimations } from "./animationComposition.js";
import { editSceneAnimations } from "./sceneAnimationEdit.js";
import { copyAnimations, pasteAnimations } from "./layerClipboard.js";
import { canUseCurrentInitialValue, usesCurrentInitialValue } from "./animationInitialValue.js";

const operation = (id, start, duration, from, to, extra = {}) => ({ id, name: id, kind: "custom", start, duration, easing: "linear", from, to, ...extra });
const documentOf = (layer) => createDocument({ id: "initial-values", scenes: [createScene({ id: "main", duration: 10, layers: [layer] })] });
const layerOf = (document) => document.scenes[0].layers[0];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("automatic starts are opt-in in documents and keep remembered explicit From values", () => {
  const source = documentOf(createLayer("rectangle", { id: "card", x: 50, animations: [
    operation("move", 1, 1, { x: 10 }, { x: 100 }),
  ] }));
  const old = parseDocument(source), animation = layerOf(old).animations[0];
  assert.equal(canUseCurrentInitialValue(animation), true);
  assert.equal(usesCurrentInitialValue(animation), false);
  const automatic = editSceneAnimations(old, "main", [{ layerId: "card", animationId: "move", patch: { fromCurrent: true } }]);
  assert.deepEqual(layerOf(automatic).animations[0].from, { x: 10 });
  assert.equal(evaluateLayer(layerOf(automatic), 1).x, 50);
  const explicit = editSceneAnimations(automatic, "main", [{ layerId: "card", animationId: "move", patch: { fromCurrent: null } }]);
  assert.deepEqual(explicit, old);
  assert.equal(evaluateLayer(layerOf(explicit), 1).x, 10);
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(automatic))), automatic);
  for (const fromCurrent of ["true", 1, [], {}]) {
    const bad = structuredClone(old); layerOf(bad).animations[0].fromCurrent = fromCurrent;
    assert.throws(() => parseDocument(bad), /fromCurrent/);
  }
  for (const kind of ["in", "out", "hide", "show", "counter", "change-text"]) {
    const bad = structuredClone(old); Object.assign(layerOf(bad).animations[0], { kind, fromCurrent: true });
    assert.throws(() => parseDocument(bad), /fromCurrent/);
  }
});

test("existing catalog endpoint definitions and legacy text spacing representation stay unchanged", () => {
  const card = createLayer("rectangle"), text = createLayer("text", { text: "Text" });
  for (const id of ["move", "rotate", "scale", "resize", "opacity", "color", "shadow", "blur", "stroke", "corners"])
    assert.equal(presetAnimation(id, card).fromCurrent, undefined, id);
  for (const id of ["letter-spacing", "line-height", "change-text", "counter"])
    assert.equal(presetAnimation(id, { ...text, text: "10" }).fromCurrent, undefined, id);
  assert.equal(presetAnimation("fade-in", card).fromCurrent, undefined);
});

test("overlapping operations freeze the earlier value at their start and refresh after earlier edits", () => {
  const layer = createLayer("rectangle", { x: 0, animations: [
    operation("first", 0, 2, { x: 0 }, { x: 40 }),
    operation("second", 1, 1, { x: -90 }, { x: 80 }, { fromCurrent: true }),
  ] });
  const original = structuredClone(layer);
  for (const [time, expected] of [[0.5, 10], [1, 20], [1.5, 50], [2, 80], [3, 80]]) near(evaluateLayer(layer, time).x, expected);
  assert.deepEqual(layer, original);
  layer.animations[0].to.x = 80;
  near(evaluateLayer(layer, 1.5).x, 60);
  layer.animations[0].enabled = false;
  near(evaluateLayer(layer, 1.5).x, 40);
});

test("partial Shadow channels use the frozen initial value and preserve other current channels", () => {
  const rest = { color: "#ff000080", x: 0, y: 4, blur: 4 };
  const layer = createLayer("rectangle", { shadow: rest, animations: [
    operation("first-x", 0, 2, { shadow: rest }, { shadow: { ...rest, x: 40 } }, { shadowChannels: ["x"] }),
    operation("color", 0, 2, { shadow: rest }, { shadow: { ...rest, color: "#0000ff80" } }, { shadowChannels: ["color"] }),
    operation("next-x", 1, 1, { shadow: { ...rest, x: -10 } }, { shadow: { ...rest, x: 80 } }, { shadowChannels: ["x"], fromCurrent: true }),
  ] });
  assert.deepEqual(evaluateLayer(layer, 1.5).shadow, { color: "#4000bf80", x: 50, y: 4, blur: 4 });
  const grouped = composeAnimations(parseDocument(documentOf(layer)), "main", ["first-x", "color", "next-x"]);
  assert.deepEqual(evaluateLayer(layerOf(grouped.document), 1.5).shadow, evaluateLayer(layer, 1.5).shadow);
  const duplicated = duplicateAnimations(grouped.document, "main", grouped.animationIds);
  const ungrouped = ungroupAnimations(duplicated.document, "main", duplicated.animationIds);
  assert.ok(layerOf(ungrouped.document).animations.some((item) => item.fromCurrent));
});

test("each text unit samples its own staggered start", () => {
  const layer = createLayer("text", { text: "ABC", x: 0, animations: [
    operation("first", 0, 2, { x: 0 }, { x: 40 }),
    operation("letters", 1, 1, { x: -1 }, { x: 100 }, { fromCurrent: true, unit: "letters", stagger: 0.25 }),
  ] });
  near(evaluateLayer(layer, 1.5, { unit: "letters", unitIndex: 0, unitCount: 3 }).x, 60);
  near(evaluateLayer(layer, 1.5, { unit: "letters", unitIndex: 1, unitCount: 3 }).x, 43.75);
  near(evaluateLayer(layer, 1.5, { unit: "letters", unitIndex: 2, unitCount: 3 }).x, 30);
});

test("automatic motion paths use the sampled start and anchored Resize is added once", () => {
  const layer = createLayer("rectangle", { x: 0, y: 0, width: 20, height: 20, animations: [
    operation("first", 0, 1, { x: 0 }, { x: 100 }),
    operation("curved", 1, 1, { x: 0, y: 0 }, { x: 300, y: 0 }, { fromCurrent: true,
      motionPath: { points: [{ x: 200, y: 0, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } }], bezierControls: false, alignToPath: false } }),
  ] });
  near(evaluateLayer(layer, 1).x, 100);
  near(evaluateLayer(layer, 1.5).x, 200);
  layer.animations = [
    operation("resize", 0, 2, { width: 20 }, { width: 120 }, { anchor: "center" }),
    operation("move", 1, 1, { x: -90 }, { x: 100 }, { fromCurrent: true }),
  ];
  near(evaluateLayer(layer, 1.5).x, 12.5);
});

test("current paint starts and same-start ordering remain deterministic", () => {
  const layer = createLayer("rectangle", { fill: "#ff0000", x: 0, animations: [
    operation("first", 0, 1, { fill: "#ff0000" }, { fill: "#0000ff" }),
    operation("second", 1, 1, { fill: "#ff0000" }, { fill: "#00ff00" }, { fromCurrent: true }),
  ] });
  assert.equal(evaluateLayer(layer, 1).fill, "#0000ff");
  assert.equal(evaluateLayer(layer, 1.5).fill, "#008080");
  layer.animations = [operation("first", 1, 1, { x: 10 }, { x: 50 }), operation("second", 1, 1, { x: -1 }, { x: 100 }, { fromCurrent: true })];
  near(evaluateLayer(layer, 1.5).x, 55);
});

test("copying keeps automatic mode and resolves against the destination's preceding operations", () => {
  const source = parseDocument(documentOf(createLayer("rectangle", { id: "source", x: 0, animations: [
    operation("auto", 1, 1, { x: 0 }, { x: 100 }, { fromCurrent: true }),
  ] })));
  source.scenes[0].layers.push(createLayer("rectangle", { id: "target", x: 300, animations: [
    operation("preceding", 0, 1, { x: 300 }, { x: 350 }),
  ] }));
  const envelope = copyAnimations(source, "main", ["auto"]);
  const result = pasteAnimations(source, "main", ["target"], envelope, 1);
  const target = result.document.scenes[0].layers[1];
  assert.equal(target.animations[1].fromCurrent, true);
  assert.deepEqual(target.animations[1].from, { x: 300 });
  near(evaluateLayer(target, 1.5).x, 375);
});

test("automatic reveal and corner radii start at effective design defaults, not remembered values", () => {
  const layer = createLayer("rectangle", { radius: 8, cornerRadii: null, animations: [
    operation("corners", 0, 1, { cornerRadii: [0, 0, 0, 0] }, { cornerRadii: [20, 20, 20, 20] }, { fromCurrent: true }),
    operation("reveal", 0, 1, { reveal: { progress: 0, direction: "up", softness: 0 } },
      { reveal: { progress: 0, direction: "up", softness: 0 } }, { fromCurrent: true }),
  ] });
  const middle = evaluateLayer(layer, 0.5);
  assert.deepEqual(middle.cornerRadii, [14, 14, 14, 14]);
  near(middle.reveal.progress, 0.5);
});

test("ephemeral resolvers use full original history without overwriting saved From", () => {
  const layer = createLayer("rectangle", { x: 0, y: 0, animations: [
    operation("first", 0, 1, { x: 0 }, { x: 100 }),
    operation("auto", 1, 1, { x: -100 }, { x: 300 }, { fromCurrent: true }),
  ] });
  const before = structuredClone(layer);
  const resolved = resolveAnimationInitialValue(layer, layer.animations[1]);
  assert.deepEqual(resolved.from, { x: 100 });
  assert.equal(resolved.fromCurrent, undefined);
  assert.deepEqual(layer, before);
  layer.animations[0].enabled = false;
  assert.deepEqual(resolveInitialAnimations(layer)[1].from, { x: 0 });
});

test("automatic Morph refuses an incompatible inherited path before it can reach drawing", () => {
  const triangle = "M0 0 L100 0 L50 100 Z", square = "M0 0 L100 0 L100 100 L0 100";
  const layer = createLayer("path", { id: "shape", path: triangle, animations: [
    operation("morph", 1, 1, { path: square }, { path: square }, { fromCurrent: true }),
  ] });
  assert.throws(() => parseDocument(documentOf(layer)), /current path cannot morph/);
  layer.animations.unshift(operation("explicit", 0, 1, { path: square }, { path: square }));
  assert.doesNotThrow(() => parseDocument(documentOf(layer)));
  layer.animations[0].enabled = false;
  assert.throws(() => parseDocument(documentOf(layer)), /current path cannot morph/);
});
