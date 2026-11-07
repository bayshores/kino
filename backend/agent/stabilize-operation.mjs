// stabilize {sceneId, layerId, smooth?, zoom?} for the agent service: steadies a shaky video layer
// on this computer (backend/cutout/stabilize.mjs: Apple Vision measures the camera's motion, Core
// Image moves each frame, one fixed zoom hides the edges), adds the steadied copy to the media
// library and points the layer at it with replace_media, so its place, timing and animations stay.
// The receipt gives the new src, the zoom and the background's frame-to-frame jerk before and
// after (measured, px at 1080p). When the copy's worst jerk is above the file's own, the layer
// keeps its file and the receipt says kept:"original".
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "../../engine/model.js";
import { applyOperations } from "../../engine/operations.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";

/** Runs one stabilize op on `document` and returns the new document. */
export async function runStabilize(document, operation, { mediaRoot, cutoutMedia, operationContext, reports, signal }) {
  const { sceneId, layerId } = operation;
  const scene = document.scenes.find((item) => item.id === sceneId);
  const layer = scene?.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`No layer "${layerId}" in this scene.`);
  if (layer.type !== "video") throw new Error(`stabilize steadies a video layer; "${layer.name}" is a ${layer.type} layer.`);
  if (!cutoutMedia?.stabilize) throw new Error("stabilize is not set up in this kino service.");
  const id = mediaIdFromSource(layer.src);
  const file = id && mediaRoot ? path.join(mediaRoot, id) : null;
  if (!file || !existsSync(file)) throw new Error(`"${layer.name}" is not in kino's media library; import the file with project {action:"import", file} and use its src.`);
  let record = {};
  try { record = JSON.parse(await readFile(`${file}.json`, "utf8")); } catch { /* the name falls back to the layer's */ }
  const made = await cutoutMedia.stabilize({ file, name: typeof record.name === "string" ? record.name : layer.name, smooth: operation.smooth, zoom: operation.zoom, signal });
  const { zoom, seconds } = made.info;
  const jerk = { before: { mean: made.info.jerk.before.mean, worst: made.info.jerk.before.worst }, after: { mean: made.info.jerk.after.mean, worst: made.info.jerk.after.worst } };
  if (!made.record) {
    reports?.set(operation, { kept: "original", jerk, seconds, note: `the steadied copy's worst jerk (${jerk.after.worst} px at ${made.info.jerk.after.at} s of the file) is above the file's own (${jerk.before.worst} px), so "${layer.name}" keeps its file; try another smooth or zoom` });
    return document;
  }
  const steps = [{ type: "replace_media", sceneId, layerId, mediaId: made.record.id }];
  const next = parseDocument(applyOperations(document, steps, await operationContext(document, steps)));
  reports?.set(operation, { src: made.record.src, zoom, jerk, seconds, cached: made.cached,
    ...(made.info.shrunk > 0.2 ? { note: `the shake was too big to remove fully in ${Math.round(made.info.shrunk * 100)}% of frames at this zoom; a larger zoom (up to 1.15) steadies more` } : {}) });
  return next;
}
