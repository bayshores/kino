import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene } from "./model.js";
import { applyOperations } from "./operations.js";
import { presetAnimation, evaluateLayer } from "./animation.js";
import { resizeTextLayer } from "./textLayout.js";
import { createComponentInstance } from "./linkedComponents.js";
import { defaultFonts } from "./fonts.js";
import { editLayers } from "./multiEdit.js";

test("path fill-rule operations validate values and apply only to paths", () => {
  const source = createDocument();
  const scene = source.scenes[0];
  scene.layers.push(createLayer("path", {
    id: "compound",
    path: "M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z",
  }));

  const updated = applyOperations(source, [{
    type: "update_layer",
    sceneId: scene.id,
    layerId: "compound",
    properties: { fillRule: "evenodd" },
  }]);
  assert.equal(updated.scenes[0].layers[0].fillRule, "evenodd");
  assert.equal(source.scenes[0].layers[0].fillRule, "nonzero", "the source stays unchanged");

  const multiUpdated = applyOperations(updated, [{
    type: "update_layers",
    sceneId: scene.id,
    layerIds: ["compound"],
    properties: { fillRule: "nonzero" },
  }]);
  assert.equal(multiUpdated.scenes[0].layers[0].fillRule, "nonzero");

  const added = applyOperations(source, [{
    type: "add_layer", sceneId: scene.id, layerType: "path",
    properties: { id: "added-path", path: "M0 0 H10 V10 Z", fillRule: "evenodd" },
  }]);
  assert.equal(added.scenes[0].layers[1].fillRule, "evenodd");

  for (const [layerId, properties] of [
    ["compound", { fillRule: "odd" }],
    ["compound", { fillRule: null }],
    ["compound", { fillRule: "evenodd" }],
  ]) {
    const document = structuredClone(source);
    if (properties.fillRule === "evenodd") document.scenes[0].layers.push(createLayer("rectangle", { id: "box" }));
    assert.throws(() => applyOperations(document, [{
      type: properties.fillRule === "evenodd" ? "update_layers" : "update_layer",
      sceneId: scene.id,
      ...(properties.fillRule === "evenodd" ? { layerIds: [layerId, "box"] } : { layerId }),
      properties,
    }]), /fillRule/);
  }
});

test("scene operations accept gradient backgrounds and Color animations and refuse other operations atomically", () => {
  const document = createDocument(), sceneId = document.scenes[0].id;
  const gradient = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
  const color = { id: "scene-color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ffffff" }, to: { fill: gradient } };
  const next = applyOperations(document, [{ type: "update_scene", sceneId, properties: { background: gradient, backgroundEnabled: false, backgroundAnimations: [color] } }]);
  assert.deepEqual(next.scenes[0].background, gradient);
  assert.equal(next.scenes[0].backgroundEnabled, false);
  assert.deepEqual(next.scenes[0].backgroundAnimations[0].to.fill, gradient);
  const move = { ...color, from: { x: 0 }, to: { x: 10 } };
  for (const operation of [
    { type: "update_scene", sceneId, properties: { backgroundAnimations: [move] } },
    { type: "add_scene", properties: { backgroundAnimations: [move] } },
  ]) assert.throws(() => applyOperations(document, [operation]), /a scene background can only have Color animations/);
  assert.deepEqual(document.scenes[0].backgroundAnimations, []);
  assert.equal(document.scenes.length, 1);
});

test("update_scene sets finish (true is the starting point) and letterbox, removes them, and refuses a wrong value", () => {
  const document = createDocument(), sceneId = document.scenes[0].id;
  const set = applyOperations(document, [{ type: "update_scene", sceneId, properties: { finish: true, letterbox: 2.2 } }]).scenes[0];
  assert.deepEqual([set.finish, set.letterbox], [{ grain: 0.15, blackLift: 0.04, halation: 0.2, vignette: 0.3, soften: 0.5 }, 2.2]);
  const changed = applyOperations(document, [{ type: "update_scene", sceneId, properties: { finish: { vignette: 0.6 } } }]).scenes[0];
  assert.deepEqual(changed.finish, { vignette: 0.6 });
  const off = applyOperations(document, [{ type: "update_scene", sceneId, properties: { finish: false, letterbox: null } }]).scenes[0];
  assert.deepEqual([off.finish, off.letterbox, "finish" in off], [undefined, undefined, false]);
  assert.throws(() => applyOperations(document, [{ type: "update_scene", sceneId, properties: { letterbox: 12 } }]), /letterbox must be the picture's width : height/);
  assert.throws(() => applyOperations(document, [{ type: "update_scene", sceneId, properties: { finish: { grain: -1 } } }]), /finish\.grain must be a number from 0 to 1/);
});

test("agent component operations preserve live references and detach their content",()=>{
  const source = createDocument(), scene=source.scenes[0];
  const result=applyOperations(source,[{type:"add_layer",sceneId:scene.id,layerType:"rectangle",properties:{id:"card"}},{type:"create_component",sceneId:scene.id},{type:"add_scene",properties:{id:"target"}},{type:"insert_component",sceneId:"target",componentSceneId:scene.id,properties:{id:"instance"}}]);
  assert.equal(result.scenes[0].isComponent,true);
  assert.equal(result.scenes[1].layers[0].componentSceneId,scene.id);
  assert.throws(()=>applyOperations(result,[{type:"delete_scene",sceneId:scene.id}]), /main component scene/);
  const detached=applyOperations(result,[{type:"detach_component",sceneId:"target",layerId:"instance"}]);
  assert.equal(detached.scenes[1].layers[0].type,"group");
  assert.equal(detached.scenes[1].layers.some(l=>l.type==="component"),false);
  assert.ok(detached.scenes[1].layers.some(l=>l.name==="Rectangle"));
  assert.equal(result.scenes[1].layers.length,1);
});

test("agent conversion preserves identity and retained operations while subsequent path edits stay atomic", () => {
  const source = createDocument(), scene = source.scenes[0];
  const rectangle = createLayer("rectangle", { id: "card", radius: 12 });
  rectangle.animations = [presetAnimation("corners", rectangle)];
  scene.layers.push(rectangle);
  const converted = applyOperations(source, [{ type: "convert_to_shape", sceneId: scene.id, layerId: rectangle.id }]);
  const path = converted.scenes[0].layers[0];
  assert.equal(path.id, rectangle.id);
  assert.equal(path.type, "path");
  assert.deepEqual(path.animations, rectangle.animations);
  assert.equal(evaluateLayer(path, 0.8).path, path.path);
  const edited = applyOperations(converted, [{ type: "update_layer", sceneId: scene.id, layerId: path.id, properties: { path: "M0 0 L100 0 L50 70 Z" } }]);
  assert.equal(edited.scenes[0].layers[0].path, "M0 0 L100 0 L50 70 Z");
  assert.notEqual(converted.scenes[0].layers[0].path, edited.scenes[0].layers[0].path);
  assert.equal(source.scenes[0].layers[0].type, "rectangle");
  assert.throws(() => applyOperations(converted, [
    { type: "rename_project", name: "Must not persist" },
    { type: "convert_to_shape", sceneId: scene.id, layerId: path.id },
  ]), /cannot be converted/);
  assert.equal(converted.name, source.name);
});

test("agent operations create editable layers and animations without mutating the source", () => {
  const source = createDocument(),
    scene = source.scenes[0];
  const result = applyOperations(source, [
    {
      type: "add_layer",
      sceneId: scene.id,
      layerType: "rectangle",
      properties: { id: "card", width: 240, height: 120 },
    },
    {
      type: "add_animation",
      sceneId: scene.id,
      layerId: "card",
      preset: "fade-in",
      start: 0.4,
    },
  ]);
  assert.equal(source.scenes[0].layers.length, 0);
  assert.equal(result.scenes[0].layers[0].animations[0].start, 0.4);
});

test("a failed batch leaves the original intact and deletes cannot strand group descendants", () => {
  const source = createDocument(),
    scene = source.scenes[0];
  scene.layers = [
    createLayer("group", { id: "group" }),
    createLayer("text", { id: "child", parentId: "group" }),
  ];
  assert.throws(() =>
    applyOperations(source, [
      { type: "rename_project", name: "changed" },
      { type: "delete_scene", sceneId: scene.id },
    ]),
  );
  assert.equal(source.name, "New file");
  const result = applyOperations(source, [
    { type: "delete_layer", sceneId: scene.id, layerId: "group" },
  ]);
  assert.equal(result.scenes[0].layers.length, 0);
  assert.equal(source.scenes[0].layers.length, 2);
});

test("agents align layers in one validated operation, moving their position animations too", () => {
  const source = createDocument(),
    scene = source.scenes[0];
  const group = createLayer("group", { id: "group", x: 200, y: 100, width: 200, height: 100, rotation: 90 });
  const child = createLayer("rectangle", { id: "child", parentId: "group", x: 20, y: 20, width: 40, height: 20 });
  child.animations = [presetAnimation("slide-left", child, 0, scene)];
  const card = createLayer("rectangle", { id: "card", x: 40, y: 300, width: 100, height: 40 });
  scene.layers.push(group, child, card);
  const op = (properties) => ({ type: "align_layers", sceneId: scene.id, layerIds: ["card"], align: "right", ...properties });

  const right = applyOperations(source, [op()]);
  assert.equal(right.scenes[0].layers.find((l) => l.id === "card").x, 540);
  assert.equal(source.scenes[0].layers.find((l) => l.id === "card").x, 40);

  // The child sits in a group turned 90 degrees, so moving it down the screen changes its own x.
  const bottom = applyOperations(source, [op({ layerIds: ["child", "card"], align: "bottom" })]);
  const moved = bottom.scenes[0].layers.find((l) => l.id === "child");
  assert.equal(bottom.scenes[0].layers.find((l) => l.id === "card").y, 300);
  assert.equal(moved.y, child.y);
  assert.notEqual(moved.x, child.x);
  const shift = moved.x - child.x;
  assert.equal(shift, 230);
  assert.equal(moved.animations[0].from.x, child.animations[0].from.x + shift);
  assert.equal(moved.animations[0].to.x, child.animations[0].to.x + shift);

  assert.throws(() => applyOperations(source, [op({ align: "justify" })]), /one of left, center, right, top, middle, bottom/);
  assert.throws(() => applyOperations(source, [op({ layerIds: [] })]), /array of 1 to 5000 layer IDs/);
  assert.throws(() => applyOperations(source, [op({ layerIds: "card" })]), /array of 1 to 5000 layer IDs/);
  assert.throws(() => applyOperations(source, [op({ layerIds: ["missing"] })]), /Layer missing was not found/);
  scene.layers.push(createLayer("audio", { id: "sound" }));
  assert.throws(() => applyOperations(source, [op({ layerIds: ["sound"] })]), /no position on the canvas/);
});

test("update_layer and update_layers move a layer's presets with it; animations the agent wrote stay", () => {
  const source = createDocument(),
    scene = source.scenes[0];
  const caption = createLayer("text", { id: "caption", text: "Hello", x: 100, y: 400, fontSize: 40 });
  const textIn = presetAnimation("preset-custom-text", caption, 0, scene);
  const drift = { id: "drift", kind: "custom", name: "Drift", start: 1, duration: 1, easing: "linear", from: { y: 400 }, to: { y: 450 } };
  caption.animations = [textIn, drift];
  const line = createLayer("rectangle", { id: "line", x: 160, y: 50, width: 100, height: 10 });
  const slide = presetAnimation("slide-left", line, 0, scene);
  line.animations = [slide];
  scene.layers.push(caption, line);

  const reports = new Map();
  const moveCaption = { type: "update_layer", sceneId: scene.id, layerId: "caption", properties: { y: 300 } };
  const moved = applyOperations(source, [moveCaption], { reports }).scenes[0].layers.find((l) => l.id === "caption");
  assert.deepEqual([moved.animations[0].from.y, moved.animations[0].to.y], [textIn.from.y - 100, 300]);
  assert.deepEqual(moved.animations[0].preset, textIn.preset, "it stays a preset");
  assert.deepEqual([moved.animations[1].from, moved.animations[1].to], [drift.from, drift.to], "a custom animation keeps the places the agent wrote");
  assert.deepEqual(reports.get(moveCaption), { presetsMoved: [{ layerId: "caption", animationId: textIn.id, name: "Custom text effect In" }] });

  // A slide travels half the layer's width, so a wider layer slides farther.
  const resized = applyOperations(source, [{ type: "update_layers", sceneId: scene.id, layerIds: ["line"], properties: { x: 110, width: 200 } }]);
  const carried = resized.scenes[0].layers.find((l) => l.id === "line").animations[0];
  assert.deepEqual([carried.from.x, carried.to.x], [210, 110]);
  // An op that sets the animations itself keeps them as sent.
  const kept = applyOperations(source, [{ type: "update_layer", sceneId: scene.id, layerId: "line", properties: { x: 10, animations: [slide] } }]);
  assert.deepEqual(kept.scenes[0].layers.find((l) => l.id === "line").animations[0].to, slide.to);
});

test("agents align auto-sized text by the size it is drawn at", () => {
  const source = createDocument();
  const scene = source.scenes[0];
  const drawn = (document, id) => resizeTextLayer(document.scenes[0].layers.find((l) => l.id === id));
  // New text whose stored size was never measured, and text whose words changed afterwards.
  const changed = applyOperations(source, [
    { type: "add_layer", sceneId: scene.id, layerType: "text", properties: { id: "label", text: "Hi", textResize: "width-height", x: 10 } },
    { type: "add_layer", sceneId: scene.id, layerType: "text", properties: { id: "title", text: "Hi", fontFamily: "Montserrat", textResize: "width-height", textAlign: "center", verticalAlign: "middle" } },
    { type: "update_layer", sceneId: scene.id, layerId: "title", properties: { text: "A much longer headline" } },
    { type: "align_layers", sceneId: scene.id, layerIds: ["label"], align: "right" },
    { type: "align_layers", sceneId: scene.id, layerIds: ["title"], align: "right" },
  ]);
  for (const id of ["label", "title"]) {
    const text = drawn(changed, id);
    assert.ok(Math.abs(text.x + text.width - scene.width) < 1e-5, `${id} ends at the right edge, not at ${text.x + text.width}`);
  }
});

test("agents turn a layer's fill off and back on with update_layer, keeping its paint", () => {
  const source = createDocument(), scene = source.scenes[0];
  scene.layers.push(createLayer("star", { id: "star", fill: "#ff660080" }));
  const update = (properties) => ({ type: "update_layer", sceneId: scene.id, layerId: "star", properties });
  const off = applyOperations(source, [update({ fillEnabled: false })]);
  assert.equal(off.scenes[0].layers[0].fillEnabled, false);
  assert.equal(off.scenes[0].layers[0].fill, "#ff660080", "the color and alpha are kept while the fill is off");
  // A new paint can be set while the fill is off; it shows once the fill is turned back on.
  const repainted = applyOperations(off, [update({ fill: "#00ff00" })]);
  assert.equal(repainted.scenes[0].layers[0].fillEnabled, false);
  const on = applyOperations(repainted, [update({ fillEnabled: true })]);
  assert.deepEqual([on.scenes[0].layers[0].fillEnabled, on.scenes[0].layers[0].fill], [true, "#00ff00"]);
  const added = applyOperations(source, [{ type: "add_layer", sceneId: scene.id, layerType: "text", properties: { id: "words", fillEnabled: false } }]);
  assert.equal(added.scenes[0].layers.at(-1).fillEnabled, false);
  assert.throws(() => applyOperations(source, [update({ fillEnabled: "off" })]), /fillEnabled: must be true or false/);
});

test("agents edit several layers with update_layers the way the multi-layer Design tab does", () => {
  const source = createDocument(), scene = source.scenes[0];
  const card = createScene({ id: "card", name: "Card", isComponent: true, width: 240, height: 120 });
  source.scenes.push(card);
  scene.layers.push(
    createLayer("group", { id: "g", x: 100, y: 100, width: 200, height: 100 }),
    createLayer("rectangle", { id: "inside", parentId: "g", x: 100, y: 50, width: 100, height: 50 }),
    createLayer("rectangle", { id: "top", x: 400, width: 10, height: 10 }),
    { ...createComponentInstance(card, { x: 10, y: 20 }), id: "instance" },
    resizeTextLayer(createLayer("text", { id: "t1", text: "Hello", textResize: "width-height", textAlign: "center", x: 100 })),
    createLayer("text", { id: "t2", text: "Hi", textResize: "fixed", width: 300, height: 90 }),
    createLayer("video", { id: "v1", src: "/api/media/short.mp4", mediaSourceDuration: 2 }),
    createLayer("video", { id: "v2", src: "/api/media/long.mp4", mediaSourceDuration: 30 }),
  );
  const update = (layerIds, properties) => ({ type: "update_layers", sceneId: scene.id, layerIds, properties });
  const layer = (document, id) => document.scenes[0].layers.find((l) => l.id === id);
  // The same edit made in the Design tab with these layers selected (App.jsx changeLayers).
  const designTab = (ids, edit) => new Map(editLayers(scene.layers, ids, edit, { scenes: source.scenes, fonts: defaultFonts }).map((l) => [l.id, l]));
  const pick = (value, keys) => keys.map((key) => value[key]);

  // A group's new width stretches the layers inside it, and an instance keeps its main component's size.
  const wide = applyOperations(source, [update(["g", "top", "instance"], { width: 400 })]);
  assert.deepEqual(["g", "top"].map((id) => layer(wide, id).width), [400, 400]);
  assert.deepEqual(pick(layer(wide, "inside"), ["x", "width"]), [200, 200]);
  assert.equal(layer(wide, "instance").width, 240);
  // update_layer, by contrast, sets only the group's own width.
  const single = applyOperations(source, [{ type: "update_layer", sceneId: scene.id, layerId: "g", properties: { width: 400 } }]);
  assert.equal(layer(single, "inside").width, 100);

  // Text boxes refit to the new size (centered fluid text keeps its center); the rectangle has no font size.
  const big = applyOperations(source, [update(["t1", "t2", "top"], { fontSize: 96 })]);
  const refit = designTab(["t1", "t2", "top"], { fontSize: 96 });
  for (const id of ["t1", "t2"])
    assert.deepEqual(pick(layer(big, id), ["x", "y", "width", "height", "fontSize"]), pick(refit.get(id), ["x", "y", "width", "height", "fontSize"]), id);
  assert.ok(layer(big, "t1").width > layer(source, "t1").width, "fluid text grows with its font size");
  assert.equal(layer(big, "top").fontSize, layer(source, "top").fontSize);
  const montserrat = applyOperations(source, [update(["t1", "t2"], { fontFamily: "Montserrat" })]);
  const face = defaultFonts.resolve({ fontFamily: "Montserrat", fontStyle: "normal", fontWeight: 400 });
  assert.deepEqual(["t1", "t2"].map((id) => layer(montserrat, id).fontSource), [face.src || "", face.src || ""], "the text picks up the new font file");

  // Play settings stay inside each video's own source, as the Play fields keep them.
  const offset = applyOperations(source, [update(["v1", "v2"], { mediaOffset: 150 })]);
  assert.deepEqual(["v1", "v2"].map((id) => layer(offset, id).mediaOffset), [1.99, 29.99]);
  const longer = applyOperations(source, [update(["v1", "v2"], { mediaDuration: 100 })]);
  assert.deepEqual(["v1", "v2"].map((id) => layer(longer, id).mediaDuration), [2, 30]);
  const open = applyOperations(longer, [update(["v1", "v2"], { mediaDuration: 0 })]);
  assert.deepEqual(["v1", "v2"].map((id) => layer(open, id).mediaDuration), [0, 0], "0 still means until the source ends");
  const both = applyOperations(source, [update(["v1"], { mediaOffset: 1, mediaDuration: 100 })]);
  assert.deepEqual(pick(layer(both, "v1"), ["mediaOffset", "mediaDuration"]), [1, 1], "the duration fits after the new offset");

  // Refused edits name the problem and save nothing.
  const fails = (operation, pattern) => assert.throws(() => applyOperations(source, [{ type: "rename_project", name: "Not saved" }, operation]), pattern);
  fails(update(["top", "t1"], { parentId: "g" }), /can't change parentId/);
  fails(update(["instance"], { componentSceneId: scene.id }), /can't change componentSceneId/);
  fails(update(["top"], { animations: [] }), /can't change animations/);
  fails(update(["top", "inside"], { fontSize: 96 }), /None of the listed layers has fontSize/);
  fails(update(["v1"], { mediaOffset: "1" }), /mediaOffset must be a number/);
  fails(update(["top"], {}), /needs properties/);
  fails(update([], { x: 1 }), /needs layerIds/);
  fails(update(["missing"], { x: 1 }), /Layer missing was not found/);
  assert.equal(source.name, "New file");
  assert.equal(layer(source, "g").width, 200, "the source document is left alone");
});

test("add_animation keeps a caller-chosen id so later operations in the same call can use it", () => {
  const source = applyOperations(createDocument(), [
    { type: "add_scene", properties: { id: "intro" } },
    { type: "add_layer", sceneId: "intro", layerType: "rectangle", properties: { id: "card" } },
  ]);
  const edited = applyOperations(source, [
    { type: "add_animation", sceneId: "intro", layerId: "card", preset: "preset-fade", id: "card.in" },
    { type: "update_animation", sceneId: "intro", layerId: "card", animationId: "card.in", properties: { start: 1 } },
  ]);
  const card = edited.scenes.find((scene) => scene.id === "intro").layers[0];
  assert.deepEqual(card.animations.map(({ id, start }) => ({ id, start })), [{ id: "card.in", start: 1 }]);
  assert.throws(() => applyOperations(source, [
    { type: "add_animation", sceneId: "intro", layerId: "card", preset: "preset-fade", id: "same" },
    { type: "add_animation", sceneId: "intro", layerId: "card", preset: "preset-fade", id: "same" },
  ]), /duplicate animation ID "same"/);
  assert.throws(() => applyOperations(source, [
    { type: "add_animation", sceneId: "intro", layerId: "card", preset: "preset-fade", id: "not valid!" },
  ]), /only letters, numbers/);
});

// A scene "s" (6 seconds) with a rectangle "card", for the add_animation timing tests below.
function cardScene() {
  return applyOperations(createDocument(), [
    { type: "add_scene", properties: { id: "s", duration: 6 } },
    { type: "add_layer", sceneId: "s", layerType: "rectangle", properties: { id: "card" } },
  ]);
}
const addTo = (source, operation) => applyOperations(source, [{ type: "add_animation", sceneId: "s", layerId: "card", ...operation }]);
const lastAnimation = (document) => document.scenes.find((scene) => scene.id === "s").layers[0].animations.at(-1);
const timing = ({ start, duration, keepStill }) => ({ start, duration, keepStill });

test("a ranged effect added with a start and duration runs in that window, not from 0", () => {
  const source = cardScene();
  assert.deepEqual(timing(lastAnimation(addTo(source, { preset: "effect:rgb-shift", start: 1.5, duration: 0.5 }))), { start: 1.5, duration: 0.5, keepStill: "off" });
  assert.deepEqual(timing(lastAnimation(addTo(source, { effect: "rgb-shift", parameters: { amount: 0.5 }, start: 1 }))), { start: 1, duration: 5, keepStill: "off" }, "a start alone lasts to the scene end");
  assert.deepEqual(timing(lastAnimation(addTo(source, { effect: "rgb-shift", start: 1, duration: 1, keepStill: "end" }))), { start: 1, duration: 1, keepStill: "end" }, "a chosen keepStill is kept");
  assert.deepEqual(timing(lastAnimation(addTo(source, { effect: "rgb-shift" }))), { start: 0, duration: 6, keepStill: "both" }, "without a time it covers the whole scene and holds both ends");
  const full = lastAnimation(addTo(source, { animation: { name: "Split", kind: "effect", effect: "rgb-shift", to: { amount: 0.5 }, start: 1.2, duration: 0.6 } }));
  assert.deepEqual(timing(full), { start: 1.2, duration: 0.6, keepStill: "off" });
});

test("a full animation without a name or easing gets defaults instead of a document error", () => {
  const source = cardScene();
  const wiggle = lastAnimation(addTo(source, { animation: { kind: "effect", effect: "wiggle", to: { wiggleX: 40, wiggleY: 40, speed: 14 }, start: 1.2, duration: 0.6 } }));
  assert.equal(wiggle.name, "Wiggle");
  const ink = lastAnimation(addTo(source, { animation: { name: "Ink", kind: "custom", from: { fill: "#000000" }, to: { fill: "#000000" }, start: 1, duration: 0.1 } }));
  assert.equal(ink.easing, "smooth");
  const entrance = (kind, from, to) => lastAnimation(addTo(source, { animation: { kind, from, to, start: 0, duration: 0.6 } })).easing;
  assert.deepEqual([entrance("in", { y: 300 }, { y: 100 }), entrance("out", { y: 100 }, { y: 300 })], ["smooth", "smooth"], "custom entrances and exits match the presets");
  assert.equal(entrance("in", { opacity: 0 }, { opacity: 1 }), "linear", "a fade alone is linear");
  const custom = lastAnimation(addTo(source, { animation: { kind: "custom", from: { opacity: 0 }, to: { opacity: 1 }, start: 0, duration: 1, easing: "linear" } }));
  assert.equal(custom.name, "Custom");
});

test("a bad full animation is refused at the operation's own field, not a path in the document", () => {
  const source = cardScene();
  assert.throws(() => addTo(source, { animation: { kind: "custom", from: { opacity: 0 }, to: { opacity: 1 }, start: 0, duration: 1, easing: 42 } }),
    (error) => error.message.startsWith("animation.easing:") && !error.message.includes("document."));
  assert.throws(() => addTo(source, { animation: { kind: "custom", from: { opacity: 0 }, to: { opacity: 1 }, start: 0, duration: -1 } }),
    (error) => error.message.startsWith("animation.duration:"));
});

test("a waiver on a layer lapses when the layer is deleted or its file changes", () => {
  const source = createDocument({ scenes: [createScene({ id: "s", layers: [createLayer("audio", { id: "music", name: "music", src: "/api/media/a.wav" })] })] });
  const waived = applyOperations(source, [{ type: "waive_check", code: "voice_under_bed", target: "music", reason: "quiet on purpose" }]);
  const targets = (document) => (document.checkWaivers ?? []).map((waiver) => waiver.target);
  // Another edit keeps it; a new song in the layer, or the layer deleted and re-added, does not.
  assert.deepEqual(targets(applyOperations(waived, [{ type: "update_layer", sceneId: "s", layerId: "music", properties: { volume: 0.5 } }])), ["music"]);
  assert.deepEqual(targets(applyOperations(waived, [{ type: "update_layer", sceneId: "s", layerId: "music", properties: { src: "/api/media/b.wav" } }])), []);
  const deleted = applyOperations(waived, [{ type: "delete_layer", sceneId: "s", layerId: "music" }]);
  assert.deepEqual(targets(deleted), []);
  assert.deepEqual(targets(applyOperations(deleted, [{ type: "add_layer", sceneId: "s", layerType: "audio", properties: { id: "music", src: "/api/media/b.wav" } }])), []);
});
