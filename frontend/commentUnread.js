// Which comment threads this viewer has not read yet.
//
// kino has no accounts, so the server keeps no per-person state: what a viewer has read is
// kept in this browser's settings (browserStorage.js: localStorage, or the Mac app's settings
// file), one record per project:
//
//   { seen:   { threadId: milliseconds },   the newest post or edit time in the thread when this
//                                            viewer last had it open (server times, so a browser
//                                            clock that is off does not matter)
//     unread: [threadId, …] }                threads "Mark as unread" marked, until opened again
//
// A thread is unread when it is not resolved and either "Mark as unread" marked it, or it has a
// comment or reply that someone else wrote (comments.js isMine) after the viewer last opened it.
// A thread that was never opened in this browser counts every comment by someone else, so on a
// first visit everything others wrote is unread. A comment that mentions the viewer's display
// name (mentions.js) also counts again when it is edited after the viewer last opened it, since
// the edit may be what added the mention.
import { getSetting, setSetting } from "./browserStorage.js";
import { isMine } from "./comments.js";
import { mentionsName } from "./mentions.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const EMPTY_READS = Object.freeze({ seen: Object.freeze({}), unread: Object.freeze([]) });

// The setting that holds a project's read record.
export function readsSetting(projectId) {
  return `comment-reads-${projectId}`;
}

// A read record from its saved JSON. Anything missing or damaged reads as nothing read yet.
export function parseReads(text) {
  try {
    const value = JSON.parse(text);
    const seen = {};
    if (value?.seen && typeof value.seen === "object" && !Array.isArray(value.seen))
      for (const [id, time] of Object.entries(value.seen))
        if (ID_PATTERN.test(id) && Number.isFinite(time)) seen[id] = time;
    const unread = Array.isArray(value?.unread) ? [...new Set(value.unread.filter((id) => typeof id === "string" && ID_PATTERN.test(id)))] : [];
    return { seen, unread };
  } catch {
    return { seen: {}, unread: [] };
  }
}

export function loadReads(projectId, storage) {
  if (!projectId) return { seen: {}, unread: [] };
  return parseReads(getSetting(readsSetting(projectId), storage));
}

// Returns false when the browser's storage is unavailable (the record then lasts until the page closes).
export function saveReads(projectId, reads, storage) {
  if (!projectId) return false;
  return setSetting(readsSetting(projectId), JSON.stringify({ seen: reads.seen, unread: reads.unread }), storage);
}

function milliseconds(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function threadComments(thread) {
  return thread?.comment ? [thread.comment, ...(thread.replies ?? [])] : [];
}

// The newest server time in a thread, counting posts and edits. Opening the thread records it.
export function threadSeenTime(thread) {
  let newest = 0;
  for (const comment of threadComments(thread))
    newest = Math.max(newest, milliseconds(comment.createdAt), milliseconds(comment.editedAt));
  return newest;
}

// When a comment last asked for the viewer's attention: when it was posted, or for a comment that
// mentions the viewer, also when it was last edited. `viewer` is {identity, name}.
export function attentionTime(comment, viewer) {
  const posted = milliseconds(comment?.createdAt);
  return mentionsName(comment, viewer?.name) ? Math.max(posted, milliseconds(comment.editedAt)) : posted;
}

// True when a comment someone else wrote mentions the viewer's display name.
export function mentionsViewer(comment, viewer) {
  return !isMine(comment, viewer?.identity) && mentionsName(comment, viewer?.name);
}

export function threadMentionsViewer(thread, viewer) {
  return threadComments(thread).some((comment) => mentionsViewer(comment, viewer));
}

export function isThreadUnread(thread, reads = EMPTY_READS, viewer = {}) {
  const root = thread?.comment;
  if (!root || root.resolved) return false;
  if (reads.unread.includes(root.id)) return true;
  const seen = reads.seen[root.id] ?? -Infinity;
  return threadComments(thread).some((comment) => !isMine(comment, viewer.identity) && attentionTime(comment, viewer) > seen);
}

// The IDs of the unread threads (their first comments' IDs).
export function unreadThreadIds(threads = [], reads = EMPTY_READS, viewer = {}) {
  return new Set(threads.filter((thread) => isThreadUnread(thread, reads, viewer)).map((thread) => thread.comment.id));
}

// The thread the viewer is reading now, which is kept read while new posts arrive in it: the
// thread open in the panel (`openId`), but only while comment mode shows the panel (`showing`),
// the panel lists that thread (`listed`, from comments.js filterThreads) and the page is visible
// (`pageVisible`: not a background tab or a minimized window). Otherwise null. A thread someone
// else deleted while it was open (comments.js keepDeletedThread) is never read: it has no record.
export function threadOnScreen(listed = [], openId, { showing = true, pageVisible = true } = {}) {
  if (!showing || !pageVisible || !openId) return null;
  const thread = listed.find((entry) => entry.comment.id === openId);
  return thread && !thread.deleted ? thread : null;
}

// The record after the viewer opened `thread`. The same record comes back when nothing changed.
export function markThreadRead(reads, thread) {
  const id = thread?.comment?.id;
  if (!id) return reads;
  const time = threadSeenTime(thread);
  if (reads.seen[id] === time && !reads.unread.includes(id)) return reads;
  return { seen: { ...reads.seen, [id]: time }, unread: reads.unread.filter((entry) => entry !== id) };
}

// The record after "Mark as unread" on a thread. It stays unread until it is opened again.
export function markThreadUnread(reads, threadId) {
  if (!threadId || reads.unread.includes(threadId)) return reads;
  return { seen: reads.seen, unread: [...reads.unread, threadId] };
}

// The record without threads that no longer exist, so it does not grow forever.
export function pruneReads(reads, threads = []) {
  const ids = new Set(threads.map((thread) => thread.comment.id));
  const seen = Object.fromEntries(Object.entries(reads.seen).filter(([id]) => ids.has(id)));
  return { seen, unread: reads.unread.filter((id) => ids.has(id)) };
}
