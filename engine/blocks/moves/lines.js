// Moves that draw lines: draw-on (a trim-paths draw-on, Lottie's "tm").
import { easingOf } from "../tokens.js";
import { shapePath } from "../../shapes.js";
import { parsePath, serializePath } from "../../vectorPath.js";
import { contourLengths, TRIM_LAYER_TYPES } from "../../strokeTrim.js";
import { motion, round } from "./kit.js";

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// The longest contour of a shape layer as drawn (its path scaled to its box), in scene px.
export function drawnLength(layer) {
  let d;
  if (layer.type === "path") {
    const bounds = layer.pathBounds;
    const sx = bounds?.width > 0 ? layer.width / bounds.width : 1;
    const sy = bounds?.height > 0 ? layer.height / bounds.height : 1;
    const point = ([x, y]) => [x * sx, y * sy];
    d = serializePath(parsePath(String(layer.path ?? "")).map((contour) => ({
      start: point(contour.start), closed: contour.closed,
      segments: contour.segments.map((segment) => ({ c1: point(segment.c1), c2: point(segment.c2), end: point(segment.end) })),
    })));
  } else d = shapePath(layer.type, layer);
  const scale = (Math.abs(layer.scaleX ?? 1) + Math.abs(layer.scaleY ?? 1)) / 2;
  return Math.max(0, ...contourLengths(d).map((contour) => contour.length)) * scale;
}

// A paint with its alpha set to 0: "#3a8" → "#33aa8800"; a gradient's stops each go clear.
function clear(paint) {
  const hex = (color) => {
    const value = String(color).slice(1);
    const full = value.length <= 4 ? [...value].map((digit) => digit + digit).join("") : value;
    return `#${full.slice(0, 6)}00`;
  };
  if (typeof paint === "string") return hex(paint);
  return { ...paint, stops: paint.stops.map((stop) => ({ ...stop, color: hex(stop.color) })) };
}

export const drawOn = {
  name: "draw-on",
  needsAt: true,
  about: "a line, outline or route draws itself on along its stroke (strokeEnd 0 to 1) with the look's smooth ease, in 0.4 to 1.2 s by its length; a fill fades in over the last 40%",
  fits: "an underline under a word, a circle around a number, a map route, a signature, a diagram's arrows and boxes",
  tags: ["draw-on"],
  length: 0.8,
  fields: {
    layer: { kind: "layer", required: true, about: "the rectangle, ellipse, star or path layer to draw; it needs a stroke (strokeWidth above 0)" },
  },
  example: { layer: "underline", at: 0.5 },
  setup: "underline, a path layer with a stroke",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    if (!TRIM_LAYER_TYPES.has(layer.type))
      throw new Error(`draw-on layer: ${layer.id} is a ${layer.type}; give a rectangle, ellipse, star or path layer (draw text with a text animation instead).`);
    if (!(layer.strokeWidth > 0))
      throw new Error(`draw-on layer: ${layer.id} has no stroke. Give it one first: update_layer {layer:"${layer.id}", properties:{strokeWidth:4, stroke:"#ffffff"}}.`);
    // Longer lines take longer, as a pen would: 0.4 s for a short tick, 1.2 s for a long route.
    const length = drawnLength(layer);
    const duration = ctx.dur ?? round(clamp(length / (1400 * ctx.scale), 0.4, 1.2), 2);
    const easing = easingOf("move", ctx.style?.feel?.intensity ?? 0.5);
    const from = layer.strokeStart ?? 0;
    ctx.animate(layer.id, "draw", motion({ name: "Draw on", kind: "in", start: ctx.start, duration, easing,
      from: { strokeEnd: from }, to: { strokeEnd: layer.strokeEnd ?? 1 } }), "layer");
    const filled = layer.fillEnabled !== false && layer.fill && (typeof layer.fill === "object" || /^#[\da-f]{3,8}$/i.test(layer.fill));
    if (filled) ctx.animate(layer.id, "fill", motion({ name: "Fill in", kind: "in", start: ctx.start + duration * 0.6, duration: duration * 0.4,
      easing, from: { fill: clear(layer.fill) }, to: { fill: layer.fill } }), "layer");
    return { end: round(ctx.start + duration) };
  },
};
