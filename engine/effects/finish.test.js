// Grain and vignette: their settings, grain that is the same for the same seed and time and new
// each step when animated, and a vignette that darkens toward the corners of the layer's pixels.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { effectDefaults, effectDefinition, normalizeEffectParameters } from "./catalog.js";
import { grainPlacement, vignetteShade } from "./finish.js";
import { libraryCatalog } from "../../backend/agent/library-catalog.mjs";

const W = 64, H = 40;
// Dark, middle and light bands, with a see-through strip at the bottom.
const SOURCE = `<rect width="${W}" height="30" fill="#7090B0"/><rect width="20" height="30" fill="#141418"/><rect x="44" width="20" height="30" fill="#F0ECE4"/>`;

function draw(key, parameters, { time = 0, content = SOURCE } = {}) {
  let sequence = 0;
  const defs = [];
  const output = effectDefinition(key).render({ content, bounds: { x: 0, y: 0, width: W, height: H }, parameters: { ...effectDefaults(key), ...parameters },
    time, progress: 1, helpers: { id: (kind) => `t-${kind}-${++sequence}`, defs, raster: true, transform: [1, 0, 0, 1, 0, 0] } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { output, markup: defs.join("") + output, pixels: new Resvg(svg).render().pixels };
}
const at = (pixels, x, y) => [...pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const differs = (a, b) => a.some((value, index) => value !== b[index]);
const luma = (pixels, x, y) => { const [r, g, b] = at(pixels, x, y); return (r + g + b) / 3; };

test("grain and vignette settings: defaults, limits and the library entries", () => {
  assert.deepEqual(effectDefaults("grain"), { amount: 0.35, size: 1.5, seed: 0, monochrome: true, animated: true, rate: 30 });
  assert.deepEqual(effectDefaults("vignette"), { amount: 0.5, midpoint: 0.6, roundness: 0, feather: 0.6, color: "#000000" });
  for (const key of ["grain", "vignette"]) assert.equal(effectDefinition(key).parameters.mix.default, 1, `${key} has mix`);
  assert.throws(() => normalizeEffectParameters("grain", { size: 9 }), /from 0.5 to 8/);
  assert.throws(() => normalizeEffectParameters("grain", { rate: 2.5 }), /integer from 1 to 60/);
  assert.throws(() => normalizeEffectParameters("grain", { seed: -1 }), /integer from 0 to 1000000/);
  assert.throws(() => normalizeEffectParameters("vignette", { roundness: 1.5 }), /from -1 to 1/);
  assert.equal(normalizeEffectParameters("vignette", { color: "#fff" }).color, "#FFFFFF");
  const entries = libraryCatalog().entries;
  for (const key of ["grain", "vignette"])
    assert.deepEqual(entries.find((entry) => entry.id === `effect:${key}`)?.tags, [key], `${key} is tagged in the library`);
});

test("grain: the same seed and time draw the same grain; animated grain changes each step, still grain never", () => {
  const first = draw("grain", { seed: 7 }, { time: 0.2 });
  assert.equal(draw("grain", { seed: 7 }, { time: 0.2 }).markup, first.markup);
  assert.deepEqual(draw("grain", { seed: 7 }, { time: 0.2 }).pixels, first.pixels);
  // Rate 30: one step a frame at 30 fps, so every frame of a 30 fps video differs from the last.
  for (let frame = 0; frame < 4; frame += 1) {
    const now = draw("grain", { seed: 7 }, { time: frame / 30 }).pixels, next = draw("grain", { seed: 7 }, { time: (frame + 1) / 30 }).pixels;
    assert.ok(differs(now, next), `frame ${frame} and ${frame + 1} differ`);
  }
  assert.notEqual(grainPlacement({ parameters: { seed: 7 }, time: 0, bounds: { x: 0, y: 0, width: W, height: H } }).variant,
    grainPlacement({ parameters: { seed: 7 }, time: 1 / 30, bounds: { x: 0, y: 0, width: W, height: H } }).variant, "the next step shows another tile");
  assert.deepEqual(draw("grain", { seed: 7, animated: false }, { time: 0 }).pixels, draw("grain", { seed: 7, animated: false }, { time: 2.5 }).pixels);
  assert.ok(differs(draw("grain", { seed: 7 }).pixels, draw("grain", { seed: 8 }).pixels), "another seed is other grain");
});

test("grain varies the picture around its own tone, keeps its shape, and amount 0 leaves it alone", () => {
  assert.equal(draw("grain", { amount: 0 }).output, SOURCE);
  const plain = draw("grain", { amount: 0 }).pixels, grained = draw("grain", { amount: 0.8 }).pixels;
  let changed = 0, total = 0, sum = 0;
  for (let y = 2; y < 28; y += 1) for (let x = 24; x < 40; x += 1) {
    total += 1; if (differs(at(grained, x, y), at(plain, x, y))) changed += 1;
    sum += luma(grained, x, y) - luma(plain, x, y);
  }
  assert.ok(changed > total * 0.8, `most pixels change (${changed}/${total})`);
  assert.ok(Math.abs(sum / total) < 8, `the mean tone stays (${sum / total})`);
  for (let x = 0; x < W; x += 7) assert.equal(at(grained, x, 35)[3], 0, "the see-through strip stays see-through");
  assert.equal(at(grained, 30, 10)[3], 255);
  // Color grain moves the channels apart; monochrome keeps them together on a gray.
  const gray = `<rect width="${W}" height="${H}" fill="#808080"/>`;
  const mono = draw("grain", { amount: 1 }, { content: gray }).pixels, colored = draw("grain", { amount: 1, monochrome: false }, { content: gray }).pixels;
  const spread = (pixels) => { let most = 0; for (let x = 0; x < W; x += 3) { const [r, g, b] = at(pixels, x, 20); most = Math.max(most, Math.max(r, g, b) - Math.min(r, g, b)); } return most; };
  assert.ok(spread(mono) <= 2 && spread(colored) > 20, `mono ${spread(mono)}, color ${spread(colored)}`);
});

test("vignette: clear in the middle, darkest at the corners, in its color, only on the layer's pixels", () => {
  const shape = { width: 16, height: 9, midpoint: 0.6, roundness: 0, feather: 0.6 };
  assert.equal(vignetteShade(0, 0, shape), 0);
  assert.equal(vignetteShade(1, 1, shape), 1);
  assert.equal(vignetteShade(0.5, 0.5, { ...shape, feather: 0 }), 0, "a hard edge, inside the midpoint");
  // Roundness 1 is a circle: on a wide layer the top middle is nearer than the left middle.
  assert.ok(vignetteShade(0, -1, { ...shape, roundness: 1 }) < vignetteShade(-1, 0, { ...shape, roundness: 1 }));
  assert.ok(vignetteShade(0.9, 0.9, { ...shape, roundness: -1 }) > vignetteShade(0.9, 0.9, shape) - 1e-9, "a rounded rectangle reaches the corners");
  const content = `<rect width="${W}" height="${H}" fill="#C0C0C0"/>`;
  assert.equal(draw("vignette", { amount: 0 }, { content }).output, content);
  const dark = draw("vignette", { amount: 1 }, { content }).pixels;
  assert.ok(luma(dark, 32, 20) > 185 && luma(dark, 1, 1) < 40, `middle ${luma(dark, 32, 20)}, corner ${luma(dark, 1, 1)}`);
  const white = draw("vignette", { amount: 1, color: "#FFFFFF" }, { content }).pixels;
  assert.ok(luma(white, 1, 1) > 240);
  const holed = draw("vignette", { amount: 1 }).pixels;
  assert.equal(at(holed, 1, 38)[3], 0, "the see-through corner stays see-through");
});
