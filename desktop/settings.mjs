import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Recovery must survive both an app crash and the local server changing ports.
// Each value is an atomic file so a large recovery document does not rewrite other documents.
// Only kino preferences and recovery copies are accessible. The small index below contains
// only per-window recovery keys; it never enumerates comments, share links, or preferences.
const INDEX_FILENAME = "recovery-window-index.json";
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_INDEX_KEYS = 2048;
const RECOVERY_PART = "[A-Za-z0-9_.:-]{1,128}";
const RECOVERY_WINDOW_KEY = new RegExp(`^kino-recovery-window-${RECOVERY_PART}~${RECOVERY_PART}~${RECOVERY_PART}$`);
const RECOVERY_WINDOW_PREFIX = new RegExp(`^kino-recovery-window-(?:${RECOVERY_PART}(?:~(?:${RECOVERY_PART}(?:~[A-Za-z0-9_.:-]{0,128})?)?)?)?$`);
const ALLOWED_SETTING_KEY = /^kino-(last-project|name|comment-identity|comment-pins|comment-reads-[A-Za-z0-9_-]+|share-links-[A-Za-z0-9_-]+|recovery-[A-Za-z0-9_.:-]+)$/;

function isRecoveryWindowKey(key) {
  return typeof key === "string" && key.length <= 480 && RECOVERY_WINDOW_KEY.test(key);
}

function writeAtomically(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, value, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function createDesktopSettings(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const indexPath = path.join(directory, INDEX_FILENAME);

  function filename(key) {
    const windowRecoveryKey = isRecoveryWindowKey(key);
    if (typeof key !== "string" || key.length > (windowRecoveryKey ? 480 : 240) ||
        (!windowRecoveryKey && !ALLOWED_SETTING_KEY.test(key))) {
      throw new Error("Unsupported setting.");
    }
    return path.join(directory, `${createHash("sha256").update(key).digest("hex")}.txt`);
  }

  function readIndex() {
    let serialized;
    try { serialized = readFileSync(indexPath, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Recovery index could not be read.");
    }
    if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) throw new Error("Recovery index is too large.");

    let index;
    try { index = JSON.parse(serialized); }
    catch { throw new Error("Recovery index is invalid."); }
    if (index?.version !== 1 || !Array.isArray(index.keys) || index.keys.length > MAX_INDEX_KEYS)
      throw new Error("Recovery index is invalid.");
    return [...new Set(index.keys.filter(isRecoveryWindowKey))];
  }

  function writeIndex(keys) {
    const serialized = JSON.stringify({ version: 1, keys: [...new Set(keys.filter(isRecoveryWindowKey))].sort() });
    if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) throw new Error("Recovery index is full.");
    writeAtomically(indexPath, serialized);
  }

  function addIndexKey(key) {
    const keys = readIndex();
    if (keys.includes(key)) return;
    if (keys.length >= MAX_INDEX_KEYS) throw new Error("Recovery index is full.");
    writeIndex([...keys, key]);
  }

  function removeIndexKey(key) {
    const keys = readIndex();
    if (keys.includes(key)) writeIndex(keys.filter((entry) => entry !== key));
  }

  function hasSnapshot(key) {
    try { return statSync(filename(key)).isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  return {
    getItem(key) {
      const file = filename(key);
      try { return readFileSync(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    setItem(key, value) {
      const file = filename(key);
      if (typeof value !== "string" || Buffer.byteLength(value) > 32 * 1024 * 1024) throw new Error("Setting is too large.");
      // Persist the index before the snapshot. A crash can leave a stale index entry, which
      // keys() filters by checking for its hashed file, but cannot hide a completed snapshot.
      if (isRecoveryWindowKey(key)) addIndexKey(key);
      writeAtomically(file, value);
    },
    removeItem(key) {
      const file = filename(key);
      try { unlinkSync(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (isRecoveryWindowKey(key)) removeIndexKey(key);
    },
    keys(prefix) {
      if (typeof prefix !== "string" || prefix.length > 480 || !RECOVERY_WINDOW_PREFIX.test(prefix))
        throw new Error("Unsupported setting prefix.");
      return readIndex().filter((key) => key.startsWith(prefix) && hasSnapshot(key)).sort();
    },
  };
}
