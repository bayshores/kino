import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { duplicateSceneInDocument } from "./sceneDuplication.js";
import { detachComponent, expandComponents } from "./linkedComponents.js";
import { copyLayers, pasteLayers } from "./layerClipboard.js";
import { applyOperations } from "./operations.js";
import { renderSceneSvg } from "./render.js";

function centerPixel(document, sceneId, time = 0) {
  const scene = expandComponents(document, sceneId);
  const image = new Resvg(renderSceneSvg(scene, time), { font: { loadSystemFonts: false } }).render();
  const offset = (4 * scene.width + 4) * 4;
  return [...image.pixels.subarray(offset, offset + 4)];
}

test("a duplicated component paints a translucent scene background only once", () => {
  const source = createScene({ id: "translucent-component", width: 8, height: 8,
    isComponent: true, background: "#ff000080", backgroundEnabled: true, layers: [] });
  const document = createDocument({ scenes: [source] });
  const result = duplicateSceneInDocument(document, source.id);
  const original = centerPixel(result.document, source.id);
  assert.equal(original[3], 128);
  assert.deepEqual(centerPixel(result.document, result.sceneId), original);
});

test("a duplicated component paints animated translucent background colors only once", () => {
  const source = createScene({ id: "animated-component", width: 8, height: 8, duration: 2,
    isComponent: true, background: "#ff000040", backgroundEnabled: true, layers: [],
    backgroundAnimations: [{ id: "translucent-color", name: "Color", kind: "custom", start: 0,
      duration: 1, easing: "linear", from: { fill: "#ff000040" }, to: { fill: "#ff000080" } }] });
  const result = duplicateSceneInDocument(createDocument({ scenes: [source] }), source.id);
  const copy = result.document.scenes.find((scene) => scene.id === result.sceneId);
  assert.equal(copy.backgroundEnabled, true);
  assert.notEqual(copy.backgroundAnimations[0].id, source.backgroundAnimations[0].id);
  for (const time of [0, 0.5, 1]) {
    const original = centerPixel(result.document, source.id, time);
    assert.ok(original[3] >= 64 && original[3] <= 128);
    assert.deepEqual(centerPixel(result.document, copy.id, time), original, `same paint at ${time}s`);
  }
});

test("a component scene copy keeps linked content but owns its background through save, paste and detach", () => {
  const source = createScene({ id: "linked-source", width: 8, height: 8, isComponent: true,
    background: "#ff000080", backgroundEnabled: true,
    layers: [createLayer("rectangle", { id: "source-content", x: 0, y: 0, width: 2, height: 2 })] });
  const result = duplicateSceneInDocument(createDocument({ scenes: [source] }), source.id);
  const saved = parseDocument(JSON.stringify(result.document));
  const copy = saved.scenes.find((scene) => scene.id === result.sceneId);
  const instance = copy.layers[0];
  assert.equal(instance.componentSceneId, source.id);
  assert.equal(instance.componentBackgroundEnabled, false);
  saved.scenes[0].background = "#0000ff";
  saved.scenes[0].layers[0].fill = "#00ff00";
  const drawn = expandComponents(saved, copy.id);
  assert.equal(drawn.layers.find((layer) => layer.componentBackground).fillEnabled, false);
  assert.equal(drawn.layers.find((layer) => layer.componentPath === "source-content").fill, "#00ff00");
  assert.equal(centerPixel(saved, copy.id)[3], 128);
  const pasted = pasteLayers(saved, copy.id, copyLayers(saved, copy.id, [instance.id]));
  const pastedInstance = pasted.document.scenes.find((scene) => scene.id === copy.id).layers.find((layer) => pasted.rootIds.includes(layer.id));
  assert.equal(pastedInstance.componentBackgroundEnabled, false);
  assert.equal(centerPixel(pasted.document, copy.id)[3], 128);
  const detached = parseDocument(detachComponent(saved, copy.id, instance.id));
  const detachedCopy = detached.scenes.find((scene) => scene.id === copy.id);
  assert.ok(detachedCopy.layers.every((layer) => !Object.hasOwn(layer, "componentBackgroundEnabled")));
  assert.equal(centerPixel(detached, copy.id)[3], 128);
});

test("component source-background suppression is a validated boolean that operations preserve", () => {
  const source = createScene({ id: "source", isComponent: true });
  const target = createScene({ id: "target", layers: [createLayer("component", { id: "instance", componentSceneId: source.id })] });
  const document = parseDocument(createDocument({ scenes: [source, target] }));
  assert.equal(document.scenes[1].layers[0].componentBackgroundEnabled, true);
  const hidden = applyOperations(document, [{ type: "update_layer", sceneId: target.id, layerId: "instance", properties: { componentBackgroundEnabled: false } }]);
  assert.equal(expandComponents(hidden, target.id).layers.find((layer) => layer.componentBackground).fillEnabled, false);
  assert.equal(expandComponents(document, target.id).layers.find((layer) => layer.componentBackground).fillEnabled, true);
  for (const value of ["false", 0, null]) {
    const invalid = structuredClone(document);
    invalid.scenes[1].layers[0].componentBackgroundEnabled = value;
    assert.throws(() => parseDocument(invalid), /componentBackgroundEnabled.*true or false/);
  }
  const legacy = structuredClone(document);
  delete legacy.scenes[1].layers[0].componentBackgroundEnabled;
  assert.equal(parseDocument(legacy).scenes[1].layers[0].componentBackgroundEnabled, true);
  legacy.scenes[1].layers = [createLayer("rectangle", { componentBackgroundEnabled: false })];
  assert.throws(() => parseDocument(legacy), /componentBackgroundEnabled.*only a component instance/);
});

test("scene copies retain background paints, Fill state and independent animation IDs", () => {
  const background = { type: "radial", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#0000ff" }] };
  const backgroundAnimations = [{ id: "source-color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ffffff" }, to: { fill: background } }];
  for (const isComponent of [false, true]) {
    const source = createScene({ background, backgroundEnabled: false, backgroundAnimations, isComponent,
      layers: [createLayer("rectangle", { id: "source-rectangle" })] });
    const document = createDocument({ scenes: [source] }), before = structuredClone(document);
    const result = duplicateSceneInDocument(document, source.id);
    const copy = result.document.scenes.find((scene) => scene.id === result.sceneId);
    assert.deepEqual(copy.background, background);
    assert.equal(copy.backgroundEnabled, false);
    assert.notEqual(copy.backgroundAnimations[0].id, "source-color");
    assert.notEqual(copy.backgroundAnimations[0].to.fill, source.backgroundAnimations[0].to.fill);
    assert.deepEqual(document, before);
    if (isComponent) assert.equal(copy.layers[0].componentSceneId, source.id);
    else assert.notEqual(copy.layers[0].id, source.layers[0].id);
  }
});

test("scene copies validate their complete result before they can be committed", () => {
  const document = createDocument();
  assert.throws(() => duplicateSceneInDocument(document, "missing"), /was not found/);
  document.scenes[0].backgroundEnabled = "false";
  const before = structuredClone(document);
  assert.throws(() => duplicateSceneInDocument(document, document.scenes[0].id), /backgroundEnabled/);
  assert.deepEqual(document, before);
});
