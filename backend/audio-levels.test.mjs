// The master limiter, the sound level meter, and what the render reply says about the sound.
// Every sound here is synthesized: a 440 Hz tone at about -6 dBFS after half a second of silence,
// or stereo pink noise peaking at -0.3 dBFS. AAC and Opus barely change a pure tone, but they push
// dense sound like noise back up past the limiter's ceiling, so the noise tests check that case.
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { createAgentClient } from "./agent/client.mjs";
import { describeLevels, describeMixPeaks, limiterPlaces, loudMixWarning, loudnessGain, mixLead, readLevels, readPeakWindows } from "./audio-levels.mjs";
import { createLoudnessCurves, measureLoudnessCurve, readMomentary } from "./loudness-curve.mjs";
import { exportScene, measureMixPeaks, sceneSoundClips } from "./export.mjs";
import { ffmpeg, makeToneAfterSilence, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { validateRenderFile } from "./render-validation.mjs";

// Integrated loudness and true peak from FFmpeg's EBU R128 summary, measured apart from the meter under test.
function summary(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"]);
    let log = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { log += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve({ lufs: Number(log.match(/Integrated loudness:\s+I:\s+(\S+) LUFS/)[1]),
      peak: Number(log.match(/True peak:\s+Peak:\s+(\S+) dBFS/)[1]) }) : reject(new Error(log))));
  });
}
const truePeak = async (file) => (await summary(file)).peak;

async function samples(file) {
  const raw = await run(ffmpeg, ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

/**
 * Writes `seconds` of stereo 16-bit pink noise at 48 kHz whose sample peak is `peakDb` dBFS.
 * Each channel is white noise from a seeded generator, shaped to pink with Paul Kellet's filter.
 */
async function makePinkNoise(path, { seconds, peakDb = -0.3 }) {
  const rate = 48000, frames = seconds * rate;
  let seed = 1;
  const white = () => { // mulberry32: the same noise on every run
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 31 - 1;
  };
  const channels = [new Float64Array(frames), new Float64Array(frames)];
  for (const channel of channels) {
    const b = [0, 0, 0, 0, 0, 0, 0];
    for (let index = 0; index < frames; index += 1) {
      const w = white();
      b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
      b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
      channel[index] = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
      b[6] = w * 0.115926;
    }
  }
  const largest = Math.max(...channels.map((channel) => channel.reduce((most, value) => Math.max(most, Math.abs(value)), 0)));
  const scale = (32767 * 10 ** (peakDb / 20)) / largest;
  const data = Buffer.alloc(frames * 4);
  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(channels[0][index] * scale), index * 4);
    data.writeInt16LE(Math.round(channels[1][index] * scale), index * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
  return path;
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-audio-levels-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  await makeToneAfterSilence(join(mediaRoot, "tone.wav"), { silence: 0.5, tone: 1 });
  await makePinkNoise(join(mediaRoot, "noise.wav"), { seconds: 2 });
  return { root, mediaRoot };
}

function toneScene(volumes) {
  return createScene({ id: "sound", name: "Sound", width: 32, height: 32, duration: 2, background: "#000000",
    layers: volumes.map((volume, index) => createLayer("audio", { id: `tone-${index + 1}`, name: `Tone ${index + 1}`,
      src: "/api/media/tone.wav", volume })) });
}

const FORMATS = [["mp4", { profile: "mp4.alt" }], ["webm", { format: "webm" }], ["mov", { format: "mov" }]];

test("the loudness curve puts each momentary value at its 400 ms window's middle", () => {
  // FFmpeg stamps the frame at pts_time T with the window T - 0.3 to T + 0.1 (a tone starting at
  // 2 s first shows at T = 2, a quarter of the window): its middle is T - 0.1.
  const printed = [[1.9, "-163.5"], [2, "-29.0"], [2.1, "-26.0"], [2.2, "-24.3"], [2.3, "-23.0"], [2.4, "nan"]]
    .map(([time, value], frame) => `frame:${frame} pts:0 pts_time:${time}\nlavfi.r128.M=${value}`).join("\n");
  const curve = readMomentary(printed);
  assert.deepEqual(curve.momentary.slice(18), [null, -29, -26, -24.3, -23, null]);
  assert.equal(curve.step, 0.1);
});

test("a sound shorter than a loudness window is read once silence pads it (place_sounds)", { skip: skipWithoutMediaTools }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "kino-pad-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "click.wav");
  await makeToneAfterSilence(file, { silence: 0, tone: 0.1 });
  const loudest = (curve) => Math.max(-Infinity, ...curve.momentary.filter(Number.isFinite));
  const padded = loudest(await measureLoudnessCurve(file, undefined, { pad: 0.4 }));
  // 0.1 s of a -6 dBFS tone in a 400 ms window: about 6 LU under the tone's own level (-9 LUFS).
  assert.ok(padded > -20 && padded < -10, `padded ${padded}`);
  assert.ok(!(loudest(await measureLoudnessCurve(file)) >= padded));
});

test("one caller cancelling a loudness measurement stops only its own wait; the last one cancelling stops the measurement", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kino-lufs-"));
  try {
    const runs = [];
    const curves = createLoudnessCurves({ measure: (file, signal) => new Promise((resolve, reject) => {
      const run = { file, signal, finish: () => resolve({ version: 1, step: 0.1, duration: 0.1, momentary: [-20] }) };
      runs.push(run);
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    }) });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const first = new AbortController(), second = new AbortController();
    const a = curves.get(join(folder, "a.wav"), first.signal), b = curves.get(join(folder, "a.wav"), second.signal);
    await tick();
    first.abort();
    await assert.rejects(a, { name: "AbortError" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].signal.aborted, false, "the other caller still waits");
    runs[0].finish();
    assert.deepEqual((await b).momentary, [-20]);
    // When every caller cancels, the measurement stops.
    const third = new AbortController();
    const c = curves.get(join(folder, "c.wav"), third.signal);
    await tick();
    third.abort();
    await assert.rejects(c, { name: "AbortError" });
    assert.equal(runs[1].signal.aborted, true);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a file the loudness measurement failed on is not measured again for ten minutes; a cancelled one is", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kino-lufs-"));
  try {
    let tries = 0;
    let clock = 0;
    const curves = createLoudnessCurves({ now: () => clock, measure: async () => { tries += 1; throw new Error("Stream map '0:a:0' matches no streams."); } });
    const file = join(folder, "silent.mp4");
    await assert.rejects(curves.get(file), /matches no streams/);
    await assert.rejects(curves.get(file), /matches no streams/);
    assert.equal(tries, 1);
    clock = 11 * 60_000;
    await assert.rejects(curves.get(file));
    assert.equal(tries, 2);

    let cancels = 0;
    const cancelled = createLoudnessCurves({ measure: async () => { cancels += 1; throw Object.assign(new Error("cancelled"), { name: "AbortError" }); } });
    await assert.rejects(cancelled.get(file));
    await assert.rejects(cancelled.get(file));
    assert.equal(cancels, 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("the meter reads loudness, true peak and the loudest moment from FFmpeg's printout", () => {
  const printed = [
    "frame:0    pts:0       pts_time:0", "lavfi.r128.I=-70.000", "lavfi.r128.true_peaks_ch0=0.100", "lavfi.r128.true_peak=0.100",
    "frame:1    pts:4800    pts_time:0.1", "lavfi.r128.I=-12.300", "lavfi.r128.true_peak=1.600",
    "frame:42   pts:201600  pts_time:4.2", "lavfi.r128.I=-11.040", "lavfi.r128.LRA=4.270", "lavfi.r128.true_peak=1.601",
  ].join("\n");
  assert.deepEqual(readLevels(printed), { integratedLufs: -11, loudnessRangeLu: 4.3, truePeakDbtp: 4.1, loudestAt: 0.1 });
  // Older FFmpeg prints only the per-channel keys.
  assert.equal(readLevels("frame:0 pts:0 pts_time:0\nlavfi.r128.true_peaks_ch0=0.5\nlavfi.r128.true_peaks_ch1=0.25").truePeakDbtp, -6);
  // Under about 4 s of sound the loudness range is left out.
  assert.equal(readLevels("frame:0 pts:0 pts_time:2.9\nlavfi.r128.I=-20\nlavfi.r128.LRA=20\nlavfi.r128.true_peak=0.5").loudnessRangeLu, null);
  assert.deepEqual(readLevels("frame:0 pts:0 pts_time:0\nlavfi.r128.I=-70.000\nlavfi.r128.true_peak=0.000"),
    { integratedLufs: null, loudnessRangeLu: null, truePeakDbtp: null, loudestAt: null });
  // One plain gain to the target; where the limiter would take peaks down more than 6 dB the gain
  // holds there, so the mix keeps its balance and names the peak that held it.
  assert.deepEqual(loudnessGain({ integratedLufs: -24, truePeakDbtp: -12 }, "web"),
    { target: "web", targetLufs: -14, gainDb: 10, correction: 0, capped: false, held: false, loudestAt: null, filter: "volume=10dB" });
  assert.deepEqual(loudnessGain({ integratedLufs: -30, truePeakDbtp: -6, loudestAt: 2.4 }, "podcast", 0.4),
    { target: "podcast", targetLufs: -16, gainDb: 11, correction: 0.4, capped: false, held: true, loudestAt: 2.4, filter: "volume=11dB" });
  assert.deepEqual(loudnessGain({ integratedLufs: -45, truePeakDbtp: -30 }, "web"),
    { target: "web", targetLufs: -14, gainDb: 20, correction: 0, capped: true, held: false, loudestAt: null, filter: "volume=20dB" });
  assert.equal(loudnessGain({ integratedLufs: -24, truePeakDbtp: -12 }, "off"), null);
  assert.equal(loudnessGain({ integratedLufs: null, truePeakDbtp: null }, "web"), null);
  assert.equal(describeLevels({ integratedLufs: -14.1, loudnessRangeLu: 4.2, truePeakDbtp: -1.1 }, { target: "web", targetLufs: -14, held: false }),
    "-14.1 LUFS (target -14 web), range 4.2 LU, true peak -1.1 dBTP");
  assert.equal(describeLevels({ integratedLufs: -17, truePeakDbtp: -1 }, { target: "web", targetLufs: -14, held: true, loudestAt: 2.4 }),
    "-17 LUFS (target -14 web, held under by the peak at 2.4 s: lower that sound to reach it), true peak -1 dBTP");
  // "auto": a song-led mix keeps the song's own level (run 8's shape: a 15 s song at -11.7 and 1.85 s of voice),
  // a voice-led one or a song under -14 gets the web's; with no song the answer carries no reason.
  const song = { seconds: 15, volume: 1, lufs: -11.7 };
  assert.deepEqual(mixLead({ duration: 20, songs: [song], voiceSeconds: 1.85 }), { target: "song", targetLufs: -11.7, why: "the song's own level, no voice leads" });
  assert.deepEqual(mixLead({ duration: 20, songs: [song], voiceSeconds: 9.2 }), { target: "web", targetLufs: -14, why: "a voice leads (9.2 s of words)" });
  assert.deepEqual(mixLead({ duration: 20, songs: [{ ...song, lufs: -19.2 }] }), { target: "web", targetLufs: -14, why: "the song (-19.2) is under -14" });
  assert.equal(mixLead({ duration: 20, songs: [{ ...song, seconds: 6 }] }).target, "web", "a song under half the video does not lead");
  assert.match(mixLead({ duration: 20, songs: [{ ...song, volume: 0.3 }] }).why, /a bed/, "a bed is not a song-led mix");
  assert.deepEqual(mixLead({ duration: 20, voiceSeconds: 12 }), { target: "web", targetLufs: -14 });
  // Fitting aims at the song's own level and says why; the gain, cap and hold are the web's.
  assert.deepEqual(loudnessGain({ integratedLufs: -14.1, truePeakDbtp: -3 }, "song", 0, -11.7, "the song's own level, no voice leads"),
    { target: "song", targetLufs: -11.7, gainDb: 2.4, correction: 0, capped: false, held: false, loudestAt: null, filter: "volume=2.4dB", why: "the song's own level, no voice leads" });
  assert.equal(describeLevels({ integratedLufs: -11.8, loudnessRangeLu: 6.2, truePeakDbtp: -1 }, { target: "song", targetLufs: -11.7, held: false, why: "the song's own level, no voice leads" }),
    "-11.8 LUFS (target -11.7 song: the song's own level, no voice leads), range 6.2 LU, true peak -1 dBTP");
  assert.equal(describeLevels({ integratedLufs: -14.2, truePeakDbtp: -1.1 }), "-14.2 LUFS, true peak -1.1 dBTP");
  assert.equal(describeLevels({ integratedLufs: -9, truePeakDbtp: 1.4 }), "-9 LUFS, true peak +1.4 dBTP (clips)");
  assert.equal(describeLevels({ integratedLufs: null, truePeakDbtp: null }), "silent");
});

test("the loud-mix warning names the moment and the sounds playing then, and stays quiet under +0.5 dBTP", () => {
  const clips = [
    { name: "Song", volume: 1, start: 0, end: 10 },
    { name: "Boom", volume: 0.9, start: 4, end: 5 },
    { name: "Outro", volume: 1, start: 8, end: 10 },
  ];
  const fitted = { ceiling: -3.2, truePeakDbtp: -1.2 };
  const warning = loudMixWarning({ truePeakDbtp: 3.3, loudestAt: 4.2 }, clips, fitted);
  assert.equal(warning.code, "audio-limited");
  assert.match(warning.message, /peaked at \+3\.3 dBTP at 4\.2 s\. The master limiter turned it down about 6\.5 dB there to stop clipping\./);
  assert.match(warning.message, /Playing then: Song at volume 1, Boom at volume 0\.9\./);
  assert.doesNotMatch(warning.message, /Outro/);
  assert.match(warning.message, /by about 5 dB \(multiply by 0\.56\)/);
  // When even the lowest ceiling tried leaves the encoded sound clipping, the warning says so.
  const stillClips = loudMixWarning({ truePeakDbtp: 3.3, loudestAt: 4.2 }, clips, { ceiling: -6, truePeakDbtp: 0.4 });
  assert.match(stillClips.message, /turned it down about 9\.3 dB there, but the encoded sound still clips at \+0\.4 dBTP\./);
  assert.doesNotMatch(stillClips.message, /to stop clipping/);
  assert.equal(loudMixWarning({ truePeakDbtp: 0.4, loudestAt: 4.2 }, clips, fitted), null);
  assert.equal(loudMixWarning({ truePeakDbtp: null, loudestAt: null }, clips, fitted), null);
});

test("the limiter places: each 0.1 s peak over the ceiling, near ones joined, timed where the peak is first reached", () => {
  const printed = [[0, "-20"], [0.1, "-1.2"], [0.2, "-0.4"], [0.3, "-0.45"], [0.4, "-9"], [2, "3.1"], [2.1, "-inf"]]
    .map(([t, peak]) => `frame:0 pts:0 pts_time:${t}\nlavfi.r128.I=-11.2\nlavfi.r128.true_peak=1.43\nlavfi.astats.1.Peak_level=${peak}\nlavfi.astats.2.Peak_level=${peak === "-inf" ? peak : -30}`).join("\n");
  const levels = readPeakWindows(printed);
  assert.equal(levels.integratedLufs, -11.2);
  assert.equal(levels.truePeakDbtp, 3.1);
  assert.equal(levels.windows.length, 6, "a silent window (-inf) is left out");
  const places = limiterPlaces(levels.windows);
  assert.deepEqual(places, [
    { at: 0.2, from: 0.1, to: 0.4, peakDbtp: -0.4, overDb: 1.1, factor: 0.88 },
    { at: 2, from: 2, to: 2.1, peakDbtp: 3.1, overDb: 4.6, factor: 0.58 },
  ]);
  const mix = { integratedLufs: -11.2, truePeakDbtp: 3.1, places: places.map((place) => ({ ...place, playing: [{ name: "song", volume: 1 }, { name: "hit", volume: 0.55 }] })) };
  const line = describeMixPeaks(mix, { limit: 1, tail: "; all: look" });
  assert.match(line, /^mix: -11\.2 LUFS, true peak \+3\.1 dBTP .*works at 2 places, worst 1: 2 s \+3\.1 dBTP, 4\.6 dB over \(song 1, hit 0\.55\) x0\.58 .*; all: look$/);
  assert.match(describeMixPeaks({ ...mix, places: [] }), /the limiter \(ceiling -1\.5 dBFS\) never works$/);
});

test("measuring the mix finds every limiter place, and the loudest matches the render's own warning", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // Three tones at 0.5-1.5 s (+3.3 dBTP), then two at 2.5-3.5 s (-0.2 dBTP, under the render's
  // +0.5 warning but still limited).
  const scene = toneScene([1, 1, 1, 1, 1]);
  scene.duration = 4;
  scene.layers.forEach((layer, index) => Object.assign(layer, { mediaSourceDuration: 1.5, mediaStart: index < 3 ? 0 : 2 }));
  const directory = join(root, "clips");
  await mkdir(directory);
  const mix = await measureMixPeaks(await sceneSoundClips(scene, { mediaRoot, directory, duration: 4 }), 4);
  assert.deepEqual(mix.places.map((place) => [place.at, place.peakDbtp, place.playing.length]), [[0.5, 3.3, 3], [2.5, -0.2, 2]]);
  const result = await exportScene(scene, { profile: "mp4.alt", fps: 10 }, { mediaRoot, outputPath: join(root, "loud.mp4") });
  const [, peak, at] = result.warnings.find((entry) => entry.code === "audio-limited").message.match(/peaked at \+([\d.]+) dBTP at ([\d.]+) s/);
  assert.ok(Math.abs(Number(at) - mix.places[0].at) <= 0.1 && Math.abs(Number(peak) - mix.places[0].peakDbtp) <= 0.5, `render ${peak} at ${at}`);
});

test("a loud mix is limited to about -1 dBTP in MP4, WebM and MOV, and the export warns with the loudest moment", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // Three tones at -6 dBFS starting together sum to about +3.3 dBTP.
  const scene = toneScene([1, 1, 1]);
  const results = [];
  for (const [format, options] of FORMATS) {
    const outputPath = join(root, `loud.${format}`);
    const result = await exportScene(scene, { ...options, fps: 10 }, { mediaRoot, outputPath });
    const peak = await truePeak(outputPath);
    results.push(`${format} ${peak} dBTP`);
    assert.ok(peak <= -1, `${format}: the true peak ${peak} dBTP stays at or under -1 dBTP`);
    const warning = result.warnings?.find((entry) => entry.code === "audio-limited");
    assert.ok(warning, `${format}: the export warns that the limiter worked hard`);
    assert.match(warning.message, /peaked at \+3\.\d dBTP at 0\.5 s/);
    assert.match(warning.message, /Tone 1 at volume 1, Tone 2 at volume 1, Tone 3 at volume 1/);

    const validation = await validateRenderFile(outputPath, { format, width: 32, height: 32, fps: 10, frameCount: 20, duration: 2, hasAudio: true });
    assert.equal(validation.ok, true, JSON.stringify(validation.checks));
    assert.equal(validation.checks.audioPeak.status, "pass");
    assert.ok(Math.abs(validation.facts.audioLevels.truePeakDbtp - peak) <= 0.1, `${format}: the file check measures the same true peak`);
    assert.ok(validation.facts.audioLevels.integratedLufs < -1 && validation.facts.audioLevels.integratedLufs > -10);
  }
  t.diagnostic(results.join("; "));
});

test("dense, loud sound stays at or under -1 dBTP after AAC and Opus encoding", {
  skip: skipWithoutMediaTools, timeout: 60_000,
}, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // Two copies of the noise sum to about +5.7 dBTP. With the limiter's first -1.5 dBFS ceiling,
  // Opus brought this back up to +1 dBTP and AAC to +0.2 to +0.4 dBTP.
  const scene = createScene({ id: "noise", name: "Noise", width: 32, height: 32, duration: 2, background: "#000000",
    layers: ["Song", "Song copy"].map((name, index) => createLayer("audio", { id: `noise-${index + 1}`, name,
      src: "/api/media/noise.wav", volume: 1 })) });
  // WebM uses Opus; MP4 uses the computer's AAC encoder (AudioToolbox on a Mac), and its
  // mp4.alt fallback uses FFmpeg's own AAC encoder.
  const exports = [["webm", { format: "webm" }], ["mp4", { format: "mp4" }], ["mp4", { profile: "mp4.alt" }]];
  const results = [];
  for (const [format, options] of exports) {
    const outputPath = join(root, `noise-${results.length}.${format}`);
    const result = await exportScene(scene, { ...options, fps: 10 }, { mediaRoot, outputPath });
    const peak = await truePeak(outputPath);
    const label = `${format}${result.mp4Encoder ? ` ${result.mp4Encoder}` : ""}`;
    results.push(`${label} ${peak} dBTP`);
    assert.ok(peak <= -1, `${label}: the true peak ${peak} dBTP stays at or under -1 dBTP`);
    const warning = result.warnings?.find((entry) => entry.code === "audio-limited");
    assert.match(warning?.message ?? "", /peaked at \+[56]\.\d dBTP at [\d.]+ s\. The master limiter turned it down about \d+(\.\d)? dB there to stop clipping\. Playing then: Song at volume 1, Song copy at volume 1\./);

    const validation = await validateRenderFile(outputPath, { format, width: 32, height: 32, fps: 10, frameCount: 20, duration: 2, hasAudio: true });
    assert.equal(validation.ok, true, JSON.stringify(validation.checks));
    assert.equal(validation.checks.audioPeak.status, "pass", `${label}: ${JSON.stringify(validation.checks.audioPeak)}`);
  }
  t.diagnostic(results.join("; "));
});

test("a quiet mix passes the limiter unchanged and in step with the picture", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  const outputPath = join(root, "quiet.mov");
  // MOV keeps uncompressed sound, so the samples can be compared with the tone itself.
  const result = await exportScene(toneScene([0.5]), { format: "mov", fps: 10 }, { mediaRoot, outputPath });
  assert.equal(result.warnings?.some((entry) => entry.code === "audio-limited") ?? false, false);
  const sound = await samples(outputPath);
  const first = sound.findIndex((value) => Math.abs(value) > 0.01);
  assert.ok(Math.abs(first - 0.5 * 48000) <= 2, `the tone still starts at 0.5 s (sample ${first})`);
  let largest = 0;
  for (let index = first; index < 1.45 * 48000; index += 1) {
    const expected = 0.5 * (16000 / 32768) * Math.sin((2 * Math.PI * 440 * (index - 0.5 * 48000)) / 48000);
    largest = Math.max(largest, Math.abs(sound[index] - expected));
  }
  // 0.002 is -54 dBFS: the resampling around the limiter, far below hearing next to a -12 dBFS tone.
  assert.ok(largest < 0.002, `samples differ from the tone by at most ${largest}`);
});

test("sound more than a minute in stays in step through the limiter and AAC", { skip: skipWithoutMediaTools }, async (t) => {
  const { root, mediaRoot } = await setup(t);
  // 70 s of silence with a 2 ms click at 66 s, as AAC so FFmpeg decodes it 1024 samples at a time.
  // The export once numbered those samples' times one short at 64.064 s, and the limiter turned
  // that into a 5 ms jump in the AAC sound's timestamps: a player, which goes by them, played
  // everything after it 5 ms late.
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,66\\,66.002)\\,0.5\\,0):s=48000:c=stereo:d=70",
    "-c:a", "aac", "-b:a", "128k", join(mediaRoot, "click.m4a")]);
  const scene = createScene({ id: "long", name: "Long", width: 32, height: 32, duration: 70, background: "#000000",
    layers: [createLayer("audio", { id: "click", name: "Click", src: "/api/media/click.m4a" })] });
  const outputPath = join(root, "long.mp4");
  await exportScene(scene, { profile: "mp4.alt", fps: 1 }, { mediaRoot, outputPath });
  // The sound from 65 s by its timestamps, as a player seeking there would play it.
  const raw = await run(ffmpeg, ["-v", "error", "-i", outputPath, "-map", "0:a:0", "-af", "atrim=start=65,asetpts=PTS-STARTPTS",
    "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  const sound = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const click = 65 + sound.findIndex((value) => Math.abs(value) > 0.1) / 48000;
  assert.ok(Math.abs(click - 66) <= 0.0005, `the click plays at ${click.toFixed(5)} s, within 0.5 ms of 66 s`);
});

test("file checks warn, but still pass, when a file's sound clips", { skip: skipWithoutMediaTools }, async (t) => {
  const { root } = await setup(t);
  const file = join(root, "clipping.mov");
  // A tone at twice full scale in floating-point PCM: the true peak is about +6 dBTP.
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10:d=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-af", "volume=16", "-c:v", "prores_ks", "-c:a", "pcm_f32le", "-shortest", file]);
  const expected = { format: "mov", width: 32, height: 32, fps: 10, frameCount: 10, duration: 1, hasAudio: true };
  const validation = await validateRenderFile(file, { ...expected, targetLufs: -14 });
  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
  assert.equal(validation.checks.audioPeak.status, "warn");
  assert.ok(validation.facts.audioLevels.truePeakDbtp > 5, JSON.stringify(validation.facts.audioLevels));
  assert.match(validation.checks.audioPeak.detail, /clips/);
  // Far louder than the -14 LUFS target it was rendered for: audioLoudness warns too.
  assert.equal(validation.checks.audioLoudness.status, "warn");
  assert.match(validation.checks.audioLoudness.detail, /LU louder than the -14 LUFS target/);
  // A -0.5 dBTP peak does not clip but is over the web's -1 dBTP; without a target there is no loudness check.
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-af", "volume=0.94*8",
    "-c:v", "prores_ks", "-c:a", "pcm_f32le", "-shortest", file]);
  const near = await validateRenderFile(file, expected);
  assert.equal(near.checks.audioPeak.status, "warn", JSON.stringify(near.facts.audioLevels));
  assert.match(near.checks.audioPeak.detail, /over the web's -1 dBTP/);
  assert.equal(near.checks.audioLoudness, undefined);
});

test("the render reply gives the sound's loudness and true peak and warns about the loud moment", {
  skip: skipWithoutMediaTools, timeout: 120_000,
}, async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "audio-levels-test" });
  const agent = async (verb, body) => {
    const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
    const reply = await response.json();
    assert.notEqual(reply.isError, true, `${verb}: ${reply.text}`);
    return reply;
  };
  const project = "loud-mix";
  await agent("project", { action: "create", id: project, name: "Loud mix", width: 64, height: 32, duration: 2, background: "#000000" });
  // Two copies of a loud, dense "song" at volume 1 in WebM, whose Opus sound pushes peaks back up.
  const songPath = join(server.dataDirectory, "song.wav");
  await makePinkNoise(songPath, { seconds: 2 });
  const song = await client.importFile(songPath);
  const scene = (await (await server.api(`/api/projects/${project}`)).json()).document.scenes[0].id;
  await agent("edit", { project, ops: ["Song", "Song copy"].map((name) => ({ op: "add_layer", scene, layerType: "audio", name,
    properties: { src: song.src, volume: 1 } })) });

  // A draft is leveled to the web's -14 LUFS by default too, so the gain, not a warning, handles the loud mix.
  const leveled = await agent("render", { project, action: "start", quality: "draft", format: "webm" });
  const draft = await agent("render", { project, action: "wait", job: leveled.data.job, timeout_s: 60 });
  assert.match(draft.text, /sound: -1[34]\.?\d* LUFS \(target -14 web\)/);
  assert.equal(draft.data.files[0].validation.checks.audioLoudness, "pass");
  assert.doesNotMatch(draft.text, /The sound mix peaked/);

  const started = await agent("render", { project, action: "start", quality: "draft", format: "webm", options: { loudness: "off" } });
  const done = await agent("render", { project, action: "wait", job: started.data.job, timeout_s: 60 });
  assert.equal(done.data.status, "done", done.text);
  t.diagnostic(done.text);
  assert.match(done.text, /file checks passed(?! with warnings)/);
  assert.match(done.text, /sound: -\d+(\.\d)? LUFS(, range [\d.]+ LU)?, true peak -\d+(\.\d)? dBTP/);
  assert.match(done.text, /The sound mix peaked at \+[56]\.\d dBTP at [\d.]+ s\. The master limiter turned it down about [\d.]+ dB there to stop clipping\./);
  assert.match(done.text, /Playing then: Song at volume 1, Song copy at volume 1\./);
  assert.ok(done.data.files[0].validation.facts.audioLevels.truePeakDbtp <= -1);
  // check names the same peak without a render; look's sound map lists every place.
  const [, renderPeak] = done.text.match(/peaked at \+([\d.]+) dBTP/);
  const checked = await agent("check", { project, pixels: false });
  const mixLine = checked.text.split("\n").find((line) => line.startsWith("mix: "));
  t.diagnostic(mixLine);
  assert.match(mixLine, /the limiter \(ceiling -1\.5 dBFS\) works at \d+ places?.*\(Song 1, Song copy 1\) x0\.\d+/);
  assert.ok(Math.abs(Number(mixLine.match(/true peak \+([\d.]+) dBTP/)[1]) - Number(renderPeak)) <= 0.5, mixLine);
  const sound = await agent("look", { project, mode: "motion", ref: "sound" });
  assert.match(sound.text, /\nlimiter: .*works at \d+ place/);
});

test("a final render brings a quiet mix to the web's -14 LUFS, and holds a peaky one quieter, naming the peak", { skip: skipWithoutMediaTools, timeout: 120_000 }, async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "loudness-test" });
  const agent = async (verb, body) => {
    const reply = await (await server.api(`/api/agent/${verb}`, { method: "POST", body })).json();
    assert.notEqual(reply.isError, true, `${verb}: ${reply.text}`);
    return reply;
  };
  // Renders one track as a final video through the agent API and checks it lands within 0.5 LU of
  // -14, or, `held`, quieter with the reply naming the peak that held the gain.
  const finalRender = async (project, file, duration, format, expected, held = false) => {
    const before = await summary(file);
    await agent("project", { action: "create", id: project, name: project, width: 64, height: 32, duration, background: "#000000" });
    const track = await client.importFile(file);
    const scene = (await (await server.api(`/api/projects/${project}`)).json()).document.scenes[0].id;
    await agent("edit", { project, ops: [{ op: "add_layer", scene, layerType: "audio", name: "Voice", properties: { src: track.src, volume: 1 } },
      ...["review", "reference"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a sound test" }))] });
    const started = await agent("render", { project, action: "start", quality: "final", format });
    const done = await agent("render", { project, action: "wait", job: started.data.job, timeout_s: 90 });
    assert.equal(done.data.status, "done", done.text);
    t.diagnostic(`${project}: ${before.lufs} LUFS, ${before.peak} dBTP in; ${done.text.match(/sound: [^·]+/)?.[0]}`);
    assert.match(done.text, expected);
    // kino's own gain set the peaks, so the reply does not ask for lower clip volumes.
    assert.doesNotMatch(done.text, /no target LUFS|The sound mix peaked/);
    const after = await summary(done.data.files[0].path);
    if (held) assert.match(done.text, /The peak at [\d.]+ s held the gain so the mix keeps its balance/);
    else {
      assert.doesNotMatch(done.text, /from the -14 LUFS target/);
      assert.ok(Math.abs(after.lufs + 14) <= 0.5, `${project} lands at ${after.lufs} LUFS, within 0.5 LU of -14`);
    }
    assert.ok(after.peak <= -1, `${project}'s true peak ${after.peak} dBTP stays at or under -1 dBTP`);
    return before;
  };
  // A quiet "voice over room tone": a 220 Hz sine with pink noise under it, far under -14 LUFS. Plain gain.
  const quiet = join(server.dataDirectory, "quiet.wav");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4.5",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=48000:amplitude=0.05:duration=4.5:seed=7",
    "-filter_complex", "[0]volume=0.2[s];[s][1]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0", quiet]);
  const before = await finalRender("quiet", quiet, 4.5, "webm", /sound: -1[34]\.?\d* LUFS \(target -14 web\), range [\d.]+ LU, true peak -\d+(\.\d)? dBTP/);
  assert.ok(before.lufs < -24, `the track starts quiet (${before.lufs} LUFS)`);
  // A soft bed with a loud 20 ms click every second: plain gain would need far more than 6 dB of
  // limiting, so the gain holds and the file comes out quieter, naming the click that held it.
  const peaky = join(server.dataDirectory, "peaky.wav");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc=0.05*sin(2*PI*220*t)+if(lt(mod(t\\,1)\\,0.02)\\,0.6*sin(2*PI*440*t)\\,0):s=48000:d=6", "-ac", "2", peaky]);
  // Its clicks are a steady beat: the render finds that song itself (no beat op, no saved .beats
  // needed) and says why the web's target stands.
  await finalRender("peaky", peaky, 6, "mp4", /sound: -\d+(\.\d)? LUFS \(target -14 web: the song \(-\d+(\.\d)?\) is under -14, held under by the peak at [\d.]+ s/, true);
});
