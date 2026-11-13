import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportFrameTimes, exportProfile } from "../engine/exportOptions.js";
import { parseFps, readFps } from "../engine/frameRate.js";
import { nextMp4Encoder } from "../engine/mp4Encoders.js";
import { archiveFileNames } from "../engine/exportNames.js";
import { assertBatchStillTime, assertStillDesign, isStillFormat, stillOptionsForScene, thumbnailFrame } from "../engine/stillFrame.js";
import { exportScene, getOutputSize } from "./export.mjs";
import { checkVideoEncoderOptions, getMp4Encoders } from "./mp4-encoders.mjs";
import { archiveFiles } from "./zip.mjs";
import { createSegmentCache } from "./render-segment-cache.mjs";
import { graphicsCacheInput } from "./render-devices.mjs";
import { validateRenderFile } from "./render-validation.mjs";
import { LOUDNESS_OPTIONS, LOUDNESS_RANGE, LOUDNESS_TARGETS, loudnessOption } from "./audio-levels.mjs";
import { normalizeRenderQuality } from "./render-quality.mjs";
import { LOOK_MOTION_SAMPLES } from "../engine/previewBlur.js";
import { renderRange } from "./render-range.mjs";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const OPTION_KEYS = new Set(["format", "profile", "size", "fps", "width", "height", "quality", "gifEncoder", "mp4Encoder", "videoEncoder", "videoQuality", "loop", "playbackDirection", "transparent", "time", "design", "duration", "from", "to", "imageDPIRatio", "motionBlur", "shutterAngle", "motionSamples", "dither", "renderQuality", "sequenceArchive", "draftWidth", "draftFps", "loudness", "referenceLoudness"]);

function createExportSemaphore(limit) {
  let active = 0;
  const queue = [];

  function updatePositions() {
    queue.forEach((waiter, index) => waiter.onPosition?.(index + 1));
  }

  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      while (active < limit && queue.length) {
        const waiter = queue.shift();
        waiter.signal?.removeEventListener("abort", waiter.abort);
        if (waiter.signal?.aborted) {
          waiter.reject(waiter.signal.reason ?? Object.assign(new Error("Export was canceled."), { name: "AbortError" }));
          updatePositions();
          continue;
        }
        active += 1;
        waiter.onAdmitted?.();
        waiter.resolve(makeRelease());
        updatePositions();
      }
      updatePositions();
    };
  }

  function acquire(signal, { onPosition, onAdmitted } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error("Export was canceled."), { name: "AbortError" }));
    if (active < limit && queue.length === 0) {
      active += 1;
      onAdmitted?.();
      return Promise.resolve(makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = { signal, onPosition, onAdmitted, resolve, reject, abort: null };
      waiter.abort = () => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        signal?.removeEventListener("abort", waiter.abort);
        reject(signal?.reason ?? Object.assign(new Error("Export was canceled."), { name: "AbortError" }));
        updatePositions();
      };
      queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
      else updatePositions();
    });
  }

  return { acquire };
}

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function exportOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError("Export options must be an object.");
  for (const key of Object.keys(value)) if (!OPTION_KEYS.has(key)) throw requestError(`Unknown batch export option: ${key}`);
  const options = { format: "mp4", ...value };
  if (options.profile) options.format = exportProfile(options.profile).format;
  else exportProfile(options.format);
  if (options.format === "jpeg" && options.transparent)
    throw requestError("A JPEG cannot be transparent. Leave transparent out (see-through areas take the scene's background color, or black when it has none), or export a PNG.");
  if (options.renderQuality !== undefined && !["draft", "final"].includes(options.renderQuality))
    throw requestError("Render quality must be draft or final.");
  // 29.97, "30000/1001" and {num, den} become frames a second here (frameRate.js).
  if (options.fps !== undefined) options.fps = readFps(options.fps, requestError);
  if (options.draftFps !== undefined && (parseFps(options.draftFps) === null || parseFps(options.draftFps) > 30))
    throw requestError("Draft fps is from 1 to 30: a whole number, or 23.976 or 29.97.");
  if (options.draftFps !== undefined) options.draftFps = parseFps(options.draftFps);
  if (options.draftWidth !== undefined && (!Number.isInteger(options.draftWidth) || options.draftWidth < 16 || options.draftWidth > 7680))
    throw requestError("Draft width must be a whole number of pixels from 16 to 7680.");
  if (options.loudness !== undefined && !loudnessOption(options.loudness))
    throw requestError(`Loudness is a number of LUFS from ${LOUDNESS_RANGE[0]} to ${LOUDNESS_RANGE[1]} or one of ${LOUDNESS_OPTIONS.join(", ")} (auto: the median of the saved references' measured LUFS, else a song-led mix keeps the song's own level when over -14, otherwise web; web -14 LUFS, podcast -16, broadcast -23, off keeps the mix's own).`);
  // Read by the service from the saved references (never typed by an agent): [{id, lufs}], lufs null
  // for a reference measured before its loudness was kept.
  if (options.referenceLoudness !== undefined && (!Array.isArray(options.referenceLoudness) || options.referenceLoudness.length > 50
    || options.referenceLoudness.some((ref) => typeof ref?.id !== "string" || !(ref.lufs === null || Number.isFinite(ref.lufs)))))
    throw requestError("referenceLoudness is a list of {id, lufs}.");
  if (options.imageDPIRatio !== undefined && options.format !== "lottie")
    throw requestError("Image resolution applies only to Lottie exports.");
  if (options.imageDPIRatio !== undefined && !["1x", "2x", "3x", "original"].includes(options.imageDPIRatio))
    throw requestError("Lottie image resolution must be 1x, 2x, 3x, or original.");
  if (options.sequenceArchive !== undefined && typeof options.sequenceArchive !== "boolean")
    throw requestError("Sequence archive must be true or false.");
  const qualityKeys = ["motionBlur", "shutterAngle", "motionSamples", "dither"].filter((key) => options[key] !== undefined);
  if (qualityKeys.length) {
    try { normalizeRenderQuality(Object.fromEntries(qualityKeys.map((key) => [key, options[key]]))); }
    catch (error) { throw requestError(error.message); }
  }
  try { assertStillDesign(options.design, options.format); } catch (error) { throw requestError(error.message); }
  try { checkVideoEncoderOptions(options, options.format); } catch (error) { throw requestError(error.message); }
  return options;
}

// Your dashboard's video encoder and quality (exports.videoEncoder and exports.videoQuality) fill
// in what the options leave out, for an MP4 that is not the fallback profile mp4.alt. Being in the
// options, they are part of the render cache key. Options that name them win. The format is read
// as exportScene reads it (any case, PNG when none), so /api/export's "MP4" gets them too.
export function withVideoDefaults(options, defaults) {
  const format = options.profile ? exportProfile(options.profile).format : String(options.format ?? "png").toLowerCase();
  if (!defaults || format !== "mp4" || options.profile === "mp4.alt") return options;
  return { ...options,
    ...(options.videoEncoder === undefined && defaults.videoEncoder ? { videoEncoder: defaults.videoEncoder } : {}),
    ...(options.videoQuality === undefined && defaults.videoQuality ? { videoQuality: defaults.videoQuality } : {}) };
}

export function exportFileName(name, extension) {
  const base = String(name || "Scene").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-").replace(/^\.+/, "").trim().slice(0, 160) || "Scene";
  return `${base}.${extension}`;
}

export function uniqueExportNames(jobs) {
  return archiveFileNames(jobs);
}

function dimensions(scene, options) {
  return getOutputSize(scene, options);
}

function isFolderSequence(options) {
  return options.format === "png-sequence" && options.sequenceArchive !== true;
}

function frameRate(options) {
  return options.fps ?? (options.format === "lottie" ? 60 : 30);
}

// The scale a draft asked for with options {width, height} (a box the picture fits in) or {size}
// (a preset such as "720p"), never above the scene's own size. Null when it asked for none, so
// the draft keeps its half-size default. A size wins over width and height, as getOutputSize reads them.
function askedDraftScale(scene, options) {
  const sceneWidth = Number(scene.width);
  const sceneHeight = Number(scene.height);
  if (options.size && options.size !== "native") {
    const size = getOutputSize(scene, options);
    return Math.min(1, size.width / sceneWidth, size.height / sceneHeight);
  }
  const box = (value) => Number.isFinite(value) && value > 0 ? value : Infinity;
  if (box(options.width) === Infinity && box(options.height) === Infinity) return null;
  return Math.min(1, box(options.width) / sceneWidth, box(options.height) / sceneHeight);
}

// Exported for tests.
export function sceneOptions(options, scene) {
  const scoped = stillOptionsForScene(options, scene);
  if (options.renderQuality === undefined) { renderRange(scene, scoped); return scoped; }

  const draft = options.renderQuality === "draft";
  const defaults = draft ? { motionBlur: 0, dither: false } : { motionBlur: 0.5, dither: true };
  // The project's shutter (update_project {shutterAngle}, on the drawn scene) replaces the default
  // shutter of drafts and finals; a draft bounds its moments as look does (LOOK_MOTION_SAMPLES).
  const projectShutter = options.motionBlur === undefined && options.shutterAngle === undefined && typeof scene.shutterAngle === "number";
  const draftBound = projectShutter && draft && scene.shutterAngle > 0 && options.motionSamples === undefined;
  // An explicit shutterAngle or motionBlur replaces the default shutter; motionSamples is kept.
  const quality = normalizeRenderQuality({
    ...(projectShutter ? { shutterAngle: scene.shutterAngle } : {}),
    ...(options.motionBlur === undefined && options.shutterAngle === undefined && !projectShutter ? { motionBlur: defaults.motionBlur } : {}),
    ...(options.motionBlur !== undefined ? { motionBlur: options.motionBlur } : {}),
    ...(options.shutterAngle !== undefined ? { shutterAngle: options.shutterAngle } : {}),
    ...(options.motionSamples !== undefined ? { motionSamples: options.motionSamples } : {}),
    dither: options.dither === undefined ? defaults.dither : options.dither,
  });
  // A draft is half size, and its long side is at most draftWidth (your dashboard setting) when given.
  const longSide = Math.max(Number(scene.width), Number(scene.height));
  // A width, height or size given with the draft wins over that half-size default, up to the scene's own size.
  const scale = draft ? askedDraftScale(scene, options) ?? Math.min(0.5, options.draftWidth ? options.draftWidth / longSide : 0.5) : 1;
  const width = Math.max(1, Math.round(Number(scene.width) * scale));
  const height = Math.max(1, Math.round(Number(scene.height) * scale));
  const result = {
    ...scoped,
    width,
    height,
    // A draft a person watches plays at the asked rate (the source's, draftFps or fps) up to 30,
    // else 30: a 15fps draft judges the motion wrong.
    fps: draft ? (options.draftFps ?? Math.min(30, options.fps ?? 30)) : (options.fps ?? 30),
    ...quality,
  };
  // Every video's sound, drafts too, is brought to the web's -14 LUFS unless told otherwise, so a
  // draft that gets shared or judged plays at the level the final will.
  // "auto" picks the song's own level for a song-led mix and web otherwise (audio-levels.mjs mixLead).
  const loudness = options.loudness ?? "auto";
  if (loudness && ["mp4", "webm", "mov"].includes(options.format)) result.loudness = loudness;
  else delete result.loudness;
  if (result.loudness !== "auto" || !options.referenceLoudness?.length) delete result.referenceLoudness;
  delete result.size;
  delete result.draftWidth;
  delete result.draftFps;
  delete result.shutterAngle;
  // Without motionSamples each frame draws as many as its fastest move needs (export.mjs
  // frameMotionSamples); normalizeRenderQuality's default of 2 would turn that off.
  if (options.motionSamples === undefined) delete result.motionSamples;
  if (draftBound) result.maxMotionSamples = LOOK_MOTION_SAMPLES;
  renderRange(scene, result);
  return result;
}

// How many frames the exporter draws for a job: its duration, fps and playback direction.
function jobFrameCount(jobOptions, scene) {
  const range = renderRange(scene, jobOptions);
  if (range) return range.count;
  const fps = frameRate(jobOptions);
  const duration = Math.max(1 / fps, Number(jobOptions.duration ?? scene.duration ?? 1));
  return exportFrameTimes(duration, fps, { format: jobOptions.format, playbackDirection: jobOptions.playbackDirection }).length;
}

/**
 * How many frames an export of `scene` with these batch options will draw (1 for a still).
 * The final-render frame limit (your approval) counts these before the export starts.
 */
export function plannedFrameCount(scene, options = {}) {
  const jobOptions = sceneOptions(exportOptions(options), scene);
  return isStillFormat(jobOptions.format) ? 1 : jobFrameCount(jobOptions, scene);
}

function validationOptions(job, output) {
  const format = job.options.format;
  const fps = frameRate(job.options);
  const frameCount = jobFrameCount(job.options, job.scene);
  const size = format === "lottie"
    ? { width: Math.max(1, Math.round(Number(job.scene.width))), height: Math.max(1, Math.round(Number(job.scene.height))) }
    : job.dimensions;
  return {
    format,
    ...size,
    ...(isStillFormat(format) ? {} : { fps, frameCount, duration: frameCount / fps }),
    ...(typeof output.hasAudio === "boolean" ? { hasAudio: output.hasAudio } : {}),
    // The sound's loudness target, so the file check warns when the encoded master misses it.
    // The target the export used (a song-led mix's is the song's own, not in LOUDNESS_TARGETS).
    ...(output.hasAudio && (output.loudness?.targetLufs ?? LOUDNESS_TARGETS[job.options.loudness]) !== undefined
      ? { targetLufs: output.loudness?.targetLufs ?? LOUDNESS_TARGETS[job.options.loudness] } : {}),
  };
}

function failedChecks(validation) {
  return Object.entries(validation.checks ?? {}).filter(([, check]) => check.status === "fail");
}

function validationDiagnostic(validation) {
  const failures = failedChecks(validation);
  if (!failures.length) return "one or more required render checks failed";
  return failures.map(([name, check]) => `${name}: ${check.detail ?? `expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`}`).join("; ");
}

function validationSummary(validation) {
  const checks = Object.fromEntries(Object.entries(validation.checks ?? {}).map(([name, check]) => [name, {
    status: check.status,
    ...(check.expected !== undefined ? { expected: check.expected } : {}),
    ...(check.actual !== undefined ? { actual: check.actual } : {}),
    ...(check.detail ? { detail: check.detail } : {}),
  }]));
  const factKeys = ["sizeBytes", "width", "height", "fps", "duration", "frameCount", "hasAudio", "audioLevels", "totalPngBytes", "codec", "container"];
  const facts = Object.fromEntries(factKeys.filter((key) => validation.facts?.[key] !== undefined).map((key) => [key, validation.facts[key]]));
  const dimensions = validation.checks?.dimensions?.actual;
  if (dimensions && typeof dimensions === "object") facts.dimensions = dimensions;
  const codec = validation.checks?.codec?.actual;
  if (codec !== undefined && codec !== null) facts.codec = codec;
  const audioVideoOffset = validation.checks?.audioVideoOffset?.actual;
  if (audioVideoOffset !== undefined && audioVideoOffset !== null) facts.audioVideoOffset = audioVideoOffset;
  return {
    ok: validation.ok,
    method: validation.method,
    checks,
    facts,
    ...(validation.warnings?.length ? { warnings: [...validation.warnings] } : {}),
  };
}

function compactAudit(audit) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return undefined;
  const checks = Object.fromEntries(Object.entries(audit.checks ?? {}).map(([name, check]) => [name, {
    status: check.status,
    ...(check.expected !== undefined ? { expected: check.expected } : {}),
    ...(check.actual !== undefined ? { actual: check.actual } : {}),
    ...(check.detail ? { detail: check.detail } : {}),
  }]));
  return {
    ok: audit.ok === true,
    checks,
    facts: audit.facts && typeof audit.facts === "object" ? audit.facts : {},
    ...(Array.isArray(audit.warnings) && audit.warnings.length
      ? { warnings: audit.warnings.slice(0, 12).map((warning) => String(warning).slice(0, 240)) }
      : {}),
  };
}

async function validateOutput(job, output, frames, signal) {
  const expected = validationOptions(job, output);
  if (!job.sequence) return validateRenderFile(output.path, expected, { signal });

  const frameCount = output.sequence?.frameCount;
  const expectedCount = expected.frameCount;
  const countCheck = {
    status: frameCount === expectedCount ? "pass" : "fail",
    expected: expectedCount,
    actual: frameCount ?? null,
    ...(frameCount === expectedCount ? {} : { detail: "The rendered PNG sequence frame count does not match the requested timeline." }),
  };
  const pngExpected = { format: "png", width: expected.width, height: expected.height,
    ...(expected.hasAudio !== undefined ? { hasAudio: expected.hasAudio } : {}) };
  let first = null;
  let last = null;
  if (Number.isSafeInteger(frameCount) && frameCount > 0) {
    const firstPath = path.join(frames, "frame-000000.png");
    first = await validateRenderFile(firstPath, pngExpected, { signal });
    last = frameCount === 1 ? first : await validateRenderFile(
      path.join(frames, `frame-${String(frameCount - 1).padStart(6, "0")}.png`), pngExpected, { signal });
  }
  const frameCheck = (validation) => ({
    status: validation?.ok ? "pass" : "fail",
    ...(validation ? { actual: validationSummary(validation) } : { actual: null }),
    ...(!validation?.ok ? { detail: validation ? validationDiagnostic(validation) : "The image sequence contains no rendered frames." } : {}),
  });
  const checks = {
    frameCount: countCheck,
    firstFrame: frameCheck(first),
    lastFrame: frameCount === 1 ? { status: "pass", actual: "same as firstFrame" } : frameCheck(last),
  };
  return {
    ok: Object.values(checks).every((check) => check.status === "pass"),
    method: "PNG sequence directory frame count and endpoint PNG validation",
    checks,
    facts: { width: expected.width, height: expected.height, frameCount: frameCount ?? null },
    warnings: ["Only the first and last PNG payloads were validated; intermediate frame pixels were not decoded."],
  };
}

function cacheMetadata(output, result) {
  return {
    mime: output.mime,
    extension: output.extension,
    size: result.size,
    ...(output.mp4Encoder ? { mp4Encoder: output.mp4Encoder } : {}),
    ...(output.videoEncoder ? { videoEncoder: output.videoEncoder } : {}),
    ...(output.graphics ? { graphics: output.graphics } : {}),
    ...(output.renderedFrames !== undefined ? { renderedFrames: output.renderedFrames } : {}),
    ...(output.hasAudio !== undefined ? { hasAudio: output.hasAudio } : {}),
    ...(output.loudness ? { loudness: output.loudness } : {}),
    ...(output.warnings ? { warnings: output.warnings } : {}),
    ...(output.gzipSize ? { gzipSize: output.gzipSize } : {}),
    ...(output.outputAudit ? { outputAudit: compactAudit(output.outputAudit) } : {}),
    ...(output.motion ? { motion: output.motion } : {}),
    validation: result.validation,
  };
}

function cacheWarning(error) {
  const candidate = typeof error?.code === "string" && /^[a-z0-9_:-]{1,40}$/i.test(error.code)
    ? error.code
    : typeof error?.name === "string" && /^[a-z0-9_:-]{1,40}$/i.test(error.name) ? error.name : "cache-error";
  return { code: "render-cache-unavailable", message: `Render cache unavailable (${candidate}); export completed without relying on the cache.` };
}

// `renderSettings` (optional): a function that answers the dashboard's machine settings now,
// { graphics, framesAtOnce, keepFreePercent } (exportScene's context.render). Read when each job
// starts; the graphics setting goes into the render cache key, the other two do not.
// `exportDefaults` (optional): a function that answers the dashboard's { videoEncoder, videoQuality }
// (withVideoDefaults). `onRendered` (optional) hears each job's result once it was drawn (not
// reused from the cache): the dashboard shows the last one's graphics and video encoder.
// `cacheMaxBytes` is the render cache size (the dashboard's compute.renderCacheMegabytes); the
// returned `renderCache` ({usage, clear, limit}, or null without a cacheDirectory) reports,
// empties and resizes it while the server runs.
export function createExportBatches({ mediaRoot, lifetime = 60 * 60 * 1000, maxBatches = 16, cacheDirectory, cacheMaxBytes, maxConcurrent = 2,
  renderSettings, exportDefaults, onRendered } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError("maxConcurrent must be a positive integer.");
  const cache = cacheDirectory === undefined ? null
    : createSegmentCache({ directory: cacheDirectory, ...(cacheMaxBytes === undefined ? {} : { maxBytes: cacheMaxBytes }) });
  const semaphore = createExportSemaphore(maxConcurrent);
  const batches = new Map();
  const requests = new Map();
  let pendingCreates = 0;
  let closed = false;

  function get(id) {
    const batch = batches.get(id);
    if (!batch || batch.disposed) throw requestError("This export queue expired or was closed. Restart the export from your file.", 404);
    batch.touchedAt = Date.now();
    return batch;
  }

  function snapshot(batch) {
    const pending = batch.jobs.some((job) => !TERMINAL.has(job.status));
    return {
      id: batch.id, projectId: batch.document.id, name: batch.document.name, options: { ...batch.options },
      status: batch.paused ? "canceled" : batch.running ? "exporting" : pending ? "waiting" : "complete",
      jobs: batch.jobs.map((job) => ({
        id: job.id, sceneId: job.sceneId, name: job.name, status: job.status, format: job.options.format,
        progress: job.progress, stage: job.stage, ...job.dimensions,
        fps: job.fps,
        cached: Boolean(job.cached),
        renderedFrames: job.result?.renderedFrames ?? job.sequence?.frameCount ?? null,
        ...(job.validation ? { validation: job.validation } : {}),
        ...(job.result?.outputAudit ? { outputAudit: job.result.outputAudit } : {}),
        ...(job.queuePosition != null ? { queuePosition: job.queuePosition } : {}),
        duration: renderRange(job.scene, job.options)?.duration ?? job.options.duration ?? job.scene.duration,
        ...(renderRange(job.scene, job.options) ? { range: renderRange(job.scene, job.options) } : {}),
        // The version changes each time the thumbnail is drawn again, so the page reloads it.
        thumbnailReady: Boolean(job.thumbnailPath), thumbnailVersion: job.thumbnailVersion,
        ...(job.sequence ? { sequence: { ...job.sequence } } : {}),
        ...(job.result ? { size: job.result.size, mime: job.result.mime, extension: job.result.extension, mp4Encoder: job.result.mp4Encoder,
          ...(job.result.videoEncoder ? { videoEncoder: job.result.videoEncoder } : {}),
          ...(job.result.graphics ? { graphics: job.result.graphics } : {}) } : {}),
        ...(job.result?.warnings ? { warnings: job.result.warnings } : {}),
        ...(job.result?.gzipSize ? { gzipSize: job.result.gzipSize } : {}),
        ...(job.error ? { error: job.error } : {}),
        ...(job.alternativeOptions ? { alternativeOptions: { ...job.alternativeOptions } } : {}),
      })),
    };
  }

  async function alternative(job, signal) {
    if (job.options.profile === "mp4.alt") return null;
    if (job.options.format === "mp4") {
      const supported = await getMp4Encoders({ ...job.dimensions, fps: job.options.fps ?? 30 },
        { signal, videoEncoder: job.options.videoEncoder ?? "auto" });
      const next = nextMp4Encoder(supported, job.result?.mp4Encoder ?? job.options.mp4Encoder);
      const options = { ...job.options };
      if (next) options.mp4Encoder = next;
      // The fallback has its own encoder settings, so the video encoder and quality go too.
      else { options.profile = "mp4.alt"; delete options.mp4Encoder; delete options.videoEncoder; delete options.videoQuality; }
      return options;
    }
    if (job.options.format === "gif" && job.options.gifEncoder !== "ffmpeg") {
      const options = { ...job.options, gifEncoder: "ffmpeg" };
      delete options.quality;
      return options;
    }
    return null;
  }

  async function run(batch) {
    while (!batch.disposed && !batch.paused) {
      const job = batch.jobs.find((item) => item.status === "queued" && !item.needsFolder);
      if (!job) break;
      const controller = new AbortController();
      job.controller = controller;
      job.status = "queued";
      job.stage = "queue";
      job.queuePosition = null;
      job.progress = null;
      job.error = "";
      job.cached = false;
      job.validation = null;
      let releaseSlot = null;
      let frames = null;
      try {
        releaseSlot = await semaphore.acquire(controller.signal, {
          onPosition(position) {
            job.status = "queued";
            job.stage = "queue";
            job.queuePosition = position;
            batch.touchedAt = Date.now();
          },
          onAdmitted() {
            job.status = "inProgress";
            job.stage = "prepare";
            job.queuePosition = null;
          },
        });
        await mkdir(job.directory, { recursive: true, mode: 0o700 });
        const outputPath = path.join(job.directory, "result");
        const render = typeof renderSettings === "function" ? renderSettings() ?? {} : {};
        const cacheable = Boolean(cache && !isFolderSequence(job.options));
        const cacheWarnings = [];
        let key = null;
        if (cacheable) {
          try {
            key = await cache.key(job.scene, job.options, {
              fonts: batch.fonts,
              mediaRoot,
              scope: JSON.stringify([batch.document.id, batch.grantId]),
              graphics: graphicsCacheInput(render.graphics),
            });
          } catch (error) {
            controller.signal.throwIfAborted();
            cacheWarnings.push(cacheWarning(error));
          }
        }
        controller.signal.throwIfAborted();
        let output = null;
        if (key) {
          try { output = await cache.restore(key, outputPath, { signal: controller.signal }); }
          catch (error) {
            controller.signal.throwIfAborted();
            cacheWarnings.push(cacheWarning(error));
          }
        }
        job.cached = Boolean(output);

        if (!output) {
          if (!job.thumbnailPath) {
            // A still PNG's thumbnail shows the frame it saves; animated formats show their first frame.
            const range = renderRange(job.scene, job.options);
            const frame = range ? { time: range.from } : thumbnailFrame(job.options);
            const version = job.thumbnailVersion + 1;
            const thumbnail = path.join(job.directory, `thumbnail-${version}.png`);
            await exportScene(job.scene, { format: "png", width: 150, height: 84, ...frame }, {
              mediaRoot, fonts: batch.fonts, signal: controller.signal, outputPath: thumbnail, render,
            });
            Object.assign(job, { thumbnailPath: thumbnail, thumbnailFrameKey: JSON.stringify(frame), thumbnailVersion: version });
          }
          frames = job.sequence ? path.join(job.directory, "frames") : null;
          if (frames) await mkdir(frames, { mode: 0o700 });
          output = await exportScene(job.scene, job.options, {
            mediaRoot, fonts: batch.fonts, signal: controller.signal, render,
            outputPath,
            ...(frames ? { sequenceDirectory: frames } : {}),
            onProgress(event) {
              job.stage = event.stage;
              job.progress = event.stage === "render" && event.total > 0 ? event.completed / event.total : null;
              batch.touchedAt = Date.now();
              if (job.sequence && event.stage === "render" && Number.isInteger(event.completed)) {
                job.sequence.readyFrames = event.completed;
                job.sequence.frameCount = event.total;
                job.sequence.bytes = event.renderedBytes ?? 0;
              }
            },
          });
        }
        controller.signal.throwIfAborted();
        if (cacheWarnings.length) output = {
          ...output,
          warnings: [...(output.warnings ?? []), ...cacheWarnings],
        };

        const size = job.sequence ? output.size : (await stat(output.path)).size;
        const validation = await validateOutput(job, output, frames, controller.signal);
        job.validation = validationSummary(validation);
        if (!validation.ok) throw new Error(`Render validation failed: ${validationDiagnostic(validation)}`);

        const renderedFrames = output.renderedFrames ?? output.sequence?.frameCount;
        const outputAudit = compactAudit(output.outputAudit);
        job.result = { ...output, path: output.path, size, ...(renderedFrames !== undefined ? { renderedFrames } : {}),
          ...(outputAudit ? { outputAudit } : {}), validation: job.validation };
        if (key && !job.cached && output.path) {
          try { await cache.store(key, output.path, cacheMetadata({ ...output, ...(outputAudit ? { outputAudit } : {}) }, job.result), { signal: controller.signal }); }
          catch (error) {
            controller.signal.throwIfAborted();
            job.result.warnings = [...(job.result.warnings ?? []), cacheWarning(error)];
          }
        }
        if (job.sequence) {
          job.sequence.frameCount = output.sequence?.frameCount ?? job.sequence.frameCount;
          job.sequence.bytes = output.size ?? job.sequence.bytes;
          job.sequence.rendered = true;
          job.stage = "saving";
          // Rendering is not delivery. Keep this job active until the disk
          // writer confirms that every PNG has been closed successfully.
          batch.waitingForSave = true;
        }
      } catch (error) {
        job.status = controller.signal.aborted || error.name === "AbortError" ? "canceled" : "failed";
        job.error = job.status === "failed" ? error.message : "";
        job.progress = null;
      } finally {
        releaseSlot?.();
        job.queuePosition = null;
      }

      if (job.status === "inProgress" && job.sequence) {
        await new Promise((resolve, reject) => {
          const aborted = () => reject(controller.signal.reason);
          const finish = () => { controller.signal.removeEventListener("abort", aborted); resolve(); };
          job.delivery = { finish };
          controller.signal.addEventListener("abort", aborted, { once: true });
          if (controller.signal.aborted) aborted();
        }).then(() => controller.signal.throwIfAborted()).catch((error) => {
          job.status = controller.signal.aborted || error.name === "AbortError" ? "canceled" : "failed";
          job.error = job.status === "failed" ? error.message : "";
          job.progress = null;
        });
      }

      if (job.status === "inProgress") {
        job.status = "completed";
        job.progress = 1;
        job.stage = "complete";
        if (!job.cached && job.result) try { onRendered?.(job.result); } catch { /* only a report */ }
      }
      batch.waitingForSave = false;
      job.delivery = null;
      batch.touchedAt = Date.now();
      if (job.removed) await rm(job.directory, { recursive: true, force: true });
      if (!batch.disposed && !batch.paused && !job.removed && ["completed", "failed"].includes(job.status)) {
        try { job.alternativeOptions = await alternative(job, controller.signal); } catch { job.alternativeOptions = null; }
      }
      job.controller = null;
    }
  }

  function start(batch) {
    if (batch.running || batch.paused || batch.disposed) return;
    if (!batch.jobs.some((job) => job.status === "queued" && !job.needsFolder)) return;
    batch.running = run(batch).catch((error) => {
      for (const job of batch.jobs) if (!TERMINAL.has(job.status)) {
        job.status = "failed"; job.error = error.message; job.progress = null;
      }
    }).finally(() => {
      batch.running = null;
      if (!batch.paused && !batch.disposed && batch.jobs.some((job) => job.status === "queued" && !job.needsFolder)) start(batch);
    });
  }

  async function pause(batch) {
    batch.paused = true;
    for (const job of batch.jobs) {
      job.controller?.abort();
      if (job.status === "queued") job.status = "canceled";
    }
    await batch.running;
  }

  async function reset(job, options) {
    job.options = sceneOptions(options, job.scene);
    // New settings that show another frame (a still's time or design view, or a new format)
    // need a new thumbnail. The old one stops being offered now and is drawn again on the next run.
    if (job.thumbnailPath && job.thumbnailFrameKey !== JSON.stringify(thumbnailFrame(job.options))) {
      await rm(job.thumbnailPath, { force: true });
      job.thumbnailPath = null;
    }
    job.dimensions = dimensions(job.scene, job.options);
    job.fps = frameRate(job.options);
    job.status = "queued"; job.stage = "queued"; job.progress = null;
    job.error = ""; job.result = null; job.alternativeOptions = null;
    job.cached = false; job.validation = null; job.queuePosition = null;
    job.needsFolder = isFolderSequence(job.options);
    job.sequence = job.needsFolder ? { readyFrames: 0, frameCount: null, bytes: 0, rendered: false } : null;
    if (job.needsFolder) job.stage = "awaiting-folder";
    await rm(path.join(job.directory, "result"), { force: true });
    await rm(path.join(job.directory, "frames"), { recursive: true, force: true });
  }

  async function createNew({ document, sceneIds, options, fonts, grantId = null, requestKey = null }) {
    if (closed) throw requestError("The export service is shutting down.", 503);
    if (!Array.isArray(sceneIds) || !sceneIds.length || sceneIds.some((id) => typeof id !== "string") || new Set(sceneIds).size !== sceneIds.length)
      throw requestError("Choose one or more distinct scenes to export.");
    if (sceneIds.some((id) => !document.scenes.some((scene) => scene.id === id))) throw requestError("One of the selected scenes is no longer in the file.");
    if (batches.size + pendingCreates >= maxBatches) throw requestError("Too many export queues are open. Close an earlier queue and try again.", 429);
    const settings = withVideoDefaults(exportOptions(options), exportDefaults?.());
    if ((settings.from !== undefined || settings.to !== undefined) && sceneIds.length !== 1)
      throw requestError("Choose one scene for a render range.");
    assertBatchStillTime(settings, sceneIds.map((id) => document.scenes.find((scene) => scene.id === id)));
    pendingCreates += 1;
    let directory;
    try {
      directory = await makeTempFolder("kino-batch-");
      if (closed) throw requestError("The export service is shutting down.", 503);
      const batch = {
        id: randomUUID(), document: structuredClone(document), options: settings, fonts, grantId, directory, requestKey,
        jobs: [], paused: false, disposed: false, running: null, mutations: Promise.resolve(), touchedAt: Date.now(),
      };
      for (const sceneId of sceneIds) {
        const scene = expandComponents(batch.document, sceneId, { fonts });
        const id = randomUUID();
        const jobOptions = sceneOptions(settings, scene);
        batch.jobs.push({ id, sceneId, name: scene.name, scene, directory: path.join(directory, id),
          options: jobOptions, dimensions: dimensions(scene, jobOptions), fps: frameRate(jobOptions), status: "queued", stage: "queued", progress: null,
          error: "", result: null, thumbnailPath: null, thumbnailFrameKey: null, thumbnailVersion: 0, controller: null,
          cached: false, validation: null, queuePosition: null,
          needsFolder: isFolderSequence(jobOptions),
          sequence: isFolderSequence(jobOptions) ? { readyFrames: 0, frameCount: null, bytes: 0, rendered: false } : null });
        if (isFolderSequence(jobOptions)) batch.jobs.at(-1).stage = "awaiting-folder";
      }
      batches.set(batch.id, batch);
      start(batch);
      return batch;
    } catch (error) {
      await removeTempFolder(directory);
      throw error;
    } finally { pendingCreates -= 1; }
  }

  async function create(input) {
    if (input.requestId == null) return createNew(input);
    if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) throw requestError("Invalid export request ID.");
    const key = JSON.stringify([input.grantId ?? null, input.document.id, input.requestId]);
    const fingerprint = createHash("sha256").update(JSON.stringify([input.document, input.sceneIds, input.options ?? {}])).digest("hex");
    const existing = requests.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw requestError("This export request ID was already used with different settings.", 409);
      return existing.promise;
    }
    const promise = createNew({ ...input, requestKey: key });
    requests.set(key, { fingerprint, promise });
    promise.catch(() => requests.delete(key));
    return promise;
  }

  function action(batch, input) {
    const mutation = batch.mutations.then(async () => {
      if (batch.disposed) throw requestError("This export queue was closed.", 404);
      batch.touchedAt = Date.now();
      if (input.type === "cancel") await pause(batch);
      else if (input.type === "resume") {
        for (const job of batch.jobs) if (job.status === "canceled") await reset(job, job.options);
        batch.paused = false; start(batch);
      } else if (input.type === "start-sequences") {
        for (const job of batch.jobs) if (job.sequence) {
          if (job.status === "canceled") await reset(job, job.options);
          if (job.status === "queued") { job.needsFolder = false; job.stage = "queued"; }
        }
        batch.paused = false; start(batch);
      } else if (input.type === "restart") {
        const options = withVideoDefaults(exportOptions(input.options), exportDefaults?.());
        for (const job of batch.jobs) dimensions(job.scene, sceneOptions(options, job.scene));
        assertBatchStillTime(options, batch.jobs.map((job) => job.scene));
        await pause(batch);
        batch.options = options;
        for (const job of batch.jobs) await reset(job, options);
        batch.paused = false; start(batch);
      } else {
        const job = batch.jobs.find((item) => item.id === input.jobId);
        if (!job) throw requestError("This scene is no longer in the export queue.", 404);
        if (input.type === "sequence-saved") {
          if (!job.sequence?.rendered || !job.delivery || input.frameCount !== job.sequence.frameCount)
            throw requestError("Save every rendered image before completing this export.", 409);
          job.delivery.finish();
        } else if (input.type === "rename") {
          if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 160) throw requestError("Enter an export name between 1 and 160 characters.");
          job.name = input.name.trim();
        } else if (input.type === "remove") {
          job.removed = true;
          batch.jobs = batch.jobs.filter((item) => item !== job);
          if (job.controller) job.controller.abort();
          else await rm(job.directory, { recursive: true, force: true });
        } else if (input.type === "retry") {
          if (!TERMINAL.has(job.status)) throw requestError("Wait for this scene to finish or cancel it first.", 409);
          const options = exportOptions(input.options ?? job.alternativeOptions ?? job.options);
          assertBatchStillTime(options, batch.jobs.map((item) => item.scene));
          await reset(job, options);
          if (batch.paused) job.status = "canceled";
          else start(batch);
        } else throw requestError("Unknown export queue action.");
      }
      return snapshot(batch);
    });
    batch.mutations = mutation.catch(() => {});
    return mutation;
  }

  function file(batch, jobId, thumbnail = false) {
    const job = batch.jobs.find((item) => item.id === jobId);
    if (!job) throw requestError("This scene is no longer in the export queue.", 404);
    if (thumbnail && job.thumbnailPath) return { path: job.thumbnailPath, mime: "image/png", name: "thumbnail.png" };
    if (!thumbnail && job.status === "completed" && job.result && !job.sequence)
      return { ...job.result, name: exportFileName(job.name, job.result.extension) };
    throw requestError("This export file is not ready.", 409);
  }

  function sequenceFrame(batch, jobId, index) {
    const job = batch.jobs.find((item) => item.id === jobId);
    if (!job) throw requestError("This scene is no longer in the export queue.", 404);
    if (!Number.isSafeInteger(index) || index < 0) throw requestError("Invalid image sequence frame.");
    if (!job.sequence || index >= job.sequence.readyFrames) throw requestError("This image has not been rendered yet.", 409);
    return { path: path.join(job.directory, "frames", `frame-${String(index).padStart(6, "0")}.png`) };
  }

  async function archive(batch, output, { signal } = {}) {
    if (batch.jobs.some((job) => !TERMINAL.has(job.status))) throw requestError("Wait for the export queue to finish before downloading.", 409);
    const completed = batch.jobs.filter((job) => job.status === "completed" && job.result);
    if (!completed.some((job) => !job.sequence)) throw requestError("There are no completed files to download as a ZIP. PNG sequences are saved directly to your chosen folder.", 409);
    const names = uniqueExportNames(completed.map((job) => ({ name: job.name, extension: job.result.extension })));
    return archiveFiles(completed.flatMap((job, index) => job.sequence ? [] : [{ name: names[index], path: job.result.path }]), output, { signal });
  }

  async function remove(id) {
    const batch = batches.get(id);
    if (!batch) return;
    batch.disposed = true;
    batches.delete(id);
    if (batch.requestKey) requests.delete(batch.requestKey);
    await pause(batch);
    await batch.mutations;
    await removeTempFolder(batch.directory);
  }

  const cleanup = setInterval(() => {
    for (const batch of batches.values()) if ((!batch.running || batch.waitingForSave) && Date.now() - batch.touchedAt > lifetime) void remove(batch.id).catch(() => {});
  }, Math.min(lifetime, 60_000));
  cleanup.unref();

  const renderCache = cache && {
    usage: () => cache.usage(),
    clear: () => cache.clear(),
    limit: (bytes) => cache.limit(bytes),
  };

  return { create, get, snapshot, action, file, sequenceFrame, archive, remove, renderCache,
    async close() {
      closed = true; clearInterval(cleanup);
      await Promise.all([...batches.keys()].map(remove));
      await cache?.close();
    },
  };
}
