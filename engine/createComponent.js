import { groupLayers } from "./grouping.js";
import { createComponentInstance } from "./linkedComponents.js";
import { createScene, parseDocument, uid } from "./model.js";
import { effectiveMediaDuration } from "./playback.js";
import { remapComponentOverrides, resolveComponentPath } from "./componentOverrides.js";

// A scene stores its layers in a flat list, even when a child precedes its parent.
// Collect the temporary group's whole tree before separating it from the source scene.
function contentsOf(layers, groupId) {
  const children = new Map();
  for (const layer of layers) {
    if (!children.has(layer.parentId)) children.set(layer.parentId, []);
    children.get(layer.parentId).push(layer.id);
  }
  const included = new Set([groupId]);
  const queue = [groupId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const id of children.get(queue[index]) ?? []) {
      if (included.has(id)) continue;
      included.add(id);
      queue.push(id);
    }
  }
  included.delete(groupId);
  return included;
}

// Existing instances of an edited main component still refer to the same layers. Their paths
// acquire the new instance ID; position overrides on the moved roots use the new local origin.
// Reparenting across different parents could also change an overridden ancestor's effects, so
// refuse that combination rather than silently dropping or changing another instance's edits.
function instanceOverridesAfterGrouping(document, scene, grouped, group, included) {
  const result = new Map();
  if (!scene.isComponent) return result;
  const scenes = new Map(document.scenes.map((item) => [item.id, item]));
  const original = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const roots = new Map(grouped.layers.filter((layer) => layer.parentId === group.id).map((layer) => [layer.id, layer]));
  const differentParents = [...roots.keys()].some((id) => original.get(id).parentId !== group.parentId);
  const paths = new Map(document.scenes.map((item) => [item.id, new Map()]));
  paths.set(scene.id, new Map([...included].map((id) => [id, `${group.id}/${id}`])));
  for (const source of document.scenes) {
    for (const instance of source.layers) {
      if (instance.type !== "component" || !instance.componentOverrides) continue;
      const overrides = remapComponentOverrides(instance.componentOverrides, instance.componentSceneId, scenes, paths);
      for (const [path, entry] of Object.entries(instance.componentOverrides)) {
        const resolved = resolveComponentPath(instance, scenes, path);
        if (differentParents && (instance.componentSceneId === scene.id || resolved?.chain.some((layer) => layer.componentSceneId === scene.id)))
          throw new Error("this main component has instance overrides; extracting layers from different parents could change them. Select layers that share a parent, or detach the affected instances first.");
        const root = roots.get(resolved?.layer.id);
        if (!root) continue;
        const mapped = remapComponentOverrides({ [path]: entry }, instance.componentSceneId, scenes, paths);
        const next = overrides[Object.keys(mapped)[0]];
        for (const key of ["x", "y"]) {
          if (Object.hasOwn(entry, key)) next[key] = entry[key] + root[key] - original.get(root.id)[key];
        }
      }
      result.set(instance.id, overrides);
    }
  }
  return result;
}

/**
 * Moves a selection into a new main component and replaces it with a linked instance.
 * grouping.js supplies the bounds, coordinate changes, stacking order and appearance checks.
 * Nothing in `document` is changed: callers compute this result before adding an undo step.
 */
export function createComponentFromLayers(document, sceneId, layerIds, { name, componentSceneId = uid(), instanceId = uid(), fonts } = {}) {
  try {
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 256))
      throw new Error("name must be text of 1 to 256 characters.");
    if (Array.isArray(layerIds) && (layerIds.length > 5000 || layerIds.some((id) => typeof id !== "string")))
      throw new Error("select 1 to 5000 layer IDs.");
    const grouped = groupLayers(document, sceneId, layerIds, { id: instanceId, fonts });
    const scene = document.scenes.find((item) => item.id === sceneId);
    const group = grouped.layers.find((layer) => layer.id === grouped.groupId);
    const selected = [...new Set(layerIds)];
    const componentName = name ?? (selected.length === 1
      ? scene.layers.find((layer) => layer.id === selected[0]).name
      : `Component ${document.scenes.filter((item) => item.isComponent).length + 1}`);
    const included = contentsOf(grouped.layers, group.id);
    const overrides = instanceOverridesAfterGrouping(document, scene, grouped, group, included);
    const layers = grouped.layers.filter((layer) => included.has(layer.id)).map((layer) => {
      const moved = { ...layer, parentId: layer.parentId === group.id ? null : layer.parentId };
      // An unknown media end otherwise contributes no Play length and the instance could
      // hold the source at time zero (playback.js). Keep it playing through this scene's end.
      if ((moved.type === "video" || moved.type === "audio") && effectiveMediaDuration(moved) === Infinity)
        moved.mediaDuration = Math.max(1 / 60, scene.duration - (moved.mediaStart ?? 0));
      return moved;
    });
    const component = createScene({
      id: componentSceneId, name: componentName, isComponent: true,
      width: Math.max(1, Math.ceil(group.width)), height: Math.max(1, Math.ceil(group.height)),
      duration: scene.duration, componentPlayback: "scene",
      background: "#ffffff", backgroundEnabled: false, layers,
    });
    const instance = createComponentInstance(component, {
      id: instanceId, name: componentName, x: group.x, y: group.y, parentId: group.parentId,
      clipContent: false, componentStart: 0, componentVisibility: "both",
    });
    const remaining = grouped.layers.filter((layer) => !included.has(layer.id)).map((layer) => layer.id === group.id ? instance : layer);
    const scenes = document.scenes.flatMap((item) => item.id === sceneId ? [{ ...item, layers: remaining }, component] : [item]).map((item) => ({
      ...item, layers: item.layers.map((layer) => overrides.has(layer.id) ? { ...layer, componentOverrides: overrides.get(layer.id) } : layer),
    }));
    // The complete document must still fit the scene, layer, ID and component nesting limits.
    return { document: parseDocument({ ...document, scenes }), componentSceneId, instanceId };
  } catch (error) {
    throw new Error(`Can't create component: ${error.message.replace(/^Can't group:\s*/, "")}`);
  }
}
