import { createScene, parseDocument, uid } from "./model.js";
import { createComponentInstance } from "./linkedComponents.js";
import { nextScenePosition } from "./sceneLayout.js";
import { freshAnimationIds } from "./animationTree.js";

/** Prepare an independent scene copy, preserving the existing linked-copy behavior for a main component. */
export function duplicateSceneInDocument(document, sceneId) {
  const source = document.scenes.find((scene) => scene.id === sceneId);
  if (!source) throw new Error(`Scene ${sceneId} was not found.`);
  const scene = createScene({
    name: `Scene ${document.scenes.length + 1}`, width: source.width, height: source.height,
    duration: source.duration, background: source.background, backgroundEnabled: source.backgroundEnabled,
    aspectLocked: source.aspectLocked ?? false, ...nextScenePosition(document.scenes),
    ...(source.componentPlayback === undefined ? {} : { componentPlayback: source.componentPlayback }),
    backgroundAnimations: (source.backgroundAnimations ?? []).map((animation) => freshAnimationIds(animation, uid)),
  });
  // The copy owns its background paint and animations; its linked content must not paint it again.
  if (source.isComponent) scene.layers = [createComponentInstance(source, { x: 0, y: 0, componentBackgroundEnabled: false })];
  else {
    const ids = new Map(source.layers.map((layer) => [layer.id, uid()]));
    scene.layers = source.layers.map((layer) => ({
      ...structuredClone(layer), id: ids.get(layer.id), parentId: ids.get(layer.parentId) || null,
      animations: (layer.animations ?? []).map((animation) => freshAnimationIds(animation, uid)),
    }));
  }
  return { document: parseDocument({ ...document, scenes: [...document.scenes, scene] }), sceneId: scene.id };
}
