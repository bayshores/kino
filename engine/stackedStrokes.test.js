import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { renderSceneSvg } from "./render.js";
import { createDocument, createLayer, parseDocument } from "./model.js";
import { normalizeStrokeList } from "./stackedStrokes.js";

const layer = (type, values = {}) => ({ ...createLayer(type), id: type, name: type, x: 40, y: 40, width: 160, height: 90, fill: "#ffffff", ...values });
const scene = (...layers) => ({ width: 400, height: 300, background: "#000000", layers });
const twoStrokes = [{ color: "#ff0000", width: 12, align: "outside", join: "round" }, { color: "#0000ff", width: 4, opacity: 0.5 }];

test("two stacked strokes on text and on a path draw in order after the single stroke", () => {
  const text = layer("text", { text: "Hi", fontSize: 60, stroke: "#00ff00", strokeWidth: 2, strokes: twoStrokes });
  const path = layer("path", { path: "M0 0 L100 0 L50 80 Z", stroke: "#00ff00", strokeWidth: 2, strokes: twoStrokes });
  for (const one of [text, path]) {
    const svg = renderSceneSvg(scene(one));
    const single = svg.indexOf('stroke="#00ff00"'), red = svg.indexOf('stroke="#ff0000"'), blue = svg.indexOf('stroke="#0000ff"');
    assert.ok(single >= 0 && single < red && red < blue, one.type);
    assert.match(svg, /stroke="#ff0000" stroke-width="24" stroke-linecap="butt" stroke-linejoin="round"/);
    assert.match(svg, /stroke="#0000ff" stroke-width="4" stroke-opacity="0.5"/);
    assert.match(svg, /<mask id="[^"]*stroke/, "the outside stroke is masked");
  }
  // Text outlines its letters once, together, not once per letter.
  const svg = renderSceneSvg(scene(text));
  assert.equal((svg.match(/stroke="#ff0000"/g) ?? []).length, 1);
});

test("layers without a list, or with an empty one, draw the same markup and save no field", () => {
  for (const type of ["rectangle", "text", "path", "star"]) {
    const extra = { text: "Hey", path: "M0 0 L60 0 L30 50 Z", stroke: "#ff0000", strokeWidth: 3, strokeAlign: "outside" };
    const plain = renderSceneSvg(scene(layer(type, extra)), 0, { raster: true });
    assert.equal(renderSceneSvg(scene(layer(type, { ...extra, strokes: [] })), 0, { raster: true }), plain);
    assert.equal(renderSceneSvg(scene(layer(type, { ...extra, strokes: [{ color: "#00ff00", width: 0 }] })), 0, { raster: true }), plain);
  }
  const document = createDocument();
  document.scenes[0].layers = [layer("rectangle"), layer("text", { id: "t", strokes: [] })];
  const saved = parseDocument(JSON.stringify(document));
  assert.equal(Object.hasOwn(saved.scenes[0].layers[0], "strokes"), false);
  assert.equal(Object.hasOwn(saved.scenes[0].layers[1], "strokes"), false);
});

test("an outside stroke paints past the edge and a later one over an earlier one", () => {
  const box = layer("rectangle", { x: 100, y: 100, width: 100, height: 100, strokes: [{ color: "#ff0000", width: 20, align: "outside" }, { color: "#0000ff", width: 8, align: "outside" }] });
  const image = new Resvg(renderSceneSvg(scene(box), 0, { raster: true })).render();
  const at = (x, y) => [...image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  assert.deepEqual(at(150, 150), [255, 255, 255]);
  assert.deepEqual(at(96, 150), [0, 0, 255]);
  assert.deepEqual(at(86, 150), [255, 0, 0]);
  assert.deepEqual(at(70, 150), [0, 0, 0]);
});

test("a dashed entry dashes, and a shape's trim cuts every stroke", () => {
  const svg = renderSceneSvg(scene(layer("rectangle", { strokes: [{ color: "#ff0000", width: 4, dash: [10, 5] }] })));
  assert.match(svg, /stroke="#ff0000"[^>]*stroke-dasharray="10 5"/);
  const trimmed = renderSceneSvg(scene(layer("ellipse", { strokeEnd: 0.5, strokes: [{ color: "#ff0000", width: 4 }] })));
  assert.match(trimmed, /stroke="#ff0000"[^>]*stroke-dasharray/);
});

test("a bad list is refused with the field it names", () => {
  assert.throws(() => normalizeStrokeList({ color: "#000", width: 2 }), /must be a list/);
  assert.throws(() => normalizeStrokeList([{ color: "red", width: 2 }]), /strokes\[0\]\.color/);
  assert.throws(() => normalizeStrokeList([{ color: "#000" }]), /strokes\[0\]\.width/);
  assert.throws(() => normalizeStrokeList([{ color: "#000", width: 2, align: "middle" }]), /align/);
  assert.throws(() => normalizeStrokeList([{ color: "#000", width: 2, dash: [0, 0] }]), /dash/);
  assert.throws(() => normalizeStrokeList([{ color: "#000", width: 2, cap: "round" }]), /unknown field cap/);
  assert.deepEqual(normalizeStrokeList([{ color: "#000", width: 2, dash: [] }]), [{ color: "#000", width: 2 }]);
  const document = createDocument();
  document.scenes[0].layers = [{ ...createLayer("group"), id: "g", strokes: [{ color: "#000", width: 2 }] }];
  assert.throws(() => parseDocument(JSON.stringify(document)), /strokes list/);
});
