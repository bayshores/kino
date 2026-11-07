import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { MP4_ENCODERS, mp4Encoder } from "../engine/mp4Encoders.js";
import { validateExportDimensions } from "../engine/exportOptions.js";
import { FPS_HELP, ffmpegRate, parseFps } from "../engine/frameRate.js";

const capabilityCache = new Map();
const CACHE_LIFETIME = 60_000;
const MAX_CACHED_CONFIGURATIONS = 16;
let probeQueue = Promise.resolve();

// The video encoder setting (exports.videoEncoder, or options.videoEncoder for one render).
// "Hw" in an MP4 encoder id means "this computer's hardware encoder": the family chosen here.
// "auto" tries this platform's families in AUTO_ORDER and keeps the first that encodes a test
// frame; "software" makes every Hw id unavailable; a named family is used alone, or is an error.
export const VIDEO_ENCODERS = ["auto", "software", "videotoolbox", "nvenc", "qsv", "amf", "vaapi"];
// The video quality setting sets the bitrate of every MP4 encoder, libx264 included.
// "standard" keeps the bitrates kino always used, so standard files do not change.
export const VIDEO_QUALITIES = ["small", "standard", "high"];
// "draft" is kino's own, for preview segments (preview-segments.mjs); agents and settings use the other three.
const QUALITY_SCALE = { draft: 0.25, small: 0.5, standard: 1, high: 2 };
const FAMILIES = {
  software: { ffmpegEncoder: "libx264", label: "Software (libx264)", name: "libx264" },
  videotoolbox: { ffmpegEncoder: "h264_videotoolbox", label: "VideoToolbox (Apple)", name: "VideoToolbox", where: "macOS" },
  nvenc: { ffmpegEncoder: "h264_nvenc", label: "NVENC (NVIDIA)", name: "NVENC", where: "Linux, WSL and Windows" },
  qsv: { ffmpegEncoder: "h264_qsv", label: "Quick Sync (Intel)", name: "Quick Sync", where: "Linux, WSL and Windows" },
  amf: { ffmpegEncoder: "h264_amf", label: "AMF (AMD)", name: "AMF", where: "Windows" },
  vaapi: { ffmpegEncoder: "h264_vaapi", label: "VA-API (Linux)", name: "VA-API", where: "Linux and WSL" },
};
// Which hardware families each platform has, in the order "auto" tries them. WSL is Linux here.
const AUTO_ORDER = { darwin: ["videotoolbox"], win32: ["nvenc", "amf", "qsv"], linux: ["nvenc", "vaapi", "qsv"] };
// The render node QSV and VA-API open when no probe chose one.
const FIRST_RENDER_NODE = "/dev/dri/renderD128";
// The device files a Linux family needs. Without them its test encode cannot work, so it is not run.
const NEEDS = {
  nvenc: "an NVIDIA device (/dev/nvidiaN or the NVIDIA kernel driver, or /dev/dxg and libcuda in WSL)",
  vaapi: "a render node (/dev/dri/renderD*)",
  qsv: "a render node (/dev/dri/renderD*)",
};
const LIST_LIFETIME = 10 * 60_000;
let listCache = null;

function ffmpegCommand() {
  return process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
}

function platformKind(platform = process.platform) {
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

/** This platform's hardware video encoder families, in the order "auto" tries them. */
export function hardwareFamilies(platform = process.platform) {
  return [...AUTO_ORDER[platformKind(platform)]];
}

// The file system calls hardwareDevices makes, so tests can answer them.
const REAL_FILES = { list: (folder) => readdirSync(folder), exists: (path) => existsSync(path) };

/**
 * The video devices Linux has, as { nvidia, renderNodes }: whether an NVIDIA device is there
 * (/dev/nvidia0 and on, the NVIDIA kernel driver, or /dev/dxg plus libcuda in WSL) and the
 * /dev/dri/renderD* nodes in order. Null on macOS and Windows, where the families find their own
 * device. `files` ({ list(folder), exists(path) }) replaces the real file system (tests).
 */
export function hardwareDevices(platform = process.platform, files = REAL_FILES) {
  if (platformKind(platform) !== "linux") return null;
  const names = (folder) => { try { return files.list(folder); } catch { return []; } };
  const renderNodes = names("/dev/dri").filter((name) => /^renderD\d+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7))).map((name) => `/dev/dri/${name}`);
  // The driver does not make /dev/nvidia0 itself: udev, nvidia-persistenced or nvidia-modprobe do,
  // and libcuda runs nvidia-modprobe when NVENC first opens. So on a machine just booted with no
  // display, the loaded driver alone says NVENC can work.
  const driver = ["/proc/driver/nvidia/version", "/sys/module/nvidia"].some((path) => files.exists(path));
  const wslCuda = files.exists("/dev/dxg") && ["/usr/lib/wsl/lib/libcuda.so.1", "/usr/lib/wsl/lib/libcuda.so"].some((path) => files.exists(path));
  return { nvidia: names("/dev").some((name) => /^nvidia\d+$/.test(name)) || driver || wslCuda, renderNodes };
}

// The nodes a family's test encode may open: [null] for a family that finds its own device,
// [] when the device it needs is not there.
function familyNodes(family, devices) {
  if (!devices || !NEEDS[family]) return [null];
  if (family === "nvenc") return devices.nvidia ? [null] : [];
  return devices.renderNodes;
}

/** The bitrate (bits per second) of an MP4 at this size and quality. */
export function videoBitrate({ width, height }, quality = "standard") {
  return (width >= 720 && height >= 720 ? 24_000_000 : 12_000_000) * QUALITY_SCALE[quality];
}

// The family that encodes an MP4 encoder's picture: software for an Sw id, else the given family
// (or this platform's first one, which on a Mac is VideoToolbox as before).
function familyOf(encoder, family, platform) {
  if (!encoder.hardware || family === "software") return "software";
  return family && family !== "auto" ? family : AUTO_ORDER[platformKind(platform)][0];
}

/**
 * The FFmpeg arguments of an MP4 encoder's picture, as { input, output }: `input` goes before
 * the frames' `-i` (QSV and VA-API open their device there: `device`, a Linux render node), `output` after it.
 * The RGBA frames become yuv420p or nv12 in FFmpeg's swscale for every family, so the frame
 * audit compares the same colours whichever encoder made the file.
 */
export function videoEncoderArgs(id, { width, height }, { family, quality = "standard", platform = process.platform, device } = {}) {
  const encoder = mp4Encoder(id);
  const bitrate = videoBitrate({ width, height }, quality);
  const rate = String(bitrate);
  const linux = platformKind(platform) === "linux";
  // AMF and VA-API name the Base profile constrained_baseline.
  const constrained = encoder.profile === "baseline" ? "constrained_baseline" : encoder.profile;
  switch (familyOf(encoder, family, platform)) {
    case "software": return { input: [], output: ["-c:v", "libx264", "-profile:v", encoder.profile, "-pix_fmt", "yuv420p", "-b:v", rate] };
    case "videotoolbox": return { input: [], output: [
      "-c:v", "h264_videotoolbox", "-profile:v", encoder.profile, "-pix_fmt", "yuv420p", "-b:v", rate, "-allow_sw", "0"] };
    case "nvenc": return { input: [], output: [
      "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-b:v", rate,
      "-maxrate", String(Math.round(bitrate * 1.5)), "-bufsize", String(bitrate * 2), "-pix_fmt", "yuv420p", "-profile:v", encoder.profile] };
    // FFmpeg reads "qsv=name:device" with device as the MFX implementation, so the render node
    // goes in child_device (FFmpeg's "-init_hw_device" documentation and hwcontext_qsv.c).
    case "qsv": return { input: ["-init_hw_device", linux ? `qsv=hw,child_device=${device ?? FIRST_RENDER_NODE}` : "qsv=hw"], output: [
      "-pix_fmt", "nv12", "-c:v", "h264_qsv", "-profile:v", encoder.profile, "-b:v", rate] };
    case "amf": return { input: [], output: [
      "-c:v", "h264_amf", "-usage", "transcoding", "-quality", "quality", "-profile:v", constrained, "-pix_fmt", "nv12", "-b:v", rate] };
    case "vaapi": return { input: ["-vaapi_device", device ?? FIRST_RENDER_NODE], output: [
      "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-profile:v", constrained, "-b:v", rate] };
    default: throw new Error(`Unknown video encoder “${family}”.`);
  }
}

function audioArgs(encoder, aacCodec = "aac") {
  return [
    "-c:a", encoder.audio === "opus" ? "libopus" : aacCodec,
    "-ar", "48000", "-ac", "2", "-b:a", "128k",
    ...(encoder.audio === "aac" && aacCodec === "aac_at" ? ["-aac_at_mode", "cvbr"] : []),
  ];
}

// Lines FFmpeg prints after the line that says what went wrong, such as
// "[out#0/mp4 @ 0x...] Nothing was written into output file...".
const FOLLOW_ON_LINE = /Nothing was written into output file|Error while (opening encoder|filtering)|Error sending frames to consumers|Could not open encoder before EOF|Task finished with error code|Terminating thread with return code|Conversion failed|Error initializing output stream|Error parsing global options/i;

/**
 * The line of FFmpeg's error output that says why an encode failed, as a short reason a person can
 * read: the first line from the `encoder` itself, else the first that is not a follow-on line.
 * Pointer addresses ("@ 0x55d...") are removed so the same failure always reads the same, and the
 * final full stop, since the reason goes inside a sentence.
 */
export function ffmpegReason(text, encoder) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/ @ 0x[0-9a-f]+/gi, "").trim()).filter(Boolean);
  const telling = lines.filter((line) => !FOLLOW_ON_LINE.test(line));
  const own = encoder && telling.find((line) => line.startsWith(`[${encoder}]`));
  const line = own ? own.slice(encoder.length + 2).trim() : telling[0] ?? lines.at(-1) ?? "";
  return line.replace(/\.$/, "").slice(0, 200);
}

// A listed codec is not proof that it can encode this output size/frame rate.
// Encode a real frame at the requested settings before advertising it.
// Resolves { ok, message, deviceFailed }: message is FFmpeg's reason (ffmpegReason) when the encode
// failed, and deviceFailed says the hardware device did not open, so the encoder never ran. FFmpeg
// 6.1.1 and 9.0.2 both print "Device creation failed: -22." then, whatever the first line says
// ("[AVHWDeviceContext] No VA display found..." in 6.1.1, "[VAAPI] No VA display found..." in 9.0.2).
function probe(command, args, signal, encoder) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
      shell: false, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    const abort = () => child.kill("SIGKILL");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    signal.addEventListener("abort", abort, { once: true });
    function finish(ok, message, deviceFailed = false) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else resolve({ ok, message, deviceFailed });
    }
    child.once("error", (error) => finish(false, error.code === "ENOENT" ? `FFmpeg was not found at ${command}` : error.message));
    child.once("close", (code) => finish(code === 0, code === 0 ? "" : ffmpegReason(stderr, encoder) || `FFmpeg stopped with code ${code}`,
      code !== 0 && /Device creation failed/.test(stderr)));
  });
}

// One black RGBA test frame at the export's size, encoded like a real export.
function videoProbeArgs(id, configuration, family, platform, device) {
  const { input, output } = videoEncoderArgs(id, configuration, { family, platform, device });
  return [
    ...input, "-f", "lavfi", "-i", `color=black:s=${configuration.width}x${configuration.height}:r=${ffmpegRate(configuration.fps)},format=rgba`,
    "-frames:v", "1", "-an", ...output, "-threads", "1", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "-",
  ];
}

function encoderConfiguration({ width = 64, height = 64, fps = 30 } = {}) {
  validateExportDimensions({ width, height });
  if (width % 2 || height % 2) throw new Error("MP4 dimensions must be even numbers.");
  // 29.97, "29.97", "30000/1001" and {num, den} all name 30000/1001 (frameRate.js).
  const rate = parseFps(fps);
  if (rate === null) throw new Error(`Export frame rate: ${FPS_HELP}.`);
  return { width, height, fps: rate };
}

function checkVideoEncoderSetting(setting) {
  if (!VIDEO_ENCODERS.includes(setting))
    throw new Error(`The video encoder must be one of ${VIDEO_ENCODERS.map((name) => `"${name}"`).join(", ")}.`);
}

/**
 * Which failed test encode of a family to quote, of `failures` (one per render node tried, as
 * { device, message, deviceFailed }): the one on `device`, the node where the family works at
 * 1280x720, when it is given; else the first where the encoder ran, since "No VA display" on
 * another card's node says nothing about this one; else the first.
 */
function failureToQuote(failures, device = null) {
  return failures.find((failure) => device !== null && failure.device === device)
    ?? failures.find((failure) => !failure.deviceFailed) ?? failures[0];
}

/**
 * Which H.264 profiles encode here with the `setting` video encoder. `check(family, profile, node)`
 * encodes one test frame (QSV and VA-API on that render node, else node is null) and resolves
 * { ok, message, deviceFailed } (probe). Software profiles are always checked; hardware families
 * are tried one at a time (some machines allow few hardware sessions), QSV and VA-API on each
 * render node in order, and "auto" stops at the first family that encodes any profile. A family
 * whose device is not in `devices` (hardwareDevices) is not tried. Resolves { family: the chosen
 * hardware family or null, device: the render node it encodes on or null, supported: Set of
 * "profile:hardware", reasons: { family: why it failed }, failures: { family: its failed test
 * encodes, one per render node tried (device null for a family that finds its own device), as
 * [{ device, message: FFmpeg's reason, deviceFailed }] } }.
 */
export async function detectVideoFamilies(setting, { platform = process.platform, check, devices = hardwareDevices(platform) }) {
  checkVideoEncoderSetting(setting);
  const profiles = [...new Set(MP4_ENCODERS.map((encoder) => encoder.profile))];
  const supported = new Set();
  const reasons = {};
  const failures = {};
  const families = hardwareFamilies(platform);
  const candidates = setting === "software" ? [] : setting === "auto" ? families : [setting];
  let family = null;
  let device = null;
  for (const profile of profiles) if ((await check("software", profile, null)).ok) supported.add(`${profile}:false`);
  for (const candidate of candidates) {
    if (!families.includes(candidate)) {
      reasons[candidate] = `${FAMILIES[candidate].label} works only on ${FAMILIES[candidate].where}`;
      continue;
    }
    const nodes = familyNodes(candidate, devices);
    if (!nodes.length) reasons[candidate] = `${FAMILIES[candidate].label} needs ${NEEDS[candidate]}, and this computer has none`;
    for (const node of nodes) {
      let failure = null;
      for (const profile of profiles) {
        const result = await check(candidate, profile, node);
        if (result.ok) supported.add(`${profile}:true`);
        else failure ??= { device: node, message: result.message, deviceFailed: Boolean(result.deviceFailed) };
      }
      if (profiles.some((profile) => supported.has(`${profile}:true`))) {
        family = candidate;
        device = node;
        delete failures[candidate];
        break;
      }
      (failures[candidate] ??= []).push(failure);
    }
    if (family) break;
    if (failures[candidate]) {
      const { message } = failureToQuote(failures[candidate]);
      reasons[candidate] = `FFmpeg could not encode a test frame with ${FAMILIES[candidate].ffmpegEncoder}: ${message}`;
    }
  }
  return { family, device, supported, reasons, failures };
}

async function detectEncoders(command, configuration, signal, setting, devices) {
  signal.throwIfAborted();
  const id = (profile, hardware) => MP4_ENCODERS.find((encoder) => encoder.profile === profile && encoder.hardware === hardware).id;
  const { family, device, supported, reasons, failures } = await detectVideoFamilies(setting, {
    devices,
    check: (candidate, profile, node) => probe(command, videoProbeArgs(id(profile, candidate !== "software"), configuration, candidate, process.platform, node),
      signal, FAMILIES[candidate].ffmpegEncoder),
  });
  const audioSupport = new Map();
  let aacCodec = "aac";
  for (const audio of ["aac", "opus"]) {
    for (const codec of audio === "aac" && process.platform === "darwin" ? ["aac_at", "aac"] : ["aac"]) {
      const { ok } = await probe(command, [
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "0.04", "-vn",
        ...audioArgs({ audio }, codec), "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "-",
      ], signal);
      audioSupport.set(audio, ok);
      if (ok) {
        if (audio === "aac") aacCodec = codec;
        break;
      }
    }
  }
  return {
    encoders: MP4_ENCODERS.filter((encoder) => supported.has(`${encoder.profile}:${encoder.hardware}`) && audioSupport.get(encoder.audio))
      .map((encoder) => encoder.id),
    aacCodec,
    family,
    device,
    reasons,
    failures,
  };
}

async function detectFallback(command, configuration, signal) {
  const { ok } = await probe(command, [
    "-f", "lavfi", "-i", `color=black:s=${configuration.width}x${configuration.height}:r=${ffmpegRate(configuration.fps)},format=rgba`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-frames:v", "1", "-t", "0.1",
    ...mp4FallbackEncodingArgs({ hasAudio: true }), "-threads", "1",
    "-movflags", "frag_keyframe+empty_moov", "-",
  ], signal);
  return { encoders: ok ? ["mp4.alt"] : [], aacCodec: "aac", family: null, device: null, reasons: {}, failures: {} };
}

function capabilities(configuration, signal, fallback = false, setting = "auto") {
  signal?.throwIfAborted();
  const command = ffmpegCommand();
  // The family setting and the devices present are part of the key: "software" and "auto" probe
  // differently, and a render node that comes or goes can change which one encodes.
  const devices = hardwareDevices();
  const key = JSON.stringify([command, configuration, fallback, fallback ? null : setting, devices]);
  for (const [cachedKey, entry] of capabilityCache) {
    if (entry.complete && entry.expiresAt <= Date.now()) capabilityCache.delete(cachedKey);
  }
  let entry = capabilityCache.get(key);
  if (!entry) {
    if (capabilityCache.size >= MAX_CACHED_CONFIGURATIONS) {
      const oldestComplete = [...capabilityCache].find(([, value]) => value.complete);
      if (oldestComplete) capabilityCache.delete(oldestComplete[0]);
      else throw new Error("Encoder checks are busy. Try again shortly.");
    }
    entry = { controller: new AbortController(), clients: 0, complete: false, expiresAt: Infinity };
    capabilityCache.set(key, entry);
    // Serialize configurations too, so rapid UI changes cannot open competing
    // hardware sessions. Cancelled queued checks never start an encoder.
    entry.promise = probeQueue.then(() => fallback
      ? detectFallback(command, configuration, entry.controller.signal)
      : detectEncoders(command, configuration, entry.controller.signal, setting, devices))
      .then((result) => {
        entry.complete = true;
        entry.expiresAt = Date.now() + CACHE_LIFETIME;
        return result;
      }, (error) => {
        if (capabilityCache.get(key) === entry) capabilityCache.delete(key);
        throw error;
      });
    probeQueue = entry.promise.catch(() => {});
  }
  // Concurrent exports can share a check. Cancelling one caller must not stop
  // another caller that is still using it; the final cancellation kills it.
  return new Promise((resolve, reject) => {
    entry.clients += 1;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      entry.clients -= 1;
      if (!entry.complete && entry.clients === 0) {
        if (capabilityCache.get(key) === entry) capabilityCache.delete(key);
        entry.controller.abort();
      }
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then((result) => finish(null, result), (error) => finish(error));
  });
}

/**
 * The video encoders of this platform (in the order "auto" tries them) and then software, each
 * as { id, label, ffmpegEncoder, available, device, reason }. Each encodes one 1280x720 test
 * frame at 30 fps (QSV and VA-API on each render node until one works, and `device` is that node,
 * else null; a family whose device is not in `devices` is not tried); the list is kept 10 minutes,
 * and `refresh` checks again. The first available entry is what "auto" picks here. `check`
 * replaces the real FFmpeg test encode (tests).
 */
export async function listVideoEncoders({ refresh = false, signal, platform = process.platform, check, devices = hardwareDevices(platform) } = {}) {
  const real = !check;
  if (real && !refresh && listCache && listCache.expiresAt > Date.now()) return listCache.promise;
  const configuration = { width: 1280, height: 720, fps: 30 };
  const command = ffmpegCommand();
  const controller = new AbortController();
  check ??= (family, profile, node) => probe(command, videoProbeArgs(family === "software" ? "h264HighSwAAC" : "h264HighHwAAC", configuration, family, platform, node),
    controller.signal, FAMILIES[family].ffmpegEncoder);
  const families = [...hardwareFamilies(platform), "software"];
  const run = async () => {
    const list = [];
    for (const id of families) {
      const nodes = familyNodes(id, devices);
      let available = false;
      let device = null;
      const failures = [];
      for (const node of nodes) {
        const result = await check(id, "high", node);
        available = result.ok;
        if (available) {
          device = node;
          break;
        }
        failures.push({ device: node, message: result.message, deviceFailed: Boolean(result.deviceFailed) });
      }
      const reason = available ? "" : !nodes.length ? `${FAMILIES[id].label} needs ${NEEDS[id]}, and this computer has none`
        : `FFmpeg could not encode a test frame with ${FAMILIES[id].ffmpegEncoder}: ${failureToQuote(failures).message}`;
      list.push({ id, label: FAMILIES[id].label, ffmpegEncoder: FAMILIES[id].ffmpegEncoder, available, device, reason });
    }
    return list;
  };
  if (!real) return run();
  // One at a time with the export probes, so no two checks open hardware sessions together.
  const promise = probeQueue.then(run);
  probeQueue = promise.catch(() => {});
  const entry = { promise, expiresAt: Infinity };
  listCache = entry;
  promise.then(() => { entry.expiresAt = Date.now() + LIST_LIFETIME; },
    () => { if (listCache === entry) listCache = null; });
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** The sentence for a named video encoder that does not work here: why, and which others do. */
export function videoEncoderUnavailableMessage(setting, reason, list) {
  const working = list.filter((entry) => entry.available && entry.id !== setting).map((entry) => `"${entry.id}"`);
  return `The video encoder "${setting}" does not work on this computer: ${reason || `the ${FAMILIES[setting].label} test encode failed`}. `
    + (working.length ? `Video encoders that work here: ${working.join(", ")}. Choose one of them or "auto".` : "No video encoder works here; check that FFmpeg is installed.");
}

/**
 * Checks the per-render video encoder options. Throws a plain Error when videoEncoder or
 * videoQuality has an unknown value, or is given for a format other than MP4 or for the
 * MP4 fallback (which has its own settings). `draft` also allows kino's own "draft" quality.
 */
export function checkVideoEncoderOptions(options, format, { draft = false } = {}) {
  if (options.videoEncoder != null) checkVideoEncoderSetting(options.videoEncoder);
  if (options.videoQuality != null && !VIDEO_QUALITIES.includes(options.videoQuality) && !(draft && options.videoQuality === "draft"))
    throw new Error(`The video quality must be one of ${VIDEO_QUALITIES.map((name) => `"${name}"`).join(", ")}.`);
  if (options.videoEncoder == null && options.videoQuality == null) return;
  if (format !== "mp4") throw new Error("The video encoder and video quality settings apply only to MP4 exports.");
  if (options.profile === "mp4.alt") throw new Error("The MP4 fallback uses its own encoder settings.");
}

export async function getMp4Encoders(configuration, { signal, videoEncoder = "auto" } = {}) {
  checkVideoEncoderSetting(videoEncoder);
  return [...(await capabilities(encoderConfiguration(configuration), signal, false, videoEncoder)).encoders];
}

// Why a hardware family that works on this computer (it encoded listVideoEncoders' 1280x720 test
// frame) cannot encode this file. Measured on an RTX 4090 in WSL2 with FFmpeg 6.1.1 and 9.0.2:
// NVENC encodes H.264 frames from 145x49 up to 4096 wide, in every profile; 144 wide or 48 high
// fails with "Frame Dimension less than the minimum supported value", 4098 wide with "No capable devices found".
function cannotEncodeThisFile(family, { width, height, fps }, message) {
  if (/less than the minimum/i.test(message)) return `${FAMILIES[family].name} cannot encode frames this small: ${width}x${height}`;
  return `${FAMILIES[family].name} cannot encode ${width}x${height} at ${fps} fps: ${message}`;
}

/**
 * The MP4 encoder of an export at `configuration`, as { id, family, device, reason }, or null when
 * no MP4 encoder works (the export then uses the fallback). `found` is what the test encodes at
 * this size found: { available ids, and detectVideoFamilies' family, device, reasons, failures }.
 * `listEncoders` resolves listVideoEncoders. When kino picks the id, a hardware family that works
 * on this computer but not at this size or frame rate encodes this file in software, and `reason`
 * says why; an Hw id asked for by name is then an error with that reason. A named family that
 * does not work here at all is an error, never a silent switch to software.
 */
export async function chooseMp4Encoder(requested, configuration, setting, found, listEncoders) {
  const { available, family, device, reasons, failures } = found;
  const wantsHardware = requested == null || mp4Encoder(requested).hardware;
  let reason = "";
  if (wantsHardware && !family && setting !== "software") {
    const failed = Object.keys(failures);
    const list = failed.length || setting !== "auto" ? await listEncoders() : [];
    const works = list.find((entry) => entry.available && failed.includes(entry.id));
    if (works) reason = cannotEncodeThisFile(works.id, configuration, failureToQuote(failures[works.id], works.device).message);
    else if (setting !== "auto") throw new Error(videoEncoderUnavailableMessage(setting, reasons[setting], list));
  }
  const id = requested ?? available[0];
  if (!id) return null;
  if (!available.includes(id)) {
    const why = !mp4Encoder(id).hardware ? ""
      : setting === "software" ? " It uses the hardware video encoder, and the video encoder is set to \"software\"."
        : reason ? ` ${reason}.` : !family ? " No hardware video encoder works here." : "";
    throw new Error(`The MP4 encoder ${id} is unavailable on this computer for these export settings.${why} Try another alternative.`);
  }
  const hardware = mp4Encoder(id).hardware;
  return { id, family: hardware ? family : "software", device: hardware ? device : null, reason: hardware ? "" : reason };
}

/**
 * The MP4 encoder an export uses: `requested` (an MP4_ENCODERS id) or the first that works,
 * with the hardware `family` that "Hw" means here ("software" for an Sw id), the render node
 * it opens (`device`, or null) and, when it encodes in software although hardware was asked
 * for, the `reason` (chooseMp4Encoder).
 */
export async function resolveMp4Encoder(requested, configuration, { signal, videoEncoder = "auto" } = {}) {
  if (requested != null) mp4Encoder(requested);
  checkVideoEncoderSetting(videoEncoder);
  const checked = encoderConfiguration(configuration);
  const { encoders: available, aacCodec, family, device, reasons, failures } = await capabilities(checked, signal, false, videoEncoder);
  const chosen = await chooseMp4Encoder(requested, checked, videoEncoder, { available, family, device, reasons, failures },
    () => listVideoEncoders({ signal }));
  if (!chosen) return resolveMp4Fallback(configuration, { signal });
  return { ...mp4Encoder(chosen.id), aacCodec, family: chosen.family, device: chosen.device, reason: chosen.reason };
}

export async function resolveMp4Fallback(configuration, { signal } = {}) {
  const { encoders } = await capabilities(encoderConfiguration(configuration), signal, true);
  if (!encoders.length) throw new Error("The MP4 fallback is unavailable for these export settings. Install FFmpeg with libx264 and AAC support.");
  return { id: "mp4.alt", aacCodec: "aac", family: "software" };
}

/** The sound settings of an MP4 encoder or the "mp4.alt" fallback. The export also encodes its sound alone with them to fit the master limiter. */
export function mp4AudioArgs(id, aacCodec) {
  if (id === "mp4.alt") return [...audioArgs({ audio: "aac" }), "-profile:a", "aac_low"];
  return audioArgs(mp4Encoder(id), aacCodec);
}

// The observed final reference output uses x264 CRF 15 and AAC. Keep this
// separate from the bitrate-targeted candidates and macOS AudioToolbox AAC.
export function mp4FallbackEncodingArgs({ hasAudio }) {
  return [
    "-c:v", "libx264", "-preset", "medium", "-crf", "15", "-profile:v", "high", "-pix_fmt", "yuv420p",
    ...(hasAudio ? mp4AudioArgs("mp4.alt") : []),
    "-movflags", "+faststart", "-f", "mp4",
  ];
}

/** The FFmpeg arguments that go before the frames' `-i` for this MP4 encoder (QSV and VA-API open `mp4Device`). */
export function mp4InputArgs(id, { mp4Family, mp4Device, platform } = {}) {
  if (id === "mp4.alt") return [];
  return videoEncoderArgs(id, { width: 2, height: 2 }, { family: mp4Family, platform, device: mp4Device }).input;
}

/** The FFmpeg output arguments of an MP4 export: picture (with `mp4Family` and `videoQuality`), sound and container. */
export function mp4EncodingArgs(id, { width, height, hasAudio, mp4AacCodec, mp4Family, videoQuality = "standard", platform }) {
  return [
    ...videoEncoderArgs(id, { width, height }, { family: mp4Family, quality: videoQuality, platform }).output,
    ...(hasAudio ? mp4AudioArgs(id, mp4AacCodec) : []),
    "-movflags", "+faststart", "-f", "mp4",
  ];
}

/**
 * The `videoEncoder` fact of an MP4 export's result: { family, ffmpegEncoder, quality, bitrate }, and
 * `reason` when the file was encoded in software although hardware was asked for (`mp4SoftwareReason`).
 */
export function mp4VideoEncoderFacts({ mp4Encoder: id, mp4Family, mp4SoftwareReason, videoQuality = "standard", width, height, platform }) {
  if (id === "mp4.alt") return { family: "software", ffmpegEncoder: "libx264", quality: "crf 15", bitrate: null };
  const family = familyOf(mp4Encoder(id), mp4Family, platform);
  return { family, ffmpegEncoder: FAMILIES[family].ffmpegEncoder, quality: videoQuality, bitrate: videoBitrate({ width, height }, videoQuality),
    ...(mp4SoftwareReason ? { reason: mp4SoftwareReason } : {}) };
}
