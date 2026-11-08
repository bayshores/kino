import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { renderSceneSvg } from "./render.js";
import { createDocument, createLayer, parseDocument } from "./model.js";
import { normalizeShadowList } from "./stackedShadows.js";

const layer = (type, values = {}) => ({ ...createLayer(type), id: type, name: type, x: 40, y: 40, width: 120, height: 80, fill: "#ffffff", ...values });
const scene = (...layers) => ({ width: 400, height: 300, background: "#000000", layers });
const passes = (svg) => (svg.match(/<feOffset /g) ?? []).length;
const twoShadows = [{ color: "#ff0000", x: 30, y: 0, blur: 0 }, { color: "#0000ff", x: 0, y: 30, blur: 6, opacity: 0.5 }];

test("two stacked shadows on text and on a path draw two filter passes", () => {
  const text = layer("text", { text: "Hi", fontSize: 60, shadows: twoShadows });
  const path = layer("path", { path: "M0 0 L100 0 L50 80 Z", shadows: twoShadows });
  for (const one of [text, path]) {
    const svg = renderSceneSvg(scene(one));
    assert.equal(passes(svg), 2, one.type);
    assert.match(svg, /flood-color="#ff0000" flood-opacity="1" result="shadow-color"/);
    assert.match(svg, /flood-color="#0000ff" flood-opacity="0.5" result="shadow-color-1"/);
    assert.match(svg, /<feMergeNode in="shadow-paint"\/><feMergeNode in="shadow-paint-1"\/><feMergeNode in="SourceGraphic"\/>/);
  }
  // The single shadow is drawn first, under the list.
  const both = renderSceneSvg(scene(layer("rectangle", { shadow: { color: "#00ff00", x: 0, y: 0, blur: 20 }, shadows: twoShadows })));
  assert.equal(passes(both), 3);
  assert.match(both, /flood-color="#00ff00"[^>]*result="shadow-color"/);
});

test("layers without a list, or with an empty one, draw the same markup and save no field", () => {
  const shadow = { color: "#00000080", x: 4, y: 8, blur: 12 };
  for (const type of ["rectangle", "text", "path"]) {
    const extra = { shadow, text: "Hey", path: "M0 0 L60 0 L30 50 Z" };
    const plain = renderSceneSvg(scene(layer(type, extra)), 0, { raster: true });
    assert.equal(renderSceneSvg(scene(layer(type, { ...extra, shadows: [] })), 0, { raster: true }), plain);
    assert.equal(renderSceneSvg(scene(layer(type, { ...extra, shadows: [{ color: "#ff000000", x: 9, y: 9, blur: 0 }] })), 0, { raster: true }), plain);
  }
  const document = createDocument();
  document.scenes[0].layers = [layer("rectangle", { shadow }), layer("text", { id: "t", shadows: [] })];
  const saved = parseDocument(JSON.stringify(document));
  assert.equal(Object.hasOwn(saved.scenes[0].layers[0], "shadows"), false);
  assert.equal(Object.hasOwn(saved.scenes[0].layers[1], "shadows"), false);
});

test("each stacked shadow paints in raster exports, inside the filter region", () => {
  const svg = renderSceneSvg(scene(layer("rectangle", { x: 100, y: 60, width: 60, height: 60, shadows: [{ color: "#ff0000", x: 120, y: 0, blur: 0 }, { color: "#0000ff", x: 0, y: 120, blur: 0 }] })), 0, { raster: true });
  const image = new Resvg(svg).render();
  const at = (x, y) => [...image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  assert.deepEqual(at(250, 90), [255, 0, 0]);
  assert.deepEqual(at(130, 210), [0, 0, 255]);
  assert.deepEqual(at(130, 90), [255, 255, 255]);
});

test("a bad list is refused with the field it names", () => {
  assert.throws(() => normalizeShadowList({ color: "#000" }), /must be a list/);
  assert.throws(() => normalizeShadowList([{ color: "red", x: 0, y: 0, blur: 0 }]), /shadows\[0\]\.color/);
  assert.throws(() => normalizeShadowList([{ color: "#000", blur: -1 }]), /shadows\[0\]\.blur/);
  assert.throws(() => normalizeShadowList([{ color: "#000", opacity: 2 }]), /opacity/);
  assert.throws(() => normalizeShadowList([{ color: "#000", spread: 2 }]), /unknown field spread/);
  assert.deepEqual(normalizeShadowList([{ color: "#000" }]), [{ color: "#000", x: 0, y: 0, blur: 0 }]);
  const document = createDocument();
  document.scenes[0].layers = [{ ...createLayer("audio"), id: "a", shadows: [{ color: "#000" }] }];
  assert.throws(() => parseDocument(JSON.stringify(document)), /no shadows/);
});
