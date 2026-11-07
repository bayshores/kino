// The Letter spacing operation: a text layer's letter spacing (a percentage of its font size)
// animated from an optional Initial value to a To value, laid out again on every frame.
import test from "node:test";
import assert from "node:assert/strict";
import { DOCUMENT_VERSION } from "./schema.js";
import { DOMParser } from "@xmldom/xmldom";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { LETTER_SPACING_LIMIT, layoutFontSize, letterSpacingPercent, letterSpacingPixels } from "./letterSpacing.js";
import { PRESETS, evaluateLayer, presetAnimation } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { glyphPath, layoutText, resizeTextLayer, textUnits, unitGlyphs } from "./textLayout.js";
import { renderSceneSvg } from "./render.js";
import { copyAnimations, copyLayers, pasteAnimations, pasteLayers } from "./layerClipboard.js";
import { importSvg } from "./svgImport.js";
import { NUMBER_FIELDS } from "./multiEdit.js";

const fonts = await loadBundledFonts();

// A linear Letter spacing animation from 0 s to 1 s.
function spacing(to, { from = {}, start = 0, duration = 1, unit = "layer", stagger = 0, id = "spacing" } = {}) {
  return { id, name: "Letter spacing", kind: "custom", start, duration, easing: "linear", from, to: { letterSpacing: to }, unit, stagger, order: "forward" };
}

function text(overrides = {}) {
  return createLayer("text", { id: "t", name: "Title", x: 10, y: 10, width: 400, height: 60, text: "HHHH", fontSize: 40, textAlign: "left", textResize: "width-height", ...overrides });
}

function documentWith(layers) {
  return createDocument({ id: "doc", scenes: [createScene({ id: "scene", name: "Scene", width: 600, height: 300, duration: 4, layers })] });
}

// Each glyph's x in the text box, in reading order.
const glyphXs = (layer) => layoutText(layer, fonts).lines.flatMap((line) => line.glyphs.map((glyph) => line.x + glyph.x));
const close = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual}, expected ${expected}`);
const paths = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);

test("letter spacing is a percentage of the font size", () => {
  assert.equal(letterSpacingPixels(10, 48), 4.8);
  assert.equal(letterSpacingPixels(-50, 20), -10);
  assert.equal(letterSpacingPercent(4.8, 48), 10);
  assert.equal(letterSpacingPercent(-10, 20), -50);
  // Text is laid out at least 0.1 px, and at 24 px when the size isn't a number.
  assert.equal(layoutFontSize(undefined), 24);
  assert.equal(layoutFontSize(0), 24);
  assert.equal(layoutFontSize(0.01), 0.1);
  assert.equal(letterSpacingPixels("wide", 48), 0);
  assert.equal(LETTER_SPACING_LIMIT, 10_000_000);
});

test("the Letter spacing preset: a custom animation to the current spacing + 20 %, without an Initial value", () => {
  assert.ok(PRESETS.some((preset) => preset.id === "letter-spacing" && preset.name === "Letter spacing" && preset.kind === "custom"));
  const animation = presetAnimation("letter-spacing", text({ letterSpacing: 5 }), 1.5);
  assert.equal(animation.name, "Letter spacing");
  assert.equal(animation.kind, "custom");
  assert.equal(animation.start, 1.5);
  assert.deepEqual(animation.from, {});
  assert.deepEqual(animation.to, { letterSpacing: 25 });
  assert.equal(animation.unit, "layer");
  // Kept within the limit.
  assert.equal(presetAnimation("letter-spacing", text({ letterSpacing: LETTER_SPACING_LIMIT - 5 })).to.letterSpacing, LETTER_SPACING_LIMIT);
  for (const type of ["rectangle", "ellipse", "group", "image", "audio"])
    assert.throws(() => presetAnimation("letter-spacing", createLayer(type)), /Letter spacing preset requires a text layer; only text has letter spacing/);
});

test("the model keeps a Letter spacing animation without an Initial value, and refuses it off text", () => {
  const document = parseDocument(documentWith([text({ animations: [spacing(20)] })]));
  const saved = document.scenes[0].layers[0].animations[0];
  assert.deepEqual(saved.from, {}, "no Initial value is filled in");
  assert.deepEqual(saved.to, { letterSpacing: 20 });
  const initial = parseDocument(documentWith([text({ animations: [spacing(20, { from: { letterSpacing: -10 } })] })]));
  assert.deepEqual(initial.scenes[0].layers[0].animations[0].from, { letterSpacing: -10 });

  const box = createLayer("rectangle", { id: "box", animations: [spacing(20)] });
  assert.throws(() => parseDocument(documentWith([box])), /a Letter spacing animation needs a text layer; only text has letter spacing/);
  const fromOnly = createLayer("ellipse", { id: "dot", animations: [{ ...spacing(0), from: { letterSpacing: 5 }, to: { opacity: 1 } }] });
  assert.throws(() => parseDocument(documentWith([fromOnly])), /needs a text layer/);
  assert.throws(() => parseDocument(documentWith([text({ animations: [spacing(LETTER_SPACING_LIMIT + 1)] })])), /letterSpacing/);
  assert.throws(() => parseDocument(documentWith([text({ letterSpacing: -LETTER_SPACING_LIMIT - 1 })])), /letterSpacing/);
});

test("only text layers are compatible with a Letter spacing animation", () => {
  assert.equal(isAnimationCompatible(text(), spacing(20)), true);
  for (const type of ["rectangle", "ellipse", "star", "path", "group", "image", "video", "audio", "component"])
    assert.equal(isAnimationCompatible({ type }, spacing(20)), false, type);
});

test("the letter spacing is evaluated at every time, from the Initial value or from the current spacing", () => {
  const plain = text({ animations: [spacing(20)] });
  for (const [time, expected] of [[0, 0], [0.25, 5], [0.5, 10], [1, 20], [3, 20]])
    close(evaluateLayer(plain, time).letterSpacing, expected, `t ${time}`);
  // An Initial value of 40 % starts there.
  const initial = text({ animations: [spacing(20, { from: { letterSpacing: 40 } })] });
  for (const [time, expected] of [[0, 40], [0.5, 30], [1, 20]]) close(evaluateLayer(initial, time).letterSpacing, expected, `t ${time}`);
  // A second Letter spacing animation without an Initial value continues from where the first
  // one left the spacing (20 %), not from the layer's own spacing.
  const chained = text({ animations: [spacing(20), spacing(60, { start: 1, id: "wider" })] });
  for (const [time, expected] of [[0.5, 10], [1, 20], [1.5, 40], [2, 60]]) close(evaluateLayer(chained, time).letterSpacing, expected, `t ${time}`);
  // Turned off for playback, the first one is left out: the second starts from the layer's 0 %.
  const off = text({ animations: [{ ...spacing(20), enabled: false }, spacing(60, { start: 1, id: "wider" })] });
  close(evaluateLayer(off, 1.5).letterSpacing, 30, "t 1.5 with the first one off");
});

test("the text is laid out again at each time: every letter moves by the spacing in pixels", () => {
  const layer = text({ animations: [spacing(20)] });
  const rest = glyphXs(layer);
  for (const time of [0, 0.25, 0.5, 1]) {
    const state = evaluateLayer(layer, time);
    const pixels = (40 * state.letterSpacing) / 100; // 40 px text: 20 % is 8 px after each letter
    const xs = glyphXs(state);
    assert.equal(xs.length, 4);
    for (const [index, x] of xs.entries()) close(x, rest[index] + pixels * index, `t ${time} letter ${index}`);
  }
  // Negative spacing pulls the letters together.
  const tight = evaluateLayer(text({ animations: [spacing(-25)] }), 1);
  close(glyphXs(tight)[3], rest[3] - 30, "-25 % of 40 px is 10 px closer per letter");
});

test("auto width text grows with the spacing and keeps its alignment anchor", () => {
  const left = text({ animations: [spacing(20)] });
  const restWidth = layoutText(left, fonts).width;
  const atEnd = resizeTextLayer(evaluateLayer(left, 1), fonts);
  // Three gaps between four letters, 8 px each, rounded up to a whole pixel like every auto width.
  close(atEnd.width, Math.ceil(layoutText(left, fonts).naturalWidth + 24), "width at 1 s");
  assert.ok(atEnd.width > restWidth);
  assert.equal(atEnd.x, 10, "left aligned text grows to the right");
  const halfway = resizeTextLayer(evaluateLayer(left, 0.5), fonts);
  assert.ok(halfway.width > restWidth && halfway.width < atEnd.width, "the box grows during the animation");

  const centered = text({ textAlign: "center", width: restWidth, animations: [spacing(20)] });
  const grown = resizeTextLayer(evaluateLayer(centered, 1), fonts);
  close(grown.x + grown.width / 2, 10 + restWidth / 2, "centered text keeps its center");
  const right = text({ textAlign: "right", width: restWidth, animations: [spacing(20)] });
  const grownRight = resizeTextLayer(evaluateLayer(right, 1), fonts);
  close(grownRight.x + grownRight.width, 10 + restWidth, "right aligned text keeps its right edge");

  // Auto height text wraps onto more lines when the spacing makes a line too long.
  const wrapping = text({ text: "AB CD EF", width: 200, textResize: "height", animations: [spacing(80)] });
  const lines = (time) => layoutText(resizeTextLayer(evaluateLayer(wrapping, time), fonts), fonts).lines.length;
  assert.equal(lines(0), 1);
  assert.ok(lines(1) > 1, "80 % of 40 px wraps the words");
  assert.ok(resizeTextLayer(evaluateLayer(wrapping, 1), fonts).height > resizeTextLayer(evaluateLayer(wrapping, 0), fonts).height);
});

test("the editor draws each frame with that frame's spacing", () => {
  const layer = text({ animations: [spacing(20)] });
  const scene = createScene({ id: "scene", name: "Scene", width: 600, height: 300, duration: 2, background: "transparent", layers: [layer] });
  const still = (letterSpacing) => paths(renderSceneSvg({ ...scene, layers: [text({ letterSpacing })] }, 0, { fonts }));
  for (const [time, letterSpacing] of [[0, 0], [0.5, 10], [1, 20]])
    assert.deepEqual(paths(renderSceneSvg(scene, time, { fonts })), still(letterSpacing), `t ${time}`);
});

test("by letters, words and lines each unit moves with the spacing, and stagger delays each unit's own spacing", () => {
  for (const unit of ["letters", "words", "lines"]) {
    const layer = text({ text: "AB CD", animations: [spacing(50, { unit })] });
    const scene = createScene({ id: "scene", name: "Scene", width: 600, height: 300, duration: 2, background: "transparent", layers: [layer] });
    // Without stagger, every unit is laid out with the same spacing: the same glyphs as the layer
    // drawn whole with that spacing.
    const drawn = paths(renderSceneSvg(scene, 0.5, { fonts })).sort();
    const whole = paths(renderSceneSvg({ ...scene, layers: [text({ text: "AB CD", letterSpacing: 25 })] }, 0, { fonts })).sort();
    assert.deepEqual(drawn, whole, unit);
  }
  // Letters with a 0.25 s stagger: at 0.5 s, letter 1 is halfway (25 %) and letter 2 a quarter
  // of the way (12.5 %); each letter is drawn where its own spacing lays it out.
  const layer = text({ text: "AB CD", animations: [spacing(50, { unit: "letters", stagger: 0.25 })] });
  const scene = createScene({ id: "scene", name: "Scene", width: 600, height: 300, duration: 3, background: "transparent", layers: [layer] });
  const units = textUnits(layoutText(layer, fonts), "letters");
  const svg = renderSceneSvg(scene, 0.5, { fonts });
  for (const [index, unit] of units.entries()) {
    const state = evaluateLayer(layer, 0.5, { unitIndex: index, unitCount: units.length, fonts });
    close(state.letterSpacing, Math.max(0, Math.min(1, (0.5 - 0.25 * index) / 1)) * 50, `letter ${index} spacing`);
    for (const glyph of unitGlyphs(layoutText(resizeTextLayer(state, fonts), fonts), unit).filter((item) => item.path))
      assert.ok(svg.includes(`d="${glyphPath(glyph)}"`), `letter ${index} is drawn with its own spacing`);
  }
});

test("when the spacing wraps the text differently, every letter is still drawn exactly once", () => {
  // Wider: one line becomes several. Narrower: a wrapped text fits on fewer lines.
  for (const [rest, to] of [[0, 80], [80, 0]]) {
    for (const unit of ["letters", "words", "lines"]) {
      const layer = text({ text: "AB CD EF", width: 200, textResize: "height", letterSpacing: rest, animations: [spacing(to, { unit })] });
      const scene = createScene({ id: "scene", name: "Scene", width: 600, height: 400, duration: 2, background: "transparent", layers: [layer] });
      for (const time of [0, 0.5, 1]) {
        const drawn = paths(renderSceneSvg(scene, time, { fonts }));
        assert.equal(drawn.length, 6, `${unit} from ${rest} % to ${to} % at ${time} s: six letters`);
        // The same letters, in the same places, as the whole layer drawn with that spacing.
        const state = evaluateLayer(layer, time);
        const whole = paths(renderSceneSvg({ ...scene, layers: [text({ text: "AB CD EF", width: 200, textResize: "height", letterSpacing: state.letterSpacing })] }, 0, { fonts }));
        assert.deepEqual(drawn.sort(), whole.sort(), `${unit} from ${rest} % to ${to} % at ${time} s`);
      }
    }
  }
});

test("units know where their characters are, and unitGlyphs finds them in another layout", () => {
  const layer = text({ text: "AB CD\nEF", width: 200, textResize: "height" });
  const layout = layoutText(layer, fonts);
  const words = textUnits(layout, "words");
  assert.deepEqual(words.map((unit) => [unit.text, unit.sourceStart, unit.sourceEnd]), [["AB ", 0, 3], ["CD", 3, 5], ["EF", 6, 8]]);
  const wide = layoutText({ ...layer, letterSpacing: 120 }, fonts);
  assert.ok(wide.lines.length > layout.lines.length, "the wide spacing wraps CD onto its own line");
  for (const unit of words) {
    const glyphs = unitGlyphs(wide, unit);
    assert.equal(glyphs.filter((glyph) => glyph.path).length, unit.text.trim().length, unit.text);
  }
  // The second word's glyphs are where the wide layout puts them: on the second line.
  const [c] = unitGlyphs(wide, words[1]);
  assert.equal(c.y, wide.lines[1].y + wide.lines[1].glyphs[0].y);
  // A whole-layer unit covers the text, and an empty range covers nothing.
  assert.equal(unitGlyphs(wide, textUnits(wide, "layer")[0]).filter((glyph) => glyph.path).length, 6);
  assert.deepEqual(unitGlyphs(wide, { sourceStart: 2, sourceEnd: 2 }), []);
  assert.deepEqual(unitGlyphs(wide, null), []);
});

test("apply_operations adds, edits and refuses Letter spacing animations like the Animate tab", () => {
  const box = createLayer("rectangle", { id: "box" });
  const source = documentWith([text({ letterSpacing: 10 }), box]);
  const added = applyOperations(source, [{ type: "add_animation", sceneId: "scene", layerId: "t", preset: "letter-spacing", start: 0.5 }], { fonts });
  const animation = added.scenes[0].layers[0].animations[0];
  assert.equal(animation.name, "Letter spacing");
  assert.deepEqual(animation.from, {});
  assert.deepEqual(animation.to, { letterSpacing: 30 });
  assert.equal(animation.start, 0.5);
  // An Initial value is set with from {letterSpacing}, and removed again with from {}.
  const withInitial = applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "t", animationId: animation.id, properties: { from: { letterSpacing: -20 } } }], { fonts });
  assert.deepEqual(withInitial.scenes[0].layers[0].animations[0].from, { letterSpacing: -20 });
  close(evaluateLayer(withInitial.scenes[0].layers[0], 0.5).letterSpacing, -20, "starts at the Initial value");
  const withoutInitial = applyOperations(withInitial, [{ type: "update_animation", sceneId: "scene", layerId: "t", animationId: animation.id, properties: { from: {} } }], { fonts });
  assert.deepEqual(withoutInitial.scenes[0].layers[0].animations[0].from, {});
  close(evaluateLayer(withoutInitial.scenes[0].layers[0], 0.5).letterSpacing, 10, "starts at the layer's spacing again");

  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "scene", layerId: "box", preset: "letter-spacing" }], { fonts }), /Letter spacing preset requires a text layer/);
  assert.throws(
    () => applyOperations(source, [{ type: "add_animation", sceneId: "scene", layerId: "box", animation: spacing(20) }], { fonts }),
    /a Letter spacing animation needs a text layer; only text has letter spacing/,
  );
  assert.throws(
    () => applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "t", animationId: animation.id, properties: { to: { letterSpacing: LETTER_SPACING_LIMIT * 2 } } }], { fonts }),
    /letterSpacing/,
  );
});

test("a version 1 clipboard pastes its pixel letter spacing as the same spacing in percent", () => {
  const document = documentWith([text({ id: "copied", fontSize: 48, letterSpacing: 10 })]);
  const envelope = copyLayers(document, "scene", ["copied"]);
  assert.equal(envelope.version, DOCUMENT_VERSION);
  // The same copy made by a kino of document version 1, which stored 4.8 px.
  const older = { ...envelope, version: 1, layers: envelope.layers.map((layer) => ({ ...layer, letterSpacing: 4.8 })) };
  const read = JSON.parse(JSON.stringify(older));
  const pasted = pasteLayers(documentWith([]), "scene", read, { fonts });
  close(pasted.textLayers[0].letterSpacing, 10, "4.8 px on 48 px text is 10 %");
  // A version 2 copy is pasted as it is.
  close(pasteLayers(documentWith([]), "scene", envelope, { fonts }).textLayers[0].letterSpacing, 10, "version 2");
});

test("a pasted Letter spacing animation moves from the target's own spacing, and skips layers that aren't text", () => {
  const document = documentWith([
    text({ id: "source", letterSpacing: 10, animations: [spacing(30, { from: { letterSpacing: 10 } })] }),
    text({ id: "wide", letterSpacing: 50 }),
    createLayer("rectangle", { id: "box", name: "Box" }),
  ]);
  const envelope = copyAnimations(document, "scene", ["spacing"]);
  const result = pasteAnimations(document, "scene", ["wide", "box"], envelope, 0);
  const pasted = result.document.scenes[0].layers.find((layer) => layer.id === "wide").animations[0];
  assert.deepEqual(pasted.from, { letterSpacing: 50 });
  assert.deepEqual(pasted.to, { letterSpacing: 70 }, "20 % wider than the target's spacing, as the copy was");
  assert.deepEqual(result.skipped.map((item) => [item.layerId, item.reason]), [["box", "Paste a Letter spacing animation onto a text layer."]]);
  assert.throws(() => pasteAnimations(document, "scene", ["box"], envelope, 0), /Paste a Letter spacing animation onto a text layer\./);
});

test("SVG letter-spacing in px, em and other lengths is imported as a percentage of the font size", () => {
  const imported = (spacingValue, fontSize = 20) => importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="0" y="40" font-size="${fontSize}" letter-spacing="${spacingValue}">Hi</text></svg>`,
    { DOMParser },
  ).layers[0].letterSpacing;
  close(imported("2"), 10, "2 px on 20 px");
  close(imported("2px"), 10, "2px on 20 px");
  close(imported("0.25em"), 25, "a quarter em");
  close(imported("-0.1em", 40), -10, "negative em");
  close(imported("normal"), 0, "normal");
  close(imported("1.5pt"), 10, "1.5 pt is 2 px");
  assert.throws(() => imported("10%"), /letter-spacing/);
});

test("several text layers' letter spacing is edited in percent, within the limit", () => {
  assert.equal(NUMBER_FIELDS.letterSpacing.min, -LETTER_SPACING_LIMIT);
  assert.equal(NUMBER_FIELDS.letterSpacing.max, LETTER_SPACING_LIMIT);
});
