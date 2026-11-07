// Motion blur from layer movement with more shutter samples (render options shutterAngle and
// motionSamples), drawn by both export renderers and checked pixel by pixel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { readImage } from "./media.test.support.mjs";

// A 20 px white bar that crosses 3600 px a second. At 30 fps a 180° shutter is open for 1/60 s,
// so the bar travels 60 px while it is open: from x=330 to x=390 around the frame at 0.1 s.
function barScene({ add = false } = {}) {
  const bar = createLayer("rectangle", { id: "bar", name: "Bar", x: 0, y: 0, width: 20, height: 40, fill: "#FFFFFF", radius: 0, strokeWidth: 0,
    ...(add ? { blendMode: "add" } : {}),
    animations: [{ id: "bar.move", name: "Move", kind: "custom", start: 0, duration: 0.2, easing: "linear", from: { x: 0 }, to: { x: 720 } }] });
  return parseDocument(createDocument({ id: "bar", name: "Bar",
    scenes: [createScene({ id: "main", name: "Main", width: 800, height: 40, duration: 0.2, background: "#000000", layers: [bar] })] })).scenes[0];
}

async function row(scene, options) {
  const { buffer } = await exportScene(scene, { format: "png", time: 0.1, fps: 30, shutterAngle: 180, ...options });
  const image = await readImage(buffer);
  return Array.from({ length: 120 }, (_, index) => image.pixel(300 + index, 20)[0]);
}

const at = (values, x) => values[x - 300];
const largestStep = (values) => Math.max(...values.slice(1).map((value, index) => Math.abs(value - values[index])));

test("two shutter samples leave a gap between two copies of a fast bar; eight smear it in even steps, as the default does", async (t) => {
  for (const add of [false, true]) {
    // add: true is drawn by Chromium (backend/raster-policy.mjs), the plain bar by resvg.
    const scene = barScene({ add });
    const two = await row(scene, { motionSamples: 2 });
    const eight = await row(scene, { motionSamples: 8 });
    // Without motionSamples a frame draws as many as its fastest move needs (60 px over 8 px apart).
    assert.deepEqual(await row(scene, {}), eight);
    const sixteen = await row(scene, { motionSamples: 16 });
    const label = add ? "Chromium" : "resvg";
    const every5 = (values) => Array.from({ length: 17 }, (_, index) => at(values, 330 + index * 5)).join(",");
    t.diagnostic(`${label}, x=330..410 every 5 px: 2 samples ${every5(two)}; 8 samples ${every5(eight)}`);
    // Two samples: bars at 345..365 and 375..395, black between them.
    assert.ok(at(two, 355) > 120 && at(two, 385) > 120 && at(two, 370) < 8, `${label} 2 samples: ${two.join(" ")}`);
    // Eight samples, 7.5 px apart: no gap, and the middle is about a third white (20 of 60 px).
    for (let x = 336; x <= 404; x += 1) assert.ok(at(eight, x) > 20, `${label} 8 samples: no gap at x=${x}: ${eight.join(" ")}`);
    assert.ok(Math.abs(at(eight, 360) - 85) <= 20, `${label} 8 samples: middle ${at(eight, 360)}`);
    assert.ok(largestStep(eight) <= 40, `${label} 8 samples: steps ${largestStep(eight)}`);
    assert.ok(largestStep(sixteen) <= 22, `${label} 16 samples: steps ${largestStep(sixteen)}`);
    assert.ok(at(eight, 320) < 4 && at(eight, 412) < 4, `${label} 8 samples: the smear ends where the shutter does`);
  }
});

test("a frame where nothing moves is the same with one sample or sixteen", async () => {
  const scene = barScene();
  scene.layers[0].animations = [];
  const still = await exportScene(scene, { format: "png", time: 0.1, fps: 30, dither: true });
  const sixteen = await exportScene(scene, { format: "png", time: 0.1, fps: 30, dither: true, shutterAngle: 360, motionSamples: 16 });
  assert.deepEqual(sixteen.buffer, still.buffer);
});
