import { createCanvas } from "@napi-rs/canvas";
import { create } from "fontkit";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTER_FONT = path.join(root, "assets", "fonts", "Inter-400.ttf");
const FONT_SOURCE = "/api/fonts/fs-noto-color-emoji--1.0.0--400-normal.ttf";
const CHECKSUM_MAGIC = 0xb1b0afba;
const FONT_LICENSE = "SIL Open Font License 1.1";

const utf8 = (text) => new TextEncoder().encode(text);

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(bytes, offset, value) { view(bytes).setUint16(offset, value, false); }
function u32(bytes, offset, value) { view(bytes).setUint32(offset, value >>> 0, false); }

function tagBytes(tag) {
  if (tag.length !== 4) throw new Error(`SFNT table tag must contain four characters: ${tag}`);
  return utf8(tag);
}

function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const word = ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

function tablesFromSfnt(bytes) {
  const data = view(bytes);
  const count = data.getUint16(4, false);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = data.getUint32(at + 8, false);
    const length = data.getUint32(at + 12, false);
    tables.set(tag, Uint8Array.from(bytes.subarray(offset, offset + length)));
  }
  return tables;
}

function makeCmap(mappings) {
  const ordered = [...mappings].sort(([left], [right]) => left - right);
  const groups = [];
  for (const [codePoint, glyphId] of ordered) {
    const previous = groups.at(-1);
    if (previous && previous.end + 1 === codePoint && previous.glyph + (codePoint - previous.start) === glyphId) {
      previous.end = codePoint;
    } else {
      groups.push({ start: codePoint, end: codePoint, glyph: glyphId });
    }
  }
  const subtableLength = 16 + groups.length * 12;
  const cmap = new Uint8Array(12 + subtableLength);
  u16(cmap, 0, 0); // cmap version
  u16(cmap, 2, 1); // one Unicode full-repertoire record
  u16(cmap, 4, 3); // Windows
  u16(cmap, 6, 10); // Unicode UCS-4
  u32(cmap, 8, 12); // subtable offset
  u16(cmap, 12, 12); // format 12
  u16(cmap, 14, 0);
  u32(cmap, 16, subtableLength);
  u32(cmap, 20, 0); // language
  u32(cmap, 24, groups.length);
  groups.forEach((group, index) => {
    const at = 28 + index * 12;
    u32(cmap, at, group.start);
    u32(cmap, at + 4, group.end);
    u32(cmap, at + 8, group.glyph);
  });
  return cmap;
}

function svgDocument(glyphIds) {
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1">` +
    `<g id="glyph${glyphIds.asciiA}"><circle cx="700" cy="-950" r="500" fill="#e53935"/><circle cx="530" cy="-1080" r="52" fill="#ffffff"/><circle cx="870" cy="-1080" r="52" fill="#ffffff"/></g>` +
    `<g id="glyph${glyphIds.asciiB}"><rect x="120" y="-1450" width="1100" height="1000" rx="120" fill="#1e66d0"/><path d="M280 -1200h780" fill="none" stroke="#ffffff" stroke-width="110"/></g>` +
    `<g id="glyph${glyphIds.asciiC}"><polygon points="700,-1500 1250,-480 150,-480" fill="#25a65a"/><circle cx="700" cy="-820" r="92" fill="#ffffff"/></g>` +
    `</svg>`;
}

function makeSvgTable(glyphIds, document, gzip) {
  const original = utf8(document);
  const bytes = gzip ? new Uint8Array(gzipSync(original)) : original;
  const records = [...new Set([glyphIds.asciiA, glyphIds.asciiB, glyphIds.asciiC])].sort((a, b) => a - b);
  const indexOffset = 10;
  const recordsOffset = indexOffset + 2;
  const documentOffset = 2 + records.length * 12;
  const table = new Uint8Array(indexOffset + documentOffset + bytes.length);
  u16(table, 0, 0); // SVG table version
  u32(table, 2, indexOffset);
  u32(table, 6, 0); // reserved
  u16(table, indexOffset, records.length);
  records.forEach((glyphId, index) => {
    const at = recordsOffset + index * 12;
    u16(table, at, glyphId);
    u16(table, at + 2, glyphId);
    u32(table, at + 4, documentOffset);
    u32(table, at + 8, bytes.length);
  });
  table.set(bytes, indexOffset + documentOffset);
  return table;
}

function bitmapPng(color, kind) {
  const canvas = createCanvas(16, 16);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 16, 16);
  context.fillStyle = color;
  if (kind === "circle") {
    context.beginPath();
    context.arc(8, 8, 7, 0, Math.PI * 2);
    context.fill();
  } else if (kind === "rect") {
    context.fillRect(1, 3, 14, 10);
  } else {
    context.beginPath();
    context.moveTo(8, 1);
    context.lineTo(15, 15);
    context.lineTo(1, 15);
    context.closePath();
    context.fill();
  }
  return new Uint8Array(canvas.toBuffer("image/png"));
}

function makeBitmapTables(glyphIds) {
  const imageByGlyph = new Map([
    [glyphIds.asciiA, bitmapPng("#e53935", "circle")],
    [glyphIds.asciiB, bitmapPng("#1e66d0", "rect")],
    [glyphIds.asciiC, bitmapPng("#25a65a", "triangle")],
  ]);
  const glyphs = [...imageByGlyph.keys()].sort((a, b) => a - b);
  const firstGlyph = glyphs[0];
  const lastGlyph = glyphs.at(-1);
  const span = lastGlyph - firstGlyph + 1;
  const recordByGlyph = new Map(glyphs.map((glyphId) => {
    const png = imageByGlyph.get(glyphId);
    const record = new Uint8Array(9 + png.length);
    record.set([16, 16, 0, 16, 16], 0);
    u32(record, 5, png.length);
    record.set(png, 9);
    return [glyphId, record];
  }));
  const orderedRecords = [];
  const offsets = [0];
  let cursor = 0;
  for (let glyphId = firstGlyph; glyphId <= lastGlyph; glyphId += 1) {
    const record = recordByGlyph.get(glyphId);
    if (record) {
      orderedRecords.push(record);
      cursor += record.length;
    }
    offsets.push(cursor);
  }
  const cbdtDataLength = orderedRecords.reduce((sum, record) => sum + record.length, 0);
  const cbdt = new Uint8Array(4 + cbdtDataLength);
  u16(cbdt, 0, 3);
  u16(cbdt, 2, 0);
  cursor = 0;
  for (const record of orderedRecords) {
    cbdt.set(record, 4 + cursor);
    cursor += record.length;
  }

  const arrayOffset = 56;
  const indexSubtableSize = 8 + (span + 1) * 4;
  const indexArraySize = 8 + indexSubtableSize;
  const cblc = new Uint8Array(arrayOffset + indexArraySize);
  u16(cblc, 0, 3);
  u16(cblc, 2, 0);
  u32(cblc, 4, 1); // one bitmap strike
  u32(cblc, 8, arrayOffset);
  u32(cblc, 12, indexArraySize);
  u32(cblc, 16, 1); // one index subtable
  u32(cblc, 20, 0); // colorRef
  u16(cblc, 48, firstGlyph);
  u16(cblc, 50, lastGlyph);
  cblc[52] = 16; // ppemX
  cblc[53] = 16; // ppemY
  cblc[54] = 32; // bitDepth
  cblc[55] = 0; // flags

  const recordAt = arrayOffset;
  u16(cblc, recordAt, firstGlyph);
  u16(cblc, recordAt + 2, lastGlyph);
  u32(cblc, recordAt + 4, 8); // subtable offset relative to arrayOffset
  const subAt = arrayOffset + 8;
  u16(cblc, subAt, 1); // index format 1
  u16(cblc, subAt + 2, 17); // CBDT small metrics plus PNG
  u32(cblc, subAt + 4, 4); // image data begins after the CBDT header
  offsets.forEach((offset, index) => u32(cblc, subAt + 8 + index * 4, offset));
  return { CBLC: cblc, CBDT: cbdt };
}

function rebuildSfnt(sourceBytes, updatedTables) {
  const tables = tablesFromSfnt(sourceBytes);
  for (const [tag, bytes] of Object.entries(updatedTables)) tables.set(tag, bytes);
  const head = Uint8Array.from(tables.get("head"));
  u32(head, 8, 0); // head.checkSumAdjustment is zero for its directory checksum
  tables.set("head", head);

  const entries = [...tables].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const count = entries.length;
  let powerOfTwo = 1;
  let entrySelector = 0;
  while (powerOfTwo * 2 <= count) { powerOfTwo *= 2; entrySelector += 1; }
  const headerLength = 12 + count * 16;
  let nextOffset = (headerLength + 3) & ~3;
  const directories = entries.map(([tag, table]) => {
    const entry = { tag, table, offset: nextOffset, checksum: checksum(table) };
    nextOffset = (nextOffset + table.length + 3) & ~3;
    return entry;
  });
  const output = new Uint8Array(nextOffset);
  output.set(sourceBytes.subarray(0, 4), 0);
  u16(output, 4, count);
  u16(output, 6, powerOfTwo * 16);
  u16(output, 8, entrySelector);
  u16(output, 10, count * 16 - powerOfTwo * 16);
  let headOffset = -1;
  directories.forEach((entry, index) => {
    const at = 12 + index * 16;
    output.set(tagBytes(entry.tag), at);
    u32(output, at + 4, entry.checksum);
    u32(output, at + 8, entry.offset);
    u32(output, at + 12, entry.table.length);
    output.set(entry.table, entry.offset);
    if (entry.tag === "head") headOffset = entry.offset;
  });
  if (headOffset < 0) throw new Error("Source font has no head table");
  const adjustment = (CHECKSUM_MAGIC - checksum(output)) >>> 0;
  u32(output, headOffset + 8, adjustment);
  if (checksum(output) !== CHECKSUM_MAGIC) throw new Error("Synthetic font checksum adjustment failed");
  return output;
}

/**
 * The bundled Inter face (SIL OFL 1.1, assets/fonts/OFL.txt) with a new character map: printable
 * ASCII plus `borrowed` ({"∞": "8"} draws ∞ with Inter's 8). Tests use it as a catalog font that
 * has, or lacks, a character such as ∞.
 */
export async function createCmapFontFixture(borrowed = {}) {
  const sourceBytes = new Uint8Array(await readFile(INTER_FONT));
  const sourceFont = create(sourceBytes);
  const mappings = new Map();
  for (let codePoint = 0x20; codePoint <= 0x7e; codePoint += 1) mappings.set(codePoint, sourceFont.glyphForCodePoint(codePoint).id);
  for (const [character, glyphOf] of Object.entries(borrowed))
    mappings.set(character.codePointAt(0), sourceFont.glyphForCodePoint(glyphOf.codePointAt(0)).id);
  return rebuildSfnt(sourceBytes, { cmap: makeCmap(mappings) });
}

/**
 * Build a complete synthetic color font in memory from the bundled Inter face.
 * Inter is licensed under SIL OFL 1.1 (assets/fonts/OFL.txt); fixture glyph art is original.
 */
export async function createColorFontFixture({ format = "svg", svgOverride, gzip = false } = {}) {
  if (!new Set(["svg", "bitmap"]).has(format)) throw new TypeError('format must be "svg" or "bitmap"');
  if (svgOverride !== undefined && typeof svgOverride !== "string") throw new TypeError("svgOverride must be text");
  if (typeof gzip !== "boolean") throw new TypeError("gzip must be true or false");
  if (format === "bitmap" && (svgOverride !== undefined || gzip))
    throw new TypeError("svgOverride and gzip are available only for the SVG fixture");

  const sourceBytes = new Uint8Array(await readFile(INTER_FONT));
  const sourceFont = create(sourceBytes);
  const asciiA = sourceFont.glyphForCodePoint(0x41);
  const asciiB = sourceFont.glyphForCodePoint(0x42);
  const asciiC = sourceFont.glyphForCodePoint(0x43);
  if ([asciiA, asciiB, asciiC].some((glyph) => !glyph || glyph.id === 0))
    throw new Error("Licensed Inter fixture must include visible A, B, and C glyphs");
  const glyphIds = {
    asciiA: asciiA.id,
    asciiB: asciiB.id,
    asciiC: asciiC.id,
    smilingFace: asciiA.id,
    thumbsUp: asciiB.id,
    skinTone: asciiC.id,
    regionalIndicatorU: asciiA.id,
    regionalIndicatorS: asciiB.id,
    woman: asciiA.id,
    boy: asciiC.id,
  };
  const mappings = new Map([
    [0x0041, glyphIds.asciiA], [0x0042, glyphIds.asciiB], [0x0043, glyphIds.asciiC],
    [0x1f600, glyphIds.smilingFace], [0x1f44d, glyphIds.thumbsUp], [0x1f3fd, glyphIds.skinTone],
    [0x1f1fa, glyphIds.regionalIndicatorU], [0x1f1f8, glyphIds.regionalIndicatorS],
    [0x1f469, glyphIds.woman], [0x1f466, glyphIds.boy],
  ]);

  const colorTables = format === "svg"
    ? { "SVG ": makeSvgTable(glyphIds, svgOverride ?? svgDocument(glyphIds), gzip) }
    : makeBitmapTables(glyphIds);
  const bytes = rebuildSfnt(sourceBytes, { cmap: makeCmap(mappings), ...colorTables });
  // Reopen the produced bytes with the public fontkit API before returning them.
  const rebuiltFont = create(bytes);
  const checks = [0x41, 0x42, 0x43, 0x1f600, 0x1f44d, 0x1f3fd, 0x1f1fa, 0x1f1f8, 0x1f469, 0x1f466];
  if (checks.some((codePoint) => rebuiltFont.glyphForCodePoint(codePoint).id === 0))
    throw new Error("Synthetic Unicode cmap did not reopen with all fixture glyphs");
  const metadata = {
    family: "Noto Color Emoji",
    src: FONT_SOURCE,
    weight: 400,
    style: "normal",
    format: format === "svg" ? "SVG" : "CBDT",
    license: FONT_LICENSE,
    provenance: "Synthetic test-only font derived in memory from assets/fonts/Inter-400.ttf; color shapes are original geometry, not Noto artwork.",
  };
  return { bytes, glyphIds, metadata };
}
