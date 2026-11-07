// Resvg's side of desktop/raster-page.cjs flattenTilts, for every Resvg frame (drafts and finals).
//
// A tilted layer (engine/render.js, triangleTiltTag) is drawn as a grid of triangles, each a pattern
// that draws the layer's whole flat drawing again. Inside a pattern, Resvg gives every clip path,
// filter and partly transparent group of that drawing a canvas of its own, triangle after
// triangle: a tilted app screen of a product trailer (4 pictures, 3 clips, 2 blurs) took 62 s a
// 960x540 frame with the full grid and about 9 s with a draft's. So each flat drawing is drawn
// once, into a bitmap at OVERSAMPLE times the most output pixels one of its units reaches
// (data-kino-flatten, already in output pixels), and each triangle's pattern gets the piece of
// that bitmap under its own grid cell (a picture is decoded every time Resvg draws it, so one
// shared picture of the whole drawing would be decoded once a triangle).
//
// The bitmap is drawn from the frame's own SVG with the whole frame kept as definitions, so every
// clip, gradient, mask and filter the drawing uses resolves as it does in the frame. Inner tilts
// are flattened first, so an outer drawing holds their pictures. A drawing that links a picture
// (anything but a data: URL) keeps the triangles, as in Chromium; so does a pattern that is not in
// render.js's form.
import { Resvg } from "@resvg/resvg-js";
import { encodeRenderPng } from "./render-png.mjs";

const OVERSAMPLE = 2;
// At most this many pixels a bitmap. A draft: 16 times the frame's own pixels, at least 1
// megapixel (raster-page.cjs DRAFT_FLAT_FACTOR, DRAFT_FLAT_MIN). A final: 48 megapixels
// (FLAT_PIXELS), and a drawing that would get fewer pixels than the output shows keeps its
// triangles.
const FLAT_FACTOR = 16;
const FLAT_MIN = 1024 * 1024;
const FLAT_PIXELS = 48 * 1024 * 1024;

const SOURCE = /<g id="([^"]+)" data-kino-flatten="([^"]+)" data-kino-box="([^"]+)">/g;
const NUMBER = "(-?[\\d.]+(?:e-?\\d+)?)";

// Where the <g> opened at `start` closes (the index of its "</g>"), or -1.
function groupEnd(svg, start) {
  const tag = /<(\/?)g(?=[\s>/])[^>]*?(\/?)>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let match; (match = tag.exec(svg));) {
    if (match[2]) continue;
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The straight-alpha RGBA of the bitmap's pixels [x0, x1) x [y0, y1) (Resvg's are premultiplied).
function crop(bitmap, x0, y0, x1, y1) {
  const width = x1 - x0, height = y1 - y0, out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y0 + row) * bitmap.width + x0) * 4;
    out.set(bitmap.pixels.subarray(from, from + width * 4), row * width * 4);
  }
  for (let index = 0; index < out.length; index += 4) {
    const alpha = out[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    for (let channel = index; channel < index + 3; channel += 1) out[channel] = Math.min(255, Math.round(out[channel] * 255 / alpha));
  }
  return { pixels: out, width, height };
}

/**
 * Returns `svg` with each tilted layer's triangles filled from one bitmap of its flat drawing, or
 * `svg` itself when it has no tilted layer. `options` are the frame's Resvg options (its fonts).
 * `draft` (check, look and draft render frames) caps the bitmap by the frame's size.
 */
export async function flattenTilts(svg, options = {}, { draft = false } = {}) {
  if (!svg.includes("data-kino-flatten=")) return svg;
  const root = /^\s*(?:<\?xml[^>]*>\s*)?(<svg\b[^>]*>)/.exec(svg);
  if (!root) return svg;
  const outputWidth = Number(/\swidth="([\d.]+)"/.exec(root[1])?.[1]);
  const outputHeight = Number(/\sheight="([\d.]+)"/.exec(root[1])?.[1]);
  const limit = draft ? Math.min(FLAT_PIXELS, Math.max(FLAT_MIN, FLAT_FACTOR * outputWidth * outputHeight || 0)) : FLAT_PIXELS;
  // Inner ones (later in the text) first.
  for (const match of [...svg.matchAll(SOURCE)].reverse()) {
    const [open, id, reachText, boxText] = match;
    const start = match.index, end = groupEnd(svg, start);
    if (end < 0) continue;
    const reach = Number(reachText);
    const [x, y, width, height] = boxText.split(" ").map(Number);
    if (!(reach > 0) || ![x, y, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) continue;
    const content = svg.slice(start + open.length, end);
    if ([...content.matchAll(/<(?:image|feImage)\b[^>]*?\shref="([^"]*)"/g)].some(([, href]) => !href.startsWith("data:") && !href.startsWith("#"))) continue;
    let scale = Math.ceil(reach * OVERSAMPLE * 4) / 4;
    if (width * height * scale * scale > limit) scale = Math.sqrt(limit / (width * height));
    if (scale < reach && !draft) continue;
    const size = [Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale))];
    const body = svg.slice(root.index + root[0].length, svg.lastIndexOf("</svg>"));
    const flat = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size[0]}" height="${size[1]}" viewBox="${x} ${y} ${width} ${height}" preserveAspectRatio="none"><defs>${body}</defs><use href="#${id}"/></svg>`;
    const rendered = new Resvg(flat, { ...options, fitTo: { mode: "original" } }).render();
    const bitmap = { pixels: rendered.pixels, width: rendered.width, height: rendered.height };
    const unitX = bitmap.width / width, unitY = bitmap.height / height;
    // Each pattern of this drawing in render.js's form gets the piece under its cell, 3 pixels of
    // margin around it (the tile clips to the cell; with 1, the picture's own soft edge showed as
    // dark dots and short lines inside a solid card).
    const pattern = new RegExp(`(<pattern id="[^"]+" patternUnits="userSpaceOnUse" x="${NUMBER}" y="${NUMBER}" width="${NUMBER}" height="${NUMBER}" patternTransform="[^"]*">)<use href="#${escapeRegExp(id)}" transform="translate\\(${NUMBER} ${NUMBER}\\)"/>(</pattern>)`, "g");
    const pieces = [];
    for (const cell of svg.matchAll(pattern)) {
      const [, , , , cellWidth, cellHeight, shiftX, shiftY] = cell.map(Number);
      const left = -shiftX, top = -shiftY;
      const x0 = Math.max(0, Math.floor((left - x) * unitX) - 3), y0 = Math.max(0, Math.floor((top - y) * unitY) - 3);
      const x1 = Math.min(bitmap.width, Math.ceil((left + cellWidth - x) * unitX) + 3), y1 = Math.min(bitmap.height, Math.ceil((top + cellHeight - y) * unitY) + 3);
      let fill = "";
      if (x1 > x0 && y1 > y0) {
        const piece = crop(bitmap, x0, y0, x1, y1);
        const png = Buffer.from(await encodeRenderPng(piece.pixels, piece.width, piece.height));
        fill = `<image x="${x + x0 / unitX - left}" y="${y + y0 / unitY - top}" width="${piece.width / unitX}" height="${piece.height / unitY}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString("base64")}"/>`;
      }
      pieces.push({ index: cell.index, length: cell[0].length, text: `${cell[1]}${fill}${cell.at(-1)}` });
    }
    // Patterns not in that form still draw the source: it keeps the whole bitmap for them.
    let rest = svg;
    for (const piece of pieces.reverse()) rest = rest.slice(0, piece.index) + piece.text + rest.slice(piece.index + piece.length);
    const used = rest.includes(`href="#${id}"`) || rest.includes(`url(#${id})`);
    const whole = used ? `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${rendered.asPng().toString("base64")}"/>` : "";
    // The pieces changed the text's length before the source (render.js writes the patterns first
    // in its <defs>): find the source again in `rest`.
    const sourceStart = rest.indexOf(open), sourceEnd = sourceStart < 0 ? -1 : groupEnd(rest, sourceStart);
    if (sourceEnd < 0) continue;
    svg = `${rest.slice(0, sourceStart)}<g id="${id}">${whole}${rest.slice(sourceEnd)}`;
  }
  return svg;
}
