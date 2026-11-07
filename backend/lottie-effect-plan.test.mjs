import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "../engine/model.js";
import { effectDefaults, EFFECTS } from "../engine/effects/catalog.js";
import { EFFECT_PRESET_DEFINITIONS } from "../engine/effects/presetCatalog.js";
import { planLottieEffects } from "./lottie-effect-plan.mjs";

function effectOperation(key, { id = `effect-${key}`, keepStill = "both", parameters = effectDefaults(key) } = {}) {
  const definition = EFFECTS.find((effect) => effect.key === key);
  return {
    id,
    name: definition.label,
    kind: "effect",
    effect: key,
    start: 0,
    duration: 1,
    easing: "linear",
    to: parameters,
    ...(definition.kind === "ranged" ? { keepStill } : {}),
  };
}

function presetOperation(id) {
  const preset = EFFECT_PRESET_DEFINITIONS[id];
  return {
    id: `preset-${id}`,
    name: preset.name,
    kind: "custom",
    start: 0,
    duration: preset.duration,
    easing: preset.easing,
    from: { effectPreset: { id, parameters: preset.parameters, progress: 0 } },
    to: { effectPreset: { id, parameters: preset.parameters, progress: 1 } },
  };
}

function duotone({ shadowColor = "#33AA66", highlightColor = shadowColor, keepStill = "both" } = {}) {
  return effectOperation("duotone", {
    id: `duotone-${keepStill}-${shadowColor}-${highlightColor}`,
    keepStill,
    parameters: { ...effectDefaults("duotone"), shadowColor, highlightColor },
  });
}

test("all effect catalog entries, presets, Background Blur, and Glass get labeled raster targets", () => {
  const expected = new Map();
  const layers = EFFECTS.map((effect) => {
    const id = `target-${effect.key}`;
    expected.set(id, [effect.label]);
    return createLayer("ellipse", { id, name: `${effect.label} row`, animations: [effectOperation(effect.key)] });
  });
  for (const preset of Object.values(EFFECT_PRESET_DEFINITIONS)) {
    const id = `target-preset-${preset.id}`;
    expected.set(id, [preset.name]);
    layers.push(createLayer("ellipse", { id, name: `${preset.name} row`, animations: [presetOperation(preset.id)] }));
  }
  for (const [id, name, key] of [
    ["target-background-blur", "Background Blur", "backgroundBlur"],
    ["target-glass", "Glass", "glass"],
  ]) {
    expected.set(id, [name]);
    layers.push(createLayer("ellipse", { id, name: `${name} row`, [key]: { enabled: true } }));
  }

  const plan = planLottieEffects(createScene({ layers }), [0, 0.5, 1]);
  assert.deepEqual(new Set(plan.targets.map(({ id }) => id)), new Set(expected.keys()));
  for (const [id, effects] of expected) {
    assert.deepEqual(plan.targets.find((target) => target.id === id)?.effects, effects, `target ${id} uses the F4 label`);
    assert.deepEqual(plan.descriptions.find((description) => description.id === id)?.effects, effects, `description ${id} keeps the warning label`);
  }
  assert.deepEqual(plan.coveredIds, new Set(expected.keys()));
});

test("hidden ancestors and disabled composed members do not create raster targets", () => {
  const hiddenGroup = createLayer("group", { id: "hidden-parent", visible: false });
  const hiddenEffect = createLayer("ellipse", {
    id: "hidden-effect",
    parentId: hiddenGroup.id,
    animations: [effectOperation("bulge")],
  });
  const disabledGroup = {
    id: "disabled-composed",
    name: "Disabled Composed",
    kind: "composed",
    start: 0,
    enabled: false,
    animations: [effectOperation("ripple", { id: "disabled-ripple" })],
  };
  const disabled = createLayer("ellipse", { id: "disabled-effect", animations: [disabledGroup] });
  const plan = planLottieEffects(createScene({ layers: [hiddenGroup, hiddenEffect, disabled] }), [0, 1]);
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.coveredIds, new Set());
  assert.deepEqual(plan.descriptions, []);
});

test("the outermost affected parent covers its full subtree, including unaffected children", () => {
  const parent = createLayer("group", {
    id: "outer",
    name: "Outer group",
    backgroundBlur: { enabled: true },
  });
  const child = createLayer("ellipse", {
    id: "inner-effect",
    parentId: parent.id,
    animations: [effectOperation("bulge")],
  });
  const nativeChild = createLayer("rectangle", {
    id: "native-fill-child",
    parentId: parent.id,
    animations: [duotone()],
  });
  const unaffected = createLayer("rectangle", { id: "unaffected-child", parentId: parent.id });
  const plan = planLottieEffects(createScene({ layers: [parent, child, nativeChild, unaffected] }), [0, 1]);
  assert.deepEqual(plan.targets.map(({ id }) => id), [parent.id]);
  assert.deepEqual(plan.coveredIds, new Set([parent.id, child.id, nativeChild.id, unaffected.id]));
  assert.equal(plan.nativeFills.has(nativeChild.id), false, "a native Fill child is covered when its parent is rasterized");
  assert.deepEqual(plan.descriptions.map(({ id }) => id), [parent.id, child.id, nativeChild.id]);
});

test("only an all-frame equal-color strokeless rectangle uses native Fill; Off, text, stroke, and general Duotone rasterize", () => {
  const native = createLayer("rectangle", { id: "native", animations: [duotone()] });
  const off = createLayer("rectangle", { id: "ranged-off", animations: [duotone({ keepStill: "off" })] });
  const text = createLayer("text", { id: "text-duotone", animations: [duotone()] });
  const stroke = createLayer("rectangle", { id: "stroked", strokeWidth: 2, animations: [duotone()] });
  const general = createLayer("rectangle", {
    id: "general-duotone",
    animations: [duotone({ highlightColor: "#FF1122" })],
  });
  const animatedStroke = createLayer("rectangle", {
    id: "animated-stroke",
    animations: [duotone(), {
      id: "stroke-width",
      name: "Stroke width",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { strokeWidth: 0 },
      to: { strokeWidth: 2 },
    }],
  });
  const plan = planLottieEffects(createScene({ layers: [native, off, text, stroke, general, animatedStroke] }), [0, 0.5, 1]);
  assert.deepEqual(plan.nativeFills.get("native"), ["#33AA66", "#33AA66", "#33AA66"]);
  assert.deepEqual(new Set(plan.nativeFills.keys()), new Set(["native"]));
  assert.deepEqual(new Set(plan.targets.map(({ id }) => id)), new Set([
    "ranged-off", "text-duotone", "stroked", "general-duotone", "animated-stroke",
  ]));
  assert.equal(plan.coveredIds.has("native"), false, "the native Fill layer is not included in the raster subtree");
});

test("Background Blur and Glass style animations keep their names in raster plan descriptions", () => {
  const blur = createLayer("rectangle", {
    id: "blur-style",
    animations: [{
      id: "blur-animation",
      name: "Blur style",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { backgroundBlur: { enabled: false, radius: 0, blend: 0 } },
      to: { backgroundBlur: { enabled: true, radius: 8, blend: 100 } },
    }],
  });
  const glass = createLayer("rectangle", {
    id: "glass-style",
    animations: [{
      id: "glass-animation",
      name: "Glass style",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { glass: { enabled: false } },
      to: { glass: { enabled: true, refraction: 30, blend: 100 } },
    }],
  });
  const plan = planLottieEffects(createScene({ layers: [blur, glass] }), [0, 1]);
  assert.deepEqual(plan.targets.map(({ id, effects }) => [id, effects]), [
    ["blur-style", ["Background Blur"]],
    ["glass-style", ["Glass"]],
  ]);
});
