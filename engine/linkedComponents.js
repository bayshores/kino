import { createLayer, uid } from "./model.js";
import { getScenePlaybackDuration } from "./playback.js";
import { applyComponentOverrides, joinComponentPath, mergeOverrides, overridableKeys, overridesUnder } from "./componentOverrides.js";
import { legacyBoxStyles } from "./boxStyles.js";
import { isBackgroundEnabled } from "./sceneBackground.js";
import { animationTreeEntries, isComposedAnimation } from "./animationTree.js";
import { MAX_TIME } from "./schema.js";
import { withDrift } from "./camera.js";
import { animationWindow } from "./blocks/timing.js";

const MAX_COMPONENT_DEPTH = 16;
const MAX_EXPANDED_LAYERS = 10_000;
const MAX_COMPONENT_TIME = MAX_TIME;
const MAX_PARENT_DEPTH = 10_000;

function fail(message) {
  throw new Error(`Component: ${message}`);
}

function clone(value) {
  return structuredClone(value);
}

function assertSourceScene(scene) {
  if (!scene || typeof scene !== "object") fail("source scene was not found.");
  if (scene.isComponent !== true)
    fail(`source scene "${scene.id ?? "(unknown)"}" is not marked as a component.`);
  if (typeof scene.id !== "string" || !scene.id)
    fail("source scene must have an ID.");
  if (!Number.isFinite(scene.width) || scene.width <= 0)
    fail(`source scene "${scene.id}" has an invalid width.`);
  if (!Number.isFinite(scene.height) || scene.height <= 0)
    fail(`source scene "${scene.id}" has an invalid height.`);
}

function componentStart(layer) {
  const start = layer.componentStart ?? 0;
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    start < 0 ||
    start > MAX_COMPONENT_TIME
  ) {
    fail(`instance "${layer.id}" has an invalid componentStart.`);
  }
  return start;
}

function addTime(value, offset, label) {
  const start = value + offset;
  if (!Number.isFinite(start) || start < 0 || start > MAX_COMPONENT_TIME)
    fail(`${label} exceeds the ${MAX_COMPONENT_TIME}-second timeline limit after component offsets are applied.`);
  return start;
}

function collectUsedIds(document) {
  const layerIds = new Set();
  const animationIds = new Set();
  for (const scene of document.scenes ?? []) {
    for (const animation of scene.backgroundAnimations ?? [])
      for (const { stored } of animationTreeEntries([animation]))
        if (typeof stored?.id === "string") animationIds.add(stored.id);
    for (const layer of scene.layers ?? []) {
      if (typeof layer.id === "string") layerIds.add(layer.id);
      for (const animation of layer.animations ?? [])
        for (const { stored } of animationTreeEntries([animation]))
          if (typeof stored?.id === "string") animationIds.add(stored.id);
    }
  }
  return { layerIds, animationIds };
}

function stableHash(value, salt = 0) {
  let first = (0x811c9dc5 ^ salt) >>> 0;
  let second = (0x9e3779b9 + salt) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
    second ^= second >>> 13;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function createDeterministicId(usedIds, key) {
  for (let salt = 0; salt < 1_000; salt += 1) {
    const id = `c-${stableHash(key, salt)}`;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    return id;
  }
  fail("could not allocate a unique materialized ID.");
}

function createFreshId(usedIds) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const id = uid();
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    return id;
  }
  fail("could not allocate a unique detached ID.");
}

function remapAnimations(
  layer,
  animationIds,
  prefix,
  timeOffset,
  freshIds,
  preserveRootId = false,
) {
  function remap(animation, index, root, parentKey = "") {
    const result = clone(animation);
    const key = `${parentKey}\u0000animation\u0000${animation.id ?? index}`;
    result.id = root && preserveRootId
      ? animation.id
      : freshIds
      ? createFreshId(animationIds)
      : createDeterministicId(
          animationIds,
          `${prefix}${key}`,
        );
    if (root) result.start = addTime(
      result.start, timeOffset,
      `animation "${animation.name ?? animation.id ?? index}"`,
    );
    if (isComposedAnimation(animation))
      result.animations = (Array.isArray(animation.animations) ? animation.animations : [])
        .map((child, childIndex) => remap(child, childIndex, false, key));
    return result;
  }
  return (layer.animations ?? []).map((animation, index) => remap(animation, index, true));
}

function effectiveVisibility(layer, byId, inheritedVisible) {
  if (!inheritedVisible) return false;
  let current = layer;
  const visited = new Set();
  while (current) {
    if (visited.has(current.id))
      fail(`layer parent hierarchy contains a cycle at "${current.id}".`);
    if (visited.size >= MAX_PARENT_DEPTH)
      fail(`layer parent hierarchy exceeds ${MAX_PARENT_DEPTH} levels.`);
    visited.add(current.id);
    if (current.visible === false) return false;
    if (current.parentId == null) current = null;
    else {
      const parentId = current.parentId;
      current = byId.get(parentId);
      if (!current)
        fail(`layer hierarchy references missing parent "${parentId}".`);
    }
  }
  return true;
}

function inheritedWindows(layer, byId, parentWindows = [], offset = 0) {
  const ancestry = [];
  const visited = new Set();
  let current = layer;
  while (current) {
    if (visited.has(current.id)) fail("cyclic playback parent hierarchy.");
    visited.add(current.id);
    ancestry.unshift(current);
    current = current.parentId == null ? null : byId.get(current.parentId);
  }
  const windows = clone(parentWindows);
  for (const ancestor of ancestry) {
    for (const original of ancestor.playbackWindows ?? []) {
      const window = { ...original, start: original.start + offset, end: original.end + offset };
      const existing = windows.find((entry) => entry.start === window.start && entry.end === window.end && entry.visibility === window.visibility);
      if (existing) existing.hold ||= window.hold;
      else windows.push(window);
    }
  }
  return windows;
}

function removeComponentMetadata(layer) {
  delete layer.componentOwnerId;
  delete layer.componentSourceSceneId;
  delete layer.componentSceneId;
  delete layer.componentStart;
  delete layer.componentBackgroundEnabled;
  delete layer.componentOverrides;
  delete layer.componentPath;
  delete layer.componentOverridden;
  return layer;
}

function materializeInstance(instance, settings) {
  const {
    scenesById,
    outputLayers,
    usedLayerIds,
    usedAnimationIds,
    freshIds,
    ownerId,
    parentId,
    parentPath,
    outerTimeOffset,
    depth,
    referenceStack,
    inheritedVisible,
    playbackWindows,
    document,
  } = settings;
  // Overrides for this level of nesting, keyed by component path from this instance's main
  // component (componentOverrides.js). `ownOverrides` is the part that the instance placed in
  // the edited scene sets itself (the rest is set by the nested instances on the way), and
  // `componentPathPrefix` is the path of this instance from that top instance ("" at the top).
  const levelOverrides = settings.overrides ?? null;
  const ownOverrides = settings.ownOverrides ?? null;
  const componentPathPrefix = settings.componentPathPrefix ?? "";

  if (depth > MAX_COMPONENT_DEPTH)
    fail(`nested component depth exceeds ${MAX_COMPONENT_DEPTH} at instance "${instance.id}".`);

  const sourceScene = scenesById.get(instance.componentSceneId);
  if (!sourceScene)
    fail(`instance "${instance.id}" references missing source scene "${instance.componentSceneId}".`);
  assertSourceScene(sourceScene);
  if (referenceStack.includes(sourceScene.id)) {
    const cycle = [...referenceStack, sourceScene.id].join(" → ");
    fail(`recursive component cycle detected (${cycle}).`);
  }

  const sourceOffset = componentStart(instance);
  const childOffset = addTime(sourceOffset, outerTimeOffset, `componentStart for instance "${instance.id}"`);
  const playbackDuration = getScenePlaybackDuration(document, sourceScene.id, settings.fonts, levelOverrides);
  const window = {
    start: childOffset,
    end: childOffset + playbackDuration,
    visibility: instance.componentVisibility ?? "both",
    hold: false,
  };
  const wrapperId = settings.wrapperId ?? instance.id;
  const wrapperPath = settings.wrapperPath ?? `${parentPath}/${instance.id}`;
  const wrapper = clone(instance);
  wrapper.id = wrapperId;
  wrapper.parentId = parentId;
  wrapper.type = "group";
  // An instance has no box paint of its own: its separate background layer and children draw
  // the main component. Retain unused instance style data without painting it on this wrapper.
  wrapper.inactiveBoxStyles = legacyBoxStyles("group");
  wrapper.width = sourceScene.width;
  wrapper.height = sourceScene.height;
  wrapper.visible = inheritedVisible && instance.visible !== false;
  wrapper.clipContent = instance.clipContent ?? true;
  wrapper.playbackWindows = [...clone(playbackWindows), window];
  delete wrapper.componentOverrides;
  if (freshIds) removeComponentMetadata(wrapper);
  else {
    wrapper.componentOwnerId = ownerId;
    wrapper.componentSourceSceneId = sourceScene.id;
    // A nested instance says where it sits in the top instance, like the layers it draws.
    if (componentPathPrefix) {
      wrapper.componentPath = componentPathPrefix;
      wrapper.componentOverridden = settings.wrapperOverridden === true;
    }
  }
  wrapper.mediaStart = addTime(
    instance.mediaStart ?? 0,
    outerTimeOffset,
    `media start for component instance "${instance.name ?? instance.id}"`,
  );
  delete wrapper.componentSceneId;
  delete wrapper.componentStart;
  delete wrapper.componentVisibility;
  delete wrapper.componentBackgroundEnabled;
  wrapper.animations = remapAnimations(
    instance,
    usedAnimationIds,
    wrapperPath,
    outerTimeOffset,
    freshIds && settings.preserveRootAnimations !== true,
    settings.preserveRootAnimations === true,
  );
  outputLayers.push(wrapper);
  if (outputLayers.length > MAX_EXPANDED_LAYERS)
    fail(`expanded scene exceeds ${MAX_EXPANDED_LAYERS} layers.`);

  const backgroundId = freshIds
    ? createFreshId(usedLayerIds)
    : createDeterministicId(
        usedLayerIds,
        `${wrapperPath}\u0000background\u0000${sourceScene.id}`,
      );
  const background = createLayer("rectangle", {
    id: backgroundId,
    name: `${sourceScene.name} Background`,
    parentId: wrapperId,
    x: 0,
    y: 0,
    width: sourceScene.width,
    height: sourceScene.height,
    fill: sourceScene.background,
    fillEnabled: isBackgroundEnabled(sourceScene) && instance.componentBackgroundEnabled !== false,
    animations: remapAnimations(
      { animations: sourceScene.backgroundAnimations }, usedAnimationIds,
      `${wrapperPath}\u0000background\u0000${sourceScene.id}`, childOffset, freshIds,
    ),
    strokeWidth: 0,
    visible: wrapper.visible,
    playbackWindows: [...clone(playbackWindows), { ...window, hold: true }],
  });
  if (!freshIds) {
    background.componentOwnerId = ownerId;
    background.componentBackground = true;
  }
  outputLayers.push(background);
  if (outputLayers.length > MAX_EXPANDED_LAYERS)
    fail(`expanded scene exceeds ${MAX_EXPANDED_LAYERS} layers.`);

  // The main component's layers as this instance shows them: its overrides applied, so they are
  // drawn, hidden and timed with the overridden values. The drawn IDs come from the source IDs,
  // so they are the same with and without overrides.
  const originalLayers = sourceScene.layers ?? [];
  const sourceLayers = applyComponentOverrides(originalLayers, levelOverrides);
  const sourceById = new Map(sourceLayers.map((layer) => [layer.id, layer]));
  const overriddenByOwner = (_sourceLayer, index) => {
    if (ownOverrides === null) return false;
    const entry = ownOverrides[originalLayers[index]?.id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const allowed = new Set(overridableKeys(originalLayers[index]));
    return Object.keys(entry).some((key) => allowed.has(key));
  };
  const layerIds = new Map();
  for (const sourceLayer of sourceLayers) {
    const path = `${wrapperPath}/${sourceLayer.id}`;
    const id =
      sourceLayer.type === "component"
        ? freshIds
          ? createFreshId(usedLayerIds)
          : createDeterministicId(usedLayerIds, `${path}\u0000instance`)
        : freshIds
          ? createFreshId(usedLayerIds)
          : createDeterministicId(usedLayerIds, `${path}\u0000layer`);
    layerIds.set(sourceLayer.id, id);
  }
  const childWindows = [...clone(playbackWindows), { ...window, hold: true }];
  const nextReferenceStack = [...referenceStack, sourceScene.id];

  for (const [index, sourceLayer] of sourceLayers.entries()) {
    const path = `${wrapperPath}/${sourceLayer.id}`;
    const componentPath = joinComponentPath(componentPathPrefix, sourceLayer.id);
    const nextParent = sourceLayer.parentId == null ? wrapperId : layerIds.get(sourceLayer.parentId);
    if (sourceLayer.parentId != null && !nextParent)
      fail(`layer "${sourceLayer.id}" references missing parent "${sourceLayer.parentId}".`);
    const visible = effectiveVisibility(
      sourceLayer,
      sourceById,
      wrapper.visible,
    );

    if (sourceLayer.type === "component") {
      const nestedWrapperId = layerIds.get(sourceLayer.id);
      materializeInstance(sourceLayer, {
        ...settings,
        ownerId,
        parentId: nextParent,
        parentPath: wrapperPath,
        outerTimeOffset: childOffset,
        depth: depth + 1,
        referenceStack: nextReferenceStack,
        inheritedVisible: visible,
        playbackWindows: inheritedWindows(sourceLayer, sourceById, childWindows, childOffset),
        wrapperId: nestedWrapperId,
        wrapperPath: path,
        preserveRootAnimations: false,
        // The nested instance's own overrides, with this level's overrides of its layers on top:
        // the outer instance wins property by property.
        overrides: mergeOverrides(sourceLayer.componentOverrides, overridesUnder(levelOverrides, sourceLayer.id)),
        ownOverrides: overridesUnder(ownOverrides, sourceLayer.id),
        componentPathPrefix: componentPath,
        wrapperOverridden: overriddenByOwner(sourceLayer, index),
      });
      continue;
    }

    const copied = clone(sourceLayer);
    copied.id = layerIds.get(sourceLayer.id);
    copied.parentId = nextParent;
    copied.visible = visible;
    copied.playbackWindows = inheritedWindows(sourceLayer, sourceById, childWindows, childOffset);
    copied.mediaStart = addTime(
      copied.mediaStart ?? 0,
      childOffset,
      `media start for layer "${sourceLayer.name ?? sourceLayer.id}"`,
    );
    copied.animations = remapAnimations(
      sourceLayer,
      usedAnimationIds,
      path,
      childOffset,
      freshIds,
    );
    if (!freshIds) {
      copied.componentOwnerId = ownerId;
      // Where this layer comes from (source layer IDs from the top instance's main component),
      // and whether the top instance overrides it. Both exist only on drawn copies.
      copied.componentPath = componentPath;
      copied.componentOverridden = overriddenByOwner(sourceLayer, index);
    } else removeComponentMetadata(copied);
    outputLayers.push(copied);
    if (outputLayers.length > MAX_EXPANDED_LAYERS)
      fail(`expanded scene exceeds ${MAX_EXPANDED_LAYERS} layers.`);
  }
}

function componentScenes(document) {
  return new Map((document.scenes ?? []).map((scene) => [scene.id, scene]));
}

function materializeScene(document, scene, { selectedId, freshIds = false, fonts } = {}) {
  const scenesById = componentScenes(document);
  const { layerIds, animationIds } = collectUsedIds(document);
  const originalLayers = scene.layers ?? [];
  const sceneLayersById = new Map(originalLayers.map((layer) => [layer.id, layer]));
  const outputLayers = [];
  for (const layer of originalLayers) {
    if (layer.type !== "component" || (selectedId && layer.id !== selectedId)) {
      const copied = clone(layer);
      copied.playbackWindows = inheritedWindows(layer, sceneLayersById);
      if (!freshIds) copied.visible = effectiveVisibility(layer, sceneLayersById, true);
      outputLayers.push(copied);
      continue;
    }
    materializeInstance(layer, {
      scenesById,
      document,
      fonts,
      outputLayers,
      usedLayerIds: layerIds,
      usedAnimationIds: animationIds,
      freshIds,
      ownerId: layer.id,
      parentId: layer.parentId ?? null,
      parentPath: scene.id,
      outerTimeOffset: 0,
      depth: 1,
      referenceStack: [],
      inheritedVisible: effectiveVisibility(layer, sceneLayersById, true),
      playbackWindows: inheritedWindows(layer, sceneLayersById),
      preserveRootAnimations: true,
      overrides: layer.componentOverrides ?? null,
      ownOverrides: layer.componentOverrides ?? null,
      componentPathPrefix: "",
    });
  }
  return { ...clone(scene), layers: outputLayers };
}

/** A new instance of `sourceScene`. `fields` are the instance layer's own fields (x, y, name…). */
export function createComponentInstance(sourceScene, fields = {}) {
  assertSourceScene(sourceScene);
  return createLayer("component", {
    ...fields,
    name: fields.name ?? sourceScene.name,
    width: sourceScene.width,
    height: sourceScene.height,
    componentSceneId: sourceScene.id,
    componentStart: fields.componentStart ?? 0,
    clipContent: fields.clipContent ?? true,
  });
}

export function expandComponents(document, sceneId, options = {}) {
  const scene = document?.scenes?.find((candidate) => candidate.id === sceneId);
  if (!scene) fail(`scene "${sceneId}" was not found.`);
  const drawn = materializeScene(document, scene, options);
  // The project's shutter goes with each drawn scene, so look and render read it there (previewBlur.js).
  if (typeof document.shutterAngle === "number") drawn.shutterAngle = document.shutterAngle;
  // The scene's drift (engine/camera.js) is part of how it is drawn; `camera: false` gives the saved
  // layer tree, for edits that look up a layer's own parent and place.
  if (options.camera === false || !scene.drift) return drawn;
  return withDrift(drawn, {
    windowOf: (layer, animation) => animationWindow(layer, animation, options.fonts),
    makeGroup: (fields) => createLayer("group", fields),
  });
}

export function detachComponent(document, sceneId, layerId, {fonts} = {}) {
  const scene = document?.scenes?.find((candidate) => candidate.id === sceneId);
  if (!scene) fail(`scene "${sceneId}" was not found.`);
  const instance = scene.layers?.find((layer) => layer.id === layerId);
  if (!instance || instance.type !== "component")
    fail(`component instance "${layerId}" was not found in scene "${sceneId}".`);
  const detachedScene = materializeScene(document, scene, {
    selectedId: layerId,
    freshIds: true,
    fonts,
  });
  const detachedDocument = clone(document);
  const sceneIndex = detachedDocument.scenes.findIndex(
    (candidate) => candidate.id === sceneId,
  );
  detachedDocument.scenes[sceneIndex] = detachedScene;
  return detachedDocument;
}

