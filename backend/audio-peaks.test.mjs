import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AUDIO_PEAK_VERSION } from "../engine/audioPeaks.js";
import { createLayer } from "../engine/model.js";
import { videoSyncState } from "../engine/mediaPlay.js";
import { createPeakAccumulator, createWavPeakAccumulator, createAudioPeaksCache, extractAudioPeaks } from "./audio-peaks.mjs";
import { ffmpeg, ffprobe, makeToneAfterSilence, run, skipWithoutMediaTools } from "./media.test.support.mjs";

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-peaks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("streaming PCM handles split bytes, stereo phase, partial bins and long-file compaction", () => {
  const pcm = Buffer.alloc(9 * 2 * 4);
  for (let i = 0; i < 9; i++) {
    pcm.writeFloatLE(i / 8, i * 8);
    pcm.writeFloatLE(-i / 8, i * 8 + 4);
  }
  const accumulator = createPeakAccumulator({ sampleRate: 4, channels: 2, peaksPerSecond: 2, maxPeaks: 4 });
  for (let offset = 0; offset < pcm.length; offset += 7) accumulator.write(pcm.subarray(offset, offset + 7));
  const data = accumulator.finish();
  assert.equal(data.duration, 2.25);
  assert.equal(data.secondsPerPeak, 1);
  assert.deepEqual(data.peaks, [0.375, 0.875, 1]);
});

test("float WAV headers supply the native rate across split chunks and padded metadata", () => {
  const header = Buffer.alloc(56);
  header.write("RIFF");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(1000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.write("JUNK", 36);
  header.writeUInt32LE(3, 40);
  header.write("data", 48);
  header.writeUInt32LE(0xffffffff, 52);
  const pcm = Buffer.alloc(40 * 8);
  for (let frame = 0; frame < 40; frame++) {
    pcm.writeFloatLE(Math.floor(frame / 10) / 4, frame * 8);
    pcm.writeFloatLE(-Math.floor(frame / 10) / 4, frame * 8 + 4);
  }
  const bytes = Buffer.concat([header, pcm]);
  for (const size of [1, 7, 31, 64, bytes.length]) {
    const accumulator = createWavPeakAccumulator();
    for (let offset = 0; offset < bytes.length; offset += size) accumulator.write(bytes.subarray(offset, offset + size));
    const data = accumulator.finish();
    assert.equal(data.duration, 0.04);
    assert.equal(data.secondsPerPeak, 0.01);
    assert.deepEqual(data.peaks, [0, 1 / 3, 2 / 3, 1]);
  }
  for (const bad of [Buffer.from("not a WAV header"), header.subarray(0, 40), Buffer.alloc(12)]) {
    const accumulator = createWavPeakAccumulator();
    accumulator.write(bad);
    assert.equal(accumulator.finish().available, false);
  }
});

test("disk cache survives a new cache instance and concurrent requests extract once", async (t) => {
  const filename = path.join(await temporary(t), "clip.wav");
  const data = { version: AUDIO_PEAK_VERSION, available: true, duration: 0.02, secondsPerPeak: 0.01, peaks: [0, 1] };
  let calls = 0;
  const extract = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return data; };
  const cache = createAudioPeaksCache({ extract });
  const values = await Promise.all([cache.get(filename), cache.get(filename)]);
  assert.deepEqual(values, [data, data]);
  assert.equal(calls, 1);
  const before = (await stat(`${filename}.peaks`)).mtimeMs;
  assert.deepEqual(await createAudioPeaksCache({ extract }).get(filename), data);
  assert.equal(calls, 1, "a disk hit never starts FFmpeg");
  assert.equal((await stat(`${filename}.peaks`)).mtimeMs, before);
});

test("old extraction sidecars regenerate once, including cached unavailable results", async (t) => {
  const directory = await temporary(t);
  const data = { version: AUDIO_PEAK_VERSION, available: true, duration: 0.02, secondsPerPeak: 0.01, peaks: [0, 1] };
  let calls = 0;
  const extract = async () => { calls++; return data; };
  for (const available of [true, false]) {
    const filename = path.join(directory, `${available}.wav`);
    await writeFile(`${filename}.peaks`, JSON.stringify({ data: { ...data, version: 1, available }, retryAt: Date.now() + 60_000 }));
    assert.deepEqual(await createAudioPeaksCache({ extract }).get(filename), data);
    const count = calls;
    assert.deepEqual(await createAudioPeaksCache({ extract }).get(filename), data);
    assert.equal(calls, count, "the regenerated format is a disk hit");
    assert.equal(JSON.parse(await readFile(`${filename}.peaks`, "utf8")).data.version, AUDIO_PEAK_VERSION);
  }
  assert.equal(calls, 2);
});

test("missing FFmpeg and files without audio are quiet unavailable results, cached for repeat requests", async (t) => {
  const filename = path.join(await temporary(t), "clip.wav");
  const result = await extractAudioPeaks(filename, { command: path.join(path.dirname(filename), "missing-ffmpeg") });
  assert.equal(result.available, false);
  assert.equal(result.reason, "missing-tool");
  let calls = 0;
  const cache = createAudioPeaksCache({ extract: async () => { calls++; return result; } });
  assert.equal((await cache.get(filename)).available, false);
  assert.equal((await cache.get(filename)).available, false);
  assert.equal(calls, 1);
  assert.equal((await cache.get(`${filename}-silent`, { hasAudio: false })).reason, "no-audio");
  assert.equal(calls, 1);
});

test("a generated tone has 100 peaks per second, silence stays zero and quiet audio normalizes", { skip: skipWithoutMediaTools }, async (t) => {
  const directory = await temporary(t);
  const filename = await makeToneAfterSilence(path.join(directory, "tone.wav"), { silence: 0.5, tone: 1.5 });
  const data = await extractAudioPeaks(filename);
  assert.equal(data.available, true);
  assert.equal(data.peaks.length, 200);
  assert.equal(data.duration, 2);
  assert.equal(data.secondsPerPeak, 0.01);
  assert.ok(data.peaks.slice(0, 45).every((peak) => peak === 0));
  assert.ok(data.peaks.slice(60).every((peak) => peak > 0.9));
  assert.equal(Math.max(...data.peaks), 1);
  assert.ok(new Set(data.peaks).size > 1);
  const silent = await makeToneAfterSilence(path.join(directory, "silence.wav"), { silence: 0.125, tone: 0 });
  const flat = await extractAudioPeaks(silent);
  assert.equal(flat.available, true);
  assert.equal(flat.peaks.length, 13);
  assert.ok(flat.peaks.every((peak) => peak === 0));
  assert.ok((await readFile(filename)).length > 44);
});

test("delayed video audio keeps the source clock at zero and nonzero Play offsets", { skip: skipWithoutMediaTools }, async (t) => {
  const directory = await temporary(t);
  for (const format of ["webm", "mp4"]) {
    await t.test(format, async () => {
      const filename = path.join(directory, `delayed.${format}`);
      await run(ffmpeg, [
        "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:r=10:d=4",
        "-itsoffset", "2", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-map", "0:v:0", "-map", "1:a:0",
        ...(format === "webm" ? ["-c:v", "libvpx-vp9", "-c:a", "libopus"]
          : ["-c:v", "libx264", "-bf", "0", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov"]),
        filename,
      ]);
      const data = await extractAudioPeaks(filename);
      assert.equal(data.available, true);
      assert.ok(data.duration > 2.9 && data.duration < 3.2, `audio ends at source second 3, got ${data.duration}`);
      // Fragmented AAC includes a tiny encoder-preroll packet at zero; it stays below the drawing floor.
      assert.ok(data.peaks.slice(0, 180).every((peak) => peak < 0.05), "no visible tone before source second 2");
      assert.ok(data.peaks.slice(5, 180).every((peak) => peak === 0), "the leading timestamp gap stays silent");
      assert.ok(data.peaks.slice(220, 280).every((peak) => peak > 0.5), "source seconds 2.2–2.8 contain the tone");
      for (const offset of [0, 1.5]) {
        const layer = createLayer("video", { mediaStart: 0.5, mediaOffset: offset, mediaDuration: 3.5 - offset, mediaSourceDuration: 4 });
        for (const sourceTime of [0.5, 1.75, 2.5, 3.25].filter((time) => time >= offset)) {
          const sceneTime = layer.mediaStart + sourceTime - offset;
          assert.equal(videoSyncState(layer, sceneTime, { playing: true }).sourceTime, sourceTime);
          const peak = data.peaks[Math.floor(sourceTime / data.secondsPerPeak)] ?? 0;
          if (sourceTime === 2.5) assert.ok(peak > 0.5, `offset ${offset}: sound at scene second ${sceneTime}`);
          else assert.equal(peak, 0, `offset ${offset}: silence at scene second ${sceneTime}`);
        }
      }
    });
  }
});

test("packet gaps and a shifted container origin preserve source-time silence", { skip: skipWithoutMediaTools }, async (t) => {
  const directory = await temporary(t);
  for (const origin of [0, 7]) {
    // Matroska with PCM: FFmpeg 6's libopus encoder (Linux CI) closes the gap by restamping
    // packets, so the file would have no gap to find.
    const filename = path.join(directory, `gaps-${origin}.mkv`);
    // The tone's own seconds 0.5 to 1.5 are cut out in the source, before -itsoffset moves it 0.5 s
    // later (scene 1 to 2): whether an -af filter's t counts that offset differs between FFmpeg versions.
    await run(ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:r=10:d=4",
      "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3,aselect=not(between(t\\,0.5\\,1.5))",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libvpx-vp9", "-c:a", "pcm_s16le", "-output_ts_offset", String(origin), filename,
    ]);
    // FFmpeg 6 (Linux CI) closes the gap while writing the file, so there is no gap to keep there.
    const packets = (await run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", filename])).toString()
      .trim().split("\n").map((line) => line.split(",").map(Number));
    const widestGap = Math.max(0, ...packets.slice(1).map(([start], index) => start - packets[index][0] - packets[index][1]));
    if (widestGap < 0.5) {
      t.diagnostic(`origin ${origin}: this FFmpeg wrote no packet gap (widest ${widestGap.toFixed(3)} s); skipped`);
      continue;
    }
    const data = await extractAudioPeaks(filename);
    assert.equal(data.available, true);
    assert.ok(data.duration > 3.4 && data.duration < 3.6, `origin ${origin}: duration ${data.duration}`);
    const columns = data.peaks;
    for (const index of [10, 120, 180, 360]) assert.equal(columns[index] ?? 0, 0, `origin ${origin}: silence at ${index / 100}`);
    for (const index of [70, 90, 220, 280, 320]) assert.ok(columns[index] > 0.5, `origin ${origin}: tone at ${index / 100}`);
  }
});

test("a sustained 10 kHz tone at 48 kHz stays visible between its boundary samples", { skip: skipWithoutMediaTools }, async (t) => {
  const filename = path.join(await temporary(t), "high-tone.wav");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=10000:sample_rate=48000:duration=0.2", "-c:a", "pcm_s16le", filename]);
  const data = await extractAudioPeaks(filename);
  assert.equal(data.available, true);
  assert.equal(data.peaks.length, 20);
  assert.equal(data.duration, 0.2);
  assert.ok(data.peaks.slice(2, -2).every((peak) => peak > 0.8), `sustained peaks must survive: middle = ${data.peaks[10]}`);
});
