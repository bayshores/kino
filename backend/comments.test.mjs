// Comment rules through the real store: authorship, replies, time anchors, moving threads,
// roles, limits, stores saved before threads existed, and author key hashes staying on the server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "./store.mjs";
import { authorIdForKeyHash, commentKeyHash, MAX_COMMENTS_PER_PROJECT, publicComment, sameAuthorKey } from "./comments.mjs";
import { anchorTime } from "../frontend/comments.js";

const ANN_KEY = "a".repeat(64);
const BEN_KEY = "b".repeat(64);
// Each person's comment key is sent as a header; the server stores its hash and works out the
// public author ID from it for each project.
const ann = { keyHash: commentKeyHash(ANN_KEY) };
const ben = { keyHash: commentKeyHash(BEN_KEY) };
ann.authorId = authorIdForKeyHash("review", ann.keyHash);
ben.authorId = authorIdForKeyHash("review", ben.keyHash);
const as = (person, role = "comment") => ({ role, keyHash: person.keyHash });

function makeDocument(id) {
  return {
    version: 1,
    id,
    name: `Project ${id}`,
    scenes: [
      { id: "wide", name: "Wide", width: 640, height: 360, duration: 4, background: "#111111", layers: [] },
      { id: "small", name: "Small", width: 100, height: 50, duration: 1, background: "#111111", layers: [] },
    ],
  };
}

async function makeStore(t, id = "review") {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kino-comments-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, "data");
  const store = await openStore(root);
  await store.createProject(makeDocument(id));
  return { store, root };
}

function post(store, person, input, role = "comment") {
  return store.addComment("review", input, as(person, role));
}

// Adds scenes (copies of the small 100 x 50, 1 s scene with the given fields) to the project.
async function addScenes(store, scenes) {
  const project = await store.getProject("review");
  const document = structuredClone(project.document);
  for (const fields of scenes) document.scenes.push({ ...document.scenes[1], name: fields.id, ...fields });
  await store.updateProject("review", document, project.revision);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

test("a comment key is stored only as its SHA-256 hash and matched exactly", () => {
  assert.equal(commentKeyHash(ANN_KEY), createHash("sha256").update(ANN_KEY).digest("hex"));
  assert.equal(commentKeyHash(undefined), null);
  assert.equal(commentKeyHash(""), null);
  assert.throws(() => commentKeyHash("short"), { code: "ERR_INVALID_COMMENT", status: 400 });
  assert.throws(() => commentKeyHash(`${"a".repeat(40)} bad`), { status: 400 });
  assert.equal(sameAuthorKey(ann.keyHash, commentKeyHash(ANN_KEY)), true);
  assert.equal(sameAuthorKey(ann.keyHash, ben.keyHash), false);
  assert.equal(sameAuthorKey(undefined, ann.keyHash), false);
  assert.equal(sameAuthorKey(ann.keyHash, null), false);
  assert.deepEqual(publicComment({ id: "c", text: "t", authorKeyHash: ann.keyHash }), { id: "c", text: "t" });
});

test("only the author's key edits text and mentions; editedAt records the edit", async (t) => {
  const { store } = await makeStore(t);
  const comment = await post(store, ann, { text: "Slow this down", author: "Ann", sceneId: "wide", x: 10, y: 20, time: 1.5 });
  assert.equal(comment.authorId, ann.authorId);
  assert.equal(comment.editedAt, undefined);

  const edited = await store.updateComment("review", comment.id, { text: "Slow this down a lot", mentions: ["Ben", " Ben ", "Cy"] }, as(ann));
  assert.equal(edited.text, "Slow this down a lot");
  assert.deepEqual(edited.mentions, ["Ben", "Cy"], "mentions are trimmed and kept once");
  assert.match(edited.editedAt, /^\d{4}-\d\d-\d\dT/);

  // Someone else, even the owner or an editor, cannot rewrite it.
  await assert.rejects(store.updateComment("review", comment.id, { text: "Changed by Ben" }, as(ben)), { code: "ERR_COMMENT_FORBIDDEN", status: 403 });
  await assert.rejects(store.updateComment("review", comment.id, { text: "Changed by the owner" }, { role: "owner", keyHash: null }), { status: 403 });
  await assert.rejects(store.updateComment("review", comment.id, { mentions: [] }, as(ben, "edit")), { status: 403 });
  assert.equal((await store.getProject("review")).comments[0].text, "Slow this down a lot");

  // Text is validated as on creation; a failed change leaves the comment as it was.
  await assert.rejects(store.updateComment("review", comment.id, { text: "   " }, as(ann)), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(store.updateComment("review", comment.id, { text: "x".repeat(2001) }, as(ann)), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(store.updateComment("review", comment.id, { text: "ok", mentions: ["x".repeat(101)] }, as(ann)), { code: "ERR_INVALID_COMMENT" });
  assert.equal((await store.getProject("review")).comments[0].text, "Slow this down a lot");

  // Clearing mentions removes the field; resolving or moving does not count as an edit.
  const cleared = await store.updateComment("review", comment.id, { mentions: [] }, as(ann));
  assert.equal(cleared.mentions, undefined);
  const moved = await store.updateComment("review", comment.id, { x: 11, resolved: true }, as(ben));
  assert.equal(moved.editedAt, cleared.editedAt);

  // A comment posted without a key has no author to prove, so nobody can edit its text.
  const keyless = await store.addComment("review", { text: "No key" });
  assert.equal(keyless.authorId, undefined);
  await assert.rejects(store.updateComment("review", keyless.id, { text: "Edited" }, as(ann)), { status: 403 });
  await assert.rejects(store.updateComment("review", keyless.id, { text: "Edited" }), { status: 403 });
});

test("the server works out each author ID from the comment key and the project, so nobody can take someone else's", async (t) => {
  const { store } = await makeStore(t);
  await store.createProject(makeDocument("other"));
  const mine = await post(store, ann, { text: "Mine" });
  assert.match(mine.authorId, /^[0-9a-f]{32}$/);
  assert.equal(mine.authorId, ann.authorId);
  assert.equal((await post(store, ann, { text: "Mine again" })).authorId, ann.authorId, "the same key keeps its ID in a project");
  assert.notEqual((await post(store, ben, { text: "Ben's" })).authorId, ann.authorId);

  // Review finding: Ben saw Ann's author ID in one project and posts with it in another project
  // before Ann does. The server never takes an author ID from the request, so this is refused and
  // Ann's own comments there still work.
  await assert.rejects(
    store.addComment("other", { text: "Pretending to be Ann", authorId: ann.authorId }, as(ben)),
    { code: "ERR_INVALID_COMMENT", status: 400 },
  );
  await assert.rejects(post(store, ann, { text: "Sending my own ID", authorId: ann.authorId }), { status: 400 }, "the author ID is never sent");
  const bens = await store.addComment("other", { text: "Ben in the other project" }, as(ben));
  const anns = await store.addComment("other", { text: "Ann in the other project" }, as(ann));
  assert.equal(anns.authorId, authorIdForKeyHash("other", ann.keyHash));
  assert.notEqual(anns.authorId, ann.authorId, "one browser has a different author ID in each project");
  assert.notEqual(bens.authorId, anns.authorId);
  assert.equal((await store.updateComment("other", anns.id, { text: "Ann, edited" }, as(ann))).text, "Ann, edited");

  // A comment posted without a key has no author ID.
  assert.equal((await store.addComment("review", { text: "No key" }, { role: "comment", keyHash: null })).authorId, undefined);
});

test("the author or the owner deletes a comment; deleting a thread's first comment deletes its replies", async (t) => {
  const { store } = await makeStore(t);
  const thread = await post(store, ann, { text: "Thread", sceneId: "wide" });
  const reply = await post(store, ben, { text: "Reply", parentId: thread.id });
  const otherReply = await post(store, ann, { text: "Another reply", parentId: thread.id });
  const other = await post(store, ben, { text: "Separate thread" });

  await assert.rejects(store.deleteComment("review", thread.id, as(ben)), { code: "ERR_COMMENT_FORBIDDEN", status: 403 });
  await assert.rejects(store.deleteComment("review", thread.id, as(ben, "edit")), { status: 403 }, "an editor is not the owner");
  await assert.rejects(store.deleteComment("review", thread.id, { role: "view", keyHash: ann.keyHash }), { status: 403 }, "a view link cannot delete, even with the author's key");

  assert.deepEqual(await store.deleteComment("review", otherReply.id, as(ann)), { deleted: [otherReply.id] }, "the author deletes a reply");
  assert.deepEqual(
    (await store.deleteComment("review", thread.id, as(ann))).deleted.sort(),
    [thread.id, reply.id].sort(),
    "the first comment takes Ben's reply with it",
  );
  assert.deepEqual((await store.getProject("review")).comments.map((comment) => comment.id), [other.id]);

  // The owner moderates: it can delete comments it did not write, and keyless ones.
  const keyless = await store.addComment("review", { text: "Old style" });
  assert.deepEqual(await store.deleteComment("review", other.id, { role: "owner", keyHash: null }), { deleted: [other.id] });
  await assert.rejects(store.deleteComment("review", keyless.id, as(ann)), { status: 403 });
  assert.deepEqual(await store.deleteComment("review", keyless.id), { deleted: [keyless.id] });
  await assert.rejects(store.deleteComment("review", keyless.id), { code: "ERR_COMMENT_NOT_FOUND", status: 404 });
  assert.deepEqual((await store.getProject("review")).comments, []);
});

test("view access writes nothing; anyone who can comment resolves, reopens, and moves any thread", async (t) => {
  const { store } = await makeStore(t);
  const comment = await post(store, ann, { text: "Pin", sceneId: "wide", x: 5, y: 5, time: 0 });
  const view = { role: "view", keyHash: ann.keyHash };
  await assert.rejects(store.addComment("review", { text: "Viewer" }, view), { status: 403 });
  await assert.rejects(store.updateComment("review", comment.id, { resolved: true }, view), { status: 403 });
  await assert.rejects(store.updateComment("review", comment.id, { text: "Viewer edit" }, view), { status: 403 });
  await assert.rejects(store.deleteComment("review", comment.id, view), { status: 403 });
  await assert.rejects(store.updateComment("review", comment.id, { resolved: true }, { keyHash: null }), { status: 403 }, "a caller without a role is refused");

  for (const role of ["comment", "edit", "owner"]) {
    const resolved = await store.updateComment("review", comment.id, { resolved: true }, { role, keyHash: ben.keyHash });
    assert.equal(resolved.resolved, true, `${role} resolves`);
    const reopened = await store.updateComment("review", comment.id, { resolved: false, x: 100, y: 50, time: 2.25 }, { role, keyHash: null });
    assert.deepEqual([reopened.resolved, reopened.x, reopened.y, reopened.time], [false, 100, 50, 2.25], `${role} reopens and moves`);
  }
  await assert.rejects(store.updateComment("review", comment.id, {}, as(ann)), { code: "ERR_INVALID_COMMENT" }, "an empty change is refused");
  await assert.rejects(store.updateComment("review", comment.id, { author: "Renamed" }, as(ann)), { code: "ERR_INVALID_COMMENT" }, "unknown fields are refused");
  await assert.rejects(store.updateComment("review", comment.id, { resolved: "yes" }, as(ann)), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(store.updateComment("review", "missing", { resolved: true }, as(ann)), { code: "ERR_COMMENT_NOT_FOUND", status: 404 });
  // The original resolve call keeps working for the local owner.
  assert.equal((await store.resolveComment("review", comment.id)).resolved, true);
  assert.equal((await store.resolveComment("review", comment.id, false)).resolved, false);
});

test("replies answer a thread's first comment and take its place", async (t) => {
  const { store } = await makeStore(t);
  const thread = await post(store, ann, { text: "Thread", sceneId: "wide", x: 30, y: 40, time: 1 });
  const reply = await post(store, ben, { text: "Reply", author: "Ben", parentId: thread.id, mentions: ["Ann"] });
  assert.equal(reply.parentId, thread.id);
  assert.deepEqual([reply.x, reply.y, reply.sceneId, reply.time], [undefined, undefined, undefined, undefined]);
  assert.deepEqual(reply.mentions, ["Ann"]);

  await assert.rejects(post(store, ann, { text: "Nested", parentId: reply.id }), { code: "ERR_INVALID_COMMENT" }, "replies cannot have replies");
  await assert.rejects(post(store, ann, { text: "Lost", parentId: "missing-thread" }), { code: "ERR_COMMENT_NOT_FOUND", status: 404 });
  for (const place of [{ x: 1 }, { y: 1 }, { sceneId: "wide" }, { sceneId: "wide", time: 0 }])
    await assert.rejects(post(store, ann, { text: "Placed reply", parentId: thread.id, ...place }), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(store.updateComment("review", reply.id, { x: 5 }, as(ben)), { code: "ERR_INVALID_COMMENT" }, "a reply moves with its thread");
  await assert.rejects(store.updateComment("review", reply.id, { resolved: true }, as(ben)), { code: "ERR_INVALID_COMMENT" }, "threads resolve from their first comment");
  assert.equal((await store.updateComment("review", reply.id, { text: "Reply, edited" }, as(ben))).text, "Reply, edited");

  // Replying to a resolved thread keeps it resolved.
  await store.updateComment("review", thread.id, { resolved: true }, as(ben));
  await post(store, ben, { text: "After resolving", parentId: thread.id });
  assert.equal((await store.getProject("review")).comments.find((comment) => comment.id === thread.id).resolved, true);

  // A deleted thread cannot receive replies.
  await store.deleteComment("review", thread.id, as(ann));
  await assert.rejects(post(store, ben, { text: "Too late", parentId: thread.id }), { status: 404 });
});

test("a time anchor is seconds into its scene, within the scene's duration, to the millisecond", async (t) => {
  const { store } = await makeStore(t);
  assert.equal((await post(store, ann, { text: "Start", sceneId: "wide", time: 0 })).time, 0);
  assert.equal((await post(store, ann, { text: "End", sceneId: "wide", time: 4 })).time, 4);
  assert.equal((await post(store, ann, { text: "Rounded", sceneId: "wide", time: 1.23456 })).time, 1.235);
  assert.equal((await post(store, ann, { text: "Rounds to the end", sceneId: "wide", time: 4.0004 })).time, 4);
  for (const time of [-0.5, 4.01, Number.NaN, Number.POSITIVE_INFINITY, "1", null])
    await assert.rejects(post(store, ann, { text: "Bad time", sceneId: "wide", time }), { code: "ERR_INVALID_COMMENT" }, `time ${time}`);
  await assert.rejects(post(store, ann, { text: "No scene", time: 1 }), { code: "ERR_INVALID_COMMENT" }, "a time needs a scene");
  await assert.rejects(post(store, ann, { text: "Short scene", sceneId: "small", time: 2 }), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(post(store, ann, { text: "Missing scene", sceneId: "gone", time: 0 }), { code: "ERR_INVALID_COMMENT" });
  const untimed = await post(store, ann, { text: "Untimed", sceneId: "wide" });
  assert.equal(untimed.time, undefined, "time stays optional");
  assert.equal((await store.updateComment("review", untimed.id, { time: 2.0001 }, as(ben))).time, 2);
  await assert.rejects(store.updateComment("review", untimed.id, { time: 5 }, as(ben)), { code: "ERR_INVALID_COMMENT" });
  const floating = await post(store, ann, { text: "No scene at all" });
  await assert.rejects(store.updateComment("review", floating.id, { time: 1 }, as(ben)), { code: "ERR_INVALID_COMMENT" });
});

test("a time at the very end of a scene whose length is not a whole millisecond stays within the scene", async (t) => {
  const { store } = await makeStore(t);
  const duration = 32 / 30; // 1.0666… s: 32 frames at 30 fps
  await addScenes(store, [{ id: "odd", duration }]);
  const scene = (await store.getProject("review")).document.scenes.find((item) => item.id === "odd");
  assert.equal(scene.duration, duration);

  // The time cursor sits exactly at the end after playback; the editor sends anchorTime of it.
  const fromEditor = await post(store, ann, { text: "End frame", sceneId: "odd", time: anchorTime(duration, scene) });
  assert.equal(fromEditor.time, 1.066);
  const exact = await post(store, ann, { text: "End frame, exact", sceneId: "odd", time: duration });
  assert.equal(exact.time, 1.066, "a time that rounds past the end takes the millisecond before");
  assert.ok(exact.time <= duration);
  assert.equal((await post(store, ann, { text: "Just before", sceneId: "odd", time: 1.0664 })).time, 1.066);
  assert.equal((await post(store, ann, { text: "Halfway", sceneId: "odd", time: 0.5 })).time, 0.5);
  await assert.rejects(post(store, ann, { text: "Past the end", sceneId: "odd", time: 1.0669 }), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(post(store, ann, { text: "Rounded past the end", sceneId: "odd", time: 1.067 }), { code: "ERR_INVALID_COMMENT" });

  // Moving a thread to the end, on the same scene or from another one, follows the same rule.
  const untimed = await post(store, ann, { text: "Moves", sceneId: "wide", time: 3 });
  assert.equal((await store.updateComment("review", untimed.id, { sceneId: "odd", time: duration }, as(ben))).time, 1.066);
  assert.equal((await store.updateComment("review", untimed.id, { time: duration }, as(ben))).time, 1.066);
  assert.equal((await store.updateComment("review", untimed.id, { sceneId: "wide" }, as(ben))).time, 1.066, "the stored time fits a longer scene");
});

test("comments can sit on scenes whose IDs have dots or colons, as documents allow", async (t) => {
  const { store } = await makeStore(t);
  await addScenes(store, [{ id: "intro.scene" }, { id: "part:2" }]);
  const comment = await post(store, ann, { text: "On the intro", sceneId: "intro.scene", x: 10, y: 10, time: 0.5 });
  assert.equal(comment.sceneId, "intro.scene");
  const moved = await store.updateComment("review", comment.id, { sceneId: "part:2", time: 1 }, as(ben));
  assert.deepEqual([moved.sceneId, moved.time], ["part:2", 1]);
  for (const sceneId of ["has space", "slash/scene", "x".repeat(129), "", 7])
    await assert.rejects(post(store, ann, { text: "Bad scene ID", sceneId }), { code: "ERR_INVALID_COMMENT" }, String(sceneId));
});

test("moving a thread to another scene checks its point and time against that scene", async (t) => {
  const { store } = await makeStore(t);
  const comment = await post(store, ann, { text: "Pin", sceneId: "wide", x: 600, y: 300, time: 3 });
  await assert.rejects(store.updateComment("review", comment.id, { sceneId: "small" }, as(ben)), { code: "ERR_INVALID_COMMENT" }, "x, y, and time are too large for the small scene");
  await assert.rejects(store.updateComment("review", comment.id, { sceneId: "small", x: 50, y: 25 }, as(ben)), { code: "ERR_INVALID_COMMENT" }, "time is still too late");
  await assert.rejects(store.updateComment("review", comment.id, { sceneId: "gone", x: 1, y: 1, time: 0 }, as(ben)), { code: "ERR_INVALID_COMMENT" });
  const moved = await store.updateComment("review", comment.id, { sceneId: "small", x: 50, y: 25, time: 0.5 }, as(ben));
  assert.deepEqual([moved.sceneId, moved.x, moved.y, moved.time], ["small", 50, 25, 0.5]);
  await assert.rejects(store.updateComment("review", comment.id, { x: 101 }, as(ben)), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(store.updateComment("review", comment.id, { x: -1 }, as(ben)), { code: "ERR_INVALID_COMMENT" });

  // The scene shrinks after the comment was placed: the stored place is kept, and the thread can
  // still be resolved or moved along one axis without restating the rest.
  const project = await store.getProject("review");
  const document = structuredClone(project.document);
  document.scenes[1].width = 40;
  document.scenes[1].duration = 0.25;
  await store.updateProject("review", document, project.revision);
  assert.equal((await store.updateComment("review", comment.id, { resolved: true }, as(ben))).x, 50);
  assert.equal((await store.updateComment("review", comment.id, { y: 10 }, as(ben))).x, 50);
  await assert.rejects(store.updateComment("review", comment.id, { x: 45 }, as(ben)), { code: "ERR_INVALID_COMMENT" });

  // A comment whose scene was deleted stays in the list and can be moved to a scene that exists.
  const withoutSmall = structuredClone((await store.getProject("review")).document);
  withoutSmall.scenes = withoutSmall.scenes.filter((scene) => scene.id !== "small");
  await store.updateProject("review", withoutSmall, (await store.getProject("review")).revision);
  const orphaned = (await store.getProject("review")).comments.find((entry) => entry.id === comment.id);
  assert.equal(orphaned.sceneId, "small", "comments are not rewritten when their scene is deleted");
  await assert.rejects(store.updateComment("review", comment.id, { y: 5 }, as(ben)), { code: "ERR_INVALID_COMMENT" });
  assert.equal((await store.updateComment("review", comment.id, { resolved: false }, as(ben))).resolved, false);
  assert.equal((await store.updateComment("review", comment.id, { sceneId: "wide" }, as(ben))).sceneId, "wide");
});

test("comment writes move the project's updatedAt and are refused while the project is in the trash", async (t) => {
  const { store } = await makeStore(t);
  const stamps = [(await store.getProject("review")).updatedAt];
  const changed = async () => {
    const updatedAt = (await store.getProject("review")).updatedAt;
    assert.ok(updatedAt > stamps.at(-1), `${updatedAt} follows ${stamps.at(-1)}`);
    stamps.push(updatedAt);
    await tick();
  };
  await tick();
  const comment = await post(store, ann, { text: "One", sceneId: "wide" });
  await changed();
  await store.updateComment("review", comment.id, { text: "One, edited" }, as(ann));
  await changed();
  await store.updateComment("review", comment.id, { x: 3, y: 4 }, as(ben));
  await changed();
  await store.updateComment("review", comment.id, { resolved: true }, as(ben));
  await changed();
  const reply = await post(store, ben, { text: "Reply", parentId: comment.id });
  await changed();
  await store.deleteComment("review", reply.id, as(ben));
  await changed();

  await store.trashProject("review");
  await assert.rejects(post(store, ann, { text: "In the trash" }), { code: "ERR_PROJECT_TRASHED" });
  await assert.rejects(store.updateComment("review", comment.id, { resolved: false }, as(ann)), { code: "ERR_PROJECT_TRASHED" });
  await assert.rejects(store.deleteComment("review", comment.id), { code: "ERR_PROJECT_TRASHED" });
  await store.restoreProject("review");
  assert.equal((await store.getProject("review")).comments.length, 1);
});

test("mentions and the per-project comment limit are enforced", async (t) => {
  const { store, root } = await makeStore(t);
  const names = Array.from({ length: 21 }, (_, index) => `Person ${index}`);
  await assert.rejects(post(store, ann, { text: "Too many", mentions: names }), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(post(store, ann, { text: "Not a list", mentions: "Ben" }), { code: "ERR_INVALID_COMMENT" });
  await assert.rejects(post(store, ann, { text: "Control", mentions: ["Be\u0007n"] }), { code: "ERR_INVALID_COMMENT" });
  assert.deepEqual((await post(store, ann, { text: "Twenty", mentions: names.slice(0, 20) })).mentions, names.slice(0, 20));
  assert.equal((await post(store, ann, { text: "None", mentions: [] })).mentions, undefined);

  // Fill the project to the limit directly in store.json, then try once more.
  const file = path.join(root, "store.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  const createdAt = new Date().toISOString();
  state.projects[0].comments = Array.from({ length: MAX_COMMENTS_PER_PROJECT }, (_, index) => ({
    id: `c${index}`, text: "Filler", author: "Guest", createdAt, resolved: false,
  }));
  await writeFile(file, JSON.stringify(state));
  await assert.rejects(post(store, ann, { text: "One too many" }), { code: "ERR_COMMENT_LIMIT", status: 400 });
  await store.deleteComment("review", "c0");
  assert.ok(await post(store, ann, { text: "Room again" }));
});

test("stores saved before threads load, and their comments behave as before", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kino-comments-old-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, "data");
  await mkdir(root, { recursive: true });
  const now = "2026-01-01T00:00:00.000Z";
  await writeFile(path.join(root, "store.json"), JSON.stringify({
    version: 1,
    folders: [],
    projects: [{
      document: makeDocument("review"),
      revision: 3,
      folderId: null,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      comments: [
        { id: "old-1", text: "Pinned", author: "Reviewer", createdAt: now, resolved: false, x: 12, y: 8, sceneId: "wide" },
        { id: "old-2", text: "Flat", author: "Guest", createdAt: now, resolved: true },
      ],
    }],
  }));
  const store = await openStore(root);
  const project = await store.getProject("review");
  assert.deepEqual(project.comments.map((comment) => comment.id), ["old-1", "old-2"]);
  assert.equal(project.comments[0].x, 12);
  assert.equal((await store.updateComment("review", "old-2", { resolved: false }, as(ben))).resolved, false);
  assert.equal((await store.updateComment("review", "old-1", { time: 1 }, as(ben))).time, 1);
  const reply = await post(store, ann, { text: "Reply to an old comment", parentId: "old-1" });
  assert.equal(reply.parentId, "old-1");
  await assert.rejects(store.updateComment("review", "old-1", { text: "Edit" }, as(ann)), { status: 403 }, "old comments have no author key");
  await assert.rejects(store.deleteComment("review", "old-2", as(ann)), { status: 403 });
  assert.deepEqual(await store.deleteComment("review", "old-2"), { deleted: ["old-2"] }, "the owner deletes old comments");
});

test("stores with broken comment threads or authorship fields are reported as corrupt", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kino-comments-corrupt-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const now = "2026-01-01T00:00:00.000Z";
  const base = { id: "c1", text: "t", author: "Guest", createdAt: now, resolved: false };
  const cases = {
    "a reply without its thread": [{ ...base, parentId: "missing" }],
    "a reply to a reply": [base, { ...base, id: "c2", parentId: "c1" }, { ...base, id: "c3", parentId: "c2" }],
    "a malformed key hash": [{ ...base, authorId: "0123456789abcdef0123456789abcdef", authorKeyHash: "not-a-hash" }],
    "a negative time": [{ ...base, sceneId: "wide", time: -1 }],
    "mentions that are not names": [{ ...base, mentions: [3] }],
  };
  for (const [label, comments] of Object.entries(cases)) {
    const root = path.join(temporaryRoot, label.replace(/\W+/g, "-"));
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "store.json"), JSON.stringify({
      version: 1, folders: [],
      projects: [{ document: makeDocument("review"), revision: 1, folderId: null, createdAt: now, updatedAt: now, trashedAt: null, comments }],
    }));
    const store = await openStore(root);
    await assert.rejects(store.getProject("review"), { code: "ERR_CORRUPT_STORE" }, label);
  }
});

test("author key hashes stay in store.json and never leave the store", async (t) => {
  const { store, root } = await makeStore(t);
  const created = await post(store, ann, { text: "Private key", sceneId: "wide", x: 1, y: 1, time: 1 });
  const reply = await post(store, ben, { text: "Reply", parentId: created.id });
  const changed = await store.updateComment("review", created.id, { text: "Private key, edited" }, as(ann));
  const resolved = await store.resolveComment("review", created.id, true, as(ben));
  const project = await store.getProject("review");
  const saved = await store.updateProject("review", project.document, project.revision);
  let conflict;
  try {
    await store.updateProject("review", project.document, project.revision);
  } catch (error) {
    conflict = error;
  }
  const trashed = await store.trashProject("review");
  const restored = await store.restoreProject("review");
  const moved = await store.moveProject("review", null);

  for (const [label, value] of Object.entries({ created, reply, changed, resolved, project, saved, conflict: conflict.current, trashed, restored, moved }))
    assert.doesNotMatch(JSON.stringify(value), /authorKeyHash|a{64}|b{64}/, `${label} has no key or key hash`);
  assert.equal(created.authorId, ann.authorId, "the public author ID is returned");

  const disk = await readFile(path.join(root, "store.json"), "utf8");
  assert.ok(disk.includes(ann.keyHash) && disk.includes(ben.keyHash), "the hashes are stored");
  assert.ok(!disk.includes(ANN_KEY) && !disk.includes(BEN_KEY), "the keys themselves are never stored");
});
