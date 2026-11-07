import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { Resvg } from "@resvg/resvg-js";
import { renderSceneSvg } from "./render.js";
import { evaluateLayer } from "./animation.js";
import { FontRegistry } from "./fonts.js";
import { IDENTITY, inverse, multiply, parentMatrix, point } from "./geometry.js";
import { layerQuad } from "./selection.js";
import { resizeTextLayer } from "./textLayout.js";
import { resizeGroup, UnevenStretchError } from "./groupResize.js";
import {
  applyFromStart,
  boxScaleMatrix,
  inParentSpace,
  nudgeSelection,
  rotateSelection,
  rotationAbout,
  scaleSelection,
  selectionBox,
  transformTargets,
} from "./multiTransform.js";

const close = (a, b, message = "number") => assert.ok(Math.abs(a - b) <= 1e-6, `${message}: ${a} != ${b}`);
const rect = (id, props = {}) => createLayer("rectangle", { id, x: 10, y: 20, width: 80, height: 40, ...props });
const anim = (from, to) => ({ id: "a", name: "Custom", kind: "custom", start: 0, duration: 1, easing: "linear", from, to });
const apply = (layers, changes) => layers.map((layer) => ({ ...layer, ...changes.find((change) => change.id === layer.id) }));
const drawn = (layer) => resizeTextLayer(layer);

test("transform targets skip audio, locked ancestors and selected descendants, but keep hidden layers", () => {
  const layers = [rect("plain"), rect("hidden", { visible: false }), rect("locked", { locked: true }),
    createLayer("group", { id: "locked-group", locked: true }), rect("inside-locked", { parentId: "locked-group" }),
    createLayer("group", { id: "selected-group" }), rect("child", { parentId: "selected-group" }), createLayer("audio", { id: "audio" })];
  assert.deepEqual(transformTargets(layers, layers.map((l) => l.id)).map((l) => l.id), ["plain", "hidden", "selected-group"]);
  assert.deepEqual(transformTargets(layers, ["inside-locked"]), []);
});

test("selection bounds measure rotated rectangles, parent scale, component source and stale auto text", () => {
  const rotated = rect("r", { x: 20, y: 30, width: 100, height: 40, rotation: 30 });
  const box = selectionBox([rotated], [rotated]);
  const w = 100 * Math.cos(Math.PI / 6) + 20, h = 50 + 40 * Math.cos(Math.PI / 6);
  close(box.x, 70 - w / 2); close(box.y, 50 - h / 2); close(box.width, w); close(box.height, h);
  const group = createLayer("group", { id: "g", x: 100, y: 50, width: 200, height: 100, scaleX: 2, scaleY: 2 });
  const child = rect("c", { parentId: "g", x: 10, y: 20 });
  assert.deepEqual(selectionBox([child], [group, child]), { x: 20, y: 40, width: 160, height: 80 });
  const instance = createLayer("component", { id: "i", x: 5, y: 6, width: 1, height: 1, componentSceneId: "source" });
  assert.deepEqual(selectionBox([instance], [instance], { scenes: [{ id: "source", width: 120, height: 60 }] }), { x: 5, y: 6, width: 120, height: 60 });
  const text = createLayer("text", { id: "text", x: 10, y: 20, width: 400, height: 200, text: "Hi", textResize: "width-height", textAlign: "center", verticalAlign: "middle" });
  const measured = resizeTextLayer(text);
  assert.notEqual(measured.width, text.width);
  assert.deepEqual(selectionBox([text], [text]), { x: measured.x, y: measured.y, width: measured.width, height: measured.height });
  group.scaleX = 0;
  assert.equal(selectionBox([child], [group, child]), null);
  assert.equal(inParentSpace(child, [group, child], IDENTITY), null);
  assert.equal(selectionBox([], []), null);
  assert.equal(selectionBox([text], [text], { fonts: new FontRegistry() }), null);
});

function fixture() {
  const layers = [rect("root"), rect("turned", { x: 140, rotation: 30 }),
    createLayer("group", { id: "turn-parent", x: 240, y: 100, width: 180, height: 140, rotation: 45 }), rect("in-turn", { parentId: "turn-parent", rotation: 10 }),
    createLayer("group", { id: "scale-parent", x: 50, y: 250, width: 180, height: 140, scaleX: 2, scaleY: 1 }), rect("in-scale", { parentId: "scale-parent" }),
    createLayer("group", { id: "mirror-parent", x: 320, y: 250, width: 180, height: 140, scaleX: -1 }), rect("in-mirror", { parentId: "mirror-parent", rotation: 12 }),
    createLayer("group", { id: "skew-parent", x: 450, y: 350, width: 180, height: 140, rotation: 15, skewX: 18, scaleX: 1.5, scaleY: 0.7 }), rect("in-skew", { parentId: "skew-parent", rotation: 25, skewX: -7 }),
    createLayer("component", { id: "component", x: 400, y: 20, width: 1, height: 1, componentSceneId: "source", rotation: -20 }),
    createLayer("group", { id: "group", x: 450, y: 200, width: 160, height: 100, rotation: 15 }), rect("group-child", { parentId: "group", rotation: 30 }),
    createLayer("group", { id: "inner", parentId: "group", x: 90, y: 30, width: 50, height: 40, rotation: -10 }), rect("inner-child", { parentId: "inner", width: 15, height: 10 }),
    createLayer("group", { id: "mirror-group", x: 80, y: 380, width: 80, height: 40, rotation: -15, scaleX: -1 }), rect("mirror-child", { parentId: "mirror-group", x: 5, y: 5, width: 20, height: 10 }),
    createLayer("path", { id: "path", x: 10, y: 440, width: 100, height: 60, path: "M0 0 L100 0 L100 60 Z" }),
    createLayer("text", { id: "text", x: 200, y: 440, text: "Hi", textResize: "width-height", textAlign: "center", verticalAlign: "middle" })];
  return { layers, ids: ["root", "turned", "in-turn", "in-scale", "in-mirror", "in-skew", "component", "group", "mirror-group", "path", "text"], scenes: [{ id: "source", width: 120, height: 50, layers: [] }] };
}

function assertTransformed(before, after, ids, T, scenes) {
  for (const id of ids) {
    const a = before.find((l) => l.id === id), b = after.find((l) => l.id === id);
    const expected = layerQuad(a, before, { evaluate: drawn, scenes }).map((p) => point(T, p.x, p.y));
    const actual = layerQuad(b, after, { evaluate: drawn, scenes });
    actual.forEach((p, i) => { close(p.x, expected[i].x, `${id} corner ${i} x`); close(p.y, expected[i].y, `${id} corner ${i} y`); });
  }
}

test("even, uneven corner, edge and center scales put all targets and descendants exactly on the mapped quads", () => {
  const { layers, ids, scenes } = fixture();
  const box = selectionBox(transformTargets(layers, ids), layers, { scenes });
  const destinations = [
    { ...box, width: box.width * 1.5, height: box.height * 1.5 },
    { ...box, x: box.x - 40, y: box.y - 30, width: box.width * 1.3, height: box.height * 0.7 },
    { ...box, width: box.width * 0.8 },
    { ...box, x: box.x - box.width / 4, y: box.y - box.height / 8, width: box.width * 1.5, height: box.height * 1.25 },
  ];
  for (const to of destinations) {
    const T = boxScaleMatrix(box, to);
    const after = applyFromStart(layers, layers, ids, scaleSelection(layers, ids, T, { scenes }));
    assertTransformed(layers, after, [...ids, "group-child", "inner", "inner-child", "mirror-child"], T, scenes);
  }
});

test("37, 90 and -200 degree rotations preserve mapped quads through rotated, scaled and mirrored parents", () => {
  const { layers, ids, scenes } = fixture();
  for (const angle of [37, 90, -200]) {
    const T = rotationAbout({ x: 300, y: 200 }, angle);
    const after = applyFromStart(layers, layers, ids, rotateSelection(layers, ids, T, { scenes }));
    assertTransformed(layers, after, [...ids, "group-child", "inner", "inner-child", "mirror-child"], T, scenes);
    if (angle === 37) {
      assert.notEqual(after.find((l) => l.id === "in-scale").skewX, 0);
      for (const id of ["root", "turned", "in-turn", "in-mirror"]) close(after.find((l) => l.id === id).skewX, 0, id);
    }
  }
});

test("each move restarts from press values, restores start exactly, and preserves a collaborator's fill", () => {
  const { layers, ids, scenes } = fixture();
  const first = scaleSelection(layers, ids, [1.5, 0, 0, 0.7, -20, 10], { scenes });
  const last = scaleSelection(layers, ids, [0.8, 0, 0, 1.3, 10, -30], { scenes });
  const moved = applyFromStart(layers, layers, ids, first);
  assert.deepEqual(applyFromStart(moved, layers, ids, last), applyFromStart(layers, layers, ids, last));
  assert.deepEqual(applyFromStart(moved, layers, ids, scaleSelection(layers, ids, IDENTITY, { scenes })), layers);
  assert.deepEqual(applyFromStart(moved, layers, ids, rotateSelection(layers, ids, IDENTITY, { scenes })), layers);
  const turned = applyFromStart(layers, layers, ids, rotateSelection(layers, ids, rotationAbout({ x: 200, y: 200 }, 37), { scenes }));
  const turnAgain = rotateSelection(layers, ids, rotationAbout({ x: 200, y: 200 }, -200), { scenes });
  assert.deepEqual(applyFromStart(turned, layers, ids, turnAgain), applyFromStart(layers, layers, ids, turnAgain));
  assert.deepEqual(applyFromStart(turned, layers, ids, rotateSelection(layers, ids, IDENTITY, { scenes })), layers);
  const colored = moved.map((l) => l.id === "root" ? { ...l, fill: "#ff0000" } : l);
  assert.equal(applyFromStart(colored, layers, ids, last).find((l) => l.id === "root").fill, "#ff0000");
});

test("target keyframes stay untouched, while group descendants use the existing group animation stretch", () => {
  const root = rect("root", { rotation: 30, animations: [anim({ x: 0, rotation: 10 }, { x: 60, rotation: 120 })] });
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 200, height: 100, animations: [anim({ x: 0 }, { x: 20 })] });
  const child = rect("c", { parentId: "g", animations: [anim({ x: 10, width: 80 }, { x: 50, width: 100 })] });
  const layers = [root, group, child], T = [2, 0, 0, 3, 0, 0];
  const after = apply(layers, scaleSelection(layers, ["root", "g"], T));
  for (const id of ["root", "g"]) assert.deepEqual(after.find((l) => l.id === id).animations, layers.find((l) => l.id === id).animations);
  const existing = resizeGroup(layers, "g", { x: 0, y: 0, width: 400, height: 300 });
  assert.deepEqual(after[2].animations, existing.find((l) => l.id === "c").animations);
  const rotated = apply(layers, rotateSelection(layers, ["root", "g"], rotationAbout({ x: 0, y: 0 }, 37)));
  layers.forEach((l, i) => assert.deepEqual(rotated[i].animations, l.animations));
});

test("a selected group's rotating child refuses uneven stretch and accepts an even fallback", () => {
  const group = createLayer("group", { id: "g" });
  const child = rect("c", { parentId: "g", animations: [anim({ rotation: 0 }, { rotation: 90 })] });
  assert.throws(() => scaleSelection([group, child], ["g"], [2, 0, 0, 1, 0, 0]), UnevenStretchError);
  assert.doesNotThrow(() => scaleSelection([group, child], ["g"], [2, 0, 0, 2, 0, 0]));
});

test("out of range transforms refuse before changing input, and parent-space conjugation is exact", () => {
  const { layers, ids, scenes } = fixture(), before = structuredClone(layers);
  assert.throws(() => scaleSelection(layers, ids, [1e8, 0, 0, 1, 0, 0], { scenes }), RangeError);
  assert.deepEqual(layers, before);
  const child = layers.find((l) => l.id === "in-scale"), T = rotationAbout({ x: 10, y: 20 }, 37), P = parentMatrix(child, layers);
  assert.deepEqual(inParentSpace(child, layers, T), multiply(multiply(inverse(P), T), P));
});

test("nudges use the box's targets and drawn parent axes without moving target keyframes", () => {
  const parent = createLayer("group", { id: "g", x: 10, y: 20, width: 200, height: 200, animations: [anim({ rotation: 0 }, { rotation: 180 })] });
  const child = rect("c", { parentId: "g", animations: [anim({ x: 0 }, { x: 100 })] });
  const hidden = rect("hidden", { visible: false });
  const audio = createLayer("audio", { id: "audio" });
  const layers = [parent, child, hidden, audio];
  const evaluate = (layer) => evaluateLayer(layer, 0.5);
  const patches = nudgeSelection(layers, ["c", "hidden", "audio"], 10, 0, evaluate);
  assert.deepEqual(patches.map((p) => p.id), ["c", "hidden"]);
  close(patches[0].x, child.x); close(patches[0].y, child.y - 10);
  const after = apply(layers, patches);
  assert.deepEqual(after[1].animations, child.animations);
  assert.deepEqual(nudgeSelection(layers, ["g", "c"], 1, 0).map((p) => p.id), ["g"]);
});

test("auto text keyframes only get the look-preserving measured-box offset", () => {
  const text = createLayer("text", { id: "t", text: "Hi", textResize: "width-height", width: 400, height: 200, textAlign: "center", verticalAlign: "middle", animations: [anim({ x: 10, y: 20 }, { x: 60, y: 70 })] });
  const measured = resizeTextLayer(text), dx = measured.x - text.x, dy = measured.y - text.y;
  for (const changes of [scaleSelection([text], ["t"], [2, 0, 0, 1.5, 10, 20]), rotateSelection([text], ["t"], rotationAbout({ x: 20, y: 30 }, 37))]) {
    const next = apply([text], changes)[0];
    assert.deepEqual(next.animations, [{ ...text.animations[0], from: { x: 10 + dx, y: 20 + dy }, to: { x: 60 + dx, y: 70 + dy } }]);
  }
});

test("scaling a valid path without bounds scales its rendered pixels and restores its original missing basis", () => {
  for (const path of ["M0 0 L100 0 L100 60 L0 60 Z", "M10 5 L90 5 L90 55 L10 55 Z"]) {
    const scene = createScene({ width: 800, height: 160, background: "#ffffff", layers: [
      createLayer("path", { id: "p", x: 0, y: 0, width: 100, height: 60, path, fill: "#ff0000", strokeWidth: 0 }),
      rect("r", { x: 300, y: 0 }),
    ] });
    const start = parseDocument(createDocument({ scenes: [scene] })).scenes[0].layers;
    assert.equal(Object.hasOwn(start[0], "pathBounds"), false);
    const ids = ["p", "r"], T = [2, 0, 0, 2, 0, 0];
    const scaled = applyFromStart(start, start, ids, scaleSelection(start, ids, T));
    const saved = parseDocument(createDocument({ scenes: [{ ...scene, layers: scaled }] })).scenes[0];
    const pixels = new Resvg(renderSceneSvg(saved)).render().pixels;
    const pixel = (x, y) => [...pixels.subarray((y * scene.width + x) * 4, (y * scene.width + x) * 4 + 4)];
    assert.deepEqual(pixel(50, 30), [255, 0, 0, 255]);
    assert.deepEqual(pixel(150, 30), [255, 0, 0, 255]);
    if (path.startsWith("M10")) assert.deepEqual(pixel(15, 30), [255, 255, 255, 255]);
    const second = scaleSelection(start, ids, [1.5, 0, 0, 1.5, 5, 10]);
    assert.deepEqual(applyFromStart(scaled, start, ids, second), applyFromStart(start, start, ids, second));
    assert.deepEqual(applyFromStart(scaled, start, ids, scaleSelection(start, ids, IDENTITY)), start);
  }
});
