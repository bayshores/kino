// How sharp the stage draws the live picture while a scene plays. Most effects play at full
// resolution, but light rays are hundreds of shifted copies of the light in three filter stages,
// and Chromium's cost grows with every device pixel. Measured in a real Chrome window on a 2× Mac
// screen with the stage zoomed to fill the window (about four times MAX_LIVE_PIXELS; the exact size
// follows the window and the dashboard's layout), on a busy machine: one rays layer showed about 6
// new pictures a second at full resolution and 30 at 1280×720; two rays layers that fill the frame
// about 25 at 1280×720 and three about 17 (an earlier count at full resolution gave 2 to 3 and
// about 1). Six small layers with rays kept 30 either way.
//
// So while light rays are drawn at the time on screen, on a stage larger than MAX_LIVE_PIXELS
// device pixels, the stage draws the live picture smaller and enlarges it to fill the stage
// (panes.jsx, ReducedPicture). A paused stage shows the exact frame from the export renderer, and
// exports never use any of this.

import { enabledAnimations } from "../../engine/animationEnabled.js";
import { effectsAt } from "../../engine/effects/animation.js";
import { calmLightAnimations } from "../../engine/effects/light.js";

/** Effects too heavy to draw live at full resolution on a large stage, with their words for the label. */
export const HEAVY_LIVE_EFFECTS = new Map([["light-rays", "light rays"]]);

/** The most device pixels the live picture of a scene with a heavy effect is drawn with (1280×720). */
export const MAX_LIVE_PIXELS = 1280 * 720;

/**
 * The layers the renderer draws: not hidden (`visible: false`) and not inside a hidden group.
 * With `calmLight` (reduced motion) their short Light bursts are calmed, as the preview draws
 * them (calmLightAnimations).
 */
function drawnLayers(layers, { calmLight = false } = {}) {
  const list = Array.isArray(layers) ? layers.filter(Boolean) : [];
  const byId = new Map(list.map((layer) => [layer.id, layer]));
  const hidden = (layer) => {
    // Walks up the groups; the step limit stops at a broken parent loop.
    for (let at = layer, steps = 0; at && steps <= list.length; at = byId.get(at.parentId), steps += 1)
      if (at.visible === false) return true;
    return false;
  };
  return list.filter((layer) => !hidden(layer))
    .map((layer) => (calmLight ? { ...layer, animations: calmLightAnimations(layer.animations) } : layer));
}

/**
 * The words for the heavy effects that turned-on animations of the drawn layers use at any time
 * of the scene, without repeats. The stage gives such a scene's live picture its own layer.
 */
export function heavyLiveEffects(layers, options) {
  const found = new Set();
  for (const layer of drawnLayers(layers, options))
    for (const animation of enabledAnimations(layer.animations ?? []))
      if (animation?.kind === "effect" && HEAVY_LIVE_EFFECTS.has(animation.effect)) found.add(HEAVY_LIVE_EFFECTS.get(animation.effect));
  return [...found];
}

/**
 * The words for the heavy effects the drawn layers show at `time` (seconds), without repeats:
 * the effects the renderer draws then (effectsAt), so a burst counts only while it shows.
 */
export function heavyLiveEffectsAt(layers, time, options) {
  const found = new Set();
  for (const layer of drawnLayers(layers, options))
    for (const frame of effectsAt(layer, time)) {
      const words = HEAVY_LIVE_EFFECTS.get(frame.effect?.key);
      if (words) found.add(words);
    }
  return [...found];
}

/**
 * The size of the smaller live picture for a stage `width` × `height` device pixels large that
 * shows a scene `aspect` (width / height) wide, on a screen with `ratio` device pixels per CSS
 * pixel: about MAX_LIVE_PIXELS device pixels of the scene's shape, as `deviceWidth` ×
 * `deviceHeight` and as CSS pixels (`width` × `height`). Null when the stage has no more device
 * pixels than that already. The size depends on the scene's shape and the screen only, never on
 * the stage's size, so resizing the window only changes how much the picture is enlarged
 * (panes.jsx ReducedPicture says why that matters).
 */
export function reducedLayout({ width, height, aspect, ratio }) {
  if (!(width * height > MAX_LIVE_PIXELS) || !(aspect > 0) || !(ratio > 0)) return null;
  const deviceWidth = Math.round(Math.sqrt(MAX_LIVE_PIXELS * aspect));
  const deviceHeight = Math.round(deviceWidth / aspect);
  return { deviceWidth, deviceHeight, width: deviceWidth / ratio, height: deviceHeight / ratio };
}
