// The layer list as a flat list of rows, the layer search, and the lock and hide rules that a
// group passes on to the layers inside it.
//
// A scene stores its layers in one flat array. `parentId` names the group a layer sits in, and
// among the layers of one group a later layer is drawn on top. The layer list shows the top
// layer first, so it reads each group's children from the end of the array to the start.
//
// Each row is { id, sceneId, layer, depth, parentId, inherited, expandable, open, match,
// lockedByGroup, hiddenByGroup }:
// - depth: 0 for the scene's top level, 1 inside one group, and so on (the row's indent);
// - inherited: the row is drawn from a component's main scene and can't be edited here;
// - expandable / open: the row has a caret, and whether its children are shown;
// - match: in search results, true for a layer whose name matches (false for its groups);
// - lockedByGroup / hiddenByGroup: a group around the layer is locked / hidden, so the layer
//   is locked / hidden on the canvas whatever its own flag says.

/** Map of layer ID to layer. */
function byIdOf(layers) {
  return new Map(layers.map((layer) => [layer.id, layer]));
}

// The groups around a layer, nearest first. Stops at a missing parent or a loop.
function ancestorsOf(byId, layer) {
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

/**
 * True when the layer or any group around it is locked: locking a group locks every layer inside it. Such a layer can still be selected in the
 * layer list, but clicks, the selection box, dragging, nudging and aligning on the canvas
 * leave it alone.
 */
export function isEffectivelyLocked(layers, id) {
  const byId = byIdOf(layers);
  const layer = byId.get(id);
  return Boolean(layer) && [layer, ...ancestorsOf(byId, layer)].some((item) => item.locked === true);
}

/** True when the layer or any group around it is hidden: the renderer then draws none of it. */
export function isEffectivelyHidden(layers, id) {
  const byId = byIdOf(layers);
  const layer = byId.get(id);
  return Boolean(layer) && [layer, ...ancestorsOf(byId, layer)].some((item) => item.visible === false);
}

/**
 * The given IDs without the layers that are locked, by themselves or by a group around them:
 * the layers a canvas edit (drag, nudge, align) may change. Keeps the order of `ids`.
 */
export function unlockedLayerIds(layers, ids) {
  const byId = byIdOf(layers);
  const locked = (layer) => [layer, ...ancestorsOf(byId, layer)].some((item) => item.locked === true);
  return ids.filter((id) => byId.has(id) && !locked(byId.get(id)));
}
