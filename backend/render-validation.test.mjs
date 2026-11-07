import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import test from "node:test";
import { archivePngSequence } from "./png-sequence.mjs";
import { runExportProcess } from "./export-process.mjs";
import { validateRenderFile } from "./render-validation.mjs";

const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";
const hasMediaTools = [ffmpeg, ffprobe].every((command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0);

async function withDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-render-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function makePng(file, width = 16, height = 12, color = "#e63946") {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  await writeFile(file, await canvas.encode("png"));
  return file;
}

async function fakeFfprobe(t, directory, output) {
  const file = path.join(directory, "fake-ffprobe");
  await writeFile(file, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o700 });
  await chmod(file, 0o700);
  const previous = process.env.KINO_FFPROBE;
  process.env.KINO_FFPROBE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.KINO_FFPROBE;
    else process.env.KINO_FFPROBE = previous;
  });
  return file;
}

async function fakeFfprobeWithPackets(t, directory, streamMetadata, packets) {
  const file = path.join(directory, "fake-ffprobe-packets");
  const base = { format: { format_name: "apng" }, streams: [streamMetadata] };
  const packetResponse = { packets };
  const script = `#!/usr/bin/env node\nconst value = process.argv.includes("-show_packets") ? ${JSON.stringify(packetResponse)} : ${JSON.stringify(base)};\nprocess.stdout.write(JSON.stringify(value));\n`;
  await writeFile(file, script, { mode: 0o700 });
  await chmod(file, 0o700);
  const previous = process.env.KINO_FFPROBE;
  process.env.KINO_FFPROBE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.KINO_FFPROBE;
    else process.env.KINO_FFPROBE = previous;
  });
  return file;
}

const videoExpected = {
  format: "mp4", width: 16, height: 12, fps: 10, frameCount: 2, duration: 0.2, hasAudio: false,
};

test("Lottie validation checks the actual JSON canvas and ip/op timing", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "scene.json");
  await writeFile(file, JSON.stringify({ v: "5.12.2", w: 640, h: 360, fr: 15, ip: 0, op: 45, layers: [] }));

  const report = await validateRenderFile(file, {
    format: "lottie", width: 640, height: 360, fps: 15, frameCount: 45, duration: 3, hasAudio: false,
  });

  assert.equal(report.ok, true);
  assert.equal(report.method, "Lottie JSON structure");
  assert.equal(report.facts.duration, 3);
  assert.equal(report.checks.frameCount.status, "pass");
  assert.equal(report.checks.codec.status, "unsupported", "Lottie is not reported as a video codec");
});

test("invalid Lottie structure and empty output never receive a successful report", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "bad.json");
  await writeFile(file, JSON.stringify({ w: 0, h: 360, fr: 15, ip: 0, op: 45, layers: [] }));
  const expected = { format: "lottie", width: 640, height: 360, fps: 15, frameCount: 45, duration: 3 };
  const bad = await validateRenderFile(file, expected);
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.structure.status, "fail");

  await writeFile(file, "");
  const empty = await validateRenderFile(file, expected);
  assert.equal(empty.ok, false);
  assert.equal(empty.checks.nonEmpty.status, "fail");
});

test("malformed Lottie JSON propagates a specific validation error", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "broken.json");
  await writeFile(file, "{not-json");
  await assert.rejects(validateRenderFile(file, {
    format: "lottie", width: 640, height: 360, fps: 15, frameCount: 45, duration: 3,
  }), /Lottie render is not valid JSON/);
});

test("PNG still validation uses ffprobe for decoded dimensions, codec and single-frame count", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for render validation tests",
}, async (t) => {
  const directory = await withDirectory(t);
  const file = await makePng(path.join(directory, "still.png"));
  const report = await validateRenderFile(file, { format: "png", width: 16, height: 12, frameCount: 1, hasAudio: false });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.method, "ffprobe -count_frames");
  assert.equal(report.checks.codec.status, "pass");
  assert.equal(report.checks.frameCount.actual, 1);
  assert.equal(report.checks.frameRate.status, "unsupported");
  assert.equal(report.checks.duration.status, "unsupported");
});

test("a tiny real MP4 is decoded and checked against dimensions, codec, frames, duration and audio", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for render validation tests",
}, async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "tiny.mp4");
  await runExportProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=16x12:r=10:d=0.2",
    "-frames:v", "2", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-an", "-f", "mp4", file,
  ]);
  const report = await validateRenderFile(file, { ...videoExpected, expectedVideoCodec: "mpeg4" });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.facts.frameCount, 2);
  assert.equal(report.facts.hasAudio, false);
  assert.equal(report.checks.audio.status, "pass");
});

test("APNG duration falls back to the real FFmpeg packet timestamp and duration span", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for render validation tests",
}, async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "animated.apng");
  await runExportProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=16x16:rate=30:duration=0.5",
    "-frames:v", "13", "-plays", "0", "-f", "apng", file,
  ]);
  const report = await validateRenderFile(file, {
    format: "apng", width: 16, height: 16, fps: 30, frameCount: 13, duration: 13 / 30, hasAudio: false,
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.facts.frameCount, 13);
  assert.equal(report.facts.durationSource, "video packet timestamps and durations");
  assert.equal(report.facts.durationPacketCount, 13);
  assert.ok(Math.abs(report.facts.duration - 13 / 30) < 0.001);
  assert.ok(report.warnings.some((warning) => warning.includes("packet timestamps")));
});

// An APNG stores no frame rate. ffprobe estimates one only when its probe (5,000,000 bytes by
// default) holds 3 frames, and otherwise reads the 1/100000 s time base: 100000 fps.
async function probedFrameRate(file) {
  return (await runExportProcess(ffprobe, ["-v", "error", "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", file])).trim();
}

test("an APNG whose frames overflow ffprobe's probe has its frame rate measured from packet timing", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for render validation tests",
}, async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "big-frames.apng");
  // Three 800 x 800 RGBA frames stored uncompressed, about 2.57 MB each (a 1080p RGBA fog frame
  // is about 4.5 MB); the hue turns, so every pixel changes and no frame is stored as a small patch.
  await runExportProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:size=800x800:rate=10,hue=h=t*360,format=rgba",
    "-frames:v", "3", "-c:v", "apng", "-compression_level", "0", "-plays", "0", "-f", "apng", file,
  ]);
  assert.equal(await probedFrameRate(file), "0/0", "the frames must overflow ffprobe's probe, or this test checks nothing");
  const report = await validateRenderFile(file, {
    format: "apng", width: 800, height: 800, fps: 10, frameCount: 3, duration: 0.3, hasAudio: false,
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.checks.frameRate.status, "pass");
  assert.equal(report.facts.fps, 10);
  assert.equal(report.facts.fpsSource, "video packet timestamps and durations");
});

test("a 2-frame APNG, the shortest a render writes, has its frame rate measured from packet timing", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for render validation tests",
}, async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "two-frames.apng");
  await runExportProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=16x16:rate=15",
    "-frames:v", "2", "-plays", "0", "-f", "apng", file,
  ]);
  assert.equal(await probedFrameRate(file), "0/0", "ffprobe needs 3 frames to estimate a frame rate");
  const report = await validateRenderFile(file, {
    format: "apng", width: 16, height: 16, fps: 15, frameCount: 2, duration: 2 / 15, hasAudio: false,
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.ok(Math.abs(report.facts.fps - 15) < 0.01, `measured ${report.facts.fps} fps`);
});

test("APNG duration fails when packet timing is missing instead of inferring from frame rate", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "missing-packet-duration.apng");
  await writeFile(file, "not empty; the fake probe supplies stream metadata");
  await fakeFfprobeWithPackets(t, directory, {
    codec_type: "video", codec_name: "apng", width: "16", height: "16", avg_frame_rate: "30/1", r_frame_rate: "30/1",
    nb_read_frames: "2", start_time: "0",
  }, [
    { pts_time: "0.000000", duration_time: "0.033330" },
    { pts_time: "0.033330" },
  ]);
  const report = await validateRenderFile(file, {
    format: "apng", width: 16, height: 16, fps: 30, frameCount: 2, duration: 2 / 30, hasAudio: false,
  });
  assert.equal(report.ok, false);
  assert.equal(report.facts.duration, null);
  assert.equal(report.facts.durationSource, "unavailable");
  assert.equal(report.checks.duration.status, "fail");
});

test("ffprobe metadata that omits decoded frames or dimensions fails the report", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "metadata.mp4");
  await writeFile(file, "not empty; the fake probe supplies metadata");
  await fakeFfprobe(t, directory, JSON.stringify({
    format: { duration: "0.2" },
    streams: [{ codec_type: "video", codec_name: "h264", width: "N/A", height: "12", avg_frame_rate: "0/0", nb_read_frames: "N/A" }],
  }));
  const report = await validateRenderFile(file, videoExpected);
  assert.equal(report.ok, false);
  assert.equal(report.checks.dimensions.status, "fail");
  assert.equal(report.checks.frameCount.status, "fail");
  assert.equal(report.checks.frameRate.status, "fail");
});

test("malformed ffprobe JSON propagates instead of producing a pass", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "metadata.mp4");
  await writeFile(file, "not empty");
  await fakeFfprobe(t, directory, "{bad-json");
  await assert.rejects(validateRenderFile(file, videoExpected), /ffprobe returned malformed render metadata/);
});

test("A/V offset outside the render tolerance fails validation", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "metadata.mp4");
  await writeFile(file, "not empty");
  await fakeFfprobe(t, directory, JSON.stringify({
    format: { duration: "0.2" },
    streams: [
      { codec_type: "video", codec_name: "h264", width: "16", height: "12", avg_frame_rate: "10/1", start_time: "0", nb_read_frames: "2", duration: "0.2" },
      { codec_type: "audio", codec_name: "aac", start_time: "0.2" },
    ],
  }));
  const report = await validateRenderFile(file, { ...videoExpected, hasAudio: true });
  assert.equal(report.ok, false);
  assert.equal(report.checks.audio.status, "pass");
  assert.equal(report.checks.audioVideoOffset.status, "fail");
  assert.equal(report.checks.audioVideoOffset.actual, 200);
});

test("PNG-sequence ZIP validates bounded central-directory names, frame sizes and CRCs", async (t) => {
  const directory = await withDirectory(t);
  const frames = path.join(directory, "frames");
  await mkdir(frames);
  await makePng(path.join(frames, "frame-000000.png"), 16, 12, "#e63946");
  await makePng(path.join(frames, "frame-000001.png"), 16, 12, "#457b9d");
  const zip = path.join(directory, "sequence.zip");
  await archivePngSequence(frames, 2, zip);

  const report = await validateRenderFile(zip, {
    format: "png-sequence", width: 16, height: 12, fps: 24, frameCount: 2, duration: 2 / 24, hasAudio: false,
  });
  assert.equal(report.ok, true);
  assert.equal(report.method, "classic ZIP central-directory and streamed PNG header/CRC checks");
  assert.equal(report.facts.frameCount, 2);
  assert.equal(report.checks.frameRate.status, "unsupported");
  assert.equal(report.checks.duration.status, "unsupported");
  assert.ok(report.warnings.some((warning) => warning.includes("not decoded")));
});

test("a ZIP with a damaged PNG payload is rejected", async (t) => {
  const directory = await withDirectory(t);
  const frames = path.join(directory, "frames");
  await mkdir(frames);
  await makePng(path.join(frames, "frame-000000.png"));
  const zip = path.join(directory, "sequence.zip");
  await archivePngSequence(frames, 1, zip);
  const handle = await open(zip, "r+");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, header.length, 0);
    const nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28);
    const position = 30 + nameLength + extraLength + 40;
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, position);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, position);
  } finally { await handle.close(); }
  await assert.rejects(validateRenderFile(zip, {
    format: "png-sequence", width: 16, height: 12, fps: 24, frameCount: 1, duration: 1 / 24,
  }), /CRC does not match/);
});

test("pre-aborted validation propagates the caller's cancellation reason", async (t) => {
  const directory = await withDirectory(t);
  const file = path.join(directory, "scene.json");
  await writeFile(file, "{}");
  const controller = new AbortController();
  const reason = Object.assign(new Error("stop validation"), { name: "AbortError" });
  controller.abort(reason);
  await assert.rejects(validateRenderFile(file, {
    format: "lottie", width: 1, height: 1, fps: 1, frameCount: 1, duration: 1,
  }, { signal: controller.signal }), { name: "AbortError", message: "stop validation" });
});
