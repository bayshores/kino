// A picture's alpha grid for moves that push into or mask a picture (push-through-type): the
// picture drawn into a small grid, 1 where a cell is mostly opaque. Read once per file.
import { open } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const CELLS = 64;
const kept = new Map();

/** The grid of the picture at /api/media/<id> in mediaRoot ({columns, rows, solid}), or null when it cannot be read. */
export function pictureAlpha(mediaRoot, src) {
  const id = /^\/api\/media\/([A-Za-z0-9._-]+)$/.exec(String(src ?? ""))?.[1];
  if (!mediaRoot || !id || id.includes("..")) return Promise.resolve(null);
  const file = path.join(mediaRoot, id);
  if (!kept.has(file)) kept.set(file, (async () => {
    const image = await loadImage(file);
    const long = Math.max(image.width, image.height);
    const columns = Math.max(1, Math.round((CELLS * image.width) / long));
    const rows = Math.max(1, Math.round((CELLS * image.height) / long));
    const canvas = createCanvas(columns, rows);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, columns, rows);
    const { data } = context.getImageData(0, 0, columns, rows);
    const solid = new Uint8Array(columns * rows);
    for (let index = 0; index < solid.length; index += 1) solid[index] = data[index * 4 + 3] >= 160 ? 1 : 0;
    return { columns, rows, solid };
  })().catch(() => null));
  return kept.get(file);
}

// A WebM video track's AlphaMode element (ID 0x53C0, one byte long, value 1): the file keeps an
// alpha channel. It sits in the track header near the start of the file.
const WEBM_ALPHA = Buffer.from([0x53, 0xc0, 0x81, 0x01]);
const HEAD_BYTES = 64 * 1024;

/**
 * True when the file at /api/media/<id> lets what is under it show: a picture with a clear part
 * (its alpha grid), or a WebM video with an alpha channel. False when it cannot be read.
 */
export async function seeThrough(mediaRoot, src) {
  const id = /^\/api\/media\/([A-Za-z0-9._-]+)$/.exec(String(src ?? ""))?.[1];
  if (!mediaRoot || !id || id.includes("..")) return false;
  if (/\.webm$/i.test(id)) {
    let handle = null;
    try {
      handle = await open(path.join(mediaRoot, id), "r");
      const head = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
      return head.subarray(0, bytesRead).includes(WEBM_ALPHA);
    } catch { return false; } finally { await handle?.close(); }
  }
  const grid = await pictureAlpha(mediaRoot, src);
  return Boolean(grid?.solid.some((cell) => !cell));
}
