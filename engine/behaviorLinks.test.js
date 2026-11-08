import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { bandEdges, measureAudioLevels } from "./audioLevels.js";
import { audioLevelAt, overshootOffset, retimeBehavior } from "./behavior.js";

const doc = (layers, duration = 6) => parseDocument(createDocument({ scenes: [createScene({ id: "s", duration, layers })] }));
const add = (layerId, animation) => ({ type: "add_animation", sceneId: "s", layerId, animation: { id: `${layerId}-a`, name: "B", ...animation } });

test("overshoot passes the end value, then settles within 1% by settle seconds", () => {
  const box = createLayer("rectangle", { id: "box", x: 0, y: 0 });
  const animation = { kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 100 }, behavior: { overshoot: { bounce: 0.3, settle: 0.6 } } };
  const layer = applyOperations(doc([box]), [add("box", animation)]).scenes[0].layers[0];
  assert.deepEqual(layer.animations[0].behavior, { overshoot: { bounce: 0.3, settle: 0.6 } });
  const xs = Array.from({ length: 61 }, (_, i) => evaluateLayer(layer, 1 + i / 100).x);
  assert.ok(Math.max(...xs) > 125, `first swing passes 100 by about bounce times the move: ${Math.max(...xs)}`);
  assert.ok(Math.min(...xs) < 100, "it swings back under the end");
  for (const [t, x] of xs.map((x, i) => [1 + i / 100, x]).filter(([t]) => t >= 1.5)) assert.ok(Math.abs(x - 100) <= 1, `within 1% at ${t}: ${x}`);
  assert.equal(evaluateLayer(layer, 1.6).x, 100);
  assert.equal(evaluateLayer(layer, 0.5).x, 50, "nothing before the end");
  assert.ok(overshootOffset({ bounce: 0.5, settle: 1 }, 0.1, -20) < 0, "a move down overshoots down");
  assert.throws(() => applyOperations(doc([box]), [add("box", { ...animation, behavior: { overshoot: { bounce: 2 } } })]), /overshoot.bounce/);
  assert.throws(() => applyOperations(doc([box]), [add("box", { ...animation, behavior: { overshoot: {}, loop: { mode: "cycle" } } })]), /can't loop/);
});

test("overshoot leaves the end at the move's speed, after keys and along a motion path", () => {
  const box = createLayer("rectangle", { id: "box", x: 0, y: 0 });
  const speed = (layer, t, axis = "x") => (evaluateLayer(layer, t + 1e-5)[axis] - evaluateLayer(layer, t - 1e-5)[axis]) / 2e-5;
  const frame = (layer, t) => (evaluateLayer(layer, t).x - evaluateLayer(layer, t - 1 / 60).x) * 60;
  for (const easing of ["linear", "ease-in", "ease-out"]) {
    const layer = applyOperations(doc([box]), [add("box", { kind: "custom", start: 0, duration: 0.5, easing, from: { x: 0 }, to: { x: 100 }, behavior: { overshoot: {} } })]).scenes[0].layers[0];
    // The speed seen over the last frame carries on (an ease-in's end is near vertical).
    const before = easing === "ease-in" ? frame(layer, 0.5) : speed(layer, 0.5 - 1e-4);
    assert.ok(Math.abs(speed(layer, 0.5 + 1e-4) - before) < 0.05 * before + 10, `${easing}: ${before} then ${speed(layer, 0.5 + 1e-4)} px/s`);
    const top = Math.max(...Array.from({ length: 60 }, (_, i) => evaluateLayer(layer, 0.5 + i / 100).x));
    assert.ok(Math.abs(top - 130) < 0.5, `${easing}: the first swing is bounce times the move: ${top}`);
    assert.equal(evaluateLayer(layer, 1.1).x, 100);
  }
  // Keys: the last step (60 to 100) swings, not the flat step a finished animation reports.
  const keyed = applyOperations(doc([box]), [add("box", { kind: "custom", start: 0, duration: 1, easing: "linear", keys: [{ t: 0, value: { x: 0 } }, { t: 0.5, value: { x: 60 } }, { t: 1, value: { x: 100 } }], behavior: { overshoot: { bounce: 0.5 } } })]).scenes[0].layers[0];
  assert.ok(Math.max(...Array.from({ length: 40 }, (_, i) => evaluateLayer(keyed, 1 + i / 100).x)) > 115);
  // A motion path swings too, leaving along its end direction (down here).
  const path = { points: [{ x: 0, y: 0, out: { x: 120, y: 0 } }, { x: 100, y: 100, in: { x: 0, y: -120 } }] };
  const curved = applyOperations(doc([box]), [add("box", { kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, motionPath: path, behavior: { overshoot: {} } })]).scenes[0].layers[0];
  assert.ok(Math.max(...Array.from({ length: 30 }, (_, i) => evaluateLayer(curved, 1 + i / 100).y)) > 110);
  assert.ok(Math.abs(speed(curved, 1 + 1e-4, "y") - speed(curved, 1 - 1e-4, "y")) < 0.05 * speed(curved, 1 - 1e-4, "y") + 10);
  assert.equal(evaluateLayer(curved, 1.7).y, 100);
});

test("a ramp's seconds stretch when its animation is retimed, so the edit is kept", () => {
  const box = createLayer("rectangle", { id: "box", x: 0, y: 0 });
  const made = applyOperations(doc([box]), [add("box", { kind: "custom", start: 0, duration: 6, easing: "linear", from: {}, to: {}, behavior: { ramp: { to: { x: 40 }, start: 4, duration: 2 } } })]);
  const shorter = applyOperations(made, [{ type: "update_animation", sceneId: "s", layerId: "box", animationId: "box-a", properties: { duration: 3 } }]);
  assert.deepEqual(shorter.scenes[0].layers[0].animations[0].behavior.ramp, { to: { x: 40 }, start: 2, duration: 1, ease: "linear" });
  assert.deepEqual(retimeBehavior({ ramp: { to: 5, start: 0, ease: "linear" } }, 6, 3), { ramp: { to: 5, start: 0, ease: "linear" } }, "a ramp to the end needs no change");
  assert.deepEqual(retimeBehavior({ wiggle: { amount: 2 } }, 6, 3), { wiggle: { amount: 2 } });
});

test("audio bands split by bin center at any sample rate", () => {
  // Bins are rate/1024 Hz apart: low bins are centered under 150 Hz, high from 2.5 kHz.
  for (const rate of [22050, 44100, 48000]) {
    const [low, high] = bandEdges(rate), hz = (bin) => (bin * rate) / 1024;
    assert.ok(hz(low - 1) < 150 && hz(low) >= 150 && hz(high - 1) < 2500 && hz(high) >= 2500, `${rate}: ${low}, ${high}`);
  }
});

test("follow trails its leader by lag seconds, scaled and offset, along a chain", () => {
  const lead = createLayer("ellipse", { id: "lead", name: "Lead", x: 0, y: 0, animations: [{ id: "m", name: "Move", kind: "custom", start: 0, duration: 2, easing: "linear", from: { x: 0 }, to: { x: 200 } }] });
  const two = createLayer("ellipse", { id: "two", name: "Two", x: 0, y: 50 });
  const three = createLayer("ellipse", { id: "three", name: "Three", x: 0, y: 100 });
  const follow = (layer, extra = {}) => ({ kind: "custom", start: 0, duration: 4, easing: "linear", from: {}, to: {}, behavior: { follow: { layer, lag: 0.25, offset: { x: 0 }, ...extra } } });
  // Three follows Two before Two is set up: the refresh orders leaders first.
  const next = applyOperations(doc([lead, two, three]), [add("three", follow("Two")), add("two", follow("Lead"))]);
  const [L, T2, T3] = next.scenes[0].layers;
  assert.equal(T2.animations[0].behavior.follow.layer, "lead", "the leader is saved by ID");
  for (const t of [0.5, 1, 1.7, 2.1]) {
    assert.ok(Math.abs(evaluateLayer(T2, t).x - evaluateLayer(L, t - 0.25).x) < 0.01, `two lags 0.25 s at ${t}`);
    assert.ok(Math.abs(evaluateLayer(T3, t).x - evaluateLayer(L, t - 0.5).x) < 0.01, `three lags 0.5 s at ${t}`);
  }
  assert.equal(evaluateLayer(T2, 1).y, 50, "keys not named stay");
  const scaled = applyOperations(doc([lead, two]), [add("two", follow("lead", { scale: 0.5, offset: { x: 10 } }))]).scenes[0].layers[1];
  assert.ok(Math.abs(evaluateLayer(scaled, 1.25).x - (0.5 * 100 + 10)) < 0.01, "scale and offset");
  // An edit to the leader moves the follower too.
  const moved = applyOperations(next, [{ type: "update_layer", sceneId: "s", layerId: "lead", properties: { x: 0 } }, add("lead", { id: "m2", kind: "custom", start: 2, duration: 1, easing: "linear", from: { y: 0 }, to: { y: 40 } })]);
  assert.ok(Math.abs(evaluateLayer(moved.scenes[0].layers[1], 3).x - 200) < 0.01);
  assert.throws(() => applyOperations(doc([lead, two]), [add("two", follow("Nobody"))]), /not a layer of this scene/);
  assert.throws(() => applyOperations(doc([lead, two]), [add("lead", follow("Two")), add("two", follow("Lead"))]), /loop of leaders/);
});

// A synthetic signal: 1 s of a quiet 80 Hz tone, then 1 s of the same tone 30 dB louder.
function signal(rate = 22050) {
  const samples = new Float32Array(rate * 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = (i < rate ? 0.02 : 0.63) * Math.sin((2 * Math.PI * 80 * i) / rate);
  return samples;
}

test("audio moves a number higher on a loud stretch than a quiet one, per band", () => {
  const measured = measureAudioLevels(signal(), 22050);
  assert.equal(measured.rate, 30);
  const mean = (values, from, to) => values.slice(from, to).reduce((sum, value) => sum + value, 0) / (to - from);
  assert.ok(mean(measured.low, 40, 55) > 0.95 && mean(measured.low, 5, 25) < 0.5, "low band: loud near 1, quiet 30 dB down");
  assert.ok(mean(measured.high, 40, 55) < mean(measured.low, 40, 55), "an 80 Hz tone is low, not high");
  const music = createLayer("audio", { id: "music", name: "Music", src: "/api/media/abc", mediaDuration: 2 });
  const box = createLayer("rectangle", { id: "box", x: 0, y: 0, scaleX: 1 });
  const animation = { kind: "custom", start: 0, duration: 2, easing: "linear", from: {}, to: {}, behavior: { audio: { layer: "Music", band: "low", amount: { scaleX: 0.5 }, smoothing: 0.1 } } };
  assert.throws(() => applyOperations(doc([music, box], 2), [add("box", animation)]), /has not been measured/);
  const soundLevels = new Map([["/api/media/abc", measured]]);
  const layer = applyOperations(doc([music, box], 2), [add("box", animation)], { soundLevels }).scenes[0].layers[1];
  assert.equal(layer.animations[0].behavior.audio.layer, "music");
  const scale = (t) => evaluateLayer(layer, t).scaleX;
  assert.ok(scale(1.6) > scale(0.5) + 0.2, `loud ${scale(1.6)} vs quiet ${scale(0.5)}`);
  assert.ok(scale(1.6) <= 1.5 + 1e-9);
  // Smoothing: right after the loud part would end, the level falls off instead of dropping.
  const audio = { levels: { rate: 10, values: [0, 1, 0, 0, 0] }, smoothing: 0.2 };
  assert.ok(Math.abs(audioLevelAt(audio, 0.2) - Math.exp(-0.5)) < 1e-9);
  assert.equal(audioLevelAt({ ...audio, smoothing: 0 }, 0.2), 0);
  // Saved levels draw the same after a reload with no measuring.
  assert.equal(evaluateLayer(parseDocument(JSON.stringify(applyOperations(doc([music, box], 2), [add("box", animation)], { soundLevels }))).scenes[0].layers[1], 1.6).scaleX, scale(1.6));
});
