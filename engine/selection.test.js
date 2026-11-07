import test from "node:test";
import assert from "node:assert/strict";
import { createLayer } from "./model.js";
import { ancestorIds, pickLayer, topmostFirst } from "./selection.js";

const layer = (type, id, props = {}) => createLayer(type, { id, name: id, ...props });

// Drawing order, bottom first:
//   bg            a rectangle at the top level
//   G             a group at (200, 0)
//     a           a rectangle inside G
//     H           a group inside G
//       b, c      rectangles inside H
//   top           an ellipse at the top level, drawn last
// The layer list shows them as: top, G, H, c, b, a, bg.
function nestedLayers(changes = {}) {
  const base = [
    layer("rectangle", "bg", { x: 0, y: 0, width: 100, height: 100 }),
    layer("group", "G", { x: 200, y: 0, width: 200, height: 200 }),
    layer("rectangle", "a", { parentId: "G", x: 0, y: 0, width: 50, height: 50 }),
    layer("group", "H", { parentId: "G", x: 100, y: 100, width: 100, height: 100 }),
    layer("rectangle", "b", { parentId: "H", x: 0, y: 0, width: 20, height: 20 }),
    layer("rectangle", "c", { parentId: "H", x: 50, y: 50, width: 20, height: 20 }),
    layer("ellipse", "top", { x: 500, y: 0, width: 50, height: 50 }),
  ];
  return base.map((item) => ({ ...item, ...(changes[item.id] ?? {}) }));
}

test("a plain click picks the outermost group, ⌘-click picks the layer itself", () => {
  const layers = nestedLayers();
  assert.equal(pickLayer(layers, ["b"], []), "G");
  assert.equal(pickLayer(layers, ["b"], [], { deep: true }), "b");
  assert.equal(pickLayer(layers, ["bg"], []), "bg");
  assert.equal(pickLayer(layers, [], []), null);
});

test("once a layer inside a group is selected, clicks pick layers at that level", () => {
  const layers = nestedLayers();
  // a is selected, so G is the context: a click on b (inside H) picks H, a's sibling.
  assert.equal(pickLayer(layers, ["b"], ["a"]), "H");
  // c is selected, so H is also the context: a click on b picks b, c's sibling.
  assert.equal(pickLayer(layers, ["b"], ["c"]), "b");
  // A click outside the context picks the top-level layer as usual.
  assert.equal(pickLayer(layers, ["top"], ["c"]), "top");
  // Selecting a top-level layer gives no context.
  assert.equal(pickLayer(layers, ["b"], ["top"]), "G");
});

test("a parent loop in a broken file does not hang the ancestor walk", () => {
  const layers = [
    layer("group", "p", { parentId: "q" }),
    layer("group", "q", { parentId: "p" }),
    layer("rectangle", "leaf", { parentId: "p" }),
  ];
  assert.deepEqual(ancestorIds(layers, "leaf"), ["p", "q"]);
  assert.equal(pickLayer(layers, ["leaf"], []), "q");
});

test("layers under the pointer are ordered topmost first", () => {
  const layers = nestedLayers();
  assert.deepEqual(topmostFirst(layers, ["bg", "b", "top", "a", "b", "missing"]), ["top", "b", "a", "bg"]);
});
