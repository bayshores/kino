// The box around layers on the dashboard stage, in "world" points: scene pixels measured from
// the center of the scene.
import { evaluateLayer } from "../engine/animation.js";
import { boxAround, sizedBox, unionBox } from "../engine/boxes.js";
import { point, worldMatrix } from "../engine/geometry.js";

/**
 * The world-space box around the selected layers of the active scene, after their own and
 * their parents' rotation and scale. A selected group also covers its visible children.
 * `time` is the playhead (layers are shown animated), or null for the layers as saved.
 * Audio layers have no box. Returns null when nothing selected has one.
 * `cache` (a Map) keeps each layer's animated state, so calls for many boxes at the same `time`
 * and document (the stage's outlines, every frame while playing) work out each layer once.
 */
export function layerBounds(document, scene, layerIds, time = null, { cache = new Map() } = {}) {
  const evaluate = (layer) => {
    if (time === null) return layer;
    let state = cache.get(layer);
    if (!state) { state = evaluateLayer(layer, time); cache.set(layer, state); }
    return state;
  };
  const included = new Set(layerIds);
  let added = true;
  while (added) {
    added = false;
    for (const layer of scene.layers) {
      if (layer.visible && included.has(layer.parentId) && !included.has(layer.id)) {
        included.add(layer.id);
        added = true;
      }
    }
  }
  const boxes = [];
  for (const original of scene.layers) {
    if (!included.has(original.id) || original.type === "audio") continue;
    // A component instance is as large as its source scene.
    const source = original.type === "component" && document.scenes.find((item) => item.id === original.componentSceneId);
    const layer = source ? { ...original, width: source.width, height: source.height } : original;
    const state = evaluate(layer);
    const matrix = worldMatrix(layer, scene.layers, evaluate);
    const corners = [[0, 0], [state.width, 0], [0, state.height], [state.width, state.height]]
      .map(([x, y]) => point(matrix, x, y))
      .map((corner) => ({ x: corner.x - scene.width / 2, y: corner.y - scene.height / 2 }));
    boxes.push(boxAround(corners));
  }
  return sizedBox(unionBox(boxes));
}
