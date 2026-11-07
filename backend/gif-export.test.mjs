// Raster exports decode only the GIF frames they show, with the same decoder and browser rules
// as the editor (engine/gifDecode.js).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { parseGif } from "../engine/gifDecode.js";
import { exportScene, gifPlayFrames } from "./export.mjs";
import { createDecodeSlots, gifDecodeSlots } from "./gif-decode-slots.mjs";
import { makeAnimatedGif, readImage } from "./media.test.support.mjs";

const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-gif-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** 200 frames of 0.1 s each, cycling through four colors, on a 16 x 16 canvas. */
function manyFrameGif() {
  return makeAnimatedGif({
    width: 16,
    height: 16,
    frames: Array.from({ length: 200 }, (_, index) => ({ delayCs: 10, color: COLORS[index % 4] })),
  });
}

function gifLayer(file, play = {}) {
  return createLayer("image", { id: "gif", name: "GIF", x: 0, y: 0, width: 16, height: 16, src: `/api/media/${file}`, ...play });
}

test("a still export encodes only the one GIF frame it shows, and none for a hidden layer", async (t) => {
  const root = await folder(t);
  const buffer = manyFrameGif();
  const playing = gifLayer("many.gif", { mediaStart: 0, mediaDuration: 20 });

  const gif = parseGif(buffer);

  const still = join(root, "still");
  const frames = await gifPlayFrames([playing], gif, { folder: still, sceneTimes: [5.25] });
  assert.deepEqual(await readdir(still), ["000052.png"], "only frame 52 (5.25 s into Play) is decoded to a file");
  assert.equal(frames.durations.length, 200, "the timeline still lists every frame's delay");
  assert.equal(frames.frames.filter(Boolean).length, 1);
  assert.equal(frames.frames[52].mimeType, "image/png");

  const withoutPlay = join(root, "without-play");
  await gifPlayFrames([gifLayer("many.gif")], gif, { folder: withoutPlay, sceneTimes: [0, 1, 2, 3] });
  assert.deepEqual(await readdir(withoutPlay), ["000000.png"], "without Play every export frame shows the first GIF frame");

  const notYet = gifLayer("many.gif", { mediaStart: 10, mediaDuration: 1 });
  assert.equal(await gifPlayFrames([notYet], gif, { folder: join(root, "hidden"), sceneTimes: [2] }), null,
    "a GIF that is not visible at the exported time decodes nothing");
  await assert.rejects(readdir(join(root, "hidden")), { code: "ENOENT" });

  // Two layers of one GIF: one decode writes the frames both of them show, and no others.
  const offset = gifLayer("many.gif", { mediaStart: 0, mediaDuration: 20, mediaOffset: 3 });
  const both = join(root, "both");
  const shared = await gifPlayFrames([playing, offset, notYet], gif, { folder: both, sceneTimes: [5.25] });
  assert.deepEqual((await readdir(both)).sort(), ["000052.png", "000082.png"], "frame 52 for the first layer, frame 82 (3 s later) for the second");
  assert.equal(shared.frames.filter(Boolean).length, 2);
});

/**
 * A decode slot limit that counts what exports ask of it: `calls` is how many decodes asked for
 * a slot, `running` how many run now, and `most` the most that ever ran at the same time.
 */
function countingSlots(limit = createDecodeSlots(2)) {
  const counts = { calls: 0, running: 0, most: 0 };
  return {
    counts,
    run(task, options) {
      counts.calls += 1;
      return limit.run(async () => {
        counts.running += 1;
        counts.most = Math.max(counts.most, counts.running);
        try {
          return await task();
        } finally {
          counts.running -= 1;
        }
      }, options);
    },
  };
}

test("layers that use the same GIF file share one decode in an export, and each shows its own frame", async (t) => {
  const mediaRoot = await folder(t);
  const buffer = manyFrameGif();
  // "copy.gif" has the same bytes as "many.gif" under another name, so it is the same GIF.
  await writeFile(join(mediaRoot, "many.gif"), buffer);
  await writeFile(join(mediaRoot, "copy.gif"), buffer);
  await writeFile(join(mediaRoot, "other.gif"), makeAnimatedGif({
    width: 16, height: 16, frames: [{ delayCs: 10, color: [255, 255, 255] }, { delayCs: 10, color: [0, 0, 0] }],
  }));
  // Four 16 x 16 layers side by side. At 5.35 s the first shows frame 53 (green); the others are
  // offset by 0.1, 0.2, and 0.3 s, so they show frames 54, 55, and 56 (blue, yellow, red).
  const layer = (index, file) => createLayer("image", {
    id: `gif-${index}`, name: `GIF ${index}`, x: index * 16, y: 0, width: 16, height: 16,
    src: `/api/media/${file}`, mediaStart: 0, mediaDuration: 20, mediaOffset: index / 10,
  });
  const scene = createScene({
    id: "s", name: "S", width: 80, height: 16, duration: 30,
    layers: [layer(0, "many.gif"), layer(1, "many.gif"), layer(2, "copy.gif"), layer(3, "many.gif"), layer(4, "other.gif")],
  });
  const slots = countingSlots();
  const image = await readImage((await exportScene(scene, { format: "png", time: 5.35 }, { mediaRoot, gifSlots: slots })).buffer);
  assert.equal(slots.counts.calls, 2, "one decode for the four layers of the same GIF, one for the other GIF");
  assert.deepEqual(image.pixel(8, 8), [0, 255, 0, 255]);
  assert.deepEqual(image.pixel(24, 8), [0, 0, 255, 255]);
  assert.deepEqual(image.pixel(40, 8), [255, 255, 0, 255]);
  assert.deepEqual(image.pixel(56, 8), [255, 0, 0, 255]);
  assert.deepEqual(image.pixel(72, 8), [0, 0, 0, 255], "the other GIF loops every 0.2 s; 5.75 s into Play is its second frame");
});

test("concurrent exports never decode more than two GIFs at the same time", async (t) => {
  const mediaRoot = await folder(t);
  const scenes = [];
  for (let index = 0; index < 6; index += 1) {
    // Six different GIFs, so no export can share another export's decode.
    await writeFile(join(mediaRoot, `gif-${index}.gif`), makeAnimatedGif({
      width: 64, height: 64,
      frames: Array.from({ length: 30 }, (_, frame) => ({ delayCs: 10, color: [index * 40, frame * 8, 0] })),
    }));
    scenes.push(createScene({
      id: `s${index}`, name: "S", width: 16, height: 16, duration: 3,
      layers: [createLayer("image", { id: "gif", name: "GIF", x: 0, y: 0, width: 16, height: 16,
        src: `/api/media/gif-${index}.gif`, mediaStart: 0, mediaDuration: 3 })],
    }));
  }
  const slots = countingSlots();
  await Promise.all(scenes.map((scene) =>
    exportScene(scene, { format: "png-sequence", fps: 10, duration: 3 }, { mediaRoot, gifSlots: slots })));
  assert.equal(slots.counts.calls, 6);
  assert.equal(slots.counts.most, 2, "two decodes ran together, and never more");
});

test("an export waits for the process-wide GIF decode slots and stops waiting when it is cancelled", async (t) => {
  const mediaRoot = await folder(t);
  await writeFile(join(mediaRoot, "many.gif"), manyFrameGif());
  const scene = createScene({ id: "s", name: "S", width: 16, height: 16, duration: 30,
    layers: [gifLayer("many.gif", { mediaStart: 0, mediaDuration: 20 })] });
  const still = (signal) => exportScene(scene, { format: "png", time: 5.35 }, { mediaRoot, signal });
  await still(); // Loads the fonts, so the timing below only measures waiting for a slot.

  // Two other decodes (the editor's frame cache, for example) hold both slots until released.
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const holders = [gifDecodeSlots.run(() => released), gifDecodeSlots.run(() => released)];
  let waitingDone = false;
  const waiting = still().then((result) => { waitingDone = true; return result; });
  const cancel = new AbortController();
  const cancelled = still(cancel.signal);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(waitingDone, false, "the export does not decode while both slots are busy");
  cancel.abort();
  await assert.rejects(cancelled, { name: "AbortError" }, "a cancelled export stops waiting at once");

  release();
  await Promise.all(holders);
  const image = await readImage((await waiting).buffer);
  assert.deepEqual(image.pixel(8, 8), [0, 255, 0, 255], "the waiting export finishes once a slot is free");
});

test("a PNG still of a playing GIF shows the frame at that time and draws partial frames over the background", async (t) => {
  const mediaRoot = await folder(t);
  await writeFile(join(mediaRoot, "many.gif"), manyFrameGif());
  // Frame 0 covers only the top-left 8 x 8; the rest of the canvas must show the scene background (cyan).
  await writeFile(join(mediaRoot, "partial.gif"), makeAnimatedGif({
    width: 16,
    height: 16,
    frames: [
      { delayCs: 50, color: [255, 0, 0], rect: { left: 0, top: 0, width: 8, height: 8 }, disposal: 1 },
      { delayCs: 50, color: [0, 0, 255] },
    ],
  }));
  async function stillAt(file, play, time) {
    const scene = createScene({ id: "s", name: "S", width: 16, height: 16, duration: 30, background: "#00ffff", layers: [gifLayer(file, play)] });
    return readImage((await exportScene(scene, { format: "png", time }, { mediaRoot })).buffer);
  }
  const play = { mediaStart: 0, mediaDuration: 20 };
  // Frame n has COLORS[n % 4]: frame 53 is green, frame 151 is yellow.
  assert.deepEqual((await stillAt("many.gif", play, 5.35)).pixel(8, 8), [0, 255, 0, 255], "5.35 s shows frame 53");
  assert.deepEqual((await stillAt("many.gif", play, 15.15)).pixel(8, 8), [255, 255, 0, 255], "15.15 s shows frame 151");
  const partial = await stillAt("partial.gif", play, 0.1);
  assert.deepEqual(partial.pixel(2, 2), [255, 0, 0, 255]);
  assert.deepEqual(partial.pixel(14, 14), [0, 255, 255, 255], "the part frame 0 does not cover is transparent");
  const partialWithoutPlay = await stillAt("partial.gif", {}, 0);
  assert.deepEqual(partialWithoutPlay.pixel(14, 14), [0, 255, 255, 255], "also without Play");
});

test("a GIF over the decode budget fails a Play export with a clear message", async (t) => {
  const mediaRoot = await folder(t);
  // 4000 x 4000 x 63 frames is more than 1,000,000,000 pixels; the file itself stores 63 pixels.
  await writeFile(join(mediaRoot, "huge.gif"), makeAnimatedGif({
    width: 4000,
    height: 4000,
    frames: Array.from({ length: 63 }, () => ({ delayCs: 10, color: [255, 0, 0], rect: { left: 0, top: 0, width: 1, height: 1 } })),
  }));
  const scene = createScene({ id: "s", name: "S", width: 16, height: 16, duration: 2, layers: [gifLayer("huge.gif", { mediaStart: 0, mediaDuration: 1 })] });
  await assert.rejects(exportScene(scene, { format: "png", time: 0.5 }, { mediaRoot }),
    /Image layer “GIF” cannot play its GIF\. .*more than 1,000,000,000 pixels/);
});

test("a GIF too large to play still draws its first frame without Play, in raster and Lottie exports", async (t) => {
  const mediaRoot = await folder(t);
  // A 6000 x 4000 canvas is over the 16,777,216-pixel limit for playing, but within the still limit.
  // Its only frame paints the top-left 600 x 400 red; a 30 x 20 layer shows that corner as 3 x 2 pixels.
  await writeFile(join(mediaRoot, "photo.gif"), makeAnimatedGif({
    width: 6000,
    height: 4000,
    frames: [{ delayCs: 10, color: [255, 0, 0], rect: { left: 0, top: 0, width: 600, height: 400 } }],
  }));
  // Over the still limit too: a 9000 x 9000 canvas.
  await writeFile(join(mediaRoot, "poster.gif"), makeAnimatedGif({
    width: 9000,
    height: 9000,
    frames: [{ delayCs: 10, color: [255, 0, 0], rect: { left: 0, top: 0, width: 1, height: 1 } }],
  }));
  const sceneWith = (file, play = {}) => createScene({
    id: "s", name: "S", width: 30, height: 20, duration: 2, background: "#00ffff",
    layers: [gifLayer(file, { width: 30, height: 20, ...play })],
  });

  const still = await readImage((await exportScene(sceneWith("photo.gif"), { format: "png", time: 0 }, { mediaRoot })).buffer);
  assert.deepEqual(still.pixel(0, 0), [255, 0, 0, 255], "the first frame is drawn");
  assert.deepEqual(still.pixel(15, 10), [0, 255, 255, 255], "the rest of the canvas is transparent");
  const lottie = await exportScene(sceneWith("photo.gif"), { format: "lottie" }, { mediaRoot });
  assert.equal(JSON.parse(lottie.buffer.toString("utf8")).assets.filter((asset) => asset.p?.startsWith("data:image/")).length, 1);

  await assert.rejects(exportScene(sceneWith("photo.gif", { mediaStart: 0, mediaDuration: 1 }), { format: "png", time: 0.5 }, { mediaRoot }),
    /Image layer “GIF” cannot play its GIF\. This GIF's picture \(6000 x 4000\) is larger than 16,777,216 pixels\./);
  for (const format of ["png", "lottie"])
    await assert.rejects(exportScene(sceneWith("poster.gif"), { format, time: 0 }, { mediaRoot }),
      /Image layer “GIF” cannot draw its GIF\. This GIF's picture \(9000 x 9000\) is larger than 33,554,432 pixels\./, format);
});
