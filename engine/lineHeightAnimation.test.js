// The Line height operation: a text layer's line height (a multiple of its font size) animated
// from an optional Initial value to a To value, laid out again on every frame.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBundledFonts } from "../backend/fonts.mjs";
import {
  DEFAULT_LINE_HEIGHT,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_PRESET_STEP,
  layoutLineHeight,
  lineHeightPixels,
  lineHeightPresetTo,
} from "./lineHeight.js";
import { PRESETS, evaluateLayer, presetAnimation } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { glyphPath, layoutText, resizeTextLayer, textUnits, unitGlyphs } from "./textLayout.js";
import { renderSceneSvg } from "./render.js";
import { copyAnimations, copyLayers, pasteAnimations, pasteLayers } from "./layerClipboard.js";

const fonts = await loadBundledFonts();

// A linear Line height animation from 0 s to 1 s.
function lineHeight(to, { from = {}, start = 0, duration = 1, unit = "layer", stagger = 0, easing = "linear", id = "line_height" } = {}) {
  return { id, name: "Line height", kind: "custom", start, duration, easing, from, to: { lineHeight: to }, unit, stagger, order: "forward" };
}

function spacing(to, { start = 0, duration = 1, id = "spacing" } = {}) {
  return { id, name: "Letter spacing", kind: "custom", start, duration, easing: "linear", from: {}, to: { letterSpacing: to }, unit: "layer", stagger: 0, order: "forward" };
}

// Three lines of 40 px text, 1.2 apart (48 px). Its saved height is the height those three lines
// take, as the editor saves an auto height text box.
function text(overrides = {}) {
  return createLayer("text", {
    id: "t", name: "Title", x: 10, y: 10, width: 400, height: 144, text: "H\nH\nH", fontSize: 40, lineHeight: 1.2, textAlign: "left", textResize: "height", ...overrides,
  });
}

function documentWith(layers) {
  return createDocument({ id: "doc", scenes: [createScene({ id: "scene", name: "Scene", width: 600, height: 400, duration: 4, layers })] });
}

function sceneWith(layers, duration = 3) {
  return createScene({ id: "scene", name: "Scene", width: 600, height: 400, duration, background: "transparent", layers });
}

// The same layer without its animations, saved with these values: what one frame should look like.
function still(layer, values) {
  return { ...layer, ...values, animations: [] };
}

const close = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual}, expected ${expected}`);
const paths = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
const lineYs = (layer) => layoutText(layer, fonts).lines.map((line) => line.y);
// Where the block of lines starts in the text box: the first line's top.
function blockTop(layout) {
  const [first] = layout.lines;
  return first.y - ((layout.lineHeight - first.ascent - first.descent) / 2 + first.ascent);
}

test("line height is a multiple of the font size, laid out at least 0.01", () => {
  assert.equal(lineHeightPixels(1.2, 40), 48);
  assert.equal(lineHeightPixels(2, 25), 50);
  assert.equal(layoutLineHeight(1.6), 1.6);
  // An overshooting easing can pass below 0.01 or reach 0; the text is laid out at 0.01.
  assert.equal(layoutLineHeight(0), LINE_HEIGHT_MIN);
  assert.equal(layoutLineHeight(-0.4), LINE_HEIGHT_MIN);
  // A value that isn't a number is the default 1.2.
  assert.equal(layoutLineHeight(undefined), DEFAULT_LINE_HEIGHT);
  assert.equal(layoutLineHeight("tall"), DEFAULT_LINE_HEIGHT);
  assert.equal(layoutLineHeight(Number.NaN), DEFAULT_LINE_HEIGHT);
  assert.deepEqual([LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_LINE_HEIGHT, LINE_HEIGHT_PRESET_STEP], [0.01, 100, 1.2, 0.4]);
});

test("the Line height preset: a custom animation to the current line height + 0.4, without an Initial value", () => {
  assert.ok(PRESETS.some((preset) => preset.id === "line-height" && preset.name === "Line height" && preset.kind === "custom"));
  const animation = presetAnimation("line-height", text({ lineHeight: 1.2 }), 1.5);
  assert.equal(animation.name, "Line height");
  assert.equal(animation.kind, "custom");
  assert.equal(animation.start, 1.5);
  assert.deepEqual(animation.from, {});
  assert.deepEqual(animation.to, { lineHeight: 1.6 }, "1.2 + 0.4, without a floating point remainder");
  assert.equal(animation.unit, "layer");
  assert.equal(lineHeightPresetTo({ lineHeight: 0.7 }), 1.1);
  assert.equal(lineHeightPresetTo({}), 1.6, "text without a number uses 1.2");
  // Kept within the limit.
  assert.equal(presetAnimation("line-height", text({ lineHeight: 99.9 })).to.lineHeight, LINE_HEIGHT_MAX);
  for (const type of ["rectangle", "ellipse", "group", "image", "audio"])
    assert.throws(() => presetAnimation("line-height", createLayer(type)), /Line height preset requires a text layer; only text has a line height/);
});

test("the model keeps a Line height animation without an Initial value, and refuses it off text or out of range", () => {
  const document = parseDocument(documentWith([text({ animations: [lineHeight(2)] })]));
  const saved = document.scenes[0].layers[0].animations[0];
  assert.deepEqual(saved.from, {}, "no Initial value is filled in");
  assert.deepEqual(saved.to, { lineHeight: 2 });
  const initial = parseDocument(documentWith([text({ animations: [lineHeight(2, { from: { lineHeight: 0.5 } })] })]));
  assert.deepEqual(initial.scenes[0].layers[0].animations[0].from, { lineHeight: 0.5 });
  // Saved and opened again, it is the same document.
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(initial))), initial);

  const box = createLayer("rectangle", { id: "box", animations: [lineHeight(2)] });
  assert.throws(() => parseDocument(documentWith([box])), /a Line height animation needs a text layer; only text has a line height/);
  const fromOnly = createLayer("ellipse", { id: "dot", animations: [{ ...lineHeight(0), from: { lineHeight: 1 }, to: { opacity: 1 } }] });
  assert.throws(() => parseDocument(documentWith([fromOnly])), /needs a text layer/);
  assert.throws(() => parseDocument(documentWith([text({ animations: [lineHeight(0)] })])), /lineHeight/);
  assert.throws(() => parseDocument(documentWith([text({ animations: [lineHeight(101)] })])), /lineHeight/);
  assert.throws(() => parseDocument(documentWith([text({ animations: [lineHeight("2")] })])), /lineHeight/);
  assert.throws(() => parseDocument(documentWith([text({ lineHeight: 0 })])), /lineHeight/);
});

test("only text layers are compatible with a Line height animation", () => {
  assert.equal(isAnimationCompatible(text(), lineHeight(2)), true);
  for (const type of ["rectangle", "ellipse", "star", "path", "group", "image", "video", "audio", "component"])
    assert.equal(isAnimationCompatible({ type }, lineHeight(2)), false, type);
});

test("the line height is evaluated at every time, from the Initial value or from the current line height", () => {
  const plain = text({ animations: [lineHeight(2)] });
  for (const [time, expected] of [[0, 1.2], [0.25, 1.4], [0.5, 1.6], [1, 2], [3, 2]])
    close(evaluateLayer(plain, time).lineHeight, expected, `t ${time}`);
  // An Initial value of 0.8 starts there.
  const initial = text({ animations: [lineHeight(2, { from: { lineHeight: 0.8 } })] });
  for (const [time, expected] of [[0, 0.8], [0.5, 1.4], [1, 2]]) close(evaluateLayer(initial, time).lineHeight, expected, `t ${time}`);
  // A second Line height animation without an Initial value continues from where the first
  // one left the line height (2), not from the layer's own 1.2.
  const chained = text({ animations: [lineHeight(2), lineHeight(1, { start: 1, id: "tighter" })] });
  for (const [time, expected] of [[0.5, 1.6], [1, 2], [1.5, 1.5], [2, 1]]) close(evaluateLayer(chained, time).lineHeight, expected, `t ${time}`);
  // Turned off for playback, the first one is left out: the second starts from the layer's 1.2.
  const off = text({ animations: [{ ...lineHeight(2), enabled: false }, lineHeight(1, { start: 1, id: "tighter" })] });
  close(evaluateLayer(off, 1.5).lineHeight, 1.1, "t 1.5 with the first one off");
});

test("the text is laid out again at each time: the lines move apart by the frame's line height", () => {
  const layer = text({ animations: [lineHeight(2)] });
  for (const time of [0, 0.25, 0.5, 0.75, 1]) {
    const state = evaluateLayer(layer, time);
    const ys = lineYs(state);
    assert.equal(ys.length, 3);
    // 40 px text: each line is lineHeight × 40 px below the one before it.
    for (const index of [1, 2]) close(ys[index] - ys[index - 1], state.lineHeight * 40, `t ${time} line ${index}`);
    // The same places as text saved with that line height.
    assert.deepEqual(ys, lineYs(still(layer, { lineHeight: state.lineHeight })), `t ${time}`);
  }
  // The first line moves too: half the extra space goes above it (each line is centered in its
  // line height), so from 1.2 to 2 on 40 px it moves down 16 px.
  close(lineYs(evaluateLayer(layer, 1))[0] - lineYs(layer)[0], 16, "first line");
  // A tighter line height pulls the lines together.
  const tight = lineYs(evaluateLayer(text({ animations: [lineHeight(0.5)] }), 1));
  close(tight[2] - tight[0], 40, "0.5 on 40 px is 20 px per line");
});

test("auto height text grows and shrinks with the line height, keeping its top, middle or bottom in place", () => {
  const top = text({ animations: [lineHeight(2)] });
  const heights = [0, 0.5, 1].map((time) => resizeTextLayer(evaluateLayer(top, time), fonts).height);
  // Three lines of 1.2, 1.6 and 2 times 40 px, rounded up to a whole pixel like every auto height.
  assert.deepEqual(heights, [144, 192, 240]);
  for (const time of [0, 0.5, 1]) assert.equal(resizeTextLayer(evaluateLayer(top, time), fonts).y, 10, `top aligned text grows down at ${time} s`);

  const bottom = text({ verticalAlign: "bottom", animations: [lineHeight(2)] });
  const middle = text({ verticalAlign: "middle", animations: [lineHeight(2)] });
  for (const time of [0, 0.5, 1]) {
    const grownBottom = resizeTextLayer(evaluateLayer(bottom, time), fonts);
    close(grownBottom.y + grownBottom.height, 154, `bottom aligned text keeps its bottom at ${time} s`);
    const grownMiddle = resizeTextLayer(evaluateLayer(middle, time), fonts);
    close(grownMiddle.y + grownMiddle.height / 2, 82, `middle aligned text keeps its middle at ${time} s`);
  }

  // A tighter line height shrinks the box.
  const shrinking = text({ animations: [lineHeight(0.8)] });
  assert.deepEqual([0, 0.5, 1].map((time) => resizeTextLayer(evaluateLayer(shrinking, time), fonts).height), [144, 120, 96]);
  // Text that sizes both its width and height grows taller and keeps its width.
  const both = text({ textResize: "width-height", animations: [lineHeight(2)] });
  const [start, end] = [0, 1].map((time) => resizeTextLayer(evaluateLayer(both, time), fonts));
  assert.equal(start.width, end.width);
  assert.equal(end.height, 240);
});

test("a fixed box keeps its size and places the taller or shorter block by its vertical alignment", () => {
  for (const verticalAlign of ["top", "middle", "bottom"]) {
    const layer = text({ textResize: "fixed", height: 300, verticalAlign, animations: [lineHeight(2)] });
    for (const time of [0, 0.5, 1]) {
      const state = resizeTextLayer(evaluateLayer(layer, time), fonts);
      assert.deepEqual([state.y, state.height], [10, 300], `${verticalAlign} at ${time} s keeps the box`);
      const layout = layoutText(state, fonts);
      const blockHeight = 3 * state.lineHeight * 40;
      close(layout.naturalHeight, blockHeight, `${verticalAlign} at ${time} s: block height`);
      const expected = verticalAlign === "top" ? 0 : verticalAlign === "middle" ? (300 - blockHeight) / 2 : 300 - blockHeight;
      close(blockTop(layout), expected, `${verticalAlign} at ${time} s: block top`);
    }
  }
});

test("the editor draws each frame with that frame's line height", () => {
  for (const [verticalAlign, textResize] of [["top", "height"], ["bottom", "height"], ["middle", "fixed"]]) {
    const layer = text({ verticalAlign, textResize, height: textResize === "fixed" ? 300 : 144, animations: [lineHeight(2)] });
    const scene = sceneWith([layer]);
    for (const [time, value] of [[0, 1.2], [0.5, 1.6], [1, 2]])
      assert.equal(renderSceneSvg(scene, time, { fonts }), renderSceneSvg(sceneWith([still(layer, { lineHeight: value })]), time, { fonts }), `${verticalAlign} ${textResize} at ${time} s`);
  }
  const scene = sceneWith([text({ animations: [lineHeight(2)] })]);
  assert.notEqual(renderSceneSvg(scene, 0, { fonts }), renderSceneSvg(scene, 1, { fonts }), "the lines move");
});

test("by lines, letters and words each unit moves with the line height, and stagger gives each line its own", () => {
  for (const unit of ["lines", "letters", "words"]) {
    const layer = text({ text: "AB CD\nEF\nGH", animations: [lineHeight(2, { unit })] });
    // Without stagger every unit is laid out with the same line height: the same glyphs as the
    // layer drawn whole with that line height.
    const drawn = paths(renderSceneSvg(sceneWith([layer]), 0.5, { fonts })).sort();
    const whole = paths(renderSceneSvg(sceneWith([still(layer, { lineHeight: 1.6 })]), 0, { fonts })).sort();
    assert.equal(drawn.length, 8, unit);
    assert.deepEqual(drawn, whole, unit);
  }
  // Lines with a 0.5 s stagger: at 0.75 s, line 0 is three quarters of the way (1.8), line 1 a
  // quarter of the way (1.4) and line 2 has not begun (1.2); each line is drawn where its own line
  // height lays it out, so the lines move one after another.
  const layer = text({ animations: [lineHeight(2, { unit: "lines", stagger: 0.5 })] });
  const units = textUnits(layoutText(layer, fonts), "lines");
  assert.equal(units.length, 3);
  const svg = renderSceneSvg(sceneWith([layer]), 0.75, { fonts });
  const placed = units.map((unit, index) => {
    const state = evaluateLayer(layer, 0.75, { unitIndex: index, unitCount: units.length, fonts });
    close(state.lineHeight, [1.8, 1.4, 1.2][index], `line ${index} line height`);
    const glyphs = unitGlyphs(layoutText(resizeTextLayer(state, fonts), fonts), unit).filter((glyph) => glyph.path);
    assert.equal(glyphs.length, 1);
    assert.ok(svg.includes(`d="${glyphPath(glyphs[0])}"`), `line ${index} is drawn with its own line height`);
    return glyphs[0].y;
  });
  const rest = lineYs(layer);
  // Line n of a line height h is at (h × 40 − ascent − descent) / 2 + ascent + n × h × 40.
  close(placed[0] - rest[0], 12, "line 0 at 1.8 moved half of 0.6 × 40 px");
  close(placed[1] - rest[1], 12, "line 1 at 1.4 moved half of 0.2 × 40 px, plus 0.2 × 40 px for the line above it");
  close(placed[2], rest[2], "line 2 has not started");
});

test("a Line height and a Letter spacing animation on the same text are laid out with both values", () => {
  // At the same time: the letters open up and wrap onto more lines while the lines move apart.
  const together = text({ text: "AB CD EF", width: 200, animations: [lineHeight(2), spacing(80)] });
  // One after the other.
  const sequence = text({ text: "AB CD EF", width: 200, animations: [spacing(80), lineHeight(2, { start: 1, id: "later" })] });
  for (const layer of [together, sequence]) {
    for (const time of [0, 0.5, 1, 1.5, 2]) {
      const state = evaluateLayer(layer, time);
      const expected = still(layer, { lineHeight: state.lineHeight, letterSpacing: state.letterSpacing });
      assert.equal(renderSceneSvg(sceneWith([layer]), time, { fonts }), renderSceneSvg(sceneWith([expected]), time, { fonts }), `${layer.animations[0].name} first, ${time} s`);
      const resized = resizeTextLayer(state, fonts);
      const layout = layoutText(resized, fonts);
      close(layout.naturalHeight, layout.lines.length * state.lineHeight * 40, `${time} s lines`);
      assert.equal(resized.height, Math.ceil(layout.naturalHeight), `${time} s height`);
    }
  }
  const lines = (time) => layoutText(resizeTextLayer(evaluateLayer(together, time), fonts), fonts).lines.length;
  assert.equal(lines(0), 1);
  assert.ok(lines(1) > 1, "80 % of 40 px wraps the words");
  // By letters with stagger, both values are each letter's own, and every letter is drawn once.
  const staggered = text({ text: "AB CD EF", width: 200, animations: [{ ...lineHeight(2), unit: "letters", stagger: 0.05 }, { ...spacing(80), unit: "letters", stagger: 0.05 }] });
  for (const time of [0, 0.4, 0.8, 1.5]) assert.equal(paths(renderSceneSvg(sceneWith([staggered]), time, { fonts })).length, 6, `${time} s: six letters`);
});

test("an overshooting easing below 0.01 lays the lines out 0.01 apart instead of failing", () => {
  const layer = text({ animations: [lineHeight(0.05, { from: { lineHeight: 2 }, easing: "overshoot" })] });
  // The intensity-50 Overshoot now peaks near one quarter of the animation.
  const time = 0.25;
  const state = evaluateLayer(layer, time);
  assert.ok(state.lineHeight < 0, `overshoot passes 0: ${state.lineHeight}`);
  const ys = lineYs(state);
  close(ys[1] - ys[0], 0.4, "0.01 × 40 px");
  assert.equal(resizeTextLayer(state, fonts).height, 2, "1.2 px of lines is rounded up to 2 px");
  assert.equal(renderSceneSvg(sceneWith([layer]), time, { fonts }), renderSceneSvg(sceneWith([still(layer, { lineHeight: 0.01 })]), time, { fonts }));
});

test("apply_operations adds, edits and refuses Line height animations like the Animate tab", () => {
  const box = createLayer("rectangle", { id: "box" });
  const source = documentWith([text({ lineHeight: 1.5 }), box]);
  const added = applyOperations(source, [{ type: "add_animation", sceneId: "scene", layerId: "t", preset: "line-height", start: 0.5 }], { fonts });
  const animation = added.scenes[0].layers[0].animations[0];
  assert.equal(animation.name, "Line height");
  assert.deepEqual(animation.from, {});
  assert.deepEqual(animation.to, { lineHeight: 1.9 });
  assert.equal(animation.start, 0.5);
  // An Initial value is set with from {lineHeight}, and removed again with from {}.
  const withInitial = applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "t", animationId: animation.id, properties: { from: { lineHeight: 0.8 } } }], { fonts });
  assert.deepEqual(withInitial.scenes[0].layers[0].animations[0].from, { lineHeight: 0.8 });
  close(evaluateLayer(withInitial.scenes[0].layers[0], 0.5).lineHeight, 0.8, "starts at the Initial value");
  const withoutInitial = applyOperations(withInitial, [{ type: "update_animation", sceneId: "scene", layerId: "t", animationId: animation.id, properties: { from: {} } }], { fonts });
  assert.deepEqual(withoutInitial.scenes[0].layers[0].animations[0].from, {});
  close(evaluateLayer(withoutInitial.scenes[0].layers[0], 0.5).lineHeight, 1.5, "starts at the layer's line height again");
  // Combined with the Letter spacing preset on the same layer.
  const both = applyOperations(added, [{ type: "add_animation", sceneId: "scene", layerId: "t", preset: "letter-spacing", start: 0.5 }], { fonts });
  assert.deepEqual(both.scenes[0].layers[0].animations.map((item) => item.name), ["Line height", "Letter spacing"]);

  assert.throws(() => applyOperations(source, [{ type: "add_animation", sceneId: "scene", layerId: "box", preset: "line-height" }], { fonts }), /Line height preset requires a text layer/);
  assert.throws(
    () => applyOperations(source, [{ type: "add_animation", sceneId: "scene", layerId: "box", animation: lineHeight(2) }], { fonts }),
    /a Line height animation needs a text layer; only text has a line height/,
  );
  for (const value of [0, 101])
    assert.throws(
      () => applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "t", animationId: animation.id, properties: { to: { lineHeight: value } } }], { fonts }),
      /lineHeight/,
    );
});

test("a pasted Line height animation moves from the target's own line height, and skips layers that aren't text", () => {
  const document = documentWith([
    text({ id: "source", lineHeight: 1.2, animations: [lineHeight(1.6, { from: { lineHeight: 1.2 } })] }),
    text({ id: "loose", lineHeight: 2 }),
    text({ id: "tall", lineHeight: 99.8 }),
    createLayer("rectangle", { id: "box", name: "Box" }),
  ]);
  const envelope = copyAnimations(document, "scene", ["line_height"]);
  const result = pasteAnimations(document, "scene", ["loose", "tall", "box"], envelope, 0);
  const pasted = (id) => result.document.scenes[0].layers.find((layer) => layer.id === id).animations[0];
  assert.deepEqual(pasted("loose").from, { lineHeight: 2 });
  assert.deepEqual(pasted("loose").to, { lineHeight: 2.4 }, "0.4 more than the target's line height, as the copy was");
  assert.deepEqual(pasted("tall").to, { lineHeight: LINE_HEIGHT_MAX }, "kept within the limit");
  assert.deepEqual(result.skipped.map((item) => [item.layerId, item.reason]), [["box", "Paste a Line height animation onto a text layer."]]);
  assert.throws(() => pasteAnimations(document, "scene", ["box"], envelope, 0), /Paste a Line height animation onto a text layer\./);
  // A copied or duplicated text layer keeps its Line height animation.
  const layers = pasteLayers(documentWith([]), "scene", copyLayers(document, "scene", ["source"]), { fonts });
  const copy = layers.document.scenes[0].layers[0];
  assert.deepEqual([copy.animations[0].from, copy.animations[0].to], [{ lineHeight: 1.2 }, { lineHeight: 1.6 }]);
});
