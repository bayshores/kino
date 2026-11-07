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
import { resolvePlayback } from "../engine/playback.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-test-font-owner-secret";
const familyA = "kino Imported Typeface";
const familyB = "Private Imported Typeface";

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

function textDocument(id, name, family = "Inter", fontSource = "") {
  return createDocument({
    id,
    name,
    scenes: [createScene({
      id: `scene-${id}`,
      name: "Font specimen",
      width: 320,
      height: 120,
      duration: 0.1,
      background: "#ffffff",
      layers: [createLayer("text", {
        id: `text-${id}`,
        name: "Imported type specimen",
        text: "Animated",
        fontFamily: family,
        fontSource,
        fontSize: 28,
        fontWeight: 400,
        x: 18,
        y: 24,
        width: 280,
        height: 56,
        fill: "#171717",
      })],
    })],
  });
}

function lottiePathVertices(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) lottiePathVertices(item, result);
  } else if (value && typeof value === "object") {
    if (
      typeof value.c === "boolean" &&
      Array.isArray(value.v) &&
      value.v.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
    ) result.push(value.v);
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

test("account-free file links load only attached font bytes for preview and real exports", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-font-share-"));
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
  const bundledFont = await readFile(path.join(projectRoot, "assets/fonts/Inter-400.ttf"));

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
    await expectStatus(response, 201, "owner creates a font project");
    return response.json();
  }

  async function uploadFont(projectId, filename) {
    const response = await api(`/api/media?project=${encodeURIComponent(projectId)}`, {
      method: "POST",
      headers: { "Content-Type": "font/ttf", "X-File-Name": encodeURIComponent(filename) },
      body: bundledFont,
    });
    await expectStatus(response, 201, `owner uploads the real font file ${filename}`);
    return response.json();
  }

  async function createShare(projectId, role) {
    const response = await api(`/api/projects/${projectId}/shares`, {
      method: "POST",
      body: { role },
    });
    await expectStatus(response, 201, `owner creates a ${role} link without account setup`);
    return response.json();
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  const projectA = await createProject(textDocument("font-project-a", "Uploaded font source"));
  await createProject(textDocument("font-project-b", "Another file"));

  const fontA = await uploadFont("font-project-a", `${familyA}.ttf`);
  const fontB = await uploadFont("font-project-b", `${familyB}.ttf`);
  const documentA = structuredClone(projectA.document);
  const textA = documentA.scenes[0].layers[0];
  textA.fontFamily = familyA;
  textA.fontSource = fontA.src;
  const saveA = await api("/api/projects/font-project-a", {
    method: "PUT",
    body: { document: documentA, revision: projectA.revision },
  });
  await expectStatus(saveA, 200, "owner assigns the uploaded face to the text layer");
  const savedA = await saveA.json();

  const projectB = await api("/api/projects/font-project-b").then((response) => response.json());
  const documentB = structuredClone(projectB.document);
  documentB.scenes[0].layers[0].fontFamily = familyB;
  documentB.scenes[0].layers[0].fontSource = fontB.src;
  const saveB = await api("/api/projects/font-project-b", {
    method: "PUT",
    body: { document: documentB, revision: projectB.revision },
  });
  await expectStatus(saveB, 200, "owner attaches the second real font to its own project");

  const copiedDocument = structuredClone(savedA.document);
  copiedDocument.id = "font-project-copy";
  copiedDocument.name = "Copied font project";
  const copiedProject = await createProject(copiedDocument);
  assert.equal(copiedProject.document.scenes[0].layers[0].fontSource, fontA.src);

  const viewA = await createShare("font-project-a", "view");
  const editA = await createShare("font-project-a", "edit");
  const viewCopy = await createShare("font-project-copy", "view");

  const catalogResponse = await api("/api/fonts", { owner: false, share: viewA.token });
  await expectStatus(catalogResponse, 200, "a viewer can load the attached font catalog");
  const catalog = await catalogResponse.json();
  const importedFace = catalog.fonts.find((font) => font.id === fontA.id);
  assert.ok(importedFace, "the imported font is listed for the shared project");
  assert.equal(importedFace.family, "Inter", "the font family uses its embedded canonical name");
  assert.ok(importedFace.aliases.includes(familyA), "legacy filename references keep an alias");
  assert.equal(importedFace.weight, 400);
  assert.equal(importedFace.style, "normal");
  assert.equal(importedFace.src, fontA.src);
  assert.deepEqual(catalog.errors, []);
  assert.equal(catalog.fonts.some((font) => font.id === fontB.id), false, "the other project's font is absent from this catalog");

  const previewBytesResponse = await api(fontA.src, { owner: false, share: viewA.token });
  await expectStatus(previewBytesResponse, 200, "a viewer can fetch the uploaded font bytes required for preview");
  assert.match(previewBytesResponse.headers.get("content-type") || "", /^font\/ttf\b/i);
  assert.deepEqual(Buffer.from(await previewBytesResponse.arrayBuffer()), bundledFont);
  await expectStatus(await api(fontB.src, { owner: false, share: viewA.token }), 403, "a viewer cannot fetch another project's known font URL");

  const bundledBytesResponse = await api("/api/fonts/Inter-400.ttf", { owner: false, share: viewA.token });
  await expectStatus(bundledBytesResponse, 200, "a viewer can fetch the real bundled Inter face");
  assert.deepEqual(Buffer.from(await bundledBytesResponse.arrayBuffer()), bundledFont);

  const forgedDocument = structuredClone(savedA.document);
  forgedDocument.scenes[0].layers[0].fontFamily = familyB;
  forgedDocument.scenes[0].layers[0].fontSource = fontB.src;
  const injectedFont = await api("/api/projects/font-project-a", {
    owner: false,
    share: editA.token,
    method: "PUT",
    body: { document: forgedDocument, revision: savedA.revision },
  });
  await expectStatus(injectedFont, 403, "an anonymous editor cannot attach a font from an unrelated project");
  const unchangedA = await api("/api/projects/font-project-a", { owner: false, share: viewA.token }).then((response) => response.json());
  assert.equal(unchangedA.revision, savedA.revision, "the rejected font reference does not persist");
  assert.equal(unchangedA.document.scenes[0].layers[0].fontSource, fontA.src);

  async function exportFontSpecimen(share, document, sceneId, format, exportOptions = {}) {
    const response = await api("/api/export", {
      owner: false,
      share,
      method: "POST",
      body: {
        document,
        sceneId,
        options: { format, width: 320, height: 120, time: 0, fps: 30, ...exportOptions },
      },
    });
    await expectStatus(response, 200, `the file viewer can export a real ${format} specimen`);
    return Buffer.from(await response.arrayBuffer());
  }

  const copyCatalog = await api("/api/fonts", { owner: false, share: viewCopy.token }).then((response) => response.json());
  assert.ok(copyCatalog.fonts.some((font) => font.id === fontA.id && font.aliases?.includes(familyA)), "a copied document's explicit font source carries permission to that referenced font");
  assert.equal(copyCatalog.fonts.some((font) => font.id === fontB.id), false);
  const copyPreviewBytes = await api(fontA.src, { owner: false, share: viewCopy.token });
  await expectStatus(copyPreviewBytes, 200, "the copied document's viewer can load its referenced font bytes");
  assert.deepEqual(Buffer.from(await copyPreviewBytes.arrayBuffer()), bundledFont);

  const lottieA = JSON.parse((await exportFontSpecimen(viewA.token, savedA.document, "scene-font-project-a", "lottie")).toString("utf8"));
  const lottieCopy = JSON.parse((await exportFontSpecimen(viewCopy.token, copiedProject.document, "scene-font-project-a", "lottie")).toString("utf8"));
  assert.equal(Object.hasOwn(lottieA, "fonts"), false, "outlined Lottie text does not depend on viewer-installed fonts");
  assert.equal(lottieA.layers.some((layer) => layer.ty === 5), false, "Lottie text is exported as portable vector shapes");
  const textShapeLayers = lottieA.layers.filter((layer) => layer.ty === 4 && String(layer.nm).startsWith("Imported type specimen"));
  assert.ok(textShapeLayers.length > 0, "Lottie contains the imported text as shape layers");
  const outlineVertices = lottiePathVertices(textShapeLayers);
  assert.ok(outlineVertices.length > 0 && outlineVertices.some((vertices) => vertices.length > 2), "the real font's glyph outlines produce nonempty vector paths");
  assert.deepEqual(lottieCopy.layers, lottieA.layers, "the copied project produces the same portable font outlines");

  const pngA = await exportFontSpecimen(viewA.token, savedA.document, "scene-font-project-a", "png");
  const pngCopy = await exportFontSpecimen(viewCopy.token, copiedProject.document, "scene-font-project-a", "png");
  assert.deepEqual(pngA.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(pngA.length > 1_000, "PNG export contains rendered text pixels");
  assert.deepEqual(pngCopy, pngA, "the owner copy renders the same attached font into real PNG bytes");

  const latestA = await api("/api/projects/font-project-a", { owner: false, share: editA.token }).then((response) => response.json());
  const componentDocument = structuredClone(latestA.document);
  const sourceSceneId = "font-component-source";
  const targetSceneId = "font-component-target";
  const originalTextId = "component-font-text";
  const instanceId = "font-component-instance";
  const componentText = createLayer("text", {
    id: originalTextId,
    name: "Animated imported type",
    text: "Animated",
    fontFamily: familyA,
    fontSource: fontA.src,
    fontSize: 28,
    x: 18,
    y: 24,
    width: 280,
    height: 56,
    animations: [{
      id: "component-letter-stagger",
      name: "Reveal each letter",
      kind: "custom",
      start: 0.1,
      duration: 0.3,
      easing: "linear",
      from: { opacity: 0 },
      to: { opacity: 1 },
      unit: "letters",
      stagger: 0.05,
      order: "forward",
    }],
  });
  const componentSource = createScene({
    id: sourceSceneId,
    name: "Animated font source",
    width: 320,
    height: 120,
    duration: 1.25,
    background: "#ffffff",
    isComponent: true,
    layers: [componentText],
  });
  const componentTarget = createScene({
    id: targetSceneId,
    name: "Animated font instance",
    width: 320,
    height: 120,
    duration: 2,
    background: "#ffffff",
    layers: [createLayer("component", {
      id: instanceId,
      name: "Imported font instance",
      componentSceneId: sourceSceneId,
      componentStart: 0.5,
      componentVisibility: "during",
      clipContent: false,
      x: 0,
      y: 0,
      width: 320,
      height: 120,
    })],
  });
  componentDocument.scenes.push(componentSource, componentTarget);
  const saveComponentDocument = await api("/api/projects/font-project-a", {
    owner: false,
    share: editA.token,
    method: "PUT",
    body: { document: componentDocument, revision: latestA.revision },
  });
  await expectStatus(saveComponentDocument, 200, "the edit link can save an animated source and linked instance using the imported family");
  const componentRecord = await saveComponentDocument.json();

  const linkedBefore = await exportFontSpecimen(editA.token, componentRecord.document, targetSceneId, "png", { time: 0.75, duration: 2 });
  const linkedBeforeStart = await exportFontSpecimen(editA.token, componentRecord.document, targetSceneId, "png", { time: 0.49, duration: 2 });
  assert.notDeepEqual(linkedBefore, linkedBeforeStart, "real component expansion shows the animated font only inside its playback window");

  const detachedResponse = await api("/api/projects/font-project-a/operations", {
    owner: false,
    share: editA.token,
    method: "POST",
    body: {
      revision: componentRecord.revision,
      operations: [{ type: "detach_component", sceneId: targetSceneId, layerId: instanceId }],
    },
  });
  await expectStatus(detachedResponse, 200, "an anonymous editor can detach the linked animated font through the real operations endpoint");
  const detachedRecord = await detachedResponse.json();
  const detachedTarget = detachedRecord.document.scenes.find((scene) => scene.id === targetSceneId);
  assert.ok(detachedTarget);
  assert.equal(detachedTarget.layers.some((layer) => layer.type === "component"), false, "the detached scene contains no linked component instance");
  const detachedText = detachedTarget.layers.find((layer) => layer.type === "text" && layer.fontFamily === familyA);
  assert.ok(detachedText, "the detached hierarchy contains an independent text layer");
  assert.notEqual(detachedText.id, originalTextId, "detach creates an independent layer ID");
  assert.equal(detachedText.fontSource, fontA.src, "detach preserves the imported font source");
  assert.equal(detachedText.componentOwnerId, undefined, "detach removes live component ownership metadata");
  assert.equal(detachedText.animations[0].unit, "letters");
  assert.equal(detachedText.animations[0].stagger, 0.05);
  assert.ok(Math.abs(detachedText.animations[0].start - 0.6) < 1e-9, "the source animation is offset to the instance start");

  const playbackWindow = detachedText.playbackWindows.find((window) => window.visibility === "during");
  assert.ok(playbackWindow, "the detached text retains its finite component playback window");
  assert.equal(playbackWindow.start, 0.5);
  assert.ok(Math.abs(playbackWindow.end - 1.25) < 1e-9, "window length includes letter stagger timing measured with the uploaded font");
  assert.equal(playbackWindow.hold, true);
  assert.equal(resolvePlayback(detachedText, 0.49).visible, false);
  assert.equal(resolvePlayback(detachedText, 0.75).visible, true);
  assert.equal(resolvePlayback(detachedText, 1.26).visible, false);

  const detachedPng = await exportFontSpecimen(editA.token, detachedRecord.document, targetSceneId, "png", { time: 0.75, duration: 2 });
  const detachedOutsideWindow = await exportFontSpecimen(editA.token, detachedRecord.document, targetSceneId, "png", { time: 0.49, duration: 2 });
  assert.deepEqual(detachedPng, linkedBefore, "the detached project preserves the same real animated font render inside the component window");
  assert.deepEqual(detachedOutsideWindow, linkedBeforeStart, "the detached project preserves visibility outside the component window");

  const detachedLottieBytes = await exportFontSpecimen(editA.token, detachedRecord.document, targetSceneId, "lottie", { duration: 2 });
  const detachedLottie = JSON.parse(detachedLottieBytes.toString("utf8"));
  const detachedVectorLayers = lottieLayers(detachedLottie);
  assert.equal(detachedVectorLayers.some((layer) => layer.ty === 5), false, "detached Lottie text does not depend on external fonts");
  const detachedOutlineLayer = detachedVectorLayers.find((layer) => layer.ty === 4 && String(layer.nm).startsWith("Animated imported type"));
  assert.ok(detachedOutlineLayer, "detached letter animation exports as real Lottie vector layers");
  assert.ok(lottiePathVertices([detachedOutlineLayer]).length > 0, "detached imported glyph outlines remain nonempty in Lottie");

});
