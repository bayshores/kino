import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { easingAt, evaluateLayer } from "./animation.js";
import { counterStateAt, easingPieces } from "./counterSchedule.js";
import { textDrawingsAt } from "./textChangeDraw.js";
import { copyAnimation, pasteAnimations } from "./layerClipboard.js";

const operation = (extra = {}) => ({ id: "move", name: "Move", kind: "custom", start: 0, duration: 1,
  easing: "smooth", from: { x: 0 }, to: { x: 100 }, ...extra });
const document = (animation = operation(), type = "rectangle") => createDocument({ id: "file", scenes: [createScene({ id: "scene",
  layers: [createLayer(type, { id: "layer", text: "0", animations: [animation] })] })] });
const first = (doc) => doc.scenes[0].layers[0].animations[0];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} should equal ${b}`);

test("document validation preserves missing intensity and checks it on every easing-bearing value", () => {
  assert.equal(Object.hasOwn(first(parseDocument(document())), "intensity"), false);
  assert.deepEqual(first(parseDocument(document(operation({ easing: "Ease Out", intensity: 75 })))).easing, "ease-out");
  for (const intensity of [0, 50, 100]) {
    for (const easing of ["None", [0.5, -2, 0.5, 3], "Elastic"])
      assert.equal(first(parseDocument(document(operation({ easing, intensity })))).intensity, intensity);
  }
  for (const intensity of [-1, 101, 0.5, "50", null, Infinity])
    assert.throws(() => parseDocument(document(operation({ intensity }))), /intensity/);
  const effect = { preset: "fade-in", duration: 1, easing: "Accelerate", intensity: 100, unit: "letters", stagger: 0.1, order: "forward" };
  const change = { id: "change", name: "Change", kind: "change-text", start: 0, text: "New", out: null, in: effect };
  const parsed = first(parseDocument(document(change, "text")));
  assert.equal(parsed.in.easing, "ease-in"); assert.equal(parsed.in.intensity, 100);
  assert.throws(() => parseDocument(document({ ...change, in: { ...effect, intensity: 12.5 } }, "text")), /intensity/);
  assert.throws(() => parseDocument(document({ ...change, intensity: 50 }, "text")), /cannot have intensity/);
  assert.throws(() => parseDocument(document({ id: "hide", name: "Hide", kind: "hide", start: 0, intensity: 50 })), /cannot have intensity/);
});

test("MCP document operations accept easing labels and intensity for add/update and keep clipboard copies", () => {
  const base = createDocument({ scenes: [createScene({ id: "scene", layers: [createLayer("rectangle", { id: "layer" })] })] });
  const added = applyOperations(base, [{ type: "add_animation", sceneId: "scene", layerId: "layer", preset: "move", easing: "Slow down", intensity: 75 }]);
  const item = first(added);
  assert.equal(item.easing, "ease-out"); assert.equal(item.intensity, 75);
  const updated = applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "layer", animationId: item.id, properties: { intensity: 0 } }]);
  assert.equal(first(updated).intensity, 0);
  assert.throws(() => applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "layer", animationId: item.id, properties: { intensity: 100.1 } }]), /intensity/);
  assert.equal(first(added).intensity, 75, "a refused edit leaves the original untouched");
  const copy = copyAnimation(updated, "scene", "layer", item.id);
  const pasted = pasteAnimations(base, "scene", ["layer"], copy, 0);
  assert.equal(first(pasted.document).intensity, 0);
});

test("ordinary and per-letter animations use the requested intensity in the shared evaluator", () => {
  for (const intensity of [0, 100]) {
    const layer = createLayer("text", { text: "Hey", animations: [operation({ intensity, unit: "letters", stagger: 0.1 })] });
    close(evaluateLayer(layer, 0.4, { unitIndex: 2, unitCount: 3, unit: "letters" }).x, 100 * easingAt("smooth", 0.2, intensity));
  }
  assert.notEqual(easingAt("smooth", 0.2, 0), easingAt("smooth", 0.2, 100));
});

test("Change text applies intensity separately to each staggered effect unit", () => {
  for (const intensity of [0, 100]) {
    const change = { id: "change", name: "Change", kind: "change-text", start: 0, text: "Hey", out: null,
      in: { preset: "fade-in", duration: 1, easing: "smooth", intensity, unit: "letters", stagger: 0.1, order: "forward" } };
    const layer = createLayer("text", { text: "Old", animations: [change] });
    const [drawing] = textDrawingsAt(layer, 0.4);
    assert.equal(drawing.units.length, 3);
    drawing.units.forEach(({ state }, index) => close(state.opacity, easingAt("smooth", 0.4 - 0.1 * index, intensity)));
  }
});

test("counter searches and turning-point caches distinguish intensities and reversing curves", () => {
  assert.notDeepEqual(easingPieces("bounce", 0), easingPieces("bounce", 100));
  for (const easing of ["smooth", "impulse", "swing", "elastic", "bounce"])
    for (const intensity of [0, 100, 50, 0]) {
      const counter = { id: "counter", kind: "counter", start: 0, duration: 1, easing, intensity, from: 0, to: 100, step: 1, in: null, out: null };
      for (const time of [0.07, 0.23, 0.41, 0.63, 0.89]) {
        const actual = counterStateAt(counter, time);
        const expected = Math.floor(Math.max(0, Math.min(1, easingAt(easing, time, intensity))) * 100 + 1e-9);
        assert.equal(actual.index, expected, `${easing} ${intensity} at ${time}`);
        assert.ok(actual.since <= time + 1e-7);
        assert.ok(actual.next >= time - 1e-7);
        if (actual.next < 1) assert.notEqual(counterStateAt(counter, actual.next + 1e-7).index, actual.index);
      }
    }
});
