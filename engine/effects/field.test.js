// The field effect: an expression per grid point that cuts (alpha), tints (color) or moves
// (displace) a layer's pixels; a bad expression is refused; a still expression keeps one map.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { effectDefaults, effectDefinition, normalizeEffectParameters } from "./catalog.js";
import { normalizeEffectAnimation } from "./animation.js";
import { fieldAlpha } from "./field.js";

const W = 64, H = 40;
// Red above y 20, blue below.
const SOURCE = `<rect width="${W}" height="20" fill="#E03020"/><rect y="20" width="${W}" height="20" fill="#2040E0"/>`;

function draw(parameters, { time = 0, raster = true, bounds = { x: 0, y: 0, width: W, height: H } } = {}) {
  let sequence = 0;
  const defs = [];
  const output = effectDefinition("field").render({ content: SOURCE, bounds, parameters: { ...effectDefaults("field"), ...parameters },
    time, progress: 1, helpers: { id: (kind) => `t-${kind}-${++sequence}`, defs, raster, transform: [1, 0, 0, 1, 0, 0] } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { markup: defs.join("") + output, pixels: raster ? new Resvg(svg).render().pixels : null };
}
const at = (pixels, x, y) => [...pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const near = (actual, expected, tolerance, label) =>
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance), `${label}: ${actual} near ${expected}`);
const RED = [224, 48, 32, 255], BLUE = [32, 64, 224, 255];

test("field settings: defaults, a bad expression refused with the parser's message, fixed expressions", () => {
  assert.deepEqual(effectDefaults("field"), { use: "alpha", expression: "noise(u*10, v*10)*0.7 + noise(u*40, v*40)*0.3", expressionY: "",
    amount: 20, threshold: 0.5, softness: 0.05, color: "#000000", a: 0, b: 0, c: 0, seed: 0, grid: 128 });
  assert.throws(() => normalizeEffectParameters("field", { expression: "u + wobble" }), /parameters\.expression: unknown name "wobble"; allowed names: inputs u, v, t, seed, a, b, c/);
  assert.throws(() => normalizeEffectParameters("field", { expression: "sin(u" }), /parameters\.expression: .*\(at character/);
  assert.throws(() => normalizeEffectParameters("field", { expression: "" }), /the expression is empty/);
  assert.throws(() => normalizeEffectParameters("field", { expression: 3 }), /must be text/);
  assert.equal(normalizeEffectParameters("field", { expressionY: "" }).expressionY, "");
  assert.throws(() => normalizeEffectParameters("field", { grid: 8 }), /from 16 to 256/);
  assert.throws(() => normalizeEffectAnimation({ kind: "effect", effect: "field", start: 0, duration: 1,
    from: { expression: "u" }, to: { expression: "v" } }), /from\.expression must equal to\.expression/);
});

test("alpha cuts the layer where the field is below threshold; 0 keeps all and 1 cuts all", () => {
  const { pixels } = draw({ use: "alpha", expression: "u", threshold: 0.5, softness: 0 });
  assert.equal(at(pixels, 10, 10)[3], 0, "left of the middle is cut");
  near(at(pixels, 54, 10), RED, 1, "right of the middle is kept");
  near(at(pixels, 54, 30), BLUE, 1, "kept below too");
  assert.deepEqual(draw({ use: "alpha", expression: "u", threshold: 0, softness: 0.2 }).pixels, draw({ use: "alpha", expression: "1", threshold: 0, softness: 0.2 }).pixels);
  near(at(draw({ use: "alpha", expression: "u", threshold: 0, softness: 0.2 }).pixels, 1, 10), RED, 1, "threshold 0 keeps even f = 0");
  assert.ok(draw({ use: "alpha", expression: "u", threshold: 1, softness: 0.2 }).pixels.every((value, index) => index % 4 !== 3 || value === 0), "threshold 1 cuts all");
  assert.deepEqual([0, 0.45, 0.55, 1].map((f) => fieldAlpha(f, 0.5, 0)), [0, 0, 1, 1]);
});

test("color mixes toward the color by the field", () => {
  const { pixels } = draw({ use: "color", expression: "u", color: "#00FF00" });
  near(at(pixels, 0, 10), RED, 8, "f near 0 leaves the layer");
  near(at(pixels, 63, 10), [0, 255, 0, 255], 8, "f near 1 is the color");
  near(at(pixels, 32, 30), [16, 160, 112, 255], 10, "the middle is half way");
});

test("displace moves pixels by (expression, expressionY), or toward an angle", () => {
  const plain = draw({ use: "displace", amount: 0 }).pixels;
  near(at(plain, 32, 14), RED, 0, "amount 0 changes nothing");
  const moved = draw({ use: "displace", expression: "0", expressionY: "1", amount: 10 }).pixels;
  near(at(moved, 32, 14), BLUE, 2, "y 1 shows the pixel 10 px below");
  near(at(moved, 32, 4), RED, 2, "far from the edge stays red");
  const angle = draw({ use: "displace", expression: "pi/2", amount: 10 }).pixels;
  assert.deepEqual(at(angle, 32, 14), at(moved, 32, 14), "angle pi/2 is straight down, as y 1");
});

test("a field that reads no time keeps one map; one that reads t or a draws a new one", () => {
  const still = { use: "alpha", expression: "noise(u*4, v*4)" };
  assert.equal(draw(still, { time: 0.2, raster: false }).markup, draw({ ...still, a: 5 }, { time: 1.7, raster: false }).markup);
  const moving = { use: "alpha", expression: "noise(u*4, v*4, t*a)", a: 1 };
  assert.notEqual(draw(moving, { time: 0.2, raster: false }).markup, draw(moving, { time: 1.7, raster: false }).markup);
  assert.notEqual(draw(moving, { time: 0.2, raster: false }).markup, draw({ ...moving, a: 2 }, { time: 0.2, raster: false }).markup);
  assert.notEqual(draw(still, { raster: false }).markup, draw({ ...still, seed: 3 }, { raster: false }).markup, "another seed is another field");
});

test("build time per frame at the default grid on a 1080p layer stays under 30 ms", () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  for (const [use, expression, expressionY] of [["alpha", "noise(u*10, v*10, t)*0.7 + noise(u*40, v*40, t)*0.3", ""],
    ["color", "0.5 + 0.5*sin(length(u - 0.5, v - 0.5)*tau*6 - t*4)", ""], ["displace", "0", "sin(u*tau*2 + t*3)"]]) {
    const times = [];
    for (let frame = 0; frame < 15; frame += 1) {
      const started = performance.now();
      effectDefinition("field").render({ content: SOURCE, bounds, parameters: { ...effectDefaults("field"), use, expression, expressionY },
        time: frame / 30, progress: 1, helpers: { id: (kind) => `p-${kind}-${frame}`, defs: [], raster: false } });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    console.log(`field ${use}: ${median.toFixed(1)} ms a frame (median of 15, grid 128)`);
    assert.ok(median < 30, `${use} builds a frame in ${median.toFixed(1)} ms`);
  }
});
