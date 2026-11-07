import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { createColorFontFixture } from "../tests/color-font.mjs";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { colorGlyph } from "./colorGlyphs.js";
import { createDocument, createLayer, createScene } from "./model.js";
import { layoutText, shapeText, textUnits, resizeTextLayer } from "./textLayout.js";
import { renderSceneSvg } from "./render.js";
import { copyLayers } from "./layerClipboard.js";
import { documentGlyphProblems, fallbackFontRequests, layerFallbackFontReferences } from "./fontGlyphReferences.js";

const text = (values = {}) => createLayer("text", { id: "text", text: "x😀y", x: 12, y: 12,
  fontFamily: "Inter", fontSize: 72, fill: "#000000", textResize: "width-height", width: 300, height: 90, ...values });
const documentFor = (layer) => createDocument({ id: "color-doc", scenes: [createScene({ id: "scene", width: 420, height: 180,
  background: "transparent", layers: [layer] })] });
async function registry(options) {
  const fixture = await createColorFontFixture(options), fonts = await loadBundledFonts();
  fonts.register(fixture.bytes, { ...fixture.metadata, id: "emoji-fixture" });
  return { fonts, fixture };
}
function coloredPixels(image) {
  let red = 0, blue = 0, green = 0, dark = 0;
  const rgba = image.pixels;
  for (let at = 0; at < rgba.length; at += 4) {
    const [r, g, b, a] = rgba.subarray(at, at + 4);
    if (a < 200) continue;
    if (r > 170 && g < 100 && b < 100) red++;
    if (b > 130 && b > r * 1.5 && b > g * 1.5) blue++;
    if (g > 100 && g > r * 1.5 && g > b * 1.5) green++;
    if (r < 60 && g < 60 && b < 60) dark++;
  }
  return { red, blue, green, dark };
}

for (const options of [{ format: "svg" }, { format: "svg", gzip: true }, { format: "bitmap" }]) {
  test(`${options.format}${options.gzip ? " gzip" : ""} emoji retain actual RGB colors beside outlined text`, async () => {
    const { fonts } = await registry(options), layer = text({ text: "x😀👍🏽y" });
    const runs = fonts.textRuns(layer.text, layer);
    assert.deepEqual(runs.map((run) => run.text), ["x", "😀👍🏽", "y"]);
    assert.equal(runs[1].face.fallbackFor, "Inter");
    const layout = layoutText(layer, fonts);
    assert.ok(layout.lines[0].glyphs.every((glyph) => !glyph.missing));
    assert.equal(layout.lines[0].glyphs.filter((glyph) => glyph.color).length, 3);
    const scene = documentFor(layer).scenes[0], svg = renderSceneSvg(scene, 0, { fonts });
    assert.match(svg, /<image/);
    assert.match(svg, /aria-label="x😀👍🏽y"/);
    const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    const pixels = coloredPixels(image);
    for (const channel of ["red", "blue", "green", "dark"]) assert.ok(pixels[channel] > 40, `${channel}: ${pixels[channel]}`);
    const anotherFill = renderSceneSvg({ ...scene, layers: [{ ...layer, fill: "#f600ff", stroke: "#f600ff", strokeWidth: 3 }] }, 0, { fonts });
    const newPixels = coloredPixels(new Resvg(anotherFill).render());
    for (const channel of ["red", "blue", "green"]) assert.equal(newPixels[channel], pixels[channel], "emoji ignore text paint and stroke");
  });
}

test("emoji sequences stay one animation/caret unit and tracking is outside each cluster", async () => {
  const { fonts } = await registry();
  const sequences = ["👩‍👦", "🇺🇸", "👍🏽"];
  for (const sequence of sequences) {
    const layer = text({ text: sequence, letterSpacing: 20 });
    const layout = layoutText(layer, fonts), units = textUnits(layout, "letters");
    assert.equal(units.length, 1, sequence);
    assert.equal(units[0].text, sequence);
    assert.ok(units[0].glyphs.every((glyph) => !glyph.missing), sequence);
    assert.equal(layout.naturalWidth, layoutText({ ...layer, letterSpacing: 0 }, fonts).naturalWidth,
      "tracking does not separate the pieces of one emoji");
  }
});

test("offline fallback boxes only unsupported graphemes and keeps neighboring scene content", async () => {
  const fonts = await loadBundledFonts(), layer = text({ text: "x👩‍👦y中" });
  const document = documentFor(layer), shaped = shapeText(layer.text, layer, fonts);
  assert.deepEqual(shaped.glyphs.filter((glyph) => glyph.missing).map((glyph) => glyph.missing), ["👩‍👦", "中"]);
  assert.ok(shaped.glyphs[0].path && shaped.glyphs[2].path);
  const svg = renderSceneSvg(document.scenes[0], 0, { fonts });
  assert.match(svg, /data-missing-glyphs="true"/);
  assert.ok(coloredPixels(new Resvg(svg).render()).dark > 200);
  assert.deepEqual(documentGlyphProblems(document, fonts)[0].glyphs.map((entry) => entry.text), ["👩‍👦", "中"]);
  const requests = fallbackFontRequests(document, fonts);
  assert.deepEqual(requests.map((request) => request.candidates[0]), ["noto-color-emoji", "noto-sans-sc"]);
  assert.ok(requests.every((request) => !request.text.includes("x") && !request.text.includes("y")), "requests omit surrounding text");
});

test("cached public fallback dependencies travel with copies and ignore unrelated uploaded fonts", async () => {
  const { fonts, fixture } = await registry(), layer = text(), document = documentFor(layer);
  const expected = { fontFamily: fixture.metadata.family, fontSource: fixture.metadata.src, fontWeight: 400, fontStyle: "normal" };
  assert.deepEqual(layerFallbackFontReferences(layer, fonts), [expected]);
  const envelope = copyLayers(document, "scene", ["text"], { fonts });
  assert.ok(envelope.fonts.some((font) => font.src === fixture.metadata.src));
  const isolated = await loadBundledFonts();
  isolated.register(fixture.bytes, { ...fixture.metadata, src: "/api/media/00000000-0000-4000-8000-000000000000.ttf", id: "private-other-project" });
  assert.equal(isolated.textRuns("😀", layer)[0].face.missingGlyph, true);
  assert.deepEqual(layerFallbackFontReferences(layer, isolated), []);
});

test("fallback metrics enlarge the line box while preserving fluid alignment anchors", async () => {
  const { fonts } = await registry(), layer = text({ text: "x😀", lineHeight: 0.7, textAlign: "center", verticalAlign: "middle" });
  const layout = layoutText(layer, fonts), line = layout.lines[0];
  assert.ok(line.lineHeight >= line.ascent + line.descent);
  const resized = resizeTextLayer(layer, fonts);
  assert.equal(resized.x + resized.width / 2, layer.x + layer.width / 2);
  assert.equal(resized.y + resized.height / 2, layer.y + layer.height / 2);
});

test("unsafe SVG glyphs refuse color output and fall back to a box without hiding the layer", async () => {
  const { fonts, fixture } = await registry({ svgOverride: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
  const face = fonts.faces.find((entry) => entry.id === "emoji-fixture");
  assert.equal(colorGlyph(face, face.font.getGlyph(fixture.glyphIds.smilingFace), 72).kind, "unsupported");
  const shaped = shapeText("x😀y", text(), fonts);
  assert.deepEqual(shaped.glyphs.filter((glyph) => glyph.missing).map((glyph) => glyph.missing), ["😀"]);
  assert.ok(shaped.glyphs[0].path && shaped.glyphs.at(-1).path);
});

test("a contextual missing glyph replaces its cluster while retaining valid contextual neighbors", () => {
  const font = { unitsPerEm: 1000, ascent: 800, descent: -200, layout: () => ({ direction: "ltr",
    glyphs: [1, 0, 2].map((id, index) => ({ id, codePoints: ["abc".codePointAt(index)],
      path: { toSVG: () => "M0 0L300 0L300 700L0 700Z" }, bbox: { minX: 0, minY: 0, maxX: 300, maxY: 700 } })),
    positions: [0, 1, 2].map(() => ({ xOffset: 0, yOffset: 0, xAdvance: 400 })),
  }) };
  const shaped = shapeText("abc", { fontSize: 100 }, { resolve: () => ({ family: "Broken context", font }) });
  assert.deepEqual(shaped.glyphs.map((glyph) => glyph.missing ?? glyph.id), [1, "b", 2]);
  assert.deepEqual(shaped.glyphs.map((glyph) => glyph.x), [0, 40, 120]);
  assert.equal(shaped.width, 160);
});

test("vector color glyphs reuse one result across font sizes", async () => {
  const { fonts, fixture } = await registry();
  const face = fonts.faces.find((entry) => entry.id === "emoji-fixture");
  const glyph = face.font.getGlyph(fixture.glyphIds.smilingFace);
  const first = colorGlyph(face, glyph, 12);
  assert.equal(first.kind, "image");
  for (const size of [24, 72, 128, 512, 2048]) assert.strictEqual(colorGlyph(face, glyph, size), first);
});

test("a dishonest gzip size is refused without rendering a partial glyph", async () => {
  const fixture = await createColorFontFixture({ gzip: true });
  const data = new DataView(fixture.bytes.buffer, fixture.bytes.byteOffset, fixture.bytes.byteLength);
  let svgAt;
  for (let index = 0; index < data.getUint16(4); index++) {
    const at = 12 + index * 16;
    if (String.fromCharCode(...fixture.bytes.subarray(at, at + 4)) === "SVG ") svgAt = data.getUint32(at + 8);
  }
  assert.ok(svgAt);
  const indexAt = svgAt + data.getUint32(svgAt + 2);
  const documentAt = indexAt + data.getUint32(indexAt + 6);
  const documentLength = data.getUint32(indexAt + 10);
  data.setUint32(documentAt + documentLength - 4, 1, true);
  const fonts = await loadBundledFonts();
  fonts.register(fixture.bytes, { ...fixture.metadata, id: "dishonest-gzip" });
  const face = fonts.faces.find((entry) => entry.id === "dishonest-gzip");
  const result = colorGlyph(face, face.font.getGlyph(fixture.glyphIds.smilingFace), 72);
  assert.equal(result.kind, "unsupported");
  assert.match(result.message, /invalid length/);
});

test("spaces in an explicitly selected emoji-only face remain blank advances", async () => {
  const { fonts, fixture } = await registry();
  const layer = text({ text: "😀 😀", fontFamily: fixture.metadata.family, fontSource: fixture.metadata.src });
  const layout = layoutText(layer, fonts), glyphs = layout.lines[0].glyphs;
  assert.equal(glyphs.filter((glyph) => glyph.color).length, 2);
  assert.ok(glyphs.every((glyph) => !glyph.missing));
  const space = glyphs.find((glyph) => glyph.start === 2);
  assert.ok(space.advance > 0);
  assert.equal(space.path, "");
  assert.ok(!space.color);
  assert.deepEqual(documentGlyphProblems(documentFor(layer), fonts), []);
});
