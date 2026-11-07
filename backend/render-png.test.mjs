import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { encodeRenderPng } from "./render-png.mjs";

function pngChunks(png) {
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    assert.ok(end <= png.length, `${type} chunk is complete`);
    chunks.push({ type, length, offset, data: png.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  assert.equal(chunks.at(-1)?.type, "IEND");
  assert.equal(chunks.at(-1)?.offset + 12, png.length);
  return chunks;
}

function independentCrc(type, data) {
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from(type, "ascii"), data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function testPixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let value = 0x7f4a7c15;
  const alphas = [0, 1, 2, 17, 64, 127, 128, 191, 254, 255];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    const offset = pixel * 4;
    pixels[offset] = value & 0xff;
    pixels[offset + 1] = (value >>> 8) & 0xff;
    pixels[offset + 2] = (value >>> 16) & 0xff;
    pixels[offset + 3] = alphas[pixel % alphas.length];
  }
  return pixels;
}

test("writes a valid 8-bit RGBA PNG preserving opaque, translucent, and transparent bytes", async () => {
  const width = 17;
  const height = 11;
  const source = testPixels(width, height);
  const storage = new Uint8ClampedArray(source.length + 12);
  storage.set(source, 6);
  const pixels = storage.subarray(6, 6 + source.length);
  const before = Buffer.from(pixels);
  const png = await encodeRenderPng(pixels, width, height);

  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = pngChunks(png);
  assert.deepEqual(chunks.map(({ type }) => type), ["IHDR", "IDAT", "IEND"]);
  const header = chunks[0].data;
  assert.equal(header.readUInt32BE(0), width);
  assert.equal(header.readUInt32BE(4), height);
  assert.equal(header[8], 8);
  assert.equal(header[9], 6);
  for (const chunk of chunks) {
    const expected = png.readUInt32BE(chunk.offset + 8 + chunk.length);
    assert.equal(expected, independentCrc(chunk.type, chunk.data), `${chunk.type} CRC`);
  }

  const scanlines = inflateSync(Buffer.concat(chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data)));
  const rowBytes = width * 4;
  assert.equal(scanlines.length, height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    const scanline = row * (rowBytes + 1);
    assert.equal(scanlines[scanline], 0, `row ${row} uses PNG filter 0`);
    assert.deepEqual(scanlines.subarray(scanline + 1, scanline + 1 + rowBytes),
      before.subarray(row * rowBytes, (row + 1) * rowBytes));
  }
  assert.deepEqual(Buffer.from(pixels), before, "encoding does not mutate the source pixels");
  assert.ok(Array.from({ length: width * height }, (_, index) => pixels[index * 4 + 3]).includes(0));
  assert.ok(Array.from({ length: width * height }, (_, index) => pixels[index * 4 + 3]).some(alpha => alpha > 0 && alpha < 255));
});

test("accepts byte buffers and enforces dimensions, pixel count, and exact RGBA length", async () => {
  const buffer = Buffer.from([20, 40, 60, 255]);
  const png = await encodeRenderPng(buffer, 1, 1);
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);

  await assert.rejects(encodeRenderPng(new Uint8Array(4), 0, 1), RangeError);
  await assert.rejects(encodeRenderPng(new Uint8Array(4), 1, 0), RangeError);
  await assert.rejects(encodeRenderPng(new Uint8Array(4), 1.5, 1), RangeError);
  await assert.rejects(encodeRenderPng(new Uint8Array(0), 8192, 8193), RangeError);
  await assert.rejects(encodeRenderPng(new Uint8Array(3), 1, 1), RangeError);
  await assert.rejects(encodeRenderPng(new Uint16Array(2), 1, 1), TypeError);
});
