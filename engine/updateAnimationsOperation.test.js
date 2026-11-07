// update_animations: the apply_operations form of editing several selected animations at once
// (the Animate tab's multi-animation editor), and of the Timeline's group moves.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TIME, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";

const fade = (id, start = 0, extra = {}) => ({
  id,
  name: "Fade In",
  kind: "in",
  start,
  duration: 1,
  easing: "smooth",
  from: { opacity: 0 },
  to: { opacity: 1 },
  unit: "layer",
  stagger: 0,
  order: "forward",
  ...extra,
});

function documentWith(duration = 5) {
  return parseDocument(
    createDocument({
      scenes: [
        createScene({
          id: "main",
          duration,
          layers: [
            createLayer("rectangle", { id: "box", animations: [fade("a", 0), fade("b", 2)] }),
            createLayer("text", { id: "title", animations: [fade("c", 1), { id: "hide", name: "Hide", kind: "hide", start: 3 }] }),
          ],
        }),
      ],
    }),
  );
}

const animationOf = (document, id) =>
  document.scenes[0].layers.flatMap((layer) => layer.animations).find((animation) => animation.id === id);

test("update_animations gives every listed animation the same properties, across layers", () => {
  const source = documentWith();
  const result = applyOperations(source, [
    { type: "update_animations", sceneId: "main", animationIds: ["a", { layerId: "title", animationId: "c" }], properties: { duration: 0.5, easing: "linear" } },
  ]);
  for (const id of ["a", "c"]) {
    assert.equal(animationOf(result, id).duration, 0.5);
    assert.equal(animationOf(result, id).easing, "linear");
  }
  assert.equal(animationOf(result, "b").duration, 1, "animations not listed are unchanged");
  assert.equal(animationOf(source, "a").duration, 1, "the source document is not changed");
  // `patch` is the same as `properties`.
  const patched = applyOperations(source, [{ type: "update_animations", sceneId: "main", animationIds: ["a", "b"], patch: { start: 1.5 } }]);
  assert.deepEqual([animationOf(patched, "a").start, animationOf(patched, "b").start], [1.5, 1.5]);
});

test("update_animations refuses unclear input and saves nothing", () => {
  const source = documentWith();
  const refused = (operation, pattern) =>
    assert.throws(() => applyOperations(source, [{ type: "update_animations", sceneId: "main", ...operation }]), pattern);
  refused({ properties: { start: 1 } }, /needs animationIds/);
  refused({ animationIds: [], properties: { start: 1 } }, /needs animationIds/);
  refused({ animationIds: ["a"] }, /needs properties/);
  refused({ animationIds: ["a"], properties: {} }, /needs properties/);
  refused({ animationIds: ["a"], properties: { start: 1 }, patch: { start: 2 } }, /not both/);
  refused({ animationIds: ["a"], properties: { id: "z" } }, /can't change an animation's id/);
  refused({ animationIds: ["missing"], properties: { start: 1 } }, /Animation missing was not found/);
  refused({ animationIds: [{ layerId: "box", animationId: "c" }], properties: { start: 1 } }, /not found on layer box/);
  refused({ animationIds: [42], properties: { start: 1 } }, /entries must be/);
  refused({ animationIds: ["a", "a"], properties: { start: 1 } }, /more than once/);
});

test("each animation is checked: one refused animation refuses the whole call", () => {
  const source = documentWith();
  // A Hide is instant, so it can't take a duration.
  assert.throws(
    () => applyOperations(source, [{ type: "update_animations", sceneId: "main", animationIds: ["a", "hide"], properties: { duration: 2 } }]),
    /instant/,
  );
  // A Hide must stay on the scene's timeline.
  assert.throws(
    () => applyOperations(source, [{ type: "update_animations", sceneId: "main", animationIds: ["a", "hide"], properties: { start: 9 } }]),
    /hide/i,
  );
  // No animation may end after the document's time limit.
  assert.throws(
    () => applyOperations(documentWith(MAX_TIME), [{ type: "update_animations", sceneId: "main", animationIds: ["a", "b"], properties: { start: MAX_TIME - 0.5 } }]),
    new RegExp(`cannot exceed ${MAX_TIME} seconds`),
  );
  // A timed animation and a Hide can both move to the same time.
  const moved = applyOperations(source, [{ type: "update_animations", sceneId: "main", animationIds: ["a", "hide"], properties: { start: 4 } }]);
  assert.deepEqual([animationOf(moved, "a").start, animationOf(moved, "hide").start], [4, 4]);
});

test("per-animation start edits of several animations save as valid documents", () => {
  const source = documentWith();
  const update = (starts) => applyOperations(source, Object.entries(starts).map(([animationId, start]) => ({
    type: "update_animation", sceneId: "main", layerId: animationId === "a" ? "box" : "title", animationId, properties: { start },
  })));
  // Each start moved by 0.25, then a group moved right until its last item (the Hide at 3)
  // reaches the scene's end at 5.
  for (const starts of [{ a: 0.25, c: 1.25, hide: 3.25 }, { a: 2, c: 3, hide: 5 }]) {
    const result = update(starts);
    assert.doesNotThrow(() => parseDocument(result));
    for (const [id, start] of Object.entries(starts)) assert.equal(animationOf(result, id).start, start);
  }
});

test("shared Color, Resize and anchor edits of several animations save as valid documents", () => {
  const color = (id, from) => fade(id, 0, { name: "Color", kind: "custom", from: { fill: from }, to: { fill: "#ffffff" } });
  const resize = (id) => fade(id, 1, { name: "Resize", kind: "custom", from: { width: 10 }, to: { width: 100 }, anchor: "center" });
  const source = parseDocument(createDocument({ scenes: [createScene({ id: "main", duration: 5, layers: [
    createLayer("rectangle", { id: "box", lockAspect: true, animations: [color("a", "#000000"), resize("r1")] }),
    createLayer("ellipse", { id: "dot", animations: [color("b", "#ff0000"), resize("r2")] }),
  ] })] }));
  const gradient = { type: "linear", angle: 45, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };
  const edits = [
    [["a", "b"], { from: { fill: "#123456" } }],
    [["a", "b"], { to: { fill: gradient } }],
    [["r1", "r2"], { to: { width: 200 } }],
    [["r1", "r2"], { anchor: "bottom-right" }],
  ];
  for (const [animationIds, properties] of edits) {
    const result = applyOperations(source, [{ type: "update_animations", sceneId: "main", animationIds, properties }]);
    assert.doesNotThrow(() => parseDocument(result));
    for (const id of animationIds)
      for (const [key, value] of Object.entries(properties)) assert.deepEqual(animationOf(result, id)[key], value);
  }
});
