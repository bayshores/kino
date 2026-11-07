import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { collectRasterSequences } from "./lottie-raster-sequences.mjs";

const svg = (color = "#ff0000") => `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2"><rect width="2" height="2" fill="${color}"/></svg>`;
const target = (id = "layer-1", name = "Hero", effects = ["Noise Warp"]) => ({ id, name, effects });
const captureResult = (overrides = {}) => ({
  svg: svg(),
  bounds: { x: 1, y: 2, width: 2, height: 2 },
  width: 2,
  height: 2,
  ...overrides,
});

test("held frames share one real PNG and merge into a single half-open interval", async () => {
  const events = [];
  const captures = [];
  const sequences = await collectRasterSequences([target()], [0, 0.25, 0.5, 0.75], {
    capture: async (item, time, index) => {
      captures.push([item.id, time, index]);
      return captureResult();
    },
    onProgress: (event) => events.push(event),
  });
  const sequence = sequences.get("layer-1");
  assert.equal(captures.length, 4);
  assert.deepEqual(sequence.bounds, { x: 1, y: 2, width: 2, height: 2 });
  assert.equal(sequence.assets.size, 1);
  assert.deepEqual(sequence.frames.map(({ start, end, width, height }) => ({ start, end, width, height })), [
    { start: 0, end: 4, width: 2, height: 2 },
  ]);
  assert.deepEqual(events, [1, 2, 3, 4].map((completed) => ({ stage: "render", completed, total: 4 })));

  const frame = sequence.frames[0];
  const image = await loadImage(sequence.assets.get(frame.assetKey).buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  assert.deepEqual([...context.getImageData(0, 0, 2, 2).data], [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
});

test("changed local origins keep separate intervals while reusing identical raster pixels", async () => {
  const sequences = await collectRasterSequences([target()], [0, 1], {
    capture: (_item, _time, index) => captureResult({
      bounds: { x: index * 5, y: -2, width: 2, height: 2 },
    }),
    limits: { maxPixels: 8 },
  });
  const sequence = sequences.get("layer-1");
  assert.deepEqual(sequence.bounds, { x: 0, y: -2, width: 7, height: 2 });
  assert.equal(sequence.frames.length, 2, "a changed local origin must not merge frame intervals");
  assert.equal(sequence.frames[0].assetKey, sequence.frames[1].assetKey, "the embedded PNG is origin-independent");
  assert.deepEqual(sequence.frames.map((frame) => frame.bounds.x), [0, 5]);
  assert.equal(sequence.assets.size, 1);
});

test("identical SVG captures across targets reuse exact native raster work and one asset", async () => {
  const sequences = await collectRasterSequences([
    target("one", "One", ["Noise Warp"]),
    target("two", "Two", ["Fluted Glass"]),
  ], [0], {
    capture: () => captureResult(),
    limits: { maxPixels: 4 },
  });
  const first = sequences.get("one"), second = sequences.get("two");
  const firstKey = first.frames[0].assetKey;
  assert.equal(second.frames[0].assetKey, firstKey);
  assert.equal(first.assets.get(firstKey), second.assets.get(firstKey));
});

test("sample and pixel limits refuse with the layer, effect, and limit before raster allocation", async () => {
  let calls = 0;
  await assert.rejects(collectRasterSequences([
    target("one", "One", ["Bulge"]),
    target("two", "Second", ["Fluted Glass"]),
  ], [0, 1], {
    capture: () => { calls += 1; return captureResult(); },
    limits: { maxSamples: 3 },
  }), /Fluted Glass on layer “Second” exceeds the maxSamples limit \(3\)/u);
  assert.equal(calls, 0, "sample caps are checked before capture starts");

  await assert.rejects(collectRasterSequences([target("too-large", "Oversized", ["Ripple"])], [0], {
    capture: () => captureResult({
      // Invalid SVG proves the pixel cap is checked before Resvg parses/renders it.
      svg: "<not-valid-svg",
      width: 3,
      height: 2,
    }),
    limits: { maxPixels: 5 },
  }), /Ripple on layer “Oversized” exceeds the maxPixels limit \(5\)/u);

  await assert.rejects(collectRasterSequences([target("wide", "Too wide", ["Bulge"])], [0], {
    capture: () => captureResult({ width: 3, height: 2 }),
    limits: { maxSide: 2 },
  }), /Bulge on layer “Too wide” exceeds the maxSide limit \(2\)/u);
});

test("pixel identity dedupes different SVG markup into one held interval", async () => {
  const sequences = await collectRasterSequences([target()], [0, 1], {
    capture: (_item, _time, index) => captureResult({
      svg: index === 0 ? svg("red") : '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="#ff0000" d="M0 0H2V2H0Z"/></svg>',
    }),
    limits: { maxPixels: 8 },
  });
  const sequence = sequences.get("layer-1");
  assert.equal(sequence.frames.length, 1, "same image and same bounds merge even when source markup differs");
  assert.equal(sequence.frames[0].end, 2);
  assert.equal(sequence.assets.size, 1);
});

test("abort during a progress callback stops before the next asynchronous capture", async () => {
  const controller = new AbortController();
  let calls = 0;
  const events = [];
  const pending = collectRasterSequences([target()], [0, 1, 2], {
    signal: controller.signal,
    capture: () => { calls += 1; return captureResult(); },
    onProgress(event) {
      events.push(event);
      if (event.completed === 1) {
        setImmediate(() => controller.abort(Object.assign(new Error("cancel requested"), { name: "AbortError" })));
      }
    },
  });
  await assert.rejects(pending, { name: "AbortError", message: "cancel requested" });
  assert.equal(calls, 1);
  assert.deepEqual(events, [{ stage: "render", completed: 1, total: 3 }]);
});
