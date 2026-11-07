import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { createCanvas } from "@napi-rs/canvas";
import {
  MAX_GRID_REPETITIONS_PER_AXIS,
  MAX_INWARD_ECHO_COPIES,
  MAX_NOISE_TILE_REPETITIONS_PER_AXIS,
  MAX_RADIAL_REPEAT_COPIES,
  MAX_UTILITY_COPY_COUNT,
  UTILITY_COPY_EFFECTS,
  renderGridScrollX,
  renderGridScrollY,
  renderInwardEchoes,
  renderNoiseTile,
  renderRadialRepeatBlur,
  renderWiggle,
} from "./utilityCopies.js";

const WIDTH = 64;
const HEIGHT = 48;
const bounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
const sample = [
  '<rect x="0" y="0" width="64" height="48" fill="#161a24"/>',
  '<path d="M3 4h13v40H3zM27 4h9v40h-9zM47 4h13v40H47z" fill="#ff577f"/>',
  '<circle cx="32" cy="24" r="10" fill="#f6f7fb"/>',
].join("");

function makeFrame(render, parameters = {}, time = 0, options = {}) {
  const frameBounds = options.bounds ?? bounds;
  const canvasWidth = options.canvasWidth ?? WIDTH;
  const canvasHeight = options.canvasHeight ?? HEIGHT;
  const content = options.content ?? sample;
  let sequence = 0;
  const defs = [];
  const included = [];
  const frame = {
    content,
    bounds: frameBounds,
    ...(options.paintBounds ? { paintBounds: options.paintBounds } : {}),
    ...(options.drawnBounds ? { drawnBounds: options.drawnBounds } : {}),
    parameters,
    time,
    progress: 0.5,
    helpers: {
      id: (kind) => `${options.prefix ?? "utility"}-${kind}-${++sequence}`,
      defs,
      includeBounds: (value) => included.push(value),
      ...(options.raster ? { raster: true } : {}),
    },
  };
  const output = render(frame);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { frame, output, defs, included, svg };
}

function pixels(render, parameters = {}, time = 0, options = {}) {
  return new Resvg(makeFrame(render, parameters, time, options).svg).render().pixels;
}

function changedPixels(first, second, threshold = 2) {
  assert.equal(first.length, second.length);
  let count = 0;
  for (let index = 0; index < first.length; index += 4) {
    if (Math.abs(first[index] - second[index]) > threshold ||
        Math.abs(first[index + 1] - second[index + 1]) > threshold ||
        Math.abs(first[index + 2] - second[index + 2]) > threshold ||
        Math.abs(first[index + 3] - second[index + 3]) > threshold) count += 1;
  }
  return count;
}

function copyCount(output) { return (output.match(/<g transform="matrix\(/g) ?? []).length; }

test("utility copy definitions expose the observed defaults and bounded repeat controls", () => {
  assert.deepEqual(UTILITY_COPY_EFFECTS.map((effect) => effect.label), [
    "Grid Scroll X", "Grid Scroll Y", "Inward Echoes", "Noise Tile", "Radial Repeat Blur", "Wiggle",
  ]);
  assert.ok(UTILITY_COPY_EFFECTS.every((effect) => effect.group === "Utility" && effect.kind === "ranged" && typeof effect.render === "function"));
  const byKey = new Map(UTILITY_COPY_EFFECTS.map((effect) => [effect.key, effect]));
  const defaults = (key) => Object.fromEntries(Object.entries(byKey.get(key).parameters).map(([name, field]) => [name, field.default]));
  assert.deepEqual(defaults("grid-scroll-x"), {
    repeatX: 5, repeatY: 5, gapX: 60, gapY: 60, baseSpeed: 0.25,
    speedVariation: 0.5, lineOffset: 0.5, scaleFactor: 0.7,
  });
  assert.deepEqual(defaults("inward-echoes"), { scaleDown: 0.3, repeatCount: 5, centerX: 0.5, centerY: 0.5 });
  assert.deepEqual(defaults("noise-tile"), {
    repetitionsX: 5, repetitionsY: 5, gapX: 12, gapY: 12, scale: 1, noiseScale: 1.5,
    noiseMoveX: 0.6, noiseMoveY: 0.4, fps: 12, threshold: 0.45, seedOffset: 0,
  });
  assert.deepEqual(defaults("radial-repeat-blur"), {
    angle: 300, centerX: 1, blurAmount: 0.18, repeats: 40, edgeFalloff: 0.5, centerY: 0,
  });
  assert.deepEqual(defaults("wiggle"), { wiggleX: 3, wiggleY: 3, speed: 3, angle: 0, seed: 1 });
  assert.equal(byKey.get("inward-echoes").parameters.scaleDown.initial, 1);
  assert.equal(byKey.get("radial-repeat-blur").parameters.angle.initial, 0);
  assert.equal(byKey.get("radial-repeat-blur").parameters.centerX.initial, -1);
  assert.equal(byKey.get("grid-scroll-x").parameters.baseSpeed.unit, "layer sizes/s");
  assert.equal(byKey.get("wiggle").parameters.angle.unit, "°");
  assert.ok(Object.isFrozen(UTILITY_COPY_EFFECTS) && Object.isFrozen(byKey.get("wiggle").parameters.wiggleX));
  assert.deepEqual([
    MAX_GRID_REPETITIONS_PER_AXIS,
    MAX_NOISE_TILE_REPETITIONS_PER_AXIS,
    MAX_INWARD_ECHO_COPIES,
    MAX_RADIAL_REPEAT_COPIES,
    MAX_UTILITY_COPY_COUNT,
  ], [10, 10, 64, 64, 128]);
});

test("every renderer keeps one original semantic proxy and strips semantics from visible copies", () => {
  const content = '<g id="layer-content" data-layer-id="layer-a" role="img" aria-label="original"><rect x="12" y="10" width="20" height="20" fill="#e53935"/></g>';
  const cases = [
    [renderGridScrollX, { repeatX: 2, repeatY: 2, gapX: 0, gapY: 0, speedVariation: 0 }],
    [renderGridScrollY, { repeatX: 2, repeatY: 2, gapX: 0, gapY: 0, speedVariation: 0 }],
    [renderInwardEchoes, { repeatCount: 2 }],
    [renderNoiseTile, { repetitionsX: 2, repetitionsY: 2, gapX: 0, gapY: 0, threshold: 0 }],
    [renderRadialRepeatBlur, { repeats: 3, blurAmount: 0 }],
    [renderWiggle, {}],
  ];
  for (const [render, parameters] of cases) {
    const { output, defs } = makeFrame(render, parameters, 0.2, { content });
    assert.equal((output.match(/opacity="0"/g) ?? []).length, 1);
    const decorative = output.slice(0, output.lastIndexOf('opacity="0"'));
    assert.match(decorative, /aria-hidden="true" pointer-events="none"/);
    assert.doesNotMatch(decorative, /id="layer-content"|data-layer-id=|aria-label=/);
    assert.match(output.slice(output.lastIndexOf('opacity="0"')), /id="layer-content" data-layer-id="layer-a"/);
    if (defs.some((definition) => definition.includes("copy-source"))) {
      const sourceDefinition = defs.find((definition) => definition.includes("copy-source"));
      assert.doesNotMatch(sourceDefinition, /id="layer-content"|data-layer-id=|aria-label=/);
      assert.match(decorative, /<use href="#utility-copy-source-/);
    }
  }
});

test("a copy-heavy effect on already-stacked SVG reuses one source definition", () => {
  const priorStack = `<g>${'<path d="M0 0h10v10z" fill="#e53935"/>'.repeat(1800)}</g>`;
  const entry = makeFrame(renderRadialRepeatBlur, {
    angle: 90, centerX: 0, centerY: 0, blurAmount: 0, repeats: 64, edgeFalloff: 0.5,
  }, 0.4, { content: priorStack });
  const totalSize = entry.output.length + entry.defs.join("").length;
  assert.equal(copyCount(entry.output), 64);
  assert.equal(entry.defs.filter((definition) => definition.includes("copy-source")).length, 1);
  assert.ok(totalSize < priorStack.length * 3,
    "source SVG is stored once and referenced by every transformed copy instead of repeated N times");
});

// Chromium left out parts of many plain <use> copies (backend/utility-copies-chromium.test.mjs
// draws the picture). The copies' definition starts with a home rectangle as large as everything
// the layer draws, which keeps each copy in one piece there; raster markup (resvg) gets none.
test("Radial Repeat Blur copies one definition that starts with a home rectangle, except in raster markup", () => {
  const parameters = { angle: 300, centerX: 1, centerY: 0, blurAmount: 0, repeats: 64, edgeFalloff: 0.5 };
  const paintBounds = { x: -20, y: -10, width: 120, height: 80 };
  const home = (box) => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="transparent" stroke="none" aria-hidden="true" pointer-events="none"/>`;
  const sourceOf = (entry) => entry.defs.find((definition) => definition.includes("copy-source"));
  const copies = makeFrame(renderRadialRepeatBlur, parameters, 0.5, { paintBounds });
  assert.equal(copyCount(copies.output), 64);
  assert.equal((copies.output.match(/<use href="#utility-copy-source-1"/g) ?? []).length, 64);
  assert.ok(sourceOf(copies).startsWith(`<g id="utility-copy-source-1">${home(paintBounds)}`));
  assert.equal(sourceOf(copies).split(sample).length, 2, "the definition holds the layer once");

  // What the layer drew before an effect kept its paint inside a box (Noise Mask) sets the home.
  const drawnBounds = { x: -500, y: -300, width: 1500, height: 900 };
  const drawn = makeFrame(renderRadialRepeatBlur, parameters, 0.5, { paintBounds, drawnBounds });
  assert.ok(sourceOf(drawn).startsWith(`<g id="utility-copy-source-1">${home(drawnBounds)}`));

  // Over a filter on parts that are drawn on their own, the home is repeated inside the filter.
  const content = `<g filter="url(#glow)"><g transform="translate(1 1)">${sample}</g></g>`;
  const filtered = makeFrame(renderRadialRepeatBlur, parameters, 0.5, { paintBounds, content });
  assert.equal((filtered.output.match(/<use href="#utility-copy-source-1"/g) ?? []).length, 64);
  assert.ok(sourceOf(filtered).includes(`<g filter="url(#glow)">${home(paintBounds)}<g transform`));

  const raster = makeFrame(renderRadialRepeatBlur, parameters, 0.5, { paintBounds, raster: true });
  assert.equal((raster.output.match(/<use href="#utility-copy-source-1"/g) ?? []).length, 64);
  assert.doesNotMatch(sourceOf(raster), /fill="transparent"/);
});

test("Grid Scroll X and Y wrap at their cell period in both speed directions and clip overflow", () => {
  const horizontal = { repeatX: 4, repeatY: 3, gapX: 4, gapY: 2, baseSpeed: -0.5, speedVariation: 0, scaleFactor: 1 };
  const horizontalAtStart = pixels(renderGridScrollX, horizontal, 0);
  const horizontalAtWrap = pixels(renderGridScrollX, horizontal, 20 / 32);
  assert.equal(changedPixels(horizontalAtStart, horizontalAtWrap), 0, "negative speed returns to the same phase after one cell period");
  assert.ok(changedPixels(horizontalAtStart, pixels(renderGridScrollX, { ...horizontal, baseSpeed: 0.5 }, 0.1)) > 20,
    "positive and negative scroll move the row pattern in opposite directions");

  const vertical = { repeatX: 4, repeatY: 3, gapX: 2, gapY: 3, baseSpeed: -0.5, speedVariation: 0, scaleFactor: 1 };
  const verticalAtStart = pixels(renderGridScrollY, vertical, 0);
  const verticalAtWrap = pixels(renderGridScrollY, vertical, 19 / 24);
  assert.equal(changedPixels(verticalAtStart, verticalAtWrap), 0, "vertical negative speed wraps after one row pitch");
  assert.ok(changedPixels(verticalAtStart, pixels(renderGridScrollY, { ...vertical, baseSpeed: 0.5 }, 0.1)) > 20);

  const clipped = makeFrame(renderGridScrollX,
    { repeatX: 2, repeatY: 2, gapX: 0, gapY: 0, baseSpeed: 1, speedVariation: 0, scaleFactor: 1 }, 0.3,
    { bounds: { x: 8, y: 6, width: 48, height: 36 }, canvasWidth: 64, canvasHeight: 48,
      content: '<rect x="8" y="6" width="48" height="36" fill="#ef233c"/>' });
  const rendered = new Resvg(clipped.svg).render().pixels;
  for (let y = 0; y < 48; y += 1) for (let x = 0; x < 64; x += 1) {
    if (x < 8 || x >= 56 || y < 6 || y >= 42) assert.equal(rendered[(y * 64 + x) * 4 + 3], 0);
  }
});

test("Grid Scroll defaults remain visible on a 200x140 box with fixed-pixel gaps", () => {
  const frameBounds = { x: 0, y: 0, width: 200, height: 140 };
  const content = '<rect x="0" y="0" width="200" height="140" fill="#ef233c"/>';
  const visiblePixels = (render) => {
    const rendered = pixels(render, {}, 0.2, {
      bounds: frameBounds, canvasWidth: 200, canvasHeight: 140, content,
    });
    let count = 0;
    for (let index = 3; index < rendered.length; index += 4) if (rendered[index] > 0) count += 1;
    return count;
  };
  assert.ok(visiblePixels(renderGridScrollX) > 1_000, "horizontal defaults render cropped tiles instead of collapsing to zero area");
  assert.ok(visiblePixels(renderGridScrollY) > 1_000, "vertical defaults render cropped tiles instead of collapsing to zero area");
});

test("Grid Scroll X culls only off-clip copies using actual overflow paint bounds", () => {
  const content = '<rect x="100" y="12" width="20" height="20" fill="#ff3040"/>';
  const paint = { x: 100, y: 12, width: 20, height: 20 };
  const entry = makeFrame(renderGridScrollX, {
    repeatX: 2, repeatY: 1, gapX: 0, gapY: 0, baseSpeed: 0, speedVariation: 0, scaleFactor: 1,
  }, 0, { content, paintBounds: paint });
  assert.equal(copyCount(entry.output), 2, "the guard cell survives because prior-effect paint overflows into the layer box");
  const raster = new Resvg(entry.svg).render().pixels;
  const visible = raster.subarray((20 * WIDTH + 23) * 4, (20 * WIDTH + 23) * 4 + 4);
  assert.ok(visible[0] > 200 && visible[3] > 200, "the overflow guard copy remains visible inside the clip");
});

test("Grid Scroll X does not pass offscreen parity-image guards to Resvg", () => {
  // Match scripts/effects-parity.mjs createImageFixture() and its rotated,
  // nonuniformly scaled image sample. Keep native Resvg in a child process so
  // a renderer panic is reported as a test failure instead of killing Node's suite.
  const canvas = createCanvas(32, 24);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 32, 24);
  context.fillStyle = "#f4f0e8";
  context.fillRect(2, 2, 24, 19);
  context.fillStyle = "#ed365a";
  context.fillRect(4, 4, 3, 16);
  context.fillRect(12, 4, 7, 7);
  context.fillStyle = "#2054bf";
  context.fillRect(20, 6, 4, 14);
  context.fillStyle = "#ffd447";
  context.beginPath();
  context.arc(10, 16, 4, 0, Math.PI * 2);
  context.fill();
  const image = `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
  const content = `<g clip-path="url(#image-clip)"><image x="0" y="0" width="73" height="58" href="${image}" preserveAspectRatio="xMidYMid slice"/></g>`;
  const clipDefinition = '<clipPath id="image-clip" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="73" height="58"/></clipPath>';
  const utilityUrl = new URL("./utilityCopies.js", import.meta.url).href;
  const childSource = [
    'import { Resvg } from "@resvg/resvg-js";',
    `const { renderGridScrollX } = await import(${JSON.stringify(utilityUrl)});`,
    `const content = ${JSON.stringify(content)};`,
    'const bounds = { x: 0, y: 0, width: 73, height: 58 };',
    `const defs = [${JSON.stringify(clipDefinition)}];`,
    'let sequence = 0;',
    'const frame = { content, bounds, paintBounds: bounds, parameters: { repeatX: 5, repeatY: 5, gapX: 60, gapY: 60, baseSpeed: 0.25, speedVariation: 0.5, lineOffset: 0.5, scaleFactor: 0.7 }, time: 0, progress: 0, helpers: { id: (kind) => `image-${kind}-${++sequence}`, defs, includeBounds() {} } };',
    'const output = renderGridScrollX(frame);',
    'const angle = 6 * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);',
    'const a = cosine * 1.08, b = sine * 1.08, c = -sine * 0.86, d = cosine * 0.86;',
    'const cx = 73 / 2, cy = 58 / 2, e = 27 + cx - a * cx - c * cy, f = 18 + cy - b * cx - d * cy;',
    'const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96" viewBox="0 0 128 96"><defs>${defs.join("")}</defs><g transform="matrix(${a} ${b} ${c} ${d} ${e} ${f})">${output}</g></svg>`;',
    'const pixels = new Resvg(svg).render().pixels;',
    'if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) throw new Error("parity image produced no visible pixels");',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000,
  });
  assert.equal(child.error, undefined, child.error?.message ?? "native child process did not launch");
  assert.equal(child.status, 0, `native image render failed (${child.signal ?? child.status}): ${child.stderr.slice(0, 1_000)}`);
});

test("Grid Scroll and Noise Tile omit zero-scale copies before SVG rasterization", () => {
  const blankPixels = (render, parameters) => {
    const entry = makeFrame(render, parameters, 0);
    assert.equal(copyCount(entry.output), 0);
    assert.equal(entry.defs.filter((definition) => definition.includes("copy-source")).length, 0);
    const raster = new Resvg(entry.svg).render().pixels;
    for (let index = 3; index < raster.length; index += 4) assert.equal(raster[index], 0);
  };
  blankPixels(renderGridScrollX, { scaleFactor: 0 });
  blankPixels(renderNoiseTile, { scale: 0, threshold: 0 });
});

test("Noise Tile culls copies outside its clipped box but retains overflow paint", () => {
  const content = '<rect x="100" y="12" width="20" height="20" fill="#ff3040"/>';
  const entry = makeFrame(renderNoiseTile, {
    repetitionsX: 2, repetitionsY: 1, gapX: 0, gapY: 0, scale: 1, threshold: 0,
  }, 0, { content, paintBounds: { x: 100, y: 12, width: 20, height: 20 } });
  assert.equal(copyCount(entry.output), 1, "only the transformed overflow paint that intersects the clip is retained");
  const raster = new Resvg(entry.svg).render().pixels;
  const visible = raster.subarray((20 * WIDTH + 55) * 4, (20 * WIDTH + 55) * 4 + 4);
  assert.ok(visible[0] > 200 && visible[3] > 200);
});

test("maximum grid counts stay under the global copy cap", () => {
  const repetitions = MAX_GRID_REPETITIONS_PER_AXIS;
  const parameters = {
    repeatX: repetitions, repeatY: repetitions,
    gapX: 0, gapY: 0, speedVariation: 0,
  };
  const candidateCount = (repetitions + 2) * repetitions;
  const oneVisibleAlternatingGuardPerOddLine = Math.floor(repetitions / 2);
  const visibleCount = repetitions * repetitions + oneVisibleAlternatingGuardPerOddLine;
  assert.equal(copyCount(makeFrame(renderGridScrollX, parameters).output), visibleCount,
    "the half-pitch line offset brings one guard copy into the clip on each odd row");
  assert.equal(copyCount(makeFrame(renderGridScrollY, parameters).output), visibleCount,
    "the half-pitch line offset brings one guard copy into the clip on each odd column");
  assert.ok(candidateCount <= MAX_UTILITY_COPY_COUNT, "the full candidate set stays under the global cap before culling");
  assert.throws(() => makeFrame(renderGridScrollX, { ...parameters, repeatX: MAX_GRID_REPETITIONS_PER_AXIS + 1 }), /repeatX/);
});

test("Inward Echoes place scaled copies behind the visible original and report its paint bounds", () => {
  const ring = '<circle cx="32" cy="24" r="18" fill="none" stroke="#ff2d55" stroke-width="6"/>';
  const options = { content: ring, paintBounds: { x: 10, y: 2, width: 44, height: 44 } };
  const none = pixels(renderInwardEchoes, { repeatCount: 0, scaleDown: 0.3, centerX: 0.5, centerY: 0.5 }, 0.5, options);
  const echoes = makeFrame(renderInwardEchoes, { repeatCount: 5, scaleDown: 0.3, centerX: 0.5, centerY: 0.5 }, 0.5, options);
  assert.ok(changedPixels(none, new Resvg(echoes.svg).render().pixels) > 100, "smaller rings appear inside the original ring");
  assert.deepEqual(echoes.included, [options.paintBounds], "scaled echoes remain within the original paint extent");
  assert.equal(copyCount(echoes.output), 6, "five copies plus the original are visible");
  assert.throws(() => makeFrame(renderInwardEchoes, { repeatCount: MAX_INWARD_ECHO_COPIES + 1 }), /repeatCount/);
});

test("Noise Tile is deterministic, time-quantized, freezes at FPS zero, and bounds copies", () => {
  const parameters = {
    repetitionsX: 3, repetitionsY: 2, gapX: 3, gapY: 4, scale: 1, noiseScale: 1.5,
    noiseMoveX: 1, noiseMoveY: 0.8, fps: 12, threshold: 0.45, seedOffset: 7,
  };
  const first = makeFrame(renderNoiseTile, parameters, 0.01);
  const sameTick = makeFrame(renderNoiseTile, parameters, 0.07);
  assert.equal(first.output, sameTick.output, "frames in the same FPS bucket reuse the same noise state");
  assert.deepEqual(pixels(renderNoiseTile, parameters, 0.01), pixels(renderNoiseTile, parameters, 0.07));
  const nextTick = pixels(renderNoiseTile, parameters, 0.1);
  assert.ok(changedPixels(pixels(renderNoiseTile, parameters, 0.01), nextTick) > 0, "the field updates on the next 12 FPS step");
  const frozen = { ...parameters, fps: 0 };
  assert.deepEqual(pixels(renderNoiseTile, frozen, 0), pixels(renderNoiseTile, frozen, 100), "FPS zero holds the initial field");
  assert.equal(copyCount(makeFrame(renderNoiseTile, { ...parameters, threshold: 0 }, 0).output), 6,
    "threshold zero shows every tile");
  assert.equal(copyCount(makeFrame(renderNoiseTile, { ...parameters, threshold: 1, seedOffset: 0 }, 0).output), 0,
    "threshold one hides this bounded seed sample");

  const max = makeFrame(renderNoiseTile, {
    ...parameters,
    repetitionsX: MAX_NOISE_TILE_REPETITIONS_PER_AXIS,
    repetitionsY: MAX_NOISE_TILE_REPETITIONS_PER_AXIS,
    threshold: 0,
  }, 0);
  assert.equal(copyCount(max.output), 100);
  assert.throws(() => makeFrame(renderNoiseTile, { ...parameters, fps: -1 }), /fps/);
  assert.throws(() => makeFrame(renderNoiseTile, { ...parameters, repetitionsX: 11 }), /repetitionsX/);
});

test("Radial Repeat Blur rotates around the selected normalized center and reports blur overflow", () => {
  const content = '<rect x="20" y="8" width="20" height="10" fill="#ff3040"/>';
  const options = { content, paintBounds: { x: 20, y: 8, width: 20, height: 10 } };
  const common = { angle: 180, blurAmount: 1, repeats: 2, edgeFalloff: 0, centerY: 0 };
  const leftCenter = makeFrame(renderRadialRepeatBlur, { ...common, centerX: -1 }, 0.5, options);
  const middleCenter = pixels(renderRadialRepeatBlur, { ...common, centerX: 0 }, 0.5, options);
  assert.ok(changedPixels(new Resvg(leftCenter.svg).render().pixels, middleCenter) > 20,
    "moving the radial center changes where the repeated paint lands");
  assert.equal(leftCenter.defs.length, 2);
  assert.match(leftCenter.defs.find((definition) => definition.startsWith("<filter")), /stdDeviation="1"/);
  const region = leftCenter.included[0];
  assert.deepEqual({ x: region.x, y: region.y, width: region.width }, { x: -43, y: 5, width: 86 });
  assert.ok(Math.abs(region.height - 38) < 1e-8, "the two rotated paints and 3-sigma blur are included");
  assert.equal(copyCount(leftCenter.output), 2);
  assert.throws(() => makeFrame(renderRadialRepeatBlur, { ...common, repeats: MAX_RADIAL_REPEAT_COPIES + 1 }), /repeats/);
});

test("Wiggle is seeded, smooth and periodic at the declared cycles-per-second rate", () => {
  const parameters = { wiggleX: 7, wiggleY: 4, speed: 3, angle: 35, seed: 10 };
  const atStart = pixels(renderWiggle, parameters, 0);
  const atPeriod = pixels(renderWiggle, parameters, 1 / parameters.speed);
  assert.equal(changedPixels(atStart, atPeriod), 0, "one full declared cycle returns to the same transform");
  assert.ok(changedPixels(atStart, pixels(renderWiggle, parameters, 0.08)) > 20);
  assert.ok(changedPixels(atStart, pixels(renderWiggle, { ...parameters, seed: 11 }, 0)) > 0);

  const included = makeFrame(renderWiggle, parameters, 0.08, {
    content: '<rect x="26" y="18" width="10" height="8" fill="#ff3040"/>',
    paintBounds: { x: 26, y: 18, width: 10, height: 8 },
  }).included[0];
  assert.ok(included.x < 26 && included.y < 18 && included.x + included.width > 36 && included.y + included.height > 26,
    "rotated paint bounds include the jittered overhang");
  assert.throws(() => makeFrame(renderWiggle, { ...parameters, speed: 61 }), /speed/);
});

// The budget is CPU time, not wall time: on a busy machine (the suite runs files side by side)
// the same work takes longer by the clock, and that is not a slower effect.
test("each Utility copy effect renders a 1920x1080 frame within the 30 second budget", { timeout: 120_000 }, () => {
  const sceneBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const content = '<rect x="0" y="0" width="1920" height="1080" fill="#202431"/><circle cx="960" cy="540" r="310" fill="#ef476f"/><path d="M180 180h1560v720H180z" fill="none" stroke="#f4f4f5" stroke-width="24"/>';
  const started = process.cpuUsage();
  for (const effect of UTILITY_COPY_EFFECTS) {
    const parameters = Object.fromEntries(Object.entries(effect.parameters).map(([key, field]) => [key, field.default]));
    const entry = makeFrame(effect.render, parameters, 0.37, {
      bounds: sceneBounds, paintBounds: sceneBounds, canvasWidth: 1920, canvasHeight: 1080, content,
    });
    const raster = new Resvg(entry.svg).render().pixels;
    assert.equal(raster.length, 1920 * 1080 * 4, `${effect.label} renders the expected frame size`);
  }
  const { user, system } = process.cpuUsage(started);
  assert.ok((user + system) / 1000 < 30_000, `the six default utility effects fit the generous render budget (${Math.round((user + system) / 1000)} ms of CPU)`);
});
