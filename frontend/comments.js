// Comments in the editor: the browser's anonymous comment identity, threads built from the flat
// comment list, where a thread shows on a scene, and the requests that change comments.
//
// Data flow: the server keeps project.comments beside the document (backend/comments.mjs has the
// rules). useWorkspace.js receives the list when a project opens and again from every
// {type: "comments"} WebSocket message: the server sends one each time the session joins the
// file (including after a reconnect) and after anyone writes. The UI turns that list into threads
// with buildThreads() and changes comments only through postComment / patchComment / deleteComment
// below, never through the document's commit/undo.
import { api } from "./client.js";
import { getSetting, setSetting } from "./browserStorage.js";
import { sha256Hex } from "./sha256.js";

// The request header that carries this browser's private comment key. The server stores only a hash of it.
export const COMMENT_KEY_HEADER = "X-Kino-Comment-Key";
const IDENTITY_SETTING = "comment-identity";
const AUTHOR_KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function randomHex(byteCount, random) {
  const bytes = new Uint8Array(byteCount);
  random.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A new identity: {authorKey}, a private random key that proves to the server which comments
// this browser wrote. The comments' public author ID is worked out from it (authorIdForKey).
export function createCommentIdentity(random = globalThis.crypto) {
  return { authorKey: randomHex(32, random) };
}

function readIdentity(text) {
  try {
    const value = JSON.parse(text);
    // Identities saved by earlier builds also hold an authorId; only the key is used.
    if (typeof value?.authorKey === "string" && AUTHOR_KEY_PATTERN.test(value.authorKey))
      return { authorKey: value.authorKey };
  } catch {
    /* A missing or damaged setting gets a new identity. */
  }
  return null;
}

// Returns a function that gives this browser's comment identity. It is created once and kept in
// the editor's settings (browserStorage.js: localStorage, or the Mac app's settings files, see
// desktop/settings.mjs). When that storage is unavailable, the identity lasts until the page closes.
export function createIdentitySource({ storage, random = globalThis.crypto } = {}) {
  let inMemory = null;
  return function currentIdentity() {
    const stored = readIdentity(getSetting(IDENTITY_SETTING, storage));
    if (stored) return stored;
    inMemory ??= createCommentIdentity(random);
    setSetting(IDENTITY_SETTING, JSON.stringify(inMemory), storage);
    return inMemory;
  };
}

const commentIdentity = createIdentitySource();

// The public author ID that a comment key's comments carry in one project. The server works it out
// the same way (backend/comments.mjs authorIdForKeyHash): the first 32 hex characters of the SHA-256
// of the project's ID and the key's SHA-256. Nobody can post under it without the key, and the same
// browser has a different ID in each project, so its comments in different files can't be linked.
// The label below is fixed: it is part of every stored author ID (see authorIdForKeyHash in backend/comments.mjs).
export function authorIdForKey(projectId, authorKey) {
  return sha256Hex(`kino-comment-author\n${projectId}\n${sha256Hex(authorKey)}`).slice(0, 32);
}

// This browser's identity in one project, {authorId, authorKey}: what isMine and the can* helpers
// take. Without a project the authorId is null, so no comment counts as this browser's.
export function projectIdentity(projectId, identity = commentIdentity()) {
  const authorKey = identity?.authorKey ?? null;
  return { authorId: projectId && authorKey ? authorIdForKey(projectId, authorKey) : null, authorKey };
}

// True when this browser's identity wrote the comment. `identity` comes from projectIdentity().
export function isMine(comment, identity) {
  return Boolean(identity?.authorId && comment?.authorId && comment.authorId === identity.authorId);
}

// Only the author can edit the text; the server checks the key as well.
export function canEditCommentText(comment, identity, access) {
  return Boolean(access?.canComment) && isMine(comment, identity);
}

// The author or the file's owner can delete a comment.
export function canDeleteComment(comment, identity, access) {
  return Boolean(access?.canComment) && (isMine(comment, identity) || access.role === "owner");
}

// Anyone who can comment can move a thread or resolve it; replies follow their first comment.
export function canMoveComment(comment, access) {
  return Boolean(access?.canComment) && !comment?.parentId;
}

function byCreation(a, b) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Threads from the flat comment list: [{comment, replies}], oldest thread first, each thread's
// replies oldest first. The server never keeps a reply without its first comment; one that arrives
// anyway is left out, because it has no thread to show in.
export function buildThreads(comments = []) {
  const threads = new Map();
  for (const comment of comments) if (!comment.parentId) threads.set(comment.id, { comment, replies: [] });
  for (const comment of comments) if (comment.parentId) threads.get(comment.parentId)?.replies.push(comment);
  const list = [...threads.values()].sort((a, b) => byCreation(a.comment, b.comment));
  for (const thread of list) thread.replies.sort(byCreation);
  return list;
}

// The scene a thread sits on, or null when it has none or that scene was deleted.
// Such threads stay in the comment list and get no pin on the canvas.
export function commentScene(comment, document) {
  if (!comment?.sceneId) return null;
  return document?.scenes?.find((scene) => scene.id === comment.sceneId) ?? null;
}

// The Comments panel's filters, in the order the panel shows them. "open" is the default.
export const COMMENT_FILTERS = Object.freeze(["open", "resolved", "all"]);

// When a thread last had a new post: the createdAt of its newest comment or reply. Edits,
// resolving and moving do not count, so fixing a typo does not move a thread up the list.
export function threadActivity(thread) {
  let newest = thread?.comment?.createdAt ?? "";
  for (const reply of thread?.replies ?? []) if (reply.createdAt > newest) newest = reply.createdAt;
  return newest;
}

// True when a filter ("open", "resolved" or "all") lists the thread whose first comment is `comment`.
export function matchesFilter(comment, filter = "open") {
  return filter === "all" ? true : filter === "resolved" ? Boolean(comment?.resolved) : !comment?.resolved;
}

// The threads the Comments panel lists for a filter, the way a comment history reads: the thread
// with the newest post (its first comment or a reply) first. Filters are "open" (not resolved),
// "resolved", or "all". `keep` is the ID of the thread open in the panel: it stays listed even when
// someone else resolves or reopens it, so a reply or edit being typed in it is not thrown away.
export function filterThreads(threads = [], filter = "open", { keep = null } = {}) {
  const kept = threads.filter(({ comment }) => matchesFilter(comment, filter) || (keep !== null && comment.id === keep));
  return kept
    .map((thread) => ({ thread, activity: threadActivity(thread) }))
    .sort((a, b) => (a.activity < b.activity ? 1 : a.activity > b.activity ? -1 : byCreation(b.thread.comment, a.thread.comment)))
    .map(({ thread }) => thread);
}

// The threads with the open thread put back, marked {deleted: true}, when someone else deleted it
// while it was open. `lastSeen` is the open thread as the panel last showed it. The panel keeps
// showing it, with a note, until it is closed, so the reply being typed in it (and keyboard focus)
// is not lost. Otherwise the threads come back unchanged.
export function keepDeletedThread(threads = [], openId = null, lastSeen = null) {
  if (!openId || lastSeen?.comment?.id !== openId || threads.some(({ comment }) => comment.id === openId)) return threads;
  return [...threads, { ...lastSeen, deleted: true }];
}

// How many threads each filter lists: {open, resolved, all}.
export function threadCounts(threads = []) {
  const resolved = threads.filter(({ comment }) => comment.resolved).length;
  return { open: threads.length - resolved, resolved, all: threads.length };
}

// The letter on a comment's pin: the first character of the author's name, or "?".
export function authorInitial(author) {
  const first = Array.from(String(author ?? "").trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}

// The start of a comment's text for a pin's name: up to `limit` characters, cut at a word.
export function commentExcerpt(text, limit = 40) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// A time on the scene's timeline as the editor shows it: "1.25 s".
export function formatCommentTime(seconds) {
  return `${Number(seconds || 0).toFixed(2)} s`;
}

// A thread's time, or its range: "1.25 s" or "1.25-2.50 s".
export function formatCommentSpan(comment) {
  if (!Number.isFinite(comment?.timeEnd)) return formatCommentTime(comment?.time);
  return `${Number(comment.time || 0).toFixed(2)}-${Number(comment.timeEnd).toFixed(2)} s`;
}

// A comment's chips: the layer it is about (by name) and its time or range; "whole video" for a
// thread with no scene and no point. [] for an older thread that only has a point.
export function commentChips(comment, document) {
  if (!comment?.sceneId) return Number.isFinite(comment?.x) ? [] : ["whole video"];
  const scene = commentScene(comment, document);
  const layer = comment.layerId ? scene?.layers?.find((item) => item.id === comment.layerId) : null;
  return [comment.layerId ? layer?.name || comment.layerId : null, Number.isFinite(comment.timeEnd) ? formatCommentSpan(comment) : null].filter(Boolean);
}

// The time range to mark on the scrubber of `sceneId`: the new comment's while one is written,
// else the open thread's; null when neither has a range there. {from, to} in seconds.
export function scrubberRange({ draft, openId, threads = [] }, sceneId) {
  const source = draft ?? threads.find(({ comment }) => comment.id === openId)?.comment;
  if (!source || source.whole || source.sceneId !== sceneId || !Number.isFinite(source.timeEnd)) return null;
  return { from: source.time, to: source.timeEnd };
}

// The fields a new comment is posted with: its place (scene, point, time, layer, range), or none
// for the whole video.
export function draftPlace(draft) {
  if (!draft || draft.whole) return {};
  return Object.fromEntries(["sceneId", "x", "y", "time", "timeEnd", "layerId"].filter((key) => draft[key] !== undefined && draft[key] !== null).map((key) => [key, draft[key]]));
}

// What a screen reader says for a thread's pin: who wrote it, how it starts, the time it is
// tied to, and how many replies it has. `time` is the time shown (comments.js commentPlacement).
export function pinLabel(thread, time) {
  const { comment, replies = [] } = thread;
  const parts = [`Comment by ${comment.author || "Guest"}: “${commentExcerpt(comment.text)}”`];
  if (Number.isFinite(time)) parts.push(`at ${formatCommentTime(time)}`);
  if (replies.length) parts.push(`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`);
  return parts.join(", ");
}

// The comment list with `saved` (a comment the server returned) in it: replacing the comment
// with the same ID, or added at the end. The WebSocket brings the same list soon after; this
// shows the change without waiting for it.
export function mergeComment(comments = [], saved) {
  if (!saved?.id) return comments;
  const index = comments.findIndex((comment) => comment.id === saved.id);
  if (index < 0) return [...comments, saved];
  const next = [...comments];
  next[index] = saved;
  return next;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

// Where to draw a thread on its scene and timeline: {x?, y?, time?}. A scene that became smaller or
// shorter after the comment was placed shows it at the nearest edge; the stored values stay as
// they are, so the pin returns if the scene grows back.
export function commentPlacement(comment, scene) {
  const place = {};
  for (const [field, size] of [["x", scene?.width], ["y", scene?.height], ["time", scene?.duration]]) {
    const value = comment?.[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    place[field] = Number.isFinite(size) ? clamp(value, 0, size) : Math.max(0, value);
  }
  return place;
}

// The time a new comment is tied to: the time cursor, within the scene, to the millisecond. A
// scene's length need not be a whole number of milliseconds (32 frames at 30 fps is 1.0666… s), so
// the end could round past the end (1.067 s), which the server refuses; it takes the millisecond
// before instead (1.066 s), as the server does (backend/comments.mjs timeInScene).
export function anchorTime(time, scene) {
  const end = Number.isFinite(scene?.duration) ? scene.duration : 0;
  const value = Number.isFinite(time) ? clamp(time, 0, end) : 0;
  const milliseconds = Math.round(value * 1000);
  return milliseconds / 1000 <= end ? milliseconds / 1000 : (milliseconds - 1) / 1000;
}

function keyHeaders(identity) {
  return identity?.authorKey ? { [COMMENT_KEY_HEADER]: identity.authorKey } : {};
}

function commentsPath(projectId, commentId) {
  return `/projects/${encodeURIComponent(projectId)}/comments${commentId ? `/${encodeURIComponent(commentId)}` : ""}`;
}

// Posts a comment ({text, author?, mentions?, sceneId?, x?, y?, time?}) or, with parentId, a reply
// (without place fields: a reply shows where its thread is). Only the key is sent; the server sets
// the comment's authorId from it. Returns the saved comment.
export function postComment(projectId, input, { identity = commentIdentity(), request = api } = {}) {
  return request(commentsPath(projectId), {
    method: "POST",
    headers: keyHeaders(identity),
    body: input,
  });
}

// Changes a comment: {text?, mentions?} (its author only), {x?, y?, sceneId?, time?} (moves the
// thread), or {resolved}. Returns the saved comment.
export function patchComment(projectId, commentId, patch, { identity = commentIdentity(), request = api } = {}) {
  return request(commentsPath(projectId, commentId), {
    method: "PATCH",
    headers: keyHeaders(identity),
    body: patch,
  });
}

// Deletes a comment (a thread's first comment takes its replies). Returns {deleted: [IDs]}.
export function deleteComment(projectId, commentId, { identity = commentIdentity(), request = api } = {}) {
  return request(commentsPath(projectId, commentId), {
    method: "DELETE",
    headers: keyHeaders(identity),
  });
}
