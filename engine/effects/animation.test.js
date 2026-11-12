import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLayer } from "../animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "../model.js";
import { applyOperations } from "../operations.js";
import { DOCUMENT_VERSION } from "../schema.js";
import { effectDefaults, effectInitialValues } from "./catalog.js";
import { createEffectAnimation, effectsAt, normalizeEffectAnimation } from "./animation.js";

const box = (values = {}) => createLayer("rectangle", { id: "box", name: "Box", width: 120, height: 80, ...values });
const sceneFor = (layer, values = {}) => createScene({ id: "scene", name: "Scene", duration: 4, layers: [layer], ...values });
const documentFor = (layer, sceneValues = {}) => createDocument({ id: "doc", name: "Document", scenes: [sceneFor(layer, sceneValues)] });

function operation(id, key, values = {}) {
  return normalizeEffectAnimation({
    id,
    name: id,
    kind: "effect",
    effect: key,
    start: 0,
    duration: 1,
    easing: "linear",
    to: effectDefaults(key),
    ...values,
  });
}

function layerWith(animations, values = {}) {
  return box({ ...values, animations });
}

test("version 5 migrates effect animations to version 6 without changing values; future versions refuse", () => {
  assert.equal(DOCUMENT_VERSION, 6);
  const saved = operation("saved-effect", "bulge", {
    start: 0.75,
    duration: 0.65,
    from: { amount: -0.5 },
    to: { amount: 1.5 },
    intensity: 35,
    enabled: false,
  });
  const current = parseDocument(documentFor(layerWith([saved])));
  const old = { ...structuredClone(current), version: 5 };
  const upgraded = parseDocument(old);
  assert.equal(upgraded.version, 6);
  assert.deepEqual(upgraded.scenes[0].layers[0].animations, current.scenes[0].layers[0].animations);
  assert.deepEqual(upgraded.scenes[0].layers[0].animations[0], saved);
  assert.throws(() => parseDocument({ ...current, version: 7 }), /version.*must be 6/);
});

test("effect normalization refuses unrelated animation fields and model input refuses audio effects", () => {
  for (const [key, value] of [["unit", "letters"], ["preset", {}], ["anchor", "center"], ["motionPath", {}], ["fromCurrent", true], ["shadowChannels", ["x"]]])
    assert.throws(() => normalizeEffectAnimation({ ...operation("bad", "bulge"), [key]: value }), new RegExp(`${key} is not an effect animation field`));
  // One of the effect's own settings beside start and duration says where it goes.
  assert.throws(() => normalizeEffectAnimation({ ...operation("bad", "bulge"), amount: 0.4 }), {
    message: 'amount is a bulge setting, not an animation field: put it in to (and from), such as to:{"amount":0.4}',
  });
  assert.throws(() => parseDocument(documentFor(createLayer("audio", {
    id: "sound", src: "/api/media/sound.wav", animations: [operation("audio-effect", "bulge")],
  }))), /Effects need a layer that is drawn/);
});

test("effect parameter validation is enforced by model normalization", () => {
  for (const invalid of [
    { effect: "unknown", to: {} },
    { effect: "bulge", to: { amount: 3 } },
    { effect: "bulge", to: { amount: 0, stray: 1 } },
    { effect: "displacement", to: { ...effectDefaults("displacement"), direction: "diagonal" } },
    { effect: "fluid-warp", to: { ...effectDefaults("fluid-warp"), octaves: 2.5 } },
    { effect: "ripple", to: { ...effectDefaults("ripple"), strength: "0.2" } },
  ]) {
    const animations = [{ ...operation("invalid", "bulge"), ...invalid }];
    assert.throws(() => parseDocument(documentFor(layerWith(animations))));
  }
  assert.throws(() => normalizeEffectAnimation({ ...operation("invalid", "bulge"), keepStill: "sometimes" }), /only available on ranged/);
});

test("the effect factory starts value effects at the playhead and ranged effects over the scene", () => {
  const layer = box(), scene = { duration: 3 };
  const value = createEffectAnimation("bulge", layer, 1.25, scene, "bulge-id", { amount: 1.5 });
  assert.deepEqual([value.name, value.kind, value.effect, value.start, value.duration, value.to], ["Bulge", "effect", "bulge", 1.25, 0.8, { amount: 1.5 }]);
  assert.deepEqual(effectInitialValues("bulge"), {});
  assert.equal(Object.hasOwn(value, "from"), false, "effects without initial metadata omit From");
  assert.equal(Object.hasOwn(value, "keepStill"), false);

  const clippedValue = createEffectAnimation("bulge", layer, 9, { duration: 2 }, "clipped-id");
  assert.deepEqual([clippedValue.start, clippedValue.duration], [1.999, 0.001], "a value effect fits at the scene end");
  const ranged = createEffectAnimation("fluid-warp", layer, 9, scene, "ranged-id", { amount: 40 });
  assert.deepEqual([ranged.start, ranged.duration, ranged.keepStill], [0, 3, "both"]);
  assert.equal(ranged.to.amount, 40);
  assert.throws(() => createEffectAnimation("bulge", { ...layer, type: "audio" }, 0, scene, "audio-id"), /drawn/);
});

test("value effects sample neutral or previous same-effect values and explicit From takes precedence", () => {
  const first = operation("first", "bulge", { start: 0, duration: 1, from: { amount: 0 }, to: { amount: 1 } });
  const inherited = operation("inherited", "bulge", { start: 2, duration: 1, to: { amount: -1 } });
  const explicit = operation("explicit", "bulge", { start: 4, duration: 1, from: { amount: 0.25 }, to: { amount: 1 } });
  const layer = layerWith([first, inherited, explicit]);
  const atFirst = effectsAt(layer, 0)[0];
  assert.equal(atFirst.parameters.amount, 0, "the first value operation begins at the neutral amount");
  assert.equal(effectsAt(layer, 2)[0].parameters.amount, 1, "an omitted From inherits the earlier finished value");
  assert.equal(effectsAt(layer, 4)[0].parameters.amount, 0.25);
});

test("a value effect with peak rises to To and returns to From inside its window", () => {
  const pulse = operation("pulse", "bulge", { from: { amount: 0 }, to: { amount: 1 }, peak: 0.25 });
  const layer = layerWith([pulse]);
  assert.deepEqual([0, 0.125, 0.25, 0.625, 1, 2].map((time) => effectsAt(layer, time)[0].parameters.amount), [0, 0.5, 1, 0.5, 0, 0]);
  assert.equal(operation("back", "bulge", { return: true }).peak, 0.35, "return alone peaks at the default share");
  assert.throws(() => operation("bad", "bulge", { peak: 1 }), /0.05 to 0.95/);
  assert.throws(() => operation("ranged", "fluid-warp", { peak: 0.5 }), /ranged effect/);
});

test("omitted and null optional From and intensity stay absent while partial From values normalize", () => {
  const omitted = operation("omitted", "bulge", { from: null, intensity: null });
  assert.equal(Object.hasOwn(omitted, "from"), false);
  assert.equal(Object.hasOwn(omitted, "intensity"), false);
  const partial = operation("partial", "bulge", { from: { amount: -0.25 }, intensity: 65 });
  assert.deepEqual(partial.from, { amount: -0.25 });
  assert.deepEqual(partial.to, { amount: 1 });
  assert.equal(partial.intensity, 65);
});

test("overlapping and same-start value effects replace by saved order while ranged effects stack", () => {
  const early = operation("early", "bulge", { start: 0, duration: 2, from: { amount: 0 }, to: { amount: 2 } });
  const overlap = operation("overlap", "bulge", { start: 1, duration: 2, from: { amount: -1 }, to: { amount: 1 } });
  const sameStart = operation("same-start", "bulge", { start: 1, duration: 2, to: { amount: 0 } });
  const rangedA = operation("ranged-a", "fluid-warp", { start: 0, duration: 4, keepStill: "both" });
  const rangedB = operation("ranged-b", "fluid-warp", { start: 1, duration: 4, keepStill: "both" });
  const active = effectsAt(layerWith([early, overlap, sameStart, rangedA, rangedB]), 1.5);
  assert.deepEqual(active.filter(({ effect }) => effect.key === "bulge").map(({ operation: item }) => item.id), ["same-start"]);
  assert.deepEqual(active.filter(({ effect }) => effect.key === "fluid-warp").map(({ operation: item }) => item.id), ["ranged-a", "ranged-b"]);
  assert.equal(active.find(({ operation: item }) => item.id === "same-start").parameters.amount, -0.75);
});

test("Keep still modes define before/start/0.99/end/after samples and hold a frozen clock", () => {
  const expected = {
    off: [false, true, true, false, false],
    start: [true, true, true, false, false],
    end: [false, true, true, true, true],
    both: [true, true, true, true, true],
  };
  const times = [0.5, 1, 1.99, 2, 2.5];
  for (const [keepStill, presence] of Object.entries(expected)) {
    const ranged = operation(`ranged-${keepStill}`, "fluid-warp", {
      start: 1, duration: 1, keepStill, to: { ...effectDefaults("fluid-warp"), speed: 1 },
    });
    const layer = layerWith([ranged]);
    const samples = times.map((time) => effectsAt(layer, time)[0] ?? null);
    assert.deepEqual(samples.map(Boolean), presence, keepStill);
    if (samples[0]) assert.deepEqual([samples[0].time, samples[0].progress], [0, 0], `${keepStill}: before holds at start`);
    assert.deepEqual([samples[1].time, samples[1].progress], [0, 0], `${keepStill}: start`);
    assert.ok(Math.abs(samples[2].progress - 0.99) < 1e-10, `${keepStill}: 0.99 sample`);
    if (samples[3]) assert.deepEqual([samples[3].time, samples[3].progress], [1, 1], `${keepStill}: end`);
    if (samples[4]) assert.deepEqual([samples[4].time, samples[4].progress], [1, 1], `${keepStill}: after remains frozen`);
  }
});

test("disabled and composed effects use enabled absolute member clocks; playback windows freeze component time", () => {
  const disabled = operation("disabled", "bulge", { enabled: false });
  const child = operation("child", "bulge", { start: 0.25, duration: 1, to: { amount: 1 } });
  const group = { id: "group", name: "Group", kind: "composed", start: 2, animations: [child] };
  const layer = layerWith([disabled, group]);
  const active = effectsAt(layer, 2.75);
  assert.deepEqual(active.map(({ operation: item }) => item.id), ["child"]);
  assert.equal(active[0].operation.start, 2.25);
  assert.equal(active[0].progress, 0.5);
  assert.deepEqual(effectsAt(layerWith([disabled, { ...group, enabled: false }]), 2.75), []);

  const long = operation("long", "fluid-warp", { start: 0, duration: 10, keepStill: "both" });
  const windowed = layerWith([long], { playbackWindows: [{ start: 2, end: 4, hold: true, visibility: "both" }] });
  const held = effectsAt(windowed, 5)[0];
  assert.deepEqual([held.time, held.progress], [4, 0.4]);
  assert.deepEqual(effectsAt(layerWith([long], { playbackWindows: [{ start: 2, end: 4, visibility: "during" }] }), 5), []);
});

test("evaluateLayer does not treat effect parameters as ordinary animated layer properties", () => {
  const source = layerWith([operation("warp", "fluid-warp", { start: 0, duration: 1 })]);
  const evaluated = evaluateLayer(source, 0.5);
  for (const key of ["amount", "noiseScale", "octaves", "speed", "contain", "effect", "parameters"])
    assert.equal(Object.hasOwn(evaluated, key), false, `${key} stays out of the ordinary layer state`);
  assert.equal(evaluated.x, source.x);
  assert.equal(evaluated.width, source.width);
});

test("applyOperations adds, updates and deletes effects; rejected batches leave the source unchanged", () => {
  const source = documentFor(box());
  const added = applyOperations(source, [{
    type: "add_animation", sceneId: "scene", layerId: "box", effect: "bulge", start: 0.5,
    parameters: { amount: 1.25 },
  }]);
  const addedAnimation = added.scenes[0].layers[0].animations[0];
  assert.deepEqual([addedAnimation.kind, addedAnimation.effect, addedAnimation.start, addedAnimation.to], ["effect", "bulge", 0.5, { amount: 1.25 }]);
  assert.equal(source.scenes[0].layers[0].animations.length, 0);

  const updated = applyOperations(added, [{
    type: "update_animation", sceneId: "scene", layerId: "box", animationId: addedAnimation.id,
    properties: { to: { amount: -0.5 }, duration: 1, easing: "ease-in" },
  }]);
  const updatedAnimation = updated.scenes[0].layers[0].animations[0];
  assert.deepEqual([updatedAnimation.to, updatedAnimation.duration, updatedAnimation.easing], [{ amount: -0.5 }, 1, "ease-in"]);

  const deleted = applyOperations(updated, [{
    type: "delete_animation", sceneId: "scene", layerId: "box", animationId: addedAnimation.id,
  }]);
  assert.deepEqual(deleted.scenes[0].layers[0].animations, []);

  const snapshot = structuredClone(source);
  assert.throws(() => applyOperations(source, [
    { type: "rename_project", name: "must roll back" },
    { type: "add_animation", sceneId: "scene", layerId: "box", effect: "not-real" },
  ]), /Unknown effect/);
  assert.deepEqual(source, snapshot, "failed add batches do not mutate the input");
  assert.throws(() => applyOperations(added, [
    { type: "rename_project", name: "must roll back" },
    { type: "update_animation", sceneId: "scene", layerId: "box", animationId: addedAnimation.id, properties: { to: { amount: 5 } } },
  ]), /amount.*from -2 to 2/);
  assert.equal(added.name, "Document");
  assert.equal(added.scenes[0].layers[0].animations[0].to.amount, 1.25);
  assert.throws(() => applyOperations(added, [
    { type: "rename_project", name: "must roll back" },
    { type: "delete_animation", sceneId: "scene", layerId: "box", animationId: "missing" },
  ]), /not found/);
  assert.equal(added.name, "Document");
  assert.equal(added.scenes[0].layers[0].animations.length, 1);
});
