import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDocument,
  createLayer,
  createScene,
  parseDocument,
} from "../engine/model.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";

const ffmpeg =
  process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";

function run(command, args, { binaryOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        const output = Buffer.concat(stdout);
        resolve(binaryOutput ? output : output.toString("utf8"));
      } else {
        reject(new Error(stderr.trim() || `${command} exited with ${code ?? signal}`));
      }
    });
  });
}

function rmsForWindow(pcm, sampleRate, start, end) {
  const first = Math.ceil(start * sampleRate);
  const last = Math.min(pcm.length / 2, Math.floor(end * sampleRate));
  let sumSquares = 0;
  let count = 0;
  for (let sample = first; sample < last; sample += 1) {
    const value = pcm.readInt16LE(sample * 2);
    sumSquares += value * value;
    count += 1;
  }
  assert.ok(count > 0, `decoded PCM contains samples for ${start}–${end}s`);
  return Math.sqrt(sumSquares / count);
}

test("component export plays audio only during its timed source content", async (t) => {
  try {
    await run(ffmpeg, ["-version"]);
  } catch (error) {
    t.skip(`FFmpeg is unavailable: ${error.message}`);
    return;
  }

  const temp = await mkdtemp(join(tmpdir(), "kino-component-playback-"));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const tonePath = join(temp, "source-tone.wav");
  await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=997:sample_rate=48000:duration=1",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "1",
    tonePath,
  ]);

  const source = createScene({
    id: "timed-component",
    isComponent: true,
    width: 32,
    height: 24,
    duration: 2,
    layers: [
      createLayer("audio", {
        id: "source-audio",
        name: "Short sound",
        src: "/api/media/source-tone.wav",
        mediaStart: 0,
        mediaDuration: 0.4,
        volume: 1,
      }),
    ],
  });
  const target = createScene({
    id: "target-scene",
    width: 32,
    height: 24,
    duration: 0.9,
    layers: [
      createLayer("component", {
        id: "component-instance",
        x: 0,
        y: 0,
        componentSceneId: source.id,
        componentStart: 0.2,
        componentVisibility: "both",
      }),
    ],
  });
  const document = parseDocument(createDocument({ scenes: [source, target] }));
  const expanded = expandComponents(document, target.id);
  const audio = expanded.layers.find((layer) => layer.type === "audio");
  assert.ok(audio, "component audio is materialized into the target scene");
  assert.equal(audio.playbackWindows[0].visibility, "both");
  assert.deepEqual(
    { start: audio.mediaStart, duration: audio.mediaDuration },
    { start: 0.2, duration: 0.4 },
  );

  const result = await exportScene(
    expanded,
    { format: "mp4", fps: 30, width: 160, height: 90 },
    { mediaRoot: temp },
  );
  const outputPath = join(temp, "component.mp4");
  await writeFile(outputPath, result.buffer);

  const decodedPcm = await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    outputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-af",
    "apad=whole_dur=0.9",
    "-t",
    "0.9",
    "-f",
    "s16le",
    "pipe:1",
  ], { binaryOutput: true });

  const before = rmsForWindow(decodedPcm, 48_000, 0.05, 0.15);
  const inside = rmsForWindow(decodedPcm, 48_000, 0.3, 0.5);
  const after = rmsForWindow(decodedPcm, 48_000, 0.7, 0.85);
  assert.ok(inside > 500, `component interval carries real audio (RMS ${inside.toFixed(1)})`);
  assert.ok(before < 100, `audio is silent before the component starts (RMS ${before.toFixed(1)})`);
  assert.ok(after < 100, `audio does not leak after timed content ends (RMS ${after.toFixed(1)})`);
});
