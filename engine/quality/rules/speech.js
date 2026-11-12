// Speech rules: a voice cut off mid-word or mid-sentence, and captions that leave out words the
// voice says. They came from a trailer whose clips stopped at "find me the nearest target" and
// "the best project we saw" (without the rest of the sentence) while every check passed.
//   speech_cut       an audio or video layer's sound starts or stops inside a word or inside a
//                    sentence the file keeps saying (both gates; waive_check for a deliberate cut).
//                    It also hears the cut: the file's loudness (ctx.speech[].loudness, its peaks)
//                    loud right inside a cut near a word is the same gate (word times run early);
//                    with no transcript a loud cut is a warning; a clip that plays to the end of a
//                    file that ends loud is cut off by the file itself. Words cut, muted, or in a
//                    gap between clips of one take on the same clock are left out on purpose: no
//                    cut line there, and no fix brings them back (muted swears, for example)
//   speech_captions  captions are shown over the voice but leave out words it says
//   speech_quotes    captions of heard speech look just like text nobody says (an explanation,
//                    a label), so viewers take the speech for narration (a warning; 2026-10-27)
//
// The agent service hands each scene's heard sound in as ctx.speech: [{layer, transcript} or
// {layer, missing: why}], with ctx.speechScene {duration, layers} (the raw scene). The
// transcript (backend/speech/transcribe.mjs) has words [{text, start, end, cut}] in file seconds.
// Without ctx.speech (edit receipts) the rules do not run.
import { volumeAt } from "../../animation.js";
import { effectiveMediaDuration, mediaPlaybackRange } from "../../playback.js";
import { isRemapped } from "../../mediaTime.js";
import { FILLERS, SOUND_TAG as TAG, cutWordsOf, plainWord, speechPieces } from "../../speech.js";
import { drawnSize, readableRuns, readingTexts, sec } from "../analysis.js";
import { hexRgba } from "../model.js";
import { stringsOf } from "./text.js";
import { LOUD_OVER, SILENT_UNDER, loudAtCut, pauseNear, peakBetween, soundLevels } from "../loudness.js";
import { round as round3 } from "../../numbers.js";

// How far past the out point the next word may start for the sentence to count as cut short.
export const SPEECH_TAIL = 0.6;
// How close before the in point the previous word may end for the start to count as cut.
export const SPEECH_HEAD = 0.3;
// A word counts as cut in half when the edge is this far inside it (word times are not exact).
const WORD_EDGE = 0.05;
// Quiet kept after the last word of a moved out point, and before the first word of an in point.
const BREATH = 0.15;
// The furthest a fix moves an edge to finish (or start) the sentence.
const MAX_MOVE = 8;
// Pieces of one voice (cut_speech) that join within this many seconds are one take: no edge there.
const JOIN = 0.1;
const HEARD = 0.05;
// A pause this long between two words is a sentence break too: whisper often drops the full stop
// ("target is on your right" then "now I'll find…", 0.5 s apart).
export const SENTENCE_PAUSE = 0.3;

const endsSentence = (text) => /[.!?…]["'”’)\]]*$/.test(String(text).trim());
// The voice may stop after `word`: its text ends a sentence, or a pause follows it. The pause is
// `pauseAfter` (heardEdges): up to the next word the recording says, fillers included, so an "um"
// dropped from the words does not look like a pause.
export const breakAfter = (word, next) => endsSentence(word.text) || !next || (word.pauseAfter ?? next.start - word.end) >= SENTENCE_PAUSE;
const said = (words) => words.map((word) => word.text.trim()).join(" ");

function isHeard(layer) {
  return (layer.type === "audio" || layer.type === "video") && Boolean(layer.src) && layer.enabled !== false;
}

// The scene stretch where the layer is heard: its Play range without the silent ends of a fade.
function heardRange(layer, sceneDuration) {
  const range = mediaPlaybackRange(layer, sceneDuration);
  if (!range || range.remapped || isRemapped(layer)) return null;
  const step = 1 / 60;
  let start = range.start;
  let end = range.end;
  while (start < end && volumeAt(layer, start + step / 2) <= HEARD) start += step;
  while (end > start && volumeAt(layer, end - step / 2) <= HEARD) end -= step;
  if (end - start < 0.05) return null;
  const fadedOut = end < range.end - step;
  const fadedIn = start > range.start + step;
  return { ...range, heardStart: start, heardEnd: end, inSource: range.offset + (start - range.start), outSource: range.offset + (end - range.start), faded: fadedIn || fadedOut, fadedIn, fadedOut };
}

// The first cut (a video layer's Play starting or ending) a fix would carry the sound over, moving
// one edge of `layer` from `from` to `to` (scene seconds): such a move takes the voice into another
// shot, so it is offered, never applied by itself. Null when none.
function cutCrossed(scene, layer, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  // Its own pieces, and the clips of its take on the same clock: the voice stays in sync there.
  const own = new Set([...speechPieces(scene, layer), ...sameClock(scene, layer).map((other) => other.layer)]);
  let found = null;
  for (const other of scene.layers) {
    if (other.type !== "video" || !other.src || other.enabled === false || own.has(other)) continue;
    const range = mediaPlaybackRange(other, scene.duration);
    if (!range) continue;
    for (const [time, what] of [[range.start, "starts"], [range.end, "ends"]]) {
      if (time <= 1e-3 || time >= scene.duration - 1e-3) continue;
      // An edge right at the old point counts (the voice starts or ends on that cut).
      const inside = to < from ? time > lo + 1e-3 && time <= hi + 0.05 : time >= lo - 0.05 && time < hi - 1e-3;
      if (inside && (!found || Math.abs(time - from) < Math.abs(found.time - from))) found = { time, text: `the cut at ${sec(time)} s ("${other.name}" ${what})` };
    }
  }
  return found;
}

// The earliest hide of the layer (its sound may run on, but a fix must not pass it).
const hideAt = (layer) => Math.min(...(layer.animations ?? []).filter((animation) => animation?.kind === "hide").map((animation) => animation.start ?? Infinity), Infinity);

// Whisper writes a whoosh or a song's hook as one word over and over ("whoop, whoop, whoop"):
// three or more words that are nearly all the same word are a sound, not speech.
export function soundAsWords(words) {
  if (words.length < 3) return false;
  const distinct = new Set(words.map((word) => plainWord(word.text)));
  return distinct.size / words.length <= 0.34;
}

const OPENS = /[[(]/;
const CLOSES = /[\])]/;
const BRACKETS = /[[\]()]/;
// A tag split over words is at most this many words past its bracketed one.
const TAG_WORDS = 3;
export const isFiller = (text) => FILLERS.has(plainWord(text)) || /^m+h+m+$/.test(plainWord(text));
// Two words of one tag: no punctuation and no gap between them.
const touching = (before, after) => !/[.,!?;:…]$/.test(String(before.text ?? "").trim()) && !(after.start - before.end > 0.1);
// The word ends inside an open tag ("[camera", "music)(upbeat").
const endsInTag = (text) => Math.max(text.lastIndexOf("["), text.lastIndexOf("(")) > Math.max(text.lastIndexOf("]"), text.lastIndexOf(")"));

// The word that closes the tag opened at words[index], or -1 when none does within TAG_WORDS
// touching words (its closing bracket was lost: then only the opening word goes, real words stay).
function tagClose(words, index) {
  for (let next = index + 1; next <= index + TAG_WORDS && next < words.length; next += 1) {
    if (!touching(words[next - 1], words[next])) return -1;
    if (CLOSES.test(String(words[next].text ?? ""))) return next;
  }
  return -1;
}

// The words a voice really says, or [] when the transcript holds only sound. Whisper writes music
// and noises as tags ("[Music]", "(laughs)", "♪"), and a tag can come split over words ("camera",
// "shutter]" for a shutter click): every word of a tag goes, and so do kino's "(unclear)" entries.
// Fillers ("um", "mhm") go too: an app's beeps are often written as "um", and a filler cut short
// is not a sentence cut short. A sound written as one word over and over is no voice at all.
export function spokenWords(words) {
  const kept = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const text = String(word.text ?? "");
    if (!BRACKETS.test(text)) {
      if (!word.unclear && !text.includes("♪") && plainWord(text) && !isFiller(text)) kept.push(word);
      continue;
    }
    const close = text.search(CLOSES);
    const open = text.search(OPENS);
    if (close >= 0 && (open < 0 || close < open)) {
      // A tag whose opening bracket was lost: the words touching it just before are the tag. This
      // guess can drop a few real words next to a tag ("now laughs]"), which only hides findings there.
      let joined = word;
      for (let count = 0; count < TAG_WORDS && kept.length && touching(kept.at(-1), joined); count += 1) joined = kept.pop();
    }
    // The bracketed word goes; an open tag runs on to the word that closes it (which may open the next).
    while (endsInTag(String(words[index].text ?? ""))) {
      const end = tagClose(words, index);
      if (end < 0) break;
      index = end;
    }
  }
  return soundAsWords(kept) ? [] : kept;
}

// A sentence tail (speech_fragment): this many spoken words at most, said this close after the
// sentence before it (seconds in the file).
export const FRAGMENT_WORDS = 3;
export const TALKING_BEFORE = 1.5;
// Words that carry on a sentence, not start one.
const CONTINUES = new Set(["at", "in", "on", "to", "of", "for", "from", "with", "by", "near", "and", "but", "or", "so", "because", "than", "then", "which", "that", "who", "where", "like"]);

// The words from `first` look like the rest of a sentence: a filler or a lowercase word heads
// them, or the first word carries a sentence on ("at", "and").
export function continues(transcript, previous, first) {
  const between = (transcript.words ?? []).filter((word) => word.start >= previous.end - 1e-3 && word.start < first.start - 1e-3);
  if (between.some((word) => isFiller(word.text))) return true;
  const text = String(first.text ?? "").trim();
  return /^[a-z]/.test(text) || CONTINUES.has(plainWord(text));
}

// The sentence starting at words[index] is the dangling tail of the one before it ("target? Uh,
// at school."): said right after it, 3 words or fewer, reading as its rest.
export function isTail(transcript, words, index) {
  const previous = words[index - 1];
  if (!previous || words[index].start - previous.end > TALKING_BEFORE) return false;
  let end = index;
  while (end < words.length - 1 && !breakAfter(words[end], words[end + 1])) end += 1;
  return end - index + 1 <= FRAGMENT_WORDS && continues(transcript, previous, words[index]);
}

// Copies of `words` with `pauseAfter`: the seconds to the next word said (a sound tag is quiet).
export function withPauses(words) {
  let next = null;
  const timed = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    timed[index] = { ...word, pauseAfter: next ? next.start - word.end : Infinity };
    if (!TAG.test(String(word.text ?? ""))) next = word;
  }
  return timed;
}

// Other layers playing the same file on the same clock as `layer` (the same file second at each
// scene second): one take cut into clips, such as room cuts around a muted swear. [{layer, range,
// heard}]: `heard` is the clip's heardRange, null for a clip never heard (a video kept for its
// picture at volume 0), which carries no words in the mix.
export function sameClock(scene, layer) {
  const own = mediaPlaybackRange(layer, scene.duration);
  if (!own || own.remapped || isRemapped(layer)) return [];
  return scene.layers.filter((other) => other !== layer && other.src === layer.src && isHeard(other) && !isRemapped(other))
    .map((other) => ({ layer: other, range: mediaPlaybackRange(other, scene.duration) }))
    .filter(({ range }) => range && Math.abs((range.start - range.offset) - (own.start - own.offset)) <= JOIN)
    .map((entry) => ({ ...entry, heard: heardRange(entry.layer, scene.duration) }));
}

// The transcript indices left out on purpose: cut_speech's cuts, a gap between clips of one take
// on the same clock, and words a mute inside the heard stretch holds at 0 all through (a fade at
// either end is speech_cut's to judge). No fix brings them back.
function removedWords(scene, layer, range, transcript, pieces, siblings) {
  const removed = cutWordsOf(pieces, transcript);
  // Only a gap a fix could cover (MAX_MOVE) reads as a cut; clips far apart are separate lines.
  const near = siblings.filter(({ heard }) => heard.heardStart - range.heardEnd <= MAX_MOVE && range.heardStart - heard.heardEnd <= MAX_MOVE);
  if (near.length) {
    const played = [range, ...near.map((other) => other.heard)];
    const from = Math.min(...played.map((stretch) => stretch.inSource));
    const to = Math.max(...played.map((stretch) => stretch.outSource));
    // A word in a gap that no clip plays any part of: one a clip starts or ends inside is cut in half.
    transcript.words.forEach((word, index) => {
      if (word.start >= from && word.end <= to && !played.some((stretch) => word.start < stretch.outSource - WORD_EDGE && word.end > stretch.inSource + WORD_EDGE)) removed.add(index);
    });
  }
  const toScene = (time) => range.start + (time - range.offset);
  transcript.words.forEach((word, index) => {
    const from = toScene(word.start), to = toScene(word.end);
    if (from >= range.heardStart && to <= range.heardEnd && [from, (from + to) / 2, to].every((time) => volumeAt(layer, time) <= HEARD)) removed.add(index);
  });
  return removed;
}

// Each heard sound layer with its range, its spoken words (null without a transcript, [] when the
// transcript holds only sound), its loudness, and which of its edges are real cuts (not a join
// between two pieces of one cut_speech voice, or with a clip of its take on the same clock).
// `removed` holds the [start, end] file seconds of words left out on purpose; `carried(word)` is
// true when a clip of the same take plays that word (the line goes on in the mix).
export function heardEdges(ctx) {
  const scene = ctx.speechScene;
  if (!scene) return [];
  const list = [];
  for (const entry of ctx.speech ?? []) {
    const { layer, transcript } = entry;
    // A song is heard for music_hard_stop only (engine/quality/rules/sound.js): its lyrics are no voice.
    if (entry.music || !isHeard(layer)) continue;
    const range = heardRange(layer, scene.duration);
    if (!range) continue;
    const pieces = speechPieces(scene, layer);
    // Only clips heard carry the line on: a muted copy of the take is picture only.
    const siblings = sameClock(scene, layer).filter((other) => other.heard);
    // Words left out on purpose are not said: the voice does not go on with them.
    const cut = transcript?.words ? removedWords(scene, layer, range, transcript, pieces, siblings) : new Set();
    // A whoosh or a click has no spoken words ([]): no speech rule treats it as a voice. A word
    // over measured silence was not said (a transcript hears "um" in a TTS track's quiet), so it
    // neither makes a cut mid-word nor carries a sentence on.
    const sound = soundLevels(entry.loudness);
    const said = (word) => !sound || !(word.end > word.start) || peakBetween(sound, word.start, word.end) >= SILENT_UNDER;
    const words = transcript?.words ? spokenWords(withPauses(transcript.words.filter((word, index) => !cut.has(index) && said(word)))) : null;
    const others = [...pieces.filter((piece) => piece !== layer).map((piece) => mediaPlaybackRange(piece, scene.duration)), ...siblings.map(({ heard }) => ({ start: heard.heardStart, end: heard.heardEnd }))].filter(Boolean);
    list.push({
      layer, transcript, words, range, sound,
      removed: [...cut].map((index) => [transcript.words[index].start, transcript.words[index].end]),
      carried: (word) => siblings.some(({ heard }) => word.start >= heard.inSource - WORD_EDGE && word.start < heard.outSource - WORD_EDGE),
      joinedOut: others.some((other) => Math.abs(other.start - range.end) <= JOIN || (other.start < range.end && other.end > range.end + JOIN)),
      joinedIn: others.some((other) => Math.abs(other.end - range.start) <= JOIN || (other.start < range.start - JOIN && other.end > range.start)),
    });
  }
  return list;
}

// Whether a fix playing the file from `from` to `to` seconds would bring back a word left out on purpose.
const bringsBack = (voice, from, to) => (voice.removed ?? []).some(([start, end]) => start < Math.max(from, to) && end > Math.min(from, to));

// The heard layers with a transcript of two spoken words or more.
const voices = (ctx) => heardEdges(ctx).filter((edge) => edge.words?.length >= 2);

/** Says in check's notes which heard sound the speech rules could not read. */
function noteMissing(ctx, code) {
  const scene = ctx.speechScene;
  for (const entry of ctx.speech ?? []) {
    // A file with no sound, or a layer never heard (volume 0 or muted), has nothing to read: no note.
    if (!entry.transcript && entry.missing && !/has no sound/i.test(entry.missing) && !(scene && (!isHeard(entry.layer) || !heardRange(entry.layer, scene.duration))))
      ctx.note(`${code} ${entry.loudness?.available ? "heard only the loudness of" : "did not run on"} "${entry.layer.name ?? entry.layer.id}": ${entry.missing}`);
  }
}

// ---------------------------------------------------------------- speech_cut

// The out point: a word cut in half, or a sentence the file keeps saying.
function outFinding(voice, ctx) {
  const { layer, transcript, range } = voice;
  const words = voice.words;
  const out = range.outSource;
  const cutIndex = words.findIndex((word) => word.start < out - WORD_EDGE && word.end > out + WORD_EDGE);
  const nextIndex = cutIndex >= 0 ? cutIndex : words.findIndex((word) => word.start >= out - WORD_EDGE);
  const next = words[nextIndex];
  const lastHeard = [...words].reverse().find((word) => word.start < out - WORD_EDGE && word.end > range.inSource);
  if (cutIndex < 0 && (!next || next.start - out > SPEECH_TAIL || !lastHeard || breakAfter(lastHeard, next))) return null;
  // A clip of the same take on the same clock says the rest: the line goes on in the mix.
  if (cutIndex < 0 && voice.carried(next)) return null;
  // The rest of the sentence the file says after the out point.
  let endIndex = nextIndex;
  while (endIndex < words.length - 1 && !breakAfter(words[endIndex], words[endIndex + 1])) endIndex += 1;
  const rest = words.slice(nextIndex, endIndex + 1);
  const heardTail = words.filter((word) => word.end > range.inSource && word.start < out - WORD_EDGE).slice(-4);
  const cut = cutIndex >= 0 ? words[cutIndex] : null;
  const fileLength = Math.min(transcript.duration ?? Infinity, layer.mediaSourceDuration > 0 ? layer.mediaSourceDuration : Infinity);
  const target = Math.min(words[endIndex].end + BREATH, words[endIndex + 1]?.start ?? Infinity, fileLength);
  const extend = target - out;
  const measured = cut
    ? `stops at ${sec(out)} s in the file, inside "${cut.text.trim()}" (${sec(cut.start)} to ${sec(cut.end)} s); heard: "…${said(heardTail)}"`
    : `stops at ${sec(out)} s in the file after "…${said(heardTail)}"; the file goes on "${said(rest)}" ${sec(Math.max(0, next.start - out))} s later`;
  return {
    // A sentence cut short is a gate even under a fade (a reviewer heard them in a final render);
    // only a word faded out under its end is a warning.
    rule: "speech_cut", severity: cut && range.fadedOut ? "warn" : "error", layerId: layer.id, at: sec(range.heardEnd),
    message: cut
      ? `"${layer.name}" cuts the word "${cut.text.trim()}" in half at its end.`
      : `"${layer.name}" stops mid-sentence: the voice goes on "${said(rest)}".`,
    measured,
    required: "end on a whole word, at the end of a sentence (or with the voice quiet for 0.6 s after it)",
    fix: outFix(voice, ctx, { extend, out, words, rest }),
  };
}

function outFix(voice, ctx, { extend, out, words, rest }) {
  const { layer, range } = voice;
  const scene = ctx.speechScene;
  // Playing on would bring back a word left out on purpose (a muted swear): never offered.
  if (extend > 0 && extend <= MAX_MOVE && !bringsBack(voice, out, out + extend)) {
    const newEnd = range.heardEnd + extend;
    const crossed = cutCrossed(scene, layer, range.heardEnd, newEnd);
    const inScene = newEnd <= scene.duration + 1e-6 && newEnd <= hideAt(layer) + 1e-6;
    const safe = !range.faded && !(layer.playbackWindows ?? []).length && inScene && !crossed;
    const mediaDuration = durationTo(layer, range, out + extend);
    // A volume fade, not the clip, ends the voice: the fade is what moves.
    if (range.faded && mediaDuration <= effectiveMediaDuration(layer) + 1e-3)
      return { kind: "hint", text: `The volume fade out of "${layer.name}" ends the voice at ${sec(range.heardEnd)} s, inside "${said(rest)}": end the fade ${sec(extend)} s later, or waive speech_cut if the mute is on purpose.` };
    const moved = `mediaDuration ${sec(effectiveMediaDuration(layer))} to ${sec(mediaDuration)}: its end moves ${sec(extend)} s later, ${sec(range.heardEnd)} to ${sec(newEnd)} s`;
    return {
      kind: "layer", layerId: layer.id, properties: { mediaDuration }, auto: safe,
      why: `plays on to finish "${said(rest)}" (${moved})${safe ? "" : range.faded ? "; move its volume fade out too"
        : crossed ? `; that carries the voice over ${crossed.text} into the next shot, so it is not applied by itself` : "; that runs past the scene end or the layer's hide: lengthen the scene first"}`,
    };
  }
  // Otherwise end at the last sentence end heard, when there is one.
  const previous = [...words].reverse().find((word) => word.end <= out && word.start > range.inSource && breakAfter(word, words[words.indexOf(word) + 1]));
  if (previous) {
    const end = Math.min(previous.end + BREATH, out);
    return { kind: "layer", layerId: layer.id, properties: { mediaDuration: durationTo(layer, range, end) }, auto: false, why: `ends ${sec(out - end)} s sooner, after "${previous.text.trim()}"` };
  }
  return { kind: "hint", text: `Move the end of "${layer.name}" to the end of a sentence (inspect speech:${layer.name} lists the words with their times), or waive speech_cut if the cut is on purpose.` };
}

// The in point: a word cut in half, or a start inside a sentence that began just before.
function inFinding(voice, ctx) {
  const { layer, transcript, range } = voice;
  const words = voice.words;
  const at = range.inSource;
  const cutIndex = words.findIndex((word) => word.start < at - WORD_EDGE && word.end > at + WORD_EDGE);
  const firstIndex = cutIndex >= 0 ? cutIndex : words.findIndex((word) => word.start >= at - WORD_EDGE);
  if (firstIndex < 0 || words[firstIndex].start > range.outSource) return null;
  const previous = words[firstIndex - 1];
  if (cutIndex < 0 && (!previous || at - previous.end > SPEECH_HEAD || breakAfter(previous, words[firstIndex]))) return null;
  // A clip of the same take on the same clock said the words before: the line is whole in the mix.
  if (cutIndex < 0 && voice.carried(previous)) return null;
  // Back to the first word of the sentence (only the words it needs), and past a break whose next
  // sentence would be a dangling tail (speech_fragment's "?, uh, at school."), so the fix lands on
  // a start speech_fragment passes too.
  let startIndex = firstIndex;
  const sentenceStart = (index) => { while (index > 0 && !breakAfter(words[index - 1], words[index])) index -= 1; return index; };
  startIndex = sentenceStart(startIndex);
  while (startIndex > 0 && isTail(transcript, words, startIndex)) startIndex = sentenceStart(startIndex - 1);
  const before = words.slice(startIndex, firstIndex + (cutIndex >= 0 ? 1 : 0));
  const target = Math.max(0, (words[startIndex].cut ?? words[startIndex].start) - BREATH * 0.5, words[startIndex - 1]?.end ?? 0);
  const back = at - target;
  const cut = cutIndex >= 0 ? words[cutIndex] : null;
  const heardHead = words.slice(firstIndex + (cut ? 1 : 0), firstIndex + (cut ? 1 : 0) + 4);
  const fix = (() => {
    const duration = effectiveMediaDuration(layer);
    // Starting earlier would bring back a word left out on purpose (a muted swear): never offered.
    if (!(back > 0 && back <= MAX_MOVE) || bringsBack(voice, at - back, at)) return { kind: "hint", text: `Move the start of "${layer.name}" to the start of a sentence, or waive speech_cut if it is on purpose.` };
    const start = (layer.mediaStart ?? 0) - back;
    const properties = { mediaOffset: round3(Math.max(0, (layer.mediaOffset ?? 0) - back)), mediaStart: round3(start), ...(Number.isFinite(duration) && layer.mediaDuration > 0 ? { mediaDuration: round3(duration + back) } : {}) };
    const crossed = cutCrossed(ctx.speechScene, layer, range.heardStart, range.heardStart - back);
    // A video drawn earlier would cover what is before it, so only a sound starts earlier by itself.
    const safe = layer.type === "audio" && start >= 0 && !range.faded && !(layer.playbackWindows ?? []).length && !crossed;
    const moved = `mediaStart ${sec(layer.mediaStart ?? 0)} to ${sec(start)}, mediaOffset ${sec(layer.mediaOffset ?? 0)} to ${sec(properties.mediaOffset)}: the voice starts ${sec(back)} s earlier, at ${sec(range.heardStart - back)} s`;
    return {
      kind: "layer", layerId: layer.id, properties, auto: safe,
      why: `starts at "${said(before.slice(0, 4))}" (${moved})${crossed ? `; that carries the voice back over ${crossed.text} into the shot before, so it is not applied by itself` : ""}`,
    };
  })();
  return {
    rule: "speech_cut", severity: cut && range.fadedIn ? "warn" : "error", layerId: layer.id, at: sec(range.heardStart),
    message: cut
      ? `"${layer.name}" cuts the word "${cut.text.trim()}" in half at its start.`
      : `"${layer.name}" starts mid-sentence: the voice said "${said(before.slice(-4))}" just before.`,
    measured: cut
      ? `starts at ${sec(at)} s in the file, inside "${cut.text.trim()}" (${sec(cut.start)} to ${sec(cut.end)} s)`
      : `starts at ${sec(at)} s in the file with "${said(heardHead)}…"; "${previous.text.trim()}" ends ${sec(Math.max(0, at - previous.end))} s before`,
    required: "start on a whole word, at the start of a sentence (or after 0.3 s of quiet)",
    fix,
  };
}

// ---------------------------------------------------------------- speech_cut by loudness

const pauseText = (pause) => (pause ? `${sec(pause.start)} to ${sec(pause.end)} s` : "none");
const pausesText = (before, after) => `the nearest pauses in the file: ${pauseText(before)} before, ${pauseText(after)} after`;
// The mediaDuration that ends Play at `source` seconds into the file (speed 1).
const durationTo = (layer, range, source) => round3(source - range.offset + range.start - (layer.mediaStart ?? 0));
// A point inside a pause to cut at: a breath into it, or its middle when it is short.
const intoPause = (pause, fromStart) => (fromStart ? pause.start + Math.min(BREATH, (pause.end - pause.start) / 2) : pause.end - Math.min(BREATH, (pause.end - pause.start) / 2));

// Whether the transcript has a word near a cut (the voice is speaking there): for an out point, a
// word ending at most 0.3 s before it or starting within SPEECH_TAIL after it; for an in point,
// a word starting at most 0.3 s after it or ending within SPEECH_HEAD before it.
function wordNear(words, time, side) {
  return side === "out"
    ? words.some((word) => word.end >= time - 0.3 && word.start <= time + SPEECH_TAIL)
    : words.some((word) => word.start <= time + 0.3 && word.end >= time - SPEECH_HEAD);
}

// The last sentence end before the unfinished words at a file's end, within MAX_MOVE of it:
// {index, end} (end: a breath after that word, before the next word starts), or null.
function lastSentenceEnd(inClip, out) {
  for (let index = inClip.length - 2; index >= 0; index -= 1) {
    const word = inClip[index];
    if (out - word.end > MAX_MOVE) return null;
    if (breakAfter(word, inClip[index + 1])) return { index, end: round3(Math.min(word.end + BREATH, (word.end + inClip[index + 1].start) / 2)) };
  }
  return null;
}

// The out point heard: a clip that plays to the end of a file that ends loud, or that ends inside
// loud sound. Null when the cut is quiet, or loud with no word near (music, noise).
function loudOutFinding(edge) {
  const { layer, range, sound, words } = edge;
  if (!sound || (words && !words.length)) return null;
  const out = range.outSource;
  const heard = loudAtCut(sound, out, "out");
  if (!heard.loud || (words && !wordNear(words, out, "out"))) return null;
  const sure = Boolean(words);
  const severity = !sure || range.fadedOut ? "warn" : "error";
  const fileEnds = out >= sound.duration - 0.05;
  const inClip = words ? words.filter((word) => word.start < out && word.end > range.inSource) : [];
  // A file that ends right after a word ending a sentence is whole: a text-to-speech file stops
  // at its last word's full stop, so its last 120 ms are loud without anything being cut.
  if (fileEnds && inClip.length && endsSentence(inClip.at(-1).text)) return null;
  const before = pauseNear(sound, out, "before");
  const after = fileEnds ? null : pauseNear(sound, out, "after");
  const lastWords = inClip.slice(-4);
  const heardTail = lastWords.length ? ` after "…${said(lastWords)}"` : "";
  // End in the pause after (finish the word) when it is near, otherwise in the pause before.
  // (A pause before the clip's own start is no place to end it.) A file that ends mid-sentence
  // ends instead after the last whole sentence heard: only the unfinished words are dropped.
  const sentenceEnd = fileEnds && words ? lastSentenceEnd(inClip, out) : null;
  const target = sentenceEnd ? sentenceEnd.end
    : fileEnds && words ? null
    : after && after.start - out <= MAX_MOVE ? intoPause(after, true)
    : before && out - before.end <= MAX_MOVE && intoPause(before, true) > range.inSource + 0.2 ? intoPause(before, true) : null;
  const dropped = sentenceEnd ? inClip.slice(sentenceEnd.index + 1) : [];
  const fix = target != null
    ? { kind: "layer", layerId: layer.id, properties: { mediaDuration: durationTo(layer, range, target) }, auto: false,
        why: sentenceEnd ? `ends at ${sec(target)} s in the file, after "${inClip[sentenceEnd.index].text.trim()}"; drops the unfinished "${said(dropped)}"` : `ends at ${sec(target)} s in the file, in a pause (${pausesText(before, after)})` }
    : { kind: "hint", text: fileEnds
      ? `The file has no pause inside "${layer.name}" before it ends (${pausesText(before, after)}): end the clip on an earlier sentence, start it later, or waive speech_cut if the cut is on purpose.`
      : `Move the end of "${layer.name}" into a pause (${pausesText(before, after)}), or waive speech_cut if the cut is on purpose.` };
  if (fileEnds) {
    return {
      rule: "speech_cut", severity, layerId: layer.id, at: sec(range.heardEnd),
      message: `"${layer.name}" plays to the end of its file, and the file itself ends mid-sentence: the voice is still sounding at ${sec(out)} s.`,
      measured: `the last 120 ms of the file are ${heard.over} dB over its quiet level${heardTail}`,
      required: `end the clip at the last pause before the file ends (${pauseText(before)})`,
      fix,
    };
  }
  return {
    rule: "speech_cut", severity, layerId: layer.id, at: sec(range.heardEnd),
    message: sure
      ? `"${layer.name}" stops mid-sentence: the voice is still sounding at its end (the transcript's word times run early).`
      : `"${layer.name}" stops inside loud sound (a voice, it may be; no transcript says which).`,
    measured: `stops at ${sec(out)} s in the file with the sound ${heard.over} dB over its quiet level${heardTail}`,
    required: `end in a pause (under ${LOUD_OVER} dB over the file's quiet level)`,
    fix,
  };
}

// The in point heard: a clip that starts inside loud sound near a word.
function loudInFinding(edge) {
  const { layer, range, sound, words } = edge;
  if (!sound || (words && !words.length)) return null;
  const at = range.inSource;
  // At the file's own start there is nothing earlier to start on.
  if (at < 0.05) return null;
  const heard = loudAtCut(sound, at, "in");
  if (!heard.loud || (words && !wordNear(words, at, "in"))) return null;
  const sure = Boolean(words);
  const before = pauseNear(sound, at, "before");
  const after = pauseNear(sound, at, "after");
  const target = before && at - before.end <= MAX_MOVE ? intoPause(before, false) : null;
  const back = target != null ? at - target : 0;
  const duration = effectiveMediaDuration(layer);
  const fix = back > 0
    ? { kind: "layer", layerId: layer.id, auto: false, why: `starts ${sec(back)} s sooner, in a pause (${pausesText(before, after)})`,
        properties: { mediaOffset: round3(Math.max(0, (layer.mediaOffset ?? 0) - back)), mediaStart: round3((layer.mediaStart ?? 0) - back), ...(Number.isFinite(duration) && layer.mediaDuration > 0 ? { mediaDuration: round3(duration + back) } : {}) } }
    : { kind: "hint", text: `Move the start of "${layer.name}" into a pause (${pausesText(before, after)}), or waive speech_cut if the cut is on purpose.` };
  const firstWords = words ? words.filter((word) => word.end > at).slice(0, 4) : [];
  return {
    rule: "speech_cut", severity: !sure || range.fadedIn ? "warn" : "error", layerId: layer.id, at: sec(range.heardStart),
    message: sure
      ? `"${layer.name}" starts mid-sentence: the voice is already sounding at its start (the transcript's word times run early).`
      : `"${layer.name}" starts inside loud sound (a voice, it may be; no transcript says which).`,
    measured: `starts at ${sec(at)} s in the file with the sound ${heard.over} dB over its quiet level${firstWords.length ? `, before "${said(firstWords)}…"` : ""}`,
    required: `start in a pause (under ${LOUD_OVER} dB over the file's quiet level)`,
    fix,
  };
}

/** speech_cut: a voice clip that stops or starts inside a word or a sentence (gates). */
export function speechCut(model, ctx) {
  noteMissing(ctx, "speech_cut");
  const findings = [];
  for (const edge of heardEdges(ctx)) {
    const voice = edge.words?.length >= 2 ? edge : null;
    // A file that ends mid-sentence comes first: no move of the end inside the file fixes it.
    const fileEnds = edge.sound && edge.range.outSource >= edge.sound.duration - 0.05;
    if (!edge.joinedIn) findings.push((voice && inFinding(voice, ctx)) || loudInFinding(edge));
    if (!edge.joinedOut) findings.push((fileEnds && loudOutFinding(edge)) || (voice && outFinding(voice, ctx)) || loudOutFinding(edge));
  }
  return findings.filter(Boolean);
}

// ---------------------------------------------------------------- speech_captions

// The words a voice plays, in scene seconds: [{text, start, end}] (no fillers or unclear sound).
export function heardWords({ words, range }) {
  const toScene = (time) => range.start + (time - range.offset);
  return words
    .filter((word) => word.start >= range.inSource - WORD_EDGE && word.end <= range.outSource + WORD_EDGE && !word.unclear && !FILLERS.has(plainWord(word.text)) && plainWord(word.text))
    .map((word) => ({ text: word.text.trim(), start: toScene(word.start), end: toScene(word.end) }));
}

// The scene times each caption text is shown (opacity over 5%), as [start, end] stretches.
function captionStretches(model) {
  const list = [];
  for (const item of model.items) {
    if (item.role !== "caption" || !item.text) continue;
    const words = new Set(item.text.split(/\s+/).map(plainWord).filter(Boolean));
    let from = null;
    model.times.forEach((time, index) => {
      const shown = item.samples.opacity[index] > HEARD;
      if (shown && from == null) from = time;
      if (!shown && from != null) { list.push({ words, start: from, end: time }); from = null; }
    });
    if (from != null) list.push({ words, start: from, end: model.duration });
  }
  return list;
}

/**
 * speech_captions: captions are shown over a voice but leave out words it says, or a text shows
 * the line of a clip that is muted there (the viewer reads a voice they never hear).
 */
export function speechCaptions(model, ctx) {
  return [...captionGaps(model, ctx), ...mutedLines(model, ctx)];
}

// A text shows this share of a line's words (2 or more words) while its clip is muted.
const LINE_SHOWN = 0.6;
// A muted clip's line counts as covered when this share of its words is heard from another sound.
const LINE_HEARD = 0.6;

// A clip this much quieter than the song under it, or less, cannot be heard over it.
const UNDER_SONG = 0.25;
// The song counts as a bed for that when its volume is at least this.
const SONG_BED = 0.5;

// The volumes `layer` is at from `from` to `to` (scene seconds), every 0.1 s.
function volumesBetween(layer, from, to) {
  const list = [];
  for (let time = from; time < to + 1e-6; time += 0.1) list.push(volumeAt(layer, Math.min(time, to)));
  return list;
}

// The layer is muted from `from` to `to` (scene seconds): at 0.05 or less, or at a quarter of a song
// that plays the whole stretch at 0.5 or more (a voice far under a song is not heard either).
function mutedBetween(scene, layer, from, to) {
  const top = Math.max(...volumesBetween(layer, from, to));
  if (top <= HEARD) return true;
  const songs = scene.layers.filter((other) => other.id !== layer.id && other.type === "audio" && other.src && other.enabled !== false)
    .filter((other) => { const range = mediaPlaybackRange(other, scene.duration); return range && range.start <= from + 1e-6 && range.end >= to - 1e-6; });
  const bed = Math.max(0, ...songs.map((song) => Math.min(...volumesBetween(song, from, to))));
  return bed >= SONG_BED && top <= UNDER_SONG * bed;
}

// ---------------------------------------------------------------- speech_unplayed
/**
 * speech_unplayed: the video's clips say lines (ctx.savedLines: saved transcripts of every clip on
 * a layer, heard or muted, read in every check) and no layer plays any of them. Run 6 and the five
 * runs before it muted every clip; nothing but a once-only status note said so
 * (.scratch/ceiling/trace-code.md section 4). One warning for the scene, with the keep_line call
 * for its best line: a whole line at speed 1, the most words up to 12, the earliest. A silent edit
 * on purpose waives it with a reason.
 */
export function speechUnplayed(model, ctx) {
  const scene = ctx.speechScene;
  const lines = (ctx.savedLines ?? []).filter((line) => line?.layerId && line.text && Number.isFinite(line.from) && Number.isFinite(line.to));
  if (!scene || !lines.length) return [];
  const layerOf = (line) => scene.layers.find((layer) => layer.id === line.layerId);
  const playing = lines.filter((line) => { const layer = layerOf(line); return layer && layer.enabled !== false; });
  if (!playing.length || playing.some((line) => !mutedBetween(scene, layerOf(line), line.from, line.to))) return [];
  const count = (line) => String(line.text).split(/\s+/).filter(Boolean).length;
  const best = [...playing].sort((a, b) => (!!a.partial - !!b.partial) || (!!a.slowed - !!b.slowed) || (Math.min(12, count(b)) - Math.min(12, count(a))) || a.from - b.from)[0];
  const name = best.layer ?? best.layerId;
  // A line the layer plays only part of (partial) is kept by the seconds it plays, with its words as the subtitle.
  const what = best.partial ? { from: best.from, to: best.to, text: best.text } : String(best.text).endsWith("…") ? { from: best.from, to: best.to } : { line: best.text };
  const keep = JSON.stringify({ ops: [{ op: "keep_line", layer: name, ...what }] });
  const shown = playing.slice(0, 3).map((line) => `${line.layer ?? line.layerId} "${String(line.text).replaceAll('"', "'").slice(0, 60)}" ${sec(line.from)}-${sec(line.to)} s`).join(" · ");
  return [{
    rule: "speech_unplayed", severity: "warn", layerId: layerOf(best).id, at: sec(best.from),
    message: `the clips say ${playing.length} line${playing.length === 1 ? "" : "s"} and the edit plays none: every clip is muted where it speaks.`,
    measured: `${shown}${playing.length > 3 ? ` +${playing.length - 3} more` : ""}`,
    required: "at least one line the clips say is heard, or a waiver saying the edit is silent on purpose",
    fix: { kind: "hint", text: `${best.slowed ? `${name} plays ${best.how || "at another speed"}; set it to speed 1 first, then ` : ""}edit ${keep}: plays only that line at the clip's volume, subtitles it and dips the music under it. Silent on purpose: waive_check {code:"speech_unplayed", target:"${scene.name ?? scene.id}", reason:"<why no line is heard>"}.` },
  }];
}

/**
 * A reading text whose words match 60% or more of a line a video clip says (ctx.clipLines, from the
 * saved transcripts) while that clip plays muted under it. Nothing else says the line: the fix is
 * keep_line, which plays only that line (and the text already shows it, so it adds no subtitle).
 */
function mutedLines(model, ctx) {
  const scene = ctx.speechScene;
  const lines = (ctx.clipLines ?? []).filter((line) => line?.layerId && line.text && Number.isFinite(line.from) && Number.isFinite(line.to));
  if (!scene || !lines.length) return [];
  const strings = shownStrings(model);
  if (!strings.length) return [];
  const heard = voices(ctx).flatMap(heardWords);
  const findings = [];
  for (const line of lines) {
    const layer = scene.layers.find((other) => other.id === line.layerId);
    if (!layer || layer.type !== "video" || layer.enabled === false || !mutedBetween(scene, layer, line.from, line.to)) continue;
    const words = String(line.text).split(/\s+/).map(plainWord).filter(Boolean);
    if (words.length < 2) continue;
    // Another sound says it: a voice clip heard in the mix with the same words.
    const heardNow = new Set(heard.filter((word) => word.end >= line.from - 0.5 && word.start <= line.to + 0.5).map((word) => plainWord(word.text)));
    if (words.filter((word) => heardNow.has(word)).length / words.length >= LINE_HEARD) continue;
    // The texts shown with the line (a word a layer, kinetic type, counts as one text): each is mostly
    // the line's words, so a long title that holds two common words of a short line is not it.
    const shown = strings.filter((candidate) => {
      if (!candidate.stretches.some((stretch) => stretch.start < line.to + 0.75 && stretch.end > line.from - 0.75)) return false;
      return candidate.words.filter((word) => words.includes(word)).length / candidate.words.length >= LINE_SHOWN;
    });
    const pooled = new Set(shown.flatMap((candidate) => candidate.words));
    const matched = words.filter((word) => pooled.has(word)).length;
    if (matched < 2 || matched / words.length < LINE_SHOWN) continue;
    const entry = shown[0];
    const shownText = shown.map((candidate) => candidate.text).join(" ").replaceAll('"', "'");
    const name = line.layer ?? layer.id;
    const waive = `Muted on purpose: waive_check {code:"speech_captions", target:"${name}", reason:"<why it stays silent>"}.`;
    // keep_line needs speed 1, forwards, every frame: one edit puts the layer back (the finding then
    // returns with the keep_line call if the line still plays), as the lines note says for a slowed clip.
    const reset = line.slowed ? JSON.stringify({ ops: [
      { op: "update_layer", layer: name, properties: { mediaSpeed: 1, mediaReverse: null, mediaFrameRate: null } },
      ...(line.speedAnimations ?? []).map((animationId) => ({ op: "delete_animation", animationId })),
    ] }) : null;
    // A line clipLines cut short ("…") is kept by its scene seconds: its words are not all known.
    const what = String(line.text).endsWith("…") ? { from: line.from, to: line.to } : { line: line.text };
    const keep = JSON.stringify({ ops: [{ op: "keep_line", layer: name, ...what, subtitle: false }, { op: "isolate_voice", layer: name }] });
    findings.push({
      rule: "speech_captions", severity: "warn", layerId: layer.id, itemId: entry.item.id, at: sec(line.from),
      message: `"${shownText}" shows the line ${name} says, but ${name} is muted there: the viewer reads a voice they never hear.`,
      measured: `line "${String(line.text).replaceAll('"', "'")}" at ${sec(line.from)}-${sec(line.to)} s, ${name} muted${shown.length > 1 ? `, ${shown.length} texts show it` : ""}`,
      required: "a line shown as text is heard from its clip, or from another sound",
      fix: { kind: "hint", text: line.slowed
        ? `edit ${reset}: ${name} plays ${line.how || "at another speed"}, and keep_line needs speed 1, forwards, every frame. Then check again: this returns with the keep_line call if the line still plays. ${waive}`
        : `edit ${keep}: plays only that line (your text stays the subtitle) and drops the clip's own music under it. ${waive}` },
    });
  }
  return findings;
}

function captionGaps(model, ctx) {
  const voicesHere = voices(ctx);
  if (!voicesHere.length) return [];
  const captions = captionStretches(model);
  if (!captions.length) return [];
  const findings = [];
  for (const voice of voicesHere) {
    const { layer, range } = voice;
    const heard = heardWords(voice);
    // Only a voice the captions are for: some caption is shown while it speaks.
    if (!captions.some((caption) => caption.start < range.heardEnd && caption.end > range.heardStart)) continue;
    const near = (caption, word) => caption.start <= word.end + 0.75 && caption.end >= word.start - 0.75;
    // A word the captions spell another way (add_captions fix: "acne" shown as "Acme") is not
    // left out: each caption word the voice never says stands in for one missing word near it.
    const heardSet = new Set(heard.map((word) => plainWord(word.text)));
    const used = new Set();
    const corrected = (word) => captions.some((caption, index) => near(caption, word) && [...caption.words].some((text) => {
      const token = `${index}:${text}`;
      if (heardSet.has(text) || used.has(token)) return false;
      used.add(token);
      return true;
    }));
    const missing = heard.filter((word) => !captions.some((caption) => near(caption, word) && caption.words.has(plainWord(word.text)))).filter((word) => !corrected(word));
    if (!missing.length) continue;
    // Runs of missing words in a row, for the message.
    const runs = [];
    for (const word of missing) {
      const last = runs.at(-1);
      if (last && heard.indexOf(word) === heard.indexOf(last.at(-1)) + 1) last.push(word);
      else runs.push([word]);
    }
    const shown = runs.slice(0, 3).map((run) => `"${said(run)}" at ${sec(run[0].start)} s`).join(", ") + (runs.length > 3 ? ` and ${runs.length - 3} more` : "");
    findings.push({
      rule: "speech_captions", severity: "warn", layerId: layer.id, at: sec(missing[0].start),
      message: `The captions leave out ${missing.length} word${missing.length === 1 ? "" : "s"} "${layer.name}" says: ${shown}.`,
      measured: `${missing.length} of ${heard.length} heard words missing`,
      required: "every word the voice says is in the captions shown with it",
      fix: { kind: "hint", text: `Make the captions again from the voice (add_captions {speech:"${layer.name}"}, or caption-words with the words inspect speech:${layer.name} lists), or add the missing words.` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- speech_quotes

// A text counts as a caption of the speech when this share of its words is heard while it shows.
const SPOKEN_SHARE = 0.6;
// Unspoken text passes for a caption when its drawn size is within this factor of the caption's.
const CAPTION_SIZE = 1.6;
// Two fills closer than this on every channel (0 to 255) read as one color.
const SAME_COLOR = 48;

const QUOTED = /^["'“”‘’«»„「『]|["'“”‘’«»」』]$/;
const familyOf = (item) => String(item.font?.family ?? item.fontFamily ?? "Inter").split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
const styleOf = (item) => item.font?.style ?? "normal";
function sameColor(a, b) {
  const one = hexRgba(a);
  const two = hexRgba(b);
  if (!one || !two) return JSON.stringify(a) === JSON.stringify(b);
  return one.slice(0, 3).every((value, channel) => Math.abs(value - two[channel]) <= SAME_COLOR);
}

// Each string a reading text shows: its plain words and the scene stretches it is readable.
function shownStrings(model) {
  const list = [];
  for (const item of readingTexts(model)) {
    if (item.role === "logo") continue;
    for (const { text, textIndex } of stringsOf(item)) {
      const words = String(text ?? "").split(/\s+/).map(plainWord).filter(Boolean);
      const stretches = readableRuns(model, item, textIndex).map((run) => ({ start: model.times[run.from], end: model.times[run.to] }));
      if (words.length && stretches.length) list.push({ item, text: String(text).trim(), words, stretches });
    }
  }
  return list;
}

/**
 * speech_quotes: when captions of heard speech share the screen with caption-like text nobody
 * says, the spoken captions must look different: in quotes, or another font, style or color.
 */
export function speechQuotes(model, ctx) {
  const voicesHere = voices(ctx);
  if (!voicesHere.length) return [];
  const heard = voicesHere.flatMap(heardWords);
  const speaking = voicesHere.map(({ range }) => ({ start: range.heardStart, end: range.heardEnd }));
  const heardIn = (word, stretches) => stretches.some((stretch) => heard.some((spoken) => plainWord(spoken.text) === word && spoken.end >= stretch.start - 0.75 && spoken.start <= stretch.end + 0.75));
  const spoken = [];
  const unspoken = [];
  for (const entry of shownStrings(model)) {
    const matched = entry.words.filter((word) => heardIn(word, entry.stretches)).length;
    if (matched / entry.words.length >= SPOKEN_SHARE && (matched >= 2 || entry.item.role === "caption")) spoken.push(entry);
    // Unspoken text that could pass for a caption: 2 words or more, shown while a voice speaks.
    else if (entry.words.length >= 2 && entry.stretches.some((stretch) => speaking.some((span) => stretch.start < span.end && stretch.end > span.start))) unspoken.push(entry);
  }
  const findings = [];
  for (const entry of spoken) {
    if (QUOTED.test(entry.text)) continue;
    const size = drawnSize(model, entry.item);
    const alike = unspoken.find((other) => other.item !== entry.item && !QUOTED.test(other.text)
      && familyOf(other.item) === familyOf(entry.item) && styleOf(other.item) === styleOf(entry.item) && sameColor(other.item.fill, entry.item.fill)
      && drawnSize(model, other.item) <= size * CAPTION_SIZE && drawnSize(model, other.item) * CAPTION_SIZE >= size);
    if (!alike) continue;
    const choices = "Or set the speech apart another way: italic, another color or another font on the spoken captions (or on the unspoken line).";
    findings.push({
      rule: "speech_quotes", severity: "warn", itemId: entry.item.id, at: sec(entry.stretches[0].start),
      message: `${ctx.name(entry.item)} "${ctx.quote(entry.text)}" captions what the voice says, but it looks like ${ctx.name(alike.item)} "${ctx.quote(alike.text)}", which nobody says: viewers cannot tell the speech from the narration.`,
      measured: `same font (${familyOf(entry.item)}, ${styleOf(entry.item)}), same color, similar size, no quotes`,
      required: "spoken captions set apart from text nobody says: in quotes, or another font, style or color",
      fix: entry.item.texts
        ? { kind: "hint", text: `Put each spoken text of ${ctx.name(entry.item)} in quotes (“…”). ${choices}` }
        : { kind: "item", itemId: entry.item.id, properties: { text: `“${entry.text}”` }, auto: false, why: `puts the spoken words in quotes. ${choices}` },
    });
  }
  return findings;
}
