import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareSvgAsset } from "./svg-asset.mjs";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";
import { readImage, skipWithoutMediaTools } from "./media.test.support.mjs";

test("SVG asset normalization retains vector dimensions and removes non-drawing attributes", () => {
  const prepared = prepareSvgAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="alert(1)"><rect width="40" height="20" fill="blue"/></svg>'));
  assert.deepEqual(prepared.measurements, { width: 40, height: 20, duration: 0 });
  assert.match(prepared.buffer.toString(), /<svg/);
  assert.doesNotMatch(prepared.buffer.toString(), /onload|alert/);
  for (const markup of ["<!DOCTYPE svg><svg/>", '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>', "not SVG"])
    assert.throws(() => prepareSvgAsset(Buffer.from(markup)), /SVG/);
  assert.throws(() => prepareSvgAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private/cache.png" width="10" height="10"/></svg>')), /Embed images/);
});

test("a bulk-created SVG image variant exports actual pixels in PNG and a real Lottie image", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-bulk-svg-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const asset = prepareSvgAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0000ff"/></svg>'));
  await writeFile(path.join(mediaRoot, "aaa.svg"), asset.buffer);
  const document = applyOperations(createDocument({ scenes: [createScene({ id: "base", width: 40, height: 20, layers: [createLayer("image", { id: "image", name: "Photo", x: 0, y: 0, width: 40, height: 20 })] })] }), [
    { type: "bulk_create", sceneId: "base", rows: [["id", "Photo"], ["svg", "/api/media/aaa.svg"]] },
  ]);
  const scene = expandComponents(document, document.scenes[1].id);
  const png = await exportScene(scene, { format: "png" }, { mediaRoot });
  const pixel = (await readImage(png.buffer)).pixel(20, 10);
  assert.ok(pixel[2] > 240 && pixel[0] < 10 && pixel[1] < 10);
  const lottie = await exportScene(scene, { format: "lottie", fps: 4 }, { mediaRoot });
  const image = JSON.parse(lottie.buffer.toString()).assets.find((entry) => entry.p?.startsWith("data:image/png;base64,"));
  assert.ok(image);
  const embedded = await readImage(Buffer.from(image.p.split(",")[1], "base64"));
  const color = embedded.pixel(Math.floor(embedded.width / 2), Math.floor(embedded.height / 2));
  assert.ok(color[2] > 240 && color[0] < 10 && color[1] < 10);
});
