// The checks that add_animation runs on one animation also run on a whole animation list, when an
// MCP client sets it with add_layer, update_layer or insert_component, or sets a scene's whole
// layer list with add_scene or update_scene (animationListCheck.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { animationListProblem, sceneAnimationProblem } from "./animationListCheck.js";

function documentWith(layers, duration = 4) {
  return parseDocument(createDocument({ scenes: [
    createScene({ id: "main", width: 200, height: 100, duration, layers }),
    createScene({ id: "card", width: 50, height: 50, duration: 2, isComponent: true }),
  ] }));
}

const layerOf = (document, id) => document.scenes[0].layers.find((layer) => layer.id === id);

const widthAnimation = (id = "w1") => ({ id, name: "W", kind: "custom", start: 0, duration: 1, easing: "linear", from: { width: 10 }, to: { width: 50 } });
const hide = (start, id = "h1") => ({ id, name: "Hide", kind: "hide", start });
const color = (id = "c1") => ({ id, name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#0000ff" } });

const groupResize = /A Resize \(width or height\) animation can't be added to group layer g1/;
const hideOutside = /Hide at 50 s is outside the scene, which lasts 4 s/;

test("animationListProblem runs the Resize, Hide and Show, and Color checks on each new animation", () => {
  const group = createLayer("group", { id: "g1" });
  const box = createLayer("rectangle", { id: "r1" });
  assert.match(animationListProblem({ ...group, animations: [widthAnimation()] }, [], 4), groupResize);
  assert.match(animationListProblem({ ...box, animations: [hide(50)] }, [], 4), hideOutside);
  assert.equal(animationListProblem({ ...group, animations: [color()] }, [], 4), null);
  assert.match(animationListProblem({ ...createLayer("image", { id: "i1" }), animations: [color()] }, [], 4), /image layer i1 has no Fill/);
  assert.equal(animationListProblem({ ...box, animations: [widthAnimation(), hide(4), color()] }, [], 4), null, "all fit a rectangle");
  assert.match(animationListProblem({ ...createLayer("audio", { id: "a1" }), animations: [widthAnimation()] }, [], 4), /audio layer a1 has no size/);
  assert.match(animationListProblem({ ...createLayer("text", { id: "t1", textResize: "width-height" }), animations: [widthAnimation()] }, [], 4), /Auto width/);
  assert.equal(animationListProblem({ ...box, animations: "not a list" }, [], 4), null, "parseDocument reports a bad list");
  assert.equal(animationListProblem({ ...box, animations: [null, 3] }, "not a list", 4), null, "parseDocument reports bad items");
});

test("animationListProblem lets an older animation keep its values, and checks only what an edit changes", () => {
  const group = createLayer("group", { id: "g1" });
  const box = createLayer("rectangle", { id: "r1" });
  // An older size animation on a group, and a Hide left past the end of a scene made shorter.
  assert.equal(animationListProblem({ ...group, animations: [{ ...widthAnimation(), name: "Wipe", start: 0.5 }] }, [widthAnimation()], 4), null);
  assert.equal(animationListProblem({ ...box, animations: [{ ...hide(50), name: "Gone" }] }, [hide(50)], 4), null);
  assert.equal(animationListProblem({ ...box, animations: [{ ...hide(50), kind: "show", name: "Show" }] }, [hide(50)], 4), null, "switched to a Show at the same time");
  // New values on them are refused.
  assert.match(animationListProblem({ ...group, animations: [{ ...widthAnimation(), to: { width: 80 } }] }, [widthAnimation()], 4), groupResize);
  assert.match(animationListProblem({ ...group, animations: [{ ...widthAnimation(), anchor: "top" }] }, [widthAnimation()], 4), groupResize);
  assert.match(animationListProblem({ ...box, animations: [hide(50, "h1"), hide(50, "h2")] }, [hide(50)], 4), hideOutside, "a copy with a new ID is new");
  assert.match(animationListProblem({ ...box, animations: [hide(60)] }, [hide(50)], 4), /Hide at 60 s is outside the scene/);
  assert.equal(animationListProblem({ ...group, animations: [] }, [widthAnimation()], 4), null, "removing it");
});

test("update_layer refuses a Resize on a group and a Hide past the scene's end, like add_animation", () => {
  const source = documentWith([createLayer("group", { id: "g1" }), createLayer("rectangle", { id: "r1" })]);
  assert.throws(() => applyOperations(source, [
    { type: "add_animation", sceneId: "main", layerId: "g1", animation: widthAnimation() },
  ]), groupResize, "add_animation refuses it");
  assert.throws(() => applyOperations(source, [
    { type: "update_layer", sceneId: "main", layerId: "g1", properties: { animations: [widthAnimation()] } },
  ]), groupResize, "update_layer refuses it too");
  assert.throws(() => applyOperations(source, [
    { type: "update_layer", sceneId: "main", layerId: "r1", properties: { animations: [hide(50)] } },
  ]), hideOutside);
  assert.throws(() => applyOperations(source, [
    { type: "update_layer", sceneId: "main", layerId: "r1", properties: { animations: [{ ...hide(-1), name: "Show", kind: "show" }] } },
  ]), /Show at -1 s is outside the scene/);
  // The same animations on a layer that can take them are accepted, and saved.
  const kept = applyOperations(source, [
    { type: "update_layer", sceneId: "main", layerId: "r1", properties: { animations: [widthAnimation(), hide(4)] } },
  ]);
  assert.deepEqual(layerOf(parseDocument(JSON.parse(JSON.stringify(kept))), "r1").animations.map((item) => item.id), ["w1", "h1"]);
});

test("add_layer and insert_component refuse the same animations", () => {
  const source = documentWith([]);
  for (const layerType of ["group", "audio"])
    assert.throws(() => applyOperations(source, [
      { type: "add_layer", sceneId: "main", layerType, properties: { id: "g1", animations: [widthAnimation()] } },
    ]), new RegExp(`A Resize \\(width or height\\) animation .*${layerType} layer g1`), `add_layer ${layerType}`);
  assert.throws(() => applyOperations(source, [
    { type: "add_layer", sceneId: "main", layerType: "text", properties: { id: "t1", textResize: "width-height", animations: [widthAnimation()] } },
  ]), /Auto width/);
  assert.throws(() => applyOperations(source, [
    { type: "add_layer", sceneId: "main", layerType: "rectangle", properties: { id: "r1", animations: [hide(50)] } },
  ]), hideOutside);
  assert.throws(() => applyOperations(source, [
    { type: "insert_component", sceneId: "main", componentSceneId: "card", properties: { id: "i1", animations: [widthAnimation()] } },
  ]), /can't be added to component layer i1: a component instance takes its main component's size/);
  assert.throws(() => applyOperations(source, [
    { type: "insert_component", sceneId: "main", componentSceneId: "card", properties: { id: "i1", animations: [hide(50)] } },
  ]), hideOutside);
  assert.throws(() => applyOperations(source, [
    { type: "insert_component", sceneId: "main", componentSceneId: "card", properties: { id: "i1", animations: [color()] } },
  ]), /component layer i1 has no Fill/);
  const added = applyOperations(source, [
    { type: "add_layer", sceneId: "main", layerType: "rectangle", properties: { id: "r1", animations: [widthAnimation(), hide(4)] } },
    { type: "insert_component", sceneId: "main", componentSceneId: "card", properties: { id: "i1", animations: [hide(2, "h2")] } },
  ]);
  assert.deepEqual(layerOf(added, "r1").animations.map((item) => item.kind), ["custom", "hide"]);
  assert.deepEqual(layerOf(added, "i1").animations.map((item) => item.kind), ["hide"]);
});

// Older versions accepted these through update_layer. Such a document still opens, and an
// update_layer that sets the list again with the older animations unchanged is still accepted.
test("update_layer keeps an older Resize on a group and an older Hide past the end", () => {
  const saved = JSON.parse(JSON.stringify(documentWith([createLayer("group", { id: "g1" }), createLayer("rectangle", { id: "r1" })])));
  saved.scenes[0].layers[0].animations = [widthAnimation()];
  saved.scenes[0].layers[1].animations = [hide(50)];
  const opened = parseDocument(saved);
  const listed = applyOperations(opened, [
    { type: "update_layer", sceneId: "main", layerId: "g1", properties: { name: "Folder", animations: [{ ...widthAnimation(), name: "Wipe", duration: 2 }] } },
    { type: "update_layer", sceneId: "main", layerId: "r1", properties: { animations: [{ ...hide(50), name: "Gone" }] } },
  ]);
  assert.deepEqual([layerOf(listed, "g1").name, layerOf(listed, "g1").animations[0].name, layerOf(listed, "g1").animations[0].duration], ["Folder", "Wipe", 2]);
  assert.equal(layerOf(listed, "r1").animations[0].name, "Gone");
  assert.throws(() => applyOperations(opened, [
    { type: "update_layer", sceneId: "main", layerId: "g1", properties: { animations: [{ ...widthAnimation(), to: { width: 90 } }] } },
  ]), groupResize);
  assert.throws(() => applyOperations(opened, [
    { type: "update_layer", sceneId: "main", layerId: "r1", properties: { animations: [hide(50), hide(50, "h2")] } },
  ]), hideOutside);
});

test("add_scene and update_scene check the animations of the layers they set", () => {
  const source = documentWith([createLayer("group", { id: "g1" }), createLayer("rectangle", { id: "r1", animations: [hide(3)] })]);
  const group = { ...createLayer("group", { id: "g2" }), animations: [widthAnimation()] };
  assert.throws(() => applyOperations(source, [{ type: "add_scene", properties: { id: "s2", layers: [group] } }]),
    /A Resize \(width or height\) animation can't be added to group layer g2/);
  assert.throws(() => applyOperations(source, [{ type: "add_scene", properties: { id: "s2", duration: 2, layers: [{ ...createLayer("rectangle", { id: "r2" }), animations: [hide(3)] }] } }]),
    /Hide at 3 s is outside the scene, which lasts 2 s/);
  assert.throws(() => applyOperations(source, [
    { type: "update_scene", sceneId: "main", properties: { layers: [...source.scenes[0].layers, group] } },
  ]), /group layer g2/);
  assert.throws(() => applyOperations(source, [
    { type: "update_scene", sceneId: "main", properties: { layers: [createLayer("image", { id: "i1", animations: [color()] })] } },
  ]), /image layer i1 has no Fill/);
  // Making the scene shorter than a Hide is still allowed, also when the layers are set again
  // unchanged, and a later Hide with a new time must be inside the shorter scene.
  const shorter = applyOperations(source, [
    { type: "update_scene", sceneId: "main", properties: { duration: 2 } },
    { type: "update_scene", sceneId: "main", properties: { name: "Short", layers: structuredClone(source.scenes[0].layers) } },
  ]);
  assert.deepEqual([shorter.scenes[0].duration, layerOf(shorter, "r1").animations[0].start], [2, 3]);
  assert.throws(() => applyOperations(shorter, [
    { type: "update_scene", sceneId: "main", properties: { layers: [{ ...layerOf(shorter, "r1"), animations: [hide(3.5)] }] } },
  ]), /Hide at 3.5 s is outside the scene, which lasts 2 s/);
  const added = applyOperations(source, [{ type: "add_scene", properties: { id: "s2", layers: [{ ...createLayer("rectangle", { id: "r2" }), animations: [widthAnimation("w9"), hide(1, "h9")] }] } }]);
  assert.equal(added.scenes.find((scene) => scene.id === "s2").layers[0].animations.length, 2);
});

test("sceneAnimationProblem treats a layer as older only when its ID and type both match", () => {
  const box = { ...createLayer("rectangle", { id: "x1" }), animations: [widthAnimation()] };
  const group = { ...createLayer("group", { id: "x1" }), animations: [widthAnimation()] };
  assert.equal(sceneAnimationProblem({ duration: 4, layers: [group] }, [group]), null, "an older group wipe");
  assert.match(sceneAnimationProblem({ duration: 4, layers: [group] }, [box]), /group layer x1/, "the same ID on a new type is new");
  assert.equal(sceneAnimationProblem({ duration: 4, layers: "not a list" }, []), null);
  assert.equal(sceneAnimationProblem({ duration: 4, layers: [null] }, "not a list"), null);
});
