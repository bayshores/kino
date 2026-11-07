import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { createExportBatches } from "./export-batches.mjs";
import { makeAnimatedGif, makeVideo, near, readImage, skipWithoutMediaTools } from "./media.test.support.mjs";

// A red bar slides from left to right across a black scene over `duration` seconds.
// `x` is the bar's design position, which the Design canvas shows without animation.
function slidingScene({ id = "sliding", name = "Sliding", duration = 2, x = 0 } = {}) {
  const bar = createLayer("rectangle", {
    id: `${id}-bar`, name: "Bar", x, y: 0, width: 4, height: 20, fill: "#ff0000",
    animations: [{
      id: `${id}-move`, name: "Move", kind: "custom", start: 0, duration, easing: "linear",
      from: { x: 0 }, to: { x: 36 }, unit: "layer", stagger: 0, order: "forward",
    }],
  });
  return createScene({ id, name, width: 40, height: 20, duration, background: "#000000", layers: [bar] });
}

// The average column of the red pixels in the middle row of a PNG.
async function barColumn(buffer) {
  const image = await readImage(buffer);
  const columns = [];
  for (let x = 0; x < image.width; x += 1) {
    const [red, green, blue] = image.pixel(x, Math.floor(image.height / 2));
    if (red > 200 && green < 60 && blue < 60) columns.push(x);
  }
  assert.ok(columns.length, "the bar is visible");
  return columns.reduce((sum, x) => sum + x, 0) / columns.length;
}

const still = (scene, time) => exportScene(scene, { format: "png", width: 40, height: 20, time });

test("a still PNG renders the requested time, not the first frame", async () => {
  const scene = slidingScene();
  const first = await still(scene, 0);
  const middle = await still(scene, 1);
  assert.notDeepEqual(middle.buffer, first.buffer, "t=1 differs from t=0");
  const start = await barColumn(first.buffer), halfway = await barColumn(middle.buffer);
  // Halfway through a linear 0 → 36 move the bar has travelled about 18 pixels.
  assert.ok(Math.abs(halfway - start - 18) <= 1, `the bar moved ${halfway - start} pixels by t=1`);
  assert.deepEqual((await exportScene(scene, { format: "png", width: 40, height: 20 })).buffer, first.buffer,
    "a request without a time still renders the first frame");
});

test("a still PNG time must be a finite number within the scene", async () => {
  const scene = slidingScene();
  for (const time of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])
    await assert.rejects(still(scene, time), /still image time/, `time ${String(time)} is rejected`);
  await assert.doesNotReject(still(scene, 2), "the last frame of the scene is allowed");
  await assert.rejects(exportScene(scene, { format: "png", width: 40, height: 20, duration: 1, time: 1.5 }),
    /between 0 and 1 seconds/, "an explicit duration is the upper limit");
});

test("a PNG batch renders the shared time in each scene, clamped to that scene", async (t) => {
  const exportBatches = createExportBatches();
  t.after(() => exportBatches.close());
  const long = slidingScene({ id: "long", name: "Long", duration: 2 });
  const short = slidingScene({ id: "short", name: "Short", duration: 1 });
  const document = createDocument({ name: "Still batch", scenes: [long, short] });
  await assert.rejects(exportBatches.create({ document, sceneIds: [long.id, short.id], options: { format: "png", time: 3 } }),
    /between 0 and 2 seconds/, "a time past every selected scene is rejected");
  const batch = await exportBatches.create({ document, sceneIds: [long.id, short.id], options: { format: "png", width: 40, height: 20, time: 1.5 } });
  assert.deepEqual(batch.jobs.map((job) => job.options.time), [1.5, 1], "the shorter scene uses its last frame");
  assert.equal(exportBatches.snapshot(batch).options.time, 1.5, "the queue keeps the requested time");
  const deadline = Date.now() + 20_000;
  while (exportBatches.snapshot(batch).jobs.some((job) => !["completed", "failed", "canceled"].includes(job.status))) {
    assert.ok(Date.now() < deadline, "the batch finishes");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(exportBatches.snapshot(batch).jobs.map((job) => job.status), ["completed", "completed"]);
  const saved = await Promise.all(batch.jobs.map((job) => readFile(exportBatches.file(batch, job.id).path)));
  assert.deepEqual(saved[0], (await still(long, 1.5)).buffer, "the current scene renders the playhead");
  assert.deepEqual(saved[1], (await still(short, 1)).buffer, "the shorter scene renders its last frame");
});

test("a design-view still renders the design values the Design canvas shows, not the hidden playhead", async () => {
  // The bar's design x is 30; its animation moves it from 0 to 36.
  const scene = slidingScene({ x: 30 });
  const design = await exportScene(scene, { format: "png", width: 40, height: 20, design: true });
  const atStart = await barColumn((await still(scene, 0)).buffer);
  const atPlayhead = await barColumn((await still(scene, 1)).buffer);
  const designColumn = await barColumn(design.buffer);
  // A 4 px bar at x 30 covers columns 30 to 33, so its middle is 31.5.
  assert.ok(Math.abs(designColumn - 31.5) <= 1, `the design view shows the bar at its design x (column ${designColumn})`);
  assert.ok(Math.abs(designColumn - atStart) > 10 && Math.abs(designColumn - atPlayhead) > 10, "it is not an animated frame");
  assert.deepEqual((await exportScene(scene, { format: "png", width: 40, height: 20, design: true, time: 1.5 })).buffer, design.buffer,
    "the playhead does not change the design view");
  await assert.rejects(exportScene(scene, { format: "png", width: 40, height: 20, design: "yes" }), /design view must be true or false/);
  await assert.rejects(exportScene(scene, { format: "lottie", design: true }), /design view applies only to still PNG/);
  assert.ok((await exportScene(scene, { format: "png", width: 40, height: 20, design: false, time: 1 })).buffer.equals((await still(scene, 1)).buffer),
    "design: false is an ordinary still at the playhead");
});

test("a design-view still shows a GIF at the frame where its Play starts, even where the playhead hides it", async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-still-design-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  // Four 0.1 s frames: red, green, blue, yellow.
  await writeFile(join(mediaRoot, "colors.gif"), makeAnimatedGif({ width: 16, height: 16, frames: [
    { delayCs: 10, color: [255, 0, 0] }, { delayCs: 10, color: [0, 255, 0] },
    { delayCs: 10, color: [0, 0, 255] }, { delayCs: 10, color: [255, 255, 0] },
  ] }));
  // Play starts at 1 s and reads the GIF from 0.1 s (the green frame), so at 0 s the layer is hidden.
  const gif = createLayer("image", { id: "gif", name: "GIF", x: 0, y: 0, width: 16, height: 16, src: "/api/media/colors.gif",
    mediaStart: 1, mediaDuration: 0.3, mediaOffset: 0.1 });
  const scene = createScene({ id: "s", name: "S", width: 16, height: 16, duration: 2, background: "#000000", layers: [gif] });
  const design = await readImage((await exportScene(scene, { format: "png", design: true, time: 0 }, { mediaRoot })).buffer);
  assert.deepEqual(design.pixel(8, 8), [0, 255, 0, 255], "the design view shows the green frame where Play starts");
  const hidden = await readImage((await exportScene(scene, { format: "png", time: 0 }, { mediaRoot })).buffer);
  assert.deepEqual(hidden.pixel(8, 8), [0, 0, 0, 255], "at 0 s on the timeline the GIF is not showing yet");
});

test("a design-view still shows a video at the frame where its Play starts", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-still-design-video-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  // Four frames per second: red, green, blue, yellow.
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  await makeVideo(join(mediaRoot, "colors.mp4"), { width: 16, height: 16, fps: 4, frames: 4, frameColor: (n) => colors[n] });
  // Play starts at 1 s and reads the video from 0.5 s (blue); before 1 s the layer is hidden.
  const video = createLayer("video", { id: "video", name: "Video", x: 0, y: 0, width: 16, height: 16, src: "/api/media/colors.mp4",
    mediaStart: 1, mediaOffset: 0.5, mediaFreeze: "none" });
  const scene = createScene({ id: "v", name: "V", width: 16, height: 16, duration: 2, background: "#000000", layers: [video] });
  const pixel = async (options) => (await readImage((await exportScene(scene, { format: "png", ...options }, { mediaRoot })).buffer)).pixel(8, 8);
  assert.ok(near(await pixel({ design: true }), [0, 0, 255, 255], 12), "the design view shows the blue frame where Play starts");
  assert.ok(near(await pixel({ time: 1.3 }), [255, 255, 0, 255], 12), "at 1.3 s on the timeline the video shows source 0.8 s (yellow)");
  assert.ok(near(await pixel({ time: 0 }), [0, 0, 0, 255], 12), "at 0 s on the timeline the video is not showing yet");
});

async function finished(exportBatches, batch) {
  const deadline = Date.now() + 20_000;
  while (exportBatches.snapshot(batch).jobs.some((job) => !["completed", "failed", "canceled"].includes(job.status))) {
    assert.ok(Date.now() < deadline, "the batch finishes");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return exportBatches.snapshot(batch);
}

const thumbnail = (scene, frame) => exportScene(scene, { format: "png", width: 150, height: 84, ...frame });

test("a PNG batch row's thumbnail shows the same frame as the PNG it saves", async (t) => {
  const exportBatches = createExportBatches();
  t.after(() => exportBatches.close());
  const long = slidingScene({ id: "long", name: "Long", duration: 2, x: 30 });
  const short = slidingScene({ id: "short", name: "Short", duration: 1, x: 30 });
  const document = createDocument({ name: "Still thumbnails", scenes: [long, short] });
  for (const options of [{ format: "lottie", design: true }, { format: "png", design: 1 }])
    await assert.rejects(exportBatches.create({ document, sceneIds: [long.id], options }),
      (error) => error.status === 400 && /design view/.test(error.message), `${JSON.stringify(options)} is rejected`);
  const batch = await exportBatches.create({ document, sceneIds: [long.id, short.id], options: { format: "png", width: 40, height: 20, time: 1.5 } });
  let snapshot = await finished(exportBatches, batch);
  assert.deepEqual(snapshot.jobs.map((job) => job.status), ["completed", "completed"]);
  const thumbnails = () => Promise.all(batch.jobs.map((job) => readFile(exportBatches.file(batch, job.id, true).path)));
  assert.deepEqual(await thumbnails(), [(await thumbnail(long, { time: 1.5 })).buffer, (await thumbnail(short, { time: 1 })).buffer],
    "each thumbnail shows the scene's still time, clamped like its PNG");
  const firstVersions = snapshot.jobs.map((job) => job.thumbnailVersion);

  // Restarting with the design view replaces the thumbnails, and the new version tells the page to reload them.
  await exportBatches.action(batch, { type: "restart", options: { format: "png", width: 40, height: 20, design: true } });
  snapshot = await finished(exportBatches, batch);
  assert.deepEqual(snapshot.jobs.map((job) => job.status), ["completed", "completed"]);
  assert.deepEqual(await thumbnails(), [(await thumbnail(long, { design: true })).buffer, (await thumbnail(short, { design: true })).buffer]);
  snapshot.jobs.forEach((job, index) => assert.ok(job.thumbnailVersion > firstVersions[index], "the thumbnail version changes"));
  const designVersions = snapshot.jobs.map((job) => job.thumbnailVersion);

  // Animated formats keep the first frame as their thumbnail.
  await exportBatches.action(batch, { type: "restart", options: { format: "lottie" } });
  snapshot = await finished(exportBatches, batch);
  assert.deepEqual(snapshot.jobs.map((job) => job.status), ["completed", "completed"]);
  assert.deepEqual(await thumbnails(), [(await thumbnail(long, { time: 0 })).buffer, (await thumbnail(short, { time: 0 })).buffer]);
  snapshot.jobs.forEach((job, index) => assert.ok(job.thumbnailVersion > designVersions[index]));

  // Retrying with the same frame keeps the thumbnail that is already there.
  const kept = exportBatches.snapshot(batch).jobs[0].thumbnailVersion;
  await exportBatches.action(batch, { type: "retry", jobId: batch.jobs[0].id });
  snapshot = await finished(exportBatches, batch);
  assert.equal(snapshot.jobs[0].thumbnailVersion, kept);
});
