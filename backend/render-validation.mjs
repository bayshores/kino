import { open, readFile, stat } from "node:fs/promises";
import { runExportProcess } from "./export-process.mjs";
import { TRUE_PEAK_TARGET_DBTP, measureFileLevels } from "./audio-levels.mjs";
import { MAX_TIME } from "../engine/schema.js";
import { isStillFormat } from "../engine/stillFrame.js";

const MAX_LOTTIE_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 32 * 1024 * 1024;
const ZIP_TAIL_BYTES = 22 + 0xffff;
const ZIP_MAX_ENTRIES = 0xffff;
// Every frame of the longest scene (engine/schema.js MAX_TIME, ten minutes) at 120 fps, plus one.
const MAX_APNG_PACKET_DURATION_FRAMES = MAX_TIME * 120 + 1;
const ZIP_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const expectedCodecs = Object.freeze({
  mp4: "h264",
  webm: "vp9",
  mov: "prores",
  apng: "apng",
  gif: "gif",
  png: "png",
  jpeg: "mjpeg",
});

function check(status, expected, actual, detail) {
  return {
    status,
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
    ...(detail ? { detail } : {}),
  };
}

function unsupported(detail) {
  return check("unsupported", undefined, undefined, detail);
}

function result(method, checks, facts = {}, warnings = []) {
  return {
    ok: Object.values(checks).every((entry) => entry.status !== "fail"),
    method,
    checks,
    facts,
    warnings,
  };
}

function requireExpected(path, expected) {
  if (typeof path !== "string" || !path) throw new TypeError("A rendered file path is required.");
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new TypeError("Expected render metadata is required.");
  const format = String(expected.format ?? "").toLowerCase();
  if (![...Object.keys(expectedCodecs), "png-sequence", "lottie"].includes(format))
    throw new TypeError(`Unsupported render validation format “${format}”.`);
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  if (["png", "jpeg", "png-sequence", "lottie", "mp4", "webm", "mov", "apng", "gif"].includes(format) &&
      (!positiveInteger(expected.width) || !positiveInteger(expected.height)))
    throw new TypeError("Expected render width and height must be positive integers.");
  if (!isStillFormat(format) && (!positiveInteger(expected.frameCount) || typeof expected.fps !== "number" || !Number.isFinite(expected.fps) || expected.fps <= 0))
    throw new TypeError("Expected render frameCount and fps must be positive numbers.");
  if (["mp4", "webm", "mov", "apng", "gif", "lottie"].includes(format) &&
      (typeof expected.duration !== "number" || !Number.isFinite(expected.duration) || expected.duration <= 0))
    throw new TypeError("Expected render duration must be a positive number.");
  if (expected.hasAudio != null && typeof expected.hasAudio !== "boolean") throw new TypeError("Expected render hasAudio must be true or false.");
  if (expected.targetLufs != null && !Number.isFinite(expected.targetLufs)) throw new TypeError("Expected render targetLufs must be a number.");
  if (expected.heldAt != null && !Number.isFinite(expected.heldAt)) throw new TypeError("Expected render heldAt must be a number.");
  if (expected.expectedVideoCodec != null && (typeof expected.expectedVideoCodec !== "string" || !expected.expectedVideoCodec.trim()))
    throw new TypeError("Expected video codec must be a non-empty string.");
  return { ...expected, format };
}

function parseRate(value) {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function numeric(value) {
  if (value == null || value === "N/A" || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = numeric(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function toleranceForDuration(expected) {
  // Encoders and container time bases can round the final boundary by one frame.
  return Math.max(0.001, 1 / expected.fps + 0.001);
}

function checkAudio(streams, expected, warnings) {
  const audio = streams.some((stream) => stream.codec_type === "audio");
  const checks = {};
  if (expected.hasAudio != null) {
    checks.audio = check(audio === expected.hasAudio ? "pass" : "fail", expected.hasAudio, audio,
      audio === expected.hasAudio ? undefined : "Audio stream presence does not match the rendered scene.");
  } else checks.audio = unsupported("No expected audio presence was supplied.");

  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  if (!audio) {
    checks.audioVideoOffset = unsupported("The output has no audio stream; A/V start offset does not apply.");
    return checks;
  }
  if (!videoStream || !audioStream) {
    checks.audioVideoOffset = check("fail", "one video and one audio stream with start times", null,
      "ffprobe did not return both streams needed to measure audio offset.");
    return checks;
  }
  const videoStart = numeric(videoStream.start_time);
  const audioStart = numeric(audioStream.start_time);
  if (videoStart === null || audioStart === null) {
    checks.audioVideoOffset = unsupported("ffprobe did not report stream start times.");
    warnings.push("A/V start offset was not measured because ffprobe omitted a stream start time.");
    return checks;
  }
  const offsetMs = Math.round((audioStart - videoStart) * 1000);
  const ok = offsetMs >= -45 && offsetMs <= 125;
  checks.audioVideoOffset = check(ok ? "pass" : "fail", "-45 to +125 ms", offsetMs,
    ok ? undefined : "Audio starts outside the accepted offset window.");
  return checks;
}

// A master this far from its loudness target (LU) gets a warning; the leveling aims within 0.3 LU.
const LOUDNESS_MISS_LU = 2;

// The sound's loudness (LUFS) and true peak (dBTP): { audioPeak, audioLoudness? }. A true peak over
// -1 dBTP (the web's ceiling, which the master limiter holds) or, with a `targetLufs`, loudness
// more than 2 LU off it is a warning, not a failure, because the file is complete; the render
// reply shows the levels either way. `heldAt` is the peak that held the loudness gain, if one did.
async function checkAudioLevels(file, facts, signal, targetLufs, heldAt) {
  let levels;
  try { levels = await measureFileLevels(file, signal); }
  catch (error) {
    if (signal?.aborted) throw error;
    return { audioPeak: check("fail", "measurable sound levels", null, `The sound levels could not be measured: ${error.message}`) };
  }
  facts.audioLevels = { integratedLufs: levels.integratedLufs, loudnessRangeLu: levels.loudnessRangeLu, truePeakDbtp: levels.truePeakDbtp };
  const peak = levels.truePeakDbtp;
  const over = peak > TRUE_PEAK_TARGET_DBTP;
  const checks = { audioPeak: check(over ? "warn" : "pass", `true peak at or under ${TRUE_PEAK_TARGET_DBTP} dBTP`, peak,
    over ? `The sound's true peak is ${peak > 0 ? `+${peak} dBTP, so it clips` : `${peak} dBTP, over the web's -1 dBTP`}.` : undefined) };
  if (Number.isFinite(targetLufs) && levels.integratedLufs !== null) {
    const off = Math.round((levels.integratedLufs - targetLufs) * 10) / 10;
    const missed = Math.abs(off) > LOUDNESS_MISS_LU;
    checks.audioLoudness = check(missed ? "warn" : "pass", `${targetLufs} LUFS within ${LOUDNESS_MISS_LU} LU`, levels.integratedLufs,
      missed ? `The sound is ${levels.integratedLufs} LUFS, ${Math.abs(off)} LU ${off > 0 ? "louder" : "quieter"} than the ${targetLufs} LUFS target.` +
        (Number.isFinite(heldAt) ? ` The peak at ${heldAt} s held the gain so the mix keeps its balance: lower that sound to reach the target.` : "") : undefined);
  }
  return checks;
}

function streamFacts(stream) {
  return {
    type: stream.codec_type ?? null,
    codec: stream.codec_name ?? null,
    ...(integer(stream.width) !== null ? { width: integer(stream.width) } : {}),
    ...(integer(stream.height) !== null ? { height: integer(stream.height) } : {}),
    ...(numeric(stream.start_time) !== null ? { startTime: numeric(stream.start_time) } : {}),
    ...(numeric(stream.duration) !== null ? { duration: numeric(stream.duration) } : {}),
    ...(integer(stream.nb_read_frames) !== null ? { decodedFrames: integer(stream.nb_read_frames) } : {}),
    ...(parseRate(stream.avg_frame_rate) !== null ? { fps: parseRate(stream.avg_frame_rate) } : {}),
  };
}

function ffprobeCommand() {
  return process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";
}

async function apngPacketSpan(file, expectedFrameCount, signal) {
  if (expectedFrameCount > MAX_APNG_PACKET_DURATION_FRAMES) return null;
  const output = await runExportProcess(ffprobeCommand(), [
    "-v", "error", "-select_streams", "v:0", "-show_packets",
    "-read_intervals", `%+#${expectedFrameCount + 1}`,
    "-show_entries", "packet=pts_time,duration_time", "-of", "json", file,
  ], signal);
  let metadata;
  try { metadata = JSON.parse(output); }
  catch (error) { throw new Error("ffprobe returned malformed APNG packet timing metadata.", { cause: error }); }
  const packets = metadata?.packets;
  if (!Array.isArray(packets) || packets.length !== expectedFrameCount || !packets.length) return null;
  let firstTime = Infinity, lastEnd = -Infinity;
  for (const packet of packets) {
    const pts = numeric(packet?.pts_time);
    const duration = numeric(packet?.duration_time);
    if (pts === null || duration === null || duration <= 0) return null;
    firstTime = Math.min(firstTime, pts);
    lastEnd = Math.max(lastEnd, pts + duration);
  }
  const duration = lastEnd - firstTime;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  // Frames a second over the whole file, to 3 decimals (each delay is a whole 1/100000 s, so 30 fps reads 30.003).
  return { duration, packetCount: packets.length, fps: Math.round(packets.length / duration * 1000) / 1000 };
}

async function validateProbedFile(file, expected, { signal, size }) {
  const output = await runExportProcess(ffprobeCommand(), [
    "-v", "error", "-count_frames", "-show_error",
    "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,start_time,duration,nb_frames,nb_read_frames",
    "-of", "json", file,
  ], signal);
  let metadata;
  try { metadata = JSON.parse(output); }
  catch (error) { throw new Error("ffprobe returned malformed render metadata.", { cause: error }); }
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.some((stream) => stream.codec_type === "audio");
  const warnings = [];
  const checks = {
    nonEmpty: check(size > 0 ? "pass" : "fail", "non-empty file", size),
    probeError: check(metadata?.error ? "fail" : "pass", "no ffprobe error", metadata?.error ?? null,
      metadata?.error ? "ffprobe reported an input or decode error." : undefined),
    videoStream: check(video ? "pass" : "fail", "one video stream", video ? streamFacts(video) : null,
      video ? undefined : "ffprobe did not find a video stream."),
  };
  const facts = {
    sizeBytes: size,
    container: typeof metadata?.format?.format_name === "string" ? metadata.format.format_name : null,
    duration: numeric(metadata?.format?.duration) ?? numeric(video?.duration),
    frameCount: integer(video?.nb_read_frames),
    fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    hasAudio: audio,
    streams: streams.map(streamFacts),
  };

  // An APNG stores no frame rate, only each frame's delay. ffprobe estimates avg_frame_rate from
  // the first frames its probe reads (5,000,000 bytes by default) and needs 3 of them, so with
  // big frames (a 1080p RGBA fog frame is about 4.5 MB) it is 0/0 and r_frame_rate is the
  // 1/100000 s time base (100000 fps). The frame rate is measured from every frame's timestamp and
  // delay instead, which ffprobe reads without decoding; a bigger probe would hold 3 frames in
  // memory, up to 800 MB at 8192 x 8192.
  const packetSpan = video && expected.format === "apng" ? await apngPacketSpan(file, expected.frameCount, signal) : null;
  if (packetSpan) {
    facts.fps = packetSpan.fps;
    facts.fpsSource = "video packet timestamps and durations";
  }
  if (video && expected.format === "apng" && facts.duration === null) {
    if (packetSpan) {
      facts.duration = packetSpan.duration;
      facts.durationSource = "video packet timestamps and durations";
      facts.durationPacketCount = packetSpan.packetCount;
      warnings.push("APNG duration was derived from decoded video packet timestamps because ffprobe omitted container and stream duration.");
    } else {
      facts.durationSource = "unavailable";
      warnings.push(expected.frameCount > MAX_APNG_PACKET_DURATION_FRAMES
        ? `APNG packet timing was not read because the ${MAX_APNG_PACKET_DURATION_FRAMES}-frame validation limit was exceeded.`
        : "APNG duration could not be derived because ffprobe did not report complete positive packet timestamps and durations.");
    }
  }

  if (video) {
    const width = integer(video.width), height = integer(video.height);
    checks.dimensions = check(width === expected.width && height === expected.height ? "pass" : "fail",
      { width: expected.width, height: expected.height }, width !== null && height !== null ? { width, height } : null,
      width === expected.width && height === expected.height ? undefined : "Decoded frame dimensions do not match the requested output.");
    const expectedCodec = expected.expectedVideoCodec ?? expectedCodecs[expected.format];
    const codecOk = typeof video.codec_name === "string" && video.codec_name.toLowerCase() === expectedCodec.toLowerCase();
    checks.codec = check(codecOk ? "pass" : "fail", expectedCodec, video.codec_name ?? null,
      codecOk ? undefined : "The encoded video codec does not match the requested format.");
    const frameCount = integer(video.nb_read_frames);
    const wantFrames = isStillFormat(expected.format) ? 1 : expected.frameCount;
    if (expected.format === "gif") {
      const valid = frameCount !== null && frameCount >= 1 && frameCount <= wantFrames;
      checks.frameCount = check(valid ? "pass" : "fail", `1 to ${wantFrames} (GIF encoders may coalesce repeated frames)`, frameCount,
        valid ? undefined : "The decoded GIF frame count is outside the allowed range.");
      if (valid && frameCount < wantFrames) warnings.push(`GIF contains ${frameCount} decoded frame(s) for ${wantFrames} requested frames; equal frames may have been coalesced.`);
    } else {
      const countOk = frameCount === wantFrames;
      checks.frameCount = check(countOk ? "pass" : "fail", wantFrames, frameCount,
        countOk ? undefined : "The decoded frame count does not match the requested output.");
    }
    if (expected.format === "gif") {
      checks.frameRate = unsupported("GIF uses variable, centisecond-quantized frame delays; a single FPS value cannot be verified from the file.");
      warnings.push("GIF frame rate is variable and was not checked as a single FPS value.");
    } else {
      const fps = facts.fps;
      const fpsTolerance = Math.max(0.01, expected.fps * 0.005);
      const fpsOk = fps !== null && Math.abs(fps - expected.fps) <= fpsTolerance;
      checks.frameRate = check(fpsOk ? "pass" : "fail", { fps: expected.fps, tolerance: fpsTolerance }, fps,
        fpsOk ? undefined : "The decoded frame rate does not match the requested output.");
    }
    if (expected.duration != null) {
      const duration = facts.duration;
      const tolerance = toleranceForDuration(expected);
      const durationOk = duration !== null && Math.abs(duration - expected.duration) <= tolerance;
      checks.duration = check(durationOk ? "pass" : "fail", { seconds: expected.duration, tolerance }, duration,
        durationOk ? undefined : "The output duration is missing or differs by more than one frame.");
    } else checks.duration = unsupported("No expected duration was supplied.");
  } else {
    checks.dimensions = check("fail", { width: expected.width, height: expected.height }, null, "No decoded video stream is available.");
    checks.codec = check("fail", expected.expectedVideoCodec ?? expectedCodecs[expected.format], null, "No decoded video stream is available.");
    checks.frameCount = check("fail", isStillFormat(expected.format) ? 1 : expected.frameCount, null, "No decoded video stream is available.");
    checks.frameRate = isStillFormat(expected.format) ? unsupported("A still image has no frame rate.") : check("fail", expected.fps, null, "No decoded video stream is available.");
    checks.duration = expected.duration == null ? unsupported("No expected duration was supplied.") : check("fail", expected.duration, null, "No decoded video stream is available.");
  }
  Object.assign(checks, checkAudio(streams, expected, warnings));
  if (audio) Object.assign(checks, await checkAudioLevels(file, facts, signal, expected.targetLufs, expected.heldAt));
  if (isStillFormat(expected.format)) {
    checks.frameRate = unsupported("A still image has no frame rate.");
    checks.duration = expected.duration == null ? unsupported("A still image does not encode a timeline duration.") : unsupported("A still image does not encode a timeline duration.");
    if (expected.frameCount != null && expected.frameCount !== 1)
      checks.frameCount = check("fail", 1, expected.frameCount, "A still image contains exactly one frame.");
  }
  return result("ffprobe -count_frames", checks, facts, warnings);
}


async function validateLottie(file, expected, { signal, size }) {
  if (size > MAX_LOTTIE_BYTES) throw new RangeError(`Lottie JSON is larger than the ${MAX_LOTTIE_BYTES}-byte validation limit.`);
  const buffer = await readFile(file, { signal });
  let animation;
  try { animation = JSON.parse(buffer.toString("utf8")); }
  catch (error) { throw new Error("Lottie render is not valid JSON.", { cause: error }); }
  const width = integer(animation?.w), height = integer(animation?.h);
  const fps = numeric(animation?.fr), inPoint = numeric(animation?.ip), outPoint = numeric(animation?.op);
  const frameCount = fps !== null && inPoint !== null && outPoint !== null ? outPoint - inPoint : null;
  const duration = frameCount !== null && fps > 0 ? frameCount / fps : null;
  const warnings = [];
  const checks = {
    nonEmpty: check(size > 0 ? "pass" : "fail", "non-empty file", size),
    structure: check(animation && typeof animation === "object" && !Array.isArray(animation) &&
      Array.isArray(animation.layers) && width !== null && width > 0 && height !== null && height > 0 && fps !== null && fps > 0 &&
      inPoint !== null && outPoint !== null && outPoint > inPoint ? "pass" : "fail",
    "JSON object with layers, positive w/h/fr, and op > ip", { width, height, fps, ip: inPoint, op: outPoint },
    Array.isArray(animation?.layers) && width > 0 && height > 0 && fps > 0 && outPoint > inPoint ? undefined : "Lottie layers, timing, or canvas fields are missing or invalid."),
    dimensions: check(width === expected.width && height === expected.height ? "pass" : "fail",
      { width: expected.width, height: expected.height }, width !== null && height !== null ? { width, height } : null),
    frameRate: check(fps === expected.fps ? "pass" : "fail", expected.fps, fps,
      fps === expected.fps ? undefined : "Lottie frame rate does not match the requested output."),
    frameCount: check(frameCount === expected.frameCount ? "pass" : "fail", expected.frameCount, frameCount,
      frameCount === expected.frameCount ? undefined : "Lottie ip/op span does not match the requested frame count."),
    duration: (() => {
      const tolerance = toleranceForDuration(expected);
      const ok = duration !== null && Math.abs(duration - expected.duration) <= tolerance;
      return check(ok ? "pass" : "fail", { seconds: expected.duration, tolerance }, duration,
        ok ? undefined : "Lottie ip/op duration differs by more than one frame.");
    })(),
    codec: unsupported("Lottie is a JSON animation document, not a video codec."),
    audioVideoOffset: unsupported("Lottie does not encode an audio stream."),
  };
  if (expected.hasAudio === true) {
    checks.audio = check("fail", false, false, "Lottie output does not include audio.");
    warnings.push("Lottie cannot carry the expected audio track.");
  } else if (expected.hasAudio === false) checks.audio = check("pass", false, false);
  else checks.audio = unsupported("No expected audio presence was supplied.");
  return result("Lottie JSON structure", checks, { sizeBytes: size, width, height, fps, ip: inPoint, op: outPoint, frameCount, duration }, warnings);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc(crc, bytes) {
  let value = crc;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

async function readExact(handle, length, position, signal) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) throw new Error("PNG sequence ZIP has an invalid record length.");
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    signal?.throwIfAborted();
    const part = await handle.read(buffer, read, length - read, position + read);
    if (!part.bytesRead) throw new Error("PNG sequence ZIP is truncated.");
    read += part.bytesRead;
  }
  return buffer;
}

async function crcAndPngHeader(handle, offset, length, signal) {
  if (length < 33) throw new Error("PNG sequence contains an empty or truncated PNG frame.");
  let position = offset, remaining = length, crc = 0xffff_ffff;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const prefix = Buffer.alloc(33);
  let prefixBytes = 0;
  while (remaining > 0) {
    signal?.throwIfAborted();
    const amount = Math.min(remaining, buffer.length);
    const { bytesRead } = await handle.read(buffer, 0, amount, position);
    if (!bytesRead) throw new Error("PNG sequence contains a truncated PNG frame.");
    const chunk = buffer.subarray(0, bytesRead);
    crc = updateCrc(crc, chunk);
    const take = Math.min(33 - prefixBytes, bytesRead);
    if (take > 0) { chunk.copy(prefix, prefixBytes, 0, take); prefixBytes += take; }
    position += bytesRead;
    remaining -= bytesRead;
  }
  if (!prefix.subarray(0, 8).equals(PNG_SIGNATURE) || prefix.readUInt32BE(8) !== 13 || prefix.toString("ascii", 12, 16) !== "IHDR")
    throw new Error("PNG sequence entry does not have a valid PNG signature and IHDR header.");
  return { crc: (crc ^ 0xffff_ffff) >>> 0, width: prefix.readUInt32BE(16), height: prefix.readUInt32BE(20) };
}

async function validatePngSequence(file, expected, { signal, size }) {
  const handle = await open(file, "r");
  try {
    signal?.throwIfAborted();
    if (size < 22) throw new Error("PNG sequence ZIP is empty or truncated.");
    if (expected.frameCount > ZIP_MAX_ENTRIES) throw new RangeError("PNG sequence has too many entries for the bounded classic-ZIP validator.");
    const tailLength = Math.min(size, ZIP_TAIL_BYTES);
    const tail = await readExact(handle, tailLength, size - tailLength, signal);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== ZIP_SIGNATURE) continue;
      const commentLength = tail.readUInt16LE(index + 20);
      if (index + 22 + commentLength === tail.length) { endOffset = index; break; }
    }
    if (endOffset < 0) throw new Error("PNG sequence ZIP has no valid end-of-directory record.");
    const end = tail.subarray(endOffset);
    const disk = end.readUInt16LE(4), directoryDisk = end.readUInt16LE(6);
    const diskCount = end.readUInt16LE(8), entryCount = end.readUInt16LE(10);
    const directorySize = end.readUInt32LE(12), directoryOffset = end.readUInt32LE(16);
    const endPosition = size - tailLength + endOffset;
    if (disk !== 0 || directoryDisk !== 0 || diskCount !== entryCount ||
      directorySize === 0xffff_ffff || directoryOffset === 0xffff_ffff || directorySize > MAX_ZIP_DIRECTORY_BYTES)
      throw new Error("PNG sequence ZIP uses a multi-disk, ZIP64, or oversized directory format that is not supported.");
    if (entryCount !== expected.frameCount) throw new Error(`PNG sequence ZIP has ${entryCount} entries; ${expected.frameCount} were expected.`);
    const zip64Locator = endPosition >= 20 ? await readExact(handle, 4, endPosition - 20, signal) : null;
    if (zip64Locator?.readUInt32LE(0) === 0x07064b50)
      throw new Error("PNG sequence ZIP uses ZIP64, which is not supported by the bounded validator.");
    if (directoryOffset + directorySize !== endPosition || directoryOffset + directorySize > size)
      throw new Error("PNG sequence ZIP central-directory bounds are invalid.");

    const checks = {
      nonEmpty: check(size > 0 ? "pass" : "fail", "non-empty file", size),
      frameCount: check("pass", expected.frameCount, entryCount),
      filenames: check("pass", `frame-000000.png through frame-${String(expected.frameCount - 1).padStart(6, "0")}.png`, "sequential frame names"),
      pngPayloads: check("pass", "stored PNG frames with matching CRC and dimensions", expected.frameCount),
      frameRate: unsupported("A ZIP of PNGs does not store frame-rate metadata."),
      duration: unsupported("A ZIP of PNGs does not store duration metadata."),
      codec: unsupported("A ZIP of PNGs is a container, not a single video codec."),
      audioVideoOffset: unsupported("A ZIP of PNGs does not contain an audio stream."),
    };
    const expectedAudio = expected.hasAudio;
    if (expectedAudio === true) checks.audio = check("fail", false, false, "PNG sequence output does not include audio.");
    else if (expectedAudio === false) checks.audio = check("pass", false, false);
    else checks.audio = unsupported("No expected audio presence was supplied.");

    let cursor = directoryOffset;
    let totalBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      signal?.throwIfAborted();
      const central = await readExact(handle, 46, cursor, signal);
      if (central.readUInt32LE(0) !== ZIP_CENTRAL_SIGNATURE) throw new Error("PNG sequence ZIP central directory is malformed.");
      const flags = central.readUInt16LE(8), method = central.readUInt16LE(10);
      const crcExpected = central.readUInt32LE(16);
      const compressedSize = central.readUInt32LE(20), uncompressedSize = central.readUInt32LE(24);
      const nameLength = central.readUInt16LE(28), extraLength = central.readUInt16LE(30), commentLength = central.readUInt16LE(32);
      const entryDisk = central.readUInt16LE(34), localOffset = central.readUInt32LE(42);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (recordLength > directorySize || cursor + recordLength > directoryOffset + directorySize) throw new Error("PNG sequence ZIP central entry exceeds directory bounds.");
      if (flags & 1 || entryDisk !== 0 || method !== 0 || compressedSize !== uncompressedSize ||
          compressedSize === 0xffff_ffff || localOffset === 0xffff_ffff)
        throw new Error("PNG sequence ZIP contains encrypted, compressed, multi-disk, or ZIP64 entries that cannot be verified safely.");
      const nameBytes = await readExact(handle, nameLength, cursor + 46, signal);
      let name;
      try { name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); }
      catch (error) { throw new Error("PNG sequence ZIP contains an invalid UTF-8 filename.", { cause: error }); }
      const expectedName = `frame-${String(index).padStart(6, "0")}.png`;
      if (name !== expectedName) throw new Error(`PNG sequence ZIP entry ${index} is “${name}”; expected “${expectedName}”.`);
      const local = await readExact(handle, 30, localOffset, signal);
      if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) throw new Error(`PNG sequence ZIP frame ${name} has no local-file header.`);
      const localFlags = local.readUInt16LE(6), localMethod = local.readUInt16LE(8);
      const localCrc = local.readUInt32LE(14), localCompressed = local.readUInt32LE(18), localSize = local.readUInt32LE(22);
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
      if (localFlags !== flags || localMethod !== method || localCrc !== crcExpected || localCompressed !== compressedSize || localSize !== uncompressedSize || localNameLength !== nameLength)
        throw new Error(`PNG sequence ZIP local metadata disagrees for frame ${name}.`);
      const localNameBytes = await readExact(handle, localNameLength, localOffset + 30, signal);
      if (!localNameBytes.equals(nameBytes)) throw new Error(`PNG sequence ZIP local filename disagrees for frame ${name}.`);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + compressedSize;
      if (!Number.isSafeInteger(dataEnd) || dataEnd > directoryOffset) throw new Error(`PNG sequence ZIP data bounds are invalid for frame ${name}.`);
      const payload = await crcAndPngHeader(handle, dataOffset, compressedSize, signal);
      if (payload.crc !== crcExpected) throw new Error(`PNG sequence ZIP CRC does not match for frame ${name}.`);
      if (payload.width !== expected.width || payload.height !== expected.height)
        throw new Error(`PNG frame ${name} is ${payload.width}×${payload.height}; expected ${expected.width}×${expected.height}.`);
      totalBytes += uncompressedSize;
      cursor += recordLength;
    }
    if (cursor !== directoryOffset + directorySize) throw new Error("PNG sequence ZIP central-directory size does not match its entries.");
    checks.filenames = check("pass", checks.filenames.expected, entryCount);
    checks.pngPayloads = check("pass", "CRC-valid PNG frames with expected dimensions", { count: entryCount, bytes: totalBytes });
    const warnings = ["PNG-sequence frame names, dimensions, and ZIP CRCs were checked; frame pixels were not decoded.",
      "PNG-sequence FPS and duration cannot be read from this ZIP and are reported as unsupported."];
    return result("classic ZIP central-directory and streamed PNG header/CRC checks", checks,
      { sizeBytes: size, frameCount: entryCount, width: expected.width, height: expected.height, totalPngBytes: totalBytes }, warnings);
  } finally {
    await handle.close();
  }
}

/** Validate a completed render without retaining video frames or extracting PNG ZIPs to disk. */
export async function validateRenderFile(file, expectedInput, { signal } = {}) {
  const expected = requireExpected(file, expectedInput);
  signal?.throwIfAborted();
  const info = await stat(file);
  const size = info.size;
  if (size === 0) {
    const checks = { nonEmpty: check("fail", "non-empty file", 0, "The rendered file is empty.") };
    return result(expected.format === "lottie" ? "Lottie JSON structure" : expected.format === "png-sequence" ? "classic ZIP central-directory and streamed PNG checks" : "ffprobe", checks, { sizeBytes: 0 });
  }
  if (expected.format === "lottie") return validateLottie(file, expected, { signal, size });
  if (expected.format === "png-sequence") return validatePngSequence(file, expected, { signal, size });
  return validateProbedFile(file, expected, { signal, size });
}
