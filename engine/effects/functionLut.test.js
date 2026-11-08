// Generated LUTs: a pixel function becomes a LUT drawn like the lut effect, cached by its rounded parameters.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "../../backend/chromium-raster.mjs";
import { functionLut, renderFunctionLut } from "./colorGrading.js";

let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-function-lut-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Draws the generated LUT over a row of 1x1 swatches (0..255 triples); returns [r, g, b] per pixel.
async function draw(options, colors) {
  const defs = [];
  let sequence = 0;
  const width = colors.length;
  const content = colors.map(([r, g, b], x) => `<rect x="${x}" width="1" height="1" fill="rgb(${r},${g},${b})"/>`).join("");
  const output = renderFunctionLut({ content, bounds: { x: 0, y: 0, width, height: 1 }, parameters: {}, time: 0, progress: 0,
    helpers: { id: (kind) => `${kind}-${++sequence}`, defs } }, options);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1" viewBox="0 0 ${width} 1"><defs>${defs.join("")}</defs>${output}</svg>`;
  const image = await loadImage((await chromium.render(svg, width, 1)).buffer);
  const canvas = createCanvas(width, 1);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, 1).data;
  return colors.map((_, x) => [...pixels.subarray(x * 4, x * 4 + 3)]);
}

function largestError(drawn, expected) {
  return Math.max(...drawn.flatMap((pixel, index) => pixel.map((value, channel) => Math.abs(value - expected[index][channel]))));
}

// A split-tone look with contrast (warm highlights, cool shadows); it mixes channels, so it goes
// through the 3D lattice, and it stays inside 0..1 so no clamp bends it.
const look = (r, g, b, { tone, contrast }) => {
  const split = 2 * tone * (0.2126 * r + 0.7152 * g + 0.0722 * b - 0.5);
  const curve = (v) => v + contrast * (v - 0.5) * (1 - Math.abs(2 * v - 1));
  return [curve(r + split * r * (1 - r)), curve(g), curve(b - split * b * (1 - b))];
};

test("an identity function draws within 1/255 of the layer at both sizes", async () => {
  const colors = [];
  for (let value = 0; value <= 255; value += 17) colors.push([value, 0, 0], [0, value, 0], [0, 0, value], [value, 255 - value, value]);
  for (const size of [17, 33]) {
    const drawn = await draw({ name: "test-identity", size, color: (r, g, b) => [r, g, b] }, colors);
    assert.ok(largestError(drawn, colors) <= 1, `size ${size}`);
  }
});

test("a known curve matches its function within 3/255 at 27 probe colors", async () => {
  const levels = [23, 120, 214];
  const colors = levels.flatMap((r) => levels.flatMap((g) => levels.map((b) => [r, g, b])));
  const parameters = { tone: 0.6, contrast: 0.35 };
  const expected = colors.map((rgb) => look(...rgb.map((value) => value / 255), parameters)
    .map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255)));
  for (const size of [17, 33]) {
    const options = { name: "test-look", size, parameters, color: look };
    assert.equal(functionLut(options).lut.size, size);
    const error = largestError(await draw(options, colors), expected);
    assert.ok(error <= 3, `size ${size}: largest error ${error}/255`);
  }
  // A steep per-channel curve reads the function itself, not the 17-point lattice.
  const greys = [[2, 2, 2], [9, 9, 9], [40, 40, 40], [200, 200, 200]];
  const drawn = await draw({ name: "test-root", color: (r, g, b) => [r, g, b].map(Math.sqrt) }, greys);
  assert.ok(largestError(drawn, greys.map((rgb) => rgb.map((value) => Math.round(Math.sqrt(value / 255) * 255)))) <= 1);
});

test("a second call with the same rounded parameters hits the cache", () => {
  let calls = 0;
  const color = (r, g, b, parameters) => { calls += 1; return look(r, g, b, parameters); };
  const first = functionLut({ name: "test-cache", color, parameters: { tone: 0.1, contrast: 0.2 } });
  assert.equal(calls, 17 ** 3);
  const second = functionLut({ name: "test-cache", color, parameters: { contrast: 0.2000001, tone: 0.1 } });
  assert.equal(second, first);
  assert.equal(calls, 17 ** 3, "the function is not run again");
  assert.notEqual(functionLut({ name: "test-cache", color, parameters: { tone: 0.2, contrast: 0.2 } }), first);
  assert.throws(() => functionLut({ name: "test-cache", color, size: 20 }), /use 17 or 33/);
  assert.throws(() => functionLut({ name: "test-bad", color: () => [0, Number.NaN, 0] }), /three numbers/);
});
