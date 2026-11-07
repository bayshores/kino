import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { createDocument, createLayer, createScene } from "../engine/model.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=",
  "base64",
);
const REQUEST_ID = "d9df9c48-63ec-4afd-99af-f738e0d470fa";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function waitForMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for a collaboration message.")), timeoutMs);
    const onMessage = data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (predicate(message)) finish(null, message);
    };
    const onError = error => finish(error);
    function finish(error, value) {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function startService(t) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-live-merge-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, MOTION_DATA_DIR: dataDirectory, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: String(port) };
  delete env.KINO_PUBLIC_URL;
  delete env.KINO_OWNER_TOKEN;
  delete env.KINO_DESKTOP;
  let child = null;
  let serverOutput = "";

  async function stop() {
    if (!child) return;
    const current = child;
    child = null;
    if (current.exitCode === null) {
      const exited = once(current, "exit");
      current.kill("SIGTERM");
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4_000).unref())]);
      if (current.exitCode === null) current.kill("SIGKILL");
    }
  }

  async function start() {
    serverOutput = "";
    child = spawn(process.execPath, ["backend/index.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
    child.stderr.on("data", chunk => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`HTTP service exited during startup. ${serverOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error(`HTTP service did not become ready: ${lastError?.message || serverOutput}`);
  }

  async function api(endpoint, { body, share, headers: extraHeaders, ...options } = {}) {
    const headers = new Headers(extraHeaders);
    let requestBody = body;
    if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    if (share) headers.set("X-Kino-Share", share);
    return fetch(`${baseUrl}${endpoint}`, { ...options, headers, body: requestBody });
  }

  t.after(async () => {
    await stop();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  await start();
  return { api, baseUrl, dataDirectory, restart: async () => { await stop(); await start(); }, start, stop };
}

async function responseJson(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, `expected HTTP ${status}; got ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function makeDocument(id, layers = [], name = id) {
  return createDocument({ id, name, scenes: [createScene({
    id: `scene-${id}`, name: "Scene", width: 64, height: 36, duration: 12, layers,
  })] });
}

function rectangle(id, properties = {}) {
  return createLayer("rectangle", { id, name: id, x: 1, y: 2, width: 12, height: 8, fill: "#3157a5", ...properties });
}

async function createProject(service, document) {
  return responseJson(await service.api("/api/projects", { method: "POST", body: { document } }), 201);
}

async function createShare(service, projectId, role = "edit") {
  return responseJson(await service.api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role } }), 201);
}

function updateLayerBody(revision, sceneId, layerId, properties, extra = {}) {
  return {
    revision,
    ...extra,
    operations: [{ type: "update_layer", sceneId, layerId, properties }],
  };
}

function animation(id) {
  return { id, name: id, kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 80 }, unit: "layer", stagger: 0, order: "forward" };
}

function group(id, memberId) {
  return { id, name: id, kind: "composed", start: 0, animations: [animation(memberId)] };
}

function moveGroupInto(document, ownerId, movingId) {
  const layers = document.scenes[0].layers;
  const animations = layers[0].animations;
  const movingIndex = animations.findIndex(item => item.id === movingId);
  const [moving] = animations.splice(movingIndex, 1);
  animations.find(item => item.id === ownerId).animations.push(moving);
}

test("real HTTP saves merge stale documents, replay operations durably, and enforce file scopes", async t => {
  const service = await startService(t);
  const { api } = service;

  const mergeProjectId = "live-merge-project";
  const base = makeDocument(mergeProjectId, [rectangle("main-layer"), rectangle("delete-layer", { x: 24 })], "Base title");
  const created = await createProject(service, base);

  const socket = new WebSocket(`${service.baseUrl.replace("http:", "ws:")}/collaboration`, { origin: service.baseUrl });
  t.after(() => { if (socket.readyState === WebSocket.OPEN) socket.close(); });
  await once(socket, "open");
  const joined = waitForMessage(socket, message => message.type === "presence" && message.selfId);
  socket.send(JSON.stringify({ type: "join", projectId: mergeProjectId, clientId: "merge-test", name: "Merge test" }));
  await joined;

  const incomingX = structuredClone(created.document);
  incomingX.scenes[0].layers[0].x = 10;
  const expectRev2 = waitForMessage(socket, message => message.type === "document" && message.revision === 2);
  const writeX = await responseJson(await api(`/api/projects/${mergeProjectId}`, {
    method: "PUT", body: { document: incomingX, revision: 1 },
  }));
  assert.equal(writeX.revision, 2);
  await expectRev2;

  const incomingY = structuredClone(created.document);
  incomingY.scenes[0].layers[0].y = 19;
  const expectRev3 = waitForMessage(socket, message => message.type === "document" && message.revision === 3);
  const mergedXY = await responseJson(await api(`/api/projects/${mergeProjectId}`, {
    method: "PUT", body: { document: incomingY, revision: 1 },
  }));
  assert.equal(mergedXY.merged, true);
  assert.deepEqual(mergedXY.conflicts, []);
  assert.equal(mergedXY.previousRevision, 2);
  assert.equal(mergedXY.document.scenes[0].layers[0].x, 10);
  assert.equal(mergedXY.document.scenes[0].layers[0].y, 19);
  await expectRev3;

  const conflictBase = structuredClone(mergedXY.document);
  const widthOurs = structuredClone(conflictBase);
  widthOurs.scenes[0].layers[0].width = 20;
  assert.equal((await responseJson(await api(`/api/projects/${mergeProjectId}`, {
    method: "PUT", body: { document: widthOurs, revision: 3 },
  }))).revision, 4);
  const widthLater = structuredClone(conflictBase);
  widthLater.scenes[0].layers[0].width = 31;
  const expectRev5 = waitForMessage(socket, message => message.type === "document" && message.revision === 5);
  const widthConflict = await responseJson(await api(`/api/projects/${mergeProjectId}`, {
    method: "PUT", body: { document: widthLater, revision: 3, actor: "merge-test" },
  }));
  assert.equal(widthConflict.merged, true);
  assert.equal(widthConflict.document.scenes[0].layers[0].width, 31, "later incoming value wins the same-property conflict");
  assert.ok(widthConflict.conflicts.some(conflict => conflict.path.join("/") === "scenes/scene-live-merge-project/layers/main-layer/width" && conflict.resolution === "ours"));
  const conflictBroadcast = await expectRev5;
  assert.equal(conflictBroadcast.author, "Merge test", "the save actor maps to its scoped session display name, not the server-generated presence ID");
  assert.ok(conflictBroadcast.conflicts.some(conflict => conflict.path.at(-1) === "width"), "the conflict is broadcast with the document update");

  const deleteBase = structuredClone(widthConflict.document);
  const deleteOurs = structuredClone(deleteBase);
  deleteOurs.scenes[0].layers = deleteOurs.scenes[0].layers.filter(layer => layer.id !== "delete-layer");
  assert.equal((await responseJson(await api(`/api/projects/${mergeProjectId}`, {
    method: "PUT", body: { document: deleteOurs, revision: 5 },
  }))).revision, 6);
  const editDeleted = structuredClone(deleteBase);
  editDeleted.scenes[0].layers.find(layer => layer.id === "delete-layer").x = 45;
  const expectRev7 = waitForMessage(socket, message => message.type === "document" && message.revision === 7);
  const deletionWins = await responseJson(await api(`/api/projects/${mergeProjectId}`, {
    method: "PUT", body: { document: editDeleted, revision: 5 },
  }));
  assert.equal(deletionWins.merged, true);
  assert.equal(deletionWins.document.scenes[0].layers.some(layer => layer.id === "delete-layer"), false);
  assert.ok(deletionWins.conflicts.some(conflict => conflict.resolution === "deleted" && conflict.path.includes("delete-layer")));
  assert.ok((await expectRev7).conflicts.some(conflict => conflict.resolution === "deleted"));

  const cycleId = "live-merge-cycle";
  const cycleBase = makeDocument(cycleId, [rectangle("cycle-layer", {
    animations: [group("group-a", "a-member"), group("group-b", "b-member")],
  })]);
  const cycleCreated = await createProject(service, cycleBase);
  const currentCycleBranch = structuredClone(cycleCreated.document);
  moveGroupInto(currentCycleBranch, "group-b", "group-a");
  assert.equal((await responseJson(await api(`/api/projects/${cycleId}`, {
    method: "PUT", body: { document: currentCycleBranch, revision: 1 },
  }))).revision, 2);
  const staleCycleBranch = structuredClone(cycleCreated.document);
  moveGroupInto(staleCycleBranch, "group-a", "group-b");
  const cycleResponse = await api(`/api/projects/${cycleId}`, {
    method: "PUT", body: { document: staleCycleBranch, revision: 1 },
  });
  assert.equal(cycleResponse.status, 409, "a merged Composed-group cycle is rejected as a conflict");
  assert.equal((await responseJson(await api(`/api/projects/${cycleId}`))).revision, 2, "a failed merge leaves the accepted branch intact");

  const operationsId = "live-merge-operations";
  const operationsCreated = await createProject(service, makeDocument(operationsId, [rectangle("operations-layer")]));
  const newerDocument = structuredClone(operationsCreated.document);
  newerDocument.scenes[0].layers[0].x = 8;
  assert.equal((await responseJson(await api(`/api/projects/${operationsId}`, {
    method: "PUT", body: { document: newerDocument, revision: 1 },
  }))).revision, 2);
  const rebasedOperation = await responseJson(await api(`/api/projects/${operationsId}/operations`, {
    method: "POST", body: updateLayerBody(1, `scene-${operationsId}`, "operations-layer", { y: 35 }),
  }));
  assert.equal(rebasedOperation.rebased, true);
  assert.equal(rebasedOperation.revision, 3);
  assert.equal(rebasedOperation.document.scenes[0].layers[0].x, 8);
  assert.equal(rebasedOperation.document.scenes[0].layers[0].y, 35);
  const invalidTarget = await api(`/api/projects/${operationsId}/operations`, {
    method: "POST", body: updateLayerBody(1, `scene-${operationsId}`, "deleted-target", { y: 99 }),
  });
  assert.equal(invalidTarget.status, 409, "an invalid stale operation is rejected against the current revision");
  assert.equal((await responseJson(await api(`/api/projects/${operationsId}`))).revision, 3);

  const requestIdProject = "live-merge-request-id";
  const requestProject = await createProject(service, makeDocument(requestIdProject, [rectangle("request-layer")]));
  const editLink = await createShare(service, requestIdProject, "edit");
  const requestBody = {
    revision: requestProject.revision,
    requestId: REQUEST_ID,
    operations: [{ type: "rename_project", name: "Idempotent title" }],
  };
  const firstOwnerResult = await responseJson(await api(`/api/projects/${requestIdProject}/operations`, { method: "POST", body: requestBody }));
  assert.equal(firstOwnerResult.revision, 2);

  const mismatch = await api(`/api/projects/${requestIdProject}/operations`, {
    method: "POST", body: { ...requestBody, operations: [{ type: "rename_project", name: "Different payload" }] },
  });
  assert.equal(mismatch.status, 400, "a request ID cannot be reused for a different same-scope payload");

  const ownerEdit = structuredClone(firstOwnerResult.document);
  ownerEdit.scenes[0].layers[0].x = 77;
  const ownerEditResult = await responseJson(await api(`/api/projects/${requestIdProject}`, {
    method: "PUT", body: { document: ownerEdit, revision: firstOwnerResult.revision },
  }));
  const firstGrantResult = await responseJson(await api(`/api/projects/${requestIdProject}/operations`, {
    method: "POST", share: editLink.token, body: requestBody,
  }));
  assert.equal(firstGrantResult.revision, ownerEditResult.revision + 1, "the same ID in a grant scope executes independently of the owner's receipt");
  assert.equal(firstGrantResult.rebased, true);
  assert.equal(firstGrantResult.document.scenes[0].layers[0].x, 77);
  const finalOwnerEdit = structuredClone(firstGrantResult.document);
  finalOwnerEdit.scenes[0].layers[0].y = 66;
  const latestRequestProject = await responseJson(await api(`/api/projects/${requestIdProject}`, {
    method: "PUT", body: { document: finalOwnerEdit, revision: firstGrantResult.revision },
  }));

  const historyId = "live-merge-history";
  const historyCreated = await createProject(service, makeDocument(historyId, [rectangle("history-layer")], "Revision 1"));
  let historyCurrent = historyCreated;
  let revisionTwo;
  for (let revision = 2; revision <= 51; revision += 1) {
    const next = structuredClone(historyCurrent.document);
    next.name = `Revision ${revision}`;
    historyCurrent = await responseJson(await api(`/api/projects/${historyId}`, {
      method: "PUT", body: { document: next, revision: revision - 1 },
    }));
    if (revision === 2) revisionTwo = structuredClone(historyCurrent.document);
  }
  assert.equal(historyCurrent.revision, 51);

  socket.close();
  await once(socket, "close");
  await service.restart();

  const ownerReplay = await responseJson(await api(`/api/projects/${requestIdProject}/operations`, { method: "POST", body: requestBody }));
  assert.deepEqual(ownerReplay, firstOwnerResult, "the owner gets its exact first operation result after later saves and restart");
  const grantReplay = await responseJson(await api(`/api/projects/${requestIdProject}/operations`, {
    method: "POST", share: editLink.token, body: requestBody,
  }));
  assert.deepEqual(grantReplay, firstGrantResult, "a grant's duplicate replays only that grant's first result after restart");
  const currentRequestProject = await responseJson(await api(`/api/projects/${requestIdProject}`));
  assert.equal(currentRequestProject.revision, latestRequestProject.revision, "replay never rewinds the current document");
  assert.equal(currentRequestProject.document.scenes[0].layers[0].y, 66);

  const expiredBase = structuredClone(historyCreated.document);
  expiredBase.name = "Too old";
  const oldRevision = await api(`/api/projects/${historyId}`, { method: "PUT", body: { document: expiredBase, revision: 1 } });
  assert.equal(oldRevision.status, 409, "a base older than the retained 50 revisions remains stale after restart");
  const retainedBase = structuredClone(revisionTwo);
  retainedBase.scenes[0].layers[0].x = 52;
  const retainedMerge = await responseJson(await api(`/api/projects/${historyId}`, {
    method: "PUT", body: { document: retainedBase, revision: 2 },
  }));
  assert.equal(retainedMerge.merged, true, "a retained historical base still merges after restart");
  assert.equal(retainedMerge.document.name, "Revision 51");
  assert.equal(retainedMerge.document.scenes[0].layers[0].x, 52);

  const mediaOwnerId = "live-media-owner";
  const mediaOwner = await createProject(service, makeDocument(mediaOwnerId));
  const uploaded = await responseJson(await api(`/api/media?project=${mediaOwnerId}`, {
    method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "foreign.png" }, body: PNG,
  }), 201);
  const mediaOwnerDocument = structuredClone(mediaOwner.document);
  mediaOwnerDocument.scenes[0].layers.push(createLayer("image", {
    id: "foreign-image", name: "Foreign image", x: 0, y: 0, width: 1, height: 1, src: uploaded.src,
  }));
  await responseJson(await api(`/api/projects/${mediaOwnerId}`, {
    method: "PUT", body: { document: mediaOwnerDocument, revision: mediaOwner.revision },
  }));

  const mediaProtectedId = "live-media-protected";
  const mediaProtected = await createProject(service, makeDocument(mediaProtectedId, [rectangle("protected-layer")]));
  const mediaEditLink = await createShare(service, mediaProtectedId, "edit");
  const ownerUpdate = structuredClone(mediaProtected.document);
  ownerUpdate.name = "Owner's current title";
  await responseJson(await api(`/api/projects/${mediaProtectedId}`, {
    method: "PUT", body: { document: ownerUpdate, revision: mediaProtected.revision },
  }));
  const foreignSource = structuredClone(mediaProtected.document);
  foreignSource.scenes[0].layers.push(createLayer("image", {
    id: "unauthorized-image", name: "Outside media", x: 0, y: 0, width: 1, height: 1, src: uploaded.src,
  }));
  foreignSource.name = "Attempted stale merge";
  const rejectedMediaMerge = await api(`/api/projects/${mediaProtectedId}`, {
    method: "PUT", share: mediaEditLink.token, body: { document: foreignSource, revision: mediaProtected.revision },
  });
  assert.equal(rejectedMediaMerge.status, 403, "a stale shared edit cannot introduce media from another project into a merge");
  const scopedRead = await api(uploaded.src, { share: mediaEditLink.token });
  assert.equal(scopedRead.status, 403, "the same grant cannot read the foreign media bytes");
  const unchangedMediaProject = await responseJson(await api(`/api/projects/${mediaProtectedId}`));
  assert.equal(unchangedMediaProject.revision, 2);
  assert.equal(unchangedMediaProject.document.name, "Owner's current title");
  assert.equal(unchangedMediaProject.document.scenes[0].layers.some(layer => layer.id === "unauthorized-image"), false);
});
