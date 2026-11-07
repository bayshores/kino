import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { IDENTITY, multiply, point, worldMatrix } from "../engine/geometry.js";
import { layerQuad } from "../engine/selection.js";
import { rotateSelection, rotationAbout, scaleSelection, selectionBox } from "../engine/multiTransform.js";
import { evaluateLayer } from "../engine/animation.js";
import { renderSceneSvg } from "../engine/render.js";
import { documentMediaIds } from "./media-use.mjs";
import { exportScene, renderStills } from "./export.mjs";
import { near, readImage } from "./media.test.support.mjs";

const close = (a, b, message) => assert.ok(Math.abs(a - b) <= 1e-6, `${message}: ${a} != ${b}`);

function fixture() {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 320, height: 240, duration: 1, layers: [
    createLayer("group", { id: "g", name: "Parent", x: 70, y: 80, width: 120, height: 100, scaleX: 2, scaleY: 1 }),
    createLayer("rectangle", { id: "red", name: "Red", parentId: "g", x: 30, y: 20, width: 40, height: 30, fill: "#ff0000", radius: 0, strokeWidth: 0 }),
    createLayer("rectangle", { id: "blue", name: "Blue", x: 220, y: 70, width: 30, height: 40, rotation: 30, fill: "#0000ff", radius: 0, strokeWidth: 0 }),
  ] })] }));
}

// The same update_layer operation exposed by MCP. No new persisted transform format is needed.
function edit(source, changes) {
  return applyOperations(source, changes.map(({ id, ...properties }) => ({ type: "update_layer", sceneId: "main", layerId: id, properties })));
}

test("multi-transform changes survive MCP operations, document validation and shared SVG rendering", () => {
  const before = fixture(), scene = before.scenes[0], T = [1.2, 0, 0, 0.7, -10, 25];
  const after = parseDocument(JSON.stringify(edit(before, scaleSelection(scene.layers, ["red", "blue"], T))));
  const rendered = expandComponents(after, "main");
  assert.match(renderSceneSvg(rendered, 0), /data-layer-id="red"/);
  assert.match(renderSceneSvg(rendered, 0), /data-layer-id="blue"/);
  assert.deepEqual([...documentMediaIds(after)], []);
  for (const id of ["red", "blue"]) {
    const a = layerQuad(scene.layers.find((l) => l.id === id), scene.layers).map((p) => point(T, p.x, p.y));
    const b = layerQuad(after.scenes[0].layers.find((l) => l.id === id), after.scenes[0].layers);
    b.forEach((p, i) => { close(p.x, a[i].x, `${id} x`); close(p.y, a[i].y, `${id} y`); });
  }
});

test("PNG export places both transformed objects at the mapped centers, including a sheared child", async () => {
  const source = fixture(), scene = source.scenes[0], T = rotationAbout({ x: 160, y: 120 }, 37);
  const changed = edit(source, rotateSelection(scene.layers, ["red", "blue"], T));
  assert.notEqual(changed.scenes[0].layers.find((l) => l.id === "red").skewX, 0);
  const image = await readImage((await exportScene(expandComponents(changed, "main"), { format: "png" })).buffer);
  for (const [id, color] of [["red", [255, 0, 0, 255]], ["blue", [0, 0, 255, 255]]]) {
    const layer = scene.layers.find((l) => l.id === id);
    const expected = point(multiply(T, worldMatrix(layer, scene.layers)), layer.width / 2, layer.height / 2);
    assert.ok(near(image.pixel(Math.round(expected.x), Math.round(expected.y)), color), `${id} is painted at its transformed center`);
  }
});

// Reconstruct a static native Lottie transform. Lottie shears before scale, while the
// document shears after scale; this checks the actual exported decomposition.
function lottieMatrix(ks) {
  const position = ks.p.k, anchor = ks.a.k, sx = ks.s.k[0] / 100, sy = ks.s.k[1] / 100;
  const angle = ks.r.k * Math.PI / 180, shear = -Math.tan((ks.sk?.k ?? 0) * Math.PI / 180);
  const a = Math.cos(angle) * sx, b = Math.sin(angle) * sx;
  const c = (Math.cos(angle) * shear - Math.sin(angle)) * sy;
  const d = (Math.sin(angle) * shear + Math.cos(angle)) * sy;
  return [a, b, c, d, position[0] - a * anchor[0] - c * anchor[1], position[1] - b * anchor[0] - d * anchor[1]];
}

test("native Lottie export preserves transformed world matrices through nonuniform parents", async () => {
  const source = fixture(), scene = source.scenes[0], T = rotationAbout({ x: 160, y: 120 }, -200);
  const changed = edit(source, rotateSelection(scene.layers, ["red", "blue"], T));
  const result = await exportScene(expandComponents(changed, "main"), { format: "lottie", fps: 4 });
  const animation = JSON.parse(result.buffer.toString());
  const found = new Map();
  function visit(layers, parent = IDENTITY) {
    for (const layer of layers) {
      if (!layer.ks) continue;
      const matrix = multiply(parent, lottieMatrix(layer.ks));
      if (layer.nm === "Red" || layer.nm === "Blue") found.set(layer.nm, matrix);
      const asset = animation.assets.find((item) => item.id === layer.refId);
      if (asset?.layers) visit(asset.layers, matrix);
    }
  }
  visit(animation.layers);
  for (const [id, name] of [["red", "Red"], ["blue", "Blue"]]) {
    const layer = scene.layers.find((l) => l.id === id);
    // Native rectangles retain their 0..width / 0..height local geometry.
    const expected = multiply(T, worldMatrix(layer, scene.layers));
    const actual = found.get(name);
    assert.ok(actual, `${name} is a native Lottie layer`);
    actual.forEach((value, i) => close(value, expected[i], `${name} matrix entry ${i}`));
  }
});

test("paused animated-size rotation survives MCP edits, validation and PNG rendering", async () => {
  const source = parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 700, height: 500, background: "#ffffff", duration: 1, layers: [
    createLayer("rectangle", { id: "a", x: 80, y: 250, width: 100, height: 40, rotation: 30, fill: "#ff0000", radius: 0, strokeWidth: 0, animations: [{ id: "size", name: "Custom", kind: "custom", start: 0, duration: 1, easing: "linear", from: { width: 100 }, to: { width: 300 } }] }),
    createLayer("rectangle", { id: "b", x: 450, y: 260, width: 100, height: 40, fill: "#0000ff", radius: 0, strokeWidth: 0 }),
  ] })] }));
  const scene = source.scenes[0], evaluate = (layer) => evaluateLayer(layer, 0.5);
  const box = selectionBox(scene.layers, scene.layers, { evaluate });
  const T = rotationAbout({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, 90);
  const changed = parseDocument(edit(source, rotateSelection(scene.layers, ["a", "b"], T, { evaluate })));
  assert.deepEqual(changed.scenes[0].layers[0].animations, scene.layers[0].animations);
  const png = await readImage((await exportScene(expandComponents(changed, "main"), { format: "png", time: 0.5 })).buffer);
  const shown = evaluate(scene.layers[0]), matrix = multiply(T, worldMatrix(scene.layers[0], scene.layers, evaluate));
  for (const [u, v] of [[0.1, 0.25], [0.5, 0.5], [0.9, 0.75]]) {
    const at = point(matrix, shown.width * u, shown.height * v);
    assert.ok(near(png.pixel(Math.round(at.x), Math.round(at.y)), [255, 0, 0, 255]), `animated red rectangle paints transformed interior (${u}, ${v})`);
  }
});

test("paths without optional bounds scale in real PNG and native Lottie exports, including group children", async () => {
  for (const grouped of [false, true]) {
    const path = createLayer("path", { id: "p", name: "Resized path", parentId: grouped ? "g" : null, x: 0, y: 0, width: 100, height: 60, path: "M10 5 L90 5 L90 55 L10 55 Z", fill: "#ff0000", strokeWidth: 0 });
    const source = parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 800, height: 160, duration: 1, background: "#ffffff", layers: [
      ...(grouped ? [createLayer("group", { id: "g", x: 0, y: 0, width: 200, height: 120 })] : []),
      path, createLayer("rectangle", { id: "other", x: 300, y: 0, width: 100, height: 60 }),
    ] })] }));
    const scene = source.scenes[0];
    const changed = parseDocument(JSON.stringify(edit(source, scaleSelection(scene.layers, [grouped ? "g" : "p", "other"], [2, 0, 0, 2, 0, 0]))));
    const savedPath = changed.scenes[0].layers.find((layer) => layer.id === "p");
    assert.deepEqual(savedPath.pathBounds, { width: 100, height: 60 });
    const rendered = expandComponents(changed, "main");
    const png = await readImage((await exportScene(rendered, { format: "png" })).buffer);
    assert.ok(near(png.pixel(150, 30), [255, 0, 0, 255]));
    assert.ok(near(png.pixel(15, 30), [255, 255, 255, 255]), "the nonzero path origin stretches from local zero");
    const animation = JSON.parse((await exportScene(rendered, { format: "lottie", fps: 4 })).buffer.toString());
    const layers = [...animation.layers, ...animation.assets.flatMap((asset) => asset.layers ?? [])];
    const native = layers.find((layer) => layer.nm === "Resized path");
    assert.ok(native?.shapes, "the path exports as native vector geometry");
    const shapes = (items) => items.flatMap((item) => item.ty === "sh" ? [item] : shapes(item.it ?? []));
    const outline = shapes(native.shapes)[0];
    assert.equal(outline.ks.a, 0);
    const vertices = outline.ks.k.v;
    assert.deepEqual([Math.min(...vertices.map((v) => v[0])), Math.max(...vertices.map((v) => v[0]))], [20, 180]);
    assert.deepEqual([Math.min(...vertices.map((v) => v[1])), Math.max(...vertices.map((v) => v[1]))], [10, 110]);
  }
});

test("a draft render draws a tilted layer with the draft grid, as look frames do; a final keeps the full grid", async () => {
  // A steep card hanging off the right edge: a draft leaves out its off-screen triangles and, at
  // half size, allows the grid's error in output pixels (render.js triangleTiltTag).
  const scene = createScene({ id: "tilt", width: 640, height: 360, duration: 1, layers: [
    createLayer("rectangle", { id: "card", x: 400, y: 100, width: 400, height: 240, fill: "#5e6ad2", rotateX: 60, rotateY: -50 })] });
  const options = { format: "png", width: 320, height: 180, motionBlur: 0, dither: false };
  const draft = await exportScene(scene, { ...options, renderQuality: "draft" });
  const final = await exportScene(scene, { ...options, renderQuality: "final" });
  const [still] = await renderStills(scene, [0], { width: 320 });
  assert.ok(draft.buffer.equals(still.buffer), "a draft frame is the look frame");
  assert.ok(!final.buffer.equals(draft.buffer), "a final draws the full grid");
});
