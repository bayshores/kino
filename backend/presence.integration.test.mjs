import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

const OWNER_TOKEN = "presence-test-owner-key";

async function startPresenceServer() {
  const previous = process.env.MOTION_FONT_DOWNLOADS;
  process.env.MOTION_FONT_DOWNLOADS = "off";
  try { return await startTestServer({ ownerToken: OWNER_TOKEN }); }
  finally {
    if (previous === undefined) delete process.env.MOTION_FONT_DOWNLOADS;
    else process.env.MOTION_FONT_DOWNLOADS = previous;
  }
}

async function expectStatus(response, status, reason) {
  const text = await response.text();
  assert.equal(response.status, status, `${reason}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function openSocket(server, share = null, sessions = []) {
  const port = new URL(server.baseUrl).port;
  const query = share ? `?share=${encodeURIComponent(share.token)}` : "";
  const socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration${query}`, {
    origin: server.baseUrl,
    headers: share ? {} : { "X-Kino-Owner": server.ownerToken },
  });
  const session = { socket, received: [] };
  socket.on("message", (data) => {
    try { session.received.push(JSON.parse(data.toString())); }
    catch { /* Collaboration messages are JSON. */ }
  });
  sessions.push(session);
  await once(socket, "open");
  return session;
}

async function nextMessage(session, predicate, from = 0, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = session.received.slice(from).find(predicate);
    if (found) return found;
    if (session.socket.readyState === WebSocket.CLOSED)
      throw new Error(`Socket closed before the expected message. Received: ${session.received.map((message) => message.type).join(", ")}.`);
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for a collaboration message. Received: ${session.received.map((message) => message.type).join(", ") || "nothing"}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function join(session, projectId, clientId, name) {
  session.socket.send(JSON.stringify({ type: "join", projectId, clientId, name }));
}

async function joinAndReadPresence(session, projectId, clientId, name) {
  const from = session.received.length;
  join(session, projectId, clientId, name);
  return nextMessage(session, (message) => message.type === "presence" && message.selfId &&
    message.people?.some((person) => person.id === message.selfId && person.name === name), from);
}

async function closeSocket(session) {
  if (session.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(session.socket, "close");
  session.socket.close();
  await closed;
}

function collaborationDocument(id, { foreign = false } = {}) {
  if (foreign) {
    return createDocument({
      id,
      name: "Other project",
      scenes: [createScene({
        id: "other-scene",
        name: "Other scene",
        width: 320,
        height: 180,
        duration: 2,
        layers: [createLayer("rectangle", { id: "foreign-layer", width: 40, height: 40 })],
      })],
    });
  }
  return createDocument({
    id,
    name: "Presence project",
    scenes: [
      createScene({
        id: "component",
        name: "Card component",
        isComponent: true,
        width: 120,
        height: 60,
        duration: 2,
        layers: [createLayer("text", { id: "component-title", text: "Title" })],
      }),
      createScene({
        id: "canvas",
        name: "Canvas",
        width: 320,
        height: 180,
        duration: 2,
        layers: [
          createLayer("rectangle", { id: "layer-a", width: 40, height: 40 }),
          createLayer("rectangle", { id: "layer-b", x: 60, width: 40, height: 40 }),
          createLayer("component", { id: "instance-a", componentSceneId: "component", width: 120, height: 60 }),
        ],
      }),
      createScene({ id: "archive", name: "Archive", width: 320, height: 180, duration: 2, layers: [] }),
    ],
  });
}

test("collaboration presence, selection, cursor, and document pruning stay ephemeral and project-scoped", async (t) => {
  const server = await startPresenceServer();
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) {
      if (session.socket.readyState !== WebSocket.CLOSED) session.socket.terminate();
    }
    await server.stop();
  });

  const projectId = "presence-project";
  const otherProjectId = "presence-other";
  const created = await expectStatus(await server.api("/api/projects", {
    method: "POST",
    body: { document: collaborationDocument(projectId) },
  }), 201, "owner creates the primary project");
  await expectStatus(await server.api("/api/projects", {
    method: "POST",
    body: { document: collaborationDocument(otherProjectId, { foreign: true }) },
  }), 201, "owner creates another project");

  const createShare = async (id, role = "view") => expectStatus(
    await server.api(`/api/projects/${id}/shares`, { method: "POST", body: { role, label: role } }),
    201,
    `owner creates a ${role} link`,
  );
  const viewLink = await createShare(projectId);
  const otherViewLink = await createShare(otherProjectId);

  const owner = await openSocket(server, null, sessions);
  const sameNameTab = await openSocket(server, viewLink, sessions);
  const ownerJoined = await joinAndReadPresence(owner, projectId, "same-tab-id", "Same name");
  const ownerId = ownerJoined.selfId;
  const ownerPerson = ownerJoined.people.find((person) => person.id === ownerId);
  assert.match(ownerId, /^[0-9a-f-]{36}$/i, "the server assigns a session UUID");
  assert.notEqual(ownerId, "same-tab-id", "clientId does not become session identity");
  assert.deepEqual(Object.keys(ownerPerson).sort(), ["color", "id", "name", "sceneId"]);

  const tabJoined = await joinAndReadPresence(sameNameTab, projectId, "same-tab-id", "Same name");
  const tabId = tabJoined.selfId;
  const tabPerson = tabJoined.people.find((person) => person.id === tabId);
  assert.notEqual(tabId, ownerId, "two tabs with the same clientId remain separate sessions");
  assert.notEqual(tabPerson.color, ownerPerson.color, "active sessions receive distinct colors");
  assert.ok(tabJoined.people.some((person) => person.id === ownerId));
  const ownerSawTab = await nextMessage(owner, (message) => message.type === "presence" && message.selfId === ownerId &&
    message.people?.some((person) => person.id === tabId));
  assert.equal(ownerSawTab.people.find((person) => person.id === ownerId).id, ownerId);

  const ownerRejoined = await joinAndReadPresence(owner, projectId, "same-tab-id", "Renamed tab");
  assert.equal(ownerRejoined.selfId, ownerId, "rejoining the same project keeps the session ID");
  assert.equal(ownerRejoined.people.find((person) => person.id === ownerId).color, ownerPerson.color);
  assert.equal(ownerRejoined.people.find((person) => person.id === ownerId).name, "Renamed tab");
  await nextMessage(sameNameTab, (message) => message.type === "presence" && message.selfId === tabId &&
    message.people?.some((person) => person.id === ownerId && person.name === "Renamed tab"));

  const ownerSelectionStart = owner.received.length;
  const tabSelectionStart = sameNameTab.received.length;
  owner.socket.send(JSON.stringify({ type: "selection", sceneId: "canvas", layerIds: ["layer-a"] }));
  const directSelection = await nextMessage(sameNameTab, (message) => message.type === "selection" && message.id === ownerId, tabSelectionStart);
  assert.deepEqual(directSelection.layerIds, ["layer-a"]);
  assert.equal(directSelection.sceneId, "canvas");
  assert.equal(directSelection.name, "Renamed tab");
  assert.equal(directSelection.color, ownerPerson.color);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(owner.received.slice(ownerSelectionStart).some((message) => message.type === "selection" && message.id === ownerId), false,
    "selection relays do not echo to their sender");

  const late = await openSocket(server, viewLink, sessions);
  const lateJoined = await joinAndReadPresence(late, projectId, "late-tab-id", "Late viewer");
  assert.equal(new Set(lateJoined.people.map((person) => person.color)).size, 3, "the first three active sessions have distinct colors");
  const selectionSnapshot = await nextMessage(late, (message) => message.type === "selection" && message.id === ownerId);
  assert.deepEqual(selectionSnapshot.layerIds, ["layer-a"], "a new join receives the existing remote selection");

  const viewerSelectionStart = owner.received.length;
  sameNameTab.socket.send(JSON.stringify({ type: "selection", sceneId: "canvas", layerIds: ["layer-b"] }));
  const viewerSelection = await nextMessage(owner, (message) => message.type === "selection" && message.id === tabId, viewerSelectionStart);
  assert.deepEqual(viewerSelection.layerIds, ["layer-b"], "a view capability may send ephemeral selections");

  const inheritedStart = sameNameTab.received.length;
  owner.socket.send(JSON.stringify({ type: "selection", sceneId: "canvas", layerIds: ["instance-a"], componentPath: "component-title" }));
  const inheritedSelection = await nextMessage(sameNameTab, (message) => message.type === "selection" && message.id === ownerId, inheritedStart);
  assert.equal(inheritedSelection.componentPath, "component-title", "a valid inherited target is relayed");
  assert.deepEqual(inheritedSelection.layerIds, ["instance-a"]);
  await nextMessage(late, (message) => message.type === "selection" && message.id === ownerId && message.componentPath === "component-title");

  const cursorStart = sameNameTab.received.length;
  const ownerCursorStart = owner.received.length;
  const lateCursorStart = late.received.length;
  owner.socket.send(JSON.stringify({ type: "cursor", sceneId: "canvas", x: 100, y: 80 }));
  const cursor = await nextMessage(sameNameTab, (message) => message.type === "cursor" && message.id === ownerId, cursorStart);
  assert.deepEqual({ x: cursor.x, y: cursor.y, sceneId: cursor.sceneId, name: cursor.name, color: cursor.color }, {
    x: 100, y: 80, sceneId: "canvas", name: "Renamed tab", color: ownerPerson.color,
  });
  await nextMessage(late, (message) => message.type === "cursor" && message.id === ownerId, lateCursorStart);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(owner.received.slice(ownerCursorStart).some((message) => message.type === "cursor" && message.id === ownerId), false,
    "cursor relays do not echo to their sender");
  const pingStart = owner.received.length;
  owner.socket.send(JSON.stringify({ type: "ping" }));
  await nextMessage(owner, (message) => message.type === "pong", pingStart);

  async function rejectedWithoutRelay(input) {
    const errorStart = owner.received.length;
    const tabStart = sameNameTab.received.length;
    const lateStart = late.received.length;
    owner.socket.send(JSON.stringify(input));
    await nextMessage(owner, (message) => message.type === "error" && message.error === "Invalid collaboration message.", errorStart);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sameNameTab.received.slice(tabStart).some((message) => message.type === input.type), false, "invalid input is not relayed");
    assert.equal(late.received.slice(lateStart).some((message) => message.type === input.type), false, "invalid input is not broadcast to other sessions");
  }

  await rejectedWithoutRelay({ type: "selection", sceneId: "foreign-scene", layerIds: ["foreign-layer"] });
  await rejectedWithoutRelay({ type: "selection", sceneId: "canvas", layerIds: ["foreign-layer"] });
  await rejectedWithoutRelay({ type: "selection", sceneId: "canvas", layerIds: Array(10_000).fill("x") });
  await rejectedWithoutRelay({ type: "selection", sceneId: "canvas", layerIds: ["instance-a"], componentPath: "missing-layer" });
  await rejectedWithoutRelay({ type: "selection", sceneId: "canvas", layerIds: ["layer-a", "layer-b"], componentPath: "component-title" });
  await rejectedWithoutRelay({ type: "cursor", sceneId: "canvas", x: 1_000_001, y: 80 });
  await rejectedWithoutRelay({ type: "cursor", sceneId: "foreign-scene", x: 100, y: 80 });

  const beforeEphemeral = await server.api(`/api/projects/${projectId}`).then((response) => response.json());
  assert.equal(beforeEphemeral.revision, created.revision, "presence, selection, cursor and ping do not revise the document");

  const layerSelectionStart = sameNameTab.received.length;
  owner.socket.send(JSON.stringify({ type: "selection", sceneId: "canvas", layerIds: ["layer-a"] }));
  await nextMessage(sameNameTab, (message) => message.type === "selection" && message.id === ownerId && message.layerIds?.[0] === "layer-a", layerSelectionStart);
  const beforeLayerDelete = await server.api(`/api/projects/${projectId}`).then((response) => response.json());
  const withoutLayer = structuredClone(beforeLayerDelete.document);
  const canvas = withoutLayer.scenes.find((scene) => scene.id === "canvas");
  canvas.layers = canvas.layers.filter((layer) => layer.id !== "layer-a");
  const layerCorrectionStart = sameNameTab.received.length;
  const layerUpdate = await expectStatus(await server.api(`/api/projects/${projectId}`, {
    method: "PUT",
    body: { document: withoutLayer, revision: beforeLayerDelete.revision },
  }), 200, "owner deletes the selected layer");
  const layerCorrection = await nextMessage(sameNameTab, (message) => message.type === "selection" && message.id === ownerId &&
    message.sceneId === "canvas" && Array.isArray(message.layerIds) && message.layerIds.length === 0, layerCorrectionStart);
  assert.equal(layerCorrection.sceneId, "canvas", "deleting a layer keeps the selected scene");

  const sceneSelectionStart = sameNameTab.received.length;
  owner.socket.send(JSON.stringify({ type: "selection", sceneId: "canvas", layerIds: ["layer-b"] }));
  await nextMessage(sameNameTab, (message) => message.type === "selection" && message.id === ownerId && message.layerIds?.[0] === "layer-b", sceneSelectionStart);
  const beforeSceneDelete = await server.api(`/api/projects/${projectId}`).then((response) => response.json());
  const withoutScene = structuredClone(beforeSceneDelete.document);
  withoutScene.scenes = withoutScene.scenes.filter((scene) => scene.id !== "canvas");
  const sceneCorrectionStart = sameNameTab.received.length;
  await expectStatus(await server.api(`/api/projects/${projectId}`, {
    method: "PUT",
    body: { document: withoutScene, revision: beforeSceneDelete.revision },
  }), 200, "owner deletes the selected scene");
  const sceneCorrection = await nextMessage(sameNameTab, (message) => message.type === "selection" && message.id === ownerId &&
    message.sceneId === null && Array.isArray(message.layerIds) && message.layerIds.length === 0, sceneCorrectionStart);
  assert.equal(sceneCorrection.sceneId, null);

  const otherWatcher = await openSocket(server, otherViewLink, sessions);
  const otherJoined = await joinAndReadPresence(otherWatcher, otherProjectId, "other-tab", "Other viewer");
  const moveStartA = sameNameTab.received.length;
  const moveStartB = otherWatcher.received.length;
  const moved = await joinAndReadPresence(owner, otherProjectId, "same-tab-id", "Renamed tab");
  await nextMessage(sameNameTab, (message) => message.type === "presence" && message.selfId === tabId &&
    !message.people.some((person) => person.id === ownerId), moveStartA);
  await nextMessage(otherWatcher, (message) => message.type === "presence" && message.selfId === otherJoined.selfId &&
    message.people.some((person) => person.id === moved.selfId), moveStartB);

  const crossProjectSelectionStart = otherWatcher.received.length;
  const primarySelectionStart = sameNameTab.received.length;
  const primaryLateSelectionStart = late.received.length;
  owner.socket.send(JSON.stringify({ type: "selection", sceneId: "other-scene", layerIds: ["foreign-layer"] }));
  await nextMessage(otherWatcher, (message) => message.type === "selection" && message.id === moved.selfId, crossProjectSelectionStart);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sameNameTab.received.slice(primarySelectionStart).some((message) => message.type === "selection"), false,
    "selection updates never cross project boundaries");
  assert.equal(late.received.slice(primaryLateSelectionStart).some((message) => message.type === "selection"), false,
    "another file's selection remains private to that file's sessions");

  const crossProjectStart = otherWatcher.received.length;
  const primaryTabStart = sameNameTab.received.length;
  const primaryLateStart = late.received.length;
  owner.socket.send(JSON.stringify({ type: "cursor", sceneId: "other-scene", x: 12, y: 18 }));
  await nextMessage(otherWatcher, (message) => message.type === "cursor" && message.id === moved.selfId, crossProjectStart);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sameNameTab.received.slice(primaryTabStart).some((message) => message.type === "cursor"), false,
    "cursor updates never cross project boundaries");
  assert.equal(late.received.slice(primaryLateStart).some((message) => message.type === "cursor"), false,
    "a second project session cannot observe the other project's cursor");

  const disconnectWatcher = await openSocket(server, otherViewLink, sessions);
  const disconnectWatcherJoined = await joinAndReadPresence(disconnectWatcher, otherProjectId, "disconnect-watcher", "Disconnect watcher");
  const disconnectId = (await nextMessage(disconnectWatcher, (message) => message.type === "presence" &&
    message.people.some((person) => person.name === "Other viewer"))).people.find((person) => person.name === "Other viewer").id;
  const disconnectStart = owner.received.length;
  await closeSocket(otherWatcher);
  await nextMessage(owner, (message) => message.type === "presence" && message.selfId === moved.selfId &&
    !message.people.some((person) => person.id === disconnectId), disconnectStart);

  const leaveStart = disconnectWatcher.received.length;
  owner.socket.send(JSON.stringify({ type: "leave" }));
  await nextMessage(disconnectWatcher, (message) => message.type === "presence" && message.selfId === disconnectWatcherJoined.selfId &&
    !message.people.some((person) => person.id === moved.selfId), leaveStart);

  const ownerBackOnPrimary = await joinAndReadPresence(owner, projectId, "same-tab-id", "Renamed tab");
  const revokeStart = owner.received.length;
  const closeSameNameTab = once(sameNameTab.socket, "close");
  const closeLate = once(late.socket, "close");
  await expectStatus(await server.api(`/api/projects/${projectId}/shares/${viewLink.grant.id}`, { method: "DELETE" }), 200, "owner revokes the view link");
  const [[sameNameCode], [lateCode]] = await Promise.all([closeSameNameTab, closeLate]);
  assert.equal(sameNameCode, 1008, "revocation closes every socket using the capability");
  assert.equal(lateCode, 1008, "a second tab using the same revoked capability also closes");
  await nextMessage(owner, (message) => message.type === "presence" && message.selfId === ownerBackOnPrimary.selfId &&
    message.people.length === 1 && message.people[0].id === ownerBackOnPrimary.selfId, revokeStart);

  const finalRecord = await server.api(`/api/projects/${projectId}`).then((response) => response.json());
  assert.equal(finalRecord.revision, layerUpdate.revision + 1, "only the two intentional document edits changed the revision");
});

test("a queued selection relay cannot leak through leave and rejoin on the same socket", async (t) => {
  const server = await startPresenceServer();
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) {
      if (session.socket.readyState !== WebSocket.CLOSED) session.socket.terminate();
    }
    await server.stop();
  });

  const projectId = "presence-queued-relay";
  await expectStatus(await server.api("/api/projects", {
    method: "POST",
    body: { document: collaborationDocument(projectId) },
  }), 201, "owner creates the project");
  const link = await expectStatus(await server.api(`/api/projects/${projectId}/shares`, {
    method: "POST",
    body: { role: "view", label: "viewer" },
  }), 201, "owner creates a view capability");

  const sender = await openSocket(server, null, sessions);
  const peer = await openSocket(server, link, sessions);
  const senderJoined = await joinAndReadPresence(sender, projectId, "queued-sender", "Sender");
  const senderId = senderJoined.selfId;
  const peerJoined = await joinAndReadPresence(peer, projectId, "queued-peer", "Peer");

  const startedAt = Date.now();
  for (let index = 0; index < 10; index += 1) {
    const layerId = index % 2 === 0 ? "layer-a" : "layer-b";
    const from = peer.received.length;
    sender.socket.send(JSON.stringify({ type: "selection", sceneId: "canvas", layerIds: [layerId] }));
    await nextMessage(peer, (message) => message.type === "selection" && message.id === senderId &&
      message.layerIds?.[0] === layerId, from);
  }
  const burstDurationMs = Date.now() - startedAt;
  assert.ok(burstDurationMs < 1000, `ten acknowledged relays must fit in the rolling one-second window (${burstDurationMs} ms)`);

  const afterBurst = peer.received.length;
  // The eleventh event is retained as the trailing selection because ten events have
  // already been acknowledged in the same rolling second.
  sender.socket.send(JSON.stringify({ type: "selection", sceneId: "canvas", layerIds: ["layer-a"] }));
  // Send leave and rejoin back-to-back. The former must cancel the queued event, and
  // the latter creates a different session identity on this same WebSocket.
  sender.socket.send(JSON.stringify({ type: "leave" }));
  const rejoined = await joinAndReadPresence(sender, projectId, "queued-sender", "Rejoined sender");
  assert.notEqual(rejoined.selfId, senderId);
  await nextMessage(peer, (message) => message.type === "presence" && message.selfId === peerJoined.selfId &&
    message.people.some((person) => person.id === rejoined.selfId && person.name === "Rejoined sender"), afterBurst);

  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(peer.received.slice(afterBurst).some((message) => message.type === "selection" && message.id === rejoined.selfId), false,
    "the old trailing relay does not appear under the socket's new identity after its timer would fire");
});
