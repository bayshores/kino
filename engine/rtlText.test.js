import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene } from "./model.js";
import { layoutText, shapeText, textUnits } from "./textLayout.js";
import { loadRtlTestFonts } from "../tests/rtl-fonts.mjs";
import { documentFontReferences, fontTextCharacters } from "./fontDocuments.js";
import { fontGlyphReferences } from "./fontGlyphReferences.js";

const fonts = await loadRtlTestFonts();
const layer = (text, values = {}) => createLayer("text", { text, fontFamily: "Inter", fontSize: 32,
  fontWeight: 400, width: 400, height: 180, textResize: "fixed", ...values });

test("mixed Hebrew, Latin and numbers draw visually while animation units remain logical", () => {
  const value = layer("abc אבג 123");
  const layout = layoutText(value, fonts);
  const line = layout.lines[0];
  assert.equal(line.glyphs.map((glyph) => line.text.slice(glyph.start, glyph.end)).join(""), "abc 123 גבא");
  assert.equal(textUnits(layout, "letters").map((unit) => unit.text).join(""), value.text);
  assert.equal(textUnits(layout, "words").map((unit) => unit.text).join(""), value.text);
  assert.equal(line.glyphs.find((glyph) => glyph.start === 4).direction, "rtl");
  assert.equal(line.glyphs.find((glyph) => glyph.start === 8).direction, "ltr");
  assert.ok(line.glyphs.every((glyph) => !glyph.missing));
});

test("Arabic joining and generated dots retain the right source letter and unit", () => {
  const value = layer("مرحبا");
  const layout = layoutText(value, fonts), line = layout.lines[0];
  const face = fonts.faces.find((item) => item.family === "Noto Sans Arabic");
  const joined = face.font.layout(value.text, { kern: true, liga: true, clig: true }, undefined, undefined, "rtl");
  assert.ok(Math.abs(line.width - joined.positions.reduce((sum, position) => sum + position.xAdvance, 0) * 32 / face.font.unitsPerEm) < 1e-8);
  const units = textUnits(layout, "letters");
  assert.deepEqual(units.map((unit) => unit.text), [...value.text]);
  assert.ok(units.every((unit) => unit.glyphs.length > 0));
  assert.ok(units.find((unit) => unit.text === "ب").glyphs.length >= 2, "the generated dots follow beh, not its neighbor");
  assert.ok(line.glyphs.every((glyph) => glyph.end > glyph.start && !glyph.missing));
  assert.deepEqual(units.map((unit) => unit.glyphs[0].start), [0, 1, 2, 3, 4]);
  assert.ok(units[0].glyphs[0].x > units.at(-1).glyphs[0].x);
});

test("Arabic vowel marks and generated artwork remain inside their grapheme units", () => {
  const value = layer("بِسْمِ"), layout = layoutText(value, fonts);
  const units = textUnits(layout, "letters");
  assert.deepEqual(units.map((unit) => unit.text), ["بِ", "سْ", "مِ"]);
  assert.ok(units.every((unit) => unit.glyphs.length >= 2));
  for (const unit of units) assert.ok(unit.glyphs.every((glyph) =>
    glyph.start >= unit.start && glyph.end <= unit.end && !glyph.missing));
});

test("a paint-only Arabic range preserves joining, glyph positions and source ownership", () => {
  for (const text of ["مرحبا", "بِسْمِ"]) {
    const plain = layoutText(layer(text), fonts).lines[0];
    const range = text === "مرحبا" ? { start: 1, end: 3 } : { start: 2, end: 4 };
    const styled = layoutText(layer(text, {
      textStyleRanges: [{ ...range, style: { fill: "#c45040" } }],
    }), fonts).lines[0];
    const geometry = (line) => line.glyphs.map(({ id, start, end, cluster, x, y, advance }) =>
      ({ id, start, end, cluster, x, y, advance }));
    assert.deepEqual(geometry(styled), geometry(plain));
    for (const glyph of styled.glyphs) assert.equal(glyph.fill,
      glyph.start >= range.start && glyph.start < range.end ? "#c45040" : undefined);
  }
});

test("paint boundaries crossing a ligature keep independent range colors", () => {
  const text = "fi";
  const styled = layoutText(layer(text, { textStyleRanges: [{ start: 1, end: 2, style: { fill: "#c45040" } }] }), fonts);
  assert.ok(styled.lines[0].glyphs.some((glyph) => glyph.start === 0 && glyph.fill === undefined));
  assert.ok(styled.lines[0].glyphs.some((glyph) => glyph.start === 1 && glyph.fill === "#c45040"));
});

test("mirrored brackets use the mirrored outline without losing their original source spans", () => {
  const text = "אב (123)", shaped = shapeText(text, layer(text), fonts);
  const face = fonts.resolve({ fontFamily: "Inter", fontWeight: 400 });
  const opening = shaped.glyphs.find((glyph) => glyph.start === text.indexOf(")"));
  const closing = shaped.glyphs.find((glyph) => glyph.start === text.indexOf("("));
  assert.equal(opening.path, face.font.glyphForCodePoint(40).path.toSVG());
  assert.equal(closing.path, face.font.glyphForCodePoint(41).path.toSVG());
  assert.ok(opening.x < closing.x);
});

test("bidi formatting controls have no advance or tracking gap", () => {
  const plain = shapeText("aאבb", layer("aאבb", { letterSpacing: 10 }), fonts);
  const isolated = shapeText("a\u2067אב\u2069b", layer("a\u2067אב\u2069b", { letterSpacing: 10 }), fonts);
  assert.ok(Math.abs(plain.width - isolated.width) < 1e-8);
  const hidden = isolated.glyphs.filter((glyph) => glyph.hidden);
  assert.equal(hidden.length, 2);
  assert.ok(hidden.every((glyph) => glyph.advance === 0 && !glyph.path && !glyph.color));
});

test("font preparation includes mirrored glyphs while preserving original source strings", () => {
  const value = layer("אב (", { textStyleRanges: [{ start: 3, end: 4, style: { fontWeight: 700 } }] });
  const document = createDocument({ scenes: [createScene({ layers: [value] })] });
  const characters = fontTextCharacters(value);
  assert.ok(characters.includes("(") && characters.includes(")"));
  const reference = documentFontReferences(document).find((item) => item.fontWeight === 700);
  assert.equal(reference.text, "()");
  const glyphs = fontGlyphReferences(document).filter((item) => item.fontWeight === 700);
  assert.deepEqual(glyphs.map((item) => item.text), ["(", ")"]);
  assert.equal(value.text, "אב (");
});

test("wrapped mixed paragraphs retain logical units and source spans across widths and styles", () => {
  const text = "אבג abc 123 דהו xyz 456";
  for (const width of [70, 110, 170, 400]) {
    const layout = layoutText(layer(text, { width,
      textStyleRanges: [{ start: 4, end: 7, style: { fontSize: 44, fill: "#c45040" } }] }), fonts);
    assert.ok(layout.lines.every((line) => line.direction === "rtl"));
    const letters = textUnits(layout, "letters").filter((unit) => unit.text.trim());
    assert.equal(letters.map((unit) => unit.text).join(""), text.replaceAll(" ", ""));
    assert.equal(new Set(letters.map((unit) => unit.sourceStart)).size, letters.length);
    assert.ok(layout.lines.every((line) => line.glyphs.every((glyph) => glyph.end > glyph.start && !glyph.missing)));
    assert.ok(letters.filter((unit) => [4, 5, 6].includes(unit.sourceStart))
      .every((unit) => unit.glyphs.every((glyph) => glyph.fill === "#c45040")));
  }
});

test("Unicode paragraph separators keep raw text intact and choose direction independently", () => {
  const value = layer("abc\u2029אבג\u2028xyz");
  const layout = layoutText(value, fonts);
  assert.deepEqual(layout.lines.map((line) => line.direction), ["ltr", "rtl", "ltr"]);
  assert.deepEqual(layout.lines.map((line) => line.start), [0, 4, 8]);
  assert.deepEqual(textUnits(layout, "lines").map((unit) => unit.text), ["abc", "אבג", "xyz"]);
  assert.equal(value.text, "abc\u2029אבג\u2028xyz");
});
