import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { layoutText, textUnits } from "./textLayout.js";
import { textUnitBounds, textUnitGroup } from "./textUnitGeometry.js";

const fonts = await loadBundledFonts();

function text(overrides = {}) {
  return {
    type: "text",
    id: "text",
    fontFamily: "Inter",
    fontSize: 36,
    fontWeight: 400,
    fontStyle: "normal",
    text: "Text",
    width: 240,
    height: 80,
    textAlign: "left",
    verticalAlign: "top",
    textResize: "fixed",
    lineHeight: 1.2,
    letterSpacing: 0,
    kerning: true,
    ligatures: true,
    ...overrides,
  };
}

function assertContains(bounds, x, y, width, height, message = "rectangle is contained") {
  const epsilon = 1e-7;
  assert.ok(bounds.x <= x + epsilon, `${message}: left edge`);
  assert.ok(bounds.y <= y + epsilon, `${message}: top edge`);
  assert.ok(bounds.x + bounds.width + epsilon >= x + width, `${message}: right edge`);
  assert.ok(bounds.y + bounds.height + epsilon >= y + height, `${message}: bottom edge`);
}

function assertGlyphsContained(bounds, glyphs) {
  for (const glyph of glyphs) {
    const ink = {
      x: glyph.x + glyph.bounds.x,
      y: glyph.y + glyph.bounds.y,
      width: glyph.bounds.width,
      height: glyph.bounds.height,
    };
    assertContains(bounds, ink.x, ink.y, ink.width, ink.height, `glyph ${glyph.start}:${glyph.end} ink`);
    assertContains(
      bounds,
      Math.min(glyph.x, glyph.x + glyph.advance),
      glyph.y,
      Math.abs(glyph.advance),
      0,
      `glyph ${glyph.start}:${glyph.end} advance`,
    );
  }
}

function assertFiniteBounds(bounds) {
  assert.ok([bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite));
  assert.ok(bounds.width >= 0);
  assert.ok(bounds.height >= 0);
}

test("unit bounds contain shaped combining-mark and italic ink, advances, and the line-height cell", () => {
  const accented = layoutText(text({ fontFamily: "Noto Serif", text: "e\u0301A", height: 100 }), fonts);
  const accentedUnits = textUnits(accented, "letters");
  assert.deepEqual(accentedUnits.map((unit) => unit.text), ["é", "A"], "NFC shaping still owns the original grapheme");
  const accentBounds = textUnitBounds(accented, accentedUnits[0]);
  assertGlyphsContained(accentBounds, accentedUnits[0].glyphs);
  assert.ok(accentBounds.height >= accented.lineHeight, "the grapheme carries its line-height cell");

  const italic = layoutText(text({ fontFamily: "Noto Serif", fontStyle: "italic", text: "f", height: 100 }), fonts);
  const italicUnit = textUnits(italic, "letters")[0];
  const italicBounds = textUnitBounds(italic, italicUnit);
  assertGlyphsContained(italicBounds, italicUnit.glyphs);
  assert.ok(italicBounds.height >= italic.lineHeight);
  assertFiniteBounds(italicBounds);
});

test("ligature advances stay with the shaped grapheme owner", () => {
  // Decomposition can leave an empty source list on the font's cached e glyph.
  // The later ordinary e must still consume its own source character without
  // forcing the earlier ffi ligature into per-character recovery shaping.
  layoutText(text({ fontFamily: "Noto Serif", text: "é" }), fonts);
  const layout = layoutText(text({ fontFamily: "Noto Serif", text: "office", width: 240 }), fonts);
  const units = textUnits(layout, "letters");
  assert.equal(units.length, 6);
  assert.equal(units.flatMap((unit) => unit.glyphs).length, 4, "the ffi ligature remains one shaped glyph");
  assert.deepEqual(units.at(-1).glyphs.map(({ start, end }) => [start, end]), [[5, 6]]);

  for (const unit of units) {
    const bounds = textUnitBounds(layout, unit);
    assertFiniteBounds(bounds);
    assertGlyphsContained(bounds, unit.glyphs);
  }
  const ligatureOwner = units.find((unit) => unit.glyphs.some((glyph) => glyph.end - glyph.start > 1));
  assert.ok(ligatureOwner, "the ligature belongs to its source grapheme as textUnits reports");
  const ligature = ligatureOwner.glyphs.find((glyph) => glyph.end - glyph.start > 1);
  assertContains(textUnitBounds(layout, ligatureOwner), ligature.x, ligature.y, ligature.advance, 0);
});

test("whitespace and empty lines produce finite advances and line cells", () => {
  const layout = layoutText(text({ text: "A B", fontFamily: "Inter" }), fonts);
  const units = textUnits(layout, "letters");
  const space = units.find((unit) => unit.text === " ");
  assert.ok(space);
  assert.equal(space.glyphs.length, 1);
  const spaceBounds = textUnitBounds(layout, space);
  assertFiniteBounds(spaceBounds);
  assert.ok(spaceBounds.width >= Math.abs(space.glyphs[0].advance), "the space keeps its measured advance despite having no ink");
  assert.ok(spaceBounds.height + 1e-9 >= layout.lineHeight);

  const blank = layoutText(text({ text: "\n", height: 100 }), fonts);
  const lines = textUnits(blank, "lines");
  assert.equal(lines.length, 2);
  const cells = lines.map((unit) => textUnitBounds(blank, unit));
  for (const bounds of cells) assertFiniteBounds(bounds);
  assert.equal(cells[0].width, 0, "an empty line has no invented text width");
  assert.ok(cells[0].height + 1e-9 >= blank.lineHeight);
  assert.ok(cells[1].y > cells[0].y, "blank lines retain their own baseline cell");

  const empty = layoutText(text({ text: "", height: 40 }), fonts);
  const emptyLine = textUnits(empty, "lines")[0];
  const emptyBounds = textUnitBounds(empty, emptyLine);
  assertFiniteBounds(emptyBounds);
  assert.equal(emptyBounds.width, 0);
});

test("layer bounds include the entire text box and every resting glyph even when ink exceeds it", () => {
  const layout = layoutText(text({ text: "Ág", fontFamily: "Noto Serif", fontSize: 42, width: 90, height: 18 }), fonts);
  const layer = textUnits(layout, "layer")[0];
  const bounds = textUnitBounds(layout, layer);
  assertContains(bounds, 0, 0, layout.width, layout.height, "full layer box");
  assertGlyphsContained(bounds, layer.glyphs);
  assert.ok(bounds.height >= layout.height);
});

test("group lookup maps units by sourceStart across different wrapping and returns null for a dropped gap", () => {
  const source = "AB CD EF";
  const wide = layoutText(text({ text: source, fontSize: 20, width: 240 }), fonts);
  const wrapped = layoutText(text({ text: source, fontSize: 20, width: 40 }), fonts);
  assert.ok(wrapped.lines.length > wide.lines.length, "the drawing layout wraps differently from the source layout");

  const wrappedLetters = textUnits(wrapped, "letters");
  const finalLetter = wrappedLetters.find((unit) => unit.text === "F");
  assert.ok(finalLetter);
  const wordGroup = textUnitGroup(wide, finalLetter, "words");
  assert.ok(wordGroup);
  assert.equal(wordGroup.unit.text.trim(), "EF");
  assert.equal(wordGroup.index, 2);
  assert.equal(wordGroup.count, textUnits(wide, "words").length);
  assert.equal(wordGroup.unit, textUnitGroup(wide, finalLetter, "words").unit, "mode units are cached per layout");
  assertGlyphsContained(wordGroup.bounds, wordGroup.unit.glyphs);

  const narrowSource = layoutText(text({ text: source, fontSize: 20, width: 40 }), fonts);
  const wideLetters = textUnits(wide, "letters");
  const sourceFinalLetter = wideLetters.find((unit) => unit.text === "F");
  const lineGroup = textUnitGroup(narrowSource, sourceFinalLetter, "lines");
  assert.ok(lineGroup);
  assert.ok(lineGroup.unit.text.includes("F"));
  assert.ok(sourceFinalLetter.sourceStart >= lineGroup.unit.sourceStart);
  assert.ok(sourceFinalLetter.sourceStart < lineGroup.unit.sourceEnd);

  const wrappedSpace = wideLetters.find((unit) => unit.text === " ");
  assert.ok(wrappedSpace);
  assert.equal(textUnitGroup(narrowSource, wrappedSpace, "lines"), null,
    "a space removed at a wrapped line boundary is not attached to the nearest line");

  const layerGroup = textUnitGroup(wide, finalLetter, "layer");
  assert.deepEqual([layerGroup.index, layerGroup.count, layerGroup.unit.sourceEnd], [0, 1, Infinity]);
  assertContains(layerGroup.bounds, 0, 0, wide.width, wide.height);
});
