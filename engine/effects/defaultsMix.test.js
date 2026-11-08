// Mix on every effect, seeds on random effects, and the defaults that used to break a picture.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { EFFECTS, effectDefaults, effectDefinition, MIX_DOCUMENTATION, normalizeEffectParameters } from "./catalog.js";
import { describeOperation } from "../../backend/operation-guide.mjs";
import { effectsAt } from "./animation.js";

const W = 48, H = 32;
// Dark to light bars with colored stripes: enough detail to see warps and tone changes.
const SOURCE = Array.from({ length: 8 }, (_, index) =>
  `<rect x="${index * 6}" width="6" height="${H}" fill="rgb(${index * 32},${index * 30},${index * 28})"/>`).join("") +
  '<rect y="12" width="48" height="3" fill="#E94F64"/><circle cx="30" cy="22" r="6" fill="#06D6A0"/>';

function draw(key, parameters, { content = SOURCE, raster = true, time = 0.5 } = {}) {
  let sequence = 0;
  const defs = [];
  const output = effectDefinition(key).render({ content, bounds: { x: 0, y: 0, width: W, height: H }, parameters, time, progress: 1,
    helpers: { id: (kind) => `t-${kind}-${++sequence}`, defs, raster, transform: [1, 0, 0, 1, 0, 0] } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { output, markup: defs.join("") + output, pixels: new Resvg(svg).render().pixels };
}
const source = () => draw("color-grade", {}).pixels; // the identity grade draws the source as it is
const at = (pixels, x, y) => [...pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const meanDifference = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;

test("every effect has mix 0..1, default 1, stored only when given", () => {
  for (const effect of EFFECTS) {
    const field = effect.parameters.mix;
    assert.deepEqual([field?.type, field?.default, field?.min, field?.max], ["number", 1, 0, 1], `${effect.key} has mix`);
    assert.equal("mix" in effectDefaults(effect.key), false, `${effect.key} defaults leave mix out`);
  }
  assert.ok(JSON.stringify(describeOperation({ topic: "effects" })).includes(MIX_DOCUMENTATION), "the effects guide says it once");
  assert.equal(normalizeEffectParameters("bulge", { mix: 0.4 }).mix, 0.4);
  assert.throws(() => normalizeEffectParameters("bulge", { mix: 1.2 }), /from 0 to 1/);
  // A saved effect without mix samples no mix (draws as before); one with mix samples it.
  const layer = (to) => ({ id: "a", type: "rectangle", animations: [{ id: "e", kind: "effect", effect: "glow", start: 0, duration: 1, to }] });
  assert.equal("mix" in effectsAt(layer(effectDefaults("glow")), 0.5)[0].parameters, false);
  assert.equal(effectsAt(layer({ ...effectDefaults("glow"), mix: 0.25 }), 0.5)[0].parameters.mix, 0.25);
});

test("mix cross-fades the effect with the layer as it was", () => {
  const black = { exposure: 0 };
  assert.equal(draw("color-grade", { ...black, mix: 1 }).output, draw("color-grade", black).output, "mix 1 draws exactly as before");
  assert.equal(draw("color-grade", { ...black, mix: 0 }).output, SOURCE);
  const half = draw("color-grade", { ...black, mix: 0.5 }).pixels, original = source();
  for (const [x, y] of [[40, 4], [30, 22], [20, 13]])
    for (let channel = 0; channel < 3; channel++)
      assert.ok(Math.abs(at(half, x, y)[channel] - at(original, x, y)[channel] / 2) <= 2, `half of the source at ${x},${y}`);
  // In the app and exports the two are added (plus-lighter) so a see-through layer mixes exactly too.
  const { output } = draw("color-grade", { ...black, mix: 0.3 }, { raster: false });
  assert.match(output, /opacity="0.7"[^>]*>.*opacity="0.3" style="mix-blend-mode:plus-lighter"/s);
  assert.equal((output.match(/<circle/g) ?? []).length, 2, "the layer under the effect is a copy");
});

test("the fixed defaults: dot grid in two tones, warps that keep the picture, luma highlight with a color", () => {
  const dots = effectDefaults("dot-grid");
  assert.notEqual(dots.shadowColor, dots.highlightColor);
  const drawn = draw("dot-grid", { ...dots, gridRepetition: 8 }).pixels;
  const colors = new Set();
  for (let offset = 0; offset < drawn.length; offset += 4) if (drawn[offset + 3] > 250) colors.add(drawn.slice(offset, offset + 3).join());
  assert.ok(colors.size > 2, "the default dots follow the picture's tones");

  // The new defaults change the picture far less than the old ones did (they shredded it).
  const original = source();
  for (const [key, old] of [["fluid-warp", { amount: 25, octaves: 4 }], ["ripple", { strength: 0.18, frequency: 8, sharpness: 6 }]]) {
    const now = meanDifference(draw(key, effectDefaults(key)).pixels, original);
    const before = meanDifference(draw(key, { ...effectDefaults(key), ...old }).pixels, original);
    assert.ok(now > 0 && now < before * 0.6, `${key}: ${now.toFixed(1)} vs ${before.toFixed(1)}`);
  }

  const luma = effectDefaults("luma-highlight");
  const lit = draw("luma-highlight", luma).pixels;
  assert.deepEqual(at(lit, 45, 4), at(original, 45, 4), "the default leaves bright tones alone");
  const red = draw("luma-highlight", { ...luma, lumaThreshold: 0.4, fuzzWidth: 0, fuzzIntensity: 1, color: "#FF0000" }).pixels;
  assert.deepEqual(at(red, 2, 4).slice(0, 3), [255, 0, 0], "dark tones turn the chosen color");
});

test("color grade: neutral defaults, exposure is a gain in linear light, not brightness", () => {
  assert.deepEqual(effectDefaults("color-grade"), { exposure: 1, brightness: 1, contrast: 1, saturation: 1 });
  const gray = '<rect width="48" height="32" fill="#404040"/>';
  const exposed = at(draw("color-grade", { exposure: 2 }, { content: gray }).pixels, 1, 1)[0];
  const brighter = at(draw("color-grade", { brightness: 2 }, { content: gray }).pixels, 1, 1)[0];
  assert.ok(Math.abs(exposed - 90) <= 2, `one stop up from 64 is about 90 in sRGB (got ${exposed})`);
  assert.ok(Math.abs(brighter - 128) <= 2, `brightness 2 doubles the sRGB value (got ${brighter})`);
});

test("seeds: the default draws as before, another seed draws another pattern", () => {
  for (const [key, extra, before] of [["pixelate", { noiseEnabled: true }, 17], ["grid-scroll-x", {}, 71], ["grid-scroll-y", {}, 83],
    ["fluid-warp", {}, 0], ["noise-warp", {}, 0]]) {
    const field = effectDefinition(key).parameters.seed;
    assert.deepEqual([field.default, field.animatable, field.optional], [before, false, true], `${key} seed`);
    assert.equal("seed" in effectDefaults(key), false, "saved effects without a seed stay as they were");
    const withoutSeed = { ...effectDefaults(key), ...extra }, settings = { ...withoutSeed, seed: before };
    const drawn = draw(key, settings).markup;
    assert.equal(drawn, draw(key, withoutSeed).markup, `${key} seed ${before} is the old pattern`);
    assert.notEqual(draw(key, { ...settings, seed: before + 5 }).markup, drawn, `${key} seed changes the pattern`);
  }
});
