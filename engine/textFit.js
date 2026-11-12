// A text added with no width and no textResize used to get the model's 320 px fixed box, which wrapped
// a short line like "Engine 3.0" (recreate test GAPS friction 5). Now it sizes to its words on one
// line, and wraps only at the frame's safe width (the same 5% landscape / phone-interface insets the
// safe_zone check uses), so the first try of a weak agent reads as one line. Only a new add_layer
// does this: a stored text keeps its stored width, and a width or textResize sent with the add wins.
import { resizeTextLayer } from "./textLayout.js";
import { SAFE_ZONES } from "./quality/rules/layout.js";

/** The text layer `layer` (just created from `properties`) sized to its words, or unchanged when width or textResize was sent. */
export function fitNewText(layer, properties, scene, fonts) {
  if (layer.type !== "text" || properties.width !== undefined || properties.textResize !== undefined) return layer;
  const portrait = scene.height > scene.width;
  const zone = portrait ? SAFE_ZONES.portrait : SAFE_ZONES.landscape;
  const safeLeft = zone.left * scene.width, safeRight = scene.width * (1 - zone.right);
  const one = resizeTextLayer({ ...layer, textResize: "width-height" }, fonts);
  const room = safeRight - Math.max(safeLeft, Math.min(layer.x ?? 0, safeRight - 1));
  if (one.width <= room) return { ...layer, textResize: "width-height", width: one.width, height: one.height };
  // Longer than the room left: wrap at the safe width, the box as tall as its lines.
  const wrapped = resizeTextLayer({ ...layer, textResize: "height", width: Math.round(room) }, fonts);
  return { ...layer, textResize: "height", width: Math.round(room), height: wrapped.height };
}
