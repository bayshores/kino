import test from "node:test";
import assert from "node:assert/strict";
import { resolveExportDimensions, exportFrameCount, exportFrameStep, exportFrameTime, exportFrameTimes } from "./exportOptions.js";
import { ffmpegRate, fpsLabel, frameRateFraction, frameToTime, parseFps } from "./frameRate.js";
import { nextMp4Encoder } from "./mp4Encoders.js";
import { MEDIA_SAMPLE_TOLERANCE } from "./playback.js";
import { MAX_TIME } from "./schema.js";

test("export presets match observed Pro short-edge scaling and format-specific even dimensions", () => {
  const scene = { width: 640, height: 360 };
  assert.deepEqual(resolveExportDimensions(scene, "480p", "mp4"), { width: 852, height: 480 });
  assert.deepEqual(resolveExportDimensions(scene, "480p", "gif"), { width: 853, height: 480 });
  assert.deepEqual(resolveExportDimensions(scene, "4K", "mp4"), { width: 3840, height: 2160 });
  assert.deepEqual(resolveExportDimensions({ width: 360, height: 640 }, "1080p", "mp4"), { width: 1080, height: 1920 });
  assert.deepEqual(resolveExportDimensions(scene, "0.5x", "mp4"), { width: 320, height: 180 });
  assert.throws(() => resolveExportDimensions(scene, "made-up", "mp4"), /Unknown export size/);
});

test("animated image sampling includes the endpoint and reverses source time for boomerang", () => {
  const times = exportFrameTimes(4, 25, { format: "gif", playbackDirection: "boomerang" });
  assert.equal(times.length, 201);
  assert.equal(times[0], 0);
  assert.equal(times[100], 4);
  assert.equal(times[200], 0);
  assert.ok(Math.abs(times[101] - 3.96) < 1e-10);
  assert.equal(exportFrameTimes(4, 60, { format: "mp4" }).length, 240);
  // Video exports share the rounded frame step, so a Play range ending at 2 s is over by frame 120.
  assert.ok(Math.abs(exportFrameTimes(4, 60, { format: "mp4" })[120] - 2.000004) < 1e-12);
  assert.equal(exportFrameTimes(4, 25, { format: "apng" }).at(-1), 4);
  assert.throws(() => exportFrameTimes(4, 25, { format: "mp4", playbackDirection: "boomerang" }), /GIF and APNG/);
});

test("the export frame step is the frame length rounded to 0.0001 ms and drives every sampled time", () => {
  assert.equal(exportFrameStep(60), 0.0166667);
  assert.equal(exportFrameStep(30), 0.0333333);
  assert.equal(exportFrameStep(25), 0.04);
  const times = exportFrameTimes(2, 30, { format: "png-sequence" });
  assert.ok(times.every((time, index) => Math.abs(time - index * exportFrameStep(30)) < 1e-12));
});

test("frame times never drift past what frame lookups accept, even ten minutes in", () => {
  // The rounded step adds up (2.4 ms early by 600 s at 120 fps), so the count starts again from
  // the exact time every two minutes; the first two minutes keep their old times exactly.
  assert.equal(exportFrameTime(7199, 60), 7199 * exportFrameStep(60));
  assert.equal(exportFrameTime(7200, 60), 120);
  assert.equal(exportFrameTime(36_000, 60), 600);
  for (const fps of [15, 24, 25, 30, 50, 60, 115, 120]) {
    const times = exportFrameTimes(MAX_TIME, fps, { format: "mp4" });
    assert.equal(times.length, MAX_TIME * fps);
    let worst = 0;
    for (let index = 0; index < times.length; index += 1) worst = Math.max(worst, Math.abs(times[index] - index / fps));
    assert.ok(worst < MEDIA_SAMPLE_TOLERANCE, `${fps} fps drifts ${worst * 1000} ms`);
    for (let index = 1; index < times.length; index += 1) assert.ok(times[index] > times[index - 1], `${fps} fps frame ${index} moves forward`);
  }
});

test("23.976 and 29.97 are read in every spelling and timed by their exact fraction", () => {
  const ntsc = 30000 / 1001;
  for (const value of [29.97, "29.97", "30000/1001", { num: 30000, den: 1001 }, ntsc]) assert.equal(parseFps(value), ntsc);
  for (const value of ["23.976", "23.98", 23.98]) assert.equal(parseFps(value), 24000 / 1001);
  assert.equal(parseFps("24"), 24);
  for (const value of [29.5, 29.98, 59.95, "30/1.001", { num: 30, den: 2 }, 0, 121, "fast", null]) assert.equal(parseFps(value), null);
  assert.deepEqual(frameRateFraction(ntsc), { num: 30000, den: 1001 });
  assert.equal(ffmpegRate(ntsc), "30000/1001");
  assert.equal(ffmpegRate(30), "30");
  assert.equal(fpsLabel(24000 / 1001), "23.976");
  assert.equal(frameToTime(300, ntsc), 10.01);
  // A 10 s scene is 300 frames; ten minutes is 17,983 frames, frame n exactly n * 1001 / 30000 s.
  assert.equal(exportFrameTimes(10, ntsc, { format: "mp4" }).length, 300);
  // Lottie uses the same count: 3.003 s at 23.976 is exactly 72 frames, not 73.
  assert.equal(exportFrameCount(3.003, 24000 / 1001), 72);
  const long = exportFrameTimes(MAX_TIME, ntsc, { format: "mp4" });
  assert.equal(long.length, 17_983);
  assert.equal(long.at(-1), 17_982 * 1001 / 30000);
});

test("MP4 alternatives advance in reference order while skipping unavailable candidates", () => {
  const available = ["h264HighSwOpus", "h264MainSwAAC"];
  assert.equal(nextMp4Encoder(available, "h264HighHwAAC"), "h264HighSwOpus");
  assert.equal(nextMp4Encoder(available, "h264HighSwOpus"), "h264MainSwAAC");
  assert.equal(nextMp4Encoder(available, "h264BaseSwAAC"), null);
});
