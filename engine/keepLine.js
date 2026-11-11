// keep_line: one spoken line of a clip stays in the edit. The rest of that layer's sound is
// silenced, a small subtitle shows the line, and the music dips under it.
//
//   keep_line {sceneId, layerId, line? | from?, to?, text?, subtitle?, look?, name?, duckId?, duckNone?, dip?, transcript?}
//
//   line      the words to keep, found in the clip's transcript as add_captions {speech} reads it
//   from, to  or a stretch in scene seconds (works with no transcript, for speech in another language)
//   text      the subtitle's words instead of the transcript's (a fix, or a translation); shown over
//             the whole line
//   subtitle  false: no subtitle. look: add_captions look (default "subtitle"); name: its group
//   duckId    the music layer (default: the audio layer named music or song, else the only other one);
//             duckNone: no dip. dip: the music's volume under the line (default 0.5, about 6 dB down)
//
// It is built from what exists: speechWords and captionWordsFromSpeech (the words), add_captions
// (the subtitle) and duck_audio (the dip). The silence is two Volume animations per line, "Line up"
// and "Line down" (and "Line mute" from the scene's start), at the layer's own volume. Another
// keep_line on the same layer keeps both lines: it reads the first from those animations.
import { uid } from "./model.js";
import { mediaPlaybackRange, mediaSoundTime } from "./playback.js";
import { applyAddCaptions } from "./captionLayers.js";
import { applyDuckAudio } from "./audioDucking.js";
import { captionWordsFromSpeech, checkSpeechLayer, speechWords } from "./speech.js";
import { lineWords } from "./blocks/moves/footage.js";
import { round } from "./numbers.js";

export const LINE_NAMES = Object.freeze({ mute: "Line mute", up: "Line up", down: "Line down" });
export const DEFAULT_DIP = 0.5;
// The fade up starts this long before the first word (the breath), the fade down after the last.
const UP_PAD = 0.08;
const DOWN_PAD = 0.12;
const SHORTEST = 0.001;
const MUSIC_NAME = /music|song|track|score/i;
const isLineMark = (animation) => Object.values(LINE_NAMES).includes(animation?.name);

function fail(message) {
  throw new Error(`keep_line: ${message}`);
}

// The stretches (scene seconds) an earlier keep_line left audible on the layer, from its animations.
function keptRanges(layer) {
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
  const dip = operation.dip ?? DEFAULT_DIP;
  if (typeof dip !== "number" || !(dip >= 0 && dip <= 1)) fail("dip is the music's volume under the line, a number from 0 to 1.");
  const range = mediaPlaybackRange(layer, scene.duration);
  if (!range) fail(`"${layer.name}" does not play inside this scene.`);

  // The words the scene plays, as captions read them (none when the clip was not transcribed or has none).
  const heard = operation.transcript?.words?.length
    ? captionWordsFromSpeech(speechWords(scene, checkSpeechLayer(scene, layer, "keep_line"), operation.transcript)).words : [];
  let start;
  let end;
  let said;
  if (operation.line !== undefined) {
    if (!heard.length) fail(`"${layer.name}" has no words heard to find "${operation.line}" in; give from and to (scene seconds) and text instead.`);
    const found = lineWords(heard, operation.line);
    if (!found) fail(`"${operation.line}" is not said in ${layer.name} in this scene; inspect speech:${layer.name} shows its words, or give from and to.`);
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
  const volume = layer.volume > 0 ? layer.volume : 1;
  const ranges = merged([...keptRanges(layer), { start, end }]);
  layer.volume = volume;
  layer.animations = [...(layer.animations ?? []).filter((animation) => !isLineMark(animation)), ...silenceAround(ranges, volume, scene.duration)];

  // The subtitle, timed to the words (or to the line when the text is given).
  const notes = [];
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
  let duck = null;
  if (music.layer) {
    const words = ranges.map((item) => ({ text: "line", start: round(mediaSoundTime(layer, Math.max(item.start, range.start))), end: round(mediaSoundTime(layer, Math.min(item.end, range.end))), p: 1 }));
    duck = applyDuckAudio(document, { type: "duck_audio", sceneId: scene.id, layerId: music.layer.id, under: [layer.id], to: dip, speech: { [layer.id]: { words } } });
  } else notes.push(`the music does not dip: ${music.reason}`);

  const text = operation.text ?? (said.length ? said.map((item) => item.text).join(" ") : null);
  const fileFrom = round(mediaSoundTime(layer, start));
  const fileTo = round(mediaSoundTime(layer, end));
  return {
    layer: layer.name,
    line: text,
    scene: [start, end],
    file: [fileFrom, fileTo],
    volume,
    kept: ranges.length,
    subtitle: subtitle ? { name: subtitle.name, pages: subtitle.pages, look: subtitle.look ?? operation.look ?? "subtitle" } : (operation.subtitle === false ? "off" : "none"),
    duck: duck ? { layer: duck.layer, to: duck.to, summary: duck.summary } : "none",
    summary: `kept ${text ? `"${text.length > 60 ? `${text.slice(0, 60)}...` : text}" ` : ""}of ${layer.name} at ${start}-${end} s (file ${fileFrom}-${fileTo} s), the rest of its sound silenced; ${subtitle ? `subtitle ${subtitle.name}` : "no subtitle"}; ${duck ? duck.summary : "no music dip"}`,
    ...(notes.length ? { notes } : {}),
  };
}
