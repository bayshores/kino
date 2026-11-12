import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFECTS,
  EFFECT_GROUPS,
  KEEP_STILL,
  effectDefaults,
  effectDefinition,
  effectDocumentation,
  effectInitialValues,
  effectMediaSources,
  normalizeEffectParameters,
  unchangedAtOneWords,
} from "./catalog.js";
import { IDENTITY_CURVE } from "./colorMath.js";
import { createEffectAnimation, effectsAt } from "./animation.js";

// The lut effect needs the src of an imported .cube file; every other default is complete.
const LUT_SOURCE = "/api/media/0a1b2c3d-0000-4000-8000-000000000001.cube";
const completeDefaults = (key) => ({ ...effectDefaults(key), ...(key === "lut" ? { lut: LUT_SOURCE } : {}) });

const registry = [
  ["bulge", "Bulge", "Distortion", "value", { amount: ["number", 1, -2, 2, 0.05, "", 0] }],
  ["displacement", "Displacement", "Distortion", "value", {
    amplitude: ["number", 10, -128, 128, 1, "px", 0],
    offset: ["number", 1, -1000, 1000, 0.05, "cycles"],
    repeat: ["number", 1, 0.25, 32, 0.1, ""],
    direction: ["enum", "horizontal", [["horizontal", "Horizontal"], ["vertical", "Vertical"], ["both", "Both"]]],
  }],
  ["fluid-warp", "Fluid Warp", "Distortion", "ranged", {
    amount: ["number", 10, 0, 128, 1, "px"],
    noiseScale: ["number", 1, 0.1, 16, 0.05, ""],
    octaves: ["number", 2, 1, 8, 1, "", undefined, true],
    speed: ["number", 1, -4, 4, 0.05, "cycles/s"],
    contain: ["boolean", false],
    seed: ["number", 0, 0, 1_000_000, 1, "", undefined, true],
  }],
  ["fluted-glass", "Fluted Glass", "Distortion", "ranged", {
    columns: ["number", 12, 1, 128, 1, "", undefined, true],
    strength: ["number", 0.45, 0, 1, 0.01, ""],
    glowStrength: ["number", 0.01, 0, 1, 0.01, ""],
    glowWidth: ["number", 0.4, 0.01, 2, 0.01, ""],
  }],
  ["noise-warp", "Noise Warp", "Distortion", "ranged", {
    amount: ["number", 26, 0, 128, 1, "px"],
    noiseScale: ["number", 1, 0.1, 16, 0.05, ""],
    speed: ["number", 1, -4, 4, 0.05, "cycles/s"],
    contain: ["boolean", true],
    seed: ["number", 0, 0, 1_000_000, 1, "", undefined, true],
  }],
  ["ripple", "Ripple", "Distortion", "ranged", {
    speed: ["number", 0.6, -4, 4, 0.05, "cycles/s"],
    strength: ["number", 0.03, 0, 0.5, 0.01, ""],
    frequency: ["number", 6, 0.1, 32, 0.1, ""],
    centerX: ["number", 0.5, 0, 1, 0.01, ""],
    centerY: ["number", 0.5, 0, 1, 0.01, ""],
    falloff: ["number", 1.2, 0, 8, 0.1, ""],
    sharpness: ["number", 1, 1, 16, 0.1, ""],
  }],
];

function compactField(field) {
  if (field.type === "number") return [field.type, field.default, field.min, field.max, field.step, field.unit, field.neutral, field.integer];
  if (field.type === "enum") return [field.type, field.default, field.options];
  return [field.type, field.default];
}

test("the registry order, labels, groups, kinds, renderers, defaults and parameter bounds are stable", () => {
  assert.deepEqual(EFFECT_GROUPS, ["Distortion", "Post FX", "Utility", "Color", "Blur", "Light", "Generate"]);
  assert.deepEqual(KEEP_STILL, [["off", "Off"], ["start", "At start"], ["end", "At end"], ["both", "Both"]]);
  // Edge fill, mirror, kaleidoscope (engine/effects/edges.test.js) and field (field.test.js) follow the warps.
  assert.deepEqual(EFFECTS.filter(({ group }) => group === "Distortion").map(({ key }) => key),
    [...registry.map(([key]) => key), "edge-fill", "mirror", "kaleidoscope", "field"]);

  for (const [index, [key, label, group, kind, parameters]] of registry.entries()) {
    const effect = EFFECTS[index];
    assert.strictEqual(effectDefinition(key), effect);
    assert.deepEqual([effect.label, effect.group, effect.kind], [label, group, kind]);
    assert.equal(typeof effect.render, "function", `${key} has a renderer`);
    assert.equal(effect.duration, kind === "value" ? 0.8 : null);
    assert.equal(effect.easing, "linear");
    const expected = Object.fromEntries(Object.entries(parameters).map(([name, values]) => [name,
      values[0] === "number"
        ? [values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7]]
        : values[0] === "enum" ? [values[0], values[1], values[2]] : [values[0], values[1]],
    ]));
    const actual = Object.fromEntries(Object.entries(effect.parameters).filter(([name]) => name !== "mix").map(([name, field]) => [name, compactField(field)]));
    assert.deepEqual(actual, expected, `${key} controls`);
    // Optional settings (seeds added later) are stored only when given.
    assert.deepEqual(effectDefaults(key), Object.fromEntries(Object.entries(parameters)
      .filter(([name]) => !effect.parameters[name].optional).map(([name, values]) => [name, values[1]])));
  }
  assert.deepEqual(effectDefaults("bulge", { neutral: true }), { amount: 0 });
  assert.throws(() => effectDefinition("invented"), /Unknown effect/);
});

test("effect parameter input rejects unknown keys, wrong types, non-finite values and invalid bounds or enums", () => {
  assert.throws(() => normalizeEffectParameters("bulge", { unknown: 1 }), /not a parameter/);
  assert.throws(() => normalizeEffectParameters("bulge", { amount: "1" }), /must be a number/);
  assert.throws(() => normalizeEffectParameters("bulge", { amount: Number.NaN }), /must be a number/);
  assert.throws(() => normalizeEffectParameters("bulge", { amount: 2.01 }), /from -2 to 2/);
  assert.throws(() => normalizeEffectParameters("fluid-warp", { octaves: 2.5 }), /must be an integer/);
  assert.throws(() => normalizeEffectParameters("fluid-warp", { contain: 1 }), /must be true or false/);
  assert.throws(() => normalizeEffectParameters("displacement", { direction: "diagonal" }), /horizontal, vertical, both/);
  assert.throws(() => normalizeEffectParameters("ripple", { frequency: Infinity }), /must be a number/);
  assert.deepEqual(normalizeEffectParameters("bulge", { amount: 0.25 }, { partial: true }), { amount: 0.25 });
});

test("settings where 1 is unchanged take a clear relative text, say so when refused, and plain numbers stay as given", () => {
  const partial = { partial: true };
  assert.deepEqual(normalizeEffectParameters("hue-saturation", { saturation: "-0.7" }, partial), { saturation: 0.3 });
  assert.deepEqual(normalizeEffectParameters("hue-saturation", { saturation: "+0.5" }, partial), { saturation: 1.5 });
  assert.deepEqual(normalizeEffectParameters("color-grade", { exposure: "+0.5 stop" }, partial), { stops: 0.5 });
  assert.deepEqual(normalizeEffectParameters("color-grade", { exposure: 0.5 }, partial), { exposure: 0.5 });
  assert.throws(() => normalizeEffectParameters("hue-saturation", { saturation: -0.7 }), /from 0 to 4 where 1 is unchanged/);
  assert.throws(() => normalizeEffectParameters("hue-saturation", { saturation: "much" }), /where 1 is unchanged/);
  assert.match(effectDocumentation({ keys: ["color-grade"] }), /exposure [^;]*\(1 = unchanged\)/);
  assert.equal(unchangedAtOneWords("exposure", 0.5), "half as bright");
  assert.equal(unchangedAtOneWords("saturation", 0), "gray, no color");
});

test("generated effect documentation reflects every registered effect and its parameter limits", () => {
  const documentation = effectDocumentation();
  for (const [key, label, _group, kind, parameters] of registry) {
    assert.ok(documentation.includes(`${key} (${label}; ${kind}):`), `${key} appears in generated documentation`);
    const effect = effectDefinition(key);
    for (const [name, field] of Object.entries(effect.parameters)) {
      if (name === "mix") continue; // said once in the guide (MIX_DOCUMENTATION)
      assert.ok(documentation.includes(`${name} ${field.type}`), `${key}.${name} type appears`);
      assert.ok(documentation.includes(`default ${JSON.stringify(field.default)}`), `${key}.${name} default appears`);
      if (field.type === "number") assert.ok(documentation.includes(`${field.min}..${field.max}`), `${key}.${name} limits appear`);
      if (field.type === "enum")
        for (const [option] of field.options) assert.ok(documentation.includes(option), `${key}.${name} option ${option} appears`);
    }
  }
  assert.deepEqual(effectInitialValues("bulge"), {});
});

test("Post FX uses the observed catalog order, starting values and typed color inputs", () => {
  assert.deepEqual(EFFECTS.filter(({ group }) => group === "Post FX").map(({ key }) => key), [
    "dithering", "dot-grid", "duotone", "luma-highlight", "noise-mask", "pixelate", "threshold-color", "tritone", "rgb-shift", "edge-lines", "grain", "vignette", "speed-lines", "impact-lines", "film-burn",
  ]);
  assert.deepEqual(effectInitialValues("luma-highlight"), { lumaThreshold: 0, fuzzWidth: 0.2, fuzzIntensity: 0.5 });
  assert.deepEqual(effectInitialValues("noise-mask"), { threshold: 1 });
  assert.deepEqual(effectInitialValues("pixelate"), { pixelSize: 1 });
  assert.equal(effectDefaults("luma-highlight").lumaThreshold, 0.25);
  assert.equal(effectDefaults("luma-highlight").color, "#FFFFFF");
  assert.equal(effectDefaults("pixelate").pixelSize, 25);
  for (const key of ["luma-highlight", "noise-mask", "pixelate"]) assert.equal(effectDefinition(key).easing, "smooth");
  assert.equal(normalizeEffectParameters("duotone", { shadowColor: "#abc" }).shadowColor, "#AABBCC");
  assert.throws(() => normalizeEffectParameters("duotone", { shadowColor: "rgba(0,0,0,1)" }), /hex color/);
  // Duotone and tritone normalize to the layer's measured levels (helpers.levels) unless normalize
  // is false, and keep:"skin" draws them as a 3D LUT that leaves skin partly its own color.
  for (const key of ["duotone", "tritone"]) {
    const drawn = (parameters, levels) => {
      const defs = [];
      const output = effectDefinition(key).render({ content: "<rect/>", bounds: { x: 0, y: 0, width: 4, height: 4 },
        parameters: { ...effectDefaults(key), ...parameters }, time: 0, progress: 0, helpers: { id: (kind) => kind, defs, ...(levels ? { levels } : {}) } });
      return defs.join("") + output;
    };
    // A new effect stores normalize true; one saved before the field existed has none and draws
    // as it did, even with levels measured.
    const layer = { id: "l", type: "rectangle", animations: [] };
    const created = createEffectAnimation(key, layer, 0, { duration: 2 }, "a", {});
    assert.equal(created.to.normalize, true);
    assert.equal(effectDefaults(key).keep, "none");
    const saved = { ...created, to: Object.fromEntries(Object.entries(created.to).filter(([name]) => name !== "normalize")) };
    assert.equal(effectsAt({ ...layer, animations: [saved] }, 1)[0].parameters.normalize, undefined);
    const plain = drawn({ normalize: true }), stretched = drawn({ normalize: true }, [0.1, 0.6]);
    assert.notEqual(plain, stretched);
    assert.equal(drawn({ normalize: false }, [0.1, 0.6]), plain);
    assert.equal(drawn({}, [0.1, 0.6]), plain);
    assert.match(drawn({ normalize: true, keep: "skin" }, [0.1, 0.6]), /feComposite in="lut"/);
  }
  assert.throws(() => normalizeEffectParameters("pixelate", { pixelSizeStep: 0 }), /from 1 to 128/);
  assert.throws(() => normalizeEffectParameters("dithering", { subdivisions: 2049 }), /from 1 to 2048/);
  // Noise Mask's Cell Size: 0 (the default, and what older documents get) keeps Scale's cells.
  const cellSize = effectDefinition("noise-mask").parameters.cellSize;
  assert.deepEqual([cellSize.default, cellSize.min, cellSize.max, cellSize.integer, cellSize.unit], [0, 0, 64, true, "px"]);
  assert.equal(normalizeEffectParameters("noise-mask", { threshold: 0.4 }).cellSize, 0);
  assert.throws(() => normalizeEffectParameters("noise-mask", { cellSize: 65 }), /from 0 to 64/);
  for (const effect of EFFECTS) {
    assert.equal(typeof effect.render, "function");
    assert.deepEqual(normalizeEffectParameters(effect.key, completeDefaults(effect.key)), completeDefaults(effect.key));
    assert.ok(effectDocumentation().includes(`${effect.key} (${effect.label}; ${effect.kind}):`));
  }
});

test("the Color group lists the grading effects with neutral defaults, typed curves and a required LUT", () => {
  assert.deepEqual(EFFECTS.filter(({ group }) => group === "Color").map(({ key, kind }) => `${key}:${kind}`), [
    "invert:ranged", "curves:ranged", "lut:ranged", "hue-saturation:ranged", "white-balance:ranged", "color-wheels:ranged", "keep-color:ranged", "color-ranges:ranged", "color-look:ranged",
  ]);
  assert.deepEqual(effectDefaults("curves"), { master: IDENTITY_CURVE, red: IDENTITY_CURVE, green: IDENTITY_CURVE, blue: IDENTITY_CURVE, strength: 1 });
  assert.deepEqual(effectDefaults("hue-saturation"), { hue: 0, saturation: 1, lightness: 0, colorize: false, tint: "#C8935A" });
  assert.deepEqual(effectDefaults("white-balance"), { temperature: 0, tint: 0 });
  assert.deepEqual(effectDefaults("keep-color"), { targetColor: "#FF0000", hueRange: 25, softness: 15, amount: 1 });
  const ranges = effectDefaults("color-ranges");
  assert.equal(Object.keys(ranges).length, 26);
  assert.ok(Object.values(ranges).every((value) => value === 0));
  assert.deepEqual([ranges.redHue, ranges.aquaSaturation, ranges.magentaLightness, ranges.highlights, ranges.shadows], [0, 0, 0, 0, 0]);
  assert.throws(() => normalizeEffectParameters("color-ranges", { blueHue: 181 }), /from -180 to 180/);
  assert.deepEqual(effectDefaults("color-look"), { look: "matte", amount: 1 });
  const wheels = effectDefaults("color-wheels");
  assert.deepEqual([wheels.lift, wheels.gamma, wheels.gain, wheels.liftRed, wheels.gammaGreen, wheels.gainBlue], [0, 1, 1, 0, 0, 0]);
  // A hue cycle is an animation of hue, so its range allows ten turns either way.
  assert.deepEqual([effectDefinition("hue-saturation").parameters.hue.min, effectDefinition("hue-saturation").parameters.hue.max], [-3600, 3600]);

  // Curves: 2 to 16 [input, output] points from 0 to 1, inputs strictly increasing.
  const curve = [[0, 0.05], [0.5, 0.45], [1, 1]];
  assert.deepEqual(normalizeEffectParameters("curves", { master: curve }, { partial: true }), { master: curve });
  assert.throws(() => normalizeEffectParameters("curves", { master: [[0, 0]] }), /2 to 16 points/);
  assert.throws(() => normalizeEffectParameters("curves", { red: [[0, 0], [0, 1]] }), /increas/);
  assert.throws(() => normalizeEffectParameters("curves", { green: [[0, 0], [1, 1.2]] }), /0 to 1|from 0 to 1/);
  assert.throws(() => normalizeEffectParameters("curves", { blue: "s-curve" }), /points/);

  // The LUT is the src of an imported .cube file and has no default.
  assert.throws(() => normalizeEffectParameters("lut", {}), /required/);
  assert.throws(() => normalizeEffectParameters("lut", { lut: "/api/media/look.png" }), /\.cube/);
  assert.throws(() => normalizeEffectParameters("lut", { lut: "https://example.com/look.cube" }), /\.cube/);
  assert.deepEqual(normalizeEffectParameters("lut", { lut: LUT_SOURCE }), { lut: LUT_SOURCE, strength: 1 });
  assert.deepEqual(normalizeEffectParameters("lut", { strength: 0.5 }, { partial: true }), { strength: 0.5 });
  assert.deepEqual(effectMediaSources({ kind: "effect", effect: "lut", to: { lut: LUT_SOURCE, strength: 1 } }), [LUT_SOURCE]);
  assert.deepEqual(effectMediaSources({ kind: "effect", effect: "curves", to: completeDefaults("curves") }), []);

  const color = effectDocumentation({ group: "Color" });
  assert.ok(color.includes("lut (LUT; ranged):") && !color.includes("bulge"), color);
  assert.ok(!effectDocumentation({ exceptGroup: "Color" }).includes("keep-color"));
  const light = effectDocumentation({ group: "Light" });
  assert.ok(light.startsWith("glow (Glow; ranged):") && light.includes("lens-flare") && !light.includes("curves"), light);
  const rest = effectDocumentation({ exceptGroup: ["Color", "Light"] });
  assert.ok(!rest.includes("light-rays") && !rest.includes("keep-color") && rest.includes("bulge"));
});
