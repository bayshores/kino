// The animations a move made together on one layer: a flash's fade in and its settle, a dissolve's
// fade and its sharpen. Deleting one alone leaves the other playing (a fade in kept after the flash
// that covered it was deleted showed the bare background for 3 frames), so delete_animation names
// the partners and takes them with it when asked (pair: true).
//
// A move names its animations <instance>.<role>-<name> on a layer that was already there and
// <layerId>.<name> on a layer it added (that layer carries `move`). Partners are the others on the
// same layer with the same instance and role (or all of the added layer's). The instance must be a
// move the scene records (scene.moves): kino's own ids look alike (lift_dark's <layer>.lift-deblock
// and <layer>.lift-grain) and are not a move's pair.
import { flattenAnimations } from "./animationTree.js";

const ON_USER_LAYER = /^([a-z0-9][a-z0-9-]*)\.([a-z0-9]+)-[a-z0-9-]+$/i;
const recorded = (moves, id) => (moves ?? []).some((entry) => entry?.id === id);

/** The prefix a move's animations share with `animation` on `layer`, or null when it is not a move's. */
export function partnerPrefix(layer, animation, moves) {
  const id = String(animation?.id ?? "");
  if (layer?.move && id.startsWith(`${layer.id}.`)) return `${layer.id}.`;
  const match = ON_USER_LAYER.exec(id);
  return match && recorded(moves, match[1]) ? `${match[1]}.${match[2]}-` : null;
}

/**
 * The other animations on `layer` that the same move made with `animation` (empty for one of your
 * own). `moves` is the scene's record of moves (scene.moves).
 */
export function animationPartners(layer, animation, moves) {
  const prefix = partnerPrefix(layer, animation, moves);
  if (!prefix) return [];
  return flattenAnimations(layer.animations ?? []).filter((item) => item.id !== animation.id && String(item.id ?? "").startsWith(prefix));
}

/**
 * What a move leaves on the scene's other layers once `gone` (layer ids) are deleted, for each move
 * whose last own layer is among them: [{move, left: [{layer, animation}]}]. A delete_layer of a
 * move's part keeps the animations the move put on your layers (a flash's plate deleted, its
 * fade in stayed on the next shot), except its show and hide steps, which go with it; the move op
 * with remove:true takes the rest.
 */
export function moveLeftovers(scene, gone) {
  const deleted = new Set(gone);
  const instances = new Map((scene.layers ?? []).filter((layer) => deleted.has(layer.id) && layer.move?.instance).map((layer) => [layer.move.instance, layer.move.name]));
  const result = [];
  for (const [instance, name] of instances) {
    const kept = (scene.layers ?? []).filter((layer) => !deleted.has(layer.id));
    if (kept.some((layer) => layer.move?.instance === instance)) continue;
    const left = kept.flatMap((layer) => flattenAnimations(layer.animations ?? [])
      // Its show and hide steps leave with its last layer (moveLeftovers.js settleDeletedMoves).
      .filter((animation) => String(animation.id ?? "").startsWith(`${instance}.`) && animation.kind !== "show" && animation.kind !== "hide")
      .map((animation) => ({ layer, animation })));
    if (!left.length) continue;
    const record = (scene.moves ?? []).find((entry) => entry?.id === instance);
    result.push({ move: { id: instance, name: record?.name ?? name ?? instance }, left });
  }
  return result;
}
