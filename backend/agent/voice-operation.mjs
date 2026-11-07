// isolate_voice {sceneId, layerId, keep?, engine?, amount?} for the agent service: splits the sound
// of an audio or video layer into voice and background on this computer (backend/voice), adds the
// result to the media library (backend/voice/media.mjs), and points the layer at it.
//
// The layer keeps its ID, name, animations, Play settings and volume: the engine's replace_media
// swaps its src. A video keeps its picture; only its file's sound track is different, so its sound
// still stops while the video is hidden, as before. keep "both" also adds an audio layer that plays
// the background with the same Play settings, volume and volume animations, right above the layer
// in the same group. Saving, history undo, exports and the dashboard mix need nothing new: they
// read the layer's src like any imported file.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { flattenAnimations } from "../../engine/animationTree.js";
import { aliasClipLinks } from "../../engine/clipSync.js";
import { parseDocument } from "../../engine/model.js";
import { applyOperations } from "../../engine/operations.js";
import { mediaPlaybackRange } from "../../engine/playback.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";
import { hiddenSpans } from "../../engine/videoSound.js";

// An animation that changes only the volume (a fade, a duck dip): the background layer gets a copy.
function volumeOnly(animation) {
  return ["in", "out", "custom"].includes(animation?.kind) && [animation.from, animation.to].every((end) =>
    end && typeof end === "object" && Object.keys(end).length > 0 && Object.keys(end).every((key) => key === "volume"));
}

// What to do when an engine can't run: the plain next step for each voice error code.
async function nextStep(error, { engine, voiceMedia }) {
  const engines = await voiceMedia.engines().catch(() => []);
  const usable = (entry) => entry.available && (entry.engine !== "dpdfnet" || entry.modelDownloaded || voiceMedia.downloads);
  const auto = engines.find(usable)?.engine ?? "rnnoise";
  const offline = engines.find((entry) => entry.engine !== "dpdfnet" && entry.available)?.engine ?? "rnnoise";
  if (error.code === "VOICE_MODEL_UNAVAILABLE") {
    const how = voiceMedia.downloads
      ? "connect to the internet so kino can download the DPDFNet model once (10.6 MB)"
      : "start kino without KINO_VOICE_DOWNLOAD=0 so it can download the DPDFNet model once (10.6 MB), or put dpdfnet2_48khz_hr.onnx in the data folder's models folder";
    return `Send engine:"${offline}" (engine:"auto" uses ${offline} here until the model is on this computer), or ${how}.`;
  }
  if (error.code === "VOICE_ENGINE_UNAVAILABLE") return `Send engine:"auto" (it uses ${auto} on this computer) or engine:"rnnoise", which works everywhere.`;
  if (error.code === "VOICE_ENGINE_FAILED") return engine === "rnnoise" ? "Check that FFmpeg works (kino status shows the media tools)." : `Send engine:"rnnoise", which works offline on every computer.`;
  if (error.code === "VOICE_NO_SOUND") return "Pick an audio or video layer whose file has sound.";
  return null;
}

/**
 * Runs one isolate_voice operation on `document` (as the operations before it in the edit left
 * it) and returns the new document. Options: mediaRoot, voiceMedia (createVoiceMedia),
 * operationContext (as for applyOperations), reports (the edit's report Map: this adds the
 * receipt's `voice`). Refusals are thrown as errors; a voice error says what to send instead and
 * carries the engine's code as `voiceError`.
 */
export async function runIsolateVoice(document, operation, { mediaRoot, voiceMedia, operationContext, reports }) {
  const { sceneId, layerId } = operation;
  const keep = operation.keep ?? "voice", engine = operation.engine ?? "auto", amount = operation.amount ?? 1;
  const scene = document.scenes.find((item) => item.id === sceneId);
  const layer = scene?.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`No layer "${layerId}" in this scene.`);
  if (layer.type !== "audio" && layer.type !== "video")
    throw new Error(`isolate_voice splits the sound of an audio or video layer, and "${layer.name}" is a ${layer.type} layer.`);
  if (!voiceMedia) throw new Error("voice isolation is not set up in this kino service.");
  const id = mediaIdFromSource(layer.src);
  const file = id && mediaRoot ? path.join(mediaRoot, id) : null;
  if (!file || !existsSync(file))
    throw new Error("the layer's sound is not in kino's media library; import the file with project {action:\"import\", file} and use its src.");
  // The library record names the file and its type; one that can't be read falls back to the
  // layer's name and the file's extension.
  let record = {};
  try { record = JSON.parse(await readFile(`${file}.json`, "utf8")); } catch {}
  if (typeof record.mime !== "string") record.mime = layer.type === "video" ? (id.endsWith(".webm") ? "video/webm" : "video/mp4") : "audio/mp4";
  if (typeof record.name !== "string") record.name = layer.name;
  // Only MP4 and WebM videos can be imported; anything else would lose its picture here.
  if (layer.type === "video" && !["video/mp4", "video/webm"].includes(record.mime))
    throw new Error(`isolate_voice keeps a video's picture in an MP4 or WebM file, and "${layer.name}" is ${record.mime}.`);

  let made;
  try {
    made = await voiceMedia.make({ file, name: record.name, mime: record.mime, keep, engine, amount });
  } catch (error) {
    // The engine's own advice assumes downloads are on, and its file names are library IDs, so
    // the reason is said again here with the next step that fits this computer.
    const said = error.code === "VOICE_NO_SOUND" ? `"${layer.name}" has no sound to split.`
      : error.code === "VOICE_MODEL_UNAVAILABLE" ? `${error.message.split(" Connect to the internet")[0].replace(/\.?$/, ".")}`
        : error.message;
    const next = await nextStep(error, { engine, voiceMedia });
    throw Object.assign(new Error(next ? `${said} ${next}` : said), error.code ? { voiceError: error.code } : {});
  }

  const notes = made.note ? [made.note] : [];
  const kept = keep === "background" ? made.background : made.voice;
  let next = parseDocument(applyOperations(document, [{ type: "replace_media", sceneId, layerId, mediaId: kept.id }],
    await operationContext(document, [{ type: "replace_media", sceneId, layerId, mediaId: kept.id }])));
  // The new files keep the original's timing, so they keep its sync links (out_of_sync).
  const keptSrc = next.scenes.find((item) => item.id === sceneId)?.layers.find((item) => item.id === layerId)?.src;
  aliasClipLinks(next, layer.src, keptSrc);
  if (keep === "both") aliasClipLinks(next, layer.src, made.background.src);

  if (keep === "both") {
    const background = {
      type: "add_layer", sceneId, layerType: "audio",
      properties: {
        id: operation.backgroundId ?? randomUUID(), name: operation.backgroundName ?? `${layer.name}-background`,
        src: made.background.src, mediaSourceDuration: made.background.duration ?? 0,
        mediaStart: layer.mediaStart ?? 0, mediaDuration: layer.mediaDuration ?? 0, mediaOffset: layer.mediaOffset ?? 0,
        volume: layer.volume ?? 1,
        ...(layer.playbackWindows?.length ? { playbackWindows: structuredClone(layer.playbackWindows) } : {}),
        animations: flattenAnimations(layer.animations).filter(volumeOnly).map(({ id: _old, ...animation }) => ({ ...structuredClone(animation), id: randomUUID() })),
      },
    };
    next = parseDocument(applyOperations(next, [background], await operationContext(next, [background])));
    // Right above the layer, in its group. A group that moves on screen refuses new layers; the
    // background then stays at the top of the scene, which sounds the same.
    const move = { type: "move_layers", sceneId, layerIds: [background.properties.id], position: "above", referenceId: layerId };
    try { next = parseDocument(applyOperations(next, [move], await operationContext(next, [move]))); }
    catch (error) { notes.push(`${background.properties.name} is at the top of the scene, not beside ${layer.name} (${error.message})`); }
    // An audio layer has no Hide and Show, so it plays where a hidden video would be silent.
    if (layer.type === "video") {
      const range = mediaPlaybackRange(layer, scene.duration);
      if (range && hiddenSpans(scene.layers, layer, range.start, range.end).length)
        notes.push(`${layer.name} is hidden for part of its Play range; ${background.properties.name} plays through it (audio layers have no Hide/Show)`);
    }
  }
  reports?.set(operation, { engine: made.engine, seconds: Math.round(made.seconds * 10) / 10, cached: made.cached, keep,
    ...(notes.length ? { note: notes.join("; ") } : {}) });
  return next;
}
