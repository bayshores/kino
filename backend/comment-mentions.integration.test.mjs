// @mentions through the real HTTP and WebSocket service: a display name in the presence list is
// the same name a comment's author and mentions may hold (up to 100 characters), so picking it
// from the @ list mentions that person.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createDocument, createScene } from "../engine/model.js";
import { mentionCandidates, mentionsInText, mentionsName } from "../frontend/mentions.js";
import { MAX_COMMENT_AUTHOR } from "./comments.mjs";
import { startTestServer } from "./media.test.support.mjs";

function waitForMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for a collaboration message.")), timeoutMs);
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
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

test("a long display name reaches the presence list whole, so picking it from the @ list mentions that person", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const document = createDocument({
    id: "mention-names",
    name: "Mentions",
    scenes: [createScene({ id: "main", name: "Main", width: 320, height: 180, duration: 2, background: "#ffffff", layers: [] })],
  });
  await expectStatus(await server.api("/api/projects", { method: "POST", body: { document } }), 201, "owner creates the project");
  const link = await expectStatus(
    await server.api("/api/projects/mention-names/shares", { method: "POST", body: { role: "comment", label: "comment" } }),
    201,
    "owner creates a comment link",
  );

  // Review finding: presence cut names to 60 characters while a display name may have 100, so the
  // @ list offered a shortened name that never matched the person's own name.
  const longName = `Carol ${"Longname".repeat(20)}`.slice(0, MAX_COMMENT_AUTHOR);
  assert.equal(longName.length, 100);
  const port = new URL(server.baseUrl).port;
  const carol = new WebSocket(`ws://127.0.0.1:${port}/collaboration?share=${encodeURIComponent(link.token)}`, { origin: server.baseUrl });
  t.after(() => carol.close());
  await once(carol, "open");
  const joined = waitForMessage(carol, (message) => message.type === "presence" && message.selfId &&
    message.people.some((person) => person.id === message.selfId && person.name === longName));
  carol.send(JSON.stringify({ type: "join", projectId: "mention-names", clientId: "carol", name: longName }));
  const joinedPresence = await joined;
  const carolId = joinedPresence.selfId;
  const { people } = joinedPresence;
  assert.notEqual(carolId, "carol", "the server assigns session identity instead of trusting clientId");
  assert.equal(people.find((person) => person.id === carolId).name, longName, "the session's presence keeps its whole name");

  // Another person picks Carol from the @ list (people in the file) and posts.
  const offered = mentionCandidates({ people, comments: [] });
  assert.deepEqual(offered, [longName]);
  const text = `@${longName} can you check the ending?`;
  const saved = await expectStatus(
    await server.api("/api/projects/mention-names/comments", {
      method: "POST",
      body: { text, author: "Ann", mentions: mentionsInText(text, offered), sceneId: "main", x: 10, y: 10, time: 0 },
    }),
    201,
    "the owner posts a comment that mentions Carol",
  );
  assert.deepEqual(saved.mentions, [longName]);
  assert.equal(mentionsName(saved, longName), true, "Carol's own display name is mentioned, so she sees Mentions you");

  // A name longer than a comment author may be is still cut, to the same limit.
  const renamed = waitForMessage(carol, (message) => message.type === "presence" && message.selfId === carolId &&
    message.people.some((person) => person.id === carolId && person.name !== longName));
  carol.send(JSON.stringify({ type: "join", projectId: "mention-names", clientId: "carol", name: `Z${longName}` }));
  assert.equal((await renamed).people.find((person) => person.id === carolId).name, `Z${longName}`.slice(0, MAX_COMMENT_AUTHOR));
});
