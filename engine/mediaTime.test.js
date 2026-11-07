// The clip speed time map (mediaTime.js) and how playback.js uses it: which moment of the file
// each scene time shows, how long Play lasts, and the inverse that places beats on the scene.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { easingAt, evaluateLayer, presetAnimation, speedSampler } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import {
  effectiveMediaDuration, gifFrameIndex, mediaDesignTime, mediaFrameState, mediaPlaybackRange, mediaSceneTime, mediaSoundTime,
} from "./playback.js";
import { fileSecondsPlayed, isRemapped, playSecondsFor, speedAtClock } from "./mediaTime.js";
import { audioSyncState, maxPlayDuration, videoSyncState } from "./mediaPlay.js";

const near = (actual, expected, tolerance = 1e-9, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ""} ${actual} is not within ${tolerance} of ${expected}`);

function video(overrides = {}) {
  return createLayer("video", {
    id: "clip", src: "/api/media/clip.mp4", mediaStart: 0, mediaOffset: 0, mediaDuration: 0,
    mediaSourceDuration: 10, mediaFreeze: "both", ...overrides,
  });
}

const speedRamp = (start, duration, from, to, easing = "linear", id = "ramp") =>
  ({ id, name: "Speed", kind: "custom", start, duration, easing, from: { speed: from }, to: { speed: to } });

// The file seconds read by each of `times` (sorted), added up in steps of 0.1 ms: a plain
// midpoint sum, independent of mediaTime.js's Simpson steps.
function bruteForce(layer, times) {
  const sample = speedSampler(layer);
  const step = 1e-4;
  let clock = layer.mediaStart ?? 0;
  let total = 0;
  return times.map((time) => {
    for (; clock + step <= time; clock += step) total += sample(clock + step / 2) * step;
    return total + sample((clock + time) / 2) * (time - clock);
  });
}

test("a constant speed reads speed × the Play time, and Play ends when the file runs out", () => {
  const fast = video({ mediaSpeed: 2, mediaStart: 1, mediaOffset: 1 });
  assert.equal(isRemapped(fast), true);
  assert.equal(effectiveMediaDuration(fast), 4.5, "9 seconds of file at 2× take 4.5 s");
  assert.equal(mediaFrameState(fast, 2).sourceTime, 3);
  assert.equal(mediaFrameState(fast, 3.25).sourceTime, 5.5);
  const slow = video({ mediaSpeed: 0.5, mediaDuration: 4 });
  assert.equal(effectiveMediaDuration(slow), 4, "the stored duration is in scene seconds");
  assert.equal(mediaFrameState(slow, 3).sourceTime, 1.5);
  assert.equal(effectiveMediaDuration(video({ mediaSpeed: 0.5 })), 20, "an open clip at half speed lasts twice its file");
  // Speed 1 is the plain map, number for number.
  const plain = video({ mediaOffset: 0.3 });
  assert.equal(isRemapped(plain), false);
  for (const time of [0, 0.1, 2.7, 9.69]) assert.equal(mediaFrameState(plain, time).sourceTime, 0.3 + time);
});

test("an eased Speed animation reads the area under its speed curve, the same as a fine sum", () => {
  for (const easing of ["linear", "smooth", "ease-in", "elastic", "overshoot"]) {
    const layer = video({ mediaStart: 0.5, animations: [speedRamp(1, 2, 1, 0.25, easing), speedRamp(4, 0.5, 0.25, 1, easing, "back")] });
    const times = [0.9, 1.37, 2, 2.999, 3.5, 4.2, 4.5, 6];
    const sums = bruteForce(layer, times);
    for (const [index, time] of times.entries()) {
      const expected = sums[index];
      near(mediaFrameState(layer, time).sourceTime, expected, 1e-6, `${easing} at ${time}`);
      // The inverse gives back the same moment.
      near(mediaSceneTime(layer, expected), time, 1e-6, `${easing} inverse at ${time}`);
    }
  }
  // Linear 1 → 0.25 over 1 s reads 0.625 s of file; after it the clip runs at a quarter speed.
  const linear = video({ animations: [speedRamp(1, 1, 1, 0.25)] });
  near(mediaFrameState(linear, 2).sourceTime, 1.625);
  near(mediaFrameState(linear, 1.5).sourceTime, 1.40625);
  near(effectiveMediaDuration(linear), 2 + (10 - 1.625) / 0.25, 1e-9, "Play lasts until the slow part reaches the file's end");
  near(speedAtClock(linear, 1.5), 0.625);
});

test("a Speed animation as long as the longest scene (ten minutes) still reads the right moment", () => {
  // Past 120 s the time map's steps grow (at most 120,000 of them: 5 ms each over ten minutes).
  // Measured against a 0.5 ms sum for every easing the worst was 0.0014 ms (16× → 0.05× ease-in,
  // this one); a frame at 120 fps is 8.3 ms. The sum here uses 1 ms steps to stay quick.
  const layer = video({ mediaSourceDuration: 20_000, animations: [speedRamp(0, 600, 16, 0.05, "ease-in")] });
  const sample = speedSampler(layer);
  const times = [37.123, 150, 299.99, 450.5, 599.9];
  const step = 1e-3;
  let clock = 0, total = 0;
  for (const time of times) {
    for (; clock + step <= time; clock += step) total += (step / 6) * (sample(clock) + 4 * sample(clock + step / 2) + sample(clock + step));
    const width = time - clock;
    const expected = total + (width / 6) * (sample(clock) + 4 * sample(clock + width / 2) + sample(time));
    near(fileSecondsPlayed(layer, time), expected, 1e-5, `file time at ${time} s`);
    near(playSecondsFor(layer, expected), time, 1e-5, `inverse at ${time} s`);
  }
});

test("the time map is the same number on every call and for every copy of the layer", () => {
  const layer = video({ animations: [speedRamp(0.2, 1.3, 1, 3, "smooth")] });
  const first = [0.1, 0.7, 1.1, 1.9].map((time) => mediaFrameState(layer, time).sourceTime);
  const copy = structuredClone(layer);
  assert.deepEqual([0.1, 0.7, 1.1, 1.9].map((time) => mediaFrameState(copy, time).sourceTime), first);
  // evaluateLayer copies the layer; the picture it would show is the same.
  assert.equal(evaluateLayer(layer, 1.1).speed, speedAtClock(layer, 1.1));
});

test("a reversed clip plays the same stretch of the file from its end back to its start", () => {
  const layer = video({ mediaReverse: true, mediaStart: 1, mediaOffset: 2, mediaDuration: 4 });
  near(mediaFrameState(layer, 1).sourceTime, 5.998, 1e-9, "Play starts 2 ms before the end of the stretch");
  near(mediaFrameState(layer, 2).sourceTime, 5);
  near(mediaFrameState(layer, 5).sourceTime, 2, 1e-9, "Play ends on the stretch's first frame");
  assert.deepEqual(mediaFrameState(layer, 0.5), { visible: true, playing: false, sourceTime: mediaFrameState(layer, 1).sourceTime },
    "before Play, Freeze shows the first frame shown (the end of the stretch)");
  assert.deepEqual(mediaFrameState(layer, 6), { visible: true, playing: false, sourceTime: 2 }, "after Play it holds the last frame shown");
  near(mediaDesignTime(layer), 5.998);
  // Open Play backwards from the end of the file at double speed.
  const open = video({ mediaReverse: true, mediaSpeed: 2 });
  assert.equal(effectiveMediaDuration(open), 5);
  near(mediaFrameState(open, 0).sourceTime, 9.998);
  near(mediaFrameState(open, 2.5).sourceTime, 5);
  near(mediaSoundTime(open, 2.5), 5);
  near(mediaSceneTime(open, 4), 3, 1e-9, "a reversed clip reaches 4 s into the file 3 s into Play");
});

test("mediaFrameRate holds each picture for a whole step, and the sound does not step", () => {
  const layer = video({ mediaFrameRate: 4, mediaSpeed: 2 });
  for (const [time, source] of [[0, 0], [0.2, 0], [0.25, 0.5], [0.498, 0.5], [0.5, 1], [1.1, 2]])
    near(mediaFrameState(layer, time).sourceTime, source, 1e-9, `at ${time}`);
  near(mediaFrameState(layer, 0.2495).sourceTime, 0.5, 1e-9, "a frame time 0.5 ms early (rounded export step) counts as the next step");
  near(mediaSoundTime(layer, 0.2), 0.4);
  assert.equal(videoSyncState(layer, 0.3, { playing: true }).play, false, "a browser element is moved to each step instead of playing");
});

test("Play's start and end edges, Freeze and the stored duration work with a speed", () => {
  const ramp = [speedRamp(2, 1, 1, 4)];
  for (const freeze of ["none", "first", "last", "both"]) {
    const layer = video({ mediaStart: 1, mediaDuration: 3, mediaFreeze: freeze, animations: ramp });
    const before = mediaFrameState(layer, 0.99);
    const after = mediaFrameState(layer, 4.01);
    assert.equal(before.visible, freeze === "first" || freeze === "both", `${freeze} before`);
    assert.equal(after.visible, freeze === "last" || freeze === "both", `${freeze} after`);
    assert.equal(before.sourceTime, 0);
    // 1 s at 1×, a 1 s ramp from 1 to 4 (2.5 s of file), then 1 s at 4×: 7.5 s, held 2 ms short.
    near(after.sourceTime, 7.498);
    near(mediaFrameState(layer, 4).sourceTime, 7.498, 1e-9, "the last frame of Play is the held one");
    assert.equal(mediaFrameState(layer, 4).playing, true);
  }
  // The file ends before the stored duration: Play stops there.
  const short = video({ mediaSourceDuration: 5, mediaDuration: 4, animations: ramp });
  near(effectiveMediaDuration(short), 3 + (5 - 4.5) / 4);
  // A speed that drops to 0 and stays there never reaches the end of the file.
  const stops = video({ animations: [speedRamp(1, 1, 1, 0)] });
  assert.equal(effectiveMediaDuration(stops), Infinity);
  near(mediaFrameState(stops, 50).sourceTime, 1.5);
  assert.equal(playSecondsFor(stops, 2), Infinity);
  near(fileSecondsPlayed(stops, 1.5), 1.375);
});

test("GIFs, audio ranges and editor limits follow the speed", () => {
  const gif = createLayer("image", { id: "gif", src: "/api/media/a.gif", mediaStart: 0, mediaDuration: 2, mediaSpeed: 3 });
  const durations = [0.1, 0.1, 0.1, 0.1];
  // At 3× the loop of 0.4 s plays every 0.1333 s of scene.
  assert.equal(gifFrameIndex(durations, mediaFrameState(gif, 0.1).sourceTime), 3);
  assert.equal(gifFrameIndex(durations, mediaFrameState(gif, 0.15).sourceTime), 0);
  const audio = createLayer("audio", { id: "a", src: "/api/media/a.wav", mediaStart: 1, mediaSourceDuration: 8, mediaSpeed: 2, mediaPitch: "follow" });
  const range = mediaPlaybackRange(audio, 10);
  assert.deepEqual(range, { start: 1, end: 5, offset: 0, duration: 4, remapped: true });
  assert.deepEqual(audioSyncState(audio, 2, 10, { playing: true }), { play: true, sourceTime: 2, rate: 2, keepPitch: false });
  assert.equal(audioSyncState({ ...audio, mediaReverse: true }, 2, 10, { playing: true }).play, false, "a browser cannot play sound backwards");
  assert.equal(maxPlayDuration(audio), 4);
  assert.deepEqual(videoSyncState(video({ mediaSpeed: 0.5 }), 1, { playing: true }), { play: true, sourceTime: 0.5, rate: 0.5, keepPitch: true });
  assert.equal(videoSyncState(video({ mediaSpeed: 0.05 }), 1, { playing: true }).play, false, "slower than 1/16 is moved frame by frame");
});

test("documents check the clip timing fields and Speed animations", () => {
  const parse = (layer) => parseDocument(createDocument({ scenes: [createScene({ id: "s", duration: 5, layers: [layer] })] })).scenes[0].layers[0];
  const parsed = parse(video({ mediaSpeed: 0.25, mediaReverse: true, mediaFrameRate: 12, mediaInterpolation: "blend", mediaPitch: "follow",
    animations: [{ id: "slow", name: "Speed", kind: "custom", start: 1, duration: 1, easing: "smooth", from: {}, to: { speed: 1 } }] }));
  assert.deepEqual(parsed.animations[0].from, { speed: 0.25 }, "a Speed animation without From starts from mediaSpeed");
  assert.equal(parse(video({ mediaSpeed: null })).mediaSpeed, undefined, "null removes a field");
  const refuses = (layer, pattern) => assert.throws(() => parse(layer), pattern);
  refuses(video({ mediaSpeed: 0 }), /mediaSpeed: must be a finite number from 0.05 to 16/);
  refuses(video({ mediaSpeed: 17 }), /mediaSpeed: must/);
  refuses(video({ mediaFrameRate: 0.5 }), /mediaFrameRate: must be a finite number from 1 to 120/);
  refuses(video({ mediaInterpolation: "smooth" }), /mediaInterpolation: must be nearest, blend, flow/);
  refuses(video({ mediaPitch: "high" }), /mediaPitch: must be keep or follow/);
  refuses(video({ mediaReverse: "yes" }), /mediaReverse: must be true or false/);
  refuses(video({ mediaReverse: true, mediaSourceDuration: 0 }), /mediaReverse: needs a known end/);
  refuses(createLayer("audio", { mediaInterpolation: "blend" }), /mediaInterpolation: needs a video layer/);
  refuses(createLayer("audio", { mediaFrameRate: 12 }), /mediaFrameRate: needs a video or GIF image layer/);
  refuses(createLayer("image", { mediaPitch: "keep" }), /mediaPitch: needs a video or audio layer/);
  refuses(createLayer("rectangle", { mediaSpeed: 2 }), /mediaSpeed: needs a video or audio or GIF image layer/);
  refuses(createLayer("image", { mediaReverse: true }), /give the GIF a mediaDuration first/);
  refuses(video({ animations: [speedRamp(0, 1, 1, 20)] }), /to\.speed: must be a finite number from 0 to 16/);
  refuses(createLayer("rectangle", { animations: [speedRamp(0, 1, 1, 2)] }), /a Speed animation needs a video, audio or GIF image layer/);
  assert.equal(isAnimationCompatible(createLayer("text"), speedRamp(0, 1, 1, 2)), false);
  assert.equal(isAnimationCompatible(video(), speedRamp(0, 1, 1, 2)), true);
});

test("the speed preset ramps from the clip's speed down to a quarter of it", () => {
  const preset = presetAnimation("speed", video({ mediaSpeed: 2 }), 1);
  assert.equal(preset.name, "Speed");
  assert.deepEqual([preset.kind, preset.start, preset.from, preset.to], ["custom", 1, { speed: 2 }, { speed: 0.5 }]);
  assert.throws(() => presetAnimation("speed", createLayer("rectangle")), /Speed preset requires a video, audio or GIF image layer/);
  // easingAt is what the integration samples; it stays inside 0..1 for the default "smooth".
  assert.ok(easingAt("smooth", 0.5) > 0 && easingAt("smooth", 0.5) < 1);
});
