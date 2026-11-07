import { applyComponentOverride, resolveComponentPath } from "./componentOverrides.js";
import { flattenAnimations } from "./animationTree.js";
import { displayText, resizeTextLayer } from "./textLayout.js";
import { parseDocument } from "./model.js";
import { isEffectivelyLocked } from "./layerTree.js";
import { layerFontReferences } from "./textFontReferences.js";
import { withTextStylePatches, withWholeTextStyle } from "./textStyleRanges.js";
import { mirroredTextCharacters } from "./textBidi.js";

export function fontTextCharacters(layer) {
  const texts = [displayText(layer)];
  for (const animation of flattenAnimations(layer.animations)) {
    if (animation.enabled === false) continue;
    if (animation.kind === "change-text") texts.push(displayText({ ...layer, text: animation.text }));
    if (animation.kind === "counter") texts.push("0123456789-., ");
  }
  return [...new Set(texts.flatMap((text) => [text, mirroredTextCharacters(text)]).join("").normalize("NFC"))].join("");
}

/** Include effective instance text without measuring it before its fonts are available. */
export function documentTextLayers(document) {
  const scenes = document?.scenes ?? [];
  const scenesById = new Map(scenes.map((scene) => [scene.id, scene]));
  const layers = scenes.flatMap((scene) => scene.layers ?? []);
  const texts = layers.filter((layer) => layer.type === "text");
  for (const instance of layers.filter((layer) => layer.type === "component")) {
    for (const [componentPath, override] of Object.entries(instance.componentOverrides ?? {})) {
      const resolved = resolveComponentPath(instance, scenesById, componentPath);
      if (resolved?.inherited?.type === "text") texts.push(applyComponentOverride(resolved.inherited, override));
    }
  }
  return texts;
}

export function documentFontReferences(document) {
  const grouped = new Map();
  for (const layer of documentTextLayers(document)) for (const { text, ...reference } of layerFontReferences(layer)) {
    const key = JSON.stringify(reference);
    const previous = grouped.get(key);
    grouped.set(key, { ...reference, text: [...new Set((previous?.text ?? "") + text)].join("") });
  }
  return [...grouped.values()];
}

export function fontTargetLayers(document, sceneId, layerIds) {
  const scene = document?.scenes.find((item) => item.id === sceneId);
  if (!scene || !Array.isArray(layerIds) || !layerIds.length || layerIds.length > 1000 || new Set(layerIds).size !== layerIds.length)
    throw new Error("Choose text layers in one scene before changing their font.");
  return layerIds.map((id) => {
    const layer = scene.layers.find((item) => item.id === id);
    if (!layer || layer.type !== "text") throw new Error("Every font target must be an existing text layer.");
    if (isEffectivelyLocked(scene.layers, id)) throw new Error("Unlock the text layers before changing their font.");
    return layer;
  });
}

/** Apply prepared font choices once; callers finish downloads before committing this result. */
export function withFontPatches(document, sceneId, patches, fonts) {
  const layers = fontTargetLayers(document, sceneId, patches.map((item) => item.id));
  const changed = layers.map((layer, index) => {
    const { id, ...patch } = patches[index];
    fonts.resolve({ ...layer, ...patch });
    return resizeTextLayer(Object.hasOwn(patch, "textStyleRanges")
      ? { ...layer, ...patch } : withWholeTextStyle(layer, patch), fonts);
  });
  if (changed.every((layer, index) => JSON.stringify(layer) === JSON.stringify(layers[index]))) return document;
  const byId = new Map(changed.map((layer) => [layer.id, layer]));
  return parseDocument({ ...document, scenes: document.scenes.map((scene) => scene.id === sceneId
    ? { ...scene, layers: scene.layers.map((layer) => byId.get(layer.id) ?? layer) } : scene) });
}

/** Render-only overrides: no source document, history, recovery or collaborative save is touched. */
export function previewFontScene(scene, preview, fonts) {
  if (!preview || preview.sceneId !== scene.id) return scene;
  const byLayer = new Map();
  for (const { id, ...patch } of preview.patches) {
    if (!byLayer.has(id)) byLayer.set(id, []);
    byLayer.get(id).push(patch);
  }
  return { ...scene, layers: scene.layers.map((layer) => {
    const patches = byLayer.get(layer.id);
    if (!patches) return layer;
    let next = layer;
    if (patches.every((patch) => patch.textRange)) next = withTextStylePatches(next,
      patches.map(({ textRange, ...style }) => ({ ...textRange, style })));
    else for (const { textRange, ...patch } of patches) {
      if (textRange) throw new Error("A font preview must target whole text or selected text.");
      next = Object.hasOwn(patch, "textStyleRanges") ? { ...next, ...patch } : withWholeTextStyle(next, patch);
    }
    return next === layer ? layer : resizeTextLayer(next, fonts);
  }) };
}
