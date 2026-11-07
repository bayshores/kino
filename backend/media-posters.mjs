import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { MAX_UPLOAD_BYTES } from "../engine/schema.js";
import { createDecodeSlots } from "./gif-decode-slots.mjs";
import { decodeLottieMediaFrame } from "./lottie-media-frames.mjs";
import { runExportProcess } from "./export-process.mjs";

const MAX_PIXELS = 16_000_000;
const MAX_QUEUE = 32;
const MAX_ENTRIES = 32;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 30_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const POSTER_MIMES = new Set(["image/gif", "video/mp4", "video/webm", "video/quicktime"]);

function codedError(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function abortError(reason) {
  if (reason?.name === "AbortError") return reason;
  const error = new Error("Media poster request was cancelled.", reason === undefined ? undefined : { cause: reason });
  error.name = "AbortError";
  return error;
}

function checkAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

function positiveLimit(value, maximum, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function mimeFrom(metadata) {
  const mime = typeof metadata?.mime === "string" ? metadata.mime.split(";", 1)[0].trim().toLowerCase() : "";
  if (!POSTER_MIMES.has(mime)) throw new TypeError("This media type does not have a static poster.");
  return mime;
}

function validateDimensions(metadata, maxPixels) {
  const { width, height } = metadata ?? {};
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || width * height > maxPixels)
    throw codedError("The media dimensions are unavailable or exceed the poster limit.", "MEDIA_POSTER_DIMENSIONS");
  return { width, height };
}

function pngDimensions(buffer, maxPixels) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE))
    throw codedError("The media decoder did not return a PNG frame.", "MEDIA_POSTER_PNG");
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > maxPixels)
    throw codedError("The decoded poster dimensions exceed the pixel limit.", "MEDIA_POSTER_DIMENSIONS");
  return { width, height };
}

async function asPng(frame, { signal, maxPixels, maxOutputBytes }) {
  checkAborted(signal);
  if (!frame || !Buffer.isBuffer(frame.buffer) || !frame.buffer.length)
    throw codedError("The media decoder returned an empty frame.", "MEDIA_POSTER_PNG");
  if (frame.buffer.length > maxOutputBytes)
    throw codedError("The decoded poster exceeds the output size limit.", "MEDIA_POSTER_OUTPUT_TOO_LARGE");
  if (frame.mime === "image/png") {
    pngDimensions(frame.buffer, maxPixels);
    return frame.buffer;
  }
  if (frame.mime !== "image/jpeg")
    throw codedError("The media decoder returned an unsupported frame format.", "MEDIA_POSTER_PNG");
  let bitmap;
  try { bitmap = await loadImage(frame.buffer); }
  catch (error) { throw codedError("The decoded poster image could not be read.", "MEDIA_POSTER_PNG", error); }
  checkAborted(signal);
  if (!Number.isSafeInteger(bitmap.width) || bitmap.width < 1 || !Number.isSafeInteger(bitmap.height) || bitmap.height < 1 || bitmap.width * bitmap.height > maxPixels)
    throw codedError("The decoded poster dimensions exceed the pixel limit.", "MEDIA_POSTER_DIMENSIONS");
  const canvas = createCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const png = Buffer.from(await canvas.encode("png"));
  checkAborted(signal);
  if (png.length > maxOutputBytes)
    throw codedError("The decoded poster exceeds the output size limit.", "MEDIA_POSTER_OUTPUT_TOO_LARGE");
  pngDimensions(png, maxPixels);
  return png;
}

/**
 * Keeps bounded PNG stills for inactive media viewers. Concurrent requests for
 * the same file version and source millisecond share one decode. A decode is
 * canceled only after its final caller leaves.
 */
export function createMediaPosterCache(directory, options = {}) {
  if (typeof directory !== "string" || !directory.length) throw new TypeError("A private media poster temp directory is required.");
  const decode = options.decode ?? decodeLottieMediaFrame;
  const runProcess = options.runProcess ?? runExportProcess;
  const queueLimit = positiveLimit(options.maxQueue, MAX_QUEUE, MAX_QUEUE);
  const entryLimit = positiveLimit(options.maxEntries, MAX_ENTRIES, MAX_ENTRIES);
  const cacheByteLimit = positiveLimit(options.maxCacheBytes, MAX_CACHE_BYTES, MAX_CACHE_BYTES);
  const outputByteLimit = positiveLimit(options.maxOutputBytes, MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const pixelLimit = positiveLimit(options.maxPixels, MAX_PIXELS, MAX_PIXELS);
  const inputByteLimit = positiveLimit(options.maxInputBytes, MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  const timeoutMs = positiveLimit(options.timeoutMs, DECODE_TIMEOUT_MS, DECODE_TIMEOUT_MS);
  const decodeSlots = options.decodeSlots ?? createDecodeSlots(1);
  // decodeLottieMediaFrame uses this slot for its inner GIF frame composition.
  const gifSlots = options.gifSlots ?? createDecodeSlots(1);

  const cache = new Map();
  const jobs = new Map();
  const queue = [];
  let cachedBytes = 0;
  let activeJob = null;

  function removeJob(job) {
    if (jobs.get(job.key) === job) jobs.delete(job.key);
  }

  function clearJobTimer(job) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
  }

  function detach(waiter) {
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }

  function rejectWaiters(job, error) {
    for (const waiter of job.waiters) {
      detach(waiter);
      waiter.reject(error);
    }
    job.waiters.clear();
  }

  function settle(job, error, png) {
    if (job.state === "settled" || job.state === "cancelled") return;
    job.state = "settled";
    clearJobTimer(job);
    removeJob(job);
    if (error) rejectWaiters(job, error);
    else {
      for (const waiter of job.waiters) {
        detach(waiter);
        waiter.resolve(png);
      }
      job.waiters.clear();
    }
  }

  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);
    return entry.buffer;
  }

  function cacheSet(key, buffer) {
    if (buffer.length > cacheByteLimit) return;
    const previous = cache.get(key);
    if (previous) cachedBytes -= previous.buffer.length;
    cache.delete(key);
    cache.set(key, { buffer });
    cachedBytes += buffer.length;
    while (cache.size > entryLimit || cachedBytes > cacheByteLimit) {
      const oldestKey = cache.keys().next().value;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      cachedBytes -= oldest.buffer.length;
    }
  }

  function cancelIfUnobserved(job, reason) {
    if (job.waiters.size) return;
    clearJobTimer(job);
    removeJob(job);
    if (job.state === "queued") {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      job.state = "settled";
      return;
    }
    if (job.state === "running") {
      job.state = "cancelled";
      job.controller.abort(reason);
    }
  }

  function timeoutJob(job) {
    if (job.state !== "queued" && job.state !== "running") return;
    const error = codedError("Decoding the media poster took longer than 30 seconds.", "MEDIA_POSTER_TIMEOUT");
    if (job.state === "queued") {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      settle(job, error);
    } else {
      job.controller.abort(error);
      settle(job, error);
    }
  }

  function addWaiter(job, signal) {
    try { checkAborted(signal); } catch (error) { return Promise.reject(error); }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { resolve: resolvePromise, reject: rejectPromise, signal, onAbort: null };
      waiter.onAbort = () => {
        if (!job.waiters.delete(waiter)) return;
        detach(waiter);
        const error = abortError(signal.reason);
        rejectPromise(error);
        cancelIfUnobserved(job, error);
      };
      job.waiters.add(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }

  async function readStableSource(job) {
    const before = await stat(job.filename);
    checkAborted(job.controller.signal);
    if (!before.isFile()) throw codedError("The media source is unavailable.", "MEDIA_POSTER_SOURCE");
    if (before.size !== job.sourceSize || before.mtimeMs !== job.mtimeMs)
      throw codedError("The media source changed while its poster was queued.", "MEDIA_POSTER_SOURCE_CHANGED");
    if (!before.size || before.size > inputByteLimit)
      throw codedError("The media source exceeds the input size limit.", "MEDIA_POSTER_INPUT_TOO_LARGE");
    if (Number.isSafeInteger(job.metadata.size) && job.metadata.size !== before.size)
      throw codedError("The media metadata no longer matches its source file.", "MEDIA_POSTER_SOURCE_CHANGED");
    const buffer = await readFile(job.filename, { signal: job.controller.signal });
    if (buffer.length !== before.size || buffer.length > inputByteLimit)
      throw codedError("The media source changed while it was being read.", "MEDIA_POSTER_SOURCE_CHANGED");
    const after = await stat(job.filename);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw codedError("The media source changed while it was being read.", "MEDIA_POSTER_SOURCE_CHANGED");
    return buffer;
  }

  function pump() {
    if (activeJob) return;
    while (queue.length && queue[0].state !== "queued") queue.shift();
    const job = queue.shift();
    if (!job) return;
    if (!job.waiters.size) {
      job.state = "settled";
      clearJobTimer(job);
      removeJob(job);
      pump();
      return;
    }
    activeJob = job;
    job.state = "running";
    void decodeSlots.run(async () => {
      const input = await readStableSource(job);
      checkAborted(job.controller.signal);
      const frame = await decode({ buffer: input, mime: job.mime }, {
        directory, signal: job.controller.signal, runProcess, time: job.milliseconds / 1000, slots: gifSlots, requirePng: true,
      });
      const png = await asPng(frame, { signal: job.controller.signal, maxPixels: pixelLimit, maxOutputBytes: outputByteLimit });
      if (png.length > outputByteLimit)
        throw codedError("The decoded poster exceeds the output size limit.", "MEDIA_POSTER_OUTPUT_TOO_LARGE");
      return png;
    }, { signal: job.controller.signal }).then((png) => {
      if (job.state !== "running") return;
      if (job.waiters.size) cacheSet(job.key, png);
      settle(job, null, png);
    }).catch((error) => {
      if (job.state !== "running") return;
      settle(job, error);
    }).finally(() => {
      if (activeJob === job) activeJob = null;
      pump();
    });
  }

  async function get(filename, metadata, milliseconds, { signal } = {}) {
    checkAborted(signal);
    if (typeof filename !== "string" || !filename.length) throw new TypeError("A media source path is required.");
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 86_400_000)
      throw new RangeError("Poster time must be an integer from 0 to 86400000 milliseconds.");
    const mime = mimeFrom(metadata);
    const dimensions = validateDimensions(metadata, pixelLimit);
    const fullPath = resolve(filename);
    const info = await stat(fullPath);
    checkAborted(signal);
    if (!info.isFile()) throw codedError("The media source is unavailable.", "MEDIA_POSTER_SOURCE");
    if (!info.size || info.size > inputByteLimit)
      throw codedError("The media source exceeds the input size limit.", "MEDIA_POSTER_INPUT_TOO_LARGE");
    if (Number.isSafeInteger(metadata.size) && metadata.size !== info.size)
      throw codedError("The media metadata no longer matches its source file.", "MEDIA_POSTER_SOURCE_CHANGED");

    const key = JSON.stringify([fullPath, info.size, info.mtimeMs, milliseconds, mime, dimensions.width, dimensions.height]);
    const cached = cacheGet(key);
    if (cached) return cached;
    let job = jobs.get(key);
    if (!job) {
      if (activeJob && queue.length >= queueLimit)
        throw codedError("The media poster queue is full. Try again shortly.", "MEDIA_POSTER_QUEUE_FULL");
      job = {
        key, filename: fullPath, metadata, mime, milliseconds,
        sourceSize: info.size, mtimeMs: info.mtimeMs,
        state: "queued", waiters: new Set(), controller: new AbortController(), timer: null,
      };
      jobs.set(key, job);
      queue.push(job);
      job.timer = setTimeout(() => timeoutJob(job), timeoutMs);
    }
    const result = addWaiter(job, signal);
    pump();
    return result;
  }

  return { get };
}
