// track {sceneId, layerId, at, point | box, name?} and pin {sceneId, layerId, to, offset?, scale?}
// for the agent service.
//
// track follows an object through a video layer's file (backend/cutout/track.mjs, Apple Vision):
// point or box is where it is at file second `at`, in % of the source frame (as look
// {mode:"source"} and mark_subject use). It runs forward from `at` to the end of the part of the
// file the layer plays, and backward to its start. The file-space boxes are then placed on the
// scene through the layer's position, size, crop and media offset (sourceView.js subjectOnScene),
// one sample a frame of the scene, and kept as scene.tracks [{name, layerId, src, at, samples}]
// (pin.js). A track made again under the same name replaces it, and every pin on it follows the
// new one.
//
// pin makes any layer follow a track: layer.pin holds the track's path with low-confidence frames
// held at the last good place (pin.js), and evaluateLayer moves the layer there, so the preview,
// look and exports draw it alike. pin {to: null} lets go.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "../../engine/model.js";
import { mediaFrameState, mediaPlaybackRange } from "../../engine/playback.js";
import { holdLowFrames, LOW_CONFIDENCE, lowRuns, MAX_PIN_SAMPLES, MAX_TRACKS } from "../../engine/pin.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";
import { subjectOnScene } from "../../engine/sourceView.js";
import { probeVideo } from "../cutout/cutout.mjs";
import { makeTrack } from "../cutout/track.mjs";

const POINT_BOX = 8; // a point tracks the 8% square around it
const round = (value, places = 1) => Number(value.toFixed(places));

function sceneOf(document, sceneId) {
  return document.scenes.find((item) => item.id === sceneId) ?? (() => { throw new Error(`No scene "${sceneId}".`); })();
}

function layerOf(scene, layerId) {
  return scene.layers.find((item) => item.id === layerId) ?? (() => { throw new Error(`No layer "${layerId}" in this scene.`); })();
}

/** The file box at file second `time`: straight between the track's frames. */
function fileBoxAt(frames, time) {
  if (time <= frames[0][0]) return frames[0];
  const last = frames[frames.length - 1];
  if (time >= last[0]) return last;
  let index = frames.findIndex((frame) => frame[0] > time);
  const a = frames[index - 1], b = frames[index];
  const share = (time - a[0]) / (b[0] - a[0]);
  return a.map((value, at) => value + (b[at] - value) * share);
}

/** pin's copy of a track: its samples with low frames held, and the object's size at the track's start. */
function pinOf(track, { offset = [0, 0], scale = false } = {}) {
  const atFrame = track.samples.reduce((best, sample) => (Math.abs(sample[0] - track.atScene) < Math.abs(best[0] - track.atScene) ? sample : best), track.samples[0]);
  return { track: track.name, offset, scale, base: [atFrame[3], atFrame[4]], path: holdLowFrames(track.samples) };
}

/**
 * Runs one track op on `document` and returns the new document. Options: mediaRoot, cacheDir
 * (where tracks are kept), reports (the edit's report Map: adds `track`), signal.
 */
export async function runTrack(document, operation, { mediaRoot, cacheDir, reports, signal }) {
  const next = structuredClone(document);
  const scene = sceneOf(next, operation.sceneId);
  const layer = layerOf(scene, operation.layerId);
  if (layer.type !== "video") throw new Error(`track follows an object in a video layer; "${layer.name}" is a ${layer.type} layer.`);
  const id = mediaIdFromSource(layer.src);
  const file = id && mediaRoot ? path.join(mediaRoot, id) : null;
  if (!file || !existsSync(file)) throw new Error(`"${layer.name}" is not in kino's media library; import the file with project {action:"import", file} and use its src.`);
  let record = {};
  try { record = JSON.parse(await readFile(`${file}.json`, "utf8")); } catch { /* probe below */ }
  const size = record.width > 0 && record.height > 0 ? { width: record.width, height: record.height } : await probeVideo(file, signal);
  if (Math.max(size.width, size.height) > 2048) throw new Error(`"${layer.name}" is ${size.width}x${size.height}; track reads files up to 2048 px (no 4K decoding). Import a 1080p copy and use it.`);

  const range = mediaPlaybackRange(layer, scene.duration);
  if (!range) throw new Error(`"${layer.name}" does not play in this scene, so there is nothing to track.`);
  const sourceAt = (t) => mediaFrameState(layer, t).sourceTime;
  const ends = [sourceAt(range.start), sourceAt(range.end)];
  const from = Math.max(0, Math.min(...ends)), to = Math.max(...ends);
  const at = operation.at;
  if (!(at >= from - 0.05 && at <= to + 0.05))
    throw new Error(`at is a second of the file; "${layer.name}" plays file seconds ${round(from, 2)} to ${round(to, 2)} in this scene, so at must be in that range.`);
  let box = operation.box;
  if (!box) {
    const [px, py] = operation.point;
    box = [Math.max(0, px - POINT_BOX / 2), Math.max(0, py - POINT_BOX / 2), POINT_BOX, POINT_BOX];
    box[2] = Math.min(box[2], 100 - box[0]); box[3] = Math.min(box[3], 100 - box[1]);
  }
  const made = await makeTrack({ source: file, cacheDir, at: Math.min(Math.max(at, from), to), from, to: Math.max(to, from + 0.05), box: box.map((value) => value / 100), signal });
  const { frames, fps } = made.info;

  // One sample a frame of the scene while the layer plays, placed on the scene.
  const samples = [];
  const step = 1 / fps;
  const count = Math.min(MAX_PIN_SAMPLES, Math.floor((range.end - range.start) / step) + 1);
  for (let index = 0; index < count; index += 1) {
    const t = range.start + index * step;
    const [, x, y, w, h, c] = fileBoxAt(frames, sourceAt(t));
    const placed = subjectOnScene(scene, layer, t, [x * 100, y * 100, w * 100, h * 100], size);
    if (!placed) continue;
    samples.push([round(t, 3), round((placed.x0 + placed.x1) / 2), round((placed.y0 + placed.y1) / 2), round(placed.x1 - placed.x0), round(placed.y1 - placed.y0), round(c, 2)]);
  }
  if (!samples.length) throw new Error(`"${layer.name}" has no size on the scene, so the track has nowhere to go.`);
  const name = operation.name ?? `${layer.name} track`;
  // The scene time where the file shows `at` (the box the agent gave): the size pin scales from.
  const atScene = samples.reduce((best, sample) => (Math.abs(sourceAt(sample[0]) - at) < Math.abs(sourceAt(best[0]) - at) ? sample : best), samples[0])[0];
  const track = { name, layerId: layer.id, src: layer.src, at, atScene, samples };
  const others = (scene.tracks ?? []).filter((item) => item.name !== name);
  if (others.length >= MAX_TRACKS) throw new Error(`A scene keeps at most ${MAX_TRACKS} tracks; make one again under an old name to replace it.`);
  scene.tracks = [...others, track];
  const pinned = [];
  for (const item of scene.layers) if (item.pin?.track === name) {
    item.pin = { ...pinOf(track, item.pin), offset: item.pin.offset, scale: item.pin.scale };
    pinned.push(item.name);
  }
  const low = lowRuns(samples, 0.3).map((run) => `${round(run.start, 2)}-${round(run.end, 2)} s`);
  const confidence = samples.reduce((sum, sample) => sum + sample[5], 0) / samples.length;
  reports?.set(operation, { track: name, frames: samples.length, fps, seconds: made.info.seconds, cached: made.cached, confidence: round(confidence, 2),
    ...(pinned.length ? { pinned } : {}),
    ...(low.length ? { note: `confidence under ${LOW_CONFIDENCE} at ${low.join(", ")}: a pin holds its last good place there; track again from a clearer frame (at) or a box on more texture` } : {}) });
  return parseDocument(next);
}

/** Runs one pin op on `document` and returns the new document. */
export function runPin(document, operation, { reports } = {}) {
  const next = structuredClone(document);
  const scene = sceneOf(next, operation.sceneId);
  const layer = layerOf(scene, operation.layerId);
  if (operation.to === null) {
    delete layer.pin;
    reports?.set(operation, { unpinned: layer.name });
    return parseDocument(next);
  }
  const track = (scene.tracks ?? []).find((item) => item.name === operation.to);
  if (!track) {
    const names = (scene.tracks ?? []).map((item) => `"${item.name}"`);
    throw new Error(`No track "${operation.to}" in this scene${names.length ? `; its tracks are ${names.join(", ")}` : "; make one first with track {layer, at, point}"}.`);
  }
  if (layer.id === track.layerId) throw new Error("A layer cannot be pinned to a track of itself.");
  if (layer.parentId) throw new Error(`"${layer.name}" is inside a group; pin a layer at the top of the scene (or the group itself).`);
  layer.pin = pinOf(track, { offset: operation.offset ?? [0, 0], scale: operation.scale === true });
  const low = lowRuns(track.samples, 0.3).map((run) => `${round(run.start, 2)}-${round(run.end, 2)} s`);
  reports?.set(operation, { pinned: layer.name, track: track.name, ...(low.length ? { note: `the track is unsure at ${low.join(", ")}; the layer holds still there (check track_lost)` } : {}) });
  return parseDocument(next);
}
