import test from "node:test";
import assert from "node:assert/strict";
import { accessShell, viewerKeyAction, viewerLayout, viewerPinsShortcut, viewerSceneIndex } from "./viewerNavigation.js";

test("the owner opens the dashboard, every share link opens the viewer, unknown access opens neither", () => {
  assert.equal(accessShell({ role: "owner" }), "dashboard");
  for (const role of ["view", "comment", "edit"]) assert.equal(accessShell({ role }), "viewer");
  for (const access of [null, {}, { role: "revoked" }]) assert.equal(accessShell(access), null);
});

test("viewer navigation follows document order and clamps at its ends", () => {
  const scenes = [{ id: "third" }, { id: "first" }, { id: "second" }];
  assert.equal(viewerSceneIndex(scenes, "first", "previous"), 0);
  assert.equal(viewerSceneIndex(scenes, "third", "previous"), 0);
  assert.equal(viewerSceneIndex(scenes, "first", "next"), 2);
  assert.equal(viewerSceneIndex(scenes, "second", "next"), 2);
  assert.equal(viewerSceneIndex(scenes, "second", "first"), 0);
  assert.equal(viewerSceneIndex(scenes, "third", "last"), 2);
  assert.equal(viewerSceneIndex(scenes, "deleted", "next"), 1);
  assert.equal(viewerSceneIndex([], "deleted", "first"), -1);
});

test("viewer shortcuts leave controls, editing targets, and modified keys alone", () => {
  assert.equal(viewerKeyAction({ key: "ArrowRight" }), "next");
  assert.equal(viewerKeyAction({ key: "PageUp" }), "previous");
  assert.equal(viewerKeyAction({ key: "Home" }), "first");
  assert.equal(viewerKeyAction({ key: "End" }), "last");
  assert.equal(viewerKeyAction({ key: " " }), "toggle");
  for (const property of ["ctrlKey", "metaKey", "altKey", "shiftKey", "defaultPrevented"])
    assert.equal(viewerKeyAction({ key: "ArrowRight", [property]: true }), null);
  assert.equal(viewerKeyAction({ key: "ArrowRight", target: { closest: () => ({}) } }), null);
  assert.equal(viewerKeyAction({ key: " ", target: { isContentEditable: true } }), null);
});

test("⇧C toggles the comment pins anywhere but while typing", () => {
  // A pin, a button or the page: the shortcut works there.
  const on = (selector) => ({ closest: (query) => (query.split(", ").includes(selector) ? {} : null) });
  assert.equal(viewerPinsShortcut({ key: "C", code: "KeyC", shiftKey: true }), true);
  assert.equal(viewerPinsShortcut({ key: "C", code: "KeyC", shiftKey: true, target: on("button") }), true);
  // Typing: a text field, a text box, a list, or editable text.
  for (const selector of ["input", "textarea", "select", "[contenteditable='true']"])
    assert.equal(viewerPinsShortcut({ key: "C", code: "KeyC", shiftKey: true, target: on(selector) }), false, selector);
  assert.equal(viewerPinsShortcut({ key: "C", code: "KeyC", shiftKey: true, target: { isContentEditable: true } }), false);
  // Other keys, a plain c, ⇧⌘C and a key another handler already took.
  assert.equal(viewerPinsShortcut({ key: "c", code: "KeyC" }), false);
  assert.equal(viewerPinsShortcut({ key: "C", code: "KeyC", shiftKey: true, metaKey: true }), false);
  assert.equal(viewerPinsShortcut({ key: "D", code: "KeyD", shiftKey: true }), false);
  assert.equal(viewerPinsShortcut({ key: "C", code: "KeyC", shiftKey: true, defaultPrevented: true }), false);
});

test("narrow windows and coarse pointers use scrolling cards", () => {
  assert.equal(viewerLayout(390), "cards");
  assert.equal(viewerLayout(719), "cards");
  assert.equal(viewerLayout(720), "stage");
  assert.equal(viewerLayout(1440, true), "cards");
});
