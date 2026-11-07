// When a Counter (counter.js) shows each number and what a text layer with one draws
// (counterSchedule.js, textChangeDraw.js), and how the Counter works with the rest of the editor:
// presets, apply_operations, paste, multi-select, stagger, the playback length and the model.
import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, easingAt, presetAnimation } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { counterFormatOf, counterIndexAt, counterSteps, counterTextAt } from "./counter.js";
import { counterStateAt, easingPieces, fittedEffect, textScheduleAt } from "./counterSchedule.js";
import { copyAnimation, pasteAnimations } from "./layerClipboard.js";
import { MAX_TIME, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { renderSceneSvg } from "./render.js";

import { isStringDrawn } from "./textChange.js";
import { shownTextAt, textDrawingsAt } from "./textChangeDraw.js";

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual}, expected ${expected}`);

function effect(preset, overrides = {}) {
  return { preset, duration: 0.5, easing: "linear", unit: "layer", stagger: 0, order: "forward", ...overrides };
}

function counter(fields = {}) {
  return { id: "count", name: "Counter", kind: "counter", start: 1, duration: 1, easing: "linear", from: 0, to: 10, step: 1, out: null, in: null, ...fields };
}

function change(start, text, { id = `change-${start}`, out = null, into = null } = {}) {
  return { id, name: "Change text", kind: "change-text", start, text, overlap: false, out, in: into };
}

function score(animations = [], overrides = {}) {
  return createLayer("text", { id: "score", name: "Score", x: 100, y: 100, text: "0", fontSize: 40, textResize: "width-height", textAlign: "center", animations, ...overrides });
}

function documentWith(layers, duration = 5) {
  return createDocument({ id: "file", name: "File", scenes: [createScene({ id: "scene", name: "Scene", width: 400, height: 300, duration, layers })] });
}

// The text a Counter shows at `time`, straight from its formula: From plus the eased progress,
// rounded down to whole steps, and exactly To at the end.
function expectedText(layer, item, time) {
  const steps = counterSteps(item);
  const progress = (time - item.start) / item.duration;
  const index = progress >= 1 ? steps.count : counterIndexAt(item, easingAt(item.easing, Math.max(0, progress)), steps);
  return counterTextAt(item, counterFormatOf(layer, item), index, steps);
}

const drawn = (layer, time) => textDrawingsAt(layer, time).map((drawing) => [drawing.text, drawing.units.map(({ state }) => Math.round(state.opacity * 1000) / 1000)]);

test("the number shown is From plus the eased progress, rounded down to whole steps, for every easing", () => {
  const easings = ["linear", "smooth", "ease-in", "ease-out", "natural", "impulse", "overshoot", "elastic", "bounce", "swing", [0.5, -1, 0.5, 2], [0.2, 0, 0.8, 1]];
  for (const easing of easings) {
    const item = counter({ easing, from: 0, to: 100, step: 1 });
    const layer = score([item]);
    for (let time = 1; time <= 2.0001; time += 0.0137)
      assert.equal(shownTextAt(layer, time), expectedText(layer, item, time), `${JSON.stringify(easing)} at ${time}`);
    assert.equal(shownTextAt(layer, 2), "100", `${JSON.stringify(easing)} ends exactly on To`);
    assert.equal(shownTextAt(layer, 3), "100");
  }
});

test("before its start the layer shows its own text, and the last value is exactly To", () => {
  const layer = score([counter({ from: 0, to: 10, step: 3 })], { text: "Score: 7" });
  assert.equal(shownTextAt(layer, 0), "Score: 7");
  assert.equal(shownTextAt(layer, 0.99), "Score: 7");
  assert.equal(shownTextAt(layer, 1), "Score: 0", "From shows at the start");
  assert.equal(shownTextAt(layer, 1.5), "Score: 3");
  assert.equal(shownTextAt(layer, 1.95), "Score: 9");
  assert.equal(shownTextAt(layer, 1.9999), "Score: 9", "the step past 9 is cut short to To at the end");
  assert.equal(shownTextAt(layer, 2), "Score: 10");
  assert.equal(shownTextAt(layer, 10), "Score: 10");
  // The layer's own text is unchanged; the Design canvas still shows it.
  assert.equal(layer.text, "Score: 7");
});

test("a Counter counts down and across zero in the text's format", () => {
  const layer = score([counter({ from: 3, to: -3, step: 1, duration: 6, start: 0 })], { text: "$1,000.00" });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((time) => shownTextAt(layer, time)), ["$3.00", "$2.00", "$1.00", "$0.00", "-$1.00", "-$2.00", "-$3.00"]);
  const padded = score([counter({ from: 997, to: 1001, step: 1, duration: 4, start: 0 })], { text: "0000" });
  assert.deepEqual([0, 1, 2, 3, 4].map((time) => shownTextAt(padded, time)), ["0997", "0998", "0999", "1000", "1001"]);
});

test("at 30 frames per second a Counter from 0 to 30 over one second shows one number per frame", () => {
  const layer = score([counter({ start: 0, from: 0, to: 30, step: 1 })]);
  for (let frame = 0; frame <= 30; frame += 1) {
    const time = frame / 30;
    assert.deepEqual(textDrawingsAt(layer, time).map((drawing) => drawing.text), [String(frame)], `frame ${frame}`);
  }
  // Between frames the number is the one of the earlier frame.
  assert.equal(shownTextAt(layer, 10.5 / 30), "10");
});

test("large counters keep late Bounce reversals inside their reported step intervals", () => {
  const item = counter({ start: 0, from: 0, to: 1_000_000, step: 1, easing: "bounce", intensity: 100 });
  const steps = counterSteps(item);
  const indexAt = (time) => counterIndexAt(item, easingAt(item.easing, time, item.intensity), steps);
  // The former 1024-point turn scan missed a dip just after this time and claimed
  // that 999998 stayed visible across a region where the curve returns to 999997.
  for (const time of [0.9973452753109697, 0.9973609157988442, 0.9985, 0.9991, 0.9997]) {
    const state = counterStateAt(item, time);
    assert.equal(state.index, indexAt(time));
    assert.ok(state.since <= time && state.next > time);
    const end = Math.min(1, state.next);
    for (const part of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      const inside = state.since + (end - state.since) * part;
      assert.equal(indexAt(inside), state.index, `step ${state.index} must remain visible at ${inside}`);
    }
  }
});

test("a huge range is computed directly, without listing its numbers", () => {
  const item = counter({ start: 0, duration: 10, from: 0, to: 1e12, step: 1 });
  const layer = score([item], { text: "1,000" });
  const started = performance.now();
  assert.equal(shownTextAt(layer, 5), "500,000,000,000");
  assert.equal(shownTextAt(layer, 2.5), "250,000,000,000");
  assert.equal(shownTextAt(layer, 10), "1,000,000,000,000");
  const state = counterStateAt(item, 5);
  assert.equal(state.index, 5e11);
  assert.ok(state.since <= 5 && state.next > 5 && state.next - state.since < 1e-6, "each number shows for a tiny moment");
  assert.ok(performance.now() - started < 500, "fast");
});

test("counterStateAt finds when the number appeared and when the next one comes", () => {
  const item = counter({ start: 1, duration: 1, from: 0, to: 4 });
  const state = counterStateAt(item, 1.3);
  assert.equal(state.index, 1);
  close(state.since, 1.25, "1 appears a quarter of the way");
  close(state.next, 1.5, "2 comes halfway");
  assert.equal(state.previous, 0);
  assert.deepEqual(counterStateAt(item, 1.1), { index: 0, since: 1, previous: null, next: counterStateAt(item, 1.1).next });
  assert.equal(counterStateAt(item, 2).index, 4);
  assert.equal(counterStateAt(item, 2).next, Infinity);
  // A non-dividing step: 9 shows until the very end, where 10 replaces it.
  const short = counter({ start: 0, duration: 1, from: 0, to: 10, step: 3 });
  close(counterStateAt(short, 0.95).next, 1, "the last step is at the end");
  assert.equal(counterStateAt(short, 1).previous, 3);
  // Elastic overshoots and comes back: its pieces only go one way each.
  const pieces = easingPieces("elastic");
  assert.ok(pieces.length > 3 && pieces[0] === 0 && pieces[pieces.length - 1] === 1);
  assert.deepEqual(easingPieces("smooth"), [0, 1]);
  assert.deepEqual(easingPieces([0.3, 0, 0.7, 1]), [0, 1]);
  const bouncing = counter({ start: 0, duration: 1, from: 0, to: 100, easing: "bounce" });
  const back = counterStateAt(bouncing, 0.5);
  assert.ok(back.previous > back.index, "bounce counts back down after its first landing");
});

test("each step plays the Out effect on the old number and the In effect on the new one, cut to the time until the next step", () => {
  // Four steps a second: each effect of 0.5 s is made 0.25 s long.
  const layer = score([counter({ start: 1, duration: 1, from: 0, to: 4, out: effect("fade-out"), in: effect("fade-in") })]);
  assert.deepEqual(drawn(layer, 0.5), [["0", [1]]], "before the start: the layer's own text");
  assert.deepEqual(drawn(layer, 1.1), [["0", [1]]], "From is the text already there, so it shows without an effect");
  assert.deepEqual(drawn(layer, 1.25 + 0.125), [["0", [0.5]], ["1", [0.5]]], "halfway through the step's effects");
  assert.deepEqual(drawn(layer, 1.45), [["0", [0.2]], ["1", [0.8]]]);
  assert.deepEqual(drawn(layer, 1.4995).map(([text]) => text), ["1"], "the old number is gone by the next step");
  assert.deepEqual(drawn(layer, 1.5), [["1", [1]], ["2", [0]]]);
  // The last step's effects play in full (0.5 s).
  assert.deepEqual(drawn(layer, 2.25), [["3", [0.5]], ["4", [0.5]]]);
  assert.deepEqual(drawn(layer, 2.5), [["4", [1]]]);
  // A slower Counter keeps the whole effect.
  const slow = score([counter({ start: 0, duration: 2, from: 0, to: 2, out: effect("fade-out"), in: effect("fade-in") })]);
  assert.deepEqual(drawn(slow, 1.25), [["0", [0.5]], ["1", [0.5]]]);
  assert.deepEqual(drawn(slow, 1.6), [["1", [1]]]);
});

test("a From that differs from the text before it plays the effects at the start", () => {
  const layer = score([counter({ start: 1, duration: 1, from: 5, to: 7, out: effect("fade-out"), in: effect("fade-in") })], { text: "0" });
  // Two steps a second: the start's effects are cut to 0.5 s.
  assert.deepEqual(drawn(layer, 1.25), [["0", [0.5]], ["5", [0.5]]]);
  assert.deepEqual(drawn(layer, 1.49), [["0", [0.02]], ["5", [0.98]]]);
  assert.deepEqual(drawn(layer, 1.5).map(([text]) => text), ["5", "6"], "the start's effects end at the first step");
});

test("letter-by-letter effects are fitted with their stagger", () => {
  const fade = effect("fade-in", { unit: "letters", stagger: 0.25, duration: 0.5 });
  // "10" has two letters: 0.5 s + 0.25 s = 0.75 s, fitted to 0.5 s: 0.333 s each, 0.167 s apart.
  const fitted = fittedEffect(fade, 0.5, 2);
  close(fitted.duration, 1 / 3, "duration");
  close(fitted.stagger, 1 / 6, "stagger");
  assert.equal(fittedEffect(fade, 2, 2), fade, "an effect that fits stays the same");
  const layer = score([counter({ start: 0, duration: 1, from: 9, to: 11, in: fade })], { text: "9" });
  // Without an Out effect the old number goes at once.
  const [{ text, units }] = textDrawingsAt(layer, 0.5 + 1 / 6);
  assert.equal(text, "10");
  close(units[0].state.opacity, 0.5, "the first letter is halfway in");
  close(units[1].state.opacity, 0, "the second letter has just started");
});

test("a Counter works with Change text before and after it, and the next operation stops it", () => {
  const layer = score([
    change(0.5, "Ready"),
    counter({ start: 1, duration: 1, from: 0, to: 10 }),
    change(1.5, "Done"),
  ]);
  assert.equal(shownTextAt(layer, 0.6), "Ready");
  assert.equal(shownTextAt(layer, 1), "0");
  assert.equal(shownTextAt(layer, 1.49), "4");
  assert.equal(shownTextAt(layer, 1.5), "Done", "the Change text replaces the number shown at its start");
  assert.equal(shownTextAt(layer, 3), "Done");
  // With an Out effect, the number shown at the Change text's start fades out.
  const fading = score([counter({ start: 0, duration: 1, from: 0, to: 10 }), change(0.5, "Done", { out: effect("fade-out") })]);
  assert.deepEqual(drawn(fading, 0.75), [["5", [0.5]]]);
  assert.deepEqual(drawn(fading, 1), [["Done", [1]]]);
  // A Counter after a Change text counts from its own From, playing its Out effect on the text.
  const after = score([change(0, "Go"), counter({ start: 1, duration: 1, from: 0, to: 2, out: effect("fade-out"), in: effect("fade-in") })]);
  assert.deepEqual(drawn(after, 1.25), [["Go", [0.5]], ["0", [0.5]]]);
  // A Counter turned off is skipped.
  const off = score([counter({ enabled: false })], { text: "7" });
  assert.equal(shownTextAt(off, 1.5), "7");
  assert.deepEqual(textDrawingsAt(off, 1.5), []);
});

test("two Counters chain: the second takes over the number the first shows at its start", () => {
  const layer = score([counter({ id: "a", start: 0, duration: 2, from: 0, to: 100 }), counter({ id: "b", start: 1, duration: 1, from: 500, to: 600 })]);
  assert.equal(shownTextAt(layer, 0.5), "25");
  assert.equal(shownTextAt(layer, 1), "500");
  assert.equal(shownTextAt(layer, 1.5), "550");
  assert.equal(shownTextAt(layer, 3), "600");
  // The strings keep one key per number, so an export can follow each one from frame to frame.
  const keys = textScheduleAt(layer, 1.5).filter((string) => isStringDrawn(string, 1.5)).map((string) => string.key);
  assert.deepEqual(keys, ["b#50"]);
});

test("the editor canvas and raster exports draw the counted number, and the Design view the layer's own text", () => {
  const scene = createScene({ id: "main", name: "Main", width: 400, height: 300, duration: 3, layers: [score([counter({ start: 0, duration: 1, from: 0, to: 10, in: effect("fade-in", { duration: 0.05 }) })], { text: "7" })] });
  const labels = (svg) => [...svg.matchAll(/role="img" aria-label="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(labels(renderSceneSvg(scene, 0.55)), ["5"]);
  assert.deepEqual(labels(renderSceneSvg(scene, 1)), ["10"]);
  assert.deepEqual(labels(renderSceneSvg(scene, 0.525)), ["5"]);
  assert.match(renderSceneSvg(scene, 0.525), /<g opacity="0.5" transform/, "the new number fades in");
  assert.deepEqual(labels(renderSceneSvg(scene, 0.55, { design: true })), ["7"]);
});

test("the Counter preset goes on text with a number and is refused elsewhere with a reason", () => {
  const preset = PRESETS.find((item) => item.id === "counter");
  assert.deepEqual({ ...preset }, { id: "counter", name: "Counter", kind: "custom" });
  const made = presetAnimation("counter", score([], { text: "$42" }), 0.5);
  assert.equal(made.kind, "counter");
  assert.equal(made.from, 42);
  assert.equal(made.to, 142);
  assert.equal(made.start, 0.5);
  assert.throws(() => presetAnimation("counter", score([], { text: "Hello" })), /needs a number in the text/);
  assert.throws(() => presetAnimation("counter", createLayer("rectangle", { id: "box" })), /needs a text layer/);
  assert.equal(isAnimationCompatible(createLayer("rectangle", { id: "box" }), made), false);
  assert.equal(isAnimationCompatible(score(), made), true);
});

test("apply_operations adds, edits and refuses Counters", () => {
  const document = documentWith([score([], { text: "12" }), score([], { id: "hello", text: "Hello" }), createLayer("rectangle", { id: "box", name: "Box" })]);
  const added = applyOperations(document, [{ type: "add_animation", sceneId: "scene", layerId: "score", preset: "counter", start: 1 }]);
  const animation = added.scenes[0].layers[0].animations[0];
  assert.deepEqual({ kind: animation.kind, from: animation.from, to: animation.to, step: animation.step, start: animation.start }, { kind: "counter", from: 12, to: 112, step: 1, start: 1 });
  const edited = applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "score", animationId: animation.id, properties: { from: 100, to: 0, step: 5, in: effect("slide-up", { distance: 20 }) } }]);
  const saved = edited.scenes[0].layers[0].animations[0];
  assert.deepEqual([saved.from, saved.to, saved.step, saved.in.preset], [100, 0, 5, "slide-up"]);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "scene", layerId: "hello", preset: "counter" }]), /“Hello” has no digits/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "scene", layerId: "box", animation: counter() }]), /needs a text layer/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "scene", layerId: "hello", animation: counter() }]), /no digits/);
  assert.throws(() => applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "score", animationId: animation.id, properties: { step: -1 } }]), /Step must be at least/);
  assert.throws(() => applyOperations(added, [{ type: "update_animation", sceneId: "scene", layerId: "score", animationId: animation.id, properties: { unit: "letters" } }]), /unit/);
  // An existing Counter can still be edited after its text lost its number.
  const lost = applyOperations(added, [{ type: "update_layer", sceneId: "scene", layerId: "score", properties: { text: "Score" } }]);
  const renamed = applyOperations(lost, [{ type: "update_animation", sceneId: "scene", layerId: "score", animationId: animation.id, properties: { name: "Count", to: 20 } }]);
  assert.equal(renamed.scenes[0].layers[0].animations[0].to, 20);
  assert.equal(shownTextAt(renamed.scenes[0].layers[0], 2), "20", "it shows the plain number");
});

test("the model keeps a valid Counter and refuses broken ones", () => {
  const parse = (animation, layer = score([animation])) => parseDocument(documentWith([layer]));
  const kept = parse(counter({ out: effect("fade-out"), in: effect("grow-in"), easing: [0.2, 0, 0.8, 1] })).scenes[0].layers[0].animations[0];
  assert.deepEqual(kept, counter({ out: effect("fade-out"), in: effect("grow-in"), easing: [0.2, 0, 0.8, 1] }));
  const { step: _step, ...withoutStep } = counter();
  assert.equal(parse(withoutStep).scenes[0].layers[0].animations[0].step, 1, "Step defaults to 1");
  assert.throws(() => parse(counter(), createLayer("rectangle", { id: "box", animations: [counter()] })), /text layer/);
  assert.throws(() => parse(counter({ unit: "letters" })), /unit/);
  assert.throws(() => parse(counter({ step: 0 })), /Step must be at least/);
  assert.throws(() => parse(counter({ from: "1" })), /from: must be a number/);
  assert.throws(() => parse(counter({ to: 2e12 })), /to: numbers must be finite/);
  assert.throws(() => parse(counter({ from: 1e12, to: -1e12, step: 0.001 })), /at most 1000000000000000 steps/);
  assert.throws(() => parse(counter({ duration: 0 })), /duration/);
  assert.throws(() => parse(counter({ start: MAX_TIME - 0.5, duration: 1 })), new RegExp(String(MAX_TIME)));
  assert.throws(() => parse(counter({ in: effect("fade-out") })), /in/);
  // A saved Counter on a text that lost its number is kept (it shows the plain number).
  assert.equal(parse(counter(), score([counter()], { text: "Score" })).scenes[0].layers[0].animations.length, 1);
});

test("copy and paste keeps a Counter's values and refuses layers without a number", () => {
  const document = documentWith([score([counter()], { text: "5" }), score([], { id: "other", text: "Total: 1" }), score([], { id: "word", text: "Hi" }), createLayer("rectangle", { id: "box", name: "Box" })]);
  const envelope = copyAnimation(document, "scene", "score", "count");
  const result = pasteAnimations(document, "scene", ["other", "word", "box"], envelope, 2);
  const pasted = result.document.scenes[0].layers.find((layer) => layer.id === "other").animations[0];
  assert.deepEqual([pasted.kind, pasted.from, pasted.to, pasted.start], ["counter", 0, 10, 2]);
  assert.notEqual(pasted.id, "count");
  assert.deepEqual(result.skipped.map((item) => [item.layerId, /no digits|needs a text layer/.test(item.reason)]), [["word", true], ["box", true]]);
});
