import { cachedMap, cachedMapImage, mapDimensions } from "./maps.js";
import { inverse, point } from "../geometry.js";

function sample(image, u, v) {
  // Pixel centers, with edge extension inside the local image rectangle. Interpolate the
  // stored bytes (not the procedural noise again) so both renderers use the same static map.
  const px = Math.max(0, Math.min(image.width - 1, u * image.width - 0.5));
  const py = Math.max(0, Math.min(image.height - 1, v * image.height - 0.5));
  const x = Math.floor(px), y = Math.floor(py), fx = px - x, fy = py - y;
  const at = (xx, yy, channel) => image.pixels[(yy * image.width + xx) * 4 + channel];
  return [0, 1, 2, 3].map((channel) => Math.round(
    (at(x, y, channel) * (1 - fx) + at(Math.min(x + 1, image.width - 1), y, channel) * fx) * (1 - fy) +
    (at(x, Math.min(y + 1, image.height - 1), channel) * (1 - fx) +
      at(Math.min(x + 1, image.width - 1), Math.min(y + 1, image.height - 1), channel) * fx) * fy));
}

/**
 * A cached local PNG in Chromium; an inverse-mapped PNG for resvg when needed.
 * resvg-js 2.6.2 stretches external feImage PNGs into the transformed primitive's
 * axis-aligned integer bounds, losing rotation/shear/reflection. Prewarping into
 * those exact bounds restores the local field. Only the raster path does this;
 * browser animation retains its static PNGs and per-frame SVG mixing. Both base
 * and warped maps share the same 64-entry/16MiB pixel LRU. Source maps cap at256px;
 * export prewarps allow512px to avoid another resize at common output scales.
 * See zimond/resvg@3495d870 filter/mod.rs apply_image and tiny-skia 0.10 to_int_rect:
 * origins use floor, while WIDTH/HEIGHT independently use ceil (not the far edge).
 */
// maxSide (default 256) caps the local map's longer side, for a coarser grid of samples.
export function effectMapImage(frame, key, pixelFn, { outside = [0, 0, 0, 0], repeatBounds, maxSide } = {}) {
  const bounds = frame.bounds;
  const sourceBounds = repeatBounds ?? bounds;
  const dimensions = maxSide ? mapDimensions(sourceBounds, maxSide) : mapDimensions(sourceBounds);
  if (repeatBounds && ![repeatBounds.x, repeatBounds.y].every(Number.isFinite))
    throw new RangeError("Repeating map origins must be finite.");
  const sourceKey = JSON.stringify(["effect-map-local-v1", key, sourceBounds, ...(maxSide ? [maxSide] : [])]);
  const source = cachedMapImage(sourceKey, dimensions.width, dimensions.height, pixelFn);
  const matrix = frame.helpers.raster && frame.helpers.transform;
  if (!Array.isArray(matrix)) return source.uri;
  const toLocal = inverse(matrix);
  if (!toLocal) return source.uri; // a singular transform has no painted area
  const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]]
    .map(([x, y]) => point(matrix, x, y));
  const left = Math.min(...corners.map(({ x }) => x)), top = Math.min(...corners.map(({ y }) => y));
  const width = Math.max(...corners.map(({ x }) => x)) - left;
  const height = Math.max(...corners.map(({ y }) => y)) - top;
  if (!repeatBounds && matrix[0] > 0 && matrix[3] > 0 && Math.abs(matrix[1]) + Math.abs(matrix[2]) < 1e-12 &&
    [left, top, width, height].every((value) => Math.abs(value - Math.round(value)) < 1e-9)) return source.uri;
  const region = { x: Math.floor(left), y: Math.floor(top), width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) };
  // A coarse grid needs no 512 px prewarp: twice its side keeps its points sharp.
  const size = mapDimensions(region, maxSide ? Math.min(512, 2 * maxSide) : 512);
  const cacheKey = JSON.stringify(["raster-map-v1", key, bounds, matrix, region, outside, repeatBounds ?? null]);
  return cachedMap(cacheKey, size.width, size.height, (x, y, mapWidth, mapHeight) => {
    const local = point(toLocal, region.x + (x + 0.5) * region.width / mapWidth,
      region.y + (y + 0.5) * region.height / mapHeight);
    let u = (local.x - bounds.x) / bounds.width, v = (local.y - bounds.y) / bounds.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return outside;
    if (repeatBounds) {
      // feTile repeats the already painted, edge-clamped cell. Interpolating a
      // full periodic source PNG would instead blend across its discontinuities.
      // Wrap first, then keep all bilinear taps inside the original cell bytes.
      const wrap = (value, size) => ((value % size) + size) % size;
      u = wrap(local.x - repeatBounds.x, repeatBounds.width) / repeatBounds.width;
      v = wrap(local.y - repeatBounds.y, repeatBounds.height) / repeatBounds.height;
    }
    return sample(source, u, v);
  });
}
