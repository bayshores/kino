// keep_line: one spoken line of a clip stays in the edit. The rest of that layer's sound is
// silenced, a small subtitle shows the line, and the music dips under it.
//
//   keep_line {sceneId, layerId, line? | from?, to? | sound?, text?, subtitle?, look?, name?, duckId?, duckNone?, dip?, dropout?, wait?, transcript?, levels?, beats?}
//
//   line      the words to keep, found in the clip's transcript as add_captions {speech} reads it
//   from, to  or a stretch in scene seconds (works with no transcript, for speech in another language)
//   sound     or a non-speech sound the clip readout lists ("laugh" finds laughter): the loudest match
//             of operation.events (put in by the agent service), kept at its own level, no subtitle
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
//   dropout   true: the music leaves for the line and hits back on the next downbeat within wait
//             (default half a bar), else the next beat. Also the default
//             (no dip, no dropout) for a line the +12 dB lift cannot bring to the music: a dip would
//             dig a hole it cannot fill; the note gives the shortfall and the dip that holds the mix.
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
import { applyDuckAudio, DIP_FLOOR, DUCK_FADES, DUCK_NAMES, earlierDips, JOIN_MAX_GAP, LOUD_LUFS, RAMP_MIN, withoutDips } from "./audioDucking.js";
import { volumeAt } from "./animation.js";
import { FIT_NAMES } from "./fitMusic.js";
import { sectionCues } from "./mixLevels.js";
import { audibleRanges } from "./videoSound.js";
import { captionWordsFromSpeech, checkSpeechLayer, speechPieces, speechWords, withoutGluedTag } from "./speech.js";
import { LINE_SURE, LOW_CONFIDENCE, SOUND_SURE, soundMoments } from "./speech.js";
import { hiddenRanges } from "./visibilityOps.js";
import { energyMean, GAIN_STAGE_MAX_DB, heardLoudness, liftCap, lineOverMusic, lineWays, loudestHeard, loudnessOver, MAX_LEVEL_DB, noiseUnder, waysText } from "./mixLevels.js";
import { BED_VOLUME, EVEN_RAMP, LINE_EVEN_LU, LINE_OVER_BED, leveledVoice, lineEvening } from "./mixLevels.js";
import { churnRun } from "./quality/rules/sound.js";
import { barLines } from "./songBars.js";
import { round } from "./numbers.js";

// A sound kept by keep_line {sound} (not a line: never leveled) fades with "Sound up" and "Sound down",
// so a layer that keeps a line and a sound keeps both levels (the export levels only the lines).
// "Line level" ramps even the line's own loud and quiet words (mixLevels.js lineEvening).
export const LINE_NAMES = Object.freeze({ mute: "Line mute", up: "Line up", down: "Line down", soundUp: "Sound up", soundDown: "Sound down", level: "Line level" });
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
  // A line typed without spaces (a language written without them, as look source prints it):
  // consecutive heard words joined.
  if (wanted.length === 1) {
    for (let from = 0; from < said.length; from += 1) {
      let joined = "";
      for (let to = from; to < said.length && joined.length < wanted[0].length; to += 1) {
        joined += said[to];
        if (to > from && joined === wanted[0]) return { words: span(from, to) };
      }
    }
  }
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

// The stretches (scene seconds) an earlier keep_line left audible on the layer, from its animations:
// [{start, end, sound?}], sound: true for a kept sound (keep_line {sound}), played at its own level.
export function keptRanges(layer) {
  const ups = [LINE_NAMES.up, LINE_NAMES.soundUp], downs = [LINE_NAMES.down, LINE_NAMES.soundDown];
  const marks = (layer.animations ?? []).filter((animation) => ups.includes(animation.name) || downs.includes(animation.name)).sort((a, b) => a.start - b.start);
  const ranges = [];
  let open = null;
  for (const mark of marks) {
    if (ups.includes(mark.name)) open = { at: mark.start + mark.duration, sound: mark.name === LINE_NAMES.soundUp };
    else { ranges.push({ start: open?.at ?? 0, end: mark.start, ...(open ? (open.sound ? { sound: true } : {}) : mark.name === LINE_NAMES.soundDown ? { sound: true } : {}) }); open = null; }
  }
  if (open !== null) ranges.push({ start: open.at, end: Infinity, ...(open.sound ? { sound: true } : {}) });
  return ranges;
}

// Stretches closer than the fades join; a join of a line and a sound is a line (leveled).
function merged(ranges) {
  const out = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && range.start - last.end < UP_PAD + DOWN_PAD + 0.05) {
      last.end = Math.max(last.end, range.end);
      if (!range.sound) delete last.sound;
    } else out.push({ ...range });
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
    if (upStart > 0.002) ramp(range.sound ? LINE_NAMES.soundUp : LINE_NAMES.up, upStart, range.start, 0, volume);
    if (Number.isFinite(range.end) && range.end + DOWN_PAD < sceneDuration - 0.002) ramp(range.sound ? LINE_NAMES.soundDown : LINE_NAMES.down, range.end, range.end + DOWN_PAD, volume, 0);
  }
  return added;
}

// Two frames at 30 fps: the gap a subtitle page leaves before the next one (captionPaging gapFrames).
const CAPTION_GAP = 2 / 30;

// The stretches [{start, end}] a layer shows in, with the eye and Show/Hide of it and every group over it.
function shownStretches(chain, duration) {
  if (chain.some((item) => item.visible === false)) return [];
  const hidden = chain.flatMap((item) => hiddenRanges(item.animations ?? [], duration)).sort((a, b) => a.start - b.start);
  const shown = [];
  let at = 0;
  for (const range of hidden) {
    if (range.start > at) shown.push({ start: at, end: range.start });
    at = Math.max(at, range.end);
  }
  if (at < duration) shown.push({ start: at, end: duration });
  return shown;
}

// The caption groups (top-level layers holding role "caption" texts) in the scene, for a kept line at
// [start, end]: [{name, group (a top-level group, which add_captions name replaces), starts (when its
// texts come on), over (its texts shown over the line: [{name, text}]), own (all of it comes on during the
// line: that line's subtitle, typed or made)}].
function captionGroups(scene, start, end) {
  const byId = new Map(scene.layers.map((item) => [item.id, item]));
  const groups = new Map();
  for (const text of scene.layers.filter((item) => item.type === "text" && item.role === "caption")) {
    const chain = [];
    for (let at = text; at && !chain.includes(at); at = at.parentId ? byId.get(at.parentId) : null) chain.push(at);
    const root = chain.at(-1);
    const group = groups.get(root.id) ?? { name: root.name, group: root.type === "group" && !root.parentId, starts: [], over: [] };
    groups.set(root.id, group);
    const shown = shownStretches(chain, scene.duration);
    group.starts.push(...shown.map((item) => item.start));
    if (shown.some((item) => item.start < end - 0.01 && item.end > start + 0.01))
      group.over.push({ name: text.name, text: String(text.text ?? "").replace(/\s+/g, " ").trim() });
  }
  return [...groups.values()].map((group) => ({ ...group, own: group.starts.length > 0 && group.starts.every((time) => time >= start - 0.05 && time <= end) }));
}

// The words of a text, lowercase letters and digits only: ["ill", "kill", "you"].
const wordsOf = (text) => String(text).toLowerCase().split(/\s+/).map((item) => item.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);

// The subtitles shown over the kept line whose words `said` are heard there: a group that all comes on
// during the line (that line's own subtitle, typed or made), or one whose texts over the line share at
// least half of the words heard (a caption track of this voice). Captions of other words (a credit,
// another voice's track) are not this line's subtitle. Each with the call that changes it: name replaces
// the line's own group; a page of a longer track gets update_layer on its text, so the rest stays.
function subtitlesOver(groups, said) {
  const heard = new Set(said.flatMap((item) => wordsOf(item.text)));
  return groups.filter((group) => group.over.length).filter((group) => {
    if (group.own) return true;
    const shared = new Set(group.over.flatMap((item) => wordsOf(item.text)).filter((item) => heard.has(item)));
    return heard.size > 0 && shared.size >= Math.ceil(heard.size / 2);
  }).map((group) => ({
    name: group.name,
    text: group.over.map((item) => item.text).join(" "),
    change: group.own && group.group ? `text:"<the words said>" with name:"${group.name}" replaces it`
      : `update_layer {layer:"${group.over[0].name}", properties:{text:"<the words said>"}} changes its words${group.own ? "" : `, the rest of ${group.name} stays`}`,
  }));
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
// 0.3 s, audioDucking RAMP_MIN: a 0.14 s release read as a 17.4 LU bed_jump (.scratch dm2 b).
const MIN_RELEASE = RAMP_MIN;
// With dropout the music comes back in this long, ending on the downbeat (a near cut without a click; a guess).
const HIT_IN = 0.03;
// Without beats, a section cue this close after the line (seconds) is where the music comes back (a guess:
// half a bar at 120 BPM, the default wait with beats).
const SECTION_REACH = 1;
// The loudness of a sound change is read over this long on each side (seconds): one momentary window.
const RISE_WINDOW = 0.4;
// The lowest bed (dB under the music's own level) between lines that share a music-out dip: a guess
// for where a bed is still heard (volume 0.01, the level kino counts as heard).
const BED_LOWEST = -40;
// A receipt's hidden link from a line's note to its music, so a later keep_line in the same edit rewrites it.
const RETURN = Symbol("keep_line return");
// A receipt's hidden link to its line's place on the song, so its `dips` is written after every line in the edit.
const CHAIN = Symbol("keep_line dips");

// The dips that follow on from one another (each kept line its own level) around start..end on the
// song, as the receipt's `dips` text ("0.631 at 0.2-1.5 s · 0.562 at 1.5-3 s"); null for one dip alone.
function dipChain(scene, musicLayer, start, end) {
  const songHead = songOf(scene, musicLayer)[0]?.layer;
  const pairs = songHead ? duckPairs(songHead) : [];
  const at = pairs.findIndex((pair) => pair.start < end && pair.end > start);
  if (at < 0) return null;
  let first = at;
  let last = at;
  while (first > 0 && !pairs[first - 1].up && Math.abs(pairs[first - 1].end - pairs[first].start) < 0.01) first -= 1;
  while (last + 1 < pairs.length && !pairs[last].up && Math.abs(pairs[last].end - pairs[last + 1].start) < 0.01) last += 1;
  if (last === first) return null;
  return `${musicLayer.name} under the lines: ${pairs.slice(first, last + 1).map((pair) => `${round(pair.level)} at ${round(pair.start)}-${round(Math.min(pair.end, scene.duration))} s`).join(" · ")}`;
}
const db =(value) => 20 * Math.log10(Math.max(1e-6, value));
const powerSum = (...values) => 10 * Math.log10(values.filter(Number.isFinite).reduce((sum, value) => sum + 10 ** (value / 10), 0));

// The song and its fit_music pieces, each with its Play range.
function songOf(scene, musicLayer) {
  const head = musicLayer.fitMusic ?? musicLayer.id;
  return scene.layers.filter((item) => item.id === head || item.fitMusic === head)
    .map((layer) => ({ layer, range: mediaPlaybackRange(layer, scene.duration) })).filter((piece) => piece.range);
}

// Each dip on `piece` as its Duck down and Duck up: [{down, up, start, end}] (end with the fade up).
function duckPairs(piece) {
  const marks = (piece.animations ?? []).filter((item) => item.name === DUCK_NAMES.down || item.name === DUCK_NAMES.up).sort((a, b) => a.start - b.start);
  const pairs = [];
  let open = null;
  for (const mark of marks) {
    if (mark.name === DUCK_NAMES.down) { if (open) pairs.push({ down: open, up: null, start: open.start, end: mark.start }); open = mark; }
    else { pairs.push({ down: open, up: mark, start: open ? open.start : 0, end: mark.start + mark.duration }); open = null; }
  }
  if (open) pairs.push({ down: open, up: null, start: open.start, end: Infinity });
  return pairs.map((pair) => ({ ...pair, level: pair.down?.to?.volume ?? pair.up?.from?.volume ?? 1 }));
}

// The stretches kept by keep_line on every layer of the scene but the song: [{start, end, layer}].
function sceneLines(scene, song) {
  return scene.layers.filter((item) => !song.includes(item) && (item.animations ?? []).some(isLineMark))
    .flatMap((item) => keptRanges(item).filter((range) => Number.isFinite(range.end)).map((range) => ({ start: range.start, end: range.end, layer: item })));
}

// The mix (LUFS, energy over 0.1 s steps) of the song as it plays and the line at `line.heard` over its stretch.
function mixOver(curve, pieces, line, from, to) {
  const totals = [];
  for (let time = from; time < to - 1e-9; time += 0.1) {
    let energy = 0;
    for (const { layer, range } of pieces) {
      const value = heardLoudness(curve, layer, range, time, time + 0.1);
      if (value !== null) energy += 10 ** (value / 10);
    }
    if (line && Number.isFinite(line.heard) && time + 0.05 >= line.start && time + 0.05 < line.end) energy += 10 ** (line.heard / 10);
    if (energy > 0) totals.push(10 * Math.log10(energy));
  }
  return totals.length ? round(energyMean(totals), 1) : null;
}

/**
 * Lines that share one music-out dip (a later line joined it): the music holds a low bed through the
 * dip instead of leaving silence between the lines. The bed puts the music LINE_OVER_BED LU under the
 * quietest line in it (measured), no deeper than DIP_FLOOR (-20 dB); unmeasured it is DIP_FLOOR, a
 * starting guess. `silent` (dropout:true given) keeps the music out and only reports the silence.
 * Returns {note, at, gap} or null when the line's dip holds no other line.
 */
function shareBed(scene, musicLayer, levels, start, end, own, silent) {
  const curve = levels?.[musicLayer.id];
  const pieces = songOf(scene, musicLayer);
  if (!pieces.length) return null;
  const head = pieces[0];
  // The music out under the line, or at its bed (one dip the lines share at one level).
  const pair = duckPairs(head.layer).find((item) => item.start < end && item.end > start && (item.level <= 0.001 || !silent));
  if (!pair) return null;
  const lines = sceneLines(scene, pieces.map((piece) => piece.layer)).filter((line) => line.start < pair.end && line.end > pair.start).sort((a, b) => a.start - b.start);
  const others = lines.filter((line) => !(own.includes(line.layer) && line.start < end + 0.01 && line.end > start - 0.01));
  if (!others.length) return null;
  // The widest stretch between two kept lines inside the dip.
  let gap = null;
  for (let index = 1; index < lines.length; index += 1) {
    const from = Math.max(...lines.slice(0, index).map((line) => line.end));
    if (lines[index].start - from > (gap ? gap.end - gap.start : 0)) gap = { start: round(from), end: round(lines[index].start) };
  }
  const bare = withoutDips(head.layer);
  const left = pair.down?.from?.volume ?? volumeAt(bare, pair.start);
  const spans = `${lines.map((line) => `${round(line.start, 1)}-${round(line.end, 1)}`).join(", ")} s`;
  if (silent) {
    return { gap, note: `the lines at ${spans} share one dip with the music out (dip:0)${gap ? `: no music in the ${round(gap.end - gap.start, 1)} s between them at ${gap.start}-${gap.end} s` : ""}; without dip:0 the music holds a measured bed there` };
  }
  // The quietest line as the export levels it (voiceLevel, at most MAX_LEVEL_DB over the file's own
  // level), its volume applied, and the music under the dip untouched.
  const heard = lines.map((line) => {
    if (!Number.isFinite(line.layer.voiceLevel)) return null;
    const curve = levels?.[line.layer.id];
    const raw = curve ? loudnessOver(curve, [{ start: mediaSoundTime(line.layer, line.start), end: mediaSoundTime(line.layer, line.end) }]) : null;
    return Math.min(line.layer.voiceLevel, raw === null ? Infinity : raw + liftCap(line.layer)) + db(line.layer.volume ?? 1);
  });
  const music = heardLoudness(curve, bare, head.range, Math.max(pair.start, lines[0].start), Math.min(pair.end, lines.at(-1).end));
  const measured = heard.every(Number.isFinite) && music !== null;
  // The music went out because no dip down to -20 dB put it 6 LU under the line, so the bed goes as
  // deep as the line needs (the music under the line stays LINE_OVER_BED LU under it), down to BED_LOWEST.
  const needed = measured ? Math.min(...heard) - LINE_OVER_BED - music : null;
  const bedDb = measured ? Math.max(BED_LOWEST, Math.min(0, needed)) : db(DIP_FLOOR);
  for (const piece of pieces) {
    const match = duckPairs(piece.layer).find((item) => Math.abs(item.start - pair.start) < 0.002 && Math.abs(item.level - pair.level) <= 0.001);
    if (!match) continue;
    const from = match.down?.from?.volume ?? volumeAt(withoutDips(piece.layer), match.start);
    const bed = round(from * 10 ** (bedDb / 20));
    if (match.down) match.down.to = { ...match.down.to, volume: bed };
    if (match.up) match.up.from = { ...match.up.from, volume: bed };
  }
  const bed = round(left * 10 ** (bedDb / 20));
  const gapLevel = gap ? mixOver(curve, songOf(scene, musicLayer), null, gap.start, gap.end) : null;
  const quietest = round(Math.min(...heard), 1);
  const how = !measured ? "not measured: a starting guess at the -20 dB floor"
    : needed < BED_LOWEST ? `held at ${BED_LOWEST} dB, a starting guess for the lowest bed still heard: the quietest line, ${quietest} LUFS, is ${round(quietest - music - bedDb, 1)} LU over it`
      : `${LINE_OVER_BED} LU under the quietest line, ${quietest} LUFS, measured`;
  return {
    gap, bed,
    note: `the lines at ${spans} share one dip: the music holds a bed at ${bed} (${round(bedDb, 1)} dB; ${how}) through it instead of going out`
      + (gap ? `, ${gapLevel === null ? "unmeasured" : `${gapLevel} LUFS measured`} in the ${round(gap.end - gap.start, 1)} s between them at ${gap.start}-${gap.end} s` : "")
      + "; dropout:true with dip:0 keeps the music out there",
  };
}

// The name of a sound layer other than `own` and the song heard inside `pair` (volume over 0.01
// for RAMP_MIN s or more, sampled every 0.05 s; with a measured curve in `levels`, also louder
// than LOUD_LUFS there): a duck_audio dip under a voice-over, which a lift must not take away.
function otherSoundIn(scene, song, own, pair, levels) {
  const other = scene.layers.find((item) => (item.type === "audio" || item.type === "video") && !song.includes(item) && !own.includes(item) && audibleRanges(scene.layers, item, scene.duration).some((span) => {
    const from = Math.max(span.start, pair.start);
    const to = Math.min(span.end, pair.end, scene.duration);
    let heard = 0;
    for (let time = from; time < to; time += 0.05) if (volumeAt(item, time) > 0.01) heard += 0.05;
    if (heard < RAMP_MIN - 1e-6) return false;
    const range = mediaPlaybackRange(item, scene.duration);
    const loud = levels?.[item.id] ? heardLoudness(levels[item.id], item, range, from, to) : Infinity;
    return loud !== null && loud > LOUD_LUFS;
  }));
  return other?.name ?? null;
}

/**
 * The dips on the song that cover [start, end] and hold no other kept line and no other heard sound,
 * removed (a lift replaces them): {removed: [[start, end]], kept: [{at, name}]}, with fit_music's
 * fades set back to the level they meet.
 */
function removeDips(scene, musicLayer, start, end, own, levels) {
  const pieces = songOf(scene, musicLayer);
  const others = sceneLines(scene, pieces.map((piece) => piece.layer)).filter((line) => !(own.includes(line.layer) && line.start < end + 0.01 && line.end > start - 0.01));
  const removed = [];
  const stays = [];
  for (const [index, { layer }] of pieces.entries()) {
    const covering = duckPairs(layer).filter((pair) => pair.start < end && pair.end > start && !others.some((line) => line.start < pair.end && line.end > pair.start));
    const drop = covering.filter((pair) => {
      const name = otherSoundIn(scene, pieces.map((piece) => piece.layer), own, pair, levels);
      if (name && index === 0) stays.push({ at: [round(pair.start), round(Math.min(pair.end, scene.duration))], name });
      return !name;
    });
    if (!drop.length) continue;
    const gone = new Set(drop.flatMap((pair) => [pair.down, pair.up]).filter(Boolean));
    const kept = layer.animations.filter((animation) => !gone.has(animation));
    const base = { ...layer, animations: kept.filter((animation) => animation.name !== FIT_NAMES.in && animation.name !== FIT_NAMES.out) };
    layer.animations = kept.map((animation) => {
      if (animation.name === FIT_NAMES.in) return { ...animation, to: { ...animation.to, volume: round(volumeAt(base, animation.start + animation.duration)) } };
      if (animation.name === FIT_NAMES.out) return { ...animation, from: { ...animation.from, volume: round(volumeAt(base, animation.start)) } };
      return animation;
    });
    if (index === 0) removed.push(...drop.map((pair) => [round(pair.start), round(Math.min(pair.end, scene.duration))]));
  }
  return { removed, stays };
}

// A music-out line's notes once a shared dip holds the music at a bed under it: what said the music
// goes out says the bed instead (the too-quiet note keeps its measured shortfall).
function bedWording(notes, bed) {
  return notes.map((note) => note.replace("; music out under the line", `; the music at its bed (${bed}) under the line`)
    .replace(/, so the music goes out under it(;|$)/, `, so a dip cannot hold it: the music sits at a bed of ${bed} under it, shared with another line's dip$1`));
}

// Rewrites the music-return note (and the mix) of each earlier keep_line receipt in `reports` whose
// music comes back at another time now that later lines are placed (a later line joined its dip).
function refreshEarlier(document, reports, current) {
  for (const report of reports?.values() ?? []) {
    // Each line's `dips`, as the song now plays (a later line chained on, or shared its dip).
    const chain = report?.[CHAIN];
    const chainScene = chain && document.scenes.find((item) => item.id === chain.sceneId);
    const chainMusic = chainScene?.layers.find((item) => item.id === chain.musicId);
    if (chainMusic) {
      const said = dipChain(chainScene, chainMusic, chain.start, chain.end);
      if (said) report.dips = said;
      else delete report.dips;
    }
    const link = report?.[RETURN];
    if (!link || report === current) continue;
    const scene = document.scenes.find((item) => item.id === link.sceneId);
    const musicLayer = scene?.layers.find((item) => item.id === link.musicId);
    if (!musicLayer) continue;
    const ups = (musicLayer.animations ?? []).filter((animation) => animation.name === DUCK_NAMES.up && animation.start + animation.duration >= link.end - 0.01);
    const upAt = ups.length ? round(Math.min(...ups.map((animation) => animation.start + animation.duration))) : null;
    const under = volumeAt(musicLayer, (link.start + link.end) / 2);
    if (upAt === null || (Math.abs(upAt - link.at) <= 0.02 && Math.abs(under - link.under) <= 0.001)) continue;
    // A later line's own dip follows on from this one (duck_audio chained them): this line keeps its level.
    const next = (musicLayer.animations ?? []).filter((animation) => animation.name === DUCK_NAMES.down && animation.start > link.start + 0.01 && animation.start < upAt
      && Math.abs((animation.from?.volume ?? -1) - under) <= 0.001).sort((a, b) => a.start - b.start)[0];
    if (next && Math.abs(under - link.under) <= 0.001) {
      report.notes[link.index] = `the next line's own dip follows on: the music goes from ${round(under)} to ${next.to?.volume} at ${round(next.start)}-${round(next.start + next.duration)} s instead of coming back up (each line keeps its own dip; full again by ${upAt} s)`;
      const own = duckPairs(musicLayer).find((item) => item.start < link.end && item.end > link.start);
      const said = own ? `ducked to ${round(under)} at ${round(own.start)}-${round(Math.min(own.end, scene.duration))} s` : null;
      if (said && report.duck && typeof report.duck.summary === "string") report.duck = { ...report.duck, summary: report.duck.summary.replace(/ducked to [\d.]+ at [\d.]+-[\d.]+ s/, said) };
      if (said && typeof report.summary === "string") report.summary = report.summary.replace(/ducked to [\d.]+ at [\d.]+-[\d.]+ s/, said);
      link.at = upAt;
      continue;
    }
    const bed = under > 0.001 && link.under <= 0.001 ? `; the music holds a bed at ${round(under)} under the lines instead of going out` : "";
    report.notes[link.index] = `a later line in this edit shares this line's dip: the music is back by ${upAt} s (${round(upAt - link.end, 1)} s after the line)${bed}`;
    // The dip as it now plays under this line (a later line moved its end or raised it to a bed).
    const pair = duckPairs(musicLayer).find((item) => item.start < link.end && item.end > link.start);
    const dipSaid = pair ? `ducked to ${round(under)} at ${round(pair.start)}-${round(Math.min(pair.end, scene.duration))} s` : null;
    const restate = (text) => (dipSaid ? text.replace(/ducked to [\d.]+ at [\d.]+-[\d.]+ s/, dipSaid) : text);
    if (report.duck && typeof report.duck === "object") report.duck = { ...report.duck, to: round(under), ...(typeof report.duck.summary === "string" ? { summary: restate(report.duck.summary) } : {}) };
    if (typeof report.summary === "string") report.summary = restate(report.summary);
    if (bed) report.notes = bedWording(report.notes, round(under));
    if (report.mix && Number.isFinite(link.bedFull)) {
      const total = round(powerSum(report.mix.line, link.bedFull + db(under / link.level)), 1);
      report.mix = { ...report.mix, under: total, change: round(total - report.mix.around, 1) };
      report.summary = report.summary.replace(/mix under the line -?[\d.]+ vs -?[\d.]+ LUFS in the 2 s around \([+-]?[\d.]+ LU\)$/, `mix under the line ${total} vs ${report.mix.around} LUFS in the 2 s around (${report.mix.change >= 0 ? "+" : ""}${report.mix.change} LU)`);
    }
    link.at = upAt;
    link.under = under;
  }
}

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
  // The music as it plays without the dips duck_audio is about to replace (fit_music's fades too,
  // which an earlier dip set to its level).
  const base = withoutDips(musicLayer);
  const sides = [heardLoudness(musicCurve, base, range, start - AROUND, start), heardLoudness(musicCurve, base, range, end, end + AROUND)].filter((value) => value !== null);
  const measured = {
    line: round(raw + 20 * Math.log10(Math.max(1e-6, owner.volume)), 1),
    around: sides.length ? round(energyMean(sides), 1) : null,
    under: heardLoudness(musicCurve, base, range, start, end),
    // The song's loudest moment in the scene, untouched: the line's headroom is measured to it (lineWays).
    ceiling: loudestHeard(musicCurve, base, range),
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
function returnTime(scene, musicLayer, analysis, end, dropout, wait, sections = []) {
  const range = mediaPlaybackRange(musicLayer, scene.duration);
  if (!range || range.remapped) return null;
  const open = (time) => time < Math.min(scene.duration, range.end) - 0.01;
  const hasBeats = Array.isArray(analysis?.beats) && analysis.beats.length > 0;
  const spacing = hasBeats ? analysis.beats.slice(1).map((time, index) => time - analysis.beats[index]).filter((gap) => gap > 0).sort((a, b) => a - b) : [];
  const limit = Number.isFinite(wait) ? wait : spacing.length ? 2 * spacing[Math.floor(spacing.length / 2)] : SECTION_REACH;
  // dropout: a section cue (drop, chorus...) after the line's last word and within `wait` is where the
  // music comes back, so the song's change lands right after the line (a reference edit cut the music
  // out under one word and landed the drop 0.24 s after it).
  const cue = dropout ? sections.find((item) => item.time >= end - 0.001 && item.time - end <= limit + 1e-6 && open(item.time)) : null;
  if (cue) return { at: round(cue.time), kind: "section", name: String(cue.name) };
  if (!hasBeats) return null;
  const inScene = (time) => range.start + (time - range.offset);
  const earliest = end + (dropout ? DOWN_PAD : MIN_RELEASE);
  const nextBeat = analysis.beats.map(inScene).find((time) => time >= earliest);
  if (!dropout) return nextBeat !== undefined && open(nextBeat) ? { at: round(nextBeat) } : null;
  // dropout: the downbeat when it comes within `wait` of the line (default half a bar), else the next beat.
  // The silence a human cut left before the music came back was 0.22 s (a reference edit); a downbeat
  // 1.9 s later (run 8) left the line in a hole.
  const down = (barLines(analysis)?.lines ?? []).map(inScene).find((time) => time >= earliest);
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
      // A release a section cue cut short (duck_audio upBy) starts inside the line; it still ends after it.
      if (animation.name === DUCK_NAMES.up && animation.start + animation.duration >= end - 0.01 && animation.start < at) {
        animation.start = round(Math.max(animation.start, at - HIT_IN));
        animation.duration = Math.max(SHORTEST, round(at - animation.start));
      }
}

// keep_line {sound}: the classifier's events in the clip (operation.events, file seconds, put in by
// the agent service from soundEvents at SOUND_LISTED), as the layer plays them: [{label, sure, db,
// start, end}] in scene seconds, under 0.1 s played left out.
function playedSounds(scene, layer, events) {
  const played = [];
  for (const piece of checkSpeechLayer(scene, layer, "keep_line")) {
    const range = mediaPlaybackRange(piece, scene.duration);
    if (!range) continue;
    const fileEnd = range.offset + range.duration;
    for (const event of events) {
      const from = Math.max(event.start, range.offset), to = Math.min(event.end, fileEnd);
      if (to - from >= 0.1) played.push({ ...event, start: round(range.start + from - range.offset), end: round(range.start + to - range.offset) });
    }
  }
  return played;
}

// "laugh" finds laughter and belly_laugh, "walking" person_walking: the whole label or the start of one of its words.
const soundMatches = (label, key) => matchKey(label) === key || String(label).split(/[_\s]+/).some((word) => matchKey(word).startsWith(key));
const soundName = (event) => `${String(event.label).replaceAll("_", " ")} ${round(event.start, 1)}-${round(event.end, 1)} s`;

/** The sound keep_line {sound} keeps: the loudest match ({label, sure, db, start, end, note?}). */
function keptSound(scene, layer, operation) {
  const key = typeof operation.sound === "string" ? matchKey(operation.sound) : "";
  if (!key) fail('sound is a sound the clip readout lists, for example "laughter".');
  if (!Array.isArray(operation.events)) fail(`${layer.name}'s sounds are not measured here (${operation.eventsWhy ?? "no sound classifier on this computer"}); give from and to.`);
  const played = playedSounds(scene, layer, operation.events);
  // Sure events first (SOUND_SURE); else any the classifier listed, and the note says how sure.
  const sure = played.filter((event) => event.sure >= SOUND_SURE);
  const found = sure.filter((event) => soundMatches(event.label, key));
  const matches = found.length ? found : played.filter((event) => soundMatches(event.label, key));
  if (!matches.length) {
    // As the readout names them (soundMoments): several names of one moment take one place.
    const heard = soundMoments(sure.length ? sure : played);
    fail(`no "${operation.sound}" heard where ${layer.name} plays. ${heard.length ? `Heard there: ${heard.slice(0, 4).map((moment) => `${moment.name} ${round(moment.start, 1)}-${round(moment.end, 1)} s`).join(", ")}${heard.length > 4 ? ", …" : ""}. Give one of those, or from and to.` : "No sound was classified there; give from and to."}`);
  }
  const [best, ...others] = [...matches].sort((a, b) => b.db - a.db);
  const notes = [];
  if (!found.length) notes.push(`the classifier was ${best.sure} sure of ${best.label} (under ${SOUND_SURE}): listen before you keep it`);
  if (others.length) notes.push(`also heard ${others.slice(0, 2).map(soundName).join(", ")}; from/to keeps that one`);
  return { label: best.label, sure: best.sure, db: best.db, start: best.start, end: best.end, ...(notes.length ? { note: notes.join("; ") } : {}) };
}

/**
 * How far the music under a kept sound drops so the sound is not masked (dB, 0 or less): the
 * music LINE_OVER_BED LU under the sound as measured (the same 6 LU voice_under_bed uses), no
 * deeper than -20 dB. 0 when the sound already stands that far over it.
 */
function soundRoom({ line, under }) {
  if (!Number.isFinite(line) || !Number.isFinite(under)) return 0;
  return round(Math.max(-20, Math.min(0, line - LINE_OVER_BED - under)), 1);
}

/**
 * keep_line evens the line's own loud and quiet words toward its median word (mixLevels.js
 * lineEvening, measured on the clip's curve): "Line level" Volume ramps of EVEN_RAMP s on the owner
 * piece, and a leveled line's voiceLevel moves by the shift so the line as a whole stays where it was
 * set. Returns {median, spread, places: [[start, end, dB]] (scene s)} or null (fewer than 3 measured words).
 * A clip played as a bed (volume under BED_VOLUME: the export does not level it) is evened only when
 * `forced` (even:true): its words are measured and `bed` gives how many places it would even.
 */
function evenLine(scene, owner, said, start, end, curve, forced) {
  const { piece, play, volume } = owner;
  const inPiece = said.filter((word) => word.start >= play.start - 0.001 && word.end <= play.end + 0.001 && word.end > word.start);
  if (!curve || inPiece.length < 3) return null;
  const shift = inPiece[0].start - mediaSoundTime(piece, inPiece[0].start);
  const evening = lineEvening(curve, inPiece.map((word) => ({ start: mediaSoundTime(piece, word.start), end: mediaSoundTime(piece, word.end) })));
  if (!evening) return null;
  if (!forced && !leveledVoice({ volume })) return { median: evening.median, spread: evening.spread, places: [], bed: evening.places.length };
  const ranges = keptRanges(piece);
  const opens = ranges.some((range) => Math.abs(range.start - start) < 0.002);
  const closes = ranges.some((range) => Math.abs(range.end - end) < 0.002) && end + DOWN_PAD < scene.duration - 0.002;
  const ramp = (from, to, a, b) => piece.animations.push({ id: uid(), name: LINE_NAMES.level, kind: "custom", easing: "smooth", start: round(from), duration: Math.max(SHORTEST, round(to - from)), from: { volume: a }, to: { volume: b } });
  const places = [];
  for (const place of evening.places) {
    const [from, to] = [round(place.start + shift), round(place.end + shift)];
    const level = round(volume * 10 ** (place.db / 20), 3);
    // A word at the line's start rises from silence to its own level in the Line up's time (the ramp starts just after it, so it wins).
    if (opens && from - EVEN_RAMP / 2 <= start + 0.001) ramp(Math.max(0, start - UP_PAD) + 0.001, start, 0, level);
    else ramp(from - EVEN_RAMP / 2, from + EVEN_RAMP / 2, volume, level);
    if (closes && to + EVEN_RAMP / 2 >= end - 0.001) ramp(end + 0.001, end + DOWN_PAD, level, 0);
    else if (to + EVEN_RAMP / 2 < end - 0.001 || !closes) ramp(to - EVEN_RAMP / 2, to + EVEN_RAMP / 2, level, volume);
    places.push([from, to, place.db]);
  }
  // The export levels the line from its raw curve: the target moves by the shift so the line's loudness stays.
  // A gain stage (voiceLift) may sit over 0 LUFS before a volume under 1, and grows by a raised target.
  const lifted = Number.isFinite(piece.voiceLift);
  if (places.length && Number.isFinite(piece.voiceLevel)) piece.voiceLevel = round(Math.max(-60, Math.min(lifted ? GAIN_STAGE_MAX_DB : 0, piece.voiceLevel - evening.shift)), 1);
  if (places.length && lifted && evening.shift < 0) piece.voiceLift = round(Math.min(60, piece.voiceLift - evening.shift), 1);
  return { median: evening.median, spread: evening.spread, places, shift: evening.shift };
}

// A receipt's hidden link to the line's ways and the way taken, so the agent service's peak cap
// (backend/line-peak.mjs) rewrites the receipt's numbers after it lowers the line.
const LEVELS = Symbol("keep_line levels");
const MIX_TAIL = /mix under the (line|sound) -?[\d.]+ vs -?[\d.]+ LUFS in the 2 s around \([+-]?[\d.]+ LU\)/;

/**
 * The receipt of a keep_line whose line came down `db` (negative) after it was placed (the peak cap):
 * mix.line, mix.under, the summary, the way taken in `ways` and the way note give the line as it now
 * plays. True when something was rewritten.
 */
export function lowerKeptLine(receipt, db) {
  if (!receipt || !(db < 0)) return false;
  const signed = (value) => `${value >= 0 ? "+" : ""}${value}`;
  let changed = false;
  if (Number.isFinite(receipt.mix?.line) && Number.isFinite(receipt.mix?.under)) {
    // The bed under the line is what the total holds besides the line; it does not move.
    const bedEnergy = Math.max(0, 10 ** (receipt.mix.under / 10) - 10 ** (receipt.mix.line / 10));
    const line = round(receipt.mix.line + db, 1);
    const under = round(10 * Math.log10(10 ** (line / 10) + bedEnergy), 1);
    const change = Number.isFinite(receipt.mix.around) ? round(under - receipt.mix.around, 1) : receipt.mix.change;
    receipt.mix = { ...receipt.mix, line, under, change };
    if (typeof receipt.summary === "string") receipt.summary = receipt.summary.replace(MIX_TAIL, (_, what) => `mix under the ${what} ${under} vs ${receipt.mix.around} LUFS in the 2 s around (${signed(change)} LU)`);
    changed = true;
  }
  const link = receipt[LEVELS];
  if (link?.ways && typeof receipt.ways === "string") {
    const key = link.way === "lift" ? "lift" : link.way === "dip" || link.way === "shared" ? "dip" : link.way === "out" ? "out" : null;
    const taken = key ? link.ways[key] : null;
    if (taken) {
      const lowered = { ...taken, reach: round(taken.reach + db, 1) };
      // Headroom is the song's loudest moment over the line and the bed together: the bed's share stays.
      const headroom = () => {
        if (taken.headroom === null || taken.headroom === undefined) return taken.headroom ?? null;
        const bed = taken.reach - taken.over; // the song under the line (LUFS)
        const before = 10 * Math.log10(10 ** (taken.reach / 10) + 10 ** (bed / 10));
        const after = 10 * Math.log10(10 ** (lowered.reach / 10) + 10 ** (bed / 10));
        return round(taken.headroom + before - after, 1);
      };
      if (key !== "out") Object.assign(lowered, { db: round(taken.db + db, 1), over: round(taken.over + db, 1), headroom: headroom() });
      if (key === "lift") Object.assign(lowered, { factor: Math.round(10 ** (lowered.db / 20) * 100) / 100, short: round(Math.max(0, LINE_OVER_BED - lowered.over), 1) });
      const note = Number.isInteger(link.note) ? receipt.notes?.[link.note] : null;
      if (typeof note === "string" && key !== "out")
        receipt.notes[link.note] = note.replace(`${taken.reach} LUFS, ${signed(taken.over)} LU over`, `${lowered.reach} LUFS, ${signed(lowered.over)} LU over`)
          .replace(`x${taken.factor} to`, `x${lowered.factor ?? taken.factor} to`)
          .replace(`the line at ${taken.reach} LUFS`, `the line at ${lowered.reach} LUFS`)
          .replace(Number.isFinite(taken.headroom) ? `, ${Math.abs(taken.headroom)} dB ${taken.headroom >= 0 ? "under" : "over"} the song's loudest moment` : /^$^/, `, ${Math.abs(lowered.headroom)} dB ${lowered.headroom >= 0 ? "under" : "over"} the song's loudest moment`);
      link.ways = { ...link.ways, [key]: lowered };
      receipt.ways = waysText(link.ways, link.level);
      changed = true;
    }
  }
  return changed;
}

/** Applies keep_line to `document` (changed in place). Returns the receipt. */
export function applyKeepLine(document, operation, { fonts, reports } = {}) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  if (!layer) fail(`layer ${operation.layerId} was not found.`);
  if ((layer.type !== "audio" && layer.type !== "video") || !layer.src) fail(`"${layer.name}" is a ${layer.type} layer; give the audio or video layer that plays the clip.`);
  const timed = operation.from !== undefined || operation.to !== undefined;
  const bySound = operation.sound !== undefined;
  if (bySound && (operation.line !== undefined || timed)) fail("give one of sound (a sound the clip readout lists), line, or from and to.");
  if (operation.line !== undefined && timed) fail("give line (words said in the clip) or from and to (scene seconds), not both.");
  if (operation.line === undefined && !timed && !bySound) fail("give line (words said in the clip) or from and to (scene seconds).");
  if (operation.line !== undefined && (typeof operation.line !== "string" || !operation.line.trim())) fail("line is the words to keep, as said.");
  if (operation.text !== undefined && (typeof operation.text !== "string" || !operation.text.trim())) fail("text is the subtitle's words, a string.");
  if (operation.dip !== undefined && (typeof operation.dip !== "number" || !(operation.dip >= 0 && operation.dip <= 1))) fail("dip is the music's volume under the line, a number from 0 to 1.");
  // A voice cut into pieces (cut_speech) is one sound: the line may play on any piece, and every piece is silenced around it.
  const plays = speechPieces(scene, layer).map((piece) => ({ piece, play: mediaPlaybackRange(piece, scene.duration) })).filter((entry) => entry.play);
  if (!plays.length) fail(`"${layer.name}" does not play inside this scene.`);
  const range = { start: Math.min(...plays.map((entry) => entry.play.start)), end: Math.max(...plays.map((entry) => entry.play.end)) };

  // The words the scene plays, as captions read them (none when the clip was not transcribed or has none).
  // A sound tag glued to a word ("see.(laughs)") is left out, as clipLines shows the line.
  const spoken = operation.transcript?.words?.length ? speechWords(scene, checkSpeechLayer(scene, layer, "keep_line"), operation.transcript) : [];
  // Each word keeps the transcript's probability (p), for the unsure-words note below.
  const heard = spoken.length
    ? captionWordsFromSpeech(spoken.map((word) => ({ ...word, text: withoutGluedTag(word.text) || word.text }))).words
      .map((word) => ({ ...word, p: spoken.find((item) => Math.abs(item.start - word.start) < 1e-6)?.p ?? 1 })) : [];
  let start;
  let end;
  let said;
  let lineNote = null;
  let sound = null;
  if (bySound) {
    sound = keptSound(scene, layer, operation);
    ({ start, end } = sound);
    said = [];
    if (sound.note) lineNote = sound.note;
  } else if (operation.line !== undefined) {
    if (!heard.length) fail(`"${layer.name}" has no words heard to find "${operation.line}" in; give from and to (scene seconds) and text instead.`);
    const match = findLine(heard, operation.line);
    if (!match) fail(`"${operation.line}" is not said in ${layer.name} in this scene. Heard there: ${heardLines(heard)}. Give one of those, or from and to (scene seconds) and text.`);
    const found = match.words;
    if (match.note) lineNote = match.note;
    start = found[0].at;
    end = found.at(-1).end;
    said = found.map((item) => ({ text: item.text, start: item.at, end: item.end, p: heard.find((word) => word.start === item.at)?.p ?? 1 }));
  } else {
    for (const key of ["from", "to"]) if (typeof operation[key] !== "number" || !Number.isFinite(operation[key])) fail(`${key} is seconds on the scene's clock, a number.`);
    start = Math.max(operation.from, range.start);
    end = Math.min(operation.to, range.end);
    if (!(end - start >= 0.1)) fail(`from ${operation.from} to ${operation.to} is under 0.1 s of what "${layer.name}" plays (${round(range.start)} to ${round(range.end)} s).`);
    said = heard.filter((item) => item.start >= start - 0.01 && item.start < end);
  }
  start = round(start);
  end = round(end);

  // When the next kept line in the scene starts (before this one joins a close one): its subtitle's limit.
  const nextLine = Math.min(Infinity, ...scene.layers.flatMap((item) => ((item.animations ?? []).some(isLineMark) ? keptRanges(item) : []))
    .map((item) => item.start).filter((time) => time > end + 0.001));
  // The sound: only the kept stretches (an earlier keep_line's too) at the layer's own volume.
  // Each piece keeps the part of the line it plays; a piece that plays none is silent.
  const kept = plays.map(({ piece, play }) => {
    const from = Math.max(start, play.start);
    const to = Math.min(end, play.end);
    const volume = piece.volume > 0 ? piece.volume : 1;
    const ranges = merged([...keptRanges(piece), ...(to - from > SHORTEST ? [{ start: from, end: to, ...(sound ? { sound: true } : {}) }] : [])]);
    piece.volume = volume;
    // An earlier line's "Line level" ramps stay; this line's are made again below.
    const earlierLevel = (animation) => animation.name === LINE_NAMES.level && (animation.start + animation.duration < start - UP_PAD - 0.01 || animation.start > end + DOWN_PAD + 0.01);
    piece.animations = [...(piece.animations ?? []).filter((animation) => !isLineMark(animation) || earlierLevel(animation)), ...silenceAround(ranges, volume, scene.duration)];
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
  let standing = null;
  const name = operation.name ?? `line-at-${round(start, 1)}s`;
  // A subtitle already shown over the line (made by hand, or by an earlier keep_line with text) stays
  // when no words are given: the transcript's words would replace words someone chose.
  const titled = operation.subtitle !== false && !(sound && operation.text === undefined);
  const groups = titled ? captionGroups(scene, start, end) : [];
  const shownOver = subtitlesOver(groups, said);
  const asIs = operation.text === undefined && operation.name === undefined ? shownOver[0] : null;
  if (asIs) {
    standing = asIs;
    const quote = asIs.text.length > 60 ? `${asIs.text.slice(0, 60)}...` : asIs.text;
    notes.push(`the subtitle ${asIs.name} ("${quote}") already shows over this line, so it stays and no new one is made; ${asIs.change}`);
  } else if (titled) {
    const look = operation.look ?? "subtitle";
    const others = shownOver.filter((item) => item.name !== name);
    if (others.length) notes.push(`the subtitle ${others[0].name} ("${others[0].text.slice(0, 60)}") also shows over this line; ${others[0].change} instead`);
    // Captions of other words (another voice's track) on screen at the same time: named, left as they are.
    const track = groups.find((group) => group.over.length && group.group && group.name !== name && !shownOver.some((item) => item.name === group.name));
    if (track) notes.push(`the caption group ${track.name} ("${track.over.map((item) => item.text).join(" ").slice(0, 60)}", other words than heard here) also show over this line; subtitle:false keeps them alone`);
    // The next line or another subtitle that comes on after this line: this subtitle is down 2 frames before it.
    const nextOn = Math.min(nextLine, ...groups.filter((group) => group.name !== name).flatMap((group) => group.starts).filter((time) => time > end + 0.001));
    if (operation.text !== undefined) {
      // A page stays up long enough to read (20 characters a second, 5/6 s at least), past the line when it is short.
      const readEnd = Math.min(scene.duration, round(Math.max(end, start + Math.max(operation.text.length / 20, 5 / 6) + 0.02)));
      const into = readEnd > nextOn - CAPTION_GAP + 0.001 ? `, into what comes on at ${round(nextOn)} s (the next line or subtitle)` : "";
      if (readEnd > end) notes.push(`the subtitle stays up to ${readEnd} s so it can be read${into}`);
      subtitle = applyAddCaptions(document, { type: "add_captions", sceneId: scene.id, text: operation.text, format: "text", start, end: readEnd, look, name }, { fonts });
    }
    else if (said.length) {
      // The pages stay inside the kept stretch: past its end only through the line's fade down, and
      // not into the next kept line or subtitle; a page too short to read starts earlier instead (captionPaging pageWords).
      const until = round(Math.min(scene.duration, Math.max(end, Math.min(end + DOWN_PAD, nextOn - CAPTION_GAP))));
      subtitle = applyAddCaptions(document, { type: "add_captions", sceneId: scene.id, words: said, look, name }, { fonts, span: { start, end: until } });
      // Few or unsure words (the clip readout's own bar for a line: LINE_SURE, LOW_CONFIDENCE): the words used and how sure.
      const mean = said.reduce((sum, item) => sum + (item.p ?? 1), 0) / said.length;
      if (said.length < 2 || mean < LINE_SURE || said.some((item) => (item.p ?? 1) < LOW_CONFIDENCE)) {
        const shown = said.slice(0, 6).map((item) => `${item.text} p ${round(item.p ?? 1, 2)}`).join(", ");
        notes.push(`the subtitle shows ${said.length === 1 ? "the 1 word" : `the ${said.length} words`} the transcript heard there (${shown}${said.length > 6 ? ", ..." : ""}; a clip line needs 2 or more words at mean p ${LINE_SURE}); if the clip says other words, text:"<the words said>" puts them on the subtitle`);
      }
    }
    else notes.push("no words were heard in that stretch, so there is no subtitle: give text (what is said) to add one");
  }

  // The music dips under the kept stretches only (the words of the other speech are silent now).
  const music = musicOf(scene, layer, operation);
  if (operation.dropout !== undefined && typeof operation.dropout !== "boolean") fail("dropout is true (the music leaves for the line and comes back on the next downbeat) or false.");
  if (operation.wait !== undefined && (typeof operation.wait !== "number" || !(operation.wait >= 0 && operation.wait <= 4))) fail("wait is how many seconds the music may stay out for the next downbeat, 0 to 4 (default half a bar; past it the music hits back on the next beat).");
  if (operation.lift !== undefined && typeof operation.lift !== "boolean" && operation.lift !== "gain") fail("lift is true (the song stays untouched and the line is lifted over it), \"gain\" (the same, past the lift cap by a gain stage on this line, the limiter after it) or false.");
  const lifting = operation.lift === true || operation.lift === "gain";
  // A given dip or dropout is kept as given; lift:true beside it is set aside, and a note says so.
  if (lifting && (operation.dip !== undefined || operation.dropout === true)) notes.push(`lift:${JSON.stringify(operation.lift)} is set aside: the ${operation.dropout === true ? "dropout" : "dip"} given takes the music down under the line`);
  // A gain stage an earlier keep_line set on these pieces goes when it was this line's (lift:"gain"
  // sets it again below); another kept line on the layer keeps it, so that line stays where it was set.
  const otherLine = kept.some((entry) => entry.ranges.some((range) => !range.sound && (range.end < start - 0.01 || range.start > end + 0.01)));
  if (!otherLine) for (const entry of kept) {
    delete entry.piece.voiceLift;
    // A level over 0 LUFS (before a volume under 1) is reached only through a gain stage.
    if (entry.piece.voiceLevel > 0) entry.piece.voiceLevel = 0;
  }
  let gainSaid = null;
  let duck = null;
  let mix = null;
  // The line's level over the song each way (lineWays), for the receipt.
  let waysSaid = null;
  // The bed between lines that share a dip, the measured rise where the song comes back on a section
  // cue, and the hidden link a later keep_line in this edit uses to rewrite this line's return note.
  let bedSaid = null;
  let dropSaid = null;
  let chainSaid = null;
  let chainLink = null;
  let returnLink = null;
  let levelsLink = null;
  if (music.layer) {
    const level = music.layer.volume ?? 1;
    // Over measured music: the line is leveled against the music around it and the dip holds the
    // mix (mixLevels.js lineOverMusic); the old fixed 0.7 dip and -16 LUFS line stay without measurements.
    let over = lineOverMusicAt(scene, owner, music.layer, start, end, operation);
    // A kept sound keeps its own level (no leveling to the line target); with no dip or dropout given,
    // the music makes room only as far as the measured sound would be masked (soundRoom).
    if (sound && over) {
      const room = operation.dip === undefined && operation.dropout === undefined ? soundRoom(over.measured) : null;
      over = { ...over, own: true, short: undefined, dipDb: room ?? over.dipDb };
    }
    // A line the +12 dB lift cannot bring to the music (a dip would dig a hole the line cannot fill):
    // with no dip or dropout given, the music goes out under it. The note says what each choice costs.
    // The line over the song each way kino can do it, measured (mixLevels.js lineWays): the song
    // untouched with the line lifted, the shallowest dip with the lift, the music out.
    const ways = over && !over.own ? lineWays(over.measured) : null;
    const asked = operation.dip !== undefined || operation.dropout !== undefined;
    // lift:true keeps the song untouched, measured or not (unmeasured, the line plays at its own level).
    const untouched = lifting && !asked;
    // The way taken: lift (song untouched) when asked, or by default when the lift alone reaches
    // the aim within the headroom; else the shallowest dip that reaches it with the lift.
    // lift:"gain" on a line the lift leaves short: the gain stage (ways.gain).
    let way = untouched ? (ways ? (operation.lift === "gain" && ways.gain ? "gain" : "lift") : null) : !asked && !sound && ways ? (ways.lift.short === 0 ? "lift" : ways.dip ? "dip" : null) : null;
    if (untouched && !ways) notes.push(`song untouched (lift:${JSON.stringify(operation.lift)}); the ${sound ? "sound keeps its own level" : "line or the music is not measured, so the line plays at its own level"}`);
    if (untouched && ways && operation.lift === "gain" && !ways.gain) notes.push("no gain stage: the lift alone reaches the aim, so lift:\"gain\" works as lift:true");
    // The gain stage measured on this line's own file: its level and the noise under its words, before
    // (as it plays) and after the gain. Null without a curve.
    const lineCurve = operation.levels?.[owner.piece.id];
    const lineSpan = [{ start: mediaSoundTime(owner.piece, start), end: mediaSoundTime(owner.piece, end) }];
    const noiseRaw = ways?.gain && lineCurve ? noiseUnder(lineCurve, lineSpan) : null;
    const gainStage = ways?.gain ? {
      db: ways.gain.db,
      line: [over.measured.line, ways.gain.reach],
      ...(noiseRaw !== null ? { noise: [round(noiseRaw + 20 * Math.log10(Math.max(1e-6, volume)), 1), round(noiseRaw + 20 * Math.log10(Math.max(1e-6, volume)) + ways.gain.db, 1)] } : {}),
    } : null;
    const gainWords = (stage) => `a +${stage.db} dB gain stage on this line only (x${Math.round(10 ** (stage.db / 20) * 100) / 100}): the line ${stage.line[0]} -> ${stage.line[1]} LUFS${stage.noise ? `, the noise under it ${stage.noise[0]} -> ${stage.noise[1]} LUFS` : ""}`;
    let out = operation.dropout === true;
    let tooQuiet = null;
    if (!way && !untouched && !out && !asked && over?.short) {
      tooQuiet = over;
      out = true;
      over = lineOverMusicAt(scene, owner, music.layer, start, end, { ...operation, dropout: true }) ?? over;
    }
    const wayDip = () => (way === "dip" ? round(Math.max(0, Math.min(level, level * 10 ** (ways.dip.dipDb / 20)))) : level);
    // Music out under the line (dropout, or a line no dip can hold): a bed LINE_OVER_BED LU under the
    // line as leveled, measured, down to BED_LOWEST; dip (0 for none) given with dropout:true sets it.
    const outBed = out && operation.dip === undefined && Number.isFinite(over?.heard) && Number.isFinite(over?.measured?.under)
      ? Math.max(BED_LOWEST, Math.min(0, over.heard - LINE_OVER_BED - over.measured.under)) : null;
    const dip = way ? wayDip() : untouched ? level : out ? (operation.dip ?? (outBed === null ? 0 : round(level * 10 ** (outBed / 20))))
      : operation.dip ?? (over ? round(Math.max(0, Math.min(level, level * 10 ** (over.dipDb / 20)))) : round(level * DEFAULT_DIP));
    const outSaid = !out ? null : dip > 0.001
      ? `the music at a bed of ${dip} under the line (${round(db(dip / level), 1)} dB${outBed === null ? ", given" : `: ${outBed <= BED_LOWEST ? `held at ${BED_LOWEST} dB, the lowest bed still heard (a starting guess)` : `${LINE_OVER_BED} LU under the line, measured`}`}); dropout:true with dip:0 takes it out`
      : "music out under the line";
    if (dip > level) notes.push(`dip ${dip} is above the music's volume ${level}, so the music gets louder under the line`);
    // The line leveled for the way taken (lift or dip), its mix and one note; a second call (the
    // default dip would churn) replaces the note.
    let wayNote = -1;
    const signed = (value) => `${value >= 0 ? "+" : ""}${value}`;
    const wayLevel = (chosen, why = "") => {
      const taken = chosen === "dip" ? ways.dip : chosen === "gain" ? ways.gain : ways.lift;
      // A gain stage on a clip under volume 1 (a bed) levels the file past 0 LUFS before that volume.
      owner.piece.voiceLevel = round(Math.max(-60, Math.min(chosen === "gain" ? GAIN_STAGE_MAX_DB : 0, taken.reach - 20 * Math.log10(Math.max(1e-6, volume)))), 1);
      for (const entry of kept) if (entry !== owner) entry.piece.voiceLevel = owner.piece.voiceLevel;
      // The gain stage: the export may lift these pieces' kept stretches this far (mixLevels.js liftCap);
      // one another line on the layer kept stays when it is larger.
      if (chosen === "gain") for (const entry of kept) entry.piece.voiceLift = Math.max(entry.piece.voiceLift ?? 0, Math.min(GAIN_STAGE_MAX_DB, Math.ceil(ways.gain.db * 10) / 10 + 0.1));
      const bed = over.measured.under + (chosen === "dip" ? ways.dip.dipDb : 0);
      const total = round(10 * Math.log10(10 ** (taken.reach / 10) + 10 ** (bed / 10)), 1);
      mix = { line: taken.reach, around: over.measured.around, under: total, change: round(total - over.measured.around, 1) };
      const room = (headroom) => (headroom === null ? "" : `, ${Math.abs(headroom)} dB ${headroom >= 0 ? "under" : "over"} the song's loudest moment`);
      const text = chosen === "gain"
        ? `song untouched: ${gainWords(gainStage)}, ${signed(taken.over)} LU over the song${room(taken.headroom)}; the master limiter after it`
        : chosen === "lift"
        ? `${why || "song untouched: "}the line is lifted x${ways.lift.factor} to ${taken.reach} LUFS, ${signed(taken.over)} LU over the song${ways.lift.short > 0 ? ` (${ways.lift.short} LU short of +${LINE_OVER_BED})` : ""}${room(ways.lift.headroom)}${gainStage ? `; lift:"gain" reaches ${signed(ways.gain.over)} LU: ${gainWords(gainStage)}, the master limiter after it` : ""}`
        : `the lift alone reaches ${signed(ways.lift.over)} LU over the song (${ways.lift.short} LU short of +${LINE_OVER_BED} within the headroom), so the shallowest dip that reaches it: dip ${dip} (${ways.dip.dipDb} dB) with the line at ${taken.reach} LUFS, ${signed(taken.over)} LU over`;
      if (chosen === "gain") gainSaid = gainStage;
      if (wayNote >= 0) notes[wayNote] = text;
      else wayNote = notes.push(text) - 1;
    };
    if (over?.own) {
      // Both levels as heard: the sound at its own level, the music under it before and after the dip.
      // A line kept earlier on the layer keeps its level (the export levels only the line stretches).
      for (const entry of kept) if (!entry.ranges.some((item) => !item.sound)) delete entry.piece.voiceLevel;
      const { line: own, under: bed, around } = over.measured;
      const dipDb = out ? -Infinity : 20 * Math.log10(Math.max(1e-6, dip / level));
      const total = round(10 * Math.log10(10 ** (own / 10) + (Number.isFinite(dipDb) ? 10 ** ((bed + dipDb) / 10) : 0)), 1);
      mix = { sound: own, music: bed, around, under: total, change: round(total - around, 1) };
      notes.push(`sound kept at its own ${own} LUFS over the music at ${bed} LUFS (${round(own - bed, 1)} LU); ${out ? "music out under it" : dip >= level ? `not masked (${LINE_OVER_BED} LU or more over it), so the music stays; dip:<0 to 1> or dropout:true makes room anyway` : `the music makes room: dip ${dip} (${round(dipDb, 1)} dB) puts it ${LINE_OVER_BED} LU under the sound`}`);
    } else if (over && way) {
      wayLevel(way);
    } else if (over) {
      // The export levels the kept line to this (before the layer's volume).
      owner.piece.voiceLevel = round(over.target - 20 * Math.log10(Math.max(1e-6, volume)), 1);
      for (const entry of kept) if (entry !== owner) entry.piece.voiceLevel = owner.piece.voiceLevel;
      const given = operation.dip !== undefined && !out ? lineOverMusic(over.measured, { dropDb: 20 * Math.log10(Math.max(1e-6, dip / level)) }) : over;
      // Music out with a bed under the line: the bed counts in the mix.
      const total = out && dip > 0.001 ? round(powerSum(given.heard, over.measured.under + db(dip / level)), 1) : given.total;
      const change = round(total - over.measured.around, 1);
      mix = { line: given.heard, around: over.measured.around, under: total, change };
      notes.push(`line leveled to ${given.heard} LUFS against the music around it (${over.measured.around}); ${out ? outSaid : `dip ${dip} (${round(given.dipDb, 1)} dB)`}`);
      if (tooQuiet) {
        // The cost of each choice, measured: the shortfall at the lift cap, and the dip that would hold the mix.
        const hold = Number.isFinite(tooQuiet.holdDb) ? round(level * 10 ** (tooQuiet.holdDb / 20), 3) : null;
        const buried = hold === null ? null : round(tooQuiet.measured.under + tooQuiet.holdDb - tooQuiet.heard, 1);
        notes.push(`the line is ${tooQuiet.short} LU short of the music at the +${MAX_LEVEL_DB} dB lift (it reaches ${tooQuiet.heard} LUFS, the music around it ${tooQuiet.measured.around}), so ${dip > 0.001 ? `a dip cannot hold it: the music sits at a bed of ${dip} under it` : "the music goes out under it"}`
          + (hold === null ? "" : `; dip:${hold} keeps the music in and holds the mix, the line ${buried} LU under the music`)
          + (gainStage ? `; lift:"gain" keeps the song untouched with ${gainWords(gainStage)}, ${signed(ways.gain.over)} LU over the song, the master limiter after it` : ""));
      }
    } else for (const entry of kept) delete entry.piece.voiceLevel;
    if (!over && !untouched && operation.dip === undefined && !operation.dropout) notes.push(`the music dips to ${dip} under the line (${DEFAULT_DIP} of its volume ${level}, about 3 dB; not measured); dip:<0 to 1> sets it`);
    // A kept sound the music does not mask: no dip at all.
    if (way !== "lift" && !untouched && !(over?.own && !out && dip >= level)) {
      // This line's own dip, at its own depth: duck_audio keeps the dips earlier lines made.
      const under = kept.filter((entry) => entry.play.start < end && entry.play.end > start);
      const speech = {};
      for (const { piece, play } of under)
        speech[piece.id] = { words: [{ text: "line", start: round(mediaSoundTime(piece, Math.max(start, play.start))), end: round(mediaSoundTime(piece, Math.min(end, play.end))), p: 1 }] };
      // The release ends on the song's next beat (dropout: the music hits back on the next downbeat).
      const back = returnTime(scene, music.layer, operation.beats?.[music.layer.id], end, out, operation.wait, sectionCues(document.cues));
      const fadeUp = back ? round(back.at - end) : undefined;
      // A default dip that would make the song churn (volume_churn: 3 turns in 10 s) is undone, and
      // the line is lifted over the untouched song instead (the receipt says so).
      const head = music.layer.fitMusic ?? music.layer.id;
      const songPieces = scene.layers.filter((item) => item.id === head || item.fitMusic === head);
      const before = songPieces.map((piece) => [piece, piece.animations]);
      const churnedBefore = churnRun(music.layer, scene);
      duck = applyDuckAudio(document, { type: "duck_audio", sceneId: scene.id, layerId: music.layer.id, under: under.map((entry) => entry.piece.id), to: dip, speech, ownLine: true, ...(operation.dip === undefined ? { payoffStop: true } : {}), ...(fadeUp !== undefined ? { fadeUp } : {}) });
      let churn = way === "dip" && !churnedBefore ? churnRun(music.layer, scene) : null;
      if (churn) {
        const spread = round(churn.at(-1).time - churn[0].time, 1);
        const turns = `a dip of its own here would turn ${music.layer.name}'s level ${churn.length} times in ${spread} s (volume_churn)`;
        // First the one dip it can share: the nearest earlier dip within JOIN_MAX_GAP joined to this
        // line's (as duck_audio's joined dip does), taken when the song then holds still.
        for (const [piece, animations] of before) piece.animations = animations;
        const near = earlierDips(songPieces.find((piece) => piece.id === head) ?? songPieces[0], scene.duration).map((dip) => ({ ...dip, gap: dip.end <= start ? start - dip.end : dip.start >= end ? dip.start - end : 0 }))
          .filter((dip) => dip.gap <= JOIN_MAX_GAP).sort((a, b) => a.gap - b.gap)[0];
        if (near) {
          duck = applyDuckAudio(document, { type: "duck_audio", sceneId: scene.id, layerId: music.layer.id, under: under.map((entry) => entry.piece.id), to: dip, speech, ownLine: true, payoffStop: true, join: round(near.gap + DUCK_FADES.down + 0.05), ...(fadeUp !== undefined ? { fadeUp } : {}) });
          churn = churnRun(music.layer, scene);
          if (churn) for (const [piece, animations] of before) piece.animations = animations;
          else {
            const shared = round(volumeAt(music.layer, (start + end) / 2));
            const overBed = round(ways.dip.reach - (over.measured.under + db(shared / level)), 1);
            notes[wayNote] = `${turns}, so the line shares the dip at ${round(near.start, 2)}-${round(near.end, 2)} s: one dip at ${shared} under both, the line at ${ways.dip.reach} LUFS, ${signed(overBed)} LU over the song there (measured)`;
            const total = round(powerSum(ways.dip.reach, over.measured.under + db(shared / level)), 1);
            mix = { ...mix, under: total, change: round(total - over.measured.around, 1) };
            way = "shared";
          }
        }
        if (churn) {
          duck = null;
          out = false;
          way = "lift";
          wayLevel("lift", `${turns.replace("a dip of its own here", "a dip here")}${near ? " (and sharing the dip next to it too)" : ""}, so the song stays untouched: `);
        }
      }
      if (duck?.payoff) notes.push(duck.payoff);
      if (out && back) hitBack(scene, music.layer, end, back.at);
      // Lines that share one music-out dip: a low bed between them, not silence (shareBed).
      const shared = out && duck ? shareBed(scene, music.layer, operation.levels, start, end, kept.map((entry) => entry.piece), dip <= 0.001) : null;
      if (shared) {
        notes.push(shared.note);
        if (shared.gap) bedSaid = { at: [shared.gap.start, shared.gap.end], bed: shared.bed ?? 0 };
        if (shared.bed) {
          duck = { ...duck, to: shared.bed, summary: duck.summary.replace(/ ducked to 0 at /, ` ducked to ${shared.bed} at `) };
          notes.splice(0, notes.length, ...bedWording(notes, shared.bed));
        }
        // The mix under this line with the bed in it.
        if (shared.bed && mix?.line !== undefined && Number.isFinite(over?.measured?.under)) {
          const total = round(powerSum(mix.line, over.measured.under + db(shared.bed / level)), 1);
          mix = { ...mix, under: total, change: round(total - mix.around, 1) };
        }
      }
      const musicOut = volumeAt(music.layer, (start + end) / 2) <= 0.001;
      // Where the music is back up in fact: a dip that ends by the song's drop (payoffStop) is back
      // before the beat returnTime planned, and the note says that time, not the plan.
      const ups = (music.layer.animations ?? []).filter((animation) => animation.name === DUCK_NAMES.up && animation.start + animation.duration >= end - 0.01);
      const upAt = ups.length ? round(Math.min(...ups.map((animation) => animation.start + animation.duration))) : null;
      const before0 = notes.length;
      if (back && out && back.kind === "section" && upAt !== null && Math.abs(upAt - back.at) <= 0.02) {
        // The rise the song's return makes at the cue, measured: the mix 0.4 s before and after it.
        const pieces = songOf(scene, music.layer);
        const line = mix ? { start, end, heard: mix.line ?? mix.sound } : null;
        const before = mixOver(operation.levels?.[music.layer.id], pieces, line, back.at - RISE_WINDOW, back.at);
        const after = mixOver(operation.levels?.[music.layer.id], pieces, line, back.at, back.at + RISE_WINDOW);
        const rise = before !== null && after !== null ? round(after - before, 1) : null;
        if (rise !== null) dropSaid = { at: back.at, cue: back.name, before, after, rise };
        notes.push(`the music stays ${musicOut ? "out" : "at its bed"} until the song's ${back.name} at ${back.at} s, ${round(back.at - end, 2)} s after the line's last word, and hits back on it${rise === null ? " (not measured)" : `: ${signed(rise)} LU there (${before} to ${after} LUFS, ${RISE_WINDOW} s each side, measured)`}`);
      } else if (back && out && upAt !== null && upAt < back.at - 0.02) notes.push(`the music ${musicOut ? "drops out for the line" : "sits at its bed under the line"} and is back by ${upAt} s (${Math.abs(round(upAt - end, 1))} s ${upAt >= end ? "after" : "before"} the line ends): the dip ends on the song's section cue there, not on the beat at ${back.at} s`);
      else if (back && out && back.kind === "beat") notes.push(`the music ${musicOut ? "drops out for the line" : "sits at its bed under the line"} and hits back on the beat at ${back.at} s (${round(back.at - end, 1)} s after the line${back.downbeat != null ? `; the downbeat at ${back.downbeat} s is ${round(back.downbeat - end, 1)} s after${back.downbeat - end <= 4 ? `: wait:${Math.min(4, Math.ceil((back.downbeat - end) * 10) / 10)} waits for it` : ""}` : ""})`);
      // A dip joined with one under another line stays down past the beat: the note says when it is back.
      else if (back && duck && !out && upAt !== null && upAt > back.at + 0.02) notes.push(`the music stays down with the dip under the next sound and comes back up at ${upAt} s (not on the beat at ${back.at} s)`);
      else if (back && duck && !out && upAt !== null && upAt < back.at - 0.02) notes.push(`the music is back up by ${upAt} s, ${Math.abs(round(upAt - end, 1))} s ${upAt >= end ? "after" : "before"} the line ends: the dip ends on the song's section cue there, not on the beat at ${back.at} s`);
      else if (back && duck) notes.push(out ? `the music ${musicOut ? "drops out for the line" : "sits at its bed under the line"} and hits back on the downbeat at ${back.at} s (${round(back.at - end, 1)} s after the line)` : `the music comes back up on the beat at ${back.at} s`);
      else if (out) notes.push("no beats measured on the music: it comes back over 0.8 s after the line");
      // A later keep_line in this edit that joins this dip rewrites this note (refreshEarlier).
      if (notes.length > before0 && duck && upAt !== null)
        returnLink = { sceneId: scene.id, musicId: music.layer.id, start, end, at: upAt, index: before0, under: volumeAt(music.layer, (start + end) / 2), level, bedFull: over?.measured?.under };
      if (duck && !out && operation.dip === undefined && over && !over.own) notes.push("dropout:true takes the music out under the line and hits back on the next downbeat");
      // The dips that follow on from one another around this line (each kept line its own level).
      chainSaid = dipChain(scene, music.layer, start, end);
      chainLink = { sceneId: scene.id, musicId: music.layer.id, start, end };
    }
    // A lift (asked, the default, or the churn fallback) replaces a dip an earlier keep_line left
    // under this line: that dip goes, unless it also holds another kept line or another heard sound
    // (a voice-over duck_audio dipped for), and the note names it.
    if ((way === "lift" || untouched) && !duck) {
      const { removed, stays } = removeDips(scene, music.layer, start, end, kept.map((entry) => entry.piece), operation.levels);
      for (const stay of stays) notes.push(`the dip at ${stay.at[0]}-${stay.at[1]} s under this line stays: ${stay.name} is heard in it too`);
      if (removed.length) notes.push(`the earlier dip${removed.length > 1 ? "s" : ""} at ${removed.map(([from, to]) => `${from}-${to} s`).join(", ")} under this line ${removed.length > 1 ? "are" : "is"} removed: the lift replaces ${removed.length > 1 ? "them" : "it"}`);
    }
    // The lift leaves the song as it is, but a dip an earlier line made may still hold it down under
    // this one (dm2-b replay): the ways are measured without it, so the note and the mix give the song as heard.
    if (way === "lift" && ways && mix?.line !== undefined && Number.isFinite(over?.measured?.under)) {
      const range = mediaPlaybackRange(music.layer, scene.duration);
      const heard = range ? heardLoudness(operation.levels?.[music.layer.id], music.layer, range, start, end) : null;
      if (heard !== null && heard < over.measured.under - 0.5) {
        const song = round(heard, 1);
        notes.push(`a dip already under this stretch holds ${music.layer.name} at ${song} LUFS (${round(song - over.measured.under, 1)} LU from its own ${over.measured.under}): the line is ${signed(round(mix.line - song, 1))} LU over the song as heard`);
        const total = round(10 * Math.log10(10 ** (mix.line / 10) + 10 ** (song / 10)), 1);
        mix = { ...mix, under: total, change: Number.isFinite(mix.around) ? round(total - mix.around, 1) : mix.change };
      }
    }
    if (ways) waysSaid = { ways: waysText(ways, level), way: way ?? (out ? "out" : "dip") };
    if (ways) levelsLink = { ways, level, way: waysSaid.way, note: wayNote >= 0 ? wayNote : null };
    if (operation.wait !== undefined && !out) notes.push("wait is ignored without dropout:true (it is how long the music stays out for the next downbeat)");
  } else {
    for (const entry of kept) delete entry.piece.voiceLevel;
    notes.push(`the music does not dip: ${music.reason}`);
  }

  // The line's own loud and quiet words, evened toward its median word (on unless even:false; a kept sound keeps its own level).
  if (operation.even !== undefined && typeof operation.even !== "boolean") fail("even is true (the line's loud and quiet words come toward its median word) or false (kept as said).");
  const even = !sound && operation.even !== false ? evenLine(scene, owner, said, start, end, operation.levels?.[owner.piece.id], operation.even === true) : null;
  if (even?.bed) notes.push(`not evened: ${layer.name} plays at volume ${owner.volume}, under ${BED_VOLUME}, ${Number.isFinite(owner.piece.voiceLevel) ? `a bed; the export levels the line to its voiceLevel ${owner.piece.voiceLevel}` : "a bed the export does not level"}; its words spread ${even.spread} LU (measured) and ${even.bed} ${even.bed === 1 ? "place is" : "places are"} over ${LINE_EVEN_LU} LU off its median word; even:true evens them`);
  if (even?.places.length) {
    const shown = even.places.slice(0, 3).map(([from, to, db]) => `${round(from, 2)}-${round(to, 2)} s ${db > 0 ? "+" : ""}${db} dB`).join(", ");
    notes.push(`evened ${even.places.length} ${even.places.length === 1 ? "place" : "places"} toward the line's median word (${even.median} LUFS; its words spread ${even.spread} LU, measured; a word over ${LINE_EVEN_LU} LU off it comes back to ${LINE_EVEN_LU}, a guess): ${shown}${even.places.length > 3 ? `, +${even.places.length - 3} more` : ""}; even:false keeps them as said`);
  }
  const text = operation.text ?? (said.length ? said.map((item) => item.text).join(" ") : null);
  const fileFrom = round(mediaSoundTime(owner.piece, Math.max(start, owner.play.start)));
  const fileTo = round(mediaSoundTime(owner.piece, Math.min(end, owner.play.end)));
  const receipt = {
    layer: layer.name,
    line: text,
    scene: [start, end],
    file: [fileFrom, fileTo],
    volume,
    ...(differs ? { heard: heardText } : {}),
    ...(sound ? { sound: { label: sound.label, sure: sound.sure, db: sound.db } } : {}),
    kept: ranges.length,
    subtitle: subtitle ? { name: subtitle.name, pages: subtitle.pages, look: subtitle.look ?? operation.look ?? "subtitle", at: [subtitle.first, subtitle.last] }
      : standing ? { name: standing.name, kept: true } : (operation.subtitle === false ? "off" : "none"),
    duck: duck ? { layer: duck.layer, to: duck.to, summary: duck.summary } : "none",
    ...(mix ? { mix } : {}),
    ...(gainSaid ? { gain: gainSaid } : {}),
    ...(waysSaid ?? {}),
    ...(bedSaid ? { bed: bedSaid } : {}),
    ...(chainSaid ? { dips: chainSaid } : {}),
    ...(dropSaid ? { drop: dropSaid } : {}),
    ...(even ? { even: { median: even.median, spread: even.spread, places: even.places } } : {}),
    summary: `kept ${sound ? `${sound.label.replaceAll("_", " ")} (${sound.db} dB) ` : text ? `"${text.length > 60 ? `${text.slice(0, 60)}...` : text}" ` : ""}of ${layer.name} at ${start}-${end} s (file ${fileFrom}-${fileTo} s), the rest of its sound silenced; ${subtitle ? `subtitle ${subtitle.name}` : standing ? `subtitle ${standing.name} kept as it was` : "no subtitle"}; ${duck ? duck.summary : "no music dip"}${mix ? `; mix under the ${sound ? "sound" : "line"} ${mix.under} vs ${mix.around} LUFS in the 2 s around (${mix.change >= 0 ? "+" : ""}${mix.change} LU)` : ""}`,
    ...(notes.length ? { notes } : {}),
  };
  if (returnLink && notes.length) Object.defineProperty(receipt, RETURN, { value: returnLink, enumerable: false });
  if (levelsLink) Object.defineProperty(receipt, LEVELS, { value: levelsLink, enumerable: false });
  if (chainLink) Object.defineProperty(receipt, CHAIN, { value: chainLink, enumerable: false });
  // Every line's note in one edit is written after all the lines are placed.
  refreshEarlier(document, reports, receipt);
  return receipt;
}
