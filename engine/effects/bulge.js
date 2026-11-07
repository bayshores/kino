import { numberParameter, radialVector, renderVectorDisplacement } from "./periodicDisplacement.js";

/**
 * Original radial bulge map.
 * Amount is a signed scale factor: 1 pulls source samples inward by up to
 * 12.5% of the layer's shorter side; -1 reverses the bulge to a pinch.
 */
export function renderBulge(frame) {
  const amount = numberParameter(frame, "amount", 1, -2, 2);
  if (amount === 0) return frame.content;

  const side = Math.min(frame.bounds.width, frame.bounds.height);
  const maxShift = Math.min(128, side * 0.125 * Math.abs(amount));
  const sign = Math.sign(amount);
  const key = JSON.stringify(["bulge-v1", sign, frame.bounds.width, frame.bounds.height]);
  return renderVectorDisplacement(frame, key, maxShift, (u, v, width, height) => {
    const center = radialVector(u, v, 0.5, 0.5, width, height);
    const radius = Math.min(1, center.length / (side * 0.5));
    const influence = 4 * radius * (1 - radius);
    return { x: -sign * center.x * influence, y: -sign * center.y * influence };
  }, { padding: maxShift + 1 });
}
