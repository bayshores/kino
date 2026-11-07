import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FontRegistry } from "./fonts.js";
import { evaluateLayer, operationStagger } from "./animation.js";
import { animationPlaybackLength } from "./playback.js";
import { counterPlaybackLength } from "./counter.js";
import { textChangeLength, textChangeSpans, textEffectLength } from "./textChange.js";
import { textDrawingsAt } from "./textChangeDraw.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { TEXT_SMOOTHING_EASINGS, normalizeSmoothing, randomOrder, rangeValue, textRangeProgress, totalUnitDelay, unitDelay } from "./textTiming.js";

const fontBytes = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
const fonts = new FontRegistry();
fonts.register(fontBytes, { family: "Inter", weight: 400, style: "normal" });
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: expected ${expected}, received ${actual}`);

function textLayer(text, animations = [], id = "text") {
  const layer = createLayer("text", {
    id,
    name: id,
    text,
    x: 20,
    y: 30,
    width: 1000,
    height: 80,
    fontFamily: "Inter",
    fontSize: 24,
    animations,
  });
  return parseDocument(createDocument({
    id: "timing-test",
    scenes: [createScene({ id: "main", width: 1200, height: 200, duration: 8, layers: [layer] })],
  })).scenes[0].layers[0];
}

function effect(preset, overrides = {}) {
  return {
    preset,
    duration: 0.5,
    easing: "linear",
    unit: "letters",
    stagger: 0.2,
    order: "forward",
    ...overrides,
  };
}

function withoutSmoothing(value) {
  const { smoothing, smoothingIntensity, ...legacy } = value;
  return legacy;
}

function changeAnimation({ id = "change", start = 1, text = "WXYZ", out = null, into = null, overlap = false }) {
  return { id, name: "Change text", kind: "change-text", start, text, overlap, out, in: into };
}

function counterAnimation(overrides = {}) {
  return {
    id: "count",
    name: "Counter",
    kind: "counter",
    start: 0,
    duration: 1,
    easing: "linear",
    from: 10,
    to: 11,
    step: 1,
    out: null,
    in: null,
    ...overrides,
  };
}

test("smoothing normalizes through easing rules but excludes unsupported named curves", () => {
  assert.deepEqual(TEXT_SMOOTHING_EASINGS, ["smooth", "natural", "expo-out", "quart-out", "in-out", "ease-out", "ease-in", "linear", "custom"]);
  assert.equal(normalizeSmoothing(null), null);
  assert.equal(normalizeSmoothing(undefined), null);
  assert.equal(normalizeSmoothing("none"), "linear");
  assert.equal(normalizeSmoothing("ease_out"), "ease-out");
  assert.deepEqual(normalizeSmoothing("custom"), [0.5, 0, 0.5, 1]);
  const custom = [0.2, 1.5, 0.8, -1.5];
  const normalized = normalizeSmoothing(custom);
  assert.deepEqual(normalized, custom);
  assert.notEqual(normalized, custom);
  assert.throws(() => normalizeSmoothing("bounce"), /text smoothing/);
});

test("unit delays preserve legacy arithmetic and clamp eased positions to the nominal spread", () => {
  const legacy = { stagger: 0.1, order: "forward" };
  assert.equal(unitDelay(legacy, 2, 4), 0.1 * 2, "omitted smoothing keeps the exact old arithmetic");
  assert.equal(unitDelay({ ...legacy, smoothing: "linear" }, 2, 4), 0.1 * 2);
  assert.equal(unitDelay({ ...legacy, order: "reverse" }, 0, 4), 0.1 * 3);
  assert.equal(unitDelay({ ...legacy, order: "reverse" }, 3, 4), 0);
  assert.equal(unitDelay(legacy, 0, 1), 0);
  assert.equal(unitDelay({ ...legacy, stagger: 0 }, 3, 4), 0);
  assert.equal(unitDelay({ ...legacy, stagger: -0.1 }, 3, 4), 0);

  const middle = unitDelay({ ...legacy, smoothing: "ease-in" }, 2, 4);
  assert.notEqual(middle, unitDelay(legacy, 2, 4), "the middle unit receives a shaped start delay");
  assert.notEqual(
    unitDelay({ ...legacy, smoothing: "ease-in", smoothingIntensity: 0 }, 2, 4),
    unitDelay({ ...legacy, smoothing: "ease-in", smoothingIntensity: 100 }, 2, 4),
    "smoothing intensity changes the delay curve independently",
  );

  const spread = totalUnitDelay({ ...legacy, smoothing: "ease-out" }, 4);
  assert.equal(spread, 0.1 * 3);
  assert.equal(totalUnitDelay(legacy, 1), 0);
  assert.equal(unitDelay({ ...legacy, smoothing: [0.25, 2, 0.75, 2] }, 1, 3), 0.2,
    "custom overshoot clamps to the end of the nominal spread");
  assert.equal(unitDelay({ ...legacy, smoothing: [0.25, -2, 0.75, -2] }, 1, 3), 0,
    "custom undershoot clamps to the start of the nominal spread");
});

test("layer animation evaluation and operationStagger share smoothed unit starts", () => {
  const animation = {
    id: "fade",
    name: "Fade In",
    kind: "in",
    start: 0,
    duration: 1,
    easing: "linear",
    from: { opacity: 0 },
    to: { opacity: 1 },
    unit: "letters",
    stagger: 0.2,
    order: "forward",
    smoothing: "ease-in",
    smoothingIntensity: 50,
  };
  const layer = textLayer("ABCD", [animation]);
  const delay = unitDelay(animation, 2, 4);
  assert.equal(operationStagger(animation, { unit: "letters", unitIndex: 2, unitCount: 4 }), delay);
  const state = evaluateLayer(layer, delay + 0.25, { unit: "letters", unitIndex: 2, unitCount: 4 });
  assert.equal(state.opacity, 0.25, "the selected letter starts at its smoothed offset");

  const old = { ...animation, smoothing: undefined, smoothingIntensity: undefined };
  assert.equal(operationStagger(old, { unit: "letters", unitIndex: 2, unitCount: 4 }), 0.4,
    "documents without smoothing keep their legacy start delay");
});

test("Change text uses smoothed effect offsets without changing its span or timeline length", () => {
  const outgoing = effect("fade-out", { duration: 0.4, stagger: 0.1, order: "reverse", smoothing: "natural", smoothingIntensity: 80 });
  const incoming = effect("fade-in", { duration: 0.5, stagger: 0.2, smoothing: "ease-in", smoothingIntensity: 35 });
  const change = changeAnimation({ id: "change", out: outgoing, into: incoming });
  const layer = textLayer("ABCD", [change]);
  const span = textChangeSpans(layer, fonts).get("change");
  assert.equal(span.start, 1);
  close(span.end, 2.8, "Change text span end");
  close(span.outEnd, 1.7, "Change text Out end");
  close(textEffectLength(incoming, 4), 1.1, "Change text In length");
  close(textChangeLength(layer, change, fonts), 1.8, "Change text length");
  close(animationPlaybackLength(layer, change, fonts), 1.8, "Change text playback length");

  const overlapping = textLayer("ABCD", [changeAnimation({
    id: "overlap",
    out: null,
    into: incoming,
    overlap: true,
  })]);
  const delay = unitDelay(incoming, 2, 4);
  const drawing = textDrawingsAt(overlapping, 1 + delay + incoming.duration * 0.25, fonts).find((item) => item.key === "overlap");
  assert.equal(drawing.units[2].state.opacity, 0.25, "the new string's third letter uses the same smoothed delay");

  const legacy = textLayer("ABCD", [changeAnimation({
    id: "legacy",
    out: withoutSmoothing(outgoing),
    into: withoutSmoothing(incoming),
  })]);
  close(textChangeLength(legacy, legacy.animations[0], fonts), 1.8,
    "omitting smoothing leaves old Change text durations exact");
});

test("Counter nested text effects share smoothed offsets and keep the prior playback span", () => {
  const incoming = effect("fade-in", { duration: 0.4, stagger: 0.3, smoothing: "ease-out", smoothingIntensity: 65 });
  const counter = counterAnimation({ in: incoming });
  const layer = textLayer("10", [counter], "score");
  const playbackLength = counterPlaybackLength(layer, counter, fonts);
  assert.equal(playbackLength, 1.7, "the smoothing curve does not change the duration plus final effect spread");
  assert.equal(animationPlaybackLength(layer, counter, fonts), playbackLength);

  const delay = unitDelay(incoming, 1, 2);
  const drawing = textDrawingsAt(layer, 1 + delay + 0.2, fonts).find((item) => item.text === "11");
  assert.ok(drawing, "the final counter string is drawn after the step");
  close(drawing.units[1].state.opacity, 0.5, "the final number's second character uses the smoothed start delay");

  const legacyCounter = counterAnimation({ in: withoutSmoothing(incoming) });
  const legacyLayer = textLayer("10", [legacyCounter], "legacy-score");
  assert.equal(counterPlaybackLength(legacyLayer, legacyCounter, fonts), playbackLength,
    "omitted smoothing preserves the legacy Counter duration");
});

test("a range selector times every unit of one animation: typewriter, center-out, random and a traveling wave", () => {
  // ArtCraft selectors.rs: 4 units, a square range 0..0.375 with full smoothness fully selects unit 0 and half unit 1.
  assert.equal(rangeValue({ start: 0, end: 0.375 }, 0, 4), 1);
  close(rangeValue({ start: 0, end: 0.375 }, 1, 4), 0.5, "soft edge");
  assert.equal(rangeValue({ start: 0, end: 0.375 }, 2, 4), 0);
  const order = randomOrder(8, 1);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.notDeepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  const at = (range, progress) => [0, 1, 2, 3].map((index) => textRangeProgress(range, progress, index, 4));
  assert.deepEqual(at({ preset: "typewriter" }, 0.5), [1, 1, 0, 0], "typewriter: the first half is in");
  assert.deepEqual(at({ preset: "center-out" }, 0.5), [0, 1, 1, 0], "center-out: the middle first");
  assert.deepEqual(at({ preset: "wave" }, 0).concat(at({ preset: "wave" }, 1)), Array(8).fill(0), "a wave enters and leaves");
  assert.ok(at({ preset: "wave" }, 0.4).some((value) => value > 0.5));

  const typed = (kind, range) => textLayer("ABCD", [{ id: "t", name: "Type", kind, start: 0, duration: 1, easing: "linear",
    from: { opacity: 0 }, to: { opacity: 1 }, unit: "letters", stagger: 0.3, range }]);
  const layer = typed("in", "typewriter");
  assert.equal(layer.animations[0].range.shape, "square", "a preset is saved with its fields");
  const opacity = (index) => evaluateLayer(layer, 0.5, { unit: "letters", unitIndex: index, unitCount: 4 }).opacity;
  assert.deepEqual([0, 1, 2, 3].map(opacity), [1, 1, 0, 0], "the range replaces the stagger");
  assert.equal(animationPlaybackLength(layer, layer.animations[0], fonts), 1);
  assert.throws(() => typed("in", "wave"), /custom animation/);
  assert.throws(() => typed("custom", { shape: "zigzag" }), /shape must be/);
});

test("a wiggly range wanders every unit on smooth seeded noise (EffectCraft's Wiggly selector)", () => {
  const wiggly = (extra, progress, index) => textRangeProgress({ shape: "wiggly", seed: 3, ...extra }, progress, index, 8);
  // Deterministic, bounded, smooth in time; correlation 1 moves every unit together, 0 apart.
  assert.equal(wiggly({}, 0.31, 5), wiggly({}, 0.31, 5));
  const values = Array.from({ length: 40 }, (_, step) => wiggly({}, step / 40, step % 8));
  assert.ok(values.every((value) => value >= -1 && value <= 1) && values.some((value) => value < 0) && values.some((value) => value > 0));
  assert.ok(Math.abs(wiggly({}, 0.5, 2) - wiggly({}, 0.5001, 2)) < 0.01, "smooth");
  assert.equal(wiggly({ correlation: 1 }, 0.4, 0), wiggly({ correlation: 1 }, 0.4, 7));
  assert.notEqual(wiggly({ correlation: 0 }, 0.4, 0), wiggly({ correlation: 0 }, 0.4, 7));
  assert.notEqual(wiggly({ seed: 4 }, 0.4, 1), wiggly({}, 0.4, 1));
  const jitter = (kind, range) => textLayer("ABCD", [{ id: "j", name: "Shake", kind, start: 0, duration: 2, easing: "linear",
    from: { y: 0 }, to: { y: -20 }, unit: "letters", stagger: 0, range }]);
  const layer = jitter("custom", { shape: "wiggly", wiggles: 6, correlation: 0.2 });
  const ys = [0, 1, 2, 3].map((index) => evaluateLayer(layer, 0.7, { unit: "letters", unitIndex: index, unitCount: 4 }).y);
  assert.ok(new Set(ys.map((y) => y.toFixed(3))).size > 1, "letters wander apart");
  assert.throws(() => jitter("in", { shape: "wiggly" }), /custom animation/);
  assert.throws(() => jitter("custom", { shape: "smooth", wiggles: 3 }), /for shape "wiggly"/);
});
