import test from "node:test";
import assert from "node:assert/strict";
import { DOCUMENT_VERSION } from "./schema.js";
import { Resvg } from "@resvg/resvg-js";
import { boxStylePatch, effectiveBoxStyle } from "./boxStyles.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { evaluateLayer } from "./animation.js";
import { renderSceneSvg } from "./render.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { copyLayers, pasteLayers } from "./layerClipboard.js";
import { parseExportDocument } from "../backend/export-document.mjs";

const source = `data:image/png;base64,${new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path fill="blue" d="M0 0H10V10H0Z"/></svg>').render().asPng().toString("base64")}`;
const layer = (type, values = {}) => createLayer(type, { id: type, x: 20, y: 20, width: 60, height: 60, src: source, ...values });
const document = (layers) => createDocument({ scenes: [createScene({ id: "scene", width: 100, height: 100, backgroundEnabled: false, layers })] });
const pixels = (scene, time = 0) => new Resvg(renderSceneSvg(scene, time)).render().pixels;
const pixel = (data, x, y) => [...data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
const animation = (from, to) => ({ id: "style", name: "Style", kind: "custom", start: 0, duration: 1, easing: "linear", from, to });

test("version 3 preserves dormant media/group style data and pixels through repeated save/reopen", () => {
  const old = document([layer("group", { fill: "#00ff00", fillEnabled: true, stroke: "#ff0000", strokeWidth: 8, radius: 22, cornerRadii: [20, 0, 4, 18], clipContent: true }), layer("image", { parentId: "group", x: 0, y: 0, radius: 19, strokeWidth: 7 })]);
  old.version = 3;
  const before = structuredClone(old);
  before.scenes[0].layers[0] = { ...before.scenes[0].layers[0], fillEnabled: false, strokeWidth: 0, radius: 0, cornerRadii: null };
  before.scenes[0].layers[1] = { ...before.scenes[0].layers[1], strokeWidth: 0, radius: 0 };
  const migrated = parseDocument(old);
  assert.equal(migrated.version, DOCUMENT_VERSION);
  assert.equal(migrated.scenes[0].layers[0].strokeWidth, 8);
  assert.deepEqual(migrated.scenes[0].layers[0].cornerRadii, [20, 0, 4, 18]);
  assert.deepEqual(pixels(migrated.scenes[0]), pixels(before.scenes[0]));
  assert.deepEqual(parseDocument(JSON.stringify(migrated)), migrated);
  assert.equal(old.version, 3);
  assert.equal(old.scenes[0].layers[0].inactiveBoxStyles, undefined);
});

test("a style edit activates only that legacy style, including a uniform corner edit", () => {
  const old = parseDocument({ ...document([layer("group", { strokeWidth: 8, radius: 4, cornerRadii: [20, 0, 4, 18], fillEnabled: true })]), version: 3 });
  const next = applyOperations(old, [{ type: "update_layer", sceneId: "scene", layerId: "group", properties: { radius: 10 } }]);
  const changed = next.scenes[0].layers[0];
  assert.deepEqual(changed.inactiveBoxStyles, ["fill", "stroke"]);
  assert.equal(changed.cornerRadii, null);
  assert.equal(effectiveBoxStyle(changed).strokeWidth, 0);
  assert.equal(effectiveBoxStyle(changed).radius, 10);
  assert.deepEqual(boxStylePatch(changed, { x: 50 }), { x: 50 });
  const enabled = applyOperations(next, [{ type: "update_layer", sceneId: "scene", layerId: "group", properties: { fillEnabled: true } }]);
  assert.equal(effectiveBoxStyle(enabled.scenes[0].layers[0]).fillEnabled, true);
  assert.equal(createLayer("group").fillEnabled, false);
});

test("legacy group Color stays hidden and new media corner/stroke animations use effective rests", () => {
  const old = parseDocument({ ...document([layer("group", { fillEnabled: true, animations: [animation({ fill: "#ff0000" }, { fill: "#0000ff" })] })]), version: 3 });
  assert.equal(evaluateLayer(old.scenes[0].layers[0], 0.5).fillEnabled, false);
  const media = parseDocument({ ...document([layer("image", { radius: 30, strokeWidth: 12 })]), version: 3 });
  const edited = applyOperations(media, [{ type: "add_animation", sceneId: "scene", layerId: "image", animation: animation({}, { radius: 20, strokeWidth: 4 }) }]);
  const animated = edited.scenes[0].layers[0];
  assert.deepEqual(animated.animations[0].from, { radius: 0, strokeWidth: 0 });
  assert.equal(evaluateLayer(animated, 0.5).radius, 10);
  assert.equal(evaluateLayer(animated, 0.5).strokeWidth, 2);
});

test("image corners clip actual pixels; outside border survives beyond the content box", () => {
  const scene = document([layer("image", { cornerRadii: [20, 0, 0, 0], stroke: "#ff0000", strokeWidth: 4, strokeAlign: "outside" })]).scenes[0];
  const data = pixels(scene);
  assert.equal(pixel(data, 20, 20)[3], 0);
  assert.deepEqual(pixel(data, 60, 40), [0, 0, 255, 255]);
  assert.deepEqual(pixel(data, 81, 50), [255, 0, 0, 255]);
  assert.deepEqual(pixel(data, 78, 22), [0, 0, 255, 255]);
});

test("group fill sits behind children and rounded child clipping leaves the outside border visible", () => {
  const scene = document([layer("group", { fill: "#00ff00", fillEnabled: true, radius: 20, clipContent: true, stroke: "#ff0000", strokeWidth: 4, strokeAlign: "outside" }), layer("rectangle", { parentId: "group", x: -10, y: -10, width: 40, height: 50, fill: "#0000ff" })]).scenes[0];
  const data = pixels(scene);
  assert.equal(pixel(data, 20, 20)[3], 0);
  assert.deepEqual(pixel(data, 25, 45), [0, 0, 255, 255]);
  assert.deepEqual(pixel(data, 65, 45), [0, 255, 0, 255]);
  assert.deepEqual(pixel(data, 81, 50), [255, 0, 0, 255]);
  const svg = renderSceneSvg(document([layer("group")]).scenes[0], 0, { canvas: true });
  assert.doesNotMatch(svg, /pointer-events="visible/);
});

test("sibling group borders keep distinct gradient and mask definitions and pixels", () => {
  const gradient = (start, end) => ({ type: "linear", angle: 90, stops: [{ offset: 0, color: start }, { offset: 1, color: end }] });
  const left = layer("group", { id: "left", x: 10, width: 30, radius: 0, strokeWidth: 4, strokeAlign: "outside", stroke: gradient("#ff0000", "#ffff00") });
  const right = layer("group", { id: "right", x: 60, width: 30, radius: 14, strokeWidth: 4, strokeAlign: "outside", stroke: gradient("#00ff00", "#0000ff") });
  const scene = document([left, right]).scenes[0];
  for (const canvas of [false, true]) {
    const svg = renderSceneSvg(scene, 0, { canvas });
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, "each sibling owns its paint and mask definitions");
  }
  const together = pixels(scene);
  const separate = [pixels(document([left]).scenes[0]), pixels(document([right]).scenes[0])];
  for (let y = 0; y < 100; y += 1) for (let x = 0; x < 100; x += 1)
    assert.deepEqual(pixel(together, x, y), pixel(separate[x < 50 ? 0 : 1], x, y));
});

test("old component overrides stay discarded, while explicit style overrides activate an instance only", () => {
  const sourceScene = createScene({ id: "master", isComponent: true, layers: [layer("image", { radius: 12, strokeWidth: 6 })] });
  const instance = createComponentInstance(sourceScene, { id: "instance", componentOverrides: { image: { radius: 12, strokeWidth: 6, name: "Photo" } } });
  const old = parseDocument({ ...createDocument({ scenes: [sourceScene, createScene({ id: "scene", layers: [instance] })] }), version: 3 });
  assert.deepEqual(old.scenes[1].layers[0].componentOverrides, { image: { name: "Photo" } });
  const next = applyOperations(old, [{ type: "set_component_overrides", sceneId: "scene", layerId: "instance", overrides: { image: { radius: 12, strokeWidth: 6 } } }]);
  assert.equal(next.scenes[1].layers[0].componentOverrides.image.radius, 12);
  const drawn = expandComponents(next, "scene").layers.find((item) => item.componentPath === "image");
  assert.equal(effectiveBoxStyle(drawn).radius, 12);
  assert.equal(effectiveBoxStyle(drawn).strokeWidth, 6);
  assert.equal(effectiveBoxStyle(next.scenes[0].layers[0]).radius, 0);
});

test("component wrappers never paint their own generic box styles over the source background", () => {
  const sourceScene = createScene({ id: "master", isComponent: true, backgroundEnabled: false, width: 80, height: 80, layers: [layer("rectangle", { x: 20, y: 20, width: 20, height: 20, fill: "#ff0000" })] });
  const instance = createComponentInstance(sourceScene, { id: "instance", x: 0, y: 0, fillEnabled: true, fill: "#0000ff", strokeWidth: 10, radius: 30 });
  const doc = parseDocument(createDocument({ scenes: [sourceScene, createScene({ id: "scene", width: 100, height: 100, backgroundEnabled: false, layers: [instance] })] }));
  const drawn = expandComponents(doc, "scene");
  const data = pixels(drawn);
  assert.equal(pixel(data, 10, 10)[3], 0);
  assert.deepEqual(pixel(data, 25, 25), [255, 0, 0, 255]);
  assert.equal(effectiveBoxStyle(drawn.layers.find((item) => item.id === "instance")).strokeWidth, 0);
});

test("v3 clipboard and inferred v3 scene exports migrate rather than activating old styles", () => {
  const original = document([layer("image", { radius: 22, strokeWidth: 5 })]);
  const envelope = copyLayers(original, "scene", ["image"]);
  envelope.version = 3;
  const pasted = pasteLayers(document([]), "scene", envelope);
  assert.equal(effectiveBoxStyle(pasted.document.scenes[0].layers[0]).radius, 0);
  assert.equal(effectiveBoxStyle(parseExportDocument({ scene: original.scenes[0] }).scenes[0].layers[0]).radius, 0);
  assert.equal(effectiveBoxStyle(parseExportDocument({ scene: original.scenes[0], version: 4 }).scenes[0].layers[0]).radius, 22);
});

test("inactive style metadata is bounded and type checked", () => {
  for (const styles of [["nope"], ["stroke", "stroke"], "stroke", ["fill"]])
    assert.throws(() => parseDocument(document([layer("image", { inactiveBoxStyles: styles })])), /inactiveBoxStyles/);
});

test("inline artboards get separate clip/paint IDs and each URL resolves within its own SVG", () => {
  const scene = document([layer("image", { radius: 20, strokeWidth: 4, strokeAlign: "outside" })]).scenes[0];
  const a = renderSceneSvg(scene, 0, { canvas: true, idPrefix: ":r1:" });
  const b = renderSceneSvg(scene, 0, { canvas: true, idPrefix: "_r1_" });
  const ids = (svg) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const aIds = ids(a), bIds = ids(b);
  assert.ok(aIds.length > 0 && bIds.length > 0);
  assert.equal(aIds.some((id) => bIds.includes(id)), false);
  for (const svg of [a, b]) for (const match of svg.matchAll(/url\(#([^)]+)\)/g))
    assert.ok(ids(svg).includes(match[1]), "each clipping/matte reference belongs to this SVG");
  assert.deepEqual(new Resvg(a).render().pixels, new Resvg(b).render().pixels);
});
