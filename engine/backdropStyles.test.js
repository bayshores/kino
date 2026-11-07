import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKDROP_STYLE_DEFINITIONS,
  BACKDROP_STYLE_KEYS,
  defaultBackdropStyle,
  normalizeBackdropStyle,
} from "./backdropStyles.js";
import { presetAnimation, evaluateLayer } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { overridableKeys } from "./componentOverrides.js";
import { catalogEntries } from "./presetCatalog.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";

test("backdrop style definitions expose exact defaults, labels, and bounded controls", () => {
  assert.deepEqual(BACKDROP_STYLE_KEYS, ["backgroundBlur", "glass"]);
  assert.deepEqual(defaultBackdropStyle("backgroundBlur"), { enabled: false, radius: 4, blend: 20 });
  assert.deepEqual(defaultBackdropStyle("glass"), {
    enabled: false,
    refraction: 50,
    depth: 50,
    dispersion: 50,
    frost: 0,
    lightIntensity: 100,
    lightAngle: 0,
    blend: 0,
  });
  assert.deepEqual(BACKDROP_STYLE_DEFINITIONS.backgroundBlur.fields.map(({ key, min, max, suffix }) => [key, min, max, suffix]), [
    ["radius", 0, 100, "px"], ["blend", 0, 100, "%"],
  ]);
  assert.deepEqual(BACKDROP_STYLE_DEFINITIONS.glass.fields.map(({ key, min, max }) => [key, min, max]), [
    ["refraction", 0, 100], ["depth", 0, 100], ["dispersion", 0, 100], ["frost", 0, 100],
    ["lightIntensity", 0, 200], ["lightAngle", -360, 360], ["blend", 0, 100],
  ]);
});

test("partial style objects fill defaults without mutating their source", () => {
  const original = { radius: 18 };
  assert.deepEqual(normalizeBackdropStyle("backgroundBlur", original), {
    enabled: false, radius: 18, blend: 20,
  });
  assert.deepEqual(original, { radius: 18 });
  assert.deepEqual(normalizeBackdropStyle("glass", { enabled: true, lightAngle: -45 }), {
    ...defaultBackdropStyle("glass"), enabled: true, lightAngle: -45,
  });
});

test("unknown fields and invalid backdrop style values are refused", () => {
  for (const value of [null, [], "blur", { enabled: 1 }, { radius: NaN }, { blend: -1 }, { radius: 101 }, { surprise: 1 }]) {
    assert.throws(() => normalizeBackdropStyle("backgroundBlur", value));
  }
  for (const [key, value] of [["frost", -1], ["lightIntensity", 201], ["lightAngle", 361], ["dispersion", Infinity]]) {
    assert.throws(() => normalizeBackdropStyle("glass", { [key]: value }));
  }
  assert.throws(() => normalizeBackdropStyle("unknown", {}), /Unknown backdrop style/);
});

test("old layers remain absent while partial styles normalize and explicit null clears them", () => {
  const legacy = createLayer("rectangle", { id: "legacy" });
  const partial = createLayer("rectangle", { id: "partial", backgroundBlur: { radius: 12 }, glass: { enabled: true } });
  const cleared = createLayer("rectangle", { id: "cleared", backgroundBlur: null, glass: null });
  const parsed = parseDocument(createDocument({ scenes: [createScene({ id: "main", layers: [legacy, partial, cleared] })] }));
  const [oldLayer, partialLayer, clearedLayer] = parsed.scenes[0].layers;
  assert.equal(Object.hasOwn(oldLayer, "backgroundBlur"), false);
  assert.equal(Object.hasOwn(oldLayer, "glass"), false);
  assert.deepEqual(partialLayer.backgroundBlur, { enabled: false, radius: 12, blend: 20 });
  assert.deepEqual(partialLayer.glass, { ...defaultBackdropStyle("glass"), enabled: true });
  assert.equal(Object.hasOwn(clearedLayer, "backgroundBlur"), false);
  assert.equal(Object.hasOwn(clearedLayer, "glass"), false);
});

test("all drawn layer types accept backdrop styles and audio rejects them", () => {
  const source = createScene({ id: "source", isComponent: true, layers: [createLayer("rectangle", { id: "source-box" })] });
  const drawnTypes = ["rectangle", "ellipse", "star", "text", "image", "video", "path", "group", "component"];
  const layers = drawnTypes.map((type, index) => createLayer(type, {
    id: `layer-${index}`,
    ...(type === "component" ? { componentSceneId: "source" } : {}),
    backgroundBlur: { enabled: true },
    glass: { enabled: true },
  }));
  const parsed = parseDocument(createDocument({ scenes: [source, createScene({ id: "main", layers })] }));
  assert.deepEqual(parsed.scenes[1].layers.map((layer) => layer.type), drawnTypes);
  assert.ok(overridableKeys({ type: "rectangle" }).includes("backgroundBlur"));
  assert.ok(overridableKeys({ type: "component" }).includes("glass"));
  assert.ok(!overridableKeys({ type: "audio" }).includes("backgroundBlur"));
  assert.throws(() => parseDocument(createDocument({
    scenes: [createScene({ id: "audio", layers: [createLayer("audio", { backgroundBlur: { enabled: true } })] })],
  })), /audio layers cannot have backdrop styles/);
});

test("backdrop custom presets keep existing properties and interpolate typed endpoints", () => {
  const scene = createScene({ id: "main" });
  const layer = createLayer("rectangle", {
    id: "box",
    backgroundBlur: { enabled: false, radius: 16, blend: 35 },
    glass: { enabled: false, refraction: 31, depth: 70, dispersion: 12, frost: 8, lightIntensity: 145, lightAngle: -40, blend: 60 },
  });
  const blur = presetAnimation("background-blur", layer, 0, scene);
  const glass = presetAnimation("glass", layer, 0, scene);
  assert.deepEqual(blur.from.backgroundBlur, { enabled: true, radius: 0, blend: 35 });
  assert.deepEqual(blur.to.backgroundBlur, { enabled: true, radius: 16, blend: 35 });
  assert.deepEqual(glass.from.glass, { ...layer.glass, enabled: true, refraction: 0 });
  assert.deepEqual(glass.to.glass, { ...layer.glass, enabled: true });
  assert.ok(isAnimationCompatible(layer, blur));
  assert.ok(isAnimationCompatible(layer, glass));
  assert.ok(catalogEntries(layer).some((entry) => entry.id === "background-blur" && entry.name === "Background Blur" && entry.group === "Effects"));
  assert.ok(catalogEntries(layer).some((entry) => entry.id === "glass" && entry.name === "Glass" && entry.group === "Effects"));

  const animated = parseDocument(createDocument({ scenes: [createScene({ id: "main", layers: [
    { ...layer, animations: [blur] },
  ] })] })).scenes[0].layers[0];
  const middle = evaluateLayer(animated, blur.duration / 2).backgroundBlur;
  assert.equal(middle.enabled, true);
  assert.ok(middle.radius > 0 && middle.radius < 16);
  assert.equal(middle.blend, 35);
});

test("audio cannot create backdrop preset animations", () => {
  const audio = createLayer("audio", { id: "sound" });
  const scene = createScene({ id: "main" });
  assert.throws(() => presetAnimation("background-blur", audio, 0, scene), /requires a layer that is drawn/);
  assert.throws(() => presetAnimation("glass", audio, 0, scene), /requires a layer that is drawn/);
  assert.equal(isAnimationCompatible(audio, { from: { glass: defaultBackdropStyle("glass") }, to: { glass: defaultBackdropStyle("glass") } }), false);
});
