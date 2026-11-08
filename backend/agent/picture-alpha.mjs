// A picture's alpha grid for moves that push into or mask a picture (push-through-type): the
// picture drawn into a small grid, 1 where a cell is mostly opaque. Read once per file.
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
