import { enabledAnimations } from "../engine/animationEnabled.js";
import { effectsAt } from "../engine/effects/animation.js";
import { effectDefinition } from "../engine/effects/catalog.js";
import { EFFECT_PRESET_DEFINITIONS } from "../engine/effects/presetCatalog.js";

function layerEffects(layer) {
  const names = new Set();
  const operations = enabledAnimations(layer.animations);
  for (const operation of operations) {
    if (operation.kind === "effect") names.add(effectDefinition(operation.effect).label);
    const preset = operation.to?.effectPreset ?? operation.from?.effectPreset;
    if (preset) names.add(EFFECT_PRESET_DEFINITIONS[preset.id]?.name ?? preset.id);
  }
  for (const [key, name] of [["backgroundBlur", "Background Blur"], ["glass", "Glass"]])
    if (layer[key]?.enabled || operations.some((operation) => operation.from?.[key]?.enabled || operation.to?.[key]?.enabled)) names.add(name);
  return [...names];
}

function nativeConstantFill(layer, times) {
  // The SVG Duotone also clips to the design box. A strokeless rectangle's
  // complete source is already inside that box, so Fill alone is exact here.
  if (layer.type !== "rectangle" || layer.strokeWidth > 0 ||
    enabledAnimations(layer.animations).some((operation) => operation.from?.strokeWidth > 0 || operation.to?.strokeWidth > 0)) return null;
  if (layer.backgroundBlur?.enabled || layer.glass?.enabled) return null;
  if (enabledAnimations(layer.animations).some((operation) => operation.from?.effectPreset || operation.to?.effectPreset ||
    operation.from?.backgroundBlur || operation.to?.backgroundBlur || operation.from?.glass || operation.to?.glass)) return null;
  const colors = [];
  for (const time of times) {
    const frames = effectsAt(layer, time);
    if (frames.length !== 1 || frames[0].effect.key !== "duotone" || frames[0].parameters.mix < 1) return null;
    const { shadowColor, highlightColor } = frames[0].parameters;
    if (shadowColor !== highlightColor) return null;
    colors.push(shadowColor);
  }
  // lottie-web 5.13 SVG Fill (21) uses an sRGB matrix that preserves alpha.
  // Equal Duotone endpoints are exactly this constant-color matrix. General
  // Duotone/Tritone luminance curves deliberately use the raster path instead.
  return colors;
}

/** Select the outermost affected subtree; unaffected ancestors stay vector. */
export function planLottieEffects(scene, times) {
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const visible = (layer) => {
    const seen = new Set();
    while (layer) {
      if (layer.visible === false || seen.has(layer.id)) return false;
      seen.add(layer.id);
      layer = byId.get(layer.parentId);
    }
    return true;
  };
  const candidates = new Map(), nativeFills = new Map(), descriptions = [];
  for (const layer of scene.layers) {
    if (!visible(layer) || layer.type === "audio") continue;
    const effects = layerEffects(layer);
    if (!effects.length) continue;
    descriptions.push({ id: layer.id, name: layer.name ?? layer.id, effects });
    const fill = nativeConstantFill(layer, times);
    if (fill) nativeFills.set(layer.id, fill);
    else candidates.set(layer.id, { id: layer.id, name: layer.name ?? layer.id, effects });
  }
  const inside = (layer, ids, includeSelf = false) => {
    let current = includeSelf ? layer : byId.get(layer.parentId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      if (ids.has(current.id)) return true;
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return false;
  };
  const targets = [...candidates.values()].filter((target) => !inside(byId.get(target.id), candidates));
  const roots = new Set(targets.map(({ id }) => id));
  const coveredIds = new Set(scene.layers.filter((layer) => inside(layer, roots, true)).map(({ id }) => id));
  for (const id of nativeFills.keys()) if (coveredIds.has(id)) nativeFills.delete(id);
  return { targets, coveredIds, nativeFills, descriptions: descriptions.filter(({ id }) => coveredIds.has(id)) };
}
