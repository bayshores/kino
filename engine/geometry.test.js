import test from "node:test";
import assert from "node:assert/strict";
import {
  layerMatrix,
  parentMatrix,
  worldMatrix,
  inverse,
  point,
  multiply,
  transformProperties,
} from "./geometry.js";

test("nested rotation and scale use the same center transforms as the SVG renderer", () => {
  const group = {
    id: "g",
    parentId: null,
    x: 100,
    y: 200,
    width: 200,
    height: 100,
    rotation: 90,
    scaleX: 2,
    scaleY: 2,
  };
  const child = {
    id: "c",
    parentId: "g",
    x: 20,
    y: 10,
    width: 40,
    height: 20,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };
  const actual = point(worldMatrix(child, [group, child]), 0, 0);
  const expected = point(layerMatrix(group), 20, 10);
  assert.ok(Math.abs(actual.x - expected.x) < 1e-8);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-8);
  const local = point(
    inverse(parentMatrix(child, [group, child])),
    actual.x,
    actual.y,
  );
  assert.ok(Math.abs(local.x - 20) < 1e-8);
  assert.ok(Math.abs(local.y - 10) < 1e-8);
});

test("zero scale cannot produce infinite pointer coordinates", () => {
  assert.equal(
    inverse(
      layerMatrix({ x: 0, y: 0, width: 10, height: 10, scaleX: 0, scaleY: 1 }),
    ),
    null,
  );
});

test("ungroup decomposition preserves nonuniform scaled and rotated child geometry", () => {
  const group = {
    x: 100,
    y: 120,
    width: 240,
    height: 180,
    rotation: 30,
    scaleX: 2,
    scaleY: 0.7,
  };
  const child = {
    x: 20,
    y: 35,
    width: 80,
    height: 60,
    rotation: -17,
    scaleX: 1.2,
    scaleY: 0.9,
  };
  const combined = multiply(layerMatrix(group), layerMatrix(child));
  const result = layerMatrix({
    ...child,
    ...transformProperties(combined, child.width, child.height),
  });
  combined.forEach((value, index) =>
    assert.ok(Math.abs(value - result[index]) < 1e-8),
  );
});

test("world pointer movement under a transformed parent converts through inverse(worldMatrix)", () => {
  const parent = {
    id: "transformed-parent",
    parentId: null,
    x: 35,
    y: -12,
    width: 320,
    height: 200,
    rotation: 27,
    skewX: 10,
    scaleX: 1.3,
    scaleY: 0.75,
  };
  const initial = {
    id: "child",
    parentId: parent.id,
    x: 200,
    y: 120,
    width: 240,
    height: 120,
    rotation: -15,
    skewX: 8,
    scaleX: 1.5,
    scaleY: 1.5,
  };
  const matrix = worldMatrix(initial, [parent, initial]);
  const inverseWorld = inverse(matrix);
  const startWorld = point(matrix, 0, 0);
  const endWorld = point(matrix, 40, 0);
  const startLocal = point(inverseWorld, startWorld.x, startWorld.y);
  const endLocal = point(inverseWorld, endWorld.x, endWorld.y);
  const dx = endLocal.x - startLocal.x;
  const dy = endLocal.y - startLocal.y;
  assert.ok(Math.abs(dx - 40) < 1e-8);
  assert.ok(Math.abs(dy) < 1e-8);
});
