// The measure end to end (backend/measure/measure.mjs): a clip made here is decoded by FFmpeg and
// read by the kino-measure helper (Apple Vision, built from kino-measure.swift). The clip pans for
// 2 s, then cuts to a still card where "make it move" appears a word at a time. Without Vision
// (another computer, or KINO_MEASURE_HELPER=none) the fingerprint has no Vision numbers and says
// why; the Vision test is skipped where Vision cannot run.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { ffmpeg, skipWithoutMediaTools } from "./media.test.support.mjs";
import { measureAbilities, measureVideo } from "./measure/measure.mjs";
import { soundHelper } from "./footage/sounds.mjs";
import { burnedTextLine, NOT_READ, readBurnedText } from "./footage/burned-text.mjs";

const skipWithoutVision = skipWithoutMediaTools
  || (process.platform !== "darwin" && "Apple Vision measure test skipped: it needs macOS")
  || (Number(release().split(".")[0]) < 22 && "Apple Vision measure test skipped: it needs macOS 13 or later")
  || (spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status !== 0
    && "Apple Vision measure test skipped: the Swift compiler (Xcode command line tools) is not installed");

const WIDTH = 640, HEIGHT = 360, FPS = 24, SECONDS = 4;

/** Writes the test clip: a striped picture panning right 3 px a frame, then a card with words. */
async function makeClip(file) {
  const child = spawn(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-r", String(FPS), "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr)))));
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  for (let frame = 0; frame < FPS * SECONDS; frame += 1) {
    const time = frame / FPS;
    if (time < 2) {
      // A picture with detail everywhere, moving left as the camera pans right.
      const shift = frame * 3;
      for (let x = -40; x < WIDTH + 40; x += 20) {
        for (let y = 0; y < HEIGHT; y += 20) {
          const column = Math.floor((x + shift) / 20);
          context.fillStyle = `hsl(${(column * 47 + y) % 360}, 60%, ${35 + ((column + y / 20) % 3) * 15}%)`;
          context.fillRect(x - (shift % 20), y, 20, 20);
        }
      }
    } else {
      context.fillStyle = "#101014";
      context.fillRect(0, 0, WIDTH, HEIGHT);
      const words = ["make", "it", "move"].slice(0, Math.min(3, 1 + Math.floor((time - 2.25) / 0.5)));
      context.fillStyle = "#ffffff";
      context.font = "bold 56px sans-serif";
      if (time >= 2.25) context.fillText(words.join(" "), 80, 200);
    }
    if (!child.stdin.write(Buffer.from(context.getImageData(0, 0, WIDTH, HEIGHT).data))) await new Promise((resolve) => child.stdin.once("drain", resolve));
  }
  child.stdin.end();
  await closed;
}

let folder, clip;
test.before(async () => {
  if (skipWithoutMediaTools) return;
  folder = await mkdtemp(path.join(tmpdir(), "kino-measure-test-"));
  clip = path.join(folder, "clip.mp4");
  await makeClip(clip);
});
test.after(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

test("Apple Vision measures the pan, the still card, the words appearing one at a time and a print a shot", { skip: skipWithoutVision }, async () => {
  const abilities = await measureAbilities();
  assert.equal(abilities.flow, true, String(abilities.flow));
  const { fingerprint: fp, prints } = await measureVideo(clip, { seconds: SECONDS, cuts: [2] });
  assert.deepEqual(Object.values(fp.vision), [true, true, true, true]);
  // The first half pans (camera), the second is still: about half and half.
  assert.ok(fp.camera.pan >= 0.35 && fp.camera.pan <= 0.6, `pan ${fp.camera.pan}`);
  assert.ok(fp.motion.stillShare >= 0.35, `still ${fp.motion.stillShare}`);
  // Each new word breaks the stillness for a frame pair, so the card holds still in half seconds.
  assert.ok(fp.motion.longestStill.seconds >= 0.4, `longest still ${fp.motion.longestStill.seconds}`);
  // 3 px a frame at 24 fps is 72 px a second, about 0.1 of the 734 px diagonal.
  assert.ok(Math.abs(fp.camera.panSpeed - 72 / Math.hypot(WIDTH, HEIGHT)) < 0.02, `pan speed ${fp.camera.panSpeed}`);
  assert.ok(fp.text.share >= 0.3 && fp.text.share <= 0.5, `text ${fp.text.share}`);
  assert.equal(fp.text.lowercase, 1);
  assert.ok(fp.text.counts.words >= 1, JSON.stringify(fp.text.counts));
  assert.equal(prints.length, 2, "one feature print a shot");
});

test("the helper's foreground job boxes a drawn figure standing on a step, from the subject mask", { skip: skipWithoutVision }, async (t) => {
  const abilities = await measureAbilities();
  if (abilities.foreground !== true) return t.skip(`subject mask: ${abilities.foreground}`);
  const [width, height] = [480, 270];
  const context = createCanvas(width, height).getContext("2d");
  // A flat wall and step, and a flat-colored figure on the step: x 200 to 240, y 80 to 230 px.
  context.fillStyle = "#2a3a48"; context.fillRect(0, 0, width, height);
  context.fillStyle = "#1c2630"; context.fillRect(0, 230, width, 40);
  context.fillStyle = "#f2c9a0"; context.beginPath(); context.arc(220, 95, 15, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#d24a2a"; context.fillRect(203, 110, 34, 65);
  context.fillStyle = "#30302c"; context.fillRect(205, 175, 12, 55); context.fillRect(223, 175, 12, 55);
  const rgba = context.getImageData(0, 0, width, height).data;
  const bgra = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) { bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1]; bgra[i + 2] = rgba[i]; bgra[i + 3] = 255; }
  const run = spawnSync(abilities.helper, ["--width", String(width), "--height", String(height)], { input: Buffer.concat([Buffer.from([64]), bgra]), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const { foreground: [box], cover } = JSON.parse(run.stdout);
  [200 / width, 80 / height, 40 / width, 150 / height].forEach((want, index) => assert.ok(Math.abs(box[index] - want) < 0.03, `box ${box}`));
  // cover: the mask's share of the picture's pixels (the figure's drawn pixels are about 3.3%).
  assert.ok(cover > 0.02 && cover < 0.05, `cover ${cover}`);
});

test("the helper's --sounds mode classifies 1 s windows, half overlapped, each with its labels and level", { skip: skipWithoutVision }, async () => {
  const { helper, why } = await soundHelper();
  assert.ok(helper, why);
  // 3 s of a 440 Hz tone at half scale, written here (no FFmpeg): windows at 0, 0.5, ... 2 s.
  const samples = new Float32Array(16000 * 3).map((_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / 16000));
  const run = spawnSync(helper, ["--sounds", "--rate", "16000"], { input: Buffer.from(samples.buffer), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const windows = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(windows.length >= 4, `${windows.length} windows`);
  for (const window of windows) assert.ok(Number.isFinite(window.t) && Array.isArray(window.top) && Number.isFinite(window.db), JSON.stringify(window));
  // A sine at half scale is about -9 dBFS RMS.
  assert.ok(Math.abs(windows[0].db + 9) < 1, `db ${windows[0].db}`);
});

test("without Apple Vision the fingerprint keeps kino's own numbers and names what it could not measure", { skip: skipWithoutMediaTools }, async () => {
  const before = process.env.KINO_MEASURE_HELPER;
  process.env.KINO_MEASURE_HELPER = "none";
  try {
    const { fingerprint: fp, prints } = await measureVideo(clip, { seconds: SECONDS, cuts: [2] });
    assert.equal(fp.motion, null);
    assert.equal(fp.camera, null);
    assert.equal(fp.text, null);
    assert.deepEqual(prints, []);
    assert.match(fp.vision.flow, /KINO_MEASURE_HELPER=none/);
    assert.ok(fp.look.brightness > 0 && fp.look.palette.length > 0);
    assert.equal(fp.shots.count, 2);
  } finally {
    if (before === undefined) delete process.env.KINO_MEASURE_HELPER; else process.env.KINO_MEASURE_HELPER = before;
  }
});

test("burned-in text: the reader's lines become a mark and subtitles on the record's line; with no reader the line says so once", async () => {
  // The reader stubbed: a site name top-left on every frame, a subtitle on the last one.
  const asked = [];
  const readFrames = async (file, options) => {
    asked.push(options);
    return [0, 0.25, 0.5, 0.75, 1.15].map((t) => ({ t, lines: [{ box: [0.009, 0.01, 0.078, 0.032], s: "sitename", c: 0.5 }, ...(t > 1 ? [{ box: [0.404, 0.88, 0.192, 0.054], s: "but I'll stay.", c: 0.5 }] : [])] }));
  };
  const burned = await readBurnedText("clip.mp4", { width: 1920, height: 1080, duration: 1.19 }, { readFrames });
  assert.equal(asked[0].step, 0.25);
  assert.equal(burnedTextLine(burned), 'burned-in text (file s, read every 0.25 s at 960 px): a mark top-left "sitename" (1-9% across, 1-4% down) on 5 of 5 frames · a subtitle 1.15 s "but I\'ll stay." (40-60% across, 88-93% down).');
  // A long clip is read at an even step, at most 48 frames.
  await readBurnedText("long.mp4", { width: 1920, height: 1080, duration: 120 }, { readFrames });
  assert.equal(asked[1].step, 2.5);
  const unread = await readBurnedText("clip.mp4", { width: 1920, height: 1080, duration: 1.19 }, { readFrames: async () => null });
  assert.equal(unread.unread, NOT_READ);
  assert.equal(burnedTextLine(unread), "burned-in text: not read on this system (Apple Vision's text reader is on a Mac only).");
});
