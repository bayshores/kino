// Sound rules for what a human QC pass of a trailer heard while every check passed:
//   speech_fragment  a sound layer starts on the tail of a sentence said just before its in point
//                    ("uh, at school." after the ask was cut). speech_cut passes it: the cut falls
//                    between words, and whisper put a "?" before the tail
//   mute_word        a volume ramp that mutes or ducks a voice starts after the word it hides has
//                    begun, or comes back up before that word ends (a swear at 55.88 s, the mute at 56.06 s)
//   music_hard_stop  a song stops dead at full volume: no fade out, the music still loud there
//   no_music         a 10 s or longer video has no music (a first pass came out silent)
// And the mix, measured in LUFS once a full check has measured the files:
//   voice_under_bed     a spoken line less than 6 LU over the beds under it, or two of its words
//                       less than 3 LU over them ("your right." buried under street sound and the song)
//   bed_jump            the beds together rise more than 8 LU within 0.3 s at a cut (street sound at
//                       0.2 cut to the same street at 1.2)
//   volume_churn        a song or bed changes direction 3 times in 10 s (0.12, 0.25, 0.12, 0.25)
//   voice_level_spread  spoken lines more than 3 dB apart as heard
//   end_on_fade         the video ends on a fade while the song is still mid-phrase
// All are warnings. They read ctx.speech like the speech rules (engine/quality/rules/speech.js):
// without it (edit receipts) they do not run. music_hard_stop reads the songs' loudness
// (entries with music: true, backend/agent/quality.mjs heardSpeech).
import { animatesVolume, volumeAt } from "../../animation.js";
import { enabledAnimations } from "../../animationEnabled.js";
import { mediaPlaybackRange } from "../../playback.js";
import { isRemapped } from "../../mediaTime.js";
import { cuts, sec } from "../analysis.js";
import { area, dimmedAt, intersection, visibleBoxAt } from "../model.js";
import { coveredAt } from "../techniques.js";
import { blurred } from "./people.js";
import { levelBetween, soundLevels } from "../loudness.js";
import { FRAGMENT_WORDS, TALKING_BEFORE, breakAfter, continues, heardEdges, isFiller } from "./speech.js";
import { bedLoudness, energyMean, leveledVoice, sectionCues, voiceLines, VOICE_OVER_BED, VOICE_OVER_MUSIC } from "../../mixLevels.js";
import { round as round3 } from "../../numbers.js";

const said = (words) => words.map((word) => word.text.trim()).join(" ");

// ---------------------------------------------------------------- speech_fragment

// At or under this volume the tail is ducked low enough to pass as murmur.
const DUCKED = 0.25;
// A tail (FRAGMENT_WORDS, TALKING_BEFORE, continues) is defined in speech.js, so speech_cut's
// start fix walks back past one and the two rules agree.

/** speech_fragment: a layer that starts on the dangling end of a sentence said before it. */
export function speechFragment(model, ctx) {
  const scene = ctx.speechScene;
  if (!scene) return [];
  const edges = heardEdges(ctx);
  const findings = [];
  for (const edge of edges) {
    const { layer, transcript, range, words } = edge;
    if (!words?.length || edge.joinedIn) continue;
    const at = range.inSource;
    const firstIndex = words.findIndex((word) => word.end > at + 0.05);
    const previous = words[firstIndex - 1];
    if (firstIndex <= 0 || at - previous.end > TALKING_BEFORE) continue;
    // A clip of the same take on the same clock said the sentence before: nothing dangles in the mix.
    if (edge.carried(previous)) continue;
    // speech_cut already says it when the cut is inside the sentence's flow.
    if (at - previous.end <= 0.3 && !breakAfter(previous, words[firstIndex])) continue;
    let endIndex = firstIndex;
    while (endIndex < words.length - 1 && !breakAfter(words[endIndex], words[endIndex + 1])) endIndex += 1;
    const tail = words.slice(firstIndex, endIndex + 1);
    const last = tail.at(-1);
    if (tail.length > FRAGMENT_WORDS || last.end > range.outSource || !continues(transcript, previous, words[firstIndex])) continue;
    // Scene times of the tail, from a filler heading it ("uh, at school.").
    const head = (transcript.words ?? []).find((word) => word.start >= at - 0.05 && word.start < words[firstIndex].start && isFiller(word.text)) ?? words[firstIndex];
    const from = range.start + Math.max(0, head.start - range.offset);
    const to = range.start + (last.end - range.offset);
    const step = 1 / 30;
    let loudest = 0;
    for (let time = from; time <= to; time += step) loudest = Math.max(loudest, volumeAt(layer, time));
    if (loudest <= DUCKED) continue;
    // Under another voice as loud or louder, the tail is not heard as words.
    const masked = edges.some((other) => other !== edge && other.words?.length && other.words.some((word) => {
      const start = other.range.start + (word.start - other.range.offset);
      const end = other.range.start + (word.end - other.range.offset);
      return start < to && end > from && start >= other.range.start - 0.05 && end <= other.range.end + 0.05 && volumeAt(other.layer, (Math.max(start, from) + Math.min(end, to)) / 2) >= loudest;
    }));
    if (masked) continue;
    const next = words[endIndex + 1];
    const offset = round3(Math.min(last.end + 0.15, next ? next.start - 0.05 : Infinity));
    const shift = offset - (layer.mediaOffset ?? 0);
    const fileLength = Math.min(transcript.duration ?? Infinity, layer.mediaSourceDuration > 0 ? layer.mediaSourceDuration : Infinity);
    // A sound starts later on the same clock, so its out point stays put (no new speech_cut there);
    // a video slips in the file, since moving its start would leave a hole in the picture.
    const sound = layer.type === "audio";
    const properties = sound
      ? { mediaOffset: offset, mediaStart: round3((layer.mediaStart ?? 0) + shift), ...(layer.mediaDuration > 0 ? { mediaDuration: round3(layer.mediaDuration - shift) } : {}) }
      : { mediaOffset: offset, ...(layer.mediaDuration > 0 && offset + layer.mediaDuration > fileLength ? { mediaDuration: round3(fileLength - offset) } : {}) };
    const nothingAfter = sound && range.outSource - offset < 0.2;
    findings.push({
      rule: "speech_fragment", severity: "warn", layerId: layer.id, at: sec(from), until: sec(to),
      message: `"${layer.name}" starts on the end of a sentence said before it: "${said(tail)}" is heard with nothing before it.`,
      measured: `starts at ${sec(at)} s in the file; "${previous.text.trim()}" ends ${sec(Math.max(0, at - previous.end))} s before, then "${said(tail)}" (${sec(words[firstIndex].start)} to ${sec(last.end)} s) at volume ${round3(loudest)}`,
      required: `start after the tail, or under another voice, or at volume ${DUCKED} or lower while it plays (a caption does not fix a dangling tail)`,
      fix: nothingAfter
        ? { kind: "hint", text: `"${layer.name}" plays little more than the tail: delete it, or set its volume to ${DUCKED} or lower.` }
        : {
          kind: "layer", layerId: layer.id, properties, auto: false,
          why: `starts the sound ${sec(shift)} s further into the file, after "${last.text.trim()}"${sound ? `, ${sec(shift)} s later on the same clock (its end stays put)` : " (the picture moves too: for a picture kept in place, split the sound into an audio layer first)"}`,
        },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- mute_word

// A ramp this short or shorter is a mute or a duck (a longer one is a fade).
const RAMP_MAX = 0.5;
// The ramp leaves at most this share of the volume before it.
const HIDE_SHARE = 0.35;
// At or under this volume a ramp mutes.
const MUTED = 0.05;
// The word is hidden by the ramp when this much of it falls in the quiet.
const HIDDEN_MIN = 0.08;
// Heard: the onset or tail plays this long above the quiet level.
const HEARD_MIN = 0.03;
// Margin the fix leaves between the ramp and the word.
const MARGIN = 0.03;

const volumeKeys = (animation) => animation?.to && typeof animation.to.volume === "number" && animation.duration > 0 && animation.duration <= RAMP_MAX && animation.kind !== "hide";

/** mute_word: a mute or duck ramp on a voice that lets part of the word it hides be heard. */
export function muteWord(model, ctx) {
  const scene = ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  for (const edge of heardEdges(ctx)) {
    const { layer, range } = edge;
    const words = edge.words;
    if (!words?.length) continue;
    const timed = words.map((word) => ({ word, start: range.start + (word.start - range.offset), end: range.start + (word.end - range.offset) }))
      .filter((entry) => entry.end > range.start && entry.start < range.end);
    const ramps = (layer.animations ?? []).filter((animation) => animation && animation.enabled !== false && volumeKeys(animation));
    for (const ramp of ramps) {
      const rampEnd = ramp.start + ramp.duration;
      const before = typeof ramp.from?.volume === "number" ? ramp.from.volume : volumeAt(layer, ramp.start - 1e-3);
      const after = ramp.to.volume;
      // duck_audio's dips make room for another voice; they hide no word unless they mute.
      if (/^Duck (down|up)$/.test(ramp.name ?? "") && Math.min(before, after) > MUTED) continue;
      const down = after <= before * HIDE_SHARE && before - after >= 0.15;
      const up = before <= after * HIDE_SHARE && after - before >= 0.15;
      if (!down && !up) continue;
      const quietLevel = Math.min(before, after) + 0.02;
      const step = 1 / 60;
      if (down) {
        // The quiet stretch: from the ramp's end until the volume comes back up (or the clip ends).
        let quietEnd = rampEnd;
        while (quietEnd < range.end && volumeAt(layer, quietEnd + step / 2) <= quietLevel) quietEnd += step;
        // A fade out at the end of the clip is speech_cut's: a mute leaves the clip playing.
        if (quietEnd - rampEnd < 0.2 || range.end - rampEnd < 0.2) continue;
        // The word it hides is in the quiet, from the ramp's middle on: a word the ramp only dips
        // on its way down (the end of "Holy" before the swear) is the one before it.
        const target = timed.find((entry) => Math.min(entry.end, quietEnd) - Math.max(entry.start, ramp.start + ramp.duration / 2) >= HIDDEN_MIN);
        if (!target) continue;
        const heard = Math.min(rampEnd, target.end) - target.start;
        if (heard < HEARD_MIN) continue;
        const start = round3(target.start - MARGIN - ramp.duration);
        const previous = timed[timed.indexOf(target) - 1];
        const clear = start >= range.start && (!previous || previous.end <= start);
        findings.push({
          rule: "mute_word", severity: "warn", layerId: layer.id, at: sec(target.start), until: sec(rampEnd),
          message: `The volume ramp "${ramp.name ?? ramp.id}" on "${layer.name}" starts after "${target.word.text.trim()}" begins: its first ${sec(heard)} s is heard.`,
          measured: `"${target.word.text.trim()}" starts at ${sec(target.start)} s; the ramp runs ${sec(ramp.start)} to ${sec(rampEnd)} s (volume ${round3(before)} to ${round3(after)})`,
          required: `the ramp ends ${MARGIN} s before the word starts`,
          fix: {
            kind: "layer_animation", layerId: layer.id, animationId: ramp.id, properties: { start: start }, auto: clear,
            why: `moves the ramp ${sec(ramp.start - start)} s earlier, to end at ${sec(start + ramp.duration)} s${clear ? "" : `; that also lowers "${previous?.word.text.trim() ?? "the clip's start"}" before it, so it is not applied by itself`}`,
          },
        });
      } else {
        // The quiet stretch before the ramp up.
        let quietStart = ramp.start;
        while (quietStart > range.start && volumeAt(layer, quietStart - step / 2) <= quietLevel) quietStart -= step;
        if (ramp.start - quietStart < 0.2) continue;
        const target = [...timed].reverse().find((entry) => Math.min(entry.end, ramp.start + ramp.duration / 2) - Math.max(entry.start, quietStart) >= HIDDEN_MIN && entry.start < ramp.start);
        if (!target) continue;
        const heard = target.end - Math.max(ramp.start, target.start);
        if (heard < HEARD_MIN) continue;
        const start = round3(target.end + MARGIN);
        const next = timed[timed.indexOf(target) + 1];
        const clear = start + ramp.duration <= range.end && (!next || next.start >= start + ramp.duration);
        findings.push({
          rule: "mute_word", severity: "warn", layerId: layer.id, at: sec(ramp.start), until: sec(target.end),
          message: `The volume ramp "${ramp.name ?? ramp.id}" on "${layer.name}" comes back up before "${target.word.text.trim()}" ends: its last ${sec(heard)} s is heard.`,
          measured: `"${target.word.text.trim()}" ends at ${sec(target.end)} s; the ramp runs ${sec(ramp.start)} to ${sec(rampEnd)} s (volume ${round3(before)} to ${round3(after)})`,
          required: `the ramp starts ${MARGIN} s after the word ends`,
          fix: {
            kind: "layer_animation", layerId: layer.id, animationId: ramp.id, properties: { start }, auto: clear,
            why: `moves the ramp ${sec(start - ramp.start)} s later, to start at ${sec(start)} s${clear ? "" : "; that also lowers the word after it, so it is not applied by itself"}`,
          },
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- music_hard_stop

// The music counts as still going when its last 120 ms are within this many dB of its median.
const STILL_GOING = 10;
// Audible: the volume where it stops.
const AUDIBLE = 0.08;
// Faded: the volume where it stops is at most this share of the volume a moment before.
const FADED_SHARE = 0.3;
const FADE = 0.25;
const FRAME = 1 / 30;

function medianLevel(sound) {
  if (sound.median != null) return sound.median;
  const sorted = Float32Array.from(sound.levels).sort();
  sound.median = sorted[Math.floor(sorted.length / 2)];
  return sound.median;
}

// A hit at `time`: a marker cue, or a beat of the project's rhythm, within a frame.
function onHit(model, ctx, time) {
  if ((ctx.cues ?? []).some((cue) => Math.abs(cue.time - time) <= FRAME)) return true;
  const rhythm = model.rhythm;
  if (!(rhythm?.bpm > 0)) return false;
  const beat = 60 / rhythm.bpm;
  const beats = (time - (rhythm.offset ?? 0)) / beat;
  return Math.abs(beats - Math.round(beats)) * beat <= FRAME;
}

// A fade out still running where the layer stops (a shutter sound): a volume animation down to
// near silence that ends after the stop, so the sound is cut while still loud.
const runningFade = (layer, end) => (layer.animations ?? []).find((animation) => animation?.id && animation.enabled !== false && animation.kind !== "hide"
  && typeof animation.to?.volume === "number" && animation.to.volume < AUDIBLE && animation.duration > 0 && animation.start < end && animation.start + animation.duration > end + 1e-3);

/** music_hard_stop: a song that stops while loud, with no fade out. */
export function musicHardStop(model, ctx) {
  const scene = ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  const songs = (ctx.speech ?? []).filter((entry) => entry.music && entry.layer?.enabled !== false && entry.layer?.src);
  for (const entry of songs) {
    const { layer } = entry;
    const sound = soundLevels(entry.loudness);
    const range = mediaPlaybackRange(layer, scene.duration);
    if (!sound || !range || range.remapped || isRemapped(layer)) continue;
    // The sound stops where the layer ends, or sooner where its file runs out.
    const end = Math.min(range.end, range.start + (sound.duration - range.offset));
    if (end <= range.start + 0.05) continue;
    const out = range.offset + (end - range.start);
    // Another piece of the same file carries on from here: a join, not a stop.
    const joined = scene.layers.some((other) => other !== layer && other.src === layer.src && other.enabled !== false && (() => {
      const next = mediaPlaybackRange(other, scene.duration);
      return next && Math.abs(next.start - end) <= 0.1 && Math.abs(next.offset - out) <= 0.1;
    })());
    if (joined) continue;
    const stopping = volumeAt(layer, end - 0.01);
    // A song fit_music already cut ends where it can: only the fade is offered.
    const fitted = layer.fitMusic || scene.layers.some((other) => other.fitMusic === layer.id);
    const refit = fitted ? "" : `fit_music {layer:"${layer.name}"} `;
    let earlier = 0;
    for (let time = Math.max(range.start, end - 1.5); time <= end - 0.3; time += FRAME) earlier = Math.max(earlier, volumeAt(layer, time));
    if (stopping < AUDIBLE || (earlier > 0 && stopping <= earlier * FADED_SHARE)) continue;
    const level = levelBetween(sound, out - 0.12, out);
    const median = medianLevel(sound);
    // The song ends quietly by itself there (its own ending or a quiet bar).
    if (level < median - STILL_GOING) continue;
    if (onHit(model, ctx, end)) continue;
    const fade = Math.min(FADE, Math.max(0.05, range.duration / 4));
    const start = round3(end - fade);
    // Another volume animation in the fade's stretch would fight it: then it is offered only.
    const crowded = (layer.animations ?? []).some((animation) => animation?.to && typeof animation.to.volume === "number" && animation.start < end && animation.start + (animation.duration ?? 0) > start);
    // A fade out that runs past the stop moves earlier to finish there, unless another volume animation is in the way.
    const running = runningFade(layer, end);
    const moveTo = running && round3(Math.max(range.start, end - running.duration));
    const inWay = running && (layer.animations ?? []).some((animation) => animation !== running && animation?.to && typeof animation.to.volume === "number" && animation.start < end && animation.start + (animation.duration ?? 0) > moveTo);
    findings.push({
      rule: "music_hard_stop", severity: "warn", layerId: layer.id, at: sec(end),
      // Its own sound, by name: "the music" read as the song when a short sound effect stopped.
      message: `"${layer.name}" stops dead at ${sec(end)} s while its own sound is still loud (volume ${round3(stopping)}, ${running ? `its fade out "${running.name ?? running.id}" ends ${sec(running.start + running.duration - end)} s after the stop` : "no fade out"}).`,
      measured: `the last 120 ms of "${layer.name}" are ${Math.round(median - level) > 0 ? `${Math.round(median - level)} dB below` : "at or above"} its median level; the volume is ${round3(stopping)} where it stops`,
      required: `${refit ? `${refit}first (the song's own ending lands on the end), else ` : ""}a fade out of 0.15 to 0.3 s, a stop on a hit (a marker cue or a beat of the rhythm), or waive_check a deliberate stop`,
      fix: running ? {
        kind: "layer_animation", layerId: layer.id, animationId: running.id, auto: !inWay,
        properties: { start: moveTo, ...(end - moveTo < running.duration ? { duration: round3(end - moveTo) } : {}) },
        why: `moves the fade out ${sec(running.start - moveTo)} s earlier, to end at the stop (${sec(end)} s)${inWay ? "; another volume animation is in that stretch, so it is not applied by itself" : ""}`,
      } : {
        kind: "add_layer_animation", layerId: layer.id, auto: !crowded,
        animation: { kind: "out", name: "Fade out", start, duration: round3(fade), easing: "ease-in", from: { volume: round3(stopping) }, to: { volume: 0 } },
        why: `${refit ? `${refit}ends the song on its own ending instead; this ` : ""}fades it out over ${sec(fade)} s, ${sec(start)} to ${sec(end)} s${crowded ? "; another volume animation is in that stretch, so it is not applied by itself" : ""}`,
      },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- voice_under_bed, voice_level_spread

// The measured mix rules (T4): they read each file's loudness in LUFS (entries' `levels`,
// backend/loudness-curve.mjs), saved after a full check measures it, so a quick check without it
// stays quiet. A voice with a transcript is heard leveled to VOICE_TARGET_LUFS (the export does it).
// A spoken line is heard at least this many LU over the music under it.
const OVER_BED = VOICE_OVER_BED;
// Spoken lines differ by at most this many dB, as heard.
const LINE_SPREAD = 3;

// Two words in a row of a line are heard at least this many LU over the beds under them (a line's
// end trailing off under street sound and a song: "the target is on your right.").
const WORDS_OVER_BED = 3;
// A sound under this many seconds is a sound effect, not a bed.
const BED_SECONDS = 3;

// The spoken lines of each voice with levels: [{layer, text, start, end (scene s), lufs, heard}],
// measured by mixLevels.js voiceLines (duck_audio sets its depth from the same numbers).
function spokenLines(ctx) {
  const lines = [];
  for (const edge of heardEdges(ctx)) {
    const entry = (ctx.speech ?? []).find((item) => item.layer === edge.layer);
    // A bed (a layer under BED_VOLUME, such as street sound) is no line: the export leaves it unleveled.
    if (!entry?.levels || !(edge.words?.length >= 2) || edge.range.remapped || !leveledVoice(edge.layer)) continue;
    const { layer, range } = edge;
    const words = edge.words.filter((word) => word.end > range.offset && word.start < range.outSource);
    for (const line of voiceLines(entry.levels, layer, range, words, breakAfter)) lines.push({ layer, text: said(line.words), start: line.start, end: line.end, lufs: line.lufs, heard: line.heard });
  }
  return lines;
}

// Measured sound layers (entries with levels) playing BED_SECONDS or more, but `except`:
// [{entry, curve, layer, range}]. With voices: false, leveled voices with words are left out too.
function measuredBeds(ctx, scene, { except = null, voices = true } = {}) {
  const beds = [];
  for (const entry of ctx.speech ?? []) {
    const { layer } = entry;
    if (!entry.levels || !layer || layer === except || layer.enabled === false) continue;
    if (!voices && !entry.music && entry.transcript?.words?.length && leveledVoice(layer)) continue;
    const range = mediaPlaybackRange(layer, scene.duration);
    if (range && !range.remapped && range.end - range.start >= BED_SECONDS) beds.push({ entry, curve: entry.levels, layer, range });
  }
  return beds;
}

const lu = (value) => Math.round(value * 10) / 10;
const names = (beds) => beds.map((bed) => bed.layer.name ?? bed.layer.id).join(", ");

/**
 * voice_under_bed: a spoken line less than 6 LU over the beds under it (music, street sound, any
 * other sound of 3 s or more), or two words in a row of it less than 3 LU over them.
 */
export function voiceUnderBed(model, ctx) {
  const scene = ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  for (const line of spokenLines(ctx)) {
    const beds = measuredBeds(ctx, scene, { except: line.layer }).filter((bed) => bed.range.start < line.end && bed.range.end > line.start);
    const bed = bedLoudness(beds, line.start, line.end);
    if (bed === null) continue;
    const over = line.lufs - bed;
    // The beds heard from `from` to `to`, loudest first.
    const heard = (from, to) => beds.map((item) => ({ ...item, lufs: bedLoudness([item], from, to) })).filter((item) => item.lufs !== null).sort((a, b) => b.lufs - a.lufs);
    if (over < OVER_BED) {
      const under = heard(line.start, line.end);
      findings.push({
        rule: "voice_under_bed", severity: "warn", layerId: line.layer.id, at: sec(line.start), until: sec(line.end),
        message: `"${line.text.slice(0, 60)}" (${line.layer.name}) is only ${lu(over)} LU over ${names(under)} under it: the words are hard to follow.`,
        measured: `voice ${lu(line.lufs)} LUFS, beds ${lu(bed)} LUFS as heard (${line.layer.name} leveled, volumes and ducks applied)`,
        required: `the voice ${OVER_BED} LU or more over the beds: duck_audio them under the voice without to (it dips ${VOICE_OVER_MUSIC} LU under the measured voice)`,
      });
      continue;
    }
    // The quietest two words in a row, against the beds under just them.
    let worst = null;
    for (let index = 0; index + 1 < (line.heard?.length ?? 0); index += 1) {
      const pair = line.heard.slice(index, index + 2);
      const voice = energyMean(pair.map((word) => word.lufs).filter((value) => value !== null));
      const under = bedLoudness(beds, pair[0].start, pair[1].end);
      if (voice === null || under === null) continue;
      if (!worst || voice - under < worst.over) worst = { pair, voice, under, over: voice - under };
    }
    if (!worst || worst.over >= WORDS_OVER_BED) continue;
    const { pair } = worst;
    const from = pair[0].start, to = pair[1].end;
    const words = pair.map((word) => word.text.trim()).join(" ");
    const covering = names(heard(from, to));
    findings.push({
      rule: "voice_under_bed", severity: "warn", layerId: line.layer.id, at: sec(from), until: sec(to),
      message: `"${words}" in "${line.text.slice(0, 50)}" (${line.layer.name}) is buried: only ${lu(worst.over)} LU over ${covering} under it.`,
      measured: `those words ${lu(worst.voice)} LUFS, beds ${lu(worst.under)} LUFS as heard; the whole line ${lu(over)} LU over them`,
      required: `every 2 words in a row ${WORDS_OVER_BED} LU or more over the beds`,
      fix: { kind: "hint", text: `Lift "${words}": a volume ramp on ${line.layer.name} up ${lu(WORDS_OVER_BED - worst.over)} dB from ${sec(Math.max(0, from - 0.1))} to ${sec(to)} s, or dip ${covering} under those words.` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- bed_jump

// The beds together (music, street sound: not voices, not sound effects) rise at most this many LU
// at a cut or a sudden volume step: the level in the JUMP_ATTACK s after it against the JUMP_WINDOW s
// before. A fade in of 0.2 s or more (smooth) stays under it in that first step; a 0.06 s one does not.
const JUMP_LU = 8;
const JUMP_WINDOW = 0.3;
const JUMP_ATTACK = 0.1;

/** bed_jump: the beds together rise more than 8 LU across a bed's in point or a sudden volume step (the first 0.1 s after against the 0.3 s before). */
export function bedJump(model, ctx) {
  const scene = ctx.speechScene;
  if (!scene) return [];
  const beds = measuredBeds(ctx, scene, { voices: false });
  if (!beds.length) return [];
  // Where a bed starts after the video's start, or a volume animation shorter than the window starts.
  const times = [];
  for (const bed of beds) {
    if (bed.range.start > 0.05) times.push(bed.range.start);
    for (const animation of enabledAnimations(bed.layer.animations ?? [])) {
      if (animatesVolume({ ...bed.layer, animations: [animation] }) && animation.duration < JUMP_WINDOW && animation.start > bed.range.start + 0.05) times.push(animation.start);
    }
  }
  times.sort((a, b) => a - b);
  const findings = [];
  let last = -Infinity;
  for (const time of times) {
    if (time - last < JUMP_WINDOW) continue;
    const before = bedLoudness(beds, time - JUMP_WINDOW, time);
    const after = bedLoudness(beds, time, time + JUMP_ATTACK);
    if (before === null || after === null || after - before <= JUMP_LU) continue;
    last = time;
    const playing = (from, to) => beds.filter((bed) => bedLoudness([bed], from, to) !== null);
    const outgoing = playing(time - JUMP_WINDOW, time);
    const incoming = playing(time, time + JUMP_WINDOW).filter((bed) => Math.abs(bed.range.start - time) < 0.05 || !outgoing.includes(bed));
    const rising = incoming.length ? incoming : playing(time, time + JUMP_WINDOW);
    findings.push({
      rule: "bed_jump", severity: "warn", layerId: rising[0]?.layer.id, at: sec(time),
      message: `The beds jump ${lu(after - before)} LU at ${sec(time)} s (${names(outgoing)} to ${names(rising)}): the sound lurches at the cut.`,
      measured: `beds ${lu(before)} LUFS in the ${JUMP_WINDOW} s before, ${lu(after)} LUFS in the ${JUMP_ATTACK} s after (volumes and fades applied)`,
      required: `the beds rise at most ${JUMP_LU} LU across a cut (in the first ${JUMP_ATTACK} s)`,
      fix: { kind: "hint", text: `Start ${names(rising)} 0.5 s or more before the cut with a fade in of 0.5 s or more (a J-cut), or lower its volume to match ${names(outgoing)}.` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- volume_churn

// A song or bed whose volume turns (up then down, or down then up) CHURN_TURNS times within
// CHURN_SECONDS churns. A move under CHURN_DB is no turn; the opening fade in and the closing
// fade out (from or to under SILENT) are left out.
const CHURN_TURNS = 3;
const CHURN_SECONDS = 10;
const CHURN_DB = 1.5;
const SILENT = 0.02;
const CHURN_STEP = 0.05;
const dbOf = (volume) => 20 * Math.log10(Math.max(1e-4, volume));

/** The turns of `layer`'s volume from `start` to `end` scene s: [{time, volume}], fades from and to silence left out. */
export function volumeTurns(layer, start, end) {
  const samples = [];
  for (let time = start; time < end - 1e-6; time += CHURN_STEP) samples.push({ time, volume: volumeAt(layer, time) });
  samples.push({ time: end, volume: volumeAt(layer, Math.max(start, end - 0.001)) });
  const turns = [];
  let extreme = samples[0];
  let direction = 0;
  for (const sample of samples) {
    const change = dbOf(sample.volume) - dbOf(extreme.volume);
    if (direction === 0) {
      if (Math.abs(change) >= CHURN_DB) { direction = Math.sign(change); extreme = sample; }
    } else if (direction * change > 0) extreme = sample;
    else if (-direction * change >= CHURN_DB) { turns.push(extreme); direction = -direction; extreme = sample; }
  }
  if (turns.length && samples[0].volume <= SILENT) turns.shift();
  if (turns.length && samples.at(-1).volume <= SILENT && direction < 0) turns.pop();
  return turns;
}

/** volume_churn: a song or bed whose volume changes direction 3 times or more within 10 s. */
export function volumeChurn(model, ctx) {
  const scene = ctx.speechScene ?? ctx.scene;
  if (!scene) return [];
  const heard = new Map((ctx.speech ?? []).map((entry) => [entry.layer?.id, entry]));
  const findings = [];
  for (const layer of scene.layers) {
    if (!animatesVolume(layer) || !layer.src || layer.enabled === false) continue;
    const entry = heard.get(layer.id);
    const voice = !entry?.music && entry?.transcript?.words?.length && leveledVoice(layer);
    const range = mediaPlaybackRange(layer, scene.duration);
    if (voice || !range || range.end - range.start < BED_SECONDS || !(isMusicLayer(layer, scene, entry) || entry)) continue;
    const turns = volumeTurns(layer, range.start, range.end);
    let worst = null;
    for (let i = 0, j = 0; i < turns.length; i += 1) {
      while (j + 1 < turns.length && turns[j + 1].time - turns[i].time <= CHURN_SECONDS) j += 1;
      if (j - i + 1 >= CHURN_TURNS && (!worst || j - i > worst.length - 1)) worst = turns.slice(i, j + 1);
    }
    if (!worst) continue;
    const path = worst.map((turn) => `${round3(turn.volume)} at ${sec(turn.time)} s`).join(", ");
    findings.push({
      rule: "volume_churn", severity: "warn", layerId: layer.id, at: sec(worst[0].time), until: sec(worst.at(-1).time),
      message: `"${layer.name ?? layer.id}" changes direction ${worst.length} times in ${sec(worst.at(-1).time - worst[0].time)} s: the level churns.`,
      measured: `turns at ${path}`,
      required: `under ${CHURN_TURNS} turns in any ${CHURN_SECONDS} s (fades in and out aside)`,
      fix: { kind: "hint", text: "Hold one level, and duck once under a whole spoken stretch instead of under each line." },
    });
  }
  return findings;
}

/** voice_level_spread: spoken lines that differ by more than 3 dB as heard. */
export function voiceLevelSpread(model, ctx) {
  if (!ctx.speechScene) return [];
  const lines = spokenLines(ctx);
  if (lines.length < 2) return [];
  const loud = lines.reduce((a, b) => (b.lufs > a.lufs ? b : a));
  const quiet = lines.reduce((a, b) => (b.lufs < a.lufs ? b : a));
  const spread = loud.lufs - quiet.lufs;
  if (spread <= LINE_SPREAD) return [];
  return [{
    rule: "voice_level_spread", severity: "warn", layerId: quiet.layer.id, at: sec(quiet.start), until: sec(quiet.end),
    message: `Spoken lines are ${lu(spread)} dB apart: "${quiet.text.slice(0, 40)}" (${quiet.layer.name}) is quieter than "${loud.text.slice(0, 40)}" (${loud.layer.name}).`,
    measured: `${lines.length} lines from ${lu(quiet.lufs)} to ${lu(loud.lufs)} LUFS as heard (leveled at export, volumes and ducks applied)`,
    required: `lines within ${LINE_SPREAD} dB: give the quiet line's layer the same volume as the others, or split a line recorded at two levels into two layers`,
  }];
}

// ---------------------------------------------------------------- end_on_fade

// A phrase is this many beats (4 bars of 4).
const PHRASE_BEATS = 16;
// The song's own ending: its file ends within this many seconds of the out point.
const OWN_ENDING = 1;

/** end_on_fade: the video ends with a fade while the song is still mid-phrase. */
export function endOnFade(model, ctx) {
  const scene = ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  for (const entry of (ctx.speech ?? []).filter((item) => item.music && item.layer?.enabled !== false && item.layer?.src)) {
    const { layer } = entry;
    const sound = soundLevels(entry.loudness);
    const range = mediaPlaybackRange(layer, scene.duration);
    if (!sound || !range || range.remapped || isRemapped(layer)) continue;
    // Plays to the video's end, faded there (a dead stop is music_hard_stop's).
    if (range.end < scene.duration - 0.05) continue;
    const end = scene.duration;
    const stopping = volumeAt(layer, end - 0.01);
    let earlier = 0;
    for (let time = Math.max(range.start, end - 3); time <= end - 0.3; time += FRAME) earlier = Math.max(earlier, volumeAt(layer, time));
    if (!(earlier >= AUDIBLE && stopping <= earlier * FADED_SHARE)) continue;
    const out = range.offset + (end - range.start);
    // The song's own ending is reached, or it is quiet there by itself.
    if (sound.duration - out <= OWN_ENDING) continue;
    if (levelBetween(sound, out - 0.5, out) < medianLevel(sound) - STILL_GOING) continue;
    // On a section cue, or on a phrase line of the rhythm: a fade there closes the phrase.
    if (sectionCues(ctx.cues).some((cue) => Math.abs(cue.time - end) <= 0.25)) continue;
    const bpm = model.rhythm?.bpm;
    if (bpm > 0) {
      const beat = 60 / bpm;
      const phrase = beat * PHRASE_BEATS;
      const into = (((end - (model.rhythm.offset ?? 0)) % phrase) + phrase) % phrase;
      if (Math.min(into, phrase - into) <= beat) continue;
    }
    findings.push({
      rule: "end_on_fade", severity: "warn", layerId: layer.id, at: sec(end),
      message: `The video ends on a fade of "${layer.name}" while the song is mid-phrase (${sec(sound.duration - out)} s before its own ending): the end feels cut off, not finished.`,
      measured: `the song is still loud at ${sec(out)} s in its file (within ${STILL_GOING} dB of its median); the volume falls from ${round3(earlier)} to ${round3(stopping)} at the end`,
      required: "end on the song's own ending (place it so its last bar lands on the end card), on a section cue, or on a phrase line (every 4 bars) with a short fade",
    });
  }
  return findings;
}
// ---------------------------------------------------------------- no_music

// A video this long or longer wants music (a silent first pass is a choice, never an accident).
const MUSIC_FROM = 10;
// A sound layer playing under this share of the video is a sound effect or a short line.
const MUSIC_SHARE = 0.3;

/** The next call for a video with no music: a soundtrack search, or the person's choice. */
export function noMusicFix(soundSearch) {
  return soundSearch
    ? 'library {topic:"soundtrack", search:"<mood, tempo>"}, measure 2 songs (library {topic:"soundtrack", measure:"<id>"}), import the best fit'
    : "sound search is off: at the sound stop ask the person to send a track, turn on sound search in kino Settings, or keep it silent";
}

/**
 * Whether the scene has an audio layer that can be its music: one kino hears a steady beat in
 * (a speech entry with music: true), or one playing 30% of the scene or more that is not a
 * transcribed voice. The sound stop asks it too (backend/agent/service.mjs).
 */
export function hasMusic(scene, speech = []) {
  const heard = new Map(speech.map((entry) => [entry.layer?.id, entry]));
  return scene.layers.some((layer) => isMusicLayer(layer, scene, heard.get(layer.id)));
}

/** One layer of hasMusic: `entry` is its speech entry ({music} or {transcript}), if any. */
export function isMusicLayer(layer, scene, entry = null) {
  if (layer.type !== "audio" || !layer.src || layer.enabled === false) return false;
  if (entry?.music) return true;
  if (entry?.transcript?.words?.length) return false;
  const range = mediaPlaybackRange(layer, scene.duration);
  return Boolean(range) && range.end - range.start >= scene.duration * MUSIC_SHARE;
}

/** no_music: a video of 10 s or more with no music; ctx.soundSearch (Settings) picks the fix. */
export function noMusic(model, ctx) {
  const scene = ctx.speechScene ?? ctx.scene;
  if (!scene || !(scene.duration >= MUSIC_FROM) || hasMusic(scene, ctx.speech ?? [])) return [];
  const sounds = scene.layers.filter((layer) => layer.type === "audio" && layer.src && layer.enabled !== false).length;
  return [{
    rule: "no_music", severity: "warn", at: 0, until: sec(scene.duration),
    message: `This ${sec(scene.duration)} s video has no music${sounds ? `: its ${sounds} sound layer${sounds > 1 ? "s are" : " is"} short or voice` : ": no sound layer at all"}.`,
    measured: `${sounds} audio layer${sounds === 1 ? "" : "s"}, none a song or ${Math.round(MUSIC_SHARE * 100)}% of the video long`,
    required: `music under a video of ${MUSIC_FROM} s or more, or the person's call to keep it silent (waive_check)`,
    fix: { kind: "hint", text: noMusicFix(ctx.soundSearch) },
  }];
}

// ---------------------------------------------------------------- sfx_restraint

// Restraint (UI sound design rules applied to video): decorative sounds tire the ear when they come often or repeat, so silence stays the default and
// a sound effect marks a visible action that matters. A sound effect here is a short sound layer
// (under SFX_SECONDS, not music, not a transcribed voice).
const SFX_SECONDS = 3;
// More than SFX_IN_STRETCH starts in any SFX_STRETCH seconds is more than one every 4 s.
const SFX_STRETCH = 16;
const SFX_IN_STRETCH = 4;
// The same file this many times or more is one sound on a repeated motion.
const SFX_REPEATS = 3;

/** sfx_restraint: sound effects more than about one every 4 s in a stretch, or one sound repeated on repeated motions. */
export function sfxRestraint(model, ctx) {
  const scene = ctx.speechScene ?? ctx.scene;
  if (!scene) return [];
  const heard = new Map((ctx.speech ?? []).map((entry) => [entry.layer?.id, entry]));
  const effects = [];
  for (const layer of scene.layers) {
    if (layer.type !== "audio" || !layer.src || layer.enabled === false || isMusicLayer(layer, scene, heard.get(layer.id))) continue;
    if (heard.get(layer.id)?.transcript?.words?.length) continue;
    const range = mediaPlaybackRange(layer, scene.duration);
    if (range && range.duration < SFX_SECONDS) effects.push({ layer, at: range.start });
  }
  effects.sort((a, b) => a.at - b.at);
  const findings = [];
  let worst = null;
  for (let i = 0; i < effects.length; i += 1) {
    let j = i;
    while (j + 1 < effects.length && effects[j + 1].at < effects[i].at + SFX_STRETCH) j += 1;
    if (j - i + 1 > SFX_IN_STRETCH && (!worst || j - i > worst.to - worst.from)) worst = { from: i, to: j };
  }
  if (worst) {
    const list = effects.slice(worst.from, worst.to + 1);
    findings.push({
      rule: "sfx_restraint", severity: "warn", at: sec(list[0].at), until: sec(Math.min(scene.duration, list[0].at + SFX_STRETCH)),
      measured: `${list.length} sound effects in ${SFX_STRETCH} s (${list.map((item) => `${item.layer.name ?? item.layer.id} ${sec(item.at)}s`).slice(0, 6).join(", ")})`,
      required: `at most ${SFX_IN_STRETCH} in any ${SFX_STRETCH} s (about one every 4 s), each on a visible action that matters`,
      message: `${list.length} sound effects play within ${SFX_STRETCH} s; frequent decorative sounds tire the ear and none of them lands.`,
      fix: { kind: "hint", text: "Keep the sounds on the hook, the turn and the payoff; delete the ones on small or repeated motions (silence is the default)." },
    });
  }
  const bySource = new Map();
  for (const item of effects) bySource.set(item.layer.src, [...(bySource.get(item.layer.src) ?? []), item]);
  for (const [, list] of bySource) {
    if (list.length < SFX_REPEATS) continue;
    findings.push({
      rule: "sfx_restraint", severity: "warn", at: sec(list[0].at),
      measured: `one sound ${list.length} times (${list.map((item) => `${sec(item.at)}s`).slice(0, 6).join(", ")})`,
      required: `a sound under ${SFX_REPEATS} times; repeated motions play silent after the first`,
      message: `${list[0].layer.name ?? "A sound effect"} plays ${list.length} times; the same sound on each repeat of a motion reads as a loop, not a moment.`,
      fix: { kind: "hint", text: "Keep the first one (or the one on the payoff) and delete the repeats." },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- music_stall
// The song is at or above its middle level while the picture holds no shot: three of eight blind
// judges marked fp-8 down for the 3.6 s of a prompt typing over a dim, blurred log right after the
// drop. A shot is a clip or picture at full strength (not blurred to a backdrop, not under a dark
// full-frame tint) filling SHOT_SHARE of the frame; a cut ends a stretch. The closing stretch is
// the end card's (template_end).
const STALL = 2.5;
const SHOT_SHARE = 0.4;

export function musicStall(model, ctx) {
  const scene = ctx.speechScene;
  if (!scene || model.duration < 8) return [];
  const songs = (ctx.speech ?? []).filter((entry) => entry.music && entry.layer?.enabled !== false && entry.layer?.src);
  const count = model.times.length;
  const loud = new Uint8Array(count);
  for (const entry of songs) {
    const sound = soundLevels(entry.loudness);
    const range = mediaPlaybackRange(entry.layer, scene.duration);
    if (!sound || !range || range.remapped || isRemapped(entry.layer)) continue;
    const median = medianLevel(sound);
    for (let index = 0; index < count; index += 1) {
      const time = model.times[index];
      if (time < range.start || time > range.end || volumeAt(entry.layer, time) < AUDIBLE) continue;
      const at = range.offset + (time - range.start);
      if (levelBetween(sound, at - 0.25, at + 0.25) >= median) loud[index] = 1;
    }
  }
  if (!loud.some(Boolean)) return [];
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const whole = model.width * model.height;
  const pictures = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && !item.isMask);
  const shotAt = (index) => !dimmedAt(model, index) && pictures.some((item) => item.samples.opacity[index] >= 0.5 && !blurred(item, index) && !coveredAt(model, item, index)
    && area(intersection(visibleBoxAt(model, item, index), frame)) >= SHOT_SHARE * whole);
  const cutIndexes = new Set(cuts(model).map((time) => model.times.findIndex((each) => each >= time - 1e-6)));
  const findings = [];
  let from = -1;
  const close = (to) => {
    if (from < 0) return;
    const seconds = (to - from) / model.fps;
    // A stretch that runs to the end is the closing card's.
    if (seconds >= STALL && to < count) {
      findings.push({
        rule: "music_stall", severity: "warn", at: sec(model.times[from]), until: sec(model.times[to - 1]),
        measured: `${sec(seconds)}s with the music at or above its middle level and no shot at full strength, no cut`,
        required: `under ${STALL}s: a loud stretch of the song carries a shot or a cut`,
        message: `At ${sec(model.times[from])}s the music is loud but the picture stalls for ${sec(seconds)}s (text or a dim, blurred backdrop, no cut).`,
        fix: { kind: "hint", text: "Put a shot under it at full strength, cut on the beats, or move this beat to the song's quiet part." },
      });
    }
    from = -1;
  };
  for (let index = 0; index < count; index += 1) {
    if (cutIndexes.has(index)) close(index);
    if (loud[index] && !shotAt(index)) { if (from < 0) from = index; }
    else close(index);
  }
  close(count);
  return findings;
}
