import test from "node:test";
import assert from "node:assert/strict";
import { authorIdForKeyHash, commentKeyHash } from "../backend/comments.mjs";
import {
  COMMENT_FILTERS,
  anchorTime,
  authorIdForKey,
  authorInitial,
  buildThreads,
  commentChips,
  draftPlace,
  scrubberRange,
  canDeleteComment,
  canEditCommentText,
  canMoveComment,
  commentPlacement,
  commentExcerpt,
  createCommentIdentity,
  createIdentitySource,
  filterThreads,
  formatCommentTime,
  isMine,
  keepDeletedThread,
  matchesFilter,
  mergeComment,
  pinLabel,
  projectIdentity,
  threadActivity,
  threadCounts,
} from "./comments.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

// Deterministic bytes, so tests can tell identities apart.
function countingRandom() {
  let next = 0;
  return { getRandomValues: (bytes) => { for (let index = 0; index < bytes.length; index += 1) bytes[index] = next++ % 256; return bytes; } };
}

const identity = { authorId: "a1b2c3d4e5f60718", authorKey: "k".repeat(64) };
const owner = { role: "owner", canComment: true };
const guest = { role: "comment", canComment: true };
const viewer = { role: "view", canComment: false };

test("a comment identity is a private random hex key from crypto.getRandomValues", () => {
  const made = createCommentIdentity(countingRandom());
  assert.deepEqual(Object.keys(made), ["authorKey"], "the browser never picks its own author ID");
  assert.match(made.authorKey, /^[0-9a-f]{64}$/);
  const real = createCommentIdentity();
  assert.match(real.authorKey, /^[0-9a-f]{64}$/);
  assert.notEqual(real.authorKey, createCommentIdentity().authorKey);
});

test("the identity is kept in the editor's settings and reused", () => {
  const storage = memoryStorage();
  const current = createIdentitySource({ storage, random: countingRandom() });
  const first = current();
  assert.deepEqual(JSON.parse(storage.values.get("kino-comment-identity")), first);
  assert.deepEqual(current(), first);
  // Another tab (another source over the same storage) sees the same identity.
  assert.deepEqual(createIdentitySource({ storage, random: countingRandom() })(), first);
  // An identity saved by an earlier build also held an authorId; its key is kept.
  const older = memoryStorage({ "kino-comment-identity": JSON.stringify({ authorId: "a1b2c3d4e5f60718", authorKey: "k".repeat(64) }) });
  assert.deepEqual(createIdentitySource({ storage: older, random: countingRandom() })(), { authorKey: "k".repeat(64) });
});

test("a damaged stored identity is replaced, and unavailable storage keeps one in memory", () => {
  for (const damaged of ["not json", JSON.stringify({ authorId: "x", authorKey: "y" }), JSON.stringify({ authorKey: 5 }), "null"]) {
    const storage = memoryStorage({ "kino-comment-identity": damaged });
    const made = createIdentitySource({ storage, random: countingRandom() })();
    assert.match(made.authorKey, /^[0-9a-f]{64}$/, damaged);
    assert.deepEqual(JSON.parse(storage.values.get("kino-comment-identity")), made);
  }
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  const current = createIdentitySource({ storage: broken, random: countingRandom() });
  const first = current();
  assert.match(first.authorKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(current(), first, "the same identity for the rest of the page's life");
  const full = { getItem: () => null, setItem() { throw new Error("quota"); }, removeItem() {} };
  const fullSource = createIdentitySource({ storage: full, random: countingRandom() });
  assert.deepEqual(fullSource(), fullSource(), "storage that cannot save still gives one identity");
});

test("the browser works out its author ID in each project the same way the server does", () => {
  for (const [projectId, key] of [["review", "k".repeat(64)], ["review", "0123456789abcdef".repeat(4)], ["other_file-2", "Ab-_".repeat(10)]])
    assert.equal(authorIdForKey(projectId, key), authorIdForKeyHash(projectId, commentKeyHash(key)), `${projectId} ${key}`);
  const key = "k".repeat(64);
  assert.match(authorIdForKey("review", key), /^[0-9a-f]{32}$/);
  assert.notEqual(authorIdForKey("review", key), authorIdForKey("other", key), "each project has its own ID");
  assert.notEqual(authorIdForKey("review", key), authorIdForKey("review", "j".repeat(64)));

  const browser = { authorKey: key };
  assert.deepEqual(projectIdentity("review", browser), { authorId: authorIdForKey("review", key), authorKey: key });
  assert.deepEqual(projectIdentity(undefined, browser), { authorId: null, authorKey: key }, "no project, no author ID");
  const saved = { id: "c", authorId: authorIdForKeyHash("review", commentKeyHash(key)) };
  assert.equal(isMine(saved, projectIdentity("review", browser)), true, "a comment the server saved is recognized as mine");
  assert.equal(isMine(saved, projectIdentity("other", browser)), false);
  assert.equal(isMine(saved, projectIdentity(undefined, browser)), false);
});

test("isMine and the permission helpers follow the server's rules", () => {
  const mine = { id: "1", authorId: identity.authorId };
  const theirs = { id: "2", authorId: "someone-else" };
  const old = { id: "3" };
  const reply = { id: "4", parentId: "1", authorId: identity.authorId };
  assert.equal(isMine(mine, identity), true);
  assert.equal(isMine(theirs, identity), false);
  assert.equal(isMine(old, identity), false, "comments without an author ID belong to nobody");
  assert.equal(isMine(old, { authorId: undefined }), false);
  assert.equal(isMine(mine, null), false);

  assert.equal(canEditCommentText(mine, identity, guest), true);
  assert.equal(canEditCommentText(mine, identity, viewer), false);
  assert.equal(canEditCommentText(theirs, identity, owner), false, "the owner cannot edit others' text");
  assert.equal(canDeleteComment(theirs, identity, owner), true, "the owner moderates");
  assert.equal(canDeleteComment(old, identity, owner), true);
  assert.equal(canDeleteComment(theirs, identity, guest), false);
  assert.equal(canDeleteComment(mine, identity, guest), true);
  assert.equal(canDeleteComment(mine, identity, viewer), false);
  assert.equal(canMoveComment(theirs, guest), true);
  assert.equal(canMoveComment(reply, guest), false, "replies move with their thread");
  assert.equal(canMoveComment(theirs, viewer), false);
});

test("a pin on a scene that shrank shows at the nearest edge without changing the comment", () => {
  const comment = { x: 600, y: 300, time: 3.5 };
  const scene = { width: 100, height: 50, duration: 1 };
  assert.deepEqual(commentPlacement(comment, scene), { x: 100, y: 50, time: 1 });
  assert.deepEqual(comment, { x: 600, y: 300, time: 3.5 }, "the stored values stay");
  assert.deepEqual(commentPlacement({ x: 20, y: 10, time: 0.25 }, scene), { x: 20, y: 10, time: 0.25 });
  assert.deepEqual(commentPlacement({ x: 20 }, scene), { x: 20 }, "missing fields stay missing");
  assert.deepEqual(commentPlacement({ x: 20, time: 2 }, null), { x: 20, time: 2 });
  assert.deepEqual(commentPlacement({ x: Number.NaN }, scene), {});
});

test("a new comment's time is the time cursor within the scene, to the millisecond", () => {
  const scene = { duration: 4 };
  assert.equal(anchorTime(1.23456, scene), 1.235);
  assert.equal(anchorTime(9, scene), 4);
  assert.equal(anchorTime(-1, scene), 0);
  assert.equal(anchorTime(Number.NaN, scene), 0);
  assert.equal(anchorTime(2, null), 0);

  // Review finding: the time cursor sits exactly at the end after playback. 32 frames at 30 fps
  // is 1.0666… s, which rounds to 1.067 s, past the end; the last millisecond inside is 1.066 s.
  const odd = { duration: 32 / 30 };
  assert.equal(anchorTime(odd.duration, odd), 1.066);
  assert.equal(anchorTime(5, odd), 1.066);
  assert.equal(anchorTime(1.0664, odd), 1.066);
  assert.equal(anchorTime(1.005, { duration: 1.005 }), 1.005, "an end on a whole millisecond is kept");
  // Every end of a frame-based scene length stays inside the scene and on a whole millisecond.
  for (const fps of [24, 25, 30, 60, 23.976])
    for (let frames = 1; frames <= 600; frames += 1) {
      const duration = frames / fps;
      const time = anchorTime(duration, { duration });
      assert.ok(time <= duration && duration - time < 0.001, `${frames} frames at ${fps} fps: ${time} for ${duration}`);
      assert.equal(time, Math.round(time * 1000) / 1000);
    }
});

test("the Comments panel lists open threads by default, newest first, and counts each filter", () => {
  const threads = buildThreads([
    { id: "a", createdAt: "2026-10-15T10:00:00.000Z", resolved: false },
    { id: "b", createdAt: "2026-10-15T10:01:00.000Z", resolved: true },
    { id: "c", createdAt: "2026-10-15T10:02:00.000Z", resolved: false },
  ]);
  assert.deepEqual(COMMENT_FILTERS, ["open", "resolved", "all"]);
  assert.deepEqual(filterThreads(threads).map((thread) => thread.comment.id), ["c", "a"]);
  assert.deepEqual(filterThreads(threads, "resolved").map((thread) => thread.comment.id), ["b"]);
  assert.deepEqual(filterThreads(threads, "all").map((thread) => thread.comment.id), ["c", "b", "a"]);
  assert.deepEqual(threads.map((thread) => thread.comment.id), ["a", "b", "c"], "the threads themselves keep their order");
  assert.deepEqual(threadCounts(threads), { open: 2, resolved: 1, all: 3 });
  assert.deepEqual(threadCounts([]), { open: 0, resolved: 0, all: 0 });
});

test("a pin shows the author's initial and is named by author, first words, time and replies", () => {
  assert.equal(authorInitial("ana"), "A");
  assert.equal(authorInitial("  Émile "), "É");
  assert.equal(authorInitial("\u{1F600} smile"), "\u{1F600}", "a character outside the basic plane stays whole");
  assert.equal(authorInitial(""), "?");
  assert.equal(authorInitial(undefined), "?");

  assert.equal(commentExcerpt("Short"), "Short");
  assert.equal(commentExcerpt("  Make   the\nlogo bigger  "), "Make the logo bigger");
  assert.equal(commentExcerpt("Move the title a little to the left so it lines up with the logo"), "Move the title a little to the left so…");
  assert.equal(commentExcerpt("x".repeat(50)), `${"x".repeat(40)}…`, "a long word is cut where the limit is");

  assert.equal(formatCommentTime(1.235), "1.24 s");
  assert.equal(formatCommentTime(undefined), "0.00 s");

  const thread = { comment: { author: "Ana", text: "Make the logo bigger" }, replies: [{}, {}] };
  assert.equal(pinLabel(thread, 1.5), "Comment by Ana: “Make the logo bigger”, at 1.50 s, 2 replies");
  assert.equal(pinLabel({ comment: { text: "Hi" }, replies: [{}] }, undefined), "Comment by Guest: “Hi”, 1 reply");
  assert.equal(pinLabel({ comment: { author: "Bo", text: "Hi" }, replies: [] }, 0), "Comment by Bo: “Hi”, at 0.00 s");
});

test("a comment the server returned replaces its old copy or joins the list", () => {
  const list = [{ id: "a", x: 1 }, { id: "b", x: 2 }];
  assert.deepEqual(mergeComment(list, { id: "b", x: 5 }), [{ id: "a", x: 1 }, { id: "b", x: 5 }]);
  assert.deepEqual(mergeComment(list, { id: "c", x: 3 }).map((comment) => comment.id), ["a", "b", "c"]);
  assert.deepEqual(list, [{ id: "a", x: 1 }, { id: "b", x: 2 }], "the old list is not changed");
  assert.equal(mergeComment(list, null), list);
  assert.deepEqual(mergeComment(undefined, { id: "a" }), [{ id: "a" }]);
});

test("the panel lists the thread with the newest post first, counting replies but not edits", () => {
  const comments = [
    { id: "a", text: "Old thread", createdAt: "2026-10-15T10:00:00.000Z" },
    { id: "b", text: "Newer thread", createdAt: "2026-10-15T10:05:00.000Z", editedAt: "2026-10-15T11:00:00.000Z" },
    { id: "a1", parentId: "a", text: "Late reply", createdAt: "2026-10-15T10:10:00.000Z" },
    { id: "c", text: "Resolved", resolved: true, createdAt: "2026-10-15T10:01:00.000Z" },
  ];
  const threads = buildThreads(comments);
  assert.equal(threadActivity(threads.find((thread) => thread.comment.id === "a")), "2026-10-15T10:10:00.000Z");
  assert.equal(threadActivity(threads.find((thread) => thread.comment.id === "b")), "2026-10-15T10:05:00.000Z");
  assert.equal(threadActivity(undefined), "");
  // The reply moves thread "a" above "b"; b's later edit does not move it.
  assert.deepEqual(filterThreads(threads).map((thread) => thread.comment.id), ["a", "b"]);
  assert.deepEqual(filterThreads(threads, "all").map((thread) => thread.comment.id), ["a", "b", "c"]);
  assert.deepEqual(filterThreads(threads, "resolved").map((thread) => thread.comment.id), ["c"]);
  // Each thread keeps its replies in order.
  assert.deepEqual(filterThreads(threads)[0].replies.map((reply) => reply.id), ["a1"]);
});

test("the open thread stays listed when someone else resolves or reopens it, at its usual place", () => {
  // Review finding: another session resolved the thread open under the Open filter, the thread
  // left the list, and the reply being typed in it was thrown away.
  const threads = buildThreads([
    { id: "a", createdAt: "2026-10-15T10:00:00.000Z", resolved: false },
    { id: "b", createdAt: "2026-10-15T10:01:00.000Z", resolved: true },
    { id: "c", createdAt: "2026-10-15T10:02:00.000Z", resolved: false },
  ]);
  assert.equal(matchesFilter(threads[1].comment, "open"), false);
  assert.equal(matchesFilter(threads[1].comment, "resolved"), true);
  assert.equal(matchesFilter(threads[0].comment, "all"), true);
  assert.deepEqual(filterThreads(threads, "open", { keep: "b" }).map((thread) => thread.comment.id), ["c", "b", "a"]);
  assert.deepEqual(filterThreads(threads, "resolved", { keep: "a" }).map((thread) => thread.comment.id), ["b", "a"]);
  // A thread that matches anyway, no open thread, or one that was deleted changes nothing.
  assert.deepEqual(filterThreads(threads, "open", { keep: "c" }).map((thread) => thread.comment.id), ["c", "a"]);
  assert.deepEqual(filterThreads(threads, "open", { keep: null }).map((thread) => thread.comment.id), ["c", "a"]);
  assert.deepEqual(filterThreads(threads, "open", { keep: "gone" }).map((thread) => thread.comment.id), ["c", "a"]);
});

test("the open thread someone else deleted stays listed, marked deleted, until it is closed", () => {
  // Review finding: deleting the open thread in another session removed the reply box being typed
  // in, and the next letters reached the editor's shortcuts.
  const before = buildThreads([
    { id: "a", createdAt: "2026-10-15T10:00:00.000Z", resolved: false },
    { id: "b", createdAt: "2026-10-15T10:01:00.000Z", resolved: false },
    { id: "b1", parentId: "b", createdAt: "2026-10-15T10:03:00.000Z", resolved: false },
  ]);
  const lastSeen = before.find((thread) => thread.comment.id === "b");
  const after = buildThreads([{ id: "a", createdAt: "2026-10-15T10:00:00.000Z", resolved: false }]);

  const kept = keepDeletedThread(after, "b", lastSeen);
  assert.deepEqual(kept.map((thread) => [thread.comment.id, Boolean(thread.deleted)]), [["a", false], ["b", true]]);
  assert.deepEqual(kept[1].replies.map((reply) => reply.id), ["b1"], "it shows as last seen");
  assert.deepEqual(filterThreads(kept, "open", { keep: "b" }).map((thread) => thread.comment.id), ["b", "a"]);
  // Nothing changes while the thread exists, once it is closed, or for a snapshot of another thread.
  assert.equal(keepDeletedThread(before, "b", lastSeen), before);
  assert.equal(keepDeletedThread(after, null, lastSeen), after);
  assert.equal(keepDeletedThread(after, "a", lastSeen), after);
  assert.equal(keepDeletedThread(after, "b", null), after);
});

test("a thread's chips name its layer and range; the new comment posts its place, or none for the whole video", () => {
  const doc = { scenes: [{ id: "s1", name: "Intro", layers: [{ id: "logo", name: "Logo" }] }] };
  const pinned = { id: "c1", sceneId: "s1", x: 5, y: 5, time: 0.5, timeEnd: 1.25, layerId: "logo" };
  assert.deepEqual(commentChips(pinned, doc), ["Logo", "0.50-1.25 s"]);
  assert.deepEqual(commentChips({ sceneId: "s1", time: 1 }, doc), []);
  assert.deepEqual(commentChips({ text: "Music" }, doc), ["whole video"]);
  assert.deepEqual(commentChips({ x: 1, y: 1 }, doc), [], "an old pin without a scene is not the whole video");
  assert.deepEqual(scrubberRange({ draft: null, openId: "c1", threads: [{ comment: pinned }] }, "s1"), { from: 0.5, to: 1.25 });
  assert.equal(scrubberRange({ draft: { ...pinned, whole: true } }, "s1"), null);
  assert.equal(scrubberRange({ draft: pinned }, "s2"), null);
  assert.deepEqual(draftPlace({ ...pinned, timeEnd: undefined, layerId: null }), { sceneId: "s1", x: 5, y: 5, time: 0.5 });
  assert.deepEqual(draftPlace({ ...pinned, whole: true }), {});
});
