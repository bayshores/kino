import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { makeAnimatedGif, readImage, startTestServer } from "./media.test.support.mjs";
import { createComponentInstance } from "../engine/linkedComponents.js";
import { openStore } from "./store.mjs";

async function json(response, expected = 200) {
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

function document(id, layers = []) {
  return createDocument({ id, name: id, scenes: [createScene({ id: "scene", width: 160, height: 48, layers })] });
}

async function deleteForever(api, id) {
  await json(await api(`/api/projects/${id}`, { method: "DELETE" }));
  return json(await api(`/api/projects/${id}/permanent`, { method: "DELETE", body: { confirm: true } }));
}

async function exportPng(api, project, access = {}) {
  const response = await api("/api/export", { ...access, method: "POST",
    body: { document: project.document, sceneId: "scene", options: { format: "png" } } });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  return Buffer.from(await response.arrayBuffer());
}

test("a family-only uploaded font survives deleting its original file and still renders/exports in its duplicate", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  const original = await json(await api("/api/projects", { method: "POST", body: { document: document("font-owner") } }), 201);
  const font = await json(await api("/api/media?project=font-owner", { method: "POST",
    headers: { "Content-Type": "font/ttf", "X-File-Name": "ReviewFace.ttf" },
    body: await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url)) }), 201);
  const edited = await json(await api("/api/projects/font-owner/operations", { method: "POST", body: {
    revision: original.revision,
    operations: [{ type: "add_layer", sceneId: "scene", layerType: "text",
      properties: { id: "text", x: 4, y: 4, width: 140, height: 32, fontFamily: "ReviewFace", fontWeight: 400, text: "Still needed", fontSize: 18 } }],
  } }));
  assert.equal(edited.document.scenes[0].layers[0].fontSource, "", "family-only references are valid MCP operation results");
  const copy = await json(await api("/api/projects/font-owner/duplicate", { method: "POST", body: {} }), 201);
  const metadata = JSON.parse(await readFile(path.join(service.dataDirectory, "media", `${font.id}.json`), "utf8"));
  assert.ok(metadata.usedInProjects.includes(copy.document.id), "duplicate records resolved font use before deletion");
  const before = await exportPng(api, copy);
  const picture = await readImage(before);
  assert.ok(Array.from({ length: 120 * 25 }, (_, index) => picture.pixel(4 + index % 120, 4 + Math.floor(index / 120)))
    .some(([r, g, b]) => r < 100 && g < 100 && b < 100), "the baseline actually draws text glyphs");
  const deleted = await deleteForever(api, "font-owner");
  assert.ok(!deleted.deletedMediaIds.includes(font.id), "the duplicate still needs the font bytes");
  assert.equal((await api(font.src)).status, 200);
  const reopened = await json(await api(`/api/projects/${copy.document.id}`));
  const link = await json(await api(`/api/projects/${copy.document.id}/shares`, { method: "POST", body: { role: "view" } }), 201);
  const shared = { owner: false, share: link.token };
  const catalog = await json(await api("/api/fonts", shared));
  assert.ok(catalog.fonts.some((face) => face.src === font.src), "retention also preserves the copy's scoped font access");
  assert.deepEqual(await exportPng(api, reopened, shared), before, "reopened copy renders exactly the same pixels");
  const lottie = await api("/api/export", { ...shared, method: "POST", body: {
    document: reopened.document, sceneId: "scene", options: { format: "lottie" },
  } });
  const animation = await json(lottie);
  assert.ok(animation.layers.length > 0);
  assert.ok((await deleteForever(api, copy.document.id)).deletedMediaIds.includes(font.id), "the final reference can still release the font");
  assert.equal((await api(font.src)).status, 404);
});

test("legacy family-only component overrides in active files and Trash retain fonts without historical upload permissions", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  await json(await api("/api/projects", { method: "POST", body: { document: document("legacy-font-owner") } }), 201);
  const font = await json(await api("/api/media?project=legacy-font-owner", { method: "POST",
    headers: { "Content-Type": "font/ttf", "X-File-Name": "OverrideFace.ttf" },
    body: await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url)) }), 201);
  const master = createScene({ id: "master", isComponent: true, width: 160, height: 48,
    layers: [createLayer("text", { id: "title", x: 4, y: 4, width: 140, height: 32, text: "Inherited", fontFamily: "Inter", fontSize: 18 })] });
  const legacy = createDocument({ id: "legacy-file", name: "Legacy", scenes: [master,
    createScene({ id: "scene", width: 160, height: 48, layers: [createComponentInstance(master, {
      id: "instance", x: 0, y: 0, componentOverrides: { title: { fontFamily: "OverrideFace" } },
    })] }),
  ] });
  // Older stores contain valid documents whose resolved font use was never
  // recorded in upload metadata. Use real persistence to exercise that state.
  const store = await openStore(service.dataDirectory);
  const original = await store.createProject(legacy);
  const copy = await store.duplicateProject(legacy.id);
  await store.trashProject(copy.document.id);
  const before = await exportPng(api, original);
  assert.deepEqual((await deleteForever(api, "legacy-font-owner")).deletedMediaIds, []);
  const record = JSON.parse(await readFile(path.join(service.dataDirectory, "media", `${font.id}.json`), "utf8"));
  assert.ok(record.usedInProjects.includes(legacy.id));
  assert.ok(record.usedInProjects.includes(copy.document.id), "Trash is scanned as well as active files");
  await deleteForever(api, legacy.id);
  assert.equal((await api(font.src)).status, 200, "the sole legacy copy in Trash still retains its overridden font");
  const restored = await json(await api(`/api/projects/${copy.document.id}/restore`, { method: "POST", body: {} }));
  const link = await json(await api(`/api/projects/${copy.document.id}/shares`, { method: "POST", body: { role: "view" } }), 201);
  assert.deepEqual(await exportPng(api, restored, { owner: false, share: link.token }), before);
  assert.ok((await deleteForever(api, copy.document.id)).deletedMediaIds.includes(font.id));
});

test("decoded-frame files and their duplicates retain the GIF and frame cache, including either file in Trash", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api, dataDirectory } = service;
  for (const trashed of ["file", "copy"]) {
    const ownerId = `gif-owner-${trashed}`, fileId = `frame-file-${trashed}`;
    await json(await api("/api/projects", { method: "POST", body: { document: document(ownerId) } }), 201);
    const gif = await json(await api(`/api/media?project=${ownerId}`, { method: "POST",
      headers: { "Content-Type": "image/gif", "X-File-Name": "frames.gif" },
      body: makeAnimatedGif({ width: 4, height: 4, frames: [{ color: [255, 0, 0], delayCs: 10 }, { color: [0, 0, 255], delayCs: 10 }] }),
    }), 201);
    const src = `${gif.src}/frames/0.png?decoder=1`;
    const frame = await api(src);
    assert.equal(frame.status, 200, "the source is an actual working decoded frame");
    const png = Buffer.from(await frame.arrayBuffer());
    assert.deepEqual((await readImage(png)).pixel(1, 1), [255, 0, 0, 255]);
    await json(await api("/api/projects", { method: "POST", body: {
      document: document(fileId, [createLayer("image", { id: "frame", src, x: 0, y: 0, width: 4, height: 4 })]),
    } }), 201);
    const copy = await json(await api(`/api/projects/${fileId}/duplicate`, { method: "POST", body: {} }), 201);
    const before = await exportPng(api, copy);
    assert.deepEqual((await readImage(before)).pixel(1, 1), [255, 0, 0, 255], "PNG export draws the selected decoded frame");
    const trashId = trashed === "file" ? fileId : copy.document.id;
    await json(await api(`/api/projects/${trashId}`, { method: "DELETE" }));
    const deleted = await deleteForever(api, ownerId);
    assert.ok(!deleted.deletedMediaIds.includes(gif.id), `${trashed} in Trash still retains the original GIF`);
    assert.equal((await api(gif.src)).status, 200);
    assert.ok((await stat(path.join(dataDirectory, "media-frames", gif.id))).isDirectory(), "existing decoded frames are retained");
    assert.deepEqual(Buffer.from(await (await api(src)).arrayBuffer()), png);
    const activeId = trashed === "file" ? copy.document.id : fileId;
    const link = await json(await api(`/api/projects/${activeId}/shares`, { method: "POST", body: { role: "view" } }), 201);
    const shared = { owner: false, share: link.token };
    assert.equal((await api(src, shared)).status, 200, "a surviving file's capability can still read its frame");
    const reopened = await json(await api(`/api/projects/${activeId}`));
    assert.deepEqual(await exportPng(api, reopened, shared), before);
    const lottie = await json(await api("/api/export", { ...shared, method: "POST", body: {
      document: reopened.document, sceneId: "scene", options: { format: "lottie" },
    } }));
    assert.ok(lottie.assets.some((asset) => asset.p?.startsWith("data:image/png;base64,")), "Lottie embeds the retained frame");
    await deleteForever(api, activeId);
    assert.equal((await api(src)).status, 200, "the sole remaining file in Trash retains the GIF");
    const final = await json(await api(`/api/projects/${trashId}/permanent`, { method: "DELETE", body: { confirm: true } }));
    assert.ok(final.deletedMediaIds.includes(gif.id));
    assert.equal((await api(src)).status, 404);
    await assert.rejects(stat(path.join(dataDirectory, "media-frames", gif.id)), { code: "ENOENT" });
  }
});
