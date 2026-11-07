import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { cachedMapImage, clearMapCache } from "./maps.js";
import { effectMapImage } from "./mapImage.js";
import { filterEffect } from "./svg.js";

const WIDTH = 64;
const HEIGHT = 48;
const BOUNDS = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
const CANVAS = { width: 176, height: 136 };
const localKey = (key, bounds = BOUNDS) => JSON.stringify(["effect-map-local-v1", key, bounds]);
const PALETTE = [
  [245, 47, 60], [255, 203, 45], [45, 91, 239], [33, 205, 156], [248, 248, 248], [46, 82, 136],
];

function paintPixel(x, y) {
  let color = PALETTE[5];
  if (x < 22 && y < 18) color = PALETTE[0];
  else if (x >= 43 && y < 14) color = PALETTE[1];
  else if (x < 15 && y >= 34) color = PALETTE[2];
  else if (x >= 48 && y >= 28) color = PALETTE[3];
  else if (x >= 28 && x < 34 && y >= 20 && y < 26) color = PALETTE[4];
  return [...color, 255];
}

function readPngDimensions(uri) {
  assert.match(uri, /^data:image\/png;base64,/);
  const png = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function renderFilterImage(uri, matrix) {
  const sourceRect = `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`;
  let sequence = 0;
  const defs = [];
  const frame = {
    content: sourceRect,
    bounds: BOUNDS,
    helpers: { id: (kind) => `map-filter-${kind}-${++sequence}`, defs, raster: true, transform: matrix },
  };
  const filtered = filterEffect(frame, [
    `<feImage href="${uri}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="none" result="mapImage"/>`,
    '<feComposite in="mapImage" in2="SourceAlpha" operator="in"/>',
  ]);
  const outer = `matrix(${matrix.join(" ")})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}"><defs>${defs.join("")}</defs><g transform="${outer}">${filtered}</g></svg>`;
  return new Resvg(svg).render().pixels;
}

function renderRegularImage(uri, matrix) {
  const outer = `matrix(${matrix.join(" ")})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}"><g transform="${outer}"><image href="${uri}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="none"/></g></svg>`;
  return new Resvg(svg).render().pixels;
}

function comparePixels(actual, expected) {
  assert.equal(actual.length, expected.length);
  let intersection = 0, union = 0, alphaError = 0, unionPixels = 0, colorError = 0, colorChannels = 0;
  let actualAlpha = 0, expectedAlpha = 0, actualX = 0, actualY = 0, expectedX = 0, expectedY = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    const pixel = offset / 4, x = pixel % CANVAS.width, y = Math.floor(pixel / CANVAS.width);
    const a = actual[offset + 3], b = expected[offset + 3];
    actualAlpha += a; expectedAlpha += b;
    actualX += x * a; actualY += y * a;
    expectedX += x * b; expectedY += y * b;
    const insideA = a >= 128, insideB = b >= 128;
    if (insideA && insideB) intersection += 1;
    if (insideA || insideB) union += 1;
    if (a > 0 || b > 0) {
      alphaError += Math.abs(a - b);
      unionPixels += 1;
    }
    if (a >= 250 && b >= 250) {
      for (let channel = 0; channel < 3; channel += 1) {
        colorError += Math.abs(actual[offset + channel] - expected[offset + channel]);
        colorChannels += 1;
      }
    }
  }
  const actualCentroid = actualAlpha ? [actualX / actualAlpha, actualY / actualAlpha] : [0, 0];
  const expectedCentroid = expectedAlpha ? [expectedX / expectedAlpha, expectedY / expectedAlpha] : [0, 0];
  let paletteMismatches = 0;
  const paletteIndex = (offset) => {
    let best = 0, distance = Infinity;
    for (let index = 0; index < PALETTE.length; index += 1) {
      const color = PALETTE[index];
      const candidate = (actual[offset] - color[0]) ** 2 + (actual[offset + 1] - color[1]) ** 2 + (actual[offset + 2] - color[2]) ** 2;
      if (candidate < distance) { best = index; distance = candidate; }
    }
    return best;
  };
  const expectedPaletteIndex = (offset) => {
    let best = 0, distance = Infinity;
    for (let index = 0; index < PALETTE.length; index += 1) {
      const color = PALETTE[index];
      const candidate = (expected[offset] - color[0]) ** 2 + (expected[offset + 1] - color[1]) ** 2 + (expected[offset + 2] - color[2]) ** 2;
      if (candidate < distance) { best = index; distance = candidate; }
    }
    return best;
  };
  for (let offset = 0; offset < actual.length; offset += 4)
    if (actual[offset + 3] >= 250 && expected[offset + 3] >= 250 && paletteIndex(offset) !== expectedPaletteIndex(offset)) paletteMismatches += 1;
  return {
    iou: union ? intersection / union : 1,
    centroidError: Math.hypot(actualCentroid[0] - expectedCentroid[0], actualCentroid[1] - expectedCentroid[1]),
    coverageError: Math.abs(actualAlpha - expectedAlpha) / Math.max(1, actualAlpha, expectedAlpha),
    meanEdgeAlphaError: unionPixels ? alphaError / unionPixels : 0,
    meanInteriorRgbError: colorChannels ? colorError / colorChannels : 0,
    paletteMismatches,
  };
}

test("effectMapImage makes transformed filter images match regular SVG images", () => {
  const transforms = [
    ["90 degree rotation", [0, 1, -1, 0, 128, 8], true],
    ["mirror", [-1, 0, 0, 1, 112, 10], true],
    ["nonuniform scale plus rotation", [1.35, 0.78, -0.34, 0.59, 32.25, 12.35], false],
    ["shear", [1, 0.35, 0.55, 1, 24.25, 10.4], false],
  ];
  const results = [];

  for (const [index, [label, matrix, exact]] of transforms.entries()) {
    clearMapCache();
    let calls = 0;
    const pixelFn = (x, y, width, height) => {
      assert.deepEqual([width, height], [WIDTH, HEIGHT]);
      calls += 1;
      return paintPixel(x, y);
    };
    const key = `map-image-fixture-${index}`;
    const source = cachedMapImage(localKey(key), WIDTH, HEIGHT, pixelFn);
    const frame = { bounds: BOUNDS, helpers: { raster: true, transform: matrix } };
    const warpedUri = effectMapImage(frame, key, pixelFn);
    assert.equal(calls, WIDTH * HEIGHT, "the source PNG is generated once; the warped map samples cached source bytes");
    assert.equal(effectMapImage(frame, key, pixelFn), warpedUri, "repeated requests return the deterministic cached URI");
    assert.equal(calls, WIDTH * HEIGHT, "cached map requests do not repaint source pixels");
    const actual = renderFilterImage(warpedUri, matrix);
    const expected = renderRegularImage(source.uri, matrix);
    const metrics = comparePixels(actual, expected);
    results.push({ label, exact, ...metrics });
  }
  const failures = results.filter((metrics) =>
    (metrics.exact && (metrics.iou !== 1 || metrics.centroidError !== 0 || metrics.coverageError !== 0 ||
      metrics.meanEdgeAlphaError !== 0 || metrics.paletteMismatches !== 0 || metrics.meanInteriorRgbError > 1)) ||
    (!metrics.exact && (metrics.centroidError > 1 || metrics.iou < 0.94 ||
      metrics.coverageError > 0.05 || metrics.meanEdgeAlphaError > 18 || metrics.meanInteriorRgbError > 8)));
  assert.deepEqual(failures, [], `cardinal/mirror images must be pixel-exact and noncardinal transforms within bounded sampling error; all metrics=${JSON.stringify(results)}`);
});

test("identity and singular transforms reuse the local PNG without generating a warped PNG", () => {
  for (const [label, matrix] of [
    ["identity", [1, 0, 0, 1, 0, 0]],
    ["singular", [1, 0, 2, 0, 9, 12]],
  ]) {
    clearMapCache();
    let calls = 0;
    const pixelFn = (x, y, width, height) => {
      assert.deepEqual([width, height], [WIDTH, HEIGHT]);
      calls += 1;
      return paintPixel(x, y);
    };
    const key = `map-image-${label}`;
    const source = cachedMapImage(localKey(key), WIDTH, HEIGHT, pixelFn);
    const uri = effectMapImage({ bounds: BOUNDS, helpers: { raster: true, transform: matrix } }, key, pixelFn);
    assert.equal(uri, source.uri, `${label} transform should use the original cached PNG`);
    assert.equal(calls, WIDTH * HEIGHT, `${label} transform should not rasterize a second PNG`);
  }
});

test("effectMapImage allows bounded 512px export prewarps while source maps retain their 256px default", () => {
  clearMapCache();
  const frame = {
    bounds: BOUNDS,
    helpers: { raster: true, transform: [0, 8, -8, 0, 0, 0] },
  };
  const uri = effectMapImage(frame, "map-image-cap", paintPixel);
  const dimensions = readPngDimensions(uri);
  assert.deepEqual(dimensions, { width: 384, height: 512 });
  assert.ok(dimensions.width <= 512 && dimensions.height <= 512);
  const browserUri = effectMapImage({ bounds: { x: 0, y: 0, width: 3000, height: 1500 },
    helpers: { raster: false } }, "browser-map-cap", () => [128, 128, 128, 255]);
  assert.deepEqual(readPngDimensions(browserUri), { width: 256, height: 128 });
});

test("repeating prewarps clamp each cell before wrapping and still cover integer full-layer bounds", () => {
  clearMapCache();
  const bounds = { x: 0, y: 0, width: 16, height: 8 };
  const repeatBounds = { x: 0, y: 0, width: 4, height: 4 };
  const uri = effectMapImage({ bounds, helpers: { raster: true, transform: [2, 0, 0, 2, 0, 0] } },
    "repeating-cell-seams", (x, y, width, height) => {
      assert.deepEqual([width, height], [4, 4]);
      return [x * 80, y * 60, 0, 255];
    }, { repeatBounds });
  assert.deepEqual(readPngDimensions(uri), { width: 32, height: 16 });
  const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><image href="${uri}" width="32" height="16"/></svg>`).render().pixels;
  const red = (x) => pixels[(4 * 32 + x) * 4];
  assert.deepEqual([red(6), red(7), red(8), red(9)], [220, 240, 0, 20],
    "adjacent cells retain the discontinuity instead of blending their last and first texels");
});
