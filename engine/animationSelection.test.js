import test from "node:test";
import assert from "node:assert/strict";
import { animationOrder } from "./animationSelection.js";

const layers = [
  { id: "a", animations: [{ id: "a1" }, { id: "a2" }] },
  { id: "b", animations: [] },
  { id: "c", animations: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] },
];
const order = animationOrder(layers);

test("animationOrder lists the animations in the Timeline's row order, across layers", () => {
  assert.deepEqual(order, ["a1", "a2", "c1", "c2", "c3"]);
  assert.deepEqual(animationOrder([{ id: "x" }]), []);
});
