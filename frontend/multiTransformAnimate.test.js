import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "../engine/animation.js";
import { canvasLayerState } from "./canvasLayerState.js";
import { createLayer } from "../engine/model.js";
import { point } from "../engine/geometry.js";
import { layerQuad } from "../engine/selection.js";
import { resizeTextLayer } from "../engine/textLayout.js";
import { applyFromStart, rotateSelection, rotationAbout, scaleSelection, selectionBox, transformTargets } from "../engine/multiTransform.js";

const animation = (from, to, extra = {}) => ({ id: "animation", name: "Custom", kind: "custom", start: 0, duration: 1, easing: "linear", from, to, ...extra });
const evaluate = (layer) => evaluateLayer(layer, 0.5);
const rectangle = (id, properties = {}) => createLayer("rectangle", { id, x: 0, y: 0, width: 100, height: 40, ...properties });

function assertDrawnTransform(before, after, ids, T, evaluate) {
  const measured = (layer) => resizeTextLayer(evaluate(layer));
  for (const id of ids) {
    const layer = before.find((item) => item.id === id);
    const next = after.find((item) => item.id === id);
    const expected = layerQuad(layer, before, { evaluate: measured }).map((corner) => point(T, corner.x, corner.y));
    const actual = layerQuad(next, after, { evaluate: measured });
    actual.forEach((corner, i) => {
      for (const key of ["x", "y"]) assert.ok(Math.abs(corner[key] - expected[i][key]) < 1e-6, `${id} corner ${i} ${key}: ${corner[key]} != ${expected[i][key]}`);
    });
  }
}

test("paused rotation follows animated dimensions while preserving the target's size keyframes", () => {
  for (const extra of [{}, { name: "Resize", anchor: "bottom-right" }]) {
    const a = rectangle("a", { rotation: 30, animations: [animation({ width: 100, height: 40 }, { width: 300, height: 80 }, extra)] });
    const layers = [a, rectangle("b", { x: 300 })], ids = ["a", "b"];
    const box = selectionBox(transformTargets(layers, ids), layers, { evaluate });
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    for (const degrees of [90, 37, -200]) {
      const T = rotationAbout(center, degrees);
      const after = applyFromStart(layers, layers, ids, rotateSelection(layers, ids, T, { evaluate }));
      assertDrawnTransform(layers, after, ids, T, evaluate);
      assert.deepEqual(after[0].animations, a.animations);
      assert.equal(after[0].width, a.width);
      assert.equal(after[0].height, a.height);
    }
  }
});

test("paused scaling uses nonuniform animated scales, including a selected group and a drawn parent", () => {
  const layers = [
    rectangle("a", { rotation: 30, skewX: 12, animations: [animation({ scaleX: 1, scaleY: 1 }, { scaleX: 3, scaleY: 0.5 })] }),
    createLayer("group", { id: "parent", x: 200, y: 80, width: 150, height: 100, animations: [animation({ rotation: 0, scaleX: 1 }, { rotation: 90, scaleX: 2 })] }),
    rectangle("nested", { parentId: "parent", rotation: -15, animations: [animation({ scaleX: 1, scaleY: 1 }, { scaleX: 2, scaleY: 0.7 })] }),
    createLayer("group", { id: "selected-group", x: 450, y: 80, width: 150, height: 100, animations: [animation({ scaleX: 1, scaleY: 1 }, { scaleX: 2, scaleY: 0.8 })] }),
    rectangle("child", { parentId: "selected-group", x: 10, y: 15, width: 30, height: 20 }),
  ], ids = ["a", "nested", "selected-group"];
  const targets = transformTargets(layers, ids), box = selectionBox(targets, layers, { evaluate });
  for (const T of [[2, 0, 0, 2, -20, 10], [1.5, 0, 0, 0.6, 30, -10]]) {
    const after = applyFromStart(layers, layers, ids, scaleSelection(layers, ids, T, { evaluate }));
    assertDrawnTransform(layers, after, [...ids, "child"], T, evaluate);
    for (const id of ids) assert.deepEqual(after.find((layer) => layer.id === id).animations, layers.find((layer) => layer.id === id).animations);
  }
});

test("paused auto-text transforms measure animated layout with raw and canvas evaluators", () => {
  const text = createLayer("text", { id: "text", x: 30, y: 40, width: 400, height: 200, text: "TEST", fontSize: 48, textResize: "width-height", textAlign: "center", verticalAlign: "middle", animations: [animation({ letterSpacing: 0, lineHeight: 1.2 }, { letterSpacing: 20, lineHeight: 1.8 })] });
  const layers = [text, rectangle("b", { x: 500 })], ids = ["text", "b"];
  for (const drawn of [evaluate, (layer) => canvasLayerState(layer, { mode: "animate", time: 0.5 })]) {
    const shown = resizeTextLayer(drawn(text)), box = selectionBox(layers, layers, { evaluate: drawn });
    const T = [2, 0, 0, 2, -10, 20];
    const scaled = applyFromStart(layers, layers, ids, scaleSelection(layers, ids, T, { evaluate: drawn }));
    assert.equal(scaled[0].width, shown.width * 2);
    assert.equal(scaled[0].height, shown.height * 2);
    assertDrawnTransform(layers, scaled, ids, T, drawn);
    const turn = rotationAbout({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, 37);
    const rotated = applyFromStart(layers, layers, ids, rotateSelection(layers, ids, turn, { evaluate: drawn }));
    assertDrawnTransform(layers, rotated, ids, turn, drawn);
    assert.deepEqual(scaled[0].animations, text.animations);
    assert.deepEqual(rotated[0].animations, text.animations);
  }
});
