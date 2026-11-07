import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "../engine/csv.js";
import { bulkCreateImageNames } from "../engine/bulkCreate.js";

const MEDIA_SOURCE = /^\/api\/media\/([a-f0-9-]+\.(?:png|jpg|jpeg|webp|gif|svg))$/;
const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif|svg)$/i;

// MCP CSV cells contain saved sources rather than local files. Recover their existing upload
// measurements so swapping a GIF uses its own length. Read only the service's media records,
// and only files already accessible to this project/session; no other application's state.
export async function loadBulkCreateMediaSources(operations, { mediaRoot, allowedIds = null, document }) {
  const sources = new Set(), names = new Set(), results = new Map();
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (operation?.type !== "bulk_create") continue;
    const parsed = typeof operation.csv === "string" ? parseCsv(operation.csv)
      : { header: operation.rows?.[0], rows: operation.rows?.slice(1) };
    const rows = parsed.rows;
    const knownScene = document?.scenes.some((scene) => scene.id === operation.sceneId);
    if (knownScene && Array.isArray(parsed.header) && Array.isArray(rows)) {
      for (const name of bulkCreateImageNames(document, operation.sceneId, parsed.header, rows)) names.add(name.toLowerCase());
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const cell of Array.isArray(row) ? row : []) {
        if (typeof cell !== "string") continue;
        if (MEDIA_SOURCE.test(cell)) sources.add(cell);
        // A batch may add or rename image columns before bulk_create. Its current image-column
        // match happens later in applyOperations, so consider row values as filename candidates
        // here and resolve them only against media records this project is allowed to use.
        // Without a document, retain the filename-extension guard for the legacy caller.
        else if (!cell.startsWith("/api/media/") && (document || IMAGE_NAME.test(cell))) names.add(cell.toLowerCase());
      }
    }
  }
  for (const src of sources) {
    const id = src.match(MEDIA_SOURCE)[1];
    if (allowedIds && !allowedIds.has(id)) continue; // Normal document access validation refuses it.
    try {
      const metadata = JSON.parse(await readFile(path.join(mediaRoot, `${id}.json`), "utf8"));
      if (metadata.src === src && metadata.mime?.startsWith("image/")) results.set(src, metadata);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Filename cells from a scene template refer only to permitted records in this store.
  // Never treat a CSV filename as a filesystem path or open files outside mediaRoot.
  if (names.size) {
    const ids = allowedIds ?? (await readdir(mediaRoot)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
    for (const id of ids) {
      if (!/^[a-f0-9-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(id)) continue;
      try {
        const metadata = JSON.parse(await readFile(path.join(mediaRoot, `${id}.json`), "utf8"));
        if (metadata.src === `/api/media/${id}` && metadata.mime?.startsWith("image/") && names.has(metadata.name?.toLowerCase()))
          results.set(metadata.src, metadata);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return results;
}
