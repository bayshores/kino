import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene } from "./model.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import {
  MAX_PLAY_TIME,
  MIN_PLAY_SECONDS,
  allowedMediaDrift,
  audioSyncState,
  importedPlayFields,
  maxPlayOffset,
  playFieldPatch,
  syncMediaElement,
  videoSyncState,
} from "./mediaPlay.js";

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-5, `${message ?? ""} expected ${expected}, got ${actual}`);

function video(fields = {}) {
  return createLayer("video", { src: "/api/media/clip.mp4", mediaSourceDuration: 6, mediaDuration: 3, ...fields });
}

function gif(fields = {}) {
  return createLayer("image", { src: "/api/media/loop.gif", mediaSourceDuration: 1.5, mediaDuration: 2, ...fields });
}

test("inspector edits clamp offset, duration, start, freeze, and volume", () => {
  const layer = video({ mediaStart: 1, mediaOffset: 1, mediaDuration: 4 });
  assert.equal(maxPlayOffset(layer), 5.99);
  assert.deepEqual(playFieldPatch(layer, "mediaOffset", 3), { mediaOffset: 3, mediaDuration: 3 }, "duration shrinks to the remaining source");
  assert.deepEqual(playFieldPatch(layer, "mediaOffset", 1.5), { mediaOffset: 1.5 });
  assert.deepEqual(playFieldPatch(layer, "mediaOffset", 99), { mediaOffset: 5.99, mediaDuration: 0.01 });
  assert.deepEqual(playFieldPatch(layer, "mediaOffset", -1), { mediaOffset: 0 });
  assert.deepEqual(playFieldPatch(layer, "mediaDuration", 9), { mediaDuration: 5 });
  close(playFieldPatch(layer, "mediaDuration", 0).mediaDuration, MIN_PLAY_SECONDS, "one frame is the shortest Play");
  assert.deepEqual(playFieldPatch(layer, "mediaStart", MAX_PLAY_TIME - 1), { mediaStart: MAX_PLAY_TIME - 4 }, "start + duration stays within the time limit");
  assert.deepEqual(playFieldPatch(gif({ mediaStart: 0 }), "mediaDuration", 90), { mediaDuration: 90 }, "GIF Play is not limited by its loop");
  assert.deepEqual(playFieldPatch(gif({ mediaStart: MAX_PLAY_TIME - 90 }), "mediaDuration", 100), { mediaDuration: 90 });
  assert.deepEqual(playFieldPatch(gif(), "mediaOffset", 4), { mediaOffset: 4 }, "GIF offsets may pass the loop length");
  assert.deepEqual(playFieldPatch(layer, "mediaFreeze", "last"), { mediaFreeze: "last" });
  assert.throws(() => playFieldPatch(layer, "mediaFreeze", "always"), /Freeze/);
  assert.deepEqual(playFieldPatch(layer, "volume", 1.4), { volume: 1 });
  assert.throws(() => playFieldPatch(layer, "x", 1), /not a Play setting/);
});

test("imports set Play from the source length, capped by the scene", () => {
  assert.deepEqual(importedPlayFields({ type: "image", sourceDuration: 2, animated: true, sceneDuration: 5 }), {
    mediaStart: 0, mediaOffset: 0, mediaFreeze: "none", mediaSourceDuration: 2, mediaDuration: 2,
  });
  assert.equal(importedPlayFields({ type: "image", sourceDuration: 8, animated: true, sceneDuration: 5 }).mediaDuration, 5);
  assert.equal(importedPlayFields({ type: "image", sourceDuration: 0.1, animated: false, sceneDuration: 5 }).mediaDuration, 0, "a single-frame GIF stays still");
  assert.equal(importedPlayFields({ type: "image", sourceDuration: 0, animated: false, sceneDuration: 5 }).mediaDuration, 0);
  assert.deepEqual(importedPlayFields({ type: "video", sourceDuration: 12, sceneDuration: 5 }), {
    mediaStart: 0, mediaOffset: 0, mediaFreeze: "none", mediaSourceDuration: 12, mediaDuration: 5,
  });
  assert.equal(importedPlayFields({ type: "video", sourceDuration: 0, sceneDuration: 5 }).mediaDuration, 0, "unknown length plays to the end");
  assert.deepEqual(importedPlayFields({ type: "audio", sourceDuration: 30, sceneDuration: 5 }), {
    mediaStart: 0, mediaOffset: 0, mediaFreeze: "none", mediaSourceDuration: 30, mediaDuration: 5,
  });
  assert.equal(importedPlayFields({ type: "audio", sourceDuration: 3, sceneDuration: 5 }).mediaDuration, 3);
  assert.equal(importedPlayFields({ type: "audio", sourceDuration: 300, sceneDuration: 500 }).mediaDuration, 300, "a five-minute song plays whole");
  assert.equal(importedPlayFields({ type: "audio", sourceDuration: 3600, sceneDuration: 5000 }).mediaDuration, MAX_PLAY_TIME, "within the document time limit");
  assert.equal(importedPlayFields({ type: "audio", sourceDuration: 0, sceneDuration: 5 }).mediaDuration, 0, "unknown length plays to the end");
});

test("the editor video follows the scene clock and holds outside Play", () => {
  const layer = video({ mediaStart: 1, mediaOffset: 2, mediaDuration: 3, mediaFreeze: "both" });
  assert.deepEqual(videoSyncState(layer, 2, { design: true, playing: true }), { play: false, sourceTime: 2 }, "design shows the offset frame");
  assert.deepEqual(videoSyncState(layer, 0.5, { playing: true }), { play: false, sourceTime: 2 });
  assert.deepEqual(videoSyncState(layer, 2.5, { playing: true }), { play: true, sourceTime: 3.5 });
  assert.deepEqual(videoSyncState(layer, 2.5, { playing: false }), { play: false, sourceTime: 3.5 }, "a paused editor seeks instead of playing");
  const after = videoSyncState(layer, 6, { playing: true });
  assert.equal(after.play, false);
  assert.ok(after.sourceTime < 5 && after.sourceTime > 4.99, "after Play the last frame before the end is held");
});

test("the editor video stays paused on the held frame before and after a component instance", () => {
  const clip = createLayer("video", { id: "clip", src: "/api/media/clip.mp4", mediaDuration: 5, mediaSourceDuration: 5, mediaFreeze: "both" });
  const source = createScene({ id: "source", isComponent: true, duration: 5, layers: [clip] });
  const main = createScene({ id: "main", duration: 10, layers: [createComponentInstance(source, { id: "instance", componentStart: 2 })] });
  const layer = expandComponents(createDocument({ scenes: [main, source] }), "main").layers.find((item) => item.type === "video");
  // The instance plays from 2 s to 7 s; outside that its hold window pins the clock.
  for (const time of [0, 1, 1.99]) assert.deepEqual(videoSyncState(layer, time, { playing: true }), { play: false, sourceTime: 0 }, `before at ${time}`);
  for (const time of [2, 4.5, 6.9]) assert.equal(videoSyncState(layer, time, { playing: true }).play, true, `inside at ${time}`);
  close(videoSyncState(layer, 4.5, { playing: true }).sourceTime, 2.5);
  for (const time of [7.5, 9]) {
    const state = videoSyncState(layer, time, { playing: true });
    assert.equal(state.play, false, `after at ${time}`);
    assert.ok(state.sourceTime > 4.99 && state.sourceTime < 5, "the held last frame shows");
  }
});

test("editor audio plays once inside its range, read from the offset", () => {
  const layer = createLayer("audio", { mediaStart: 1, mediaOffset: 2, mediaDuration: 3, mediaSourceDuration: 4 });
  assert.deepEqual(audioSyncState(layer, 0.5, 10, { playing: true }), { play: false, sourceTime: 2 });
  assert.deepEqual(audioSyncState(layer, 2, 10, { playing: true }), { play: true, sourceTime: 3 });
  // The 4 s source has 2 s left after the offset, so the range ends at 3 s.
  assert.deepEqual(audioSyncState(layer, 3.5, 10, { playing: true }), { play: false, sourceTime: 4 });
  assert.deepEqual(audioSyncState(layer, 2, 10, { playing: true, design: true }).play, false);
  assert.deepEqual(audioSyncState(layer, 2, 0.5, { playing: true }), { play: false, sourceTime: 2 }, "no range inside a short scene");
});

test("a playing clip may drift the same scene time at any speed, and never less than half a frame of its file", () => {
  assert.equal(allowedMediaDrift(1, 0.08), 0.08);
  assert.equal(allowedMediaDrift(2, 0.08), 0.16, "2×: 0.08 s of the scene is 0.16 s of the file");
  assert.equal(allowedMediaDrift(0.5, 0.08), 0.04);
  assert.equal(allowedMediaDrift(0.25, 0.08), 0.02, "0.25×: 0.08 s of the scene is 0.02 s of the file");
  assert.equal(allowedMediaDrift(0.1, 0.08), 0.02, "slower still: half a frame of 25 to 30 fps footage");
  assert.equal(allowedMediaDrift(Number.NaN, 0.08), 0.08);
});

// A stand-in for a <video> element: a seek sets `seeking` until `finishSeek`, and is recorded.
function fakeMedia({ duration = 60, currentTime = 0, paused = true } = {}) {
  let time = currentTime;
  return {
    duration, paused, seeking: false, muted: true, playbackRate: 1, preservesPitch: true, seeks: [],
    get currentTime() { return time; },
    set currentTime(value) { time = value; this.seeking = true; this.seeks.push(value); },
    finishSeek() { this.seeking = false; },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
}

test("a playing video that is still seeking is left to finish instead of being sought every frame", () => {
  const media = fakeMedia({ currentTime: 10, paused: false });
  const play = (sourceTime, now) => syncMediaElement(media, { play: true, sourceTime }, { playing: true, now });
  play(12, 0);
  assert.deepEqual(media.seeks, [12], "far away: one seek");
  // The decoder takes 300 ms; the scene moves on a frame at a time meanwhile.
  for (let frame = 1; frame <= 9; frame++) play(12 + frame / 30, frame * 33);
  assert.deepEqual(media.seeks, [12], "no new seek while the first one runs");
  media.finishSeek();
  play(12.4, 330);
  // Late by 0.4 s: sought again, this time ahead by how long the last seek took (0.33 s).
  assert.equal(media.seeks.length, 2);
  close(media.seeks[1], 12.4 + 0.33);
  // A jump of the scene while seeking (a click on the scrub bar) is followed at once.
  play(30, 340);
  assert.equal(media.seeks.at(-1), 30);
});

test("a small drift is closed by playing a little faster or slower, not by a seek", () => {
  const media = fakeMedia({ currentTime: 5, paused: false });
  syncMediaElement(media, { play: true, sourceTime: 5.05, rate: 1 }, { playing: true, drift: 0.08, now: 0 });
  assert.deepEqual(media.seeks, [], "0.05 s late: no seek");
  assert.ok(media.playbackRate > 1 && media.playbackRate <= 1.25, `plays faster to catch up: ${media.playbackRate}`);
  syncMediaElement(media, { play: true, sourceTime: 4.95, rate: 2 }, { playing: true, drift: 0.08, now: 33 });
  assert.ok(media.playbackRate < 2 && media.playbackRate >= 1.5, `ahead at 2x: a little slower than 2x: ${media.playbackRate}`);
  syncMediaElement(media, { play: true, sourceTime: 5.005, rate: 2 }, { playing: true, drift: 0.08, now: 66 });
  assert.equal(media.playbackRate, 2, "in step: the clip's own speed");
  assert.deepEqual(media.seeks, []);
});

test("a stepped clip waits for its last seek while the scene plays, and is always moved while paused", () => {
  const media = fakeMedia({ currentTime: 2 });
  syncMediaElement(media, { play: false, sourceTime: 1.9 }, { playing: true, now: 0 });
  syncMediaElement(media, { play: false, sourceTime: 1.87 }, { playing: true, now: 33 });
  assert.deepEqual(media.seeks, [1.9], "playing: the next frame waits for the seek before");
  media.finishSeek();
  syncMediaElement(media, { play: false, sourceTime: 1.83 }, { playing: true, now: 66 });
  assert.deepEqual(media.seeks, [1.9, 1.83]);
  syncMediaElement(media, { play: false, sourceTime: 1.5 }, { playing: false, now: 99 });
  assert.deepEqual(media.seeks, [1.9, 1.83, 1.5], "paused: every change is shown");
});

test("a clip that just started playing catches up by playing faster instead of seeking", () => {
  const media = fakeMedia({ currentTime: 3 });
  const play = (sourceTime, now) => syncMediaElement(media, { play: true, sourceTime }, { playing: true, drift: 0.08, now });
  play(3, 0);
  assert.equal(media.paused, false);
  // The element's time does not move for its first 0.2 s.
  for (let frame = 1; frame <= 6; frame++) play(3 + frame / 30, frame * 33);
  assert.deepEqual(media.seeks, [], "no seek at the clip start");
  assert.ok(media.playbackRate > 1, `plays faster to catch up: ${media.playbackRate}`);
  // Later the usual limit holds again.
  play(3.3, 1000);
  assert.deepEqual(media.seeks.length, 1);
});
