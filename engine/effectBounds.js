import { point } from "./geometry.js";
import { shadowAlpha } from "./shadowInterpolation.js";
import { stackedShadows } from "./stackedShadows.js";

export function mergeBounds(boxes) {
  let result = null;
  for (const box of boxes) {
    if (!box) continue;
    if (!result) { result = { ...box }; continue; }
    const x = Math.min(result.x, box.x), y = Math.min(result.y, box.y);
    result = { x, y, width: Math.max(result.x + result.width, box.x + box.width) - x,
      height: Math.max(result.y + result.height, box.y + box.height) - y };
  }
  return result;
}

export function mappedBounds(bounds, matrix) {
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  return mergeBounds([[x, y], [x + width, y], [x, y + height], [x + width, y + height]].map(([px, py]) =>
    ({ ...point(matrix, px, py), width: 0, height: 0 })));
}

// Three Gaussian sigmas around the original paint and its displaced shadow.
export function expandEffectBounds(bounds, state) {
  if (!bounds) return null;
  // A stacked list adds one box per shadow, each sized like a single shadow's.
  const stacked = stackedShadows(state);
  if (stacked.length)
    return mergeBounds([{ ...state, shadows: null }, ...stacked.map((shadow) => ({ ...state, shadow, shadows: null }))]
      .map((one) => expandEffectBounds(bounds, one)));
  const shadow = state.shadow && shadowAlpha(state.shadow.color) > 0 ? state.shadow : null;
  const spread = 1.5 * (Math.max(0, state.blur ?? 0) + (shadow?.blur ?? 0)) + Math.max(0, state.strokeWidth ?? 0);
  const dx = shadow?.x ?? 0, dy = shadow?.y ?? 0;
  return { x: bounds.x + Math.min(0, dx) - spread, y: bounds.y + Math.min(0, dy) - spread,
    width: bounds.width + Math.abs(dx) + 2 * spread, height: bounds.height + Math.abs(dy) + 2 * spread };
}
