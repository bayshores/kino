import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { glyphPath, layoutText, resizeTextLayer, shapeText, textUnits } from "./textLayout.js";
import { textSourceMap } from "./textSource.js";
import { renderSceneSvg } from "./render.js";
import { evaluateLayer } from "./animation.js";
import { textStringPlan } from "./textChangeDraw.js";
import { applyComponentOverride } from "./componentOverrides.js";
import { documentFontReferences } from "./fontDocuments.js";
import { missingDocumentFonts } from "./fontRecovery.js";
import { prepareFontPatches } from "../backend/font-selection.mjs";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { exportScene } from "../backend/export.mjs";
import { applyOperations } from "./operations.js";
import { documentMediaIds } from "../backend/media-use.mjs";
import { copyLayers } from "./layerClipboard.js";

const fonts = await loadBundledFonts();
const text = (properties = {}) => createLayer("text", { id: "text", text: "Yo", fontSize: 40,
  x: 100, width: 100, height: 48, textResize: "width-height", textAlign: "center",
  fill: "#204080", ...properties });
const doc = (layer) => parseDocument(createDocument({ id: "rich", scenes: [createScene({ id: "scene", layers: [layer] })] }));

test("Yo keeps one center while only Y uses a bold face and another paint", () => {
  const layer = text({ fontSource: "/api/fonts/Inter-400.ttf",
    textStyleRanges: [{ start: 0, end: 1, style: { fontWeight: 700, fill: "#dd2200" } }] });
  const layout = layoutText(layer, fonts), line = layout.lines[0];
  assert.equal(line.glyphs[0].path, shapeText("Y", { ...layer, fontWeight: 700, fontSource: "" }, fonts).glyphs[0].path);
  assert.equal(line.glyphs[1].path, shapeText("o", layer, fonts).glyphs[0].path);
  assert.equal(line.width, shapeText("Y", { ...layer, fontWeight: 700, fontSource: "" }, fonts).width + shapeText("o", layer, fonts).width);
  const resized = resizeTextLayer(layer, fonts);
  assert.equal(resized.x + resized.width / 2, 150);
  const svg = renderSceneSvg(createScene({ layers: [resized] }), 0, { fonts, design: true });
  assert.match(svg, /#dd2200/); assert.match(svg, /#204080/);
  assert.equal(textUnits(layout, "letters").length, 2);
});

test("raw ranges survive NFC, CRLF and length-changing uppercase", () => {
  const layer = text({ text: "Aße\u0301\r\nYo", textCase: "upper",
    textStyleRanges: [{ start: 1, end: 2, style: { fontWeight: 700 } }, { start: 2, end: 4, style: { fontSize: 64 } }] });
  const source = textSourceMap(layer);
  assert.equal(source.text, "ASSÉ\nYO");
  assert.deepEqual(source.boundaries, [0, 1, 2, 4, 6, 7, 8]);
  assert.deepEqual(source.displayOffsets, [0, 1, 3, 4, 5, 6, 7]);
  const layout = layoutText(layer, fonts);
  assert.equal(layout.lines[0].fontSize, 64);
  assert.equal(layout.lines[1].fontSize, 40);
});

test("wrapped runs retain global style offsets and tallest-run line boxes", () => {
  const layer = text({ text: "aa BBB cc", width: 120, textResize: "height", textAlign: "left", fontSize: 20,
    textStyleRanges: [{ start: 3, end: 6, style: { fontSize: 60, fontFamily: "Montserrat", fill: "#008800" } }] });
  const layout = layoutText(layer, fonts);
  assert.ok(layout.lines.length >= 3);
  assert.equal(layout.naturalHeight, layout.lines.reduce((sum, line) => sum + line.fontSize * layer.lineHeight, 0));
  for (const line of layout.lines) for (const glyph of line.glyphs) {
    const offset = line.start + glyph.start;
    assert.equal(glyph.fill ?? layer.fill, offset >= 3 && offset < 6 ? "#008800" : layer.fill);
  }
  assert.equal(textUnits(layout, "letters").flatMap((unit) => unit.glyphs).length, layout.lines.flatMap((line) => line.glyphs).length);
});

test("range paint and tracking follow current-initial animations from their own styles", () => {
  const layer = text({ textStyleRanges: [{ start: 0, end: 1, style: { fill: "#ff0000", letterSpacing: 20 } }],
    animations: [{ id: "color", kind: "custom", start: 0, duration: 1, easing: "linear", fromCurrent: true,
      from: {}, to: { fill: "#00ff00", letterSpacing: 40 } }] });
  const state = evaluateLayer(layer, 0.5, { fonts });
  assert.equal(state.textStyleRanges[0].style.fill, "#808000");
  assert.equal(state.textStyleRanges[0].style.letterSpacing, 30);
  assert.equal(state.letterSpacing, 20);
  assert.equal(layer.textStyleRanges[0].style.fill, "#ff0000");
  assert.equal(layoutText(state, fonts).lines[0].glyphs[0].fill, "#808000");
});

test("converging animated paints preserve glyph boundaries and tracking can overshoot", () => {
  const layer = text({ text: "fi", textStyleRanges: [
    { start: 0, end: 1, style: { fill: "#ff0000", letterSpacing: 10_000_000 } },
    { start: 1, end: 2, style: { fill: "#0000ff" } },
  ], animations: [{ id: "color", kind: "custom", start: 0, duration: 1, easing: "linear", fromCurrent: true,
    from: {}, to: { fill: "#00ff00" } }] });
  const end = evaluateLayer(layer, 1, { fonts });
  assert.equal(layoutText(layer, fonts).lines[0].glyphs.length, 2);
  assert.equal(layoutText(end, fonts).lines[0].glyphs.length, 2);
  end.textStyleRanges[0].style.letterSpacing = 12_000_000;
  assert.ok(Number.isFinite(layoutText(end, fonts).naturalWidth));
});

test("a color entrance ends each styled range on its own fill, and an unstyled letter on the layer fill", () => {
  const layer = text({ text: "Yo", textStyleRanges: [{ start: 0, end: 1, style: { fill: "#00aa00" } }],
    animations: [{ id: "enter", kind: "in", start: 0, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#204080" } }] });
  const end = evaluateLayer(layer, 1, { fonts });
  assert.equal(end.textStyleRanges[0].style.fill, "#00aa00");
  assert.equal(end.fill, "#204080");
  assert.equal(evaluateLayer(layer, 0, { fonts }).textStyleRanges[0].style.fill, "#ff0000");
});

test("a range rotation and baseline shift move one letter's drawing, never the spacing", () => {
  const plain = layoutText(text({ text: "Yo" }), fonts);
  const turned = layoutText(text({ text: "Yo", textStyleRanges: [{ start: 1, end: 2, style: { rotation: 20, baselineShift: 10 } }] }), fonts);
  assert.equal(turned.lines[0].width, plain.lines[0].width);
  assert.equal(glyphPath(turned.lines[0].glyphs[0]), glyphPath(plain.lines[0].glyphs[0]), "the other letter is untouched");
  assert.notEqual(glyphPath(turned.lines[0].glyphs[1]), glyphPath(plain.lines[0].glyphs[1]));
  assert.throws(() => doc(text({ textStyleRanges: [{ start: 0, end: 1, style: { rotation: 400 } }] })), /rotation/);
});

test("jitter is fixed per seed, differs between seeds, keeps the spacing and is refused off text", () => {
  const paths = (jitter) => layoutText(text({ text: "Yo hand", width: 400, jitter }), fonts).lines[0].glyphs.map(glyphPath);
  const plain = layoutText(text({ text: "Yo hand", width: 400 }), fonts);
  const first = paths({ seed: 1 });
  assert.deepEqual(first, paths({ seed: 1 }), "the same seed gives the same letters");
  assert.notDeepEqual(first, paths({ seed: 2 }));
  assert.notDeepEqual(first, plain.lines[0].glyphs.map(glyphPath));
  assert.equal(layoutText(text({ text: "Yo hand", width: 400, jitter: true }), fonts).lines[0].width, plain.lines[0].width);
  assert.throws(() => parseDocument(createDocument({ id: "j", scenes: [createScene({ id: "s", layers: [createLayer("rectangle", { id: "r", jitter: true })] })] })), /jitter/);
});

test("changed strings use base styles while identical component text retains ranges", () => {
  const layer = text({ textStyleRanges: [{ start: 0, end: 1, style: { fontWeight: 700 } }] });
  assert.equal(textStringPlan(layer, { text: "New" }, fonts).textLayer.textStyleRanges, undefined);
  assert.deepEqual(applyComponentOverride(layer, { text: "Yo" }).textStyleRanges, layer.textStyleRanges);
  assert.equal(applyComponentOverride(layer, { text: "New" }).textStyleRanges, undefined);
  const next = applyOperations(doc(layer), [{ type: "update_layer", sceneId: "scene", layerId: "text", properties: { text: "New" } }], { fonts });
  assert.equal(next.scenes[0].layers[0].textStyleRanges?.length ?? 0, 0);
});

test("range operations validate grapheme offsets, first substring and locks", () => {
  const source = doc(text({ text: "Yo Yo" }));
  const next = applyOperations(source, [{ type: "style_text_range", sceneId: "scene", layerId: "text", text: "Yo", style: { fontWeight: 700 } }], { fonts });
  assert.deepEqual(next.scenes[0].layers[0].textStyleRanges, [{ start: 0, end: 2, style: { fontWeight: 700 } }]);
  assert.equal(source.scenes[0].layers[0].textStyleRanges, undefined);
  assert.throws(() => applyOperations(doc(text({ text: "e\u0301" })), [{ type: "style_text_range", sceneId: "scene", layerId: "text", start: 0, end: 1, style: { fontWeight: 700 } }], { fonts }), /grapheme/);
  assert.throws(() => applyOperations(doc(text({ locked: true })), [{ type: "style_text_range", sceneId: "scene", layerId: "text", start: 0, end: 1, style: { fontWeight: 700 } }], { fonts }), /Unlock/);
});

test("range fonts participate in loading, missing-font recovery, clipboard and share media", async () => {
  const source = doc(text({ textStyleRanges: [{ start: 0, end: 1, style: { fontFamily: "Missing range", fontSource: "/api/media/11111111-1111-4111-8111-111111111111.ttf", fontWeight: 700 } }] }));
  const refs = documentFontReferences(source);
  assert.equal(refs.find((ref) => ref.fontFamily === "Missing range").text, "Y");
  assert.equal(refs.find((ref) => ref.fontFamily === "Inter").text, "o");
  const missing = missingDocumentFonts(source, fonts);
  assert.equal(missing.length, 1); assert.deepEqual(missing[0].locations[0].textRange, { start: 0, end: 1 });
  const clip = copyLayers(source, "scene", ["text"]);
  assert.ok(clip.fonts.some((font) => font.family === "Missing range"));
  assert.ok(clip.media.some((media) => media.type === "font"));
  assert.ok(documentMediaIds(source).has("11111111-1111-4111-8111-111111111111.ttf"));
  const [{ fontSource }] = await prepareFontPatches([{ ...source.scenes[0].layers[0], fontFamily: "Missing range" }], { family: "Montserrat", weight: 700 },
    { fonts, catalog: { list: async () => ({ families: [] }), loadInto: async () => {} } });
  const fixed = applyOperations(source, [{ type: "style_text_range", sceneId: "scene", layerId: "text", start: 0, end: 1,
    style: { fontFamily: "Montserrat", fontSource } }], { fonts });
  assert.equal(fixed.scenes[0].layers[0].fontFamily, "Inter");
  assert.equal(fixed.scenes[0].layers[0].textStyleRanges[0].style.fontFamily, "Montserrat");
  assert.equal(missingDocumentFonts(fixed, fonts).length, 0);
});

test("PNG and Lottie export both per-glyph range paints", async () => {
  const scene = createScene({ width: 300, height: 160, layers: [text({ y: 30,
    textStyleRanges: [{ start: 0, end: 1, style: { fill: "#ff0000", fontWeight: 700 } }] })] });
  const png = await exportScene(scene, { format: "png" }, { fonts });
  assert.ok(png.buffer.length > 1000);
  const result = await exportScene(scene, { format: "lottie" }, { fonts });
  const json = JSON.parse(result.buffer.toString());
  const fills = [];
  const visit = (value) => { if (!value || typeof value !== "object") return;
    if (value.ty === "fl") fills.push(value.c.k); for (const child of Object.values(value)) visit(child); };
  visit(json);
  assert.ok(fills.some((fill) => Array.isArray(fill) && fill[0] === 1 && fill[1] === 0 && fill[2] === 0));
  assert.ok(fills.some((fill) => Array.isArray(fill) && Math.abs(fill[0] - 32 / 255) < 0.0001));
});
