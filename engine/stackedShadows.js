// Stacked shadows: a layer's optional `shadows` list, drawn after its single `shadow`.
// Each entry is a drop shadow plus an opacity: { color, x, y, blur, opacity? (0..1, default 1) }.
// Later entries paint over earlier ones; the layer paints over all of them. Long shadows,
// a soft shadow under a hard one and neon glow stacks are lists. The list is static: an
// animation moves the single `shadow` only.
import { SHADOW_LIMITS, shadowAlpha } from "./shadowInterpolation.js";

export const MAX_STACKED_SHADOWS = 32;

/**
 * The checked list, or throws a message naming the bad part. `path` names the field.
 * null, undefined and [] mean no list (the caller deletes the field).
 */
export function normalizeShadowList(value, path = "shadows") {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error(`${path} must be a list of shadows [{color, x, y, blur, opacity?}]`);
  if (value.length > MAX_STACKED_SHADOWS) throw new Error(`${path} holds at most ${MAX_STACKED_SHADOWS} shadows`);
  if (!value.length) return null;
  return value.map((entry, index) => {
    const at = `${path}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} must be {color, x, y, blur, opacity?}`);
    const extra = Object.keys(entry).filter((key) => !["color", "x", "y", "blur", "opacity"].includes(key));
    if (extra.length) throw new Error(`${at} has unknown field ${extra[0]}; a shadow is {color, x, y, blur, opacity?}`);
    if (typeof entry.color !== "string" || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(entry.color))
      throw new Error(`${at}.color must be a hex color such as #000000 or #00000080`);
    const number = (key, min, max, fallback) => {
      const given = entry[key] ?? fallback;
      if (typeof given !== "number" || !Number.isFinite(given) || given < min || given > max)
        throw new Error(`${at}.${key} must be a number from ${min} to ${max}`);
      return given;
    };
    const shadow = {
      color: entry.color,
      x: number("x", -SHADOW_LIMITS.offset, SHADOW_LIMITS.offset, 0),
      y: number("y", -SHADOW_LIMITS.offset, SHADOW_LIMITS.offset, 0),
      blur: number("blur", 0, SHADOW_LIMITS.blur, 0),
    };
    if (entry.opacity !== undefined) shadow.opacity = number("opacity", 0, 1, 1);
    return shadow;
  });
}

const strength = (shadow) => shadowAlpha(shadow.color) * (typeof shadow.opacity === "number" ? shadow.opacity : 1);

/** The list entries that paint (alpha times opacity above 0), or [] for none. */
export function stackedShadows(state) {
  return Array.isArray(state?.shadows) ? state.shadows.filter((shadow) => shadow && typeof shadow === "object" && strength(shadow) > 0) : [];
}

/** The flood opacity one shadow paints with (its color's alpha times its opacity). */
export const shadowStrength = strength;
