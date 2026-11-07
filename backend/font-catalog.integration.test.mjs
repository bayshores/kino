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
import { createFontCatalog } from "./font-catalog.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-test-font-catalog-owner-secret";
const familyId = "fixture-sans";
const familyName = "Fixture Sans";
const version = "5.3.0";
const source = `/api/fonts/fs-${familyId}--${version}--400-normal.ttf`;
const catalogUrl = "https://api.fontsource.org/v1/fonts?type=google";
const detailUrl = `https://api.fontsource.org/v1/fonts/${familyId}`;
const faceUrl = `https://cdn.jsdelivr.net/fontsource/fonts/${familyId}@${version}/latin-400-normal.ttf`;

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

function jsonResponse(value, url) {
  const response = new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
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

function lottieLayers(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) lottieLayers(item, result);
  } else if (value && typeof value === "object") {
    if (Number.isFinite(value.ty)) result.push(value);
    for (const item of Object.values(value)) lottieLayers(item, result);
  }
  return result;
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

test("cached Fontsource faces stay local through project edits, sharing, and exports after restart", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-font-catalog-http-"));
  const bundledInter = await readFile(path.join(projectRoot, "assets/fonts/Inter-400.ttf"));
  const family = {
    id: familyId,
    family: familyName,
    type: "google",
    subsets: ["latin"],
    weights: [400],
    styles: ["normal"],
    defSubset: "latin",
    license: "OFL-1.1",
  };
  const details = {
    ...family,
    npmVersion: version,
    unicodeRange: { latin: "U+0000-024F" },
    variants: { 400: { normal: { latin: { url: { ttf: "/ignored-by-fixture.ttf" } } } } },
  };
  const fixtureCalls = [];
  const strictFixtureFetch = async (input, options = {}) => {
    const url = typeof input === "string" ? input : input.url;
    fixtureCalls.push(url);
    assert.equal(options.method, "GET", "Fontsource fixture requests use GET only");
    assert.equal(options.redirect, "error", "Fontsource fixture requests never follow redirects");
    if (url === catalogUrl) return jsonResponse([family], url);
    if (url === detailUrl) return jsonResponse(details, url);
    if (url === faceUrl) {
      const response = new Response(bundledInter, { status: 200, headers: { "content-type": "font/ttf" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`Unexpected external font fixture fetch: ${url}`);
  };
  const timestamp = Date.now();
  const seedCatalog = await createFontCatalog({ dataRoot: dataDirectory, fetchImpl: strictFixtureFetch, now: () => timestamp, enabled: true });
  const seededList = await seedCatalog.list();
  assert.deepEqual(seededList.families.map(({ id }) => id), [familyId]);
  assert.equal((await seedCatalog.detail(familyId)).version, version);
  const seededFace = await seedCatalog.ensureFace({ id: familyId, weight: 400, style: "normal", text: "Café" });
  assert.equal(seededFace.src, source);
  assert.deepEqual(fixtureCalls, [catalogUrl, detailUrl, faceUrl], "cache setup uses only its exact fixture responses");

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
  // A child-process guard makes an accidental non-local fetch fail inside the real service too.
  // The only HTTP used by this test process is its explicit loopback API traffic.
  const networkGuardPath = path.join(dataDirectory, "font-test-network-guard.mjs");
  await writeFile(networkGuardPath, `
    const fetchWithNetwork = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? input : input.url;
      const url = new URL(raw);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname))
        throw new Error("Blocked external network request in offline font catalog integration test: " + url.origin);
      return fetchWithNetwork(input, init);
    };
  `);
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${pathToFileURL(networkGuardPath).href}`].filter(Boolean).join(" ");

  let child = null;
  let serverOutput = "";
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
    child = spawn(process.execPath, ["backend/index.mjs"], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
    child.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
    const deadline = Date.now() + 15_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Service exited during startup. ${serverOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Service did not become ready: ${lastError?.message || serverOutput}`);
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
    return fetch(`${baseUrl}${endpoint}`, { ...options, headers, body });
  }
  async function json(response, status, reason) {
    const result = await response.json();
    assert.equal(response.status, status, `${reason}: ${JSON.stringify(result)}`);
    return result;
  }
  async function getProject(id, access = {}) {
    return json(await api(`/api/projects/${id}`, access), 200, "read project");
  }
  async function exportBytes(share, document, format) {
    const response = await api("/api/export", {
      owner: false,
      share,
      method: "POST",
      body: { document, sceneId: "font-scene", options: { format, width: 320, height: 160, time: 0, fps: 30 } },
    });
    await expectStatus(response, 200, `shared export returns real ${format} bytes`);
    return Buffer.from(await response.arrayBuffer());
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  const registryResponse = await api("/api/fonts");
  const registry = await json(registryResponse, 200, "read local fonts");
  const face = registry.fonts.find((item) => item.src === source);
  assert.ok(face, "the cached catalog face is registered under its logical source");
  assert.equal(face.family, familyName);
  assert.equal(face.weight, 400);
  assert.equal(face.style, "normal");
  assert.equal(face.subset, "latin");
  assert.equal(face.defaultSubset, "latin");
  assert.equal(face.unicodeRange, "U+0000-024F");
  assert.equal(face.packageVersion, version);
  assert.match(face.url, /^\/api\/fonts\/fs-cache-[a-f0-9]{64}\.ttf$/);
  for (const localUrl of [face.url, face.src]) {
    const bytes = await api(localUrl);
    await expectStatus(bytes, 200, `fetch cached font through ${localUrl}`);
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), bundledInter);
  }

  const initialLayer = createLayer("text", {
    id: "centered-title", name: "Centered title", text: "Café", fontFamily: "Inter", fontWeight: 400, fontStyle: "normal", fontSource: "",
    x: 54, y: 24, width: 212, height: 96, fontSize: 30, textResize: "width-height", textAlign: "center", verticalAlign: "middle",
  });
  const initialDocument = createDocument({ id: "catalog-font-project", name: "Offline font test", scenes: [createScene({
    id: "font-scene", name: "Font scene", width: 320, height: 160, duration: 2, background: "#ffffff", layers: [initialLayer],
  })] });
  const project = await json(await api("/api/projects", { method: "POST", body: { document: initialDocument } }), 201, "create isolated project");
  const changed = await json(await api(`/api/projects/${initialDocument.id}/operations`, {
    method: "POST",
    body: { revision: project.revision, operations: [{ type: "update_layer", sceneId: "font-scene", layerId: initialLayer.id,
      properties: { fontFamily: familyName, fontSource: source } }] },
  }), 200, "save the cached face on the text layer");
  assert.equal(changed.revision, project.revision + 1, "one font change makes one project revision");
  const changedText = changed.document.scenes[0].layers[0];
  assert.equal(changedText.fontFamily, familyName);
  assert.equal(changedText.fontSource, source);

  const view = await json(await api(`/api/projects/${initialDocument.id}/shares`, { method: "POST", body: { role: "view", label: "Cached font viewer" } }), 201, "create view link");
  const viewerFonts = await json(await api("/api/fonts", { owner: false, share: view.token }), 200, "viewer reads document font resources");
  assert.ok(viewerFonts.fonts.some((item) => item.family === familyName && item.src === source));

  await stopServer();
  serverOutput = "";
  await startServer();
  const png = await exportBytes(view.token, changed.document, "png");
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(png.length > 1_000, "PNG export contains the rendered text");
  assert.equal(await imageHasInk(png), true, "PNG has actual rendered glyph pixels from the cached face");

  const lottieBytes = await exportBytes(view.token, changed.document, "lottie");
  const lottie = JSON.parse(lottieBytes.toString("utf8"));
  const vectorLayers = lottieLayers(lottie).filter((layer) => layer.ty === 4);
  assert.ok(vectorLayers.length > 0, "Lottie represents cached font text as vector layers");
  assert.equal(lottieLayers(lottie).some((layer) => layer.ty === 5), false, "Lottie output does not depend on viewer-installed fonts");
  assert.ok(lottiePathVertices(vectorLayers).some((vertices) => vertices.length > 2), "cached font produces real glyph outlines");
});
