import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { MAX_TIME } from "../engine/schema.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-test-owner-secret";
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=",
  "base64",
);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function expectStatus(response, status, reason) {
  if (response.status !== status) {
    const detail = await response.text();
    assert.equal(response.status, status, `${reason}: ${detail}`);
  }
}

function waitForMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for collaboration presence.")), timeoutMs);
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
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

function makeDocument(id, name) {
  return createDocument({
    id,
    name,
    scenes: [createScene({
      id: `scene-${id}`,
      name: "Scene 1",
      width: 32,
      height: 18,
      duration: 0.1,
      layers: [createLayer("rectangle", {
        id: `layer-${id}`,
        name: "Block",
        x: 2,
        y: 2,
        width: 12,
        height: 8,
        fill: "#633ae9",
      })],
    })],
  });
}

test("anonymous share roles enforce project, media, comment, export, and revocation access", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-share-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  env.MOTION_DATA_DIR = dataDirectory;
  env.MOTION_HOST = "127.0.0.1";
  env.MOTION_API_PORT = String(port);
  env.KINO_OWNER_TOKEN = ownerSecret;
  let child;
  let serverOutput = "";

  async function stopServer() {
    if (!child) return;
    const current = child;
    child = null;
    if (current.exitCode === null) {
      const exited = once(current, "exit");
      current.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4_000).unref())]);
      if (current.exitCode === null) current.kill("SIGKILL");
    }
  }

  async function startServer() {
    child = spawn(process.execPath, ["backend/index.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
    child.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Service exited during startup. ${serverOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Service did not become ready: ${lastError?.message || serverOutput}`);
  }

  async function api(endpoint, options = {}) {
    const {
      owner = true,
      share,
      headers: extraHeaders,
      body: inputBody,
      ...requestOptions
    } = options;
    const headers = new Headers(extraHeaders);
    if (owner) headers.set("X-Kino-Owner", ownerSecret);
    if (share) headers.set("X-Kino-Share", share);
    let requestBody = inputBody;
    if (inputBody !== undefined && typeof inputBody !== "string" && !Buffer.isBuffer(inputBody)) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(inputBody);
    }
    return fetch(`${baseUrl}${endpoint}`, { ...requestOptions, headers, body: requestBody });
  }

  async function createProject(document) {
    const response = await api("/api/projects", { method: "POST", body: { document } });
    await expectStatus(response, 201, "owner can create a project");
    return JSON.parse(await response.clone().text());
  }

  async function createShare(projectId, role, label = "") {
    const response = await api(`/api/projects/${projectId}/shares`, {
      method: "POST",
      body: { role, label },
    });
    await expectStatus(response, 201, `owner can create a ${role} link`);
    return response.json();
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  await expectStatus(await api("/api/projects", { owner: false }), 403, "workspace access needs a local owner key or a file link");

  await api("/api/folders", { method: "POST", body: { name: "Private folder" } }).then((response) => expectStatus(response, 201, "owner creates a folder"));
  const projectA = await createProject(makeDocument("shared-project", "Shared project"));
  await createProject(makeDocument("foreign-project", "Private project"));

  const sessionResponse = await api("/api/session", { method: "POST" });
  await expectStatus(sessionResponse, 200, "the configured owner can establish a browser session");
  const setCookie = sessionResponse.headers.get("set-cookie") || "";
  assert.match(setCookie, /^kino_owner=[a-f0-9-]{36};/);
  assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(setCookie, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(setCookie, /;\s*Path=\/(?:;|$)/i, "the session cookie covers the collaboration route");
  assert.doesNotMatch(setCookie, /;\s*Path=\/api(?:;|$)/i);
  const ownerCookie = setCookie.split(";")[0];

  const cookieProjectsResponse = await api("/api/projects", {
    owner: false,
    headers: { Cookie: ownerCookie },
  });
  await expectStatus(cookieProjectsResponse, 200, "the browser cookie authenticates project reads");
  const cookieProjects = await cookieProjectsResponse.json();
  assert.equal(cookieProjects.access.role, "owner");
  assert.deepEqual(cookieProjects.projects.map((project) => project.id).sort(), ["foreign-project", "shared-project"]);

  let ownerSocket;
  try {
    ownerSocket = new WebSocket(`ws://127.0.0.1:${port}/collaboration`, {
      origin: baseUrl,
      headers: { Cookie: ownerCookie },
    });
    await once(ownerSocket, "open");
    const ownerPresence = waitForMessage(ownerSocket, (message) => message.type === "presence" && message.selfId &&
      message.people?.some((person) => person.id === message.selfId && person.name === "Owner"));
    ownerSocket.send(JSON.stringify({
      type: "join",
      projectId: "shared-project",
      clientId: "cookie-owner",
      name: "Owner",
    }));
    const ownerJoined = await ownerPresence;
    assert.notEqual(ownerJoined.selfId, "cookie-owner", "the server assigns a per-socket session ID");
    assert.ok(ownerJoined.people.some((person) => person.id === ownerJoined.selfId && person.name === "Owner"),
      "the same cookie authorizes this named collaboration session without an owner header");
  } finally {
    if (ownerSocket && ownerSocket.readyState !== WebSocket.CLOSED) {
      const closed = once(ownerSocket, "close");
      ownerSocket.close();
      await closed;
    }
  }

  const viewLink = await createShare("shared-project", "view", "Read only");
  const commentLink = await createShare("shared-project", "comment", "Review");
  const editLink = await createShare("shared-project", "edit", "Collaborate");
  assert.ok(viewLink.token && commentLink.token && editLink.token, "the owner receives each bearer secret once");

  const ownerShareList = await api("/api/projects/shared-project/shares").then((response) => response.json());
  assert.equal(ownerShareList.shares.length, 3);
  for (const grant of ownerShareList.shares) {
    assert.equal("token" in grant, false);
    assert.equal("tokenHash" in grant, false);
  }

  const projectsViaQuery = await api(`/api/shared-project?share=${encodeURIComponent(viewLink.token)}`, { owner: false });
  await expectStatus(projectsViaQuery, 200, "a share URL opens without an account");
  const scopedList = JSON.parse(await projectsViaQuery.text());
  assert.equal(scopedList.document.id, "shared-project");
  assert.equal(scopedList.folders, undefined, "a single-file endpoint exposes no workspace folders");
  assert.equal(scopedList.access.role, "view");
  const headerOverridesOwnerCookie = await api("/api/shared-project", {
    owner: false,
    share: viewLink.token,
    headers: { Cookie: ownerCookie },
  });
  await expectStatus(headerOverridesOwnerCookie, 200, "a share header scopes a request that also has the owner cookie");
  const headerOverrideList = await headerOverridesOwnerCookie.json();
  assert.equal(headerOverrideList.access.role, "view");
  assert.equal(headerOverrideList.document.id, "shared-project");
  const queryOverridesOwnerCookie = await api(`/api/shared-project?share=${encodeURIComponent(viewLink.token)}`, {
    owner: false,
    headers: { Cookie: ownerCookie },
  });
  await expectStatus(queryOverridesOwnerCookie, 200, "a share query scopes a request that also has the owner cookie");
  const queryOverrideList = await queryOverridesOwnerCookie.json();
  assert.equal(queryOverrideList.access.role, "view");
  assert.equal(queryOverrideList.document.id, "shared-project");
  await expectStatus(await api("/api/projects/foreign-project", { owner: false, share: viewLink.token }), 403, "a share cannot read another project");
  await expectStatus(await api("/api/projects/shared-project/shares", { owner: false, share: viewLink.token }), 403, "a viewer cannot manage links");

  const projectResponse = await api("/api/projects/shared-project", { owner: false, share: viewLink.token });
  await expectStatus(projectResponse, 200, "a viewer can read the shared project");
  const sharedProject = await projectResponse.json();

  const ownerMediaA = await api("/api/media?project=shared-project", {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-File-Name": "shared.png" },
    body: pngBytes,
  }).then(async (response) => {
    await expectStatus(response, 201, "owner uploads media to the shared file");
    return response.json();
  });
  const foreignMedia = await api("/api/media?project=foreign-project", {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-File-Name": "private.png" },
    body: pngBytes,
  }).then(async (response) => {
    await expectStatus(response, 201, "owner uploads media to another file");
    return response.json();
  });
  const scopedMedia = await api("/api/media", { owner: false, share: viewLink.token });
  await expectStatus(scopedMedia, 200, "viewers can list attached media");
  const mediaList = await scopedMedia.json();
  assert.deepEqual(mediaList.media.map((media) => media.id), [ownerMediaA.id]);
  await expectStatus(await api(foreignMedia.src, { owner: false, share: viewLink.token }), 403, "a viewer cannot read another file's known media URL");

  await expectStatus(await api("/api/projects", { owner: false, share: viewLink.token }), 403, "single-file links cannot reach the file list");
  await expectStatus(await api("/api/projects", { owner: false, share: viewLink.token, method: "POST", body: { document: makeDocument("guest-project", "Guest project") } }), 403, "viewers cannot create projects");
  await expectStatus(await api("/api/projects/shared-project", {
    owner: false,
    share: viewLink.token,
    headers: { Cookie: ownerCookie },
    method: "PUT",
    body: { document: sharedProject.document, revision: sharedProject.revision },
  }), 403, "a view link cannot edit a document even when the owner cookie is also present");
  await expectStatus(await api("/api/projects/shared-project", { owner: false, share: viewLink.token, method: "DELETE" }), 403, "viewers cannot trash the shared file");
  await expectStatus(await api("/api/folders", { owner: false, share: viewLink.token, method: "POST", body: { name: "Guest folder" } }), 403, "viewers cannot create workspace folders");

  const commentDenied = await api("/api/projects/shared-project/comments", {
    owner: false,
    share: viewLink.token,
    method: "POST",
    body: { text: "Should be denied", sceneId: "scene-shared-project" },
  });
  await expectStatus(commentDenied, 403, "a view-only link cannot post comments");

  const guestCommentResponse = await api("/api/projects/shared-project/comments", {
    owner: false,
    share: commentLink.token,
    method: "POST",
    body: { text: "Anonymous review", sceneId: "scene-shared-project", x: 4, y: 5 },
  });
  await expectStatus(guestCommentResponse, 201, "a comment link can post without an account or display name");
  const guestComment = await guestCommentResponse.json();
  assert.equal(guestComment.author, "Guest");
  const persistedGuestComments = await api("/api/projects/shared-project/comments", { owner: false, share: viewLink.token }).then((response) => response.json());
  assert.equal(persistedGuestComments.comments[0].id, guestComment.id);
  assert.equal(persistedGuestComments.comments[0].author, "Guest");
  await expectStatus(await api(`/api/projects/shared-project/comments/${guestComment.id}`, {
    owner: false,
    share: viewLink.token,
    method: "PATCH",
    body: { resolved: true },
  }), 403, "a view-only link cannot resolve comments");
  const resolveResponse = await api(`/api/projects/shared-project/comments/${guestComment.id}`, {
    owner: false,
    share: commentLink.token,
    method: "PATCH",
    body: { resolved: true },
  });
  await expectStatus(resolveResponse, 200, "a comment link can resolve comments");
  assert.equal((await resolveResponse.json()).resolved, true);
  await expectStatus(await api("/api/projects/shared-project", {
    owner: false,
    share: commentLink.token,
    method: "PUT",
    body: { document: sharedProject.document, revision: sharedProject.revision },
  }), 403, "comment access does not permit document edits");

  const exportResponse = await api("/api/export", {
    owner: false,
    share: viewLink.token,
    method: "POST",
    body: {
      document: sharedProject.document,
      sceneId: "scene-shared-project",
      options: { format: "png", width: 32, height: 18, time: 0 },
    },
  });
  await expectStatus(exportResponse, 200, "a viewer can export the shared file");
  const exportedPng = Buffer.from(await exportResponse.arrayBuffer());
  assert.deepEqual(exportedPng.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(exportedPng.length > 60, "the real render endpoint returns PNG image data");
  await expectStatus(await api("/api/export", {
    owner: false,
    share: viewLink.token,
    method: "POST",
    body: {
      document: sharedProject.document,
      sceneId: "scene-shared-project",
      options: { format: "png", width: 32, height: 18, time: 0, duration: MAX_TIME + 1 },
    },
  }), 400, "export duration is rejected above the 600 second (ten minute) limit before rendering");
  await expectStatus(await api("/api/export", {
    owner: false,
    share: viewLink.token,
    method: "POST",
    body: {
      document: makeDocument("foreign-project", "Private project"),
      sceneId: "scene-foreign-project",
      options: { format: "png", width: 32, height: 18, time: 0 },
    },
  }), 403, "a viewer cannot export another project's document");

  const editRecord = await api("/api/projects/shared-project", { owner: false, share: editLink.token }).then((response) => response.json());
  const editedDocument = structuredClone(editRecord.document);
  editedDocument.name = "Edited through anonymous link";
  const editResponse = await api("/api/projects/shared-project", {
    owner: false,
    share: editLink.token,
    method: "PUT",
    body: { document: editedDocument, revision: editRecord.revision },
  });
  await expectStatus(editResponse, 200, "an edit link can persist a document change");
  const editedRecord = await editResponse.json();
  assert.equal(editedRecord.document.name, "Edited through anonymous link");
  await expectStatus(await api("/api/projects/shared-project/shares", { owner: false, share: editLink.token }), 403, "edit links cannot manage other links");
  await expectStatus(await api(`/api/projects/shared-project/shares/${viewLink.grant.id}`, { owner: false, share: editLink.token, method: "DELETE" }), 403, "edit links cannot revoke other links");
  await expectStatus(await api("/api/projects/shared-project", { owner: false, share: editLink.token, method: "DELETE" }), 403, "edit links cannot trash the project");

  const forgedDocument = structuredClone(editedRecord.document);
  forgedDocument.scenes[0].layers.push(createLayer("image", {
    id: "foreign-media-layer",
    name: "Other file media",
    src: foreignMedia.src,
    width: 4,
    height: 4,
  }));
  await expectStatus(await api("/api/projects/shared-project", {
    owner: false,
    share: editLink.token,
    method: "PUT",
    body: { document: forgedDocument, revision: editedRecord.revision },
  }), 403, "an editor cannot attach media from another project");
  const stillClean = await api("/api/projects/shared-project", { owner: false, share: editLink.token }).then((response) => response.json());
  assert.equal(stillClean.revision, editedRecord.revision, "the rejected cross-project media reference does not save");
  assert.equal(stillClean.document.scenes[0].layers.some((layer) => layer.id === "foreign-media-layer"), false);

  const uploadedByEditor = await api("/api/media", {
    owner: false,
    share: editLink.token,
    method: "POST",
    headers: { "Content-Type": "image/png", "X-File-Name": "guest-upload.png" },
    body: pngBytes,
  });
  await expectStatus(uploadedByEditor, 201, "an edit link can upload media to its own project");
  const uploadedMetadata = await uploadedByEditor.json();
  const editorMediaList = await api("/api/media", { owner: false, share: editLink.token }).then((response) => response.json());
  assert.ok(editorMediaList.media.some((media) => media.id === uploadedMetadata.id));

  const malformed = await api("/api/projects", { owner: false, share: `${viewLink.token.slice(0, -1)}!` });
  await expectStatus(malformed, 403, "malformed bearer links are rejected");

  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration?share=${encodeURIComponent(viewLink.token)}`, { origin: baseUrl });
    await once(socket, "open");
    const presence = waitForMessage(socket, (message) => message.type === "presence" && message.selfId &&
      message.people?.some((person) => person.id === message.selfId && person.name === "Guest"));
    socket.send(JSON.stringify({
      type: "join",
      projectId: "shared-project",
      clientId: "anonymous-reviewer",
      name: "Guest",
    }));
    const guestJoined = await presence;
    assert.notEqual(guestJoined.selfId, "anonymous-reviewer", "the server assigns the guest session ID");
    assert.ok(guestJoined.people.some((person) => person.id === guestJoined.selfId && person.name === "Guest"),
      "a valid anonymous link can join collaboration with the requested display name");
    const closed = once(socket, "close");
    const revokeResponse = await api(`/api/projects/shared-project/shares/${viewLink.grant.id}`, { method: "DELETE" });
    await expectStatus(revokeResponse, 200, "the owner can revoke a link");
    const revokedGrant = await revokeResponse.json();
    assert.ok(revokedGrant.grant.revokedAt);
    const [closeCode] = await closed;
    assert.equal(closeCode, 1008, "revocation closes connected sockets with a policy code");
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  await expectStatus(await api("/api/projects/shared-project", { owner: false, share: viewLink.token }), 403, "revoked links immediately lose HTTP access");
  await expectStatus(await api("/api/projects?share=not-a-token", { owner: false }), 403, "unknown secrets cannot open the workspace");

  const joinRaceLink = await createShare("shared-project", "view", "Join race");
  let joinRaceSocket;
  try {
    joinRaceSocket = new WebSocket(`ws://127.0.0.1:${port}/collaboration?share=${encodeURIComponent(joinRaceLink.token)}`, { origin: baseUrl });
    await once(joinRaceSocket, "open");
    const unexpectedMessages = [];
    joinRaceSocket.on("message", (data) => {
      try { unexpectedMessages.push(JSON.parse(data.toString())); } catch { /* Ignore non-JSON protocol data. */ }
    });
    const joinRaceClosed = once(joinRaceSocket, "close");
    const revokeBeforeJoin = await api(`/api/projects/shared-project/shares/${joinRaceLink.grant.id}`, { method: "DELETE" });
    await expectStatus(revokeBeforeJoin, 200, "the owner revokes the link after upgrade but before join");
    joinRaceSocket.send(JSON.stringify({
      type: "join",
      projectId: "shared-project",
      clientId: "revoked-before-join",
      name: "Guest",
    }));
    const [joinRaceCode] = await joinRaceClosed;
    assert.equal(joinRaceCode, 1008, "join rechecks the revoked link and closes the socket");
    assert.equal(unexpectedMessages.some((message) => message.type === "presence"), false, "a revoked link never joins or receives presence");
  } finally {
    if (joinRaceSocket && joinRaceSocket.readyState !== WebSocket.CLOSED) joinRaceSocket.terminate();
  }

  const grantFile = await readFile(path.join(dataDirectory, "shares.json"), "utf8");
  for (const token of [viewLink.token, commentLink.token, editLink.token, joinRaceLink.token]) {
    assert.equal(grantFile.includes(token), false, "persistent share state never contains a bearer secret");
  }

  await stopServer();
  await startServer();
  await expectStatus(await api("/api/projects/shared-project", { owner: false, share: viewLink.token }), 403, "revocation survives server restart");
  const reopenedEdit = await api("/api/projects/shared-project", { owner: false, share: editLink.token });
  await expectStatus(reopenedEdit, 200, "a still-active bearer link remains valid after restart");
  assert.equal((await reopenedEdit.json()).document.name, "Edited through anonymous link");
  const persistedComments = await api("/api/projects/shared-project/comments", { owner: false, share: commentLink.token }).then((response) => response.json());
  assert.equal(persistedComments.comments[0].author, "Guest");
});
