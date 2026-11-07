// The Timeline's Stagger command (stagger.js) and its apply_operations form stagger_animations.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TIME, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { evaluateLayer } from "./animation.js";
import { operationStaggerItems, staggerPlan } from "./stagger.js";

const fade = (id, start = 0, duration = 1) => ({
  id,
  name: `Fade ${id}`,
  kind: "in",
  start,
  duration,
  easing: "linear",
  from: { opacity: 0 },
  to: { opacity: 1 },
  unit: "layer",
  stagger: 0,
  order: "forward",
});

// Five layers, Timeline rows top to bottom: a, b, c, d, e (one animation each, all at 0).
function rowLayers(count = 5) {
  return "abcde".slice(0, count).split("").map((letter) =>
    createLayer("rectangle", { id: letter.toUpperCase(), name: letter.toUpperCase(), animations: [fade(letter, 0, 1)] }),
  );
}

// The new start of each animation, by ID, after applying `changes` to `layers`.
function startsAfter(layers, changes) {
  const starts = Object.fromEntries(layers.flatMap((layer) => layer.animations.map((animation) => [animation.id, animation.start])));
  for (const { animationId, patch } of changes) starts[animationId] = patch.start;
  return starts;
}

function documentWith(layers, duration = 5) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", duration, layers })] }));
}

const animationOf = (document, id) =>
  document.scenes[0].layers.flatMap((layer) => layer.animations).find((animation) => animation.id === id);

test("stagger_animations staggers mixed animations and layer blocks in one revision", () => {
  const source = documentWith([
    createLayer("rectangle", { id: "A", name: "A", animations: [fade("a", 1, 1)] }),
    createLayer("text", { id: "T", name: "T", animations: [fade("t1", 2, 1), fade("t2", 2.5, 0.5)] }),
    createLayer("ellipse", { id: "E", name: "E", animations: [fade("e", 0.5, 1)] }),
  ]);
  const next = applyOperations(source, [
    { type: "stagger_animations", sceneId: "main", items: ["e", { layerId: "T" }, { layerId: "A", animationId: "a" }], delay: 0.4, order: "selection" },
  ]);
  // Selection order: e at 0.5 (the earliest start), T's block at 0.9, a at 1.3.
  assert.deepEqual(["e", "t1", "t2", "a"].map((id) => animationOf(next, id).start), [0.5, 0.9, 1.4, 1.3]);
  assert.deepEqual(["e", "t1", "t2", "a"].map((id) => animationOf(next, id).duration), [1, 1, 0.5, 1]);
  // The source document is not changed.
  assert.equal(animationOf(source, "t1").start, 2);
  // The editor preview and every export read these starts: A is half faded in at 1.8 s.
  const layerA = next.scenes[0].layers.find((layer) => layer.id === "A");
  assert.equal(evaluateLayer(layerA, 1.8).opacity, 0.5);
  // A random stagger with a seed gives the same result every time.
  const random = (seed) => applyOperations(source, [{ type: "stagger_animations", sceneId: "main", items: ["a", "t1", "t2", "e"], delay: 0.2, order: "random", seed }]);
  assert.deepEqual(random(9), random(9));
});

test("stagger_animations refuses unclear or impossible requests and saves nothing", () => {
  const source = documentWith([
    createLayer("group", { id: "G", name: "G", animations: [] }),
    createLayer("rectangle", { id: "A", name: "A", parentId: "G", animations: [fade("a", 0, 1)] }),
    createLayer("rectangle", { id: "B", name: "B", animations: [fade("b", 0, 1)] }),
    createLayer("rectangle", { id: "EMPTY", name: "Empty", animations: [] }),
  ]);
  const refuse = (operation, pattern) =>
    assert.throws(() => applyOperations(source, [{ type: "stagger_animations", sceneId: "main", delay: 0.5, ...operation }]), pattern);
  refuse({ items: ["a"] }, /2 to 5000/);
  refuse({ items: "a" }, /2 to 5000/);
  refuse({ items: ["a", "nope"] }, /Animation nope was not found\./);
  refuse({ items: [{ layerId: "B", animationId: "a" }, "b"] }, /Animation a was not found on layer B\./);
  refuse({ items: ["a", { layerId: "NOPE" }] }, /Layer NOPE was not found\./);
  refuse({ items: ["a", { layerId: "EMPTY" }] }, /Layer EMPTY has no animations to stagger/);
  refuse({ items: ["a", "a"] }, /more than once/);
  refuse({ items: [{ layerId: "G" }, "a"] }, /more than once/);
  refuse({ items: ["a", 4] }, /must be animation IDs/);
  refuse({ items: ["a", "b"], delay: -0.1 }, new RegExp(`from 0 to ${MAX_TIME}`));
  refuse({ items: ["a", "b"], delay: "0.5" }, new RegExp(`from 0 to ${MAX_TIME}`));
  refuse({ items: ["a", "b"], order: "zigzag" }, /must be one of/);
  refuse({ items: ["a", "b"], seed: 3 }, /seed is only used with order "random"/);
  refuse({ items: ["a", "b"], order: "random", seed: -3 }, /whole number/);
  refuse({ items: ["a", "b"], delay: 4.5 }, /would end at 5\.5 s, after the scene ends at 5 s\. The longest delay that fits is 4 s\./);
});

test("operation items keep the order they are listed in for a selection-order stagger", () => {
  const layers = rowLayers(3);
  const items = operationStaggerItems(layers, ["c", { layerId: "A" }, { animationId: "b" }]);
  assert.deepEqual(items.map((item) => item.key), ["c", "layer:A", "b"]);
  const plan = staggerPlan(items, { delay: 1, order: "selection", sceneDuration: 5 });
  assert.deepEqual(startsAfter(layers, plan.changes), { c: 0, a: 1, b: 2 });
});
