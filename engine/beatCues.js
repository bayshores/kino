// detect_beats: the beats and onsets found in a sound layer become cues in document.cues.
//
// The agent service decodes the layer's sound and finds the beats first (backend/audio-analysis.mjs
// and beatDetection.js), then hands the result to this operation as `analysis`. Here the times,
// which are seconds into the sound file, become times on the scene's clock: the layer plays the
// file from mediaOffset, starting at mediaStart, until its Play range ends (playback.js). Beats
// and onsets outside what the scene plays are left out.
//
// Writes: beat cues beat-1, beat-2, … and onset cues onset-1, onset-2, … (all earlier beat,
// onset and accent cues are replaced, so there is one beat grid per project). From a weighted
// analysis (beatDetection.js version 7) onsets keep their weight and band, the beats that start a
// bar (barGrid) get downbeat: true, and accent-1, accent-2, … mark the hardest hits of each
// section with their rank (pickAccents), so an effect can be sized by the hit that motivates it. With a steady beat
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
import { MAX_CUES, MUSIC_CUE_KINDS } from "./qualityFields.js";
import { barGrid } from "./fitMusic.js";
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
  // A weighted analysis (version 7) gives each onset a weight and a band; then the beats that
  // start a bar are marked and the hardest hits become accent cues. An older one gives times only.
  const weighted = analysis.onsets.some((onset) => typeof onset.weight === "number");
  const grid = weighted ? barGrid(analysis) : null;
  const headIndex = grid ? analysis.beats.indexOf(grid.downbeat) : -1;
  const beats = analysis.beats
    .map((time, index) => ({ time: sceneTimes(layer, scene.duration, [time])[0], ...(headIndex >= 0 && (index - headIndex) % 4 === 0 ? { downbeat: true } : {}) }))
    .filter((beat) => beat.time !== undefined)
    .sort((a, b) => a.time - b.time);
  const others = (document.cues ?? []).filter((cue) => !MUSIC_CUE_KINDS.includes(cue.kind)).length;
  let onsets = [];
  let accents = [];
  if (operation.onsets !== false) {
    const placed = analysis.onsets
      .map((onset) => ({ time: sceneTimes(layer, scene.duration, [onset.time])[0], strength: onset.strength, ...(weighted ? { weight: onset.weight ?? 0, band: onset.band ?? "mid" } : {}) }))
      .filter((onset) => onset.time !== undefined);
    if (weighted) accents = pickAccents(placed, beats, document.cues ?? []).slice(0, Math.max(0, MAX_CUES - others - beats.length));
    const room = Math.max(0, Math.min(MAX_ONSET_CUES, MAX_CUES - others - beats.length - accents.length));
    // The strongest ones when there are too many, back in time order.
    onsets = placed.sort((a, b) => b.strength - a.strength).slice(0, room).sort((a, b) => a.time - b.time);
  }
  if (others + beats.length > MAX_CUES) fail(`the document can hold ${MAX_CUES} cues and already has ${others}.`);
  const hit = (onset) => (weighted ? { weight: onset.weight, band: onset.band } : {});
  const cues = [
    ...beats.map((beat, index) => ({ name: `beat-${index + 1}`, time: beat.time, kind: "beat", ...(beat.downbeat ? { downbeat: true } : {}) })),
    ...onsets.map((onset, index) => ({ name: `onset-${index + 1}`, time: onset.time, kind: "onset", ...hit(onset) })),
    ...accents.map((onset, index) => ({ name: `accent-${index + 1}`, time: onset.time, kind: "accent", ...hit(onset), rank: onset.rank })),
  ];
  const before = (document.cues ?? []).filter(isBeatCue);
  document.cues = withCues(document.cues, cues, { kinds: MUSIC_CUE_KINDS });
  if (!document.cues.length) delete document.cues;
  const cuesMoved = animationsOnMovedCues(document, before);
  // The tempo the scene hears: a sound at 2× plays its beats twice as fast. A Speed animation
  // changes the tempo as it plays, so it has no one rhythm.
  const rampsTempo = animatesSpeed(layer);
  const bpm = constantSpeed(layer) === 1 ? analysis.bpm : round(analysis.bpm * constantSpeed(layer));
  const steady = !rampsTempo && bpm >= 30 && bpm <= 300 && analysis.confidence >= CONFIDENT && beats.length >= 2;
  const setRhythm = operation.rhythm !== false && steady;
  if (setRhythm) document.rhythm = { bpm, offset: beats[0].time };
  const note = [analysis.note, rampsTempo && operation.rhythm !== false ? `"${layer.name}" has a Speed animation, so its tempo changes and no rhythm was set` : null].filter(Boolean).join("; ");
  return {
    layer: layer.name,
    bpm: rampsTempo ? analysis.bpm : bpm,
    confidence: analysis.confidence,
    beats: beats.length,
    onsets: onsets.length,
    ...(weighted && operation.onsets !== false ? { accents: `${accents.length} (top per section)` } : {}),
    ...(beats.length ? { firstBeat: beats[0].time, lastBeat: beats.at(-1).time } : {}),
    ...(setRhythm ? { rhythm: document.rhythm } : {}),
    ...(note ? { note } : {}),
    ...(cuesMoved.length ? { cuesMoved: cuesMoved.slice(0, MAX_MOVED_REPORTED) } : {}),
    ...(cuesMoved.length > MAX_MOVED_REPORTED ? { cuesMovedMore: cuesMoved.length - MAX_MOVED_REPORTED } : {}),
  };
}

// Accents: a hit this light (against the song's hardest) is never one, so a quiet intro gets none.
const ACCENT_FLOOR = 0.3;
// Without the song's sections (fit_music's song-* cues), a section is a phrase of 8 bars.
const PHRASE_BARS = 8;
// At most one accent per bar, and about one per 4 bars of a section: the top few, not every hit.
const BARS_PER_ACCENT = 4;
// An onset this close before a bar line is in that bar (a hit a hair early).
const EARLY = 0.035;

/**
 * The accent cues: the hardest hits of each section. `onsets` [{time, weight, band}] and `beats`
 * [{time, downbeat?}] are on the scene clock; `cues` are the document's cues, whose song-*
 * markers (fit_music) are the sections, else phrases of 8 bars. Each bar offers its heaviest
 * onset; a section of n bars keeps the ceil(n / 4) heaviest of those that weigh at least 0.3.
 * Returns them in time order, each with rank (1 = its section's heaviest).
 */
export function pickAccents(onsets, beats, cues) {
  if (beats.length < 2 || !onsets.length) return [];
  let heads = beats.filter((beat) => beat.downbeat).map((beat) => beat.time);
  if (!heads.length) heads = beats.filter((_, index) => index % 4 === 0).map((beat) => beat.time);
  const songMarks = cues.filter((cue) => cue.kind === "marker" && cue.name.startsWith("song-")).map((cue) => cue.time).sort((a, b) => a - b);
  // A pickup before the first bar line belongs to the first phrase.
  const edges = songMarks.length ? songMarks : heads.filter((_, index) => index % PHRASE_BARS === 0).slice(1);
  const countUpTo = (list, time) => list.filter((value) => value <= time + EARLY).length;
  const sections = new Map();
  for (const onset of onsets) {
    const section = countUpTo(edges, onset.time);
    const bar = countUpTo(heads, onset.time);
    if (!sections.has(section)) sections.set(section, new Map());
    const bars = sections.get(section);
    const best = bars.get(bar);
    if (!best || onset.weight > best.weight || (onset.weight === best.weight && onset.time < best.time)) bars.set(bar, onset);
  }
  const picked = [];
  for (const [section, bars] of sections) {
    const from = section === 0 ? -Infinity : edges[section - 1];
    const to = section < edges.length ? edges[section] : Infinity;
    const barCount = Math.max(1, heads.filter((time) => time + EARLY >= from && time + EARLY < to).length);
    const keep = Math.min(bars.size, Math.ceil(barCount / BARS_PER_ACCENT));
    const ranked = [...bars.values()].filter((onset) => onset.weight >= ACCENT_FLOOR)
      .sort((a, b) => b.weight - a.weight || a.time - b.time).slice(0, keep);
    ranked.forEach((onset, index) => picked.push({ ...onset, rank: index + 1 }));
  }
  return picked.sort((a, b) => a.time - b.time);
}

const isSound = (layer) => SOUND_TYPES.has(layer.type) && Boolean(layer.src);
const isBeatCue = (cue) => MUSIC_CUE_KINDS.includes(cue.kind);
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
