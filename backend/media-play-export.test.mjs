// Exports scenes with timed media (GIF images, video, audio) and checks the exported pixels
// and samples against the Play settings: start, duration, offset, and freeze.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import {
  ffmpeg,
  makeAnimatedGif,
  makeToneAfterSilence,
  makeVideo,
  near,
  readImage,
  readVideoFrames,
  run,
  skipWithoutMediaTools,
} from "./media.test.support.mjs";

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];
const WHITE = [255, 255, 255];
const COLOR_NAMES = new Map([[RED, "red"], [GREEN, "green"], [BLUE, "blue"], [YELLOW, "yellow"], [WHITE, "background"]]);
const SIZE = 32;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-media-play-export-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  // Red, green, blue, yellow for 1/10 s each: one loop lasts 0.4 s.
  await writeFile(join(mediaRoot, "colors.gif"), makeAnimatedGif({
    width: 8, height: 8, frames: [RED, GREEN, BLUE, YELLOW].map((color) => ({ color, delayCs: 10 })),
  }));
  return { root, mediaRoot };
}

function scene(layers, duration = 3, size = SIZE) {
  return createScene({ id: "media-play", name: "Media Play", width: size, height: size, duration, background: "#ffffff", layers });
}

function gifLayer(play = {}) {
  return createLayer("image", { id: "gif", name: "GIF", x: 0, y: 0, width: SIZE, height: SIZE, src: "/api/media/colors.gif", ...play });
}

function videoLayer(src, play = {}) {
  return createLayer("video", { id: "video", name: "Video", x: 0, y: 0, width: SIZE, height: SIZE, src, ...play });
}

function colorName(pixel) {
  for (const [color, name] of COLOR_NAMES) if (near(pixel, color, 12)) return name;
  return `rgb(${pixel.slice(0, 3).join(",")})`;
}

async function stillColor(document, time, mediaRoot) {
  const result = await exportScene(document, { format: "png", time }, { mediaRoot });
  const picture = await readImage(result.buffer);
  return colorName(picture.pixel(SIZE / 2, SIZE / 2));
}

test("PNG stills of a GIF with Play follow its offset, duration, freeze, and frame delays", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { mediaRoot } = await setup(t);
  // Play from 1 s to 2 s, reading the GIF from 0.1 s (its green frame).
  const play = { mediaStart: 1, mediaDuration: 1, mediaOffset: 0.1 };
  const cases = [
    { freeze: "none", time: 0.5, expected: "background", why: "hidden before Play" },
    { freeze: "none", time: 1, expected: "green", why: "Play starts at the offset frame" },
    { freeze: "none", time: 1.25, expected: "yellow", why: "0.35 s into the GIF" },
    { freeze: "none", time: 1.45, expected: "green", why: "0.55 s wraps to 0.15 s: the GIF loops" },
    { freeze: "none", time: 2, expected: "blue", why: "Play includes its end time and shows the last frame before the end" },
    { freeze: "none", time: 2.5, expected: "background", why: "hidden after Play" },
    { freeze: "last", time: 2.5, expected: "blue", why: "Freeze last holds the final Play frame" },
    { freeze: "last", time: 0.5, expected: "background", why: "Freeze last does not show anything before Play" },
    { freeze: "first", time: 0.5, expected: "green", why: "Freeze first shows the offset frame before Play" },
    { freeze: "both", time: 2.9, expected: "blue", why: "Freeze both holds after Play" },
  ];
  const actual = [];
  for (const { freeze, time } of cases) actual.push(await stillColor(scene([gifLayer({ ...play, mediaFreeze: freeze })]), time, mediaRoot));
  assert.deepEqual(actual, cases.map(({ expected }) => expected), cases.map(({ freeze, time, why }) => `${freeze}@${time}s: ${why}`).join("; "));

  // A GIF without Play is a still image of its first frame at any time.
  assert.equal(await stillColor(scene([gifLayer()]), 1.25, mediaRoot), "red");
});

test("a PNG sequence of a GIF with Play shows the frame each export frame's time selects", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const sequenceDirectory = join(root, "sequence");
  await mkdir(sequenceDirectory);
  const document = scene([gifLayer({ mediaStart: 1, mediaDuration: 1, mediaOffset: 0.1, mediaFreeze: "last" })]);
  const result = await exportScene(document, { format: "png-sequence", fps: 20 }, { mediaRoot, sequenceDirectory });
  assert.equal(result.sequence.frameCount, 60);
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, 60);
  const order = ["red", "green", "blue", "yellow"];
  const actual = [];
  const expected = [];
  for (const [index, name] of names.entries()) {
    actual.push(colorName((await readImage(await readFile(join(sequenceDirectory, name)))).pixel(SIZE / 2, SIZE / 2)));
    // Worked out by hand: 20 frames per second, 1/10 s per GIF frame, Play from 1 s to 2 s starting 0.1 s in.
    const time = index / 20;
    if (time < 1) expected.push("background");
    else {
      const source = 0.1 + Math.min(time - 1, 0.998);
      expected.push(order[Math.floor(((source + 0.001) % 0.4) * 10 + 1e-9)]);
    }
  }
  assert.deepEqual(actual, expected);
});

test("video stills read the frame on screen at the source time, hold the last frame past the end, and respect the offset", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { mediaRoot } = await setup(t);
  // Four frames per second for 1 s: red 0-0.25 s, green 0.25-0.5 s, blue 0.5-0.75 s, yellow 0.75-1 s.
  for (const format of ["mp4", "webm"]) {
    await makeVideo(join(mediaRoot, `colors.${format}`), {
      width: SIZE, height: SIZE, fps: 4, frames: 4, format, frameColor: (n) => [RED, GREEN, BLUE, YELLOW][n],
    });
    const src = `/api/media/colors.${format}`;
    const cases = [
      { play: { mediaFreeze: "both" }, time: 0, expected: "red" },
      { play: { mediaFreeze: "both" }, time: 0.25, expected: "green", why: "a frame boundary shows the new frame" },
      { play: { mediaFreeze: "both" }, time: 0.3, expected: "green", why: "0.3 s is inside the 0.25 s frame, not the next one" },
      { play: { mediaFreeze: "both" }, time: 0.74, expected: "blue" },
      { play: { mediaFreeze: "both" }, time: 1.5, expected: "yellow", why: "past the end the last frame stays" },
      { play: { mediaFreeze: "none" }, time: 2.5, expected: "yellow", why: "open-ended Play holds the last frame" },
      { play: { mediaStart: 1, mediaOffset: 0.5, mediaFreeze: "both" }, time: 1.1, expected: "blue", why: "scene 1.1 s is source 0.6 s" },
      { play: { mediaStart: 1, mediaOffset: 0.5, mediaFreeze: "both" }, time: 0.2, expected: "blue", why: "Freeze first shows the offset frame" },
      { play: { mediaStart: 1, mediaOffset: 0.5, mediaFreeze: "none" }, time: 0.2, expected: "background", why: "no freeze hides it before Play" },
      { play: { mediaStart: 0, mediaDuration: 0.5, mediaFreeze: "last" }, time: 2, expected: "green", why: "a 0.5 s Play holds the frame before 0.5 s" },
    ];
    const actual = [];
    for (const { play, time } of cases) actual.push(await stillColor(scene([videoLayer(src, play)]), time, mediaRoot));
    assert.deepEqual(actual, cases.map(({ expected }) => expected),
      `${format}: ${cases.map(({ time, why }) => `${time}s ${why ?? ""}`).join("; ")}`);
  }
});

test("video exports show the source frame for every export frame, including held frames between grid samples", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // Frame N of this 30 fps video has gray level 4N.
  await makeVideo(join(mediaRoot, "gray.mp4"), {
    width: SIZE, height: SIZE, fps: 30, frames: 60, frameColor: (n) => [n * 4, n * 4, n * 4],
  });
  const sequenceDirectory = join(root, "gray-sequence");
  await mkdir(sequenceDirectory);
  // Play lasts 0.5 s and then holds; at 24 fps the held time (0.498 s) is not on the 1/24 s grid.
  const document = scene([videoLayer("/api/media/gray.mp4", { mediaDuration: 0.5, mediaFreeze: "last" })], 1);
  await exportScene(document, { format: "png-sequence", fps: 24 }, { mediaRoot, sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  const actual = [];
  for (const name of names)
    actual.push(Math.round((await readImage(await readFile(join(sequenceDirectory, name)))).pixel(SIZE / 2, SIZE / 2)[0] / 4));
  const expected = names.map((_, index) => {
    // Export frame times use a step rounded to 0.1 µs: frame 12 is at 0.5000004 s, just after Play.
    const time = (index * Math.round((1000 / 24) * 1e4) / 1e4) / 1000;
    const source = time <= 0.5 ? time : 0.498;
    return Math.min(59, Math.floor((source + 0.001) * 30));
  });
  assert.deepEqual(actual, expected, "each exported frame shows the video frame on screen at its source time");
  assert.equal(actual.at(-1), 14, "the held frame is 0.498 s (frame 14), not the 24 fps grid sample before it (frame 13)");
  t.diagnostic(`24 fps export of a 30 fps source: frames ${actual.join(",")}`);
});

test("Lottie embeds GIF and video stills where Play starts and hides a GIF outside Play", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { mediaRoot } = await setup(t);
  await makeVideo(join(mediaRoot, "colors.mp4"), {
    width: SIZE, height: SIZE, fps: 4, frames: 4, frameColor: (n) => [RED, GREEN, BLUE, YELLOW][n],
  });
  const gif = gifLayer({ mediaStart: 1, mediaDuration: 1, mediaOffset: 0.25, mediaFreeze: "none" });
  const video = { ...videoLayer("/api/media/colors.mp4", { mediaOffset: 0.3, mediaFreeze: "both" }), id: "lottie-video", name: "Video" };
  const result = await exportScene(scene([gif, video]), { format: "lottie", fps: 4, imageDPIRatio: "1x" }, { mediaRoot });
  assert.deepEqual(result.warnings.map(({ code }) => code), ["lottie-media-first-frame"], "the saved warning code is unchanged");
  assert.match(result.warnings[0].message, /the frame where its Play range starts/);
  const animation = JSON.parse(result.buffer.toString("utf8"));

  async function stillName(name) {
    const root = animation.layers.find((layer) => layer.nm === name);
    const composition = animation.assets.find((asset) => asset.id === root.refId);
    const image = composition.layers.find((layer) => layer.ty === 2);
    const bitmap = animation.assets.find((asset) => asset.id === image.refId);
    const bytes = Buffer.from(bitmap.p.replace(/^data:image\/[^;]+;base64,/, ""), "base64");
    const picture = await readImage(bytes);
    return { root, color: colorName(picture.pixel(Math.floor(picture.width / 2), Math.floor(picture.height / 2))) };
  }
  const gifStill = await stillName("GIF");
  assert.equal(gifStill.color, "blue", "the GIF still is the frame at its 0.25 s offset");
  assert.equal((await stillName("Video")).color, "green", "the video still is the frame at its 0.3 s offset");

  // Opacity keyframes: one per 1/4 s. Visible only from 1 s through 2 s.
  const opacity = gifStill.root.ks.o;
  assert.equal(opacity.a, 1, "the GIF's opacity is animated");
  const visibleAt = opacity.k.map((keyframe) => [keyframe.t / 4, keyframe.s[0] > 0]);
  for (const [time, visible] of visibleAt) assert.equal(visible, time >= 1 && time <= 2, `GIF visibility at ${time} s`);
  assert.ok(visibleAt.some(([time]) => time > 2), "frames after Play are included");
});

async function audioSamples(path) {
  const raw = await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

function loudness(samples, from, to) {
  let sum = 0;
  const first = Math.round(from * 48000);
  const last = Math.round(to * 48000);
  // Audio may end before the video does; missing samples are silence.
  for (let index = first; index < last; index += 1) sum += (samples[index] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, last - first));
}

test("exported audio starts at the Play start and reads the source from the offset", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // 0.5 s of silence, then 1 s of tone. Reading from 0.5 s starts directly on the tone.
  await makeToneAfterSilence(join(mediaRoot, "tone.wav"), { silence: 0.5, tone: 1 });
  const audio = createLayer("audio", { id: "audio", name: "Tone", src: "/api/media/tone.wav", mediaStart: 1, mediaOffset: 0.5, mediaDuration: 0.5 });
  const results = [];
  for (const format of ["mov", "mp4", "webm"]) {
    const outputPath = join(root, `audio.${format}`);
    // MP4 uses the software (libx264 + AAC) profile so the test never waits on a shared hardware encoder.
    const options = format === "mp4" ? { profile: "mp4.alt" } : { format };
    await exportScene(scene([audio], 2), { ...options, fps: 10 }, { mediaRoot, outputPath });
    const samples = await audioSamples(outputPath);
    // The windows stay 20-50 ms away from the edges, because compressed audio blurs them slightly.
    const levels = {
      beforeStart: loudness(samples, 0.05, 0.95),
      duringPlay: loudness(samples, 1.05, 1.45),
      afterPlay: loudness(samples, 1.55, 1.95),
    };
    results.push(`${format}: before ${levels.beforeStart.toFixed(4)}, during ${levels.duringPlay.toFixed(4)}, after ${levels.afterPlay.toFixed(4)}`);
    assert.ok(samples.length >= 1.48 * 48000, `${format} audio lasts through the end of Play`);
    assert.ok(levels.beforeStart < 0.01, `${format} is silent before Play starts at 1 s`);
    assert.ok(levels.duringPlay > 0.2, `${format} plays the tone from 1 s, so the source was read from its 0.5 s offset`);
    assert.ok(levels.afterPlay < 0.01, `${format} is silent after the 0.5 s Play duration`);
  }
  t.diagnostic(`RMS ${results.join("; ")}`);
});

test("reference case: a 60 fps MP4 of a 3 s scene shows a GIF playing from 0 to 2 s through frame 119 and hides it from frame 120", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const size = 64;
  const gif = createLayer("image", {
    id: "gif", name: "GIF", x: 0, y: 0, width: size, height: size, src: "/api/media/colors.gif",
    mediaStart: 0, mediaDuration: 2, mediaOffset: 0, mediaFreeze: "none",
  });
  const outputPath = join(root, "reference.mp4");
  // The software MP4 profile keeps the test independent of shared hardware encoders; frame choice is the same.
  await exportScene(scene([gif], 3, size), { profile: "mp4.alt", fps: 60 }, { mediaRoot, outputPath });
  const frames = await readVideoFrames(outputPath, { width: size, height: size });
  assert.equal(frames.length, 180);
  const named = frames.map((frame) => colorName(frame.pixel(size / 2, size / 2)));
  const order = ["red", "green", "blue", "yellow"];
  const expected = named.map((_, index) => {
    const time = (index * Math.round(1000 / 60 * 1e4) / 1e4) / 1000;
    if (time > 2) return "background";
    return order[Math.floor(((Math.min(time, 1.998) + 0.001) % 0.4) * 10 + 1e-9)];
  });
  assert.equal(named[119], "yellow", "frame 119 (1.983 s) shows the GIF");
  assert.equal(named[120], "background", "frame 120 (2.000004 s) is after Play, so the GIF is hidden");
  assert.deepEqual(named, expected, "every frame matches the GIF timeline");
  t.diagnostic(`frame 0 ${named[0]}, 6 ${named[6]}, 24 ${named[24]}, 119 ${named[119]}, 120 ${named[120]}, 179 ${named[179]}`);
});

test("Lottie starts and ends Play on the same frame as an MP4 of the same scene", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const size = 32;
  // Lottie opacity keyframes, one per export frame: true where the GIF is visible.
  async function lottieVisible(play, fps) {
    const result = await exportScene(scene([gifLayer({ ...play, mediaFreeze: "none" })], 2, size), { format: "lottie", fps }, { mediaRoot });
    const animation = JSON.parse(result.buffer.toString("utf8"));
    const opacity = animation.layers.find((layer) => layer.nm === "GIF").ks.o;
    return new Map(opacity.k.map((keyframe) => [keyframe.t, keyframe.s[0] > 0]));
  }

  // Play 0-1 s at 60 fps: frame 60 is sampled at 1.000002 s, just after Play, in every format.
  const outputPath = join(root, "play-end.mp4");
  await exportScene(scene([gifLayer({ mediaStart: 0, mediaDuration: 1, mediaFreeze: "none" })], 2, size),
    { profile: "mp4.alt", fps: 60 }, { mediaRoot, outputPath });
  const frames = await readVideoFrames(outputPath, { width: size, height: size });
  const mp4Visible = frames.map((frame) => colorName(frame.pixel(size / 2, size / 2)) !== "background");
  assert.deepEqual([mp4Visible[59], mp4Visible[60]], [true, false], "the MP4 hides the GIF from frame 60");
  const end = await lottieVisible({ mediaStart: 0, mediaDuration: 1 }, 60);
  assert.deepEqual([end.get(59), end.get(60)], [true, false], "Lottie hides the GIF from frame 60 too");

  // Play 1-2 s at 30 fps: frame 30 is sampled at 0.999999 s, which counts as the start of Play
  // (within MEDIA_SAMPLE_TOLERANCE), so a cut's first frame is not left empty.
  const start = await lottieVisible({ mediaStart: 1, mediaDuration: 1 }, 30);
  assert.deepEqual([start.get(29), start.get(30)], [false, true], "Lottie shows the GIF from frame 30, like the raster formats");
});
