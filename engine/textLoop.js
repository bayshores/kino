// A text layer's loop (`textLoop`): a motion each letter, word or line keeps playing between the
// layer's in and out animations, on top of them. Optional; a layer without it draws as before.
//
// textLoop { style, amount?, speed?, stagger?, unit?, seed?, ramp? }
//   style   wave: units rise and fall in sequence (a sine that travels along the text)
//           float: each unit bobs and sways on its own seeded phase and pace, out of step
//           pulse: each unit grows and shrinks about its own center
//           jitter: each unit jumps to a seeded spot (and tilt) `speed` times a second
//   amount  pixels the unit moves (wave, float, jitter; jitter also tilts amount / 2 degrees),
//           or percent it grows (pulse)
//   speed   cycles a second (jumps a second for jitter); stagger: seconds each unit lags the last
//   unit    letters (default) | words | lines; seed picks float and jitter's pattern
//   ramp    seconds the loop eases in after a unit's in ends and out before its out starts
// For each unit the loop runs from the end of its latest in animation (from the start without
// one) to the start of its earliest out animation (forever without one), and is 0 outside it.
// Every value is a pure function of time and seed, so preview, exports and Lottie (sampled) agree.

export const TEXT_LOOP_STYLES = Object.freeze(["wave", "float", "pulse", "jitter"]);
export const TEXT_LOOP_UNITS = Object.freeze(["letters", "words", "lines"]);
export const TEXT_LOOP_DEFAULTS = Object.freeze({
  wave: Object.freeze({ amount: 12, speed: 1, stagger: 0.08 }),
  float: Object.freeze({ amount: 8, speed: 0.5, stagger: 0 }),
  pulse: Object.freeze({ amount: 12, speed: 1, stagger: 0.08 }),
  jitter: Object.freeze({ amount: 3, speed: 8, stagger: 0 }),
});
export const TEXT_LOOP_RAMP = 0.3;
const LIMITS = Object.freeze({ amount: [0, 1000], speed: [0.01, 60], stagger: [0, 10], seed: [0, 4294967295], ramp: [0, 10] });
const FIELDS = ["style", "amount", "speed", "stagger", "unit", "seed", "ramp"];

const finite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** The checked loop, or throws a RangeError naming the field (model.js wraps it). */
export function normalizeTextLoop(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RangeError("must be {style, amount?, speed?, stagger?, unit?, seed?, ramp?}");
  for (const key of Object.keys(raw)) if (!FIELDS.includes(key)) throw new RangeError(`.${key} is not ${FIELDS.join(", ")}`);
  if (!TEXT_LOOP_STYLES.includes(raw.style)) throw new RangeError(`.style must be ${TEXT_LOOP_STYLES.join(", ")}`);
  const loop = { style: raw.style };
  for (const key of ["amount", "speed", "stagger", "seed", "ramp"]) {
    if (raw[key] == null) continue;
    const [low, high] = LIMITS[key];
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < low || raw[key] > high)
      throw new RangeError(`.${key} must be a number from ${low} to ${high}`);
    if (key === "seed" && !Number.isInteger(raw[key])) throw new RangeError(".seed must be a whole number");
    loop[key] = raw[key];
  }
  if (raw.unit != null) {
    if (!TEXT_LOOP_UNITS.includes(raw.unit)) throw new RangeError(`.unit must be ${TEXT_LOOP_UNITS.join(", ")}`);
    loop.unit = raw.unit;
  }
  return loop;
}

export const textLoopUnit = (loop) => loop?.unit ?? "letters";

// 0 outside [from, to], 1 a ramp inside each end, smoothstep between.
function envelope(time, from, to, ramp) {
  if (!(time > from && time < to)) return 0;
  const side = (gap) => (ramp > 0 ? smooth(Math.min(1, gap / ramp)) : 1);
  return (Number.isFinite(from) ? side(time - from) : 1) * (Number.isFinite(to) ? side(to - time) : 1);
}
const smooth = (t) => t * t * (3 - 2 * t);

/** A number from -1 to 1 for the seed, unit, step and channel: integer hashing, the same everywhere. */
export function noise(seed, index, step, channel) {
  let hash = 0x9e3779b9;
  for (const value of [seed, index, step, channel]) {
    hash = Math.imul(hash ^ (value >>> 0), 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;
  }
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * One unit's loop offset at `time` (the layer's clock): {x, y, rotation, scale} in the layer's
 * own axes, scaled by the envelope of [from, to] (the unit's in end and out start).
 */
export function textLoopOffset(loop, index, time, from = -Infinity, to = Infinity) {
  const none = { x: 0, y: 0, rotation: 0, scale: 1 };
  const base = TEXT_LOOP_DEFAULTS[loop?.style];
  if (!base) return none;
  const strength = envelope(time, from, to, Math.max(0, finite(loop.ramp, TEXT_LOOP_RAMP)));
  if (strength <= 0) return none;
  const amount = finite(loop.amount, base.amount) * strength;
  const speed = finite(loop.speed, base.speed);
  const seed = Math.floor(finite(loop.seed, 1));
  const local = time - index * finite(loop.stagger, base.stagger);
  const turn = 2 * Math.PI;
  if (loop.style === "wave") return { ...none, y: -amount * Math.sin(turn * speed * local) };
  if (loop.style === "pulse") return { ...none, scale: 1 + (amount / 100) * (0.5 - 0.5 * Math.cos(turn * speed * local)) };
  if (loop.style === "float") {
    const pace = speed * (1 + 0.25 * noise(seed, index, 0, 0));
    return { ...none, y: -amount * Math.sin(turn * (pace * local + noise(seed, index, 0, 1))),
      x: 0.3 * amount * Math.sin(Math.PI * pace * local + turn * noise(seed, index, 0, 2)) };
  }
  const step = Math.floor(speed * local);
  return { x: amount * noise(seed, index, step, 0), y: amount * noise(seed, index, step, 1), rotation: 0.5 * amount * noise(seed, index, step, 2), scale: 1 };
}
