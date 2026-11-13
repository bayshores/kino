import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { worldMatrix } from "./geometry.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { maskTargets } from "./grouping.js";
import { renderSceneSvg } from "./render.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import {
  CLIPBOARD_VERSION,
  copyAnimation,
  copyAnimations,
  copyLayers,
  duplicateLayers,
  mediaReferences,
  pasteAnimations,
  pasteLayers,
} from "./layerClipboard.js";
import { buildPiece, checkPiece, pieceLine } from "./piece.js";

const IMAGE = "/api/media/0f8fad5b-d9cb-469f-a165-70867728950e.png";
const FONT_FILE = "/api/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.ttf";

function documentWith(layers, overrides = {}) {
  const scene = createScene({ id: "main", layers });
  return parseDocument(createDocument({ scenes: [scene], ...overrides }));
}

function fade(id, start = 0) {
  return { id, name: "Fade in", kind: "in", start, duration: 1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } };
}

// Copy, write out as JSON, read back: what a paste in another file receives.
function throughClipboard(envelope) {
  return JSON.parse(JSON.stringify(envelope));
}

// An envelope as an attacker could write it.
function hostile(layers, extra = {}) {
  return JSON.parse(JSON.stringify({ format: "kino.clipboard", version: 1, kind: "layers", layers, roots: [], components: [], ...extra }));
}

function sceneLayers(document, id = "main") {
  return document.scenes.find((scene) => scene.id === id).layers;
}

function assertSameMatrix(a, b, message) {
  for (let index = 0; index < 6; index += 1) assert.ok(Math.abs(a[index] - b[index]) < 1e-6, `${message}: [${a}] vs [${b}]`);
}

test("layers round-trip through the clipboard envelope and paste above the originals with new IDs", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "back", name: "Back", x: 10, y: 20, fill: "#ff0000", animations: [fade("fade")] }),
    createLayer("text", { id: "title", name: "Title", text: "Hello", x: 40 }),
    createLayer("ellipse", { id: "front", name: "Front" }),
  ]);
  const envelope = throughClipboard(copyLayers(document, "main", ["back", "title"]));
  assert.equal(envelope.version, CLIPBOARD_VERSION);
  const result = pasteLayers(document, "main", envelope);
  const layers = sceneLayers(result.document);
  // Directly above the topmost original ("title"), below "front".
  assert.deepEqual(layers.map((layer) => layer.name), ["Back", "Title", "Back", "Title", "Front"]);
  const [pastedBack, pastedTitle] = [layers[2], layers[3]];
  assert.deepEqual(result.rootIds, [pastedBack.id, pastedTitle.id]);
  assert.notEqual(pastedBack.id, "back");
  assert.notEqual(pastedBack.animations[0].id, "fade");
  assert.equal(result.idMap.get("back"), pastedBack.id);
  // Same place and look.
  const { id: _a, animations: backAnimations, ...backValues } = pastedBack;
  const { id: _b, animations: originalAnimations, ...originalValues } = layers[0];
  assert.deepEqual(backValues, originalValues);
  assert.deepEqual({ ...backAnimations[0], id: "fade" }, originalAnimations[0]);
  assert.equal(pastedTitle.text, "Hello");
  assert.equal(layers.length, new Set(layers.map((layer) => layer.id)).size, "every layer ID is unique");
  assert.equal(sceneLayers(document).length, 3, "the original document is unchanged");
});

test("compound path rules and morph contours survive cross-project copy, paste, and duplicate", () => {
  const pathData = "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z";
  const nextPath = "M0 0 H50 V50 H0 Z M12 12 H38 V38 H12 Z";
  const source = documentWith([createLayer("path", {
    id: "evenodd-ring",
    path: pathData,
    width: 40,
    height: 40,
    pathBounds: { width: 40, height: 40 },
    fillRule: "evenodd",
    animations: [{
      id: "ring-morph", name: "Morph", kind: "custom", start: 0, duration: 1, easing: "linear",
      from: { path: pathData }, to: { path: nextPath },
    }],
  })]);
  const original = sceneLayers(source)[0];
  const envelope = throughClipboard(copyLayers(source, "main", [original.id]));
  const pasted = sceneLayers(pasteLayers(documentWith([]), "main", envelope).document)[0];
  assert.equal(pasted.fillRule, "evenodd");
  assert.equal(pasted.path, original.path);
  assert.equal(pasted.animations[0].from.path, original.animations[0].from.path);
  assert.equal(pasted.animations[0].to.path, original.animations[0].to.path);

  const duplicate = sceneLayers(duplicateLayers(source, "main", [original.id]).document)[1];
  assert.equal(duplicate.fillRule, "evenodd");
  assert.equal(duplicate.path, original.path);
  assert.equal(duplicate.animations[0].from.path, original.animations[0].from.path);
  assert.equal(duplicate.animations[0].to.path, original.animations[0].to.path);
});

test("a pasted group keeps its nested groups, children and stacking order with remapped parents", () => {
  const document = documentWith([
    createLayer("group", { id: "outer", name: "Outer", x: 50, y: 50, width: 300, height: 200, rotation: 15 }),
    createLayer("group", { id: "inner", name: "Inner", parentId: "outer", x: 10, y: 10, width: 100, height: 100 }),
    createLayer("rectangle", { id: "leaf", name: "Leaf", parentId: "inner", x: 5, y: 5, width: 20, height: 20 }),
    createLayer("ellipse", { id: "dot", name: "Dot", parentId: "outer", x: 30, y: 30 }),
  ]);
  // Selecting a group and a layer inside it copies the group once.
  const envelope = throughClipboard(copyLayers(document, "main", ["leaf", "outer"]));
  assert.equal(envelope.layers.length, 4);
  assert.deepEqual(envelope.roots.map((root) => root.id), ["outer"]);
  const target = documentWith([]);
  const result = pasteLayers(target, "main", envelope);
  const layers = sceneLayers(result.document);
  const byName = Object.fromEntries(layers.map((layer) => [layer.name, layer]));
  assert.deepEqual(layers.map((layer) => layer.name), ["Outer", "Inner", "Leaf", "Dot"]);
  assert.equal(byName.Outer.parentId, null);
  assert.equal(byName.Inner.parentId, byName.Outer.id);
  assert.equal(byName.Leaf.parentId, byName.Inner.id);
  assert.equal(byName.Dot.parentId, byName.Outer.id);
  assert.deepEqual(result.rootIds, [byName.Outer.id]);
  const original = sceneLayers(document);
  assertSameMatrix(worldMatrix(byName.Leaf, layers), worldMatrix(original[2], original), "the nested leaf");
});

test("a layer copied out of a rotated, scaled group pastes elsewhere at the same place on the canvas", () => {
  const document = documentWith([
    createLayer("group", { id: "group", name: "Group", x: 100, y: 80, width: 200, height: 120, rotation: 30, scaleX: 2, scaleY: 2 }),
    createLayer("rectangle", { id: "child", name: "Child", parentId: "group", x: 20, y: 10, width: 40, height: 30, rotation: 10 }),
  ]);
  const envelope = throughClipboard(copyLayers(document, "main", ["child"]));
  const elsewhere = documentWith([]);
  const result = pasteLayers(elsewhere, "main", envelope);
  const [pasted] = sceneLayers(result.document);
  assert.equal(pasted.parentId, null);
  assert.equal(pasted.rotation, 40);
  assert.equal(pasted.scaleX, 2);
  const original = sceneLayers(document);
  assertSameMatrix(worldMatrix(pasted, [pasted]), worldMatrix(original[1], original), "the moved child");
  assert.deepEqual(result.notes, []);
});

test("a layer pasted where its group still exists goes back into that group, above the original", () => {
  const document = documentWith([
    createLayer("group", { id: "group", name: "Group", rotation: 30 }),
    createLayer("rectangle", { id: "child", name: "Child", parentId: "group", x: 20, y: 10 }),
    createLayer("ellipse", { id: "sibling", name: "Sibling", parentId: "group" }),
  ]);
  const result = pasteLayers(document, "main", throughClipboard(copyLayers(document, "main", ["child"])));
  const layers = sceneLayers(result.document);
  assert.deepEqual(layers.map((layer) => layer.name), ["Group", "Child", "Child", "Sibling"]);
  assert.equal(layers[2].parentId, "group");
  assert.equal(layers[2].x, 20, "group-local values are kept inside the same group");
  assert.equal(layers[2].rotation, 0);
});

test("duplicating keeps the same group, place and name, directly above the originals", () => {
  const document = documentWith([
    createLayer("group", { id: "group", name: "Group" }),
    createLayer("rectangle", { id: "one", name: "One", parentId: "group", x: 3 }),
    createLayer("rectangle", { id: "two", name: "Two", x: 9 }),
    createLayer("rectangle", { id: "top", name: "Top" }),
  ]);
  const result = duplicateLayers(document, "main", ["one", "two"]);
  const layers = sceneLayers(result.document);
  assert.deepEqual(layers.map((layer) => layer.name), ["Group", "One", "Two", "One", "Two", "Top"]);
  assert.equal(layers[3].parentId, "group");
  assert.equal(layers[3].x, 3);
  assert.equal(layers[4].parentId, null);
  assert.equal(result.idMap.get("one"), layers[3].id);
  assert.equal(result.idMap.get("two"), layers[4].id);
});

function componentDocument() {
  const badge = createScene({ id: "badge", name: "Badge", isComponent: true, width: 80, height: 40, layers: [createLayer("ellipse", { id: "badge-dot" })] });
  const card = createScene({
    id: "card",
    name: "Card",
    isComponent: true,
    width: 200,
    height: 120,
    layers: [createLayer("rectangle", { id: "card-back", animations: [fade("card-fade")] }), createComponentInstance(badge, { id: "card-badge" })],
  });
  const main = createScene({ id: "main", layers: [createComponentInstance(card, { id: "card-instance", x: 12 })] });
  return parseDocument(createDocument({ scenes: [main, card, badge] }));
}

test("an instance pasted in its own file stays linked to the same main component", () => {
  const document = componentDocument();
  const result = pasteLayers(document, "main", throughClipboard(copyLayers(document, "main", ["card-instance"])));
  assert.equal(result.document.scenes.length, 3, "no main component is added");
  assert.deepEqual(result.addedComponents, []);
  const pasted = sceneLayers(result.document)[1];
  assert.equal(pasted.componentSceneId, "card");
  assert.equal(pasted.x, 12);
});

test("an instance pasted into another file brings its main components once, nested ones included", () => {
  const source = componentDocument();
  const envelope = throughClipboard(copyLayers(source, "main", ["card-instance"]));
  assert.deepEqual(envelope.components.map((scene) => scene.id), ["card", "badge"]);
  const target = documentWith([]);
  const first = pasteLayers(target, "main", envelope);
  assert.deepEqual(first.addedComponents, ["Card", "Badge"]);
  const scenes = new Map(first.document.scenes.map((scene) => [scene.id, scene]));
  assert.ok(scenes.get("card").isComponent);
  assert.equal(sceneLayers(first.document)[0].componentSceneId, "card");
  const nested = scenes.get("card").layers.find((layer) => layer.type === "component");
  assert.equal(nested.componentSceneId, "badge");
  assert.notEqual(nested.id, "card-badge", "layers inside an added main component get new IDs");
  assert.notEqual(scenes.get("card").layers[0].animations[0].id, "card-fade");
  // A second paste links to the main components the first one added.
  const second = pasteLayers(first.document, "main", envelope);
  assert.equal(second.document.scenes.length, 3);
  assert.deepEqual(second.addedComponents, []);
  assert.equal(sceneLayers(second.document)[1].componentSceneId, "card");
});

test("a version 2 clipboard migrates its copied component scenes to version 3", () => {
  const source = componentDocument();
  const envelope = copyLayers(source, "main", ["card-instance"]);
  envelope.version = 2;
  const card = envelope.components.find((scene) => scene.id === "card");
  card.background = "#ffffff00";
  delete card.backgroundEnabled;
  delete card.backgroundAnimations;
  for (const component of envelope.components) {
    delete component.backgroundEnabled;
    delete component.backgroundAnimations;
  }

  const result = pasteLayers(documentWith([]), "main", throughClipboard(envelope));
  const pastedCard = result.document.scenes.find((scene) => scene.name === "Card");
  assert.equal(pastedCard.background, "#ffffff");
  assert.equal(pastedCard.backgroundEnabled, false);
  assert.deepEqual(pastedCard.backgroundAnimations, []);
});

test("background animations can be copied and get fresh IDs with a pasted component", () => {
  const color = {
    id: "background-color",
    name: "Color",
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from: { fill: "#ff0000" },
    to: { fill: "#0000ff" },
  };
  const card = createScene({
    id: "card",
    name: "Card",
    isComponent: true,
    background: "#ffffff",
    backgroundAnimations: [color],
  });
  const source = parseDocument(createDocument({
    scenes: [createScene({ id: "main", layers: [createComponentInstance(card, { id: "card-instance" })] }), card],
  }));
  const copied = copyAnimations(source, "card", [color.id]);
  assert.equal(copied.source.layerId, "#scene-background");
  assert.deepEqual(copied.animations.map((animation) => animation.id), [color.id]);
  assert.deepEqual(copyAnimation(source, "card", "#scene-background", color.id).animations, copied.animations);

  const destination = documentWith([
    createLayer("rectangle", { id: "existing", animations: [{ ...color }] }),
  ]);
  const pasted = pasteLayers(destination, "main", throughClipboard(copyLayers(source, "main", ["card-instance"])));
  const pastedCard = pasted.document.scenes.find((scene) => scene.name === "Card");
  assert.equal(pastedCard.backgroundAnimations.length, 1);
  assert.notEqual(pastedCard.backgroundAnimations[0].id, color.id);
  const animationIds = pasted.document.scenes.flatMap((scene) => [
    ...scene.backgroundAnimations.map((animation) => animation.id),
    ...scene.layers.flatMap((layer) => layer.animations.map((animation) => animation.id)),
  ]);
  assert.equal(animationIds.length, new Set(animationIds).size, "pasted background IDs stay unique across the document");
});

test("a main component whose scene ID is taken by an ordinary scene is added under a new ID", () => {
  const source = componentDocument();
  const envelope = throughClipboard(copyLayers(source, "main", ["card-instance"]));
  const target = parseDocument(createDocument({ scenes: [createScene({ id: "main" }), createScene({ id: "card", name: "Not a component" })] }));
  const result = pasteLayers(target, "main", envelope);
  const instance = sceneLayers(result.document)[0];
  assert.notEqual(instance.componentSceneId, "card");
  const added = result.document.scenes.find((scene) => scene.id === instance.componentSceneId);
  assert.equal(added.name, "Card");
  assert.ok(added.isComponent);
  assert.equal(result.document.scenes.find((scene) => scene.id === "card").isComponent, false);
});

test("an instance can't be pasted inside its own main component", () => {
  const document = componentDocument();
  const envelope = copyLayers(document, "main", ["card-instance"]);
  assert.throws(() => pasteLayers(document, "card", envelope), /Can't paste an instance of “Card” inside that main component/);
  assert.throws(() => pasteLayers(document, "badge", envelope), /inside that main component/);
});

test("drawing-only component fields never reach the saved document", () => {
  const document = documentWith([createLayer("rectangle", { id: "r", componentOwnerId: "x", componentSourceSceneId: "y", componentBackground: true })]);
  const result = pasteLayers(documentWith([]), "main", throughClipboard(copyLayers(document, "main", ["r"])));
  const [pasted] = sceneLayers(result.document);
  for (const key of ["componentOwnerId", "componentSourceSceneId", "componentBackground"]) assert.equal(Object.hasOwn(pasted, key), false);
});

test("hostile clipboard layers are rejected without changing the document or any prototype", () => {
  const target = documentWith([createLayer("rectangle", { id: "keep" })]);
  const before = structuredClone(target);
  const rectangle = (overrides) => ({ ...createLayer("rectangle"), ...overrides });
  const polluted = JSON.parse('{"format":"kino.clipboard","version":1,"kind":"layers","layers":[{"id":"p","type":"rectangle","__proto__":{"polluted":true}}],"roots":[{"id":"p","world":{"__proto__":{"polluted":true}}}]}');
  const cases = [
    [polluted, /unsafe field name/],
    [hostile([rectangle({ id: "a", src: "javascript:alert(1)" })]), /can't be pasted/],
    [hostile([{ ...rectangle({ id: "a" }), type: "macro" }]), /unsupported layer type/],
    // A script layer is a real type, and its module is checked like any field.
    [hostile([{ ...rectangle({ id: "a" }), type: "script" }]), /script: is empty/],
    [hostile([rectangle({ id: "a" }), rectangle({ id: "a" })]), /duplicate layer ID/],
    [hostile([rectangle({ id: "a", parentId: "b", type: "group" }), rectangle({ id: "b", parentId: "a", type: "group" })]), /cycle/],
    [hostile([rectangle({ id: "a", parentId: "r" }), rectangle({ id: "r" })]), /must reference a group layer/],
    [hostile([{ ...createLayer("component"), id: "c", componentSceneId: "nowhere" }]), /must reference a main component scene/],
    [hostile([rectangle({ id: "a", x: 1e12 })]), /can't be pasted/],
    [hostile([rectangle({ id: "a", animations: [{ ...fade("f"), from: { notAProperty: 1 }, to: {} }] })]), /unsupported property/],
    [hostile(Array.from({ length: 5001 }, (_, index) => rectangle({ id: `l${index}` }))), /more than 5000 layers/],
    [hostile("not a list"), /damaged/],
    [hostile([]), /no layers/],
    [hostile([rectangle({ id: "a" })], { components: [{ id: "x", __proto__: null, layers: "nope" }] }), /can't be pasted/],
  ];
  for (const [envelope, error] of cases) {
    assert.throws(() => pasteLayers(target, "main", envelope), error);
    assert.deepEqual(target, before);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("a hostile top-level placement is validated like any layer value", () => {
  const envelope = hostile([{ ...createLayer("rectangle"), id: "a", parentId: "gone" }], { roots: [{ id: "a", world: { x: "far", y: 1 } }] });
  assert.throws(() => pasteLayers(documentWith([]), "main", envelope), /x/);
});

test("a pasted instance relinks an overridden text font to this workspace's family file", () => {
  const sourceRegular = "/api/media/aaaaaaaa-0000-4000-8000-000000000001.ttf";
  const sourceBold = "/api/media/aaaaaaaa-0000-4000-8000-000000000002.ttf";
  const loadedByWeight = new Map([
    [400, "/api/media/bbbbbbbb-0000-4000-8000-000000000001.ttf"],
    [700, "/api/media/bbbbbbbb-0000-4000-8000-000000000002.ttf"],
  ]);
  const fonts = {
    resolve(layer) {
      const src = loadedByWeight.get(layer.fontWeight || 400);
      if (!src) throw new Error("Font is unavailable.");
      if (layer.fontSource && layer.fontSource !== src)
        throw new Error("The linked font for Brand is unavailable.");
      return { family: "Brand", weight: layer.fontWeight || 400, src };
    },
  };
  const card = createScene({
    id: "card",
    name: "Card",
    isComponent: true,
    layers: [createLayer("text", {
      id: "title",
      name: "Title",
      text: "Hello",
      fontFamily: "Brand",
      fontWeight: 400,
      fontSource: sourceRegular,
    })],
  });
  const source = parseDocument(createDocument({ scenes: [
    createScene({ id: "main", layers: [createComponentInstance(card, {
      id: "card-1",
      componentOverrides: { title: { fontWeight: 700, fontSource: sourceBold } },
    })] }),
    card,
  ] }));
  const envelope = throughClipboard(copyLayers(source, "main", ["card-1"]));
  const destination = documentWith([]);
  const result = pasteLayers(destination, "main", envelope, { fonts });
  const pastedInstance = sceneLayers(result.document).find((layer) => layer.id === result.rootIds[0]);
  const override = Object.values(pastedInstance.componentOverrides)[0];
  const drawnTitle = expandComponents(result.document, "main").layers.find((layer) => layer.componentOwnerId === pastedInstance.id && layer.text === "Hello");

  assert.equal(override.fontSource, loadedByWeight.get(700));
  assert.equal(drawnTitle.fontSource, loadedByWeight.get(700));
  assert.equal(fonts.resolve(drawnTitle).src, loadedByWeight.get(700));
});

test("a copied animation pastes onto every selected layer at the time cursor", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "from", animations: [fade("fade", 0.25)] }),
    createLayer("ellipse", { id: "a" }),
    createLayer("text", { id: "b" }),
  ]);
  const envelope = throughClipboard(copyAnimation(document, "main", "from", "fade"));
  assert.equal(envelope.kind, "animations");
  const result = pasteAnimations(document, "main", ["a", "b"], envelope, 1.2345);
  const layers = sceneLayers(result.document);
  for (const layer of layers.slice(1)) {
    assert.equal(layer.animations.length, 1);
    assert.equal(layer.animations[0].start, 1.235);
    assert.notEqual(layer.animations[0].id, "fade");
    assert.deepEqual(layer.animations[0].to, { opacity: 1 });
  }
  assert.notEqual(layers[1].animations[0].id, layers[2].animations[0].id);
  assert.deepEqual(result.pasted.map((item) => item.layerId), ["a", "b"]);
  assert.deepEqual(result.skipped, []);
});

test("several selected animations from different layers copy and paste together", () => {
  const slide = { id: "slide", name: "Slide", kind: "in", start: 1, duration: 0.5, easing: "linear", from: { y: 140 }, to: { y: 100 } };
  const document = documentWith([
    createLayer("rectangle", { id: "first", y: 100, animations: [fade("fade", 0.5), slide] }),
    createLayer("ellipse", { id: "second", y: 300, animations: [{ ...slide, id: "drop", start: 2, from: { y: 260 }, to: { y: 300 } }] }),
    createLayer("rectangle", { id: "target", y: 0 }),
  ]);
  // In the Timeline's order, whatever order they were selected in.
  const envelope = throughClipboard(copyAnimations(document, "main", ["drop", "fade", "slide"]));
  assert.deepEqual(envelope.animations.map((item) => item.id), ["fade", "slide", "drop"]);
  assert.deepEqual(envelope.rests.map((rest) => rest.y), [100, 100, 300]);
  assert.equal(envelope.source.layerId, "first");
  const result = pasteAnimations(document, "main", ["target"], envelope, 3);
  const pasted = sceneLayers(result.document).find((layer) => layer.id === "target").animations;
  // The earliest lands on the time cursor and the others keep their offsets from it.
  assert.deepEqual(pasted.map((item) => item.start), [3, 3.5, 4.5]);
  // Each one moves the target from its own y, as it moved its own layer from that layer's y.
  assert.deepEqual(pasted.slice(1).map((item) => [item.from.y, item.to.y]), [[40, 0], [-40, 0]]);
  assert.equal(new Set(pasted.map((item) => item.id)).size, 3);
  assert.deepEqual(result.pasted, [{ layerId: "target", animationIds: pasted.map((item) => item.id) }]);
  assert.throws(() => copyAnimations(document, "main", ["missing"]), /Select the animation to copy/);
});

test("an animation copy from before several-animation copies (only `rest`) still pastes", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "from", y: 100, animations: [{ id: "up", name: "Up", kind: "in", start: 0, duration: 1, easing: "linear", from: { y: 140 }, to: { y: 100 } }] }),
    createLayer("rectangle", { id: "to", y: 10 }),
  ]);
  const { rests, ...older } = copyAnimation(document, "main", "from", "up");
  assert.equal(rests.length, 1);
  const result = pasteAnimations(document, "main", ["to"], throughClipboard(older), 0);
  const pasted = sceneLayers(result.document).find((layer) => layer.id === "to").animations[0];
  assert.deepEqual([pasted.from.y, pasted.to.y], [50, 10]);
});

test("layers that can't take a copied animation are skipped with the reason", () => {
  const corner = { id: "corner", name: "Corner", kind: "custom", start: 0, duration: 1, easing: "linear", from: { radius: 0 }, to: { radius: 20 } };
  const shape = "M0 0 L20 0 L0 20 Z";
  const morph = { id: "morph", name: "Morph", kind: "custom", start: 0, duration: 1, easing: "linear", from: { path: shape }, to: { path: "M0 0 L60 0 L0 44 Z" } };
  const document = documentWith([
    createLayer("rectangle", { id: "box", animations: [corner] }),
    createLayer("ellipse", { id: "round" }),
    createLayer("rectangle", { id: "other" }),
    createLayer("path", { id: "shape", path: "M0 0 L10 0 L0 10 Z", animations: [morph] }),
    createLayer("path", { id: "line", path: "M0 0 L30 0 L0 30 Z" }),
  ]);
  const radius = pasteAnimations(document, "main", ["round", "other"], copyAnimation(document, "main", "box", "corner"), 0);
  assert.deepEqual(radius.pasted.map((item) => item.layerId), ["other"]);
  assert.equal(radius.skipped[0].layerId, "round");
  assert.match(radius.skipped[0].reason, /requires a rectangle layer/);
  const morphed = pasteAnimations(document, "main", ["other", "line"], copyAnimation(document, "main", "shape", "morph"), 0);
  assert.deepEqual(morphed.skipped.map((item) => [item.layerId, item.reason]), [["other", "Paste a Morph onto a vector path."]]);
  const line = sceneLayers(morphed.document).find((layer) => layer.id === "line");
  assert.equal(line.animations[0].from.path, "M0 0 L30 0 L0 30 Z", "a Morph starts from the target's own shape");
  assert.throws(() => pasteAnimations(document, "main", ["round"], copyAnimation(document, "main", "box", "corner"), 0), /requires a rectangle layer/);
});

test("layer and animation clipboards can't be confused", () => {
  const document = documentWith([createLayer("rectangle", { id: "box", animations: [fade("fade")] })]);
  assert.throws(() => pasteLayers(document, "main", copyAnimation(document, "main", "box", "fade")), /holds an animation/);
  assert.throws(() => pasteAnimations(document, "main", ["box"], copyLayers(document, "main", ["box"]), 0), /holds layers/);
  assert.throws(() => pasteAnimations(document, "main", [], copyAnimation(document, "main", "box", "fade"), 0), /Select a layer/);
  assert.throws(() => copyLayers(document, "main", ["missing"]), /Select the layers to copy/);
});

function maskedDocument() {
  return documentWith([
    createLayer("ellipse", { id: "m", name: "Mask", isMask: true }),
    createLayer("rectangle", { id: "t", name: "Masked" }),
    createLayer("rectangle", { id: "u", name: "Above" }),
  ]);
}

// "Mask" → "Masked" for each mask that masks a layer, by layer name.
function maskPairs(layers) {
  const name = (id) => layers.find((layer) => layer.id === id)?.name ?? null;
  return [...maskTargets(layers)].map(([mask, target]) => [layers.indexOf(layers.find((layer) => layer.id === mask)), name(mask), name(target)]);
}

test("duplicating a mask copies the layer it masks too, so the original keeps masking and the scene still draws", () => {
  const document = maskedDocument();
  const result = duplicateLayers(document, "main", ["m"]);
  const layers = sceneLayers(result.document);
  assert.deepEqual(layers.map((layer) => layer.name), ["Mask", "Masked", "Mask", "Masked", "Above"]);
  assert.deepEqual(maskPairs(layers), [[0, "Mask", "Masked"], [2, "Mask", "Masked"]]);
  assert.equal(maskTargets(layers).get("m"), "t", "the original mask still masks the original layer");
  assert.equal(maskTargets(layers).get(result.idMap.get("m")), result.idMap.get("t"), "the copy masks the copy");
  assert.deepEqual(result.rootIds, [result.idMap.get("m"), result.idMap.get("t")]);
  assert.doesNotThrow(() => renderSceneSvg(result.document.scenes[0], 0));
});

test("a copied masked layer keeps its mask, in place and in another scene", () => {
  const document = maskedDocument();
  const envelope = throughClipboard(copyLayers(document, "main", ["t"]));
  assert.deepEqual(envelope.roots.map((root) => root.id), ["m", "t"]);
  const inPlace = sceneLayers(pasteLayers(document, "main", envelope).document);
  assert.deepEqual(inPlace.map((layer) => layer.name), ["Mask", "Masked", "Mask", "Masked", "Above"]);
  assert.deepEqual(maskPairs(inPlace), [[0, "Mask", "Masked"], [2, "Mask", "Masked"]]);
  const elsewhere = sceneLayers(pasteLayers(documentWith([createLayer("rectangle", { id: "x", name: "Other" })]), "main", envelope).document);
  assert.deepEqual(maskPairs(elsewhere), [[1, "Mask", "Masked"]]);
});

test("a paste that would change what a mask masks, or leave a mask with nothing to mask, is refused", () => {
  // A mask at the top of a scene masks the next layer that is added above it.
  const target = documentWith([createLayer("rectangle", { id: "a", name: "A" }), createLayer("ellipse", { id: "top", name: "Top mask", isMask: true }), createLayer("rectangle", { id: "b", name: "B" })]);
  const before = structuredClone(target);
  const loose = documentWith([createLayer("rectangle", { id: "x", name: "Loose" })]);
  assert.throws(() => pasteLayers(documentWith([createLayer("ellipse", { id: "lone", name: "Lone", isMask: true })]), "main", copyLayers(loose, "main", ["x"])), /mask “Lone” would start masking “Loose”/);
  assert.deepEqual(pasteLayers(target, "main", copyLayers(loose, "main", ["x"])).document.scenes[0].layers.length, 4, "a paste above a mask's pair is fine");
  // A mask group's mask copied on its own becomes an ordinary mask, with nothing of its own to mask.
  const group = documentWith([
    createLayer("group", { id: "g", name: "Mask group", isMaskGroup: true }),
    createLayer("ellipse", { id: "gm", name: "Group mask", parentId: "g", isMask: true }),
    createLayer("rectangle", { id: "inside", name: "Inside", parentId: "g" }),
  ]);
  assert.throws(() => duplicateLayers(group, "main", ["gm"]), /copied mask “Group mask” would mask “Inside”/);
  assert.throws(() => pasteLayers(documentWith([]), "main", copyLayers(group, "main", ["gm"])), /copied mask “Group mask” would have no layer to mask/);
  assert.deepEqual(target, before);
});

test("pasting a layer from a mask group into that group keeps it under the group's mask", () => {
  const document = documentWith([
    createLayer("group", { id: "g", name: "Mask group", isMaskGroup: true }),
    createLayer("ellipse", { id: "gm", name: "Group mask", parentId: "g", isMask: true }),
    createLayer("rectangle", { id: "inside", name: "Inside", parentId: "g" }),
  ]);
  const layers = sceneLayers(duplicateLayers(document, "main", ["inside"]).document);
  assert.deepEqual(layers.map((layer) => [layer.name, layer.parentId]), [["Mask group", null], ["Group mask", "g"], ["Inside", "g"], ["Inside", "g"]]);
  assert.doesNotThrow(() => renderSceneSvg({ ...document.scenes[0], layers }, 0));
});

test("a pasted animation moves each layer from its own resting values, not the copied layer's", () => {
  const source = createLayer("rectangle", { id: "src", x: 50, y: 100, scaleX: 1, scaleY: 1, rotation: 10, opacity: 1 });
  source.animations = [
    presetAnimation("slide-up", source, 0, { width: 400, height: 500 }, { parameters: { distance: 40 / source.height * 100 } }),
    presetAnimation("fade-in", source, 0),
    presetAnimation("grow-in", source, 0, null, { parameters: { scale: 60 } }),
    presetAnimation("rotate-in", source, 0),
    presetAnimation("blur-in", source, 0, null, { parameters: { blur: 16 } }),
  ];
  const document = documentWith([
    source,
    createLayer("rectangle", { id: "a", y: 200, opacity: 0.5, scaleX: 2, scaleY: 2, rotation: 0, blur: 4 }),
    createLayer("rectangle", { id: "b", y: 20 }),
  ]);
  const values = (layer, time) => {
    const at = evaluateLayer(layer, time);
    return { y: at.y, opacity: at.opacity, scaleX: at.scaleX, rotation: at.rotation, blur: at.blur };
  };
  const paste = (index) => pasteAnimations(document, "main", ["a", "b"], throughClipboard(copyAnimation(document, "main", "src", source.animations[index].id)), 0);
  const slid = sceneLayers(paste(0).document);
  assert.deepEqual([values(slid[1], 0).y, values(slid[1], 5).y], [240, 200], "a slides up into its own place");
  assert.deepEqual([values(slid[2], 0).y, values(slid[2], 5).y], [60, 20], "b slides up into its own place");
  const faded = sceneLayers(paste(1).document);
  assert.deepEqual([values(faded[1], 0).opacity, values(faded[1], 5).opacity], [0, 0.5], "a fades in to its own 50%");
  const grown = sceneLayers(paste(2).document);
  assert.deepEqual([values(grown[1], 0).scaleX, values(grown[1], 5).scaleX], [1.2, 2]);
  const turned = sceneLayers(paste(3).document);
  assert.deepEqual([values(turned[1], 0).rotation, values(turned[1], 5).rotation], [-90, 0]);
  const blurred = sceneLayers(paste(4).document);
  assert.deepEqual([values(blurred[1], 0).blur, values(blurred[1], 5).blur], [20, 4]);
  // On the layer it was copied from, the animation is unchanged.
  const again = pasteAnimations(document, "main", ["src"], copyAnimation(document, "main", "src", source.animations[0].id), 0);
  const copy = sceneLayers(again.document)[0].animations.at(-1);
  assert.deepEqual([copy.from, copy.to], [source.animations[0].from, source.animations[0].to]);
});

test("a layer's aspect-ratio lock comes along when it is copied and pasted, and doesn't change the drawing", () => {
  const document = documentWith([createLayer("rectangle", { id: "a", name: "A", width: 120, height: 40, lockAspect: true })]);
  const result = pasteLayers(document, "main", throughClipboard(copyLayers(document, "main", ["a"])));
  const pasted = sceneLayers(result.document).find((layer) => layer.id === result.rootIds[0]);
  assert.equal(pasted.lockAspect, true);
  // The lock is an editor setting: the drawn (and exported) scene is the same either way.
  const unlocked = { ...document.scenes[0], layers: sceneLayers(document).map((layer) => ({ ...layer, lockAspect: false })) };
  assert.equal(renderSceneSvg(document.scenes[0], 0), renderSceneSvg(unlocked, 0));
});

test("a layer whose fill is off pastes with its fill still off and its paint kept, in another file too", () => {
  const gradient = { type: "linear", angle: 30, stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#00ff00" }] };
  const document = documentWith([
    createLayer("rectangle", { id: "a", name: "A", fill: gradient, fillEnabled: false, strokeWidth: 2 }),
  ]);
  const other = documentWith([], { id: "other-file" });
  for (const target of [document, other]) {
    const result = pasteLayers(target, "main", throughClipboard(copyLayers(document, "main", ["a"])));
    const pasted = sceneLayers(result.document).find((layer) => layer.id === result.rootIds[0]);
    assert.equal(pasted.fillEnabled, false, "the fill stays off");
    assert.deepEqual(pasted.fill, gradient, "the hidden gradient comes along for turning it back on");
    assert.doesNotMatch(renderSceneSvg({ ...result.document.scenes[0], layers: [pasted] }, 0), /<linearGradient/,
      "the pasted layer draws no fill");
  }
});

test("layers pasted from another project keep their media references", () => {
  const source = documentWith([
    createLayer("image", { id: "photo", name: "Photo", src: IMAGE }),
    createLayer("text", { id: "label", name: "Label", fontFamily: "Brand", fontSource: FONT_FILE }),
  ]);
  const envelope = throughClipboard(copyLayers(source, "main", ["photo", "label"]));
  assert.deepEqual(envelope.media.map((item) => [item.src, item.type]), [[IMAGE, "image"], [FONT_FILE, "font"]]);
  const result = pasteLayers(documentWith([]), "main", envelope);
  const [photo, label] = sceneLayers(result.document);
  assert.equal(photo.src, IMAGE);
  assert.equal(label.fontSource, FONT_FILE);
  assert.deepEqual(result.media, mediaReferences([photo, label]));
});

test("a pasted text layer whose font file is missing uses this workspace's copy of the same family", () => {
  const loaded = { family: "Brand", src: "/api/fonts/brand-regular.ttf" };
  const fonts = {
    resolve(layer) {
      if (layer.fontSource && layer.fontSource !== loaded.src) throw new Error("The linked font is unavailable.");
      if (layer.fontFamily !== loaded.family) throw new Error(`Font “${layer.fontFamily}” is unavailable.`);
      return loaded;
    },
  };
  const source = documentWith([
    createLayer("text", { id: "a", fontFamily: "Brand", fontSource: FONT_FILE }),
    createLayer("text", { id: "b", fontFamily: "Unknown", fontSource: FONT_FILE }),
  ]);
  const result = pasteLayers(documentWith([]), "main", copyLayers(source, "main", ["a", "b"]), { fonts });
  const [relinked, kept] = sceneLayers(result.document);
  assert.equal(relinked.fontSource, loaded.src);
  assert.equal(kept.fontSource, FONT_FILE);
});

test("pasting several animations adds the ones each layer can take and skips only the others", () => {
  const tint = { id: "tint", name: "Color", kind: "custom", start: 1, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#0000ff" } };
  const document = documentWith([
    createLayer("rectangle", { id: "box", name: "Box", fill: "#ff0000", animations: [fade("fade", 0.5), tint] }),
    createLayer("image", { id: "image", name: "Image" }),
    createLayer("ellipse", { id: "dot", name: "Dot" }),
    createLayer("group", { id: "group", name: "Group" }),
  ]);
  const envelope = throughClipboard(copyAnimations(document, "main", ["fade", "tint"]));

  // An image has no fill: it gets the Fade In, and only the Color is skipped.
  const alone = pasteAnimations(document, "main", ["image"], envelope, 2);
  const image = sceneLayers(alone.document).find((layer) => layer.id === "image");
  assert.deepEqual(image.animations.map((item) => [item.name, item.start]), [["Fade in", 2]]);
  assert.deepEqual(alone.pasted, [{ layerId: "image", animationIds: [image.animations[0].id] }]);
  assert.deepEqual(alone.skipped, [{ layerId: "image", name: "Image", animation: "Color", reason: "Paste a Color animation onto a shape, path, text, or group layer." }]);

  // Together with an ellipse, the ellipse gets both and the image still gets its Fade In.
  const both = pasteAnimations(document, "main", ["image", "dot"], envelope, 2);
  const layers = sceneLayers(both.document);
  assert.deepEqual(layers.find((layer) => layer.id === "image").animations.map((item) => item.name), ["Fade in"]);
  assert.deepEqual(layers.find((layer) => layer.id === "dot").animations.map((item) => [item.name, item.start]), [["Fade in", 2], ["Color", 2.5]]);
  assert.deepEqual(both.pasted.map((item) => [item.layerId, item.animationIds.length]), [["image", 1], ["dot", 2]]);
  assert.equal(both.skipped.length, 1);

  const groupCopy = pasteAnimations(document, "main", ["group"], envelope, 2);
  const group = sceneLayers(groupCopy.document).find((layer) => layer.id === "group");
  assert.deepEqual(group.animations.map((item) => item.name), ["Fade in", "Color"]);
  assert.equal(group.fillEnabled, false, "pasting Color does not enable a group fill");
  assert.equal(groupCopy.skipped.length, 0);

  // Only when no copied animation fits any selected layer does the paste fail.
  const onlyColor = throughClipboard(copyAnimations(document, "main", ["tint"]));
  assert.throws(() => pasteAnimations(document, "main", ["image"], onlyColor, 0), /^Error: Paste a Color animation onto a shape, path, text, or group layer\.$/);
});

test("a layer pasted outside an animated group says it no longer follows that group", () => {
  const group = createLayer("group", { id: "g", name: "Spinner", x: 100, y: 100, width: 200, height: 200, rotation: 30, scaleX: 1.5, scaleY: 1.5 });
  group.animations = [presetAnimation("rotate", group, 0)];
  const document = parseDocument(createDocument({
    scenes: [
      createScene({ id: "main", layers: [group, createLayer("rectangle", { id: "c", name: "Child", parentId: "g" })] }),
      createScene({ id: "two", layers: [] }),
    ],
  }));
  const envelope = throughClipboard(copyLayers(document, "main", ["c"]));
  const outside = pasteLayers(document, "two", envelope);
  assert.equal(outside.notes.length, 1);
  assert.match(outside.notes[0], /“Child” was pasted outside its group “Spinner”, so it doesn't get what that group does to it: the group is animated\./);
  assert.deepEqual(pasteLayers(document, "main", envelope).notes, [], "pasted back into the same group, it follows the group");
  const still = documentWith([createLayer("group", { id: "g", name: "Still", rotation: 30 }), createLayer("rectangle", { id: "c", parentId: "g" })]);
  assert.deepEqual(pasteLayers(documentWith([]), "main", copyLayers(still, "main", ["c"])).notes, [], "a group that only places its layers needs no note");
  const faded = documentWith([createLayer("group", { id: "g", name: "Faded", opacity: 0.5 }), createLayer("rectangle", { id: "c", name: "Child", parentId: "g" })]);
  assert.match(pasteLayers(documentWith([]), "main", copyLayers(faded, "main", ["c"])).notes[0], /the group has opacity below 100%/);
  const forged = hostile([{ ...createLayer("rectangle"), id: "a", parentId: "gone" }], { roots: [{ id: "a", world: { x: 1 }, groupEffect: { group: 7, effect: "<b>" } }] });
  assert.deepEqual(pasteLayers(documentWith([]), "main", forged).notes, [], "a damaged note is left out");
});

test("a pasted Hide or Show that would land past the scene's end is skipped with a reason", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "from", animations: [fade("fade", 0), { id: "hide", name: "Hide", kind: "hide", start: 1 }, { id: "show", name: "Show", kind: "show", start: 3 }] }),
    createLayer("rectangle", { id: "to" }),
  ]);
  const duration = document.scenes[0].duration;
  const envelope = throughClipboard(copyAnimations(document, "main", ["fade", "hide", "show"]));
  // The Fade lands at the cursor, the Hide 1 s later; the Show (3 s later) would be past the end.
  const at = duration - 2;
  const result = pasteAnimations(document, "main", ["to"], envelope, at);
  const pasted = sceneLayers(result.document).find((layer) => layer.id === "to").animations;
  assert.deepEqual(pasted.map((item) => [item.kind, item.start]), [["in", at], ["hide", at + 1]]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].animation, "Show");
  assert.match(result.skipped[0].reason, /outside the scene/);
});

test("copying a script layer carries the pictures in its image inputs", () => {
  const script = "export default function setup() { return function draw() {}; }";
  const plot = createLayer("script", { id: "plot", name: "plot", script, inputs: [{ key: "photo", type: "image" }, { key: "empty", type: "image" }], values: { photo: IMAGE, empty: "" } });
  const envelope = throughClipboard(copyLayers(documentWith([plot]), "main", ["plot"]));
  assert.deepEqual(envelope.media.map((item) => [item.src, item.type, item.name]), [[IMAGE, "image", "plot"]]);
});

test("a piece wraps a clipboard envelope: its line, needs and a trial paste that refuses damaged data", () => {
  const caption = createLayer("text", { id: "caption", name: "caption", text: "Hi", x: 0, y: 0, width: 100, height: 40, animations: [fade("a1", 0.5)] });
  const logo = createLayer("image", { id: "logo", name: "logo", src: IMAGE, x: 0, y: 50, width: 40, height: 40 });
  const envelope = throughClipboard(copyLayers(documentWith([caption, logo]), "main", ["caption", "logo"]));
  const piece = buildPiece({ name: "Lower third", envelope, canvas: { width: 1920, height: 1080 } });
  assert.deepEqual([piece.kind, piece.layerCount, piece.length, piece.media.map((item) => item.id)], ["layers", 2, 1, [IMAGE.slice("/api/media/".length)]]);
  assert.equal(pieceLine(piece), "Lower third (layers caption, logo): 1920x1080, 1s, 2 layers, needs 0 fonts and 1 media");
  assert.ok(pieceLine({ ...piece, name: "x".repeat(200) }).length <= 120);
  assert.equal(checkPiece(piece).name, "Lower third");
  assert.throws(() => checkPiece({ ...piece, envelope: { ...envelope, layers: [{ id: "a", type: "banana" }] } }), /contents are not valid/);
  assert.throws(() => checkPiece({ ...piece, format: "other" }), /not a kino piece file/);
});
