import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "../model.js";
import { presetAnimation, evaluateLayer } from "../animation.js";
import { applyOperations } from "../operations.js";
import { renderSceneSvg } from "../render.js";
import { catalogEntries, patchPresetAnimation } from "../presetCatalog.js";
import { EFFECT_PRESET_DEFINITIONS, normalizeEffectPresetValue } from "./presetCatalog.js";

const card = () => createLayer("rectangle", { id: "card", x: 24, y: 20, width: 80, height: 60,
  fill: { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] } });
const scene = (layer) => createScene({ id: "main", width: 128, height: 96, duration: 4, background: "#00000000", layers: [layer] });
const document = (layer) => parseDocument(createDocument({ scenes: [scene(layer)] }));
const pixels = (layer, time) => new Resvg(renderSceneSvg(scene(layer), time, { raster: true })).render().pixels;

test("seven effect presets integrate with exact hidden and clean In/Out endpoints and deterministic midframes", () => {
  const original = pixels(card(), 0);
  for (const definition of Object.values(EFFECT_PRESET_DEFINITIONS)) for (const mode of ["in", "out"]) {
    const layer = card();
    const animation = presetAnimation(`preset-${definition.id}`, layer, 1, scene(layer), { mode });
    layer.animations = [animation];
    assert.equal(animation.duration, 1);
    assert.equal(animation.easing, definition.easing);
    assert.doesNotThrow(() => document(layer));
    const hidden = pixels(layer, mode === "in" ? 0 : 3);
    assert.ok(hidden.every((value) => value === 0), `${definition.id} ${mode} hidden endpoint`);
    assert.deepEqual(pixels(layer, mode === "in" ? 3 : 0), original, `${definition.id} ${mode} clean endpoint`);
    const middle = pixels(layer, 1.5);
    assert.notDeepEqual(middle, original, `${definition.id} changes the middle frame`);
    assert.deepEqual(pixels(layer, 1.5), middle);
    assert.deepEqual(pixels(parseDocument(JSON.parse(JSON.stringify(document(layer)))).scenes[0].layers[0], 1.5), middle);
  }
});

test("Mode retains effect fields and row timing, and a preset change resets them", () => {
  const layer = card();
  const changed = { ...presetAnimation("preset-film-roll", layer, 1, scene(layer)), id: "selected", duration: 2 };
  assert.equal(changed.easing, "natural");
  const out = patchPresetAnimation(changed, { preset: { mode: "out", parameters: { copies: 3 } } }, layer);
  assert.equal(out.kind, "out"); assert.equal(out.preset.parameters.copies, 3); assert.equal(out.easing, "natural");
  const back = patchPresetAnimation(out, { preset: { id: "dissolve" } }, layer);
  assert.equal(back.easing, "linear"); assert.equal(back.preset.parameters.scale, 10); assert.equal(back.preset.parameters.variant, 2);
  assert.equal(back.duration, 2); assert.equal(back.id, "selected");
});

test("MCP preset operations validate atomically and overlapping presets use the latest channel", () => {
  const source = document(card());
  const added = applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "card", preset: "preset-pixel-wipe", start: 1,
    parameters: { direction: "left", spread: 40 } }]);
  const animation = added.scenes[0].layers[0].animations[0];
  assert.equal(animation.preset.parameters.direction, "left");
  for (const preset of [{ id: "unknown" }, { parameters: { direction: "diagonal" } }, { parameters: { variant: 0.5 } }, { parameters: { scale: -1 } }])
    assert.throws(() => applyOperations(added, [{ type: "update_animation", sceneId: "main", layerId: "card", animationId: animation.id, properties: { preset } }]));
  assert.equal(source.scenes[0].layers[0].animations.length, 0);
  const later = applyOperations(added, [{ type: "add_animation", sceneId: "main", layerId: "card", preset: "preset-dissolve", start: 1.5 }]);
  assert.equal(evaluateLayer(later.scenes[0].layers[0], 1.75).effectPreset.id, "dissolve");
  assert.throws(() => normalizeEffectPresetValue({ id: "pixel", parameters: {}, progress: Infinity }), /progress/);
  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "card", preset: "preset-pixel", duration: 0 }]), /duration/);
  assert.deepEqual(catalogEntries(card()).filter((entry) => entry.group === "Effects" && entry.tab === "presets").map((entry) => entry.name),
    ["Dissolve", "Wipe", "Pixel", "Pixel Wipe", "Luma Reveal", "Blink", "Glitch", "Barrel", "Film Roll"]);
});

test("effect preset channels render with independently staggered text units and ordinary effects", () => {
  const text = createLayer("text", { id: "text", text: "AB", x: 8, y: 15, width: 110, height: 65, fontSize: 44, fill: "#ffffff" });
  const animation = presetAnimation("preset-dissolve", text, 0, scene(text));
  animation.unit = "letters"; animation.stagger = 0.4; animation.easing = "linear";
  text.animations = [animation];
  assert.doesNotThrow(() => document(text));
  const middle = pixels(text, 0.6), end = pixels(text, 2);
  assert.notDeepEqual(middle, end);
  assert.deepEqual(end, pixels({ ...text, animations: [] }, 2));
});
