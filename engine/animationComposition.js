import { parseDocument, uid } from "./model.js";
import { animationOwner, animationOwners, backgroundAnimationProblem, setAnimationList } from "./sceneBackground.js";
import { animationPlaybackLength } from "./playback.js";
import { animationTreeEntries, editAnimationTree, flattenAnimations, freshAnimationIds, isComposedAnimation, minimumAnimationScale, scaleAnimationTimes } from "./animationTree.js";
import { presetActions } from "./presetActions.js";
import { unlockedLayerIds } from "./layerTree.js";
import { sceneAnimationProblem } from "./animationListCheck.js";

function context(document, sceneId, ids) {
  const scene = document.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error("The scene was not found.");
  const wanted = new Set(ids);
  const all = animationOwners(scene).flatMap((layer) => animationTreeEntries(layer.animations).map((entry) => ({ ...entry, layer })));
  const available = new Set(all.map(({ animation }) => animation.id));
  if ([...wanted].some((id) => !available.has(id))) throw new Error("An animation in the selection was not found.");
  const entries = animationOwners(scene).flatMap((layer) => animationTreeEntries(layer.animations)
    .filter((entry) => wanted.has(entry.animation.id) && !entry.parents.some((id) => wanted.has(id)))
    .map((entry) => ({ ...entry, layer })));
  if (!entries.length) throw new Error("Select animations in the Timeline first.");
  const unlocked = new Set(unlockedLayerIds(scene.layers, entries.map(({ layer }) => layer.id)));
  if (entries.some(({ layer }) => !layer.id.startsWith("#") && !unlocked.has(layer.id))) throw new Error("Unlock the layers before editing their animations.");
  return { scene, entries };
}

function finish(document, scene, ids) {
  const previous = document.scenes.find((item) => item.id === scene.id);
  const problem = backgroundAnimationProblem(scene, previous) || sceneAnimationProblem(scene, previous?.layers ?? []);
  if (problem) throw new Error(problem);
  return { document: parseDocument({ ...document, scenes: document.scenes.map((item) => item.id === scene.id ? scene : item) }), animationIds: ids };
}

function animationGroupProblem(entries) {
  if (entries.length < 2) return "Select at least two animations to group.";
  if (new Set(entries.map(({ layer }) => layer.id)).size !== 1) return "Animation groups need animations from the same layer.";
  if (new Set(entries.map(({ parents = [] }) => parents.join("/"))).size !== 1) return "Select animations in the same animation group.";
  return null;
}

/** Group sibling operations without baking their values, text units, or easing. */
export function composeAnimations(document, sceneId, ids, { name = "Composed" } = {}) {
  const { scene, entries } = context(document, sceneId, ids);
  const problem = animationGroupProblem(entries);
  if (problem) throw new Error(problem);
  const start = Math.min(...entries.map(({ animation }) => animation.start));
  const group = { id: uid(), name, kind: "composed", start,
    animations: entries.map(({ animation, stored }) => ({ ...structuredClone(stored), start: animation.start - start })) };
  const selected = new Set(entries.map(({ animation }) => animation.id));
  function replace(list, offset = 0) {
    let inserted = false;
    return list.flatMap((item) => {
      if (selected.has(item.id)) {
        if (inserted) return [];
        inserted = true;
        return [{ ...group, start: start - offset }];
      }
      return [isComposedAnimation(item) ? { ...item, animations: replace(item.animations, offset + item.start) } : item];
    });
  }
  const list = replace(entries[0].layer.animations);
  const executionOrder = (animations) => flattenAnimations(animations).map((animation, index) => ({ animation, index }))
    .sort((left, right) => left.animation.start - right.animation.start || left.index - right.index).map(({ animation }) => animation.id).join("/");
  if (executionOrder(list) !== executionOrder(entries[0].layer.animations))
    throw new Error("These simultaneous animations would change order when grouped. Select the intervening animations as well.");
  return finish(document, setAnimationList(scene, entries[0].layer.id, list), [group.id]);
}

export function ungroupAnimations(document, sceneId, ids) {
  const { scene, entries } = context(document, sceneId, ids);
  if (entries.some(({ animation }) => !isComposedAnimation(animation))) throw new Error("Select Composed animation groups to ungroup.");
  const wanted = new Set(entries.map(({ animation }) => animation.id));
  const selected = [];
  function ungroup(list) {
    return list.flatMap((item) => {
      if (wanted.has(item.id)) return item.animations.map((child) => {
        selected.push(child.id);
        return { ...child, start: child.start + item.start, ...(item.enabled === false ? { enabled: false } : {}) };
      });
      return [isComposedAnimation(item) ? { ...item, animations: ungroup(item.animations) } : item];
    });
  }
  let next = scene;
  for (const owner of new Set(entries.map(({ layer }) => layer.id))) next = setAnimationList(next, owner, ungroup(animationOwner(next, owner).animations));
  return finish(document, next, selected);
}

export function duplicateAnimations(document, sceneId, ids) {
  const { scene, entries } = context(document, sceneId, ids);
  const wanted = new Set(entries.map(({ animation }) => animation.id));
  const selected = [];
  function duplicate(list) {
    return list.flatMap((item) => {
      if (wanted.has(item.id)) {
        const copy = freshAnimationIds(item, uid);
        selected.push(copy.id);
        return [item, copy];
      }
      return [isComposedAnimation(item) ? { ...item, animations: duplicate(item.animations) } : item];
    });
  }
  let next = scene;
  for (const owner of new Set(entries.map(({ layer }) => layer.id))) next = setAnimationList(next, owner, duplicate(animationOwner(next, owner).animations));
  return finish(document, next, selected);
}

export function resizeComposedAnimation(layer, animation, duration, fonts) {
  const length = animationPlaybackLength(layer, animation, fonts);
  if (!(duration > 0) || !(length > 0) || !Number.isFinite(duration)) throw new Error("A group duration must be a positive number.");
  const factor = duration / length;
  if (factor + 1e-10 < minimumAnimationScale(animation)) throw new Error("Group members cannot be shorter than 1 millisecond.");
  return scaleAnimationTimes(animation, factor, { start: false });
}

export function convertSceneAnimations(document, sceneId, ids) {
  const { scene, entries } = context(document, sceneId, ids);
  let next = scene;
  for (const { layer, animation, stored } of entries) {
    const group = { id: animation.id, name: animation.name, kind: "composed", start: animation.start,
      ...(stored.enabled === false ? { enabled: false } : {}), animations: presetActions(layer, { ...animation, enabled: true }) };
    next = setAnimationList(next, layer.id, editAnimationTree(animationOwner(next, layer.id).animations, animation.id, () => group));
  }
  return finish(document, next, entries.map(({ animation }) => animation.id));
}
