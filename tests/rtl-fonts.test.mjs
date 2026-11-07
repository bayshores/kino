import assert from "node:assert/strict";
import test from "node:test";
import { shapeText } from "../engine/textLayout.js";
import { loadRtlTestFonts } from "./rtl-fonts.mjs";

const fonts = await loadRtlTestFonts();

test("local Noto Arabic and Hebrew fixtures shape explicit faces and script fallbacks", () => {
  const cases = [
    { family: "Noto Sans Arabic", text: "السَّلَامُ" },
    { family: "Noto Sans Hebrew", text: "שָׁלוֹם" },
  ];

  for (const { family, text } of cases) {
    const fallbackRuns = fonts.textRuns(text, { fontFamily: "Inter" });
    assert.ok(fallbackRuns.every((run) => run.face.family === family && run.face.fallbackFor === "Inter"));

    const explicitRuns = fonts.textRuns(text, { fontFamily: family });
    assert.ok(explicitRuns.every((run) => run.face.family === family && !run.face.missingGlyph));

    for (const fontFamily of ["Inter", family]) {
      const shaped = shapeText(text, { fontFamily, fontSize: 36, fontWeight: 400, fontStyle: "normal" }, fonts);
      assert.ok(shaped.glyphs.length > 0, `${family} produced glyphs`);
      assert.ok(shaped.glyphs.every((glyph) => !glyph.missing), `${family} has coverage for ${JSON.stringify(text)}`);
    }
  }

  const arabicFace = fonts.resolve({ fontFamily: "Noto Sans Arabic" });
  const joined = arabicFace.font.layout("سلام").glyphs.map((glyph) => glyph.id);
  const isolated = [..."سلام"].flatMap((character) => arabicFace.font.layout(character).glyphs.map((glyph) => glyph.id));
  assert.notDeepEqual(joined, isolated, "Arabic joining changes contextual glyph selection");
});
