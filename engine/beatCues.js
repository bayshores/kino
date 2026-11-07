// detect_beats: the beats and onsets found in a sound layer become cues in document.cues.
//
// The agent service decodes the layer's sound and finds the beats first (backend/audio-analysis.mjs
// and beatDetection.js), then hands the result to this operation as `analysis`. Here the times,
// which are seconds into the sound file, become times on the scene's clock: the layer plays the
// file from mediaOffset, starting at mediaStart, until its Play range ends (playback.js). Beats
// and onsets outside what the scene plays are left out.
//
// Writes: beat cues beat-1, beat-2, … and onset cues onset-1, onset-2, … (all earlier beat and
// onset cues are replaced, so there is one beat grid per project). With a steady beat
// (confidence 0.5 or more) it also sets document.rhythm {bpm, offset: first beat}, which the
// quality checker compares motion to. When it runs again and moves a beat or onset cue that an
// animation starts on, the report's cuesMoved lists that animation (it keeps its time). When
// retime (backend/agent/blocks.mjs) moves the sound, moveBeatCues moves its cues and the rhythm
// with it.
import { animationTreeEntries } from "./animationTree.js";
import { CONFIDENT } from "./beatDetection.js";
import { mediaPlaybackRange, mediaSceneTime, mediaSoundTime } from "./playback.js";
import { constantSpeed, isRemapped } from "./mediaTime.js";
import { animatesSpeed } from "./animation.js";
import { withCues } from "./cues.js";
import { MAX_CUES } from "./qualityFields.js";
import { round } from "./numbers.js";

export const MAX_ONSET_CUES = 1000;
const SOUND_TYPES = new Set(["audio", "video"]);

function fail(message) {
  throw new Error(`detect_beats: ${message}`);
}

/**
 * Scene times for source times, kept only while the layer plays them, earliest first. A clip
 * with a speed or played backwards (mediaTime.js) places each one through its time map
 * (playback.js mediaSceneTime), so a beat in a slowed-down stretch lands later on the scene.
 */
export function sceneTimes(layer, sceneDuration, times) {
  const range = mediaPlaybackRange(layer, sceneDuration);
  if (!range) return [];
  const toScene = range.remapped ? (time) => mediaSceneTime(layer, time) ?? NaN : (time) => range.start + (time - range.offset);
  return times
    .map(toScene)
    .filter((time) => time >= range.start - 1e-6 && time <= range.end + 1e-6)
    .map((time) => round(Math.min(sceneDuration, Math.max(0, time))))
    .sort((left, right) => left - right);
}

/** The stretch of the file a range plays: { from, to } in file seconds. */
function fileSpan(layer, range) {
  if (!range.remapped) return { from: range.offset, to: range.offset + range.duration };
  const [first, last] = [mediaSoundTime(layer, range.start), mediaSoundTime(layer, range.end)];
  return { from: Math.min(first, last), to: Math.max(first, last) };
}

/** Applies detect_beats {sceneId, layerId, analysis, onsets?, rhythm?}. Returns a report. */
export function applyDetectBeats(document, operation) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  if (!layer) fail(`layer ${operation.layerId} was not found.`);
  if (!SOUND_TYPES.has(layer.type) || !layer.src) fail(`"${layer.name}" is a ${layer.type} layer; give an audio or video layer with sound.`);
  for (const key of ["onsets", "rhythm"])
    if (operation[key] !== undefined && typeof operation[key] !== "boolean") fail(`${key} must be true or false.`);
  const analysis = operation.analysis;
  if (!analysis || !Array.isArray(analysis.beats) || !Array.isArray(analysis.onsets))
    fail("the sound has not been analysed; send detect_beats through the agent service (edit), which analyses it first.");
  const beats = sceneTimes(layer, scene.duration, analysis.beats);
  const others = (document.cues ?? []).filter((cue) => cue.kind !== "beat" && cue.kind !== "onset").length;
  let onsets = [];
  if (operation.onsets !== false) {
    const room = Math.max(0, Math.min(MAX_ONSET_CUES, MAX_CUES - others - beats.length));
    const placed = analysis.onsets
      .map((onset) => ({ time: sceneTimes(layer, scene.duration, [onset.time])[0], strength: onset.strength }))
      .filter((onset) => onset.time !== undefined);
    // The strongest ones when there are too many, back in time order.
    onsets = placed.sort((a, b) => b.strength - a.strength).slice(0, room).map((onset) => onset.time).sort((a, b) => a - b);
  }
  if (others + beats.length > MAX_CUES) fail(`the document can hold ${MAX_CUES} cues and already has ${others}.`);
  const cues = [
    ...beats.map((time, index) => ({ name: `beat-${index + 1}`, time, kind: "beat" })),
    ...onsets.map((time, index) => ({ name: `onset-${index + 1}`, time, kind: "onset" })),
  ];
  const before = (document.cues ?? []).filter(isBeatCue);
  document.cues = withCues(document.cues, cues, { kinds: ["beat", "onset"] });
  if (!document.cues.length) delete document.cues;
  const cuesMoved = animationsOnMovedCues(document, before);
  // The tempo the scene hears: a sound at 2× plays its beats twice as fast. A Speed animation
  // changes the tempo as it plays, so it has no one rhythm.
  const rampsTempo = animatesSpeed(layer);
  const bpm = constantSpeed(layer) === 1 ? analysis.bpm : round(analysis.bpm * constantSpeed(layer));
  const steady = !rampsTempo && bpm >= 30 && bpm <= 300 && analysis.confidence >= CONFIDENT && beats.length >= 2;
  const setRhythm = operation.rhythm !== false && steady;
  if (setRhythm) document.rhythm = { bpm, offset: beats[0] };
  const note = [analysis.note, rampsTempo && operation.rhythm !== false ? `"${layer.name}" has a Speed animation, so its tempo changes and no rhythm was set` : null].filter(Boolean).join("; ");
  return {
    layer: layer.name,
    bpm: rampsTempo ? analysis.bpm : bpm,
    confidence: analysis.confidence,
    beats: beats.length,
    onsets: onsets.length,
    ...(beats.length ? { firstBeat: beats[0], lastBeat: beats.at(-1) } : {}),
    ...(setRhythm ? { rhythm: document.rhythm } : {}),
    ...(note ? { note } : {}),
    ...(cuesMoved.length ? { cuesMoved: cuesMoved.slice(0, MAX_MOVED_REPORTED) } : {}),
    ...(cuesMoved.length > MAX_MOVED_REPORTED ? { cuesMovedMore: cuesMoved.length - MAX_MOVED_REPORTED } : {}),
  };
}

const isSound = (layer) => SOUND_TYPES.has(layer.type) && Boolean(layer.src);
const isBeatCue = (cue) => cue.kind === "beat" || cue.kind === "onset";
// Two times this close are the same moment (cue times are rounded to the millisecond).
const SAME_TIME = 0.002;
const within = (time, range) => Boolean(range) && time >= range.start - SAME_TIME && time <= range.end + SAME_TIME;
const MAX_MOVED_REPORTED = 20;

/**
 * Running detect_beats again (on a new sound, or after an update) can move a beat or onset cue,
 * or renumber them all. Animations keep their seconds: an animation put on "cue:beat-16" does
 * not follow the cue. This finds the animations that started on a beat or onset cue (`before`,
 * the cues before the run) whose time is now different, so the agent can move them or keep them.
 * A beat and an onset can share a moment; then the beat is the one that counts, so an animation
 * whose beat moved is listed even when the onset there stayed.
 * Returns [{animation (its ID), cue, at (its start), moved (seconds) or gone: true, now?}];
 * `now` names the cue at that time after the run, if one is (a beat first, else an onset).
 */
function animationsOnMovedCues(document, before) {
  const after = (document.cues ?? []).filter(isBeatCue);
  const timeNow = new Map(after.map((cue) => [cue.name, cue.time]));
  const kept = (cue) => timeNow.has(cue.name) && Math.abs(timeNow.get(cue.name) - cue.time) <= SAME_TIME;
  const atTime = (cues, start) => {
    const here = cues.filter((cue) => Math.abs(cue.time - start) <= SAME_TIME);
    return here.find((cue) => cue.kind === "beat") ?? here[0];
  };
  const found = [];
  const listed = new Set();
  for (const scene of document.scenes) {
    for (const animations of [scene.backgroundAnimations, ...scene.layers.map((layer) => layer.animations)]) {
      for (const { animation, stored, parents } of animationTreeEntries(animations ?? [])) {
        // A group on a cue is listed once, not again for each animation in it.
        if (!stored?.id || parents.some((id) => listed.has(id))) continue;
        const start = animation.start ?? 0;
        // The beat cue it started on, or its onset cue when no beat was there.
        const cue = atTime(before, start);
        if (!cue || kept(cue)) continue;
        const now = atTime(after, start);
        found.push({
          animation: stored.id,
          cue: cue.name,
          at: round(start),
          ...(timeNow.has(cue.name) ? { moved: round(timeNow.get(cue.name) - cue.time) } : { gone: true }),
          ...(now ? { now: now.name } : {}),
        });
        listed.add(stored.id);
      }
    }
  }
  return found;
}

/**
 * After a scene is retimed: the beat and onset cues move with the sound they were found in.
 * retime moves a sound's Play start (mediaStart) and the scene's end, but the sound still plays
 * at its own speed, so its cues (and the rhythm, when its first beat is one of them) shift by
 * the same seconds as its Play start, and cues of a part it no longer plays are left out.
 * A sound with a speed or played backwards (mediaTime.js) can play its file differently after
 * the retime (retime stretches a long Speed animation), so each cue goes through the file: from
 * its scene time before to the file time it marked, and on to where that plays now.
 * `starts` maps each layer of `scene` to its mediaStart before the retime, `animations` (when
 * given) to its animations before it, and `length` is the scene's length before it. Changes
 * `document` and returns a note for the receipt, or null.
 */
export function moveBeatCues(document, scene, starts, length, animations = null) {
  const found = (document.cues ?? []).filter(isBeatCue);
  if (!found.length) return null;
  const layerBefore = (layer) => ({ ...layer, mediaStart: starts.get(layer), ...(animations?.has(layer) ? { animations: animations.get(layer) } : {}) });
  const rangeBefore = (layer) => mediaPlaybackRange(layerBefore(layer), length);
  const changed = scene.layers.filter((layer) => {
    if (!isSound(layer) || !starts.has(layer)) return false;
    const [before, after] = [rangeBefore(layer), mediaPlaybackRange(layer, scene.duration)];
    return layer.mediaStart !== starts.get(layer) || before?.start !== after?.start || before?.end !== after?.end
      || (animations?.has(layer) && animations.get(layer) !== layer.animations && (isRemapped(layer) || isRemapped(layerBefore(layer))));
  });
  if (!changed.length) return null;
  // The cues came from a sound that played at every one of their times (detect_beats leaves
  // out the beats a sound does not play). In other scenes, sounds play on their own clock.
  const sources = document.scenes.flatMap((item) => item.layers.filter((layer) => isSound(layer)
    && found.every((cue) => within(cue.time, item === scene ? rangeBefore(layer) : mediaPlaybackRange(layer, item.duration)))));
  const sound = sources.find((layer) => changed.includes(layer));
  if (!sound) return null;
  const shift = round((sound.mediaStart ?? 0) - (starts.get(sound) ?? 0));
  const moved = `"${sound.name}" moved ${shift > 0 ? "+" : ""}${shift} s`;
  if (sources.length > 1) {
    if (!shift) return null;
    const names = sources.map((layer) => `"${layer.name}"`).join(", ");
    return `retime: ${moved}, but the beat and onset cues could be from any of ${names}, so they stayed: run detect_beats again on the sound they are from`;
  }
  const range = mediaPlaybackRange(sound, scene.duration);
  const before = rangeBefore(sound);
  // A cue's new time: the same seconds later, or (a sound with a speed) where the moment of the
  // file it marked plays now, which is NaN when the sound no longer plays that moment.
  const remapped = isRemapped(sound) || isRemapped(layerBefore(sound));
  const moveTime = remapped
    ? (time) => mediaSceneTime(sound, mediaSoundTime(layerBefore(sound), time)) ?? NaN
    : (time) => time + shift;
  const rhythmMoves = Boolean(document.rhythm) && found.some((cue) => cue.kind === "beat" && Math.abs(cue.time - document.rhythm.offset) <= 0.002);
  let left = 0;
  const cues = [];
  for (const cue of document.cues) {
    const time = isBeatCue(cue) ? round(moveTime(cue.time)) : cue.time;
    if (!isBeatCue(cue) || within(time, range)) cues.push({ ...cue, time });
    else left += 1;
  }
  document.cues = cues.sort((a, b) => a.time - b.time);
  if (!document.cues.length) delete document.cues;
  const rhythmAt = rhythmMoves ? round(moveTime(document.rhythm.offset)) : NaN;
  if (Number.isFinite(rhythmAt)) document.rhythm = { ...document.rhythm, offset: Math.max(0, rhythmAt) };
  // Beats in a part of the file it did not play before were never found.
  const [playsNow, playedBefore] = [range && fileSpan(sound, range), before && fileSpan(layerBefore(sound), before)];
  const playsMore = Boolean(playsNow) && (!playedBefore || playsNow.from < playedBefore.from - 0.002 || playsNow.to > playedBefore.to + 0.002);
  const parts = [];
  if (remapped) parts.push(`"${sound.name}" plays at a speed (mediaSpeed or a Speed animation), so its beat and onset cues${rhythmMoves ? " and the rhythm" : ""} moved to where the same moments of its file play now`);
  else if (shift) parts.push(`${moved}, and its beat and onset cues${rhythmMoves ? " and the rhythm" : ""} with it`);
  if (left) parts.push(`removed ${left} beat/onset ${left === 1 ? "cue" : "cues"} that "${sound.name}" no longer plays`);
  if (playsMore) parts.push(`"${sound.name}" now plays more of its file: run detect_beats again for the beats there`);
  return parts.length ? `retime: ${parts.join("; ")}` : null;
}
