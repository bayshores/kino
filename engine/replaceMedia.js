// Replacement changes the source of an existing layer. It never creates a new layer,
// so animations, component paths and comment anchors keep pointing at the same ID.
import { overridableKeys, resolveComponentPath, withReplacementSource } from "./componentOverrides.js";
import { replacementPlayFields } from "./mediaPlay.js";
import { parseMediaSource } from "./mediaSource.js";

const VISUAL_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"]);
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg", "audio/webm"]);
export const MEDIA_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]+$/i;

function isMediaLayer(layer) {
  return ["image", "video", "audio"].includes(layer?.type);
}

export function mediaIdFromSource(src) {
  const id = parseMediaSource(src)?.id;
  return MEDIA_ID_PATTERN.test(id) ? id : null;
}

// The override schema supports image sources, but cannot keep an instance's image
// when its master becomes video. Check paths against the current document before
// normalization can drop them, including paths stored on nested and Bulk instances.
export function assertReplacementKeepsOverrides(document, layer, replacement) {
  if (layer.type === replacement.type || overridableKeys(replacement).includes("src")) return;
  const scenesById = new Map(document.scenes.map((scene) => [scene.id, scene]));
  const index = new Map();
  for (const scene of document.scenes) for (const instance of scene.layers) {
    if (instance.type !== "component") continue;
    for (const [path, entry] of Object.entries(instance.componentOverrides ?? {})) {
      if (!Object.hasOwn(entry, "src")) continue;
      if (resolveComponentPath(instance, scenesById, path, index)?.layer === layer)
        throw new Error("Media wasn't replaced: an instance has an image source override on this layer. Keep an image/GIF source, or reset or detach the customized instances before changing the main component to video.");
    }
  }
}

/** The validated layer, ready to commit, from an uploaded record (never a caller's URL). */
export function layerWithReplacementMedia(layer, media, { previousMedia, sceneDuration } = {}) {
  if (!isMediaLayer(layer)) throw new Error("Replace Media needs an image, video, or audio media layer.");
  if (!media || !MEDIA_ID_PATTERN.test(media.id) || media.src !== `/api/media/${media.id}`)
    throw new Error("The uploaded media was not found. Use an existing local media ID.");
  if (media.measurementSucceeded === false)
    throw new Error("The uploaded media could not be decoded. Choose a readable media file.");
  const audio = AUDIO_MIMES.has(media.mime), visual = VISUAL_MIMES.has(media.mime);
  if ((layer.type === "audio" && !audio) || (layer.type !== "audio" && !visual))
    throw new Error("Audio can only replace audio; image, GIF and video can replace each other.");
  const type = audio ? "audio" : media.mime.startsWith("video/") ? "video" : "image";
  const next = withReplacementSource(layer, media.src);
  next.type = type;
  // Subject boxes (mark_subject) belong to a video's frames; a video keeps them, tied to the old file.
  if (type !== "video") { delete next.subjectBoxes; delete next.askShows; }
  // log follows the new file: its import found it log footage or not (a still never is).
  if (type === "video" && media.log) next.log = media.log;
  else delete next.log;
  const sourceId = mediaIdFromSource(layer.src);
  if (sourceId && sourceId === mediaIdFromSource(previousMedia?.src) &&
      layer.name === previousMedia.name && typeof media.name === "string")
    next.name = media.name;
  Object.assign(next, replacementPlayFields(layer, {
    type, sourceDuration: media.duration, animated: media.animated === true || Number(media.frameCount) > 1, sceneDuration,
  }));
  return next;
}
