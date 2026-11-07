import { canvasLayerState } from "./canvasLayerState.js";
import { componentPathProblem } from "../engine/componentOverrides.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { ancestorIds, layerQuad } from "../engine/selection.js";
import { isEffectivelyHidden } from "../engine/layerTree.js";

const MAX_REMOTE_SELECTION = 200;

function finiteQuad(layer, layers, scenes, evaluate) {
  // The Layers list can select locked layers, just as the local outline can.
  // Locking blocks edits and canvas picking; it does not hide a selection.
  if (layer.type === "audio" || layer.componentBackground || isEffectivelyHidden(layers, layer.id)) return null;
  const byId = new Map(layers.map((item) => [item.id, item]));
  if ([layer.id, ...ancestorIds(layers, layer.id)].some((id) => evaluate(byId.get(id))?.visible === false)) return null;
  try {
    const points = layerQuad(layer, layers, { evaluate, scenes });
    if (points.length !== 4 || points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
    return { id: layer.id, points };
  } catch {
    return null;
  }
}

/**
 * Build scene-space outlines for a remote selection using the same geometry and visibility
 * rules as local canvas selection. Inherited selections name one component instance ID in
 * `layerIds` and one source `componentPath`; callers may pass an already expanded scene.
 */
export function remoteSelectionQuads(document, sceneId, selection, { mode = "design", time = 0, resolvedLayers = null } = {}) {
  if (!document || !Array.isArray(document.scenes) || !selection || selection.sceneId !== sceneId ||
      !Array.isArray(selection.layerIds) || selection.layerIds.length === 0 ||
      selection.layerIds.length > MAX_REMOTE_SELECTION || !Number.isFinite(time)) return [];
  const scene = document.scenes.find((item) => item?.id === sceneId);
  if (!scene || !Array.isArray(scene.layers)) return [];
  const evaluate = (layer) => canvasLayerState(layer, { mode, time });

  if (selection.componentPath != null) {
    const instanceId = selection.layerIds.length === 1 ? selection.layerIds[0] : null;
    if (typeof instanceId !== "string" || componentPathProblem(selection.componentPath)) return [];
    if (!scene.layers.some((layer) => layer?.id === instanceId && layer.type === "component")) return [];
    let layers = resolvedLayers;
    if (!Array.isArray(layers)) {
      try { layers = expandComponents(document, sceneId, { camera: false }).layers; }
      catch { return []; }
    }
    const matches = layers.filter((layer) => layer?.componentOwnerId === instanceId &&
      layer.componentPath === selection.componentPath && !layer.componentBackground);
    if (matches.length !== 1) return [];
    const quad = finiteQuad(matches[0], layers, document.scenes, evaluate);
    return quad ? [quad] : [];
  }

  const byId = new Map(scene.layers.map((layer) => [layer?.id, layer]));
  const quads = [];
  const seen = new Set();
  for (const id of selection.layerIds) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const layer = byId.get(id);
    if (!layer) continue;
    const quad = finiteQuad(layer, scene.layers, document.scenes, evaluate);
    if (quad) quads.push(quad);
  }
  return quads;
}
