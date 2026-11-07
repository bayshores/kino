import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IDAT_SIZE = 4096;
const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  CRC_TABLE[value] = crc >>> 0;
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function crc32(type, data) {
  let crc = 0xffffffff;
  for (const bytes of [type, data]) {
    for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(name, data), data.length + 8);
  return chunk;
}

export function encodeLottiePng(rgba, width, height, { signal } = {}) {
  if (!Number.isInteger(width) || width < 1 || width > 0x7fffffff) throw new RangeError("PNG width must be a positive 31-bit integer");
  if (!Number.isInteger(height) || height < 1 || height > 0x7fffffff) throw new RangeError("PNG height must be a positive 31-bit integer");
  if (!(Buffer.isBuffer(rgba) || rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) {
    throw new TypeError("RGBA pixels must be an 8-bit typed array");
  }
  const rowBytes = width * 4;
  const byteCount = rowBytes * height;
  if (!Number.isSafeInteger(byteCount) || rgba.byteLength !== byteCount) throw new RangeError("RGBA byte length must equal width × height × 4");

  checkAbort(signal);
  const scanlines = Buffer.allocUnsafe(height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    checkAbort(signal);
    const sourceOffset = row * rowBytes;
    const targetOffset = row * (rowBytes + 1);
    scanlines[targetOffset] = 2;
    for (let byte = 0; byte < rowBytes; byte += 1) {
      scanlines[targetOffset + byte + 1] = (rgba[sourceOffset + byte] - (row ? rgba[sourceOffset - rowBytes + byte] : 0)) & 0xff;
    }
  }

  checkAbort(signal);
  const compressed = deflateSync(scanlines, { level: 1 });
  checkAbort(signal);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [SIGNATURE, pngChunk("IHDR", header)];
  for (let offset = 0; offset < compressed.length; offset += IDAT_SIZE) {
    checkAbort(signal);
    chunks.push(pngChunk("IDAT", compressed.subarray(offset, offset + IDAT_SIZE)));
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  checkAbort(signal);
  return Buffer.concat(chunks);
}
