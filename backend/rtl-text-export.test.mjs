import assert from "node:assert/strict";
import test from "node:test";
import { createCounter } from "../engine/counter.js";
import { createLayer, createScene } from "../engine/model.js";
import { layoutText, textGraphemes, textUnits } from "../engine/textLayout.js";
import { bidiTextLine, prepareTextBidi } from "../engine/textBidi.js";
import { exportScene } from "./export.mjs";
import { loadRtlTestFonts } from "../tests/rtl-fonts.mjs";
import { readImage } from "./media.test.support.mjs";

const fonts = await loadRtlTestFonts();
const WIDTH = 420;
const HEIGHT = 300;
const FPS = 12;
const DURATION = 2;
const BACKGROUND = "#f4f1eb";

function textLayer(id, name, text, overrides = {}) {
  return createLayer("text", {
    id, name, x: 24, y: 36, width: 372, height: 84, text,
    fontFamily: "Inter", fontWeight: 400, fontStyle: "normal", fontSize: 32,
    textResize: "fixed", textAlign: "left", verticalAlign: "middle", fill: "#263b59", strokeWidth: 0,
    ...overrides,
  });
}

function scene(layers, overrides = {}) {
  return createScene({
    id: "rtl-export-scene", name: "RTL text export", width: WIDTH, height: HEIGHT,
    duration: DURATION, background: BACKGROUND, layers, ...overrides,
  });
}

const custom = (id, unit, stagger) => ({
  id, name: id, kind: "custom", start: 0.08, duration: 1.3, easing: "linear",
  from: { opacity: 0 }, to: { opacity: 1 }, unit, stagger,
  textAnchor: unit, order: "forward",
});

async function lottie(input) {
  const result = await exportScene(input, { format: "lottie", width: WIDTH, height: HEIGHT, fps: FPS, duration: input.duration }, { fonts });
  return { result, animation: JSON.parse(result.buffer.toString("utf8")) };
}

function staticValue(property) {
  assert.equal(property?.a, 0, "expected a static Lottie property");
  return property.k;
}

function vectorLayers(animation, name) {
  return animation.layers.filter((layer) => layer.ty === 4 && layer.nm.startsWith(`${name} `));
}

function assertLayerPosition(layer, x, y) {
  assert.deepEqual(staticValue(layer.ks.p), [x, y, 0], `${layer.nm} keeps its layer position`);
}

function scalarBoundaries(text) {
  const boundaries = new Set([0]);
  let offset = 0;
  for (const character of text) {
    offset += character.length;
    boundaries.add(offset);
  }
  return boundaries;
}

function assertSourceSpans(layer, layout) {
  const boundaries = scalarBoundaries(layer.text);
  let glyphCount = 0;
  for (const line of layout.lines) for (const glyph of line.glyphs) {
    const start = line.start + glyph.start;
    const end = line.start + glyph.end;
    assert.ok(boundaries.has(start), `${JSON.stringify(layer.text.slice(start, end))} begins on a source scalar boundary`);
    assert.ok(boundaries.has(end), `${JSON.stringify(layer.text.slice(start, end))} ends on a source scalar boundary`);
    assert.ok(start <= end && end <= layer.text.length, "glyph source spans remain in the logical UTF-16 string");
    const owner = textGraphemes(line.text).findIndex((part) => part.start <= glyph.start && glyph.start < part.end);
    assert.notEqual(owner, -1, "each glyph starts inside one source grapheme");
    assert.equal(glyph.cluster, owner, "the shaping cluster owns the glyph's source scalar span");
    glyphCount += 1;
  }
  assert.ok(glyphCount > 0, `${layer.name} shapes real glyphs`);
}

function assertMarkedGraphemesStayInLetterUnits(layer, layout) {
  const units = textUnits(layout, "letters");
  const marked = textGraphemes(layer.text).filter((part) => /\p{M}/u.test(part.text));
  assert.ok(marked.length > 0, "the Arabic sample contains combining-mark graphemes");
  for (const part of marked) {
    const unit = units.find((item) => item.sourceStart === part.start && item.sourceEnd === part.end);
    assert.ok(unit, `${JSON.stringify(part.text)} remains one logical letter unit`);
    assert.equal(unit.text, part.text);
    const line = layout.lines.find((item) => item.start <= part.start && item.start + item.text.length >= part.end);
    const localStart = part.start - line.start;
    const cluster = textGraphemes(line.text).findIndex((item) => item.start === localStart);
    const key = (glyph) => `${glyph.id}:${glyph.start}:${glyph.end}`;
    const expected = line.glyphs.filter((glyph) => glyph.cluster === cluster).map(key).sort();
    assert.deepEqual(unit.glyphs.map(key).sort(), expected,
      `${JSON.stringify(part.text)} keeps every base and mark glyph in one letter unit`);
    if (part.text === "مُ")
      assert.deepEqual(new Set(unit.glyphs.map((glyph) => glyph.id)), new Set([74, 345]),
        "the base Meem and Damma remain together in the مُ grapheme");
  }
}

function allValues(value, predicate, output = []) {
  if (Array.isArray(value)) value.forEach((item) => allValues(item, predicate, output));
  else if (value && typeof value === "object") {
    if (predicate(value)) output.push(value);
    Object.values(value).forEach((item) => allValues(item, predicate, output));
  }
  return output;
}

function normalizedRgb(hex) {
  return hex.slice(1).match(/../gu).map((part) => Number.parseInt(part, 16) / 255);
}

function rgbaBytes(image) {
  const result = new Uint8Array(image.width * image.height * 4);
  let offset = 0;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    result.set(image.pixel(x, y), offset);
    offset += 4;
  }
  return result;
}

function samePixels(actual, expected, message) {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], `${message}: dimensions`);
  assert.deepEqual(rgbaBytes(actual), rgbaBytes(expected), message);
}

test("real Lottie export keeps mixed Hebrew/Latin glyphs on logical grapheme spans and at the layer position", async () => {
  const text = "שלום (ABC 123)";
  const layer = textLayer("mixed", "Mixed bidi", text, {
    x: 37, y: 54, width: 346, height: 76, fontSize: 32, textAlign: "right",
  });
  const layout = layoutText(layer, fonts);
  const bidi = bidiTextLine(prepareTextBidi(text));
  assert.equal(layout.lines[0].direction, "rtl");
  assert.ok(layout.lines[0].glyphs.some((glyph) => glyph.direction === "rtl"));
  assert.ok(layout.lines[0].glyphs.some((glyph) => glyph.direction === "ltr"));
  assert.equal(layout.lines[0].x, layer.width - layout.lines[0].width, "right alignment stays on the stored textbox edge");
  assert.deepEqual(bidi.parts.map((part) => text.slice(part.start, part.end)).join(""), text,
    "Bidi itemization retains the original logical source order");
  assertSourceSpans(layer, layout);

  const { animation } = await lottie(scene([layer]));
  const [vector] = vectorLayers(animation, layer.name);
  assert.ok(vector, "the exporter writes native outline geometry");
  assertLayerPosition(vector, layer.x, layer.y);
  assert.ok(allValues(vector.shapes, (value) => value.ty === "sh").length > 0,
    "the Lottie layer contains real text outline paths");
});

test("Arabic joining and rich text styles preserve complete raw spans through Lottie outlining", async () => {
  const arabic = "السَّلَامُ";
  const hebrew = "שלום";
  const text = `${arabic} ${hebrew} ABC 12`;
  const styledEnd = arabic.length + 1 + hebrew.length;
  const layer = textLayer("arabic", "Arabic rich style", text, {
    x: 30, y: 70, width: 360, height: 92, fontSize: 31, textAlign: "right",
    textStyleRanges: [{ start: 0, end: styledEnd, style: { fill: "#326884", fontSize: 34 } }],
  });
  const arabicFace = fonts.resolve({ fontFamily: "Noto Sans Arabic" });
  const joined = arabicFace.font.layout("سلام").glyphs.map((glyph) => glyph.id);
  const isolated = [..."سلام"].flatMap((character) => arabicFace.font.layout(character).glyphs.map((glyph) => glyph.id));
  assert.notDeepEqual(joined, isolated, "the local Arabic face uses contextual joining glyphs");

  const layout = layoutText(layer, fonts);
  assert.equal(layout.lines[0].direction, "rtl");
  assertSourceSpans(layer, layout);
  assertMarkedGraphemesStayInLetterUnits(layer, layout);
  assert.ok(layout.lines[0].glyphs.some((glyph) => glyph.start < styledEnd && glyph.fill === "#326884"),
    "the styled complete Arabic and Hebrew words retain their range paint");
  assert.ok(layout.lines[0].glyphs.some((glyph) => glyph.start >= styledEnd && glyph.fill === undefined),
    "the Latin phrase after the direction boundary retains the base paint");

  const { animation } = await lottie(scene([layer]));
  const [vector] = vectorLayers(animation, layer.name);
  assert.ok(vector, "styled text remains native outlined geometry in Lottie");
  assertLayerPosition(vector, layer.x, layer.y);
  const fills = allValues(vector.shapes, (value) => value.ty === "fl")
    .map((fill) => staticValue(fill.c));
  for (const color of ["#326884", layer.fill]) {
    const expected = normalizedRgb(color);
    assert.ok(fills.some((actual) => expected.every((part, index) => Math.abs(part - actual[index]) < 1e-7)),
      `Lottie retains fill ${color}`);
  }
});

test("wrapped RTL word and letter stagger retain stored right and center alignment in Lottie", async () => {
  const right = textLayer("right", "Right words", "שלום world 123 שלום שוב 456", {
    x: 22, y: 24, width: 174, height: 246, fontSize: 24, lineHeight: 1.25,
    textAlign: "right", verticalAlign: "top", animations: [custom("words", "words", 0.09)],
  });
  const center = textLayer("center", "Centered letters", "مرحبا بالناس world 42 هنا", {
    x: 222, y: 24, width: 174, height: 246, fontSize: 24, lineHeight: 1.25,
    textAlign: "center", verticalAlign: "top", animations: [custom("letters", "letters", 0.035)],
  });
  const rightLayout = layoutText(right, fonts);
  const centerLayout = layoutText(center, fonts);
  assert.ok(rightLayout.lines.length > 1, "the Hebrew paragraph wraps at the stored width");
  assert.ok(centerLayout.lines.length > 1, "the Arabic paragraph wraps at the stored width");
  for (const line of rightLayout.lines) assert.equal(line.x, right.width - line.width);
  for (const line of centerLayout.lines) assert.equal(line.x, (center.width - line.width) / 2);
  assertSourceSpans(right, rightLayout);
  assertSourceSpans(center, centerLayout);

  const { animation } = await lottie(scene([right, center]));
  for (const [layer, layout, mode] of [[right, rightLayout, "words"], [center, centerLayout, "letters"]]) {
    const output = vectorLayers(animation, layer.name);
    const drawnUnits = textUnits(layout, mode).filter((unit) => unit.glyphs.some((glyph) => glyph.path));
    assert.equal(output.length, drawnUnits.length, `${layer.name} exports one outline group per visible logical ${mode} unit`);
    assert.ok(output.length > 1);
    for (const vector of output) assertLayerPosition(vector, layer.x, layer.y);
  }
});

test("Change Text and Counter export mixed Arabic strings with the matching PNG layout", async () => {
  const changed = textLayer("changed", "Change mixed", "שלום 08 \u2014 total", {
    x: 24, y: 44, width: 372, height: 72, fontSize: 31, textAlign: "center",
    animations: [{
      id: "change", name: "Change", kind: "change-text", start: 0.65, text: "مرحبا 12 \u2014 إجمالي", overlap: false,
      out: { preset: "fade-out", duration: 0.18, easing: "linear", unit: "layer", stagger: 0, order: "forward" },
      in: { preset: "fade-in", duration: 0.18, easing: "linear", unit: "layer", stagger: 0, order: "forward" },
    }],
  });
  const counted = textLayer("counted", "Counter mixed", "نقاط 08 \u2014 score", {
    x: 24, y: 156, width: 372, height: 72, fontSize: 31, textAlign: "center",
  });
  counted.animations = [{ ...createCounter(counted, 0.3, "counter"), duration: 1.5, easing: "linear", to: 12, step: 1 }];
  const animated = scene([changed, counted], { duration: 2 });
  const { animation } = await lottie(animated);
  assert.ok(vectorLayers(animation, changed.name).length > 0, "Change Text strings export as outlined layers");
  assert.ok(vectorLayers(animation, counted.name).length > 0, "Counter strings export as outlined layers");

  const actual = await exportScene(animated, { format: "png", time: 1.9, width: WIDTH, height: HEIGHT }, { fonts });
  const expectedChange = textLayer(changed.id, changed.name, "مرحبا 12 \u2014 إجمالي", {
    x: changed.x, y: changed.y, width: changed.width, height: changed.height, fontSize: changed.fontSize, textAlign: changed.textAlign,
  });
  const expectedCount = textLayer(counted.id, counted.name, "نقاط 12 \u2014 score", {
    x: counted.x, y: counted.y, width: counted.width, height: counted.height, fontSize: counted.fontSize, textAlign: counted.textAlign,
  });
  const expected = await exportScene(scene([expectedChange, expectedCount], { duration: 2 }), {
    format: "png", time: 0, width: WIDTH, height: HEIGHT,
  }, { fonts });
  samePixels(await readImage(actual.buffer), await readImage(expected.buffer),
    "the settled Change Text and Counter outputs match their real static RTL layouts");
});
