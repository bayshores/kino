import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBulkCreateMediaSources } from "./bulk-create-media.mjs";
import { applyOperations } from "../engine/operations.js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { documentMediaIds } from "./media-use.mjs";

test("bulk CSV operations recover only permitted upload measurements for saved image sources", async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-bulk-media-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const src = "/api/media/aaa.gif";
  await writeFile(path.join(mediaRoot, "aaa.gif.json"), JSON.stringify({ src, mime: "image/gif", duration: 3, frameCount: 4, animated: true }));
  const operations = [{ type: "bulk_create", sceneId: "base", csv: `id,Photo\r\none,${src}\r\n` }];
  const mediaBySrc = await loadBulkCreateMediaSources(operations, { mediaRoot });
  assert.equal(mediaBySrc.get(src).duration, 3);
  const document = createDocument({ scenes: [createScene({ id: "base", layers: [createLayer("image", { id: "photo", name: "Photo", src: "/api/media/bbb.gif", mediaSourceDuration: 1 })] })] });
  const next = applyOperations(document, operations, { mediaBySrc });
  assert.deepEqual(next.scenes[1].layers[0].componentOverrides.photo, { src, mediaSourceDuration: 3 });
  assert.ok(documentMediaIds(next).has("aaa.gif"));
  assert.equal((await loadBulkCreateMediaSources(operations, { mediaRoot, allowedIds: new Set() })).size, 0);
  assert.equal((await loadBulkCreateMediaSources([{ ...operations[0], csv: "id,Photo\r\none,/api/media/ccc.gif\r\n" }], { mediaRoot })).size, 0);
});

test("scene CSV filenames resolve permitted saved images without reading named local paths", async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-scene-csv-media-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const metadata = { src: "/api/media/aaa.png", name: "photo, été", mime: "image/png", width: 32, height: 16 };
  await writeFile(path.join(mediaRoot, "aaa.png.json"), JSON.stringify(metadata));
  await writeFile(path.join(mediaRoot, "bbb.png.json"), JSON.stringify({ ...metadata, src: "/api/media/bbb.png", name: "private.png" }));
  const operations = [{ type: "bulk_create", sceneId: "base", rows: [["id", "Photo"], ["copy", "photo, été"]] }];
  const document = createDocument({ scenes: [createScene({ id: "base", layers: [createLayer("image", { id: "photo", name: "Photo", src: metadata.src })] })] });
  const mediaBySrc = await loadBulkCreateMediaSources(operations, { mediaRoot, allowedIds: new Set(["aaa.png"]), document });
  assert.deepEqual([...mediaBySrc.keys()], [metadata.src]);
  const next = applyOperations(document, operations, { mediaBySrc });
  assert.equal(next.scenes.length, 2);
  assert.deepEqual(next.scenes[1].layers[0].componentOverrides ?? {}, {});
  assert.equal((await loadBulkCreateMediaSources(operations, { mediaRoot, allowedIds: new Set() })).size, 0);
  const privateRequest = [{ ...operations[0], rows: [["id", "Photo"], ["copy", "private.png"]] }];
  assert.equal((await loadBulkCreateMediaSources(privateRequest, { mediaRoot, allowedIds: new Set(["aaa.png"]) })).size, 0);
});

test("one operation batch resolves image filenames for layers added or renamed before bulk_create", async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-bulk-media-batch-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const photo = { src: "/api/media/aaa.png", name: "photo.png", mime: "image/png", width: 32, height: 16 };
  const original = { src: "/api/media/bbb.png", name: "original.png", mime: "image/png", width: 32, height: 16 };
  await writeFile(path.join(mediaRoot, "aaa.png.json"), JSON.stringify(photo));
  await writeFile(path.join(mediaRoot, "bbb.png.json"), JSON.stringify(original));

  const addedDocument = createDocument({ scenes: [createScene({ id: "base" })] });
  const addBatch = [
    { type: "add_layer", sceneId: "base", layerType: "image", properties: { id: "photo", name: "Photo", src: original.src } },
    { type: "bulk_create", sceneId: "base", rows: [["id", "Photo"], ["copy", photo.name]] },
  ];
  const addMedia = await loadBulkCreateMediaSources(addBatch, {
    mediaRoot,
    allowedIds: new Set(["aaa.png", "bbb.png"]),
    document: addedDocument,
  });
  const added = applyOperations(addedDocument, addBatch, { mediaBySrc: addMedia });
  assert.equal(added.scenes.length, 2);
  assert.deepEqual(added.scenes[1].layers[0].componentOverrides.photo, { src: photo.src, mediaSourceDuration: 0 });

  const renamedDocument = createDocument({ scenes: [createScene({
    id: "base",
    layers: [createLayer("image", { id: "photo", name: "Old", src: original.src })],
  })] });
  const renameBatch = [
    { type: "update_layer", sceneId: "base", layerId: "photo", properties: { name: "Photo" } },
    { type: "bulk_create", sceneId: "base", rows: [["id", "Photo"], ["copy", photo.name]] },
  ];
  const renameMedia = await loadBulkCreateMediaSources(renameBatch, {
    mediaRoot,
    allowedIds: new Set(["aaa.png", "bbb.png"]),
    document: renamedDocument,
  });
  const renamed = applyOperations(renamedDocument, renameBatch, { mediaBySrc: renameMedia });
  assert.equal(renamed.scenes.length, 2);
  assert.deepEqual(renamed.scenes[1].layers[0].componentOverrides.photo, { src: photo.src, mediaSourceDuration: 0 });

  const deniedMedia = await loadBulkCreateMediaSources(addBatch, {
    mediaRoot,
    allowedIds: new Set(),
    document: addedDocument,
  });
  assert.equal(deniedMedia.size, 0);
  const denied = applyOperations(addedDocument, addBatch, { mediaBySrc: deniedMedia });
  assert.equal(denied.scenes.length, 1);
  assert.equal(denied.scenes[0].isComponent, false);
});
