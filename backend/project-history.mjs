import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
const activeWrites = new Set();

function validateHistoryId(historyId) {
  if (typeof historyId !== "string" || !UUID_PATTERN.test(historyId))
    throw new TypeError("Project history ID must be a UUID.");
  return historyId.toLowerCase();
}

function validateRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision <= 0)
    throw new TypeError("Project history revision must be a positive safe integer.");
  return revision;
}

function validateDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      typeof document.id !== "string" || document.id.length === 0)
    throw new TypeError("Project history document must be an object with a non-empty string id.");
}

function contextualError(operation, historyId, revision, error) {
  const detail = error?.message || String(error);
  const target = revision === undefined ? historyId : `${historyId}/${revision}`;
  const wrapped = new Error(`Cannot ${operation} project history ${target}: ${detail}`, { cause: error });
  if (error?.code) wrapped.code = error.code;
  return wrapped;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

async function openDirectory(directory, label) {
  let handle;
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
    if (!entry.isDirectory()) throw new Error(`${label} is not a directory.`);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0);
    handle = await open(directory, flags);
    const stats = await handle.stat();
    if (!stats.isDirectory()) throw new Error(`${label} is not a directory.`);
    await handle.chmod(0o700);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      let isSymlink = false;
      try {
        isSymlink = (await lstat(directory)).isSymbolicLink();
      } catch { /* Preserve the original open error if the path changed. */ }
      if (isSymlink) throw new Error(`${label} must not be a symbolic link.`, { cause: error });
    }
    throw error;
  }
}

async function syncDirectory(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has(error?.code)) throw error;
  }
}

async function openRoot(directory, create) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await openDirectory(directory, "Project history root");
  } catch (error) {
    if (!create && isMissing(error)) return null;
    throw error;
  }
}

async function openGeneration(rootHandle, directory, historyId, create) {
  const generationPath = path.join(directory, historyId);
  if (create) {
    try {
      await mkdir(generationPath, { mode: 0o700 });
      await syncDirectory(rootHandle);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  try {
    const handle = await openDirectory(generationPath, "Project history generation");
    return { handle, path: generationPath };
  } catch (error) {
    if (!create && isMissing(error)) return null;
    throw error;
  }
}

async function closeHandles(...handles) {
  await Promise.all(handles.filter(Boolean).map(handle => handle.close().catch(() => {})));
}

async function fileExistsWithoutFollowingLinks(filename) {
  try {
    const stats = await lstat(filename);
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new Error("History revision path is not a regular file.");
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function serializedEntry(revision, document) {
  validateDocument(document);
  let text;
  try {
    text = JSON.stringify({ revision, document });
  } catch (error) {
    throw new TypeError(`Project history document is not JSON serializable: ${error.message}`, { cause: error });
  }
  if (typeof text !== "string") throw new TypeError("Project history document is not JSON serializable.");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new TypeError(`Project history document is not valid JSON: ${error.message}`, { cause: error }); }
  if (parsed?.revision !== revision) throw new TypeError("Project history revision did not survive JSON serialization.");
  validateDocument(parsed.document);
  return text;
}

function parseEntry(text, expectedRevision, filename) {
  let entry;
  try { entry = JSON.parse(text); }
  catch (error) { throw new Error(`Malformed project history JSON at ${filename}.`, { cause: error }); }
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.revision !== expectedRevision)
    throw new Error(`Malformed project history revision at ${filename}.`);
  validateDocumentForRead(entry.document, filename);
  return entry.document;
}

function validateDocumentForRead(document, filename) {
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      typeof document.id !== "string" || document.id.length === 0)
    throw new Error(`Malformed project history document at ${filename}.`);
}

async function removeTreeWithoutFollowingLinks(directory) {
  const entries = await readdir(directory);
  for (const name of entries) {
    const entryPath = path.join(directory, name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      await unlink(entryPath);
      continue;
    }
    await removeTreeWithoutFollowingLinks(entryPath);
    await rmdir(entryPath);
  }
}

/**
 * Stores immutable, private snapshots under app-generated history UUIDs.
 * The root must be a dedicated application-private directory.
 */
export function createProjectHistory(directory) {
  if (typeof directory !== "string" || directory.trim() === "")
    throw new TypeError("Project history directory is required.");
  const root = path.resolve(directory);

  async function write(historyIdValue, revisionValue, document) {
    const historyId = validateHistoryId(historyIdValue);
    const revision = validateRevision(revisionValue);
    const text = serializedEntry(revision, document);
    const writeKey = `${root}\u0000${historyId}\u0000${revision}`;
    if (activeWrites.has(writeKey)) throw contextualError("write", historyId, revision, new Error("A write for this revision is already in progress."));
    activeWrites.add(writeKey);

    let rootHandle, generationHandle, temporaryPath;
    try {
      rootHandle = await openRoot(root, true);
      const generation = await openGeneration(rootHandle, root, historyId, true);
      generationHandle = generation.handle;
      const targetPath = path.join(generation.path, `${revision}.json`);
      if (await fileExistsWithoutFollowingLinks(targetPath))
        throw new Error("That history revision already exists and cannot be replaced.");

      const candidatePath = path.join(generation.path, `.tmp-${revision}-${randomUUID()}`);
      const file = await open(candidatePath, "wx", 0o600);
      temporaryPath = candidatePath;
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }

      if (await fileExistsWithoutFollowingLinks(targetPath))
        throw new Error("That history revision already exists and cannot be replaced.");
      await rename(temporaryPath, targetPath);
      temporaryPath = null;
      await syncDirectory(generationHandle);
    } catch (error) {
      throw contextualError("write", historyId, revision, error);
    } finally {
      if (temporaryPath) await unlink(temporaryPath).catch(() => {});
      await closeHandles(generationHandle, rootHandle);
      activeWrites.delete(writeKey);
    }
  }

  async function read(historyIdValue, revisionValue) {
    const historyId = validateHistoryId(historyIdValue);
    const revision = validateRevision(revisionValue);
    let rootHandle, generationHandle, fileHandle;
    const filename = path.join(root, historyId, `${revision}.json`);
    try {
      rootHandle = await openRoot(root, false);
      if (!rootHandle) return null;
      const generation = await openGeneration(rootHandle, root, historyId, false);
      if (!generation) return null;
      generationHandle = generation.handle;
      try {
        const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
        fileHandle = await open(filename, flags);
      } catch (error) {
        if (isMissing(error)) return null;
        if (error?.code === "ELOOP") throw new Error("History revision must not be a symbolic link.", { cause: error });
        throw error;
      }
      const stats = await fileHandle.stat();
      if (!stats.isFile()) throw new Error("History revision path is not a regular file.");
      const text = await fileHandle.readFile("utf8");
      return parseEntry(text, revision, filename);
    } catch (error) {
      throw contextualError("read", historyId, revision, error);
    } finally {
      await closeHandles(fileHandle, generationHandle, rootHandle);
    }
  }

  async function prune(historyIdValue, keepRevisions) {
    const historyId = validateHistoryId(historyIdValue);
    if (!Array.isArray(keepRevisions)) throw new TypeError("keepRevisions must be an array of positive safe integers.");
    const keep = new Set(keepRevisions.map(validateRevision));
    let rootHandle, generationHandle;
    try {
      rootHandle = await openRoot(root, false);
      if (!rootHandle) return [];
      const generation = await openGeneration(rootHandle, root, historyId, false);
      if (!generation) return [];
      generationHandle = generation.handle;
      const removed = [];
      for (const entry of await readdir(generation.path, { withFileTypes: true })) {
        const match = /^(?:([1-9]\d*))\.json$/.exec(entry.name);
        if (!match) continue;
        const revision = Number(match[1]);
        if (!Number.isSafeInteger(revision) || keep.has(revision)) continue;
        const filename = path.join(generation.path, entry.name);
        const stats = await lstat(filename);
        if (stats.isSymbolicLink() || !stats.isFile()) continue;
        await unlink(filename);
        removed.push(revision);
      }
      if (removed.length) await syncDirectory(generationHandle);
      return removed;
    } catch (error) {
      throw contextualError("prune", historyId, undefined, error);
    } finally {
      await closeHandles(generationHandle, rootHandle);
    }
  }

  async function remove(historyIdValue) {
    const historyId = validateHistoryId(historyIdValue);
    let rootHandle, generationHandle;
    try {
      rootHandle = await openRoot(root, false);
      if (!rootHandle) return false;
      const generation = await openGeneration(rootHandle, root, historyId, false);
      if (!generation) return false;
      generationHandle = generation.handle;
      await closeHandles(generationHandle);
      generationHandle = null;
      await removeTreeWithoutFollowingLinks(generation.path);
      await rmdir(generation.path);
      await syncDirectory(rootHandle);
      return true;
    } catch (error) {
      throw contextualError("remove", historyId, undefined, error);
    } finally {
      await closeHandles(generationHandle, rootHandle);
    }
  }

  return { write, read, prune, remove };
}
