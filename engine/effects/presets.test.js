import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { EFFECT_PRESET_KEYS, renderEffectPreset } from "./presets.js";

const WIDTH = 64;
const HEIGHT = 48;
const BOUNDS = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
const SOURCE = [
  '<g id="source-layer" data-layer-id="layer-1" role="img" aria-label="Accessible sample">',
  ...Array.from({ length: 16 }, (_, index) => {
    const gray = Math.round(index * 255 / 15).toString(16).padStart(2, "0");
    return `<rect x="${index * 4}" y="8" width="4" height="32" fill="#${gray}${gray}${gray}"/>`;
  }),
  '<circle cx="30" cy="22" r="12" fill="#E64576" fill-opacity="0.62"/>',
  '<path d="M5 44L24 39L41 45L60 41" fill="none" stroke="#11AABB" stroke-width="3"/>',
  "</g>",
].join("");

function makeFrame(key, progress, parameters = {}, options = {}) {
  const bounds = options.bounds ?? BOUNDS;
  const defs = [];
  let sequence = 0;
  const frame = {
    content: options.content ?? SOURCE,
    bounds,
    paintBounds: options.paintBounds,
    progress,
    parameters,
    // Preset renderers must not use time; it is fixed to catch accidental dependence.
    time: options.time ?? 3.75,
    helpers: {
      id: (kind) => `${options.prefix ?? key}-${kind}-${++sequence}`,
      defs,
      raster: options.raster ?? false,
      transform: options.transform,
    },
  };
  const output = renderEffectPreset(key, frame);
  const width = options.canvasWidth ?? bounds.width;
  const height = options.canvasHeight ?? bounds.height;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { frame, output, defs, svg };
}

function pixels(key, progress, parameters = {}, options = {}) {
  return new Resvg(makeFrame(key, progress, parameters, options).svg).render().pixels;
}

function changedPixelCount(left, right, threshold = 2) {
  assert.equal(left.length, right.length);
  let changed = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    if ([0, 1, 2, 3].some((channel) => Math.abs(left[offset + channel] - right[offset + channel]) > threshold)) changed += 1;
  }
  return changed;
}

test("seven preset renderers have exact hidden and untouched endpoints", () => {
  assert.deepEqual(EFFECT_PRESET_KEYS, ["dissolve", "pixel", "pixel-wipe", "luma-reveal", "glitch", "barrel", "film-roll"]);
  for (const key of EFFECT_PRESET_KEYS) {
    const hidden = makeFrame(key, 0);
    assert.match(hidden.output, /opacity="0"/);
    assert.equal((hidden.output.match(/data-layer-id="layer-1"/g) ?? []).length, 1,
      `${key} keeps one semantic source and hit target`);
    assert.ok(new Resvg(hidden.svg).render().pixels.every((value) => value === 0), `${key} is fully hidden at progress zero`);

    const end = makeFrame(key, 1);
    assert.equal(end.output, SOURCE, `${key} returns the untouched SVG at progress one`);
    assert.equal(end.defs.length, 0, `${key} does not add effect definitions at the clean endpoint`);
    assert.deepEqual(new Resvg(end.svg).render().pixels, new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${SOURCE}</svg>`).render().pixels);
  }
});

test("every preset makes a deterministic visible mid-transition from the same source", () => {
  const parameters = {
    dissolve: { scale: 10, sharpness: 100, variant: 2 },
    pixel: { pixelSize: 8, variant: 2 },
    "pixel-wipe": { direction: "right", scale: 8, spread: 18, variant: 2 },
    "luma-reveal": { sharpness: 90, direction: "light-to-dark" },
    glitch: { sliceSize: 8, speed: 65, colorShift: 40, variant: 2 },
    barrel: { intensity: 0.5, direction: "inward" },
    "film-roll": { direction: "up", copies: 6, motionBlur: 50, stretch: 50 },
  };
  const baseline = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${SOURCE}</svg>`).render().pixels;
  for (const key of EFFECT_PRESET_KEYS) {
    const first = makeFrame(key, 0.47, parameters[key], { prefix: `mid-${key}` });
    const second = makeFrame(key, 0.47, parameters[key], { prefix: `mid-${key}` });
    const firstPixels = new Resvg(first.svg).render().pixels;
    assert.deepEqual(firstPixels, new Resvg(second.svg).render().pixels, `${key} uses no random or clock state`);
    assert.ok(changedPixelCount(firstPixels, baseline) > 80, `${key} has a visible midframe`);
    assert.equal((first.output.match(/data-layer-id="layer-1"/g) ?? []).length, 1,
      `${key} only exposes the original semantic layer once`);
  }
});

test("Variant changes the seeded block and noise looks without relying on frame time", () => {
  for (const key of ["dissolve", "pixel", "pixel-wipe", "glitch"]) {
    const base = { dissolve: { scale: 10, sharpness: 80 }, pixel: { pixelSize: 8 },
      "pixel-wipe": { scale: 8, spread: 16, direction: "down" }, glitch: { sliceSize: 8, speed: 65, colorShift: 35 } }[key];
    const first = pixels(key, 0.43, { ...base, variant: 2 }, { prefix: `${key}-v2` });
    const second = pixels(key, 0.43, { ...base, variant: 93 }, { prefix: `${key}-v93`, time: 29 });
    assert.ok(changedPixelCount(first, second) > 30, `${key} variant changes its seeded pattern`);
  }
});

test("Pixel and Pixel Wipe respect square cells, direction, and spread controls", () => {
  const pixelSmall = pixels("pixel", 0.5, { pixelSize: 6, variant: 2 });
  const pixelLarge = pixels("pixel", 0.5, { pixelSize: 16, variant: 2 });
  assert.ok(changedPixelCount(pixelSmall, pixelLarge) > 100);

  const right = pixels("pixel-wipe", 0.45, { direction: "right", scale: 8, spread: 14, variant: 2 });
  const left = pixels("pixel-wipe", 0.45, { direction: "left", scale: 8, spread: 14, variant: 2 });
  const narrow = pixels("pixel-wipe", 0.45, { direction: "right", scale: 8, spread: 2, variant: 2 });
  assert.ok(changedPixelCount(right, left) > 100, "opposite directions reveal opposite sides first");
  assert.ok(changedPixelCount(right, narrow) > 40, "Spread controls the randomized edge band");
});

test("Luma Reveal changes reveal order and keeps antialiased source coverage", () => {
  const lightFirst = pixels("luma-reveal", 0.45, { sharpness: 100, direction: "light-to-dark" });
  const darkFirst = pixels("luma-reveal", 0.45, { sharpness: 100, direction: "dark-to-light" });
  assert.ok(changedPixelCount(lightFirst, darkFirst) > 500);
  const alphaSource = '<circle cx="32" cy="24" r="18" fill="#D83A66" fill-opacity="0.55"/>';
  const original = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${alphaSource}</svg>`).render().pixels;
  const reveal = pixels("luma-reveal", 0.55, { direction: "light-to-dark", sharpness: 80 }, { content: alphaSource });
  for (let offset = 3; offset < original.length; offset += 4)
    assert.ok(reveal[offset] <= original[offset] + 1, "luma selection does not add alpha coverage");
});

test("Barrel direction, Glitch controls, and Film Roll controls change real pixels", () => {
  const inward = pixels("barrel", 0.48, { intensity: 0.8, direction: "inward" });
  const outward = pixels("barrel", 0.48, { intensity: 0.8, direction: "outward" });
  assert.ok(changedPixelCount(inward, outward) > 100);

  const glitchSlow = pixels("glitch", 0.43, { sliceSize: 6, speed: 10, colorShift: 20, variant: 2 });
  const glitchFast = pixels("glitch", 0.43, { sliceSize: 6, speed: 90, colorShift: 20, variant: 2 });
  assert.ok(changedPixelCount(glitchSlow, glitchFast) > 30);

  const rollShort = pixels("film-roll", 0.45, { direction: "up", copies: 3, motionBlur: 0, stretch: 0 });
  const rollLong = pixels("film-roll", 0.45, { direction: "up", copies: 9, motionBlur: 80, stretch: 80 });
  assert.ok(changedPixelCount(rollShort, rollLong) > 300);
  const rollSideways = pixels("film-roll", 0.45, { direction: "right", copies: 6, motionBlur: 30, stretch: 50 });
  assert.ok(changedPixelCount(rollShort, rollSideways) > 300);
});

test("static preset maps are data images, definitions stay bounded, and large Glitch uses a capped slice count", () => {
  for (const key of ["dissolve", "pixel", "pixel-wipe"]) {
    const entry = makeFrame(key, 0.5, { scale: 8, pixelSize: 8, spread: 16, variant: 3 });
    assert.match(entry.defs.join(""), /href="data:image\/png;base64,/);
    assert.doesNotMatch(entry.defs.join(""), /href="#|href="url\(#/);
    for (const definition of entry.defs) for (const match of definition.matchAll(/<feImage\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g))
      assert.ok(Number(match[1]) <= 512 && Number(match[2]) <= 512);
  }
  const large = makeFrame("glitch", 0.5, { sliceSize: 1, speed: 80, colorShift: 20, variant: 1 }, {
    bounds: { x: 0, y: 0, width: 64, height: 20_000 }, canvasWidth: 64, canvasHeight: 20_000,
  });
  assert.ok((large.defs.join("").match(/<clipPath\b/g) ?? []).length <= 256);
  assert.ok((large.output.match(/href="#/g) ?? []).length <= 256);
});

test("unknown preset ids and invalid progress are rejected", () => {
  const validFrame = makeFrame("dissolve", 0.4).frame;
  assert.throws(() => renderEffectPreset("not-a-preset", validFrame), /Unknown effect preset/);
  assert.throws(() => renderEffectPreset("dissolve", { ...validFrame, progress: NaN }), /finite progress/);
});
