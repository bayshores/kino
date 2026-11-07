import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";

export const DEFAULT_RASTER_SEQUENCE_LIMITS = Object.freeze({
  maxSamples: 1000,
  maxPixels: 64_000_000,
  maxSide: 8192,
});

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function rasterLimits(overrides = {}) {
  return {
    maxSamples: positiveInteger(overrides.maxSamples ?? DEFAULT_RASTER_SEQUENCE_LIMITS.maxSamples, "maxSamples"),
    maxPixels: positiveInteger(overrides.maxPixels ?? DEFAULT_RASTER_SEQUENCE_LIMITS.maxPixels, "maxPixels"),
    maxSide: positiveInteger(overrides.maxSide ?? DEFAULT_RASTER_SEQUENCE_LIMITS.maxSide, "maxSide"),
  };
}

function targetTitle(target) {
  const label = String(target.name ?? target.id ?? "unknown layer");
  const effects = Array.isArray(target.effects) ? target.effects.filter((value) => typeof value === "string" && value.trim()) : [];
  return `${effects.length ? effects.join(", ") : "Effect"} on layer “${label}”`;
}

function limitError(target, limit, maximum) {
  // The way out, for an agent reading the refusal: fewer or smaller pictures, or a video.
  return new RangeError(`Lottie rasterization of ${targetTitle(target)} exceeds the ${limit} limit (${maximum}). Lottie keeps an effect as one picture a frame: use a lower fps, options {imageDPIRatio:"original"} (1× instead of 3×), a shorter effect or a smaller layer, or a video format.`);
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "Lottie rasterization was cancelled.");
  error.name = "AbortError";
  throw error;
}

function normalizeBounds(bounds, target) {
  if (!bounds || typeof bounds !== "object") throw new TypeError(`Raster capture for ${targetTitle(target)} needs local bounds.`);
  const result = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  if (![result.x, result.y, result.width, result.height].every(Number.isFinite) || result.width <= 0 || result.height <= 0) {
    throw new RangeError(`Raster capture for ${targetTitle(target)} has invalid local bounds.`);
  }
  return result;
}

function normalizeCapture(result, target, limits) {
  if (!result || typeof result.svg !== "string") throw new TypeError(`Raster capture for ${targetTitle(target)} must return SVG text.`);
  const bounds = normalizeBounds(result.bounds, target);
  const width = positiveInteger(result.width, "Raster pixel width");
  const height = positiveInteger(result.height, "Raster pixel height");
  if (width > limits.maxSide || height > limits.maxSide) throw limitError(target, "maxSide", limits.maxSide);
  return { svg: result.svg, bounds, width, height };
}

function boundsSignature(bounds) {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

function svgSignature(capture) {
  const hash = createHash("sha256");
  hash.update("kino-lottie-raster-v1\0");
  hash.update(`${capture.width}x${capture.height}\0${boundsSignature(capture.bounds)}\0`);
  hash.update(capture.svg);
  return hash.digest("hex");
}

function pngPixelSignature(pixels, width, height) {
  const hash = createHash("sha256");
  hash.update(`rgba-${width}x${height}\0`).update(pixels);
  return hash.digest("hex");
}

function unionBounds(left, right) {
  if (!left) return { ...right };
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const edgeX = Math.max(left.x + left.width, right.x + right.width);
  const edgeY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: edgeX - x, height: edgeY - y };
}

function sameBounds(left, right) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function appendFrame(frames, next) {
  const previous = frames.at(-1);
  // End indexes are exclusive: [start, end) identifies the sampled Lottie frames.
  if (previous && previous.end === next.start && previous.assetKey === next.assetKey && sameBounds(previous.bounds, next.bounds)) {
    previous.end = next.end;
    return;
  }
  frames.push(next);
}

/**
 * Capture each requested target at each Lottie frame time, rasterize it with the
 * deterministic bundled-font boundary, and collect deduplicated image assets.
 * `capture` owns local subtree/backdrop rendering; this module owns bounded
 * raster work and sequence interval construction.
 */
export async function collectRasterSequences(targets, times, {
  capture,
  signal,
  onProgress,
  limits: limitOverrides,
  rasterize,
} = {}) {
  if (!Array.isArray(targets)) throw new TypeError("Raster targets must be an array.");
  if (!Array.isArray(times) || (targets.length > 0 && times.length === 0)) {
    throw new TypeError("Raster sequence times must be a nonempty array.");
  }
  if (typeof capture !== "function") throw new TypeError("A raster capture function is required.");
  if (times.some((time) => typeof time !== "number" || !Number.isFinite(time))) {
    throw new TypeError("Raster sequence times must be finite numbers.");
  }
  const limits = rasterLimits(limitOverrides ?? {});
  const ids = new Set();
  for (const target of targets) {
    if (!target || typeof target.id !== "string" || !target.id.trim()) throw new TypeError("Each raster target needs a layer id.");
    if (ids.has(target.id)) throw new TypeError(`Raster target layer id “${target.id}” is repeated.`);
    ids.add(target.id);
  }
  const total = targets.length * times.length;
  if (!Number.isSafeInteger(total)) throw new RangeError("Raster sample count is too large.");
  if (total > limits.maxSamples) {
    const firstExcessTarget = targets[Math.min(targets.length - 1, Math.floor(limits.maxSamples / times.length))];
    throw limitError(firstExcessTarget, "maxSamples", limits.maxSamples);
  }
  if (targets.length === 0) return new Map();

  const svgRasters = new Map();
  const pixelAssets = new Map();
  const result = new Map();
  let rasterPixels = 0;
  let completed = 0;

  for (const target of targets) {
    const sequence = { bounds: null, frames: [], assets: new Map() };
    for (let frameIndex = 0; frameIndex < times.length; frameIndex += 1) {
      abortIfNeeded(signal);
      const captured = normalizeCapture(await capture(target, times[frameIndex], frameIndex), target, limits);
      abortIfNeeded(signal);
      const signature = svgSignature(captured);
      let asset = svgRasters.get(signature);
      if (!asset) {
        const framePixels = captured.width * captured.height;
        if (rasterPixels + framePixels > limits.maxPixels) throw limitError(target, "maxPixels", limits.maxPixels);
        rasterPixels += framePixels;
        const rendered = rasterize ? await rasterize(captured.svg, captured.width, captured.height)
          : new Resvg(captured.svg, { font: { loadSystemFonts: false } }).render();
        abortIfNeeded(signal);
        if (rendered.width !== captured.width || rendered.height !== captured.height) {
          throw new RangeError(`Raster capture for ${targetTitle(target)} produced ${rendered.width}×${rendered.height} pixels; expected ${captured.width}×${captured.height}.`);
        }
        // Chromium emits a canonical PNG with no varying metadata. Identical
        // captures therefore share the same bytes, including across SVG hashes.
        const buffer = rendered.buffer ? Buffer.from(rendered.buffer) : Buffer.from(rendered.asPng());
        const pixelKey = rendered.pixels ? pngPixelSignature(rendered.pixels, rendered.width, rendered.height)
          : createHash("sha256").update(`png-${rendered.width}x${rendered.height}\0`).update(buffer).digest("hex");
        asset = pixelAssets.get(pixelKey);
        if (!asset) {
          asset = { key: `raster_${pixelKey}`, value: { buffer, width: rendered.width, height: rendered.height } };
          pixelAssets.set(pixelKey, asset);
        }
        svgRasters.set(signature, asset);
      }
      sequence.bounds = unionBounds(sequence.bounds, captured.bounds);
      sequence.assets.set(asset.key, asset.value);
      appendFrame(sequence.frames, {
        start: frameIndex,
        end: frameIndex + 1,
        assetKey: asset.key,
        bounds: captured.bounds,
        width: captured.width,
        height: captured.height,
      });
      completed += 1;
      onProgress?.({ stage: "render", completed, total });
      abortIfNeeded(signal);
      await new Promise((resolve) => setImmediate(resolve));
      abortIfNeeded(signal);
    }
    result.set(target.id, sequence);
  }
  return result;
}
