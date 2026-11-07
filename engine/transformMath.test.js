import test from "node:test";
import assert from "node:assert/strict";
import { layerMatrix, point } from "./geometry.js";
import { MAX_SIZE, fixedPoint, placeResized, resizeBox, sizeFieldPatch } from "./transformMath.js";

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? "value"}: expected ${expected}, got ${actual}`);
const closePoint = (actual, expected, message) => {
  close(actual.x, expected.x, `${message} x`);
  close(actual.y, expected.y, `${message} y`);
};
const box = (values = {}) => ({ id: "box", parentId: null, x: 10, y: 20, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, ...values });

test("the side opposite the dragged handle stays put, or the center with Option", () => {
  assert.deepEqual(fixedPoint(1, 1), { u: 0, v: 0 }, "bottom-right corner: the top-left stays");
  assert.deepEqual(fixedPoint(-1, -1), { u: 1, v: 1 }, "top-left corner: the bottom-right stays");
  assert.deepEqual(fixedPoint(1, -1), { u: 0, v: 1 });
  assert.deepEqual(fixedPoint(1, 1, { fromCenter: true }), { u: 0.5, v: 0.5 });
  assert.deepEqual(fixedPoint(0, 1, { fromCenter: true }), { u: 0.5, v: 0.5 });
  // An edge: the other direction keeps its top or left side, or its center when it grows too.
  assert.deepEqual(fixedPoint(0, 1), { u: 0, v: 0 });
  assert.deepEqual(fixedPoint(-1, 0), { u: 1, v: 0 });
  assert.deepEqual(fixedPoint(-1, 0, { keepAspect: true }), { u: 1, v: 0.5 });
  assert.throws(() => fixedPoint(0, 0), /not both 0/);
  assert.throws(() => fixedPoint(2, 1), /handle/);
});

test("a corner follows the pointer, an edge changes one side, and Option doubles the change", () => {
  const start = { width: 100, height: 50 };
  assert.deepEqual(resizeBox(start, { dx: 20, dy: 10, h: 1, v: 1 }), { width: 120, height: 60 });
  assert.deepEqual(resizeBox(start, { dx: -20, dy: -10, h: -1, v: -1 }), { width: 120, height: 60 }, "dragging the top-left corner outward");
  assert.deepEqual(resizeBox(start, { dx: 30, dy: 99, h: 1, v: 0 }), { width: 130, height: 50 }, "a side edge ignores up and down");
  assert.deepEqual(resizeBox(start, { dx: 99, dy: -5, h: 0, v: -1 }), { width: 100, height: 55 }, "the top edge ignores left and right");
  assert.deepEqual(resizeBox(start, { dx: 10, dy: 10, h: 1, v: 1, fromCenter: true }), { width: 120, height: 70 });
});

test("keeping the proportions follows the side the pointer moved most, and an edge its own side", () => {
  const start = { width: 100, height: 50 };
  assert.deepEqual(resizeBox(start, { dx: 50, dy: 5, h: 1, v: 1, keepAspect: true }), { width: 150, height: 75 });
  assert.deepEqual(resizeBox(start, { dx: 2, dy: 25, h: 1, v: 1, keepAspect: true }), { width: 150, height: 75 });
  assert.deepEqual(resizeBox(start, { dx: 50, h: 1, v: 0, keepAspect: true }), { width: 150, height: 75 });
  assert.deepEqual(resizeBox(start, { dy: 25, h: 0, v: 1, keepAspect: true }), { width: 150, height: 75 });
  assert.deepEqual(resizeBox(start, { dx: 25, h: 1, v: 1, keepAspect: true, fromCenter: true }), { width: 150, height: 75 });
});

test("a resize stops at the smallest and largest sizes, together when the proportions are kept", () => {
  const start = { width: 100, height: 50 };
  assert.deepEqual(resizeBox(start, { dx: -500, h: 1, v: 1 }), { width: 1, height: 50 });
  assert.deepEqual(resizeBox(start, { dx: -500, h: 1, v: 1, keepAspect: true }), { width: 2, height: 1 });
  assert.deepEqual(resizeBox({ width: 40_000, height: 20_000 }, { dx: 40_000, h: 1, v: 0, keepAspect: true }), { width: MAX_SIZE, height: MAX_SIZE / 2 });
  assert.deepEqual(resizeBox({ width: 0.5, height: 50 }, { dx: -10, h: 1, v: 0 }), { width: 0.5, height: 50 }, "a layer already smaller than the minimum doesn't jump up to it");
  assert.throws(() => resizeBox({ width: 0, height: 50 }, { dx: 1, h: 1, v: 1 }), /positive width and height/);
  assert.throws(() => resizeBox(start, { dx: Number.NaN, h: 1, v: 1 }), /finite/);
});

test("placeResized keeps the fixed point in place on a rotated, scaled layer", () => {
  const flat = box();
  assert.deepEqual(placeResized(flat, { ...flat, width: 120, height: 60 }, fixedPoint(1, 1)), { x: 10, y: 20 });
  assert.deepEqual(placeResized(flat, { ...flat, width: 120, height: 60 }, fixedPoint(-1, -1)), { x: -10, y: 10 });
  const turned = box({ rotation: 37, scaleX: 1.5, scaleY: 0.5, skewX: 10 });
  for (const [h, v, options] of [
    [1, 1, {}],
    [-1, 1, {}],
    [0, -1, {}],
    [1, -1, { fromCenter: true }],
    [1, 0, { keepAspect: true }],
  ]) {
    const fixed = fixedPoint(h, v, options);
    const size = resizeBox(turned, { dx: 30, dy: -12, h, v, ...options });
    const next = { ...turned, ...size };
    Object.assign(next, placeResized(turned, next, fixed));
    closePoint(
      point(layerMatrix(next), fixed.u * next.width, fixed.v * next.height),
      point(layerMatrix(turned), fixed.u * turned.width, fixed.v * turned.height),
      `handle ${h},${v}`,
    );
  }
});

test("the aspect-ratio lock makes the Inspector's width and height change together", () => {
  const free = box();
  assert.deepEqual(sizeFieldPatch(free, "width", 200), { width: 200 });
  const locked = box({ lockAspect: true });
  assert.deepEqual(sizeFieldPatch(locked, "width", 200), { width: 200, height: 100 });
  assert.deepEqual(sizeFieldPatch(locked, "height", 25), { height: 25, width: 50 });
  assert.deepEqual(sizeFieldPatch(box({ lockAspect: true, width: 3, height: 7 }), "width", 10), { width: 10, height: 23.333333 });
  // Both sides stay within the sizes a layer can have, keeping the proportions.
  assert.deepEqual(sizeFieldPatch(locked, "height", 40_000), { height: 32_768, width: 65_536 });
  assert.deepEqual(sizeFieldPatch(box({ lockAspect: true, width: 100, height: 1 }), "width", 0.01), { width: 0.1, height: 0.001 });
  // Something that isn't a number is left for the field's own check to refuse.
  assert.deepEqual(sizeFieldPatch(locked, "width", Number.NaN), { width: Number.NaN });
  assert.throws(() => sizeFieldPatch(locked, "x", 10), /width or height/);
});
