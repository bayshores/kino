import assert from "node:assert/strict";
import test from "node:test";
import { colorStats, framePixels, matchParameters, oklab, skinWeight, solveMatch } from "./colorMatch.js";
import { liftGammaGain, saturationMatrix } from "./colorMath.js";

// A lightness ramp with a greenish top band and a bluish bottom band (FilmCraft's test frame), as sRGB bytes.
function frame(grade = null, skin = false) {
  const width = 96, height = 54, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const t = x / width;
    let rgb = [t, t * 0.95 + 0.02, t * 0.9 + 0.03];
    if (y < height / 3) rgb = [rgb[0] * 0.75, rgb[1] * 1.05, rgb[2] * 0.8];
    else if (y > (2 * height) / 3) rgb = [rgb[0] * 0.85, rgb[1] * 0.9, rgb[2] * 1.1];
    if (skin && x >= 30 && x < 60 && y >= 20 && y < 35) rgb = [0.78, 0.6, 0.5];
    if (grade) {
      rgb = rgb.map((value, channel) => liftGammaGain(Math.min(1, value), grade[channel], 1 + grade[3 + channel], 1 + grade[6 + channel]));
      rgb = saturationMatrix(1 + grade[9]).map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
    }
    data.set([...rgb.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255)), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test("Oklab and skin weights match FilmCraft's reference values", () => {
  const white = oklab([1, 1, 1]);
  assert.ok(Math.abs(white[0] - 1) < 1e-3 && Math.abs(white[1]) < 1e-3 && Math.abs(white[2]) < 1e-3);
  const red = oklab([1, 0, 0]);
  assert.ok(Math.abs(red[0] - 0.6279) < 2e-3 && Math.abs(red[1] - 0.2249) < 2e-3 && Math.abs(red[2] - 0.1258) < 2e-3);
  assert.ok(skinWeight(oklab([0.55, 0.32, 0.22])) > 0.9);
  assert.equal(skinWeight(oklab([0.2, 0.3, 0.8])), 0);
});

test("color match: a shot matched to itself gets no grade; a known grade is recovered", () => {
  const plain = framePixels([frame()]);
  const same = solveMatch(plain, plain);
  assert.ok(same.before < 1e-4 && same.x.every((value) => Math.abs(value) < 0.02), JSON.stringify(same));
  // Warm highlights, cool shadows, a little more saturation.
  const truth = [-0.04, 0.0, 0.06, 0, 0, 0, 0.12, 0.03, -0.1, 0.25];
  const reference = framePixels([frame(truth)]);
  const match = solveMatch(plain, reference);
  assert.ok(match.after < match.before * 0.2, JSON.stringify(match));
  const out = colorStats(plain, match.x), want = colorStats(reference);
  for (let band = 0; band < 3; band += 1) for (let channel = 1; channel < 4; channel += 1)
    assert.ok(Math.abs(out.bands[band][channel] - want.bands[band][channel]) < 0.02, `band ${band} channel ${channel}`);
  const { wheels, saturation } = matchParameters(match.x);
  assert.ok(wheels.gainRed > wheels.gainBlue && saturation > 1, JSON.stringify({ wheels, saturation }));
});

test("color match keeps the shot's skin hue within 8 degrees", () => {
  const shot = framePixels([frame(null, true)]);
  const teal = framePixels([frame([-0.2, 0.1, 0.2, 0, 0, 0, -0.3, 0.1, 0.3, 0], true)]);
  const hue = (stats) => Math.atan2(stats.skin[1], stats.skin[0]) * 180 / Math.PI;
  const protectedMatch = solveMatch(shot, teal);
  assert.ok(Math.abs(hue(colorStats(shot, protectedMatch.x)) - hue(colorStats(shot))) <= 8.5);
});

test("match_color adds a named color-wheels and saturation grade, and replaces it when run again", async () => {
  const { runMatchColor } = await import("../../backend/agent/color-operation.mjs");
  const { createDocument, createLayer, createScene } = await import("../model.js");
  const scene = createScene({ id: "s", duration: 4, layers: [
    createLayer("image", { id: "walk", name: "walk", src: "/api/media/a.png" }),
    createLayer("image", { id: "stock", name: "stock", src: "/api/media/b.png" })] });
  let document = createDocument({ scenes: [scene] });
  const frames = async (layer) => [layer.id === "stock" ? frame([-0.04, 0, 0.06, 0, 0, 0, 0.12, 0.03, -0.1, 0.25]) : frame()];
  const reports = new Map();
  const operation = { type: "match_color", sceneId: "s", layerIds: ["walk"], toId: "stock" };
  for (let run = 0; run < 2; run += 1)
    document = await runMatchColor(document, operation, { frames, reports, operationContext: async () => ({}) });
  const effects = document.scenes[0].layers.find((layer) => layer.id === "walk").animations;
  assert.deepEqual(effects.map((animation) => [animation.name, animation.effect]), [["Color match", "color-wheels"], ["Color match saturation", "hue-saturation"]]);
  assert.ok(effects[0].to.gainRed > effects[0].to.gainBlue && effects[1].to.saturation > 1);
  assert.match(reports.get(operation).summary, /walk matched to stock: color distance/);
});
