import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDocument } from "../engine/model.js";
import { requestJson } from "../frontend/request.js";
import { sameDocument } from "../engine/saveConnection.js";

const serverFile = fileURLToPath(new URL("./index.mjs", import.meta.url));
const projectRoot = path.resolve(path.dirname(serverFile), "..");
const HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

function makeServerEnv(dataDirectory, ownerToken, port) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    MOTION_HOST: HOST,
    MOTION_API_PORT: String(port),
    MOTION_DATA_DIR: dataDirectory,
    MOTION_FONT_DOWNLOADS: "off",
    KINO_OWNER_TOKEN: ownerToken,
    KINO_PUBLIC_URL: "",
  };
}

function launchServer(dataDirectory, ownerToken, port) {
  return fork(serverFile, [], {
    cwd: projectRoot,
    env: makeServerEnv(dataDirectory, ownerToken, port),
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Server startup timed out.")), STARTUP_TIMEOUT_MS);
    const onMessage = (message) => {
      if (message?.type === "kino-ready" || message?.type === "kino-startup-error") finish(null, message);
    };
    const onExit = (code, signal) => finish(new Error(`Server exited before startup (${code ?? signal ?? "unknown"}).`));
    const onError = (error) => finish(error);
    function finish(error, message) {
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) reject(error); else resolve(message);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref())]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit").catch(() => {});
    child.kill("SIGKILL");
    await Promise.race([killed, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
  }
}

function requestOptions(ownerToken, method = "GET", body) {
  return {
    method,
    headers: {
      "X-Kino-Owner": ownerToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function api(baseUrl, ownerToken, route, method = "GET", body, dependencies) {
  return requestJson(`${baseUrl}${route}`, requestOptions(ownerToken, method, body), dependencies);
}

function listenOnEphemeralPort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

test("pending saves survive a service restart and a lost acknowledgement retries on the fetched revision", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-connection-recovery-"));
  const ownerToken = randomBytes(32).toString("hex");
  const children = new Set();
  let occupiedPortServer = null;
  t.after(async () => {
    await Promise.all([...children].map(stopServer));
    if (occupiedPortServer?.listening) await new Promise((resolve) => occupiedPortServer.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  function start(port) {
    const child = launchServer(dataDirectory, ownerToken, port);
    children.add(child);
    return { child, startup: waitForStartup(child) };
  }
  async function stop(child) {
    await stopServer(child);
    children.delete(child);
  }

  const first = start(0);
  const firstReady = await first.startup;
  assert.equal(firstReady.type, "kino-ready");
  assert.equal(firstReady.host, HOST);
  assert.ok(Number.isInteger(firstReady.port) && firstReady.port > 0);
  const port = firstReady.port;
  const baseUrl = `http://${HOST}:${port}`;

  const initialDocument = createDocument();
  initialDocument.name = "Connection recovery base";
  const created = await api(baseUrl, ownerToken, "/api/projects", "POST", { document: initialDocument });
  assert.equal(created.revision, 1);
  const projectId = created.document.id;
  const baseDocument = created.document;

  const pending = structuredClone(baseDocument);
  pending.name = "Edit kept while the service is offline";
  await stop(first.child);

  await assert.rejects(
    api(baseUrl, ownerToken, `/api/projects/${projectId}`, "PUT", {
      document: pending, revision: created.revision,
    }, { timeoutMs: 2_000 }),
    (error) => error.kind === "network" && error.status === undefined,
    "an unreachable loopback server is classified as a network failure",
  );

  const restarted = start(port);
  const restartedReady = await restarted.startup;
  assert.deepEqual(restartedReady, { type: "kino-ready", host: HOST, port });
  const afterRestart = await api(baseUrl, ownerToken, `/api/projects/${projectId}`);
  assert.equal(afterRestart.revision, created.revision);
  assert.equal(sameDocument(afterRestart.document, baseDocument), true, "the offline save never reached the service");

  const firstSave = await api(baseUrl, ownerToken, `/api/projects/${projectId}`, "PUT", {
    document: pending, revision: afterRestart.revision,
  });
  assert.equal(firstSave.revision, afterRestart.revision + 1);
  assert.equal(sameDocument(firstSave.document, pending), true);

  const acknowledgedRecord = await api(baseUrl, ownerToken, `/api/projects/${projectId}`);
  const lastAttempt = structuredClone(acknowledgedRecord.document);
  lastAttempt.name = "Committed despite the lost response";
  let intercepted = false;
  const losePutResponse = async (url, options) => {
    const response = await fetch(url, options);
    if (!intercepted && options?.method === "PUT" && new URL(url).pathname === `/api/projects/${projectId}`) {
      intercepted = true;
      // Drain the real response body but simulate failure in the consumer's JSON read.
      await response.arrayBuffer();
      return { ok: response.ok, status: response.status, json: async () => { throw new Error("simulated lost acknowledgment"); } };
    }
    return response;
  };
  await assert.rejects(
    api(baseUrl, ownerToken, `/api/projects/${projectId}`, "PUT", {
      document: lastAttempt, revision: acknowledgedRecord.revision,
    }, { fetch: losePutResponse }),
    (error) => error.kind === "network" && error.status === 200,
    "a committed PUT with an unreadable response is classified as a lost acknowledgment",
  );
  assert.equal(intercepted, true);

  const newerPending = structuredClone(lastAttempt);
  newerPending.name = "Newer edit retained after reconciliation";
  const afterLostAck = await api(baseUrl, ownerToken, `/api/projects/${projectId}`);
  assert.equal(afterLostAck.revision, acknowledgedRecord.revision + 1);
  assert.equal(sameDocument(afterLostAck.document, lastAttempt), true);

  const secondSave = await api(baseUrl, ownerToken, `/api/projects/${projectId}`, "PUT", {
    document: newerPending, revision: afterLostAck.revision,
  });
  assert.equal(secondSave.revision, afterLostAck.revision + 1, "retry is based on the fetched post-commit revision");
  const persisted = await api(baseUrl, ownerToken, `/api/projects/${projectId}`);
  assert.equal(persisted.revision, secondSave.revision);
  assert.equal(sameDocument(persisted.document, newerPending), true);

  await stop(restarted.child);
  occupiedPortServer = net.createServer();
  const occupiedPort = await listenOnEphemeralPort(occupiedPortServer);
  const collision = start(occupiedPort);
  const collisionMessage = await collision.startup;
  assert.deepEqual(collisionMessage, { type: "kino-startup-error", code: "EADDRINUSE" });
  await stop(collision.child);
  await new Promise((resolve) => occupiedPortServer.close(resolve));
  occupiedPortServer = null;

  const freshPort = start(0);
  const freshReady = await freshPort.startup;
  assert.equal(freshReady.type, "kino-ready");
  assert.equal(freshReady.host, HOST);
  assert.ok(freshReady.port > 0);
  const afterFreshStart = await api(`http://${HOST}:${freshReady.port}`, ownerToken, `/api/projects/${projectId}`);
  assert.equal(afterFreshStart.revision, persisted.revision);
  assert.equal(sameDocument(afterFreshStart.document, newerPending), true);
});
