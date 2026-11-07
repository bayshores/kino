const MAX_TABLE_BYTES = 16 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PNG_AXIS = 8192;
const MAX_GLYPH_ID = 0xffff;
const MAX_SVG_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_SVG_CACHE_ENTRIES = 64;
const SFNT_SIGNATURES = new Set([0x00010000, 0x4f54544f, 0x74727565, 0x74797031]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function fail(message) {
  throw new Error(`Invalid color font table: ${message}`);
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Font data must be an ArrayBuffer or byte view');
}

function checkedRange(offset, length, total, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > total || length > total - offset) {
    fail(`${label} is outside its table`);
  }
}

function reader(bytes, label) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset, length = 1) => checkedRange(offset, length, bytes.byteLength, label);
  return {
    bytes,
    length: bytes.byteLength,
    check,
    u8(offset) { check(offset); return view.getUint8(offset); },
    i8(offset) { check(offset); return view.getInt8(offset); },
    u16(offset) { check(offset, 2); return view.getUint16(offset, false); },
    i16(offset) { check(offset, 2); return view.getInt16(offset, false); },
    u32(offset) { check(offset, 4); return view.getUint32(offset, false); },
    slice(offset, length) { check(offset, length); return bytes.subarray(offset, offset + length); },
  };
}

function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}

function tableDirectory(fontBytes) {
  const r = reader(fontBytes, 'SFNT directory');
  if (r.length < 12) fail('truncated SFNT header');
  const signature = r.u32(0);
  // WOFF and WOFF2 wrap tables with compression; this reader intentionally has
  // no decompressor and does not inspect their private/internal representation.
  if (signature === 0x774f4646 || signature === 0x774f4632) return null;
  if (!SFNT_SIGNATURES.has(signature)) return null;

  const count = r.u16(4);
  if (count === 0 || count > 4096) fail('invalid SFNT table count');
  r.check(12, count * 16);
  const tables = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(r.u8(at), r.u8(at + 1), r.u8(at + 2), r.u8(at + 3));
    const offset = r.u32(at + 8);
    const length = r.u32(at + 12);
    checkedRange(offset, length, r.length, `${tag} table`);
    if (tables.has(tag)) fail(`duplicate ${tag} table`);
    if (['SVG ', 'CBDT', 'CBLC', 'sbix', 'COLR', 'CPAL', 'maxp'].includes(tag) && length > MAX_TABLE_BYTES) {
      fail(`${tag} table exceeds the 16 MB limit`);
    }
    tables.set(tag, fontBytes.subarray(offset, offset + length));
  }
  return tables;
}

function glyphCount(tables) {
  const maxp = tables.get('maxp');
  if (!maxp) return null;
  const r = reader(maxp, 'maxp');
  if (r.length < 6) fail('truncated maxp table');
  const count = r.u16(4);
  if (count === 0) fail('empty maxp glyph count');
  return count;
}

function parseSvgTable(bytes) {
  const r = reader(bytes, 'SVG table');
  if (r.length < 10) fail('truncated SVG header');
  if (r.u16(0) !== 0 || r.u32(6) !== 0) fail('unsupported SVG table header');
  const indexOffset = r.u32(2);
  if (indexOffset < 10) fail('invalid SVG document index offset');
  r.check(indexOffset, 2);
  const count = r.u16(indexOffset);
  const recordsStart = indexOffset + 2;
  r.check(recordsStart, count * 12);
  const records = [];
  let priorEnd = -1;
  for (let i = 0; i < count; i += 1) {
    const at = recordsStart + i * 12;
    const start = r.u16(at);
    const end = r.u16(at + 2);
    const docOffset = r.u32(at + 4);
    const docLength = r.u32(at + 8);
    if (start > end || start <= priorEnd) fail('SVG glyph ranges are not sorted and disjoint');
    if (docLength === 0 || docLength > MAX_TABLE_BYTES) fail('invalid SVG document length');
    const docAt = indexOffset + docOffset;
    r.check(docAt, docLength);
    records.push({ start, end, docAt, docLength });
    priorEnd = end;
  }
  return { bytes, records, documentCache: new Map(), documentCacheBytes: 0 };
}

function findSvgRecord(svg, glyphId) {
  let low = 0;
  let high = svg.records.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const record = svg.records[middle];
    if (glyphId < record.start) high = middle - 1;
    else if (glyphId > record.end) low = middle + 1;
    else return record;
  }
  return null;
}

function cachedSvgDocument(svg, record) {
  const documentId = `${record.docAt}:${record.docLength}`;
  const cached = svg.documentCache.get(documentId);
  if (cached) {
    svg.documentCache.delete(documentId);
    svg.documentCache.set(documentId, cached);
    return { documentId, document: cached.document };
  }

  const document = copyBytes(svg.bytes.subarray(record.docAt, record.docAt + record.docLength));
  if (document.byteLength <= MAX_SVG_CACHE_BYTES) {
    while (svg.documentCache.size >= MAX_SVG_CACHE_ENTRIES || svg.documentCacheBytes + document.byteLength > MAX_SVG_CACHE_BYTES) {
      const oldestId = svg.documentCache.keys().next().value;
      if (oldestId === undefined) break;
      const oldest = svg.documentCache.get(oldestId);
      svg.documentCache.delete(oldestId);
      svg.documentCacheBytes -= oldest.document.byteLength;
    }
    svg.documentCache.set(documentId, { document });
    svg.documentCacheBytes += document.byteLength;
  }
  return { documentId, document };
}

function parseCpal(bytes) {
  const r = reader(bytes, 'CPAL table');
  if (r.length < 12) fail('truncated CPAL header');
  const version = r.u16(0);
  const numEntries = r.u16(2);
  const numPalettes = r.u16(4);
  const numColors = r.u16(6);
  const colorOffset = r.u32(8);
  if (version > 1 || numEntries === 0 || numPalettes === 0 || numEntries > numColors) fail('invalid CPAL counts or version');
  r.check(12, numPalettes * 2);
  if (version === 1) {
    const extraAt = 12 + numPalettes * 2;
    r.check(extraAt, 12);
    const optionalOffsets = [r.u32(extraAt), r.u32(extraAt + 4), r.u32(extraAt + 8)];
    for (const offset of optionalOffsets) {
      if (offset !== 0) r.check(offset, 1);
    }
  }
  r.check(colorOffset, numColors * 4);
  const firstRecord = r.u16(12);
  if (firstRecord + numEntries > numColors) fail('first CPAL palette exceeds the color records');
  const palette = [];
  for (let i = 0; i < numEntries; i += 1) {
    const at = colorOffset + (firstRecord + i) * 4;
    const b = r.u8(at);
    const g = r.u8(at + 1);
    const red = r.u8(at + 2);
    const alpha = r.u8(at + 3);
    palette.push([red, g, b, alpha]);
  }
  return palette;
}

function parseColr(bytes, palette, numGlyphs) {
  const r = reader(bytes, 'COLR table');
  if (r.length < 14) fail('truncated COLR header');
  const version = r.u16(0);
  if (version > 1) fail(`unsupported COLR version ${version}`);
  const baseCount = r.u16(2);
  const baseOffset = r.u32(4);
  const layerOffset = r.u32(8);
  const layerCount = r.u16(12);
  if (baseCount > 0) r.check(baseOffset, baseCount * 6);
  if (layerCount > 0) r.check(layerOffset, layerCount * 4);

  if ((baseCount > 0 || layerCount > 0) && !palette) fail('COLR records require a CPAL palette');
  const layers = [];
  for (let i = 0; i < layerCount; i += 1) {
    const at = layerOffset + i * 4;
    const glyphId = r.u16(at);
    const paletteIndex = r.u16(at + 2);
    if (numGlyphs !== null && glyphId >= numGlyphs) fail('COLR layer glyph exceeds maxp');
    if (paletteIndex !== 0xffff && paletteIndex >= (palette?.length ?? 0)) fail('COLR palette index is out of range');
    layers.push({ glyphId, paletteIndex });
  }

  const bases = [];
  let previousGlyph = -1;
  for (let i = 0; i < baseCount; i += 1) {
    const at = baseOffset + i * 6;
    const glyphId = r.u16(at);
    const firstLayer = r.u16(at + 2);
    const count = r.u16(at + 4);
    if (glyphId <= previousGlyph || (numGlyphs !== null && glyphId >= numGlyphs)) fail('COLR base glyph records are invalid');
    if (firstLayer + count > layerCount) fail('COLR base glyph layer range is invalid');
    bases.push({ glyphId, firstLayer, count });
    previousGlyph = glyphId;
  }

  let hasV1 = false;
  let v1GlyphIds = new Set();
  if (version === 1) {
    if (r.length < 34) fail('truncated COLR version 1 header');
    hasV1 = true;
    for (const at of [14, 18, 22, 26, 30]) {
      const offset = r.u32(at);
      if (offset !== 0) {
        if (offset < 34) fail('COLR version 1 offset overlaps its header');
        r.check(offset, 1);
      }
    }
    const baseGlyphListOffset = r.u32(14);
    if (baseGlyphListOffset !== 0) {
      r.check(baseGlyphListOffset, 4);
      const count = r.u32(baseGlyphListOffset);
      const recordsAt = baseGlyphListOffset + 4;
      if (count > MAX_GLYPH_ID + 1) fail('COLR version 1 has too many base glyph paint records');
      r.check(recordsAt, count * 6);
      let priorGlyph = -1;
      v1GlyphIds = new Set();
      for (let i = 0; i < count; i += 1) {
        const at = recordsAt + i * 6;
        const glyphId = r.u16(at);
        const paintOffset = r.u32(at + 2);
        if (glyphId <= priorGlyph || (numGlyphs !== null && glyphId >= numGlyphs)) fail('COLR version 1 base glyph IDs are invalid');
        if (paintOffset < 4 + count * 6) fail('COLR version 1 paint offset overlaps the base glyph list');
        // Paint offsets are relative to the BaseGlyphList. Check only their
        // bounded target byte here; paint graphs remain explicitly unsupported.
        r.check(baseGlyphListOffset + paintOffset, 1);
        v1GlyphIds.add(glyphId);
        priorGlyph = glyphId;
      }
    }
  }
  const v0 = bases.length && layerCount && palette ? { bases, layers, palette } : null;
  return { v0, hasV1, v1GlyphIds };
}

function hasColrV0Glyph(colr, glyphId) {
  if (!colr?.v0) return false;
  let low = 0;
  let high = colr.v0.bases.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const base = colr.v0.bases[middle];
    if (glyphId < base.glyphId) high = middle - 1;
    else if (glyphId > base.glyphId) low = middle + 1;
    else return base.count > 0;
  }
  return false;
}

function parseBigMetrics(r, offset) {
  r.check(offset, 8);
  return {
    height: r.u8(offset),
    width: r.u8(offset + 1),
    bearingX: r.i8(offset + 2),
    bearingY: r.i8(offset + 3),
  };
}

function parseSmallMetrics(r, offset) {
  r.check(offset, 5);
  return {
    height: r.u8(offset),
    width: r.u8(offset + 1),
    bearingX: r.i8(offset + 2),
    bearingY: r.i8(offset + 3),
  };
}

function parseCbdt(cblcBytes, cbdtBytes, numGlyphs) {
  const l = reader(cblcBytes, 'CBLC table');
  const d = reader(cbdtBytes, 'CBDT table');
  if (l.length < 8 || d.length < 4) fail('truncated CBLC/CBDT header');
  if (l.u16(0) !== 3 || l.u16(2) !== 0 || d.u16(0) !== 3 || d.u16(2) !== 0) fail('unsupported CBLC/CBDT version');
  const strikeCount = l.u32(4);
  if (strikeCount === 0 || strikeCount > 2048) fail('invalid CBLC strike count');
  l.check(8, strikeCount * 48);
  const strikes = [];
  for (let si = 0; si < strikeCount; si += 1) {
    const at = 8 + si * 48;
    const arrayOffset = l.u32(at);
    const indexTablesSize = l.u32(at + 4);
    const subtableCount = l.u32(at + 8);
    const startGlyph = l.u16(at + 40);
    const endGlyph = l.u16(at + 42);
    const ppemX = l.u8(at + 44);
    const ppemY = l.u8(at + 45);
    if (startGlyph > endGlyph || ppemX === 0 || ppemY === 0) fail('invalid CBLC strike range or ppem');
    if (numGlyphs !== null && endGlyph >= numGlyphs) fail('CBLC strike exceeds maxp');
    if (subtableCount > 4096) fail('too many CBLC index subtables');
    l.check(arrayOffset, indexTablesSize);
    if (indexTablesSize < subtableCount * 8) fail('CBLC index array is too short');
    const indexEnd = arrayOffset + indexTablesSize;
    const subtables = [];
    let previousEnd = -1;
    const indexRecords = [];
    for (let ti = 0; ti < subtableCount; ti += 1) {
      const recordAt = arrayOffset + ti * 8;
      const first = l.u16(recordAt);
      const last = l.u16(recordAt + 2);
      const additional = l.u32(recordAt + 4);
      if (first > last || first < startGlyph || last > endGlyph || first <= previousEnd) fail('CBLC index subtable ranges overlap or exceed strike');
      const subAt = arrayOffset + additional;
      if (subAt < arrayOffset + subtableCount * 8 || subAt >= indexEnd) fail('CBLC index subtable offset is invalid');
      if (indexRecords.length && subAt <= indexRecords[indexRecords.length - 1].subAt) fail('CBLC index subtable offsets are not increasing');
      indexRecords.push({ first, last, subAt });
      previousEnd = last;
    }
    for (let ti = 0; ti < indexRecords.length; ti += 1) {
      const { first, last, subAt } = indexRecords[ti];
      const subEnd = indexRecords[ti + 1]?.subAt ?? indexEnd;
      if (subEnd - subAt < 8) fail('truncated CBLC index subtable');
      const sub = reader(l.bytes.subarray(subAt, subEnd), 'CBLC index subtable');
      const indexFormat = sub.u16(0);
      const imageFormat = sub.u16(2);
      const imageDataOffset = sub.u32(4);
      const span = last - first + 1;
      let entries;
      let fixedImageSize = null;
      let sharedMetrics = null;
      if (indexFormat === 1 || indexFormat === 3) {
        const itemSize = indexFormat === 1 ? 4 : 2;
        const offsetsAt = 8;
        sub.check(offsetsAt, (span + 1) * itemSize);
        entries = [];
        let prior = -1;
        for (let i = 0; i <= span; i += 1) {
          const value = itemSize === 4 ? sub.u32(offsetsAt + i * itemSize) : sub.u16(offsetsAt + i * itemSize);
          if (value < prior) fail('CBLC glyph offsets are not monotonic');
          prior = value;
          if (i < span) entries.push({ glyphId: first + i, offset: value, endOffset: null });
        }
        for (let i = 0; i < entries.length; i += 1) entries[i].endOffset = itemSize === 4 ? sub.u32(offsetsAt + (i + 1) * itemSize) : sub.u16(offsetsAt + (i + 1) * itemSize);
      } else if (indexFormat === 2) {
        fixedImageSize = sub.u32(8);
        sharedMetrics = parseBigMetrics(sub, 12);
        if (fixedImageSize === 0) fail('CBLC fixed image size is zero');
        entries = Array.from({ length: span }, (_, i) => ({ glyphId: first + i, offset: i * fixedImageSize, endOffset: null }));
      } else if (indexFormat === 4) {
        const count = sub.u32(8);
        if (count === 0 || count > span || count > 65536) fail('invalid sparse CBLC glyph count');
        const pairsAt = 12;
        sub.check(pairsAt, (count + 1) * 4);
        const pairs = [];
        let priorGlyph = -1;
        let priorOffset = -1;
        for (let i = 0; i <= count; i += 1) {
          const glyphId = sub.u16(pairsAt + i * 4);
          const offset = sub.u16(pairsAt + i * 4 + 2);
          if (glyphId <= priorGlyph || offset < priorOffset) fail('CBLC sparse glyph pairs are not monotonic');
          if (i < count && (glyphId < first || glyphId > last || (numGlyphs !== null && glyphId >= numGlyphs))) fail('CBLC sparse glyph ID is out of range');
          pairs.push({ glyphId, offset });
          priorGlyph = glyphId;
          priorOffset = offset;
        }
        entries = pairs.slice(0, count).map((pair, i) => ({ glyphId: pair.glyphId, offset: pair.offset, endOffset: pairs[i + 1].offset }));
      } else if (indexFormat === 5) {
        fixedImageSize = sub.u32(8);
        sharedMetrics = parseBigMetrics(sub, 12);
        const countAt = 20;
        const count = sub.u32(countAt);
        if (fixedImageSize === 0 || count === 0 || count > span) fail('invalid fixed sparse CBLC index');
        const glyphsAt = countAt + 4;
        sub.check(glyphsAt, count * 2);
        entries = [];
        let previous = -1;
        for (let i = 0; i < count; i += 1) {
          const glyphId = sub.u16(glyphsAt + i * 2);
          if (glyphId <= previous || glyphId < first || glyphId > last || (numGlyphs !== null && glyphId >= numGlyphs)) fail('CBLC sparse glyph IDs are invalid');
          entries.push({ glyphId, offset: i * fixedImageSize, endOffset: null });
          previous = glyphId;
        }
      } else {
        fail(`unsupported CBLC index format ${indexFormat}`);
      }
      const supportedImage = imageFormat === 17 || imageFormat === 18 || imageFormat === 19;
      if (imageFormat === 19 && !sharedMetrics) fail('CBDT image format 19 requires shared CBLC metrics');
      for (const entry of entries) {
        let length = fixedImageSize;
        if (entry.endOffset !== null) length = entry.endOffset - entry.offset;
        const dataAt = imageDataOffset + entry.offset;
        d.check(dataAt, length);
        entry.dataAt = dataAt;
        entry.dataLength = length;
        entry.imageFormat = imageFormat;
        entry.sharedMetrics = sharedMetrics;
      }
      subtables.push({ first, last, indexFormat, imageFormat, supportedImage, entries });
      previousEnd = last;
    }
    strikes.push({ ppemX, ppemY, subtables });
  }
  return { strikes, data: cbdtBytes, supported: strikes.some((strike) => strike.subtables.some((subtable) => subtable.supportedImage)) };
}

function findCbdtEntry(strike, glyphId) {
  for (const subtable of strike.subtables) {
    if (!subtable.supportedImage || glyphId < subtable.first || glyphId > subtable.last) continue;
    return subtable.entries.find((entry) => entry.glyphId === glyphId) ?? null;
  }
  return null;
}

function pngInfo(bytes) {
  if (bytes.length < 33 || bytes.length > MAX_PNG_BYTES) fail('PNG image exceeds bounds or is truncated');
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) fail('bitmap is not PNG data');
  }
  const r = reader(bytes, 'PNG header');
  if (r.u32(8) !== 13 || r.u32(12) !== 0x49484452) fail('PNG does not begin with IHDR');
  const width = r.u32(16);
  const height = r.u32(20);
  if (width === 0 || height === 0 || width > MAX_PNG_AXIS || height > MAX_PNG_AXIS) fail('PNG dimensions exceed limits');
  return { width, height };
}

function metricsGeometry(metrics, scaleX, scaleY) {
  if (!metrics || metrics.width <= 0 || metrics.height <= 0) return null;
  return {
    x: metrics.bearingX * scaleX,
    y: -metrics.bearingY * scaleY,
    width: metrics.width * scaleX,
    height: metrics.height * scaleY,
  };
}

function cbdtGlyph(table, glyphId, options) {
  const { unitsPerEm, ppem } = options;
  const candidates = table.strikes
    .map((strike) => ({ strike, entry: findCbdtEntry(strike, glyphId) }))
    .filter(({ entry }) => entry && entry.dataLength > 0)
    .sort((a, b) => Math.abs(a.strike.ppemY - ppem) - Math.abs(b.strike.ppemY - ppem));
  for (const { strike, entry } of candidates) {
    const d = reader(table.data, 'CBDT table');
    const start = entry.dataAt;
    const length = entry.dataLength;
    let metrics = entry.sharedMetrics;
    let pngAt = start;
    let pngLength;
    if (entry.imageFormat === 17) {
      metrics = parseSmallMetrics(d, start);
      pngLength = d.u32(start + 5);
      pngAt = start + 9;
    } else if (entry.imageFormat === 18) {
      metrics = parseBigMetrics(d, start);
      pngLength = d.u32(start + 8);
      pngAt = start + 12;
    } else if (entry.imageFormat === 19) {
      pngLength = d.u32(start);
      pngAt = start + 4;
    } else {
      continue;
    }
    if (pngLength > MAX_PNG_BYTES || pngLength > length - (pngAt - start)) fail('CBDT PNG length is invalid');
    const png = d.slice(pngAt, pngLength);
    const info = pngInfo(png);
    if (info.width !== metrics?.width || info.height !== metrics?.height) fail('CBDT PNG dimensions do not match glyph metrics');
    const geometry = metricsGeometry(metrics, unitsPerEm / strike.ppemX, unitsPerEm / strike.ppemY);
    if (!geometry) continue;
    return { kind: 'bitmap', png: copyBytes(png), pixelWidth: info.width, pixelHeight: info.height, ...geometry };
  }
  return null;
}

function parseSbix(bytes, numGlyphs) {
  const r = reader(bytes, 'sbix table');
  if (r.length < 8) fail('truncated sbix header');
  if (r.u16(0) !== 1) fail('unsupported sbix version');
  const strikeCount = r.u32(4);
  if (strikeCount === 0 || strikeCount > 2048) fail('invalid sbix strike count');
  r.check(8, strikeCount * 4);
  if (numGlyphs === null) fail('sbix requires maxp glyph count');
  const offsets = [];
  let previous = 8 + strikeCount * 4 - 1;
  for (let i = 0; i < strikeCount; i += 1) {
    const offset = r.u32(8 + i * 4);
    if (offset <= previous || offset >= r.length) fail('sbix strike offsets are invalid');
    offsets.push(offset);
    previous = offset;
  }
  const strikes = offsets.map((offset, index) => {
    const end = offsets[index + 1] ?? r.length;
    if (end - offset < 4 + (numGlyphs + 1) * 4) fail('truncated sbix strike');
    const ppem = r.u16(offset);
    if (ppem === 0) fail('invalid sbix ppem');
    const dataStart = offset + 4 + (numGlyphs + 1) * 4;
    const glyphs = [];
    const relativeOffsets = [];
    for (let gid = 0; gid <= numGlyphs; gid += 1) {
      const delta = r.u32(offset + 4 + gid * 4);
      const maxDelta = end - offset;
      if (delta < 4 + (numGlyphs + 1) * 4 || delta > maxDelta || (relativeOffsets.length && delta < relativeOffsets[relativeOffsets.length - 1])) fail('sbix glyph offsets are invalid');
      relativeOffsets.push(delta);
    }
    for (let gid = 0; gid < numGlyphs; gid += 1) {
      const start = offset + relativeOffsets[gid];
      const length = relativeOffsets[gid + 1] - relativeOffsets[gid];
      if (length > 0) {
        r.check(start, length);
        if (start + length > end) fail('sbix glyph record exceeds strike');
        if (length < 8) fail('truncated sbix glyph record');
      }
      glyphs.push({ start, length });
    }
    return { ppem, glyphs, dataStart };
  });
  return { bytes, strikes, numGlyphs };
}

function sbixGlyph(table, glyphId, options) {
  const candidates = table.strikes.filter((strike) => strike.glyphs[glyphId]?.length > 0)
    .sort((a, b) => Math.abs(a.ppem - options.ppem) - Math.abs(b.ppem - options.ppem));
  for (const strike of candidates) {
    let current = glyphId;
    const seen = new Set();
    const r = reader(table.bytes, 'sbix table');
    const originalRecord = strike.glyphs[glyphId];
    const originalX = r.i16(originalRecord.start);
    const originalY = r.i16(originalRecord.start + 2);
    while (true) {
      if (seen.has(current) || seen.size > 10) break;
      seen.add(current);
      const record = strike.glyphs[current];
      if (!record || record.length === 0) break;
      const tag = String.fromCharCode(r.u8(record.start + 4), r.u8(record.start + 5), r.u8(record.start + 6), r.u8(record.start + 7));
      if (tag === 'dupe') {
        if (record.length !== 10) break;
        current = r.u16(record.start + 8);
        if (current >= table.numGlyphs) break;
        continue;
      }
      if (tag !== 'png ') break;
      const pngAt = record.start + 8;
      const png = r.slice(pngAt, record.length - 8);
      const info = pngInfo(png);
      const scale = options.unitsPerEm / strike.ppem;
      const geometry = {
        x: originalX * scale,
        y: -originalY * scale - info.height * scale,
        width: info.width * scale,
        height: info.height * scale,
      };
      return { kind: 'bitmap', png: copyBytes(png), pixelWidth: info.width, pixelHeight: info.height, ...geometry };
    }
  }
  return null;
}

function colrGlyph(colr, glyphId) {
  if (!colr?.v0) return null;
  let low = 0;
  let high = colr.v0.bases.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const base = colr.v0.bases[middle];
    if (glyphId < base.glyphId) high = middle - 1;
    else if (glyphId > base.glyphId) low = middle + 1;
    else {
      const selected = colr.v0.layers.slice(base.firstLayer, base.firstLayer + base.count);
      return {
        kind: 'layers',
        layers: selected.map((layer) => ({
          glyphId: layer.glyphId,
          // 0xFFFF is the COLR foreground color. kino's color-glyph path
          // has no inherited text fill, so use the platform's opaque black default.
          color: layer.paletteIndex === 0xffff ? [0, 0, 0, 255] : [...colr.v0.palette[layer.paletteIndex]],
        })),
      };
    }
  }
  return null;
}

function validateOptions(glyphId, options, formats, numGlyphs) {
  if (!Number.isInteger(glyphId) || glyphId < 0 || glyphId > MAX_GLYPH_ID) throw new RangeError('glyphId must be an unsigned 16-bit integer');
  if (numGlyphs !== null && glyphId >= numGlyphs) return null;
  const unitsPerEm = options?.unitsPerEm;
  const ppem = options?.ppem ?? 128;
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0 || unitsPerEm > 0xffff) throw new RangeError('unitsPerEm must be a positive finite font-unit scale');
  if (!Number.isFinite(ppem) || ppem <= 0 || ppem > MAX_PNG_AXIS) throw new RangeError('ppem must be a positive finite pixel size');
  if (options?.format !== undefined && typeof options.format !== 'string') throw new TypeError('format must be a color-font format label');
  if (options?.format && !formats.includes(options.format)) return null;
  return { unitsPerEm, ppem, format: options?.format };
}

export function readColorFontTables(input) {
  const fontBytes = asBytes(input);
  const tables = tableDirectory(fontBytes);
  if (!tables) return { formats: [], glyph: () => null };
  const numGlyphs = glyphCount(tables);

  const svg = tables.has('SVG ') ? parseSvgTable(tables.get('SVG ')) : null;
  const hasBitmapPair = tables.has('CBLC') || tables.has('CBDT');
  if (hasBitmapPair && !(tables.has('CBLC') && tables.has('CBDT'))) fail('CBLC and CBDT must both be present');
  const cbdt = hasBitmapPair ? parseCbdt(tables.get('CBLC'), tables.get('CBDT'), numGlyphs) : null;
  const sbix = tables.has('sbix') ? parseSbix(tables.get('sbix'), numGlyphs) : null;

  const hasColr = tables.has('COLR');
  const hasCpal = tables.has('CPAL');
  const palette = hasCpal ? parseCpal(tables.get('CPAL')) : null;
  const colr = hasColr ? parseColr(tables.get('COLR'), palette, numGlyphs) : null;
  const formats = [];
  if (svg) formats.push('SVG');
  if (cbdt?.supported) formats.push('CBDT');
  if (sbix) formats.push('sbix');
  if (colr?.v0) formats.push('COLR-v0');
  if (colr?.hasV1) formats.push('COLR-v1');
  const order = ['SVG', 'CBDT', 'sbix', 'COLR-v0'];

  function glyph(glyphId, options = {}) {
    const parsedOptions = validateOptions(glyphId, options, formats, numGlyphs);
    if (!parsedOptions) return null;
    const wanted = parsedOptions.format ? [parsedOptions.format] : order;
    for (const format of wanted) {
      if (format === 'SVG' && svg) {
        const entry = findSvgRecord(svg, glyphId);
        if (entry) {
          // Cached descriptor bytes are a stable read-only payload by contract.
          const { documentId, document } = cachedSvgDocument(svg, entry);
          return { kind: 'svg', documentId, document, gzip: document[0] === 0x1f && document[1] === 0x8b };
        }
      } else if (format === 'CBDT' && cbdt) {
        const value = cbdtGlyph(cbdt, glyphId, parsedOptions);
        if (value) return value;
      } else if (format === 'sbix' && sbix) {
        const value = sbixGlyph(sbix, glyphId, parsedOptions);
        if (value) return value;
      } else if (format === 'COLR-v0' && colr) {
        const value = colrGlyph(colr, glyphId);
        if (value) return value;
      }
    }
    return null;
  }

  // The integration calls this after it has tried the supported SVG, bitmap,
  // and COLRv0 providers for this glyph.
  function unsupportedGlyph(glyphId) {
    if (!Number.isInteger(glyphId) || glyphId < 0 || glyphId > MAX_GLYPH_ID) throw new RangeError('glyphId must be an unsigned 16-bit integer');
    if (numGlyphs !== null && glyphId >= numGlyphs) return false;
    return Boolean(colr?.v1GlyphIds.has(glyphId) && !hasColrV0Glyph(colr, glyphId));
  }

  return { formats, glyph, unsupportedGlyph };
}
