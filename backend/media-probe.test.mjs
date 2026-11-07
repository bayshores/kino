import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGif } from "../engine/gifDecode.js";
import {
  decodeGifFrames,
  probeGifTimeline,
  probeMedia,
  runMediaTool,
  videoGridArgs,
  videoGridCount,
  writeGifFrames,
} from "./media-probe.mjs";
import {
  ffmpeg,
  makeAnimatedGif,
  makeToneAfterSilence,
  makeVideo,
  readImage,
  run,
  skipWithoutMediaTools,
} from "./media.test.support.mjs";

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-media-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("probeMedia reports GIF delays and frame counts, video and audio durations, and still images", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const root = await folder(t);
  const animated = join(root, "delays.gif");
  await writeFile(animated, makeAnimatedGif({
    width: 8,
    height: 6,
    frames: [0, 1, 2, 5, 7].map((delayCs, index) => ({ delayCs, color: [RED, GREEN, BLUE, RED, GREEN][index] })),
  }));
  assert.deepEqual((await probeGifTimeline(animated)).durations, [0.1, 0.1, 0.02, 0.05, 0.07]);
  assert.deepEqual(await probeMedia(animated), {
    duration: 0.34, width: 8, height: 6, hasVideo: true, hasAudio: false, frameCount: 5, animated: true,
  });

  const single = join(root, "single.gif");
  await writeFile(single, makeAnimatedGif({ width: 4, height: 4, loop: null, frames: [{ delayCs: 0, color: RED }] }));
  const singleInfo = await probeMedia(single);
  assert.equal(singleInfo.frameCount, 1);
  assert.equal(singleInfo.animated, false, "a one-frame GIF is a still image");

  const video = await makeVideo(join(root, "clip.mp4"), { width: 32, height: 24, fps: 30, frames: 45, frameColor: () => RED });
  const videoInfo = await probeMedia(video);
  assert.ok(Math.abs(videoInfo.duration - 1.5) < 0.01, `video duration is 1.5 s: ${videoInfo.duration}`);
  assert.deepEqual([videoInfo.width, videoInfo.height, videoInfo.hasVideo, videoInfo.hasAudio], [32, 24, true, false]);
  assert.equal(videoInfo.frameCount, undefined, "frame counts are only reported for GIFs");

  const rotated = join(root, "rotated.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-display_rotation:v:0", "90", "-i", video, "-c", "copy", rotated]);
  const rotatedInfo = await probeMedia(rotated);
  assert.deepEqual([rotatedInfo.width, rotatedInfo.height], [24, 32], "a rotated video reports its upright size");

  const audio = await makeToneAfterSilence(join(root, "tone.wav"), { silence: 0.25, tone: 1 });
  const audioInfo = await probeMedia(audio);
  assert.ok(Math.abs(audioInfo.duration - 1.25) < 0.01, `audio duration is 1.25 s: ${audioInfo.duration}`);
  assert.deepEqual([audioInfo.hasVideo, audioInfo.hasAudio, audioInfo.width, audioInfo.height], [false, true, 0, 0]);

  const png = join(root, "still.png");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=40x20", "-frames:v", "1", png]);
  assert.deepEqual(await probeMedia(png), { duration: 0, width: 40, height: 20, hasVideo: true, hasAudio: false });
});

// GIF frames are decoded by kino's own decoder (engine/gifDecode.js), so these tests need no FFmpeg.
test("decodeGifFrames writes one complete RGBA picture per frame, with transparency and disposal applied", async (t) => {
  const root = await folder(t);
  const gif = join(root, "frames.gif");
  const halfClear = Array.from({ length: 4 * 2 }, (_, index) => (index % 4 < 2 ? BLUE : null));
  await writeFile(gif, makeAnimatedGif({
    width: 4,
    height: 2,
    frames: [
      { delayCs: 10, color: RED },
      { delayCs: 20, pixels: halfClear },
      { delayCs: 30, color: null },
      { delayCs: 5, color: GREEN },
    ],
  }));
  const output = join(root, "frames");
  await mkdir(output);
  const timeline = await decodeGifFrames(gif, output);
  assert.deepEqual(timeline.durations, [0.1, 0.2, 0.3, 0.05]);
  assert.deepEqual((await readdir(output)).sort(), ["000000.png", "000001.png", "000002.png", "000003.png"]);
  const pictures = await Promise.all([0, 1, 2, 3].map(async (index) => readImage(await readFile(join(output, `00000${index}.png`)))));
  assert.deepEqual(pictures.map(({ width, height }) => [width, height]), Array(4).fill([4, 2]), "every frame is full canvas size");
  assert.deepEqual(pictures[0].pixel(3, 1), [255, 0, 0, 255]);
  assert.deepEqual(pictures[1].pixel(0, 0), [0, 0, 255, 255]);
  assert.equal(pictures[1].pixel(3, 0)[3], 0, "the clear half of frame 1 does not keep frame 0's red (disposal 2)");
  assert.equal(pictures[2].pixel(1, 1)[3], 0, "a fully transparent frame stays transparent");
  assert.deepEqual(pictures[3].pixel(2, 1), [0, 255, 0, 255]);
});

test("decodeGifFrames composes partial frames and disposal like browsers do", async (t) => {
  const root = await folder(t);
  const gif = join(root, "partial.gif");
  // A 4 x 2 canvas. Frame 0 paints only the left half; frame 1 (no transparent color) paints the
  // right half and is cleared by disposal 2; frame 2 paints one pixel at (3, 1).
  await writeFile(gif, makeAnimatedGif({
    width: 4,
    height: 2,
    frames: [
      { delayCs: 10, color: RED, rect: { left: 0, top: 0, width: 2, height: 2 }, disposal: 1 },
      { delayCs: 10, color: BLUE, rect: { left: 2, top: 0, width: 2, height: 2 }, disposal: 2, transparent: false },
      { delayCs: 10, color: GREEN, rect: { left: 3, top: 1, width: 1, height: 1 }, disposal: 1 },
    ],
  }));
  const output = join(root, "frames");
  await mkdir(output);
  assert.deepEqual((await decodeGifFrames(gif, output)).durations, [0.1, 0.1, 0.1]);
  const [first, second, third] = await Promise.all([0, 1, 2].map(async (index) => readImage(await readFile(join(output, `00000${index}.png`)))));
  assert.deepEqual(first.pixel(0, 0), [...RED, 255]);
  assert.equal(first.pixel(3, 0)[3], 0, "the part of the canvas frame 0 does not cover starts transparent, not black or background");
  assert.deepEqual(second.pixel(0, 1), [...RED, 255], "disposal 1 keeps frame 0 under frame 1");
  assert.deepEqual(second.pixel(3, 0), [...BLUE, 255]);
  assert.deepEqual(third.pixel(0, 0), [...RED, 255]);
  assert.equal(third.pixel(2, 0)[3], 0, "disposal 2 clears frame 1 to transparent even though it has no transparent color");
  assert.deepEqual(third.pixel(3, 1), [...GREEN, 255]);
});

test("a GIF over the decode budget is refused before any frame is decoded", async (t) => {
  const root = await folder(t);
  const gif = join(root, "huge.gif");
  // 4000 x 4000 x 63 frames is more than 1,000,000,000 pixels, though the file stores only 63 pixels.
  await writeFile(gif, makeAnimatedGif({
    width: 4000,
    height: 4000,
    frames: Array.from({ length: 63 }, () => ({ delayCs: 10, color: RED, rect: { left: 0, top: 0, width: 1, height: 1 } })),
  }));
  const output = join(root, "frames");
  await mkdir(output);
  await assert.rejects(decodeGifFrames(gif, output), { code: "GIF_TOO_LARGE" });
  assert.deepEqual(await readdir(output), [], "no frame was written");
  await assert.rejects(probeGifTimeline(gif), { code: "GIF_TOO_LARGE" });
});

test("writing GIF frames stops with GIF_TOO_LARGE once the PNG files would pass maxBytes", async (t) => {
  const root = await folder(t);
  const gif = parseGif(makeAnimatedGif({ width: 6, height: 4, frames: [RED, GREEN, BLUE].map((color) => ({ delayCs: 10, color })) }));
  const everything = join(root, "everything");
  await mkdir(everything);
  const total = await writeGifFrames(gif, everything);
  const sizes = await Promise.all((await readdir(everything)).sort().map(async (name) => (await readFile(join(everything, name))).length));
  assert.equal(total, sizes[0] + sizes[1] + sizes[2], "the number returned is the bytes written");
  assert.equal(await writeGifFrames(gif, join(root, "everything"), { maxBytes: total }), total, "exactly the budget fits");

  const limited = join(root, "limited");
  await mkdir(limited);
  await assert.rejects(writeGifFrames(gif, limited, { maxBytes: sizes[0] + sizes[1] }), {
    code: "GIF_TOO_LARGE",
    message: `This GIF's decoded frames need more than ${(sizes[0] + sizes[1]).toLocaleString("en-US")} bytes of disk space.`,
  });
  assert.deepEqual((await readdir(limited)).sort(), ["000000.png", "000001.png"], "the frame past the budget was not written");
});

test("a missing ffprobe reports how to install or configure it", async (t) => {
  const previous = process.env.KINO_FFPROBE;
  process.env.KINO_FFPROBE = join(tmpdir(), "kino-missing-ffprobe-for-test");
  t.after(() => {
    if (previous === undefined) delete process.env.KINO_FFPROBE;
    else process.env.KINO_FFPROBE = previous;
  });
  await assert.rejects(probeMedia(join(tmpdir(), "anything.mp4")),
    /ffprobe executable “kino-missing-ffprobe-for-test” was not found\. Install FFmpeg with ffprobe, or configure KINO_FFMPEG and KINO_FFPROBE\./);
});

// A stand-in ffprobe: a shell script that counts its runs in `count` and answers after `sleep` s.
async function fakeProbe(t, root, sleep) {
  const script = join(root, "fake-ffprobe.sh");
  const count = join(root, "runs.txt");
  // A stuck one replaces itself with sleep (exec), so stopping it stops the sleep too.
  await writeFile(script, `#!/bin/sh\necho run >> "${count}"\n${sleep >= 10 ? "exec " : ""}sleep ${sleep}\necho '{"streams":[{"codec_type":"audio","duration":"2"}],"format":{"format_name":"wav","duration":"2"}}'\n`, { mode: 0o755 });
  const previous = process.env.KINO_FFPROBE;
  process.env.KINO_FFPROBE = script;
  t.after(() => {
    if (previous === undefined) delete process.env.KINO_FFPROBE;
    else process.env.KINO_FFPROBE = previous;
  });
  return async () => (await readFile(count, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
}

test("probes of one file asked for at once share one ffprobe run", { skip: process.platform === "win32" }, async (t) => {
  const root = await folder(t);
  const runs = await fakeProbe(t, root, 0.2);
  const file = join(root, "sound.wav");
  await writeFile(file, "not really a sound");
  const answers = await Promise.all(Array.from({ length: 6 }, () => probeMedia(file)));
  assert.equal(await runs(), 1);
  for (const answer of answers) assert.equal(answer.duration, 2);
});

test("a stuck ffprobe is stopped after its time limit", { skip: process.platform === "win32" }, async (t) => {
  const root = await folder(t);
  await fakeProbe(t, root, 30);
  const started = Date.now();
  await assert.rejects(runMediaTool("ffprobe", ["x"], { timeoutMs: 200 }), /took longer than/);
  assert.ok(Date.now() - started < 5000);
});

// Frame N of the test video has gray level 4N, so a decoded picture tells which frame it came from.
function frameNumber(picture) {
  return Math.round(picture.pixel(4, 4)[0] / 4);
}

// The frame a viewer sees at `time`: the latest frame starting at or before it (1 ms tolerance).
function expectedFrame(time, sourceFps, frameCount) {
  return Math.min(frameCount - 1, Math.floor((time + 0.001) * sourceFps + 1e-9));
}

test("video grid sampling picks the latest frame at or before each sample time, through and past the end", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const root = await folder(t);
  const sources = [
    { name: "gray.mp4", format: "mp4" },
    { name: "gray.webm", format: "webm" },
  ];
  const results = [];
  for (const { name, format } of sources) {
    // 30 fps for 2 s with long keyframe spacing, so seeking has to decode from an earlier keyframe.
    const input = await makeVideo(join(root, name), {
      width: 16, height: 12, fps: 30, frames: 60, format, frameColor: (n) => [n * 4, n * 4, n * 4],
    });
    const cases = [
      { firstTime: 0, lastTime: 1, fps: 24 },
      { firstTime: 0.3, lastTime: 0.3, fps: 30 },
      { firstTime: 0.95, lastTime: 1.2, fps: 30 },
      { firstTime: 1.234, lastTime: 1.9, fps: 60 },
      { firstTime: 1.8, lastTime: 2, fps: 24 },
      { firstTime: 2, lastTime: 2, fps: 30 },
    ];
    for (const [index, { firstTime, lastTime, fps }] of cases.entries()) {
      const output = join(root, `${format}-${index}`);
      await mkdir(output);
      const count = videoGridCount(firstTime, lastTime, fps);
      await run(ffmpeg, videoGridArgs({ input, output: join(output, "%06d.png"), firstTime, fps, count, outputArgs: ["-start_number", "0"] }));
      const files = (await readdir(output)).sort();
      assert.equal(files.length, count, `${name} ${firstTime}-${lastTime} s at ${fps} fps writes ${count} pictures`);
      const actual = [];
      for (const file of files) actual.push(frameNumber(await readImage(await readFile(join(output, file)))));
      const expected = files.map((_, k) => expectedFrame(firstTime + k / fps, 30, 60));
      assert.deepEqual(actual, expected, `${name} samples from ${firstTime} s at ${fps} fps`);
      results.push(`${name}@${firstTime}s/${fps}fps:${count} ok`);
    }
  }
  t.diagnostic(results.join(", "));
});
