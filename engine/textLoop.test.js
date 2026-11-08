import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FontRegistry } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { textAnimationPlan, textAnimationUnitState } from "./textAnimation.js";
import { totalUnitDelay, unitDelay } from "./textTiming.js";
import { textLoopOffset } from "./textLoop.js";
import { textUnitGroup } from "./textUnitGeometry.js";
import { layerMatrix, point } from "./geometry.js";

const fonts = new FontRegistry();
fonts.register(await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url)), { family: "Inter", weight: 400, style: "normal" });
const word = (props = {}) => createLayer("text", { id: "t", name: "t", text: "abcde", x: 20, y: 30, width: 400, height: 80, fontFamily: "Inter", fontSize: 40, ...props });
const parsed = (layer) => parseDocument(createDocument({ id: "d", name: "d", scenes: [createScene({ id: "s", name: "s", width: 400, height: 200, duration: 5, layers: [layer] })] })).scenes[0].layers[0];

test("center-out starts the middle letter first, edges-in the outer ones; both take half the steps", () => {
  const delays = (order, n) => Array.from({ length: n }, (_, i) => unitDelay({ stagger: 0.1, order }, i, n).toFixed(2));
  assert.deepEqual(delays("center-out", 5), ["0.20", "0.10", "0.00", "0.10", "0.20"]);
  assert.deepEqual(delays("center-out", 4), ["0.10", "0.00", "0.00", "0.10"]);
  assert.deepEqual(delays("edges-in", 5), ["0.00", "0.10", "0.20", "0.10", "0.00"]);
  assert.equal(totalUnitDelay({ stagger: 0.1, order: "center-out" }, 5).toFixed(2), "0.20");
  assert.deepEqual(delays("forward", 3), ["0.00", "0.10", "0.20"]);
});

test("random order is a seeded shuffle that every unit takes once", () => {
  const order = (seed) => Array.from({ length: 8 }, (_, i) => unitDelay({ stagger: 1, order: "random", orderSeed: seed }, i, 8));
  assert.deepEqual(order(3), order(3));
  assert.notDeepEqual(order(3), order(4));
  assert.deepEqual([...order(3)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  const layer = parsed(word({ animations: [{ id: "a", name: "in", kind: "in", start: 0, duration: 0.5, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 }, unit: "letters", stagger: 0.1, order: "random", orderSeed: 9 }] }));
  assert.equal(layer.animations[0].orderSeed, 9);
  assert.throws(() => parsed(word({ animations: [{ id: "a", name: "in", kind: "in", start: 0, duration: 0.5, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 }, unit: "letters", stagger: 0.1, orderSeed: 9 }] })), /orderSeed/);
});

test("the loop runs between a unit's in and out, stacks with them and stops at out", () => {
  const animations = [
    { id: "in", name: "in", kind: "in", start: 0, duration: 0.5, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 }, unit: "letters", stagger: 0.1 },
    { id: "out", name: "out", kind: "out", start: 3, duration: 0.5, easing: "linear", from: { opacity: 1 }, to: { opacity: 0 }, unit: "letters", stagger: 0.1 },
  ];
  const looped = parsed(word({ animations, textLoop: { style: "wave", amount: 10, speed: 0.5, stagger: 0, ramp: 0 } }));
  const plain = parsed(word({ animations }));
  const state = (layer, unit, time) => textAnimationUnitState(textAnimationPlan(layer, fonts), unit, time);
  // Letter 2 ends its in at 0.2 + 0.5 and starts its out at 3.2.
  for (const time of [0.3, 0.69, 3.2, 3.4]) assert.deepEqual([state(looped, 2, time).y, state(looped, 2, time).opacity], [state(plain, 2, time).y, state(plain, 2, time).opacity], `t ${time}`);
  const mid = state(looped, 2, 1.5);
  assert.ok(Math.abs(mid.y - state(plain, 2, 1.5).y - textLoopOffset(looped.textLoop, 2, 1.5).y) < 1e-9);
  assert.ok(Math.abs(mid.y - plain.y) > 5, "the wave moves the letter");
  assert.equal(mid.opacity, 1);
});

test("pulse grows a unit about its own center, jitter is seeded, a bad loop is refused", () => {
  const layer = parsed(word({ textLoop: { style: "pulse", amount: 50, speed: 1, stagger: 0 } }));
  const plan = textAnimationPlan(layer, fonts);
  const unit = textAnimationUnitState(plan, 0, 0.5);
  assert.ok(Math.abs(unit.scaleX - 1.5) < 1e-9);
  const { bounds } = textUnitGroup(plan.layout, plan.units[0], "letters");
  const center = (state) => point(layerMatrix(state), bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const [grown, rest] = [center(unit), center(textAnimationUnitState(plan, 0, 0, { design: true }))];
  assert.ok(Math.abs(grown.x - rest.x) < 1e-6 && Math.abs(grown.y - rest.y) < 1e-6, "the letter's center stays put");
  const jitter = { style: "jitter", amount: 4, seed: 2 };
  assert.deepEqual(textLoopOffset(jitter, 1, 0.3), textLoopOffset(jitter, 1, 0.3));
  assert.notDeepEqual(textLoopOffset(jitter, 1, 0.3), textLoopOffset({ ...jitter, seed: 3 }, 1, 0.3));
  assert.throws(() => parsed(word({ textLoop: { style: "spin" } })), /textLoop\.style/);
  assert.throws(() => parsed(createLayer("rectangle", { id: "t", name: "t", textLoop: { style: "wave" } })), /only text layers/);
});
