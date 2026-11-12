import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { createDocument, createLayer, createScene } from "../engine/model.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=",
  "base64",
);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function waitForMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out waiting for a collaboration message (received: ${seen.join(", ") || "none"}).`,
          ),
        ),
      timeoutMs,
    );
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      seen.push(message.type || "unknown");
      if (predicate(message)) finish(null, message);
    };
    const onError = (error) => finish(error);
    function finish(error, message) {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(message);
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

test("a server a test started stops when that test process is killed", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-orphan-"));
  const port = await freePort();
  // A stand-in test process: it starts the server, prints its pid, and is then killed outright.
  const script = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["backend/index.mjs"], { stdio: "ignore", env: { ...process.env, MOTION_DATA_DIR: ${JSON.stringify(dataDirectory)}, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: "${port}", KINO_EXIT_WITH_PARENT: "1" } }); console.log(child.pid); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ["-e", script], { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] });
  const [line] = await once(parent.stdout, "data");
  const pid = Number(String(line).trim());
  const running = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(running(), true);
  parent.kill("SIGKILL");
  for (let waited = 0; running() && waited < 8000; waited += 200) await new Promise((resolve) => setTimeout(resolve, 200));
  const left = running();
  if (left) process.kill(pid, "SIGKILL");
  await rm(dataDirectory, { recursive: true, force: true });
  assert.equal(left, false, "the server outlived the process that started it");
});

test("real HTTP service persists edits, merges stale writes, serves media, and broadcasts collaboration", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    MOTION_DATA_DIR: dataDirectory,
    MOTION_HOST: "127.0.0.1",
    MOTION_API_PORT: String(port),
  };
  let child;
  let serverOutput = "";

  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const current = child;
    current.kill("SIGTERM");
    await Promise.race([
      once(current, "exit"),
      new Promise((resolve) => setTimeout(resolve, 4_000).unref()),
    ]);
    if (current.exitCode === null) current.kill("SIGKILL");
    child = null;
  }

  async function startServer() {
    child = spawn(process.execPath, ["backend/index.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      serverOutput = `${serverOutput}${chunk}`.slice(-4_000);
    });
    child.stderr.on("data", (chunk) => {
      serverOutput = `${serverOutput}${chunk}`.slice(-4_000);
    });
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`Service exited during startup. ${serverOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          assert.deepEqual(await response.json(), {
            ready: true,
            version: "0.1.0",
            storage: "persistent",
            rendering: "ffmpeg",
          });
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Service did not become ready: ${lastError?.message || serverOutput}`,
    );
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  const document = createDocument({
    id: "http-integration-project",
    name: "Initial motion",
    scenes: [
      createScene({
        id: "scene-one",
        name: "Scene 1",
        width: 32,
        height: 18,
        duration: 0.1,
        layers: [
          createLayer("rectangle", {
            id: "layer-one",
            name: "Block",
            x: 1,
            y: 2,
            width: 12,
            height: 8,
            fill: "#633ae9",
          }),
        ],
      }),
    ],
  });

  const denied = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://attacker.invalid" },
  });
  assert.equal(denied.status, 403, "cross-origin API request is rejected");

  // "//" is not a URL: one such request once stopped the whole service.
  const badTarget = await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    let reply = "";
    socket.setEncoding("utf8").on("data", (chunk) => { reply += chunk; });
    socket.on("close", () => resolve(reply.split("\r\n")[0]));
    socket.on("error", () => resolve(""));
  });
  assert.equal(badTarget, "HTTP/1.1 400 Bad Request");
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200, "the service still answers after a bad request target");

  const folderResponse = await fetch(`${baseUrl}/api/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Real work" }),
  });
  assert.equal(folderResponse.status, 201);
  const folder = await folderResponse.json();

  const createResponse = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document, folderId: folder.id }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.revision, 1);
  assert.equal(created.folderId, folder.id);

  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration`, {
      origin: baseUrl,
    });
    await once(socket, "open");
    const presenceMessage = waitForMessage(
      socket,
      (message) => message.type === "presence" && message.selfId &&
        message.people.some((person) => person.id === message.selfId && person.name === "Integration test"),
    );
    socket.send(
      JSON.stringify({
        type: "join",
        projectId: document.id,
        clientId: "integration-client",
        name: "Integration test",
      }),
    );
    const presence = await presenceMessage;
    assert.notEqual(presence.selfId, "integration-client", "the server assigns presence identity instead of trusting clientId");
    assert.ok(presence.people.some((person) => person.id === presence.selfId && person.name === "Integration test"));

    const editedDocument = structuredClone(document);
    editedDocument.name = "Persisted motion";
    editedDocument.scenes[0].layers[0].x = 7;
    const documentBroadcast = waitForMessage(
      socket,
      (message) => message.type === "document",
    );
    const editResponse = await fetch(`${baseUrl}/api/projects/${document.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document: editedDocument,
        revision: created.revision,
        actor: "http-integration-test",
      }),
    });
    assert.equal(editResponse.status, 200);
    const edited = await editResponse.json();
    assert.equal(edited.revision, 2);
    const broadcast = await documentBroadcast;
    assert.equal(broadcast.revision, 2);
    assert.equal(broadcast.document.scenes[0].layers[0].x, 7);

    const stalePut = await fetch(`${baseUrl}/api/projects/${document.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document, revision: 1 }),
    });
    assert.equal(stalePut.status, 200);
    const staleMerged = await stalePut.json();
    assert.equal(staleMerged.merged, true);
    assert.equal(staleMerged.revision, 3);
    assert.equal(staleMerged.document.name, "Persisted motion");
    assert.equal(staleMerged.document.scenes[0].layers[0].x, 7);

    const staleOperation = await fetch(
      `${baseUrl}/api/projects/${document.id}/operations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: 1,
          operations: [{ type: "rename_project", name: "Stale overwrite" }],
        }),
      },
    );
    assert.equal(staleOperation.status, 200, "a valid operation can replay against a newer document");
    const staleOperationResult = await staleOperation.json();
    assert.equal(staleOperationResult.rebased, true);
    assert.equal(staleOperationResult.revision, 4);
    assert.equal(staleOperationResult.document.name, "Stale overwrite");

    const operationResponse = await fetch(
      `${baseUrl}/api/projects/${document.id}/operations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: 2,
          operations: [
            {
              type: "update_layer",
              sceneId: "scene-one",
              layerId: "layer-one",
              properties: { width: 19 },
            },
          ],
        }),
      },
    );
    assert.equal(operationResponse.status, 200);
    const operationResult = await operationResponse.json();
    assert.equal(operationResult.rebased, true);
    assert.equal(operationResult.revision, 5);
    assert.equal(operationResult.document.scenes[0].layers[0].width, 19);

    const commentResponse = await fetch(
      `${baseUrl}/api/projects/${document.id}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          author: "Integration test",
          text: "Saved comment",
          sceneId: "scene-one",
          x: 3,
          y: 4,
        }),
      },
    );
    assert.equal(commentResponse.status, 201);
    const comment = await commentResponse.json();
    const comments = await fetch(
      `${baseUrl}/api/projects/${document.id}/comments`,
    ).then((response) => response.json());
    assert.equal(comments.comments[0].id, comment.id);
    assert.equal(comments.comments[0].text, "Saved comment");

    const mediaResponse = await fetch(`${baseUrl}/api/media`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-File-Name": encodeURIComponent("pixel.png"),
      },
      body: pngBytes,
    });
    assert.equal(mediaResponse.status, 201);
    const media = await mediaResponse.json();
    assert.equal(media.size, pngBytes.length);
    const mediaList = await fetch(`${baseUrl}/api/media`).then((response) =>
      response.json(),
    );
    assert.equal(
      mediaList.media.some((item) => item.id === media.id),
      true,
    );
    const rangeResponse = await fetch(`${baseUrl}${media.src}`, {
      headers: { Range: "bytes=0-7" },
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(
      rangeResponse.headers.get("content-range"),
      `bytes 0-7/${pngBytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await rangeResponse.arrayBuffer()),
      pngBytes.subarray(0, 8),
    );

    const exportResponse = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scene: operationResult.document.scenes[0],
        options: { format: "png", width: 32, height: 18, time: 0 },
      }),
    });
    if (!exportResponse.ok)
      assert.fail(
        `PNG export failed (${exportResponse.status}): ${await exportResponse.text()}`,
      );
    assert.equal(exportResponse.headers.get("content-type"), "image/png");
    const exportedPng = Buffer.from(await exportResponse.arrayBuffer());
    assert.deepEqual(
      exportedPng.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.ok(
      exportedPng.length > 60,
      "export endpoint returns rendered PNG bytes",
    );

    const componentDocument = structuredClone(operationResult.document);
    const main = componentDocument.scenes[0];
    main.isComponent = true;
    componentDocument.scenes.push({...main, id:"linked-export-scene", name:"Linked export", isComponent:false, layers:[createLayer("component",{id:"linked-export-instance",componentSceneId:main.id,x:0,y:0})]});
    const linkedExport = await fetch(`${baseUrl}/api/export`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({document:componentDocument,sceneId:"linked-export-scene",options:{format:"png",width:32,height:18,time:0}}),
    });
    if (!linkedExport.ok) assert.fail(`Component export failed: ${await linkedExport.text()}`);
    const linkedPng=Buffer.from(await linkedExport.arrayBuffer());
    assert.deepEqual(linkedPng,exportedPng,"document export resolves the linked source before rasterization");

    const closed = once(socket, "close");
    socket.close();
    await closed;
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  await stopServer();
  await startServer();
  const persistedResponse = await fetch(
    `${baseUrl}/api/projects/${document.id}`,
  );
  assert.equal(persistedResponse.status, 200);
  const persisted = await persistedResponse.json();
  assert.equal(persisted.revision, 5);
  assert.equal(persisted.document.name, "Stale overwrite");
  assert.equal(persisted.document.scenes[0].layers[0].width, 19);
  assert.equal(persisted.folderId, folder.id);
  assert.equal(persisted.comments[0].text, "Saved comment");
  assert.equal(
    (await fetch(`${baseUrl}/api/media`).then((response) => response.json()))
      .media.length,
    1,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/projects`).then((response) => response.json()))
      .folders[0].id,
    folder.id,
  );
});
