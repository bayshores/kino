import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { frameReference, inspectRenderedOutput, motionFacts } from "./render-output-audit.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMP_ROOT = join(PROJECT_ROOT, ".local", "tmp");
const FFMPEG = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const WIDTH = 32;
const HEIGHT = 18;
const PIXELS = WIDTH * HEIGHT;
let directory;

before(async () => {
  await mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  directory = await mkdtemp(join(TEMP_ROOT, "render-output-audit-"));
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function rgbaFrame([r, g, b, a = 255]) {
  const pixels = new Uint8Array(PIXELS * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = a;
  }
  return pixels;
}

function rgbFrame([r, g, b]) {
  const pixels = new Uint8Array(PIXELS * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
  }
  return pixels;
}

async function encodeApng(name, colors) {
  const rawPath = join(directory, `${name}.rgb`);
  const outputPath = join(directory, `${name}.png`);
  await writeFile(rawPath, Buffer.concat(colors.map(rgbFrame)));
  runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${WIDTH}x${HEIGHT}`,
    "-framerate", "10", "-i", rawPath, "-an", "-frames:v", String(colors.length),
    "-plays", "0", "-f", "apng", outputPath,
  ]);
  return outputPath;
}

function runFfmpeg(args) {
  const result = spawnSync(FFMPEG, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `FFmpeg fixture generation failed: ${result.stderr}`);
}

function references(colors) {
  return colors.map((color) => frameReference(rgbaFrame(color), WIDTH, HEIGHT));
}

test("frameReference accepts clamped canvas pixels and unpremultiplies transparent colors safely", () => {
  const clamped = new Uint8ClampedArray([64, 32, 16, 128, 250, 100, 50, 0]);
  const rgb = frameReference(clamped, 2, 1, { premultiplied: true });
  assert.deepEqual([...rgb.slice(0, 3)], [128, 64, 32]);
  assert.deepEqual([...rgb.slice(16 * 3, 17 * 3)], [0, 0, 0]);
  assert.deepEqual(frameReference(new Uint8Array(clamped), 2, 1, { premultiplied: true }), rgb);
});

test("decoded APNG matches intentional black and held renderer frames", async () => {
  const colors = [[0, 0, 0], [0, 0, 0], [210, 40, 30], [210, 40, 30]];
  const path = await encodeApng("intentional-holds", colors);
  const result = await inspectRenderedOutput(path, { format: "apng", fps: 10, references: references(colors), hasAudio: false });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.checks.decodedFrameCount.status, "pass");
  assert.equal(result.checks.unexpectedBlackFrames.status, "pass");
  assert.equal(result.checks.holdFlicker.status, "pass");
  assert.match(result.facts.method, /32×18 RGB thumbnails/);
});

test("a ten-minute render has every one of its frames compared", async () => {
  // 600 s at 30 fps: 18,000 frames, past the old 14,400-frame limit (two minutes at 120 fps).
  const color = [210, 40, 30];
  const outputPath = join(directory, "ten-minutes.mov");
  runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=0xd2281e:size=${WIDTH}x${HEIGHT}:rate=30`,
    "-t", "600", "-c:v", "mpeg4", "-q:v", "3", outputPath,
  ]);
  const frames = Array.from({ length: 18_000 }, () => frameReference(rgbaFrame(color), WIDTH, HEIGHT));
  const result = await inspectRenderedOutput(outputPath, { format: "mov", fps: 30, references: frames, hasAudio: false });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.facts.decodedFrameCount, 18_000);
  assert.equal(result.facts.framesCompared, 18_000);
});

test("decoded APNG reports unexpected black, frozen, flickering, and missing frames", async () => {
  const red = [220, 30, 20], blue = [10, 30, 220], green = [20, 200, 40];

  const blackPath = await encodeApng("unexpected-black", [[0, 0, 0], [0, 0, 0]]);
  const black = await inspectRenderedOutput(blackPath, { format: "apng", fps: 10, references: references([red, red]), hasAudio: false });
  assert.equal(black.checks.unexpectedBlackFrames.status, "fail");
  assert.equal(black.facts.unexpectedBlackCount, 2);

  const frozenPath = await encodeApng("frozen", [red, red]);
  const frozen = await inspectRenderedOutput(frozenPath, { format: "apng", fps: 10, references: references([red, blue]), hasAudio: false });
  assert.equal(frozen.checks.frozenFrames.status, "fail");
  assert.equal(frozen.facts.frozenCount, 1);

  const flickerPath = await encodeApng("hold-flicker", [red, green]);
  const flicker = await inspectRenderedOutput(flickerPath, { format: "apng", fps: 10, references: references([red, red]), hasAudio: false });
  assert.equal(flicker.checks.holdFlicker.status, "fail");
  assert.equal(flicker.facts.holdFlickerCount, 1);

  const droppedPath = await encodeApng("dropped-frame", [red, blue]);
  const dropped = await inspectRenderedOutput(droppedPath, { format: "apng", fps: 10, references: references([red, blue, green]), hasAudio: false });
  assert.equal(dropped.checks.decodedFrameCount.status, "fail");
  assert.equal(dropped.facts.decodedFrameCount, 2);
});

function rgbToRgba(rgb) {
  const rgba = new Uint8Array(rgb.length / 3 * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = 255;
  }
  return rgba;
}

function mirrored(rgba, width, height) {
  const flipped = new Uint8Array(rgba.length);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      flipped.set(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (y * width + width - 1 - x) * 4);
  return flipped;
}

// FFmpeg's testsrc2 has colour detail that changes every few pixels. Before the thumbnail decode
// gave each column its own colour sample, its 4:2:0 file failed rendererMatch on every frame
// (mean error about 20) although the file matched its frames within about 1 level.
test("a busy 4:2:0 MP4 (FFmpeg testsrc2) matches its renderer references; a mirrored picture still fails", async () => {
  const width = 160, height = 90, frames = 6, frameBytes = width * height * 3;
  const rawPath = join(directory, "busy.rgb");
  const outputPath = join(directory, "busy.mp4");
  // The renderer's frames: testsrc2 decoded from 4:2:0, as a video layer's frames are.
  runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30`,
    "-frames:v", String(frames), "-vf", "format=yuv420p,format=rgb24", "-pix_fmt", "rgb24", "-f", "rawvideo", rawPath]);
  runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
    "-video_size", `${width}x${height}`, "-framerate", "30", "-i", rawPath,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-an", outputPath]);
  const rgb = await readFile(rawPath);
  assert.equal(rgb.length, frames * frameBytes);
  const rendered = Array.from({ length: frames }, (_, index) => rgbToRgba(rgb.subarray(index * frameBytes, (index + 1) * frameBytes)));

  const busy = await inspectRenderedOutput(outputPath, { format: "mp4", fps: 30, hasAudio: false,
    references: rendered.map((pixels) => frameReference(pixels, width, height)) });
  assert.equal(busy.checks.rendererMatch.status, "pass", JSON.stringify(busy.checks.rendererMatch));
  assert.ok(busy.facts.meanRgbError < 3, `each sampled pixel keeps its own colour (mean error ${busy.facts.meanRgbError})`);
  assert.equal(busy.ok, true, JSON.stringify(busy.checks));

  const wrong = await inspectRenderedOutput(outputPath, { format: "mp4", fps: 30, hasAudio: false,
    references: rendered.map((pixels) => frameReference(mirrored(pixels, width, height), width, height)) });
  assert.equal(wrong.checks.rendererMatch.status, "fail", "the check still catches a picture that is not the rendered one");
  assert.equal(wrong.facts.mismatchCount, frames);
});

test("a final MP4 render of a testsrc2 video layer passes its decoded-output audit", async () => {
  const width = 160, height = 90, duration = 0.5;
  const mediaRoot = join(directory, "busy-media");
  await mkdir(mediaRoot);
  runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=${duration}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(mediaRoot, "busy.mp4")]);
  const video = { id: "busy", name: "busy", type: "video", parentId: null, x: 0, y: 0, width, height, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, visible: true, locked: false, src: "/api/media/busy.mp4", mediaDuration: duration, animations: [] };
  const scene = { id: "busy-video", name: "Busy video", width, height, duration, background: "#000000", layers: [video] };
  // mp4.alt (libx264) keeps this fast on every computer; the audit decodes any H.264 file the same way.
  const result = await exportScene(scene, { profile: "mp4.alt", fps: 15, width, height, renderQuality: "final" },
    { mediaRoot, outputPath: join(directory, "busy-final.mp4") });
  assert.equal(result.outputAudit.checks.rendererMatch.status, "pass", JSON.stringify(result.outputAudit.checks.rendererMatch));
  assert.equal(result.outputAudit.facts.framesCompared, 8);
  assert.ok(result.outputAudit.facts.meanRgbError < 3, `mean error ${result.outputAudit.facts.meanRgbError}`);
  // Brightness and change of every decoded frame: testsrc2 moves, so it has no stills.
  assert.equal(result.motion.luma.length, 8);
  assert.equal(result.motion.diff.length, 8);
  assert.deepEqual(result.motion.stills, []);
  // A one-way brightening (100 to 140 at 0.33 s) is listed off a cut, not on the scene's planned change.
  const gray = (level, count) => new Uint8Array(count * 32 * 18 * 3).fill(level);
  const steps = new Uint8Array([...gray(100, 10), ...gray(140, 10)]);
  assert.equal(motionFacts(steps, 20, 30, []).jumps.length, 1);
  assert.deepEqual(motionFacts(steps, 20, 30, [0.33]).jumps, []);
  // Hue of each frame's mean color: red frames then blue frames read near 0 then 240 degrees; gray has none.
  const solid = (r, g, b, count) => Uint8Array.from({ length: count * 32 * 18 * 3 }, (_, index) => [r, g, b][index % 3]);
  const tinted = motionFacts(new Uint8Array([...solid(255, 0, 0, 2), ...solid(0, 0, 255, 2), ...gray(100, 1)]), 5, 30, []);
  assert.deepEqual(tinted.hue, [0, 0, 240, 240, null]);

  // A draft has no frame references and no verdict, only the motion facts, with the cut times it was given.
  const draft = await exportScene(scene, { profile: "mp4.alt", fps: 15, width, height, renderQuality: "draft" },
    { mediaRoot, outputPath: join(directory, "busy-draft.mp4") });
  assert.equal(draft.outputAudit, undefined, "no audit verdict on a draft");
  assert.equal(draft.motion.hue.length, draft.motion.luma.length);
  assert.ok(draft.motion.luma.length > 0 && Array.isArray(draft.motion.cuts), "every frame's brightness and hue, and the cut times");

  // APNG is lossless, so the same render must read back exactly (its limit is 2 levels a pixel).
  const apng = await exportScene(scene, { format: "apng", fps: 15, width, height, renderQuality: "final" },
    { mediaRoot, outputPath: join(directory, "busy-final.apng") });
  assert.equal(apng.outputAudit.ok, true, JSON.stringify(apng.outputAudit.checks.rendererMatch));
  assert.equal(apng.outputAudit.facts.meanRgbError, 0);
});

// Before the APNG thumbnail decode asked FFmpeg for exact colour (full_chroma_inp, accurate_rnd),
// a saturated pixel beside a different colour came back up to 123 levels off, and a correct APNG
// of footage failed rendererMatch on every frame.
test("a lossless APNG of footage reads back exactly and passes the lossless limits", async () => {
  const width = 320, height = 180, frames = 3, frameBytes = width * height * 3;
  for (const source of ["testsrc2", "mandelbrot"]) {
    const rawPath = join(directory, `${source}-lossless.rgb`);
    const outputPath = join(directory, `${source}-lossless.apng`);
    runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `${source}=size=${width}x${height}:rate=30`,
      "-frames:v", String(frames), "-pix_fmt", "rgb24", "-f", "rawvideo", rawPath]);
    runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
      "-video_size", `${width}x${height}`, "-framerate", "30", "-i", rawPath, "-c:v", "apng", "-f", "apng", outputPath]);
    const rgb = await readFile(rawPath);
    const references = Array.from({ length: frames }, (_, index) => frameReference(rgbToRgba(rgb.subarray(index * frameBytes, (index + 1) * frameBytes)), width, height));
    const result = await inspectRenderedOutput(outputPath, { format: "apng", fps: 30, hasAudio: false, references });
    assert.equal(result.checks.rendererMatch.status, "pass", `${source}: ${JSON.stringify(result.checks.rendererMatch)}`);
    assert.equal(result.facts.meanRgbError, 0, source);
  }
});

// A picture that says where each pixel came from: red holds the column and green the row, each
// times 37 (odd, so no two of 256 neighbours share a value, and a pixel one row or column off is
// 37 levels off), and blue holds the bits above 255 and the frame number.
function positionPicture(width, height, frame) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      rgb[offset] = (x * 37) & 255;
      rgb[offset + 1] = (y * 37) & 255;
      rgb[offset + 2] = ((x >> 8) << 5) | ((y >> 8) << 2) | (frame & 3);
    }
  return rgb;
}

// FFmpeg's 32×18 neighbor scale worked in 16-bit fixed point. Where the centre of a thumbnail row
// falls exactly on a pixel edge it took the row above: at 96 px tall rows 7, 23, 39, 55, 71 and 87
// where frameReference takes 8, 24, 40, 56, 72 and 88, so every frame of a correct final APNG at
// 160×96 failed rendererMatch. Measured with FFmpeg 9.0.2: 244 of the heights from 1 to 2,200
// (8, 24, 96, 240, 1024 among them) picked a different row; no width from 1 to 1,000 picked a
// different column. Now FFmpeg keeps the very pixels frameReference takes, at every size.
test("a lossless APNG reads back the exact pixels frameReference takes, at every size", async () => {
  const sizes = [[160, 96], [48, 8], [64, 24], [250, 60], [96, 1024], [333, 333], [1366, 20], [7, 5], [2, 1]];
  for (const [width, height] of sizes) {
    const frames = 2;
    const pictures = Array.from({ length: frames }, (_, frame) => positionPicture(width, height, frame));
    const rawPath = join(directory, `position-${width}x${height}.rgb`);
    const outputPath = join(directory, `position-${width}x${height}.apng`);
    await writeFile(rawPath, Buffer.concat(pictures));
    runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
      "-video_size", `${width}x${height}`, "-framerate", "30", "-i", rawPath, "-c:v", "apng", "-f", "apng", outputPath]);
    const result = await inspectRenderedOutput(outputPath, { format: "apng", fps: 30, hasAudio: false,
      references: pictures.map((rgb) => frameReference(rgbToRgba(rgb), width, height)) });
    const label = `${width}x${height}`;
    assert.equal(result.checks.rendererMatch.status, "pass", `${label}: ${JSON.stringify(result.checks.rendererMatch)}`);
    assert.equal(result.facts.meanRgbError, 0, label);
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.checks)}`);
  }
});

// A scene of bands 16 px tall whose edges are the rows FFmpeg's scale used to miss: a final render
// at 160×96 failed rendererMatch as an APNG and as an MP4 (a third of each thumbnail sampled the
// band above).
test("a final 160×96 render whose edges fall on the thumbnail's rows passes its audit as APNG and MP4", async () => {
  const width = 160, height = 96;
  const bands = [0, 1, 2, 3, 4, 5].map((index) => createLayer("rectangle", { id: `band-${index}`, name: `Band ${index}`,
    x: 0, y: 8 + 16 * index, width, height: 8, fill: ["#f0f0f0", "#e03020", "#20a040", "#2040e0", "#f0c020", "#c020c0"][index] }));
  const scene = createScene({ id: "bands", name: "Bands", width, height, duration: 0.2, background: "#101010", layers: bands });
  for (const options of [{ profile: "mp4.alt" }, { format: "apng" }]) {
    const label = options.format ?? options.profile;
    const outputPath = join(directory, `bands.${options.format === "apng" ? "apng" : "mp4"}`);
    const result = await exportScene(scene, { ...options, fps: 10, width, height, renderQuality: "final" }, { outputPath });
    await rm(outputPath, { force: true });
    assert.equal(result.outputAudit.checks.rendererMatch.status, "pass", `${label}: ${JSON.stringify(result.outputAudit.checks.rendererMatch)}`);
    assert.equal(result.outputAudit.facts.framesCompared, result.outputAudit.facts.referenceFrameCount, label);
    if (options.format === "apng") assert.equal(result.outputAudit.facts.meanRgbError, 0);
  }
});

// Frames in the order a faulty encode might show them. Each list holds source frame numbers.
function shiftedOrders(frames) {
  const k = Math.floor(frames / 3);
  const all = Array.from({ length: frames }, (_, index) => index);
  return {
    correct: all,
    early: [...all.slice(1), frames - 1], // one frame early: the first frame is missing
    late: [0, ...all.slice(0, -1)], // one frame late: the first frame shows twice
    dropped: [...all.slice(0, k), ...all.slice(k + 1), frames - 1], // frame k dropped, the last repeated
    repeated: [...all.slice(0, k + 1), ...all.slice(k, -1)], // frame k repeated, the last cut
  };
}

// The mean limit (10 levels) lets a file one frame early or late pass: on testsrc2 such a file
// scores about 4.4. With heavy grain a correct file scores up to about 5, so the mean limit cannot
// be lowered; the shift check compares each frame with the frames before and after instead.
// 24 frames: the dropped and repeated files slip at frame 8, leaving a run of 15 (the check needs 8).
test("a file one frame early or late, or that drops or repeats a frame, fails rendererMatch; the correct file passes", async () => {
  const width = 160, height = 90, frames = 24, frameBytes = width * height * 3;
  for (const [source, filter] of [["testsrc2", "format=yuv420p"], ["grain", "noise=alls=20:allf=t+u,format=yuv420p"]]) {
    const rawPath = join(directory, `${source}-frames.rgb`);
    runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30`,
      "-frames:v", String(frames), "-vf", `${filter},format=rgb24`, "-pix_fmt", "rgb24", "-f", "rawvideo", rawPath]);
    const rgb = await readFile(rawPath);
    const picture = (index) => rgb.subarray(index * frameBytes, (index + 1) * frameBytes);
    const references = Array.from({ length: frames }, (_, index) => frameReference(rgbToRgba(picture(index)), width, height));

    const results = {};
    for (const [name, order] of Object.entries(shiftedOrders(frames))) {
      const orderPath = join(directory, `${source}-${name}.rgb`);
      const outputPath = join(directory, `${source}-${name}.mp4`);
      await writeFile(orderPath, Buffer.concat(order.map(picture)));
      runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
        "-video_size", `${width}x${height}`, "-framerate", "30", "-i", orderPath,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-an", outputPath]);
      results[name] = await inspectRenderedOutput(outputPath, { format: "mp4", fps: 30, hasAudio: false, references });
    }

    const { correct, early, late, dropped, repeated } = results;
    assert.equal(correct.ok, true, `${source}: ${JSON.stringify(correct.checks)}`);
    assert.equal(correct.facts.closerToPreviousCount + correct.facts.closerToNextCount, 0, source);
    assert.equal(correct.facts.longestShiftRun, null, source);
    for (const [name, result] of Object.entries({ early, late, dropped, repeated })) {
      assert.equal(result.checks.decodedFrameCount.status, "pass", `${source} ${name}: same number of frames`);
      // Shifted heavy grain is near the mean limit (about 10); shifted testsrc2 is well inside it.
      if (source === "testsrc2")
        assert.equal(result.facts.mismatchCount, 0, `${source} ${name}: inside the mean and pixel limits (mean ${result.facts.meanRgbError})`);
      assert.equal(result.checks.rendererMatch.status, "fail", `${source} ${name}: ${JSON.stringify(result.checks.rendererMatch)}`);
    }
    const slip = Math.floor(frames / 3);
    const run = (result) => {
      const { direction, start, end, frames: count } = result.facts.longestShiftRun;
      return { direction, start, end, frames: count };
    };
    assert.deepEqual(run(early), { direction: "next", start: 0, end: frames - 2, frames: frames - 1 }, `${source}: every frame but the last looks like the next one`);
    assert.deepEqual(run(late), { direction: "previous", start: 1, end: frames - 1, frames: frames - 1 }, `${source}: every frame but the first looks like the one before`);
    assert.deepEqual(run(dropped), { direction: "next", start: slip, end: frames - 2, frames: frames - 1 - slip }, `${source}: the slip is found where the frame was dropped`);
    assert.deepEqual(run(repeated), { direction: "previous", start: slip + 1, end: frames - 1, frames: frames - 1 - slip }, `${source}: the slip is found after the repeated frame`);
    assert.match(early.checks.rendererMatch.detail, /From frame 0 \(0 s\) to frame 22 \(0\.733 s\), 23 decoded frames look like the renderer frame just after their own: the file runs a frame early there, as if a frame was dropped\. This is a fault in encoding the file, not in your scene\. Render again; if it fails again, report it/);
    assert.match(late.checks.rendererMatch.detail, /From frame 1 \(0\.033 s\) to frame 23 \(0\.767 s\), 23 decoded frames look like the renderer frame just before their own: the file runs a frame late there, as if a frame was repeated\./);
    // A hardware encoder or "small" quality may drop detail: the sentence says so and what to change.
    const latePath = join(directory, `${source}-late.mp4`);
    const detail = async (videoEncoder) =>
      (await inspectRenderedOutput(latePath, { format: "mp4", fps: 30, hasAudio: false, references, videoEncoder })).checks.rendererMatch.detail;
    assert.match(await detail({ family: "videotoolbox", ffmpegEncoder: "h264_videotoolbox", quality: "standard" }),
      /as if a frame was repeated\. The video encoder \(h264_videotoolbox, standard quality\) may have dropped detail there, so frames look like their neighbours\. Render again with videoQuality "high", or with videoEncoder "software"\.$/);
    assert.match(await detail({ family: "software", ffmpegEncoder: "libx264", quality: "small" }),
      /The video encoder \(libx264, small quality\) may have dropped detail there, so frames look like their neighbours\. Render again with videoQuality "standard" or "high"\.$/);
    assert.match(await detail({ family: "nvenc", ffmpegEncoder: "h264_nvenc", quality: "high" }), /Render again with videoEncoder "software"\.$/);
    assert.match(await detail({ family: "software", ffmpegEncoder: "libx264", quality: "standard" }), /This is a fault in encoding the file, not in your scene\./);
  }
});

// Flat grey frames stored losslessly (APNG), so the test sets every decoded value, checked with
// an mp4's limits. The renderer frames step 2 levels a frame; a decoded frame 2 levels up equals
// the next renderer frame and one 2 levels down equals the previous one, both well inside the
// mean limit. Only a run of 8 or more frames that look like the same neighbour fails.
test("rendererMatch fails only when 8 frames in a row look like the same neighbour; holds do not end a run", async () => {
  const grey = (level) => [level, level, level];
  const steps = Array.from({ length: 20 }, (_, index) => 40 + 2 * index);
  const audit = async (name, rendered, decoded) => {
    const file = await encodeApng(name, decoded.map(grey));
    return inspectRenderedOutput(file, { format: "mp4", fps: 10, hasAudio: false, references: references(rendered.map(grey)) });
  };

  // Rounding in a slow fade: frames look like a neighbour one at a time, in both directions.
  const scattered = await audit("scattered", steps, steps.map((level, index) => level + (index % 2 ? -2 : 2)));
  assert.equal(scattered.checks.rendererMatch.status, "pass", JSON.stringify(scattered.checks.rendererMatch));
  assert.equal(scattered.facts.closerToNextCount + scattered.facts.closerToPreviousCount, 20, "every frame looks like a neighbour");
  assert.equal(scattered.facts.longestShiftRun.frames, 1);

  // Seven frames like the next one, a frame that matches its own, then seven more: no run of 8.
  const broken = await audit("broken", steps, steps.map((level, index) => level + (index === 7 || index > 14 ? 0 : 2)));
  assert.equal(broken.checks.rendererMatch.status, "pass", JSON.stringify(broken.checks.rendererMatch));
  assert.equal(broken.facts.longestShiftRun.frames, 7);

  // Eight frames in a row like the next one: the file runs a frame early from frame 0 to 7.
  const eight = await audit("eight", steps, steps.map((level, index) => level + (index < 8 ? 2 : 0)));
  assert.equal(eight.checks.rendererMatch.status, "fail");
  assert.match(eight.checks.rendererMatch.detail, /^From frame 0 \(0 s\) to frame 7 \(0\.7 s\), 8 decoded frames look like the renderer frame just after their own: the file runs a frame early there/);
  assert.equal(eight.checks.rendererMatch.actual.framesInARowLikeANeighbour, 8);

  // A file one frame late over a hold (renderer frames 5 to 7 are the same picture). Frames 6
  // and 7 cannot show the shift, so they neither extend nor end the run: 5 + 7 = 12 frames.
  const held = [40, 42, 44, 46, 48, 50, 50, 50, 52, 54, 56, 58, 60, 62, 64];
  const late = await audit("late-over-hold", held, [held[0], ...held.slice(0, -1)]);
  assert.equal(late.checks.rendererMatch.status, "fail");
  assert.deepEqual(late.facts.closerToNeighbourFrames, [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14]);
  assert.match(late.checks.rendererMatch.detail, /^From frame 1 \(0\.1 s\) to frame 14 \(1\.4 s\), 12 decoded frames look like the renderer frame just before their own: the file runs a frame late there, as if a frame was repeated\./);
});

// The other side of the shift check: on a flat colour that changes by 1 or 2 levels a frame,
// 8-bit colour rounding leaves single decoded frames nearer the frame before or after. With a
// rule of "2 such frames anywhere" these correct renders failed (measured on a Mac with
// FFmpeg 9.0.2: the white fade had 36 such frames, the blue fades 2 to 13); none has a run of 8.
test("correct final renders of slow fades pass rendererMatch", async () => {
  const width = 640, height = 360;
  const fade = (color, seconds) => createScene({ id: "fade", name: "Fade", width, height, duration: seconds, background: "#000000",
    layers: [createLayer("rectangle", { id: "fill", name: "Fill", x: 0, y: 0, width, height, fill: color, opacity: 0,
      animations: [{ id: "in", name: "Fade in", kind: "custom", start: 0, duration: seconds, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } }] })] });
  for (const [label, scene, options] of [
    ["10 s white fade, default mp4", fade("#ffffff", 10), { format: "mp4" }],
    ["4 s #3060c0 fade, mp4.alt", fade("#3060c0", 4), { profile: "mp4.alt" }],
    ["4 s #3060c0 fade, webm", fade("#3060c0", 4), { format: "webm" }],
  ]) {
    const outputPath = join(directory, `slow-fade.${options.format === "webm" ? "webm" : "mp4"}`);
    const result = await exportScene(scene, { ...options, fps: 30, renderQuality: "final", motionBlur: 0.5, dither: true }, { outputPath });
    await rm(outputPath, { force: true });
    assert.equal(result.outputAudit.ok, true, `${label}: ${JSON.stringify(result.outputAudit.checks.rendererMatch)}`);
    assert.ok((result.outputAudit.facts.longestShiftRun?.frames ?? 0) < 8, label);
  }
});

test("a final render whose encode shows every frame one frame late fails its audit", async () => {
  const width = 160, height = 90, duration = 0.5;
  const mediaRoot = join(directory, "late-media");
  await mkdir(mediaRoot);
  runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=${duration}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(mediaRoot, "busy.mp4")]);
  // A stand-in for FFmpeg: kino's encode (PNG frames on stdin, read as image2pipe) shows the
  // first frame twice and so every frame one frame late; every other call, the audit's decode
  // (which writes image2pipe) among them, runs the real FFmpeg unchanged.
  const lateFfmpeg = join(directory, "late-ffmpeg.mjs");
  await writeFile(lateFfmpeg, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.slice(0, args.indexOf("-i")).includes("image2pipe")) args.splice(args.length - 1, 0, "-vf", "tpad=start_mode=clone:start=1");
const result = spawnSync(${JSON.stringify(FFMPEG)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  await chmod(lateFfmpeg, 0o700);
  const video = { id: "busy", name: "busy", type: "video", parentId: null, x: 0, y: 0, width, height, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, visible: true, locked: false, src: "/api/media/busy.mp4", mediaDuration: duration, animations: [] };
  const scene = { id: "late-video", name: "Late video", width, height, duration, background: "#000000", layers: [video] };
  const priorPath = process.env.KINO_FFMPEG;
  process.env.KINO_FFMPEG = lateFfmpeg;
  try {
    await assert.rejects(exportScene(scene, { profile: "mp4.alt", fps: 30, width, height, renderQuality: "final" },
      { mediaRoot, outputPath: join(directory, "late-final.mp4") }), (error) => {
      // Only the shift check fails: every frame is inside the mean and pixel limits.
      assert.match(error.message, /^Rendered file differs from its intended frames: rendererMatch\. From frame 1 \(0\.033 s\) to frame 14 \(0\.467 s\), 14 decoded frames look like the renderer frame just before their own: the file runs a frame late there, as if a frame was repeated\. This is a fault in encoding the file, not in your scene\. Render again; if it fails again, report it with this message and the scene\.$/);
      return true;
    });
  } finally {
    if (priorPath === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = priorPath;
  }
});

test("audio inspection measures real PCM audio and treats full-scale peaks as a warning", async () => {
  const rawPath = join(directory, "audio-fixture.rgb");
  const outputPath = join(directory, "full-scale-audio.mov");
  const colors = [[30, 80, 160], [30, 80, 160], [30, 80, 160], [30, 80, 160]];
  await writeFile(rawPath, Buffer.concat(colors.map(rgbFrame)));
  runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${WIDTH}x${HEIGHT}`,
    "-framerate", "10", "-i", rawPath,
    "-f", "lavfi", "-i", "aevalsrc=1:s=48000:d=0.4",
    "-frames:v", "4", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "pcm_s16le", "-shortest", outputPath,
  ]);
  const result = await inspectRenderedOutput(outputPath, { format: "mov", fps: 10, references: references(colors), hasAudio: true });
  assert.ok(result.facts.audio);
  assert.equal(result.checks.audioLoudness.status, "pass");
  assert.equal(result.checks.audioClipping.status, "warn");
  assert.ok(result.warnings.some((warning) => /does not prove clipping/i.test(warning)));
  assert.match(result.facts.method, /EBU R128\/astats/);
});

test("loudness and peak checks each fail when their own measurement is missing", async () => {
  const fixture = join(directory, "partial-audio-stats.mov");
  const fakeFfmpeg = join(directory, "partial-stats-ffmpeg.mjs");
  await writeFile(fixture, "fixture");
  await writeFile(fakeFfmpeg, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("-af")) {
  const mode = process.env.KINO_AUDIT_FAKE_MODE;
  if (mode === "loudness-only") process.stderr.write("\\nIntegrated loudness:\\nI: -23.0 LUFS\\n");
  else if (mode === "peak-only") process.stderr.write("\\n[Parsed_astats_0] Peak level dB: -6.0\\n");
} else {
  // One frame as the audit's decode writes it: a PPM strip of the 18 thumbnail rows.
  process.stdout.write(Buffer.concat([Buffer.from("P6\\n32 18\\n255\\n"), Buffer.alloc(${32 * 18 * 3}, 80)]));
}
`);
  await chmod(fakeFfmpeg, 0o700);
  const priorPath = process.env.KINO_FFMPEG;
  const priorOpenPath = process.env.OPEN_MOTION_FFMPEG;
  const priorMode = process.env.KINO_AUDIT_FAKE_MODE;
  process.env.KINO_FFMPEG = fakeFfmpeg;
  delete process.env.OPEN_MOTION_FFMPEG;
  try {
    process.env.KINO_AUDIT_FAKE_MODE = "loudness-only";
    const missingPeak = await inspectRenderedOutput(fixture, {
      format: "mov", fps: 10, references: references([[80, 80, 80]]), hasAudio: true,
    });
    assert.equal(missingPeak.checks.audioLoudness.status, "pass");
    assert.equal(missingPeak.checks.audioClipping.status, "fail");
    assert.equal(missingPeak.checks.audioClipping.actual, null);

    process.env.KINO_AUDIT_FAKE_MODE = "peak-only";
    const missingLoudness = await inspectRenderedOutput(fixture, {
      format: "mov", fps: 10, references: references([[80, 80, 80]]), hasAudio: true,
    });
    assert.equal(missingLoudness.checks.audioLoudness.status, "fail");
    assert.equal(missingLoudness.checks.audioClipping.status, "pass");
    assert.equal(missingLoudness.checks.audioLoudness.actual, null);
  } finally {
    if (priorPath === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = priorPath;
    if (priorOpenPath === undefined) delete process.env.OPEN_MOTION_FFMPEG;
    else process.env.OPEN_MOTION_FFMPEG = priorOpenPath;
    if (priorMode === undefined) delete process.env.KINO_AUDIT_FAKE_MODE;
    else process.env.KINO_AUDIT_FAKE_MODE = priorMode;
  }
});

test("aborting a stalled decode reaps the FFmpeg child", async () => {
  const fixture = join(directory, "abort-input.png");
  const fakeFfmpeg = join(directory, "stalled-ffmpeg.mjs");
  const pidPath = join(directory, "stalled-ffmpeg.pid");
  await writeFile(fixture, "fixture");
  await writeFile(fakeFfmpeg, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nprocess.stdout.write(Buffer.concat([Buffer.from('P6\\n32 18\\n255\\n'), Buffer.alloc(${32 * 18 * 3}, 20)]));\nsetInterval(() => {}, 1000);\n`);
  await chmod(fakeFfmpeg, 0o700);

  const priorPath = process.env.KINO_FFMPEG;
  const priorOpenPath = process.env.OPEN_MOTION_FFMPEG;
  process.env.KINO_FFMPEG = fakeFfmpeg;
  delete process.env.OPEN_MOTION_FFMPEG;
  const controller = new AbortController();
  try {
    const inspection = inspectRenderedOutput(fixture, { format: "apng", fps: 1, references: [references([[20, 20, 20]])[0]], hasAudio: false }, { signal: controller.signal });
    let pid;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { pid = Number(await readFile(pidPath, "utf8")); break; }
      catch { await delay(10); }
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "stalled FFmpeg fixture started");
    controller.abort();
    await assert.rejects(inspection, (error) => error.name === "AbortError");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (priorPath === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = priorPath;
    if (priorOpenPath === undefined) delete process.env.OPEN_MOTION_FFMPEG;
    else process.env.OPEN_MOTION_FFMPEG = priorOpenPath;
  }
});

test("GIF reports its frame-coalescing limitation without running FFmpeg", async () => {
  const path = join(directory, "unsupported.gif");
  await writeFile(path, "gif fixture");
  const result = await inspectRenderedOutput(path, { format: "gif", fps: 10, references: references([[10, 20, 30]]), hasAudio: false });
  assert.equal(result.ok, true);
  assert.equal(result.checks.contentAudit.status, "unsupported");
  assert.match(result.warnings[0], /coalescing/i);
});
