import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConflictError, openStore } from "./store.mjs";

function makeDocument(id, name = `Project ${id}`) {
  return {
    version: 1,
    id,
    name,
    scenes: [
      {
        id: `scene_${id}`,
        name: "Scene 1",
        width: 640,
        height: 360,
        duration: 4,
        background: "#111111",
        layers: [],
      },
    ],
  };
}

async function makeDataRoot(t) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "kino-store-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return path.join(temporaryRoot, "data");
}

test("starts empty and persists projects with restrictive file permissions", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);

  assert.deepEqual(await store.listProjects(), []);
  assert.deepEqual(await store.listFolders(), []);
  const created = await store.createProject(makeDocument("motion_1"));
  assert.equal(created.revision, 1);
  assert.equal(created.folderId, null);

  const reopened = await openStore(root);
  assert.deepEqual(await reopened.getProject("motion_1"), created);
  assert.deepEqual(await reopened.listProjects(), [
    {
      id: "motion_1",
      name: "Project motion_1",
      folderId: null,
      updatedAt: created.updatedAt,
      sceneCount: 1,
      revision: 1,
    },
  ]);

  const directoryMode = (await stat(root)).mode & 0o777;
  const fileMode = (await stat(path.join(root, "store.json"))).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(fileMode, 0o600);
  assert.match(
    await readFile(path.join(root, "store.json"), "utf8"),
    /"version":1/,
  );
});

test("queues mutations across store handles and applies sequential revisions atomically", async (t) => {
  const root = await makeDataRoot(t);
  const firstStore = await openStore(root);
  const secondStore = await openStore(root);

  await Promise.all([
    firstStore.createProject(makeDocument("one")),
    secondStore.createProject(makeDocument("two")),
    firstStore.createProject(makeDocument("three")),
  ]);
  assert.deepEqual(
    (await secondStore.listProjects()).map(({ id }) => id),
    ["one", "two", "three"],
  );

  const initial = await firstStore.getProject("one");
  const updated = await firstStore.updateProject(
    "one",
    makeDocument("one", "Updated once"),
    initial.revision,
  );
  const updatedAgain = await secondStore.updateProject(
    "one",
    makeDocument("one", "Updated twice"),
    updated.revision,
  );
  assert.equal(updated.revision, 2);
  assert.equal(updatedAgain.revision, 3);
  assert.equal(
    (await firstStore.getProject("one")).document.name,
    "Updated twice",
  );
});

test("revision conflicts include the current persisted project entry", async (t) => {
  const store = await openStore(await makeDataRoot(t));
  await store.createProject(makeDocument("conflict"));
  const current = await store.updateProject(
    "conflict",
    makeDocument("conflict", "Newer"),
    1,
  );

  await assert.rejects(
    store.updateProject("conflict", makeDocument("conflict", "Stale"), 1),
    (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "ERR_REVISION_CONFLICT");
      assert.deepEqual(error.current, current);
      assert.deepEqual(error.currentEntry, current);
      return true;
    },
  );
});

test("folders can be renamed and deleted while contained projects move to Trash", async (t) => {
  const store = await openStore(await makeDataRoot(t));
  const folder = await store.createFolder("Drafts");
  assert.deepEqual(await store.renameFolder(folder.id, "Finals"), {
    id: folder.id,
    name: "Finals",
  });
  const created = await store.createProject(
    makeDocument("foldered"),
    folder.id,
  );
  assert.equal(created.folderId, folder.id);

  const otherFolder = await store.createFolder("Archive");
  const moved = await store.moveProject("foldered", otherFolder.id);
  assert.equal(moved.folderId, otherFolder.id);
  await store.deleteFolder(otherFolder.id);
  assert.equal((await store.getProject("foldered")).folderId, null);
  assert.ok((await store.getProject("foldered")).trashedAt);
  assert.deepEqual(await store.listFolders(), [
    { id: folder.id, name: "Finals" },
  ]);
});

test("trash is recoverable and comments persist with resolution state", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);
  await store.createProject(makeDocument("review"));
  const comment = await store.addComment("review", {
    text: "Check this transition.",
    author: "Reviewer",
    x: 120,
    y: 80,
    sceneId: "scene_review",
  });
  assert.equal(comment.resolved, false);
  assert.equal(
    (await store.resolveComment("review", comment.id)).resolved,
    true,
  );

  const trashed = await store.trashProject("review");
  assert.ok(trashed.trashedAt);
  assert.deepEqual(await store.listProjects(), []);

  const reopened = await openStore(root);
  assert.equal(
    (await reopened.getProject("review")).trashedAt,
    trashed.trashedAt,
  );
  const restored = await reopened.restoreProject("review");
  assert.equal(restored.trashedAt, undefined);
  assert.equal(restored.comments.length, 1);
  assert.equal(restored.comments[0].id, comment.id);
  assert.equal(restored.comments[0].resolved, true);
});

test("comments work anonymously without an account or display name", async(t)=>{
  const store=await openStore(await makeDataRoot(t));
  await store.createProject(makeDocument("anonymous"));
  const comment=await store.addComment("anonymous",{text:"Review this transition."});
  assert.equal(comment.author,"Guest");
  const unnamed=await store.addComment("anonymous",{text:"Optional name left empty.",author:"   "});
  assert.equal(unnamed.author,"Guest");
  assert.equal((await store.getProject("anonymous")).comments.length,2);
});

test("rejects duplicate project IDs and out-of-bounds comment input without overwriting data", async (t) => {
  const store = await openStore(await makeDataRoot(t));
  await store.createProject(makeDocument("safe"));
  await assert.rejects(
    store.createProject(makeDocument("safe", "Replacement")),
    { code: "ERR_DUPLICATE_PROJECT" },
  );
  await assert.rejects(
    store.addComment("safe", { text: "x".repeat(2001), author: "Reviewer" }),
    { code: "ERR_INVALID_COMMENT" },
  );
  await assert.rejects(
    store.addComment("safe", {
      text: "Out of bounds",
      author: "Reviewer",
      x: 641,
      y: 2,
      sceneId: "scene_safe",
    }),
    { code: "ERR_INVALID_COMMENT" },
  );
  assert.equal((await store.getProject("safe")).document.name, "Project safe");
  assert.deepEqual((await store.getProject("safe")).comments, []);
});
