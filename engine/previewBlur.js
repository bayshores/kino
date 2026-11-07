// A cheap motion-blur preview for look and the dashboard (renderSceneSvg option previewBlur), and
// the smear of a whip preset in every drawing.
// A final render blurs by drawing the whole frame at several moments of the open shutter and
// averaging them (backend/render-quality.mjs motionSampleTimes). That is too slow for look sheets
// and playback, so the preview reads each moving layer's place at PREVIEW_SAMPLES moments of the
// same shutter and, when it travels far enough to blur, smears the drawn layer along that path
// with one directional-blur filter (effects/motionBlurs.js). Only the layer's own move counts:
// a moving group smears its children with it, and a child moving inside it adds its own smear.
import { evaluateLayer } from "./animation.js";
import { enabledAnimations } from "./animationEnabled.js";
import { IDENTITY, layerMatrix, multiply } from "./geometry.js";
import { renderDirectionalBlur } from "./effects/motionBlurs.js";

export const PREVIEW_SAMPLES = 4;
// The final render's default shutter: motionBlur 0.5 (a 180° shutter) at 30 fps.
export const PREVIEW_SHUTTER = 0.5 / 30;
// Scene pixels of travel during the shutter below which a layer is drawn sharp (480 px/s).
export const PREVIEW_BLUR_FROM = 8;

// A whip preset (presetCatalog.js) smears as if the shutter stayed open a whole 30 fps frame, in
// every drawing (dashboard, look and exports), so its blur does not depend on render settings.
export const WHIP_SHUTTER = 1 / 30;

/** WHIP_SHUTTER while one of `animations` (enabled ones) is a whip running at `time`, else 0. */
export function whipShutter(animations, time) {
  return animations.some((animation) => animation.preset?.id === "whip" &&
    time >= animation.start - WHIP_SHUTTER && time <= animation.start + animation.duration + WHIP_SHUTTER) ? WHIP_SHUTTER : 0;
}

/** The previewBlur option as a shutter in seconds, or 0 when off. */
export function previewShutter(option) {
  if (option === true) return PREVIEW_SHUTTER;
  return typeof option === "number" && Number.isFinite(option) && option > 0 ? Math.min(option, 0.1) : 0;
}

/** The sample moments of the shutter at `time`, as motionSampleTimes spreads them. */
export function previewSampleTimes(time, shutter, duration = Infinity) {
  return Array.from({ length: PREVIEW_SAMPLES }, (_, index) =>
    Math.min(duration, Math.max(0, time + shutter * ((index + 0.5) / PREVIEW_SAMPLES - 0.5))));
}

const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];

/**
 * How a layer moves while the shutter is open: `vector` is the travel of its box center over the
 * whole shutter in its parent's coordinates, `pixels` that travel in scene pixels. `stateAt(time)`
 * gives the layer's evaluated state; `parent` is the parent's world matrix. Null when it is
 * hidden at a sample or holds still.
 */
export function shutterTravel(stateAt, times, parent) {
  const centers = [];
  for (const time of times) {
    const state = stateAt(time);
    if (!state || state.visible === false) return null;
    const width = Number(state.width) || 0, height = Number(state.height) || 0;
    centers.push(apply(layerMatrix(state), [width / 2, height / 2]));
  }
  const first = centers[0], last = centers[centers.length - 1];
  // The samples sit in the middle of their slices, so first to last is (n - 1) / n of the shutter.
  const stretch = times.length / Math.max(1, times.length - 1);
  const vector = [(last[0] - first[0]) * stretch, (last[1] - first[1]) * stretch];
  const [a, b, c, d] = parent;
  const pixels = Math.hypot(a * vector[0] + c * vector[1], b * vector[0] + d * vector[1]);
  return pixels > 0 ? { vector, pixels } : null;
}

// A final render without an explicit motionSamples draws enough shutter samples that the copies of
// its fastest layer sit at most this many output pixels apart, so a fast move smears as the preview
// shows it instead of showing two copies (backend/export.mjs frameMotionSamples).
export const SAMPLE_SPACING = 8;

/**
 * How many shutter samples the frame at `time` needs (2 to `max`): the fastest layer's own travel
 * while the shutter is open, in output pixels (scene pixels times `scale`), over SAMPLE_SPACING.
 * Each layer counts its move within its parent, as the preview smears it; a whip is left out,
 * since it smears itself (whipShutter). `layers` is the scene's flat layer list.
 */
export function shutterSampleCount(layers, time, shutter, { scale = 1, duration = Infinity, fonts, max = 16 } = {}) {
  if (!(shutter > 0) || !Array.isArray(layers)) return 2;
  const times = [Math.max(0, time - shutter / 2), Math.min(duration, time + shutter / 2)];
  if (times[1] <= times[0]) return 2;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const states = times.map(() => new Map());
  const stateAt = (layer, index) => {
    if (!states[index].has(layer.id)) {
      let state = null;
      try { state = evaluateLayer(layer, times[index], { unitIndex: 0, unitCount: 1, fonts, shareAnimations: true }); } catch { state = null; }
      states[index].set(layer.id, state);
    }
    return states[index].get(layer.id);
  };
  const worlds = new Map();
  const worldOf = (id, depth = 0) => {
    const layer = byId.get(id);
    if (!layer || depth > 64) return IDENTITY;
    if (!worlds.has(id)) worlds.set(id, multiply(worldOf(layer.parentId, depth + 1), layerMatrix(stateAt(layer, 0) ?? layer)));
    return worlds.get(id);
  };
  let fastest = 0;
  for (const layer of layers) {
    if (layer.visible === false || !Array.isArray(layer.animations) || !layer.animations.length) continue;
    const animations = enabledAnimations(layer.animations);
    if (!animations.length || whipShutter(animations, time)) continue;
    const travel = shutterTravel((at) => stateAt(layer, at === times[0] ? 0 : 1), times, worldOf(layer.parentId));
    if (travel) fastest = Math.max(fastest, travel.pixels / 2);
  }
  // shutterTravel stretches two end samples by 2 (as if they sat mid-slice): halved, it is the
  // whole shutter's travel.
  return Math.max(2, Math.min(max, Math.ceil(fastest * scale / SAMPLE_SPACING)));
}

/**
 * The layer's drawn tag smeared along `vector` (parent coordinates) with a directional blur, as
 * renderSceneSvg puts it in its parent. `bounds` is what the tag paints in the parent; `helpers`
 * are the effect helpers (defs, id, raster, transform from parent to output pixels).
 */
export function smearTag(tag, vector, bounds, helpers) {
  const length = Math.hypot(vector[0], vector[1]);
  const angle = Math.atan2(vector[1], vector[0]) * 180 / Math.PI;
  const box = { x: bounds.x, y: bounds.y, width: Math.max(0.001, bounds.width), height: Math.max(0.001, bounds.height) };
  const smeared = renderDirectionalBlur({ content: tag, bounds: box, paintBounds: box,
    parameters: { length: Math.min(4000, length), angle }, helpers });
  return smeared === tag ? tag : `<g data-preview-blur="${Math.round(length)}">${smeared}</g>`;
}
