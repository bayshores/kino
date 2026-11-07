// Preview segments: short draft videos of a scene that playback can show in place of drawing
// live (step 1 of the preview cache; preview-scheduler.mjs is step 2).
//
// A scene is cut into 2 s segments on its frame grid. Each segment's key hashes only what can
// change its pixels: the scene's own settings, the layers that may show in its frames (with
// everything they lean on: parents, masks, layers they name), the draft size, and the renderer
// (renderContentKey adds the renderer's code, FFmpeg, fonts and media files). An edit to a layer
// that is hidden in every frame of a segment leaves that segment's key as it was. When unsure,
// a layer counts as shown: a stale picture is worse than a render we did not need.
import { join } from "node:path";
import { evaluateLayer, animatesSpeed } from "../engine/animation.js";
import { exportFrameTimes } from "../engine/exportOptions.js";
import { exportScene } from "./export.mjs";
import { createSegmentCache, renderContentKey } from "./render-segment-cache.mjs";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";

export const SEGMENT_SECONDS = 2;
export const PREVIEW_FPS = 30;
// The draft's long side, in pixels: 960 x 540 for a 16:9 scene.
export const PREVIEW_LONG_SIDE = 960;
export const PREVIEW_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
// 2: drawn at the draft quality (PREVIEW_QUALITY). 3: with the motion-blur preview.
const KEY_VERSION = 3;
// About 3 Mbit/s at 960 x 540 (backend/mp4-encoders.mjs videoBitrate), a quarter of an export's.
export const PREVIEW_QUALITY = "draft";
// Group keys that only move, turn, scale or fade the group's children.
const PLAIN_MOTION_KEYS = new Set(["x", "y", "rotation", "scaleX", "scaleY", "skewX", "opacity"]);

/** The draft size for a scene: its long side `longSide` pixels (never larger than the scene), both sides even. */
export function previewSize(scene, { longSide = PREVIEW_LONG_SIDE } = {}) {
  const width = Number(scene.width), height = Number(scene.height);
  if (!(width > 0 && height > 0)) throw new Error("The scene needs a positive width and height.");
  const scale = Math.min(1, longSide / Math.max(width, height));
  const even = (value) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

function sceneFrameTimes(scene, fps) {
  const duration = Math.max(1 / fps, Number.isFinite(scene.duration) ? scene.duration : 1);
  return exportFrameTimes(duration, fps, { format: "mp4" });
}

/**
 * The scene's segments: [{index, start, end, first, count}], `first` and `count` in frames of
 * the scene's grid at `fps`, `start` and `end` in seconds. The last one may be shorter.
 */
export function previewSegments(scene, { fps = PREVIEW_FPS } = {}) {
  const total = sceneFrameTimes(scene, fps).length;
  const per = Math.round(SEGMENT_SECONDS * fps);
  const segments = [];
  for (let first = 0, index = 0; first < total; first += per, index += 1) {
    const count = Math.min(per, total - first);
    segments.push({ index, start: first / fps, end: (first + count) / fps, first, count });
  }
  return segments;
}

// Whether the layer draws nothing at each of `times` by its own state: Hide/Show operations,
// media outside its Play range, or no opacity. Opacity is trusted only when every text unit
// fades at the same moment (no stagger).
function hiddenThroughout(layer, times) {
  const animations = Array.isArray(layer.animations) ? layer.animations : [];
  const perUnit = animations.some((animation) => Number(animation?.stagger) > 0 ||
    animation?.textAnchor != null || animation?.textClip != null || animation?.preset?.text);
  const constant = !animations.length && !(layer.playbackWindows?.length) && !layer.src;
  try {
    for (const time of constant ? times.slice(0, 1) : times) {
      const state = evaluateLayer(layer, time);
      const opacity = typeof state.opacity === "number" ? state.opacity : 1;
      if (state.visible !== false && (perUnit || !(opacity <= 0))) return false;
    }
    return true;
  } catch { return false; }
}

// hiddenThroughout's answers by the layer's JSON and the frames asked about, kept across calls:
// after an edit, only the layers it changed are evaluated again (a product trailer's 106 layers
// over 41 segments take about 1.5 s to evaluate, and a few ms to look up).
const HIDDEN_KEPT = 4000;
const hiddenAnswers = new Map();
function rememberedHidden() {
  const texts = new WeakMap();
  return (layer, times) => {
    if (!texts.has(layer)) texts.set(layer, JSON.stringify(layer));
    const text = texts.get(layer);
    let answers = hiddenAnswers.get(text);
    if (answers) hiddenAnswers.delete(text);
    else answers = new Map();
    hiddenAnswers.set(text, answers);
    if (hiddenAnswers.size > HIDDEN_KEPT) hiddenAnswers.delete(hiddenAnswers.keys().next().value);
    const frames = `${times.length}:${times[0]}:${times.at(-1)}`;
    if (!answers.has(frames)) answers.set(frames, hiddenThroughout(layer, times));
    return answers.get(frames);
  };
}

function walk(value, visit) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { visit(key, child); walk(child, visit); }
}

// A group that only moves, turns, scales or fades its children: each child draws on its own.
// Any other group (blur, shadow, mask, clip, blend, effects, fill...) may draw its children
// together, so all of them count with it.
function plainGroup(group) {
  if (group.blur || group.shadow || group.isMask || group.isMaskGroup || group.clipContent) return false;
  if ((group.blendMode ?? "normal") !== "normal" || group.fillEnabled || Number(group.strokeWidth) > 0) return false;
  if (group.playbackWindows?.length || animatesSpeed(group)) return false;
  let plain = true;
  walk(group.animations ?? [], (key, child) => {
    if (key === "effect" || key === "effectPreset" || key === "motionPath") plain = false;
    if ((key === "from" || key === "to") && child && typeof child === "object")
      for (const name of Object.keys(child)) if (!PLAIN_MOTION_KEYS.has(name)) plain = false;
  });
  return plain;
}

/**
 * The layers that may change the pixels of frames `times`, in the scene's order. A layer counts
 * when it may show at one of them, and then so do its parents, the layers it names by id, the
 * layers that name it (other than its children), the siblings between it and its mask (all of
 * them in a mask group), and
 * every descendant of a group that is not plain.
 */
export function segmentLayers(scene, times, { hidden = hiddenThroughout } = {}) {
  const layers = Array.isArray(scene.layers) ? scene.layers : [];
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const children = new Map();
  for (const layer of layers) {
    const key = byId.has(layer.parentId) ? layer.parentId : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(layer);
  }
  const ancestors = (layer) => {
    const chain = [];
    const seen = new Set([layer.id]);
    for (let parent = byId.get(layer.parentId); parent && !seen.has(parent.id); parent = byId.get(parent.parentId)) {
      seen.add(parent.id);
      chain.push(parent);
    }
    return chain;
  };
  // Ids each layer names (other than its own id and its parent), and the layers naming it.
  const names = new Map(layers.map((layer) => [layer.id, new Set()]));
  const namedBy = new Map(layers.map((layer) => [layer.id, new Set()]));
  for (const layer of layers) {
    walk(layer, (key, value) => {
      if (typeof value !== "string" || key === "id" || key === "parentId" || value === layer.id || !byId.has(value)) return;
      names.get(layer.id).add(value);
      namedBy.get(value).add(layer.id);
    });
  }
  const included = new Set();
  const queue = [];
  const add = (layer) => { if (layer && !included.has(layer.id)) { included.add(layer.id); queue.push(layer); } };
  for (const layer of layers) {
    // Segments are silent: a sound layer draws nothing (it still counts when another names it).
    if (layer.type === "audio") continue;
    // A parent with its own clock (Play windows, Speed) changes when its children show.
    const timed = ancestors(layer).some((parent) => parent.playbackWindows?.length || animatesSpeed(parent));
    if (timed || !hidden(layer, times)) add(layer);
  }
  const shown = new Set(included);
  // Outside a mask group, a mask masks the next sibling that is not hidden (engine/render.js
  // renderSiblings). A layer counts with the masks before it and a mask with the layers after it,
  // up to the nearest shown layer, and so does every layer between them: moving or removing one
  // changes which layer the mask masks.
  const maskSpan = (siblings, at) => {
    const span = [];
    const collect = (step) => {
      const part = [];
      for (let index = at + step; index >= 0 && index < siblings.length; index += step) {
        part.push(siblings[index]);
        if (!siblings[index].isMask && shown.has(siblings[index].id)) break;
      }
      if (part.some((sibling) => sibling.isMask) || (step > 0 && siblings[at].isMask)) span.push(...part);
    };
    collect(-1);
    if (siblings[at].isMask) collect(1);
    return span;
  };
  // Layers the scene's own settings name by id.
  const { layers: _layers, ...settings } = scene;
  walk(settings, (_key, value) => { if (typeof value === "string" && byId.has(value)) add(byId.get(value)); });
  const addTree = (layer) => { add(layer); for (const child of children.get(layer.id) ?? []) addTree(child); };
  while (queue.length) {
    const layer = queue.pop();
    ancestors(layer).forEach(add);
    for (const id of names.get(layer.id)) add(byId.get(id));
    for (const id of namedBy.get(layer.id)) add(byId.get(id));
    const parentKey = byId.has(layer.parentId) ? layer.parentId : null;
    const siblings = children.get(parentKey) ?? [];
    if (byId.get(parentKey)?.isMaskGroup) siblings.forEach(addTree);
    else if (siblings.some((sibling) => sibling.isMask)) maskSpan(siblings, siblings.indexOf(layer)).forEach(addTree);
    if (layer.type === "group" && !plainGroup(layer)) addTree(layer);
  }
  return layers.filter((layer) => included.has(layer.id));
}

/** How heavy layers are to draw live: one a layer, more for blur and video (the slowest to play). */
export function segmentWeight(layers) {
  let weight = 0;
  for (const layer of layers) weight += 1 + (Number(layer.blur) > 0 || layer.animations?.some((animation) => animation?.to?.blur > 0) ? 4 : 0) + (layer.type === "video" ? 8 : 0);
  return weight;
}

function keyInputs(scene, segment, { size, fps, hidden }) {
  const times = sceneFrameTimes(scene, fps).slice(segment.first, segment.first + segment.count);
  const { layers: _layers, name: _name, ...settings } = scene;
  return {
    scene: { ...settings, layers: segmentLayers(scene, times, { hidden }) },
    options: { kinoPreview: KEY_VERSION, format: "mp4", fps, width: size.width, height: size.height,
      first: segment.first, count: segment.count },
  };
}

/**
 * Each segment with its key and weight: [{index, start, end, first, count, weight, key}]. The
 * weight guesses how slow it is to draw live (segmentWeight), so the heaviest render first.
 * `scene` is the scene as the export draws it (components expanded). `fonts`, `mediaRoot` and
 * `graphics` are as for renderContentKey; `size` defaults to previewSize(scene).
 */
export async function previewSegmentKeys(scene, { size = previewSize(scene), fps = PREVIEW_FPS, fonts, mediaRoot, graphics, scope = "kino-preview" } = {}) {
  const result = [];
  const hidden = rememberedHidden();
  for (const segment of previewSegments(scene, { fps })) {
    const { scene: keyScene, options } = keyInputs(scene, segment, { size, fps, hidden });
    result.push({ ...segment, weight: segmentWeight(keyScene.layers), key: await renderContentKey(keyScene, options, { fonts, mediaRoot, graphics, scope }) });
  }
  return result;
}

/** The preview cache: segment videos under <data>/preview-cache, oldest used removed first. */
export function createPreviewCache({ dataDirectory, directory = join(dataDirectory, "preview-cache"), maxBytes = PREVIEW_CACHE_BYTES } = {}) {
  return createSegmentCache({ directory, maxBytes });
}

/**
 * Draws one segment (from previewSegmentKeys) at the draft size as silent H.264 and keeps it in
 * `cache` under its key. A segment already there is not drawn again. Returns
 * {key, path, bytes, cached}: `path` is the cached file, for as long as the cache keeps it.
 * `render` is the dashboard's machine settings, as for exportScene. `projectId` is kept with the
 * file, so the segments of a deleted project can be removed (preview-scheduler.mjs prune).
 */
export async function renderPreviewSegment(scene, segment, { cache, size = previewSize(scene), fps = PREVIEW_FPS, fonts, mediaRoot, render, signal, projectId } = {}) {
  if (!cache) throw new TypeError("A preview cache is required.");
  if (!segment?.key) throw new TypeError("The segment needs its key (previewSegmentKeys).");
  const found = await cache.locate(segment.key);
  if (found) return { key: segment.key, path: found.path, bytes: found.size, cached: true };
  const folder = await makeTempFolder("kino-preview-");
  try {
    const file = join(folder, "segment.mp4");
    await exportScene(scene, { format: "mp4", fps, width: size.width, height: size.height, videoQuality: PREVIEW_QUALITY }, {
      mediaRoot, fonts, signal, render, outputPath: file, silent: true, frameRange: { first: segment.first, count: segment.count },
      // Playback shows the motion-blur preview, as live drawing does (previewBlur.js).
      previewBlur: true,
    });
    await cache.store(segment.key, file, { start: segment.start, end: segment.end, width: size.width, height: size.height, fps, ...(projectId ? { projectId } : {}) }, { signal });
  } finally { await removeTempFolder(folder); }
  const stored = await cache.locate(segment.key);
  if (!stored) throw new Error("The preview cache did not keep the segment (larger than its size limit?).");
  return { key: segment.key, path: stored.path, bytes: stored.size, cached: false };
}
