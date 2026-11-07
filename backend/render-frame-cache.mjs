import { createHash } from "node:crypto";

// The SVG contains resolved font outlines and embedded media, so replacing an asset
// changes this key even when its URL or family name stays the same. All raster callers
// (look, quality checks, stills and movies) use this bounded cache.
export function createRenderFrameCache({ maxBytes = 96 * 1024 * 1024, maxEntries = 1024 } = {}) {
  const entries = new Map();
  let bytes = 0, hits = 0, misses = 0;
  function key(svg, options) {
    return createHash("sha256").update("kino-raster-1\0").update(JSON.stringify(options)).update(svg).digest("hex");
  }
  function get(id) {
    const entry = entries.get(id);
    if (!entry) { misses++; return null; }
    entries.delete(id); entries.set(id, entry); hits++;
    return { ...entry.value, ...(entry.value.buffer ? { buffer: Buffer.from(entry.value.buffer) } : { pixels: Buffer.from(entry.value.pixels) }),
      ...(entry.value.reference ? { reference: Buffer.from(entry.value.reference) } : {}) };
  }
  function set(id, value) {
    const size = (value.buffer ?? value.pixels).byteLength + (value.reference?.byteLength ?? 0);
    if (size > maxBytes) return;
    if (entries.has(id)) { bytes -= entries.get(id).size; entries.delete(id); }
    const copy = { ...value, ...(value.buffer ? { buffer: Buffer.from(value.buffer) } : { pixels: Buffer.from(value.pixels) }),
      ...(value.reference ? { reference: Buffer.from(value.reference) } : {}) };
    entries.set(id, { size, value: copy }); bytes += size;
    while (bytes > maxBytes || entries.size > maxEntries) { const oldest = entries.keys().next().value; bytes -= entries.get(oldest).size; entries.delete(oldest); }
  }
  return { key, get, set, clear() { entries.clear(); bytes = 0; hits = 0; misses = 0; },
    stats() { return { entries: entries.size, bytes, maxBytes, maxEntries, hits, misses }; } };
}

export const renderFrameCache = createRenderFrameCache();
