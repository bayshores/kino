import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { createComponentInstance } from "./linkedComponents.js";
import { copyScene, pasteScene } from "./sceneClipboard.js";

function fixture() {
  return parseDocument(createDocument({ id: "source-file", scenes: [createScene({ id: "source", name: "Artboard", width: 300, height: 200, canvasX: -500, canvasY: 800,
    background: { type: "linear", angle: 45, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] },
    backgroundAnimations: [{ id: "bg", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#0000ff" } }],
    layers: [createLayer("group", { id: "group", x: 10 }), createLayer("image", { id: "image", parentId: "group", src: "/api/media/11111111-1111-1111-1111-111111111111.png", animations: [{ id: "fade", name: "Fade", kind: "in", start: 0, duration: 1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } }] })],
  })] }));
}

test("scene clipboard crosses files with media, grouping, background and fresh animation IDs", () => {
  const source = fixture(), before = JSON.stringify(source);
  const target = parseDocument(createDocument({ scenes: [createScene({ id: "target", canvasX: 100, canvasY: -20 })] }));
  const envelope = JSON.parse(JSON.stringify(copyScene(source, "source")));
  const result = pasteScene(target, "target", envelope), scene = result.document.scenes.at(-1);
  assert.equal(scene.name, "Artboard"); assert.equal(scene.canvasX, 860); assert.equal(scene.canvasY, -20);
  assert.deepEqual(scene.background, source.scenes[0].background);
  assert.notEqual(scene.backgroundAnimations[0].id, "bg");
  assert.notEqual(scene.layers[1].animations[0].id, "fade");
  assert.equal(scene.layers[1].parentId, scene.layers[0].id);
  assert.equal(result.media.length, 1); assert.equal(result.media[0].src, source.scenes[0].layers[1].src);
  assert.deepEqual(parseDocument(JSON.stringify(result.document)), result.document);
  assert.equal(JSON.stringify(source), before);
});

test("paste and replace retains destination identity, position and component role", () => {
  const target = parseDocument(createDocument({ scenes: [createScene({ id: "target", name: "Old", canvasX: -40, canvasY: 300, isComponent: true })] }));
  const result = pasteScene(target, "target", copyScene(fixture(), "source"), { replace: true });
  assert.equal(result.document.scenes.length, 1);
  assert.equal(result.sceneId, "target");
  assert.deepEqual([result.document.scenes[0].canvasX, result.document.scenes[0].canvasY, result.document.scenes[0].isComponent], [-40, 300, true]);
  assert.equal(result.document.scenes[0].layers.length, 2);
  assert.equal(target.scenes[0].layers.length, 0);
});

test("empty scenes copy and paste, and invalid metadata or layer envelopes fail atomically", () => {
  const source = parseDocument(createDocument({ scenes: [createScene({ id: "empty" })] }));
  const envelope = copyScene(source, "empty");
  assert.equal(pasteScene(source, "empty", envelope).document.scenes.length, 2);
  assert.throws(() => pasteScene(source, "empty", { ...envelope, scene: { width: -2 } }));
  assert.throws(() => pasteScene(source, "empty", { ...envelope, contents: { kind: "layers", layers: [{ type: "bad" }] } }));
  assert.equal(source.scenes.length, 1);
});

test("scene paste imports nested component dependencies and preserves instance overrides", () => {
  const source = fixture();
  const main = createScene({ id: "component", name: "Badge", isComponent: true, layers: [createLayer("text", { id: "label", text: "Default" })] });
  source.scenes.push(main);
  source.scenes[0].layers.push(createComponentInstance(main, { id: "instance", componentOverrides: { label: { text: "Override" } } }));
  const target = parseDocument(createDocument());
  const result = pasteScene(target, target.scenes[0].id, copyScene(source, "source"));
  const scene = result.document.scenes.find((item) => item.id === result.sceneId);
  const instance = scene.layers.find((item) => item.type === "component");
  const component = result.document.scenes.find((item) => item.id === instance.componentSceneId);
  assert.equal(instance.componentOverrides[component.layers[0].id].text, "Override");
  assert.ok(component.canvasX > scene.canvasX + scene.width);
});
