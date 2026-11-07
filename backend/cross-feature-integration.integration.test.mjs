import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { selectionFromLink } from "../frontend/sceneLinks.js";
import { mediaIdFromSource } from "../engine/replaceMedia.js";
import { startTestServer, makeAnimatedGif } from "./media.test.support.mjs";
import { shareUrl } from "../engine/shareUrls.js";

// A link to a scene or layer, as the share menu builds it (shareUrls.js); null without a scene.
const selectionLink = (href, projectId, { sceneId, layerId, componentPath } = {}, options = {}) =>
  (sceneId ? shareUrl(href, projectId, { sceneId, layerId, componentPath }, options) : null);

// The original file's metadata or download route for a stored source, keeping its share token.
function mediaRecordPath(src, action) {
  const query = new URLSearchParams(src.split("?")[1]);
  query.delete("decoder");
  return `/api/media/${mediaIdFromSource(src)}/${action}${query.size ? `?${query}` : ""}`;
}

async function json(response, status = 200) {
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

test("imported share/frame sources download original bytes and replace through the operations route", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  let record = await json(await api("/api/projects", { method: "POST", body: { document: createDocument({ id: "imported-media", scenes: [createScene({ id: "scene", width: 8, height: 4 })] }) } }), 201);
  const gifBytes = makeAnimatedGif({ width: 8, height: 4, frames: [{ delayCs: 10, color: [255, 0, 0] }, { delayCs: 20, color: [0, 255, 0] }] });
  const original = await json(await api("/api/media?project=imported-media", { method: "POST", headers: { "Content-Type": "image/gif", "X-File-Name": encodeURIComponent("été original.gif") }, body: gifBytes }), 201);
  const share = await json(await api("/api/projects/imported-media/shares", { method: "POST", body: { role: "view" } }), 201);
  const canvas = createCanvas(8, 4);
  canvas.getContext("2d").fillRect(0, 0, 8, 4);
  const replacement = await json(await api("/api/media?project=imported-media", { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "replacement.png" }, body: canvas.toBuffer("image/png") }), 201);

  for (const suffix of [`?share=${share.token}`, "/frames/0.png?decoder=1", `/frames/1.png?decoder=1&share=${share.token}`]) {
    const document = structuredClone(record.document);
    document.scenes[0].layers = [createLayer("image", { id: "photo", name: original.name, src: `${original.src}${suffix}`, width: 8, height: 4, x: 0, y: 0 })];
    record = await json(await api("/api/projects/imported-media", { method: "PUT", body: { document, revision: record.revision } }));
    const source = record.document.scenes[0].layers[0].src;
    const access = { owner: false, ...(suffix.includes("share=") ? {} : { share: share.token }) };
    const metadata = await json(await api(mediaRecordPath(source, "metadata"), access));
    assert.equal(metadata.id, original.id);
    assert.equal(metadata.name, original.name);
    const downloaded = await api(mediaRecordPath(source, "download"), access);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), gifBytes, "a decoded PNG source downloads its original GIF");
    const changed = await json(await api("/api/projects/imported-media/operations", { method: "POST", body: {
      revision: record.revision, operations: [{ type: "replace_media", sceneId: "scene", layerId: "photo", mediaId: replacement.id }],
    } }));
    assert.equal(changed.document.scenes[0].layers[0].name, replacement.name, "the old source's name is found through its share or frame suffix");
    record = await json(await api("/api/projects/imported-media"));
    assert.equal(record.document.scenes[0].layers[0].src, replacement.src);
    for (const format of ["png", "lottie"]) {
      const output = await api("/api/export", { method: "POST", body: { document: record.document, sceneId: "scene", options: { format } } });
      const bytes = Buffer.from(await output.arrayBuffer());
      assert.equal(output.status, 200, bytes.toString("utf8", 0, 160));
      if (format === "png") assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      else assert.ok(JSON.parse(bytes.toString()).assets.some((asset) => asset.p?.startsWith("data:image/png;base64,")));
    }
  }
});

test("copied scene/layer links cannot transfer workspace authority and keep file-scoped sharing", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const document = createDocument({ id: "linked-file", scenes: [createScene({ id: "scene", layers: [createLayer("rectangle", { id: "box" })] })] });
  await json(await service.api("/api/projects", { method: "POST", body: { document } }), 201);
  await json(await service.api("/api/projects", { method: "POST", body: { document: createDocument({ id: "unrelated-file" }) } }), 201);
  const shared = await json(await service.api(`/api/projects/${document.id}/shares`, { method: "POST", body: { role: "view" } }), 201);
  for (const selection of [{ sceneId: "scene" }, { sceneId: "scene", layerId: "box" }]) {
    const ownerLink = new URL(selectionLink(`${service.baseUrl}/?project=${document.id}#owner=${service.ownerToken}`, document.id, selection));
    assert.equal(ownerLink.hash, "");
    assert.equal((await service.api(`/api/projects/${document.id}`, { owner: false })).status, 403, "a fresh recipient needs their own authorization");
    const link = new URL(selectionLink(`${service.baseUrl}/?project=${document.id}#owner=${service.ownerToken}&share=${shared.token}`, document.id, selection));
    const share = new URLSearchParams(link.hash.slice(1)).get("share");
    assert.equal(share, shared.token);
    assert.equal(link.href.includes(service.ownerToken), false);
    const opened = await json(await service.api(`/api/projects/${document.id}`, { owner: false, share }));
    assert.equal(opened.access.canEdit, false);
    assert.deepEqual(selectionFromLink(opened.document, link.href), { sceneId: "scene", layerIds: selection.layerId ? ["box"] : [] });
    assert.equal((await service.api("/api/projects", { owner: false, share })).status, 403);
    assert.equal((await service.api("/api/projects/unrelated-file", { owner: false, share })).status, 403);
    assert.equal((await service.api("/api/projects/unrelated-file/permanent", { owner: false, share, method: "DELETE", body: { confirm: true } })).status, 403);
  }
});
