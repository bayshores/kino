import test from "node:test";
import assert from "node:assert/strict";
import { blendRenderSamples, createSampleBlend, MAX_MOTION_SAMPLES, motionSampleTimes, normalizeRenderQuality } from "./render-quality.mjs";

function sample(width, height, rgba, premultiplied) {
  return {
    width,
    height,
    pixels: Uint8Array.from(rgba),
    ...(premultiplied === undefined ? {} : { premultiplied }),
  };
}

function pixelAt(result, x, y = 0) {
  const offset = (y * result.width + x) * 4;
  return Array.from(result.pixels.subarray(offset, offset + 4));
}

test("the two-sample fast path matches general premultiplied blending at every alpha", () => {
  const first = new Uint8Array(256 * 4), second = new Uint8Array(256 * 4);
  for (let alpha = 0; alpha < 256; alpha++) {
    first.set([alpha, Math.floor(alpha / 2), 0, alpha], alpha * 4);
    second.set([0, alpha, Math.floor(alpha / 3), alpha], alpha * 4);
  }
  const a = { pixels: first, width: 32, height: 8 }, b = { pixels: second, width: 32, height: 8 };
  for (const dither of [false, true]) assert.deepEqual(blendRenderSamples([a, b], { dither }),
    blendRenderSamples([a, b, a, b], { dither }));
});

test("normalizes render quality defaults and explicit values", () => {
  assert.deepEqual(normalizeRenderQuality(), { motionBlur: 0, motionSamples: 2, dither: false });
  assert.deepEqual(normalizeRenderQuality({ motionBlur: 0.65, dither: true, width: 1280 }), {
    motionBlur: 0.65,
    motionSamples: 2,
    dither: true,
  });
});

test("a shutter angle is the same as motionBlur in degrees, with a sample count", () => {
  assert.deepEqual(normalizeRenderQuality({ shutterAngle: 180, motionSamples: 8 }), { motionBlur: 0.5, motionSamples: 8, dither: false });
  assert.deepEqual(normalizeRenderQuality({ shutterAngle: 360 }), { motionBlur: 1, motionSamples: 2, dither: false });
  assert.equal(normalizeRenderQuality({ shutterAngle: 90, motionBlur: 0.25 }).motionBlur, 0.25);
  assert.throws(() => normalizeRenderQuality({ shutterAngle: 180, motionBlur: 0.25 }), /shutterAngle 180 is motionBlur 0.5/);
  for (const shutterAngle of [-1, 361]) assert.throws(() => normalizeRenderQuality({ shutterAngle }), RangeError);
  for (const shutterAngle of ["180", Number.NaN]) assert.throws(() => normalizeRenderQuality({ shutterAngle }), TypeError);
  for (const motionSamples of [1, 17]) assert.throws(() => normalizeRenderQuality({ motionSamples }), RangeError);
  for (const motionSamples of [2.5, "8"]) assert.throws(() => normalizeRenderQuality({ motionSamples }), TypeError);
  assert.equal(MAX_MOTION_SAMPLES, 16);
});

test("more shutter samples spread evenly over the open shutter, each in the middle of its slice", () => {
  // 180° at 10 fps: the shutter is open from 0.475 to 0.525.
  const times = motionSampleTimes(0.5, 2, 10, 0.5, 4);
  assert.deepEqual(times.map((time) => Number(time.toFixed(6))), [0.48125, 0.49375, 0.50625, 0.51875]);
  assert.deepEqual(motionSampleTimes(0.5, 2, 10, 0, 8), [0.5]);
  assert.deepEqual(motionSampleTimes(0, 1, 10, 1, 4).slice(0, 2), [0, 0]);
  assert.throws(() => motionSampleTimes(0.5, 2, 10, 0.5, 17), RangeError);
});

test("a sample blend added one at a time matches blending all samples at once", () => {
  const width = 16, height = 8, count = 7, samples = [];
  for (let index = 0; index < count; index += 1) {
    const pixels = new Uint8Array(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = (offset * 7 + index * 53) % 256;
      pixels.set([Math.floor(alpha * ((offset + index) % 5) / 4), Math.floor(alpha / 2), alpha, alpha], offset);
    }
    samples.push({ width, height, pixels, premultiplied: true });
  }
  for (const dither of [false, true]) {
    const blend = createSampleBlend(width, height);
    for (const item of samples) blend.add(item);
    assert.equal(blend.count, count);
    assert.deepEqual(blend.finish({ dither }), blendRenderSamples(samples, { dither }));
  }
  assert.throws(() => createSampleBlend(width, height).finish(), TypeError);
  assert.throws(() => createSampleBlend(width, height).add(sample(1, 1, [0, 0, 0, 0])), RangeError);
  assert.throws(() => createSampleBlend(1, 1).add(sample(1, 1, [0, 0, 0, 0], false)), TypeError);
});

test("rejects malformed render quality values", () => {
  for (const options of [null, [], "draft"]) assert.throws(() => normalizeRenderQuality(options), TypeError);
  for (const motionBlur of [-0.01, 1.01]) assert.throws(() => normalizeRenderQuality({ motionBlur }), RangeError);
  for (const motionBlur of ["0.5", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeRenderQuality({ motionBlur }), TypeError);
  }
  for (const dither of [null, 0, "yes"]) assert.throws(() => normalizeRenderQuality({ dither }), TypeError);
});

test("uses one sample without blur and centered shutter midpoints with blur", () => {
  assert.deepEqual(motionSampleTimes(0.5, 2, 10, 0), [0.5]);
  assert.deepEqual(motionSampleTimes(0.5, 2, 10, 1), [0.475, 0.525]);
  assert.deepEqual(motionSampleTimes(0, 1, 10, 1), [0, 0.025]);
  assert.deepEqual(motionSampleTimes(1, 1, 10, 1), [0.975, 1]);
});

test("rejects invalid shutter sampling inputs", () => {
  assert.throws(() => motionSampleTimes(Number.NaN, 1, 30, 0), TypeError);
  assert.throws(() => motionSampleTimes(0, 0, 30, 0), RangeError);
  assert.throws(() => motionSampleTimes(0, 1, 0, 0), RangeError);
  assert.throws(() => motionSampleTimes(1.1, 1, 30, 0), RangeError);
  assert.throws(() => motionSampleTimes(0, 1, 30, 1.1), RangeError);
});

test("averages premultiplied samples before unpremultiplying, avoiding dark alpha fringes", () => {
  // Half-transparent red in premultiplied form, followed by a transparent pixel.
  const result = blendRenderSamples([
    sample(1, 1, [128, 0, 0, 128]),
    sample(1, 1, [0, 0, 0, 0]),
  ]);
  assert.deepEqual(pixelAt(result, 0), [255, 0, 0, 64]);
});

test("converts straight-alpha input before blending with premultiplied samples", () => {
  const result = blendRenderSamples([
    sample(1, 1, [255, 0, 0, 128], false),
    sample(1, 1, [0, 0, 0, 0], true),
  ]);
  assert.deepEqual(pixelAt(result, 0), [255, 0, 0, 64]);
});

test("averages moving opaque edges into stable partial coverage", () => {
  const first = sample(4, 1, [
    255, 255, 255, 255,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const second = sample(4, 1, [
    0, 0, 0, 0,
    255, 255, 255, 255,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const result = blendRenderSamples([first, second]);
  assert.deepEqual(pixelAt(result, 0), [255, 255, 255, 128]);
  assert.deepEqual(pixelAt(result, 1), [255, 255, 255, 128]);
  assert.deepEqual(pixelAt(result, 2), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(result, 3), [0, 0, 0, 0]);
});

test("spatial dither is repeatable, frame-independent, and leaves alpha unchanged", () => {
  const pixels = new Uint8Array(16 * 8 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 100;
    pixels[offset + 1] = 80;
    pixels[offset + 2] = 60;
    pixels[offset + 3] = 173;
  }
  const input = { width: 16, height: 8, pixels, premultiplied: false };
  const first = blendRenderSamples([input], { dither: true });
  const repeated = blendRenderSamples([input], { dither: true });
  const undithered = blendRenderSamples([input]);
  assert.deepEqual(first.pixels, repeated.pixels);
  for (let y = 0; y < first.height; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      assert.deepEqual(pixelAt(first, x, y), pixelAt(first, x + 8, y));
    }
  }
  for (let pixel = 0; pixel < first.width * first.height; pixel += 1) {
    const offset = pixel * 4;
    assert.ok(Math.abs(first.pixels[offset] - 100) === 1);
    assert.ok(Math.abs(first.pixels[offset + 1] - 80) === 1);
    assert.ok(Math.abs(first.pixels[offset + 2] - 60) === 1);
    assert.equal(first.pixels[offset + 3], undithered.pixels[offset + 3]);
    assert.equal(first.pixels[offset + 3], 173);
  }
  assert.deepEqual(pixelAt(undithered, 0, 0), [100, 80, 60, 173]);
});

test("zero-alpha pixels always return zero RGB, including with dither", () => {
  const result = blendRenderSamples([sample(1, 1, [29, 150, 200, 0])], { dither: true });
  assert.deepEqual(pixelAt(result, 0), [0, 0, 0, 0]);
});

test("validates sample data, matching dimensions, and the 64-megapixel limit", () => {
  assert.throws(() => blendRenderSamples([]), TypeError);
  assert.throws(() => blendRenderSamples([null]), TypeError);
  assert.throws(() => blendRenderSamples([sample(1, 1, [1, 2, 3])]), RangeError);
  assert.throws(() => blendRenderSamples([{ width: 1, height: 1, pixels: [1, 2, 3, 4] }]), TypeError);
  assert.throws(() => blendRenderSamples([
    sample(1, 1, [0, 0, 0, 0]),
    sample(2, 1, [0, 0, 0, 0, 0, 0, 0, 0]),
  ]), RangeError);
  assert.throws(() => blendRenderSamples([sample(8000, 8001, [])]), RangeError);
  assert.throws(() => blendRenderSamples([sample(1, 1, [0, 0, 0, 0], null)]), TypeError);
  assert.throws(() => blendRenderSamples([sample(1, 1, [0, 0, 0, 0])], { dither: 1 }), TypeError);
});
