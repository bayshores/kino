import { easingAt, normalizeEasing, normalizeIntensity } from "./easing.js";

/** Named easing curves allowed for unit-start spacing, in the order shown by the UI. */
export const TEXT_SMOOTHING_EASINGS = Object.freeze([
  "smooth", "natural", "expo-out", "quart-out", "in-out", "ease-out", "ease-in", "linear", "custom",
]);

const allowedEasings = new Set(TEXT_SMOOTHING_EASINGS);
const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Normalize a text-unit smoothing curve, retaining custom cubic-bezier arrays. */
export function normalizeSmoothing(value) {
  if (value === null || value === undefined) return null;
  const normalized = normalizeEasing(value);
  if (Array.isArray(normalized)) return normalized;
  if (!allowedEasings.has(normalized))
    throw new RangeError(`unsupported text smoothing "${String(value)}"`);
  return normalized;
}

// `delays`: each unit's own delay after the start, in seconds (caption words timed to speech).
// The last one holds for any further units. It replaces the stagger, order and smoothing.
const ownDelays = (animation) => (Array.isArray(animation?.delays) && animation.delays.length ? animation.delays : null);

/** The delay before one text unit, eased within the animation's nominal stagger spread. */
export function unitDelay(animation, index, count) {
  if (animation?.range) return 0; // a range selector times every unit itself (textRangeProgress)
  const delays = ownDelays(animation);
  if (delays) return Math.max(0, finite(delays[Math.min(Math.max(0, Math.floor(finite(index, 0))), delays.length - 1)]));
  const units = Math.max(1, Math.floor(finite(count, 1)));
  const stagger = Math.max(0, finite(animation?.stagger));
  if (units <= 1 || stagger <= 0) return 0;

  const unitIndex = finite(index, 0);
  const position = animation?.order === "reverse" ? units - 1 - unitIndex : unitIndex;
  const smoothing = normalizeSmoothing(animation?.smoothing ?? "linear") ?? "linear";
  const intensity = normalizeIntensity(animation?.smoothingIntensity ?? 50);
  // Preserve the original stagger arithmetic bit for bit for omitted and linear smoothing.
  if (smoothing === "linear") return stagger * position;
  const normalized = position / (units - 1);
  const eased = easingAt(smoothing, normalized, intensity);
  return Math.max(0, Math.min(1, eased)) * stagger * (units - 1);
}

// `scatter`: each unit starts (in) or ends (out) away from its place by a seeded amount, so
// letters fly together into a word without one animation per letter. {x, y} are the most
// pixels a unit is off, rotation the most degrees, scale the most it is bigger or smaller
// (0.5: from half to one and a half times), seed picks the offsets (the same seed, the same ones).
const SCATTER_KEYS = ["x", "y", "rotation", "scale"];

/** A number from -1 to 1 for (seed, unit, channel): plain integer hashing, the same everywhere. */
function unitNoise(seed, index, channel) {
  let hash = (Math.imul(seed | 0, 374761393) + Math.imul((index | 0) + 1, 668265263) + Math.imul(channel + 1, 362437)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 2246822519) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 3266489917) >>> 0;
  return (((hash ^ (hash >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

/** One unit's offsets for an animation's scatter: {x, y, rotation, scale} (scale is a factor). */
export function unitScatter(scatter, index) {
  const seed = Math.floor(finite(scatter?.seed, 1));
  const [x, y, rotation, scale] = SCATTER_KEYS.map((key, channel) => unitNoise(seed, index, channel) * Math.max(0, finite(scatter?.[key])));
  return { x, y, rotation, scale: Math.max(0.05, 1 + scale) };
}

/**
 * The animation with this unit's scatter added to its away end (from for in and custom, to for
 * out). Only keys the end names move: x, y, rotation, and scaleX/scaleY by the factor.
 */
export function scatteredAnimation(animation, index) {
  if (!animation?.scatter) return animation;
  const side = animation.kind === "out" ? "to" : "from";
  const end = { ...animation[side] };
  const offset = unitScatter(animation.scatter, index);
  for (const key of ["x", "y", "rotation"]) if (typeof end[key] === "number") end[key] += offset[key];
  for (const key of ["scaleX", "scaleY"]) if (typeof end[key] === "number") end[key] *= offset.scale;
  return { ...animation, [side]: end };
}

/** Maximum delay before the last unit; smoothing is clamped and pins its endpoints. */
export function totalUnitDelay(animation, count) {
  if (animation?.range) return 0;
  const units = Math.max(1, Math.floor(finite(count, 1)));
  const delays = ownDelays(animation);
  if (delays) return Math.max(0, ...delays.slice(0, units).map((delay) => finite(delay)));
  const stagger = Math.max(0, finite(animation?.stagger));
  return units <= 1 || stagger <= 0 ? 0 : stagger * (units - 1);
}

// Range selector, ported from ArtCraft EffectCraft, effectcraft/crates/text/src/selectors.rs
// (`shape_value`, `ease`, `range_value`, `random_order`, `splitmix`, `Mode::combine`; MIT OR
// Apache-2.0, (c) the ArtCraft authors). A range selector on one animation: each text
// unit's progress is how much a moving window covers it, so one animation makes a traveling wave,
// a center-out or random-order reveal or a soft typewriter without one animation per letter.
//
// `range` is one selector or a list of up to 4 combined by `mode`. A selector:
//   preset  typewriter | center-out | random | wave (fills the fields below; any of them overrides)
//   shape   square (default) | ramp-up | ramp-down | triangle | round | smooth | wiggly
//   wiggly  (selectors.rs `Wiggly`, `wiggly_value`, `noise1`, `hash3`) every unit wanders from -1
//           to 1 on smooth seeded noise, `wiggles` times over the animation; `correlation` 0..1
//           (1: every unit moves together); start, end and offset do not apply. Its selection
//           goes past from and to, so it is for a custom animation (a jitter, a shimmer), often
//           with mode add over another selector.
//   start, end, offset  fractions of the text (0 = before the first unit, 1 = after the last);
//           a number, or [from, to] moved by the animation's eased progress (the sweep)
//   smoothness 0..1 (square: the soft edge, in units), easeHigh, easeLow -1..1, amount -1..1
//   order   forward | reverse | random (seeded by seed)
//   mode    add | subtract | intersect | min | max | difference (with the selectors before it)
// A unit's progress is its selection: 0 is the animation's from, 1 its to. It replaces the stagger.
export const RANGE_SHAPES = Object.freeze(["square", "ramp-up", "ramp-down", "triangle", "round", "smooth", "wiggly"]);
export const RANGE_MODES = Object.freeze(["add", "subtract", "intersect", "min", "max", "difference"]);
export const RANGE_ORDERS = Object.freeze(["forward", "reverse", "random"]);
export const RANGE_PRESETS = Object.freeze({
  typewriter: Object.freeze({ shape: "square", start: 0, end: [0, 1], smoothness: 1 }),
  "center-out": Object.freeze({ shape: "square", start: [0.5, 0], end: [0.5, 1], smoothness: 1 }),
  random: Object.freeze({ shape: "square", start: 0, end: [0, 1], smoothness: 1, order: "random", seed: 1 }),
  wave: Object.freeze({ shape: "smooth", start: 0, end: 0.35, offset: [-0.35, 1] }),
});

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Shape profile over the range (`f` = 0 at start, 1 at end). selectors.rs `shape_value`. */
export function shapeValue(shape, f) {
  if (shape === "ramp-up") return clamp(f, 0, 1); // ramps hold their end values outside the range
  if (shape === "ramp-down") return 1 - clamp(f, 0, 1);
  if (!(f >= 0 && f <= 1)) return 0;
  if (shape === "triangle") return 1 - Math.abs(2 * f - 1);
  if (shape === "round") return Math.sqrt(Math.max(0, 1 - (2 * f - 1) ** 2));
  if (shape === "smooth") { const t = 1 - Math.abs(2 * f - 1); return t * t * (3 - 2 * t); }
  return 1;
}

/** Ease High / Low remap of a selection 0..1: a cubic Bezier y(t). selectors.rs `ease`. */
export function easeSelection(value, high = 0, low = 0) {
  if (!high && !low) return value;
  const t = clamp(value, 0, 1);
  const p1 = (1 - clamp(low, -1, 1)) / 3;
  const p2 = 1 - (1 - clamp(high, -1, 1)) / 3;
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** Selection of unit position `i` of `n` by a selector with plain-number fields. selectors.rs `range_value`. */
export function rangeValue(selector, i, n) {
  n = Math.max(1, n);
  let s = selector.start ?? 0, e = selector.end ?? 1;
  if (s > e) [s, e] = [e, s];
  s += selector.offset ?? 0;
  e += selector.offset ?? 0;
  const unit = 1 / n;
  const c = (i + 0.5) * unit;
  const shape = selector.shape ?? "square";
  let value;
  if (shape === "square") {
    const w = clamp(selector.smoothness ?? 1, 0, 1) * unit;
    const edge = (d) => (w > 1e-12 ? clamp(d / w + 0.5, 0, 1) : d >= 0 ? 1 : 0);
    value = e - s <= 1e-12 ? 0 : Math.min(edge(c - s), edge(e - c));
  } else if (e - s <= 1e-12) value = shape === "ramp-up" ? Number(c >= s) : shape === "ramp-down" ? Number(c < s) : 0;
  else value = easeSelection(shapeValue(shape, (c - s) / (e - s)), selector.easeHigh, selector.easeLow);
  return value * (selector.amount ?? 1);
}

const MASK64 = (1n << 64n) - 1n;
/** SplitMix64 step on BigInt, as selectors.rs `splitmix`. */
function splitmix(x) {
  x = (x + 0x9e3779b97f4a7c15n) & MASK64;
  let z = x;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

const U64 = (value) => BigInt.asUintN(64, value);
/** selectors.rs `hash3`. */
const hash3 = (a, b, c) => splitmix(U64(splitmix(U64(splitmix(a) ^ U64(b * 0x632be59bd9b4e019n))) ^ U64(c * 0x8cb92ba72f3d8dd7n)));

/** Smooth 1D value noise in -1..1, quintic between seeded lattice values. selectors.rs `noise1`. */
export function noise1(x, seed, channel) {
  const i = Math.floor(x);
  const f = x - i;
  const lattice = (k) => Number(hash3(seed, channel, U64(BigInt(k))) >> 11n) / 2 ** 53 * 2 - 1;
  const a = lattice(i);
  const b = lattice(i + 1);
  return a + (b - a) * (f * f * f * (f * (f * 6 - 15) + 10));
}

/** The Wiggly selection (-1..1) of unit position `i` at time `tau` (in wiggles). selectors.rs `wiggly_value`, one dimension. */
export function wigglyValue(tau, i, { correlation = 0.5, seed = 0 } = {}) {
  const s = U64(BigInt(seed));
  const shared = noise1(tau, s, 0n);
  const along = i * 0.61;
  const own = 0.5 * noise1(tau + along, s ^ 0xa5a5n, 1n) + 0.5 * noise1(tau * 1.37 + along * 1.7, s ^ U64(BigInt(i + 1) * 0x9e37n), 0n);
  const c = clamp(correlation, 0, 1);
  return clamp(c * shared + (1 - c) * clamp(own, -1, 1), -1, 1);
}

const orders = new Map();
/** Randomize Order: a seeded permutation, p[i] = the position unit i takes. selectors.rs `random_order`. */
export function randomOrder(n, seed) {
  const key = `${n}:${seed}`;
  if (orders.has(key)) return orders.get(key);
  const p = Array.from({ length: n }, (_, index) => index);
  let s = splitmix(BigInt.asUintN(64, BigInt(seed)) ^ 0x5eedn);
  for (let i = n - 1; i >= 1; i--) {
    s = splitmix(s);
    const j = Number(s % BigInt(i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  if (orders.size > 64) orders.clear();
  orders.set(key, p);
  return p;
}

/** The selection before the first selector. selectors.rs `Mode::initial`. */
export const initialSelection = (mode) => (["subtract", "intersect", "min"].includes(mode) ? 1 : 0);

/** One selector's value `v` combined with the selection so far. selectors.rs `Mode::combine`. */
export function combineSelection(mode, acc, v) {
  const r = mode === "subtract" ? (acc >= 0 ? Math.max(0, acc - v) : acc - v)
    : mode === "intersect" ? acc * v
      : mode === "min" ? Math.min(acc, v)
        : mode === "max" ? Math.max(acc, v)
          : mode === "difference" ? Math.abs(acc - v)
            : acc + v;
  return clamp(r, -1, 1);
}

const sweepAt = (value, fallback, progress) => (Array.isArray(value) ? value[0] + (value[1] - value[0]) * progress : value ?? fallback);

/** One unit's progress (its selection) at the animation's eased progress, for unit `index` of `count`. */
export function textRangeProgress(range, progress, index, count) {
  const n = Math.max(1, Math.floor(finite(count, 1)));
  const i = clamp(Math.floor(finite(index, 0)), 0, n - 1);
  let acc = null;
  for (const raw of Array.isArray(range) ? range : [range]) {
    const selector = raw?.preset && RANGE_PRESETS[raw.preset] ? { ...RANGE_PRESETS[raw.preset], ...raw } : raw ?? {};
    const mode = selector.mode ?? "add";
    acc ??= initialSelection(mode);
    const position = selector.order === "random" ? randomOrder(n, selector.seed ?? 1)[i] : selector.order === "reverse" ? n - 1 - i : i;
    const value = selector.shape === "wiggly" ? wigglyValue(progress * (selector.wiggles ?? 4), position, selector) * (selector.amount ?? 1)
      : rangeValue({ ...selector, start: sweepAt(selector.start, 0, progress), end: sweepAt(selector.end, 1, progress), offset: sweepAt(selector.offset, 0, progress) }, position, n);
    acc = combineSelection(mode, acc, value);
  }
  return acc ?? progress;
}

const RANGE_FIELDS = ["preset", "shape", "start", "end", "offset", "smoothness", "easeHigh", "easeLow", "amount", "order", "seed", "mode", "wiggles", "correlation"];

/** A checked, expanded copy of an animation's range, or throws an Error that says what is wrong. */
export function normalizeTextRange(raw, kind) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.length > 4) throw new Error("must be one selector or a list of 1 to 4");
  const selectors = list.map((item, index) => {
    const where = Array.isArray(raw) ? `[${index}]` : "";
    if (typeof item === "string") item = { preset: item };
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${where} must be a preset name or {shape?, start?, end?, offset?, ...}`);
    if (item.preset != null && !RANGE_PRESETS[item.preset]) throw new Error(`${where}.preset must be ${Object.keys(RANGE_PRESETS).join(", ")}`);
    const selector = { ...(item.preset ? RANGE_PRESETS[item.preset] : {}), ...item };
    const unknown = Object.keys(selector).filter((key) => !RANGE_FIELDS.includes(key));
    if (unknown.length) throw new Error(`${where} has no ${unknown.join(", ")}: use ${RANGE_FIELDS.join(", ")}`);
    const pick = (key, allowed) => { if (selector[key] != null && !allowed.includes(selector[key])) throw new Error(`${where}.${key} must be ${allowed.join(", ")}`); };
    pick("shape", RANGE_SHAPES); pick("order", RANGE_ORDERS); pick("mode", RANGE_MODES);
    for (const key of RANGE_FIELDS) if (selector[key] == null) delete selector[key];
    for (const key of ["start", "end", "offset"]) {
      if (selector[key] === undefined) continue;
      const values = Array.isArray(selector[key]) ? selector[key] : [selector[key]];
      if (!values.length || values.length > 2 || values.some((number) => !Number.isFinite(number) || number < -2 || number > 2))
        throw new Error(`${where}.${key} must be a number from -2 to 2 or [from, to] (fractions of the text)`);
      if (Array.isArray(selector[key])) selector[key] = [...selector[key]];
    }
    if (selector.wiggles !== undefined && !(Number.isFinite(selector.wiggles) && selector.wiggles > 0 && selector.wiggles <= 100))
      throw new Error(`${where}.wiggles must be a number above 0, up to 100 (wiggles over the animation)`);
    if ((selector.wiggles !== undefined || selector.correlation !== undefined) && selector.shape !== "wiggly")
      throw new Error(`${where}: wiggles and correlation are for shape "wiggly"`);
    for (const [key, low] of [["smoothness", 0], ["easeHigh", -1], ["easeLow", -1], ["amount", -1], ["correlation", 0]])
      if (selector[key] !== undefined && !(Number.isFinite(selector[key]) && selector[key] >= low && selector[key] <= 1))
        throw new Error(`${where}.${key} must be a number from ${low} to 1`);
    if (selector.seed !== undefined && !(Number.isInteger(selector.seed) && selector.seed >= 0 && selector.seed <= 1e6))
      throw new Error(`${where}.seed must be a whole number from 0 to 1000000`);
    return selector;
  });
  const range = Array.isArray(raw) ? selectors : selectors[0];
  // An in or out must take every unit from 0 to 1, or units jump at its start or stay away after it.
  if (kind === "in" || kind === "out") {
    for (const n of [1, 2, 7, 30]) for (let i = 0; i < n; i++) {
      if (Math.abs(textRangeProgress(range, 0, i, n)) > 1e-9 || Math.abs(textRangeProgress(range, 1, i, n) - 1) > 1e-9)
        throw new Error(`does not take every unit from 0 to 1 (a wave returns to 0): use it on a custom animation, or typewriter, center-out or random on an ${kind}`);
    }
  }
  return range;
}
