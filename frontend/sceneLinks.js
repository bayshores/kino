// A selection is local view state, never a document mutation. Forward only the
// file's share capability; a workspace-owner key must never leave its browser.
import { expandComponents } from "../engine/linkedComponents.js";

/** Unknown ids leave the normal initial scene alone. A deleted layer still opens its scene. */
export function selectionFromLink(document, href) {
  let params;
  try { params = new URL(href).searchParams; } catch { return null; }
  if (params.has("project") && params.get("project") !== document?.id) return null;
  const alias = params.get("nodeId");
  const scenes = document?.scenes ?? [];
  const scene = params.has("scene") ? scenes.find((item) => item.id === params.get("scene"))
    : scenes.find((item) => item.id === alias) ?? scenes.find((item) => item.layers.some((layer) => layer.id === alias));
  if (!scene) return null;
  const layerId = params.get("layer") || (alias !== scene.id ? alias : null);
  const selected = scene.layers.find((item) => item.id === layerId);
  const selection = { sceneId: scene.id, layerIds: selected ? [selected.id] : [] };
  if (selected?.type === "component" && params.get("componentPath")) {
    const target = { sceneId: scene.id, instanceId: layerId, componentPath: params.get("componentPath") };
    try {
      const inherited = validInheritedTarget(expandComponents(document, scene.id, { camera: false }).layers, scene.id, target);
      if (inherited) selection.inheritedTarget = inherited;
    } catch { /* A stale path still opens the scene and selects its instance. */ }
  }
  return selection;
}

// An "inherited target" names a layer an instance draws from its main component:
// { sceneId, instanceId, componentPath }, e.g. { "page", "card-1", "badge-1/label" }.
function inheritedLayerOf(drawnLayers, target) {
  if (!target?.componentPath) return null;
  return drawnLayers.find((layer) =>
    layer.componentOwnerId === target.instanceId && layer.componentPath === target.componentPath && !layer.componentBackground) ?? null;
}

/** The target when the open scene `sceneId` still draws its layer, otherwise null. */
function validInheritedTarget(drawnLayers, sceneId, target) {
  if (!target || target.sceneId !== sceneId) return null;
  return inheritedLayerOf(drawnLayers, target) ? target : null;
}
