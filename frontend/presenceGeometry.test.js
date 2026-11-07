import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { createComponentInstance, expandComponents } from "../engine/linkedComponents.js";
import { remoteSelectionQuads } from "./presenceGeometry.js";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} should equal ${expected}`);
const pointsNear = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((point, index) => {
    near(point.x, expected[index][0]);
    near(point.y, expected[index][1]);
  });
};

test("ordinary selected layers use nested parent rotations in scene coordinates", () => {
  const scene = createScene({ id: "page", width: 600, height: 400, layers: [
    createLayer("group", { id: "outer", x: 100, y: 50, width: 100, height: 100, rotation: 90 }),
    createLayer("group", { id: "inner", parentId: "outer", x: 10, y: 20, width: 60, height: 40 }),
    createLayer("rectangle", { id: "leaf", parentId: "inner", x: 5, y: 7, width: 20, height: 10 }),
  ] });
  const document = createDocument({ scenes: [scene] });
  const [quad] = remoteSelectionQuads(document, "page", { sceneId: "page", layerIds: ["leaf"] });
  assert.equal(quad.id, "leaf");
  pointsNear(quad.points, [[173, 65], [173, 85], [163, 85], [163, 65]]);
});

test("ordinary component selections use the source scene size for the instance box", () => {
  const component = createScene({ id: "component", name: "Component", isComponent: true, width: 200, height: 100, layers: [] });
  const instance = createComponentInstance(component, { id: "instance", x: 10, y: 20 });
  instance.width = 5;
  instance.height = 6;
  const page = createScene({ id: "page", width: 500, height: 300, layers: [instance] });
  const document = createDocument({ scenes: [page, component] });
  const [quad] = remoteSelectionQuads(document, "page", { sceneId: "page", layerIds: ["instance"] });
  pointsNear(quad.points, [[10, 20], [210, 20], [210, 120], [10, 120]]);
});

test("locked layers selected from the tree retain ordinary and inherited outlines", () => {
  const component = createScene({ id: "component", isComponent: true, width: 100, height: 100, layers: [
    createLayer("rectangle", { id: "source", locked: true, x: 5, y: 7, width: 20, height: 10 }),
  ] });
  const page = createScene({ id: "page", width: 400, height: 300, layers: [
    createLayer("group", { id: "locked-group", locked: true, x: 100, y: 50, width: 100, height: 100 }),
    createLayer("rectangle", { id: "locked-child", parentId: "locked-group", locked: true, x: 5, y: 7, width: 20, height: 10 }),
    createComponentInstance(component, { id: "locked-instance", locked: true, x: 100, y: 50 }),
  ] });
  const document = createDocument({ scenes: [page, component] });
  const [ordinary] = remoteSelectionQuads(document, "page", { sceneId: "page", layerIds: ["locked-child"] });
  const [inherited] = remoteSelectionQuads(document, "page", { sceneId: "page", layerIds: ["locked-instance"], componentPath: "source" });
  pointsNear(ordinary.points, [[105, 57], [125, 57], [125, 67], [105, 67]]);
  pointsNear(inherited.points, [[105, 57], [125, 57], [125, 67], [105, 67]]);
});

test("Animate mode uses the current animated position and rotation", () => {
  const move = {
    id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing: "linear",
    from: { x: 10, rotation: 0 }, to: { x: 30, rotation: 90 },
    unit: "layer", stagger: 0, order: "forward",
  };
  const scene = createScene({ id: "page", width: 400, height: 300, layers: [
    createLayer("rectangle", { id: "animated", x: 10, y: 20, width: 20, height: 10, animations: [move] }),
  ] });
  const document = createDocument({ scenes: [scene] });
  const [quad] = remoteSelectionQuads(document, "page", { sceneId: "page", layerIds: ["animated"] }, { mode: "animate", time: 0.5 });
  pointsNear(quad.points, [
    [26.464466, 14.393398],
    [40.606602, 28.535534],
    [33.535534, 35.606602],
    [19.393398, 21.464466],
  ]);
});

test("inherited component quads include overrides, outer transform, and componentStart time offset without mutation", () => {
  const move = {
    id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing: "linear",
    from: { x: 0 }, to: { x: 20 }, unit: "layer", stagger: 0, order: "forward",
  };
  const component = createScene({ id: "card", name: "Card", isComponent: true, width: 100, height: 60, layers: [
    createLayer("group", { id: "G", x: 20, y: 10, width: 60, height: 40 }),
    createLayer("rectangle", { id: "leaf", parentId: "G", x: 5, y: 7, width: 20, height: 10, animations: [move] }),
  ] });
  const instance = createComponentInstance(component, {
    id: "instance", x: 100, y: 50, rotation: 90, componentStart: 2,
    componentOverrides: { leaf: { rotation: 30, y: 11 } },
  });
  const page = createScene({ id: "page", width: 500, height: 300, layers: [instance] });
  const document = createDocument({ scenes: [page, component] });
  const snapshot = structuredClone(document);
  const selection = { sceneId: "page", layerIds: ["instance"], componentPath: "leaf" };
  const resolvedLayers = expandComponents(document, "page").layers;
  const [quad] = remoteSelectionQuads(document, "page", selection, { mode: "animate", time: 2.5, resolvedLayers });
  pointsNear(quad.points, [
    [163.330127, 63.839746],
    [153.330127, 81.160254],
    [144.669873, 76.160254],
    [154.669873, 58.839746],
  ]);
  assert.deepEqual(document, snapshot);
});

test("deleted, hidden, audio, and invalid inherited targets produce no quads", () => {
  const component = createScene({ id: "component", isComponent: true, width: 80, height: 40, layers: [
    createLayer("rectangle", { id: "live", width: 20, height: 10 }),
  ] });
  const instance = createComponentInstance(component, { id: "instance" });
  const scene = createScene({ id: "page", width: 400, height: 300, layers: [
    createLayer("group", { id: "hidden", visible: false, width: 100, height: 100 }),
    createLayer("rectangle", { id: "under-hidden", parentId: "hidden", width: 20, height: 10 }),
    createLayer("audio", { id: "sound", src: "/sound.wav" }),
    instance,
  ] });
  const document = createDocument({ scenes: [scene, component] });
  const quads = (selection) => remoteSelectionQuads(document, "page", selection);
  assert.deepEqual(quads({ sceneId: "page", layerIds: ["deleted"] }), []);
  assert.deepEqual(quads({ sceneId: "page", layerIds: ["under-hidden"] }), []);
  assert.deepEqual(quads({ sceneId: "page", layerIds: ["sound"] }), []);
  assert.deepEqual(quads({ sceneId: "other", layerIds: ["instance"], componentPath: "live" }), []);
  assert.deepEqual(quads({ sceneId: "page", layerIds: ["instance", "instance"], componentPath: "live" }), []);
  assert.deepEqual(quads({ sceneId: "page", layerIds: ["deleted-instance"], componentPath: "live" }), []);
  assert.deepEqual(quads({ sceneId: "page", layerIds: ["instance"], componentPath: "missing" }), []);
  assert.deepEqual(quads({ sceneId: "page", layerIds: ["instance"], componentPath: "live//bad" }), []);
});
