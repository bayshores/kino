// The audio, caption and sequence operations (milestone A7), in one place for operations.js:
//   set_cues      {cues?, replace?, remove?}         named moments in document.cues (cues.js)
//   add_captions  {sceneId, text | words | speechId, …}  caption layers and line/word cues (captionLayers.js)
//   detect_beats  {sceneId, layerId, analysis, …}    beat and onset cues, rhythm (beatCues.js)
//   add_sequence  {properties, scenes, transition?}  one scene playing others in a row (sequence.js)
//   duck_audio    {sceneId, layerId, under, to?, fade?}  volume dips under other sound (audioDucking.js)
//   cut_speech    {sceneId, layerId, words?, spans?, pauses?, restore?, ripple?, morph?, transcript}  words cut from (or put back in) a voice (speech.js)
//   sync_clips    {sceneId, layerId, toId, at? | match}  one clip played in step with another (clipSync.js)
//   fit_music     {sceneId, layerId, payoff, turn?, end?, plan?, drop?, recut?, shape, analysis}  one stretch of the song, its drop on the payoff (fitMusic.js)
//   place_broll   {sceneId, speechId, layerIds, about, lead?, transcript, shots}  B-roll where its words are said (broll.js)
// Each one that has something to tell the agent (pages made, beats found) puts a short report in
// `reports` (a Map from operation to report), which the agent service adds to its answer.
import { applySetCues } from "./cues.js";
import { applyAddCaptions } from "./captionLayers.js";
import { applyDetectBeats } from "./beatCues.js";
import { applyAddSequence } from "./sequence.js";
import { applyDuckAudio } from "./audioDucking.js";
import { applyCutSpeech } from "./speech.js";
import { applySyncClips } from "./clipSync.js";
import { applyFitMusic } from "./fitMusic.js";
import { applyPlaceBroll } from "./broll.js";

export const AUDIO_CAPTION_OPERATIONS = new Set(["set_cues", "add_captions", "detect_beats", "add_sequence", "duck_audio", "cut_speech", "sync_clips", "fit_music", "place_broll"]);

/** Applies one of AUDIO_CAPTION_OPERATIONS to `document` (changed in place). */
export function applyAudioCaptionOperation(document, operation, { fonts, reports } = {}) {
  let report;
  if (operation.type === "set_cues") applySetCues(document, operation);
  else if (operation.type === "add_captions") report = applyAddCaptions(document, operation, { fonts });
  else if (operation.type === "detect_beats") report = applyDetectBeats(document, operation);
  else if (operation.type === "add_sequence") report = applyAddSequence(document, operation);
  else if (operation.type === "duck_audio") report = applyDuckAudio(document, operation);
  else if (operation.type === "cut_speech") report = applyCutSpeech(document, operation);
  else if (operation.type === "sync_clips") report = applySyncClips(document, operation);
  else if (operation.type === "fit_music") report = applyFitMusic(document, operation);
  else if (operation.type === "place_broll") report = applyPlaceBroll(document, operation);
  else throw new Error(`Unsupported editing operation: ${operation.type}`);
  if (report && reports) reports.set(operation, report);
}
