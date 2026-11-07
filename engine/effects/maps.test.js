import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { cachedMap, cachedMapImage, clearMapCache, fractalNoise, mapDimensions, noise2d, pngDataUri } from "./maps.js";

test("mapDimensions preserves aspect ratio and caps each raster side", () => {
  assert.deepEqual(mapDimensions({ width: 1000, height: 400 }), { width: 256, height: 103 });
  assert.deepEqual(mapDimensions({ x: 20, y: -5, width: 1000, height: 400 }), { width: 256, height: 103 });
  assert.deepEqual(mapDimensions({ width: 3, height: 7 }, 4), { width: 2, height: 4 });
  assert.deepEqual(mapDimensions({ width: 0.1, height: 0.1 }), { width: 1, height: 1 });
  assert.deepEqual(mapDimensions({ width: 1000, height: 400 }, 512), { width: 512, height: 205 });
  assert.throws(() => mapDimensions({ width: 0, height: 4 }), /finite positive/);
  assert.throws(() => mapDimensions({ width: 4, height: 4 }, 513), /1 to 512/);
});

test("pngDataUri produces a decodable RGBA PNG with the requested pixels", async () => {
  const calls = [];
  const uri = pngDataUri(2, 2, (x, y, width, height) => {
    calls.push([x, y, width, height]);
    return [x * 100, y * 100, x + y, 255 - x * 10 - y * 20];
  });
  assert.match(uri, /^data:image\/png;base64,/);
  assert.deepEqual(calls, [[0, 0, 2, 2], [1, 0, 2, 2], [0, 1, 2, 2], [1, 1, 2, 2]]);

  const image = await loadImage(uri);
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  assert.deepEqual([...context.getImageData(0, 0, 2, 2).data], [
    0, 0, 0, 255, 100, 0, 1, 245,
    0, 100, 1, 235, 100, 100, 2, 225,
  ]);
});

test("PNG inputs and pixel channels are validated", () => {
  for (const [width, height] of [[0, 1], [1.5, 1], [513, 1], [1, 513]])
    assert.throws(() => pngDataUri(width, height, () => [0, 0, 0, 0]), /integer from 1 to 512/);
  assert.match(pngDataUri(512, 1, () => [0, 0, 0, 0]), /^data:image\/png;base64,/);
  assert.throws(() => pngDataUri(1, 1, 0), /pixelFn must be a function/);
  assert.throws(() => pngDataUri(1, 1, () => [0, 1, 2]), /four RGBA bytes/);
  assert.throws(() => pngDataUri(1, 1, () => [0, 1, 2, 256]), /invalid RGBA byte/);
});

test("cachedMap keys dimensions, reuses results, and evicts the least-recently-used entry at 64", () => {
  clearMapCache();
  let calls = 0;
  const draw = () => { calls += 1; return [10, 20, 30, 255]; };
  const first = cachedMap("same", 1, 1, draw);
  assert.match(first, /^data:image\/png;base64,/);
  assert.equal(cachedMap("same", 1, 1, draw), first);
  cachedMap("same", 2, 1, draw);
  assert.equal(calls, 3);

  clearMapCache();
  const perKeyCalls = new Map();
  const renderer = (key) => () => {
    perKeyCalls.set(key, (perKeyCalls.get(key) ?? 0) + 1);
    return [key, 0, 0, 255];
  };
  for (let key = 0; key < 64; key += 1) cachedMap(key, 1, 1, renderer(key));
  cachedMap(0, 1, 1, renderer(0)); // promote entry 0 before evicting the oldest.
  cachedMap(64, 1, 1, renderer(64));
  cachedMap(0, 1, 1, renderer(0));
  cachedMap(1, 1, 1, renderer(1));
  assert.equal(perKeyCalls.get(0), 1);
  assert.equal(perKeyCalls.get(1), 2);
  assert.equal(perKeyCalls.get(64), 1);
  clearMapCache();
  cachedMap(2, 1, 1, renderer(2));
  assert.equal(perKeyCalls.get(2), 2);
});

test("cachedMapImage returns pixels matching its PNG and runs pixelFn once per cached entry", async () => {
  clearMapCache();
  let calls = 0;
  const paint = (x, y, width, height) => {
    calls += 1;
    assert.deepEqual([width, height], [2, 2]);
    return [x * 100, y * 100, x + y, 255 - x * 10 - y * 20];
  };
  const image = cachedMapImage("image", 2, 2, paint);
  assert.deepEqual([image.width, image.height], [2, 2]);
  assert.deepEqual([...image.pixels], [
    0, 0, 0, 255, 100, 0, 1, 245,
    0, 100, 1, 235, 100, 100, 2, 225,
  ]);
  assert.equal(calls, 4, "each pixel is sampled once while both forms are generated");

  const decoded = await loadImage(image.uri);
  const canvas = createCanvas(2, 2), context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  assert.deepEqual([...context.getImageData(0, 0, 2, 2).data], [...image.pixels]);
  assert.strictEqual(cachedMapImage("image", 2, 2, () => { calls += 1; return [0, 0, 0, 0]; }), image);
  assert.equal(cachedMap("image", 2, 2, () => { calls += 1; return [0, 0, 0, 0]; }), image.uri);
  assert.equal(calls, 4, "both public APIs share the cached URI and pixels");
});

test("PNG and cached image dimensions accept an explicit 512-pixel side", () => {
  clearMapCache();
  const paint = () => [20, 40, 60, 255];
  const image = cachedMapImage("max-side", 512, 1, paint);
  assert.deepEqual([image.width, image.height, image.pixels.length], [512, 1, 512 * 4]);
  assert.match(cachedMap("max-side-string", 1, 512, paint), /^data:image\/png;base64,/);
  assert.throws(() => cachedMapImage("too-wide", 513, 1, paint), /integer from 1 to 512/);
  assert.throws(() => cachedMap("too-high", 1, 513, paint), /integer from 1 to 512/);
  clearMapCache();
});

test("cachedMap and cachedMapImage share one 64-entry LRU", () => {
  clearMapCache();
  const calls = new Map();
  const paint = (key) => () => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return [key, 0, 0, 255];
  };
  const firstImage = cachedMapImage(0, 1, 1, paint(0));
  for (let key = 1; key < 64; key += 1) {
    if (key % 2) cachedMap(key, 1, 1, paint(key));
    else cachedMapImage(key, 1, 1, paint(key));
  }
  assert.equal(cachedMap(0, 1, 1, paint(0)), firstImage.uri);
  assert.strictEqual(cachedMapImage(0, 1, 1, paint(0)), firstImage);
  cachedMapImage(64, 1, 1, paint(64));
  assert.equal(calls.get(0), 1, "string access promotes an image entry without regenerating it");
  assert.equal(calls.get(1), 1);
  cachedMapImage(1, 1, 1, paint(1));
  assert.equal(calls.get(1), 2, "the least recently used string entry is evicted by an image insertion");
  clearMapCache();
});

test("the shared LRU evicts at the 16 MiB retained-pixel budget", () => {
  clearMapCache();
  const renders = new Map();
  const paint = (key) => (x, y) => {
    if (x === 0 && y === 0) renders.set(key, (renders.get(key) ?? 0) + 1);
    return [12, 34, 56, 255];
  };
  const side = 512, bytesPerImage = side * side * 4;
  assert.equal(bytesPerImage * 16, 16 * 1024 * 1024);
  cachedMapImage(0, side, side, paint(0));
  for (let key = 1; key < 16; key += 1) {
    if (key % 2) cachedMap(key, side, side, paint(key));
    else cachedMapImage(key, side, side, paint(key));
  }
  assert.equal(cachedMap(0, side, side, paint(0)).startsWith("data:image/png;base64,"), true,
    "a cache read through the string API promotes the first image");
  cachedMapImage(16, side, side, paint(16));
  cachedMapImage(0, side, side, paint(0));
  assert.equal(renders.get(0), 1, "the promoted oldest image stays in cache");
  cachedMap(1, side, side, paint(1));
  assert.equal(renders.get(1), 2, "the least recently used entry is evicted when retained pixels exceed 16 MiB");
  clearMapCache();
});

test("seeded smooth noise is deterministic, continuous at lattice boundaries, and normalized", () => {
  assert.equal(noise2d(0.25, -3.5, 17), noise2d(0.25, -3.5, 17));
  assert.notEqual(noise2d(0.25, -3.5, 17), noise2d(0.25, -3.5, 18));
  const left = noise2d(0.99999, 0.37, 5), right = noise2d(1.00001, 0.37, 5);
  assert.ok(Math.abs(left - right) < 1e-7, `${left} vs ${right}`);
  for (const [x, y] of [[-20, -3], [0, 0], [1.5, 8], [99, -4]]) {
    assert.ok(noise2d(x, y, 42) >= -1 && noise2d(x, y, 42) <= 1);
    const fractal = fractalNoise(x, y, 8, 42);
    assert.ok(fractal >= -1 && fractal <= 1);
    assert.equal(fractal, fractalNoise(x, y, 8, 42));
  }
  assert.throws(() => noise2d(Infinity, 0), /coordinates must be finite/);
  assert.throws(() => fractalNoise(0, 0, 9), /integer from 1 to 8/);
});

test("noise with a period repeats every period cells on both axes; period 0 is the old field", () => {
  const near = (left, right, label) => assert.ok(Math.abs(left - right) < 1e-9, `${label}: ${left} vs ${right}`);
  for (const [x, y] of [[0.3, 0.7], [5.25, 2.5], [15.9, 0.01]]) {
    near(noise2d(x, y, 9, 16), noise2d(x + 16, y, 9, 16), "repeats across");
    near(noise2d(x, y, 9, 16), noise2d(x, y - 32, 9, 16), "repeats down, also below zero");
    near(fractalNoise(x, y, 5, 9, 16), fractalNoise(x + 16, y + 16, 5, 9, 16), "every octave repeats");
    assert.equal(noise2d(x, y, 9, 0), noise2d(x, y, 9));
    assert.equal(fractalNoise(x, y, 5, 9, 0), fractalNoise(x, y, 5, 9));
  }
  assert.ok(Math.abs(noise2d(0.3, 0.7, 9) - noise2d(16.3, 0.7, 9)) > 1e-6, "without a period the field does not repeat");
  assert.throws(() => noise2d(0, 0, 0, 1.5), /whole number of cells/);
  assert.throws(() => fractalNoise(0, 0, 4, 0, -1), /whole number of cells/);
});
