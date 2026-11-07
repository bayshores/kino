import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "../engine/animation.js";
import { flattenAnimations, mapAnimationTree } from "../engine/animationTree.js";
import { createLayer, createScene } from "../engine/model.js";
import { textAnimationPlan, textAnimationUnitState } from "../engine/textAnimation.js";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { ffmpeg, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const fonts = await loadBundledFonts();

function operation(id, start, duration, from, to, extra = {}) {
  return {
    id, name: id, kind: "custom", start, duration, easing: "linear", from, to,
    unit: "layer", stagger: 0, order: "forward", ...extra,
  };
}

function group(id, start, animations, enabled = true) {
  return { id, name: id, kind: "composed", start, ...(enabled ? {} : { enabled: false }), animations };
}

/** Replace one remembered From with the prior enabled operations' sampled raw property values. */
function withResolvedFrom(scene, layerId, animationId, options = {}) {
  return {
    ...scene,
    layers: scene.layers.map((layer) => {
      if (layer.id !== layerId) return layer;
      const operations = flattenAnimations(layer.animations, { enabledOnly: true });
      const index = operations.findIndex((animation) => animation.id === animationId);
      assert.notEqual(index, -1, `${animationId} exists in the enabled animation tree`);
      const target = operations[index];
      const before = { ...layer, animations: operations.slice(0, index) };
      const initial = evaluateLayer(before, target.start, { ...options, fonts });
      const keys = new Set([...Object.keys(target.from ?? {}), ...Object.keys(target.to ?? {})]);
      const from = Object.fromEntries([...keys].map((key) => [
        key,
        initial[key] === undefined ? target.from?.[key] : initial[key],
      ]));
      return {
        ...layer,
        animations: mapAnimationTree(layer.animations, (animation) => animation.id === animationId
          ? { ...animation, fromCurrent: false, from }
          : animation),
      };
    }),
  };
}

function shadowScene() {
  const baseShadow = { color: "#ff0000", x: 0, y: 0, blur: 0 };
  const prior = group("prior-group", 0, [
    operation("move", 0, 1, { x: 10, y: 10 }, { x: 40, y: 25 }),
    operation("shadow-color", 0, 0.8, { shadow: baseShadow },
      { shadow: { ...baseShadow, color: "#0000ff" } }, { shadowChannels: ["color"] }),
    operation("shadow-y-blur", 0.2, 0.8, { shadow: baseShadow },
      { shadow: { ...baseShadow, y: 10, blur: 8 } }, { shadowChannels: ["y", "blur"] }),
    operation("reveal-prior", 0, 0.4,
      { reveal: { direction: "right", softness: 0, progress: 0 } },
      { reveal: { direction: "right", softness: 0, progress: 0.1 } }),
  ]);
  const automatic = operation("continued-move-shadow", 0.1, 0.6,
    { x: -200, y: -100, opacity: 0, shadow: { color: "#00ff00", x: -50, y: -80, blur: 0 },
      reveal: { direction: "right", softness: 0, progress: 0.7 } },
    { x: 60, y: 35, opacity: 0.45, shadow: { color: "#ffff00", x: 24, y: 55, blur: 20 },
      reveal: { direction: "right", softness: 0, progress: 1 } },
    { fromCurrent: true, shadowChannels: ["x"], easing: "overshoot", intensity: 100 });
  const disabled = group("disabled-prior-group", 0, [
    operation("disabled-move", 0, 1, { x: 10, y: 10 }, { x: 500, y: 500 }),
  ], false);
  const layer = createLayer("rectangle", {
    id: "box", name: "Box", x: 10, y: 10, width: 24, height: 24,
    fill: "#ffffff", strokeWidth: 0, shadow: baseShadow,
    animations: [prior, disabled, group("continued-group", 0.2, [
      group("continued-nested", 0.1, [automatic]),
    ])],
  });
  return createScene({ id: "initial-shadow", name: "Initial shadow", width: 120, height: 100,
    duration: 1.2, background: "#ffffff", layers: [layer] });
}

function textScene() {
  const layer = createLayer("text", {
    id: "letters", name: "Letters", x: 12, y: 20, width: 100, height: 36,
    text: "ABC", fontFamily: "Inter", fontSize: 28, textResize: "width-height", fill: "#111111",
    animations: [
      group("text-prior-group", 0, [operation("text-prior-opacity", 0, 0.2,
        { opacity: 1 }, { opacity: 0.4 })]),
      group("text-clipped-move-group", 0, [operation("text-clipped-move", 0, 0.2,
        { x: 12 }, { x: 40 }, { textAnchor: "layer", textClip: true })]),
      group("text-target-group", 0.1, [group("text-target-nested", 0.1, [
        operation("letter-opacity", 0.1, 0.6, { x: -100, opacity: 0 }, { x: 70, opacity: 1 }, {
          fromCurrent: true, unit: "letters", stagger: 0.15, textAnchor: "letters",
        }),
      ])]),
    ],
  });
  return createScene({ id: "initial-text", name: "Initial text", width: 140, height: 80,
    duration: 1.2, background: "#ffffff", layers: [layer] });
}

async function assertPngMatchesAutomaticAndExplicit(automatic, explicit, times) {
  for (const time of times) {
    const options = { format: "png", time, width: automatic.width, height: automatic.height };
    const [actual, expected] = await Promise.all([
      exportScene(automatic, options, { fonts }), exportScene(explicit, options, { fonts }),
    ]);
    const [left, right] = await Promise.all([readImage(actual.buffer), readImage(expected.buffer)]);
    assert.deepEqual([left.width, left.height], [right.width, right.height]);
    for (let y = 0; y < left.height; y += 1) for (let x = 0; x < left.width; x += 1)
      assert.deepEqual(left.pixel(x, y), right.pixel(x, y), `PNG (${x},${y}) at ${time}s`);
  }
}

async function assertPngsDiffer(leftScene, rightScene, time) {
  const options = { format: "png", time, width: leftScene.width, height: leftScene.height };
  const [leftExport, rightExport] = await Promise.all([
    exportScene(leftScene, options, { fonts }), exportScene(rightScene, options, { fonts }),
  ]);
  const [left, right] = await Promise.all([readImage(leftExport.buffer), readImage(rightExport.buffer)]);
  let differentPixels = 0;
  for (let y = 0; y < left.height; y += 1) for (let x = 0; x < left.width; x += 1)
    if (left.pixel(x, y).some((channel, index) => channel !== right.pixel(x, y)[index])) differentPixels += 1;
  assert.ok(differentPixels > 0, `the legacy From remains visible in the exported pixels at ${time}s`);
}

function allLottieLayers(animation) {
  const assets = new Map((animation.assets ?? []).filter((asset) => Array.isArray(asset.layers)).map((asset) => [asset.id, asset]));
  const seen = new Set();
  const result = [];
  const visit = (layers) => {
    for (const layer of layers ?? []) {
      result.push(layer);
      const asset = assets.get(layer.refId);
      if (asset && !seen.has(asset.id)) {
        seen.add(asset.id);
        visit(asset.layers);
      }
    }
  };
  visit(animation.layers);
  return result;
}

function atProperty(property, frame) {
  if (property.a !== 1) return property.k;
  let index = 0;
  while (index + 1 < property.k.length && property.k[index + 1].t <= frame) index += 1;
  const key = property.k[index], next = property.k[index + 1];
  if (!next || key.h) return key.s[0];
  const amount = (frame - key.t) / (next.t - key.t);
  return key.s[0] + (next.s[0] - key.s[0]) * amount;
}

async function assertLottieMatchesAutomaticAndExplicit(automatic, explicit, options) {
  const [actual, expected] = await Promise.all([
    exportScene(automatic, { format: "lottie", ...options }, { fonts }),
    exportScene(explicit, { format: "lottie", ...options }, { fonts }),
  ]);
  const [left, right] = [actual, expected].map((result) => JSON.parse(result.buffer.toString("utf8")));
  assert.deepEqual(actual.warnings, expected.warnings);
  assert.deepEqual(left, right, "Lottie samples the same resolved initial values at every export frame");
  return left;
}

test("PNG and Lottie sample nested Move and overlapping partial Shadow channels at automatic From", async () => {
  const automatic = shadowScene();
  const remembered = structuredClone(automatic.layers[0].animations[2].animations[0].animations[0].from);
  const explicit = withResolvedFrom(automatic, "box", "continued-move-shadow");

  await assertPngMatchesAutomaticAndExplicit(automatic, explicit, [0.4, 0.45, 0.49, 0.55, 0.8, 1.1]);
  assert.equal(evaluateLayer(automatic.layers[0], 0.49).reveal.progress, 1,
    "the nested reveal reaches its full-box threshold during the overshoot turn");
  await assertLottieMatchesAutomaticAndExplicit(automatic, explicit,
    { fps: 10, duration: 1.2, width: 120, height: 100 });
  assert.deepEqual(automatic.layers[0].animations[2].animations[0].animations[0].from, remembered,
    "export sampling leaves the remembered From values intact");

  const legacyLayer = {
    ...automatic.layers[0],
    animations: mapAnimationTree(automatic.layers[0].animations, (animation) => {
      if (animation.id !== "continued-move-shadow") return animation;
      const { fromCurrent: _fromCurrent, ...legacyAnimation } = animation;
      return legacyAnimation;
    }),
  };
  const legacy = { ...automatic, layers: [legacyLayer] };
  const legacyStart = evaluateLayer(legacyLayer, 0.4);
  assert.deepEqual([legacyStart.x, legacyStart.y, legacyStart.opacity, legacyStart.shadow.x],
    [-200, -100, 0, -50], "without the flag, the custom operation still starts from its remembered values");
  await assertPngsDiffer(automatic, legacy, 0.65);
});

test("GIF frames preserve nested automatic From values", { skip: skipWithoutMediaTools }, async () => {
  const automatic = shadowScene();
  const explicit = withResolvedFrom(automatic, "box", "continued-move-shadow");
  const options = { format: "gif", fps: 4, width: 120, height: 100 };
  const actual = await exportScene(automatic, options, { fonts });
  const expected = await exportScene(explicit, options, { fonts });
  const decode = (buffer) => run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
    "-vf", "fps=4", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: buffer });
  const actualFrames = await decode(actual.buffer);
  const expectedFrames = await decode(expected.buffer);
  assert.ok(actualFrames.length > 0, "the GIF has decoded frames");
  assert.deepEqual(actualFrames, expectedFrames, "GIF frames match the manually resolved endpoints");
});

test("per-letter automatic From inside nested groups matches explicit per-unit sampling in PNG and Lottie", async () => {
  const automatic = textScene();
  const explicit = withResolvedFrom(automatic, "letters", "letter-opacity", { unit: "letters", unitIndex: 0, unitCount: 3 });
  const target = flattenAnimations(automatic.layers[0].animations, { enabledOnly: true })
    .find((animation) => animation.id === "letter-opacity");
  assert.ok(Math.abs(target.start - 0.3) < 1e-12, "relative Composed clocks resolve to the leaf's absolute start");
  const manualFrom = explicit.layers[0].animations[2].animations[0].animations[0].from;
  assert.deepEqual([manualFrom.x, manualFrom.opacity], [40, 0.4],
    "the manual From includes the earlier clipped Move and settled opacity at the grouped start");
  const plan = textAnimationPlan(automatic.layers[0], fonts);
  assert.deepEqual(plan.units.map((_, index) => Math.round(textAnimationUnitState(plan, index, 0.5).opacity * 1000) / 1000),
    [0.6, 0.45, 0.4], "PNG and Lottie share the current per-letter sample and keep the earlier clipped operation in history");

  await assertPngMatchesAutomaticAndExplicit(automatic, explicit, [0.31, 0.5, 0.67, 1.05]);
  const animation = await assertLottieMatchesAutomaticAndExplicit(automatic, explicit,
    { fps: 10, duration: 1.2, width: 140, height: 80 });
  const units = allLottieLayers(animation).filter((layer) => /^Letters [123]$/u.test(layer.nm ?? ""))
    .sort((left, right) => Number(left.nm.split(" ")[1]) - Number(right.nm.split(" ")[1]));
  assert.equal(units.length, 3, "Lottie retains one sampled outline layer per letter");
  const opacity = units.map((layer) => Math.round(atProperty(layer.ks.o, 5) * 1000) / 1000);
  assert.deepEqual(opacity, [60, 45, 40],
    "at 0.5 s, each letter uses its own staggered clock from the settled earlier opacity");
});
