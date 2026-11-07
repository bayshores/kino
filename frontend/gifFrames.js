// Decoded GIF frames for the editor canvas.
// The server decodes each uploaded GIF into PNG frames plus the delay of every frame.
// A GIF embedded in the document as a data: URL is decoded here in the browser, with the same
// decoder (engine/gifDecode.js). The editor then shows the frame that belongs to the scene clock
// instead of letting the browser animate the GIF on its own clock.
//
// Memory: decoded frames stay in memory only while the open document uses their GIF.
// Stage calls gifFrames.keepOnly(sources) whenever the document's GIF sources change, and every
// other GIF is released (its decode is cancelled, preloaded pictures dropped, blob: URLs revoked).
import { api, authorizedMediaUrl } from "./client.js";
import { composeGifFrames, parseGif } from "../engine/gifDecode.js";

const MAX_PARALLEL_FRAME_LOADS = 6;
// A source that failed to load is tried again after 1 s, then 2 s, 4 s, ... up to 30 s apart.
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const EMBEDDED_GIF = /^data:image\/gif;base64,/i;
// Errors that mean an embedded GIF's bytes can never be decoded (they cannot change, so retrying is pointless).
const UNDECODABLE = new Set(["GIF_TOO_LARGE", "GIF_UNREADABLE"]);

// An embedded GIF is decoded in the editor only when width x height x frame count is at most
// 50 million pixels: for example 100 frames of 700 x 700, or 400 frames of 350 x 350.
// Every decoded frame is kept as a PNG Blob while the document uses the GIF, so this limits the
// memory one embedded GIF can take. A larger embedded GIF is not decoded at all: the canvas shows
// the GIF file itself, animated by the browser. (Upload the GIF to play it by the scene clock.)
export const MAX_EMBEDDED_GIF_PIXELS = 50_000_000;
// A GIF's frames are loaded ahead of time (preloaded) until they add up to 64 million pixels
// (about 256 MB once the browser decodes them). Later frames load when they are first shown.
export const MAX_PRELOAD_PIXELS = 64_000_000;

/** Checks the server's frame timeline and turns it into the renderer's imageFrames value. */
export function frameTimeline(src, data, frameUrl = (url) => url) {
  const count = Number(data?.count);
  const durations = Array.isArray(data?.durations) ? data.durations.map(Number) : [];
  const width = Number(data?.width);
  const height = Number(data?.height);
  if (!Number.isInteger(count) || count < 1 || durations.length !== count)
    throw new Error("The GIF frame timeline does not list a delay for every frame.");
  if (durations.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("The GIF frame timeline has an invalid frame delay.");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error("The GIF frame timeline has an invalid picture size.");
  // The server's decoder version keeps browsers from reusing frames an older decoder made.
  const version = Number.isInteger(data?.decoder) && data.decoder > 0 ? `?decoder=${data.decoder}` : "";
  const frames = Array.from({ length: count }, (_, index) => frameUrl(`${src}/frames/${index}.png${version}`));
  return { durations, frames, width, height };
}

/** The bytes of a data:image/gif;base64,... URL. */
export function embeddedGifBytes(src) {
  return Uint8Array.from(atob(src.slice(src.indexOf(",") + 1)), (char) => char.charCodeAt(0));
}

/** Whether a parsed embedded GIF is small enough to decode in the editor (see MAX_EMBEDDED_GIF_PIXELS). */
export function fitsEditorBudget(gif) {
  return gif.width * gif.height * gif.frames.length <= MAX_EMBEDDED_GIF_PIXELS;
}

/**
 * Decodes an embedded GIF into the same { durations, frames, width, height } shape as frameTimeline.
 * `encodeFrame(rgba, width, height)` turns one composed frame into a Blob (a PNG in the editor).
 * Each Blob is kept behind an object URL (blob:...), which the renderer accepts for decoded frames.
 *
 * Resolves with null, before any pixel is decoded, when the GIF is over MAX_EMBEDDED_GIF_PIXELS.
 * Stops when `signal` aborts. When decoding fails or stops, the object URLs made so far are revoked.
 */
export async function decodeEmbeddedGif(src, encodeFrame, {
  signal,
  createUrl = (blob) => URL.createObjectURL(blob),
  revokeUrl = (url) => URL.revokeObjectURL(url),
} = {}) {
  // parseGif reads only the block structure (sizes and frame count), so this check is cheap.
  const gif = parseGif(embeddedGifBytes(src));
  if (!fitsEditorBudget(gif)) return null;
  const frames = [];
  try {
    await composeGifFrames(gif, {
      signal,
      onFrame: async (index, rgba) => {
        frames[index] = createUrl(await encodeFrame(rgba, gif.width, gif.height));
      },
    });
  } catch (error) {
    for (const url of frames) if (url) revokeUrl(url);
    throw error;
  }
  return { durations: gif.durations, frames, width: gif.width, height: gif.height };
}

/** How many of a GIF's first frames are preloaded: as many as fit in `budget` pixels, at least one. */
export function preloadCount(timeline, budget = MAX_PRELOAD_PIXELS) {
  const framePixels = timeline.width * timeline.height;
  return Math.min(timeline.frames.length, Math.max(1, Math.floor(budget / framePixels)));
}

/**
 * Runs `task` for every item, at most `limit` at a time. After a task fails no new item starts;
 * the tasks already running are waited for, and then the first error is thrown.
 * (So nothing is still loading when the caller frees the items after a failure.)
 */
async function eachLimited(items, limit, task) {
  let next = 0;
  let failure = null;
  async function worker() {
    while (next < items.length && !failure) {
      try {
        await task(items[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

/**
 * A per-source cache of GIF frame timelines. Concurrent requests for the same source share
 * one load. A source whose timeline or frames cannot be loaded resolves to null, so the canvas
 * keeps showing the original GIF file; it is not remembered, and load() tries again once the
 * source's retry time has passed (retryAt tells when).
 * An embedded GIF over the editor budget, or one that is not a readable GIF, also resolves to null,
 * but for good: its bytes cannot change, so it is not decoded again while the document uses it.
 *
 * - fetchTimeline(src, signal): the server's frame timeline JSON for an uploaded GIF.
 * - preloadFrame(url): loads one frame picture ahead of time.
 * - releaseFrame(url): forgets a preloaded frame picture and revokes a blob: URL.
 * - decodeEmbedded(src, signal): decodes an embedded data: GIF (decodeEmbeddedGif), or null when it is over budget.
 */
export function createGifFrameCache({
  fetchTimeline,
  preloadFrame,
  releaseFrame = () => {},
  frameUrl = (url) => url,
  decodeEmbedded,
  now = Date.now,
}) {
  // src -> { value, promise, controller, frames } for sources that are loading or loaded.
  // `frames` lists the frame URLs this entry owns, so releasing the entry frees them.
  const entries = new Map();
  // src -> { count, retryAt } for sources whose last load failed.
  const failures = new Map();
  // Embedded GIFs the editor does not decode; the canvas shows the GIF file itself.
  const native = new Set();

  async function loadTimeline(src, entry) {
    const { signal } = entry.controller;
    const timeline = EMBEDDED_GIF.test(src)
      ? await decodeEmbedded(src, signal)
      : frameTimeline(src, await fetchTimeline(src, signal), frameUrl);
    if (!timeline) return null;
    entry.frames = timeline.frames;
    // Frames past the preload budget load when they are first shown.
    await eachLimited(timeline.frames.slice(0, preloadCount(timeline)), MAX_PARALLEL_FRAME_LOADS, (url) => {
      signal.throwIfAborted();
      return preloadFrame(url);
    });
    return timeline;
  }

  // Frees an entry's frames: preloaded pictures are forgotten and blob: URLs revoked.
  function release(entry) {
    for (const url of entry.frames) releaseFrame(url);
    entry.frames = [];
  }

  function load(src) {
    const existing = entries.get(src);
    if (existing) return existing.promise;
    if (native.has(src)) return Promise.resolve(null);
    const failure = failures.get(src);
    if (failure && now() < failure.retryAt) return Promise.resolve(null);
    const entry = { value: undefined, promise: null, controller: new AbortController(), frames: [] };
    entries.set(src, entry);
    entry.promise = loadTimeline(src, entry).then(
      (timeline) => {
        // keepOnly released this source while it loaded: free what arrived after that.
        if (entry.controller.signal.aborted) {
          release(entry);
          return null;
        }
        if (!timeline) {
          // Over the editor budget: the canvas keeps showing the GIF file.
          entries.delete(src);
          native.add(src);
          return null;
        }
        entry.value = timeline;
        failures.delete(src);
        return timeline;
      },
      (error) => {
        release(entry);
        // A released source was cancelled on purpose; keepOnly already forgot it.
        if (entry.controller.signal.aborted) return null;
        entries.delete(src);
        // A GIF that can never be decoded keeps showing the GIF file: an embedded one over the limits,
        // or an uploaded one the server refused as too large (413) or undecodable (422).
        if ((EMBEDDED_GIF.test(src) && UNDECODABLE.has(error?.code)) || error?.status === 413 || error?.status === 422) native.add(src);
        else {
          const count = (failure?.count ?? 0) + 1;
          failures.set(src, { count, retryAt: now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (count - 1)) });
        }
        return null;
      },
    );
    return entry.promise;
  }

  /** The loaded timeline, or undefined while it is loading, after loading failed, or when it is not decoded. */
  function get(src) {
    return entries.get(src)?.value;
  }

  /** The time (on the `now` clock, in ms) when a failed source may load again; undefined when it has not failed. */
  function retryAt(src) {
    return failures.get(src)?.retryAt;
  }

  /** Milliseconds until a failed source may be loaded again (0 when it may load now). */
  function retryDelay(src) {
    const failure = failures.get(src);
    return failure ? Math.max(0, failure.retryAt - now()) : 0;
  }

  /**
   * Releases every source that is not in `sources` (a Set of the GIF sources the open document uses):
   * an unfinished load is cancelled, and the source's frames are freed.
   */
  function keepOnly(sources) {
    for (const [src, entry] of entries) {
      if (sources.has(src)) continue;
      entries.delete(src);
      entry.controller.abort();
      release(entry);
    }
    for (const src of failures.keys()) if (!sources.has(src)) failures.delete(src);
    for (const src of native) if (!sources.has(src)) native.delete(src);
  }

  return { load, get, retryAt, retryDelay, keepOnly };
}

/**
 * One timer for all the GIF sources that failed to load. schedule(at) makes the timer fire at
 * `at` (a time on the `now` clock) when that is sooner than the time it is already set for.
 * A later time does not move it: when the timer fires, `onRetry` makes the editor load every
 * source again, and each source that is still waiting schedules its own retry time again.
 */
export function createRetryTimer(onRetry, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  let firesAt = Infinity;
  function cancel() {
    clearTimer(timer);
    timer = undefined;
    firesAt = Infinity;
  }
  function schedule(at) {
    if (!(at < firesAt)) return;
    cancel();
    firesAt = at;
    timer = setTimer(() => {
      timer = undefined;
      firesAt = Infinity;
      onRetry();
    }, Math.max(0, at - now()));
  }
  return { schedule, cancel };
}

// Pictures loaded ahead of time, by URL, so the browser can reuse them while the GIF plays.
const preloaded = new Map();

function preloadImage(url) {
  if (preloaded.has(url)) return preloaded.get(url).promise;
  const image = new Image();
  const promise = new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => {
      // Forget the failed picture, so a later attempt loads it again.
      if (preloaded.get(url)?.image === image) preloaded.delete(url);
      reject(new Error("A GIF frame could not be loaded."));
    };
  }).then(() => image.decode?.().catch(() => {}));
  image.src = url;
  preloaded.set(url, { image, promise });
  return promise;
}

// Forgets a preloaded picture. A blob: URL (an embedded GIF's frame) is also revoked, which frees its PNG.
function releaseImage(url) {
  preloaded.delete(url);
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

// One canvas turns decoded embedded-GIF frames into PNG Blobs.
let frameCanvas;
function pngBlob(rgba, width, height) {
  frameCanvas ??= document.createElement("canvas");
  frameCanvas.width = width;
  frameCanvas.height = height;
  // putImageData and toBlob run together, so the canvas holds this frame when toBlob copies it.
  frameCanvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return new Promise((resolve, reject) =>
    frameCanvas.toBlob((result) => (result ? resolve(result) : reject(new Error("A GIF frame could not be encoded."))), "image/png"));
}

export const gifFrames = createGifFrameCache({
  // `src` is /api/media/<file>.gif; api() adds the same access headers as other editor requests.
  fetchTimeline: (src, signal) => api(`${src.replace(/^\/api/, "")}/frames`, { signal }),
  preloadFrame: preloadImage,
  releaseFrame: releaseImage,
  frameUrl: authorizedMediaUrl,
  decodeEmbedded: (src, signal) => decodeEmbeddedGif(src, pngBlob, { signal }),
});

/** Only uploaded GIF files have a decoded frame timeline on the server. */
export function hasServerFrames(src) {
  return typeof src === "string" && /^\/api\/media\/[a-z0-9_-]+\.gif$/i.test(src);
}

/** Uploaded GIFs get their frames from the server; embedded data: GIFs are decoded in the editor. */
export function hasFrameTimeline(src) {
  return hasServerFrames(src) || (typeof src === "string" && EMBEDDED_GIF.test(src));
}
