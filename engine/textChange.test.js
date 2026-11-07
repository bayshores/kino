// The Change text operation (textChange.js): its data and checks, its timing, and how the
// editor's edits (Timeline drag and stagger, copy and paste, apply_operations) treat it.
import test from "node:test";
import assert from "node:assert/strict";
import { operationStaggerItems, staggerPlan } from "./stagger.js";
import {
  createTextEffect,
  slideDistance,
  textChangeEffectSeconds,
  textChangeLength,
  textChangeSchedule,
  textChangeSpans,
  textChangeTimeProblem,
} from "./textChange.js";
import { PRESETS, presetAnimation } from "./animation.js";
import { MAX_TIME, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { copyAnimations, duplicateLayers, pasteAnimations } from "./layerClipboard.js";
import { animationPlaybackLength, getScenePlaybackDuration } from "./playback.js";
import { isAnimationCompatible } from "./animationCompatibility.js";

const SCENE = { width: 800, height: 600 };

function effect(preset, overrides = {}) {
  return { ...createTextEffect(preset, preset.endsWith("-out") ? "out" : "in", SCENE), easing: "linear", ...overrides };
}

function change(start, text, { id = `change-${start}`, out = effect("fade-out"), into = effect("fade-in"), overlap = false, enabled } = {}) {
  return { id, name: "Change text", kind: "change-text", start, text, overlap, out, in: into, ...(enabled === false ? { enabled: false } : {}) };
}

function title(animations = [], overrides = {}) {
  return createLayer("text", { id: "title", name: "Title", x: 100, y: 100, text: "Hello", fontSize: 40, textResize: "width-height", textAlign: "center", animations, ...overrides });
}

function documentWith(layers, duration = 4) {
  return parseDocument({ ...createDocument(), scenes: [createScene({ id: "main", name: "Main", duration, ...SCENE, layers })] });
}

test("the Change text preset is a text-only custom preset that fades the old text out and the new text in", () => {
  const preset = PRESETS.find((item) => item.id === "change-text");
  assert.equal(preset.name, "Change text");
  const layer = title();
  const added = presetAnimation("change-text", layer, 1.5, SCENE);
  assert.equal(added.kind, "change-text");
  assert.equal(added.start, 1.5);
  assert.equal(added.text, "Hello", "starts as the layer's own text, ready to type over");
  assert.equal(added.overlap, false);
  assert.deepEqual(added.out, { preset: "fade-out", duration: 0.6, easing: "smooth", unit: "layer", stagger: 0, order: "forward" });
  assert.deepEqual(added.in, { preset: "fade-in", duration: 0.6, easing: "smooth", unit: "layer", stagger: 0, order: "forward" });
  assert.equal(added.duration, undefined, "no duration of its own");
  assert.throws(() => presetAnimation("change-text", createLayer("rectangle"), 0, SCENE), /text layer/);
  assert.equal(isAnimationCompatible(createLayer("rectangle"), added), false);
  assert.equal(isAnimationCompatible(layer, added), true);
  // A Slide travels as far as the Slide preset animations do.
  assert.equal(createTextEffect("slide-up", "in", SCENE).distance, slideDistance(SCENE, "slide-up"));
  assert.equal(slideDistance(SCENE, "slide-up"), 48);
  assert.equal(slideDistance(SCENE, "slide-left"), 64);
  assert.throws(() => createTextEffect("fade-in", "out", SCENE), /not an Out text effect/);
});

test("an instant swap shows the new text at exactly its time, also on export frames that land just before it", async () => {
  const { shownTextAt } = await import("./textChangeDraw.js");
  const { exportFrameTimes } = await import("./exportOptions.js");
  const layer = title([change(1, "World", { out: null, into: null })]);
  assert.equal(shownTextAt(layer, 0.99), "Hello");
  assert.equal(shownTextAt(layer, 1), "World", "the state at the change's own time is the new text");
  assert.equal(shownTextAt(layer, 3), "World");
  const times = exportFrameTimes(4, 30, { format: "mp4" });
  assert.ok(times[30] < 1, "30 fps frame 30 is sampled just before 1 s");
  assert.equal(shownTextAt(layer, times[30]), "World");
  assert.equal(shownTextAt(layer, times[29]), "Hello");
  // One string at a time: nothing overlaps for an instant swap.
  const schedule = textChangeSchedule(layer);
  assert.deepEqual(schedule.map(({ text, appear, disappear }) => [text, appear, disappear]), [["Hello", -Infinity, 1], ["World", 1, Infinity]]);
});

test("Out then In: the old text plays its Out effect, then the new text appears and plays its In effect", () => {
  const layer = title([change(1, "World", { out: effect("fade-out", { duration: 0.5 }), into: effect("fade-in", { duration: 1 }) })]);
  const [base, next] = textChangeSchedule(layer);
  assert.deepEqual([base.appear, base.disappear, base.out.start], [-Infinity, 1.5, 1]);
  assert.deepEqual([next.appear, next.disappear, next.in.start], [1.5, Infinity, 1.5]);
  assert.equal(textChangeEffectSeconds(layer.animations[0]), 1.5);
  assert.deepEqual(textChangeSpans(layer).get("change-1"), { start: 1, end: 2.5, outEnd: 1.5 });
});

test("with Overlap the In effect starts with the Out effect, and both strings are drawn while they run", () => {
  const layer = title([change(1, "World", { overlap: true, out: effect("fade-out", { duration: 0.5 }), into: effect("fade-in", { duration: 1 }) })]);
  const [base, next] = textChangeSchedule(layer);
  assert.equal(base.disappear, 1.5);
  assert.equal(next.appear, 1);
  assert.equal(textChangeEffectSeconds(layer.animations[0]), 1, "the longer of the two");
  assert.deepEqual(textChangeSpans(layer).get("change-1"), { start: 1, end: 2, outEnd: 1.5 });
});

test("several changes chain in time order, and one turned off is skipped", () => {
  const second = change(2, "Third", { id: "second" });
  const first = change(1, "Second", { id: "first" });
  const layer = title([second, first]);
  assert.deepEqual(textChangeSchedule(layer).map((string) => [string.key, string.text, string.appear, string.disappear]),
    [["base", "Hello", -Infinity, 1.6], ["first", "Second", 1.6, 2.6], ["second", "Third", 2.6, Infinity]]);
  const off = title([second, { ...first, enabled: false }]);
  assert.deepEqual(textChangeSchedule(off).map((string) => [string.key, string.text, string.appear]),
    [["base", "Hello", -Infinity], ["second", "Third", 2.6]]);
  // The Timeline still places the turned-off one, measuring the text shown before it.
  assert.deepEqual(textChangeSpans(off).get("first"), { start: 1, end: 2.2, outEnd: 1.6 });
});

test("a staggered effect plays longer by its stagger between units", () => {
  const layer = title([change(1, "Hey you", { into: effect("fade-in", { unit: "letters", stagger: 0.1 }), out: effect("fade-out", { unit: "words", stagger: 0.2 }) })], { text: "One two three" });
  // Out: three words, 0.6 s + 2 × 0.2 s. In: seven letters (the space counts), 0.6 s + 6 × 0.1 s.
  assert.deepEqual(textChangeSpans(layer).get("change-1"), { start: 1, end: 1 + 1 + 1.2, outEnd: 2 });
  assert.ok(Math.abs(textChangeLength(layer, layer.animations[0]) - 2.2) < 1e-9);
  assert.ok(Math.abs(animationPlaybackLength(layer, layer.animations[0]) - 2.2) < 1e-9);
});

test("a component plays for as long as its Change text effects run", () => {
  const layer = title([change(1, "World")]);
  const document = documentWith([layer], 10);
  assert.ok(Math.abs(getScenePlaybackDuration(document, "main") - 2.2) < 1e-9);
});

test("apply_operations adds, edits and checks Change text", () => {
  const document = documentWith([title(), createLayer("rectangle", { id: "box" })]);
  const added = applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "title", preset: "change-text", start: 1 }]);
  const [stored] = added.scenes[0].layers[0].animations;
  assert.equal(stored.kind, "change-text");
  const edited = applyOperations(added, [{ type: "update_animation", sceneId: "main", layerId: "title", animationId: stored.id, properties: { text: "Bye", overlap: true, out: null, in: { preset: "slide-up", unit: "letters" } } }]);
  const [changed] = edited.scenes[0].layers[0].animations;
  assert.equal(changed.text, "Bye");
  assert.equal(changed.out, null);
  assert.deepEqual(changed.in, { preset: "slide-up", duration: 0.6, easing: "smooth", unit: "letters", stagger: 0, order: "forward", distance: 80 },
    "a new effect replaces the whole effect; left-out settings take their defaults");
  const update = (properties) => applyOperations(added, [{ type: "update_animation", sceneId: "main", layerId: "title", animationId: stored.id, properties }]);
  assert.throws(() => update({ duration: 1 }), /cannot have duration/);
  assert.throws(() => update({ start: 5 }), /outside the scene/);
  assert.throws(() => update({ in: { preset: "fade-out" } }), /in\.preset/);
  // A range selector on an effect, as on an in or out: it needs units and must end every unit at 1.
  const ranged = update({ in: { preset: "fade-in", unit: "letters", range: "typewriter" } }).scenes[0].layers[0].animations[0];
  assert.deepEqual(ranged.in.range, { preset: "typewriter", shape: "square", start: 0, end: [0, 1], smoothness: 1 });
  assert.throws(() => update({ in: { preset: "fade-in", range: "typewriter" } }), /in\.range: requires a unit/);
  assert.throws(() => update({ out: { preset: "fade-out", unit: "words", range: "wave" } }), /out\.range: does not take every unit from 0 to 1/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "box", preset: "change-text" }]), /text layer/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "box", animation: { ...stored, id: "x" } }]), /text layer/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "title", animation: { ...stored, id: "x", start: 4.5 } }]), /outside the scene/);
  // A Change text left past the end of a scene that was made shorter can still be edited.
  const shorter = applyOperations(added, [{ type: "update_animation", sceneId: "main", layerId: "title", animationId: stored.id, properties: { start: 3.5 } }, { type: "update_scene", sceneId: "main", properties: { duration: 2 } }]);
  assert.doesNotThrow(() => applyOperations(shorter, [{ type: "update_animation", sceneId: "main", layerId: "title", animationId: stored.id, properties: { text: "Later" } }]));
});

test("copy and paste keeps a Change text on text layers, and duplicate copies it", () => {
  const document = documentWith([title([change(1, "World", { id: "swap" })]), title([], { id: "other", name: "Other" }), createLayer("rectangle", { id: "box", name: "Box" })]);
  const text = JSON.stringify(copyAnimations(document, "main", ["swap"]));
  const pasted = pasteAnimations(document, "main", ["other", "box"], JSON.parse(text), 2);
  const copy = pasted.document.scenes[0].layers.find((layer) => layer.id === "other").animations[0];
  assert.equal(copy.kind, "change-text");
  assert.equal(copy.start, 2);
  assert.equal(copy.text, "World");
  assert.deepEqual(copy.in, document.scenes[0].layers[0].animations[0].in);
  assert.deepEqual(pasted.skipped.map((item) => [item.layerId, item.reason]), [["box", "Paste a Change text onto a text layer."]]);
  assert.throws(() => pasteAnimations(document, "main", ["other"], JSON.parse(text), 4.5), /outside the scene/);
  const { document: duplicated } = duplicateLayers(document, "main", ["title"]);
  const copies = duplicated.scenes[0].layers.filter((layer) => layer.type === "text" && layer.animations.some((item) => item.kind === "change-text"));
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].animations[0].id, copies[1].animations[0].id);
});

test("a Change text's block runs from its start through both of its effects", () => {
  const layer = title([change(1, "World", { id: "swap" })]);
  assert.ok(Math.abs(animationPlaybackLength(layer, layer.animations[0]) - 1.2) < 1e-9);
});

test("stagger moves a Change text's start and measures its effects", () => {
  const first = title([change(0, "A", { id: "a" })], { id: "first" });
  const second = title([change(0, "B", { id: "b" })], { id: "second" });
  const items = operationStaggerItems([first, second], ["a", "b"]);
  const plan = staggerPlan(items, { delay: 0.5, sceneDuration: 4 });
  assert.equal(plan.problem ?? null, null);
  // The first keeps its start, so only the second changes.
  assert.deepEqual(plan.changes.map((item) => [item.animationId, item.patch]), [["b", { start: 0.5 }]]);
  assert.match(staggerPlan(items, { delay: 3, sceneDuration: 4 }).problem, /longest delay/i);
});

test("the document check fills an effect's defaults and refuses what a Change text can't have", () => {
  const raw = { id: "c", name: "Change text", kind: "change-text", start: 1, text: "Hi", out: { preset: "blur-out" }, in: { preset: "slide-left", unit: "letters" } };
  const [stored] = documentWith([title([raw])]).scenes[0].layers[0].animations;
  assert.deepEqual(stored.out, { preset: "blur-out", duration: 0.6, easing: "smooth", unit: "layer", stagger: 0, order: "forward" });
  assert.deepEqual(stored.in, { preset: "slide-left", duration: 0.6, easing: "smooth", unit: "letters", stagger: 0, order: "forward", distance: 80 });
  assert.equal(stored.overlap, false);
  const refused = (patch, pattern, layer = title) =>
    assert.throws(() => documentWith([layer([{ ...raw, ...patch }])]), pattern);
  refused({ duration: 1 }, /cannot have duration/);
  refused({ from: {} }, /cannot have from/);
  refused({ unit: "letters" }, /cannot have unit/);
  refused({ text: 5 }, /text/);
  refused({ overlap: "yes" }, /overlap/);
  refused({ out: { preset: "fade-in" } }, /out\.preset/);
  refused({ in: { preset: "fade-out" } }, /in\.preset/);
  refused({ in: { preset: "fade-in", distance: 10 } }, /only a Slide/);
  refused({ in: { preset: "fade-in", speed: 2 } }, /not a text effect setting/);
  refused({ in: { preset: "fade-in", duration: 0 } }, /duration/);
  refused({ in: { preset: "fade-in", stagger: 61 } }, /stagger/);
  refused({ in: { preset: "fade-in", unit: "glyphs" } }, /unit/);
  refused({ in: { preset: "fade-in", order: "random" } }, /order/);
  refused({ start: MAX_TIME - 0.5 }, /cannot exceed/);
  refused({}, /needs a text layer/, () => createLayer("rectangle", { id: "box", animations: [raw] }));
  // null (or no) effects: an instant swap.
  const { in: _left, ...withoutIn } = raw;
  const [instant] = documentWith([title([{ ...withoutIn, out: null }])]).scenes[0].layers[0].animations;
  assert.equal(instant.out, null);
  assert.equal(instant.in, null);
});

test("a Change text's start must be on the scene's timeline", () => {
  const animation = change(1, "World", { out: effect("fade-out", { duration: 2 }), into: effect("fade-in", { duration: 3 }) });
  assert.equal(textChangeTimeProblem(animation, 4), "");
  assert.match(textChangeTimeProblem({ ...animation, start: 5 }, 4), /outside the scene/);
  // A new one at the playhead shortens its effects to end by the scene's end.
});
