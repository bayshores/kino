// When a video layer's sound is heard: only while the video is drawn.
//
// The editor preview plays a video with a <video> element (render.js, Stage.jsx). While the layer
// is hidden, the renderer leaves that element out, so the sound stops with the picture. Exports
// mix a video's sound from its Play range (mediaPlaybackRange in playback.js). This module cuts
// out of that range the stretches in which the video is not drawn: while a Hide operation hides
// the video or a group around it, or while one of those groups is hidden with the eye button or
// by its playback window. The exported soundtrack then goes silent exactly where the preview does.
//
// The data flow: backend/export.mjs calls audibleRanges(scene.layers, layer, sceneDuration) for each
// video layer and mixes one sound clip per range it returns. The share-link viewer's preview
// (ScenePreview.jsx) mutes a video outside those ranges, and plays an audio layer only when it and
// its groups are shown (shownWithGroups), so it sounds like the export. The dashboard plays the
// export's own mix (GET /api/dashboard/mix).
import { evaluateLayer } from "./animation.js";
import { effectiveMediaDuration, mediaPlaybackRange, mediaSoundTime } from "./playback.js";
import { isVisibilityOperation } from "./visibilityOps.js";
import { enabledAnimations } from "./animationEnabled.js";

// A sound clip shorter than this (1 ms) is left out: it can't be heard, and FFmpeg reads a
// clip duration of 0 as "until the end".
export const MIN_SOUND_SECONDS = 1e-3;

/** The layer and the groups around it, from the layer outward. Stops at a missing parent or a loop. */
function layerChain(layers, layer) {
  const byId = new Map((layers ?? []).map((item) => [item.id, item]));
  const chain = [];
  const seen = new Set();
  for (let item = layer; item && !seen.has(item.id); item = item.parentId == null ? null : byId.get(item.parentId)) {
    seen.add(item.id);
    chain.push(item);
  }
  return chain;
}

/** True when the layer and every group around it are drawn at `time` seconds (the renderer's rule). */
function chainDrawnAt(chain, time) {
  return chain.every((item) => item.visible !== false && evaluateLayer(item, time).visible !== false);
}

/**
 * The times at which the layer or a group around it may appear or disappear: its Hide and Show
 * operations that are used in playback (animationEnabled.js), the edges of playback windows, and the edges of the layer's own Play range.
 */
function switchTimes(chain) {
  const times = [];
  for (const item of chain) {
    for (const animation of enabledAnimations(item.animations))
      if (isVisibilityOperation(animation) && Number.isFinite(animation.start)) times.push(animation.start);
    for (const window of item.playbackWindows ?? []) times.push(window.start, window.end);
  }
  const [layer] = chain;
  const start = layer.mediaStart ?? 0;
  times.push(start, start + effectiveMediaDuration(layer));
  return times.filter(Number.isFinite);
}

/**
 * The stretches of scene time from `start` to `end` seconds in which `layer` is not drawn because
 * it, or a group around it, is hidden. `layers` are the scene's layers (components expanded, as
 * exports draw them). Returns sorted [{ start, end }] stretches that don't overlap.
 */
export function hiddenSpans(layers, layer, start, end) {
  if (!layer || !(end > start)) return [];
  const chain = layerChain(layers, layer);
  // Between two neighbouring switch times nothing changes, so one check in the middle of each
  // piece tells whether the whole piece is drawn.
  const times = [...new Set([start, end, ...switchTimes(chain).filter((time) => time > start && time < end)])]
    .sort((left, right) => left - right);
  const spans = [];
  for (let index = 0; index + 1 < times.length; index += 1) {
    const from = times[index];
    const to = times[index + 1];
    if (chainDrawnAt(chain, (from + to) / 2)) continue;
    const last = spans.at(-1);
    if (last && last.end === from) last.end = to;
    else spans.push({ start: from, end: to });
  }
  return spans;
}

/**
 * True when the layer and every group around it are switched on (not hidden with the eye
 * button). Exports mix the sound of such layers only (export.mjs visibleLayerIds), so an audio
 * layer inside a hidden group is silent there and in the preview.
 */
export function shownWithGroups(layers, layer) {
  return layerChain(layers, layer).every((item) => item.visible !== false);
}

/** True when `time` is inside one of `ranges` (from audibleRanges). */
export function heardAt(ranges, time) {
  return ranges.some((range) => time >= range.start && time < range.end);
}

/**
 * The parts of a video layer's Play range in which its sound is heard, in a scene that lasts
 * `sceneDuration` seconds: the range from mediaPlaybackRange without the stretches in which the
 * video is hidden. Each part is { start, end, offset, duration } like mediaPlaybackRange's range,
 * with `offset` the time in the source file where that part starts reading. A clip with a speed
 * or played backwards (mediaTime.js) has `remapped: true`: its part reads the file on the time
 * map (playback.js mediaSoundTime), not one second of file per second of scene.
 */
export function audibleRanges(layers, layer, sceneDuration) {
  const range = mediaPlaybackRange(layer, sceneDuration);
  if (!range) return [];
  const parts = [];
  let from = range.start;
  const add = (to) => {
    if (to - from >= MIN_SOUND_SECONDS)
      parts.push(range.remapped
        ? { start: from, end: to, offset: mediaSoundTime(layer, from), duration: to - from, remapped: true }
        : { start: from, end: to, offset: range.offset + (from - range.start), duration: to - from });
  };
  for (const span of hiddenSpans(layers, layer, range.start, range.end)) {
    add(span.start);
    from = span.end;
  }
  add(range.end);
  return parts;
}
