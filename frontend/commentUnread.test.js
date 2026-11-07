import test from "node:test";
import assert from "node:assert/strict";
import { buildThreads, filterThreads } from "./comments.js";
import {
  EMPTY_READS,
  isThreadUnread,
  loadReads,
  markThreadRead,
  markThreadUnread,
  mentionsViewer,
  parseReads,
  pruneReads,
  readsSetting,
  saveReads,
  threadMentionsViewer,
  threadOnScreen,
  threadSeenTime,
  unreadThreadIds,
} from "./commentUnread.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const me = { identity: { authorId: "a".repeat(32), authorKey: "k".repeat(64) }, name: "Ana" };
const other = "b".repeat(32);
const at = (minute) => `2026-10-15T10:${String(minute).padStart(2, "0")}:00.000Z`;

function comment(id, minute, fields = {}) {
  return { id, text: "Note", author: "Bo", authorId: other, createdAt: at(minute), sceneId: "s", x: 0, y: 0, ...fields };
}

test("damaged or missing read records read as nothing read yet", () => {
  assert.deepEqual(parseReads(null), { seen: {}, unread: [] });
  assert.deepEqual(parseReads("not json"), { seen: {}, unread: [] });
  assert.deepEqual(parseReads('{"seen":[1,2],"unread":"x"}'), { seen: {}, unread: [] });
  assert.deepEqual(
    parseReads(JSON.stringify({ seen: { good: 5, "bad id!": 3, nan: "x" }, unread: ["good", "good", 7, "bad id!", "two"] })),
    { seen: { good: 5 }, unread: ["good", "two"] },
  );
});

test("threads by others are unread until opened; the viewer's own and resolved threads are not", () => {
  const threads = buildThreads([
    comment("theirs", 1),
    comment("mine", 2, { authorId: me.identity.authorId, author: "Ana" }),
    comment("resolved", 3, { resolved: true }),
    // A comment saved before identities existed has no authorId: it is someone else's.
    comment("legacy", 4, { authorId: undefined }),
  ]);
  assert.deepEqual([...unreadThreadIds(threads, EMPTY_READS, me)].sort(), ["legacy", "theirs"]);
  // Without an identity every comment is someone else's.
  assert.equal(isThreadUnread(threads.find((thread) => thread.comment.id === "mine"), EMPTY_READS, {}), true);
});

test("opening a thread reads it, and a later reply by someone else makes it unread again", () => {
  let comments = [comment("root", 1, { authorId: me.identity.authorId })];
  comments.push(comment("r1", 2, { parentId: "root" }));
  let [thread] = buildThreads(comments);
  assert.equal(isThreadUnread(thread, EMPTY_READS, me), true);
  const reads = markThreadRead(EMPTY_READS, thread);
  assert.equal(reads.seen.root, Date.parse(at(2)));
  assert.equal(isThreadUnread(thread, reads, me), false);
  // Opening it again changes nothing: the same record comes back.
  assert.equal(markThreadRead(reads, thread), reads);

  // The viewer's own reply does not make it unread.
  comments = [...comments, comment("r2", 3, { parentId: "root", authorId: me.identity.authorId })];
  [thread] = buildThreads(comments);
  assert.equal(isThreadUnread(thread, reads, me), false);
  // A reply by someone else does.
  comments = [...comments, comment("r3", 4, { parentId: "root" })];
  [thread] = buildThreads(comments);
  assert.equal(isThreadUnread(thread, reads, me), true);
  // Resolving the thread takes it out of the unread count.
  [thread] = buildThreads(comments.map((entry) => (entry.id === "root" ? { ...entry, resolved: true } : entry)));
  assert.equal(isThreadUnread(thread, reads, me), false);
});

test("an edit counts again only when the comment mentions the viewer", () => {
  const plainEdit = comment("plain", 1, { editedAt: at(5) });
  const [plainThread] = buildThreads([plainEdit]);
  const read = { seen: { plain: Date.parse(at(1)) }, unread: [] };
  assert.equal(isThreadUnread(plainThread, read, me), false);

  const mention = comment("mention", 1, { text: "Over to @Ana", mentions: ["Ana"], editedAt: at(5) });
  const [mentionThread] = buildThreads([mention]);
  assert.equal(isThreadUnread(mentionThread, { seen: { mention: Date.parse(at(1)) }, unread: [] }, me), true);
  // Opened after the edit: read.
  assert.equal(isThreadUnread(mentionThread, markThreadRead(EMPTY_READS, mentionThread), me), false);
  assert.equal(threadSeenTime(mentionThread), Date.parse(at(5)));
});

test("Mark as unread keeps a thread unread until it is opened again", () => {
  const [thread] = buildThreads([comment("root", 1)]);
  const read = markThreadRead(EMPTY_READS, thread);
  assert.equal(isThreadUnread(thread, read, me), false);
  const marked = markThreadUnread(read, "root");
  assert.deepEqual(marked.unread, ["root"]);
  assert.equal(markThreadUnread(marked, "root"), marked);
  assert.equal(isThreadUnread(thread, marked, me), true);
  // Even a thread with only the viewer's own comments.
  const [own] = buildThreads([comment("own", 1, { authorId: me.identity.authorId })]);
  assert.equal(isThreadUnread(own, markThreadUnread(EMPTY_READS, "own"), me), true);
  // Opening it clears the mark.
  const reopened = markThreadRead(marked, thread);
  assert.deepEqual(reopened.unread, []);
  assert.equal(isThreadUnread(thread, reopened, me), false);
});

test("Mentions you: a comment by someone else whose text and list both name the viewer", () => {
  const theirs = comment("c1", 1, { text: "Thanks @ana", mentions: ["Ana"] });
  assert.equal(mentionsViewer(theirs, me), true);
  assert.equal(mentionsViewer({ ...theirs, authorId: me.identity.authorId }, me), false);
  assert.equal(mentionsViewer(theirs, { ...me, name: "" }), false);
  assert.equal(mentionsViewer(theirs, { ...me, name: "Bo" }), false);
  const [thread] = buildThreads([comment("root", 0), { ...theirs, parentId: "root" }]);
  assert.equal(threadMentionsViewer(thread, me), true);
});

test("records drop deleted threads and are saved per project in the browser's settings", () => {
  const threads = buildThreads([comment("keep", 1)]);
  const reads = { seen: { keep: 1, gone: 2 }, unread: ["gone", "keep"] };
  assert.deepEqual(pruneReads(reads, threads), { seen: { keep: 1 }, unread: ["keep"] });

  const storage = memoryStorage();
  assert.equal(saveReads("project-1", { seen: { keep: 1 }, unread: ["keep"] }, storage), true);
  assert.equal(storage.values.get(`kino-${readsSetting("project-1")}`), '{"seen":{"keep":1},"unread":["keep"]}');
  assert.deepEqual(loadReads("project-1", storage), { seen: { keep: 1 }, unread: ["keep"] });
  assert.deepEqual(loadReads("project-2", storage), { seen: {}, unread: [] });
  assert.deepEqual(loadReads(null, storage), { seen: {}, unread: [] });
  assert.equal(saveReads(null, reads, storage), false);

  // Storage that throws (blocked site data) does not break the editor.
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(loadReads("project-1", broken), { seen: {}, unread: [] });
  assert.equal(saveReads("project-1", reads, broken), false);
});

test("only the open thread the panel lists on a visible page is read as posts arrive", () => {
  // Review finding: thread "two" was open, then the viewer chose the Resolved filter. The panel
  // showed "No resolved comments.", yet each new reply in "two" was marked read.
  const before = buildThreads([comment("one", 1), comment("two", 2)]);
  let reads = markThreadRead(EMPTY_READS, before[1]);
  const after = buildThreads([comment("one", 1), comment("two", 2), comment("reply", 3, { parentId: "two" })]);
  const two = after.find((thread) => thread.comment.id === "two");

  const resolvedList = filterThreads(after, "resolved");
  assert.equal(threadOnScreen(resolvedList, "two"), null, "the Resolved list does not show it");
  assert.equal(isThreadUnread(two, reads, me), true, "so the reply stays unread");

  const openList = filterThreads(after, "open", { keep: "two" });
  assert.equal(threadOnScreen(openList, "two"), two);
  assert.equal(threadOnScreen(openList, "two", { showing: false }), null, "comment mode is off");
  assert.equal(threadOnScreen(openList, "two", { pageVisible: false }), null, "a background tab or a minimized window");
  assert.equal(threadOnScreen(openList, null), null);
  assert.equal(threadOnScreen(openList, "gone"), null);
  // A thread someone else deleted while it was open stays on screen until it is closed; it is never read.
  assert.equal(threadOnScreen([{ ...two, deleted: true }], "two"), null);
  reads = markThreadRead(reads, threadOnScreen(openList, "two"));
  assert.equal(isThreadUnread(two, reads, me), false);
});
