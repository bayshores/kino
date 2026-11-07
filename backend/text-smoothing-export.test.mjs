import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "../engine/model.js";
import { easingAt } from "../engine/easing.js";
import { exportFrameStep } from "../engine/exportOptions.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

function scene(smoothing = "ease-in", order = "forward") {
  return createScene({ id: "timing", name: "Text delays", width: 240, height: 90,
    duration: 2, background: "#ffffff", layers: [createLayer("text", {
      id: "text", name: "Letters", text: "HHHH", x: 20, y: 20, width: 200, height: 60,
      fontSize: 40, fill: "#111111", animations: [{ id: "fade", name: "Fade", kind: "in",
        start: 0, duration: .8, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 },
        unit: "letters", stagger: .3, order, smoothing, smoothingIntensity: 75,
      }],
    })] });
}

function valueAt(property, frame) {
  if (property.a !== 1) return property.k;
  const keys = property.k;
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index];
    if (frame < key.t) continue;
    if (key.h === 1 || !key.e || index === keys.length - 1) return key.s;
    const amount = (frame - key.t) / (keys[index + 1].t - key.t);
    return key.s.map((value, axis) => value + (key.e[axis] - value) * amount);
  }
  return keys[0].s;
}

test("Lottie preserves smoothed per-letter start times independently from progress easing", async () => {
  for (const smoothing of ["smooth", "natural", "ease-out", "ease-in", "linear", [.3, -1, .7, 2]]) {
    for (const order of ["forward", "reverse"]) {
      const result = await exportScene(scene(smoothing, order), { format: "lottie", fps: 10 });
      assert.equal(result.warnings, undefined);
      const exported = JSON.parse(result.buffer);
      const letters = exported.layers.filter((layer) => /^Letters \d+$/.test(layer.nm))
        .sort((a, b) => Number(a.nm.split(" ").at(-1)) - Number(b.nm.split(" ").at(-1)));
      assert.equal(letters.length, 4);
      for (const [index, letter] of letters.entries()) {
        const position = order === "reverse" ? 3 - index : index;
        const delay = .9 * Math.max(0, Math.min(1, easingAt(smoothing, position / 3, 75)));
        for (const frame of [0, 3, 6, 9, 12, 17, 19]) {
          const expected = Math.max(0, Math.min(1, (frame * exportFrameStep(10) - delay) / .8)) * 100;
          assert.ok(Math.abs(valueAt(letter.ks.o, frame)[0] - expected) < 1e-3,
            `${smoothing} ${order}, unit ${index}, frame ${frame}`);
        }
      }
    }
  }
});

test("None smoothing retains exact legacy PNG frames while curved delay changes the middle units", async () => {
  const linear = scene("linear"), legacy = structuredClone(linear), curved = scene("ease-in");
  delete legacy.layers[0].animations[0].smoothing;
  delete legacy.layers[0].animations[0].smoothingIntensity;
  for (const time of [0, .4, .75, 1.2, 1.9]) {
    const a = await exportScene(linear, { format: "png", time });
    const b = await exportScene(legacy, { format: "png", time });
    assert.deepEqual(a.buffer, b.buffer, `legacy pixels at ${time}`);
  }
  assert.notDeepEqual((await exportScene(linear, { format: "png", time: .75 })).buffer,
    (await exportScene(curved, { format: "png", time: .75 })).buffer);
});

test("encoded GIF and MP4 keep the smoothed text frames", { skip: skipWithoutMediaTools }, async () => {
  const input = scene("natural", "reverse"), width = 240, height = 90, frameBytes = width * height * 4;
  const framesToCheck = [0, 1, 3, 5, 7, 8];
  const expected = new Map();
  for (const frame of framesToCheck)
    expected.set(frame, await readImage((await exportScene(input, { format: "png", time: frame / 4 })).buffer));
  for (const format of ["gif", "mp4"]) {
    const encoded = await exportScene(input, { format, fps: 4 });
    const decoded = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vf", "fps=4", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: encoded.buffer });
    const frameCount = format === "gif" ? 9 : 8; // GIF includes the existing endpoint frame.
    assert.equal(decoded.length, frameBytes * frameCount, `${format} contains the full scene`);
    for (const frame of framesToCheck.filter((index) => index < frameCount)) {
      const png = expected.get(frame);
      let total = 0, intersection = 0, union = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const actual = decoded[frame * frameBytes + (y * width + x) * 4], reference = png.pixel(x, y)[0];
        total += Math.abs(actual - reference);
        if (actual < 230 || reference < 230) union++;
        if (actual < 230 && reference < 230) intersection++;
      }
      assert.ok(total / (width * height) < 2, `${format} frame ${frame}: mean gray difference`);
      assert.ok(!union || intersection / union > .9, `${format} frame ${frame}: same visible units`);
    }
  }
});
