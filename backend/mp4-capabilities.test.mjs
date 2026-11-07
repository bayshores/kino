import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportScene } from "./export.mjs";
import { getMp4Encoders, listVideoEncoders, resolveMp4Encoder } from "./mp4-encoders.mjs";
import { MP4_ENCODERS } from "../engine/mp4Encoders.js";

const realFfmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const realFfprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

async function createRecordingWrapper(t) {
  const directory = await mkdtemp(join(tmpdir(), "kino-ffmpeg-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = join(directory, "ffmpeg-wrapper");
  const log = join(directory, "argv.log");
  await writeFile(wrapper, `#!/bin/sh
printf '%s\\n' '---CALL---' "$$" "$@" '---END---' >> "$KINO_FFMPEG_ARGS_LOG"
exec "$KINO_REAL_FFMPEG" "$@"
`, "utf8");
  await chmod(wrapper, 0o700);

  const previous = {
    command: process.env.KINO_FFMPEG,
    log: process.env.KINO_FFMPEG_ARGS_LOG,
    real: process.env.KINO_REAL_FFMPEG,
    probe: process.env.KINO_FFPROBE,
  };
  process.env.KINO_FFMPEG = wrapper;
  process.env.KINO_FFMPEG_ARGS_LOG = log;
  process.env.KINO_REAL_FFMPEG = realFfmpeg;
  process.env.KINO_FFPROBE = realFfprobe;
  t.after(() => {
    if (previous.command === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = previous.command;
    if (previous.log === undefined) delete process.env.KINO_FFMPEG_ARGS_LOG;
    else process.env.KINO_FFMPEG_ARGS_LOG = previous.log;
    if (previous.real === undefined) delete process.env.KINO_REAL_FFMPEG;
    else process.env.KINO_REAL_FFMPEG = previous.real;
    if (previous.probe === undefined) delete process.env.KINO_FFPROBE;
    else process.env.KINO_FFPROBE = previous.probe;
  });
  return { directory, wrapper, log };
}

async function readCalls(log) {
  let contents = "";
  try { contents = await readFile(log, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const calls = [];
  let current;
  for (const line of contents.split(/\r?\n/)) {
    if (line === "---CALL---") current = { pid: null, args: [] };
    else if (line === "---END---") {
      if (current) calls.push(current);
      current = undefined;
    } else if (current) {
      if (current.pid === null) current.pid = Number(line);
      else current.args.push(line);
    }
  }
  return calls;
}

function videoProbeCalls(calls) {
  return calls.filter(({ args }) => args.includes("-i") && args[args.indexOf("-i") + 1]?.startsWith("color=black:s="));
}

function assertProbeConfiguration(calls, { width, height, fps }) {
  const expectedInput = `color=black:s=${width}x${height}:r=${fps},format=rgba`;
  const probes = videoProbeCalls(calls).filter(({ args }) => args.includes(expectedInput));
  assert.ok(probes.length > 0, `FFmpeg received a real video probe at ${expectedInput}`);
  const expectedBitrate = width >= 720 && height >= 720 ? "24000000" : "12000000";
  for (const { args } of probes) {
    const bitrateIndex = args.indexOf("-b:v");
    assert.notEqual(bitrateIndex, -1, "video capability probe specifies the output bitrate");
    assert.equal(args[bitrateIndex + 1], expectedBitrate);
    assert.ok(args.includes("-frames:v") && args[args.indexOf("-frames:v") + 1] === "1");
  }
  return probes;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function waitForRunningCall(log, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const calls = await readCalls(log);
    const call = calls.find(({ pid }) => isAlive(pid));
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a real FFmpeg capability probe process.");
}

async function waitForProcessExit(pid, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return !isAlive(pid);
}

test("capability probes use each requested configuration and cache completed checks for that configuration", async (t) => {
  const wrapper = await createRecordingWrapper(t);
  const defaults = await getMp4Encoders();
  assert.ok(defaults.length > 0, "real FFmpeg advertises at least one working MP4 path");
  assertProbeConfiguration(await readCalls(wrapper.log), { width: 64, height: 64, fps: 30 });
  const defaultCallCount = (await readCalls(wrapper.log)).length;
  assert.deepEqual(await getMp4Encoders(), defaults);
  assert.equal((await readCalls(wrapper.log)).length, defaultCallCount, "a repeat default request reuses the completed result");

  const large = { width: 1280, height: 720, fps: 60 };
  const largeResult = await getMp4Encoders(large);
  assert.ok(largeResult.length > 0, "the distinct size/rate has its own supported encoder set");
  assertProbeConfiguration(await readCalls(wrapper.log), large);
  const largeCallCount = (await readCalls(wrapper.log)).length;
  assert.deepEqual(await getMp4Encoders(large), largeResult);
  assert.equal((await readCalls(wrapper.log)).length, largeCallCount, "the nondefault result is cached independently");

  const descriptor = await resolveMp4Encoder(largeResult[0], large);
  assert.equal(descriptor.id, largeResult[0]);
  assert.equal(descriptor.profile, MP4_ENCODERS.find(({ id }) => id === descriptor.id).profile);
  assert.equal((await readCalls(wrapper.log)).length, largeCallCount, "resolving an encoder reuses the same configuration probe");

  // 29.97 in any spelling (as /api/export-capabilities?fps= passes it) probes once at 30000/1001.
  const ntsc = await getMp4Encoders({ width: 64, height: 64, fps: "30000/1001" });
  assertProbeConfiguration(await readCalls(wrapper.log), { width: 64, height: 64, fps: "30000/1001" });
  const ntscCallCount = (await readCalls(wrapper.log)).length;
  assert.deepEqual(await getMp4Encoders({ width: 64, height: 64, fps: "29.97" }), ntsc);
  assert.equal((await readCalls(wrapper.log)).length, ntscCallCount, "29.97 and 30000/1001 share one probe");
});

test("concurrent requests share same-config probes and serialize different configurations", async (t) => {
  const wrapper = await createRecordingWrapper(t);
  const first = { width: 640, height: 360, fps: 25 };
  const second = { width: 1280, height: 720, fps: 60 };
  const shared = { width: 96, height: 54, fps: 24 };
  const [firstResult, secondResult, sharedA, sharedB] = await Promise.all([
    getMp4Encoders(first),
    getMp4Encoders(second),
    getMp4Encoders(shared),
    getMp4Encoders(shared),
  ]);
  assert.ok(firstResult.length > 0);
  assert.ok(secondResult.length > 0);
  assert.deepEqual(sharedB, sharedA, "concurrent same-config callers share one completed result");

  const calls = await readCalls(wrapper.log);
  const firstProbes = assertProbeConfiguration(calls, first);
  const secondProbes = assertProbeConfiguration(calls, second);
  const sharedProbes = assertProbeConfiguration(calls, shared);
  const allVideoProbes = videoProbeCalls(calls);
  assert.equal(new Set(allVideoProbes.map(({ args }) => JSON.stringify(args))).size, allVideoProbes.length,
    "concurrent same-config callers do not duplicate real encoder probes");
  assert.equal(firstProbes.length + secondProbes.length + sharedProbes.length, allVideoProbes.length,
    "the wrapper recorded only the three requested video configurations");
  const callCountAfterConcurrentRequests = calls.length;
  assert.deepEqual(await getMp4Encoders(shared), sharedA);
  assert.equal((await readCalls(wrapper.log)).length, callCountAfterConcurrentRequests,
    "a repeat request reuses the completed shared result");

  const configsInOrder = allVideoProbes.map(({ args }) => args[args.indexOf("-i") + 1]);
  const transitions = configsInOrder.filter((value, index) => index === 0 || value !== configsInOrder[index - 1]);
  assert.equal(transitions.length, 3, "different configuration probes run in serial groups");
  assert.deepEqual(new Set(transitions), new Set([
    `color=black:s=${first.width}x${first.height}:r=${first.fps},format=rgba`,
    `color=black:s=${second.width}x${second.height}:r=${second.fps},format=rgba`,
    `color=black:s=${shared.width}x${shared.height}:r=${shared.fps},format=rgba`,
  ]));
});

test("cancelling one shared caller does not stop the other caller's real probe", async (t) => {
  const wrapper = await createRecordingWrapper(t);
  const configuration = { width: 960, height: 540, fps: 50 };
  const controller = new AbortController();
  const cancelled = getMp4Encoders(configuration, { signal: controller.signal });
  const continuing = getMp4Encoders(configuration);
  controller.abort();

  await assert.rejects(cancelled, (error) => error.name === "AbortError");
  const available = await continuing;
  assert.ok(available.length > 0, "the remaining subscriber receives real capability results");
  const calls = await readCalls(wrapper.log);
  const probes = assertProbeConfiguration(calls, configuration);
  assert.equal(new Set(probes.map(({ args }) => JSON.stringify(args))).size, probes.length,
    "the cancelled subscriber did not duplicate or poison the shared check");
});

test("invalid configurations, unknown choices, and a pre-aborted request launch no probes", async (t) => {
  const wrapper = await createRecordingWrapper(t);
  const invalid = [
    { width: 0, height: 64, fps: 30 },
    { width: 63, height: 64, fps: 30 },
    { width: 6000, height: 1080, fps: 30 },
    { width: 2880, height: 2880, fps: 30 },
    { width: 64, height: 64, fps: 0 },
    { width: 64, height: 64, fps: 120.5 },
  ];
  for (const configuration of invalid) {
    await assert.rejects(getMp4Encoders(configuration));
  }
  await assert.rejects(resolveMp4Encoder("h264DefinitelyNotReal", { width: 64, height: 64, fps: 30 }), /Unknown MP4 encoder/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getMp4Encoders({ width: 64, height: 64, fps: 30 }, { signal: controller.signal }),
    (error) => error.name === "AbortError");
  await assert.rejects(resolveMp4Encoder("h264HighSwAAC", { width: 64, height: 64, fps: 30 }, { signal: controller.signal }),
    (error) => error.name === "AbortError");
  assert.deepEqual(await readCalls(wrapper.log), [], "invalid and already-aborted requests perform no FFmpeg work");
});

test("cancelling the last subscriber stops an active FFmpeg probe", async (t) => {
  const wrapper = await createRecordingWrapper(t);
  const controller = new AbortController();
  const configuration = { width: 4320, height: 2160, fps: 120 };
  const pending = getMp4Encoders(configuration, { signal: controller.signal });
  const active = await waitForRunningCall(wrapper.log);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  const calls = await readCalls(wrapper.log);
  assert.equal(calls.length, 1, "cancellation stopped the probe sequence before another encoder started");
  assert.ok(active.args.includes(`color=black:s=${configuration.width}x${configuration.height}:r=${configuration.fps},format=rgba`));
  assert.equal(await waitForProcessExit(active.pid), true, "the cancelled FFmpeg process exits");

  const beforeRetry = calls.length;
  const retried = await getMp4Encoders(configuration);
  assert.ok(retried.length > 0, "the cancelled configuration can be probed again");
  const retryCalls = (await readCalls(wrapper.log)).slice(beforeRetry);
  assertProbeConfiguration(retryCalls, configuration);
  assert.equal(new Set(retryCalls.map(({ args }) => JSON.stringify(args))).size, retryCalls.length,
    "the retry runs one complete fresh probe sequence after cancellation");
});

test("a real export resolves capabilities at the requested nondefault size and frame rate", async (t) => {
  const wrapper = await createRecordingWrapper(t);
  const configuration = { width: 80, height: 48, fps: 24 };
  const result = await exportScene({
    id: "mp4-capability-export",
    name: "Capability export",
    width: configuration.width,
    height: configuration.height,
    duration: 0.125,
    background: "#244466",
    layers: [],
  }, { format: "mp4", ...configuration });
  assert.ok(result.buffer.length > 0);
  assert.ok(MP4_ENCODERS.some(({ id }) => id === result.mp4Encoder));
  assertProbeConfiguration(await readCalls(wrapper.log), configuration);
  const path = join(wrapper.directory, "real-export.mp4");
  await writeFile(path, result.buffer);
  const metadata = spawnSync(realFfprobe, [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate,nb_read_frames",
    "-of", "json", path,
  ], { encoding: "utf8" });
  assert.equal(metadata.status, 0, metadata.stderr);
  const video = JSON.parse(metadata.stdout).streams[0];
  assert.equal(video.codec_name, "h264");
  assert.deepEqual([Number(video.width), Number(video.height)], [configuration.width, configuration.height]);
  assert.equal(video.avg_frame_rate, "24/1");
  assert.equal(Number(video.nb_read_frames), 3);
});

test("the video encoder setting is part of the probe: software probes only libx264 and offers no Hw id", async (t) => {
  const wrapper = await createRecordingWrapper(t);
  const configuration = { width: 112, height: 64, fps: 30 };
  const auto = await getMp4Encoders(configuration);
  const autoCalls = (await readCalls(wrapper.log)).length;
  const software = await getMp4Encoders(configuration, { videoEncoder: "software" });
  const softwareCalls = (await readCalls(wrapper.log)).slice(autoCalls);
  assert.ok(softwareCalls.length > 0, "the software setting has its own cached probe, not the auto one");
  assert.ok(software.length > 0 && software.every((id) => id.includes("Sw")), `software offers only Sw ids (${software.join(", ")})`);
  for (const { args } of videoProbeCalls(softwareCalls)) assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.deepEqual(await getMp4Encoders(configuration), auto, "the auto result is still cached");
  assert.equal((await readCalls(wrapper.log)).length, autoCalls + softwareCalls.length);
  const hardware = MP4_ENCODERS.find((entry) => entry.hardware).id;
  await assert.rejects(resolveMp4Encoder(hardware, configuration, { videoEncoder: "software" }),
    /h264HighHwAAC is unavailable on this computer for these export settings\. It uses the hardware video encoder, and the video encoder is set to "software"\./);
  assert.equal((await resolveMp4Encoder(null, configuration, { videoEncoder: "software" })).family, "software");
});

test("a named video encoder that cannot work here is an error naming why and what works, never a silent switch", async (t) => {
  await createRecordingWrapper(t);
  const configuration = { width: 64, height: 64, fps: 30 };
  const foreign = process.platform === "darwin" ? "nvenc" : "videotoolbox";
  await assert.rejects(resolveMp4Encoder(null, configuration, { videoEncoder: foreign }), (error) => {
    assert.match(error.message, new RegExp(`^The video encoder "${foreign}" does not work on this computer: .+ works only on .+\\. `));
    assert.match(error.message, /Video encoders that work here: .*"software"\. Choose one of them or "auto"\.$/);
    return true;
  });
  // An Sw id needs no hardware encoder, so a named family does not stop it.
  assert.equal((await resolveMp4Encoder("h264HighSwAAC", configuration, { videoEncoder: foreign })).family, "software");
  await assert.rejects(exportScene({ id: "s", name: "s", width: 64, height: 64, duration: 0.1, background: "#000", layers: [] },
    { format: "mp4", videoEncoder: foreign }), /does not work on this computer/);
  await assert.rejects(exportScene({ id: "s", name: "s", width: 64, height: 64, duration: 0.1, background: "#000", layers: [] },
    { format: "webm", videoQuality: "high" }), /apply only to MP4 exports/);
});

// NVENC on an RTX 4090 encodes from 145x49 (mp4-encoders.mjs cannotEncodeThisFile), so 146x50 is the
// smallest even size it takes. A computer whose NVENC does not work skips this test.
test("a named NVENC that works here encodes a file below its minimum size in software and says why", async (t) => {
  const list = await listVideoEncoders();
  if (!list.find((entry) => entry.id === "nvenc")?.available) return t.skip("NVENC does not work on this computer");
  const wrapper = await createRecordingWrapper(t);
  const options = { videoEncoder: "nvenc" };
  for (const [width, height, family] of [[128, 72, "software"], [146, 50, "nvenc"]]) {
    const encoder = await resolveMp4Encoder(null, { width, height, fps: 30 }, options);
    assert.equal(encoder.family, family, `${width}x${height}`);
    assert.equal(encoder.id, family === "nvenc" ? "h264HighHwAAC" : "h264HighSwAAC", `${width}x${height}`);
    assert.equal(encoder.reason, family === "nvenc" ? "" : `NVENC cannot encode frames this small: ${width}x${height}`);
  }
  assert.ok((await readCalls(wrapper.log)).some(({ args }) => args.includes("h264_nvenc") && args.includes("color=black:s=128x72:r=30,format=rgba")),
    "NVENC's test encode ran at 128x72");

  const result = await exportScene({ id: "tiny", name: "Tiny", width: 128, height: 72, duration: 0.1, background: "#244466", layers: [] },
    { format: "mp4", videoEncoder: "nvenc" });
  assert.equal(result.mp4Encoder, "h264HighSwAAC");
  assert.deepEqual(result.videoEncoder, { family: "software", ffmpegEncoder: "libx264", quality: "standard", bitrate: 12_000_000,
    reason: "NVENC cannot encode frames this small: 128x72" });
  const path = join(wrapper.directory, "tiny.mp4");
  await writeFile(path, result.buffer);
  const metadata = spawnSync(realFfprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", path], { encoding: "utf8" });
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.deepEqual(JSON.parse(metadata.stdout).streams[0], { codec_name: "h264", width: 128, height: 72 });

  // A family that fails here at every size stays an error, and is never listed as one that works.
  const failing = list.find((entry) => entry.id !== "nvenc" && entry.id !== "software" && !entry.available);
  if (failing) await assert.rejects(resolveMp4Encoder(null, { width: 1280, height: 720, fps: 30 }, { videoEncoder: failing.id }), (error) => {
    assert.match(error.message, new RegExp(`^The video encoder "${failing.id}" does not work on this computer: `));
    assert.match(error.message, /Video encoders that work here: "nvenc", "software"\. Choose one of them or "auto"\.$/);
    assert.doesNotMatch(error.message, / @ 0x/);
    return true;
  });
});
