import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { openStore } from "./store.mjs";

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-files-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { store: await openStore(directory), directory };
}

test("duplicate persists an independent document in the same folder without comments or history", async (t) => {
  const { store, directory } = await setup(t);
  const folder = await store.createFolder("Campaign");
  const document = createDocument({ id: "source", name: "Campaign", scenes: [createScene({ id: "scene", layers: [createLayer("rectangle", { id: "shape" })] })] });
  await store.createProject(document, folder.id);
  await store.addComment(document.id, { text: "Only on source" });
  const before = Date.now();
  const copied = await store.duplicateProject(document.id);
  assert.notEqual(copied.document.id, document.id);
  assert.equal(copied.document.name, "Campaign [copy]");
  assert.equal(copied.folderId, folder.id);
  assert.equal(copied.revision, 1);
  assert.ok(Date.parse(copied.updatedAt) >= before);
  assert.deepEqual(copied.comments, []);
  assert.equal((await store.listProjects())[0].id, copied.document.id);
  copied.document.scenes[0].layers[0].name = "Copy only";
  await store.updateProject(copied.document.id, copied.document, 1);
  assert.equal((await store.getProject(document.id)).document.scenes[0].layers[0].name, document.scenes[0].layers[0].name);
  const reopened = await openStore(directory);
  assert.equal((await reopened.getProject(copied.document.id)).document.scenes[0].layers[0].name, "Copy only");
  await store.trashProject(document.id);
  await assert.rejects(store.duplicateProject(document.id), { code: "ERR_PROJECT_TRASHED" });
});

test("folder names may repeat across creation, rename and reopening", async (t) => {
  const { store, directory } = await setup(t);
  const first = await store.createFolder("Campaign");
  const second = await store.createFolder("Campaign");
  assert.notEqual(first.id, second.id);
  const third = await store.createFolder("Other");
  await store.renameFolder(third.id, " Campaign ");
  assert.deepEqual((await (await openStore(directory)).listFolders()).map((folder) => folder.name), ["Campaign", "Campaign", "Campaign"]);
  await assert.rejects(store.renameFolder(first.id, " "), { code: "ERR_INVALID_NAME" });
  assert.equal((await store.listFolders())[0].name, "Campaign");
});

test("deleting a folder trashes active contents and preserves existing Trash dates; restore uses Drafts", async (t) => {
  const { store, directory } = await setup(t);
  const folder = await store.createFolder("Campaign");
  for (const id of ["active", "already-trashed"]) await store.createProject(createDocument({ id }), folder.id);
  await store.createProject(createDocument({ id: "outside" }));
  const old = await store.trashProject("already-trashed");
  const before = await store.getProject("active");
  const result = await store.deleteFolder(folder.id);
  assert.deepEqual(result.trashedProjectIds, ["active"]);
  assert.deepEqual((await store.listProjects()).map((file) => file.id), ["outside"]);
  const active = await store.getProject("active");
  assert.ok(active.trashedAt);
  assert.ok(active.revision > before.revision);
  assert.equal((await store.getProject("already-trashed")).trashedAt, old.trashedAt);
  assert.equal((await (await openStore(directory)).restoreProject("active")).folderId, null);
  await store.restoreProject("already-trashed");
  assert.equal((await store.getProject("already-trashed")).folderId, null);
});

test("Trash is newest first; stale writes fail across trash/restore; permanent delete only accepts Trash", async (t) => {
  const { store, directory } = await setup(t);
  const original = await store.createProject(createDocument({ id: "file" }));
  await assert.rejects(store.deleteProjectForever("file"), { code: "ERR_PROJECT_NOT_TRASHED" });
  await store.trashProject("file");
  await assert.rejects(store.updateProject("file", original.document, original.revision), { code: "ERR_PROJECT_TRASHED" });
  const restored = await store.restoreProject("file");
  assert.ok(restored.revision > original.revision);
  await assert.rejects(store.updateProject("file", original.document, original.revision), { code: "ERR_REVISION_CONFLICT" });
  await store.trashProject("file");
  assert.equal((await store.listTrashedProjects())[0].id, "file");
  await store.deleteProjectForever("file");
  assert.equal(await (await openStore(directory)).getProject("file"), null);
  assert.deepEqual(await store.listTrashedProjects(), []);
  await assert.rejects(store.restoreProject("file"), { code: "ERR_PROJECT_NOT_FOUND" });
});
