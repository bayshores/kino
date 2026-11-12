// The animations a move made together on one layer: a flash's fade in and its settle, a dissolve's
// fade and its sharpen. Deleting one alone leaves the other playing (a fade in kept after the flash
// that covered it was deleted showed the bare background for 3 frames), so delete_animation names
// the partners and takes them with it when asked (pair: true).
//
// A move names its animations <instance>.<role>-<name> on a layer that was already there (role
// from, to or layer) and <layerId>.<name> on a layer it added (that layer carries `move`). Partners
// are the others on the same layer with the same instance and role (or all of the added layer's).
import { flattenAnimations } from "./animationTree.js";

const ON_USER_LAYER = /^([a-z0-9][a-z0-9-]*)\.([a-z0-9]+)-[a-z0-9-]+$/i;

/** The prefix a move's animations share with `animation` on `layer`, or null when it is not a move's. */
export function partnerPrefix(layer, animation) {
  const id = String(animation?.id ?? "");
  if (layer?.move && id.startsWith(`${layer.id}.`)) return `${layer.id}.`;
  const match = ON_USER_LAYER.exec(id);
  return match ? `${match[1]}.${match[2]}-` : null;
}

/** The other animations on `layer` that the same move made with `animation` (empty for one of your own). */
export function animationPartners(layer, animation) {
  const prefix = partnerPrefix(layer, animation);
  if (!prefix) return [];
  return flattenAnimations(layer.animations ?? []).filter((item) => item.id !== animation.id && String(item.id ?? "").startsWith(prefix));
}

