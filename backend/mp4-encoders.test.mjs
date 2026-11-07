import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportScene } from "./export.mjs";
import { MP4_ENCODERS } from "../engine/mp4Encoders.js";
import { getMp4Encoders } from "./mp4-encoders.mjs";

const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} failed (${code ?? signal}): ${stderr.trim()}`));
    });
  });
}

async function probe(path) {
  const output = await run(ffprobe, [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,sample_rate,channels,bit_rate,duration",
    "-of", "json", path,
  ]);
  return JSON.parse(output.toString("utf8")).streams;
}

function rectangle(id, values = {}) {
  return {
    id,
    name: id,
    type: "rectangle",
    parentId: null,
    x: 4,
    y: 20,
    width: 8,
    height: 12,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    fill: "#f00000",
    stroke: "none",
    strokeWidth: 0,
    radius: 0,
    visible: true,
    locked: false,
    blur: 0,
    blendMode: "normal",
    isMask: false,
    shadow: null,
    text: "",
    fontFamily: "Inter",
    fontSize: 10,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: "left",
    path: "",
    src: "",
    mediaStart: 0,
    mediaDuration: 0,
    volume: 1,
    animations: [],
    ...values,
  };
}

function animatedScene(audioSrc = "/api/media/tone.wav") {
  return {
    id: "mp4-encoder-test",
    name: "Encoder verification",
    width: 64,
    height: 64,
    duration: 0.4,
    background: "#102030",
    layers: [
      rectangle("moving", {
        animations: [{
          id: "move",
          name: "Move",
          kind: "custom",
          start: 0,
          duration: 0.4,
          easing: "linear",
          from: { x: 4 },
          to: { x: 44 },
          unit: "layer",
          stagger: 0,
          order: "forward",
        }],
      }),
      rectangle("tone", {
        type: "audio",
        src: audioSrc,
        mediaStart: 0,
        mediaDuration: 0.4,
        volume: 1,
      }),
    ],
  };
}

function assertMovingFrames(rgb, width, height, expectedFrames) {
  const frameBytes = width * height * 3;
  assert.equal(rgb.length % frameBytes, 0, "video decode contains complete RGB frames");
  const frameCount = rgb.length / frameBytes;
  assert.equal(frameCount, expectedFrames);
  const centers = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * frameBytes;
    let totalX = 0;
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = offset + (y * width + x) * 3;
        if (rgb[pixel] > 150 && rgb[pixel + 1] < 100 && rgb[pixel + 2] < 100) {
          totalX += x;
          count += 1;
        }
      }
    }
    assert.ok(count > 20, `frame ${frame} retains the moving red shape`);
    centers.push(totalX / count);
  }
  assert.ok(centers.at(-1) - centers[0] > 15, `decoded red shape moves across the composition (${centers.join(", ")})`);
}

async function decodeVideo(path) {
  return run(ffmpeg, [
    "-v", "error", "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
}

async function decodeAudio(path, channels = 1) {
  return run(ffmpeg, [
    "-v", "error", "-i", path, "-map", "0:a:0", "-f", "f32le", "-ac", String(channels), "-ar", "48000", "pipe:1",
  ]);
}

function windowRms(pcm, channels, channel = 0, start = 0.1, end = 0.3) {
  const first = Math.round(start * 48_000);
  const last = Math.round(end * 48_000);
  let sum = 0;
  let count = 0;
  for (let sample = first; sample < last; sample += 1) {
    const value = pcm.readFloatLE((sample * channels + channel) * 4);
    sum += value * value;
    count += 1;
  }
  return Math.sqrt(sum / count);
}

function toneAmplitude(pcm, channels, channel, frequency, start = 0.1, end = 0.3) {
  const first = Math.round(start * 48_000);
  const last = Math.round(end * 48_000);
  let sine = 0;
  let cosine = 0;
  for (let sample = first; sample < last; sample += 1) {
    const value = pcm.readFloatLE((sample * channels + channel) * 4);
    const phase = 2 * Math.PI * frequency * sample / 48_000;
    sine += value * Math.sin(phase);
    cosine += value * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (last - first);
}

test("every available MP4 alternative produces the requested real video and audio profile", async (t) => {
  const available = await getMp4Encoders();
  const software = available.filter((id) => id.includes("Sw"));
  assert.ok(software.length > 0, "FFmpeg must expose at least one working software H.264 candidate");
  const parent = await mkdtemp(join(tmpdir(), "kino-mp4-encoders-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const mediaRoot = join(parent, "media");
  await mkdir(mediaRoot);
  const audioPath = join(mediaRoot, "tone.wav");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000:duration=0.4",
    "-ac", "1", "-c:a", "pcm_s16le", audioPath,
  ]);
  const sourceMono = await decodeAudio(audioPath, 1);
  const sourceMonoRms = windowRms(sourceMono, 1);
  for (const id of available) {
    const metadata = MP4_ENCODERS.find((encoder) => encoder.id === id);
    assert.ok(metadata, `${id} is a declared client option`);
    const exported = await exportScene(animatedScene(), {
      format: "mp4",
      mp4Encoder: id,
      fps: 15,
      width: 64,
      height: 64,
    }, { mediaRoot });
    assert.equal(exported.mp4Encoder, id);
    const path = join(parent, `${id}.mp4`);
    await writeFile(path, exported.buffer);
    const streams = await probe(path);
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");

    assert.ok(video, `${id} has a real video stream`);
    assert.ok(audio, `${id} has a real audio stream`);
    assert.equal(video.codec_name, "h264");
    if (metadata.profile === "baseline") assert.match(video.profile, /baseline/i, `${id} uses the requested baseline profile`);
    else assert.equal(video.profile, metadata.profile[0].toUpperCase() + metadata.profile.slice(1), `${id} uses the requested ${metadata.profile} profile`);
    assert.deepEqual([Number(video.width), Number(video.height)], [64, 64]);
    assert.equal(video.avg_frame_rate, "15/1");
    assert.equal(Number(video.nb_read_frames), 6);
    assert.equal(audio.codec_name, metadata.audio);
    assert.equal(Number(audio.sample_rate), 48000);
    assert.equal(Number(audio.channels), 2);
    assert.ok(Number.isFinite(Number(audio.bit_rate)) && Number(audio.bit_rate) > 0 && Number(audio.bit_rate) <= 256_000,
      `${id} reports a positive, bounded average audio bitrate (reported ${audio.bit_rate})`);

    assertMovingFrames(await decodeVideo(path), 64, 64, 6);
    const decodedAudio = await decodeAudio(path, 2);
    assert.ok(decodedAudio.length > 4800 * 2 * 4, `${id} decodes nonempty stereo tone samples`);
    let peak = 0;
    for (let offset = 0; offset + 4 <= decodedAudio.length; offset += 4) {
      peak = Math.max(peak, Math.abs(decodedAudio.readFloatLE(offset)));
    }
    assert.ok(peak > 0.01, `${id} contains nonzero tone samples`);
    const leftRms = windowRms(decodedAudio, 2, 0);
    const rightRms = windowRms(decodedAudio, 2, 1);
    for (const [channel, rms] of [["left", leftRms], ["right", rightRms]]) {
      assert.ok(Math.abs(rms - sourceMonoRms) / sourceMonoRms < 0.12,
        `${id} duplicates mono tone to ${channel} without attenuation (source ${sourceMonoRms.toFixed(4)}, output ${rms.toFixed(4)})`);
    }
    assert.ok(Math.abs(leftRms - rightRms) / Math.max(leftRms, rightRms) < 0.04,
      `${id} has matched left/right levels (${leftRms.toFixed(4)} vs ${rightRms.toFixed(4)})`);
  }

  const candidates = MP4_ENCODERS.filter((encoder) => !available.includes(encoder.id));
  const unavailableHardware = candidates.filter((encoder) => encoder.hardware);
  if (unavailableHardware.length) {
    t.diagnostic(`Hardware-only candidates not advertised on this host: ${unavailableHardware.map(({ id }) => id).join(", ")}`);
  }
});

test("stereo audio keeps distinct channel frequencies and levels through software AAC MP4", async (t) => {
  const available = await getMp4Encoders();
  const id = available.find((candidate) => candidate.includes("Sw") && candidate.endsWith("AAC"));
  if (!id) return t.skip("No supported software AAC MP4 candidate is available on this host.");

  const parent = await mkdtemp(join(tmpdir(), "kino-mp4-stereo-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const mediaRoot = join(parent, "media");
  await mkdir(mediaRoot);
  const audioPath = join(mediaRoot, "tone.wav");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
    "-i", "aevalsrc=0.08*sin(2*PI*440*t)|0.16*sin(2*PI*880*t):s=48000:d=0.4:c=stereo",
    "-ac", "2", "-c:a", "pcm_s16le", audioPath,
  ]);

  const source = await decodeAudio(audioPath, 2);
  const sourceLeftRms = windowRms(source, 2, 0);
  const sourceRightRms = windowRms(source, 2, 1);
  const sourceLeft440 = toneAmplitude(source, 2, 0, 440);
  const sourceLeft880 = toneAmplitude(source, 2, 0, 880);
  const sourceRight440 = toneAmplitude(source, 2, 1, 440);
  const sourceRight880 = toneAmplitude(source, 2, 1, 880);
  assert.ok(sourceRightRms > sourceLeftRms * 1.8, "the generated right channel starts louder");
  assert.ok(sourceLeft440 > sourceLeft880 * 8, "left source channel contains 440 Hz");
  assert.ok(sourceRight880 > sourceRight440 * 8, "right source channel contains 880 Hz");

  const exported = await exportScene(animatedScene(), {
    format: "mp4", mp4Encoder: id, fps: 15, width: 64, height: 64,
  }, { mediaRoot });
  const path = join(parent, "stereo.mp4");
  await writeFile(path, exported.buffer);
  const audio = (await probe(path)).find((stream) => stream.codec_type === "audio");
  assert.equal(Number(audio.channels), 2);
  assert.equal(Number(audio.sample_rate), 48_000);

  const decoded = await decodeAudio(path, 2);
  const leftRms = windowRms(decoded, 2, 0);
  const rightRms = windowRms(decoded, 2, 1);
  assert.ok(Math.abs(leftRms - sourceLeftRms) / sourceLeftRms < 0.12,
    `left channel level is preserved (${sourceLeftRms.toFixed(4)} to ${leftRms.toFixed(4)})`);
  assert.ok(Math.abs(rightRms - sourceRightRms) / sourceRightRms < 0.12,
    `right channel level is preserved (${sourceRightRms.toFixed(4)} to ${rightRms.toFixed(4)})`);
  assert.ok(rightRms > leftRms * 1.8, "the right channel remains louder after export");
  const left440 = toneAmplitude(decoded, 2, 0, 440);
  const left880 = toneAmplitude(decoded, 2, 0, 880);
  const right440 = toneAmplitude(decoded, 2, 1, 440);
  const right880 = toneAmplitude(decoded, 2, 1, 880);
  assert.ok(left440 > left880 * 8, "440 Hz remains isolated to the left channel");
  assert.ok(right880 > right440 * 8, "880 Hz remains isolated to the right channel");
});

test("MP4 encoder IDs reject unknown or unavailable choices and options stay format-specific", async (t) => {
  const sample = animatedScene();
  await assert.rejects(exportScene(sample, { format: "mp4", mp4Encoder: "h264DefinitelyNotReal" }), /Unknown MP4 encoder/);
  await assert.rejects(exportScene(sample, { format: "webm", mp4Encoder: "h264HighSwAAC" }), /MP4 encoder settings apply only to MP4/);

  const available = await getMp4Encoders();
  const unavailable = MP4_ENCODERS.find((entry) => !available.includes(entry.id));
  if (unavailable) {
    await assert.rejects(
      exportScene(sample, { format: "mp4", mp4Encoder: unavailable.id }),
      /encoder .* is unavailable on this computer/,
    );
  } else {
    t.diagnostic("All declared MP4 alternatives are available on this host.");
  }
});

test("the final MP4 fallback encodes CRF 15 video and AAC with matching track durations", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "kino-mp4-fallback-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const mediaRoot = join(parent, "media");
  await mkdir(mediaRoot);
  const audioPath = join(mediaRoot, "tone.wav");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000:duration=0.4",
    "-ac", "1", "-c:a", "pcm_s16le", audioPath,
  ]);
  const sourceRms = windowRms(await decodeAudio(audioPath), 1);
  const sample = { ...animatedScene(), width: 160, height: 90 };
  const output = await exportScene(sample, { profile: "mp4.alt", size: "1x", fps: 25 }, { mediaRoot });
  assert.equal(output.mp4Encoder, "mp4.alt");
  assert.equal(output.mime, "video/mp4");
  assert.match(output.buffer.toString("latin1"), /rc=crf .*crf=15\.0/, "encoded H.264 SEI reports the separate CRF fallback");
  const path = join(parent, "fallback.mp4");
  await writeFile(path, output.buffer);
  const streams = await probe(path);
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.profile, "High");
  assert.deepEqual([video.width, video.height, video.avg_frame_rate, Number(video.nb_read_frames)], [160, 90, "25/1", 10]);
  assert.equal(Number(video.duration), 0.4);
  assert.equal(audio.codec_name, "aac");
  assert.equal(audio.profile, "LC");
  assert.equal(Number(audio.sample_rate), 48_000);
  assert.equal(audio.channels, 2);
  assert.equal(Number(audio.duration), 0.4);
  assertMovingFrames(await decodeVideo(path), 160, 90, 10);
  const decoded = await decodeAudio(path, 2);
  for (const channel of [0, 1]) {
    assert.ok(Math.abs(windowRms(decoded, 2, channel) - sourceRms) / sourceRms < 0.12,
      `fallback channel ${channel} preserves the original mono level`);
  }
  await assert.rejects(exportScene(sample, { profile: "mp4.alt", mp4Encoder: "h264HighSwOpus" }), /fallback uses its own encoder/);
});
