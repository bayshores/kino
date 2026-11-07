import test from "node:test";
import assert from "node:assert/strict";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { layoutText, shapeText, textUnits, resizeTextLayer, textGraphemes } from "./textLayout.js";
import { renderSceneSvg } from "./render.js";
import { Resvg } from "@resvg/resvg-js";

const fonts = await loadBundledFonts();
const text = (overrides = {}) => ({type: "text", id: "text", fontFamily: "Inter", fontSize: 36, fontWeight: 400, fontStyle: "normal", text: "AVATAR office ffi", width: 300, height: 44, textAlign: "center", verticalAlign: "middle", textResize: "width-height", lineHeight: 1.2, letterSpacing: 0, ...overrides});

test("Inter uses real advances, kerning, line metrics, and the measured reference box", () => {
  const layer = text({kerning: false});
  const layout = layoutText(layer, fonts);
  // This sample's 300x44 box and 35.096 baseline were measured from an outline export
  // using the same public Inter font.
  assert.equal(layout.naturalWidth, 299.8828125);
  assert.deepEqual([layout.width, layout.height], [300, 44]);
  assert.ok(Math.abs(layout.lines[0].y - 35.095703125) < 1e-9);
  assert.equal(shapeText(layer.text, {...layer, kerning: true}, fonts).width, 286.03125);
  assert.ok(shapeText("iiii", layer, fonts).width < shapeText("WWWW", layer, fonts).width / 2);
});

test("real font ligatures change glyphs while letter units preserve grapheme timing", () => {
  const layer = text({fontFamily: "Noto Serif", text: "office", kerning: true});
  const ligatures = shapeText(layer.text, {...layer, ligatures: true}, fonts);
  const separate = shapeText(layer.text, {...layer, ligatures: false}, fonts);
  assert.equal(ligatures.glyphs.length, 4);
  assert.equal(separate.glyphs.length, 6);
  assert.notEqual(ligatures.width, separate.width);
  const units = textUnits(layoutText({...layer, ligatures: true}, fonts), "letters");
  assert.equal(units.length, 6);
  assert.equal(units.flatMap((unit) => unit.glyphs).length, 4);
  assert.deepEqual(units.map((unit) => unit.text), [..."office"]);
});

test("a blank spacer a code font puts before its ligature is drawn, not missing", () => {
  // JetBrains Mono shapes "//" as [blank spacer, wide slash_slash]; Inter does it here the same way.
  const layer = text({text: "//", textResize: "width-height"});
  const font = fonts.resolve(layer).font;
  const layout = font.layout;
  font.layout = function (...args) {
    const run = layout.apply(this, args);
    if (args[0] === "//") run.glyphs[0] = this.glyphForCodePoint(32);
    return run;
  };
  try { assert.equal(shapeText("//", layer, fonts).glyphs.filter((glyph) => glyph.missing).length, 0); }
  finally { font.layout = layout; }
});

test("Montserrat's default specimen uses real family metrics and kerning pairs", () => {
  const layer = text({fontFamily: "Montserrat", text: "Text", kerning: false});
  const unkerned = layoutText(layer, fonts);
  assert.ok(Math.abs(unkerned.naturalWidth - 76.248) < 1e-9);
  assert.deepEqual([unkerned.width, unkerned.height], [77, 44]);
  const kerned = layoutText({...layer, kerning: true}, fonts);
  assert.ok(Math.abs(kerned.naturalWidth - 73.728) < 1e-9);
  assert.deepEqual([kerned.width, kerned.height], [74, 44]);
});

test("wrapping, case, vertical alignment, and fluid sizing use the shaped lines", () => {
  const layer = text({text: "One two three", textResize: "height", width: 100, textAlign: "left"});
  const layout = layoutText(layer, fonts);
  assert.deepEqual(layout.lines.map((line) => line.text), ["One", "two", "three"]);
  assert.equal(layout.height, 130);
  assert.equal(resizeTextLayer(layer, fonts).height, 130);
  const upper = layoutText({...layer, textResize: "width-height", textCase: "upper"}, fonts);
  assert.equal(upper.text, "ONE TWO THREE");
  assert.ok(upper.width > layout.naturalWidth);
  const top = layoutText({...layer, textResize: "fixed", height: 200, verticalAlign: "top"}, fonts);
  const bottom = layoutText({...layer, textResize: "fixed", height: 200, verticalAlign: "bottom"}, fonts);
  assert.ok(Math.abs(bottom.lines[0].y - top.lines[0].y - (200 - top.naturalHeight)) < 1e-9);
});

test("fluid edits and animated sizing preserve the real alignment anchor", () => {
  const initial = text({x: 170, y: 158});
  const changed = resizeTextLayer({...initial, fontSize: 60}, fonts);
  assert.equal(changed.x + changed.width / 2, 320);
  assert.equal(changed.y + changed.height / 2, 180);
  const wrapped = resizeTextLayer({...initial, textResize: "height", width: 100, text: "One two three"}, fonts);
  assert.equal(wrapped.x, initial.x);
  assert.equal(wrapped.y + wrapped.height / 2, 180);
});

test("grapheme units keep combining sequences intact and unavailable glyphs are explicit", () => {
  assert.deepEqual(textGraphemes("e\u0301🙂").map((part) => part.text), ["e\u0301", "🙂"]);
  const units = textUnits(layoutText(text({text: "e\u0301A"}), fonts), "letters");
  assert.equal(units.length, 2);
  assert.ok(units[0].glyphs.length > 0);
  assert.equal(shapeText("中", text(), fonts).glyphs[0].missing, "中");
  const missingFamily = text({fontFamily: "Missing Font"});
  assert.throws(() => fonts.resolve(missingFamily), /unavailable.*Import/);
  assert.deepEqual(layoutText(missingFamily, fonts), layoutText(text(), fonts));
  const missingSource = text({fontSource: "/api/media/00000000-0000-4000-8000-000000000000.ttf"});
  assert.throws(() => fonts.resolve(missingSource), /linked font.*unavailable/);
  assert.deepEqual(layoutText(missingSource, fonts), layoutText(text(), fonts));
});

test("cached canonical and nonbreaking-space glyph aliases keep following letter units", () => {
  shapeText("é ", text(), fonts);
  const units = textUnits(layoutText(text({text: "e\u0301A\u00a0B "}), fonts), "letters");
  assert.equal(units.length, 5);
  assert.equal(units.find((unit) => unit.text === "A").glyphs.length, 1);
  assert.equal(units.find((unit) => unit.text === "B").glyphs.length, 1);
  assert.equal(units.flatMap((unit) => unit.glyphs).filter((glyph) => glyph.path).length, 3);
});

test("SVG text is self-contained outlined geometry even with system fonts disabled", () => {
  const layer = text({x: 0, y: 0, kerning: true, fill: "#000000", opacity: 1, scaleX: 1, scaleY: 1, animations: []});
  const svg = renderSceneSvg({width: 320, height: 80, background: "transparent", layers: [layer]}, 0, {fonts});
  assert.doesNotMatch(svg, /<text|font-family|@font-face/);
  assert.match(svg, /aria-label="AVATAR office ffi"/);
  const image = new Resvg(svg, {font: {loadSystemFonts: false}}).render();
  assert.ok(image.pixels.some((value, index) => index % 4 === 3 && value > 0));
});
