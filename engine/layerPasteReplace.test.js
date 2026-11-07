import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { point, worldMatrix } from "./geometry.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { copyLayers } from "./layerClipboard.js";
import { pasteReplaceLayers } from "./layerPasteReplace.js";

const IMAGE = "/api/media/0f8fad5b-d9cb-469f-a165-70867728950e.png";
const FONT = "/api/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.ttf";

function documentWith(layers, id = "main") {
  return parseDocument(createDocument({ scenes: [createScene({ id, layers })] }));
}

const fade = (id, start = 0.5) => ({
  id, name: "Fade in", kind: "in", start, duration: 1, easing: "linear",
  from: { opacity: 0 }, to: { opacity: 1 },
});

function centerInScene(layer, layers) {
  return point(worldMatrix(layer, layers), layer.width / 2, layer.height / 2);
}

test("replace keeps target identity and world center under a rotated mirrored parent, and rebases compatible animations", () => {
  const source = documentWith([
    createLayer("rectangle", { id: "source", name: "Copied", x: 500, y: 300, width: 24, height: 16, rotation: -20 }),
  ], "source-scene");
  const envelope = copyLayers(source, "source-scene", ["source"]);
  const targetDocument = documentWith([
    createLayer("group", { id: "parent", name: "Parent", x: 80, y: 40, width: 260, height: 180, rotation: 37, scaleX: -1.4, scaleY: 0.8, skewX: 12 }),
    createLayer("ellipse", {
      id: "target", name: "Keep target", parentId: "parent", x: 30, y: 40, width: 80, height: 50,
      rotation: 15, animations: [
        fade("keep-fade", 1.25),
        { id: "keep-move", name: "Move", kind: "custom", start: 0.25, duration: 0.75, easing: "linear", from: { x: 10 }, to: { x: 30 } },
        { id: "drop-donut", name: "Donut", kind: "custom", start: 2, duration: 0.5, easing: "linear", from: { donut: 0 }, to: { donut: 0.7 } },
      ],
    }),
    createLayer("ellipse", { id: "sibling", name: "Sibling", parentId: "parent", x: 150, y: 20 }),
  ]);
  const beforeLayers = targetDocument.scenes[0].layers;
  const beforeCenter = centerInScene(beforeLayers[1], beforeLayers);
  const original = JSON.stringify(targetDocument);

  const result = pasteReplaceLayers(targetDocument, "main", ["target"], envelope);
  const layers = result.document.scenes[0].layers;
  const replacement = layers.find((layer) => layer.id === "target");
  assert.equal(replacement.type, "rectangle");
  assert.equal(replacement.name, "Keep target");
  assert.equal(replacement.parentId, "parent");
  assert.deepEqual(layers.map((layer) => layer.id), ["parent", "target", "sibling"]);
  const afterCenter = centerInScene(replacement, layers);
  assert.ok(Math.abs(afterCenter.x - beforeCenter.x) < 1e-7);
  assert.ok(Math.abs(afterCenter.y - beforeCenter.y) < 1e-7);
  assert.deepEqual(replacement.animations.map(({ id, start }) => [id, start]), [["keep-fade", 1.25], ["keep-move", 0.25]]);
  assert.equal(replacement.animations[1].to.x, replacement.x, "position endpoints move with the recentered root");
  assert.match(result.notes.join(" "), /Skipped Donut on “Keep target”/);
  assert.deepEqual(result.rootIds, ["target"]);
  assert.equal(JSON.stringify(targetDocument), original, "the source document is unchanged");
});

test("replace removes the old subtree and keeps a fresh copied subtree at the target's stack slot", () => {
  const source = documentWith([
    createLayer("group", { id: "source-group", name: "New group", x: 100, y: 60, width: 90, height: 70 }),
    createLayer("ellipse", { id: "new-child", name: "New child", parentId: "source-group", x: 8, y: 9 }),
  ], "source-scene");
  const envelope = copyLayers(source, "source-scene", ["source-group"]);
  const destination = documentWith([
    createLayer("rectangle", { id: "back", name: "Back" }),
    createLayer("group", { id: "target", name: "Target group", x: 25, y: 40, width: 140, height: 100 }),
    createLayer("rectangle", { id: "old-child", name: "Old child", parentId: "target" }),
    createLayer("ellipse", { id: "front", name: "Front" }),
  ]);

  const result = pasteReplaceLayers(destination, "main", ["target", "old-child"], envelope);
  const layers = result.document.scenes[0].layers;
  const root = layers.find((layer) => layer.id === "target");
  const child = layers.find((layer) => layer.name === "New child");
  assert.equal(root.type, "group");
  assert.equal(root.name, "Target group");
  assert.equal(child.parentId, root.id);
  assert.notEqual(child.id, "new-child");
  assert.equal(layers.some((layer) => layer.id === "old-child"), false);
  assert.deepEqual(layers.map((layer) => layer.name), ["Back", "Target group", "New child", "Front"]);
  assert.deepEqual(result.rootIds, ["target"], "a selected descendant is covered by its selected ancestor");
});

test("component replacement retains linked component scenes, media, and font references", () => {
  const master = createScene({
    id: "master", name: "Media card", isComponent: true, width: 120, height: 80,
    layers: [
      createLayer("image", { id: "photo", src: IMAGE }),
      createLayer("text", { id: "caption", text: "Hello", fontFamily: "Brand", fontSource: FONT }),
    ],
  });
  const source = parseDocument(createDocument({
    scenes: [createScene({ id: "source-scene", layers: [createComponentInstance(master, { id: "instance" })] }), master],
  }));
  const envelope = copyLayers(source, "source-scene", ["instance"]);
  const destination = documentWith([createLayer("ellipse", { id: "target", name: "Target", x: 20, y: 30, width: 40, height: 30 })]);

  const result = pasteReplaceLayers(destination, "main", ["target"], envelope);
  const instance = result.document.scenes[0].layers[0];
  const component = result.document.scenes.find((scene) => scene.id === instance.componentSceneId);
  assert.equal(instance.id, "target");
  assert.equal(component.isComponent, true);
  assert.equal(component.name, "Media card");
  assert.deepEqual(result.addedComponents, ["Media card"]);
  assert.ok(result.media.some((item) => item.src === IMAGE));
  assert.ok(result.media.some((item) => item.src === FONT && item.type === "font"));
  assert.ok(result.textLayers.some((layer) => layer.fontFamily === "Brand" && layer.fontSource === FONT));
});

test("replace refuses multiple clipboard roots, locked subtrees, unsafe masks, and inherited component children", () => {
  const multiple = documentWith([createLayer("rectangle", { id: "one" }), createLayer("ellipse", { id: "two" })], "source");
  const multipleEnvelope = copyLayers(multiple, "source", ["one", "two"]);
  const simpleEnvelope = copyLayers(documentWith([createLayer("rectangle", { id: "copy" })], "source"), "source", ["copy"]);
  const unlocked = documentWith([createLayer("group", { id: "target" }), createLayer("rectangle", { id: "child", parentId: "target", locked: true })]);
  const masked = documentWith([
    createLayer("ellipse", { id: "mask", isMask: true }),
    createLayer("rectangle", { id: "target" }),
  ]);
  const component = createScene({ id: "master", name: "Master", isComponent: true, layers: [createLayer("text", { id: "inherited", text: "Text" })] });
  const inherited = parseDocument(createDocument({ scenes: [createScene({ id: "main", layers: [createComponentInstance(component, { id: "instance" })] }), component] }));
  const inheritedLayerId = expandComponents(inherited, "main").layers.find((layer) => layer.type === "text" && layer.componentOwnerId).id;

  assert.throws(() => pasteReplaceLayers(documentWith([createLayer("rectangle", { id: "target" })]), "main", ["target"], multipleEnvelope), /exactly one root layer/);
  assert.throws(() => pasteReplaceLayers(unlocked, "main", ["target"], simpleEnvelope), /locked/);
  assert.throws(() => pasteReplaceLayers(masked, "main", ["target"], simpleEnvelope), /mask or mask group/);
  assert.throws(() => pasteReplaceLayers(inherited, "main", [inheritedLayerId], simpleEnvelope), /part of a component instance/);
});
