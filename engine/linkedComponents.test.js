import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument, createDocument, createLayer, createScene } from "./model.js";
import {
  createComponentInstance,
  detachComponent,
  expandComponents,
} from "./linkedComponents.js";

test("component backgrounds inherit Fill off, gradients and offset Color animations with stable expanded and fresh detached IDs", () => {
  const gradient = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
  const color = { id: "source-bg-color", name: "Color", kind: "custom", start: 0.25, duration: 1, easing: "linear", from: { fill: "#ffffff" }, to: { fill: gradient } };
  const source = createScene({ id: "gradient-component", isComponent: true, background: gradient, backgroundEnabled: false, backgroundAnimations: [color] });
  const instance = createComponentInstance(source, { id: "gradient-instance", componentStart: 0.5 });
  const document = parseDocument(createDocument({ scenes: [source, createScene({ id: "main-gradient", layers: [instance] })] }));
  const expanded = expandComponents(document, "main-gradient");
  const background = expanded.layers.find((layer) => layer.componentBackground);
  assert.equal(background.fillEnabled, false);
  assert.deepEqual(background.fill, gradient);
  assert.equal(background.animations[0].start, 0.75);
  assert.notEqual(background.animations[0].id, color.id);
  assert.deepEqual(expandComponents(document, "main-gradient"), expanded);
  const detached = detachComponent(document, "main-gradient", instance.id);
  const detachedBackground = detached.scenes.find((scene) => scene.id === "main-gradient").layers.find((layer) => layer.name === `${source.name} Background`);
  assert.equal(detachedBackground.fillEnabled, false);
  assert.deepEqual(detachedBackground.fill, gradient);
  assert.equal(detachedBackground.animations[0].start, 0.75);
  assert.notEqual(detachedBackground.id, background.id);
  assert.notEqual(detachedBackground.animations[0].id, background.animations[0].id);
  document.scenes[0].backgroundEnabled = true;
  assert.equal(expandComponents(document, "main-gradient").layers.find((layer) => layer.componentBackground).fillEnabled, true);
});

function operation(id, start = 0) {
  return {
    id,
    name: id,
    kind: "in",
    start,
    duration: 1,
    easing: "linear",
    from: { opacity: 0 },
    to: { opacity: 1 },
    unit: "layer",
    stagger: 0,
    order: "forward",
  };
}

function documentWith(scenes) {
  return parseDocument(createDocument({ scenes }));
}

function componentScene(overrides = {}) {
  return createScene({ isComponent: true, ...overrides });
}

test("component factory pins its source and uses source dimensions", () => {
  const source = componentScene({ id: "card", name: "Card", width: 240, height: 120 });
  const instance = createComponentInstance(source, {
    id: "card-instance",
    x: 45,
    y: 60,
    width: 999,
    height: 888,
    clipContent: false,
    componentStart: 1.25,
  });
  assert.equal(instance.type, "component");
  assert.equal(instance.name, "Card");
  assert.equal(instance.componentSceneId, "card");
  assert.equal(instance.componentStart, 1.25);
  assert.equal(instance.width, 240);
  assert.equal(instance.height, 120);
  assert.equal(instance.clipContent, false);
  assert.equal(instance.x, 45);
  assert.equal(instance.y, 60);
  assert.equal(createComponentInstance(source).clipContent, true);
});

test("expansion resolves current source edits without mutating the linked document", () => {
  const source = componentScene({
    id: "badge",
    name: "Badge",
    width: 140,
    height: 56,
    background: "#f0f0f0",
    layers: [createLayer("text", { id: "label", text: "Before", x: 8, y: 5 })],
  });
  const instance = createComponentInstance(source, { id: "badge-use", x: 30, y: 40 });
  source.layers[0].text = "After source edit";
  source.width = 180;
  const document = documentWith([createScene({ id: "main", layers: [instance] }), source]);
  const before = structuredClone(document);

  const expanded = expandComponents(document, "main");
  const wrapper = expanded.layers.find((layer) => layer.id === "badge-use");
  const background = expanded.layers.find((layer) => layer.name === "Badge Background");
  const label = expanded.layers.find((layer) => layer.text === "After source edit");

  assert.equal(wrapper.type, "group");
  assert.equal(wrapper.width, 180);
  assert.equal(wrapper.height, 56);
  assert.equal(wrapper.x, 30);
  assert.equal(wrapper.clipContent, true);
  assert.equal(background.parentId, wrapper.id);
  assert.equal(background.width, 180);
  assert.equal(background.fill, "#f0f0f0");
  assert.equal(label.parentId, wrapper.id);
  assert.equal(label.componentOwnerId, wrapper.id);
  assert.deepEqual(document, before);
  assert.deepEqual(expanded.layers.map((layer) => layer.id), expandComponents(document, "main").layers.map((layer) => layer.id));
});

test("parent references resolve when a child precedes its group and clipping follows the instance", () => {
  const source = componentScene({
    id: "ordered",
    name: "Ordered",
    layers: [
      createLayer("text", { id: "early-child", parentId: "late-group", text: "Child" }),
      createLayer("group", { id: "late-group", name: "Late group" }),
    ],
  });
  const instance = createComponentInstance(source, {
    id: "unclipped-instance",
    clipContent: false,
  });
  const document = documentWith([createScene({ id: "main", layers: [instance] }), source]);
  const expanded = expandComponents(document, "main");
  const wrapper = expanded.layers.find((layer) => layer.id === instance.id);
  const child = expanded.layers.find((layer) => layer.text === "Child");
  const group = expanded.layers.find((layer) => layer.name === "Late group");

  assert.equal(wrapper.clipContent, false);
  assert.equal(child.parentId, group.id);
  assert.ok(expanded.layers.indexOf(child) < expanded.layers.indexOf(group));
});

test("a component under a hidden outer group makes its media invisible", () => {
  const source = componentScene({
    id: "media-component",
    layers: [
      createLayer("audio", {
        id: "component-audio",
        src: "/api/media/music.mp3",
      }),
    ],
  });
  const instance = createComponentInstance(source, {
    id: "nested-media-instance",
    parentId: "hidden-parent",
  });
  const hiddenParent = createLayer("group", {
    id: "hidden-parent",
    visible: false,
  });
  const document = documentWith([
    createScene({ id: "main", layers: [instance, hiddenParent] }),
    source,
  ]);
  const expanded = expandComponents(document, "main");

  assert.equal(expanded.layers.find((layer) => layer.id === instance.id).visible, false);
  assert.equal(expanded.layers.find((layer) => layer.name === "Audio").visible, false);
});

test("nested components preserve order, offsets, inherited visibility, and media timing", () => {
  const inner = componentScene({
    id: "inner",
    name: "Inner",
    width: 24,
    height: 18,
    background: "#ff0000",
    layers: [
      createLayer("video", {
        id: "inner-video",
        src: "/api/media/clip.mp4",
        mediaStart: 1,
        mediaDuration: 6,
        animations: [operation("video-operation", 0.2)],
      }),
    ],
  });
  const innerInstance = createComponentInstance(inner, {
    id: "nested-instance",
    componentStart: 0.5,
    animations: [operation("nested-operation", 0.1)],
  });
  const outer = componentScene({
    id: "outer",
    name: "Outer",
    width: 80,
    height: 40,
    background: "#00ff00",
    layers: [
      createLayer("group", {
        id: "hidden-group",
        visible: false,
        animations: [operation("group-operation", 0.25)],
      }),
      createLayer("audio", {
        id: "outer-audio",
        parentId: "hidden-group",
        src: "/api/media/music.mp3",
        mediaStart: 2,
      }),
      innerInstance,
    ],
  });
  const outerInstance = createComponentInstance(outer, {
    id: "outer-instance",
    componentStart: 2,
    visible: false,
    animations: [operation("host-operation", 0.3)],
  });
  const document = documentWith([
    createScene({ id: "main", layers: [outerInstance] }),
    outer,
    inner,
  ]);

  const expanded = expandComponents(document, "main");
  const byName = new Map(expanded.layers.map((layer) => [layer.name, layer]));
  const wrapper = byName.get("Outer");
  const outerBackground = byName.get("Outer Background");
  const hiddenGroup = expanded.layers.find((layer) => layer.name === "Group");
  const audio = expanded.layers.find((layer) => layer.name === "Audio");
  const nested = byName.get("Inner");
  const innerBackground = byName.get("Inner Background");
  const video = expanded.layers.find((layer) => layer.name === "Video");

  assert.deepEqual(
    expanded.layers.slice(0, 7).map((layer) => layer.id),
    [wrapper.id, outerBackground.id, hiddenGroup.id, audio.id, nested.id, innerBackground.id, video.id],
  );
  assert.equal(outerBackground.parentId, wrapper.id);
  assert.equal(hiddenGroup.parentId, wrapper.id);
  assert.equal(audio.parentId, hiddenGroup.id);
  assert.equal(nested.parentId, wrapper.id);
  assert.equal(innerBackground.parentId, nested.id);
  assert.equal(video.parentId, nested.id);
  assert.equal(wrapper.animations[0].start, 0.3);
  assert.equal(hiddenGroup.animations[0].start, 2.25);
  assert.equal(nested.animations[0].start, 2.1);
  assert.equal(video.animations[0].start, 2.7);
  assert.equal(audio.mediaStart, 4);
  assert.equal(video.mediaStart, 3.5);
  assert.equal(audio.visible, false);
  assert.equal(video.visible, false);
  assert.equal(nested.componentOwnerId, wrapper.id);
  assert.equal(video.componentOwnerId, wrapper.id);
});

test("detach creates an independently editable ordinary group with new descendant IDs", () => {
  const source = componentScene({
    id: "title-card",
    name: "Title card",
    width: 200,
    height: 100,
    layers: [
      createLayer("group", {
        id: "source-group",
        animations: [operation("source-group-animation", 0.5)],
      }),
      createLayer("text", {
        id: "source-text",
        parentId: "source-group",
        text: "Independent",
        animations: [operation("source-text-animation", 1)],
      }),
    ],
  });
  const instance = createComponentInstance(source, {
    id: "detached-instance",
    animations: [operation("instance-animation", 0.25)],
  });
  const otherSource = componentScene({ id: "other", name: "Other" });
  const otherInstance = createComponentInstance(otherSource, { id: "other-instance" });
  const document = documentWith([
    createScene({ id: "main", layers: [instance, otherInstance] }),
    source,
    otherSource,
  ]);
  const originalSourceLayerIds = new Set(source.layers.map((layer) => layer.id));
  const detached = detachComponent(document, "main", instance.id);
  const detachedScene = detached.scenes.find((scene) => scene.id === "main");
  const wrapper = detachedScene.layers.find((layer) => layer.id === instance.id);
  const text = detachedScene.layers.find((layer) => layer.text === "Independent");
  const sourceText = detached.scenes.find((scene) => scene.id === "title-card").layers.find((layer) => layer.id === "source-text");

  assert.equal(wrapper.type, "group");
  assert.equal(wrapper.width, 200);
  assert.equal(wrapper.animations[0].id, "instance-animation");
  assert.notEqual(text.id, "source-text");
  assert.ok(!originalSourceLayerIds.has(text.id));
  assert.notEqual(text.animations[0].id, "source-text-animation");
  assert.equal(text.parentId, detachedScene.layers.find((layer) => layer.name === "Group").id);
  const detachedIds = new Set([wrapper.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const layer of detachedScene.layers) {
      if (detachedIds.has(layer.parentId) && !detachedIds.has(layer.id)) {
        detachedIds.add(layer.id);
        changed = true;
      }
    }
  }
  const detachedSubtree = detachedScene.layers.filter((layer) => detachedIds.has(layer.id));
  assert.ok(detachedSubtree.every((layer) => layer.type !== "component"));
  assert.ok(detachedSubtree.every((layer) => !Object.hasOwn(layer, "componentOwnerId")));
  assert.ok(detachedSubtree.every((layer) => !Object.hasOwn(layer, "componentSceneId")));
  const stillLinked = detachedScene.layers.find((layer) => layer.id === "other-instance");
  assert.equal(stillLinked.type, "component");
  assert.equal(stillLinked.componentSceneId, "other");
  assert.equal(sourceText.text, "Independent");
  text.text = "Edited copy";
  assert.equal(sourceText.text, "Independent");
  assert.equal(document.scenes[0].layers[0].type, "component");
  assert.equal(parseDocument(detached).scenes[0].layers[0].type, "group");
});

test("expansion reports missing, unmarked, and recursive component sources", () => {
  const main = createScene({
    id: "main",
    layers: [createLayer("component", { id: "instance", componentSceneId: "missing" })],
  });
  const document = createDocument({ scenes: [main] });
  assert.throws(() => expandComponents(document, "main"), /missing source scene/);

  const notComponent = createScene({ id: "not-component" });
  const invalidDocument = createDocument({
    scenes: [
      createScene({
        id: "main",
        layers: [createLayer("component", { id: "instance", componentSceneId: "not-component" })],
      }),
      notComponent,
    ],
  });
  assert.throws(() => expandComponents(invalidDocument, "main"), /not marked as a component/);

  const first = componentScene({
    id: "first",
    layers: [createLayer("component", { id: "to-second", componentSceneId: "second" })],
  });
  const second = componentScene({
    id: "second",
    layers: [createLayer("component", { id: "to-first", componentSceneId: "first" })],
  });
  const cyclic = createDocument({
    scenes: [
      createScene({
        id: "main",
        layers: [createLayer("component", { id: "instance", componentSceneId: "first" })],
      }),
      first,
      second,
    ],
  });
  assert.throws(() => expandComponents(cyclic, "main"), /recursive component cycle/);

  const parentCycleSource = componentScene({
    id: "parent-cycle-source",
    layers: [
      createLayer("group", { id: "parent-a", parentId: "parent-b" }),
      createLayer("group", { id: "parent-b", parentId: "parent-a" }),
    ],
  });
  const parentCycle = createDocument({
    scenes: [
      createScene({
        id: "main",
        layers: [createLayer("component", { id: "instance", componentSceneId: "parent-cycle-source" })],
      }),
      parentCycleSource,
    ],
  });
  assert.throws(() => expandComponents(parentCycle, "main"), /layer parent hierarchy contains a cycle/);
});

