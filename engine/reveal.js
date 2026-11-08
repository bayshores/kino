export const FULL_REVEAL = Object.freeze({
  progress: 1,
  direction: "up",
  softness: 0,
});

const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const REQUIRED_KEYS = ["progress", "direction", "softness"];
// Optional wipe fields (engine/wipe.js). Absent, a reveal is today's straight wipe.
export const WIPE_SHAPES = Object.freeze(["linear", "radial", "iris", "clock"]);
export const WIPE_RANGES = Object.freeze({
  angle: [-3600, 3600], centerX: [-1, 2], centerY: [-1, 2], edgeWidth: [0, 10000],
});
// invert shows the other side of the edge (the part a sequence wipe takes away), no band.
const OPTIONAL_KEYS = ["shape", "angle", "centerX", "centerY", "edgeColor", "edgeWidth", "invert"];
const REVEAL_KEYS = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
const HEX = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;
// Defaults of the optional fields: angle comes from direction for a straight wipe, -90 (12 o'clock)
// starts a clock.
export const WIPE_DEFAULTS = Object.freeze({ shape: "linear", centerX: 0.5, centerY: 0.5, edgeColor: "#FFFFFF", edgeWidth: 0, invert: false });
const DIRECTION_ANGLE = { right: 0, down: 90, left: 180, up: 270 };

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
  if (REQUIRED_KEYS.some((key) => !Object.hasOwn(value, key))) {
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
  const out = {
    progress: value.progress,
    direction: value.direction,
    softness: value.softness,
  };
  for (const key of OPTIONAL_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const next = value[key];
    if (key === "shape") {
      if (!WIPE_SHAPES.includes(next)) throw new TypeError("Reveal shape must be linear, radial, iris, or clock");
    } else if (key === "invert") {
      if (typeof next !== "boolean") throw new TypeError("Reveal invert must be true or false");
    } else if (key === "edgeColor") {
      if (typeof next !== "string" || !HEX.test(next)) throw new TypeError("Reveal edgeColor must be a hex color");
    } else {
      const [min, max] = WIPE_RANGES[key];
      if (typeof next !== "number" || !Number.isFinite(next) || next < min || next > max)
        throw new RangeError(`Reveal ${key} must be finite and from ${min} to ${max}`);
    }
    out[key] = next;
  }
  return out;
}

/** True when a reveal uses any wipe field beyond today's four straight directions. */
export function isGeneralReveal(reveal) {
  return Boolean(reveal) && OPTIONAL_KEYS.some((key) => Object.hasOwn(reveal, key));
}

/** A reveal's wipe settings with every default filled in. */
export function wipeSettings(reveal) {
  const shape = reveal.shape ?? WIPE_DEFAULTS.shape;
  const angle = reveal.angle ?? (shape === "clock" ? -90 : DIRECTION_ANGLE[reveal.direction]);
  return { ...WIPE_DEFAULTS, ...reveal, shape, angle };
}

/** Interpolate reveal geometry; easing overshoot is clamped to valid endpoint range. */
export function interpolateReveal(from, to, progress) {
  const start = normalizeReveal(from);
  const end = normalizeReveal(to);
  if (typeof progress !== "number" || !Number.isFinite(progress)) {
    throw new TypeError("Reveal interpolation progress must be finite");
  }
  const amount = Math.max(0, Math.min(1, progress));
  const out = {
    progress: start.progress + (end.progress - start.progress) * amount,
    direction: amount >= 1 ? end.direction : start.direction,
    softness: start.softness + (end.softness - start.softness) * amount,
  };
  if (!isGeneralReveal(start) && !isGeneralReveal(end)) return out;
  // Numbers move between the endpoints; shape, edge color and invert switch at the end, like direction.
  const a = wipeSettings(start), b = wipeSettings(end);
  for (const key of OPTIONAL_KEYS) {
    if (!Object.hasOwn(start, key) && !Object.hasOwn(end, key)) continue;
    out[key] = key === "shape" || key === "edgeColor" || key === "invert" ? (amount >= 1 ? b[key] : a[key])
      : a[key] + (b[key] - a[key]) * amount;
  }
  return out;
}
