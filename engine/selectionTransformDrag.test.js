import test from "node:test";
import assert from "node:assert/strict";
import { createLayer } from "./model.js";
import { selectionResizeAt } from "./selectionTransformDrag.js";

const layer = createLayer("rectangle", { id: "r", x: 0, y: 0, width: 100, height: 50 });
const box = { x: 0, y: 0, width: 100, height: 50 };

test("Shift, Alt and forced aspect lock recalculate from the same press snapshot", () => {
  const plain = selectionResizeAt([layer], ["r"], box, 20, 5, 1, 1);
  assert.deepEqual(plain.transform, [1.2, 0, 0, 1.1, 0, 0]);
  const shift = selectionResizeAt([layer], ["r"], box, 20, 5, 1, 1, { keepAspect: true });
  assert.deepEqual(shift.transform, [1.2, 0, 0, 1.2, 0, 0]);
  const alt = selectionResizeAt([layer], ["r"], box, 20, 5, 1, 1, { fromCenter: true });
  assert.deepEqual(alt.transform, [1.4, 0, 0, 1.2, -20, -5]);
  assert.deepEqual(selectionResizeAt([layer], ["r"], box, 20, 5, 1, 1), plain);
});

test("selection union resize is not capped at the per-layer size limit", () => {
  const layers = [
    createLayer("rectangle", { id: "left", x: 0, y: 0, width: 100, height: 100 }),
    createLayer("rectangle", { id: "right", x: 70_000, y: 0, width: 100, height: 100 }),
  ];
  const union = { x: 0, y: 0, width: 70_100, height: 100 };

  for (const options of [{}, { keepAspect: true }, { fromCenter: true }, { keepAspect: true, fromCenter: true }]) {
    const dx = options.fromCenter ? 5 : 10;
    const result = selectionResizeAt(layers, ["left", "right"], union, dx, 0, 1, 0, options);
    assert.equal(result.size.width, 70_110, JSON.stringify(options));
    assert.equal(result.changes.length, 2, JSON.stringify(options));
    const right = result.changes.find((change) => change.id === "right");
    const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
    assert.equal(right.x, round(70_000 * result.transform[0] + result.transform[4], 6), JSON.stringify(options));
    assert.equal(right.width, round(100 * result.transform[0], 9), JSON.stringify(options));
    assert.equal(right.height, round(100 * result.transform[3], 9), JSON.stringify(options));
  }
});

test("selection resize rejects an out-of-range target before changing its snapshot", () => {
  const layers = [
    createLayer("rectangle", { id: "left", x: 0, y: 0, width: 100, height: 100 }),
    createLayer("rectangle", { id: "right", x: 900_000, y: 0, width: 100, height: 100 }),
  ];
  const snapshot = structuredClone(layers);
  const union = { x: 0, y: 0, width: 900_100, height: 100 };

  assert.throws(() => selectionResizeAt(layers, ["left", "right"], union, 900_100, 0, 1, 0), RangeError);
  assert.deepEqual(layers, snapshot);
});

test("an uneven animation refusal computes a working proportional fallback and a reason", () => {
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 100, height: 50 });
  const child = createLayer("rectangle", { id: "c", parentId: "g", animations: [{ id: "a", name: "Spin", kind: "custom", start: 0, duration: 1, easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } }] });
  const result = selectionResizeAt([group, child], ["g"], box, 20, 0, 1, 0);
  assert.match(result.reason, /animates its rotation/);
  assert.equal(result.transform[0], result.transform[3]);
  assert.equal(result.changes.length, 2);
});
