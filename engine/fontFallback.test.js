import assert from "node:assert/strict";
import test from "node:test";
import { fallbackCatalogIds, fallbackFaces, isEmojiGrapheme } from "./fontFallback.js";

test("emoji presentation recognizes whole sequences without treating ordinary digits as emoji", () => {
  for (const text of ["😀", "👩‍👩‍👦", "🇺🇸", "1️⃣", "#⃣", "👍🏽", "🏽", "©️"])
    assert.equal(isEmojiGrapheme(text), true, text);
  for (const text of ["1", "#", "©", "☺︎", "a", "é"]) assert.equal(isEmojiGrapheme(text), false, text);
});

test("script fallback candidates retain graphemes and use nearby Kana to choose Han forms", () => {
  assert.deepEqual(fallbackCatalogIds("مَ"), ["noto-sans-arabic", "noto-sans"]);
  assert.deepEqual(fallbackCatalogIds("क्ष"), ["noto-sans-devanagari", "noto-sans"]);
  assert.deepEqual(fallbackCatalogIds("文"), ["noto-sans-sc"]);
  assert.deepEqual(fallbackCatalogIds("文", "かな文"), ["noto-sans-jp"]);
  assert.deepEqual(fallbackCatalogIds("😀"), ["noto-color-emoji"]);
  assert.deepEqual(fallbackCatalogIds("\n"), []);
});

test("fallback discovery never borrows an unrelated private upload", () => {
  const publicFace = { id: "public", src: "/api/fonts/fs-noto-color-emoji--5.3.2--400-normal.ttf", weight: 400, style: "normal" };
  const privateFace = { ...publicFace, id: "private", src: "/api/media/11111111-1111-4111-8111-111111111111.ttf" };
  assert.deepEqual(fallbackFaces([privateFace, publicFace], "😀"), [publicFace]);
});

test("repeated variable-face resolution reuses a bounded set of actual instances", async () => {
  const { FontRegistry } = await import("./fonts.js");
  let created = 0;
  const font = { variationAxes: { wght: { min: 100, max: 900 } }, getVariation: ({ wght }) => ({ instance: ++created, wght }) };
  const fonts = new FontRegistry();
  fonts.faces = [{ id: "variable", family: "Variable", weight: 400, style: "normal", font }];
  const first = fonts.resolve({ fontFamily: "Variable", fontWeight: 700 });
  assert.strictEqual(fonts.resolve({ fontFamily: "Variable", fontWeight: 700 }).font, first.font);
  assert.equal(created, 1);
  for (let weight = 100; weight < 120; weight++) fonts.resolve({ fontFamily: "Variable", fontWeight: weight });
  assert.ok(fonts.resolve({ fontFamily: "Variable", fontWeight: 700 }).font.instance > first.font.instance, "old variation entries are evicted");
});
