// keep_line: one spoken line of a clip stays in the edit. The rest of that layer's sound is
// silenced, a small subtitle shows the line, and the music dips under it.
//
//   keep_line {sceneId, layerId, line? | from?, to?, text?, subtitle?, look?, name?, duckId?, duckNone?, dip?, dropout?, wait?, transcript?, levels?, beats?}
//
//   line      the words to keep, found in the clip's transcript as add_captions {speech} reads it
//   from, to  or a stretch in scene seconds (works with no transcript, for speech in another language)
//   text      the subtitle's words instead of the transcript's (a fix, or a translation); shown over
//             the whole line. kino does not refuse a text that differs from what it heard in the
//             stretch: the receipt says what it heard next to what was typed (notes, heard)
//   subtitle  false: no subtitle. look: add_captions look (default "subtitle"); name: its group
//   duckId    the music layer (default: the audio layer named music or song, else the only other one);
//             duckNone: no dip. dip: the music's volume under the line. Default, with both files
//             measured (levels, put in by the agent service): the line is leveled against the music
//             in the 2 s around it (voiceLevel on the layer, read by the export) and the dip holds the
//             mix under the line at that music's level (mixLevels.js lineOverMusic); unmeasured, 0.7
//             of the music's volume (about 3 dB) and the line at -16 LUFS. The release ends on the
//             song's next beat (beats {layerId: beat analysis}, put in by the agent service).
//   dropout   true: the music leaves for the line and hits back on the next downbeat within wait (default half a bar), else the next beat
//   wait      0 to 4 s: how long the music may stay out for the downbeat (with dropout)
// The receipt's mix {line, around, under, change} (LUFS, LU) says the total under the line next to
// the 2 s around, for any dip, given or default: a fact, never a refusal.
//
// line matches leniently: case, punctuation and apostrophes ("cant" is "can't"), a repeat said more
// or fewer times ("I can't, I can't" finds "I can't, I can't, I can't"), a last word typed short,
// and the first words of a longer typed line (a note says which words were kept). A miss lists
// the lines heard in that layer.
//
// It is built from what exists: speechWords and captionWordsFromSpeech (the words), add_captions
// (the subtitle) and duck_audio (the dip). The silence is two Volume animations per line, "Line up"
// and "Line down" (and "Line mute" from the scene's start), at the layer's own volume. Another
// keep_line on the same layer keeps both lines: it reads the first from those animations.
import { uid } from "./model.js";
import { mediaPlaybackRange, mediaSoundTime } from "./playback.js";
import { applyAddCaptions } from "./captionLayers.js";
import { applyDuckAudio, DUCK_NAMES } from "./audioDucking.js";
import { captionWordsFromSpeech, checkSpeechLayer, speechPieces, speechWords, withoutGluedTag } from "./speech.js";
import { energyMean, heardLoudness, lineOverMusic, loudnessOver } from "./mixLevels.js";
import { barLines } from "./songBars.js";
import { round } from "./numbers.js";

export const LINE_NAMES = Object.freeze({ mute: "Line mute", up: "Line up", down: "Line down" });
// The music's volume under the line, as a share of its own volume. 0.7 is about 3 dB down. It was
// 0.5 (6 dB): a director keeping lines over a song's drop reported the song sank to 0.4 and raised
// it to dip 0.8 by hand to keep the drop's energy (.scratch/ceiling/a/result.md, FRICTION 10).
// 0.7 sits between the two; a guess, so dip sets it per call.
export const DEFAULT_DIP = 0.7;
// The fade up starts this long before the first word (the breath), the fade down after the last.
const UP_PAD = 0.08;
const DOWN_PAD = 0.12;
const SHORTEST = 0.001;
const MUSIC_NAME = /music|song|track|score/i;
const isLineMark = (animation) => Object.values(LINE_NAMES).includes(animation?.name);

function fail(message) {
  throw new Error(`keep_line: ${message}`);
}

// A word as a match key: lower case, letters and digits only (apostrophes, curly or straight, go too).
const matchKey = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// Tokens with an immediate repeat of the 1 to 4 tokens before it folded in: [{key, from, to}],
// from/to the indices of the first and last original token it covers.
function folded(keys) {
  const out = [];
  for (let index = 0; index < keys.length; index += 1) {
    let size = 0;
    for (let n = Math.min(4, out.length); n >= 1 && !size; n -= 1)
      if (index + n <= keys.length && out.slice(-n).every((entry, offset) => entry.key === keys[index + offset])) size = n;
    if (size) { out.at(-1).to = index + size - 1; index += size - 1; }
    else out.push({ key: keys[index], from: index, to: index });
  }
  return out;
}

/**
 * The words of `line` in `words` ([{text, start, end}], scene seconds), matched leniently:
 * {words: [{text, at, end}], note?} or null. Tried in order: the exact words; the last typed word
 * as a prefix (3+ letters) of the heard one; repeats folded on both sides; the longest run of the
 * typed line's first words (3 or more, at least half of them), with a note.
 */
export function findLine(words, line) {
  const wanted = String(line).split(/\s+/).map(matchKey).filter(Boolean);
  if (!wanted.length || !words.length) return null;
  const said = words.map((word) => matchKey(word.text));
  const span = (from, to) => words.slice(from, to + 1).map((word) => ({ text: word.text, at: word.start, end: word.end }));
  const same = (heard, typed, last) => heard === typed || (last && typed.length >= 3 && heard.startsWith(typed));
  const runIn = (keys, want, prefix = false) => {
    for (let index = 0; index + want.length <= keys.length; index += 1)
      if (want.every((key, offset) => same(keys[index + offset], key, prefix && offset === want.length - 1))) return index;
    return -1;
  };
  const exact = runIn(said, wanted);
  const at = exact >= 0 ? exact : runIn(said, wanted, true);
  if (at >= 0) return { words: span(at, at + wanted.length - 1) };
  const heardFold = folded(said);
  const wantedFold = folded(wanted).map((entry) => entry.key);
  const foldAt = runIn(heardFold.map((entry) => entry.key), wantedFold);
  if (foldAt >= 0) return { words: span(heardFold[foldAt].from, heardFold[foldAt + wantedFold.length - 1].to) };
  for (let count = wanted.length - 1; count >= Math.max(3, Math.ceil(wanted.length / 2)); count -= 1) {
    const start = runIn(said, wanted.slice(0, count));
    if (start >= 0) {
      const found = span(start, start + count - 1);
      return { words: found, note: `kept the first ${count} of ${wanted.length} typed words, as heard: "${found.map((word) => word.text).join(" ")}"` };
    }
  }
  return null;
}

// The lines heard in `words` (split at a sentence end or a 0.6 s pause), for a miss: at most 4.
function heardLines(words) {
  const lines = [];
  let current = [];
  for (const [index, word] of words.entries()) {
    current.push(word);
    const next = words[index + 1];
    if (!next || /[.!?…]["')\]]*$/.test(word.text) || next.start - word.end >= 0.6) { lines.push(current); current = []; }
  }
  const shown = lines.slice(0, 4).map((line) => `"${line.map((word) => word.text).join(" ").replaceAll('"', "'")}" ${round(line[0].start, 1)}-${round(line.at(-1).end, 1)} s`);
  return `${shown.join(" · ")}${lines.length > 4 ? ` +${lines.length - 4} more` : ""}`;
}

// The stretches (scene seconds) an earlier keep_line left audible on the layer, from its animations.
export function keptRanges(layer) {
  const marks = (layer.animations ?? []).filter((animation) => animation.name === LINE_NAMES.up || animation.name === LINE_NAMES.down).sort((a, b) => a.start - b.start);
  const ranges = [];
  let open = null;
  for (const mark of marks) {
    if (mark.name === LINE_NAMES.up) open = mark.start + mark.duration;
    else { ranges.push({ start: open ?? 0, end: mark.start }); open = null; }
  }
  if (open !== null) ranges.push({ start: open, end: Infinity });
  return ranges;
}

function merged(ranges) {
  const out = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && range.start - last.end < UP_PAD + DOWN_PAD + 0.05) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

// Volume animations that play only `ranges` of the layer, at `volume`.
function silenceAround(ranges, volume, sceneDuration) {
  const added = [];
  const ramp = (name, start, end, from, to) => added.push({ id: uid(), name, kind: "custom", easing: "smooth", start: round(start), duration: Math.max(SHORTEST, round(end - start)), from: { volume: from }, to: { volume: to } });
  if (!ranges.length) ramp(LINE_NAMES.mute, 0, SHORTEST, volume, 0);
  for (const [index, range] of ranges.entries()) {
    const upStart = Math.max(0, range.start - UP_PAD);
    if (index === 0 && upStart > 0.002) ramp(LINE_NAMES.mute, 0, SHORTEST, volume, 0);
    if (upStart > 0.002) ramp(LINE_NAMES.up, upStart, range.start, 0, volume);
    if (Number.isFinite(range.end) && range.end + DOWN_PAD < sceneDuration - 0.002) ramp(LINE_NAMES.down, range.end, range.end + DOWN_PAD, volume, 0);
  }
  return added;
}

// The music layer to dip, or null with the reason.
function musicOf(scene, layer, operation) {
  if (operation.duckNone) return { reason: "duck is none" };
  if (operation.duckId !== undefined) {
    const found = scene.layers.find((item) => item.id === operation.duckId);
    if (!found) fail(`duck: layer ${operation.duckId} was not found in this scene.`);
    if (found.type !== "audio" && found.type !== "video") fail(`duck: "${found.name}" has no sound.`);
    if (found.id === layer.id) fail("duck: the music is another layer than the one with the line.");
    return { layer: found };
  }
  const sound = scene.layers.filter((item) => item.type === "audio" && item.id !== layer.id && item.src);
  const found = sound.find((item) => MUSIC_NAME.test(item.name)) ?? (sound.length === 1 ? sound[0] : null);
  return found ? { layer: found } : { reason: "no music layer found (name one in duck)" };
}

// The music is measured this long before and after the line (seconds): the 2 s the design names
// (.scratch/run8/trace/DESIGN-2.md change 4), the stretch a listener compares the line with.
const AROUND = 2;
// A release shorter than this sounds like a jump, so the next beat must be at least this far after
// the line (seconds; a guess). The old release was 0.8 s (audioDucking DUCK_FADES.up).
const MIN_RELEASE = 0.2;
// With dropout the music comes back in this long, ending on the downbeat (a near cut without a click; a guess).
const HIT_IN = 0.03;

/**
 * The line and the music around it, measured (operation.levels: {layerId: loudness curve}, put in by
 * the agent service), as lineOverMusic gives them plus {measured: {line, around, under}}; null
 * without both curves.
 */
function lineOverMusicAt(scene, owner, musicLayer, start, end, operation) {
  const lineCurve = operation.levels?.[owner.piece.id];
  const musicCurve = operation.levels?.[musicLayer.id];
  const range = mediaPlaybackRange(musicLayer, scene.duration);
  if (!lineCurve || !musicCurve || !range) return null;
  const raw = loudnessOver(lineCurve, [{ start: mediaSoundTime(owner.piece, start), end: mediaSoundTime(owner.piece, end) }]);
  if (raw === null) return null;
  // The music as it plays without the dips duck_audio is about to replace.
  const base = { ...musicLayer, animations: (musicLayer.animations ?? []).filter((animation) => animation.name !== DUCK_NAMES.down && animation.name !== DUCK_NAMES.up) };
  const sides = [heardLoudness(musicCurve, base, range, start - AROUND, start), heardLoudness(musicCurve, base, range, end, end + AROUND)].filter((value) => value !== null);
  const measured = {
    line: round(raw + 20 * Math.log10(Math.max(1e-6, owner.volume)), 1),
    around: sides.length ? round(energyMean(sides), 1) : null,
    under: heardLoudness(musicCurve, base, range, start, end),
  };
  if (measured.under !== null) measured.under = round(measured.under, 1);
  const over = lineOverMusic(measured, { dropout: operation.dropout === true });
  return over ? { ...over, measured } : null;
}

/**
 * When the music comes back after a line ending at `end` (scene seconds): {at} on the song's next
 * beat at least MIN_RELEASE after it, or with `dropout` the next bar line (songBars.js barLines) after
 * the line's fade down. `analysis` is the song file's beat analysis (operation.beats, put in by the
 * agent service). Null without beats, or when that beat is past the scene's end.
 */
function returnTime(scene, musicLayer, analysis, end, dropout, wait) {
  if (!Array.isArray(analysis?.beats) || !analysis.beats.length) return null;
  const range = mediaPlaybackRange(musicLayer, scene.duration);
  if (!range || range.remapped) return null;
  const inScene = (time) => range.start + (time - range.offset);
  const open = (time) => time < Math.min(scene.duration, range.end) - 0.01;
  const earliest = end + (dropout ? DOWN_PAD : MIN_RELEASE);
  const nextBeat = analysis.beats.map(inScene).find((time) => time >= earliest);
  if (!dropout) return nextBeat !== undefined && open(nextBeat) ? { at: round(nextBeat) } : null;
  // dropout: the downbeat when it comes within `wait` of the line (default half a bar), else the next beat.
  // The silence a human cut left before the music came back was 0.22 s (a reference edit); a downbeat
  // 1.9 s later (run 8) left the line in a hole.
  const down = (barLines(analysis)?.lines ?? []).map(inScene).find((time) => time >= earliest);
  const spacing = analysis.beats.slice(1).map((time, index) => time - analysis.beats[index]).filter((gap) => gap > 0).sort((a, b) => a - b);
  const limit = Number.isFinite(wait) ? wait : 2 * (spacing[Math.floor(spacing.length / 2)] ?? 0);
  const downOk = down !== undefined && open(down);
  if (downOk && down - end <= limit + 1e-6) return { at: round(down), kind: "downbeat" };
  if (nextBeat !== undefined && open(nextBeat)) return { at: round(nextBeat), kind: "beat", downbeat: downOk ? round(down) : null };
  return downOk ? { at: round(down), kind: "downbeat" } : null;
}

// dropout: the music stays out until `at`, then comes back in HIT_IN seconds ending on it.
function hitBack(scene, musicLayer, end, at) {
  const head = musicLayer.fitMusic ?? musicLayer.id;
  for (const piece of scene.layers.filter((item) => item.id === head || item.fitMusic === head))
    for (const animation of piece.animations ?? [])
      if (animation.name === DUCK_NAMES.up && animation.start >= end - 0.01 && animation.start < at) {
        animation.start = round(Math.max(animation.start, at - HIT_IN));
        animation.duration = Math.max(SHORTEST, round(at - animation.start));
      }
}

/** Applies keep_line to `document` (changed in place). Returns the receipt. */
export function applyKeepLine(document, operation, { fonts } = {}) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  if (!layer) fail(`layer ${operation.layerId} was not found.`);
  if ((layer.type !== "audio" && layer.type !== "video") || !layer.src) fail(`"${layer.name}" is a ${layer.type} layer; give the audio or video layer that plays the clip.`);
  const timed = operation.from !== undefined || operation.to !== undefined;
  if (operation.line !== undefined && timed) fail("give line (words said in the clip) or from and to (scene seconds), not both.");
  if (operation.line === undefined && !timed) fail("give line (words said in the clip) or from and to (scene seconds).");
  if (operation.line !== undefined && (typeof operation.line !== "string" || !operation.line.trim())) fail("line is the words to keep, as said.");
  if (operation.text !== undefined && (typeof operation.text !== "string" || !operation.text.trim())) fail("text is the subtitle's words, a string.");
  if (operation.dip !== undefined && (typeof operation.dip !== "number" || !(operation.dip >= 0 && operation.dip <= 1))) fail("dip is the music's volume under the line, a number from 0 to 1.");
  // A voice cut into pieces (cut_speech) is one sound: the line may play on any piece, and every piece is silenced around it.
  const plays = speechPieces(scene, layer).map((piece) => ({ piece, play: mediaPlaybackRange(piece, scene.duration) })).filter((entry) => entry.play);
  if (!plays.length) fail(`"${layer.name}" does not play inside this scene.`);
  const range = { start: Math.min(...plays.map((entry) => entry.play.start)), end: Math.max(...plays.map((entry) => entry.play.end)) };

  // The words the scene plays, as captions read them (none when the clip was not transcribed or has none).
  // A sound tag glued to a word ("see.(laughs)") is left out, as clipLines shows the line.
  const heard = operation.transcript?.words?.length
    ? captionWordsFromSpeech(speechWords(scene, checkSpeechLayer(scene, layer, "keep_line"), operation.transcript)
      .map((word) => ({ ...word, text: withoutGluedTag(word.text) || word.text }))).words : [];
  let start;
  let end;
  let said;
  let lineNote = null;
  if (operation.line !== undefined) {
    if (!heard.length) fail(`"${layer.name}" has no words heard to find "${operation.line}" in; give from and to (scene seconds) and text instead.`);
    const match = findLine(heard, operation.line);
    if (!match) fail(`"${operation.line}" is not said in ${layer.name} in this scene. Heard there: ${heardLines(heard)}. Give one of those, or from and to (scene seconds) and text.`);
    const found = match.words;
    if (match.note) lineNote = match.note;
    start = found[0].at;
    end = found.at(-1).end;
    said = found.map((item) => ({ text: item.text, start: item.at, end: item.end }));
  } else {
    for (const key of ["from", "to"]) if (typeof operation[key] !== "number" || !Number.isFinite(operation[key])) fail(`${key} is seconds on the scene's clock, a number.`);
    start = Math.max(operation.from, range.start);
    end = Math.min(operation.to, range.end);
    if (!(end - start >= 0.1)) fail(`from ${operation.from} to ${operation.to} is under 0.1 s of what "${layer.name}" plays (${round(range.start)} to ${round(range.end)} s).`);
    said = heard.filter((item) => item.start >= start - 0.01 && item.start < end);
  }
  start = round(start);
  end = round(end);

  // The sound: only the kept stretches (an earlier keep_line's too) at the layer's own volume.
  // Each piece keeps the part of the line it plays; a piece that plays none is silent.
  const kept = plays.map(({ piece, play }) => {
    const from = Math.max(start, play.start);
    const to = Math.min(end, play.end);
    const volume = piece.volume > 0 ? piece.volume : 1;
    const ranges = merged([...keptRanges(piece), ...(to - from > SHORTEST ? [{ start: from, end: to }] : [])]);
    piece.volume = volume;
    piece.animations = [...(piece.animations ?? []).filter((animation) => !isLineMark(animation)), ...silenceAround(ranges, volume, scene.duration)];
    return { piece, play, ranges, volume };
  });
  const owner = kept.find((entry) => entry.play.start <= start + 0.001 && start < entry.play.end) ?? kept.find((entry) => entry.ranges.length) ?? kept[0];
  const { volume } = owner;
  const ranges = owner.ranges;

  // The subtitle, timed to the words (or to the line when the text is given).
  const notes = lineNote ? [lineNote] : [];
  // What kino heard in the kept stretch, said next to the typed subtitle when they differ (one line, no refusal):
  // a typed text over audio heard as other words is how a wrong line gets kept.
  const heardText = said.map((item) => item.text).join(" ").trim();
  const letters = (words) => String(words).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const differs = operation.text !== undefined && heardText && letters(heardText) !== letters(operation.text);
  if (differs) notes.push(`kino heard "${heardText.length > 80 ? `${heardText.slice(0, 80)}...` : heardText}" in that stretch; the subtitle shows your text "${operation.text.length > 80 ? `${operation.text.slice(0, 80)}...` : operation.text}"`);
  let subtitle = null;
  const name = operation.name ?? `line-at-${round(start, 1)}s`;
  if (operation.subtitle !== false) {
    const look = operation.look ?? "subtitle";
    if (operation.text !== undefined) {
      // A page stays up long enough to read (20 characters a second, 5/6 s at least), past the line when it is short.
      const readEnd = Math.min(scene.duration, round(Math.max(end, start + Math.max(operation.text.length / 20, 5 / 6) + 0.02)));
      if (readEnd > end) notes.push(`the subtitle stays up to ${readEnd} s so it can be read`);
      subtitle = applyAddCaptions(document, { type: "add_captions", sceneId: scene.id, text: operation.text, format: "text", start, end: readEnd, look, name }, { fonts });
    }
    else if (said.length) subtitle = applyAddCaptions(document, { type: "add_captions", sceneId: scene.id, words: said, look, name }, { fonts });
    else notes.push("no words were heard in that stretch, so there is no subtitle: give text (what is said) to add one");
  }

  // The music dips under the kept stretches only (the words of the other speech are silent now).
  const music = musicOf(scene, layer, operation);
  if (operation.dropout !== undefined && typeof operation.dropout !== "boolean") fail("dropout is true (the music leaves for the line and comes back on the next downbeat) or false.");
  if (operation.wait !== undefined && (typeof operation.wait !== "number" || !(operation.wait >= 0 && operation.wait <= 4))) fail("wait is how many seconds the music may stay out for the next downbeat, 0 to 4 (default half a bar; past it the music hits back on the next beat).");
  if (operation.dropout && operation.dip !== undefined) fail("give dip or dropout:true, not both: dropout takes the music out under the line.");
  let duck = null;
  let mix = null;
  if (music.layer) {
    const level = music.layer.volume ?? 1;
    // Over measured music: the line is leveled against the music around it and the dip holds the
    // mix (mixLevels.js lineOverMusic); the old fixed 0.7 dip and -16 LUFS line stay without measurements.
    const over = lineOverMusicAt(scene, owner, music.layer, start, end, operation);
    const dip = operation.dropout ? 0
      : operation.dip ?? (over ? round(Math.max(0, Math.min(level, level * 10 ** (over.dipDb / 20)))) : round(level * DEFAULT_DIP));
    if (dip > level) notes.push(`dip ${dip} is above the music's volume ${level}, so the music gets louder under the line`);
    if (over) {
      // The export levels the kept line to this (before the layer's volume).
      owner.piece.voiceLevel = round(over.target - 20 * Math.log10(Math.max(1e-6, volume)), 1);
      for (const entry of kept) if (entry !== owner) entry.piece.voiceLevel = owner.piece.voiceLevel;
      const given = operation.dip !== undefined ? lineOverMusic(over.measured, { dropDb: 20 * Math.log10(Math.max(1e-6, dip / level)) }) : over;
      const change = round(given.total - over.measured.around, 1);
      mix = { line: given.heard, around: over.measured.around, under: given.total, change };
      notes.push(`line leveled to ${given.heard} LUFS against the music around it (${over.measured.around}); ${operation.dropout ? "music out under the line" : `dip ${dip} (${round(given.dipDb, 1)} dB)`}`);
    } else for (const entry of kept) delete entry.piece.voiceLevel;
    if (!over && operation.dip === undefined && !operation.dropout) notes.push(`the music dips to ${dip} under the line (${DEFAULT_DIP} of its volume ${level}, about 3 dB; not measured); dip:<0 to 1> sets it`);
    const under = kept.filter((entry) => entry.ranges.length);
    const speech = {};
    for (const { piece, play, ranges: stretches } of under)
      speech[piece.id] = { words: stretches.map((item) => ({ text: "line", start: round(mediaSoundTime(piece, Math.max(item.start, play.start))), end: round(mediaSoundTime(piece, Math.min(item.end, play.end))), p: 1 })) };
    // The release ends on the song's next beat (dropout: the music hits back on the next downbeat).
    const back = returnTime(scene, music.layer, operation.beats?.[music.layer.id], end, operation.dropout, operation.wait);
    const fadeUp = back ? round(back.at - end) : undefined;
    duck = applyDuckAudio(document, { type: "duck_audio", sceneId: scene.id, layerId: music.layer.id, under: under.map((entry) => entry.piece.id), to: dip, speech, ...(fadeUp !== undefined ? { fadeUp } : {}) });
    if (operation.dropout && back) hitBack(scene, music.layer, end, back.at);
    if (back && operation.dropout && back.kind === "beat") notes.push(`the music drops out for the line and hits back on the beat at ${back.at} s (${round(back.at - end, 1)} s after the line${back.downbeat != null ? `; the downbeat at ${back.downbeat} s is ${round(back.downbeat - end, 1)} s after${back.downbeat - end <= 4 ? `: wait:${Math.min(4, Math.ceil((back.downbeat - end) * 10) / 10)} waits for it` : ""}` : ""})`);
    else if (back) notes.push(operation.dropout ? `the music drops out for the line and hits back on the downbeat at ${back.at} s (${round(back.at - end, 1)} s after the line)` : `the music comes back up on the beat at ${back.at} s`);
    else if (operation.dropout) notes.push("no beats measured on the music: it comes back over 0.8 s after the line");
    if (operation.wait !== undefined && !operation.dropout) notes.push("wait is ignored without dropout:true (it is how long the music stays out for the next downbeat)");
    if (!operation.dropout && operation.dip === undefined && over) notes.push("dropout:true takes the music out under the line and hits back on the next downbeat");
  } else {
    for (const entry of kept) delete entry.piece.voiceLevel;
    notes.push(`the music does not dip: ${music.reason}`);
  }

  const text = operation.text ?? (said.length ? said.map((item) => item.text).join(" ") : null);
  const fileFrom = round(mediaSoundTime(owner.piece, Math.max(start, owner.play.start)));
  const fileTo = round(mediaSoundTime(owner.piece, Math.min(end, owner.play.end)));
  return {
    layer: layer.name,
    line: text,
    scene: [start, end],
    file: [fileFrom, fileTo],
    volume,
    ...(differs ? { heard: heardText } : {}),
    kept: ranges.length,
    subtitle: subtitle ? { name: subtitle.name, pages: subtitle.pages, look: subtitle.look ?? operation.look ?? "subtitle" } : (operation.subtitle === false ? "off" : "none"),
    duck: duck ? { layer: duck.layer, to: duck.to, summary: duck.summary } : "none",
    ...(mix ? { mix } : {}),
    summary: `kept ${text ? `"${text.length > 60 ? `${text.slice(0, 60)}...` : text}" ` : ""}of ${layer.name} at ${start}-${end} s (file ${fileFrom}-${fileTo} s), the rest of its sound silenced; ${subtitle ? `subtitle ${subtitle.name}` : "no subtitle"}; ${duck ? duck.summary : "no music dip"}${mix ? `; mix under the line ${mix.under} vs ${mix.around} LUFS in the 2 s around (${mix.change >= 0 ? "+" : ""}${mix.change} LU)` : ""}`,
    ...(notes.length ? { notes } : {}),
  };
}
