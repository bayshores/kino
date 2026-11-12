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
  // Han: the line's other script picks the family tried first; the other CJK families follow.
  assert.deepEqual(fallbackCatalogIds("文"), ["noto-sans-sc", "noto-sans-tc", "noto-sans-hk", "noto-sans-jp", "noto-sans-kr"]);
  assert.equal(fallbackCatalogIds("文", "かな文")[0], "noto-sans-jp");
  assert.equal(fallbackCatalogIds("文", "한글 文")[0], "noto-sans-kr");
  assert.ok(fallbackCatalogIds("文", "かな文").includes("noto-sans-sc"));
  assert.deepEqual(fallbackCatalogIds("😀"), ["noto-color-emoji"]);
  assert.deepEqual(fallbackCatalogIds("\n"), []);
});

test("fallback discovery never borrows an unrelated private upload", () => {
  const publicFace = { id: "public", src: "/api/fonts/fs-noto-color-emoji--5.3.2--400-normal.ttf", weight: 400, style: "normal" };
  const privateFace = { ...publicFace, id: "private", src: "/api/media/11111111-1111-4111-8111-111111111111.ttf" };
  assert.deepEqual(fallbackFaces([privateFace, publicFace], "😀"), [publicFace]);
});

test("a Chinese character falls back to an installed Japanese face when no Chinese one is", () => {
  const jp = { id: "jp", src: "/api/fonts/fs-noto-sans-jp--5.3.0--400-normal.ttf", weight: 400, style: "normal" };
  const kr = { id: "kr", src: "/api/fonts/fs-noto-sans-kr--5.3.0--400-normal.ttf", weight: 400, style: "normal" };
  assert.deepEqual(fallbackFaces([kr, jp], "离"), [jp, kr]);
  assert.deepEqual(fallbackFaces([jp, kr], "离", "한 离"), [kr, jp]);
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
