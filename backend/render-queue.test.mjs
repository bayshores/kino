import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { createExportBatches } from "./export-batches.mjs";
import { loadBundledFonts } from "./fonts.mjs";

const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateTempRoot = path.join(worktree, ".local", "render-queue-tests");
const originalTmpdir = process.env.TMPDIR;
const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const fontsPromise = loadBundledFonts();

process.env.TMPDIR = privateTempRoot;
process.env.TEMP = privateTempRoot;
process.env.TMP = privateTempRoot;

test.after(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  if (originalTemp === undefined) delete process.env.TEMP;
  else process.env.TEMP = originalTemp;
  if (originalTmp === undefined) delete process.env.TMP;
  else process.env.TMP = originalTmp;
  await rm(privateTempRoot, { recursive: true, force: true });
});

async function testDirectory(t) {
  await mkdir(privateTempRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(privateTempRoot, "case-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, { timeout = 20_000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(interval);
  }
  throw new Error("Timed out waiting for export batch state.");
}

function rectangleScene({ id, name = id, color = "#ff0000", duration = 0.2, width = 64, height = 36, layers = null }) {
  return createScene({
    id,
    name,
    width,
    height,
    duration,
    background: "#101010",
    layers: layers ?? [createLayer("rectangle", {
      id: `shape-${id}`,
      name: "Color block",
      x: 8,
      y: 6,
      width: 44,
      height: 24,
      fill: color,
      stroke: "#000000",
      strokeWidth: 0,
    })],
  });
}

function documentWith(id, scenes) {
  return createDocument({ id, name: "Queue fixture", scenes });
}

async function batch(exportBatches, document, sceneIds, options, fonts) {
  return exportBatches.create({ document, sceneIds, options, fonts, grantId: "queue-test-grant" });
}

test("global export slots are FIFO, queued cancellation advances the queue, and slots do not leak", async (t) => {
  await testDirectory(t);
  const fonts = await fontsPromise;
  const layers = Array.from({ length: 18 }, (_, index) => createLayer("rectangle", {
    id: `slow-layer-${index}`,
    name: `Block ${index}`,
    x: (index * 7) % 56,
    y: (index * 5) % 28,
    width: 7 + index % 8,
    height: 5 + index % 6,
    fill: `#${((index * 0x12345 + 0x2468ac) & 0xffffff).toString(16).padStart(6, "0")}`,
    strokeWidth: 0,
  }));
  const slowDocument = documentWith("render-queue-slow", [rectangleScene({
    id: "long-sequence",
    duration: 8,
    layers,
  })]);
  const quickDocument = documentWith("render-queue-quick", [rectangleScene({ id: "quick" })]);
  const exportBatches = createExportBatches({ maxConcurrent: 1 });
  t.after(() => exportBatches.close());

  const active = await batch(exportBatches, slowDocument, ["long-sequence"], {
    format: "png-sequence", sequenceArchive: true, fps: 30, duration: 8, width: 64, height: 36,
  }, fonts);
  const canceled = await batch(exportBatches, quickDocument, ["quick"], { format: "png" }, fonts);
  const waiting = await batch(exportBatches, quickDocument, ["quick"], { format: "png" }, fonts);

  await waitFor(() => {
    const canceledJob = exportBatches.snapshot(canceled).jobs[0];
    const waitingJob = exportBatches.snapshot(waiting).jobs[0];
    return canceledJob.queuePosition === 1 && waitingJob.queuePosition === 2;
  });
  assert.equal(exportBatches.snapshot(active).jobs[0].status, "inProgress");
  assert.equal(exportBatches.snapshot(canceled).jobs[0].stage, "queue");
  assert.equal(exportBatches.snapshot(waiting).jobs[0].queuePosition, 2);

  await exportBatches.action(canceled, { type: "cancel" });
  assert.equal(exportBatches.snapshot(canceled).jobs[0].status, "canceled");
  assert.equal(exportBatches.snapshot(waiting).jobs[0].queuePosition, 1);

  await Promise.all([active.running, waiting.running]);
  assert.equal(exportBatches.snapshot(active).jobs[0].status, "completed");
  assert.equal(exportBatches.snapshot(waiting).jobs[0].status, "completed");
  assert.equal(exportBatches.snapshot(waiting).jobs[0].queuePosition, undefined);
  assert.equal(exportBatches.file(active, active.jobs[0].id).extension, "zip");
  assert.equal(exportBatches.snapshot(active).jobs[0].validation?.ok, true);
  assert.equal(exportBatches.snapshot(waiting).jobs[0].validation?.ok, true);
});

test("sequence archives complete as checked ZIPs while folder delivery releases the render slot", async (t) => {
  const directory = await testDirectory(t);
  const fonts = await fontsPromise;
  const document = documentWith("sequence-delivery", [rectangleScene({ id: "scene", duration: 0.2 })]);
  const exportBatches = createExportBatches({ maxConcurrent: 1, cacheDirectory: path.join(directory, "cache") });
  t.after(() => exportBatches.close());

  const archived = await batch(exportBatches, document, ["scene"], {
    format: "png-sequence", sequenceArchive: true, fps: 10, duration: 0.2, width: 64, height: 36,
  }, fonts);
  await archived.running;
  const archivedJob = exportBatches.snapshot(archived).jobs[0];
  const archiveFile = exportBatches.file(archived, archivedJob.id);
  assert.equal(archivedJob.status, "completed");
  assert.equal(archivedJob.sequence, undefined);
  assert.equal(archivedJob.needsFolder, undefined);
  assert.equal(archiveFile.extension, "zip");
  assert.equal(archivedJob.validation.checks.frameCount.status, "pass");
  assert.equal(archivedJob.validation.facts.frameCount, 2);

  const folder = await batch(exportBatches, document, ["scene"], {
    format: "png-sequence", fps: 10, duration: 0.2, width: 64, height: 36,
  }, fonts);
  assert.equal(exportBatches.snapshot(folder).jobs[0].stage, "awaiting-folder");
  await exportBatches.action(folder, { type: "start-sequences" });
  await waitFor(() => folder.jobs[0].delivery && folder.jobs[0].sequence?.rendered);
  assert.equal(exportBatches.snapshot(folder).jobs[0].stage, "saving");

  const still = await batch(exportBatches, document, ["scene"], { format: "png" }, fonts);
  await still.running;
  assert.equal(exportBatches.snapshot(still).jobs[0].status, "completed");
  assert.equal(exportBatches.snapshot(folder).jobs[0].status, "inProgress");

  await exportBatches.action(folder, {
    type: "sequence-saved", jobId: folder.jobs[0].id, frameCount: folder.jobs[0].sequence.frameCount,
  });
  await folder.running;
  assert.equal(exportBatches.snapshot(folder).jobs[0].status, "completed");
});

test("cached scenes restore validated results independently after one scene changes", async (t) => {
  const directory = await testDirectory(t);
  const fonts = await fontsPromise;
  const original = documentWith("scene-cache", [
    rectangleScene({ id: "unchanged", color: "#f02020" }),
    rectangleScene({ id: "changed", color: "#2080f0" }),
  ]);
  const edited = documentWith("scene-cache", [
    rectangleScene({ id: "unchanged", color: "#f02020" }),
    rectangleScene({ id: "changed", color: "#20f080" }),
  ]);
  const exportBatches = createExportBatches({ cacheDirectory: path.join(directory, "cache"), maxConcurrent: 1 });
  t.after(() => exportBatches.close());
  const options = { format: "lottie", renderQuality: "draft", duration: 0.2 };

  const first = await batch(exportBatches, original, ["unchanged", "changed"], options, fonts);
  await first.running;
  const firstSnapshot = exportBatches.snapshot(first).jobs;
  assert.ok(firstSnapshot.every((job) => job.status === "completed" && job.validation?.ok));
  assert.deepEqual(firstSnapshot.map(({ width, height, fps }) => [width, height, fps]), [[64, 36, 30], [64, 36, 30]]);
  const originalFiles = first.jobs.map((job) => readFile(exportBatches.file(first, job.id).path));
  const originalBytes = await Promise.all(originalFiles);

  const second = await batch(exportBatches, edited, ["unchanged", "changed"], options, fonts);
  await second.running;
  const secondSnapshot = exportBatches.snapshot(second).jobs;
  assert.deepEqual(secondSnapshot.map((job) => job.cached), [true, false]);
  assert.ok(secondSnapshot.every((job) => job.validation?.ok));
  const changedBytes = await readFile(exportBatches.file(second, second.jobs[1].id).path);
  assert.notDeepEqual(changedBytes, originalBytes[1], "edited scene produces a different Lottie payload");
  const reusedBytes = await readFile(exportBatches.file(second, second.jobs[0].id).path);
  assert.deepEqual(reusedBytes, originalBytes[0], "unchanged scene restores the original cached payload");
});

test("a draft is half size, and its long side stays within the draft width setting", async (t) => {
  const directory = await testDirectory(t);
  const fonts = await fontsPromise;
  const document = documentWith("draft-width", [
    rectangleScene({ id: "wide", width: 400, height: 200 }),
    rectangleScene({ id: "tall", width: 100, height: 400 }),
  ]);
  const exportBatches = createExportBatches({ cacheDirectory: path.join(directory, "cache"), maxConcurrent: 1 });
  t.after(() => exportBatches.close());
  const sizes = async (options) => {
    const job = await batch(exportBatches, document, ["wide", "tall"], { format: "lottie", renderQuality: "draft", duration: 0.2, ...options }, fonts);
    await job.running;
    return job.jobs.map(({ options }) => [options.width, options.height]);
  };
  assert.deepEqual(await sizes({}), [[200, 100], [50, 200]]);
  assert.deepEqual(await sizes({ draftWidth: 100 }), [[100, 50], [25, 100]]);
  assert.deepEqual(await sizes({ draftWidth: 960 }), [[200, 100], [50, 200]], "a larger setting never makes a draft bigger than half size");
  await assert.rejects(sizes({ draftWidth: 3 }), /Draft width/);
});
