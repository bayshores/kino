// The server's rules for comments.
//
// Comments are stored beside a project's document (project.comments in store.json), not inside
// it, so they are never part of the document's undo history. store.mjs reads and writes them;
// this module decides what a new comment or a change may contain and who may make it.
//
// A stored comment:
//   { id, text, author, createdAt, resolved,   every comment (stores from before threads have only these, plus x/y/sceneId)
//     x?, y?, sceneId?, time?,                 where and when the thread sits: canvas point, scene, seconds into the scene
//     parentId?,                               set on a reply: the id of its thread's first comment
//     authorId?, authorKeyHash?,               anonymous authorship (below)
//     editedAt?, mentions? }                   when the text last changed; display names typed after @
//
// A thread is a first comment (a "root", no parentId) and its replies. Replies cannot have replies,
// and they have no place of their own: they show wherever their root is.
//
// Authorship without accounts: each browser keeps a random private comment key (frontend/comments.js).
// It arrives in the X-Kino-Comment-Key header, and only its SHA-256 hash (authorKeyHash) is
// stored. The comment's public authorId is worked out here from that hash and the project's ID
// (authorIdForKeyHash), never taken from the request, so nobody can post under someone else's ID,
// and one browser has a different ID in every project. publicComment() removes the hash; the store
// applies it to every comment it hands out, so the hash never reaches an API response, a WebSocket
// message, an MCP read, or a conflict reply.
//
// Who may do what (role comes from the request's access: owner, edit, comment, or view):
//   - view links read comments and change nothing.
//   - owner, edit, and comment can post, reply, resolve or reopen, and move a thread (x, y, sceneId, time).
//   - Only the comment's author (the matching key) can edit its text or mentions. Comments posted
//     without a key, such as ones saved before authorship existed, cannot be edited by anyone.
//   - The author or the owner can delete a comment. Deleting a thread's first comment deletes its replies.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { MAX_TIME } from "../engine/schema.js";

export const MAX_COMMENT_TEXT = 2000;
export const MAX_COMMENT_AUTHOR = 100;
export const MAX_COMMENT_COORDINATE = 1_000_000;
// The longest scene the editor allows (MAX_TIME in engine/model.js); used only when a scene has no duration.
export const MAX_COMMENT_TIME = MAX_TIME;
export const MAX_COMMENT_MENTIONS = 20;
export const MAX_COMMENTS_PER_PROJECT = 5000;
// Node lowercases request header names.
export const COMMENT_KEY_HEADER = "x-kino-comment-key";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Scene IDs follow the document's ID rule (ID_PATTERN in engine/model.js), which also allows dots and colons.
const SCENE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const AUTHOR_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const COMMENT_KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const KEY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const NAME_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const PLACEMENT_FIELDS = ["x", "y", "sceneId", "time"];
const CHANGE_FIELDS = new Set(["text", "mentions", "resolved", ...PLACEMENT_FIELDS]);

// The local machine without a share token is the file's owner (see authorize() in index.mjs).
// Requests through a share link pass that link's role instead.
export const LOCAL_OWNER = Object.freeze({ role: "owner", keyHash: null });

// `status` is the HTTP status the server answers with (index.mjs uses error.status).
export class CommentError extends Error {
  constructor(message, code = "ERR_INVALID_COMMENT", status = 400) {
    super(message);
    this.name = "CommentError";
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  return new CommentError(message, "ERR_INVALID_COMMENT", 400);
}

function refused(message) {
  return new CommentError(message, "ERR_COMMENT_FORBIDDEN", 403);
}

export function commentNotFound(message = "This comment no longer exists.") {
  return new CommentError(message, "ERR_COMMENT_NOT_FOUND", 404);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canWriteComments(role) {
  return ["owner", "edit", "comment"].includes(role);
}

// The stored form of a comment key: its SHA-256 hash in hex. No key (the header is absent) is null.
export function commentKeyHash(key) {
  if (key === undefined || key === null || key === "") return null;
  if (typeof key !== "string" || !COMMENT_KEY_PATTERN.test(key))
    throw invalid("The comment key must be 32 to 128 letters, numbers, underscores, or hyphens.");
  return createHash("sha256").update(key).digest("hex");
}

// The public author ID of a comment key in one project: the first 32 hex characters of the SHA-256
// of the project's ID and the key's hash. Only the key's holder can post under it, and the same key
// has a different ID in every project, so comments in different files cannot be linked by it.
// frontend/comments.js authorIdForKey works out the same ID in the browser from the key itself.
// The label below is fixed: it is part of every stored author ID, so changing it would make
// people lose their own comments. Never rename it.
export function authorIdForKeyHash(projectId, keyHash) {
  return createHash("sha256").update(`kino-comment-author\n${projectId}\n${keyHash}`).digest("hex").slice(0, 32);
}

// True when `keyHash` (from the request) is the hash stored on the comment.
export function sameAuthorKey(storedHash, keyHash) {
  if (typeof storedHash !== "string" || typeof keyHash !== "string") return false;
  if (!KEY_HASH_PATTERN.test(storedHash) || !KEY_HASH_PATTERN.test(keyHash)) return false;
  return timingSafeEqual(Buffer.from(storedHash, "hex"), Buffer.from(keyHash, "hex"));
}

// The copy of a comment that may leave the server: everything except the author key's hash.
export function publicComment(comment) {
  const { authorKeyHash: _private, ...visible } = comment;
  return visible;
}

export function publicComments(comments) {
  return comments.map(publicComment);
}

function validateText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_COMMENT_TEXT || TEXT_CONTROL_CHARACTERS.test(text))
    throw invalid(`Comment text must be 1 to ${MAX_COMMENT_TEXT} characters.`);
  return text;
}

// A display name: the author field and each mention. Empty means "Guest" only for the author.
function validateDisplayName(value, label) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_COMMENT_AUTHOR || NAME_CONTROL_CHARACTERS.test(name))
    throw invalid(`${label} must be 1 to ${MAX_COMMENT_AUTHOR} characters.`);
  return name;
}

function validateAuthor(value) {
  if (value === undefined) return "Guest";
  if (typeof value === "string" && !value.trim()) return "Guest";
  return validateDisplayName(value, "Comment author");
}

// Mentions are the display names typed after @. kino has no accounts or email, so a mention
// is a name for people to find, not a notification. Repeated names are kept once.
function validateMentions(value) {
  if (!Array.isArray(value) || value.length > MAX_COMMENT_MENTIONS)
    throw invalid(`Mentions must be a list of at most ${MAX_COMMENT_MENTIONS} display names.`);
  return [...new Set(value.map((name) => validateDisplayName(name, "Each mention")))];
}

function validateCommentId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    throw invalid(`${label} must contain 1 to 128 letters, numbers, underscores, or hyphens.`);
  return value;
}

function validateSceneId(value) {
  if (typeof value !== "string" || !SCENE_ID_PATTERN.test(value))
    throw invalid("Scene ID must contain 1 to 128 letters, numbers, dots, colons, underscores, or hyphens.");
  return value;
}

function validateCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COMMENT_COORDINATE)
    throw invalid(`${label} must be a finite number between 0 and ${MAX_COMMENT_COORDINATE}.`);
  return value;
}

// Seconds into the scene. placeInScene() rounds it to the millisecond once the scene is known.
function validateTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw invalid("Comment time must be a finite number of seconds, 0 or more.");
  return value;
}

// `time` rounded to the millisecond, never past the scene's end (`duration`). A scene's length
// need not be a whole number of milliseconds (32 frames at 30 fps is 1.0666… s), so a time at its
// very end would round past the end (1.067 s); it takes the millisecond before instead (1.066 s).
// A time that is past the end even after rounding is refused.
export function timeInScene(time, duration) {
  const milliseconds = Math.round(time * 1000);
  if (milliseconds / 1000 <= duration) return milliseconds / 1000;
  if (time <= duration) return (milliseconds - 1) / 1000;
  throw invalid("Comment time must be within the scene's duration.");
}

function findScene(document, sceneId) {
  const scene = Array.isArray(document?.scenes)
    ? document.scenes.find((item) => item && item.id === sceneId)
    : null;
  if (!scene) throw invalid("Comment scene does not exist in this project.");
  return scene;
}

// Checks the named placement fields of `place` against the scene's size and length, and rounds
// place.time to the millisecond within the scene (timeInScene).
function placeInScene(place, scene, fields) {
  if (fields.includes("x") && place.x !== undefined && Number.isFinite(scene.width) && place.x > scene.width)
    throw invalid("Comment x must be within the selected scene.");
  if (fields.includes("y") && place.y !== undefined && Number.isFinite(scene.height) && place.y > scene.height)
    throw invalid("Comment y must be within the selected scene.");
  const duration = Number.isFinite(scene.duration) ? scene.duration : MAX_COMMENT_TIME;
  if (fields.includes("time") && place.time !== undefined) place.time = timeInScene(place.time, duration);
}

function given(input, field) {
  return Object.hasOwn(input, field) && input[field] !== undefined;
}

// A new comment or reply from `input` ({text, author?, mentions?, parentId?, x?, y?, sceneId?,
// time?}), checked against the project's document and its current comments. `actor` is
// {role, keyHash}; keyHash is the hash of the request's comment key, or null. `projectId` is the
// project the comment is posted in. Returns the record to store (it includes authorKeyHash, so use
// publicComment() before sending it).
export function newComment(input, { projectId, document, comments, actor = LOCAL_OWNER }) {
  if (!isPlainObject(input)) throw invalid("Comment must be an object.");
  if (!canWriteComments(actor.role)) throw refused("This link permits viewing. A comment or edit link is needed to post comments.");
  if (comments.length >= MAX_COMMENTS_PER_PROJECT)
    throw new CommentError(`A project can hold at most ${MAX_COMMENTS_PER_PROJECT} comments and replies. Delete some before adding more.`, "ERR_COMMENT_LIMIT", 400);

  const comment = {
    id: randomUUID(),
    text: validateText(input.text),
    author: validateAuthor(input.author),
    createdAt: new Date().toISOString(),
    resolved: false,
  };

  // Authorship: the private key arrives in the X-Kino-Comment-Key header (keyHash is its hash).
  // The public author ID is worked out from it, so a request cannot choose one.
  if (given(input, "authorId"))
    throw invalid("Leave out authorId: the server works it out from the comment key (X-Kino-Comment-Key header).");
  const keyHash = actor.keyHash ?? null;
  if (keyHash) {
    comment.authorId = authorIdForKeyHash(projectId, keyHash);
    comment.authorKeyHash = keyHash;
  }
  if (given(input, "mentions")) {
    const mentions = validateMentions(input.mentions);
    if (mentions.length) comment.mentions = mentions;
  }

  if (given(input, "parentId")) {
    const parentId = validateCommentId(input.parentId, "Reply parent ID");
    const parent = comments.find((entry) => entry.id === parentId);
    if (!parent) throw commentNotFound("The comment you replied to no longer exists.");
    if (parent.parentId) throw invalid("Replies cannot have replies. Reply to the thread's first comment.");
    if (PLACEMENT_FIELDS.some((field) => given(input, field)))
      throw invalid("A reply uses its thread's place on the canvas and timeline; send it without x, y, sceneId, or time.");
    comment.parentId = parentId;
    return comment;
  }

  if (given(input, "x")) comment.x = validateCoordinate(input.x, "Comment x");
  if (given(input, "y")) comment.y = validateCoordinate(input.y, "Comment y");
  if (given(input, "time")) {
    if (!given(input, "sceneId")) throw invalid("A comment time needs the scene it belongs to (sceneId).");
    comment.time = validateTime(input.time);
  }
  if (given(input, "sceneId")) {
    comment.sceneId = validateSceneId(input.sceneId);
    placeInScene(comment, findScene(document, comment.sceneId), PLACEMENT_FIELDS);
  }
  return comment;
}

// Applies `patch` ({text?, mentions?, x?, y?, sceneId?, time?, resolved?}) to the stored `comment`
// in place, after checking every field and the actor's right to change it. Nothing changes when
// any check fails. Returns the comment.
export function changeComment(comment, patch, { document, actor = LOCAL_OWNER }) {
  if (!isPlainObject(patch)) throw invalid("Comment changes must be an object.");
  const fields = Object.keys(patch).filter((field) => patch[field] !== undefined);
  const unknown = fields.filter((field) => !CHANGE_FIELDS.has(field));
  if (unknown.length)
    throw invalid(`A comment change may include only text, mentions, x, y, sceneId, time, and resolved (not ${unknown.join(", ")}).`);
  if (!fields.length) throw invalid("Choose something to change on the comment.");
  if (!canWriteComments(actor.role)) throw refused("This link permits viewing. A comment or edit link is needed to change comments.");

  const next = {};
  if (fields.includes("text") || fields.includes("mentions")) {
    if (!comment.authorKeyHash)
      throw refused("This comment was posted without an author key, so its text cannot be edited. The owner can delete it.");
    if (!sameAuthorKey(comment.authorKeyHash, actor.keyHash))
      throw refused("Only the person who wrote this comment can edit it.");
    if (fields.includes("text")) next.text = validateText(patch.text);
    if (fields.includes("mentions")) next.mentions = validateMentions(patch.mentions);
  }

  const moving = PLACEMENT_FIELDS.filter((field) => fields.includes(field));
  if (moving.length) {
    if (comment.parentId) throw invalid("A reply moves with its thread. Move the thread's first comment instead.");
    const place = { x: comment.x, y: comment.y, sceneId: comment.sceneId, time: comment.time };
    if (moving.includes("x")) place.x = validateCoordinate(patch.x, "Comment x");
    if (moving.includes("y")) place.y = validateCoordinate(patch.y, "Comment y");
    if (moving.includes("time")) place.time = validateTime(patch.time);
    if (moving.includes("sceneId")) place.sceneId = validateSceneId(patch.sceneId);
    if (place.time !== undefined && place.sceneId === undefined)
      throw invalid("A comment time needs the scene it belongs to (sceneId).");
    if (place.sceneId !== undefined) {
      // A thread moved to another scene must fit that scene with everything it keeps; otherwise only
      // the moved fields are checked, so a thread on a scene that has since shrunk can still be resolved
      // or nudged along one axis.
      const changedScene = moving.includes("sceneId") && place.sceneId !== comment.sceneId;
      placeInScene(place, findScene(document, place.sceneId), changedScene ? PLACEMENT_FIELDS : moving);
    }
    for (const field of moving) next[field] = place[field];
  }

  if (fields.includes("resolved")) {
    if (typeof patch.resolved !== "boolean") throw invalid("Resolved must be true or false.");
    if (comment.parentId) throw invalid("Resolve the thread from its first comment.");
    next.resolved = patch.resolved;
  }

  const edited =
    (next.text !== undefined && next.text !== comment.text) ||
    (next.mentions !== undefined && JSON.stringify(next.mentions) !== JSON.stringify(comment.mentions ?? []));
  Object.assign(comment, next);
  if (Array.isArray(comment.mentions) && comment.mentions.length === 0) delete comment.mentions;
  if (edited) comment.editedAt = new Date().toISOString();
  return comment;
}

// Removes the comment with `commentId` from `comments`; a thread's first comment takes its replies.
// Returns {remaining, deleted}, where deleted lists the removed IDs.
export function removeComment(comments, commentId, { actor = LOCAL_OWNER } = {}) {
  if (!canWriteComments(actor.role)) throw refused("This link permits viewing. A comment or edit link is needed to change comments.");
  const comment = comments.find((entry) => entry.id === commentId);
  if (!comment) throw commentNotFound();
  if (actor.role !== "owner" && !sameAuthorKey(comment.authorKeyHash, actor.keyHash))
    throw refused("Only the person who wrote this comment or the file's owner can delete it.");
  const deleted = new Set([comment.id]);
  if (!comment.parentId)
    for (const entry of comments) if (entry.parentId === comment.id) deleted.add(entry.id);
  return { remaining: comments.filter((entry) => !deleted.has(entry.id)), deleted: [...deleted] };
}

function optional(value, check) {
  return value === undefined || check(value);
}

// The checks store.mjs runs on a project's comments when it loads store.json. Fields added with
// threads are optional, so stores saved before them still load.
export function validStoredComments(comments) {
  if (!Array.isArray(comments)) return false;
  const ids = new Set();
  const roots = new Set();
  for (const comment of comments) {
    if (
      !comment ||
      typeof comment !== "object" ||
      typeof comment.id !== "string" ||
      ids.has(comment.id) ||
      typeof comment.text !== "string" ||
      typeof comment.author !== "string" ||
      typeof comment.createdAt !== "string" ||
      typeof comment.resolved !== "boolean" ||
      !optional(comment.parentId, (value) => typeof value === "string" && ID_PATTERN.test(value)) ||
      !optional(comment.authorId, (value) => typeof value === "string" && AUTHOR_ID_PATTERN.test(value)) ||
      !optional(comment.authorKeyHash, (value) => typeof value === "string" && KEY_HASH_PATTERN.test(value)) ||
      !optional(comment.editedAt, (value) => typeof value === "string") ||
      !optional(comment.time, (value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
      !optional(comment.mentions, (value) => Array.isArray(value) && value.length <= MAX_COMMENT_MENTIONS && value.every((name) => typeof name === "string"))
    )
      return false;
    ids.add(comment.id);
    if (comment.parentId === undefined) roots.add(comment.id);
  }
  // Every reply belongs to a thread's first comment in the same project.
  return comments.every((comment) => comment.parentId === undefined || roots.has(comment.parentId));
}
