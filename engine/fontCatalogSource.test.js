import assert from "node:assert/strict";
import test from "node:test";
import { catalogFontSource, parseCatalogFontSource, parseUnicodeRange, unicodeRangeContains, fontSubsetsForText } from "./fontCatalogSource.js";

test("catalog sources preserve a pinned face without permitting remote URLs or traversal", () => {
  const face = { id: "noto-sans", version: "5.2.8", weight: 600, style: "italic" };
  assert.deepEqual(parseCatalogFontSource(catalogFontSource(face)), face);
  for (const source of ["https://example.com/font.ttf", "/api/fonts/fs-noto--latest--400-normal.ttf", "/api/fonts/fs-../secret--5.2.8--400-normal.ttf", "/api/fonts/fs-noto--5.2.8--0-normal.ttf", "/api/fonts/fs-noto--5.2.8--0400-normal.ttf"])
    assert.equal(parseCatalogFontSource(source), null);
  assert.throws(() => catalogFontSource({ ...face, id: "../secret" }));
});

test("Unicode ranges accept CSS singletons, intervals and trailing wildcards, with bounded scalars", () => {
  const ranges = parseUnicodeRange("U+0-7F, U+4??, U+1F600");
  assert.equal(unicodeRangeContains(ranges, 0x0416), true);
  assert.equal(unicodeRangeContains(ranges, 0x1f600), true);
  assert.equal(unicodeRangeContains(ranges, 0x0500), false);
  for (const invalid of ["", "U+FF-1", "U+110000", "U+?A", "U+4??-5FF", "https://x"])
    assert.throws(() => parseUnicodeRange(invalid));
});

test("subset selection is NFC-aware, deduplicated and keeps the default for offline face metadata", () => {
  const metadata = { defSubset: "latin", subsets: ["cyrillic", "latin", "vietnamese"], unicodeRange: {
    latin: "U+0-FF", cyrillic: "U+400-4FF,U+20", vietnamese: "U+1EA0-1EF9,U+20",
  } };
  assert.deepEqual(fontSubsetsForText(metadata, "Cafe\u0301"), ["latin"]);
  assert.deepEqual(fontSubsetsForText(metadata, "Café ЖЖ ộ\u200d"), ["latin", "cyrillic", "vietnamese"]);
  assert.throws(() => fontSubsetsForText(metadata, "字"), /does not include/);
});

test("a face that lacks characters is refused with every missing character listed, so fonts with them can be found", () => {
  const metadata = { defSubset: "latin", subsets: ["latin"], unicodeRange: { latin: "U+0-FF" } };
  assert.throws(() => fontSubsetsForText(metadata, "A ∞ ≠ ∞"), (error) => {
    assert.equal(error.code, "FONT_MISSING_CHARACTERS");
    assert.deepEqual(error.characters, ["∞", "≠"]);
    assert.match(error.message, /does not include "∞", "≠"\./);
    return true;
  });
});
