// Steps that come from the material: after the build, each ability the project's own measured
// facts say applies and that is not done yet, as a filled edit with the one fact that picked it.
// The service gathers the facts from what it already keeps (saved transcripts, the scene's
// layers, the visible actions from saved measurements); nothing is decoded or rendered here.
// Every step is an offer: none is a gate, a warning or a refusal, and the final render never
// waits on one. An offer is made once per revision of the layers it is about (offeredOpen).
//
// Order: cut the slips first (captions made before a cut no longer match the voice), then the
// captions, then the music under the voice, then the effects on the visible actions.
import { LONG_PAUSE, PAUSE_PACES, speechFlags, speechPieces, speechWords } from "../../engine/speech.js";
import { volumeAt } from "../../engine/animation.js";
import { DUCK_NAMES } from "../../engine/audioDucking.js";
import { mediaPlaybackRange } from "../../engine/playback.js";
import { round } from "../../engine/numbers.js";

// The most action ids one place_sounds is filled with: what library {topic:"sounds", actions:true} lists.
const MOST_ACTIONS = 12;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const sceneField = (facts) => (facts.scene ? { scene: facts.scene } : {});

/** A short fingerprint of what a step is about: the same layers give the same string. */
export function layerSig(value) {
  const text = JSON.stringify(value ?? null);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

/**
 * A voice's fact from its saved transcript: the words the scene plays at a volume over 0, on the
 * first piece of the voice (its name is what cut_speech and add_captions take). null for a later
 * piece or a voice with no transcript. cut: cut_speech already made pieces of it.
 */
export function voiceFact(scene, layer, transcript) {
  if (!Array.isArray(transcript?.words)) return null;
  let pieces;
  try { pieces = speechPieces(scene, layer); } catch { pieces = [layer]; }
  if (pieces[0] !== layer) return null;
  const words = speechWords(scene, pieces, transcript)
    .filter((word) => volumeAt(word.piece, word.start) > 0)
    .map(({ piece, ...word }) => word);
  return { name: layer.name ?? layer.id, sig: layerSig(pieces), words, cut: pieces.length > 1 || (layer.cutWords?.length ?? 0) > 0 };
}

/** A music layer's fact: where it plays in the scene and whether duck_audio dipped it. */
export function musicFact(scene, layer) {
  const range = mediaPlaybackRange(layer, scene.duration);
  if (!range) return null;
  const ducked = (layer.animations ?? []).some((animation) => animation?.name === DUCK_NAMES.down || animation?.name === DUCK_NAMES.up);
  return { name: layer.name ?? layer.id, sig: layerSig(layer), start: range.start, end: range.end, ducked };
}

// The person's words that say no words on screen: "no captions", "without subtitles", "no on-screen text".
const NO_CAPTIONS = /\b(?:no|without|skip|drop|never)\s+(?:any\s+|the\s+)?(?:captions?|subtitles?|on[- ]screen (?:text|words)|text on screen)\b/i;

/** Whether the brief's fields (their asks and every line) say no captions. */
export function briefSaysNoCaptions(brief) {
  const texts = [];
  for (const value of Object.values(brief?.fields ?? {})) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === "string") texts.push(entry);
      else if (typeof entry?.text === "string") texts.push(entry.text);
    }
  }
  return texts.some((text) => NO_CAPTIONS.test(text));
}

// Seconds of speech: the words' own lengths, summed.
const speechSeconds = (words) => round(words.reduce((sum, word) => sum + Math.max(0, word.end - word.start), 0), 1);

// Seconds a voice's words play inside [start, end).
const overlapSeconds = (words, start, end) => round(words.reduce((sum, word) => sum + Math.max(0, Math.min(word.end, end) - Math.max(word.start, start)), 0), 1);

/**
 * The steps the material asks for, [{key, why, step, call, sig}], in their fixed order.
 * facts: {
 *   scene: the scene's name when the project has several (else null),
 *   voices: [{name, sig, words: [{index, text, start, end, p?, unclear?}] heard in the scene, cut: bool}],
 *   captions: the scene has a caption layer, noCaptions: the brief says no on-screen words,
 *   music: [{name, sig, start, end, ducked}],
 *   actions: [{id, at}] visible actions, effects: sound effect layers in the scene, soundsSig,
 * }
 */
export function materialSteps(facts = {}) {
  const steps = [];
  const voices = (facts.voices ?? []).filter((voice) => voice.words?.length >= 3);
  const voice = [...voices].sort((a, b) => speechSeconds(b.words) - speechSeconds(a.words))[0];
  // 1. Slips and long pauses in a voice not cut yet (speechFlags: the inspect speech flags line).
  for (const each of voices) {
    if (each.cut) continue;
    const flags = speechFlags(each.words);
    const slips = [...flags.repeat, ...flags.filler].flat().sort((a, b) => a - b);
    const pauses = flags.pause.filter((pause) => pause.seconds > PAUSE_PACES.natural.over);
    if (!slips.length && !pauses.length) continue;
    const parts = [
      flags.repeat.length ? plural(flags.repeat.length, "repeat") : "",
      flags.filler.length ? plural(flags.filler.length, "filler") : "",
      pauses.length ? `${plural(pauses.length, "pause")} over ${LONG_PAUSE} s (${round(pauses.reduce((sum, pause) => sum + pause.seconds, 0), 1)} s)` : "",
    ].filter(Boolean);
    const op = { op: "cut_speech", layer: each.name, ...(slips.length ? { words: slips } : {}), ...(pauses.length ? { pauses: "natural" } : {}) };
    steps.push({ key: `cut_speech:${each.name}`, sig: each.sig, step: `cut the slips in ${each.name}`, why: `${each.name} plays ${parts.join(", ")}`, call: { tool: "edit", input: { ops: [op] } } });
    break;
  }
  // 2. Speech with no caption layer, unless the brief says no words on screen.
  if (voice && !facts.captions && !facts.noCaptions) {
    steps.push({ key: `add_captions:${voice.name}`, sig: voice.sig, step: `caption ${voice.name}`, why: `${speechSeconds(voice.words)} s of speech in ${voice.name}, no caption layer`,
      call: { tool: "edit", input: { ops: [{ op: "add_captions", speech: voice.name, ...sceneField(facts) }] } } });
  }
  // 3. Music over a voice with no dip in it.
  for (const music of facts.music ?? []) {
    if (music.ducked) continue;
    const under = voices.map((each) => ({ each, seconds: overlapSeconds(each.words, music.start, music.end) })).filter((entry) => entry.seconds > 0);
    if (!under.length) continue;
    const seconds = round(under.reduce((sum, entry) => sum + entry.seconds, 0), 1);
    steps.push({ key: `duck_audio:${music.name}`, sig: layerSig([music.sig, ...under.map((entry) => entry.each.sig)]), step: `dip ${music.name} under the voice`,
      why: `${music.name} plays under ${seconds} s of speech (${under.map((entry) => entry.each.name).join(", ")}), no dip`,
      call: { tool: "edit", input: { ops: [{ op: "duck_audio", layer: music.name, under: under.map((entry) => entry.each.name) }] } } });
    break;
  }
  // 4. Visible actions and no sound effect on any (sound effects only on visible actions).
  const actions = facts.actions ?? [];
  if (actions.length && !(facts.effects > 0)) {
    steps.push({ key: "place_sounds", sig: facts.soundsSig ?? layerSig(actions), step: "put sounds on the visible actions",
      why: `${plural(actions.length, "visible action")} (${actions.slice(0, 3).map((action) => `${action.id} ${action.kind ? `${action.kind} ` : ""}${action.at} s`).join(", ")}${actions.length > 3 ? ", ..." : ""}), 0 sound effects`,
      call: { tool: "edit", input: { ops: [{ op: "place_sounds", ...sceneField(facts), at: actions.slice(0, MOST_ACTIONS).map((action) => action.id) }] } } });
  }
  return steps;
}

/**
 * The first step still open: not offered before on an earlier revision with the same layers.
 * offered: {[key]: {sig, rev}} from the agent state; a step offered on this revision is still
 * shown (status and the answer that follows say the same call).
 */
export function offeredOpen(steps, offered = {}, rev) {
  return steps.find((step) => {
    const before = offered?.[step.key];
    return !(before && before.sig === step.sig && before.rev !== rev);
  }) ?? null;
}
