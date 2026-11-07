import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "../engine/model.js";
import { layerBounds } from "./layerBounds.js";

function assertBoxClose(actual, expected) {
  assert.ok(actual, "expected a box");
  for (const name of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(actual[name] - expected[name]) < 1e-9, `${name}: ${actual[name]} is not ${expected[name]}`);
  }
}

test("selection bounds follow rotation, parents, components and the animated state", () => {
  const source = createScene({ id: "source", width: 80, height: 40, isComponent: true });
  const scene = createScene({ id: "main", width: 400, height: 300 });
  scene.layers = [
    createLayer("rectangle", { id: "turned", x: 0, y: 0, width: 100, height: 50, rotation: 90 }),
    createLayer("group", { id: "group", x: 100, y: 100, width: 10, height: 10, scaleX: 2, scaleY: 2 }),
    createLayer("rectangle", { id: "child", parentId: "group", x: 20, y: 0, width: 10, height: 10 }),
    createLayer("rectangle", { id: "hidden-child", parentId: "group", x: -500, y: -500, width: 10, height: 10, visible: false }),
    createLayer("component", { id: "instance", x: 10, y: 20, width: 1, height: 1, componentSceneId: "source" }),
    createLayer("rectangle", {
      id: "moving", x: 0, y: 0, width: 10, height: 10,
      animations: [{ id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 200 }, unit: "layer", stagger: 0, order: "forward" }],
    }),
    createLayer("audio", { id: "sound", width: 50, height: 50 }),
  ];
  const document = { scenes: [scene, source] };
  // Rotating 100x50 by 90° about its center gives a 50x100 box; world space starts at the scene center.
  assertBoxClose(layerBounds(document, scene, ["turned"]), { x: 25 - 200, y: -25 - 150, width: 50, height: 100 });
  // A child is placed and scaled by its group; a selected group covers its visible children.
  assertBoxClose(layerBounds(document, scene, ["child"]), { x: 135 - 200, y: 95 - 150, width: 20, height: 20 });
  assertBoxClose(layerBounds(document, scene, ["group"]), { x: 95 - 200, y: 95 - 150, width: 60, height: 20 });
  assertBoxClose(layerBounds(document, scene, ["instance"]), { x: 10 - 200, y: 20 - 150, width: 80, height: 40 });
  assertBoxClose(layerBounds(document, scene, ["moving"]), { x: -200, y: -150, width: 10, height: 10 });
  assertBoxClose(layerBounds(document, scene, ["moving"], 1), { x: 0, y: -150, width: 10, height: 10 });
  assert.equal(layerBounds(document, scene, ["sound"]), null);
});

test("boxes drawn at one time share each layer's animated state through a cache", () => {
  const scene = createScene({ id: "main", width: 400, height: 300 });
  const move = { id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 100 }, unit: "layer", stagger: 0, order: "forward" };
  scene.layers = [
    createLayer("group", { id: "group", x: 0, y: 0, width: 10, height: 10, animations: [move] }),
    createLayer("rectangle", { id: "a", parentId: "group", x: 0, y: 0, width: 10, height: 10 }),
    createLayer("rectangle", { id: "b", parentId: "group", x: 20, y: 0, width: 10, height: 10 }),
  ];
  const document = { scenes: [scene] };
  const cache = new Map();
  const a = layerBounds(document, scene, ["a"], 0.5, { cache });
  const b = layerBounds(document, scene, ["b"], 0.5, { cache });
  // The group was worked out once, for the first box, and used again for the second.
  assert.equal(cache.size, 3);
  assertBoxClose(a, layerBounds(document, scene, ["a"], 0.5));
  assertBoxClose(b, layerBounds(document, scene, ["b"], 0.5));
  assertBoxClose(b, { x: 70 - 200, y: -150, width: 10, height: 10 });
});
