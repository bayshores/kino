export const FULL_REVEAL = Object.freeze({
  progress: 1,
  direction: "up",
  softness: 0,
});

const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const REVEAL_KEYS = new Set(["progress", "direction", "softness"]);

/** Validate a stored reveal endpoint without adding fields to legacy records. */
export function normalizeReveal(value) {
  if (value === undefined || value === null) return FULL_REVEAL;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Reveal must be an object or null");
  }
  for (const key of Object.keys(value)) {
    if (!REVEAL_KEYS.has(key)) throw new TypeError(`Reveal has unknown field ${key}`);
  }
  if (Object.keys(value).length !== REVEAL_KEYS.size ||
      [...REVEAL_KEYS].some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Reveal needs progress, direction, and softness");
  }
  if (typeof value.progress !== "number" || !Number.isFinite(value.progress) ||
      value.progress < 0 || value.progress > 1) {
    throw new RangeError("Reveal progress must be finite and from 0 to 1");
  }
  if (typeof value.direction !== "string" || !DIRECTIONS.has(value.direction)) {
    throw new TypeError("Reveal direction must be up, down, left, or right");
  }
  if (typeof value.softness !== "number" || !Number.isFinite(value.softness) ||
      value.softness < 0 || value.softness > 100) {
    throw new RangeError("Reveal softness must be finite and from 0 to 100");
  }
  return {
    progress: value.progress,
    direction: value.direction,
    softness: value.softness,
  };
}

/** Interpolate reveal geometry; easing overshoot is clamped to valid endpoint range. */
export function interpolateReveal(from, to, progress) {
  const start = normalizeReveal(from);
  const end = normalizeReveal(to);
  if (typeof progress !== "number" || !Number.isFinite(progress)) {
    throw new TypeError("Reveal interpolation progress must be finite");
  }
  const amount = Math.max(0, Math.min(1, progress));
  return {
    progress: start.progress + (end.progress - start.progress) * amount,
    direction: amount >= 1 ? end.direction : start.direction,
    softness: start.softness + (end.softness - start.softness) * amount,
  };
}
