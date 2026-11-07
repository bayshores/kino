import test from "node:test";
import assert from "node:assert/strict";
import { createLayer } from "../engine/model.js";
import { evaluateLayer } from "../engine/animation.js";
import { hasSoftReveal, lottieRevealMask, revealRectangle, revealSampleTimes } from "./lottie-reveal.mjs";
import { easingPieces } from "../engine/counterSchedule.js";

const identity = [1, 0, 0, 1, 0, 0];
const state = (progress, direction = "right", softness = 0, width = 100, height = 60) => ({
  width, height, reveal: { progress, direction, softness },
});

test("reveal rectangles move the visible edge in the requested direction and preserve endpoints", () => {
  assert.deepEqual(revealRectangle(100, 60, state(0.25, "right").reveal), { x: 0, y: 0, width: 25, height: 60 });
  assert.deepEqual(revealRectangle(100, 60, state(0.25, "left").reveal), { x: 75, y: 0, width: 25, height: 60 });
  assert.deepEqual(revealRectangle(100, 60, state(0.25, "down").reveal), { x: 0, y: 0, width: 100, height: 15 });
  assert.deepEqual(revealRectangle(100, 60, state(0.25, "up").reveal), { x: 0, y: 45, width: 100, height: 15 });
  assert.deepEqual(revealRectangle(100, 60, state(0, "left").reveal), { x: 100, y: 0, width: 0, height: 60 });
  assert.deepEqual(revealRectangle(100, 60, state(1, "up", 20).reveal), { x: 0, y: 0, width: 100, height: 60 });
  assert.deepEqual(revealRectangle(-10, -3, state(0.5).reveal), { x: 0, y: 0, width: 0, height: 0 });
});

test("native reveal masks sample a moving rectangle in transformed parent coordinates", () => {
  const mask = lottieRevealMask(
    [state(0, "right"), state(0.5, "right"), state(1, "right")],
    [identity, [0, 1, -1, 0, 200, 10], identity],
  );
  assert.equal(mask.mode, "a");
  assert.equal(mask.pt.a, 1);
  assert.deepEqual(mask.pt.k.map((frame) => frame.t), [0, 1, 2]);
  assert.deepEqual(mask.pt.k[0].s[0].v, [[0, 0], [0, 0], [0, 60], [0, 60]]);
  assert.deepEqual(mask.pt.k[1].s[0].v, [[200, 10], [200, 60], [140, 60], [140, 10]]);
  assert.deepEqual(mask.pt.k[2].s[0].v, [[0, 0], [100, 0], [100, 60], [0, 60]]);
  assert.equal(mask.pt.k[0].o.x, 0);
  assert.equal(mask.pt.k[0].i.x, 1);
});

test("the fully shown Lottie endpoint covers the whole parent composition without box clipping", () => {
  const mask = lottieRevealMask([state(1, "right")], [identity], { width: 200, height: 120 });
  assert.deepEqual(mask.pt.k.v, [[0, 0], [200, 0], [200, 120], [0, 120]]);
});

test("compressed paths retain the last repeated sample and jump to full composition at the endpoint", () => {
  const mask = lottieRevealMask(
    [state(0), state(0), state(0), state(0.5), state(0.75), state(1)],
    Array.from({ length: 6 }, () => identity),
    { width: 200, height: 120 },
  );
  const frames = mask.pt.k;
  assert.deepEqual(frames.map((frame) => frame.t), [0, 2, 3, 4, 5 - 1e-6, 5]);
  assert.deepEqual(frames.find((frame) => frame.t === 2).e[0].v, frames.find((frame) => frame.t === 3).s[0].v,
    "the last repeated shape sample interpolates to the next frame instead of delaying the change");
  const endpointLocal = frames.find((frame) => frame.t === 5 - 1e-6);
  assert.equal(endpointLocal.h, 1, "the local full-box mask holds only over the final sub-frame");
  assert.equal(Object.hasOwn(endpointLocal, "e"), false);
  assert.deepEqual(endpointLocal.s[0].v, [[0, 0], [100, 0], [100, 60], [0, 60]]);
  assert.deepEqual(frames.find((frame) => frame.t === 5).s[0].v, [[0, 0], [200, 0], [200, 120], [0, 120]]);
});

test("the final local-box interval keeps interpolating before the full-domain jump", () => {
  const mask = lottieRevealMask(
    [state(0), state(0.5), state(0.9), state(1), state(1)],
    Array.from({ length: 5 }, () => identity),
    { width: 200, height: 120 },
  );
  const frames = mask.pt.k;
  const lastLocalInterval = frames.find((frame) => frame.t === 2);
  const localEndpoint = frames.find((frame) => frame.t === 3 - 1e-6);
  const fullEndpoint = frames.find((frame) => frame.t === 3);
  assert.ok(lastLocalInterval.e, "the last sampled local rectangle still has an interpolated endpoint");
  assert.equal(lastLocalInterval.h, undefined);
  assert.deepEqual(lastLocalInterval.e[0].v, localEndpoint.s[0].v,
    "the reveal reaches the full local box before changing mask domains");
  assert.equal(localEndpoint.h, 1, "the local box is held only until the exact endpoint keyframe");
  assert.deepEqual(fullEndpoint.s[0].v, [[0, 0], [200, 0], [200, 120], [0, 120]]);

  const startX = lastLocalInterval.s[0].v[1][0];
  const endX = lastLocalInterval.e[0].v[1][0];
  const amount = (2.5 - lastLocalInterval.t) / (localEndpoint.t - lastLocalInterval.t);
  const halfFrameX = startX + (endX - startX) * amount;
  assert.ok(Math.abs(halfFrameX - 95) < 0.001,
    "a fractional pre-endpoint frame follows the remaining local reveal instead of freezing at the previous sample");
});

test("a full-to-local transition begins just after the full endpoint instead of one sampled frame late", () => {
  const mask = lottieRevealMask(
    [state(1), state(0.9), state(0.5)],
    [identity, identity, identity],
    { width: 200, height: 120 },
  );
  const frames = mask.pt.k;
  const full = frames.find((frame) => frame.t === 0);
  const localEndpoint = frames.find((frame) => frame.t === 1e-6);
  const nextLocal = frames.find((frame) => frame.t === 1);
  assert.equal(full.h, 1, "the full composition remains visible at the exact endpoint");
  assert.deepEqual(localEndpoint.s[0].v, [[0, 0], [100, 0], [100, 60], [0, 60]]);
  assert.ok(localEndpoint.e, "the local reveal begins changing immediately after the endpoint");
  assert.deepEqual(localEndpoint.e[0].v, nextLocal.s[0].v);
});

test("explicit fractional frame positions preserve a non-frame-aligned reveal endpoint", () => {
  const mask = lottieRevealMask(
    [state(0), state(0.5), state(0.9), state(1), state(1)],
    Array.from({ length: 5 }, () => identity),
    { width: 200, height: 120 },
    [0, 1, 2, 3.25, 4],
  );
  const frames = mask.pt.k;
  const lastLocalInterval = frames.find((frame) => frame.t === 2);
  const localEndpoint = frames.find((frame) => frame.t === 3.25 - 1e-6);
  const fullEndpoint = frames.find((frame) => frame.t === 3.25);
  assert.ok(lastLocalInterval.e, "the local reveal keeps interpolating to its full-box endpoint");
  assert.deepEqual(lastLocalInterval.e[0].v, localEndpoint.s[0].v);
  assert.equal(localEndpoint.h, 1);
  assert.deepEqual(fullEndpoint.s[0].v, [[0, 0], [200, 0], [200, 120], [0, 120]]);
  assert.throws(() => lottieRevealMask([state(0), state(1)], [identity, identity], { width: 200, height: 120 }, [0]),
    /frame positions must match/);
  assert.throws(() => lottieRevealMask([state(0), state(1)], [identity, identity], { width: 200, height: 120 }, [0, Infinity]),
    /finite and strictly increasing/);
  assert.throws(() => lottieRevealMask([state(0), state(1)], [identity, identity], { width: 200, height: 120 }, [1, 1]),
    /finite and strictly increasing/);
});

test("reveal sample times include enabled endpoints and playback window boundaries only within export duration", () => {
  const layer = {
    animations: [
      { id: "off", enabled: false, start: 0.1, duration: 0.3, from: { reveal: state(0).reveal }, to: { reveal: state(1).reveal } },
      { id: "reveal", start: 0.15, duration: 0.35, easing: "linear", from: { reveal: state(0).reveal }, to: { reveal: state(1).reveal } },
    ],
    playbackWindows: [{ start: 0.05, end: 0.9, visibility: "both", hold: false }, { start: 1.1, end: 1.2 }],
  };
  const times = revealSampleTimes(layer, [0, 0.25, 0.5, 0.75, 1]);
  for (const expected of [0, 0.05, 0.15, 0.25, 0.5, 0.9, 1]) assert.ok(times.includes(expected), `includes ${expected}`);
  assert.ok(!times.includes(0.1), "disabled reveal operations do not add frame samples");
  assert.ok(!times.includes(1.1), "times beyond the export window are omitted");
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("nonlinear reveal easing samples every turn and every return to or from a full endpoint", () => {
  const pieces = easingPieces("bounce");
  const duration = 0.8;
  const start = 0.1;
  const frameTimes = [0, 1];
  const inLayer = { animations: [{
    id: "bounce-in", start, duration, easing: "bounce",
    from: { reveal: state(0).reveal }, to: { reveal: state(1).reveal },
  }] };
  const outLayer = { animations: [{
    id: "bounce-out", start, duration, easing: "bounce",
    from: { reveal: state(1).reveal }, to: { reveal: state(0).reveal },
  }] };
  const inTimes = revealSampleTimes(inLayer, frameTimes);
  const outTimes = revealSampleTimes(outLayer, frameTimes);
  for (const progress of pieces) {
    const time = start + duration * progress;
    assert.ok(inTimes.some((sample) => Math.abs(sample - time) < 1e-12), `Mask samples Bounce turn ${progress}`);
    assert.ok(outTimes.some((sample) => Math.abs(sample - time) < 1e-12), `reverse Mask samples Bounce turn ${progress}`);
  }
  const firstPeak = start + duration / 3;
  const secondPeak = start + duration * 2 / 3;
  const includes = (times, value) => times.some((time) => Math.abs(time - value) < 1e-12);
  assert.ok(includes(inTimes, firstPeak) && includes(inTimes, secondPeak),
    "a full reveal touched at a Bounce peak gets a key time before easing returns to a local mask");
  assert.ok(includes(outTimes, firstPeak) && includes(outTimes, secondPeak),
    "a reverse reveal leaves its full state at the same nonlinear crossings");
});

function evaluatedFullTransitions(layer, start, end) {
  const isFull = (time) => evaluateLayer(layer, time).reveal.progress >= 1;
  const transitions = [];
  let beforeTime = start;
  let beforeFull = isFull(beforeTime);
  const divisions = 10_000;
  for (let index = 1; index <= divisions; index += 1) {
    const afterTime = start + (end - start) * index / divisions;
    const afterFull = isFull(afterTime);
    if (afterFull !== beforeFull) {
      let low = beforeTime;
      let high = afterTime;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const middle = (low + high) / 2;
        if (isFull(middle) === beforeFull) low = middle;
        else high = middle;
      }
      transitions.push(high);
    }
    beforeTime = afterTime;
    beforeFull = afterFull;
  }
  return transitions;
}

test("Overshoot In and Impulse Out threshold roots match evaluated full-state transitions", () => {
  const start = 0.1;
  const duration = 0.8;
  const end = start + duration;
  const makeLayer = (id, easing, from, to, kind) => createLayer("rectangle", {
    id,
    animations: [{
      id: `${id}-animation`,
      name: id,
      kind,
      start,
      duration,
      easing,
      intensity: 100,
      from: { reveal: from },
      to: { reveal: to },
    }],
  });
  const cases = [
    ["Overshoot In", makeLayer("overshoot-in", "overshoot", state(0).reveal, state(1).reveal, "in")],
    ["Impulse Out", makeLayer("impulse-out", "impulse", state(1).reveal, state(0).reveal, "out")],
  ];
  for (const [name, layer] of cases) {
    const evaluated = evaluatedFullTransitions(layer, start, end);
    const sampled = revealSampleTimes(layer, [0, 1]);
    assert.ok(evaluated.length > 0, `${name} has a real full/local transition in evaluateLayer`);
    for (const crossing of evaluated) {
      assert.ok(sampled.some((time) => Math.abs(time - crossing) < 1e-8),
        `${name} samples the evaluator's threshold crossing at ${crossing}`);
      assert.ok(sampled.some((time) => time < crossing && crossing - time <= 2e-7),
        `${name} samples just before its full/local crossing`);
      assert.ok(sampled.some((time) => time > crossing && time - crossing <= 2e-7),
        `${name} samples just after its full/local crossing`);
    }
  }
});

test("unchanged reveal samples compress to one native path and softness fallback is explicit", () => {
  const mask = lottieRevealMask([state(0.5), state(0.5), state(0.5)], [identity, identity, identity]);
  assert.equal(mask.pt.a, 0);
  assert.equal(hasSoftReveal([state(0, "right", 20), state(1, "right", 20)]), false);
  assert.equal(hasSoftReveal([state(0.5, "right", 20)]), true);
  assert.equal(hasSoftReveal([state(0.5, "right", 0)]), false);
});

test("native mask helper rejects mismatched samples and invalid matrices", () => {
  assert.throws(() => lottieRevealMask([], []), /matching sampled states/);
  assert.throws(() => lottieRevealMask([state(0.5)], []), /matching sampled states/);
  assert.throws(() => lottieRevealMask([state(0.5)], [[1, 0, 0, 1, Infinity, 0]]), /six finite numbers/);
});
