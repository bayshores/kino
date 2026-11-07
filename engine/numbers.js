// Small number and value helpers that many engine, frontend and backend files share.

/** `value` kept between min and max (min wins when min is above max; NaN stays NaN). */
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** `value` kept between 0 and 1 (NaN stays NaN). */
export const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** `value` rounded to `places` decimals; 3 keeps milliseconds of a time in seconds. */
export const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

/** True for any object that is not null and not an array. */
export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The smooth 0 to 1 ease of `value` (clamped to 0..1 first): 3t² - 2t³. */
export function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}
