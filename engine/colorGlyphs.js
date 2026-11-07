import { Gunzip } from "fflate";
import { readColorFontTables } from "./colorFontTables.js";
import { createColorGlyphSvgSanitizer } from "./colorGlyphSvg.js";

const MAX_SVG_BYTES = 8 * 1024 * 1024;
const MAX_GLYPH_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_PARSED_SOURCE_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function bytesDataUrl(bytes, mime) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${mime};base64,${btoa(text)}`;
}

function svgText(bytes, gzip) {
  if (bytes.length > MAX_SVG_BYTES) throw new Error("The color glyph exceeds its SVG size limit.");
  if (gzip) {
    if (bytes.length < 18) throw new Error("The compressed color glyph is incomplete.");
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true);
    if (size > MAX_SVG_BYTES) throw new Error("The color glyph exceeds its decompression limit.");
    const chunks = [];
    let length = 0;
    const inflater = new Gunzip((chunk) => {
      length += chunk.length;
      if (length > size || length > MAX_SVG_BYTES) throw new Error("The compressed color glyph has an invalid length.");
      chunks.push(chunk);
    });
    // Small compressed input chunks bound each inflate allocation even when
    // an untrusted gzip trailer lies about the uncompressed size.
    for (let at = 0; at < bytes.length; at += 1024)
      inflater.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length);
    if (length !== size) throw new Error("The compressed color glyph has an invalid length.");
    const expanded = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { expanded.set(chunk, offset); offset += chunk.length; }
    bytes = expanded;
  }
  if (bytes.length > MAX_SVG_BYTES) throw new Error("The color glyph exceeds its SVG size limit.");
  return decoder.decode(bytes);
}

/** Font-owned, lazy color data. Nothing from this cache enters saved documents. */
export function createColorGlyphReader(bytes) {
  const tables = readColorFontTables(bytes), fonts = new WeakMap(), documents = new Map();
  let documentBytes = 0;
  const sizeDependent = tables.formats.some((format) => format === "CBDT" || format === "sbix");
  function sanitizer(data) {
    const key = data.documentId;
    if (documents.has(key)) {
      const entry = documents.get(key);
      documents.delete(key); documents.set(key, entry);
      return entry.sanitize;
    }
    const source = svgText(data.document, data.gzip);
    const entry = { sanitize: createColorGlyphSvgSanitizer(source), bytes: source.length * 2 };
    while (documents.size && (documents.size >= 4 || documentBytes + entry.bytes > MAX_PARSED_SOURCE_BYTES)) {
      const first = documents.keys().next().value;
      documentBytes -= documents.get(first).bytes;
      documents.delete(first);
    }
    if (entry.bytes <= MAX_PARSED_SOURCE_BYTES) { documents.set(key, entry); documentBytes += entry.bytes; }
    return entry.sanitize;
  }
  return {
    formats: tables.formats,
    glyph(glyphId, font, ppem = 128) {
      if (!tables.formats.length) return null;
      let cache = fonts.get(font);
      if (!cache) { cache = { entries: new Map(), bytes: 0 }; fonts.set(font, cache); }
      const pixelSize = Math.ceil(Math.max(1, Math.min(8192, ppem)));
      const key = sizeDependent ? `${glyphId}:${pixelSize}` : String(glyphId);
      if (cache.entries.has(key)) {
        const entry = cache.entries.get(key);
        cache.entries.delete(key); cache.entries.set(key, entry);
        return entry.result;
      }
      const options = { unitsPerEm: font.unitsPerEm, ppem: pixelSize };
      let result = null, lastError;
      for (const format of ["SVG", "CBDT", "sbix", "COLR-v0"]) {
        if (!tables.formats.includes(format)) continue;
        try {
          const data = tables.glyph(glyphId, { ...options, format });
          if (!data) continue;
          if (data.kind === "svg") {
            const { svg, ...bounds } = sanitizer(data)(glyphId, {
              unitsPerEm: font.unitsPerEm, ascent: font.ascent, descent: font.descent,
              advanceWidth: font.getGlyph(glyphId).advanceWidth,
            });
            result = { kind: "image", mime: "image/svg+xml", ...bounds,
              href: bytesDataUrl(encoder.encode(svg), "image/svg+xml") };
          } else if (data.kind === "bitmap") {
            const { png, ...geometry } = data;
            result = { ...geometry, kind: "image", mime: "image/png", href: bytesDataUrl(png, "image/png") };
          } else if (data.kind === "layers") {
            result = { kind: "layers", layers: data.layers.map(({ glyphId: id, color }) => ({
              path: font.getGlyph(id).path.toSVG(), fill: `#${color.map((part) => part.toString(16).padStart(2, "0")).join("")}`,
            })) };
          }
          if (result) break;
        } catch (error) { lastError = error; }
      }
      if (!result && tables.unsupportedGlyph?.(glyphId))
        result = { kind: "unsupported", message: "This glyph uses unsupported COLR version 1 paints." };
      if (!result && lastError) result = { kind: "unsupported", message: lastError.message };
      const resultBytes = 256 + (result?.href?.length ?? 0) * 2 +
        (result?.layers?.reduce((sum, layer) => sum + layer.path.length * 2 + 64, 0) ?? 0);
      while (cache.entries.size && (cache.entries.size >= 1024 || cache.bytes + resultBytes > MAX_GLYPH_CACHE_BYTES)) {
        const first = cache.entries.keys().next().value;
        cache.bytes -= cache.entries.get(first).bytes; cache.entries.delete(first);
      }
      if (resultBytes <= MAX_GLYPH_CACHE_BYTES) { cache.entries.set(key, { result, bytes: resultBytes }); cache.bytes += resultBytes; }
      return result;
    },
  };
}

export function colorGlyph(face, glyph, size) {
  const color = face.colorReader?.glyph(glyph.id, face.font, size);
  if (color) return color;
  // Fontkit exposes COLR v0 layers for compressed WOFF/WOFF2 faces too.
  if (Array.isArray(glyph.layers) && glyph.layers.length) return { kind: "layers", layers: glyph.layers.map(({ glyph: part, color: paint }) => ({
    path: part.path.toSVG(), fill: `#${[paint.red, paint.green, paint.blue, paint.alpha]
      .map((value) => value.toString(16).padStart(2, "0")).join("")}`,
  })) };
  return null;
}
