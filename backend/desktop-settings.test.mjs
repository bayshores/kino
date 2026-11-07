import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopSettings } from "../desktop/settings.mjs";
import { createIdentitySource } from "../frontend/comments.js";
import { getSetting, setSetting } from "../frontend/browserStorage.js";
import { loadReads, saveReads } from "../frontend/commentUnread.js";

async function makeStore(t) {
  const parent = await mkdtemp(join(tmpdir(), "kino-desktop-settings-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "settings");
  return { parent, directory, store: createDesktopSettings(directory) };
}

test("a new settings store instance reads edits and removals from the same private files", async (t) => {
  const { directory, store } = await makeStore(t);
  const recoveryKey = "kino-recovery-project_1";
  store.setItem(recoveryKey, "first draft");

  const reopened = createDesktopSettings(directory);
  assert.equal(reopened.getItem(recoveryKey), "first draft");

  reopened.setItem(recoveryKey, "edited draft");
  assert.equal(store.getItem(recoveryKey), "edited draft");

  store.removeItem(recoveryKey);
  assert.equal(reopened.getItem(recoveryKey), null);
});

test("per-window recovery keys are indexed by exact project and grant prefixes across relaunches", async (t) => {
  const { directory, store } = await makeStore(t);
  const first = "kino-recovery-window-project.one~grant:shared~window-1";
  const second = "kino-recovery-window-project.one~grant:shared~window-2";
  const otherGrant = "kino-recovery-window-project.one~grant:other~window-3";
  const otherProject = "kino-recovery-window-other-project~grant:shared~window-4";
  store.setItem(first, "window one snapshot");
  store.setItem(second, "window two snapshot");
  store.setItem(otherGrant, "different grant snapshot");
  store.setItem(otherProject, "different project snapshot");
  store.setItem("kino-comment-identity", "private-comment-identity");
  store.setItem("kino-share-links-project_1", "private-share-capability");

  const grantPrefix = "kino-recovery-window-project.one~grant:shared~";
  assert.deepEqual(store.keys(grantPrefix), [first, second]);
  assert.deepEqual(store.keys("kino-recovery-window-project.one~"), [otherGrant, first, second]);
  assert.throws(() => store.keys("other-recovery-window-project.one~"), /Unsupported setting prefix/);
  assert.deepEqual(store.keys("kino-recovery-window-"), [otherProject, otherGrant, first, second]);

  const indexFile = join(directory, "recovery-window-index.json");
  if (process.platform !== "win32") assert.equal((await stat(indexFile)).mode & 0o777, 0o600);
  const index = JSON.parse(await readFile(indexFile, "utf8"));
  assert.deepEqual(index.keys, [first, otherGrant, otherProject, second].sort());
  assert.equal(JSON.stringify(index).includes("private-comment-identity"), false);
  assert.equal(JSON.stringify(index).includes("private-share-capability"), false);

  const orphan = "kino-recovery-window-project.one~grant:shared~orphaned-write";
  await writeFile(indexFile, JSON.stringify({ ...index, keys: [...index.keys, orphan] }));
  const reopened = createDesktopSettings(directory);
  assert.deepEqual(reopened.keys(grantPrefix), [first, second], "an index entry without a snapshot is ignored");
  assert.equal(reopened.getItem(first), "window one snapshot");
  reopened.removeItem(first);
  assert.equal(store.getItem(first), null);
  assert.equal(store.getItem(second), "window two snapshot");
  assert.deepEqual(store.keys(grantPrefix), [second], "removing one window preserves the other window's index entry");
  assert.deepEqual(reopened.keys("kino-recovery-window-"), [otherProject, otherGrant, second]);
});

test("settings files and their directory are private and successful atomic writes leave no temporary file", async (t) => {
  const { directory, store } = await makeStore(t);
  store.setItem("kino-name", "Local animator");

  const names = await readdir(directory);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[a-f0-9]{64}\.txt$/);
  assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  assert.equal(await readFile(join(directory, names[0]), "utf8"), "Local animator");

  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600);
  }
});

test("invalid and traversing keys cannot write outside the store", async (t) => {
  const { parent, directory, store } = await makeStore(t);
  const sentinel = join(parent, "outside.txt");
  await writeFile(sentinel, "preserve this file");
  store.setItem("kino-name", "safe value");

  for (const key of [
    "../outside.txt",
    "kino-recovery-../../outside.txt",
    "kino-name/../../../outside.txt",
    "kino-recovery-",
    `kino-recovery-${"x".repeat(240)}`,
  ]) {
    assert.throws(() => store.setItem(key, "attack"), /Unsupported setting/);
    assert.throws(() => store.getItem(key), /Unsupported setting/);
    assert.throws(() => store.removeItem(key), /Unsupported setting/);
  }
  for (const prefix of [
    "kino-name",
    "recovery-window-",
    "kino-recovery-window-../",
    "kino-recovery-window-project~~grant~",
    `kino-recovery-window-${"x".repeat(129)}~grant~`,
  ]) {
    assert.throws(() => store.keys(prefix), /Unsupported setting prefix/);
  }

  assert.equal(await readFile(sentinel, "utf8"), "preserve this file");
  assert.deepEqual((await readdir(parent)).sort(), ["outside.txt", "settings"]);
  assert.equal((await readdir(directory)).length, 1);
  assert.equal(store.getItem("kino-name"), "safe value");
});

test("legacy recovery keys allow project and grant punctuation while other allowlists stay narrow", async (t) => {
  const { store } = await makeStore(t);
  const legacyKey = "kino-recovery-project.one:grant:two";
  store.setItem(legacyKey, "legacy snapshot");
  assert.equal(store.getItem(legacyKey), "legacy snapshot");
  assert.throws(() => store.setItem("kino-comment-reads-project.one:grant", "{}"), /Unsupported setting/);
  assert.throws(() => store.setItem("kino-share-links-project.one", "{}"), /Unsupported setting/);
});

test("only kino setting names are accepted", async (t) => {
  const { store } = await makeStore(t);
  store.setItem("kino-last-project", "project-3");
  assert.equal(store.getItem("kino-last-project"), "project-3");
  assert.throws(() => store.setItem("other-app-last-project", "x"), /Unsupported setting/);
});

test("oversized and non-string values cannot replace an intact recovery copy", async (t) => {
  const { directory, store } = await makeStore(t);
  const key = "kino-recovery-project_2";
  store.setItem(key, "last known good recovery copy");
  const reopened = createDesktopSettings(directory);
  const oversized = "x".repeat(32 * 1024 * 1024 + 1);

  for (const invalid of [null, 7, { text: "not a string" }, oversized]) {
    assert.throws(() => reopened.setItem(key, invalid), /Setting is too large/);
    assert.equal(store.getItem(key), "last known good recovery copy");
  }

  assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
});

test("the Mac app keeps the browser's comment identity, so its author survives a relaunch", async (t) => {
  const { directory, store } = await makeStore(t);
  // The renderer reaches this store through preload.cjs, which throws when a key is refused.
  const bridge = (settings) => ({
    getItem: (key) => settings.getItem(key),
    setItem: (key, value) => settings.setItem(key, value),
    removeItem: (key) => settings.removeItem(key),
  });
  store.setItem("kino-comment-identity", "{\"authorKey\":\"saved\"}");
  assert.equal(createDesktopSettings(directory).getItem("kino-comment-identity"), "{\"authorKey\":\"saved\"}");
  store.removeItem("kino-comment-identity");

  // One launch makes the identity; the next launch (a new store over the same folder) reads it back.
  const first = createIdentitySource({ storage: bridge(store) })();
  const relaunched = createIdentitySource({ storage: bridge(createDesktopSettings(directory)) })();
  assert.match(first.authorKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(relaunched, first);
  assert.throws(() => store.setItem("kino-comment-identity-extra", "x"), /Unsupported setting/);
});

test("the Mac app keeps each file's comment read record and the hidden-pins choice across a relaunch", async (t) => {
  const { directory, store } = await makeStore(t);
  const bridge = (settings) => ({
    getItem: (key) => settings.getItem(key),
    setItem: (key, value) => settings.setItem(key, value),
    removeItem: (key) => settings.removeItem(key),
  });
  // Review finding: the settings store refused these keys, so the Mac app forgot which threads
  // were read (and "Mark as unread") on every launch, and the pins came back after ⇧C hid them.
  const reads = { seen: { "thread-1": 5 }, unread: ["thread-2"] };
  assert.equal(saveReads("project_1", reads, bridge(store)), true);
  // "comment-pins" is PINS_SETTING in src/useCommentMode.js.
  assert.equal(setSetting("comment-pins", "hidden", bridge(store)), true);

  const relaunched = bridge(createDesktopSettings(directory));
  assert.deepEqual(loadReads("project_1", relaunched), reads);
  assert.deepEqual(loadReads("project-2", relaunched), { seen: {}, unread: [] }, "each file has its own record");
  assert.equal(getSetting("comment-pins", relaunched), "hidden");

  // Only these comment settings are accepted, and a project ID with other characters is refused.
  assert.throws(() => store.setItem("kino-comment-reads-a/b", "{}"), /Unsupported setting/);
  assert.throws(() => store.setItem("kino-comment-pins-extra", "x"), /Unsupported setting/);
  assert.throws(() => store.setItem("kino-comment-reads-", "{}"), /Unsupported setting/);
});

test("remembered share links survive relaunch in private files and cannot traverse outside the store", async (t) => {
  const { parent, directory, store } = await makeStore(t);
  const key = "kino-share-links-project_1";
  const remembered = JSON.stringify({ version: 1, links: [{ token: "synthetic-test-capability" }] });
  store.setItem(key, remembered);

  const reopened = createDesktopSettings(directory);
  assert.equal(reopened.getItem(key), remembered);
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[a-f0-9]{64}\.txt$/);
  if (process.platform !== "win32") assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600);

  const sentinel = join(parent, "outside.txt");
  await writeFile(sentinel, "preserve this file");
  for (const invalid of [
    "kino-share-links-../outside.txt",
    "kino-share-links-project_1/../../../outside.txt",
  ]) {
    assert.throws(() => reopened.setItem(invalid, "attack"), /Unsupported setting/);
    assert.throws(() => reopened.getItem(invalid), /Unsupported setting/);
  }
  assert.equal(await readFile(sentinel, "utf8"), "preserve this file");
  assert.deepEqual((await readdir(parent)).sort(), ["outside.txt", "settings"]);
  assert.deepEqual((await readdir(directory)), names);
  assert.equal(reopened.getItem(key), remembered);
});
