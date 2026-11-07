import {
  numberParameter,
  radialVector,
  renderVectorDisplacementMix,
  timeSeconds,
} from "./periodicDisplacement.js";

const wrappedUnit = (value) => value - Math.floor(value);
const sharpWave = (value, sharpness) => Math.sign(value) * Math.pow(Math.abs(value), 1 / sharpness);

/**
 * Original radial ripple. Strength is a fraction of the layer's short side;
 * Frequency is waves from the selected center to the farthest layer corner,
 * center coordinates are normalized, and Speed is cycles per second.
 * Sharpness shapes each wave toward a flatter crest. Four cached quarter-cycle
 * maps are interpolated with nonnegative weights for smooth periodic motion.
 */
export function renderRipple(frame) {
  const speed = numberParameter(frame, "speed", 0.6, -4, 4);
  const strength = numberParameter(frame, "strength", 0.18, 0, 0.5);
  if (strength === 0) return frame.content;
  const frequency = numberParameter(frame, "frequency", 8, 0.1, 32);
  const centerX = numberParameter(frame, "centerX", 0.5, 0, 1);
  const centerY = numberParameter(frame, "centerY", 0.5, 0, 1);
  const falloff = numberParameter(frame, "falloff", 1.2, 0, 8);
  const sharpness = numberParameter(frame, "sharpness", 6, 1, 16);
  const temporalPosition = wrappedUnit(timeSeconds(frame) * speed) * 4;
  const phaseIndex = Math.floor(temporalPosition);
  const phaseWeight = temporalPosition - phaseIndex;
  const side = Math.min(frame.bounds.width, frame.bounds.height);
  const centerPxX = centerX * frame.bounds.width;
  const centerPxY = centerY * frame.bounds.height;
  const radius = Math.max(1,
    Math.hypot(centerPxX, centerPxY),
    Math.hypot(frame.bounds.width - centerPxX, centerPxY),
    Math.hypot(centerPxX, frame.bounds.height - centerPxY),
    Math.hypot(frame.bounds.width - centerPxX, frame.bounds.height - centerPxY));
  const maxDisplacement = Math.min(128, strength * side);
  const fields = [];

  const makeField = (quarter, weight) => {
    const phase = 2 * Math.PI * quarter / 4;
    fields.push({
      key: JSON.stringify(["ripple-v2", frequency, centerX, centerY, falloff, sharpness, quarter,
        frame.bounds.width, frame.bounds.height]),
      weight,
      vectorAt: (u, v, width, height) => {
        const radial = radialVector(u, v, centerX, centerY, width, height);
        if (radial.length < 1e-12) return { x: 0, y: 0 };
        const radiusFraction = Math.min(1, radial.length / radius);
        const wave = sharpWave(Math.sin(2 * Math.PI * frequency * radiusFraction - phase), sharpness);
        const attenuation = Math.exp(-falloff * radiusFraction);
        return { x: radial.x * wave * attenuation, y: radial.y * wave * attenuation };
      },
    });
  };

  makeField(phaseIndex, 1 - phaseWeight);
  if (phaseWeight > 0) makeField((phaseIndex + 1) % 4, phaseWeight);
  return renderVectorDisplacementMix(frame, fields, 2 * maxDisplacement, {
    padding: maxDisplacement + 1,
  });
}
