// Scene finish and letterbox: two scene fields drawn above every layer of the scene, in previews
// and in every export kino draws with its own renderer (Lottie keeps editable vector layers and
// cannot carry them; the export says so). Fields and limits: engine/sceneFinishFields.js.
//
//   finish {grain, blackLift, halation, vignette}  each 0 to 1, a part left out is off
//   letterbox 2.35                                 bars so the picture is that wide (width : height)
//
// Both are drawn as ordinary full-scene layers added when the scene is drawn (never stored in
// scene.layers), so the quality checks, the layer list and the agent's edits never see them:
//   black lift   a gray layer screened over the picture (blacks rise to that gray)
//   halation     the picture blurred, cut to its highlights, tinted red-orange and screened back
//   vignette     a white layer multiplied over the picture with the vignette effect (engine/effects/finish.js)
//   grain        a 50% gray layer hard-lit with the grain effect (its amount is finish.grain, seed 0)
//   bars         two black rectangles on top; a root layer with aboveLetterbox true is drawn after them
// Order, bottom to top: the scene's layers, lift, halation, vignette, grain, bars, aboveLetterbox layers.
import { createLayer } from "./model.js";
import { clamp } from "./numbers.js";
import { letterboxBar, normalizeLetterbox, normalizeSceneFinish } from "./sceneFinishFields.js";

const FINISH_ID = "kino-finish";
const throwing = (path, message) => { throw new Error(`${path} ${message}`); };

const fx = (id, effect, to, duration) => ({ id: `${FINISH_ID}-${id}-fx`, name: `Finish ${effect}`, kind: "effect", effect, start: 0, duration, easing: "linear", keepStill: "both", to });
const gray = (amount) => { const byte = Math.round(clamp(amount, 0, 1) * 255).toString(16).padStart(2, "0"); return `#${byte}${byte}${byte}`.toUpperCase(); };

function plate(part, scene, properties) {
  return createLayer("rectangle", { id: `${FINISH_ID}-${part}`, name: `Finish ${part}`, x: 0, y: 0, width: scene.width, height: scene.height,
    radius: 0, locked: true, ...properties });
}

/** The layers that draw a scene's finish and letterbox, bottom to top (empty when both are off). */
export function sceneFinishLayers(scene) {
  const { width, height } = scene;
  const duration = Number.isFinite(scene.duration) && scene.duration > 0 ? scene.duration : 1;
  const finish = normalizeSceneFinish(scene.finish, "finish", throwing);
  const layers = [];
  if (finish?.blackLift) layers.push(plate("lift", scene, { fill: gray(finish.blackLift), blendMode: "screen" }));
  if (finish?.halation) {
    // Blur radius is a share of the scene height (a guess: 1.2%, about 13 px at 1080p; the layer maximum is 100).
    const radius = clamp(Math.round(height * 0.012), 2, 100);
    layers.push(plate("halation", scene, {
      fillEnabled: false, blendMode: "screen", opacity: clamp(finish.halation * 2, 0, 1),
      backgroundBlur: { enabled: true, radius, blend: 100 },
      // Highlights only (the curve is flat to 0.55 luma), then a red-orange tint.
      animations: [
        fx("halation-curve", "curves", { master: [[0, 0], [0.55, 0], [1, 1]] }, duration),
        fx("halation-tint", "color-wheels", { gainGreen: -0.55, gainBlue: -0.85 }, duration),
      ] }));
  }
  if (finish?.vignette) layers.push(plate("vignette", scene, { fill: "#FFFFFF", blendMode: "multiply",
    // Corners go dark from about 45% of the way out; amount is the whole setting (a guess for midpoint and feather).
    animations: [fx("vignette", "vignette", { amount: finish.vignette, midpoint: 0.45, feather: 0.7, color: "#000000" }, duration)] }));
  if (finish?.grain) layers.push(plate("grain", scene, { fill: "#808080", blendMode: "hard-light",
    // finish.grain is the grain effect's own amount (the synthesis table's 0.15 is that amount). Doubled,
    // as first built, 0.15 put noise of about 7 levels (of 255) on flat black and green at 1280 px,
    // plainly visible where the studied human frames show none. Size scales with the scene so 1080p
    // and 4K look alike (the effect's 1.5 px at 1080p; scaling is a guess, not a measurement).
    animations: [fx("grain", "grain", { amount: finish.grain, size: clamp(1.5 * height / 1080, 0.5, 8), monochrome: true, animated: true }, duration)] }));
  const bar = letterboxBar(width, height, normalizeLetterbox(scene.letterbox, "letterbox", throwing));
  if (bar > 0) {
    layers.push(plate("bar-top", scene, { height: bar, fill: "#000000" }));
    layers.push(plate("bar-bottom", scene, { y: height - bar, height: bar, fill: "#000000" }));
  }
  return layers;
}

/**
 * The scene as it is drawn: the finish and bars above its layers, and the root layers marked
 * aboveLetterbox moved above the bars. The same scene object when it has neither.
 */
export function withSceneFinish(scene) {
  if (!scene.finish && !scene.letterbox) return scene;
  const added = sceneFinishLayers(scene);
  if (!added.length) return scene;
  const lifted = scene.layers.filter((layer) => layer.aboveLetterbox === true && !layer.parentId && !layer.isMask);
  const rest = lifted.length ? scene.layers.filter((layer) => !lifted.includes(layer)) : scene.layers;
  return { ...scene, layers: [...rest, ...added, ...lifted] };
}
