// Picking layers on the dashboard stage (a note's dot snaps to the layer under it) and a
// layer's outline for presence and transforms.
//
// - `layers` is one scene's flat layer list in drawing order (first is drawn first, at the
//   bottom). A layer's `parentId` names the group it sits in.
// - "Group first": a pick inside a group returns the group, unless `deep` is set or a layer
//   inside that group is already selected (the group is then the "selection context").
// - A "quad" is a layer's four corners in scene pixels, after every rotation, scale and skew
//   of the layer and the groups around it.
//
// Everything here is a plain function of its inputs (no React, no DOM), so it can be tested.
import { point, worldMatrix } from "./geometry.js";

const keepValue = (layer) => layer;

function layersById(layers) {
  return new Map(layers.map((layer) => [layer.id, layer]));
}

// The groups around a layer, nearest first. A broken file with a parent loop stops at the loop.
function ancestorsOf(byId, id) {
  const ancestors = [],
    visited = new Set([id]);
  let parent = byId.get(byId.get(id)?.parentId);
  while (parent && !visited.has(parent.id)) {
    ancestors.push(parent);
    visited.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return ancestors;
}

/** The ids of the groups around a layer, nearest first. */
export function ancestorIds(layers, id) {
  return ancestorsOf(layersById(layers), id).map((layer) => layer.id);
}

// Shown and unlocked, with no hidden or locked group around it. `evaluate` gives the layer's
// state at the playhead; it hides a layer outside its Play range in Animate mode.
function selectableOnCanvas(byId, id, evaluate = keepValue) {
  const layer = byId.get(id);
  if (!layer || layer.type === "audio" || layer.componentBackground) return false;
  return [layer, ...ancestorsOf(byId, id)].every(
    (item) => item.visible !== false && !item.locked && evaluate(item)?.visible !== false,
  );
}

// The ids from the outermost group down to the layer itself.
function chainOf(byId, id) {
  return [id, ...ancestorsOf(byId, id).map((layer) => layer.id)].reverse();
}

// The groups the current selection sits in. A click picks layers whose group is one of these.
function selectionContext(byId, selectedIds) {
  const context = new Set();
  for (const id of selectedIds)
    for (const ancestor of ancestorsOf(byId, id)) context.add(ancestor.id);
  return context;
}

/**
 * The layer a click on the canvas selects, or null when nothing selectable is under the pointer.
 * `candidateIds` are the layers under the pointer, topmost first (see `topmostFirst`). A locked
 * or hidden layer lets the click through to the layer under it.
 * - `deep: false` (a plain click): the outermost group around the layer, or, when the selection
 *   is inside a group, the layer at that level.
 * - `deep: true` (⌘/Ctrl + click): the layer itself, however deep it is.
 */
export function pickLayer(layers, candidateIds, selectedIds = [], { deep = false } = {}) {
  const byId = layersById(layers);
  const leaf = candidateIds.find((id) => selectableOnCanvas(byId, id));
  if (!leaf) return null;
  if (deep) return leaf;
  const chain = chainOf(byId, leaf);
  const context = selectionContext(byId, selectedIds);
  for (let index = chain.length - 1; index > 0; index -= 1)
    if (context.has(byId.get(chain[index]).parentId)) return chain[index];
  return chain[0];
}

// The size a layer is drawn with: a component instance is as large as its source scene.
function drawnSize(layer, scenes) {
  if (layer.type !== "component") return layer;
  const source = scenes.find((scene) => scene.id === layer.componentSceneId);
  return source ? { ...layer, width: source.width, height: source.height } : layer;
}

/**
 * A layer's four corners in scene pixels (see "quad" above), in order around the outline.
 * `evaluate` gives a layer's state at the playhead (the Design tab passes values through).
 * `scenes` sizes component instances; this is the same box the selection outline draws.
 */
export function layerQuad(layer, layers, { evaluate = keepValue, scenes = [] } = {}) {
  const shape = drawnSize(layer, scenes);
  const matrix = worldMatrix(shape, layers, evaluate);
  const state = evaluate(shape);
  const width = state.width,
    height = state.height;
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => point(matrix, x, y));
}

// Every layer in the order it is drawn: a group's layers right after the group, each level
// in list order. Index 0 is drawn first (bottom-most).
function drawOrder(layers) {
  const byId = layersById(layers);
  const childrenOf = new Map();
  for (const layer of layers) {
    const key = byId.has(layer.parentId) ? layer.parentId : null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(layer);
  }
  const order = new Map();
  const visit = (layer) => {
    if (order.has(layer.id)) return;
    order.set(layer.id, order.size);
    for (const child of childrenOf.get(layer.id) ?? []) visit(child);
  };
  for (const layer of childrenOf.get(null) ?? []) visit(layer);
  return order;
}

/** The given layer ids without repeats, topmost (drawn last) first. Unknown ids are dropped. */
export function topmostFirst(layers, ids) {
  const order = drawOrder(layers);
  return [...new Set(ids)].filter((id) => order.has(id)).sort((a, b) => order.get(b) - order.get(a));
}
