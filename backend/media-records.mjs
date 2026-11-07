// The media library's records: one <id>.json beside each file in the media folder.
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a new record in one rename, so a reader (or a crash part-way) never leaves half-written
 * JSON. The temporary name does not end in .json, so record listings never pick it up.
 */
export async function writeMediaRecord(mediaRoot, id, record) {
  const target = path.join(mediaRoot, `${id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Every readable record in the media folder. A record that cannot be read (cut short by a crash,
 * or not JSON) is left out and named once through `warn`, instead of failing every listing.
 */
export function createMediaRecordReader(mediaRoot, { warn = console.warn } = {}) {
  const told = new Set();
  return async function readMediaRecords() {
    const names = (await readdir(mediaRoot)).filter((name) => name.endsWith(".json"));
    const records = await Promise.all(names.map(async (name) => {
      try {
        const record = JSON.parse(await readFile(path.join(mediaRoot, name), "utf8"));
        if (record && typeof record === "object" && !Array.isArray(record)) return record;
        throw new Error("it is not a record");
      } catch (error) {
        if (error.code === "ENOENT") return null; // removed while listing
        if (!told.has(name)) {
          told.add(name);
          warn(`[kino] Skipping the unreadable media record ${name}: ${error.message}`);
        }
        return null;
      }
    }));
    return records.filter(Boolean);
  };
}
