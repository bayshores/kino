import { fractalNoise, mapDimensions } from "./maps.js";
import {
  booleanParameter,
  numberParameter,
  renderVectorDisplacementMix,
  temporalSeed,
  timeSeconds,
} from "./periodicDisplacement.js";

/**
 * Original fluid-style warp: each static map is the normalized curl of a
 * scalar fractal-noise potential. This rotational field differs from Noise
 * Warp's independent channels. Amount is px, Noise Scale is cycles across the
 * short side, and Speed is adjacent seeded fields per second. PNGs depend only
 * on parameters and integer seeds; SVG mixes them with convex weights.
 */
export function renderFluidWarp(frame) {
  const amount = numberParameter(frame, "amount", 10, 0, 128);
  if (amount === 0) return frame.content;
  const noiseScale = numberParameter(frame, "noiseScale", 1, 0.1, 16);
  const octaves = numberParameter(frame, "octaves", 2, 1, 8, { integer: true });
  const speed = numberParameter(frame, "speed", 1, -4, 4);
  const contain = booleanParameter(frame, "contain", false);
  const start = numberParameter(frame, "seed", 0, 0, 1_000_000, { integer: true });
  const { seed: tick, weight } = temporalSeed(timeSeconds(frame), speed);
  // Seed 0 keeps the fields drawn before the setting existed.
  const seed = tick + start * 7919;
  const side = Math.min(frame.bounds.width, frame.bounds.height);
  const scaleX = noiseScale * frame.bounds.width / side;
  const scaleY = noiseScale * frame.bounds.height / side;
  const dimensions = mapDimensions(frame.bounds);
  const delta = 0.5 / Math.max(1, Math.min(dimensions.width, dimensions.height));
  const fields = [];

  const makeField = (fieldSeed, fieldWeight) => {
    const potential = (u, v) => fractalNoise(
      u * scaleX + 17.25,
      v * scaleY - 9.5,
      octaves,
      fieldSeed,
    );
    fields.push({
      key: JSON.stringify(["fluid-warp-v2", noiseScale, octaves, fieldSeed, frame.bounds.width, frame.bounds.height]),
      weight: fieldWeight,
      vectorAt: (u, v) => {
        const dx = potential(u + delta, v) - potential(u - delta, v);
        const dy = potential(u, v + delta) - potential(u, v - delta);
        const curlX = dy, curlY = -dx;
        const length = Math.hypot(curlX, curlY);
        return length > 1e-10 ? { x: curlX / length, y: curlY / length } : { x: 0, y: 0 };
      },
    });
  };

  makeField(seed, 1 - weight);
  if (weight > 0) makeField(seed + 1, weight);
  return renderVectorDisplacementMix(frame, fields, 2 * amount, {
    contain,
    padding: amount + 1,
  });
}
