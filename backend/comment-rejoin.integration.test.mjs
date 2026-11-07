// A session that joins a file over the collaboration WebSocket (on first open and on every
// reconnect) is sent the file's current comments right away. Without this, comment changes made
// while its socket was closed (server restart, sleep, network drop) or between loading the file
// and the first join would never reach it, because comments are only broadcast after a write.
// The list goes only to the session that joined, carries no author key hashes, and arrives
// before the broadcasts of later writes. A revoked link gets nothing.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createDocument, createScene } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

const KEY_HEADER = "X-Kino-Comment-Key";
const OWNER_KEY = "o".repeat(48);
const GUEST_KEY = "g".repeat(48);
const SECRET = /authorKeyHash|o{48}|g{48}/;

async function expectStatus(response, status, reason) {
  const text = await response.text();
  assert.equal(response.status, status, `${reason}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Opens a collaboration socket and keeps every message it receives, in order.
async function openSocket(server, link) {
  const port = new URL(server.baseUrl).port;
  const query = link ? `?share=${encodeURIComponent(link.token)}` : "";
  const socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration${query}`, {
    origin: server.baseUrl,
    headers: link ? {} : { "X-Kino-Owner": server.ownerToken },
  });
  const received = [];
  socket.on("message", (data) => {
    try {
      received.push({ message: JSON.parse(data.toString()), raw: data.toString() });
    } catch {
      /* Not JSON: not a collaboration message. */
    }
  });
  await once(socket, "open");
  return { socket, received };
}

// Waits until a received message matches, and returns it.
async function nextMessage(session, predicate, from = 0, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = session.received.slice(from).find(({ message }) => predicate(message));
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`Timed out. Received: ${session.received.map(({ message }) => message.type).join(", ") || "nothing"}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function join(session, clientId, name) {
  session.socket.send(JSON.stringify({ type: "join", projectId: "rejoin", clientId, name }));
}

async function closeSocket(session) {
  if (session.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(session.socket, "close");
  session.socket.close();
  await closed;
}

const ids = (list) => list.map((comment) => comment.id).sort();

test("joining a file sends its current comments, so a reconnecting session catches up", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const document = createDocument({
    id: "rejoin",
    name: "Rejoin",
    scenes: [createScene({ id: "main", name: "Main", width: 640, height: 360, duration: 4, background: "#ffffff", layers: [] })],
  });
  await expectStatus(await server.api("/api/projects", { method: "POST", body: { document } }), 201, "owner creates the project");
  const share = async (role) =>
    expectStatus(await server.api("/api/projects/rejoin/shares", { method: "POST", body: { role, label: role } }), 201, `owner creates a ${role} link`);
  const [viewLink, commentLink] = [await share("view"), await share("comment")];
  const comments = "/api/projects/rejoin/comments";
  const asOwner = { headers: { [KEY_HEADER]: OWNER_KEY } };
  const asGuest = { owner: false, share: commentLink.token, headers: { [KEY_HEADER]: GUEST_KEY } };
  const post = (who, body) => server.api(comments, { ...who, method: "POST", body });

  const a = await expectStatus(await post(asOwner, { text: "Thread A", sceneId: "main", x: 10, y: 10, time: 1 }), 201, "owner posts A");
  const b = await expectStatus(await post(asOwner, { text: "Thread B", sceneId: "main", x: 20, y: 20, time: 2 }), 201, "owner posts B");

  // A view-link session watches; the owner's browser session joins and gets A and B at once.
  const watcher = await openSocket(server, viewLink);
  t.after(() => watcher.socket.terminate());
  join(watcher, "watcher", "Viewer");
  const watcherFirst = await nextMessage(watcher, (message) => message.type === "comments");
  assert.deepEqual(ids(watcherFirst.message.comments), ids([a, b]), "a view link is sent the comments it may read");

  const browser = await openSocket(server);
  t.after(() => browser.socket.terminate());
  join(browser, "browser", "Guest");
  const first = await nextMessage(browser, (message) => message.type === "comments");
  assert.deepEqual(ids(first.message.comments), ids([a, b]), "the first join brings the comments");
  assert.doesNotMatch(first.raw, SECRET, "the join's comment list carries no key or hash");

  // The browser's socket closes. Meanwhile a guest resolves A and posts C.
  await closeSocket(browser);
  const watcherSeen = watcher.received.length;
  await expectStatus(await server.api(`${comments}/${a.id}`, { ...asGuest, method: "PATCH", body: { resolved: true } }), 200, "guest resolves A");
  const c = await expectStatus(await post(asGuest, { text: "Thread C", sceneId: "main", x: 30, y: 30, time: 3 }), 201, "guest posts C");

  // The browser reconnects and joins again: no further comment write is needed to catch up.
  const again = await openSocket(server);
  t.after(() => again.socket.terminate());
  join(again, "browser", "Guest");
  const caughtUp = await nextMessage(again, (message) => message.type === "comments");
  assert.deepEqual(ids(caughtUp.message.comments), ids([a, b, c]), "the reconnect brings C");
  assert.equal(caughtUp.message.comments.find((comment) => comment.id === a.id).resolved, true, "the reconnect shows A resolved");
  assert.doesNotMatch(caughtUp.raw, SECRET);

  // Later writes still reach the rejoined session, after its join list.
  const d = await expectStatus(await post(asGuest, { text: "Thread D", sceneId: "main", x: 40, y: 40, time: 0 }), 201, "guest posts D");
  const later = await nextMessage(again, (message) => message.type === "comments" && message.comments.some((comment) => comment.id === d.id));
  const commentMessages = again.received.filter(({ message }) => message.type === "comments");
  assert.equal(commentMessages.at(-1), later, "the write's broadcast comes after the join list");
  assert.equal(commentMessages[0], caughtUp);

  // Someone else joining sends the list only to them: the watcher heard the three writes, nothing more.
  await nextMessage(watcher, (message) => message.type === "comments" && message.comments.some((comment) => comment.id === d.id), watcherSeen);
  const watcherLists = watcher.received.slice(watcherSeen).filter(({ message }) => message.type === "comments");
  assert.equal(watcherLists.length, 3, "the watcher gets one list per write and none for the other session's join");

  // A revoked link's join is refused and sends no comments.
  const revokedLink = await share("view");
  const revoked = await openSocket(server, revokedLink);
  t.after(() => revoked.socket.terminate());
  await expectStatus(await server.api(`/api/projects/rejoin/shares/${revokedLink.grant.id}`, { method: "DELETE" }), 200, "owner revokes the link");
  const closed = once(revoked.socket, "close");
  join(revoked, "revoked", "Guest");
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(revoked.received.some(({ message }) => message.type === "comments"), false, "a revoked link receives no comments");
});
