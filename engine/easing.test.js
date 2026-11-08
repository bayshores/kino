import test from "node:test";
import assert from "node:assert/strict";
import { EASINGS, checkedEasingValue, easingAt, easingBezier, normalizeEasing, normalizeIntensity } from "./easing.js";

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);

test("catalog labels, historical aliases, and custom curves normalize to stable values", () => {
  assert.deepEqual(EASINGS.map(({ id }) => id), [
    "custom", "smooth", "natural", "expo-out", "quart-out", "in-out", "ease-out", "ease-in", "elastic", "bounce", "overshoot", "impulse", "swing", "spring", "back-out", "steps", "linear",
  ]);
  // Named fixed curves: CSS and animation-library spellings reach them too.
  assert.equal(normalizeEasing("easeOutExpo"), "expo-out");
  assert.equal(normalizeEasing("snap"), "expo-out");
  // The two common presets at their usual intensity: smooth (the default) and natural.
  easingBezier("smooth").forEach((value, index) => close(value, [0.5, 0, 0, 1][index]));
  easingBezier("natural").forEach((value, index) => close(value, [0.8, 0, 0.2, 1][index]));
  assert.equal(normalizeEasing("quart_out"), "quart-out");
  assert.equal(normalizeEasing("ease-in-out"), "in-out");
  assert.deepEqual(easingBezier("expo-out", 90), [0.16, 1, 0.3, 1]);
  assert.ok(easingAt("expo-out", 0.2) > 0.7, "expo-out is most of the way at a fifth of the time");
  assert.equal(normalizeEasing("None"), "linear");
  assert.equal(normalizeEasing("Linear"), "linear");
  assert.equal(normalizeEasing("Ease Out"), "ease-out");
  assert.equal(normalizeEasing("Slow down"), "ease-out");
  assert.equal(normalizeEasing("Ease In"), "ease-in");
  assert.equal(normalizeEasing("Accelerate"), "ease-in");
  const source = [0.5, -2, 0.5, 3];
  const normalized = normalizeEasing(source);
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  assert.deepEqual(normalizeEasing("Custom"), [0.5, 0, 0.5, 1]);
  assert.throws(() => normalizeEasing("unrecognized"), /unsupported easing/);
  assert.throws(() => normalizeEasing([2, 0, 0, 1]), /supported range/);
  assert.throws(() => normalizeEasing([0, 0, 1]), /supported range/);
});

test("intensity validation uses a default of 50 and rejects non-integer or out-of-range values", () => {
  assert.equal(normalizeIntensity(), 50);
  for (const value of [0, 50, 100]) assert.equal(normalizeIntensity(value), value);
  for (const value of [-1, 101, 0.5, "50", null, Infinity])
    assert.throws(() => normalizeIntensity(value), /intensity.*supported range/);
});

test("the four cubic presets use the captured anchors and interpolate their parameters", () => {
  assert.deepEqual(easingBezier("smooth", 0), [0.3, 0, 0, 1]);
  assert.deepEqual(easingBezier("smooth", 25), [0.4, 0, 0, 1]);
  assert.deepEqual(easingBezier("smooth", 50), [0.5, 0, 0, 1]);
  assert.deepEqual(easingBezier("smooth", 75), [0.7, 0, 0, 1]);
  assert.deepEqual(easingBezier("smooth", 100), [0.9, 0, 0, 1]);
  assert.deepEqual(easingBezier("natural", 25), [0.65, 0, 0.35, 1]);
  assert.deepEqual(easingBezier("natural", 100), [1, 0, 0, 1]);
  assert.deepEqual(easingBezier("ease-out", 0), [0, 0, 0.3, 1]);
  assert.deepEqual(easingBezier("ease-out", 50), [0, 0, 0, 1]);
  assert.deepEqual(easingBezier("ease-out", 75), [0, 0.45, 0, 1]);
  assert.deepEqual(easingBezier("ease-out", 100), [0, 0.9, 0, 1]);
  assert.deepEqual(easingBezier("ease-in", 0), [0.7, 0, 1, 1]);
  assert.deepEqual(easingBezier("ease-in", 50), [1, 0, 1, 1]);
  assert.deepEqual(easingBezier("ease-in", 100), [1, 0, 1, 0.1]);
});

test("Bezier evaluation has stable endpoints and inverts the x coordinate", () => {
  assert.equal(easingAt("smooth", 0), 0);
  assert.equal(easingAt("smooth", 1), 1);
  close(easingAt([0, 0, 1, 1], 0.37), 0.37);
  for (const time of [0.1, 0.2, 0.3, 0.6, 0.7, 0.9]) {
    assert.equal(easingAt("linear", time), time, "linear counter boundaries must remain exact");
    assert.equal(easingAt([0.25, 0.25, 0.75, 0.75], time), time);
  }
  close(easingAt([0.42, 0, 0.58, 1], 0.5), 0.5, 1e-5);
  assert.throws(() => easingAt("smooth", NaN), /finite number/);
  assert.throws(() => easingAt("smooth", 0.5, 101), /intensity.*supported range/);
});

test("sampled curves are formula-driven, intensity-sensitive, and serialize to CSS syntax", () => {
  for (const id of ["elastic", "bounce", "overshoot", "impulse", "swing"]) {
    assert.equal(easingAt(id, 0), 0);
    assert.equal(easingAt(id, 1), 1);
    assert.notEqual(easingAt(id, 0.37, 0), easingAt(id, 0.37, 100), `${id} responds to intensity`);
  }
  close(easingAt("bounce", 1 / 3, 50), 1);
  close(easingAt("bounce", 0.5, 50), 0.75, 1e-12);
  close(easingAt("overshoot", 0.15, 100), 2, 0.02);
  close(easingAt("impulse", 0.47, 100), -1, 0.02);
  close(easingAt("swing", 0.2, 50), -0.2, 0.02);
  close(easingAt("swing", 0.6, 50), 1.1, 0.02);
  close(easingAt("swing", 0.27, 100), -1, 0.02);
  close(easingAt("swing", 0.47, 100), 1.5, 0.02);
  close(easingAt("swing", 1, 100), 1);
  // Spring and back-out (FilmCraft motion.rs): both end exactly at 1 and overshoot on the way.
  for (const id of ["spring", "back-out"]) {
    close(easingAt(id, 0.999, 50), 1, 0.01);
    assert.ok(Math.max(...[0.4, 0.6].map((t) => easingAt(id, t, 50))) > 1.05, `${id} overshoots`);
  }
  assert.equal(normalizeEasing("easeOutBack"), "back-out");
});

test("a saved easing keeps only a valid curve and intensity", () => {
  assert.deepEqual(checkedEasingValue({ easing: [0.5, -2, 0.8, 3], intensity: 75, name: "Mine" }), { easing: [0.5, -2, 0.8, 3], intensity: 75 });
  assert.throws(() => checkedEasingValue(null), /required/);
  assert.throws(() => checkedEasingValue({ easing: "smooth", intensity: 1.5 }));
  assert.throws(() => checkedEasingValue({ easing: [0, Infinity, 1, 1] }));
});
