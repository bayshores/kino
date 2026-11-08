import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Plan removal using all surviving files, including Trash and their undo permissions. */
export function releasedMediaRecord(entry, projectId, projects, removedIds) {
  const used = Array.isArray(entry.usedInProjects) ? entry.usedInProjects : [];
  if (entry.projectId !== projectId && !used.includes(projectId) && !removedIds.has(entry.id)) return null;
  const liveIds = new Set(projects.map((project) => project.id));
  const retained = new Set([entry.projectId, ...used].filter((id) => id !== projectId && liveIds.has(id)));
  for (const project of projects) if (project.mediaIds.includes(entry.id)) retained.add(project.id);
  if (!retained.size) return { deleteFile: true };
  const { projectId: owner, ...fields } = entry;
  return { deleteFile: false, record: { ...fields,
    ...(owner !== projectId && liveIds.has(owner) ? { projectId: owner } : {}),
    usedInProjects: [...retained],
  } };
}

/**
 * Called inside the server's file-mutation queue, after the project was removed.
 * Reuse the metadata queue so a concurrent measurement cannot resurrect an old owner.
 * Failed cleanup is reported; unrelated and unreadable uploads are kept conservatively.
 */
export async function releaseProjectMedia({ projectId, removedIds, projects, mediaRoot, recordWrites }) {
  const deleted = [], errors = [];
  const names = (await readdir(mediaRoot)).filter((name) => /^[a-f0-9-]+\.[a-z0-9]+\.json$/.test(name));
  for (const name of names) {
    const id = name.slice(0, -5);
    const task = (recordWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const filename = path.join(mediaRoot, id);
      let entry;
      try { entry = JSON.parse(await readFile(`${filename}.json`, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (entry.id !== id) throw new Error(`Media record ${id} has a different ID.`);
      const result = releasedMediaRecord(entry, projectId, projects, removedIds);
      if (!result) return;
      if (result.deleteFile) {
        await rm(filename, { force: true });
        await rm(`${filename}.json`, { force: true });
        await rm(`${filename}.peaks`, { force: true });
        await rm(`${filename}.lufs`, { force: true });
        await rm(`${filename}.bands`, { force: true });
        await rm(path.join(mediaRoot, "..", "media-frames", id), { recursive: true, force: true });
        deleted.push(id);
      } else {
        const temporary = `${filename}.json.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(result.record), { mode: 0o600, flag: "wx" });
          await rename(temporary, `${filename}.json`);
        } finally { await rm(temporary, { force: true }); }
      }
    });
    recordWrites.set(id, task);
    try { await task; }
    catch { errors.push(`Could not release media ${id}. Its remaining files were kept for recovery.`); }
    finally { if (recordWrites.get(id) === task) recordWrites.delete(id); }
  }
  return { deletedMediaIds: deleted, cleanupErrors: errors };
}

// Saving, duplicating and deleting must not interleave a new reference with collection.
export function createFileMutationLock() {
  let previous = Promise.resolve();
  return async function acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const wait = previous;
    previous = next;
    await wait;
    return release;
  };
}
