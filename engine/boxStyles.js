// Images, videos and groups used to store these properties without drawing them. Version 4
// keeps the old values, but marks each formerly unused style inactive. An explicit edit wakes
// only that style. Drawing reads the effective state; saving keeps the original stored values.
export const BOX_LAYER_TYPES = new Set(["group", "image", "video"]);
export const CORNER_LAYER_TYPES = new Set(["rectangle", ...BOX_LAYER_TYPES]);
export const STROKE_LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path", "text", ...BOX_LAYER_TYPES]);

const STYLE_KEYS = {
  fill: ["fill", "fillEnabled"],
  stroke: ["stroke", "strokeWidth", "strokeAlign"],
  corners: ["radius", "cornerRadii"],
};

export function legacyBoxStyles(type) {
  return type === "group" ? ["fill", "stroke", "corners"]
    : type === "image" || type === "video" ? ["stroke", "corners"] : [];
}

/** A drawing/Inspector copy. Animation may then change its effective resting values. */
export function effectiveBoxStyle(layer) {
  if (!BOX_LAYER_TYPES.has(layer?.type) || !layer.inactiveBoxStyles?.length) return layer;
  const next = { ...layer };
  if (layer.inactiveBoxStyles.includes("fill")) next.fillEnabled = false;
  if (layer.inactiveBoxStyles.includes("stroke")) next.strokeWidth = 0;
  if (layer.inactiveBoxStyles.includes("corners")) {
    next.radius = 0;
    next.cornerRadii = null;
  }
  delete next.inactiveBoxStyles;
  return next;
}

/** Add the activation metadata to an intentional property edit, never to a saved snapshot. */
export function boxStylePatch(layer, patch) {
  if (!patch || !BOX_LAYER_TYPES.has(layer?.type) || !layer.inactiveBoxStyles?.length) return patch;
  const remaining = layer.inactiveBoxStyles.filter((style) => !STYLE_KEYS[style]?.some((key) => Object.hasOwn(patch, key)));
  if (remaining.length === layer.inactiveBoxStyles.length) return patch;
  // A uniform edit must not unexpectedly resurrect dormant independent corners.
  const uniform = layer.inactiveBoxStyles.includes("corners") && Object.hasOwn(patch, "radius") && !Object.hasOwn(patch, "cornerRadii");
  return { ...patch, ...(uniform ? { cornerRadii: null } : {}), inactiveBoxStyles: remaining };
}

/** Version 3 instance overrides silently discarded these newly supported properties. */
export function isLegacyStyleOverride(layer, key) {
  return legacyBoxStyles(layer?.type).some((style) => STYLE_KEYS[style].includes(key)) ||
    (layer?.type === "group" && key === "clipContent");
}
