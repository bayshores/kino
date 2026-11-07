// Temporary folders kino makes in the computer's temp folder (os.tmpdir()) for one job: an export,
// a frame check, a sound mix, a download. Each job removes its own folder when it ends, also when
// it fails or is cancelled. A process that is killed part-way (the app quits, a test run is
// stopped) cannot, so the server sweeps old ones when it starts (sweepTempFolders).
//
// A folder made here carries the pid of the process that made it in its name:
// "kino-export-p4242-AbC123". The sweep keeps a folder while that process is alive.
import { rmSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The names kino gives its temporary folders. The sweep removes only folders that start with one
 * of these, and nothing else in the temp folder. Keep the list in step with the code that makes
 * them (makeTempFolder callers, and the test helpers named at the end).
 */
export const TEMP_FOLDER_PREFIXES = [
  // The server (makeTempFolder).
  "kino-export-", "kino-frames-", "kino-mix-", "kino-batch-", "kino-batch-download-", "kino-download-",
  "kino-remux-", "kino-sound-", "kino-speech-", "kino-preview-",
  // Tests and scripts (they remove their own; these are what a stopped run leaves).
  "kino-test-server-", "kino-dashboard-browser-", "kino-inspire-profile-", "kino-blur-chromium-",
  "kino-crew-", "kino-desktop-profile-", "kino-desktop-data-", "kino-golden-media-", "kino-blocks-",
  "kino-test-times-", "kino-icon-",
];

/** A folder whose maker has stopped is removed once it is this old. */
export const DEAD_OWNER_AGE_MS = 6 * 60 * 60 * 1000;
/** A folder with no maker in its name (made by a test, a script or an older kino) waits this long. */
export const NO_OWNER_AGE_MS = 24 * 60 * 60 * 1000;

// The folders this process made and has not removed yet, removed when the process exits.
const ownFolders = new Set();
let exitHook = false;

/** Makes a new folder in the temp folder named `${prefix}p<pid>-XXXXXX`; resolves to its path. */
export async function makeTempFolder(prefix, { root = tmpdir() } = {}) {
  if (!TEMP_FOLDER_PREFIXES.includes(prefix)) throw new Error(`Add "${prefix}" to TEMP_FOLDER_PREFIXES first.`);
  const folder = await mkdtemp(join(root, `${prefix}p${process.pid}-`));
  ownFolders.add(folder);
  if (!exitHook) {
    exitHook = true;
    process.once("exit", removeOwnTempFoldersSync);
  }
  return folder;
}

/** Removes a folder makeTempFolder made. Never throws. */
export async function removeTempFolder(folder) {
  if (!folder) return;
  ownFolders.delete(folder);
  await rm(folder, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
}

/** Removes every folder this process made and still has, at once (for process exit). */
export function removeOwnTempFoldersSync() {
  for (const folder of ownFolders) {
    try { rmSync(folder, { recursive: true, force: true }); } catch { /* the sweep gets it later */ }
  }
  ownFolders.clear();
}

/** The pid in a folder name "…-p<pid>-XXXXXX", or null when the name has none. */
export function ownerPid(name) {
  const match = /-p(\d{1,10})-[A-Za-z0-9]{6}$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** True when a process with this pid is running. */
export function pidAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return error.code === "EPERM";
  }
}

// Bytes in a folder and everything in it. Links are counted, not followed.
async function folderBytes(path) {
  let total = 0;
  const info = await lstat(path).catch(() => null);
  if (!info) return 0;
  total += info.size;
  if (!info.isDirectory()) return total;
  const names = await readdir(path).catch(() => []);
  for (const name of names) total += await folderBytes(join(path, name));
  return total;
}

/**
 * Removes kino's old temporary folders from `root` (the temp folder): those whose maker has
 * stopped and that are older than DEAD_OWNER_AGE_MS, and those with no maker in their name that
 * are older than NO_OWNER_AGE_MS. Age is the time since the folder last changed. Only folders whose
 * names start with TEMP_FOLDER_PREFIXES are looked at. Resolves to { removed: [names], bytes }.
 * Never throws.
 */
export async function sweepTempFolders({ root = tmpdir(), now = Date.now(), isAlive = pidAlive } = {}) {
  let names = [];
  try { names = await readdir(root); } catch { return { removed: [], bytes: 0 }; }
  const removed = [];
  let bytes = 0;
  for (const name of names) {
    if (!TEMP_FOLDER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const folder = join(root, name);
    try {
      const info = await lstat(folder);
      if (!info.isDirectory()) continue;
      const age = now - info.mtimeMs;
      const pid = ownerPid(name);
      if (pid === null ? age < NO_OWNER_AGE_MS : age < DEAD_OWNER_AGE_MS || isAlive(pid)) continue;
      const size = await folderBytes(folder);
      await rm(folder, { recursive: true, force: true });
      removed.push(name);
      bytes += size;
    } catch { /* gone already, or not ours to read */ }
  }
  return { removed: removed.sort(), bytes };
}

/** The one log line for a sweep, or null when nothing was removed. */
export function sweepSummary({ removed, bytes }) {
  if (!removed.length) return null;
  const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `kino removed ${removed.length} leftover temporary folder${removed.length === 1 ? "" : "s"} (${size}).`;
}
