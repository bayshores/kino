// What a text layer with Change text draws (textChangeDraw.js): which strings, cut into which
// units, in which states, and the SVG the editor canvas and raster exports draw from them.
import test from "node:test";
import assert from "node:assert/strict";
import { createTextEffect } from "./textChange.js";
import { shownTextAt, textDrawingsAt, textStringPlans } from "./textChangeDraw.js";
import { createLayer, createScene } from "./model.js";
import { renderSceneSvg } from "./render.js";
import { layoutText, resizeTextLayer } from "./textLayout.js";

const SCENE = { width: 800, height: 600 };
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual}, expected ${expected}`);

function effect(preset, overrides = {}) {
  return { ...createTextEffect(preset, preset.endsWith("-out") ? "out" : "in", SCENE), easing: "linear", ...overrides };
}

function change(start, text, { id = `change-${start}`, out = effect("fade-out"), into = effect("fade-in"), overlap = false } = {}) {
  return { id, name: "Change text", kind: "change-text", start, text, overlap, out, in: into };
}

function title(animations = [], overrides = {}) {
  return createLayer("text", { id: "title", name: "Title", x: 100, y: 100, text: "Hello", fontSize: 40, textResize: "width-height", textAlign: "center", animations, ...overrides });
}

const opacities = (drawing) => drawing.units.map(({ state }) => state.opacity);

test("Out then In: the old text fades out, then the new text fades in and stays", () => {
  const layer = title([change(1, "World", { out: effect("fade-out", { duration: 0.5 }), into: effect("fade-in", { duration: 1 }) })]);
  const at = (time) => textDrawingsAt(layer, time).map((drawing) => [drawing.text, drawing.units[0].state.opacity]);
  assert.deepEqual(at(0.5), [["Hello", 1]]);
  assert.deepEqual(at(1), [["Hello", 1]]);
  assert.deepEqual(at(1.25), [["Hello", 0.5]]);
  assert.deepEqual(at(1.5), [["World", 0]], "the new text appears when the Out effect ends");
  assert.deepEqual(at(2), [["World", 0.5]]);
  assert.deepEqual(at(3), [["World", 1]]);
  assert.equal(shownTextAt(layer, 1.49), "Hello");
  assert.equal(shownTextAt(layer, 1.5), "World");
  assert.deepEqual(textDrawingsAt(title(), 1), [], "a layer without a Change text draws as before");
});

test("with Overlap both strings are drawn while the effects run, oldest first", () => {
  const layer = title([change(1, "World", { overlap: true, out: effect("fade-out", { duration: 0.5 }), into: effect("fade-in", { duration: 1 }) })]);
  const drawings = textDrawingsAt(layer, 1.25);
  assert.deepEqual(drawings.map((drawing) => [drawing.text, drawing.units[0].state.opacity]), [["Hello", 0.5], ["World", 0.25]]);
  assert.deepEqual(textDrawingsAt(layer, 1.5).map((drawing) => drawing.text), ["World"], "the old text is gone when its Out effect ends");
  assert.equal(shownTextAt(layer, 1.25), "World", "the canvas outline follows the newest string");
});

test("two chained changes: each string plays its own effects", () => {
  const layer = title([change(1, "Two", { id: "a" }), change(2, "Three", { id: "b", out: effect("blur-out", { duration: 0.4 }), into: null })]);
  assert.deepEqual(textDrawingsAt(layer, 1.9).map((drawing) => drawing.text), ["Two"]);
  const blurring = textDrawingsAt(layer, 2.2);
  assert.deepEqual(blurring.map((drawing) => drawing.text), ["Two"]);
  close(blurring[0].units[0].state.blur, 8, "half way through Blur Out");
  close(blurring[0].units[0].state.opacity, 1, "In effect done");
  // No In effect: the last text shows plainly once the Out effect ends.
  const last = textDrawingsAt(layer, 2.4);
  assert.deepEqual(last.map((drawing) => [drawing.text, drawing.units[0].state.opacity, drawing.units[0].state.blur]), [["Three", 1, 0]]);
});

test("a letter-by-letter In effect staggers the new text's letters, in either order", () => {
  const into = effect("fade-in", { duration: 0.5, unit: "letters", stagger: 0.1 });
  const layer = title([change(1, "Hey", { out: null, into })]);
  const [drawing] = textDrawingsAt(layer, 1.25);
  assert.equal(drawing.text, "Hey");
  assert.equal(drawing.mode, "letters");
  assert.deepEqual(drawing.units.map(({ unit }) => unit.text), ["H", "e", "y"]);
  opacities(drawing).forEach((value, index) => close(value, [0.5, 0.3, 0.1][index], `letter ${index}`));
  const reverse = title([change(1, "Hey", { out: null, into: { ...into, order: "reverse" } })]);
  opacities(textDrawingsAt(reverse, 1.25)[0]).forEach((value, index) => close(value, [0.1, 0.3, 0.5][index], `reverse letter ${index}`));
  // A Slide by words moves each word on its own; the old text (no effect by units) is one unit.
  const slide = title([change(1, "Two words", { overlap: true, into: effect("slide-up", { unit: "words", stagger: 0.3, distance: 40 }) })]);
  const [old, words] = textDrawingsAt(slide, 1.3);
  assert.equal(old.units.length, 1);
  assert.deepEqual(words.units.map(({ unit }) => unit.text), ["Two ", "words"]);
  const y = words.units.map(({ state }) => state.y);
  assert.ok(y[0] < y[1], "the first word has travelled further up");
  close(y[1] - y[0], 40 * 0.5, "the second word starts 0.3 s later");
  // A range selector times the letters over the effect's own duration in place of the stagger.
  const typed = title([change(1, "Hey", { out: null, into: effect("fade-in", { duration: 0.5, unit: "letters", range: { shape: "square", start: 0, end: [0, 1], smoothness: 1 } }) })]);
  opacities(textDrawingsAt(typed, 1.25)[0]).forEach((value, index) => close(value, [1, 0.5, 0][index], `typed letter ${index}`));
  opacities(textDrawingsAt(typed, 1.5)[0]).forEach((value, index) => close(value, 1, `typed letter ${index} at the end`));
});

test("the layer's own animations apply to whichever string is drawn, unit by unit", () => {
  const move = { id: "move", name: "Move", kind: "custom", start: 0, duration: 2, easing: "linear", from: { rotation: 0 }, to: { rotation: 20 }, unit: "letters", stagger: 0, order: "forward" };
  const layer = title([move, change(1, "Hi", { overlap: true, into: effect("fade-in", { unit: "words" }) })]);
  const drawings = textDrawingsAt(layer, 1.5);
  assert.deepEqual(drawings.map((drawing) => drawing.mode), ["letters", "letters"], "the finest of the layer's and the effects' units");
  for (const drawing of drawings) for (const { state } of drawing.units) close(state.rotation, 15, `${drawing.text} turned`);
  // Plans map each letter to its word for the In effect.
  const plan = textStringPlans(layer).find((item) => item.text === "Hi");
  assert.equal(plan.inUnits.count, 1);
  assert.equal(plan.ownUnits.count, 2);
});

test("auto-size text: each string gets its own box at the layer's alignment anchor", () => {
  for (const [textAlign, anchor] of [["left", 0], ["center", 0.5], ["right", 1]]) {
    const base = title([], { textAlign, text: "Hi" });
    const stored = resizeTextLayer(base);
    const layer = { ...stored, animations: [change(1, "A much longer line", { overlap: true })] };
    const [old, next] = textDrawingsAt(layer, 1.3);
    const oldState = old.units[0].state;
    const newState = next.units[0].state;
    close(oldState.width, layoutText({ ...layer, text: "Hi" }).width, `${textAlign}: old box fits its text`);
    close(newState.width, layoutText({ ...layer, text: "A much longer line" }).width, `${textAlign}: new box fits its text`);
    assert.ok(newState.width > oldState.width * 3);
    const point = (state) => state.x + state.width * anchor;
    close(point(oldState), stored.x + stored.width * anchor, `${textAlign}: old anchor stays`);
    close(point(newState), stored.x + stored.width * anchor, `${textAlign}: new anchor is the same`);
  }
});

test("the editor and raster exports draw the strings shown, and the Design view the layer's own text", () => {
  const layer = title([change(1, "World", { overlap: true })]);
  const scene = createScene({ id: "main", name: "Main", duration: 3, ...SCENE, layers: [layer] });
  const labels = (svg) => [...svg.matchAll(/role="img" aria-label="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(labels(renderSceneSvg(scene, 0.5)), ["Hello"]);
  const both = renderSceneSvg(scene, 1.3);
  assert.deepEqual(labels(both), ["Hello", "World"]);
  const groups = [...both.matchAll(/<g opacity="([^"]*)" transform/g)].map((match) => Number(match[1]));
  assert.equal(groups.length, 2);
  close(groups[0] + groups[1], 1, "one fades out as the other fades in (linear, same duration)");
  assert.deepEqual(labels(renderSceneSvg(scene, 2)), ["World"]);
  // The Design canvas shows the text the Design tab edits.
  assert.doesNotMatch(renderSceneSvg(scene, 2, { design: true }), /aria-label="World"/);
  // A turned-off change draws nothing new.
  const off = createScene({ ...scene, layers: [{ ...layer, animations: [{ ...layer.animations[0], enabled: false }] }] });
  assert.doesNotMatch(renderSceneSvg(off, 2), /World/);
});
