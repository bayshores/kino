// A video exported with its sound goes silent while a Hide operation hides it, or hides a group
// around it, as the editor preview does (engine/videoSound.js).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const SIZE = 32;
const hide = (start) => ({ id: `hide-${start}`, name: "Hide", kind: "hide", start });
const show = (start) => ({ id: `show-${start}`, name: "Show", kind: "show", start });

async function audioSamples(path) {
  const raw = await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

function loudness(samples, from, to) {
  let sum = 0;
  const first = Math.round(from * 48000);
  const last = Math.round(to * 48000);
  for (let index = first; index < last; index += 1) sum += (samples[index] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, last - first));
}

test("an exported video is silent while a Hide hides it or the group around it", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-visibility-sound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  // A 2 s red video with a 440 Hz tone all the way through.
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=red:s=${SIZE}x${SIZE}:r=10:d=2`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(mediaRoot, "tone.mp4"),
  ]);
  const clip = (values) => createLayer("video", { id: "video", name: "Video", x: 0, y: 0, width: SIZE, height: SIZE,
    src: "/api/media/tone.mp4", ...values });
  const scene = (layers) => createScene({ id: "sound", name: "Sound", width: SIZE, height: SIZE, duration: 2, background: "#000000", layers });
  const cases = {
    "the video's own Hide and Show": scene([clip({ animations: [hide(0.5), show(1.5)] })]),
    "a Hide and Show on its group": scene([
      createLayer("group", { id: "group", name: "Group", width: SIZE, height: SIZE, animations: [hide(0.5), show(1.5)] }),
      clip({ parentId: "group" }),
    ]),
  };
  const results = [];
  for (const [name, document] of Object.entries(cases)) {
    const outputPath = join(root, `${results.length}.mp4`);
    // The software MP4 profile keeps the test independent of shared hardware encoders.
    await exportScene(document, { profile: "mp4.alt", fps: 10 }, { mediaRoot, outputPath });
    const samples = await audioSamples(outputPath);
    // The windows stay 50 ms or more away from the switches, because compressed audio blurs them slightly.
    const levels = { before: loudness(samples, 0.05, 0.45), hidden: loudness(samples, 0.6, 1.4), after: loudness(samples, 1.6, 1.95) };
    results.push(`${name}: ${Object.entries(levels).map(([key, value]) => `${key} ${value.toFixed(4)}`).join(", ")}`);
    assert.ok(levels.before > 0.05, `${name}: the tone plays before the Hide`);
    assert.ok(levels.hidden < 0.005, `${name}: silent from the Hide at 0.5 s to the Show at 1.5 s`);
    assert.ok(levels.after > 0.05, `${name}: the tone plays again after the Show`);
  }
  t.diagnostic(`RMS ${results.join("; ")}`);
});
