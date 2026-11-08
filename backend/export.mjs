import { pivotOf } from "../engine/geometry.js";
import { resizeTextLayer } from "../engine/textLayout.js";
import { missingDocumentFonts } from "../engine/fontRecovery.js";
import { documentGlyphProblems } from "../engine/fontGlyphReferences.js";
import { loadBundledFonts } from "./fonts.mjs";
import { lottieTextLayers } from "./lottie-text.mjs";
import {
  MEDIA_SAMPLE_TOLERANCE,
  gifFrameIndex,
  hasMediaPlay,
  mediaDesignTime,
  mediaFrameState,
  mediaPlaybackRange,
  resolvePlayback,
  videoFrameIndex,
} from "../engine/playback.js";
import { runExportProcess as runProcess, runExportStream } from "./export-process.mjs";
import { defaultRenderPool, MAX_SVG_BYTES } from "./render-pool.mjs";
import { renderFrameCache } from "./render-frame-cache.mjs";
import { normalizeRenderQuality, motionSampleTimes, createSampleBlend, MAX_MOTION_SAMPLES } from "./render-quality.mjs";
import { shutterSampleCount } from "../engine/previewBlur.js";
import { frameReference, inspectRenderedOutput } from "./render-output-audit.mjs";
import { fitLoudness, loudMixWarning, masterLimiter, measureMixLevels } from "./audio-levels.mjs";
import { encodeRenderPng } from "./render-png.mjs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { gzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { inspectLottieImage, resizeLottieImage } from "./lottie-images.mjs";
import { decodeLottieMediaFrame } from "./lottie-media-frames.mjs";
import { ffmpegCommand, gifFrameFileName, probeMedia, videoGridArgs, videoGridCount, writeGifFrames } from "./media-probe.mjs";
import { remappedPictures, remappedSource } from "./media-remap.mjs";
import { remappedSoundClip } from "./sound-remap.mjs";
import { MAX_VOLUME, isRemapped, mediaInterpolationOf } from "../engine/mediaTime.js";
import { gifDecodeSlots } from "./gif-decode-slots.mjs";
import { parseGif, parseGifStart } from "../engine/gifDecode.js";
import { evaluateLayer } from "../engine/animation.js";
import { kinoTimeline } from "../engine/quality/kinoTimeline.js";
import { plannedTimes } from "../engine/quality/motionPixels.js";
import { isAnimationCompatible } from "../engine/animationCompatibility.js";
import { enabledAnimations } from "../engine/animationEnabled.js";
import { effectDefinition } from "../engine/effects/catalog.js";
import { lottieShapeParts, roundedBoxMask } from "./lottie-shapes.mjs";
import { hasSoftReveal, lottieRevealMask, revealSampleTimes } from "./lottie-reveal.mjs";
import { isGeneralReveal } from "../engine/reveal.js";
import { lottieFramePosition } from "./lottie-frame-time.mjs";
import { isFillEnabled } from "../engine/paints.js";
import { vectorLayer } from "./lottie-vector.mjs";
import { compositionBounds } from "./lottie-bounds.mjs";
import { effectPadding, lottieEffects, transparentEffectBounds } from "./lottie-effects.mjs";
import { holdKeyframesAt, loopRestartFrames, stepFrames, visibilitySwitchFrames } from "./lottie-visibility.mjs";
import { discreteOpacityProperty } from "./lottie-opacity.mjs";
import { audibleRanges } from "../engine/videoSound.js";
import { animatesVolume } from "../engine/animation.js";
import { trackVolumeAt, volumeTrackInput, writeVolumeTrack } from "./volume-track.mjs";
import { cleansVoice, voiceChainFilters } from "./voice-chain.mjs";
import { lowpassFilters, lowpassPlan, writeLowpassPlan } from "./lowpass-track.mjs";
import { createLoudnessCurves, readMomentary, savedWordsOf } from "./loudness-curve.mjs";
import { leveledVoice, loudnessOver, voiceLeveling } from "../engine/mixLevels.js";
import { maskStyle, maskSwitchedOff } from "../engine/maskVisibility.js";
import { captureLayerSvg, escapeXml, EXPORT_FRAME_URL, normalizeMediaHref, renderSceneSvg } from "../engine/render.js";
import { backgroundLayer, isBackgroundEnabled, withoutBackground } from "../engine/sceneBackground.js";
import { ffmpegRate, readFps } from "../engine/frameRate.js";
import { exportFrameCount, exportFrameTime, exportFrameTimes, exportProfile, resolveExportDimensions, validateExportDimensions } from "../engine/exportOptions.js";
import { nativePngSize } from "../engine/nativePngSize.js";
import { MAX_TIME } from "../engine/schema.js";
import { assertStillDesign, assertStillFrameTime } from "../engine/stillFrame.js";
import { MORPH_SAME_SHOT, interpolateFrame, morphDissolveScene, morphFlows, morphJoins, shotDifference } from "../engine/morphCut.js";
import { speechPieces } from "../engine/speech.js";
import { archivePngSequence } from "./png-sequence.mjs";
import { rasterizeSvgAsset } from "./svg-asset.mjs";
import { parseMediaSource } from "./media-source.mjs";
import { createGifFrameCache } from "./gif-frame-cache.mjs";
import { checkVideoEncoderOptions, mp4AudioArgs, mp4EncodingArgs, mp4FallbackEncodingArgs, mp4InputArgs, mp4VideoEncoderFacts, resolveMp4Encoder, resolveMp4Fallback } from "./mp4-encoders.mjs";
import { planLottieEffects } from "./lottie-effect-plan.mjs";
import { lottieParticleProblem } from "./lottie-particles.mjs";
import { collectRasterSequences, DEFAULT_RASTER_SEQUENCE_LIMITS } from "./lottie-raster-sequences.mjs";
import { claimRasterWorkers, createChromiumRasterizer } from "./chromium-raster.mjs";
import { chooseRasterWorkers } from "./raster-workers.mjs";
import { graphicsReport, listGraphics, renderSettings } from "./render-devices.mjs";
import { isBackground, renderStarted } from "./render-activity.mjs";
import { videoWindows } from "./video-windows.mjs";
import { sceneNeedsChromium } from "./raster-policy.mjs";
import { layersLutSources, loadedLut, missingLut } from "../engine/effects/lutFiles.js";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";
import { checkPictures } from "./check-pictures.mjs";
import { untaggedImage } from "./image-color.mjs";

// What a PNG sequence ZIP can hold (classic ZIP, zip.mjs): 65,535 entries and 4 GiB.
const PNG_ZIP_MAX_FRAMES = 0xffff;
const PNG_ZIP_MAX_BYTES = 0xffff_ffff;
// "75s" or "2.5s" for messages.
const secondsText = (seconds) => `${Number(seconds.toFixed(2))}s`;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
};
const FORMAT_INFO = {
  png: { extension: "png", mime: "image/png" },
  mp4: { extension: "mp4", mime: "video/mp4" },
  webm: { extension: "webm", mime: "video/webm" },
  mov: { extension: "mov", mime: "video/quicktime" },
  gif: { extension: "gif", mime: "image/gif" },
  apng: { extension: "apng", mime: "image/apng" },
  "png-sequence": { extension: "zip", mime: "application/zip" },
  lottie: { extension: "json", mime: "application/json" },
};
const missingLocalMedia = new WeakMap();

function markMissingLocalMedia(error, mediaId) {
  if (error?.code === "ENOENT" && error && typeof error === "object")
    missingLocalMedia.set(error, mediaId);
  return error;
}

function missingMediaId(error) {
  return error && typeof error === "object" ? missingLocalMedia.get(error) : undefined;
}

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, finite(value, min)));
const aborted = (signal) => {
  if (!signal?.aborted) return;
  const error = new Error("Export was cancelled.");
  error.name = "AbortError";
  throw error;
};

function mapGet(map, layer) {
  if (!map) return undefined;
  return map instanceof Map
    ? (map.get(layer.id) ?? map.get(layer.src))
    : (map[layer.id] ?? map[layer.src]);
}

function checkScene(scene) {
  if (!scene || !Array.isArray(scene.layers))
    throw new TypeError("A scene with a layers array is required.");
  if (!(finite(scene.width) > 0) || !(finite(scene.height) > 0))
    throw new Error("Scene width and height must be positive.");
}

async function validateSequenceDirectory(directory) {
  const details = await lstat(directory);
  if (!details.isDirectory()) {
    throw new TypeError("PNG sequence directory must be an existing empty directory.");
  }
  if ((await readdir(directory)).length > 0) {
    throw new Error("PNG sequence directory must be empty before export.");
  }
}

async function writeRetainedFrame(path, buffer) {
  let handle;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(buffer);
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

async function readMediaSource(source, mediaRoot, label) {
  if (source && typeof source === "object") {
    if (source.buffer instanceof Uint8Array) {
      const mime = source.mimeType ?? source.type ?? "image/png";
      return { buffer: Buffer.from(source.buffer), mime };
    }
    source = source.href ?? source.src ?? source.url;
  }
  if (source instanceof Uint8Array)
    return { buffer: Buffer.from(source), mime: "image/png" };
  if (typeof source !== "string")
    throw new Error(`${label} is missing media input.`);
  if (
    /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[a-z0-9+/=]+$/i.test(
      source,
    )
  ) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(
      source,
    );
    return {
      buffer: Buffer.from(match[2], "base64"),
      mime: match[1].toLowerCase(),
    };
  }
  normalizeMediaHref(source, {}, undefined, label);
  if (!source.startsWith("/api/media/"))
    throw new Error(
      `${label} must be a local /api/media/... file or an embedded raster image.`,
    );
  if (!mediaRoot)
    throw new Error(
      `${label} references ${source}, but no mediaRoot was supplied for export.`,
    );
  const uploaded = parseMediaSource(source);
  const mediaId = uploaded?.id ?? source.slice("/api/media/".length);
  const rootPath = await realpath(mediaRoot);
  const candidate = resolve(rootPath, mediaId);
  if (
    !candidate.startsWith(`${rootPath}${sep}`) ||
    basename(candidate) !== mediaId
  ) {
    throw new Error(`${label} has an invalid local media path.`);
  }
  let filePath;
  try {
    filePath = await realpath(candidate);
  } catch (error) {
    throw markMissingLocalMedia(error, mediaId);
  }
  if (!filePath.startsWith(`${rootPath}${sep}`))
    throw new Error(`${label} resolves outside the media directory.`);
  if (uploaded?.frame != null) {
    const cache = createGifFrameCache(join(rootPath, "..", "media-frames"));
    const frame = await cache.openFrame(uploaded.id, filePath, uploaded.frame);
    if (!frame) throw new Error(`${label} references a GIF frame that does not exist.`);
    try { return { buffer: await frame.readFile(), mime: "image/png" }; }
    finally { await frame.close(); }
  }
  const mime =
    MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  try {
    return { buffer: await readFile(filePath), mime };
  } catch (error) {
    throw markMissingLocalMedia(error, mediaId);
  }
}

async function resolveLocalMediaPath(source, mediaRoot, label) {
  if (typeof source !== "string")
    throw new Error(`${label} has no src (no media file). Import the file with project import and set src to the /api/media/... address it answers, or delete the layer.`);
  normalizeMediaHref(source, {}, undefined, label);
  if (!source.startsWith("/api/media/"))
    throw new Error(
      `${label} needs a local /api/media/... source. External files are not fetched.`,
    );
  if (!mediaRoot)
    throw new Error(
      `${label} references ${source}, but no mediaRoot was supplied for export.`,
    );
  // A shared address (?share=...) names the same uploaded file as the plain one.
  const uploaded = parseMediaSource(source);
  if (uploaded?.frame != null)
    throw new Error(`${label} references a GIF frame instead of a video or audio file.`);
  const mediaId = uploaded?.id ?? source.slice("/api/media/".length);
  const rootPath = await realpath(mediaRoot);
  const candidate = resolve(rootPath, mediaId);
  if (
    !candidate.startsWith(`${rootPath}${sep}`) ||
    basename(candidate) !== mediaId
  )
    throw new Error(`${label} has an invalid local media path.`);
  let filePath;
  try {
    filePath = await realpath(candidate);
  } catch (error) {
    throw markMissingLocalMedia(error, mediaId);
  }
  if (!filePath.startsWith(`${rootPath}${sep}`))
    throw new Error(`${label} resolves outside the media directory.`);
  return filePath;
}

function toDataUrl({ buffer, mime }) {
  if (!/^image\/(?:png|jpeg|jpg|webp|gif|avif)$/i.test(mime)) {
    throw new Error(
      `Only raster images can be embedded in these exports (received ${mime}).`,
    );
  }
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

let transparentMediaSampleCache;
function transparentMediaSample() {
  if (!transparentMediaSampleCache) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    transparentMediaSampleCache = {
      buffer: new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng(),
      mime: "image/png",
    };
  }
  return transparentMediaSampleCache;
}

function reportMissingMedia(layer, error, warnings) {
  const source = missingMediaId(error);
  if (!source) return false;
  const layerName = String(layer.name ?? layer.id ?? "Layer");
  const kind = layer.type === "video" ? "Video" : "Image";
  warnings.push({
    code: "missing-media",
    layerId: layer.id,
    layerName,
    source,
    message: `${kind} layer “${layerName}” references missing local media “${source}”; its media is transparent in this export.`,
  });
  return true;
}

// Runs a media decoding step; when the export was cancelled meanwhile, reports the cancellation instead.
async function mediaStep(signal, step) {
  try {
    return await step();
  } catch (error) {
    aborted(signal);
    throw error;
  }
}

/**
 * The moments a media layer's picture comes from, one for each rendered time that draws the layer.
 * An entry of `sceneTimes` is a scene time, or {time, frameTime} when motion blur draws output
 * frame `frameTime` at a nearby `time` (shutterSamples): the layer is drawn or hidden by `time`,
 * but its footage shows the picture of `frameTime`, as render.js mediaClock does. A video that
 * blends or flows between its file frames (mediaInterpolation) shows the blend of `frameTime` too.
 * Returns [{at (the scene time the picture is taken at), clock (resolvePlayback), state (mediaFrameState)}].
 */
function mediaMoments(layer, sceneTimes) {
  const moments = [];
  for (const entry of sceneTimes) {
    const time = typeof entry === "number" ? entry : entry.time;
    const drawn = resolvePlayback(layer, time);
    if (!drawn.visible || !mediaFrameState(layer, drawn.time).visible) continue;
    const at = typeof entry === "number" ? time : entry.frameTime;
    const clock = at === time ? drawn : resolvePlayback(layer, at);
    moments.push({ at, clock, state: mediaFrameState(layer, clock.time) });
  }
  return moments;
}

/**
 * The GIF frame numbers that the given scene times (see mediaMoments) show, skipping times when
 * the layer is hidden. The design view (`design`) shows only the frame where Play starts, as the
 * Design canvas does.
 */
function gifFramesShown(layer, durations, sceneTimes, design = false) {
  if (design) return new Set([gifFrameIndex(durations, mediaDesignTime(layer))]);
  const shown = new Set();
  for (const { state } of mediaMoments(layer, sceneTimes)) shown.add(gifFrameIndex(durations, state.sourceTime));
  return shown;
}

/** GIF problems found before decoding (too large, or not decodable by browsers), from src/gifDecode.js. */
function isGifError(error) {
  return error?.code === "GIF_TOO_LARGE" || error?.code === "GIF_UNREADABLE";
}

/**
 * Decodes the GIF frames an export shows into PNG files, with the editor's decoder and browser rules.
 * `gif` comes from parseGif, and every layer in `layers` uses that one GIF file, so it is decoded
 * once for all of them. Only frames that some export frame of some layer shows are encoded, so a
 * PNG still encodes at most one per layer. Without Play every export frame shows the first frame.
 * Decoding waits for a free GIF decode slot, which the whole server process shares
 * (gif-decode-slots.mjs); `slots` can be replaced by tests.
 * Returns { durations, frames } for the renderer, shared by the layers (frames none of them shows
 * stay empty), or null when no export frame shows any of the layers.
 * A frame file is read from disk the first time an export frame shows it, and only once.
 * Exported for tests.
 */
export async function gifPlayFrames(layers, gif, { folder, sceneTimes, design = false, signal, slots = gifDecodeSlots }) {
  const shown = new Set();
  for (const layer of layers)
    for (const index of gifFramesShown(layer, gif.durations, sceneTimes, design)) shown.add(index);
  if (!shown.size) return null;
  await mkdir(folder, { mode: 0o700 });
  await mediaStep(signal, () => slots.run(() => writeGifFrames(gif, folder, { frames: shown, signal }), { signal }));
  const frames = gif.durations.map((_, index) => {
    if (!shown.has(index)) return undefined;
    let bytes;
    const file = join(folder, gifFrameFileName(index));
    return {
      mimeType: "image/png",
      // Chromium loads the file itself by link (chromiumFrameMaps).
      file,
      get buffer() {
        bytes ??= readFileSync(file);
        return bytes;
      },
    };
  });
  return { durations: gif.durations, frames };
}

/**
 * The times inside a video file (seconds) that the given scene times (see mediaMoments) show,
 * skipping hidden times. `playing` is true only while the video really plays; Freeze and component
 * holds give held frames. The design view (`design`) shows one held frame where Play starts, as
 * the Design canvas does.
 */
function videoSourceTimes(layer, sceneTimes, design = false) {
  if (design) return [{ time: mediaDesignTime(layer), playing: false }];
  const times = [];
  for (const { at, clock, state } of mediaMoments(layer, sceneTimes)) {
    // A component hold stops the clock before or after its window, so the video shows one held
    // frame there. Any change counts, even a tiny one: a time held by less than 1 ms is not on the
    // playing frames' grid, and anchoring the grid on it would shift every playing frame.
    const held = clock.time !== at;
    times.push({ time: state.sourceTime, playing: state.playing && !held });
  }
  return times;
}

// Limits on FFmpeg runs per video layer. exportScene can lower them for tests (`videoLimits`).
const VIDEO_LIMITS = {
  // Playing frames that miss the main grid (a boomerang's backward pass, for example) share a few
  // phases, and each phase gets one more grid run. Normal exports need at most two.
  maxPhaseGrids: 4,
  // Held frames (Freeze, component holds) can fall between grid samples. Each one gets its own
  // extraction, up to this many per layer; beyond that they use the grid sample just before them.
  maxExtraSamples: 64,
  // An export of more than two windows of this many frames extracts its video pictures one window
  // at a time while it draws, and deletes each window when its frames are drawn
  // (videoPictureWindows), so its temporary disk holds two windows, not the whole video (a
  // five-minute render of full-frame 1080p video needed 12.5 GB of PNG files; two windows of it
  // are about 0.4 GB). 180 frames is 6 s at 30 fps. In a windowed export the two caps above count
  // for each window.
  windowFrames: 180,
};
// Two source times this close (seconds) are the same time; the difference is rounding.
const SAME_TIME = 1e-6;
const sampleKey = (time) => time.toFixed(6);

/** True when `sample` lands on a grid that starts at `first` and steps by 1/fps (within 1 ms). */
function onGridPhase(sample, first, fps) {
  const frames = (sample - first) * fps;
  return Math.abs(frames - Math.round(frames)) <= MEDIA_SAMPLE_TOLERANCE * fps;
}

// Source times further apart than this (seconds) get separate grid runs. A check or a look sheet
// asks for a few frames spread over a long video: one grid over all of them would write a picture
// every 1/fps seconds of it (18,000 for ten minutes at 30 fps) to use a dozen. A new FFmpeg run
// costs about as much as writing a couple of seconds of grid pictures, so a gap longer than that
// starts a new run.
const VIDEO_STRETCH_GAP = 2;

// The most select terms a sparse grid uses; a grid that needs more writes every sample.
const MAX_SELECT_TERMS = 256;

/**
 * The sorted sample indexes of a grid (`count` samples from `first` at `fps`) that `samples` (source
 * times) can show: each sample's own index, which is also the closest earlier one, and the last.
 * Null when they are nearly all of them (every sample is written) or too scattered for one select.
 */
export function gridSamplesKept(samples, first, fps, count) {
  const kept = new Set([count - 1]);
  for (const sample of samples) kept.add(videoFrameIndex(sample, first, fps, count));
  if (kept.size * 2 > count) return null;
  const sorted = [...kept].sort((a, b) => a - b);
  let terms = 0;
  for (const [index, value] of sorted.entries()) if (index === 0 || sorted[index - 1] !== value - 1) terms += 1;
  return terms > MAX_SELECT_TERMS ? null : sorted;
}

/** FFmpeg filters that pass only the grid samples `kept` (sorted indexes; runs as between()). */
export function selectSamples(kept) {
  const terms = [];
  for (let index = 0; index < kept.length;) {
    let end = index;
    while (end + 1 < kept.length && kept[end + 1] === kept[end] + 1) end += 1;
    terms.push(end === index ? `eq(n\\,${kept[index]})` : `between(n\\,${kept[index]}\\,${kept[end]})`);
    index = end + 1;
  }
  // trim ends the stream after the last kept sample: the padding repeats the last frame without
  // end, and FFmpeg would wait forever for select to pass another one.
  return `trim=end_frame=${kept.at(-1) + 1},select=${terms.join("+")}`;
}

// Where grid sample `index` was written among the kept ones; a sample not kept (never asked for)
// shows the closest earlier kept one.
function keptPosition(kept, index) {
  let low = 0, high = kept.length - 1, found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (kept[middle] <= index) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/** Groups sorted times into stretches [{first, last}] with no gap over VIDEO_STRETCH_GAP inside. */
function videoStretches(sortedTimes) {
  const stretches = [];
  for (const time of sortedTimes) {
    const current = stretches.at(-1);
    if (current && time - current.last <= VIDEO_STRETCH_GAP) current.last = time;
    else stretches.push({ first: time, last: time });
  }
  return stretches;
}

/**
 * Extracts the video frames an export shows, as PNG files sized for the layer.
 * Playing frames come from one FFmpeg run for each stretch of them (videoStretches; an export
 * of a video that plays throughout is one stretch), which samples the video every 1/fps seconds
 * from the stretch's first source time, plus one run for each other phase the playing frames use.
 * Each held frame that is not exactly on a grid sample gets one more run of its own.
 * `limits` caps those runs (VIDEO_LIMITS); past them a warning is added to `warnings`.
 * A time after the end of the video shows its last frame.
 * A long export calls this once for each window of its frames (videoPictureWindows), with the
 * same `shared` object each time, so the file is probed and a flow proxy made only once, and
 * `allNeeded` (the times of the whole export) decides the flow proxy as one call for the whole
 * export would.
 * Returns { frameFor(sourceTime) -> PNG path }, or null when the layer is never visible.
 */
async function extractVideoFrames(layer, videoPath, { folder, fps, sceneTimes, design = false, width, height, decoderArgs, signal, warnings, limits = VIDEO_LIMITS, flowCacheDir, shared = {}, allNeeded, checkCache = null }) {
  const needed = videoSourceTimes(layer, sceneTimes, design);
  if (!needed.length) return null;
  await mkdir(folder, { mode: 0o700 });
  const label = `Video layer “${layer.name ?? layer.id}”`;
  const remapped = isRemapped(layer) || mediaInterpolationOf(layer) !== "nearest";
  // A check render reads the pictures an earlier check render of the same timing kept
  // (check-pictures.mjs) instead of running FFmpeg again.
  const cacheKey = checkCache && !remapped ? await checkCache.keyFor(videoPath, { needed, width, height, fps, decoderArgs, design, limits }) : null;
  const cached = cacheKey ? checkCache.get(cacheKey) : null;
  if (cached) return keptPictures(cached, folder);
  shared.probe ??= mediaStep(signal, () => probeMedia(videoPath, { signal }));
  const probe = await shared.probe;
  const end = probe.duration > 0 ? probe.duration : Infinity;
  // A clip with a speed, backwards, choppy or blended shows the file's own frames (media-remap.mjs).
  if (remapped) {
    shared.remap ??= mediaStep(signal, () => remappedSource(layer, videoPath, allNeeded ?? needed, { end, width, height, decoderArgs, design, signal, warnings, flowCacheDir }));
    const source = await shared.remap;
    return mediaStep(signal, () => remappedPictures(source, needed, { folder, width, height, signal }));
  }
  const clampToEnd = (time) => Math.min(time, end);
  const filters = [`scale=${width}:${height}:force_original_aspect_ratio=decrease`];
  const ffmpeg = ffmpegCommand();

  // One FFmpeg run samples `count` pictures from `first` on, one per 1/fps seconds, and writes the
  // ones a needed time can show (all of them for a playing export) as `${prefix}000000.png` and up.
  // A check or look sheet that wants a frame every half second keeps 1 sample in 15: the others
  // are neither scaled nor written (select picks the same samples, so each picture is the same).
  const extractGrid = async (prefix, first, last) => {
    const count = videoGridCount(first, last, fps);
    const keep = gridSamplesKept(needed.map((item) => clampToEnd(item.time)), first, fps, count);
    await runProcess(ffmpeg, videoGridArgs({
      input: videoPath,
      output: join(folder, `${prefix}%06d.png`),
      firstTime: first,
      fps,
      count: keep ? keep.length : count,
      decoderArgs,
      filters: keep ? [selectSamples(keep), ...filters] : filters,
      outputArgs: ["-an", "-sn", "-dn", "-start_number", "0"],
    }), signal);
    const pattern = new RegExp(`^${prefix}\\d{6}\\.png$`);
    const written = (await readdir(folder)).filter((name) => pattern.test(name)).length;
    const wanted = keep ? keep.length : count;
    if (written === 0) throw new Error(`${label} produced no readable frames.`);
    if (written !== wanted) throw new Error(`${label} produced ${written} of ${wanted} frames.`);
    const file = (index) => join(folder, `${prefix}${String(index).padStart(6, "0")}.png`);
    return { first, count, path: keep ? (index) => file(keptPosition(keep, index)) : file };
  };
  // Grid picture for a source time, or -1 when the time is more than `tolerance` from every sample
  // of the grid. Playing times may drift up to 1 ms from the grid (the export step is rounded).
  const gridIndex = ({ first, count }, sample, tolerance = MEDIA_SAMPLE_TOLERANCE) => {
    const gridTime = (index) => first + index / fps;
    if (sample >= end && gridTime(count - 1) >= end - MEDIA_SAMPLE_TOLERANCE) return count - 1;
    const index = videoFrameIndex(sample, first, fps, count);
    return sample >= first - tolerance && Math.abs(sample - gridTime(index)) <= tolerance ? index : -1;
  };

  // The main grids follow the frames that really play, one for each stretch of them; without any,
  // they follow the held frames.
  const playing = needed.filter((item) => item.playing);
  const gridTimes = (playing.length ? playing : needed).map((item) => clampToEnd(item.time)).sort((a, b) => a - b);
  const mains = [];
  for (const stretch of videoStretches(gridTimes))
    mains.push(await extractGrid(mains.length ? `stretch-${mains.length}-` : "", stretch.first, stretch.last));
  const grids = [...mains];
  const gridPathFor = (sample, tolerance) => {
    for (const grid of grids) {
      const index = gridIndex(grid, sample, tolerance);
      if (index >= 0) return grid.path(index);
    }
    return null;
  };

  // Group the playing frames that miss the main grids by phase (and stretch). Each group's grid
  // starts at its earliest sample, so every sample in the group lands exactly on a picture.
  const phases = [];
  const playingTimes = playing.map((item) => clampToEnd(item.time)).sort((a, b) => a - b);
  for (const sample of playingTimes) {
    if (mains.some((grid) => gridIndex(grid, sample) >= 0)) continue;
    const phase = phases.find((group) => onGridPhase(sample, group.first, fps) && sample - group.last <= VIDEO_STRETCH_GAP);
    if (phase) phase.last = sample;
    else phases.push({ first: sample, last: sample });
  }
  for (const phase of phases.slice(0, limits.maxPhaseGrids))
    grids.push(await extractGrid(`phase-${grids.length}-`, phase.first, phase.last));

  // The picture for each source time the export shows, by sampleKey.
  const pictures = new Map();
  // Held frames show exactly their own time, so they use a grid picture only when they are on one.
  // The others, and playing frames beyond the phase grids, get one extraction each.
  const between = new Map();
  for (const item of needed) {
    const sample = clampToEnd(item.time);
    const key = sampleKey(sample);
    if (pictures.has(key) || between.has(key)) continue;
    const path = gridPathFor(sample, item.playing ? MEDIA_SAMPLE_TOLERANCE : SAME_TIME);
    if (path) pictures.set(key, path);
    else between.set(key, sample);
  }
  let extractions = 0;
  for (const [key, sample] of between) {
    if (extractions >= limits.maxExtraSamples) break;
    const output = join(folder, `held-${extractions}.png`);
    await runProcess(ffmpeg, videoGridArgs({
      input: videoPath, output, firstTime: sample, fps, count: 1, decoderArgs, filters,
      outputArgs: ["-an", "-sn", "-dn", "-update", "1"],
    }), signal);
    try {
      await lstat(output);
    } catch {
      throw new Error(`${label} produced no readable frame at ${sample.toFixed(3)} s.`);
    }
    pictures.set(key, output);
    extractions += 1;
  }
  if (between.size > extractions && warnings && !warnings.some((warning) => warning.code === "video-frames-approximated"))
    warnings.push({
      code: "video-frames-approximated",
      message: "A video needs too many separate frame extractions. Some exported frames show the closest earlier video frame instead.",
    });
  const frameFor = (sourceTime) => {
    const sample = clampToEnd(sourceTime);
    // Otherwise the closest earlier picture of the main grid that starts at or before it.
    const main = mains.findLast((grid) => grid.first <= sample + MEDIA_SAMPLE_TOLERANCE) ?? mains[0];
    return pictures.get(sampleKey(sample)) ?? gridPathFor(sample) ?? main.path(videoFrameIndex(sample, main.first, fps, main.count));
  };
  // A check render keeps the picture each of its times draws, for the next check render.
  if (cacheKey) {
    const kept = new Map();
    for (const item of needed) {
      const key = sampleKey(clampToEnd(item.time));
      if (!kept.has(key)) kept.set(key, await readFile(frameFor(item.time)));
    }
    checkCache.set(cacheKey, end, kept);
  }
  return { frameFor };
}

/**
 * The pictures an earlier check render kept for the same video and timing (check-pictures.mjs),
 * written into `folder` again, as { frameFor(sourceTime) -> PNG path }. A time it did not keep
 * (none should be asked) gives the closest kept picture before it.
 */
async function keptPictures({ end, pictures }, folder) {
  const paths = new Map();
  for (const [key, buffer] of pictures) {
    const file = join(folder, `kept-${paths.size}.png`);
    await writeFile(file, buffer);
    paths.set(key, file);
  }
  const times = [...paths.keys()].map(Number).sort((a, b) => a - b);
  return {
    frameFor(sourceTime) {
      const sample = Math.min(sourceTime, end);
      const exact = paths.get(sampleKey(sample));
      if (exact) return exact;
      const before = times.findLast((time) => time <= sample) ?? times[0];
      return paths.get(sampleKey(before));
    },
  };
}

// ---- sound ---------------------------------------------------------------------------------------
// The sound clips a video export mixes. prepareMedia collects them while it prepares the pictures;
// sceneSoundClips collects the same clips without any picture, for the dashboard's live playback
// (dashboard-routes.mjs, GET /api/dashboard/mix). A clip is { name, path, channels, start, end,
// offset, duration, volume, volumeTrack?, source? }; audioMixGraph sums the clips. A clip with a speed
// or played backwards is first made into a WAV on the scene clock (sound-remap.mjs), and `source`
// names the file and timing it was made from.

// Spoken lines are leveled: a clip whose file has a saved transcript (and is no song) gets one
// gain that brings its words, as measured, to VOICE_TARGET_LUFS (engine/mixLevels.js), so lines
// recorded loud and quiet sit at one level before the volume, the ducks and the master loudness.
const exportCurves = createLoudnessCurves();

// The words of `path` heard from `offset` to `offset + length` file seconds, as [{start, end}].
async function heardWordSpans(path, offset, length) {
  const words = await savedWordsOf(path);
  return (words ?? []).filter((word) => word.end > offset && word.start < offset + length && word.end > word.start)
    .map((word) => ({ start: Math.max(offset, word.start), end: Math.min(offset + length, word.end) }));
}

// A voiceLeveling result as the clip's { levelDb, levelLines? }: line times on the clip's own clock
// (0 at its Play offset), or null when it changes nothing.
function clipLeveling(leveling, shift = 0) {
  if (!leveling) return null;
  if (leveling.lines) return { levelDb: leveling.gain, levelLines: leveling.lines.map((line) => ({ ...line, from: line.from - shift, to: line.to - shift })) };
  return Math.abs(leveling.gain) < 0.1 ? null : { levelDb: leveling.gain };
}

/**
 * The leveling of a clip of `path` playing `offset` to `offset + length` file seconds, or null:
 * { levelDb, levelLines? } (engine/mixLevels.js voiceLeveling: lines far apart get a gain each).
 */
export async function voiceLevelDb(path, offset, length, { curves = exportCurves, signal } = {}) {
  const spans = await heardWordSpans(path, offset, length);
  if (!spans.length) return null;
  const curve = await curves.get(path, signal).catch(() => null);
  return clipLeveling(voiceLeveling(curve, spans), offset);
}

// The cleaned voice's leveling gains, one FFmpeg measurement per clip and chain while kino runs.
const cleanedLevels = new Map();
export const CLEANED_LEVELS_KEPT = 512;

/**
 * The leveling gain (dB) of a spoken clip after the voice cleanup chain (voice-chain.mjs), or null.
 * The chain runs before leveling, so the gain is measured on the cleaned sound: the leveling sets
 * the final level of any voice, and the chain adds no make-up gain of its own. Returns
 * { chain, leveling }: the chain's compressor threshold sits over the line's own loudness.
 */
export async function cleanedVoiceLevel(path, offset, length, { curves = exportCurves, signal } = {}) {
  const spans = await heardWordSpans(path, offset, length);
  if (!spans.length) return null;
  const curve = await curves.get(path, signal).catch(() => null);
  const chain = voiceChainFilters(loudnessOver(curve, spans));
  const file = await stat(path).catch(() => null);
  const key = JSON.stringify([path, file?.size, file?.mtimeMs, offset, length, chain]);
  if (!cleanedLevels.has(key)) {
    const printed = await runProcess(ffmpegCommand(), ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(offset), "-t", String(length), "-i", path,
      "-map", "0:a:0", "-vn", "-af", `${chain},ebur128=metadata=1,ametadata=mode=print:file=-`, "-f", "null", "-"], signal);
    const cleaned = readMomentary(printed);
    cleanedLevels.set(key, clipLeveling(voiceLeveling(cleaned, spans.map((span) => ({ start: span.start - offset, end: span.end - offset })))));
    // Each trim of a clip is a new key: keep the newest CLEANED_LEVELS_KEPT.
    if (cleanedLevels.size > CLEANED_LEVELS_KEPT) cleanedLevels.delete(cleanedLevels.keys().next().value);
  }
  return { chain, leveling: cleanedLevels.get(key) };
}

/**
 * The function that finishes a clip with its layer's volume. A clip whose layer has Volume
 * animations gets a volume track (volume-track.mjs, written into `directory`) that the mix
 * multiplies it by. `volume` is then the track's loudest value, so a clip that stays silent is
 * left out of the mix like one at volume 0.
 */
function soundClipMaker(directory, sceneDuration, signal) {
  let volumeTracks = 0;
  let speedClips = 0;
  let lowpasses = 0;
  return async (layer, clip) => {
    const volume = clamp(layer.volume ?? 1, 0, MAX_VOLUME);
    // A clip with a speed or played backwards is first made into a WAV on the scene's clock.
    if (clip.remapped && (volume > 0 || animatesVolume(layer)))
      clip = await remappedSoundClip(layer, clip, { directory, index: speedClips++, sampleRate: await audioSampleRate(clip.path, signal), signal });
    const length = clipLength(clip, sceneDuration);
    // A lowpass cutoff (engine/lowpass.js): a filter, moved by commands when it is animated.
    const lowpass = await writeLowpassPlan(join(directory, `lowpass-${lowpasses}.txt`), lowpassPlan(layer, clip.start, length, `lp${lowpasses++}`));
    if (lowpass) clip = { ...clip, lowpass };
    // A spoken line is leveled (voiceLevelDb); a remapped clip (a made WAV) and a bed turned down
    // under BED_VOLUME (street sound, chatter on footage) keep their level.
    const spoken = !clip.remapped && !clip.source && leveledVoice(layer);
    // A spoken line is first cleaned (voice-chain.mjs) unless voiceCleanup is false, then leveled.
    const cleaned = spoken && cleansVoice(layer) ? await cleanedVoiceLevel(clip.path, clip.offset ?? 0, length, { signal }) : null;
    const leveling = cleaned ? cleaned.leveling : spoken ? await voiceLevelDb(clip.path, clip.offset ?? 0, length, { signal }) : null;
    if (cleaned) clip = { ...clip, voiceChain: cleaned.chain };
    if (leveling) clip = { ...clip, ...leveling };
    if (!animatesVolume(layer)) return { ...clip, volume };
    const track = await writeVolumeTrack(join(directory, `volume-${volumeTracks++}.f32`), layer, clip.start, length);
    return { ...clip, volume: track.peak, volumeTrack: { ...track, sampleRate: await audioSampleRate(clip.path, signal) } };
  };
}

// The sound of a video layer whose file is at `path`. It is heard only while the video is drawn:
// a Hide on the video or a group around it silences it until a Show, as in the editor preview
// (videoSound.js), so there is one clip per audible range.
async function videoSoundClips(layers, layer, path, sceneDuration, { signal, soundClip }) {
  const ranges = audibleRanges(layers, layer, sceneDuration);
  const channels = ranges.length ? await audioChannelCount(path, signal) : 0;
  const clips = [];
  if (channels)
    for (const range of ranges)
      clips.push(await soundClip(layer, { name: layer.name ?? layer.id, path, channels, ...range }));
  return clips;
}

// The sound of an audio layer: one clip over its Play range (playback.js mediaPlaybackRange).
async function audioLayerSoundClips(layer, mediaRoot, sceneDuration, { signal, soundClip }) {
  const path = await resolveLocalMediaPath(layer.src, mediaRoot, `Audio layer “${layer.name ?? layer.id}”`);
  const range = mediaPlaybackRange(layer, sceneDuration);
  if (!range) return [];
  const channels = await audioChannelCount(path, signal);
  if (!channels) throw new Error(`Audio layer “${layer.name ?? layer.id}” contains no readable audio stream.`);
  return [await soundClip(layer, { name: layer.name ?? layer.id, path, channels, ...range })];
}

/**
 * The sound clips a video export of `scene` mixes, collected as prepareMedia collects them but
 * without preparing a picture: the same layers (drawn ones, so not hidden and not inside a hidden
 * group), the same ranges and the same volume tracks (written into `directory`). A video whose
 * file is missing is left out with a warning, as the export draws it transparent. `duration` is
 * the export's length in seconds: whole frames, exportFrameTimes(…).length / fps.
 */
export async function sceneSoundClips(scene, { mediaRoot, directory, duration, signal, warnings = [] }) {
  const soundClip = soundClipMaker(directory, duration, signal);
  const renderedIds = visibleLayerIds(scene);
  const clips = [];
  for (const layer of scene.layers) {
    if (layer.visible === false || !renderedIds.has(layer.id) || !layer.src) continue;
    if (layer.type === "video") {
      let path;
      try {
        path = await resolveLocalMediaPath(layer.src, mediaRoot, `Video layer “${layer.name ?? layer.id}”`);
      } catch (error) {
        aborted(signal);
        if (!reportMissingMedia(layer, error, warnings)) throw error;
        continue;
      }
      clips.push(...await videoSoundClips(scene.layers, layer, path, duration, { signal, soundClip }));
    } else if (layer.type === "audio") {
      clips.push(...await audioLayerSoundClips(layer, mediaRoot, duration, { signal, soundClip }));
    }
  }
  return clips;
}

/** How long an MP4 export of `scene` at `fps` lasts, in seconds: its whole frames, as exportScene counts them. */
export function soundMixDuration(scene, fps) {
  return exportFrameTimes(Math.max(1 / fps, finite(scene.duration, 1)), fps, { format: "mp4" }).length / fps;
}

/**
 * FFmpeg arguments that write the MP4 export's sound mix of `clips` (from sceneSoundClips) to
 * `output` as a 48 kHz stereo 16-bit WAV that lasts `duration` seconds: the export's audioMixGraph
 * and master limiter, then silence to the end so a player can loop it in step with the picture.
 * The limiter keeps its starting ceiling; a final MP4 lowers it only for a mix loud enough that
 * AAC would push it over -1 dBTP (planMasterLimiter). Null when nothing is heard.
 */
export function soundMixArgs(clips, duration, output) {
  const heard = audibleClips(clips, duration);
  if (!heard.length) return null;
  // The limiter's resampling can leave the first sample's time a few ms after 0 (a 44.1 kHz file
  // does), and then apad and -t stop that much short of `duration`. Counting times from the
  // samples again keeps the mix exactly as long as the scene.
  const graph = `${audioMixGraph(heard, duration, "mp4", 0)},${masterLimiter()},${SAMPLE_TIMES},apad=whole_dur=${duration}[sound]`;
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...audioInputArgs(heard),
    "-filter_complex", graph, "-map", "[sound]", "-t", String(duration), "-ac", "2", "-c:a", "pcm_s16le", "-f", "wav", output];
}

/**
 * The loudness of the MP4 export's mix of `clips` (from sceneSoundClips) every 0.1 s, as FFmpeg's
 * ebur128 meters it: [{t, m, s}] (momentary 0.4 s and short-term 3 s windows, LUFS; -70 is its
 * floor). One FFmpeg run that writes nothing; [] when nothing is heard. look {mode:"sound"}.
 */
export async function soundCurve(clips, duration, signal) {
  const heard = audibleClips(clips, duration);
  if (!heard.length) return [];
  const graph = `${audioMixGraph(heard, duration, "mp4", 0)},${SAMPLE_TIMES},apad=whole_dur=${duration},ebur128=peak=true:metadata=1,ametadata=mode=print:file=-`;
  const printed = await runProcess(ffmpegCommand(), ["-hide_banner", "-nostdin", "-loglevel", "error", ...audioInputArgs(heard),
    "-filter_complex", graph, "-t", String(duration), "-f", "null", "-"], signal);
  const curve = [];
  let point = null;
  for (const line of printed.split("\n")) {
    const frame = /pts_time:(\S+)/.exec(line);
    if (frame) { point = { t: Number(frame[1]), m: -70, s: -70 }; curve.push(point); continue; }
    const value = /^lavfi\.r128\.([MS])=(\S+)/.exec(line);
    if (point && value) point[value[1].toLowerCase()] = Math.max(-70, Number(value[2]) || -70);
    // The running true peak (the loudest channel so far, linear): tp in dBTP, for the mix check.
    const peak = /^lavfi\.r128\.true_peaks?(?:_ch\d+)?=(\S+)/.exec(line);
    if (point && peak && Number(peak[1]) > 0) point.tp = Math.max(point.tp ?? -Infinity, Math.round(200 * Math.log10(Number(peak[1]))) / 10);
  }
  return curve;
}

// `frameTimes` are the output frames' times; `samples` the times their pictures are drawn at, with
// motion blur {time, frameTime} pairs from shutterSamples (see mediaMoments).
async function prepareMedia(
  scene,
  options,
  mediaRoot,
  { directory, format, fps, frameTimes, samples = frameTimes, design = false, dimensions, signal, warnings, gifSlots, videoLimits, flowCacheDir, windowFrames = 0, silent = false, checkCache = null, morph = true } = {},
) {
  const frameCount = frameTimes.length;
  // Video layers whose pictures a long export extracts a window at a time (`windowFrames` > 0):
  // [{layer, videoPath, folder, extraction}], for videoPictureWindows.
  const videoPlans = [];
  const images = new Map();
  const imageSources = new Map();
  const imageFrames = new Map();
  // GIFs that raster image layers play, by the SHA-256 of the file:
  // { parsed (from parseGif), dataUrl, layers }. Layers that use the same file share one decode.
  const gifs = new Map();
  // Lottie GIF stills, by file hash and time: a promise of { buffer, mime, animated }.
  const lottieGifStills = new Map();
  // Pictures converted to plain sRGB (untaggedImage), by file hash, shared by layers.
  const untaggedImages = new Map();
  const videos = new Map();
  // Each video layer's file and extraction settings, for the morph cut pictures (morphPictures).
  const videoSources = new Map();
  let videoFolders = 0;
  const audio = [];
  const soundClip = soundClipMaker(directory, frameCount / fps, signal);
  const lottieVideoIds = new Set();
  const lottieVideoLayerIds = new Set();
  let animatedGif = false;
  const renderedIds = visibleLayerIds(scene);
  for (const layer of scene.layers) {
    if (layer.visible === false) continue;
    if (!renderedIds.has(layer.id)) continue;
    if (layer.type === "image") {
      const source = mapGet(options.embedMedia, layer) ?? layer.src;
      let media;
      try {
        media = await readMediaSource(
          source,
          mediaRoot,
          `Image layer “${layer.name ?? layer.id}”`,
        );
      } catch (error) {
        aborted(signal);
        if (!reportMissingMedia(layer, error, warnings)) throw error;
        media = transparentMediaSample();
      }
      if (media.mime === "image/svg+xml") {
        // Keep the shared renderer's raster-data boundary. Stored SVG stays vector; export
        // staging renders it at the requested canvas resolution, and Lottie embeds that PNG.
        media = { buffer: rasterizeSvgAsset(media.buffer, dimensions), mime: "image/png" };
      }
      // Chromium reads color tags and resvg does not: draw the same pixels in both.
      media = await untaggedImage(media, untaggedImages);
      if (format === "lottie" && media.mime === "image/gif") {
        // Lottie embeds one still: the GIF frame shown where Play starts (the first frame without Play).
        // Layers that show the same frame of the same file share one decode.
        const time = mediaDesignTime(layer);
        const key = `${createHash("sha256").update(media.buffer).digest("hex")}@${time}`;
        if (!lottieGifStills.has(key)) {
          const still = decodeLottieMediaFrame(media, { directory, signal, runProcess, time });
          still.catch(() => {});
          lottieGifStills.set(key, still);
        }
        try {
          media = await lottieGifStills.get(key);
        } catch (error) {
          if (!isGifError(error)) throw error;
          throw new Error(`Image layer “${layer.name ?? layer.id}” cannot draw its GIF. ${error.message}`, { cause: error });
        }
        animatedGif ||= media.animated;
      } else if (media.mime === "image/gif") {
        // Raster exports draw decoded GIF frames, so partial frames and disposal look as in the editor.
        // Reading the file's structure is quick; decoding waits until every layer is known (below).
        const key = createHash("sha256").update(media.buffer).digest("hex");
        let gif = gifs.get(key);
        if (!gif) {
          gif = { parsed: null, error: null, still: null, stillError: null, dataUrl: toDataUrl(media), layers: [] };
          try {
            gif.parsed = parseGif(media.buffer);
          } catch (error) {
            if (!isGifError(error)) throw error;
            gif.error = error;
            // A layer without Play shows only the first frame, which has its own, larger limit.
            try {
              gif.still = parseGifStart(media.buffer);
            } catch (stillError) {
              if (!isGifError(stillError)) throw stillError;
              gif.stillError = stillError;
            }
          }
          gifs.set(key, gif);
        }
        if (gif.error && hasMediaPlay(layer))
          throw new Error(`Image layer “${layer.name ?? layer.id}” cannot play its GIF. ${gif.error.message}`, { cause: gif.error });
        if (gif.stillError)
          throw new Error(`Image layer “${layer.name ?? layer.id}” cannot draw its GIF. ${gif.stillError.message}`, { cause: gif.stillError });
        gif.layers.push(layer);
        images.set(layer.id, gif.dataUrl);
        continue;
      }
      images.set(layer.id, toDataUrl(media));
      if (format === "lottie") imageSources.set(layer.id, media);
    }
    if (layer.type === "video") {
      if (format === "lottie") {
        let source;
        try {
          source = await readMediaSource(mapGet(options.embedMedia, layer) ?? layer.src,
            mediaRoot, `Video layer “${layer.name ?? layer.id}”`);
        } catch (error) {
          aborted(signal);
          if (!reportMissingMedia(layer, error, warnings)) throw error;
          const transparent = transparentMediaSample();
          images.set(layer.id, toDataUrl(transparent));
          imageSources.set(layer.id, transparent);
          lottieVideoLayerIds.add(layer.id);
          continue;
        }
        const frame = await decodeLottieMediaFrame(source, { directory, signal, runProcess, time: mediaDesignTime(layer) });
        images.set(layer.id, toDataUrl(frame));
        imageSources.set(layer.id, frame);
        lottieVideoIds.add(layer.id);
        lottieVideoLayerIds.add(layer.id);
        continue;
      }
      let frames = mapGet(options.videoFrames ?? options.frameInputs, layer);
      if (typeof frames === "function")
        throw new Error(
          `Video layer “${layer.name ?? layer.id}” needs a frame array or a local uploaded video file.`,
        );
      if (frames != null) {
        if (!Array.isArray(frames)) frames = [frames];
        if (!frames.length)
          throw new Error(
            `Video layer “${layer.name ?? layer.id}” has an empty frame array.`,
          );
        const prepared = [];
        for (const frame of frames) {
          const media = await readMediaSource(
            frame,
            mediaRoot,
            `Video frame for “${layer.name ?? layer.id}”`,
          );
          prepared.push({
            time: finite(frame?.time ?? frame?.timestamp, NaN),
            src: toDataUrl(media),
          });
        }
        videos.set(layer.id, prepared);
      } else {
        let videoPath;
        try {
          videoPath = await resolveLocalMediaPath(
            layer.src,
            mediaRoot,
            `Video layer “${layer.name ?? layer.id}”`,
          );
        } catch (error) {
          aborted(signal);
          if (!reportMissingMedia(layer, error, warnings)) throw error;
          videos.set(layer.id, [{ time: 0, src: toDataUrl(transparentMediaSample()) }]);
          continue;
        }
        const extension = extname(videoPath).toLowerCase();
        if (!String(MIME_BY_EXT[extension] ?? "").startsWith("video/"))
          throw new Error(
            `Video layer “${layer.name ?? layer.id}” references an unsupported video file.`,
          );
        const pixelWidth = Math.max(
          2,
          Math.round(
            (finite(layer.width) * dimensions.width) / finite(scene.width, 1),
          ),
        );
        const pixelHeight = Math.max(
          2,
          Math.round(
            (finite(layer.height) * dimensions.height) /
              finite(scene.height, 1),
          ),
        );
        const extraction = {
          fps,
          design,
          width: pixelWidth,
          height: pixelHeight,
          decoderArgs: extension === ".webm" ? await webmDecoderArgs(videoPath, signal) : [],
          signal,
          warnings,
          limits: videoLimits,
          flowCacheDir,
          checkCache,
        };
        const folder = `video-${videoFolders++}`;
        videoSources.set(layer.id, { layer, videoPath, extraction });
        // A long export whose video shows more pictures than one window holds extracts them a
        // window at a time while it draws (videoPictureWindows); the others are extracted now.
        const allNeeded = windowFrames ? videoSourceTimes(layer, samples, design) : null;
        if (allNeeded && new Set(allNeeded.map((item) => sampleKey(item.time))).size > windowFrames) {
          videoPlans.push({ layer, videoPath, folder, extraction: { ...extraction, shared: {}, allNeeded } });
        } else {
          const frames = await extractVideoFrames(layer, videoPath, { ...extraction, folder: join(directory, folder), sceneTimes: samples });
          if (frames) videos.set(layer.id, frames);
        }
      }
      if (["mp4", "webm", "mov"].includes(format) && layer.src && !silent) {
        const sourcePath = await resolveLocalMediaPath(
          layer.src,
          mediaRoot,
          `Video layer “${layer.name ?? layer.id}”`,
        );
        audio.push(...await videoSoundClips(scene.layers, layer, sourcePath, frameCount / fps, { signal, soundClip }));
      }
    }
    if (layer.type === "audio" && ["mp4", "webm", "mov"].includes(format) && layer.src && !silent)
      audio.push(...await audioLayerSoundClips(layer, mediaRoot, frameCount / fps, { signal, soundClip }));
  }
  // Decode each GIF once, with the frames that any of its layers shows.
  let gifFolders = 0;
  for (const gif of gifs.values()) {
    if (!gif.layers.length) continue;
    const frames = await gifPlayFrames(gif.layers, gif.parsed ?? gif.still,
      { folder: join(directory, `gif-${gifFolders++}`), sceneTimes: samples, design, signal, slots: gifSlots });
    if (frames) for (const layer of gif.layers) imageFrames.set(layer.id, frames);
  }
  if (format === "lottie") {
    const video = lottieVideoIds.size > 0;
    // The codes keep their original names because saved clients match on them.
    if (video || animatedGif) warnings.push({
      code: video && animatedGif ? "lottie-media-first-frame" : video ? "lottie-video-first-frame" : "lottie-gif-first-frame",
      message: `${video && animatedGif ? "Videos and animated GIFs" : video ? "Videos" : "Animated GIFs"} can't be fully exported to Lottie. Only one still frame of each has been exported: the frame where its Play range starts.`,
    });
  }
  const luts = await loadSceneLuts(scene, mediaRoot, renderedIds, signal);
  // `morph` false: check and look draw morph joins as morphDissolveScene's dissolve, without the flow.
  const morphs = design || !morph ? new Map() : await morphPictures(scene, videoSources, { directory, fps, frameTimes, signal, warnings });
  return { images, imageSources, imageFrames, videos, videoPlans, audio, lottieVideoIds, lottieVideoLayerIds, luts, directory, morphs };
}

// One picture of a video layer at scene time `time`, as {width, height, data} RGBA.
async function videoPictureAt({ layer, videoPath, extraction }, time, folder) {
  const frames = await extractVideoFrames(layer, videoPath, { ...extraction, folder, sceneTimes: [time] });
  const source = frames && videoSourceTimes(layer, [time])[0];
  if (!source) return null;
  const image = await loadImage(await readFile(frames.frameFor(source.time)));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  // A plain copy: reading the canvas's own pixel array one value at a time is about 5x slower.
  const { width, height, data } = context.getImageData(0, 0, image.width, image.height);
  return { width, height, data: new Uint8ClampedArray(data) };
}

/**
 * Morph cuts (engine/morphCut.js): for each join of a speech video whose incoming piece has
 * morphIn, the in-between pictures from the outgoing piece's last frame to the incoming piece's
 * first, one per output frame of the window around the join, written as PNG files. Both pieces
 * show them inside the window (videoFramesForMedia). A join between two different shots, or one
 * outside the frames this export draws, gets none and stays a plain cut.
 * Returns Map(layer id -> {start, end, files}).
 */
async function morphPictures(scene, videoSources, { directory, fps, frameTimes, signal, warnings }) {
  const morphs = new Map();
  const cuts = morphJoins(scene, speechPieces).filter((cut) => videoSources.has(cut.outgoing.id) && videoSources.has(cut.incoming.id) &&
    frameTimes.some((entry) => { const time = typeof entry === "number" ? entry : entry.time; return time >= cut.start - 1e-6 && time <= cut.end + 1e-6; }));
  for (const [number, cut] of cuts.entries()) {
    aborted(signal);
    const folder = join(directory, `morph-${number}`);
    await mkdir(folder, { mode: 0o700 });
    const last = await videoPictureAt(videoSources.get(cut.outgoing.id), cut.join - 1 / fps / 2, join(folder, "a"));
    const first = await videoPictureAt(videoSources.get(cut.incoming.id), cut.join, join(folder, "b"));
    const flows = last && first ? morphFlows(last, first) : null;
    if (!flows || shotDifference(flows) > MORPH_SAME_SHOT) {
      warnings.push({ code: "morph-cut-skipped", message: `The morph cut into “${cut.incoming.name}” was left a plain cut: ${flows ? "the frames on each side of the join look like two different shots" : "its frames could not be read"}.` });
      continue;
    }
    const count = Math.max(2, Math.round((cut.end - cut.start) * fps));
    const files = [];
    for (let index = 0; index < count; index += 1) {
      aborted(signal);
      const frame = interpolateFrame(last, first, (index + 0.5) / count, flows);
      const canvas = createCanvas(frame.width, frame.height);
      const context = canvas.getContext("2d");
      const image = context.createImageData(frame.width, frame.height);
      image.data.set(frame.data);
      context.putImageData(image, 0, 0);
      const file = join(folder, `${String(index).padStart(4, "0")}.png`);
      await writeFile(file, canvas.toBuffer("image/png"));
      files.push(file);
    }
    const morph = { start: cut.start, end: cut.end, files };
    morphs.set(cut.outgoing.id, morph);
    morphs.set(cut.incoming.id, morph);
  }
  return morphs;
}

// The .cube files that the lut effects of the drawn layers use, read and parsed once per export
// (src → parsed LUT). A file that is missing or broken is kept as { error }; drawing a frame
// with it then stops the export with that message instead of leaving the grade out.
async function loadSceneLuts(scene, mediaRoot, renderedIds, signal) {
  const luts = new Map();
  const layers = scene.layers.filter((layer) => layer.visible !== false && renderedIds.has(layer.id));
  for (const source of layersLutSources(layers)) {
    aborted(signal);
    try {
      const { buffer } = await readMediaSource(source, mediaRoot, `The LUT ${source}`);
      luts.set(source, loadedLut(source, buffer.toString("utf8")));
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      luts.set(source, missingMediaId(error) ? missingLut(source) : { error: error.message });
    }
  }
  return luts;
}

export function getOutputSize(scene, options) {
  if (options.size === "native") {
    if (options.format !== "png") throw new Error("Native size applies only to still PNG exports.");
    return nativePngSize(scene);
  }
  if (options.format === "lottie") return {
    width: Math.max(1, Math.round(finite(scene.width))),
    height: Math.max(1, Math.round(finite(scene.height))),
  };
  if (options.size) {
    const dimensions = resolveExportDimensions(scene, options.size, options.profile ?? options.format);
    validateExportDimensions(dimensions);
    return dimensions;
  }
  const width = finite(scene.width);
  const height = finite(scene.height);
  const portrait = width < height;
  const maxWidth = clamp(options.width ?? (portrait ? 1080 : 1920), 1, 5760);
  const maxHeight = clamp(options.height ?? (portrait ? 1920 : 1080), 1, 5760);
  const explicit = options.width != null || options.height != null;
  const scale = Math.min(
    maxWidth / width,
    maxHeight / height,
    explicit ? 1000 : 1,
  );
  // Video encoders need even sizes, so an odd video size is rounded down by one pixel
  // instead of failing (the size presets in exportOptions.js do the same).
  const even = EVEN_SIZE_FORMATS.has(options.format);
  const round = (value) => even ? Math.max(2, Math.floor(Math.round(value) / 2) * 2) : Math.max(1, Math.round(value));
  const dimensions = { width: round(width * scale), height: round(height * scale) };
  validateExportDimensions(dimensions);
  return dimensions;
}

const EVEN_SIZE_FORMATS = new Set(["mp4", "webm", "mov", "apng"]);

function makeRendererOptions(scene, fonts, dimensions) {
  return {
    fitTo: { mode: "width", value: dimensions.width },
    font: { loadSystemFonts: false },
    imageRendering: 0,
  };
}

/**
 * The video pictures of a long export, a window of output frames at a time (video-windows.mjs).
 * Each window extracts, for every layer in media.videoPlans, the pictures its frames show, with
 * extractVideoFrames given only that window's times; layers prepared at once (media.videos) are
 * shared by all windows. `picturesFor(index)` gives the media to draw output frame `index` with.
 */
function videoPictureWindows(media, { directory, frameTimes, windowFrames, samplesFor, signal, limits, flowCacheDir }) {
  return videoWindows({
    directory,
    frameCount: frameTimes.length,
    windowFrames,
    extract: async (first, end, folder) => {
      const sceneTimes = samplesFor(frameTimes.slice(first, end));
      const videos = new Map(media.videos);
      for (const plan of media.videoPlans) {
        const frames = await extractVideoFrames(plan.layer, plan.videoPath, { ...plan.extraction, limits, flowCacheDir, signal, folder: join(folder, plan.folder), sceneTimes });
        if (frames) videos.set(plan.layer.id, frames);
      }
      return { ...media, videos };
    },
  });
}

// With a Chromium `rasterizer`, a video picture is the link by which Chromium loads the PNG file
// itself (chromiumLink), otherwise the file's bytes.
function videoFramesForMedia(media, rasterizer) {
  const videos = new Map();
  for (const [id, source] of media.videos) {
    const morph = media.morphs?.get(id);
    if (Array.isArray(source)) videos.set(id, source);
    else
      // sourceTime is the time inside the video file that the renderer computed for this frame;
      // inside a morph cut's window both pieces show its in-between picture for `time` instead.
      videos.set(id, ({ time, sourceTime }) => {
        const inMorph = morph && time >= morph.start - 1e-6 && time <= morph.end + 1e-6;
        const file = inMorph
          ? morph.files[Math.max(0, Math.min(morph.files.length - 1, Math.floor((time - morph.start) / (morph.end - morph.start) * morph.files.length)))]
          : source.frameFor(sourceTime);
        return chromiumLink(rasterizer, file) ?? { buffer: readFileSync(file), mimeType: "image/png" };
      });
  }
  return videos;
}

// Chromium draws the export's pictures from links to their files (kino-frame://media/<path>) rather
// than from base64 data: URLs inside each frame's SVG. Chromium kept every data: URL it was sent:
// its renderer grew by about the URL's size for every frame drawn, even for the same picture
// (1.05-1.18 MB a frame for a 1 MB picture, over 200 frames), and a test edit's frame SVG carried 7 MB
// of base64 on average (up to 15 MB) twice per frame, once per motion-blur sample. With links the
// renderer stayed level (18-85 MB over 200 different 3413x1920 pictures) and drew the same pixels
// for a picture drawn once. Each paint now decodes its pictures afresh (desktop/raster-page.cjs), so a
// picture drawn at changing sizes in a final movie or a motion-blurred still matches the still and
// preview; before, it depended on what the worker drew earlier (up to 98 levels of 255 on a shrunk
// striped JPEG).
function chromiumLink(rasterizer, file) {
  const link = rasterizer?.mediaUrl?.(file);
  return link && EXPORT_FRAME_URL.test(link) ? link : null;
}

// Links for one rasterizer: still images (written once to a file in the export's folder, by their
// data URL) and decoded GIF frames (by their frames object).
const chromiumLinkCache = new WeakMap();

function linkCache(rasterizer) {
  let cache = chromiumLinkCache.get(rasterizer);
  if (!cache) chromiumLinkCache.set(rasterizer, cache = { stills: new Map(), gifs: new WeakMap(),
    pictures: { entries: new Map(), bytes: 0, svgs: 0, next: 0 }, folders: new Map() });
  return cache;
}

// Each rasterizer writes its files to new folders of its own (chromium-stills-XXXXXX and
// chromium-pictures-XXXXXX) inside the export's folder, so several workers can share one export
// folder without one overwriting or removing a file another still links to.
function linkFolder(rasterizer, directory, name) {
  const folders = linkCache(rasterizer).folders;
  const key = `${name}\0${directory}`;
  if (!folders.has(key)) folders.set(key, mkdtempSync(join(directory, `${name}-`)));
  return folders.get(key);
}

const STILL_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

function stillLink(rasterizer, directory, dataUrl) {
  const cache = linkCache(rasterizer).stills;
  if (cache.has(dataUrl)) return cache.get(dataUrl);
  let link = null;
  const match = /^data:(image\/[a-z]+);base64,/i.exec(dataUrl);
  const extension = match && STILL_EXTENSIONS[match[1].toLowerCase()];
  if (extension && directory) {
    const file = join(linkFolder(rasterizer, directory, "chromium-stills"), `still-${cache.size}.${extension}`);
    writeFileSync(file, Buffer.from(dataUrl.slice(match[0].length), "base64"), { mode: 0o600 });
    link = chromiumLink(rasterizer, file);
  }
  cache.set(dataUrl, link);
  return link;
}

// Effects draw some pictures of their own (a noise tile, a displacement map, a light disc), made
// in engine/effects/maps.js as PNG data: URLs, and the same picture usually comes back every frame.
// Sent as data: URLs these still grew Chromium's renderer by about their size each frame: a test edit's
// grain effect puts the same 472 KB noise tile in every frame twice, and painting one 1080x1920
// noise picture 300 times grew the renderer 0.993 MB a paint as a data: URL and 0.069 MB a paint
// as a link. So a Chromium frame's embedded pictures of 16 KB or more are written once to files in
// the export's folder and the SVG links to them. The files stay while any of the last
// LINK_KEEP_SVGS SVGs for each raster worker used them (a frame's 16 motion-blur samples are all
// made before the first is drawn, and orderedFrames keeps one frame more than there are workers
// in hand, so no sample loses a picture before it is drawn), and the oldest beyond that are removed
// once they hold more than LINKED_PICTURE_BYTES; a removed picture that comes back gets a new file
// and link, never an old name.
// Only <image> elements get links. The page waits for each linked <image> to fire its load event
// before the frame is captured (desktop/raster-page.cjs); an <feImage> fires no load event, so a
// linked one could be captured before Chromium draws it, and its pictures stay data: URLs.
const EMBEDDED_PICTURE = /(<image\b[^>]*?\s)href="data:(image\/(?:png|jpeg|jpg|webp|gif|avif));base64,([A-Za-z0-9+/]+={0,2})"/gi;
const LINK_PICTURES_FROM = 16 * 1024;
const LINK_KEEP_SVGS = 64;
const LINKED_PICTURE_BYTES = 256 * 1024 * 1024;

// Exported for tests, which also pass smaller limits.
export function linkEmbeddedPictures(svg, rasterizer, directory, { keepSvgs = LINK_KEEP_SVGS * Math.max(1, rasterizer?.workers ?? 1), maxBytes = LINKED_PICTURE_BYTES } = {}) {
  if (!rasterizer?.mediaUrl || !directory || !svg.includes('href="data:image/')) return svg;
  const cache = linkCache(rasterizer).pictures;
  const use = ++cache.svgs;
  const linked = svg.replace(EMBEDDED_PICTURE, (whole, start, type, data) => {
    if (data.length < LINK_PICTURES_FROM) return whole;
    const extension = STILL_EXTENSIONS[type.toLowerCase()];
    const key = `${extension}:${createHash("sha256").update(data).digest("base64url")}`;
    let entry = cache.entries.get(key);
    if (entry) cache.entries.delete(key);
    else {
      const file = join(linkFolder(rasterizer, directory, "chromium-pictures"), `picture-${cache.next++}.${extension}`);
      const bytes = Buffer.from(data, "base64");
      writeFileSync(file, bytes, { mode: 0o600 });
      const link = chromiumLink(rasterizer, file);
      if (!link) { rmSync(file, { force: true }); return whole; }
      entry = { file, link, bytes: bytes.length };
      cache.bytes += entry.bytes;
    }
    // A Map keeps insertion order, so the least recently used picture comes first.
    entry.use = use;
    cache.entries.set(key, entry);
    // The link names a file in the temporary folder, whose path may hold "&" or "'".
    return `${start}href="${escapeXml(entry.link)}"`;
  });
  for (const [key, entry] of cache.entries) {
    if (cache.bytes <= maxBytes || entry.use > use - keepSvgs) break;
    rmSync(entry.file, { force: true });
    cache.entries.delete(key);
    cache.bytes -= entry.bytes;
  }
  return linked;
}

// The frame maps renderSceneSvg reads (imageFrames and videoFrames), with links for Chromium.
// Exported for tests.
export function chromiumFrameMaps(media, rasterizer) {
  const videoFrames = videoFramesForMedia(media, rasterizer);
  if (!rasterizer?.mediaUrl) return { imageFrames: media.imageFrames, videoFrames };
  const imageFrames = new Map(media.imageFrames);
  const gifs = linkCache(rasterizer).gifs;
  for (const [id, value] of imageFrames) {
    if (!value || typeof value !== "object" || !Array.isArray(value.frames)) continue;
    if (!gifs.has(value)) gifs.set(value, { ...value, frames: value.frames.map(frame => (frame?.file && chromiumLink(rasterizer, frame.file)) || frame) });
    imageFrames.set(id, gifs.get(value));
  }
  for (const [id, dataUrl] of media.images ?? []) {
    if (imageFrames.has(id) || typeof dataUrl !== "string") continue;
    const link = stillLink(rasterizer, media.directory, dataUrl);
    if (link) imageFrames.set(id, link);
  }
  return { imageFrames, videoFrames };
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (whole, name) => XML_ENTITIES[name]);

// The cache key of a Chromium frame names its linked files by path; their size, change time and
// file number make it change if a file at that path ever held another picture. Links sit in the
// SVG escaped ("&" written "&amp;"), so they are unescaped before the file is looked up.
// Exported for tests.
export function linkedFilesKey(svg) {
  const files = new Set((svg.match(/kino-frame:\/\/media\/[^"'\s<>]+/g) ?? []).map(unescapeXml));
  return [...files].map(link => {
    try {
      const info = statSync(fileURLToPath(`file://${link.slice("kino-frame://media".length)}`), { bigint: true });
      return `${info.size}:${info.mtimeNs}:${info.ino}`;
    } catch { return "missing"; }
  }).join(",");
}

// `design` draws the layers' design values without animation, as the editor's Design canvas does.
// `raw` returns the RGBA pixels instead of a PNG file (the quality checker reads them).
// `mediaTime` is the output frame whose footage pictures are shown (motion blur draws a frame at
// nearby times but keeps its own footage picture; render.js mediaClock).
// `previewBlur` (look frames) smears fast layers as a final render's motion blur would (previewBlur.js).
function frameSvg(scene, time, media, fonts, dimensions, { design = false, rasterizer, mediaTime = time, draft = false, previewBlur = false } = {}) {
  const { imageFrames, videoFrames } = chromiumFrameMaps(media, rasterizer);
  const svg = renderSceneSvg(scene, time, {
    design,
    mediaTime,
    raster: !rasterizer,
    draft,
    previewBlur,
    rasterScale: { x: dimensions.width / scene.width, y: dimensions.height / scene.height },
    embedMedia: media.images,
    imageFrames,
    videoFrames,
    fonts,
    luts: media.luts,
  }).replace(/^(<svg[^>]*?) width="[^"]+" height="[^"]+"/, `$1 width="${dimensions.width}" height="${dimensions.height}" preserveAspectRatio="none"`);
  return rasterizer ? linkEmbeddedPictures(svg, rasterizer, media.directory) : svg;
}

// `label` names the frame in a Chromium time-limit error ("frame 151 at 5.033 s").
// `draft` (check and look frames): tilted layers get a coarser grid with only on-screen triangles
// (render.js triangleTiltTag) and, in Chromium, a smaller shared bitmap.
async function renderPng(scene, time, media, fonts, dimensions, { design = false, raw = false, rasterizer, signal, mediaTime = time, svg, label, draft = false, previewBlur = false } = {}) {
  aborted(signal);
  svg ??= frameSvg(scene, time, media, fonts, dimensions, { design, rasterizer, mediaTime, draft, previewBlur });
  const rendererOptions = makeRendererOptions(scene, fonts, dimensions);
  // Chromium's pixels depend on the card it draws with (rasterizer.graphicsKey), so a frame drawn on
  // the processor is not reused for an export that asks for the card, or the other way round.
  const key = renderFrameCache.key(svg, { rendererOptions, raw, renderer: rasterizer ? "chromium" : "resvg", ...(draft ? { draft } : {}),
    ...(rasterizer?.graphicsKey ? { graphics: rasterizer.graphicsKey } : {}),
    ...(rasterizer && svg.includes("kino-frame://") ? { linkedFiles: linkedFilesKey(svg) } : {}) });
  const cached = renderFrameCache.get(key);
  if (cached) return cached;
  let result;
  if (rasterizer) {
    // Chromium sends raw pixels as premultiplied RGBA, the quality checker's contract.
    const request = { label: label ?? `the frame at ${Number(time).toFixed(3)} s`, draft };
    result = raw ? await rasterizer.renderPixels(svg, dimensions.width, dimensions.height, request)
      : await rasterizer.render(svg, dimensions.width, dimensions.height, request);
  } else result = await defaultRenderPool.render(svg, rendererOptions, { signal, raw, draft });
  aborted(signal);
  renderFrameCache.set(key, result);
  return result;
}

// The shutter samples of each output frame (motionSampleTimes) as {time, frameTime} pairs, for
// prepareMedia: footage shows the picture of `frameTime` at every sample (mediaMoments).
// `samplesAt(frameTime)` is how many that frame draws (frameMotionSamples).
function shutterSamples(frameTimes, duration, fps, motionBlur, samplesAt) {
  const samples = new Map();
  for (const frameTime of frameTimes)
    for (const time of motionSampleTimes(frameTime, duration, fps, motionBlur, samplesAt(frameTime)))
      samples.set(`${time}@${frameTime}`, { time, frameTime });
  return [...samples.values()];
}

async function blendedPng(blended, dimensions) {
  return { buffer: await encodeRenderPng(blended.pixels, dimensions.width, dimensions.height),
    reference: frameReference(blended.pixels, dimensions.width, dimensions.height), ...dimensions };
}

// Rounds to the nearest whole number, and a half to the even one, as the processor does.
function roundHalfEven(value) {
  const whole = Math.floor(value);
  if (value - whole !== 0.5) return Math.round(value);
  return whole % 2 === 0 ? whole : whole + 1;
}

// FFmpeg reads straight (not premultiplied) RGBA. This undoes the premultiplication the way
// Chromium's PNG encoder (Skia) does it, in 32-bit floats (Math.fround), so a movie gets the
// pixels Chromium's PNG files had: the same at every colour and alpha on a Mac. Opaque and
// fully transparent pixels stay as they are. Changes the pixels in place and returns them.
const ONE_255TH = Math.fround(1 / 255);
function straightAlpha(pixels) {
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    const scale = Math.fround(1 / Math.fround(alpha * ONE_255TH));
    for (let channel = index; channel < index + 3; channel += 1) {
      const straight = Math.min(1, Math.fround(Math.fround(pixels[channel] * ONE_255TH) * scale));
      pixels[channel] = roundHalfEven(Math.fround(straight * 255));
    }
  }
  return pixels;
}

// How many shutter samples the frame at `time` draws: options.motionSamples when the agent set it,
// otherwise as many as its fastest layer needs for an even smear (previewBlur.js shutterSampleCount).
function frameMotionSamples(scene, time, options, dimensions, fonts) {
  if (!options.autoMotionSamples) return options.motionSamples ?? 2;
  return shutterSampleCount(scene.layers, time, options.motionBlur / (options.fps ?? 30), {
    scale: dimensions.width / finite(scene.width, dimensions.width), duration: options.duration ?? scene.duration, fonts, max: MAX_MOTION_SAMPLES });
}

// One output frame with motion blur (options.motionSamples moments of the open shutter, averaged)
// and dither. The blur comes from the layers' movement: every sample shows the footage picture of
// the frame's own time (mediaTime), so a clip never mixes two of its pictures.
// `context.pixels` (Chromium only) answers straight RGBA pixels, {pixels, width, height}, instead
// of a PNG file: exportScene sends a movie's frames to FFmpeg that way.
async function renderQualityFrame(scene, time, media, fonts, dimensions, options, context) {
  // Real motion blur replaces the preview's.
  if (options.motionBlur && context.previewBlur) context = { ...context, previewBlur: false };
  if ((!options.motionBlur && !options.dither) || context.design) {
    if (!context.pixels) return renderPng(scene, time, media, fonts, dimensions, context);
    const frame = await renderPng(scene, time, media, fonts, dimensions, { ...context, raw: true });
    return { ...frame, pixels: straightAlpha(frame.pixels) };
  }
  const times = motionSampleTimes(time, options.duration ?? scene.duration, options.fps ?? 30, options.motionBlur, frameMotionSamples(scene, time, options, dimensions, fonts));
  const svgs = times.map(sampleTime => frameSvg(scene, sampleTime, media, fonts, dimensions, { ...context, mediaTime: time }));
  // Nothing moves while the shutter is open: every sample is the same picture, so draw it once.
  if (svgs.every(svg => svg === svgs[0])) svgs.length = 1;
  if (!context.rasterizer) {
    const rendererOptions = makeRendererOptions(scene, fonts, dimensions);
    const key = renderFrameCache.key(JSON.stringify(svgs), { rendererOptions, quality: options, renderer: "resvg-quality", ...(context.draft ? { draft: true } : {}) });
    const cached = renderFrameCache.get(key);
    if (cached) return cached;
    let result;
    if (svgs.reduce((bytes, svg) => bytes + Buffer.byteLength(svg, "utf8"), 0) <= MAX_SVG_BYTES) {
      result = await defaultRenderPool.render(svgs[0], rendererOptions, {
        samples: svgs.slice(1), dither: options.dither, signal: context.signal, draft: Boolean(context.draft),
      });
    } else {
      // Too much SVG text for one worker request (large footage pictures in many samples).
      const blend = createSampleBlend(dimensions.width, dimensions.height);
      for (const svg of svgs) blend.add({ ...await defaultRenderPool.render(svg, rendererOptions, { raw: true, signal: context.signal, draft: Boolean(context.draft) }), premultiplied: true });
      result = await blendedPng(blend.finish(options), dimensions);
    }
    renderFrameCache.set(key, result);
    return result;
  }
  const blend = createSampleBlend(dimensions.width, dimensions.height);
  let picture, pictureSvg;
  for (let index = 0; index < svgs.length; index += 1) {
    // Samples next to each other are often the same picture (a move that starts mid-shutter).
    if (svgs[index] !== pictureSvg)
      picture = await renderPng(scene, times[index], media, fonts, dimensions, { ...context, raw: true, mediaTime: time, svg: svgs[index],
        label: `${context.label ?? `the frame at ${time.toFixed(3)} s`}, shutter sample ${index + 1} of ${svgs.length}` });
    pictureSvg = svgs[index];
    blend.add({ ...picture, premultiplied: true });
  }
  const blended = blend.finish(options);
  if (context.pixels) return { ...blended, reference: frameReference(blended.pixels, dimensions.width, dimensions.height) };
  return blendedPng(blended, dimensions);
}

async function referenceForFrame(result) {
  if (result.reference) return result.reference;
  if (result.pixels) return frameReference(result.pixels, result.width, result.height);
  const image = await loadImage(result.buffer);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return frameReference(context.getImageData(0, 0, image.width, image.height).data, image.width, image.height);
}

// Draws `ahead` frames at a time (two by default; one more than there are raster workers, so a
// worker that finishes always finds a frame waiting) and hands them out in order, however they
// finish: frame i + ahead starts once frame i is drawn and the encoder asks for it. Promise
// rejections are observed immediately, and shutdown awaits every frame still drawing before
// media is deleted. Exported for tests.
export async function* orderedFrames(times, render, signal, ahead = 2) {
  const pending = new Map();
  const start = index => {
    if (index >= times.length) return;
    const promise = render(times[index], index).then(value => ({ value }), error => ({ error }));
    pending.set(index, promise);
  };
  for (let index = 0; index < ahead; index++) start(index);
  try {
    for (let index = 0; index < times.length; index++) {
      aborted(signal);
      const { value, error } = await pending.get(index); pending.delete(index);
      if (error) throw error;
      start(index + ahead);
      yield { index, ...value };
    }
  } finally { await Promise.all(pending.values()); }
}

function colorToRgba(value) {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  const named = {
    black: [0, 0, 0, 1],
    white: [255, 255, 255, 1],
    red: [255, 0, 0, 1],
    green: [0, 128, 0, 1],
    blue: [0, 0, 255, 1],
    yellow: [255, 255, 0, 1],
    orange: [255, 165, 0, 1],
    purple: [128, 0, 128, 1],
    pink: [255, 192, 203, 1],
    gray: [128, 128, 128, 1],
    grey: [128, 128, 128, 1],
    transparent: [0, 0, 0, 0],
  };
  if (named[color]) return named[color];
  const hex = /^#([\da-f]{3,8})$/i.exec(color);
  if (hex) {
    let value = hex[1];
    if (value.length === 3 || value.length === 4)
      value = [...value].map((part) => part + part).join("");
    if (value.length === 6 || value.length === 8) {
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
        value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgb) {
    const components = rgb[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    if (
      components.length >= 3 &&
      components.slice(0, 3).every(Number.isFinite)
    ) {
      return [
        clamp(components[0], 0, 255),
        clamp(components[1], 0, 255),
        clamp(components[2], 0, 255),
        components.length > 3 ? clamp(components[3], 0, 1) : 1,
      ];
    }
  }
  return null;
}


function property(values, dimension = 1) {
  const normalized = values.map((value) =>
    Array.isArray(value) ? value.slice(0, dimension) : [value],
  );
  const same = normalized.every(
    (value) =>
      value.length === normalized[0].length &&
      value.every(
        (part, index) =>
          Math.abs(finite(part) - finite(normalized[0][index])) < 1e-7,
      ),
  );
  if (same)
    return { a: 0, k: dimension === 1 ? normalized[0][0] : normalized[0] };
  const keyframes = normalized.map((value, index) => {
    const next = normalized[index + 1];
    const frame = { t: index, s: value };
    if (next) {
      frame.e = next;
      frame.i = { x: 1, y: 1 };
      frame.o = { x: 0, y: 0 };
    } else frame.h = 1;
    return frame;
  });
  return { a: 1, k: keyframes };
}

// `fonts` is the export's font registry; it measures Auto height text that a Resize rewraps.
function evaluated(layer, time, unitIndex = 0, unitCount = 1, unit = "layer", fonts = undefined) {
  const result = evaluateLayer(layer, time, { unitIndex, unitCount, unit, ...(fonts ? { fonts } : {}) });
  if (result.visible === false) result.opacity = 0;
  return {
    ...layer,
    ...(result?.values ?? result?.properties ?? result ?? {}),
  };
}

function localMatrix(layer, state) {
  const x = finite(state.x);
  const y = finite(state.y);
  const width = finite(state.width);
  const height = finite(state.height);
  const rotation = (finite(state.rotation) * Math.PI) / 180;
  const sx = finite(state.scaleX, 1);
  const sy = finite(state.scaleY, 1);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const shear = Math.tan((finite(state.skewX) * Math.PI) / 180);
  let a = cos * sx;
  let b = sin * sx;
  const c = cos * sx * shear - sin * sy;
  const d = sin * sx * shear + cos * sy;
  // skewY after skewX (geometry.js layerMatrix), only when set.
  if (finite(state.skewY)) {
    const shearY = Math.tan((finite(state.skewY) * Math.PI) / 180);
    a += c * shearY;
    b += d * shearY;
  }
  const [cx, cy] = pivotOf(state, width, height);
  return [a, b, c, d, x + cx - a * cx - c * cy, y + cy - b * cx - d * cy];
}

function multiplyMatrix(parent, child) {
  const [a, b, c, d, e, f] = parent;
  const [g, h, i, j, k, l] = child;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function decompose(
  matrix,
  width,
  height,
  label,
  anchor = [width / 2, height / 2],
) {
  const [a, b, c, d, e, f] = matrix;
  const sx = Math.hypot(a, b);
  const determinant = a * d - b * c;
  const sy = sx > 1e-12 ? determinant / sx : Math.hypot(c, d);
  const dot = a * c + b * d;
  if (Math.abs(determinant) < 1e-12 && Math.abs(dot) > 1e-8) {
    throw new Error(
      `${label} has a collapsed, sheared transform that Lottie cannot preserve.`,
    );
  }
  const rotation = (sx > 1e-12 ? Math.atan2(b, a) : Math.atan2(-c, d)) * 180 / Math.PI;
  const skew = Math.abs(determinant) > 1e-12 ? -Math.atan(dot / determinant) * 180 / Math.PI : 0;
  const centerX = e + a * anchor[0] + c * anchor[1];
  const centerY = f + b * anchor[0] + d * anchor[1];
  return {
    p: [centerX, centerY, 0],
    a: [anchor[0], anchor[1], 0],
    s: [sx * 100, sy * 100, 100],
    r: rotation,
    sk: skew,
  };
}

function visibleTree(scene) {
  const byId = new Map(
    (scene.layers ?? []).map((layer) => [layer.id, { layer, children: [] }]),
  );
  const roots = [];
  for (const node of byId.values()) {
    const parent =
      node.layer.parentId == null ? undefined : byId.get(node.layer.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function visibleLayerIds(scene) {
  const ids = new Set();
  const visit = (nodes) => {
    for (const { layer, children } of nodes) {
      if (layer.visible === false) continue;
      ids.add(layer.id);
      visit(children);
    }
  };
  visit(visibleTree(scene));
  return ids;
}

// Images fill their layer box with a centered crop. Lottie's asset size is
// measured in physical pixels, so the cover transform precedes the layer transform.
function imageFitMatrix(state, image) {
  const fitSize = state.lottieFitMode === "contain" ? Math.min : Math.max;
  const fit = fitSize(finite(state.width) / image.sourceWidth, finite(state.height) / image.sourceHeight);
  return [fit, 0, 0, fit,
    (finite(state.width) - image.sourceWidth * fit) / 2,
    (finite(state.height) - image.sourceHeight * fit) / 2];
}

function measureLottieImageAssets(scene, options, images, signal) {
  if (options.imageDPIRatio === "original") return;
  const duration = finite(options.duration, finite(scene.duration, 1));
  const basisProperties = new Set(["width", "height", "rotation", "scaleX", "scaleY", "skewX", "skewY"]);
  const visit = (nodes, parents = []) => {
    for (const { layer, children } of nodes) {
      if (layer.visible === false) continue;
      const chain = [...parents, layer];
      const image = images.get(layer.id);
      if (image) {
        const boundaries = new Set([0, duration]);
        let animated = false;
        const states = chain.map((item) => {
          // Only operations used in playback (animationEnabled.js) change the image's size.
          const operations = enabledAnimations(item.animations).filter((animation) =>
            isAnimationCompatible(item, animation) &&
            Object.keys({ ...animation.from, ...animation.to }).some((key) => basisProperties.has(key)));
          for (const animation of operations) {
            const start = finite(animation.start);
            const end = start + Math.max(0, finite(animation.duration));
            if (start < duration && end > 0) animated = true;
            if (start > 0 && start < duration) boundaries.add(start);
            if (end > 0 && end < duration) boundaries.add(end);
          }
          for (const window of item.playbackWindows ?? []) {
            if (window.start > 0 && window.start < duration) boundaries.add(window.start);
            if (window.end > 0 && window.end < duration) boundaries.add(window.end);
          }
          return operations.length ? null : evaluated(item, 0);
        });
        const measure = (time) => {
          aborted(signal);
          let matrix = [1, 0, 0, 1, 0, 0];
          let imageState;
          for (let index = 0; index < chain.length; index += 1) {
            const state = states[index] ?? evaluated(chain[index], time);
            matrix = multiplyMatrix(matrix, localMatrix(chain[index], state));
            if (index === chain.length - 1) imageState = state;
          }
          matrix = multiplyMatrix(matrix, imageFitMatrix(imageState, image));
          image.maxWidth = Math.max(image.maxWidth, image.sourceWidth * Math.hypot(matrix[0], matrix[1]));
          image.maxHeight = Math.max(image.maxHeight, image.sourceHeight * Math.hypot(matrix[2], matrix[3]));
        };
        if (!animated) measure(0);
        else {
          // Include narrow operations and easing overshoot by sampling each shared
          // transform interval, independently of the animation's export frame rate.
          const times = [...boundaries].sort((left, right) => left - right);
          for (let index = 1; index < times.length; index += 1) {
            const start = times[index - 1], end = times[index];
            for (let sample = 0; sample <= 1000; sample += 1)
              measure(start + (end - start) * sample / 1000);
          }
        }
      }
      visit(children, chain);
    }
  };
  visit(visibleTree(scene));
}

async function prepareLottieImageAssets(scene, options, media, { directory, signal, warnings }) {
  const sources = new Map();
  const images = new Map();
  for (const [id, source] of media.imageSources) {
    aborted(signal);
    const digest = createHash("sha256").update(source.mime).update(source.buffer).digest("hex");
    let image = sources.get(digest);
    if (!image) {
      image = await inspectLottieImage(source, { directory, index: sources.size, signal, runProcess });
      Object.assign(image, { index: sources.size, maxWidth: 0, maxHeight: 0 });
      sources.set(digest, image);
    }
    images.set(id, image);
  }
  if (!images.size) return images;

  measureLottieImageAssets(scene, options, images, signal);
  for (const image of sources.values()) {
    aborted(signal);
    const result = await resizeLottieImage(image, {
      maxWidth: image.maxWidth, maxHeight: image.maxHeight,
      imageDPIRatio: options.imageDPIRatio ?? "3x", directory,
      index: image.index, signal, runProcess,
    });
    Object.assign(image, result);
    if (image.clamped && !warnings.some((warning) => warning.code === "lottie-image-clamped")) {
      warnings.push({
        code: "lottie-image-clamped",
        message: "At least one image was too large to be exported at full size. Images in the exported Lottie file may appear slightly blurry.",
      });
    }
  }
  return images;
}

function sampleLayer(
  layer,
  times,
  unitIndex = 0,
  unitCount = 1,
  unit = "layer",
  fonts = undefined,
) {
  return times.map((time) =>
    evaluated(layer, time, unitIndex, unitCount, unit, fonts),
  );
}

function sampledTransform(layer, matrices, states, label, anchor = null) {
  const decomposed = matrices.map((matrix, index) =>
    decompose(
      matrix,
      finite(states[index].width),
      finite(states[index].height),
      label,
      // The layer's anchor is Lottie's anchor too, so a turn about it keeps p still.
      anchor ?? pivotOf(states[index], finite(states[index].width), finite(states[index].height)),
    ),
  );
  // A cycling loop jumps back at each new pass: hold across that frame gap (lottie-visibility.mjs).
  const restarts = new Set([...loopRestartFrames(states), ...stepFrames(states)]);
  const sampled = (values, dimension) => holdKeyframesAt(property(values, dimension), restarts);
  return {
    a: sampled(decomposed.map((item) => item.a), 3),
    p: sampled(decomposed.map((item) => item.p), 3),
    s: sampled(decomposed.map((item) => item.s), 3),
    r: sampled(decomposed.map((item) => item.r)),
    sk: sampled(decomposed.map((item) => item.sk)),
    sa: {a: 0, k: 0},
    // A layer that is hidden or shown between two frames switches at once (hold keyframes).
    o: states[0]?._lottieOpacity ?? holdKeyframesAt(property(states.map((state) => clamp(state.opacity, 0, 1) * 100)),
      new Set([...visibilitySwitchFrames(states), ...restarts])),
  };
}


function assertLottieFeatures(scene, media = {}) {
  const renderedIds = visibleLayerIds(scene);
  const inspect = (layers) => {
    for (const layer of layers) {
      if (!renderedIds.has(layer.id)) continue;
      if (media.effectCoveredIds?.has(layer.id) || media.nativeEffectFills?.has(layer.id)) continue;
      const effect = enabledAnimations(layer.animations).find((animation) => animation.kind === "effect");
      if (effect) throw new Error(`Lottie export cannot yet render ${effectDefinition(effect.effect).label} on layer “${layer.name ?? layer.id}”. Use PNG, video, or GIF export for this effect.`);
      const presetEffect = enabledAnimations(layer.animations).find((animation) => animation.from?.effectPreset || animation.to?.effectPreset);
      if (presetEffect) throw new Error(`Lottie export cannot yet render effect preset ${(presetEffect.to?.effectPreset ?? presetEffect.from.effectPreset).id} on layer “${layer.name ?? layer.id}”. Use PNG, video, or GIF export for this effect.`);
      if (layer.backgroundBlur?.enabled || layer.glass?.enabled)
        throw new Error(`Lottie export could not prepare backdrop effects on layer “${layer.name ?? layer.id}”.`);
      // 2.5D tilt (engine/tilt.js): Lottie players draw 3D layers differently or not at all.
      const tilted = (values) => ["rotateX", "rotateY"].some((key) => Math.abs(finite(values?.[key])) > 1e-6);
      // A keyed animation's middle keys count too (they are sampled frame by frame like the rest).
      const anyValues = (test) => enabledAnimations(layer.animations).some((animation) =>
        test(animation.from) || test(animation.to) || (animation.keys ?? []).some((key) => test(key.value)));
      if (tilted(layer) || anyValues(tilted))
        throw new Error(`Lottie export cannot yet render the 3D tilt (rotateX, rotateY) on layer “${layer.name ?? layer.id}”. Use PNG, video, or GIF export, or set rotateX and rotateY to 0 for Lottie.`);
      // A repeater (engine/repeater.js) is not written to Lottie yet.
      const repeated = (values) => finite(values?.repeatCopies, 1) > 1;
      if (repeated(layer) || anyValues(repeated))
        throw new Error(`Lottie export cannot yet render the repeater (repeatCopies) on layer “${layer.name ?? layer.id}”. Use PNG, video, or GIF export, or set repeatCopies to 1 for Lottie.`);
      // Lottie has one drop shadow per layer: a stacked list is refused, not cut to one.
      if (Array.isArray(layer.shadows) && layer.shadows.length)
        throw new Error(`Lottie export cannot render stacked shadows (shadows) on layer “${layer.name ?? layer.id}”. Use PNG, video, or GIF export, or keep one shadow (shadow) for Lottie.`);
      if (Array.isArray(layer.strokes) && layer.strokes.length)
        throw new Error(`Lottie export cannot render stacked strokes (strokes) on layer “${layer.name ?? layer.id}”. Use PNG, video, or GIF export, or keep one stroke (stroke) for Lottie.`);
      if (["video", "audio"].includes(layer.type))
        throw new Error(
          `Lottie export does not support ${layer.type} layer “${layer.name ?? layer.id}”.`,
        );
    }
  };
  inspect(scene.layers);
}

// `warnings` collects what the Lottie file can't show exactly ({ code, message }, once per code).
function lottieAnimation(scene, options, media, dimensions, fontRegistry, warnings = []) {
  const opacityCache = new WeakMap();
  const sample = (layer, times, unitIndex = 0, unitCount = 1, unit = "layer") => {
    let opacity = null;
    if (times === frameTimes) {
      let cache = opacityCache.get(layer);
      if (!cache) opacityCache.set(layer, cache = new Map());
      const key = `${unit}:${unitIndex}:${unitCount}`;
      if (!cache.has(key)) cache.set(key, discreteOpacityProperty(layer, times, { unitIndex, unitCount, unit, fonts: fontRegistry }));
      opacity = cache.get(key);
    }
    return sampleLayer(layer, times, unitIndex, unitCount, unit, fontRegistry)
      .map((state) => ({ ...resizeTextLayer(state, fontRegistry), ...(opacity ? { _lottieOpacity: opacity } : {}) }));
  };
  assertLottieFeatures(scene, media);
  const fps = clamp(options.fps ?? 60, 1, 120);
  const duration = Math.max(
    1 / fps,
    finite(options.duration, finite(scene.duration, 1)),
  );
  // The same frame count as video (exportFrameCount), so 3.003 s at 23.976 is 72 frames, not 73.
  const frameCount = exportFrameCount(duration, fps);
  // Lottie samples with the same rounded step as the other formats, so a Play range starts and
  // ends on the same frame everywhere. The last sample is the final frame boundary.
  const frameTimes = Array.from(
    { length: frameCount + 1 },
    (_, index) => Math.min(frameCount / fps, exportFrameTime(index, fps)),
  );
  const nextIndexFactory = () => {
    let index = 1;
    return () => index++;
  };
  const nextIndex = nextIndexFactory();
  const layers = [];
  const assets = [];
  const imageAssetIds = new Map();
  const colorImageAssets = new Map();
  const sceneTree = visibleTree(scene);

  const inlineImage = (color) => {
    if (![color.width, color.height].every((value) => Number.isFinite(value) && value > 0))
      throw new Error("A color glyph has invalid dimensions.");
    const source = /^data:image\/(svg\+xml|png);base64,([A-Za-z0-9+/=]+)$/u.exec(color.href ?? "");
    if (!source) throw new Error("A color glyph must contain an embedded SVG or PNG.");
    const key = createHash("sha256").update(color.href).digest("hex");
    if (colorImageAssets.has(key)) return colorImageAssets.get(key);
    let href = color.href, width = color.pixelWidth, height = color.pixelHeight;
    if (source[1] === "svg+xml") {
      // Preserve the sanitized vector drawing. Rasterizing here adds a second
      // sampling step in the player and changes small emoji edges and colors.
      // The integer viewport matches Lottie's asset dimensions; image placement
      // maps it back to the glyph's exact, possibly fractional font metrics.
      const zoom = Math.min(1, 8192 / color.width, 8192 / color.height);
      width = Math.max(1, Math.ceil(color.width * zoom));
      height = Math.max(1, Math.ceil(color.height * zoom));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="${color.href}" width="${width}" height="${height}" preserveAspectRatio="none"/></svg>`;
      href = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      if (!warnings.some((warning) => warning.code === "lottie-svg-color-glyphs"))
        warnings.push({ code: "lottie-svg-color-glyphs", message: "Color emoji use embedded SVG images to preserve their artwork. Choose a Lottie player that supports SVG image assets; some native mobile players require a custom image loader." });
    }
    if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192))
      throw new Error("A color glyph image has invalid pixel dimensions.");
    const result = { refId: `color_glyph_${colorImageAssets.size + 1}`, width, height };
    assets.push({ id: result.refId, w: width, h: height, u: "", p: href, e: 1 });
    colorImageAssets.set(key, result);
    return result;
  };

  const compositionLayer = (content, name, domain, { precompose = false } = {}) => {
    if (content.length === 1 && !precompose) return content[0];
    const refId = `composition_${nextIndex()}`;
    assets.push({id: refId, w: domain.width, h: domain.height, layers: content.reverse()});
    return {
      ddd: 0, ind: nextIndex(), ty: 0, nm: name, refId, w: domain.width, h: domain.height,
      sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0,
      ks: {a: {a: 0, k: [0,0,0]}, p: {a: 0, k: [0,0,0]}, s: {a: 0, k: [100,100,100]}, r: {a: 0, k: 0}, o: {a: 0, k: 100}},
    };
  };

  // A luminance track matte: the mask layer's drawing decides where the masked layers show.
  // `addMasked(content)` adds the masked layers to `content`. On frames in which a Hide
  // operation switches the mask off, it masks nothing, as in render.js (maskVisibility.js):
  // the matte is then empty, and a copy of the masked layers without the matte shows on those
  // frames only. Its opacity switches with hold keyframes, at the same frames as the matte's.
  // A mask that is off on every frame adds the masked layers without a matte.
  // maskMode and maskInvert pick the matte type: 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted.
  const addMatte = (maskNode, addMasked, maskedName, parentMatrix, parentOpacity, target, domain, group = null) => {
    const { invert, mode } = maskStyle(maskNode.layer, group);
    const off = frameTimes.map((time) => maskSwitchedOff(maskNode.layer, time));
    if (off.every(Boolean)) {
      addMasked(target);
      return;
    }
    const maskContent = [], maskedContent = [];
    addLayer(maskNode, parentMatrix, parentOpacity, maskContent, domain);
    addMasked(maskedContent);
    const matte = compositionLayer(maskContent, maskNode.layer.name ?? "Mask", domain);
    const graphic = compositionLayer(maskedContent, maskedName, domain);
    matte.td = 1;
    graphic.tt = (mode === "alpha" ? 1 : 3) + (invert ? 1 : 0);
    graphic.tp = matte.ind;
    // An empty inverted matte already shows the masked layers whole.
    if (off.some(Boolean) && !invert) {
      const unmaskedContent = [];
      addMasked(unmaskedContent);
      const unmasked = compositionLayer(unmaskedContent, `${maskedName} (mask off)`, domain, { precompose: true });
      unmasked.ks.o = holdKeyframesAt(property(off.map((value) => (value ? 100 : 0))),
        visibilitySwitchFrames(off.map((value) => ({ visible: !value }))));
      // Pushed first, so it sits just below the masked layers and the matte stays right before them.
      target.push(unmasked);
    }
    // Layer arrays are reversed at serialization: the matte must precede its target.
    target.push(graphic, matte);
  };

  let addLayer;
  const addSiblings = (nodes, parentMatrix, parentOpacity, target = layers, domain = scene, maskGroup = false) => {
    // In a mask group, the bottom-most mask layer masks every visible layer above it, as in render.js.
    const groupMask = maskGroup ? nodes.findIndex((node) => node.layer.isMask) : -1;
    if (groupMask >= 0 && nodes[groupMask].layer.visible !== false) {
      addSiblings(nodes.slice(0, groupMask), parentMatrix, parentOpacity, target, domain);
      const above = nodes.slice(groupMask + 1);
      if (above.some((node) => node.layer.visible !== false)) {
        addMatte(nodes[groupMask], (content) => addSiblings(above, parentMatrix, parentOpacity, content, domain),
          "Masked layers", parentMatrix, parentOpacity, target, domain, maskGroup === true ? null : maskGroup);
      }
      return;
    }
    const visible = nodes.filter((node) => node.layer.visible !== false);
    for (let index = 0; index < visible.length; index += 1) {
      const node = visible[index];
      if (!node.layer.isMask) {
        addLayer(node, parentMatrix, parentOpacity, target, domain);
        continue;
      }
      const masked = visible[index + 1];
      if (!masked || masked.layer.isMask) throw new Error(`Mask layer “${node.layer.name ?? node.layer.id}” needs a following visible layer.`);
      addMatte(node, (content) => addLayer(masked, parentMatrix, parentOpacity, content, domain),
        masked.layer.name ?? "Masked layer", parentMatrix, parentOpacity, target, domain);
      index += 1;
    }
  };

  const applyEffects = (content, layer, states, matrices, visibleStates, { bounds, transformInChildren = false, contentOrigin = { x: 0, y: 0 } } = {}) => {
    const effects = lottieEffects(states, { property, colorToRgba });
    const fill = media.nativeEffectFills?.get(layer.id);
    if (fill) effects.unshift({ ty: 21, nm: "Duotone (equal colors)", ef: Array.from({ length: 7 }, (_, index) =>
      index === 2 ? { ty: 2, nm: "Color", v: property(fill.map((color) => colorToRgba(color).slice(0, 3).map((channel) => channel / 255)), 3) }
        : { ty: 0, nm: index === 6 ? "Opacity" : "", v: { a: 0, k: index === 6 ? 1 : 0 } }) });
    if (!effects.length) return content;
    const localBounds = bounds ?? compositionBounds([
      { layer: { ...layer, animations: [] }, children: [] },
    ], frameTimes, {
      sampleLayer: () => states, localMatrix: () => [1, 0, 0, 1, 0, 0],
      multiplyMatrix, fonts: fontRegistry, ignoreEffects: new Set([layer.id]),
    });
    const padding = Math.max(...states.map(effectPadding));
    const x = localBounds.x - padding, y = localBounds.y - padding;
    const width = Math.max(1, localBounds.width + padding * 2);
    const height = Math.max(1, localBounds.height + padding * 2);
    const refId = `effects_${nextIndex()}`;
    const localTransform = {
      a: { a: 0, k: [0, 0, 0] }, p: { a: 0, k: [-x, -y, 0] },
      s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
    };
    if (transformInChildren) {
      // Aligned strokes put their transform on each drawing and matte. Their
      // fresh asset can use padded local coordinates here, leaving the world
      // transform only on the outer effects layer. Sampling an inverse instead
      // would fail between frames when the scale changes or crosses zero.
      const matteAsset = assets.find((asset) => asset.id === content.refId);
      if (!matteAsset?.layers?.length) throw new Error("Aligned stroke effects require a vector composition.");
      matteAsset.w = width;
      matteAsset.h = height;
      for (const drawing of matteAsset.layers) drawing.ks = structuredClone(localTransform);
      content = { ...content, w: width, h: height };
      localTransform.p = { a: 0, k: [0, 0, 0] };
    }
    // Effects operate on local content before its world transform and opacity.
    // Transparent geometry reserves room for filters outside the visible paint.
    assets.push({ id: refId, w: width, h: height, layers: [
      { ...content, ks: localTransform },
      transparentEffectBounds(width, height, frameCount, nextIndex),
    ] });
    // Keep the source pivot and position tracks. Moving the padded bounds into
    // position samples would make rotation follow a chord between frames.
    const effectTransform = sampledTransform(layer, matrices, visibleStates,
      `Effects on “${layer.name ?? layer.id}”`);
    effectTransform.a = property(states.map((state) => [
      finite(state.width) / 2 - contentOrigin.x - x, finite(state.height) / 2 - contentOrigin.y - y, 0,
    ]), 3);
    return {
      ddd: 0, ind: nextIndex(), ty: 0, nm: layer.name ?? layer.type, refId,
      w: width, h: height, sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0, ef: effects,
      ks: effectTransform,
    };
  };

  const localTransform = (x = 0, y = 0) => ({
    a: { a: 0, k: [0, 0, 0] }, p: { a: 0, k: [x, y, 0] },
    s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  });

  // Paint a media/group box in its own coordinates. The content gets a rounded mask, while
  // the border remains outside it. One outer composition owns opacity, transform and effects.
  const styledBox = (node, states, worldMatrices, effectiveStates, imageLayer = null) => {
    const { layer } = node;
    const group = layer.type === "group";
    const clipped = !group || layer.clipContent;
    const width = Math.max(1, ...states.map((state) => Math.ceil(finite(state.width))));
    const height = Math.max(1, ...states.map((state) => Math.ceil(finite(state.height))));
    const childrenBounds = clipped ? { x: 0, y: 0, width, height }
      : compositionBounds(node.children, frameTimes, { sampleLayer: sample, localMatrix, multiplyMatrix, fonts: fontRegistry });
    const outset = Math.max(0, ...states.map((state) => Math.max(0, finite(state.strokeWidth)) *
      (state.strokeAlign === "inside" ? 0 : state.strokeAlign === "outside" ? 1 : 0.5)));
    const left = Math.floor(Math.min(-outset, childrenBounds.x));
    const top = Math.floor(Math.min(-outset, childrenBounds.y));
    const right = Math.ceil(Math.max(width + outset, childrenBounds.x + childrenBounds.width));
    const bottom = Math.ceil(Math.max(height + outset, childrenBounds.y + childrenBounds.height));
    const domain = { width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    const offset = localTransform(-left, -top);
    const content = [];
    const paint = (stroke) => {
      const paintStates = states.map((state) => ({ ...state, opacity: 1,
        ...(stroke ? { fillEnabled: false } : { strokeWidth: 0 }) }));
      const parts = lottieShapeParts({ ...layer, type: "rectangle" }, paintStates,
        `${layer.name ?? layer.type} ${stroke ? "border" : "background"}`, { property, colorToRgba });
      content.push(vectorLayer([parts], offset, {
        name: `${layer.name ?? layer.type} ${stroke ? "border" : "background"}`, frameCount, nextIndex,
        compose: (items, name) => compositionLayer(items, name, domain),
      }));
    };
    if (group && states.some(isFillEnabled)) paint(false);
    const identity = states.map(() => [1, 0, 0, 1, 0, 0]);
    const opaque = states.map(() => 1);
    if (clipped) {
      const inside = imageLayer ? [imageLayer] : [];
      if (group) addSiblings(node.children, identity, opaque, inside, { width, height }, layer.isMaskGroup === true && layer);
      const refId = `composition_${nextIndex()}`;
      assets.push({ id: refId, w: width, h: height, layers: inside.reverse() });
      content.push({ ddd: 0, ind: nextIndex(), ty: 0, nm: `${layer.name ?? layer.type} content`, refId,
        w: width, h: height, sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0,
        ks: offset, hasMask: true, masksProperties: [roundedBoxMask(states)] });
    } else {
      addSiblings(node.children, states.map(() => [1, 0, 0, 1, -left, -top]), opaque, content, domain, layer.isMaskGroup === true && layer);
    }
    if (states.some((state) => state.strokeWidth > 0)) paint(true);
    const refId = `composition_${nextIndex()}`;
    assets.push({ id: refId, w: domain.width, h: domain.height, layers: content.reverse() });
    const transform = sampledTransform(layer, worldMatrices, effectiveStates, `Box “${layer.name ?? layer.id}”`);
    // Moving the anchor preserves the original pivot between sampled frames, including a
    // rotating outside stroke. Moving sampled positions would interpolate a chord instead.
    transform.a = property(states.map((state) => [finite(state.width) / 2 - left, finite(state.height) / 2 - top, 0]), 3);
    return applyEffects({ ddd: 0, ind: nextIndex(), ty: 0, nm: layer.name ?? layer.type, refId,
      w: domain.width, h: domain.height, sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0, ks: transform },
    layer, states, worldMatrices, effectiveStates, { bounds: { x: 0, y: 0, ...domain }, contentOrigin: { x: left, y: top } });
  };

  const addLayerContent = (
    node,
    parentMatrix = Array.from({ length: frameCount + 1 }, () => [
      1, 0, 0, 1, 0, 0,
    ]),
    parentOpacity = Array(frameCount + 1).fill(1),
    target = layers,
    domain = scene,
  ) => {
    const { layer } = node;
    if (layer.visible === false) return;
    const states = sample(layer, frameTimes);
    const parentMatrices = states.map((_, index) => parentMatrix[index]);
    const worldMatrices = states.map((state, index) =>
      multiplyMatrix(parentMatrices[index], localMatrix(layer, state)),
    );
    const childOpacity = states.map(
      (state, index) => parentOpacity[index] * (state.visible === false ? 0 : clamp(state.opacity, 0, 1)),
    );
    if (layer.type === "group") {
      if (states.some((state) => isFillEnabled(state) || state.strokeWidth > 0)) {
        target.push(styledBox(node, states, worldMatrices, states.map((state, index) => ({ ...state, opacity: childOpacity[index] }))));
        return;
      }
      if (layer.clipContent) {
        const content = [];
        const identity = states.map(() => [1, 0, 0, 1, 0, 0]);
        const opaque = states.map(() => 1);
        const width = Math.max(1, ...states.map((state) => Math.ceil(finite(state.width))));
        const height = Math.max(1, ...states.map((state) => Math.ceil(finite(state.height))));
        addSiblings(node.children, identity, opaque, content, {width, height}, layer.isMaskGroup === true && layer);
        const refId = `composition_${nextIndex()}`;
        assets.push({id: refId, w: width, h: height, layers: content.reverse()});
        target.push(applyEffects({
          ddd: 0, ind: nextIndex(), ty: 0, nm: layer.name ?? "Clipped group", refId,
          w: width, h: height, sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0,
          ks: sampledTransform(layer, worldMatrices, states.map((state, index) => ({...state, opacity: childOpacity[index]})), `Group “${layer.name ?? layer.id}”`),
          hasMask: true, masksProperties: [roundedBoxMask(states)],
        }, layer, states, worldMatrices, states.map((state, index) => ({ ...state, opacity: childOpacity[index] })),
        { bounds: { x: 0, y: 0, width, height } }));
        return;
      }
      const bounds = compositionBounds(node.children, frameTimes, {sampleLayer: sample, localMatrix, multiplyMatrix, fonts: fontRegistry});
      const content = [];
      const offset = states.map(() => [1,0,0,1,-bounds.x,-bounds.y]);
      addSiblings(node.children, offset, states.map(() => 1), content, bounds, layer.isMaskGroup === true && layer);
      const refId = `composition_${nextIndex()}`;
      assets.push({id: refId, w: bounds.width, h: bounds.height, layers: content.reverse()});
      const matrices = worldMatrices.map((matrix) => multiplyMatrix(matrix, [1,0,0,1,bounds.x,bounds.y]));
      target.push(applyEffects({
        ddd: 0, ind: nextIndex(), ty: 0, nm: layer.name ?? "Group", refId,
        w: bounds.width, h: bounds.height, sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0,
        ks: sampledTransform(layer, matrices, states.map((state, index) => ({...state, opacity: childOpacity[index]})), `Group “${layer.name ?? layer.id}”`, [0,0]),
      }, layer, states, matrices, states.map((state, index) => ({ ...state, opacity: childOpacity[index] })),
      { bounds: { x: 0, y: 0, width: bounds.width, height: bounds.height } }));
      return;
    }
    if (layer.type === "audio" || layer.type === "video")
      throw new Error(
        `Lottie export does not support ${layer.type} layer “${layer.name ?? layer.id}”.`,
      );
    const effectiveStates = states.map((state, index) => ({
      ...state,
      opacity: childOpacity[index],
    }));
    const transform = sampledTransform(
      layer,
      worldMatrices,
      effectiveStates,
      `Layer “${layer.name ?? layer.id}”`,
    );
    if (layer.type === "text") {
      target.push(
        ...lottieTextLayers(
          layer,
          states[0],
          frameTimes,
          frameCount,
          fps,
          nextIndex,
          parentMatrices,
          parentOpacity,
          {sampleLayer: sample, localMatrix, multiplyMatrix, sampledTransform, property, colorToRgba, applyEffects, inlineImage,
            compose: (content, name, options) => compositionLayer(content, name, options?.domain ?? domain, options),
            warn: (warning) => { if (!warnings.some((known) => known.code === warning.code)) warnings.push(warning); }},
          fontRegistry,
        ),
      );
      return;
    }
    if (layer.type === "image") {
      const image = media.lottieImages.get(layer.id);
      if (!image)
        throw new Error(
          `Image layer “${layer.name ?? layer.id}” could not be embedded.`,
        );
      let assetId = imageAssetIds.get(image);
      if (!assetId) {
        assetId = `image_${imageAssetIds.size + 1}`;
        imageAssetIds.set(image, assetId);
        assets.push({ id: assetId, w: image.width, h: image.height, u: "", p: image.href, e: 1 });
      }
      const imageMatrices = states.map((state) =>
        multiplyMatrix(imageFitMatrix(state, image),
          [image.sourceWidth / image.width, 0, 0, image.sourceHeight / image.height, 0, 0]));
      const imageLayer = {
        ddd: 0,
        ind: nextIndex(),
        ty: 2,
        nm: layer.name ?? "Image",
        refId: assetId,
        sr: 1,
        ks: sampledTransform(layer, imageMatrices, states.map((state) => ({ ...state, opacity: 1, _lottieOpacity: null })), `Image “${layer.name ?? layer.id}”`, [0, 0]),
        ao: 0,
        ip: 0,
        op: frameCount,
        st: 0,
        bm: 0,
      };
      if (states.some((state) => state.strokeWidth > 0)) {
        target.push(styledBox(node, states, worldMatrices, effectiveStates, imageLayer));
        return;
      }
      const width = Math.max(1, ...states.map((state) => Math.ceil(finite(state.width))));
      const height = Math.max(1, ...states.map((state) => Math.ceil(finite(state.height))));
      const refId = `composition_${nextIndex()}`;
      assets.push({ id: refId, w: width, h: height, layers: [imageLayer] });
      target.push(applyEffects({
        ddd: 0, ind: nextIndex(), ty: 0, nm: layer.name ?? "Image", refId,
        w: width, h: height, sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0,
        ks: transform, hasMask: true, masksProperties: [roundedBoxMask(states)],
      }, layer, states, worldMatrices, effectiveStates));
      return;
    }
    if (!["rectangle", "ellipse", "star", "path"].includes(layer.type))
      throw new Error(
        `Lottie export does not support layer type “${layer.type}”.`,
      );
    const parts = lottieShapeParts(
      layer,
      states,
      `Layer “${layer.name ?? layer.id}”`,
      {property, colorToRgba},
    );
    target.push(applyEffects(vectorLayer([parts], transform, {
      name: layer.name ?? layer.type, frameCount, nextIndex,
      compose: (content, name) => compositionLayer(content, name, domain),
    }), layer, states, worldMatrices, effectiveStates, { transformInChildren: !!parts.matte }));
  };

  // Render a layer's full existing content first, then mask that composition in its parent
  // coordinate space. This keeps reveal clipping above text-unit transforms, rounded media/group
  // clips, strokes, and effects, while using the same sampled transform as the editor.
  addLayer = (
    node,
    parentMatrix = Array.from({ length: frameCount + 1 }, () => [1, 0, 0, 1, 0, 0]),
    parentOpacity = Array(frameCount + 1).fill(1),
    target = layers,
    domain = scene,
  ) => {
    const { layer } = node;
    if (layer.visible === false) return;
    const sequence = media.rasterEffects?.get(layer.id);
    if (sequence) {
      const bounds = sequence.bounds;
      if (bounds.width > DEFAULT_RASTER_SEQUENCE_LIMITS.maxSide || bounds.height > DEFAULT_RASTER_SEQUENCE_LIMITS.maxSide)
        throw new Error(`Lottie rasterization of layer “${layer.name ?? layer.id}” exceeds the local composition side limit (${DEFAULT_RASTER_SEQUENCE_LIMITS.maxSide}).`);
      const assetIds = media.rasterAssetIds ??= new Map();
      const images = [];
      for (const frame of sequence.frames) {
        const end = Math.min(frame.end, frameCount);
        if (frame.start >= end) continue;
        let assetId = assetIds.get(frame.assetKey);
        if (!assetId) {
          const image = sequence.assets.get(frame.assetKey);
          assetId = `effect_image_${assetIds.size + 1}`;
          assetIds.set(frame.assetKey, assetId);
          assets.push({ id: assetId, w: image.width, h: image.height, u: "", p: `data:image/png;base64,${image.buffer.toString("base64")}`, e: 1 });
        }
        images.push({ ddd: 0, ind: nextIndex(), ty: 2, nm: `${layer.name ?? layer.type} frame ${frame.start + 1}`,
          refId: assetId, sr: 1, ao: 0, ip: frame.start, op: end, st: 0, bm: 0,
          ks: { a: { a: 0, k: [0, 0, 0] }, p: { a: 0, k: [frame.bounds.x - bounds.x, frame.bounds.y - bounds.y, 0] },
            s: { a: 0, k: [frame.bounds.width / frame.width * 100, frame.bounds.height / frame.height * 100, 100] },
            r: { a: 0, k: 0 }, o: { a: 0, k: 100 } } });
      }
      const refId = `effect_sequence_${nextIndex()}`;
      assets.push({ id: refId, w: bounds.width, h: bounds.height, layers: images.reverse() });
      const states = sample(layer, frameTimes);
      const matrices = states.map((state, index) => multiplyMatrix(parentMatrix[index], localMatrix(layer, state)));
      // The raster already owns opacity, visibility, reveal, shadow and blur.
      // Ancestor opacity and the layer's transform remain native Lottie tracks.
      const transform = sampledTransform(layer, matrices, states.map((state, index) => ({ ...state, opacity: parentOpacity[index], _lottieOpacity: null })), `Raster layer “${layer.name ?? layer.id}”`);
      transform.a = property(states.map((state) => [finite(state.width) / 2 - bounds.x, finite(state.height) / 2 - bounds.y, 0]), 3);
      target.push({ ddd: 0, ind: nextIndex(), ty: 0, nm: layer.name ?? layer.type, refId,
        w: bounds.width, h: bounds.height, sr: 1, ao: 0, ip: 0, op: frameCount, st: 0, bm: 0, ks: transform });
      return;
    }
    const hasReveal = layer.reveal || enabledAnimations(layer.animations).some((animation) => animation.from?.reveal || animation.to?.reveal);
    const revealTimes = hasReveal ? revealSampleTimes(layer, frameTimes) : frameTimes;
    const states = sample(layer, revealTimes);
    if (!states.some((state) => state.reveal && state.reveal.progress < 1)) {
      addLayerContent(node, parentMatrix, parentOpacity, target, domain);
      return;
    }
    // A shaped or angled wipe, or one with an edge band (engine/wipe.js), is not written to Lottie yet.
    if (states.some((state) => isGeneralReveal(state.reveal) && state.reveal.progress < 1))
      throw new Error(`Lottie export draws only straight wipes up, down, left or right; layer “${layer.name ?? layer.id}” has a wipe with a shape, angle, center or edge band. Use PNG, video, or GIF export, or remove those wipe settings for Lottie.`);
    const frames = revealTimes.map((time) => lottieFramePosition(frameTimes, time));
    const matrices = states.map((state, index) => {
      const frame = frames[index], before = Math.min(frameCount, Math.floor(frame));
      const after = Math.min(frameCount, before + 1), progress = frame - before;
      const parent = parentMatrix[before].map((value, part) =>
        value + (parentMatrix[after][part] - value) * progress);
      return multiplyMatrix(parent, localMatrix(layer, state));
    });
    const content = [];
    addLayerContent(node, parentMatrix, parentOpacity, content, domain);
    if (!content.length) return;
    const wrapper = compositionLayer(content, `${layer.name ?? layer.type} reveal`, domain, { precompose: true });
    wrapper.hasMask = true;
    wrapper.masksProperties = [lottieRevealMask(states, matrices, domain, frames)];
    if (hasSoftReveal(states) && !warnings.some((warning) => warning.code === "lottie-reveal-softness")) {
      warnings.push({
        code: "lottie-reveal-softness",
        message: "Soft Wipe edges are exported as hard clips in Lottie; reveal timing and direction are preserved, but feathering is not.",
      });
    }
    target.push(wrapper);
  };

  addSiblings(sceneTree);
  const backgroundIsStaticSolid = isBackgroundEnabled(scene) && typeof scene.background === "string" &&
    !(Array.isArray(scene.backgroundAnimations) && scene.backgroundAnimations.length > 0);
  const bg = backgroundIsStaticSolid ? colorToRgba(scene.background ?? "transparent") : null;
  if (bg && bg[3] > 0) {
    const bgShape = {
      ty: "gr",
      it: [
        {
          ty: "rc",
          d: 1,
          p: { a: 0, k: [dimensions.width / 2, dimensions.height / 2] },
          s: { a: 0, k: [dimensions.width, dimensions.height] },
          r: { a: 0, k: 0 },
          nm: "Background rectangle",
          hd: false,
        },
        {
          ty: "fl",
          c: { a: 0, k: bg.slice(0, 3).map((channel) => channel / 255) },
          o: { a: 0, k: bg[3] * 100 },
          r: 1,
          bm: 0,
          nm: "Background fill",
          hd: false,
        },
        {
          ty: "tr",
          p: { a: 0, k: [0, 0] },
          a: { a: 0, k: [0, 0] },
          s: { a: 0, k: [100, 100] },
          r: { a: 0, k: 0 },
          o: { a: 0, k: 100 },
          sk: { a: 0, k: 0 },
          sa: { a: 0, k: 0 },
          nm: "Transform",
        },
      ],
      nm: "Background",
      np: 3,
      cix: 2,
      bm: 0,
      ix: 1,
      mn: "ADBE Vector Group",
      hd: false,
    };
    layers.unshift({
      ddd: 0,
      ind: nextIndex(),
      ty: 4,
      nm: "Background",
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [0, 0, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [bgShape],
      ip: 0,
      op: frameCount,
      st: 0,
      bm: 0,
    });
  }
  if (isBackgroundEnabled(scene) && !backgroundIsStaticSolid) {
    const backgroundLayers = [];
    addLayer({ layer: backgroundLayer(scene), children: [] }, undefined, undefined, backgroundLayers, scene);
    layers.unshift(...backgroundLayers);
  }
  return {
    v: "5.12.2",
    fr: fps,
    ip: 0,
    op: frameCount,
    w: Math.round(finite(scene.width)),
    h: Math.round(finite(scene.height)),
    nm: String(scene.name ?? "kino"),
    ddd: 0,
    assets,
    layers: layers.reverse(),
    markers: [],
  };
}

function outputDimensions(scene, options) {
  const dimensions = getOutputSize(scene, options);
  return dimensions;
}

// Whether every pixel of every frame is opaque: the scene's background is on and is one colour
// with full alpha that no animation changes. Layers are drawn over it and no blend mode erases,
// so they cannot make it see-through. A gradient or any colour this cannot read counts as maybe
// see-through.
function backgroundIsOpaque(scene) {
  if (!isBackgroundEnabled(scene)) return false;
  if (Array.isArray(scene.backgroundAnimations) && scene.backgroundAnimations.length > 0) return false;
  return colorToRgba(scene.background ?? "#ffffff")?.[3] === 1;
}

// The sounds an export can hear: they start before its end and are not muted.
function audibleClips(audioInputs, duration) {
  return audioInputs.filter((audio) => audio.start < duration && audio.volume > 0);
}

// The FFmpeg filter that numbers sound timestamps from the sample count (N samples so far, SR
// samples a second, TB seconds a tick), rounded to whole ticks (see audioMixGraph).
const SAMPLE_TIMES = "asetpts=round(N/SR/TB)";

// How many seconds of a clip play in an export `duration` seconds long.
function clipLength(audio, duration) {
  return Math.min(audio.duration > 0 ? audio.duration : duration, duration - audio.start);
}

// The FFmpeg inputs that audioMixGraph reads: every clip's file, then the volume track of each
// clip that has one (volume-track.mjs), in clip order.
function audioInputArgs(clips) {
  return [
    ...clips.flatMap((audio) => ["-i", audio.path]),
    ...clips.filter((audio) => audio.volumeTrack).flatMap((audio) => volumeTrackInput(audio.volumeTrack)),
  ];
}

/**
 * The FFmpeg filter graph that sums an export's sound, from the inputs audioInputArgs lists.
 * `firstInput` is the FFmpeg input number of the first clip. The last filter's output has no
 * name, so callers add their own filters.
 */
function audioMixGraph(clips, duration, format, firstInput) {
  let nextTrack = firstInput + clips.length;
  const filters = clips.map((audio, index) => {
    const clipDuration = clipLength(audio, duration);
    const delay = Math.round(audio.start * 1000);
    // Web Audio copies mono into both stereo channels. FFmpeg's automatic
    // remix instead attenuates each channel, changing the exported volume.
    const toStereo = format === "mp4" && audio.channels === 1;
    const channels = toStereo ? "pan=stereo|c0=c0|c1=c0," : "";
    // atrim reads the source from the Play offset; adelay inserts silence until the Play start.
    // FFmpeg gives adelay's inserted silence invalid timestamps after asetpts, and the final
    // atrim then drops the clip, so timestamps are renumbered from the sample count. SAMPLE_TIMES
    // rounds them: FFmpeg cuts N/SR/TB down to a whole number, so past about a minute some come
    // out one sample early, and the master limiter turned that into a 5 ms gap that AAC filled
    // with silence (all the sound after it 5 ms late).
    const source = `[${index + firstInput}:a:0]${channels}atrim=start=${audio.offset ?? 0}:duration=${clipDuration},asetpts=PTS-STARTPTS` +
      (audio.voiceChain ? `,${audio.voiceChain}` : "") + levelFilters(audio) + lowpassFilters(audio.lowpass);
    const placed = `adelay=${delay}:all=1,${SAMPLE_TIMES}[a${index}]`;
    if (!audio.volumeTrack) return `${source},volume=${audio.volume},${placed}`;
    // A Volume animation: the volume track is resampled to the clip's sample rate (a smooth
    // curve through its samples), copied into each of the clip's channels, and multiplied with
    // the clip sample by sample.
    const count = toStereo ? 2 : audio.channels;
    const copies = Array.from({ length: count }, (_, channel) => `c${channel}=c0`).join("|");
    const track = `[${nextTrack++}:a:0]aresample=${audio.volumeTrack.sampleRate},pan=${count}c|${copies}[v${index}]`;
    return `${source}[s${index}];${track};[s${index}][v${index}]amultiply,${placed}`;
  });
  const sources = clips.map((_, index) => `[a${index}]`).join("");
  filters.push(`${sources}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${duration}`);
  return filters.join(";");
}

// A spoken clip's leveling: one gain, or one per line (enabled from the middle of the pause before
// it to the middle of the pause after, on the clip's own clock).
function levelFilters(audio) {
  if (audio.levelLines?.length) {
    return audio.levelLines.map(({ from, to, gain }) => {
      const when = [Number.isFinite(from) ? `gte(t,${from})` : null, Number.isFinite(to) ? `lt(t,${to})` : null].filter(Boolean).join("*") || "1";
      return `,volume=${gain}dB:enable='${when}'`;
    }).join("");
  }
  return audio.levelDb ? `,volume=${audio.levelDb}dB` : "";
}

// The FFmpeg arguments that encode an export's sound (MP4 needs its resolved encoder in `options`).
// The trial encodes that fit the master limiter use the same ones, so they measure the same sound.
function audioCodecArgs(format, options) {
  if (format === "mp4") return mp4AudioArgs(options.mp4Encoder, options.mp4AacCodec);
  if (format === "webm") return ["-c:a", "libopus"];
  return ["-c:a", "pcm_s16le"];
}

/**
 * Prepares the master limiter before the export encodes its sound. It measures the mix (after
 * ducking and every Volume animation) without the limiter, brings it to the `options.loudness`
 * target when one is set, then fits the limiter's ceiling to this format's sound encoder
 * (audio-levels.mjs). Without a target, a mix that would have clipped gets a warning with its
 * loudest moment and the sounds playing there, so their volumes can be lowered. Returns { ceiling, loudness, warning }:
 * `loudness` is the gain filter used (loudnessGain), or null.
 */
async function planMasterLimiter(audioInputs, duration, format, options, directory, signal) {
  const clips = audibleClips(audioInputs, duration);
  const inputs = audioInputArgs(clips);
  const graph = audioMixGraph(clips, duration, format, 0);
  const levels = await measureMixLevels(inputs, graph, signal);
  const sound = await fitLoudness(inputs, graph, levels, options.loudness, { codecArgs: audioCodecArgs(format, options), format, directory, signal });
  const { loudness } = sound;
  // A clip with a Volume animation is named with its volume at the loudest moment.
  const named = clips.map((clip) => clip.volumeTrack && levels.loudestAt !== null
    ? { ...clip, volume: trackVolumeAt(clip, levels.loudestAt) } : clip);
  // With a loudness target, kino's own gain sets the peaks: lowering clip volumes would be undone by
  // the next render's gain, and the limiter takes at most 6 dB off them (past that, the gain holds
  // and the file comes out quieter). Sound that still clips after encoding is warned about by the file checks.
  return { ceiling: sound.ceiling, loudness, warning: loudness ? null : loudMixWarning(levels, named, sound) };
}

function encodeArgs(
  format,
  fps,
  frameCount,
  directory,
  output,
  audioInputs = [],
  duration = frameCount / fps,
  options = {},
) {
  const input = options.pipeInput ? "pipe:0" : join(directory, "frame-%06d.png");
  // Piped frames are PNG files, or straight RGBA pixels when rawFrameSize ("1920x1080") is given.
  let inputFormat = [];
  if (options.pipeInput && options.rawFrameSize) inputFormat = ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", options.rawFrameSize];
  else if (options.pipeInput) inputFormat = ["-f", "image2pipe", "-vcodec", "png"];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    // An MP4 hardware encoder may open its device first (QSV, VA-API: mp4-encoders.mjs).
    ...(format === "mp4" ? mp4InputArgs(options.profile === "mp4.alt" ? "mp4.alt" : options.mp4Encoder, options) : []),
    ...inputFormat,
    "-framerate",
    ffmpegRate(fps),
    "-i",
    input,
  ];
  const usableAudio = audibleClips(audioInputs, duration);
  args.push(...audioInputArgs(usableAudio));
  args.push(
    "-frames:v",
    String(frameCount),
    "-t",
    String(duration),
    "-map",
    "0:v:0",
  );
  if (usableAudio.length) {
    // The loudness gain and the master limiter, as planMasterLimiter fitted them, bring the summed
    // sound to its target and keep it from clipping.
    const gain = options.loudnessFilter ? `${options.loudnessFilter},` : "";
    const graph = `${audioMixGraph(usableAudio, duration, format, 1)},${gain}${masterLimiter(options.limiterCeiling)}[audio]`;
    args.push("-filter_complex", graph, "-map", "[audio]");
  } else args.push("-an");
  if (format === "mp4")
    return [
      ...args,
      ...(options.profile === "mp4.alt"
        ? mp4FallbackEncodingArgs({ hasAudio: usableAudio.length > 0 })
        : mp4EncodingArgs(options.mp4Encoder, { ...options, hasAudio: usableAudio.length > 0 })),
      output,
    ];
  if (format === "webm")
    return [
      ...args,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      options.transparent ? "yuva420p" : "yuv420p",
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      ...(usableAudio.length ? audioCodecArgs(format, options) : []),
      "-f",
      "webm",
      output,
    ];
  if (format === "mov")
    return [
      ...args,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-pix_fmt",
      "yuva444p10le",
      ...(usableAudio.length ? audioCodecArgs(format, options) : []),
      "-f",
      "mov",
      output,
    ];
  if (format === "gif") {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...inputFormat,
      "-framerate",
      ffmpegRate(fps),
      "-i",
      input,
      "-filter_complex",
      `split[s0][s1];[s0]palettegen=stats_mode=diff:reserve_transparent=${options.transparent ? 1 : 0}[p];[s1][p]paletteuse=dither=${options.transparent ? "bayer:bayer_scale=5" : "sierra2_4a"}`,
      "-loop",
      options.loop === false ? "-1" : "0",
      "-f",
      "gif",
      output,
    ];
  }
  // Raw pixels always carry alpha, so FFmpeg would make an RGBA APNG. When every frame is opaque
  // (opaqueFrames), ask for RGB instead: the same picture in a file about 8% smaller for 1080p fog
  // or light-leaks, which FFmpeg writes about 3 times faster. A movie whose frames may be
  // see-through keeps RGBA, as Chromium's PNG files of them had.
  const apngPixels = options.rawFrameSize && options.opaqueFrames ? ["-pix_fmt", "rgb24"] : [];
  if (format === "apng") return [
    ...args, "-c:v", "apng", ...apngPixels, "-plays", options.loop === false ? "1" : "0", "-f", "apng", output,
  ];
  throw new Error(`Unsupported video export format “${format}”.`);
}

// The sample rate of the first sound stream, for a clip's volume track (volume-track.mjs).
async function audioSampleRate(path, signal) {
  const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";
  const result = await runProcess(ffprobe,
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path], signal);
  const rate = Number.parseInt(result, 10);
  if (!(rate > 0)) throw new Error(`Could not read the sample rate of ${basename(path)}.`);
  return rate;
}

async function audioChannelCount(path, signal) {
  const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";
  const result = await runProcess(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=channels",
      "-of",
      "csv=p=0",
      path,
    ],
    signal,
  );
  return Number.parseInt(result, 10) || 0;
}

async function webmDecoderArgs(path, signal) {
  const result = await runProcess(
    process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:stream_tags=alpha_mode", "-of", "json", path],
    signal,
  );
  const stream = JSON.parse(result).streams?.[0];
  // Muxers write the tag as alpha_mode or ALPHA_MODE (some WebM files use the latter).
  const alphaMode = Object.entries(stream?.tags ?? {}).find(([name]) => name.toLowerCase() === "alpha_mode")?.[1];
  if (String(alphaMode) !== "1") return [];
  // FFmpeg's native VP8/VP9 decoders discard WebM's auxiliary alpha stream.
  if (stream.codec_name === "vp9") return ["-c:v", "libvpx-vp9"];
  if (stream.codec_name === "vp8") return ["-c:v", "libvpx"];
  return [];
}

// An open-ended video Play (duration 0) runs until the video ends; as a still image it needs a
// finite duration that outlasts any export, because image layers only play with a duration.
const OPEN_PLAY_SECONDS = 1e9;

/** In Lottie a video becomes one still image that keeps the video's Play visibility. */
function lottieVideoStill(layer) {
  return {
    ...layer,
    type: "image",
    // The source editor fits videos with contain; ordinary image layers use cover.
    lottieFitMode: "contain",
    mediaDuration: layer.mediaDuration > 0 ? layer.mediaDuration : OPEN_PLAY_SECONDS,
    // Videos saved before Freeze existed hold their first and last frames.
    mediaFreeze: layer.mediaFreeze ?? "both",
  };
}

/**
 * The third argument also takes two internal options that only tests pass:
 * `gifSlots` replaces the process-wide GIF decode limit (gif-decode-slots.mjs), and
 * `videoLimits` lowers the video frame extraction caps (VIDEO_LIMITS), and `flowCacheDir`
 * keeps mediaInterpolation "flow" proxies in another folder than the data folder's cache/flow.
 */
/**
 * Renders a scene at several times and returns each frame's RGBA pixels:
 * [{time, width, height, pixels}] (4 bytes a pixel, row by row). Media is prepared once for
 * all the times. `width` is the frame width in pixels (default 480). The quality checker
 * (backend/agent/quality.mjs) uses it to measure contrast and flashing.
 */
export async function renderSceneFrames(scene, times, context = {}) {
  // Counted as a running render (render-activity.mjs), unless background work asked for it.
  const ended = isBackground() ? null : renderStarted();
  try { return await renderSceneFramesNow(scene, times, context); } finally { ended?.(); }
}

/**
 * The PNG stills exportScene draws one call at a time ({format: "png", time, width, height}), at
 * several times in one call: [{time, buffer}]. Media is prepared once for all the times (a video
 * that several times show is decoded in one FFmpeg run) and one Chromium draws them all, so a look
 * sheet of 16 tiles starts FFmpeg and Chromium once, not 16 times.
 */
export async function renderStills(scene, times, context = {}) {
  const ended = isBackground() ? null : renderStarted();
  try { return await renderStillsNow(scene, times, context); } finally { ended?.(); }
}

async function renderStillsNow(given, times, { width, height, mediaRoot, fonts: providedFonts, render, signal, previewBlur = false } = {}) {
  // Look draws a morph cut as the live preview does: a dissolve, without the flow (morphCut.js).
  const scene = morphDissolveScene(given, speechPieces);
  checkScene(scene);
  const duration = scene.duration ?? 1;
  if (!Array.isArray(times) || !times.length || times.length > 600) throw new Error("Give 1 to 600 still times.");
  for (const time of times) assertStillFrameTime(time, duration);
  const fps = 30;
  const options = { format: "png", width, ...(height ? { height } : {}), ...normalizeRenderQuality({}), fps, duration: Math.max(1 / fps, finite(duration, 1)) };
  const fonts = providedFonts || await loadBundledFonts();
  const dimensions = outputDimensions(scene, options);
  let rasterizer, starting;
  const directory = await makeTempFolder("kino-frames-");
  try {
    starting = startCheckRasterizer(scene, directory, signal, render);
    const media = await prepareMedia(scene, options, mediaRoot, {
      directory, format: "png", fps, frameTimes: times, samples: times, dimensions, signal, warnings: [], videoLimits: VIDEO_LIMITS, morph: false,
    });
    rasterizer = await starting;
    const stills = [];
    for await (const { index, buffer } of orderedFrames(times, (time) =>
      renderQualityFrame(scene, time, media, fonts, dimensions, options, { design: false, rasterizer, signal, draft: true, previewBlur }), signal))
      stills.push({ time: times[index], buffer });
    return stills;
  } finally {
    rasterizer ??= await starting?.catch(() => null);
    await rasterizer?.close();
    await removeTempFolder(directory);
  }
}

async function renderSceneFramesNow(given, times, { mediaRoot, fonts: providedFonts, width = 480, signal, render, checkCache = checkPictures } = {}) {
  // Check draws a morph cut as the live preview does: a dissolve, without the flow (morphCut.js).
  const scene = morphDissolveScene(given, speechPieces);
  checkScene(scene);
  if (!Array.isArray(times) || !times.length || times.length > 600 || times.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0))
    throw new Error("Give 1 to 600 frame times of 0 seconds or more.");
  const fonts = providedFonts || await loadBundledFonts();
  const dimensions = outputDimensions(scene, { format: "png", width });
  let rasterizer, starting;
  const directory = await makeTempFolder("kino-frames-");
  try {
    // Chromium starts while FFmpeg prepares the media. `render` is the dashboard's machine
    // settings, as for exportScene: the card that draws.
    starting = startCheckRasterizer(scene, directory, signal, render);
    const media = await prepareMedia(scene, { format: "png" }, mediaRoot, {
      directory, format: "png", fps: 30, frameTimes: times, dimensions, signal, warnings: [], checkCache, morph: false,
    });
    rasterizer = await starting;
    // The next frame's SVG is made while Chromium draws this one (orderedFrames keeps one ahead).
    const frames = [];
    for await (const { index, ...frame } of orderedFrames(times, (time) => renderPng(scene, time, media, fonts, dimensions, { raw: true, rasterizer, signal, draft: true }), signal))
      frames.push({ time: times[index], ...frame });
    return frames;
  } finally {
    rasterizer ??= await starting?.catch(() => null);
    await rasterizer?.close();
    await removeTempFolder(directory);
  }
}

// The one Chromium worker of a check or look render (null when the scene needs none), started
// before its media is prepared so the two overlap.
function startCheckRasterizer(scene, directory, signal, render) {
  if (!sceneNeedsChromium(scene)) return null;
  const starting = createChromiumRasterizer({ directory: join(directory, "chromium"), mediaDirectory: directory, signal,
    workers: 1, graphics: renderSettings(render).graphics, claim: claimRasterWorkers(1) });
  // Observed now: prepareMedia may fail first, and the finally block then closes the worker.
  starting.catch(() => {});
  return starting;
}

export async function exportScene(scene, options = {}, context = {}) {
  // Counted as a running render (render-activity.mjs), unless background work asked for it.
  const ended = isBackground() ? null : renderStarted();
  try { return await exportSceneNow(scene, options, context); } finally { ended?.(); }
}

async function exportSceneNow(
  scene,
  options = {},
  { onProgress, signal, mediaRoot, fonts: providedFonts, outputPath, sequenceDirectory, gifSlots, videoLimits, flowCacheDir, rasterWorkers, render, frameRange, silent = false, previewBlur = false } = {},
) {
  checkScene(scene);
  // The machine settings from the dashboard ({ graphics, framesAtOnce, keepFreePercent }): which
  // card draws, how many frames at once and how much memory to leave free. They are not export
  // options, so they do not change what the file is asked to be.
  const machine = renderSettings(render);
  aborted(signal);
  if (options.profile) {
    const profile = exportProfile(options.profile);
    options = { ...options, format: profile.format, transparent: Boolean(profile.transparent) };
  }
  const requestedDuration = options.duration ?? scene.duration ?? 1;
  if (typeof requestedDuration !== "number" || !Number.isFinite(requestedDuration) || requestedDuration <= 0 || requestedDuration > MAX_TIME)
    throw new Error(`Export duration must be greater than zero and at most ${MAX_TIME} seconds.`);
  const format = String(options.format ?? "png").toLowerCase();
  // Without motionSamples, each frame draws as many as its fastest move needs (frameMotionSamples).
  options = { ...options, format, ...normalizeRenderQuality(options), autoMotionSamples: options.motionSamples === undefined };
  const info = FORMAT_INFO[format];
  if (!info) throw new Error(`Unsupported export format “${format}”.`);
  // A still renders one frame at this time; other formats render every frame and ignore it.
  // `design: true` asks a still for the design view instead (the Design canvas), which has no time.
  const stillTime = options.time === undefined ? 0 : options.time;
  if (format === "png") assertStillFrameTime(stillTime, requestedDuration);
  assertStillDesign(options.design, format);
  const design = options.design === true;
  // A draft render draws tilted layers as check and look frames do (render.js triangleTiltTag): the
  // grid's error in output pixels and no triangles wholly off screen. A tilted 3D plane drew up to
  // 60 s a frame at 960x540 under Resvg with the full grid (a product trailer's tilted app screen), about 9 s
  // with this. Final renders keep the full grid.
  const draft = options.renderQuality === "draft";
  const warnings = [];
  let exportFacts = {};
  if (format === "lottie" && scene.layers.some((layer) => layer.type === "audio")) {
    warnings.push({ code: "lottie-audio-omitted", message: "This file includes audio, but audio can't be exported to Lottie." });
    scene = { ...scene, layers: scene.layers.filter((layer) => layer.type !== "audio") };
  }
  if (format === "lottie") {
    const rendered = visibleLayerIds(scene);
    if (scene.layers.some((layer) => rendered.has(layer.id) && layer.blendMode && layer.blendMode !== "normal"))
      warnings.push({ code: "lottie-blend-mode-normalized", message: 'At least one layer uses a blending other than "normal". These layers have been exported with the "normal" blending.' });
  }
  if (sequenceDirectory !== undefined) {
    if (format !== "png-sequence") {
      throw new Error("A sequence directory can only be used for PNG sequence exports.");
    }
    if (typeof sequenceDirectory !== "string" || sequenceDirectory.length === 0) {
      throw new TypeError("PNG sequence directory path is required.");
    }
    await validateSequenceDirectory(sequenceDirectory);
  }
  const fonts = providedFonts || await loadBundledFonts();
  const missing = missingDocumentFonts({ scenes: [scene] }, fonts);
  if (missing.length) {
    const names = missing.slice(0, 8).map((entry) =>
      `“${entry.fontFamily.slice(0, 60)}” (${entry.fontWeight} ${entry.fontStyle}) uses ${entry.fallbackFamily.slice(0, 60) || "an available font"}`);
    warnings.push({ code: "missing-font-fallback", message: `Unavailable fonts: ${names.join("; ")}.${missing.length > 8 ? ` ${missing.length - 8} additional font references use fallback faces.` : ""} Replace or upload the originals to restore their appearance.` });
  }
  const glyphProblems = documentGlyphProblems({ scenes: [scene] }, fonts);
  if (glyphProblems.length) warnings.push({ code: "missing-glyphs", message: `Missing characters are shown as boxes in ${glyphProblems.length} text layer(s): ${glyphProblems.slice(0, 8)
    .map((problem) => `“${String(problem.name ?? problem.layerId).slice(0, 60)}” (${problem.glyphs.slice(0, 6).map((glyph) => JSON.stringify(glyph.text.slice(0, 32))).join(", ")})`).join("; ")}. Connect to download fallback fonts or choose a font containing those characters.` });
  // Chromium export workers that stopped while the export carried on (createChromiumRasterizer
  // onWorkerStopped): one warning that counts them and names the first reason and frames.
  const stoppedWorkers = { count: 0, frames: [], firstReason: "", warning: null };
  const workerStopped = ({ reason, label }) => {
    stoppedWorkers.count += 1;
    if (label && stoppedWorkers.frames.length < 3) stoppedWorkers.frames.push(label);
    if (!stoppedWorkers.warning) {
      stoppedWorkers.firstReason = String(reason?.message ?? "").slice(0, 300);
      warnings.push(stoppedWorkers.warning = { code: "chromium-worker-stopped", message: "" });
    }
    const { count, frames, firstReason, warning } = stoppedWorkers;
    warning.message = `A Chromium export worker stopped ${count === 1 ? "once" : `${count} times`} and the export carried on${frames.length ? `, drawing again ${frames.join("; ")}` : ""}. First reason: ${firstReason}`;
  };
  // Every result carries `warnings` when there are any, in a fixed order.
  const warningDetails = () => {
    const order = ["missing-media", "lottie-media-first-frame", "lottie-video-first-frame", "lottie-gif-first-frame", "lottie-audio-omitted", "lottie-blend-mode-normalized", "lottie-image-clamped", "lottie-counter-effects-simplified", "lottie-reveal-softness", "lottie-effect-rasterized"];
    warnings.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    return warnings.length ? { warnings } : {};
  };
  // What Chromium drew with, once it has drawn (render-devices.mjs graphicsReport): the result's
  // `graphics`, and a warning when the setting asked for the card but the processor drew while
  // this computer has a card (the cards are looked up only then; a server without one, such as
  // CI, gets no warning).
  const noteGraphics = async () => {
    if (!rasterizer?.renderers || exportFacts.graphics) return;
    const facts = { setting: machine.graphics, renderers: rasterizer.renderers(), workers: rasterizer.memory?.().workers };
    let { graphics, warning } = graphicsReport(facts);
    if (warning) ({ warning } = graphicsReport({ ...facts, cards: (await listGraphics()).cards }));
    exportFacts = { ...exportFacts, graphics };
    if (warning) warnings.push(warning);
  };
  const finishBuffer = async (buffer) => {
    await noteGraphics();
    const encoder = format === "mp4" ? { mp4Encoder: options.mp4Encoder, videoEncoder: mp4VideoEncoderFacts(options) } : {};
    const details = { ...warningDetails(), ...exportFacts, ...(format === "lottie" ? { gzipSize: gzipSync(buffer).length } : {}) };
    if (outputPath) {
      const temporary = join(dirname(outputPath), `.kino-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, buffer, { signal, mode: 0o600, flag: "wx" });
        aborted(signal);
        await rename(temporary, outputPath);
      } finally { await rm(temporary, { force: true }); }
      return { path: outputPath, mime: info.mime, extension: info.extension, ...encoder, ...details };
    }
    return { buffer, mime: info.mime, extension: info.extension, ...encoder, ...details };
  };
  if (options.transparent && !["webm", "mov", "gif", "png", "apng", "png-sequence", "lottie"].includes(format))
    throw new Error("This export format does not support transparency.");
  if (options.transparent != null && typeof options.transparent !== "boolean") throw new Error("Export transparency must be true or false.");
  if (options.loop != null && typeof options.loop !== "boolean") throw new Error("Export loop must be true or false.");
  if (options.loop != null && !["gif", "apng"].includes(format)) throw new Error("Loop settings are available for GIF and APNG exports.");
  if (options.quality != null && (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100))
    throw new Error("GIF quality must be an integer between 1 and 100.");
  if (options.quality != null && (format !== "gif" || options.transparent || options.gifEncoder === "ffmpeg"))
    throw new Error("Quality is available for the standard GIF encoder.");
  if (options.gifEncoder != null && !["gifski", "ffmpeg"].includes(options.gifEncoder))
    throw new Error("Unknown GIF encoder.");
  if (options.gifEncoder != null && format !== "gif") throw new Error("GIF encoder settings apply only to GIF exports.");
  if (options.mp4Encoder != null && format !== "mp4") throw new Error("MP4 encoder settings apply only to MP4 exports.");
  if (options.mp4Encoder != null && options.profile === "mp4.alt") throw new Error("The MP4 fallback uses its own encoder settings.");
  // Requests are checked before (export-batches.mjs); kino's own draft quality is allowed here.
  checkVideoEncoderOptions(options, format, { draft: true });
  if (options.imageDPIRatio != null && format !== "lottie") throw new Error("Image resolution applies only to Lottie exports.");
  if (options.imageDPIRatio != null && !["1x", "2x", "3x", "original"].includes(options.imageDPIRatio))
    throw new Error("Lottie image resolution must be 1x, 2x, 3x, or original.");
  if (options.transparent) scene = withoutBackground(scene);
  const dimensions = outputDimensions(scene, options);
  // 29.97 and "30000/1001" are read here too (frameRate.js); from here on fps is frames a second.
  const fps = readFps(options.fps ?? (format === "lottie" ? 60 : 30), (message) => new Error(`Export frame rate: ${message}`));
  if (options.fps != null) options = { ...options, fps };
  if (format === "mp4") {
    const encoder = options.profile === "mp4.alt"
      ? await resolveMp4Fallback({ ...dimensions, fps }, { signal })
      : await resolveMp4Encoder(options.mp4Encoder, { ...dimensions, fps }, { signal, videoEncoder: options.videoEncoder ?? "auto" });
    // mp4Family is the encoder family "Hw" means here, or "software"; mp4Device is the render node
    // QSV or VA-API opens; mp4SoftwareReason says why hardware could not encode this file (mp4-encoders.mjs).
    options = { ...options, ...dimensions, mp4Encoder: encoder.id, mp4AacCodec: encoder.aacCodec, mp4Family: encoder.family,
      ...(encoder.device ? { mp4Device: encoder.device } : {}), ...(encoder.reason ? { mp4SoftwareReason: encoder.reason } : {}),
      ...(encoder.id === "mp4.alt" ? { profile: "mp4.alt" } : {}) };
    aborted(signal);
  }
  const report = typeof onProgress === "function" ? onProgress : () => {};
  const duration = Math.max(
    1 / fps,
    finite(options.duration, finite(scene.duration, 1)),
  );
  let frameTimes = exportFrameTimes(duration, fps, { format, playbackDirection: options.playbackDirection });
  // `frameRange` {first, count} (preview-segments.mjs): only these frames of the scene's frame
  // grid, drawn at their own scene times, so a stretch of the scene is a short video of its own.
  // `silent` leaves every sound out.
  if (frameRange !== undefined) {
    const { first, count } = frameRange ?? {};
    if (!["mp4", "webm", "mov"].includes(format)) throw new Error("A frame range applies only to video exports.");
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 1 || first >= frameTimes.length)
      throw new RangeError("A frame range needs a first frame inside the scene and a count of 1 or more.");
    frameTimes = frameTimes.slice(first, first + count);
  }
  const frameCount = frameTimes.length;
  // A PNG sequence ZIP (png-sequence.mjs, zip.mjs) holds at most 65,535 frames: refused here,
  // before any frame is drawn, rather than after a long scene is rendered.
  if (format === "png-sequence" && !sequenceDirectory && frameCount > PNG_ZIP_MAX_FRAMES)
    throw new RangeError(`A PNG sequence ZIP holds at most ${PNG_ZIP_MAX_FRAMES} frames; ${secondsText(duration)} at ${fps} fps is ${frameCount}. Use at most ${Math.floor(PNG_ZIP_MAX_FRAMES / duration)} fps, a shorter scene, or a video format.`);
  const lottieTimes = format === "lottie" ? Array.from({ length: frameCount + 1 }, (_, index) =>
    Math.min(frameCount / fps, exportFrameTime(index, fps))) : null;
  const effectPlan = format === "lottie" ? planLottieEffects(scene, lottieTimes) : null;
  const particleProblem = format === "lottie" ? lottieParticleProblem(scene, { times: lottieTimes, fps,
    density: options.imageDPIRatio === "original" ? 1 : Number.parseInt(options.imageDPIRatio ?? "3x", 10) }) : null;
  if (particleProblem) throw new Error(particleProblem);
  if (effectPlan?.targets.length * frameCount > DEFAULT_RASTER_SEQUENCE_LIMITS.maxSamples) {
    const target = effectPlan.targets[Math.min(effectPlan.targets.length - 1,
      Math.floor(DEFAULT_RASTER_SEQUENCE_LIMITS.maxSamples / frameCount))];
    throw new Error(`Lottie rasterization of ${target.effects.join(", ")} on layer “${target.name}” exceeds the maxSamples limit (${DEFAULT_RASTER_SEQUENCE_LIMITS.maxSamples}). Reduce duration, frame rate, or the number of affected layers.`);
  }
  const lottieMediaScene = effectPlan?.coveredIds.size
    ? { ...scene, layers: scene.layers.filter((layer) => !effectPlan.coveredIds.has(layer.id)) } : scene;
  const directory = await makeTempFolder("kino-export-");
  const output = join(directory, `result.${info.extension}`);
  let rasterizer;
  const exportSignal = signal;
  const renderController = new AbortController();
  signal = signal ? AbortSignal.any([signal, renderController.signal]) : renderController.signal;
  // Video pictures of a long export, extracted a window of frames at a time (videoPictureWindows).
  let pictureWindows = null;
  try {
    const shownTimes = format === "png" ? [stillTime] : frameTimes;
    // The times each output frame's pictures are drawn at: with motion blur, its shutter samples.
    const samplesFor = (times) => options.motionBlur && format !== "lottie" ? shutterSamples(times, duration, fps, options.motionBlur,
      (time) => frameMotionSamples(scene, time, { ...options, fps, duration }, dimensions, fonts)) : times;
    const limits = { ...VIDEO_LIMITS, ...videoLimits };
    const windowed = format !== "png" && format !== "lottie" && frameCount > 2 * limits.windowFrames;
    const media = await prepareMedia(lottieMediaScene, options, mediaRoot, {
      directory,
      format,
      fps,
      frameTimes: shownTimes,
      samples: samplesFor(shownTimes),
      design,
      dimensions,
      signal,
      warnings,
      gifSlots,
      videoLimits: limits,
      flowCacheDir,
      windowFrames: windowed ? limits.windowFrames : 0,
      silent,
    });
    if (media.videoPlans.length)
      pictureWindows = videoPictureWindows(media, { directory, frameTimes, windowFrames: limits.windowFrames, samplesFor, signal, limits, flowCacheDir });
    exportFacts = { ...(format !== "lottie" ? { renderedFrames: format === "png" ? 1 : frameCount } : {}),
      hasAudio: ["mp4", "webm", "mov"].includes(format) && media.audio.some(item => item.start < frameCount / fps && item.volume > 0) };
    if (format === "lottie" && (options.motionBlur || options.dither)) warnings.push({ code: "lottie-quality", message: "Lottie keeps editable vector animation; motion blur and dither apply to raster formats only." });
    if (format === "lottie") {
      media.nativeEffectFills = effectPlan.nativeFills;
      media.effectCoveredIds = effectPlan.coveredIds;
      if (effectPlan.targets.length) {
        const rasterDirectory = join(directory, "effect-media");
        await mkdir(rasterDirectory);
        const rasterWarnings = [];
        const rasterMedia = await prepareMedia(scene, options, mediaRoot, {
          directory: rasterDirectory, format: "png-sequence", fps, frameTimes: lottieTimes.slice(0, -1),
          design: false, dimensions, signal, warnings: rasterWarnings, gifSlots, videoLimits, flowCacheDir,
        });
        for (const warning of rasterWarnings) if (!warnings.some((known) => known.code === warning.code &&
          known.layerId === warning.layerId && known.source === warning.source && known.message === warning.message)) warnings.push(warning);
        const density = options.imageDPIRatio === "original" ? 1 : Number.parseInt(options.imageDPIRatio ?? "3x", 10);
        rasterizer = await createChromiumRasterizer({ directory: join(directory, "chromium"), mediaDirectory: directory, signal,
          graphics: machine.graphics, claim: claimRasterWorkers(1) });
        const { imageFrames, videoFrames } = chromiumFrameMaps(rasterMedia, rasterizer);
        report({ stage: "render", completed: 0, total: effectPlan.targets.length * frameCount });
        media.rasterEffects = await collectRasterSequences(effectPlan.targets, lottieTimes.slice(0, -1), {
          signal, onProgress: report,
          rasterize: (svg, width, height) => rasterizer.render(linkEmbeddedPictures(svg, rasterizer, rasterMedia.directory), width, height),
          capture: (target, time) => captureLayerSvg(scene, target.id, time, {
            raster: false, rasterScale: { x: density, y: density }, embedMedia: rasterMedia.images,
            imageFrames, videoFrames, fonts, luts: rasterMedia.luts,
          }),
        });
        for (const description of effectPlan.descriptions) warnings.push({ code: "lottie-effect-rasterized", layerId: description.id,
          layerName: description.name, effects: description.effects,
          message: `${description.effects.join(", ")} on layer “${description.name}” uses an embedded raster image sequence in Lottie (${fps} fps, ${density}× local resolution).` });
      }
      scene = { ...scene, layers: scene.layers
        .map((layer) => media.lottieVideoLayerIds.has(layer.id) ? lottieVideoStill(layer) : layer) };
      assertLottieFeatures(scene, media);
      // Lottie serializes through the final frame boundary, including exports
      // shorter than one frame and durations between frame boundaries.
      media.lottieImages = await prepareLottieImageAssets(scene,
        { ...options, duration: frameCount / fps }, media, { directory, signal, warnings });
      const lottieSize = {
        width: Math.max(1, Math.round(finite(scene.width))),
        height: Math.max(1, Math.round(finite(scene.height))),
      };
      const animation = lottieAnimation(scene, options, media, lottieSize, fonts, warnings);
      aborted(signal);
      if (!effectPlan.targets.length) report({ stage: "render", completed: 1, total: 1 });
      return await finishBuffer(Buffer.from(JSON.stringify(animation)));
    }
    if (sceneNeedsChromium(scene)) {
      // A still is one frame: one worker. The frames of a movie or sequence may be drawn by several
      // workers at once when "frames at once" (context.render.framesAtOnce) or KINO_RASTER_WORKERS
      // asks for them (raster-workers.mjs chooses how many; tests pass `rasterWorkers`). They count
      // as running from this same step on (claimRasterWorkers), so an export that starts at the
      // same time leaves room for them. They draw on the card context.render.graphics names.
      // A worker that stops (a crash, or a frame out of time) is replaced and its frame drawn again
      // (chromium-raster.mjs createPool); the result says so in a warning.
      const workers = format === "png" ? 1 : rasterWorkers ?? chooseRasterWorkers({ frames: frameCount, width: dimensions.width, height: dimensions.height,
        framesAtOnce: machine.framesAtOnce, keepFreePercent: machine.keepFreePercent });
      rasterizer = await createChromiumRasterizer({ directory: join(directory, "chromium"), mediaDirectory: directory, signal, workers,
        graphics: machine.graphics, claim: claimRasterWorkers(workers), onWorkerStopped: workerStopped });
    }
    if (format === "png") {
      aborted(signal);
      report({ stage: "render", completed: 0, total: 1 });
      const result = await renderQualityFrame(scene, stillTime, media, fonts, dimensions, { ...options, fps, duration }, { design, rasterizer, signal, previewBlur, draft });
      aborted(signal);
      report({ stage: "render", completed: 1, total: 1 });
      // Await inside the try: an aborted write must be observed before the asynchronous
      // finally cleanup runs, otherwise its rejection can terminate the batch service.
      return await finishBuffer(result.buffer);
    }
    const frameDirectory = sequenceDirectory ?? directory;
    const auditFrames = options.renderQuality === "final" && ["mp4", "webm", "mov", "apng"].includes(format);
    const references = [];
    const useFiles = Boolean(sequenceDirectory) || format === "png-sequence" ||
      (format === "gif" && !options.transparent && options.gifEncoder !== "ffmpeg");
    // A scene Chromium draws goes to FFmpeg as raw RGBA pixels, not PNG files: compressing each
    // PNG took most of a 1080p fog or light-leaks frame's time. PNG files stay where a PNG is the
    // output (stills, PNG sequences, GIFs made by gifski).
    const rawFrames = Boolean(rasterizer) && !useFiles;
    let renderedBytes = 0;
    const frames = producerSignal => orderedFrames(frameTimes, async (time, index) => {
      // A windowed export draws each frame with its window's video pictures, and says when it is
      // drawn so the window can be deleted.
      const frameMedia = pictureWindows ? await pictureWindows.picturesFor(index) : media;
      try {
        return await renderQualityFrame(scene, time, frameMedia, fonts, dimensions, { ...options, fps, duration },
          { rasterizer, signal: producerSignal, pixels: rawFrames, label: `frame ${index + 1} of ${frameCount} at ${time.toFixed(3)} s`, previewBlur, draft });
      } finally { pictureWindows?.done(index); }
    // With video windows, never more frames at once than a window holds (at most two on disk).
    }, producerSignal, Math.min(1 + (rasterizer?.workers ?? 1), pictureWindows ? Math.max(2, limits.windowFrames) : Infinity));
    if (useFiles) for await (const result of frames(signal)) {
      if (result.width !== dimensions.width || result.height !== dimensions.height)
        throw new Error("Renderer produced a frame with unexpected dimensions.");
      const framePath = join(frameDirectory, `frame-${String(result.index).padStart(6, "0")}.png`);
      if (sequenceDirectory) await writeRetainedFrame(framePath, result.buffer);
      else await writeFile(framePath, result.buffer, { signal });
      renderedBytes += result.buffer.length;
      // The ZIP cannot pass 4 GiB (zip.mjs), so a long sequence stops as soon as its frames do.
      if (format === "png-sequence" && !sequenceDirectory && renderedBytes > PNG_ZIP_MAX_BYTES)
        throw new RangeError(`This PNG sequence passed the 4 GiB a ZIP can hold at frame ${result.index + 1} of ${frameCount}. Use a smaller size, a lower frame rate, a shorter scene, or a video format.`);
      report({ stage: "render", completed: result.index + 1, total: frameCount,
        ...(sequenceDirectory ? { renderedBytes } : {}) });
    }
    aborted(signal);
    if (sequenceDirectory) {
      return {
        sequence: { directory: sequenceDirectory, frameCount },
        size: renderedBytes,
        mime: "image/png",
        extension: "png",
        ...warningDetails(),
      };
    }
    const audio = media.audio.filter((item) => item.start < frameCount / fps);
    let limiterCeiling, loudnessFilter;
    if (exportFacts.hasAudio) {
      try {
        const limiter = await planMasterLimiter(audio, frameCount / fps, format, options, directory, signal);
        limiterCeiling = limiter.ceiling;
        if (limiter.loudness) {
          loudnessFilter = limiter.loudness.filter;
          const { target, targetLufs, gainDb, held, loudestAt } = limiter.loudness;
          exportFacts.loudness = { target, targetLufs, gainDb, held, loudestAt };
        }
        if (limiter.warning) warnings.push(limiter.warning);
      } catch (error) {
        aborted(signal);
        warnings.push({ code: "audio-level-unmeasured", message: `The sound mix could not be measured, so the master limiter kept its first ceiling: ${error.message.slice(0, 200)}` });
      }
    }
    report({ stage: "encode", completed: 0, total: 1 });
    const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
    if (format === "png-sequence") {
      await archivePngSequence(directory, frameCount, output, { signal });
    } else if (format === "gif" && !options.transparent && options.gifEncoder !== "ffmpeg") {
      const gifski = process.env.KINO_GIFSKI ?? "gifski";
      try {
        await runProcess(gifski, [
          "--quiet", "--fps", String(fps), "--quality", String(options.quality ?? 95),
          "--width", String(dimensions.width), "--height", String(dimensions.height),
          "--repeat", options.loop === false ? "-1" : "0", "--output", output,
          ...frameTimes.map((_, index) => `frame-${String(index).padStart(6, "0")}.png`),
        ], signal, directory);
      } catch (error) {
        if (error.code === "ENOENT") throw new Error("GIF export requires gifski. Install gifski or configure KINO_GIFSKI.");
        throw error;
      }
    } else await runExportStream(ffmpeg,
      encodeArgs(format, fps, frameCount, directory, output, audio, frameCount / fps, { ...options, pipeInput: true,
        rawFrameSize: rawFrames ? `${dimensions.width}x${dimensions.height}` : null, opaqueFrames: backgroundIsOpaque(scene), limiterCeiling, loudnessFilter }), {
        signal: exportSignal,
        input: async function* (encoderSignal) {
          const cancel = () => renderController.abort();
          encoderSignal.addEventListener("abort", cancel, { once: true });
          try {
            for await (const result of frames(signal)) {
              if (result.width !== dimensions.width || result.height !== dimensions.height)
                throw new Error("Renderer produced a frame with unexpected dimensions.");
              if (auditFrames) references.push(await referenceForFrame(result));
              report({ stage: "render", completed: result.index + 1, total: frameCount });
              // A blended frame's pixels are a Uint8ClampedArray; FFmpeg is given the same bytes.
              yield result.pixels ? new Uint8Array(result.pixels.buffer, result.pixels.byteOffset, result.pixels.byteLength) : result.buffer;
            }
            report({ stage: "encode", completed: 0, total: 1 });
          } finally { encoderSignal.removeEventListener("abort", cancel); }
        },
      });
    aborted(signal);
    report({ stage: "encode", completed: 1, total: 1 });
    if (auditFrames) {
      report({ stage: "verify", completed: 0, total: 1 });
      // The scene's cuts and transitions: the receipt lists only brightness jumps off them.
      // They are scene times; the file plays frameTimes (a frame range starts later, a reversed
      // APNG runs backward), so each one becomes the file time of the frame that crosses it.
      let planned = null;
      try {
        const sceneTimes = plannedTimes(kinoTimeline({ scenes: [scene] }, scene.id, { fonts }));
        const crosses = (time, index) => index > 0 && Math.min(frameTimes[index - 1], frameTimes[index]) < time && time <= Math.max(frameTimes[index - 1], frameTimes[index]);
        planned = sceneTimes.flatMap((time) => frameTimes.flatMap((_, index) => (crosses(time, index) ? [exportFrameTime(index, fps)] : [])));
      } catch { planned = null; }
      const { motion, ...audit } = await inspectRenderedOutput(output, { format, fps, references, hasAudio: exportFacts.hasAudio, planned,
        ...(exportFacts.loudness ? { targetLufs: exportFacts.loudness.targetLufs } : {}),
        ...(exportFacts.loudness?.held && exportFacts.loudness.loudestAt !== null ? { heldAt: exportFacts.loudness.loudestAt } : {}),
        ...(format === "mp4" ? { videoEncoder: mp4VideoEncoderFacts(options) } : {}) }, { signal });
      exportFacts.outputAudit = audit;
      // Brightness and change of every frame of the file, with its stills and brightness jumps.
      if (motion) exportFacts.motion = motion;
      if (!exportFacts.outputAudit.ok) {
        const failures = Object.entries(exportFacts.outputAudit.checks).filter(([, check]) => check.status === "fail");
        // Each failed check's own sentence says what was found (for example a file one frame late).
        const details = failures.map(([, check]) => check.detail).filter(Boolean).join(" ");
        throw new Error(`Rendered file differs from its intended frames: ${failures.map(([name]) => name).join(", ")}.${details ? ` ${details}` : ""}`);
      }
      for (const message of exportFacts.outputAudit.warnings ?? []) warnings.push({ code: "output-audit", message });
      report({ stage: "verify", completed: 1, total: 1 });
    }
    if (outputPath) {
      await copyFile(output, outputPath);
      aborted(signal);
      await noteGraphics();
      return { path: outputPath, mime: info.mime, extension: info.extension,
        ...(format === "mp4" ? { mp4Encoder: options.mp4Encoder, videoEncoder: mp4VideoEncoderFacts(options) } : {}), ...warningDetails(), ...exportFacts };
    }
    return await finishBuffer(await readFile(output));
  } finally {
    renderController.abort();
    // Wait for a video window FFmpeg may still be writing, so nothing is left behind the removal.
    try { await pictureWindows?.close(); await rasterizer?.close(); }
    finally { await removeTempFolder(directory); }
  }
}
