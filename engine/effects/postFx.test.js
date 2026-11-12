import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import {
  noiseTileSize,
  renderDithering,
  renderDotGrid,
  renderDuotone,
  renderLumaHighlight,
  renderNoiseMask,
  renderPixelate,
  renderRgbShift,
  renderThresholdColor,
  renderTritone,
} from "./postFx.js";
import { fractalNoise } from "./maps.js";
import { mosaicPlan, mosaicStates, renderMosaic } from "./mosaic.js";

test("mosaic shows flat cells with gaps that arrive in a seeded order and resolve to the picture", () => {
  const plan = mosaicPlan({ width: 300, height: 240, cell: 30, merges: 2, order: "clusters", angle: 0, seed: 4 });
  const shown = (p) => mosaicStates(plan, p).filter((state) => state !== "none" && state !== "dots").length;
  assert.equal(shown(0), 0);
  assert.ok(shown(0.2) < shown(0.4) && shown(0.6) === 80, `${shown(0.2)}, ${shown(0.4)}, ${shown(0.6)} of 80 cells`);
  assert.ok(mosaicStates(plan, 1).every((state) => state === "clean"));
  assert.deepEqual(mosaicPlan({ width: 300, height: 240, cell: 30, merges: 2, order: "clusters", angle: 0, seed: 4 }), plan);
  // Half red, half blue: a cell is one flat color, its gap is empty, and progress 1 is the layer as it was.
  const source = '<rect width="32" height="48" fill="#FF0000"/><rect x="32" width="32" height="48" fill="#0000FF"/>';
  const data = pixels(renderMosaic, { progress: 0.6, cell: 16, gap: 4, radius: 0, merges: 0, dots: 0 }, { source, raster: true });
  assertColorNear(pixelAt(data, WIDTH, 4, 4), [255, 0, 0], 40, "red cell");
  assertColorNear(pixelAt(data, WIDTH, 13, 13), pixelAt(data, WIDTH, 4, 4), 2, "same cell, same color");
  assert.equal(pixelAt(data, WIDTH, 1, 1)[3], 0, "the gap shows what is behind");
  assert.equal(makeFrame(renderMosaic, { progress: 1 }, { source }).output, source);
});

const WIDTH = 64;
const HEIGHT = 48;
const bounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
const opaqueRamp = [
  '<defs><linearGradient id="grayRamp"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs>',
  '<rect width="64" height="48" fill="url(#grayRamp)"/>',
].join("");
const transparentCircle = '<circle cx="32" cy="24" r="17" fill="#D83A66" fill-opacity="0.55"/>';
const mixedSource = `${opaqueRamp}${transparentCircle}`;
const BAYER8 = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21],
];

function makeFrame(render, parameters = {}, options = {}) {
  const frameBounds = options.bounds ?? bounds;
  const source = options.source ?? mixedSource;
  const defs = [];
  let sequence = 0;
  const frame = {
    content: source,
    bounds: frameBounds,
    paintBounds: options.paintBounds,
    parameters,
    time: options.time ?? 0,
    progress: options.progress ?? 0.5,
    helpers: {
      id: (kind) => `${options.prefix ?? "postfx"}-${kind}-${++sequence}`,
      defs,
      raster: options.raster ?? false,
      transform: options.transform,
    },
  };
  const output = render(frame);
  const width = options.canvasWidth ?? frameBounds.width;
  const height = options.canvasHeight ?? frameBounds.height;
  const x = options.canvasX ?? 0;
  const y = options.canvasY ?? 0;
  const paintedOutput = Array.isArray(options.outerTransform)
    ? `<g transform="matrix(${options.outerTransform.join(" ")})">${output}</g>`
    : output;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}"><defs>${defs.join("")}</defs>${paintedOutput}</svg>`;
  return { frame, output, defs, svg };
}

function pixels(render, parameters = {}, options = {}) {
  return new Resvg(makeFrame(render, parameters, options).svg).render().pixels;
}

function pixelAt(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

function changedPixelCount(left, right, threshold = 2) {
  assert.equal(left.length, right.length);
  let changed = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    if ([0, 1, 2, 3].some((channel) => Math.abs(left[offset + channel] - right[offset + channel]) > threshold)) changed += 1;
  }
  return changed;
}

function assertAlphaEqual(left, right, { tolerance = 1, message = "alpha coverage should be preserved" } = {}) {
  assert.equal(left.length, right.length);
  for (let offset = 3; offset < left.length; offset += 4)
    assert.ok(Math.abs(left[offset] - right[offset]) <= tolerance, `${message} at pixel ${Math.floor(offset / 4)}: ${left[offset]} vs ${right[offset]}`);
}

function assertColorNear(actual, expected, tolerance = 3, label = "pixel color") {
  for (let channel = 0; channel < 3; channel += 1)
    assert.ok(Math.abs(actual[channel] - expected[channel]) <= tolerance,
      `${label}, channel ${channel}: expected ${expected[channel]} ± ${tolerance}, got ${actual[channel]}`);
}

test("duotone and tritone map real luminance endpoints while keeping source alpha", () => {
  const ramp = '<rect x="0" y="0" width="21" height="48" fill="#000000"/><rect x="21" y="0" width="22" height="48" fill="#808080"/><rect x="43" y="0" width="21" height="48" fill="#FFFFFF"/>';
  const duo = pixels(renderDuotone, {
    midpoint: 0.5, contrast: 1, shadowColor: "#1400FF", highlightColor: "#FFE4E4",
  }, { source: `${ramp}${transparentCircle}` });
  assertColorNear(pixelAt(duo, WIDTH, 10, 10), [20, 0, 255]);
  assertColorNear(pixelAt(duo, WIDTH, 54, 10), [255, 228, 228]);
  assertAlphaEqual(pixels((frame) => frame.content, {}, { source: `${ramp}${transparentCircle}` }), duo);

  const tri = pixels(renderTritone, {
    threshold1: 0.33, threshold2: 0.66, softness: 0, contrast: 1,
    shadowColor: "#1A1033", midtoneColor: "#E94F64", highlightColor: "#FFE9B0",
  }, { source: ramp });
  assertColorNear(pixelAt(tri, WIDTH, 10, 10), [26, 16, 51]);
  assertColorNear(pixelAt(tri, WIDTH, 32, 10), [233, 79, 100]);
  assertColorNear(pixelAt(tri, WIDTH, 54, 10), [255, 233, 176]);
  const antialiased = pixels((frame) => frame.content, {}, { source: transparentCircle });
  const gradedAntialiased = pixels(renderDuotone, { shadowColor: "#1400FF", highlightColor: "#FFE4E4" }, { source: transparentCircle });
  assertAlphaEqual(antialiased, gradedAntialiased);
});

test("ordered dithering creates Bayer cells and preserves transparent and antialiased coverage", () => {
  const source = '<rect x="8" y="6" width="48" height="36" fill="#777777"/>';
  const baseline = pixels((frame) => frame.content, {}, { source });
  const params = { darkColor: "#000", lightColor: "#fff", subdivisions: 8, contrast: 1.2 };
  const rendered = makeFrame(renderDithering, params, { source });
  const result = new Resvg(rendered.svg).render().pixels;
  assertAlphaEqual(baseline, result);
  let whiteCells = 0;
  for (let cellY = 1; cellY <= 4; cellY += 1) for (let cellX = 1; cellX <= 6; cellX += 1) {
    const rank = BAYER8[cellY % 8][cellX % 8];
    const expectedLight = 0.5 + (119 / 255 - 0.5) * 1.2 > (rank + 0.5) / 64;
    const actual = pixelAt(result, WIDTH, cellX * 8 + 4, cellY * 8 + 4)[0] > 127;
    assert.equal(actual, expectedLight, `Bayer rank ${rank} at cell ${cellX},${cellY}`);
    whiteCells += Number(actual);
  }
  assert.ok(whiteCells >= 8 && whiteCells <= 16, `ordered pattern should produce a balanced mid-gray density, got ${whiteCells}/24`);
  const flat = pixels((frame) => frame.content, {}, { source: '<rect width="64" height="48" fill="#777777"/>' });
  const dithered = pixels(renderDithering, params, { source: '<rect width="64" height="48" fill="#777777"/>' });
  const states = new Set();
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) states.add(pixelAt(dithered, WIDTH, x, y)[0]);
  assert.ok(states.has(0) && states.has(255), "both dither colors appear on mid-gray input");
  assert.ok(changedPixelCount(flat, dithered) > 200, "the pattern changes visible output pixels");
});

test("dot grid uses luma-dependent circular coverage and preserves source edge alpha", () => {
  const base = pixels((frame) => frame.content, {}, { source: transparentCircle });
  const params = { gridRepetition: 7, dotScale: 6, contrast: 1.4, shadowColor: "#133355", highlightColor: "#FFE0A0" };
  const dots = pixels(renderDotGrid, params, { source: transparentCircle });
  assert.ok(changedPixelCount(base, dots) > 80, "halftone dots visibly alter the circle");
  for (let offset = 3; offset < dots.length; offset += 4)
    assert.ok(dots[offset] <= base[offset] + 1, `dot mask must not invent edge coverage at pixel ${Math.floor(offset / 4)}`);
  const noDots = pixels(renderDotGrid, { ...params, dotScale: 0 }, { source: transparentCircle });
  assert.ok(noDots.every((value) => value === 0), "zero dot scale is transparent");
  assert.ok(changedPixelCount(dots, pixels(renderDotGrid, { ...params, invertDetection: true }, { source: transparentCircle })) > 40,
    "inverting detection changes the halftone area");
});

test("luma highlight and threshold color preserve exact alpha and respond to threshold controls", () => {
  const baseline = pixels((frame) => frame.content);
  const highlight = pixels(renderLumaHighlight, { lumaThreshold: 0.15, fuzzWidth: 0.1, fuzzIntensity: 0.9 });
  assertAlphaEqual(baseline, highlight);
  const broadHighlight = pixels(renderLumaHighlight, { lumaThreshold: 0.85, fuzzWidth: 0.1, fuzzIntensity: 0.9 });
  assert.ok(changedPixelCount(highlight, broadHighlight) > 100, "moving the luma threshold changes the highlighted region");
  assert.deepEqual(pixels(renderLumaHighlight, { fuzzIntensity: 0 }), baseline, "zero intensity is an exact identity");
  assertAlphaEqual(pixels((frame) => frame.content, {}, { source: transparentCircle }),
    pixels(renderLumaHighlight, { lumaThreshold: 0.5, fuzzWidth: 0.2, fuzzIntensity: 0.7 }, { source: transparentCircle }));

  const threshold = pixels(renderThresholdColor, {
    contrast: 1.25, defaultColor: "#6f6645", colorThreshold: 0.5, softness: 0, invertLuma: true,
  });
  assertAlphaEqual(baseline, threshold);
  assertColorNear(pixelAt(threshold, WIDTH, 4, 24), [111, 102, 69]);
  assert.ok(changedPixelCount(baseline, threshold) > 500);
  assertAlphaEqual(pixels((frame) => frame.content, {}, { source: transparentCircle }),
    pixels(renderThresholdColor, { colorThreshold: 0.5, defaultColor: "#6F6645" }, { source: transparentCircle }));
});

test("noise mask is deterministic, follows its threshold, and does not expand source alpha", () => {
  const noiseOptions = { source: transparentCircle };
  const source = pixels((frame) => frame.content, {}, noiseOptions);
  const low = makeFrame(renderNoiseMask, { threshold: 0, scale: 0.55, seed: 17, octaves: 4, edgeSoftness: 0.06 }, noiseOptions);
  const lowPixels = new Resvg(low.svg).render().pixels;
  const repeated = makeFrame(renderNoiseMask, { threshold: 0, scale: 0.55, seed: 17, octaves: 4, edgeSoftness: 0.06 }, noiseOptions);
  assert.deepEqual(lowPixels, new Resvg(repeated.svg).render().pixels);
  const high = pixels(renderNoiseMask, { threshold: 0.9, scale: 0.55, seed: 17, octaves: 4, edgeSoftness: 0.06 }, noiseOptions);
  assert.ok(changedPixelCount(lowPixels, high) > 250);
  for (let offset = 3; offset < high.length; offset += 4)
    assert.ok(high[offset] <= source[offset] + 1, `noise mask only removes coverage at pixel ${Math.floor(offset / 4)}`);
  const seedA = low.defs.join("").match(/href="(data:image\/png;base64,[^"]+)/)?.[1];
  const thresholdChanged = makeFrame(renderNoiseMask, { threshold: 0.25, scale: 0.55, seed: 17, octaves: 4, edgeSoftness: 0.06 }, noiseOptions);
  const seedB = thresholdChanged.defs.join("").match(/href="(data:image\/png;base64,[^"]+)/)?.[1];
  assert.equal(seedA, seedB, "threshold animation reuses the static fractal field");
  const otherSeed = makeFrame(renderNoiseMask, { threshold: 0, scale: 0.55, seed: 18, octaves: 4, edgeSoftness: 0.06 }, noiseOptions);
  assert.notEqual(seedA, otherSeed.defs.join("").match(/href="(data:image\/png;base64,[^"]+)/)?.[1]);
});

// Average length of the runs of kept (red > 127) pixels and removed pixels along rows and down
// columns: about the size of one noise cell in each direction.
function meanRuns(data, width, height) {
  const kept = (x, y) => data[(y * width + x) * 4] > 127;
  const average = (lines, length, at) => {
    let total = 0, runs = 0;
    for (let line = 0; line < lines; line += 1) {
      let run = 1;
      for (let step = 1; step < length; step += 1) {
        if (kept(...at(line, step)) === kept(...at(line, step - 1))) run += 1;
        else { total += run; runs += 1; run = 1; }
      }
    }
    return total / runs;
  };
  return { across: average(height, width, (y, x) => [x, y]), down: average(width, height, (x, y) => [x, y]) };
}

test("noise mask Cell Size makes square cells that many pixels wide on a tall layer", () => {
  const width = 108, height = 384;
  const options = { bounds: { x: 0, y: 0, width, height }, source: `<rect width="${width}" height="${height}" fill="#FFFFFF"/>` };
  const grain = { threshold: 0.5, seed: 4, octaves: 1, edgeSoftness: 0 };
  // Scale's cells follow the layer, so on this tall layer they come out about twice as tall as wide.
  const stretched = meanRuns(pixels(renderNoiseMask, { ...grain, scale: 16 }, options), width, height);
  assert.ok(stretched.down > stretched.across * 1.6, `Scale cells stretch: ${JSON.stringify(stretched)}`);
  for (const [cellSize, low, high] of [[1, 1.6, 2.6], [4, 5.5, 11]]) {
    // `scale` is ignored once Cell Size is set.
    const runs = meanRuns(pixels(renderNoiseMask, { ...grain, scale: 16, cellSize }, options), width, height);
    for (const direction of ["across", "down"])
      assert.ok(runs[direction] >= low && runs[direction] <= high, `${cellSize} px cells, ${direction}: ${JSON.stringify(runs)}`);
    assert.ok(runs.down / runs.across > 0.75 && runs.down / runs.across < 1.33, `${cellSize} px cells are square: ${JSON.stringify(runs)}`);
  }
});

test("noise mask 1 px cells are exact noise values and the tile repeats without a seam", () => {
  // Wider than the 512 px tile and away from the origin: the pattern starts at the layer's corner.
  const width = 600, height = 24, left = 20, top = 8;
  const seed = 9;
  const data = pixels(renderNoiseMask, { threshold: 0.5, seed, octaves: 1, edgeSoftness: 0, cellSize: 1 }, {
    bounds: { x: left, y: top, width, height }, canvasX: left, canvasY: top,
    source: `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#FFFFFF"/>`,
  });
  let checked = 0, wrong = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const byte = Math.round((fractalNoise(x % 512, y % 512, 1, seed, 512) + 1) / 2 * 255);
    if (Math.abs(byte - 127.5) < 3) continue; // too close to the threshold to call
    checked += 1;
    if ((data[(y * width + x) * 4] > 127) !== (byte >= 128)) wrong += 1;
  }
  assert.ok(checked > 10_000);
  assert.equal(wrong, 0, `${wrong} of ${checked} pixels differ from the noise field`);
});

test("noise mask Cell Size grain does not repeat across a 1080×1920 layer", () => {
  const width = 1080, height = 1920;
  const tall = { x: 0, y: 0, width, height };
  // The tile grows to cover the layer. Below 8 px it stops at 256 cells (512 for 1 px), and
  // 1-2 px cells keep one map pixel per layer pixel.
  assert.deepEqual(noiseTileSize(1, tall), { cells: 512, mapSide: 512, side: 512 });
  assert.deepEqual(noiseTileSize(2, tall), { cells: 256, mapSide: 512, side: 512 });
  assert.deepEqual(noiseTileSize(4, tall), { cells: 256, mapSide: 512, side: 1024 });
  assert.deepEqual(noiseTileSize(8, tall), { cells: 256, mapSide: 512, side: 2048 });
  assert.deepEqual(noiseTileSize(16, tall), { cells: 128, mapSide: 512, side: 2048 });
  assert.deepEqual(noiseTileSize(64, tall), { cells: 32, mapSide: 512, side: 2048 });
  assert.deepEqual(noiseTileSize(2, { width: 64, height: 48 }), { cells: 32, mapSide: 64, side: 64 }, "a small layer gets a small map");
  for (const [cellSize, shifts] of [[4, [256, 512]], [16, [256, 512, 1024]], [64, [256, 512, 1024]]]) {
    const data = pixels(renderNoiseMask, { threshold: 0.5, seed: 2, cellSize }, {
      bounds: tall, source: `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    });
    const kept = (x, y) => data[(y * width + x) * 4] > 127;
    // Share of pixels that match the pixel (dx, dy) away: about 0.5 for unrelated grain, 1 for a repeat.
    const matching = (dx, dy) => {
      let same = 0, total = 0;
      for (let y = 0; y + dy < height; y += 2) for (let x = 0; x + dx < width; x += 2) {
        total += 1;
        if (kept(x, y) === kept(x + dx, y + dy)) same += 1;
      }
      return same / total;
    };
    for (const shift of shifts) for (const [dx, dy] of [[shift, 0], [0, shift]]) {
      const share = matching(dx, dy);
      assert.ok(share < 0.7, `${cellSize} px cells repeat ${dx || dy} px ${dx ? "across" : "down"}: ${share.toFixed(3)} of pixels match`);
    }
  }
});

test("noise mask Cell Size keeps one small tile for threshold changes and stays fine when rotated", () => {
  const tileOf = (parameters) => makeFrame(renderNoiseMask, parameters).defs.join("").match(/href="(data:image\/png;base64,[^"]+)/)?.[1];
  const tile = tileOf({ threshold: 0.2, seed: 5, cellSize: 2 });
  assert.ok(tile);
  assert.equal(tileOf({ threshold: 0.7, seed: 5, cellSize: 2 }), tile, "threshold animation reuses the tile");
  assert.notEqual(tileOf({ threshold: 0.2, seed: 6, cellSize: 2 }), tile);
  assert.notEqual(tileOf({ threshold: 0.2, seed: 5, cellSize: 3 }), tile);
  const width = 160, height = 160;
  const rotated = pixels(renderNoiseMask, { threshold: 0.5, seed: 5, octaves: 1, edgeSoftness: 0, cellSize: 3 }, {
    bounds: { x: 0, y: 0, width, height }, source: `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    raster: true, transform: [0.866, 0.5, -0.5, 0.866, 80, -40], outerTransform: [0.866, 0.5, -0.5, 0.866, 80, -40],
  });
  // Measure inside the rotated layer only, where every pixel is grain.
  const inner = new Uint8Array(60 * 60 * 4);
  for (let y = 0; y < 60; y += 1) inner.set(rotated.subarray(((y + 50) * width + 50) * 4, ((y + 50) * width + 110) * 4), y * 60 * 4);
  const runs = meanRuns(inner, 60, 60);
  for (const direction of ["across", "down"])
    assert.ok(runs[direction] >= 3 && runs[direction] <= 9, `3 px cells stay small when rotated: ${JSON.stringify(runs)}`);
});

test("noise mask without Cell Size draws exactly what it drew before Cell Size existed", () => {
  // sha256 of the effect's markup and definitions, taken from the renderer at commit ea4bd3e,
  // before Cell Size existed. A saved document with Noise Mask must keep rendering this.
  const markup = (parameters, options) => {
    const { output, defs } = makeFrame(renderNoiseMask, parameters, { source: transparentCircle, ...options });
    return output + defs.join("");
  };
  const sha256 = (text) => createHash("sha256").update(text).digest("hex");
  const saved = { threshold: 0.42, scale: 0.8, seed: 71, octaves: 5, edgeSoftness: 0.08 };
  const tall = { bounds: { x: 0, y: 0, width: 1080, height: 1920 } };
  assert.equal(sha256(markup(saved)), "24794ae2aa80145c6b70f996e717e8a200c484f980c91c76303919b9f75658b3");
  assert.equal(sha256(markup({ threshold: 0.42, scale: 16, seed: 3, octaves: 1, edgeSoftness: 0 }, tall)),
    "0b43427a9b21476336dd16ddf36cb307c8db0fd5e3bd314eded86527b0aef002");
  assert.equal(sha256(markup(saved, { raster: true })), "373ba337b37f02c51ffc2ee2b020c7a9303def5918548f3a8f52a7ef9a6f4322");
  assert.equal(markup({ ...saved, cellSize: 0 }), markup(saved), "Cell Size 0 is the old behavior");
});

test("pixelate snaps fractional size to step and keeps true mosaic cells on a large layer", () => {
  const width = 640, height = 96;
  const bands = Array.from({ length: 40 }, (_, index) => {
    const x = index * 16;
    const center = index % 2 ? "#E8B41B" : "#18B84A";
    return [
      `<rect x="${x}" y="0" width="4" height="96" fill="#E32733"/>`,
      `<rect x="${x + 4}" y="0" width="8" height="96" fill="${center}"/>`,
      `<rect x="${x + 12}" y="0" width="4" height="96" fill="#1555D0"/>`,
    ].join("");
  }).join("");
  const source = pixels((frame) => frame.content, {}, { source: bands, bounds: { x: 0, y: 0, width, height }, canvasWidth: width, canvasHeight: height, raster: true });
  const params = { pixelSize: 17, pixelSizeStep: 4, noiseScale: 1, noiseThreshold: 0.5, noiseEnabled: false };
  const result = pixels(renderPixelate, params, { source: bands, bounds: { x: 0, y: 0, width, height }, canvasWidth: width, canvasHeight: height, raster: true });
  assert.ok(changedPixelCount(source, result) > 2_000);
  assert.deepEqual(pixelAt(result, width, 2, 40).slice(0, 3), [24, 184, 74], "the first cell samples its green center patch");
  assert.deepEqual(pixelAt(result, width, 14, 40).slice(0, 3), [24, 184, 74], "the blue edge pixels snap to the first cell center");
  assert.deepEqual(pixelAt(result, width, 18, 40).slice(0, 3), [232, 180, 27], "the next cell samples its yellow center patch");
  assert.deepEqual(pixelAt(result, width, 30, 40).slice(0, 3), [232, 180, 27], "the second cell remains one constant mosaic block");
  const gated = pixels(renderPixelate, { ...params, noiseEnabled: true, noiseThreshold: 1 }, {
    source: bands, bounds: { x: 0, y: 0, width, height }, canvasWidth: width, canvasHeight: height, raster: true,
  });
  assert.ok(changedPixelCount(result, gated) > 500, "noise gating leaves some cells sharp");
});

test("pixelate carries alpha X and neutral gray Y in browser maps, with native opaque RG maps", () => {
  const mapWidth = 16, mapHeight = 16;
  const source = '<rect width="64" height="48" fill="#E32733"/>';
  const options = { source, raster: false };
  const browser = makeFrame(renderPixelate, { pixelSize: 16 }, options);
  assert.match(browser.defs.join(""), /xChannelSelector="A" yChannelSelector="R"/);
  const uriPattern = /<feImage href="(data:image\/png;base64,[^"]+)"[^>]*result="postFxPixelCell"/;
  const browserUri = browser.defs.join("").match(uriPattern)?.[1];
  assert.ok(browserUri, "the tiled browser map is an embedded PNG");

  const compositeMap = (background) => new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mapWidth}" height="${mapHeight}"><rect width="100%" height="100%" fill="${background}"/><image href="${browserUri}" width="${mapWidth}" height="${mapHeight}" preserveAspectRatio="none"/></svg>`,
  ).render().pixels;
  const black = pixelAt(compositeMap("#000"), mapWidth, 0, 4);
  const white = pixelAt(compositeMap("#fff"), mapWidth, 0, 4);
  const inferredAlpha = 1 - (white[0] - black[0]) / 255;
  const inferredGray = black[0] / inferredAlpha;
  assert.ok(Math.abs(inferredAlpha * 255 - 188) <= 4, `browser alpha carries encoded X displacement, got ${inferredAlpha * 255}`);
  assert.ok(Math.abs(inferredGray - 158) <= 5, `browser neutral grayscale carries encoded Y displacement, got ${inferredGray}`);
  assert.ok(Math.abs(black[0] - black[1]) <= 1 && Math.abs(black[1] - black[2]) <= 1,
    "browser Y channels remain equal to avoid color-dependent displacement skew");

  const native = makeFrame(renderPixelate, { pixelSize: 16 }, { source, raster: true });
  assert.match(native.defs.join(""), /xChannelSelector="R" yChannelSelector="G"/);
  const nativeUri = native.defs.join("").match(uriPattern)?.[1];
  assert.ok(nativeUri, "the native map uses a separate opaque PNG encoding");
  const nativeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${mapWidth}" height="${mapHeight}"><image href="${nativeUri}" width="${mapWidth}" height="${mapHeight}" preserveAspectRatio="none"/></svg>`;
  const nativeMap = new Resvg(nativeSvg).render().pixels;
  assertColorNear(pixelAt(nativeMap, mapWidth, 0, 4), [188, 158, 128], 3);
  assert.equal(pixelAt(nativeMap, mapWidth, 0, 4)[3], 255, "native map stays opaque for the raster sampler");
  assert.match(native.defs.join(""), /<feDisplacementMap[^>]*scale="32"/,
    "the half-range encoding restores the displacement scale");
  assert.match(native.defs.join(""), /<filter\b[^>]*x="-9" y="-9" width="82" height="66"/,
    "the filter keeps neutral padding around maximum cell shifts");
});

test("pixelate keeps full mosaic cells through a rotated nonuniform native prewarp", () => {
  const palette = ["#e4365a", "#ffd447", "#2054bf"];
  const tiles = ['<rect width="64" height="48" fill="#101010"/>'];
  for (let row = 0; row < 6; row += 1) for (let column = 0; column < 8; column += 1) {
    const fill = palette[(column + row * 2) % palette.length];
    tiles.push(`<rect x="${column * 8 + 2}" y="${row * 8 + 2}" width="4" height="4" fill="${fill}"/>`);
  }
  const matrix = [1.1, 0.18, -0.14, 0.9, 28, 15];
  const options = {
    source: tiles.join(""), bounds: { x: 0, y: 0, width: 64, height: 48 },
    canvasWidth: 128, canvasHeight: 96, raster: true, transform: matrix, outerTransform: matrix,
  };
  const rendered = makeFrame(renderPixelate, { pixelSize: 8 }, options);
  assert.doesNotMatch(rendered.defs.join(""), /<feTile\b/,
    "a prewarped periodic map covers the full local layer before sampling");
  const output = new Resvg(rendered.svg).render().pixels;
  const colorBytes = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const transformPoint = (x, y) => [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];

  for (let row = 0; row < 6; row += 1) for (let column = 0; column < 8; column += 1) {
    const expected = colorBytes(palette[(column + row * 2) % palette.length]);
    for (const [offsetX, offsetY] of [[1.5, 1.5], [6.5, 1.5], [1.5, 6.5], [6.5, 6.5]]) {
      const [screenX, screenY] = transformPoint(column * 8 + offsetX, row * 8 + offsetY);
      assertColorNear(pixelAt(output, 128, Math.floor(screenX), Math.floor(screenY)), expected, 8,
        `cell ${column},${row} at local ${offsetX},${offsetY} / screen ${screenX.toFixed(2)},${screenY.toFixed(2)}`);
    }
  }
});

test("pixelate repeats source alpha as block coverage and retains affine correction metadata", () => {
  const alphaSource = '<rect x="8" y="8" width="24" height="24" fill="#F0476A" fill-opacity="0.5"/>';
  const options = { source: alphaSource, bounds: { x: 0, y: 0, width: 40, height: 40 }, raster: true };
  const baseline = pixels((frame) => frame.content, {}, options);
  const mosaic = pixels(renderPixelate, { pixelSize: 8 }, options);
  for (let y = 8; y < 16; y += 1) for (let x = 8; x < 16; x += 1)
    assert.ok(Math.abs(pixelAt(mosaic, 40, x, y)[3] - 128) <= 1, `cell repeats source alpha at ${x},${y}`);
  assert.equal(pixelAt(mosaic, 40, 4, 12)[3], 0, "transparent cells remain transparent");
  assertAlphaEqual(baseline, pixels(renderPixelate, { pixelSize: 1 }, options));

  const rotated = makeFrame(renderPixelate, { pixelSize: 8 }, {
    raster: true, transform: [0, 1, -1, 0, 48, 0],
  });
  assert.match(rotated.defs.join(""), /postFxPixelTransformedMap/,
    "native pixelate retains the resvg affine vector correction");
  assert.match(rotated.defs.join(""), /xChannelSelector="R" yChannelSelector="G"/);
});

test("RGB Shift adds visible channel fringes, respects overflow clipping, and preserves zero amount", () => {
  const source = '<circle cx="60" cy="24" r="10" fill="#F00" fill-opacity="0.6"/>';
  const options = { source, bounds, canvasWidth: 88, canvasHeight: HEIGHT };
  const baseline = pixels((frame) => frame.content, {}, options);
  const overflowOff = makeFrame(renderRgbShift, { amount: 1, direction: 0, overflow: false }, options);
  const offPixels = new Resvg(overflowOff.svg).render().pixels;
  const overflowOn = pixels(renderRgbShift, { amount: 1, direction: 0, overflow: true }, options);
  assert.ok(pixelAt(overflowOn, 88, 67, 24)[3] > 0, "shifted channel alpha is retained outside the source silhouette");
  assert.equal(pixelAt(offPixels, 88, 67, 24)[3], 0, "Overflow off clips at the 64px layer box");
  assert.ok(changedPixelCount(baseline, overflowOn) > 100);
  assert.deepEqual(pixels(renderRgbShift, { amount: 0, direction: 270, overflow: true }, options), baseline,
    "zero amount returns the exact source pixels");

  const onePixelSource = '<rect x="3" y="3" width="1" height="1" fill="#F00" fill-opacity="0.5"/>';
  const onePixel = pixels(renderRgbShift, { amount: 1, direction: 0, overflow: true }, {
    source: onePixelSource,
    bounds: { x: 0, y: 0, width: 8, height: 8 },
    canvasWidth: 16,
    canvasHeight: 12,
  });
  const maxAlpha = Math.max(...Array.from({ length: onePixel.length / 4 }, (_, index) => onePixel[index * 4 + 3]));
  assert.ok(maxAlpha >= 120 && maxAlpha <= 136, `single-pixel channel assembly should retain 0.5 coverage, got ${maxAlpha}`);

  const rotated = makeFrame(renderRgbShift, { amount: 0.5, direction: 0 }, {
    raster: true, transform: [0, 1, -1, 0, 48, 0],
  });
  const offsets = rotated.defs.join("").match(/<feOffset\b[^>]*dx="([^"]+)" dy="([^"]+)"/g) ?? [];
  assert.equal(offsets.length, 2);
  assert.match(offsets[0], /dx="0" dy="2\.4"/);
  assert.match(offsets[1], /dx="0" dy="-2\.4"/);
});

test("all Post FX filters produce stable definitions and use safe embedded maps", () => {
  const cases = [
    [renderDithering, { subdivisions: 8 }],
    [renderDotGrid, { gridRepetition: 8 }],
    [renderDuotone, {}],
    [renderLumaHighlight, { lumaThreshold: 0.6 }],
    [renderNoiseMask, { threshold: 0.5 }],
    [renderNoiseMask, { threshold: 0.5, cellSize: 2 }],
    [renderPixelate, { pixelSize: 8 }],
    [renderThresholdColor, {}],
    [renderTritone, {}],
    [renderRgbShift, { amount: 0.2 }],
  ];
  const allIds = [];
  for (const [index, [render, parameters]] of cases.entries()) {
    const first = makeFrame(render, parameters, { prefix: `fx-${index}` });
    const second = makeFrame(render, parameters, { prefix: `fx-${index}` });
    assert.equal(first.output, second.output);
    assert.deepEqual(first.defs, second.defs);
    const raster = new Resvg(first.svg).render().pixels;
    assert.deepEqual(raster, new Resvg(second.svg).render().pixels);
    for (const definition of first.defs) {
      const id = definition.match(/\bid="([^"]+)"/)?.[1];
      assert.ok(id);
      allIds.push(id);
      if (definition.startsWith("<filter ")) assert.match(definition, /color-interpolation-filters="sRGB"/);
      assert.doesNotMatch(definition, /href="#|href="url\(#/);
      for (const match of definition.matchAll(/<feImage\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g))
        assert.ok(Number(match[1]) <= 512 && Number(match[2]) <= 512, "embedded maps stay bounded");
    }
  }
  assert.equal(new Set(allIds).size, allIds.length);
});
