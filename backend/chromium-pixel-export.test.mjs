// A movie of a scene that Chromium draws goes to FFmpeg as raw RGBA pixels (export.mjs rawFrames),
// while a still, a PNG sequence and a gifski GIF keep Chromium's PNG files. All must show the same picture.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportFrameTimes } from "../engine/exportOptions.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { rasterFrameCounts } from "./chromium-raster.mjs";
import { exportScene } from "./export.mjs";
import { ffmpeg, ffprobe, run, skipWithoutMediaTools } from "./media.test.support.mjs";
import { renderFrameCache } from "./render-frame-cache.mjs";

const WIDTH = 96, HEIGHT = 64, FPS = 10, DURATION = 0.2;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

// Fog (soft, translucent, a little different every frame) under a dot on the add blend.
function fogScene({ background = "#203040", backgroundEnabled = true } = {}) {
  const fog = createLayer("rectangle", { id: "fog", name: "Fog", x: 0, y: 0, width: WIDTH, height: HEIGHT, fillEnabled: false, strokeWidth: 0 });
  fog.animations = [{ id: "fog-effect", name: "fog", kind: "effect", effect: "fog", start: 0, duration: DURATION, easing: "linear",
    from: { count: 12 }, to: { count: 12 } }];
  const dot = createLayer("ellipse", { id: "dot", name: "Dot", x: 20, y: 16, width: 32, height: 32, fill: "#ff8040", strokeWidth: 0, blendMode: "add" });
  return parseDocument(createDocument({ id: "fog-pixels", name: "Fog pixels",
    scenes: [createScene({ id: "main", name: "Main", width: WIDTH, height: HEIGHT, duration: DURATION, background, backgroundEnabled, layers: [fog, dot] })] })).scenes[0];
}

// FFmpeg and ffprobe get each file as a path: the Linux builds cannot read an APNG or a GIF from a
// pipe ("pipe:0: Function not implemented").
async function withFile(bytes, read) {
  const directory = await mkdtemp(join(tmpdir(), "kino-chromium-pixels-"));
  try {
    const file = join(directory, "input");
    await writeFile(file, bytes);
    return await read(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The first `frames` pictures of an image or movie file, as RGBA bytes.
async function rgba(bytes, frames = 1) {
  return withFile(bytes, (file) => run(ffmpeg, ["-v", "error", "-i", file, "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]));
}

async function probe(bytes, entries) {
  return String(await withFile(bytes, (file) => run(ffprobe, ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", file]))).trim();
}

// The largest difference of any channel, and how many channels differ at all.
function compare(movie, still) {
  let largest = 0, differing = 0;
  for (let index = 0; index < still.length; index += 1) {
    const difference = Math.abs(movie[index] - still[index]);
    if (difference) differing += 1;
    largest = Math.max(largest, difference);
  }
  return { largest, differing };
}

// Each frame (RGBA bytes) must equal the PNG still of its time made with the same options.
// Returns how many pixels of the stills are neither opaque nor fully transparent.
async function assertFramesMatchStills(scene, options, frames, times, { exact = true } = {}) {
  assert.equal(frames.length, times.length * FRAME_BYTES);
  let translucent = 0;
  for (const [index, time] of times.entries()) {
    const still = await rgba((await exportScene(scene, { ...options, format: "png", time })).buffer);
    const frame = frames.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
    for (let offset = 3; offset < still.length; offset += 4) if (still[offset] > 0 && still[offset] < 255) translucent += 1;
    const { largest, differing } = compare(frame, still);
    // Every pixel is the same. export.mjs straightAlpha undoes the premultiplication as Chromium's
    // PNG encoder does, checked at every colour and alpha on a Mac; elsewhere allow one level.
    if (!exact) assert.ok(largest <= 1, `frame ${index}: a channel differs by ${largest}`);
    else assert.deepEqual({ largest, differing }, { largest: 0, differing: 0 }, `frame ${index}`);
  }
  return translucent;
}

// `pixelFormat` is what the APNG must be: RGB when every frame is opaque (smaller and faster to
// write), RGBA whenever a pixel may be see-through, as it is in Chromium's PNG stills.
const CASES = [
  { name: "movie", options: {}, pixelFormat: "rgb24" },
  { name: "transparent movie", options: { transparent: true }, pixelFormat: "rgba" },
  // The scene's own background is see-through and transparent is not asked for: the movie must keep
  // the alpha its stills have (agents set background "#00000000" for this).
  { name: "movie on a see-through background", scene: { background: "#00000000" }, options: {}, pixelFormat: "rgba" },
  { name: "movie with its background turned off", scene: { backgroundEnabled: false }, options: {}, pixelFormat: "rgba" },
  // Final quality turns on motion blur and dither, which kino blends before FFmpeg gets the frame.
  { name: "final-quality movie", options: { motionBlur: 0.5, dither: true }, pixelFormat: "rgb24" },
  { name: "final-quality transparent movie", options: { transparent: true, motionBlur: 0.5, dither: true }, pixelFormat: "rgba" },
];

for (const { name, scene: look, options: extra, pixelFormat: expected } of CASES) {
  test(`a Chromium-drawn ${name} shows the pixels of Chromium's PNG stills`, { skip: skipWithoutMediaTools }, async () => {
    const scene = fogScene(look);
    const options = { fps: FPS, ...extra };
    // APNG is lossless, so its frames are exactly what FFmpeg was given.
    const times = exportFrameTimes(DURATION, FPS, { format: "apng" });
    const movieFile = (await exportScene(scene, { ...options, format: "apng" })).buffer;
    assert.equal(await probe(movieFile, "stream=pix_fmt"), expected);
    const seeThrough = expected === "rgba";
    const translucent = await assertFramesMatchStills(scene, options, await rgba(movieFile, times.length), times,
      { exact: !seeThrough || process.platform === "darwin" });
    if (seeThrough) assert.ok(translucent > 1000, `the fog has translucent pixels to compare (${translucent})`);
    else assert.equal(translucent, 0);
  });
}

test("a Chromium-drawn movie takes Chromium's raw pixels, not PNG files", { skip: skipWithoutMediaTools }, async () => {
  // Frames already drawn come from the frame cache without asking Chromium, so start empty.
  renderFrameCache.clear();
  const before = { ...rasterFrameCounts };
  const times = exportFrameTimes(DURATION, FPS, { format: "mp4" });
  await exportScene(fogScene(), { fps: FPS, format: "mp4" });
  assert.deepEqual({ png: rasterFrameCounts.png - before.png, pixels: rasterFrameCounts.pixels - before.pixels },
    { png: 0, pixels: times.length });
});

test("a PNG sequence and a gifski GIF of a Chromium-drawn scene keep Chromium's PNG files", { skip: skipWithoutMediaTools }, async (t) => {
  const scene = fogScene({ background: "#00000000" });
  const options = { fps: FPS };
  const directory = await mkdtemp(join(tmpdir(), "kino-chromium-sequence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sequenceDirectory = join(directory, "sequence");
  await mkdir(sequenceDirectory);
  const times = exportFrameTimes(DURATION, FPS, { format: "png-sequence" });
  await exportScene(scene, { ...options, format: "png-sequence" }, { sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, times.length);
  const frames = Buffer.concat(await Promise.all(names.map(async (file) => rgba(await readFile(join(sequenceDirectory, file))))));
  assert.ok(await assertFramesMatchStills(scene, options, frames, times) > 1000, "the sequence keeps the fog's alpha");

  // gifski reads the same PNG files. A GIF has a palette (and gifski joins frames that look the
  // same), so only that it is a GIF of the scene's size is checked.
  const gif = (await exportScene(scene, { ...options, format: "gif" })).buffer;
  assert.equal(await probe(gif, "stream=codec_name,width,height"), `gif,${WIDTH},${HEIGHT}`);
});
