// Subject cut-out files (backend/cutout/cutout.mjs): which engines a computer has and the reasons
// when it has none, the matte a clip or picture gets, the cache, cancelling, and the three outputs
// (subject, matte, silhouette) checked pixel by pixel against footage made in code
// (cutout.test.support.mjs), where the subject's outline is known in every frame.
//
// Two helpers find the subject. The stand-in (cutout.test.stand-in.mjs) keys red, so everything
// after "find the subject" runs on every computer, Linux CI included. The real one (Apple Vision,
// kino-cutout.swift, built from source here) runs on macOS 14 and later and is measured on a lit,
// textured ball over a plain and a busy background with camera grain. Last, the work folders a
// stopped server leaves in the cache (backend/cutout/media.mjs).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cutoutEngines, cutoutHelperPath, makeMatte, probeVideo, writeCutoutOutput } from "./cutout/cutout.mjs";
import { matteMeasure, radialEdgeErrors } from "./cutout/matte.mjs";
import { createCutoutMedia } from "./cutout/media.mjs";
import { makeTrack } from "./cutout/track.mjs";
import { makeBallClip, skipWithoutVision, standInHelper, visionHelper, withOrientation } from "./cutout.test.support.mjs";
import { ffmpeg, ffprobe, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-cutout-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function setEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

/** Every frame of a video as one byte a pixel: grey, or the alpha of a VP9 WebM (libvpx keeps it). */
async function decodeFrames(path, { width, height, alpha = false }) {
  const raw = await run(ffmpeg, ["-v", "error", ...(alpha ? ["-c:v", "libvpx-vp9"] : []), "-i", path, "-map", "0:v:0",
    "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", alpha ? "rgba" : "gray", "pipe:1"]);
  const step = alpha ? 4 : 1, size = width * height * step;
  const frames = [];
  for (let offset = 0; offset + size <= raw.length; offset += size) {
    const frame = new Uint8Array(width * height);
    for (let i = 0; i < frame.length; i += 1) frame[i] = raw[offset + i * step + (alpha ? 3 : 0)];
    frames.push(Object.assign(frame, { rgba: alpha ? raw.subarray(offset, offset + size) : null }));
  }
  return frames;
}

// The times of a video's key frames (where a seek can start decoding).
async function keyFrameTimes(path) {
  const text = (await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path])).toString();
  return text.trim().split("\n").filter((line) => line.includes("K")).map((line) => Number(line.split(",")[0]));
}

async function probe(path) {
  const text = (await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
    "stream=codec_name,width,height,nb_read_frames,pix_fmt:stream_tags=alpha_mode:format=duration", "-of", "json", path])).toString();
  const json = JSON.parse(text);
  return { ...json.streams[0], duration: Number(json.format.duration) };
}

// The smallest IoU over the frames, against the clip's known outline.
function worstIoU(frames, clip, { grow = 0 } = {}) {
  return Math.min(...frames.map((frame, index) => {
    const where = clip.where(index);
    const truth = new Uint8Array(clip.width * clip.height);
    for (let y = 0; y < clip.height; y += 1)
      for (let x = 0; x < clip.width; x += 1)
        truth[y * clip.width + x] = Math.hypot(x + 0.5 - where.cx, y + 0.5 - where.cy) <= where.r + grow ? 1 : 0;
    return matteMeasure(frame, { truth }).iou;
  }));
}

test("without an engine, cut-out says why, and auto falls back to the person engine on macOS 13", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const root = await folder(t);
  // Off macOS, with no helper named by hand: Apple Vision is not there.
  setEnv(t, "KINO_CUTOUT_HELPER", undefined);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    const engines = await cutoutEngines();
    assert.deepEqual(engines.map((entry) => [entry.engine, entry.available, entry.reason]), [
      ["subject", false, "Subject cut-out uses Apple Vision, which is only on macOS."],
      ["person", false, "Subject cut-out uses Apple Vision, which is only on macOS."]]);
    await assert.rejects(makeMatte({ source: join(root, "any.mp4"), kind: "video", cacheDir: root }), {
      code: "CUTOUT_ENGINE_UNAVAILABLE", message: "No cut-out engine is available. Subject cut-out uses Apple Vision, which is only on macOS." });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  // A Mac on macOS 13 has the person engine only (the stand-in reports what the real helper would).
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper({ KINO_STAND_IN_MACOS: "13.6" }));
  const old = await cutoutEngines();
  assert.equal(old[0].available, false);
  assert.equal(old[0].reason, "The subject engine needs macOS 14 or later (this Mac has 13.6).");
  assert.equal(old[1].available, true);
  const clip = await makeBallClip(join(root, "red.png"), { width: 160, height: 90, seconds: 0, look: "red" });
  await assert.rejects(makeMatte({ source: clip.path, kind: "image", engine: "subject", cacheDir: join(root, "cache") }), {
    code: "CUTOUT_ENGINE_UNAVAILABLE", message: "The subject engine needs macOS 14 or later (this Mac has 13.6)." });
  const fallback = await makeMatte({ source: clip.path, kind: "image", cacheDir: join(root, "cache") });
  assert.equal(fallback.engine, "person");
  assert.equal(fallback.note, "auto used the person engine: The subject engine needs macOS 14 or later (this Mac has 13.6).");

  // KINO_CUTOUT_HELPER=none turns Vision off, even on a Mac (the look-source golden frames use it).
  setEnv(t, "KINO_CUTOUT_HELPER", "none");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    const off = await cutoutEngines();
    assert.deepEqual(off.map((entry) => [entry.available, entry.reason]), [
      [false, "Apple Vision is turned off (KINO_CUTOUT_HELPER=none)."], [false, "Apple Vision is turned off (KINO_CUTOUT_HELPER=none)."]]);
    assert.equal(cutoutHelperPath(), null);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  // A helper file that cannot run.
  const broken = join(root, "kino-cutout");
  await writeFile(broken, "not a program");
  setEnv(t, "KINO_CUTOUT_HELPER", broken);
  const failed = await cutoutEngines();
  assert.match(failed[0].reason, /^The kino-cutout helper could not start: .*EACCES/);

  // A helper built from older source (no --track, no points) is named with the command that fixes
  // it, instead of its matte bytes being read as track JSON.
  const stale = await standInHelper({ KINO_STAND_IN_VERSION: "1" });
  setEnv(t, "KINO_CUTOUT_HELPER", stale);
  const fix = new RegExp(`^The kino-cutout helper at ${stale.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is version 1; this kino needs version \\d+\\. Rebuild it with npm run desktop:cutout`);
  assert.match((await cutoutEngines())[0].stale, fix);
  await assert.rejects(makeTrack({ source: clip.path, cacheDir: join(root, "tracks"), at: 0, to: 1, box: [0.1, 0.1, 0.2, 0.2] }), { code: "CUTOUT_ENGINE_UNAVAILABLE", message: fix });
  await assert.rejects(makeMatte({ source: clip.path, kind: "image", cacheDir: join(root, "cache"), pick: { points: [[50, 50]] } }), { code: "CUTOUT_ENGINE_UNAVAILABLE", message: fix });
});

test("a clip's matte follows the subject in every frame, is kept by the file's hash, and makes all three outputs", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper());
  const root = await folder(t);
  const cacheDir = join(root, "cache");
  const clip = await makeBallClip(join(root, "red.mp4"), { width: 320, height: 180, fps: 30, seconds: 2, still: 0.5, look: "red" });
  const progress = [];
  const made = await makeMatte({ source: clip.path, kind: "video", cacheDir, onProgress: (fraction) => progress.push(fraction) });
  assert.equal(made.cached, false);
  assert.equal(made.engine, "subject");
  assert.equal(made.note, null);
  assert.deepEqual({ kind: made.info.kind, width: made.info.width, height: made.info.height, frames: made.info.frames, empty: made.info.empty, rate: made.info.source.rate },
    { kind: "video", width: 320, height: 180, frames: 60, empty: 0, rate: "30/1" });
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]), "progress only goes up");
  // The steadied matte, kept losslessly, covers the subject in every frame.
  const mattes = await decodeFrames(join(made.folder, made.info.file), clip);
  assert.equal(mattes.length, 60);
  const matteIoU = worstIoU(mattes, clip);
  t.diagnostic(`stand-in matte: worst IoU ${matteIoU.toFixed(4)} over 60 frames`);
  assert.ok(matteIoU >= 0.96, `matte IoU ${matteIoU}`);
  // The same file again is found in the cache at once; a work folder is never left behind.
  const again = await makeMatte({ source: clip.path, kind: "video", cacheDir });
  assert.equal(again.cached, true);
  assert.equal(again.folder, made.folder);
  assert.deepEqual((await readdir(cacheDir)).filter((name) => name.startsWith(".")), []);

  // subject: VP9 with transparency, the clip's own colours inside, the same frames and length.
  const subject = join(root, "subject.webm");
  assert.deepEqual(await writeCutoutOutput({ source: clip.path, folder: made.folder, info: made.info, output: "subject", target: subject }),
    { extension: "webm", mime: "video/webm" });
  const facts = await probe(subject);
  assert.equal(facts.codec_name, "vp9");
  assert.equal(facts.tags?.alpha_mode, "1", "the WebM says it has transparency");
  assert.equal(Number(facts.nb_read_frames), 60);
  assert.ok(Math.abs(facts.duration - 2) < 0.05, `duration ${facts.duration}`);
  assert.deepEqual(await keyFrameTimes(subject), [0, 1], "a key frame every second, so the dashboard seeks it quickly");
  const subjectFrames = await decodeFrames(subject, { ...clip, alpha: true });
  const subjectIoU = worstIoU(subjectFrames, clip);
  t.diagnostic(`subject WebM alpha: worst IoU ${subjectIoU.toFixed(4)}`);
  assert.ok(subjectIoU >= 0.96, `subject IoU ${subjectIoU}`);
  const centre = clip.where(30), frame = subjectFrames[30];
  const at = (Math.round(centre.cy) * clip.width + Math.round(centre.cx)) * 4;
  assert.ok(frame.rgba[at] > 200 && frame.rgba[at + 1] < 60 && frame.rgba[at + 3] > 250, `the subject keeps its red: ${[...frame.rgba.subarray(at, at + 4)]}`);
  assert.equal(frame.rgba[3], 0, "the corner is transparent");

  // matte, inverted: black subject on white, H.264 for create_mask.
  const matte = join(root, "matte.mp4");
  await writeCutoutOutput({ source: clip.path, folder: made.folder, info: made.info, output: "matte", invert: true, target: matte });
  assert.equal((await probe(matte)).codec_name, "h264");
  assert.deepEqual(await keyFrameTimes(matte), [0, 1]);
  const inverted = await decodeFrames(matte, clip);
  assert.equal(inverted.length, 60);
  assert.ok(worstIoU(inverted.map((values) => values.map((value) => 255 - value)), clip) >= 0.96);

  // silhouette, grown by 8 px and in green: an outline ring 8 px outside the subject.
  const silhouette = join(root, "silhouette.webm");
  await writeCutoutOutput({ source: clip.path, folder: made.folder, info: made.info, output: "silhouette", grow: 8, color: "#00ff00", target: silhouette });
  const ring = await decodeFrames(silhouette, { ...clip, alpha: true });
  assert.equal(ring.length, 60);
  const radii = ring.map((frame, index) => {
    const where = clip.where(index);
    const errors = radialEdgeErrors(frame, clip.width, clip.height, { ...where, r: where.r + 8 }).map((ray) => ray.error);
    return errors.reduce((sum, error) => sum + error, 0) / errors.length;
  });
  t.diagnostic(`silhouette grow 8: edge ${Math.min(...radii).toFixed(2)} to ${Math.max(...radii).toFixed(2)} px from radius + 8`);
  assert.ok(radii.every((error) => Math.abs(error) < 1.5), "the grown edge is 8 px out in every frame");
  const green = ring[10].rgba, middle = (Math.round(clip.where(10).cy) * clip.width + Math.round(clip.where(10).cx)) * 4;
  assert.ok(green[middle] < 40 && green[middle + 1] > 215 && green[middle + 2] < 40, `silhouette colour ${[...green.subarray(middle, middle + 3)]}`);

  // A damaged cache (its matte file deleted, then matte.json cut short) is made again, not trusted.
  await rm(join(made.folder, made.info.file));
  const remade = await makeMatte({ source: clip.path, kind: "video", cacheDir });
  assert.deepEqual([remade.cached, remade.folder, remade.info.frames], [false, made.folder, 60]);
  await writeFile(join(made.folder, "matte.json"), "{\"file\":");
  const again2 = await makeMatte({ source: clip.path, kind: "video", cacheDir });
  assert.deepEqual([again2.cached, again2.info.frames], [false, 60]);
  assert.equal((await makeMatte({ source: clip.path, kind: "video", cacheDir })).cached, true);
  assert.deepEqual((await readdir(cacheDir)).filter((name) => name.startsWith(".")), [], "no work folder is left behind");
});

test("a still picture's outputs are PNGs at its upright size, also for a phone photo turned by EXIF", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper());
  const root = await folder(t);
  const cacheDir = join(root, "cache");
  // 240 × 120 stored, shown turned a quarter clockwise: 120 × 240 upright.
  const clip = await makeBallClip(join(root, "stored.jpg"), { width: 240, height: 120, seconds: 0, look: "red" });
  const photo = join(root, "photo.jpg");
  await writeFile(photo, withOrientation(await readFile(clip.path), 6));
  const made = await makeMatte({ source: photo, kind: "image", cacheDir });
  assert.deepEqual([made.info.source.width, made.info.source.height, made.info.frames, made.info.empty], [120, 240, 1, 0]);
  const subject = join(root, "subject.png");
  assert.deepEqual(await writeCutoutOutput({ source: photo, folder: made.folder, info: made.info, output: "subject", feather: 6, target: subject }),
    { extension: "png", mime: "image/png" });
  const image = await readImage(await readFile(subject));
  assert.deepEqual([image.width, image.height], [120, 240]);
  // Turned clockwise, the stored picture's (x, y) is shown at (height − 1 − y, x).
  const stored = clip.where(0);
  const shown = { cx: 120 - stored.cy, cy: stored.cx, r: stored.r };
  const inside = image.pixel(Math.round(shown.cx), Math.round(shown.cy));
  assert.ok(inside[0] > 200 && inside[3] === 255, `the subject is where the upright photo shows it: ${inside}`);
  assert.equal(image.pixel(Math.round(shown.cx), Math.round(shown.cy - shown.r - 12))[3], 0, "above the subject is transparent");
  // Feather 6 makes the edge soft: some pixels across it are part-transparent.
  const across = Array.from({ length: 12 }, (_, step) => image.pixel(Math.round(shown.cx), Math.round(shown.cy - shown.r - 6 + step))[3]);
  assert.ok(across.filter((alpha) => alpha > 10 && alpha < 245).length >= 3, `a soft edge: ${across}`);

  const matte = join(root, "matte.png");
  await writeCutoutOutput({ source: photo, folder: made.folder, info: made.info, output: "matte", target: matte });
  const grey = await readImage(await readFile(matte));
  assert.deepEqual(grey.pixel(Math.round(shown.cx), Math.round(shown.cy)), [255, 255, 255, 255]);
  assert.deepEqual(grey.pixel(2, 2), [0, 0, 0, 255]);
});

test("a clip whose picture starts late keeps its place, and a cancelled or failed cut-out leaves nothing behind", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const root = await folder(t);
  const cacheDir = join(root, "cache");
  const clip = await makeBallClip(join(root, "red.mp4"), { width: 160, height: 90, fps: 25, seconds: 2, look: "red" });
  // Sound from 0 s, the picture from 0.4 s (as some cameras and screen recorders write files).
  const late = join(root, "late.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.4", "-itsoffset", "0.4", "-i", clip.path,
    "-map", "1:v", "-map", "0:a", "-c:v", "copy", "-c:a", "aac", late]);
  const video = await probeVideo(late);
  assert.ok(Math.abs(video.lead - 0.4) < 0.03, `lead ${video.lead}`);
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper());
  const made = await makeMatte({ source: late, kind: "video", cacheDir });
  assert.equal(made.info.frames, 50);
  const subject = join(root, "subject.webm");
  await writeCutoutOutput({ source: late, folder: made.folder, info: made.info, output: "subject", target: subject });
  // The output starts at the file's start too: 0.4 s of the first picture, then the clip.
  const frames = await decodeFrames(subject, { width: 160, height: 90, alpha: true });
  assert.equal(frames.length, 60);
  const first = clip.where(0), last = clip.where(49);
  const alphaAt = (frame, where) => frame[Math.round(where.cy) * 160 + Math.round(where.cx)];
  assert.ok(alphaAt(frames[0], first) > 250 && alphaAt(frames[59], last) > 250 && alphaAt(frames[59], first) < 5,
    "frame 0 shows where the subject first is, the last frame where it ends");
  // A lead that is not whole frames (0.41 s at 25 fps): each picture of the cut-out starts when the
  // same picture of the file does, not up to half a frame off (dm3 run a: two heads at 0.2x).
  const odd = join(root, "odd.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.4", "-itsoffset", "0.41", "-i", clip.path,
    "-map", "1:v", "-map", "0:a", "-c:v", "copy", "-c:a", "aac", odd]);
  const oddMatte = await makeMatte({ source: odd, kind: "video", cacheDir });
  const oddSubject = join(root, "odd.webm");
  await writeCutoutOutput({ source: odd, folder: oddMatte.folder, info: oddMatte.info, output: "subject", target: oddSubject });
  const times = async (file) => String(await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file]))
    .trim().split("\n").map((line) => Number.parseFloat(line)).filter(Number.isFinite);
  // FFmpeg times both files from their first stream, as check, look and export read them.
  const [fileStart, webmStart] = await Promise.all([odd, oddSubject].map(async (file) => Number(String(await run(ffprobe, ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", file])))));
  const picture = (await times(odd)).map((time) => time - fileStart), cut = (await times(oddSubject)).map((time) => time - webmStart);
  const leadCopies = cut.length - picture.length;
  assert.ok(leadCopies >= 1, `${cut.length} cut-out frames for ${picture.length} pictures`);
  const off = picture.map((time, k) => Math.abs(cut[k + leadCopies] - time));
  assert.ok(Math.max(...off) <= 0.0015, `the largest gap between a picture and its cut-out is ${Math.max(...off).toFixed(4)} s (${picture.slice(0, 3)} / ${cut.slice(0, 4)}; starts ${fileStart}, ${webmStart})`);

  // Cancelling stops the helper and FFmpeg and removes the half-made matte.
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper({ KINO_STAND_IN_DELAY_MS: 40 }));
  const controller = new AbortController();
  const cancelled = makeMatte({ source: clip.path, kind: "video", cacheDir: join(root, "cancel"), signal: controller.signal,
    onProgress: (fraction) => { if (fraction > 0.1) controller.abort(); } });
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(await readdir(join(root, "cancel")), []);

  // A helper that fails part-way: the error says so, and nothing is cached.
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper({ KINO_STAND_IN_FAIL: "the picture could not be read" }));
  await assert.rejects(makeMatte({ source: clip.path, kind: "video", cacheDir: join(root, "fail") }), (error) => {
    assert.equal(error.code, "CUTOUT_ENGINE_FAILED");
    assert.match(error.message, /^Apple Vision could not cut out the subject: kino-cutout failed \(3\): kino-cutout: the picture could not be read/);
    return true;
  });
  assert.deepEqual(await readdir(join(root, "fail")), []);
});

test("a tracker that dies on the backward pass fails the track, without an unhandled rejection or a wait for ever", {
  skip: skipWithoutMediaTools, timeout: 20_000,
}, async (t) => {
  const root = await folder(t);
  // 640 × 360 pictures fill the pipe, so the backward pass waits for drain when the helper dies.
  const clip = await makeBallClip(join(root, "red.mp4"), { width: 640, height: 360, fps: 30, seconds: 2, look: "red" });
  // Forward (1.5 s to 2 s) reads 16 pictures; backward (0 to 1.5 s) dies at its 20th.
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper({ KINO_STAND_IN_FAIL: "lost", KINO_STAND_IN_FAIL_AFTER: 20 }));
  const unhandled = [];
  const note = (error) => unhandled.push(error);
  process.on("unhandledRejection", note);
  t.after(() => process.off("unhandledRejection", note));
  await assert.rejects(makeTrack({ source: clip.path, cacheDir: join(root, "tracks"), at: 1.5, from: 0, to: 2, box: [0.1, 0.1, 0.2, 0.2] }),
    /kino-cutout --track failed \(3\): kino-cutout: lost/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unhandled, []);
});

test("Apple Vision finds a lit, textured subject over plain and busy backgrounds with grain, steadily", {
  skip: skipWithoutVision,
}, async (t) => {
  setEnv(t, "KINO_CUTOUT_HELPER", await visionHelper());
  const root = await folder(t);
  const engines = await cutoutEngines();
  assert.equal(engines[0].available, true, engines[0].reason);
  for (const [background, least] of [["plain", 0.97], ["pattern", 0.95]]) {
    // A ball resting for 1 s then rolling across, with camera grain (sd 6 levels) in every frame.
    const clip = await makeBallClip(join(root, `${background}.mp4`), { background, noise: 6 });
    const made = await makeMatte({ source: clip.path, kind: "video", engine: "subject", cacheDir: join(root, "cache") });
    const mattes = await decodeFrames(join(made.folder, made.info.file), clip);
    assert.equal(mattes.length, clip.frames);
    assert.equal(made.info.empty, 0);
    const ious = mattes.map((matte, index) => matteMeasure(matte, { truth: clip.truthAt(index) }).iou);
    // Flicker: how far the edge moves from one frame to the next while the ball rests (it should not).
    const edges = mattes.map((matte, index) => radialEdgeErrors(matte, clip.width, clip.height, clip.where(index)).map((ray) => ray.error ?? 0));
    let still = 0;
    for (let index = 1; index < 30; index += 1) still += edges[index].reduce((sum, error, ray) => sum + Math.abs(error - edges[index - 1][ray]), 0) / 64;
    still /= 29;
    t.diagnostic(`${background}: IoU worst ${Math.min(...ious).toFixed(4)}, mean ${(ious.reduce((a, b) => a + b) / ious.length).toFixed(4)}; resting edge moves ${still.toFixed(3)} px a frame; ${made.info.seconds} s for ${clip.frames} frames`);
    assert.ok(Math.min(...ious) >= least, `${background}: worst IoU ${Math.min(...ious)}`);
    assert.ok(still < 0.15, `${background}: the resting edge moves ${still} px a frame`);
  }
  // A still picture.
  const photo = await makeBallClip(join(root, "ball.png"), { seconds: 0, background: "pattern" });
  const made = await makeMatte({ source: photo.path, kind: "image", engine: "subject", cacheDir: join(root, "cache") });
  const matte = new Uint8Array(await readFile(join(made.folder, made.info.file)));
  const iou = matteMeasure(matte, { truth: photo.truthAt(0) }).iou;
  t.diagnostic(`still on the busy background: IoU ${iou.toFixed(4)}`);
  assert.ok(iou >= 0.95);
  assert.ok(existsSync(join(made.folder, "matte.json")));
});

test("the work folders a stopped server left in the cut-out cache go when the next one starts; kept mattes and recent work stay", async (t) => {
  const root = await folder(t);
  const cacheDir = join(root, "cutout");
  // A matte half made (.work-…) and an output half written (.media-…), as a killed server leaves
  // them two hours ago, next to a finished matte and the work of another server running now.
  const kept = "0123456789abcdef0123456789abcdef";
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const [name, file, at] of [[".work-Ab12Cd", "matte.mkv", old], [".media-Ef34Gh", "out.webm", old], [kept, "matte.json", old], [".work-Running", "matte.mkv", null]]) {
    await mkdir(join(cacheDir, name), { recursive: true });
    await writeFile(join(cacheDir, name, file), "partial");
    if (at) await utimes(join(cacheDir, name), at, at);
  }
  // The server makes this when it starts (backend/index.mjs).
  createCutoutMedia({ mediaRoot: join(root, "media"), cacheDir, addMedia: () => { throw new Error("nothing is made here"); } });
  let names = await readdir(cacheDir);
  for (const until = Date.now() + 5000; names.length > 2 && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    names = await readdir(cacheDir);
  }
  assert.deepEqual(names.sort(), [".work-Running", kept]);
  assert.equal(await readFile(join(cacheDir, kept, "matte.json"), "utf8"), "partial");
});
