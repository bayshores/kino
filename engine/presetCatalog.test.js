import test from "node:test";
import assert from "node:assert/strict";
import { catalogEntries, normalizePreset, patchPresetAnimation, PRESET_DEFINITIONS } from "./presetCatalog.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { editSceneAnimations } from "./sceneAnimationEdit.js";
import { resizeTextLayer } from "./textLayout.js";
import { EFFECT_PRESET_DEFINITIONS } from "./effects/presetCatalog.js";
const card = (properties = {}) => createLayer("rectangle", { id: "card", x: 30, y: 40, width: 200, height: 80, opacity: 0.8, ...properties });
const file = (layer) => parseDocument(createDocument({ scenes: [createScene({ id: "main", duration: 5,
  layers: [layer.type === "component" ? { ...layer, componentSceneId: "source" } : layer] }),
  ...(layer.type === "component" ? [createScene({ id: "source", isComponent: true, width: 400, height: 240, layers: [card({ id: "source-card" })] })] : [])] }));
const stored = (document) => document.scenes[0].layers[0].animations[0];

test("catalog filters real actions and generates valid saved presets without changing the source", () => {
  for (const type of ["rectangle", "ellipse", "star", "path", "text", "image", "video", "group", "component"]) {
    const layer = createLayer(type, { id: "card", text: "Count 42", src: "/api/media/fixture.png" });
    const before = structuredClone(layer);
    const entries = catalogEntries(layer);
    assert.ok(entries.some((entry) => entry.id === (type === "text" ? "preset-custom-text" : "custom")));
    assert.equal(entries.some((entry) => entry.tab === "effects"), false);
    assert.equal(entries.some((entry) => entry.id === "change-text"), type === "text");
    for (const entry of entries.filter((entry) => entry.tab === "presets" && entry.id !== "custom")) {
      const animation = presetAnimation(entry.id, layer, 1, null, { parameters: entry.parameters });
      assert.equal(animation.start, 1);
      assert.ok(animation.preset);
      assert.doesNotThrow(() => file({ ...layer, animations: [animation] }));
    }
    assert.deepEqual(layer, before);
  }
  assert.deepEqual(catalogEntries(createLayer("audio")), []);
  assert.ok(catalogEntries(createLayer("text", { text: "No digits" })).find((entry) => entry.id === "counter").disabledReason);
});

// A Blur & Slide exit (and a custom text exit) eased out by default, unlike every other preset
// exit, which is smooth. As entrances they still ease out. (A visual effect preset such as
// dissolve has its own easing.)
test("presets start smooth both ways (fades linear, a whip expo-out in and ease-in out); a mode change swaps a default easing", () => {
  const text = createLayer("text", { id: "words", text: "Hello", x: 30, y: 40 });
  const ids = Object.keys(PRESET_DEFINITIONS).filter((id) => !EFFECT_PRESET_DEFINITIONS[id]);
  assert.ok(ids.includes("blur-slide") && ids.includes("custom-text") && ids.includes("slide"));
  const expected = (id, mode) => id === "whip" ? (mode === "out" ? "ease-in" : "expo-out") : ["appear", "fade", "blink"].includes(id) ? "linear" : "smooth";
  for (const id of ids) {
    assert.equal(presetAnimation(`preset-${id}`, text, 1, null, { mode: "out" }).easing, expected(id, "out"), `${id} out`);
    assert.equal(presetAnimation(`preset-${id}`, text, 1).easing, expected(id, "in"), `${id} in`);
  }
  // Template medians: a slide 0.8 s, a scale 0.7 s, a rotation 1.05 s, a fade 0.5 s.
  assert.deepEqual(["slide", "grow", "rotate", "fade"].map((id) => presetAnimation(`preset-${id}`, card(), 0).duration), [0.8, 0.7, 1.05, 0.5]);
  const whip = { ...presetAnimation("whip-in", card(), 0), id: "w" };
  assert.equal(patchPresetAnimation(whip, { preset: { mode: "out" } }, card()).easing, "ease-in");
  assert.equal(patchPresetAnimation({ ...whip, easing: "smooth" }, { preset: { mode: "out" } }, card()).easing, "smooth");
});

test("preset parameter edits regenerate endpoints and Mode Out holds its effect", () => {
  const layer = card();
  const animation = { ...presetAnimation("blur-slide", layer, 1), id: "travel" };
  assert.deepEqual(animation.from, { y: 80, blur: 20 });
  assert.deepEqual(animation.to, { y: 40, blur: 0 });
  const edited = patchPresetAnimation(animation, { preset: { mode: "out", parameters: { direction: "right", distance: 25, blur: 35 } } }, layer);
  assert.deepEqual(edited.from, { x: 30, blur: 0 });
  assert.deepEqual(edited.to, { x: -20, blur: 35 });
  assert.equal(edited.id, "travel");
  assert.equal(edited.start, 1);
  assert.equal(edited.duration, animation.duration);
  assert.equal(edited.easing, "smooth");
  const posed = evaluateLayer({ ...layer, animations: [edited] }, 4);
  assert.equal(posed.x, -20); assert.equal(posed.blur, 35);
  assert.equal(evaluateLayer({ ...layer, animations: [edited] }, 0).x, 30);
});

// {preset:{parameters:{distance:50}}, to:{y:100}} saved the preset's own to: the sent to was lost.
test("a preset patch sent with a value the preset works out itself is refused, never half kept", () => {
  const layer = card();
  const animation = { ...presetAnimation("slide-up", layer, 1), id: "travel" };
  for (const [key, value] of [["to", { y: 100 }], ["from", { y: 10 }], ["kind", "custom"], ["discrete", { type: "instant" }],
    ["motionPath", { points: [] }], ["anchor", "center"], ["fromCurrent", true]]) {
    assert.throws(() => patchPresetAnimation(animation, { preset: { parameters: { distance: 50 } }, [key]: value }, layer),
      new RegExp(`A preset works out ${key} itself, so they would be lost: send preset without ${key}, or ${key} without preset`), key);
  }
  // Each one alone is kept: the preset's settings, or the value (which makes it a plain animation).
  assert.deepEqual(patchPresetAnimation(animation, { preset: { parameters: { distance: 50 } } }, layer).preset.parameters, { direction: "up", distance: 50 });
  const plain = patchPresetAnimation(animation, { to: { y: 100 } }, layer);
  assert.deepEqual([plain.to, plain.preset], [{ y: 100 }, undefined]);
  assert.deepEqual(patchPresetAnimation(animation, { preset: null, to: { y: 100 } }, layer).to, { y: 100 });
});

// {preset:{mode:"out"}, kind:"out"} was refused as a value the preset works out itself, though a
// kind next to a preset is read as its mode.
test("a kind of in or out next to a preset patch is its mode, and refused only when it disagrees with the mode sent", () => {
  const layer = card();
  const animation = { ...presetAnimation("slide-up", layer, 1), id: "travel" };
  const exit = patchPresetAnimation(animation, { preset: { mode: "out" }, kind: "out", start: 4 }, layer);
  assert.deepEqual([exit.kind, exit.preset.mode, exit.start], ["out", "out", 4]);
  const longer = patchPresetAnimation(animation, { preset: { parameters: { distance: 80 } }, kind: "in" }, layer);
  assert.deepEqual([longer.kind, longer.preset.mode, longer.preset.parameters.distance], ["in", "in", 80]);
  assert.equal(patchPresetAnimation(animation, { preset: { parameters: { distance: 80 } }, kind: "out" }, layer).preset.mode, "out");
  assert.throws(() => patchPresetAnimation(animation, { preset: { mode: "in" }, kind: "out" }, layer), /kind "out" and preset.mode "in" disagree/);
});

// A direction names the entrance's movement into place and an exit reverses it, so a slide out
// with direction up moves down. Its name said "Slide Out ↑" (the direction's arrow), and an agent
// that read it back thought the layer left upward.
test("an exit's name has the arrow of the way it moves, and an old exit name still follows a preset change", () => {
  const layer = card();
  const ways = { up: "↑", down: "↓", left: "←", right: "→" };
  for (const id of ["slide", "blur-slide"]) {
    for (const direction of Object.keys(ways)) {
      for (const mode of ["in", "out"]) {
        const animation = presetAnimation(`preset-${id}`, layer, 0, null, { mode, parameters: { direction } });
        const key = ["up", "down"].includes(direction) ? "y" : "x";
        const step = animation.to[key] - animation.from[key];
        const moved = key === "y" ? (step < 0 ? "up" : "down") : (step < 0 ? "left" : "right");
        assert.equal(animation.name.at(-1), ways[moved], `${id} ${mode} ${direction}: ${animation.name}`);
        assert.equal(moved === direction, mode === "in", `${id} ${mode} ${direction}`);
      }
    }
  }
  assert.equal(presetAnimation("preset-slide", layer, 0, null, { mode: "out", parameters: { direction: "up" } }).name, "Slide Out ↓");
  assert.equal(presetAnimation("preset-wipe", layer, 0, null, { mode: "out", parameters: { direction: "right" } }).name, "Wipe Out ←");
  // An exit saved with the direction's arrow is still kino's name: a preset change renames it.
  const exit = { ...presetAnimation("preset-slide", layer, 1, null, { mode: "out", parameters: { direction: "up" } }), id: "leave", name: "Slide Out ↑" };
  assert.equal(patchPresetAnimation(exit, { preset: { parameters: { direction: "left" } } }, layer).name, "Slide Out →");
  assert.equal(patchPresetAnimation({ ...exit, name: "Leave" }, { preset: { parameters: { direction: "left" } } }, layer).name, "Leave");
});

test("manual endpoint edits detach metadata but timing edits and legacy endpoint documents remain exact", () => {
  const animation = presetAnimation("slide-up", card(), 0);
  const document = file(card({ animations: [animation] }));
  const timed = editSceneAnimations(document, "main", [{ layerId: "card", animationId: animation.id, patch: { start: 1, duration: 2 } }]);
  assert.deepEqual(stored(timed).preset, stored(document).preset);
  assert.deepEqual(stored(timed).from, stored(document).from);
  const manual = editSceneAnimations(timed, "main", [{ layerId: "card", animationId: animation.id, patch: { to: { y: 123 } } }]);
  assert.equal(stored(manual).preset, undefined); assert.equal(stored(manual).to.y, 123);
  const legacy = structuredClone(manual); const before = JSON.stringify(legacy);
  assert.equal(JSON.stringify(parseDocument(legacy)), before);
});

test("MCP add/update/multi-update use the same validated regeneration and reject malformed input atomically", () => {
  const source = file(card());
  const document = applyOperations(source, [{ type: "add_animation", sceneId: "main", layerId: "card", preset: "blur-slide", start: 0.5,
    mode: "out", parameters: { direction: "left", distance: 40, blur: 30 }, duration: 1.5 }]);
  const first = stored(document);
  assert.equal(first.kind, "out"); assert.deepEqual(first.to, { x: 110, blur: 30 }); assert.equal(first.duration, 1.5);
  const edit = { type: "update_animation", sceneId: "main", layerId: "card", animationId: first.id, properties: { preset: { parameters: { distance: 80 } } } };
  assert.equal(stored(applyOperations(document, [edit])).to.x, 190);
  const multi = applyOperations(document, [{ type: "update_animations", sceneId: "main", animationIds: [first.id], properties: edit.properties }]);
  assert.equal(stored(multi).to.x, 190);
  for (const bad of [{ id: "unknown" }, { parameters: { distance: "5" } }, { parameters: { bogus: 3 } }, { parameters: [] }, { parameters: null }, { mode: "both" }])
    assert.throws(() => applyOperations(document, [{ ...edit, properties: { preset: bad } }]));
  assert.deepEqual(stored(document), first);
  assert.throws(() => normalizePreset({ id: "__proto__" }));
  assert.throws(() => normalizePreset({ id: "blink", parameters: { count: 2.5 } }));
  assert.throws(() => presetAnimation("blur", card(), 0, null, { parameters: { blur: 3 } }), /Custom animations/);
});

test("preset-fade on a sound layer is a Volume fade; other presets there name the working call", () => {
  const song = file(createLayer("audio", { id: "song", src: "/api/media/song.mp3", volume: 0.8 }));
  const faded = stored(applyOperations(song, [{ type: "add_animation", sceneId: "main", layerId: "song", preset: "preset-fade", mode: "out", start: 4 }]));
  assert.deepEqual([faded.kind, faded.from, faded.to], ["out", { volume: 0.8 }, { volume: 0 }]);
  assert.throws(() => applyOperations(song, [{ type: "add_animation", sceneId: "main", layerId: "song", preset: "preset-slide", start: 4 }]), /only preset-fade works/);
});

test("Appear is instantaneous and Blink switches full opacity, including pre-start, final state and Out", () => {
  for (const mode of ["in", "out"]) {
    const appear = { ...presetAnimation("appear", card(), 1, null, { mode }), easing: "linear" };
    const layer = card({ animations: [appear] });
    assert.equal(evaluateLayer(layer, 0.9).opacity, mode === "in" ? 0 : 0.8);
    assert.equal(evaluateLayer(layer, 1).opacity, mode === "in" ? 0.8 : 0);
    const blink = { ...presetAnimation("blink", card(), 1, null, { mode, parameters: { count: 3 } }), easing: "linear", duration: 1 };
    const blinking = card({ animations: [blink] });
    const samples = [0.01, 0.2, 0.3, 0.5, 0.6, 0.75, 0.9, 1.01].map((time) => evaluateLayer(blinking, 1 + time).opacity);
    assert.deepEqual(samples, (mode === "in" ? [0,1,0,1,0,1,0,1] : [1,0,1,0,1,0,1,0]).map((value) => value * 0.8));
    assert.equal(stored(file(blinking)).discrete.count, 3);
  }
  const invalid = { ...presetAnimation("move", card()), discrete: { type: "blink", count: 3 } };
  assert.throws(() => file(card({ animations: [invalid] })), /opacity only/);
});

test("preset distances use the real auto-text and linked component box through editor and MCP edits", () => {
  const component = createLayer("component", { id: "card", componentSceneId: "source", width: 10, height: 10, y: 20 });
  const document = file(component);
  const added = applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "card", preset: "slide-up", parameters: { distance: 50 } }]);
  assert.equal(stored(added).from.y, 140, "uses half the source scene's 240px height");
  const edited = editSceneAnimations(added, "main", [{ layerId: "card", animationId: stored(added).id, patch: { preset: { parameters: { distance: 25 } } } }]);
  assert.equal(stored(edited).from.y, 80);
  const text = createLayer("text", { id: "text", text: "Hello", textResize: "width-height", width: 1, height: 1, fontSize: 40 });
  const slide = presetAnimation("slide-left", text);
  assert.ok(slide.from.x - slide.to.x > 20, "auto text measures content before setting travel distance");
  for (const textAlign of ["center", "right"]) for (const verticalAlign of ["middle", "bottom"]) {
    const anchored = { ...text, x: 100, y: 150, textAlign, verticalAlign };
    const design = resizeTextLayer(anchored);
    for (const id of ["slide-left", "slide-up", "blur-slide"]) {
      const animation = presetAnimation(id, anchored);
      const end = resizeTextLayer(evaluateLayer({ ...anchored, animations: [animation] }, 2));
      assert.deepEqual([end.x, end.y, end.width, end.height], [design.x, design.y, design.width, design.height], `${id} anchor applied once`);
    }
  }
});

test("a fade on a layer stored hidden (opacity 0) fades to full, not from 0 to 0", () => {
  const hidden = createLayer("rectangle", { id: "r", width: 10, height: 10, opacity: 0 });
  for (const [id, mode, from, to] of [["preset-fade", "in", 0, 1], ["preset-fade", "out", 1, 0], ["opacity", undefined, 0, 1]]) {
    const animation = presetAnimation(id, hidden, 0, undefined, mode ? { mode } : {});
    assert.deepEqual([animation.from.opacity, animation.to.opacity], [from, to], `${id} ${mode ?? ""}`);
  }
  const half = presetAnimation("preset-fade", { ...hidden, opacity: 0.4 }, 0, undefined, { mode: "in" });
  assert.equal(half.to.opacity, 0.4, "a layer with its own opacity keeps it");
});
