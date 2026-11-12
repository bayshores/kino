// Cleaning up a voiceover: the words a transcript heard in a voice layer, the slips among them,
// cutting words out, and captions from what is left.
//
// The transcript (backend/speech/transcribe.mjs) is of the whole file: words [{text, start, end,
// p, cut, unclear?}] in file seconds, where `cut` is the quiet point just before the word and
// `tail` the one after the last word. The agent service reads it and hands it to the operations
// here as `transcript`, the way detect_beats gets its analysis.
//
// A speech layer is an audio or video layer at speed 1. cut_speech splits it into pieces: the
// layer itself and copies named "<name>-2", "<name>-3", … (same file, same parent), each playing
// one stretch of the file (mediaOffset, mediaStart, mediaDuration), back to back. A word keeps
// its transcript index for good, so indices from one inspect still name the same words after a
// cut. Times here are seconds on the scene's clock unless they say file.
//
//   played words  speechWords(scene, layer, transcript) → [{index, text, start, end, cut, …}]
//   flags         speechFlags(words) → {repeat, filler, maybe, low, unclear, pause}
//   inspect       speechText(…) → the paged answer of inspect {targets:["speech:<layer>"]}
//   cut_speech    applyCutSpeech(document, operation) → receipt
//   add_captions  captionWordsFromSpeech(…) → words [{text, start, end}] for captionLayers.js
import { uid } from "./model.js";
import { volumeAt } from "./animation.js";
import { mediaPlaybackRange, hasMediaPlay } from "./playback.js";
import { isRemapped } from "./mediaTime.js";
import { MORPH_DEFAULT, MORPH_MAX, MORPH_MIN } from "./morphCut.js";
import { round } from "./numbers.js";
import { MUSIC_CUE_KINDS } from "./qualityFields.js";

export const FILLERS = new Set(["um", "uh", "er", "erm", "ah", "hmm", "mm", "uhm", "umm"]);
// Words that are often filler but often not ("I like it"): flagged as maybe.
const MAYBE_WORDS = new Set(["like"]);
export const LONG_PAUSE = 0.6; // seconds of silence between words that inspect marks
export const LOW_CONFIDENCE = 0.4; // whisper's word probability under which a word is flagged low (on kino's test voiceovers every misheard name was under 0.4, and 0.5 also flagged plain words like "and")
// The fades at each join, so a cut never clicks: short enough not to be heard as a fade.
export const JOIN_FADE = 0.012;
export const JOIN_NAMES = Object.freeze({ in: "Join in", out: "Join out" });
const SPEECH_TYPES = new Set(["audio", "video"]);
export const plainWord = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

function fail(type, message) {
  throw new Error(`${type}: ${message}`);
}

/** The layer name without a sound or video file extension: the base of its pieces' names. */
export function speechBaseName(name) {
  return String(name).replace(/\.(?:mp4|webm|mov|m4a|mp3|wav|ogg|aac|flac)$/i, "") || String(name);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pieces of the speech layer `layer` is part of, in the order they play: the first layer and
 * its "<name>-2", "<name>-3", … copies with the same file and parent.
 */
export function speechPieces(scene, layer) {
  const same = scene.layers.filter((item) => SPEECH_TYPES.has(item.type) && item.src === layer.src && item.parentId === layer.parentId);
  const piecesOf = (head) => {
    const pattern = new RegExp(`^${escapeRegExp(speechBaseName(head.name))}-\\d+$`);
    return same.filter((item) => item === head || pattern.test(item.name));
  };
  // The head is the layer with the most pieces ("vo.wav" over "vo-2", whose own name is longer or shorter).
  const head = same.map((item) => ({ item, pieces: piecesOf(item) })).filter((entry) => entry.pieces.includes(layer))
    .sort((a, b) => b.pieces.length - a.pieces.length || a.item.name.length - b.item.name.length)[0]?.item ?? layer;
  return piecesOf(head).sort((a, b) => (a.mediaStart ?? 0) - (b.mediaStart ?? 0) || (a === head ? -1 : b === head ? 1 : 0));
}

/** Refuses a layer that is not a speech layer; returns its pieces. */
export function checkSpeechLayer(scene, layer, type) {
  if (!layer) fail(type, "the layer was not found in this scene.");
  if (!SPEECH_TYPES.has(layer.type) || !layer.src) fail(type, `"${layer.name}" is a ${layer.type} layer; give the audio or video layer with the voice.`);
  const pieces = speechPieces(scene, layer);
  const remapped = pieces.find((piece) => isRemapped(piece));
  if (remapped) fail(type, `"${remapped.name}" plays at a speed, backwards or at its own frame rate; speech works on a voice at speed 1, so set mediaSpeed 1 (and no Speed animation or mediaReverse) first.`);
  return pieces;
}

/** The transcript the agent service put in the operation, or a refusal saying what is wrong. */
export function checkTranscript(transcript, type) {
  if (!transcript || !Array.isArray(transcript.words))
    fail(type, "the voice has not been transcribed; send it through the agent service (edit), which transcribes it first.");
  return transcript;
}

/**
 * The words the scene plays, earliest first: {index (in the transcript), text, start, end, cut
 * (scene seconds), p, unclear?, piece (the layer)}. A word plays when its start is inside a
 * piece's Play range; its end and cut are kept inside that piece.
 */
export function speechWords(scene, pieces, transcript) {
  const ranges = pieces.map((piece) => ({ piece, range: mediaPlaybackRange(piece, scene.duration) })).filter((entry) => entry.range);
  const words = [];
  for (const [index, word] of transcript.words.entries()) {
    for (const { piece, range } of ranges) {
      const fileEnd = range.offset + range.duration;
      if (word.start < range.offset - 1e-6 || word.start >= fileEnd - 1e-6) continue;
      const at = (time) => range.start + (Math.min(Math.max(time, range.offset), fileEnd) - range.offset);
      words.push({
        index, text: word.text, start: round(at(word.start)), end: round(at(Math.max(word.start, word.end))), cut: round(at(word.cut ?? word.start)),
        p: word.p ?? 1, ...(word.unclear ? { unclear: true } : {}), piece,
      });
    }
  }
  return words.sort((a, b) => a.start - b.start || a.index - b.index);
}

/** Every word of the file, in file seconds, whatever the scene plays (inspect speech:<layer>[file]). */
export function fileWords(transcript, piece = null) {
  return transcript.words.map((word, index) => ({
    index, text: word.text, start: round(word.start), end: round(Math.max(word.start, word.end)), cut: round(word.cut ?? word.start),
    p: word.p ?? 1, ...(word.unclear ? { unclear: true } : {}), piece,
  }));
}

/**
 * The slips in played words (each a list of transcript indices, except pause):
 *   repeat  a word or a run of 2 or 3 said twice in a row (fillers between them ignored): the first saying
 *   filler  um, uh, er, …
 *   maybe   "like" and "you know", which are filler only sometimes
 *   low     words whisper was unsure of (p under LOW_CONFIDENCE): check them, they may be misheard
 *   unclear sound with no word written (a mumble, a cough)
 *   pause   [{before: index, seconds}] silences of LONG_PAUSE or more
 */
export function speechFlags(words) {
  const flags = { repeat: [], filler: [], maybe: [], low: [], unclear: [], pause: [] };
  const spoken = [];
  for (const [position, word] of words.entries()) {
    const plain = plainWord(word.text);
    if (word.unclear) flags.unclear.push([word.index]);
    else if (FILLERS.has(plain)) flags.filler.push([word.index]);
    else {
      if (MAYBE_WORDS.has(plain)) flags.maybe.push([word.index]);
      if (plain === "you" && plainWord(words[position + 1]?.text ?? "") === "know") flags.maybe.push([word.index, words[position + 1].index]);
      if (!MAYBE_WORDS.has(plain) && word.p < LOW_CONFIDENCE) flags.low.push([word.index]);
      spoken.push({ plain, index: word.index });
    }
    const gap = position ? word.start - words[position - 1].end : 0;
    if (gap >= LONG_PAUSE) flags.pause.push({ before: word.index, seconds: round(gap) });
  }
  for (let at = 0; at < spoken.length;) {
    let found = 0;
    for (let size = 3; size >= 1 && !found; size -= 1) {
      if (at + 2 * size > spoken.length) continue;
      const first = spoken.slice(at, at + size).map((word) => word.plain).join(" ");
      const second = spoken.slice(at + size, at + 2 * size).map((word) => word.plain).join(" ");
      if (first && first === second) found = size;
    }
    if (found) {
      flags.repeat.push(spoken.slice(at, at + found).map((word) => word.index));
      at += found;
    } else at += 1;
  }
  return flags;
}

const span = (indices) => (indices.length === 1 ? `${indices[0]}` : `${indices[0]}-${indices.at(-1)}`);

/** One flags line part: `repeat 47-48 "we will", 60 "the"`; at most `max` entries. */
function flagList(name, entries, textOf, max = 25) {
  if (!entries.length) return null;
  const shown = entries.slice(0, max).map((entry) => (name === "pause"
    ? `${entry.before} (${entry.seconds}s)`
    : `${span(entry)} "${entry.map(textOf).join(" ")}"`));
  return `${name} ${shown.join(", ")}${entries.length > max ? ` +${entries.length - max} more` : ""}`;
}

/**
 * inspect {targets:["speech:<layer>"]}: the played words with their indices and scene times, the
 * slips, and how to cut them. `from` lists the words from that scene time on; one answer holds
 * about `budget` characters of words, and its last line names the target for the next ones.
 * A cut voice: `pieces` names its pieces, `voice` is the first (cut_speech's layer; it lists the
 * whole voice, another piece only its own words) and `cut` the indices cut out (restore puts them back).
 */
export function speechText({ layerName, words, transcript, from = null, budget = 10_000, how = "", voice = layerName, pieces = [], cut = [], pinned = null, file = false }) {
  const textOf = new Map(words.map((word) => [word.index, word.text]));
  const flags = speechFlags(words);
  const lines = [];
  const first = words[0];
  const last = words.at(-1);
  lines.push(`speech "${layerName}": ${words.length} word${words.length === 1 ? "" : "s"}${first ? `, ${first.start}–${last.end}s ${file ? "in the file" : "on the scene"}` : ""} (${transcript.model ?? "whisper"}${how ? `, ${how}` : ""})`);
  // Words the file has that this scene does not play (past its end, or before the layer's offset).
  const unplayed = file ? 0 : transcript.words.length - new Set(words.map((word) => word.index)).size;
  if (unplayed > 0 && pieces.length <= 1) lines.push(`${unplayed} more word${unplayed === 1 ? "" : "s"} in the file this scene does not play: inspect {targets:["speech:${layerName}[file]"]} lists them all in file seconds`);
  if (transcript.names?.length) lines.push(`heard with the project's names: ${transcript.names.join(", ")}`);
  // A cut voice keeps the transcript its cuts were made on while the brief names others.
  if (pinned) lines.push(`kept on the transcript its cuts were made on (the brief now names ${pinned.join(", ") || "nothing"}); to hear it with those: cut_speech {layer:"${voice}", restore:"all"}, then inspect and cut again`);
  // Unsure sentences whisper heard again alone (backend/speech/transcribe.mjs betterReadings).
  for (const span of (transcript.reheard ?? []).slice(0, 8)) {
    lines.push(`re-heard ${span.start}–${span.end}s of the file alone, kept the ${span.kept} reading (confidence ${span.p[0]} vs ${span.p[1]}): "${span.first}" | "${span.second}"`);
  }
  if (pieces.length > 1) {
    lines.push(layerName === voice
      ? `pieces (cut_speech): ${pieces.map((name) => `"${name}"`).join(", ")}; this lists the whole voice, speech:<piece> one piece`
      : `piece ${pieces.indexOf(layerName) + 1} of ${pieces.length} of "${voice}": only its words; speech:${voice} lists the whole voice`);
  }
  if (cut.length) {
    const runs = [];
    for (const index of cut) {
      if (runs.at(-1)?.at(-1) === index - 1) runs.at(-1).push(index);
      else runs.push([index]);
    }
    lines.push(`${flagList("cut", runs, (index) => transcript.words[index]?.text ?? "")}; put back: cut_speech {layer:"${voice}", restore:[indices]} or restore:"all" (words and pauses)`);
  } else if (pieces.length > 1) {
    lines.push(`cut: pauses only; put back: cut_speech {layer:"${voice}", restore:"all"}`);
  }
  if (!words.length) {
    lines.push(transcript.words.length ? "No transcribed word plays in this scene: the layer's Play range is outside them." : "No words were heard in the file.");
    return lines.join("\n");
  }
  const flagParts = ["repeat", "filler", "maybe", "unclear", "low", "pause"]
    .map((name) => flagList(name, flags[name], (index) => textOf.get(index) ?? ""))
    .filter(Boolean);
  lines.push(flagParts.length ? `flags (word index): ${flagParts.join(" · ")}` : "flags: none (no repeats, fillers, unclear sound or long pauses)");
  lines.push(`cut: edit cut_speech {layer:"${voice}", words:[indices]} (pauses:"natural", "tight" or "fast" shortens long pauses); captions: add_captions {speech:"${voice}", fix:{"heard":"meant"}}`);
  lines.push(`words (index:text start; ‖ marks a pause of ${LONG_PAUSE} s or more, with its seconds):`);
  const shown = from === null ? words : words.filter((word) => word.start >= from - 1e-6);
  const parts = [];
  let used = 0;
  let stop = shown.length;
  for (const [position, word] of shown.entries()) {
    const before = words[words.indexOf(word) - 1];
    const gap = before ? word.start - before.end : 0;
    const part = `${gap >= LONG_PAUSE ? `‖${round(gap)} ` : ""}${word.index}:${word.text} ${word.start}`;
    if (used + part.length > budget && parts.length) { stop = position; break; }
    parts.push(part);
    used += part.length + 1;
  }
  // Lines of about 100 characters.
  let line = "";
  for (const part of parts) {
    if (line && line.length + part.length + 1 > 100) { lines.push(line); line = ""; }
    line = line ? `${line} ${part}` : part;
  }
  if (line) lines.push(line);
  if (stop < shown.length) lines.push(`${shown.length - stop} more from ${shown[stop].start}s: inspect {targets:["speech:${layerName}[${file ? "file," : ""}from=${shown[stop].start}]"]}`);
  return lines.join("\n");
}

// ---- cut_speech ------------------------------------------------------------------------------

/** Sorted, merged intervals [{start, end}]. */
function merged(list) {
  const sorted = list.filter((item) => item.end - item.start > 1e-6).sort((a, b) => a.start - b.start);
  const out = [];
  for (const item of sorted) {
    const lastItem = out.at(-1);
    if (lastItem && item.start <= lastItem.end + 1e-6) lastItem.end = Math.max(lastItem.end, item.end);
    else out.push({ ...item });
  }
  return out;
}

/** `[start, end]` without the `cuts` intervals: the parts that stay. */
function without(start, end, cuts) {
  const kept = [];
  let from = start;
  for (const cut of cuts) {
    if (cut.end <= from || cut.start >= end) continue;
    if (cut.start > from) kept.push({ start: from, end: cut.start });
    from = Math.max(from, cut.end);
  }
  if (end > from) kept.push({ start: from, end });
  return kept;
}

/** Seconds of `cuts` before scene time `time`: map(t) = t - removedBefore(t). */
function removedBefore(cuts, time) {
  let total = 0;
  for (const cut of cuts) {
    if (cut.start >= time) break;
    total += Math.min(cut.end, time) - cut.start;
  }
  return total;
}

/**
 * The pause cap: in each gap between two words left, the silence beyond `cap` seconds is cut from
 * its middle (taking what other cuts leave of the gap into account). A named pace sets `over`:
 * only pauses longer than it are shortened, to `cap`. Returns new cut intervals.
 */
function pauseCuts(words, cuts, cap, over = cap) {
  const removed = new Set(words.filter((word) => cuts.some((cut) => word.start >= cut.start - 1e-6 && word.start < cut.end - 1e-6)).map((word) => word));
  const left = words.filter((word) => !removed.has(word));
  const extra = [];
  for (let position = 1; position < left.length; position += 1) {
    const kept = without(left[position - 1].end, left[position].start, cuts);
    const length = kept.reduce((sum, part) => sum + part.end - part.start, 0);
    let excess = length - cap;
    if (excess < 0.01 || length < over + 0.01) continue;
    // Skip the first cap/2 seconds of what is kept, then cut `excess` seconds.
    let skip = cap / 2;
    for (const part of kept) {
      if (excess <= 0) break;
      let start = part.start;
      if (skip > 0) {
        const used = Math.min(skip, part.end - part.start);
        skip -= used;
        start += used;
      }
      const take = Math.min(excess, part.end - start);
      if (take > 0) {
        extra.push({ start, end: start + take });
        excess -= take;
      }
    }
  }
  return extra;
}

// A short animation (an entrance, a Show) moves and keeps its length; a long one is cut like the
// time under it. A composed animation moves as a whole (blocks.mjs retime does the same).
function rippleAnimations(list, map) {
  return (list ?? []).map((animation) => {
    if (!animation || typeof animation.start !== "number") return animation;
    const length = animation.kind === "composed"
      ? Math.max(0, ...(animation.animations ?? []).map((member) => (member.start ?? 0) + (member.duration ?? 0)))
      : animation.duration ?? 0;
    const end = animation.start + length;
    if (animation.kind === "composed" || length <= 1) {
      const start = animation.kind === "out" ? map(end) - length : map(animation.start);
      return start === animation.start ? animation : { ...animation, start: round(Math.max(0, start)) };
    }
    const start = map(animation.start);
    const duration = round(Math.max(0.05, map(end) - start));
    return start === animation.start && duration === animation.duration ? animation : { ...animation, start: round(start), duration };
  });
}

/**
 * Silence removal by named pace:
 * a pause longer than `over` seconds shrinks to `keep`, half of it left beside each word as
 * padding. Shorter pauses stay as spoken, so the voice keeps its rhythm.
 */
export const PAUSE_PACES = Object.freeze({
  natural: { over: 0.6, keep: 0.4 },
  tight: { over: 0.35, keep: 0.25 },
  fast: { over: 0.2, keep: 0.12 },
});

const isJoin = (animation) => animation?.name === JOIN_NAMES.in || animation?.name === JOIN_NAMES.out;
const FREEZE_KEEPS = { first: ["first", "both"], last: ["last", "both"] };

/**
 * The new pieces of a voice from `stretches` [{piece, start, duration, offset}] (scene start,
 * file offset), earliest first: the first keeps the voice's ID and name, the others are
 * "<name>-2", "<name>-3" … and reuse the old pieces' IDs in order. Each copies the animations of
 * the old piece it plays (moved by `map` when given), plus those only the pieces in `stretch.also`
 * had (restore joining pieces), and gets fresh join fades.
 */
function makePieces(pieces, stretches, map, morph = 0) {
  const head = pieces[0];
  const base = speechBaseName(head.name);
  const freeze = head.mediaFreeze;
  const used = new Set();
  const made = stretches.map((stretch, number) => {
    const reuse = pieces[number];
    const sameLayer = reuse === stretch.piece && !used.has(stretch.piece);
    if (sameLayer) used.add(stretch.piece);
    const copy = structuredClone(stretch.piece);
    copy.id = reuse ? reuse.id : uid();
    copy.name = number === 0 ? head.name : `${base}-${number + 1}`;
    copy.mediaStart = round(stretch.start);
    copy.mediaOffset = round(stretch.offset);
    copy.mediaDuration = round(stretch.duration);
    delete copy.playbackWindows;
    if (freeze !== undefined || copy.type === "video") {
      const mode = freeze ?? (copy.type === "video" ? "both" : "none");
      const first = number === 0 && FREEZE_KEEPS.first.includes(mode);
      const lastOne = number === stretches.length - 1 && FREEZE_KEEPS.last.includes(mode);
      copy.mediaFreeze = first && lastOne ? "both" : first ? "first" : lastOne ? "last" : "none";
    }
    let animations = (copy.animations ?? []).filter((animation) => !isJoin(animation));
    // A cut gives every piece the same animations; keep each one once, and a piece's own (a Duck).
    const key = ({ id, ...rest }) => JSON.stringify(rest);
    const seen = new Set(animations.map(key));
    for (const other of stretch.also ?? []) {
      for (const animation of other.animations ?? []) {
        if (isJoin(animation) || seen.has(key(animation))) continue;
        seen.add(key(animation));
        animations.push(animation);
      }
    }
    animations = map ? rippleAnimations(animations, map) : animations;
    if (!sameLayer) animations = animations.map((animation) => ({ ...structuredClone(animation), id: uid() }));
    copy.animations = animations;
    // A video piece after the first morphs in from the one before it (morphCut.js); 0 keeps the cut.
    delete copy.morphIn;
    if (copy.type === "video" && number > 0) copy.morphIn = morph;
    return copy;
  });
  // The fades at each join (in after the first piece starts, out before the last ends).
  for (const [number, piece] of made.entries()) {
    const end = piece.mediaStart + piece.mediaDuration;
    const fade = Math.min(JOIN_FADE, piece.mediaDuration / 3);
    const joins = [];
    if (number > 0) joins.push({ id: uid(), name: JOIN_NAMES.in, kind: "custom", easing: "linear", start: round(piece.mediaStart), duration: round(fade), from: { volume: 0 }, to: { volume: round(volumeAt(piece, piece.mediaStart + fade)) } });
    if (number < made.length - 1) joins.push({ id: uid(), name: JOIN_NAMES.out, kind: "custom", easing: "linear", start: round(end - fade), duration: round(fade), from: { volume: round(volumeAt(piece, end - fade)) }, to: { volume: 0 } });
    piece.animations = [...piece.animations, ...joins];
  }
  return made;
}

/**
 * Ripple: everything in the scene but the voice's pieces moves by `map` (old scene time → new):
 * other layers' animations and Play, the background, assertions, cues, rhythm and the scene's
 * length. Returns what moved, for the receipt.
 */
function rippleScene(document, scene, pieces, map) {
  const movedLayers = new Set();
  for (const item of scene.layers) {
    if (pieces.includes(item)) continue;
    const before = JSON.stringify([item.animations, item.mediaStart, item.componentStart, item.playbackWindows]);
    item.animations = rippleAnimations(item.animations, map);
    if (item.type === "component" && typeof item.componentStart === "number") item.componentStart = map(item.componentStart);
    if (hasMediaPlay(item) && typeof item.mediaStart === "number") item.mediaStart = map(item.mediaStart);
    if (Array.isArray(item.playbackWindows)) item.playbackWindows = item.playbackWindows.map((window) => ({ ...window, start: map(window.start), end: map(window.end) }));
    if (before !== JSON.stringify([item.animations, item.mediaStart, item.componentStart, item.playbackWindows])) movedLayers.add(item.name);
  }
  const background = JSON.stringify(scene.backgroundAnimations ?? []);
  scene.backgroundAnimations = rippleAnimations(scene.backgroundAnimations, map);
  const backgroundMoved = background !== JSON.stringify(scene.backgroundAnimations ?? []);
  if (scene.assertions) scene.assertions = scene.assertions.map((assertion) => (typeof assertion.time === "number" ? { ...assertion, time: map(assertion.time) } : assertion));
  let cuesMoved = 0;
  if (document.cues?.length) {
    document.cues = document.cues.map((cue) => {
      const time = map(cue.time);
      if (time !== cue.time) cuesMoved += 1;
      return time === cue.time ? cue : { ...cue, time };
    }).sort((a, b) => a.time - b.time);
    if (document.rhythm) document.rhythm = { ...document.rhythm, offset: map(document.rhythm.offset) };
  }
  if (scene.rests) scene.rests = scene.rests.map((rest) => ({ ...rest, at: map(rest.at), until: map(rest.until) })).filter((rest) => rest.until > rest.at);
  const length = scene.duration;
  scene.duration = Math.max(0.1, map(scene.duration));
  if (scene.template) scene.template = { ...scene.template, length: scene.duration };
  if (scene.composition) scene.composition = { ...scene.composition, duration: scene.duration };
  const others = `${movedLayers.size} other layer${movedLayers.size === 1 ? "" : "s"}, ${backgroundMoved ? "the background, " : ""}${cuesMoved} cue${cuesMoved === 1 ? "" : "s"}`;
  return { scene: `${length}s → ${scene.duration}s`, others };
}

/**
 * shift {at, by, scene?}: a ripple insert. Everything that starts at or after `at` (layer Play
 * times, animations, cues, the rhythm, rests, assertions) moves `by` seconds and the scene grows
 * or shrinks by `by`; an animation running across `at` stretches over the new time. Beat cues stay
 * with a sound that does not move. A negative `by` takes out the seconds before `at`, refused when
 * something starts or ends inside them. Changes `document`; returns the receipt.
 */
export function shiftScene(document, scene, at, by) {
  if (!(at >= 0 && at <= scene.duration)) throw new Error(`shift at ${at} s is outside the scene (0 to ${scene.duration} s).`);
  if (!Number.isFinite(by) || by === 0) throw new Error("shift needs by: seconds to insert (positive) or take out (negative), not 0.");
  const gapStart = round(at + by);
  if (gapStart < 0) throw new Error(`shift by ${by} s at ${at} s would take out time before the scene starts; the most is ${-at} s.`);
  if (by < 0) {
    const inside = (time) => typeof time === "number" && time > gapStart + 1e-6 && time < at - 1e-6;
    const blockers = [];
    for (const item of scene.layers) {
      const times = [];
      for (const animation of item.animations ?? []) if (typeof animation?.start === "number") times.push(animation.start, animation.start + (animation.duration ?? 0));
      if (hasMediaPlay(item) && typeof item.mediaStart === "number") {
        times.push(item.mediaStart);
        const range = mediaPlaybackRange(item, scene.duration);
        if (range && Number.isFinite(range.end) && range.end < scene.duration - 1e-6) times.push(range.end);
      }
      if (times.some(inside)) blockers.push(`"${item.name}"`);
    }
    const cues = (document.cues ?? []).filter((cue) => inside(cue.time)).map((cue) => `cue "${cue.name ?? cue.kind}"`);
    const all = [...blockers, ...cues];
    if (all.length) throw new Error(`shift by ${by} s would take out ${gapStart} to ${at} s, but ${all.slice(0, 5).join(", ")}${all.length > 5 ? ` and ${all.length - 5} more` : ""} start${all.length === 1 ? "s" : ""} or end${all.length === 1 ? "s" : ""} there, so they would overlap. Move or trim ${all.length === 1 ? "it" : "them"} first, or take out less.`);
  }
  const map = (time) => round(time >= at - 1e-6 ? time + by : time);
  // Beat cues belong to their sound: when a sound that stays put plays over all of them, they stay.
  const beats = (document.cues ?? []).filter((cue) => MUSIC_CUE_KINDS.includes(cue.kind));
  const staying = beats.length > 0 && scene.layers.some((item) => (item.type === "audio" || item.type === "video") && item.src && (item.mediaStart ?? 0) < at - 1e-6
    && beats.every((cue) => { const range = mediaPlaybackRange(item, scene.duration); return range && cue.time >= range.start - 1e-6 && cue.time <= range.end + 1e-6; }));
  const rhythm = document.rhythm;
  if (staying) document.cues = document.cues.filter((cue) => !beats.includes(cue));
  const across = scene.layers.filter((item) => hasMediaPlay(item) && (item.mediaStart ?? 0) < at - 1e-6 && (mediaPlaybackRange(item, scene.duration)?.end ?? 0) > at + 1e-6).map((item) => `"${item.name}"`);
  const moved = rippleScene(document, scene, [], map);
  if (staying) {
    document.cues = [...document.cues, ...beats].sort((a, b) => a.time - b.time);
    if (rhythm) document.rhythm = rhythm;
  }
  return {
    shift: `${by > 0 ? "+" : ""}${by} s from ${at} s${by < 0 ? ` (took out ${gapStart} to ${at} s)` : ""}`, scene: moved.scene, moved: moved.others,
    ...(staying ? { beats: "beat cues stayed with their sound" } : {}),
    ...(across.length ? { playing: `${across.slice(0, 4).join(", ")} play${across.length === 1 ? "s" : ""} across ${at} s and keep${across.length === 1 ? "s" : ""} playing through the shift` } : {}),
  };
}

/** The old pieces go; the new ones take the first one's place. */
function replacePieces(scene, pieces, made) {
  const at = scene.layers.indexOf(pieces[0]);
  scene.layers = scene.layers.filter((item) => !pieces.includes(item));
  scene.layers.splice(Math.min(at, scene.layers.length), 0, ...made);
}

const captionNote = (document, scene, name) => ((scene.layers.some((item) => item.role === "caption") || (document.cues ?? []).some((cue) => cue.kind === "word" || cue.kind === "line"))
  ? { captions: `captions made before this change no longer match the voice: run add_captions {speech:"${name}"} again` }
  : {});
const RIPPLE_FALSE = "ripple:false: only the voice moved; other layers, cues and the scene length kept their times";

/** Applies cut_speech {sceneId, layerId, words?, spans?, pauses?, restore?, ripple?, transcript}. Returns the receipt. */
export function applyCutSpeech(document, operation) {
  const type = "cut_speech";
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  const pieces = checkSpeechLayer(scene, layer, type);
  const transcript = checkTranscript(operation.transcript, type);
  if (operation.ripple !== undefined && typeof operation.ripple !== "boolean") fail(type, "ripple must be true or false.");
  const morph = morphOf(operation.morph, pieces, type);
  if (operation.restore !== undefined) {
    if (operation.words !== undefined || operation.spans !== undefined || operation.pauses !== undefined) fail(type, "restore puts cut words back; send it in its own cut_speech, without words, spans or pauses.");
    return restoreSpeech(document, scene, pieces, transcript, operation.restore, operation.ripple ?? pieces[0].cutRipple !== false, morph);
  }
  if (operation.words === undefined && operation.spans === undefined && operation.pauses === undefined)
    fail(type, "give words (transcript indices from inspect speech:<layer>), spans [{from, to}] in scene seconds, pauses (a pace: natural, tight or fast; or the longest pause to keep, in seconds), or restore (indices to put back, or \"all\").");
  const ripple = operation.ripple !== false;
  const words = speechWords(scene, pieces, transcript);
  const head = pieces[0];
  const cuts = [];
  if (operation.words !== undefined) {
    if (!Array.isArray(operation.words) || !operation.words.length || operation.words.length > 5000) fail(type, "words must be a list of transcript indices (whole numbers from inspect speech:<layer>).");
    const byIndex = new Map();
    for (const word of words) byIndex.set(word.index, [...(byIndex.get(word.index) ?? []), word]);
    const missing = operation.words.filter((index) => !byIndex.has(index));
    if (missing.length) {
      const bad = missing.filter((index) => !Number.isInteger(index));
      if (bad.length) fail(type, `words are transcript indices (whole numbers), not ${JSON.stringify(bad[0])}.`);
      fail(type, `word${missing.length > 1 ? "s" : ""} ${missing.slice(0, 8).join(", ")} ${missing.length > 1 ? "do" : "does"} not play in "${head.name}" (already cut, or outside the transcript's 0–${transcript.words.length - 1}); inspect speech:${head.name} lists the words that play.`);
    }
    for (const index of new Set(operation.words)) {
      for (const word of byIndex.get(index)) {
        const range = mediaPlaybackRange(word.piece, scene.duration);
        // To the quiet point before the next word in the file (or after the last word), inside this piece.
        const nextFile = transcript.words[index + 1]?.cut ?? transcript.tail ?? transcript.words[index].end;
        const end = Math.min(range.end, range.start + (nextFile - range.offset));
        cuts.push({ start: word.cut, end: Math.max(end, word.end) });
      }
    }
  }
  if (operation.spans !== undefined) {
    if (!Array.isArray(operation.spans) || !operation.spans.length || operation.spans.length > 1000) fail(type, "spans must be a list of {from, to} in scene seconds.");
    for (const item of operation.spans) {
      if (!item || typeof item.from !== "number" || typeof item.to !== "number" || !(item.to > item.from) || item.from < 0)
        fail(type, `each span is {from, to} in scene seconds with to after from, not ${JSON.stringify(item)}.`);
      cuts.push({ start: Math.max(0, item.from), end: Math.min(scene.duration, item.to) });
    }
  }
  let shortened = 0;
  if (operation.pauses !== undefined) {
    const pace = typeof operation.pauses === "string" ? PAUSE_PACES[operation.pauses] : null;
    if (typeof operation.pauses === "string" && !pace) fail(type, `pauses is a pace (${Object.keys(PAUSE_PACES).join(", ")}) or the longest pause to keep in seconds, not "${operation.pauses}".`);
    if (!pace && (typeof operation.pauses !== "number" || !(operation.pauses >= 0.05) || operation.pauses > 10)) fail(type, `pauses is a pace (${Object.keys(PAUSE_PACES).join(", ")}) or the longest pause to keep between words, in seconds (0.05 to 10), for example 0.4.`);
    const extra = pace ? pauseCuts(words, merged(cuts), pace.keep, pace.over) : pauseCuts(words, merged(cuts), operation.pauses);
    shortened = new Set(extra.map((cut) => words.findIndex((word) => word.start >= cut.end - 1e-6))).size;
    cuts.push(...extra);
  }
  const removed = merged(cuts.map((cut) => ({ start: Math.max(0, cut.start), end: Math.min(scene.duration, cut.end) })));
  const total = removed.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  if (total < 0.001) fail(type, "nothing to cut: the words or spans given are not played, and no pause is longer than pauses.");
  const map = (time) => round(time - removedBefore(removed, time));
  const cutWords = words.filter((word) => removed.some((cut) => word.start >= cut.start - 1e-6 && word.start < cut.end - 1e-6)).length;

  // The new pieces: what each old piece plays, without the cuts, back to back.
  const stretches = [];
  for (const piece of pieces) {
    const range = mediaPlaybackRange(piece, scene.duration);
    if (!range) continue;
    for (const part of without(range.start, range.end, removed)) {
      if (part.end - part.start < 0.005) continue;
      // The voice always closes up; ripple decides whether everything else moves with it.
      stretches.push({ piece, start: map(part.start), duration: part.end - part.start, offset: range.offset + (part.start - range.start) });
    }
  }
  stretches.sort((a, b) => a.start - b.start);
  if (!stretches.length) fail(type, `that would cut all of "${head.name}"; delete the layer instead.`);
  const made = makePieces(pieces, stretches, ripple ? map : null, morph);
  rememberRipple(made, ripple);
  rememberCut(made, pieces, words.filter((word) => removed.some((cut) => word.start >= cut.start - 1e-6 && word.start < cut.end - 1e-6)).map((word) => word.index), [], transcript);
  // Everything else after a cut moves earlier by the seconds cut before it.
  const rippled = ripple ? rippleScene(document, scene, pieces, map) : null;
  replacePieces(scene, pieces, made);
  const shifts = removed.slice(0, 8).map((cut) => `after ${map(cut.start)}s −${round(removedBefore(removed, cut.end))}s`);
  return {
    layer: head.name,
    removed: round(total),
    ...(cutWords ? { words: cutWords } : {}),
    ...(shortened ? { pauses: shortened } : {}),
    pieces: made.length,
    ...(rippled
      ? { scene: rippled.scene, moved: `${shifts.join(", ")}${removed.length > 8 ? ` (+${removed.length - 8} more cuts)` : ""}: ${rippled.others} moved earlier` }
      : { note: RIPPLE_FALSE }),
    ...morphNote(made),
    ...captionNote(document, scene, head.name),
  };
}

/**
 * The seconds of the morph cut at each join of a video voice (cut_speech `morph`): a number from
 * MORPH_MIN to MORPH_MAX, false for plain cuts, or by default what its pieces had (MORPH_DEFAULT
 * the first time). Audio voices have no picture: 0.
 */
function morphOf(value, pieces, type) {
  if (pieces[0].type !== "video") {
    if (value !== undefined && value !== false) fail(type, `morph needs a video voice; "${pieces[0].name}" is ${pieces[0].type}.`);
    return 0;
  }
  if (value === false) return 0;
  if (value === undefined) return pieces.slice(1).find((piece) => typeof piece.morphIn === "number")?.morphIn ?? MORPH_DEFAULT;
  if (typeof value !== "number" || !(value >= MORPH_MIN && value <= MORPH_MAX)) fail(type, `morph is the morph cut's length in seconds (${MORPH_MIN} to ${MORPH_MAX}, for example ${MORPH_DEFAULT}) or false for plain cuts.`);
  return round(value);
}

/** The receipt's line about the morph cuts at a video voice's joins. */
function morphNote(made) {
  const joins = made.filter((piece) => piece.morphIn > 0);
  if (!joins.length) return {};
  return { morph: `${joins[0].morphIn}s morph cut at ${joins.length} join${joins.length === 1 ? "" : "s"} (render only: a join between two different shots stays a cut; the live preview shows plain cuts); morph:false for plain cuts` };
}

/**
 * The voice's first piece keeps `cutRipple: false` while its last cut was made with ripple:false,
 * so restore moves the same things back (only the voice) unless it is given ripple itself.
 */
function rememberRipple(made, ripple) {
  for (const piece of made) delete piece.cutRipple;
  if (!ripple && made.length > 1) made[0].cutRipple = false;
}

/**
 * The voice's first piece keeps `cutWords`: the transcript indices cut_speech cut out, also those
 * at its ends (cut from the start or the end of the voice leaves no gap between pieces to find
 * them by). speech_cut does not count them as words the voice goes on saying. Those indices are
 * positions in one transcript, so it also keeps `heardWith`: the names whisper was told for that
 * transcript (none: the one made without names). The service reads that transcript for this
 * voice until every cut is restored (backend/speech/name-hint.mjs speechNamesFor).
 */
function rememberCut(made, pieces, added, restored, transcript) {
  const back = new Set(restored);
  const cut = [...new Set([...pieces.flatMap((piece) => piece.cutWords ?? []), ...added])].filter((index) => !back.has(index)).sort((a, b) => a - b);
  for (const piece of made) { delete piece.cutWords; delete piece.heardWith; }
  if (!cut.length) return;
  made[0].cutWords = cut;
  if (transcript.names?.length) made[0].heardWith = [...transcript.names];
}

/** The transcript indices cut_speech cut out of a voice that no piece plays now. */
export function cutWordsOf(pieces, transcript) {
  const stretches = pieceStretches(pieces, transcript);
  const plays = (time) => stretches.some((stretch) => time >= stretch.offset - 1e-6 && time < stretch.fileEnd - 1e-6);
  const cut = new Set([...pieces.flatMap((piece) => piece.cutWords ?? []), ...cutSpeechIndices(pieces, transcript)]);
  return new Set([...cut].filter((index) => transcript.words[index] && !plays(transcript.words[index].start)));
}

/** What each piece plays, earliest first: {piece, start (scene), offset, fileEnd (file seconds)}. */
function pieceStretches(pieces, transcript) {
  return pieces.map((piece) => {
    const range = mediaPlaybackRange(piece, Infinity);
    if (!range) return null;
    const fileEnd = Number.isFinite(range.duration) ? range.offset + range.duration : Math.max(range.offset, transcript.duration ?? transcript.tail ?? 0);
    return { piece, start: range.start, offset: range.offset, fileEnd };
  }).filter(Boolean).sort((a, b) => a.start - b.start);
}

/**
 * The transcript indices cut out of a voice: words between the first and last file second its
 * pieces play that no piece plays (what restore:"all" puts back).
 */
export function cutSpeechIndices(pieces, transcript) {
  const stretches = pieceStretches(pieces, transcript);
  if (stretches.length < 2) return [];
  const from = Math.min(...stretches.map((stretch) => stretch.offset));
  const to = Math.max(...stretches.map((stretch) => stretch.fileEnd));
  const plays = (time) => stretches.some((stretch) => time >= stretch.offset - 1e-6 && time < stretch.fileEnd - 1e-6);
  return transcript.words.flatMap((word, index) => (word.start >= from - 1e-6 && word.start < to - 1e-6 && !plays(word.start) ? [index] : []));
}

/**
 * cut_speech {restore}: puts cut words back. restore is a list of transcript indices or "all"
 * (every gap between the pieces). An index before the first or after the last word played (cut
 * there, or trimmed off by Play) extends the voice to it. Each word comes back from the quiet point before it to the one
 * before the next word, at the join where it was cut; pieces that now play on from each other
 * become one again, and their join fades go. ripple moves everything after later by the time put
 * back (ripple false moves only the voice).
 */
function restoreSpeech(document, scene, pieces, transcript, restore, ripple, morph = 0) {
  const type = "cut_speech";
  const head = pieces[0];
  const stretches = pieceStretches(pieces, transcript);
  if (!stretches.length) fail(type, `"${head.name}" plays nothing in this scene.`);
  const played = merged(stretches.map((stretch) => ({ start: stretch.offset, end: stretch.fileEnd })));
  const wanted = [];
  let restoredWords = [];
  if (restore === "all") {
    restoredWords = cutSpeechIndices(pieces, transcript);
    for (let i = 1; i < played.length; i += 1) wanted.push({ start: played[i - 1].end, end: played[i].start });
    if (!wanted.length) fail(type, `nothing to restore: "${head.name}" is one piece with no cut in it.`);
  } else {
    if (!Array.isArray(restore) || !restore.length || restore.length > 5000) fail(type, 'restore is a list of transcript indices to put back (cut words; inspect speech:<layer> lists them) or "all".');
    const bad = restore.find((index) => !Number.isInteger(index) || index < 0 || index >= transcript.words.length);
    if (bad !== undefined) fail(type, `restore takes transcript indices (whole numbers 0–${transcript.words.length - 1}), not ${JSON.stringify(bad)}.`);
    const playing = restore.filter((index) => played.some((part) => transcript.words[index].start >= part.start - 1e-6 && transcript.words[index].start < part.end - 1e-6));
    if (playing.length) fail(type, `word${playing.length > 1 ? "s" : ""} ${playing.slice(0, 8).join(", ")} already play${playing.length > 1 ? "" : "s"} in "${head.name}"; restore only words that do not play (inspect speech:${head.name} lists the cut ones).`);
    restoredWords = [...new Set(restore)].sort((a, b) => a - b);
    for (const index of restoredWords) {
      const word = transcript.words[index];
      const next = transcript.words[index + 1]?.cut ?? transcript.tail ?? word.end;
      wanted.push({ start: word.cut ?? word.start, end: Math.max(next, word.end) });
    }
  }
  // Only the file seconds no piece plays yet.
  const parts = merged(wanted).flatMap((item) => without(item.start, item.end, played)).filter((part) => part.end - part.start >= 0.005);
  if (!parts.length) fail(type, "nothing to restore: those words already play.");
  // Each part goes in where the file reaches it: after the piece that plays the file just before it.
  const additions = parts.map((part) => {
    const before = stretches.filter((stretch) => stretch.fileEnd <= part.start + 1e-6).sort((a, b) => b.fileEnd - a.fileEnd)[0];
    const point = before ? before.start + (before.fileEnd - before.offset) : stretches[0].start;
    return { piece: before?.piece ?? head, point: round(point), offset: part.start, duration: part.end - part.start };
  });
  const map = (time) => round(time + additions.filter((item) => item.point <= time + 1e-6).reduce((sum, item) => sum + item.duration, 0));
  const all = [
    ...stretches.map((stretch) => ({ piece: stretch.piece, start: map(stretch.start), offset: stretch.offset, duration: stretch.fileEnd - stretch.offset })),
    ...additions.map((item) => ({
      piece: item.piece, offset: item.offset, duration: item.duration,
      start: item.point + additions.filter((other) => other.point < item.point - 1e-6 || (Math.abs(other.point - item.point) <= 1e-6 && other.offset < item.offset)).reduce((sum, other) => sum + other.duration, 0),
    })),
  ].sort((a, b) => a.start - b.start || a.offset - b.offset);
  // Stretches that play on from each other (in the file and on the scene) are one piece.
  const joined = [];
  for (const stretch of all) {
    const last = joined.at(-1);
    if (last && Math.abs(last.offset + last.duration - stretch.offset) < 2e-3 && Math.abs(last.start + last.duration - stretch.start) < 2e-3) {
      last.duration = stretch.offset + stretch.duration - last.offset;
      if (stretch.piece !== last.piece) last.also = [...(last.also ?? []), stretch.piece];
    }
    else joined.push({ ...stretch });
  }
  const made = makePieces(pieces, joined, ripple ? map : null, morph);
  rememberRipple(made, pieces[0].cutRipple !== false);
  rememberCut(made, pieces, [], restoredWords, transcript);
  const rippled = ripple ? rippleScene(document, scene, pieces, map) : null;
  replacePieces(scene, pieces, made);
  const total = additions.reduce((sum, item) => sum + item.duration, 0);
  const shifts = additions.slice(0, 8).map((item) => `after ${item.point}s +${round(item.duration)}s`);
  return {
    layer: head.name,
    restored: round(total),
    words: restoredWords.length,
    pieces: made.length,
    ...(rippled
      ? { scene: rippled.scene, moved: `${shifts.join(", ")}${additions.length > 8 ? ` (+${additions.length - 8} more)` : ""}: ${rippled.others} moved later` }
      : { note: RIPPLE_FALSE }),
    ...morphNote(made),
    ...captionNote(document, scene, head.name),
  };
}

// ---- captions --------------------------------------------------------------------------------

/**
 * The words for add_captions {speech}: what the scene plays, without unclear sound and fillers
 * (um, uh), with `fix` applied: {"heard": "meant"} replaces a word or a run of words (matched
 * without case or punctuation; the last word's punctuation stays), and "" leaves them out.
 * Returns {words: [{text, start, end}], fixed, left}.
 */
// A word with brackets, parentheses or a note sign is a sound tag whisper wrote ("[BLANK_AUDIO]",
// "(upbeat music)", "♪"), not something said.
export const SOUND_TAG = /[[\]()♪]/;

// ---- lines a clip says -----------------------------------------------------------------------

export const LINE_SURE = 0.5; // a line's mean word probability must reach this (a guess over loud music is under it)
const LINE_TEXT_MOST = 60;
/**
 * What the readout calls whisper's English for a line heard in another language. It is a machine
 * translation that can reverse the meaning (measured: "sin internet" came out as "on the Internet"),
 * so it is named as one wherever it is shown, and it is never used as subtitle text: keep_line and
 * add_captions show the words as said, or the `text` the agent sends.
 */
export const GLOSS_LABEL = "gloss (machine, unverified)";
// A tag glued to a word ("see.(laughs)") goes; a whole tag word ("(Door", "creaks)", "Sigh*") is not a word said.
const GLUED_TAG = /\([^)]*\)|\[[^\]]*\]/g;
const isTagWord = (text) => SOUND_TAG.test(text) || /^\*|\*$/.test(text);
/** A word without a sound tag glued to it: "see.(laughs)" is "see." (clipLines and keep_line read it so). */
export const withoutGluedTag = (text) => String(text).replace(GLUED_TAG, "").trim();
const endsLine = (text) => /[.?!…]["')]*$/.test(text);

/**
 * The lines a clip's own sound says, for the import answer and look source: [{text, start, end}]
 * in file seconds, shortest first (then earliest), at most `most`. Sound tags, unclear sound,
 * fillers and unsure guesses are left out: a line needs 2 or more words and a mean probability of
 * LINE_SURE. A line ends at a pause of LONG_PAUSE or at a full stop, "?" or "!".
 */
export function clipLines(transcript, { most = 3 } = {}) {
  return readClipSound(transcript).lines.sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.start - b.start).slice(0, most);
}

// whisper's own sound tags that name a voice ("[speaking in foreign language]", "(giggles)",
// "*sobbing*"), and the ones that say the voice is in a language an English model cannot read.
// Measured on run 8's 13 clips with small.en (.scratch/run8/wave/clip-sound-review/RESULT.md):
// every tag whisper wrote on a voice used one of these words; "Music]" and "(upbeat music)" are not
// a voice, and neither is a tag that names the music ("*sings along to the music*" on a stairs
// clip of score and steps): that is the score's own voice, not a person's (MUSIC_TAG). Whole words only: inside a word, "sing" is "rising" or "closing", "hum" is "thump", "cry" is
// "crystal", so "(music rising)" or "(door closing)" would read as a voice.
const VOICE_TAG = /\b(speak|sings?\b|singing|sung\b|talk|language|chant|laugh|giggl|chuckl|sob|cr(y|ies|ied|ying)\b|scream|shout|yell|gasp|scoff|sigh|groan|grunt|moan|hum(s|med|ming)?\b|mumbl|murmur|whisper|breath|pant(s|ed|ing)?\b)/i;
// A tag names another language when it says so ("foreign language") or names one after speaking,
// singing or talking: a capitalized word ("Singing in Japanese)"), or in an all-capitals tag any
// word but these ("[SPEAKING IN BACKGROUND]"). "(talking in the background)" names none, so the
// English lines around it stay lines.
const NOT_A_LANGUAGE = /^(BACKGROUND|DISTANCE|UNISON|CHORUS|HARMONY|THE|A|AN|SOFTLY|QUIETLY|LOUDLY|ALONG|TO|WITH|INDISTINCTLY)$/;
function namesOtherLanguage(text) {
  if (/foreign|language/i.test(text)) return true;
  if (/[a-z]/.test(text)) return /\b(?:speak|sing|talk)\w*\s+(?:in\s+)?[A-Z][a-z]+/.test(text.replace(/\b(?:speak|sing|talk)/gi, (verb) => verb.toLowerCase()));
  const word = /\b(?:SPEAK|SING|TALK)\w*\s+(?:IN\s+)?([A-Z]+)/.exec(text)?.[1];
  return Boolean(word) && !NOT_A_LANGUAGE.test(word);
}
const MUSIC_TAG = /\b(music|song|melody|instrumental)/i;
const VOICE_JOIN = 0.7; // seconds: voice spans closer than this read as one (a guess: one breath)
// One word said over and over is a voice (a laugh, a chant) when whisper was this sure of at least
// one of them. Measured on run 8: the laugh's runs had a best word p of 0.88 to 0.97 on four runs
// ("Hey" x6, "Heh" x7, "heh" x8, "Heh, heh"), a score's "Good. Good." 0.34. A guess between them.
const REPEAT_SURE = 0.6;

/**
 * What a clip's own sound holds, from its transcript: {lines, voice, otherLanguage}.
 * lines: [{text, start, end}] a viewer could read (as clipLines). voice: [{start, end}] (file
 * seconds, joined) where whisper heard a voice it could not read as words: inside its own voice
 * tags, a line of one word said over and over ("Hey, hey, hey": a laugh, measured on run 8's clip
 * F4.7, read "Hey" x6, "Heh" x8 and "heh" x9 on three runs), and every line of a clip whisper
 * tagged as another language (an English model writes sound-alike words for it: "I see." in
 * F4.13). otherLanguage: whisper tagged one. No language is named: an English model cannot tell.
 */
export function readClipSound(transcript) {
  const words = transcript?.words ?? [];
  // Words inside a tag: from an opening bracket to its closing one; a closing bracket without its
  // opening (a transcript made before wordsFromWhisper kept it) reaches back to the pause before.
  const inTag = new Array(words.length).fill(false);
  const tags = [];
  for (let i = 0, open = -1; i < words.length; i += 1) {
    const text = String(words[i].text ?? "");
    if (words[i].unclear) { open = -1; continue; }
    if (open < 0 && /^[[(*]/.test(text)) open = i;
    // "*sobbing" opens a tag and does not close it; "*sobbing*", "sobbing*" and "Japanese)" close one.
    const closes = /[\])][.,!?]*$/.test(text) || (/\*[.,!?]*$/.test(text) && !(open === i && /^\*[^*]*$/.test(text)));
    if (!closes) continue;
    // A tag glued to a word ("see.(laughs)") is its own: the word stays a word (withoutGluedTag).
    if (open < 0 && /[[(]/.test(text)) {
      tags.push({ text, start: words[i].start, end: words[i].end });
      continue;
    }
    let from = open;
    if (from < 0) {
      from = i;
      while (from > 0 && !words[from - 1].unclear && !/[\])*][.,!?]*$/.test(words[from - 1].text) && words[from].start - words[from - 1].end < LONG_PAUSE) from -= 1;
    }
    for (let k = from; k <= i; k += 1) inTag[k] = true;
    tags.push({ text: words.slice(from, i + 1).map((word) => word.text).join(" "), start: words[from].start, end: words[i].end });
    open = -1;
  }
  // A transcript heard in its own language (backend/speech/transcribe.mjs heard): its lines are the
  // words as said, so a tag naming a language turns nothing into voice.
  const language = typeof transcript?.language === "string" && transcript.language !== "en" ? transcript.language : null;
  const noSpace = language && NO_SPACE_LANGUAGES.has(language);
  const tagged = !language && tags.some((tag) => namesOtherLanguage(tag.text));
  const otherLanguage = Boolean(language) || tagged;
  const endsSaid = (text) => endsLine(text) || (noSpace && /[。！？]["'）」』]*$/.test(text));
  const voice = tags.filter((tag) => VOICE_TAG.test(tag.text) && !MUSIC_TAG.test(tag.text)).map(({ start, end }) => ({ start, end }));
  // One word over and over ("Heh. Heh. Heh.", "Heh, heh,"), across full stops and unsure words:
  // a voice when whisper was sure of one of them (REPEAT_SURE). A line would drop it word by word.
  // Only a run that stands alone: "No, no, no, wait!" stays a line.
  const said = (k) => k >= 0 && k < words.length && !inTag[k] && !words[k].unclear && plainWord(withoutGluedTag(words[k].text));
  const joins = (a, b) => said(a) && said(b) && words[b].start - words[a].end < LONG_PAUSE && !endsLine(words[a].text);
  for (let i = 0; i < words.length;) {
    let k = i + 1;
    while (said(i) && said(k) === said(i) && words[k].start - words[k - 1].end < LONG_PAUSE) k += 1;
    const alone = !joins(i - 1, i) && !joins(k - 1, k);
    if (k - i >= 2 && alone && Math.max(...words.slice(i, k).map((word) => word.p ?? 1)) >= REPEAT_SURE) {
      voice.push({ start: round(words[i].start), end: round(words[k - 1].end) });
      for (let n = i; n < k; n += 1) inTag[n] = true;
    }
    i = k;
  }
  const lines = [];
  let line = [];
  const close = () => {
    const said = line;
    line = [];
    // A language without spaces: one segment-word can be a whole line.
    if (said.length < (noSpace ? 1 : 2)) return;
    const span = { start: round(said[0].start), end: round(Math.max(said[0].start, said.at(-1).end)) };
    // An unsure line of a clip heard in its own language is still voice (the English pass read it as voice too).
    if (said.reduce((sum, word) => sum + (word.p ?? 1), 0) / said.length < LINE_SURE) { if (language) voice.push(span); return; }
    // One word over and over is a sound (a laugh, a chant), not a line; so is any line of a clip
    // the English model tagged as another language.
    if (tagged || (said.length > 1 && new Set(said.map((word) => plainWord(word.text))).size === 1)) { voice.push(span); return; }
    const text = said.map((word) => word.text).join(noSpace ? "" : " ");
    lines.push({ text: text.length > LINE_TEXT_MOST ? `${text.slice(0, LINE_TEXT_MOST - 1).trimEnd()}…` : text, ...span });
  };
  for (const [i, word] of words.entries()) {
    const text = withoutGluedTag(word.text);
    if (inTag[i] || word.unclear || !text || isTagWord(text) || FILLERS.has(plainWord(text))) { close(); continue; }
    if (line.length && word.start - line.at(-1).end >= LONG_PAUSE) close();
    line.push({ ...word, text });
    if (endsSaid(text)) close();
  }
  close();
  // Whisper's English for each line: the segments whose largest overlap is that line.
  if (language && Array.isArray(transcript.english)) {
    const glosses = lines.map(() => []);
    for (const segment of transcript.english) {
      let best = -1, most = 0;
      for (const [index, each] of lines.entries()) {
        const overlap = Math.min(each.end, segment.end) - Math.max(each.start, segment.start);
        if (overlap > most) { most = overlap; best = index; }
      }
      if (best >= 0) glosses[best].push(String(segment.text).trim());
    }
    for (const [index, each] of lines.entries()) {
      const english = glosses[index].join(" ");
      if (english) each.english = english.length > LINE_TEXT_MOST ? `${english.slice(0, LINE_TEXT_MOST - 1).trimEnd()}…` : english;
    }
  }
  const joined = [];
  // Voice a kept line already covers (a "(laughs)" glued to its last word) is said with the line.
  const free = voice.filter((span) => !lines.some((each) => span.start < each.end && span.end > each.start));
  for (const span of free.sort((a, b) => a.start - b.start)) {
    const last = joined.at(-1);
    if (last && span.start - last.end < VOICE_JOIN) last.end = round(Math.max(last.end, span.end));
    else joined.push({ start: round(span.start), end: round(span.end) });
  }
  return { lines, voice: joined, otherLanguage, ...(language ? { language, p: transcript.languageP ?? null } : {}) };
}

// Languages written without spaces between words (whisper's codes): a whisper segment is one word,
// a line may be one word and joins without spaces.
export const NO_SPACE_LANGUAGES = new Set(["ja", "zh", "yue", "th", "lo", "my", "km", "bo"]);

// "Japanese" for "ja"; the code itself when this runtime has no names.
function languageName(code) {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; }
}

// Sounds besides words, from the macOS sound classifier's 1 s windows (backend/footage/sounds.mjs).
// SOUND_SURE is a guess: on run 8's 13 clips (.scratch/barwave/wave/scene-sounds/RESULT.md) a
// clear dog bark read 0.75 and a duck quack 0.83, while the known laugh in one clip read only 0.43
// (keep_line falls back to every listed label, SOUND_LISTED, and says how sure).
export const SOUND_SURE = 0.5;
export const SOUND_LISTED = 0.1;
// A label in this share of a clip's windows (at SOUND_LISTED or more) is its bed, named once. A
// guess: run 8's score clips list "music" in 100% of their windows, a one-off sound in 1 or 2 of 5+.
export const BED_SHARE = 0.8;
const BED_LEAST = 3; // windows (2 s): a shorter clip has no bed, every sound is an event (a guess)

/**
 * A clip's sounds from the classifier's windows ([{t, d, top: [[label, sure]], db}], file seconds):
 * {events: [{label, start, end, sure, db}], bed: [label]}. Windows that overlap and share a label
 * at `sure` or more join into one event (its best sure, its loudest db). No label is left out.
 */
export function soundEvents(windows = [], { sure = SOUND_SURE } = {}) {
  const sorted = [...windows].filter((window) => Number.isFinite(window?.t)).sort((a, b) => a.t - b.t);
  const counts = new Map();
  for (const window of sorted) for (const [label, value] of window.top ?? []) if (value >= SOUND_LISTED) counts.set(label, (counts.get(label) ?? 0) + 1);
  const bed = sorted.length >= BED_LEAST ? [...counts].filter(([, count]) => count / sorted.length >= BED_SHARE).sort((a, b) => b[1] - a[1]).map(([label]) => label) : [];
  const open = new Map();
  const events = [];
  for (const window of sorted) {
    const end = window.t + (window.d ?? 1);
    for (const [label, value] of window.top ?? []) {
      if (!(value >= sure)) continue;
      const last = open.get(label);
      if (last && window.t <= last.end + 1e-6) {
        last.end = round(Math.max(last.end, end));
        last.sure = round(Math.max(last.sure, value));
        last.db = Math.max(last.db, window.db ?? -120);
        continue;
      }
      const event = { label, start: round(window.t), end: round(end), sure: round(value), db: window.db ?? -120 };
      open.set(label, event);
      events.push(event);
    }
  }
  return { events, bed };
}

/**
 * Events as moments, loudest first: [{name: "mallet percussion / glockenspiel", labels, start, end, db}].
 * Surest first, an event inside an earlier moment's span joins it, so a surer label is never hidden
 * under a less sure one; a label with the very same span is named beside the first (2 at most).
 */
export function soundMoments(events = []) {
  const moments = [];
  for (const event of [...events].sort((a, b) => b.sure - a.sure)) {
    const home = moments.find((moment) => event.start >= moment.start - 1e-6 && event.end <= moment.end + 1e-6);
    const same = home && Math.abs(event.start - home.start) < 1e-6 && Math.abs(event.end - home.end) < 1e-6;
    if (home) { if (same) home.labels.push(event.label); home.db = Math.max(home.db, event.db); }
    else moments.push({ labels: [event.label], start: event.start, end: event.end, db: event.db });
  }
  return moments.sort((a, b) => b.db - a.db).map((moment) => ({ ...moment, name: moment.labels.slice(0, 2).map((label) => String(label).replaceAll("_", " ")).join(" / ") }));
}

/**
 * `sounds laughter 0.5-2.0 s (-18 dB), mallet percussion / glockenspiel 5.0-6.5 s (-27 dB), … · bed music`:
 * the loudest few moments. A less sure event inside a surer one's span is the same moment (the
 * classifier names one sound several ways, and a window's db is the whole window's), so it joins
 * that moment (a label with the very same span is shown beside the first, 2 at most) instead of taking a place: on a product clip measured in the
 * skeptic proof (.scratch/barwave/wave/scene-sounds-review/RESULT.md) "mosquito buzz" and "insect"
 * windows inside the speech took 2 of the 3 places and hid the chime after it.
 */
export function clipSoundsText({ events = [], bed = [] } = {}, most = 3) {
  const moments = soundMoments(events.filter((item) => !bed.includes(item.label)));
  const parts = [];
  if (moments.length) parts.push(`sounds ${moments.slice(0, most).map((moment) => `${moment.name} ${moment.start.toFixed(1)}-${moment.end.toFixed(1)} s (${Math.round(moment.db)} dB)`).join(", ")}${moments.length > most ? ", …" : ""}`);
  if (bed.length) parts.push(`bed ${bed.slice(0, 2).map((label) => String(label).replaceAll("_", " ")).join(", ")}`);
  return parts.join(" · ");
}

/** `heard "Heh heh heh." 0.4-2.0 s, "I'm just gonna see." 7.1-9.2 s` for clipLines' answer, or "". */
export function clipLinesText(lines = [], most = 2) {
  if (!lines.length) return "";
  const shown = lines.slice(0, most).map((line) => `"${line.text.replaceAll('"', "'")}" ${line.start.toFixed(1)}-${line.end.toFixed(1)} s`);
  return `heard ${shown.join(", ")}${lines.length > most ? ", …" : ""}`;
}

/**
 * One clip's sound for the import answer and look source: its loudness, the lines it says, and
 * voice whisper heard but could not read. `-23.4 LUFS · voice heard 2.8-9.2 s, words not read`,
 * `-15.8 LUFS · heard "What are you doing here?" 0.5-1.4 s`, `-18.2 LUFS · no voice heard`.
 * sound: {lufs (integrated, null when silent), lines, voice} (readClipSound plus a level).
 */
export function clipSoundText({ lufs = null, lines = [], voice = [], language = null, p = null, sounds = null } = {}, most = 2) {
  const level = Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : "";
  const parts = [];
  // Another language: `heard in Japanese (ja, p 0.76): "<as said>" [gloss (machine, unverified): "<whisper's English>"] 0.0-6.1 s`.
  if (lines.length && language && language !== "en") {
    const quote = (text) => `"${String(text).replaceAll('"', "'")}"`;
    const shown = lines.slice(0, most).map((line) => `${quote(line.text)}${line.english ? ` [${GLOSS_LABEL}: ${quote(line.english)}]` : ""} ${line.start.toFixed(1)}-${line.end.toFixed(1)} s`);
    parts.push(`heard in ${languageName(language)} (${language}${Number.isFinite(p) ? `, p ${p.toFixed(2)}` : ""}): ${shown.join(", ")}${lines.length > most ? ", …" : ""}`);
  } else if (lines.length) parts.push(clipLinesText(lines, most));
  if (voice.length) parts.push(`voice heard ${voice.slice(0, most).map((span) => `${span.start.toFixed(1)}-${span.end.toFixed(1)}`).join(", ")}${voice.length > most ? ", …" : ""} s, words not read`);
  if (!parts.length) parts.push(level ? "no voice heard" : "");
  // Sounds besides words (soundEvents), when the clip was classified; a clip that could not be
  // (sounds.why: not a Mac, no helper) reads as before.
  const heard = sounds?.events ? clipSoundsText(sounds) : "";
  return [level, ...parts, heard].filter(Boolean).join(" · ");
}

export function captionWordsFromSpeech(words, fix = {}) {
  if (fix === null || typeof fix !== "object" || Array.isArray(fix)) fail("add_captions", 'fix is an object of {"heard": "meant"}, for example {"Acmes": "Acme"}.');
  const rules = Object.entries(fix).map(([heard, meant]) => {
    if (typeof meant !== "string") fail("add_captions", `fix "${heard}" must be a string ("" leaves the words out).`);
    const parts = String(heard).split(/\s+/).map(plainWord).filter(Boolean);
    if (!parts.length) fail("add_captions", `fix key "${heard}" has no letters or digits.`);
    return { heard, parts, meant };
  }).sort((a, b) => b.parts.length - a.parts.length);
  const spoken = words.filter((word) => !word.unclear && !SOUND_TAG.test(word.text) && !FILLERS.has(plainWord(word.text)));
  const left = words.length - spoken.length;
  const out = [];
  let fixed = 0;
  const used = new Set();
  for (let at = 0; at < spoken.length;) {
    const rule = rules.find(({ parts }) => parts.every((part, offset) => plainWord(spoken[at + offset]?.text ?? "") === part));
    if (!rule) {
      out.push({ text: spoken[at].text, start: spoken[at].start, end: spoken[at].end });
      at += 1;
      continue;
    }
    const run = spoken.slice(at, at + rule.parts.length);
    used.add(rule);
    fixed += 1;
    if (rule.meant) {
      const trailing = /[^\p{L}\p{N}']+$/u.exec(run.at(-1).text)?.[0] ?? "";
      const meant = /[^\p{L}\p{N}']$/u.test(rule.meant) ? rule.meant : `${rule.meant}${trailing}`;
      out.push({ text: meant, start: run[0].start, end: run.at(-1).end });
    }
    at += rule.parts.length;
  }
  const unused = rules.filter((rule) => !used.has(rule)).map((rule) => rule.heard);
  return { words: out, fixed, left, ...(unused.length ? { unused } : {}) };
}
