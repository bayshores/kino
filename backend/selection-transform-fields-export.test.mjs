import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { selectionTransformFromFields } from "../engine/selectionTransformFields.js";
import { selectionBox, transformTargets } from "../engine/multiTransform.js";
import { point, worldMatrix } from "../engine/geometry.js";
import { renderSceneSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";
import { near, readImage } from "./media.test.support.mjs";

test("numeric shared scale and rotation survive MCP edits, saved documents, SVG, real PNG and native Lottie", async () => {
  const ids = ["red", "blue"];
  let document = parseDocument(createDocument({ scenes: [createScene({ id: "page", width: 400, height: 300, duration: 1, layers: [
    createLayer("rectangle", { id: "red", name: "Red", x: 80, y: 100, width: 40, height: 30, fill: "#ff0000", radius: 0, strokeWidth: 0 }),
    createLayer("rectangle", { id: "blue", name: "Blue", x: 240, y: 100, width: 40, height: 30, fill: "#0000ff", radius: 0, strokeWidth: 0 }),
  ] })] }));
  for (const action of [{ kind: "scale", scaleX: 120, scaleY: 80 }, { kind: "rotate", degrees: 90 }]) {
    const scene = document.scenes[0], box = selectionBox(transformTargets(scene.layers, ids), scene.layers);
    const result = selectionTransformFromFields(scene.layers, ids, box, action);
    const mcp = applyOperations(document, result.changes.map(({ id, ...properties }) => ({ type: "update_layer", sceneId: "page", layerId: id, properties })));
    document = parseDocument(JSON.parse(JSON.stringify(mcp)));
  }
  const rendered = expandComponents(document, "page");
  assert.match(renderSceneSvg(rendered, 0), /data-layer-id="red"/);
  const png = await readImage((await exportScene(rendered, { format: "png" })).buffer);
  const lottie = JSON.parse((await exportScene(rendered, { format: "lottie", fps: 4 })).buffer.toString());
  const exported = [...lottie.layers, ...lottie.assets.flatMap((asset) => asset.layers ?? [])];
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} should equal ${b}`);
  for (const [id, name, color] of [["red", "Red", [255, 0, 0, 255]], ["blue", "Blue", [0, 0, 255, 255]]]) {
    const layer = document.scenes[0].layers.find((item) => item.id === id);
    const matrix = worldMatrix(layer, document.scenes[0].layers);
    const center = point(matrix, layer.width / 2, layer.height / 2);
    assert.ok(near(png.pixel(Math.round(center.x), Math.round(center.y)), color));
    const native = exported.find((item) => item.nm === name);
    assert.ok(native?.shapes, `${name} remains native vector geometry`);
    const anchor = native.ks.a.k, position = point(matrix, anchor[0], anchor[1]);
    close(native.ks.p.k[0], position.x); close(native.ks.p.k[1], position.y);
    close(native.ks.r.k, layer.rotation);
    close(native.ks.s.k[0], layer.scaleX * 100); close(native.ks.s.k[1], layer.scaleY * 100);
  }
});
