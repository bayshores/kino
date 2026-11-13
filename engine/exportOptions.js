import { frameToTime } from "./frameRate.js";

const VIDEO_FPS = [15, 25, 30, 60, 120];
const GIF_FPS = [5, 10, 16, 20, 25, 33, 50];

const EXPORT_SIZES = ["0.5x", "1x", "2x", "3x", "480p", "720p", "1080p", "4K"];
export const EXPORT_PROFILES = [
  { id: "mp4", label: "MP4 (H.264)", format: "mp4" },
  { id: "mp4.alt", label: "mp4.alt", format: "mp4", alternative: true },
  { id: "webm", label: "WebM", format: "webm" },
  { id: "mov", label: "MOV (ProRes 4444)", format: "mov" },
  { id: "webm-transparent", label: "WebM (transparent)", format: "webm", transparent: true },
  { id: "mov-transparent", label: "MOV (transparent)", format: "mov", transparent: true },
  { id: "gif", label: "GIF", format: "gif", loopable: true, quality: true, defaultFps: 25, frameRates: GIF_FPS },
  { id: "gif-transparent", label: "GIF (transparent)", format: "gif", transparent: true, loopable: true, defaultFps: 25, frameRates: GIF_FPS },
  { id: "lottie", label: "Lottie", format: "lottie" },
  { id: "apng", label: "APNG", format: "apng", loopable: true, defaultFps: 25 },
  { id: "png-sequence", label: "PNG (Image Sequence)", format: "png-sequence" },
  { id: "png", label: "PNG (Still image)", format: "png" },
  { id: "jpeg", label: "JPEG (Still image)", format: "jpeg" },
].map((profile) => ({ defaultFps: 60, frameRates: VIDEO_FPS, ...profile }));

export function exportProfile(id) {
  const profile = EXPORT_PROFILES.find((entry) => entry.id === id);
  if (!profile) throw new Error(`Unknown export profile “${id}”.`);
  return profile;
}

export function resolveExportDimensions(scene, size, profileId = "mp4") {
  const profile = exportProfile(profileId);
  if (!EXPORT_SIZES.includes(size)) throw new Error(`Unknown export size “${size}”.`);
  const width = Number(scene.width), height = Number(scene.height);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
    throw new Error("Export dimensions must be positive finite numbers.");
  const scale = size.endsWith("x") ? Number.parseFloat(size)
    : ({ "480p": 480, "720p": 720, "1080p": 1080, "4K": 2160 }[size] / Math.min(width, height));
  const even = ["mp4", "webm", "mov", "apng"].includes(profile.format);
  const round = (value) => even ? Math.max(2, Math.floor(Math.round(value) / 2) * 2) : Math.max(1, Math.round(value));
  return { width: round(width * scale), height: round(height * scale) };
}

export function validateExportDimensions({ width, height }) {
  if (![width, height].every((value) => Number.isInteger(value) && value > 0))
    throw new Error("Export dimensions must be positive integers.");
  if (![[2160, 4320], [4320, 2160], [2800, 2800], [5760, 1080]].some(([w, h]) => width <= w && height <= h))
    throw new Error("Export size exceeds the supported canvas limits (4K, 2800 × 2800, or 5760 × 1080).");
}

// Every format steps by the frame length rounded to 0.0001 ms, as the reference exporter does:
// at 60 fps frame 120 is sampled at 2.000004 s, just after a Play range that ends at 2 s.
// A fractional rate (29.97) steps by its exact fraction instead (frameRate.js).
export function exportFrameStep(fps) {
  if (!Number.isInteger(fps)) return frameToTime(1, fps);
  return Math.round((1000 / fps + Number.EPSILON) * 1e4) / 1e4 / 1000;
}

// The rounded step adds up: two minutes at 120 fps samples the last frame about 0.5 ms early, and
// ten minutes would be 2.4 ms, past the 1 ms that frame lookups accept (MEDIA_SAMPLE_TOLERANCE in
// playback.js). So the count starts again from the exact time every FRAME_TIME_ANCHOR_SECONDS:
// within the first two minutes every frame time is what it always was, and no frame of a longer
// scene drifts more than that first stretch does.
const FRAME_TIME_ANCHOR_SECONDS = 120;

/** The scene time export frame `index` samples at `fps` (frames a second). */
export function exportFrameTime(index, fps) {
  if (!Number.isInteger(fps)) return frameToTime(index, fps);
  const block = Math.round(FRAME_TIME_ANCHOR_SECONDS * fps);
  const anchors = block > 0 ? Math.floor(index / block) : 0;
  return anchors * FRAME_TIME_ANCHOR_SECONDS + (index - anchors * block) * exportFrameStep(fps);
}

/**
 * How many frames a video (or Lottie) `duration` seconds long has at `fps`: at least one, the last
 * starting before the end. At 29.97, 10 s holds 299.7 frames: 300, the last starting at 9.977 s;
 * 3.003 s at 23.976 is exactly 72 (the 1e-9 keeps float error from adding a 73rd).
 */
export function exportFrameCount(duration, fps) {
  return Math.max(1, Math.ceil(duration * fps - (Number.isInteger(fps) ? 0 : 1e-9)));
}

// Animation image formats include the endpoint, so a four-second 25 fps GIF
// has 101 samples. A boomerang traverses the source duration in both directions.
export function exportFrameTimes(duration, fps, { format, playbackDirection = "normal" } = {}) {
  if (!["normal", "reverse", "boomerang"].includes(playbackDirection))
    throw new Error("Unknown export playback direction.");
  const animatedImage = ["gif", "apng"].includes(format);
  if (!animatedImage && playbackDirection !== "normal")
    throw new Error("Playback direction is available for GIF and APNG exports.");
  const end = duration * (playbackDirection === "boomerang" ? 2 : 1);
  const count = animatedImage ? Math.floor(end / exportFrameStep(fps) + (Number.isInteger(fps) ? 0 : 1e-9)) + 1
    : exportFrameCount(end, fps);
  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const time = Math.min(end, exportFrameTime(index, fps));
    if (playbackDirection === "reverse") return Math.max(0, duration - time);
    if (playbackDirection === "boomerang" && time > duration) return Math.max(0, 2 * duration - time);
    return time;
  });
}
