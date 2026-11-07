import test from "node:test";
import assert from "node:assert/strict";
import { GIF_DECODER_VERSION, composeGifFrames, decodeLzw, gifDelaySeconds, parseGif, parseGifStart } from "./gifDecode.js";

// Expected pixels below were checked against Chromium's own GIF decoder (WebCodecs ImageDecoder).
const BLACK = [0, 0, 0];
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const CLEAR = [0, 0, 0, 0];
const fill = (count, index) => new Array(count).fill(index);
const u16 = (value) => [value & 0xff, value >> 8];

/**
 * Builds a GIF89a byte by byte.
 * palette: [[r, g, b], ...] or null; frames: [{ left, top, width, height, indexes (rows top to bottom),
 * disposal, transparentIndex, delayCs, interlaced, localPalette, encodedPixels (stop early, no end code) }].
 */
function buildGif({ width, height, palette, background = 0, frames }) {
  const bytes = [..."GIF89a"].map((char) => char.charCodeAt(0));
  bytes.push(...u16(width), ...u16(height));
  const tableBits = paletteBits(palette);
  bytes.push(palette ? 0x80 | (tableBits - 1) : 0, background, 0);
  if (palette) bytes.push(...paletteBytes(palette, tableBits));
  for (const frame of frames) {
    const transparent = frame.transparentIndex ?? -1;
    const flags = ((frame.disposal ?? 0) << 2) | (transparent >= 0 ? 1 : 0);
    bytes.push(0x21, 0xf9, 4, flags, ...u16(frame.delayCs ?? 10), Math.max(0, transparent), 0);
    const local = frame.localPalette;
    const localBits = local ? paletteBits(local) : 0;
    bytes.push(0x2c, ...u16(frame.left ?? 0), ...u16(frame.top ?? 0), ...u16(frame.width), ...u16(frame.height));
    bytes.push((local ? 0x80 | (localBits - 1) : 0) | (frame.interlaced ? 0x40 : 0));
    if (local) bytes.push(...paletteBytes(local, localBits));
    const codeSize = Math.max(2, local ? localBits : tableBits);
    let indexes = frame.interlaced ? interlace(frame.indexes, frame.width, frame.height) : frame.indexes;
    if (frame.encodedPixels !== undefined) indexes = indexes.slice(0, frame.encodedPixels);
    bytes.push(codeSize, ...subBlocks(lzw(indexes, codeSize, frame.encodedPixels === undefined)));
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

function paletteBits(palette) {
  let bits = 1;
  while (1 << bits < (palette?.length ?? 2)) bits += 1;
  return bits;
}

function paletteBytes(palette, bits) {
  const bytes = new Array((1 << bits) * 3).fill(0);
  palette.forEach((color, index) => bytes.splice(index * 3, 3, ...color));
  return bytes;
}

function interlace(indexes, width, height) {
  const rows = [];
  for (const [first, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
    for (let row = first; row < height; row += step) rows.push(row);
  return rows.flatMap((row) => indexes.slice(row * width, (row + 1) * width));
}

// LZW without compression: a clear code before the table grows keeps every code the same width.
function lzw(indexes, codeSize, withEndCode) {
  const clear = 1 << codeSize;
  const bytes = [];
  let bits = 0;
  let count = 0;
  const write = (code) => {
    bits |= code << count;
    count += codeSize + 1;
    while (count >= 8) {
      bytes.push(bits & 0xff);
      bits >>>= 8;
      count -= 8;
    }
  };
  indexes.forEach((index, position) => {
    if (position % (clear - 2) === 0) write(clear);
    write(index);
  });
  if (withEndCode) write(clear + 1);
  if (count > 0) bytes.push(bits & 0xff);
  return bytes;
}

function subBlocks(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.slice(offset, offset + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return blocks;
}

/** Decodes every frame and returns a pixel reader per frame. */
async function frames(bytes) {
  const gif = parseGif(bytes);
  const pictures = [];
  await composeGifFrames(gif, { onFrame: (index, rgba) => { pictures[index] = rgba.slice(); } });
  return pictures.map((rgba) => (x, y) => [...rgba.subarray((y * gif.width + x) * 4, (y * gif.width + x) * 4 + 4)]);
}

test("the canvas starts transparent: a partial first frame without transparency leaves the rest clear", async () => {
  // The background index points at black, which browsers ignore.
  const [first, second] = await frames(buildGif({ width: 16, height: 16, palette: [BLACK, RED, GREEN], background: 0, frames: [
    { left: 4, top: 4, width: 8, height: 8, indexes: fill(64, 1), disposal: 1 },
    { width: 2, height: 2, indexes: fill(4, 2), disposal: 1 },
  ] }));
  assert.deepEqual(first(14, 14), CLEAR);
  assert.deepEqual(first(0, 0), CLEAR);
  assert.deepEqual(first(5, 5), [...RED, 255]);
  assert.deepEqual(second(0, 0), [...GREEN, 255]);
  assert.deepEqual(second(14, 14), CLEAR);
  assert.deepEqual(second(8, 8), [...RED, 255], "disposal 1 keeps the earlier frame");
});

test("disposal 2 clears the frame's rectangle to transparent even without a transparent index", async () => {
  const pictures = await frames(buildGif({ width: 16, height: 16, palette: [BLACK, RED, GREEN, WHITE, BLUE], background: 3, frames: [
    { width: 16, height: 16, indexes: fill(256, 1), disposal: 1 },
    { left: 4, top: 4, width: 8, height: 8, indexes: fill(64, 2), disposal: 2 },
    { width: 1, height: 1, indexes: [4], disposal: 1 },
  ] }));
  assert.deepEqual(pictures[1](8, 8), [...GREEN, 255]);
  assert.deepEqual(pictures[2](8, 8), CLEAR, "not the white background color");
  assert.deepEqual(pictures[2](5, 5), CLEAR);
  assert.deepEqual(pictures[2](0, 0), [...BLUE, 255]);
  assert.deepEqual(pictures[2](1, 1), [...RED, 255]);
});

test("disposal 3 restores the canvas from before the frame, also for the first frame", async () => {
  const pictures = await frames(buildGif({ width: 16, height: 16, palette: [BLACK, RED, GREEN, WHITE, BLUE], frames: [
    { width: 16, height: 16, indexes: fill(256, 1), disposal: 1 },
    { left: 4, top: 4, width: 8, height: 8, indexes: fill(64, 2), disposal: 3 },
    { width: 1, height: 1, indexes: [4], disposal: 1 },
  ] }));
  assert.deepEqual(pictures[1](8, 8), [...GREEN, 255]);
  assert.deepEqual(pictures[2](8, 8), [...RED, 255]);
  assert.deepEqual(pictures[2](0, 0), [...BLUE, 255]);

  const firstRestored = await frames(buildGif({ width: 8, height: 8, palette: [BLACK, RED, GREEN], frames: [
    { width: 8, height: 8, indexes: fill(64, 1), disposal: 3 },
    { width: 2, height: 2, indexes: fill(4, 2) },
  ] }));
  assert.deepEqual(firstRestored[0](5, 5), [...RED, 255]);
  assert.deepEqual(firstRestored[1](5, 5), CLEAR, "restoring before frame 0 gives the empty canvas");
  assert.deepEqual(firstRestored[1](1, 1), [...GREEN, 255]);
});

test("transparent pixels keep what is underneath, and frames are clipped to the canvas", async () => {
  const transparent = await frames(buildGif({ width: 4, height: 4, palette: [BLACK, RED, GREEN, BLUE], frames: [
    { width: 4, height: 4, indexes: fill(16, 1) },
    { width: 4, height: 4, transparentIndex: 0, indexes: Array.from({ length: 16 }, (_, index) => (index % 2 ? 2 : 0)) },
  ] }));
  assert.deepEqual(transparent[1](0, 0), [...RED, 255]);
  assert.deepEqual(transparent[1](1, 0), [...GREEN, 255]);

  const clipped = await frames(buildGif({ width: 6, height: 6, palette: [BLACK, RED, GREEN], frames: [
    { width: 6, height: 6, indexes: fill(36, 1), disposal: 1 },
    { left: 4, top: 4, width: 4, height: 4, indexes: fill(16, 2), disposal: 2 },
    { width: 1, height: 1, indexes: [1] },
  ] }));
  assert.deepEqual(clipped[1](5, 5), [...GREEN, 255]);
  assert.deepEqual(clipped[1](3, 5), [...RED, 255], "the frame's columns past the canvas edge are dropped, not wrapped");
  assert.deepEqual(clipped[2](5, 5), CLEAR);
  assert.deepEqual(clipped[2](3, 3), [...RED, 255]);
});

test("interlaced rows, local palettes, and indexes past the palette", async () => {
  // Row r uses color r % 4, so a row in the wrong place shows the wrong color.
  const palette = [BLACK, RED, GREEN, BLUE];
  const [interlaced] = await frames(buildGif({ width: 4, height: 10, palette, frames: [
    { width: 4, height: 10, interlaced: true, indexes: Array.from({ length: 40 }, (_, index) => Math.floor(index / 4) % 4) },
  ] }));
  for (let row = 0; row < 10; row += 1) assert.deepEqual(interlaced(2, row), [...palette[row % 4], 255], `row ${row}`);

  const [local] = await frames(buildGif({ width: 4, height: 4, palette: null, frames: [
    { width: 4, height: 4, indexes: fill(16, 1), localPalette: [BLACK, [255, 255, 0]] },
  ] }));
  assert.deepEqual(local(3, 3), [255, 255, 0, 255]);

  // A two-color palette with indexes 2 and 3: Chromium shows them as opaque black.
  const [outside] = await frames(buildGif({ width: 4, height: 1, palette: [RED, GREEN], frames: [
    { width: 4, height: 1, indexes: [0, 1, 2, 3] },
  ] }));
  assert.deepEqual([0, 1, 2, 3].map((x) => outside(x, 0)), [[...RED, 255], [...GREEN, 255], [0, 0, 0, 255], [0, 0, 0, 255]]);
});

test("truncated LZW data paints what was decoded and leaves the rest of that frame unpainted", async () => {
  const [, second] = await frames(buildGif({ width: 4, height: 4, palette: [BLACK, RED, GREEN, BLUE], frames: [
    { width: 4, height: 4, indexes: fill(16, 1) },
    { width: 4, height: 4, indexes: fill(16, 2), encodedPixels: 6 },
  ] }));
  assert.deepEqual(second(0, 0), [...GREEN, 255]);
  assert.deepEqual(second(1, 1), [...GREEN, 255], "pixel 5 was decoded");
  assert.deepEqual(second(3, 3), [...RED, 255], "the undecoded end keeps the previous frame");

  // Codes past the table and a missing first literal stop decoding instead of throwing.
  const output = new Uint8Array(4);
  assert.equal(decodeLzw(Uint8Array.from([1, 0b00000111, 0]), 0, 3, 2, output), 0, "code 7 cannot start a frame");
  assert.equal(decodeLzw(Uint8Array.from([]), 0, 0, 2, output), 0);
  assert.equal(decodeLzw(Uint8Array.from([1, 0]), 0, 2, 9, output), 0, "code sizes above 8 are not GIF data");
});

test("real compressed LZW data, including codes that are not in the table yet, decodes correctly", () => {
  // Six 1s with min code size 2: clear, 1, 6 (= 1 1, not in the table yet), 7 (= 1 1 1), then end.
  // Adding entry 7 fills the 3-bit codes, so the end code is 4 bits wide.
  const codes = [[4, 3], [1, 3], [6, 3], [7, 3], [5, 4]];
  let bits = 0;
  let count = 0;
  const data = [];
  for (const [code, width] of codes) {
    bits |= code << count;
    count += width;
    while (count >= 8) {
      data.push(bits & 0xff);
      bits >>>= 8;
      count -= 8;
    }
  }
  if (count) data.push(bits & 0xff);
  const bytes = Uint8Array.from([data.length, ...data, 0]);
  const output = new Uint8Array(6);
  assert.equal(decodeLzw(bytes, 0, bytes.length, 2, output), 6);
  assert.deepEqual([...output], fill(6, 1));
});

test("delays follow the browser rule and match the server's earlier ffprobe timings", () => {
  const gif = parseGif(buildGif({ width: 2, height: 2, palette: [BLACK, RED], frames: [0, 1, 2, 5, 7].map((delayCs) => ({ width: 2, height: 2, delayCs, indexes: fill(4, 1) })) }));
  assert.deepEqual(gif.durations, [0.1, 0.1, 0.02, 0.05, 0.07]);
  assert.deepEqual([gifDelaySeconds(0), gifDelaySeconds(0.0199), gifDelaySeconds(0.02), gifDelaySeconds(0.1234)], [0.1, 0.1, 0.02, 0.123]);
});

test("over-budget GIFs are rejected from their headers before any pixel is decoded", () => {
  const header = (width, height) => Uint8Array.from([..."GIF89a"].map((char) => char.charCodeAt(0)).concat(u16(width), u16(height), [0, 0, 0]));
  assert.throws(() => parseGif(header(5000, 5000)), (error) => error.code === "GIF_TOO_LARGE" && /5000 x 5000/.test(error.message));

  // Frames whose data is damaged: parsing never looks at it, so the limit decides alone.
  const frameBlock = (width, height) => [0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0, 2, 1, 0xff, 0];
  const withFrames = (width, height, count, frame = frameBlock(1, 1)) => {
    const bytes = [...header(width, height)];
    for (let index = 0; index < count; index += 1) bytes.push(...frame);
    return Uint8Array.from(bytes);
  };
  assert.equal(parseGif(withFrames(1, 1, 10_000)).frames.length, 10_000);
  assert.throws(() => parseGif(withFrames(1, 1, 10_001)), (error) => error.code === "GIF_TOO_LARGE" && /more than 10,000 frames/.test(error.message));
  assert.throws(() => parseGif(withFrames(4000, 4000, 63)), (error) => error.code === "GIF_TOO_LARGE" && /pixels across its frames/.test(error.message));
  assert.equal(parseGif(withFrames(4000, 4000, 62)).frames.length, 62);
  assert.throws(() => parseGif(withFrames(1, 1, 1, frameBlock(5000, 5000))), (error) => error.code === "GIF_TOO_LARGE" && /Frame 1/.test(error.message));

  assert.throws(() => parseGif(Uint8Array.from([1, 2, 3])), (error) => error.code === "GIF_UNREADABLE");
  assert.throws(() => parseGif(header(4, 4)), (error) => error.code === "GIF_UNREADABLE" && /no readable frames/.test(error.message));
});

test("composing stops after the last wanted frame, waits for each onFrame, and can be cancelled", async () => {
  const gif = parseGif(buildGif({ width: 2, height: 1, palette: [BLACK, RED, GREEN, BLUE], frames: [1, 2, 3, 1].map((index) => ({ width: 2, height: 1, indexes: [index, index] })) }));
  const seen = [];
  await composeGifFrames(gif, { wanted: (index) => index === 1 || index === 2, onFrame: (index, rgba) => { seen.push([index, [...rgba.subarray(0, 4)]]); } });
  assert.deepEqual(seen, [[1, [...GREEN, 255]], [2, [...BLUE, 255]]]);

  const controller = new AbortController();
  const delivered = [];
  await assert.rejects(composeGifFrames(gif, {
    onFrame: (index) => {
      delivered.push(index);
      if (index === 1) controller.abort();
    },
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.deepEqual(delivered, [0, 1], "no frame is drawn after the abort");

  // A slow onFrame is awaited before the next frame is drawn.
  const order = [];
  await composeGifFrames(gif, {
    wanted: (index) => index < 2,
    onFrame: async (index) => {
      order.push(`start ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${index}`);
    },
  });
  assert.deepEqual(order, ["start 0", "end 0", "start 1", "end 1"]);
});

/** A copy of `bytes` whose frame `frameIndex` (0 is the first) says its LZW minimum code size is `codeSize`. */
function withLzwCodeSize(bytes, frameIndex, codeSize) {
  const copy = bytes.slice();
  copy[parseGif(bytes).frames[frameIndex].dataStart - 1] = codeSize;
  return copy;
}

test("an LZW minimum code size above 8 is a decode error, because Chromium cannot decode that frame", () => {
  const bytes = buildGif({ width: 2, height: 2, palette: [BLACK, RED], frames: [1, 1].map((index) => ({ width: 2, height: 2, indexes: fill(4, index) })) });
  assert.equal(parseGif(withLzwCodeSize(bytes, 0, 8)).frames.length, 2, "8 is the largest code size browsers decode");
  for (const codeSize of [9, 12, 15, 255]) {
    assert.throws(() => parseGif(withLzwCodeSize(bytes, 0, codeSize)), (error) =>
      error.code === "GIF_UNREADABLE" && error.message === `Frame 1 of this GIF has an LZW code size of ${codeSize}, which browsers cannot decode.`);
  }
  assert.throws(() => parseGif(withLzwCodeSize(bytes, 1, 12)), (error) => error.code === "GIF_UNREADABLE" && /^Frame 2 /.test(error.message));
});

test("firstFrames reads only the start of a GIF, so later frames are neither listed nor checked", () => {
  const bytes = buildGif({ width: 2, height: 1, palette: [BLACK, RED, GREEN, BLUE], frames: [1, 2, 3].map((index, position) => ({ width: 2, height: 1, delayCs: 10 * (position + 1), indexes: [index, index] })) });
  const damagedThird = withLzwCodeSize(bytes, 2, 12);
  const start = parseGif(damagedThird, { firstFrames: 2 });
  assert.equal(start.frames.length, 2);
  assert.deepEqual(start.durations, [0.1, 0.2]);
  assert.throws(() => parseGif(damagedThird), { code: "GIF_UNREADABLE" }, "reading every frame finds the bad third frame");
  assert.equal(parseGif(bytes).frames.length, 3);
});

test("the decoder has a version number that caches can store", () => {
  assert.ok(Number.isSafeInteger(GIF_DECODER_VERSION) && GIF_DECODER_VERSION >= 1);
});

test("parseGifStart reads the first frame of a GIF too large to play, and says whether it is animated", () => {
  const big = buildGif({ width: 6000, height: 4000, palette: [BLACK, RED], frames: [{ width: 1, height: 1, indexes: [1] }] });
  assert.throws(() => parseGif(big), { code: "GIF_TOO_LARGE" }, "playing every frame keeps the smaller limit");
  const still = parseGifStart(big);
  assert.equal(still.width, 6000);
  assert.equal(still.frames.length, 1);
  assert.equal(still.animated, false);
  const huge = buildGif({ width: 9000, height: 9000, palette: [BLACK, RED], frames: [{ width: 1, height: 1, indexes: [1] }] });
  assert.throws(() => parseGifStart(huge), (error) => error.code === "GIF_TOO_LARGE" && /33,554,432 pixels/.test(error.message));

  const two = buildGif({ width: 2, height: 1, palette: [BLACK, RED, GREEN, BLUE], frames: [1, 2].map((index) => ({ width: 2, height: 1, delayCs: 20, indexes: [index, index] })) });
  const start = parseGifStart(two);
  assert.equal(start.animated, true);
  assert.deepEqual(start.durations, [0.2], "only the first frame is returned");
  const badSecond = parseGifStart(withLzwCodeSize(two, 1, 12));
  assert.equal(badSecond.animated, true, "a second frame that cannot be read still makes the GIF animated");
  assert.equal(badSecond.frames.length, 1);
  assert.throws(() => parseGifStart(withLzwCodeSize(two, 0, 12)), { code: "GIF_UNREADABLE" }, "a bad first frame cannot be drawn");
});
