import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "./model.js";
import { isFillEnabled } from "./paints.js";
import { createComponentInstance } from "./linkedComponents.js";
import { defaultFonts } from "./fonts.js";
import { resizeTextLayer } from "./textLayout.js";
import {
  MIXED,
  canEditProperty,
  editLayers,
  editablePatch,
  paintState,
  sharedValue,
  updateLayersEdit,
} from "./multiEdit.js";

const rectangle = (id, values = {}) => createLayer("rectangle", { id, name: id, ...values });
const byId = (layers) => new Map(layers.map((layer) => [layer.id, layer]));
const source = createScene({ id: "card", name: "Card", isComponent: true, width: 240, height: 120 });
const instance = (id, values = {}) => ({ ...createComponentInstance(source, { x: 10, y: 20, ...values }), id });

test("sharedValue gives the value every layer has, or mixed", () => {
  const layers = [rectangle("a", { x: 10 }), rectangle("b", { x: 10 }), rectangle("c", { x: 30 })];
  assert.deepEqual(sharedValue(layers.slice(0, 2), (layer) => layer.x), { value: 10, mixed: false });
  assert.deepEqual(sharedValue(layers, (layer) => layer.x), { value: null, mixed: true });
  assert.deepEqual(sharedValue([], (layer) => layer.x), { value: null, mixed: false });
  // Values the number field shows the same way (four decimals) count as shared.
  assert.equal(sharedValue([rectangle("d", { x: 0.1 + 0.2 }), rectangle("e", { x: 0.3 })], (layer) => layer.x).mixed, false);
  // Paints and shadows are compared by content, and one MIXED layer makes the field mixed.
  const gradient = () => ({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] });
  assert.equal(sharedValue([rectangle("f", { fill: gradient() }), rectangle("g", { fill: gradient() })], (layer) => layer.fill).mixed, false);
  assert.equal(sharedValue(layers, (layer) => (layer.id === "a" ? MIXED : 10)).mixed, true);
});

test("an edit changes every selected layer in one new list and leaves the input alone", () => {
  const layers = [rectangle("a", { x: 0 }), rectangle("b", { x: 50 }), rectangle("c", { x: 99 })];
  const before = structuredClone(layers);
  const next = editLayers(layers, ["a", "b"], { x: 12 });
  assert.deepEqual(layers, before);
  assert.deepEqual(next.map((layer) => layer.x), [12, 12, 99]);
  assert.deepEqual(next.map((layer) => layer.id), ["a", "b", "c"], "the stacking order is kept");
  // Nothing to change: the same list comes back, so App.jsx adds no undo step.
  assert.equal(editLayers(next, ["a", "b"], { x: 12 }), next);
  assert.equal(editLayers(next, ["missing"], { x: 1 }), next);
});

test("each layer gets only the properties it can take", () => {
  const text = createLayer("text", { id: "t", fontSize: 20 });
  const audio = createLayer("audio", { id: "s", x: 7 });
  const card = instance("i");
  const layers = [rectangle("r", { width: 80 }), text, audio, card];
  const next = byId(editLayers(layers, ["r", "t", "s", "i"], { x: 5, width: 300, fontSize: 40, radius: 9 }));
  assert.equal(next.get("r").x, 5);
  assert.equal(next.get("r").width, 300);
  assert.equal(next.get("r").fontSize, layers[0].fontSize, "a rectangle has no font size to change");
  assert.equal(next.get("r").radius, 9);
  assert.equal(next.get("t").fontSize, 40);
  assert.equal(next.get("t").radius, 0, "text has no corner radius");
  assert.equal(next.get("s").x, 7, "audio has no place on the canvas");
  // A component instance moves but keeps its main component's size.
  assert.equal(next.get("i").x, 5);
  assert.equal(next.get("i").width, 240);
  assert.equal(next.get("i").fill, card.fill, "an instance has no fill of its own");

  assert.equal(canEditProperty(card, "width"), false);
  assert.equal(canEditProperty(card, "clipContent"), true);
  assert.equal(canEditProperty(card, "componentSceneId"), false);
  assert.deepEqual(editablePatch(rectangle("q"), { id: "other", type: "text", parentId: "g", name: "Box" }), { name: "Box" });
  assert.equal(editablePatch(audio, { fill: "#ff0000" }), null);
});

test("nested layers: x and y stay in each layer's own group, and groups resize before the layers inside", () => {
  const group = createLayer("group", { id: "g", x: 100, y: 100, width: 200, height: 100 });
  const inside = rectangle("in", { parentId: "g", x: 0, y: 0, width: 100, height: 50 });
  const other = rectangle("other", { parentId: "g", x: 100, y: 50, width: 100, height: 50 });
  const top = rectangle("top", { x: 400, y: 0, width: 10, height: 10 });
  const layers = [group, inside, other, top];

  const placed = byId(editLayers(layers, ["in", "top"], { x: 20 }));
  assert.equal(placed.get("in").x, 20, "a nested layer's x is measured inside its group");
  assert.equal(placed.get("top").x, 20);
  assert.equal(placed.get("g").x, 100);

  // The group's new width stretches the layers inside it, then the selected one gets its own width.
  const sized = byId(editLayers(layers, ["in", "g", "top"], { width: 400 }));
  assert.equal(sized.get("g").width, 400);
  assert.equal(sized.get("other").width, 200, "an unselected layer inside stretches with its group");
  assert.equal(sized.get("other").x, 200);
  assert.equal(sized.get("in").width, 400, "the selected layer inside keeps the typed width");
  assert.equal(sized.get("top").width, 400);
});

test("locked layers in the selection change too, as the single-layer Design tab edits a locked layer", () => {
  const layers = [rectangle("a", { locked: true }), rectangle("b")];
  const next = editLayers(layers, ["a", "b"], { fill: "#ff0000" });
  assert.deepEqual(next.map((layer) => layer.fill), ["#ff0000", "#ff0000"]);
});

test("text edits refit auto-sized text boxes and pick up the new font file", () => {
  const fluid = resizeTextLayer(createLayer("text", { id: "t1", text: "Hello", fontFamily: "Inter", textResize: "width-height", textAlign: "center", x: 100 }), defaultFonts);
  const fixed = createLayer("text", { id: "t2", text: "Hi", fontFamily: "Inter", textResize: "fixed", width: 300, height: 90 });
  const layers = [fluid, fixed];
  const next = byId(editLayers(layers, ["t1", "t2"], { fontSize: 96 }, { fonts: defaultFonts }));
  assert.equal(next.get("t1").fontSize, 96);
  assert.ok(next.get("t1").width > fluid.width, "fluid text grows with its font size");
  assert.ok(Math.abs(next.get("t1").x + next.get("t1").width / 2 - (fluid.x + fluid.width / 2)) < 1e-6, "centered text keeps its center");
  assert.deepEqual([next.get("t2").width, next.get("t2").height], [300, 90], "fixed text keeps its box");

  const family = byId(editLayers(layers, ["t1", "t2"], { fontFamily: "Montserrat" }, { fonts: defaultFonts }));
  const montserrat = defaultFonts.resolve({ fontFamily: "Montserrat", fontStyle: "normal", fontWeight: 400 });
  assert.equal(family.get("t2").fontSource, montserrat.src || "");
  // A typed height turns automatic sizing off, as in the single-layer Design tab.
  assert.equal(byId(editLayers(layers, ["t1", "t2"], { height: 200 }, { fonts: defaultFonts })).get("t1").textResize, "fixed");
});

test("a refused edit throws and changes nothing", () => {
  // A layer scaled to zero inside a group can't be resized with it, so the group can't take a new width.
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 100, height: 100 });
  const flat = rectangle("flat", { parentId: "g", scaleX: 0, width: 50, height: 50 });
  const layers = [rectangle("b"), group, flat];
  const before = structuredClone(layers);
  assert.throws(() => editLayers(layers, ["b", "g"], { width: 300 }), /scaled to zero/);
  assert.deepEqual(layers, before);
});

test("paintState tells a shared paint from mixed colors and mixed kinds of paint", () => {
  const linear = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] };
  assert.deepEqual(paintState([rectangle("a", { fill: "#ff0000" }), rectangle("b", { fill: "#ff0000" })], "fill"), { paint: "#ff0000", type: "solid", mixed: false });
  assert.deepEqual(paintState([rectangle("a", { fill: "#ff0000" }), rectangle("b", { fill: "#00ff00" })], "fill"), { paint: null, type: "solid", mixed: true });
  assert.deepEqual(paintState([rectangle("a", { fill: linear }), rectangle("b", { fill: "#00ff00" })], "fill"), { paint: null, type: null, mixed: true });
});

test("the Enable fill box is shared between selected layers and turns their fills off without losing them", () => {
  const gradient = { type: "radial", angle: 0, stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#0000ff" }] };
  const layers = [
    rectangle("solid", { fill: "#11223380" }),
    createLayer("text", { id: "words", fillEnabled: false }),
    createLayer("ellipse", { id: "round", fill: gradient }),
    createLayer("image", { id: "photo" }),
  ];
  assert.deepEqual(sharedValue(layers.slice(0, 2), isFillEnabled), { value: null, mixed: true }, "one on and one off shows Mixed");
  assert.deepEqual(sharedValue([layers[0], layers[2]], isFillEnabled), { value: true, mixed: false });

  const off = byId(editLayers(layers, ["solid", "words", "round", "photo"], { fillEnabled: false }));
  assert.deepEqual(["solid", "words", "round"].map((id) => off.get(id).fillEnabled), [false, false, false]);
  assert.equal(off.get("photo").fillEnabled, true, "an image has no Fill section, so it keeps the default");
  assert.equal(canEditProperty(layers[3], "fillEnabled"), false);
  assert.equal(off.get("solid").fill, "#11223380", "the color and alpha are kept");
  assert.deepEqual(off.get("round").fill, gradient, "the gradient is kept");

  // Turning a Mixed box on turns every selected fill back on with the paint it had.
  const on = byId(editLayers([...off.values()], ["solid", "words", "round"], { fillEnabled: true }));
  assert.deepEqual(["solid", "words", "round"].map((id) => on.get(id).fillEnabled), [true, true, true]);
  assert.deepEqual(on.get("round").fill, gradient);
  assert.equal(on.get("words").fill, layers[1].fill);
});

test("updateLayersEdit gives each listed layer the stored values it can take", () => {
  const audio = createLayer("audio", { id: "s", mediaSourceDuration: 10 });
  const video = createLayer("video", { id: "v", mediaSourceDuration: 4 });
  const gif = createLayer("image", { id: "g", src: "/api/media/a.gif" });
  const layers = [rectangle("r", { x: 5 }), audio, video, gif];
  const ids = layers.map((layer) => layer.id);
  const moved = byId(editLayers(layers, ids, updateLayersEdit(layers, { x: 50, volume: 2 })));
  assert.deepEqual(["r", "s", "v", "g"].map((id) => moved.get(id).x), [50, audio.x, 50, 50], "audio has no position");
  assert.deepEqual([moved.get("s").volume, moved.get("v").volume], [1, 1], "volume stays within 0 to 1");
  assert.equal(moved.get("r").volume, layers[0].volume);
  // Play settings change only layers with Play; a GIF without Play keeps none.
  const played = byId(editLayers(layers, ids, updateLayersEdit(layers, { mediaStart: 1, mediaOffset: 9 })));
  assert.deepEqual([played.get("s").mediaOffset, played.get("v").mediaOffset], [9, 3.99]);
  assert.equal(played.get("g").mediaStart, gif.mediaStart);
  assert.throws(() => updateLayersEdit(layers, { type: "text" }), /can't change type/);
  assert.throws(() => updateLayersEdit([rectangle("x")], { donut: 0.5 }), /None of the listed layers has donut/);
  assert.throws(() => updateLayersEdit([gif], { mediaDuration: 2 }), /None of the listed layers has mediaDuration/);
  assert.throws(() => updateLayersEdit(layers, null), /needs properties/);
  assert.throws(() => updateLayersEdit([video], { mediaStart: Number.NaN }), /mediaStart must be a number/);
});
