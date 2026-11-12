import { enabledAnimations } from "../engine/animationEnabled.js";
import { withSceneFinish } from "../engine/sceneFinish.js";

// These filters use Chromium's affine sampling and color pipeline in the editor.
// Keep the established Resvg path for documents without the new filter features
// or the "add" blend mode.
export function sceneNeedsChromium(scene) {
  // The scene's finish draws effect layers above the scene's own (sceneFinish.js).
  scene = withSceneFinish(scene);
  const byId = new Map(scene.layers.map(layer => [layer.id, layer]));
  return scene.layers.some(layer => {
    if (layer.type === "audio") return false;
    const seen = new Set();
    for (let current = layer; current; current = byId.get(current.parentId)) {
      if (current.visible === false || seen.has(current.id)) return false;
      seen.add(current.id);
    }
    if (layer.effectPreset || layer.backgroundBlur?.enabled || layer.glass?.enabled) return true;
    // Log footage is converted by a 3D LUT, which resvg draws darker (about 4/255).
    if (layer.type === "video" && layer.log) return true;
    // Resvg has no "add" (CSS plus-lighter) blending, so those scenes are drawn by Chromium.
    if (String(layer.blendMode ?? "").toLowerCase() === "add") return true;
    return enabledAnimations(layer.animations).some(operation => operation.kind === "effect" ||
      [operation.from, operation.to].some(endpoint => endpoint?.effectPreset || endpoint?.backgroundBlur?.enabled || endpoint?.glass?.enabled));
  });
}
