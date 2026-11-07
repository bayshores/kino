import { zlibSync } from "fflate";

const DEFAULT_MAP_SIDE = 256;
const MAX_MAP_SIDE = 512;
const MAP_CACHE_LIMIT = 64;
const MAP_CACHE_PIXEL_BUDGET = 16 * 1024 * 1024;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CRC_TABLE = new Uint32Array(256);

for (let value = 0; value < CRC_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  CRC_TABLE[value] = crc >>> 0;
}

function validateBounds(bounds) {
  if (!bounds || typeof bounds !== "object") throw new TypeError("Bounds must be an object.");
  const { width, height } = bounds;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0)
    throw new RangeError("Bounds width and height must be finite positive numbers.");
  return { width, height };
}

function validateMapSide(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAP_SIDE)
    throw new RangeError(`${name} must be an integer from 1 to ${MAX_MAP_SIDE}.`);
}

export function mapDimensions(bounds, max = DEFAULT_MAP_SIDE) {
  const { width, height } = validateBounds(bounds);
  validateMapSide(max, "Maximum map side");
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.min(max, Math.ceil(width * scale))),
    height: Math.max(1, Math.min(max, Math.ceil(height * scale))),
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = new Uint8Array(type.length);
  for (let index = 0; index < type.length; index += 1) typeBytes[index] = type.charCodeAt(index);
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  view.setUint32(data.length + 8, crc32(crcInput));
  return chunk;
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64Encode(bytes) {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const hasSecond = offset + 1 < bytes.length;
    const hasThird = offset + 2 < bytes.length;
    const second = hasSecond ? bytes[offset + 1] : 0;
    const third = hasThird ? bytes[offset + 2] : 0;
    result += BASE64[first >>> 2];
    result += BASE64[((first & 3) << 4) | (second >>> 4)];
    result += hasSecond ? BASE64[((second & 15) << 2) | (third >>> 6)] : "=";
    result += hasThird ? BASE64[third & 63] : "=";
  }
  return result;
}

function pixelBytes(pixel, x, y) {
  if (!(Array.isArray(pixel) || pixel instanceof Uint8Array || pixel instanceof Uint8ClampedArray) || pixel.length !== 4)
    throw new TypeError(`pixelFn must return four RGBA bytes at (${x}, ${y}).`);
  for (let channel = 0; channel < 4; channel += 1) {
    if (!Number.isInteger(pixel[channel]) || pixel[channel] < 0 || pixel[channel] > 255)
      throw new RangeError(`pixelFn returned an invalid RGBA byte at (${x}, ${y}).`);
  }
  return pixel;
}

function renderPng(width, height, pixelFn, retainPixels) {
  validateMapSide(width, "PNG width");
  validateMapSide(height, "PNG height");
  if (typeof pixelFn !== "function") throw new TypeError("pixelFn must be a function.");

  // Filter type 0 keeps each scanline independent and avoids browser or Node APIs.
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  const pixels = retainPixels ? new Uint8Array(width * height * 4) : null;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const rgba = pixelBytes(pixelFn(x, y, width, height), x, y);
      const at = row + 1 + x * 4;
      const pixelAt = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        scanlines[at + channel] = rgba[channel];
        if (pixels) pixels[pixelAt + channel] = rgba[channel];
      }
    }
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA color type
  const compressed = zlibSync(scanlines);
  const png = concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    // Maps encode numeric channel values in the filter's declared sRGB space.
    // Carry that space explicitly rather than relying on an untagged PNG default.
    pngChunk("sRGB", new Uint8Array([0])),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
  const uri = `data:image/png;base64,${base64Encode(png)}`;
  return retainPixels ? { uri, pixels } : uri;
}

export function pngDataUri(width, height, pixelFn) {
  return renderPng(width, height, pixelFn, false);
}

const cacheBuckets = new Map();
// The insertion order of this map is the LRU order. A unique token avoids
// stringifying arbitrary caller keys (which could collide for object keys).
const cacheOrder = new Map();
let cachedPixelBytes = 0;

function cacheDimension(width, height) { return `${width}x${height}`; }

function touchCacheEntry(bucket, dimension, entry) {
  cacheOrder.delete(entry.token);
  cacheOrder.set(entry.token, { bucket, dimension, entry });
}

function trimMapCache() {
  while (cacheOrder.size > MAP_CACHE_LIMIT || cachedPixelBytes > MAP_CACHE_PIXEL_BUDGET) {
    const [token, oldest] = cacheOrder.entries().next().value;
    cacheOrder.delete(token);
    oldest.bucket.delete(oldest.dimension);
    cachedPixelBytes -= oldest.entry.bytes;
    if (!oldest.bucket.size) cacheBuckets.delete(oldest.entry.key);
  }
}

/**
 * Cached RGBA data is exposed for internal sampling. Callers must treat `pixels` as read-only.
 * The PNG URI and pixels are generated together from one pixelFn pass.
 */
export function cachedMapImage(key, width, height, pixelFn) {
  validateMapSide(width, "PNG width");
  validateMapSide(height, "PNG height");
  if (typeof pixelFn !== "function") throw new TypeError("pixelFn must be a function.");
  const dimension = cacheDimension(width, height);
  let bucket = cacheBuckets.get(key);
  const existing = bucket?.get(dimension);
  if (existing) {
    touchCacheEntry(bucket, dimension, existing);
    return existing.image;
  }

  const rendered = renderPng(width, height, pixelFn, true);
  // Cached pixel bytes are intentionally mutable at the JavaScript level because typed arrays
  // cannot be frozen portably; this internal sampling API is read-only by contract.
  const image = Object.freeze({ uri: rendered.uri, width, height, pixels: rendered.pixels });
  if (!bucket) {
    bucket = new Map();
    cacheBuckets.set(key, bucket);
  }
  const entry = { image, token: {}, key, bytes: image.pixels.byteLength };
  bucket.set(dimension, entry);
  cacheOrder.set(entry.token, { bucket, dimension, entry, key });
  cachedPixelBytes += entry.bytes;
  trimMapCache();
  return image;
}

export function cachedMap(key, width, height, pixelFn) {
  return cachedMapImage(key, width, height, pixelFn).uri;
}

export function clearMapCache() {
  cacheBuckets.clear();
  cacheOrder.clear();
  cachedPixelBytes = 0;
}

function validateNoiseCoordinates(x, y, seed) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("Noise coordinates must be finite numbers.");
  if (!Number.isFinite(seed)) throw new RangeError("Noise seed must be a finite number.");
}

function latticeValue(x, y, seed) {
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ Math.imul(seed | 0, 0x6c8e9cf5);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return ((value >>> 0) / 0xffffffff) * 2 - 1;
}

function smoothStep(value) { return value * value * (3 - 2 * value); }
function mix(start, end, amount) { return start + (end - start) * amount; }

function validateNoisePeriod(period) {
  if (!Number.isInteger(period) || period < 0) throw new RangeError("Noise period must be a whole number of cells (0 for none).");
}

// With a period, lattice cell `period` is cell 0 again, so the field repeats without a seam.
function wrapCell(cell, period) {
  return period ? ((cell % period) + period) % period : cell;
}

// `period` 0 (the default) never repeats. A whole number of cells repeats the field every
// `period` units on both axes, which lets a small tile cover a large layer seamlessly.
export function noise2d(x, y, seed = 0, period = 0) {
  validateNoiseCoordinates(x, y, seed);
  validateNoisePeriod(period);
  const left = Math.floor(x), top = Math.floor(y);
  const fx = smoothStep(x - left), fy = smoothStep(y - top);
  const x0 = wrapCell(left, period), x1 = wrapCell(left + 1, period);
  const y0 = wrapCell(top, period), y1 = wrapCell(top + 1, period);
  const topValue = mix(latticeValue(x0, y0, seed), latticeValue(x1, y0, seed), fx);
  const bottomValue = mix(latticeValue(x0, y1, seed), latticeValue(x1, y1, seed), fx);
  return mix(topValue, bottomValue, fy);
}

export function fractalNoise(x, y, octaves = 4, seed = 0, period = 0) {
  validateNoiseCoordinates(x, y, seed);
  if (!Number.isInteger(octaves) || octaves < 1 || octaves > 8)
    throw new RangeError("Noise octaves must be an integer from 1 to 8.");
  validateNoisePeriod(period);
  let value = 0, amplitude = 1, totalAmplitude = 0, frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    // Each octave has twice as many cells, so its repeat period doubles with it.
    value += noise2d(x * frequency, y * frequency, seed + octave * 1013, period * frequency) * amplitude;
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / totalAmplitude;
}
