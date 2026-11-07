import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { createComponentInstance } from "../engine/linkedComponents.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerToken = "kino-test-rich-text-owner-token";
const projectId = "rich-text-project";
const fontProjectId = "rich-text-font-source";

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function textLayer(id, text, overrides = {}) {
  return createLayer("text", {
    id,
    name: id,
    x: 8,
    y: 6,
    width: 270,
    height: 42,
    text,
    textResize: "fixed",
    fontFamily: "Inter",
    fontSource: "",
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 28,
    letterSpacing: 0,
    fill: "#202020",
    textAlign: "left",
    verticalAlign: "middle",
    ...overrides,
  });
}

function richDocument() {
  const component = createScene({
    id: "rich-component",
    name: "Rich component",
    isComponent: true,
    width: 290,
    height: 54,
    backgroundEnabled: false,
    layers: [textLayer("component-title", "Ae\u0301Yo")],
  });
  const plainInstance = createComponentInstance(component, {
    id: "plain-instance",
    x: 18,
    y: 106,
    componentOverrides: { "component-title": { text: "Ae\u0301No" } },
  });
  const styledInstance = createComponentInstance(component, {
    id: "styled-instance",
    x: 18,
    y: 184,
    componentOverrides: { "component-title": {
      text: "Ae\u0301Go",
      textStyleRanges: [{ start: 3, end: 5, style: { fill: "#00aa55" } }],
    } },
  });
  const main = createScene({
    id: "rich-main",
    name: "Rich text page",
    width: 540,
    height: 270,
    duration: 1,
    background: "#ffffff",
    layers: [
      textLayer("range-title", "Ae\u0301Yo", { x: 18, y: 16, width: 500, height: 60, fontSize: 30 }),
      plainInstance,
      styledInstance,
      textLayer("validation-long-text", "x".repeat(4_200), { visible: false }),
    ],
  });
  return createDocument({ id: projectId, name: "Rich text integration", scenes: [main, component] });
}

function foreignFontProject() {
  return createDocument({
    id: fontProjectId,
    name: "Font source project",
    scenes: [createScene({ id: "font-source-scene", name: "Font source" })],
  });
}

async function countPaint(bytes) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const count = { red: 0, green: 0, blue: 0 };
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [r, g, b, a] = pixels.subarray(offset, offset + 4);
    if (a < 180) continue;
    if (r > 145 && g < 125 && b < 140) count.red++;
    if (r < 100 && g > 100 && b < 145) count.green++;
    if (r < 120 && g < 160 && b > 160) count.blue++;
  }
  return count;
}

function lottieFillColors(value, colors = []) {
  if (Array.isArray(value)) {
    for (const item of value) lottieFillColors(item, colors);
  } else if (value && typeof value === "object") {
    if (value.ty === "fl" && Array.isArray(value.c?.k) && value.c.k.length >= 3)
      colors.push(value.c.k.slice(0, 3));
    for (const item of Object.values(value)) lottieFillColors(item, colors);
  }
  return colors;
}

function hasColor(colors, expected) {
  return colors.some((color) => color.every((channel, index) => Math.abs(channel - expected[index]) < 0.015));
}

test("rich text ranges persist, render, respect component text overrides, and retain only authorized font media", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-rich-text-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of ["KINO_PUBLIC_URL", "KINO_SHARE_TOKEN"]) delete env[key];
  Object.assign(env, {
    MOTION_DATA_DIR: dataDirectory,
    MOTION_HOST: "127.0.0.1",
    MOTION_API_PORT: String(port),
    MOTION_FONT_DOWNLOADS: "off",
    KINO_OWNER_TOKEN: ownerToken,
  });
  const networkGuardPath = path.join(dataDirectory, "rich-text-network-guard.mjs");
  await writeFile(networkGuardPath, `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? input : input.url;
      const url = new URL(raw);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname))
        throw new Error("Blocked external request in offline rich text integration test: " + url.origin);
      return originalFetch(input, init);
    };
  `);
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${pathToFileURL(networkGuardPath).href}`].filter(Boolean).join(" ");

  const fontBytes = await readFile(path.join(projectRoot, "assets/fonts/Inter-700.ttf"));
  let child = null;
  let childOutput = "";

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
    child.stdout.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-2_000); });
    child.stderr.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-2_000); });
    const deadline = Date.now() + 15_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Service exited during startup: ${childOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        const healthy = response.ok;
        await response.arrayBuffer();
        if (healthy) return;
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Service did not become ready: ${lastError?.message || childOutput}`);
  }

  async function api(endpoint, { owner = true, share, headers: extraHeaders, body: inputBody, ...options } = {}) {
    const headers = new Headers(extraHeaders);
    if (owner) headers.set("X-Kino-Owner", ownerToken);
    if (share) headers.set("X-Kino-Share", share);
    let body = inputBody;
    if (inputBody !== undefined && typeof inputBody !== "string" && !Buffer.isBuffer(inputBody)) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(inputBody);
    }
    return fetch(`${baseUrl}${endpoint}`, { ...options, headers, body });
  }

  async function json(response, status, reason) {
    const value = await response.json();
    assert.equal(response.status, status, `${reason}: ${value.error || "unexpected response status"}`);
    return value;
  }

  async function expectError(response, status, reason) {
    const value = await response.json();
    assert.equal(response.status, status, `${reason}: ${value.error || "unexpected response status"}`);
    assert.equal(typeof value.error, "string", `${reason} returns a readable error`);
    return value.error;
  }

  async function project(id = projectId, access = {}) {
    return json(await api(`/api/projects/${id}`, access), 200, `read ${id}`);
  }

  async function apply(revision, operations, access = {}) {
    return api(`/api/projects/${projectId}/operations`, {
      ...access,
      method: "POST",
      body: { revision, operations, actor: "rich-text-integration" },
    });
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  await json(await api("/api/projects", { method: "POST", body: { document: foreignFontProject() } }), 201, "create the font source project");
  const created = await json(await api("/api/projects", { method: "POST", body: { document: richDocument() } }), 201, "create the rich text project");
  const font = await json(await api(`/api/media?project=${encodeURIComponent(fontProjectId)}`, {
    method: "POST",
    headers: { "Content-Type": "font/ttf", "X-File-Name": "Shared Inter Bold.ttf" },
    body: fontBytes,
  }), 201, "upload an actual Inter font in a different project");

  const view = await json(await api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role: "view" } }), 201, "create a viewer link");
  const edit = await json(await api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role: "edit" } }), 201, "create an editor link");
  const rangeEdit = await json(await apply(created.revision, [
    { type: "style_text_range", sceneId: "rich-main", layerId: "range-title", start: 3, end: 5,
      style: { fontFamily: "Missing Typeface", fontSource: "", fontWeight: 700, fontSize: 36, fill: "#e02030", letterSpacing: 1.5 } },
    { type: "update_layer", sceneId: "rich-component", layerId: "component-title",
      properties: { textStyleRanges: [{ start: 3, end: 5, style: { fill: "#2255ee" } }] } },
    { type: "update_layer", sceneId: "rich-main", layerId: "range-title", properties: { textAlign: "center" } },
  ]), 200, "style Yo, add a component range, and center the layer in one save");
  assert.equal(rangeEdit.revision, created.revision + 1, "three operations produce one project revision");
  const mainAfterStyle = rangeEdit.document.scenes.find((scene) => scene.id === "rich-main");
  const richLayer = mainAfterStyle.layers.find((layer) => layer.id === "range-title");
  assert.equal(richLayer.textAlign, "center");
  assert.deepEqual([richLayer.textStyleRanges[0].start, richLayer.textStyleRanges[0].end], [3, 5], "UTF-16 offsets select Yo after a combining grapheme");
  assert.equal(richLayer.textStyleRanges[0].style.fill, "#e02030");
  assert.equal(richLayer.textStyleRanges[0].style.fontFamily, "Missing Typeface");
  assert.equal(mainAfterStyle.layers.find((layer) => layer.id === "plain-instance").componentOverrides["component-title"].text, "Ae\u0301No");
  assert.equal(Object.hasOwn(mainAfterStyle.layers.find((layer) => layer.id === "plain-instance").componentOverrides["component-title"], "textStyleRanges"), false,
    "a text-only component override follows the component range policy and clears its source range styles");
  assert.equal(mainAfterStyle.layers.find((layer) => layer.id === "styled-instance").componentOverrides["component-title"].textStyleRanges[0].style.fill, "#00aa55",
    "an explicit per-instance range override remains attached to the replacement text");

  const stableRevision = rangeEdit.revision;
  const rejectWithoutSave = async (label, operation) => {
    await expectError(await apply(stableRevision, [operation]), 400, label);
    assert.equal((await project()).revision, stableRevision, `${label} leaves the saved revision unchanged`);
  };
  await rejectWithoutSave("partial combining grapheme", {
    type: "style_text_range", sceneId: "rich-main", layerId: "range-title", start: 2, end: 5, style: { fill: "#ff0000" },
  });
  await rejectWithoutSave("overlapping style ranges", {
    type: "update_layer", sceneId: "rich-main", layerId: "validation-long-text", properties: {
      textStyleRanges: [
        { start: 0, end: 3, style: { fill: "#ff0000" } },
        { start: 2, end: 4, style: { fill: "#00ff00" } },
      ],
    },
  });
  await rejectWithoutSave("more than the supported range limit", {
    type: "update_layer", sceneId: "rich-main", layerId: "validation-long-text", properties: {
      textStyleRanges: Array.from({ length: 2_049 }, (_, index) => ({
        start: index * 2, end: index * 2 + 1, style: { fill: "#ff0000" },
      })),
    },
  });
  await rejectWithoutSave("remote font URL", {
    type: "style_text_range", sceneId: "rich-main", layerId: "range-title", start: 3, end: 5,
    style: { fontSource: "https://example.invalid/font.ttf" },
  });

  const foreignSourceAttempt = await apply(stableRevision, [{
    type: "style_text_range", sceneId: "rich-main", layerId: "range-title", start: 3, end: 5,
    style: { fontFamily: "Inter", fontSource: font.src },
  }], { owner: false, share: edit.token });
  await expectError(foreignSourceAttempt, 403, "an edit link cannot borrow another project's font file");
  assert.equal((await project()).revision, stableRevision, "the rejected cross-project source does not change the document");

  const replaced = await json(await apply(stableRevision, [{
    type: "style_text_range", sceneId: "rich-main", layerId: "range-title", start: 3, end: 5,
    style: { fontFamily: "Inter", fontSource: font.src },
  }]), 200, "recover the missing range font from the authorized owner context");
  assert.equal(replaced.revision, stableRevision + 1);
  const replacedMain = replaced.document.scenes.find((scene) => scene.id === "rich-main");
  const replacedRange = replacedMain.layers.find((layer) => layer.id === "range-title").textStyleRanges[0];
  assert.equal(replacedRange.style.fontFamily, "Inter");
  assert.equal(replacedRange.style.fontSource, font.src, "font recovery updates the nested range face");

  await stopServer();
  childOutput = "";
  await startServer();
  const reopened = await project();
  assert.equal(reopened.revision, replaced.revision);
  const reopenedMain = reopened.document.scenes.find((scene) => scene.id === "rich-main");
  const reopenedRich = reopenedMain.layers.find((layer) => layer.id === "range-title");
  assert.equal(reopenedRich.textAlign, "center");
  assert.deepEqual(reopenedRich.textStyleRanges, [replacedRange], "the style span and its face source persist across restart");
  assert.deepEqual(reopenedMain.layers.find((layer) => layer.id === "plain-instance").componentOverrides["component-title"], { text: "Ae\u0301No" });

  async function exportBytes(format) {
    const response = await api("/api/export", { owner: false, share: view.token, method: "POST", body: {
      document: reopened.document,
      sceneId: "rich-main",
      options: { format, width: 540, height: 270, size: "1x", time: 0, fps: 30 },
    } });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${format} export returns bytes (${bytes.toString("utf8", 0, 140)})`);
    return bytes;
  }
  const png = await exportBytes("png");
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const paint = await countPaint(png);
  assert.ok(paint.red > 20, "PNG contains actual glyph pixels with the saved red Yo style");
  assert.ok(paint.green > 20, "the component's explicit instance range style is painted");
  assert.equal(paint.blue, 0, "the text-only instance override does not inherit stale source range styling");

  const lottie = JSON.parse((await exportBytes("lottie")).toString("utf8"));
  assert.ok(lottie.layers.some((layer) => layer.ty === 4 && layer.shapes?.length), "Lottie contains actual vectorized text shapes");
  const colors = lottieFillColors(lottie);
  assert.ok(hasColor(colors, [224 / 255, 32 / 255, 48 / 255]), "Lottie paints the range's recovered red style");
  assert.ok(hasColor(colors, [0, 170 / 255, 85 / 255]), "Lottie paints the component instance's green range override");
  assert.equal(hasColor(colors, [34 / 255, 85 / 255, 238 / 255]), false, "Lottie honors text-only component override range policy");

  const readableWhileUsed = await api(font.src, { owner: false, share: view.token });
  assert.equal(readableWhileUsed.status, 200, "the project's viewer link may read the referenced font bytes");
  assert.deepEqual(Buffer.from(await readableWhileUsed.arrayBuffer()), fontBytes);

  const rangesWithoutSource = structuredClone(reopenedRich.textStyleRanges);
  delete rangesWithoutSource[0].style.fontSource;
  const detached = await json(await apply(reopened.revision, [{
    type: "update_layer", sceneId: "rich-main", layerId: "range-title", properties: { textStyleRanges: rangesWithoutSource },
  }]), 200, "remove the range's explicit media reference");
  assert.equal(detached.revision, reopened.revision + 1);
  const readableAfterRemoval = await api(font.src, { owner: false, share: view.token });
  assert.equal(readableAfterRemoval.status, 200, "the project retains its prior media permission after removing the range reference");
  assert.deepEqual(Buffer.from(await readableAfterRemoval.arrayBuffer()), fontBytes);
});
