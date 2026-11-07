import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConflictError, openStore } from "./store.mjs";
import { createProjectHistory } from "./project-history.mjs";

function makeDocument(id, name = `Project ${id}`) {
  return {
    version: 1,
    id,
    name,
    scenes: [{
      id: `scene_${id}`,
      name: "Scene 1",
      width: 640,
      height: 360,
      duration: 4,
      background: "#111111",
      layers: [],
    }],
  };
}

function request(id, scope = "owner", fingerprintSeed = 1) {
  return { id, scope, fingerprint: fingerprintSeed.toString(16).padStart(64, "0") };
}

async function makeDataRoot(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kino-store-history-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return path.join(temporaryRoot, "data");
}

async function projectHistoryId(root, id) {
  const state = JSON.parse(await readFile(path.join(root, "store.json"), "utf8"));
  return state.projects.find((project) => project.document.id === id)?.historyId;
}

test("retains the latest 50 project revisions across restart", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);
  const id = "history-limit";
  await store.createProject(makeDocument(id));
  for (let number = 1; number <= 60; number += 1) {
    await store.updateProject(id, makeDocument(id, `Revision ${number}`), number);
  }

  const reopened = await openStore(root);
  const current = await reopened.getProject(id);
  assert.equal(current.revision, 61);
  assert.equal((await reopened.getProjectRevision(id, 11)), null);
  assert.equal((await reopened.getProjectRevision(id, 12)).name, "Revision 11");
  assert.equal((await reopened.getProjectRevision(id, 60)).name, "Revision 59");
  assert.equal((await reopened.getProjectRevision(id, 61)).name, "Revision 60");
});

test("rename, Trash, and restore each advance durable document history", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);
  const id = "lifecycle-history";
  await store.createProject(makeDocument(id));
  await store.renameProject(id, "Renamed");
  const trashed = await store.trashProject(id);
  assert.ok(trashed.trashedAt);
  const reopened = await openStore(root);
  assert.equal((await reopened.getProject(id)).revision, 3);
  assert.equal((await reopened.getProjectRevision(id, 1)).name, `Project ${id}`);
  assert.equal((await reopened.getProjectRevision(id, 2)).name, "Renamed");
  assert.equal((await reopened.getProjectRevision(id, 3)).name, "Renamed");

  const restored = await reopened.restoreProject(id);
  assert.equal(restored.revision, 4);
  assert.equal(restored.trashedAt, undefined);
  const afterRestore = await openStore(root);
  assert.equal((await afterRestore.getProjectRevision(id, 4)).name, "Renamed");
  assert.equal((await afterRestore.getProject(id)).trashedAt, undefined);
});

test("stale merge reads its base and current version inside the cross-handle mutation queue", async (t) => {
  const root = await makeDataRoot(t);
  const first = await openStore(root), second = await openStore(root);
  const id = "atomic-merge";
  const initial = await first.createProject(makeDocument(id, "Base"));
  const remoteDocument = makeDocument(id, "Remote edit");
  const localDocument = makeDocument(id, "Local edit");
  let observed;

  const remoteWrite = second.updateProject(id, remoteDocument, initial.revision);
  const staleMerge = first.updateProject(id, localDocument, initial.revision, {
    resultMetadata: { rebased: true },
    merge(base, ours, theirs) {
      observed = { base: base.name, ours: ours.name, theirs: theirs.name };
      return { document: makeDocument(id, "Merged remote and local"), conflicts: [] };
    },
  });
  const [remote, merged] = await Promise.all([remoteWrite, staleMerge]);

  assert.equal(remote.revision, 2);
  assert.deepEqual(observed, { base: "Base", ours: "Local edit", theirs: "Remote edit" });
  assert.equal(merged.revision, 3);
  assert.equal(merged.merged, true);
  assert.equal(merged.previousRevision, 2);
  assert.equal(merged.rebased, true);
  assert.equal((await second.getProject(id)).document.name, "Merged remote and local");
});

test("out-of-history revisions fall back to strict conflict instead of calling merge", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);
  const id = "expired-base";
  await store.createProject(makeDocument(id));
  for (let revision = 1; revision <= 55; revision += 1)
    await store.updateProject(id, makeDocument(id, `Revision ${revision}`), revision);

  let called = false;
  await assert.rejects(store.updateProject(id, makeDocument(id, "stale"), 1, {
    merge() { called = true; return { document: makeDocument(id, "should not save"), conflicts: [] }; },
  }), (error) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.current.revision, 56);
    return true;
  });
  assert.equal(called, false);
});

test("an operation receipt replays its exact first result after later edits and restart", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);
  const id = "receipt-persistence";
  await store.createProject(makeDocument(id, "Initial"));
  const firstRequest = request("operation-1", "owner", 1);
  const firstResult = await store.updateProject(id, makeDocument(id, "First result"), 1, {
    request: firstRequest,
    resultMetadata: { rebased: true },
  });
  await store.updateProject(id, makeDocument(id, "Later edit"), 2);

  const reopened = await openStore(root);
  const replayed = await reopened.getOperationResult(id, firstRequest);
  assert.deepEqual(replayed, firstResult);
  const duplicate = await reopened.updateProject(id, makeDocument(id, "Must not apply"), 1, { request: firstRequest });
  assert.deepEqual(duplicate, firstResult);
  assert.equal((await reopened.getProject(id)).revision, 3);
});

test("receipt IDs are isolated by scope and a reused ID with another fingerprint is refused", async (t) => {
  const store = await openStore(await makeDataRoot(t));
  const id = "receipt-scope";
  await store.createProject(makeDocument(id, "Initial"));
  const ownerRequest = request("same-request", "owner", 10);
  const shareRequest = request("same-request", "11111111-2222-4333-8444-555555555555", 10);
  const ownerResult = await store.updateProject(id, makeDocument(id, "Owner result"), 1, { request: ownerRequest });
  const shareResult = await store.updateProject(id, makeDocument(id, "Share result"), 2, { request: shareRequest });

  assert.equal(ownerResult.revision, 2);
  assert.equal(shareResult.revision, 3);
  assert.deepEqual(await store.getOperationResult(id, ownerRequest), ownerResult);
  assert.deepEqual(await store.getOperationResult(id, shareRequest), shareResult);
  await assert.rejects(store.updateProject(id, makeDocument(id, "Wrong fingerprint"), 3, {
    request: { ...ownerRequest, fingerprint: "f".repeat(64) },
  }), { code: "ERR_REQUEST_ID_REUSE" });
  assert.equal((await store.getProject(id)).revision, 3);
});

test("only the latest 100 receipts replay, and evicted receipt revisions are not merge bases", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);
  const id = "receipt-limit";
  await store.createProject(makeDocument(id, "Initial"));
  let latestRequest, latestResult;
  for (let number = 1; number <= 101; number += 1) {
    const currentRevision = number;
    latestRequest = request(`operation-${number}`, "owner", number);
    latestResult = await store.updateProject(id, makeDocument(id, `Result ${number}`), currentRevision, {
      request: latestRequest,
    });
  }

  const reopened = await openStore(root);
  assert.equal(latestResult.revision, 102);
  assert.equal((await reopened.getOperationResult(id, request("operation-1", "owner", 1))), null);
  assert.deepEqual(await reopened.getOperationResult(id, latestRequest), latestResult);
  assert.equal(await reopened.getProjectRevision(id, 2), null);
  const generation = await projectHistoryId(root, id);
  const archivedRevisions = (await readdir(path.join(root, "project-history", generation)))
    .filter((name) => /^\d+\.json$/u.test(name))
    .map((name) => Number(name.slice(0, -5)))
    .sort((left, right) => left - right);
  assert.equal(archivedRevisions.length, 99, "only the revisions still needed by history or receipts remain on disk");
  assert.equal(archivedRevisions[0], 3);
  assert.equal(archivedRevisions.at(-1), 101);

  let mergeCalled = false;
  await assert.rejects(reopened.updateProject(id, makeDocument(id, "stale receipt base"), 2, {
    merge() { mergeCalled = true; return { document: makeDocument(id, "must not save"), conflicts: [] }; },
  }), { code: "ERR_REVISION_CONFLICT" });
  assert.equal(mergeCalled, false);
});

test("missing or corrupt archived receipt documents throw and never reapply a request", async (t) => {
  for (const damage of ["missing", "corrupt"]) {
    const root = await makeDataRoot(t);
    const store = await openStore(root);
    const id = `receipt-${damage}`;
    await store.createProject(makeDocument(id, "Initial"));
    const savedRequest = request(`request-${damage}`, "owner", damage === "missing" ? 20 : 21);
    await store.updateProject(id, makeDocument(id, "First result"), 1, { request: savedRequest });
    await store.updateProject(id, makeDocument(id, "Later result"), 2);

    const generation = await projectHistoryId(root, id);
    assert.ok(generation);
    const archivedReceipt = path.join(root, "project-history", generation, "2.json");
    if (damage === "missing") await unlink(archivedReceipt);
    else await writeFile(archivedReceipt, "not valid json", "utf8");

    await assert.rejects(store.getOperationResult(id, savedRequest), { code: "ERR_STORE_IO" }, damage);
    await assert.rejects(store.updateProject(id, makeDocument(id, "Must not reapply"), 3, {
      request: savedRequest,
    }), { code: "ERR_STORE_IO" }, damage);
    assert.equal((await store.getProject(id)).revision, 3, damage);
    assert.equal((await store.getProject(id)).document.name, "Later result", damage);
  }
});

test("an identical archive-before-index snapshot is reused, but a different one is refused", async (t) => {
  for (const mismatch of [false, true]) {
    const root = await makeDataRoot(t);
    const store = await openStore(root);
    const id = mismatch ? "orphan-conflict" : "orphan-reuse";
    const created = await store.createProject(makeDocument(id, "Indexed revision one"));
    const generation = await projectHistoryId(root, id);
    const history = createProjectHistory(path.join(root, "project-history"));
    const orphan = mismatch ? makeDocument(id, "Different preexisting revision") : created.document;
    await history.write(generation, created.revision, orphan);

    if (mismatch) {
      await assert.rejects(store.updateProject(id, makeDocument(id, "must not commit"), 1), { code: "ERR_STORE_IO" });
      const current = await store.getProject(id);
      assert.equal(current.revision, 1);
      assert.equal(current.document.name, "Indexed revision one");
    } else {
      const updated = await store.updateProject(id, makeDocument(id, "Revision two"), 1);
      assert.equal(updated.revision, 2);
      assert.equal((await store.getProjectRevision(id, 1)).name, "Indexed revision one");
      assert.equal((await store.getProject(id)).document.name, "Revision two");
    }
  }
});

test("permanent deletion removes its history generation and ID reuse starts clean", async (t) => {
  const root = await makeDataRoot(t);
  const store = await openStore(root);
  const id = "reused-project";
  await store.createProject(makeDocument(id, "Old generation"));
  await store.updateProject(id, makeDocument(id, "Old generation edit"), 1);
  await store.trashProject(id);
  const oldGeneration = await projectHistoryId(root, id);
  await store.deleteProjectForever(id);
  await assert.rejects(readdir(path.join(root, "project-history", oldGeneration)), { code: "ENOENT" });

  const recreated = await store.createProject(makeDocument(id, "New generation"));
  const newGeneration = await projectHistoryId(root, id);
  assert.notEqual(newGeneration, oldGeneration);
  assert.equal(recreated.revision, 1);
  assert.equal((await store.getProjectRevision(id, 1)).name, "New generation");
  assert.equal(await store.getProjectRevision(id, 2), null);
});
