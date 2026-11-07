import test from "node:test";
import assert from "node:assert/strict";
import {
  createVisibilityOperation,
  hiddenRanges,
  isVisibilityOperation,
  orderedVisibilityOperations,
  visibilityTimeProblem,
  visibleByOperations,
  VISIBILITY_TIME_TOLERANCE,
} from "./visibilityOps.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { MAX_TIME, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { exportFrameTimes } from "./exportOptions.js";
import { MEDIA_SAMPLE_TOLERANCE, getScenePlaybackDuration } from "./playback.js";
import { renderSceneSvg } from "./render.js";

const hide = (start, id = `hide-${start}`) => ({ id, name: "Hide", kind: "hide", start });
const show = (start, id = `show-${start}`) => ({ id, name: "Show", kind: "show", start });

test("Hide and Show apply in time order, and list order breaks a tie", () => {
  const operations = [show(3), hide(1), hide(3, "late-hide")];
  assert.deepEqual(orderedVisibilityOperations(operations).map(({ kind, start, index }) => [kind, start, index]),
    [["hide", 1, 1], ["show", 3, 0], ["hide", 3, 2]]);
  assert.equal(visibleByOperations(operations, 0.5), true, "visible before the first Hide");
  assert.equal(visibleByOperations(operations, 2), false, "hidden after the Hide at 1 s");
  // The Show at 3 s and the Hide at 3 s: the later one in the list wins.
  assert.equal(visibleByOperations(operations, 3), false);
  assert.equal(visibleByOperations([hide(3), show(3)], 3), true);
  assert.equal(visibleByOperations([], 1), true, "no operations: visible");
});

test("a layer whose first operation is a Show is hidden until that Show", () => {
  assert.equal(visibleByOperations([show(2)], 0), false);
  assert.equal(visibleByOperations([show(2)], 1.99), false);
  assert.equal(visibleByOperations([show(2)], 2), true);
  assert.equal(visibleByOperations([show(2), hide(4)], 5), false);
  // Hide first: visible before it, as designed.
  assert.equal(visibleByOperations([hide(2), show(4)], 0), true);
});

test("the state at an operation's time is the operation's result, also on rounded export frames", () => {
  assert.equal(visibleByOperations([hide(1)], 1), false);
  assert.equal(visibleByOperations([hide(1)], 1 - 1 / 120), true, "one 120 fps frame earlier is still before it");
  assert.equal(VISIBILITY_TIME_TOLERANCE, MEDIA_SAMPLE_TOLERANCE, "the same frame drift media lookups accept");
  assert.ok(exportFrameTimes(4, 30, { format: "mp4" })[30] < 1, "30 fps frame 30 is sampled just before 1 s");
  for (const fps of [24, 25, 30, 60, 120]) {
    const times = exportFrameTimes(4, fps, { format: "mp4" });
    for (const at of [1, 2.5]) {
      const frame = Math.round(at * fps);
      if (Math.abs(frame / fps - at) > 1e-9) continue; // the operation is not on a frame at this rate
      assert.equal(visibleByOperations([hide(at)], times[frame]), false, `${fps} fps frame ${frame} (${times[frame]} s) is hidden`);
      assert.equal(visibleByOperations([hide(at)], times[frame - 1]), true, `${fps} fps frame ${frame - 1} is visible`);
    }
  }
});

test("hidden ranges for the timeline follow the same rules", () => {
  assert.deepEqual(hiddenRanges([hide(1), show(2), hide(3)], 4), [{ start: 1, end: 2 }, { start: 3, end: 4 }]);
  assert.deepEqual(hiddenRanges([show(1)], 4), [{ start: 0, end: 1 }]);
  assert.deepEqual(hiddenRanges([hide(1), show(1)], 4), []);
  assert.deepEqual(hiddenRanges([hide(1), hide(2), show(3)], 4), [{ start: 1, end: 3 }]);
  assert.deepEqual(hiddenRanges([], 4), []);
});

test("Hide and Show presets are instant operations at the given time", () => {
  const layer = createLayer("rectangle", { id: "box" });
  const operation = presetAnimation("hide", layer, 1.25);
  assert.equal(isVisibilityOperation(operation), true);
  assert.deepEqual(Object.keys(operation).sort(), ["id", "kind", "name", "start"]);
  assert.deepEqual({ ...operation, id: "x" }, { id: "x", name: "Hide", kind: "hide", start: 1.25 });
  assert.equal(presetAnimation("show", layer, 0).kind, "show");
  assert.throws(() => createVisibilityOperation("fade", 1, "x"), /unknown visibility operation/);
  assert.throws(() => createVisibilityOperation("hide", -1, "x"), /start time/);
});

test("evaluateLayer combines the operations with the eye button and keeps opacity animations", () => {
  const fade = { id: "fade", name: "Fade", kind: "custom", start: 0, duration: 4, easing: "linear",
    from: { opacity: 0 }, to: { opacity: 1 } };
  const layer = createLayer("rectangle", { id: "box", animations: [fade, hide(1), show(3)] });
  assert.equal(evaluateLayer(layer, 0.5).visible, true);
  assert.equal(evaluateLayer(layer, 0.5).opacity, 0.125);
  assert.equal(evaluateLayer(layer, 1).visible, false, "hidden at the Hide's own time");
  assert.equal(evaluateLayer(layer, 2).opacity, 0.5, "the fade keeps running while hidden");
  assert.equal(evaluateLayer(layer, 3).visible, true, "shown at the Show's own time");
  assert.equal(evaluateLayer(layer, 3).opacity, 0.75, "and the fade continues where it is");
  // The eye button hides the layer at all times: a Show does not bring it back.
  assert.equal(evaluateLayer({ ...layer, visible: false }, 3.5).visible, false);
});

test("the document accepts Hide and Show and refuses timed fields on them", () => {
  const document = (animations) => createDocument({
    scenes: [createScene({ id: "main", layers: [createLayer("rectangle", { id: "box", animations })] })],
  });
  const parsed = parseDocument(document([hide(1), show(2)]));
  assert.deepEqual(parsed.scenes[0].layers[0].animations, [hide(1), show(2)]);
  for (const extra of [{ duration: 1 }, { easing: "linear" }, { from: { opacity: 0 } }, { to: { opacity: 1 } },
    { unit: "layer" }, { stagger: 0 }, { order: "forward" }]) {
    const field = Object.keys(extra)[0];
    assert.throws(() => parseDocument(document([{ ...hide(1), ...extra }])),
      new RegExp(`hide operation is instant and cannot have ${field}`));
  }
  assert.throws(() => parseDocument(document([hide(-1)])), /start/);
  assert.throws(() => parseDocument(document([hide(MAX_TIME + 1)])), /start/);
  assert.throws(() => parseDocument(document([{ ...hide(1), kind: "toggle" }])), /in, out, custom, hide, or show/);
});

test("a Hide or Show counts up to its own time in a component's playback length", () => {
  const document = createDocument({
    scenes: [createScene({ id: "main", layers: [createLayer("rectangle", { id: "box", animations: [hide(1.5), show(2.5)] })] })],
  });
  assert.equal(getScenePlaybackDuration(document, "main"), 2.5);
});

test("the preview hides a layer, and the layers inside a hidden group, from the operation's time", () => {
  const group = createLayer("group", { id: "group", width: 40, height: 40, animations: [hide(1)] });
  const child = createLayer("rectangle", { id: "child", parentId: "group", width: 10, height: 10 });
  const box = createLayer("rectangle", { id: "box", x: 50, animations: [show(2)] });
  const scene = createScene({ id: "main", width: 100, height: 100, layers: [group, child, box] });
  const drawn = (time) => ["group", "child", "box"].filter((id) => renderSceneSvg(scene, time).includes(`data-layer-id="${id}"`));
  assert.deepEqual(drawn(0), ["group", "child"], "the box waits for its first Show");
  assert.deepEqual(drawn(1), [], "the Hide at 1 s hides the group and its child");
  assert.deepEqual(drawn(2), ["box"]);
  // The design view shows the layers as designed.
  assert.match(renderSceneSvg(scene, 2, { design: true }), /data-layer-id="child"/);
});

test("a mask that a Hide hides masks nothing, like a mask hidden with the eye button", () => {
  const mask = createLayer("rectangle", { id: "mask", isMask: true, fill: "#ffffff", width: 20, height: 20, animations: [hide(1), show(2)] });
  const target = createLayer("rectangle", { id: "target", width: 100, height: 100 });
  const scene = createScene({ id: "main", width: 100, height: 100, layers: [mask, target] });
  const eyeHidden = { ...scene, layers: [{ ...mask, visible: false, animations: [] }, target] };
  const masked = /<g mask="url\(#[^"]+\)"><g data-layer-id="target"/;
  assert.match(renderSceneSvg(scene, 0), masked, "before the Hide the mask masks the target");
  const hidden = renderSceneSvg(scene, 1);
  assert.doesNotMatch(hidden, /mask=/, "while hidden it masks nothing");
  assert.match(hidden, /<g data-layer-id="target"/, "so the whole target shows");
  assert.equal(hidden, renderSceneSvg(eyeHidden, 1), "the same picture as with the mask's eye off");
  assert.match(renderSceneSvg(scene, 2), masked, "the Show turns the mask back on");
  // The design view ignores Hide and Show, so the mask masks there.
  assert.match(renderSceneSvg(scene, 1, { design: true }), masked);
});

test("in a mask group, a mask that a Hide hides lets every layer above it show whole", () => {
  const group = createLayer("group", { id: "group", isMaskGroup: true, width: 100, height: 100 });
  const mask = createLayer("ellipse", { id: "mask", parentId: "group", isMask: true, fill: "#ffffff", width: 20, height: 20, animations: [hide(1)] });
  const one = createLayer("rectangle", { id: "one", parentId: "group", width: 100, height: 100 });
  const two = createLayer("rectangle", { id: "two", parentId: "group", x: 10, width: 50, height: 50 });
  const scene = createScene({ id: "main", width: 100, height: 100, layers: [group, mask, one, two] });
  const eyeHidden = { ...scene, layers: [group, { ...mask, visible: false, animations: [] }, one, two] };
  assert.match(renderSceneSvg(scene, 0.5), /<g mask="url\(#[^"]+\)"><g data-layer-id="one"[^]*data-layer-id="two"/);
  const hidden = renderSceneSvg(scene, 1);
  assert.doesNotMatch(hidden, /mask=/);
  assert.equal(hidden, renderSceneSvg(eyeHidden, 1));
});

test("Hide and Show times must be on the scene's timeline", () => {
  assert.equal(visibilityTimeProblem(hide(0), 4), "");
  assert.equal(visibilityTimeProblem(hide(4), 4), "");
  assert.match(visibilityTimeProblem(hide(4.5), 4), /Hide at 4\.5 s is outside the scene, which lasts 4 s/);
  assert.match(visibilityTimeProblem(show(-1), 4), /Show at -1 s is outside/);
  assert.match(visibilityTimeProblem({ ...show(0), start: "1" }, 4), /needs a start time/);
  assert.equal(visibilityTimeProblem({ kind: "in", start: 9 }, 4), "", "timed animations have their own limits");
});
