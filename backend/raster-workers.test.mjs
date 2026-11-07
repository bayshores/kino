// Drawing an export's frames with several Chromium raster workers at once (raster-workers.mjs
// chooses how many, chromium-raster.mjs runs them, export.mjs orderedFrames puts the frames back in
// order): how many are chosen, that two exports starting together leave room for each other, that
// frames reach the encoder in order, that a movie drawn by three workers has exactly the pixels of
// one drawn by one worker, and that the same export gives the same pixels every time.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { effectDefaults } from "../engine/effects/catalog.js";
import { exportFrameTimes } from "../engine/exportOptions.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { MAX_RASTER_WORKERS, claimRasterWorkers, rasterFrameCounts, rasterWorkerStarts, rasterWorkersRunning } from "./chromium-raster.mjs";
import { exportScene, orderedFrames } from "./export.mjs";
import { ffmpeg, makeVideo, run, skipWithoutMediaTools } from "./media.test.support.mjs";
import { KEEP_FREE_PERCENT, MIN_FRAMES_PER_WORKER, WORKER_MEMORY_MB, chooseRasterWorkers, framesAtOnceCap, freeMemoryMB, workerCap, workerMemoryMB } from "./raster-workers.mjs";
import { renderFrameCache } from "./render-frame-cache.mjs";

// A computer with room for many workers, and KINO_RASTER_WORKERS asking for more than may run, so
// each test can show the one limit it is about.
const roomy = { frames: 720, env: { KINO_RASTER_WORKERS: "20" }, cpus: 32, totalMB: 65536, freeMB: 60000, running: 0 };

test("the worker count is one unless KINO_RASTER_WORKERS asks for more", () => {
  assert.equal(chooseRasterWorkers({ ...roomy, env: {} }), 1);
  assert.equal(chooseRasterWorkers({ ...roomy, env: { KINO_RASTER_WORKERS: "four" } }), 1);
});

test("the worker count is the smallest of the cap, half the cores, the free memory, the frames and the room left", () => {
  assert.equal(chooseRasterWorkers(roomy), MAX_RASTER_WORKERS, "never more than the process-wide limit");
  assert.equal(chooseRasterWorkers({ ...roomy, env: { KINO_RASTER_WORKERS: "3" } }), 3, "KINO_RASTER_WORKERS caps it");
  assert.equal(chooseRasterWorkers({ ...roomy, env: { KINO_RASTER_WORKERS: "1" } }), 1);
  assert.equal(chooseRasterWorkers({ ...roomy, cpus: 11 }), 5, "half the cores, rounded down");
  // 18 GB computer, 8000 MB free: a fifth of all memory (3686.4 MB) stays free, the rest is
  // 4313.6 MB, room for two workers of WORKER_MEMORY_MB.
  assert.equal(WORKER_MEMORY_MB, 1600);
  assert.equal(chooseRasterWorkers({ ...roomy, totalMB: 18432, freeMB: 8000 }), 2);
  assert.equal(chooseRasterWorkers({ ...roomy, totalMB: 18432, freeMB: 3000 }), 1, "always at least one worker");
  assert.equal(MIN_FRAMES_PER_WORKER, 30);
  assert.equal(chooseRasterWorkers({ ...roomy, frames: 61 }), 3, "one worker for every 30 frames, rounded up");
  assert.equal(chooseRasterWorkers({ ...roomy, frames: 1 }), 1);
  assert.equal(chooseRasterWorkers({ ...roomy, running: 6 }), 2, "workers other exports run leave less room");
  assert.equal(chooseRasterWorkers({ ...roomy, cpus: 11, running: 3 }), 2, "they count against the cores");
  assert.equal(chooseRasterWorkers({ ...roomy, totalMB: 18432, freeMB: 11000, running: 3 }), 1, "and against the memory");
  assert.equal(chooseRasterWorkers({ ...roomy, running: MAX_RASTER_WORKERS }), 1);
  assert.equal(chooseRasterWorkers({ ...roomy, cpus: 1, freeMB: Number.NaN }), 1);
});

test("a worker counts for more memory the more pixels its frames have", () => {
  assert.equal(workerMemoryMB(1080, 1920), WORKER_MEMORY_MB);
  assert.equal(workerMemoryMB(1920, 1080), 1600);
  assert.equal(workerMemoryMB(640, 360), 1600, "smaller frames were not measured, so they count as much");
  assert.equal(workerMemoryMB(2160, 3840), 4000, "4K: 1600 MB and 800 MB for each further 1080x1920 of pixels");
  assert.equal(workerMemoryMB(3840, 2160), 4000);
  // The same 18 GB computer with 8000 MB free has room for two 1080x1920 workers, but for one at 4K
  // (4313.6 MB left over is little more than one 4K worker's 4000 MB).
  const computer = { ...roomy, env: { KINO_RASTER_WORKERS: "8" }, totalMB: 18432, freeMB: 8000 };
  assert.equal(chooseRasterWorkers({ ...computer, width: 1080, height: 1920 }), 2);
  assert.equal(chooseRasterWorkers({ ...computer, width: 2160, height: 3840 }), 1);
  assert.equal(chooseRasterWorkers({ ...computer, freeMB: 16000, width: 2160, height: 3840 }), 3);
});

test("frames at once caps the count; auto allows up to eight; KINO_RASTER_WORKERS still wins", () => {
  const computer = { ...roomy, env: {} };
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: 3 }), 3);
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: 1 }), 1);
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: "auto" }), MAX_RASTER_WORKERS);
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: "auto", cpus: 10 }), 5, "the cores still limit auto");
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: 6, frames: 50 }), 2, "and the frames");
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: 8, totalMB: 18432, freeMB: 8000 }), 2, "and the memory");
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: 4, env: { KINO_RASTER_WORKERS: "2" } }), 2, "the variable wins over the setting");
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: 1, env: { KINO_RASTER_WORKERS: "6" } }), 6);
  assert.equal(chooseRasterWorkers({ ...computer, framesAtOnce: 4, env: { KINO_RASTER_WORKERS: "many" } }), 4, "a variable that is not a number is ignored");
  for (const value of [undefined, 0, -2, 2.5, "3", null]) assert.equal(framesAtOnceCap(value), 1, String(value));
  assert.equal(framesAtOnceCap(20), MAX_RASTER_WORKERS);
});

test("memory to leave free replaces the fifth of all memory", () => {
  const computer = { ...roomy, env: {}, framesAtOnce: "auto", totalMB: 32768, freeMB: 16000 };
  assert.equal(KEEP_FREE_PERCENT, 20);
  // 32 GB, 16000 MB free: leaving 20% (6553.6 MB) gives 9446.4 MB, room for 5 workers of 1600 MB;
  // 40% (13107.2 MB) leaves 2892.8 MB, room for 1; 5% (1638.4 MB) leaves room for 8.
  assert.equal(chooseRasterWorkers(computer), 5);
  assert.equal(chooseRasterWorkers({ ...computer, keepFreePercent: 20 }), 5);
  assert.equal(chooseRasterWorkers({ ...computer, keepFreePercent: 40 }), 1);
  assert.equal(chooseRasterWorkers({ ...computer, keepFreePercent: 5 }), 8);
  assert.equal(chooseRasterWorkers({ ...computer, keepFreePercent: 90 }), 5, "a share outside 5 to 60 counts as 20");
});

test("KINO_RASTER_WORKERS counts only as a whole number from 1", () => {
  assert.equal(workerCap({ KINO_RASTER_WORKERS: "4" }), 4);
  assert.equal(workerCap({ KINO_RASTER_WORKERS: " 2 " }), 2);
  for (const text of [undefined, "", "0", "-1", "1.5", "four", "2x"]) assert.equal(workerCap({ KINO_RASTER_WORKERS: text }), null, String(text));
});

test("workers an export has chosen count as running until each takes its slot or gives up", () => {
  const before = rasterWorkersRunning();
  const release = claimRasterWorkers(3);
  assert.equal(rasterWorkersRunning(), before + 3);
  assert.equal(chooseRasterWorkers({ ...roomy, running: rasterWorkersRunning() }), MAX_RASTER_WORKERS - 3, "a second export leaves room for them");
  release();
  assert.equal(rasterWorkersRunning(), before + 2);
  release(Infinity);
  assert.equal(rasterWorkersRunning(), before);
  release(5);
  assert.equal(rasterWorkersRunning(), before, "a claim never gives back more than it took");
  claimRasterWorkers(0)(1);
  claimRasterWorkers(Number.NaN)(1);
  assert.equal(rasterWorkersRunning(), before);
});

test("free memory is the share macOS calls free on a Mac and os.freemem() elsewhere", () => {
  const total = 18 * 1024 * 1048576;
  assert.equal(freeMemoryMB({ platform: "darwin", total, free: 512 * 1048576, level: 50 }), 9216);
  assert.equal(freeMemoryMB({ platform: "linux", total, free: 512 * 1048576, level: 50 }), 512);
  assert.equal(freeMemoryMB({ platform: "darwin", total, free: 512 * 1048576, level: Number.NaN }), 512, "falls back when the level cannot be read");
});

test("frames drawn several at a time reach the encoder in order, and a frame starts only when there is room", async () => {
  const times = Array.from({ length: 20 }, (_, index) => index / 10);
  const started = [];
  const finished = new Set();
  let drawing = 0, most = 0;
  const draw = async (time, index) => {
    // Frame index starts only once every frame up to index - 4 is drawn: four frames at a time.
    for (let before = 0; before <= index - 4; before += 1) assert.ok(finished.has(before), `frame ${index} started before frame ${before} was drawn`);
    started.push(index);
    drawing += 1;
    most = Math.max(most, drawing);
    // Later frames often finish first.
    await new Promise((resolve) => setTimeout(resolve, [7, 1, 4, 0, 2][index % 5]));
    drawing -= 1;
    finished.add(index);
    return { time };
  };
  const order = [];
  for await (const frame of orderedFrames(times, draw, undefined, 4)) {
    order.push(frame.index);
    assert.equal(frame.time, times[frame.index]);
  }
  assert.deepEqual(order, times.map((_, index) => index));
  assert.deepEqual(started, times.map((_, index) => index), "frames start in order");
  assert.equal(most, 4, "four frames were drawn at once");
});

test("a failed frame stops the export after the frames before it, and the frames still drawing are awaited", async () => {
  const times = Array.from({ length: 10 }, (_, index) => index);
  const finished = [];
  const draw = async (time, index) => {
    await new Promise((resolve) => setTimeout(resolve, index === 3 ? 5 : 1));
    finished.push(index);
    if (index === 3) throw new Error("frame 4 failed");
    return {};
  };
  const order = [];
  await assert.rejects(async () => { for await (const frame of orderedFrames(times, draw, undefined, 3)) order.push(frame.index); }, /frame 4 failed/);
  assert.deepEqual(order, [0, 1, 2]);
  assert.deepEqual([...finished].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], "frames 5 and 6 were drawing and were waited for");
});

const WIDTH = 96, HEIGHT = 64, FPS = 30, DURATION = 1.2;

// Fog (a little different every frame) and a dot that moves across the frame, so every frame
// differs from the one before it and a frame in the wrong place would show.
function movingScene(duration = DURATION) {
  const fog = createLayer("rectangle", { id: "fog", name: "Fog", x: 0, y: 0, width: WIDTH, height: HEIGHT, fillEnabled: false, strokeWidth: 0 });
  fog.animations = [{ id: "fog-effect", name: "fog", kind: "effect", effect: "fog", start: 0, duration, easing: "linear",
    from: { count: 12 }, to: { count: 12 } }];
  const dot = createLayer("ellipse", { id: "dot", name: "Dot", x: 0, y: 16, width: 24, height: 24, fill: "#ff8040", strokeWidth: 0 });
  dot.animations = [{ id: "dot-move", name: "Move", kind: "custom", start: 0, duration, easing: "linear", from: { x: 0 }, to: { x: 72 } }];
  return parseDocument(createDocument({ id: "workers-pixels", name: "Workers pixels",
    scenes: [createScene({ id: "main", name: "Main", width: WIDTH, height: HEIGHT, duration, background: "#203040", layers: [fog, dot] })] })).scenes[0];
}

// The movie's frames as RGBA bytes, one buffer for each frame. FFmpeg reads the APNG from a file
// (the Linux build cannot read one from a pipe).
async function movieFrames(bytes, count, width = WIDTH, height = HEIGHT) {
  const directory = await mkdtemp(join(tmpdir(), "kino-raster-workers-"));
  try {
    const file = join(directory, "movie.apng");
    await writeFile(file, bytes);
    const pixels = await run(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    const size = width * height * 4;
    assert.equal(pixels.length, size * count, "the movie has every frame");
    return Array.from({ length: count }, (_, index) => pixels.subarray(index * size, (index + 1) * size));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Exports the scene with `workers` raster workers, every frame drawn by Chromium (none from the
// frame cache), and returns the frames and how many workers started.
async function exportWith(workers, extra = {}) {
  renderFrameCache.clear();
  const starts = rasterWorkerStarts.count;
  const drawn = rasterFrameCounts.pixels;
  const result = await exportScene(movingScene(), { fps: FPS, format: "apng" }, { rasterWorkers: workers, ...extra });
  return { result, started: rasterWorkerStarts.count - starts, drawn: rasterFrameCounts.pixels - drawn };
}

test("a movie drawn by three workers at once has exactly the pixels of one drawn by one worker, frame for frame", { skip: skipWithoutMediaTools }, async () => {
  const count = exportFrameTimes(DURATION, FPS, { format: "apng" }).length;
  const one = await exportWith(1);
  const three = await exportWith(3);
  assert.deepEqual([one.started, one.drawn], [1, count], "one worker drew every frame");
  assert.deepEqual([three.started, three.drawn], [3, count], "three workers started and every frame was drawn");
  const serial = await movieFrames(one.result.buffer, count);
  const parallel = await movieFrames(three.result.buffer, count);
  for (let index = 1; index < count; index += 1) {
    assert.ok(!serial[index].equals(serial[index - 1]), `frame ${index + 1} differs from the frame before it, so the order shows`);
  }
  for (let index = 0; index < count; index += 1) {
    assert.ok(parallel[index].equals(serial[index]), `frame ${index + 1} has the same pixels and the same place`);
  }
  assert.equal(rasterWorkersRunning(), 0, "every worker was closed");
});

test("cancelling an export drawn by three workers stops all three", { skip: skipWithoutMediaTools }, async () => {
  const controller = new AbortController();
  const starts = rasterWorkerStarts.count;
  renderFrameCache.clear();
  await assert.rejects(exportScene(movingScene(), { fps: FPS, format: "apng" }, {
    rasterWorkers: 3,
    signal: controller.signal,
    onProgress(event) {
      if (event.stage === "render" && event.completed >= 4) controller.abort(new Error("cancelled by the test"));
    },
  }), { name: "AbortError" });
  assert.equal(rasterWorkerStarts.count - starts, 3);
  assert.equal(rasterWorkersRunning(), 0, "no worker is left running");
});

test("two exports that start together leave room for each other's workers", { skip: skipWithoutMediaTools }, async (t) => {
  const setting = process.env.KINO_RASTER_WORKERS;
  process.env.KINO_RASTER_WORKERS = String(MAX_RASTER_WORKERS);
  t.after(() => { if (setting === undefined) delete process.env.KINO_RASTER_WORKERS; else process.env.KINO_RASTER_WORKERS = setting; });
  // 8 s at 30 fps: enough frames that the count is set by the cores, the memory or the
  // process-wide limit, which the two exports share, and not by the number of frames.
  const scene = movingScene(8);
  const frames = exportFrameTimes(8, FPS, { format: "apng" }).length;
  const alone = chooseRasterWorkers({ frames });
  renderFrameCache.clear();
  const starts = rasterWorkerStarts.count;
  // Started in the same step: each chooses its worker count before either has started a worker.
  // Before, both chose as if the other were not there (on an 11-core Mac, 5 each: 8 started).
  const results = await Promise.all([1, 2].map(() => exportScene(scene, { fps: FPS, format: "apng" })));
  const started = rasterWorkerStarts.count - starts;
  t.diagnostic(`${started} workers started; one export alone chooses ${alone}`);
  assert.ok(started <= alone + 1, `${started} workers started; one export alone chooses ${alone}, and the second always gets one`);
  assert.ok(results.every((result) => result.buffer.length > 0));
  assert.equal(rasterWorkersRunning(), 0, "every worker was closed and every claim given back");
});

// A JPEG with fine stripes, which Chromium draws a little differently from a picture it decoded
// for another size than from a fresh one.
async function stripedPhoto(file) {
  const canvas = createCanvas(800, 600);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 800, 600);
  gradient.addColorStop(0, "#ff3366"); gradient.addColorStop(0.5, "#33ccff"); gradient.addColorStop(1, "#ffee55");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 800, 600);
  for (let index = 0; index < 40; index += 1) {
    context.fillStyle = `hsl(${index * 37 % 360},70%,${30 + index % 40}%)`;
    context.beginPath();
    context.arc((index * 97) % 800, (index * 53) % 600, 20 + index % 50, 0, Math.PI * 2);
    context.fill();
  }
  for (let row = 0; row < 120; row += 1) { context.fillStyle = row % 2 ? "#000" : "#fff"; context.fillRect(0, row * 5, 800, 2); }
  await writeFile(file, canvas.toBuffer("image/jpeg", 90));
}

const PICTURE_WIDTH = 192, PICTURE_HEIGHT = 108;
const effect = (id, key, to, from) => ({ id, name: key, kind: "effect", effect: key, start: 0, duration: 1, easing: "linear",
  to: { ...effectDefaults(key), ...to }, ...(from ? { from: { ...effectDefaults(key), ...from } } : {}) });
const change = (id, from, to) => ({ id, name: id, kind: "custom", start: 0, duration: 1, easing: "linear", from, to });
const photo = (id, props) => createLayer("image", { id, name: id, src: "/api/media/photo.jpg", ...props });
// Every change and effect runs the whole scene.
function pictureScene(layers, duration) {
  for (const layer of layers) for (const animation of layer.animations ?? []) animation.duration = duration;
  return parseDocument(createDocument({ id: "workers-pictures", name: "Workers pictures",
    scenes: [createScene({ id: "main", name: "Main", width: PICTURE_WIDTH, height: PICTURE_HEIGHT, duration, background: "#102030", layers })] })).scenes[0];
}

// The photo shrunk to four sizes that change as it moves, inside a zoom blur, inward echoes and a
// radial repeat blur.
function shrunkPhotoScene() {
  const layers = [[160, 120], [96, 72], [48, 36], [24, 18]].map(([width, height], index) => {
    const layer = photo(`photo-${index}`, { x: 0, y: index * 20, width, height });
    layer.animations = [change(`move-${index}`, { x: index * 30 - 20, rotation: 0, scaleX: 1, scaleY: 1 }, { x: index * 30 + 40, rotation: 10, scaleX: 0.45, scaleY: 0.45 })];
    return layer;
  });
  const echo = createLayer("group", { id: "echo", name: "Echo", x: 100, y: 10, width: 80, height: 60 });
  echo.animations = [effect("echoes", "inward-echoes", { repeatCount: 4, scaleDown: 0.4 }), change("echo-move", { x: 90 }, { x: 110 })];
  const repeat = createLayer("group", { id: "repeat", name: "Repeat", x: 110, y: 60, width: 64, height: 48 });
  repeat.animations = [effect("repeats", "radial-repeat-blur", { repeats: 8, angle: 60, blurAmount: 0.1 }), change("repeat-turn", { rotation: 0 }, { rotation: 20 })];
  const zoom = createLayer("group", { id: "zoom", name: "Zoom", x: 20, y: 40, width: 120, height: 60 });
  zoom.animations = [effect("zoom-blur", "zoom-blur", { amount: 0.35, centerX: 0.3, centerY: 0.4 }, { amount: 0, centerX: 0.3, centerY: 0.4 })];
  layers.push(echo, photo("echo-photo", { parentId: "echo", x: 0, y: 0, width: 80, height: 60 }),
    repeat, photo("repeat-photo", { parentId: "repeat", x: 0, y: 0, width: 64, height: 48 }),
    zoom, photo("zoom-photo", { parentId: "zoom", x: 0, y: 0, width: 120, height: 60 }), photo("zoom-small", { parentId: "zoom", x: 60, y: 30, width: 40, height: 30 }));
  return pictureScene(layers, 0.5);
}

// Exports `scene` (motion blur on) with `workers` raster workers and returns its frames.
async function pictureMovie(scene, mediaRoot, workers) {
  renderFrameCache.clear();
  const starts = rasterWorkerStarts.count;
  const result = await exportScene(scene, { fps: FPS, format: "apng", motionBlur: 0.5, motionSamples: 2 }, { rasterWorkers: workers, mediaRoot });
  assert.equal(rasterWorkerStarts.count - starts, workers);
  const count = exportFrameTimes(scene.duration, FPS, { format: "apng" }).length;
  return movieFrames(result.buffer, count, PICTURE_WIDTH, PICTURE_HEIGHT);
}

const differentFrames = (frames, reference) => frames.map((pixels, index) => pixels.equals(reference[index]) ? null : index + 1).filter(Boolean);

// Before each paint decoded its pictures afresh (desktop/raster-page.cjs paintLinks), 3 workers gave
// 14 of 16 frames of this movie up to 48 levels away from 1 worker, in 4 of 4 runs.
test("a JPEG shrunk to changing sizes, with motion blur, has one worker's pixels when three draw it, run after run", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-raster-workers-photo-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  await stripedPhoto(join(mediaRoot, "photo.jpg"));
  const scene = shrunkPhotoScene();
  const one = await pictureMovie(scene, mediaRoot, 1);
  for (let index = 1; index < one.length; index += 1) assert.ok(!one[index].equals(one[index - 1]), `frame ${index + 1} moves on`);
  for (let runNumber = 1; runNumber <= 3; runNumber += 1) {
    const three = await pictureMovie(scene, mediaRoot, 3);
    assert.deepEqual(differentFrames(three, one), [], `run ${runNumber} of three workers: frames that differ from one worker`);
  }
  assert.equal(rasterWorkersRunning(), 0);
});

// A busy computer sometimes drew a frame while its pictures were still loading, and the finished
// frame was then drawn from that early drawing's decoded pictures, a little differently. The page
// now hides a frame until it is ready (desktop/raster-page.cjs); KINO_RASTER_TEST_EARLY_FRAME=1
// makes the early drawing happen every time. Before the fix, frames 1 and 12 to 16 then differed on
// a Mac. Drawn without the graphics processor (KINO_RASTER_GPU=off, as on Linux CI) the early
// drawing changed no pixel even before the fix, so there this test passes either way.
test("a frame Chromium draws early, while its pictures load, keeps the pixels of a frame drawn once", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-raster-workers-early-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  await stripedPhoto(join(mediaRoot, "photo.jpg"));
  const scene = shrunkPhotoScene();
  const once = await pictureMovie(scene, mediaRoot, 1);
  const before = process.env.KINO_RASTER_TEST_EARLY_FRAME;
  process.env.KINO_RASTER_TEST_EARLY_FRAME = "1";
  let early;
  try {
    early = await pictureMovie(scene, mediaRoot, 1);
  } finally {
    if (before === undefined) delete process.env.KINO_RASTER_TEST_EARLY_FRAME;
    else process.env.KINO_RASTER_TEST_EARLY_FRAME = before;
  }
  assert.deepEqual(differentFrames(early, once), [], "frames that differ when Chromium drew them early");
});

// Pictures (a photo, a PNG with partial alpha and a video) in groups inside groups, each with
// effects that draw them again at other sizes and turns. A 60-frame, 640x360 test scene of this
// kind drawn by one worker had a few frames (22, 28, 49 and 56 in the review's runs) up to 1 level
// different from one run to the next; frames 22 and 49 still are now and then, from the graphics
// processor's own caches (chromium-raster.mjs, createPool). This small scene gave the same pixels
// in 5 of 5 exports before and after the changes, so it guards the result rather than showing a
// problem.
test("pictures in nested groups give the same pixels in five exports with one worker", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-raster-workers-nested-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  await stripedPhoto(join(mediaRoot, "photo.jpg"));
  const tile = createCanvas(300, 200);
  const context = tile.getContext("2d");
  const image = context.createImageData(300, 200);
  for (let index = 0; index < image.data.length; index += 4) {
    const pixel = index / 4;
    image.data.set([pixel % 300 * 0.85, pixel / 300 * 1.27, (pixel * 2654435761) % 251, 128 + (pixel * 40503) % 127], index);
  }
  context.putImageData(image, 0, 0);
  await writeFile(join(mediaRoot, "tile.png"), tile.toBuffer("image/png"));
  await makeVideo(join(mediaRoot, "clip.mp4"), { width: 48, height: 32, fps: 30, frames: 12, frameColor: (frame) => [frame * 20, 180 - frame * 10, 90] });
  const layers = [];
  for (let index = 0; index < 2; index += 1) {
    const outer = createLayer("group", { id: `outer-${index}`, name: "Outer", x: 8 + index * 76, y: 6 + index * 12, width: 72, height: 60, rotation: 10 });
    outer.animations = [effect(`glow-${index}`, "glow", { strength: 2, radius: 6, threshold: 0.3 }), change(`outer-turn-${index}`, { rotation: 0 }, { rotation: 15 })];
    const inner = createLayer("group", { id: `inner-${index}`, name: "Inner", parentId: `outer-${index}`, x: 4, y: 4, width: 64, height: 52 });
    inner.animations = [effect(`spin-${index}`, "spin-blur", { angle: 25 }), change(`inner-turn-${index}`, { rotation: -20, scaleX: 1, scaleY: 1 }, { rotation: 20, scaleX: 0.6, scaleY: 0.6 })];
    layers.push(outer, inner,
      photo(`inner-photo-${index}`, { parentId: `inner-${index}`, x: 0, y: 0, width: 64, height: 28 }),
      createLayer("image", { id: `inner-tile-${index}`, name: "Tile", parentId: `inner-${index}`, x: 0, y: 28, width: 64, height: 24, src: "/api/media/tile.png" }),
      createLayer("video", { id: `inner-clip-${index}`, name: "Clip", parentId: `inner-${index}`, x: 12, y: 10, width: 40, height: 26,
        src: "/api/media/clip.mp4", mediaSourceDuration: 0.4, mediaFreeze: "both" }));
  }
  const scene = pictureScene(layers, 0.2);
  const first = await pictureMovie(scene, mediaRoot, 1);
  for (let runNumber = 2; runNumber <= 5; runNumber += 1)
    assert.deepEqual(differentFrames(await pictureMovie(scene, mediaRoot, 1), first), [], `export ${runNumber}: frames that differ from the first export`);
});
