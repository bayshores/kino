// render cancel against the moment a render ends. finishRender copies each finished file out of
// the export batch folder, and cancel removes that folder, so the two must never overlap: either
// the render is already over (cancel answers "Nothing to cancel" and the files are saved) or
// cancel wins before any copy starts. A cancel that slipped in between used to delete the folder
// during the copy and leave the job "failed". The fake export batches below make that moment
// happen every time, without rendering anything.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDocument, createScene } from "../engine/model.js";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { openStore } from "./store.mjs";

const ENDED = ["completed", "failed", "canceled"];

// A stand-in for export-batches.mjs. The test says when each scene finishes (complete). As in
// the real one, a batch keeps running a little after its last scene finishes, cancel stops the
// run and waits for it to end, and remove deletes the batch folder. Here remove deletes the
// folder at once, the worst moment for a copy that has already started.
function fakeExportBatches(directory) {
  const batches = new Map();
  function stop(batch) {
    for (const job of batch.jobs) if (!ENDED.includes(job.status)) Object.assign(job, { status: "canceled", stage: "canceled" });
    batch.end();
    return batch.running;
  }
  return {
    async create({ sceneIds }) {
      let end;
      const running = new Promise((resolve) => { end = resolve; });
      const batch = { id: randomUUID(), directory: path.join(directory, randomUUID()), running, end,
        jobs: sceneIds.map((sceneId) => ({ id: randomUUID(), sceneId, status: "inProgress", stage: "render", progress: 0.5,
          width: 64, height: 36, fps: 15, duration: 1 })) };
      await mkdir(batch.directory, { recursive: true });
      batches.set(batch.id, batch);
      return batch;
    },
    // The batch the service is rendering with (one at a time in these tests).
    only: () => [...batches.values()].at(-1),
    async complete(batch, index) {
      const job = batch.jobs[index];
      job.file = path.join(batch.directory, `${job.id}.mp4`);
      await writeFile(job.file, `synthesized video ${index + 1}`);
      Object.assign(job, { status: "completed", stage: "complete", progress: 1, size: 20 });
    },
    get(id) {
      const batch = batches.get(id);
      if (!batch) throw new Error("This export queue expired or was closed.");
      return batch;
    },
    snapshot: (batch) => ({ jobs: batch.jobs.map(({ file, ...job }) => ({ ...job })) }),
    file(batch, jobId) {
      const job = batch.jobs.find((entry) => entry.id === jobId);
      return { path: job.file, extension: "mp4", renderedFrames: 15 };
    },
    async action(batch, input) {
      if (input.type === "cancel") await stop(batch);
    },
    async remove(id) {
      const batch = batches.get(id);
      if (!batch) return;
      batches.delete(id);
      rmSync(batch.directory, { recursive: true, force: true });
      await stop(batch);
    },
  };
}

async function setup(t, sceneCount) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-render-cancel-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  const scenes = Array.from({ length: sceneCount }, (_, index) => createScene({ id: `scene-${index + 1}`, name: `Scene ${index + 1}`, duration: 1 }));
  await store.createProject(createDocument({ id: "cancel-race", name: "Cancel race", scenes }));
  const exportBatches = fakeExportBatches(path.join(dataRoot, "batches"));
  const agentDirectory = path.join(dataRoot, "agent");
  const fonts = await loadBundledFonts();
  const service = createAgentService({
    store, agentState: createAgentStateStore(dataRoot), agentDirectory, mediaRoot: path.join(dataRoot, "media"),
    exportBatches, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts,
  });
  const renders = path.join(agentDirectory, "renders", "cancel-race");
  return { service, exportBatches, renders };
}

test("a cancel after every scene finished, before the files are saved, saves them and says nothing was canceled", async (t) => {
  const { service, exportBatches, renders } = await setup(t, 1);
  const started = await service.call("render", { project: "cancel-race", action: "start" });
  assert.equal(started.isError, undefined, started.text);
  const job = started.data.job;

  // The scene's file is ready, but the batch has not stopped running, so nothing saved it yet.
  const batch = exportBatches.only();
  await exportBatches.complete(batch, 0);

  const canceled = await service.call("render", { action: "cancel", job });
  assert.equal(canceled.isError, undefined, canceled.text);
  assert.equal(canceled.data.status, "done", canceled.text);
  assert.match(canceled.text, new RegExp(`^Nothing to cancel: ${job} draft done `));
  assert.equal(await readFile(canceled.data.path, "utf8"), "synthesized video 1");
  assert.equal(path.dirname(canceled.data.path), renders);

  const status = await service.call("render", { action: "status", job });
  assert.equal(status.isError, undefined, status.text);
  assert.equal(status.data.status, "done", status.text);
  assert.equal(status.data.path, canceled.data.path);
});

test("a cancel while a scene still renders wins before any finished scene is copied", async (t) => {
  const { service, exportBatches, renders } = await setup(t, 2);
  const started = await service.call("render", { project: "cancel-race", action: "start", scene: "all" });
  assert.equal(started.isError, undefined, started.text);
  const job = started.data.job;

  // Scene 1 is finished; scene 2 is still rendering when the cancel arrives. Stopping the batch
  // ends the run, which is when the service would otherwise start saving scene 1.
  const batch = exportBatches.only();
  await exportBatches.complete(batch, 0);

  const canceled = await service.call("render", { action: "cancel", job });
  assert.equal(canceled.isError, undefined, canceled.text);
  assert.deepEqual(canceled.data, { job, status: "canceled" });

  // status waits for any save still going; none started, so the job stays canceled.
  const status = await service.call("render", { action: "status", job });
  assert.equal(status.isError, undefined, status.text);
  assert.equal(status.data.status, "canceled", status.text);
  assert.equal(status.data.error, undefined, status.text);
  assert.deepEqual(await readdir(renders).catch(() => []), [], "no half-saved files");

  // A second cancel changes nothing and says so.
  const again = await service.call("render", { action: "cancel", job });
  assert.equal(again.data.status, "canceled", again.text);
  assert.match(again.text, new RegExp(`^Nothing to cancel: ${job} draft canceled `));
});
