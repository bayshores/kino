// inspect {targets:["cuts"]}: every cut in the video, one line each, with what was said around it,
// so an agent (and the person) can see whether a cut lands between sentences or inside one:
//
//   cuts in s1 (24 s): 3 · words from whisper (saved transcripts) · dB: loudness change across the cut
//   4.2s interview-1 > broll-2 · before "…we built this" · after "nothing" · -38 dB
//   9.8s broll-2 > interview-2 · before "nothing" · after "So the next…" MID-SENTENCE · +36 dB
//   12s nothing > broll-3 (voice plays on) · before "…and we built" · after "this for you.…" · +0 dB
//
// A cut is a time inside the scene where a video or audio clip starts or ends (clips that meet
// within CUT_JOIN seconds are one cut). "before" is the last 3 words the clips that end there say,
// "after" the first 3 the clips that start there say; MID-SENTENCE marks a side whose file goes on
// (or began) inside a sentence or a word there. A heard clip that plays across the cut (a voice
// under B-roll, a J or L cut) is named "plays on", and its words and sound count on both sides.
// The dB is the change in loudness across the cut (each file's waveform peaks, scaled to that
// file's loudest, times the layer's volume): a big jump is heard. At most CUT_LINES cuts per answer; the last line says how to ask for the rest.
//
// Plain data in and out: the service reads the saved transcripts and peaks (no transcription
// here: inspect stays fast) and hands them in as `heard`.
import { volumeAt } from "../../engine/animation.js";
import { mediaPlaybackRange, mediaSoundTime } from "../../engine/playback.js";
import { EDGE_WINDOW, levelBetween } from "../../engine/quality/loudness.js";
import { spokenWords, SPEECH_HEAD, SPEECH_TAIL } from "../../engine/quality/rules/speech.js";
import { round } from "../../engine/numbers.js";

const CUT_TARGET = /^cuts(?:\[from=(\d+(?:\.\d+)?)\])?$/;
export const CUT_LINES = 40;
const CUT_JOIN = 0.02;
const WORDS = 3;
const SILENT = -60;
const WORD_EDGE = 0.05;

/** True for a target that asks for the cut list: "cuts" or "cuts[from=60]". */
export function isCutTarget(target) {
  return CUT_TARGET.test(String(target).trim());
}

const endsSentence = (text) => /[.!?…]["'”’)\]]*$/.test(String(text).trim());
const said = (words) => words.map((word) => String(word.text).trim()).join(" ");

/** The clips of a scene that a cut can start or end: enabled video and audio layers with a file. */
function clipsOf(scene) {
  return scene.layers
    .filter((layer) => (layer.type === "video" || layer.type === "audio") && layer.src && layer.enabled !== false)
    .map((layer) => ({ layer, range: mediaPlaybackRange(layer, scene.duration) }))
    .filter((clip) => clip.range);
}

/**
 * The cuts of a scene, in time order: [{time, outs, ins}], where outs are the clips that end
 * there and ins the clips that start there ({layer, range} each). The scene's own start and end
 * are not cuts.
 */
export function sceneCuts(scene) {
  const edges = [];
  for (const clip of clipsOf(scene)) {
    if (clip.range.start > CUT_JOIN) edges.push({ time: clip.range.start, side: "ins", clip });
    if (clip.range.end < scene.duration - CUT_JOIN) edges.push({ time: clip.range.end, side: "outs", clip });
  }
  edges.sort((a, b) => a.time - b.time);
  const cuts = [];
  for (const edge of edges) {
    let cut = cuts.at(-1);
    if (!cut || edge.time - cut.time > CUT_JOIN) cuts.push(cut = { time: edge.time, outs: [], ins: [] });
    cut[edge.side].push(edge.clip);
  }
  return cuts;
}

// The words one clip says next to the cut: {words, mid} or {missing} (why there are none).
function wordsAt(clip, side, heard) {
  const entry = heard.get(clip.layer.id);
  if (!entry) return { missing: "muted" };
  if (!entry.words) return { missing: entry.missing ?? "not transcribed" };
  if (clip.range.remapped) return { missing: "speed changed" };
  const words = spokenWords(entry.words);
  const inSource = clip.range.offset;
  const outSource = clip.range.offset + clip.range.duration;
  if (side === "outs") {
    const heardWords = words.filter((word) => word.start < outSource - WORD_EDGE && word.end > inSource);
    const last = heardWords.at(-1);
    const next = words.find((word) => word.start >= outSource - WORD_EDGE);
    const cutWord = words.some((word) => word.start < outSource - WORD_EDGE && word.end > outSource + WORD_EDGE);
    const mid = cutWord || Boolean(last && next && !endsSentence(last.text) && next.start - outSource <= SPEECH_TAIL);
    return { words: heardWords.slice(-WORDS), mid };
  }
  const heardWords = words.filter((word) => word.end > inSource + WORD_EDGE && word.start < outSource);
  const previous = [...words].reverse().find((word) => word.end <= inSource + WORD_EDGE);
  const cutWord = words.some((word) => word.start < inSource - WORD_EDGE && word.end > inSource + WORD_EDGE);
  const mid = cutWord || Boolean(previous && heardWords.length && !endsSentence(previous.text) && inSource - previous.end <= SPEECH_HEAD);
  return { words: heardWords.slice(0, WORDS), mid };
}

// The words a clip that plays across the cut says just before it ("outs") or just after ("ins").
// Its voice is not cut there, so it is never MID-SENTENCE.
function wordsAcross(clip, time, side, heard) {
  const entry = heard.get(clip.layer.id);
  if (!entry.words) return { missing: entry.missing ?? "not transcribed" };
  if (clip.range.remapped) return { missing: "speed changed" };
  const words = spokenWords(entry.words);
  const at = mediaSoundTime(clip.layer, time);
  if (side === "outs") return { words: words.filter((word) => word.start < at && word.end > clip.range.offset).slice(-WORDS), mid: false };
  return { words: words.filter((word) => word.start >= at && word.start < clip.range.offset + clip.range.duration).slice(0, WORDS), mid: false };
}

// What one side of a cut says, as text: "…we built this" (the words of every clip on that side,
// and of every heard clip playing across it, that says any), or why nothing is heard.
function sideText(clips, across, time, side, heard) {
  if (!clips.length && !across.length) return { text: "nothing", whisper: false };
  const found = [...clips.map((clip) => wordsAt(clip, side, heard)), ...across.map((clip) => wordsAcross(clip, time, side, heard))];
  const spoken = found.filter((entry) => entry.words?.length);
  if (!spoken.length) {
    const why = [...new Set(found.map((entry) => entry.missing ?? "no words"))].join(", ");
    return { text: why, whisper: false };
  }
  const text = spoken.map((entry) => (side === "outs" ? `"…${said(entry.words)}"` : `"${said(entry.words)}…"`)).join(" + ");
  return { text: `${text}${spoken.some((entry) => entry.mid) ? " MID-SENTENCE" : ""}`, whisper: true };
}

// The loudness (dB under the file's loudest, times the layer's volume) of one side of a cut: the
// loudest clip there (those playing across it included), SILENT with none, or null when a clip's
// sound is not known (no saved peaks).
function sideLevel(clips, across, time, side, heard) {
  let loudest = SILENT;
  const sides = [...clips.map((clip) => ({ clip, at: side === "outs" ? clip.range.end - 1e-3 : clip.range.start + 1e-3 })), ...across.map((clip) => ({ clip, at: time }))];
  for (const { clip: { layer }, at } of sides) {
    const volume = volumeAt(layer, at);
    if (!(volume > 0) || !heard.has(layer.id)) continue;
    const sound = heard.get(layer.id).sound;
    if (!sound) return null;
    const file = mediaSoundTime(layer, at);
    const level = side === "outs" ? levelBetween(sound, file - EDGE_WINDOW, file) : levelBetween(sound, file, file + EDGE_WINDOW);
    loudest = Math.max(loudest, level + 20 * Math.log10(volume));
  }
  return Math.max(SILENT, loudest);
}

/**
 * The cut list of `scene` as {text, count, shown}. `heard` maps a layer ID to what is known of
 * its sound: {words (the transcript's words, file seconds) | null, missing?, sound (soundLevels)
 * | null}; a layer that is not in it is muted. `name(id)` names a layer or scene; `from` (seconds)
 * starts the list at a later cut.
 */
export function cutListText(scene, heard, { name = (id) => id, from = 0 } = {}) {
  const cuts = sceneCuts(scene);
  const clips = clipsOf(scene);
  const listed = cuts.filter((cut) => cut.time >= from - 1e-6);
  const shown = listed.slice(0, CUT_LINES);
  let whisper = false;
  const lines = shown.map((cut) => {
    const names = (list) => (list.length ? list.map((clip) => name(clip.layer.id)).join("+") : "nothing");
    // The heard clips playing across the cut: a voice under B-roll goes on through it.
    const across = clips.filter(({ layer, range }) => heard.has(layer.id) && range.start < cut.time - CUT_JOIN && range.end > cut.time + CUT_JOIN);
    const before = sideText(cut.outs, across, cut.time, "outs", heard);
    const after = sideText(cut.ins, across, cut.time, "ins", heard);
    whisper ||= before.whisper || after.whisper;
    const out = sideLevel(cut.outs, across, cut.time, "outs", heard);
    const into = sideLevel(cut.ins, across, cut.time, "ins", heard);
    const jump = out == null || into == null ? "dB unknown" : `${into - out >= 0 ? "+" : ""}${Math.round(into - out)} dB`;
    const on = across.length ? ` (${names(across)} play${across.length === 1 ? "s" : ""} on)` : "";
    return `${round(cut.time)}s ${names(cut.outs)} > ${names(cut.ins)}${on} · before ${before.text} · after ${after.text} · ${jump}`;
  });
  const head = `cuts in ${name(scene.id)} (${round(scene.duration)} s): ${cuts.length}${from > 0 ? `, ${listed.length} from ${from}s` : ""}`
    + (whisper ? " · words from whisper (saved transcripts; word times run early)" : "")
    + (shown.length ? " · dB: loudness change across the cut" : "");
  if (!cuts.length) lines.push(clips.length ? "no cuts: every clip plays from the scene's start to its end" : "no cuts: the scene has no video or audio clips");
  else if (!shown.length) lines.push(`no cuts from ${from}s`);
  if (listed.length > shown.length) {
    const next = round(listed[shown.length].time);
    lines.push(`${listed.length - shown.length} more from ${next}s: inspect "cuts[from=${next}]" for the next ones`);
  }
  return { text: [head, ...lines].join("\n"), count: cuts.length, shown: shown.length };
}

/** The `from` of a cut target ("cuts[from=60]" is 60), 0 for "cuts". */
export function cutTargetFrom(target) {
  return Number(CUT_TARGET.exec(String(target).trim())?.[1] ?? 0);
}
