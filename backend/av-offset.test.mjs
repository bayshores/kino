// av_offset (milestone A3): after a final render, the sound must start within 45 ms before
// and 125 ms after the picture (ITU-R BT.1359). Files are made with FFmpeg here.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { avOffsetFinding, judgeOffset } from "./agent/av-offset.mjs";
import { ffmpegCommand } from "./media-probe.mjs";
import { run, skipWithoutMediaTools } from "./media.test.support.mjs";

let directory;
before(async () => { directory = await mkdtemp(path.join(tmpdir(), "kino-av-offset-")); });
after(() => rm(directory, { recursive: true, force: true }));

test("the limits are 45 ms early and 125 ms late", () => {
  assert.equal(judgeOffset(0).severity, "ok");
  assert.equal(judgeOffset(0).message, "sound in step");
  assert.equal(judgeOffset(-45).severity, "ok");
  assert.equal(judgeOffset(125).severity, "ok");
  const early = judgeOffset(-60);
  assert.equal(early.severity, "error");
  assert.match(early.message, /60 ms early/);
  const late = judgeOffset(200);
  assert.equal(late.severity, "error");
  assert.match(late.message, /200 ms late/);
  assert.equal(late.measured, 200);
});

// A 1 s black MP4 with a tone whose stream starts `delay` seconds late.
async function movie(name, { delay = 0, audio = true } = {}) {
  const file = path.join(directory, name);
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1:r=30"];
  if (audio) args.push("-itsoffset", String(delay), "-f", "lavfi", "-i", "sine=f=440:d=1");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac", "-shortest"] : []), file);
  await run(ffmpegCommand(), args);
  return file;
}

test("a file in step passes, a late sound fails, a silent file has no finding", { skip: skipWithoutMediaTools }, async () => {
  const inStep = await avOffsetFinding(await movie("in-step.mp4"));
  assert.equal(inStep.severity, "ok", inStep.message);
  const late = await avOffsetFinding(await movie("late.mp4", { delay: 0.3 }));
  assert.equal(late.severity, "error", late.message);
  assert.ok(late.measured >= 250 && late.measured <= 350, `measured ${late.measured} ms`);
  assert.equal(await avOffsetFinding(await movie("silent.mp4", { audio: false })), null);
});
