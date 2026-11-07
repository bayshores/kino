// A video's sound is heard only while the video is drawn, as in the editor preview.
import test from "node:test";
import assert from "node:assert/strict";
import { audibleRanges, hiddenSpans } from "./videoSound.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { expandComponents } from "./linkedComponents.js";
import { renderSceneSvg } from "./render.js";

const hide = (start, id = `hide-${start}`) => ({ id, name: "Hide", kind: "hide", start });
const show = (start, id = `show-${start}`) => ({ id, name: "Show", kind: "show", start });
const video = (values = {}) => createLayer("video", { id: "video", name: "Video", src: "/api/media/clip.mp4", width: 40, height: 30, ...values });
const parts = (ranges) => ranges.map(({ start, end, offset }) => [start, end, offset]);

test("without Hide or Show the sound plays through the whole Play range", () => {
  const layer = video({ mediaStart: 0.5, mediaOffset: 2 });
  assert.deepEqual(audibleRanges([layer], layer, 4), [{ start: 0.5, end: 4, offset: 2, duration: 3.5 }]);
});

test("a Hide silences the video until a later Show, and the sound goes on from the right place", () => {
  const layer = video({ mediaOffset: 1, animations: [hide(1), show(3)] });
  assert.deepEqual(hiddenSpans([layer], layer, 0, 4), [{ start: 1, end: 3 }]);
  // After the Show the file is read from 1 + 3 = 4 s: the place the preview's <video> seeks to.
  assert.deepEqual(parts(audibleRanges([layer], layer, 4)), [[0, 1, 1], [3, 4, 4]]);
  // A first operation that is a Show keeps the video silent until it, as it keeps it hidden.
  const late = video({ animations: [show(2)] });
  assert.deepEqual(parts(audibleRanges([late], late, 4)), [[2, 4, 2]]);
  // A Hide with no Show after it silences the rest of the scene.
  const gone = video({ animations: [hide(2.5)] });
  assert.deepEqual(parts(audibleRanges([gone], gone, 4)), [[0, 2.5, 0]]);
});

test("a Hide on a group around the video silences it, and an eye-hidden group silences it all the time", () => {
  const outer = createLayer("group", { id: "outer", width: 100, height: 100, animations: [hide(0.5), show(1)] });
  const inner = createLayer("group", { id: "inner", parentId: "outer", width: 100, height: 100, animations: [hide(2)] });
  const layer = video({ parentId: "inner", animations: [hide(3), show(3.5)] });
  const layers = [outer, inner, layer];
  assert.deepEqual(hiddenSpans(layers, layer, 0, 4), [{ start: 0.5, end: 1 }, { start: 2, end: 4 }]);
  assert.deepEqual(parts(audibleRanges(layers, layer, 4)), [[0, 0.5, 0], [1, 2, 1]]);
  const closed = [{ ...outer, visible: false, animations: [] }, { ...inner, animations: [] }, { ...layer, animations: [] }];
  assert.deepEqual(audibleRanges(closed, closed[2], 4), []);
});

// True when the <video> element is in the SVG outside every layer drawn ahead hidden
// (visibility="hidden": the live preview puts a video in the page a second before it shows).
function showsVideoElement(svg, id) {
  const at = svg.indexOf(`data-media-layer-id="${id}"`);
  if (at < 0) return false;
  const open = [];
  for (const tag of svg.slice(0, at).matchAll(/<g\b[^>]*>|<\/g>/g)) {
    if (tag[0] === "</g>") open.pop();
    else open.push(/\svisibility="hidden"/.test(tag[0]));
  }
  return !open.includes(true);
}

test("the silent stretches are the ones in which the preview shows no <video> element", () => {
  const group = createLayer("group", { id: "group", width: 100, height: 100, animations: [hide(1.25)] });
  const layer = video({ parentId: "group", animations: [hide(0.5), show(0.75), show(2.5)] });
  const scene = createScene({ id: "main", width: 100, height: 100, duration: 3, layers: [group, layer] });
  const spans = hiddenSpans(scene.layers, layer, 0, 3);
  const svgAt = (time) => renderSceneSvg(scene, time, {
    interactiveMedia: true, embedMedia: new Map([["video", "/api/media/clip.mp4"]]),
  });
  const drawsVideo = (time) => showsVideoElement(svgAt(time), "video");
  // Hidden from 0.5 s, the element stays in the page (hidden) for the Show at 0.75 s; after the
  // group's Hide at 1.25 s nothing shows it again, so it leaves the page.
  assert.equal(svgAt(0.6).includes('data-media-layer-id="video"'), true);
  assert.equal(svgAt(2).includes('data-media-layer-id="video"'), false);
  // Every 50 ms, including each operation's own time. (The renderer already counts an operation
  // reached up to 1 ms early, for rounded export frame times; the sound switches at the exact time.)
  for (let step = 0; step < 60; step += 1) {
    const time = step / 20;
    const silent = spans.some((span) => time >= span.start && time < span.end);
    assert.equal(drawsVideo(time), !silent, `at ${time.toFixed(2)} s`);
  }
});

test("operations closer together than 1 ms leave no sound clip of length 0", () => {
  const layer = video({ animations: [hide(1), show(1.0004), hide(1.0008), show(2)] });
  for (const range of audibleRanges([layer], layer, 3)) assert.ok(range.duration >= 1e-3, JSON.stringify(range));
});

test("in a component, a Hide on the instance silences the video inside it at the outer time", () => {
  const source = createScene({ id: "source", isComponent: true, width: 40, height: 30, duration: 2,
    layers: [video({ mediaDuration: 2, animations: [hide(0.5), show(1)] })] });
  const target = createScene({ id: "target", width: 40, height: 30, duration: 4, layers: [
    createLayer("component", { id: "instance", componentSceneId: "source", componentStart: 1, animations: [hide(2.5)] }),
  ] });
  const expanded = expandComponents(parseDocument(createDocument({ scenes: [source, target] })), "target");
  const copy = expanded.layers.find((layer) => layer.type === "video");
  // The video plays from 1 s to 3 s (the instance's range). Its own Hide and Show move with the
  // instance (1.5 s to 2 s), and the instance's Hide at 2.5 s silences the rest.
  assert.deepEqual(parts(audibleRanges(expanded.layers, copy, 4)), [[1, 1.5, 0], [2, 2.5, 1]]);
});
