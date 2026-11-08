import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";

// The value of a Lottie property at `frame`: holds keep their value, others slide.
function at(property, frame) {
  let index = 0;
  while (index + 1 < property.k.length && property.k[index + 1].t <= frame) index += 1;
  const key = property.k[index], next = property.k[index + 1];
  if (!next || key.h) return key.s[0];
  return key.s[0] + (next.s[0] - key.s[0]) * (frame - key.t) / (next.t - key.t);
}

test("Lottie bakes oscillate and stepped randomize into keyframes and holds the steps", async () => {
  const layer = createLayer("rectangle", { id: "box", name: "Box", x: 20, y: 20, width: 40, height: 40, fill: "#ff0000", strokeWidth: 0,
    animations: [{ id: "jitter", name: "Jitter", kind: "custom", start: 0, duration: 2, easing: "linear", from: { rotation: 0, opacity: 1 }, to: { rotation: 0, opacity: 1 },
      behavior: { randomize: { amount: { rotation: 20 }, rate: 3, seed: 4, mode: "stepped" }, oscillate: { amount: { opacity: 0.4 }, period: 1, phase: 0.25 } } }] });
  const scene = createScene({ id: "behaviors", width: 80, height: 80, duration: 2, background: "#ffffff", layers: [layer] });
  const lottie = JSON.parse((await exportScene(scene, { format: "lottie", fps: 12, width: 80, height: 80 })).buffer.toString("utf8"));
  const box = lottie.layers.find((entry) => entry.nm === "Box");
  assert.equal(box.ks.r.a, 1, "rotation is keyed");
  const rotations = [1, 2, 3, 5, 6].map((frame) => at(box.ks.r, frame + 0.5));
  assert.equal(rotations[0], rotations[1], "held inside one random step (12 fps, 3 steps a second)");
  assert.notEqual(rotations[2], rotations[3], "a new value on the next step");
  assert.ok(box.ks.r.k.some((key) => key.h === 1), "the steps hold instead of sliding");
  assert.ok(Math.abs(at(box.ks.o, 0) - 100) < 1e-6 && Math.abs(at(box.ks.o, 6) - 60) < 1e-6, "opacity 1 at the top, 0.6 half a period later");
});
