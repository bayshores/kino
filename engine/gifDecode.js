// Reads GIF files and draws their frames the way browsers (Chromium) show them.
// The server uses it for decoded GIF frames and exports; the editor uses it for embedded data: GIFs.
//
// It works in two steps:
//   1. parseGif reads only the block structure (sizes, palettes, delays, where each frame's
//      compressed data lives). Size limits are checked here, before any pixel is decoded.
//   2. composeGifFrames decodes each frame's LZW data and draws it onto one full-size RGBA canvas,
//      applying transparency and disposal, and hands every wanted frame to a callback.

// Raise this number whenever decoded pixels change, so frames saved by an older decoder
// (for example the server's frame cache in backend/gif-frame-cache.mjs) are decoded again.
export const GIF_DECODER_VERSION = 1;
// Largest canvas (and largest single frame) that is decoded: 4096 x 4096 pixels.
export const MAX_GIF_CANVAS_PIXELS = 16_777_216;
// A still that needs only the first frame may be larger, because only one canvas is decoded:
// up to 33,554,432 pixels (for example 8192 x 4096, or a 6000 x 4000 photo).
export const MAX_GIF_STILL_PIXELS = 33_554_432;
export const MAX_GIF_FRAMES = 10_000;
// Limit for canvas pixels times frames, so one small file cannot ask for hours of decoding.
export const MAX_GIF_PIXEL_FRAMES = 1_000_000_000;
// Browsers show GIF frames with a delay of 0 or 1 hundredths of a second for 1/10 s.
export const MIN_GIF_DELAY = 0.02;
export const DEFAULT_GIF_DELAY = 0.1;
// Long decodes give other work (server requests, editor input) a turn this often.
const YIELD_EVERY_MS = 15;
const MAX_LZW_CODES = 4096;
// Chromium cannot decode a frame whose LZW minimum code size is above 8 (palette indexes are bytes).
const MAX_LZW_MIN_CODE_SIZE = 8;
const INTERLACE_PASSES = [[0, 8], [4, 8], [2, 4], [1, 2]];

/** Applies the browser delay rule to a delay in seconds: very short delays play as 1/10 s. */
export function gifDelaySeconds(seconds) {
  return seconds < MIN_GIF_DELAY - 1e-6 ? DEFAULT_GIF_DELAY : Math.round(seconds * 1000) / 1000;
}

function gifError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const tooLarge = (message) => gifError(message, "GIF_TOO_LARGE");
const unreadable = (message) => gifError(message, "GIF_UNREADABLE");

function abortError(signal) {
  const error = new Error("GIF decoding was cancelled.", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}

/** Returns the offset just after a run of data sub-blocks (each starts with its length; 0 ends the run). */
function skipSubBlocks(bytes, offset) {
  while (offset < bytes.length) {
    const size = bytes[offset];
    offset += 1 + size;
    if (size === 0) return offset;
  }
  return bytes.length;
}

/**
 * Reads a GIF's structure without decoding pixels.
 * Returns { width, height, frames, durations, bytes } where each frame lists its rectangle,
 * palette, transparent index, disposal, delay and the position of its compressed data.
 * `firstFrames` stops reading after that many frames, for callers that only need the start of the GIF
 * (the limits then apply to those frames only). Every frame is read when it is left out.
 * `maxCanvasPixels` replaces MAX_GIF_CANVAS_PIXELS for the canvas and each frame; callers that decode
 * only the first frame pass MAX_GIF_STILL_PIXELS.
 * Throws an error with code GIF_TOO_LARGE when the canvas, a frame, or the frame count is over the limits,
 * and GIF_UNREADABLE when the file is not a GIF, has no frames, or has a frame that browsers
 * cannot decode (an LZW minimum code size above 8).
 */
export function parseGif(bytes, { firstFrames = Infinity, maxCanvasPixels = MAX_GIF_CANVAS_PIXELS } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("parseGif needs the GIF file's bytes.");
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (bytes.length < 13 || (signature !== "GIF87a" && signature !== "GIF89a")) throw unreadable("This file is not a GIF.");
  const u16 = (offset) => bytes[offset] | (bytes[offset + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  if (!width || !height) throw unreadable("This GIF has an empty picture size.");
  const canvasPixels = width * height;
  if (canvasPixels > maxCanvasPixels)
    throw tooLarge(`This GIF's picture (${width} x ${height}) is larger than ${maxCanvasPixels.toLocaleString("en-US")} pixels.`);
  const screenFlags = bytes[10];
  let offset = 13;
  let globalPalette = null;
  if (screenFlags & 0x80) {
    globalPalette = { offset, colors: 2 << (screenFlags & 7) };
    offset += globalPalette.colors * 3;
  }
  const frames = [];
  let framePixels = 0;
  // The graphic control extension describes the image that follows it.
  let control = null;
  while (offset < bytes.length && frames.length < firstFrames) {
    const block = bytes[offset];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[offset + 1];
      if (label === 0xf9 && bytes[offset + 2] >= 4 && offset + 7 < bytes.length) {
        const flags = bytes[offset + 3];
        control = {
          disposal: (flags >> 2) & 7,
          delayCs: u16(offset + 4),
          transparentIndex: flags & 1 ? bytes[offset + 6] : -1,
        };
      }
      // Application, comment and plain-text extensions are skipped.
      offset = skipSubBlocks(bytes, offset + 2);
      continue;
    }
    if (block !== 0x2c) break;
    // Image descriptor (10 bytes), optional local palette, LZW code size, then the data sub-blocks.
    if (offset + 10 >= bytes.length) break;
    const frame = {
      left: u16(offset + 1),
      top: u16(offset + 3),
      width: u16(offset + 5),
      height: u16(offset + 7),
      interlaced: Boolean(bytes[offset + 9] & 0x40),
      palette: globalPalette,
      transparentIndex: control?.transparentIndex ?? -1,
      disposal: control?.disposal ?? 0,
      delayCs: control?.delayCs ?? 0,
    };
    const imageFlags = bytes[offset + 9];
    offset += 10;
    if (imageFlags & 0x80) {
      frame.palette = { offset, colors: 2 << (imageFlags & 7) };
      offset += frame.palette.colors * 3;
    }
    if (offset >= bytes.length) break;
    frame.codeSize = bytes[offset];
    if (frame.codeSize > MAX_LZW_MIN_CODE_SIZE)
      throw unreadable(`Frame ${frames.length + 1} of this GIF has an LZW code size of ${frame.codeSize}, which browsers cannot decode.`);
    frame.dataStart = offset + 1;
    offset = skipSubBlocks(bytes, frame.dataStart);
    frame.dataEnd = Math.min(offset, bytes.length);
    control = null;
    if (frames.length >= MAX_GIF_FRAMES) throw tooLarge(`This GIF has more than ${MAX_GIF_FRAMES.toLocaleString("en-US")} frames.`);
    if (frame.width * frame.height > maxCanvasPixels)
      throw tooLarge(`Frame ${frames.length + 1} of this GIF is larger than ${maxCanvasPixels.toLocaleString("en-US")} pixels.`);
    framePixels += frame.width * frame.height;
    if (framePixels > MAX_GIF_PIXEL_FRAMES || (frames.length + 1) * canvasPixels > MAX_GIF_PIXEL_FRAMES)
      throw tooLarge(`This GIF has more than ${MAX_GIF_PIXEL_FRAMES.toLocaleString("en-US")} pixels across its frames.`);
    frames.push(frame);
  }
  if (!frames.length) throw unreadable("This GIF has no readable frames.");
  const durations = frames.map((frame) => gifDelaySeconds(frame.delayCs / 100));
  return { width, height, frames, durations, bytes };
}

/**
 * Reads only what is needed to draw a GIF's first frame, with the larger still limit
 * (MAX_GIF_STILL_PIXELS). Returns parseGif's result for that one frame, plus `animated`:
 * whether a second frame follows. A second frame that cannot be read still counts as animation,
 * because browsers start to play it; only a problem with the first frame throws.
 */
export function parseGifStart(bytes) {
  const options = { maxCanvasPixels: MAX_GIF_STILL_PIXELS };
  let gif;
  let animated = true;
  try {
    gif = parseGif(bytes, { ...options, firstFrames: 2 });
    animated = gif.frames.length > 1;
  } catch {
    // Read the first frame alone: it throws when the problem is in the first frame itself.
    gif = parseGif(bytes, { ...options, firstFrames: 1 });
  }
  return { ...gif, frames: gif.frames.slice(0, 1), durations: gif.durations.slice(0, 1), animated };
}

/**
 * Decodes one frame's LZW data into palette indexes (one byte per pixel, rows in file order).
 * Returns how many pixels were decoded. Damaged or truncated data stops early;
 * the pixels after that point stay unpainted, as in browsers.
 */
export function decodeLzw(bytes, start, end, minCodeSize, output) {
  if (minCodeSize < 2 || minCodeSize > MAX_LZW_MIN_CODE_SIZE) return 0;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  // Each code is a string of indexes: the string of `prefix` followed by `suffix`.
  const prefix = new Uint16Array(MAX_LZW_CODES);
  const suffix = new Uint8Array(MAX_LZW_CODES);
  const firstIndex = new Uint8Array(MAX_LZW_CODES);
  const lengths = new Uint16Array(MAX_LZW_CODES);
  for (let code = 0; code < clearCode; code += 1) {
    suffix[code] = code;
    firstIndex[code] = code;
    lengths[code] = 1;
  }
  let codeSize = minCodeSize + 1;
  let nextCode = clearCode + 2;
  let previous = -1;
  let written = 0;
  // Codes are packed least significant bit first across the data sub-blocks.
  let position = start;
  let blockEnd = start;
  let bits = 0;
  let bitCount = 0;
  while (written < output.length) {
    while (bitCount < codeSize) {
      if (position >= blockEnd) {
        if (position >= end || bytes[position] === 0) return written;
        blockEnd = Math.min(end, position + 1 + bytes[position]);
        position += 1;
        continue;
      }
      bits |= bytes[position] << bitCount;
      position += 1;
      bitCount += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    bitCount -= codeSize;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = clearCode + 2;
      previous = -1;
      continue;
    }
    if (code === endCode) return written;
    if (previous < 0) {
      // The first code after a clear must be a single index.
      if (code > clearCode) return written;
      output[written] = code;
      written += 1;
      previous = code;
      continue;
    }
    // A code can name an existing entry or the one about to be added; anything later is damaged data.
    if (code > nextCode) return written;
    // When the table is full, codes keep their 12-bit size and no entries are added until the next clear.
    if (nextCode < MAX_LZW_CODES) {
      prefix[nextCode] = previous;
      // A code that is not in the table yet (code === nextCode) starts with the previous string's first index.
      suffix[nextCode] = firstIndex[code === nextCode ? previous : code];
      firstIndex[nextCode] = firstIndex[previous];
      lengths[nextCode] = lengths[previous] + 1;
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    // Write the code's string backwards from its last index, dropping anything past the frame.
    const length = lengths[code];
    let entry = code;
    for (let index = length - 1; index >= 0; index -= 1) {
      if (written + index < output.length) output[written + index] = suffix[entry];
      entry = prefix[entry];
    }
    written = Math.min(output.length, written + length);
    previous = code;
  }
  return written;
}

/** Row numbers inside the frame, in the order the file stores them. */
function rowOrder(frame) {
  const rows = [];
  if (!frame.interlaced) {
    for (let row = 0; row < frame.height; row += 1) rows.push(row);
    return rows;
  }
  for (const [first, step] of INTERLACE_PASSES)
    for (let row = first; row < frame.height; row += step) rows.push(row);
  return rows;
}

/**
 * Draws one frame's pixels over the canvas. Pixels with the transparent index keep what is underneath.
 * An index past the end of the palette is opaque black, as Chromium shows it.
 */
function drawFrame(gif, frame, canvas) {
  const { bytes, width, height } = gif;
  const indexes = new Uint8Array(frame.width * frame.height);
  const decoded = decodeLzw(bytes, frame.dataStart, frame.dataEnd, frame.codeSize, indexes);
  const colors = frame.palette?.colors ?? 0;
  const paletteOffset = frame.palette?.offset ?? 0;
  const rows = rowOrder(frame);
  for (let fileRow = 0; fileRow * frame.width < decoded; fileRow += 1) {
    const y = frame.top + rows[fileRow];
    if (y >= height) continue;
    const rowStart = fileRow * frame.width;
    const columns = Math.min(frame.width, width - frame.left, decoded - rowStart);
    for (let column = 0; column < columns; column += 1) {
      const index = indexes[rowStart + column];
      if (index === frame.transparentIndex) continue;
      const pixel = (y * width + frame.left + column) * 4;
      if (index < colors) {
        const color = paletteOffset + index * 3;
        canvas[pixel] = bytes[color];
        canvas[pixel + 1] = bytes[color + 1];
        canvas[pixel + 2] = bytes[color + 2];
      } else canvas.fill(0, pixel, pixel + 3);
      canvas[pixel + 3] = 255;
    }
  }
}

/** Disposal 2: the frame's rectangle (inside the canvas) becomes transparent. */
function clearRectangle(gif, frame, canvas) {
  const right = Math.min(gif.width, frame.left + frame.width);
  const bottom = Math.min(gif.height, frame.top + frame.height);
  if (frame.left >= right) return;
  for (let y = frame.top; y < bottom; y += 1)
    canvas.fill(0, (y * gif.width + frame.left) * 4, (y * gif.width + right) * 4);
}

const now = () => globalThis.performance?.now() ?? Date.now();
const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Draws the GIF's frames in order on one RGBA canvas (width x height x 4, straight alpha),
 * following browser rules: the canvas starts transparent whatever the background color says,
 * and before frame i is drawn, frame i - 1's disposal is applied
 * (2 clears its rectangle to transparent, 3 restores the canvas from before frame i - 1).
 *
 * `wanted(index)` picks the frames passed to `onFrame(index, rgba)`; decoding stops after the last
 * wanted frame. `rgba` is the live canvas: use or copy it before the promise onFrame returns settles.
 * Between frames the decoder waits for onFrame, gives other work a turn now and then, and stops
 * with an AbortError when `signal` is aborted.
 */
export async function composeGifFrames(gif, { wanted = () => true, onFrame, signal } = {}) {
  const { width, height, frames } = gif;
  let lastWanted = -1;
  for (let index = 0; index < frames.length; index += 1) if (wanted(index)) lastWanted = index;
  const canvas = new Uint8ClampedArray(width * height * 4);
  let beforePrevious = null;
  let lastTurn = now();
  for (let index = 0; index <= lastWanted; index += 1) {
    if (signal?.aborted) throw abortError(signal);
    const frame = frames[index];
    const previous = frames[index - 1];
    if (previous?.disposal === 2) clearRectangle(gif, previous, canvas);
    else if (previous?.disposal === 3 && beforePrevious) canvas.set(beforePrevious);
    beforePrevious = frame.disposal === 3 ? canvas.slice() : null;
    drawFrame(gif, frame, canvas);
    if (wanted(index)) await onFrame?.(index, canvas);
    if (now() - lastTurn > YIELD_EVERY_MS) {
      await nextTurn();
      lastTurn = now();
    }
  }
  if (signal?.aborted) throw abortError(signal);
}
