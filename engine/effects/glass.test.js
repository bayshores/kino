import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../model.js";
import { renderSceneSvg } from "../render.js";

const box = (id, properties = {}) => createLayer("rectangle", { id, x: 0, y: 0, width: 200, height: 140, ...properties });
const parameters = (properties = {}) => ({ enabled: true, refraction: 100, depth: 100, dispersion: 0, frost: 0,
  lightIntensity: 0, lightAngle: 0, blend: 0, ...properties });
const glass = (properties = {}) => box("glass", { x: 40, y: 20, width: 100, height: 100, fill: "#FF0000", glass: parameters(), ...properties });
const stripes = () => Array.from({ length: 40 }, (_, index) => box(`stripe${index}`, {
  x: index * 5, width: 5, fill: index % 2 ? "#FFFFFF" : "#101010",
}));
const scene = (layers) => createScene({ width: 200, height: 140, duration: 1, background: "#202020", layers });
const raster = (layers, time = 0) => {
  const svg = renderSceneSvg(scene(layers), time, { raster: true });
  const image = new Resvg(svg).render();
  return { svg, pixels: image.pixels, width: image.width };
};
const pixel = (image, x, y) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const difference = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0);

test("glass bends only the edge band, keeps the interior flat, and paints no own fill at blend zero", () => {
  const lower = stripes();
  const original = raster(lower);
  const result = raster([...lower, glass()]);
  let edgeDifference = 0;
  for (let y = 45; y < 95; y++) for (let x = 43; x < 61; x++)
    edgeDifference += difference(pixel(result, x, y), pixel(original, x, y));
  assert.ok(edgeDifference > 20_000, edgeDifference);
  for (const [x, y] of [[82, 60], [92, 70], [102, 80], [12, 60], [170, 80]])
    assert.deepEqual(pixel(result, x, y), pixel(original, x, y));
  assert.deepEqual(result.pixels, raster([...lower, glass()]).pixels);
  assert.doesNotMatch(result.svg, /BackgroundImage|<feImage[^>]+href="#/);
});

test("zero refraction or depth leaves the opaque backdrop unchanged and blend100 uses rounded box paint", () => {
  const lower = stripes();
  const original = raster(lower);
  for (const style of [parameters({ refraction: 0 }), parameters({ depth: 0 })]) {
    const image = raster([...lower, glass({ glass: style })]);
    let max = 0;
    for (let index = 0; index < image.pixels.length; index++) max = Math.max(max, Math.abs(image.pixels[index] - original.pixels[index]));
    assert.ok(max <= 1, max);
  }
  const opaque = raster([...lower, glass({ glass: parameters({ blend: 100 }) })]);
  assert.deepEqual(pixel(opaque, 90, 70), [255, 0, 0, 255]);
  assert.deepEqual(pixel(opaque, 40, 20), pixel(original, 40, 20));
});

test("dispersion separates RGB at a colored edge and Frost softens and slightly lightens the interior", () => {
  const lower = stripes();
  const dispersed = raster([...lower, glass({ glass: parameters({ dispersion: 100 }) })]);
  let colorFringes = 0;
  for (let y = 30; y < 110; y++) for (let x = 44; x < 135; x++) {
    const [r, g, b] = pixel(dispersed, x, y);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 20) colorFringes++;
  }
  assert.ok(colorFringes > 80, colorFringes);
  const sharp = raster([...lower, glass()]);
  const frosted = raster([...lower, glass({ glass: parameters({ frost: 10 }) })]);
  assert.ok(pixel(frosted, 92, 70)[0] > pixel(sharp, 92, 70)[0] + 50);
  assert.ok(pixel(frosted, 97, 70)[0] < pixel(sharp, 97, 70)[0] - 50);
});

test("glass retains ellipse, compound-hole and glyph silhouettes with one accessible source", () => {
  const lower = stripes();
  const ring = createLayer("path", { id: "ring", x: 40, y: 20, width: 100, height: 100,
    path: "M0 0H100V100H0Z M30 30H70V70H30Z", fillRule: "evenodd", glass: parameters() });
  const original = raster(lower);
  assert.deepEqual(pixel(raster([...lower, ring]), 90, 70), pixel(original, 90, 70));
  const ellipse = createLayer("ellipse", { ...glass(), id: "ellipse", type: "ellipse" });
  assert.deepEqual(pixel(raster([...lower, ellipse]), 40, 20), pixel(original, 40, 20));
  const text = createLayer("text", { id: "text", text: "O", fontFamily: "Inter", fontSize: 70,
    x: 40, y: 20, width: 100, height: 100, glass: parameters({ blend: 30 }) });
  const result = raster([...lower, text]);
  assert.equal((result.svg.match(/aria-label="O"/g) ?? []).length, 1);
  assert.equal((result.svg.match(/data-layer-id="text"/g) ?? []).length, 1);
  const ids = [...result.svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});

test("light angle360 and0 agree and tiny boxes keep bounded finite maps", () => {
  const lower = stripes();
  assert.deepEqual(raster([...lower, glass({ glass: parameters({ lightIntensity: 100, lightAngle: 360 }) })]).pixels,
    raster([...lower, glass({ glass: parameters({ lightIntensity: 100, lightAngle: 0 }) })]).pixels);
  const tiny = raster([...lower, glass({ width: 0.5, height: 1, glass: parameters({ dispersion: 100, frost: 10 }) })]);
  assert.doesNotMatch(tiny.svg.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, "image"), /NaN|Infinity/);
});
