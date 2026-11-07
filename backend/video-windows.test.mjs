// A long export extracts its video pictures a window of output frames at a time and deletes each
// window when its frames are drawn (backend/video-windows.mjs, export.mjs videoPictureWindows), so
// its temporary folder holds two windows of pictures, not the whole video. Before, every picture
// of every video layer was written first: five minutes of full-frame 1080p filled gigabytes.
// The export tests draw ten seconds of numbered footage in windows of 20 frames (the real windows
// are 180 frames; `videoLimits.windowFrames` lowers it) and check that every frame shows the file
// frame for its time, the same pictures as an export extracted at once, and that the temporary
// folder never holds more than two windows.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportFrameTimes } from "../engine/exportOptions.js";
import { exportScene, orderedFrames } from "./export.mjs";
import { videoWindows } from "./video-windows.mjs";
import { makeVideo, readImage, skipWithoutMediaTools } from "./media.test.support.mjs";

const SIZE = 16;
const FPS = 30;
const SECONDS = 10;
const WINDOW = 20;
// Frame N of the test video shows N in three base-16 digits (red, green, blue), as in
// video-frame-grid.test.mjs.
const frameColor = (n) => [n % 16, Math.floor(n / 16) % 16, Math.floor(n / 256)].map((digit) => digit * 16 + 8);
const frameNumber = (pixel) => pixel.slice(0, 3).reduce((sum, level, index) => sum + Math.round((level - 8) / 16) * 16 ** index, 0);
// The file frame on screen at a source time (1 ms of tolerance, as in Play).
const fileFrame = (time) => Math.floor((time + 0.001) * FPS);

// The PNG files and window folders in `folder` and below. Files come and go while FFmpeg writes
// and windows are deleted, so a folder that is gone by the time it is read counts as empty.
function picturesOnDisk(folder) {
  let pictures = 0, windows = 0;
  let entries = [];
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return { pictures, windows }; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (/^video-window-\d+$/.test(entry.name)) windows += 1;
      const inside = picturesOnDisk(join(folder, entry.name));
      pictures += inside.pictures;
      windows += inside.windows;
    } else if (entry.name.endsWith(".png")) pictures += 1;
  }
  return { pictures, windows };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-video-windows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { mode: 0o700 });
  await makeVideo(join(mediaRoot, "numbered.mp4"), { width: SIZE, height: SIZE, fps: FPS, frames: FPS * (SECONDS + 2), frameColor });
  // The export makes its temporary folder in os.tmpdir(), which reads TMPDIR each time: pointing it
  // at a folder of the test's own lets the test watch what the export keeps on disk.
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  return { root, mediaRoot, temporary };
}

// Video layers side by side: playing at 1×, at 0.5×, and at 0.5× blended between file frames;
// with `flow`, a fourth at 0.5× drawn from FFmpeg's motion-interpolated frames (twice the size:
// FFmpeg's minterpolate needs 32 pixels).
function footageScene({ flow = false } = {}) {
  const video = (id, x, play, size = SIZE) => createLayer("video", { id, name: id, x, y: 0, width: size, height: size, src: "/api/media/numbered.mp4", mediaFreeze: "none", ...play });
  return createScene({ id: "long", name: "Long", width: SIZE * (flow ? 5 : 3), height: SIZE * (flow ? 2 : 1), duration: SECONDS, background: "#ffffff", layers: [
    video("plain", 0, { mediaDuration: SECONDS }),
    video("half", SIZE, { mediaSpeed: 0.5, mediaDuration: SECONDS }),
    video("blend", SIZE * 2, { mediaSpeed: 0.5, mediaDuration: SECONDS, mediaInterpolation: "blend" }),
    ...(flow ? [video("flow", SIZE * 3, { mediaSpeed: 0.5, mediaDuration: SECONDS, mediaInterpolation: "flow" }, SIZE * 2)] : []),
  ] });
}

/** Exports a PNG sequence and returns its frames' bytes and the most the temporary folder held. */
async function exportFrames(root, mediaRoot, temporary, options, windowFrames, scene = footageScene()) {
  const sequenceDirectory = join(root, `sequence-${Math.random().toString(36).slice(2)}`);
  await mkdir(sequenceDirectory);
  const peak = { pictures: 0, windows: 0 };
  // flowCacheDir keeps a flow layer's in-between frames in the test's folder, not the data folder.
  await exportScene(scene, { format: "png-sequence", fps: FPS, ...options }, {
    mediaRoot, sequenceDirectory, flowCacheDir: join(root, "flow"), videoLimits: { windowFrames },
    onProgress: () => {
      const now = picturesOnDisk(temporary);
      peak.pictures = Math.max(peak.pictures, now.pictures);
      peak.windows = Math.max(peak.windows, now.windows);
    },
  });
  const frames = [];
  for (const name of (await readdir(sequenceDirectory)).sort()) frames.push(await readFile(join(sequenceDirectory, name)));
  return { frames, peak };
}

test("a long export keeps at most two windows of video pictures on disk, and each frame shows the file frame for its time", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot, temporary } = await setup(t);
  const { frames, peak } = await exportFrames(root, mediaRoot, temporary, {}, WINDOW);
  const times = exportFrameTimes(SECONDS, FPS, { format: "png-sequence" });
  assert.equal(frames.length, times.length);
  for (const [index, bytes] of frames.entries()) {
    const image = await readImage(bytes);
    assert.equal(frameNumber(image.pixel(SIZE / 2, SIZE / 2)), fileFrame(times[index]), `frame ${index}: the 1× layer`);
    assert.equal(frameNumber(image.pixel(SIZE * 1.5, SIZE / 2)), fileFrame(times[index] * 0.5), `frame ${index}: the 0.5× layer`);
  }
  // A window of 20 frames holds 20 or 21 pictures of the 1× layer, 10 or 11 file frames of each
  // 0.5× layer, and up to 10 blends: at most 63. All at once it was 300 + 150 + 300 = 750.
  assert.ok(peak.windows <= 2, `at most two windows on disk (${peak.windows})`);
  assert.ok(peak.pictures <= 2 * 63, `at most two windows of pictures on disk (${peak.pictures})`);
  assert.deepEqual(await readdir(temporary), [], "nothing is left in the temporary folder");
  t.diagnostic(`most pictures on disk at once: ${peak.pictures} in ${peak.windows} windows`);
});

test("windows draw the same frames as extracting every picture at once, with a final render's motion blur and a flow layer too", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot, temporary } = await setup(t);
  const scene = footageScene({ flow: true });
  for (const options of [{}, { motionBlur: 0.5, dither: true }]) {
    const windowed = await exportFrames(root, mediaRoot, temporary, options, WINDOW, scene);
    // 300 frames are not more than two windows of 1000, so this export extracts everything first.
    const atOnce = await exportFrames(root, mediaRoot, temporary, options, 1000, scene);
    assert.ok(atOnce.peak.pictures > 900, `the export at once had every picture on disk (${atOnce.peak.pictures})`);
    assert.equal(windowed.frames.length, atOnce.frames.length);
    const different = windowed.frames.map((bytes, index) => (bytes.equals(atOnce.frames[index]) ? -1 : index)).filter((index) => index >= 0);
    assert.deepEqual(different, [], `${options.motionBlur ? "motion blur: " : ""}frames that differ`);
  }
});

test("cancelling a windowed export stops FFmpeg and leaves no pictures behind", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot, temporary } = await setup(t);
  const controller = new AbortController();
  const sequenceDirectory = join(root, "cancelled");
  await mkdir(sequenceDirectory);
  let drawn = 0;
  await assert.rejects(exportScene(footageScene(), { format: "png-sequence", fps: FPS }, {
    mediaRoot, sequenceDirectory, signal: controller.signal, videoLimits: { windowFrames: WINDOW },
    // Cancel just after the first window, while FFmpeg extracts the next ones.
    onProgress: () => { if (++drawn === WINDOW + 2) controller.abort(); },
  }), { name: "AbortError" });
  assert.deepEqual(await readdir(temporary), [], "nothing is left in the temporary folder");
});

test("windows: frames drawn two at a time keep at most two windows, each extracted once, one after another, and deleted after its last frame", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-video-windows-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extracted = [];
  let running = 0, mostRunning = 0;
  const windows = videoWindows({
    directory, frameCount: 23, windowFrames: 5,
    extract: async (first, end, folder) => {
      extracted.push([first, end]);
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await writeFile(join(folder, "picture.png"), "");
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      return `${first}-${end}`;
    },
  });
  const onDisk = () => readdirSync(directory).length;
  let most = 0;
  // As export.mjs orderedFrames does: frame i + 2 starts when frame i is finished.
  const draw = async (index) => {
    const pictures = await windows.picturesFor(index);
    most = Math.max(most, onDisk());
    assert.equal(pictures, `${Math.floor(index / 5) * 5}-${Math.min(23, Math.floor(index / 5) * 5 + 5)}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    windows.done(index);
  };
  const pending = [draw(0), draw(1)];
  for (let index = 2; index < 23; index += 1) {
    await pending.shift();
    pending.push(draw(index));
  }
  await Promise.all(pending);
  await windows.close();
  assert.deepEqual(extracted, [[0, 5], [5, 10], [10, 15], [15, 20], [20, 23]], "each window once, in order");
  assert.equal(mostRunning, 1, "one extraction at a time");
  assert.equal(most, 2, "the window being drawn and the next one");
  assert.equal(onDisk(), 0, "every window is deleted after its last frame");
});

test("windows: frames drawn a whole window at a time, finishing out of order, still keep at most two windows", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-video-windows-ahead-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extracted = [];
  const windows = videoWindows({
    directory, frameCount: 23, windowFrames: 5,
    extract: async (first, end, folder) => {
      extracted.push([first, end]);
      await writeFile(join(folder, "picture.png"), "");
      return `${first}-${end}`;
    },
  });
  const onDisk = () => readdirSync(directory).length;
  let most = 0;
  const times = Array.from({ length: 23 }, (_, index) => index);
  // As export.mjs does with several raster workers: as many frames at once as a window holds, and
  // later frames often finish first.
  const draw = async (time, index) => {
    try {
      const pictures = await windows.picturesFor(index);
      most = Math.max(most, onDisk());
      assert.equal(pictures, `${Math.floor(index / 5) * 5}-${Math.min(23, Math.floor(index / 5) * 5 + 5)}`);
      await new Promise((resolve) => setTimeout(resolve, [6, 1, 3, 0, 2][index % 5]));
      return {};
    } finally { windows.done(index); }
  };
  const order = [];
  for await (const frame of orderedFrames(times, draw, undefined, 5)) order.push(frame.index);
  await windows.close();
  assert.deepEqual(order, times);
  assert.deepEqual(extracted, [[0, 5], [5, 10], [10, 15], [15, 20], [20, 23]], "each window once, in order");
  assert.equal(most, 2, "never more than two windows on disk");
  assert.equal(onDisk(), 0, "every window is deleted after its last frame");
});
