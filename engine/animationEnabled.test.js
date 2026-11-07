// An operation turned off for playback (the Timeline eye, animationEnabled.js) stays in the
// document but is skipped wherever animations are evaluated, and comes back exactly when it is
// turned on again.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { applyOperations } from "./operations.js";
import { hiddenRanges, visibleByOperations } from "./visibilityOps.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { getScenePlaybackDuration } from "./playback.js";
import { renderSceneSvg } from "./render.js";
import { copyAnimations, duplicateLayers, pasteAnimations } from "./layerClipboard.js";
import { duplicateSelection } from "./duplicate.js";
import { enabledAnimations, enabledValueProblem, isAnimationEnabled } from "./animationEnabled.js";

const off = (animation) => ({ ...animation, enabled: false });
// Slide sets x from 0 to 100 over the first second. Move, at 2 s, has no From x, so it starts
// from whatever x the earlier operations left (the layer's own 20 when Slide is off). Fade In,
// at 1 s, holds its From opacity before it starts, as an "in" animation does.
const slide = { id: "slide", name: "Slide", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 100 } };
const move = { id: "move", name: "Move", kind: "custom", start: 2, duration: 1, easing: "linear", from: {}, to: { x: 200 } };
const fade = { id: "fade", name: "Fade in", kind: "in", start: 1, duration: 1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } };
const TIMES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];

function box(animations) {
  return createLayer("rectangle", { id: "box", name: "Box", x: 20, y: 0, width: 10, height: 10, animations });
}

const sample = (layer) => TIMES.map((time) => {
  const state = evaluateLayer(layer, time);
  return [state.x, state.opacity];
});

test("an operation that is off changes nothing, and later operations start without it", () => {
  assert.deepEqual(sample(box([slide, move, fade])), [
    [0, 0], [50, 0], [100, 0], [100, 0.5], [100, 1], [150, 1], [200, 1], [200, 1],
  ]);
  // Slide off: x stays at the layer's 20 until Move, which then starts from 20, not from 100.
  assert.deepEqual(sample(box([off(slide), move, fade])), [
    [20, 0], [20, 0], [20, 0], [20, 0.5], [20, 1], [110, 1], [200, 1], [200, 1],
  ]);
  // Move off: Slide's end value stays.
  assert.deepEqual(sample(box([slide, off(move), fade])).map(([x]) => x), [0, 50, 100, 100, 100, 100, 100, 100]);
  // Fade In off: no From opacity before its start, and no fade.
  assert.deepEqual(sample(box([slide, move, off(fade)])).map(([, opacity]) => opacity), TIMES.map(() => 1));
  // Everything off: the layer as designed, at every time.
  assert.deepEqual(sample(box([off(slide), off(move), off(fade)])), TIMES.map(() => [20, 1]));
  // The operations are still on the layer, and turning one on again brings back exactly what it did.
  const layer = box([off(slide), move, fade]);
  assert.equal(evaluateLayer(layer, 0.5).animations.length, 3);
  Object.assign(layer.animations[0], { enabled: true });
  assert.deepEqual(sample(layer), sample(box([slide, move, fade])));
});

test("a Hide or Show that is off does not change visibility", () => {
  const hide = { id: "hide", name: "Hide", kind: "hide", start: 1 };
  const show = { id: "show", name: "Show", kind: "show", start: 2 };
  const visible = (animations) => [0.5, 1.5, 2.5].map((time) => evaluateLayer(box(animations), time).visible);
  assert.deepEqual(visible([hide, show]), [true, false, true]);
  // With the Hide off, the Show is the layer's first operation, so the layer is hidden until it,
  // exactly as if the Hide were deleted.
  assert.deepEqual(visible([off(hide), show]), [false, false, true]);
  assert.deepEqual(visible([off(hide), show]), visible([show]));
  assert.deepEqual(visible([hide, off(show)]), [true, false, false], "with the Show off the layer stays hidden");
  // A Show that is a layer's first operation hides the layer before it, unless it is off.
  assert.deepEqual(visible([show]), [false, false, true]);
  assert.deepEqual(visible([off(show)]), [true, true, true]);
  assert.equal(visibleByOperations([off(hide)], 1.5), true);
  // The Timeline's hidden stretch follows the same rule.
  assert.deepEqual(hiddenRanges([hide, show], 3), [{ start: 1, end: 2 }]);
  assert.deepEqual(hiddenRanges([off(hide), show], 3), [{ start: 0, end: 2 }]);
  assert.deepEqual(hiddenRanges([off(hide), off(show)], 3), []);
  assert.deepEqual(hiddenRanges([hide, off(show)], 3), [{ start: 1, end: 3 }]);
});

test("a text animation by letters that is off does not split the text, and its stagger is gone", () => {
  const letters = { id: "letters", name: "Letters", kind: "in", start: 0, duration: 0.5, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 }, unit: "letters", stagger: 0.25, order: "forward" };
  const words = { ...letters, id: "words", name: "Words", unit: "words", stagger: 0 };
  const text = (animations) => createScene({ id: "text", width: 400, height: 100, duration: 2, layers: [
    createLayer("text", { id: "title", text: "AB CD", width: 380, animations }),
  ] });
  const labels = (scene) => [...renderSceneSvg(scene, 1).matchAll(/<g opacity="[^"]*" transform="[^"]*" aria-label="([^"]*)"/g)].map((match) => match[1]);
  // The first animation by letters, words or lines sets the units the text is drawn in.
  assert.deepEqual(labels(text([letters, words])), ["A", "B", " ", "C", "D"]);
  assert.deepEqual(labels(text([off(letters), words])), ["AB ", "CD"], "the words animation sets the units instead");
  assert.deepEqual(labels(text([off(letters)])), [], "with no unit animation on, the text is drawn whole");
  assert.match(renderSceneSvg(text([off(letters)]), 0), /role="img" aria-label="AB CD"/);
  // Each letter's own stagger is skipped with the animation.
  const title = text([off(letters)]).layers[0];
  assert.equal(evaluateLayer(title, 0, { unitIndex: 3, unitCount: 4, unit: "letters" }).opacity, 1);
});

test("a component instance skips its source's off animations, and they do not count toward its play length", () => {
  const fadeShort = { ...fade, start: 0, duration: 0.8 };
  const long = { ...move, id: "long", start: 0, duration: 3, from: { x: 0 } };
  const source = createScene({ id: "source", isComponent: true, duration: 4, layers: [box([fadeShort, off(long)])] });
  const target = createScene({ id: "target", duration: 8, layers: [createComponentInstance(source, { id: "instance", componentStart: 1 })] });
  const document = parseDocument(createDocument({ scenes: [source, target] }));
  assert.equal(getScenePlaybackDuration(document, "source"), 0.8);
  assert.equal(getScenePlaybackDuration(document, "target"), 1.8);
  const inner = expandComponents(document, "target").layers.find((layer) => layer.name === "Box");
  assert.equal(inner.animations.find((item) => item.name === "Move").enabled, false, "the copy keeps the flag");
  assert.equal(evaluateLayer(inner, 2.5).x, 20, "the off move does nothing in the instance");
  assert.ok(Math.abs(evaluateLayer(inner, 1.4).opacity - 0.5) < 1e-9, "the fade still plays on the instance's clock");
  // Turned on again, the long move sets the play length and moves the box.
  document.scenes[0].layers[0].animations[1] = long;
  assert.equal(getScenePlaybackDuration(document, "source"), 3);
  const moved = expandComponents(document, "target").layers.find((layer) => layer.name === "Box");
  assert.ok(evaluateLayer(moved, 2.5).x > 20);
  // A looping fade plays until the source scene ends, so the instance plays that long too.
  document.scenes[0].layers[0].animations[0] = { ...fadeShort, behavior: { loop: { mode: "cycle" } } };
  assert.equal(getScenePlaybackDuration(document, "source"), 4);
});

test("the document keeps enabled false, drops enabled true, and refuses any other value", () => {
  const scene = createScene({ id: "main", duration: 4, layers: [box([off(slide), { ...move, enabled: true }, fade, off({ id: "hide", name: "Hide", kind: "hide", start: 1 })])] });
  const parsed = parseDocument(JSON.parse(JSON.stringify(createDocument({ scenes: [scene] }))));
  const saved = parsed.scenes[0].layers[0].animations;
  assert.deepEqual(saved.map((item) => item.enabled), [false, undefined, undefined, false]);
  assert.equal(Object.hasOwn(saved[1], "enabled"), false, "an operation that is on is saved without the field");
  // Saving and opening again gives the same document.
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(parsed))), parsed);
  for (const value of ["false", 0, null, 1, {}]) {
    const bad = createScene({ id: "main", layers: [box([{ ...slide, enabled: value }])] });
    assert.throws(() => parseDocument(createDocument({ scenes: [bad] })), /animations\[0\]\.enabled: must be true or false/, String(value));
  }
});

test("update_animation and update_animations turn animations off and on with a true or false enabled", () => {
  const scene = createScene({ id: "main", duration: 4, layers: [box([slide, move, { id: "hide", name: "Hide", kind: "hide", start: 1 }])] });
  const document = parseDocument(createDocument({ scenes: [scene] }));
  const animations = (value) => value.scenes[0].layers[0].animations;
  const turnedOff = applyOperations(document, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: "slide", properties: { enabled: false } }]);
  assert.equal(animations(turnedOff)[0].enabled, false);
  assert.equal(evaluateLayer(turnedOff.scenes[0].layers[0], 0.5).x, 20);
  const turnedOn = applyOperations(turnedOff, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: "slide", properties: { enabled: true } }]);
  assert.equal(Object.hasOwn(animations(turnedOn)[0], "enabled"), false);
  assert.deepEqual(turnedOn, document, "turning it on again gives back the original document");
  const all = applyOperations(document, [{ type: "update_animations", sceneId: "main", animationIds: ["slide", "move", "hide"], properties: { enabled: false } }]);
  assert.deepEqual(animations(all).map((item) => item.enabled), [false, false, false]);
  assert.equal(evaluateLayer(all.scenes[0].layers[0], 1.5).visible, true, "the Hide is off too");
  for (const value of ["no", 0, null]) {
    assert.throws(
      () => applyOperations(document, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: "slide", properties: { enabled: value } }]),
      /update_animation enabled must be true or false/,
    );
    assert.throws(
      () => applyOperations(document, [{ type: "update_animations", sceneId: "main", animationIds: ["slide"], patch: { enabled: value } }]),
      /update_animations enabled must be true or false/,
    );
  }
  // An off animation can still be staggered, moved and deleted; it stays off.
  const staggered = applyOperations(all, [{ type: "stagger_animations", sceneId: "main", items: ["slide", "move"], delay: 0.5 }]);
  assert.deepEqual(animations(staggered).slice(0, 2).map((item) => [item.start, item.enabled]), [[0, false], [0.5, false]]);
  const deleted = applyOperations(all, [{ type: "delete_animation", sceneId: "main", layerId: "box", animationId: "move" }]);
  assert.deepEqual(animations(deleted).map((item) => item.id), ["slide", "hide"]);
});

test("copy and paste, and duplicating a layer, keep an animation off", () => {
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "main", duration: 4, layers: [
    box([off(slide), fade]),
    createLayer("ellipse", { id: "target" }),
  ] })] }));
  const text = JSON.stringify(copyAnimations(document, "main", ["slide", "fade"]));
  const pasted = pasteAnimations(document, "main", ["target"], JSON.parse(text), 1);
  const copies = pasted.document.scenes[0].layers.find((layer) => layer.id === "target").animations;
  assert.deepEqual(copies.map((item) => [item.name, item.enabled]), [["Slide", false], ["Fade in", undefined]]);
  const duplicated = duplicateLayers(document, "main", ["box"]).document.scenes[0].layers;
  assert.equal(duplicated.length, 3);
  assert.deepEqual(duplicated.filter((layer) => layer.name.startsWith("Box")).map((layer) => layer.animations[0].enabled), [false, false]);
  const moved = duplicateSelection(document, "main", ["box"]).document.scenes[0].layers;
  assert.deepEqual(moved.filter((layer) => layer.name.startsWith("Box")).map((layer) => layer.animations[0].enabled), [false, false]);
});

test("helpers: what is on, and which enabled values an API edit may set", () => {
  assert.equal(isAnimationEnabled(slide), true);
  assert.equal(isAnimationEnabled({ ...slide, enabled: true }), true);
  assert.equal(isAnimationEnabled(off(slide)), false);
  assert.deepEqual(enabledAnimations([slide, off(move), fade]).map((item) => item.id), ["slide", "fade"]);
  assert.deepEqual(enabledAnimations(undefined), []);
  assert.equal(enabledValueProblem({ start: 1 }, "update_animation"), null);
  assert.equal(enabledValueProblem({ enabled: false }, "update_animation"), null);
  assert.equal(enabledValueProblem({ enabled: "off" }, "update_animations"), "update_animations enabled must be true or false.");
});
