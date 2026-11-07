import { DEFAULT_SHADOW, copyShadow, interpolateShadow, shadowAlpha, transparentShadow, withShadowAlpha } from "./shadowInterpolation.js";

/** The independently animated parts of a drop shadow. */
export const SHADOW_CHANNELS = Object.freeze(["color", "opacity", "x", "y", "blur"]);
const channelNames = new Set(SHADOW_CHANNELS);

/** Return a canonical channel mask, or null when the legacy whole-shadow behavior is requested. */
export function normalizeShadowChannels(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError("Shadow channels must be a nonempty array of distinct channel names.");

  const selected = new Set();
  for (const channel of value) {
    if (typeof channel !== "string" || !channelNames.has(channel))
      throw new TypeError(`Unknown shadow channel ${String(channel)}.`);
    if (selected.has(channel)) throw new TypeError(`Shadow channel ${channel} is listed more than once.`);
    selected.add(channel);
  }
  return SHADOW_CHANNELS.filter((channel) => selected.has(channel));
}

/**
 * Interpolate only the requested shadow channels over the currently composed shadow.
 * Null endpoints retain their other endpoint's geometry and RGB with zero opacity so
 * independent tracks can share the same transparent shadow state.
 */
export function interpolateShadowChannels(current, from, to, progress, channels) {
  const selected = normalizeShadowChannels(channels);
  if (!selected || selected.length === SHADOW_CHANNELS.length)
    return interpolateShadow(from, to, progress);

  const currentShadow = copyShadow(current);
  const result = currentShadow ?? transparentShadow(DEFAULT_SHADOW);
  const fromShadow = copyShadow(from);
  const toShadow = copyShadow(to);

  if (!fromShadow && !toShadow) {
    if (!currentShadow) return null;
    if (!selected.includes("opacity")) return currentShadow;
    result.color = withShadowAlpha(result.color, 0);
    return result;
  }

  const sampleFrom = fromShadow ?? transparentShadow(toShadow);
  const sampleTo = toShadow ?? transparentShadow(fromShadow);
  const sample = interpolateShadow(sampleFrom, sampleTo, progress);

  // Apply RGB before opacity; opacity then retains the newly sampled RGB if both are selected.
  if (selected.includes("color"))
    result.color = withShadowAlpha(sample.color, shadowAlpha(result.color));
  if (selected.includes("opacity"))
    result.color = withShadowAlpha(result.color, shadowAlpha(sample.color));
  for (const channel of ["x", "y", "blur"])
    if (selected.includes(channel)) result[channel] = sample[channel];

  return result;
}
