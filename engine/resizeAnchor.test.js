// The Resize animation (preset "resize"): the anchor math, evaluation with rotation, scale, skew
// and other position animations, text auto-size, the model's checks, apply_operations, the
// clipboard and Duplicate. Exports are tested in server/resize-animation-export.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RESIZE_ANCHOR, RESIZE_ANCHORS, isResizeAnimation, resizableSides, resizeAnchorShift,
  resizePresetValues, resizeProblem,
} from "./resizeAnchor.js";
import { PRESETS, evaluateLayer, presetAnimation } from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { layerMatrix, point } from "./geometry.js";
import { copyAnimation, pasteAnimations } from "./layerClipboard.js";
import { duplicateSelection } from "./duplicate.js";
import { renderSceneSvg } from "./render.js";
import { resizeTextLayer } from "./textLayout.js";
import { readFile } from "node:fs/promises";
import { loadBundledFonts } from "../backend/fonts.mjs";

function close(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: expected ${expected}, received ${actual}`);
}

function closePoint(actual, expected, message, tolerance = 1e-6) {
  close(actual.x, expected.x, `${message} (x)`, tolerance);
  close(actual.y, expected.y, `${message} (y)`, tolerance);
}

// Where the point at fraction (u, v) of a layer's box is drawn, in its parent's space. This uses
// geometry.js layerMatrix, which is written separately from resizeAnchor.js.
function anchorPoint(layer, { u, v }) {
  return point(layerMatrix(layer), u * layer.width, v * layer.height);
}

function resize(anchor, from, to, extra = {}) {
  return {
    id: `resize-${anchor ?? "none"}`, name: "Resize", kind: "custom", start: 0, duration: 1, easing: "linear",
    from, to, unit: "layer", stagger: 0, order: "forward", ...(anchor ? { anchor } : {}), ...extra,
  };
}

const box = (overrides = {}) => ({
  type: "rectangle", id: "box", x: 40, y: 30, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0,
  animations: [], ...overrides,
});

test("Resize is offered with the Custom animations and starts at the layer's size with a Center anchor", () => {
  assert.deepEqual(PRESETS.find((preset) => preset.id === "resize"), { id: "resize", name: "Resize", kind: "custom" });
  const animation = presetAnimation("resize", box(), 0.5);
  assert.equal(animation.anchor, DEFAULT_RESIZE_ANCHOR);
  assert.equal(DEFAULT_RESIZE_ANCHOR, "center");
  assert.deepEqual([animation.kind, animation.start, animation.from, animation.to],
    ["custom", 0.5, { width: 100, height: 60 }, { width: 150, height: 90 }], "To is a visibly larger box with the same proportions");
  assert.deepEqual(resizePresetValues(box({ width: 50_000, height: 10 })).to, { width: 25_000, height: 15 },
    "a size that would pass the largest size shrinks instead");
});

test("the nine anchors are the menu's nine points, Center first", () => {
  assert.deepEqual(RESIZE_ANCHORS.map((anchor) => anchor.label),
    ["Center", "Top-Left", "Top", "Top-Right", "Right", "Bottom-Right", "Bottom", "Bottom-Left", "Left"]);
});

test("without rotation the shift keeps the anchor's edge: 0 at the top left, half at the center, all at the bottom right", () => {
  const change = { width: 40, height: 20 };
  const expected = {
    "top-left": [0, 0], top: [-20, 0], "top-right": [-40, 0],
    left: [0, -10], center: [-20, -10], right: [-40, -10],
    "bottom-left": [0, -20], bottom: [-20, -20], "bottom-right": [-40, -20],
  };
  for (const [anchor, [x, y]] of Object.entries(expected))
    assert.deepEqual(resizeAnchorShift(anchor, change), { x, y }, anchor);
  assert.deepEqual(resizeAnchorShift("middle", change), { x: 0, y: 0 }, "an unknown anchor moves nothing");
  assert.deepEqual(resizeAnchorShift("center", { width: 0, height: 0 }), { x: 0, y: 0 });
});

test("every anchor stays on the same canvas spot of a rotated, scaled and skewed box at every time", () => {
  const transform = { rotation: 33, scaleX: 1.5, scaleY: -0.75, skewX: 12 };
  for (const anchor of RESIZE_ANCHORS) {
    const layer = box({ ...transform, animations: [resize(anchor.id, { width: 100, height: 60 }, { width: 180, height: 25 })] });
    const resting = anchorPoint({ ...layer, animations: [] }, anchor);
    for (const time of [0, 0.25, 0.5, 1, 3]) {
      const state = evaluateLayer(layer, time);
      closePoint(anchorPoint(state, anchor), resting, `${anchor.label} at ${time} s`);
    }
    const end = evaluateLayer(layer, 1);
    assert.deepEqual([end.width, end.height], [180, 25]);
    // On a turned box even the top-left corner needs x and y to move.
    assert.ok(Math.hypot(end.x - layer.x, end.y - layer.y) > 1, `${anchor.label} moves x and y`);
  }
});

test("an animation without an anchor keeps x and y, as before anchors existed", () => {
  const layer = box({ rotation: 30, animations: [resize(null, { width: 100, height: 60 }, { width: 200, height: 60 })] });
  const state = evaluateLayer(layer, 1);
  assert.deepEqual([state.x, state.y, state.width], [40, 30, 200]);
});

test("a Move during or after a Resize moves the anchored box by exactly its own distance", () => {
  const anchor = RESIZE_ANCHORS.find((item) => item.id === "bottom-right");
  const move = { id: "move", name: "Move", kind: "custom", start: 0.5, duration: 1, easing: "linear", from: { x: 40, y: 30 }, to: { x: 140, y: -20 } };
  const layer = box({ rotation: 20, animations: [resize("bottom-right", { width: 100, height: 60 }, { width: 50, height: 120 }), move] });
  const resting = anchorPoint({ ...layer, animations: [] }, anchor);
  for (const time of [0.25, 0.5, 1, 1.5, 4]) {
    const moved = evaluateLayer({ ...layer, animations: [move] }, time);
    const state = evaluateLayer(layer, time);
    closePoint(anchorPoint(state, anchor), { x: resting.x + moved.x - 40, y: resting.y + moved.y - 30 }, `at ${time} s`);
  }
});

test("the turn at the Resize's start is used, so a later Rotate turns the resized box around its own center", () => {
  const rotate = { id: "rotate", name: "Rotate", kind: "custom", start: 0, duration: 1, easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } };
  const later = resize("left", { width: 100, height: 60 }, { width: 160, height: 60 }, { start: 1 });
  const layer = box({ animations: [rotate, later] });
  const anchor = RESIZE_ANCHORS.find((item) => item.id === "left");
  const atStart = anchorPoint(evaluateLayer(layer, 1), anchor);
  for (const time of [1.25, 1.5, 2]) closePoint(anchorPoint(evaluateLayer(layer, time), anchor), atStart, `turned box at ${time} s`);

  // A Rotate after the Resize: the box keeps its center while it turns.
  const turnAfter = { ...rotate, id: "turn-after", start: 2, from: { rotation: 0 }, to: { rotation: 45 } };
  const resized = box({ animations: [resize("left", { width: 100, height: 60 }, { width: 160, height: 60 }), turnAfter] });
  const before = evaluateLayer(resized, 1.5);
  const after = evaluateLayer(resized, 3);
  assert.equal(after.rotation, 45);
  closePoint({ x: after.x + after.width / 2, y: after.y + after.height / 2 }, { x: before.x + before.width / 2, y: before.y + before.height / 2 }, "same center");
});

test("Resize animations one after another add up, each keeping its own anchor", () => {
  const first = resize("left", { width: 100, height: 60 }, { width: 200, height: 60 });
  const second = resize("right", { width: 200, height: 60 }, { width: 300, height: 60 }, { id: "second", start: 1 });
  const layer = box({ animations: [first, second] });
  const after = evaluateLayer(layer, 2);
  assert.deepEqual([after.x, after.width], [-60, 300], "the left edge stayed for the first, the right edge for the second");
  const middle = evaluateLayer(layer, 1);
  assert.deepEqual([middle.x, middle.width], [40, 200]);
});

test("an In Resize shows its From size, anchored, before it starts", () => {
  const layer = box({ animations: [resize("center", { width: 20, height: 20 }, { width: 100, height: 60 }, { kind: "in", start: 1 })] });
  const before = evaluateLayer(layer, 0);
  assert.deepEqual([before.width, before.height, before.x, before.y], [20, 20, 80, 50], "centered on the resting box");
  const after = evaluateLayer(layer, 2);
  assert.deepEqual([after.width, after.height, after.x, after.y], [100, 60, 40, 30]);
});

test("text follows its auto-size: Auto height text resizes only its width, Auto width text can't be resized", () => {
  const fixed = { type: "text", textResize: "fixed" };
  assert.deepEqual(resizableSides(fixed), { width: true, height: true });
  assert.deepEqual(resizableSides({ type: "text", textResize: "height" }), { width: true, height: false });
  assert.deepEqual(resizableSides({ type: "text", textResize: "width-height" }), { width: false, height: false });
  const autoHeight = createLayer("text", { id: "words", text: "Hello", width: 200, height: 40, textResize: "height" });
  const preset = presetAnimation("resize", autoHeight, 0);
  assert.deepEqual([preset.from, preset.to], [{ width: 200 }, { width: 300 }], "only the width");
  const state = evaluateLayer({ ...autoHeight, animations: [{ ...preset, duration: 1, easing: "linear" }] }, 1);
  assert.deepEqual([state.width, state.x], [300, autoHeight.x - 50], "the width grows around its center");
  const autoWidth = createLayer("text", { id: "label", text: "Hi", textResize: "width-height" });
  assert.throws(() => presetAnimation("resize", autoWidth, 0), /sizes itself \(Text resize: Auto width\)/);
  assert.match(resizeProblem(autoHeight, { from: { height: 10 }, to: { height: 20 } }), /only the width of text layer words/);
  // An Auto width text layer with an older width animation still draws as before: no x move.
  const legacy = evaluateLayer({ ...autoWidth, animations: [resize("center", { width: 10 }, { width: 300 })] }, 1);
  assert.equal(legacy.x, autoWidth.x);
});

// A sentence that wraps onto more lines when its box gets narrower.
const SENTENCE = "The quick brown fox jumps over the lazy dog again and again";

// Auto height text 400 px wide, with the height its lines need (as the Text tool saves it).
function autoHeightText(overrides = {}, fonts = undefined) {
  return resizeTextLayer(createLayer("text", {
    id: "words", x: 100, y: 100, width: 400, fontSize: 32, text: SENTENCE, textResize: "height", ...overrides,
  }), fonts);
}

// The text as it is drawn at `time`: evaluated, then fitted to its lines, as render.js and the
// exports do (textLayout.js resizeTextLayer).
function drawnText(layer, time, fonts = undefined) {
  return resizeTextLayer({ ...layer, ...evaluateLayer(layer, time, fonts ? { fonts } : undefined) }, fonts);
}

test("Auto height text keeps every anchor in place while narrowing it adds lines", () => {
  for (const verticalAlign of ["top", "middle", "bottom"]) {
    for (const rotation of [0, 30]) {
      for (const anchor of RESIZE_ANCHORS) {
        const layer = { ...autoHeightText({ rotation, scaleX: 1.25, verticalAlign }), animations: [resize(anchor.id, { width: 400 }, { width: 120 })] };
        const start = drawnText(layer, 0);
        assert.ok(drawnText(layer, 1).height > start.height * 2, "the narrower text wraps onto more lines");
        const resting = anchorPoint(start, anchor);
        for (const time of [0.25, 0.5, 0.75, 1])
          closePoint(anchorPoint(drawnText(layer, time), anchor), resting, `${anchor.id}, ${rotation}°, ${verticalAlign} at ${time} s`);
      }
    }
  }
  // A saved height that is out of date (Auto height text fits it again when drawn) doesn't matter.
  const stale = { ...autoHeightText({ verticalAlign: "bottom" }), height: 10, animations: [resize("bottom", { width: 400 }, { width: 120 })] };
  closePoint(anchorPoint(drawnText(stale, 1), { u: 0.5, v: 1 }), anchorPoint(drawnText(stale, 0), { u: 0.5, v: 1 }), "a stale saved height");
  // An In Resize before its start shows its narrower From size, anchored, too.
  const entering = { ...autoHeightText(), animations: [resize("bottom-right", { width: 120 }, { width: 400 }, { kind: "in", start: 1 })] };
  closePoint(anchorPoint(drawnText(entering, 0), { u: 1, v: 1 }), anchorPoint(autoHeightText(), { u: 1, v: 1 }), "an In Resize before it starts");
  // An older width animation without an anchor still keeps x and y.
  const legacy = { ...autoHeightText(), animations: [resize(null, { width: 400 }, { width: 120 })] };
  assert.deepEqual([drawnText(legacy, 1).x, drawnText(legacy, 1).y], [100, 100]);
});

test("Auto height text measures its new height with the fonts it is drawn with", async () => {
  // A font only an export's own registry has, as an imported font is on the server.
  const fonts = await loadBundledFonts();
  fonts.register(await readFile(new URL("../assets/fonts/Inter-700.ttf", import.meta.url)), {
    id: "brand-bold", family: "Brand Bold", src: "/api/media/brand-bold.ttf",
  });
  const style = { fontFamily: "Brand Bold", fontSource: "/api/media/brand-bold.ttf", fontWeight: 700 };
  const layer = { ...autoHeightText(style, fonts), animations: [resize("bottom", { width: 400 }, { width: 120 })] };
  const resting = anchorPoint(drawnText(layer, 0, fonts), { u: 0.5, v: 1 });
  closePoint(anchorPoint(drawnText(layer, 1, fonts), { u: 0.5, v: 1 }), resting, "the bottom middle stays put");
  // The renderer the canvas and the raster exports share passes its fonts on.
  const scene = createScene({ id: "main", width: 600, height: 800, duration: 1, layers: [layer] });
  const [x, y, halfWidth, halfHeight] = renderSceneSvg(scene, 1, { fonts })
    .match(/data-layer-id="words"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\) translate\(([-\d.]+) ([-\d.]+)\)/).slice(1).map(Number);
  closePoint({ x: x + halfWidth, y: y + 2 * halfHeight }, resting, "the drawn box's bottom middle", 1e-3);
});

test("groups, audio and component instances are refused with a reason", () => {
  for (const type of ["group", "audio", "component"]) {
    assert.ok(resizeProblem({ type, id: "it" }, { to: { width: 10 } }), type);
    assert.throws(() => presetAnimation("resize", { type, id: "it", width: 10, height: 10 }, 0), TypeError, type);
  }
  assert.match(resizeProblem({ type: "group", id: "g" }, { to: { height: 1 } }), /Animate the size of the layers inside the group instead/);
  assert.equal(resizeProblem({ type: "group", id: "g" }, { to: { opacity: 1 } }), null, "other animations are not a Resize");
  assert.equal(isResizeAnimation({ from: {}, to: { height: 2 } }), true);
});

function documentWith(layers) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 400, height: 300, duration: 4, layers })] }));
}

test("the model keeps a valid anchor and refuses anything else", () => {
  const layer = createLayer("rectangle", { id: "box", width: 100, height: 60 });
  const saved = documentWith([{ ...layer, animations: [resize("bottom-left", { width: 100 }, { width: 140 })] }]);
  const animation = saved.scenes[0].layers[0].animations[0];
  assert.equal(animation.anchor, "bottom-left");
  assert.deepEqual(JSON.parse(JSON.stringify(parseDocument(JSON.parse(JSON.stringify(saved))))).scenes[0].layers[0].animations[0].anchor,
    "bottom-left", "saving and opening keeps the anchor");
  const removed = documentWith([{ ...layer, animations: [{ ...resize(null, { width: 100 }, { width: 140 }), anchor: null }] }]);
  assert.equal(Object.hasOwn(removed.scenes[0].layers[0].animations[0], "anchor"), false, "null removes the anchor");
  assert.throws(() => documentWith([{ ...layer, animations: [resize("middle", { width: 100 }, { width: 140 })] }]), /anchor: must be one of center, top-left/);
  assert.throws(() => documentWith([{ ...layer, animations: [resize("center", { opacity: 0 }, { opacity: 1 })] }]), /only a Resize/);
  assert.throws(() => documentWith([{ ...layer, animations: [{ id: "hide", name: "Hide", kind: "hide", start: 1, anchor: "center" }] }]), /instant and cannot have anchor/);
  const group = createLayer("group", { id: "group", width: 100, height: 60 });
  assert.throws(() => documentWith([{ ...group, animations: [resize("center", { width: 100 }, { width: 140 })] }]), /can't be added to group layer group/);
});

test("apply_operations adds a Resize, changes its anchor and refuses groups and bad anchors", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "box", x: 10, y: 10, width: 100, height: 50 }),
    createLayer("group", { id: "group", width: 100, height: 60 }),
    createLayer("text", { id: "label", text: "Hi", textResize: "width-height" }),
  ]);
  const added = applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "box", preset: "resize", start: 0.5 }]);
  const animation = added.scenes[0].layers[0].animations[0];
  assert.deepEqual([animation.name, animation.anchor, animation.from, animation.to],
    ["Resize", "center", { width: 100, height: 50 }, { width: 150, height: 75 }]);
  const moved = applyOperations(added, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: animation.id, properties: { anchor: "top-right" } }]);
  assert.equal(moved.scenes[0].layers[0].animations[0].anchor, "top-right");
  const cleared = applyOperations(moved, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: animation.id, properties: { anchor: null } }]);
  assert.equal(cleared.scenes[0].layers[0].animations[0].anchor, undefined);
  assert.throws(() => applyOperations(added, [{ type: "update_animation", sceneId: "main", layerId: "box", animationId: animation.id, properties: { anchor: "north" } }]), /must be one of/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "group", preset: "resize" }]), /can't be added to group layer group/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "group", animation: resize(null, { width: 100 }, { width: 10 }) }]), /group layer group/);
  assert.throws(() => applyOperations(document, [{ type: "add_animation", sceneId: "main", layerId: "label", animation: resize("center", { width: 10 }, { width: 100 }) }]), /Auto width/);
});

test("an older size animation on a group still plays, and edits that keep its sizes are allowed", () => {
  // A reveal wipe saved before Resize refused groups: the clip-content group's width grows.
  const wipe = { id: "wipe", name: "Wipe", kind: "custom", start: 0, duration: 1, easing: "linear", from: { width: 0 }, to: { width: 200 } };
  const fade = { id: "fade", name: "Fade", kind: "custom", start: 0, duration: 1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } };
  const document = documentWith([createLayer("group", { id: "g", clipContent: true, width: 200, height: 100, animations: [wipe, fade] })]);
  assert.equal(evaluateLayer(document.scenes[0].layers[0], 0.25).width, 50, "it still plays");
  const update = (properties, animationId = "wipe") =>
    applyOperations(document, [{ type: "update_animation", sceneId: "main", layerId: "g", animationId, properties }]).scenes[0].layers[0].animations[0];
  assert.equal(update({ name: "Reveal wipe" }).name, "Reveal wipe");
  assert.deepEqual([update({ start: 0.5, easing: "smooth" }).start, update({ start: 0.5, easing: "smooth" }).easing], [0.5, "smooth"]);
  assert.equal(update({ ...wipe, easing: "bounce" }).easing, "bounce", "the whole animation sent back with only its easing changed");
  const many = applyOperations(document, [{ type: "update_animations", sceneId: "main", animationIds: ["wipe", "fade"], properties: { duration: 2 } }]);
  assert.deepEqual(many.scenes[0].layers[0].animations.map((animation) => animation.duration), [2, 2]);
  // New sizes, an anchor, or turning another animation into a size animation are still refused.
  assert.throws(() => update({ to: { width: 300 } }), /can't be added to group layer g/);
  assert.throws(() => update({ anchor: "center" }), /group layer g/);
  assert.throws(() => update({ to: { opacity: 1, height: 50 } }, "fade"), /group layer g/);
  assert.throws(() => applyOperations(document, [{ type: "update_animations", sceneId: "main", animationIds: ["wipe"], properties: { from: { width: 20 } } }]), /group layer g/);
});

test("copying, pasting and duplicating keep the anchor; a paste onto a group is skipped", () => {
  const document = documentWith([
    createLayer("rectangle", { id: "box", width: 100, height: 50, animations: [resize("top", { width: 100, height: 50 }, { width: 40, height: 80 })] }),
    createLayer("ellipse", { id: "dot", width: 30, height: 30 }),
    createLayer("group", { id: "group", width: 100, height: 60 }),
  ]);
  const envelope = JSON.parse(JSON.stringify(copyAnimation(document, "main", "box", "resize-top")));
  const { document: pasted, skipped } = pasteAnimations(document, "main", ["dot", "group"], envelope, 1);
  const copy = pasted.scenes[0].layers.find((layer) => layer.id === "dot").animations[0];
  assert.deepEqual([copy.anchor, copy.start, copy.to], ["top", 1, { width: 40, height: 80 }]);
  assert.deepEqual(skipped.map((item) => item.layerId), ["group"]);
  const { document: duplicated, rootIds } = duplicateSelection(document, "main", ["box"]);
  const twin = duplicated.scenes[0].layers.find((layer) => layer.id === rootIds[0]);
  assert.equal(twin.animations[0].anchor, "top");
});

test("the SVG renderer the canvas and raster exports share draws the anchored box", () => {
  const scene = createScene({ id: "main", width: 200, height: 200, duration: 1, layers: [
    createLayer("rectangle", { id: "box", x: 50, y: 50, width: 100, height: 100, animations: [resize("bottom-right", { width: 100, height: 100 }, { width: 50, height: 20 })] }),
  ] });
  const svg = renderSceneSvg(scene, 1);
  assert.match(svg, /data-layer-id="box" transform="translate\(100 130\) translate\(25 10\)/, "the box ends at the same bottom-right corner (150, 150)");
});
