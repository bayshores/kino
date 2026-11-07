import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogAnimation } from "../engine/presetCatalog.js";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { evaluateLayer } from "../engine/animation.js";
import { discreteOpacityProperty, blinkSwitchProgress } from "./lottie-opacity.mjs";
import { exportFrameStep } from "../engine/exportOptions.js";

function sceneWithPreset(presetId, parameters = {}, { start = 0, operationDuration = 1, sceneDuration = 1 } = {}) {
  const base = createLayer("rectangle", {
    id: "box", name: "Box", x: 10, y: 10, width: 40, height: 40, fill: "#ff0000", strokeWidth: 0,
  });
  const animation = createCatalogAnimation(presetId, base, start, { parameters }, `animation-${presetId}`);
  animation.duration = operationDuration;
  animation.easing = "linear";
  return createScene({ id: `discrete-${presetId}`, width: 80, height: 60, duration: sceneDuration, background: "#ffffff",
    layers: [createLayer("rectangle", { ...base, animations: [animation] })] });
}

function opacity(layer) {
  const value = layer.ks.o;
  return value.a === 1 ? value.k : [];
}

test("Lottie holds the sampled opacity at Appear and Blink phase switches", async () => {
  const appear = await exportScene(sceneWithPreset("appear", {}, { start: 0.5, sceneDuration: 1.5 }), { format: "lottie", fps: 4, width: 80, height: 60 });
  const appearLayer = JSON.parse(appear.buffer.toString("utf8")).layers.find((layer) => layer.nm === "Box");
  const appearFrames = opacity(appearLayer);
  assert.equal(atProperty(appearLayer.ks.o, 1.99), 0, "instant Appear remains hidden before its start");
  assert.equal(atProperty(appearLayer.ks.o, 2), 100, "instant Appear switches at its exact start");

  const blink = await exportScene(sceneWithPreset("blink", { count: 2 }), { format: "lottie", fps: 4, width: 80, height: 60 });
  const blinkLayer = JSON.parse(blink.buffer.toString("utf8")).layers.find((layer) => layer.nm === "Box");
  const blinkFrames = opacity(blinkLayer);
  assert.ok(blinkFrames.filter((frame) => frame.h === 1).length >= 3, "each sampled Blink phase change holds until its next step");
  assert.deepEqual([0, 1, 2, 3, 4].map((frame) => atProperty(blinkLayer.ks.o, frame)), [0, 100, 0, 100, 100], "Blink retains integer-frame values");
  assert.equal(atProperty(blinkLayer.ks.o, 0.79), 0);
  assert.equal(atProperty(blinkLayer.ks.o, 0.8), 100, "the first Blink is not delayed to frame 1");
});

function atProperty(property, frame) {
  if (property.a !== 1) return property.k;
  let index = 0;
  while (index + 1 < property.k.length && property.k[index + 1].t <= frame) index += 1;
  const key = property.k[index], next = property.k[index + 1];
  if (!next || key.h) return key.s[0];
  const progress = (frame - key.t) / (next.t - key.t);
  return key.s[0] + (next.s[0] - key.s[0]) * progress;
}

test("fractional Blink switches retain fast pulses, nonlinear easing, reverse stagger, and held clocks", () => {
  for (const easing of ["linear", "smooth", "bounce", "elastic", "overshoot", "impulse", "swing", [0.3, -0.4, 0.8, 1.3]]) {
    const layer = sceneWithPreset("blink", { count: 20 }, { start: 0.13 }).layers[0];
    Object.assign(layer.animations[0], { easing, intensity: 100, unit: "letters", stagger: 0.073, order: "reverse" });
    const timing = { unitIndex: 1, unitCount: 3, unit: "letters" };
    const original = JSON.stringify(layer);
    const times = Array.from({ length: 13 }, (_, frame) => frame / 4);
    const property = discreteOpacityProperty(layer, times, timing);
    const switches = blinkSwitchProgress(layer.animations[0]);
    assert.ok(switches.length >= 40, `${JSON.stringify(easing)} contains every fast phase`);
    const probes = [0, 0.1, 0.203, 1.203, 2.2];
    for (const phase of switches) for (const delta of [-1e-5, 1e-5]) probes.push(0.203 + phase + delta);
    for (const time of probes) {
      if (time < 0 || time > 3) continue;
      const state = evaluateLayer(layer, time, timing);
      assert.ok(Math.abs(atProperty(property, time * 4) - state.opacity * 100) < 0.01,
        `${JSON.stringify(easing)} at ${time}`);
    }
    assert.equal(JSON.stringify(layer), original, "sampling never adds metadata to the document");
    layer.playbackWindows = [{ start: 0.32, end: 0.77, visibility: "both", hold: true }];
    const held = discreteOpacityProperty(layer, times, timing);
    for (const time of [0, 0.2, 0.4, 0.6, 0.9, 2])
      assert.ok(Math.abs(atProperty(held, time * 4) - evaluateLayer(layer, time, timing).opacity * 100) < 0.01);
  }
});

test("a looping Blink switches exactly on every pass, backwards on a pingpong's way back", () => {
  const times = Array.from({ length: 13 }, (_, frame) => frame / 4);
  for (const mode of ["cycle", "pingpong"]) {
    const layer = sceneWithPreset("blink", { count: 2 }, { sceneDuration: 3 }).layers[0];
    layer.animations[0].behavior = { loop: { mode } };
    const property = discreteOpacityProperty(layer, times);
    // Second pass from 1 s (frame 4): cycle shows again at 1.2 s; pingpong runs backwards and
    // hides at 1.4 s, where the forward pass showed at 0.6 s.
    const frame = mode === "cycle" ? 4.8 : 5.6;
    const [before, after] = [frame - 0.01, frame + 0.01].map((at) => atProperty(property, at));
    assert.deepEqual([before, after], mode === "cycle" ? [0, 100] : [100, 0], mode);
    assert.equal(after, evaluateLayer(layer, (frame + 0.01) / 4).opacity * 100, `${mode} matches the editor`);
  }
});

test("a continuous opacity operation taking over Blink keeps its interpolation", () => {
  const layer = sceneWithPreset("blink", { count: 3 }).layers[0];
  layer.animations.push({ id: "later-fade", name: "Fade", kind: "custom", start: 1.13,
    duration: 1, easing: "linear", from: { opacity: 1 }, to: { opacity: 0 } });
  const times = Array.from({ length: 10 }, (_, frame) => frame / 4);
  const property = discreteOpacityProperty(layer, times);
  for (const time of [1.25, 1.4, 1.6, 1.9, 2])
    assert.ok(Math.abs(atProperty(property, time * 4) - evaluateLayer(layer, time).opacity * 100) < 0.001);
});

test("the exact evaluated Bounce switch is not left on the previous phase by time-to-frame rounding", () => {
  const step = exportFrameStep(30);
  const layer = sceneWithPreset("blink", { count: 3 }, { start: 6.35 * step, operationDuration: 24 * step }).layers[0];
  layer.animations[0].easing = "bounce";
  const times = Array.from({ length: 46 }, (_, index) => index * step);
  const property = discreteOpacityProperty(layer, times);
  const boundary = 13.756560798179793;
  assert.equal(evaluateLayer(layer, boundary * step).opacity, 0);
  assert.equal(atProperty(property, boundary), 0);
  assert.equal(atProperty(property, boundary - 1e-5), 100);
});

test("visibility and media range changes stay instant when composed with a discrete preset", () => {
  const layer = sceneWithPreset("appear").layers[0];
  layer.animations.push({ id: "hide", kind: "hide", start: 0.437 }, { id: "show", kind: "show", start: 0.793 });
  const times = Array.from({ length: 121 }, (_, frame) => frame / 120);
  const property = discreteOpacityProperty(layer, times);
  for (const time of [0.435, 0.4361, 0.6, 0.791, 0.7921, 0.85]) {
    const state = evaluateLayer(layer, time);
    assert.equal(atProperty(property, time * 120), state.visible ? 100 : 0);
  }
  Object.assign(layer, { type: "image", mediaStart: 0.137, mediaDuration: 0.6, mediaFreeze: "none" });
  layer.animations = layer.animations.slice(0, 1);
  const media = discreteOpacityProperty(layer, times);
  for (const time of [0.13, 0.138, 0.73, 0.738, 0.9]) {
    const state = evaluateLayer(layer, time);
    assert.equal(atProperty(media, time * 120), state.visible ? 100 : 0);
  }
});

test("ordinary opacity fades keep interpolated Lottie keyframes", async () => {
  const base = createLayer("rectangle", { id: "box", name: "Box", width: 40, height: 40, fill: "#ff0000", strokeWidth: 0 });
  const layer = createLayer("rectangle", { ...base, animations: [{
    id: "fade", name: "Fade", kind: "custom", start: 0, duration: 1, easing: "linear",
    from: { opacity: 0 }, to: { opacity: 1 },
  }] });
  const scene = createScene({ id: "ordinary-fade", width: 80, height: 60, duration: 1, background: "#ffffff", layers: [layer] });
  const result = await exportScene(scene, { format: "lottie", fps: 4, width: 80, height: 60 });
  const lottieLayer = JSON.parse(result.buffer.toString("utf8")).layers.find((item) => item.nm === "Box");
  const frames = opacity(lottieLayer);
  assert.deepEqual(frames.map((frame) => frame.s[0]), [0, 25, 50, 75, 100]);
  assert.ok(frames.slice(0, -1).every((frame) => frame.h !== 1), "ordinary fades remain linear between samples");
});
