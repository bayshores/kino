// The video encoder families and video quality of MP4 exports (mp4-encoders.mjs), without FFmpeg:
// every family's arguments, the order "auto" tries on each platform, and the plain errors.
// NVENC, QSV, AMF and VA-API cannot run on a Mac, so only their arguments are checked here.
import test from "node:test";
import assert from "node:assert/strict";
import { MP4_ENCODERS } from "../engine/mp4Encoders.js";
import { createDocument, createScene } from "../engine/model.js";
import { createExportBatches } from "./export-batches.mjs";
import {
  VIDEO_ENCODERS, VIDEO_QUALITIES, checkVideoEncoderOptions, chooseMp4Encoder, detectVideoFamilies, ffmpegReason, hardwareDevices, hardwareFamilies,
  listVideoEncoders, mp4EncodingArgs, mp4InputArgs, mp4VideoEncoderFacts, videoBitrate, videoEncoderArgs, videoEncoderUnavailableMessage,
} from "./mp4-encoders.mjs";

const PLATFORMS = ["darwin", "linux", "wsl", "win32"];
const PROFILES = { High: "high", Main: "main", Base: "baseline" };
// Stub Linux devices (hardwareDevices): an NVIDIA device and one render node, whatever this computer has.
const LINUX_DEVICES = { nvidia: true, renderNodes: ["/dev/dri/renderD128"] };
const devicesFor = (platform) => (platform === "darwin" || platform === "win32" ? null : LINUX_DEVICES);

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

test("the bitrate is today's for standard quality, double for high and half for small", () => {
  assert.equal(videoBitrate({ width: 1080, height: 1920 }), 24_000_000);
  assert.equal(videoBitrate({ width: 1080, height: 1920 }, "high"), 48_000_000);
  assert.equal(videoBitrate({ width: 1080, height: 1920 }, "small"), 12_000_000);
  assert.equal(videoBitrate({ width: 719, height: 1280 }, "standard"), 12_000_000);
  assert.equal(videoBitrate({ width: 640, height: 360 }, "high"), 24_000_000);
  assert.equal(videoBitrate({ width: 640, height: 360 }, "small"), 6_000_000);
});

test("standard VideoToolbox and libx264 arguments are exactly the ones kino always used", () => {
  for (const { id, hardware, profile } of MP4_ENCODERS) {
    for (const [width, height, rate] of [[1080, 1920, "24000000"], [640, 360, "12000000"]]) {
      const args = mp4EncodingArgs(id, { width, height, hasAudio: false, mp4Family: hardware ? "videotoolbox" : "software", platform: "darwin" });
      assert.deepEqual(args, [
        "-c:v", hardware ? "h264_videotoolbox" : "libx264", "-profile:v", profile, "-pix_fmt", "yuv420p", "-b:v", rate,
        ...(hardware ? ["-allow_sw", "0"] : []), "-movflags", "+faststart", "-f", "mp4",
      ]);
      assert.deepEqual(mp4InputArgs(id, { mp4Family: hardware ? "videotoolbox" : "software", platform: "darwin" }), []);
    }
  }
});

test("every family, profile and quality builds its own encoder arguments on each platform", () => {
  const expected = {
    software: { codec: "libx264", pix: "yuv420p", base: "baseline" },
    videotoolbox: { codec: "h264_videotoolbox", pix: "yuv420p", base: "baseline" },
    nvenc: { codec: "h264_nvenc", pix: "yuv420p", base: "baseline" },
    qsv: { codec: "h264_qsv", pix: "nv12", base: "baseline" },
    amf: { codec: "h264_amf", pix: "nv12", base: "constrained_baseline" },
    vaapi: { codec: "h264_vaapi", pix: null, base: "constrained_baseline" },
  };
  for (const platform of PLATFORMS) for (const family of Object.keys(expected)) for (const [name, profile] of Object.entries(PROFILES))
    for (const quality of VIDEO_QUALITIES) for (const [width, height] of [[1080, 1920], [1280, 720], [640, 360]]) {
      const id = `h264${name}${family === "software" ? "Sw" : "Hw"}AAC`;
      const { input, output } = videoEncoderArgs(id, { width, height }, { family, quality, platform });
      const bitrate = videoBitrate({ width, height }, quality);
      const label = `${family} ${id} ${quality} ${width}x${height} on ${platform}`;
      assert.equal(value(output, "-c:v"), expected[family].codec, label);
      assert.equal(value(output, "-b:v"), String(bitrate), label);
      assert.equal(value(output, "-profile:v"), profile === "baseline" ? expected[family].base : profile, label);
      if (expected[family].pix) assert.equal(value(output, "-pix_fmt"), expected[family].pix, label);
      // The RGBA frames are converted by FFmpeg's swscale before the hardware sees them.
      if (family === "vaapi") assert.equal(value(output, "-vf"), "format=nv12,hwupload", label);
      if (family === "nvenc") {
        assert.deepEqual([value(output, "-preset"), value(output, "-tune"), value(output, "-rc")], ["p5", "hq", "vbr"], label);
        assert.equal(value(output, "-maxrate"), String(bitrate * 1.5), label);
        assert.equal(value(output, "-bufsize"), String(bitrate * 2), label);
      }
      if (family === "amf") assert.deepEqual([value(output, "-usage"), value(output, "-quality")], ["transcoding", "quality"], label);
      if (family === "videotoolbox") assert.equal(value(output, "-allow_sw"), "0", label);
      const linux = platform === "linux" || platform === "wsl";
      if (family === "qsv") assert.deepEqual(input, ["-init_hw_device", linux ? "qsv=hw,child_device=/dev/dri/renderD128" : "qsv=hw"], label);
      else if (family === "vaapi") assert.deepEqual(input, ["-vaapi_device", "/dev/dri/renderD128"], label);
      else assert.deepEqual(input, [], label);
      assert.deepEqual(mp4InputArgs(id, { mp4Family: family, platform }), input, label);
    }
});

test("QSV and VA-API open the render node the probe chose", () => {
  const node = "/dev/dri/renderD129";
  assert.deepEqual(videoEncoderArgs("h264HighHwAAC", { width: 1280, height: 720 }, { family: "vaapi", platform: "linux", device: node }).input,
    ["-vaapi_device", node]);
  // FFmpeg reads "qsv=name:device" with device as the MFX implementation, so the node is the child device.
  assert.deepEqual(mp4InputArgs("h264HighHwAAC", { mp4Family: "qsv", mp4Device: node, platform: "linux" }), ["-init_hw_device", `qsv=hw,child_device=${node}`]);
  assert.deepEqual(mp4InputArgs("h264HighHwAAC", { mp4Family: "qsv", mp4Device: node, platform: "win32" }), ["-init_hw_device", "qsv=hw"]);
});

test("an Sw id always uses libx264, whatever the family", () => {
  for (const family of ["nvenc", "videotoolbox", "vaapi"]) {
    const { output } = videoEncoderArgs("h264MainSwOpus", { width: 1280, height: 720 }, { family, quality: "high", platform: "linux" });
    assert.equal(value(output, "-c:v"), "libx264");
    assert.equal(value(output, "-b:v"), "48000000");
  }
});

test("the export result names the family, FFmpeg encoder, quality and bitrate", () => {
  assert.deepEqual(mp4VideoEncoderFacts({ mp4Encoder: "h264HighHwAAC", mp4Family: "videotoolbox", videoQuality: "high", width: 1080, height: 1920 }),
    { family: "videotoolbox", ffmpegEncoder: "h264_videotoolbox", quality: "high", bitrate: 48_000_000 });
  assert.deepEqual(mp4VideoEncoderFacts({ mp4Encoder: "h264HighSwAAC", mp4Family: "software", width: 640, height: 360 }),
    { family: "software", ffmpegEncoder: "libx264", quality: "standard", bitrate: 12_000_000 });
  assert.deepEqual(mp4VideoEncoderFacts({ mp4Encoder: "h264BaseHwOpus", mp4Family: "nvenc", videoQuality: "small", width: 1280, height: 720 }),
    { family: "nvenc", ffmpegEncoder: "h264_nvenc", quality: "small", bitrate: 12_000_000 });
  assert.deepEqual(mp4VideoEncoderFacts({ mp4Encoder: "mp4.alt", width: 640, height: 360 }),
    { family: "software", ffmpegEncoder: "libx264", quality: "crf 15", bitrate: null });
  assert.deepEqual(mp4VideoEncoderFacts({ mp4Encoder: "h264HighSwAAC", mp4Family: "software", mp4SoftwareReason: "NVENC cannot encode frames this small: 128x72", width: 128, height: 72 }),
    { family: "software", ffmpegEncoder: "libx264", quality: "standard", bitrate: 12_000_000, reason: "NVENC cannot encode frames this small: 128x72" });
});

// FFmpeg 6.1.1 and 9.0.2's error output for NVENC below its minimum size (RTX 4090, WSL2).
const NVENC_TOO_SMALL_6 = `[h264_nvenc @ 0x565288e2df00] InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value.
[vost#0:0/h264_nvenc @ 0x565288e2db40] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
Error while filtering: Invalid argument
[out#0/mp4 @ 0x565288e2c6c0] Nothing was written into output file, because at least one of its streams received no packets.
`;
const NVENC_TOO_SMALL_9 = `[h264_nvenc @ 0x55e5d09d7b40] InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value.
[vost#0:0/h264_nvenc @ 0x55e5d09d76c0] [enc:h264_nvenc @ 0x55e5d09d4200] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
[vf#0:0 @ 0x55e5d09f3080] Error sending frames to consumers: Invalid argument
[vf#0:0 @ 0x55e5d09f3080] Task finished with error code: -22 (Invalid argument)
[vf#0:0 @ 0x55e5d09f3080] Terminating thread with return code -22 (Invalid argument)
[vost#0:0/h264_nvenc @ 0x55e5d09d76c0] [enc:h264_nvenc @ 0x55e5d09d4200] Could not open encoder before EOF
[vost#0:0/h264_nvenc @ 0x55e5d09d76c0] Task finished with error code: -22 (Invalid argument)
[vost#0:0/h264_nvenc @ 0x55e5d09d76c0] Terminating thread with return code -22 (Invalid argument)
[out#0/mp4 @ 0x55e5d09d71c0] Nothing was written into output file, because at least one of its streams received no packets.
`;

test("FFmpeg's reason is the line that says what went wrong, without pointer addresses", () => {
  const tooSmall = "InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value";
  assert.equal(ffmpegReason(NVENC_TOO_SMALL_6, "h264_nvenc"), tooSmall);
  assert.equal(ffmpegReason(NVENC_TOO_SMALL_9, "h264_nvenc"), tooSmall);
  assert.equal(ffmpegReason("[h264_nvenc @ 0x1] Cannot load libcuda.so.1\n[h264_nvenc @ 0x1] Failed loading nvcuda.\n[out#0/mp4 @ 0x2] Nothing was written into output file\n",
    "h264_nvenc"), "Cannot load libcuda.so.1");
  assert.equal(ffmpegReason("Unknown encoder 'h264_qsv'\n", "h264_qsv"), "Unknown encoder 'h264_qsv'");
  assert.equal(ffmpegReason(`[AVHWDeviceContext @ 0x55d23c66fb80] No VA display found for device /dev/dri/renderD128.
Device creation failed: -22.
Failed to set value '/dev/dri/renderD128' for option 'vaapi_device': Invalid argument
Error parsing global options: Invalid argument
`, "h264_vaapi"), "[AVHWDeviceContext] No VA display found for device /dev/dri/renderD128");
  // Only follow-on lines: the last one, still without its address.
  assert.equal(ffmpegReason("[out#0/mp4 @ 0x55d0aa] Nothing was written into output file.\n", "h264_nvenc"), "[out#0/mp4] Nothing was written into output file");
  assert.equal(ffmpegReason("", "h264_nvenc"), "");
});

// A stub test encode: `working` lists the families whose test frame encodes.
function stubCheck(working, calls = []) {
  return async (family, profile) => {
    calls.push(`${family}:${profile}`);
    return working.includes(family) ? { ok: true, message: "" } : { ok: false, message: `Unknown encoder 'h264_${family}'` };
  };
}

test("auto tries each platform's hardware families in order and keeps the first that works", async () => {
  assert.deepEqual(hardwareFamilies("darwin"), ["videotoolbox"]);
  assert.deepEqual(hardwareFamilies("win32"), ["nvenc", "amf", "qsv"]);
  assert.deepEqual(hardwareFamilies("linux"), ["nvenc", "vaapi", "qsv"]);
  assert.deepEqual(hardwareFamilies("wsl"), ["nvenc", "vaapi", "qsv"]);
  const cases = [
    ["darwin", ["software", "videotoolbox"], "videotoolbox"],
    ["darwin", ["software"], null],
    ["win32", ["software", "amf", "qsv"], "amf"],
    ["win32", ["software", "qsv"], "qsv"],
    ["win32", ["software", "nvenc", "amf"], "nvenc"],
    ["linux", ["software", "vaapi", "qsv"], "vaapi"],
    ["linux", ["software", "qsv"], "qsv"],
    ["wsl", ["software", "nvenc"], "nvenc"],
    ["linux", ["software"], null],
  ];
  for (const [platform, working, chosen] of cases) {
    const calls = [];
    const result = await detectVideoFamilies("auto", { platform, check: stubCheck(working, calls), devices: devicesFor(platform) });
    assert.equal(result.family, chosen, `${platform} with ${working.join(", ")}`);
    assert.equal(result.supported.has("high:false"), true);
    assert.equal(result.supported.has("high:true"), Boolean(chosen));
    // Families after the chosen one are never opened.
    const order = hardwareFamilies(platform);
    const tried = [...new Set(calls.map((call) => call.split(":")[0]).filter((family) => family !== "software"))];
    assert.deepEqual(tried, chosen ? order.slice(0, order.indexOf(chosen) + 1) : order, `${platform} tries in order`);
    if (!chosen) for (const family of order) assert.match(result.reasons[family], new RegExp(`h264_${family}`));
  }
});

test("software makes every Hw id unavailable and opens no hardware encoder", async () => {
  const calls = [];
  const result = await detectVideoFamilies("software", { platform: "darwin", check: stubCheck(["software", "videotoolbox"], calls) });
  assert.equal(result.family, null);
  assert.deepEqual([...result.supported].sort(), ["baseline:false", "high:false", "main:false"]);
  assert.ok(calls.every((call) => call.startsWith("software:")), calls.join(", "));
});

test("a named family is used alone, and one from another platform says where it works", async () => {
  const calls = [];
  const nvenc = await detectVideoFamilies("nvenc", { platform: "linux", check: stubCheck(["software", "vaapi"], calls), devices: LINUX_DEVICES });
  assert.equal(nvenc.family, null);
  assert.match(nvenc.reasons.nvenc, /could not encode a test frame with h264_nvenc: Unknown encoder 'h264_nvenc'/);
  assert.ok(!calls.some((call) => call.startsWith("vaapi")), "a named family never falls back to another one");
  const vaapi = await detectVideoFamilies("vaapi", { platform: "linux", check: stubCheck(["software", "vaapi"]), devices: LINUX_DEVICES });
  assert.equal(vaapi.family, "vaapi");
  assert.equal(vaapi.device, "/dev/dri/renderD128");
  const apple = await detectVideoFamilies("videotoolbox", { platform: "win32", check: stubCheck(["software", "videotoolbox"]) });
  assert.equal(apple.family, null);
  assert.equal(apple.reasons.videotoolbox, "VideoToolbox (Apple) works only on macOS");
  await assert.rejects(detectVideoFamilies("quicktime", { platform: "darwin", check: stubCheck([]) }), /video encoder must be one of "auto", "software"/);
});

test("a Linux family whose device is not there is not tried, and says what it needs", async () => {
  const calls = [];
  const none = await detectVideoFamilies("auto", { platform: "linux", check: stubCheck(["software", "nvenc", "vaapi", "qsv"], calls), devices: { nvidia: false, renderNodes: [] } });
  assert.equal(none.family, null);
  assert.ok(calls.every((call) => call.startsWith("software:")), calls.join(", "));
  assert.equal(none.reasons.nvenc, "NVENC (NVIDIA) needs an NVIDIA device (/dev/nvidiaN or the NVIDIA kernel driver, or /dev/dxg and libcuda in WSL), and this computer has none");
  assert.equal(none.reasons.vaapi, "VA-API (Linux) needs a render node (/dev/dri/renderD*), and this computer has none");
  assert.equal(none.reasons.qsv, "Quick Sync (Intel) needs a render node (/dev/dri/renderD*), and this computer has none");
  assert.deepEqual(none.failures, {}, "no test encode ran, so none failed");
  const nvidiaOnly = [];
  await detectVideoFamilies("auto", { platform: "wsl", check: stubCheck(["software"], nvidiaOnly), devices: { nvidia: true, renderNodes: [] } });
  assert.deepEqual([...new Set(nvidiaOnly.map((call) => call.split(":")[0]))], ["software", "nvenc"]);
  const list = await listVideoEncoders({ platform: "linux", check: stubCheck(["software", "vaapi"], []), devices: { nvidia: false, renderNodes: [] } });
  assert.deepEqual(list.map((entry) => [entry.id, entry.available]), [["nvenc", false], ["vaapi", false], ["qsv", false], ["software", true]]);
  assert.match(list[1].reason, /needs a render node/);
});

// A stub Linux file system for hardwareDevices: `folders` lists what each folder holds, and every
// other path in `paths` exists.
function stubFiles(folders, paths = []) {
  return {
    list: (folder) => {
      if (!folders[folder]) throw Object.assign(new Error(`ENOENT: ${folder}`), { code: "ENOENT" });
      return folders[folder];
    },
    exists: (path) => Boolean(folders[path]) || paths.includes(path),
  };
}

test("NVENC counts as there when the NVIDIA kernel driver is loaded, before /dev/nvidia0 is made", async () => {
  const dev = { "/dev": ["dri", "null", "tty"], "/dev/dri": ["card0", "renderD129", "renderD128"] };
  // A Linux machine just booted with no display: the driver is loaded, but nothing has made /dev/nvidia0 yet.
  for (const driver of ["/proc/driver/nvidia/version", "/sys/module/nvidia"]) {
    const devices = hardwareDevices("linux", stubFiles(dev, [driver]));
    assert.deepEqual(devices, { nvidia: true, renderNodes: ["/dev/dri/renderD128", "/dev/dri/renderD129"] }, driver);
    const calls = [];
    await detectVideoFamilies("auto", { platform: "linux", check: stubCheck(["software", "nvenc"], calls), devices });
    assert.ok(calls.includes("nvenc:high"), `NVENC is tried with only ${driver}`);
  }
  assert.equal(hardwareDevices("linux", stubFiles({ "/dev": ["nvidia0", "nvidiactl"] })).nvidia, true);
  assert.equal(hardwareDevices("wsl", stubFiles({ "/dev": ["dxg"] }, ["/dev/dxg", "/usr/lib/wsl/lib/libcuda.so.1"])).nvidia, true);
  assert.equal(hardwareDevices("wsl", stubFiles({ "/dev": ["dxg"] }, ["/dev/dxg"])).nvidia, false, "WSL without libcuda has no NVENC");
  // A CI runner has no NVIDIA driver, so NVENC's test encode never runs there.
  const runner = hardwareDevices("linux", stubFiles({ "/dev": ["null", "tty", "kvm"] }));
  assert.deepEqual(runner, { nvidia: false, renderNodes: [] });
  const calls = [];
  await detectVideoFamilies("auto", { platform: "linux", check: stubCheck(["software", "nvenc"], calls), devices: runner });
  assert.ok(calls.every((call) => call.startsWith("software:")), calls.join(", "));
  assert.equal(hardwareDevices("darwin", stubFiles({})), null);
  assert.equal(hardwareDevices("win32", stubFiles({})), null);
});

test("VA-API and QSV try each render node in order and keep the first that works", async () => {
  const devices = { nvidia: false, renderNodes: ["/dev/dri/renderD128", "/dev/dri/renderD129", "/dev/dri/renderD130"] };
  const calls = [];
  const check = async (family, profile, node) => {
    calls.push(`${family}:${profile}:${node}`);
    return family === "software" || node === "/dev/dri/renderD129" ? { ok: true, message: "" } : { ok: false, message: `No VA display found for device ${node}` };
  };
  const result = await detectVideoFamilies("vaapi", { platform: "linux", check, devices });
  assert.equal(result.family, "vaapi");
  assert.equal(result.device, "/dev/dri/renderD129");
  assert.deepEqual(calls.filter((call) => call.startsWith("vaapi:high")), ["vaapi:high:/dev/dri/renderD128", "vaapi:high:/dev/dri/renderD129"],
    "renderD130 is never opened once renderD129 works");
  assert.deepEqual(result.reasons, {});
  const qsv = await detectVideoFamilies("qsv", { platform: "linux", check, devices });
  assert.deepEqual([qsv.family, qsv.device], ["qsv", "/dev/dri/renderD129"]);
  const list = await listVideoEncoders({ platform: "linux", check, devices });
  assert.deepEqual(list.map((entry) => [entry.id, entry.available, entry.device]),
    [["nvenc", false, null], ["vaapi", true, "/dev/dri/renderD129"], ["qsv", true, "/dev/dri/renderD129"], ["software", true, null]]);
  const broken = await detectVideoFamilies("vaapi", { platform: "linux", check: async (family, profile, node) => ({ ok: family === "software", message: `No VA display found for device ${node}` }), devices });
  assert.deepEqual([broken.family, broken.device], [null, null]);
  assert.equal(broken.reasons.vaapi, "FFmpeg could not encode a test frame with h264_vaapi: No VA display found for device /dev/dri/renderD128");
});

test("the list of video encoders follows the auto order and says why one does not work", async () => {
  const list = await listVideoEncoders({ platform: "win32", check: stubCheck(["software", "qsv"]) });
  assert.deepEqual(list.map((entry) => [entry.id, entry.available]), [["nvenc", false], ["amf", false], ["qsv", true], ["software", true]]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["available", "device", "ffmpegEncoder", "id", "label", "reason"]);
  assert.equal(list[0].ffmpegEncoder, "h264_nvenc");
  assert.match(list[0].reason, /h264_nvenc: Unknown encoder/);
  assert.equal(list[2].reason, "");
  const mac = await listVideoEncoders({ platform: "darwin", check: stubCheck(["software", "videotoolbox"]) });
  assert.deepEqual(mac.map((entry) => entry.id), ["videotoolbox", "software"]);
});

test("a named family that does not work is a plain error naming why and what does work", () => {
  const list = [
    { id: "nvenc", available: false }, { id: "vaapi", available: true }, { id: "qsv", available: false }, { id: "software", available: true },
  ];
  assert.equal(videoEncoderUnavailableMessage("nvenc", "FFmpeg could not encode a test frame with h264_nvenc: Cannot load libcuda.so.1", list),
    'The video encoder "nvenc" does not work on this computer: FFmpeg could not encode a test frame with h264_nvenc: Cannot load libcuda.so.1. '
    + 'Video encoders that work here: "vaapi", "software". Choose one of them or "auto".');
  assert.match(videoEncoderUnavailableMessage("amf", "", []), /^The video encoder "amf" does not work on this computer: the AMF \(AMD\) test encode failed\. No video encoder works here; check that FFmpeg is installed\.$/);
  // The failing encoder is never listed as one that works, even when the 1280x720 list says it does.
  const stale = videoEncoderUnavailableMessage("vaapi", "FFmpeg could not encode a test frame with h264_vaapi: No VA display found", list);
  assert.match(stale, /Video encoders that work here: "software"\./);
  assert.doesNotMatch(stale, /work here: .*"vaapi"/);
});

// What the test encodes at a 128x72 file found on a computer whose NVENC works at 1280x720 but not here.
function foundTooSmall(overrides = {}) {
  return {
    available: MP4_ENCODERS.filter((entry) => !entry.hardware).map((entry) => entry.id), family: null, device: null,
    reasons: { nvenc: "FFmpeg could not encode a test frame with h264_nvenc: InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value" },
    failures: { nvenc: [{ device: null, message: "InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value", deviceFailed: false }] },
    ...overrides,
  };
}
const NVENC_WORKS = [{ id: "nvenc", available: true }, { id: "vaapi", available: false }, { id: "qsv", available: false }, { id: "software", available: true }];
const NOTHING_WORKS = [{ id: "nvenc", available: false }, { id: "vaapi", available: false }, { id: "qsv", available: false }, { id: "software", available: true }];
const SMALL = { width: 128, height: 72, fps: 30 };

test("a named hardware encoder that works here but not at this size encodes the file in software and says why", async () => {
  const reason = "NVENC cannot encode frames this small: 128x72";
  assert.deepEqual(await chooseMp4Encoder(null, SMALL, "nvenc", foundTooSmall(), async () => NVENC_WORKS),
    { id: "h264HighSwAAC", family: "software", device: null, reason });
  // An Hw id asked for by name stays an error, and says why.
  await assert.rejects(chooseMp4Encoder("h264MainHwOpus", SMALL, "nvenc", foundTooSmall(), async () => NVENC_WORKS),
    /^Error: The MP4 encoder h264MainHwOpus is unavailable on this computer for these export settings\. NVENC cannot encode frames this small: 128x72\. Try another alternative\.$/);
  // Auto says the same, instead of quietly using libx264.
  assert.deepEqual(await chooseMp4Encoder(null, SMALL, "auto", foundTooSmall(), async () => NVENC_WORKS),
    { id: "h264HighSwAAC", family: "software", device: null, reason });
  // Another reason than the size is quoted with the size and frame rate.
  const large = foundTooSmall({ failures: { nvenc: [{ device: null, message: "No capable devices found", deviceFailed: false }] } });
  assert.equal((await chooseMp4Encoder(null, { width: 4320, height: 2160, fps: 30 }, "nvenc", large, async () => NVENC_WORKS)).reason,
    "NVENC cannot encode 4320x2160 at 30 fps: No capable devices found");
  // An Sw id asked for needs no hardware, so nothing is said.
  assert.equal((await chooseMp4Encoder("h264HighSwAAC", SMALL, "nvenc", foundTooSmall(), async () => assert.fail("no list needed"))).reason, "");
});

test("a named hardware encoder that does not work here at all is still an error that never lists it", async () => {
  await assert.rejects(chooseMp4Encoder(null, SMALL, "nvenc", foundTooSmall(), async () => NOTHING_WORKS), (error) => {
    assert.equal(error.message, 'The video encoder "nvenc" does not work on this computer: FFmpeg could not encode a test frame with h264_nvenc: '
      + 'InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value. Video encoders that work here: "software". Choose one of them or "auto".');
    return true;
  });
  // A family with no device here was never probed: an error, not a fallback.
  const missing = foundTooSmall({ reasons: { nvenc: "NVENC (NVIDIA) needs an NVIDIA device (/dev/nvidiaN or the NVIDIA kernel driver, or /dev/dxg and libcuda in WSL), and this computer has none" }, failures: {} });
  await assert.rejects(chooseMp4Encoder(null, SMALL, "nvenc", missing, async () => NOTHING_WORKS), /needs an NVIDIA device .+, and this computer has none\. Video encoders that work here: "software"\./);
  // Auto with no hardware that works anywhere here uses libx264 without a reason, and skips the list when nothing was probed.
  assert.equal((await chooseMp4Encoder(null, SMALL, "auto", foundTooSmall(), async () => NOTHING_WORKS)).reason, "");
  assert.deepEqual(await chooseMp4Encoder(null, SMALL, "auto", missing, async () => assert.fail("nothing failed, so no list")),
    { id: "h264HighSwAAC", family: "software", device: null, reason: "" });
  // A family that works at this size keeps its render node.
  assert.deepEqual(await chooseMp4Encoder(null, { width: 1280, height: 720, fps: 30 }, "vaapi",
    { available: MP4_ENCODERS.map((entry) => entry.id), family: "vaapi", device: "/dev/dri/renderD129", reasons: {}, failures: {} }, async () => assert.fail("no list needed")),
  { id: "h264HighHwAAC", family: "vaapi", device: "/dev/dri/renderD129", reason: "" });
});

// Two render nodes: renderD128 is a card whose VA-API does not open or does not encode, and
// renderD129 an Intel GPU whose VA-API encodes at 1280x720 but not a 64x64 file. `first` is what
// renderD128 says, and `small` what renderD129 says at 64x64.
const TWO_NODES = { nvidia: false, renderNodes: ["/dev/dri/renderD128", "/dev/dri/renderD129"] };
const NO_VA_DISPLAY = { ok: false, message: "[AVHWDeviceContext] No VA display found for device /dev/dri/renderD128", deviceFailed: true };
const INTEL_SIZE = "Hardware does not support encoding at size 64x64 (constraints: width 128-4096 height 128-4096)";
function twoNodeCheck({ width }, first, small = INTEL_SIZE) {
  return async (family, profile, node) => {
    if (family === "software") return { ok: true, message: "" };
    if (node === "/dev/dri/renderD128") return first;
    return width >= 1280 ? { ok: true, message: "" } : { ok: false, message: small, deviceFailed: false };
  };
}
const TINY = { width: 64, height: 64, fps: 30 };
const SOFTWARE_IDS = MP4_ENCODERS.filter((entry) => !entry.hardware).map((entry) => entry.id);

test("with several render nodes, why a file is encoded in software quotes the node the family works on", async () => {
  const list = await listVideoEncoders({ platform: "linux", check: twoNodeCheck({ width: 1280 }, NO_VA_DISPLAY), devices: TWO_NODES });
  assert.deepEqual([list[1].id, list[1].available, list[1].device], ["vaapi", true, "/dev/dri/renderD129"]);
  const found = await detectVideoFamilies("vaapi", { platform: "linux", check: twoNodeCheck(TINY, NO_VA_DISPLAY), devices: TWO_NODES });
  assert.deepEqual(found.failures.vaapi.map((failure) => [failure.device, failure.deviceFailed]),
    [["/dev/dri/renderD128", true], ["/dev/dri/renderD129", false]]);
  const reason = `VA-API cannot encode 64x64 at 30 fps: ${INTEL_SIZE}`;
  assert.deepEqual(await chooseMp4Encoder(null, TINY, "vaapi", { available: SOFTWARE_IDS, ...found }, async () => list),
    { id: "h264HighSwAAC", family: "software", device: null, reason });
  await assert.rejects(chooseMp4Encoder("h264HighHwAAC", TINY, "vaapi", { available: SOFTWARE_IDS, ...found }, async () => list),
    (error) => error.message === `The MP4 encoder h264HighHwAAC is unavailable on this computer for these export settings. ${reason}. Try another alternative.`);
  // renderD128 encodes nothing but opens, so its error is an encoder's too: the node that works at 1280x720 is quoted.
  const noEntrypoint = { ok: false, message: "No usable encoding entrypoint found for profile VAProfileH264High (7)", deviceFailed: false };
  const other = await detectVideoFamilies("vaapi", { platform: "linux", check: twoNodeCheck(TINY, noEntrypoint), devices: TWO_NODES });
  assert.equal((await chooseMp4Encoder(null, TINY, "vaapi", { available: SOFTWARE_IDS, ...other }, async () => list)).reason, reason);
  // A size message from the second node is read as one.
  const tooSmall = await detectVideoFamilies("auto", { platform: "linux", check: twoNodeCheck(TINY, NO_VA_DISPLAY, "Frame Dimension less than the minimum supported value"), devices: TWO_NODES });
  assert.equal((await chooseMp4Encoder(null, TINY, "auto", { available: SOFTWARE_IDS, ...tooSmall }, async () => list)).reason,
    "VA-API cannot encode frames this small: 64x64");
});

test("a family that works on no render node quotes an encoder's error before a device that did not open", async () => {
  const broken = { ok: false, message: "Failed to upload frame (-38)", deviceFailed: false };
  const check = async (family, profile, node) => (family === "software" ? { ok: true, message: "" } : node === "/dev/dri/renderD128" ? NO_VA_DISPLAY : broken);
  const found = await detectVideoFamilies("vaapi", { platform: "linux", check, devices: TWO_NODES });
  assert.equal(found.reasons.vaapi, "FFmpeg could not encode a test frame with h264_vaapi: Failed to upload frame (-38)");
  const list = await listVideoEncoders({ platform: "linux", check, devices: TWO_NODES });
  assert.deepEqual([list[1].available, list[1].device, list[1].reason], [false, null, found.reasons.vaapi]);
  await assert.rejects(chooseMp4Encoder(null, TINY, "vaapi", { available: SOFTWARE_IDS, ...found }, async () => list),
    /^Error: The video encoder "vaapi" does not work on this computer: FFmpeg could not encode a test frame with h264_vaapi: Failed to upload frame \(-38\)\. /);
  // When every node fails to open, the first is quoted, as before.
  const closed = await detectVideoFamilies("vaapi", { platform: "linux", check: async (family) => (family === "software" ? { ok: true, message: "" } : NO_VA_DISPLAY), devices: TWO_NODES });
  assert.match(closed.reasons.vaapi, /No VA display found for device \/dev\/dri\/renderD128$/);
});

test("video encoder options are checked: known values, MP4 only, not with the fallback", () => {
  assert.deepEqual(VIDEO_ENCODERS, ["auto", "software", "videotoolbox", "nvenc", "qsv", "amf", "vaapi"]);
  for (const videoEncoder of VIDEO_ENCODERS) checkVideoEncoderOptions({ videoEncoder }, "mp4");
  for (const videoQuality of VIDEO_QUALITIES) checkVideoEncoderOptions({ videoQuality }, "mp4");
  checkVideoEncoderOptions({}, "webm");
  assert.throws(() => checkVideoEncoderOptions({ videoEncoder: "x264" }, "mp4"),
    /^Error: The video encoder must be one of "auto", "software", "videotoolbox", "nvenc", "qsv", "amf", "vaapi"\.$/);
  assert.throws(() => checkVideoEncoderOptions({ videoQuality: "best" }, "mp4"), /^Error: The video quality must be one of "small", "standard", "high"\.$/);
  assert.throws(() => checkVideoEncoderOptions({ videoQuality: 2 }, "mp4"), /video quality must be one of/);
  assert.throws(() => checkVideoEncoderOptions({ videoEncoder: "software" }, "webm"), /apply only to MP4 exports/);
  assert.throws(() => checkVideoEncoderOptions({ videoQuality: "high" }, "gif"), /apply only to MP4 exports/);
  assert.throws(() => checkVideoEncoderOptions({ videoQuality: "high", profile: "mp4.alt" }, "mp4"), /MP4 fallback uses its own encoder settings/);
});

test("a batch export accepts videoEncoder and videoQuality and refuses wrong ones with a 400", async (t) => {
  const exportBatches = createExportBatches();
  t.after(() => exportBatches.close());
  const scene = createScene({ id: "plain", name: "Plain", width: 64, height: 64, duration: 0.2, background: "#000000", layers: [] });
  const document = createDocument({ name: "Encoder options", scenes: [scene] });
  for (const [options, message] of [
    [{ format: "mp4", videoEncoder: "h265" }, /^The video encoder must be one of "auto", "software",/],
    [{ format: "mp4", videoQuality: "max" }, /^The video quality must be one of "small", "standard", "high"\.$/],
    [{ format: "webm", videoQuality: "high" }, /^The video encoder and video quality settings apply only to MP4 exports\.$/],
    [{ profile: "mp4.alt", videoEncoder: "software" }, /^The MP4 fallback uses its own encoder settings\.$/],
  ]) await assert.rejects(exportBatches.create({ document, sceneIds: [scene.id], options }),
    (error) => error.status === 400 && message.test(error.message), JSON.stringify(options));
  const batch = await exportBatches.create({ document, sceneIds: [scene.id], options: { format: "mp4", videoEncoder: "software", videoQuality: "small" } });
  assert.deepEqual([batch.jobs[0].options.videoEncoder, batch.jobs[0].options.videoQuality], ["software", "small"]);
});
