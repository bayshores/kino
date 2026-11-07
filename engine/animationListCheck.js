// The checks an animation passes before apply_operations stores it, for one animation and for a
// whole list.
//
// add_animation and update_animation(s) check the one animation they add or change. add_layer,
// update_layer (with `animations`) and insert_component set a layer's whole list at once, and
// add_scene and update_scene (with `layers`) set every layer's list at once, so
// animationListProblem and sceneAnimationProblem run the same checks on every animation:
// - a Hide or Show must be on the scene's timeline (visibilityOps.js visibilityUpdateProblem),
//   and so must a Change text's start (textChange.js textChangeUpdateProblem),
// - a new Counter needs a text with a number in it (counter.js counterEditProblem),
// - a Color animation needs a layer with a Fill (paints.js fillAnimationEditProblem),
// - a Resize (width or height) needs a layer whose sides it can change (resizeAnchor.js
//   resizeEditProblem): not a group, audio, component instance, or text that sizes itself.
//
// An animation in the new list that has the same ID as one in the list before the edit is an
// edit of that older animation, so only the values the edit changes are checked. That way a
// document saved before a rule existed (a group's width wipe, or a Hide left past the end of a
// scene that was made shorter) can still set its list again with those animations unchanged.

import { visibilityUpdateProblem } from "./visibilityOps.js";
import { fillAnimationEditProblem } from "./paints.js";
import { resizeEditProblem } from "./resizeAnchor.js";
import { textChangeUpdateProblem } from "./textChange.js";
import { counterEditProblem } from "./counter.js";
import { flattenAnimations } from "./animationTree.js";
import { isRecord } from "./numbers.js";

/**
 * Why an edit that turns animation `before` into `after` on `layer` can't be stored in a scene
 * that lasts `sceneDuration` seconds, or null. `before` is undefined for a new animation.
 */
export function animationEditProblem(layer, before, after, sceneDuration) {
  return (
    visibilityUpdateProblem(before, after, sceneDuration) ||
    textChangeUpdateProblem(before, after, sceneDuration) ||
    counterEditProblem(layer, before, after) ||
    fillAnimationEditProblem(layer, before, after) ||
    resizeEditProblem(layer, before, after) ||
    null
  );
}

/**
 * The first problem with the animations in `layer.animations` after an edit that set the whole
 * list, or null. `previous` is the list before the edit (empty for a new layer). A list or an
 * item that is not an object is left for parseDocument, which reports it with its path.
 */
export function animationListProblem(layer, previous, sceneDuration) {
  if (!Array.isArray(layer?.animations)) return null;
  const before = new Map(flattenAnimations(previous).filter(isRecord).map((item) => [item.id, item]));
  for (const animation of flattenAnimations(layer.animations)) {
    if (!isRecord(animation)) continue;
    const problem = animationEditProblem(layer, before.get(animation.id), animation, sceneDuration);
    if (problem) return problem;
  }
  return null;
}

/**
 * The first problem with the animations of `scene.layers` after an edit that set the scene's
 * whole layer list (add_scene, or update_scene with `layers`), or null. `previousLayers` is the
 * list before the edit (empty for a new scene): a layer with the same ID and type keeps its
 * older animations, as in animationListProblem.
 */
export function sceneAnimationProblem(scene, previousLayers) {
  if (!Array.isArray(scene?.layers)) return null;
  const before = new Map((Array.isArray(previousLayers) ? previousLayers : []).filter(isRecord).map((layer) => [layer.id, layer]));
  for (const layer of scene.layers) {
    if (!isRecord(layer)) continue;
    const previous = before.get(layer.id);
    const problem = animationListProblem(layer, previous?.type === layer.type ? previous.animations : [], scene.duration);
    if (problem) return problem;
  }
  return null;
}
