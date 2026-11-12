import { effectDefinition, effectDefaults, effectInitialValues, KEEP_STILL, normalizeEffectParameters } from "./catalog.js";
import { easingAt, normalizeEasing, normalizeIntensity } from "../easing.js";
import { enabledAnimations } from "../animationEnabled.js";
import { resolvePlayback } from "../playback.js";
import { MAX_TIME } from "../schema.js";
import { clamp } from "../numbers.js";
import { behaviorOffset, normalizeBehavior } from "../behavior.js";

export const isEffectAnimation = (animation) => animation?.kind === "effect";
/** The fields an effect animation has; its settings go inside `to` (and `from`). */
export const EFFECT_ANIMATION_FIELDS = Object.freeze(new Set(["id", "name", "kind", "effect", "start", "duration", "easing", "intensity", "from", "to", "keepStill", "enabled", "behavior", "peak", "return"]));
const allowed = EFFECT_ANIMATION_FIELDS;
// Where a rise-and-return reaches `to`, as a share of its window, when only return is given. From
// the transitions study's reference radial smear: the bloom peaks at frame 7 of 21 (0.33), then
// falls back over the landing shot.
export const DEFAULT_PEAK = 0.35;

// A value effect with peak (0.05 to 0.95) or return: true rises from From to To by the peak and
// falls back to From by the end of its window, so one animation is a pulse instead of two.
function readPeak(animation, effect) {
  if (animation.peak == null && (animation.return == null || animation.return === false)) return null;
  if (effect.kind !== "value") throw new TypeError(`peak and return work on value effects; ${effect.key} is a ranged effect: give it a short start and duration instead`);
  if (animation.return != null && typeof animation.return !== "boolean") throw new TypeError("return must be true or false");
  if (animation.return === false) throw new TypeError("peak rises to `to` and falls back; leave out return:false, or leave out peak for a one-way change");
  const peak = animation.peak ?? DEFAULT_PEAK;
  if (typeof peak !== "number" || !Number.isFinite(peak) || peak < 0.05 || peak > 0.95)
    throw new RangeError("peak is the share of the window where the value is highest: a number from 0.05 to 0.95");
  return peak;
}

/** The share of the way from From to To at `share` (0..1 of the window), rising and falling for a peak. */
function pulseShare(peak, share) {
  if (peak == null) return share;
  return share <= peak ? share / peak : (1 - share) / (1 - peak);
}

// The document normalizer already validates the common ID/name/enabled fields and the absolute
// time of a Composed member. Refuse unrelated animation fields rather than silently losing them.
export function normalizeEffectAnimation(animation, { maxTime = MAX_TIME } = {}) {
  const effect = effectDefinition(animation.effect);
  for (const key of Object.keys(animation)) if (!allowed.has(key)) {
    // A setting of the effect named beside start and duration belongs inside to (and from).
    if (Object.hasOwn(effect.parameters, key))
      throw new TypeError(`${key} is a ${effect.key} setting, not an animation field: put it in to (and from), such as to:${JSON.stringify({ [key]: animation[key] })}`);
    throw new TypeError(`${key} is not an effect animation field${key === "parameters" ? ": an effect's settings are in to (and from)" : ""}`);
  }
  for (const [key, min] of [["start", 0], ["duration", 0.001]]) {
    if (typeof animation[key] !== "number" || !Number.isFinite(animation[key]) || animation[key] < min || animation[key] > maxTime)
      throw new RangeError(`${key} must be a number from ${min} to ${maxTime}`);
  }
  if (animation.start + animation.duration > maxTime) throw new RangeError(`start plus duration cannot exceed ${maxTime} seconds`);
  const result = { ...animation, easing: normalizeEasing(animation.easing ?? effect.easing),
    to: normalizeEffectParameters(effect.key, animation.to, { path: "to" }) };
  if (animation.from == null) delete result.from;
  else {
    result.from = normalizeEffectParameters(effect.key, animation.from, { partial: true, path: "from" });
    if (!Object.keys(result.from).length) delete result.from;
    // Some settings (a particle generator's lifetime, seed, loop...) hold for the whole effect.
    for (const [key, value] of Object.entries(result.from ?? {}))
      if (effect.parameters[key].animatable === false && value !== result.to[key])
        throw new RangeError(`from.${key} must equal to.${key}: ${effect.key} keeps ${key} fixed for the whole effect`);
  }
  // oscillate, ramp, randomize and wiggle add to named number settings (behavior.js); no loop.
  if (animation.behavior == null) delete result.behavior;
  else {
    const movable = Object.keys(result.to).filter((key) => effect.parameters[key].type === "number" && effect.parameters[key].animatable !== false);
    try {
      result.behavior = normalizeBehavior(animation.behavior, (key) => movable.includes(key), { duration: animation.duration, effect: true,
        keyHint: (key, label) => `${label}.${key}: ${effect.key} has no setting ${key} that can move; use ${movable.join(", ") || "none"}` });
    } catch (error) { throw new TypeError(`behavior ${error.message}`); }
  }
  const peak = readPeak(animation, effect);
  delete result.return;
  if (peak == null) delete result.peak;
  else result.peak = peak;
  if (animation.intensity == null) delete result.intensity;
  else result.intensity = normalizeIntensity(animation.intensity);
  if (effect.kind === "ranged") {
    // An accent (invert, lines, a burn) draws only inside its range unless asked to hold.
    result.keepStill = animation.keepStill ?? effect.keepStill ?? "both";
    if (!KEEP_STILL.some(([value]) => value === result.keepStill)) throw new RangeError("keepStill must be off, start, end, or both");
  } else if (animation.keepStill !== undefined) throw new TypeError("keepStill is only available on ranged effects");
  return result;
}

export function createEffectAnimation(key, layer, start, scene, id, parameters = {}) {
  const effect = effectDefinition(key);
  if (!layer || layer.type === "audio") throw new TypeError("Effects need a layer that is drawn");
  const sceneDuration = clamp(Number.isFinite(scene?.duration) ? scene.duration : 4, 0.001, MAX_TIME);
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) throw new RangeError("Effect start must be a finite nonnegative number");
  const from = effectInitialValues(key);
  const at = effect.kind === "ranged" ? 0 : Math.min(start, Math.max(0, sceneDuration - 0.001));
  // Timeline labels already prepend the owning layer's name.
  return normalizeEffectAnimation({ id, name: effect.label, kind: "effect", effect: key,
    start: at, duration: effect.kind === "ranged" ? sceneDuration : Math.min(effect.duration, Math.max(0.001, sceneDuration - at)),
    easing: effect.easing, to: normalizeEffectParameters(key, parameters),
    ...(Object.keys(from).length ? { from } : {}), ...(effect.kind === "ranged" ? { keepStill: effect.keepStill ?? "both" } : {}) });
}

function colorAt(from, to, progress) {
  const channel = (color, offset) => parseInt(color.slice(offset, offset + 2), 16);
  return `#${[1, 3, 5].map((offset) => Math.round(clamp(channel(from, offset) + (channel(to, offset) - channel(from, offset)) * progress, 0, 255)).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function parametersAt(effect, from, to, progress) {
  return Object.fromEntries(Object.entries(effect.parameters).filter(([key, field]) => !field.optional || key in from || key in to).map(([key, field]) => {
    const a = from[key] ?? to[key] ?? field.default, b = to[key] ?? field.default;
    if (field.type === "number") {
      const value = clamp(a + (b - a) * progress, field.min, field.max);
      return [key, field.integer ? Math.round(value) : value];
    }
    if (field.type === "color") return [key, colorAt(a, b, progress)];
    // Two curves with the same number of points move point by point (their inputs stay in
    // order); curves with different counts, and other values, switch halfway.
    if (field.type === "curve" && a.length === b.length && progress > 0 && progress < 1)
      return [key, a.map((point, index) => point.map((value, axis) => clamp(value + (b[index][axis] - value) * progress, 0, 1)))];
    return [key, progress < 0.5 ? a : b];
  }));
}

function sample(operation, effect, from, time) {
  const seconds = clamp(time - operation.start, 0, operation.duration);
  const progress = easingAt(operation.easing ?? effect.easing, pulseShare(operation.peak, seconds / operation.duration), operation.intensity ?? 50);
  const parameters = parametersAt(effect, from, operation.to, progress);
  if (operation.behavior) for (const [key, value] of Object.entries(parameters)) {
    const field = effect.parameters[key];
    const offset = field.type === "number" ? behaviorOffset(operation.behavior, key, seconds, operation.duration) : 0;
    if (offset) parameters[key] = field.integer ? Math.round(clamp(value + offset, field.min, field.max)) : clamp(value + offset, field.min, field.max);
  }
  return { operation, effect, parameters, time: seconds, progress };
}

/**
 * Return the active stack in timeline order, using the same component clock as ordinary motion.
 * Value effects replace earlier values of the same effect. An omitted From samples that earlier
 * value at this operation's start (neutral if none); after the end it holds. That sampling/hold
 * rule is kino's explicit design.
 * Ranged effects may stack. Their end is exclusive when Keep still is Off/At start; held frames
 * clamp both progress AND the noise clock, so a completed Fluid Warp really stops moving.
 */
export function effectsAt(layer, time) {
  if (typeof time !== "number" || !Number.isFinite(time)) throw new TypeError("Effect time must be a finite number");
  const playback = resolvePlayback(layer, time);
  if (!playback.visible || layer.type === "audio") return [];
  const clock = playback.time;
  const ordered = enabledAnimations(layer.animations).map((operation, index) => ({ operation, index }))
    .filter(({ operation }) => isEffectAnimation(operation))
    .sort((a, b) => a.operation.start - b.operation.start || a.index - b.index);
  const previous = new Map(), active = [];
  for (const { operation } of ordered) {
    const effect = effectDefinition(operation.effect);
    if (effect.kind === "value") {
      if (clock < operation.start) continue;
      const earlier = previous.get(effect.key);
      const baseline = earlier ? sample(earlier.operation, effect, earlier.from, operation.start).parameters : effectDefaults(effect.key, { neutral: true });
      const from = { ...baseline, ...operation.from };
      if (earlier) active[earlier.activeIndex] = null;
      previous.set(effect.key, { operation, from, activeIndex: active.length });
      active.push(sample(operation, effect, from, clock));
    } else {
      const hold = operation.keepStill ?? "both";
      if (clock < operation.start && !["start", "both"].includes(hold)) continue;
      if (clock >= operation.start + operation.duration && !["end", "both"].includes(hold)) continue;
      active.push(sample(operation, effect, { ...operation.to, ...operation.from }, clock));
    }
  }
  return active.filter(Boolean);
}
