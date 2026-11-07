import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDocument } from "../engine/model.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startApi(dataDirectory, ownerToken) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  delete env.KINO_SHARE_TOKEN;
  Object.assign(env, {
    MOTION_DATA_DIR: dataDirectory,
    MOTION_HOST: "127.0.0.1",
    MOTION_API_PORT: String(port),
    KINO_OWNER_TOKEN: ownerToken,
  });
  const child = spawn(process.execPath, ["backend/index.mjs"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-3000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-3000); });

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000).unref())]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`The test server exited during startup. ${output}`);
    }
    if (await fetch(`${baseUrl}/api/health`).then((response) => response.ok, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline) {
    await stop();
    throw new Error(`The test server did not start. ${output}`);
  }

  function api(endpoint, { owner = true, share, body, headers: extra, ...options } = {}) {
    const headers = new Headers(extra);
    if (owner) headers.set("X-Kino-Owner", ownerToken);
    if (share) headers.set("X-Kino-Share", share);
    let requestBody = body;
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    return fetch(`${baseUrl}${endpoint}`, { ...options, headers, body: requestBody });
  }
  return { baseUrl, api, stop, output: () => output };
}

async function expectStatus(response, status, label) {
  const text = await response.text();
  assert.equal(response.status, status, `${label}: ${text}`);
  return text ? JSON.parse(text) : null;
}

test("easing API is owner-only, copies values, is reachable by the agent, and persists across restart", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "kino-easing-api-"));
  const ownerToken = "kino-easing-library-test-owner";
  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.stop().catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const first = await startApi(dataDirectory, ownerToken);
  servers.push(first);
  assert.deepEqual((await expectStatus(await first.api("/api/easings"), 200, "owner lists empty library")).easings, []);
  await expectStatus(await first.api("/api/easings", { owner: false }), 403, "anonymous library read is denied");

  const document = createDocument({ id: "easing-project", name: "Project with easing" });
  const projectCreated = await expectStatus(await first.api("/api/projects", { method: "POST", body: { document } }), 201, "owner creates project");
  const saved = await expectStatus(await first.api("/api/easings", {
    method: "POST",
    body: { name: "Curve", easing: [0.2, 0.4, 0.8, 0.9], intensity: 25 },
  }), 201, "owner saves a copied easing");
  assert.match(saved.easing.id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.deepEqual(saved.easing, {
    id: saved.easing.id,
    name: "Curve",
    easing: [0.2, 0.4, 0.8, 0.9],
    intensity: 25,
  });
  const renamed = await expectStatus(await first.api(`/api/easings/${saved.easing.id}`, {
    method: "PATCH", body: { name: "Renamed" },
  }), 200, "owner renames easing");
  assert.equal(renamed.easing.name, "Renamed");
  await expectStatus(await first.api("/api/easings", {
    method: "POST", body: { name: "Invalid", easing: "linear", projectId: document.id },
  }), 400, "unexpected mutation fields are refused");
  await expectStatus(await first.api("/api/easings/missing-easing", {
    method: "PATCH", body: { name: "Missing" },
  }), 404, "missing easing rename is not found");
  await expectStatus(await first.api("/api/easings/missing-easing", { method: "DELETE" }), 404, "missing easing delete is not found");

  const grants = [];
  for (const role of ["view", "comment", "edit"]) {
    const link = await expectStatus(await first.api(`/api/projects/${document.id}/shares`, {
      method: "POST", body: { role, label: role },
    }), 201, `owner creates ${role} share link`);
    grants.push({ role, token: link.token });
  }
  for (const { role, token } of grants) {
    await expectStatus(await first.api("/api/easings", { owner: false, share: token }), 403, `${role} link cannot list library`);
    await expectStatus(await first.api("/api/easings", {
      owner: false, share: token, method: "POST", body: { name: "No", easing: "linear" },
    }), 403, `${role} link cannot save`);
    await expectStatus(await first.api(`/api/easings/${saved.easing.id}`, {
      owner: false, share: token, method: "PATCH", body: { name: "No" },
    }), 403, `${role} link cannot rename`);
    await expectStatus(await first.api(`/api/easings/${saved.easing.id}`, {
      owner: false, share: token, method: "DELETE",
    }), 403, `${role} link cannot delete`);
  }
  const projectBefore = await expectStatus(await first.api(`/api/projects/${document.id}`), 200, "owner reads project");
  assert.deepEqual(projectBefore.document, projectCreated.document, "library changes do not edit project data");
  assert.equal(projectBefore.revision, 1);

  // The agent reaches the library through project {action:"manage", options:{resource:"easings"}}.
  const easings = async (options) => {
    const reply = await expectStatus(await first.api("/api/agent/project", {
      method: "POST", body: { action: "manage", options: { resource: "easings", ...options } },
    }), 200, `agent easings ${options.action}`);
    assert.equal(reply.isError, undefined, reply.text);
    return reply.data;
  };
  assert.equal((await easings({ action: "list" })).easings.length, 1);
  const agentRecord = await easings({ action: "save", name: "Agent curve", easing: "linear", intensity: 50 });
  assert.deepEqual([agentRecord.name, agentRecord.easing, agentRecord.intensity], ["Agent curve", "linear", 50]);
  assert.equal((await easings({ action: "rename", id: agentRecord.id, name: "Agent renamed" })).name, "Agent renamed");
  assert.deepEqual(await easings({ action: "delete", id: agentRecord.id }), { deleted: agentRecord.id });
  assert.deepEqual((await easings({ action: "list" })).easings.map((easing) => easing.id), [saved.easing.id], "the agent's easing is deleted");

  await expectStatus(await first.api(`/api/easings/${saved.easing.id}`, { method: "DELETE" }), 200, "owner deletes first record");
  const persistent = await expectStatus(await first.api("/api/easings", {
    method: "POST", body: { name: "Across restart", easing: "linear" },
  }), 201, "owner creates restart fixture");
  await first.stop();

  const restarted = await startApi(dataDirectory, ownerToken);
  servers.push(restarted);
  assert.deepEqual((await expectStatus(await restarted.api("/api/easings"), 200, "owner lists after restart")).easings, [persistent.easing]);
});
