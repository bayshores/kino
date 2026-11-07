import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../model.js";
import { renderSceneSvg } from "../render.js";
import { edgeExtendedBackdrop } from "./backdrop.js";

const box = (id, properties = {}) => createLayer("rectangle", { id, x: 0, y: 0, width: 100, height: 80, ...properties });
const scene = (layers, properties = {}) => createScene({ width: 100, height: 80, duration: 1, background: "#0000FF", layers, ...properties });
const blur = (properties = {}) => box("blur", { x: 25, y: 15, width: 50, height: 50, fill: "#FFFFFF",
  backgroundBlur: { enabled: true, radius: 4, blend: 20 }, ...properties });
const raster = (value, time = 0) => {
  const svg = renderSceneSvg(value, time, { raster: true });
  const image = new Resvg(svg).render();
  return { svg, pixels: image.pixels, width: image.width, height: image.height };
};
const pixel = (image, x, y) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const stripes = () => [box("red", { width: 50, fill: "#FF0000" }), box("blue", { x: 50, width: 50, fill: "#0000FF" })];

test("background blur samples lower paint inside its silhouette with exact zero/opaque blend endpoints", () => {
  const lower = stripes();
  const original = raster(scene(lower));
  const mixed = raster(scene([...lower, blur()]));
  assert.deepEqual(pixel(mixed, 10, 40), pixel(original, 10, 40));
  const middle = pixel(mixed, 49, 40);
  assert.ok(middle[0] > 100 && middle[2] > 100 && middle[1] >= 50, middle);
  assert.deepEqual(raster(scene([...lower, blur({ backgroundBlur: { enabled: true, radius: 4, blend: 0 } })])).pixels, original.pixels);
  assert.deepEqual(pixel(raster(scene([...lower, blur({ backgroundBlur: { enabled: true, radius: 4, blend: 100 } })])), 49, 40), [255, 255, 255, 255]);
  assert.doesNotMatch(mixed.svg, /BackgroundImage|backdrop-filter|<feImage[^>]+href="#/);
  assert.equal((mixed.svg.match(/data-layer-id="red"/g) ?? []).length, 1);
});

test("the blur extends cropped edge pixels instead of bleeding outside colors into its box", () => {
  const red = box("crop", { x: 25, y: 15, width: 50, height: 50, fill: "#FF0000" });
  const result = raster(scene([red, blur({ backgroundBlur: { enabled: true, radius: 12, blend: 1 } })]));
  for (const [x, y] of [[25, 40], [26, 40], [73, 40], [50, 15], [50, 63]]) {
    const rgba = pixel(result, x, y);
    assert.ok(rgba[0] >= 250 && rgba[2] <= 5, `${x},${y}: ${rgba}`);
  }
  assert.deepEqual(pixel(result, 24, 40), [0, 0, 255, 255]);
});

test("cached backdrop edge strips retain translucent colors and sample the source once", () => {
  const defs = [];
  let id = 0;
  const frame = {
    content: '<rect x="0" y="0" width="20" height="16" fill="#E43A62" fill-opacity="0.5"/>',
    bounds: { x: 0, y: 0, width: 20, height: 16 },
    helpers: { defs, id: (kind) => `${kind}-${++id}`, raster: true, transform: [1, 0, 0, 1, 0, 0] },
  };
  const extended = edgeExtendedBackdrop(frame, 10);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="36" viewBox="-10 -10 40 36"><defs>${defs.join("")}</defs>${extended}</svg>`;
  assert.equal((svg.match(/fill-opacity="0.5"/g) ?? []).length, 1, "the lower artwork is one SourceGraphic input");
  const image = new Resvg(svg).render();
  const result = { pixels: image.pixels, width: image.width, height: image.height };
  for (const [x, y] of [[20, 18], [1, 18], [38, 18], [20, 1], [1, 1], [38, 34]]) {
    const actual = pixel(result, x, y);
    assert.ok(Math.abs(actual[0] - 114) <= 1 && Math.abs(actual[1] - 29) <= 1 &&
      Math.abs(actual[2] - 49) <= 1 && Math.abs(actual[3] - 128) <= 1, `${x},${y}: ${actual}`);
  }
});

test("a text silhouette preserves holes and does not blur the surrounding text box", () => {
  const text = createLayer("text", { id: "text-blur", text: "OO", fontFamily: "Inter", fontWeight: 700,
    fontSize: 48, x: 14, y: 9, width: 80, height: 65, fill: "#FFFFFF",
    backgroundBlur: { enabled: true, radius: 5, blend: 20 } });
  const result = raster(scene([...stripes(), text]));
  const original = raster(scene(stripes()));
  let changed = 0, unchanged = 0;
  for (let y = 12; y < 61; y++) for (let x = 15; x < 91; x++) {
    if (pixel(result, x, y).join() === pixel(original, x, y).join()) unchanged++;
    else changed++;
  }
  assert.ok(changed > 100 && unchanged > 800, { changed, unchanged });
  assert.equal((result.svg.match(/aria-label="OO"/g) ?? []).length, 1);
});

test("backdrop roots stop at group opacity, while ordinary transformed groups inherit lower paint", () => {
  const group = createLayer("group", { id: "group", x: 10, y: 5, width: 80, height: 70,
    scaleX: 0.9, scaleY: 0.9, rotation: 8, opacity: 1 });
  const child = blur({ parentId: "group", x: 10, y: 10, width: 60, height: 50,
    backgroundBlur: { enabled: true, radius: 6, blend: 1 } });
  const inherited = raster(scene([...stripes(), group, child]));
  const isolated = raster(scene([...stripes(), { ...group, opacity: 0.5 }, child]));
  const a = pixel(inherited, 49, 40), b = pixel(isolated, 49, 40);
  assert.ok(a[2] > 50 && a[0] > 50, a);
  assert.ok(b[0] > 240 && b[2] < 10, b);
});

test("overlapping blurs sample the lower blur result once and keep unique decorative definitions", () => {
  const lower = blur({ id: "lower", x: 20, width: 60, fill: "#00FF00" });
  const upper = blur({ id: "upper", x: 30, y: 25, width: 50, height: 40, fill: "#FFFFFF",
    backgroundBlur: { enabled: true, radius: 3, blend: 10 } });
  const value = scene([...stripes(), lower, upper]);
  const result = raster(value);
  assert.deepEqual(result.pixels, raster(value).pixels);
  const ids = [...result.svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal((result.svg.match(/data-layer-id="lower"/g) ?? []).length, 1);
  assert.equal((result.svg.match(/data-layer-id="upper"/g) ?? []).length, 1);
  assert.ok(pixel(result, 49, 40)[1] > 35);
});
