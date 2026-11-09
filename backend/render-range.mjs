// A review excerpt keeps the scene clock for pictures and sound. Only the output clock starts
// at zero. Ranges snap outwards to the output frame grid and never change the saved document.
import { exportFrameCount } from "../engine/exportOptions.js";

export function renderRange(scene, options = {}) {
  const { from, to } = options;
  if (from === undefined && to === undefined) return null;
  if (options.renderQuality !== "draft") throw new Error("A render range is for draft previews only.");
  if (!["mp4", "webm", "mov"].includes(options.format)) throw new Error("A render range requires a video format (mp4, webm or mov).");
  if (options.duration !== undefined) throw new Error("Use from/to or duration, not both.");
  if ((options.playbackDirection ?? "normal") !== "normal") throw new Error("A render range requires normal playback direction.");
  const duration = Number(scene.duration);
  if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) ||
      from < 0 || to <= from || to > duration || !Number.isFinite(duration))
    throw new Error("Give both from and to in scene seconds: 0 <= from < to <= scene duration.");
  const fps = Number(options.draftFps ?? options.fps ?? 30);
  if (!Number.isFinite(fps) || fps < 1 || fps > 30) throw new Error("A draft range needs fps from 1 to 30.");
  const total = exportFrameCount(duration, fps);
  const first = Math.min(total - 1, Math.floor(from * fps + 1e-9));
  const end = Math.min(total, Math.ceil(to * fps - 1e-9));
  const count = Math.max(1, end - first);
  return { first, count, from: first / fps, to: (first + count) / fps, duration: count / fps };
}

export function rangeCaptions(events, range) {
  if (!range) return events;
  return events.map(event => ({ ...event,
    start: Math.max(0, event.start - range.from), end: Math.min(range.duration, event.end - range.from) }))
    .filter(event => event.end > event.start);
}

export function fastPreviewOptions(input, defaults = {}) {
  if (input.preview === undefined) return {};
  if (input.preview !== "fast") throw new Error("preview is fast.");
  if ((input.quality ?? "draft") !== "draft") throw new Error("preview=fast requires quality=draft.");
  const width = input.options?.draftWidth ?? defaults.draftWidth ?? 640;
  if (!Number.isInteger(width) || width < 16 || width > 7680) throw new Error("Draft width must be a whole number of pixels from 16 to 7680.");
  return { draftWidth: Math.min(640, width),
    motionBlur: 0, dither: false };
}
