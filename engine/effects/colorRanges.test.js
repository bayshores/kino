// color-ranges: per hue range hue, saturation and lightness, plus highlights and shadows, drawn as a generated LUT.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "../../backend/chromium-raster.mjs";
import { effectDefaults, effectDefinition } from "./catalog.js";
import { rangeWeights } from "./colorRanges.js";

let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-color-ranges-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const render = (parameters, content) => effectDefinition("color-ranges").render({ content, bounds: { x: 0, y: 0, width: 1, height: 1 },
  parameters: { ...effectDefaults("color-ranges"), ...parameters }, time: 0, progress: 0, helpers: { id: (kind) => `${kind}-1`, defs: [] } });

// Draws the effect over a row of 1x1 swatches (0..255 triples); returns [r, g, b] per pixel.
async function draw(parameters, colors) {
  const defs = [];
  let sequence = 0;
  const width = colors.length;
  const content = colors.map(([r, g, b], x) => `<rect x="${x}" width="1" height="1" fill="rgb(${r},${g},${b})"/>`).join("");
  const output = effectDefinition("color-ranges").render({ content, bounds: { x: 0, y: 0, width, height: 1 },
    parameters: { ...effectDefaults("color-ranges"), ...parameters }, time: 0, progress: 0, helpers: { id: (kind) => `${kind}-${++sequence}`, defs } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1" viewBox="0 0 ${width} 1"><defs>${defs.join("")}</defs>${output}</svg>`;
  const image = await loadImage((await chromium.render(svg, width, 1)).buffer);
  const canvas = createCanvas(width, 1);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, 1).data;
  return colors.map((_, x) => [...pixels.subarray(x * 4, x * 4 + 3)]);
}

const spread = (rgb) => Math.max(...rgb) - Math.min(...rgb);
const largestError = (drawn, expected) => Math.max(...drawn.flatMap((pixel, index) => pixel.map((value, channel) => Math.abs(value - expected[index][channel]))));

test("every default is 0 and changes nothing; neighboring ranges blend", () => {
  const content = '<rect width="1" height="1" fill="#C04020"/>';
  assert.equal(render({}, content), content);
  assert.equal(render({ mix: 0.5 }, content), content);
  assert.deepEqual(rangeWeights(0).slice(0, 2), [1, 0]);
  assert.deepEqual(rangeWeights(15).slice(0, 2), [0.5, 0.5]);
  assert.deepEqual([rangeWeights(330)[0], rangeWeights(330)[7]], [0.5, 0.5]);
});

test("red saturation -1 greys pure red and leaves pure blue within 2/255", async () => {
  const [red, blue] = await draw({ redSaturation: -1 }, [[255, 0, 0], [0, 0, 255]]);
  assert.ok(spread(red) <= 2, `red became ${red}`);
  assert.ok(Math.abs(red[0] - 54) <= 2, `red keeps its luma: ${red}`);
  assert.ok(largestError([blue], [[0, 0, 255]]) <= 2, `blue became ${blue}`);
});

test("greys stay grey under every range setting", async () => {
  const greys = [];
  for (let value = 0; value <= 255; value += 15) greys.push([value, value, value]);
  const parameters = {};
  for (const name of ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"])
    Object.assign(parameters, { [`${name}Hue`]: 120, [`${name}Saturation`]: 1, [`${name}Lightness`]: -0.6 });
  const drawn = await draw(parameters, greys);
  assert.ok(largestError(drawn, greys) <= 2, `greys moved by ${largestError(drawn, greys)}/255`);
});

test("highlights +0.5 brightens a 0.9 grey more than a 0.2 grey", async () => {
  const [light, dark] = await draw({ highlights: 0.5 }, [[230, 230, 230], [51, 51, 51]]);
  assert.ok(light[0] - 230 >= 5, `0.9 grey became ${light}`);
  assert.ok(light[0] - 230 > dark[0] - 51, `0.9 grey +${light[0] - 230}, 0.2 grey +${dark[0] - 51}`);
  assert.ok(spread(light) <= 1 && spread(dark) <= 1);
});
