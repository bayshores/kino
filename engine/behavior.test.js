import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { effectsAt } from "./effects/animation.js";
import { behaviorOffset, waveAt, wiggleOffset } from "./behavior.js";

// A layer whose animations went through the document checks (model.js normalizeAnimation).
function checked(animations) {
  const layer = createLayer("rectangle", { id: "box", x: 100, y: 50, animations });
  return parseDocument(createDocument({ scenes: [createScene({ duration: 6, layers: [layer] })] })).scenes[0].layers[0];
}
const custom = (behavior, extra = {}) => ({ id: "a", name: "T", kind: "custom", start: 1, duration: 4, easing: "linear", from: {}, to: {}, behavior, ...extra });
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("oscillate adds a wave of each shape, with phase and decay, held after the animation", () => {
  const layer = checked([custom({ oscillate: { amount: { x: 10 }, period: 2 } })]);
  assert.deepEqual(layer.animations[0].behavior, { oscillate: { amount: { x: 10 }, period: 2, phase: 0, wave: "sine", decay: 0 } });
  assert.deepEqual(layer.animations[0].to, { x: 100 }, "a named key joins from and to at the layer's value");
  for (const [t, x] of [[0.5, 100], [1, 100], [1.5, 110], [2, 100], [2.5, 90], [5, 100], [6, 100]]) near(evaluateLayer(layer, t).x, x, `sine at ${t}`);
  assert.deepEqual([0, 0.125, 0.25, 0.5, 0.75, 0.875].map((c) => waveAt("triangle", c)), [0, 0.5, 1, 0, -1, -0.5]);
  assert.deepEqual([0, 0.49, 0.5, 0.99].map((c) => waveAt("square", c)), [1, 1, -1, -1]);
  assert.deepEqual([0, 0.25, 0.5, 0.75].map((c) => waveAt("saw", c)), [0, 0.5, -1, -0.5]);
  near(behaviorOffset({ oscillate: { amount: 4, period: 1, phase: 0.25, wave: "sine", decay: 0 } }, "y", 0, 3), 4, "phase a quarter starts at the top");
  near(behaviorOffset({ oscillate: { amount: 4, period: 1, phase: 0.25, wave: "sine", decay: 2 } }, "y", 1, 3), 4 * Math.exp(-2), "decay per second");
  const square = checked([custom({ oscillate: { amount: { rotation: 5 }, period: 1, wave: "square" } })]);
  assert.notEqual(evaluateLayer(square, 1.4)._stepsAt, evaluateLayer(square, 1.6)._stepsAt, "a square wave marks its jump for Lottie");
});

test("ramp moves an offset from, to over its own window and holds; it eases", () => {
  const layer = checked([custom({ ramp: { from: { y: -20 }, to: { y: 40 }, start: 1, duration: 2 } })]);
  for (const [t, y] of [[0.5, 50], [1, 30], [2, 30], [3, 60], [4, 90], [5.5, 90]]) near(evaluateLayer(layer, t).y, y, `ramp at ${t}`);
  const whole = checked([custom({ ramp: { to: 8 } }, { from: { rotation: 0 }, to: { rotation: 0 } })]);
  near(evaluateLayer(whole, 3).rotation, 4, "no duration: to the animation's end");
  const eased = checked([custom({ ramp: { to: { x: 100 }, ease: "ease-in" } })]);
  assert.ok(evaluateLayer(eased, 3).x < 150, "an ease-in ramp is behind halfway at half time");
  assert.throws(() => checked([custom({ ramp: { to: { x: 1 }, start: 3, duration: 2 } })]), /at most the animation's duration/);
  assert.throws(() => checked([custom({ ramp: { to: { x: 1 }, from: 2 } })]), /shape of ramp.to/);
  assert.throws(() => checked([custom({ ramp: { to: { x: 1 }, ease: "wobbly" } })]), /ramp.ease/);
});

test("randomize repeats for a seed, stays in range, steps or glides", () => {
  const random = (seed, mode) => checked([custom({ randomize: { amount: { x: 10 }, rate: 4, seed, mode } })]);
  const xs = (layer) => [1.1, 1.3, 2.05, 3.7].map((t) => evaluateLayer(layer, t).x);
  assert.deepEqual(xs(random(5, "stepped")), xs(random(5, "stepped")), "same seed, same values");
  assert.notDeepEqual(xs(random(5, "stepped")), xs(random(6, "stepped")), "another seed, other values");
  const stepped = random(5, "stepped");
  assert.equal(evaluateLayer(stepped, 1.05).x, evaluateLayer(stepped, 1.2).x, "one value per 1/rate seconds");
  assert.notEqual(evaluateLayer(stepped, 1.2).x, evaluateLayer(stepped, 1.3).x);
  assert.notEqual(evaluateLayer(stepped, 1.2)._stepsAt, evaluateLayer(stepped, 1.3)._stepsAt, "a step is marked for Lottie");
  const smooth = random(5, "smooth");
  assert.equal(evaluateLayer(smooth, 1.25).x, evaluateLayer(stepped, 1.25).x, "smooth passes through the stepped values at each knot");
  assert.ok(Math.abs(evaluateLayer(smooth, 1.375).x - evaluateLayer(smooth, 1.37).x) < 1, "smooth glides");
  for (let t = 1; t <= 5; t += 1 / 30) assert.ok(Math.abs(evaluateLayer(smooth, t).x - 100) <= 10);
  assert.notEqual(behaviorOffset({ randomize: { amount: 1, rate: 2, seed: 3, mode: "smooth" } }, "x", 0.3, 1),
    behaviorOffset({ wiggle: { amount: 1, rate: 2, seed: 3 } }, "x", 0.3, 1), "not the wiggle's pattern");
});

test("behaviors move effect settings, clamped to the setting's range, and are refused where they can't", () => {
  const effect = (behavior) => checked([{ id: "e", name: "Hue", kind: "effect", effect: "hue-saturation", start: 1, duration: 2, easing: "linear",
    from: { hue: 0 }, to: { hue: 0, saturation: 1 }, behavior }]);
  const hue = effect({ oscillate: { amount: { hue: 30, saturation: 2 }, period: 2, phase: 0.25 } });
  const at = (layer, t) => effectsAt(layer, t)[0].parameters;
  near(at(hue, 1).hue, 30, "hue at the top of the wave");
  near(at(hue, 2).hue, -30, "half a period later");
  assert.equal(at(hue, 1).saturation, 3, "saturation 1 + 2");
  assert.equal(at(hue, 2).saturation, 0, "1 - 2 clamps to the setting's 0");
  assert.equal(at(effect({ ramp: { to: { lightness: 0.5 } } }), 3).lightness, 0.5);
  assert.throws(() => effect({ oscillate: { amount: 5 } }), /on an effect, name the settings/);
  assert.throws(() => effect({ loop: "cycle" }), /an effect can't loop/);
  assert.throws(() => effect({ wiggle: { amount: { tint: 1 } } }), /hue-saturation has no setting tint that can move/);
  assert.throws(() => checked([custom({ oscillate: { amount: 8 } }, { from: { x: 0, scaleX: 1 }, to: { x: 10, scaleX: 1 } })]), /scaleX is a fraction/);
  assert.throws(() => checked([custom({ oscillate: { amount: { x: 1 }, wave: "zigzag" } })]), /oscillate.wave must be/);
  assert.throws(() => checked([custom({ randomize: { amount: { x: 1 }, mode: "jumpy" } })]), /randomize.mode must be/);
  assert.throws(() => checked([custom({ bounce: {} }, { from: { x: 0 }, to: { x: 1 } })]), /has no bounce/);
});

test("a wiggle decay dies the shake down by e^(-decay * seconds) and is refused when out of range", () => {
  const even = { amount: 10, rate: 3, seed: 7 }, dying = { ...even, decay: 2 };
  assert.equal(wiggleOffset(dying, "x", 0, 2), wiggleOffset(even, "x", 0, 2), "starts at full size");
  assert.ok(Math.abs(wiggleOffset(dying, "x", 1.3, 2) - wiggleOffset(even, "x", 1.3, 2) * Math.exp(-2.6)) < 1e-9);
  const layer = checked([custom({ wiggle: { amount: { x: 10 }, rate: 3, seed: 7, decay: 4 } }, { duration: 2 })]);
  assert.equal(layer.animations[0].behavior.wiggle.decay, 4);
  assert.throws(() => checked([custom({ wiggle: { amount: { x: 10 }, decay: 1000 } }, { duration: 2 })]), /decay/);
});

test("old wiggle and loop values are unchanged", () => {
  const drift = { amount: 10, rate: 3, seed: 7 };
  assert.deepEqual([0.4, 0.9, 1.3].map((t) => wiggleOffset(drift, "x", t, 2)), [-5.865964155701615, -2.5489275617523144, -5.185164013637042]);
  const layer = checked([custom({ wiggle: { amount: { x: 10 }, rate: 3, seed: 7 }, loop: { mode: "cycle" } }, { duration: 2 })]);
  assert.deepEqual(layer.animations[0].behavior, { wiggle: { amount: { x: 10 }, rate: 3, seed: 7 }, loop: { mode: "cycle" } });
  assert.equal(evaluateLayer(layer, 1.4).x, 100 + wiggleOffset(drift, "x", 0.4, 2));
  assert.equal(evaluateLayer(layer, 3.4).x, 100 + wiggleOffset(drift, "x", 0.4, 2), "the loop repeats it");
  assert.equal(evaluateLayer(layer, 1.4)._stepsAt, undefined, "wiggle marks no jumps");
});
