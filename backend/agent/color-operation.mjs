// match_color {sceneId, layerId | layerIds, toId, at?} for the agent service: grades footage so its
// color matches a reference shot (engine/effects/colorMatch.js).
//
// Each layer (video or image) is sampled at 3 moments of its shown span, the reference at `at`
// (scene seconds) or 3 moments of its own span. Frames come from the files, at most 96 pixels
// wide, decoded one FFmpeg at a time; a file over 2048 pixels on its long side is refused (kino
// never decodes 4K: import a 1080p copy). The grade is two ordinary effects on the layer, named
// "Color match" (color-wheels) and "Color match saturation" (hue-saturation); running match_color
// again on a layer replaces them. The match reads the files' own pixels, so another grade already
// on the layer or the reference is not counted.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { framePixels, matchParameters, MATCH_WIDTH, solveMatch } from "../../engine/effects/colorMatch.js";
import { parseDocument } from "../../engine/model.js";
import { applyOperations } from "../../engine/operations.js";
import { mediaFrameState, mediaPlaybackRange } from "../../engine/playback.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";
import { ffmpegCommand } from "../media-probe.mjs";
import { ffmpegArgs, lowerIfBackground } from "../render-activity.mjs";

export const MATCH_NAMES = Object.freeze({ wheels: "Color match", saturation: "Color match saturation" });
const MAX_SIDE = 2048;
const MAX_LAYERS = 12;
const round2 = (value) => Math.round(value * 100) / 100;

/** One frame of a video file at `seconds`, `width` × `height` RGBA bytes (FFmpeg, area scaling). */
function videoFrame(file, seconds, width, height) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-ss", String(Math.max(0, round2(seconds))), "-i", file, "-map", "0:V:0", "-an", "-sn", "-dn",
      "-vf", `scale=${width}:${height}:flags=area,format=rgba`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"];
    const child = spawn(ffmpegCommand(), ffmpegArgs(args), { stdio: ["ignore", "pipe", "pipe"] });
    lowerIfBackground(child);
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-500); });
    child.once("error", reject);
    child.once("close", (code) => {
      const data = Buffer.concat(chunks);
      if (code === 0 && data.length >= width * height * 4) resolve({ width, height, data: new Uint8Array(data.buffer, data.byteOffset, width * height * 4) });
      else reject(new Error(`FFmpeg could not read a frame: ${stderr.trim().split("\n").at(-1) || `exit ${code}`}`));
    });
  });
}

async function imageFrame(file) {
  const image = await loadImage(await readFile(file));
  const width = Math.min(MATCH_WIDTH, image.width), height = Math.max(1, Math.round((image.height * width) / image.width));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return { width, height, data: canvas.getContext("2d").getImageData(0, 0, width, height).data };
}

/** The scene times to sample a layer at: `at`, or 3 moments inside its shown span. */
function sampleTimes(scene, layer, at) {
  if (at !== undefined) return [at];
  const range = layer.type === "video" ? mediaPlaybackRange(layer, scene.duration) : null;
  const start = range?.start ?? 0, end = range?.end ?? scene.duration;
  return [0.2, 0.5, 0.8].map((fraction) => start + (end - start) * fraction);
}

/** Small frames of a layer's file at scene times `times` (video) or its one picture (image). */
async function layerFrames(layer, times, mediaRoot) {
  if (layer.type !== "video" && layer.type !== "image")
    throw new Error(`match_color grades video and image layers; "${layer.name}" is a ${layer.type} layer.`);
  const id = mediaIdFromSource(layer.src);
  const file = id && mediaRoot ? path.join(mediaRoot, id) : null;
  if (!file || !existsSync(file)) throw new Error(`"${layer.name}" is not in kino's media library; import the file with project {action:"import", file} and use its src.`);
  let record = {};
  try { record = JSON.parse(await readFile(`${file}.json`, "utf8")); } catch { /* sizes from the layer */ }
  const fileWidth = Number(record.width) || layer.width, fileHeight = Number(record.height) || layer.height;
  if (Math.max(fileWidth, fileHeight) > MAX_SIDE)
    throw new Error(`"${layer.name}" is ${fileWidth}×${fileHeight}; match_color reads files up to ${MAX_SIDE} px (no 4K decoding). Import a 1080p copy and use it.`);
  if (layer.type === "image") return [await imageFrame(file)];
  const width = Math.min(MATCH_WIDTH, fileWidth), height = Math.max(2, Math.round((fileHeight * width) / fileWidth / 2) * 2);
  const frames = [];
  // One FFmpeg at a time. A time past the file's end (a clip shorter than the scene) reads its last
  // known moment, or its first frame when the length is unknown.
  const length = Number(record.duration) || Number(layer.mediaSourceDuration) || 0;
  for (const time of times) {
    const at = mediaFrameState(layer, time).sourceTime;
    const seconds = length > 0 ? Math.min(at, Math.max(0, length - 0.1)) : at;
    frames.push(await videoFrame(file, seconds, width, height).catch((error) => (seconds > 0 ? videoFrame(file, 0, width, height) : Promise.reject(error))));
  }
  return frames;
}

/**
 * Runs one match_color on `document` and returns the new document. Options: mediaRoot,
 * operationContext (as for applyOperations), reports (the edit's report Map: adds `color`),
 * frames (tests: a stand-in for layerFrames).
 */
export async function runMatchColor(document, operation, { mediaRoot, operationContext, reports, frames = layerFrames }) {
  const { sceneId, toId } = operation;
  const scene = document.scenes.find((item) => item.id === sceneId);
  const ids = [...new Set([...(operation.layerIds ?? []), ...(operation.layerId ? [operation.layerId] : [])])];
  if (!ids.length) throw new Error("match_color needs layer or layers: the footage to grade.");
  if (ids.length > MAX_LAYERS) throw new Error(`match_color grades at most ${MAX_LAYERS} layers at once.`);
  if (ids.includes(toId)) throw new Error("match_color: to is the reference shot; leave it out of layers.");
  const find = (id) => scene?.layers.find((item) => item.id === id) ?? (() => { throw new Error(`No layer "${id}" in this scene.`); })();
  const reference = find(toId);
  const target = framePixels(await frames(reference, sampleTimes(scene, reference, operation.at), mediaRoot));
  if (!target.length) throw new Error(`"${reference.name}" has no visible pixels to match.`);
  const steps = [], report = [];
  for (const id of ids) {
    const layer = find(id);
    const shot = framePixels(await frames(layer, sampleTimes(scene, layer, undefined), mediaRoot));
    if (!shot.length) throw new Error(`"${layer.name}" has no visible pixels to match.`);
    const { x, before, after } = solveMatch(shot, target);
    const { wheels, saturation } = matchParameters(x);
    // An earlier match on the layer is replaced.
    for (const animation of layer.animations ?? [])
      if (Object.values(MATCH_NAMES).includes(animation.name)) steps.push({ type: "delete_animation", sceneId, layerId: id, animationId: animation.id });
    const add = (key, effect, parameters) => {
      const animationId = `${id}-${key === "wheels" ? "color-match" : "color-match-saturation"}-${randomUUID().slice(0, 8)}`;
      steps.push({ type: "add_animation", sceneId, layerId: id, id: animationId, effect, parameters },
        { type: "rename_animation", sceneId, layerId: id, animationId, name: MATCH_NAMES[key] });
    };
    add("wheels", "color-wheels", wheels);
    if (Math.abs(saturation - 1) >= 0.01) add("saturation", "hue-saturation", { saturation });
    report.push({ layer: layer.name, wheels, saturation, distance: [round2(before * 100), round2(after * 100)] });
  }
  const next = parseDocument(applyOperations(document, steps, await operationContext(document, steps)));
  reports?.set(operation, { to: reference.name, layers: report, summary: report.map((entry) => `${entry.layer} matched to ${reference.name}: color distance ${entry.distance[0]} → ${entry.distance[1]}`).join("; ") });
  return next;
}
