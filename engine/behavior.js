// Behaviors: declarative motion that would otherwise need an expression.
//
// An in, out or custom animation may have `behavior: { wiggle?, loop? }`:
//   wiggle { amount, rate?: 2, seed?: 0 }  adds smooth random drift to the animated numbers.
//     amount is a number (the same for every numeric key) or { key: number } (only those keys,
//     added to the animation's from and to at the layer's own value when it leaves them out).
//     rate is about how many drifts a second; seed picks another random pattern.
//   loop { mode: "cycle" | "pingpong" }  plays the animation again and again after its start:
//     cycle starts over each time, pingpong plays forward then backward.
//
// Everything here is a pure function of time and seed (no Math.random, no state), so the same
// document always draws the same frame, cached preview segments stay exact and Lottie bakes the
// result into ordinary keyframes by sampling each frame.
//
// The wiggle is fractal value noise (ported from ArtCraft, see wiggleOffset): WIGGLE_OCTAVES
// layers, each twice as fast and half as strong as the one before, with a quintic fade between
// knots, so it drifts like a hand-held camera instead of easing from point to point. A taper one
// drift long at each end brings it to 0 with no speed, so a wiggle starts and ends at the
// animation's own value (no jump), and a cycling loop repeats it seamlessly.
import { isRecord } from "./numbers.js";

export const LOOP_MODES = Object.freeze(["cycle", "pingpong"]);
export const WIGGLE_RATE = 2;
const MAX_RATE = 30;
const MAX_SEED = 2 ** 31 - 1;
const MAX_AMOUNT = 100000;

const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** True when the animation repeats after its start (a loop behavior). */
export const loops = (animation) => isRecord(animation?.behavior?.loop);

/**
 * The time inside one pass of the animation, 0..duration, for `elapsed` seconds after its start.
 * Without a loop it is elapsed itself (clamped by the caller's progress).
 */
export function behaviorTime(animation, elapsed, duration) {
  const mode = animation?.behavior?.loop?.mode;
  if (!mode || !(duration > 0) || elapsed <= 0) return elapsed;
  if (mode === "pingpong") {
    const phase = elapsed % (2 * duration);
    return phase <= duration ? phase : 2 * duration - phase;
  }
  // cycle: the end of one pass is the start of the next.
  return elapsed % duration;
}

// A 32-bit integer hash (lowbias32) of the numbers, then mapped to -1..1.
function hash(...values) {
  let state = 0x9e3779b9;
  for (const value of values) {
    state = Math.imul(state ^ (value >>> 0), 0x7feb352d);
    state ^= state >>> 15;
    state = Math.imul(state, 0x846ca68b);
    state ^= state >>> 16;
  }
  return ((state >>> 0) / 0xffffffff) * 2 - 1;
}

function keyNumber(key) {
  let value = 0;
  for (let index = 0; index < key.length; index += 1) value = Math.imul(value, 31) + key.charCodeAt(index) | 0;
  return value;
}

/**
 * The wiggle's drift for `key` at `local` seconds into a pass of `duration` seconds: a number in
 * -amount..amount, 0 at the pass's start and end. Returns 0 when the key does not wiggle.
 */
export function wiggleOffset(wiggle, key, local, duration) {
  const amount = finiteNumber(wiggle?.amount) ? wiggle.amount : wiggle?.amount?.[key];
  if (!finiteNumber(amount) || amount === 0 || !(duration > 0)) return 0;
  const rate = finiteNumber(wiggle.rate) && wiggle.rate > 0 ? wiggle.rate : WIGGLE_RATE;
  const seed = Number.isInteger(wiggle.seed) ? wiggle.seed : 0;
  const time = Math.max(0, Math.min(duration, local));
  // Octaves as in ArtCraft EffectCraft, effectcraft/crates/expr/src/noise.rs `wiggle` (MIT OR
  // Apache-2.0, (c) the ArtCraft authors): amplitude halves and frequency doubles per octave, and
  // each octave starts at its own seeded phase so the octaves never share knots.
  let sum = 0;
  for (let octave = 0, weight = 1, frequency = rate; octave < WIGGLE_OCTAVES; octave++, weight *= 0.5, frequency *= 2) {
    const phase = (hash(seed, keyNumber(key), octave, 1) + 1) * 500;
    sum += weight * noise1(seed, keyNumber(key) + octave, frequency * time + phase);
  }
  // Scaled to one octave's spread, then softly held inside -1..1, so the amount means what it did.
  const drift = softLimit(sum / OCTAVE_SPREAD);
  // The taper: 0 with no speed at the pass's start and end, full strength one drift (1/rate s) in.
  const edge = Math.min(1 / rate, duration / 2);
  const taper = fade(Math.min(1, time / edge)) * fade(Math.min(1, (duration - time) / edge));
  return amount * drift * taper;
}

export const WIGGLE_OCTAVES = 3;
const OCTAVE_SPREAD = Math.sqrt(1 + 0.25 + 0.0625);

// Quintic fade t^3 (t (6t - 15) + 10): zero speed and acceleration at both ends (C2).
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Smooth 1D value noise in -1..1: seeded knot values with a quintic fade between them. Ported
 * from ArtCraft EffectCraft, effectcraft/crates/expr/src/noise.rs `noise1` (MIT OR Apache-2.0,
 * (c) the ArtCraft authors), with kino's 32-bit hash for the knots.
 */
export function noise1(seed, channel, x) {
  if (!Number.isFinite(x)) return 0;
  const index = Math.floor(x);
  const a = hash(seed, channel, index), b = hash(seed, channel, index + 1);
  return a + (b - a) * fade(x - index);
}

// The identity up to 0.75, then a tanh shoulder that never passes 1 (same slope at the joint).
function softLimit(value) {
  const size = Math.abs(value);
  return size <= 0.75 ? value : Math.sign(value) * (0.75 + 0.25 * Math.tanh((size - 0.75) / 0.25));
}

/**
 * A checked copy of a behavior, or throws an Error that says what is wrong. `isKey(key)` tells
 * whether a wiggle amount key is a number property the animation may change.
 */
export function normalizeBehavior(raw, isKey = () => true) {
  if (!isRecord(raw)) throw new Error("must be an object such as {loop:{mode:\"cycle\"}} or {wiggle:{amount:8}}");
  const unknown = Object.keys(raw).filter((key) => key !== "wiggle" && key !== "loop");
  if (unknown.length) throw new Error(`has no ${unknown.join(", ")}: use wiggle and/or loop`);
  const behavior = {};
  if (raw.wiggle !== undefined && raw.wiggle !== null) behavior.wiggle = normalizeWiggle(raw.wiggle, isKey);
  if (raw.loop !== undefined && raw.loop !== null) {
    const loop = typeof raw.loop === "string" ? { mode: raw.loop } : raw.loop;
    if (!isRecord(loop) || !LOOP_MODES.includes(loop.mode) || Object.keys(loop).length !== 1)
      throw new Error(`loop must be {mode: "cycle"} or {mode: "pingpong"}`);
    behavior.loop = { mode: loop.mode };
  }
  if (!Object.keys(behavior).length) throw new Error("needs wiggle or loop");
  return behavior;
}

function normalizeWiggle(raw, isKey) {
  if (!isRecord(raw)) throw new Error("wiggle must be {amount, rate?, seed?}");
  const unknown = Object.keys(raw).filter((key) => !["amount", "rate", "seed"].includes(key));
  if (unknown.length) throw new Error(`wiggle has no ${unknown.join(", ")}: use amount, rate and seed`);
  const checkAmount = (value, label) => {
    if (!finiteNumber(value) || value < 0 || value > MAX_AMOUNT) throw new Error(`${label} must be a number from 0 to ${MAX_AMOUNT}`);
    return value;
  };
  let amount;
  if (isRecord(raw.amount)) {
    const keys = Object.keys(raw.amount);
    if (!keys.length) throw new Error("wiggle.amount names no property");
    for (const key of keys) if (!isKey(key)) throw new Error(`wiggle.amount.${key}: only number properties such as x, y, rotation, scaleX or opacity can wiggle`);
    amount = Object.fromEntries(keys.map((key) => [key, checkAmount(raw.amount[key], `wiggle.amount.${key}`)]));
  } else amount = checkAmount(raw.amount, "wiggle.amount");
  const rate = raw.rate === undefined ? WIGGLE_RATE : raw.rate;
  if (!finiteNumber(rate) || rate <= 0 || rate > MAX_RATE) throw new Error(`wiggle.rate must be above 0 and at most ${MAX_RATE} (drifts a second)`);
  const seed = raw.seed === undefined ? 0 : raw.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) throw new Error("wiggle.seed must be a whole number from 0");
  return { amount, rate, seed };
}
