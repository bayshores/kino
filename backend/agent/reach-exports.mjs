import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { availableSequenceBase, imageSequenceName } from "../../engine/exportNames.js";

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const WAIT_LIMIT_MS = 55_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

// The file names already in a folder (none when it does not exist yet).
async function folderNames(directory) {
  try { return await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function unusedPath(directory, name, reserved = new Set()) {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = path.join(directory, name);
  for (let suffix = 2; reserved.has(candidate) || await exists(candidate); suffix += 1)
    candidate = path.join(directory, `${stem}-${suffix}${extension}`);
  reserved.add(candidate);
  return candidate;
}

async function atomicCopy(source, target) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// The scenes an export draws: the ones named in sceneIds (a main component too), or every scene but
// the components. Throws when the list is empty, repeats a scene or names one that is gone.
export function selectedScenes(document, sceneIds) {
  const selected = sceneIds ?? document.scenes.filter((scene) => !scene.isComponent).map((scene) => scene.id);
  if (!Array.isArray(selected) || !selected.length || selected.some((id) => typeof id !== "string") || new Set(selected).size !== selected.length)
    throw new Error("Choose one or more distinct scene IDs to export.");
  if (selected.some((id) => !document.scenes.some((scene) => scene.id === id)))
    throw new Error("One of the selected scenes is no longer in the file.");
  return selected;
}

function summary(meta, batch) {
  const snapshot = meta.exportBatches.snapshot(batch);
  const jobs = snapshot.jobs.map((job) => ({
    ...job,
    ...(meta.files.get(job.id) ? { path: meta.files.get(job.id) } : {}),
    ...(meta.sequenceFiles.get(job.id)?.length ? { files: [...meta.sequenceFiles.get(job.id)] } : {}),
  }));
  return {
    batch: snapshot.id,
    project: snapshot.projectId,
    rev: meta.revision,
    quality: meta.quality,
    status: snapshot.status,
    options: snapshot.options,
    jobs,
    ...(meta.outputDirectory ? { output: meta.outputDirectory } : {}),
    ...(meta.deliveryError ? { deliveryError: meta.deliveryError } : {}),
  };
}

/** Agent access to the real export queue, including delivery into agent-owned files. */
export function createReachExports({ exportBatches, agentDirectory, fontsFor, checkFinal, draftWidth = () => undefined }) {
  if (!exportBatches || !agentDirectory || typeof fontsFor !== "function")
    throw new TypeError("Export reachability needs exportBatches, agentDirectory, and fontsFor.");
  const managed = new Map();

  function getBatch(options, record) {
    const id = String(options.batch ?? options.batchId ?? "");
    if (!id) throw new Error("This export action needs batch.");
    const meta = managed.get(id);
    if (!meta || meta.closed || meta.projectId !== record.document.id)
      throw new Error("No open export queue with that batch ID for this project.");
    return { meta, batch: exportBatches.get(id) };
  }

  function snapshot(meta, batch) {
    return summary(meta, batch);
  }

  async function saveFile(meta, batch, job) {
    if (job.status !== "completed" || meta.files.has(job.id)) return;
    if (meta.copying.has(job.id)) return meta.copying.get(job.id);
    const task = (async () => {
      const source = exportBatches.file(batch, job.id);
      await mkdir(meta.outputDirectory, { recursive: true, mode: 0o700 });
      const target = await unusedPath(meta.outputDirectory, source.name, meta.reservedPaths);
      try {
        await atomicCopy(source.path, target);
        meta.files.set(job.id, target);
      } catch (error) {
        meta.reservedPaths.delete(target);
        throw error;
      }
    })();
    meta.copying.set(job.id, task);
    try { await task; } finally { meta.copying.delete(job.id); }
  }

  async function observeFiles(meta, batch, signal) {
    while (!signal.aborted && !meta.closed) {
      const current = exportBatches.snapshot(batch);
      await Promise.all(current.jobs.map((job) => saveFile(meta, batch, job)));
      if (current.jobs.every((job) => TERMINAL.has(job.status))) return;
      await wait(80);
    }
  }

  async function observeSequences(meta, batch, signal) {
    await exportBatches.action(batch, { type: "start-sequences" });
    for (const initial of exportBatches.snapshot(batch).jobs.filter((job) => job.sequence)) {
      let base = meta.sequenceBases.get(initial.id);
      if (!base) {
        // A name is free only when none of its frames is in the folder yet.
        const names = await folderNames(meta.outputDirectory);
        base = await availableSequenceBase(initial.name, async (name) =>
          meta.reservedSequenceFirstFrames.has(path.join(meta.outputDirectory, name)) || exists(path.join(meta.outputDirectory, name)), names);
        meta.sequenceBases.set(initial.id, base);
        meta.reservedSequenceFirstFrames.add(path.join(meta.outputDirectory, imageSequenceName(base, 0)));
      }
      let index = 0;
      while (!signal.aborted && !meta.closed) {
        const current = exportBatches.snapshot(batch);
        const job = current.jobs.find((item) => item.id === initial.id);
        if (!job) throw new Error(`Scene ${initial.name} left the export queue.`);
        if (job.status === "failed") throw new Error(job.error || `${job.name} could not be exported.`);
        if (job.status === "canceled" || current.status === "canceled") return;
        await mkdir(meta.outputDirectory, { recursive: true, mode: 0o700 });
        while (index < job.sequence.readyFrames) {
          signal.throwIfAborted();
          const source = exportBatches.sequenceFrame(batch, job.id, index);
          const filename = imageSequenceName(base, index);
          const target = path.join(meta.outputDirectory, filename);
          const files = meta.sequenceFiles.get(job.id) ?? [];
          // Never replace a file this export did not write (after a resume it writes its own frames again).
          try { await copyFile(source.path, target, files[index] === target ? 0 : constants.COPYFILE_EXCL); }
          catch (error) {
            if (error.code === "EEXIST") throw new Error(`${filename} is already in ${meta.outputDirectory}; kino does not replace files it did not write. Export again or choose another out folder.`);
            throw error;
          }
          files[index] = target;
          meta.sequenceFiles.set(job.id, files);
          index += 1;
        }
        if (job.sequence.rendered && index === job.sequence.frameCount) {
          await exportBatches.action(batch, { type: "sequence-saved", jobId: job.id, frameCount: index });
          break;
        }
        await wait(70);
      }
      if (signal.aborted || meta.closed) return;
    }
  }

  function observe(meta, batch) {
    meta.worker?.abort();
    const controller = new AbortController();
    meta.worker = controller;
    meta.delivery = (async () => {
      try {
        if (meta.format === "png-sequence") await observeSequences(meta, batch, controller.signal);
        else await observeFiles(meta, batch, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && !meta.closed) {
          meta.deliveryError = error instanceof Error ? error.message : String(error);
          await exportBatches.action(batch, { type: "cancel" }).catch(() => {});
        }
      }
    })();
    return meta.delivery;
  }

  async function status(meta, batch) {
    const current = exportBatches.snapshot(batch);
    if (meta.format !== "png-sequence") await Promise.all(current.jobs.map((job) => saveFile(meta, batch, job)));
    return snapshot(meta, batch);
  }

  async function waitForBatch(meta, batch, timeoutSeconds) {
    const requested = Number(timeoutSeconds ?? 55);
    const timeout = Number.isFinite(requested) ? Math.max(0, Math.min(requested * 1000, WAIT_LIMIT_MS)) : WAIT_LIMIT_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      const current = exportBatches.snapshot(batch);
      if (current.jobs.every((job) => TERMINAL.has(job.status))) {
        await meta.delivery;
        if (meta.format !== "png-sequence") await Promise.all(current.jobs.map((job) => saveFile(meta, batch, job)));
        return snapshot(meta, batch);
      }
      if (Date.now() >= deadline) return snapshot(meta, batch);
      await wait(Math.min(100, deadline - Date.now()));
    }
  }

  async function manage(options = {}, record) {
    if (!record?.document?.id || !Number.isSafeInteger(record.revision)) throw new Error("Exports need the saved project document and revision.");
    const action = options.action ?? "start";
    if (action === "start") {
      const sceneIds = selectedScenes(record.document, options.sceneIds);
      const quality = options.quality ?? "draft";
      if (quality !== "draft" && quality !== "final") throw new Error("quality is draft or final.");
      if (!options.options || typeof options.options !== "object" || Array.isArray(options.options))
        throw new Error("start needs export settings in options.");
      if (options.out !== undefined && (typeof options.out !== "string" || !options.out.trim()))
        throw new Error("out must be a non-empty output folder path.");
      if (quality === "final") {
        if (typeof checkFinal !== "function") throw new Error("Final export checks are unavailable.");
        await checkFinal(record.document, sceneIds, options.options);
      }
      const fonts = await fontsFor(record.document);
      // A draft is half size at 30fps (fps up to 30), its long side at most your draft size setting, as render
      // start makes it. A final export uses the size and fps in options.
      const width = draftWidth();
      const settings = quality === "draft" ? { ...options.options, renderQuality: "draft", ...(width ? { draftWidth: width } : {}) } : options.options;
      const batch = await exportBatches.create({ document: record.document, sceneIds, options: settings, fonts, grantId: null });
      const outputDirectory = options.out
        ? path.resolve(String(options.out))
        : path.join(agentDirectory, "exports", encodeURIComponent(record.document.id), `r${record.revision}-${batch.id}`);
      const meta = {
        exportBatches, projectId: record.document.id, revision: record.revision, quality,
        format: batch.options.format, outputDirectory, files: new Map(), sequenceFiles: new Map(), sequenceBases: new Map(),
        copying: new Map(), reservedPaths: new Set(), reservedSequenceFirstFrames: new Set(), deliveryError: null, worker: null, delivery: Promise.resolve(), closed: false,
      };
      managed.set(batch.id, meta);
      observe(meta, batch);
      const data = snapshot(meta, batch);
      const draftNote = quality === "draft" ? ' A draft is half size at 30fps (fps up to 30) unless options give a width, height or size; quality:"final" uses the size and fps in options.' : "";
      return { text: `${batch.id} started ${quality} ${batch.options.format} for ${sceneIds.length} scene${sceneIds.length === 1 ? "" : "s"} at rev ${record.revision}.${draftNote} Use project manage {resource:"exports", action:"wait", batch:"${batch.id}"} for the saved files.`, data };
    }

    const { meta, batch } = getBatch(options, record);
    if (action === "status") {
      const data = await status(meta, batch);
      return { text: JSON.stringify(data), data };
    }
    if (action === "wait") {
      const data = await waitForBatch(meta, batch, options.timeout_s);
      return { text: JSON.stringify(data), data };
    }
    if (action === "cancel") {
      if (exportBatches.snapshot(batch).jobs.every((job) => TERMINAL.has(job.status)))
        throw new Error("This export queue has no active work to cancel.");
      await exportBatches.action(batch, { type: "cancel" });
      meta.worker?.abort();
      const data = snapshot(meta, batch);
      return { text: `${data.batch} canceled at rev ${data.rev}.`, data };
    }
    if (action === "resume") {
      if (exportBatches.snapshot(batch).status !== "canceled")
        throw new Error("Only a canceled export queue can be resumed.");
      await meta.delivery.catch(() => {});
      await exportBatches.action(batch, { type: "resume" });
      meta.deliveryError = null;
      if (meta.worker?.signal.aborted) meta.worker = null;
      observe(meta, batch);
      const data = snapshot(meta, batch);
      return { text: `${data.batch} resumed at rev ${data.rev}.`, data };
    }
    if (action === "zip") {
      const current = exportBatches.snapshot(batch);
      if (current.jobs.some((job) => !TERMINAL.has(job.status))) throw new Error("Wait for the export queue to finish before creating a ZIP.");
      await mkdir(meta.outputDirectory, { recursive: true, mode: 0o700 });
      const target = await unusedPath(meta.outputDirectory, `${record.document.id}-r${meta.revision}-${batch.id.slice(0, 8)}.zip`, meta.reservedPaths);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await exportBatches.archive(batch, temporary);
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        meta.reservedPaths.delete(target);
        throw error;
      }
      const data = { ...snapshot(meta, batch), zip: target };
      return { text: `${path.basename(target)} saved at ${target}.`, data };
    }
    if (action === "close") {
      meta.closed = true;
      meta.worker?.abort();
      await exportBatches.remove(batch.id);
      await meta.delivery.catch(() => {});
      managed.delete(batch.id);
      return { text: `${batch.id} closed; temporary export files were removed.`, data: { batch: batch.id, closed: true, rev: meta.revision } };
    }
    throw new Error(`Unknown export action "${action}". Choose start, status, wait, cancel, resume, zip or close.`);
  }

  return manage;
}
