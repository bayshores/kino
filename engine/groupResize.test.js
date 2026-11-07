import test from "node:test";
import assert from "node:assert/strict";
import { createLayer } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { layerMatrix, multiply, point, worldMatrix } from "./geometry.js";
import { resizeGroup, stretchLayerBy, UnevenStretchError } from "./groupResize.js";
import { resizeTextLayer } from "./textLayout.js";

const TIMES = [0, 0.2, 0.5, 0.8, 1.2];

function animation(id, from, to, start = 0, duration = 1) {
  return { id, name: id, kind: "custom", start, duration, easing: "ease-in", from, to };
}

function applyChanges(layers, changes) {
  const byId = new Map(changes.map((change) => [change.id, change]));
  return layers.map((layer) => (byId.has(layer.id) ? { ...layer, ...byId.get(layer.id) } : layer));
}

function assertMatrix(actual, expected, message) {
  for (let index = 0; index < 6; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) < 1e-5,
      `${message}: [${actual.map((v) => v.toFixed(4))}] expected [${expected.map((v) => v.toFixed(4))}]`,
    );
  }
}

// Where a layer's box is drawn: the matrix that maps the unit square (0…1 across and down)
// onto the canvas. Comparing these ignores how the box is split into size and scale.
function boxOnCanvas(matrix, layer) {
  return multiply(matrix, [layer.width, 0, 0, layer.height, 0, 0]);
}

// The layer as the renderer draws it: auto-sized text is measured again (render.js does this).
const drawnLayer = (layer, evaluate) => resizeTextLayer(evaluate(layer));

function drawnBox(layers, layerId, evaluate = (layer) => layer) {
  const layer = drawnLayer(layers.find((item) => item.id === layerId), evaluate);
  return boxOnCanvas(worldMatrix(layer, layers, evaluate), layer);
}

// In proportion, a layer inside the group must land exactly where the group's stretch puts it:
// new group world matrix · stretch · the layer's old matrices inside the group.
function expectedStretched(after, groupId, across, down, before, layerId, evaluate = (layer) => layer) {
  const group = after.find((layer) => layer.id === groupId);
  const chain = [];
  let current = before.find((layer) => layer.id === layerId);
  while (current && current.id !== groupId) {
    chain.unshift(layerMatrix(drawnLayer(current, evaluate)));
    current = before.find((layer) => layer.id === current.parentId);
  }
  const matrix = chain.reduce(multiply, multiply(worldMatrix(group, after, evaluate), [across, 0, 0, down, 0, 0]));
  return boxOnCanvas(matrix, drawnLayer(before.find((layer) => layer.id === layerId), evaluate));
}

function setup() {
  const group = createLayer("group", { id: "g", x: 40, y: 30, width: 200, height: 100, rotation: 20 });
  const box = createLayer("rectangle", { id: "box", parentId: "g", x: 10, y: 20, width: 60, height: 30, rotation: 35 });
  // Its saved height is out of date: the text is measured again whenever it is drawn.
  const label = createLayer("text", { id: "label", parentId: "g", x: 100, y: 10, width: 80, height: 40, textResize: "height", verticalAlign: "bottom" });
  const inner = createLayer("group", { id: "inner", parentId: "g", x: 120, y: 50, width: 60, height: 40, rotation: -50, scaleX: 1.5, scaleY: 1.5 });
  const dot = createLayer("ellipse", { id: "dot", parentId: "inner", x: 5, y: 5, width: 20, height: 10, rotation: 15 });
  return [group, box, label, inner, dot];
}

test("stretchLayerBy applies a non-diagonal map exactly without changing the target's keyframes", () => {
  const layer = createLayer("rectangle", { id: "r", x: 20, y: 30, width: 100, height: 50, rotation: 30, scaleX: -1.2, scaleY: 0.8 });
  layer.animations.push(animation("spin", { rotation: 0 }, { rotation: 90 }));
  const T = [1.2, 0.3, 0.2, 1.4, 17, -11];
  const after = applyChanges([layer], stretchLayerBy([layer], "r", T));
  assertMatrix(drawnBox(after, "r"), multiply(T, drawnBox([layer], "r")), "general stretch");
  assert.deepEqual(after[0].animations, layer.animations);
});

test("resizing a group stretches every layer inside it exactly with the group", () => {
  const before = setup();
  const after = applyChanges(before, resizeGroup(before, "g", { x: 40, y: 30, width: 300, height: 250 }));
  const group = after.find((layer) => layer.id === "g");
  assert.deepEqual([group.width, group.height, group.rotation], [300, 250, 20]);
  for (const id of ["box", "label", "inner", "dot"]) {
    assertMatrix(drawnBox(after, id), expectedStretched(after, "g", 1.5, 2.5, before, id), id);
  }
  // A rotated layer stretched unevenly becomes slanted, and stays within the skew limit.
  assert.notEqual(after.find((layer) => layer.id === "box").skewX, 0);
  // Text keeps the box it was given instead of resizing itself back.
  assert.equal(after.find((layer) => layer.id === "label").textResize, "fixed");
  assert.equal(after.find((layer) => layer.id === "label").width, 120);
});

test("auto-sized text stretches from the box it is drawn in, not an out-of-date saved size", () => {
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 400, height: 300, rotation: 15 });
  // A new text layer keeps the 320 × 180 it starts with, but "Hi" is drawn far smaller.
  const title = createLayer("text", { id: "title", parentId: "g", x: 40, y: 30, text: "Hi", textResize: "width-height", textAlign: "center", verticalAlign: "middle", rotation: 25 });
  title.animations.push(animation("move", { x: 40, y: 30 }, { x: 140, y: 90 }));
  const before = [group, title];
  assert.notEqual(resizeTextLayer(title).width, title.width);
  for (const [width, height] of [[600, 450], [800, 300]]) {
    const after = applyChanges(before, resizeGroup(before, "g", { x: 0, y: 0, width, height }));
    const changed = after.find((layer) => layer.id === "title");
    assert.equal(changed.textResize, "fixed");
    for (const time of TIMES) {
      const evaluate = (layer) => evaluateLayer(layer, time);
      assertMatrix(drawnBox(after, "title", evaluate), expectedStretched(after, "g", width / 400, height / 300, before, "title", evaluate), `title ${width}×${height} at ${time}s`);
    }
  }
  // Auto-sized text that animates its size has no single box to stretch.
  title.animations.push(animation("grow", { width: 320 }, { width: 400 }));
  assert.throws(() => resizeGroup(before, "g", { x: 0, y: 0, width: 600, height: 450 }), /sizes itself to its text and animates its width or height/);
});

test("an even resize keeps rotations and animations exact at every time", () => {
  const before = setup();
  const box = before.find((layer) => layer.id === "box");
  box.animations.push(
    animation("move", { x: 10, y: 20 }, { x: 150, y: 70 }),
    animation("spin", { rotation: 35 }, { rotation: 200 }, 0.3),
    animation("size", { width: 60 }, { width: 120 }, 0.1),
  );
  const after = applyChanges(before, resizeGroup(before, "g", { x: 0, y: 0, width: 100, height: 50 }));
  assert.equal(after.find((layer) => layer.id === "box").rotation, 35);
  for (const time of TIMES) {
    const evaluate = (layer) => evaluateLayer(layer, time);
    assertMatrix(drawnBox(after, "box", evaluate), expectedStretched(after, "g", 0.5, 0.5, before, "box", evaluate), `box at ${time}s`);
  }
});

test("an uneven resize keeps an unrotated layer's animations exact", () => {
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 100, height: 100 });
  const bar = createLayer("rectangle", { id: "bar", parentId: "g", x: 10, y: 10, width: 30, height: 20 });
  bar.animations.push(animation("move", { x: 10, y: 10 }, { x: 60, y: 70 }), animation("grow", { width: 30 }, { width: 80 }, 0.4));
  const before = [group, bar];
  const after = applyChanges(before, resizeGroup(before, "g", { x: 0, y: 0, width: 300, height: 50 }));
  for (const time of TIMES) {
    const evaluate = (layer) => evaluateLayer(layer, time);
    assertMatrix(drawnBox(after, "bar", evaluate), expectedStretched(after, "g", 3, 0.5, before, "bar", evaluate), `bar at ${time}s`);
  }
});

test("a component instance inside a resized group changes scale, not size", () => {
  const scenes = [{ id: "button-scene", width: 120, height: 40, layers: [] }];
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 200, height: 200 });
  const button = createLayer("component", { id: "button", parentId: "g", componentSceneId: "button-scene", x: 20, y: 20, width: 1, height: 1, rotation: 30 });
  const before = [group, button];
  const after = applyChanges(before, resizeGroup(before, "g", { x: 0, y: 0, width: 400, height: 100 }, { scenes }));
  const changed = after.find((layer) => layer.id === "button");
  assert.equal(changed.width, 1);
  assert.notEqual(changed.scaleX, 1);
  const size = (layer) => ({ ...layer, width: 120, height: 40 });
  const actual = multiply(worldMatrix(after[0], after), layerMatrix(size(changed)));
  const expected = multiply(multiply(worldMatrix(after[0], after), [2, 0, 0, 0.5, 0, 0]), layerMatrix(size(button)));
  assertMatrix(actual, expected, "button");
});

test("holding Control resizes only the group's box and leaves its layers in place", () => {
  const before = setup();
  before.find((layer) => layer.id === "box").animations.push(animation("move", { x: 10, y: 20 }, { x: 150, y: 70 }));
  const changes = resizeGroup(before, "g", { x: 0, y: -20, width: 320, height: 160 }, { scaleChildren: false });
  const after = applyChanges(before, changes);
  // Only the group and its own layers' positions change; the dot inside "inner" is untouched.
  assert.deepEqual(changes.map((change) => change.id), ["g", "box", "label", "inner"]);
  for (const time of TIMES) {
    const evaluate = (layer) => evaluateLayer(layer, time);
    for (const id of ["box", "label", "inner", "dot"]) {
      assertMatrix(
        worldMatrix(after.find((layer) => layer.id === id), after, evaluate),
        worldMatrix(before.find((layer) => layer.id === id), before, evaluate),
        `${id} at ${time}s`,
      );
    }
  }
});

test("resizing refuses changes it can't draw", () => {
  const group = createLayer("group", { id: "g", width: 100, height: 100 });
  const flat = createLayer("rectangle", { id: "flat", parentId: "g", scaleX: 0 });
  assert.throws(() => resizeGroup([group, flat], "g", { x: 0, y: 0, width: 200, height: 100 }), /scaled to zero/);
  assert.throws(() => resizeGroup([group], "flat", { x: 0, y: 0, width: 1, height: 1 }), /Group flat was not found/);
  assert.throws(() => resizeGroup([group], "g", { x: 0, y: 0, width: Number.NaN, height: 1 }), /new width must be a number/);
});

// A 100 × 20 bar in the middle of a 200 × 200 group.
function spinningBar(extra = {}) {
  const group = createLayer("group", { id: "g", name: "Card", x: 0, y: 0, width: 200, height: 200 });
  const bar = createLayer("rectangle", { id: "bar", name: "Bar", parentId: "g", x: 50, y: 90, width: 100, height: 20, ...extra });
  return [group, bar];
}

test("an uneven resize refuses a layer whose rotation is animated, and an even one keeps it exact", () => {
  const before = spinningBar();
  before[1].animations.push(animation("spin", { rotation: 0 }, { rotation: 90 }));
  assert.throws(
    () => resizeGroup(before, "g", { x: 0, y: 0, width: 400, height: 200 }),
    (error) => error instanceof UnevenStretchError && /“Card” more one way than the other: “Bar” animates its rotation/.test(error.message) && error.reason === "“Bar” animates its rotation",
  );
  // A nested group passes an uneven stretch on, so a spinning layer inside it is refused too.
  const nested = [before[0], createLayer("group", { id: "inner", parentId: "g", x: 0, y: 0, width: 200, height: 200 }), { ...before[1], parentId: "inner" }];
  assert.throws(() => resizeGroup(nested, "g", { x: 0, y: 0, width: 400, height: 200 }), UnevenStretchError);
  // The same amount both ways is exact at every time.
  const after = applyChanges(before, resizeGroup(before, "g", { x: 0, y: 0, width: 400, height: 400 }));
  for (const time of TIMES) {
    const evaluate = (layer) => evaluateLayer(layer, time);
    assertMatrix(drawnBox(after, "bar", evaluate), expectedStretched(after, "g", 2, 2, before, "bar", evaluate), `bar at ${time}s`);
  }
  // At the end of the turn the bar stands upright: 40 wide and 200 tall after doubling.
  const end = drawnBox(after, "bar", (layer) => evaluateLayer(layer, 1));
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => point(end, x, y));
  assert.ok(Math.abs(Math.max(...corners.map((c) => c.x)) - Math.min(...corners.map((c) => c.x)) - 40) < 1e-6);
  assert.ok(Math.abs(Math.max(...corners.map((c) => c.y)) - Math.min(...corners.map((c) => c.y)) - 200) < 1e-6);
});

test("an uneven resize is exact at every time for every animation it accepts", () => {
  // Every mix of rest rotation and animated value; each either matches the stretched original
  // at every time or is refused with an UnevenStretchError.
  const rotations = [0, 90, 180, -90, 30, 135];
  const animated = {
    move: [{ x: 50, y: 90 }, { x: 10, y: 140 }],
    moveX: [{ x: 50 }, { x: 120 }],
    grow: [{ width: 100 }, { width: 40 }],
    tall: [{ height: 20 }, { height: 70 }],
    scale: [{ scaleX: 1, scaleY: 1 }, { scaleX: 2, scaleY: 0.5 }],
    scaleX: [{ scaleX: 1 }, { scaleX: 2 }],
    pop: [{ scaleX: 0, scaleY: 0 }, { scaleX: 1.5, scaleY: 1.5 }],
    spin: [{ rotation: 0 }, { rotation: 45 }],
  };
  const expectRefused = {
    spin: () => true,
    scale: (r) => r % 90 !== 0,
    scaleX: (r) => r % 90 !== 0,
    grow: (r) => r % 180 !== 0,
    tall: (r) => r % 180 !== 0,
  };
  let accepted = 0;
  for (const rotation of rotations) {
    for (const [name, [from, to]] of Object.entries(animated)) {
      for (const skewX of [0, 20]) {
        const before = spinningBar({ rotation, skewX });
        const start = name === "spin" ? { rotation } : from;
        before[1].animations.push(animation(name, start, name === "spin" ? { rotation: rotation + 45 } : to), animation("move2", { y: 90 }, { y: 30 }, 0.5));
        const refused = expectRefused[name]?.(rotation) ?? false;
        const resize = () => resizeGroup(before, "g", { x: 0, y: 0, width: 300, height: 120 });
        if (refused) {
          assert.throws(resize, UnevenStretchError, `${name} at ${rotation}° should be refused`);
          continue;
        }
        const after = applyChanges(before, resize());
        accepted += 1;
        for (const time of TIMES) {
          const evaluate = (layer) => evaluateLayer(layer, time);
          assertMatrix(drawnBox(after, "bar", evaluate), expectedStretched(after, "g", 1.5, 0.6, before, "bar", evaluate), `${name} at ${rotation}°, skew ${skewX}, ${time}s`);
        }
      }
    }
  }
  assert.ok(accepted > 40);
});


test("an uneven resize keeps a rotated layer that grows or shrinks the same amount both ways", () => {
  // The bar is drawn twice as wide as tall by its scale, and its animation keeps that shape.
  const before = spinningBar({ rotation: 30, scaleX: 2, scaleY: 1 });
  before[1].animations.push(animation("pop", { scaleX: 0.5, scaleY: 0.25 }, { scaleX: 3, scaleY: 1.5 }));
  const after = applyChanges(before, resizeGroup(before, "g", { x: 0, y: 0, width: 300, height: 120 }));
  for (const time of TIMES) {
    const evaluate = (layer) => evaluateLayer(layer, time);
    assertMatrix(drawnBox(after, "bar", evaluate), expectedStretched(after, "g", 1.5, 0.6, before, "bar", evaluate), `${time}s`);
  }
  // Changing the shape instead is refused.
  before[1].animations[0].to = { scaleX: 3, scaleY: 3 };
  assert.throws(
    () => resizeGroup(before, "g", { x: 0, y: 0, width: 300, height: 120 }),
    (error) => error instanceof UnevenStretchError && error.reason === "“Bar” animates its scale more one way than the other while rotated",
  );
});
