// Pixel comparison for golden-frame tests (tests/golden-frames.test.mjs and
// tests/look-source-frames.test.mjs): a rendered PNG passes when it matches the stored one
// within a small tolerance.
import { createCanvas, loadImage } from "@napi-rs/canvas";

// A pixel only counts as different when one of its channels (R, G, B or alpha) moved by more
// than this, so tiny anti-aliasing noise is ignored.
export const CHANNEL_TOLERANCE = 8;
// A frame passes when at most this share of its pixels are different (0.1%).
export const MAX_MISMATCH_RATIO = 0.001;

/** Decodes a PNG buffer into { width, height, data } with 4 bytes (RGBA) per pixel. */
export async function decodePng(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
}

/**
 * Counts the pixels that differ between two same-sized images and builds a diff image:
 * different pixels are solid red, matching pixels are a faded copy of the expected frame.
 */
export function comparePixels(expected, actual) {
  const diff = new Uint8ClampedArray(expected.data.length);
  let mismatched = 0;
  for (let index = 0; index < expected.data.length; index += 4) {
    let largest = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      largest = Math.max(largest, Math.abs(expected.data[index + channel] - actual.data[index + channel]));
    }
    if (largest > CHANNEL_TOLERANCE) {
      mismatched += 1;
      diff.set([255, 0, 0, 255], index);
    } else {
      const gray = (expected.data[index] + expected.data[index + 1] + expected.data[index + 2]) / 3;
      const faded = 255 - (255 - gray) * 0.25;
      diff.set([faded, faded, faded, 255], index);
    }
  }
  return { mismatched, diff };
}

// A 16×16 block of pixels with more than this many different pixels fails a look-source golden
// (tests/look-source-frames.test.mjs), however few differ in all: one wrong digit or letter in a
// label is some 30–60 pixels in one or two blocks, under the 0.1% of a whole look.
export const BLOCK_SIZE = 16;
export const MAX_BLOCK_MISMATCH = 8;

/** The most pixels that differ (as comparePixels counts them) inside any one BLOCK_SIZE square. */
export function worstBlock(expected, actual) {
  const columns = Math.ceil(expected.width / BLOCK_SIZE);
  const counts = new Uint32Array(columns * Math.ceil(expected.height / BLOCK_SIZE));
  for (let y = 0; y < expected.height; y += 1) {
    for (let x = 0; x < expected.width; x += 1) {
      const index = (y * expected.width + x) * 4;
      let largest = 0;
      for (let channel = 0; channel < 4; channel += 1) largest = Math.max(largest, Math.abs(expected.data[index + channel] - actual.data[index + channel]));
      if (largest > CHANNEL_TOLERANCE) counts[Math.floor(y / BLOCK_SIZE) * columns + Math.floor(x / BLOCK_SIZE)] += 1;
    }
  }
  return counts.reduce((most, count) => Math.max(most, count), 0);
}

/** Encodes raw RGBA pixels as a PNG buffer. */
export async function encodePng(width, height, pixels) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const imageData = context.createImageData(width, height);
  imageData.data.set(pixels);
  context.putImageData(imageData, 0, 0);
  return canvas.encode("png");
}
