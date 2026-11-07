import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyFromStart, selectionBox, transformTargets } from "./multiTransform.js";
import { selectionResizeAt } from "./selectionTransformDrag.js";
import { SELECTION_RESIZE_ANCHORS, selectionTransformFromFields } from "./selectionTransformFields.js";

import { layerQuad } from "./selection.js";
import { point } from "./geometry.js";

function fixture(extra = []) {
  return parseDocument(createDocument({ id: "file", scenes: [createScene({ id: "page", layers: [
    createLayer("rectangle", { id: "left", x: 0, y: 0, width: 100, height: 50 }),
    createLayer("rectangle", { id: "right", x: 300, y: 0, width: 100, height: 50 }), ...extra,
  ] })] }));
}
const ids = ["left", "right"];
const layersOf = (document) => document.scenes[0].layers;
const boxOf = (layers, options) => selectionBox(transformTargets(layers, ids), layers, options);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} should equal ${expected}`);

test("numeric shared rotation moves both centers around the union center instead of rotating in place", () => {
  const before = fixture(), layers = layersOf(before), box = boxOf(layers);
  const result = selectionTransformFromFields(layers, ids, box, { kind: "rotate", degrees: "90" });
  const next = applyFromStart(layers, layers, ids, result.changes);
  for (const [index, layer] of layers.entries()) {
    const corners = layerQuad(layer, layers), drawn = layerQuad(next[index], next);
    for (let i = 0; i < corners.length; i++) {
      const wanted = point(result.transform, corners[i].x, corners[i].y);
      near(drawn[i].x, wanted.x); near(drawn[i].y, wanted.y);
    }
  }
  const center = (layer) => {
    const corners = layerQuad(layer, next);
    return { x: corners.reduce((sum, corner) => sum + corner.x, 0) / 4, y: corners.reduce((sum, corner) => sum + corner.y, 0) / 4 };
  };
  near(center(next[0]).x, 200); near(center(next[0]).y, -125);
  near(center(next[1]).x, 200); near(center(next[1]).y, 175);
  assert.deepEqual(before, fixture(), "the edit leaves the source unchanged");
});

test("numeric scale changes shared spacing and exactly matches center and opposite-corner drags", () => {
  const layers = layersOf(fixture()), box = boxOf(layers);
  for (const [anchor, fromCenter, dx, dy] of [["center", true, 200, -12.5], ["top-left", false, 400, -25]]) {
    const result = selectionTransformFromFields(layers, ids, box, { kind: "scale", scaleX: 200, scaleY: 50, anchor });
    const drag = selectionResizeAt(layers, ids, box, dx, dy, 1, 1, { fromCenter });
    assert.deepEqual(result.transform, drag.transform);
    assert.deepEqual(result.changes, drag.changes);
    const next = applyFromStart(layers, layers, ids, result.changes);
    near(next[1].x - next[0].x, 600);
  }
});

test("every resize anchor stays fixed, including edge and center keyboard equivalents", () => {
  const layers = layersOf(fixture()), box = boxOf(layers);
  for (const [anchor, , u, v] of SELECTION_RESIZE_ANCHORS) {
    const result = selectionTransformFromFields(layers, ids, box, { kind: "scale", scaleX: 150, scaleY: 75, anchor });
    const fixed = { x: box.x + box.width * u, y: box.y + box.height * v };
    const after = point(result.transform, fixed.x, fixed.y);
    near(after.x, fixed.x); near(after.y, fixed.y);
  }
});

test("keyboard scaling uses the drag's proportional fallback for incompatible group animations", () => {
  const group = createLayer("group", { id: "g", width: 100, height: 50 });
  const child = createLayer("rectangle", { id: "child", parentId: "g", animations: [{ id: "spin", name: "Spin", kind: "custom", start: 0, duration: 1, easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } }] });
  const layers = [group, child], box = selectionBox([group], layers);
  const result = selectionTransformFromFields(layers, ["g"], box, { kind: "scale", scaleX: 120, scaleY: 100 });
  assert.match(result.message, /animates its rotation.*keeps its proportions/);
  near(result.transform[0], result.transform[3]);
  assert.deepEqual(result.changes, selectionResizeAt(layers, ["g"], box, box.width * 0.1, 0, 1, 1, { fromCenter: true }).changes);
});

test("keyboard edits preserve target rules, locks and animation capability refusals", () => {
  const before = fixture([
    createLayer("rectangle", { id: "locked", x: 900, locked: true }),
    createLayer("audio", { id: "audio", src: "/api/media/aaa.mp3" }),
  ]);
  const layers = layersOf(before), selected = [...ids, "locked", "audio"];
  const result = selectionTransformFromFields(layers, selected, boxOf(layers), { kind: "rotate", degrees: 90 });
  assert.deepEqual(applyFromStart(layers, layers, selected, result.changes).slice(2), layers.slice(2));
  layers[0].lockAspect = true;
  assert.throws(() => selectionTransformFromFields(layers, ids, boxOf(layers), { kind: "scale", scaleX: 200, scaleY: 100 }), /proportions are locked/);
  for (const [kind, handles] of [["scale", { resize: false }], ["rotate", { rotate: false }]])
    assert.throws(() => selectionTransformFromFields(layers, ids, boxOf(layers), { kind }, { handles }), /cannot be/);
});

test("identity edits change nothing and all invalid transforms refuse before any edit", () => {
  const before = fixture(), snapshot = structuredClone(before), box = boxOf(layersOf(before));
  for (const action of [{ kind: "scale", scaleX: 100, scaleY: 100 }, { kind: "rotate", degrees: 0 }])
    assert.deepEqual(selectionTransformFromFields(layersOf(before), ids, box, action).changes, []);
  for (const action of [
    { kind: "scale", scaleX: "", scaleY: 100 }, { kind: "scale", scaleX: 0, scaleY: 100 },
    { kind: "scale", scaleX: 1e9, scaleY: 100 }, { kind: "scale", scaleX: 100, scaleY: 100, anchor: "unknown" },
    { kind: "rotate", degrees: "no" }, { kind: "rotate", degrees: Infinity },
  ]) assert.throws(() => selectionTransformFromFields(layersOf(before), ids, box, action));
  assert.deepEqual(before, snapshot);
});
