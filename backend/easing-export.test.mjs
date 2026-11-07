import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "../engine/model.js";
import { evaluateLayer } from "../engine/animation.js";
import { exportScene } from "./export.mjs";
import { exportFrameStep } from "../engine/exportOptions.js";

function valueAt(property, frame) {
  if (!property.a) return property.k;
  const keys = property.k;
  let index = 0;
  while (index + 1 < keys.length && keys[index + 1].t <= frame) index += 1;
  const key = keys[index], next = keys[index + 1];
  const progress = !next || key.h ? 0 : (frame - key.t) / (next.t - key.t);
  return key.s.map((value, part) => value + ((key.e ?? next?.s ?? key.s)[part] - value) * progress);
}

test("Lottie position samples use the same intensity at the shared export frame times", async () => {
  for (const easing of ["smooth", "natural", "ease-out", "ease-in", "elastic", "bounce", "overshoot", "impulse", "swing"])
    for (const intensity of [0, 100]) {
      const layer = createLayer("rectangle", { id: "moving", name: "Moving", width: 20, height: 20, y: 30,
        animations: [{ id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing, intensity, from: { x: 0 }, to: { x: 100 } }] });
      const scene = createScene({ id: "scene", width: 240, height: 100, duration: 1, layers: [layer] });
      const result = JSON.parse((await exportScene(scene, { format: "lottie", fps: 30 })).buffer);
      const output = result.layers.find((item) => item.nm === "Moving");
      for (const frame of [0, 3, 9, 15, 21, 29]) {
        const actual = valueAt(output.ks.p, frame)[0] - 10;
        // The existing reference-compatible schedule rounds each frame step to 0.0001 ms.
        // Natural at 100 has a vertical tangent at its midpoint, so even a sub-microsecond
        // difference from frame/fps can cause a visible difference. Compare the same clock.
        const expected = evaluateLayer(layer, frame * exportFrameStep(30)).x;
        assert.ok(Math.abs(actual - expected) < 0.5, `${easing}/${intensity} frame ${frame}: ${actual} vs ${expected}`);
      }
    }
});
