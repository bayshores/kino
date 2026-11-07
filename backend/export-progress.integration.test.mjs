import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

function documentWithScene({ id, name, duration = 0.1, layerCount = 1, width = 64, height = 36 }) {
  const layers = Array.from({ length: layerCount }, (_, index) => createLayer("rectangle", {
    id: `${id}-layer-${index}`,
    name: `Block ${index}`,
    x: (index * 17) % Math.max(1, width - 12),
    y: (index * 11) % Math.max(1, height - 12),
    width: Math.min(10, width),
    height: Math.min(8, height),
    fill: `#${((index * 0x12345 + 0x2468ac) & 0xffffff).toString(16).padStart(6, "0")}`,
  }));
  const scene = createScene({ id: `${id}-scene`, name, width, height, duration, layers });
  return createDocument({ id, name, scenes: [scene] });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForProgress(service, id, predicate, options = {}) {
  const deadline = Date.now() + 15_000;
  let latest = null;
  while (Date.now() < deadline) {
    const response = await service.api(`/api/export-progress/${id}`, options);
    if (response.ok) {
      latest = await response.json();
      if (predicate(latest)) return latest;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for export progress ${id}: ${JSON.stringify(latest)}`);
}

test("real export progress preserves download, authorization, Unicode names, and cancellation", async (t) => {
  const service = await startTestServer();
  t.after(() => service.stop());

  const document = documentWithScene({ id: "export-progress-project", name: "Sea and wind", });
  document.scenes[0].name = "海と風 ✨";
  const create = await service.api("/api/projects", { method: "POST", body: { document } });
  assert.equal(create.status, 201);
  const project = await create.json();
  const createShare = async (projectId, role = "view") => {
    const response = await service.api(`/api/projects/${projectId}/shares`, { method: "POST", body: { role } });
    assert.equal(response.status, 201);
    return response.json();
  };
  const viewerA = await createShare(document.id);
  const viewerB = await createShare(document.id);
  const foreignDocument = documentWithScene({ id: "foreign-progress-project", name: "Foreign" });
  assert.equal((await service.api("/api/projects", { method: "POST", body: { document: foreignDocument } })).status, 201);
  const foreignViewer = await createShare(foreignDocument.id);

  const ownerExportId = randomUUID();
  const exportBody = { document: project.document, sceneId: project.document.scenes[0].id,
    options: { format: "png", width: 64, height: 36, time: 0 } };
  const ownerExport = await service.api("/api/export", {
    method: "POST", headers: { "X-Kino-Export-ID": ownerExportId }, body: exportBody,
  });
  assert.equal(ownerExport.status, 200);
  assert.deepEqual(Buffer.from(await ownerExport.arrayBuffer()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const disposition = ownerExport.headers.get("content-disposition");
  assert.match(disposition, /filename\*=UTF-8''/);
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  assert.equal(decodeURIComponent(encodedName), "海と風.png");

  // The server marks the export complete once the response has finished sending, which a fast
  // client can ask about a moment before: wait for it.
  const ownerProgress = await waitForProgress(service, ownerExportId, (progress) => progress.status !== "running");
  assert.deepEqual(ownerProgress, {
    id: ownerExportId.toLowerCase(), status: "complete", stage: "render", completed: 1, total: 1,
  });
  assert.equal("projectId" in ownerProgress, false);
  assert.equal("grantId" in ownerProgress, false);
  assert.equal((await service.api(`/api/export-progress/${randomUUID()}`)).status, 404);
  assert.equal((await service.api(`/api/export-progress/${ownerExportId}`, { owner: false })).status, 403);
  assert.equal((await service.api(`/api/export-progress/${ownerExportId}`, { owner: false, share: viewerA.token })).status, 403,
    "a share grant cannot poll an owner-scoped export");
  assert.equal((await service.api(`/api/export-progress/not-a-uuid`)).status, 400);

  const viewerExportId = randomUUID();
  const viewerExport = await service.api("/api/export", {
    owner: false, share: viewerA.token, method: "POST", headers: { "X-Kino-Export-ID": viewerExportId }, body: exportBody,
  });
  assert.equal(viewerExport.status, 200);
  await viewerExport.arrayBuffer();
  assert.equal((await service.api(`/api/export-progress/${viewerExportId}`, { owner: false, share: viewerA.token })).status, 200);
  assert.equal((await service.api(`/api/export-progress/${viewerExportId}`, { owner: false, share: viewerB.token })).status, 403,
    "a different grant for the same project cannot poll this export");
  assert.equal((await service.api(`/api/export-progress/${viewerExportId}`, { owner: false, share: foreignViewer.token })).status, 403,
    "another project cannot poll the export");
  assert.equal((await service.api(`/api/export-progress/${viewerExportId}`)).status, 200,
    "the owner can inspect exports in the project");

  const duplicate = await service.api("/api/export", {
    method: "POST", headers: { "X-Kino-Export-ID": ownerExportId }, body: exportBody,
  });
  assert.equal(duplicate.status, 409);
  const invalidId = await service.api("/api/export", {
    method: "POST", headers: { "X-Kino-Export-ID": "../../bad" }, body: exportBody,
  });
  assert.equal(invalidId.status, 400);

  const slowDocument = documentWithScene({ id: "cancel-export-project", name: "Cancelable",
    width: 512, height: 288, duration: 1.5, layerCount: 120 });
  const exportId = randomUUID();
  const controller = new AbortController();
  const request = service.api("/api/export", {
    method: "POST", signal: controller.signal, headers: { "X-Kino-Export-ID": exportId },
    body: { document: slowDocument, sceneId: slowDocument.scenes[0].id,
      options: { format: "png-sequence", width: 512, height: 288, fps: 60, duration: 1.5 } },
  });
  const started = await waitForProgress(service, exportId,
    (progress) => progress.status === "running" && progress.stage === "render");
  assert.ok(started.completed >= 1 && started.total > started.completed);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  const cancelled = await waitForProgress(service, exportId, (progress) => progress.status === "cancelled");
  assert.equal(cancelled.stage, "render");
});
