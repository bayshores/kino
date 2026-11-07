import test from "node:test";
import assert from "node:assert/strict";
import { FULL_REVEAL, interpolateReveal, normalizeReveal } from "./reveal.js";

test("missing reveal endpoints are fully shown and explicit values are cloned", () => {
  assert.equal(normalizeReveal(undefined), FULL_REVEAL);
  assert.equal(normalizeReveal(null), FULL_REVEAL);
  const input = { progress: 0.25, direction: "left", softness: 12.5 };
  const output = normalizeReveal(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  output.progress = 0.75;
  assert.equal(input.progress, 0.25);
  assert.deepEqual(FULL_REVEAL, { progress: 1, direction: "up", softness: 0 });
});

test("reveal endpoints require exactly the documented finite fields", () => {
  for (const value of [false, 3, "up", [], new Date()]) {
    assert.throws(() => normalizeReveal(value), /Reveal must be an object/);
  }
  assert.throws(() => normalizeReveal({ progress: 0.5, direction: "up" }), /needs progress, direction, and softness/);
  assert.throws(() => normalizeReveal({ progress: 0.5, direction: "up", softness: 1, extra: true }), /unknown field/);
  for (const progress of [-0.01, 1.01, NaN, Infinity, "0.5"]) {
    assert.throws(() => normalizeReveal({ progress, direction: "up", softness: 0 }), /Reveal progress/);
  }
  for (const direction of ["north", "UP", null]) {
    assert.throws(() => normalizeReveal({ progress: 0.5, direction, softness: 0 }), /Reveal direction/);
  }
  for (const softness of [-1, 100.01, NaN, Infinity, "20"]) {
    assert.throws(() => normalizeReveal({ progress: 0.5, direction: "up", softness }), /Reveal softness/);
  }
});

test("reveal interpolation moves edge and feather together, switching direction only at endpoint", () => {
  assert.deepEqual(
    interpolateReveal(
      { progress: 0, direction: "right", softness: 0 },
      { progress: 1, direction: "left", softness: 20 },
      0.4,
    ),
    { progress: 0.4, direction: "right", softness: 8 },
  );
  assert.deepEqual(
    interpolateReveal(
      { progress: 0, direction: "right", softness: 0 },
      { progress: 1, direction: "left", softness: 20 },
      1,
    ),
    { progress: 1, direction: "left", softness: 20 },
  );
  assert.deepEqual(interpolateReveal(null, null, 0.5), FULL_REVEAL);
});

test("easing overshoot clamps to fully hidden or shown without invalid stored values", () => {
  const from = { progress: 0, direction: "down", softness: 10 };
  const to = { progress: 1, direction: "up", softness: 30 };
  assert.deepEqual(interpolateReveal(from, to, -0.2), from);
  assert.deepEqual(interpolateReveal(from, to, 1.4), to);
  assert.throws(() => interpolateReveal(from, to, NaN), /progress must be finite/);
});
