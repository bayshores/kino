// Replaces stored scene layers with one layer subtree from the layer clipboard.
// The clipboard's root supplies the appearance and structure; each target keeps its
// identity, name, hierarchy slot, center, and animations that still fit the new root.
import { copyAnimations, pasteAnimations, pasteLayers } from "./layerClipboard.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { maskTargets } from "./grouping.js";
import { expandComponents } from "./linkedComponents.js";
import { createScene, parseDocument, uid } from "./model.js";
import { nextScenePosition } from "./sceneLayout.js";
import { resizeTextLayer } from "./textLayout.js";

const label = (layer) => `“${layer?.name || layer?.id || "layer"}”`;

function sceneOf(document, sceneId) {
  const scene = document?.scenes?.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} was not found.`);
  return scene;
}

function descendants(layers, rootId) {
  const included = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const layer of layers) {
      if (included.has(layer.parentId) && !included.has(layer.id)) {
        included.add(layer.id);
        changed = true;
      }
    }
  }
  return included;
}

function ancestors(layer, byId) {
  const result = [];
  const seen = new Set([layer.id]);
  let parent = byId.get(layer.parentId);
  while (parent && !seen.has(parent.id)) {
    result.push(parent);
    seen.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return result;
}

function drawingBox(layer, document, fonts) {
  if (layer.type === "text") return resizeTextLayer(layer, fonts);
  if (layer.type !== "component") return layer;
  const source = document.scenes.find((item) => item.id === layer.componentSceneId);
  return source ? { ...layer, width: source.width, height: source.height } : layer;
}

function clipboardRoot(envelope) {
  if (envelope?.kind !== "layers") throw new Error("The clipboard holds an animation. Copy a layer to use Paste and Replace.");
  if (!Array.isArray(envelope.layers) || !envelope.layers.length)
    throw new Error("The clipboard holds no layers to replace with.");
  const ids = new Set(envelope.layers.map((layer) => layer?.id).filter((id) => typeof id === "string"));
  const roots = envelope.layers.filter((layer) => layer && !ids.has(layer.parentId));
  if (roots.length !== 1)
    throw new Error("Paste and Replace needs a clipboard with exactly one root layer.");
  if (envelope.layers.some((layer) => layer?.isMask || layer?.isMaskGroup))
    throw new Error("Paste and Replace can't safely change layers that include a mask or mask group.");

  const normalized = structuredClone(envelope);
  const root = normalized.layers.find((layer) => layer.id === roots[0].id);
  root.parentId = null;
  // The destination layer supplies hierarchy and placement. Do not let source-scene group IDs
  // accidentally reconnect the clipboard root to a similarly named destination group.
  normalized.roots = [{ id: root.id }];
  normalized.masks = [];
  return { envelope: normalized, id: root.id };
}

function normalizeTargets(document, scene, targetIds) {
  if (!Array.isArray(targetIds) || targetIds.length === 0)
    throw new Error("Select one or more layers to replace.");
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const unique = [...new Set(targetIds)];
  const expanded = new Map();
  let drawn = [];
  try {
    drawn = expandComponents(document, scene.id, { camera: false }).layers;
  } catch {
    // A broken component can't provide inherited layer targets either.
  }
  for (const id of unique) {
    if (byId.has(id)) continue;
    const inherited = drawn.find((layer) => layer.id === id && layer.componentOwnerId);
    if (inherited) {
      throw new Error(`Can't replace ${label(inherited)}: it is part of a component instance. Edit the main component, or detach the instance first.`);
    }
    throw new Error(`Layer ${String(id)} was not found in this scene.`);
  }
  for (const layer of scene.layers) expanded.set(layer.id, ancestors(layer, byId));
  const selected = new Set(unique);
  // A selected group already covers selected descendants, so it is replaced once.
  return unique.filter((id) => !expanded.get(id).some((parent) => selected.has(parent.id)));
}

function checkTargetSafety(scene, targetId) {
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const root = byId.get(targetId);
  const ids = descendants(scene.layers, targetId);
  const members = scene.layers.filter((layer) => ids.has(layer.id));
  const ancestorsOfRoot = ancestors(root, byId);
  const locked = [...ancestorsOfRoot, ...members].find((layer) => layer.locked);
  if (locked) throw new Error(`Can't replace ${label(root)} because ${label(locked)} is locked.`);

  const pairs = maskTargets(scene.layers);
  const paired = new Set([...pairs.keys(), ...pairs.values()].filter(Boolean));
  const maskGroupAncestor = members.some((layer) => ancestors(layer, byId).some((parent) => parent.isMaskGroup));
  if (maskGroupAncestor || members.some((layer) => layer.isMask || layer.isMaskGroup || paired.has(layer.id)))
    throw new Error(`Can't replace ${label(root)} because it participates in a mask or mask group. Change the mask pairing first.`);
  return { root, ids };
}

function animationLabel(animation) {
  return animation?.name?.trim?.() || "Animation";
}

function incompatibility(layer, animation) {
  const values = [animation?.from, animation?.to].filter((value) => value && typeof value === "object").flatMap(Object.keys);
  if (animation?.kind === "change-text" || animation?.kind === "counter" || animation?.textAnchor != null || animation?.textClip != null || animation?.preset?.text)
    return "it requires a text layer";
  const shapeOnly = values.find((key) => ["radius", "cornerRadii"].includes(key) && !["rectangle", "group", "image", "video"].includes(layer.type))
    ?? values.find((key) => ({ donut: "ellipse", sweep: "ellipse", startAngle: "ellipse", spikes: "star", starThickness: "star" })[key] && ({ donut: "ellipse", sweep: "ellipse", startAngle: "ellipse", spikes: "star", starThickness: "star" })[key] !== layer.type)
    ?? values.find((key) => ["stroke", "strokeWidth"].includes(key) && ["audio", "component"].includes(layer.type))
    ?? values.find((key) => ["letterSpacing", "lineHeight"].includes(key) && layer.type !== "text")
    ?? values.find((key) => key === "volume" && layer.type !== "video" && layer.type !== "audio");
  return shapeOnly ? `its ${shapeOnly} property doesn't fit a ${layer.type} layer` : `it isn't compatible with a ${layer.type} layer`;
}

function restoreAnimationIdentity(source, rebased) {
  const result = structuredClone(rebased);
  result.id = source.id;
  result.start = source.start;
  if (source.kind === "composed" && Array.isArray(source.animations) && Array.isArray(result.animations)) {
    const members = new Map(result.animations.map((member) => [member.id, member]));
    result.animations = source.animations.map((member, index) => {
      const candidate = result.animations[index] ?? members.get(member.id);
      return candidate ? restoreAnimationIdentity(member, candidate) : structuredClone(member);
    });
  }
  return result;
}

function scratchId(document) {
  const used = new Set(document.scenes.map((scene) => scene.id));
  let id = uid();
  while (used.has(id)) id = uid();
  return id;
}

function rebuildComponentPositions(document, previousIds, scratchSceneId) {
  const scenes = document.scenes.filter((scene) => scene.id !== scratchSceneId);
  const added = scenes.filter((scene) => !previousIds.has(scene.id) && scene.isComponent);
  const ordered = scenes.filter((scene) => !added.includes(scene));
  for (const scene of added) {
    Object.assign(scene, nextScenePosition(ordered));
    ordered.push(scene);
  }
  document.scenes = scenes;
}


/**
 * Replace each selected stored root with one clipboard layer subtree. The target roots retain
 * their IDs, names, hierarchy positions, and compatible animations. Returns the same public
 * metadata shape as pasteLayers, without mutating the input document or clipboard envelope.
 */
export function pasteReplaceLayers(document, sceneId, targetIds, envelope, { fonts } = {}) {
  const initialScene = sceneOf(document, sceneId);
  const targets = normalizeTargets(document, initialScene, targetIds);
  const copied = clipboardRoot(envelope);
  let nextDocument = document;
  const notes = [];
  const addedComponents = [];
  const media = new Map();
  const textLayers = new Map();

  for (const targetId of targets) {
    const currentScene = sceneOf(nextDocument, sceneId);
    const { root: target, ids: removedIds } = checkTargetSafety(currentScene, targetId);
    const targetIndex = currentScene.layers.findIndex((layer) => layer.id === target.id);
    const insertionIndex = currentScene.layers.slice(0, targetIndex).filter((layer) => !removedIds.has(layer.id)).length;
    const oldBox = drawingBox(target, nextDocument, fonts);
    const oldCenter = { x: oldBox.x + oldBox.width / 2, y: oldBox.y + oldBox.height / 2 };

    const eligible = [];
    for (const animation of target.animations ?? []) {
      if (isAnimationCompatible({ type: envelope.layers.find((layer) => layer.id === copied.id)?.type }, animation)) {
        eligible.push({ animation, envelope: copyAnimations(nextDocument, sceneId, [animation.id]) });
      } else {
        notes.push(`Skipped ${animationLabel(animation)} on ${label(target)}: ${incompatibility({ type: envelope.layers.find((layer) => layer.id === copied.id)?.type }, animation)}.`);
      }
    }

    const previousSceneIds = new Set(nextDocument.scenes.map((scene) => scene.id));
    const tempId = scratchId(nextDocument);
    const withScratch = structuredClone(nextDocument);
    withScratch.scenes.push(createScene({ id: tempId, name: "Clipboard", width: 1, height: 1, backgroundEnabled: false, layers: [] }));
    const pasted = pasteLayers(withScratch, tempId, copied.envelope, { fonts });
    const scratch = sceneOf(pasted.document, tempId);
    const copiedRootId = pasted.rootIds[0];
    const copiedIds = descendants(scratch.layers, copiedRootId);
    const replacementLayers = scratch.layers.filter((layer) => copiedIds.has(layer.id)).map((layer) => structuredClone(layer));
    if (replacementLayers.length === 0) throw new Error("The clipboard's root layer could not be pasted.");

    const working = structuredClone(pasted.document);
    rebuildComponentPositions(working, previousSceneIds, tempId);
    const scene = sceneOf(working, sceneId);
    const remaining = scene.layers.filter((layer) => !removedIds.has(layer.id));
    const replacementRoot = replacementLayers.find((layer) => layer.id === copiedRootId);
    const replacementBox = drawingBox(replacementRoot, working, fonts);
    replacementRoot.id = target.id;
    replacementRoot.name = target.name;
    replacementRoot.parentId = target.parentId;
    replacementRoot.x += oldCenter.x - (replacementBox.x + replacementBox.width / 2);
    replacementRoot.y += oldCenter.y - (replacementBox.y + replacementBox.height / 2);
    replacementRoot.animations = [];
    for (const layer of replacementLayers)
      if (layer.id === copiedRootId) layer.id = target.id;
      else if (layer.parentId === copiedRootId) layer.parentId = target.id;
    scene.layers = [...remaining.slice(0, insertionIndex), ...replacementLayers, ...remaining.slice(insertionIndex)];

    let withAnimations = working;
    for (const { animation, envelope: animationEnvelope } of eligible) {
      try {
        const pastedAnimation = pasteAnimations(withAnimations, sceneId, [target.id], animationEnvelope, animation.start);
        const pastedIds = pastedAnimation.pasted.find((item) => item.layerId === target.id)?.animationIds ?? [];
        if (!pastedIds.length) {
          const skipped = pastedAnimation.skipped.find((item) => item.layerId === target.id);
          notes.push(`Skipped ${animationLabel(animation)} on ${label(target)}: ${skipped?.reason ?? "it is incompatible with the replacement layer"}.`);
          continue;
        }
        const resultScene = sceneOf(pastedAnimation.document, sceneId);
        const resultRoot = resultScene.layers.find((layer) => layer.id === target.id);
        const newId = pastedIds[0];
        const rebased = resultRoot.animations.find((item) => item.id === newId);
        if (!rebased) throw new Error("the animation could not be added to the replacement layer");
        const restored = restoreAnimationIdentity(animation, rebased);
        const update = structuredClone(pastedAnimation.document);
        const updateRoot = sceneOf(update, sceneId).layers.find((layer) => layer.id === target.id);
        updateRoot.animations[updateRoot.animations.length - 1] = restored;
        withAnimations = update;
      } catch (error) {
        notes.push(`Skipped ${animationLabel(animation)} on ${label(target)}: ${error.message}.`);
      }
    }

    const parsed = parseDocument(withAnimations);
    nextDocument = parsed;
    notes.push(...pasted.notes);
    for (const item of pasted.media ?? []) media.set(item.src, item);
    for (const layer of pasted.textLayers ?? []) {
      const summarized = layer.id === copiedRootId ? { ...layer, id: target.id, name: target.name } : layer;
      textLayers.set(`${summarized.id}:${summarized.componentOwnerId ?? ""}`, summarized);
    }
    for (const name of pasted.addedComponents ?? []) if (!addedComponents.includes(name)) addedComponents.push(name);
  }

  // A fresh parse is the atomic commit boundary for replacements across multiple targets.
  return {
    document: parseDocument(nextDocument),
    rootIds: targets,
    notes,
    media: [...media.values()],
    textLayers: [...textLayers.values()],
    addedComponents,
  };
}
