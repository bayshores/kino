// Exported sound follows Volume animations (a fade in and a duck_audio dip) sample by sample, as
// kino's own evaluator gives them (engine/animation.js volumeAt), and a clip without one is mixed
// exactly as before: the plain FFmpeg volume filter, with no volume track.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { volumeAt } from "../engine/animation.js";
import { masterLimiter } from "./audio-levels.mjs";
import { exportScene } from "./export.mjs";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const SIZE = 32;
const RATE = 48_000;
// A 500 Hz tone at FFmpeg's default sine amplitude of 1/8: a 10 ms window holds exactly 5 waves,
// so its RMS is the amplitude / √2 times the volume, with no part-wave error.
const AMPLITUDE = 1 / 8;
const WINDOW = 0.01;
const dB = (ratio) => 20 * Math.log10(ratio);

async function makeMedia(root) {
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  // pan copies the tone into each channel at full level (FFmpeg's own upmix would lower it 3 dB).
  const tone = (layout, file) => run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=500:sample_rate=${RATE}:duration=4`, "-af", layout, join(mediaRoot, file)]);
  await tone("pan=stereo|c0=c0|c1=c0", "music.wav");
  await tone("pan=mono|c0=c0", "music-mono.wav");
  // The voice-over only needs to play from 2 s to 3 s; silence keeps it out of the measurement.
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=mono`, "-t", "1", join(mediaRoot, "voice.wav")]);
  return mediaRoot;
}

// A 4 s scene: music with a 0.5 s linear fade in, ducked to 0.25 under a voice-over at 2–3 s.
function fadeAndDuckScene(music) {
  const scene = createScene({ id: "mix", name: "Mix", width: SIZE, height: SIZE, duration: 4, background: "#000000" });
  scene.layers = [
    createLayer("audio", { id: "music", name: "Music", src: `/api/media/${music}` }),
    createLayer("audio", { id: "voice", name: "Voice", src: "/api/media/voice.wav", mediaStart: 2, mediaDuration: 1 }),
  ];
  const reports = new Map();
  const duck = { type: "duck_audio", sceneId: "mix", layerId: "music", under: ["voice"], to: 0.25, fade: 0.25 };
  const document = applyOperations(parseDocument({ ...createDocument(), scenes: [scene] }), [
    { type: "add_animation", sceneId: "mix", layerId: "music",
      animation: { kind: "in", start: 0, duration: 0.5, easing: "linear", from: { volume: 0 }, to: { volume: 1 } } },
    duck,
  ], { reports });
  assert.deepEqual(reports.get(duck), { layer: "Music", to: 0.25, dips: 1, summary: "Music ducked to 0.25 at 1.75-3.25 s (Voice)", times: [[1.75, 3.25]] });
  return document.scenes[0];
}

// The first channel of the exported sound as 32-bit float samples at 48 kHz.
async function firstChannel(path) {
  const raw = await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-ar", String(RATE), "-f", "f32le", "pipe:1"]);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

function rms(samples, from) {
  const first = Math.round(from * RATE);
  const count = Math.round(WINDOW * RATE);
  let sum = 0;
  for (let index = first; index < first + count; index += 1) sum += (samples[index] ?? 0) ** 2;
  return Math.sqrt(sum / count);
}

// What the window should measure: the tone times the layer's volume, sample by sample.
function expectedRms(layer, from) {
  const first = Math.round(from * RATE);
  const count = Math.round(WINDOW * RATE);
  let sum = 0;
  for (let index = first; index < first + count; index += 1) sum += volumeAt(layer, index / RATE) ** 2;
  return (AMPLITUDE / Math.SQRT2) * Math.sqrt(sum / count);
}

test("exported sound follows a Volume fade in and a duck_audio dip, without steps", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-volume-animation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = await makeMedia(root);
  const scene = fadeAndDuckScene("music.wav");
  const music = scene.layers.find((layer) => layer.id === "music");
  // MOV keeps the sound as 16-bit PCM, so the levels are not blurred by a lossy encoder.
  const outputPath = join(root, "mix.mov");
  await exportScene(scene, { profile: "mov", fps: 10 }, { mediaRoot, outputPath });
  const samples = await firstChannel(outputPath);
  assert.ok(samples.length >= 3.9 * RATE, "the sound lasts the whole scene");

  // The steady parts: full volume, the dip at 0.25 (-12 dB), and full volume again.
  for (const [time, volume] of [[1, 1], [1.5, 1], [2.5, 0.25], [2.9, 0.25], [3.6, 1]]) {
    const measured = rms(samples, time) / (AMPLITUDE / Math.SQRT2);
    assert.ok(Math.abs(dB(measured / volume)) < 0.5, `at ${time} s the volume is ${measured.toFixed(3)}, not ${volume}`);
  }
  // Every 10 ms through the fade in (0.05 to 0.5 s), the fade down (1.75 to 2 s) and the fade up
  // (3 to 3.25 s), the level matches the evaluator's curve within 0.5 dB. A volume that only
  // changed once a video frame (every 100 ms here) would be several dB off inside these ramps.
  const misses = [];
  let checked = 0, worst = 0;
  for (const [from, to] of [[0.05, 0.5], [1.7, 2.05], [2.95, 3.3]]) {
    for (let time = from; time < to - 1e-9; time += WINDOW) {
      const error = dB(rms(samples, time) / expectedRms(music, time));
      checked += 1;
      worst = Math.max(worst, Math.abs(error));
      if (Math.abs(error) >= 0.5) misses.push(`${time.toFixed(2)} s: ${error.toFixed(2)} dB`);
    }
  }
  t.diagnostic(`${checked} windows in the ramps checked; the largest difference is ${worst.toFixed(3)} dB`);
  assert.deepEqual(misses, [], "the exported level follows the Volume animations");
});

test("an MP4 of a mono sound with a Volume animation keeps the fade and the dip", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-volume-animation-mp4-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = await makeMedia(root);
  // MP4 copies a mono sound into both stereo channels, so the volume track is copied into two.
  const scene = fadeAndDuckScene("music-mono.wav");
  const outputPath = join(root, "mix.mp4");
  // The software MP4 profile keeps the test independent of shared hardware encoders.
  const result = await exportScene(scene, { profile: "mp4.alt", fps: 10 }, { mediaRoot, outputPath });
  assert.ok(!result.warnings?.some((warning) => warning.code === "audio-level-unmeasured"), "the mix with a volume track was measured");
  const samples = await firstChannel(outputPath);
  // Halfway through the linear fade in from 0 the volume is sin(pi/4) (equal power).
  for (const [time, volume] of [[0.25, Math.SQRT1_2], [1, 1], [2.5, 0.25], [3.6, 1]]) {
    const measured = rms(samples, time) / (AMPLITUDE / Math.SQRT2);
    assert.ok(Math.abs(dB(measured / volume)) < 0.5, `at ${time} s the volume is ${measured.toFixed(3)}, not ${volume}`);
  }
});

test("a sound without a Volume animation is mixed exactly as before", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-volume-plain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = await makeMedia(root);
  const scene = createScene({ id: "plain", name: "Plain", width: SIZE, height: SIZE, duration: 4, background: "#000000",
    layers: [createLayer("audio", { id: "music", name: "Music", src: "/api/media/music.wav", volume: 0.5 })] });
  const outputPath = join(root, "plain.mov");
  await exportScene(scene, { profile: "mov", fps: 10 }, { mediaRoot, outputPath });
  const exported = await run(ffmpeg, ["-v", "error", "-i", outputPath, "-map", "0:a:0", "-c:a", "copy", "-f", "s16le", "pipe:1"]);
  // The mix as kino built it before Volume animations: the clip through FFmpeg's volume filter,
  // amix and the master limiter, with no volume track input.
  const graph = "[0:a:0]atrim=start=0:duration=4,asetpts=PTS-STARTPTS,volume=0.5,adelay=0:all=1,asetpts=round(N/SR/TB)[a0];" +
    `[a0]amix=inputs=1:duration=longest:dropout_transition=0:normalize=0,atrim=duration=4,${masterLimiter()}`;
  const reference = await run(ffmpeg, ["-v", "error", "-i", join(mediaRoot, "music.wav"), "-filter_complex", graph,
    "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"]);
  assert.ok(exported.length >= 3.9 * RATE * 4, "the sound lasts the whole scene");
  const length = Math.min(exported.length, reference.length);
  assert.ok(exported.subarray(0, length).equals(reference.subarray(0, length)), "the samples are identical to the plain volume mix");
});

// The level of one frequency in a 10 ms window (Goertzel), as a ratio of a full-scale sine.
function toneLevel(samples, from, frequency) {
  const first = Math.round(from * RATE);
  const count = Math.round(WINDOW * RATE);
  const k = 2 * Math.cos((2 * Math.PI * frequency) / RATE);
  let previous = 0, before = 0;
  for (let index = first; index < first + count; index += 1) {
    const next = (samples[index] ?? 0) + k * previous - before;
    before = previous;
    previous = next;
  }
  return (2 * Math.sqrt(previous ** 2 + before ** 2 - k * previous * before)) / count;
}

test("exported sound follows a Lowpass sweep: highs gone while muffled, back when open", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-lowpass-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  // A 300 Hz and an 8 kHz tone together (both whole waves in 10 ms).
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=300:sample_rate=${RATE}:duration=4`,
    "-f", "lavfi", "-i", `sine=frequency=8000:sample_rate=${RATE}:duration=4`, "-filter_complex", "amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0",
    join(mediaRoot, "music.wav")]);
  // Muffled at 400 Hz until 2 s, then opening (evenly in octaves) to 20 kHz by 3 s.
  const scene = createScene({ id: "lp", name: "Lowpass", width: SIZE, height: SIZE, duration: 4, background: "#000000",
    layers: [createLayer("audio", { id: "music", name: "Music", src: "/api/media/music.wav" })] });
  const document = applyOperations(parseDocument({ ...createDocument(), scenes: [scene] }), [{ type: "add_animation", sceneId: "lp", layerId: "music",
    animation: { kind: "in", start: 2, duration: 1, easing: "linear", from: { lowpass: 400 }, to: { lowpass: 20000 } } }]);
  const outputPath = join(root, "lowpass.mov");
  await exportScene(document.scenes[0], { profile: "mov", fps: 10 }, { mediaRoot, outputPath });
  const samples = await firstChannel(outputPath);
  const level = (time, frequency) => dB(toneLevel(samples, time, frequency) / AMPLITUDE);
  const [muffled, middle, open] = [1, 2.5, 3.5].map((time) => level(time, 8000));
  t.diagnostic(`8 kHz: ${muffled.toFixed(1)} dB at 1 s, ${middle.toFixed(1)} dB at 2.5 s, ${open.toFixed(1)} dB at 3.5 s; 300 Hz at 1 s: ${level(1, 300).toFixed(1)} dB`);
  // A 2-pole filter at 400 Hz takes 8 kHz down about 52 dB; at 2.5 s the cutoff is about 2.8 kHz (about -18 dB).
  assert.ok(muffled < -40, `the highs are gone while muffled (${muffled.toFixed(1)} dB)`);
  assert.ok(middle > -25 && middle < -12, `halfway through the sweep the highs are partly back (${middle.toFixed(1)} dB)`);
  assert.ok(Math.abs(open) < 0.5, `the highs are back when open (${open.toFixed(1)} dB)`);
  assert.ok(Math.abs(level(1, 300)) < 3, "the lows play while muffled");
  assert.ok(Math.abs(level(3.5, 300)) < 0.5, "the lows are unchanged when open");
});
