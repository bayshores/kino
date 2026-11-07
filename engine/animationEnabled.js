// Turning an animation off for playback: `animation.enabled`.
//
// - It is saved only as `enabled: false`; an animation that is on has no `enabled` field
//   (model.js drops `enabled: true`), so older documents stay on.
// - An animation that is off is skipped everywhere animations are evaluated: the stage, every
//   export (PNG, GIF, video and Lottie), component instances, Hide/Show visibility, the start
//   values later animations take (animation.js applyOperations), the text unit mode and a
//   component's play length. A Composed group that is off also turns off what it holds.
// - It is still an animation: it can be moved, resized, copied, staggered and deleted, and
//   turning it on again brings back exactly what it did.
// Agents set it with update_animation or update_animations { enabled }.
import { flattenAnimations } from "./animationTree.js";

/** Whether an animation is used in playback: true unless it was turned off (`enabled: false`). */
export function isAnimationEnabled(animation) {
  return animation?.enabled !== false;
}

/** The operations of a list that are used in playback, in their saved order. */
export function enabledAnimations(animations) {
  return flattenAnimations(animations, { enabledOnly: true });
}

/**
 * The problem with an `enabled` value an API edit (operations.js update_animation and
 * update_animations) sets, or null when it sets none or sets true or false.
 */
export function enabledValueProblem(properties, operationType) {
  if (!properties || typeof properties !== "object" || !("enabled" in properties)) return null;
  return typeof properties.enabled === "boolean" ? null : `${operationType} enabled must be true or false.`;
}
