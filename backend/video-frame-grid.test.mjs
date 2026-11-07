// Exports videos whose playing frames do not line up with one 1/fps grid (a component that starts
// between export frames, a boomerang's backward pass) and checks two things: every exported frame
// shows the exact source frame for its time, and FFmpeg runs once per grid, not once per frame.
// It also checks held frames (component holds, Freeze) and the warning when the frame runs hit their caps.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { createComponentInstance, expandComponents } from "../engine/linkedComponents.js";
import { exportFrameTimes } from "../engine/exportOptions.js";
import { exportScene, gridSamplesKept, renderSceneFrames, selectSamples } from "./export.mjs";
import { createCheckPictures } from "./check-pictures.mjs";
import { ffmpeg, makeVideo, readImage, readVideoFrames, skipWithoutMediaTools } from "./media.test.support.mjs";

const SIZE = 16;
const SOURCE_FPS = 60;
// Frame N of the test video is colored so N can be read back: red, green, and blue hold the
// three base-16 digits of N, in steps of 16 levels.
const frameColor = (n) => [n % 16, Math.floor(n / 16) % 16, Math.floor(n / 256)].map((digit) => digit * 16 + 8);
const frameNumber = (pixel) => pixel.slice(0, 3).reduce((sum, level, index) => sum + Math.round((level - 8) / 16) * 16 ** index, 0);
// The source frame on screen at a source time, with the 1 ms tolerance the exporter uses.
const sourceFrame = (time, sourceFps = SOURCE_FPS) => Math.floor((time + 0.001) * sourceFps);
// What the center pixel of an exported frame shows: a source frame number, or the white background.
const shownAt = (image) => {
  const pixel = image.pixel(SIZE / 2, SIZE / 2);
  return pixel.slice(0, 3).every((level) => level > 250) ? "background" : frameNumber(pixel);
};

// Points KINO_FFMPEG at a wrapper that logs each call, so the test can count frame extractions.
async function countFfmpegRuns(t, root) {
  const log = join(root, "ffmpeg.log");
  const wrapper = join(root, "ffmpeg-wrapper.sh");
  await writeFile(log, "");
  await writeFile(wrapper, `#!/bin/sh\necho "$@" >> '${log}'\nexec '${ffmpeg}' "$@"\n`);
  await chmod(wrapper, 0o755);
  const previous = process.env.KINO_FFMPEG;
  process.env.KINO_FFMPEG = wrapper;
  t.after(() => {
    if (previous === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = previous;
  });
  // Frame extractions use the tpad filter; the final encode does not.
  return async () => (await readFile(log, "utf8")).split("\n").filter((line) => line.includes("tpad=stop=-1")).length;
}

async function setup(t, seconds, sourceFps = SOURCE_FPS) {
  const root = await mkdtemp(join(tmpdir(), "kino-video-frame-grid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { mode: 0o700 });
  await makeVideo(join(mediaRoot, "numbered.mp4"), {
    width: SIZE, height: SIZE, fps: sourceFps, frames: sourceFps * seconds, frameColor,
  });
  return { root, mediaRoot, extractionRuns: await countFfmpegRuns(t, root) };
}

/** Exports a PNG sequence into a new folder and returns what each frame shows (see shownAt). */
async function exportSequence(root, scene, options, internal = {}) {
  const sequenceDirectory = join(root, `sequence-${Math.random().toString(36).slice(2)}`);
  await mkdir(sequenceDirectory);
  const result = await exportScene(scene, { format: "png-sequence", ...options }, { mediaRoot: join(root, "media"), sequenceDirectory, ...internal });
  const shown = [];
  for (const name of (await readdir(sequenceDirectory)).sort())
    shown.push(shownAt(await readImage(await readFile(join(sequenceDirectory, name)))));
  return { result, shown };
}

/** A scene with one instance of a component that plays the video from 0 to 2 s and holds outside that. */
function componentScene(componentStart, duration) {
  const source = createScene({
    id: "source", name: "Source", isComponent: true, width: SIZE, height: SIZE, duration: 5, background: "#ffffff",
    layers: [videoLayer({ mediaStart: 0, mediaDuration: 2 })],
  });
  const instance = createComponentInstance(source, { id: "instance", x: 0, y: 0, componentStart, componentVisibility: "both" });
  const target = createScene({ id: "target", name: "Target", width: SIZE, height: SIZE, duration, background: "#ffffff", layers: [instance] });
  return expandComponents(parseDocument(createDocument({ scenes: [source, target] })), "target");
}

function videoLayer(play) {
  return createLayer("video", {
    id: "video", name: "Video", x: 0, y: 0, width: SIZE, height: SIZE, src: "/api/media/numbered.mp4", mediaFreeze: "none", ...play,
  });
}

test("a component that starts between export frames shows the exact video frame and extracts one grid", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot, extractionRuns } = await setup(t, 3);
  // The video plays 2 s inside the component. The instance starts at 0.51 s, which is not on the
  // 30 fps export grid, and holds its first and last frames outside that window.
  const source = createScene({
    id: "source", name: "Source", isComponent: true, width: SIZE, height: SIZE, duration: 2, background: "#ffffff",
    layers: [videoLayer({ mediaStart: 0, mediaDuration: 2 })],
  });
  const instance = createComponentInstance(source, { id: "instance", x: 0, y: 0, componentStart: 0.51, componentVisibility: "both" });
  const target = createScene({ id: "target", name: "Target", width: SIZE, height: SIZE, duration: 3, background: "#ffffff", layers: [instance] });
  const scene = expandComponents(parseDocument(createDocument({ scenes: [source, target] })), "target");

  const sequenceDirectory = join(root, "sequence");
  await mkdir(sequenceDirectory);
  await exportScene(scene, { format: "png-sequence", fps: 30, duration: 3 }, { mediaRoot, sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  const actual = [];
  for (const name of names) actual.push(frameNumber((await readImage(await readFile(join(sequenceDirectory, name)))).pixel(SIZE / 2, SIZE / 2)));
  const expected = exportFrameTimes(3, 30, { format: "png-sequence" }).map((time) => {
    // Worked out by hand: before 0.51 s the instance holds source 0 s; after 2.51 s it holds the
    // last Play frame, sampled 2 ms before the 2 s end.
    const local = Math.max(0, Math.min(time - 0.51, 2));
    return sourceFrame(Math.min(local, 1.998));
  });
  assert.deepEqual(actual, expected, "every frame shows the source frame for its time");
  // One grid for the playing frames, plus one extraction each for the two held frames.
  assert.equal(await extractionRuns(), 3);
  t.diagnostic(`frames ${actual.join(",")}`);
});

test("a boomerang whose backward pass is off the forward grid extracts one more grid, not one run per frame", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot, extractionRuns } = await setup(t, 6);
  // 2 × 5.01 s × 30 fps is not a whole number, so the backward times fall between forward grid samples.
  const duration = 5.01;
  const document = createScene({
    id: "boomerang", name: "Boomerang", width: SIZE, height: SIZE, duration, background: "#ffffff",
    layers: [videoLayer({ mediaStart: 0, mediaDuration: 10 })],
  });
  const outputPath = join(root, "boomerang.apng");
  const result = await exportScene(document, { format: "apng", fps: 30, playbackDirection: "boomerang", duration }, { mediaRoot, outputPath });
  const frames = await readVideoFrames(outputPath, { width: SIZE, height: SIZE });
  const times = exportFrameTimes(duration, 30, { format: "apng", playbackDirection: "boomerang" });
  assert.equal(frames.length, times.length);
  const actual = frames.map((frame) => frameNumber(frame.pixel(SIZE / 2, SIZE / 2)));
  assert.deepEqual(actual, times.map((time) => sourceFrame(time)), "forward and backward frames both show the source frame for their time");
  assert.equal(await extractionRuns(), 2, "one grid for each direction");
  assert.equal(result.warnings, undefined, "the default caps are enough for this export");
});

test("a component that starts less than 1 ms after an export frame holds that frame, and playing frames stay on their own grid", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  // 25 fps source, 48 fps export, component start 0.23 s. Export frame 11 (0.22917 s) is 0.83 ms
  // before the start, so the component holds source 0 s there. Treating that tiny hold as playing
  // anchored the grid 0.83 ms early and showed the wrong source frame at export frames 34 and 82.
  const { root, extractionRuns } = await setup(t, 4, 25);
  const { result, shown } = await exportSequence(root, componentScene(0.23, 4), { fps: 48, duration: 4 });
  const expected = exportFrameTimes(4, 48, { format: "png-sequence" }).map((time) => {
    // As in the first test: the instance holds source 0 s before it starts, and the last Play
    // frame (2 ms before the 2 s end) after it ends.
    const local = Math.max(0, Math.min(time - 0.23, 2));
    return sourceFrame(Math.min(local, 1.998), 25);
  });
  assert.deepEqual(shown, expected, "every frame shows the source frame for its time");
  assert.equal(await extractionRuns(), 3, "one grid for the playing frames, plus one extraction each for the two held frames");
  assert.equal(result.warnings, undefined);
});

test("a Freeze hold less than 1 ms before a grid sample shows its own frame, not the grid sample", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  // Play starts at 0.4995 s, 0.5 ms before export frame 15, and reads the video from 0.0155 s.
  // Before Play, Freeze holds source 0.0155 s (frame 0). The first playing frame samples 0.016 s, and
  // with the 1 ms tolerance it is frame 1, so reusing that grid picture for the hold was wrong.
  const { root, extractionRuns } = await setup(t, 2);
  const scene = createScene({
    id: "freeze", name: "Freeze", width: SIZE, height: SIZE, duration: 1, background: "#ffffff",
    layers: [videoLayer({ mediaStart: 0.4995, mediaDuration: 0.4, mediaOffset: 0.0155, mediaFreeze: "both" })],
  });
  const { shown } = await exportSequence(root, scene, { fps: 30, duration: 1 });
  const expected = exportFrameTimes(1, 30, { format: "png-sequence" }).map((time) => {
    if (time < 0.4995) return sourceFrame(0.0155);
    // After Play the last frame is held, sampled 2 ms before the Play end.
    if (time >= 0.8995) return sourceFrame(0.0155 + 0.4 - 0.002);
    return sourceFrame(0.0155 + time - 0.4995);
  });
  assert.deepEqual(shown, expected);
  assert.equal(expected[0], 0, "the held first frame is source frame 0");
  assert.equal(await extractionRuns(), 3, "one grid, plus one extraction for each held frame");
});

test("exports written to a file or a folder report when the frame extraction caps were reached", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t, 6);
  // Caps of zero: the boomerang's backward pass gets no grid of its own, and held frames between
  // grid samples get no extraction of their own.
  const videoLimits = { maxPhaseGrids: 0, maxExtraSamples: 0 };
  const approximated = [{
    code: "video-frames-approximated",
    message: "A video needs too many separate frame extractions. Some exported frames show the closest earlier video frame instead.",
  }];
  const boomerang = createScene({
    id: "boomerang", name: "Boomerang", width: SIZE, height: SIZE, duration: 2.01, background: "#ffffff",
    layers: [videoLayer({ mediaStart: 0, mediaDuration: 10 })],
  });
  const options = { format: "apng", fps: 30, playbackDirection: "boomerang", duration: 2.01 };
  const inMemory = await exportScene(boomerang, options, { mediaRoot, videoLimits });
  assert.deepEqual(inMemory.warnings, approximated, "an export returned in memory reports it");
  const outputPath = join(root, "boomerang.apng");
  const onDisk = await exportScene(boomerang, options, { mediaRoot, outputPath, videoLimits });
  assert.equal(onDisk.path, outputPath);
  assert.deepEqual(onDisk.warnings, approximated, "an export written to a file reports it");

  // Batch exports (export-batches.mjs) pass both a result path and a frame folder for PNG sequences.
  const { result: sequence } = await exportSequence(root, componentScene(0.51, 3), { fps: 30, duration: 3 },
    { videoLimits, outputPath: join(root, "sequence-result") });
  assert.equal(sequence.sequence.frameCount, 90);
  assert.deepEqual(sequence.warnings, approximated, "a PNG sequence written to a folder reports it");
});

test("a morph cut between two speech pieces of one shot slides the picture across; between two shots it stays a cut", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t, 2);
  // A white 16 px square on gray that moves 0.5 px a frame (30 fps): file 0.467 s has it at x 11, file 1 s at x 19.
  const [W, H] = [64, 48];
  const framePixels = (n) => {
    const rgb = Buffer.alloc(W * H * 3, 90);
    for (let y = 16; y < 32; y += 1) for (let x = Math.round(4 + n / 2); x < Math.round(4 + n / 2) + 16; x += 1) rgb.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3);
    return rgb;
  };
  await makeVideo(join(mediaRoot, "talk.mp4"), { width: W, height: H, fps: 30, frames: 60, framePixels });
  const pieces = (src, offset = 1) => createScene({ id: "s", name: "S", width: W, height: H, duration: 1, background: "#000000", layers: [
    createLayer("video", { id: "a", name: "talk", x: 0, y: 0, width: W, height: H, src, mediaStart: 0, mediaOffset: 0, mediaDuration: 0.5, mediaFreeze: "none" }),
    createLayer("video", { id: "b", name: "talk-2", x: 0, y: 0, width: W, height: H, src, mediaStart: 0.5, mediaOffset: offset, mediaDuration: 0.5, mediaFreeze: "none", morphIn: 0.2 }),
  ] });
  const directory = join(root, "morph");
  await mkdir(directory);
  await exportScene(pieces("/api/media/talk.mp4"), { format: "png-sequence", fps: 30 }, { mediaRoot, sequenceDirectory: directory });
  const names = (await readdir(directory)).sort();
  const leftEdge = async (index) => {
    const image = await readImage(await readFile(join(directory, names[index])));
    for (let x = 0; x < W; x += 1) if (image.pixel(x, 24)[0] > 170) return x;
    return -1;
  };
  // Frame 15 (0.5 s) is the middle of the 0.4 to 0.6 s morph: one square about halfway, solid.
  assert.equal(await leftEdge(11), 10, "before the morph: piece one plays");
  const middle = await leftEdge(15);
  assert.ok(middle >= 13 && middle <= 17, `halfway at 0.5 s: ${middle}`);
  assert.ok((await readImage(await readFile(join(directory, names[15])))).pixel(middle + 8, 24)[0] > 230, "one solid square, not two faded ones");
  assert.equal(await leftEdge(19), 21, "after the morph: piece two plays");
  // Check (and look) skip the flow: the middle of the morph is the live preview's dissolve, the
  // last square of piece one and the first of piece two each half faded in.
  const [checked] = await renderSceneFrames(pieces("/api/media/talk.mp4"), [0.5], { mediaRoot, width: W });
  const red = (x) => checked.pixels[(24 * W + x) * 4];
  assert.ok(red(13) > 140 && red(13) < 210 && red(33) > 140 && red(33) < 210, `two half-faded squares: ${red(13)}, ${red(33)}`);
  // The numbered video is a flat color that changes every frame: far apart, two shots, so a plain cut.
  const { result } = await exportSequence(root, pieces("/api/media/numbered.mp4", 1.5), { fps: 30 });
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["morph-cut-skipped"]);
});

test("a dozen frames spread over a ten-minute video extract a dozen pictures, not the whole video", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  // A look sheet or a check asks for a few frames of a long scene. One grid from the first to the
  // last would write a picture every 1/30 s of the ten minutes (17,971 of them) to use 12.
  const { mediaRoot, extractionRuns } = await setup(t, 600, 4);
  const scene = createScene({
    id: "long", name: "Long", width: SIZE, height: SIZE, duration: 600, background: "#ffffff",
    layers: [videoLayer({ mediaStart: 0, mediaDuration: 0, mediaSourceDuration: 600 })],
  });
  const times = Array.from({ length: 12 }, (_, index) => Math.round((index * 599 / 11) * 1000) / 1000);
  const started = performance.now();
  const frames = await renderSceneFrames(scene, times, { mediaRoot, width: SIZE });
  const seconds = (performance.now() - started) / 1000;
  const center = (SIZE / 2 * SIZE + SIZE / 2) * 4;
  const shown = frames.map((frame) => frameNumber([...frame.pixels.subarray(center, center + 3)]));
  assert.deepEqual(shown, times.map((time) => sourceFrame(time, 4)), "each frame shows the source frame for its time");
  assert.equal(await extractionRuns(), 12, "one short run for each frame far from the others");
  t.diagnostic(`12 frames of a 600 s video in ${seconds.toFixed(2)} s`);
});

test("a check render keeps the video pictures it drew, so checking the same timing again runs no FFmpeg", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { mediaRoot, extractionRuns } = await setup(t, 6);
  const scene = createScene({ id: "check", name: "Check", width: SIZE, height: SIZE, duration: 6, background: "#ffffff", layers: [videoLayer({ mediaStart: 0 })] });
  const times = [0.5, 1.7, 2.9, 4.1];
  const center = (SIZE / 2 * SIZE + SIZE / 2) * 4;
  const shown = (frames) => frames.map((frame) => frameNumber([...frame.pixels.subarray(center, center + 3)]));
  const checkCache = createCheckPictures();
  const first = await renderSceneFrames(scene, times, { mediaRoot, width: SIZE, checkCache });
  assert.deepEqual(shown(first), times.map((time) => sourceFrame(time)), "each frame shows the source frame for its time");
  assert.equal(await extractionRuns(), 1);
  const again = await renderSceneFrames(scene, times, { mediaRoot, width: SIZE, checkCache });
  assert.equal(await extractionRuns(), 1, "the second check reads the kept pictures");
  assert.deepEqual(again.map((frame) => [...frame.pixels]), first.map((frame) => [...frame.pixels]));
});

test("a sparse grid keeps only the samples its times show, and the stream ends after the last", () => {
  const kept = gridSamplesKept([86, 86.5, 87, 88, 88.0333], 86, 30, 135);
  assert.deepEqual(kept, [0, 15, 30, 60, 61, 134]);
  assert.equal(selectSamples(kept), "trim=end_frame=135,select=eq(n\\,0)+eq(n\\,15)+eq(n\\,30)+between(n\\,60\\,61)+eq(n\\,134)");
  assert.equal(gridSamplesKept(Array.from({ length: 135 }, (_, index) => 86 + index / 30), 86, 30, 135), null);
});
