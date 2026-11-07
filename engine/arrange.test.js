import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "./model.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { point, worldMatrix } from "./geometry.js";
import { resizeTextLayer } from "./textLayout.js";
import {
  ALIGNMENT_IDS,
  alignLayers,
  alignmentFrame,
  alignmentReference,
  alignmentTargets,
  layerWorldBox,
  moveLayerByWorldDelta,
} from "./arrange.js";

const close = (actual, expected, label = "value") =>
  assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} is not ${expected}`);

// The scene after the alignment changes are applied, as the editor and agents apply them.
function aligned(scene, layerIds, align, scenes = []) {
  const moves = alignLayers(scene, layerIds, align, scenes);
  return {
    moves,
    scene: {
      ...scene,
      layers: scene.layers.map((layer) => {
        const move = moves.find((item) => item.id === layer.id);
        return move ? { ...layer, ...move } : layer;
      }),
    },
  };
}

const boxOf = (scene, id) => layerWorldBox(scene.layers.find((layer) => layer.id === id), scene.layers);

function sceneWith(layers, size = { width: 640, height: 360 }) {
  return createScene({ ...size, layers });
}

test("one top-level layer lines up with the scene edges and centers", () => {
  const card = createLayer("rectangle", { id: "card", x: 100, y: 50, width: 200, height: 100 });
  const scene = sceneWith([card]);
  const expected = {
    left: { x: 0, y: 50 },
    center: { x: 220, y: 50 },
    right: { x: 440, y: 50 },
    top: { x: 100, y: 0 },
    middle: { x: 100, y: 130 },
    bottom: { x: 100, y: 260 },
  };
  for (const align of ALIGNMENT_IDS) {
    const { moves } = aligned(scene, ["card"], align);
    assert.equal(moves.length, 1, align);
    assert.deepEqual({ x: moves[0].x, y: moves[0].y }, expected[align], align);
  }
  assert.equal(alignmentFrame(scene, ["card"]).reference, "scene");
});

test("a rotated layer aligns by its visible box, not its unrotated rectangle", () => {
  const card = createLayer("rectangle", { id: "card", x: 200, y: 100, width: 200, height: 100, rotation: 90 });
  const scene = sceneWith([card]);
  // Turned 90 degrees around its center, the 200 x 100 card covers 100 x 200 pixels.
  const before = boxOf(scene, "card");
  close(before.right - before.left, 100, "width");
  const left = aligned(scene, ["card"], "left").scene;
  close(boxOf(left, "card").left, 0, "left edge");
  const bottom = aligned(scene, ["card"], "bottom").scene;
  close(boxOf(bottom, "card").bottom, 360, "bottom edge");
  close(boxOf(bottom, "card").left, before.left, "bottom keeps the horizontal position");
});

test("one layer inside a rotated, scaled group lines up with the group's box", () => {
  const group = createLayer("group", { id: "group", x: 120, y: 40, width: 300, height: 200, rotation: 30, scaleX: 1.5, scaleY: 0.8 });
  const child = createLayer("rectangle", { id: "child", parentId: "group", x: 40, y: 30, width: 60, height: 40, rotation: 15 });
  const scene = sceneWith([group, child]);
  assert.equal(alignmentFrame(scene, ["child"]).reference, "group");
  const groupBox = boxOf(scene, "group");
  for (const [align, edge] of [["left", "left"], ["right", "right"], ["top", "top"], ["bottom", "bottom"]]) {
    const result = aligned(scene, ["child"], align).scene;
    close(boxOf(result, "child")[edge], groupBox[edge], `${align} edge`);
    close(boxOf(result, "group")[edge], groupBox[edge], "the group itself does not move");
  }
  const centered = aligned(scene, ["child"], "center").scene;
  const box = boxOf(centered, "child");
  close((box.left + box.right) / 2, (groupBox.left + groupBox.right) / 2, "horizontal center");
  // Moving along one screen axis inside a rotated group changes both of the child's own x and y.
  const move = alignLayers(scene, ["child"], "left")[0];
  assert.notEqual(move.x, child.x);
  assert.notEqual(move.y, child.y);
  close(box.top, boxOf(scene, "child").top, "a horizontal alignment keeps the vertical position");
});

test("several layers in different groups line up with the box around all of them", () => {
  const outer = createLayer("group", { id: "outer", x: 300, y: 80, width: 200, height: 200, scaleX: 2, scaleY: 2 });
  const inner = createLayer("group", { id: "inner", parentId: "outer", x: 20, y: 10, width: 100, height: 100, rotation: -45 });
  const nested = createLayer("ellipse", { id: "nested", parentId: "inner", x: 10, y: 20, width: 30, height: 20 });
  const top = createLayer("rectangle", { id: "top", x: 40, y: 220, width: 80, height: 50, rotation: 20 });
  const scene = sceneWith([outer, inner, nested, top]);
  const ids = ["nested", "top"];
  const frame = alignmentFrame(scene, ids);
  assert.equal(frame.reference, "selection");
  for (const [align, edge] of [["left", "left"], ["right", "right"], ["top", "top"], ["bottom", "bottom"]]) {
    const result = aligned(scene, ids, align).scene;
    for (const id of ids) close(boxOf(result, id)[edge], frame.box[edge], `${id} ${align}`);
  }
  for (const [align, start, end] of [["center", "left", "right"], ["middle", "top", "bottom"]]) {
    const result = aligned(scene, ids, align).scene;
    for (const id of ids) {
      const box = boxOf(result, id);
      close((box[start] + box[end]) / 2, (frame.box[start] + frame.box[end]) / 2, `${id} ${align}`);
    }
  }
  // The groups around the nested layer stay where they are.
  const result = aligned(scene, ids, "right").scene;
  assert.deepEqual(result.layers.find((layer) => layer.id === "outer"), outer);
  assert.deepEqual(result.layers.find((layer) => layer.id === "inner"), inner);
});

test("position animations move with the layer so it plays identically, shifted", () => {
  const group = createLayer("group", { id: "group", x: 50, y: 30, width: 400, height: 300, rotation: 30, scaleX: 2, scaleY: 2 });
  const card = createLayer("rectangle", { id: "card", parentId: "group", x: 40, y: 30, width: 80, height: 40 });
  card.animations = [
    presetAnimation("slide-up", card, 0, { width: 640, height: 360 }),
    { ...presetAnimation("move", card, 0.5), id: "move" },
    { ...presetAnimation("fade-in", card, 0), id: "fade" },
  ];
  const scene = sceneWith([group, card]);
  const result = aligned(scene, ["card"], "left");
  const moved = result.scene.layers.find((layer) => layer.id === "card");
  // Opacity values are not positions, so they stay as they were.
  assert.deepEqual(moved.animations[2], card.animations[2]);
  assert.deepEqual(moved.animations.map((animation) => animation.id), card.animations.map((animation) => animation.id));
  const worldDelta = boxOf(result.scene, "card").left - boxOf(scene, "card").left;
  assert.ok(Math.abs(worldDelta) > 1, "the card moves");
  // At every time, the animated card sits exactly worldDelta pixels to the side of where it was.
  for (const time of [0, 0.1, 0.3, 0.55, 0.8, 1.2, 3]) {
    const origin = (layer) => point(worldMatrix(evaluateLayer(layer, time), scene.layers), 0, 0);
    const before = origin(card),
      after = origin(moved);
    close(after.x - before.x, worldDelta, `x at ${time}s`);
    close(after.y - before.y, 0, `y at ${time}s`);
  }
});

test("a layer whose group is also selected moves with that group only", () => {
  const group = createLayer("group", { id: "group", x: 100, y: 100, width: 200, height: 100 });
  const child = createLayer("rectangle", { id: "child", parentId: "group", x: -50, y: 0, width: 40, height: 40 });
  const card = createLayer("rectangle", { id: "card", x: 400, y: 20, width: 40, height: 40 });
  const scene = sceneWith([group, child, card]);
  assert.deepEqual(alignmentTargets(scene.layers, ["child", "group", "card"]).map((layer) => layer.id), ["group", "card"]);
  assert.equal(alignmentReference(scene.layers, ["child", "group"]), "scene");
  assert.equal(alignmentReference(scene.layers, ["child"]), "group");
  assert.equal(alignmentReference(scene.layers, ["child", "card"]), "selection");
  const { moves } = aligned(scene, ["child", "group", "card"], "left");
  assert.deepEqual(moves.map((move) => move.id), ["card"]);
  assert.equal(moves[0].x, 100);
});

test("audio layers are not aligned, and a selection of only audio has nothing to align", () => {
  const audio = createLayer("audio", { id: "audio", x: 10, y: 10 });
  const card = createLayer("rectangle", { id: "card", x: 100, y: 100, width: 50, height: 50 });
  const scene = sceneWith([audio, card]);
  assert.equal(alignmentFrame(scene, ["audio"]), null);
  assert.equal(alignmentReference(scene.layers, ["audio"]), null);
  assert.deepEqual(alignLayers(scene, ["audio"], "left"), []);
  // With one visual layer left, it aligns to the scene.
  assert.deepEqual(alignLayers(scene, ["audio", "card"], "left").map((move) => [move.id, move.x]), [["card", 0]]);
});

test("locked and hidden layers are aligned like any other selected layer", () => {
  const card = createLayer("rectangle", { id: "card", x: 100, y: 100, width: 50, height: 50, locked: true, visible: false });
  assert.equal(alignLayers(sceneWith([card]), ["card"], "right")[0].x, 590);
});

test("aligned layers and layers that cannot move produce no change", () => {
  const card = createLayer("rectangle", { id: "card", x: 0, y: 0, width: 50, height: 50 });
  assert.deepEqual(alignLayers(sceneWith([card]), ["card"], "left"), []);
  assert.deepEqual(alignLayers(sceneWith([card]), ["missing"], "left"), []);
  const flat = createLayer("group", { id: "flat", x: 0, y: 0, width: 100, height: 100, scaleX: 0 });
  const inside = createLayer("rectangle", { id: "inside", parentId: "flat", x: 10, y: 10, width: 10, height: 10 });
  const other = createLayer("rectangle", { id: "other", x: 300, y: 10, width: 10, height: 10 });
  const moves = alignLayers(sceneWith([flat, inside, other]), ["inside", "other"], "top");
  assert.deepEqual(moves, []);
  assert.equal(moveLayerByWorldDelta(inside, [flat, inside], 10, 0), null);
});

test("component instances align by the size of their source scene", () => {
  const source = createScene({ id: "source", width: 200, height: 100 });
  const instance = createLayer("component", { id: "instance", componentSceneId: "source", x: 10, y: 10, width: 50, height: 50 });
  const scene = sceneWith([instance]);
  const [move] = alignLayers(scene, ["instance"], "right", [source, scene]);
  assert.equal(move.x, 440);
});

test("auto-sized text lines up by the size it is drawn at, even when its stored size is old", () => {
  // Text made the way the Text tool makes it, whose words then changed without measuring again
  // (as an agent's update_layer does). The stored box is still the size of "Hi".
  const made = resizeTextLayer(createLayer("text", { id: "title", text: "Hi", fontFamily: "Montserrat", textResize: "width-height", textAlign: "center", verticalAlign: "middle" }));
  const title = { ...made, text: "A much longer headline" };
  const drawnBox = (scene) => layerWorldBox(resizeTextLayer(scene.layers.find((layer) => layer.id === "title")), scene.layers);
  const scene = sceneWith([title]);
  assert.ok(drawnBox(scene).right - drawnBox(scene).left > 4 * made.width, "the drawn text is much wider than the stored box");
  close(boxOf(scene, "title").left, drawnBox(scene).left, "the box is the drawn text");
  for (const [align, edge, target] of [["left", "left", 0], ["right", "right", 640], ["top", "top", 0], ["bottom", "bottom", 360]]) {
    close(drawnBox(aligned(scene, ["title"], align).scene)[edge], target, `${align} edge`);
  }
  // Fixed-height text that grows downward from its top, inside a rotated group.
  const group = createLayer("group", { id: "group", x: 100, y: 60, width: 300, height: 200, rotation: 90 });
  const note = { ...resizeTextLayer(createLayer("text", { id: "title", parentId: "group", text: "One", fontFamily: "Montserrat", width: 120, textResize: "height", verticalAlign: "bottom" })), text: "One line\nand another\nand a third" };
  const nested = sceneWith([group, note]);
  const result = aligned(nested, ["title"], "top").scene;
  close(drawnBox(result).top, boxOf(nested, "group").top, "top of the rotated group");
  // Missing-font text aligns using the same real fallback geometry it draws with.
  const missing = sceneWith([{ ...title, fontFamily: "No Such Family" }]);
  const recovered = aligned(missing, ["title"], "left").scene;
  close(drawnBox(recovered).left, 0, "fallback text aligns to its drawn edge");
  assert.equal(recovered.layers[0].fontFamily, "No Such Family");
});

test("alignment leaves the scene untouched and refuses unknown or out-of-range moves", () => {
  const card = createLayer("rectangle", { id: "card", x: 100, y: 100, width: 50, height: 50 });
  const scene = sceneWith([card]);
  const before = structuredClone(scene);
  alignLayers(scene, ["card"], "center");
  assert.deepEqual(scene, before);
  assert.throws(() => alignLayers(scene, ["card"], "justify"), /Unknown alignment "justify"/);
  const tiny = createLayer("group", { id: "tiny", x: 0, y: 0, width: 100, height: 100, scaleX: 1e-4, scaleY: 1e-4 });
  const inside = createLayer("rectangle", { id: "inside", parentId: "tiny", x: 0, y: 0, width: 10, height: 10 });
  const far = createLayer("rectangle", { id: "far", x: 600, y: 0, width: 10, height: 10 });
  assert.throws(() => alignLayers(sceneWith([tiny, inside, far]), ["inside", "far"], "right"), /outside the supported position range/);
});
