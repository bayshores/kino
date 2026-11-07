import { evaluateLayer } from "../engine/animation.js";
import { defaultFonts } from "../engine/fonts.js";
import { resizeTextLayer } from "../engine/textLayout.js";
import { shownTextAt } from "../engine/textChangeDraw.js";

/**
 * Geometry for canvas outlines and text-box hits. Inherited text retains the source's stored
 * box, so remeasure it in Design as well as Animate, keeping the same alignment anchors as
 * render.js. These measured values belong to the view and are never saved as overrides.
 */
export function canvasLayerState(layer, { mode = "design", time = 0, fonts = defaultFonts } = {}) {
  const state = mode === "animate" ? evaluateLayer(layer, time) : layer;
  if (state.type !== "text") return state;
  try {
    return resizeTextLayer(mode === "animate" ? { ...state, text: shownTextAt(layer, time) } : state, fonts);
  } catch {
    // The drawing reports an unavailable font; keep the saved box until it can be loaded.
    return state;
  }
}
