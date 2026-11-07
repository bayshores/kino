import test from "node:test";
import assert from "node:assert/strict";
import { isCommentPinsShortcut, pinPlacement, roundCoordinate, withPendingMoves } from "./commentPins.js";

const scenes = [
  { id: "s1", width: 400, height: 300, duration: 4 },
  { id: "s2", width: 200, height: 100, duration: 2 },
];

test("a pin sits inside its scene, at a tenth of a pixel, at a time within the scene", () => {
  assert.equal(roundCoordinate(12.345), 12.3);
  assert.equal(roundCoordinate(0.35), 0.4);
  assert.deepEqual(pinPlacement({ sceneId: "s2", x: 900, y: 50, time: 9 }, scenes[1]), { x: 200, y: 50, time: 2 });
  assert.deepEqual(pinPlacement({ sceneId: "s1" }, scenes[0]), { x: 0, y: 0 }, "a comment without x and y sits at the top-left corner");
});

test("moves that are not saved yet show on the comments without changing them", () => {
  const comments = [{ id: "a", x: 1, y: 1 }, { id: "b", x: 2, y: 2 }];
  assert.equal(withPendingMoves(comments, {}), comments);
  const shown = withPendingMoves(comments, { b: { x: 9, y: 8, sceneId: "s2" } });
  assert.deepEqual(shown, [{ id: "a", x: 1, y: 1 }, { id: "b", x: 9, y: 8, sceneId: "s2" }]);
  assert.deepEqual(comments[1], { id: "b", x: 2, y: 2 });
});

test("⇧C is the only press that hides or shows comment pins", () => {
  const press = (key, modifiers = {}) => ({ key, code: "KeyC", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
  assert.equal(isCommentPinsShortcut(press("C", { shiftKey: true })), true);
  assert.equal(isCommentPinsShortcut(press("c")), false, "plain C");
  assert.equal(isCommentPinsShortcut(press("c", { shiftKey: true, metaKey: true })), false, "⇧⌘C");
  assert.equal(isCommentPinsShortcut(press("C", { shiftKey: true, ctrlKey: true })), false);
  assert.equal(isCommentPinsShortcut(press("Ç", { shiftKey: true, altKey: true })), false, "⇧⌥C");
  // On a layout where this key types another letter, that letter decides (keyboardLayout.js).
  assert.equal(isCommentPinsShortcut({ key: "J", code: "KeyC", shiftKey: true }), false);
  // A Cyrillic layout types "С" on the C key; its position counts there.
  assert.equal(isCommentPinsShortcut({ key: "С", code: "KeyC", shiftKey: true }), true);
  assert.equal(isCommentPinsShortcut(null), false);
});
