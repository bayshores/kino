// Editing math for media Play ranges (video, audio, and GIF images).
// The timeline, the inspector, and import all go through these functions,
// so a Play range is clamped the same way no matter where it is edited.
import {
  MEDIA_FREEZE_MODES,
  mediaDesignTime,
  mediaFrameState,
  mediaPlaybackRange,
  mediaSoundTime,
  resolvePlayback,
} from "./playback.js";
import { animatesSpeed } from "./animation.js";
import { isRemapped, isReversed, mediaFrameRateOf, mediaPitchOf, playSecondsFor, speedAtClock } from "./mediaTime.js";
import { MAX_TIME } from "./schema.js";

/** Latest scene time a Play range may reach; matches the document's time limit. */
export const MAX_PLAY_TIME = MAX_TIME;
/** Largest offset into a source file the document accepts (one day). */
const MAX_MEDIA_OFFSET = 86_400;
/** The shortest Play range is one frame at 60 fps. */
export const MIN_PLAY_SECONDS = 1 / 60;
// An offset stops this far before the end of the source, so Play always has a frame to show.
const SOURCE_END_MARGIN = 0.01;
const FREEZE_VALUES = new Set(MEDIA_FREEZE_MODES.map(([value]) => value));
// A component's hold window moves the media clock away from the scene clock by more than this.
const HELD_CLOCK_TOLERANCE = 1e-9;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Removes floating point noise such as 0.30000000000000004 from dragged values.
function roundTime(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** True for a GIF file: an uploaded .gif or an embedded GIF data URL. */
function isGifSource(src) {
  if (typeof src !== "string") return false;
  return /\.gif(?:$|[?#])/i.test(src) || /^data:image\/gif[;,]/i.test(src);
}

export function isGifLayer(layer) {
  return layer?.type === "image" && isGifSource(layer.src);
}

/** Video and audio cannot play past the end of their source; GIFs loop instead. */
function sourceLength(layer) {
  if (layer.type !== "video" && layer.type !== "audio") return Infinity;
  return layer.mediaSourceDuration > 0 ? layer.mediaSourceDuration : Infinity;
}

/** Largest Start offset: just before the source ends for video and audio, otherwise the document limit. */
export function maxPlayOffset(layer) {
  const length = sourceLength(layer);
  return Number.isFinite(length) ? Math.max(0, roundTime(length - SOURCE_END_MARGIN)) : MAX_MEDIA_OFFSET;
}

/**
 * Largest Play duration (scene seconds) for a given start and offset: the time it takes to play
 * the rest of the file at the clip's speed (mediaTime.js), within the document's time limit.
 */
export function maxPlayDuration(layer, start = finite(layer.mediaStart), offset = finite(layer.mediaOffset)) {
  const limit = Math.max(0, MAX_PLAY_TIME - start);
  const length = sourceLength(layer);
  if (!Number.isFinite(length)) return limit;
  const left = Math.max(0, length - offset);
  const playable = isRemapped(layer) ? playSecondsFor({ ...layer, mediaStart: start }, left) : left;
  return Math.min(limit, Math.max(0, roundTime(playable)));
}

/**
 * Applies an inspector edit to one Play field and returns the patch to store.
 * Changing the offset of a video or audio layer also shortens a duration that
 * would otherwise run past the end of the source.
 */
export function playFieldPatch(layer, field, value) {
  const number = finite(value);
  const stored = layer.mediaDuration > 0 ? layer.mediaDuration : 0;
  if (field === "mediaStart")
    return { mediaStart: roundTime(clamp(number, 0, MAX_PLAY_TIME - stored)) };
  if (field === "mediaOffset") {
    const mediaOffset = roundTime(clamp(number, 0, maxPlayOffset(layer)));
    const longest = maxPlayDuration(layer, finite(layer.mediaStart), mediaOffset);
    return stored > longest ? { mediaOffset, mediaDuration: longest } : { mediaOffset };
  }
  if (field === "mediaDuration") {
    const longest = maxPlayDuration(layer);
    return { mediaDuration: roundTime(clamp(number, Math.min(MIN_PLAY_SECONDS, longest), longest)) };
  }
  if (field === "mediaFreeze") {
    if (!FREEZE_VALUES.has(value)) throw new Error("Freeze must be none, first, last, or both.");
    return { mediaFreeze: value };
  }
  if (field === "volume") return { volume: clamp(number, 0, 1) };
  throw new Error(`${field} is not a Play setting.`);
}

/**
 * Scene time where newly imported audio starts: the playhead. When the playhead is at the
 * scene end (less than one frame left), the audio starts at 0 instead, so it can be heard.
 */
function audioImportStart(playhead, sceneDuration) {
  const start = roundTime(clamp(finite(playhead), 0, MAX_PLAY_TIME - MIN_PLAY_SECONDS));
  return finite(sceneDuration) - start >= MIN_PLAY_SECONDS ? start : 0;
}

/**
 * Play fields for a newly imported file. Video and animated GIFs play from the start of the
 * scene; audio starts at the `playhead` (see audioImportStart). Each plays for the source
 * length or until the scene ends, whichever is shorter. Video and audio with an unknown
 * length stay open (they play until the source ends). Still images, including single-frame
 * GIFs, get no Play range.
 */
export function importedPlayFields({ type, sourceDuration, animated = false, sceneDuration, playhead = 0 }) {
  const length = finite(sourceDuration) > 0 ? Math.min(finite(sourceDuration), MAX_MEDIA_OFFSET) : 0;
  const base = { mediaStart: 0, mediaOffset: 0, mediaFreeze: "none" };
  if (type === "image") {
    if (!animated || !(length > 0)) return { ...base, mediaDuration: 0, mediaSourceDuration: 0 };
    return { ...base, mediaSourceDuration: length, mediaDuration: Math.min(length, finite(sceneDuration, length), MAX_PLAY_TIME) };
  }
  if (type === "video")
    return { ...base, mediaSourceDuration: length, mediaDuration: length > 0 ? Math.min(length, finite(sceneDuration, length), MAX_PLAY_TIME) : 0 };
  if (type === "audio") {
    const mediaStart = audioImportStart(playhead, sceneDuration);
    const room = roundTime(Math.min(finite(sceneDuration, length + mediaStart), MAX_PLAY_TIME) - mediaStart);
    return { ...base, mediaStart, mediaSourceDuration: length, mediaDuration: length > 0 ? Math.min(length, room) : 0 };
  }
  return {};
}

/**
 * Replacing a source preserves an existing Play range, shortening its trims to fit the
 * new file. A new timed layer gets import's normal Play range; a still loses Play.
 * GIFs may loop after later edits, but replacement initially clamps to one new source.
 */
export function replacementPlayFields(layer, media) {
  const imported = importedPlayFields(media);
  const nextTimed = media.type === "video" || media.type === "audio" || (media.animated && imported.mediaSourceDuration > 0);
  const hadPlay = layer.type === "video" || layer.type === "audio" || (isGifLayer(layer) && layer.mediaDuration > 0);
  if (!nextTimed || !hadPlay) return imported;
  const next = { ...layer, type: media.type === "image" ? "video" : media.type, mediaSourceDuration: imported.mediaSourceDuration };
  // Treat the new GIF as a finite source for this clamp, without changing ordinary GIF looping.
  Object.assign(next, playFieldPatch(next, "mediaOffset", layer.mediaOffset));
  Object.assign(next, playFieldPatch(next, "mediaStart", layer.mediaStart));
  if (layer.mediaDuration > 0) Object.assign(next, playFieldPatch(next, "mediaDuration", layer.mediaDuration));
  return { mediaSourceDuration: imported.mediaSourceDuration, mediaStart: next.mediaStart,
    mediaOffset: next.mediaOffset, mediaDuration: next.mediaDuration, mediaFreeze: layer.mediaFreeze };
}

/**
 * What an editor <video> should do at scene time `time`: the source time to show,
 * and whether it should be playing. Outside Play the video is paused on the held frame.
 * Before and after a component instance, the instance's hold window pins the clock;
 * the video then shows the held frame paused instead of playing in place.
 */
export function videoSyncState(layer, time, { design = false, playing = false } = {}) {
  if (design) return { play: false, sourceTime: mediaDesignTime(layer) };
  const clock = resolvePlayback(layer, time);
  const state = mediaFrameState(layer, clock.time);
  const held = Math.abs(clock.time - time) > HELD_CLOCK_TOLERANCE;
  const play = playing && clock.visible && state.playing && !held;
  return withElementRate({ play, sourceTime: state.sourceTime }, layer, clock.time, { picture: true });
}

/**
 * Audio plays once inside its Play range, from the range's source offset at the clip's speed
 * (mediaSoundTime). A reversed clip, or one slower than a media element can play, is paused on
 * each moment instead, so it is silent in a browser preview.
 */
export function audioSyncState(layer, time, sceneDuration, { design = false, playing = false } = {}) {
  const range = mediaPlaybackRange(layer, sceneDuration);
  if (!range) return { play: false, sourceTime: Math.max(0, finite(layer.mediaOffset)) };
  const local = clamp(time - range.start, 0, range.duration);
  return withElementRate({
    play: !design && playing && time >= range.start && time < range.end,
    sourceTime: range.remapped ? mediaSoundTime(layer, range.start + local) : range.offset + local,
  }, layer, range.start + local, { picture: false });
}

// A slowed-down element may drift at least this far (seconds of its file) before it is moved:
// about half a frame of 25 to 30 fps footage, so reading the time a little early or late does not
// make it seek on every frame.
const MIN_ELEMENT_DRIFT = 0.02;

/**
 * How far (seconds of its file) a playing <video> or <audio> element at playbackRate `rate` may
 * be from the time the scene asks for before the preview seeks it. `drift` is the allowed drift
 * in seconds of the scene; a file moves `rate` seconds per scene second, so the same drift is
 * `drift × rate` file seconds. At 0.25× a looser limit let the picture run 0.06 s of file
 * (0.24 s of the scene) ahead after a ramp, because a browser applies a new playbackRate late.
 */
export function allowedMediaDrift(rate, drift) {
  return Math.max(MIN_ELEMENT_DRIFT, drift * (Number.isFinite(rate) && rate > 0 ? rate : 1));
}

// Browsers play a <video> or <audio> element from 1/16 to 16 times its speed.
const MIN_ELEMENT_RATE = 1 / 16;
const MAX_ELEMENT_RATE = 16;

/**
 * Adds how a browser media element plays a clip with a speed, backwards or choppy (mediaTime.js)
 * at `clock` (the layer's clock): its playbackRate (`rate`) and whether it keeps its pitch
 * (`keepPitch`, as the export's mediaPitch "keep" does for a constant speed; a Speed animation's
 * sound follows the speed like a tape, so it does not). When the element cannot play the clip by
 * itself (backwards, a choppy mediaFrameRate picture, or slower than 1/16) it is paused and moved
 * to each moment instead (`play` false). Other clips keep { play, sourceTime } as they are.
 */
function withElementRate(state, layer, clock, { picture }) {
  if (!isRemapped(layer)) return state;
  const keepPitch = mediaPitchOf(layer) === "keep" && !animatesSpeed(layer);
  const speed = speedAtClock(layer, clock);
  const stepped = isReversed(layer) || (picture && mediaFrameRateOf(layer) > 0) ||
    speed < MIN_ELEMENT_RATE || speed > MAX_ELEMENT_RATE;
  return { ...state, play: state.play && !stepped, rate: stepped ? 1 : speed, keepPitch };
}

// How a preview keeps a <video> or <audio> element on the scene clock while the scene plays.
// The element plays on its own; once a frame the preview compares it with the time the scene
// asks for. A seek makes the decoder start again from the last keyframe, which can take longer
// than a frame (a 1080p clip took a few tenths of a second). Before, a playing element that was
// still seeking looked late, so it was sought again the next frames, and every new seek cancelled
// the one before: the video stood still while the preview sought it ten times a second. Now:
// - a small drift is closed by playing a little faster or slower for a moment (no seek);
// - an element that is still seeking is left to finish, unless the scene jumped far;
// - a seek while playing aims a little ahead, by how long this element's last seek took.

// Drift smaller than this part of the allowed drift is left alone.
const NUDGE_FROM = 0.25;
// A paused element that is told to play takes a moment (about 0.1 to 0.3 s) before its time moves.
// For this long after play() it may lag up to START_DRIFT_SECONDS (of the scene) and catches up
// by playing faster: a seek there restarted the decoder and froze every clip start.
const START_GRACE_MS = 700;
const START_DRIFT_SECONDS = 0.4;
// A drift is closed over about this many seconds of the scene...
const CATCH_UP_SECONDS = 0.5;
// ...playing at most this much faster or slower than the clip's speed.
const MAX_NUDGE = 0.25;
// Playback rates are changed in steps of this size, so the rate is not set again every frame.
const NUDGE_STEP = 0.02;
// An element that is still seeking is sought again only when the scene time moved this far
// (seconds of the scene) from where it is going: you jumped while playing.
const RESEEK_SECONDS = 1;
// A seek while playing aims at most this far ahead (seconds of the scene).
const MAX_SEEK_LEAD = 0.5;
// A paused element is sought only when it is visibly away from the wanted frame.
const PAUSED_SEEK_SECONDS = 0.001;

// For each element: when the preview last sought it (ms), whether that seek is still open, and
// how long its last finished seek took (ms).
const seekTimes = new WeakMap();
// For each element: when the preview last told it to play (ms).
const startTimes = new WeakMap();

function seekTo(media, time, now) {
  const record = seekTimes.get(media);
  seekTimes.set(media, { at: now, took: record?.took ?? 0, open: true });
  media.currentTime = time;
}

/**
 * Moves a <video> or <audio> element toward `sourceTime` (seconds of its file), as
 * videoSyncState or audioSyncState describe it: playing at `rate` times its speed (keeping its
 * pitch when `keepPitch`) when `play`, else paused on that moment. `silent` mutes it. `drift`
 * is how far (seconds of the scene) a playing element may be from the scene clock before it is
 * sought. `playing` says the scene is playing, so the preview calls this again next frame: a
 * paused (stepped) element that is still seeking then waits for that call. `now` is the time in
 * milliseconds (performance.now()), given in tests.
 */
export function syncMediaElement(media, { play, sourceTime, rate = 1, keepPitch = true },
  { silent = false, drift = 0.08, playing = false, now = globalThis.performance?.now() ?? Date.now() } = {}) {
  const length = Number.isFinite(media.duration) ? media.duration : Infinity;
  const target = Math.max(0, Math.min(sourceTime, length));
  const playable = play && target < length;
  media.muted = silent || !playable;
  const record = seekTimes.get(media);
  if (record?.open && !media.seeking) { record.took = now - record.at; record.open = false; }
  if (playable) {
    if ("preservesPitch" in media && media.preservesPitch !== keepPitch) media.preservesPitch = keepPitch;
    // How far ahead (+) or behind (-) the element is, in seconds of its file.
    const error = media.currentTime - target;
    const starting = now - (startTimes.get(media) ?? -Infinity) < START_GRACE_MS;
    const normal = allowedMediaDrift(rate, drift);
    const allowed = starting ? Math.max(normal, allowedMediaDrift(rate, START_DRIFT_SECONDS)) : normal;
    let nextRate = rate;
    if (media.seeking) {
      if (Math.abs(error) > allowedMediaDrift(rate, RESEEK_SECONDS)) seekTo(media, target, now);
    } else if (Math.abs(error) > allowed) {
      const lead = Math.min(MAX_SEEK_LEAD, (record?.took ?? 0) / 1000) * rate;
      seekTo(media, Math.min(target + lead, Math.max(target, length - 0.001)), now);
    } else if (Math.abs(error) > normal * NUDGE_FROM) {
      const change = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, -error / rate / CATCH_UP_SECONDS));
      nextRate = rate * (1 + Math.round(change / NUDGE_STEP) * NUDGE_STEP);
    }
    nextRate = Math.max(MIN_ELEMENT_RATE, Math.min(MAX_ELEMENT_RATE, nextRate));
    if (media.playbackRate !== nextRate) media.playbackRate = nextRate;
    if (media.paused) { startTimes.set(media, now); media.play().catch(() => {}); }
    return;
  }
  if (!media.paused) media.pause();
  // While the scene plays, a stepped clip (backwards or choppy) is moved every frame: a seek that
  // has not finished is left to finish, and the next frame moves it on.
  if (playing && media.seeking) return;
  if (Math.abs(media.currentTime - target) > PAUSED_SEEK_SECONDS) seekTo(media, target, now);
}
