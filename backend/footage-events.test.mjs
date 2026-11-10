// Footage events (backend/footage/events.mjs, footage/analyze.mjs): impacts, light and motion at
// the clip's own frame rate, and frames per drawing. A clip made here: a white square drawn on 2s
// moves right and hits a wall at 1.5 s, then the room's light comes up over 3 frames at 3 s, then
// one inverted frame at 3.5 s; then a texture pans right from 4 s and at 4.75 s cuts to another,
// brighter texture panning left (a cut, not a hit).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ffmpeg, skipWithoutMediaTools } from "./media.test.support.mjs";
import { measureFootage } from "./footage/analyze.mjs";
import { GRID_H, GRID_W, eventWindows, footageEvents, phaseShift } from "./footage/events.mjs";

process.env.KINO_MEASURE_HELPER = "none";
const WIDTH = 320, HEIGHT = 180, FPS = 24, SECONDS = 5.5;
const WALL_FRAME = 36; // 1.5 s
const PAN_FRAME = 96, CUT_FRAME = 114; // 4 s, 4.75 s

// Fixed noise (drawn in 32 px blocks), one pattern per seed.
const noise = (x, y, seed) => ((Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453) % 1 + 1) % 1;

// One frame of the clip, 8-bit gray.
function frameAt(index) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT);
  if (index >= PAN_FRAME) {
    // On 2s too, 12 px a drawing.
    const [seed, shift] = index < CUT_FRAME ? [1, 12 * Math.floor((index - PAN_FRAME) / 2)] : [2, -12 * Math.floor((index - CUT_FRAME) / 2)];
    for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
      pixels[y * WIDTH + x] = Math.round((seed === 1 ? 60 : 120) + 130 * noise(Math.floor((x - shift) / 32), Math.floor(y / 32), seed));
    }
    return pixels;
  }
  const ramp = Math.min(3, Math.max(0, index - 72 + 1)) / 3; // frames 72 to 74 brighten
  const back = Math.round(30 + 90 * ramp);
  pixels.fill(back);
  // The wall: a darker band on the right.
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 260; x < WIDTH; x += 1) pixels[y * WIDTH + x] = back - 20;
  const drawing = Math.floor(Math.min(index, WALL_FRAME) / 2) * 2; // on 2s
  const left = 20 + Math.round((drawing / WALL_FRAME) * 208);
  for (let y = 70; y < 110; y += 1) for (let x = left; x < left + 32; x += 1) pixels[y * WIDTH + x] = 240;
  if (index === 84) for (let i = 0; i < pixels.length; i += 1) pixels[i] = 255 - pixels[i];
  return pixels;
}

async function makeClip(file) {
  const child = spawn(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${WIDTH}x${HEIGHT}`, "-r", String(FPS), "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr)))));
  for (let index = 0; index < FPS * SECONDS; index += 1) {
    if (!child.stdin.write(frameAt(index))) await new Promise((resolve) => child.stdin.once("drain", resolve));
  }
  child.stdin.end();
  await closed;
}

test("phase correlation reads which way the picture moved", () => {
  // A textured picture (2 px blocks of fixed noise) moved right by `shift` grid pixels.
  const grid = (shift) => {
    const out = new Float32Array(GRID_W * GRID_H);
    const noise = (x, y) => ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
    for (let y = 0; y < GRID_H; y += 1) for (let x = 0; x < GRID_W; x += 1) out[y * GRID_W + x] = noise(Math.floor((x - shift) / 2), Math.floor(y / 2));
    return out;
  };
  const moved = phaseShift(grid(0), grid(4));
  assert.ok(Math.abs(moved.dx * GRID_W - 4) < 0.5 && Math.abs(moved.dy) < 0.01, JSON.stringify(moved));
  assert.ok(moved.peak > 0.3);
  // Nothing moves and nothing new: no events, no drawing rate.
  assert.deepEqual(footageEvents([{ start: 0, fps: 24, frames: Array.from({ length: 24 }, () => grid(0)) }]), { events: [], drawing: null });
  // A square moving right at a steady 3 grid px a frame, drawn on 4s: no stop between drawings.
  const square = (index) => {
    const out = new Float32Array(GRID_W * GRID_H).fill(0.2);
    const left = 4 + 3 * Math.floor(index / 4) * 4;
    for (let y = 26; y < 38; y += 1) for (let x = left; x < left + 12; x += 1) out[y * GRID_W + x] = 0.9;
    return out;
  };
  const onFours = footageEvents([{ start: 0, fps: 24, frames: Array.from({ length: 36 }, (_, index) => square(index)) }]);
  assert.ok(onFours.events.some((event) => event.kind === "motion" && event.dir === "right"), JSON.stringify(onFours));
  assert.deepEqual(onFours.events.filter((event) => event.kind === "impact"), []);
});

test("close-look windows go to flashes and light, not cuts, across the whole clip", () => {
  // 5 minutes at 24 fps: a hard cut every 106 frames, a 1-frame flash at 250 s, and light rising
  // 0.02 a frame for 10 frames at 200 s (under the 1-frame jump of 0.05).
  const frames = 300 * 24;
  const luma = Array.from({ length: frames }, (_, i) => 0.4 + 0.02 * Math.min(10, Math.max(0, i - 4800)));
  const change = Array.from({ length: frames }, (_, i) => (i > 0 ? 0.01 : 0)), back = Array(frames).fill(0.01);
  for (let i = 106; i < frames; i += 106) { change[i] = 0.3; back[i] = 0.3; }
  change[6000] = 0.3; back[6000] = 0.005; change[6001] = 0.3;
  const windows = eventWindows({ luma, change, back }, 24, 300);
  const covers = (t) => windows.some(([start, end]) => start <= t && end >= t);
  assert.ok(covers(250) && covers(4808 / 24), JSON.stringify(windows));
  assert.ok(windows.at(-1)[0] > 200 && windows[0][1] < 60, JSON.stringify(windows));
});

test("a clip's impacts, light, motion and drawing rate, at its own frame rate", { skip: skipWithoutMediaTools }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-footage-events-"));
  try {
    const file = path.join(folder, "events.mp4");
    await makeClip(file);
    const measured = await measureFootage(file, { width: WIDTH, height: HEIGHT, duration: SECONDS });
    assert.equal(measured.version, 2);
    assert.equal(measured.rate, 24);
    const frame = 1 / FPS;
    const near = (kind, t, extra = () => true) => measured.events.find((event) => event.kind === kind && Math.abs(event.t - t) <= frame + 1e-3 && extra(event));
    const contact = near("impact", WALL_FRAME / FPS, (event) => event.how === "contact");
    assert.ok(contact, JSON.stringify(measured.events));
    assert.equal(contact.dir, "right");
    const light = near("light", 74 / FPS);
    assert.ok(light && light.from <= 73 / FPS && light.from >= 71 / FPS, JSON.stringify(measured.events));
    const flash = near("impact", 84 / FPS, (event) => event.how === "frame");
    assert.ok(flash && flash.frames === 1, JSON.stringify(measured.events));
    assert.ok(measured.events.some((event) => event.kind === "motion" && event.dir === "right" && event.t < WALL_FRAME / FPS), JSON.stringify(measured.events));
    // No false impact while the square is still or the light holds, and none at the cuts.
    assert.equal(measured.events.filter((event) => event.kind === "impact").length, 2, JSON.stringify(measured.events));
    assert.ok(measured.events.some((event) => event.kind === "motion" && event.t >= CUT_FRAME / FPS && event.dir === "left"), JSON.stringify(measured.events));
    assert.deepEqual(measured.drawing && { frames: measured.drawing.frames, perSecond: measured.drawing.perSecond }, { frames: 2, perSecond: 12 });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
