import test from 'node:test';
import assert from 'node:assert/strict';
import { readColorFontTables } from './colorFontTables.js';

function u16(value) { return [(value >>> 8) & 0xff, value & 0xff]; }
function i16(value) { return u16(value & 0xffff); }
function u32(value) { return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]; }
function tag(value) { return [...value].map((char) => char.charCodeAt(0)); }
function bytes(...parts) {
  return Uint8Array.from(parts.flatMap((part) => (
    part instanceof Uint8Array ? Array.from(part) : Array.isArray(part) ? part : [part]
  )));
}
function writeU16(array, offset, value) { array.set(u16(value), offset); }
function writeU32(array, offset, value) { array.set(u32(value), offset); }

function makeSfnt(tables, signature = 0x00010000) {
  const entries = Object.entries(tables);
  const directoryEnd = 12 + entries.length * 16;
  let total = directoryEnd;
  const layout = entries.map(([name, value]) => {
    const data = value instanceof Uint8Array ? value : Uint8Array.from(value);
    const offset = total;
    total += (data.length + 3) & ~3;
    return { name, data, offset };
  });
  const out = new Uint8Array(total);
  writeU32(out, 0, signature);
  writeU16(out, 4, entries.length);
  layout.forEach(({ name, data, offset }, index) => {
    const at = 12 + index * 16;
    out.set(tag(name), at);
    writeU32(out, at + 8, offset);
    writeU32(out, at + 12, data.length);
    out.set(data, offset);
  });
  return out;
}

function png(width = 3, height = 4) {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeU32(out, 8, 13);
  out.set(tag('IHDR'), 12);
  writeU32(out, 16, width);
  writeU32(out, 20, height);
  return out;
}

function svgTable(document, { start = 5, end = 5, docOffsetAdjustment = 0 } = {}) {
  const indexOffset = 10;
  const storedDocOffset = 14;
  const docOffset = storedDocOffset + docOffsetAdjustment;
  const out = new Uint8Array(indexOffset + storedDocOffset + document.length);
  writeU16(out, 0, 0);
  writeU32(out, 2, indexOffset);
  writeU32(out, 6, 0);
  writeU16(out, indexOffset, 1);
  writeU16(out, 12, start);
  writeU16(out, 14, end);
  writeU32(out, 16, docOffset);
  writeU32(out, 20, document.length);
  out.set(document, indexOffset + storedDocOffset);
  return out;
}

function svgTableRecords(records) {
  const indexOffset = 10;
  const recordsStart = indexOffset + 2;
  const documentsStart = recordsStart + records.length * 12;
  const documentsLength = records.reduce((total, record) => total + record.document.length, 0);
  const out = new Uint8Array(documentsStart + documentsLength);
  writeU16(out, 0, 0);
  writeU32(out, 2, indexOffset);
  writeU32(out, 6, 0);
  writeU16(out, indexOffset, records.length);
  let documentAt = documentsStart;
  records.forEach(({ start, end = start, document }, index) => {
    const recordAt = recordsStart + index * 12;
    writeU16(out, recordAt, start);
    writeU16(out, recordAt + 2, end);
    writeU32(out, recordAt + 4, documentAt - indexOffset);
    writeU32(out, recordAt + 8, document.length);
    out.set(document, documentAt);
    documentAt += document.length;
  });
  return out;
}

function svgTableWithOverlappingDocuments(documentLength) {
  const indexOffset = 10;
  const recordsStart = indexOffset + 2;
  const documentsStart = recordsStart + 2 * 12;
  const documentBytes = new Uint8Array(documentLength + 1);
  documentBytes[0] = 0x31;
  documentBytes[documentLength] = 0x32;
  const out = new Uint8Array(documentsStart + documentBytes.length);
  writeU16(out, 0, 0);
  writeU32(out, 2, indexOffset);
  writeU32(out, 6, 0);
  writeU16(out, indexOffset, 2);
  writeU16(out, recordsStart, 1);
  writeU16(out, recordsStart + 2, 1);
  writeU32(out, recordsStart + 4, documentsStart - indexOffset);
  writeU32(out, recordsStart + 8, documentLength);
  writeU16(out, recordsStart + 12, 2);
  writeU16(out, recordsStart + 14, 2);
  writeU32(out, recordsStart + 16, documentsStart + 1 - indexOffset);
  writeU32(out, recordsStart + 20, documentLength);
  out.set(documentBytes, documentsStart);
  return out;
}

function bitmapRecord(imageFormat, image) {
  if (imageFormat === 17) return bytes([4, 3, 0xff, 3, 8], u32(image.length), image);
  if (imageFormat === 18) return bytes([4, 3, 0xff, 3, 8, 0, 0, 0], u32(image.length), image);
  return bytes(u32(image.length), image);
}

function cblcTable(indexFormat, imageFormat, recordLength) {
  const arrayOffset = 56;
  const subtableOffset = arrayOffset + 8;
  let subtable;
  if (indexFormat === 1) {
    subtable = bytes(u16(1), u16(imageFormat), u32(4), u32(0), u32(recordLength));
  } else if (indexFormat === 2) {
    subtable = bytes(u16(2), u16(imageFormat), u32(4), u32(recordLength), [4, 3, 0xff, 3, 8, 0, 0, 0]);
  } else if (indexFormat === 3) {
    subtable = bytes(u16(3), u16(imageFormat), u32(4), u16(0), u16(recordLength));
  } else if (indexFormat === 4) {
    subtable = bytes(u16(4), u16(imageFormat), u32(4), u32(1), u16(5), u16(0), u16(6), u16(recordLength));
  } else if (indexFormat === 5) {
    subtable = bytes(u16(5), u16(imageFormat), u32(4), u32(recordLength), [4, 3, 0xff, 3, 8, 0, 0, 0], u32(1), u16(5));
  } else {
    throw new Error('unsupported test index format');
  }
  const padded = new Uint8Array((subtable.length + 3) & ~3);
  padded.set(subtable);
  const out = new Uint8Array(subtableOffset + padded.length);
  writeU16(out, 0, 3);
  writeU16(out, 2, 0);
  writeU32(out, 4, 1);
  writeU32(out, 8, arrayOffset);
  writeU32(out, 12, 8 + padded.length);
  writeU32(out, 16, 1);
  writeU16(out, 48, 5);
  writeU16(out, 50, 5);
  out[52] = 20;
  out[53] = 10;
  writeU16(out, arrayOffset, 5);
  writeU16(out, arrayOffset + 2, 5);
  writeU32(out, arrayOffset + 4, 8);
  out.set(padded, subtableOffset);
  return out;
}

function bitmapFont(indexFormat, imageFormat, image = png()) {
  const record = bitmapRecord(imageFormat, image);
  const cblc = cblcTable(indexFormat, imageFormat, record.length);
  return makeSfnt({
    maxp: bytes(u32(0x00010000), u16(10)),
    CBLC: cblc,
    CBDT: bytes(u16(3), u16(0), record),
  });
}

function cpalTable() {
  return bytes(
    u16(0), u16(1), u16(1), u16(1), u32(14), u16(0),
    [30, 20, 10, 255],
  );
}

function colrTable(paletteIndex = 0) {
  const out = bytes(
    u16(0), u16(1), u32(14), u32(20), u16(1),
    u16(5), u16(0), u16(1),
    u16(6), u16(paletteIndex),
  );
  return out;
}

function colrV1Table({ glyphIds = [], v0Fallback = false, paletteIndex = 0, paintOffsetAdjustment = 0 } = {}) {
  const baseGlyphListOffset = v0Fallback ? 44 : 34;
  const listBodyLength = 4 + glyphIds.length * 6;
  const out = new Uint8Array(baseGlyphListOffset + listBodyLength + glyphIds.length);
  writeU16(out, 0, 1);
  writeU16(out, 2, v0Fallback ? 1 : 0);
  writeU32(out, 4, v0Fallback ? 34 : 0);
  writeU32(out, 8, v0Fallback ? 40 : 0);
  writeU16(out, 12, v0Fallback ? 1 : 0);
  writeU32(out, 14, baseGlyphListOffset);
  writeU32(out, 18, 0);
  writeU32(out, 22, 0);
  writeU32(out, 26, 0);
  writeU32(out, 30, 0);
  if (v0Fallback) {
    writeU16(out, 34, 5);
    writeU16(out, 36, 0);
    writeU16(out, 38, 1);
    writeU16(out, 40, 6);
    writeU16(out, 42, paletteIndex);
  }
  writeU32(out, baseGlyphListOffset, glyphIds.length);
  glyphIds.forEach((glyphId, index) => {
    const recordAt = baseGlyphListOffset + 4 + index * 6;
    writeU16(out, recordAt, glyphId);
    writeU32(out, recordAt + 2, listBodyLength + index + paintOffsetAdjustment);
  });
  return out;
}

function sbixFont({ cycle = false } = {}) {
  const image = png();
  const pngRecord = bytes(i16(2), i16(-3), tag('png '), image);
  const dupeA = bytes(i16(4), i16(-1), tag('dupe'), u16(cycle ? 2 : 0));
  const dupeB = bytes(i16(10), i16(20), tag('dupe'), u16(1));
  const glyph0 = cycle ? dupeA : pngRecord;
  const glyph1 = cycle ? dupeB : dupeA;
  const glyph2 = cycle ? bytes() : dupeB;
  const first = 4 + 4 * 4;
  const second = first + glyph0.length;
  const third = second + glyph1.length;
  const end = third + glyph2.length;
  const strike = bytes(
    u16(10), u16(72),
    u32(first), u32(second), u32(third), u32(end),
    glyph0, glyph1, glyph2,
  );
  const table = bytes(u16(1), u16(0), u32(1), u32(12), strike);
  return makeSfnt({ maxp: bytes(u32(0x00010000), u16(3)), sbix: table });
}

test('SVG glyph ranges return a stable cached document descriptor and detect gzip', () => {
  const raw = Uint8Array.from([60, 115, 118, 103, 47, 62]);
  const reader = readColorFontTables(makeSfnt({ 'SVG ': svgTable(raw) }));
  assert.deepEqual(reader.formats, ['SVG']);
  const entry = reader.glyph(5, { unitsPerEm: 1000 });
  assert.equal(entry.kind, 'svg');
  assert.deepEqual(entry.document, raw);
  assert.equal(entry.gzip, false);
  assert.equal(entry.documentId, '24:6');
  const repeated = reader.glyph(5, { unitsPerEm: 1000 });
  assert.equal(repeated.documentId, entry.documentId);
  assert.strictEqual(repeated.document, entry.document);
  assert.deepEqual(repeated.document, raw);
  assert.equal(reader.glyph(4, { unitsPerEm: 1000 }), null);

  const gzip = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]);
  assert.equal(readColorFontTables(makeSfnt({ 'SVG ': svgTable(gzip) })).glyph(5, { unitsPerEm: 1000 }).gzip, true);
});

test('SVG document cache evicts by entry count and byte budget', () => {
  const manyDocuments = svgTableRecords(Array.from({ length: 65 }, (_, glyphId) => ({
    start: glyphId,
    document: Uint8Array.of(glyphId + 1),
  })));
  const countLimited = readColorFontTables(makeSfnt({ 'SVG ': manyDocuments }));
  const oldest = countLimited.glyph(0, { unitsPerEm: 1000 });
  for (let glyphId = 1; glyphId < 65; glyphId += 1) countLimited.glyph(glyphId, { unitsPerEm: 1000 });
  const restoredOldest = countLimited.glyph(0, { unitsPerEm: 1000 });
  assert.notStrictEqual(restoredOldest.document, oldest.document);
  assert.strictEqual(countLimited.glyph(0, { unitsPerEm: 1000 }).document, restoredOldest.document);

  const documentLength = 8 * 1024 * 1024 + 2;
  const byteLimited = readColorFontTables(makeSfnt({ 'SVG ': svgTableWithOverlappingDocuments(documentLength) }));
  const firstLarge = byteLimited.glyph(1, { unitsPerEm: 1000 });
  byteLimited.glyph(2, { unitsPerEm: 1000 });
  assert.notStrictEqual(byteLimited.glyph(1, { unitsPerEm: 1000 }).document, firstLarge.document);
});

test('SVG document offsets are relative to the document index and malformed ranges reject', () => {
  assert.throws(() => readColorFontTables(makeSfnt({ 'SVG ': svgTable(bytes([1]), { start: 9, end: 8 }) })), /ranges/);
  assert.throws(() => readColorFontTables(makeSfnt({ 'SVG ': svgTable(bytes([1]), { docOffsetAdjustment: 100 }) })), /outside its table/);
});

test('unsupported wrappers and fonts without color tables return no formats', () => {
  const plain = readColorFontTables(makeSfnt({ maxp: bytes(u32(0x00010000), u16(2)) }));
  assert.deepEqual(plain.formats, []);
  assert.equal(plain.glyph(0, { unitsPerEm: 1000 }), null);
  const woff = makeSfnt({}, 0x774f4632);
  assert.deepEqual(readColorFontTables(woff).formats, []);
});

test('CBDT reads index formats 1 through 5 with separate x/y strike scales and matching PNG metrics', () => {
  const combinations = [[1, 17], [2, 19], [3, 18], [4, 17], [5, 19]];
  for (const [indexFormat, imageFormat] of combinations) {
    const reader = readColorFontTables(bitmapFont(indexFormat, imageFormat));
    assert.deepEqual(reader.formats, ['CBDT'], `index format ${indexFormat}, image format ${imageFormat}`);
    const entry = reader.glyph(5, { unitsPerEm: 1000, ppem: 10 });
    assert.equal(entry.kind, 'bitmap');
    assert.equal(entry.pixelWidth, 3);
    assert.equal(entry.pixelHeight, 4);
    assert.equal(entry.x, -50);
    assert.equal(entry.y, -300);
    assert.equal(entry.width, 150);
    assert.equal(entry.height, 400);
    assert.deepEqual(entry.png, png());
  }
  assert.equal(readColorFontTables(bitmapFont(1, 17)).glyph(5, { unitsPerEm: 1000, format: 'COLR-v1' }), null);
  assert.throws(() => readColorFontTables(bitmapFont(1, 17, png(8193, 1))).glyph(5, { unitsPerEm: 1000 }), /dimensions/);
  assert.throws(() => readColorFontTables(bitmapFont(1, 17, png(2, 4))).glyph(5, { unitsPerEm: 1000 }), /do not match/);
});

test('CBDT rejects a broken index array rather than reading outside CBLC', () => {
  const font = bitmapFont(1, 17);
  const copy = font.slice();
  // The test SFNT has maxp, CBLC and CBDT; locate CBLC through its directory entry.
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    const name = String.fromCharCode(...copy.subarray(at, at + 4));
    if (name === 'CBLC') {
      const tableAt = view.getUint32(at + 8);
      // The offset array's final entry is moved past this bounded table.
      writeU32(copy, tableAt + 56 + 8 + 12, 0xffff_ffff);
      break;
    }
  }
  assert.throws(() => readColorFontTables(copy), /outside|monotonic/);
});

test('sbix reads PNG glyphs and follows dupe data while retaining current glyph offsets', () => {
  const reader = readColorFontTables(sbixFont());
  assert.deepEqual(reader.formats, ['sbix']);
  const entry = reader.glyph(1, { unitsPerEm: 1000, ppem: 10 });
  assert.equal(entry.kind, 'bitmap');
  assert.equal(entry.x, 400);
  assert.equal(entry.y, -300);
  assert.equal(entry.width, 300);
  assert.equal(entry.height, 400);
  assert.deepEqual(entry.png, png());
  assert.equal(readColorFontTables(sbixFont({ cycle: true })).glyph(1, { unitsPerEm: 1000 }), null);
});

test('COLR v0 uses first-palette RGBA and COLR v1-only glyphs are identified without parsing paint graphs', () => {
  const v0 = readColorFontTables(makeSfnt({ maxp: bytes(u32(0x00010000), u16(10)), COLR: colrTable(), CPAL: cpalTable() }));
  assert.deepEqual(v0.formats, ['COLR-v0']);
  assert.deepEqual(v0.glyph(5, { unitsPerEm: 1000 }), { kind: 'layers', layers: [{ glyphId: 6, color: [10, 20, 30, 255] }] });

  const v1Only = readColorFontTables(makeSfnt({
    maxp: bytes(u32(0x00010000), u16(10)),
    COLR: colrV1Table({ glyphIds: [5, 7] }),
  }));
  assert.deepEqual(v1Only.formats, ['COLR-v1']);
  assert.equal(v1Only.glyph(5, { unitsPerEm: 1000 }), null);
  assert.equal(v1Only.unsupportedGlyph(5), true);
  assert.equal(v1Only.unsupportedGlyph(6), false);
  assert.equal(v1Only.unsupportedGlyph(7), true);

  const v1Fallback = readColorFontTables(makeSfnt({
    maxp: bytes(u32(0x00010000), u16(10)),
    COLR: colrV1Table({ glyphIds: [5, 7], v0Fallback: true }),
    CPAL: cpalTable(),
  }));
  assert.deepEqual(v1Fallback.formats, ['COLR-v0', 'COLR-v1']);
  assert.equal(v1Fallback.glyph(5, { unitsPerEm: 1000 }).kind, 'layers');
  assert.equal(v1Fallback.unsupportedGlyph(5), false);
  assert.equal(v1Fallback.unsupportedGlyph(7), true);

  assert.throws(() => readColorFontTables(makeSfnt({ COLR: colrV1Table({ glyphIds: [7, 5] }) })), /base glyph IDs/);
  assert.throws(() => readColorFontTables(makeSfnt({ COLR: colrV1Table({ glyphIds: [5], paintOffsetAdjustment: 100 }) })), /outside its table/);

  const foreground = readColorFontTables(makeSfnt({ maxp: bytes(u32(0x00010000), u16(10)), COLR: colrTable(0xffff), CPAL: cpalTable() }));
  assert.deepEqual(foreground.glyph(5, { unitsPerEm: 1000 }).layers[0].color, [0, 0, 0, 255]);
});

test('requested inputs and table bounds are checked', () => {
  const reader = readColorFontTables(makeSfnt({ 'SVG ': svgTable(bytes([1])) }));
  assert.throws(() => reader.glyph(-1, { unitsPerEm: 1000 }), /glyphId/);
  assert.throws(() => reader.glyph(1, { unitsPerEm: 0 }), /unitsPerEm/);
  assert.throws(() => reader.glyph(1, { unitsPerEm: 1000, ppem: Infinity }), /ppem/);
});
