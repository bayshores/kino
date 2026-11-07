import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { sceneCsvRows } from "../engine/sceneCsv.js";
import { parseCsv, writeCsv } from "../engine/csv.js";
import { applyOperations } from "../engine/operations.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportScene, getOutputSize } from "./export.mjs";
import { makeAnimatedGif, readImage } from "./media.test.support.mjs";

// A whole scene as a native-size still PNG at `time`, as the /api/export route takes it.
const scenePngRequest = (document, sceneId, time) => ({ document, sceneId, options: { format: "png", size: "native", time } });

test("a native scene PNG renders the whole scene and its background at native size at the requested playhead", async () => {
  const scene = createScene({ id: "scene", width: 48, height: 24, duration: 2, background: "#112233", layers: [
    createLayer("rectangle", { id: "bar", x: 24, y: 2, width: 8, height: 8, fill: "#ff0000", animations: [
      { id: "move", name: "Move", kind: "custom", start: 0, duration: 2, easing: "linear", from: { x: 0 }, to: { x: 32 } },
    ] }),
  ] });
  const document = parseDocument(createDocument({ scenes: [scene] }));
  const request = scenePngRequest(document, scene.id, 1);
  const rendered = expandComponents(request.document, request.sceneId);
  const output = await exportScene(rendered, request.options);
  const image = await readImage(output.buffer);
  assert.equal(image.width, 48);
  assert.equal(image.height, 24);
  assert.deepEqual(image.pixel(46, 22), [17, 34, 51, 255], "whole background remains in the image");
  assert.deepEqual(image.pixel(18, 4), [255, 0, 0, 255], "the animated bar is at the one-second playhead");
  assert.deepEqual(image.pixel(2, 4), [17, 34, 51, 255], "not frame zero");
  assert.deepEqual(output.buffer, (await exportScene(rendered, { format: "png", width: 48, height: 24, time: 1 })).buffer,
    "the native PNG and a sized still produce the same image");
});

test("scene PNG requests render a 3000 by 3000 scene beyond the preset export footprint", async () => {
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "large", width: 3000, height: 3000,
    background: "#123456", layers: [] })] }));
  const request = scenePngRequest(document, "large", 0.5);
  const output = await exportScene(expandComponents(request.document, request.sceneId), request.options);
  const image = await readImage(output.buffer);
  assert.deepEqual([image.width, image.height], [3000, 3000]);
  assert.deepEqual(image.pixel(2999, 2999), [18, 52, 86, 255]);
});

test("native PNG size is bounded and cannot bypass animated export preset limits", () => {
  const scene = { width: 3000, height: 3000 };
  assert.deepEqual(getOutputSize(scene, { format: "png", size: "native" }), scene);
  assert.throws(() => getOutputSize(scene, { format: "png", size: "1x" }), /supported canvas limits/);
  for (const format of ["mp4", "gif", "apng", "png-sequence", "lottie"])
    assert.throws(() => getOutputSize(scene, { format, size: "native" }), /only to still PNG/);
  assert.throws(() => getOutputSize({ width: 6000, height: 6000 }, { format: "png", size: "native" }), /33,554,432/);
});

test("a native scene PNG waits for animated media frames and preserves an off background's transparency", async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-scene-copy-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  await writeFile(path.join(mediaRoot, "colors.gif"), makeAnimatedGif({ width: 8, height: 8,
    frames: [{ delayCs: 10, color: [255, 0, 0] }, { delayCs: 10, color: [0, 255, 0] }] }));
  const scene = createScene({ id: "scene", width: 16, height: 16, backgroundEnabled: false, layers: [
    createLayer("image", { id: "gif", src: "/api/media/colors.gif", x: 0, y: 0, width: 8, height: 8, mediaDuration: 2 }),
  ] });
  const document = parseDocument(createDocument({ scenes: [scene] }));
  const request = scenePngRequest(document, scene.id, 0.15);
  const output = await exportScene(expandComponents(request.document, request.sceneId), request.options, { mediaRoot });
  const image = await readImage(output.buffer);
  assert.deepEqual(image.pixel(4, 4), [0, 255, 0, 255], "the decoded second GIF frame is ready before the PNG is returned");
  assert.equal(image.pixel(14, 14)[3], 0, "Fill off remains transparent");
});

test("untouched scene CSV preserves animated PNG content, with at most one channel value of linked text roundoff", async () => {
  const scene = createScene({ id: "scene", width: 96, height: 64, duration: 2, background: "#112233", layers: [
    createLayer("text", { id: "title", name: "Title, quoted", text: 'Bonjour,\n"été"', fontSize: 12, x: 4, y: 20, width: 90, height: 25 }),
    createLayer("rectangle", { id: "bar", x: 20, y: 2, width: 8, height: 8, fill: "#ff0000", animations: [
      { id: "move", name: "Move", kind: "custom", start: 0, duration: 2, easing: "linear", from: { x: 0 }, to: { x: 40 } },
    ] }),
  ] });
  const document = parseDocument(createDocument({ scenes: [scene] }));
  const csv = writeCsv(sceneCsvRows(document, scene.id));
  assert.equal(parseCsv(csv).rows.length, 1);
  const imported = parseDocument(applyOperations(document, [{ type: "bulk_create", sceneId: scene.id, csv }]));
  const variant = imported.scenes.find((item) => item.bulkVariant);
  assert.deepEqual(variant.layers[0].componentOverrides ?? {}, {});
  const png = async (doc, sceneId) => {
    const request = scenePngRequest(doc, sceneId, 1.25);
    return readImage((await exportScene(expandComponents(doc, sceneId), request.options)).buffer);
  };
  const before = await png(document, scene.id), after = await png(imported, variant.id);
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    const original = before.pixel(x, y), actual = after.pixel(x, y);
    assert.ok(original.every((value, index) => Math.abs(value - actual[index]) <= 1), `pixel ${x},${y} changed beyond text-compositing roundoff`);
  }
});
