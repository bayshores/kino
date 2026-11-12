// color-look: eight ready-made looks with an amount, drawn as a generated LUT.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "../../backend/chromium-raster.mjs";
import { effectDefaults, effectDefinition } from "./catalog.js";
import { COLOR_LOOKS, COLOR_LOOK_NAMES, SECTION_GRADE, colorLookColor, sectionGradeColor, sectionGradeStops } from "./colorLook.js";
import { hexRgb01, keepOf } from "./relight.js";

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
  assert.equal(COLOR_LOOK_NAMES.length, 9);
  for (const look of Object.keys(COLOR_LOOKS)) {
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

test("section-grade relights in one hue, keeps skin partly its own, lifts black and blooms", async () => {
  const stops = sectionGradeStops(SECTION_GRADE.hue);
  const settings = { stops, levels: null, keep: keepOf({ keep: "skin", keepAmount: 0.6 }, hexRgb01), blackLift: 0.04 };
  const keepless = { ...settings, keep: null };
  // Skin (a peach face) keeps more red than the same brightness of gray does.
  const face = sectionGradeColor(0.94, 0.76, 0.63, settings), plain = sectionGradeColor(0.94, 0.76, 0.63, keepless);
  assert.ok(face[0] - face[1] > plain[0] - plain[1] + 0.1, `skin kept: ${face} vs ${plain}`);
  // Black lands at blackLift; a gray wall takes the hue (green over red at hue 160).
  assert.ok(Math.abs(Math.min(...sectionGradeColor(0, 0, 0, settings)) - 0.04) < 0.03);
  const wall = sectionGradeColor(0.4, 0.4, 0.4, settings);
  assert.ok(wall[1] > wall[0] + 0.05, `wall ${wall}`);
  // Normalize: a dim picture (luma 0.1..0.5) uses the whole ramp.
  const lifted = sectionGradeColor(0.5, 0.5, 0.5, { ...keepless, levels: [0.1, 0.5] });
  assert.ok(Math.max(...lifted) > 0.8, `top of the range reaches the light stop: ${lifted}`);
  // One call draws the grade and a bloom glow.
  const drawn = await draw({ look: "section-grade", bloom: 0 });
  assert.ok(drawn[2][1] > drawn[2][0], "gray swatch drawn in the hue");
  const svg = effectDefinition("color-look").render({ content: "<rect/>", bounds: { x: 0, y: 0, width: 8, height: 1 },
    parameters: { look: "section-grade", amount: 1 }, time: 0, progress: 0, helpers: { id: (kind) => kind, defs: [] } });
  assert.match(svg, /filter/);
});
