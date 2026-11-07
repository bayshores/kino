import { deflate } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 64_000_000;
const CRC_TABLE = new Uint32Array(256);

for (let value = 0; value < CRC_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  CRC_TABLE[value] = crc >>> 0;
}

function crc32(type, data) {
  let crc = 0xffffffff;
  for (const bytes of [type, data]) {
    for (let index = 0; index < bytes.length; index += 1) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 0xff];
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(output, offset, name, data) {
  const type = Buffer.from(name, "ascii");
  output.writeUInt32BE(data.length, offset);
  type.copy(output, offset + 4);
  data.copy(output, offset + 8);
  output.writeUInt32BE(crc32(type, data), offset + 8 + data.length);
  return offset + 12 + data.length;
}

function deflateAsync(bytes) {
  return new Promise((resolve, reject) => {
    deflate(bytes, { level: 1 }, (error, compressed) => {
      if (error) reject(error);
      else resolve(compressed);
    });
  });
}

/** Encode straight-alpha RGBA bytes as an 8-bit PNG without changing pixel values. */
export async function encodeRenderPng(pixels, width, height) {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("PNG width must be a positive integer.");
  if (!Number.isSafeInteger(height) || height < 1) throw new RangeError("PNG height must be a positive integer.");
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PIXELS) {
    throw new RangeError(`PNG dimensions must not exceed ${MAX_PIXELS} pixels.`);
  }
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
    throw new TypeError("PNG pixels must be an 8-bit RGBA typed array.");
  }
  const pixelBytes = pixelCount * 4;
  if (pixels.byteLength !== pixelBytes) throw new RangeError("PNG pixel bytes must equal width × height × 4.");

  const rowBytes = width * 4;
  const scanlineBytes = height * (rowBytes + 1);
  const scanlines = Buffer.allocUnsafe(scanlineBytes);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * (rowBytes + 1);
    scanlines[targetOffset] = 0;
    scanlines.set(pixels.subarray(sourceOffset, sourceOffset + rowBytes), targetOffset + 1);
  }

  const compressed = await deflateAsync(scanlines);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const output = Buffer.allocUnsafe(SIGNATURE.length + 25 + compressed.length + 24);
  SIGNATURE.copy(output, 0);
  let offset = SIGNATURE.length;
  offset = writeChunk(output, offset, "IHDR", header);
  offset = writeChunk(output, offset, "IDAT", compressed);
  offset = writeChunk(output, offset, "IEND", Buffer.alloc(0));
  return output.subarray(0, offset);
}
