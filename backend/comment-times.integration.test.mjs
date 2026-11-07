// A comment's time changed on its own: a PATCH with only `time`, through the real HTTP service.
// It keeps the thread's scene and canvas point, reaches every session over the WebSocket, is
// refused outside the scene's duration and for view links, and a scene made shorter later keeps
// the stored time.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { anchorTime } from "../frontend/comments.js";
import { createDocument, createScene } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

function waitForMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for a collaboration message.")), timeoutMs);
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(message)) finish(null, message);
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

test("a comment's time changes on its own, is checked against the scene, and reaches every session", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const document = createDocument({
    id: "comment-times",
    name: "Comment times",
    scenes: [createScene({ id: "main", name: "Main", width: 640, height: 360, duration: 4, background: "#ffffff", layers: [] })],
  });
  await expectStatus(await server.api("/api/projects", { method: "POST", body: { document } }), 201, "owner creates the project");
  const share = async (role) =>
    expectStatus(await server.api("/api/projects/comment-times/shares", { method: "POST", body: { role, label: role } }), 201, `owner creates a ${role} link`);
  const [viewLink, commentLink] = [await share("view"), await share("comment")];
  const comments = "/api/projects/comment-times/comments";
  const as = (link) => ({ owner: false, share: link.token });
  const stored = async (id) => (await expectStatus(await server.api(comments, as(viewLink)), 200, "read comments")).comments.find((comment) => comment.id === id);

  const port = new URL(server.baseUrl).port;
  const watcher = new WebSocket(`ws://127.0.0.1:${port}/collaboration?share=${encodeURIComponent(viewLink.token)}`, { origin: server.baseUrl });
  t.after(() => watcher.close());
  await once(watcher, "open");
  const joined = waitForMessage(watcher, (message) => message.type === "presence");
  watcher.send(JSON.stringify({ type: "join", projectId: "comment-times", clientId: "watcher", name: "Viewer" }));
  await joined;

  const root = await expectStatus(
    await server.api(comments, { ...as(commentLink), method: "POST", body: { text: "Slow this down", author: "Guest", sceneId: "main", x: 120, y: 80, time: 1 } }),
    201,
    "a comment link posts a timed comment",
  );

  // A marker dropped at 2.25 s: one PATCH with only the time.
  const live = waitForMessage(watcher, (message) => message.type === "comments" && message.comments.some((comment) => comment.id === root.id && comment.time === 2.25));
  const moved = await expectStatus(
    await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: 2.25 } }),
    200,
    "a comment link changes the time",
  );
  assert.deepEqual([moved.time, moved.sceneId, moved.x, moved.y, moved.text], [2.25, "main", 120, 80, "Slow this down"], "only the time changes");
  await live;
  assert.equal((await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: 1.0004 } }), 200, "rounded")).time, 1);
  assert.equal((await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: 4 } }), 200, "the scene's end")).time, 4);

  // Refused moves leave the stored time as it was, which is what the editor rolls back to.
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: 4.5 } }), 400, "past the scene's end");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: -0.1 } }), 400, "before the start");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: "2" } }), 400, "not a number");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(viewLink), method: "PATCH", body: { time: 2 } }), 403, "a view link cannot move a comment");
  assert.equal((await stored(root.id)).time, 4);

  // The owner makes the scene shorter: the comment keeps its stored time.
  const record = await expectStatus(await server.api("/api/projects/comment-times"), 200, "owner reads the project");
  const shorter = { ...record.document, scenes: record.document.scenes.map((scene) => ({ ...scene, duration: 2 })) };
  await expectStatus(await server.api("/api/projects/comment-times", { method: "PUT", body: { document: shorter, revision: record.revision } }), 200, "owner shortens the scene");
  assert.equal((await stored(root.id)).time, 4, "the stored time is not cut");
  await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: 3 } }), 400, "a new time must fit the shorter scene");
  assert.equal((await expectStatus(await server.api(`${comments}/${root.id}`, { ...as(commentLink), method: "PATCH", body: { time: 1.5 } }), 200, "a time inside it")).time, 1.5);
});

test("a comment moved to the end of a scene that is not a whole number of milliseconds is saved", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  // 20/3 typed in the Timeline's scene-duration field is stored as 6.6667 s.
  const duration = 6.6667;
  const scene = createScene({ id: "main", name: "Main", width: 640, height: 360, duration, background: "#ffffff", layers: [] });
  const document = createDocument({ id: "odd-length", name: "Odd length", scenes: [scene] });
  await expectStatus(await server.api("/api/projects", { method: "POST", body: { document } }), 201, "owner creates the project");
  const comments = "/api/projects/odd-length/comments";

  // Posted with the playhead at the scene's very end, as after playback stops there.
  const root = await expectStatus(
    await server.api(comments, { method: "POST", body: { text: "End frame", sceneId: "main", x: 10, y: 10, time: anchorTime(duration, scene) } }),
    201,
    "a comment at the scene's end",
  );
  assert.equal(root.time, 6.666);

  // Moved back, then to the end again: the end time is clamped and rounded as the server stores it.
  await expectStatus(await server.api(`${comments}/${root.id}`, { method: "PATCH", body: { time: 1 } }), 200, "moved to 1 s");
  const end = anchorTime(duration + 0.1, scene);
  assert.equal(end, 6.666);
  assert.equal((await expectStatus(await server.api(`${comments}/${root.id}`, { method: "PATCH", body: { time: end } }), 200, "moved to the end")).time, 6.666);
});
