import test from "node:test";
import assert from "node:assert/strict";
import { mergeIdOrder } from "./mergeOrder.js";

test("keeps insertions from both sides in a shared gap with a stable local-first tie choice", () => {
  const result = mergeIdOrder(["a", "b"], ["a", "local", "b"], ["a", "remote", "b"], ["a", "b", "local", "remote"]);
  assert.deepEqual(result, { ids: ["a", "local", "remote", "b"], conflictIds: [] });
});

test("filters deleted and moved-out IDs to the final collection membership", () => {
  const deleted = mergeIdOrder(["a", "b", "c", "d"], ["a", "c", "d"], ["a", "b", "d"], ["a", "d"]);
  assert.deepEqual(deleted, { ids: ["a", "d"], conflictIds: [] });

  const movedToAnotherOwner = mergeIdOrder(["a", "b", "c"], ["a", "c", "b"], ["a", "b", "c"], ["a", "c"]);
  assert.deepEqual(movedToAnotherOwner, { ids: ["a", "c"], conflictIds: [] });
});

test("an unchanged local sequence does not undo a remote reorder", () => {
  const base = ["a", "b", "c", "d"];
  const result = mergeIdOrder(base, base, ["a", "c", "b", "d"], base);
  assert.deepEqual(result, { ids: ["a", "c", "b", "d"], conflictIds: [] });
});

test("independent moves compose without a conflict", () => {
  const base = ["a", "b", "c", "d", "e", "f"];
  const result = mergeIdOrder(base, ["a", "c", "d", "e", "f", "b"], ["e", "a", "b", "c", "d", "f"], base);
  assert.deepEqual(result, { ids: ["e", "a", "c", "d", "f", "b"], conflictIds: [] });
});

test("reports only a base ID moved to different neighbor gaps and applies the later local placement", () => {
  const base = ["a", "b", "c", "d"];
  const result = mergeIdOrder(base, ["a", "c", "d", "b"], ["b", "a", "c", "d"], base);
  assert.deepEqual(result, { ids: ["a", "c", "d", "b"], conflictIds: ["b"] });

  const sameMove = mergeIdOrder(base, ["b", "a", "c", "d"], ["b", "a", "c", "d"], base);
  assert.deepEqual(sameMove, { ids: ["b", "a", "c", "d"], conflictIds: [] });
});

test("handles empty collections and deterministically appends unmentioned present IDs", () => {
  assert.deepEqual(mergeIdOrder([], [], [], []), { ids: [], conflictIds: [] });
  assert.deepEqual(mergeIdOrder(["gone"], [], [], []), { ids: [], conflictIds: [] });
  assert.deepEqual(mergeIdOrder([], [], [], new Set(["z", "a", "m"])), { ids: ["a", "m", "z"], conflictIds: [] });
});

test("validates unique string IDs and does not mutate inputs", () => {
  const base = ["a", "b", "c"], ours = ["a", "c", "b"], theirs = ["a", "b", "c"], present = ["a", "b", "c"];
  const copies = structuredClone([base, ours, theirs, present]);
  mergeIdOrder(base, ours, theirs, present);
  assert.deepEqual([base, ours, theirs, present], copies);

  assert.throws(() => mergeIdOrder(["a", "a"], [], [], []), /duplicate/);
  assert.throws(() => mergeIdOrder([], ["a", 1], [], ["a"]), /string IDs/);
  assert.throws(() => mergeIdOrder([], [], [], ["a", "a"]), /duplicate/);
  assert.throws(() => mergeIdOrder([], [], [], new Set(["a", null])), /string IDs/);
  assert.throws(() => mergeIdOrder(null, [], [], []), /array/);
});
