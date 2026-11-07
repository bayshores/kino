import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { FontRegistry } from "./fonts.js";
import { resizeTextLayer, shapeText } from "./textLayout.js";
import { createDocument, createScene, createLayer } from "./model.js";
import { fontTextCharacters, documentFontReferences, withFontPatches, previewFontScene } from "./fontDocuments.js";

const bytes = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
const source = "/api/fonts/fs-inter--5.2.8--400-normal.ttf";
function subsetRegistry() {
  const fonts = new FontRegistry();
  for (const [subset, unicodeRange] of [["latin", "U+0-7F"], ["extended", "U+80-FF"]])
    fonts.register(bytes, { id: subset, family: "Inter", weight: 400, style: "normal", src: source, subset, defaultSubset: "latin", unicodeRange });
  return fonts;
}

test("downloaded subset runs retain glyph geometry, source offsets and tracking", () => {
  const fonts = subsetRegistry();
  const text = "Ae\u0301A";
  // Separate font files shape separate runs; disable pair kerning for this geometry comparison.
  const layer = createLayer("text", { fontSource: source, fontSize: 40, letterSpacing: 10, kerning: false });
  const actual = shapeText(text, layer, fonts);
  const single = new FontRegistry(); single.register(bytes, { family: "Inter", src: source });
  const expected = shapeText(text, layer, single);
  assert.deepEqual(actual.glyphs.map(({ start, end, cluster }) => ({ start, end, cluster })), expected.glyphs.map(({ start, end, cluster }) => ({ start, end, cluster })));
  assert.deepEqual(actual.glyphs.map(({ id, x, y, path }) => ({ id, x, y, path })), expected.glyphs.map(({ id, x, y, path }) => ({ id, x, y, path })));
  assert.equal(actual.width, expected.width);
  assert.equal(fonts.textRuns("AéA", layer).length, 3);
  assert.equal(shapeText("字", layer, fonts).glyphs[0].missing, "字");
});

test("font preview leaves the original document and scalar settings intact", () => {
  const fonts = subsetRegistry();
  const scene = createScene({ id: "scene", layers: [createLayer("text", { id: "text", text: "Café", fontSize: 30, width: 300, textResize: "width-height", textAlign: "center" })] });
  const document = createDocument({ scenes: [scene] });
  const before = JSON.stringify(document);
  const patch = { id: "text", fontFamily: "Inter", fontSource: source, fontWeight: 400, fontStyle: "normal" };
  const preview = previewFontScene(scene, { sceneId: "scene", patches: [patch] }, fonts);
  assert.equal(JSON.stringify(document), before);
  assert.equal(preview.layers[0].fontSource, source);
  assert.equal(preview.layers[0].x + preview.layers[0].width / 2, scene.layers[0].x + scene.layers[0].width / 2);
  const changed = withFontPatches(document, "scene", [patch], fonts);
  assert.equal(JSON.stringify(document), before);
  assert.equal(changed.scenes[0].layers[0].fontSource, source);
  assert.equal(withFontPatches(changed, "scene", [patch], fonts), changed);
  assert.throws(() => withFontPatches(document, "scene", [{ ...patch, id: "missing" }], fonts), /existing text layer/);
});

test("font requirements include changed strings, generated digits and normalized text case", () => {
  const layer = createLayer("text", { text: "straße", textCase: "upper", animations: [{ id: "swap", kind: "change-text", text: "Café", start: 1 }, { id: "counter", kind: "counter", start: 2 }] });
  const characters = fontTextCharacters(layer);
  assert.ok(characters.includes("É") && characters.includes("9") && !characters.includes("ß"));
  const refs = documentFontReferences(createDocument({ scenes: [createScene({ layers: [layer] })] }));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].text, characters);
});

test("an unsupported printable glyph has a visible box instead of empty text", () => {
  const font = { unitsPerEm: 1000, ascent: 1000, descent: 0, layout: () => ({ direction: "ltr",
    glyphs: [{ id: 45, codePoints: [0x1f600], path: { toSVG: () => "" }, bbox: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } }],
    positions: [{ xOffset: 0, yOffset: 0, xAdvance: 1000 }],
  }) };
  const shaped = shapeText("😀", { fontSize: 40 }, { resolve: () => ({ family: "Bitmap fixture", font }) });
  assert.equal(shaped.glyphs[0].missing, "😀");
  assert.ok(shaped.glyphs[0].path);
});

test("text stays measurable with a box until its next subset is available", () => {
  const fonts = new FontRegistry();
  fonts.register(bytes, { id: "latin", family: "Inter", weight: 400, style: "normal", src: source,
    subset: "latin", defaultSubset: "latin", unicodeRange: "U+0-7F" });
  const layer = createLayer("text", { id: "text", text: "Café", fontSource: source, textResize: "width-height", width: 200, height: 80 });
  const recovery = resizeTextLayer(layer, fonts);
  assert.equal(recovery.text, "Café");
  assert.notEqual(recovery.width, 200);
  assert.equal(shapeText("Café", recovery, fonts).glyphs.at(-1).missing, "é");
  assert.equal(layer.width, 200);
  fonts.register(bytes, { id: "extended", family: "Inter", weight: 400, style: "normal", src: source,
    subset: "extended", defaultSubset: "latin", unicodeRange: "U+80-FF" });
  const ready = resizeTextLayer(layer, fonts);
  assert.notEqual(ready.width, 200);
  assert.ok(shapeText("Café", ready, fonts).glyphs.every((glyph) => !glyph.missing));
});
