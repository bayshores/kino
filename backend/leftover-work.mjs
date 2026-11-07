// The work folders (".work-…", ".media-…") a server stopped part-way (killed, or the computer
// shut down) leaves in a cut-out or voice cache. A job removes its own folder when it finishes or
// fails, and keeps adding files to it while it runs, so only folders left alone for an hour are
// removed: two servers that share a data folder never remove each other's running work.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const LEFTOVER_AGE_MS = 60 * 60 * 1000;

/** Removes the old work folders in `dir`; resolves to their names. Never throws. */
export async function removeLeftoverWork(dir, { prefixes = [".work-", ".media-"], olderThanMs = LEFTOVER_AGE_MS, now = Date.now() } = {}) {
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const removed = [];
  await Promise.all(names.filter((name) => prefixes.some((prefix) => name.startsWith(prefix))).map(async (name) => {
    const folder = join(dir, name);
    try {
      if (now - (await stat(folder)).mtimeMs < olderThanMs) return;
      await rm(folder, { recursive: true, force: true });
      removed.push(name);
    } catch { /* already gone */ }
  }));
  return removed.sort();
}
