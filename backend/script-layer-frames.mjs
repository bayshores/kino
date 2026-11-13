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
import { hiddenRanges } from "../engine/visibilityOps.js";
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
export function sceneScriptFrames(scene, { dimensions, readImage, warnings = [], final = false, renderer, only } = {}) {
  const layers = shownScriptLayers(scene).filter((layer) => !only || only.includes(layer.id));
  if (!layers.length) return null;
  const sceneDuration = scene.duration;
  const plans = new Map();
  const failed = new Map();
  // What the latest prepare calls found, by layer then scene time: {kind:"error", error} for a
  // frame that failed, {kind:"empty"} for a visible frame with no pixel drawn (issuesAt, testDraw).
  const outcomes = new Map();
  const note = (layer, time, outcome) => {
    if (!outcomes.has(layer.id)) outcomes.set(layer.id, new Map());
    outcomes.get(layer.id).set(time, outcome);
  };

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
          const failure = { message: error?.message ?? String(error), phase: "load", time: times[0] ?? 0 };
          problems.push(record(layer, failure));
          for (const time of times) note(layer, time, { kind: "error", error: failure });
          continue;
        }
        ready.set(layer.id, plan);
        // Frames by canvas size: a layer whose size animates mounts once per size.
        const missing = new Map();
        for (const sceneTime of times) {
          const time = heldSceneTime(sceneTime, plan.clocks);
          const evaluated = evaluateLayer(layer, time);
          if (evaluated.visible === false) continue;
          const seen = (evaluated.opacity ?? 1) > 0;
          const frame = frameFor(layer, time, { sceneDuration });
          const key = frameKey(plan, frame);
          const known = recall(key);
          if (known) {
            hold(key, known);
            if (known.empty && seen) note(layer, sceneTime, { kind: "empty" });
            continue;
          }
          const size = `${frame.width}x${frame.height}`;
          if (!missing.has(size)) missing.set(size, new Map());
          const group = missing.get(size);
          if (!group.has(key)) group.set(key, { frame, at: [] });
          group.get(key).at.push({ sceneTime, seen });
        }
        for (const group of missing.values()) {
          const keys = [...group.keys()], entries = [...group.values()];
          const { width, height } = entries[0].frame;
          if (!(width > 0 && height > 0)) continue;
          const results = await (renderer ?? scriptRenderer()).render({ script: layer.script, width, height, pixelRatio: plan.pixelRatio,
            frames: entries.map((entry) => entry.frame), images: plan.images, signal, name: layer.name ?? "" });
          results.forEach((result, index) => {
            const { at } = entries[index];
            if (result.error) {
              problems.push(record(layer, result.error));
              for (const { sceneTime } of at) note(layer, sceneTime, { kind: "error", error: result.error });
            } else {
              remember(keys[index], result);
              hold(keys[index], result);
              if (result.empty) for (const { sceneTime, seen } of at) if (seen) note(layer, sceneTime, { kind: "empty" });
            }
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

  // The problems prepare found at one scene time: [{layerId, kind: "error"|"empty", message?}]
  // (check's script rules read them off the frame; message is the error sentence).
  const issuesAt = (time) => layers.flatMap((layer) => {
    const outcome = outcomes.get(layer.id)?.get(time);
    if (!outcome) return [];
    return [{ layerId: layer.id, kind: outcome.kind, ...(outcome.error ? { message: scriptErrorSentence(layer, outcome.error) } : {}) }];
  });

  return { frames, prepare, failed, outcomes, issuesAt };
}

// ------------------------------------------------------------- the test draw after an edit

const TEST_RATIO = 0.25;
const TEST_LAYERS = 6;
export const TEST_DRAW_MS = 6000;

// The values animations move, from every depth, so a changed animation shows as a changed layer.
function animatedValues(animations) {
  return (animations ?? []).map((animation) => [
    animation?.from?.values, animation?.to?.values, (animation?.keys ?? []).map((key) => key?.value?.values), animatedValues(animation?.animations),
  ]);
}

const drawnBy = (layer) => JSON.stringify([layer.script, layer.inputs, layer.values, layer.width, layer.height, animatedValues(layer.animations)]);

/** The script layers of `after` (a scene) that are new or drew differently in `before` (a scene or null). */
export function changedScriptLayers(before, after) {
  const was = new Map((before?.layers ?? []).filter((layer) => layer.type === "script").map((layer) => [layer.id, drawnBy(layer)]));
  return (after?.layers ?? []).filter((layer) => layer.type === "script" && typeof layer.script === "string" && was.get(layer.id) !== drawnBy(layer));
}

// The start, middle and end of the time a layer shows (the stretches its Hide and Show ops leave).
function testTimes(layer, duration) {
  const total = duration > 0 ? duration : 0;
  const hidden = hiddenRanges(layer.animations ?? [], total);
  let start = 0, end = total;
  if (hidden.length) {
    start = hidden[0].start <= 0 ? hidden[0].end : 0;
    end = hidden.at(-1).end >= total ? hidden.at(-1).start : total;
  }
  if (!(end >= start)) return [];
  return [...new Set([start, (start + end) / 2, end].map((time) => Math.round(time * 100) / 100))];
}

const seconds = (time) => `${time.toFixed(2)} s`;
const listOf = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function errorLine(layer, error, time) {
  const text = String(error?.message ?? "the script failed").replace(/\s+/g, " ").trim();
  const message = text.length > 160 ? `${text.slice(0, 157)}...` : text;
  const at = /\bat \d+\.\d\d s\b/.test(message) ? "" : ` at ${seconds(Number.isFinite(error?.time) ? error.time : time)}`;
  const where = [error?.phase ?? "draw", Number.isInteger(error?.line) ? `line ${error.line}` : null].filter(Boolean).join(", ");
  return `script "${layer.name ?? layer.id}": ${message}${at} (${where})`;
}

/**
 * The lines an edit's receipt shows for the script layers it added or changed: each is drawn at
 * three times (start, middle, end of its visible time) at a small pixel ratio with the shared
 * renderer and frame cache. One line per layer at most: the first failure, else the times that
 * drew nothing; a layer that drew fine adds none.
 * - `before`, `after`: the document before and after the edit.
 * - `renderer`: replaces the shared script renderer (tests).
 * - `readImage(src, label)`: reads an image input's picture, as sceneScriptFrames takes it.
 * Never throws: a renderer that cannot run (no Electron) gives no lines; a draw that has not
 * answered in `timeoutMs` gives one line saying so.
 */
export async function testDrawScriptLayers(before, after, { renderer, readImage, timeoutMs = TEST_DRAW_MS } = {}) {
  const beforeScenes = new Map((before?.scenes ?? []).map((scene) => [scene.id, scene]));
  const jobs = (after?.scenes ?? []).flatMap((scene) => changedScriptLayers(beforeScenes.get(scene.id), scene).map((layer) => ({ scene, layer })));
  if (!jobs.length) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const lines = [];
  const work = (async () => {
    for (const { scene, layer } of jobs.slice(0, TEST_LAYERS)) {
      const times = testTimes(layer, scene.duration);
      const dimensions = { width: Math.max(1, Math.round((scene.width || 1) * TEST_RATIO)), height: Math.max(1, Math.round((scene.height || 1) * TEST_RATIO)) };
      const drawn = sceneScriptFrames(scene, { dimensions, readImage, renderer, only: [layer.id] });
      if (!drawn || !times.length) continue;
      await drawn.prepare(times, controller.signal);
      const outcome = drawn.outcomes.get(layer.id) ?? new Map();
      const failure = times.find((time) => outcome.get(time)?.kind === "error");
      if (failure !== undefined) { lines.push(errorLine(layer, outcome.get(failure).error, failure)); continue; }
      const empty = times.filter((time) => outcome.get(time)?.kind === "empty");
      if (empty.length) lines.push(`script "${layer.name ?? layer.id}" drew nothing at ${listOf(empty.map(seconds))}`);
    }
  })();
  work.catch(() => {});
  const stopped = new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve("timeout"), { once: true }));
  try {
    const outcome = await Promise.race([work.then(() => "done"), stopped]);
    if (outcome === "timeout") return [`script test draw skipped: no answer in ${Math.round(timeoutMs / 1000)} s`];
    return lines;
  } catch {
    // The renderer could not run (no Electron, a worker that stopped): say nothing, the edit stands.
    return [];
  } finally {
    clearTimeout(timer);
  }
}
