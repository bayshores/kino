import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { layerMatrix, point } from "./geometry.js";
import { layoutText } from "./textLayout.js";
import { textUnitGroup } from "./textUnitGeometry.js";
import { textAnimationPlan, textAnimationUnitState } from "./textAnimation.js";
import { textDrawingsAt } from "./textChangeDraw.js";
import { patchPresetAnimation } from "./presetCatalog.js";
import { renderLayerSvg } from "./render.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const text = (overrides = {}) => createLayer("text", { id: "text", text: "Hi all", x: 30, y: 40, width: 240, height: 90,
  textResize: "fixed", fontSize: 40, lineHeight: 1.2, ...overrides });
const timed = (overrides = {}) => ({ id: "effect", name: "Effect", kind: "in", start: 0, duration: 1,
  easing: "linear", unit: "letters", stagger: .1, order: "forward", from: { rotation: 90 }, to: { rotation: 0 }, ...overrides });
const parsed = (layer) => parseDocument(createDocument({ scenes: [createScene({ layers: [layer] })] })).scenes[0].layers[0];

test("text anchors and clips validate on ordinary text operations and null removes them", () => {
  for (const textAnchor of ["layer", "letters", "words", "lines"]) {
    const layer = parsed(text({ animations: [timed({ textAnchor, textClip: true })] }));
    assert.equal(layer.animations[0].textAnchor, textAnchor);
    assert.equal(layer.animations[0].textClip, true);
  }
  const legacy = timed();
  assert.deepEqual(parsed(text({ animations: [{ ...legacy, textAnchor: null, textClip: null }] })).animations[0], parsed(text({ animations: [legacy] })).animations[0]);
  for (const patch of [{ textAnchor: "glyph" }, { textClip: 1 }, { textAnchor: {} }])
    assert.throws(() => parsed(text({ animations: [timed(patch)] })), /textAnchor|textClip/);
  assert.throws(() => parsed(createLayer("rectangle", { animations: [timed({ textAnchor: "layer" })] })), /text layer/);
  for (const kind of ["hide", "show", "change-text", "counter"])
    assert.throws(() => parsed(text({ animations: [{ ...timed(), kind, textClip: true }] })), /textClip|timed/);
});

test("custom text effects combine independent properties and travel in line-height percentages", () => {
  const layer = text({ scaleX: -2, scaleY: .5, opacity: .8, fill: "#112233", blur: 3, rotation: 15 });
  const animation = presetAnimation("preset-custom-text", layer, 0, null, { parameters: {
    moveX: -50, moveY: 100, angle: -45, scale: 25, opacity: 50, color: "#abcdef", blur: 7,
  } });
  assert.deepEqual(animation.from, { x: 6, y: 88, rotation: -30, blur: 10, scaleX: -.5, scaleY: .125, opacity: .4, fill: "#abcdef" });
  assert.deepEqual(animation.to, { x: 30, y: 40, rotation: 15, blur: 3, scaleX: -2, scaleY: .5, opacity: .8, fill: "#112233" });
  assert.equal(animation.textAnchor, "layer");
  const larger = { ...layer, fontSize: 80, animations: [animation] };
  close(evaluateLayer(larger, 0).y, 136);
  close(evaluateLayer({ ...layer, animations: [animation] }, 0).y, 88);
  const detached = patchPresetAnimation(animation, { from: { y: 200 }, to: { y: 40 } }, layer);
  assert.equal(detached.preset, undefined);
  close(evaluateLayer({ ...larger, animations: [detached] }, 0).y, 200);
  const out = patchPresetAnimation(animation, { preset: { mode: "out" } }, layer);
  assert.deepEqual(out.from, animation.to); assert.deepEqual(out.to, animation.from);
  assert.throws(() => presetAnimation("preset-custom-text", createLayer("rectangle"), 0), /text/);
  assert.throws(() => presetAnimation("preset-custom-text", layer, 0, null, { parameters: { moveY: null } }), /enabled property/);
});

test("per-unit pivots stay fixed through rotation, mirrored scales and zero scale", () => {
  for (const mode of ["letters", "words", "lines"]) {
    for (const values of [{ rotation: 145 }, { scaleX: 0, scaleY: 0 }, { scaleX: 1.3, scaleY: -2 }]) {
      const layer = text({ text: "Hi\nall", rotation: 25, scaleX: -1.2, scaleY: .8,
        animations: [timed({ textAnchor: mode, unit: "layer", stagger: 0, from: values,
          to: Object.fromEntries(Object.keys(values).map((key) => [key, key === "rotation" ? 25 : key === "scaleX" ? -1.2 : .8])) })] });
      const plan = textAnimationPlan(layer);
      assert.equal(plan.mode, mode);
      for (let index = 0; index < plan.units.length; index++) {
        const group = textUnitGroup(plan.layout, plan.units[index], mode);
        if (!group) continue;
        const { x, y, width, height } = group.bounds;
        const original = point(layerMatrix(layer), x + width / 2, y + height / 2);
        for (const time of [0, .3, .8, 1]) {
          const state = textAnimationUnitState(plan, index, time);
          const pivot = point(layerMatrix(state), x + width / 2, y + height / 2);
          close(pivot.x, original.x); close(pivot.y, original.y);
        }
      }
    }
  }
});

test("relative text travel preserves saved rest endpoints and unrelated imported property tracks", () => {
  const layer = text();
  const animation = presetAnimation("slide-up", layer, 0);
  animation.from.width = 50; animation.to.width = 200;
  animation.from.blur = 0; animation.to.blur = 4;
  animation.to.y = 60;
  const input = { ...layer, fontSize: 80, animations: [animation] };
  const start = evaluateLayer(input, 0), end = evaluateLayer(input, 5);
  close(start.y, 60 + 96 * .5); close(end.y, 60);
  close(start.width, 50); close(end.width, 200);
  close(start.blur, 0); close(end.blur, 4);
});

test("explicit text operations keep separate word and letter delay modes; legacy timing stays unchanged", () => {
  const fade = timed({ id: "fade", from: { opacity: 0 }, to: { opacity: 1 }, textAnchor: "layer" });
  const move = timed({ id: "move", from: { x: 130 }, to: { x: 30 }, unit: "words", stagger: .4, textAnchor: "layer" });
  const layer = text({ animations: [fade, move] }), plan = textAnimationPlan(layer);
  const states = plan.units.map((unit, index) => ({ unit, state: textAnimationUnitState(plan, index, .5) }));
  const firstWord = states.filter(({ unit }) => unit.sourceStart < 2);
  close(firstWord[0].state.x, firstWord[1].state.x);
  assert.notEqual(firstWord[0].state.opacity, firstWord[1].state.opacity);
  close(firstWord[0].state.x, 80);
  close(states.find(({ unit }) => unit.sourceStart === 3).state.x, 120);
  const legacy = { ...layer, animations: layer.animations.map(({ textAnchor, ...animation }) => animation) };
  const oldPlan = textAnimationPlan(legacy);
  oldPlan.units.forEach((unit, index) => assert.deepEqual(textAnimationUnitState(oldPlan, index, .5), evaluateLayer(legacy, .5,
    { unit: "letters", unitIndex: index, unitCount: oldPlan.units.length })));
});

test("unit masks stay stationary during the clipped effect and follow other layer movement", () => {
  const layer = text({ animations: [timed({ id: "slide", from: { y: 88 }, to: { y: 40 }, textClip: true, textAnchor: "letters" }),
    timed({ id: "other", from: { x: 30 }, to: { x: 70 }, unit: "layer", stagger: 0 })] });
  const plan = textAnimationPlan(layer), first = textAnimationUnitState(plan, 0, 0), middle = textAnimationUnitState(plan, 0, .5);
  close(first._textClips[0][0].y, middle._textClips[0][0].y);
  close(middle._textClips[0][0].x - first._textClips[0][0].x, 20);
  assert.notEqual(first.y, middle.y);
  const svg = renderLayerSvg(layer, .5);
  assert.match(svg, /clipPathUnits="userSpaceOnUse"><polygon/);
  assert.match(svg, /clip-path="url\(#/);
  assert.doesNotMatch(renderLayerSvg(layer, .5, { design: true }), /<polygon/);
  const inactive = { ...layer, animations: layer.animations.map((item) => ({ ...item, enabled: false })) };
  assert.equal(textAnimationPlan(inactive).clips.length, 0);
});

test("Change text strings use the shared unit plan and clipping geometry", () => {
  const layer = text({ animations: [timed({ textAnchor: "letters", textClip: true, unit: "words" }),
    { id: "swap", name: "Change", kind: "change-text", start: .2, text: "New text", overlap: false, out: null, in: null }] });
  const drawing = textDrawingsAt(layer, .5)[0];
  assert.equal(drawing.text, "New text"); assert.equal(drawing.mode, "letters");
  assert.ok(drawing.units.every(({ state }) => state._textClips.length === 1));
  assert.ok(drawing.units.every(({ state }) => Number.isFinite(state.x) && Number.isFinite(state.y)));
  const plain = textAnimationPlan({ ...layer, text: "New text", animations: [layer.animations[0]] });
  assert.deepEqual(drawing.units[0].state._textClips, textAnimationUnitState(plain, 0, .5)._textClips);
  assert.equal(layoutText(drawing.units[0].state).text, "New text");
});
