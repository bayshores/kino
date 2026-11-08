// A layer's anchor (the pivot of rotation, scale and skew) and animated skewX / skewY.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLayer } from "./animation.js";
import { layerMatrix, point } from "./geometry.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { renderSceneSvg } from "./render.js";
import { reparentLayer } from "./reparent.js";
import { resizeAnchorShift } from "./resizeAnchor.js";
import { exportScene } from "../backend/export.mjs";

const turn = { id: "a", name: "Rotate", kind: "custom", start: 0, duration: 1, easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } };
function sceneWith(layer) {
  const scene = createScene({ id: "s", name: "S", width: 400, height: 300, duration: 2, layers: [createLayer("rectangle", { id: "r", name: "Box", x: 100, y: 50, width: 80, height: 40, fill: "#ff0000", ...layer })] });
  return parseDocument(createDocument({ scenes: [scene] }));
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const corner = (doc, time) => point(layerMatrix(evaluateLayer(doc.scenes[0].layers[0], time)), 0, 0);

test("rotating 90 degrees about the top-left corner keeps that corner fixed", () => {
  const doc = sceneWith({ anchor: [0, 0], animations: [turn] });
  for (const time of [0, 0.3, 1, 2]) { close(corner(doc, time).x, 100); close(corner(doc, time).y, 50); }
  const svg = renderSceneSvg(doc.scenes[0], 1);
  assert.match(svg, /translate\(100 50\) translate\(0 0\) rotate\(90\) scale\(1 1\) skewX\(0\) translate\(0 0\)/);
  // The center pivot (no anchor) moves the corner.
  assert.notEqual(Math.round(corner(sceneWith({ animations: [turn] }), 1).x), 100);
  // A Resize that holds the top-left still about a top-left pivot moves nothing.
  assert.deepEqual(resizeAnchorShift("top-left", { width: 20, height: 10 }, { rotation: 90, anchor: [0, 0] }), { x: 0, y: 0 });
});

test("skewX 20 and skewY animate and change the drawn transform", () => {
  const skew = { id: "k", name: "Skew", kind: "custom", start: 0, duration: 1, easing: "linear", from: { skewX: 0, skewY: 0 }, to: { skewX: 20, skewY: 10 } };
  const doc = sceneWith({ animations: [skew] });
  const state = evaluateLayer(doc.scenes[0].layers[0], 1);
  assert.equal(state.skewX, 20);
  assert.equal(state.skewY, 10);
  assert.match(renderSceneSvg(doc.scenes[0], 1), /skewX\(20\) skewY\(10\)/);
  assert.notEqual(renderSceneSvg(doc.scenes[0], 1), renderSceneSvg(doc.scenes[0], 0));
  assert.throws(() => sceneWith({ skewY: 95 }), /skewY/);
  assert.throws(() => sceneWith({ anchor: [0] }), /anchor/);
});

test("a layer without anchor or skewY draws exactly as before", () => {
  const doc = sceneWith({ rotation: 30, scaleX: 1.5, skewX: 5, animations: [turn] });
  const layer = doc.scenes[0].layers[0];
  assert.equal(Object.hasOwn(layer, "anchor") || Object.hasOwn(layer, "skewY"), false);
  const svg = renderSceneSvg(doc.scenes[0], 0.5);
  // The pre-anchor transform string: about the center, no skewY.
  assert.match(svg, /translate\(100 50\) translate\(40 20\) rotate\(45\) scale\(1\.5 1\) skewX\(5\) translate\(-40 -20\)/);
  assert.doesNotMatch(svg, /skewY/);
  // Same as a layer whose anchor is the center.
  const centered = sceneWith({ rotation: 30, scaleX: 1.5, skewX: 5, anchor: [50, 50], animations: [turn] });
  assert.equal(renderSceneSvg(centered.scenes[0], 0.5), svg);
});

test("add_animation anchor sets the layer's pivot, refuses a move, and moving into a group keeps the corner", () => {
  const doc = sceneWith({});
  const next = applyOperations(doc, [{ type: "add_animation", sceneId: "s", layerId: "r", preset: "preset-rotate", start: 0, anchor: "top-left" }]);
  const layer = next.scenes[0].layers[0];
  assert.deepEqual(layer.anchor, [0, 0]);
  for (const time of [0, 0.5, 1.05]) { close(corner(next, time).x, 100); close(corner(next, time).y, 50); }
  const grown = applyOperations(doc, [{ type: "add_animation", sceneId: "s", layerId: "r", preset: "preset-grow", start: 0, anchor: [50, 100] }]);
  assert.deepEqual(grown.scenes[0].layers[0].anchor, [50, 100]);
  assert.throws(() => applyOperations(doc, [{ type: "add_animation", sceneId: "s", layerId: "r", preset: "preset-fade", anchor: [0, 0] }]), /anchor is the point a rotate or scale turns about/);
  // Into a group turned 90 degrees: the top-left (the pivot) lands where the group puts it.
  const placed = reparentLayer({ ...layer, rotation: 0, animations: [] }, [0, 1, -1, 0, 0, 0]);
  close(point(layerMatrix({ ...layer, ...placed }), 0, 0).x, -50);
  close(point(layerMatrix({ ...layer, ...placed }), 0, 0).y, 100);
});

test("Lottie keeps the anchor as its anchor and writes skew", async () => {
  const doc = sceneWith({ anchor: [0, 0], skewX: 20, animations: [turn] });
  const output = JSON.parse((await exportScene(doc.scenes[0], { format: "lottie", fps: 10 })).buffer).layers.find((item) => item.nm === "Box");
  const values = (property) => property.a ? property.k.map((key) => key.s) : [property.k];
  for (const anchor of values(output.ks.a)) assert.deepEqual(anchor.slice(0, 2), [0, 0]);
  for (const position of values(output.ks.p)) { close(position[0], 100); close(position[1], 50); }
  for (const skew of values(output.ks.sk)) assert.ok(Math.abs(Math.abs(Array.isArray(skew) ? skew[0] : skew) - 20) < 1e-6);
});
