import { applyComponentOverride, resolveComponentPath } from "./componentOverrides.js";
import { isEffectivelyLocked } from "./layerTree.js";
import { textStyleSegments } from "./textStyleRanges.js";
import { layerFontReferences } from "./textFontReferences.js";

const FONT_KEYS = ["fontFamily", "fontSource", "fontWeight", "fontStyle"];
const reference = (layer) => ({ fontFamily: layer.fontFamily, fontSource: layer.fontSource || "",
  fontWeight: layer.fontWeight || 400, fontStyle: layer.fontStyle || "normal" });

/** Stored text sites, including effective instance text and its owning override. */
export function documentFontSites(document) {
  const scenes = document?.scenes ?? [];
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const sites = [];
  for (const scene of scenes) for (const owner of scene.layers ?? []) {
    const add = (layer, componentPath = null, ownsFont = true, ownsRanges = true) => {
      const required = new Map(layerFontReferences(layer).map(({ text, ...font }) => [JSON.stringify(font), text]));
      const site = (styled, rangeIndex = null, owns = ownsFont) => sites.push({
        key: JSON.stringify([scene.id, owner.id, componentPath, ...(rangeIndex === null ? [] : [rangeIndex])]),
        sceneId: scene.id, sceneName: scene.name, layerId: owner.id,
        layerName: componentPath ? `${owner.name} / ${layer.name}` : owner.name,
        componentPath, rangeIndex, ownsFont: owns, layer: styled, storedLayer: layer,
        characters: required.get(JSON.stringify(reference(styled))) ?? "",
        locked: Boolean(layer.locked || isEffectivelyLocked(scene.layers, owner.id)),
      });
      site(layer);
      const segments = layer.textStyleRanges?.length ? textStyleSegments(layer) : [];
      let segmentIndex = 0;
      for (const [index, range] of (layer.textStyleRanges ?? []).entries()) {
        if (!FONT_KEYS.some((key) => Object.hasOwn(range.style, key))) continue;
        while (segments[segmentIndex]?.end <= range.start) segmentIndex++;
        site({ ...layer, ...segments[segmentIndex]?.style }, index, ownsRanges);
      }
    };
    if (owner.type === "text") add(owner);
    if (owner.type !== "component") continue;
    for (const [componentPath, override] of Object.entries(owner.componentOverrides ?? {})) {
      const resolved = resolveComponentPath(owner, byId, componentPath);
      if (resolved?.inherited?.type === "text")
        add(applyComponentOverride(resolved.inherited, override), componentPath,
          FONT_KEYS.some((key) => Object.hasOwn(override, key)), Object.hasOwn(override, "textStyleRanges"));
    }
  }
  return sites;
}

/** A strict availability report; fallback drawing never conceals a missing reference. */
export function missingDocumentFonts(document, fonts) {
  const grouped = new Map();
  for (const site of documentFontSites(document)) {
    let problem;
    try { fonts.resolve(site.layer); }
    catch (error) { problem = error; }
    if (!problem) continue;
    const font = reference(site.layer), key = JSON.stringify(font);
    let entry = grouped.get(key);
    if (!entry) {
      let fallbackFamily = "";
      try { fallbackFamily = fonts.renderingFace(site.layer).family; } catch { /* No usable face exists. */ }
      entry = { key, ...font, message: problem.message, fallbackFamily, locations: [] };
      grouped.set(key, entry);
    }
    entry.locations.push({ sceneId: site.sceneId, sceneName: site.sceneName, layerId: site.layerId,
      layerName: site.layerName, componentPath: site.componentPath, locked: site.locked,
      ...(site.rangeIndex === null ? {} : { textRange: { start: site.storedLayer.textStyleRanges[site.rangeIndex].start, end: site.storedLayer.textStyleRanges[site.rangeIndex].end } }) });
  }
  return [...grouped.values()].map((entry) => ({ ...entry,
    layerCount: new Set(entry.locations.map((site) => JSON.stringify([site.sceneId, site.layerId, site.componentPath]))).size,
    sceneCount: new Set(entry.locations.map((site) => site.sceneId)).size,
  }));
}
