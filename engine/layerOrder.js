// Moving layers in the stacking order, into and out of groups, and switching their eye and
// lock flags. The layer list's drag and drop, the ] [ ⇧⌘] ⇧⌘[ keys, the eye and lock buttons
// and the apply_operations editing API all use these functions.
//
// A scene's layers are one flat array. `parentId` names a layer's group, and among the layers
// of one group a later layer is drawn on top. Only the order of layers that share a group
// matters, so a move takes the moved layers out of the array and puts them back next to the
// layer they are dropped at. The layers inside a moved group stay where they are in the array:
// they keep pointing at their group.
//
// Every function returns new layers (the input is not changed), or null when nothing would
// change. They throw an Error that says why when the change isn't possible.
import { IDENTITY, inverse, multiply, parentMatrix, worldMatrix } from "./geometry.js";
import { ancestorsOf, checkGroupMasks, checkMasks, groupMasks, maskGroupCoverage, maskOfGroup, maskTargets, moveLayer, paintOrder } from "./grouping.js";
import { expandComponents } from "./linkedComponents.js";
import { animatedKeys } from "./reparent.js";

const label = (layer) => `“${layer.name || layer.id}”`;

/** The ways reorderLayers can move layers, besides a number (a place among their siblings). */
export const ORDER_MOVES = ["front", "back", "forward", "backward"];

// The values that place a group's space on the canvas (geometry.js layerMatrix): its layers
// are drawn inside that space, so animating any of them moves its layers too.
const SPACE_KEYS = ["x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX"];

// True when a group's animations move, resize or turn its space, and so its layers.
function movesItsLayers(group) {
  const keys = animatedKeys(group);
  return SPACE_KEYS.some((key) => keys.has(key));
}

// A layer's group, or null at the scene's top level (also when the group does not exist).
function parentKey(layer, byId) {
  return byId.has(layer.parentId) ? layer.parentId : null;
}

// Why a layer ID can't be used: it is not in this scene, or it is drawn from a component.
function missingLayer(document, sceneId, layers, id, action) {
  let drawn = null;
  try {
    drawn = document ? expandComponents(document, sceneId, { camera: false }).layers.find((layer) => layer.id === id) : null;
  } catch {
    // A component that can't be drawn can't contain the layer either.
  }
  if (drawn?.componentOwnerId) {
    const owner = layers.find((layer) => layer.id === drawn.componentOwnerId);
    return new Error(
      `Can't ${action}: ${label(drawn)} is part of the component instance ${label(owner ?? { id: drawn.componentOwnerId })}. Edit the main component, or detach the instance first.`,
    );
  }
  return new Error(`Layer ${String(id)} was not found.`);
}

function checkIds(layerIds, byId, action, missing) {
  if (!Array.isArray(layerIds) || layerIds.length === 0) throw new Error(`Can't ${action}: choose at least one layer.`);
  for (const id of layerIds) if (typeof id !== "string" || !byId.has(id)) throw missing(id);
}

// The chosen layers without those whose group is also chosen (they move with the group),
// bottom to top in drawing order.
function rootsOf(layers, layerIds, byId) {
  const chosen = new Set(layerIds);
  const order = paintOrder(layers);
  return layers
    .filter((layer) => chosen.has(layer.id) && !ancestorsOf(layer, byId).some((item) => chosen.has(item.id)))
    .sort((left, right) => order.get(left.id) - order.get(right.id));
}

// True when the two layer lists have the same layers in the same order with the same groups.
function sameOrder(before, after) {
  return before.length === after.length && before.every((layer, index) => layer.id === after[index].id && layer.parentId === after[index].parentId);
}

// Inside a mask group, the mask covers the layers above it and not the ones below it
// (render.js). So:
// - a layer that stays in the mask group stays on its side of the mask, and the mask itself
//   doesn't move past the layers around it: the mask keeps covering the same layers;
// - a layer that joins a mask group goes above its mask, where the mask covers it.
// Leaving a mask group is fine: the layer is no longer masked, as moving it out asks for.
// `movedIds` are the layers the user moved, so the error can name the mask when it moved.
// With `mask` (move_layers {mask:true}) a layer may start being masked: the move asks for it.
function checkMaskGroupSides(before, after, movedIds, action, maskAsked = false) {
  const coveredAfter = maskGroupCoverage(after);
  const byIdBefore = new Map(before.map((layer) => [layer.id, layer])),
    byIdAfter = new Map(after.map((layer) => [layer.id, layer]));
  // Parents first, so the error names a moved group rather than a layer inside it.
  const order = paintOrder(before);
  const inOrder = [...after].sort((left, right) => order.get(left.id) - order.get(right.id));
  for (const [groupId, coveredBefore] of maskGroupCoverage(before)) {
    const covered = coveredAfter.get(groupId);
    if (!covered) continue; // a mask group that loses its mask is left to checkGroupMasks
    const isInside = (layer, byId) => ancestorsOf(layer, byId).some((item) => item.id === groupId);
    const group = byIdBefore.get(groupId),
      groupMask = maskOfGroup(group, before);
    for (const layer of inOrder) {
      if (!isInside(layer, byIdAfter)) continue;
      const stayed = isInside(byIdBefore.get(layer.id), byIdBefore);
      const wasCovered = stayed ? coveredBefore.has(layer.id) : true;
      if (wasCovered === covered.has(layer.id)) continue;
      if (maskAsked && !wasCovered) continue;
      if (movedIds.has(groupMask.id)) {
        throw new Error(
          `Can't ${action}: ${label(groupMask)} is the mask of the mask group ${label(group)} and stays below the layers it masks. Move the other layers instead, or drag a layer out of the mask group to stop masking it.`,
        );
      }
      const below = `Can't ${action}: ${label(layer)} would go below ${label(groupMask)}, the mask of ${label(group)}, where the mask doesn't cover it.`;
      throw new Error(
        !stayed
          ? `${below} Drop it above the mask instead.`
          : wasCovered
            ? `${below} Keep it above the mask, or drag it out of the mask group to stop masking it.`
            : `Can't ${action}: ${label(layer)} would go above ${label(groupMask)}, the mask of ${label(group)}, and start being masked. Keep it below the mask, or move it with mask:true to mask it.`,
      );
    }
  }
}

// Mask groups keep their masks, the masks stay below the layers they mask, and masks keep
// masking the same layers. A mask that had nothing to mask may start masking a moved layer
// when the move says so (`mask`: true, move_layers {mask:true}); without it that is refused,
// so a move never masks a layer by accident.
function checkMaskPairs(before, after, action, movedIds, mask = false) {
  checkGroupMasks(groupMasks(before), groupMasks(after), before, action);
  checkMaskGroupSides(before, after, movedIds, action, mask);
  const was = maskTargets(before),
    now = maskTargets(after);
  for (const [maskId, maskedId] of now) {
    if (maskedId === null || was.get(maskId) != null || !movedIds.has(maskedId)) continue;
    if (mask) {
      was.set(maskId, maskedId);
      continue;
    }
    const byId = new Map(before.map((layer) => [layer.id, layer]));
    // retryWith: what the op needs to work as meant (the agent's refusal sends it as next).
    throw Object.assign(new Error(
      `Can't ${action}: the mask ${label(byId.get(maskId))} would start masking ${label(byId.get(maskedId))}. To mask it on purpose, send the same move with mask: true; otherwise drop it somewhere else.`,
    ), { retryWith: { mask: true } });
  }
  for (const [maskId, maskedId] of now) {
    if (maskedId !== null || was.has(maskId)) continue;
    const mask = before.find((layer) => layer.id === maskId);
    throw new Error(`Can't ${action}: the mask ${label(mask)} would have no visible layer above it to mask. Move the mask and the layer it masks together.`);
  }
  checkMasks(was, now, before, action, "Move the mask and the layer it masks together.");
}

/**
 * Moves layers to a new place in the layer list, also into or out of groups, the way
 * dragging rows in the layer list does. Every moved layer keeps its place, size and turn on
 * the canvas: a layer that changes group gets new x, y, rotation, scale and animated values
 * in the new group's space (reparent.js), as grouping does.
 *
 * `target` is one of:
 * - { side: "above" | "below", referenceId }: just above or below that layer in the list,
 *   in the same group as it;
 * - { side: "top" | "bottom", parentId }: the top or bottom of a group's layers, or of the
 *   scene's top level when parentId is null.
 *
 * Layers whose group is also moved move with it. The moved layers keep their order. A layer
 * that joins a group also takes on what the group does to its layers, such as its opacity,
 * mask, clipping, hidden state or play range; that is what moving it there asks for. Refuses
 * moving a group into itself, moving layers into a component instance or a layer that is not
 * a group, moving layers into or out of a group whose place, size or turn is animated (they
 * could not stay in place), changes that would give a mask another layer to mask or a mask
 * group another mask, and moves across a mask group's mask (it stays below the layers it
 * masks). `mask: true` lets a mask that had nothing to mask start masking a moved layer.
 * `fonts` measures auto-sized text.
 * Returns { layers, movedIds } (the moved layers, bottom to top), or null when nothing moves.
 */
export function moveLayers(document, sceneId, layerIds, target, { fonts, mask } = {}) {
  const action = "move layers";
  const scene = document?.scenes?.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} was not found.`);
  const layers = scene.layers;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  checkIds(layerIds, byId, action, (id) => missingLayer(document, sceneId, layers, id, action));
  const side = target?.side;
  if (!["above", "below", "top", "bottom"].includes(side)) throw new Error(`Can't ${action}: the side must be above, below, top or bottom.`);

  // 1. The group the layers go into.
  let parent = null,
    reference = null;
  if (side === "above" || side === "below") {
    reference = byId.get(target.referenceId);
    if (!reference) throw missingLayer(document, sceneId, layers, target.referenceId, action);
    parent = byId.get(parentKey(reference, byId)) ?? null;
  } else if (target.parentId !== null && target.parentId !== undefined) {
    parent = byId.get(target.parentId);
    if (!parent) throw missingLayer(document, sceneId, layers, target.parentId, action);
  }
  if (parent?.type === "component") {
    throw new Error(`Can't ${action}: ${label(parent)} is a component instance, whose layers come from its main component. Edit the main component instead.`);
  }
  if (parent && parent.type !== "group") throw new Error(`Can't ${action}: ${label(parent)} is not a group, and only groups hold layers.`);

  // 2. A group can't go into itself or into a group inside it.
  const roots = rootsOf(layers, layerIds, byId);
  const moving = new Set(roots.map((root) => root.id));
  if (parent) {
    const around = [parent, ...ancestorsOf(parent, byId)];
    const inside = roots.find((root) => around.includes(root));
    if (inside) {
      throw new Error(
        inside === parent
          ? `Can't ${action}: ${label(inside)} can't go into itself.`
          : `Can't ${action}: ${label(inside)} can't go into ${label(parent)}, which is inside it.`,
      );
    }
  }

  // 3. A group whose place, size or turn is animated carries its layers along over time. The
  //    new x, y, rotation and scale below can keep a layer in place for only one pose of such
  //    a group, so at other times it would jump. Layers can't move into or out of it then
  //    (groupLayers refuses the same). Only the groups the layer leaves or enters count, not
  //    the ones around both its old and new place.
  const parentId = parent?.id ?? null;
  const newChain = parent ? [parent, ...ancestorsOf(parent, byId)] : [];
  for (const root of roots) {
    if (parentKey(root, byId) === parentId) continue;
    const oldChain = ancestorsOf(root, byId);
    const shared = oldChain.find((item) => newChain.includes(item));
    const leaving = shared ? oldChain.slice(0, oldChain.indexOf(shared)) : oldChain;
    const entering = shared ? newChain.slice(0, newChain.indexOf(shared)) : newChain;
    for (const [groups, verb] of [[leaving, "leave"], [entering, "move into"]]) {
      const animated = groups.find(movesItsLayers);
      if (animated) {
        throw new Error(
          `Can't ${action}: ${label(root)} would ${verb} ${label(animated)}, which is animated, so it would not stay in place while ${label(animated)} moves. Move it within its own group, or remove the group's animation first.`,
        );
      }
    }
  }

  // 4. Same look in the new group: the move from the old group's space to the new one's.
  const fromNewParent = inverse(parent ? worldMatrix(parent, layers) : IDENTITY);
  if (!fromNewParent) throw new Error(`Can't ${action}: ${label(parent)} is scaled to zero.`);
  const moved = new Map(
    roots.map((root) => {
      if (parentKey(root, byId) === parentId) return [root.id, root];
      try {
        const matrix = multiply(fromNewParent, parentMatrix(root, layers));
        return [root.id, { ...moveLayer(root, matrix, document.scenes, fonts), parentId }];
      } catch (error) {
        throw new Error(`Can't ${action}: ${error.message}`);
      }
    }),
  );
  const movedLayers = roots.map((root) => moved.get(root.id));

  // 5. The place in the list: next to a layer that stays, or at a group's top or bottom.
  const siblings = layers.filter((layer) => !moving.has(layer.id) && parentKey(layer, byId) === parentId);
  let anchor = null,
    before = false;
  if (side === "above") anchor = reference;
  else if (side === "below") [anchor, before] = [reference, true];
  else if (side === "top") anchor = siblings.at(-1) ?? parent;
  else [anchor, before] = siblings.length ? [siblings[0], true] : [parent, false];
  const next = [];
  if (!anchor && side === "bottom") next.push(...movedLayers);
  for (const layer of layers) {
    if (layer === anchor) {
      // A drop next to one of the moved layers puts them all where that layer was.
      if (moving.has(layer.id)) next.push(...movedLayers);
      else if (before) next.push(...movedLayers, layer);
      else next.push(layer, ...movedLayers);
    } else if (!moving.has(layer.id)) next.push(layer);
  }
  if (!anchor && side === "top") next.push(...movedLayers);
  if (sameOrder(layers, next)) return null;

  // 6. Masks keep their layers, and mask groups keep their masks below the layers they mask.
  checkMaskPairs(layers, next, action, moving, mask === true);
  return { layers: next, movedIds: roots.map((root) => root.id) };
}

// One group's layers (bottom first) with the chosen ones moved "front", "back", "forward" or
// "backward". Forward and backward move each chosen layer one step past the next layer that
// is not chosen.
function moveWithin(order, chosen, to) {
  const isChosen = (layer) => chosen.has(layer.id);
  if (to === "front") return [...order.filter((layer) => !isChosen(layer)), ...order.filter(isChosen)];
  if (to === "back") return [...order.filter(isChosen), ...order.filter((layer) => !isChosen(layer))];
  const result = [...order];
  if (to === "forward") {
    for (let at = result.length - 2; at >= 0; at -= 1) {
      if (isChosen(result[at]) && !isChosen(result[at + 1])) [result[at], result[at + 1]] = [result[at + 1], result[at]];
    }
  } else {
    for (let at = 1; at < result.length; at += 1) {
      if (isChosen(result[at]) && !isChosen(result[at - 1])) [result[at], result[at - 1]] = [result[at - 1], result[at]];
    }
  }
  return result;
}

/**
 * Moves layers up or down among the layers of their own group: "front" to the top, "back" to
 * the bottom, "forward" and "backward" one step past the next layer that is not moved, or a
 * number for one layer: its place among its group's layers, 0 at the bottom. The
 * shortcuts: ] bring to front, [ send to back, ⇧⌘] bring forward, ⇧⌘[ send backward.
 * Layers whose group is also chosen move with the group. Chosen layers in different groups
 * each move within their own group, keeping their order. In a mask group, layers move only
 * among the layers on their side of the mask: [ sends a masked layer to just above the mask.
 * Refuses moves that would change what a mask masks, such as moving a mask group's mask, or
 * a place number across it. Returns the new layers, or null.
 */
export function reorderLayers(layers, layerIds, to) {
  const action = "reorder layers";
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  checkIds(layerIds, byId, action, (id) => new Error(`Layer ${String(id)} was not found.`));
  const byPlace = typeof to === "number";
  if (!byPlace && !ORDER_MOVES.includes(to)) {
    throw new Error(`Can't ${action}: "to" must be front, back, forward, backward, or a place number.`);
  }
  const roots = rootsOf(layers, layerIds, byId);
  if (byPlace && roots.length !== 1) throw new Error(`Can't ${action}: a place number moves one layer at a time.`);
  const chosen = new Set(roots.map((root) => root.id));
  const next = [...layers];
  for (const groupId of new Set(roots.map((root) => parentKey(root, byId)))) {
    const slots = [];
    layers.forEach((layer, at) => {
      if (parentKey(layer, byId) === groupId) slots.push(at);
    });
    const order = slots.map((at) => layers[at]);
    let result;
    if (!byPlace) {
      // In a mask group, the mask splits its layers into the ones below it and the ones it
      // covers above it. Each part is reordered on its own, so ] [ ⇧⌘] ⇧⌘[ keep every layer
      // on its side of the mask. Moving the mask itself is refused (checkMaskPairs).
      const mask = maskOfGroup(byId.get(groupId), layers);
      const split = mask && !chosen.has(mask.id) ? order.indexOf(mask) : -1;
      const parts = split >= 0 ? [order.slice(0, split), [mask], order.slice(split + 1)] : [order];
      result = parts.flatMap((part) => moveWithin(part, chosen, to));
    } else {
      if (!Number.isInteger(to) || to < 0 || to >= order.length) {
        throw new Error(`Can't ${action}: the place must be a whole number from 0 (bottom) to ${order.length - 1} (top) for ${label(roots[0])}.`);
      }
      result = order.filter((layer) => !chosen.has(layer.id));
      result.splice(to, 0, roots[0]);
    }
    slots.forEach((at, position) => {
      next[at] = result[position];
    });
  }
  if (sameOrder(layers, next)) return null;
  checkMaskPairs(layers, next, action, chosen);
  return next;
}

/**
 * Shows or hides and locks or unlocks layers: `flags` is { visible?, locked? } with true or
 * false. A locked group locks the layers inside it on the canvas, and a hidden group hides
 * them, without changing their own flags. Refuses hiding or showing that would leave a shown
 * mask with no visible layer above it to mask: the scene could not be drawn then.
 * Returns the new layers, or null when every layer already has those flags.
 */
export function setLayerFlags(layers, layerIds, flags) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const change = {};
  for (const key of ["visible", "locked"]) {
    if (flags?.[key] === undefined) continue;
    if (typeof flags[key] !== "boolean") throw new Error(`${key} must be true or false.`);
    change[key] = flags[key];
  }
  if (!Object.keys(change).length) throw new Error("Choose visible, locked, or both.");
  const verb = change.visible === undefined ? (change.locked ? "lock" : "unlock") : change.visible ? "show" : "hide";
  checkIds(layerIds, byId, `${verb} layers`, (id) => new Error(`Layer ${String(id)} was not found.`));
  const chosen = new Set(layerIds);
  let changed = false;
  const next = layers.map((layer) => {
    if (!chosen.has(layer.id) || Object.entries(change).every(([key, value]) => layer[key] === value)) return layer;
    changed = true;
    return { ...layer, ...change };
  });
  if (!changed) return null;
  if (change.visible !== undefined) {
    const before = maskTargets(layers);
    for (const [maskId, maskedId] of maskTargets(next)) {
      if (maskedId !== null || before.get(maskId) === null) continue;
      const mask = byId.get(maskId);
      throw new Error(
        `Can't ${verb} layers: the mask ${label(mask)} would have no visible layer above it to mask. ` +
          (chosen.has(maskId) ? "Show the layer above it first." : "Hide the mask too."),
      );
    }
  }
  return next;
}
