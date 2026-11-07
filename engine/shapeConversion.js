import { shapePath } from "./shapes.js";

const CONVERTIBLE_TYPES = new Set(["rectangle", "ellipse", "star"]);

/** Return whether a parametric layer can become an editable path layer. */
export function canConvertToShape(layer) {
  if (!layer || !CONVERTIBLE_TYPES.has(layer.type)) return false;
  if (
    layer.type === "ellipse" &&
    (layer.donut ?? 0) !== 0 &&
    (layer.sweep ?? 1) === 1
  ) {
    return false;
  }
  return true;
}

/** Bake a supported primitive's base geometry into a local cubic path. */
export function convertLayerToShape(layer) {
  if (!canConvertToShape(layer)) {
    const type = layer?.type ?? "unknown";
    const reason =
      type === "ellipse" &&
      (layer.donut ?? 0) !== 0 &&
      (layer.sweep ?? 1) === 1
        ? "a full donut ellipse cannot be converted"
        : `layer type "${String(type)}" cannot be converted`;
    throw new TypeError(
      `Cannot convert to shape: ${reason}; only rectangles, stars, and eligible ellipses are supported.`,
    );
  }

  const converted = structuredClone(layer);
  const originalType = layer.type;
  converted.type = "path";
  converted.convertedFrom = originalType;
  converted.path = shapePath(originalType, layer);
  converted.pathBounds = {
    x: 0,
    y: 0,
    width: layer.width,
    height: layer.height,
  };
  return converted;
}
