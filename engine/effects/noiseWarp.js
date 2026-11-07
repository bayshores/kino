import { fractalNoise } from "./maps.js";
import {
  booleanParameter,
  numberParameter,
  renderVectorDisplacementMix,
  temporalSeed,
  timeSeconds,
} from "./periodicDisplacement.js";

/**
 * Original independent-channel fractal noise warp. Amount is px; Noise Scale
 * is cycles across the shorter layer side; Speed is seeded-field transitions
 * per second. Each static vector map is cached by scale/seed and SVG performs
 * the time-dependent nonnegative cross-fade, so playback does not re-encode
 * a PNG every frame.
 */
export function renderNoiseWarp(frame) {
  const amount = numberParameter(frame, "amount", 26, 0, 128);
  if (amount === 0) return frame.content;
  const noiseScale = numberParameter(frame, "noiseScale", 1, 0.1, 16);
  const speed = numberParameter(frame, "speed", 1, -4, 4);
  const contain = booleanParameter(frame, "contain", true);
  const { seed, weight } = temporalSeed(timeSeconds(frame), speed);
  const side = Math.min(frame.bounds.width, frame.bounds.height);
  const scaleX = noiseScale * frame.bounds.width / side;
  const scaleY = noiseScale * frame.bounds.height / side;
  const fields = [];
  const makeField = (fieldSeed, fieldWeight) => fields.push({
    key: JSON.stringify(["noise-warp-v2", noiseScale, fieldSeed, frame.bounds.width, frame.bounds.height]),
    weight: fieldWeight,
    vectorAt: (u, v) => ({
      x: fractalNoise(u * scaleX + 11.75, v * scaleY - 8.57, 4, fieldSeed),
      y: fractalNoise(u * scaleX + 29.5, v * scaleY - 21.535, 4, fieldSeed + 1),
    }),
  });

  makeField(seed, 1 - weight);
  if (weight > 0) makeField(seed + 1, weight);
  return renderVectorDisplacementMix(frame, fields, 2 * amount, {
    contain,
    padding: amount + 1,
  });
}
