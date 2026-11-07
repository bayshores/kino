// Image layers draw the same colors with resvg and with Chromium.
//
// Chromium (Skia) reads a picture's color tags: a PNG's iCCP, cICP, gAMA and cHRM chunks, a
// JPEG's ICC profile and its EXIF orientation. resvg reads none of them. So a user's photo with a
// Display P3 profile, or a PNG with a gAMA chunk, drew different pixels whenever any layer of the
// scene needed Chromium, and a check compared frames drawn by different renderers.
// Before a render, such a picture is converted once to plain sRGB (with Skia, as a browser shows
// it) and written back without tags, so both renderers draw the same pixels.
// Video pictures get the same treatment from FFmpeg (PICTURE_COLOR_FILTERS in media-probe.mjs).
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_COLOR_CHUNKS = new Set(["iCCP", "cICP", "sRGB", "gAMA", "cHRM"]);
// Quality for a converted JPEG: visually the same, and far smaller than a PNG of a photo.
const JPEG_QUALITY = 95;

// PNG chunks as { type, start, end } (end is past the CRC), or null when the file is not a PNG.
function pngChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const end = offset + 12 + buffer.readUInt32BE(offset);
    if (end > buffer.length) return null;
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    chunks.push({ type, start: offset, end });
    if (type === "IEND") break;
    offset = end;
  }
  return chunks;
}

// JPEG segments before the image data as { marker, start, end, body }, or null when not a JPEG.
function jpegSegments(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const segments = [];
  for (let offset = 2; offset + 4 <= buffer.length;) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const end = offset + 2 + buffer.readUInt16BE(offset + 2);
    if (end > buffer.length) return null;
    segments.push({ marker, start: offset, end, body: buffer.subarray(offset + 4, end) });
    offset = end;
  }
  return segments;
}

const isIccSegment = (segment) => segment.marker === 0xe2 && segment.body.toString("latin1", 0, 12) === "ICC_PROFILE\0";
const isExifSegment = (segment) => segment.marker === 0xe1 && segment.body.toString("latin1", 0, 6) === "Exif\0\0";

// The EXIF orientation (1 to 8) of a JPEG's APP1 segment, or 1 when it has none.
function exifOrientation(segment) {
  const tiff = segment.body.subarray(6);
  if (tiff.length < 8) return 1;
  const little = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (at) => (at + 2 <= tiff.length ? (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)) : 0);
  const u32 = (at) => (at + 4 <= tiff.length ? (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at)) : 0);
  const ifd = u32(4);
  for (let index = 0, count = u16(ifd); index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
  }
  return 1;
}

/**
 * What a picture's color tags need: `convert` when Chromium would draw other colors (or another
 * orientation) than resvg, `strip` when the tags only say sRGB and can be dropped as they are.
 */
export function imageColorTags({ buffer, mime }) {
  if (mime === "image/png") {
    const types = new Set((pngChunks(buffer) ?? []).map((chunk) => chunk.type).filter((type) => PNG_COLOR_CHUNKS.has(type)));
    // An sRGB chunk overrides gAMA and cHRM; an ICC profile or cICP overrides sRGB.
    const convert = types.has("iCCP") || types.has("cICP") || (!types.has("sRGB") && (types.has("gAMA") || types.has("cHRM")));
    return { convert, strip: types.size > 0 };
  }
  if (mime === "image/jpeg" || mime === "image/jpg") {
    const segments = jpegSegments(buffer) ?? [];
    const convert = segments.some(isIccSegment) || segments.some((segment) => isExifSegment(segment) && exifOrientation(segment) !== 1);
    return { convert, strip: convert };
  }
  return { convert: false, strip: false };
}

// The same file without its color tags (pixels unchanged).
function withoutTags(buffer, mime) {
  if (mime === "image/png") {
    const chunks = pngChunks(buffer);
    if (!chunks) return buffer;
    return Buffer.concat([PNG_SIGNATURE, ...chunks.filter((chunk) => !PNG_COLOR_CHUNKS.has(chunk.type)).map((chunk) => buffer.subarray(chunk.start, chunk.end))]);
  }
  const segments = jpegSegments(buffer);
  if (!segments) return buffer;
  const dropped = segments.filter((segment) => isIccSegment(segment) || isExifSegment(segment));
  if (!dropped.length) return buffer;
  const parts = [buffer.subarray(0, 2)];
  let offset = 2;
  for (const segment of dropped) {
    parts.push(buffer.subarray(offset, segment.start));
    offset = segment.end;
  }
  parts.push(buffer.subarray(offset));
  return Buffer.concat(parts);
}

/**
 * The picture as both renderers draw it alike: converted to plain sRGB and upright when its tags
 * change how Chromium draws it, with sRGB-only tags dropped, and otherwise unchanged.
 * `cache` (a Map) shares one conversion between layers that use the same file.
 */
export async function untaggedImage(media, cache) {
  const { convert, strip } = imageColorTags(media);
  if (!strip) return media;
  if (!convert) return { ...media, buffer: withoutTags(media.buffer, media.mime) };
  const key = createHash("sha256").update(media.buffer).digest("hex");
  if (cache?.has(key)) return cache.get(key);
  let image;
  try {
    image = await loadImage(media.buffer);
  } catch {
    // A picture Skia cannot read draws as it did before (neither renderer can show it either),
    // instead of failing the whole render.
    return media;
  }
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const png = media.mime === "image/png";
  const encoded = png ? await canvas.encode("png") : await canvas.encode("jpeg", JPEG_QUALITY);
  const result = { ...media, mime: png ? "image/png" : "image/jpeg", buffer: withoutTags(encoded, png ? "image/png" : "image/jpeg") };
  cache?.set(key, result);
  return result;
}
