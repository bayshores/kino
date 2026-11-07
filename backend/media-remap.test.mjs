// media-remap.mjs: which file frames a clip on a time map shows, and flow's in-between frames,
// on generated footage of a white square moving across black.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer } from "../engine/model.js";
import { atempoChain } from "./sound-remap.mjs";
import { extractRemappedFrames, flowFactor, framePosition } from "./media-remap.mjs";
import { ffmpeg, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const SIZE = 96;
const SQUARE = 16;
// The square starts at x 8 and moves 8 pixels to the right each file frame, 30 frames a second.
const MOVE = 8;
const squareAt = (frame) => 8 + frame * MOVE;

// `hold` repeats each picture that many frames, as a screen recording of a slow preview does.
async function movingSquare(path, frames = 8, hold = 1) {
  const raw = Buffer.alloc(SIZE * SIZE * 3 * frames);
  for (let frame = 0; frame < frames; frame += 1)
    for (let y = 40; y < 40 + SQUARE; y += 1)
      for (let x = squareAt(Math.floor(frame / hold)); x < squareAt(Math.floor(frame / hold)) + SQUARE; x += 1)
        raw.fill(255, ((frame * SIZE + y) * SIZE + x) * 3, ((frame * SIZE + y) * SIZE + x) * 3 + 3);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${SIZE}x${SIZE}`, "-r", "30", "-i", "pipe:0",
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", path], { input: raw });
}

// The brightest pixel along the square's row, and where the bright part is (its first and last x).
async function row(path) {
  const picture = await readImage(await readFile(path));
  const values = Array.from({ length: SIZE }, (_, x) => picture.pixel(x, 48)[0]);
  const bright = values.map((value, x) => (value > 200 ? x : -1)).filter((x) => x >= 0);
  return { brightest: Math.max(...values), first: bright[0] ?? -1, last: bright.at(-1) ?? -1 };
}

test("framePosition finds the frame on screen and how far toward the next one a time is", () => {
  assert.deepEqual(framePosition(0, 30), { index: 0, part: 0 });
  assert.deepEqual(framePosition(0.5 / 30, 30), { index: 0, part: 0.5 });
  assert.deepEqual(framePosition(1 / 30 - 0.0005, 30), { index: 1, part: 0 }, "within 1 ms of a frame is that frame");
  const late = framePosition(1.25 / 30, 30, 0);
  assert.equal(late.index, 1);
  assert.ok(Math.abs(late.part - 0.25) < 1e-9);
  assert.equal(framePosition(2, 30, 1).index, 30, "counted from the first frame's time");
  // flow makes enough frames for the slowest stretch, at most 8 per file frame.
  assert.equal(flowFactor([0, 1 / 120, 2 / 120], 30), 4);
  assert.equal(flowFactor([0, 1 / 30], 30), 1);
  assert.equal(flowFactor([0, 0.0001], 30), 8);
  // atempo goes from 0.5×; slower speeds chain it.
  assert.equal(atempoChain(2), "atempo=2");
  assert.equal(atempoChain(0.25), "atempo=0.5,atempo=0.5");
  assert.equal(atempoChain(0.05), "atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.8");
});

test("flow draws the square halfway between two file frames, where blend shows two half-strength squares", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-media-remap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = join(root, "square.mp4");
  await movingSquare(video);
  // At 0.25× the export asks for a quarter of a file frame further each frame.
  const needed = Array.from({ length: 29 }, (_, index) => ({ time: index / 120, playing: true }));
  // Halfway between file frames 3 (square at x 32-47) and 4 (x 40-55).
  const halfway = 3.5 / 30;
  const layer = (interpolation) => createLayer("video", { id: "v", name: "Square", src: "/api/media/square.mp4", mediaSpeed: 0.25, mediaDuration: 1, mediaInterpolation: interpolation });
  const options = (name) => ({ folder: join(root, name), end: 8 / 30, width: SIZE, height: SIZE, flowCacheDir: join(root, "flow-cache") });

  const blend = await extractRemappedFrames(layer("blend"), video, needed, options("blend"));
  const blended = await row(blend.frameFor(halfway));
  assert.equal(blend.mode, "blend");
  // Only where the two squares overlap (x 40-47) is the mix fully bright.
  assert.deepEqual([blended.first, blended.last], [squareAt(4), squareAt(3) + SQUARE - 1], "blend: two half-strength squares, bright only where they overlap");

  const started = performance.now();
  const flow = await extractRemappedFrames(layer("flow"), video, needed, options("flow"));
  const firstSeconds = (performance.now() - started) / 1000;
  assert.equal(flow.mode, "flow");
  assert.deepEqual({ factor: flow.flow.factor, built: flow.flow.built }, { factor: 4, built: true });
  const flowed = await row(flow.frameFor(halfway));
  // Halfway, flow draws one whole square at x 36-51.
  const middle = squareAt(3) + MOVE / 2;
  assert.ok(Math.abs(flowed.first - middle) <= 1 && Math.abs(flowed.last - (middle + SQUARE - 1)) <= 1, `flow: one square halfway, x ${flowed.first}-${flowed.last}`);
  const onFrame = await row(flow.frameFor(4 / 30));
  assert.deepEqual([onFrame.first, onFrame.last], [squareAt(4), squareAt(4) + SQUARE - 1], "on a file frame, flow shows that frame");

  const again = await extractRemappedFrames(layer("flow"), video, needed, options("flow-again"));
  assert.equal(again.flow.built, false, "the second time, the proxy comes from the cache");
  assert.equal((await readdir(join(root, "flow-cache"))).filter((name) => name.endsWith(".mkv")).length, 1);
  // Shown twice as big, the clip uses the same proxy (made at the file's own size, never larger)
  // and its pictures are scaled up afterwards.
  const larger = await extractRemappedFrames(layer("flow"), video, needed, { ...options("flow-larger"), width: 2 * SIZE, height: 2 * SIZE });
  assert.equal(larger.flow.built, false, "a larger layer reuses the proxy made at the file's size");
  assert.equal((await readImage(await readFile(larger.frameFor(halfway)))).width, 2 * SIZE);
  t.diagnostic(`flow at ${SIZE}×${SIZE}, 8 file frames ×4: first ${firstSeconds.toFixed(2)} s (proxy ${flow.flow.seconds.toFixed(2)} s)`);
});

test("flow drops a file's repeated frames, so a held picture moves at its own speed and keeps its times", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-media-remap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = join(root, "held.mp4");
  // 30 frames a second, a new picture every 6 frames (5 a second): 4 pictures, 24 frames.
  await movingSquare(video, 24, 6);
  const needed = Array.from({ length: 24 }, (_, index) => ({ time: index / 30, playing: true }));
  const layer = createLayer("video", { id: "v", name: "Held", src: "/api/media/held.mp4", mediaDuration: 0.8, mediaInterpolation: "flow" });
  const flow = await extractRemappedFrames(layer, video, needed, { folder: join(root, "frames"), end: 24 / 30, width: SIZE, height: SIZE, flowCacheDir: join(root, "flow-cache") });
  assert.equal(flow.flow.factor, 1, "at the file's speed");
  const rows = [];
  for (const { time } of needed) rows.push(await row(flow.frameFor(time)));
  // Each new picture lands on its own frame time, and the frames between move toward the next one.
  for (const picture of [0, 1, 2, 3]) assert.equal(rows[picture * 6].first, squareAt(picture), `picture ${picture} at frame ${picture * 6}`);
  for (let index = 1; index <= 18; index += 1) assert.notDeepEqual(rows[index], rows[index - 1], `frame ${index} repeats frame ${index - 1}`);
  // The last picture is held to the end: the clip keeps its length.
  assert.equal(rows[23].first, squareAt(3));
});
