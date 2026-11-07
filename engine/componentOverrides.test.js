import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { createComponentInstance, detachComponent, expandComponents } from "./linkedComponents.js";
import { presetAnimation, evaluateLayer } from "./animation.js";
import { resizeTextLayer } from "./textLayout.js";
import { getScenePlaybackDuration } from "./playback.js";
import { copyLayers, pasteLayers } from "./layerClipboard.js";
import { applyOperations } from "./operations.js";
import {
  COMPONENT_OVERRIDE_KEYS,
  applyComponentOverrides,
  mergeOverrides,
  overridableKeys,
  overrideReferenceLayers,
  overridesUnder,
  remapComponentOverrides,
} from "./componentOverrides.js";

// A main component "card" with a rectangle "box" and a text "title", placed once in "main" as
// the instance "card-1". `overrides` become the instance's componentOverrides.
function cardScenes({ overrides, title = {}, box = {} } = {}) {
  const card = createScene({
    id: "card", name: "Card", isComponent: true, width: 240, height: 120,
    layers: [
      createLayer("rectangle", { id: "box", name: "Box", x: 0, y: 0, width: 100, height: 50, fill: "#ff0000", ...box }),
      createLayer("text", { id: "title", name: "Title", x: 20, y: 60, width: 200, height: 60, text: "Hello", fill: "#111111", ...title }),
    ],
  });
  const instance = createComponentInstance(card, { id: "card-1", x: 10, y: 10, ...(overrides ? { componentOverrides: overrides } : {}) });
  return [card, createScene({ id: "main", name: "Main", layers: [instance] })];
}
const documentWith = (scenes) => parseDocument(createDocument({ scenes }));
const cardDocument = (options) => documentWith(cardScenes(options));
const instanceOf = (document, sceneId = "main", id = "card-1") =>
  document.scenes.find((scene) => scene.id === sceneId).layers.find((layer) => layer.id === id);
const drawn = (document, componentPath, sceneId = "main") =>
  expandComponents(document, sceneId).layers.find((layer) => layer.componentPath === componentPath);

test("component instances inherit and track the path fill rule from their main component", () => {
  const master = createScene({
    id: "path-master", name: "Path master", isComponent: true,
    layers: [createLayer("path", {
      id: "compound", path: "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z",
      fillRule: "evenodd",
    })],
  });
  const page = createScene({
    id: "main",
    layers: [createComponentInstance(master, { id: "instance" })],
  });
  const document = documentWith([master, page]);
  assert.equal(drawn(document, "compound").fillRule, "evenodd");

  const updated = applyOperations(document, [{
    type: "update_layer", sceneId: "path-master", layerId: "compound",
    properties: { fillRule: "nonzero" },
  }]);
  assert.equal(drawn(updated, "compound").fillRule, "nonzero", "the instance follows its source rule live");
});

// "badge" has a text "label"; "card" holds the instance "badge-1" of it, whose own overrides
// change the label's text and fill; "main" holds the instance "card-1" of "card".
function nestedScenes({ outer, inner = { label: { text: "Card says", fill: "#00ff00" } } } = {}) {
  const badge = createScene({
    id: "badge", name: "Badge", isComponent: true, width: 80, height: 40,
    layers: [createLayer("text", { id: "label", name: "Label", width: 80, height: 40, text: "Inner", fill: "#000000" })],
  });
  const card = createScene({
    id: "card", name: "Card", isComponent: true, width: 200, height: 100,
    layers: [createComponentInstance(badge, { id: "badge-1", x: 5, y: 5, componentOverrides: inner })],
  });
  const main = createScene({ id: "main", name: "Main", layers: [createComponentInstance(card, { id: "card-1", ...(outer ? { componentOverrides: outer } : {}) })] });
  return [badge, card, main];
}

test("overridable properties depend on the layer type", () => {
  assert.ok(overridableKeys({ type: "text" }).includes("text"));
  assert.ok(overridableKeys({ type: "text" }).includes("fill"));
  assert.ok(!overridableKeys({ type: "rectangle" }).includes("text"));
  assert.ok(overridableKeys({ type: "rectangle" }).includes("cornerRadii"));
  assert.ok(overridableKeys({ type: "image" }).includes("src"));
  assert.ok(overridableKeys({ type: "image" }).includes("width"));
  assert.ok(overridableKeys({ type: "image" }).includes("cornerRadii"));
  assert.ok(overridableKeys({ type: "group" }).includes("clipContent"));
  assert.ok(!overridableKeys({ type: "image" }).includes("clipContent"));
  assert.ok(!overridableKeys({ type: "group" }).includes("width"), "a group's size comes from the main component");
  assert.ok(!overridableKeys({ type: "path" }).includes("width"));
  assert.ok(!overridableKeys({ type: "component" }).includes("width"), "a nested instance takes its main component's size");
  assert.ok(overridableKeys({ type: "audio" }).includes("volume"));
  for (const key of ["id", "type", "parentId", "animations", "playbackWindows", "path", "locked", "lockAspect", "isMask", "textResize", "scaleX", "scaleY", "skewX", "mediaStart", "mediaDuration", "componentSceneId", "componentOverrides", "componentPath"])
    assert.ok(!COMPONENT_OVERRIDE_KEYS.includes(key), `${key} is never overridable`);
});

test("a text override shows while the instance's other properties follow the main component live", () => {
  const document = cardDocument({ overrides: { title: { text: "Bye" } } });
  const title = drawn(document, "title");
  assert.equal(title.text, "Bye");
  assert.equal(title.fill, "#111111");
  assert.equal(title.componentOverridden, true);
  assert.equal(drawn(document, "box").componentOverridden, false);
  assert.equal(document.scenes[0].layers[1].text, "Hello", "the main component keeps its own text");

  // Editing the main component changes everything the instance doesn't override.
  const edited = structuredClone(document);
  edited.scenes[0].layers[1].fill = "#0000ff";
  edited.scenes[0].layers[1].text = "Hi";
  edited.scenes[0].layers[1].fontSize = 20;
  const after = drawn(parseDocument(edited), "title");
  assert.equal(after.fill, "#0000ff");
  assert.equal(after.fontSize, 20);
  assert.equal(after.text, "Bye", "the overridden text stays");
});

test("changing the main component's fill still updates an instance with overridden text", () => {
  const before = cardDocument({ overrides: { title: { text: "Bye" } }, box: { fill: "#ff0000" } });
  assert.equal(drawn(before, "box").fill, "#ff0000");
  const after = parseDocument({ ...before, scenes: [{ ...before.scenes[0], layers: [{ ...before.scenes[0].layers[0], fill: "#00ff00" }, before.scenes[0].layers[1]] }, before.scenes[1]] });
  assert.equal(drawn(after, "box").fill, "#00ff00");
  assert.equal(drawn(after, "title").text, "Bye");
});

test("an override equal to the main component's value is removed", () => {
  const document = cardDocument({ overrides: { title: { text: "Hello", fill: "#222222" }, box: { fill: "#ff0000" } } });
  assert.deepEqual(instanceOf(document).componentOverrides, { title: { fill: "#222222" } });
  const unchanged = cardDocument({ overrides: { title: { text: "Hello" } } });
  assert.equal(Object.hasOwn(instanceOf(unchanged), "componentOverrides"), false, "an empty map is left out");
});

test("visible: false on a group of the main component hides the layers inside it", () => {
  const card = createScene({
    id: "card", name: "Card", isComponent: true, width: 100, height: 100,
    layers: [
      createLayer("group", { id: "g", name: "Group", width: 100, height: 100 }),
      createLayer("rectangle", { id: "inside", name: "Inside", parentId: "g", width: 10, height: 10 }),
    ],
  });
  const main = createScene({ id: "main", layers: [createComponentInstance(card, { id: "card-1", componentOverrides: { g: { visible: false } } })] });
  const document = documentWith([card, main]);
  assert.equal(drawn(document, "g").visible, false);
  assert.equal(drawn(document, "inside").visible, false);
  assert.equal(drawn(documentWith([card, createScene({ id: "main", layers: [createComponentInstance(card, { id: "card-1" })] })]), "inside").visible, true);
});

test("a nested path applies, and the outer instance's value beats the nested instance's own", () => {
  const plain = documentWith(nestedScenes());
  assert.equal(drawn(plain, "badge-1/label").text, "Card says", "the nested instance's own override");
  const document = documentWith(nestedScenes({ outer: { "badge-1/label": { text: "Outer" } } }));
  const label = drawn(document, "badge-1/label");
  assert.equal(label.text, "Outer");
  assert.equal(label.fill, "#00ff00", "properties the outer instance doesn't set come from the nested instance");
  assert.equal(label.componentOverridden, true);
  assert.equal(drawn(plain, "badge-1/label").componentOverridden, false, "a nested instance's own override isn't the top instance's");
  const wrapper = drawn(document, "badge-1");
  assert.equal(wrapper.type, "group");
  assert.equal(wrapper.componentOverridden, false);
  const scene = expandComponents(document, "main");
  const top = scene.layers.find((layer) => layer.id === "card-1");
  assert.equal(Object.hasOwn(top, "componentPath"), false, "the top wrapper has no path");
  assert.equal(scene.layers.filter((layer) => layer.componentBackground).some((layer) => Object.hasOwn(layer, "componentPath")), false);
  // An outer value equal to what the nested instance shows is dropped.
  const same = documentWith(nestedScenes({ outer: { "badge-1/label": { text: "Card says" } } }));
  assert.equal(Object.hasOwn(instanceOf(same), "componentOverrides"), false);
  // The nested instance itself can be moved or hidden.
  const moved = documentWith(nestedScenes({ outer: { "badge-1": { x: 50 } } }));
  assert.equal(drawn(moved, "badge-1").x, 50);
  assert.equal(drawn(moved, "badge-1").componentOverridden, true);
});

test("an outer override equal to the main layer still marks it as overridden when it replaces a nested value", () => {
  const document = documentWith(nestedScenes({
    inner: { label: { text: "Card says" } },
    outer: { "badge-1/label": { text: "Inner" } },
  }));
  const instance = instanceOf(document);
  const label = drawn(document, "badge-1/label");

  assert.deepEqual(instance.componentOverrides, { "badge-1/label": { text: "Inner" } });
  assert.equal(label.text, "Inner");
  assert.equal(label.componentOverridden, true);
});

test("an x override moves a slide-in animation along with the layer", () => {
  const scenes = cardScenes();
  const box = scenes[0].layers[0];
  box.x = 100;
  box.animations = [{ ...presetAnimation("slide-right", box, 0, scenes[0]), id: "slide" }];
  const plain = documentWith(scenes);
  scenes[1].layers[0].componentOverrides = { box: { x: 140 } };
  const moved = documentWith(scenes);
  const animation = box.animations[0];
  const end = animation.start + animation.duration;
  const half = animation.start + animation.duration / 2;
  const at = (document, time) => evaluateLayer(drawn(document, "box"), time).x;
  assert.equal(at(moved, end), 140, "the slide ends at the overridden place");
  assert.ok(Math.abs(at(moved, half) - (at(plain, half) + 40)) < 1e-9, "the whole motion moves by the same amount");
  assert.equal(moved.scenes[0].layers[0].animations[0].to.x, 100, "the main component keeps its own motion");
  // Other overrides change only the resting value.
  scenes[1].layers[0].componentOverrides = { box: { opacity: 0.5 } };
  assert.deepEqual(drawn(documentWith(scenes), "box").animations[0].from, drawn(plain, "box").animations[0].from);
});

test("drawn IDs are the same with and without overrides", () => {
  const ids = (document) => expandComponents(document, "main").layers.map((layer) => layer.id);
  assert.deepEqual(ids(documentWith(nestedScenes({ outer: { "badge-1/label": { text: "Other" }, "badge-1": { visible: false } } }))), ids(documentWith(nestedScenes())));
  assert.deepEqual(ids(cardDocument({ overrides: { title: { text: "Bye" }, box: { x: 30 } } })), ids(cardDocument()));
});

test("centred auto-width text keeps its centre after a longer override", () => {
  const source = createLayer("text", { id: "title", name: "Title", x: 0, y: 40, text: "Hi", textAlign: "center", textResize: "width-height", fontSize: 24 });
  Object.assign(source, resizeTextLayer(source));
  source.x = 120 - source.width / 2;
  const scenes = cardScenes();
  scenes[0].layers[1] = source;
  scenes[1].layers[0].componentOverrides = { title: { text: "A much longer title" } };
  const document = documentWith(scenes);
  const shown = resizeTextLayer(drawn(document, "title"));
  assert.ok(shown.width > source.width + 50, "the text refit to the longer string");
  assert.ok(Math.abs(shown.x + shown.width / 2 - 120) < 1e-6, `the centre stays at 120 (got ${shown.x + shown.width / 2})`);
});

test("broken overrides are refused with a clear path", () => {
  const refuses = (overrides, pattern) => assert.throws(() => cardDocument({ overrides }), pattern);
  refuses({ title: { animations: [] } }, /componentOverrides\["title"\]\.animations: can't be overridden/);
  refuses({ "a b": { text: "x" } }, /componentOverrides\["a b"\]: is not a component path/);
  refuses({ [Array.from({ length: 18 }, () => "a").join("/")]: { text: "x" } }, /names 18 layers; a path names at most 17/);
  refuses(Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`layer-${index}`, { name: "x" }])), /cannot hold more than 500 component paths/);
  refuses({ title: { opacity: 2 } }, /componentOverrides\["title"\]\.opacity/);
  refuses({ title: {} }, /at least one overridden property/);
  refuses({ title: "Bye" }, /at least one overridden property/);
  refuses({ "a//b": { text: "x" } }, /an empty part/);
  for (const value of [null, [], "title"]) {
    const broken = cardScenes();
    broken[1].layers[0].componentOverrides = value;
    assert.throws(() => documentWith(broken), /componentOverrides: must be an object of component paths/, `${JSON.stringify(value)} is refused`);
  }
  const scenes = cardScenes();
  scenes[0].layers[0].componentOverrides = { title: { text: "x" } };
  assert.throws(() => documentWith(scenes), /only a component instance can override/);
});

test("a document holds at most 10,000 overrides", () => {
  const scenes = cardScenes();
  const paths = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`gone-${index}`, { name: "x" }]));
  const many = Array.from({ length: 21 }, (_, index) => createComponentInstance(scenes[0], { id: `copy-${index}`, componentOverrides: paths }));
  scenes[1].layers.push(...many);
  assert.throws(() => documentWith(scenes), /cannot hold more than 10000 component overrides/);
});

test("overrides that no longer mean anything are dropped", () => {
  const document = cardDocument({ overrides: { gone: { text: "x" }, box: { text: "x" }, title: { text: "Bye", src: "/api/media/a.png" } } });
  assert.deepEqual(instanceOf(document).componentOverrides, { title: { text: "Bye" } }, "a stale path, text on a rectangle, and src on a text are dropped");
  assert.equal(Object.hasOwn(instanceOf(cardDocument({ overrides: { gone: { text: "x" } } })), "componentOverrides"), false);
  // Deleting the layer from the main component drops its override on the next read.
  const removed = structuredClone(cardDocument({ overrides: { title: { text: "Bye" }, box: { fill: "#000000" } } }));
  removed.scenes[0].layers.splice(1, 1);
  assert.deepEqual(instanceOf(parseDocument(removed)).componentOverrides, { box: { fill: "#000000" } });
  // A path through a layer that isn't an instance leads nowhere.
  assert.equal(Object.hasOwn(instanceOf(cardDocument({ overrides: { "box/title": { text: "x" } } })), "componentOverrides"), false);
});

test("an image src override keeps the main component's box, and mediaSourceDuration goes only with src", () => {
  const card = createScene({
    id: "card", name: "Card", isComponent: true, width: 100, height: 100,
    layers: [createLayer("image", { id: "photo", name: "Photo", width: 60, height: 40, src: "/api/media/aaaa.png" })],
  });
  const main = createScene({ id: "main", layers: [createComponentInstance(card, { id: "card-1", componentOverrides: { photo: { src: "/api/media/bbbb.gif", mediaSourceDuration: 2 } } })] });
  const document = documentWith([card, main]);
  const photo = drawn(document, "photo");
  assert.equal(photo.src, "/api/media/bbbb.gif");
  assert.equal(photo.mediaSourceDuration, 2);
  assert.deepEqual([photo.width, photo.height], [60, 40]);
  assert.equal(photo.mediaDuration, 0, "Play comes from the main component, so this GIF shows its first frame");
  const alone = documentWith([card, createScene({ id: "main", layers: [createComponentInstance(card, { id: "card-1", componentOverrides: { photo: { mediaSourceDuration: 2 } } })] })]);
  assert.equal(Object.hasOwn(instanceOf(alone), "componentOverrides"), false, "mediaSourceDuration without src is dropped");
  assert.deepEqual(overrideReferenceLayers(document), [{ type: "image", name: "Photo", src: "/api/media/bbbb.gif", fontSource: "", fontFamily: "Inter", fontStyle: "normal", fontWeight: 400, mediaSourceDuration: 2 }]);
});

test("font overrides are listed with the whole font of the text they change", () => {
  const document = cardDocument({ title: { fontWeight: 700 }, overrides: { title: { fontFamily: "Brand", fontSource: "/api/media/0123abcd-0000-4000-8000-000000000001.woff2" } } });
  const [reference] = overrideReferenceLayers(document);
  assert.deepEqual([reference.type, reference.fontFamily, reference.fontWeight, reference.fontStyle, reference.fontSource], ["text", "Brand", 700, "normal", "/api/media/0123abcd-0000-4000-8000-000000000001.woff2"]);
  assert.deepEqual(overrideReferenceLayers(cardDocument({ overrides: { title: { text: "Bye" } } })), [], "a text change uses no new file");
});

test("detaching bakes the overrides into ordinary layers with no component data", () => {
  const document = documentWith(nestedScenes({ outer: { "badge-1/label": { text: "Outer" } } }));
  const detached = parseDocument(detachComponent(document, "main", "card-1"));
  const layers = detached.scenes.find((scene) => scene.id === "main").layers;
  assert.ok(layers.some((layer) => layer.type === "text" && layer.text === "Outer" && layer.fill === "#00ff00"));
  for (const layer of layers)
    for (const key of ["componentPath", "componentOverridden", "componentOverrides", "componentOwnerId", "componentSceneId"])
      assert.equal(Object.hasOwn(layer, key), false, `${layer.name} has no ${key}`);
});

test("copy and paste keep overrides, rename their paths with a copied main component, and strip drawing-only fields", () => {
  const source = documentWith(nestedScenes({ outer: { "badge-1/label": { text: "Outer" } } }));
  const envelope = copyLayers(source, "main", ["card-1"]);
  assert.deepEqual(envelope.layers[0].componentOverrides, { "badge-1/label": { text: "Outer" } });

  // Into another file: both main components are added with new layer IDs, and the path follows them.
  const other = documentWith([createScene({ id: "elsewhere", name: "Elsewhere" })]);
  const pasted = pasteLayers(other, "elsewhere", envelope);
  const instance = pasted.document.scenes[0].layers[0];
  const card = pasted.document.scenes.find((scene) => scene.id === instance.componentSceneId);
  const nested = card.layers[0];
  const badge = pasted.document.scenes.find((scene) => scene.id === nested.componentSceneId);
  assert.notEqual(nested.id, "badge-1");
  assert.deepEqual(instance.componentOverrides, { [`${nested.id}/${badge.layers[0].id}`]: { text: "Outer" } });
  assert.deepEqual(Object.keys(nested.componentOverrides), [badge.layers[0].id], "the nested instance's own paths follow too");
  assert.equal(drawn(pasted.document, `${nested.id}/${badge.layers[0].id}`, "elsewhere").text, "Outer");

  // Into the same file: the instance links to the main component already there and keeps its paths.
  const again = pasteLayers(source, "main", envelope);
  const copy = again.document.scenes.find((scene) => scene.id === "main").layers.find((layer) => layer.id !== "card-1");
  assert.equal(copy.componentSceneId, "card");
  assert.deepEqual(copy.componentOverrides, { "badge-1/label": { text: "Outer" } });

  // Drawing-only fields on a copied layer are never stored.
  const drawnEnvelope = structuredClone(envelope);
  Object.assign(drawnEnvelope.layers[0], { componentPath: "x", componentOverridden: true });
  const stored = pasteLayers(other, "elsewhere", drawnEnvelope).document.scenes[0].layers[0];
  assert.equal(Object.hasOwn(stored, "componentPath"), false);
  assert.equal(Object.hasOwn(stored, "componentOverridden"), false);
  // A damaged clipboard with overrides on a layer that isn't an instance is refused.
  const damaged = structuredClone(envelope);
  damaged.layers = [{ ...createLayer("rectangle", { id: "r", name: "R" }), componentOverrides: { a: { name: "x" } } }];
  damaged.roots = [{ id: "r", parentId: null }];
  damaged.components = [];
  assert.throws(() => pasteLayers(other, "elsewhere", damaged), /can't be pasted:.*only a component instance can override/);
});

test("copying lists the pictures and fonts the overrides use", () => {
  const document = cardDocument({ overrides: { title: { fontFamily: "Brand", fontSource: "/api/media/0123abcd-0000-4000-8000-000000000001.woff2" } } });
  const envelope = copyLayers(document, "main", ["card-1"]);
  assert.ok(envelope.media.some((item) => item.src === "/api/media/0123abcd-0000-4000-8000-000000000001.woff2" && item.type === "font"));
  assert.ok(envelope.fonts.some((font) => font.family === "Brand" && font.src === "/api/media/0123abcd-0000-4000-8000-000000000001.woff2"));
  const pasted = pasteLayers(documentWith([createScene({ id: "elsewhere" })]), "elsewhere", envelope);
  assert.ok(pasted.media.some((item) => item.src === "/api/media/0123abcd-0000-4000-8000-000000000001.woff2"));
  assert.ok(pasted.textLayers.some((layer) => layer.fontFamily === "Brand"), "the paste checks the overridden font is loaded");
});

test("an overridden text lengthens the instance's Play window", () => {
  const scenes = cardScenes({ title: { text: "Hi" } });
  const title = scenes[0].layers[1];
  title.animations = [{ id: "letters", name: "Letters", kind: "in", start: 0, duration: 0.5, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 }, unit: "letters", stagger: 0.1, order: "forward" }];
  const plain = documentWith(scenes);
  assert.ok(Math.abs(getScenePlaybackDuration(plain, "card") - 0.6) < 1e-9);
  scenes[1].layers[0].componentOverrides = { title: { text: "Hello" } };
  const longer = documentWith(scenes);
  const overrides = instanceOf(longer).componentOverrides;
  assert.ok(Math.abs(getScenePlaybackDuration(longer, "card", undefined, overrides) - 0.9) < 1e-9);
  assert.ok(Math.abs(getScenePlaybackDuration(longer, "card") - 0.6) < 1e-9, "the main component itself is unchanged");
  const wrapper = expandComponents(longer, "main").layers.find((layer) => layer.id === "card-1");
  assert.ok(Math.abs(wrapper.playbackWindows.at(-1).end - 0.9) < 1e-9);
  // Through a nested instance too.
  const nested = nestedScenes({ outer: { "badge-1/label": { text: "Outer text" } } });
  nested[0].layers[0].animations = [{ ...title.animations[0], id: "nested-letters" }];
  const document = documentWith(nested);
  // Letters don't count spaces: "Outer text" has 9 and "Card says" 8.
  assert.ok(Math.abs(getScenePlaybackDuration(document, "card", undefined, instanceOf(document).componentOverrides) - (0.5 + 0.1 * 8)) < 1e-9);
  assert.ok(Math.abs(getScenePlaybackDuration(document, "card") - (0.5 + 0.1 * 7)) < 1e-9, "the nested instance's own text");
});

test("set_component_overrides refuses what can't be overridden", () => {
  const document = cardDocument();
  const set = (overrides, extra = {}) => () => applyOperations(document, [{ type: "set_component_overrides", sceneId: "main", layerId: "card-1", overrides, ...extra }]);
  assert.throws(set({ missing: { text: "x" } }), /no layer at component path "missing" in the main component "Card"/);
  assert.throws(set({ box: { text: "x" } }), /"text" can't be overridden on the rectangle layer "box"/);
  assert.throws(set({ title: { animations: [] } }), /"animations" can't be overridden/);
  assert.throws(set({ "a b": { text: "x" } }), /is not a component path/);
  assert.throws(set({ title: {} }), /at least one property/);
  assert.throws(set({ title: { opacity: 2 } }), /opacity/);
  assert.throws(set("title"), /needs overrides/);
  assert.throws(set({ title: { text: "x" } }, { replace: "yes" }), /replace must be true or false/);
  assert.throws(() => applyOperations(document, [{ type: "set_component_overrides", sceneId: "card", layerId: "title", overrides: { title: { text: "x" } } }]), /needs layerId: the ID of a component instance/);
  assert.throws(() => applyOperations(document, [{ type: "reset_component_overrides", sceneId: "card", layerId: "title" }]), /needs layerId: the ID of a component instance/);
  assert.throws(() => applyOperations(document, [{ type: "reset_component_overrides", sceneId: "main", layerId: "card-1", componentPaths: "title" }]), /must be null/);
  assert.throws(() => applyOperations(document, [{ type: "reset_component_overrides", sceneId: "main", layerId: "card-1", componentPaths: ["a b"] }]), /is not a component path/);
  const image = documentWith([
    createScene({ id: "card", isComponent: true, layers: [createLayer("image", { id: "photo", name: "Photo", src: "/api/media/aaaa.png" })] }),
    createScene({ id: "main", layers: [{ ...createLayer("component", { id: "card-1", componentSceneId: "card" }) }] }),
  ]);
});

test("the resolver helpers apply one level at a time and keep unchanged objects", () => {
  const layers = [{ id: "a", type: "rectangle", x: 0, y: 0, fill: "#000000" }, { id: "b", type: "text", text: "Hi" }];
  assert.equal(applyComponentOverrides(layers, {}), layers);
  assert.equal(applyComponentOverrides(layers, { a: { fill: "#000000" } }), layers, "an equal value changes nothing");
  assert.equal(applyComponentOverrides(layers, { "a/b": { fill: "#ffffff" } }), layers, "deeper paths belong to nested instances");
  const changed = applyComponentOverrides(layers, { b: { text: "Yo", animations: [] } });
  assert.equal(changed[0], layers[0]);
  assert.deepEqual(changed[1], { id: "b", type: "text", text: "Yo" }, "only allowed keys apply");
  assert.deepEqual(overridesUnder({ "x/y": { a: 1 }, "x/y/z": { b: 2 }, x: { c: 3 }, "xy/z": { d: 4 } }, "x"), { y: { a: 1 }, "y/z": { b: 2 } });
  assert.deepEqual(mergeOverrides({ a: { x: 1, y: 1 } }, { a: { y: 2 }, b: { z: 3 } }), { a: { x: 1, y: 2 }, b: { z: 3 } });
  const scenes = new Map([["s", { id: "s", layers: [{ id: "inner", type: "component", componentSceneId: "t" }] }], ["t", { id: "t", layers: [{ id: "leaf", type: "text" }] }]]);
  const ids = new Map([["s", new Map([["inner", "inner-2"]])], ["t", new Map([["leaf", "leaf-2"]])]]);
  assert.deepEqual(remapComponentOverrides({ "inner/leaf": { text: "x" }, inner: { x: 1 } }, "s", scenes, ids), { "inner-2/leaf-2": { text: "x" }, "inner-2": { x: 1 } });
  assert.deepEqual(remapComponentOverrides({ "inner/leaf": { text: "x" } }, "s", scenes, new Map([["t", ids.get("t")]])), { "inner/leaf": { text: "x" } }, "a linked scene keeps its paths and everything under them");
});

test("set_component_overrides merges or replaces, and reset_component_overrides removes paths", () => {
  const document = documentWith(nestedScenes());
  const set = (overrides, replace) => applyOperations(document, [{ type: "set_component_overrides", sceneId: "main", layerId: "card-1", overrides, ...(replace === undefined ? {} : { replace }) }]);
  const first = set({ "badge-1/label": { text: "One" }, "badge-1": { x: 40 } });
  const merged = applyOperations(first, [{ type: "set_component_overrides", sceneId: "main", layerId: "card-1", overrides: { "badge-1/label": { fill: "#123456" } } }]);
  assert.deepEqual(instanceOf(merged).componentOverrides, { "badge-1/label": { text: "One", fill: "#123456" }, "badge-1": { x: 40 } });
  const replaced = applyOperations(merged, [{ type: "set_component_overrides", sceneId: "main", layerId: "card-1", overrides: { "badge-1/label": { opacity: 0.5 } }, replace: true }]);
  assert.deepEqual(instanceOf(replaced).componentOverrides, { "badge-1/label": { opacity: 0.5 } });

  const reset = (from, componentPaths) => applyOperations(from, [{ type: "reset_component_overrides", sceneId: "main", layerId: "card-1", componentPaths }]);
  assert.deepEqual(instanceOf(reset(merged, ["badge-1/label"])).componentOverrides, { "badge-1": { x: 40 } });
  assert.equal(Object.hasOwn(instanceOf(reset(merged, ["badge-1"])), "componentOverrides"), false, "a path also resets the deeper paths under it");
  assert.equal(Object.hasOwn(instanceOf(reset(merged, null)), "componentOverrides"), false);
  assert.equal(Object.hasOwn(instanceOf(reset(merged)), "componentOverrides"), false);
  assert.deepEqual(instanceOf(reset(merged, ["badge"])).componentOverrides, instanceOf(merged).componentOverrides, "a path is matched by whole layer IDs");

  // The exported helpers do the same.
  assert.equal(instanceOf(document).componentOverrides, undefined, "the original document is unchanged");
});
