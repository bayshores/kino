import { CORNER_LAYER_TYPES, STROKE_LAYER_TYPES } from "./boxStyles.js";
import { BACKDROP_STYLE_KEYS } from "./backdropStyles.js";
import { TRIM_KEYS, TRIM_LAYER_TYPES } from "./strokeTrim.js";
import { REPEAT_KEYS, REPEAT_LAYER_TYPES } from "./repeater.js";

export const SHAPE_PROPERTY_TYPES = Object.freeze({
  radius: "rectangle",
  cornerRadii: "rectangle",
  donut: "ellipse",
  sweep: "ellipse",
  startAngle: "ellipse",
  spikes: "star",
  starThickness: "star",
});

// The values whose From is an optional "Initial value": a Letter spacing or Line height
// animation without one starts from the value the text has when it begins (letterSpacing.js,
// lineHeight.js). Only text layers have them.
export const INITIAL_VALUE_KEYS = new Set(["letterSpacing", "lineHeight"]);

function endpointKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

export function isAnimationCompatible(layer, animation) {
  if (animation?.kind === "composed") return Array.isArray(animation.animations) && animation.animations.every((member) => isAnimationCompatible(layer, member));
  if (animation?.kind === "effect") return Boolean(layer) && layer.type !== "audio";
  if ((animation?.textAnchor != null || animation?.textClip != null || animation?.preset?.text) && layer?.type !== "text") return false;
  // A Change text swaps a text layer's string (textChange.js); other layers have no string.
  if (animation?.kind === "change-text" && layer?.type !== "text") return false;
  // A Counter counts the number in a text layer's text (counter.js).
  if (animation?.kind === "counter" && layer?.type !== "text") return false;
  const keys = new Set([
    ...endpointKeys(animation?.from),
    ...endpointKeys(animation?.to),
  ]);

  for (const key of keys) {
    const requiredType = SHAPE_PROPERTY_TYPES[key];
    if (key === "radius" || key === "cornerRadii") {
      if (!CORNER_LAYER_TYPES.has(layer?.type)) return false;
    } else if (requiredType && layer?.type !== requiredType) return false;
    if (
      (key === "stroke" || key === "strokeWidth") &&
      !STROKE_LAYER_TYPES.has(layer?.type)
    ) {
      return false;
    }
    // Trim paths and dashes follow a shape's outline (strokeTrim.js).
    if (TRIM_KEYS.includes(key) && !TRIM_LAYER_TYPES.has(layer?.type)) return false;
    // A repeater copies a shape, path, text or group (repeater.js).
    if (REPEAT_KEYS.includes(key) && !REPEAT_LAYER_TYPES.has(layer?.type)) return false;
    // Audio is never drawn, so it has no shadow to animate.
    if ((key === "shadow" || key === "reveal" || key === "effectPreset") && layer?.type === "audio") return false;
    if (BACKDROP_STYLE_KEYS.includes(key) && layer?.type === "audio") return false;
    // Only text has letter spacing (a Letter spacing animation).
    if (key === "letterSpacing" && layer?.type !== "text") return false;
    // Only text has a line height (a Line height animation).
    if (key === "lineHeight" && layer?.type !== "text") return false;
    // Only text has variable font axes (fontAxes.js).
    if (key === "axes" && layer?.type !== "text") return false;
    // Only video and audio have sound (a Volume animation).
    if ((key === "volume" || key === "lowpass") && layer?.type !== "video" && layer?.type !== "audio") return false;
    // Only video, audio and GIF images play a file (a Speed animation, mediaTime.js).
    if (key === "speed" && layer?.type !== "video" && layer?.type !== "audio" && layer?.type !== "image") return false;
  }

  return true;
}
