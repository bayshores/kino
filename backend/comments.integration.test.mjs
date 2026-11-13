// Comment routes through the real HTTP service: share roles, the comment key header, replies,
// moving threads, deleting, live WebSocket updates, and author key hashes never leaving the
// server (API answers, WebSocket messages, merged-save replies, and the agent's comment list).
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { authorIdForKeyHash, commentKeyHash } from "./comments.mjs";
import { startTestServer } from "./media.test.support.mjs";

const GUEST_KEY = "g".repeat(48);
const EDITOR_KEY = "e".repeat(48);
const KEY_HEADER = "X-Kino-Comment-Key";
const SECRET = /authorKeyHash|g{48}|e{48}/;
// The public author IDs the server works out from each key for this test's project.
const GUEST_ID = authorIdForKeyHash("comments-http", commentKeyHash(GUEST_KEY));
const EDITOR_ID = authorIdForKeyHash("comments-http", commentKeyHash(EDITOR_KEY));

function waitForMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for a collaboration message.")), timeoutMs);
    const onMessage = (data) => {
      const raw = data.toString();
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (predicate(message)) finish(null, { message, raw });
    };
    function finish(error, value) {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if (error) reject(error);
      else resolve(value);
    }
    socket.on("message", onMessage);
  });
}

async function expectStatus(response, status, reason) {
  const text = await response.text();
  assert.equal(response.status, status, `${reason}: ${text}`);
  return text ? JSON.parse(text) : null;
}

test("comment routes enforce roles and authorship, broadcast live, and never expose author key hashes", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const document = createDocument({
    id: "comments-http",
    name: "Comments",
    scenes: [
      createScene({ id: "wide", name: "Wide", width: 640, height: 360, duration: 4, background: "#ffffff", layers: [createLayer("rectangle", { id: "logo", name: "Logo" })] }),
      createScene({ id: "small", name: "Small", width: 100, height: 50, duration: 1, background: "#ffffff", layers: [] }),
    ],
  });
  await expectStatus(await server.api("/api/projects", { method: "POST", body: { document } }), 201, "owner creates the project");
  const share = async (role) =>
    expectStatus(await server.api("/api/projects/comments-http/shares", { method: "POST", body: { role, label: role } }), 201, `owner creates a ${role} link`);
  const [viewLink, commentLink, editLink] = [await share("view"), await share("comment"), await share("edit")];
  const comments = "/api/projects/comments-http/comments";
  const as = (link, key) => ({ owner: false, share: link.token, headers: key ? { [KEY_HEADER]: key } : {} });

  // A second session (the view link) watches for live updates.
  const port = new URL(server.baseUrl).port;
  const watcher = new WebSocket(`ws://127.0.0.1:${port}/collaboration?share=${encodeURIComponent(viewLink.token)}`, { origin: server.baseUrl });
  t.after(() => watcher.close());
  await once(watcher, "open");
  const joined = waitForMessage(watcher, (message) => message.type === "presence");
  watcher.send(JSON.stringify({ type: "join", projectId: "comments-http", clientId: "watcher", name: "Viewer" }));
  await joined;

  // A guest with a comment link posts a timed pin with its own key.
  let live = waitForMessage(watcher, (message) => message.type === "comments" && message.comments.length === 1);
  const root = await expectStatus(await server.api(comments, {
    ...as(commentLink, GUEST_KEY), method: "POST",
    body: { text: "Hold this frame @Editor", author: "Guest A", sceneId: "wide", x: 600, y: 300, time: 3.0004, mentions: ["Editor"] },
  }), 201, "a comment link posts with its key");
  assert.deepEqual([root.authorId, root.time, root.mentions, root.sceneId], [GUEST_ID, 3, ["Editor"], "wide"]);
  let update = await live;
  assert.equal(update.message.comments[0].id, root.id);
  assert.doesNotMatch(update.raw, SECRET, "the WebSocket message carries no key or hash");

  // An editor replies; the reply has no place of its own.
  live = waitForMessage(watcher, (message) => message.type === "comments" && message.comments.length === 2);
  const reply = await expectStatus(await server.api(comments, {
    ...as(editLink, EDITOR_KEY), method: "POST", body: { text: "On it", author: "Editor", parentId: root.id },
  }), 201, "an edit link replies");
  assert.equal(reply.parentId, root.id);
  assert.equal(reply.authorId, EDITOR_ID);
  assert.doesNotMatch((await live).raw, SECRET);
  await expectStatus(await server.api(comments, {
    ...as(editLink, EDITOR_KEY), method: "POST", body: { text: "Nested", parentId: reply.id },
  }), 400, "replies cannot have replies");
  await expectStatus(await server.api(comments, {
    ...as(editLink, EDITOR_KEY), method: "POST", body: { text: "Lost", parentId: "no-such-comment" },
  }), 404, "replying to a missing comment");
  await expectStatus(await server.api(comments, {
    ...as(editLink, EDITOR_KEY), method: "POST", body: { text: "Impostor", authorId: GUEST_ID },
  }), 400, "the server never takes an author ID from the request");

  // View links read but never write.
  const viewed = await expectStatus(await server.api(comments, as(viewLink)), 200, "a view link reads comments");
  assert.equal(viewed.comments.length, 2);
  await expectStatus(await server.api(comments, { ...as(viewLink, GUEST_KEY), method: "POST", body: { text: "No" } }), 403, "a view link cannot post");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(viewLink, GUEST_KEY), method: "PATCH", body: { resolved: true } }), 403, "a view link cannot resolve");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(viewLink, GUEST_KEY), method: "PATCH", body: { text: "No" } }), 403, "a view link cannot edit, even with the author's key");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(viewLink, GUEST_KEY), method: "DELETE" }), 403, "a view link cannot delete");

  // Text belongs to its author; the owner cannot rewrite it.
  await expectStatus(await server.api(`${comments}/${root.id}`, { method: "PATCH", body: { text: "Owner rewrite" } }), 403, "the owner cannot edit a guest's text");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(editLink, EDITOR_KEY), method: "PATCH", body: { text: "Editor rewrite" } }), 403, "another person's key cannot edit");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { text: "No key" } }), 403, "no key cannot edit");
  live = waitForMessage(watcher, (message) => message.type === "comments" && message.comments.some((comment) => comment.editedAt));
  const edited = await expectStatus(await server.api(`${comments}/${root.id}`, {
    ...as(commentLink, GUEST_KEY), method: "PATCH", body: { text: "Hold this frame longer", mentions: [] },
  }), 200, "the author edits the text");
  assert.equal(edited.text, "Hold this frame longer");
  assert.equal(edited.mentions, undefined);
  assert.ok(edited.editedAt);
  assert.doesNotMatch((await live).raw, SECRET);

  // Anyone who can comment moves or resolves a thread; moves are checked against the target scene.
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(editLink), method: "PATCH", body: { sceneId: "small" } }), 400, "the pin does not fit the small scene");
  const moved = await expectStatus(await server.api(`${comments}/${root.id}`, {
    ...as(editLink), method: "PATCH", body: { sceneId: "small", x: 50, y: 25, time: 0.5 },
  }), 200, "an editor moves the guest's thread to another scene");
  assert.deepEqual([moved.sceneId, moved.x, moved.y, moved.time], ["small", 50, 25, 0.5]);
  await expectStatus(await server.api(`${comments}/${reply.id}`, { ...as(editLink), method: "PATCH", body: { x: 1 } }), 400, "a reply moves with its thread");
  assert.equal((await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { resolved: true } }), 200, "the original resolve body still works")).resolved, true);
  assert.equal((await expectStatus(await server.api(`${comments}/${root.id}`, { method: "PATCH", body: { resolved: false } }), 200, "the owner reopens")).resolved, false);

  // Malformed requests.
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink, "short"), method: "PATCH", body: { resolved: true } }), 400, "a malformed comment key");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { author: "Renamed" } }), 400, "an unknown field");
  await expectStatus(await server.api(`${comments}/missing`, { ...as(commentLink), method: "PATCH", body: { resolved: true } }), 404, "a missing comment");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: "not json", headers: { "Content-Type": "text/plain" } }), 400, "a body that is not JSON");

  // Deleting: authors and the owner; the first comment takes its replies.
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(editLink, EDITOR_KEY), method: "DELETE" }), 403, "an editor cannot delete someone else's comment");
  const extra = await expectStatus(await server.api(comments, { ...as(editLink, EDITOR_KEY), method: "POST", body: { text: "Mine to delete", sceneId: "wide" } }), 201, "editor posts");
  assert.deepEqual(await expectStatus(await server.api(`${comments}/${extra.id}`, { ...as(editLink, EDITOR_KEY), method: "DELETE" }), 200, "the author deletes"), { deleted: [extra.id] });

  // Nothing that leaves the server carries a hash: project reads and merged-save replies.
  const ownerRecord = await expectStatus(await server.api("/api/projects/comments-http"), 200, "owner reads the project");
  const saved = await expectStatus(await server.api("/api/projects/comments-http", { method: "PUT", body: { document: ownerRecord.document, revision: ownerRecord.revision } }), 200, "owner saves");
  const staleMerged = await expectStatus(await server.api("/api/projects/comments-http", { method: "PUT", body: { document: ownerRecord.document, revision: ownerRecord.revision } }), 200, "stale save merges with the current document");
  assert.equal(staleMerged.merged, true);
  assert.equal(staleMerged.revision, saved.revision + 1);
  assert.deepEqual(staleMerged.comments.map((comment) => comment.id), saved.comments.map((comment) => comment.id), "merging document data preserves comment threads");
  for (const value of [ownerRecord, saved, staleMerged, viewed]) assert.doesNotMatch(JSON.stringify(value), SECRET);
  const disk = await readFile(path.join(server.dataDirectory, "store.json"), "utf8");
  assert.match(disk, /"authorKeyHash":"[a-f0-9]{64}"/, "the hash is kept on disk");
  assert.doesNotMatch(disk, /g{48}|e{48}/, "the keys themselves are not");

  // An agent reads the same comments (project manage comments list) without any key or hash.
  const read = await expectStatus(await server.api("/api/agent/project", {
    method: "POST", body: { action: "manage", id: "comments-http", options: { resource: "comments", action: "list" } },
  }), 200, "the agent lists comments");
  assert.notEqual(read.isError, true, read.text);
  assert.doesNotMatch(JSON.stringify(read), SECRET, "agent reads carry no key or hash");
  const agentComments = read.data.comments;
  const agentRoot = agentComments.find((comment) => comment.id === root.id);
  assert.deepEqual(
    [agentRoot.authorId, agentRoot.sceneId, agentRoot.time, Boolean(agentRoot.editedAt)],
    [GUEST_ID, "small", 0.5, true],
  );
  assert.equal(agentComments.find((comment) => comment.id === reply.id).parentId, root.id);
  // The guest's comment and the editor's reply reached the agent's inbox (handed over with its
  // first call), one line each.
  assert.match(read.text, /comment from Guest A on Wide @3 "Hold this frame @Editor" \(answer: manage comments add \{parentId:"/);
  assert.match(read.text, /reply from Editor on Wide @3 "On it"/);

  // The owner moderates; deleting the thread removes the editor's reply, and every session hears it.
  live = waitForMessage(watcher, (message) => message.type === "comments" && message.comments.length === 0);
  const removed = await expectStatus(await server.api(`${comments}/${root.id}`, { method: "DELETE" }), 200, "the owner deletes the thread");
  assert.deepEqual(removed.deleted.sort(), [root.id, reply.id].sort());
  await live;

  // The agent pins a comment to a layer by name, over a range, and lists it in one short line.
  const agent = async (verb, body) => expectStatus(await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "comments-http", ...body } }), 200, verb);
  const manage = (options) => agent("project", { action: "manage", id: "comments-http", options: { resource: "comments", ...options } });
  const pinned = (await manage({ action: "add", text: "Logo enters late", layer: "Logo", time: 1, timeEnd: 2.5 })).data;
  assert.deepEqual([pinned.sceneId, pinned.layerId, pinned.time, pinned.timeEnd], ["wide", "logo", 1, 2.5]);
  assert.match((await manage({ action: "list" })).text, /1 open, 0 resolved\n\S+ Agent on Wide Logo @1-2\.5: "Logo enters late"/);
  const whole = (await manage({ action: "update", id: pinned.id, patch: { scene: null } })).data;
  assert.deepEqual([whole.sceneId, whole.layerId, whole.time], [undefined, undefined, undefined]);
  assert.match((await manage({ action: "list" })).text, /Agent on whole video: "Logo enters late"/);
  assert.doesNotMatch((await agent("status", {})).text, /Logo enters late/, "the agent's own comment adds no inbox line");

  // A revoked link cannot post.
  await expectStatus(await server.api(`/api/projects/comments-http/shares/${commentLink.grant.id}`, { method: "DELETE" }), 200, "owner revokes the comment link");
  await expectStatus(await server.api(comments, { ...as(commentLink, GUEST_KEY), method: "POST", body: { text: "After revoke" } }), 403, "a revoked link cannot post");
});
