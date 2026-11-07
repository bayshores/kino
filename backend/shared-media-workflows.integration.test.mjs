import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { parseCsv, writeCsv } from "../engine/csv.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { mediaIdFromSource } from "../engine/replaceMedia.js";
import { sceneCsvRows } from "../engine/sceneCsv.js";
import { ffmpeg, makeToneAfterSilence, readImage, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

// The audio peaks route for an uploaded source, keeping its share token.
const peaksRoute = (src) => `/api/media/${mediaIdFromSource(src)}/peaks?${src.split("?")[1] ?? ""}`;

async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("persisted shared audio/video sources request real peaks with file-scoped authorization", { skip: skipWithoutMediaTools }, async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const projectId = "shared-peaks";
  let record = await json(await service.api("/api/projects", { method: "POST", body: {
    document: createDocument({ id: projectId, scenes: [createScene({ id: "scene", duration: 1 })] }),
  } }), 201);
  const shared = await json(await service.api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role: "view" } }), 201);
  const audioFile = await makeToneAfterSilence(path.join(service.dataDirectory, "tone.wav"), { silence: 0.1, tone: 0.3 });
  const videoFile = path.join(service.dataDirectory, "video.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=16x16:r=10:d=0.4", "-i", audioFile,
    "-c:v", "libx264", "-c:a", "aac", "-shortest", videoFile]);
  const layers = [];
  for (const [type, filename, mime] of [["audio", audioFile, "audio/wav"], ["video", videoFile, "video/mp4"]]) {
    const upload = await json(await service.api(`/api/media?project=${projectId}`, {
      method: "POST", headers: { "Content-Type": mime }, body: await readFile(filename),
    }), 201);
    layers.push(createLayer(type, { id: type, src: `${upload.src}?share=${shared.token}`, mediaDuration: 0.4, mediaSourceDuration: 0.4 }));
  }
  record.document.scenes[0].layers = layers;
  record = await json(await service.api(`/api/projects/${projectId}`, {
    method: "PUT", body: { document: record.document, revision: record.revision },
  }));
  for (const layer of record.document.scenes[0].layers) {
    const route = peaksRoute(layer.src);
    assert.ok(route);
    const peaks = await json(await service.api(route, { owner: false }));
    assert.equal(peaks.available, true);
    assert.ok(peaks.peaks.some((peak) => peak > 0.5), `${layer.type} contains audible samples`);
    assert.equal((await service.api(route.split("?")[0], { owner: false })).status, 403);
    assert.equal((await service.api(`${route.split("?")[0]}?share=invalid-capability`, { owner: false })).status, 403);
  }
  await json(await service.api(`/api/projects/${projectId}/shares/${shared.grant.id}`, { method: "DELETE" }));
  for (const layer of record.document.scenes[0].layers)
    assert.equal((await service.api(peaksRoute(layer.src), { owner: false })).status, 403, "revocation is checked even after peaks are cached");
});

test("a scene CSV round-trips a shared image through duplicate saved filenames and real PNG export", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const projectId = "shared-scene-csv";
  let record = await json(await service.api("/api/projects", { method: "POST", body: {
    document: createDocument({ id: projectId, scenes: [createScene({ id: "scene", width: 8, height: 4 })] }),
  } }), 201);
  const uploads = [];
  for (const color of ["#ff0000", "#0000ff"]) {
    const canvas = createCanvas(8, 4);
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, 8, 4);
    uploads.push(await json(await service.api(`/api/media?project=${projectId}`, {
      method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "photo.png" }, body: canvas.toBuffer("image/png"),
    }), 201));
  }
  const shared = await json(await service.api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role: "edit" } }), 201);
  const src = `${uploads[0].src}?share=${shared.token}`;
  record.document.scenes[0].layers = [createLayer("image", { id: "photo", name: "Photo", src, x: 0, y: 0, width: 8, height: 4 })];
  record = await json(await service.api(`/api/projects/${projectId}`, {
    method: "PUT", body: { document: record.document, revision: record.revision },
  }));
  // Through the edit link: the scene's one-row template (project manage csv template), then
  // one revision-guarded bulk_create.
  const requestJson = async (route, options = {}) =>
    json(await service.api(route, { owner: false, share: shared.token, method: options.method, body: options.json }));
  const csv = writeCsv(sceneCsvRows(record.document, "scene", (await requestJson("/api/media")).media));
  assert.deepEqual(parseCsv(csv).rows, [["copy", "photo.png", ""]]);
  await requestJson(`/api/projects/${projectId}/operations`, { method: "POST",
    json: { revision: record.revision, operations: [{ type: "bulk_create", sceneId: "scene", csv }] } });
  const saved = await requestJson(`/api/projects/${projectId}`);
  assert.equal(saved.revision, record.revision + 1);
  assert.equal(saved.document.scenes[0].layers[0].src, src);
  const variant = saved.document.scenes.find((scene) => scene.bulkVariant?.key === "copy");
  assert.equal(expandComponents(saved.document, variant.id).layers.find((layer) => layer.type === "image").src, uploads[0].src);
  const exported = await service.api("/api/export", { method: "POST", body: {
    document: saved.document, sceneId: variant.id, options: { format: "png" },
  } });
  assert.equal(exported.status, 200, await exported.clone().text());
  const image = await readImage(Buffer.from(await exported.arrayBuffer()));
  assert.deepEqual(image.pixel(4, 2), [255, 0, 0, 255], "the variant renders the current red upload, not the other same-named blue image");
});
