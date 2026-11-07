import { numberParameter, renderVectorDisplacementMix } from "./periodicDisplacement.js";

/**
 * Original periodic displacement. Amplitude is a signed local-space distance
 * in SVG units; repeat is full sinusoidal cycles across the perpendicular
 * layer axis, and offset is measured in cycles. Static signed sine/cosine
 * maps are mixed with nonnegative weights so animating phase never regenerates
 * the PNG fields.
 */
export function renderDisplacement(frame) {
  const amplitude = numberParameter(frame, "amplitude", 10, -128, 128);
  if (amplitude === 0) return frame.content;
  const repeat = numberParameter(frame, "repeat", 1, 0.25, 32);
  const offset = numberParameter(frame, "offset", 1, -1000, 1000);
  const direction = ["horizontal", "vertical", "both"].includes(frame.parameters?.direction)
    ? frame.parameters.direction : "horizontal";
  const phase = 2 * Math.PI * (offset - Math.floor(offset));
  const phaseCos = Math.cos(phase), phaseSin = Math.sin(phase);
  const sum = Math.abs(phaseCos) + Math.abs(phaseSin);
  const weightSin = Math.abs(phaseCos) / sum;
  const weightCos = Math.abs(phaseSin) / sum;
  const signSin = Math.sign(phaseCos), signCos = Math.sign(phaseSin);
  const keyPrefix = JSON.stringify(["displacement-v2", direction, repeat, frame.bounds.width, frame.bounds.height]);
  const basis = (type, sign, weight) => ({
    key: `${keyPrefix}|${type}|${sign}`,
    weight,
    vectorAt: (u, v) => {
      const sample = type === "sin" ? Math.sin : Math.cos;
      const x = direction === "vertical" ? 0 : sign * sample(2 * Math.PI * repeat * v);
      const y = direction === "horizontal" ? 0 : sign * sample(2 * Math.PI * repeat * u);
      return { x, y };
    },
  });

  const fields = [
    basis("sin", signSin, weightSin),
    basis("cos", signCos, weightCos),
  ].filter((field) => field.weight > 0);
  return renderVectorDisplacementMix(frame, fields, 2 * amplitude * sum, { padding: Math.abs(amplitude) + 1 });
}
