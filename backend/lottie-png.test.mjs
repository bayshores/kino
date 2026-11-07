import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { encodeLottiePng } from "./lottie-png.mjs";

function chunks(png) {
  const output = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    output.push({ type, length, start: offset, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
    if (type === "IEND") break;
  }
  return output;
}

function independentCrc(type, data) {
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from(type, "ascii"), data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("encodes 8-bit RGBA PNGs that an independent decoder can read", async () => {
  const width = 7;
  const height = 5;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set([index * 17 & 255, index * 31 & 255, index * 47 & 255, [0, 64, 128, 192, 255][index % 5]], index * 4);
  }
  pixels.set([235, 91, 17, 0], 0); // Fully transparent RGB is valid PNG data too.
  const png = encodeLottiePng(pixels, width, height);
  const parts = chunks(png);
  assert.deepEqual(parts.map(({ type }) => type), ["IHDR", "IDAT", "IEND"]);
  assert.equal(parts[0].data.readUInt32BE(0), width);
  assert.equal(parts[0].data.readUInt32BE(4), height);
  assert.equal(parts[0].data[8], 8);
  assert.equal(parts[0].data[9], 6);
  for (const chunk of parts) {
    const expected = png.readUInt32BE(chunk.start + 8 + chunk.length);
    assert.equal(expected, independentCrc(chunk.type, chunk.data), `${chunk.type} checksum`);
  }
  const filteredRows = inflateSync(Buffer.concat(parts.filter(({ type }) => type === "IDAT").map(({ data }) => data)));
  assert.equal(filteredRows.length, height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) assert.equal(filteredRows[row * (width * 4 + 1)], 2);

  const image = await loadImage(png);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const decoded = context.getImageData(0, 0, width, height).data;
  for (let index = 0; index < pixels.length; index += 4) {
    assert.equal(decoded[index + 3], pixels[index + 3], `alpha at pixel ${index / 4}`);
    if (pixels[index + 3] === 0) continue; // Canvas may discard hidden RGB when alpha is zero.
    for (let channel = 0; channel < 3; channel += 1) {
      assert.ok(Math.abs(decoded[index + channel] - pixels[index + channel]) <= 2, `pixel ${index / 4}, channel ${channel}`);
    }
  }
});

test("ImageMagick independently accepts valid PNG checksums and rejects a damaged IDAT checksum", (context) => {
  const probe = spawnSync("magick", ["-version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") return context.skip("ImageMagick is unavailable");
  assert.equal(probe.status, 0, probe.stderr);
  const png = encodeLottiePng(new Uint8Array([20, 40, 60, 255]), 1, 1);
  const valid = spawnSync("magick", ["-", "null:"], { input: png });
  assert.equal(valid.status, 0, valid.stderr.toString("utf8"));
  const damaged = Buffer.from(png);
  const idat = chunks(damaged).find(({ type }) => type === "IDAT");
  damaged[idat.start + 8 + idat.length] ^= 1;
  const invalid = spawnSync("magick", ["-", "null:"], { input: damaged });
  assert.notEqual(invalid.status, 0, "independent decoder rejects an IDAT checksum error");
});

test("splits compressed image data into 4096-byte IDAT chunks with valid CRCs", () => {
  const width = 160;
  const height = 140;
  const pixels = new Uint8Array(width * height * 4);
  let value = 0x6d2b79f5;
  for (let index = 0; index < pixels.length; index += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    pixels[index] = value & 255;
  }
  const png = encodeLottiePng(pixels, width, height);
  const idats = chunks(png).filter(({ type }) => type === "IDAT");
  assert.ok(idats.length > 1);
  assert.ok(idats.slice(0, -1).every(({ length }) => length === 4096));
  assert.ok(idats.at(-1).length <= 4096);
  assert.ok(idats.every(({ length }) => length > 0));
});

test("rejects invalid dimensions, non-8-bit inputs, and mismatched pixel buffers", () => {
  assert.throws(() => encodeLottiePng(new Uint8Array(4), 0, 1), RangeError);
  assert.throws(() => encodeLottiePng(new Uint8Array(4), 1.5, 1), RangeError);
  assert.throws(() => encodeLottiePng(new Uint8Array(4), 2, 1), RangeError);
  assert.throws(() => encodeLottiePng(new Uint16Array(2), 1, 1), TypeError);
});

test("checks cancellation while preparing rows and writing IDAT chunks", () => {
  const pixels = new Uint8Array(8 * 8 * 4);
  const rowCancel = { reads: 0, get aborted() { this.reads += 1; return this.reads === 4; }, reason: new Error("row cancel") };
  assert.throws(() => encodeLottiePng(pixels, 8, 8, { signal: rowCancel }), /row cancel/);

  const noisy = new Uint8Array(160 * 140 * 4);
  let value = 0x12345678;
  for (let index = 0; index < noisy.length; index += 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    noisy[index] = value >>> 24;
  }
  const chunkCancel = { reads: 0, get aborted() { this.reads += 1; return this.reads === 145; }, reason: new Error("chunk cancel") };
  assert.throws(() => encodeLottiePng(noisy, 160, 140, { signal: chunkCancel }), /chunk cancel/);

  const controller = new AbortController();
  controller.abort();
  assert.throws(() => encodeLottiePng(new Uint8Array(4), 1, 1, { signal: controller.signal }), { name: "AbortError" });
});
