// color-look: eight ready-made looks with an amount, drawn as a generated LUT.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "../../backend/chromium-raster.mjs";
import { effectDefaults, effectDefinition } from "./catalog.js";
import { COLOR_LOOKS, COLOR_LOOK_NAMES, colorLookColor } from "./colorLook.js";

let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-color-look-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const SWATCHES = [[0, 0, 0], [40, 30, 60], [128, 128, 128], [220, 90, 40], [60, 140, 200], [90, 170, 80], [245, 235, 220], [255, 255, 255]];

// Draws the effect over a row of 1x1 swatches; returns [r, g, b] per pixel.
async function draw(parameters) {
  const defs = [];
  let sequence = 0;
  const width = SWATCHES.length;
  const content = SWATCHES.map(([r, g, b], x) => `<rect x="${x}" width="1" height="1" fill="rgb(${r},${g},${b})"/>`).join("");
  const output = effectDefinition("color-look").render({ content, bounds: { x: 0, y: 0, width, height: 1 },
    parameters: { ...effectDefaults("color-look"), ...parameters }, time: 0, progress: 0, helpers: { id: (kind) => `${kind}-${++sequence}`, defs } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1" viewBox="0 0 ${width} 1"><defs>${defs.join("")}</defs>${output}</svg>`;
  const image = await loadImage((await chromium.render(svg, width, 1)).buffer);
  const canvas = createCanvas(width, 1);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, 1).data;
  return SWATCHES.map((_, x) => [...pixels.subarray(x * 4, x * 4 + 3)]);
}
const largestError = (drawn, expected) => Math.max(...drawn.flatMap((pixel, index) => pixel.map((value, channel) => Math.abs(value - expected[index][channel]))));

test("amount 0 draws the layer as it was within 1/255", async () => {
  assert.equal(effectDefinition("color-look").render({ content: "<rect/>", parameters: { look: "ink", amount: 0 } }), "<rect/>");
  assert.ok(largestError(await draw({ look: "ember", amount: 0 }), SWATCHES) <= 1);
});

test("each look renders its own colors, and amount 0.5 lands halfway", async () => {
  assert.equal(COLOR_LOOK_NAMES.length, 8);
  for (const look of COLOR_LOOK_NAMES) {
    const drawn = await draw({ look });
    const expected = SWATCHES.map(([r, g, b]) => colorLookColor(r / 255, g / 255, b / 255, COLOR_LOOKS[look]).map((value) => value * 255));
    assert.ok(largestError(drawn, expected) <= 4, `${look} is off by ${largestError(drawn, expected)}/255`);
    assert.ok(largestError(drawn, SWATCHES) >= 8, `${look} barely changes the swatches`);
  }
  const half = await draw({ look: "frost", amount: 0.5 });
  const full = await draw({ look: "frost" });
  const middle = SWATCHES.map((swatch, index) => swatch.map((value, channel) => (value + full[index][channel]) / 2));
  assert.ok(largestError(half, middle) <= 2);
});
