import { layoutText, textUnits } from "./textLayout.js";
import { isVisibilityOperation } from "./visibilityOps.js";
import { enabledAnimations } from "./animationEnabled.js";
import { isTextChange, textChangeLength } from "./textChange.js";
import { counterPlaybackLength, isCounter } from "./counter.js";
import { applyComponentOverrides, hasOverrides, mergeOverrides, overridesUnder } from "./componentOverrides.js";
import { totalUnitDelay } from "./textTiming.js";
import { flattenAnimations } from "./animationTree.js";
import { loops } from "./behavior.js";
import { fileSecondsPlayed, isRemapped, isReversed, playSecondsFor, steppedPlayTime } from "./mediaTime.js";
import { MAX_TIME } from "./schema.js";

export const MEDIA_FREEZE_MODES = Object.freeze([
  ["none", "None"],
  ["first", "First frame"],
  ["last", "Last frame"],
  ["both", "First & last"],
]);

// How far past a range's end a time still counts as inside it (ranges other than a clip's
// picture, which ends on its end time: mediaFrameState).
export const PLAY_END_TOLERANCE = 1e-9;
// The held last frame is sampled just before the end, so a looping GIF never wraps back to frame 0.
const HOLD_BEFORE_END = 2e-3;
// Export frame times use a rounded step (exportFrameTimes; see MEDIA_SAMPLE_TOLERANCE's test for
// how far it drifts by the ten-minute limit).
// Frame lookups accept that much drift so exactly aligned frames are not shown one frame late.
export const MEDIA_SAMPLE_TOLERANCE = 1e-3;
// A Play range never counts past the document's time limit (schema.js MAX_TIME).
const MAX_PLAY_END = MAX_TIME;

/** Video and audio always have a Play range; an image (GIF) has one when its Play duration is set. */
export function hasMediaPlay(layer) {
  if (layer.type === "video" || layer.type === "audio") return true;
  return layer.type === "image" && layer.mediaDuration > 0;
}

/** Saved videos from before Freeze existed always showed their first and last frames. */
function mediaFreezeMode(layer) {
  return layer.mediaFreeze ?? (layer.type === "video" ? "both" : "none");
}

/**
 * How long Play really lasts, in scene seconds. A stored mediaDuration of 0 means "until the
 * source ends". Video and audio with a known source length never play past the end of the file,
 * even when the stored duration is longer: at speed 1 that is the source length minus the offset,
 * and with a clip speed (mediaTime.js) the scene seconds it takes to read that much of the file.
 * Infinity means the source length is unknown, or the speed drops to 0 before the file ends.
 * GIFs loop, so they keep their stored duration.
 */
export function effectiveMediaDuration(layer) {
  const stored = layer.mediaDuration > 0 ? layer.mediaDuration : Infinity;
  if ((layer.type !== "video" && layer.type !== "audio") || !(layer.mediaSourceDuration > 0)) return stored;
  const offset = Math.max(0, layer.mediaOffset ?? 0);
  return Math.min(stored, playSecondsFor(layer, Math.max(0, layer.mediaSourceDuration - offset)));
}

/**
 * Seconds after mediaOffset of the file moment that Play shows `local` seconds after it starts
 * (`local` from 0 to `duration`, the effectiveMediaDuration). The file moves on by the clip speed
 * (mediaTime.js); a reversed clip reads the same stretch from its end back to its start. The
 * result stays HOLD_BEFORE_END short of the end of that stretch, so a held last frame never wraps
 * a looping GIF back to its first frame. `picture` false leaves out mediaFrameRate's steps, which
 * only the picture has.
 */
function mediaSourceOffset(layer, local, duration = effectiveMediaDuration(layer), { picture = true } = {}) {
  const shown = picture ? steppedPlayTime(layer, local, MEDIA_SAMPLE_TOLERANCE) : local;
  const span = Number.isFinite(duration) ? fileSecondsPlayed(layer, duration) : Infinity;
  const read = fileSecondsPlayed(layer, Math.min(shown, duration));
  const along = isReversed(layer) && Number.isFinite(span) ? span - read : read;
  return Math.min(Math.max(0, along), Math.max(0, span - HOLD_BEFORE_END));
}

/**
 * Maps a layer clock time to the media source time and to Play visibility.
 * Play starts at mediaStart, reads the source from mediaOffset at the clip's speed, and lasts
 * effectiveMediaDuration seconds. Freeze decides whether the first frame shows before Play and
 * whether the last frame stays after it.
 * Play counts as started up to MEDIA_SAMPLE_TOLERANCE before mediaStart: export frame times drift
 * that far below n / fps (exportFrameTimes), and a Show at the same time already counts there
 * (VISIBILITY_TIME_TOLERANCE). Without it, a clip with Freeze "none" that starts on a cut was
 * hidden on its first frame and the frame drew nothing.
 */
export function mediaFrameState(layer, time) {
  if (!hasMediaPlay(layer)) return { visible: true, playing: false, sourceTime: 0 };
  const start = layer.mediaStart ?? 0;
  // A time just short of the start shows the start.
  if (time < start && time >= start - MEDIA_SAMPLE_TOLERANCE) time = start;
  const offset = Math.max(0, layer.mediaOffset ?? 0);
  const duration = effectiveMediaDuration(layer);
  const freeze = mediaFreezeMode(layer);
  // Play ends on its end time: a clip from 0.30 s lasting 0.10 s draws its last frame at 0.36 s
  // (25 fps) and is gone at 0.40 s, where the next shot starts (GAPS 6). Frame times drift up to
  // MEDIA_SAMPLE_TOLERANCE below n / fps, so that much before the end counts as the end.
  const ended = time >= start + duration - MEDIA_SAMPLE_TOLERANCE && duration > MEDIA_SAMPLE_TOLERANCE;
  if (!isRemapped(layer)) {
    const lastLocalTime = Math.max(0, duration - HOLD_BEFORE_END);
    if (time < start)
      return { visible: freeze === "first" || freeze === "both", playing: false, sourceTime: offset };
    if (ended)
      return { visible: freeze === "last" || freeze === "both", playing: false, sourceTime: offset + lastLocalTime };
    return { visible: true, playing: true, sourceTime: offset + Math.min(time - start, lastLocalTime) };
  }
  if (time < start)
    return { visible: freeze === "first" || freeze === "both", playing: false, sourceTime: offset + mediaSourceOffset(layer, 0, duration) };
  if (ended)
    return { visible: freeze === "last" || freeze === "both", playing: false, sourceTime: offset + mediaSourceOffset(layer, duration, duration) };
  return { visible: true, playing: true, sourceTime: offset + mediaSourceOffset(layer, time - start, duration) };
}

/** The editing canvas shows the frame where Play begins: the end of a reversed clip's stretch. */
export function mediaDesignTime(layer) {
  if (!hasMediaPlay(layer)) return 0;
  const offset = Math.max(0, layer.mediaOffset ?? 0);
  return isRemapped(layer) ? offset + mediaSourceOffset(layer, 0) : offset;
}

/**
 * Picks a frame from video frames that were extracted every 1/fps seconds, starting at `firstFrameTime`
 * in the source. The result is clamped to the available frames, so a short source holds its last frame.
 */
export function videoFrameIndex(sourceTime, firstFrameTime, fps, count) {
  if (!(count > 0)) return -1;
  const index = Math.floor((sourceTime - firstFrameTime + MEDIA_SAMPLE_TOLERANCE) * fps);
  return Math.max(0, Math.min(count - 1, index));
}

/** GIF frames repeat for as long as Play lasts. `durations` holds each frame's delay in seconds. */
export function gifFrameIndex(durations, sourceTime) {
  if (!Array.isArray(durations) || durations.length === 0) return -1;
  const total = durations.reduce((sum, value) => sum + (value > 0 ? value : 0), 0);
  if (!(total > 0)) return 0;
  let local = Math.max(0, sourceTime + MEDIA_SAMPLE_TOLERANCE) % total;
  for (let index = 0; index < durations.length; index += 1) {
    const length = durations[index] > 0 ? durations[index] : 0;
    if (local < length) return index;
    local -= length;
  }
  return durations.length - 1;
}

function unitCount(layer, animation, fonts) {
  if (layer.type !== "text" || animation.unit === "layer") return 1;
  return Math.max(1, textUnits(layoutText(layer, fonts), animation.unit).length);
}

/**
 * How long an animation plays, in seconds: its duration, plus for a text animation by letter,
 * word or line the per-unit stagger that delays its last unit. A Hide or Show is a point in
 * time (0). A Change text plays from its start until its last effect ends (textChange.js; 0 for an
 * instant swap). A Counter plays its duration plus the effects of its last step (counter.js).
 * Throws like layoutText when the layer's font is not loaded.
 */
export function animationPlaybackLength(layer, animation, fonts) {
  if (animation.kind === "composed") return Math.max(0, ...flattenAnimations([animation]).map((member) =>
    member.start - animation.start + animationPlaybackLength(layer, member, fonts)));
  if (isVisibilityOperation(animation)) return 0;
  if (isTextChange(animation)) return textChangeLength(layer, animation, fonts);
  if (isCounter(animation)) return counterPlaybackLength(layer, animation, fonts);
  return animation.duration + totalUnitDelay(animation, unitCount(layer, animation, fonts));
}

/**
 * Play instances use the source's timed content, independently of export duration.
 * `componentPlayback: "scene"` keeps an extracted selection's scene duration as a
 * minimum so its media clock continues through post-Play visibility transitions.
 * `overrides` (an instance's componentOverrides, see componentOverrides.js) are applied to the
 * scene's layers first, and the overrides of nested instances at each level below: a longer
 * overridden text makes a by-letter animation, and so the instance's Play bar, last longer.
 */
export function getScenePlaybackDuration(document, sceneId, fonts, overrides = null) {
  const scenes = new Map((document.scenes ?? []).map((scene) => [scene.id, scene]));
  // Lengths of scenes drawn without overrides. A scene drawn with overrides is measured again.
  const memo = new Map();
  function visit(id, stack = [], levelOverrides = null) {
    if (stack.includes(id)) throw new Error("Component: recursive component cycle in playback.");
    if (stack.length >= 16) throw new Error("Component playback nesting exceeds 16 levels.");
    const plain = !hasOverrides(levelOverrides);
    if (plain && memo.has(id)) return memo.get(id);
    const scene = scenes.get(id);
    if (!scene) throw new Error(`Component source ${id} was not found.`);
    // Extracted selections keep the source scene clock through media visibility
    // transitions. Ordinary components still use only their timed content.
    let duration = scene.componentPlayback === "scene" ? scene.duration : 0;
    for (const animation of enabledAnimations(scene.backgroundAnimations))
      duration = Math.max(duration, animation.start + animation.duration);
    for (const layer of applyComponentOverrides(scene.layers ?? [], levelOverrides)) {
      // An operation turned off for playback (animationEnabled.js) does not set the length.
      for (const animation of enabledAnimations(layer.animations)) {
        // A Hide or Show is a point in time: it counts up to its own time.
        duration = Math.max(duration, animation.start + animationPlaybackLength(layer, animation, fonts));
        // A loop (behavior.js) plays until the source scene ends.
        if (flattenAnimations([animation]).some(loops)) duration = Math.max(duration, scene.duration ?? 0);
      }
      // Open media with an unknown source length has no end, so it does not set the length.
      if (hasMediaPlay(layer) && Number.isFinite(effectiveMediaDuration(layer)))
        duration = Math.max(duration, Math.min(MAX_PLAY_END, (layer.mediaStart ?? 0) + effectiveMediaDuration(layer)));
      if (layer.type === "component") {
        const nested = mergeOverrides(layer.componentOverrides, overridesUnder(levelOverrides, layer.id));
        const childDuration = visit(layer.componentSceneId, [...stack, id], nested);
        if (childDuration > 0) duration = Math.max(duration, (layer.componentStart ?? 0) + childDuration);
      }
      for (const window of layer.playbackWindows ?? []) duration = Math.max(duration, window.end);
    }
    if (plain) memo.set(id, duration);
    return duration;
  }
  return visit(sceneId, [], overrides);
}

/** Ordered outer-to-inner windows preserve held source frames in nested instances. */
export function resolvePlayback(layer, time) {
  let clock = time;
  let visible = layer.visible !== false;
  for (const window of layer.playbackWindows ?? []) {
    if (clock < window.start && !["before", "both"].includes(window.visibility)) visible = false;
    if (clock >= window.end && !["after", "both"].includes(window.visibility)) visible = false;
    if (window.hold) clock = Math.max(window.start, Math.min(window.end, clock));
  }
  return { visible, time: clock };
}

/**
 * Media plays once inside its source windows; held visual frames never repeat audio.
 * `offset` is the source time (seconds into the file) where the range begins. With a clip speed
 * or mediaReverse the file does not move one second per scene second; the range then has
 * `remapped: true`, and mediaSoundTime gives the file time at each moment of it.
 */
export function mediaPlaybackRange(layer, duration) {
  const mediaStart = layer.mediaStart ?? 0;
  const mediaOffset = Math.max(0, layer.mediaOffset ?? 0);
  let start = Math.max(0, mediaStart);
  const playDuration = effectiveMediaDuration(layer);
  let end = Number.isFinite(playDuration) ? mediaStart + playDuration : duration;
  end = Math.min(end, duration);
  for (const window of layer.playbackWindows ?? []) {
    start = Math.max(start, window.start);
    end = Math.min(end, window.end);
  }
  if (!(end > start)) return null;
  if (!isRemapped(layer)) return { start, end, offset: mediaOffset + start - mediaStart, duration: end - start };
  return { start, end, offset: mediaSoundTime(layer, start), duration: end - start, remapped: true };
}

/**
 * The time in the file (seconds) that a video's or audio layer's sound plays at scene `time`
 * (on the layer's clock), inside its Play range: mediaOffset plus the file seconds read so far,
 * at the clip's speed and backwards for a reversed clip. Unlike the picture, the sound has no
 * mediaFrameRate steps. Outside Play it gives the nearest end of the range.
 */
export function mediaSoundTime(layer, time) {
  const offset = Math.max(0, layer.mediaOffset ?? 0);
  const duration = effectiveMediaDuration(layer);
  const local = Math.min(Math.max(0, time - (layer.mediaStart ?? 0)), duration);
  if (!isRemapped(layer)) return offset + local;
  return offset + mediaSourceOffset(layer, local, duration, { picture: false });
}

/**
 * The scene time (on the layer's clock) at which Play reaches `sourceTime` seconds into the
 * file, or null when Play never shows that moment. A reversed clip reaches each moment once,
 * counting from the end of its stretch. Used to place beats found in the file on the scene.
 */
export function mediaSceneTime(layer, sourceTime) {
  const start = layer.mediaStart ?? 0;
  const offset = Math.max(0, layer.mediaOffset ?? 0);
  const duration = effectiveMediaDuration(layer);
  const span = Number.isFinite(duration) ? fileSecondsPlayed(layer, duration) : Infinity;
  const along = sourceTime - offset;
  if (along < -1e-9 || along > span + 1e-9) return null;
  const read = isReversed(layer) && Number.isFinite(span) ? span - along : along;
  const local = playSecondsFor(layer, Math.max(0, read));
  return Number.isFinite(local) ? start + Math.min(local, duration) : null;
}
