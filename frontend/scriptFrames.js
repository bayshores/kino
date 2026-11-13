// The live preview's plan for script layers, as plain functions (useScriptFrames.js runs them):
// which layers need a frame, what one request asks for, when to ask again, and when a picture
// came back too late to show. No DOM here, so it is tested on its own (scriptFrames.test.js).
import { frameFor, scriptKey } from "../engine/scriptLayer.js";

/** A picture for a time this far (seconds) from where the playhead is now is not shown. */
export const LATE_SECONDS = 0.1;
/** The most picture pixels per layer pixel the preview asks for. */
export const MAX_PREVIEW_RATIO = 2;

/** The scene's script layers that have a module to run. */
export function scriptLayersToDraw(layers) {
  return (layers ?? []).filter((layer) => layer?.type === "script" && typeof layer.script === "string" && layer.script.trim() !== "");
}

/** The image inputs' sources (or a model input's, `type` "model"), {key: src}; an empty src is none. */
export function imageSources(layer, type = "image") {
  const sources = {};
  for (const input of layer.inputs ?? []) if (input.type === type) sources[input.key] = layer.values?.[input.key] || "";
  return sources;
}

/**
 * The pixel ratio the preview draws at: the stage's screen pixels per scene pixel, in quarter
 * steps (so a small window resize does not start the module again), at most MAX_PREVIEW_RATIO.
 */
export function previewRatio(stagePixels, sceneWidth) {
  const ratio = stagePixels > 0 && sceneWidth > 0 ? stagePixels / sceneWidth : 1;
  return Math.min(MAX_PREVIEW_RATIO, Math.max(0.25, Math.ceil(ratio * 4) / 4));
}

/**
 * What to ask the frame for at `time`: the mount (module, size, ratio, images: a new one starts
 * the module again) and the draw (frameFor). Each has a key; the same key means the same picture.
 */
export function scriptRequest(layer, time, { sceneDuration, pixelRatio = 1 } = {}) {
  const frame = frameFor(layer, time, { sceneDuration });
  const width = Math.max(1, Math.round(Number(frame.width) || 1));
  const height = Math.max(1, Math.round(Number(frame.height) || 1));
  const images = imageSources(layer);
  const models = imageSources(layer, "model");
  const mountKey = JSON.stringify([scriptKey(layer), width, height, pixelRatio, layer.name ?? "", images, models]);
  const drawn = { ...frame, width, height };
  return {
    mountKey,
    mount: { script: layer.script, width, height, pixelRatio, name: String(layer.name ?? ""), images, models },
    key: `${mountKey}\n${JSON.stringify(drawn)}`,
    frame: drawn,
    sceneTime: time,
  };
}

/**
 * Whether to send `wanted` now. A slot is one layer's state: {mounted (its mountKey once the
 * module is ready), pending (the request in flight), shownKey (the picture on screen)}. At most
 * one request is in flight: a newer wish waits in slot.wanted and goes when the reply comes.
 */
export function shouldSend(slot, wanted) {
  if (!wanted || slot.failedKey === wanted.mountKey) return false;
  if (slot.mounted !== wanted.mountKey || slot.pending) return false;
  return wanted.key !== slot.shownKey;
}

/**
 * True when a picture drawn for `arrived` should not be shown because the preview now wants
 * another one: another module or size, or a time more than LATE_SECONDS from the playhead.
 */
export function isLate(arrived, wanted) {
  if (!wanted || arrived.key === wanted.key) return false;
  if (arrived.mountKey !== wanted.mountKey) return true;
  return Math.abs(arrived.sceneTime - wanted.sceneTime) > LATE_SECONDS;
}
