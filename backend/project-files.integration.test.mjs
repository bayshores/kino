import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { createCanvas } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

async function responseJson(response, expected = 200) {
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}

function waitMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("No lifecycle message received.")), 10_000);
    function receive(bytes) {
      const message = JSON.parse(bytes.toString());
      if (predicate(message)) finish(null, message);
    }
    function finish(error, value) {
      clearTimeout(timeout);
      socket.off("message", receive);
      if (error) reject(error); else resolve(value);
    }
    socket.on("message", receive);
  });
}

test("file duplicate, Trash, permanent deletion, media/font retention and real exports work through HTTP", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  const folder = await responseJson(await api("/api/folders", { method: "POST", body: { name: "Campaign" } }), 201);
  const document = createDocument({ id: "file", name: "Campaign", scenes: [createScene({ id: "scene", width: 64, height: 64, layers: [] })] });
  let source = await responseJson(await api("/api/projects", { method: "POST", body: { document, folderId: folder.id } }), 201);
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ff0088";
  context.fillRect(0, 0, 2, 2);
  const png = canvas.toBuffer("image/png");
  const image = await responseJson(await api("/api/media?project=file", { method: "POST", headers: { "Content-Type": "image/png" }, body: png }), 201);
  const unused = await responseJson(await api("/api/media?project=file", { method: "POST", headers: { "Content-Type": "image/png" }, body: png }), 201);
  const library = await responseJson(await api("/api/media", { method: "POST", headers: { "Content-Type": "image/png" }, body: png }), 201);
  const font = await responseJson(await api("/api/media?project=file", { method: "POST", headers: { "Content-Type": "font/ttf", "X-File-Name": "Inter.ttf" }, body: await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url)) }), 201);
  document.scenes[0].layers.push(createLayer("image", { id: "photo", src: image.src, width: 32, height: 32 }),
    createLayer("text", { id: "text", text: "Copy", fontSource: font.src, fontFamily: "Inter", fontSize: 12, y: 40 }));
  source = await responseJson(await api("/api/projects/file", { method: "PUT", body: { document, revision: source.revision } }));
  await responseJson(await api("/api/projects/file/comments", { method: "POST", body: { text: "Source only" } }), 201);
  const oldLink = await responseJson(await api("/api/projects/file/shares", { method: "POST", body: { role: "view" } }), 201);
  const copy = await responseJson(await api("/api/projects/file/duplicate", { method: "POST", body: {} }), 201);
  assert.equal(copy.document.name, "Campaign [copy]");
  assert.equal(copy.folderId, folder.id);
  assert.equal(copy.revision, 1);
  assert.deepEqual(copy.comments, []);
  assert.deepEqual((await responseJson(await api(`/api/projects/${copy.document.id}/shares`))).shares, []);
  assert.equal((await responseJson(await api("/api/projects"))).projects[0].id, copy.document.id);
  const copyLink = await responseJson(await api(`/api/projects/${copy.document.id}/shares`, { method: "POST", body: { role: "view" } }), 201);
  const sharedCopy = { owner: false, share: copyLink.token };
  await responseJson(await api("/api/projects/file", { method: "DELETE" }));
  assert.equal((await responseJson(await api("/api/trash"))).projects[0].id, "file");
  const restoredSource = await responseJson(await api("/api/projects/file/restore", { method: "POST", body: {} }));
  assert.equal(restoredSource.folderId, folder.id, "restore keeps the original folder when it still exists");
  assert.equal(restoredSource.comments[0].text, "Source only");
  await responseJson(await api("/api/projects/file", { method: "DELETE" }));
  for (const confirm of [undefined, false, "true"]) {
    assert.equal((await api("/api/projects/file/permanent", { method: "DELETE", body: confirm === undefined ? {} : { confirm } })).status, 400);
    assert.ok((await responseJson(await api("/api/projects/file"))).trashedAt);
  }
  const deleted = await responseJson(await api("/api/projects/file/permanent", { method: "DELETE", body: { confirm: true } }));
  assert.deepEqual(deleted.cleanupErrors, []);
  assert.ok(deleted.deletedMediaIds.includes(unused.id), "unreferenced original upload is released");
  assert.equal((await api(unused.src)).status, 404);
  assert.equal((await api(library.src)).status, 200, "unrelated library uploads are preserved");
  assert.equal((await api(image.src, sharedCopy)).status, 200, "copy retains original image");
  assert.equal((await api(font.src, sharedCopy)).status, 200, "copy retains custom font");
  assert.equal((await api("/api/projects/file")).status, 404);
  assert.equal((await api("/api/projects/file", { owner: false, share: oldLink.token })).status, 403);
  const imageRecord = JSON.parse(await readFile(path.join(service.dataDirectory, "media", `${image.id}.json`), "utf8"));
  assert.equal(imageRecord.projectId, undefined);
  assert.ok(imageRecord.usedInProjects.includes(copy.document.id));
  const fonts = await responseJson(await api("/api/fonts", sharedCopy));
  assert.ok(fonts.fonts.some((entry) => entry.src === font.src));
  for (const format of ["png", "lottie"]) {
    const exported = await api("/api/export", { ...sharedCopy, method: "POST", body: { document: copy.document, sceneId: "scene", options: { format } } });
    assert.equal(exported.status, 200, await exported.clone().text());
    if (format === "lottie") assert.ok((await exported.json()).assets.some((asset) => asset.p?.startsWith("data:image/")));
    else assert.deepEqual(Buffer.from(await exported.arrayBuffer()).subarray(1, 4), Buffer.from("PNG"));
  }
  await api(`/api/projects/${copy.document.id}`, { method: "DELETE" });
  assert.equal((await api(image.src)).status, 200, "Trash retains media");
  await writeFile(path.join(service.dataDirectory, "media", `${image.id}.peaks`), "derived cache");
  const frameCache = path.join(service.dataDirectory, "media-frames", image.id);
  await mkdir(frameCache, { recursive: true });
  await writeFile(path.join(frameCache, "frame-0.png"), png);
  const lastDelete = await responseJson(await api(`/api/projects/${copy.document.id}/permanent`, { method: "DELETE", body: { confirm: true } }));
  assert.ok(lastDelete.deletedMediaIds.includes(image.id));
  assert.ok(lastDelete.deletedMediaIds.includes(font.id));
  assert.equal((await api(image.src)).status, 404);
  await assert.rejects(stat(path.join(service.dataDirectory, "media", `${image.id}.peaks`)), { code: "ENOENT" });
  await assert.rejects(stat(frameCache), { code: "ENOENT" });
  await responseJson(await api("/api/projects", { method: "POST", body: { document: createDocument({ id: "file" }) } }), 201);
  assert.equal((await api("/api/projects/file", { owner: false, share: oldLink.token })).status, 403, "old links stay revoked if ID is reused");
});

test("folders validate rename/delete, allow repeated names, preserve Trash and restore to Drafts", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  const folder = await responseJson(await api("/api/folders", { method: "POST", body: { name: "Campaign" } }), 201);
  await responseJson(await api("/api/folders", { method: "POST", body: { name: "Campaign" } }), 201);
  await responseJson(await api(`/api/folders/${folder.id}`, { method: "PATCH", body: { name: "Renamed" } }));
  for (const name of ["", 42, "Bad/name", "x".repeat(81)]) assert.equal((await api(`/api/folders/${folder.id}`, { method: "PATCH", body: { name } })).status, 400);
  assert.equal((await api("/api/folders/missing", { method: "DELETE" })).status, 404);
  const source = await responseJson(await api("/api/projects", { method: "POST", body: { document: createDocument({ id: "folder-file" }), folderId: folder.id } }), 201);
  const renamed = await responseJson(await api("/api/projects/folder-file", { method: "PATCH", body: { name: "New name" } }));
  assert.equal(renamed.document.name, "New name");
  assert.ok(renamed.revision > source.revision);
  assert.equal((await api("/api/projects/folder-file", { method: "PATCH", body: {} })).status, 400);
  await responseJson(await api(`/api/folders/${folder.id}`, { method: "DELETE" }));
  const trash = await responseJson(await api("/api/trash"));
  assert.equal(trash.projects[0].id, "folder-file");
  assert.equal(trash.projects[0].folderId, null);
  assert.equal((await api("/api/projects/folder-file", { method: "PUT", body: { document: source.document, revision: source.revision } })).status, 410);
  assert.equal((await api("/api/projects/folder-file/duplicate", { method: "POST", body: {} })).status, 410);
  assert.equal((await api("/api/media?project=folder-file", { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from("upload") })).status, 410);
  const restored = await responseJson(await api("/api/projects/folder-file/restore", { method: "POST", body: {} }));
  assert.equal(restored.folderId, null);
  const staleAfterRestore = await responseJson(await api("/api/projects/folder-file", {
    method: "PUT", body: { document: source.document, revision: source.revision },
  }));
  assert.equal(staleAfterRestore.merged, true, "a stale document save merges after restore");
  assert.equal(staleAfterRestore.document.name, "New name", "the merge preserves the latest file name");
  assert.equal(staleAfterRestore.folderId, null, "the merge leaves the restored file in Drafts");
  assert.equal(staleAfterRestore.trashedAt, undefined, "the merge does not put the restored file back in Trash");
  assert.equal((await api("/api/projects/folder-file/permanent", { method: "DELETE", body: { confirm: true } })).status, 400);
  assert.equal((await api("/api/projects/folder-file/restore/extra", { method: "POST", body: {} })).status, 404);
});

test("single-file capabilities never reach file management; owner tabs receive trash/delete lifecycle events", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  const document = createDocument({ id: "live-file" });
  await responseJson(await api("/api/projects", { method: "POST", body: { document } }), 201);
  const folder = await responseJson(await api("/api/folders", { method: "POST", body: { name: "Folder" } }), 201);
  for (const role of ["view", "comment", "edit"]) {
    const link = await responseJson(await api("/api/projects/live-file/shares", { method: "POST", body: { role } }), 201);
    const shared = { owner: false, share: link.token };
    const own = await responseJson(await api("/api/shared-project", shared));
    assert.equal(own.document.id, document.id);
    assert.equal(own.access.role, role);
    const session = await api("/api/session", { method: "POST", body: {} });
    const ownerCookie = session.headers.get("set-cookie").split(";")[0];
    for (const [endpoint, method, body] of [
      ["/api/projects", "GET"], ["/api/trash", "GET"], ["/api/folders", "GET"],
      ["/api/projects/live-file/duplicate", "POST", {}], ["/api/projects/live-file/restore", "POST", {}],
      ["/api/projects/live-file/permanent", "DELETE", { confirm: true }], ["/api/projects/live-file", "DELETE"],
      [`/api/folders/${folder.id}`, "PATCH", { name: "No" }], [`/api/folders/${folder.id}`, "DELETE"],
    ]) {
      assert.equal((await api(endpoint, { ...shared, method, body })).status, 403, `${role}: ${method} ${endpoint}`);
      assert.equal((await api(endpoint, { ...shared, headers: { Cookie: ownerCookie }, method, body })).status, 403,
        `${role} stays scoped with an owner cookie: ${method} ${endpoint}`);
    }
  }
  const socket = new WebSocket(service.baseUrl.replace("http:", "ws:") + "/collaboration", { headers: { "X-Kino-Owner": service.ownerToken } });
  t.after(() => socket.close());
  await once(socket, "open");
  const joined = waitMessage(socket, (message) => message.type === "comments");
  socket.send(JSON.stringify({ type: "join", projectId: document.id, clientId: "open-tab" }));
  await joined;
  const trashed = waitMessage(socket, (message) => message.type === "project-lifecycle" && message.state === "trashed");
  await api("/api/projects/live-file", { method: "DELETE" });
  assert.equal((await trashed).projectId, document.id);
  const deleted = waitMessage(socket, (message) => message.type === "project-lifecycle" && message.state === "deleted");
  await api("/api/projects/live-file/permanent", { method: "DELETE", body: { confirm: true } });
  assert.equal((await deleted).projectId, document.id);
  assert.equal((await api("/api/projects/live-file", { method: "PUT", body: { document, revision: 1 } })).status, 404);
});
