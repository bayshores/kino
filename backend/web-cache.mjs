// A small file cache for answers kino gets from the web (song searches, footage searches), so the
// same search again within ttlMs answers at once and asks no one. One JSON file per key in
// `directory`, named by the key's sha1. A write goes to its own temporary name first and is then
// renamed, so two agents running the same search at once never read a half-written file.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Makes a cache in `directory` whose answers last `ttlMs`. `now` is the clock (tests pass their own).
 * Returns {cached}: cached(key, make) answers the saved result for `key` while it is fresh, or
 * runs make(), saves what it resolves to and answers that. A failed make() saves nothing.
 */
export function createWebCache({ directory, ttlMs, now = Date.now }) {
  if (!directory) throw new Error("createWebCache needs a directory.");
  if (!(ttlMs > 0)) throw new Error("createWebCache needs ttlMs above 0.");

  async function cached(key, make) {
    const file = path.join(directory, `${createHash("sha1").update(key).digest("hex")}.json`);
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (now() - saved.at < ttlMs) return saved.results;
    } catch { /* not cached */ }
    const results = await make();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Its own temporary name: the same search running twice at once (two agents) must not collide.
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ at: now(), results }), { mode: 0o600 });
    await rename(temporary, file);
    return results;
  }

  return { cached };
}
