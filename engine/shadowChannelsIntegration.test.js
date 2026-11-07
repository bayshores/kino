import assert from "node:assert/strict";
import test from "node:test";
import { applyOperations } from "./operations.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { DEFAULT_SHADOW } from "./shadowInterpolation.js";
import { evaluateLayer } from "./animation.js";
import { easingAt } from "./easing.js";
import { SHADOW_CHANNELS } from "./shadowChannels.js";
import { copyAnimation, pasteAnimations } from "./layerClipboard.js";
import { duplicateSelection } from "./duplicate.js";

const BASE = { color: "#11223380", x: 3, y: 4, blur: 5 };
const RED = { color: "#ff0000ff", x: 10, y: 11, blur: 12 };
const BLUE = { color: "#0000ffff", x: 20, y: 21, blur: 22 };

function shadowAnimation(id, from, to, options = {}) {
  return {
    id,
    name: id,
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from: { shadow: from },
    to: { shadow: to },
    ...options,
  };
}

function documentWith(layers) {
  return parseDocument(createDocument({
    scenes: [createScene({ id: "main", width: 100, height: 60, duration: 4, layers })],
  }));
}

function layerOf(document, id) {
  return document.scenes[0].layers.find((layer) => layer.id === id);
}

test("model canonicalizes valid channel masks and refuses malformed, non-shadow, and unsupported operations", () => {
  const document = documentWith([
    createLayer("rectangle", {
      id: "valid",
      animations: [shadowAnimation("valid-channels", null, BASE, { shadowChannels: ["blur", "color", "y"] })],
    }),
  ]);
  assert.deepEqual(layerOf(document, "valid").animations[0].shadowChannels, ["color", "y", "blur"]);

  for (const shadowChannels of ["x", [], ["x", "x"], ["unknown"], ["opacity", null]]) {
    const invalid = createLayer("rectangle", {
      id: "invalid",
      animations: [shadowAnimation("invalid-channels", null, BASE, { shadowChannels })],
    });
    assert.throws(() => documentWith([invalid]), /shadowChannels/);
  }

  const nonShadow = shadowAnimation("not-shadow", null, null, {
    from: { opacity: 0 },
    to: { opacity: 1 },
    shadowChannels: ["x"],
  });
  assert.throws(() => documentWith([createLayer("rectangle", { id: "non-shadow", animations: [nonShadow] })]),
    /shadowChannels.*requires a Shadow animation/);

  const unsupportedKinds = [
    createLayer("rectangle", {
      id: "hide",
      animations: [{ id: "hide-channel", name: "Hide", kind: "hide", start: 0, shadowChannels: ["x"] }],
    }),
    createLayer("text", {
      id: "change-text",
      text: "1",
      animations: [{ id: "text-channel", name: "Change text", kind: "change-text", start: 0, text: "2", out: null, in: null, shadowChannels: ["x"] }],
    }),
    createLayer("text", {
      id: "counter",
      text: "1",
      animations: [{ id: "counter-channel", name: "Counter", kind: "counter", start: 0, duration: 1, easing: "linear", from: 0, to: 1, step: 1, out: null, in: null, shadowChannels: ["x"] }],
    }),
    createLayer("audio", {
      id: "audio",
      animations: [shadowAnimation("audio-channel", null, BASE, { shadowChannels: ["x"] })],
    }),
  ];
  for (const layer of unsupportedKinds)
    assert.throws(() => documentWith([layer]), /shadowChannels|Shadow animation|timed in, out, or custom/);
});

test("omitted, null, and all-channel masks retain whole-shadow behavior through document roundtrip", () => {
  const from = { color: "#f0102080", x: -4, y: 8, blur: 3 };
  const to = { color: "#2070f040", x: 16, y: -2, blur: 19 };
  const document = documentWith([
    createLayer("rectangle", { id: "legacy", shadow: from, animations: [shadowAnimation("legacy", from, to)] }),
    createLayer("rectangle", { id: "null-mask", shadow: from, animations: [shadowAnimation("null-mask", from, to, { shadowChannels: null })] }),
    createLayer("rectangle", { id: "all-channels", shadow: from, animations: [shadowAnimation("all-channels", from, to, { shadowChannels: [...SHADOW_CHANNELS].reverse() })] }),
  ]);
  const saved = parseDocument(JSON.parse(JSON.stringify(document)));

  assert.equal(Object.hasOwn(layerOf(saved, "legacy").animations[0], "shadowChannels"), false);
  assert.equal(Object.hasOwn(layerOf(saved, "null-mask").animations[0], "shadowChannels"), false);
  assert.deepEqual(layerOf(saved, "all-channels").animations[0].shadowChannels, SHADOW_CHANNELS);
  for (const time of [0, 0.25, 0.5, 1, 2]) {
    const expected = evaluateLayer(layerOf(saved, "legacy"), time).shadow;
    assert.deepEqual(evaluateLayer(layerOf(saved, "null-mask"), time).shadow, expected, `null mask at ${time}s`);
    assert.deepEqual(evaluateLayer(layerOf(saved, "all-channels"), time).shadow, expected, `all channels at ${time}s`);
  }
});

test("independent channels honor each track's start, duration, and easing", () => {
  const opacityFrom = { ...BASE, color: "#11223300" };
  const opacityTo = { ...BASE, color: "#aabbcc80" };
  const xFrom = { ...BASE, x: 0 };
  const xTo = { ...BASE, x: 20 };
  const blurFrom = { ...BASE, blur: 4 };
  const blurTo = { ...BASE, blur: 12 };
  const box = createLayer("rectangle", {
    id: "box",
    shadow: BASE,
    animations: [
      shadowAnimation("color", RED, BLUE, { duration: 2, shadowChannels: ["color"] }),
      shadowAnimation("opacity", opacityFrom, opacityTo, { start: 0.5, duration: 2, shadowChannels: ["opacity"] }),
      shadowAnimation("x", xFrom, xTo, { start: 0.5, duration: 2, shadowChannels: ["x"] }),
      shadowAnimation("blur", blurFrom, blurTo, { start: 0.5, duration: 1, easing: "ease-in", shadowChannels: ["blur"] }),
    ],
  });

  const result = evaluateLayer(box, 1).shadow;
  assert.deepEqual(result, {
    color: "#80008020",
    x: 5,
    y: BASE.y,
    blur: 4 + 8 * easingAt("ease-in", 0.5),
  });
});

test("later-started tracks take precedence and same-start tracks follow stored order", () => {
  const xTrack = (id, start, duration, fromX, toX) => shadowAnimation(
    id,
    { ...BASE, x: fromX },
    { ...BASE, x: toX },
    { start, duration, shadowChannels: ["x"] },
  );
  const box = createLayer("rectangle", {
    id: "box",
    shadow: BASE,
    animations: [
      xTrack("first-at-zero", 0, 2, 0, 100),
      xTrack("second-at-zero", 0, 2, 0, 40),
      xTrack("later-start", 0.5, 1, 100, 200),
    ],
  });

  assert.equal(evaluateLayer(box, 0.25).shadow.x, 5, "the second stored track wins when starts tie");
  assert.equal(evaluateLayer(box, 0.75).shadow.x, 125, "the later-started track wins after it begins");
});

test("an In track applies only its selected From channel before its start", () => {
  const box = createLayer("rectangle", {
    id: "box",
    shadow: BASE,
    animations: [shadowAnimation("in-x", { ...BASE, x: 5 }, { ...BASE, x: 25 }, {
      kind: "in",
      start: 1,
      duration: 1,
      shadowChannels: ["x"],
    })],
  });

  assert.deepEqual(evaluateLayer(box, 0).shadow, { ...BASE, x: 5 });
  assert.deepEqual(evaluateLayer(box, 1.5).shadow, { ...BASE, x: 15 });
});

test("null endpoints compose opacity and geometry without replacing unselected channels", () => {
  const ending = { color: "#aabbcc80", x: 20, y: 30, blur: 40 };
  const appearing = createLayer("rectangle", {
    id: "appearing",
    shadow: BASE,
    animations: [shadowAnimation("appear", null, ending, { shadowChannels: ["opacity", "x"] })],
  });
  assert.deepEqual(evaluateLayer(appearing, 0.5).shadow, {
    color: "#11223340",
    x: ending.x,
    y: BASE.y,
    blur: BASE.blur,
  });

  const absent = createLayer("rectangle", {
    id: "absent",
    shadow: BASE,
    animations: [shadowAnimation("absent", null, null, { shadowChannels: ["opacity", "x"] })],
  });
  assert.deepEqual(evaluateLayer(absent, 0.5).shadow, { ...BASE, color: "#11223300" });
});

test("update, clipboard paste, duplicate, and saved-document parsing preserve normalized channel masks", () => {
  const source = documentWith([
    createLayer("rectangle", {
      id: "source",
      shadow: BASE,
      animations: [shadowAnimation("editable", BASE, BLUE, { start: 0.25, shadowChannels: ["x"] })],
    }),
    createLayer("rectangle", { id: "target" }),
    createLayer("audio", { id: "sound" }),
  ]);
  const updated = applyOperations(source, [{
    type: "update_animation",
    sceneId: "main",
    layerId: "source",
    animationId: "editable",
    properties: { start: 0.5, shadowChannels: ["blur", "x"] },
  }]);
  const updatedAnimation = layerOf(updated, "source").animations[0];
  assert.equal(updatedAnimation.start, 0.5);
  assert.deepEqual(updatedAnimation.shadowChannels, ["x", "blur"]);

  const envelope = JSON.parse(JSON.stringify(copyAnimation(updated, "main", "source", "editable")));
  const { document: pasted, skipped } = pasteAnimations(updated, "main", ["target", "sound"], envelope, 1);
  const pastedAnimation = layerOf(pasted, "target").animations[0];
  assert.deepEqual(pastedAnimation.shadowChannels, ["x", "blur"]);
  assert.equal(pastedAnimation.start, 1);
  assert.deepEqual(skipped.map(({ layerId }) => layerId), ["sound"]);

  const { document: duplicated, rootIds } = duplicateSelection(updated, "main", ["source"]);
  const duplicate = layerOf(parseDocument(duplicated), rootIds[0]);
  assert.deepEqual(duplicate.animations[0].shadowChannels, ["x", "blur"]);
  assert.deepEqual(
    evaluateLayer(duplicate, 1.25).shadow,
    evaluateLayer(layerOf(updated, "source"), 1.25).shadow,
    "duplicating a layer keeps its partial shadow animation intact",
  );

  const reloaded = parseDocument(JSON.parse(JSON.stringify(pasted)));
  assert.deepEqual(layerOf(reloaded, "target").animations[0], pastedAnimation);
});

test("letter-unit text and groups can evaluate partial shadow channels while audio is refused", () => {
  const textBase = { color: "#11223380", x: 2, y: 3, blur: 4 };
  const text = createLayer("text", {
    id: "letters",
    text: "Hi",
    shadow: textBase,
    animations: [shadowAnimation("letter-opacity",
      { ...textBase, color: "#11223300" },
      { ...textBase, color: "#aabbcc80" },
      { unit: "letters", stagger: 0.5, shadowChannels: ["opacity"] },
    )],
  });
  assert.equal(evaluateLayer(text, 0.75, { unit: "letters", unitIndex: 0, unitCount: 2 }).shadow.color, "#11223360");
  assert.equal(evaluateLayer(text, 0.75, { unit: "letters", unitIndex: 1, unitCount: 2 }).shadow.color, "#11223320");

  const group = createLayer("group", {
    id: "group",
    animations: [shadowAnimation("group-x", { ...DEFAULT_SHADOW, x: 0 }, { ...DEFAULT_SHADOW, x: 8 }, { shadowChannels: ["x"] })],
  });
  assert.deepEqual(evaluateLayer(group, 0.5).shadow, {
    color: "#00000000",
    x: 4,
    y: DEFAULT_SHADOW.y,
    blur: DEFAULT_SHADOW.blur,
  });

  const audio = createLayer("audio", {
    id: "audio",
    animations: [shadowAnimation("audio-shadow", null, BASE, { shadowChannels: ["x"] })],
  });
  assert.throws(() => documentWith([audio]), /Shadow animation needs a layer that is drawn/);
});
