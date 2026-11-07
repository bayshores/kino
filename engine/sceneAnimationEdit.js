import { parseDocument } from "./model.js";
import { animationListOf, animationOwner, backgroundAnimationProblem, setAnimationList } from "./sceneBackground.js";
import { sceneAnimationProblem } from "./animationListCheck.js";
import { patchPresetAnimation } from "./presetCatalog.js";
import { animationTreeEntries, editAnimationTree, isComposedAnimation } from "./animationTree.js";
import { resizeComposedAnimation } from "./animationComposition.js";

// Prepare the complete result before App commits it. A refused edit or a missing target then
// leaves both the document and the undo history untouched, including during timeline drags.
function finish(document, previous, scene) {
  const problem = backgroundAnimationProblem(scene, previous) || sceneAnimationProblem(scene, previous.layers);
  if (problem) throw new Error(problem);
  return parseDocument({ ...document, scenes: document.scenes.map((item) => item.id === scene.id ? scene : item) });
}

export function editSceneAnimations(document, sceneId, changes, { fonts } = {}) {
  const scene = document.scenes.find((item) => item.id === sceneId);
  if (!scene) return null;
  let next = scene;
  for (const { layerId, animationId, patch } of changes) {
    const list = animationListOf(next, layerId);
    if (!animationTreeEntries(list).some(({ animation }) => animation.id === animationId)) continue;
    const owner = animationOwner(next, layerId);
    next = setAnimationList(next, layerId, editAnimationTree(list, animationId, (item) => {
      if (!isComposedAnimation(item)) return patchPresetAnimation(item, patch, owner, { document, fonts });
      const { duration, ...fields } = patch;
      return { ...(duration === undefined ? item : resizeComposedAnimation(owner, item, duration, fonts)), ...fields };
    }));
  }
  return next === scene ? null : finish(document, scene, next);
}
