const EASING_ENTRIES = [
  ["custom", "Custom"],
  ["smooth", "Smooth"],
  ["natural", "Natural"],
  ["expo-out", "Expo out"],
  ["quart-out", "Quart out"],
  ["in-out", "In and out"],
  ["ease-out", "Slow down"],
  ["ease-in", "Accelerate"],
  ["elastic", "Elastic"],
  ["bounce", "Bounce"],
  ["overshoot", "Overshoot"],
  ["impulse", "Impulse"],
  ["swing", "Swing"],
  ["spring", "Spring"],
  ["back-out", "Back out"],
  ["linear", "None"],
];

export const EASINGS = Object.freeze(EASING_ENTRIES.map(([id, name]) => Object.freeze({ id, name })));

const DEFAULT_CUSTOM = Object.freeze([0.5, 0, 0.5, 1]);
// Fixed curves with names (intensity does not change them). expo-out ("snap") is a fast arrival and
// a long settle (about 75% of the way at a fifth of the time), for a deliberate snap;
// quart-out is a softer version; in-out speeds up and slows down evenly (a cubic in-out).
const NAMED_CURVES = Object.freeze({
  "expo-out": Object.freeze([0.16, 1, 0.3, 1]),
  "quart-out": Object.freeze([0.25, 1, 0.5, 1]),
  "in-out": Object.freeze([0.65, 0, 0.35, 1]),
});
const ELASTIC_PERIODS = Object.freeze([0.63810572, 0.36260465, 0.17135067]);
const ELASTIC_DAMPING = 10;
const OVERSHOOT_PARAMETERS = Object.freeze([
  Object.freeze([0.4491, 0.0502, 0.9011, 1.6952, 1.0387, 1.8669, 1.3147, 1.5638]),
  Object.freeze([0.2507, 0.2019, 0.8923, 1.7813, 1.0372, 1.6810, 1.3978, 1.5798]),
  Object.freeze([0.1645, 1.0096, 0.8609, 2.1073, 1.0259, 1.1163, 1.6777, 1.2529]),
]);
const IMPULSE_PARAMETERS = Object.freeze([
  Object.freeze([0.16323196003298587, 0.04950733103799979, 1.8613950176327305, 1.489720613507659, 0.8125282282525637, -1.622872501565249, 0.2574447299913048, 2.485803035268712, 2.09932575165326, 2.8461659977987703, -3.122602148382637, 0.40839188340357774]),
  Object.freeze([0.2904405145008717, 0.19815622259487967, 1.9394270953345083, 1.4222251045894587, 0.7248779876097317, -1.465974853106988, 0.3243549813117646, 3.144658920319716, 2.1321249358967003, 4.555483695754239, -5.662402674990657, 1.4628188316707147]),
  Object.freeze([0.4539208948868705, 0.996166912889895, 2.160803353010393, 1.3162171413579178, 0.6407731804471366, -2.0223500975274638, 1.0747404296655603, 6.098583235946713, 0.19114577977905017, 12.737262536996196, -20.576649123616424, 13.942935446334236]),
]);
const SWING = Object.freeze({
  dipTime: Object.freeze([0.17, 0.2, 0.27]),
  peakTime: Object.freeze([0.67, 0.6, 0.47]),
  depth: Object.freeze([0.1, 0.2, 1]),
  // The rising segment is an asymmetric logistic with a cubic logit correction.
  // Its parameters are fitted only at the documented 0/50/100 anchors.
  rise: Object.freeze([
    Object.freeze([1.439011, 2.686646, 1.031098, 4.150343, -4.489936, -0.342248]),
    Object.freeze([0.466433, 2.395648, 4.47299, 15.539843, -17.493119, 5.808173]),
    Object.freeze([0.010022, 26.481129, 5.248207, -21.25424, 29.733771, -68.673419]),
  ]),
  // A polynomial decay envelope lets the overshoot settle to 1 at the final endpoint.
  tail: Object.freeze([
    Object.freeze([2.470351, 2.362796, -2.054728]),
    Object.freeze([2.478512, 2.38117, -2.072288]),
    Object.freeze([2.436858, 1.946087, -1.757999]),
  ]),
});

const ALIASES = new Map([
  ["none", "linear"], ["linear", "linear"],
  ["custom", "custom"],
  ["smooth", "smooth"],
  ["natural", "natural"],
  ["expoout", "expo-out"], ["snap", "expo-out"], ["easeoutexpo", "expo-out"], ["outexpo", "expo-out"],
  ["quartout", "quart-out"], ["easeoutquart", "quart-out"], ["outquart", "quart-out"],
  ["inout", "in-out"], ["easeinout", "in-out"], ["easeinoutcubic", "in-out"],
  ["easeout", "ease-out"], ["slowdown", "ease-out"],
  ["easein", "ease-in"], ["accelerate", "ease-in"],
  ["elastic", "elastic"], ["bounce", "bounce"],
  ["overshoot", "overshoot"], ["impulse", "impulse"], ["swing", "swing"],
  ["spring", "spring"], ["backout", "back-out"], ["easeoutback", "back-out"], ["outback", "back-out"],
]);

function easingToken(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${name} must be a finite number`);
}

export function normalizeIntensity(value = 50) {
  if (!Number.isInteger(value) || value < 0 || value > 100)
    throw new RangeError("easing intensity must be an integer in the supported range 0 to 100");
  return value;
}

export function normalizeEasing(value) {
  if (Array.isArray(value)) {
    if (value.length !== 4)
      throw new RangeError("custom easing must have four control points in the supported range");
    const curve = value.map((entry, index) => {
      finiteNumber(entry, `easing control point ${index + 1}`);
      return entry;
    });
    if (curve[0] < 0 || curve[0] > 1 || curve[2] < 0 || curve[2] > 1 ||
        curve[1] < -10 || curve[1] > 10 || curve[3] < -10 || curve[3] > 10)
      throw new RangeError("custom easing control points are outside the supported range");
    return curve;
  }
  if (typeof value !== "string") throw new TypeError("easing must be a name or four-number cubic bezier");
  const id = ALIASES.get(easingToken(value));
  if (!id) throw new RangeError(`unsupported easing "${value}"`);
  return id === "custom" ? [...DEFAULT_CUSTOM] : id;
}

function interpolateIntensityAnchors(first, middle, last, intensity) {
  if (intensity <= 50) return first + (middle - first) * (intensity / 50);
  return middle + (last - middle) * ((intensity - 50) / 50);
}

/** A saved easing: the curve and its intensity, checked, without names or other fields. */
export function checkedEasingValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("An easing value is required.");
  const result = { easing: normalizeEasing(value.easing) };
  if (value.intensity !== undefined) result.intensity = normalizeIntensity(value.intensity);
  return result;
}

export function easingBezier(easing, intensity = 50) {
  const value = normalizeEasing(easing);
  const strength = normalizeIntensity(intensity);
  if (Array.isArray(value)) return [...value];
  if (NAMED_CURVES[value]) return [...NAMED_CURVES[value]];
  switch (value) {
    case "linear": return [0, 0, 1, 1];
    case "custom": return [...DEFAULT_CUSTOM];
    case "smooth": return [interpolateIntensityAnchors(0.3, 0.5, 0.9, strength), 0, 0, 1];
    case "natural": {
      const first = interpolateIntensityAnchors(0.5, 0.8, 1, strength);
      return [first, 0, 1 - first, 1];
    }
    case "ease-out": {
      if (strength <= 50) {
        const part = strength / 50;
        return [0, 0, 0.3 * (1 - part), 1];
      }
      return [0, 0.9 * ((strength - 50) / 50), 0, 1];
    }
    case "ease-in": {
      if (strength <= 50) {
        const part = strength / 50;
        return [0.7 + 0.3 * part, 0, 1, 1];
      }
      return [1, 0, 1, Number((1 - 0.9 * ((strength - 50) / 50)).toFixed(8))];
    }
    default: return null;
  }
}

function cubicCoordinate(t, first, second) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

function cubicDerivative(t, first, second) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * first + 6 * inverse * t * (second - first) + 3 * t * t * (1 - second);
}

function cubicBezierAt(curve, time) {
  const [x1, y1, x2, y2] = curve;
  // Diagonal curves are exactly linear. Inverting them numerically can round a
  // counter's whole-step boundary down into the preceding value.
  if (x1 === y1 && x2 === y2) return time;
  let parameter = time;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const difference = cubicCoordinate(parameter, x1, x2) - time;
    const derivative = cubicDerivative(parameter, x1, x2);
    if (Math.abs(difference) < 1e-8) return cubicCoordinate(parameter, y1, y2);
    if (Math.abs(derivative) < 1e-7) break;
    const next = parameter - difference / derivative;
    if (next < 0 || next > 1) break;
    parameter = next;
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    parameter = (low + high) / 2;
    const x = cubicCoordinate(parameter, x1, x2);
    if (Math.abs(x - time) < 1e-8) break;
    if (x < time) low = parameter;
    else high = parameter;
  }
  return cubicCoordinate(parameter, y1, y2);
}

function elasticPeriod(intensity) {
  if (intensity <= 50) return ELASTIC_PERIODS[0] + (ELASTIC_PERIODS[1] - ELASTIC_PERIODS[0]) * intensity / 50;
  return ELASTIC_PERIODS[1] + (ELASTIC_PERIODS[2] - ELASTIC_PERIODS[1]) * (intensity - 50) / 50;
}

function bounceParameters(intensity) {
  const restitution = intensity <= 50
    ? 0.2 + 0.3 * (intensity / 50)
    : 0.5 + 0.2 * ((intensity - 50) / 50);
  const firstDuration = (1 - restitution) / (1 + restitution);
  return { restitution, firstDuration };
}

function bounceAt(time, intensity) {
  const { restitution, firstDuration } = bounceParameters(intensity);
  if (time <= firstDuration) return (time / firstDuration) ** 2;
  let duration = (1 - firstDuration) * (1 - restitution);
  let start = firstDuration;
  let bounce = 0;
  while (bounce < 64 && time > start + duration) {
    start += duration;
    duration *= restitution;
    bounce += 1;
  }
  const progress = Math.max(0, Math.min(1, (time - start) / duration));
  const depth = restitution ** (2 * (bounce + 1));
  return 1 - depth * 4 * progress * (1 - progress);
}

/** Exact interval boundaries where known curves change direction; null otherwise. */
export function easingBreakpoints(easing, intensity = 50) {
  const value = normalizeEasing(easing);
  const strength = normalizeIntensity(intensity);
  if (value !== "bounce") return null;
  const { restitution, firstDuration } = bounceParameters(strength);
  const points = [0, firstDuration];
  let start = firstDuration;
  let duration = (1 - firstDuration) * (1 - restitution);
  // Mirror the evaluator's finite bounce limit. Late arcs are too short for a
  // uniform time scan, but can still cross whole-number boundaries in a Counter.
  for (let bounce = 0; bounce <= 64; bounce += 1) {
    const end = Math.min(1, start + duration);
    for (const point of [start + duration / 2, end]) {
      if (point > points[points.length - 1] && point < 1) points.push(point);
    }
    if (end >= 1 || end <= start) break;
    start = end;
    duration *= restitution;
  }
  points.push(1);
  return points;
}

function interpolatedParameters(knots, intensity) {
  return knots[0].map((_, index) => interpolateIntensityAnchors(
    knots[0][index], knots[1][index], knots[2][index], intensity,
  ));
}

function logisticSegment(progress, rise, fall, shift, linear = 0, quadratic = 0) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const logit = shift + rise * Math.log(progress) - fall * Math.log1p(-progress) +
    linear * progress + quadratic * progress * progress;
  return 1 / (1 + Math.exp(-logit));
}

function overshootAt(time, intensity) {
  const [middle, amount, riseLeft, fallLeft, shiftLeft, riseRight, fallRight, shiftRight] =
    interpolatedParameters(OVERSHOOT_PARAMETERS, intensity);
  if (time <= middle) return (1 + amount) * logisticSegment(time / middle, riseLeft, fallLeft, shiftLeft);
  const progress = (time - middle) / (1 - middle);
  return 1 + amount * (1 - logisticSegment(progress, riseRight, fallRight, shiftRight));
}

function impulseAt(time, intensity) {
  const [middle, amount, riseLeft, fallLeft, shiftLeft, linearLeft, quadraticLeft,
    riseRight, fallRight, shiftRight, linearRight, quadraticRight] =
    interpolatedParameters(IMPULSE_PARAMETERS, intensity);
  if (time <= middle) {
    return -amount * logisticSegment(time / middle, riseLeft, fallLeft, shiftLeft, linearLeft, quadraticLeft);
  }
  const progress = (time - middle) / (1 - middle);
  return -amount + (1 + amount) *
    logisticSegment(progress, riseRight, fallRight, shiftRight, linearRight, quadraticRight);
}

function swingAt(time, intensity) {
  const dipTime = interpolateIntensityAnchors(...SWING.dipTime, intensity);
  const peakTime = interpolateIntensityAnchors(...SWING.peakTime, intensity);
  const depth = interpolateIntensityAnchors(...SWING.depth, intensity);
  const smooth = (progress) => progress * progress * (3 - 2 * progress);
  if (time <= dipTime) return -depth * smooth(time / dipTime);

  if (time <= peakTime) {
    const [rise, fall, shift, linear, quadratic, cubic] = [0, 1, 2, 3, 4, 5].map((index) =>
      interpolateIntensityAnchors(SWING.rise[0][index], SWING.rise[1][index], SWING.rise[2][index], intensity));
    const progress = (time - dipTime) / (peakTime - dipTime);
    const logit = rise * Math.log(progress) - fall * Math.log1p(-progress) - shift +
      linear * progress + quadratic * progress * progress + cubic * progress ** 3;
    const normalized = 1 / (1 + Math.exp(-logit));
    return -depth + (1 + 1.5 * depth) * normalized;
  }

  const [power, linear, quadratic] = [0, 1, 2].map((index) =>
    interpolateIntensityAnchors(SWING.tail[0][index], SWING.tail[1][index], SWING.tail[2][index], intensity));
  const progress = (time - peakTime) / (1 - peakTime);
  return 1 + (depth / 2) * (1 - progress) ** power *
    (1 + linear * progress + quadratic * progress * progress);
}

// Spring and back-out, ported from ArtCraft FilmCraft, filmcraft/crates/render/src/transitions/motion.rs
// (`spring`, `back_out`; MIT OR Apache-2.0, (c) the ArtCraft authors). Intensity sets FilmCraft's
// bounce (0 to 0.8) and overshoot s (0.6 to 3; 50 is Penner's 1.70158).
function springAt(time, intensity) {
  const bounce = interpolateIntensityAnchors(0, 0.4, 0.8, intensity);
  const wave = (2 + 4 * bounce) * Math.PI;
  const damping = 4 + 6 * (1 - bounce);
  const settle = (u) => 1 - Math.exp(-damping * u) * Math.cos(wave * u);
  // A slower start (u = x^1.6) so the move reads before the bounce; the end is corrected to 1.
  const u = time ** 1.6;
  return settle(u) + u * (1 - settle(1));
}

function backOutAt(time, intensity) {
  const s = interpolateIntensityAnchors(0.6, 1.70158, 3, intensity);
  const x = time - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
}

/** 0 at both ends and 1 in the middle, smoothly (FilmCraft transitions.rs `bell`): a blur's or flash's peak. */
export function bell(progress) {
  const t = 4 * progress * (1 - progress);
  return t * t * (3 - 2 * t);
}

export function easingAt(easing, time, intensity = 50) {
  const value = normalizeEasing(easing);
  const strength = normalizeIntensity(intensity);
  finiteNumber(time, "easing time");
  if (time <= 0) return 0;
  if (time >= 1) return 1;
  if (Array.isArray(value)) return cubicBezierAt(value, time);
  const bezier = easingBezier(value, strength);
  if (bezier) return cubicBezierAt(bezier, time);
  switch (value) {
    case "elastic": {
      const damping = ELASTIC_DAMPING;
      const frequency = (2 * Math.PI) / elasticPeriod(strength);
      return 1 - Math.exp(-damping * time) *
        (Math.cos(frequency * time) + (damping / frequency) * Math.sin(frequency * time));
    }
    case "bounce": return bounceAt(time, strength);
    case "overshoot": return overshootAt(time, strength);
    case "impulse": return impulseAt(time, strength);
    case "swing": return swingAt(time, strength);
    case "spring": return springAt(time, strength);
    case "back-out": return backOutAt(time, strength);
    default: throw new RangeError(`unsupported easing "${String(value)}"`);
  }
}
