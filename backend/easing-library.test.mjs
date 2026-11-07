import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocument } from "../engine/model.js";
import { openStore } from "./store.mjs";

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kino-easings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("old stores list no easings without changing projects or the store file", async (t) => {
  const root = await makeRoot(t);
  const store = await openStore(root);
  const project = await store.createProject(createDocument({ id: "saved-project", name: "Saved" }));
  const filename = path.join(root, "store.json");
  const oldState = JSON.parse(await readFile(filename, "utf8"));
  delete oldState.easings;
  const oldText = `${JSON.stringify(oldState)}\n`;
  await writeFile(filename, oldText, { mode: 0o600 });

  const reopened = await openStore(root);
  assert.deepEqual(await reopened.listEasings(), []);
  assert.deepEqual(await reopened.getProject("saved-project"), project);
  assert.equal(await readFile(filename, "utf8"), oldText, "reading an old store does not rewrite it");
});

test("saved easings copy normalized values, allow duplicate names, and survive rename, delete, and reopen", async (t) => {
  const root = await makeRoot(t);
  const first = await openStore(root);
  const sourceCurve = [0.2, 0.4, 0.8, 0.9];
  const saved = await first.saveEasing({ name: "  Favorite  ", easing: sourceCurve, intensity: 30 });
  sourceCurve[1] = 9;
  saved.easing[2] = 0;
  assert.deepEqual(await first.listEasings(), [{
    id: saved.id,
    name: "Favorite",
    easing: [0.2, 0.4, 0.8, 0.9],
    intensity: 30,
  }]);

  const duplicate = await first.saveEasing({ name: "Favorite", easing: "linear" });
  assert.notEqual(duplicate.id, saved.id);
  assert.equal(duplicate.name, "Favorite");
  assert.equal(Object.hasOwn(duplicate, "intensity"), false);
  const slashName = await first.saveEasing({ name: "Favorite/Curve", easing: "linear" });
  assert.equal(slashName.name, "Favorite/Curve", "names follow the contract without project-name path restrictions");
  const renamed = await first.renameEasing(saved.id, "  Favorite  2 ");
  assert.equal(renamed.name, "Favorite  2");

  assert.deepEqual(await first.deleteEasing(duplicate.id), { deleted: duplicate.id });
  assert.deepEqual(await first.deleteEasing(slashName.id), { deleted: slashName.id });
  const reopened = await openStore(root);
  assert.deepEqual(await reopened.listEasings(), [renamed]);
  const mode = (await stat(path.join(root, "store.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("easing writes queue across handles, stay isolated by root, and failed changes leave state alone", async (t) => {
  const root = await makeRoot(t);
  const otherRoot = await makeRoot(t);
  const [first, second, isolated] = await Promise.all([
    openStore(root), openStore(root), openStore(otherRoot),
  ]);
  const writes = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? first : second).saveEasing({ name: `Curve ${index}`, easing: "linear" }),
  ));
  const listed = await second.listEasings();
  assert.equal(listed.length, 20);
  assert.equal(new Set(listed.map(({ id }) => id)).size, 20);
  assert.equal((await isolated.listEasings()).length, 0);

  const before = await readFile(path.join(root, "store.json"), "utf8");
  await assert.rejects(first.saveEasing({ name: " ", easing: "linear" }), /name/i);
  await assert.rejects(first.saveEasing({ name: "Unknown", easing: "no-such-easing" }));
  await assert.rejects(first.saveEasing({ name: "Extra", easing: "linear", projectId: "project" }), /cannot contain projectId/i);
  await assert.rejects(first.saveEasing({ name: "Bad intensity", easing: "linear", intensity: 101 }));
  await assert.rejects(first.renameEasing("missing-easing", "Renamed"), { code: "ERR_EASING_NOT_FOUND" });
  await assert.rejects(first.deleteEasing("missing-easing"), { code: "ERR_EASING_NOT_FOUND" });
  assert.equal(await readFile(path.join(root, "store.json"), "utf8"), before);
  assert.equal(writes.length, 20);
});

test("the 500-record workspace limit is enforced without replacing the existing store", async (t) => {
  const root = await makeRoot(t);
  const filename = path.join(root, "store.json");
  await writeFile(filename, JSON.stringify({
    version: 1,
    folders: [],
    projects: [],
    easings: Array.from({ length: 500 }, (_, index) => ({
      id: `easing-${index}`,
      name: "Repeated name",
      easing: "linear",
    })),
  }));
  const store = await openStore(root);
  const before = await readFile(filename, "utf8");
  await assert.rejects(store.saveEasing({ name: "One too many", easing: "linear" }), { code: "ERR_EASING_LIMIT" });
  assert.equal(await readFile(filename, "utf8"), before);
});
