import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  chmod,
  lstat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  LOCAL_OWNER,
  changeComment,
  commentNotFound,
  newComment,
  publicComment,
  publicComments,
  removeComment,
  validStoredComments,
} from "./comments.mjs";
import { migrateDocument } from "../engine/documentMigration.js";
import { copyProjectDocument } from "../engine/projectFiles.js";
import { documentMediaIds } from "./media-use.mjs";
import { checkedEasingValue } from "../engine/easing.js";
import { normalizeSavedTextEffect } from "../engine/savedTextEffects.js";
import { createProjectHistory } from "./project-history.mjs";
import { isRecord } from "../engine/numbers.js";

const STORE_FILE = "store.json";
const STORE_VERSION = 1;
const MAX_PROJECT_NAME = 120;
const MAX_FOLDER_NAME = 80;
const MAX_EASING_NAME = 120;
const MAX_EASINGS = 500;
const MAX_TEXT_EFFECTS = 1_000;
const MAX_TEXT_EFFECT_RECORD_BYTES = 256 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HISTORY_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const HISTORY_LIMIT = 50;
const REQUEST_LIMIT = 100;

const rootQueues = new Map();

export class StoreError extends Error {
  constructor(message, code = "ERR_STORE") {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export class ConflictError extends StoreError {
  constructor(currentEntry) {
    super("The project changed since it was loaded.", "ERR_REVISION_CONFLICT");
    this.name = "ConflictError";
    this.current = cloneJson(currentEntry);
    this.currentEntry = this.current;
  }
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new StoreError(
      "The value must contain only JSON data.",
      "ERR_INVALID_DATA",
    );
  }
}

function validateId(id, label = "ID") {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new StoreError(
      `${label} must contain 1 to 128 letters, numbers, underscores, or hyphens.`,
      "ERR_INVALID_ID",
    );
  }
  return id;
}

function validateName(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new StoreError(`${label} must be a string.`, "ERR_INVALID_NAME");
  }
  const name = value.trim();
  if (
    !name ||
    name.length > maxLength ||
    /[\\/\u0000-\u001F\u007F]/.test(name)
  ) {
    throw new StoreError(
      `${label} must be 1 to ${maxLength} characters and cannot contain slashes or control characters.`,
      "ERR_INVALID_NAME",
    );
  }
  return name;
}

function validateEasingName(value) {
  if (typeof value !== "string")
    throw new StoreError("Saved easing name must be a string.", "ERR_INVALID_NAME");
  const name = value.trim();
  if (!name || name.length > MAX_EASING_NAME)
    throw new StoreError(
      `Saved easing name must be 1 to ${MAX_EASING_NAME} characters.`,
      "ERR_INVALID_NAME",
    );
  return name;
}

function validateTextEffectName(value) {
  if (typeof value !== "string")
    throw new StoreError("Saved text effect name must be a string.", "ERR_INVALID_TEXT_EFFECT");
  const name = value.trim();
  if (!name || name.length > 120)
    throw new StoreError("Saved text effect name must be 1 to 120 characters.", "ERR_INVALID_TEXT_EFFECT");
  return name;
}

function validOperationRequest(request) {
  return isRecord(request) && typeof request.id === "string" && REQUEST_ID_PATTERN.test(request.id) &&
    (request.scope === "owner" || HISTORY_ID_PATTERN.test(request.scope)) &&
    typeof request.fingerprint === "string" && /^[a-f0-9]{64}$/.test(request.fingerprint);
}

function validateEasingValue(easing, intensity, hasIntensity) {
  try {
    return cloneJson(checkedEasingValue({
      easing,
      ...(hasIntensity ? { intensity } : {}),
    }));
  } catch (error) {
    throw new StoreError(`Invalid easing value: ${error.message}`, "ERR_INVALID_EASING");
  }
}

function validateEasingInput(input, allowedKeys, label = "Saved easing") {
  if (!isRecord(input))
    throw new StoreError(`${label} must be an object.`, "ERR_INVALID_EASING");
  const unexpected = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length)
    throw new StoreError(`${label} cannot contain ${unexpected.join(", ")}.`, "ERR_INVALID_EASING");
  return input;
}

function newEasingRecord(input) {
  validateEasingInput(input, ["name", "easing", "intensity"]);
  if (!Object.hasOwn(input, "name") || !Object.hasOwn(input, "easing"))
    throw new StoreError("Saved easing needs a name and an easing value.", "ERR_INVALID_EASING");
  const name = validateEasingName(input.name);
  const value = validateEasingValue(input.easing, input.intensity, Object.hasOwn(input, "intensity"));
  return { id: randomUUID(), name, ...value };
}

function newTextEffectRecord(input) {
  if (!isRecord(input))
    throw new StoreError("Saved text effect must be an object.", "ERR_INVALID_TEXT_EFFECT");
  const unexpected = Object.keys(input).filter((key) => !["name", "animation", "rest"].includes(key));
  if (unexpected.length)
    throw new StoreError(`Saved text effect cannot contain ${unexpected.join(", ")}.`, "ERR_INVALID_TEXT_EFFECT");
  let portable;
  try {
    portable = normalizeSavedTextEffect(input);
  } catch (error) {
    throw new StoreError(error.message, "ERR_INVALID_TEXT_EFFECT");
  }
  const record = { id: randomUUID(), ...portable };
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_TEXT_EFFECT_RECORD_BYTES)
    throw new StoreError(`A saved text effect cannot exceed ${MAX_TEXT_EFFECT_RECORD_BYTES} bytes.`, "ERR_TEXT_EFFECT_TOO_LARGE");
  return record;
}

function validateDocument(document) {
  // A document of an older version is stored as the current version (documentMigration.js).
  const copy = migrateDocument(cloneJson(document));
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    throw new StoreError(
      "Project document must be a JSON object.",
      "ERR_INVALID_DOCUMENT",
    );
  }
  validateId(copy.id, "Project ID");
  copy.name = validateName(copy.name, "Project name", MAX_PROJECT_NAME);
  return copy;
}

function validateFolderId(folderId) {
  return folderId === null ? null : validateId(folderId, "Folder ID");
}

function emptyState() {
  return { version: STORE_VERSION, folders: [], projects: [], easings: [], textEffects: [] };
}

function validateLoadedState(state) {
  if (
    !state ||
    state.version !== STORE_VERSION ||
    !Array.isArray(state.folders) ||
    !Array.isArray(state.projects)
  ) {
    throw new StoreError(
      "The project store has an unsupported or invalid format.",
      "ERR_CORRUPT_STORE",
    );
  }

  // Older version-1 stores contain only projects and folders. Keep those stores readable
  // without changing their file until the next successful mutation.
  if (!Object.hasOwn(state, "easings")) state.easings = [];
  if (!Array.isArray(state.easings) || state.easings.length > MAX_EASINGS)
    throw new StoreError(
      "The project store contains an invalid saved easing list.",
      "ERR_CORRUPT_STORE",
    );
  const easingIds = new Set();
  for (const record of state.easings) {
    try {
      if (!isRecord(record) || ["id", "name", "easing"].some((key) => !Object.hasOwn(record, key)))
        throw new Error("Invalid easing record.");
      if (Object.keys(record).some((key) => !["id", "name", "easing", "intensity"].includes(key)))
        throw new Error("Unexpected saved easing field.");
      validateId(record.id, "Easing ID");
      if (easingIds.has(record.id)) throw new Error("Duplicate saved easing ID.");
      record.name = validateEasingName(record.name);
      const value = validateEasingValue(record.easing, record.intensity, Object.hasOwn(record, "intensity"));
      record.easing = value.easing;
      if (Object.hasOwn(value, "intensity")) record.intensity = value.intensity;
      else delete record.intensity;
      easingIds.add(record.id);
    } catch {
      throw new StoreError(
        "The project store contains an invalid saved easing.",
        "ERR_CORRUPT_STORE",
      );
    }
  }

  if (!Object.hasOwn(state, "textEffects")) state.textEffects = [];
  if (!Array.isArray(state.textEffects) || state.textEffects.length > MAX_TEXT_EFFECTS)
    throw new StoreError("The project store contains an invalid saved text effect list.", "ERR_CORRUPT_STORE");
  const textEffectIds = new Set();
  for (const record of state.textEffects) {
    try {
      if (!isRecord(record) || ["id", "name", "animation", "rest"].some((key) => !Object.hasOwn(record, key)))
        throw new Error("Invalid text effect record.");
      if (Object.keys(record).some((key) => !["id", "name", "animation", "rest"].includes(key)))
        throw new Error("Unexpected saved text effect field.");
      validateId(record.id, "Text effect ID");
      if (textEffectIds.has(record.id)) throw new Error("Duplicate saved text effect ID.");
      const portable = normalizeSavedTextEffect(record);
      record.name = portable.name;
      record.animation = portable.animation;
      record.rest = portable.rest;
      if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_TEXT_EFFECT_RECORD_BYTES)
        throw new Error("Saved text effect exceeds its size limit.");
      textEffectIds.add(record.id);
    } catch {
      throw new StoreError("The project store contains an invalid saved text effect.", "ERR_CORRUPT_STORE");
    }
  }

  const folderIds = new Set();
  for (const folder of state.folders) {
    if (!folder || typeof folder !== "object")
      throw new StoreError(
        "The project store contains an invalid folder.",
        "ERR_CORRUPT_STORE",
      );
    validateId(folder.id, "Folder ID");
    validateName(folder.name, "Folder name", MAX_FOLDER_NAME);
    if (folderIds.has(folder.id))
      throw new StoreError(
        "The project store contains duplicate folders.",
        "ERR_CORRUPT_STORE",
      );
    if (typeof folder.createdAt !== "string")
      throw new StoreError(
        "The project store contains an invalid folder timestamp.",
        "ERR_CORRUPT_STORE",
      );
    folderIds.add(folder.id);
  }

  const projectIds = new Set();
  for (const project of state.projects) {
    if (!project || typeof project !== "object")
      throw new StoreError(
        "The project store contains an invalid project.",
        "ERR_CORRUPT_STORE",
      );
    const document = validateDocument(project.document);
    if (projectIds.has(document.id))
      throw new StoreError(
        "The project store contains duplicate project IDs.",
        "ERR_CORRUPT_STORE",
      );
    if (
      !Number.isSafeInteger(project.revision) ||
      project.revision < 1 ||
      typeof project.createdAt !== "string" ||
      typeof project.updatedAt !== "string" ||
      !Array.isArray(project.comments)
    ) {
      throw new StoreError(
        "The project store contains invalid project metadata.",
        "ERR_CORRUPT_STORE",
      );
    }
    if ((project.historyId !== undefined && !HISTORY_ID_PATTERN.test(project.historyId)) ||
        (project.historyRevisions !== undefined && (!Array.isArray(project.historyRevisions) ||
          !project.historyId || project.historyRevisions.length >= HISTORY_LIMIT ||
          new Set(project.historyRevisions).size !== project.historyRevisions.length ||
          project.historyRevisions.some((revision) => !Number.isSafeInteger(revision) || revision < 1 || revision >= project.revision))) ||
        (project.operationReceipts !== undefined && (!Array.isArray(project.operationReceipts) ||
          project.operationReceipts.length > REQUEST_LIMIT || project.operationReceipts.some((receipt) =>
            !validOperationRequest(receipt) || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 ||
            receipt.revision > project.revision || !isRecord(receipt.result) || receipt.result.revision !== receipt.revision)))) {
      throw new StoreError("The project store contains invalid revision history.", "ERR_CORRUPT_STORE");
    }
    if (project.folderId !== null && !folderIds.has(project.folderId))
      throw new StoreError(
        "The project store refers to a missing folder.",
        "ERR_CORRUPT_STORE",
      );
    if (project.trashedAt !== null && typeof project.trashedAt !== "string")
      throw new StoreError(
        "The project store contains an invalid trash timestamp.",
        "ERR_CORRUPT_STORE",
      );
    // Comment fields and reply links are checked in comments.mjs.
    if (!validStoredComments(project.comments)) {
      throw new StoreError(
        "The project store contains an invalid comment.",
        "ERR_CORRUPT_STORE",
      );
    }
    projectIds.add(document.id);
  }
  return state;
}

// Brings every project's document up to the current document version (documentMigration.js), so
// a project saved by an older kino opens and draws the same. Returns whether any changed.
function migrateProjects(state) {
  let changed = false;
  for (const project of state.projects) {
    const document = migrateDocument(project.document);
    if (document === project.document) continue;
    project.document = document;
    changed = true;
  }
  return changed;
}

async function readState(storePath) {
  let details;
  try {
    details = await lstat(storePath);
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw new StoreError(
      `Could not inspect the project store: ${error.message}`,
      "ERR_STORE_IO",
    );
  }
  if (!details.isFile())
    throw new StoreError(
      "The project store path must be a regular file.",
      "ERR_INVALID_STORE_PATH",
    );
  try {
    return validateLoadedState(JSON.parse(await readFile(storePath, "utf8")));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(
      "The project store could not be read as valid JSON.",
      "ERR_CORRUPT_STORE",
    );
  }
}

async function writeState(storePath, state, directory) {
  const temporaryPath = path.join(
    directory,
    `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let file;
  try {
    file = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = null;
    await rename(temporaryPath, storePath);
    try {
      const directoryHandle = await open(directory, "r");
      await directoryHandle.sync();
      await directoryHandle.close();
    } catch {
      // Directory fsync is unavailable on some supported filesystems; rename is still atomic.
    }
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw new StoreError(
      `Could not save the project store: ${error.message}`,
      "ERR_STORE_IO",
    );
  }
}

function enqueue(root, operation) {
  const previous = rootQueues.get(root) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  rootQueues.set(root, tail);
  tail.finally(() => {
    if (rootQueues.get(root) === tail) rootQueues.delete(root);
  });
  return result;
}

// The project whose comments a write changes. A trashed project's comments stay as they are
// until it is restored.
function commentProject(state, projectId) {
  const project = state.projects.find((entry) => entry.document.id === projectId);
  if (!project)
    throw new StoreError("Project does not exist.", "ERR_PROJECT_NOT_FOUND");
  if (project.trashedAt !== null)
    throw new StoreError(
      "A trashed project's comments cannot change. Restore the project first.",
      "ERR_PROJECT_TRASHED",
    );
  return project;
}

function projectEntry(project) {
  const entry = {
    document: cloneJson(project.document),
    revision: project.revision,
    folderId: project.folderId,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    // Comments leave the store without their author key hashes (see comments.mjs).
    comments: publicComments(cloneJson(project.comments)),
  };
  if (project.trashedAt !== null) entry.trashedAt = project.trashedAt;
  return entry;
}

function projectSummary(project) {
  return {
    id: project.document.id,
    name: project.document.name,
    folderId: project.folderId,
    updatedAt: project.updatedAt,
    sceneCount: Array.isArray(project.document.scenes)
      ? project.document.scenes.length
      : 0,
    revision: project.revision,
  };
}

export async function openStore(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new StoreError(
      "Store root must be an absolute directory path.",
      "ERR_INVALID_STORE_ROOT",
    );
  }
  const directory = path.resolve(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const storePath = path.join(directory, STORE_FILE);
  const history = createProjectHistory(path.join(directory, "project-history"));

  async function archivedDocument(project, revision) {
    if (revision === project.revision) return cloneJson(project.document);
    if (!project.historyId) return null;
    let document;
    try { document = await history.read(project.historyId, revision); }
    catch { throw new StoreError("The saved revision could not be read.", "ERR_STORE_IO"); }
    if (document === null) return null;
    if (document.id !== project.document.id)
      throw new StoreError("The saved revision belongs to a different file.", "ERR_CORRUPT_STORE");
    return validateDocument(document);
  }

  async function operationResult(project, request) {
    const receipt = project.operationReceipts?.find((item) => item.id === request.id && item.scope === request.scope);
    if (!receipt) return null;
    if (receipt.fingerprint !== request.fingerprint)
      throw new StoreError("This request ID was already used for different operations.", "ERR_REQUEST_ID_REUSE");
    const document = await archivedDocument(project, receipt.revision);
    // A missing receipt document must never cause the operation to run twice.
    if (!document) throw new StoreError("The first result for this request could not be read.", "ERR_STORE_IO");
    return { ...cloneJson(receipt.result), document };
  }

  async function read(operation) {
    return enqueue(directory, async () => {
      const state = await readState(storePath);
      // Projects of an older document version are saved back in the current one, once. If that
      // save fails (a read-only disk), reading still works and the next save tries again.
      if (migrateProjects(state))
        await writeState(storePath, state, directory).catch(() => {});
      return operation(state);
    });
  }

  async function mutate(operation) {
    return enqueue(directory, async () => {
      const state = await readState(storePath);
      migrateProjects(state);
      const next = cloneJson(state);
      const result = await operation(next);
      const previous = new Map(state.projects.map((project) => [project.document.id, project]));
      const changed = [];
      for (const project of next.projects) {
        const before = previous.get(project.document.id);
        if (!before || before.revision === project.revision) continue;
        project.historyId = before.historyId || randomUUID();
        project.historyRevisions = [...(before.historyRevisions || []), before.revision].slice(-(HISTORY_LIMIT - 1));
        // The old revision is durable before the index can refer to it. A failed
        // store rename may leave an unreferenced file, which the next prune removes.
        try {
          const existing = await history.read(project.historyId, before.revision);
          if (existing === null) await history.write(project.historyId, before.revision, before.document);
          else if (!isDeepStrictEqual(validateDocument(existing), before.document)) throw new Error("Revision archive differs.");
        }
        catch { throw new StoreError("The previous revision could not be saved.", "ERR_STORE_IO"); }
        changed.push(project);
      }
      await writeState(storePath, next, directory);
      for (const project of changed) {
        const keep = new Set([...project.historyRevisions, ...(project.operationReceipts || []).map((receipt) => receipt.revision)]);
        keep.delete(project.revision);
        // Cleanup failure cannot turn a committed edit into a reported failure.
        await history.prune(project.historyId, [...keep]).catch(() => {});
      }
      const remaining = new Set(next.projects.map((project) => project.document.id));
      for (const project of state.projects) {
        if (project.historyId && !remaining.has(project.document.id))
          await history.remove(project.historyId).catch(() => {});
      }
      return cloneJson(result);
    });
  }

  async function updateComment(projectId, commentId, patch, actor = LOCAL_OWNER) {
    validateId(projectId, "Project ID");
    validateId(commentId, "Comment ID");
    return mutate((state) => {
      const project = commentProject(state, projectId);
      const comment = project.comments.find((entry) => entry.id === commentId);
      if (!comment) throw commentNotFound();
      changeComment(comment, patch, { document: project.document, actor });
      project.updatedAt = new Date().toISOString();
      return publicComment(comment);
    });
  }

  return {
    async listProjects() {
      return read((state) =>
        state.projects
          .filter((project) => project.trashedAt === null)
          .map(projectSummary),
      );
    },

    async listTrashedProjects() {
      return read((state) => state.projects
        .filter((project) => project.trashedAt !== null)
        .map((project) => ({ ...projectSummary(project), trashedAt: project.trashedAt }))
        .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt)));
    },

    // Trashed files and historical media permissions still retain their sources.
    async projectMediaReferences(fonts) {
      return read((state) => state.projects.map((project) => ({
        id: project.document.id, mediaIds: [...documentMediaIds(project.document, { fonts })],
      })));
    },

    async getProject(id) {
      validateId(id, "Project ID");
      return read((state) => {
        const project = state.projects.find(
          (entry) => entry.document.id === id,
        );
        return project ? projectEntry(project) : null;
      });
    },

    async getProjectRevision(id, revision) {
      validateId(id, "Project ID");
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new StoreError("Revision must be a positive integer.", "ERR_INVALID_REVISION");
      return read(async (state) => {
        const project = state.projects.find((entry) => entry.document.id === id);
        if (!project || (revision !== project.revision && !project.historyRevisions?.includes(revision))) return null;
        return archivedDocument(project, revision);
      });
    },

    async getOperationResult(id, request) {
      validateId(id, "Project ID");
      if (!validOperationRequest(request)) throw new StoreError("Invalid operation request.", "ERR_INVALID_REQUEST");
      return read(async (state) => operationResult(commentProject(state, id), request));
    },

    async listEasings() {
      return read((state) => state.easings.map((record) => cloneJson(record)));
    },

    async saveEasing(input) {
      const record = newEasingRecord(input);
      return mutate((state) => {
        if (state.easings.length >= MAX_EASINGS)
          throw new StoreError(`The workspace can store at most ${MAX_EASINGS} easings.`, "ERR_EASING_LIMIT");
        state.easings.push(record);
        return record;
      });
    },

    async renameEasing(id, name) {
      validateId(id, "Easing ID");
      const validatedName = validateEasingName(name);
      return mutate((state) => {
        const record = state.easings.find((entry) => entry.id === id);
        if (!record) throw new StoreError("Saved easing does not exist.", "ERR_EASING_NOT_FOUND");
        record.name = validatedName;
        return record;
      });
    },

    async deleteEasing(id) {
      validateId(id, "Easing ID");
      return mutate((state) => {
        const index = state.easings.findIndex((entry) => entry.id === id);
        if (index < 0) throw new StoreError("Saved easing does not exist.", "ERR_EASING_NOT_FOUND");
        state.easings.splice(index, 1);
        return { deleted: id };
      });
    },

    async listTextEffects() {
      return read((state) => state.textEffects.map((record) => cloneJson(record)));
    },

    async saveTextEffect(input) {
      const record = newTextEffectRecord(input);
      return mutate((state) => {
        if (state.textEffects.length >= MAX_TEXT_EFFECTS)
          throw new StoreError(`The workspace can store at most ${MAX_TEXT_EFFECTS} text effects.`, "ERR_TEXT_EFFECT_LIMIT");
        state.textEffects.push(record);
        return record;
      });
    },

    async renameTextEffect(id, name) {
      validateId(id, "Text effect ID");
      const validatedName = validateTextEffectName(name);
      return mutate((state) => {
        const record = state.textEffects.find((entry) => entry.id === id);
        if (!record) throw new StoreError("Saved text effect does not exist.", "ERR_TEXT_EFFECT_NOT_FOUND");
        const renamed = { ...record, name: validatedName };
        if (Buffer.byteLength(JSON.stringify(renamed), "utf8") > MAX_TEXT_EFFECT_RECORD_BYTES)
          throw new StoreError(`A saved text effect cannot exceed ${MAX_TEXT_EFFECT_RECORD_BYTES} bytes.`, "ERR_TEXT_EFFECT_TOO_LARGE");
        record.name = validatedName;
        return record;
      });
    },

    async deleteTextEffect(id) {
      validateId(id, "Text effect ID");
      return mutate((state) => {
        const index = state.textEffects.findIndex((entry) => entry.id === id);
        if (index < 0) throw new StoreError("Saved text effect does not exist.", "ERR_TEXT_EFFECT_NOT_FOUND");
        state.textEffects.splice(index, 1);
        return { deleted: id };
      });
    },

    async createProject(document, folderId = null) {
      const validatedDocument = validateDocument(document);
      const validatedFolderId = validateFolderId(folderId);
      return mutate((state) => {
        if (
          state.projects.some(
            (project) => project.document.id === validatedDocument.id,
          )
        ) {
          throw new StoreError(
            `Project "${validatedDocument.id}" already exists.`,
            "ERR_DUPLICATE_PROJECT",
          );
        }
        if (
          validatedFolderId !== null &&
          !state.folders.some((folder) => folder.id === validatedFolderId)
        ) {
          throw new StoreError(
            "Target folder does not exist.",
            "ERR_FOLDER_NOT_FOUND",
          );
        }
        const now = new Date().toISOString();
        const project = {
          document: validatedDocument,
          revision: 1,
          historyId: randomUUID(),
          historyRevisions: [],
          operationReceipts: [],
          folderId: validatedFolderId,
          updatedAt: now,
          createdAt: now,
          comments: [],
          trashedAt: null,
        };
        state.projects.push(project);
        return projectEntry(project);
      });
    },

    async updateProject(id, document, expectedRevision, { merge, request, resultMetadata = {} } = {}) {
      validateId(id, "Project ID");
      const validatedDocument = validateDocument(document);
      if (validatedDocument.id !== id)
        throw new StoreError(
          "Document ID must match the project ID.",
          "ERR_INVALID_DOCUMENT",
        );
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new StoreError(
          "Expected revision must be a positive integer.",
          "ERR_INVALID_REVISION",
        );
      }
      if (request !== undefined && !validOperationRequest(request))
        throw new StoreError("Invalid operation request.", "ERR_INVALID_REQUEST");
      return mutate(async (state) => {
        const project = state.projects.find(
          (entry) => entry.document.id === id,
        );
        if (!project)
          throw new StoreError(
            "Project does not exist.",
            "ERR_PROJECT_NOT_FOUND",
          );
        if (project.trashedAt !== null)
          throw new StoreError(
            "A trashed project must be restored before it can be updated.",
            "ERR_PROJECT_TRASHED",
          );
        if (request) {
          const firstResult = await operationResult(project, request);
          if (firstResult) return firstResult;
        }
        let merged = null;
        if (project.revision !== expectedRevision) {
          if (!merge || !project.historyRevisions?.includes(expectedRevision))
            throw new ConflictError(projectEntry(project));
          try {
            const base = await archivedDocument(project, expectedRevision);
            if (!base) throw new Error("Missing base revision.");
            const result = merge(base, validatedDocument, cloneJson(project.document));
            const mergedDocument = validateDocument(result.document);
            if (mergedDocument.id !== id || !Array.isArray(result.conflicts)) throw new Error("Invalid merge result.");
            merged = { merged: true, conflicts: result.conflicts,
              previousDocument: cloneJson(project.document), previousRevision: project.revision };
            project.document = mergedDocument;
          } catch {
            throw new ConflictError(projectEntry(project));
          }
        } else project.document = validatedDocument;
        project.revision += 1;
        project.updatedAt = new Date().toISOString();
        const result = { ...resultMetadata, ...projectEntry(project), ...(merged || {}) };
        if (request) {
          const { document: _document, ...metadata } = result;
          project.operationReceipts = [...(project.operationReceipts || []),
            { ...request, revision: project.revision, result: metadata }].slice(-REQUEST_LIMIT);
        }
        return result;
      });
    },

    async duplicateProject(id) {
      validateId(id, "Project ID");
      return mutate((state) => {
        const source = commentProject(state, id);
        const now = new Date().toISOString();
        const project = {
          document: copyProjectDocument(source.document, randomUUID()),
          revision: 1, folderId: source.folderId, createdAt: now, updatedAt: now,
          historyId: randomUUID(), historyRevisions: [], operationReceipts: [],
          comments: [], trashedAt: null,
        };
        state.projects.unshift(project);
        return projectEntry(project);
      });
    },

    async renameProject(id, name) {
      validateId(id, "Project ID");
      const validatedName = validateName(name, "Project name", MAX_PROJECT_NAME);
      return mutate((state) => {
        const project = commentProject(state, id);
        project.document.name = validatedName;
        project.revision += 1;
        project.updatedAt = new Date().toISOString();
        return projectEntry(project);
      });
    },

    async trashProject(id) {
      validateId(id, "Project ID");
      return mutate((state) => {
        const project = state.projects.find(
          (entry) => entry.document.id === id,
        );
        if (!project)
          throw new StoreError(
            "Project does not exist.",
            "ERR_PROJECT_NOT_FOUND",
          );
        if (project.trashedAt !== null)
          throw new StoreError(
            "Project is already in the trash.",
            "ERR_PROJECT_TRASHED",
          );
        project.trashedAt = new Date().toISOString();
        project.updatedAt = project.trashedAt;
        project.revision += 1;
        return projectEntry(project);
      });
    },

    async restoreProject(id) {
      validateId(id, "Project ID");
      return mutate((state) => {
        const project = state.projects.find(
          (entry) => entry.document.id === id,
        );
        if (!project)
          throw new StoreError(
            "Project does not exist.",
            "ERR_PROJECT_NOT_FOUND",
          );
        if (project.trashedAt === null)
          throw new StoreError(
            "Project is not in the trash.",
            "ERR_PROJECT_NOT_TRASHED",
          );
        project.trashedAt = null;
        if (!state.folders.some((folder) => folder.id === project.folderId)) project.folderId = null;
        project.revision += 1;
        project.updatedAt = new Date().toISOString();
        return projectEntry(project);
      });
    },

    async deleteProjectForever(id) {
      validateId(id, "Project ID");
      return mutate((state) => {
        const index = state.projects.findIndex((project) => project.document.id === id);
        if (index < 0) throw new StoreError("Project does not exist.", "ERR_PROJECT_NOT_FOUND");
        const project = state.projects[index];
        if (project.trashedAt === null) throw new StoreError("Move this project to Trash before deleting it forever.", "ERR_PROJECT_NOT_TRASHED");
        state.projects.splice(index, 1);
        return { id };
      });
    },

    async listFolders() {
      return read((state) =>
        state.folders.map(({ id, name }) => ({ id, name })),
      );
    },

    async createFolder(name) {
      const validatedName = validateName(name, "Folder name", MAX_FOLDER_NAME);
      return mutate((state) => {
        const folder = {
          id: randomUUID(),
          name: validatedName,
          createdAt: new Date().toISOString(),
        };
        state.folders.push(folder);
        return { id: folder.id, name: folder.name };
      });
    },

    async renameFolder(id, name) {
      validateId(id, "Folder ID");
      const validatedName = validateName(name, "Folder name", MAX_FOLDER_NAME);
      return mutate((state) => {
        const folder = state.folders.find((entry) => entry.id === id);
        if (!folder)
          throw new StoreError(
            "Folder does not exist.",
            "ERR_FOLDER_NOT_FOUND",
          );
        folder.name = validatedName;
        return { id: folder.id, name: folder.name };
      });
    },

    async deleteFolder(id) {
      validateId(id, "Folder ID");
      return mutate((state) => {
        const index = state.folders.findIndex((entry) => entry.id === id);
        if (index < 0)
          throw new StoreError(
            "Folder does not exist.",
            "ERR_FOLDER_NOT_FOUND",
          );
        state.folders.splice(index, 1);
        const now = new Date().toISOString();
        const trashedProjectIds = [];
        for (const project of state.projects) {
          if (project.folderId === id) {
            project.folderId = null;
            if (project.trashedAt === null) {
              project.trashedAt = now;
              project.updatedAt = now;
              project.revision += 1;
              trashedProjectIds.push(project.document.id);
            }
          }
        }
        return { id, trashedProjectIds };
      });
    },

    async moveProject(id, folderId) {
      validateId(id, "Project ID");
      const validatedFolderId = validateFolderId(folderId);
      return mutate((state) => {
        const project = state.projects.find(
          (entry) => entry.document.id === id,
        );
        if (!project)
          throw new StoreError(
            "Project does not exist.",
            "ERR_PROJECT_NOT_FOUND",
          );
        if (project.trashedAt !== null)
          throw new StoreError(
            "A trashed project cannot be moved.",
            "ERR_PROJECT_TRASHED",
          );
        if (
          validatedFolderId !== null &&
          !state.folders.some((folder) => folder.id === validatedFolderId)
        ) {
          throw new StoreError(
            "Target folder does not exist.",
            "ERR_FOLDER_NOT_FOUND",
          );
        }
        if (project.folderId !== validatedFolderId) {
          project.folderId = validatedFolderId;
          project.updatedAt = new Date().toISOString();
        }
        return projectEntry(project);
      });
    },

    // Comment writes. `actor` is {role, keyHash}: the request's access role and the SHA-256 hash of
    // its comment key (or null). It defaults to the local owner; requests through a share link pass
    // that link's role. comments.mjs holds the rules. Each write returns comments without their
    // author key hashes and moves the project's updatedAt.
    async addComment(projectId, input, actor = LOCAL_OWNER) {
      validateId(projectId, "Project ID");
      return mutate((state) => {
        const project = commentProject(state, projectId);
        const comment = newComment(input, {
          projectId,
          document: project.document,
          comments: project.comments,
          actor,
        });
        project.comments.push(comment);
        project.updatedAt = comment.createdAt;
        return publicComment(comment);
      });
    },

    // `patch` may hold text, mentions, x, y, sceneId, time, and resolved.
    updateComment,

    // Deleting a thread's first comment deletes its replies too. Returns {deleted: [comment IDs]}.
    async deleteComment(projectId, commentId, actor = LOCAL_OWNER) {
      validateId(projectId, "Project ID");
      validateId(commentId, "Comment ID");
      return mutate((state) => {
        const project = commentProject(state, projectId);
        const { remaining, deleted } = removeComment(project.comments, commentId, { actor });
        project.comments = remaining;
        project.updatedAt = new Date().toISOString();
        return { deleted };
      });
    },

    async resolveComment(projectId, commentId, resolved = true, actor = LOCAL_OWNER) {
      return updateComment(projectId, commentId, { resolved }, actor);
    },
  };
}
