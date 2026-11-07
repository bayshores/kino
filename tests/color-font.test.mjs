import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { create } from "fontkit";
import { loadImage } from "@napi-rs/canvas";
import test from "node:test";
import { readColorFontTables } from "../engine/colorFontTables.js";
import { createColorFontFixture } from "./color-font.mjs";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function sfntTables(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, false);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = view.getUint32(at + 8, false);
    const length = view.getUint32(at + 12, false);
    tables.set(tag, bytes.subarray(offset, offset + length));
  }
  return tables;
}

function bitmapPngs(fontBytes) {
  const tables = sfntTables(fontBytes);
  const cblc = tables.get("CBLC");
  const cbdt = tables.get("CBDT");
  assert.ok(cblc && cbdt, "bitmap fixture has CBLC and CBDT tables");
  const view = new DataView(cblc.buffer, cblc.byteOffset, cblc.byteLength);
  const arrayOffset = view.getUint32(8, false);
  const firstGlyph = view.getUint16(arrayOffset, false);
  const lastGlyph = view.getUint16(arrayOffset + 2, false);
  const subtable = arrayOffset + view.getUint32(arrayOffset + 4, false);
  assert.equal(view.getUint16(subtable, false), 1, "fixture uses a format-1 index subtable");
  assert.equal(view.getUint16(subtable + 2, false), 17, "fixture stores small-metric PNG images");
  const imageDataOffset = view.getUint32(subtable + 4, false);
  const pngs = [];
  for (let glyphId = firstGlyph; glyphId <= lastGlyph; glyphId += 1) {
    const offsetAt = subtable + 8 + (glyphId - firstGlyph) * 4;
    const start = view.getUint32(offsetAt, false);
    const end = view.getUint32(offsetAt + 4, false);
    if (end === start) continue;
    const record = imageDataOffset + start;
    const length = new DataView(cbdt.buffer, cbdt.byteOffset, cbdt.byteLength).getUint32(record + 5, false);
    pngs.push(cbdt.subarray(record + 9, record + 9 + length));
  }
  return pngs;
}

function assertMetadata(metadata, format) {
  assert.equal(metadata.family, "Noto Color Emoji");
  assert.equal(metadata.src, "/api/fonts/fs-noto-color-emoji--1.0.0--400-normal.ttf");
  assert.equal(metadata.weight, 400);
  assert.equal(metadata.style, "normal");
  assert.equal(metadata.format, format);
  assert.equal(metadata.license, "SIL Open Font License 1.1");
  assert.match(metadata.provenance, /Inter-400\.ttf/);
  assert.match(metadata.provenance, /original geometry, not Noto artwork/);
}

test("SVG color-font fixture shapes mapped Unicode with licensed Inter glyphs", async () => {
  const sourceBefore = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const original = create(new Uint8Array(sourceBefore));
  const fixture = await createColorFontFixture();
  const rebuilt = create(fixture.bytes);
  const colorFont = readColorFontTables(fixture.bytes);
  const sourceAfter = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));

  assert.deepEqual(sourceAfter, sourceBefore, "fixture generation leaves the licensed source font untouched");
  assertMetadata(fixture.metadata, "SVG");
  assert.deepEqual(
    rebuilt.layout("ABC").glyphs.map(({ id }) => id),
    original.layout("ABC").glyphs.map(({ id }) => id),
  );
  assert.deepEqual(
    rebuilt.layout("ABC").glyphs.map(({ advanceWidth }) => advanceWidth),
    original.layout("ABC").glyphs.map(({ advanceWidth }) => advanceWidth),
  );
  assert.deepEqual(rebuilt.layout("😀👍🏽🇺🇸👩👦").glyphs.map(({ id }) => id), [
    fixture.glyphIds.smilingFace,
    fixture.glyphIds.thumbsUp,
    fixture.glyphIds.skinTone,
    fixture.glyphIds.regionalIndicatorU,
    fixture.glyphIds.regionalIndicatorS,
    fixture.glyphIds.woman,
    fixture.glyphIds.boy,
  ]);
  assert.equal(sfntTables(fixture.bytes).has("SVG "), true);
  assert.deepEqual(colorFont.formats, ["SVG"]);
  assert.equal(colorFont.glyph(fixture.glyphIds.smilingFace, { unitsPerEm: rebuilt.unitsPerEm, format: "SVG" }).kind, "svg");
});

test("bitmap color-font fixture embeds decodable PNG glyph bytes", async () => {
  const sourceBefore = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const fixture = await createColorFontFixture({ format: "bitmap" });
  const rebuilt = create(fixture.bytes);
  const colorFont = readColorFontTables(fixture.bytes);
  const sourceAfter = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const pngs = bitmapPngs(fixture.bytes);

  assert.deepEqual(sourceAfter, sourceBefore, "fixture generation leaves the licensed source font untouched");
  assertMetadata(fixture.metadata, "CBDT");
  assert.deepEqual(colorFont.formats, ["CBDT"]);
  assert.deepEqual(rebuilt.layout("😀👍🏽").glyphs.map(({ id }) => id), [
    fixture.glyphIds.smilingFace,
    fixture.glyphIds.thumbsUp,
    fixture.glyphIds.skinTone,
  ]);
  assert.equal(colorFont.glyph(fixture.glyphIds.smilingFace, { unitsPerEm: rebuilt.unitsPerEm, ppem: 16, format: "CBDT" }).kind, "bitmap");
  assert.equal(pngs.length, 3);
  for (const png of pngs) {
    assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
    const image = await loadImage(Buffer.from(png));
    assert.equal(image.width, 16);
    assert.equal(image.height, 16);
  }
});
