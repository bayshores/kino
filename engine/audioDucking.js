// duck_audio: turns one sound layer down while other sound layers play, such as music under a
// voice-over.
//
//   duck_audio {sceneId, layerId, under: [layer ids], to?, fade?: 0.15, fadeUp?: 0.8, replace?}
//
// For each stretch in which an `under` layer plays (its Play range, without the times a Hide
// silences a video; videoSound.js), the layer gets two Volume animations: "Duck down" goes from
// its volume to `to` in the `fade` seconds before the stretch starts, and "Duck up" goes back in
// the `fadeUp` seconds after it ends (a quick dip, a slow return). Stretches that overlap, or are
// so close that the fades would meet, become one dip, except across a section cue (drop, break...):
// there the dips stay apart and their fades stop at the cue, so the song's change is heard at full
// (merging them into one long dip buried a song's drop).
//
// How deep: a given `to` is the level of every dip (the agent chose it). Without `to`, the dip puts
// the music VOICE_OVER_MUSIC (9) LU under the voice, from the files' measured loudness (`levels`
// {layerId: curve}, put in by the agent service from backend/loudness-curve.mjs; a voice with a
// transcript counts at the level the export levels it to, mixLevels.js leveledLoudness: -16 LUFS
// unless the 12 dB leveling limit leaves it off that); without measurements it is 0.25. A default dip
// never raises the music above its level there.
// Then a default dip longer than LONG_DIP seconds sits at most LONG_DIP_DB under the level it
// leaves (a long dip at -15 dB takes the drive out of the music under a whole beat), and any
// default dip goes deeper where a line it covers needs it: each spoken line, measured the way the
// voice_under_bed check measures it (mixLevels.js voiceLines, clearVolume), stays VOICE_OVER_BED
// (6) LU over the music under it (one merged dip held shallow for its loud lines once left a
// quiet line 1.9 LU over the music). A default dip stops at DIP_FLOOR (0.1, -20 dB) of
// the level it leaves; a line still under the music there is named in `quiet` with its fix (the
// voice comes up), and voice_under_bed flags it. A dip that covers a section cue (a cue named drop,
// break, chorus and so on: mixLevels.js sectionCues) is warned about: the song's change is heard
// muffled under the voice. Without `to` (or from keep_line with its own dip, payoffStop), a dip that
// would cross the song's drop ends there instead, its fade up done on the drop (RAMP_MIN at least),
// and the receipt's payoff gives the line's level over the song there and the volume that lifts it.
// Each default dip takes its depth from its own voices and the music under it, not one for all.
// Fades are cut short at the start and end of the scene. Running duck_audio again on the same
// layer adds its dips to the ones already there (earlierDips reads them back from the "Duck down"
// and "Duck up" animations): an earlier dip stays at its own volume and fades unless a span of the
// new call plays inside it; replace:true removes them all first. Fade in and fade out are plain
// add_animation Volume animations (from {volume: 0}).
//
// The volume the dip leaves and returns to is read from the layer's other animations at that
// moment (animation.js volumeAt). A Volume animation that starts inside a dip takes over from the
// dip, because the latest started animation sets the value (animation.js applyOperations).
// An under layer with no mediaSourceDuration or mediaDuration counts as playing to the scene's
// end (kino cannot know where its file ends), and the report's note says so.
//
// A voice follows its words, not its clip: the agent service puts each under layer's saved word
// transcript in as `speech` {layerId: transcript} (backend/agent/service.mjs), and that layer's
// stretches become the times it speaks, with pauses under SPEECH_GAP seconds kept ducked (the
// music comes back up in longer gaps). A clip of 13 s with 4 s of talk dips for the talk only. A
// measured layer without a transcript dips while it is loud (loudSpans); an unmeasured one for its clip.
//
// The report's `summary` says the same as `times` in words, with the under layers each dip covers,
// such as "music ducked to 0.3 at 0.2-7.4 s (line-a, line-c) and 10.9-14.9 s (line-b)", so a
// dip that joins two lines does not look like a line that was missed.
import { animatesVolume, volumeAt } from "./animation.js";
import { uid } from "./model.js";
import { effectiveMediaDuration, mediaPlaybackRange } from "./playback.js";
import { audibleRanges } from "./videoSound.js";
import { plainWord, speechWords } from "./speech.js";
import { FIT_NAMES } from "./fitMusic.js";
import { clearVolume, duckDepth, energyMean, heardLoudness, leveledLoudness, leveledVoice, lineWays,loudestHeard, loudnessOver, sectionCues, voiceLines, waysText, VOICE_OVER_BED, VOICE_OVER_MUSIC, VOICE_TARGET_LUFS } from "./mixLevels.js";
import { breakAfter, spokenWords, withPauses } from "./quality/rules/speech.js";
import { round } from "./numbers.js";
import { churnRun } from "./quality/rules/sound.js";

export const DUCK_NAMES = Object.freeze({ down: "Duck down", up: "Duck up" });
const SOUND_TYPES = new Set(["audio", "video"]);
const MAX_FADE_SECONDS = 10;
// The longest gap (s, between one dip's fade up and the next one's fade down) that churning
// default dips are joined across; a guess, not measured by listening.
export const JOIN_MAX_GAP = 3;
// A default dip longer than this (seconds) goes no deeper than LONG_DIP_DB under the level it
// leaves, unless a measured line in it needs it deeper to stay VOICE_OVER_BED LU over the music.
export const LONG_DIP = 2;
export const LONG_DIP_DB = -8;
const LONG_DIP_RATIO = 10 ** (LONG_DIP_DB / 20);
// A default dip never goes under this share of the level it leaves (-20 dB): music that nearly
// vanishes under one quiet line sounds broken. A line still under the music there is named.
export const DIP_FLOOR = 0.1;
// Pauses in a voice shorter than this stay inside one dip (the music does not pump between words);
// in longer gaps the music comes back up.
export const SPEECH_GAP = 1.2;
// A fade back up never takes less than this (seconds): kino's bed_jump reads a volume step shorter
// than its 0.3 s window as a jump (a dip cut short at a drop jumped 17.4 LU in 0.14 s).
export const RAMP_MIN = 0.3;
// A rise in the song is read over this long on each side (seconds): one momentary window.
const RISE_WINDOW = 0.4;
// The music comes back up between two dips whenever the two ramps fit in the gap and leave it up
// RAMP_MIN, a moment the ear hears (a 0.05 s touch at full is a blip). It was 3 s: a 2 s gap between
// two lines stayed ducked and left a hole in the song (.scratch dm2 a, FRICTION 8).
export const MIN_UP = RAMP_MIN;
// A dip that would cross the song's drop (a cue named drop, fit_music's song-drop-<n>) ends before it.
const DROP = /^(?:section-|song-)?drop\b/i;
// The default fades: quick down, slow back up.
export const DUCK_FADES = Object.freeze({ down: 0.15, up: 0.8 });
// The shortest animation the model keeps; a fade of 0 is a cut this long.
const SHORTEST = 0.001;
// The report lists at most this many dips; `dips` still counts them all.
const MAX_REPORTED = 20;
// The summary names at most this many dips ("and N more") and under layers a dip ("+N").
const SUMMARY_DIPS = 4;
const SUMMARY_NAMES = 3;
// Times and volumes are kept to three decimals (milliseconds for times).

function fail(message) {
  throw new Error(`duck_audio: ${message}`);
}

const isDuck = (animation) => animation?.name === DUCK_NAMES.down || animation?.name === DUCK_NAMES.up;
const isFitFade = (animation) => animation?.name === FIT_NAMES.in || animation?.name === FIT_NAMES.out;

/**
 * `layer` as it plays without duck_audio's dips: its Duck animations left out, and fit_music's Fit in
 * and Fit out, which a dip over them set to the dipped level, set back to the level they meet
 * (as applyDuckAudio rebuilds them). keep_line measures the music it dips from this.
 */
export function withoutDips(layer) {
  const kept = (layer.animations ?? []).filter((animation) => !isDuck(animation));
  const bare = { ...layer, animations: kept.filter((animation) => !isFitFade(animation)) };
  return { ...layer, animations: kept.map((animation) => {
    if (animation.name === FIT_NAMES.in) return { ...animation, to: { ...animation.to, volume: round(volumeAt(bare, animation.start + animation.duration)) } };
    if (animation.name === FIT_NAMES.out) return { ...animation, from: { ...animation.from, volume: round(volumeAt(bare, animation.start)) } };
    return animation;
  }) };
}

// A song cut by fit_music is several pieces (fitMusic.js): <layer>, <layer>-2, ... They duck
// together, so ducking any one of them ducks them all.
function fitPieces(scene, layer) {
  const head = layer.fitMusic ?? (scene.layers.some((item) => item.fitMusic === layer.id) ? layer.id : null);
  return head ? scene.layers.filter((item) => item.id === head || item.fitMusic === head) : [layer];
}

// The stretches of scene time in which `layer` can be heard.
function soundSpans(layers, layer, sceneDuration) {
  if (layer.type === "video") return audibleRanges(layers, layer, sceneDuration);
  const range = mediaPlaybackRange(layer, sceneDuration);
  return range ? [range] : [];
}

// The stretches of `spans` in which the voice says words (`transcript` of its file), pauses under
// SPEECH_GAP joined. Null when the transcript cannot be placed (a voice at another speed).
function spokenSpans(scene, layer, transcript, spans) {
  let words;
  try { words = speechWords(scene, [layer], transcript); } catch { return null; }
  const said = words.filter((word) => !word.unclear && plainWord(word.text) && !/[[\]()♪]/.test(word.text) && word.end > word.start);
  const runs = [];
  for (const word of said) {
    const last = runs.at(-1);
    if (last && word.start - last.end < SPEECH_GAP) { last.end = Math.max(last.end, word.end); last.word = word; }
    else runs.push({ start: word.start, end: word.end, word });
  }
  // Each span keeps its run's last word (a dip held to the end of a word that runs past the drop).
  return runs.flatMap((run) => spans.map((span) => ({ ...span, start: Math.max(span.start, run.start), end: Math.min(span.end, run.end),
    ...(run.end <= span.end ? { lastWord: { text: String(run.word.text).trim(), start: run.word.start, end: run.word.end } } : {}) }))).filter((span) => span.end > span.start);
}

// Ducking for any trigger, ported from ArtCraft FilmCraft, filmcraft/crates/audio-dsp/src/ducking.rs
// (`activity`; MIT OR Apache-2.0, (c) the ArtCraft authors). A sound with no transcript (a sound
// effect, a voice not transcribed) ducks the music while it is loud, not for its whole clip: its
// measured loudness (the file's momentary curve, its volume applied) over LOUD_LUFS, gaps under
// LOUD_GAP bridged, then stretches under LOUD_SHORTEST dropped. FilmCraft's envelope is RMS dBFS
// every 10 ms; kino reads the same file's ebur128 curve (100 ms steps) that the depth uses.
export const LOUD_LUFS = -44;
const LOUD_GAP = 0.25;
const LOUD_SHORTEST = 0.1;
// Each loud stretch is widened by half the curve's 400 ms window on both sides: a value is the
// mean of 0.2 s either side of its time, so a hit that starts at 2.0 s reads loud from about 2.2 s.
const LOUD_WINDOW_HALF = 0.2;

// The stretches of `spans` (scene seconds) in which `layer` playing `curve` over its Play `range`
// is louder than LOUD_LUFS. Null when there is no curve to read.
export function loudSpans(curve, layer, range, spans) {
  if (!Array.isArray(curve?.momentary) || !(curve.step > 0) || !range) return null;
  const gain = 20 * Math.log10(Math.max(1e-6, layer.volume ?? 1));
  const runs = [];
  for (let time = range.start; time < range.end; time += curve.step) {
    const value = curve.momentary[Math.floor((range.offset + (time - range.start)) / curve.step)];
    if (!(Number.isFinite(value) && value + gain > LOUD_LUFS)) continue;
    const end = Math.min(range.end, time + curve.step);
    const last = runs.at(-1);
    if (last && time - last.end < LOUD_GAP) last.end = end;
    else runs.push({ start: time, end });
  }
  const loud = runs.filter((run) => run.end - run.start >= LOUD_SHORTEST)
    // Within one window of the clip's start or end, the curve cannot tell: the clip's edge counts.
    .map((run) => ({
      start: run.start - range.start <= 2 * LOUD_WINDOW_HALF ? range.start : run.start - LOUD_WINDOW_HALF,
      end: range.end - run.end <= 2 * LOUD_WINDOW_HALF ? range.end : run.end + LOUD_WINDOW_HALF,
    }));
  return loud.flatMap((run) => spans.map((span) => ({ ...span, start: Math.max(span.start, run.start), end: Math.min(span.end, run.end) }))).filter((span) => span.end > span.start);
}

/**
 * The dips for `spans` ({start, end, name?} in scene seconds): each one starts `fade` seconds
 * before its stretch and ends `fadeUp` seconds after it (`fade` when not given), inside
 * 0..sceneDuration. Stretches whose fades would leave the music up under MIN_UP seconds are joined, unless a section cue time in
 * `breaks` falls between them: then the first gets upBy and the next downFrom (the cue), where
 * their fades must stop. Returns sorted [{ start, end, names?, upBy?, downFrom? }] of the
 * stretches themselves; `names` lists the names of the spans in each, when the spans have them.
 */
export function duckStretches(spans, fade, sceneDuration, fadeUp = fade, breaks = [], join = 0) {
  const sorted = spans
    .map((span) => ({ ...span, start: Math.max(0, span.start), end: Math.min(sceneDuration, span.end) }))
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start);
  const joined = [];
  // Stretches that hold a span of this call (not only earlier dips).
  const fresh = new Set();
  for (const { name, voice, unlined, earlier, ramps, ...span } of sorted) {
    let last = joined.at(-1);
    const cue = last && breaks.find((time) => time >= last.end && time <= span.start);
    // An earlier dip keeps its own fades; the music comes back up whenever the two ramps fit in the gap.
    const up = last?.ramps?.fadeUp ?? fadeUp;
    const down = ramps?.fade ?? fade;
    // `join`: stretches this close are one dip as well (the ramps keep their own lengths).
    if (last && cue == null && span.start - down < last.end + Math.max(up, join) + MIN_UP) {
      last.end = Math.max(last.end, span.end);
      if (earlier === undefined || last.ramps !== ramps) delete last.ramps;
    } else {
      if (cue != null && span.start - down <= last.end + up) { last.upBy = cue; span.downFrom = cue; }
      joined.push(last = { ...span, ...(ramps ? { ramps } : {}) });
    }
    if (name && !(last.names ??= []).includes(name)) last.names.push(name);
    if (Number.isFinite(voice)) last.voice = Math.min(last.voice ?? Infinity, voice);
    if (Number.isFinite(unlined)) last.unlined = Math.min(last.unlined ?? Infinity, unlined);
    if (earlier !== undefined) last.earlier = Math.min(last.earlier ?? Infinity, earlier);
    else fresh.add(last);
  }
  for (const stretch of joined) {
    if (stretch.earlier !== undefined && !fresh.has(stretch)) stretch.onlyEarlier = true;
    else delete stretch.ramps;
  }
  return joined;
}

/**
 * The dips duck_audio made earlier on `layer`, read back from its "Duck down" and "Duck up"
 * animations: [{start, end (the stretch, without fades), earlier (its volume), ramps: {fade, fadeUp}}].
 */
export function earlierDips(layer, sceneDuration) {
  const marks = (layer.animations ?? []).filter(isDuck).sort((left, right) => left.start - right.start);
  const dips = [];
  let open = null;
  for (const mark of marks) {
    if (mark.name === DUCK_NAMES.down) {
      if (open) dips.push({ ...open, end: mark.start, ramps: { ...open.ramps, fadeUp: 0 } });
      open = { start: mark.start + mark.duration, earlier: mark.to?.volume ?? 1, ramps: { fade: mark.duration } };
    } else {
      const from = open ?? { start: 0, earlier: mark.from?.volume ?? 1, ramps: { fade: 0 } };
      dips.push({ ...from, end: mark.start, ramps: { ...from.ramps, fadeUp: mark.duration } });
      open = null;
    }
  }
  if (open) dips.push({ ...open, end: sceneDuration, ramps: { ...open.ramps, fadeUp: 0 } });
  return dips.filter((dip) => dip.end > dip.start).map((dip) => ({ ...dip, earlier: round(dip.earlier) }));
}

// The parts of `dip` ({start, end}) outside `spans`, each longer than SHORTEST: [{start, end}].
function outsideSpans(dip, spans) {
  const parts = [];
  let from = dip.start;
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    if (span.start > from) parts.push({ start: from, end: Math.min(span.start, dip.end) });
    from = Math.max(from, span.end);
  }
  if (dip.end > from) parts.push({ start: from, end: dip.end });
  return parts.filter((part) => part.end - part.start > SHORTEST);
}

// True when a sound layer other than `own` (the ducked song's pieces) is heard (volume over 0.01)
// for RAMP_MIN seconds or more inside `part`, sampled every 0.05 s.
function heardElsewhere(scene, own, part) {
  return scene.layers.some((other) => SOUND_TYPES.has(other.type) && !own.includes(other) &&
    soundSpans(scene.layers, other, scene.duration).some((span) => {
      let heard = 0;
      for (let time = Math.max(span.start, part.start); time < Math.min(span.end, part.end); time += 0.05) if (volumeAt(other, time) > 0.01) heard += 0.05;
      return heard >= RAMP_MIN - 1e-6;
    }));
}

// The stretches keep_line kept on `layer` ([{start, end}], scene s), read from its "Line up"/"Sound up"
// and "Line down"/"Sound down" Volume animations (keepLine.js LINE_NAMES; read here to keep the
// import one way). Empty for a layer keep_line never touched.
export function keepLineStretches(layer) {
  const marks = (layer.animations ?? []).filter((animation) => /^(?:Line|Sound) (?:up|down)$/.test(animation?.name ?? "")).sort((a, b) => a.start - b.start);
  const stretches = [];
  let open = null;
  for (const mark of marks) {
    if (/ up$/.test(mark.name)) open = mark.start + mark.duration;
    else { stretches.push({ start: open ?? 0, end: mark.start }); open = null; }
  }
  if (open !== null) stretches.push({ start: open, end: Infinity });
  return stretches.filter((stretch) => stretch.end > stretch.start);
}

// The same numbers as `times` (milliseconds), so the words never say a dip ends before it does:
// toFixed(1) wrote 6.85 as "6.8" and 11.35 as "11.3".
const seconds = (value) => String(round(value));
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const listed = (parts) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

// "music ducked to 0.3 at 0.2-7.4 s (line-a, line-c) and 10.9-14.9 s (line-b)". `dips` are
// [{ start, end, names }], from the start of the fade down to the end of the fade up.
function duckSummary(name, to, dips) {
  if (!dips.length) return `${name} is not ducked: none of the under layers is heard in the scene`;
  // Long dips held shallower (LONG_DIP) show their own level, unless every dip shares one.
  if (dips.every((dip) => dip.level === dips[0].level)) to = dips[0].level;
  const parts = dips.slice(0, SUMMARY_DIPS).map(({ start, end, names = [], level }) => {
    const covers = names.length > SUMMARY_NAMES ? `${names.slice(0, SUMMARY_NAMES).join(", ")} +${names.length - SUMMARY_NAMES}` : names.join(", ");
    const held = level !== to ? `to ${level}` : "";
    const inside = [covers, held].filter(Boolean).join("; ");
    return `${seconds(start)}-${seconds(end)} s${inside ? ` (${inside})` : ""}`;
  });
  const more = dips.length - SUMMARY_DIPS;
  return `${name} ducked to ${to} at ${more > 0 ? `${parts.join(", ")} and ${more} more` : listed(parts)}`;
}

/** Applies duck_audio to `document` (changed in place). Returns a short report. */
export function applyDuckAudio(document, operation) {
  // Without `to` or fadeUp, a dip per line can make the song churn (volume_churn: 3 turns in 10 s).
  // Then the dips are one dip under the whole spoken stretch when that does not churn, and the
  // receipt's joined says so. A given `to` or fadeUp and keep_line's own dips stay as made.
  if (operation.to !== undefined || operation.fadeUp !== undefined || operation.ownLine) return duckOnce(document, operation);
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  const layer = scene?.layers.find((item) => item.id === operation.layerId);
  if (!layer || !SOUND_TYPES.has(layer.type)) return duckOnce(document, operation);
  const pieces = fitPieces(scene, layer);
  const saved = pieces.map((piece) => [piece, piece.animations]);
  const before = churnRun(layer, scene);
  const report = duckOnce(document, operation);
  const churn = before ? null : churnRun(layer, scene);
  if (!churn || !(report.times?.length > 1)) return report;
  const made = pieces.map((piece) => [piece, piece.animations]);
  const gap = Math.max(...report.times.slice(1).map((time, index) => time[0] - report.times[index][1]));
  // A longer gap lets the song be heard at full between the lines: those dips stay apart.
  if (gap > JOIN_MAX_GAP) return report;
  const fadeUp = operation.fade ?? DUCK_FADES.up;
  for (const [piece, animations] of saved) piece.animations = animations;
  const one = duckOnce(document, { ...operation, join: round(fadeUp + gap + 0.05) });
  if (churnRun(layer, scene) || one.dips >= report.dips) {
    for (const [piece, animations] of made) piece.animations = animations;
    return report;
  }
  const spread = round(churn.at(-1).time - churn[0].time, 1);
  return { ...one, joined: `a dip per line would turn ${layer.name}'s level ${churn.length} times in ${spread} s (volume_churn), so the lines share ${plural(one.dips, "dip")} instead of ${report.dips} (a given to or fadeUp keeps a dip per line)` };
}

function duckOnce(document, operation) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  if (!layer) fail(`layer ${operation.layerId} was not found.`);
  if (!SOUND_TYPES.has(layer.type)) fail(`"${layer.name}" is a ${layer.type} layer and has no sound; duck an audio or video layer.`);
  const fade = operation.fade ?? DUCK_FADES.down;
  const fadeUp = operation.fadeUp ?? (operation.fade ?? DUCK_FADES.up);
  if (operation.to !== undefined && (typeof operation.to !== "number" || !(operation.to >= 0 && operation.to <= 1))) fail("to is the volume during a dip, a number from 0 to 1.");
  for (const [name, value] of [["fade", fade], ["fadeUp", fadeUp]])
    if (typeof value !== "number" || !(value >= 0 && value <= MAX_FADE_SECONDS))
      fail(`${name} is the seconds ${name === "fade" ? "each fade down" : "each fade back up"} takes, a number from 0 to ${MAX_FADE_SECONDS}.`);
  if (!Array.isArray(operation.under) || operation.under.length === 0)
    fail("under lists the layers that play over this one, such as a voice-over: under:[\"voice\"].");
  const pieces = fitPieces(scene, layer);
  const spans = [];
  // How loud the voices are as heard (LUFS), for the depth.
  const voiceLevels = [];
  // Each measured spoken line [{start, end (scene s), lufs}], measured like voice_under_bed, and
  // the loudness of measured voices without lines (no transcript, or not leveled).
  const lines = [];
  const unlined = [];
  // Voices heard with no measurement at all: the receipt cannot promise they are clear.
  let unmeasured = 0;
  // Under layers whose length kino does not know count as playing to the scene's end.
  const untimed = [];
  // Under layers ducked for their words (a transcript), not their clip.
  const byWords = [];
  // Under layers without words ducked while they are loud (their measured loudness).
  const byLoudness = [];
  // Stretches keep_line kept on an under layer: [{start, end, layer}], left as keep_line set them.
  const keptLines = [];
  for (const id of new Set(operation.under)) {
    const other = scene.layers.find((item) => item.id === id);
    if (!other) fail(`under: layer ${id} was not found in scene ${scene.id}.`);
    if (other.id === layer.id || pieces.includes(other)) fail("under: a layer cannot duck under itself (or another piece of its song).");
    if (!SOUND_TYPES.has(other.type)) fail(`under: "${other.name}" is a ${other.type} layer and has no sound.`);
    // A layer at volume 0 with no Volume animation is never heard.
    if ((other.volume ?? 1) === 0 && !animatesVolume(other)) continue;
    // keep_line already set the music under this layer's kept lines from its measurements (a dip, a
    // shared bed, a lift or a return on a cue), and the rest of the layer is silent: a plain
    // duck_audio keeps what it set (replace:true rebuilds it).
    const keptHere = operation.ownLine || operation.replace === true ? [] : keepLineStretches(other);
    if (keptHere.length) { keptLines.push(...keptHere.map((stretch) => ({ ...stretch, layer: other }))); continue; }
    const heard = soundSpans(scene.layers, other, scene.duration).map((span) => ({ ...span, name: other.name }));
    const transcript = operation.speech?.[other.id];
    const spoken = Array.isArray(transcript?.words) ? spokenSpans(scene, other, transcript, heard) : null;
    if (spoken) byWords.push(other.name);
    // A voice with a transcript is leveled to VOICE_TARGET_LUFS at export; another sound counts as measured.
    const range = mediaPlaybackRange(other, scene.duration);
    // Without words, a measured sound ducks while it is loud (loudSpans), not for its whole clip.
    const loud = spoken ? null : loudSpans(operation.levels?.[other.id], other, range, heard);
    // The report names it only when its dips are shorter than its clip.
    const length = (list) => list.reduce((sum, span) => sum + span.end - span.start, 0);
    if (loud && length(loud) < length(heard) - 0.05) byLoudness.push(other.name);
    const mine = spoken ?? loud ?? heard;
    const curve = operation.levels?.[other.id];
    const words = spoken && curve && range && leveledVoice(other) ? spokenWords(withPauses(transcript.words)).filter((word) => word.end > range.offset && word.start < range.offset + range.duration) : [];
    // A leveled voice counts at the level the render gives it (leveledLoudness: -16 LUFS unless
    // leveling's 12 dB limit leaves it off that); without its curve, at VOICE_TARGET_LUFS.
    const measured = spoken && leveledVoice(other)
      ? leveledLoudness(curve, words.map((word) => ({ start: word.start, end: word.end }))) ?? VOICE_TARGET_LUFS
      : range ? loudnessOver(curve, [{ start: range.offset, end: range.offset + range.duration }]) : null;
    const heardAt = measured != null ? measured + 20 * Math.log10(Math.max(1e-6, other.volume ?? 1)) : null;
    if (heardAt != null) voiceLevels.push(heardAt);
    const said = words.length >= 2 ? voiceLines(curve, other, range, words, breakAfter) : [];
    lines.push(...said.map((line) => ({ ...line, name: other.name, text: line.words.map((word) => String(word.text).trim()).join(" ") })));
    if (!said.length) { if (heardAt != null) unlined.push(heardAt); else if (heard.length) unmeasured += 1; }
    // Each span carries its own voice's level, so each dip is as deep as the voice in it needs. A
    // line keep_line leveled (voiceLevel) is heard at that level.
    const gain = 20 * Math.log10(Math.max(1e-6, other.volume ?? 1));
    const lineLevel = Number.isFinite(other.voiceLevel) ? other.voiceLevel + gain : heardAt;
    spans.push(...mine.map((span) => ({ ...span, layer: other, lineLevel,
      ...(heardAt != null ? { voice: heardAt, ...(said.length ? {} : { unlined: heardAt }) } : {}) })));
    if (!spoken && effectiveMediaDuration(other) === Infinity) untimed.push(other.name);
  }

  const sections = sectionCues(document.cues);
  // A default dip (no `to`, or keep_line's own) ends before the song's drop, so the drop plays at
  // full: a span that runs into it stops there, and its fade up is done by it.
  const stop = operation.to === undefined || operation.payoffStop === true;
  const drops = stop ? sections.filter((cue) => DROP.test(String(cue.name))).map((cue) => cue.time) : [];
  // The song as it plays without duck_audio's dips (the first piece's file; fit_music's pieces are one song).
  const first = { ...layer, animations: (layer.animations ?? []).filter((animation) => !isDuck(animation) && !isFitFade(animation)) };
  const own = mediaPlaybackRange(layer, scene.duration);
  const songCurve = operation.levels?.[layer.id];
  const ceiling = own ? loudestHeard(songCurve, first, own) : null;
  // Without `to`: a measured line already VOICE_OVER_BED LU or more over the song as it plays there,
  // at its own level (lineWays: no dip needed and no lift), gets no dip.
  const clear = [];
  const audible = [];
  for (const span of spans) {
    if (operation.to === undefined && !operation.ownLine && own && Number.isFinite(span.lineLevel)) {
      const under = heardLoudness(songCurve, first, own, span.start, span.end);
      const way = lineWays({ line: span.lineLevel, under, ceiling });
      if (way && way.lift.short === 0 && way.lift.db <= 0) { clear.push({ span, over: round(span.lineLevel - under, 1) }); continue; }
    }
    audible.push(span);
  }
  const crossed = [];
  const ducked = [];
  // Lines whose last word runs past the drop: the dip holds to that word's end, then rises in RAMP_MIN.
  const heldPast = [];
  for (const span of audible) {
    const cue = drops.find((time) => time > span.start && time < span.end);
    if (cue === undefined) { ducked.push(span); continue; }
    const word = span.lastWord;
    if (word && word.start < cue && word.end > cue && Math.abs(word.end - span.end) < 1e-6) { ducked.push(span); heldPast.push({ span, cue }); continue; }
    crossed.push({ span, cue });
    if (cue - span.start >= RAMP_MIN + 0.1) ducked.push({ ...span, end: cue });
  }
  // Earlier dips on the layer stay (a later keep_line or duck_audio adds its dips), except where a
  // span of this call plays (it sets that dip again) or with replace:true.
  const inside = (dip) => ducked.filter((span) => span.start < dip.end && span.end > dip.start);
  const earlier = operation.replace === true ? [] : earlierDips(pieces[0], scene.duration);
  const kept = earlier.filter((dip) => !inside(dip).length);
  // keep_line (ownLine): a dip this line shares with a close earlier line is cut around this line,
  // and its parts where another sound is still heard (that earlier line) dip with this one.
  const rest = operation.ownLine ? earlier.filter((dip) => inside(dip).length).flatMap((dip) => outsideSpans(dip, inside(dip)))
    .filter((part) => heardElsewhere(scene, [layer, ...pieces], part)) : [];
  const stretches = duckStretches([
    ...ducked.map(({ start, end, name, voice, unlined }) => ({ start, end, ...(name ? { name } : {}), voice, unlined })),
    ...rest,
    ...kept,
  ], fade, scene.duration, fadeUp, sections.map((cue) => cue.time), operation.join ?? 0);
  for (const stretch of stretches) {
    const cue = stretch.onlyEarlier ? undefined : drops.find((time) => time >= stretch.end - 1e-6 && time < stretch.end + fadeUp);
    if (cue !== undefined) stretch.upBy = Math.min(stretch.upBy ?? Infinity, cue);
    // Held to the end of a last word past the drop: back up RAMP_MIN after it.
    if (!stretch.onlyEarlier && heldPast.some(({ span }) => Math.abs(span.end - stretch.end) < 1e-6)) stretch.upBy = Math.min(stretch.upBy ?? Infinity, stretch.end + RAMP_MIN);
  }
  // Without `to`: each dip puts the music VOICE_OVER_MUSIC LU under the quietest voice in it, from
  // the music's measured loudness under that dip.
  const musicUnder = (stretch) => (own && operation.to === undefined
    ? loudnessOver(operation.levels?.[layer.id], [{ start: own.offset + (stretch.start - own.start), end: own.offset + (stretch.end - own.start) }])
    : null);
  const fresh = stretches.filter((stretch) => !stretch.onlyEarlier);
  const depths = new Map(fresh.map((stretch) => [stretch, Number.isFinite(stretch.voice) ? duckDepth(stretch.voice, musicUnder(stretch), Math.max(volumeAt(first, stretch.start), 0.02)) : null]));
  const measuredDepths = [...depths.values()].filter((value) => value != null);
  const depth = measuredDepths.length ? Math.min(...measuredDepths) : null;
  const to = operation.to ?? depth ?? 0.25;
  const toFor = (stretch) => (stretch.onlyEarlier ? stretch.earlier : operation.to ?? depths.get(stretch) ?? depth ?? 0.25);
  // The loudest each dip may stay for every measured line in it to be heard VOICE_OVER_BED LU
  // over the music (only without `to`: a given `to` is the agent's choice).
  const songPieces = pieces.map((piece) => ({ layer: piece, range: mediaPlaybackRange(piece, scene.duration) })).filter((piece) => piece.range);
  // {clear, needs: [{line, volume}]}: the volume, and what each measured line in the dip needs.
  const clearFor = (stretch) => {
    const needs = [];
    if (operation.to !== undefined || stretch.onlyEarlier) return { clear: Infinity, needs };
    const music = musicUnder(stretch);
    let clear = depths.get(stretch) != null && Number.isFinite(stretch.unlined) && music != null ? round(10 ** ((stretch.unlined - VOICE_OVER_BED - music) / 20)) : Infinity;
    for (const line of lines) {
      if (line.end <= stretch.start || line.start >= stretch.end) continue;
      const volume = clearVolume(songCurve, songPieces, line.lufs, line.start, line.end);
      if (volume != null) { clear = Math.min(clear, volume); needs.push({ line, volume }); }
    }
    return { clear, needs };
  };
  const clears = stretches.map(clearFor);
  // The earlier dips go first, so the volume around each new dip is the layer's own. A
  // fit_music crossfade inside a dip fades to the ducked level, not back up to full.
  const dips = [];
  // Lines still under VOICE_OVER_BED at a dip's floor: the voice must come up, not the music down.
  const buried = [];
  // A dip stopped at its floor short of what a voice needs (named in `buried` when it is a line).
  let floored = false;
  for (const [index, piece] of pieces.entries()) {
    const kept = (piece.animations ?? []).filter((animation) => !isDuck(animation));
    const base = { ...piece, animations: kept.filter((animation) => !isFitFade(animation)) };
    const added = [];
    for (const [number, stretch] of stretches.entries()) {
      // An earlier dip alone keeps its own fades and volume.
      const ramps = stretch.onlyEarlier ? stretch.ramps ?? { fade, fadeUp } : { fade, fadeUp };
      const downStart = round(Math.max(0, stretch.start - ramps.fade, stretch.downFrom ?? 0));
      const left = volumeAt(base, downStart);
      const target = toFor(stretch);
      // A given `to` is kept. A default long dip stays within LONG_DIP_DB of the level it leaves;
      // any default dip goes deeper when a measured line in it needs that to stay clear, down to
      // DIP_FLOOR of the level it leaves.
      const chosen = operation.to !== undefined || stretch.onlyEarlier;
      const long = !chosen && stretch.end - stretch.start > LONG_DIP;
      const gentle = long ? Math.max(target, Math.min(left, round(left * LONG_DIP_RATIO))) : target;
      const floor = chosen ? 0 : round(left * DIP_FLOOR);
      // A default dip never raises the music (a bed already turned down under `to` there).
      const made = chosen ? Math.max(Math.min(gentle, clears[number].clear), floor) : Math.min(round(left), Math.max(Math.min(gentle, clears[number].clear), floor));
      // A dip joined with an earlier one goes as deep as the deeper of the two.
      const level = stretch.earlier !== undefined ? Math.min(made, stretch.earlier) : made;
      const under = clears[number].needs.filter((need) => need.volume < level).map((need) => need.line);
      added.push({
        id: uid(), name: DUCK_NAMES.down, kind: "custom", easing: "smooth",
        start: downStart, duration: Math.max(SHORTEST, round(stretch.start - downStart)),
        from: { volume: round(left) }, to: { volume: level },
      });
      let end = stretch.end;
      if (stretch.end < scene.duration - SHORTEST) {
        // Cut short by a section cue, the fade up still takes RAMP_MIN, ending on the cue.
        const by = stretch.upBy ?? Infinity;
        const upStart = Number.isFinite(by) ? Math.max(stretch.start, Math.min(stretch.end, by - RAMP_MIN)) : stretch.end;
        end = round(Math.min(scene.duration, stretch.end + ramps.fadeUp, by));
        added.push({
          id: uid(), name: DUCK_NAMES.up, kind: "custom", easing: "smooth",
          start: round(upStart), duration: Math.max(SHORTEST, round(end - upStart)),
          from: { volume: level }, to: { volume: round(volumeAt(base, end)) },
        });
      }
      if (index === 0) {
        dips.push({ start: downStart, end: round(end), hold: stretch.end, names: stretch.names ?? (stretch.onlyEarlier ? ["earlier"] : undefined), level, earlier: stretch.onlyEarlier === true, held: !stretch.onlyEarlier && level > target, deeper: !stretch.onlyEarlier && level < gentle && !under.length });
        for (const line of under) if (!buried.includes(line)) buried.push(line);
        if (clears[number].clear < level) floored = true;
      }
    }
    const level = { ...base, animations: [...base.animations, ...added] };
    piece.animations = [...kept.map((animation) => {
      if (animation.name === FIT_NAMES.in) return { ...animation, to: { ...animation.to, volume: round(volumeAt(level, animation.start + animation.duration)) } };
      if (animation.name === FIT_NAMES.out) return { ...animation, from: { ...animation.from, volume: round(volumeAt(level, animation.start)) } };
      return animation;
    }), ...added];
  }
  // A section change of the song (a cue named drop, break, chorus..., or fit_music's song-drop-1) heard under a dip.
  // A dip whose fade down starts on the cue covers it too (the change lands as the music goes down);
  // a cue a held last word runs past is reported with its rise in payoff instead.
  const covered = sections.filter((cue) => !heldPast.some((item) => item.cue === cue.time) && dips.some((dip) => dip.start <= cue.time + 1e-6 && cue.time < dip.hold));
  // Section cues that kept two dips apart, so the song's change is heard at full (not one a dip starts on).
  const apart = sections.filter((cue) => !covered.includes(cue) && stretches.some((stretch) => stretch.upBy === cue.time));
  // A line that runs into the drop: its dip ended before it. Measured: the line over the song there
  // (at full), and the volume that would lift the line VOICE_OVER_BED LU over it instead.
  const payoff = [];
  for (const { span, cue } of crossed) {
    const songAt = energyMean(songPieces.map(({ layer: piece, range }) => heardLoudness(songCurve, piece, range, cue, span.end)).filter((value) => value !== null));
    const over = Number.isFinite(span.lineLevel) && songAt !== null ? round(span.lineLevel - songAt, 1) : null;
    const factor = over !== null && over < VOICE_OVER_BED ? 10 ** ((VOICE_OVER_BED - over) / 20) : null;
    const name = span.layer.name;
    const text = `the dip under ${name} ends by the song's drop at ${seconds(cue)} s, so the drop plays at full`
      + (over === null ? "" : `; ${name} is ${over >= 0 ? "+" : ""}${over} LU over the song there (measured)`)
      + (factor === null ? "" : `: volume ${round((span.layer.volume ?? 1) * factor, 2)} on ${name} (x${round(factor, 2)}) lifts it ${VOICE_OVER_BED} LU over`);
    if (!payoff.includes(text)) payoff.push(text);
  }
  // A last word that runs past the drop holds the dip to its end; the rise after it, measured on the
  // song as it now plays (RISE_WINDOW each side of the fade up).
  for (const { span, cue } of heldPast) {
    const before = own ? heardLoudness(songCurve, layer, own, span.end - RISE_WINDOW, span.end) : null;
    const after = own ? heardLoudness(songCurve, layer, own, span.end + RAMP_MIN, span.end + RAMP_MIN + RISE_WINDOW) : null;
    const rise = before !== null && after !== null ? round(after - before, 1) : null;
    payoff.push(`the dip under ${span.layer.name} holds to the end of its last word "${span.lastWord.text}" at ${seconds(span.end)} s, ${round(span.end - cue, 2)} s past the song's drop at ${seconds(cue)} s, then comes up in ${RAMP_MIN} s`
      + (rise === null ? " (not measured)" : `: ${rise >= 0 ? "+" : ""}${rise} LU (${round(before, 1)} to ${round(after, 1)} LUFS, ${RISE_WINDOW} s each side, measured)`));
  }
  // Each line over the song each way kino can do it (mixLevels.js lineWays), measured with the song untouched.
  const ways = [];
  // A line cut at the drop is measured over its whole length (the drop included): crossed spans first.
  for (const span of [...crossed.map((item) => item.span), ...ducked, ...clear.map((item) => item.span)].sort((a, b) => a.start - b.start)) {
    if (!own || !Number.isFinite(span.lineLevel) || ways.some((way) => way.span.layer === span.layer && way.span.start === span.start)) continue;
    const under = heardLoudness(songCurve, first, own, span.start, span.end);
    const text = waysText(lineWays({ line: span.lineLevel, under, ceiling }), round(volumeAt(first, span.start)));
    if (text) ways.push({ span, text: `${span.layer.name} ${seconds(span.start)}-${seconds(span.end)} s: ${text}` });
  }
  const held = dips.filter((dip) => dip.held).length;
  const deeper = dips.filter((dip) => dip.deeper).length;
  // The receipt promises clear lines only when the music and every voice under the dips were measured.
  const promise = depth != null && (lines.length || unlined.length) && !unmeasured && !floored;
  // Dips at their own depths: the headline is the deepest one this call made (a measured depth
  // under a dip's floor is never the level heard), or the given `to`.
  const made = dips.filter((dip) => !dip.earlier).map((dip) => dip.level);
  const headline = operation.to ?? (made.length ? Math.min(...made) : to);
  const quoted = (line) => `"${line.text.length > 40 ? `${line.text.slice(0, 40)}...` : line.text}" (${line.name})`;
  return {
    layer: layer.name,
    to: dips.length && dips.every((dip) => dip.level === dips[0].level) ? dips[0].level : headline,
    dips: dips.length,
    summary: !dips.length && (clear.length || keptLines.length) ? `${layer.name} is not ducked: ${keptLines.length ? "keep_line already set it under the kept lines" : ""}${keptLines.length && clear.length ? "; " : ""}${clear.length ? "every line is clear of it as it plays" : ""}` : duckSummary(layer.name, headline, dips),
    ...(pieces.length > 1 ? { pieces: pieces.length } : {}),
    ...(dips.length ? { times: dips.slice(0, MAX_REPORTED).map((dip) => [dip.start, dip.end]) } : {}),
    ...(dips.length > MAX_REPORTED ? { more: dips.length - MAX_REPORTED } : {}),
    ...(byWords.length ? { words: `dips follow the words ${byWords.slice(0, 3).join(", ")}${byWords.length > 3 ? ` +${byWords.length - 3}` : ""} say${byWords.length === 1 ? "s" : ""} (pauses under ${SPEECH_GAP} s stay ducked), not ${byWords.length === 1 ? "its clip" : "their clips"}` } : {}),
    ...(byLoudness.length ? { loud: `dips follow when ${byLoudness.slice(0, 3).join(", ")}${byLoudness.length > 3 ? ` +${byLoudness.length - 3}` : ""} ${byLoudness.length === 1 ? "is" : "are"} loud (over ${LOUD_LUFS} LUFS, measured), not ${byLoudness.length === 1 ? "its clip" : "their clips"}` } : {}),
    ...(depth != null && operation.to === undefined && !held && !deeper ? { depth: `music ${VOICE_OVER_MUSIC} LU under the voice (measured)` } : {}),
    ...(held ? { held: `${plural(held, "dip")} over ${LONG_DIP} s ${held === 1 ? "stays" : "stay"} within ${-LONG_DIP_DB} dB of the music's level${promise ? `, each line still ${VOICE_OVER_BED} LU or more over it (measured)` : ""}` } : {}),
    ...(deeper ? { deeper: `${plural(deeper, "dip")} ${deeper === 1 ? "goes" : "go"} deeper so each line in ${deeper === 1 ? "it" : "them"} is ${VOICE_OVER_BED} LU or more over the music (measured)` } : {}),
    ...(buried.length ? { quiet: `${buried.slice(0, 2).map(quoted).join(", ")}${buried.length > 2 ? ` +${buried.length - 2}` : ""} ${buried.length === 1 ? "stays" : "stay"} under ${VOICE_OVER_BED} LU over the music with the dip at its floor (${DIP_FLOOR} of the music's level): raise that voice's volume, or split the line into its own clip so the export levels it alone` } : {}),
    ...(payoff.length ? { payoff: payoff.slice(0, 2).join(" · ") } : {}),
    ...(clear.length ? { clear: `no dip under ${clear.slice(0, 3).map(({ span, over }) => `${span.layer.name} ${seconds(span.start)}-${seconds(span.end)} s (${over >= 0 ? "+" : ""}${over} LU)`).join(", ")}${clear.length > 3 ? ` +${clear.length - 3}` : ""}: already ${VOICE_OVER_BED} LU or more over the song as it plays there (measured; ways: no dip needed); to:<volume> dips anyway` } : {}),
    ...(keptLines.length ? { keptLines: `keep_line set the music under ${keptLines.slice(0, 3).map(({ start, end, layer: other }) => {
      const at = (start + Math.min(end, scene.duration)) / 2;
      const now = round(volumeAt(layer, at));
      const how = now <= 0.001 ? "music out" : now >= round(volumeAt(first, at)) - 0.001 ? (Number.isFinite(other.voiceLevel) ? "song untouched, line lifted" : "song untouched") : `music at ${now}`;
      return `${other.name} ${seconds(start)}-${seconds(Math.min(end, scene.duration))} s (${how})`;
    }).join(", ")}${keptLines.length > 3 ? ` +${keptLines.length - 3}` : ""}, measured: kept; keep_line on that line again, or duck_audio {replace:true}, changes it` } : {}),
    ...(ways.length && !operation.ownLine ? { ways: [...ways.slice(0, 3).map((way) => way.text), ...(ways.length > 3 ? [`+${ways.length - 3} more`] : [])] } : {}),
    ...(apart.length ? { sections: `dips kept apart at the song's ${apart.slice(0, 3).map((cue) => `${cue.name} at ${seconds(cue.time)} s`).join(", ")}, so it is heard at full` } : {}),
    ...(covered.length ? { warning: `a dip covers the song's ${covered.slice(0, 3).map((cue) => `${cue.name} at ${seconds(cue.time)} s`).join(", ")}: the change is heard muffled under the voice; move the line off it, or end the line before it` } : {}),
    ...(untimed.length ? { note: `${untimed.slice(0, 3).join(", ")}: length unknown, so ducked to the scene's end; set mediaSourceDuration (the duration import answers) or mediaDuration, then run duck_audio again` } : {}),
  };
}
