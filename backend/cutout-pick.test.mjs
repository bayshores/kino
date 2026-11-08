// cut_out points (backend/cutout/pick.mjs, makeMatte pick): on two objects the pointed one is
// kept and the other's area has no kept pixel, exclude drops one, and a clip follows the pointed
// object before and after `time` and reports where it was lost or weak. The stand-in helper (red blobs are instances) runs everywhere;
// Apple Vision runs on a two-ball still on macOS 14 and later.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeMatte } from "./cutout/cutout.mjs";
import { followPicked, followReport, pickedLabels } from "./cutout/pick.mjs";
import { ballFrame, skipWithoutVision, standInHelper, visionHelper } from "./cutout.test.support.mjs";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const W = 320, H = 180;

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-cutout-pick-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function setEnv(t, name, value) {
  const before = process.env[name];
  process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}

// Two red discs on navy (the stand-in's subject), as RGB bytes.
function twoDiscs(a, b, width = W, height = H) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0, p = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1, p += 3) {
      const inside = [a, b].some(({ cx, cy, r }) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r);
      pixels.set(inside ? [230, 25, 25] : [25, 40, 90], p);
    }
  return pixels;
}

async function encode(path, frames, { width = W, height = H, fps = 10 } = {}) {
  const still = frames.length === 1;
  const child = spawn(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
    ...(still ? ["-frames:v", "1", path] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv444p", path])], { stdio: ["pipe", "ignore", "inherit"] });
  const closed = new Promise((resolve, reject) => child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)))));
  for (const frame of frames) child.stdin.write(frame);
  child.stdin.end();
  await closed;
}

// Kept pixels (matte 128 and up) inside a disc, and how many pixels the disc has.
function keptIn(matte, { cx, cy, r }, width = W, height = H) {
  let kept = 0, all = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 2) { all += 1; if (matte[y * width + x] >= 128) kept += 1; }
  return { kept, all };
}

async function matteFrames(result) {
  const file = join(result.folder, result.info.file);
  if (result.info.kind === "image") return [new Uint8Array(await readFile(file))];
  const raw = await run(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
  const size = result.info.width * result.info.height, frames = [];
  for (let at = 0; at + size <= raw.length; at += size) frames.push(raw.subarray(at, at + size));
  return frames;
}

test("followPicked keeps the object that overlaps the kept one, forward and back", () => {
  // 4 × 1 grids: object 1 drifts right, object 2 stays at the end; labels swap numbers in frame 2.
  const grids = [[1, 1, 0, 2], [0, 1, 0, 2], [0, 2, 0, 1], [0, 2, 2, 1]].map((row) => Uint8Array.from(row));
  const keeps = followPicked(grids, 1, new Set([1]));
  assert.deepEqual(keeps.map((keep) => [...keep]), [[1], [1], [2], [2]]);
  assert.deepEqual([...pickedLabels(Uint8Array.from([1, 1, 2, 2]), 4, 1, { points: [[10, 50], [80, 50]], exclude: [[90, 50]] })], [1]);
});

test("followReport finds lost, shrunk and jumping frames, judged outward from the chosen one", () => {
  // 10 × 10 grids: a 4 × 4 square (16 cells) kept as label 1.
  const square = (x, y, size = 4) => {
    const grid = new Uint8Array(100);
    for (let row = y; row < y + size; row += 1) for (let column = x; column < x + size; column += 1) grid[row * 10 + column] = 1;
    return grid;
  };
  const grids = [square(1, 1), square(1, 1), new Uint8Array(100), new Uint8Array(100), square(1, 1), square(1, 1, 2), square(1, 1), square(5, 5), square(5, 5), square(6, 0, 2)];
  const keeps = grids.map((grid) => new Set(grid.some(Boolean) ? [1] : []));
  // Frames 2-3 lost; 5 shrank to 4 cells; 7 jumped 4 cells; 8 stays where 7 went (no new jump);
  // 9 is small and far but cut by the picture's edge, so it is not judged.
  assert.deepEqual(followReport(grids, keeps, 0, 10), { lost: [[2, 4]], weak: [[5, 6], [7, 8]] });
  // From the last frame back: frame 7 is sound, 6 is a jump from it, 5 shrank, 4 is sound again.
  assert.deepEqual(followReport(grids, keeps, 8, 10), { lost: [[2, 4]], weak: [[5, 7]] });
});

const left = { cx: 80, cy: 90, r: 40 }, right = { cx: 240, cy: 90, r: 40 };

test("points keep the pointed object of a still, and exclude drops one", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await folder(t);
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper());
  const source = join(root, "two.png");
  await encode(source, [twoDiscs(left, right)]);
  const cacheDir = join(root, "cache");
  const pointed = await makeMatte({ source, kind: "image", cacheDir, pick: { points: [[25, 50]] } });
  const [matte] = await matteFrames(pointed);
  assert.equal(keptIn(matte, right).kept, 0, "the other object has no kept pixel");
  assert.ok(keptIn(matte, left).kept > keptIn(matte, left).all * 0.9, "the pointed object is kept");
  assert.deepEqual(pointed.info.picked, { frame: 0, objects: 1 });
  const dropped = await makeMatte({ source, kind: "image", cacheDir, pick: { points: [[25, 50], [75, 50]], exclude: [[75, 50]] } });
  const [only] = await matteFrames(dropped);
  assert.equal(keptIn(only, right).kept, 0);
  assert.ok(keptIn(only, left).kept > 0);
  // Without points both are kept, and the cache keeps them apart.
  const [both] = await matteFrames(await makeMatte({ source, kind: "image", cacheDir }));
  assert.ok(keptIn(both, right).kept > 0 && keptIn(both, left).kept > 0);
  await assert.rejects(makeMatte({ source, kind: "image", cacheDir, pick: { points: [[50, 5]] } }), { code: "CUTOUT_NO_SUBJECT" });
});

test("points at a time follow the same object through a clip, before and after", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await folder(t);
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper());
  const source = join(root, "two.mp4");
  // The left disc moves right 6 px a frame; the right one stays.
  const at = (n) => ({ ...left, cx: left.cx + 6 * n, r: 30 });
  const still = { ...right, r: 30 };
  await encode(source, Array.from({ length: 10 }, (_, n) => twoDiscs(at(n), still)));
  // At 0.5 s (frame 5) the moving disc is at 110 px: 34% across.
  const made = await makeMatte({ source, kind: "video", cacheDir: join(root, "cache"), pick: { points: [[(at(5).cx / W) * 100, 50]], time: 0.5 } });
  assert.deepEqual(made.info.picked, { frame: 5, objects: 1, lost: [], weak: [] });
  const frames = await matteFrames(made);
  assert.equal(frames.length, 10);
  for (const [n, matte] of frames.entries()) {
    assert.equal(keptIn(matte, still).kept, 0, `frame ${n}: the still disc has no kept pixel`);
    assert.ok(keptIn(matte, at(n)).kept > keptIn(matte, at(n)).all * 0.8, `frame ${n}: the moving disc is kept`);
  }
});

test("a clip whose object leaves the picture for a stretch reports that span as lost, within one frame", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await folder(t);
  setEnv(t, "KINO_CUTOUT_HELPER", await standInHelper());
  const source = join(root, "away.mp4");
  // 10 fps: the right disc drifts out past the right edge (frames 0-11), is gone (12-19), drifts
  // back (20-31). The left disc stays and is never kept.
  const x = (n) => (n < 12 ? 280 + 6 * n : n < 20 ? 420 : 346 - 6 * (n - 20));
  const stay = { ...left, r: 30 };
  await encode(source, Array.from({ length: 32 }, (_, n) => twoDiscs(stay, { cx: x(n), cy: 90, r: 30 })));
  const made = await makeMatte({ source, kind: "video", cacheDir: join(root, "cache"), pick: { points: [[(280 / W) * 100, 50]] } });
  const { lost, weak } = made.info.picked;
  assert.equal(lost.length, 1, JSON.stringify(made.info.picked));
  // Gone from 1.2 s until 2.0 s.
  assert.ok(Math.abs(lost[0][0] - 1.2) <= 0.1 + 1e-9 && Math.abs(lost[0][1] - 2.0) <= 0.1 + 1e-9, JSON.stringify(lost));
  // Leaving and coming back, the disc is cut by the picture's edge, which is not weak.
  assert.deepEqual(weak, []);
  // Followed back in after the gap: the last frame keeps the right disc, never the left one.
  const frames = await matteFrames(made);
  assert.equal(keptIn(frames.at(-1), stay).kept, 0);
  assert.ok(keptIn(frames.at(-1), { cx: x(31), cy: 90, r: 30 }).kept > 0);
});

test("Apple Vision: points keep one of two balls on a still", { skip: skipWithoutVision, timeout: 120_000 }, async (t) => {
  const root = await folder(t);
  setEnv(t, "KINO_CUTOUT_HELPER", await visionHelper());
  const width = 640, height = 360;
  const a = { cx: 170, cy: 190, r: 80, spin: 0 }, b = { cx: 480, cy: 190, r: 80, spin: 1 };
  const one = ballFrame({ width, height, where: a }), two = ballFrame({ width, height, where: b });
  // Both balls: the second ball's pixels where it is.
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (Math.hypot(x + 0.5 - b.cx, y + 0.5 - b.cy) <= b.r + 1) one.set(two.subarray((y * width + x) * 3, (y * width + x) * 3 + 3), (y * width + x) * 3);
  const source = join(root, "balls.png");
  await encode(source, [one], { width, height });
  const made = await makeMatte({ source, kind: "image", cacheDir: join(root, "cache"), engine: "subject", pick: { points: [[(b.cx / width) * 100, 50]] } });
  const [matte] = await matteFrames(made);
  assert.equal(keptIn(matte, a, width, height).kept, 0, "the other ball has no kept pixel");
  const kept = keptIn(matte, { ...b, r: b.r - 4 }, width, height);
  assert.ok(kept.kept > kept.all * 0.8, `the pointed ball is kept (${kept.kept} of ${kept.all})`);
});
