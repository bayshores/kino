// Voice and music levels in LUFS, from a file's measured loudness curve (backend/loudness-curve.mjs:
// FFmpeg's ebur128 momentary loudness, a 400 ms window, every 0.1 s, kept beside the file as
// <file>.lufs). Pure math, shared by duck_audio (how deep a dip goes), the export (each spoken
// line leveled) and the sound rules (voice_under_bed, voice_level_spread).
//
// A curve is {step, momentary: [LUFS or null]}. Loudness over several stretches is the energy mean
// of the values in them (silence under -70 LUFS left out), the way an integrated meter adds them.
import { volumeAt } from "./animation.js";

// Spoken lines are leveled to this at export, each by one gain from its measured words.
export const VOICE_TARGET_LUFS = -16;
// The gain leveling may give a line, either way.
export const MAX_LEVEL_DB = 12;
// A layer turned down under this volume is a bed or background sound (street sound, chatter on
// footage), not a line: the export does not level it and the voice rules leave it out.
export const BED_VOLUME = 0.5;
/** Whether the export levels `layer`'s words (when its file has a transcript). */
export const leveledVoice = (layer) => Number(layer?.volume ?? 1) >= BED_VOLUME;
// duck_audio sets the music this far under the voice during a dip.
export const VOICE_OVER_MUSIC = 9;
// A spoken line is heard at least this many LU over the music under it (voice_under_bed).
export const VOICE_OVER_BED = 6;
const SILENCE = -70;

const db = (volume) => 20 * Math.log10(Math.max(1e-6, volume));
const round1 = (value) => Math.round(value * 10) / 10;

/** The energy mean (LUFS) of `values`, or null when none is above silence. */
export function energyMean(values) {
  const heard = values.filter((value) => Number.isFinite(value) && value > SILENCE);
  if (!heard.length) return null;
  return 10 * Math.log10(heard.reduce((sum, value) => sum + 10 ** (value / 10), 0) / heard.length);
}

/** The curve's values whose times fall in `spans` ([{start, end}] in file seconds). */
export function curveValues(curve, spans) {
  if (!Array.isArray(curve?.momentary) || !(curve.step > 0)) return [];
  const values = [];
  for (const { start, end } of spans) {
    const first = Math.max(0, Math.floor(start / curve.step));
    const last = Math.min(curve.momentary.length - 1, Math.ceil(end / curve.step) - 1);
    for (let index = first; index <= last; index += 1) values.push(curve.momentary[index]);
  }
  return values;
}

/** The loudness (LUFS) of a file over `spans` (file seconds), or null. */
export const loudnessOver = (curve, spans) => energyMean(curveValues(curve, spans));

/** The gain (dB) that brings a line measured at `lufs` to `target` (VOICE_TARGET_LUFS by default), or null. */
export function levelGain(lufs, target = VOICE_TARGET_LUFS) {
  if (!Number.isFinite(lufs)) return null;
  return round1(Math.max(-MAX_LEVEL_DB, Math.min(MAX_LEVEL_DB, target - lufs)));
}

// A kept clip line over music (keep_line). Leveled to the fixed VOICE_TARGET_LUFS under a song
// dipped 9 dB, run 8's only kept line left the mix 2 to 5 LU under the 2 s around it, a hole where
// the line should land (.scratch/run8/trace/audio.md L31-32). Human edits hold the total under a
// line (one measured -10.9 LUFS with and without speech, audio.md L84) or let the music drop out.
// So over music the line sits LINE_OVER_BED LU over the dipped music under it, and the two together
// sum to the music heard in the 2 s around the line. The design asked for the line 3 LU over the
// music around; with a steady song that puts the total 3 LU or more over the 2 s around, so the
// 3 LU is measured against the bed under the line instead (renders in .scratch/run8/wave/line-over-music).
export const LINE_OVER_BED = 3;
// The most the total under a kept line may move from the 2 s around it before the receipt says so.
export const LINE_HOLD_LU = 1.5;
// A dip goes no deeper than this (dB): music under -20 dB sounds switched off (audioDucking DIP_FLOOR).
const LINE_DIP_FLOOR_DB = -20;
const powerSum = (...values) => 10 * Math.log10(values.filter(Number.isFinite).reduce((sum, value) => sum + 10 ** (value / 10), 0));

/**
 * The level of a kept line over music, all in LUFS as heard: `line` the line before leveling (its
 * volume applied), `around` the music in the 2 s around it, `under` the music under it before the
 * dip. Returns {target, gain, heard, dipDb, total} (dipDb: the music's change under the line, 0 or
 * less; -Infinity with dropout), or null when a level is unknown. `dropDb` sets the dip instead
 * (a given dip), `dropout` takes the music out: the line alone then holds the music's level (a guess).
 */
export function lineOverMusic({ line, around, under }, { dropDb, dropout = false } = {}) {
  if (![line, around, under].every(Number.isFinite)) return null;
  // The line that, with a bed LINE_OVER_BED under it, sums to `around`.
  const target = dropout ? around : around - 10 * Math.log10(1 + 10 ** (-LINE_OVER_BED / 10));
  const gain = round1(Math.max(-MAX_LEVEL_DB, Math.min(MAX_LEVEL_DB, target - line)));
  const heard = line + gain;
  const dipDb = dropout ? -Infinity
    : Number.isFinite(dropDb) ? Math.min(0, dropDb)
    : Math.max(LINE_DIP_FLOOR_DB, Math.min(0, heard - LINE_OVER_BED - under));
  const total = powerSum(heard, under + dipDb);
  return { target: round1(target), gain, heard: round1(heard), dipDb: Number.isFinite(dipDb) ? round1(dipDb) : dipDb, total: round1(total) };
}

// A clip whose spoken lines need leveling gains more than this apart is leveled line by line.
export const LINE_SPREAD_DB = 6;

/**
 * How the export levels a voice whose heard words are `spans` [{start, end}] (file seconds): one
 * gain for all of them, or, when its lines (split at pauses over LINE_PAUSE) need gains more than
 * LINE_SPREAD_DB apart (TTS lines made at different levels), one gain per line. Returns null, or
 * {gain, lines?: [{from, to, gain}]} whose lines cover the file, changing gain mid-pause.
 */
export function voiceLeveling(curve, spans, target = VOICE_TARGET_LUFS) {
  const gain = levelGain(loudnessOver(curve, spans), target);
  if (gain === null) return null;
  const groups = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const group = groups.at(-1);
    if (group && span.start - group.at(-1).end <= LINE_PAUSE) group.push(span);
    else groups.push([span]);
  }
  const lines = groups.map((group) => ({ start: group[0].start, end: group.at(-1).end, gain: levelGain(loudnessOver(curve, group), target) ?? gain }));
  const gains = lines.map((line) => line.gain);
  if (lines.length < 2 || Math.max(...gains) - Math.min(...gains) <= LINE_SPREAD_DB) return { gain };
  const middle = (index) => Math.round((lines[index].end + lines[index + 1].start) * 500) / 1000;
  return { gain, lines: lines.map((line, index) => ({ from: index ? middle(index - 1) : -Infinity, to: index < lines.length - 1 ? middle(index) : Infinity, gain: line.gain })) };
}

/**
 * The loudness (LUFS) a leveled voice is heard at in the render, at volume 1: its words `spans`
 * (file seconds) through its curve with the export's leveling gains. Usually VOICE_TARGET_LUFS,
 * but a voice too quiet or loud for MAX_LEVEL_DB stays off it (a TTS line at -34 LUFS is heard at
 * -22). Null without a measurement.
 */
export function leveledLoudness(curve, spans) {
  const leveling = voiceLeveling(curve, spans);
  if (!leveling) return null;
  return energyMean(spans.flatMap((span) => curveValues(curve, [span]).map((value) => (Number.isFinite(value) ? value + levelAt(leveling, span.start) : value))));
}

/** The leveling gain (dB) at file second `time` of a voiceLeveling result (0 without one). */
export const levelAt = (leveling, time) => (leveling?.lines?.find((line) => time >= line.from && time < line.to)?.gain ?? leveling?.gain ?? 0);

/**
 * The music volume for a dip: the music (`music` LUFS at volume 1) sits VOICE_OVER_MUSIC LU under
 * the voice (`voice` LUFS as heard). Never above `current` (a dip does not raise the music), never
 * under 0.02. Null when either is unknown.
 */
export function duckDepth(voice, music, current = 1) {
  if (!Number.isFinite(voice) || !Number.isFinite(music)) return null;
  const volume = 10 ** ((voice - VOICE_OVER_MUSIC - music) / 20);
  return Math.round(Math.max(0.02, Math.min(current, volume)) * 1000) / 1000;
}

/**
 * The loudness (LUFS) of `layer` as heard from `from` to `to` scene seconds: its file's curve
 * through its Play range (`range` from mediaPlaybackRange), its volume at each moment and `gain` dB.
 */
export function heardLoudness(curve, layer, range, from, to, gain = 0) {
  if (!Array.isArray(curve?.momentary) || !range) return null;
  const values = [];
  const step = curve.step;
  for (let time = Math.max(from, range.start); time < Math.min(to, range.end); time += step) {
    const index = Math.floor((range.offset + (time - range.start)) / step);
    const value = curve.momentary[index];
    if (Number.isFinite(value) && value > SILENCE) values.push(value + gain + db(volumeAt(layer, time + step / 2)));
  }
  return energyMean(values);
}

// Beds are measured in steps this long (the curves' step).
const BED_STEP = 0.1;

/**
 * The loudness (LUFS) of several beds heard together from `from` to `to` scene seconds: at each
 * step their energies add up (two beds at -20 LUFS make -17), then the steps are energy-averaged.
 * `beds` are [{curve, layer, range}] as heardLoudness takes them. Null when none is heard.
 */
export function bedLoudness(beds, from, to) {
  const totals = [];
  for (let time = from; time < to - 1e-9; time += BED_STEP) {
    let energy = 0;
    for (const { curve, layer, range } of beds) {
      if (!Array.isArray(curve?.momentary) || !range || time < range.start || time >= range.end) continue;
      const value = curve.momentary[Math.floor((range.offset + (time - range.start)) / curve.step)];
      if (Number.isFinite(value) && value > SILENCE) energy += 10 ** ((value + db(volumeAt(layer, time + BED_STEP / 2))) / 10);
    }
    if (energy > 0) totals.push(10 * Math.log10(energy));
  }
  return energyMean(totals);
}

// A pause this long ends a spoken line.
export const LINE_PAUSE = 0.6;

/**
 * A voice's spoken lines as heard, measured the one way voice_under_bed and duck_audio both use:
 * `words` ([{text, start, end}] in file seconds, inside its Play `range`) split at pauses over
 * LINE_PAUSE and where `breaks(word, next)` says, the voice leveled as the export does
 * (voiceLeveling), its volume applied. Returns [{words, start, end (scene s), lufs, heard}]
 * (heard: each word's {text, start, end (scene s), lufs}); lines under 0.4 s are left out.
 */
export function voiceLines(curve, layer, range, words, breaks = () => false) {
  const leveling = voiceLeveling(curve, words.map((word) => ({ start: word.start, end: word.end })));
  const at = (time) => range.start + (time - range.offset);
  const lines = [];
  let run = [];
  const close = () => {
    if (!run.length) return;
    const start = at(run[0].start), end = at(run.at(-1).end);
    const heard = run.map((word) => ({ text: word.text, start: at(word.start), end: at(word.end), lufs: heardLoudness(curve, layer, range, at(word.start), at(word.end), levelAt(leveling, word.start)) }));
    const lufs = energyMean(heard.map((word) => word.lufs).filter((value) => value !== null));
    if (lufs !== null && end - start >= 0.4) lines.push({ words: run, start, end, lufs, heard });
    run = [];
  };
  for (const word of words) {
    const last = run.at(-1);
    if (last && (word.start - last.end > LINE_PAUSE || breaks(last, word))) close();
    run.push(word);
  }
  close();
  return lines;
}

/**
 * The loudest volume a song may have from `from` to `to` scene seconds for a voice heard at `voice`
 * LUFS to stay VOICE_OVER_BED LU over it, measured like voice_under_bed. `pieces` [{layer, range}]
 * are the song's layers (fit_music's pieces) playing `curve`, with their Play ranges. Rounded down
 * to 0.001; null without a measurement.
 */
export function clearVolume(curve, pieces, voice, from, to) {
  const heard = pieces.map(({ layer, range }) => heardLoudness(curve, { ...layer, volume: 1, animations: [] }, range, from, to)).filter((value) => value !== null);
  const music = energyMean(heard);
  if (music === null) return null;
  return Math.floor(10 ** ((voice - VOICE_OVER_BED - music) / 20) * 1000) / 1000;
}

// Section cues (set_cues, or a song's sections stored as cues) name a song's parts: "drop",
// "drop-2", "section-break" and so on. duck_audio warns when a dip covers one.
const SECTION = /^(?:section-|song-)?(intro|verse|pre-?chorus|chorus|build|drop|break|bridge|outro)\b/i;
export const sectionCues = (cues) => (cues ?? []).filter((cue) => Number.isFinite(cue?.time) && SECTION.test(String(cue.name ?? "")));
