import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { createComponentFromLayers } from "./createComponent.js";
import { groupLayers, maskTargets } from "./grouping.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { applyOperations } from "./operations.js";
import { duplicateSceneInDocument } from "./sceneDuplication.js";
import { effectiveMediaDuration, getScenePlaybackDuration, mediaFrameState, mediaPlaybackRange, resolvePlayback } from "./playback.js";

const options = { componentSceneId: "new-component", instanceId: "new-instance" };
const box = (id, properties = {}) => createLayer("rectangle", { id, name: id, x: 20, y: 30, width: 40, height: 25, ...properties });
const documentWith = (layers, scenes = []) => parseDocument(createDocument({ scenes: [createScene({ id: "main", duration: 5, background: "#ffcc00", layers }), ...scenes] }));

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("selection becomes a transparent component after its source with the grouped origin, size and duration", () => {
  const document = documentWith([
    box("below"),
    box("one", { x: 30.25, y: 40.5, width: 30.1, height: 20.2 }),
    createLayer("group", { id: "group", x: 80, y: 90, width: 70, height: 50 }),
    box("child", { parentId: "group", x: 5, y: 6 }),
    box("above"),
  ], [createScene({ id: "following" })]);
  const original = structuredClone(document);
  freeze(document);
  const grouped = groupLayers(document, "main", ["one", "group", "child"], { id: options.instanceId });
  const group = grouped.layers.find((layer) => layer.id === options.instanceId);
  const result = createComponentFromLayers(document, "main", ["one", "group", "child"], options);
  const [main, component, following] = result.document.scenes;
  const instance = main.layers.find((layer) => layer.id === result.instanceId);
  assert.equal(result.componentSceneId, options.componentSceneId);
  assert.equal(result.instanceId, options.instanceId);
  assert.deepEqual(result.document.scenes.map((scene) => scene.id), ["main", options.componentSceneId, "following"]);
  assert.equal(following.id, "following");
  assert.equal(component.name, "Component 1");
  assert.equal(component.isComponent, true);
  assert.equal(component.background, "#ffffff");
  assert.equal(component.backgroundEnabled, false);
  assert.equal(component.duration, 5);
  assert.equal(component.componentPlayback, "scene");
  assert.equal(component.width, Math.max(1, Math.ceil(group.width)));
  assert.equal(component.height, Math.max(1, Math.ceil(group.height)));
  assert.equal(instance.name, component.name);
  assert.equal(instance.x, group.x);
  assert.equal(instance.y, group.y);
  assert.equal(instance.parentId, group.parentId);
  assert.equal(instance.componentStart, 0);
  assert.equal(instance.componentVisibility, "both");
  assert.equal(instance.clipContent, false);
  assert.deepEqual(main.layers.map((layer) => layer.id), ["below", options.instanceId, "above"]);
  assert.deepEqual(component.layers.map((layer) => [layer.id, layer.parentId]), [["one", null], ["group", null], ["child", "group"]]);
  for (const layer of component.layers) {
    const before = grouped.layers.find((item) => item.id === layer.id);
    assert.equal(layer.x, before.x);
    assert.equal(layer.y, before.y);
  }
  assert.deepEqual(document, original, "the input stays untouched, even on success");
  assert.deepEqual(parseDocument(JSON.stringify(result.document)), result.document, "the conversion persists as ordinary document data");
});

test("one layer supplies the name, multiple layers count component scenes, and an explicit name wins", () => {
  const source = createScene({ id: "existing-component", isComponent: true });
  const document = documentWith([box("one", { name: "Card" }), box("two")], [source]);
  const single = createComponentFromLayers(document, "main", ["one"], options).document;
  assert.equal(single.scenes[1].name, "Card");
  assert.equal(single.scenes[0].layers.find((layer) => layer.type === "component").name, "Card");
  assert.equal(createComponentFromLayers(document, "main", ["one", "two"], options).document.scenes[1].name, "Component 2");
  const named = createComponentFromLayers(document, "main", ["one"], { ...options, name: "Reusable card" }).document;
  assert.equal(named.scenes[1].name, "Reusable card");
  assert.equal(named.scenes[0].layers.find((layer) => layer.type === "component").name, "Reusable card");
  const automatic = createComponentFromLayers(document, "main", ["one"]);
  assert.ok(automatic.componentSceneId && automatic.instanceId);
  assert.notEqual(automatic.componentSceneId, automatic.instanceId);
});

test("the instance stays in the topmost selected layer's parent and place", () => {
  const document = documentWith([
    box("outside", { x: 0, y: 0 }),
    createLayer("group", { id: "parent", x: 100, y: 70, rotation: 22 }),
    box("sibling", { parentId: "parent" }),
    box("inside", { parentId: "parent", x: 70, y: 80 }),
    box("last", { parentId: "parent" }),
  ]);
  const grouped = groupLayers(document, "main", ["outside", "inside"], { id: options.instanceId });
  const result = createComponentFromLayers(document, "main", ["outside", "inside"], options).document;
  const instance = result.scenes[0].layers.find((layer) => layer.id === options.instanceId);
  assert.equal(instance.parentId, "parent");
  assert.deepEqual(result.scenes[0].layers.map((layer) => layer.id), ["parent", "sibling", options.instanceId, "last"]);
  assert.equal(instance.x, grouped.layers.find((layer) => layer.id === instance.id).x);
  assert.equal(instance.y, grouped.layers.find((layer) => layer.id === instance.id).y);
});

test("layer and animation ids, mask pairs, and nested instance overrides survive the move", () => {
  const badge = createScene({ id: "badge", isComponent: true, width: 50, height: 30, layers: [box("badge-box")] });
  const document = documentWith([
    box("mask", { isMask: true, fill: "#ffffff" }),
    box("masked", { animations: [{ id: "slide", name: "Slide", kind: "in", start: 0.25, duration: 1, easing: "linear", from: { x: -20 }, to: { x: 20 } }] }),
    createComponentInstance(badge, { id: "nested", componentOverrides: { "badge-box": { fill: "#ff0000" } } }),
  ], [badge]);
  const beforeIds = document.scenes.flatMap((scene) => scene.layers.map((layer) => layer.id));
  const next = createComponentFromLayers(document, "main", ["mask", "masked", "nested"], options).document;
  const combined = new Map([...maskTargets(next.scenes[0].layers), ...maskTargets(next.scenes[1].layers)]);
  assert.deepEqual(combined, maskTargets(document.scenes[0].layers));
  assert.deepEqual(next.scenes[1].layers.find((layer) => layer.id === "nested").componentOverrides, document.scenes[0].layers[2].componentOverrides);
  assert.equal(next.scenes[1].layers.find((layer) => layer.id === "masked").animations[0].id, "slide");
  const afterIds = next.scenes.flatMap((scene) => scene.layers.map((layer) => layer.id));
  assert.deepEqual(afterIds.filter((id) => id !== options.instanceId).sort(), beforeIds.sort());
  assert.equal(new Set(afterIds).size, afterIds.length);
});

test("tiny visual selections still make a component at least one pixel wide and high", () => {
  const result = createComponentFromLayers(documentWith([box("dot", { width: 0.1, height: 0.2 })]), "main", ["dot"], options);
  assert.equal(result.document.scenes[1].width, 1);
  assert.equal(result.document.scenes[1].height, 1);
});

test("extracting inside a main component preserves existing override paths and local positions", () => {
  const badge = createScene({ id: "badge", isComponent: true, layers: [box("badge-box")] });
  const source = createScene({ id: "main", isComponent: true, layers: [
    box("one", { x: 20, y: 30 }),
    box("two", { x: 90, y: 60 }),
    createComponentInstance(badge, { id: "badge-use", x: 70, y: 50 }),
  ] });
  const middle = createScene({ id: "middle", isComponent: true, layers: [
    createComponentInstance(source, { id: "source-use", componentOverrides: { one: { x: 55, fill: "#ff0000" }, "badge-use/badge-box": { opacity: 0.5 } } }),
  ] });
  const output = createScene({ id: "output", layers: [
    createComponentInstance(middle, { id: "middle-use", componentOverrides: { "source-use/one": { y: 70 }, "source-use/two": { visible: false } } }),
  ] });
  const document = parseDocument(createDocument({ scenes: [source, middle, output, badge] }));
  const next = createComponentFromLayers(document, "main", ["one", "badge-use"], options).document;
  const own = next.scenes.find((scene) => scene.id === "middle").layers[0].componentOverrides;
  const outer = next.scenes.find((scene) => scene.id === "output").layers[0].componentOverrides;
  assert.deepEqual(own, { "new-instance/one": { x: 35, fill: "#ff0000" }, "new-instance/badge-use/badge-box": { opacity: 0.5 } });
  assert.deepEqual(outer, { "source-use/new-instance/one": { y: 40 }, "source-use/two": { visible: false } });
  assert.equal(document.scenes[1].layers[0].componentOverrides.one.x, 55);
});

test("mixed-parent extraction in a reused main refuses when an instance override could change its result", () => {
  const source = createScene({ id: "main", isComponent: true, layers: [
    createLayer("group", { id: "parent" }), box("inside", { parentId: "parent" }), box("outside"),
  ] });
  const output = createScene({ id: "output", layers: [createComponentInstance(source, { id: "use", componentOverrides: { parent: { opacity: 0.5 } } })] });
  assertRefusal(parseDocument(createDocument({ scenes: [source, output] })), ["inside", "outside"], /overrides.*different parents|different parents.*overrides/i);
});

test("open video and audio are pinned through the source scene end, including descendants", () => {
  const document = documentWith([
    createLayer("group", { id: "media-group" }),
    createLayer("video", { id: "open-video", parentId: "media-group", mediaStart: 1, mediaDuration: 0 }),
    createLayer("audio", { id: "open-audio", parentId: "media-group", mediaStart: 0.5, mediaDuration: 0 }),
    createLayer("audio", { id: "late", parentId: "media-group", mediaStart: 6, mediaDuration: 0 }),
    createLayer("video", { id: "known", parentId: "media-group", mediaDuration: 0, mediaSourceDuration: 2 }),
    createLayer("audio", { id: "finite", parentId: "media-group", mediaDuration: 2 }),
  ]);
  const next = createComponentFromLayers(document, "main", ["media-group"], options).document;
  const layers = new Map(next.scenes[1].layers.map((layer) => [layer.id, layer]));
  assert.equal(layers.get("open-video").mediaDuration, 4);
  assert.equal(layers.get("open-audio").mediaDuration, 4.5);
  assert.equal(layers.get("late").mediaDuration, 1 / 60);
  assert.equal(layers.get("known").mediaDuration, 0);
  assert.equal(effectiveMediaDuration(layers.get("known")), 2);
  assert.equal(layers.get("finite").mediaDuration, 2);
  assert.ok(getScenePlaybackDuration(next, options.componentSceneId) >= 5);
  const video = expandComponents(next, "main").layers.find((layer) => layer.componentPath === "open-video");
  assert.equal(resolvePlayback(video, 4).time, 4, "the component does not hold a moving video at time zero");
});

test("finite video and timed images retain their Play visibility after extraction, including the first frame after Play", () => {
  for (const type of ["video", "image"]) {
    for (const mediaFreeze of ["none", "first", "last", "both"]) {
      for (const mediaStart of [0, 0.5]) {
        const document = documentWith([
          createLayer("group", { id: "media-group" }),
          createLayer(type, { id: "finite-media", parentId: "media-group", mediaStart, mediaDuration: 2, mediaOffset: 0.25, mediaFreeze }),
        ]);
        const before = structuredClone(document);
        freeze(document);
        const result = createComponentFromLayers(document, "main", ["media-group"], options).document;
        const original = document.scenes[0].layers[1];
        const moved = result.scenes[1].layers.find((layer) => layer.id === original.id);
        const expanded = expandComponents(result, "main").layers.find((layer) => layer.componentPath === original.id);
        for (const field of ["mediaStart", "mediaDuration", "mediaOffset", "mediaFreeze", "mediaSourceDuration"])
          assert.equal(moved[field], original[field], `${type}/${mediaFreeze}: ${field} stays unchanged`);
        for (const time of [0, mediaStart, mediaStart + 1, mediaStart + 2, mediaStart + 2 + 1 / 60, 4, 5]) {
          const clock = resolvePlayback(expanded, time);
          assert.deepEqual(mediaFrameState(expanded, clock.time), mediaFrameState(original, time),
            `${type}/${mediaFreeze} at ${time}s keeps visibility, playing state and source frame`);
          assert.equal(clock.visible, true);
        }
        assert.deepEqual(mediaPlaybackRange(expanded, 5), mediaPlaybackRange(original, 5), "Play is not extended with the component clock");
        assert.deepEqual(document, before, "conversion does not mutate the caller's document");
        assert.deepEqual(parseDocument(JSON.stringify(result)), result, "media clock preservation persists");
      }
    }
  }
});

test("video with a known source end keeps its open duration and hides after that end when extracted", () => {
  const document = documentWith([createLayer("video", {
    id: "known-media", mediaDuration: 0, mediaSourceDuration: 2, mediaFreeze: "none",
  })]);
  const operation = { type: "create_component_from_layers", sceneId: "main", layerIds: ["known-media"], ...options };
  const result = applyOperations(document, [operation]);
  assert.equal(result.scenes[1].layers[0].mediaDuration, 0);
  assert.equal(result.scenes[1].layers[0].mediaSourceDuration, 2);
  const expanded = expandComponents(result, "main").layers.find((layer) => layer.componentPath === "known-media");
  assert.equal(mediaFrameState(expanded, resolvePlayback(expanded, 4).time).visible, false,
    "MCP conversion preserves the source-end visibility transition too");
});

test("extracted scene clocks persist, follow scene duration edits, and still include longer content", () => {
  const document = documentWith([createLayer("video", { id: "clip", mediaDuration: 2, mediaFreeze: "none" })]);
  const result = createComponentFromLayers(document, "main", ["clip"], options).document;
  assert.equal(getScenePlaybackDuration(result, options.componentSceneId), 5);
  assert.equal(resolvePlayback(expandComponents(result, "main").layers.find((layer) => layer.type === "video"), 4).time, 4);
  const edited = applyOperations(result, [{ type: "update_scene", sceneId: options.componentSceneId, properties: { duration: 3 } }]);
  assert.equal(getScenePlaybackDuration(edited, options.componentSceneId), 3);
  const longer = applyOperations(edited, [{ type: "update_layer", sceneId: options.componentSceneId, layerId: "clip", properties: { mediaDuration: 6 } }]);
  assert.equal(getScenePlaybackDuration(longer, options.componentSceneId), 6, "the scene duration is a floor, not a cap on timed content");
  const content = applyOperations(edited, [{ type: "update_scene", sceneId: options.componentSceneId, properties: { componentPlayback: "content" } }]);
  assert.equal(getScenePlaybackDuration(content, options.componentSceneId), 2);
  const ordinary = documentWith([createLayer("video", { id: "clip", mediaDuration: 2, mediaFreeze: "none" })]);
  ordinary.scenes[0].isComponent = true;
  assert.equal(getScenePlaybackDuration(ordinary, "main"), 2, "ordinary components retain their existing timing without the optional field");
  assert.deepEqual(parseDocument(JSON.stringify(edited)), edited);
  for (const componentPlayback of ["", "unknown", 5, null, false, [], {}]) {
    const invalid = structuredClone(result);
    invalid.scenes[1].componentPlayback = componentPlayback;
    assert.throws(() => parseDocument(invalid), /componentPlayback.*content or scene/);
  }
});

test("scene copies preserve an extracted component's playback clock mode", () => {
  const result = createComponentFromLayers(documentWith([box("one")]), "main", ["one"], options).document;
  for (const isComponent of [true, false]) {
    const document = structuredClone({ ...result, scenes: [result.scenes[1]] });
    document.scenes[0].isComponent = isComponent;
    const copy = duplicateSceneInDocument(document, options.componentSceneId);
    const scene = copy.document.scenes.find((item) => item.id === copy.sceneId);
    assert.equal(scene.componentPlayback, "scene");
    assert.equal(getScenePlaybackDuration(copy.document, scene.id), 5);
  }
});

test("extracted media keeps its endpoint and Freeze through nested instances with nonzero starts", () => {
  const document = documentWith([createLayer("video", { id: "clip", mediaDuration: 2, mediaFreeze: "none" })]);
  const result = createComponentFromLayers(document, "main", ["clip"], options).document;
  result.scenes[0].isComponent = true;
  result.scenes[0].layers[0].componentStart = 0.75;
  result.scenes.push(createScene({ id: "output", duration: 8, layers: [
    createComponentInstance(result.scenes[0], { id: "outer", componentStart: 1.25 }),
  ] }));
  const validated = parseDocument(result);
  const clip = expandComponents(validated, "output").layers.find((layer) => layer.type === "video");
  assert.equal(clip.mediaStart, 2);
  assert.equal(getScenePlaybackDuration(validated, "main"), 5.75, "the extracted component clock includes its scene duration");
  assert.equal(mediaFrameState(clip, resolvePlayback(clip, 4).time).visible, true, "the exact Play endpoint is included");
  for (const time of [4 + 1 / 60, 5, 8])
    assert.equal(mediaFrameState(clip, resolvePlayback(clip, time).time).visible, false, `hidden after nested Play at ${time}s`);
});

test("extracting media already held before its Play end keeps that earlier held frame", () => {
  const document = documentWith([createLayer("video", {
    id: "held-clip", mediaDuration: 2, mediaFreeze: "none",
    playbackWindows: [{ start: 0, end: 1, visibility: "both", hold: true }],
  })]);
  const result = createComponentFromLayers(document, "main", ["held-clip"], options).document;
  const clip = expandComponents(result, "main").layers.find((layer) => layer.type === "video");
  for (const time of [0, 1, 2, 4, 5]) {
    const clock = resolvePlayback(clip, time);
    const original = document.scenes[0].layers[0];
    assert.equal(clock.time, resolvePlayback(original, time).time);
    assert.deepEqual(mediaFrameState(clip, clock.time), mediaFrameState(original, clock.time));
  }
});

function assertRefusal(document, selected, pattern, fields = options) {
  const before = structuredClone(document);
  const undo = [];
  const commit = (next) => undo.push(next);
  freeze(document);
  assert.throws(() => {
    const result = createComponentFromLayers(document, "main", selected, fields);
    commit(result.document);
  }, (error) => {
    assert.match(error.message, /^Can't create component:/);
    assert.match(error.message, pattern);
    return true;
  });
  assert.deepEqual(document, before);
  assert.equal(undo.length, 0, "a caller that computes before committing adds no undo step on refusal");
}

test("empty, missing, inherited, and audio-only selections refuse without mutating input or caller history", () => {
  assertRefusal(documentWith([box("one")]), [], /select at least one layer/i);
  assertRefusal(documentWith([box("one")]), ["missing"], /not found/i);
  assertRefusal(documentWith([createLayer("audio", { id: "audio" })]), ["audio"], /audio layers/i);
  const source = createScene({ id: "source", isComponent: true, layers: [box("inherited")] });
  const document = documentWith([createComponentInstance(source, { id: "instance" })], [source]);
  const child = expandComponents(document, "main").layers.find((layer) => layer.componentPath === "inherited");
  assertRefusal(document, [child.id], /part of the component instance/i);
});

test("scene limits, mixed-parent appearance effects and separated masks refuse atomically", () => {
  const many = Array.from({ length: 99 }, (_, index) => createScene({ id: `scene-${index}` }));
  assertRefusal(documentWith([box("one")], many), ["one"], /100/);
  assertRefusal(documentWith([
    createLayer("group", { id: "faded", opacity: 0.5 }),
    box("inside", { parentId: "faded" }), box("outside"),
  ]), ["inside", "outside"], /opacity/);
  assertRefusal(documentWith([box("mask", { isMask: true }), box("target")]), ["mask"], /mask/);
});

test("wrapping a valid sixteen-level component chain refuses the seventeenth level", () => {
  const scenes = Array.from({ length: 17 }, (_, index) => createScene({ id: index === 0 ? "main" : `nested-${index}`, isComponent: index > 0 }));
  scenes.forEach((scene, index) => {
    scene.layers = index === 16 ? [box("leaf")] : [createComponentInstance(scenes[index + 1], { id: `instance-${index}` })];
  });
  const document = parseDocument(createDocument({ scenes }));
  assertRefusal(document, ["instance-0"], /nested too deeply/);
});

test("invalid explicit names and colliding ids refuse without changing the document", () => {
  for (const name of ["", " ", 12, "a".repeat(257)]) {
    assertRefusal(documentWith([box("one")]), ["one"], /name/i, { ...options, name });
  }
  assertRefusal(documentWith([box("one")]), ["one"], /already used|duplicate/i, { ...options, instanceId: "one" });
  assertRefusal(documentWith([box("one")]), ["one"], /duplicate scene/i, { ...options, componentSceneId: "main" });
});

test("MCP create_component_from_layers runs the same conversion and supports later operations on its result", () => {
  const document = documentWith([box("one"), box("two")]);
  const operation = { type: "create_component_from_layers", sceneId: "main", layerIds: ["one", "two"], name: "MCP component", ...options };
  const expected = createComponentFromLayers(document, "main", operation.layerIds, operation).document;
  assert.deepEqual(applyOperations(document, [operation]), expected);
  const next = applyOperations(document, [operation, { type: "update_layer", sceneId: options.componentSceneId, layerId: "one", properties: { fill: "#00ff00" } }]);
  assert.equal(next.scenes[1].layers.find((layer) => layer.id === "one").fill, "#00ff00");
  assert.equal(document.scenes.length, 1);
  assert.throws(() => applyOperations(document, [operation, { type: "create_component_from_layers", sceneId: "main", layerIds: [] }]), /^Error: Can't create component:/);
  assert.equal(document.scenes.length, 1, "an operation batch is atomic");
});
