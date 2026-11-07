import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TIME, createDocument, createScene, createLayer, parseDocument } from "./model.js";
import { createComponentInstance, detachComponent, expandComponents } from "./linkedComponents.js";
import { evaluateLayer } from "./animation.js";
import {
  effectiveMediaDuration,
  getScenePlaybackDuration,
  gifFrameIndex,
  mediaFrameState,
  mediaPlaybackRange,
  resolvePlayback,
  videoFrameIndex,
} from "./playback.js";
import { renderSceneSvg } from "./render.js";
import { exportFrameTimes } from "./exportOptions.js";

test("component play length includes enabled scene background Color animations", () => {
  const document = fixture(), source = document.scenes[0];
  source.backgroundAnimations = [{ id: "background-length", name: "Color", kind: "custom", start: 1, duration: 2, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#0000ff" } }];
  assert.equal(getScenePlaybackDuration(document, source.id), 3);
  const expanded = expandComponents(document, "target");
  const background = expanded.layers.find((layer) => layer.componentBackground);
  assert.equal(background.playbackWindows.at(-1).end, 4);
  assert.equal(evaluateLayer(background, 2).fill, "#ff0000");
  assert.equal(evaluateLayer(background, 3).fill, "#800080");
  assert.equal(evaluateLayer(background, 4).fill, "#0000ff");
  source.backgroundAnimations[0].enabled = false;
  assert.equal(getScenePlaybackDuration(document, source.id), 0.8);
});

function fixture(visibility = "both") {
  const source = createScene({ id: "source", isComponent: true, duration: 4, layers: [createLayer("rectangle", {
    id: "shape", x: 0, y: 0, width: 20, height: 20, animations: [{
      id: "fade", name: "Fade", kind: "in", start: 0, duration: 0.8, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 },
    }],
  })] });
  const target = createScene({ id: "target", duration: 8, layers: [createComponentInstance(source, { id: "instance", componentStart: 1, componentVisibility: visibility })] });
  return parseDocument(createDocument({ scenes: [source, target] }));
}

test("component playback length follows timed content, including text stagger, media, and nested instances", () => {
  const document = fixture();
  assert.equal(getScenePlaybackDuration(document, "source"), 0.8);
  assert.equal(getScenePlaybackDuration(document, "target"), 1.8);
  const source = document.scenes[0];
  source.layers.push(createLayer("text", { text: "ABCD", width: 1000, animations: [{ id: "stagger", start: 0.5, duration: 1, unit: "letters", stagger: 0.2 }] }));
  assert.equal(getScenePlaybackDuration(document, "source"), 2.1);
  source.layers.push(createLayer("audio", { mediaStart: 1, mediaDuration: 2 }));
  assert.equal(getScenePlaybackDuration(document, "source"), 3);
  assert.equal(getScenePlaybackDuration(document, "target"), 4);
  source.layers = [];
  assert.equal(getScenePlaybackDuration(document, "source"), 0);
  assert.equal(getScenePlaybackDuration(document, "target"), 0);
});

test("all four Keep visible modes control the wrapper, its background, and source descendants", () => {
  const expected = {
    both: [true, true, true], before: [true, true, false],
    after: [false, true, true], during: [false, true, false],
  };
  for (const [visibility, values] of Object.entries(expected)) {
    const scene = expandComponents(fixture(visibility), "target");
    for (let i = 0; i < 3; i++) {
      const time = [0.5, 1.4, 2][i];
      for (const layer of scene.layers) assert.equal(evaluateLayer(layer, time).visible, values[i], `${visibility}, ${layer.name}, ${time}`);
      assert.equal(renderSceneSvg(scene, time).includes('data-layer-id="instance"'), values[i]);
    }
    assert.equal(evaluateLayer(scene.layers[0], 1.8).visible, ["both", "after"].includes(visibility));
    assert.ok(renderSceneSvg(scene, 0, { design: true }).includes('data-layer-id="instance"'));
  }
});

test("the source clock holds endpoints while instance animations continue on the parent clock", () => {
  const document = fixture();
  document.scenes[1].layers[0].animations = [{ id: "move-instance", name: "Move", kind: "custom", start: 0, duration: 4, easing: "linear", from: { x: 0 }, to: { x: 80 } }];
  const scene = expandComponents(document, "target");
  const shape = scene.layers.find((layer) => layer.name === "Rectangle");
  assert.equal(resolvePlayback(shape, 0.5).time, 1);
  assert.equal(resolvePlayback(shape, 2).time, 1.8);
  assert.equal(evaluateLayer(shape, 0.5).opacity, 0);
  assert.ok(Math.abs(evaluateLayer(shape, 1.4).opacity - 0.5) < 1e-10);
  assert.equal(evaluateLayer(shape, 2).opacity, 1);
  assert.equal(evaluateLayer(scene.layers[0], 2).x, 40);
});

test("detaching preserves window visibility and source timing in the portable document", () => {
  const document = fixture("during");
  const detached = parseDocument(detachComponent(document, "target", "instance"));
  const scene = expandComponents(detached, "target");
  assert.equal(scene.layers[0].type, "group");
  assert.equal(evaluateLayer(scene.layers[0], 0.5).visible, false);
  assert.equal(evaluateLayer(scene.layers[0], 1.4).visible, true);
  assert.equal(evaluateLayer(scene.layers[0], 2).visible, false);
  document.scenes[0].layers[0].fill = "#ff0000";
  assert.notEqual(scene.layers.find((layer) => layer.name === "Rectangle").fill, "#ff0000");
});

test("nested source clocks hold outer endpoints before evaluating an inner window", () => {
  const layer = createLayer("rectangle", { playbackWindows: [
    { start: 1, end: 3, visibility: "both", hold: true },
    { start: 2, end: 4, visibility: "during", hold: true },
  ] });
  assert.deepEqual(resolvePlayback(layer, 0), { visible: false, time: 2 });
  assert.deepEqual(resolvePlayback(layer, 5), { visible: true, time: 3 });
});

test("media windows trim source offsets and never extend audio into held frames", () => {
  const layer = createLayer("audio", { mediaStart: 1, mediaDuration: 5, playbackWindows: [
    { start: 2, end: 4, visibility: "both", hold: true },
  ] });
  assert.deepEqual(mediaPlaybackRange(layer, 8), { start: 2, end: 4, offset: 1, duration: 2 });
  assert.deepEqual(mediaPlaybackRange(layer, 3), { start: 2, end: 3, offset: 1, duration: 1 });
  assert.equal(mediaPlaybackRange(layer, 1), null);
});

test("portable playback windows reject invalid visibility, backwards time, and missing hold flags", () => {
  const document = fixture();
  const layer = document.scenes[0].layers[0];
  for (const window of [
    { start: 2, end: 1, visibility: "both", hold: true },
    { start: 0, end: 1, visibility: "unknown", hold: true },
    { start: 0, end: 1, visibility: "both" },
  ]) {
    layer.playbackWindows = [window];
    assert.throws(() => parseDocument(document), /playbackWindows/);
  }
});

test("media Play maps scene time to source time and Freeze controls visibility outside Play", () => {
  const gif = createLayer("image", { src: "/api/media/a.gif", mediaStart: 1, mediaDuration: 2, mediaOffset: 0.5 });
  const at = (layer, time) => mediaFrameState(layer, time);
  assert.deepEqual(at(gif, 0.5), { visible: false, playing: false, sourceTime: 0.5 });
  assert.deepEqual(at(gif, 1), { visible: true, playing: true, sourceTime: 0.5 });
  assert.equal(at(gif, 2).sourceTime, 1.5);
  // The end time is part of Play; the frame shown there and held afterward is the one just before the end.
  assert.equal(at(gif, 3).visible, true);
  assert.ok(Math.abs(at(gif, 3).sourceTime - 2.498) < 1e-9);
  assert.equal(at(gif, 3.000004).visible, false);
  for (const [freeze, before, after] of [["none", false, false], ["first", true, false], ["last", false, true], ["both", true, true]]) {
    const layer = { ...gif, mediaFreeze: freeze };
    assert.equal(at(layer, 0.99).visible, before, `${freeze} before`);
    assert.equal(at(layer, 3.01).visible, after, `${freeze} after`);
    assert.equal(at(layer, 0).sourceTime, 0.5);
    assert.equal(at(layer, 99).sourceTime, at(layer, 3).sourceTime);
  }
  // A cut's first export frame falls just short of mediaStart (frame 123 at 30 fps is 4.0999959 s):
  // Play has started there, so a clip with Freeze none is not hidden (that frame drew black).
  const cut = createLayer("video", { mediaStart: 4.1, mediaOffset: 2, mediaFreeze: "none" });
  const frame123 = exportFrameTimes(10, 30, { format: "mp4" })[123];
  assert.ok(frame123 < 4.1);
  assert.deepEqual(at(cut, frame123), { visible: true, playing: true, sourceTime: 2 });
  assert.equal(at(cut, 4.1 - 1 / 30).visible, false, "the frame before the cut is still before Play");
  // A GIF without a Play duration is a still image showing its first frame.
  assert.deepEqual(mediaFrameState(createLayer("image", { mediaStart: 3 }), 0), { visible: true, playing: false, sourceTime: 0 });
  // A video with no Play duration plays until its source ends.
  assert.deepEqual(mediaFrameState(createLayer("video", { mediaStart: 1, mediaOffset: 2 }), 50), { visible: true, playing: true, sourceTime: 51 });
});

test("legacy video layers keep their first and last frames visible", () => {
  const document = createDocument({ scenes: [createScene({ id: "scene", layers: [] })] });
  const raw = JSON.parse(JSON.stringify(document));
  const video = createLayer("video", { id: "old-video", src: "/api/media/clip.mp4", mediaStart: 1, mediaDuration: 1 });
  const image = createLayer("image", { id: "old-image", src: "/api/media/still.png" });
  delete video.mediaFreeze;
  delete video.mediaOffset;
  delete video.mediaSourceDuration;
  delete image.mediaFreeze;
  raw.scenes[0].layers = [video, image];
  const parsed = parseDocument(JSON.stringify(raw));
  assert.equal(parsed.scenes[0].layers[0].mediaFreeze, "both");
  assert.equal(parsed.scenes[0].layers[0].mediaOffset, 0);
  assert.equal(parsed.scenes[0].layers[1].mediaFreeze, "none");
  assert.equal(createLayer("video").mediaFreeze, "none");
  assert.equal(evaluateLayer(parsed.scenes[0].layers[0], 0).visible, true);
  assert.equal(evaluateLayer(parsed.scenes[0].layers[0], 5).visible, true);
  raw.scenes[0].layers = [{ ...video, mediaFreeze: "sometimes" }];
  assert.throws(() => parseDocument(JSON.stringify(raw)), /mediaFreeze/);
  raw.scenes[0].layers = [{ ...video, mediaOffset: -1 }];
  assert.throws(() => parseDocument(JSON.stringify(raw)), /mediaOffset/);
});

test("GIF frames loop for the whole Play range and the held last frame never wraps", () => {
  const durations = [0.1, 0.2, 0.3];
  assert.equal(gifFrameIndex(durations, 0), 0);
  assert.equal(gifFrameIndex(durations, 0.0999), 1, "export frame times may run a fraction of a millisecond early");
  assert.equal(gifFrameIndex(durations, 0.1), 1);
  assert.equal(gifFrameIndex(durations, 0.35), 2);
  assert.equal(gifFrameIndex(durations, 0.6), 0);
  assert.equal(gifFrameIndex(durations, 1.25), 0);
  assert.equal(gifFrameIndex(durations, 1), 2);
  const layer = createLayer("image", { mediaDuration: 1.2, mediaFreeze: "last" });
  assert.equal(gifFrameIndex(durations, mediaFrameState(layer, 1.2).sourceTime), 2);
  assert.equal(gifFrameIndex(durations, mediaFrameState(layer, 5).sourceTime), 2);
  assert.equal(gifFrameIndex([], 1), -1);
  assert.equal(gifFrameIndex([0, 0], 1), 0);
});

test("video frames are chosen from the source offset and clamp to the last decoded frame", () => {
  assert.equal(videoFrameIndex(0.5, 0.5, 4, 8), 0);
  assert.equal(videoFrameIndex(0.7499, 0.5, 4, 8), 1);
  assert.equal(videoFrameIndex(0.74, 0.5, 4, 8), 0);
  assert.equal(videoFrameIndex(10, 0.5, 4, 8), 7);
  assert.equal(videoFrameIndex(0, 0.5, 4, 8), 0);
  assert.equal(videoFrameIndex(1, 0, 4, 0), -1);
  const layer = createLayer("video", { mediaDuration: 1, mediaFreeze: "last" });
  assert.equal(videoFrameIndex(mediaFrameState(layer, 4).sourceTime, 0, 60, 120), 59);
});

test("media Play ranges read the source from its offset and stop where the source ends", () => {
  const audio = createLayer("audio", { mediaStart: 1, mediaDuration: 4, mediaOffset: 2, mediaSourceDuration: 4 });
  assert.deepEqual(mediaPlaybackRange(audio, 10), { start: 1, end: 3, offset: 2, duration: 2 });
  const windowed = { ...audio, mediaSourceDuration: 0, playbackWindows: [{ start: 2, end: 3, visibility: "both", hold: true }] };
  assert.deepEqual(mediaPlaybackRange(windowed, 10), { start: 2, end: 3, offset: 3, duration: 1 });
  const scene = createScene({ id: "gif", duration: 1, layers: [createLayer("image", { mediaStart: 0.5, mediaDuration: 3 })] });
  assert.equal(getScenePlaybackDuration({ scenes: [scene] }, "gif"), 3.5);
});

test("video and audio Play ends where the source ends, even when open or stored too long", () => {
  // Source 4 s, read from 1 s: Play can last at most 3 s.
  const open = createLayer("video", { mediaSourceDuration: 4, mediaOffset: 1, mediaFreeze: "none" });
  assert.equal(effectiveMediaDuration(open), 3);
  assert.equal(effectiveMediaDuration({ ...open, mediaDuration: 10 }), 3, "a stored duration never passes the source end");
  assert.equal(effectiveMediaDuration({ ...open, mediaDuration: 2 }), 2);
  assert.equal(effectiveMediaDuration({ ...open, mediaSourceDuration: 0 }), Infinity, "unknown source length stays open");
  assert.equal(effectiveMediaDuration(createLayer("image", { mediaSourceDuration: 1, mediaDuration: 5 })), 5, "GIFs loop");
  assert.equal(mediaFrameState(open, 3).visible, true, "the end is part of Play");
  assert.deepEqual(mediaFrameState(open, 3.5), { visible: false, playing: false, sourceTime: 3.998 }, "Freeze none hides the layer after Play");
  assert.equal(mediaFrameState({ ...open, mediaDuration: 10, mediaFreeze: "last" }, 5).sourceTime, 3.998, "the last frame before the source end is held");
  assert.equal(mediaPlaybackRange({ ...open, type: "audio", mediaDuration: 10 }, 8).end, 3);
  // A component counts the open range, so its instance plays the whole range instead of freezing.
  const source = createScene({ id: "source", isComponent: true, duration: 5, layers: [{ ...open, id: "clip" }] });
  const main = createScene({ id: "main", duration: 5, layers: [createComponentInstance(source, { id: "instance" })] });
  const document = createDocument({ scenes: [main, source] });
  assert.equal(getScenePlaybackDuration(document, "source"), 3);
  const clip = expandComponents(document, "main").layers.find((layer) => layer.type === "video");
  assert.equal(mediaFrameState(clip, resolvePlayback(clip, 2.5).time).sourceTime, 3.5);
  document.scenes[1].layers[0].mediaSourceDuration = 3600;
  assert.equal(getScenePlaybackDuration(document, "source"), MAX_TIME, "a long open source counts only up to the time limit");
});
