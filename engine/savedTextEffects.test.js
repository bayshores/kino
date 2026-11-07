import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, parseDocument } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { applySavedTextEffect, normalizeSavedTextEffect, savedTextEffectInput } from "./savedTextEffects.js";

function documentWith(layers) {
  const document = createDocument({ id: "text-effect-project", name: "Text effect project" });
  document.scenes[0].id = "text-effect-scene";
  document.scenes[0].layers = layers;
  return parseDocument(document);
}

function moveAnimation(overrides = {}) {
  return {
    id: "source-animation",
    name: "Source name",
    kind: "custom",
    start: 0.75,
    duration: 1,
    easing: "linear",
    enabled: false,
    from: { x: 10 },
    to: { x: 30 },
    ...overrides,
  };
}

test("saved automatic starts keep their mode and resolve against the destination's preceding animation", () => {
  const source = createLayer("text", { x: 10 });
  const saved = savedTextEffectInput("Continue", source, moveAnimation({ fromCurrent: true }));
  assert.equal(saved.animation.fromCurrent, true);
  const target = createLayer("text", { id: "target", x: 100, animations: [
    moveAnimation({ id: "prior", enabled: true, start: 0, from: { x: 100 }, to: { x: 110 } }),
  ] });
  const document = documentWith([target]);
  const result = applySavedTextEffect(document, "text-effect-scene", ["target"], saved, 1);
  const pasted = result.document.scenes[0].layers[0];
  assert.equal(pasted.animations[1].fromCurrent, true);
  assert.deepEqual(pasted.animations[1].from, { x: 100 });
  assert.equal(evaluateLayer(pasted, 1.5).x, 115);
});

test("saved effects reject private or unknown fields nested in endpoint paints and structured values", () => {
  const gradient = {
    type: "linear",
    angle: 0,
    stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }],
  };
  for (const [paint, field] of [
    [{ ...gradient, sourceText: "hidden" }, "sourceText"],
    [{ ...gradient, stops: [{ ...gradient.stops[0], src: "/api/media/file" }, gradient.stops[1]] }, "src"],
    [{ ...gradient, stops: [{ ...gradient.stops[0], layerId: "private-layer" }, gradient.stops[1]] }, "layerId"],
  ]) {
    assert.throws(() => normalizeSavedTextEffect({
      name: "Private", animation: moveAnimation({ from: { fill: paint } }), rest: {},
    }), new RegExp(`cannot contain ${field}`, "i"));
  }
  assert.throws(() => normalizeSavedTextEffect({
    name: "Private", animation: moveAnimation({ from: { shadow: { color: "#000000", x: 0, y: 0, blur: 1, projectId: "private" } } }), rest: {},
  }), /shadow cannot contain projectId/i);
  assert.throws(() => normalizeSavedTextEffect({
    name: "Private", animation: moveAnimation({ from: { reveal: { progress: 0, direction: "up", softness: 0, sourceText: "private" } } }), rest: {},
  }), /reveal cannot contain sourceText/i);
});

test("normalization copies its inputs and returns only name, portable animation, and rest", () => {
  const input = {
    id: "saved-effect-id",
    name: " Custom ",
    animation: { ...moveAnimation(), from: { x: 3 }, to: { x: 24 } },
    rest: { x: 8, opacity: 0.6 },
  };
  const normalized = normalizeSavedTextEffect(input);
  assert.deepEqual(Object.keys(normalized).sort(), ["animation", "name", "rest"]);
  assert.equal(normalized.name, "Custom");
  input.animation.to.x = 100;
  input.rest.opacity = 0;
  assert.equal(normalized.animation.to.x, 24);
  assert.equal(normalized.rest.opacity, 0.6);
  assert.throws(() => normalizeSavedTextEffect({ ...input, name: "   " }), /1 to 120/i);
  assert.throws(() => normalizeSavedTextEffect({ ...input, name: "x".repeat(121) }), /1 to 120/i);
});

test("applying a saved effect creates fresh playhead-timed copies and rebases each text target", () => {
  const target = createLayer("text", { id: "target-a", x: 25, animations: [] });
  const second = createLayer("text", { id: "target-b", x: -5, animations: [] });
  const document = documentWith([target, second]);
  const item = {
    id: "library-record-id",
    name: "Rise",
    animation: { kind: "custom", duration: 1, easing: "linear", from: { x: 10 }, to: { x: 30 } },
    rest: { x: 5 },
  };
  const original = structuredClone(item);
  const result = applySavedTextEffect(document, "text-effect-scene", ["target-a", "target-b"], item, 2.25);
  const layers = result.document.scenes[0].layers;
  const [firstCopy] = layers[0].animations;
  const [secondCopy] = layers[1].animations;

  assert.equal(firstCopy.name, "Rise");
  assert.equal(firstCopy.start, 2.25);
  assert.deepEqual([firstCopy.from.x, firstCopy.to.x], [30, 50]);
  assert.deepEqual([secondCopy.from.x, secondCopy.to.x], [0, 20]);
  assert.notEqual(firstCopy.id, item.id);
  assert.notEqual(secondCopy.id, firstCopy.id);
  assert.deepEqual(item, original, "applying does not change the library item");
  assert.deepEqual(document.scenes[0].layers.map((layer) => layer.animations), [[], []], "applying does not mutate the project");
});

test("applying refuses non-text, locked, and missing targets", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "shape" }),
    createLayer("text", { id: "locked", locked: true }),
  ]);
  const item = {
    name: "Fade", animation: { kind: "in", duration: 1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } }, rest: {},
  };
  assert.throws(() => applySavedTextEffect(document, "text-effect-scene", ["shape"], item, 0), /only.*text/i);
  assert.throws(() => applySavedTextEffect(document, "text-effect-scene", ["locked"], item, 0), /locked/i);
  assert.throws(() => applySavedTextEffect(document, "text-effect-scene", ["missing"], item, 0), /no longer exist/i);
});
