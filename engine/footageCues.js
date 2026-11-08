// Footage cues: a cue pinned to a clip, {name, layer, media, time}, where media is seconds into
// the clip's own file. Its time (scene seconds) is worked out again from the clip's mediaStart,
// mediaOffset, mediaSpeed and mediaReverse each time the document is read, so "cue:x" stays on
// the same moment of the footage after the clip is trimmed, moved or sped up.
// A clip whose speed is animated has no simple answer and is refused.
import { animatesSpeed } from "./animation.js";
import { effectiveMediaDuration } from "./playback.js";
import { constantSpeed, isReversed } from "./mediaTime.js";

export const FOOTAGE_CUE_TYPES = Object.freeze(["video", "audio"]);

function findClip(document, layerId) {
  for (const scene of document?.scenes ?? []) {
    const layer = (scene.layers ?? []).find((item) => item.id === layerId);
    if (layer) return { scene, layer };
  }
  return null;
}

/**
 * Where a clip plays `media` seconds of its file: {time, shown, scene, layer}. time is scene
 * seconds, not rounded or clamped; past either end of Play the same line goes on, so a moment
 * trimmed off the head lands before mediaStart. shown is false when Play never shows it.
 * Throws a plain message for a missing layer, a layer without footage or an animated speed.
 */
export function footageCueTime(document, layerId, media) {
  const found = findClip(document, layerId);
  if (!found) throw new Error(`No layer ${layerId} for a footage cue.`);
  const { scene, layer } = found;
  if (!FOOTAGE_CUE_TYPES.includes(layer.type)) throw new Error(`${layer.name ?? layerId} is a ${layer.type} layer; a footage cue needs a video or audio layer.`);
  if (animatesSpeed(layer))
    throw new Error(`${layer.name ?? layerId} has a Speed animation, so its footage has no steady scene time; give the cue a scene time (at) or remove the Speed animation.`);
  const speed = constantSpeed(layer);
  const along = media - Math.max(0, layer.mediaOffset ?? 0);
  const duration = effectiveMediaDuration(layer);
  let local = along / speed;
  if (isReversed(layer)) {
    if (!Number.isFinite(duration)) throw new Error(`${layer.name ?? layerId} plays backwards without a known end; set mediaDuration first.`);
    local = duration - along / speed;
  }
  const time = (layer.mediaStart ?? 0) + local;
  const shown = local >= -1e-9 && local <= duration + 1e-9 && time <= scene.duration + 1e-9;
  return { time, shown, scene, layer };
}
