// Motion tokens: named durations, easings, type sizes and colour roles.
// An agent writes "standard" or "enter" instead of a free number; the server turns the name
// into seconds or a cubic-bezier curve. The bands and the enter and move curves follow the
// medians measured in 404 public motion templates: a fade 0.2 s, an entrance 0.7 to 0.85 s, a
// move 1 s or more, all on one smooth curve (0.5, 0, 0, 1). The calm
// feel sits at 0.6 of each band so a 15 s four-beat promo still fits.
import { round } from "../numbers.js";

/** Duration bands in seconds: [shortest, longest]. */
export const DURATIONS = Object.freeze({
  micro: Object.freeze([0.15, 0.3]),
  standard: Object.freeze([0.5, 0.9]),
  emphasis: Object.freeze([0.7, 1.0]),
  hero: Object.freeze([1.0, 2.0]),
});

/** Easing curves as cubic-bezier [x1, y1, x2, y2], at intensity 0.5. */
export const EASING_TOKENS = Object.freeze({
  enter: Object.freeze([0.5, 0, 0, 1]),
  exit: Object.freeze([0.3, 0, 0.8, 0.15]),
  move: Object.freeze([0.5, 0, 0, 1]),
  hero: Object.freeze([0.4, 0.14, 0.3, 1]),
});

/** The six steps of a type scale, largest first. */
export const TYPE_STEPS = Object.freeze(["display", "h1", "h2", "body", "label", "caption"]);

/** The five colour roles a look or brand fills. */
export const COLOR_ROLES = Object.freeze(["bg", "surface", "text", "accent", "accent2"]);

/**
 * Motion feels: where in each duration band a look sits (0 = shortest, 1 = longest) and how
 * strong its easing is (0 = gentle, 1 = sharp).
 */
export const FEELS = Object.freeze({
  snappy: Object.freeze({ position: 0.25, intensity: 0.75 }),
  smooth: Object.freeze({ position: 0.5, intensity: 0.5 }),
  calm: Object.freeze({ position: 0.6, intensity: 0.35 }),
});

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Seconds for a duration name. `position` 0–1 picks a point in the band (0.5 is the middle). */
export function durationOf(name, position = 0.5) {
  const band = DURATIONS[name];
  if (!band) throw new Error(`Unknown duration "${name}". Durations: ${Object.keys(DURATIONS).join(", ")}.`);
  return round(band[0] + (band[1] - band[0]) * clamp(position, 0, 1), 2);
}

/**
 * The cubic-bezier for an easing name at an intensity from 0 to 1. Intensity 0.5 is the curve
 * in the table. Each control point's y moves away from (or toward) its x: k = 0.4 + 1.2 × intensity,
 * y' = x + k(y − x), kept between 0 and 1. The result is never a straight line.
 */
export function easingOf(name, intensity = 0.5) {
  const curve = EASING_TOKENS[name];
  if (!curve) throw new Error(`Unknown easing token "${name}". Easing tokens: ${Object.keys(EASING_TOKENS).join(", ")}.`);
  const level = clamp(Number.isFinite(intensity) ? intensity : 0.5, 0, 1);
  if (level === 0.5) return [...curve];
  const k = 0.4 + 1.2 * level;
  const [x1, y1, x2, y2] = curve;
  return [x1, round(clamp(x1 + k * (y1 - x1), 0, 1)), x2, round(clamp(x2 + k * (y2 - x2), 0, 1))];
}

/** A feel by name, or the smooth feel. */
export function feelOf(name) {
  return FEELS[name] ?? FEELS.smooth;
}

/**
 * Reads an easing written as a token: "enter", "exit:0.8" (with an intensity), or
 * {token: "enter", intensity: 0.8}. Returns null when the value is not a token.
 */
export function easingFromToken(value) {
  if (typeof value === "string") {
    const match = /^(enter|exit|move|hero)(?::(\d*\.?\d+))?$/.exec(value.trim());
    if (!match) return null;
    return easingOf(match[1], match[2] === undefined ? 0.5 : Number(match[2]));
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.token === "string" && EASING_TOKENS[value.token])
    return easingOf(value.token, value.intensity ?? 0.5);
  return null;
}

/** Reads a duration written as a token ("standard", "hero:0.2"). Returns null when it is not one. */
export function durationFromToken(value) {
  if (typeof value !== "string") return null;
  const match = /^(micro|standard|emphasis|hero)(?::(\d*\.?\d+))?$/.exec(value.trim());
  if (!match) return null;
  return durationOf(match[1], match[2] === undefined ? 0.5 : Number(match[2]));
}
