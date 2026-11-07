import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { makeAnimatedGif } from "./media.test.support.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-test-viewer-owner-secret";

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

function textLayer(id, name, text, fontSource = "") {
  return createLayer("text", {
    id,
    name,
    text,
    fontFamily: "Inter",
    fontSource,
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 24,
    fill: "#171717",
    x: 8,
    y: 8,
    width: 280,
    height: 48,
  });
}

function fontDocument(id, name) {
  return createDocument({
    id,
    name,
    scenes: [createScene({
      id: `scene-${id}`,
      name: "Viewer font specimen",
      width: 320,
      height: 120,
      duration: 0.1,
      background: "#ffffff",
      layers: [textLayer(`${id}-base`, "Bundled Inter", "Bundled Inter 400")],
    })],
  });
}

test("viewer probes are document-free and shared fonts expose only the linked file's renderable faces", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-viewer-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  env.MOTION_DATA_DIR = dataDirectory;
  env.MOTION_HOST = "127.0.0.1";
  env.MOTION_API_PORT = String(port);
  env.MOTION_FONT_DOWNLOADS = "off";
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
    await expectStatus(response, 201, "owner creates a project");
    return response.json();
  }

  async function uploadFont(projectId, filename, bytes) {
    const response = await api(`/api/media?project=${encodeURIComponent(projectId)}`, {
      method: "POST",
      headers: { "Content-Type": "font/ttf", "X-File-Name": encodeURIComponent(filename) },
      body: bytes,
    });
    await expectStatus(response, 201, `owner uploads ${filename} to its project`);
    return response.json();
  }

  async function uploadMedia(projectId, filename, mime, bytes) {
    const response = await api(`/api/media?project=${encodeURIComponent(projectId)}`, {
      method: "POST",
      headers: { "Content-Type": mime, "X-File-Name": encodeURIComponent(filename) },
      body: bytes,
    });
    await expectStatus(response, 201, `owner uploads ${filename} to its project`);
    return response.json();
  }

  async function createShare(projectId, role) {
    const response = await api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role } });
    await expectStatus(response, 201, `owner creates ${role} access`);
    return response.json();
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();

  const projectId = "viewer-font-project";
  const privateProjectId = "owner-private-font-project";
  const initial = await createProject(fontDocument(projectId, "Viewer font specimen"));
  await createProject(fontDocument(privateProjectId, "Private workspace font"));
  const interBytes = await readFile(path.join(projectRoot, "assets/fonts/Inter-400.ttf"));
  const scopedFont = await uploadFont(projectId, "Viewer Imported Inter.ttf", interBytes);
  const privateFont = await uploadFont(privateProjectId, "Private Imported Inter.ttf", interBytes);
  const scopedGif = await uploadMedia(projectId, "Viewer preview.gif", "image/gif", makeAnimatedGif({
    width: 2,
    height: 2,
    frames: [{ delayCs: 10, color: [220, 30, 40] }],
  }));

  const withScopedFont = structuredClone(initial.document);
  withScopedFont.scenes[0].layers.push(textLayer(`${projectId}-custom`, "Scoped Inter", "Scoped Inter 400", scopedFont.src));
  const save = await api(`/api/projects/${projectId}`, {
    method: "PUT",
    body: { document: withScopedFont, revision: initial.revision },
  });
  await expectStatus(save, 200, "owner references the uploaded face in the shared document");
  const savedProject = await save.json();

  const view = await createShare(projectId, "view");
  const comment = await createShare(projectId, "comment");
  const edit = await createShare(projectId, "edit");
  const privateView = await createShare(privateProjectId, "view");

  async function probe(role, share) {
    const response = await api("/api/access", share ? { share } : {});
    await expectStatus(response, 200, `${role} access probe succeeds`);
    const value = await response.json();
    assert.deepEqual(Object.keys(value), ["access"], "the probe returns no project document or workspace list");
    assert.equal(value.access.role, role);
    assert.equal(Object.hasOwn(value, "document"), false);
    return value.access;
  }

  const ownerAccess = await probe("owner");
  assert.equal(ownerAccess.manageShares, true);
  assert.equal((await probe("view", view.token)).canEdit, false);
  assert.equal((await probe("comment", comment.token)).canComment, true);
  assert.equal((await probe("edit", edit.token)).canEdit, true);

  const unknownToken = `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.${"A".repeat(43)}`;
  await expectStatus(
    await api(`/api/access?share=${encodeURIComponent(unknownToken)}`),
    403,
    "an unknown capability cannot fall back to valid owner credentials",
  );

  const ownerFontRequest = await api("/api/shared-fonts");
  await expectStatus(ownerFontRequest, 403, "owner credentials alone cannot read a workspace-wide viewer font list");

  const posterUrl = `${scopedGif.src}/poster/0.png`;
  const posterResponse = await api(posterUrl, { share: view.token });
  await expectStatus(posterResponse, 200, "a file viewer can fetch an attached GIF poster");
  assert.match(posterResponse.headers.get("content-type") || "", /^image\/png\b/i);
  const posterBytes = Buffer.from(await posterResponse.arrayBuffer());
  assert.ok(posterBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "the poster response is real PNG data");
  await expectStatus(
    await api(posterUrl, { share: privateView.token }),
    403,
    "another project's capability cannot read the GIF poster",
  );
  await expectStatus(
    await api(`${scopedGif.src}/poster/86400001.png`, { share: view.token }),
    400,
    "poster times beyond the supported range are rejected",
  );
  await expectStatus(
    await api(`${posterUrl}?share=${encodeURIComponent(unknownToken)}`),
    403,
    "an unknown capability cannot use owner credentials to read a poster",
  );

  const fontsResponse = await api("/api/shared-fonts", { share: view.token });
  await expectStatus(fontsResponse, 200, "a viewer capability can load fonts needed by its document");
  const fontPayload = await fontsResponse.json();
  assert.deepEqual(Object.keys(fontPayload).sort(), ["errors", "fonts"]);
  assert.deepEqual(fontPayload.errors, []);
  assert.deepEqual(
    fontPayload.fonts.map((font) => font.src).sort(),
    ["/api/fonts/Inter-400.ttf", scopedFont.src].sort(),
    "only the referenced bundled face and that file's referenced upload are returned",
  );
  const bundledInter = fontPayload.fonts.find((font) => font.src === "/api/fonts/Inter-400.ttf");
  assert.equal(bundledInter.id, "bundled:Inter-400.ttf");
  assert.equal(bundledInter.family, "Inter");
  assert.equal(bundledInter.weight, 400);
  assert.equal(bundledInter.style, "normal");
  const customInter = fontPayload.fonts.find((font) => font.src === scopedFont.src);
  assert.equal(customInter.family, "Inter");
  assert.equal(customInter.weight, 400);
  assert.equal(customInter.style, "normal");
  assert.equal(fontPayload.fonts.some((font) => font.src === privateFont.src), false, "a different project's uploaded face stays private");
  for (const font of fontPayload.fonts) {
    assert.equal(Object.hasOwn(font, "font"), false);
    assert.equal(Object.hasOwn(font, "ranges"), false);
    assert.equal(Object.hasOwn(font, "colorReader"), false);
  }

  const unchangedSharedProject = await api("/api/shared-project", { share: view.token });
  await expectStatus(unchangedSharedProject, 200, "the established shared-project route remains available");
  assert.equal((await unchangedSharedProject.json()).document.id, projectId);
  const unchangedRevision = await api(`/api/projects/${projectId}`, { share: view.token }).then((response) => response.json());
  assert.equal(unchangedRevision.revision, savedProject.revision, "poster reads do not change the project revision");

  const revoked = await api(`/api/projects/${projectId}/shares/${view.grant.id}`, { method: "DELETE" });
  await expectStatus(revoked, 200, "owner revokes the viewer capability");
  await expectStatus(
    await api(`/api/access?share=${encodeURIComponent(view.token)}`),
    403,
    "a revoked capability cannot fall back to valid owner credentials",
  );
  await expectStatus(
    await api("/api/shared-fonts", { share: view.token }),
    403,
    "revocation immediately denies the shared font response",
  );
  await expectStatus(
    await api(posterUrl, { share: view.token }),
    403,
    "a revoked capability cannot use owner credentials to read a poster",
  );
});
