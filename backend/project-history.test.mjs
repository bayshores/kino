import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectHistory } from "./project-history.mjs";

const HISTORY_ID = "a12b34cd-56ef-4789-8abc-0123456789ab";

async function temporaryRoot(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "project-history-test-"));
  const root = path.join(parent, "history");
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, history: createProjectHistory(root) };
}

function document(id, title = "Snapshot") {
  return { id, title, scenes: [] };
}

test("writes a private atomic snapshot and reads it after reopening the helper", async t => {
  const { root, history } = await temporaryRoot(t);
  const value = document("doc-1");

  await history.write(HISTORY_ID, 4, value);

  const filename = path.join(root, HISTORY_ID, "4.json");
  const contents = JSON.parse(await readFile(filename, "utf8"));
  assert.deepEqual(contents, { revision: 4, document: value });
  assert.deepEqual(await createProjectHistory(root).read(HISTORY_ID, 4), value);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, HISTORY_ID))).mode & 0o777, 0o700);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
});

test("prunes only unkept positive revision JSON files and preserves unrelated entries", async t => {
  const { root, history } = await temporaryRoot(t);
  for (const revision of [1, 2, 3, 10]) await history.write(HISTORY_ID, revision, document(`doc-${revision}`));
  const generation = path.join(root, HISTORY_ID);
  await writeFile(path.join(generation, "notes.txt"), "keep me");
  await writeFile(path.join(generation, "0.json"), "not a positive revision");
  await writeFile(path.join(generation, "2.json.bak"), "not a revision file");

  const removed = await history.prune(HISTORY_ID, [1, 3, 10, 50]);

  assert.deepEqual(removed, [2]);
  assert.deepEqual(await history.read(HISTORY_ID, 1), document("doc-1"));
  assert.equal(await history.read(HISTORY_ID, 2), null);
  assert.deepEqual(await history.read(HISTORY_ID, 3), document("doc-3"));
  assert.deepEqual(await history.read(HISTORY_ID, 10), document("doc-10"));
  assert.equal(await readFile(path.join(generation, "notes.txt"), "utf8"), "keep me");
  assert.equal(await readFile(path.join(generation, "0.json"), "utf8"), "not a positive revision");
  assert.equal(await readFile(path.join(generation, "2.json.bak"), "utf8"), "not a revision file");
});

test("validates UUIDs, positive safe revisions, documents, and prune keep values", async t => {
  const { history } = await temporaryRoot(t);
  await assert.rejects(history.write("../outside", 1, document("doc-1")), /UUID/);
  await assert.rejects(history.read(HISTORY_ID, 0), /positive safe integer/);
  await assert.rejects(history.read(HISTORY_ID, -1), /positive safe integer/);
  await assert.rejects(history.read(HISTORY_ID, 1.5), /positive safe integer/);
  await assert.rejects(history.read(HISTORY_ID, Number.MAX_SAFE_INTEGER + 1), /positive safe integer/);
  await assert.rejects(history.write(HISTORY_ID, 1, { scenes: [] }), /object with a non-empty string id/);
  await assert.rejects(history.write(HISTORY_ID, 1, []), /object with a non-empty string id/);
  await assert.rejects(history.prune(HISTORY_ID, [1, 0]), /positive safe integer/);
  await assert.rejects(history.prune(HISTORY_ID, "1,2"), /keepRevisions must be an array/);
});

test("refuses symlink roots, generations, and revision files without touching their targets", async t => {
  const { parent, root, history } = await temporaryRoot(t);
  const outside = path.join(parent, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel.txt"), "outside data");

  const rootLink = path.join(parent, "history-link");
  await symlink(outside, rootLink, "dir");
  await assert.rejects(createProjectHistory(rootLink).read(HISTORY_ID, 1), /symbolic link|ELOOP/i);

  await mkdir(root);
  const generationLink = path.join(root, HISTORY_ID);
  await symlink(outside, generationLink, "dir");
  await assert.rejects(history.write(HISTORY_ID, 1, document("doc-1")), /symbolic link|ELOOP/i);
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "outside data");
  await rm(generationLink);

  await mkdir(generationLink);
  const revisionLink = path.join(generationLink, "2.json");
  await symlink(path.join(outside, "sentinel.txt"), revisionLink);
  await assert.rejects(history.read(HISTORY_ID, 2), /symbolic link|ELOOP/i);
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "outside data");
  assert.equal(await history.remove(HISTORY_ID), true);
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "outside data");
});

test("rejects malformed stored JSON, revision envelopes, and document IDs", async t => {
  const { root, history } = await temporaryRoot(t);
  const generation = path.join(root, HISTORY_ID);
  await mkdir(generation, { recursive: true });

  await writeFile(path.join(generation, "1.json"), "{");
  await assert.rejects(history.read(HISTORY_ID, 1), /Malformed project history JSON/);
  await writeFile(path.join(generation, "1.json"), JSON.stringify({ revision: 2, document: document("doc-1") }));
  await assert.rejects(history.read(HISTORY_ID, 1), /Malformed project history revision/);
  await writeFile(path.join(generation, "1.json"), JSON.stringify({ revision: 1, document: { title: "missing id" } }));
  await assert.rejects(history.read(HISTORY_ID, 1), /Malformed project history document/);
});

test("a failed write never replaces an existing revision", async t => {
  const { history } = await temporaryRoot(t);
  const original = document("doc-1", "original");
  await history.write(HISTORY_ID, 7, original);

  await assert.rejects(history.write(HISTORY_ID, 7, document("doc-1", "replacement")), /already exists/);

  assert.deepEqual(await history.read(HISTORY_ID, 7), original);
});

test("remove deletes only the selected history namespace and is idempotent", async t => {
  const { root, history } = await temporaryRoot(t);
  const otherId = "b12b34cd-56ef-4789-8abc-0123456789ab";
  await history.write(HISTORY_ID, 1, document("doc-1"));
  await history.write(otherId, 1, document("doc-2"));

  assert.equal(await history.remove(HISTORY_ID), true);
  assert.equal(await history.read(HISTORY_ID, 1), null);
  assert.deepEqual(await history.read(otherId, 1), document("doc-2"));
  assert.equal(await history.remove(HISTORY_ID), false);
  assert.deepEqual((await readdir(root)).sort(), [otherId]);
});
