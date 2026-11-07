import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { renderBulge } from "./bulge.js";
import { renderDisplacement } from "./displacement.js";
import { renderFluidWarp } from "./fluidWarp.js";
import { renderFlutedGlass } from "./flutedGlass.js";
import { renderNoiseWarp } from "./noiseWarp.js";
import { renderRipple } from "./ripple.js";
import { renderVectorDisplacement } from "./periodicDisplacement.js";

const WIDTH = 72;
const HEIGHT = 56;
const bounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
const source = [
  '<rect width="72" height="56" fill="#15171b"/>',
  ...Array.from({ length: 12 }, (_, index) => {
    const x = index * 6;
    const color = ["#ef476f", "#ffd166", "#06d6a0", "#118ab2"][index % 4];
    return `<rect x="${x}" y="0" width="3" height="56" fill="${color}"/>`;
  }),
  '<circle cx="19" cy="17" r="11" fill="#f8f9fa"/>',
  '<path d="M4 45L27 28L44 50L67 31" fill="none" stroke="#8d99ae" stroke-width="3"/>',
  '<rect x="48" y="5" width="17" height="18" rx="2" fill="#6c63ff"/>',
].join("");

function makeFrame(render, parameters = {}, time = 0, {
  frameBounds = bounds,
  canvasWidth = WIDTH,
  canvasHeight = HEIGHT,
  prefix = "fx",
} = {}) {
  let sequence = 0;
  const defs = [];
  const frame = {
    content: source,
    bounds: frameBounds,
    parameters,
    time,
    progress: 0.5,
    helpers: { id: (kind) => `${prefix}-${kind}-${++sequence}`, defs,
      raster: true, transform: [1, 0, 0, 1, 0, 0] },
  };
  const output = render(frame);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { frame, output, defs, svg };
}

function pixels(render, parameters = {}, time = 0, options) {
  return new Resvg(makeFrame(render, parameters, time, options).svg).render().pixels;
}

function changedPixelCount(left, right, threshold = 2) {
  assert.equal(left.length, right.length);
  let count = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    if (Math.abs(left[offset] - right[offset]) > threshold ||
        Math.abs(left[offset + 1] - right[offset + 1]) > threshold ||
        Math.abs(left[offset + 2] - right[offset + 2]) > threshold ||
        Math.abs(left[offset + 3] - right[offset + 3]) > threshold) count += 1;
  }
  return count;
}

function assertPixelsChange(render, before, after, label, time = 0, options) {
  const difference = changedPixelCount(pixels(render, before, time, options), pixels(render, after, time, options));
  assert.ok(difference > 8, `${label} should visibly change resvg output; changed pixels=${difference}`);
}

test("six distortion renderers produce deterministic resvg pixels and unique SVG definitions", () => {
  const cases = [
    [renderBulge, { amount: 1 }],
    [renderDisplacement, { amplitude: 12, offset: 0.25, repeat: 1.5, direction: "both" }],
    [renderFluidWarp, { amount: 18, noiseScale: 1.4, octaves: 4, speed: 0.75, contain: false }],
    [renderFlutedGlass, { columns: 9, strength: 0.7, glowStrength: 0.2, glowWidth: 0.7 }],
    [renderNoiseWarp, { amount: 18, noiseScale: 1.3, speed: 0.65, contain: true }],
    [renderRipple, { speed: 0.7, strength: 0.2, frequency: 6, centerX: 0.43, centerY: 0.58, falloff: 1.4, sharpness: 5 }],
  ];
  const combinedDefs = [];
  const combinedMarkup = [];
  const ids = [];
  for (const [index, [render, parameters]] of cases.entries()) {
    const prefix = `effect-${index}`;
    const first = makeFrame(render, parameters, 0.37, { prefix });
    const second = makeFrame(render, parameters, 0.37, { prefix });
    assert.equal(first.output, second.output, "same inputs produce identical SVG markup");
    assert.deepEqual(first.defs, second.defs, "same inputs produce identical map and filter definitions");
    assert.deepEqual(new Resvg(first.svg).render().pixels, pixels(render, parameters, 0.37), "same frame produces identical pixels");
    combinedMarkup.push(first.output);
    for (const definition of first.defs) {
      const id = definition.match(/\bid="([^"]+)"/)?.[1];
      assert.ok(id, "each definition has an ID");
      ids.push(id);
      combinedDefs.push(definition);
    }
    if (first.defs.length) {
      assert.match(first.defs.join(""), /color-interpolation-filters="sRGB"/);
      assert.match(first.defs.join(""), /href="data:image\/png;base64,/);
      assert.doesNotMatch(first.defs.join(""), /href="#|href="url\(#/);
      for (const match of first.defs.join("").matchAll(/<feImage\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)) {
        assert.ok(Number(match[1]) <= 256 && Number(match[2]) <= 256, "embedded displacement maps stay within 256 px");
      }
    }
  }
  assert.equal(new Set(ids).size, ids.length, "shared helper IDs are unique across effect definitions");
  // Rendering the combined definitions in one SVG catches reference collisions
  // as well as syntactically valid individual filters.
  const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><defs>${combinedDefs.join("")}</defs>${combinedMarkup.join("")}</svg>`;
  assert.equal(new Resvg(combined).render().pixels.length, WIDTH * HEIGHT * 4);
});

test("time and phase changes alter SVG mix weights while reusing static PNG fields", () => {
  const uriList = (entry) => [...entry.defs.join("").matchAll(/<feImage\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]);
  const composites = (entry) => (entry.defs.join("").match(/<feComposite\b[^>]*operator="arithmetic"[^>]*>/g) ?? [])
    .filter((tag) => /result="displacement(?:Map|X|Y)Mix"/.test(tag));
  const dynamicCases = [
    [renderDisplacement, { amplitude: 12, offset: 0.1, repeat: 1.4, direction: "both" }, { ...{ amplitude: 12, repeat: 1.4, direction: "both" }, offset: 0.2 }, 0, 0],
    [renderFluidWarp, { amount: 18, noiseScale: 1.4, octaves: 4, speed: 0.8 }, { amount: 18, noiseScale: 1.4, octaves: 4, speed: 0.8 }, 0.11, 0.21],
    [renderNoiseWarp, { amount: 18, noiseScale: 1.4, speed: 0.8 }, { amount: 18, noiseScale: 1.4, speed: 0.8 }, 0.11, 0.21],
    [renderRipple, { speed: 0.6, strength: 0.2, frequency: 7, centerX: 0.4, centerY: 0.6, falloff: 1.3, sharpness: 5 },
      { speed: 0.6, strength: 0.2, frequency: 7, centerX: 0.4, centerY: 0.6, falloff: 1.3, sharpness: 5 }, 0.05, 0.1],
  ];
  for (const [index, [render, firstParams, secondParams, firstTime, secondTime]] of dynamicCases.entries()) {
    const first = makeFrame(render, firstParams, firstTime);
    const second = makeFrame(render, secondParams, secondTime);
    assert.deepEqual(uriList(first), uriList(second), "the same static field PNGs are reused while time or phase changes");
    if (index === 0) assert.notEqual(first.defs.join("").match(/<feDisplacementMap\b[^>]*scale="([^"]+)"/)?.[1],
      second.defs.join("").match(/<feDisplacementMap\b[^>]*scale="([^"]+)"/)?.[1], "offset changes the displacement scale when sine/cosine weights change");
    assert.notEqual(composites(first).join(""), composites(second).join(""), "convex SVG weights change without regenerating maps");
    for (const composite of [...composites(first), ...composites(second)]) {
      const weights = ["k2", "k3"].map((name) => Number(composite.match(new RegExp(`${name}="([^"]+)"`))?.[1]));
      assert.ok(weights.every((weight) => weight >= 0 && weight <= 1));
      assert.ok(Math.abs(weights[0] + weights[1] - 1) < 1e-9, "each numeric coordinate uses convex weights");
    }
  }
});

test("Bulge is neutral at zero and its signed radial strength changes real pixels", () => {
  const neutral = makeFrame(renderBulge, { amount: 0 });
  assert.equal(neutral.output, source);
  assert.equal(neutral.defs.length, 0);
  assertPixelsChange(renderBulge, { amount: 0.5 }, { amount: 1.5 }, "bulge amount");
  assertPixelsChange(renderBulge, { amount: 1 }, { amount: -1 }, "bulge direction");
});

test("Displacement respects amplitude, phase, repeat, and axis selection", () => {
  const neutral = makeFrame(renderDisplacement, { amplitude: 0 });
  assert.equal(neutral.output, source);
  assert.equal(neutral.defs.length, 0);
  assertPixelsChange(renderDisplacement, { amplitude: 12, offset: 0, repeat: 1, direction: "horizontal" },
    { amplitude: 12, offset: 0.25, repeat: 1, direction: "horizontal" }, "displacement offset");
  assertPixelsChange(renderDisplacement, { amplitude: 12, offset: 0.25, repeat: 1, direction: "horizontal" },
    { amplitude: 12, offset: 0.25, repeat: 2.5, direction: "horizontal" }, "displacement repeat");
  assertPixelsChange(renderDisplacement, { amplitude: 12, offset: 0.25, repeat: 1.5, direction: "horizontal" },
    { amplitude: 12, offset: 0.25, repeat: 1.5, direction: "vertical" }, "displacement direction");
  assertPixelsChange(renderDisplacement, { amplitude: 12, offset: 0.25, repeat: 1.5, direction: "horizontal" },
    { amplitude: -12, offset: 0.25, repeat: 1.5, direction: "horizontal" }, "signed displacement amplitude");
});

test("Fluid Warp uses a changing curl-noise field with deterministic controls and optional containment", () => {
  const neutral = makeFrame(renderFluidWarp, { amount: 0 });
  assert.equal(neutral.output, source);
  assertPixelsChange(renderFluidWarp, { amount: 18, noiseScale: 0.7, octaves: 2, speed: 0.6 },
    { amount: 18, noiseScale: 2.3, octaves: 2, speed: 0.6 }, "fluid noise scale");
  assertPixelsChange(renderFluidWarp, { amount: 18, noiseScale: 1.4, octaves: 1, speed: 0.6 },
    { amount: 18, noiseScale: 1.4, octaves: 6, speed: 0.6 }, "fluid octaves");
  assertPixelsChange(renderFluidWarp, { amount: 18, noiseScale: 1.4, octaves: 4, speed: 0 },
    { amount: 18, noiseScale: 1.4, octaves: 4, speed: 1.2 }, "fluid speed", 0.37);
  assertPixelsChange(renderFluidWarp, { amount: 18, noiseScale: 1.4, octaves: 4, speed: 0.8, contain: false },
    { amount: 18, noiseScale: 1.4, octaves: 4, speed: 0.8, contain: true }, "fluid contain", 0.37, {
      frameBounds: { x: 8, y: 8, width: 56, height: 40 }, canvasWidth: WIDTH, canvasHeight: HEIGHT,
    });
});

test("Fluted Glass controls its refraction frequency, strength, and soft highlight", () => {
  assertPixelsChange(renderFlutedGlass, { columns: 6, strength: 0.65, glowStrength: 0, glowWidth: 0.4 },
    { columns: 13, strength: 0.65, glowStrength: 0, glowWidth: 0.4 }, "fluted columns");
  assertPixelsChange(renderFlutedGlass, { columns: 10, strength: 0.15, glowStrength: 0, glowWidth: 0.4 },
    { columns: 10, strength: 0.9, glowStrength: 0, glowWidth: 0.4 }, "fluted strength");
  assertPixelsChange(renderFlutedGlass, { columns: 10, strength: 0.65, glowStrength: 0, glowWidth: 0.4 },
    { columns: 10, strength: 0.65, glowStrength: 0.7, glowWidth: 0.4 }, "fluted glow strength");
  assertPixelsChange(renderFlutedGlass, { columns: 10, strength: 0.65, glowStrength: 0.7, glowWidth: 0.1 },
    { columns: 10, strength: 0.65, glowStrength: 0.7, glowWidth: 1.5 }, "fluted glow width");
});

test("Noise Warp is neutral at zero, changes smoothly with noise controls, and contains output", () => {
  const neutral = makeFrame(renderNoiseWarp, { amount: 0 });
  assert.equal(neutral.output, source);
  assertPixelsChange(renderNoiseWarp, { amount: 20, noiseScale: 0.6, speed: 0.7, contain: true },
    { amount: 20, noiseScale: 2.4, speed: 0.7, contain: true }, "noise warp scale");
  assertPixelsChange(renderNoiseWarp, { amount: 20, noiseScale: 1.3, speed: 0, contain: true },
    { amount: 20, noiseScale: 1.3, speed: 1, contain: true }, "noise warp speed", 0.37);
  assertPixelsChange(renderNoiseWarp, { amount: 30, noiseScale: 1.3, speed: 0.8, contain: false },
    { amount: 30, noiseScale: 1.3, speed: 0.8, contain: true }, "noise warp contain", 0.37, {
      frameBounds: { x: 8, y: 8, width: 56, height: 40 }, canvasWidth: WIDTH, canvasHeight: HEIGHT,
    });
});

test("Ripple responds to its temporal, spatial, falloff, and sharpness controls", () => {
  const neutral = makeFrame(renderRipple, { strength: 0 });
  assert.equal(neutral.output, source);
  assertPixelsChange(renderRipple, { speed: 0, strength: 0.23, frequency: 6, centerX: 0.5, centerY: 0.5, falloff: 1.4, sharpness: 5 },
    { speed: 1, strength: 0.23, frequency: 6, centerX: 0.5, centerY: 0.5, falloff: 1.4, sharpness: 5 }, "ripple speed", 0.37);
  assertPixelsChange(renderRipple, { speed: 0.6, strength: 0.23, frequency: 4, centerX: 0.5, centerY: 0.5, falloff: 1.4, sharpness: 5 },
    { speed: 0.6, strength: 0.23, frequency: 12, centerX: 0.5, centerY: 0.5, falloff: 1.4, sharpness: 5 }, "ripple frequency", 0.21);
  assertPixelsChange(renderRipple, { speed: 0.6, strength: 0.23, frequency: 8, centerX: 0.5, centerY: 0.5, falloff: 1.4, sharpness: 5 },
    { speed: 0.6, strength: 0.23, frequency: 8, centerX: 0.28, centerY: 0.72, falloff: 1.4, sharpness: 5 }, "ripple center", 0.21);
  assertPixelsChange(renderRipple, { speed: 0.6, strength: 0.23, frequency: 8, centerX: 0.5, centerY: 0.5, falloff: 0, sharpness: 5 },
    { speed: 0.6, strength: 0.23, frequency: 8, centerX: 0.5, centerY: 0.5, falloff: 5, sharpness: 5 }, "ripple falloff", 0.21);
  assertPixelsChange(renderRipple, { speed: 0.6, strength: 0.23, frequency: 8, centerX: 0.5, centerY: 0.5, falloff: 1.4, sharpness: 1 },
    { speed: 0.6, strength: 0.23, frequency: 8, centerX: 0.5, centerY: 0.5, falloff: 1.4, sharpness: 12 }, "ripple sharpness", 0.21);
});

test("raster displacement follows its affine transform for rotation, scale, reflection, and shear", () => {
  const amount = 3;
  const localBounds = { x: 0, y: 0, width: 96, height: 72 };
  // A larger opaque patch keeps edge AA from dominating the affine sampling
  // check; the local displacement and each transform's linear part stay fixed.
  const shape = '<rect x="28" y="24" width="28" height="20" fill="#ef3340"/>';
  const transforms = [
    ["90 degree rotation", [0, 1, -1, 0, 170, 12]],
    ["nonuniform scale plus rotation", [1.35, 0.78, -0.34, 0.59, 35, 18]],
    ["horizontal reflection", [-1, 0, 0, 1, 165, 12]],
    ["shear", [1, 0.35, 0.55, 1, 28, 20]],
  ];
  const svgPixels = (defs, markup) => new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="192" viewBox="0 0 240 192"><defs>${defs.join("")}</defs>${markup}</svg>`,
  ).render().pixels;
  const affine = (matrix) => `matrix(${matrix.join(" ")})`;
  const maskOverlap = (left, right, cutoff = 128) => {
    let intersection = 0, union = 0, unionAlphaError = 0, unionCount = 0, coreColorError = 0, coreCount = 0;
    let leftAlphaTotal = 0, rightAlphaTotal = 0, leftX = 0, leftY = 0, rightX = 0, rightY = 0;
    const width = 240;
    for (let offset = 0; offset < left.length; offset += 4) {
      const pixel = offset / 4, x = pixel % width, y = Math.floor(pixel / width);
      const leftAlpha = left[offset + 3], rightAlpha = right[offset + 3];
      leftAlphaTotal += leftAlpha; rightAlphaTotal += rightAlpha;
      leftX += x * leftAlpha; leftY += y * leftAlpha;
      rightX += x * rightAlpha; rightY += y * rightAlpha;
      const leftInside = leftAlpha >= cutoff, rightInside = rightAlpha >= cutoff;
      if (leftInside && rightInside) intersection += 1;
      if (leftInside || rightInside) union += 1;
      if (leftAlpha > 0 || rightAlpha > 0) {
        unionAlphaError += Math.abs(leftAlpha - rightAlpha);
        unionCount += 1;
      }
      if (leftAlpha >= 250 && rightAlpha >= 250) {
        coreColorError += Math.abs(left[offset] - right[offset]) + Math.abs(left[offset + 1] - right[offset + 1]) + Math.abs(left[offset + 2] - right[offset + 2]);
        coreCount += 3;
      }
    }
    const leftCentroid = leftAlphaTotal ? [leftX / leftAlphaTotal, leftY / leftAlphaTotal] : [0, 0];
    const rightCentroid = rightAlphaTotal ? [rightX / rightAlphaTotal, rightY / rightAlphaTotal] : [0, 0];
    return {
      iou: union ? intersection / union : 1,
      meanUnionAlphaError: unionCount ? unionAlphaError / unionCount : 0,
      meanCoreColorError: coreCount ? coreColorError / coreCount : 0,
      centroidDelta: Math.hypot(leftCentroid[0] - rightCentroid[0], leftCentroid[1] - rightCentroid[1]),
      coverageRelativeError: Math.abs(leftAlphaTotal - rightAlphaTotal) / Math.max(1, leftAlphaTotal, rightAlphaTotal),
    };
  };

  const results = [];
  for (const [label, matrix] of transforms) {
    const defs = [];
    let sequence = 0;
    const frame = {
      content: shape,
      bounds: localBounds,
      parameters: {},
      time: 0,
      progress: 1,
      helpers: {
        id: (kind) => `affine-${label.replaceAll(" ", "-")}-${kind}-${++sequence}`,
        defs,
        raster: true,
        transform: matrix,
      },
    };
    const warped = renderVectorDisplacement(frame, `constant-x-${label}`, amount, () => ({ x: 1, y: 0 }));
    const transform = affine(matrix);
    const actual = svgPixels(defs, `<g transform="${transform}">${warped}</g>`);
    const expected = svgPixels([], `<g transform="${transform}"><g transform="translate(${-amount} 0)">${shape}</g></g>`);
    const metrics = maskOverlap(actual, expected);
    results.push({ label, exact: Buffer.from(actual).equals(Buffer.from(expected)), ...metrics });
  }
  const exactLabels = new Set(["90 degree rotation", "horizontal reflection"]);
  const failures = results.filter((metrics) =>
    (exactLabels.has(metrics.label) && !metrics.exact) ||
    (!exactLabels.has(metrics.label) && (metrics.centroidDelta > 1 || metrics.iou < 0.94 ||
      metrics.coverageRelativeError > 0.05 || metrics.meanUnionAlphaError > 16)) ||
    metrics.meanCoreColorError > 1);
  assert.deepEqual(failures, [], `cardinal/reflection displacement must match exactly; other transforms may differ by at most 1 device pixel of filter sampling plus edge AA; all metrics=${JSON.stringify(results)}`);
});
