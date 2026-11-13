// The pictures of a scene's script layers for an export, a still or a look frame. Before a frame's
// SVG is made, `prepare(times)` draws every script layer the scene shows at those times with the
// shared script renderer (script-frames.mjs), and `frames` hands the PNGs to renderSceneSvg
// (its `scriptFrames` option). Frames are kept in a small cache, so a sheet or a second render
// never draws the same frame twice; a frame that fails draws nothing and becomes one warning
// sentence (a final render is refused with it instead).
//
// The flow for one output frame: export.mjs renderPng / renderQualityFrame
//   -> scripts.prepare([times])        draws what is not cached yet
//   -> frameSvg(... scriptFrames)      renderSceneSvg asks frames.get(id)({layer, time})
//   -> the PNG goes into the SVG as an <image>, like a video frame.
import { createHash } from "node:crypto";
import { heldSceneTime, layerClocks } from "../engine/render.js";
import { evaluateLayer } from "../engine/animation.js";
import { frameFor, scriptKey } from "../engine/scriptLayer.js";
import { createScriptRenderer } from "./script-frames.mjs";

const IDLE_CLOSE_MS = 60_000;
const MAX_PIXEL_RATIO = 8;
const MAX_SIDE = 16384;
const MAX_PIXELS = 64_000_000;
// The drawn frames kept between calls, by the bytes of their PNGs (oldest out first).
const CACHE_BYTES = 96 * 1024 * 1024;

// ------------------------------------------------------------- one renderer per backend process

let shared = null;
let idleTimer = null;
let users = 0;

function keepAlive() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

function closeWhenQuiet() {
  clearTimeout(idleTimer);
  if (users > 0) return;
  idleTimer = setTimeout(() => { void closeScriptRenderer(); }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/** The process's script renderer, started on first use and closed after a quiet minute. */
export function scriptRenderer() {
  shared ??= createScriptRenderer();
  return shared;
}

/** Stops the shared renderer's worker (shutdown, or a quiet minute). The next use starts a new one. */
export async function closeScriptRenderer() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const renderer = shared;
  shared = null;
  await renderer?.close().catch(() => {});
}

// ------------------------------------------------------------- the frame cache

const cache = new Map();
let cachedBytes = 0;

function remember(key, entry) {
  if (cache.has(key)) return;
  cache.set(key, entry);
  cachedBytes += entry.png?.length ?? 0;
  for (const [oldKey, old] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    cache.delete(oldKey);
    cachedBytes -= old.png?.length ?? 0;
  }
}

function recall(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

/** Empties the frame cache (tests). */
export function clearScriptFrameCache() {
  cache.clear();
  cachedBytes = 0;
}

/** How many frames the cache holds (tests). */
export function scriptFrameCacheSize() {
  return cache.size;
}

// ------------------------------------------------------------- a scene's script layers

// Script layers the scene draws: visible, with every group around them visible.
function shownScriptLayers(scene) {
  const byId = new Map((scene.layers ?? []).map((layer) => [layer.id, layer]));
  const shown = (layer, seen = new Set()) => {
    for (let at = layer; at; at = at.parentId == null ? null : byId.get(at.parentId)) {
      if (seen.has(at.id) || at.visible === false) return false;
      seen.add(at.id);
    }
    return true;
  };
  return (scene.layers ?? []).filter((layer) => layer.type === "script" && typeof layer.script === "string" && shown(layer));
}

/**
 * The pixel ratio a script draws at for an output of `dimensions`: the output's scale over the
 * scene, so a 2x or 4K export gets a sharper picture, bounded so the canvas stays within limits.
 */
export function scriptPixelRatio(scene, dimensions, layer) {
  const scale = Math.max(dimensions.width / (scene.width || dimensions.width), dimensions.height / (scene.height || dimensions.height));
  let ratio = Math.min(MAX_PIXEL_RATIO, Math.max(0.05, Number.isFinite(scale) ? scale : 1));
  const width = Math.max(1, layer?.width ?? 1), height = Math.max(1, layer?.height ?? 1);
  ratio = Math.min(ratio, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.round(ratio * 1000) / 1000;
}

/** The warning sentence of a failed frame. */
export function scriptErrorSentence(layer, error) {
  const time = Number.isFinite(error?.time) ? ` at ${error.time.toFixed(2)} s` : "";
  return `script layer "${layer.name ?? layer.id}": ${error?.message ?? "the script failed"}${time} (${error?.phase ?? "draw"})`;
}

const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

/**
 * The script layers of `scene` for one render, or null when it has none.
 * - `dimensions`: the output size ({width, height}); it sets the pixel ratio.
 * - `readImage(src, label)`: the bytes of an image input's picture ({buffer}), read the safe way
 *   image layers are (export.mjs readMediaSource).
 * - `warnings`: the render's warnings list; each failing layer adds one {code:"script-layer-error"}.
 * - `final`: a final render, which a failing frame stops with the warning sentence.
 * Returns {frames, prepare(times, signal) -> [sentences of this call's failures]}.
 */
export function sceneScriptFrames(scene, { dimensions, readImage, warnings = [], final = false, renderer } = {}) {
  const layers = shownScriptLayers(scene);
  if (!layers.length) return null;
  const sceneDuration = scene.duration;
  const plans = new Map();
  const failed = new Map();

  // What one layer needs for every frame: its key parts and its image inputs' bytes.
  async function planFor(layer) {
    if (plans.has(layer.id)) return plans.get(layer.id);
    const plan = (async () => {
      const images = {};
      const imageHashes = {};
      for (const input of layer.inputs ?? []) {
        if (input.type !== "image") continue;
        const src = layer.values?.[input.key];
        if (!src) { images[input.key] = null; continue; }
        const media = await readImage(src, `Script layer "${layer.name ?? layer.id}" image input "${input.key}"`);
        images[input.key] = media.buffer;
        imageHashes[input.key] = hashOf(media.buffer);
      }
      const pixelRatio = scriptPixelRatio(scene, dimensions, layer);
      const base = `${scriptKey(layer)}\u0000${layer.name ?? ""}\u0000${pixelRatio}\u0000${JSON.stringify(imageHashes)}`;
      return { images, pixelRatio, base, clocks: layerClocks(scene.layers, layer) };
    })();
    plans.set(layer.id, plan);
    return plan;
  }

  const frameKey = (plan, frame) => `${plan.base}\u0000${JSON.stringify(frame)}`;
  // The plans are settled once prepare has run; the SVG side reads them without waiting.
  const ready = new Map();
  // The frames the latest prepare calls asked for, so the shared cache dropping one (a big export
  // filling it) never loses a frame between prepare and its SVG.
  const held = new Map();
  const hold = (key, entry) => {
    held.delete(key);
    held.set(key, entry);
    if (held.size > 64) held.delete(held.keys().next().value);
  };

  function record(layer, error) {
    const sentence = scriptErrorSentence(layer, error);
    if (final) throw new Error(`${sentence}. Fix the script (look {mode:"frame", t} shows the frame) before a final render.`);
    if (!failed.has(layer.id)) {
      failed.set(layer.id, sentence);
      warnings.push({ code: "script-layer-error", layerId: layer.id, message: sentence });
    }
    return sentence;
  }

  async function prepare(times, signal) {
    const problems = [];
    users += 1;
    keepAlive();
    try {
      for (const layer of layers) {
        let plan;
        try {
          plan = await planFor(layer);
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          problems.push(record(layer, { message: error?.message ?? String(error), phase: "load", time: times[0] ?? 0 }));
          continue;
        }
        ready.set(layer.id, plan);
        // Frames by canvas size: a layer whose size animates mounts once per size.
        const missing = new Map();
        for (const sceneTime of times) {
          const time = heldSceneTime(sceneTime, plan.clocks);
          if (evaluateLayer(layer, time).visible === false) continue;
          const frame = frameFor(layer, time, { sceneDuration });
          const key = frameKey(plan, frame);
          const known = recall(key);
          if (known) { hold(key, known); continue; }
          const size = `${frame.width}x${frame.height}`;
          if (!missing.has(size)) missing.set(size, new Map());
          missing.get(size).set(key, frame);
        }
        for (const group of missing.values()) {
          const keys = [...group.keys()], frames = [...group.values()];
          const { width, height } = frames[0];
          if (!(width > 0 && height > 0)) continue;
          const results = await (renderer ?? scriptRenderer()).render({ script: layer.script, width, height, pixelRatio: plan.pixelRatio,
            frames, images: plan.images, signal, name: layer.name ?? "" });
          results.forEach((result, index) => {
            if (result.error) problems.push(record(layer, result.error));
            else { remember(keys[index], result); hold(keys[index], result); }
          });
        }
      }
    } finally {
      users -= 1;
      closeWhenQuiet();
    }
    return problems;
  }

  // renderSceneSvg's scriptFrames: the cached PNG of the layer's frame at the drawing's time, or
  // nothing (a failed or empty frame).
  const frames = new Map(layers.map((layer) => [layer.id, ({ layer: shown, time }) => {
    const plan = ready.get(layer.id);
    if (!plan) return "";
    const key = frameKey(plan, frameFor(shown, time, { sceneDuration }));
    const entry = held.get(key) ?? recall(key);
    if (!entry?.png || entry.empty) return "";
    return { buffer: entry.png, mimeType: "image/png" };
  }]));

  return { frames, prepare, failed };
}
