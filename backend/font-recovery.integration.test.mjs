import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { createComponentInstance } from "../engine/linkedComponents.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-test-font-recovery-owner-secret";
const projectId = "font-recovery-project";
const foreignProjectId = "font-recovery-foreign-project";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function expectStatus(response, status, reason, { consume = true } = {}) {
  if (response.status !== status) {
    const detail = await response.text();
    assert.equal(response.status, status, `${reason}: ${detail}`);
  }
  if (consume) await response.arrayBuffer();
}

async function imageHasInk(bytes) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  for (let offset = 0; offset < pixels.length; offset += 4)
    if (pixels[offset + 3] > 0 && (pixels[offset] < 245 || pixels[offset + 1] < 245 || pixels[offset + 2] < 245)) return true;
  return false;
}

function lottiePathVertices(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) lottiePathVertices(item, result);
  } else if (value && typeof value === "object") {
    if (typeof value.c === "boolean" && Array.isArray(value.v) &&
        value.v.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) result.push(value.v);
    for (const item of Object.values(value)) lottiePathVertices(item, result);
  }
  return result;
}

function text(id, name, fontFamily, y, extra = {}) {
  return createLayer("text", {
    id,
    name,
    x: 24,
    y,
    width: 260,
    height: 44,
    text: "Font recovery text",
    fontFamily,
    fontSource: "",
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 24,
    textResize: "fixed",
    fill: "#181818",
    ...extra,
  });
}

function recoveryDocument() {
  const component = createScene({
    id: "font-component",
    name: "Font component",
    isComponent: true,
    width: 260,
    height: 104,
    layers: [
      text("inherited-missing", "Inherited missing title", "Missing Typeface", 8),
      text("override-base", "Overridden type", "Inter", 54),
    ],
  });
  const firstPage = createScene({
    id: "font-scene-one",
    name: "First font scene",
    width: 640,
    height: 420,
    duration: 1,
    background: "#ffffff",
    layers: [
      text("direct-one", "Direct missing face", "Missing Typeface", 12),
      createComponentInstance(component, {
        id: "inherited-instance",
        x: 330,
        y: 10,
        componentOverrides: { "inherited-missing": { text: "Inherited copy" } },
      }),
      createComponentInstance(component, {
        id: "override-instance",
        x: 330,
        y: 140,
        componentOverrides: { "override-base": { fontFamily: "Missing Typeface" } },
      }),
      text("legacy-explicit", "Old explicit source reference", "Legacy Family Filename", 245),
      text("legacy-alias", "Filename alias reference", "Acme Text Bold", 295, { fontWeight: 700 }),
      text("same-family-source", "Exact same-family source", "Inter", 345, { fontWeight: 700 }),
    ],
  });
  const secondPage = createScene({
    id: "font-scene-two",
    name: "Second font scene",
    width: 420,
    height: 100,
    duration: 1,
    background: "#ffffff",
    layers: [text("direct-two", "Locked missing face", "Missing Typeface", 10, { locked: true })],
  });
  return createDocument({ id: projectId, name: "Font recovery integration", scenes: [component, firstPage, secondPage] });
}

test("font recovery reports fallback, scopes uploaded sources, and replaces all stored references once", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-font-recovery-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of ["KINO_PUBLIC_URL", "KINO_SHARE_TOKEN"]) delete env[key];
  Object.assign(env, {
    MOTION_DATA_DIR: dataDirectory,
    MOTION_HOST: "127.0.0.1",
    MOTION_API_PORT: String(port),
    MOTION_FONT_DOWNLOADS: "off",
    KINO_OWNER_TOKEN: ownerSecret,
  });
  const networkGuardPath = path.join(dataDirectory, "font-recovery-network-guard.mjs");
  await writeFile(networkGuardPath, `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? input : input.url;
      const url = new URL(raw);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname))
        throw new Error("Blocked external request in offline font recovery integration test: " + url.origin);
      return originalFetch(input, init);
    };
  `);
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${pathToFileURL(networkGuardPath).href}`].filter(Boolean).join(" ");

  const regularFont = await readFile(path.join(projectRoot, "assets/fonts/Inter-400.ttf"));
  const boldFont = await readFile(path.join(projectRoot, "assets/fonts/Inter-700.ttf"));
  let child = null;
  let serverOutput = "";
  let serverStderr = "";
  let phase = "initializing fixture server";

  function childDiagnostics() {
    const state = child
      ? `exitCode=${child.exitCode ?? "running"}, signal=${child.signalCode ?? "none"}`
      : "not running";
    const stderr = serverStderr
      .replaceAll(ownerSecret, "[redacted]")
      .replaceAll(dataDirectory, "[temporary-data]")
      .replace(/((?:owner|share)?token|secret)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]")
      .trim()
      .slice(-1_600);
    return `phase=${phase}; child=${state}${stderr ? `; stderr=${stderr}` : ""}`;
  }

  async function stopServer() {
    if (!child) return;
    const current = child;
    child = null;
    if (current.exitCode === null && current.signalCode === null) {
      const exited = once(current, "exit");
      current.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4_000).unref())]);
      if (current.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
    }
  }

  async function startServer() {
    phase = "starting service child";
    child = spawn(process.execPath, ["backend/index.mjs"], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
    child.stderr.on("data", (chunk) => { serverStderr = `${serverStderr}${chunk}`.slice(-4_000); });
    const deadline = Date.now() + 15_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Service exited during startup (${childDiagnostics()}). ${serverOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        const healthy = response.ok;
        await response.arrayBuffer();
        if (healthy) {
          phase = "service ready";
          return;
        }
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Service did not become ready: ${lastError?.message || serverOutput}; ${childDiagnostics()}`);
  }

  async function api(endpoint, { owner = true, share, headers: extraHeaders, body: inputBody, ...options } = {}) {
    const headers = new Headers(extraHeaders);
    if (owner) headers.set("X-Kino-Owner", ownerSecret);
    if (share) headers.set("X-Kino-Share", share);
    let body = inputBody;
    if (inputBody !== undefined && typeof inputBody !== "string" && !Buffer.isBuffer(inputBody)) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(inputBody);
    }
    const method = String(options.method || "GET").toUpperCase();
    const requestPath = new URL(endpoint, baseUrl).pathname;
    phase = `request ${method} ${requestPath}`;
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, { ...options, headers, body });
      phase = `response ${method} ${requestPath} status=${response.status}`;
      return response;
    } catch (error) {
      throw new Error(`HTTP ${method} ${requestPath} failed (${childDiagnostics()})`, { cause: error });
    }
  }

  async function json(response, status, reason) {
    phase = `read JSON response: ${reason}`;
    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new Error(`Could not read JSON response for ${reason} (${childDiagnostics()})`, { cause: error });
    }
    assert.equal(response.status, status, `${reason}: ${JSON.stringify(result)}`);
    if (typeof result?.token === "string") {
      // Keep any minted capability values out of failure diagnostics.
      serverStderr = serverStderr.replaceAll(result.token, "[redacted]");
    }
    return result;
  }

  async function project(id, access = {}) {
    return json(await api(`/api/projects/${id}`, access), 200, `read ${id}`);
  }

  async function uploadFont(id, filename, bytes) {
    return json(await api(`/api/media?project=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "font/ttf", "X-File-Name": encodeURIComponent(filename) },
      body: bytes,
    }), 201, `upload ${filename}`);
  }

  async function exportResult(share, document, format) {
    phase = `export ${format} response body`;
    const response = await api("/api/export", {
      owner: false,
      share,
      method: "POST",
      body: { document, sceneId: "font-scene-one", options: { format, width: 640, height: 420, time: 0, fps: 30 } },
    });
    await expectStatus(response, 200, `export fallback and recovered text as ${format}`, { consume: false });
    const warningHeader = response.headers.get("X-Kino-Export-Warnings");
    try {
      return { bytes: Buffer.from(await response.arrayBuffer()), warnings: warningHeader ? JSON.parse(warningHeader) : [] };
    } catch (error) {
      throw new Error(`Could not consume ${format} export body (${childDiagnostics()})`, { cause: error });
    }
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  const created = await json(await api("/api/projects", { method: "POST", body: { document: recoveryDocument() } }), 201, "create a recovery project");
  await json(await api("/api/projects", { method: "POST", body: { document: createDocument({ id: foreignProjectId, name: "Foreign font source" }) } }), 201, "create a second project");

  const regular = await uploadFont(projectId, "Acme Text Regular.ttf", regularFont);
  const bold = await uploadFont(projectId, "Acme Text Bold.ttf", boldFont);
  const foreign = await uploadFont(foreignProjectId, "Foreign Inter Copy.ttf", regularFont);
  const withSources = structuredClone(created.document);
  const mainScene = withSources.scenes.find((scene) => scene.id === "font-scene-one");
  mainScene.layers.find((layer) => layer.id === "legacy-explicit").fontSource = regular.src;
  mainScene.layers.find((layer) => layer.id === "same-family-source").fontSource = bold.src;
  const savedSetup = await json(await api(`/api/projects/${projectId}`, {
    method: "PUT",
    body: { document: withSources, revision: created.revision },
  }), 200, "attach real uploaded sources and legacy family references");

  const view = await json(await api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role: "view" } }), 201, "create a viewer link");
  const edit = await json(await api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role: "edit" } }), 201, "create an editor link");
  const projectFonts = await json(await api("/api/fonts", { owner: false, share: view.token }), 200, "read project-scoped uploaded faces");
  const uploadedFaces = projectFonts.fonts.filter((face) => face.src === regular.src || face.src === bold.src);
  assert.equal(uploadedFaces.length, 2, "two uploads with the same internal family remain distinct faces");
  const regularEntry = uploadedFaces.find((face) => face.src === regular.src);
  const boldEntry = uploadedFaces.find((face) => face.src === bold.src);
  assert.deepEqual({ family: regularEntry.family, aliases: regularEntry.aliases, weight: regularEntry.weight }, {
    family: "Inter", aliases: ["Acme Text Regular"], weight: 400,
  });
  assert.deepEqual({ family: boldEntry.family, aliases: boldEntry.aliases, weight: boldEntry.weight }, {
    family: "Inter", aliases: ["Acme Text Bold"], weight: 700,
  });
  assert.equal(projectFonts.fonts.some((face) => face.src === foreign.src), false, "another project's same-family source is not registered");
  await expectStatus(await api(foreign.src, { owner: false, share: view.token }), 403, "a viewer cannot read another project's font bytes");

  const beforeMissing = await project(projectId);
  // One warning: the filename alias and the explicit legacy source both resolve; only Missing Typeface falls back.
  const fallbackPng = await exportResult(view.token, beforeMissing.document, "png");
  assert.equal(fallbackPng.warnings.filter((warning) => warning.code === "missing-font-fallback").length, 1);
  assert.match(fallbackPng.warnings[0].message, /Missing Typeface.*Inter/u);
  assert.equal(await imageHasInk(fallbackPng.bytes), true, "the PNG draws visible fallback glyph pixels");
  const fallbackLottie = await exportResult(view.token, beforeMissing.document, "lottie");
  assert.equal(fallbackLottie.warnings.filter((warning) => warning.code === "missing-font-fallback").length, 1);
  assert.ok(lottiePathVertices(JSON.parse(fallbackLottie.bytes.toString("utf8"))).length > 0, "the Lottie fallback contains real vector outlines");
  const unchangedAfterFallback = await project(projectId);
  assert.equal(unchangedAfterFallback.revision, beforeMissing.revision);
  assert.deepEqual(unchangedAfterFallback.document, beforeMissing.document, "fallback export does not rewrite missing font references");

  // Recovery is ordinary edits (agents: update_layer, set_font, set_component_overrides): every site in one revision.
  const recovery = (src) => [
    ...[["font-component", "inherited-missing"], ["font-scene-one", "direct-one"], ["font-scene-two", "direct-two"]].map(([sceneId, layerId]) =>
      ({ type: "update_layer", sceneId, layerId, properties: { fontFamily: "Inter", fontSource: src } })),
    { type: "set_component_overrides", sceneId: "font-scene-one", layerId: "override-instance",
      overrides: { "override-base": { fontFamily: "Inter", fontSource: src } } },
  ];
  const operations = (operations, share) => api(`/api/projects/${projectId}/operations`, {
    owner: false, share, method: "POST", body: { revision: beforeMissing.revision, operations, actor: "font-recovery-test" },
  });
  await expectStatus(await operations(recovery(regular.src), view.token), 403, "view links cannot replace font references");
  await expectStatus(await operations(recovery(foreign.src), edit.token), 403, "a project cannot replace its fonts from an unauthorized upload");
  const unchanged = await project(projectId);
  assert.equal(unchanged.revision, beforeMissing.revision);
  assert.deepEqual(unchanged.document, beforeMissing.document);

  const replaced = await json(await operations(recovery(regular.src), edit.token), 200, "replace all references with the authorized uploaded face");
  assert.equal(replaced.revision, beforeMissing.revision + 1, "all references update in one project revision");
  const componentAfter = replaced.document.scenes.find((scene) => scene.id === "font-component");
  assert.equal(componentAfter.layers.find((layer) => layer.id === "inherited-missing").fontSource, regular.src);
  const sceneOneAfter = replaced.document.scenes.find((scene) => scene.id === "font-scene-one");
  assert.equal(sceneOneAfter.layers.find((layer) => layer.id === "direct-one").fontSource, regular.src);
  assert.deepEqual(sceneOneAfter.layers.find((layer) => layer.id === "inherited-instance").componentOverrides, {
    "inherited-missing": { text: "Inherited copy" },
  }, "an inherited instance stays linked to its updated component source");
  assert.equal(sceneOneAfter.layers.find((layer) => layer.id === "override-instance").componentOverrides["override-base"].fontSource, regular.src);
  assert.equal(replaced.document.scenes.find((scene) => scene.id === "font-scene-two").layers[0].fontFamily, "Inter");

  await stopServer();
  serverOutput = "";
  serverStderr = "";
  phase = "restarting service child";
  await startServer();
  const reopened = await project(projectId, { owner: false, share: view.token });
  assert.equal(reopened.revision, replaced.revision);
  assert.deepEqual(reopened.document, replaced.document, "font references survive service restart");
  const afterRestartFonts = await json(await api("/api/fonts", { owner: false, share: view.token }), 200, "reload authorized uploaded faces");
  assert.ok(afterRestartFonts.fonts.some((face) => face.src === regular.src && face.family === "Inter"));
  assert.ok(afterRestartFonts.fonts.some((face) => face.src === bold.src && face.family === "Inter"));

  const recoveredPng = await exportResult(view.token, reopened.document, "png");
  assert.deepEqual(recoveredPng.warnings, [], "a resolved file exports without missing-font warnings after restart");
  assert.equal(await imageHasInk(recoveredPng.bytes), true);
  const recoveredLottie = await exportResult(view.token, reopened.document, "lottie");
  assert.deepEqual(recoveredLottie.warnings, []);
  assert.ok(lottiePathVertices(JSON.parse(recoveredLottie.bytes.toString("utf8"))).length > 0);
});
