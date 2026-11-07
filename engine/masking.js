// Create mask and remove mask: the ⌃⌘M command (Ctrl+Alt+M on Windows and Linux).
//
// How masks work: a layer marked `isMask` is not drawn on its own. Its drawing is used as a
// luminance mask: where the mask is white the masked layers show, and where it is black or
// empty they are hidden. Normally a mask covers the next visible layer above it. In a mask
// group (a group with `isMaskGroup`), the group's bottom-most mask covers every visible layer
// above it in that group. render.js and the Lottie exporter draw both cases.
//
// Create mask, step by step (`createMask`):
// 1. Group the selected layers with grouping.js, which keeps every layer in the same place
//    on the canvas at every time. A selected layer whose group is also selected moves with
//    that group, so at least two layers must remain.
// 2. The bottom-most of those layers (the last of the selection in the layer list) becomes the
//    mask.
//    An agent may choose another layer with `maskLayerId`; it then moves to the bottom, and it
//    stays there when the mask is removed later (nothing records where it was).
// 3. Mark the new group as a mask group and the chosen layer as a mask.
// 4. Refuse when another mask would start or stop masking a layer.
//
// Removing the mask (`removeMasks`) ungroups the mask group (grouping.js `ungroupLayers`): the
// mask becomes an ordinary layer again and every layer goes back to the group's place, as it
// was before Create mask. A mask group that can't be ungrouped without changing how its layers
// look, for example because it is animated or faded, stays a group; only its mask is turned off.
import { checkMasks, groupLayers, maskOfGroup, maskTargets, ungroupLayers } from "./grouping.js";

const label = (layer) => `“${layer.name || layer.id}”`;

function findScene(document, sceneId) {
  const scene = document?.scenes?.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} was not found.`);
  return scene;
}

/** True when the layer is a group made by Create mask (or marked as one by an agent). */
export function isMaskGroup(layer) {
  return layer?.type === "group" && layer.isMaskGroup === true;
}

/**
 * Wraps the given layers of one scene in a new mask group without moving them. The
 * bottom-most layer (or `maskLayerId`) becomes the mask of all the others. Returns
 * { layers, groupId, maskId }: the scene's new layer list, the mask group's ID and the mask's
 * ID. The document itself is not changed. Throws an Error (starting "Can't create a mask")
 * when that isn't possible. `fonts` measures auto-sized text, as in grouping.js.
 */
export function createMask(document, sceneId, layerIds, { maskLayerId, name = "Mask group", id, fonts } = {}) {
  const scene = findScene(document, sceneId);
  if (!Array.isArray(layerIds) || new Set(layerIds).size < 2) {
    throw new Error("Can't create a mask: select at least two layers. The bottom one becomes the mask.");
  }
  if (maskLayerId !== undefined && !layerIds.includes(maskLayerId)) {
    throw new Error(`Can't create a mask: the mask ${String(maskLayerId)} must be one of the selected layers.`);
  }

  // 1. Group them. grouping.js explains when and why it refuses.
  let grouped;
  try {
    grouped = groupLayers(document, sceneId, layerIds, { name, id, fonts });
  } catch (error) {
    throw new Error(error.message.replace(/^Can't group:/, "Can't create a mask:"));
  }
  const { groupId } = grouped;
  const children = grouped.layers.filter((layer) => layer.parentId === groupId);
  if (children.length < 2) {
    throw new Error("Can't create a mask: select at least two layers that are not inside each other. The bottom one becomes the mask.");
  }

  // 2. The bottom-most layer that can be drawn is the mask, unless the caller chose one.
  let mask;
  if (maskLayerId !== undefined) {
    mask = children.find((layer) => layer.id === maskLayerId);
    if (!mask) {
      const inside = scene.layers.find((layer) => layer.id === maskLayerId);
      throw new Error(`Can't create a mask: ${label(inside ?? { id: maskLayerId })} is inside another selected layer, so it can't be the mask.`);
    }
  } else {
    mask = children.find((layer) => layer.type !== "audio");
  }
  if (!mask || mask.type === "audio") {
    throw new Error(`Can't create a mask: ${label(mask ?? { id: maskLayerId })} is an audio layer and has no shape to mask with.`);
  }

  // 3. Mark the group and the mask, and put the mask at the bottom of the group.
  const layers = [];
  for (const layer of grouped.layers) {
    if (layer.id === mask.id) continue;
    if (layer.id === groupId) layers.push({ ...layer, isMaskGroup: true }, { ...mask, isMask: true });
    else layers.push(layer);
  }

  // 4. Masks that were already in the selection keep masking the same layers. The chosen
  //    layer is left out: it now masks the whole group instead of one layer.
  const before = maskTargets(scene.layers);
  before.delete(mask.id);
  checkMasks(before, maskTargets(layers), scene.layers, "create a mask", "Choose a different mask layer.");
  return { layers, groupId, maskId: mask.id };
}

// The same document with a new layer list for one scene.
function withSceneLayers(document, sceneId, layers) {
  return { ...document, scenes: document.scenes.map((scene) => (scene.id === sceneId ? { ...scene, layers } : scene)) };
}

// How many groups a layer is inside.
function depthOf(layers, id) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const visited = new Set([id]);
  let depth = 0;
  for (let parent = byId.get(byId.get(id)?.parentId); parent && !visited.has(parent.id); parent = byId.get(parent.parentId)) {
    visited.add(parent.id);
    depth += 1;
  }
  return depth;
}

// Keeps a mask group as an ordinary group and turns its mask into an ordinary layer. Nothing
// moves, and other masks keep their layers: no layer below the mask is a mask (the mask is the
// group's bottom-most one), so the masks above it still pair with the same layers.
function turnOffMask(layers, groupId) {
  const mask = maskOfGroup(layers.find((layer) => layer.id === groupId), layers);
  return layers.map((layer) => {
    if (layer.id === groupId) return { ...layer, isMaskGroup: false };
    if (layer === mask) return { ...layer, isMask: false };
    return layer;
  });
}

/**
 * Removes the masks of the given mask groups. Each one is ungrouped when grouping.js can do
 * that without changing how its layers look, which puts the layers back as they were. Otherwise
 * (for example the group is animated, faded, blurred or clips its layers) the group stays and
 * only its mask is turned off. Returns { layers, childIds, keptGroupIds, notice }: the scene's
 * new layer list, the layers of the ungrouped groups, the groups that stayed, and a sentence for
 * the user about the groups that stayed ("" when none did). `fonts` measures auto-sized text.
 */
export function removeMasks(document, sceneId, groupIds, { fonts } = {}) {
  const scene = findScene(document, sceneId);
  if (!Array.isArray(groupIds) || groupIds.length === 0) throw new Error("Can't remove a mask: select a mask group.");
  for (const groupId of groupIds) {
    const layer = scene.layers.find((item) => item.id === groupId);
    if (!layer) throw new Error(`Layer ${String(groupId)} was not found.`);
    if (!isMaskGroup(layer)) throw new Error(`Can't remove a mask: ${label(layer)} is not a mask group.`);
  }
  // Outer groups first, as ungroupLayers does, so an inner group is handled in its new place.
  const ordered = [...new Set(groupIds)].sort((left, right) => depthOf(scene.layers, left) - depthOf(scene.layers, right));
  let layers = scene.layers;
  const childIds = [],
    keptGroupIds = [],
    reasons = [];
  for (const groupId of ordered) {
    try {
      const result = ungroupLayers(withSceneLayers(document, sceneId, layers), sceneId, [groupId], { fonts });
      layers = result.layers;
      childIds.push(...result.childIds);
    } catch (error) {
      // The group can't be ungrouped (ungroupLayers says why), so keep it and remove only the mask.
      layers = turnOffMask(layers, groupId);
      keptGroupIds.push(groupId);
      reasons.push(error.message);
    }
  }
  const remaining = new Set(layers.map((layer) => layer.id));
  const names = keptGroupIds.map((id) => label(layers.find((layer) => layer.id === id)));
  const notice = !names.length
    ? ""
    : names.length === 1
      ? `Removed the mask. ${names[0]} stays a group. ${reasons[0]}`
      : `Removed the masks. ${names.join(", ")} stay groups. ${[...new Set(reasons)].join(" ")}`;
  return { layers, childIds: childIds.filter((id) => remaining.has(id)), keptGroupIds, notice };
}
