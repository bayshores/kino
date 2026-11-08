// The steps easing: its count is the intensity, it plays in animations, keys and a move's
// ease field, Lottie holds its jumps, and the older easings sample exactly as before.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { easingAt, normalizeEasing } from "./easing.js";
import { evaluateLayer } from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { readMoveInput, runMove } from "./blocks/move.js";
import { MOVES } from "./blocks/moves/index.js";
import { exportScene } from "../backend/export.mjs";

// Hashes of 101 samples (12 decimals) at the default intensity, taken before steps existed.
const OLD = {
  custom: "0899fc106aef7d9c", smooth: "f78bc0d84c34ff57", natural: "31ec523ed84ee033", "expo-out": "a804e235b4cccef2",
  "quart-out": "2739dae9046c113f", "in-out": "7bd8a755316ea9c5", "ease-out": "875f4b361298d067", "ease-in": "22b3580337f0e36b",
  elastic: "45c9f9eed9f02131", bounce: "c8c09d44f83b57fe", overshoot: "731d2d7e40221aef", impulse: "322e90555a3919ac",
  swing: "e9d0a258cb96131c", spring: "fe2a19afb8f808cc", "back-out": "71f3159e08f43160", linear: "2aaa0c22cd10abbe",
};

test("the 16 older easings sample exactly as before", () => {
  for (const [name, hash] of Object.entries(OLD)) {
    const samples = Array.from({ length: 101 }, (_, index) => easingAt(name, index / 100).toFixed(12));
    assert.equal(createHash("sha256").update(samples.join(",")).digest("hex").slice(0, 16), hash, name);
  }
});

// A layer as a saved document reads it back (easing names and keys checked).
const parsed = (layer) => parseDocument(createDocument({ scenes: [createScene({ id: "s", name: "S", width: 400, height: 300, duration: 4, layers: [layer] })] })).scenes[0].layers[0];
const distinct = (values) => [...new Set(values.map((value) => Math.round(value * 1e6)))].length;

test("steps 4 gives exactly 4 values across the animation, from the start value to the end value", () => {
  assert.equal(normalizeEasing("Stepped"), "steps");
  const layer = parsed(createLayer("rectangle", { id: "box", name: "Box", width: 10, height: 10,
    animations: [{ id: "hop", name: "Hop", kind: "custom", start: 0, duration: 1, easing: "stepped", intensity: 4, from: { x: 0 }, to: { x: 90 } }] }));
  assert.equal(layer.animations[0].easing, "steps");
  const xs = Array.from({ length: 1001 }, (_, index) => evaluateLayer(layer, index / 1000).x);
  assert.equal(distinct(xs), 4);
  assert.deepEqual([...new Set(xs)], [0, 30, 60, 90]);
  assert.equal(evaluateLayer(layer, 0.249).x, 0);
  assert.equal(evaluateLayer(layer, 0.25).x, 30);
  assert.equal(evaluateLayer(layer, 0.999).x, 90);
  // 0 and 1 count as one step: it holds the start until the end.
  assert.deepEqual([0, 0.5, 0.99, 1].map((time) => easingAt("steps", time, 0)), [0, 0, 0, 1]);
  assert.equal(distinct(Array.from({ length: 1001 }, (_, index) => easingAt("steps", index / 1000, 100))), 100);
});

test("a key's ease steps counts by the animation's intensity", () => {
  const layer = parsed(createLayer("rectangle", { id: "box", name: "Box", width: 10, height: 10,
    animations: [{ id: "keyed", name: "Keyed", kind: "custom", start: 0, duration: 2, easing: "smooth", intensity: 3, from: {}, to: {},
      keys: [{ t: 0, value: { x: 0 }, ease: "steps" }, { t: 0.5, value: { x: 100 } }, { t: 1, value: { x: 300 } }] }] }));
  const first = Array.from({ length: 500 }, (_, index) => evaluateLayer(layer, index / 500).x);
  assert.deepEqual([...new Set(first)], [0, 50, 100]);
  assert.ok(distinct(Array.from({ length: 100 }, (_, index) => evaluateLayer(layer, 1 + index / 100).x)) > 50, "the smooth segment is not stepped");
});

function sceneOf() {
  return createScene({ id: "s", name: "S", width: 1920, height: 1080, duration: 5, layers: [
    createLayer("image", { id: "shot-b", name: "shot-b", src: "/b.png", x: 0, y: 0, width: 1920, height: 1080 }),
    createLayer("image", { id: "shot-a", name: "shot-a", src: "/a.png", x: 0, y: 0, width: 1920, height: 1080 }),
  ] });
}
const cut = (fields) => {
  const scene = sceneOf();
  return runMove(MOVES["zoom-blur"], { id: "m", input: readMoveInput(MOVES["zoom-blur"], { from: "shot-a", to: "shot-b", ...fields }), scene,
    style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 1, dur: null, media: () => null, seed: 1 });
};

test("a move's ease steps-4 stores the steps easing with intensity 4; other curves are unchanged", () => {
  const stepped = cut({ ease: "steps-4" }).animations.map((entry) => entry.animation).filter((animation) => animation.easing === "steps");
  assert.ok(stepped.length >= 2, "both halves step");
  assert.ok(stepped.every((animation) => animation.intensity === 4));
  const plain = cut({}).animations.map((entry) => entry.animation).filter((animation) => animation.easing !== undefined);
  assert.ok(plain.every((animation) => Array.isArray(animation.easing) && animation.intensity === undefined));
  assert.throws(() => readMoveInput(MOVES["zoom-blur"], { from: "shot-a", to: "shot-b", ease: "steps-0" }), /1 to 100/);
});

test("Lottie holds each step's jump instead of sliding across the frame gap", async () => {
  const layer = createLayer("rectangle", { id: "box", name: "Box", width: 20, height: 20, fill: "#ffffff",
    animations: [{ id: "hop", name: "Hop", kind: "custom", start: 0, duration: 1, easing: "steps", intensity: 4, from: { x: 0 }, to: { x: 90 } }] });
  const scene = createScene({ id: "scene", width: 200, height: 100, duration: 1, layers: [layer] });
  const output = JSON.parse((await exportScene(scene, { format: "lottie", fps: 30 })).buffer).layers.find((item) => item.nm === "Box");
  const keys = output.ks.p.k;
  // Every keyframe whose next one has another value holds, so players never draw a middle value.
  const jumps = keys.filter((key, index) => keys[index + 1] && keys[index + 1].s[0] !== key.s[0]);
  assert.equal(jumps.length, 3);
  assert.ok(jumps.every((key) => key.h === 1 && key.e === undefined));
});
