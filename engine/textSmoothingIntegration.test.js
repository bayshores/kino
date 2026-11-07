import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { presetAnimation } from "./animation.js";
import { editSceneAnimations } from "./sceneAnimationEdit.js";
import { copyAnimation, pasteAnimations } from "./layerClipboard.js";

const CURVE = [0.25, 0.1, 0.75, 0.9];

function timed(id, options = {}) {
  return {
    id,
    name: id,
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from: { opacity: 0 },
    to: { opacity: 1 },
    ...options,
  };
}

function documentWith(layers) {
  return parseDocument(createDocument({
    scenes: [createScene({ id: "scene", width: 120, height: 80, duration: 4, layers })],
  }));
}

function layerOf(document, id) {
  return document.scenes[0].layers.find((layer) => layer.id === id);
}

function animationOf(document, layerId, animationId) {
  return layerOf(document, layerId).animations.find((animation) => animation.id === animationId);
}

test("documents normalize named aliases and custom smoothing while keeping it independent of easing intensity", () => {
  const cases = [
    ["smooth", "Smooth", "smooth"],
    ["natural", "Natural", "natural"],
    ["slow-down", "Slow down", "ease-out"],
    ["accelerate", "Accelerate", "ease-in"],
    ["none", "None", "linear"],
    ["custom-alias", "custom", [0.5, 0, 0.5, 1]],
    ["bezier", CURVE, CURVE],
  ];
  const layer = createLayer("rectangle", {
    id: "box",
    animations: cases.map(([id, smoothing], index) => timed(id, {
      smoothing,
      smoothingIntensity: index === 0 ? 0 : index === 1 ? 100 : 37,
      intensity: 82,
    })),
  });
  const parsed = documentWith([layer]);

  for (const [id, , expected] of cases)
    assert.deepEqual(animationOf(parsed, "box", id).smoothing, expected, id);
  assert.equal(animationOf(parsed, "box", "smooth").smoothingIntensity, 0);
  assert.equal(animationOf(parsed, "box", "natural").smoothingIntensity, 100);
  assert.equal(animationOf(parsed, "box", "accelerate").intensity, 82);
  assert.equal(animationOf(parsed, "box", "accelerate").smoothingIntensity, 37);
  assert.deepEqual(
    animationOf(parseDocument(JSON.parse(JSON.stringify(parsed))), "box", "bezier").smoothing,
    CURVE,
  );
});

test("omitted and null smoothing settings stay absent, including on zero-effect non-text animations", () => {
  const parsed = documentWith([
    createLayer("rectangle", { id: "legacy", animations: [timed("legacy")] }),
    createLayer("rectangle", {
      id: "cleared",
      animations: [timed("cleared", { smoothing: null, smoothingIntensity: null, unit: "layer", stagger: 0 })],
    }),
    createLayer("rectangle", {
      id: "zero-effect",
      animations: [timed("zero-effect", { smoothing: "Natural", smoothingIntensity: 50, unit: "layer", stagger: 0 })],
    }),
  ]);

  for (const id of ["legacy", "cleared"]) {
    const animation = animationOf(parsed, id, id);
    assert.equal(Object.hasOwn(animation, "smoothing"), false, id);
    assert.equal(Object.hasOwn(animation, "smoothingIntensity"), false, id);
  }
  assert.deepEqual(
    [animationOf(parsed, "zero-effect", "zero-effect").smoothing, animationOf(parsed, "zero-effect", "zero-effect").smoothingIntensity],
    ["natural", 50],
    "smoothing remains valid even where unit delays currently have no visible effect",
  );
});

test("documents refuse unsupported smoothing curves and invalid smoothing intensity", () => {
  for (const smoothing of ["bounce", "elastic", "impulse", "swing", "overshoot", 5]) {
    assert.throws(() => documentWith([
      createLayer("text", { id: "title", text: "Hi", animations: [timed("invalid", { smoothing })] }),
    ]), /smoothing/);
  }
  for (const smoothingIntensity of [-1, 101, 50.5, "50"]) {
    assert.throws(() => documentWith([
      createLayer("text", { id: "title", text: "Hi", animations: [timed("invalid", { smoothing: "linear", smoothingIntensity })] }),
    ]), /smoothingIntensity/);
  }
});

test("parent Hide, Show, Change text, and Counter operations refuse smoothing fields", () => {
  const unsupported = [
    createLayer("rectangle", {
      id: "hide",
      animations: [{ id: "hide-smoothing", name: "Hide", kind: "hide", start: 0, smoothing: "smooth" }],
    }),
    createLayer("rectangle", {
      id: "show",
      animations: [{ id: "show-smoothing", name: "Show", kind: "show", start: 0, smoothingIntensity: 50 }],
    }),
    createLayer("text", {
      id: "change-text",
      text: "Old",
      animations: [{ id: "change-smoothing", name: "Change text", kind: "change-text", start: 0, text: "New", out: null, in: null, smoothing: "linear" }],
    }),
    createLayer("text", {
      id: "counter",
      text: "1",
      animations: [{ id: "counter-smoothing", name: "Counter", kind: "counter", start: 0, duration: 1, easing: "linear", from: 0, to: 2, step: 1, out: null, in: null, smoothingIntensity: 50 }],
    }),
  ];
  for (const layer of unsupported)
    assert.throws(() => documentWith([layer]), /smoothing/);
});

test("Change text and Counter effects accept their own named and Bezier smoothing settings", () => {
  const change = createLayer("text", {
    id: "change",
    text: "Old",
    animations: [{
      id: "change-text",
      name: "Change text",
      kind: "change-text",
      start: 0,
      text: "New",
      overlap: false,
      out: { preset: "fade-out", smoothing: "Slow down", smoothingIntensity: 18 },
      in: { preset: "fade-in", smoothing: CURVE, smoothingIntensity: 91 },
    }],
  });
  const counter = createLayer("text", {
    id: "counter",
    text: "1",
    animations: [{
      id: "count",
      name: "Counter",
      kind: "counter",
      start: 0,
      duration: 1,
      easing: "linear",
      from: 0,
      to: 2,
      step: 1,
      out: { preset: "fade-out", smoothing: "Accelerate", smoothingIntensity: 22 },
      in: { preset: "fade-in", smoothing: "None", smoothingIntensity: 77 },
    }],
  });
  const parsed = documentWith([change, counter]);
  const changeText = animationOf(parsed, "change", "change-text");
  assert.deepEqual([changeText.out.smoothing, changeText.out.smoothingIntensity], ["ease-out", 18]);
  assert.deepEqual([changeText.in.smoothing, changeText.in.smoothingIntensity], [CURVE, 91]);
  const count = animationOf(parsed, "counter", "count");
  assert.deepEqual([count.out.smoothing, count.out.smoothingIntensity], ["ease-in", 22]);
  assert.deepEqual([count.in.smoothing, count.in.smoothingIntensity], ["linear", 77]);
});

test("add overrides, multi-edit, and preset changes keep smoothing fields on the intended rows", () => {
  const title = createLayer("text", { id: "title", text: "AB" });
  const first = {
    ...presetAnimation("slide-up", title, 0),
    id: "preset-row",
    smoothing: "natural",
    smoothingIntensity: 12,
    intensity: 84,
  };
  const second = timed("custom-row", {
    unit: "letters",
    stagger: 0.25,
    smoothing: CURVE,
    smoothingIntensity: 93,
    intensity: 21,
  });
  const source = documentWith([
    createLayer("text", { ...title, animations: [first] }),
    createLayer("rectangle", { id: "box", animations: [second] }),
  ]);

  const added = applyOperations(source, [{
    type: "add_animation",
    sceneId: "scene",
    layerId: "title",
    animation: timed("top-level-override", { smoothing: "linear", smoothingIntensity: 4, intensity: 79 }),
    smoothing: "Slow down",
    smoothingIntensity: 63,
  }]);
  const override = animationOf(added, "title", "top-level-override");
  assert.deepEqual([override.smoothing, override.smoothingIntensity, override.intensity], ["ease-out", 63, 79]);
  const cleared = applyOperations(added, [{
    type: "update_animation",
    sceneId: "scene",
    layerId: "title",
    animationId: "top-level-override",
    properties: { smoothing: null, smoothingIntensity: null },
  }]);
  assert.equal(Object.hasOwn(animationOf(cleared, "title", "top-level-override"), "smoothing"), false);
  assert.equal(Object.hasOwn(animationOf(cleared, "title", "top-level-override"), "smoothingIntensity"), false);

  const multi = applyOperations(source, [{
    type: "update_animations",
    sceneId: "scene",
    animationIds: [
      { layerId: "title", animationId: "preset-row" },
      { layerId: "box", animationId: "custom-row" },
    ],
    properties: { smoothingIntensity: 55 },
  }]);
  assert.deepEqual(
    [animationOf(multi, "title", "preset-row").smoothing, animationOf(multi, "box", "custom-row").smoothing],
    ["natural", CURVE],
    "a multi-edit of intensity retains each row's independent smoothing curve",
  );
  assert.deepEqual(
    [animationOf(multi, "title", "preset-row").smoothingIntensity, animationOf(multi, "box", "custom-row").smoothingIntensity],
    [55, 55],
  );
  assert.deepEqual(
    [animationOf(multi, "title", "preset-row").intensity, animationOf(multi, "box", "custom-row").intensity],
    [84, 21],
    "smoothingIntensity does not overwrite animation easing intensity",
  );

  const edited = editSceneAnimations(multi, "scene", [{
    layerId: "title",
    animationId: "preset-row",
    patch: { smoothing: "Accelerate" },
  }]);
  const changed = animationOf(edited, "title", "preset-row");
  assert.equal(changed.smoothing, "ease-in");
  assert.deepEqual(changed.preset, first.preset, "changing a preset's smoothing keeps its preset metadata");
  assert.deepEqual(changed.from, first.from);
  assert.deepEqual(changed.to, first.to);
});

test("clipboard roundtrip creates a fresh ID and keeps smoothing when pasted onto a non-text layer", () => {
  const source = documentWith([
    createLayer("text", {
      id: "title",
      text: "AB",
      animations: [timed("text-fade", {
        unit: "letters",
        stagger: 0.2,
        smoothing: "Slow down",
        smoothingIntensity: 68,
      })],
    }),
    createLayer("rectangle", { id: "box" }),
  ]);
  const envelope = JSON.parse(JSON.stringify(copyAnimation(source, "scene", "title", "text-fade")));
  const { document: pasted, skipped } = pasteAnimations(source, "scene", ["box"], envelope, 1);
  const original = animationOf(source, "title", "text-fade");
  const copy = layerOf(pasted, "box").animations[0];

  assert.deepEqual(skipped, []);
  assert.notEqual(copy.id, original.id);
  assert.deepEqual([copy.smoothing, copy.smoothingIntensity, copy.unit, copy.stagger], ["ease-out", 68, "letters", 0.2]);
  assert.equal(copy.start, 1);
  assert.equal(layerOf(source, "title").animations[0].id, original.id, "copying leaves the source unchanged");
});
