// Text drawing that render.js remembers between frames (textSvgCache.js, and the glyph outlines
// in textLayout.js) must draw exactly what working everything out again would draw.
//
// Each check plays a scene three times through some times, so the later passes draw from what
// the earlier ones remembered, and compares every frame with a drawing that remembers nothing
// yet: one made with a fresh copy of the font registry, which has never laid out any text.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { createColorFontFixture } from "../tests/color-font.mjs";
import { FontRegistry } from "./fonts.js";
import { createLayer, createScene } from "./model.js";
import { createCatalogAnimation } from "./presetCatalog.js";
import { renderSceneSvg } from "./render.js";
import { glyphPath, glyphPathBounds, layoutText } from "./textLayout.js";
import { pathBounds } from "./vectorPath.js";
import { plainPaintKey, rememberForLayout } from "./textSvgCache.js";

const bundled = await loadBundledFonts();
const gradient = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#2f6fdf" }, { offset: 1, color: "#e2553f" }] };

// The same faces in a registry that has never laid out text, so nothing is remembered for it.
function freshCopy(fonts) {
  const copy = new FontRegistry();
  copy.replace(fonts);
  return copy;
}

const text = (id, value, properties = {}) => createLayer("text", { id, name: id, text: value, fill: "#111827",
  fontSize: 32, textResize: "width-height", ...properties });
const custom = (id, from, to) => ({ id, name: id, kind: "custom", start: 0, duration: 1, easing: "linear", from, to });
const preset = (presetId, layer, id, fields, fonts = bundled) => ({ ...createCatalogAnimation(presetId, layer, 0, { fonts }, id), ...fields });
const sceneOf = (layers) => createScene({ id: "scene", width: 640, height: 360, duration: 2, layers });

// The dashboard preview, the editor canvas, an export frame and a plain drawing.
const drawings = [{}, { canvas: true, idPrefix: "preview-1" }, { design: true, canvas: true }, { raster: true, rasterScale: { x: 0.75, y: 0.75 } }];

function assertSameAsFresh(scene, fonts, times) {
  for (const options of drawings) {
    for (let pass = 1; pass <= 3; pass++) {
      for (const time of times) {
        const remembered = renderSceneSvg(scene, time, { ...options, fonts });
        const fresh = renderSceneSvg(scene, time, { ...options, fonts: freshCopy(fonts) });
        assert.equal(remembered, fresh, `${JSON.stringify(options)}, pass ${pass}, ${time} s`);
      }
    }
  }
}

// Every url(#id) the drawing uses is defined once, so remembered markup never points at a
// gradient, clip or mask from another frame.
function assertReferencesDefined(svg) {
  const defined = [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(defined).size, defined.length, "no id is defined twice");
  for (const [, id] of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(defined.includes(id), `#${id} is defined`);
}

const times = [0, 0.13, 0.4, 0.75, 1.2];

test("static text draws the same from memory as fresh", () => {
  const twin = text("twin-a", "Same words", { x: 20, y: 300 });
  const scene = sceneOf([
    text("plain", "Static title", { x: 20, y: 20 }),
    text("wrapped", "A fixed box wraps long text onto more lines", { x: 20, y: 70, width: 220, height: 120, textResize: "height", lineHeight: 1.4 }),
    text("center-stroke", "Outlined", { x: 300, y: 20, stroke: "#e2553f", strokeWidth: 2 }),
    text("inside-stroke", "Inside", { x: 300, y: 70, stroke: "#2f6fdf", strokeWidth: 3, strokeAlign: "inside" }),
    text("outside-stroke", "Outside", { x: 300, y: 120, stroke: "#3aa675", strokeWidth: 3, strokeAlign: "outside" }),
    text("no-fill", "Stroke only", { x: 300, y: 170, fillEnabled: false, stroke: "#111827", strokeWidth: 1 }),
    text("styled", "Two colors", { x: 300, y: 220, textStyleRanges: [{ start: 4, end: 10, style: { fill: "#e2553f" } }] }),
    text("effects", "Blur and shadow", { x: 20, y: 220, blur: 2, shadow: { x: 2, y: 3, blur: 4, color: "#00000080" } }),
    twin,
    { ...twin, id: "twin-b", name: "twin-b", y: 330 },
  ]);
  assertSameAsFresh(scene, bundled, times);
});

test("text animated by letters, words and lines, and text that changes, draws the same from memory as fresh", () => {
  const letters = text("letters", "Slide by letter", { x: 20, y: 20 });
  letters.animations = [preset("preset-slide", letters, "slide", { unit: "letters", stagger: 0.04, duration: 0.5 })];
  const words = text("words", "Mask reveal by word", { x: 20, y: 70 });
  words.animations = [preset("preset-mask", words, "mask", { unit: "words", stagger: 0.15 })];
  const lines = text("lines", "Grow line\nby line", { x: 20, y: 120 });
  lines.animations = [preset("preset-grow", lines, "grow", { unit: "lines", stagger: 0.1 })];
  const blur = text("blur", "Blur word by word", { x: 20, y: 220 });
  blur.animations = [preset("preset-blur", blur, "blur", { unit: "words", stagger: 0.2 })];
  const tracking = text("tracking", "Tracking", { x: 340, y: 20 });
  tracking.animations = [custom("tracking-spread", { letterSpacing: 0 }, { letterSpacing: 30 })];
  const size = text("size", "Size", { x: 340, y: 70 });
  size.animations = [custom("size-grow", { fontSize: 20 }, { fontSize: 44 })];
  const color = text("color", "Color", { x: 340, y: 140, stroke: "#111827", strokeWidth: 1 });
  color.animations = [custom("color-shift", { fill: "#2f6fdf" }, { fill: "#e2553f" })];
  const swap = text("swap", "Hello", { x: 340, y: 200 });
  swap.animations = [{
    id: "swap", name: "Change text", kind: "change-text", start: 0.2, text: "Goodbye", overlap: true,
    out: { preset: "fade-out", duration: 0.4, easing: "linear", unit: "letters", stagger: 0.03, order: "forward" },
    in: { preset: "slide-up", duration: 0.5, easing: "ease-out", unit: "words", stagger: 0.04, order: "reverse", distance: 40 },
  }];
  assertSameAsFresh(sceneOf([letters, words, lines, blur, tracking, size, color, swap]), bundled, times);
});

test("gradient text is drawn fresh with its own ids on every frame", () => {
  const still = text("still", "Gradient", { x: 20, y: 20, fill: gradient });
  const letters = text("letters", "Gradient letters", { x: 20, y: 80, fill: gradient });
  letters.animations = [preset("preset-slide", letters, "slide", { unit: "letters", stagger: 0.04, duration: 0.5 })];
  const range = text("range", "Some gradient words", { x: 20, y: 140, textStyleRanges: [{ start: 5, end: 13, style: { fill: gradient } }] });
  range.animations = [preset("preset-fade", range, "fade", { unit: "words", stagger: 0.1 })];
  const stroke = text("stroke", "Gradient stroke", { x: 20, y: 200, stroke: gradient, strokeWidth: 2 });
  const scene = sceneOf([still, letters, range, stroke]);
  assertSameAsFresh(scene, bundled, times);
  for (const time of times) assertReferencesDefined(renderSceneSvg(scene, time, { fonts: bundled, canvas: true, idPrefix: "preview-1" }));
});

for (const format of ["svg", "bitmap"]) {
  test(`${format} color glyphs (emoji) draw the same from memory as fresh`, async () => {
    const fixture = await createColorFontFixture({ format });
    const fonts = freshCopy(bundled);
    fonts.register(fixture.bytes, { ...fixture.metadata, id: "emoji-fixture" });
    const still = text("still", "x😀👍🏽y", { x: 20, y: 20, fontSize: 48 });
    const letters = text("letters", "A😀B👍🏽C", { x: 20, y: 120, fontSize: 48, stroke: "#e2553f", strokeWidth: 2 });
    letters.animations = [preset("preset-slide", letters, "slide", { unit: "letters", stagger: 0.05, duration: 0.5 }, fonts)];
    const scene = sceneOf([still, letters]);
    assertSameAsFresh(scene, fonts, times);
    assert.match(renderSceneSvg(scene, 1.2, { fonts }), /<image/);
  });
}

test("text with missing glyphs draws the same from memory as fresh", () => {
  const still = text("still", "x👩‍👦y中", { x: 20, y: 20 });
  const words = text("words", "missing 中 glyph", { x: 20, y: 120 });
  words.animations = [preset("preset-fade", words, "fade", { unit: "words", stagger: 0.1 })];
  const scene = sceneOf([still, words]);
  assertSameAsFresh(scene, bundled, times);
  assert.match(renderSceneSvg(scene, 1.2, { fonts: bundled }), /data-missing-glyphs="true"/);
});

test("after the font registry changes, text is drawn with the new fonts", async () => {
  const fonts = freshCopy(bundled);
  const still = text("still", "Font change x😀y", { x: 20, y: 20 });
  const letters = text("letters", "Letters change", { x: 20, y: 120 });
  letters.animations = [preset("preset-slide", letters, "slide", { unit: "letters", stagger: 0.04, duration: 0.5 })];
  const scene = sceneOf([still, letters]);
  const play = () => times.map((time) => renderSceneSvg(scene, time, { fonts, canvas: true }));
  play();
  const before = play();

  // Adding an emoji font draws the emoji that were missing.
  const fixture = await createColorFontFixture();
  fonts.register(fixture.bytes, { ...fixture.metadata, id: "emoji-fixture" });
  const withEmoji = play();
  assert.notDeepEqual(withEmoji, before);
  assertSameAsFresh(scene, fonts, times);

  // Replacing the Inter face the text uses with other outlines draws those outlines.
  const inter = fonts.faces.find((face) => face.family === "Inter" && face.weight === 400 && face.style === "normal");
  const montserrat = await readFile(new URL("../assets/fonts/Montserrat-400.woff2", import.meta.url));
  fonts.register(montserrat, { id: inter.id, family: "Inter", weight: 400, style: "normal" });
  const replaced = play();
  assert.notDeepEqual(replaced, withEmoji);
  assertSameAsFresh(scene, fonts, times);
});

test("a remembered glyph outline equals one worked out again", () => {
  const layout = layoutText(text("glyphs", "Glyph outlines"), bundled);
  for (const glyph of layout.lines[0].glyphs) {
    assert.equal(glyphPath(Object.freeze({ ...glyph })), glyphPath({ ...glyph }));
    // Bounds measured on the outline's contours equal those of its written path data.
    if (glyph.path) assert.deepEqual(glyphPathBounds({ ...glyph }), pathBounds(glyphPath({ ...glyph })));
  }
});

test("self-sizing text shares one layout whatever box size it is given", () => {
  const layer = { ...text("sizing", "Shared layout"), textResize: "width-height" };
  assert.equal(layoutText({ ...layer, width: 10, height: 10 }, bundled), layoutText({ ...layer, width: 999, height: 5 }, bundled));
  const autoHeight = { ...layer, textResize: "height", width: 120 };
  assert.equal(layoutText({ ...autoHeight, height: 10 }, bundled), layoutText({ ...autoHeight, height: 400 }, bundled));
  assert.notEqual(layoutText({ ...autoHeight, width: 60 }, bundled), layoutText(autoHeight, bundled), "the width still wraps auto-height text");
});

test("only plain paints are remembered: gradients and inside or outside strokes add <defs>", () => {
  const plain = { fill: "#111827", stroke: "#e2553f", strokeWidth: 2 };
  assert.equal(typeof plainPaintKey(plain, {}), "string");
  assert.notEqual(plainPaintKey(plain, {}), plainPaintKey(plain, { canvas: true }));
  assert.equal(plainPaintKey({ ...plain, fill: gradient }, {}), null);
  assert.equal(typeof plainPaintKey({ ...plain, fill: gradient, fillEnabled: false }, {}), "string", "a turned-off gradient draws nothing");
  assert.equal(plainPaintKey({ ...plain, stroke: gradient }, {}), null);
  assert.equal(typeof plainPaintKey({ ...plain, stroke: gradient, strokeWidth: 0 }, {}), "string", "a stroke of width 0 draws nothing");
  assert.equal(plainPaintKey({ ...plain, strokeAlign: "inside" }, {}), null);
  assert.equal(plainPaintKey({ ...plain, strokeAlign: "outside" }, {}), null);
});

test("what is remembered for a layout is shared in one drawing, kept once a second drawing uses it, and bounded", () => {
  const layout = {};
  let made = 0;
  const make = () => ++made;
  const first = {}, second = {}, third = {};
  assert.equal(rememberForLayout(layout, first, "a", make), 1);
  assert.equal(rememberForLayout(layout, first, "a", make), 1, "shared within one drawing");
  assert.equal(rememberForLayout(layout, second, "a", make), 2, "not kept after a single drawing");
  assert.equal(rememberForLayout(layout, third, "a", make), 2, "kept once a second drawing used it");
  for (let key = 0; key < 300; key++) rememberForLayout(layout, third, `key ${key}`, make);
  const count = made;
  rememberForLayout(layout, third, "a", make);
  assert.equal(made, count + 1, "a layout keeps at most 256 entries, then starts over");
});
