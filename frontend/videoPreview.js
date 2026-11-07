import { enabledAnimations } from "../engine/animationEnabled.js";
import { isEffectAnimation } from "../engine/effects/animation.js";
import { effectDefinition } from "../engine/effects/catalog.js";
import { effectiveMediaDuration, hasMediaPlay } from "../engine/playback.js";

export const INITIAL_VIDEO_FRAME = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=";

export const MAX_VIDEO_FRAME_SIDE = 2048;
export const MAX_VIDEO_FRAME_PIXELS = 4_000_000;
const PAUSED_FRAME_TOLERANCE = 0.04;

function propertyAnimation(operations, key) {
  return operations.some((operation) => [operation?.from, operation?.to].some((values) =>
    values && typeof values === "object" && Object.hasOwn(values, key)));
}

function layerOperations(layer) {
  return enabledAnimations(layer?.animations);
}

function hasBackdropStyle(layer, operations) {
  return layer?.backgroundBlur?.enabled === true || layer?.glass?.enabled === true ||
    propertyAnimation(operations, "backgroundBlur") || propertyAnimation(operations, "glass");
}

// A frame of slack on each side of a video's shown time (seconds of the scene).
const SHOWN_MARGIN = 0.05;

/**
 * The scene seconds [from, to] when a video's picture can show: its Play range, open on each side
 * its Freeze holds a frame (playback.js mediaFrameState). Hides and groups are not counted, so
 * the span is never shorter than the time the video really shows.
 */
export function videoShownSpan(layer) {
  // A component's clock can hold a frame past its Play range, so it may show at any scene time.
  if (!hasMediaPlay(layer) || layer.playbackWindows?.length) return [-Infinity, Infinity];
  const freeze = layer.mediaFreeze ?? (layer.type === "video" ? "both" : "none");
  const start = Number.isFinite(layer.mediaStart) ? layer.mediaStart : 0;
  const end = start + effectiveMediaDuration(layer);
  return [freeze === "first" || freeze === "both" ? -Infinity : start - SHOWN_MARGIN,
    freeze === "last" || freeze === "both" || !Number.isFinite(end) ? Infinity : end + SHOWN_MARGIN];
}

// True when a value effect's held value (its `to`, after it ends) changes nothing: its strength
// setting (the one with a neutral value, such as a zoom blur's amount) is at that neutral value.
function heldNeutral(effect, to = {}) {
  return Object.entries(effect.parameters).some(([key, field]) =>
    Object.hasOwn(field, "neutral") && (to[key] ?? field.default) === field.neutral);
}

/**
 * The scene seconds [first, last] when each effect animation among `operations` (enabled, on
 * `layer`) changes the picture. A value effect works from its start and holds its last value
 * after its end, unless that value is neutral, until a later one of the same kind takes over; a
 * ranged effect holds before and after as its Keep still says (effects/animation.js effectsAt).
 * A layer on a component's clock, or an effect this version does not know, always works.
 */
function effectSpans(layer, operations) {
  const effects = operations.map((operation, index) => ({ operation, index }))
    .filter(({ operation }) => isEffectAnimation(operation))
    .sort((a, b) => (Number(a.operation.start) || 0) - (Number(b.operation.start) || 0) || a.index - b.index);
  if (!effects.length) return [];
  if (Array.isArray(layer?.playbackWindows) && layer.playbackWindows.length) return [[-Infinity, Infinity]];
  const spans = [], held = new Map();
  for (const { operation } of effects) {
    let effect;
    try { effect = effectDefinition(operation.effect); } catch { return [[-Infinity, Infinity]]; }
    const start = Number(operation.start) || 0, end = start + (Number(operation.duration) || 0);
    let first = start, last = Infinity;
    if (effect.kind === "value") {
      if (heldNeutral(effect, operation.to)) last = end;
      const earlier = held.get(effect.key);
      if (earlier) earlier[1] = Math.min(earlier[1], Math.max(earlier[0], start));
    } else {
      const hold = operation.keepStill ?? "both";
      if (hold === "start" || hold === "both") first = -Infinity;
      if (hold !== "end" && hold !== "both") last = end;
    }
    const span = [first, last];
    if (effect.kind === "value") held.set(effect.key, span);
    spans.push(span);
  }
  return spans;
}

function visibleLayer(layer, byId, cache) {
  const chain = [];
  const path = new Set();
  let current = layer;
  let visible = true;
  while (current) {
    const id = current.id;
    if (cache.has(id)) { visible = cache.get(id); break; }
    if (path.has(id)) { visible = false; break; }
    path.add(id);
    chain.push(current);
    if (current.visible === false) { visible = false; break; }
    if (current.parentId == null) { current = null; break; }
    current = byId.get(current.parentId) ?? null;
    if (!current) { visible = false; break; }
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    visible = visible && chain[index].visible !== false;
    cache.set(chain[index].id, visible);
  }
  return cache.get(layer.id) ?? false;
}

// A captured video costs a picture copied and encoded every frame, and a big blur on it is
// redrawn at full size (in a sample edit, a zoom blur that ended before two copies of a phone
// clip began made each of them cost that for 7 s). So a video is captured only while an effect on
// it or a group around it changes the picture: the scene seconds of each such effect inside the
// video's shown time, CAPTURE_MARGIN wider on each side. [[-Infinity, Infinity]] means always;
// an effect preset always works.
export const CAPTURE_MARGIN = 0.1;
// Capture starts this much (seconds) before a window, so its first picture is ready at the switch.
export const CAPTURE_LEAD = 0.3;

// A layer turned in 3D (drawn through SVG <use> triangles, render.js triangleTiltTag) or a mask:
// a canvas inside a <use>, a pattern or a mask draws nothing, so a video under one keeps a
// captured picture for its whole shown time.
function drawnOnlyAsPicture(layer, own) {
  return layer.isMask === true || ["rotateX", "rotateY"].some((key) =>
    Math.abs(Number(layer[key]) || 0) > 1e-6 || propertyAnimation(own, key));
}

function captureWindows(layer, byId, operations) {
  const [shownFrom, shownTo] = videoShownSpan(layer);
  const windows = [];
  const path = new Set();
  let picture = false;
  for (let current = layer; current && !path.has(current.id);) {
    path.add(current.id);
    const own = operations.get(current) ?? [];
    if (current.effectPreset || propertyAnimation(own, "effectPreset")) return [[-Infinity, Infinity]];
    picture ||= drawnOnlyAsPicture(current, own);
    for (const [first, last] of effectSpans(current, own)) {
      const from = Math.max(first, shownFrom), to = Math.min(last, shownTo);
      if (from <= to) windows.push([from - CAPTURE_MARGIN, to + CAPTURE_MARGIN]);
    }
    current = current.parentId == null ? null : byId.get(current.parentId);
  }
  // Tilted or a mask: a live <video> cannot draw there at all (triangles copy it with <use>), so
  // it keeps a captured picture whenever it shows, effects or not.
  if (picture) return [[-Infinity, Infinity]];
  windows.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
    else merged.push([...window]);
  }
  return merged;
}

/** True when `time` (scene seconds) is inside one of `windows`, or up to `lead` seconds before one. */
export function capturingAt(windows, time, lead = 0) {
  return Boolean(windows?.some(([from, to]) => time >= from - lead && time <= to));
}

/**
 * The expanded video layers that use a decoded frame inside the scene SVG at some time, as a map
 * from layer ID to the scene seconds when (captureWindows). A backdrop effect can sample any
 * lower sibling or copied backdrop, so one visible background blur/glass effect captures all
 * visible video layers in this scene, always.
 */
export function videoCaptureWindows(scene) {
  const layers = Array.isArray(scene?.layers) ? scene.layers : [];
  const byId = new Map(layers.filter((layer) => layer?.id != null).map((layer) => [layer.id, layer]));
  const operations = new Map(layers.map((layer) => [layer, layerOperations(layer)]));
  const visibility = new Map();
  for (const layer of layers) visibleLayer(layer, byId, visibility);
  const anyBackdrop = layers.some((layer) => visibility.get(layer.id) === true &&
    hasBackdropStyle(layer, operations.get(layer)));
  const result = new Map();
  for (const layer of layers) {
    if (layer?.type !== "video" || visibility.get(layer.id) !== true) continue;
    const windows = anyBackdrop ? [[-Infinity, Infinity]] : captureWindows(layer, byId, operations);
    if (windows.length) result.set(layer.id, windows);
  }
  return result;
}

/** IDs of expanded video layers that use a decoded frame inside the scene SVG at some time. */
export function videoFrameLayerIds(scene) {
  return new Set(videoCaptureWindows(scene).keys());
}

// The browser encodes a canvas picture on the page's own thread in its idle time. A 720 × 1564
// video frame took about 22 ms as PNG and 8 ms as JPEG in kino's window (70 and 36 ms while a
// large scene played), so an MP4, whose H.264 or HEVC picture has no see-through parts, is kept
// as a high-quality JPEG. Any other file (a WebM can be see-through) stays PNG.
const OPAQUE_VIDEO = /\.(?:mp4|m4v)(?:[?#]|$)/i;
export const VIDEO_FRAME_JPEG_QUALITY = 0.95;

/** How a captured frame of the video at `source` is encoded: { type, quality }. */
export function videoFrameEncoding(source) {
  return typeof source === "string" && OPAQUE_VIDEO.test(source)
    ? { type: "image/jpeg", quality: VIDEO_FRAME_JPEG_QUALITY }
    : { type: "image/png", quality: undefined };
}

/**
 * Size a snapshot canvas without changing the source frame's aspect ratio. `maxSide` (pixels)
 * caps the longer side further: a playing preview passes its stage's size on screen.
 */
export function videoFrameCanvasSize(width, height, maxSide = MAX_VIDEO_FRAME_SIDE) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  const side = Number.isFinite(maxSide) && maxSide >= 1 ? Math.min(MAX_VIDEO_FRAME_SIDE, maxSide) : MAX_VIDEO_FRAME_SIDE;
  const scale = Math.min(
    1,
    side / Math.max(width, height),
    Math.sqrt(MAX_VIDEO_FRAME_PIXELS / (width * height)),
  );
  let targetWidth = Math.max(1, Math.floor(width * scale));
  let targetHeight = Math.max(1, Math.floor(height * scale));
  while (targetWidth > MAX_VIDEO_FRAME_SIDE || targetHeight > MAX_VIDEO_FRAME_SIDE ||
      targetWidth * targetHeight > MAX_VIDEO_FRAME_PIXELS) {
    if (targetWidth >= targetHeight) targetWidth -= 1;
    else targetHeight -= 1;
  }
  return { width: targetWidth, height: targetHeight };
}

/** Reject an encoded result if a newer source, seek, or paused frame superseded it. */
export function isCurrentVideoCapture({
  generation,
  currentGeneration,
  source,
  currentSource,
  captureTime,
  currentTime,
  wasPlaying,
  isPlaying,
  seeking = false,
}) {
  if (generation !== currentGeneration || source !== currentSource || seeking ||
      Boolean(wasPlaying) !== Boolean(isPlaying)) return false;
  if (wasPlaying) return true;
  return Number.isFinite(captureTime) && Number.isFinite(currentTime) &&
    Math.abs(captureTime - currentTime) <= PAUSED_FRAME_TOLERANCE;
}

/**
 * Serializes asynchronous frame encoding per video. Events during an encode replace
 * the pending request, so the next capture observes the latest decoded frame only.
 */
export function createLatestFrameQueue(processFrame, onError = () => {}) {
  if (typeof processFrame !== "function") throw new TypeError("A frame processor is required.");
  if (typeof onError !== "function") throw new TypeError("The frame error handler must be a function.");
  let running = false;
  let disposed = false;
  let pending;
  let drainPromise = Promise.resolve();
  const idleWaiters = new Set();

  const settleIdle = () => {
    if (running || pending !== undefined) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const drain = async () => {
    while (!disposed && pending !== undefined) {
      const request = pending;
      pending = undefined;
      try { await processFrame(request); }
      catch (error) { onError(error); }
    }
    running = false;
    settleIdle();
    if (!disposed && pending !== undefined) start();
  };

  const start = () => {
    if (running || disposed) return;
    running = true;
    drainPromise = drain();
  };

  return {
    enqueue(request) {
      if (disposed) return;
      pending = request;
      start();
    },
    clear() { pending = undefined; settleIdle(); },
    dispose() {
      disposed = true;
      pending = undefined;
      settleIdle();
    },
    waitForIdle() {
      if (!running && pending === undefined) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    get running() { return running; },
    get drainPromise() { return drainPromise; },
  };
}
