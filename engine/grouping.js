// Group and ungroup layers without changing how anything looks.
//
// The layers of a scene are one flat list. A layer's `parentId` names the group it is in, and
// among layers with the same parent, the one later in the list is drawn on top. A group's
// children use the group's box as their coordinate space: x = 0, y = 0 is its top-left corner.
//
// Grouping, step by step (`groupLayers`):
// 1. Drop selected layers whose group is also selected; they move with that group.
// 2. Find the selected layer drawn on top. The new group goes into that layer's parent and
//    takes its place in the stacking order. The others follow it, keeping their order.
// 3. Refuse when leaving or entering a group would change how a layer looks: that group is
//    animated, hidden, see-through, filled, stroked, blurred, shadowed, blended, clipping,
//    masking or masked.
// 4. The new group's box is the box around the selected layers, after their rotations.
//    Auto-sized text counts with the size it is drawn at, not its saved size.
// 5. Each layer gets new x/y/rotation/scale values (and animated values) so it stays in the
//    same place on the canvas at every time. See reparent.js.
// 6. Refuse when a mask would end up masking a different layer, a mask group would get a
//    different mask, or a layer would move from one side of a mask group's mask to the other.
//
// Ungrouping does the reverse (`ungroupLayers`): the group's own move, rotation and scale are
// baked into each child, the children take the group's place in the stacking order, and the
// group's hidden state and play ranges are copied to them. Groups with their own animations or
// visible box paint and appearance effects can't be ungrouped, because those can't be copied
// onto the children without changing the result. Ungrouping a mask group (see masking.js)
// removes its mask: the mask layer becomes an ordinary layer again.
import { IDENTITY, inverse, layerMatrix, multiply, parentMatrix, point, worldMatrix } from "./geometry.js";
import { expandComponents } from "./linkedComponents.js";
import { roundedBoxContainsLocalPoint, visibleBoxStyleEffect } from "./boxHitTest.js";
import { effectiveBoxStyle } from "./boxStyles.js";
import { createLayer, uid } from "./model.js";
import { reparentLayer, withDrawnBox } from "./reparent.js";
import { geometryOf } from "./arrange.js";

const MAX_COORDINATE = 1_000_000;
const MAX_DIMENSION = 65_536;
const MAX_PLAYBACK_WINDOWS = 32;

const label = (layer) => `“${layer.name || layer.id}”`;

function findScene(document, sceneId) {
  const scene = document?.scenes?.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} was not found.`);
  return scene;
}

// Explains why an ID that is not in the scene's own list can't be used. Layers inside a
// component instance are drawn from the main component and are not stored in this scene.
function missingLayer(document, scene, layerId, action) {
  let drawn = null;
  try {
    drawn = expandComponents(document, scene.id, { camera: false }).layers.find((layer) => layer.id === layerId);
  } catch {
    // A component that can't be drawn can't contain the layer either.
  }
  if (drawn?.componentOwnerId) {
    const owner = scene.layers.find((layer) => layer.id === drawn.componentOwnerId);
    return new Error(
      `Can't ${action}: ${label(drawn)} is part of the component instance ${label(owner ?? { id: drawn.componentOwnerId })}. Edit the main component, or detach the instance first.`,
    );
  }
  return new Error(`Layer ${String(layerId)} was not found.`);
}

// Moves a layer into a new parent group space (reparent.js). Auto-sized text is first saved
// with the box it is drawn in (reparent.js withDrawnBox), so turning or scaling it keeps the
// text where it is. Text that animates its size keeps its saved box: reparentLayer moves such
// a layer only when its group just moves it, which keeps it in place whatever its box.
export function moveLayer(layer, matrix, scenes, fonts) {
  const source = withDrawnBox(layer, fonts) ?? layer;
  return { ...source, ...reparentLayer(source, matrix, geometryOf(source, scenes, fonts)) };
}

// Runs `measure`, which may measure text. Text can't be measured without its font, so the
// error then says which action failed.
function measured(measure, action) {
  try {
    return measure();
  } catch (error) {
    throw new Error(`${action}: ${error.message}`);
  }
}

/** The groups around a layer, nearest first. */
export function ancestorsOf(layer, byId) {
  const ancestors = [],
    visited = new Set([layer.id]);
  let parent = byId.get(layer.parentId);
  while (parent && !visited.has(parent.id)) {
    ancestors.push(parent);
    visited.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return ancestors;
}

// Each layer's children in list order. Layers without a (known) parent are under `null`.
function childrenByParent(layers) {
  const byId = new Set(layers.map((layer) => layer.id));
  const children = new Map([[null, []]]);
  for (const layer of layers) {
    const parentId = byId.has(layer.parentId) ? layer.parentId : null;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(layer);
  }
  return children;
}

/** Each layer's place in drawing order: 0 is drawn first (at the bottom). */
export function paintOrder(layers) {
  const children = childrenByParent(layers);
  const order = new Map();
  const visit = (layer) => {
    if (order.has(layer.id)) return;
    order.set(layer.id, order.size);
    for (const child of children.get(layer.id) ?? []) visit(child);
  };
  for (const layer of children.get(null)) visit(layer);
  return order;
}

/**
 * The mask of a mask group: the group's bottom-most child marked as a mask, or null. While it
 * is visible it masks every visible layer above it in the group (render.js draws it that way).
 */
export function maskOfGroup(group, layers) {
  if (group?.type !== "group" || !group.isMaskGroup) return null;
  return layers.find((layer) => layer.parentId === group.id && layer.isMask) ?? null;
}

/** Each mask group's mask: a Map of mask group ID to mask layer ID (or null when it has none). */
export function groupMasks(layers) {
  return new Map(layers.filter((layer) => layer.type === "group" && layer.isMaskGroup).map((group) => [group.id, maskOfGroup(group, layers)?.id ?? null]));
}

/**
 * Which layer each mask masks: a mask covers the next visible layer in its group, as the
 * renderer draws it. Returns a Map of mask ID to masked layer ID (or null when it has none).
 * The mask of a mask group covers all the layers above it instead, so it is not listed; masks
 * above it pair up with the next visible layer as usual.
 */
export function maskTargets(layers) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const shown = (layer) => layer.visible !== false && ancestorsOf(layer, byId).every((item) => item.visible !== false);
  const targets = new Map();
  for (const [parentId, all] of childrenByParent(layers)) {
    const parent = byId.get(parentId);
    const groupMask = parent?.type === "group" && parent.isMaskGroup ? all.find((layer) => layer.isMask) : null;
    const siblings = groupMask && shown(groupMask) ? all.slice(all.indexOf(groupMask) + 1) : all;
    const visible = siblings.filter(shown);
    for (let index = 0; index < visible.length; index += 1) {
      if (!visible[index].isMask) continue;
      const target = visible[index + 1];
      targets.set(visible[index].id, target && !target.isMask ? target.id : null);
      if (target && !target.isMask) index += 1;
    }
  }
  return targets;
}

/**
 * The layers each mask group's mask covers: a Map of mask group ID to a Set of layer IDs. The
 * mask covers the group's children above it and every layer inside those children, also when
 * they sit inside nested groups. Layers below the mask are drawn without it. Whether the mask
 * is hidden does not matter here, because showing it again would cover these layers.
 */
export function maskGroupCoverage(layers) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const coverage = new Map();
  for (const [parentId, children] of childrenByParent(layers)) {
    const mask = maskOfGroup(byId.get(parentId), layers);
    if (!mask) continue;
    const above = new Set(children.slice(children.indexOf(mask) + 1).map((layer) => layer.id));
    const covered = layers.filter((layer) => above.has(layer.id) || ancestorsOf(layer, byId).some((item) => above.has(item.id)));
    coverage.set(parentId, new Set(covered.map((layer) => layer.id)));
  }
  return coverage;
}

// Refuses a change that would move a layer from one side of a mask group's mask to the other,
// so that the mask would start or stop covering it. Run checkGroupMasks first: a mask group
// whose mask changes, or that is gone, is left to it. Layers are checked parents first, so the
// error names the selected layer rather than a layer inside it.
function checkMaskSides(before, after, layers, nextLayers, action) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const kept = new Set(nextLayers.map((layer) => layer.id));
  const order = paintOrder(layers);
  const inOrder = layers.filter((layer) => kept.has(layer.id)).sort((left, right) => order.get(left.id) - order.get(right.id));
  for (const [groupId, coveredBefore] of before) {
    const coveredAfter = after.get(groupId);
    if (!coveredAfter) continue;
    const moved = inOrder.find((layer) => coveredBefore.has(layer.id) !== coveredAfter.has(layer.id));
    if (!moved) continue;
    const group = label(byId.get(groupId));
    throw new Error(
      coveredBefore.has(moved.id)
        ? `Can't ${action}: ${label(moved)} is above the mask of ${group}, and this would move it below the mask, where the mask would stop covering it. Select layers on one side of the mask.`
        : `Can't ${action}: ${label(moved)} is below the mask of ${group}, and this would move it above the mask, where the mask would cover it too. Select layers on one side of the mask.`,
    );
  }
}

/**
 * Refuses a change when a mask would start or stop masking a layer. `before` and `after` are
 * maskTargets results; `hint` tells the user what to do instead.
 */
export function checkMasks(before, after, layers, action, hint) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(id) === after.get(id)) continue;
    const mask = label(byId.get(id) ?? { id });
    const target = before.get(id) ?? after.get(id);
    const masked = label(byId.get(target) ?? { id: target });
    throw new Error(
      before.get(id)
        ? `Can't ${action}: the mask ${mask} would stop masking ${masked}. ${hint}`
        : `Can't ${action}: the mask ${mask} would start masking ${masked}. ${hint}`,
    );
  }
}

// Refuses a change that would give a mask group a different mask (or none). `removed` is the
// ID of a mask group that is being ungrouped on purpose.
export function checkGroupMasks(before, after, layers, action, removed = null) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (const [groupId, maskId] of before) {
    if (groupId === removed || after.get(groupId) === maskId) continue;
    const group = label(byId.get(groupId));
    const next = after.get(groupId);
    throw new Error(
      maskId
        ? `Can't ${action}: the mask group ${group} would ${next ? `use ${label(byId.get(next))} as its mask instead of ${label(byId.get(maskId))}` : `lose its mask ${label(byId.get(maskId))}`}.`
        : `Can't ${action}: the mask group ${group} would start using ${label(byId.get(next))} as its mask.`,
    );
  }
}

// What a group does to the layers inside it beyond moving, rotating and scaling them, in
// words, or null when it does nothing else. `maskedIds` holds the layers that masks cover.
export function groupEffect(group, maskedIds) {
  if (group.animations?.length) return "is animated";
  if (group.visible === false) return "is hidden";
  if (group.opacity !== 1) return "has opacity below 100%";
  if (group.blur) return "has blur";
  if (group.shadow) return "has a shadow";
  if ((group.blendMode ?? "normal") !== "normal") return "has a blend mode";
  if (group.isMask) return "is a mask";
  if (group.isMaskGroup) return "is a mask group";
  if (maskedIds.has(group.id)) return "is masked";
  const boxStyleEffect = visibleBoxStyleEffect(group);
  if (boxStyleEffect) return boxStyleEffect;
  if (group.clipContent) return "clips its content";
  if (group.playbackWindows?.length) return "has a play range";
  return null;
}

function snapEdge(value) {
  const rounded = Math.round(value * 1e6) / 1e6 + 0;
  return Math.abs(rounded - Math.round(rounded)) < 1e-6 ? Math.round(rounded) : rounded;
}

/**
 * Puts the given layers of one scene into a new group without changing how they look.
 * Returns { layers, groupId }: the scene's new layer list and the new group's ID. The document
 * itself is not changed. Throws an Error (starting "Can't group") when that isn't possible.
 * `fonts` (default: the editor's loaded fonts) measures auto-sized text.
 */
export function groupLayers(document, sceneId, layerIds, { name = "Group", id = uid(), fonts } = {}) {
  const scene = findScene(document, sceneId);
  const layers = scene.layers;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  if (!Array.isArray(layerIds) || layerIds.length === 0) throw new Error("Can't group: select at least one layer.");
  for (const layerId of layerIds) if (!byId.has(layerId)) throw missingLayer(document, scene, layerId, "group");
  if (document.scenes.some((item) => item.layers.some((layer) => layer.id === id))) {
    throw new Error(`Can't group: layer ID ${id} is already used.`);
  }

  // 1. A layer whose group is also selected moves with that group.
  const selected = new Set(layerIds);
  const order = paintOrder(layers);
  const roots = layers
    .filter((layer) => selected.has(layer.id) && !ancestorsOf(layer, byId).some((item) => selected.has(item.id)))
    .sort((left, right) => order.get(left.id) - order.get(right.id));

  // 2. The new group goes where the top-most selected layer is.
  const topmost = roots.at(-1);
  const parent = byId.get(topmost.parentId) ?? null;
  const parentId = parent?.id ?? null;

  // 3. Leaving or entering a group must not change how a layer looks.
  const masks = maskTargets(layers);
  const maskedIds = new Set([...masks.values()].filter(Boolean));
  const newChain = parent ? [parent, ...ancestorsOf(parent, byId)] : [];
  for (const root of roots) {
    if ((byId.get(root.parentId)?.id ?? null) === parentId) continue;
    const oldChain = ancestorsOf(root, byId);
    const shared = oldChain.find((item) => newChain.includes(item));
    const leaving = shared ? oldChain.slice(0, oldChain.indexOf(shared)) : oldChain;
    const entering = shared ? newChain.slice(0, newChain.indexOf(shared)) : newChain;
    for (const [groups, verb] of [[leaving, "leave"], [entering, "move into"]]) {
      for (const group of groups) {
        const effect = groupEffect(group, maskedIds);
        if (effect) {
          throw new Error(
            `Can't group: ${label(root)} would ${verb} ${label(group)}, which ${effect}, and that would change how it looks. Select layers that share that group instead.`,
          );
        }
      }
    }
  }

  // Inside a mask group, the mask must stay its bottom-most mask. (Step 6 makes sure no layer
  // moves from one side of the mask to the other.)
  const parentMask = maskOfGroup(parent, layers);
  if (parentMask && roots.includes(parentMask)) {
    throw new Error(
      `Can't group: ${label(parentMask)} is the mask of the mask group ${label(parent)} and must stay its bottom layer. Group the mask group instead.`,
    );
  }

  // 4. The box around the selected layers, measured in the new group's parent.
  const parentWorld = parent ? worldMatrix(parent, layers) : IDENTITY;
  const fromParentWorld = inverse(parentWorld);
  if (!fromParentWorld) throw new Error(`Can't group: ${label(parent)} is scaled to zero.`);
  const toParent = new Map(
    roots.map((root) => [
      root.id,
      (byId.get(root.parentId)?.id ?? null) === parentId ? IDENTITY : multiply(fromParentWorld, parentMatrix(root, layers)),
    ]),
  );
  const corners = roots
    .filter((root) => root.type !== "audio")
    .flatMap((root) => {
      const box = measured(() => geometryOf(root, document.scenes, fonts), "Can't group");
      const matrix = multiply(toParent.get(root.id), layerMatrix(box));
      return [[0, 0], [box.width, 0], [0, box.height], [box.width, box.height]].map(([x, y]) => point(matrix, x, y));
    });
  if (!corners.length) throw new Error("Can't group: audio layers have no place on the canvas to group.");
  const left = snapEdge(Math.min(...corners.map((item) => item.x))),
    top = snapEdge(Math.min(...corners.map((item) => item.y)));
  const width = Math.max(0.001, snapEdge(Math.max(...corners.map((item) => item.x)) - left)),
    height = Math.max(0.001, snapEdge(Math.max(...corners.map((item) => item.y)) - top));
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error("Can't group: the selection is larger than the 65,536-pixel limit for a group.");
  }
  if (Math.abs(left) > MAX_COORDINATE || Math.abs(top) > MAX_COORDINATE) {
    throw new Error("Can't group: the selection is outside the supported position range.");
  }
  const group = createLayer("group", { id, name, parentId, x: left, y: top, width, height });

  // 5. Same place on the canvas, now measured from the group's top-left corner.
  const intoGroup = [1, 0, 0, 1, -left, -top];
  const moved = new Map(
    roots.map((root) => {
      try {
        return [root.id, { ...moveLayer(root, multiply(intoGroup, toParent.get(root.id)), document.scenes, fonts), parentId: group.id }];
      } catch (error) {
        throw new Error(`Can't group: ${error.message}`);
      }
    }),
  );
  const next = [];
  for (const layer of layers) {
    if (layer.id === topmost.id) next.push(group, ...roots.map((root) => moved.get(root.id)));
    else if (!moved.has(layer.id)) next.push(layer);
  }

  // 6. Masks keep masking the same layers, mask groups keep their masks, and every layer stays
  //    on its side of a mask group's mask, also when it leaves or enters a nested group.
  checkMasks(masks, maskTargets(next), layers, "group", "Select the mask and the layer it masks together.");
  checkGroupMasks(groupMasks(layers), groupMasks(next), layers, "group");
  checkMaskSides(maskGroupCoverage(layers), maskGroupCoverage(next), layers, next, "group");
  return { layers: next, groupId: group.id };
}

// Copies a group's play ranges onto a child, outermost first, as linkedComponents.js
// combines them when it draws the scene.
function withGroupWindows(group, child) {
  const windows = (group.playbackWindows ?? []).map((window) => ({ ...window }));
  for (const window of child.playbackWindows ?? []) {
    const same = windows.find((item) => item.start === window.start && item.end === window.end && item.visibility === window.visibility);
    if (same) same.hold ||= window.hold;
    else windows.push({ ...window });
  }
  if (windows.length > MAX_PLAYBACK_WINDOWS) {
    throw new Error(`Can't ungroup ${label(group)}: ${label(child)} would have more than ${MAX_PLAYBACK_WINDOWS} play ranges.`);
  }
  return windows;
}

// True when every layer inside a clipping group stays inside the group's box, so turning the
// clip off changes nothing. Animated layers could move outside, so they count as outside.
function clipChangesNothing(group, layers, scenes, fonts) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const inside = layers.filter((layer) => ancestorsOf(layer, byId).includes(group));
  const groupSpace = inverse(worldMatrix(group, layers));
  if (!groupSpace) return false;
  return inside.every((layer) => {
    if (layer.animations?.length || layer.shadow || layer.blur) return false;
    if (layer.type === "audio" || (layer.type === "group" && !visibleBoxStyleEffect(layer))) return true;
    const style = effectiveBoxStyle(layer);
    const box = geometryOf(style, scenes, fonts);
    const margin = style.strokeWidth > 0 ? style.strokeWidth * (style.strokeAlign === "center" ? 0.5 : style.strokeAlign === "outside" ? 1 : 0) : 0;
    const matrix = multiply(groupSpace, worldMatrix(box, layers));
    const ends = [[-margin, -margin], [box.width + margin, -margin], [-margin, box.height + margin], [box.width + margin, box.height + margin]];
    return ends.every(([x, y]) => {
      const local = point(matrix, x, y);
      return roundedBoxContainsLocalPoint(group, local);
    });
  });
}

function ungroupOne(document, layers, group, fonts) {
  const name = label(group);
  const boxStyleEffect = visibleBoxStyleEffect(group);
  if (group.animations?.length || group.shadow || group.blur || group.opacity !== 1 || (group.blendMode ?? "normal") !== "normal" || group.isMask || boxStyleEffect) {
    // A mask group's mask can still be removed without ungrouping it (masking.js removeMasks).
    const maskHint = group.isMaskGroup ? " To remove only its mask and keep the group, use Remove mask (⌃⌘M)." : "";
    throw new Error(
      `Can't ungroup ${name}: remove the group's animations and appearance effects (opacity, blur, shadow, blend mode, mask, fill or stroke) first.${maskHint}`,
    );
  }
  if (group.clipContent && !measured(() => clipChangesNothing(group, layers, document.scenes, fonts), `Can't ungroup ${name}`)) {
    throw new Error(
      `Can't ungroup ${name}: it clips layers that reach past its edges or move. Hold Control while dragging a corner to make the group bigger than its layers, then ungroup.`,
    );
  }
  const into = layerMatrix(group);
  const parentId = group.parentId ?? null;
  // Ungrouping a mask group removes its mask: the mask is drawn as an ordinary layer again.
  const removedMask = maskOfGroup(group, layers);
  const moved = new Map();
  for (const child of layers.filter((layer) => layer.parentId === group.id)) {
    let props;
    try {
      props = moveLayer(child, into, document.scenes, fonts);
    } catch (error) {
      throw new Error(`Can't ungroup ${name}: ${error.message}`);
    }
    moved.set(child.id, {
      ...props,
      parentId,
      visible: group.visible === false ? false : child.visible,
      playbackWindows: withGroupWindows(group, child),
      ...(child === removedMask ? { isMask: false } : {}),
    });
  }
  const next = [];
  for (const layer of layers) {
    if (layer.id === group.id) next.push(...moved.values());
    else if (!moved.has(layer.id)) next.push(layer);
  }
  const masks = maskTargets(layers);
  for (const [maskId, target] of masks) {
    if (target === group.id) {
      throw new Error(
        `Can't ungroup ${name}: the mask ${label(layers.find((layer) => layer.id === maskId))} masks the whole group. Remove the mask or keep the group.`,
      );
    }
  }
  checkMasks(masks, maskTargets(next), layers, `ungroup ${name}`, "Give the mask a layer to mask inside the group first.");
  checkGroupMasks(groupMasks(layers), groupMasks(next), layers, `ungroup ${name}`, group.id);
  return { layers: next, childIds: [...moved.keys()] };
}

/**
 * Ungroups the given groups of one scene without changing how their layers look. Returns
 * { layers, childIds }: the scene's new layer list and the IDs of the layers that were inside
 * the groups. The document itself is not changed. Throws an Error when that isn't possible.
 * `fonts` (default: the editor's loaded fonts) measures auto-sized text.
 */
export function ungroupLayers(document, sceneId, groupIds, { fonts } = {}) {
  const scene = findScene(document, sceneId);
  if (!Array.isArray(groupIds) || groupIds.length === 0) throw new Error("Can't ungroup: select a group.");
  let layers = scene.layers;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (const groupId of groupIds) {
    const layer = byId.get(groupId);
    if (!layer) throw missingLayer(document, scene, groupId, "ungroup");
    if (layer.type === "component") throw new Error(`Can't ungroup ${label(layer)}: it is a component instance. Detach it first.`);
    if (layer.type !== "group") throw new Error(`Can't ungroup ${label(layer)}: it is not a group.`);
  }
  // Outer groups first, so a selected group inside another selected group is ungrouped after
  // its new position is known.
  const depth = (id) => ancestorsOf(byId.get(id), byId).length;
  const ordered = [...new Set(groupIds)].sort((left, right) => depth(left) - depth(right));
  const childIds = [];
  for (const groupId of ordered) {
    const result = ungroupOne(document, layers, layers.find((layer) => layer.id === groupId), fonts);
    layers = result.layers;
    childIds.push(...result.childIds);
  }
  const remaining = new Set(layers.map((layer) => layer.id));
  return { layers, childIds: childIds.filter((id) => remaining.has(id)) };
}
