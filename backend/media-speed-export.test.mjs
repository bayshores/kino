// Exports clips with a speed, played backwards, with a choppy frame rate, or blended
// (engine/mediaTime.js, backend/media-remap.mjs), on generated footage whose every frame has its own
// grey level, and checks which file frame each exported frame shows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { makeAnimatedGif, makeVideo, readImage, skipWithoutMediaTools } from "./media.test.support.mjs";

const SIZE = 32;
// Frame N of the test video has grey level STEP × N, 30 frames a second for 2 s.
const STEP = 4;
const FILE_FPS = 30;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-media-speed-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeVideo(join(mediaRoot, "grey.mp4"), { width: SIZE, height: SIZE, fps: FILE_FPS, frames: 60, frameColor: (n) => [n * STEP, n * STEP, n * STEP] });
  return { root, mediaRoot };
}

function clipScene(play, duration = 1) {
  const video = createLayer("video", { id: "clip", name: "Clip", x: 0, y: 0, width: SIZE, height: SIZE, src: "/api/media/grey.mp4", ...play });
  return createScene({ id: "speed", name: "Speed", width: SIZE, height: SIZE, duration, background: "#ffffff", layers: [video] });
}

// The grey level in the middle of every exported frame, in file-frame units (level ÷ STEP).
async function exportedLevels(root, mediaRoot, scene, fps = 30) {
  const sequenceDirectory = join(root, `sequence-${Math.random().toString(36).slice(2)}`);
  await mkdir(sequenceDirectory);
  await exportScene(scene, { format: "png-sequence", fps }, { mediaRoot, sequenceDirectory });
  const levels = [];
  for (const name of (await readdir(sequenceDirectory)).sort())
    levels.push((await readImage(await readFile(join(sequenceDirectory, name)))).pixel(SIZE / 2, SIZE / 2)[0] / STEP);
  return levels;
}

// The export's frame times (the step is rounded to 0.1 µs, as exportFrameTimes does).
const frameTime = (index, fps = 30) => (index * Math.round((1000 / fps) * 1e4) / 1e4) / 1000;
// The file frame on screen at a source time (1 ms of tolerance, as in Play).
const fileFrame = (source) => Math.min(59, Math.floor((source + 0.001) * FILE_FPS));

test("a constant speed shows the file frame at offset + speed × time, faster and slower", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const slow = await exportedLevels(root, mediaRoot, clipScene({ mediaSpeed: 0.5, mediaDuration: 1, mediaFreeze: "last" }));
  assert.deepEqual(slow.map(Math.round), slow.map((_, index) => fileFrame(Math.min(frameTime(index), 1) * 0.5 - (frameTime(index) >= 1 ? 0.002 : 0))),
    "0.5×: each file frame shows for two export frames");
  assert.deepEqual(slow.slice(0, 8).map(Math.round), [0, 0, 1, 1, 2, 2, 3, 3]);
  const fast = await exportedLevels(root, mediaRoot, clipScene({ mediaSpeed: 2, mediaOffset: 0.1, mediaDuration: 0.9, mediaFreeze: "last" }));
  assert.deepEqual(fast.slice(0, 6).map(Math.round), [3, 5, 7, 9, 11, 13], "2× from 0.1 s: every other file frame");
  assert.equal(Math.round(fast.at(-1)), fileFrame(0.1 + 1.8 - 0.002), "after Play it holds the last frame played");
});

test("mediaReverse plays the same stretch from its end back to its start", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const levels = (await exportedLevels(root, mediaRoot, clipScene({ mediaReverse: true, mediaDuration: 1, mediaOffset: 0.5 }))).map(Math.round);
  const expected = levels.map((_, index) => fileFrame(0.5 + Math.min(1 - Math.min(frameTime(index), 1), 0.998)));
  assert.deepEqual(levels, expected);
  assert.equal(levels[0], 44, "it starts on the last frame of the stretch (file 1.498 s)");
  assert.equal(levels[15], 30, "halfway it shows file 1 s");
  assert.ok(levels.every((level, index) => index === 0 || level <= levels[index - 1]), "it only goes backwards");
});

test("mediaFrameRate holds each picture for a whole step: 10 a second shows every third file frame", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const levels = (await exportedLevels(root, mediaRoot, clipScene({ mediaFrameRate: 10, mediaDuration: 1 }))).map(Math.round);
  assert.deepEqual(levels.slice(0, 10), [0, 0, 0, 3, 3, 3, 6, 6, 6, 9]);
});

test("blend mixes the two file frames around each time: at 0.25× a quarter, a half and three quarters of the next", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // File frames alternate black and light grey (240), so a mix shows plainly in the grey level.
  await makeVideo(join(mediaRoot, "alternate.mp4"), { width: SIZE, height: SIZE, fps: FILE_FPS, frames: 30, frameColor: (n) => (n % 2 ? [240, 240, 240] : [0, 0, 0]) });
  const scene = clipScene({ src: "/api/media/alternate.mp4", mediaSpeed: 0.25, mediaDuration: 1, mediaInterpolation: "blend" });
  const levels = (await exportedLevels(root, mediaRoot, scene)).map((level) => level * STEP);
  // At export frame k the source is k / 120 s: k / 4 of the way through the file frames.
  const expected = levels.slice(0, 16).map((_, index) => {
    const [frame, part] = [Math.floor(index / 4), (index % 4) / 4];
    return frame % 2 ? 240 * (1 - part) : 240 * part;
  });
  levels.slice(0, 16).forEach((level, index) => assert.ok(Math.abs(level - expected[index]) <= 3, `frame ${index}: grey ${level}, expected ${expected[index]}`));
  assert.ok(Math.abs(levels[2] - 120) <= 3, "halfway between a black and a grey file frame: a 50/50 mix");
  t.diagnostic(`blend grey levels: ${levels.slice(0, 16).join(", ")}`);
  const nearest = (await exportedLevels(root, mediaRoot, clipScene({ mediaSpeed: 0.25, mediaDuration: 1 }))).slice(0, 8).map(Math.round);
  assert.deepEqual(nearest, [0, 0, 0, 0, 1, 1, 1, 1], "nearest (the default) holds each file frame instead");
});

test("a Speed animation ramps the clip: 1× then slowing to 0.25×, with the same frames every export", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const ramp = { id: "clip.speed", kind: "custom", name: "Speed", start: 0.2, duration: 0.4, easing: "linear", from: { speed: 1 }, to: { speed: 0.25 } };
  const scene = clipScene({ mediaDuration: 1, animations: [ramp] });
  const levels = (await exportedLevels(root, mediaRoot, scene)).map(Math.round);
  // Worked out by hand: 1× until 0.2 s, then speed 1 − 1.875 (t − 0.2) until 0.6 s, then 0.25×.
  const source = (time) => {
    if (time <= 0.2) return time;
    const ramped = Math.min(time, 0.6) - 0.2;
    const along = 0.2 + ramped - 0.9375 * ramped * ramped;
    return time <= 0.6 ? along : along + 0.25 * (time - 0.6);
  };
  assert.deepEqual(levels, levels.map((_, index) => fileFrame(Math.min(source(Math.min(frameTime(index), 1)), source(1) - 0.002))));
  t.diagnostic(`ramp frames: ${levels.join(",")}`);
  assert.deepEqual(await exportedLevels(root, mediaRoot, scene).then((again) => again.map(Math.round)), levels, "the same frames again");
});

test("a final render's motion blur keeps one footage frame per output frame, and still blurs movement", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // Video frames alternate black and light grey (240): a mix of two of them shows as mid grey.
  await makeVideo(join(mediaRoot, "alternate.mp4"), { width: SIZE, height: SIZE, fps: FILE_FPS, frames: 60, frameColor: (n) => (n % 2 ? [240, 240, 240] : [0, 0, 0]) });
  const shade = (frame) => (frame % 2 ? 240 : 0);
  // GIF frame N is grey 20 N, a tenth of a second each.
  await writeFile(join(mediaRoot, "count.gif"), makeAnimatedGif({
    width: SIZE, height: SIZE, frames: Array.from({ length: 10 }, (_, n) => ({ color: [20 * n, 20 * n, 20 * n], delayCs: 10 })),
  }));
  const at = (x, play) => ({ x, y: 0, width: SIZE, height: SIZE, ...play });
  const scene = createScene({ id: "blur", name: "Blur", width: SIZE * 5, height: SIZE, duration: 1, background: "#000000", layers: [
    createLayer("video", { id: "plain", name: "Plain", src: "/api/media/alternate.mp4", ...at(0) }),
    createLayer("video", { id: "half", name: "Half speed", src: "/api/media/alternate.mp4", ...at(SIZE, { mediaSpeed: 0.5, mediaDuration: 1 }) }),
    createLayer("image", { id: "gif", name: "Count", src: "/api/media/count.gif", ...at(SIZE * 2, { mediaDuration: 1 }) }),
    // A white bar that crosses 56 pixels in a tenth of a second.
    createLayer("rectangle", { id: "bar", name: "Bar", x: SIZE * 3, y: 0, width: 8, height: SIZE, fill: "#ffffff",
      animations: [{ id: "bar.move", name: "Move", kind: "custom", start: 0.4, duration: 0.1, easing: "linear", from: { x: SIZE * 3 }, to: { x: SIZE * 3 + 56 } }] }),
  ] });
  // A final render's quality settings (export-batches.mjs): motion blur 0.5 and dither, with the
  // default two shutter samples and with eight (motionSamples).
  for (const motionSamples of [2, 8]) {
    const sequenceDirectory = join(root, `final-${motionSamples}`);
    await mkdir(sequenceDirectory);
    await exportScene(scene, { format: "png-sequence", fps: 30, motionBlur: 0.5, motionSamples, dither: true }, { mediaRoot, sequenceDirectory });
    const pictures = [];
    for (const name of (await readdir(sequenceDirectory)).sort()) pictures.push(await readImage(await readFile(join(sequenceDirectory, name))));
    assert.equal(pictures.length, 30);
    const grey = (picture, x) => picture.pixel(x, SIZE / 2)[0];
    pictures.forEach((picture, index) => {
      const time = frameTime(index);
      // A mix of two file frames (the old ghost) would show grey 120 or half a GIF step.
      assert.ok(Math.abs(grey(picture, SIZE / 2) - shade(fileFrame(time))) <= 6, `${motionSamples} samples, frame ${index}: video grey ${grey(picture, SIZE / 2)}, expected ${shade(fileFrame(time))}`);
      assert.ok(Math.abs(grey(picture, SIZE * 1.5) - shade(fileFrame(time * 0.5))) <= 6, `${motionSamples} samples, frame ${index}: the 0.5× video grey ${grey(picture, SIZE * 1.5)}, expected ${shade(fileFrame(time * 0.5))}`);
      const gifFrame = Math.min(9, Math.floor((time + 0.001) / 0.1));
      assert.ok(Math.abs(grey(picture, SIZE * 2.5) - 20 * gifFrame) <= 2, `${motionSamples} samples, frame ${index}: GIF grey ${grey(picture, SIZE * 2.5)}, expected ${20 * gifFrame}`);
    });
    // While the bar moves (frame 13, 0.433 s) its edges are smeared: grey between black and white.
    const smeared = Array.from({ length: SIZE * 2 }, (_, x) => grey(pictures[13], SIZE * 3 + x)).filter((value) => value > 30 && value < 225);
    assert.ok(smeared.length >= 4, `motion blur still smears the moving bar (${motionSamples} samples: ${smeared.length} grey pixels)`);
  }
});

test("a final render shows a blend or flow clip's picture of the frame's own time, as a render without motion blur does", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // Video frames alternate black and light grey (240): a mix of neighbouring file frames shows
  // as a grey between them.
  await makeVideo(join(mediaRoot, "alternate.mp4"), { width: SIZE, height: SIZE, fps: FILE_FPS, frames: 60, frameColor: (n) => (n % 2 ? [240, 240, 240] : [0, 0, 0]) });
  const clip = (id, x, play) => createLayer("video", { id, name: id, src: "/api/media/alternate.mp4", x, y: 0, width: SIZE, height: SIZE, mediaDuration: 1, ...play });
  const scene = createScene({ id: "blended", name: "Blended", width: SIZE * 5, height: SIZE, duration: 1, background: "#000000", layers: [
    clip("blend", 0, { mediaInterpolation: "blend" }),
    clip("slowBlend", SIZE, { mediaInterpolation: "blend", mediaSpeed: 0.5 }),
    clip("fastBlend", SIZE * 2, { mediaInterpolation: "blend", mediaSpeed: 1.5 }),
    clip("flow", SIZE * 3, { mediaInterpolation: "flow" }),
    // A white bar that crosses 24 pixels in a tenth of a second.
    createLayer("rectangle", { id: "bar", name: "Bar", x: SIZE * 4, y: 0, width: 4, height: SIZE, fill: "#ffffff",
      animations: [{ id: "bar.move", name: "Move", kind: "custom", start: 0.4, duration: 0.1, easing: "linear", from: { x: SIZE * 4 }, to: { x: SIZE * 4 + 24 } }] }),
  ] });
  const render = async (name, quality) => {
    const sequenceDirectory = join(root, name);
    await mkdir(sequenceDirectory);
    // flowCacheDir keeps the flow layer's in-between frames in the test's folder.
    await exportScene(scene, { format: "png-sequence", fps: 30, ...quality }, { mediaRoot, sequenceDirectory, flowCacheDir: join(root, "flow") });
    const pictures = [];
    for (const file of (await readdir(sequenceDirectory)).sort()) pictures.push(await readImage(await readFile(join(sequenceDirectory, file))));
    return pictures;
  };
  // The picture of each frame's own time (what the draft and look show), and a final render's
  // motion blur 0.5 with dither.
  const sharp = await render("sharp", { motionBlur: 0, dither: false });
  const final = await render("final", { motionBlur: 0.5, dither: true });
  assert.equal(final.length, 30);
  const grey = (picture, x) => picture.pixel(x, SIZE / 2)[0];
  ["blend", "slowBlend", "fastBlend", "flow"].forEach((name, column) => {
    const x = SIZE * column + SIZE / 2;
    const different = final.map((picture, index) => `${index}: ${grey(picture, x)} (frame time ${grey(sharp[index], x)})`)
      .filter((_, index) => Math.abs(grey(final[index], x) - grey(sharp[index], x)) > 2);
    assert.deepEqual(different, [], `${name}: final frames whose clip picture is not the frame time's`);
  });
  // The 1× blend shows each file frame on its own: black or grey 240, never a mix.
  final.forEach((picture, index) => assert.ok(Math.abs(grey(picture, SIZE / 2) - (fileFrame(frameTime(index)) % 2 ? 240 : 0)) <= 2, `frame ${index}: 1× blend grey ${grey(picture, SIZE / 2)}`));
  // While the bar moves (frame 13, 0.433 s) its edges are smeared: grey between black and white.
  const smeared = Array.from({ length: SIZE }, (_, x) => grey(final[13], SIZE * 4 + x)).filter((value) => value > 30 && value < 225);
  assert.ok(smeared.length >= 2, `motion blur still smears the moving bar (${smeared.length} grey pixels)`);
});
