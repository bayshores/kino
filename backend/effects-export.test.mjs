import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createLayer, createScene } from "../engine/model.js";
import { EFFECTS, effectDefaults } from "../engine/effects/catalog.js";
import { cubeText } from "../engine/effects/colorMath.js";
import { EFFECT_PRESET_DEFINITIONS } from "../engine/effects/presetCatalog.js";
import { exportScene, glowReadsLayer, layerBrightness, layerEdges, lumaLevels, normalizesLevels, readsBrightness } from "./export.mjs";
import { lumaSplit } from "./agent/shot-color.mjs";

test("normalize levels: the 2nd and 98th luma percentile of opaque pixels, for grades that ask", () => {
  // Every 4th pixel is sampled; half of those are transparent and skipped, leaving the 50 lumas
  // 50, 52, ... 148, whose 2nd and 98th percentiles are 50 and 146.
  const data = new Uint8ClampedArray(400 * 4);
  for (let pixel = 0; pixel < 400; pixel += 1) data.set([50 + pixel / 4, 50 + pixel / 4, 50 + pixel / 4, pixel % 8 === 4 ? 0 : 255], pixel * 4);
  const [low, high] = lumaLevels([{ data }]);
  assert.deepEqual([Math.round(low * 255), Math.round(high * 255)], [50, 146]);
  assert.equal(lumaLevels([{ data: new Uint8ClampedArray(16) }]), null);
  assert.equal(normalizesLevels({ kind: "effect", effect: "duotone", to: { normalize: true } }), true);
  // A duotone saved before normalize existed is not measured (it draws as it did).
  assert.equal(normalizesLevels({ kind: "effect", effect: "duotone", to: {} }), false);
  assert.equal(normalizesLevels({ kind: "effect", effect: "tritone", to: { normalize: false } }), false);
  assert.equal(normalizesLevels({ kind: "effect", effect: "color-look", to: { look: "section-grade" } }), true);
  assert.equal(normalizesLevels({ kind: "effect", effect: "color-look", to: { look: "ember" } }), false);
  // An auto glow reads its 90th and 99th percentile (lumas 50..148: 138 and 148); a numbered or behind one is not measured.
  assert.deepEqual(layerBrightness([{ data }]).map((value) => Math.round(value * 255)), [138, 148]);
  assert.equal(readsBrightness({ kind: "effect", effect: "glow", to: { threshold: "auto" } }), true);
  assert.equal(readsBrightness({ kind: "effect", effect: "glow", to: { threshold: 0.7 } }), false, "saved glows keep their number");
  assert.equal(readsBrightness({ kind: "effect", effect: "glow", to: { threshold: "auto", mode: "behind" } }), false);
  // A glow inside an animation group is measured too; a group that is off is not.
  const grouped = (enabled) => ({ animations: [{ id: "g", kind: "composed", start: 0, duration: 1, ...(enabled ? {} : { enabled: false }),
    animations: [{ id: "a", kind: "effect", effect: "glow", start: 0, duration: 1, to: { threshold: "auto" } }] }] });
  assert.equal(glowReadsLayer(grouped(true)), true);
  assert.equal(glowReadsLayer(grouped(false)), false);
  // A hit's recolor split (shot-color.mjs): a flat background on 60% of the picture is not cut in two;
  // the splits sit in the empty ranges around it (20 | 120 | 240: 30% below, then 70%).
  const flat = new Uint8ClampedArray(100 * 4);
  for (let pixel = 0; pixel < 100; pixel += 1) { const value = pixel < 30 ? 20 : pixel < 70 ? 120 : 240; flat.set([value, value, value, 255], pixel * 4); }
  assert.deepEqual(lumaSplit(flat), { at: [0.275, 0.706], gaps: [0.392, 0.471] });
});

test("edge-lines auto: the layer's own edge percentile and its black bars are measured; a numbered threshold is not", () => {
  // 40 x 40: black bars 6 rows tall top and bottom, a faint vertical step (100 to 110 gray) at x 20.
  const width = 40, height = 40, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const gray = y < 6 || y >= 34 ? 0 : x < 20 ? 100 : 110;
    data.set([gray, gray, gray, 255], (y * width + x) * 4);
  }
  const [threshold, top, bottom, left, right] = layerEdges([{ width, height, data }], 0);
  assert.deepEqual([top, bottom, left, right], [6 / height, 6 / height, 0, 0], "the bars, as shares of the picture");
  assert.ok(threshold > 0 && threshold <= 10 / 255 + 1e-9, `the threshold sits at or under the faint step: ${threshold}`);
  assert.equal(normalizesLevels({ kind: "effect", effect: "edge-lines", to: { threshold: "auto" } }), true);
  assert.equal(normalizesLevels({ kind: "effect", effect: "edge-lines", to: { threshold: 0.05 } }), false, "saved effects are not measured");
});

const OUTPUT = { format: "lottie", fps: 2, duration: 1 };

function effectOperation(key, { id = `animation-${key}`, enabled, parameters = effectDefaults(key) } = {}) {
  const definition = EFFECTS.find((effect) => effect.key === key);
  return {
    id,
    name: definition.label,
    kind: "effect",
    effect: key,
    start: 0,
    duration: 1,
    easing: "linear",
    ...(enabled !== undefined ? { enabled } : {}),
    to: parameters,
    ...(definition.kind === "ranged" ? { keepStill: "both" } : {}),
  };
}

function presetOperation(id) {
  const preset = EFFECT_PRESET_DEFINITIONS[id];
  return {
    id: `animation-preset-${id}`,
    name: preset.name,
    kind: "custom",
    start: 0,
    duration: preset.duration,
    easing: preset.easing,
    from: { effectPreset: { id, parameters: preset.parameters, progress: 0 } },
    to: { effectPreset: { id, parameters: preset.parameters, progress: 1 } },
  };
}

function makeScene(layer, { id = "effect-scene", width = 48, height = 36, layers = [layer], ...overrides } = {}) {
  return createScene({ id, name: "Effect export", width, height, duration: 1, background: "#FFFFFF", layers, ...overrides });
}

function effectScene(definition, overrides = {}, parameters = effectDefaults(definition.key)) {
  const layer = createLayer("rectangle", {
    id: `layer-${definition.key}`,
    name: definition.label,
    x: 12,
    y: 9,
    width: 20,
    height: 16,
    fill: "#E63946",
    ...overrides,
    animations: [effectOperation(definition.key, { parameters })],
  });
  return makeScene(layer, { id: `scene-${definition.key}` });
}

function parseAnimation(result) {
  return JSON.parse(result.buffer.toString("utf8"));
}

function lottieLayers(animation) {
  const assets = new Map(animation.assets.map((asset) => [asset.id, asset]));
  const seen = new Set();
  const output = [];
  const visit = (layers) => {
    for (const layer of layers ?? []) {
      output.push(layer);
      const asset = layer.ty === 0 ? assets.get(layer.refId) : null;
      if (asset?.layers && !seen.has(asset.id)) {
        seen.add(asset.id);
        visit(asset.layers);
      }
    }
  };
  visit(animation.layers);
  return output;
}

function sequenceFor(animation, name) {
  const assets = new Map(animation.assets.map((asset) => [asset.id, asset]));
  const root = lottieLayers(animation).find((layer) => layer.nm === name && layer.ty === 0 && assets.get(layer.refId)?.id.startsWith("effect_sequence_"));
  assert.ok(root, `Lottie contains a raster sequence layer for ${name}`);
  return { root, asset: assets.get(root.refId), assets };
}

function imageFrames(sequence) {
  return sequence.asset.layers.filter((layer) => layer.ty === 2).sort((left, right) => left.ip - right.ip);
}

function assertIntervals(frames, totalFrames = 2) {
  assert.ok(frames.length > 0, "sequence has embedded image frames");
  let next = 0;
  for (const frame of frames) {
    assert.equal(frame.ip, next, "image intervals have no gaps");
    assert.ok(frame.op > frame.ip, "image interval is nonempty");
    next = frame.op;
  }
  assert.equal(next, totalFrames, "image intervals cover the complete composition frame range");
}

async function assertEmbeddedPng(assets, frame, { density } = {}) {
  const asset = assets.get(frame.refId);
  assert.ok(asset, "frame references an embedded image asset");
  assert.equal(asset.e, 1, "embedded image does not need an external file");
  assert.match(asset.p, /^data:image\/png;base64,/u);
  const bitmap = await loadImage(Buffer.from(asset.p.slice(asset.p.indexOf(",") + 1), "base64"));
  assert.equal(bitmap.width, asset.w);
  assert.equal(bitmap.height, asset.h);
  assert.ok(bitmap.width > 0 && bitmap.height > 0);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  assert.equal(pixels.length, bitmap.width * bitmap.height * 4, "PNG contains real decoded RGBA pixels");
  if (density !== undefined) {
    const scale = frame.ks?.s?.k;
    assert.ok(Array.isArray(scale) && scale[0] > 0 && scale[1] > 0, "frame maps its raster back to local bounds");
    assert.ok(Math.abs(100 / scale[0] - density) < 0.02);
    assert.ok(Math.abs(100 / scale[1] - density) < 0.02);
  }
  return { asset, pixels: Uint8ClampedArray.from(pixels), bitmap };
}

function expectRasterWarning(result, { id, name, effect }) {
  const warning = result.warnings?.find((item) => item.code === "lottie-effect-rasterized" && item.layerId === id);
  assert.ok(warning, `export warns that ${name} was rasterized`);
  assert.equal(warning.layerName, name);
  assert.deepEqual(warning.effects, [effect]);
  assert.match(warning.message, new RegExp(`${effect}.*${name}.*embedded raster image sequence`, "u"));
  return warning;
}

// Every effect gets a labeled raster target (backend/lottie-effect-plan.test.mjs) and the raster
// path is the same for each, so `npm test` exports the first effect of each group and lut (which
// reads its .cube file). EVERY_EFFECT=1 exports every effect, preset and backdrop (by hand).
const EVERY = Boolean(process.env.EVERY_EFFECT);
const firstOfGroup = (definition, index, all) => all.findIndex((item) => item.group === definition.group) === index;
const SAMPLE_EFFECTS = EVERY ? EFFECTS : EFFECTS.filter((definition, index, all) => firstOfGroup(definition, index, all) || definition.key === "lut");
const SAMPLE_PRESETS = Object.values(EFFECT_PRESET_DEFINITIONS).slice(0, EVERY ? undefined : 1);

test("each group's first effect and lut export a named local raster sequence with actual embedded PNG pixels", async () => {
  assert.equal(EFFECTS.length, 64);
  // The lut effect needs an imported .cube file: this one, made here, inverts the colors.
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-effects-export-"));
  const lutFile = "0a1b2c3d-0000-4000-8000-0000000000c1.cube";
  await writeFile(path.join(mediaRoot, lutFile), cubeText({ size: 2, color: (r, g, b) => [1 - r, 1 - g, 1 - b] }));
  try {
    for (const definition of SAMPLE_EFFECTS) {
      const parameters = definition.key === "lut" ? { ...effectDefaults("lut"), lut: `/api/media/${lutFile}` } : effectDefaults(definition.key);
      const scene = effectScene(definition, {}, parameters);
      const before = structuredClone(scene);
      const result = await exportScene(scene, OUTPUT, { mediaRoot });
      assert.deepEqual(scene, before, `${definition.label} export does not mutate its scene`);
      expectRasterWarning(result, { id: `layer-${definition.key}`, name: definition.label, effect: definition.label });

      const animation = parseAnimation(result);
      assert.equal(animation.op, 2, "1 second at 2 fps serializes two frames");
      const sequence = sequenceFor(animation, definition.label);
      const frames = imageFrames(sequence);
      assertIntervals(frames);
      const embedded = [];
      for (const frame of frames) embedded.push(await assertEmbeddedPng(sequence.assets, frame, { density: 3 }));
      if (definition.key === "lut") {
        // The inverting LUT turns the red fill (#E63946) into #19C6B9 in the embedded frames.
        const { pixels, bitmap } = embedded[0];
        const centre = ((bitmap.height >> 1) * bitmap.width + (bitmap.width >> 1)) * 4;
        const rgb = [...pixels.slice(centre, centre + 3)];
        const expected = [0x19, 0xC6, 0xB9];
        assert.ok(rgb.every((value, channel) => Math.abs(value - expected[channel]) <= 2), `the LUT inverts the red fill to ${expected}, got ${rgb}`);
      }
    }
  } finally {
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

test("an effect preset and both backdrop styles export with named raster warnings", async () => {
  assert.equal(Object.keys(EFFECT_PRESET_DEFINITIONS).length, 7);
  for (const preset of SAMPLE_PRESETS) {
    const layer = createLayer("rectangle", {
      id: `preset-${preset.id}`,
      name: preset.name,
      x: 12, y: 9, width: 20, height: 16, fill: "#2787D8",
      animations: [presetOperation(preset.id)],
    });
    const scene = makeScene(layer, { id: `scene-preset-${preset.id}` });
    const before = structuredClone(scene);
    const result = await exportScene(scene, OUTPUT);
    assert.deepEqual(scene, before, `${preset.name} export does not mutate its scene`);
    expectRasterWarning(result, { id: layer.id, name: preset.name, effect: preset.name });
    const sequence = sequenceFor(parseAnimation(result), preset.name);
    assertIntervals(imageFrames(sequence));
    await assertEmbeddedPng(sequence.assets, imageFrames(sequence)[0], { density: 3 });
  }

  for (const [key, label] of [["backgroundBlur", "Background Blur"], ["glass", "Glass"]]) {
    const backdrop = createLayer("rectangle", {
      id: `${key}-target`, name: label, x: 8, y: 7, width: 30, height: 20,
      fill: "#E8EEF4", [key]: { enabled: true },
    });
    const scene = makeScene(backdrop, {
      id: `scene-${key}`,
      layers: [
        createLayer("rectangle", { id: `${key}-below`, x: 3, y: 4, width: 42, height: 28, fill: "#1557A0" }),
        backdrop,
      ],
    });
    const before = structuredClone(scene);
    const result = await exportScene(scene, OUTPUT);
    assert.deepEqual(scene, before, `${label} export does not mutate its scene`);
    expectRasterWarning(result, { id: backdrop.id, name: label, effect: label });
    const sequence = sequenceFor(parseAnimation(result), label);
    assertIntervals(imageFrames(sequence));
    await assertEmbeddedPng(sequence.assets, imageFrames(sequence)[0], { density: 3 });
  }
});

test("disabled effects preserve legacy Lottie structure and equal-color Duotone uses native Fill", async () => {
  const plain = createLayer("rectangle", {
    id: "same-layer", name: "Hero", x: 12, y: 9, width: 20, height: 16, fill: "#E63946",
  });
  const disabled = createLayer("rectangle", {
    ...structuredClone(plain),
    animations: [effectOperation("ripple", { enabled: false })],
  });
  const plainScene = makeScene(plain, { id: "plain-scene" });
  const disabledScene = makeScene(disabled, { id: "disabled-scene" });
  const plainBefore = structuredClone(plainScene), disabledBefore = structuredClone(disabledScene);
  const plainResult = await exportScene(plainScene, OUTPUT);
  const disabledResult = await exportScene(disabledScene, OUTPUT);
  assert.deepEqual(plainScene, plainBefore);
  assert.deepEqual(disabledScene, disabledBefore);
  assert.deepEqual(parseAnimation(disabledResult), parseAnimation(plainResult), "disabled effects add no Lottie structure or warnings");
  assert.equal(Boolean(disabledResult.warnings?.some((warning) => warning.code === "lottie-effect-rasterized")), false);

  const duotone = effectOperation("duotone", {
    id: "equal-duotone",
    parameters: { ...effectDefaults("duotone"), shadowColor: "#337755", highlightColor: "#337755" },
  });
  const exactScene = makeScene(createLayer("rectangle", {
    id: "native-duotone", name: "Equal Duotone", x: 8, y: 8, width: 28, height: 20,
    fill: "#D95F38", strokeWidth: 0, animations: [duotone],
  }), { id: "native-duotone-scene" });
  const before = structuredClone(exactScene);
  const exactResult = await exportScene(exactScene, OUTPUT);
  const exactAnimation = parseAnimation(exactResult);
  assert.deepEqual(exactScene, before);
  assert.equal(Boolean(exactResult.warnings?.some((warning) => warning.code === "lottie-effect-rasterized")), false);
  const nativeFill = lottieLayers(exactAnimation).flatMap((layer) => layer.ef ?? []).find((effect) => effect.ty === 21);
  assert.ok(nativeFill, "equal-color Duotone maps to native Lottie Fill effect 21");
  assert.equal(nativeFill.nm, "Duotone (equal colors)");
  assert.equal(nativeFill.ef.length, 7, "native Fill carries its complete Lottie parameter field list");
  assert.deepEqual(nativeFill.ef.slice(0, 2).map((field) => field.v.k), [0, 0]);
  assert.deepEqual(nativeFill.ef.slice(3, 6).map((field) => field.v.k), [0, 0, 0]);
  assert.equal(nativeFill.ef[6].v.k, 1, "native Fill keeps full opacity");
  const color = nativeFill.ef[2].v.k;
  assert.ok(Math.abs(color[0] - 0x33 / 255) < 1e-8);
  assert.ok(Math.abs(color[1] - 0x77 / 255) < 1e-8);
  assert.ok(Math.abs(color[2] - 0x55 / 255) < 1e-8);
});
