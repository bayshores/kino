// Behaviors: declarative motion that would otherwise need an expression.
//
// An in, out, custom or effect animation may have `behavior: { wiggle?, oscillate?, ramp?,
// randomize?, loop? }` (loop not on an effect). Each adds an offset to the animated numbers:
//   wiggle { amount, rate?: 2, seed?: 0, decay?: 0 }  adds smooth random drift to the animated
//     numbers; decay per second dies it down (the drift is times e^(-decay t)).
//     amount is a number (the same for every numeric key) or { key: number } (only those keys,
//     added to the animation's from and to at the layer's own value when it leaves them out).
//     rate is about how many drifts a second; seed picks another random pattern.
//   oscillate { amount, period?: 1, phase?: 0, wave?: "sine", decay?: 0 }  a repeating wave:
//     period seconds a cycle, phase a share 0..1 of a cycle, wave sine | triangle | square | saw,
//     decay per second (the swing is times e^(-decay t)).
//   ramp { to, from?: 0, start?: 0, duration?, ease?: "linear" }  an offset that moves from `from`
//     to `to` between start and start + duration seconds into the animation (default: to its end);
//     both stretch when the animation's duration changes (retimeBehavior).
//   randomize { amount, rate?: 2, seed?: 0, mode?: "smooth" }  a new random value in -amount..amount
//     `rate` times a second: smooth glides between them, stepped jumps.
//   overshoot { bounce?: 0.3, settle?: 0.6 }  after the animation ends, each number carries on
//     past its end value (the first swing bounce times its last move) and springs back, settled
//     to the end value settle seconds later. It leaves at the move's end speed (keys: the last
//     step; a motion path along its end direction).
//   follow { layer, property?, lag?: 0.1, scale?: 1, offset?: 0 }  adds the named layer's move
//     (its value lag seconds earlier minus its own saved value) times scale, plus offset. The
//     leader's values are sampled into `track` whenever the document is edited (behaviorLinks.js).
//   audio { layer, band?: "all", amount, smoothing?: 0.15 }  adds amount times the sound layer's
//     level 0..1 in a band (low under 150 Hz, mid to 2.5 kHz, high above, all); the level rises at
//     once and falls with smoothing seconds. The levels are measured into `levels` by the edit.
//   loop { mode: "cycle" | "pingpong" }  plays the animation again and again after its start:
//     cycle starts over each time, pingpong plays forward then backward.
// amount (and ramp's to and from) is one number for every animated number, or { key: number }.
// Offsets use the time into the pass, held after the animation ends.
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
import { easingAt, normalizeEasing } from "./easing.js";

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
  // decay per second dies the drift down by e^(-decay t): a shake that settles (a hit's aftershock).
  const dying = finiteNumber(wiggle.decay) && wiggle.decay > 0 ? Math.exp(-wiggle.decay * time) : 1;
  return amount * drift * taper * dying;
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

export const WAVES = Object.freeze(["sine", "triangle", "square", "saw"]);
export const RANDOM_MODES = Object.freeze(["smooth", "stepped"]);
const OFFSET_KINDS = ["wiggle", "oscillate", "ramp", "randomize", "follow", "audio"];
export const AUDIO_BANDS = Object.freeze(["all", "low", "mid", "high"]);
// A baked track or level list holds at most this many values (10 minutes at 60 a second).
export const MAX_TRACK_VALUES = 36000;
const MAX_PERIOD = 3600;
const MAX_DECAY = 100;
const MAX_RANDOM_RATE = 60;
// randomize draws from its own noise channels, so the same seed as a wiggle gives another pattern.
const RANDOM_SALT = 104729;

const fract = (value) => value - Math.floor(value);
const amountFor = (spec, key) => (finiteNumber(spec) ? spec : isRecord(spec) && finiteNumber(spec[key]) ? spec[key] : undefined);

/** -1..1 at `cycles` (0 is the start of a cycle): sine and triangle and saw start at 0 rising. */
export function waveAt(wave, cycles) {
  const f = fract(cycles);
  if (wave === "triangle") return f < 0.25 ? 4 * f : f < 0.75 ? 2 - 4 * f : 4 * f - 4;
  if (wave === "square") return f < 0.5 ? 1 : -1;
  if (wave === "saw") return 2 * fract(cycles + 0.5) - 1;
  return Math.sin(2 * Math.PI * cycles);
}

/** The oscillate offset for `key` at `local` seconds into a pass of `duration` (held after it). */
export function oscillateOffset(oscillate, key, local, duration) {
  const amount = amountFor(oscillate?.amount, key);
  if (!amount) return 0;
  const time = Math.max(0, Math.min(duration, local));
  const decay = oscillate.decay ? Math.exp(-oscillate.decay * time) : 1;
  return amount * waveAt(oscillate.wave, time / (oscillate.period ?? 1) + (oscillate.phase ?? 0)) * decay;
}

/** The ramp offset for `key`: from until start, eased to `to` over its duration, then held. */
export function rampOffset(ramp, key, local, duration) {
  const to = amountFor(ramp?.to, key);
  if (to === undefined) return 0;
  const from = amountFor(ramp.from, key) ?? 0;
  const time = Math.max(0, Math.min(duration, local));
  const start = ramp.start ?? 0;
  const span = ramp.duration ?? Math.max(0, duration - start);
  const progress = span > 0 ? Math.max(0, Math.min(1, (time - start) / span)) : time >= start ? 1 : 0;
  return from + (to - from) * easingAt(ramp.ease ?? "linear", progress);
}

/** The randomize offset for `key`: seeded values in -amount..amount, `rate` a second. */
export function randomizeOffset(randomize, key, local, duration) {
  const amount = amountFor(randomize?.amount, key);
  if (!amount) return 0;
  const x = Math.max(0, Math.min(duration, local)) * (randomize.rate ?? WIGGLE_RATE);
  const seed = randomize.seed ?? 0, channel = keyNumber(key) + RANDOM_SALT;
  return amount * (randomize.mode === "stepped" ? hash(seed, channel, Math.floor(x)) : noise1(seed, channel, x));
}

/** Every offset of the behavior for `key`, summed (0 when it names none). */
export function behaviorOffset(behavior, key, local, duration) {
  if (!behavior) return 0;
  let sum = behavior.wiggle ? wiggleOffset(behavior.wiggle, key, local, duration) : 0;
  if (behavior.oscillate) sum += oscillateOffset(behavior.oscillate, key, local, duration);
  if (behavior.ramp) sum += rampOffset(behavior.ramp, key, local, duration);
  if (behavior.randomize) sum += randomizeOffset(behavior.randomize, key, local, duration);
  if (behavior.follow) sum += followOffset(behavior.follow, key, local, duration);
  if (behavior.audio) sum += audioOffset(behavior.audio, key, local, duration);
  return sum;
}

// A value of an evenly sampled list at `index` (fractional), straight between samples.
function sampled(values, index) {
  if (!Array.isArray(values) || !values.length) return 0;
  const x = Math.max(0, Math.min(values.length - 1, index)), i = Math.floor(x);
  const a = values[i], b = values[Math.min(values.length - 1, i + 1)];
  return a + (b - a) * (x - i);
}

/** follow: scale times the leader's sampled move (track) at `local`, plus offset; 0 unbaked. */
export function followOffset(follow, key, local, duration) {
  if (isRecord(follow?.offset) && !Object.hasOwn(follow.offset, key)) return 0;
  const values = follow?.track?.values?.[follow.property ?? key];
  if (!values) return 0;
  const time = Math.max(0, Math.min(duration, local));
  return (follow.scale ?? 1) * sampled(values, time * follow.track.rate) + (amountFor(follow.offset, key) ?? 0);
}

/**
 * The audio level 0..1 at `local` seconds: the measured levels, rising at once and falling by
 * e^(-1) each `smoothing` seconds (an envelope follower), so a hit lifts and then eases off.
 */
export function audioLevelAt(audio, local) {
  const values = audio?.levels?.values;
  if (!Array.isArray(values) || !values.length) return 0;
  const x = Math.max(0, Math.min(values.length - 1, local * audio.levels.rate));
  const raw = sampled(values, x);
  if (!(audio.smoothing > 0)) return raw;
  const keep = Math.exp(-1 / (audio.levels.rate * audio.smoothing));
  let level = 0;
  for (let i = 0; i <= Math.floor(x); i += 1) level = Math.max(values[i], level * keep);
  return Math.max(raw, level * keep ** (x - Math.floor(x)));
}

/** audio: amount times the level at `local` (held after the animation). */
export function audioOffset(audio, key, local, duration) {
  const amount = amountFor(audio?.amount, key);
  if (!amount) return 0;
  return amount * audioLevelAt(audio, Math.max(0, Math.min(duration, local)));
}

/**
 * The overshoot `after` seconds past the animation's end, for a key whose last move was `change`
 * and ended at `speed` units a second: a damped swing that first passes the end by bounce times
 * the change, then is exactly 0 from settle seconds on. Its envelope falls to 1% at settle; more
 * bounce gives more swings. The swing leaves the end at the move's own speed (no jump): early
 * time is warped, slower after an ease-out, faster after an ease-in. A move ending faster than
 * OVERSHOOT_FASTEST times the plain swing's speed swings further, so its speed still carries on.
 */
export const OVERSHOOT_FASTEST = 3;
export function overshootOffset(overshoot, after, change, speed = 0) {
  const bounce = overshoot?.bounce ?? 0, settle = overshoot?.settle ?? 0;
  if (!(after > 0) || after >= settle || !bounce || (!change && !speed)) return 0;
  const omega = (Math.PI * (2 + 4 * bounce)) / settle;
  const lambda = Math.log(100) / settle;
  const shape = (t) => Math.sin(omega * t) * (Math.exp(-lambda * t) - 0.01) / 0.99;
  const crest = Math.atan(omega / lambda) / omega, peak = shape(crest);
  // The plain swing leaves at amplitude * omega / peak a second (shape'(0) is omega).
  let amplitude = change * bounce;
  const fastest = (Math.abs(speed) * peak) / (omega * OVERSHOOT_FASTEST);
  if (fastest > Math.abs(amplitude)) amplitude = Math.sign(speed) * fastest;
  const ratio = Math.max(0, (speed * peak) / (amplitude * omega));
  // Warp time over the first `span` seconds: tau'(0) = ratio, tau = t from span on (C1), and
  // tau' >= 1 - 2/3 * (ratio - 1) > 0 while ratio <= 3, so the swing never runs backward.
  const span = Math.min(0.9 * settle, 3 * crest), u = after / span;
  const tau = u < 1 ? after + (ratio - 1) * after * (1 - u) ** 2 : after;
  return (amplitude * shape(tau)) / peak;
}

/**
 * The behavior of an animation stretched from `before` to `after` seconds: a ramp's start and
 * duration (seconds into the animation) stretch with it, so it still fits. Else unchanged.
 */
export function retimeBehavior(behavior, before, after) {
  const ramp = behavior?.ramp;
  if (!isRecord(ramp) || !(before > 0) || !(after > 0) || before === after || (!ramp.start && ramp.duration == null)) return behavior;
  const factor = after / before, round = (value) => Math.round(value * 1e6) / 1e6;
  const next = { ...ramp, start: Math.min(after, round((ramp.start ?? 0) * factor)) };
  if (ramp.duration != null) {
    const span = Math.min(round(ramp.duration * factor), after - next.start);
    if (span > 0) next.duration = span;
    else delete next.duration;
  }
  return { ...behavior, ramp: next };
}

/** True when the behavior adds offsets (anything but a lone loop). */
export const hasOffsets = (behavior) => OFFSET_KINDS.some((kind) => isRecord(behavior?.[kind]));

/**
 * Which jump the behavior is on at `local` seconds ("" when it never jumps): a stepped randomize,
 * a square or saw wave and a steps ramp change at once, which Lottie must hold between frames.
 */
export function behaviorJumps(behavior, local, duration) {
  if (!behavior) return "";
  const time = Math.max(0, Math.min(duration, local));
  let marks = "";
  const { oscillate, randomize, ramp } = behavior;
  if (randomize?.mode === "stepped") marks += `r${Math.floor(time * (randomize.rate ?? WIGGLE_RATE))}`;
  if (oscillate?.wave === "square" || oscillate?.wave === "saw") {
    const cycles = time / (oscillate.period ?? 1) + (oscillate.phase ?? 0);
    marks += `o${oscillate.wave === "square" ? Math.floor(cycles * 2) : Math.floor(cycles + 0.5)}`;
  }
  if (ramp?.ease === "steps") marks += `s${rampOffset({ ...ramp, from: 0, to: 1 }, "", local, duration)}`;
  return marks;
}

/** The keys a behavior names in a { key: number } amount (or ramp to/from): they wiggle in place. */
export function behaviorKeys(behavior) {
  if (!isRecord(behavior)) return [];
  const specs = [behavior.wiggle?.amount, behavior.oscillate?.amount, behavior.randomize?.amount, behavior.ramp?.to, behavior.ramp?.from,
    behavior.follow?.offset, behavior.audio?.amount];
  return [...new Set(specs.flatMap((spec) => (isRecord(spec) ? Object.keys(spec) : [])))];
}

/**
 * A checked copy of a behavior, or throws an Error that says what is wrong. `isKey(key)` tells
 * whether an amount key is a number property the animation may change. Options: `duration` (the
 * animation's, for ramp), `effect` (an effect's settings: named keys only, no loop) and
 * `keyHint(key, label)` (the message for a key isKey refuses).
 */
export function normalizeBehavior(raw, isKey = () => true, options = {}) {
  const kinds = options.effect ? OFFSET_KINDS.filter((kind) => kind !== "follow") : [...OFFSET_KINDS, "overshoot", "loop"];
  const example = options.effect ? "{oscillate:{amount:{hue:20}}}" : "{loop:{mode:\"cycle\"}} or {wiggle:{amount:8}}";
  if (!isRecord(raw)) throw new Error(`must be an object such as ${example}`);
  const unknown = Object.keys(raw).filter((key) => !kinds.includes(key));
  if (unknown.length) throw new Error(`has no ${unknown.join(", ")}: use ${kinds.join(", ")}${options.effect && unknown.some((kind) => ["loop", "overshoot", "follow"].includes(kind)) ? " (an effect can't loop, overshoot or follow)" : ""}`);
  const behavior = {};
  if (raw.wiggle !== undefined && raw.wiggle !== null) behavior.wiggle = normalizeWiggle(raw.wiggle, isKey, options);
  if (raw.oscillate != null) behavior.oscillate = normalizeOscillate(raw.oscillate, isKey, options);
  if (raw.ramp != null) behavior.ramp = normalizeRamp(raw.ramp, isKey, options);
  if (raw.randomize != null) behavior.randomize = normalizeRandomize(raw.randomize, isKey, options);
  if (raw.follow != null) behavior.follow = normalizeFollow(raw.follow, isKey, options);
  if (raw.audio != null) behavior.audio = normalizeAudio(raw.audio, isKey, options);
  if (raw.overshoot != null) behavior.overshoot = normalizeOvershoot(raw.overshoot);
  if (raw.loop !== undefined && raw.loop !== null) {
    const loop = typeof raw.loop === "string" ? { mode: raw.loop } : raw.loop;
    if (!isRecord(loop) || !LOOP_MODES.includes(loop.mode) || Object.keys(loop).length !== 1)
      throw new Error(`loop must be {mode: "cycle"} or {mode: "pingpong"}`);
    behavior.loop = { mode: loop.mode };
  }
  if (!Object.keys(behavior).length) throw new Error(`needs ${kinds.join(", ").replace(/, (\w+)$/, " or $1")}`);
  const looped = ["overshoot", "follow", "audio"].find((kind) => behavior[kind]);
  if (behavior.loop && looped) throw new Error(`${looped} can't loop: it reads the time after the start once`);
  return behavior;
}

const layerRef = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(`${label} must name a layer of the scene`);
  return value;
};

// A baked list: {rate, values} (or values per property), checked but not made by the agent.
function bakedList(raw, label, perKey) {
  if (raw == null) return undefined;
  const list = (values, where) => {
    if (!Array.isArray(values) || values.length > MAX_TRACK_VALUES || !values.every(finiteNumber)) throw new Error(`${where} must be at most ${MAX_TRACK_VALUES} numbers`);
    return values;
  };
  if (!isRecord(raw) || !finiteNumber(raw.rate) || raw.rate <= 0 || raw.rate > 240) throw new Error(`${label} must be {rate, values}; kino fills it`);
  const values = perKey
    ? (isRecord(raw.values) ? Object.fromEntries(Object.entries(raw.values).map(([key, entry]) => [key, list(entry, `${label}.values.${key}`)])) : list(null, `${label}.values`))
    : list(raw.values, `${label}.values`);
  return { ...raw, rate: raw.rate, values };
}

function normalizeFollow(raw, isKey, options) {
  onlyFields(raw, "follow", ["layer", "property?", "lag?", "scale?", "offset?", "track?"]);
  if (raw.property != null && (typeof raw.property !== "string" || !raw.property)) throw new Error("follow.property must name a number property of the leader, such as x");
  const follow = {
    layer: layerRef(raw.layer, "follow.layer"),
    ...(raw.property != null ? { property: raw.property } : {}),
    lag: numberIn(raw.lag, "follow.lag", 0.1, 0, 60, { unit: " seconds" }),
    scale: numberIn(raw.scale, "follow.scale", 1, -1000, 1000),
    offset: raw.offset == null ? 0 : amountSpec(raw.offset, "follow.offset", isKey, options, { min: -MAX_AMOUNT, verb: "follow" }),
  };
  const track = bakedList(raw.track, "follow.track", true);
  if (track) follow.track = track;
  return follow;
}

function normalizeAudio(raw, isKey, options) {
  onlyFields(raw, "audio", ["layer", "band?", "amount", "smoothing?", "levels?"]);
  const band = raw.band ?? "all";
  if (!AUDIO_BANDS.includes(band)) throw new Error(`audio.band must be ${AUDIO_BANDS.join(", ")}`);
  const audio = {
    layer: layerRef(raw.layer, "audio.layer"),
    band,
    amount: amountSpec(raw.amount, "audio.amount", isKey, options, { min: -MAX_AMOUNT, verb: "move with sound" }),
    smoothing: numberIn(raw.smoothing, "audio.smoothing", 0.15, 0, 5, { unit: " seconds" }),
  };
  const levels = bakedList(raw.levels, "audio.levels", false);
  if (levels) audio.levels = levels;
  return audio;
}

function normalizeOvershoot(raw) {
  onlyFields(raw, "overshoot", ["bounce?", "settle?"]);
  return {
    bounce: numberIn(raw.bounce, "overshoot.bounce", 0.3, 0, 1, { unit: " (share of the last move)" }),
    settle: numberIn(raw.settle, "overshoot.settle", 0.6, 0.05, 10, { unit: " seconds" }),
  };
}

function onlyFields(raw, label, fields) {
  if (!isRecord(raw)) throw new Error(`${label} must be {${fields.join(", ")}}`);
  const unknown = Object.keys(raw).filter((key) => !fields.includes(key.replace(/\?$/, "")) && !fields.includes(`${key}?`));
  if (unknown.length) throw new Error(`${label} has no ${unknown.join(", ")}: use ${fields.map((field) => field.replace(/\?$/, "")).join(", ")}`);
}

// One number, or { key: number } naming number properties; min is 0 for a size, -MAX for a value.
function amountSpec(value, label, isKey, options, { min = 0, verb }) {
  const check = (entry, where) => {
    if (!finiteNumber(entry) || entry < min || entry > MAX_AMOUNT) throw new Error(`${where} must be a number from ${min} to ${MAX_AMOUNT}`);
    return entry;
  };
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (!keys.length) throw new Error(`${label} names no property`);
    for (const key of keys) if (!isKey(key)) throw new Error(options.keyHint?.(key, label) ?? `${label}.${key}: only number properties such as x, y, rotation, scaleX or opacity can ${verb}`);
    return Object.fromEntries(keys.map((key) => [key, check(value[key], `${label}.${key}`)]));
  }
  if (options.effect) throw new Error(`${label}: on an effect, name the settings, such as {${label.split(".").pop()}:{hue:20}}`);
  return check(value, label);
}

function numberIn(raw, label, fallback, min, max, { above = false, integer = false, unit = "" } = {}) {
  const value = raw === undefined ? fallback : raw;
  if (!finiteNumber(value) || (above ? value <= min : value < min) || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`${label} must be a ${integer ? "whole number" : "number"} ${above ? "above" : "from"} ${min}${above ? " and at most" : " to"} ${max}${unit}`);
  return value;
}

function normalizeOscillate(raw, isKey, options) {
  onlyFields(raw, "oscillate", ["amount", "period?", "phase?", "wave?", "decay?"]);
  const wave = raw.wave ?? "sine";
  if (!WAVES.includes(wave)) throw new Error(`oscillate.wave must be ${WAVES.join(", ")}`);
  return {
    amount: amountSpec(raw.amount, "oscillate.amount", isKey, options, { verb: "oscillate" }),
    period: numberIn(raw.period, "oscillate.period", 1, 0, MAX_PERIOD, { above: true, unit: " (seconds a cycle)" }),
    phase: numberIn(raw.phase, "oscillate.phase", 0, 0, 1, { unit: " (share of a cycle)" }),
    wave,
    decay: numberIn(raw.decay, "oscillate.decay", 0, 0, MAX_DECAY, { unit: " (per second)" }),
  };
}

function normalizeRamp(raw, isKey, options) {
  onlyFields(raw, "ramp", ["to", "from?", "start?", "duration?", "ease?"]);
  const to = amountSpec(raw.to, "ramp.to", isKey, options, { min: -MAX_AMOUNT, verb: "ramp" });
  const ramp = { to };
  if (raw.from != null) {
    ramp.from = amountSpec(raw.from, "ramp.from", isKey, options, { min: -MAX_AMOUNT, verb: "ramp" });
    if (isRecord(to) !== isRecord(ramp.from) || (isRecord(to) && Object.keys(ramp.from).some((key) => !Object.hasOwn(to, key))))
      throw new Error("ramp.from must have the shape of ramp.to: both one number, or from naming only keys in to");
  }
  const limit = finiteNumber(options.duration) ? options.duration : MAX_PERIOD;
  ramp.start = numberIn(raw.start, "ramp.start", 0, 0, limit, { unit: " (seconds into the animation)" });
  if (raw.duration != null) {
    ramp.duration = numberIn(raw.duration, "ramp.duration", 0, 0, limit, { above: true, unit: " seconds" });
    if (ramp.start + ramp.duration > limit + 1e-9) throw new Error(`ramp.start plus ramp.duration must be at most the animation's duration (${limit} s)`);
  }
  try { ramp.ease = normalizeEasing(raw.ease ?? "linear"); }
  catch (error) { throw new Error(`ramp.ease: ${error.message}`); }
  return ramp;
}

function normalizeRandomize(raw, isKey, options) {
  onlyFields(raw, "randomize", ["amount", "rate?", "seed?", "mode?"]);
  const mode = raw.mode ?? "smooth";
  if (!RANDOM_MODES.includes(mode)) throw new Error(`randomize.mode must be ${RANDOM_MODES.join(" or ")}`);
  return {
    amount: amountSpec(raw.amount, "randomize.amount", isKey, options, { verb: "randomize" }),
    rate: numberIn(raw.rate, "randomize.rate", WIGGLE_RATE, 0, MAX_RANDOM_RATE, { above: true, unit: " (values a second)" }),
    seed: numberIn(raw.seed, "randomize.seed", 0, 0, MAX_SEED, { integer: true }),
    mode,
  };
}

function normalizeWiggle(raw, isKey, options = {}) {
  if (!isRecord(raw)) throw new Error("wiggle must be {amount, rate?, seed?, decay?}");
  const unknown = Object.keys(raw).filter((key) => !["amount", "rate", "seed", "decay"].includes(key));
  if (unknown.length) throw new Error(`wiggle has no ${unknown.join(", ")}: use amount, rate, seed and decay`);
  const amount = amountSpec(raw.amount, "wiggle.amount", isKey, options, { verb: "wiggle" });
  const rate = raw.rate === undefined ? WIGGLE_RATE : raw.rate;
  if (!finiteNumber(rate) || rate <= 0 || rate > MAX_RATE) throw new Error(`wiggle.rate must be above 0 and at most ${MAX_RATE} (drifts a second)`);
  const seed = raw.seed === undefined ? 0 : raw.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) throw new Error("wiggle.seed must be a whole number from 0");
  const decay = numberIn(raw.decay, "wiggle.decay", 0, 0, MAX_DECAY, { unit: " (per second)" });
  return decay > 0 ? { amount, rate, seed, decay } : { amount, rate, seed };
}
