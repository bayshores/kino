// The agent service: the 10 verbs an agent uses (status, edit, check, look, inspect, render,
// library, history, notes, project). The MCP tools and the `kino` command line are thin
// clients of this one module, through POST /api/agent/<verb>.
//
// Every verb answers { text, data?, images?, isError? }:
// - text: what the agent reads (short plain text, or compact JSON for receipts)
// - data: the same facts as an object, for programs (MCP structuredContent, `kino --json`)
// - images: [{ path, mime, data(base64) }] for `look`
// Problems are answers too (isError: true), never HTTP errors, so the agent always gets a
// readable reason, the operation number and a "did you mean".
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, writeFile, mkdir, rename, copyFile, readdir } from "node:fs/promises";
import { callStarted } from "../render-activity.mjs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { uptime } from "node:os";
import { EASINGS, lowpassSampler, PRESETS } from "../../engine/animation.js";
import { addNeeds, answerNeed, emptyNeeds, finishNeed, needsCall, needsLine, needState, NEEDS_WAIVER, openNeeds, parseNeedItems } from "./needs.mjs";
import { LIBRARY_TOPICS, NOTES_ACTIONS } from "./actions.mjs";
import { createFootageActions, FootageError, FOOTAGE_RESULT_KEEP_MS, FOOTAGE_TOPIC_LINE, FOOTAGE_WAIT_MS, isFoundClip, parseRef as parseFootageRef, personClipCount, personClipsLine, scanIdOf } from "../footage-finder/actions.mjs";
import { importedSeconds, planTake, takeText } from "../footage-finder/take.mjs";
import { footageSheet, foundClipTag, groupClips, groupLine, GROUP_TILES_MOST } from "../footage-finder/sheet.mjs";
import { FOOTAGE_WAIVER, footageLed, footageStepOn } from "../footage-finder/step.mjs";
import { shotsNeeded } from "../footage-finder/needs.mjs";
import { SAYS_MIN_SECONDS, saysOf } from "../footage-finder/words.mjs";
import { captionSpoilers, captionWindows, directionMiss, viewerBarProtocol, SHOW_FIRST, heardLines, heardText, musicSections, openStoryBugs, parseIntents, parseViewer, VIEWER_PER_SHEET, VIEWER_PROTOCOL, VIEWER_RECENT, VIEWER_ROUNDS, VIEWER_TILE, VIEWER_UNDER, VIEWER_WAIVER, SPOILER_WAIVER, viewerGap, viewerRounds, viewerTimes, writePacket } from "./viewer.mjs";
import { PRESET_DEFINITIONS } from "../../engine/presetCatalog.js";
import { applyOperations } from "../../engine/operations.js";
import { MUSIC_CUE_KINDS } from "../../engine/qualityFields.js";
import { createDocument, createLayer, createScene, parseDocument } from "../../engine/model.js";
import { documentChanges } from "../../engine/documentChanges.js";
import { mergeDocuments } from "../../engine/documentMerge.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { exportProfile } from "../../engine/exportOptions.js";
import { fpsLabel, parseFps, readFps } from "../../engine/frameRate.js";
import { fontTargetLayers, withFontPatches } from "../../engine/fontDocuments.js";
import { ensureDocumentFonts, prepareFontPatches } from "../font-selection.mjs";
import { OPERATION_TYPES, SERVICE_OPERATION_TYPES, describeOperation, guideTopics, linesMentioning } from "../operation-guide.mjs";
import { runIsolateVoice } from "./voice-operation.mjs";
import { runCutOut } from "./cutout-operation.mjs";
import { runMatchColor } from "./color-operation.mjs";
import { runPin, runTrack } from "./track-operation.mjs";
import { runStabilize } from "./stabilize-operation.mjs";
import { recordingFor } from "../recorder/recorder.mjs";
import { createOperationRequest } from "../operation-request.mjs";
import { ConflictError } from "../store.mjs";
import { hideShareSecrets } from "../shares.mjs";
import { mediaAllowedIn } from "../media-use.mjs";
import { assignCodes, closest, createResolver, documentObjects, nearMiss, ReferenceError } from "./refs.mjs";
import { SAMPLE_FRAME, sampleOps } from "./library-catalog.mjs";
import { pictureAlpha } from "./picture-alpha.mjs";
import { libraryMedia, stripPng } from "./library-media.mjs";
import { currentTurn, turnOver } from "./state.mjs";
import { editFocus } from "./dashboard.mjs";
import { callLabel, callTarget, pointingText } from "./labels.mjs";
import { knownAgent, touchedLayers } from "./live.mjs";
import { AGENT_OPERATION_TYPES, createdIds, plainLayer, referencedIds, translateAll } from "./translate.mjs";
import { exampleFor, moreExamplesFor, signatureFor } from "./op-examples.mjs";
import { opFromWord, PRESET_LAYER, PRESET_SAMPLE_TO, PRESET_VALUE_KEYS } from "./common-mistakes.mjs";
import { animationSpan, isRandomId, layerAnimations, refName, sec } from "./describe.mjs";
import { fontsLibraryText, missingCharactersHelp } from "./font-help.mjs";
import { projectOutline } from "./outline.mjs";
import { applyBrief, asksOf, BriefError, briefChanges, briefData, briefText, hasBrief, isSettled, lengthTarget, lockNeeded, notBuilt, orderSteps, pickOpen, referenceSearches, SUBJECT_SLOT, songTitleOf, REFERENCE_SKIP_UNDER, realEdit, REFERENCES_WANTED, savedText, TREATMENTS_WAIVER, videoFacts } from "./brief.mjs";
import { createFootageFacts, MAX_FOOTAGE } from "./footage.mjs";
import { createFootageCache } from "../footage/analyze.mjs";
import { createPeopleCache } from "../footage/people.mjs";
import { applySwap, dealDue, deckData, deckInputs, deckRequest, deckStatusLine, deckText, loadMoves, mediaKeys, newDeal, RECENT_PROJECTS, swapProblem } from "./deck.mjs";
import { answerStep, checkpointStep, dashboardAnswerStep, finalRefusal, openStops, reopenStep, settleWaiting, statusLines, statusMove, StopError, stopRules, stopsSummary, waitingData, waitingStop, waivedLine, workPrint } from "./stops.mjs";
import { finishLog, logCall, stepNameOf, stepRows, stepsLine, stepsTable } from "./step-log.mjs";
import { controlsLine } from "./controls.mjs";
import { addRejected } from "./style.mjs";
import { pickedEnding, pickedType } from "./treatments.mjs";
import { activeApproval, boardFacts, boardPrint, laterAnswer, settleBoard } from "./board.mjs";
import { boardLook, BoardLookError, boardShotImage, SHOT_WIDTHS, styleFrameFacts, styleFrameImage } from "./board-look.mjs";
import { boardData as boardScreenData } from "./board-data.mjs";
import { editableField, inspectTargets } from "./inspect.mjs";
import { overriddenValues } from "./overridden-values.mjs";
import { animationJumps, moveHandEdits } from "./jumps.mjs";
import { BRIEF_RULES, checkDocument, checkReport, checkSummary, explainMissingGlyphs, groupFixLines, liveWaivers, mergeFindings, openFindingLines, staleWaiverLine, triageFindings, waiverNotes } from "./checks.mjs";
import { addVerdict, anchorLines, barOf, barPairs, barTimeAt, parseVerdict } from "./bar.mjs";
import { BAR_PROTOCOL, CRITIQUE_PROTOCOL, CRITIQUE_ROUNDS, CRITIQUE_WAIVER, barGap, blocksRender, critiqueDirectionKey, critiqueOf, critiqueSpine, critiqueQuestions, critiqueTimes, critiqueWanted, lineText, openCritique, parseCritique, personCall, upLines } from "./critique.mjs";
import { createQualityChecker, qualityRulesText, videoScene } from "./quality.mjs";
import { houseMoments, houseStructure, houseType } from "../house-memory.mjs";
import { plateChanges, techniquesLine } from "../../engine/quality/techniques.js";
import { PLAIN_TAGS, TECHNIQUE_TAGS, techniquesText } from "../../engine/techniques.js";
import { styleContext } from "../../engine/styleSpec.js";
import { blocksFinal, FINAL_GATES } from "../../engine/quality/index.js";
import { ideaLines, signatureRanges } from "../../engine/quality/rules/signature.js";
import { hasMusic, isMusicLayer } from "../../engine/quality/rules/sound.js";
import { renderSceneFrames, sceneSoundClips, soundCurve } from "../export.mjs";
import { decodeMono } from "../audio-analysis.mjs";
import { songShape } from "../song-shape.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";
import { sectionsInVideo, soundMapImage, soundMapText, volumeDips } from "./sound-map.mjs";
import { createTries, triesView } from "./tries.mjs";
import { boardRefKeys, createJudge, judgeLine, judgeLost, pairCount, pinnedPairs, refForKey, resultText, roundView, tally, VERSUS_ROWS } from "./judge.mjs";
import { createPicks, SITTING_PICKS } from "./picks.mjs";
import { rendererIsProcessor } from "../render-devices.mjs";
import { plannedFrameCount } from "../export-batches.mjs";
import { planClips } from "./clips-sheet.mjs";
import { evenTimes, everyFrame, FRAMES_MOST, reviewColumns, sceneKey, SEAM_EDGE, SEAM_MERGE, SEAM_OFFSETS, SHEET_FRAMES, sheetTimes, SOURCE_EDGE, SOURCE_EDGE_RANGE, STRIP_TILES, tileSize, VERSUS_EDGE } from "./look.mjs";
import { boardShotKind, craftRow, editPixelKind, gapWords, imageStats, KIND_WORDS, referenceMoments, sameKindMoment } from "./versus.mjs";
import { CAMERA_RULES, motionGraphImage, motionTrace, traceText } from "./motion-graph.mjs";
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { changedStretches, findingsAt, frameSignature, nearDuplicate, newFindingsLine, rememberReviewed, REVIEW_COMPACT_EDGE, REVIEW_FULL_EDGE, REVIEW_IMAGE_BUDGET, REVIEW_SKIP_UNDER, REVIEW_WAIVER, reviewEvents, reviewKey, reviewSizes, unreviewed } from "./review.mjs";
import { missingDocumentFonts } from "../../engine/fontRecovery.js";
import { sceneShots, shotTiles } from "../../engine/sceneShots.js";
import { boxesAt, cropOnSource, insideShare } from "../../engine/sourceView.js";
import { mediaFrameState, mediaPlaybackRange } from "../../engine/playback.js";
import { isRemapped } from "../../engine/mediaTime.js";
import { visionBoxes } from "../cutout/cutout.mjs";
import { shotsLine } from "../shot-detection.mjs";
import { isFreesoundId, isOpenverseId, SOUND_LIMITS, SoundSearchError, soundsText } from "../sound-search.mjs";
import { isLibraryId, librarySoundsText, musicText, SoundLibraryError } from "../sound-library.mjs";
import { compareText, compareToStory, exploreLanes, importableId, junkTitle, keepCandidates, licenseTag, SoundtrackError } from "../soundtrack.mjs";
import { rankSongs } from "../songTaste.mjs";
import { dot, LANES } from "../music-embed.mjs";
import { importedText } from "./client.mjs";
import { estimateImageTokens, estimateTextTokens, pngSize } from "../meter.mjs";
import { drawnSeconds, estimateWords, renderEstimate } from "./render-estimate.mjs";
import { blockRules, blocksLibraryText, createBlockRunner, isBlockOperation, movesLibraryText, variantSet } from "./blocks.mjs";
import { originReferenceLine, REFERENCE_LOOKUP, seenNames } from "./seen-names.mjs";
import { spokenLine } from "../../engine/blocks/moves/footage.js";
import { VIDEO_FORMAT_NAMES, videoFormatsText } from "../../engine/blocks/videoFormats.js";
import { existsSync } from "node:fs";
import { avOffsetFinding } from "./av-offset.mjs";
import { describeLevels } from "../audio-levels.mjs";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";
import { createBeatAnalysisCache, isSoundEffect, soundIsMusic, steadyBeat } from "../audio-analysis.mjs";
import { createSongShapeCache } from "../song-shape.mjs";
import { createAudioPeaksCache } from "../audio-peaks.mjs";
import { createLoudnessCurves } from "../loudness-curve.mjs";
import { captionEvents, writeCaptionFiles } from "./caption-export.mjs";
import { renderRange, rangeCaptions, fastPreviewOptions } from "../render-range.mjs";
import { cueListText, isCueTarget } from "./cue-list.mjs";
import { cutListText, cutTargetFrom, isCutTarget } from "./cut-list.mjs";
import { soundLevels } from "../../engine/quality/loudness.js";
import { createTranscriptCache, TRANSCRIPT_VERSION } from "../speech/transcribe.mjs";
import { projectNames, speechNamesFor } from "../speech/name-hint.mjs";
import { createSyncEnvelopeCache } from "../clip-sync.mjs";
import { currentLag, matchEnvelopes, SYNC_FALLBACK, syncLayers } from "../../engine/clipSync.js";
import { checkSpeechLayer, clipLines, clipLinesText, cutSpeechIndices, fileWords, speechPieces, speechText, speechWords } from "../../engine/speech.js";
import { access } from "node:fs/promises";
import { REACH_HELP, REACH_OPERATIONS, applyReachOperation } from "./reach-operations.mjs";
import { WORKSPACE_HELP, createReachWorkspace } from "./reach-workspace.mjs";
import { createReachExports, selectedScenes } from "./reach-exports.mjs";
import { CLOSED_PLATFORM, closedPlatform, ideasAnswerText, ideasProposedText, isYouTubeUrl, MAX_SOUND_SECONDS, numbersLine, originPhrase, originQuery, projectText, rankedSoundsText, referenceText, refId, rhythmCues, SEARCH_KINDS, searchText } from "../inspire.mjs";
import { suggestStyleLines } from "../measure/suggest.mjs";
import { changedParts, RENDER } from "./crew-locks.mjs";
import { CrewError } from "./crew.mjs";
import { callDetails as answerDetails, takeSaid } from "./said.mjs";
import { answerText, call as nextOf, callText, cleanInput, opWithName, originFootage, originFootageNext, STATUS_CALL, unfilledSlot, withSuggestion } from "./next-call.mjs";

// Inbox lines kept for one agent (a helper's hand-back to its lead) until that agent calls.
const INBOX_FOR_OTHERS_KEPT = 50;

// inspect "speech:<layer>" or "speech:<layer>[from=30]".
// speech:<layer>, speech:<layer>[from=30], speech:<layer>[file] (the whole file) or [file,from=30].
// Characters of words one speech target lists, all of them together, and the least worth one more.
const SPEECH_BUDGET_ONE = 10_000;
const SPEECH_BUDGET = 15_000;
const SPEECH_BUDGET_MIN = 2_000;
const SPEECH_TARGET = /^speech:(.+?)(?:\[(file)?,?(?:from=(\d+(?:\.\d+)?))?\])?$/;
export const VERBS = Object.freeze(["status", "edit", "check", "look", "inspect", "render", "library", "history", "notes", "project"]);
const RECEIPT_LIST = 30;
// An edit receipt lists the times of at most this many animations it made or retimed.
const TIMES_LIST = 8;
// look: the longest image edge, in pixels (an image costs about (w/28)×(h/28) tokens).
const LOOK_MAX_EDGE = 1280;
// look sheet: when its frames are further apart than this (a scene over about a minute), the
// answer says how to see a stretch of it closer.
const SHEET_GAP_HINT = 6;
// library {topic:"rules", name:"render"}.
const RENDER_RULES = 'render start defaults to draft: half each scene dimension at 30fps (or your fps up to 30, such as 24 or 25 to match the footage), the long side at most the person\'s draft size setting (960 by default). The person\'s export settings fill in format, fps and output folder when you leave them out. A final render over their frame limit, or one that would overwrite a file, answers awaiting_approval {id, rev}: the person answers it in the app, or tells you in the chat (then record their words: notes {action:"answer", id, words, read_as:"approve" or "deny"}), so tell them and do not poll; render {action:"wait", job:id} blocks until they answer (up to 55 s) and {action:"cancel", job:id} withdraws it. Allowing it renders that rev; an edit first makes it ask again, and the same start after an edit replaces the waiting request (replaced:id). final uses full scene dimensions and requested fps (default 30; 23.976, 29.97, 59.94, "30000/1001" or {num, den} too), motionBlur:0.5 and dither:true; override motionBlur:0..1 or dither:false. Motion blur comes from layer movement while the shutter is open: options {shutterAngle:0..360 (180 = motionBlur 0.5), motionSamples:2..16 (default: as many as the fastest move in each frame needs for copies at most 8 px apart)}; 2 samples show a fast move as two copies. Each sample draws a moving frame once more (frames that do not move are drawn once); footage keeps one picture per frame. The dashboard (cached playback too) and look show a preview of it (each fast-moving layer smeared along its path); a final png (options {time}) shows the real one. Unwaived check errors (and signature_missing, a warning while editing) block final, and so do open stops (stops_open; drafts render) moments of the whole video not yet seen in look {mode:\"review\"} (review_needed; waive_check {code:\"review\"} skips it), a video of 5 s or more with no saved reference (find 2 with library inspire), or with saved references no look {mode:\"versus\"} in 10 revisions or a rev judged blind with the references winning (reference_needed; waive_check {code:\"reference\"} skips it), and a whole video of 15 s or more with footage or speech without a fresh viewer report (look {mode:\"viewer\"}, notes viewer) on a recent revision with no open story bugs, or an edit after round 2 found them (viewer_needed; waive_check {code:\"viewer\"} skips it), and a need not answered and done (needs_open) or such a video whose material was never checked (needs_unchecked; notes needs; waive_check {code:\"needs\"} skips both). preview:"fast" caps drafts at 640px/15fps without blur or dither. from/to select one draft video excerpt, snapped outward to frames; sound and captions stay aligned. Replies give actual range. scene:"all" renders up to 20 scenes as separate files; unchanged scenes reuse checked segments, including after restart. Formats: mp4, webm, mov, gif, png, apng, png-sequence (ZIP), lottie (native vector canvas; no blur/dither). queue lists recent jobs; wait returns paths, cachedScenes/redrawnScenes and file checks. options passes existing export settings (transparent, profile, loop, GIF quality, PNG time, imageDPIRatio); the quality rung determines dimensions. Two exports run concurrently. Cancel stops workers/encoders; start again to reuse completed segments. A job whose scenes all finished is saved instead: cancel answers Nothing to cancel with its files. Output checks verify dimensions, codec, frame count, duration and audio start offset where the format supports them; unsupported checks are explicit. Final mp4, webm, mov and apng files are also compared frame by frame with the renderer; a file that runs a frame early or late fails with the frames where it slips: render again, and report it with the message if it fails again. Exported sound goes through a master limiter that keeps the encoded file\'s true peak at or under -1 dBTP: the sound is encoded and measured first, and the ceiling drops when AAC or Opus push peaks back up. Before it, every mp4, webm or mov (drafts too) brings the whole mix (after ducking) to a loudness target: options {loudness:"web" (-14 LUFS, the default)|"podcast" (-16)|"broadcast" (-23)|"off"}. It is one plain gain, so the balance never shifts; where the limiter would take peaks down more than 6 dB the gain holds and the file is quieter (the reply names that peak). Unleveled mixes well under -1 dBTP pass unchanged. wait gives each file\'s sound as integrated loudness (LUFS) with its target, loudness range (LU) and true peak (dBTP); audioPeak warns over -1 dBTP, audioLoudness over 2 LU off target. Without a loudness target, a mix that would have clipped by more than 0.5 dB gets a warning with the loudest moment and the sounds playing then: lower those volumes. Rendered scene caches are bounded by the person\'s render cache setting (512MiB by default). They include media/font bytes, renderer, graphics and quality settings. A new revision alone does not invalidate unchanged scenes. mp4 only: options {videoEncoder:"auto"|"software"|"videotoolbox"|"nvenc"|"qsv"|"amf"|"vaapi", videoQuality:"small"|"standard"|"high"} replace the person\'s defaults for this render (standard is 24 Mbps at 720p and up, high twice, small half); a named encoder that does not work on this computer is an error naming those that do. The graphics card, frames at once and memory to leave free are the person\'s dashboard settings; you cannot change them. wait says what drew each file (graphics card or processor) and which encoder wrote it.';

// library op and rules: at most this many names in one call.
const LIBRARY_NAMES = 8;
// library {topic:"inspire", name} waits this long for a reference kino is still measuring.
const INSPIRE_WAIT_MS = 50_000;
// How long saving the brief's about line waits for the origin search (inspire.origin) before it answers.
const ORIGIN_WAIT_MS = 20_000;
// A skipped origin search (a bot check, a timeout, yt-dlp briefly missing) is tried again on a later
// save of the same about line, but not within this long of the last try.
const ORIGIN_RETRY_MS = 10 * 60_000;
// The waiver code that lets a final render go without look versus (waive_check {code:"reference"}).
const REFERENCE_WAIVER = "reference";
// A look versus counts for this many revisions after it, like a viewer report: small fixes after
// it ask for no new versus (a test run looked again after each one).
const versusSeen = (state, rev) => Number.isFinite(state.versus?.rev) && rev >= state.versus.rev && rev - state.versus.rev <= VIEWER_RECENT;
const IDEAS_HELP = 'library {topic:"inspire", ideas:{ref, take:[{title, from, to?, what, why, use, place?:{at, to?}, tags?}], skip?:[{title, why}]}}: up to 6 ideas from one measured reference (from/to: seconds in it; place: seconds in this video), in plain words: what happens, why it is good, what it becomes here. The person turns each on or off on the inspire screen and allows them; the answer comes in your inbox.';
const BORROW_HELP = 'borrow_rhythm {ref, fit?, at?, scene?}: a reference\'s pace per section (library {topic:"inspire"}, its lend: line), never its cut times: each section\'s shot lengths in a new order become cue marks rhythm-1, rhythm-2, … (kind marker) that at:"cue:rhythm-3" points at, cut on the song\'s song- seams when fit_music marked them. fit:true scales the measured stretch to the scene (from at); fit:<seconds> to that length; marks past the scene are left out. at: seconds into the scene (default 0). scene: id or name (default the first). Borrowing again replaces the rhythm-* marks. Only times come in: the footage never enters the project. The reference is saved in the project.';
const RENDER_WAIT_MS = 55_000;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
// The keys notes {action:"brief"} takes; the last three save (notesBrief).
const BRIEF_KEYS = ["action", "project", "fields", "log", "no_playback"];
// The verbs whose answers end with the brief's advice when it is the next step (a playback, the
// plan): reading the project and the direction. Other answers name their own next call.
const ADVICE_VERBS = ["status", "notes", "project"];
// A refused edit is kept this long (at most REFUSED_KEPT of them) so `edit {retry}` can resend it.
const REFUSED_KEEP_MS = 30 * 60_000;
const REFUSED_KEPT = 20;
const REFUSAL_LIST = 5;
// A refusal names every name it did not find (`missing`), up to this many.
const MISSING_LIST = 100;
const ANSWER_TOKEN_LIMIT = 8000;
// The narrower form of each verb's call, named when its answer is too long to send.
const NARROWER_CALL = {
  status: "status {scene} (one scene), page:2 for the next layers",
  inspect: 'inspect with fewer targets, fields:["<field>"], or speech:<layer>[from=<s>]',
  look: "look {scene, from, to} (a stretch of one scene)",
  check: 'check {scene, rules:["<code>"]}',
  library: 'library {topic:"rules", name, search:"<word>"} (only the lines that mention it)',
};

/** A problem the agent can act on. `code` is a stable word; `details` go into the answer. */
export class AgentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.details = details;
  }
}

// A sound search refusal as the agent's error: off, rate_limited, not_found, refused or failed.
const soundError = (error) => (error instanceof SoundSearchError || error instanceof SoundtrackError || error instanceof SoundLibraryError ? new AgentError(error.code === "bad_input" ? "bad_input" : error.code, error.message) : error);

// Compact JSON for the agent: empty lists and objects are left out (the full reply is in `data`).
const compact = (value) => JSON.stringify(value, (key, entry) =>
  key && entry && typeof entry === "object" && (Array.isArray(entry) ? !entry.length : !Object.keys(entry).length) ? undefined : entry);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// How the agent answers a note when it is done (the note then shows as fixed in the app).
const replyHint = (id) => ` · when done: notes {action:"reply", id:"${id}", text}`;

// "L2 logo, L4 title" for layer ids (with codes), "logo, title" without; a layer that is gone shows its code or id.
function keptNames(ids, document, codes) {
  const layers = new Map((document?.scenes ?? []).flatMap((scene) => scene.layers.map((layer) => [layer.id, layer])));
  return (ids ?? []).map((id) => {
    const name = layers.get(id)?.name;
    if (!codes) return name || id;
    const code = codes.byId?.[id] ?? id;
    return name && name !== code ? `${code} ${name}` : code;
  }).join(", ");
}

// The status line for the person's always notes: they hold for the whole video.
function alwaysLine(notes, codes) {
  const always = (notes ?? []).filter((note) => note.always);
  if (!always.length) return null;
  const shown = always.slice(-5).map((note) => `${note.id} "${note.text.length > 60 ? `${note.text.slice(0, 59)}…` : note.text}"${note.keep?.length ? ` keeps ${note.keep.map((id) => refName(id, codes)).join(" ")}` : ""}`);
  return `always ▸ ${shown.join(" · ")}${always.length > 5 ? ` · ${always.length - 5} more (notes list)` : ""}`;
}

// "3-5, 9" for [3, 4, 5, 9]; "A4-A6, L2" for codes.
function ranges(values) {
  const groups = new Map();
  for (const value of values) {
    const [, prefix, digits] = /^(\D*)(\d+)$/.exec(String(value)) ?? [null, String(value), ""];
    if (!groups.has(prefix)) groups.set(prefix, []);
    if (digits !== "") groups.get(prefix).push(Number(digits));
  }
  const parts = [];
  for (const [prefix, numbers] of groups) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index += 1) {
      let end = index;
      while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
      parts.push(end > index ? `${prefix}${sorted[index]}-${prefix}${sorted[end]}` : `${prefix}${sorted[index]}`);
      index = end;
    }
  }
  return parts.join(", ");
}

// An output folder from the agent must be absolute: a relative one would land wherever the
// kino service was started. (The kino command makes a relative folder absolute before sending.)
function checkOutFolder(out) {
  if (out !== undefined && (typeof out !== "string" || !path.isAbsolute(out)))
    throw new AgentError("bad_input", "out must be an absolute folder path, such as /Users/you/Movies.", { safeToRetry: true });
}

function errorReply(error) {
  if (error instanceof AgentError)
    return { isError: true, text: compact({ error: error.code, reason: error.message, ...error.details }), data: { error: error.code, reason: error.message, ...error.details }, ...(error.nextCall ? { nextCall: error.nextCall } : {}) };
  if (error instanceof ReferenceError)
    return errorReply(new AgentError("unknown_ref", error.message, { didYouMean: error.suggestions, safeToRetry: true }));
  const reason = error instanceof Error ? error.message : String(error);
  return { isError: true, text: compact({ error: "failed", reason }), data: { error: "failed", reason } };
}

// The operation guide was written for the older one-tool-per-operation MCP; point its
// cross-references at the library verb instead.
function guideText(text) {
  return text.replaceAll("describe_operation {topic}", "library {topic:\"rules\", name}").replaceAll("describe_operation", "library");
}

// library search: the operations and guide topics that mention a word, one short line each
// (the sentence where the word appears), not the topics' whole text. A phrase such as "crop
// video and word by word reveal" is split into its words: a topic matches when it holds the
// whole phrase or any of the words, and the ones holding the most words come first.
const SEARCH_SHOWN = 12;
const SEARCH_MORE = 20;
const SEARCH_SKIP = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "how", "in", "into", "is", "it", "its", "my", "of", "on", "or", "the", "then", "that", "this", "to", "with", "what", "when"]);
// rules render, quality and workspace are written in this file, not in the guide.
const RULES_OWN = ["render", "quality", "workspace"];
const TOOL_VERBS = ["status", "edit", "check", "look", "render", "project", "library", "inspect", "history", "notes"];
// Words agents look up as ops that are a tool's action or another topic.
const NOT_OPS = {
  import: 'project {action:"import", file}', transcribe: 'inspect {targets:["speech:<layer>"]} lists a voice\'s words',
  inspire: 'library {topic:"inspire", search}', needs: 'notes {action:"needs", items}', plan: 'notes {action:"set_plan", steps}',
};
/** Why a word asked as library op is not one, with the call it stands for; null for anything else. */
export function notAnOp(word) {
  const name = String(word ?? "").trim().toLowerCase();
  if (TOOL_VERBS.includes(name)) return `${name} is a tool, not an edit op: call ${name} {...} itself; its fields are in its description.`;
  return NOT_OPS[name] ? `${name} is not an edit op: ${NOT_OPS[name]}.` : null;
}

export function searchGuide(search) {
  const needle = String(search ?? "").trim().toLowerCase();
  if (!needle) throw new AgentError("bad_input", "search needs a word, such as move.");
  const words = [...new Set(needle.split(/[^a-z0-9_-]+/).filter((word) => word.length > 1 && !SEARCH_SKIP.has(word)))];
  if (!words.length) words.push(needle);
  // A word also matches its plain stem, so "synced" finds "sync" and "reveals" finds "reveal".
  const forms = words.map((word) => [...new Set([word, word.replace(/(ed|ing|es|s)$/, "")])].filter((form) => form === word || form.length > 3));
  const score = (text) => (text.includes(needle) ? words.length + 1 : 0) + forms.filter((list) => list.some((form) => text.includes(form))).length;
  // A word in a topic's name or title counts once more than a word only in its text.
  const rank = (entries, textOf, titleOf = () => "") => entries.map((entry) => [entry, score(textOf(entry)), score(titleOf(entry))])
    .filter(([, points]) => points > 0).sort((a, b) => b[1] + b[2] - a[1] - a[2]).map(([entry]) => entry);
  const allOps = [...OPERATION_TYPES, ...SERVICE_OPERATION_TYPES, ...REACH_OPERATIONS];
  const ops = rank(allOps, (type) => type).slice(0, SEARCH_SHOWN);
  const topics = rank(guideTopics(), (entry) => `${entry.title}\n${entry.text}`.toLowerCase(), (entry) => `${entry.id} ${entry.title}`.toLowerCase());
  // What the words describe ("bloom", "subtitles"), as the kino names that make it (seen-names.mjs).
  const names = seenNames(needle, { ops: allOps });
  if (!ops.length && !topics.length && !names.length) return `Nothing mentions "${search}". library {topic:"rules"} lists every topic.`;
  // The sentence that holds the most of the words.
  const snippet = (text) => {
    let sentence = "", most = 0;
    for (const part of text.split(/(?<=[.!?])\s+|\n/)) {
      const points = score(part.toLowerCase());
      if (points > most) [sentence, most] = [part, points];
    }
    return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
  };
  const lines = topics.slice(0, SEARCH_SHOWN).map((entry) => `${entry.id} (${entry.title}): ${snippet(entry.text) || snippet(entry.title)}`);
  const more = topics.slice(SEARCH_SHOWN);
  return [
    names.length ? "kino names for it:" : "",
    ...names,
    ops.length ? `ops: ${ops.join(", ")} (library {topic:"op", name})` : "",
    topics.length ? `topics (library {topic:"rules", name} reads one):` : "",
    ...lines,
    more.length ? `…and ${more.length} more: ${more.slice(0, SEARCH_MORE).map((entry) => entry.id).join(", ")}${more.length > SEARCH_MORE ? ", …" : ""}` : "",
  ].filter(Boolean).join("\n");
}

// One operation's line and the names of its guide topics (full:true adds every topic's text).
function operationHelp(type, full) {
  const sections = describeOperation({ type }).split("\n\n");
  if (full) return guideText(sections.join("\n\n"));
  const topics = sections.slice(1).map((section) => /^## ([^\s:]+): (.+)/.exec(section)).filter(Boolean).map(([, id, title]) => `${id} (${title})`);
  const more = sections.at(-1).startsWith("More topics match") ? sections.at(-1).replace(/^.*?:\s*/, "").replace(/\.$/, "") : "";
  return [sections[0], topics.length || more ? `Rules: library {topic:"rules", name} for ${[...topics, more].filter(Boolean).join(", ")}. full:true sends them all.` : ""].filter(Boolean).join("\n");
}

const SET_FONT_RULES = "set_font {layerIds or layerId, family, weight?, style?}: sets the font of text layers, downloading it first when needed; other layers in the list are skipped and named in the receipt's notes. A font that lacks a character of the text (such as \"∞\") is refused; the refusal names fonts that have it and gives \"instead\", the ops to send in its place: set_font for the layers that are fine and, for each layer that lacks a character, an update_layer op that keeps the font and draws only those characters in another (a textStyleRanges range).";

// The rules sent with a refusal: the op's fields in one line (with `example`, a working op, beside
// them). library {topic:"op", name} has every rule.
function rulesFor(type) {
  const signature = signatureFor(type);
  return signature ? `${signature} (library {topic:"op", name:"${type}"} has every rule)` : undefined;
}

// A refusal's working example: the one the problem came with, or the op's usual one.
function exampleOf(type, error, layer, moveName = error?.moveName) {
  if (error?.noExample) return undefined;
  if (error?.example) return error.example;
  return exampleFor(type, layer, moveName) ?? undefined;
}

// A refused effect setting (add_animation {effect, parameters}): the same op without that
// setting, so it takes the effect's default and sending next as given keeps the effect.
function effectSettingRetry(type, operation, error) {
  const parameters = operation?.parameters;
  if (type !== "add_animation" || typeof operation?.effect !== "string" || !parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
  const name = /\bparameters\.(\w+)/.exec(error instanceof Error ? error.message : String(error))?.[1];
  if (!name || !Object.hasOwn(parameters, name)) return undefined;
  const { [name]: _refused, ...kept } = parameters;
  return { ...operation, parameters: kept };
}

// The answer to library {topic:"op", name}: the rules, then one working example (and, for a
// use that is easy to get wrong, another on a line of its own: "Effect: {…}").
function withExample(type, text) {
  const example = exampleFor(type);
  if (!example) return text;
  return [text, `Example: ${JSON.stringify(example)}`, ...moreExamplesFor(type).map(({ label, op }) => `${label}: ${JSON.stringify(op)}`)].join("\n");
}

// library {topic:"op", name:"add_animation"}: what each property preset animates, and how to
// send the values to reach.
function propertyPresetHelp() {
  const values = Object.keys(PRESET_VALUE_KEYS).filter((id) => PRESET_SAMPLE_TO[id])
    .map((id) => `${id}${PRESET_LAYER[id] ? ` (${PRESET_LAYER[id]})` : ""} ${JSON.stringify(PRESET_SAMPLE_TO[id])}`);
  const example = { op: "add_animation", layer: "title", animation: { kind: "custom", name: "Move", start: 0, duration: 1, from: { x: 100 }, to: PRESET_SAMPLE_TO.move } };
  return [
    `Chosen values: animation {kind:"custom" ("in"/"out" for an entrance/exit), name, start, duration, from, to}; from left out starts where the layer is drawn at its start. to for each property preset: ${values.join(", ")}.`,
    `Example: ${JSON.stringify(example)}`,
  ].join("\n");
}

/**
 * Builds the service. Everything that touches the server's wider state comes in `deps`:
 * - store, agentState (state.mjs), look (look.mjs), fontCatalog
 * - loadFonts(): the project font registry (bundled, uploaded and downloaded faces)
 * - operationContext(document, operations): { fonts, mediaBySrc, mediaById } for applyOperations
 * - saveDocument(projectId, before, document, expectedRevision, options): saves, records media
 *   use and tells open editors; throws ConflictError when the project moved on
 * - createProject(document), duplicateProject(id), archiveProject(id)
 * - exportBatches, listMedia(), pointing(projectId), emit(projectId, event)
 * - live: who is calling and what about, for the dashboard's live view (live.mjs)
 * - agentDirectory: where the service keeps its own files (current project, renders)
 * - voiceMedia: makes voice and background media for isolate_voice (backend/voice/media.mjs)
 * - cutoutMedia: makes subject, matte and silhouette media for cut_out (backend/cutout/media.mjs)
 */
export function createAgentService(deps) {
  const { store, agentState, look, fontCatalog, loadFonts, operationContext, exportBatches, agentDirectory } = deps;
  const now = deps.now ?? Date.now;
  const quality = deps.quality ?? createQualityChecker({ mediaRoot: deps.mediaRoot, renderFrames: deps.renderFrames ?? renderSceneFrames,
    // screen_unreadable: a video measured before kino read its picture facts gets them once.
    videoFacts: deps.videoFacts ?? null,
    // reference_drift: the project's saved Inspire references, measured like a render.
    references: deps.inspire ? (projectId) => deps.inspire.savedFingerprints(projectId) : null,
    // reference_closeness: the saved references' lent cuts (an edit must not copy their order).
    rhythms: deps.inspire?.savedRhythms ? (projectId) => deps.inspire.savedRhythms(projectId) : null,
    // seen_before: what kino rendered in other projects (house-memory.mjs).
    house: deps.house ? (projectId, name) => deps.house.others(projectId, name) : null,
    measureRender: deps.measureRender ?? null });
  // The building-block ops (recipe, compose, place, set_cue, …) and relative times (blocks.mjs).
  const blocks = createBlockRunner({ fontsFor: (document) => fontsFor(document), listMedia: async () => (await deps.listMedia?.()) ?? [], fontCatalog, operationContext,
    deckDeals: (document, count) => nextDecks(document.id, document, count),
    pictureAlpha: (src) => pictureAlpha(deps.mediaRoot, src),
    // impact-accent: a clip's measured impacts and light (footage/events.mjs, kept beside the file).
    clipEvents: (src) => clipEventsOf(src),
    // compose {footage}: the material's measures, the deck it is cut with, and its ops applied.
    footageFacts: (document, input) => footageFacts(document, input), footageDeck: (document, options) => footageDeck(document, options),
    runOps: (document, ops) => runOps(document, ops),
    // frame_shot: the faces saved for a layer's file, the ones check reads (never a new decode).
    subjectSamples: async (layer) => {
      let file;
      try { file = mediaFileOf(layer); } catch { return []; }
      return ((await usableSubjects(file)) ?? (await peopleCache.saved(file)))?.samples ?? [];
    },
    // A board shot's move.ref: the project's saved references and their keys, so a refusal can name what is accepted now (null without inspire).
    savedRefs: (document) => (deps.inspire?.savedKeys ? deps.inspire.savedKeys(document.id).catch(() => null) : null),
    // Every recipe, move or compose takes the type the brief's style spec names; a picked type with no fonts yet is named in the receipt.
    styleType: async (document) => {
      const brief = (await agentState.read(document.id).catch(() => null))?.brief;
      return { fonts: brief?.style?.fonts ?? null, type: brief?.style?.type ?? pickedType(brief?.treatments) };
    } });
  // detect_beats: decoded and analysed sound, kept in a .beats file beside each media file.
  const beatAnalysis = deps.beatAnalysis ?? createBeatAnalysisCache();
  // fit_music: the song's sections (song-shape.mjs), kept in a .song file beside each media file.
  const songShapes = deps.songShapes ?? createSongShapeCache();
  // speech_cut hears each cut: the waveform peaks the Timeline draws, in a .peaks file beside each media file.
  const audioPeaks = deps.audioPeaks ?? createAudioPeaksCache();
  // Each sound file's loudness in LUFS over time (duck_audio's depth, the measured sound rules).
  const loudnessCurves = deps.loudnessCurves ?? createLoudnessCurves();
  // cut_speech, add_captions {speech} and inspect speech:<layer>: a word transcript of the voice
  // (whisper.cpp on this computer), kept beside each media file.
  // whisper is told the names of the project's brief (backend/speech/name-hint.mjs), so it spells
  // "Zuri" instead of hearing "David"; a transcript is kept per file and names. Each read passes
  // the document and the layer: a voice cut_speech cut keeps reading the transcript its cuts
  // were made on (speechNamesFor), so new names never move its cuts.
  const transcriptCache = deps.transcripts ?? createTranscriptCache();
  async function namesOf(document, layer) {
    if (!document || !layer) return { names: [], pinned: false };
    const brief = (await agentState.read(document.id).catch(() => null))?.brief ?? null;
    return speechNamesFor(document, brief, layer.src);
  }
  // A sound effect's transcript is empty, without running whisper (isSoundEffect).
  const effectTranscript = () => ({ version: TRANSCRIPT_VERSION, words: [], effect: true, cached: true });
  const transcripts = {
    /** The transcript of `file` (the sound `layer` of `document` plays), made when there is none. */
    get: async (file, document, layer) => (await isSoundEffect(file)) ? effectTranscript() : transcriptCache.get(file, { names: (await namesOf(document, layer)).names }),
    /** The saved one, or null: never transcribes. `any`: one heard with older names counts too. */
    saved: transcriptCache.saved ? async (file, document, layer, { any = false } = {}) => {
      if (await isSoundEffect(file)) return effectTranscript();
      const { names, pinned } = await namesOf(document, layer);
      return transcriptCache.saved(file, { names, exact: pinned, any });
    } : undefined,
  };
  // compose {footage}: each clip's faces, motion and text, and each sound's loudness, kept beside the file.
  const footageCache = deps.footageCache ?? createFootageCache();
  // The people in each clip (head_cut_off, overlay_covers_subject), in a .people-v1 file beside it.
  const peopleCache = deps.peopleCache ?? createPeopleCache();
  // A file's saved .subjects-v1 when saliency ran on it. A header that says saliency did not run
  // (saliency is not true) is not measured: an empty subjects list there is not "nothing stands
  // out", so its readers fall back to the faces in people-v1 and mark nothing as salient.
  const usableSubjects = async (file) => {
    const saved = await peopleCache.savedSubjects?.(file).catch(() => null);
    return saved?.saliency === true ? saved : null;
  };
  // library {topic:"footage"}: found video for the project (deps.footage is footage-finder/index.mjs).
  // The subject's origin ({word, about}) of the footage call running, so a search keeps the edit
  // uploads that carry the word (footage-finder/search.mjs isOriginEdit).
  const footageOrigin = new AsyncLocalStorage();
  const originFinder = deps.footage ? { ...deps.footage, search: (words, options) => deps.footage.search(words, { ...options, origin: footageOrigin.getStore() ?? null }) } : null;
  const footageActions = deps.footage ? createFootageActions({ finder: originFinder, ...(deps.footageWaitMs !== undefined ? { waitMs: deps.footageWaitMs } : {}) }) : null;
  // The footage step in status shows only once the tool schema takes the topic (LIBRARY_TOPICS
  // gains "footage" with importing), so its next call validates; deps.footageStep sets it in tests.
  const footageStepShown = deps.footageStep ?? LIBRARY_TOPICS.includes("footage");
  const footageFacts = createFootageFacts({ listMedia: async () => (await deps.listMedia?.()) ?? [], mediaRoot: deps.mediaRoot, transcripts, beatAnalysis, footageCache, songShapes, peopleCache });
  // sync_clips: each file's sound curves, kept in a .sync file beside it.
  const syncCurves = deps.syncCurves ?? createSyncEnvelopeCache();
  const manageWorkspace = createReachWorkspace(deps);
  // Judge rounds (judge.mjs): the person picks blind between edit and reference frames.
  const judge = createJudge({ agentState, inspire: deps.inspire, directory: path.join(agentDirectory, "judge"), emit: (...args) => deps.emit?.(...args),
    editFrame: async (document, sceneId, time, width) => (await look.frame(await prepare(document, sceneId, await fontsFor(document)), time, width)).png });
  // Try rounds (tries.mjs): 2 to 4 versions of one moment of the video; the person picks one.
  const tries = createTries({ agentState, directory: path.join(agentDirectory, "try"), emit: (...args) => deps.emit?.(...args),
    documentWith: (record, ops) => documentWith(record, ops),
    renderClip: async (document, sceneId, from, to, outputPath) => look.clip(await prepare(document, sceneId, await fontsFor(document)), { from, to, outputPath }) });
  // The blind pick box (picks.mjs): two videos side by side; the person picks, the ladder reads picks.jsonl.
  const picks = createPicks({ directory: deps.tasteDirectory ?? path.join(agentDirectory, "taste"), mediaRoot: deps.mediaRoot,
    emit: (view) => deps.emit?.(null, { kind: "picks", picks: view }) });
  const manageExports = createReachExports({ exportBatches, agentDirectory, fontsFor, draftWidth: () => deps.renderDefaults?.()?.draftWidth, async checkFinal(document, sceneIds, options) {
    const fonts = await fontsFor(document);
    const codes = await syncCodes(document.id, document);
    for (const sceneId of sceneIds) {
      const { findings } = await findingsFor(document, { fonts, codes, sceneId, pixels: true, outputFps: parseFps(options?.fps) ?? 30 });
      const real = await isRealEdit(document);
      const errors = findings.filter((finding) => blocksFinal(finding, real));
      if (errors.length) throw new AgentError("check_failed", `${errors.length} open findings block final export of ${refName(sceneId, codes)}: ${openFindingLines(errors).join("; ")}. Run check, fix each or waive it with a reason.`);
    }
  } });
  const renders = new Map();
  const RENDERS_KEPT = deps.rendersKept ?? 100;
  let renderStateLoaded, nextRenderId = 1;
  let renderStateWrite = Promise.resolve();
  const refused = new Map();
  let refusedCount = 0;
  // Projects whose check has shown its rules line since kino started.
  const checkRulesShown = new Set();
  // A caller's last plain check per project ({ask, rev, body, at}), so the same check again on
  // the same revision answers in one line (repeatedCheck).
  const lastChecks = new Map();
  let current = null;
  // Who made the call that is running (meta.by is "you" for a person).
  const caller = new AsyncLocalStorage();
  const byYou = () => caller.getStore()?.by === "you";
  // The live view (milestone LIVE): a handler notes what its call is about (`where`, as
  // labels.mjs callTarget takes it) and, for a look, what it covered (live.mjs coveredLayers).
  function noteLive(where, covers) {
    const live = caller.getStore()?.live;
    if (!live) return;
    live.where = where;
    if (covers) live.covers = covers;
  }
  // A look notes the revision it draws: only saves in it count as looked at (live.mjs looked).
  function noteDrawn(record) {
    const live = caller.getStore()?.live;
    if (live) live.drew = { rev: record.revision, document: record.document };
  }
  // The agent that asked, for what is saved with its id (an approval): with this server run's
  // boot, so a restart never hands the wait to the agent that gets the same id next.
  const savedAgent = (meta) => (meta.live && !meta.live.replay ? { ...meta.live.agent, boot: deps.live.boot ?? null } : meta.agent ?? null);

  // ---- current project ------------------------------------------------------------------
  const currentFile = path.join(agentDirectory, "current.json");
  async function readCurrent() {
    if (current) return current;
    try { current = JSON.parse(await readFile(currentFile, "utf8")).project ?? null; } catch { current = null; }
    return current;
  }
  async function setCurrent(projectId) {
    current = projectId;
    await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${currentFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, compact({ project: projectId }), { mode: 0o600 });
    await rename(temporary, currentFile);
  }

  async function projectFor(input, { open = true } = {}) {
    const wanted = input.project ?? (open ? await readCurrent() : null);
    if (!wanted) throw new AgentError("no_project", "No project is open. Call status to list projects, then project open, or project create.");
    let record = await store.getProject(String(wanted));
    if (!record) {
      const projects = await store.listProjects();
      // A project's name works like its ID when one project has it (project open ride).
      const named = projects.filter((project) => String(project.name ?? "").trim().toLowerCase() === String(wanted).trim().toLowerCase());
      if (named.length === 1) record = await store.getProject(named[0].id);
    }
    if (!record) {
      const projects = await store.listProjects();
      const suggestions = closest(String(wanted), projects.flatMap((project) => [project.id, project.name])).slice(0, 3);
      throw new AgentError("unknown_project", `No project "${wanted}".`, { didYouMean: suggestions });
    }
    if (record.trashedAt) throw new AgentError("archived", `Project "${wanted}" is archived. Restore it in the dashboard first.`);
    // The dashboard and every read (meta.keepCurrent) look at a project without switching the agent's open one.
    if (input.project && input.project !== current && !caller.getStore()?.keepCurrent) await setCurrent(record.document.id);
    return record;
  }

  // Short codes for everything in the document (saved, so a code keeps its meaning).
  function syncCodes(projectId, document) {
    return agentState.update(projectId, (state) => (state.codes = assignCodes(state.codes, document)));
  }

  // Every check finding: the render checks and the quality rules. `pixels` adds the rules that
  // render frames (contrast, flashing, luma_jump, frozen_picture); edit receipts and status leave them out to stay fast,
  // except on scenes check saw unchanged. `unchecked` is "all" or the names of the scenes whose
  // rendered rules are not in the findings (checkSummary says so).
  // listen:false (the dashboard's own check) renders frames for the pixel rules but reads only
  // saved transcripts, peaks, loudness and people: no whisper and no sound or people decodes.
  // A real edit (realEdit in brief.mjs): every open warning holds its final render, not only the
  // errors (blocksFinal). A long video made of text cards over clips is a real edit too, not a
  // rough pass; a one-card sketch is not.
  async function isRealEdit(document) {
    const state = await agentState.read(document.id).catch(() => null);
    return realEdit(state, videoFacts(document));
  }

  async function findingsFor(document, { fonts, codes, sceneId = null, pixels = false, rules = null, outputFps = 30, listen = true } = {}) {
    const basic = checkDocument(document, { fonts, mediaRoot: deps.mediaRoot, codes, sceneId });
    // The brief's style spec (notes brief fields.style) sets the style rules; none is kino's default style.
    const saved = await agentState.read(document.id).catch(() => null);
    // A picked treatment's ending rides along (styleContext ending): template_end quotes it.
    const ending = saved?.brief?.style ? pickedEnding(saved.brief.treatments) : null;
    const styleSpec = ending ? { ...saved.brief.style, ending } : saved?.brief?.style ?? null;
    // The project's deck (notes deck): deck_unused counts the cards the video uses.
    const deck = saved?.deck ?? null;
    // Font families the brief names (in any field): off_brand_font holds the texts to them.
    const briefFonts = briefFontFamilies(saved?.brief?.fields, fonts);
    // speech_cut reads each heard sound's word transcript: the saved one, and a full check
    // (pixels) transcribes a file that has none yet.
    // A song (a file kino found a steady beat in) is music, not speech: its lyrics are not checked.
    const transcriptOf = async (layer, { make: asked }) => {
      const make = asked && listen;
      const file = mediaFileOf(layer);
      if (await soundIsMusic(layer, file, { listen: make, beats: beatAnalysis })) return { music: true };
      return make ? transcripts.get(file, document, layer) : transcripts.saved?.(file, document, layer) ?? null;
    };
    // And hears each cut: the file's waveform peaks (saved ones; a full check makes them).
    const loudnessOf = async (layer, { make: asked }) => {
      const make = asked && listen;
      const file = mediaFileOf(layer);
      return make ? audioPeaks.get(file) : audioPeaks.saved?.(file) ?? null;
    };
    // The brief's length (notes brief fields.length): the assertions gate holds the video to it.
    const length = lengthTarget(saved?.brief);
    // And finds the people in each clip (saved ones; a full check finds them).
    const peopleOf = async (layer, { make: asked }) => {
      const make = asked && listen;
      // A clip outside kino's media library (a link, a test file) is not measured.
      let file;
      try { file = mediaFileOf(layer); } catch { return null; }
      // The saved subjects (.subjects-v1) hold the same faces and people as .people-v1 plus where
      // the eye goes; they are read first. Never a new decode for them: a clip with no saved
      // subjects is measured only where people-v1 is (a full check), which saves both.
      const subjects = await usableSubjects(file);
      if (subjects) return subjects;
      if (!make) return peopleCache.saved(file);
      let record = null;
      try { record = JSON.parse(await readFile(`${file}.json`, "utf8")); } catch { record = null; }
      if (!(record?.width > 0 && record?.height > 0)) return null;
      const found = await peopleCache.get(file, { width: record.width, height: record.height, duration: record.duration });
      return (await usableSubjects(file)) ?? found;
    };
    // And the measured loudness in LUFS (voice_under_bed, voice_level_spread): saved ones; a full check measures.
    const levelsOfLayer = async (layer, { make: asked }) => {
      const make = asked && listen;
      const file = mediaFileOf(layer);
      return make ? loudnessCurves.get(file) : loudnessCurves.saved(file);
    };
    // A song's vocal spans (.song file, never a new measure): reference_range asks whether a voice plays before the loudest change.
    const voiceOf = async (layer) => {
      const shape = await songShapes.saved?.(mediaFileOf(layer));
      return shape?.vocals === "whisper" && Array.isArray(shape.voice) ? shape.voice : null;
    };
    const asks = askedItems(saved);
    const checked = await quality.check(document, { fonts, codes, sceneId, pixels, outputFps, styleSpec, deck, briefFonts, length, asks, transcriptOf, loudnessOf, levelsOf: levelsOfLayer, voiceOf, peopleOf, soundSearch: songSearchOn(), origin: saved?.origin ?? null, playsOn: saved?.brief?.fields?.plays_on ?? null });
    const findings = mergeFindings(basic, checked.findings, { document, codes });
    const missed = checked.unchecked ?? [];
    const unchecked = missed.length && missed.length === checked.scenes ? "all" : missed.map((id) => refName(id, codes));
    return { findings: rules ? findings.filter((finding) => rules.includes(finding.rule)) : findings, notes: checked.notes, ms: checked.ms, unchecked, techniques: checked.techniques ?? {}, styleSpec, stale: checked.stale ?? [] };
  }

  // The project's waivers that still silence a finding (stale ones left out): what the waived
  // counts at a stop and at the final render count.
  async function waiversInUse(document) {
    const codes = await syncCodes(document.id, document);
    const { stale } = await findingsFor(document, { fonts: await fontsFor(document), codes }).catch(() => ({ stale: [] }));
    return liveWaivers(document.checkWaivers, stale);
  }

  // What the person asked for, in their own words, for request_unmet: the brief lines they said
  // (by "you"; never is checked the other way round) and their notes still open.
  function askedItems(saved) {
    const fields = saved?.brief?.fields ?? {};
    const brief = ["message", "look_sound", "key_moment", "never"].filter((name) => fields[name]?.by === "you")
      .map((name) => ({ id: `brief ${name}`, field: name, text: fields[name].quote || fields[name].text }));
    const notes = (saved?.notes ?? []).filter((note) => note.from === "you" && note.text && !["dismissed", "rejected", "deleted"].includes(note.status))
      .map((note) => ({ id: note.id, note: true, text: note.text }));
    return [...brief, ...notes];
  }

  // The loaded font families the brief's fields name ("captions in JetBrains Mono"), longest first.
  function briefFontFamilies(fields, fonts) {
    const said = Object.values(fields ?? {}).map((field) => String(field?.text ?? "")).join("\n").toLowerCase();
    if (!said.trim()) return [];
    const families = [...new Set((fonts?.faces ?? []).map((face) => face.family).filter(Boolean))].sort((a, b) => b.length - a.length);
    return families.filter((family) => new RegExp(`(^|[^a-z])${family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(said));
  }

  // Fonts as the renderer sees them: downloads catalog faces the document uses.
  async function fontsFor(document) {
    const fonts = await loadFonts();
    await ensureDocumentFonts(document, fontCatalog, { allowMissing: true, fonts });
    return fonts;
  }

  function sceneFor(document, codes, ref, fallback) {
    if (ref == null || ref === "") return document.scenes.find((scene) => scene.id === fallback) ?? document.scenes[0];
    const id = createResolver(document, codes).resolve(String(ref), "scene");
    return document.scenes.find((scene) => scene.id === id);
  }

  // ---- turn bookkeeping and the inbox ---------------------------------------------------
  // Runs after every project verb: counts the call in the current turn, records an edit, and
  // takes the inbox (your notes and actions since the agent's last call) to hand over.
  // A call made by the person (by:"you") is not the agent's: it leaves the turns, the inbox
  // and what the agent has seen alone, and only applies `change` when it is `shared` (a revert
  // notice for the agent, a new plan).
  // The step open when this call arrived (answer's openStepOf) gets the call in the step log
  // (step-log.mjs). Once per call: a handler that finishes twice still counts one call.
  function logOpenStep(state) {
    const open = caller.getStore()?.openStep;
    if (!open || open.logged) return;
    open.logged = true;
    state.stepLog = logCall(state.stepLog, open.name, open.at, now());
  }

  async function finishCall(projectId, { edit, change, shared = false } = {}) {
    // A call you approved in the dashboard runs again for the agent (meta.approved): its edit
    // belongs to the agent's turn, and the inbox stays for the agent's own next call.
    if (caller.getStore()?.approved) {
      return agentState.update(projectId, (state) => {
        const turn = currentTurn(state, now());
        turn.calls += 1;
        if (edit) turn.edits.push(edit);
        logOpenStep(state);
        change?.(state);
        return { turn: turn.id, inbox: [] };
      });
    }
    if (byYou()) {
      if (change && shared) await agentState.update(projectId, (state) => { change(state); });
      return { turn: null, inbox: [] };
    }
    const delivered = [];
    const finished = await agentState.update(projectId, (state) => {
      const turn = currentTurn(state, now());
      turn.calls += 1;
      if (edit) turn.edits.push(edit);
      logOpenStep(state);
      change?.(state);
      // A line for one agent (a helper's hand-back to its lead, crew.mjs) waits for that agent's
      // own call; every other line goes to the agent that calls next.
      const me = caller.getStore()?.live?.agent?.id ?? null;
      const inbox = state.inbox.filter((item) => !item.agentId || item.agentId === me);
      state.inbox = state.inbox.filter((item) => item.agentId && item.agentId !== me).slice(-INBOX_FOR_OTHERS_KEPT);
      for (const item of inbox) {
        const note = item.noteId && state.notes.find((entry) => entry.id === item.noteId);
        if (note && note.status === "new") { note.status = "seen"; delivered.push(structuredClone(note)); }
        // The agent has the person's dashboard answer to this stop now: the stop lines say so.
        const answer = item.stopId && state.stops?.find((round) => round.id === item.stopId)?.answer;
        if (answer && !answer.heardAt) answer.heardAt = new Date(now()).toISOString();
      }
      return { turn: turn.id, inbox: inbox.map((item) => item.text) };
    });
    // The dashboard shows these notes as delivered.
    for (const note of delivered) await deps.emit?.(projectId, { kind: "note", note });
    return finished;
  }

  // Ends a project verb: records the call and attaches the inbox to the answer.
  async function done(projectId, reply, options) {
    return { ...reply, project: projectId, finish: await finishCall(projectId, options) };
  }

  // ---- approvals (plan §5.7, decision D3) --------------------------------------------------
  // `kinds` lists what this call does that may need your approval ({kind, summary, targets?}).
  // `targets` are the ids of the scenes or projects a delete removes, as the summary names them.
  // Returns null to go ahead, or the answer for the agent: {status:"awaiting_approval", id} at
  // once (the agent never waits on a blocked call). Throws when your rules deny it. Calls made
  // from the dashboard (meta.reviewed) go ahead. The approved call itself (meta.approved, with
  // the targets you saw in meta.approvedTargets) goes ahead only as far as you approved it: if
  // it would now delete a scene or project the approval did not name, it asks again.
  // `rev` is the revision a render draws. The request names it, and the approved render runs
  // only on that revision: after an edit it asks again, so it never draws one you did not see.
  // notes {action:"judge"}: the agent starts a blind round (the counts arrive in its inbox); the
  // person's picks come from the dashboard as {action:"judge", round, pair, pick}.
  async function notesJudge(record, input, meta) {
    const projectId = record.document.id;
    if (input.pick !== undefined || input.pair !== undefined) {
      if (meta.by !== "you") throw new AgentError("bad_input", "Only the person picks, on the dashboard: the round is blind. Keep working; the counts arrive in your inbox.");
      let round;
      try { round = await judge.pick(projectId, { id: String(input.round ?? ""), n: Number(input.pair), pick: input.pick }); }
      catch (error) { throw new AgentError("bad_input", error.message); }
      return done(projectId, { text: `${round.id} pair ${input.pair}: ${input.pick}${round.status === "done" ? " · done" : ""}`, data: { judge: roundView(round) } });
    }
    if (!(await judge.hasSaved(projectId)))
      throw new AgentError("bad_input", `judge needs a saved reference: ${saveReference(await findSearchFor(projectId))}.`);
    const { round, existing } = await judge.start(record, { by: meta.by === "you" ? "you" : "agent" });
    const text = existing && round.status === "done" ? resultText(round)
      : `judge ${round.id} ${existing ? "is already" : "started"} for rev ${round.rev}: the person picks blind on the dashboard; the counts arrive in your inbox. Keep working.`;
    return done(projectId, { text, data: { id: round.id, rev: round.rev, status: round.status } });
  }

  // notes {action:"try", question, at, options:[{name, ops}], scene?, topic?, later?}: the agent
  // asks the person to pick one version of a moment (tries.mjs); the person's answer comes from
  // the dashboard as {action:"try", round, pick, note?} and reaches the agent's inbox.
  async function notesTry(record, input, meta) {
    const projectId = record.document.id;
    if (input.pick !== undefined || input.round !== undefined) {
      if (meta.by !== "you") throw new AgentError("bad_input", "Only the person picks, on the dashboard. Keep working; their pick arrives in your inbox.");
      let round;
      try { round = await tries.answer(projectId, { id: String(input.round ?? ""), pick: input.pick, note: input.note }); }
      catch (error) { throw new AgentError("bad_input", error.message); }
      return done(projectId, { text: `${round.id}: ${round.pick}`, data: { tries: triesView(await agentState.read(projectId)) } });
    }
    let round;
    try { round = await tries.start(record, input, { by: meta.by === "you" ? "you" : "agent" }); }
    catch (error) { throw new AgentError("bad_input", error.message, { safeToRetry: true }); }
    const text = `try ${round.id} started: ${round.options.length} options of ${round.from} to ${round.to} s render one by one; the person picks on the dashboard and the pick arrives in your inbox (with the ops to apply). Keep working on other parts.`;
    return done(projectId, { text, data: { id: round.id, rev: round.rev, status: round.status, options: round.options.map((option) => option.letter) } });
  }

  async function approvalFor(kinds, projectId, verb, input, rev) {
    const meta = caller.getStore() ?? {};
    const changed = rev !== undefined && meta.approvedRev !== undefined && meta.approvedRev !== rev;
    const approved = new Set(changed ? [] : meta.approved ?? []);
    const covered = (entry) => {
      if (!approved.has(entry.kind)) return false;
      if (!entry.targets) return true;
      const seen = new Set(meta.approvedTargets?.[entry.kind] ?? []);
      return entry.targets.every((id) => seen.has(id));
    };
    const needed = kinds.filter((entry) => entry && !covered(entry));
    if (!deps.approvals || meta.reviewed || !needed.length) return null;
    // A final render asks: a judge round starts by itself (judge.mjs auto).
    if (needed.some((entry) => entry.kind === "final-render")) store.getProject(projectId).then((record) => judge.auto(record)).catch(() => {});
    const answer = await deps.approvals.request({ kinds: needed, projectId, verb, input, client: meta.client ?? null, agent: savedAgent(meta), rev });
    if (answer.status === "allowed") return null;
    if (answer.status === "denied")
      throw new AgentError("denied", `The person's approval rules deny ${answer.summary}.`, { kind: answer.kind, next: "Do not retry. Leave a note (notes add) if you need it." });
    const data = { status: "awaiting_approval", id: answer.id, summary: answer.summary,
      ...(answer.rev === undefined ? {} : { rev: answer.rev }), ...(answer.replaced ? { replaced: answer.replaced } : {}),
      next: `Tell the person it waits for them: they answer it in the kino app or in the chat (record a chat answer with notes {action:"answer", id:"${answer.id}", words:"<their words>", read_as:"approve"}). ${answer.rev === undefined ? "" : `Allowing it renders rev ${answer.rev}; after an edit it asks again. `}Keep working or end your turn; the answer arrives in your inbox. Do not poll: render {action:"wait", job:"${answer.id}"} blocks until they answer (up to 55 s). {action:"cancel", job:"${answer.id}"} withdraws it.` };
    // An allowed call that would now do more than its approval named, or render a newer
    // revision: the dashboard shows this text as that approval's result, and the agent reads it
    // in its inbox.
    const text = !meta.approved ? compact(data)
      : changed ? `Not run: the project changed since ${meta.approvedId} (rev ${meta.approvedRev}, now rev ${rev}), so it asks again as ${answer.id}: ${answer.summary}`
        : `Not run: it would now do more than the approval named, so it asks again as ${answer.id}: ${answer.summary}`;
    return done(projectId, { text, data });
  }

  // While you hold agent writes (H in the dashboard), these calls answer {held:true} instead;
  // while a stop waits for you, they answer {waiting} for that project (waitingFor).
  function isWrite(verb, input) {
    const action = input?.action;
    if (verb === "edit") return input?.dry_run !== true;
    // fix:true is fix:"auto" (check turns it into that after this ran).
    if (verb === "check") return input?.fix === "auto" || input?.fix === true;
    if (verb === "history") return ["revert", "restore"].includes(action);
    if (verb === "render") return (action ?? "start") === "start";
    // manage: everything but reading (list, status, wait, peaks, CSV template and review).
    if (verb === "project" && action === "manage") return !["list", "status", "wait", "peaks", "template", "review"].includes(input?.options?.action);
    if (verb === "project") return ["create", "duplicate", "archive", "share", "import"].includes(action);
    return false;
  }

  // project open and create set the open project themselves; archive, share and duplicate act on
  // another project without opening it.
  function opensProject(verb, input) {
    return isWrite(verb, input) && !(verb === "project" && ["archive", "share", "duplicate"].includes(input?.action));
  }

  async function heldReply(input) {
    const hold = deps.hold?.() ?? {};
    const data = { held: true, note: hold.note || "The person paused agent writes in the kino dashboard (hold).",
      next: "Nothing was changed. Reads (status, look, check, inspect, library, notes) still work; your inbox says when the hold is released." };
    const projectId = typeof input.project === "string" ? input.project : await readCurrent();
    const known = projectId ? await store.getProject(String(projectId)).catch(() => null) : null;
    if (!known || known.trashedAt) return { text: compact(data), data };
    deps.heldCall?.(known.document.id);
    return done(known.document.id, { text: compact(data), data });
  }

  // ---- stops (stops.mjs, direction plan §6) -------------------------------------------------
  // The person's stop rules: ask or allow, and the skip-under lengths, from their settings.
  const stopRulesNow = () => stopRules(deps.approvals?.rules?.(), deps.approvals?.limits?.());
  // too_fast measures the time since an ask on the computer's steady clock, saved with the round
  // as {at, boot}: the wall clock can jump by seconds (on the Windows PC, WSL 2 steps it back half
  // a second every few seconds and spikes 8 s ahead), which would refuse a real answer or let a
  // quick one through. The steady clock counts from boot, so it holds across a kino restart;
  // after a reboot (boot moved) the round's askedAt is used. Tests with their own clock use it,
  // or their own steady clock (deps.steadyNow) to show a wall clock jump changes nothing.
  const steadyNow = deps.steadyNow ?? deps.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const bootedAt = deps.steadyNow || deps.now ? 0 : Date.now() - uptime() * 1000;
  const sameBoot = (boot) => Math.abs(boot - bootedAt) < 120_000;
  const roundOf = (draft, id) => draft.stops?.find((round) => round.id.toLowerCase() === String(id ?? "").trim().toLowerCase());

  // The stop a write would go past: { projectId, round } when the call's project has a stop
  // waiting for the person's answer, else null. The call's project is the one it names (project
  // calls name it with id), or the open one. project create names a new project, so it never waits.
  async function waitingFor(verb, input) {
    if (verb === "project" && input.action === "create") return null;
    const named = verb === "project" ? input.id ?? input.project : input.project;
    const projectId = named == null ? await readCurrent() : String(named);
    if (!projectId) return null;
    const known = await store.getProject(projectId).catch(() => null);
    if (!known || known.trashedAt) return null;
    const round = await liveStop(known);
    return round ? { projectId: known.document.id, round } : null;
  }

  // The stop waiting on this project (`record` from the store), or null. A waiting stop that no
  // longer stands is closed and saved first (settleWaiting: the person undid or changed the work
  // it showed, the video has no such stop now, or their settings allow it), so the agent is not
  // told to wait for an answer kino would refuse.
  async function liveStop(record) {
    const projectId = record.document.id;
    if (!waitingStop(await agentState.read(projectId))) return null;
    const facts = { video: await videoFactsFor(record.document), rules: stopRulesNow(), rev: record.revision, work: workPrint(record.document), now: now(), board: boardFacts(record.document) };
    return agentState.update(projectId, (draft) => { settleWaiting(draft, facts); return structuredClone(waitingStop(draft)); });
  }

  // videoFacts, where footage also counts clips uploaded to the project but not placed yet, so
  // the storyboard stop asks before the build. Every stop site uses it, so a board round asked on
  // imported clips is not closed elsewhere as "no such stop now". The library is read only while
  // nothing is built and no video layer is placed: a built video counts only placed clips.
  // The size of each distinct video file the video places, from its library record. A screen
  // recording is shaped by the screen, not by how it was filmed, so it is left out as shape_guess does.
  async function footageSizesOf(document) {
    const ids = new Set();
    for (const scene of document.scenes) {
      if (scene.isComponent) continue;
      for (const layer of scene.layers) {
        const id = layer.type === "video" && layer.src && layer.enabled !== false ? mediaIdFromSource(layer.src) : null;
        if (id) ids.add(id);
      }
    }
    if (!ids.size) return [];
    const media = (await deps.listMedia?.().catch(() => [])) ?? [];
    return media.filter((item) => ids.has(item.id) && !item.recording && item.width > 0 && item.height > 0).map((item) => ({ width: item.width, height: item.height }));
  }

  async function videoFactsFor(document) {
    const facts = videoFacts(document);
    if (facts.footage || !notBuilt(document)) return facts;
    return videoFacts(document, (await deps.listMedia?.().catch(() => [])) ?? []);
  }

  // The song this video is about, in the person's words or the song's own title: the song the
  // agent marked as named by the person (library soundtrack song; its title when that was a
  // link or an id), else the longest audio of 20 s or more in this project that is one of its
  // soundtrack candidates (so never a sound effect or an ambience). "" when there is none.
  async function songTitleFor(projectId) {
    const candidates = (await agentState.read(projectId)).soundtrack?.candidates ?? [];
    const media = (await deps.listMedia?.().catch(() => [])) ?? [];
    return songTitleOf(candidates, media.filter((item) => mediaAllowedIn(item, projectId) && String(item.mime ?? "").startsWith("audio/")));
  }

  // The song-free twin of a search the agent sent from the step's filled words: the filled twin,
  // or, when the step left a slot for the subject, the agent's own words before the song's title.
  function songFreeTwin(filled, typed) {
    if (!filled?.withoutSong) return "";
    const sent = String(typed).replace(/\s+/g, " ").trim();
    if (!filled.search.includes(SUBJECT_SLOT)) return filled.search.toLowerCase() === sent.toLowerCase() ? filled.withoutSong : "";
    const tail = filled.search.slice(filled.search.indexOf(SUBJECT_SLOT) + SUBJECT_SLOT.length);
    const subject = sent.toLowerCase().endsWith(tail.toLowerCase()) ? sent.slice(0, sent.length - tail.length).trim() : "";
    return subject ? `${subject} edit` : "";
  }

  // The first inspire search for this video's own words: the step's filled search while the brief
  // names something, else the placeholder the refusals and gates have always shown.
  async function findSearchFor(projectId) {
    const brief = (await agentState.read(projectId)).brief;
    return (hasBrief(brief) ? referenceSearches(brief, await songTitleFor(projectId))?.search : null) ?? "<an edit like yours>";
  }

  // videoFacts plus what the direction step needs about references: how many the project saved
  // (left out when kino has no inspire, so the step is skipped) and whether the check is waived;
  // and about the material: needs {checked} when the video has footage or speech (left out
  // otherwise, or when waived, so the step is skipped).
  async function directionFacts(document) {
    const references = deps.inspire ? await savedReferences(document.id) : undefined;
    const waivers = document.checkWaivers ?? [];
    const referenceWaived = waivers.some((waiver) => waiver.code === REFERENCE_WAIVER && waiver.target === "*");
    const treatmentsWaived = waivers.some((waiver) => waiver.code === TREATMENTS_WAIVER && waiver.target === "*");
    // The order step (brief.mjs orderStep) also wants the saved ids and whether one was studied.
    const saved = references ? await savedIds(document.id) : [];
    const studied = references !== undefined ? ((await agentState.read(document.id)).studied ?? []) : undefined;
    const facts = { ...(await videoFactsFor(document)), references, referenceWaived, treatmentsWaived, saved, studied };
    // The brief's playback compares the frame with the shape of the footage placed (shapeLine).
    const footageSizes = await footageSizesOf(document);
    if (footageSizes.length) facts.footageSizes = footageSizes;
    // The first search is filled from what the person named, while references are still wanted.
    if (references !== undefined && references < REFERENCES_WANTED && !referenceWaived) facts.songTitle = await songTitleFor(document.id);
    // The signature step offers the product's own picture: read the library only while it is next.
    const brief = (await agentState.read(document.id)).brief;
    if (brief?.treatments?.picked && !brief.style?.signatures?.length) facts.picture = await productPicture(document.id);
    // A footage-led brief with no clip in the project (the person's or found): the footage step
    // (footage-finder/step.mjs). Any clip or picture of theirs makes it silent: their media leads,
    // and when the picked who is not in their clips the needs step below is the path (with search
    // on, its drafted item offers finding that footage). It ends once something is built, a plan
    // is set or it is waived. On only while the library
    // offers the footage topic (LIBRARY_TOPICS, which the tool schema checks).
    if (footageActions && footageStepShown && !facts.footage && footageLed(brief)) {
      const state = await agentState.read(document.id);
      const step = { built: !notBuilt(document), planned: Boolean(state.plan?.steps?.length), waived: waivers.some((waiver) => waiver.code === FOOTAGE_WAIVER && waiver.target === "*") };
      if (!step.built && !step.planned && !step.waived) step.personMedia = ((await deps.listMedia?.().catch(() => [])) ?? []).some((item) => item?.projectId === document.id && /^image\//.test(item.mime ?? "") && !isFoundClip(item));
      if (footageStepOn(brief, step)) facts.findFootage = true;
    }
    if (waivers.some((waiver) => waiver.code === NEEDS_WAIVER)) return facts;
    const storied = facts.footage || (await someAsync(document.scenes.filter((scene) => !scene.isComponent), (scene) => hasFootageOrSpeech(scene, document)));
    if (!storied) return facts;
    const checked = Boolean((await agentState.read(document.id)).needs?.checked);
    return { ...facts, needs: { checked, ...(footageSearchOn() ? { search: true } : {}) } };
  }
  // The project's own picture for a signature: its largest screenshot or image (not a logo or
  // icon), else its longest clip, by the library's name; null with neither.
  async function productPicture(projectId) {
    const media = ((await deps.listMedia?.().catch(() => [])) ?? []).filter((item) => mediaAllowedIn(item, projectId) && typeof item.name === "string");
    const images = media.filter((item) => /^image\//.test(item.mime ?? "") && !/svg/.test(item.mime) && !/logo|icon|\b(word)?mark\b/i.test(item.name));
    const size = (item) => (item.width ?? 0) * (item.height ?? 0);
    const image = images.sort((a, b) => size(b) - size(a))[0];
    const clip = media.filter((item) => /^video\//.test(item.mime ?? "")).sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
    return (image ?? clip)?.name ?? null;
  }
  async function someAsync(list, test) {
    for (const item of list) if (await test(item)) return true;
    return false;
  }
  async function savedReferences(projectId) {
    if (deps.inspire.savedCount) return deps.inspire.savedCount(projectId).catch(() => 0);
    return (await deps.inspire.projectView?.(projectId).catch(() => null))?.saved?.length ?? 0;
  }
  async function savedIds(projectId) {
    if (deps.inspire?.savedIds) return deps.inspire.savedIds(projectId).catch(() => []);
    return (await deps.inspire?.projectView?.(projectId).catch(() => null))?.saved ?? [];
  }
  // The references a type_seen waiver may name (translate.mjs): the brief's style lines' refs and the
  // saved Inspire references. Read only for an edit that waives it.
  // An ask_unmet waiver's reason must name the origin word (state.origin: {words, top}); a search
  // that was skipped has no words, so the waiver says there is nothing to waive.
  async function waiverReferences(resolver, document, ops) {
    const list = Array.isArray(ops) ? ops : [ops];
    if (list.some((op) => op?.code === "ask_unmet")) {
      const origin = (await agentState.read(document.id).catch(() => null))?.origin;
      if (origin?.words?.length) resolver.origin = origin;
    }
    if (!list.some((op) => op?.code === "type_seen")) return resolver;
    const lines = (await agentState.read(document.id).catch(() => null))?.brief?.style?.lines ?? [];
    resolver.references = [...lines.map((line) => line?.ref).filter((ref) => typeof ref === "string"), ...(await savedIds(document.id))];
    return resolver;
  }

  // A final render waits for the video's open stops (stops.mjs openStops, direction plan B2c),
  // on every path: render, project exports, the dashboard's own render keys and the older
  // export-batches route. A waiting stop that no longer stands is closed first (liveStop).
  // Answers { message, next, stops } or null; drafts are never refused.
  async function finalStopsOpen(record) {
    await liveStop(record);
    await settleBoardNow(record);
    const open = openStops(await agentState.read(record.document.id), await videoFactsFor(record.document), stopRulesNow());
    return open.length ? finalRefusal(open, { byYou: byYou() }) : null;
  }
  async function refuseFinalWhileStopsOpen(record) {
    const refused = await finalStopsOpen(record);
    if (!refused) return;
    const first = refused.stops[0];
    const state = first?.status === "waiting" ? await agentState.read(record.document.id) : null;
    const round = state ? waitingStop(state) : null;
    const nextCall = round ? nextOf("notes", { action: "answer", id: round.id, rev: round.rev, words: "<their reply, word for word>", read_as: "approve" }) : nextOf("notes", { action: "checkpoint", id: first.kind });
    throw Object.assign(new AgentError("stops_open", refused.message, { stops: refused.stops, next: refused.next }), { nextCall });
  }
  // For the export-batches route (index.mjs): the refusal's words, or null.
  async function finalRefused(projectId) {
    const known = await store.getProject(String(projectId)).catch(() => null);
    const refused = known && !known.trashedAt ? await finalStopsOpen(known) : null;
    return refused ? `${refused.message} ${refused.next}` : null;
  }

  // ---- the approved storyboard (board.mjs) --------------------------------------------------
  // After a save (an edit, revert or restore) that changed the board, left it no longer covering
  // the video or the music (a longer video, a moved music layer), or changed the music layer's
  // file (boardPrint): the board is compared with the approved copy, which lapses the approval
  // or logs the small changes. Returns the answer's `board` field, or null when nothing changed
  // or no approval stands.
  async function settleBoardAfter(projectId, before, updated) {
    const facts = { ...boardFacts(updated.document), rev: updated.revision, now: now() };
    if (boardPrint(before) === boardPrint(updated.document)) return null;
    return agentState.update(projectId, (draft) => boardAnswer(settleBoard(draft, facts), updated.document));
  }

  // Before status reads the stops: a board changed some other way (the dashboard's undo) is
  // compared too. Only an approval that still stands, lapsed by a gap alone, or past a later
  // stop's answer (laterAnswer: its lapse ends) is checked, so status writes nothing else.
  async function settleBoardNow(record) {
    const projectId = record.document.id;
    const state = await agentState.read(projectId);
    const approval = activeApproval(state);
    if (!approval || (approval.lapsed && !approval.lapsed.gap && !laterAnswer(state, approval))) return;
    const facts = { ...boardFacts(record.document), rev: record.revision, now: now() };
    await agentState.update(projectId, (draft) => { settleBoard(draft, facts); });
  }

  // The edit answer's board field: the approval this change lapsed, or the revision lines it logged.
  function boardAnswer(settled, document) {
    if (!settled) return null;
    const rev = document.board?.rev ?? null;
    const approval = settled.approval.stop;
    const few = (lines) => (lines.length > 8 ? [...lines.slice(0, 8), `… and ${lines.length - 8} more`] : lines);
    if (settled.lapsed) return { rev, approval, lapsed: few(settled.lapsed),
      next: `${approval} approved the board as it was; ${settled.earlier ? "that approval has lapsed" : "this change lapses that approval"}: ask again (notes checkpoint {id:"board"}); kino lists only the changed shots.` };
    if (settled.stands) return { rev, approval, revisions: few(settled.revisions), next: `the board covers the ${settled.approval.copy.music === "none" ? "video" : "music"} again within kino's tolerances: ${approval} stands; no need to ask again.` };
    return { rev, approval, revisions: few(settled.revisions) };
  }

  // An agent's saves and stop asks on one project run one at a time (notesStop, saveDocument).
  // An edit that passed waitingFor before a stop was asked then cannot save after the stop told
  // the agent to wait: either its save comes first and the ask sees the new revision, or the ask
  // comes first and the save is refused.
  const stopLines = new Map();
  function oneAtATime(projectId, run) {
    const result = (stopLines.get(projectId) ?? Promise.resolve()).then(run);
    const ended = result.catch(() => {});
    stopLines.set(projectId, ended);
    ended.then(() => { if (stopLines.get(projectId) === ended) stopLines.delete(projectId); });
    return result;
  }

  // Saves an agent's write (deps.saveDocument). A stop asked while the write was running refuses
  // it here (call() answers {waiting}), so nothing reaches the project after the stop's answer.
  // Calls from the dashboard and calls the person approved save as they always did.
  async function saveDocument(projectId, ...rest) {
    const meta = caller.getStore() ?? {};
    // The live view shows what this call's own saves changed (not another agent's).
    const noteSave = (saved) => {
      if (meta.live && saved?.document) meta.live.saves.push({ before: rest[0], after: saved.document, rev: saved.revision ?? null });
      if (saved?.document) rememberLive(projectId, saved.document);
      return saved;
    };
    if (meta.reviewed || meta.approved) {
      const saved = noteSave(await deps.saveDocument(projectId, ...rest));
      // Your write (an undo, a restore) or one you approved can change the work a waiting stop
      // showed: it closes now, so the dashboard never shows a stop kino would refuse to take.
      await settleStop(projectId);
      return saved;
    }
    return oneAtATime(projectId, async () => {
      const round = waitingStop(await agentState.read(projectId)) ? await liveStop(await store.getProject(projectId)) : null;
      if (round) throw new StopWaits({ projectId, round });
      // The crew (crew.mjs): this agent now holds the parts it changed, unless another agent
      // holds one of them; then nothing is saved and it waits.
      if (deps.crew && meta.live?.agent && !meta.live.replay) {
        const wait = deps.crew.claim(meta.live.agent, projectId, changedParts(rest[0], rest[1]));
        if (wait) throw new LockWaits(projectId, wait);
      }
      return noteSave(await deps.saveDocument(projectId, ...rest));
    });
  }

  // A write that touched a part another agent holds (crew-locks.mjs): nothing was saved.
  class LockWaits extends Error {
    constructor(projectId, wait) {
      super(`${wait.holder} holds ${wait.waiting}`);
      this.projectId = projectId;
      this.answer = { crew: "waiting", data: lockData(wait) };
    }
  }
  const lockData = (wait) => ({ crew: "waiting", ...wait,
    next: `Nothing was saved: ${wait.holder} is changing ${wait.parts.join(", ")}. Work on another part, or try again in a while (a part is free when its holder releases it or has been quiet 2 minutes).` });

  // The answer to a call the crew refused (crew.mjs gate, or a held part): nothing changed, and
  // the call counts in the turn. "stopped" and "denied" are errors the agent must not repeat.
  async function crewReply({ crew, data }, input, projectId = null) {
    const text = compact(data);
    const error = crew === "stopped" || crew === "denied" ? { isError: true } : {};
    const wanted = projectId ?? (typeof input.project === "string" ? input.project : await readCurrent());
    const known = wanted ? await store.getProject(String(wanted)).catch(() => null) : null;
    if (!known || known.trashedAt) return { text, data, ...error };
    return done(known.document.id, { text, data, ...error });
  }

  // Before an agent's call: the crew's limits (stopped, look only, budget, held), for agents
  // only (not the person, the dashboard or a call the person approved).
  async function crewGate(verb, input, meta) {
    const agent = meta.live?.agent;
    if (!deps.crew || !agent || meta.live.replay || meta.by === "you" || meta.reviewed || meta.approved) return null;
    const named = verb === "project" ? input.id ?? input.project : input.project;
    const projectId = typeof named === "string" ? named : await readCurrent();
    return deps.crew.gate({ agent, verb, write: isWrite(verb, input), projectId: projectId ?? null });
  }

  // A render start holds "render" for the agent while it renders. Render starts still on their
  // way to a job (its gates can take seconds), by project: they count as running.
  const startingRenders = new Map();
  async function renderClaim(verb, input, meta) {
    const agent = meta.live?.agent;
    if (!deps.crew || verb !== "render" || !isWrite(verb, input) || !agent || meta.live.replay || meta.by === "you" || meta.reviewed || meta.approved) return null;
    const projectId = typeof input.project === "string" ? input.project : await readCurrent();
    if (!projectId) return null;
    // The hold lasts while a render runs: a finished one frees it (a first pass's next turn, a
    // new agent id, was refused by its own done render for 2 minutes and looped to retry).
    await loadRenderState();
    const running = startingRenders.get(String(projectId)) > 0
      || [...renders.values()].some((job) => job.projectId === String(projectId) && !["done", "failed", "canceled", "gone"].includes(renderData(job).status));
    if (!running) deps.crew.settle?.(String(projectId), RENDER.key);
    const wait = deps.crew.claim(agent, String(projectId), [RENDER]);
    if (wait) return { answer: { crew: "waiting", data: lockData(wait) } };
    startingRenders.set(String(projectId), (startingRenders.get(String(projectId)) ?? 0) + 1);
    return { starting: String(projectId) };
  }
  function renderStarted(projectId) {
    const left = (startingRenders.get(projectId) ?? 1) - 1;
    if (left > 0) startingRenders.set(projectId, left); else startingRenders.delete(projectId);
  }

  // Closes this project's waiting stop when it no longer stands (liveStop), after your write or a
  // change to your stop settings. Returns the new stops summary when it closed one, else null.
  async function settleStop(projectId) {
    if (!waitingStop(await agentState.read(projectId))) return null;
    const known = await store.getProject(projectId).catch(() => null);
    if (!known || known.trashedAt || await liveStop(known)) return null;
    return stopsSummary(await agentState.read(projectId));
  }

  // The person answers a waiting stop on the dashboard, or reopens an answer (POST
  // /api/dashboard/stops, stops.mjs dashboardAnswerStep and reopenStep). These are not agent
  // calls: no turn, no call event; the agent hears them in its inbox. They run after the agent's
  // saves on this project (oneAtATime), on the project as it is then, and answer the dashboard's
  // stops summary or throw the StopError. A refusal still keeps what settling the waiting stop
  // changed (it lapsed because the work moved on), as notesStop does.
  async function answerStop(projectId, input = {}) {
    return oneAtATime(projectId, async () => {
      const steady = steadyNow();
      const record = await store.getProject(projectId);
      // board: an approved storyboard freezes the board it showed (stops.mjs, board.mjs).
      const step = { input, video: await videoFactsFor(record.document), rules: stopRulesNow(), rev: record.revision, work: workPrint(record.document), now: now(), board: boardFacts(record.document) };
      return dashboardStopUpdate(projectId, (draft) => {
        const asked = roundOf(draft, input.id)?.steady;
        return dashboardAnswerStep(draft, { ...step, waited: asked && sameBoot(asked.boot) ? steady - asked.at : null });
      });
    });
  }

  function reopenStop(projectId, input = {}) {
    return oneAtATime(projectId, () => dashboardStopUpdate(projectId, (draft) => reopenStep(draft, { input, now: now() })));
  }

  // One page of the storyboard as the agent's look {mode:"board", page} draws it (board-look.mjs),
  // for the dashboard's stop card (GET /api/dashboard/board): the board of revision `rev` (the one
  // the stop showed), or of the newest. Returns { png, pages } or throws AgentError (not_found,
  // bad_input). Not an agent call: no turn, no call event, nothing saved.
  async function boardPage(projectId, { rev = null, page = 1 } = {}) {
    const record = await store.getProject(projectId);
    if (!record) throw new AgentError("not_found", "This project could not be found.");
    const document = rev === null || rev === record.revision ? record.document : await store.getProjectRevision(projectId, rev);
    if (!document) throw new AgentError("not_found", `rev ${rev} is no longer kept.`);
    try {
      const { image, extra } = await boardLook({ page }, { document, look, fontsFor, mediaRecord, soundFiles: await soundFilesFor(document), soundSearch: soundSearchOn() });
      return { png: image.png, pages: extra.pages };
    } catch (error) {
      if (error instanceof BoardLookError) throw new AgentError(error.code, error.message);
      throw error;
    }
  }

  // The storyboard a board stop showed, as data for the dashboard's board screen (GET
  // /api/dashboard/board-data, board-data.mjs): by `stop` (its C id: the board of the revision
  // it showed), by `rev` (the newest board stop asked at it, or none), or else the newest board
  // stop, or the board now when none was asked. Returns the data or throws AgentError
  // (not_found). Not an agent call: no turn, no call event, nothing saved.
  async function boardData(projectId, { stop = null, rev = null } = {}) {
    const record = await store.getProject(projectId);
    if (!record) throw new AgentError("not_found", "This project could not be found.");
    const state = await agentState.read(projectId);
    const boards = (state.stops ?? []).filter((entry) => entry.kind === "board");
    let round = null;
    if (stop !== null) {
      round = boards.find((entry) => entry.id.toLowerCase() === String(stop).trim().toLowerCase()) ?? null;
      if (!round) throw new AgentError("not_found", `${String(stop).trim()} is not a storyboard stop of this project.`);
    } else if (rev !== null) round = boards.findLast((entry) => entry.rev === rev) ?? null;
    else round = boards.at(-1) ?? null;
    const shownRev = round?.rev ?? rev ?? record.revision;
    const document = shownRev === record.revision ? record.document : await store.getProjectRevision(projectId, shownRev);
    if (!document) throw new AgentError("not_found", `rev ${shownRev} is no longer kept.`);
    const records = new Map();
    // Each shot's file and its options' files (an option may use another clip).
    const sources = (document.board?.shots ?? []).flatMap((shot) => [shot.media, ...(shot.alts ?? []).map((alt) => alt.media)]);
    for (const src of sources) if (typeof src === "string" && src !== "none" && !records.has(src)) records.set(src, await mediaRecord(src));
    const data = boardScreenData(document, { state, round, rev: shownRev, project: projectId, records, soundFiles: await soundFilesFor(document), soundSearch: soundSearchOn() });
    if (!data) throw new AgentError("not_found", `No storyboard in rev ${shownRev}.`);
    return data;
  }

  // One shot of the board of revision `rev` as a picture, for the board screen (GET
  // /api/dashboard/board-shot, board-look.mjs boardShotImage): { png } or AgentError
  // (not_found, bad_input). Not an agent call.
  async function boardShot(projectId, { rev, shot, part, width }) {
    const record = await store.getProject(projectId);
    if (!record) throw new AgentError("not_found", "This project could not be found.");
    const document = rev === record.revision ? record.document : await store.getProjectRevision(projectId, rev);
    if (!document) throw new AgentError("not_found", `rev ${rev} is no longer kept.`);
    try {
      // part "style": the style frame the board ask of this revision carried (board-look.mjs styleFrameImage).
      if (part === "style") {
        if (!SHOT_WIDTHS.includes(width)) throw new BoardLookError("bad_input", `w is ${SHOT_WIDTHS.slice(0, -1).join(", ")} or ${SHOT_WIDTHS.at(-1)}.`);
        const facts = ((await agentState.read(projectId)).stops ?? []).findLast((round) => round.kind === "board" && round.rev === rev && round.styleFrame)?.styleFrame;
        if (!facts) throw new BoardLookError("not_found", `The board ask at rev ${rev} carried no style frame.`);
        return await styleFrameImage(facts, { document, look, fontsFor, mediaRecord, width });
      }
      return await boardShotImage({ shot, part, width }, { document, rev, look, fontsFor, mediaRecord });
    }
    catch (error) {
      if (error instanceof BoardLookError) throw new AgentError(error.code, error.message);
      throw error;
    }
  }

  // Runs a dashboard stop step in one saved update. Its StopError is thrown after the save, so
  // what the step changed before it stays.
  async function dashboardStopUpdate(projectId, step) {
    const { stops, refused } = await agentState.update(projectId, (draft) => {
      try { return { stops: step(draft) }; } catch (error) {
        if (error instanceof StopError) return { refused: error };
        throw error;
      }
    });
    if (refused) throw refused;
    return stops;
  }

  // A write that reached its save after a stop was asked (saveDocument): call() answers it as a
  // write refused while the stop waits.
  class StopWaits extends Error {
    constructor(waiting) {
      super(waitingData(waiting.round).next);
      this.waiting = waiting;
    }
  }

  // A refused write while a stop waits: nothing changes, and the call counts in the turn.
  function waitingReply({ projectId, round }) {
    const data = waitingData(round);
    return done(projectId, { text: compact(data), data });
  }

  // ---- edit -------------------------------------------------------------------------------
  // Applies the agent's operations to `document`. set_font runs on its own (it may download a
  // font), and so does detect_beats (it analyses the sound first); runs of engine operations go
  // to applyOperations together. When the engine refuses a run, its operations are tried one at
  // a time: each refused one goes into `problems` and is left out, and so is every later
  // operation that uses what a refused one makes (those go into `blocked`, as op number → the
  // refused op's number). Null operations (refused before this) are left out.
  // A video layer that plays a screen recording kino made keeps its pointer, clicks and keys
  // (layer.recording, from <media id>.recording.json), so the screen-recording move can use them.
  async function attachRecordings(entries) {
    if (!deps.mediaRoot) return;
    for (const { operation } of entries) {
      const properties = (operation.type === "add_layer" && operation.layerType === "video") || operation.type === "update_layer" ? operation.properties : null;
      if (typeof properties?.src !== "string") continue;
      const id = mediaIdFromSource(properties.src);
      const recording = id ? await recordingFor(deps.mediaRoot, id) : null;
      if (recording) properties.recording = recording;
      else if (operation.type === "update_layer") properties.recording = null;
    }
  }

  async function applyAll(document, operations, raw, fontsCache, problems = [], blocked = new Map()) {
    let next = document;
    const failedIds = new Map();
    // An add_layer with inline animations is a list of ops that share its number.
    const usable = operations.flatMap((operation, index) => [operation].flat().map((part) => ({ operation: part, index }))).filter((entry) => entry.operation);
    await attachRecordings(usable);
    const dependsOnFailure = ({ operation, index }) => {
      const cause = referencedIds(operation).find((id) => failedIds.has(id));
      if (cause === undefined) return false;
      blocked.set(index, failedIds.get(cause));
      for (const id of createdIds(operation)) failedIds.set(id, failedIds.get(cause));
      return true;
    };
    const refuse = ({ operation, index }, error) => {
      // One problem per op number: the stand-in of an op refused while translating adds none.
      if (!problems.some((problem) => problem.details?.op === index)) problems.push(error);
      for (const id of createdIds(operation)) failedIds.set(id, index);
    };
    // Deleting a group deletes its layers. A delete_layer later in the same edit for one of them
    // (a rebuild that deletes every name status listed, the group's layers under it) is skipped
    // with a note instead of refused with "Layer plate was not found".
    const deleted = new Map();
    const wentWith = new Map();
    const alreadyDeleted = ({ operation, index }) => {
      for (const id of createdIds(operation)) deleted.delete(id);
      if (operation.type !== "delete_layer") return false;
      const by = deleted.get(operation.layerId);
      if (by) {
        const key = `${by.layerId}\u0000${by.index}`;
        if (!wentWith.has(key)) wentWith.set(key, { ...by, names: [] });
        const { names } = wentWith.get(key);
        if (!names.includes(operation.layerId)) names.push(operation.layerId);
        return true;
      }
      const layers = next.scenes.flatMap((scene) => scene.layers);
      const ids = new Set([operation.layerId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const layer of layers) if (ids.has(layer.parentId) && !ids.has(layer.id)) { ids.add(layer.id); grew = true; }
      }
      for (const id of ids) if (!deleted.has(id)) deleted.set(id, { layerId: operation.layerId, index });
      return false;
    };
    let position = 0;
    while (position < usable.length) {
      const first = usable[position];
      if (REACH_OPERATIONS.includes(first.operation.type)) {
        if (!dependsOnFailure(first)) {
          try {
            const fonts = fontsCache.fonts ??= await fontsFor(next);
            const context = await operationContext(next, [first.operation]);
            const result = await applyReachOperation(next, first.operation, { store, fonts, agentState, context });
            next = parseDocument(result.document);
            (fontsCache.warnings ??= []).push(...(result.warnings ?? []));
            if (result.summary) (fontsCache.summaries ??= []).push(result.summary);
          } catch (error) { refuse(first, operationFailed(first.index, raw[first.index], first.operation.type, error)); }
        }
        position += 1;
        continue;
      }
      if (first.operation.type === "set_font") {
        if (!dependsOnFailure(first)) {
          try { next = await applySetFont(next, first.operation, first.index, fontsCache); }
          catch (error) { refuse(first, error instanceof AgentError ? error : operationFailed(first.index, raw[first.index], "set_font", error)); }
        }
        position += 1;
        continue;
      }
      if (blocks.handles(first.operation)) {
        if (!dependsOnFailure(first)) {
          try {
            await voiceLine(next, first.operation);
            next = await blocks.apply(next, first.operation, fontsCache);
            if (first.operation.formatName && first.operation.formatMusic) next = await fitFormatMusic(next, first.operation, fontsCache);
          }
          catch (error) { refuse(first, error instanceof AgentError ? error : operationFailed(first.index, raw[first.index], first.operation.type, error)); }
        }
        position += 1;
        continue;
      }
      if (needsTranscript(first.operation)) {
        if (!dependsOnFailure(first)) {
          try { next = await runWithTranscript(next, first.operation, fontsCache); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], first.operation.type, error)); }
        }
        position += 1;
        continue;
      }
      if (first.operation.type === "sync_clips") {
        if (!dependsOnFailure(first)) {
          try { next = await runSyncClips(next, first.operation, fontsCache); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], "sync_clips", error)); }
        }
        position += 1;
        continue;
      }
      if (first.operation.type === "fit_music") {
        if (!dependsOnFailure(first)) {
          try { next = await runFitMusic(next, first.operation, fontsCache); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], "fit_music", error)); }
        }
        position += 1;
        continue;
      }
      if (first.operation.type === "detect_beats") {
        if (!dependsOnFailure(first)) {
          try { next = await runDetectBeats(next, first.operation, fontsCache); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], "detect_beats", error)); }
        }
        position += 1;
        continue;
      }
      // isolate_voice splits the layer's sound first (voice-operation.mjs), on the document as
      // the operations before it left it.
      if (first.operation.type === "isolate_voice") {
        if (!dependsOnFailure(first)) {
          try { next = await runIsolateVoice(next, first.operation, { mediaRoot: deps.mediaRoot, voiceMedia: deps.voiceMedia, operationContext, reports: fontsCache.reports }); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], "isolate_voice", error)); }
        }
        position += 1;
        continue;
      }
      // match_color reads small frames of the footage and its reference first (color-operation.mjs).
      if (first.operation.type === "match_color") {
        if (!dependsOnFailure(first)) {
          try { next = await runMatchColor(next, first.operation, { mediaRoot: deps.mediaRoot, operationContext, reports: fontsCache.reports }); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], "match_color", error)); }
        }
        position += 1;
        continue;
      }
      // track follows an object through the layer's file first, and pin copies a track onto a
      // layer (track-operation.mjs).
      if (first.operation.type === "track" || first.operation.type === "pin") {
        if (!dependsOnFailure(first)) {
          try {
            next = first.operation.type === "track"
              ? await runTrack(next, first.operation, { mediaRoot: deps.mediaRoot, cacheDir: deps.cutoutMedia?.trackCacheDir ?? path.join(deps.mediaRoot ?? ".", "..", "cutout", "tracks"), reports: fontsCache.reports })
              : runPin(next, first.operation, { reports: fontsCache.reports });
          } catch (error) { refuse(first, operationFailed(first.index, raw[first.index], first.operation.type, error)); }
        }
        position += 1;
        continue;
      }
      // stabilize makes a steadied copy of the layer's file first (stabilize-operation.mjs).
      if (first.operation.type === "stabilize") {
        if (!dependsOnFailure(first)) {
          try { next = await runStabilize(next, first.operation, { mediaRoot: deps.mediaRoot, cutoutMedia: deps.cutoutMedia, operationContext, reports: fontsCache.reports }); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], "stabilize", error)); }
        }
        position += 1;
        continue;
      }
      // cut_out finds the layer's subject first (cutout-operation.mjs), the same way. Cut-outs are
      // made one at a time, so all of an edit's cut_outs share one wait (from the first of them):
      // each waiting its own would answer after the tool-call limit the wait keeps under.
      if (first.operation.type === "cut_out") {
        if (!dependsOnFailure(first)) {
          fontsCache.cutoutDeadline ??= performance.now() + (deps.cutoutMedia?.waitSeconds ?? 50) * 1000;
          try { next = await runCutOut(next, first.operation, { mediaRoot: deps.mediaRoot, cutoutMedia: deps.cutoutMedia, operationContext, reports: fontsCache.reports, deadline: fontsCache.cutoutDeadline }); }
          catch (error) { refuse(first, operationFailed(first.index, raw[first.index], "cut_out", error)); }
        }
        position += 1;
        continue;
      }
      let end = position;
      while (end < usable.length && !["set_font", "detect_beats", "fit_music", "sync_clips", "isolate_voice", "cut_out", "match_color", "track", "pin", "stabilize"].includes(usable[end].operation.type) && !needsTranscript(usable[end].operation) && !REACH_OPERATIONS.includes(usable[end].operation.type) && !blocks.handles(usable[end].operation)) end += 1;
      const run = usable.slice(position, end).filter((entry) => !dependsOnFailure(entry) && !alreadyDeleted(entry));
      position = end;
      if (!run.length) continue;
      const context = await operationContext(next, run.map((entry) => entry.operation));
      // add_captions, detect_beats, add_sequence and duck_audio report what they made (audioCaptionOperations.js).
      if (fontsCache.reports) context.reports = fontsCache.reports;
      try {
        next = parseDocument(applyOperations(next, run.map((entry) => entry.operation), context));
      } catch (error) {
        let probe = next;
        let failed = false;
        for (const entry of run) {
          if (dependsOnFailure(entry)) continue;
          try { probe = parseDocument(applyOperations(probe, [entry.operation], context)); }
          catch (single) {
            failed = true;
            refuse(entry, operationFailed(entry.index, raw[entry.index], entry.operation.type, single));
            // A refused add_layer: a plain layer with its ID stands in, so the ops that use it
            // are still tried and their problems listed too (nothing is saved).
            const standIn = plainLayer(entry.operation);
            if (standIn) {
              try {
                probe = parseDocument(applyOperations(probe, [standIn], context));
                for (const id of createdIds(standIn)) failedIds.delete(id);
              } catch { /* the ops that use it are not tried */ }
            }
          }
        }
        // Each works alone but not all together.
        if (!failed) { problems.push(operationFailed(null, null, null, error)); return next; }
        next = probe;
      }
    }
    for (const { layerId, index, names } of wentWith.values()) {
      const others = names.filter((name) => name !== layerId);
      const list = (items) => (items.length < 2 ? items.join("")
        : items.length > 8 ? `${items.slice(0, 6).join(", ")} and ${items.length - 6} more`
        : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
      if (others.length) (fontsCache.notes ??= []).push(`${list(others)} went with ${layerId} (op ${index}): deleting a group deletes its layers, so ${others.length === 1 ? "that delete was" : "those deletes were"} skipped.`);
      if (others.length < names.length) (fontsCache.notes ??= []).push(`${layerId} was already deleted by op ${index}; the second delete was skipped.`);
    }
    return next;
  }

  // detect_beats needs the layer's sound analysed first (FFmpeg decodes it; beatDetection.js
  // finds the beats). It runs on its own, on `document` as the operations before it left it, so
  // a sound set earlier in the same edit is the one analysed. The result goes into the operation
  // as `analysis`, replacing anything the caller sent. A sound that cannot be analysed refuses
  // the operation like any other problem.
  async function runDetectBeats(document, operation, work) {
    delete operation.analysis;
    const layer = document.scenes.flatMap((scene) => scene.layers).find((item) => item.id === operation.layerId);
    // Without a layer or a sound, the engine names the problem.
    if (layer?.src) {
      const id = mediaIdFromSource(layer.src);
      const file = id && deps.mediaRoot ? path.join(deps.mediaRoot, id) : null;
      if (!file || !existsSync(file)) throw new Error("the layer's sound is not in kino's media library; import the file with project {action:\"import\", file} and use its src.");
      operation.analysis = await beatAnalysis.get(file);
    }
    const context = await operationContext(document, [operation]);
    if (work.reports) context.reports = work.reports;
    return parseDocument(applyOperations(document, [operation], context));
  }

  // fit_music measures the song first (the beat analysis and its sections, each kept beside the
  // file) and puts both in the operation. Without payoff or turn, the spine's payoff (and turn)
  // beat starts give them (notes brief style.spine).
  // format {slots:{music}}: the song is fit to the video (fit_music) with its drop on the hero (or
  // the quote, or the headline). A song fit_music cannot shape (no steady beat or no drop) stays
  // as laid, and the receipt's notes say why.
  async function fitFormatMusic(document, operation, work) {
    const sceneId = operation.sceneId ?? operation.newSceneId;
    const scene = document.scenes.find((item) => item.id === sceneId);
    const music = scene?.layers.find((item) => item.id === `${sceneId}-music`);
    if (!music) return document;
    const names = new Set(operation.formatCues.map((cue) => cue.name));
    const payoffCue = ["hero", "quote", "headline"].find((name) => names.has(name));
    const payoff = (document.cues ?? []).find((cue) => cue.name === payoffCue)?.time;
    const fit = { type: "fit_music", sceneId, layerId: music.id, ...(payoff > 0 ? { payoff } : {}) };
    try {
      const fitted = await runFitMusic(document, fit, { ...work, reports: null });
      (work.notes ??= []).push(`format music: one stretch of the song (fit_music)${payoff > 0 ? `, its drop on ${payoffCue} at ${payoff} s` : ""}`);
      return fitted;
    }
    catch (error) {
      (work.notes ??= []).push(`format music: kept as laid, not fit to the beat (${String(error.message).replace(/^fit_music:\s*/, "")})`);
      return document;
    }
  }

  async function runFitMusic(document, operation, work) {
    delete operation.analysis;
    delete operation.shape;
    const layer = document.scenes.flatMap((scene) => scene.layers).find((item) => item.id === operation.layerId);
    if (layer?.src) {
      const file = mediaFileOf(layer);
      operation.analysis = await beatAnalysis.get(file);
      operation.shape = await songShapes.get(file, operation.analysis);
      // The file's length from importing it when shorter: FFmpeg 6 also decodes an AAC file's end
      // padding (up to 1024 samples, 23 ms at 44.1 kHz), which would put the song's ending late.
      const length = (await mediaRecord(layer.src))?.duration;
      if (length > 0 && !(operation.shape.seconds <= length)) operation.shape = { ...operation.shape, seconds: length };
    }
    const spine = (await agentState.read(document.id).catch(() => null))?.brief?.style?.spine;
    const beatOf = (role) => (Array.isArray(spine) ? spine.find((beat) => beat?.role === role)?.from : undefined);
    if (operation.payoff === undefined && typeof beatOf("payoff") === "number") operation.payoff = beatOf("payoff");
    if (operation.turn === undefined && typeof beatOf("turn") === "number") operation.turn = beatOf("turn");
    const context = await operationContext(document, [operation]);
    if (work.reports) context.reports = work.reports;
    return parseDocument(applyOperations(document, [operation], context));
  }

  // sync_clips compares the two clips' sound first (backend/clip-sync.mjs, engine/clipSync.js), unless
  // `at` names the same moment in each. Like detect_beats it runs on its own, with the match put
  // in as `match` (replacing anything the caller sent). search: only offsets within that many
  // seconds of how the clips line up now.
  async function runSyncClips(document, operation, work) {
    delete operation.match;
    if (operation.at === undefined) {
      const { layer, to } = syncLayers(document, operation);
      const curves = [];
      for (const item of [layer, to]) {
        try { curves.push(await syncCurves.get(mediaFileOf(item))); }
        catch (error) {
          if (!/no sound/i.test(error.message)) throw error;
          throw new Error(`sync_clips: "${item.name}" has no sound track, so the clips cannot be matched by sound. ${SYNC_FALLBACK}`);
        }
      }
      const search = operation.search === undefined ? {} : { search: operation.search, around: currentLag(layer, to) };
      operation.match = matchEnvelopes(curves[0], curves[1], search);
    }
    const context = await operationContext(document, [operation]);
    if (work.reports) context.reports = work.reports;
    return parseDocument(applyOperations(document, [operation], context));
  }

  // cut_speech and add_captions {speech} need the voice's transcript: made on this computer the
  // first time (backend/speech/transcribe.mjs) and kept beside the file. Like detect_beats, the
  // operation runs on its own, on the document as the operations before it left it, with the
  // transcript put in as `transcript` (replacing anything the caller sent).
  function needsTranscript(operation) {
    return operation?.type === "cut_speech" || operation?.type === "duck_audio" || operation?.type === "place_broll" || operation?.type === "keep_line" || (operation?.type === "add_captions" && operation.speechId !== undefined);
  }

  // move voice-type {speech, line}: the line's words and times from the voice's transcript
  // (made on first use, as for add_captions {speech}); the move keeps them as its words.
  async function voiceLine(document, operation) {
    if (operation?.type !== "move" || operation.name !== "voice-type" || operation.speech === undefined) return;
    // With your text layer, the line is its text unless line says otherwise.
    const own = operation.line === undefined && typeof operation.layer === "string"
      ? document.scenes.flatMap((item) => item.layers).find((item) => item.id === operation.layer && item.type === "text") : null;
    if (own) operation.line = own.text;
    if (operation.line === undefined) throw new Error("voice-type speech needs line: the words to set, as said (or layer, your text layer holding them).");
    const scene = document.scenes.find((item) => item.layers.some((layer) => layer.id === operation.speech));
    const layer = scene?.layers.find((item) => item.id === operation.speech);
    if (!layer?.src) throw new Error("voice-type speech is the audio or video layer with the voice.");
    const transcript = await transcripts.get(mediaFileOf(layer), document, layer);
    operation.words = spokenLine(scene, layer, transcript, operation.line);
    delete operation.speech;
    delete operation.line;
  }

  // The media library file a layer plays, or a refusal that says to import it.
  function mediaFileOf(layer) {
    const id = mediaIdFromSource(layer.src);
    const file = id && deps.mediaRoot ? path.join(deps.mediaRoot, id) : null;
    if (!file || !existsSync(file)) throw new Error("the layer's sound is not in kino's media library; import the file with project {action:\"import\", file} and use its src.");
    return file;
  }

  // A song (a file kino found a steady beat in: a tempo it is sure of) is music, not speech.
  async function isMusicFile(file) {
    if (await isSoundEffect(file)) return false;
    try { return steadyBeat(JSON.parse(await readFile(`${file}.beats`, "utf8"))); } catch { return false; }
  }

  async function runWithTranscript(document, operation, work) {
    delete operation.transcript;
    if (operation.type === "duck_audio") {
      operation.speech = await savedSpeechOf(document, operation.under);
      // The music's level sets the depth (without `to`); each under layer's says when it is loud.
      operation.levels = await levelsOf(document, operation.to === undefined ? [operation.layerId, ...(operation.under ?? [])] : (operation.under ?? []));
    }
    const layerId = operation.type === "cut_speech" || operation.type === "keep_line" ? operation.layerId : operation.type === "add_captions" || operation.type === "place_broll" ? operation.speechId : null;
    const layers = document.scenes.flatMap((scene) => scene.layers);
    const layer = layers.find((item) => item.id === layerId);
    // place_broll starts each clip on one of its file's shots (backend/shot-detection.mjs).
    if (operation.type === "place_broll") {
      operation.shots = {};
      for (const id of operation.layerIds ?? []) {
        const clip = layers.find((item) => item.id === id);
        if (clip?.type === "video" && clip.src) operation.shots[id] = (await fileShots(clip.src)).shots;
      }
    }
    // Without a layer or a sound, the engine names the problem.
    // keep_line {from, to} needs the words only for its subtitle: not when it has its own text (or none),
    // and a clip whisper cannot read (speech in another language) still keeps its stretch.
    const wordsOptional = operation.type === "keep_line" && operation.line === undefined;
    if (layer?.src && (layer.type === "audio" || layer.type === "video") && !(wordsOptional && (operation.text !== undefined || operation.subtitle === false))) {
      try { operation.transcript = await transcripts.get(mediaFileOf(layer), document, layer); } catch (error) { if (!wordsOptional) throw error; }
    }
    const context = await operationContext(document, [operation]);
    if (work.reports) context.reports = work.reports;
    return parseDocument(applyOperations(document, [operation], context));
  }

  // duck_audio sets its depth from the measured loudness of the music and the voices
  // ({layerId: curve}, backend/loudness-curve.mjs); a file measured once is kept beside it.
  async function levelsOf(document, ids) {
    const levels = {};
    const layers = document.scenes.flatMap((scene) => scene.layers);
    for (const id of new Set(ids)) {
      const layer = layers.find((item) => item.id === id);
      if (!layer?.src || (layer.type !== "audio" && layer.type !== "video")) continue;
      try { levels[id] = await loudnessCurves.get(mediaFileOf(layer)); } catch { /* not measured: the default depth */ }
    }
    return levels;
  }

  // duck_audio dips under a voice's words: the saved transcript of each under layer that has one
  // ({layerId: transcript}); nothing is transcribed here, and a song has no words to follow.
  async function savedSpeechOf(document, under) {
    const speech = {};
    const layers = document.scenes.flatMap((scene) => scene.layers);
    for (const id of Array.isArray(under) ? under : []) {
      const layer = layers.find((item) => item.id === id);
      if (!layer?.src || (layer.type !== "audio" && layer.type !== "video")) continue;
      try {
        const file = mediaFileOf(layer);
        if (await isMusicFile(file)) continue;
        const transcript = await transcripts.saved?.(file, document, layer);
        if (Array.isArray(transcript?.words)) speech[id] = transcript;
      } catch { /* no saved transcript: the dip follows the clip */ }
    }
    return speech;
  }

  // inspect {targets:["cuts"]}: the cuts of the video (its longest shown scene) with the words
  // around each from the saved transcripts and the loudness from the saved peaks. Nothing is
  // transcribed here: a check with pixels transcribes the heard sound.
  async function cutListFor(document, codes, from) {
    const scene = videoScene(document);
    if (!scene) throw new AgentError("bad_input", "cuts: the project has no scene.");
    const heard = new Map();
    const savedOf = async (cache, file, layer) => { try { return (await cache.saved?.(file, document, layer)) ?? null; } catch { return null; } };
    for (const layer of scene.layers) {
      if ((layer.type !== "video" && layer.type !== "audio") || !layer.src || layer.enabled === false) continue;
      if (!(Number(layer.volume ?? 1) > 0 || (layer.animations ?? []).some((animation) => animation?.to && "volume" in animation.to))) continue;
      const file = mediaFileOf(layer);
      const music = await isMusicFile(file);
      const transcript = music ? null : await savedOf(transcripts, file, layer);
      heard.set(layer.id, {
        words: transcript?.words ?? null, sound: soundLevels(await savedOf(audioPeaks, file)),
        missing: music ? "music" : "not transcribed yet (check {pixels:true} transcribes it)",
      });
    }
    return cutListText(scene, heard, { name: (id) => refName(id, codes), from });
  }

  // inspect {targets:["speech:<layer>"]} (or "speech:<layer>[from=30]"): the words the voice
  // says, with transcript indices, scene times and the slips (engine/speech.js speechText).
  async function speechList(document, codes, target, budget = SPEECH_BUDGET_ONE) {
    const [, ref, whole, from] = SPEECH_TARGET.exec(String(target).trim());
    const resolver = createResolver(document, codes);
    const layerId = resolver.resolve(ref, "layer");
    const scene = document.scenes.find((item) => item.layers.some((layer) => layer.id === layerId));
    const layer = scene.layers.find((item) => item.id === layerId);
    const pieces = checkSpeechLayer(scene, layer, "speech");
    const started = performance.now();
    const transcript = await transcripts.get(mediaFileOf(pieces[0]), document, pieces[0]);
    const how = transcript.cached ? "saved transcript" : `transcribed in ${Math.round((performance.now() - started) / 100) / 10} s`;
    // A cut voice reads the transcript its cuts were made on; say so when the brief names others.
    const wanted = projectNames((await agentState.read(document.id).catch(() => null))?.brief ?? null);
    const pinned = pieces[0].cutWords?.length && wanted.join("\n") !== (transcript.names ?? []).join("\n") ? wanted : null;
    // The first piece lists the whole voice; another piece of a cut voice lists only its own words.
    // [file]: every word of the file in file seconds, however long the scene is.
    const words = whole ? fileWords(transcript, pieces[0]) : speechWords(scene, pieces, transcript).filter((word) => layer === pieces[0] || word.piece === layer);
    const text = speechText({
      layerName: layer.name, words, transcript, from: from === undefined ? null : Number(from), how, file: Boolean(whole),
      voice: pieces[0].name, pieces: pieces.map((piece) => piece.name), cut: cutSpeechIndices(pieces, transcript), pinned, budget,
    });
    return { text, words: words.length };
  }

  // The receipt fields for what add_captions, detect_beats, add_sequence, duck_audio,
  // isolate_voice and cut_out reported. detect_beats names the animations on cues that moved by their IDs;
  // the agent gets their names. A duck_audio replaces the dips an earlier one made on the same
  // layer, so only the last duck_audio of a layer reports (an earlier report told of dips that
  // were gone), and its `replaced` says which op's dips are gone. `operations` (the translated
  // ops, one entry per op the agent sent) gives that op's number.
  function reportFields(reports, codes, operations = []) {
    const fields = {};
    const duckOf = (operation) => `${operation.sceneId}/${operation.layerId}`;
    const lastDuck = new Map();
    for (const [operation] of reports) if (operation.type === "duck_audio") lastDuck.set(duckOf(operation), operation);
    const opNumber = (operation) => operations.findIndex((entry) => entry === operation || (Array.isArray(entry) && entry.includes(operation)));
    const replaced = new Map();
    for (const [operation, found] of reports) {
      if (operation.type !== "duck_audio" || lastDuck.get(duckOf(operation)) === operation) continue;
      const last = lastDuck.get(duckOf(operation));
      const number = opNumber(operation);
      replaced.set(last, [...(replaced.get(last) ?? []), `${number >= 0 ? `op ${number}` : "an earlier duck_audio"} (${found.summary ?? "its dips"})`]);
    }
    for (const [operation, found] of reports) {
      // update_layer and update_layers moved a layer's presets with it (engine/presetMove.js).
      if (found.presetsMoved) {
        (fields.movedWithLayer ??= []).push(...found.presetsMoved.map(({ layerId, animationId, name, what }) => `${refName(animationId, codes)}${name ? ` (${name})` : ""}${what ? ` ${what}` : ""} with ${refName(layerId, codes)}`));
        continue;
      }
      const key = { add_captions: "captions", detect_beats: "beats", fit_music: "music", add_sequence: "sequence", duck_audio: "duck", isolate_voice: "voice", cut_out: "cutout", track: "track", pin: "pin", stabilize: "stabilize", cut_speech: "speech", sync_clips: "sync", match_color: "color", place_broll: "broll", keep_line: "keepLine" }[operation.type];
      if (!key) continue;
      if (operation.type === "duck_audio" && lastDuck.get(duckOf(operation)) !== operation) continue;
      let report = found.cuesMoved
        ? { ...found, cuesMoved: found.cuesMoved.map((entry) => ({ ...entry, animation: refName(entry.animation, codes) })) }
        : found;
      if (replaced.has(operation)) {
        report = { ...report, replaced: `This duck_audio replaced the dips of ${replaced.get(operation).join(" and ")}: a later duck_audio on a layer replaces the earlier dips. To keep both, send one duck_audio with every layer in under.` };
      }
      fields[key] = fields[key] === undefined ? report : [].concat(fields[key], report);
    }
    return fields;
  }

  // A problem found while translating (an unknown name, a bad value) as an agent answer.
  function translationProblem(error) {
    const isReference = error.cause instanceof ReferenceError;
    const details = { op: error.index, type: error.type, safeToRetry: true };
    if (error.suggestions.length) details.didYouMean = error.suggestions;
    const rules = rulesFor(error.type);
    if (rules && !isReference) details.rules = rules;
    // An unknown name needs the right name, not another op.
    const example = isReference ? undefined : exampleOf(error.type, error, error.layer);
    if (example) details.example = example;
    const problem = new AgentError(isReference ? "unknown_ref" : "op_failed", `Operation ${error.index}${error.type ? ` (${error.type})` : ""}: ${error.message}`, details);
    // The names that were not found ({kind, ref} each), for the refusal's `missing` list (not
    // sent on their own): one, or one for each part of an op such as delete_layer {layers:[…]}.
    if (error.waive) problem.waive = error.waive;
    if (Array.isArray(error.missing)) problem.missing = error.missing;
    else if (isReference && !error.cause.ambiguous && typeof error.cause.ref === "string" && error.cause.kind) problem.missing = [{ kind: error.cause.kind, ref: error.cause.ref }];
    return problem;
  }

  // Keeps a refused edit's operations so `edit {retry, fix}` can send them again.
  function rememberRefused(projectId, ops) {
    const cutoff = now() - REFUSED_KEEP_MS;
    for (const [code, entry] of refused) if (entry.at < cutoff || refused.size >= REFUSED_KEPT) refused.delete(code);
    const code = `E${++refusedCount}`;
    refused.set(code, { projectId, ops: structuredClone(ops), at: now() });
    return code;
  }

  // One answer for every problem of an edit: the first in full (with the op's rules), up to
  // four more in a line each, and the ops that were not tried because they use what a
  // refused op makes. Nothing is saved; `retry` resends the edit with only the fixes.
  function refusal(projectId, ops, problems, blocked, waiverCall = null) {
    problems.sort((a, b) => (a.details.op ?? -1) - (b.details.op ?? -1));
    const [first, ...rest] = problems;
    const code = rememberRefused(projectId, ops);
    const details = { ...first.details };
    const reasonOf = (problem) => problem.message.replace(/^Operation \d+(?: \([^)]*\))?(?::| was refused:) /, "");
    if (rest.length) details.alsoRefused = rest.slice(0, REFUSAL_LIST - 1).map((problem) => ({
      op: problem.details.op, type: problem.details.type, reason: reasonOf(problem),
      ...(problem.details.didYouMean?.length ? { didYouMean: problem.details.didYouMean } : {}),
    }));
    if (rest.length > REFUSAL_LIST - 1) details.moreRefused = rest.length - (REFUSAL_LIST - 1);
    // Every name that was not found, by kind, even past the problems listed one by one, so a
    // script that deletes what it built can see at once which of its names are already gone.
    const missing = {};
    let names = 0;
    for (const entry of problems.flatMap((problem) => problem.missing ?? [])) {
      if (names >= MISSING_LIST || missing[entry.kind]?.includes(entry.ref)) continue;
      (missing[entry.kind] ??= []).push(entry.ref);
      names += 1;
    }
    if (names >= 2 || (names && details.moreRefused)) details.missing = missing;
    if (blocked.size) details.notTried = `ops ${ranges([...blocked.keys()])} use what a refused op makes`;
    details.retry = code;
    const opNumber = first.details.op ?? "<op number>";
    details.next = `Nothing was saved. edit {retry:"${code}", fix:{"${opNumber}": {fields to change}}} resends the ${ops.length} ops with your fixes (a whole op replaces it, null drops it; a field set to null is removed).`;
    // A refused waiver answers with the fix of what it tried to waive, not an example waive_check.
    if (waiverCall && first.waive) {
      delete details.example;
      details.next = `Nothing was saved. The finding needs its fix, not a waiver: ${callText(waiverCall)}`;
    }
    const message = problems.length > 1 ? `${plural(problems.length, "operation")} refused. ${first.message}` : first.message;
    return Object.assign(new AgentError(first.code, message, details), { nextCall: waiverCall && first.waive ? waiverCall : retryCall(code, ops, problems) });
  }

  // The fix a refused waiver (waive_check on a viewer or face-cut code) answers with. A cut face or
  // a narrow window: kino's own framing of the layers named (frame_shot), or mark_subject for a shot
  // an animation moves (frame_shot would fight it). Any other code: check {fix:"auto"} when its
  // finding has an auto fix, else the finding's own fix op, else check {rules:[code]} (its words). Null when the edit refused no waiver.
  const FRAME_WAIVERS = new Set(["crop_no_subject", "head_cut_off", "narrow_window"]);
  async function waiverFixCall(document, problems, codes) {
    const refused = problems.filter((problem) => problem.waive);
    if (!refused.length) return null;
    const { findings } = await findingsFor(document, { fonts: await fontsFor(document), codes }).catch(() => ({ findings: [] }));
    const layers = [...new Set(refused.filter((problem) => FRAME_WAIVERS.has(problem.waive.code)).flatMap((problem) => problem.waive.layers))].map((id) => refName(id, codes));
    if (FRAME_WAIVERS.has(refused[0].waive.code) && layers.length) {
      const moves = (ref) => findings.some((finding) => finding.moves && finding.ref === ref);
      const still = layers.filter((ref) => !moves(ref));
      if (still.length) return nextOf("edit", { ops: [{ op: "frame_shot", layers: still }] });
      return nextOf("edit", { ops: [{ op: "mark_subject", layer: layers[0], t: "<seconds into the file>", box: "<[x, y, width, height] in % of the file>" }] });
    }
    const own = findings.filter((finding) => finding.rule === refused[0].waive.code && !finding.waived);
    if (own.some((finding) => finding.auto)) return nextOf("check", { fix: "auto" });
    const fix = own.find((finding) => finding.fix && typeof finding.fix === "object")?.fix;
    if (fix) return nextOf("edit", { ops: [fix].flat() });
    // A finding whose fix is words only (a hint), or none left: check lists it with those words.
    return nextOf("check", { rules: [refused[0].waive.code] });
  }

  // The call that resends a refused edit with each refused op fixed as kino would: a name it
  // could not find replaced by the one it suggests, else the working example of that op (built
  // from what was sent where possible). An op kino has no fix for is dropped (null), so the rest
  // still go in; with nothing to fix it, the op's rules.
  function retryCall(code, ops, problems) {
    const fix = {};
    const list = Array.isArray(ops) ? ops : [ops];
    for (const problem of problems) {
      const index = problem.details?.op;
      if (!Number.isInteger(index) || fix[index] !== undefined) continue;
      const sent = list[index];
      const suggestion = problem.details.didYouMean?.[0];
      const named = suggestion && problem.missing?.length ? opWithName(sent, problem.missing[0].ref, suggestion) : null;
      if (named) fix[index] = named;
      else if (problem.details.example) fix[index] = problem.details.example;
    }
    if (!Object.keys(fix).length) {
      const type = problems[0]?.details?.type;
      return type ? nextOf("library", { topic: "op", name: type }) : nextOf("library", { topic: "op" });
    }
    return nextOf("edit", { retry: code, fix });
  }

  // Op fields where null is a value with a meaning (it removes something), so a fix keeps it.
  const NULL_MEANS = { source: ["text"], mark_subject: ["box"] };

  // A refused op with fix's fields changed; a field fixed to null is removed.
  function patchOp(operation, fields) {
    const patched = { ...operation, ...fields };
    const kept = NULL_MEANS[patched.op ?? patched.type] ?? [];
    for (const [key, value] of Object.entries(fields)) if (value === null && !kept.includes(key)) delete patched[key];
    return patched;
  }

  // The operations of an edit: `ops`, or a refused edit (`retry`) with `fix` applied and
  // `ops` added at the end.
  function editOperations(input, projectId) {
    if (input.retry === undefined) {
      if (input.fix !== undefined) throw new AgentError("bad_input", "fix goes with retry, the code of a refused edit (such as E1).");
      // One op sent on its own is a list of one (edit reports it in fixed).
      const one = input.ops;
      if (one && typeof one === "object" && !Array.isArray(one) && (one.op ?? one.type) !== undefined) return Object.assign([one], { wrapped: true });
      return input.ops;
    }
    const code = String(input.retry).toUpperCase();
    const saved = refused.get(code);
    if (!saved || saved.projectId !== projectId || saved.at < now() - REFUSED_KEEP_MS)
      throw new AgentError("not_found", `No refused edit ${input.retry} in this project (refused edits are kept for 30 minutes). Send ops instead.`,
        { didYouMean: closest(code, [...refused.keys()]) });
    const fix = input.fix ?? {};
    if (!fix || typeof fix !== "object" || Array.isArray(fix))
      throw new AgentError("bad_input", 'fix is an object such as {"3": {"easing":"smooth"}}: op number → fields to change (a field null removes it), a whole op (with op) to replace it, a list of ops, or null to drop it.');
    const result = saved.ops.map((operation) => [operation]);
    for (const [key, value] of Object.entries(fix)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= saved.ops.length)
        throw new AgentError("bad_input", `fix key "${key}" is not an op number of ${code} (0 to ${saved.ops.length - 1}).`);
      if (value === null) result[index] = [];
      else if (Array.isArray(value)) result[index] = value;
      else if (value && typeof value === "object") result[index] = [value.op !== undefined || value.type !== undefined ? value : patchOp(saved.ops[index], value)];
      else throw new AgentError("bad_input", `fix "${key}" must be an object, a list of ops, or null.`);
    }
    const extra = input.ops === undefined ? [] : Array.isArray(input.ops) ? input.ops : [input.ops];
    return [...result.flat(), ...extra];
  }

  async function applySetFont(document, operation, index, fontsCache) {
    const requested = operation.layerIds ?? (operation.layerId ? [operation.layerId] : []);
    if (!requested.length) throw operationFailed(index, operation, "set_font", new Error("set_font needs layerIds (or layerId)."));
    const fonts = fontsCache.fonts ??= await fontsFor(document);
    const byScene = new Map();
    const layerIds = [];
    // Layers that are not text (a background, a group) are skipped and named in the receipt's
    // notes, so a font set on "every layer" still works; with no text layer at all it is refused.
    const skipped = [];
    const name = (id) => (isRandomId(id) ? fontsCache.resolver?.codeOf(id) ?? id : id);
    for (const id of new Set(requested)) {
      const scene = document.scenes.find((entry) => entry.layers.some((layer) => layer.id === id));
      if (!scene) throw operationFailed(index, operation, "set_font", new Error(`No layer "${id}".`));
      const type = scene.layers.find((layer) => layer.id === id).type;
      if (type !== "text") { skipped.push(`${name(id)} (${type})`); continue; }
      layerIds.push(id);
      if (!byScene.has(scene.id)) byScene.set(scene.id, []);
      byScene.get(scene.id).push(id);
    }
    if (!layerIds.length)
      throw operationFailed(index, operation, "set_font", new Error(`set_font sets the font of text layers, and ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not text.`));
    if (skipped.length) fontsCache.notes?.push(`op ${index} set_font skipped ${skipped.join(", ")}: not text`);
    const choice = { family: operation.family, ...(operation.weight !== undefined ? { weight: operation.weight } : {}), ...(operation.style !== undefined ? { style: operation.style } : {}) };
    let next = document;
    const lacking = []; // the errors of layers whose face lacks some of their characters
    try {
      for (const [sceneId, ids] of byScene) {
        // One layer at a time, so one refusal names every layer that lacks a character.
        const patches = [];
        for (const layer of fontTargetLayers(next, sceneId, ids)) {
          try { patches.push(...await prepareFontPatches([layer], choice, { fonts, catalog: fontCatalog })); }
          catch (error) {
            if (error?.code !== "FONT_MISSING_CHARACTERS" || !error.layer) throw error;
            lacking.push(error);
          }
        }
        if (patches.length) next = withFontPatches(next, sceneId, patches, fonts);
      }
    } catch (error) { throw operationFailed(index, operation, "set_font", error); }
    if (lacking.length) throw await missingCharactersRefusal(index, operation, layerIds, choice, lacking, fonts, fontsCache.resolver);
    return next;
  }

  // set_font chose a face that lacks some of the layers' characters (such as "∞"). The refusal
  // names fonts that have them (glyphs checked) and, in `instead`, the ops to send in its place:
  // set_font for the layers that are fine, and for each other layer an update_layer with the
  // chosen face and a textStyleRanges range for just the characters it lacks.
  async function missingCharactersRefusal(index, operation, layerIds, choice, lacking, fonts, resolver) {
    const ref = (id) => (isRandomId(id) ? resolver?.codeOf(id) ?? id : id);
    const help = await missingCharactersHelp(lacking.map((error) => ({ layer: error.layer, layerRef: ref(error.layer.id),
      characters: error.characters, choice: error.face })), { fonts, catalog: fontCatalog, opNumber: index });
    const refused = operationFailed(index, operation, "set_font", new Error(help.message));
    refused.details.field = "family";
    if (help.instead) {
      const failed = new Set(lacking.map((error) => error.layer.id));
      const others = layerIds.filter((id) => !failed.has(id)).map(ref);
      const ops = [...(others.length ? [{ op: "set_font", layerIds: others, ...choice }] : []), ...help.instead];
      refused.details.instead = ops.length === 1 ? ops[0] : ops;
    }
    return refused;
  }

  function operationFailed(index, operation, type, error) {
    // "document.scenes[0].layers[1].role must be …" names the field as the op has it: "role must be …".
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\bdocument\.scenes\[\d+\](?:\.layers\[\d+\])?\./g, "");
    const details = { safeToRetry: true };
    if (index != null) Object.assign(details, { op: index, type });
    if (error?.suggestions?.length) details.didYouMean = error.suggestions;
    // isolate_voice: which voice error it was (the reason says what to send instead).
    if (error?.voiceError) details.voiceError = error.voiceError;
    // cut_out: which cut-out error it was (CUTOUT_RUNNING: send the same edit again later).
    if (error?.cutoutError) details.cutoutError = error.cutoutError;
    // board: which storyboard problem it was (missing_layer, gap, overlap or bad_shot).
    if (error?.boardError) details.boardError = error.boardError;
    const rules = rulesFor(type);
    if (rules) details.rules = rules;
    // An op that works once one field is added (move_layers mask:true): that op is the example.
    const example = index == null ? undefined : error?.retryWith && operation && typeof operation === "object" ? { ...operation, ...error.retryWith }
      : (!error?.example && !error?.noExample && effectSettingRetry(type, operation, error))
        || exampleOf(type, error, typeof operation?.layer === "string" ? operation.layer : undefined, operation?.name);
    if (example) details.example = example;
    return new AgentError("op_failed", index == null ? `The operations were refused together: ${reason}` : `Operation ${index} (${type}) was refused: ${reason}`, details);
  }

  // Readable names for created things: "hero-title": "L3", "hero-title.in": "A5". Things with
  // no readable name are listed only by code, as ranges ("A7-A12, L4").
  function createdNames(after, ids, codes) {
    const objects = documentObjects(after);
    const animationName = new Map();
    for (const entry of objects.animations) {
      if (!entry.layer || refName(entry.id, codes) !== entry.id) {
        const sameKind = objects.animations.filter((other) => other.layer && other.layer.id === entry.layer?.id && other.parents.length === 0 && other.animation.kind === entry.animation.kind);
        if (entry.layer && entry.parents.length === 0 && sameKind.length === 1 && /^[a-z]/i.test(entry.animation.kind ?? ""))
          animationName.set(entry.id, `${refName(entry.layer.id, codes)}.${entry.animation.kind}`);
        // A second custom animation of a layer is named by the name the agent gave it
        // ("dot2.Back"), when that name finds only it.
        else if (entry.layer && entry.parents.length === 0 && !entry.animation.preset && typeof entry.animation.name === "string") {
          const job = entry.animation.name.toLowerCase();
          const same = objects.animations.filter((other) => other.layer?.id === entry.layer.id && other.parents.length === 0
            && (other.animation.kind === job || String(other.animation.name ?? "").toLowerCase() === job));
          if (job && !job.includes(".") && same.length === 1) animationName.set(entry.id, `${refName(entry.layer.id, codes)}.${entry.animation.name}`);
        }
      }
    }
    const named = {};
    const unnamed = [];
    let more = 0;
    for (const id of ids) {
      const code = codes.byId[id] ?? id;
      const name = animationName.get(id) ?? (refName(id, codes) === id ? id : null);
      if (!name || name === code) unnamed.push(code);
      else if (Object.keys(named).length < RECEIPT_LIST) named[name] = code;
      else more += 1;
    }
    return { named, unnamed: ranges(unnamed), more };
  }

  // Each name the edit gave that was already in use, and the ID it got instead
  // ({renamed:{"r80":"r80-2"}}), always in full: the created list stops at RECEIPT_LIST names.
  // A name given to several new things lists each ID.
  function renamedNames(renamed, after) {
    if (!renamed?.length) return {};
    const objects = documentObjects(after);
    const made = new Set([...objects.scenes, ...objects.layers, ...objects.animations].map((entry) => entry.id));
    const result = {};
    for (const { name, id } of renamed) {
      if (!made.has(id)) continue;
      result[name] = result[name] === undefined ? id : [result[name]].flat().concat(id);
    }
    return Object.keys(result).length ? { renamed: result } : {};
  }

  // How many changed (or removed) things the receipt leaves out of its list: `changedMore: 12`.
  function listedMore(list, changes) {
    const more = Math.max(0, changes[list].length - RECEIPT_LIST) + (changes[`${list}More`] ?? 0);
    return more ? { [`${list}More`]: more } : {};
  }

  // The start and end of each animation the edit made or retimed: at most TIMES_LIST, and
  // `more` counts the rest. An animation whose times did not change is left out.
  function animationTimes(before, after, ids, codes) {
    const wanted = new Set(ids);
    const key = (entry) => `${entry.scene.id}/${entry.id}`;
    const old = new Map(documentObjects(before).animations.map((entry) => [key(entry), animationSpan(entry.animation, entry.offset).join()]));
    const times = {};
    let more = 0;
    for (const entry of documentObjects(after).animations) {
      if (!wanted.has(entry.id)) continue;
      const span = animationSpan(entry.animation, entry.offset);
      if (old.get(key(entry)) === span.join()) continue;
      if (Object.keys(times).length < TIMES_LIST) times[refName(entry.id, codes)] = span;
      else more += 1;
    }
    return { times, more };
  }

  // How many keys each keyed animation the edit made or changed has: `keys: {A1: 4}`.
  function animationKeyCounts(after, ids, codes) {
    const wanted = new Set(ids);
    const counts = {};
    for (const entry of documentObjects(after).animations) {
      if (!wanted.has(entry.id) || !entry.animation.keys?.length || Object.keys(counts).length >= TIMES_LIST) continue;
      counts[refName(entry.id, codes)] = entry.animation.keys.length;
    }
    return Object.keys(counts).length ? { keys: counts } : {};
  }

  function changedSince(before, after, codes) {
    const changes = documentChanges(before, after);
    const name = (id) => refName(id, codes);
    return [...changes.created, ...changes.changed, ...changes.removed].slice(0, RECEIPT_LIST).map(name);
  }

  // The document with `ops` applied as an edit would apply them, nothing saved (try rounds):
  // throws the edit's refusal when an op is wrong.
  async function documentWith(record, ops) {
    const list = Array.isArray(ops) ? ops : [ops];
    if (!list.length) return record.document;
    const before = record.document;
    const projectId = before.id;
    const codes = await syncCodes(projectId, before);
    const resolver = await waiverReferences(createResolver(before, codes), before, list);
    const translation = translateAll(list, resolver, before);
    const problems = translation.problems.map(translationProblem);
    const after = await applyAll(before, translation.operations, list, { resolver, notes: [], reports: new Map() }, problems, translation.blocked);
    if (problems.length) throw refusal(projectId, list, problems, translation.blocked);
    return after;
  }

  // The library screen's samples (library-catalog.mjs): the entry's sample ops run through the
  // agent's own edit path on an empty scene, nothing saved. Kept once built; an entry the sample
  // cannot build answers null (a video format), or the reason it was refused.
  const samples = new Map();
  // A move's card shows the middle of the move (a transition halfway through), not its end, or
  // the share of it the sample names.
  const moveMiddle = (document, share = 0.5) => {
    const move = document.scenes[0]?.moves?.[0];
    return Number.isFinite(move?.start) && Number.isFinite(move?.end) ? Math.round((move.start + (move.end - move.start) * share) * 30) / 30 : null;
  };
  // The stretch a sample's preview loops: from a little before its first change to a little after
  // its last (a move's own span when it has one), at least 1.5 s, so it is not mostly a still.
  const sampleLoop = (document) => {
    const scene = document.scenes[0];
    const duration = Number(scene?.duration) || 1;
    const move = scene?.moves?.[0];
    const spans = Number.isFinite(move?.start) && Number.isFinite(move?.end) ? [[move.start, move.end]]
      : (scene?.layers ?? []).flatMap((layer) => (layer.animations ?? []).map((animation) => [animation.start, animation.start + (animation.duration ?? 0)]));
    if (!spans.length) return [0, duration];
    const from = Math.max(0, Math.min(...spans.map(([start]) => start)) - 0.4);
    let to = Math.min(duration, Math.max(...spans.map(([, end]) => end)) + 0.9);
    if (to - from < 1.5) to = Math.min(duration, from + 1.5);
    return [Math.round(from * 30) / 30, Math.round(to * 30) / 30];
  };
  // Opening the library draws the samples' pictures and clip once (about 2 s the first time), so
  // the first card does not wait for them.
  const libraryWarm = () => { if (deps.mediaRoot) libraryMedia(deps.mediaRoot).catch(() => {}); };
  async function librarySample(kind, name) {
    const key = `${kind}:${name}`;
    if (!samples.has(key)) samples.set(key, (async () => {
      const sample = sampleOps(kind, name);
      if (!sample) return null;
      const scene = createScene({ id: "library-scene", name: "sample", ...SAMPLE_FRAME, duration: sample.duration, background: "#0B0E12" });
      const before = parseDocument(createDocument({ id: "library-sample", name: "sample", scenes: [scene] }));
      const resolver = createResolver(before, assignCodes({}, before));
      const translation = translateAll(sample.ops, resolver, before);
      const problems = translation.problems.map(translationProblem);
      try {
        // The samples' own pictures and clip (library-media.mjs) stand in for uploads.
        const mediaList = deps.mediaRoot ? await libraryMedia(deps.mediaRoot) : [];
        const document = await applyAll(before, translation.operations, sample.ops, { resolver, notes: [], reports: new Map(), mediaList }, problems, translation.blocked);
        return problems.length ? { document: null, reason: problems[0].message ?? String(problems[0]) }
          : { document, still: moveMiddle(document, sample.share) ?? sample.still, loop: sampleLoop(document), ...(sample.strip ? { strip: sample.strip } : {}) };
      } catch (error) { return { document: null, reason: error.message }; }
    })());
    return samples.get(key);
  }
  // A card's still, drawn by the export renderer (effects included), 480 px wide. Kept on disk by
  // the sample's content (about 0.5 s to draw), so a changed sample is drawn again.
  const stills = new Map();
  async function libraryStill(kind, name) {
    const key = `${kind}:${name}`;
    if (!stills.has(key)) stills.set(key, (async () => {
      const sample = await librarySample(kind, name);
      if (!sample?.document) return null;
      const { document } = sample;
      // Animation ids are new on each build, so they are left out of the key.
      const content = JSON.stringify([sample.still, sample.strip ?? null, document], (field, value) => (field === "id" && /^[0-9a-f-]{36}$/.test(value) ? undefined : value));
      const file = path.join(agentDirectory, "library", `${createHash("sha256").update(content).digest("hex").slice(0, 24)}.png`);
      const kept = await readFile(file).catch(() => null);
      if (kept) return kept;
      const prepared = await prepare(document, document.scenes[0].id, await fontsFor(document));
      // A cut cannot show in one frame: a strip of slices, one per moment, side by side.
      const png = sample.strip ? await stripPng(await Promise.all(sample.strip.map(async (time) => (await look.frame(prepared, time, 480)).png)))
        : (await look.frame(prepared, sample.still, 480)).png;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, png);
      return png;
    })().catch(() => null));
    return stills.get(key);
  }

  async function edit(input) {
    let record = await projectFor(input);
    const projectId = record.document.id;
    const ops = await withBorrowedRhythm(editOperations(input, projectId), record.document, { dryRun: input.dry_run === true });
    // Deleting a scene needs your approval (D3). bulk_create with deleteMissing:true deletes the
    // variants its CSV leaves out, so that edit asks once it knows which scenes go (below).
    const opList = Array.isArray(ops) ? ops : [ops];
    const bulkDeletes = input.dry_run !== true && opList.some((op) => (op?.op ?? op?.type) === "bulk_create" && op.deleteMissing === true);
    const sceneDeletes = input.dry_run === true || bulkDeletes ? [] : opList.filter((op) => (op?.op ?? op?.type) === "delete_scene");
    if (sceneDeletes.length) {
      const waiting = await approvalFor([{ kind: "delete-scene", summary: `deleting ${sceneDeletes.map((op) => op.sceneId ?? op.scene ?? "a scene").join(", ")} in ${projectId}` }], projectId, "edit", input);
      if (waiting) return waiting;
    }
    const baseRevision = input.rev;
    if (baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || baseRevision < 1))
      throw new AgentError("bad_input", "rev must be a positive whole number (or left out to edit the latest version).");
    if (baseRevision > record.revision)
      throw new AgentError("bad_input", `rev ${baseRevision} is newer than the project (rev ${record.revision}).`, { currentRev: record.revision });
    const request = input.request_id === undefined ? undefined
      : createOperationRequest({ requestId: input.request_id, revision: baseRevision ?? 0, operations: ops }, "owner");
    if (request) {
      const first = await store.getOperationResult(projectId, request);
      if (first?.agentReceipt) return { project: projectId, data: { ...first.agentReceipt, repeated: true }, receipt: true };
    }

    for (let attempt = 0; ; attempt += 1) {
      const editBag = { reports: new Map() };
      const before = record.document;
      const codes = await syncCodes(projectId, before);
      const resolver = await waiverReferences(createResolver(before, codes), before, ops);
      if (ops.wrapped) resolver.fixes.push("ops {…} → [{…}]");
      const stale = baseRevision !== undefined && baseRevision < record.revision;
      let after, work, translation;
      try {
        try { translation = translateAll(ops, resolver, before); }
        catch (error) { throw new AgentError("bad_input", error.message, { safeToRetry: true }); }
        const problems = translation.problems.map(translationProblem);
        // `work` is shared by set_font, the block ops, detect_beats, isolate_voice and cut_out: fonts, media, notes, reports, the names and the cut_outs' deadline.
        work = { resolver, notes: [], reports: editBag.reports };
        after = await applyAll(before, translation.operations, ops, work, problems, translation.blocked);
        if (problems.length) throw refusal(projectId, ops, problems, translation.blocked, await waiverFixCall(before, problems, codes));
        // compose {footage}: check fixes the new edit before it is saved, in this same revision.
        if (work.footage && input.dry_run !== true) {
          const fixed = await finishFootage(after, work.footage.sceneId, codes);
          after = fixed.document;
          work.finished = fixed.finished;
        }
        // variants {vary:"format"}: the same for each new format, with what is left per scene.
        if (work.finishScenes?.length && input.dry_run !== true) {
          // A compose {footage} in the same edit keeps its report, under its scene.
          const composed = work.finished ? (({ next, ...left }) => left)(work.finished) : null;
          work.finished = composed ? { [refName(work.footage.sceneId, codes)]: composed } : {};
          for (const sceneId of work.finishScenes) {
            const fixed = await finishFootage(after, sceneId, codes, 3);
            after = fixed.document;
            const { next, ...left } = fixed.finished;
            work.finished[refName(sceneId, codes)] = left;
          }
          const errors = Object.values(work.finished).some((entry) => entry.errors);
          work.finished.next = errors ? 'check {scene} (fix the errors it lists), then look {mode:"variants"}' : 'look {mode:"variants"}, then look {mode:"review", scene} on each';
        }
      } catch (error) {
        // An edit written against an older version that no longer applies is a conflict:
        // say what moved instead of sending the whole project back.
        if (stale && error instanceof AgentError) {
          const old = await store.getProjectRevision(projectId, baseRevision).catch(() => null);
          throw new AgentError("conflict", `The project changed since rev ${baseRevision} and your operations no longer apply (${error.message}).`, {
            currentRev: record.revision, ...(old ? { changedIds: changedSince(old, before, codes) } : {}),
            next: "Read status (it shows only what changed), then send the edit again without rev.", safeToRetry: false,
          });
        }
        throw error;
      }
      // The idea before the template (brief.mjs orderStep): on a briefed video, an edit that adds
      // visual layers or animations waits for the references, the treatments and the signature.
      // Only the first build waits: a video already built (before this order existed, or by the
      // person) takes further changes without being sent back to its treatments.
      const building = buildsSomething(before, after);
      if (building === "first") await refuseOutOfOrder(projectId, after);
      // The edit is worked out but not saved: ask about every scene it would remove. The approval
      // keeps their ids, so the allowed edit asks again if it would then remove any other scene.
      if (bulkDeletes) {
        const removed = before.scenes.filter((scene) => !after.scenes.some((entry) => entry.id === scene.id));
        const names = removed.map((scene) => `${refName(scene.id, codes)} ('${scene.name}')`);
        const waiting = removed.length ? await approvalFor([{ kind: "delete-scene", targets: removed.map((scene) => scene.id),
          summary: `deleting ${plural(removed.length, "scene")} in ${projectId}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""}` }], projectId, "edit", input) : null;
        if (waiting) return waiting;
      }
      // A layer an always note keeps stays: the person decides (notes stopped).
      await keptLayersCheck(projectId, before, after, codes, { dryRun: input.dry_run === true });

      const changes = documentChanges(before, after);
      const fonts = await fontsFor(after);
      const afterCodes = assignCodes(codes, after, resolver.reserved);
      const { findings, unchecked, stale: staleWaivers } = await findingsFor(after, { fonts, codes: afterCodes });
      // The findings this edit brought into the stretch it changed, so a regression shows at once.
      const removedLayers = (before.scenes ?? []).flatMap((scene) => (scene.layers ?? []).filter((layer) => changes.removed.includes(layer.id)).map((layer) => ({ sceneId: scene.id, layerId: layer.id })));
      const stretches = changedStretches(before, after, [...touchedLayers(before, after), ...removedLayers], changes.changed);
      const newFindings = stretches.size ? newFindingsLine((await findingsFor(before, { fonts, codes })).findings, findings, stretches) : null;
      const created = createdNames(after, changes.created, afterCodes);
      const timed = animationTimes(before, after, [...changes.created, ...changes.changed], afterCodes);
      // A value update_layer set that an animation draws over (opacity 0 under a fade-in).
      const covered = new Set();
      const overridden = overriddenValues(after, translation.operations, (id) => refName(id, afterCodes), before, covered);
      if (overridden.length) (work.warnings ??= []).push(...overridden);
      // An animation this edit added or changed that starts away from where its layer is drawn
      // (not on a place a line above already joins).
      const jumps = animationJumps(after, translation.operations, (id) => refName(id, afterCodes), before, covered);
      if (jumps.length) (work.warnings ??= []).push(...jumps);
      const handEdits = moveHandEdits(after, translation.operations, (id) => refName(id, afterCodes));
      if (handEdits.length) (work.warnings ??= []).push(...handEdits);
      // A rule this edit waived past the limit is likely kino's mistake: say so in the receipt.
      const waivedCodes = translation.operations.filter((operation) => operation.type === "waive_check").map((operation) => operation.code);
      const waiverNote = waivedCodes.length ? waiverNotes(liveWaivers(after.checkWaivers, staleWaivers), { codes: waivedCodes }) : [];
      // Spoken lines of the footage that no layer plays: named once, here or in status (linesToName).
      const lineNote = await linesToName(after, afterCodes, await agentState.read(projectId));
      if (lineNote) work.notes.push(lineNote.text);
      const receipt = {
        ...(input.dry_run ? { dryRun: true, wouldBeRev: record.revision + 1 } : {}),
        created: created.named,
        ...(created.unnamed ? { createdCodes: created.unnamed } : {}),
        ...(created.more ? { createdMore: created.more } : {}),
        ...renamedNames(resolver.renamed, after),
        changed: changes.changed.slice(0, RECEIPT_LIST).map((id) => refName(id, afterCodes)),
        ...listedMore("changed", changes),
        removed: changes.removed.slice(0, RECEIPT_LIST).map((id) => refName(id, codes)),
        ...listedMore("removed", changes),
        ...(Object.keys(timed.times).length ? { times: timed.times } : {}),
        ...(timed.more ? { timesMore: timed.more } : {}),
        ...animationKeyCounts(after, [...changes.created, ...changes.changed], afterCodes),
        ...(resolver.fixes.length ? { fixed: [...new Set(resolver.fixes)] } : {}),
        ...(work.notes.length || resolver.notes.length || waiverNote.length ? { notes: [...work.notes, ...new Set(resolver.notes), ...waiverNote] } : {}),
        // compose {footage}: the plan in words (all of it in a dry run).
        ...(work.plan ? { plan: input.dry_run ? work.plan : work.plan.slice(0, 2) } : {}),
        ...(work.finished ? { finished: work.finished } : {}),
        ...(stale ? { rebased: true } : {}),
        ...reportFields(editBag.reports, afterCodes, translation.operations),
        check: checkSummary(findings, { unchecked }),
        ...(newFindings ? { newFindings } : {}),
        ...(work.warnings?.length ? { warnings: [...new Set(work.warnings)] } : {}),
        ...(work.summaries?.length ? { summaries: work.summaries.map((summary) => ({ ...summary, ...(input.dry_run ? { preview: true } : {}) })) } : {}),
      };
      if (input.dry_run) {
        const finish = await finishCall(projectId);
        return { receipt: true, project: projectId, data: { ...receipt, rev: record.revision, turn: finish.turn, inbox: finish.inbox } };
      }
      const actor = byYou() ? "you" : "agent";
      let updated;
      try {
        updated = await saveDocument(projectId, before, after, record.revision, { request, actor, resultMetadata: { changes, agentReceipt: { rev: record.revision + 1, ...receipt } } });
      } catch (error) {
        // Someone saved between reading and saving: run the same operations on their version once.
        if (error instanceof ConflictError && attempt === 0) { record = await projectFor({ project: projectId }); continue; }
        throw error;
      }
      if (!updated.document && updated.agentReceipt)
        return { project: projectId, data: { ...updated.agentReceipt, repeated: true }, receipt: true };
      // The references saved at a briefed video's first build: the final render's reference gate
      // counts only these and the ones studied before it (refuseWithoutReference).
      const savedAtBuild = building ? await savedIds(projectId) : null;
      await agentState.update(projectId, (state) => {
        if (savedAtBuild && !state.firstBuild && hasBrief(state.brief)) state.firstBuild = { rev: updated.revision, saved: savedAtBuild, studied: [...(state.studied ?? [])] };
        state.codes = assignCodes(state.codes, updated.document, resolver.reserved);
        if (lineNote) state.linesNamed = lineNote.key;
        // The layers this edit moved (placedByYou); check's own auto-fix edit does not count.
        if (!autoFixEdits.has(input)) state.placed = { rev: updated.revision, ids: movedLayers(before, updated.document) };
        // The agent hears about an edit the person made from the command line.
        if (actor === "you") state.inbox.push({ kind: "edit", text: `you edited ${plural(ops.length, "op")} (rev ${record.revision}→${updated.revision})${receipt.changed.length ? `: ${receipt.changed.slice(0, 8).join(", ")}` : ""}` });
      });
      const board = await settleBoardAfter(projectId, before, updated);
      const finish = await finishCall(projectId, { edit: { before: record.revision, after: updated.revision, ops: ops.length, at: new Date(now()).toISOString() } });
      return { receipt: true, project: projectId, data: { rev: updated.revision, ...receipt, ...(board ? { board } : {}), ...(finish.turn ? { turn: finish.turn } : {}), inbox: finish.inbox } };
    }
  }

  // ---- status -----------------------------------------------------------------------------
  async function status(input) {
    if (!input.project && !(await readCurrent())) return listProjects();
    let record;
    try { record = await projectFor(input); }
    catch (error) {
      if (error.code === "unknown_project" && !input.project) { current = null; return listProjects(); }
      throw error;
    }
    const projectId = record.document.id;
    const document = record.document;
    const codes = await syncCodes(projectId, document);
    await liveStop(record);
    await settleBoardNow(record);
    const state = await agentState.read(projectId);
    const focus = sceneFor(document, codes, input.scene, state.focus);
    const fonts = await fontsFor(document);
    const { findings, unchecked } = await findingsFor(document, { fonts, codes });
    // The dashboard's selection carries the line it showed you, word for word.
    const selected = deps.pointing?.(projectId);
    const pointing = selected ? (selected.line ?? pointingText(selected, { codes })) : null;
    const deck = await deckFor(projectId, document);
    const deckLine = deck ? deckStatusLine(deck.deck, deck.basis) : "";
    const always = alwaysLine(state.notes, codes);
    const needs = needsLine(state.needs);
    // Spoken lines of the footage that no layer plays, said once (an edit receipt may have said them).
    const lineNote = await linesToName(document, codes, state);
    if (lineNote) await nameLinesOnce(projectId, lineNote.key);
    // Past the build (built and checked once, no stop waiting, the storyboard stop not open): every
    // gate left before the final render. A gate that fails to work out leaves the line out.
    const prebuild = waitingStop(state) || openStops(state, await directionFacts(document), stopRulesNow()).some((stop) => stop.kind === "board");
    const toFinal = hasLayers(document) && state.checked && !prebuild ? await finalGates(record).then(toFinalLine, () => "") : "";
    const outline = projectOutline(record, {
      codes, focus: focus.id, page: input.page ?? 1, seen: state.seen ?? {}, full: input.full === true,
      plan: state.plan, checks: checkSummary(findings, { unchecked }), pointing, direction: [...statusLines(state, await directionFacts(document), stopRulesNow()), ...(controlsLine(state.brief?.controls) ? [controlsLine(state.brief.controls)] : []), ...(toFinal ? [toFinal] : []), ...(deckLine ? [deckLine] : []), ...(always ? [always] : []), ...(needs ? [needs] : []), ...(lineNote ? [lineNote.text] : [])],
    });
    // What waits for the person: approvals, and a hold on agent writes.
    const waiting = deps.approvals?.pending?.(projectId) ?? [];
    const extra = [
      waiting.length ? `awaiting the person's approval: ${waiting.slice(0, 5).map((entry) => `${entry.id} ${entry.summary}`).join("; ")}` : "",
      deps.hold?.().on ? "HOLD: the person paused agent writes; reads still work." : "",
    ].filter(Boolean);
    if (extra.length) outline.text = `${outline.text}\n${extra.join("\n")}`;
    const stop = waitingStop(state);
    noteLive({ sceneId: focus.id });
    return done(projectId, { text: outline.text, data: { project: projectId, rev: record.revision, focus: refName(focus.id, codes), ...(stop ? { waiting: stop.id } : {}) } },
      { change(draft) { draft.seen = outline.shown; draft.focus = focus.id; } });
  }

  async function listProjects() {
    const projects = await store.listProjects();
    if (!projects.length)
      return { text: "No projects yet. project create {id, name, width, height, duration} makes one.", data: { projects: [] } };
    const lines = [`${plural(projects.length, "project")} (none open; project open {id} or status {project})`];
    for (const project of projects.slice(0, 30))
      lines.push(`  ${project.id} '${project.name}' ${plural(project.sceneCount, "scene")} updated ${project.updatedAt.slice(0, 16).replace("T", " ")}`);
    if (projects.length > 30) lines.push(`  +${projects.length - 30} more`);
    return { text: lines.join("\n"), data: { projects: projects.map(({ id, name, sceneCount, updatedAt }) => ({ id, name, sceneCount, updatedAt })) } };
  }

  // ---- check and inspect -------------------------------------------------------------------
  async function check(input) {
    let record = await projectFor(input);
    const projectId = record.document.id;
    let codes = await syncCodes(projectId, record.document);
    const scene = input.scene ? sceneFor(record.document, codes, input.scene) : null;
    // fix:true means the same as fix:"auto".
    if (input.fix === true) input = { ...input, fix: "auto" };
    if (input.fix !== undefined && input.fix !== "auto") throw new AgentError("bad_input", 'fix is "auto" (apply the fixes marked auto), or left out: check {fix:"auto"}.');
    // rules: a list of rule codes limits the check; true only asks for the rules line.
    const rules = input.rules == null || input.rules === true ? null : (Array.isArray(input.rules) ? input.rules : [input.rules]).map(String);
    const options = { codes, sceneId: scene?.id, pixels: input.pixels !== false, listen: input.listen !== false, rules, outputFps: input.fps == null ? 30 : readFps(input.fps, (message) => new AgentError("bad_input", message)) };
    // A settled brief has a deck by the time the video is checked (deck_unused counts it).
    await deckFor(projectId, record.document);
    noteLive({ sceneId: scene?.id ?? null });
    let fonts = await fontsFor(record.document);
    let result = await findingsFor(record.document, { ...options, fonts });
    let applied = null;
    if (input.fix === "auto") {
      const keep = placedByYou(await agentState.read(projectId), codes, record.document);
      const outcome = await autoFix(record.document, result.findings, { ...options, fonts, keep });
      if (outcome.ops.length) {
        let receipt;
        const fixEdit = { project: projectId, ops: outcome.ops };
        autoFixEdits.add(fixEdit);
        try { receipt = await edit(fixEdit); }
        catch (error) {
          if (!(error instanceof AgentError)) throw error;
          throw new AgentError(error.code, `The auto fixes could not be saved, so none were: ${error.message}`, { fixes: outcome.fixed });
        }
        applied = { ops: outcome.ops.length, rev: receipt.data.rev, fixed: outcome.fixed, dropped: outcome.dropped };
        record = await projectFor({ project: projectId });
        codes = await syncCodes(projectId, record.document);
        fonts = await fontsFor(record.document);
        result = await findingsFor(record.document, { ...options, codes, fonts });
      } else applied = { ops: 0, fixed: [], dropped: outcome.dropped };
    }
    await explainMissingGlyphs(result.findings, record.document, { fonts, catalog: fontCatalog, codes });
    if (!scene) await recordDeckUse(projectId, result.techniques);
    const report = checkReport(result.findings, { info: Boolean(rules) });
    const counts = `${report.errors} err · ${report.warnings} warn${report.info ? ` · ${report.info} info` : ""}${report.waived ? ` · ${report.waived} waived` : ""}`;
    const lines = [`rev ${record.revision} · ${counts}${scene ? ` · ${refName(scene.id, codes)} only` : ""}${options.pixels ? "" : " · pixels off"} · ${result.ms} ms`];
    // A rule waived over and over in one project is likely kino's mistake, not taste. Right after
    // the counts, so an agent that reads only the first lines still sees it.
    for (const note of waiverNotes(liveWaivers(record.document.checkWaivers, result.stale))) lines.push(`note: ${note}`);
    const staleLine = staleWaiverLine(result.stale, (id) => (id === "*" ? "*" : refName(id, codes)));
    if (staleLine) lines.push(staleLine);
    if (applied) {
      lines.push(applied.ops ? `applied ${applied.fixed.length} auto ${applied.fixed.length === 1 ? "fix" : "fixes"} in one edit (now rev ${applied.rev}); history can undo it.` : "No auto fixes to apply.");
      for (const line of applied.fixed) lines.push(`  fixed ${line}`);
      for (const line of groupFixLines(applied.dropped)) lines.push(`  not applied ${line}`);
    }
    for (const finding of report.findings)
      lines.push(`${finding.severity === "error" ? "E" : finding.severity === "info" ? "I" : "W"} ${finding.rule} ${finding.ref}${finding.at != null ? ` @${sec(finding.at)}` : ""}: ${finding.message}${finding.fix ? ` fix${finding.auto ? "(auto)" : ""}: ${typeof finding.fix === "string" ? finding.fix : compact(finding.fix)}` : ""}`);
    if (report.more) lines.push(`+${report.more} more: ${report.moreByRule}. Fix these first, or check {scene} or {rules}.`);
    if (report.waivedFindings.length) lines.push(`waived: ${report.waivedFindings.slice(0, 5).map((entry) => `${entry.rule} ${entry.ref}`).join(", ")}${report.waivedFindings.length > 5 ? ", …" : ""}`);
    // Advice (info): taste notes in one line; they never block a render.
    if (report.advice) lines.push(`advice (does not block): ${report.advice}. check {rules:[code]} lists one.`);
    if (!report.errors && !report.warnings) lines.push("Nothing to fix.");
    else if (!applied && report.autoFixes) lines.push(`check {fix:"auto"} applies the ${report.autoFixes} ${report.autoFixes === 1 ? "fix" : "fixes"} marked auto.`);
    // What the video uses (engine/quality/techniques.js), and whose style the style rules follow.
    lines.push(`techniques: ${techniquesLine(result.techniques, 8)} · style: ${result.styleSpec ? "spec" : "kino default"}`);
    for (const note of result.notes) lines.push(`note: ${note}`);
    // The rules line comes with the agent's first check of a project since kino started, and
    // with {rules:true}. The dashboard's own checks (by you) do not count.
    if (input.rules === true || !checkRulesShown.has(projectId)) {
      lines.push(report.rules);
      if (!byYou()) checkRulesShown.add(projectId);
    }
    // A full check by the agent (every scene and rule, pixels on) is what a stop shows: it is
    // saved for this revision, after any auto fixes. The person's own checks (by you) are not.
    const full = !scene && !rules && options.pixels;
    const saveChecked = (draft) => {
      draft.checked = { rev: record.revision, errors: report.errors, warnings: report.warnings, at: new Date(now()).toISOString(), client: caller.getStore()?.client ?? null };
    };
    const data = { rev: record.revision, ...report, notes: result.notes, ms: result.ms, techniques: result.techniques, ...(applied ? { applied } : {}) };
    const repeat = applied ? null : repeatedCheck(projectId, input, record.revision, lines);
    return done(projectId, repeat ? { text: `${lines[0]}\n${repeat}`, data: { rev: record.revision, errors: report.errors, warnings: report.warnings, unchanged: true } }
      : { text: lines.join("\n"), data }, full ? { change: saveChecked } : undefined);
  }

  // The same check again from the same agent session, on the same revision, with the same
  // findings, within 15 minutes: one line instead of the findings again (the server log had 44
  // such repeats). rules:true always answers in full. CLI calls always answer in full: a shell
  // often runs the same check twice to filter it two ways (kino check | grep), seconds apart.
  const REPEAT_CHECK_MS = 15 * 60_000;
  function repeatedCheck(projectId, input, rev, lines) {
    const meta = caller.getStore() ?? {};
    if (byYou() || meta.client === "cli" || input.rules === true || input.fix) return null;
    const { why, next, ...asked } = input;
    const key = `${projectId}|${meta.client ?? ""}|${meta.session ?? ""}`;
    const ask = JSON.stringify(asked);
    // The first line ends with the time the check took: not part of what it found.
    const body = [lines[0].replace(/ · \d+ ms$/, ""), ...lines.slice(1).filter((line) => !line.startsWith("Rules"))].join("\n");
    const last = lastChecks.get(key);
    const at = now();
    lastChecks.set(key, { ask, rev, body, at: last?.ask === ask && last.rev === rev && last.body === body ? last.at : at });
    if (lastChecks.size > 200) lastChecks.delete(lastChecks.keys().next().value);
    if (!last || last.ask !== ask || last.rev !== rev || last.body !== body || at - last.at > REPEAT_CHECK_MS) return null;
    return `Unchanged since your same check ${Math.max(1, Math.round((at - last.at) / 1000))} s ago at this rev: the same findings. check {rules:true} lists them again.`;
  }

  // check's own edits (its auto fixes): they do not count as the agent placing a layer.
  const autoFixEdits = new WeakSet();

  // The layers that were there before and whose x or y an edit changed, as ids (new layers are
  // not: a fresh build still gets its auto fixes).
  function movedLayers(before, after) {
    const old = new Map((before.scenes ?? []).flatMap((scene) => (scene.layers ?? []).map((layer) => [layer.id, layer])));
    return (after.scenes ?? []).flatMap((scene) => scene.layers ?? [])
      .filter((layer) => old.has(layer.id) && (old.get(layer.id).x !== layer.x || old.get(layer.id).y !== layer.y)).map((layer) => layer.id).slice(0, 200);
  }

  // The layers check {fix:"auto"} leaves for a warning, as ref -> {why, moveOnly}: the ones the
  // latest edit moved (an auto move could undo the agent's answer to the critic; only
  // moves are held), and the ones a waiver names or the spine's beats use (designed elements:
  // a centered title and app shots could be pulled back to defaults; no fix touches them).
  // Their warnings stay; an error's fix still applies, and so does a push that grows a card in place.
  function placedByYou(state, codes, document) {
    const keep = new Map((state?.placed?.ids ?? []).map((id) => [refName(id, codes), { why: `you placed it (rev ${state.placed.rev})`, moveOnly: true }]));
    const layers = (document?.scenes ?? []).flatMap((scene) => scene.layers ?? []);
    const ids = new Set(layers.map((layer) => layer.id));
    for (const waiver of document?.checkWaivers ?? []) {
      const ref = refName(waiver.target, codes);
      if (ids.has(waiver.target) && keep.get(ref)?.moveOnly !== false) keep.set(ref, { why: `a waiver names it (${waiver.code})`, moveOnly: false });
    }
    for (const beat of Array.isArray(state?.brief?.style?.spine) ? state.brief.style.spine : []) {
      const uses = new Set((beat?.uses ?? []).map((name) => String(name).toLowerCase()));
      for (const layer of layers) {
        const ref = refName(layer.id, codes);
        if (keep.get(ref)?.moveOnly === false || !(uses.has(String(layer.name ?? "").toLowerCase()) || uses.has(layer.id.toLowerCase()) || uses.has(String(ref).toLowerCase()))) continue;
        keep.set(ref, { why: `the spine's ${beat.role} uses it`, moveOnly: false });
      }
    }
    return keep;
  }

  // The fixes check {fix:"auto"} applies: those marked auto, on findings that are not waived, as
  // [{key, ops, refs, line}]: `refs` the layers they change (and the finding's), `line` what the
  // answer says. When two fixes set the same field of the same thing, the first one wins.
  // `skip` holds fixes already tried: they claim nothing, so another fix of the same property
  // (a text_collision move after a refused overlap move) still gets its turn.
  // `keep` (ref -> {why, moveOnly}, placedByYou) holds layers a warning's fix leaves alone (only
  // its move, for moveOnly): `held` gets one line for each.
  function autoFixGroups(findings, taken = new Set(), skip = new Set(), keep = null, held = null) {
    const groups = [];
    for (const finding of findings) {
      if (!finding.auto || finding.waived || !finding.fix || typeof finding.fix !== "object") continue;
      if (skip.has(`${finding.rule} ${finding.ref}`)) continue;
      const ops = Array.isArray(finding.fix) ? finding.fix : [finding.fix];
      const target = (op) => op.animationId ?? op.layerId ?? op.properties?.name ?? op.sceneId ?? "";
      const keys = ops.flatMap((op) => Object.keys(op.properties ?? {}).map((key) => `${op.op} ${target(op)} ${key}`));
      // One fix moves a layer per round: two worked out from the same document (a cut_off_at_rest
      // move and a frozen_screen push) would each write the old position, and the picture jumps.
      // The next round's fix starts from the moved layer.
      const moves = (values) => values && typeof values === "object" && ("x" in values || "y" in values);
      const moving = ops.filter((op) => moves(op.properties) || moves(op.properties?.from) || moves(op.properties?.to) || moves(op.animation?.from) || moves(op.animation?.to));
      if (finding.ref && moving.length) keys.push(`position ${finding.ref}`);
      // A push (held_static's end card growing in place over its hold) moves no layer back.
      if (finding.severity !== "error" && !finding.push && keep) {
        const touched = [finding.ref, ...ops.flatMap((op) => [op.layerId, ...(op.layerIds ?? [])])];
        const kept = touched.find((ref) => keep.get(ref)?.moveOnly === false)
          ?? (moving.length ? [finding.ref, ...moving.map((op) => op.layerId)].find((ref) => keep.has(ref)) : undefined);
        if (kept) { held?.add(`${finding.rule} ${finding.ref}: left ${moving.length ? "where" : "alone:"} ${keep.get(kept).why}; the warning stays`); continue; }
      }
      if (keys.some((key) => taken.has(key))) continue;
      for (const key of keys) taken.add(key);
      const refs = new Set([finding.ref, ...ops.flatMap((op) => [op.layerId, ...(op.layerIds ?? []), op.properties?.name])].filter(Boolean));
      groups.push({ key: `${finding.rule} ${finding.ref}`, ops, refs, line: `${finding.rule} ${finding.ref}${finding.why ? `: ${finding.why}` : ""}` });
    }
    return groups;
  }

  // The document `ops` would make, worked out but not saved (an edit's dry run). Throws the
  // refusal an edit would give.
  async function simulateOps(document, ops, codes) {
    const resolver = await waiverReferences(createResolver(document, codes), document, ops);
    let translation;
    try { translation = translateAll(ops, resolver, document); }
    catch (error) { throw new AgentError("bad_input", error.message); }
    const problems = translation.problems.map(translationProblem);
    const after = await applyAll(document, translation.operations, ops, { resolver, notes: [], reports: new Map() }, problems, translation.blocked);
    if (problems.length) throw problems[0];
    return after;
  }

  // The errors in `after` that `before` does not have (by rule and layer, counted).
  function addedErrors(before, after) {
    const counts = new Map();
    const key = (finding) => `${finding.rule}|${finding.ref}`;
    for (const finding of before) if (finding.severity === "error" && !finding.waived) counts.set(key(finding), (counts.get(key(finding)) ?? 0) + 1);
    return after.filter((finding) => {
      if (finding.severity !== "error" || finding.waived) return false;
      const left = counts.get(key(finding)) ?? 0;
      counts.set(key(finding), left - 1);
      return left <= 0;
    });
  }

  // True when a finding is about one of `refs`: its layer, or a layer its message names.
  function mentions(finding, refs) {
    if (refs.has(finding.ref)) return true;
    return [...refs].some((ref) => new RegExp(`(^|[^\\w-])${String(ref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(finding.message ?? ""));
  }

  /**
   * check {fix:"auto"}: the safe fixes, proven safe before they are saved. Every fix must apply on
   * its own; then all of them are worked out together and checked (pixels too, when the check has
   * them). A fix that brings a new error (a moved caption now over low contrast, a plate that
   * touches another text) is dropped, with the reason, and the rest checked again. Fixes the first
   * ones make possible (a brand font after a fallback weight) get up to two more rounds. Returns {ops,
   * fixed, dropped}: the ops for one edit, and one short line for each fix kept or dropped.
   */
  async function autoFix(document, findings, options) {
    const { codes, fonts } = options;
    const full = { ...options, rules: null };
    let base = document;
    let baseFindings = options.rules ? (await findingsFor(document, { ...full, fonts })).findings : findings;
    const held = new Set();
    let pending = autoFixGroups(findings, new Set(), new Set(), options.keep, held);
    const tried = new Set(pending.map((group) => group.key));
    const kept = [];
    const dropped = [];
    for (let round = 0; round < 3 && pending.length; round += 1) {
      const usable = [];
      for (const group of pending) {
        try { await simulateOps(base, group.ops, codes); usable.push(group); }
        catch (error) { dropped.push(`${group.key}: refused (${String(error.message).slice(0, 120)})`); }
      }
      let candidates = usable;
      for (let attempt = 0; candidates.length && attempt < 3; attempt += 1) {
        let after;
        try { after = await simulateOps(base, candidates.flatMap((group) => group.ops), codes); }
        catch (error) {
          // Each applies alone but not together: the last one gives way.
          dropped.push(`${candidates.at(-1).key}: refused with the others (${String(error.message).slice(0, 120)})`);
          candidates = candidates.slice(0, -1);
          continue;
        }
        const checked = await findingsFor(after, { ...full, fonts: await fontsFor(after), codes });
        const added = addedErrors(baseFindings, checked.findings);
        // A fix that leaves its own finding in place is not kept either: so the next
        // check {fix:"auto"} does not stack another change on the same thing.
        const still = added.length ? [] : candidates.filter((group) => checked.findings.some((finding) => !finding.waived
          && `${finding.rule} ${finding.ref}` === group.key));
        if (still.length) {
          for (const group of still) dropped.push(`${group.key}: it did not clear the finding`);
          // Tried with others, it may have been undone by one of them: the next round tries it again.
          if (candidates.length > still.length) for (const group of still) tried.delete(group.key);
          candidates = candidates.filter((group) => !still.includes(group));
          attempt -= 1;
          continue;
        }
        if (!added.length) {
          kept.push(...candidates);
          base = after;
          baseFindings = checked.findings;
          candidates = [];
          break;
        }
        let blamed = candidates.filter((group) => added.some((finding) => mentions(finding, group.refs)));
        // Several fixes on the same layer are all named: try each alone, and drop only the ones
        // that add an error by themselves (a move onto other text, not the color fix beside it).
        if (blamed.length > 1) {
          const guilty = [];
          for (const group of blamed) {
            try {
              const alone = await simulateOps(base, group.ops, codes);
              const found = await findingsFor(alone, { ...full, fonts: await fontsFor(alone), codes });
              if (addedErrors(baseFindings, found.findings).length) guilty.push(group);
            } catch { guilty.push(group); }
          }
          if (guilty.length) blamed = guilty;
        }
        const out = blamed.length ? blamed : candidates;
        for (const group of out) {
          const cause = added.find((finding) => mentions(finding, group.refs)) ?? added[0];
          dropped.push(`${group.key}: it would add ${cause.rule} on ${cause.ref}${blamed.length ? "" : " (not traced to one fix, so none were applied)"}`);
        }
        candidates = candidates.filter((group) => !out.includes(group));
      }
      for (const group of candidates) dropped.push(`${group.key}: still adds an error after 3 tries`);
      // The next round (up to 3): fixes the kept ones made possible, on findings not tried yet.
      pending = autoFixGroups(baseFindings.filter((finding) => !options.rules || options.rules.includes(finding.rule)), new Set(), tried, options.keep, held);
      for (const group of pending) tried.add(group.key);
    }
    // The saved edit runs every kept op from the start, in one go: a later fix that names
    // something an earlier one made must still find it. One that does not is left out.
    for (let tries = 0; kept.length && tries < 5; tries += 1) {
      try { await simulateOps(document, kept.flatMap((group) => group.ops), codes); break; }
      catch (error) {
        const index = Number(error.details?.op);
        let start = 0;
        const culprit = kept.find((group) => { const inside = index >= start && index < start + group.ops.length; start += group.ops.length; return inside; }) ?? kept.at(-1);
        dropped.push(`${culprit.key}: refused with the others (${String(error.message).slice(0, 120)})`);
        kept.splice(kept.indexOf(culprit), 1);
      }
    }
    const keptKeys = new Set(kept.map((group) => group.key));
    return { ops: kept.flatMap((group) => group.ops), fixed: kept.map((group) => group.line), dropped: [...held, ...dropped.filter((line) => !keptKeys.has(line.split(":")[0]))] };
  }

  async function inspect(input) {
    const record = await projectFor(input);
    const projectId = record.document.id;
    const codes = await syncCodes(projectId, record.document);
    // layer and layers are other names for targets. One string may hold several names with commas
    // ("walk-3,walk-4" from the command line); a comma inside a selector's [...] stays.
    // target is one too; speech:"vo" (or a list) is targets ["speech:vo"].
    const speechGiven = input.speech === undefined ? [] : [input.speech].flat().map((name) => `speech:${String(name).replace(/^speech:/, "")}`);
    const named = input.targets ?? input.target ?? input.layers ?? input.layer;
    const given = speechGiven.length ? [...(named == null ? [] : [named].flat()), ...speechGiven] : named;
    const targets = Array.isArray(given) ? given
      : typeof given === "string" ? given.split(/,(?![^[]*\])/).map((name) => name.trim()).filter(Boolean)
      : given != null ? [given] : [];
    if (!targets.length) throw new AgentError("bad_input", "targets lists 1 to 10 names, codes or selectors, such as [\"hero-title\", \"text[fontSize>40]\"].");
    {
      // The live view outlines the named layers (selectors and cues are left out).
      const resolver = createResolver(record.document, codes);
      const layerIds = targets.flatMap((target) => { try { return [resolver.resolve(String(target), "layer")]; } catch { return []; } });
      const sceneId = record.document.scenes.find((scene) => scene.layers.some((layer) => layer.id === layerIds[0]))?.id ?? null;
      noteLive({ sceneId, layerIds });
    }
    // A list, or one name or names with commas ("name,fontSize" from the command line). A list item
    // with commas is split too: ["name,width"] is ["name", "width"].
    const fields = Array.isArray(input.fields) ? input.fields.flatMap((name) => String(name).split(",")).map((name) => name.trim()).filter(Boolean)
      : typeof input.fields === "string" ? input.fields.split(",").map((name) => name.trim()).filter(Boolean)
      : undefined;
    if (input.fields != null && !(fields && (fields.length || Array.isArray(input.fields)))) throw new AgentError("bad_input", "fields is a list of field names, such as [\"name\", \"fontSize\"].");
    // "cues", "cues[kind=beat]" and "cues[from=60,to=90]" list document.cues and the rhythm
    // (cue-list.mjs), the earliest ones that fit one answer.
    const speechTargets = targets.filter((target) => SPEECH_TARGET.test(String(target).trim()));
    if (speechTargets.length) {
      // Several transcripts in turn, sharing one budget of words so the answer stays small; the
      // ones that do not fit are named for the next call.
      const texts = [];
      const left = [];
      let budget = SPEECH_BUDGET;
      let words = 0;
      for (const target of speechTargets) {
        if (budget < SPEECH_BUDGET_MIN) { left.push(target); continue; }
        let speech;
        try { speech = await speechList(record.document, codes, target, Math.min(budget, SPEECH_BUDGET_ONE)); }
        catch (error) {
          if (error instanceof AgentError) throw error;
          throw new AgentError(error instanceof ReferenceError ? "not_found" : "bad_input", error.message.replace(/^speech: /, ""));
        }
        texts.push(speech.text);
        words += speech.words;
        budget -= speech.text.length;
      }
      if (left.length) texts.push(`not shown, to keep this answer short: inspect {targets:${JSON.stringify(left)}}`);
      const rest = targets.filter((target) => !speechTargets.includes(target));
      const others = rest.length ? inspectTargets(createResolver(record.document, codes), codes, { targets: rest, fields }) : null;
      return done(projectId, { text: [`rev ${record.revision}`, ...texts, ...(others ? [others.text] : [])].join("\n"),
        data: { rev: record.revision, words, ...(left.length ? { notShown: left } : {}), ...(others ? { count: others.count, matched: others.matched } : {}) } });
    }
    // "cuts" and "cuts[from=60]": each cut in the video with the words around it (cut-list.mjs).
    const cutTargets = targets.filter(isCutTarget);
    if (cutTargets.length) {
      if (targets.length > 1) throw new AgentError("bad_input", 'cuts is inspected on its own: inspect {targets:["cuts"]}.');
      const cutList = await cutListFor(record.document, codes, cutTargetFrom(cutTargets[0]));
      return done(projectId, { text: `rev ${record.revision}\n${cutList.text}`, data: { rev: record.revision, cuts: cutList.count, ...(cutList.shown < cutList.count ? { shown: cutList.shown } : {}) } });
    }
    const cueTargets = targets.filter(isCueTarget);
    if (cueTargets.length) {
      let cueList;
      try { cueList = cueListText(record.document, cueTargets); }
      catch (error) { throw new AgentError("bad_input", error.message); }
      const rest = targets.filter((target) => !isCueTarget(target));
      const others = rest.length ? inspectTargets(createResolver(record.document, codes), codes, { targets: rest, fields }) : null;
      return done(projectId, { text: [`rev ${record.revision}`, cueList.text, ...(others ? [others.text] : [])].join("\n"),
        data: { rev: record.revision, cues: cueList.count, ...(cueList.shown < cueList.count ? { shown: cueList.shown } : {}), ...(others ? { count: others.count, matched: others.matched } : {}) } });
    }
    const result = inspectTargets(createResolver(record.document, codes), codes, { targets, fields });
    return done(projectId, { text: `rev ${record.revision}\n${result.text}`, data: { rev: record.revision, count: result.count, matched: result.matched } });
  }

  // ---- look -------------------------------------------------------------------------------
  async function prepare(document, sceneId, fonts) {
    const scene = expandComponents(document, sceneId, { fonts });
    return { scene, fonts, key: sceneKey(scene, fonts) };
  }

  // When a layer is fully in: the end of its first entrance, or the middle of the scene.
  function settledTime(layer, scene) {
    const entrance = layerAnimations(layer).find(({ animation, depth }) => depth === 0 && animation.kind === "in");
    if (entrance) return Math.min(scene.duration, animationSpan(entrance.animation, entrance.offset)[1] + 0.05);
    return sec(scene.duration / 2);
  }

  async function lookAt(input) {
    // "time" or "at" in place of t: before, the frame was drawn at the scene's middle and the
    // answer only said "@10s", easy to miss. Now the time is read, and the answer says so.
    const misnamed = input.t == null ? ["time", "at"].find((key) => typeof input[key] === "number") : undefined;
    if (misnamed) input = { ...input, t: input[misnamed] };
    const record = await projectFor(input);
    noteDrawn(record);
    const projectId = record.document.id;
    const document = record.document;
    const codes = await syncCodes(projectId, document);
    const resolver = createResolver(document, codes);
    const state = await agentState.read(projectId);
    const mode = input.mode ?? "sheet";
    const fonts = await fontsFor(document);
    const scene = sceneFor(document, codes, input.scene, state.focus);
    let image, text, lookKey = scene.id, extra = null, nextCall = null;

    if (mode === "review") return reviewLook(input, { record, codes, fonts, scene, state });
    if (mode === "versus") return versusLook(input, { record, codes, fonts, state });
    if (mode === "viewer") return viewerLook({ record, codes, fonts, scene, state });
    if (mode === "critique") return critiqueLook(input, { record, codes, fonts, scene, state });
    if (mode === "frame") {
      const time = clampTime(input.t ?? sec(scene.duration / 2), scene);
      // The longest edge is at most LOOK_MAX_EDGE (1280 px wide for 16:9, 720 px for 9:16).
      const widest = Math.floor(LOOK_MAX_EDGE * Math.min(1, scene.width / scene.height));
      const asked = Math.round(Math.max(64, input.width ?? Math.min(480, scene.width)));
      const width = Math.min(widest, asked);
      image = await look.frameImage(await prepare(document, scene.id, fonts), { time, width });
      noteLive({ sceneId: scene.id, time }, [{ sceneId: scene.id, time }]);
      text = `frame ${refName(scene.id, codes)} @${time}s ${width}px${asked > width ? ` (at most ${LOOK_MAX_EDGE} px on the long edge; zoom {layer} shows detail)` : ""}`;
    } else if (mode === "sheet") {
      const stretch = input.from != null || input.to != null;
      if (!input.scene && !stretch && document.scenes.length > 1) {
        const entries = [];
        for (const item of document.scenes.slice(0, SHEET_FRAMES)) {
          const time = sec(item.duration * 0.6);
          entries.push({ sceneId: item.id, prepared: await prepare(document, item.id, fonts), time, label: `${refName(item.id, codes)} · ${time}s` });
        }
        image = await look.scenesImage(entries);
        image.frames = image.frames.map((frame, index) => ({ ...frame, scene: entries[index].sceneId, label: entries[index].label }));
        lookKey = "all";
        noteLive({ sceneId: null }, entries.map((entry) => ({ sceneId: entry.sceneId, time: entry.time })));
        text = `sheet: one frame (at 60%) from each of ${plural(entries.length, "scene")}${document.scenes.length > SHEET_FRAMES ? ` (first ${SHEET_FRAMES})` : ""}; look {mode:"sheet", scene} for 12 frames of one`;
      } else {
        // A ten-minute scene's 12 frames are almost a minute apart, so from and to spread them
        // over a stretch of it instead.
        const times = stretch ? sheetStretch(input, scene) : sheetTimes(scene.duration);
        const { from, to } = stretch ? stretchBounds(input, scene) : { from: 0, to: scene.duration };
        noteLive({ sceneId: scene.id, range: [from, to] }, [{ sceneId: scene.id, range: [from, to] }]);
        const prepared = await prepare(document, scene.id, fonts);
        // When the scene's footage cuts, the tiles follow the shots: at least one a shot, and a
        // long shot as many as 12 even frames would give it (sceneShots.js shotTiles).
        const cuts = await shotsOf(prepared.scene);
        const { tiles, total, shown } = shotTiles(cuts.shots, stretch ? stretchBounds(input, scene) : {});
        if (total >= 2) {
          const labels = tiles.map((tile) => `${tile.n} · ${tile.time}s`);
          image = await look.sheetImage(prepared, { times: tiles.map((tile) => tile.time), labels });
          image.frames = image.frames.map((frame, index) => ({ ...frame, label: labels[index] }));
          const groups = [];
          for (const tile of tiles) {
            if (groups.at(-1)?.n === tile.n) groups.at(-1).times.push(tile.time);
            else groups.push({ n: tile.n, start: tile.start, end: tile.end, times: [tile.time] });
          }
          const spans = groups.map((group) => `${group.n} (${sec(group.start)}–${sec(group.end)}s) at ${group.times.join(" ")}s`).join(" · ");
          const rest = total > shown ? `; look {mode:"sheet", from:${sec(groups.at(-1).end)}${input.to != null ? `, to:${input.to}` : ""}} for the rest` : "";
          text = `sheet ${refName(scene.id, codes)}: ${total} shots${total > shown ? ` (the first ${shown} here)` : ""} in ${tiles.length} tiles labeled shot · time: ${spans}${rest}`;
        } else {
          image = await look.sheetImage(prepared, { times });
          const apart = sec(times.length > 1 ? times[1] - times[0] : 0);
          text = `sheet ${refName(scene.id, codes)}: ${times.map((time, index) => `${index + 1}=${time}s`).join(" ")}${!stretch && apart > SHEET_GAP_HINT ? ` (${apart}s apart; look {mode:"sheet", from, to} spreads 12 over a stretch)` : ""}`;
        }
        for (const line of cuts.unknownLines) text += `\n${line}`;
      }
    } else if (mode === "zoom") {
      if (!input.layer) throw new AgentError("bad_input", "zoom needs layer (a name or code).");
      const layerId = resolver.resolve(String(input.layer), "layer");
      const layerScene = document.scenes.find((item) => item.layers.some((layer) => layer.id === layerId));
      const prepared = await prepare(document, layerScene.id, fonts);
      const layer = prepared.scene.layers.find((item) => item.id === layerId) ?? layerScene.layers.find((item) => item.id === layerId);
      const time = clampTime(input.t ?? settledTime(layer, layerScene), layerScene);
      image = await look.zoomImage(prepared, { layer, time });
      lookKey = layerScene.id;
      noteLive({ sceneId: layerScene.id, layerIds: [layerId], time }, [{ sceneId: layerScene.id, layerIds: [layerId] }]);
      // A layer partly off screen (or larger than the scene) is cropped to its part on screen.
      const parent = layer.parentId ? ` inside ${refName(layer.parentId, codes)}` : "";
      const part = image.clipped ? ` (its part on screen; the layer is ${image.layerSize.width}×${image.layerSize.height}${parent})` : "";
      text = `zoom ${refName(layerId, codes)} @${time}s crop ${image.crop.x},${image.crop.y} ${image.crop.width}×${image.crop.height}${part} at ${image.crop.scale}×`;
    } else if (mode === "source") {
      ({ image, text, extra, nextCall = null } = await sourceLook(input, { document, codes, resolver, fonts, state }));
      // A clip by file name, or every clip (no layer), is on no layer.
      let layerId = null;
      if (input.layer) try { layerId = resolver.resolve(String(input.layer), "layer"); } catch { /* a file name */ }
      const layerScene = document.scenes.find((item) => item.layers.some((layer) => layer.id === layerId));
      const layerIds = layerId ? [layerId] : [];
      noteLive({ sceneId: layerScene?.id ?? null, layerIds, time: Number.isFinite(input.t) ? input.t : null }, [{ sceneId: layerScene?.id, layerIds }]);
    } else if (mode === "reference") {
      ({ image = {}, text, extra } = await referenceLook(input, projectId));
    } else if (mode === "board") {
      noteLive({ sceneId: null });
      try { ({ image, text, extra, nextCall } = await boardLook(input, { document, look, fontsFor, mediaRecord, soundFiles: await soundFilesFor(document), soundSearch: soundSearchOn() })); }
      catch (error) {
        if (error instanceof BoardLookError) throw new AgentError(error.code, error.message);
        throw error;
      }
    } else if (mode === "strip") {
      if (!input.anim) throw new AgentError("bad_input", "strip needs anim (an animation name, code, or layer.kind such as cta.in).");
      const animationId = resolver.resolve(String(input.anim), "animation");
      const entry = resolver.objects.animations.find((item) => item.id === animationId);
      const [start, end] = animationSpan(entry.animation, entry.offset);
      // every:true: each output frame of the animation (at most FRAMES_MOST), not 6 spread out.
      const every = input.every === true ? everyFrame(start, Math.min(end, entry.scene.duration)) : null;
      const times = every ? every.times : evenTimes(start, Math.min(end, entry.scene.duration), STRIP_TILES);
      image = await look.sheetImage(await prepare(document, entry.scene.id, fonts), { times, ...(every ? { columns: 6, labels: times.map((time) => `${time.toFixed(2)}s`) } : {}) });
      lookKey = entry.scene.id;
      const span = [start, Math.min(end, entry.scene.duration)];
      noteLive({ sceneId: entry.scene.id, layerIds: entry.layer ? [entry.layer.id] : [], range: span }, [{ sceneId: entry.scene.id, layerIds: entry.layer ? [entry.layer.id] : [], range: span }]);
      text = every ? `strip ${refName(animationId, codes)} ${start}–${end}s: every frame at 30 fps, ${times.length} tiles labeled with their time${every.rest != null ? `; look {mode:"frames", from:${every.rest}, to:${sec(end)}} for the rest` : ""}`
        : `strip ${refName(animationId, codes)} ${start}–${end}s: ${times.map((time, index) => `${index + 1}=${time}s`).join(" ")}`;
    } else if (mode === "frames") {
      // Every output frame (30 fps) of a stretch, 6 to a row (0.2 s), at most FRAMES_MOST.
      const from = input.from ?? input.t;
      if (from == null) throw new AgentError("bad_input", `frames needs from (seconds); to defaults to ${sec((FRAMES_MOST - 1) / 30)} s later.`);
      const { from: start, to: end } = stretchBounds({ from, to: input.to ?? from + (FRAMES_MOST - 1) / 30 }, scene);
      const { times, rest } = everyFrame(start, end);
      const longEdge = Math.round(Math.min(480, Math.max(96, input.width ?? 240)));
      image = await look.sheetImage(await prepare(document, scene.id, fonts), { times, longEdge, columns: 6, labels: times.map((time) => `${time.toFixed(2)}s`) });
      noteLive({ sceneId: scene.id, range: [start, end] }, [{ sceneId: scene.id, range: [start, end] }]);
      text = `frames ${refName(scene.id, codes)} ${sec(times[0])}–${sec(times.at(-1))}s: ${times.length} frames at 30 fps, 6 a row (0.2 s), labeled with their time${rest != null ? `; at most ${FRAMES_MOST} a call: look {mode:"frames", from:${rest}, to:${sec(end)}} for the rest` : ""}`;
    } else if (mode === "sound" || (mode === "motion" && input.ref === "sound")) {
      // The MCP tool list is at its token budget, so the sound map is look {mode:"motion", ref:"sound"} there.
      ({ image, text } = await soundLook({ record, codes, scene, state }));
      noteLive({ sceneId: scene.id });
    } else if (mode === "motion") {
      ({ image, text } = await motionLook(input, { document, codes, fonts, scene }));
      noteLive({ sceneId: scene.id });
    } else if (mode === "compare") {
      if (!Number.isSafeInteger(input.rev)) throw new AgentError("bad_input", "compare needs rev, the earlier revision to compare with.");
      const old = await store.getProjectRevision(projectId, input.rev);
      if (!old) throw new AgentError("not_found", `rev ${input.rev} is no longer kept (the last 50 versions are). history lists what is.`);
      const oldScene = old.scenes.find((item) => item.id === scene.id);
      if (!oldScene) throw new AgentError("not_found", `${refName(scene.id, codes)} did not exist at rev ${input.rev}.`);
      const oldFonts = await fontsFor(old);
      const times = sheetTimes(scene.duration);
      image = await look.compareImage(await prepare(old, scene.id, oldFonts), await prepare(document, scene.id, fonts), { times, beforeLabel: `rev ${input.rev}`, afterLabel: `rev ${record.revision}` });
      // The right side is the current revision: it covers the whole scene.
      noteLive({ sceneId: scene.id, range: [0, scene.duration] }, [{ sceneId: scene.id, range: [0, scene.duration] }]);
      text = image.png ? `compare ${refName(scene.id, codes)} rev ${input.rev} (left) vs rev ${record.revision} (right) at ${image.differing.join("s, ")}s` : `compare: no visible difference between rev ${input.rev} and rev ${record.revision} at ${times.length} times`;
    } else if (mode === "changed") {
      // After a sheet of every scene, changed (with no scene) compares every scene again.
      const looks = state.looks ?? {};
      const all = !input.scene && document.scenes.length > 1 && state.lastLook === "all" && looks.all?.frames?.length;
      let previous = all ? looks.all : looks[scene.id];
      if (!previous?.frames?.length && looks.all?.frames?.some((entry) => entry.scene === scene.id))
        previous = { ...looks.all, frames: looks.all.frames.filter((entry) => entry.scene === scene.id) };
      if (!previous?.frames?.length) throw new AgentError("no_previous_look", `No earlier look at ${refName(scene.id, codes)} to compare with. Use look sheet first.`);
      const preparedScenes = new Map();
      const preparedFor = async (entry) => {
        const id = entry.scene ?? scene.id;
        if (!document.scenes.some((item) => item.id === id)) return null;
        if (!preparedScenes.has(id)) preparedScenes.set(id, await prepare(document, id, fonts));
        return preparedScenes.get(id);
      };
      image = await look.changedImage(preparedFor, previous);
      lookKey = all ? "all" : scene.id;
      const compared = all ? document.scenes : [scene];
      noteLive({ sceneId: all ? null : scene.id, ...(all ? {} : { range: [0, scene.duration] }) }, compared.map((item) => ({ sceneId: item.id, range: [0, item.duration] })));
      const where = all ? "the scenes" : refName(scene.id, codes);
      text = image.png ? `changed since your last look at ${where}: ${image.labels.join(", ")}` : `nothing visible changed in ${where} since your last look (${plural(previous.frames.length, "frame")} compared)`;
    } else if (mode === "variants") {
      // One row per variant (the original first), five moments across each.
      const latest = document.scenes.filter((item) => item.variant).at(-1);
      const found = variantSet(document, scene) ?? (latest ? variantSet(document, latest) : null);
      if (!found) throw new AgentError("not_found", `${refName(scene.id, codes)} has no variants. edit [{op:"variants", scene}] makes some.`);
      const entries = [];
      // Deck variants compare openings: the first 8 s of each.
      const opening = found.members.some((member) => member.variant.vary === "deck");
      for (const member of found.members) {
        const prepared = await prepare(document, member.id, fonts);
        const span = opening ? Math.min(member.duration, 8) : member.duration;
        for (const share of [0.1, 0.3, 0.5, 0.7, 0.92]) {
          const time = sec(span * share);
          entries.push({ sceneId: member.id, prepared, time, label: `${member.variant.label}${member.variant.picked ? " ✓" : ""} · ${time}s` });
        }
      }
      image = await look.scenesImage(entries, { columns: 5 });
      image.frames = image.frames.map((frame, index) => ({ ...frame, scene: entries[index].sceneId, label: entries[index].label }));
      lookKey = "all";
      noteLive({ sceneId: scene.id });
      const members = found.members.map((member) => ({ scene: refName(member.id, codes), id: member.id, label: member.variant.label, ...(member.variant.picked ? { picked: true } : {}) }));
      extra = { set: found.set, members };
      text = `variants ${found.set}: one row each, at 10/30/50/70/92%${opening ? " of the first 8 s" : ""}: ${members.map((member, index) => `${index + 1}. ${member.scene} ${member.label}${member.picked ? " (picked)" : ""}`).join("; ")}. pick_variant {scene} marks the one to keep.`;
    } else throw new AgentError("bad_input", `Unknown look mode "${mode}".`, { didYouMean: closest(mode, ["frame", "frames", "motion", "sound", "sheet", "zoom", "strip", "compare", "changed", "variants", "source", "board", "reference", "review", "versus", "viewer", "critique"]) });

    const images = [];
    if (image.png) {
      const file = await look.save(projectId, mode, image.png);
      images.push({ path: file, mime: "image/png", data: input.inline === false ? undefined : image.png.toString("base64") });
      text += `\nimage ${file}`;
    }
    if (misnamed) text += `\n(${misnamed} read as t: look takes t, in seconds)`;
    const frames = image.frames;
    // compare, source and board are looks beside the scene's own frames: changed never compares them.
    const remember = mode !== "compare" && mode !== "source" && mode !== "board" && mode !== "reference" && mode !== "motion" && mode !== "sound";
    return done(projectId, { text, images, ...(nextCall ? { nextCall } : {}), data: { rev: record.revision, mode, ...(images[0] ? { path: images[0].path } : {}), ...(extra ?? {}) } }, { change(draft) {
      draft.looks ??= {};
      if (remember) draft.lastLook = lookKey;
      if (frames?.length && remember) draft.looks[lookKey] = { mode, frames, rev: record.revision };
    } });
  }

  // ---- the viewer test (viewer.mjs) ---------------------------------------------------------
  // look {mode:"viewer"} makes the packet a fresh agent watches (frames every 0.5 s, 9 to a
  // sheet, and heard.txt); notes intents and notes viewer keep the beats and the reports; a final
  // render waits for a recent pass (refuseWithoutViewer). kino never calls a model itself.

  // What a first-time viewer hears in a scene: each voice's words (its transcript, made when
  // missing) as lines, and each song's stretches, muffled or full. Muted sound is left out.
  // saved:true reads saved transcripts only (never makes one) and also returns the words.
  async function viewerHeard(scene, document, { saved = false } = {}) {
    const words = [];
    const music = [];
    const missing = [];
    const done = new Set();
    const audible = (layer) => Number(layer.volume ?? 1) > 0 || (layer.animations ?? []).some((animation) => animation?.to && "volume" in animation.to);
    for (const layer of scene.layers) {
      if (!["audio", "video"].includes(layer.type) || !layer.src || layer.enabled === false || done.has(layer) || !audible(layer)) continue;
      let pieces;
      try { pieces = speechPieces(scene, layer); } catch { pieces = [layer]; }
      for (const piece of pieces) done.add(piece);
      let file;
      try { file = mediaFileOf(pieces[0]); } catch { continue; }
      if (await isMusicFile(file)) {
        for (const piece of pieces) {
          const range = mediaPlaybackRange(piece, scene.duration);
          if (range) music.push(...musicSections(range, lowpassSampler(piece), 0.1, piece.src));
        }
        continue;
      }
      let transcript;
      try { transcript = saved ? await transcripts.saved?.(file, document, pieces[0]) : await transcripts.get(file, document, pieces[0]); } catch (error) {
        missing.push({ voice: pieces[0].name, why: String(error.message).split("\n")[0].slice(0, 120) });
        continue;
      }
      if (!transcript) continue;
      for (const word of speechWords(scene, pieces, transcript)) if (!word.unclear) words.push({ voice: pieces[0].name, start: word.start, end: word.end, text: word.text });
    }
    return { lines: heardLines(words, captionWindows(scene)), music: music.sort((a, b) => a.start - b.start), missing, ...(saved ? { words } : {}) };
  }

  const intentsCall = () => nextOf("notes", { action: "intents", beats: [{ from: 0, to: 5, intent: "<what the viewer should know or feel after this beat>" }] });

  // Viewer sheets of `source` at `times` (9 to a sheet, each frame labeled with its time).
  async function sheetsOf(source, list) {
    const out = [];
    for (let index = 0; index < list.length; index += VIEWER_PER_SHEET) {
      const chunk = list.slice(index, index + VIEWER_PER_SHEET);
      out.push((await look.sheetImage(source, { times: chunk, longEdge: VIEWER_TILE, labels: chunk.map((time) => `${time.toFixed(1)}s`) })).png);
    }
    return out;
  }

  // A scene's viewer sheets and heard.txt text (no bar).
  async function viewerSheets(document, scene, prepared) {
    const times = viewerTimes(scene.duration);
    // Every sheet's frames in one render first: each video is decoded once, not once a sheet.
    await look.drawAhead?.(prepared, times, { longEdge: VIEWER_TILE });
    const pngs = await sheetsOf(prepared, times);
    return { pngs, heard: heardText({ duration: scene.duration, sheets: pngs.length, ...(await viewerHeard(scene, document)) }) };
  }

  // Whether the viewer gate asks a new packet of this scene now (intents written, no fix due, no
  // bar): look critique then carries the viewer's sheets too, one helper for both.
  async function viewerJoins(document, state, scene, revision) {
    if (barOf(state.verdicts) || !state.story?.intents?.[scene.id]) return false;
    const needed = await viewerNeeded(document, state, revision, [scene]);
    return Boolean(needed && !needed.gap.fix && !needed.gap.spoiler);
  }

  async function viewerLook({ record, codes, fonts, scene, state }) {
    const document = record.document;
    const projectId = document.id;
    const sceneName = refName(scene.id, codes);
    const intents = state.story?.intents?.[scene.id];
    if (!intents) throw Object.assign(new AgentError("intents_needed", `Write what each beat of ${sceneName} should leave the viewer knowing or feeling first (notes {action:"intents", beats:[{from, to, intent}]}), before any viewer watches it.`), { nextCall: intentsCall() });
    noteLive({ sceneId: scene.id, range: [0, scene.duration] }, [{ sceneId: scene.id, range: [0, scene.duration] }]);
    const prepared = await prepare(document, scene.id, fonts);
    const times = viewerTimes(scene.duration);
    const { pngs, heard: ownHeard } = await viewerSheets(document, scene, prepared);
    let heardWords = ownHeard;
    // With a bar: the bar's frames at the same story points as each of this cut's (same density),
    // blind as cut A or B; which one is the bar changes with the revision (position bias).
    const bar = await barCut(state);
    const barSide = bar ? (record.revision % 2 ? "A" : "B") : null;
    if (bar) {
      const spine = styleContext(state.brief?.style ?? null)?.spine ?? [];
      const barTimes = times.map((time) => barTimeAt(time, { duration: scene.duration, barDuration: bar.duration, spine, barSpine: bar.spine }));
      await look.drawAhead?.(bar.prepared, barTimes, { longEdge: VIEWER_TILE });
      const theirs = await sheetsOf(bar.prepared, barTimes);
      const barHeard = heardText({ duration: bar.duration, sheets: theirs.length, ...(await viewerHeard(bar.scene, bar.document)) });
      const ours = pngs.splice(0);
      pngs.push(...(barSide === "A" ? [...theirs, ...ours] : [...ours, ...theirs]));
      heardWords = barSide === "A" ? `Cut A\n${barHeard}\n\nCut B\n${heardWords}` : `Cut A\n${heardWords}\n\nCut B\n${barHeard}`;
    }
    const half = pngs.length / 2;
    const sheetRange = (from, to) => `${String(from).padStart(2, "0")} to ${String(to).padStart(2, "0")}`;
    // Beside the look images (out/<project>), the folder a subagent may read: a packet kept
    // elsewhere was refused to a sandboxed critic, which had to copy it first.
    const folder = path.join(agentDirectory, "out", encodeURIComponent(projectId), `viewer-${scene.id}-r${record.revision}`);
    const packet = await writePacket(folder, pngs, heardWords);
    const prompt = `Read ${packet.heard}, then the sheets ${folder}/sheet-01.jpg to sheet-${String(pngs.length).padStart(2, "0")}.jpg in order.\n${VIEWER_PROTOCOL}${bar ? `\n${viewerBarProtocol(sheetRange(1, half), sheetRange(half + 1, pngs.length))}` : ""}`;
    const heardShown = heardWords.split("\n");
    const idea = ideaLines(styleContext(state.brief?.style));
    const lines = [
      `viewer packet ${sceneName} rev ${record.revision}: ${plural(pngs.length, "sheet")} of ${VIEWER_PER_SHEET} frames (every 0.5 s) and heard.txt in ${folder}`,
      ...(!bar && critiqueAsks(state, document, scene, record.revision) ? ['The critic asks too: look {mode:"critique"} carries these sheets for one subagent to do both; use it instead.'] : []),
      "Start a fresh subagent that never saw the brief, the plan or this chat, and give it only this prompt:",
      "---", prompt, "---",
      `Then match its answer against your ${plural(intents.beats.length, "beat")}' intents (yourself, or a second fresh agent given the intents and the answer), and record both: notes {action:"viewer", rev:${record.revision}, report:"<its whole answer>", matches:[{beat:1, got:"yes"|"partly"|"no", note}], bugs:[{at, what}]}. A bug is a story problem with its time: confusion, a missed beat, a drag, too much to read.`,
      // The idea and signature, for the match only (never in the viewer's packet).
      ...(idea.length ? [`Match it against the idea too (did its "moment you cared most" land on the signature?): ${idea.join(" · ")}`] : []),
      "heard.txt:", ...heardShown.slice(0, 40), ...(heardShown.length > 40 ? [`... ${heardShown.length - 40} more lines in heard.txt`] : []),
    ];
    return done(projectId, { text: lines.join("\n"),
      nextCall: nextOf("notes", { action: "viewer", rev: record.revision, report: "<the fresh viewer's whole answer>", matches: intents.beats.map((_, index) => ({ beat: index + 1, got: "<yes|partly|no>", note: "<what its answer shows>" })), bugs: [] }),
      data: { rev: record.revision, mode: "viewer", folder, sheets: packet.sheets, heard: packet.heard, prompt } },
    { change(draft) {
      draft.story ??= {};
      const kept = (draft.story.packets ?? []).filter((entry) => !(entry.rev === record.revision && entry.sceneId === scene.id));
      draft.story.packets = [...kept, { rev: record.revision, sceneId: scene.id, at: now(), ...(barSide ? { barSide } : {}) }].slice(-6);
    } });
  }

  // notes {action:"intents", scene?, beats:[{from, to, intent}]}: what each beat should leave the
  // viewer knowing or feeling, written before any viewer report.
  async function notesIntents(record, input, codes) {
    const state = await agentState.read(record.document.id);
    const scene = sceneFor(record.document, codes, input.scene, state.focus);
    let beats;
    try { beats = parseIntents(input.beats, scene.duration); } catch (error) { throw Object.assign(new AgentError("bad_input", error.message), { nextCall: intentsCall() }); }
    const sceneField = record.document.scenes.length > 1 ? { scene: refName(scene.id, codes) } : {};
    return done(record.document.id, { text: `intents saved for ${refName(scene.id, codes)}: ${beats.map((beat, index) => `${index + 1}. ${beat.from}-${beat.to}s`).join(" · ")}. look {mode:"viewer"} makes the packet a fresh viewer watches.`,
      nextCall: nextOf("look", { mode: "viewer", ...sceneField }), data: { beats } },
    { change(draft) {
      draft.story ??= {};
      draft.story.intents = { ...(draft.story.intents ?? {}), [scene.id]: { beats, rev: record.revision, at: now() } };
    } });
  }

  // notes {action:"viewer", rev, report, matches, bugs}: a fresh viewer's report on a packet of
  // rev, matched against the intents saved before that packet.
  async function notesViewer(record, input, codes) {
    const state = await agentState.read(record.document.id);
    const scene = sceneFor(record.document, codes, input.scene, state.focus);
    const report = viewerReport(state, scene, refName(scene.id, codes), input);
    const nextCall = report.bugs.length || report.warns.length ? STATUS_CALL : nextOf("render", { action: "start", quality: "final", wait: true });
    return done(record.document.id, { text: report.text, nextCall, data: report.data }, { change: report.change });
  }

  // A viewer's report on the rev `input.rev` packet (look viewer, or look critique carrying it),
  // matched against the intents saved before it: {entry, bugs, warns, text, data, change}.
  // `again` names the next packet's look mode.
  function viewerReport(state, scene, sceneName, input, again = "viewer") {
    const intents = state.story?.intents?.[scene.id];
    if (!intents) throw Object.assign(new AgentError("intents_needed", `${sceneName} has no intents: write them before any viewer watches (notes {action:"intents", beats}).`), { nextCall: intentsCall() });
    const rev = Number(input.rev);
    const packet = (state.story?.packets ?? []).find((entry) => entry.rev === rev && entry.sceneId === scene.id);
    if (!packet) throw Object.assign(new AgentError("bad_input", `There is no viewer packet of ${sceneName} at rev ${input.rev ?? "?"}: rev is the revision look {mode:"viewer"} made the packet of.`), { nextCall: nextOf("look", { mode: "viewer" }) });
    if (intents.at > packet.at) throw Object.assign(new AgentError("bad_input", `The intents changed after the rev ${rev} packet was made: make a new packet (look {mode:"${again}"}) and give it to a new fresh viewer.`), { nextCall: nextOf("look", { mode: again }) });
    let parsed;
    try { parsed = parseViewer(input, intents.beats, scene.duration, { bar: Boolean(packet.barSide) }); } catch (error) { throw new AgentError("bad_input", error.message); }
    if (parsed.prefer) parsed.prefer.bar = parsed.prefer.cut === packet.barSide;
    const entry = { rev, sceneId: scene.id, ...parsed, at: now() };
    const all = openStoryBugs(entry, intents.beats);
    const bugs = all.filter((bug) => !bug.warn);
    // The keep-watching dips and long drags: open story bugs at warning level (no render hold).
    const warns = all.filter((bug) => bug.warn);
    const miss = directionMiss(entry, signatureRanges(state.brief?.style));
    const count = (got) => parsed.matches.filter((match) => match.got === got).length;
    const scores = parsed.scores ? ` · keep ${parsed.scores.start}/${parsed.scores.middle}/${parsed.scores.end}` : "";
    const head = `viewer report saved for ${sceneName} rev ${rev}: beats yes ${count("yes")} · partly ${count("partly")} · no ${count("no")}${scores}`;
    const warnText = [...warns.map((bug) => `  warn @${bug.at}s ${bug.what}`), ...(miss ? [`  ${miss}`] : [])];
    const later = warnText.length ? `\nStory warnings (fix before the final render; they hold nothing):\n${warnText.join("\n")}` : "";
    const round = viewerRounds({ viewers: [...(state.story?.viewers ?? []), entry] }, scene.id);
    const after = round >= VIEWER_ROUNDS
      ? `Fix them (${SHOW_FIRST}); this was viewer round ${round} of ${VIEWER_ROUNDS}, so no new viewer is asked for: after an edit for them a final render no longer waits on them (a cut changed over ${VIEWER_RECENT} revisions is watched again).`
      : `Fix them (${SHOW_FIRST}), then one new packet (look {mode:"${again}"}, round ${round + 1} of ${VIEWER_ROUNDS}) for a new fresh viewer; a final render waits until then.`;
    const text = bugs.length
      ? `${head}; ${plural(bugs.length, "open story bug")}:\n${bugs.map((bug) => `  @${bug.at}s ${bug.what}`).join("\n")}\n${after}${later}`
      : `${head}; no open story bugs.${later || " A final render may go ahead."}`;
    return { entry, bugs, warns, text, data: { rev, bugs, ...(warns.length ? { warnings: warns } : {}), ...(miss ? { miss } : {}) },
      change(draft) {
        draft.story ??= {};
        draft.story.viewers = [...(draft.story.viewers ?? []), entry].slice(-10);
      } };
  }

  // Whether a scene tells something a viewer test can check: footage, or a voice with words.
  async function hasFootageOrSpeech(scene, document) {
    for (const layer of scene.layers) {
      if (!layer.src || layer.enabled === false) continue;
      if (layer.type === "video") return true;
      if (layer.type !== "audio") continue;
      let file;
      try { file = mediaFileOf(layer); } catch { continue; }
      if (await isMusicFile(file)) continue;
      const transcript = transcripts.saved ? await transcripts.saved(file, document, layer).catch(() => null) : null;
      if ((transcript?.words?.length ?? 0) >= 3) return true;
    }
    return false;
  }

  // The first scene a final render would hold for a viewer pass: {scene, gap} or null. Short
  // scenes, scenes without footage or speech, cut-short renders and waived scenes go ahead.
  async function viewerNeeded(document, state, revision, scenes, options = {}) {
    const waivers = document.checkWaivers ?? [];
    for (const scene of scenes) {
      if (scene.duration < VIEWER_UNDER) continue;
      if (Number.isFinite(options?.duration) && options.duration < scene.duration - 0.01) continue;
      if (waivers.some((waiver) => waiver.code === VIEWER_WAIVER && (waiver.target === "*" || waiver.target === scene.id))) continue;
      if (!(await hasFootageOrSpeech(scene, document))) continue;
      // A caption before the last beat that names what the ending reveals is a story bug too,
      // unless the voice says those words then (a speech caption) or it is waived.
      const spoilers = await spoilersOf(scene, document, state, waivers);
      if (spoilers.length) return { scene, gap: { why: `the caption "${spoilers[0].text.slice(0, 60)}" at ${spoilers[0].start} s gives away the ending (${spoilers[0].words.slice(0, 3).join(", ")}) before its last beat`, bugs: spoilers.map((spoiler) => ({ at: spoiler.start, layer: spoiler.id, what: `caption spoils the ending (${spoiler.words.join(", ")}): show it instead, or say less` })), spoiler: true }, intents: true };
      const gap = viewerGap(state.story, scene.id, revision);
      if (gap) return { scene, gap, intents: Boolean(state.story?.intents?.[scene.id]) };
    }
    return null;
  }

  // Captions that spoil the ending (viewer.mjs captionSpoilers), with saved transcripts read only
  // when one is flagged. A scene or caption waived with code "spoiler" is skipped.
  async function spoilersOf(scene, document, state, waivers) {
    const skip = waivers.filter((waiver) => waiver.code === SPOILER_WAIVER).map((waiver) => waiver.target);
    if (skip.includes("*") || skip.includes(scene.id)) return [];
    const beats = state.story?.intents?.[scene.id]?.beats;
    if (!captionSpoilers(scene, beats, { waived: skip }).length) return [];
    const { words } = await viewerHeard(scene, document, { saved: true });
    return captionSpoilers(scene, beats, { heard: words, waived: skip });
  }

  // The viewer gate: a final render of a video 15 s or longer with footage or speech waits for a
  // fresh viewer's report on a recent revision with no open story bugs. Calls the person made or
  // allowed in the app go ahead, like the review gate.
  async function refuseWithoutViewer(record, scenes, { codes, format, options }) {
    const meta = caller.getStore() ?? {};
    if (meta.reviewed || meta.approved || meta.by === "you" || format === "png") return;
    const state = await agentState.read(record.document.id);
    const needed = await viewerNeeded(record.document, state, record.revision, scenes, options);
    if (!needed) return;
    const name = refName(needed.scene.id, codes);
    const sceneField = record.document.scenes.length > 1 ? { scene: name } : {};
    const skip = `A deliberate skip: edit waive_check {code:"viewer", target:"${name}", reason}. A draft render is allowed now.`;
    if (needed.gap.spoiler) {
      const caption = refName(needed.gap.bugs[0].layer, codes);
      throw Object.assign(new AgentError("viewer_needed", `${name}: ${needed.gap.why}. Fix the caption (show it, or leave out the ending's words); the check runs again on the next render.`, { next: `edit ${caption} at ${needed.gap.bugs[0].at} s. A false hit: edit waive_check {code:"spoiler", target:"${caption}", reason}.` }),
        { nextCall: viewerFixCall(needed.gap) });
    }
    if (needed.gap.fix) throw Object.assign(new AgentError("viewer_needed", `${name}: ${needed.gap.why}. Fix them first; ${needed.gap.last ? `that was viewer round ${VIEWER_ROUNDS}, so after the edit nothing waits on them` : "a new viewer watches the changed cut"}.`, { next: `edit the cut at those times${needed.gap.last ? "" : ', then look {mode:"viewer"}'}. ${skip}` }),
      { nextCall: viewerFixCall(needed.gap) });
    // The critic asks too: look critique carries the viewer's sheets, one subagent for both.
    const joined = needed.intents && !barOf(state.verdicts) && critiqueAsks(state, record.document, needed.scene, record.revision);
    const asks = joined ? 'look {mode:"critique"} (it carries the viewer\'s sheets too)' : 'look {mode:"viewer"}';
    throw Object.assign(new AgentError("viewer_needed", `${name}: ${needed.gap.why}. A final render needs a fresh viewer's report (${asks}, then notes {action:"${joined ? "critique" : "viewer"}"}) with no open story bugs.`, {
      next: `${needed.intents ? "" : "notes intents first, then "}${asks} and give its prompt to one fresh subagent. ${skip}`,
    }), { nextCall: !needed.intents ? intentsCall() : joined ? critiqueCall(sceneField) : nextOf("look", { mode: "viewer", ...sceneField }) });
  }

  // The fix a viewer's open story bug asks for, before another viewer watches.
  function viewerFixCall(gap) {
    const bug = gap.bugs[0];
    return nextOf("edit", { ops: [`<${gap.spoiler ? "show it, or leave the ending's words out of the caption" : "show it, a caption last"}: @${bug.at}s ${String(bug.what).slice(0, 140)}>`] });
  }

  // ---- the fresh-eyes critic (critique.mjs) -------------------------------------------------
  // look {mode:"critique"} writes the packet a fresh critic reads (packet.txt and the pages);
  // notes {action:"critique", rev, lines} records its P0/P1/P2 lines; a final render waits while
  // the latest round has a P0 (refuseOpenCritique). kino never calls a model itself.
  const CRITIQUE_FRAMES = 9; // frames on a page, like a viewer sheet
  const CRITIQUE_SEAMS = 4; // cuts on a seam page
  const critiqueWaived = (document, sceneId) => (document.checkWaivers ?? []).some((waiver) => waiver.code === CRITIQUE_WAIVER && (waiver.target === "*" || waiver.target === sceneId));
  const critiqueCall = (fields = {}) => nextOf("look", { mode: "critique", ...fields });
  // After the last critic round the open lines go to the person: the critique stop (stops.mjs).
  const critiqueStopCall = () => nextOf("notes", { action: "checkpoint", id: "critique" });

  // A scene's open P0 lines as they stand now, or null: none, waived, or answered by the person
  // at the critique stop (kept, or a fix they asked for that an edit since has made).
  function critiqueStanding(state, document, sceneId, revision) {
    if (critiqueWaived(document, sceneId)) return null;
    const open = openCritique(critiqueOf(state, sceneId));
    const call = personCall(state, sceneId, open);
    if (!open || (call && (!call.fix || revision > call.rev))) return null;
    return { ...open, call };
  }

  // Whether the critic gate asks a new packet of this scene now: a real edit's first round, or a
  // re-read of P0s an edit since has fixed (rounds left, no person's call).
  function critiqueAsks(state, document, scene, revision) {
    if (critiqueWaived(document, scene.id)) return false;
    const open = critiqueStanding(state, document, scene.id, revision);
    if (open) return !open.call && open.rounds < CRITIQUE_ROUNDS && open.rev < revision;
    return critiqueWanted(scene, critiqueOf(state, scene.id)) && realEdit(state, videoFacts(document));
  }

  // What notes checkpoint {id:"critique"} asks: the first scene whose last critic round left P0
  // lines the person has not answered ({sceneId, scene, rev, lines}), or null.
  async function critiqueToAsk(record) {
    const state = await agentState.read(record.document.id);
    const codes = await syncCodes(record.document.id, record.document);
    for (const scene of record.document.scenes) {
      const open = critiqueStanding(state, record.document, scene.id, record.revision);
      if (open && !open.call && open.rounds >= CRITIQUE_ROUNDS) return { sceneId: scene.id, scene: refName(scene.id, codes), rev: open.rev, lines: open.lines.map(lineText), ideas: critiqueIdeas(state, scene.id) };
    }
    // Then a critic's P0 that would delete or shrink a designed moment: the person's call.
    for (const scene of record.document.scenes) {
      if (critiqueWaived(record.document, scene.id)) continue;
      const asks = critiqueQuestions(critiqueOf(state, scene.id));
      if (asks && !personCall(state, scene.id, asks)) return { sceneId: scene.id, scene: refName(scene.id, codes), rev: asks.rev, lines: asks.lines.map(lineText), question: true, ideas: critiqueIdeas(state, scene.id) };
    }
    return null;
  }

  // The latest round's UP lines (ideas that would raise the edit), as text for the critique stop.
  function critiqueIdeas(state, sceneId) {
    const record = critiqueOf(state, sceneId);
    return upLines((record.last ?? record.rounds.at(-1))?.lines ?? []).map(lineText);
  }

  // A page of a packet look {mode:"critique"} already wrote (same rev and stretch), or null.
  async function savedCritiquePage(folder, page) {
    const names = await readdir(folder).catch(() => []);
    // heard.txt: a viewer-carrying packet whose packet.txt is still held back.
    if (!names.includes("packet.txt") && !names.includes("heard.txt")) return null;
    const sheets = names.filter((name) => /^sheet-\d+\.jpg$/.test(name)).sort();
    if (!sheets.length) return null;
    const number = Math.min(Math.max(1, page), sheets.length);
    const file = path.join(folder, sheets[number - 1]);
    return { number, file, count: sheets.length, data: await readFile(file) };
  }

  // A critique packet's folder (whole scene unless a stretch).
  const critiqueFolder = (projectId, sceneId, rev, stretch = "") => path.join(agentDirectory, "out", encodeURIComponent(projectId), `critique-${sceneId}-r${rev}${stretch}`);
  // Where a viewer-carrying packet keeps packet.txt (the brief) until the helper's viewer part is
  // in viewer.txt: outside the folder, so that part is written before the brief can be read.
  const heldPacket = (folder) => path.join(agentDirectory, "held", `${encodeURIComponent(path.relative(path.join(agentDirectory, "out"), folder))}.txt`);
  const holding = new Map();
  // Moves the held packet.txt into the folder once viewer.txt has words; true when it is there.
  async function releasePacket(folder) {
    const report = await readFile(path.join(folder, "viewer.txt"), "utf8").catch(() => "");
    if (!report.trim()) return false;
    await rename(heldPacket(folder), path.join(folder, "packet.txt")).catch(() => {});
    return access(path.join(folder, "packet.txt")).then(() => true, () => false);
  }
  function holdPacket(folder) {
    clearInterval(holding.get(folder));
    const until = Date.now() + 3 * 3600_000;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      const free = await releasePacket(folder).catch(() => false);
      busy = false;
      if (free || Date.now() > until) { clearInterval(timer); holding.delete(folder); }
    }, 250);
    timer.unref?.();
    holding.set(folder, timer);
  }

  // The direction a critic judges by: the story spine and style bible, else the brief's lines.
  function critiqueDirection(brief) {
    const spec = brief?.style ?? null;
    const context = styleContext(spec);
    // The idea and its signature first: the critic judges the edit against its own idea.
    const lines = [...ideaLines(context)];
    if (context?.spine?.length) {
      lines.push("Story spine (each beat's purpose):");
      for (const beat of context.spine) lines.push(`  ${beat.role} ${beat.from}-${beat.to}s: ${beat.purpose ?? ""}${beat.uses?.length ? ` (uses ${beat.uses.join(", ")})` : ""}`);
    } else {
      lines.push("Brief (no story spine yet):");
      for (const [key, field] of Object.entries(brief?.fields ?? {}).slice(0, 8)) {
        const value = typeof field?.text === "string" ? field.text : typeof field === "string" ? field : null;
        if (value) lines.push(`  ${key}: ${value.slice(0, 200)}`);
      }
      if (lines.length === 1) lines.push("  (no brief saved)");
    }
    if (spec?.fonts) lines.push(`Fonts by role: ${Object.entries(spec.fonts).map(([role, font]) => `${role} ${font?.family ?? "?"}${font?.size ? ` ${font.size}` : ""}`).join(" · ")}`);
    if (spec?.accent?.color) lines.push(`Accent: ${spec.accent.color}${spec.accent.share != null ? ` on at most ${Math.round(spec.accent.share * 100)}% of the frame` : ""}`);
    if (spec?.moves?.length) lines.push(`Named moves: ${spec.moves.map((move) => `${move.tag} (${move.where ?? "anywhere"})`).join(" · ")}`);
    if (context?.wants.length || context?.avoids.length) lines.push(`Style: wants ${context.wants.join(", ") || "-"} · avoids ${context.avoids.join(", ") || "-"}`);
    if (context?.rejected.length) lines.push(`Rejected by the person (must not appear): ${context.rejected.map((text) => `"${text}"`).join(", ")}`);
    return { lines, spine: context?.spine ?? [] };
  }

  async function critiqueLook(input, { record, codes, fonts, scene, state }) {
    const document = record.document;
    const projectId = document.id;
    const sceneName = refName(scene.id, codes);
    const sceneField = document.scenes.length > 1 ? { scene: sceneName } : {};
    const kept = critiqueOf(state, scene.id);
    if (kept.rounds.length >= CRITIQUE_ROUNDS && !kept.rounds.some((round) => round.rev === record.revision)) {
      // Open lines the person already answered (a fix still to make, or kept) are not asked again.
      const open = critiqueStanding(state, document, scene.id, record.revision);
      const ask = open && !open.call;
      throw Object.assign(new AgentError("critique_rounds", `${sceneName} had ${CRITIQUE_ROUNDS} critic rounds; a third is not asked for. ${ask ? `Its open P0 lines go to the person: ${open.lines.slice(0, 3).map(lineText).join(" | ")}` : open ? `The person asked for the fix (${open.call.id}).` : "Nothing it found still blocks."}`, {
        next: ask ? 'Ask the person: notes {action:"checkpoint", id:"critique"}; their answer fixes or keeps the lines.' : open ? "Make the fix they asked for, then render." : "Go on to the final render.",
      }), { nextCall: ask ? critiqueStopCall() : open ? nextOf("edit", { ops: [`<the edit for: ${open.lines[0].change}>`] }) : STATUS_CALL });
    }
    const range = input.from != null || input.to != null ? stretchBounds(input, scene) : { from: 0, to: scene.duration };
    const inRange = (time) => time >= range.from - 1e-6 && time <= range.to + 1e-6;
    const whole = range.from <= 1e-6 && range.to >= scene.duration - 1e-6;
    // Beside the look images, so a sandboxed critic subagent can read it (as the viewer packet).
    const folder = critiqueFolder(projectId, scene.id, record.revision, whole ? "" : `-${sec(range.from)}-${sec(range.to)}`);
    // page:n of a packet made at this rev: the saved page, not every page drawn again.
    const saved = input.page != null && kept.packets.some((packet) => packet.rev === record.revision) ? await savedCritiquePage(folder, input.page) : null;
    if (saved) {
      return done(projectId, { text: `critique packet ${sceneName} rev ${record.revision}: page ${saved.number} of ${saved.count} (saved) in ${folder}\nimage ${saved.file}`,
        images: [{ path: saved.file, mime: "image/jpeg", data: input.inline === false ? undefined : saved.data.toString("base64") }],
        nextCall: nextOf("notes", { action: "critique", rev: record.revision, lines: ["<the critic's lines, as it wrote them>"], ...sceneField }),
        data: { rev: record.revision, mode: "critique", folder, page: saved.number, pages: saved.count } });
    }
    noteLive({ sceneId: scene.id, range: [range.from, range.to] }, [{ sceneId: scene.id, range: [range.from, range.to] }]);
    const direction = critiqueDirection(state.brief);
    const notesOpen = (state.notes ?? []).filter((note) => note.status !== "resolved").slice(-12);
    const { findings } = await findingsFor(document, { fonts, codes, sceneId: scene.id, pixels: false });
    const briefTier = findings.filter((finding) => !finding.waived && (finding.severity === "error" || BRIEF_RULES.has(finding.rule)));
    const { listed } = triageFindings(briefTier.filter((finding) => finding.at == null || inRange(finding.at)), 12);
    const { text: trace } = await motionLook(range, { document, codes, fonts, scene });
    // The pages: seams across each cut (footage cuts and full-frame plate changes), then the
    // frames around each finding and each beat boundary.
    const prepared = await prepare(document, scene.id, fonts);
    const footageCuts = (await shotsOf(prepared.scene)).shots.slice(1).map((shot) => shot.start);
    const cutTimes = [];
    for (const time of [...footageCuts, ...(await reviewPlateCuts(document, scene.id, fonts, record.revision))].sort((a, b) => a - b))
      if (inRange(time) && !cutTimes.some((other) => Math.abs(other - time) <= SEAM_MERGE + 1e-6)) cutTimes.push(sec(time));
    const seams = cutTimes.slice(0, 24).map((time, index) => ({ n: index + 1, time }));
    const moments = critiqueTimes({ findings: listed, spine: direction.spine, duration: scene.duration }).filter((entry) => inRange(entry.time)).slice(0, 36);
    // When the viewer gate asks too, its sheets (a frame every 0.5 s) and heard.txt come first, for
    // the same helper; the moments are then frames on those sheets, not pages of their own.
    const viewer = whole && await viewerJoins(document, state, scene, record.revision) ? await viewerSheets(document, scene, prepared) : null;
    const intents = viewer ? state.story.intents[scene.id] : null;
    const first = viewer ? viewer.pngs.length : 0;
    const sheetName = (number) => `sheet-${String(number).padStart(2, "0")}.jpg`;
    const viewerTimeList = viewer ? viewerTimes(scene.duration) : [];
    // Where a moment is on the viewer sheets: the nearest frame ("sheet 3 frame 5").
    const viewerFrame = (time) => {
      const index = viewerTimeList.reduce((best, at, n) => (Math.abs(at - time) < Math.abs(viewerTimeList[best] - time) ? n : best), 0);
      return `sheet ${Math.floor(index / VIEWER_PER_SHEET) + 1} frame ${(index % VIEWER_PER_SHEET) + 1}`;
    };
    // The seam rows' frames in one render, then the moments' (another size): each video is
    // decoded once for all the pages, not once a page.
    await look.drawAhead?.(prepared, seams, { seams: true });
    if (!viewer) await look.drawAhead?.(prepared, moments.map((entry) => entry.time), { longEdge: VIEWER_TILE });
    const pages = [];
    for (let index = 0; index < seams.length; index += CRITIQUE_SEAMS) {
      const chunk = seams.slice(index, index + CRITIQUE_SEAMS);
      pages.push({ png: (await look.seamImage(prepared, chunk)).png, about: `seams, a row a cut, frames at ${SEAM_OFFSETS.join(" ")} s across it: cut ${chunk.map((seam) => `${seam.n} @${seam.time}s`).join(", ")}`,
        ask: "After each cut, does the eye know where to look? Does the brightness hold across it (no accidental flash or dip; a planned flash on a hit is fine)? Does anything pop, jump or vanish?" });
    }
    for (let index = 0; !viewer && index < moments.length; index += CRITIQUE_FRAMES) {
      const chunk = moments.slice(index, index + CRITIQUE_FRAMES);
      const beats = direction.spine.filter((beat) => chunk.some((entry) => entry.time >= beat.from - 0.3 && entry.time <= beat.to + 0.3));
      pages.push({ png: (await look.sheetImage(prepared, { times: chunk.map((entry) => entry.time), longEdge: VIEWER_TILE, labels: chunk.map((entry) => `${entry.time}s ${entry.why}`.slice(0, 44)) })).png,
        about: `frames: ${chunk.map((entry) => `${entry.time}s (${entry.why})`).join(", ")}`,
        ask: `Does any element hang at the frame edge? Can every text be read? Does each beat do its purpose${beats.length ? ` (${beats.map((beat) => `${beat.role}: ${beat.purpose ?? "?"}`).join("; ")})` : ""}?` });
    }
    if (!pages.length && !viewer) pages.push({ png: (await look.sheetImage(prepared, { times: evenTimes(range.from, range.to, CRITIQUE_FRAMES), longEdge: VIEWER_TILE })).png, about: "frames spread over the stretch", ask: "Does the eye know where to look? Can every text be read?" });
    // The bar first (bar.mjs): this cut and the person's best earlier cut at the same story points.
    const bar = whole ? await barCut(state) : null;
    if (bar) {
      const { pairs, ours, theirs } = await barPages(prepared, scene, direction.spine, bar);
      pages.unshift({ png: ours, about: `THIS CUT at the story points: ${pairs.map((pair) => `${pair.why} ${pair.at}s`).join(", ")}`, ask: "Compare it with the next page, frame by frame." },
        { png: theirs, about: `THE BAR (${bar.name} rev ${bar.verdict.rev}, ${sec(bar.duration)} s) at the same points: ${pairs.map((pair) => `${pair.barAt}s`).join(", ")}`, ask: "Which cut is better at each point, and why, specifically (captions, cut timing, devices, title and end card)?" });
    }
    const packet = [
      `Video ${sceneName}, ${sec(scene.duration)} s, ${scene.width}x${scene.height}; this packet covers ${sec(range.from)}-${sec(range.to)}s at rev ${record.revision} (critic round ${Math.min(kept.rounds.length + 1, CRITIQUE_ROUNDS)} of ${CRITIQUE_ROUNDS}).`,
      ...direction.lines,
      ...anchorLines(state.verdicts),
      notesOpen.length ? "The person's open notes:" : "The person's open notes: none",
      ...notesOpen.map((note) => `  ${note.time != null ? `@${note.time}s ` : ""}"${note.text.slice(0, 200)}"`),
      listed.length ? "Gates and findings about the brief (kino's checks):" : "Gates and findings about the brief: none open",
      ...listed.map((finding) => `  ${finding.at != null ? `t=${finding.at}` : "whole"} ${finding.severity === "error" ? "GATE" : "brief"} ${finding.rule} ${finding.ref}: ${String(finding.message ?? "").slice(0, 160)}`),
      "Pages (read in order; answer each page's questions):",
      ...pages.map((page, index) => `  page ${first + index + 1} = ${sheetName(first + index + 1)}: ${page.about}\n    ${page.ask}`),
      ...(viewer && moments.length ? [`Moments, on the viewer sheets (${sheetName(1)} to ${sheetName(first)}): ${moments.map((entry) => `${entry.time}s (${entry.why}) ${viewerFrame(entry.time)}`).join(", ")}`,
        `    Does any element hang at the frame edge? Can every text be read? Does each beat do its purpose${direction.spine.length ? ` (${direction.spine.map((beat) => `${beat.role}: ${beat.purpose ?? "?"}`).join("; ")})` : ""}?`] : []),
      "Motion trace (from the model, 0.5 s a line):",
      trace,
    ].join("\n");
    const all = [...(viewer?.pngs ?? []), ...pages.map((page) => page.png)];
    const written = await writePacket(folder, all, packet, "packet.txt");
    const heardFile = viewer ? path.join(folder, "heard.txt") : null;
    if (viewer) {
      await writeFile(heardFile, `${viewer.heard}\n`, { mode: 0o600 });
      // packet.txt waits outside until the helper writes viewer.txt (holdPacket).
      await mkdir(path.dirname(heldPacket(folder)), { recursive: true, mode: 0o700 });
      await rename(written.heard, heldPacket(folder));
      holdPacket(folder);
    }
    // The first critic page is shown (a viewer sheet when there is none).
    const pageNumber = Math.min(Math.max(1, input.page ?? (pages.length ? first + 1 : 1)), all.length);
    const file = await look.save(projectId, "critique", all[pageNumber - 1]);
    const images = [{ path: file, mime: "image/png", data: input.inline === false ? undefined : all[pageNumber - 1].toString("base64") }];
    const critic = `${bar ? `${BAR_PROTOCOL}\n` : ""}${CRITIQUE_PROTOCOL}`;
    const viewerFile = path.join(folder, "viewer.txt");
    const prompt = viewer
      ? `Two parts. Part 1, the viewer: read ${heardFile}, then ${folder}/${sheetName(1)} to ${sheetName(first)}.\n${VIEWER_PROTOCOL}\nWrite that report, whole, to ${viewerFile}. Only then does packet.txt appear beside it (if not yet, wait a second).\nPart 2, the critic: read ${written.heard}${pages.length ? `, then ${sheetName(first + 1)} to ${sheetName(all.length)}` : ""}.\n${critic}\nYour answer is part 2's lines only. If you cannot write files, answer with part 1 only.`
      : `Read ${written.heard}, then ${folder}/sheet-01.jpg to ${sheetName(all.length)} in order.\n${critic}`;
    const shown = packet.split("\n");
    const idea = viewer ? ideaLines(styleContext(state.brief?.style)) : [];
    const record_ = viewer
      ? [`Then read ${viewerFile} (its part 1) and record both in one call: notes {action:"critique", rev:${record.revision}, lines:[its answer], matches:[{beat, got:"yes"|"partly"|"no", note}], bugs:[{at, what}]}; kino takes the report from viewer.txt. Match it against your ${plural(intents.beats.length, "beat")}' intents yourself. A P0 or a story bug asks for round 2. Answered part 1 only: notes {action:"critique", rev:${record.revision}, report:"<its answer>"}.`,
        ...(idea.length ? [`Match it against the idea too (did its "moment you cared most" land on the signature?): ${idea.join(" · ")}`] : [])]
      : [`Then record its lines as they came: notes {action:"critique", rev:${record.revision}, lines:["P0 t=..."]}. A P0 blocks a final render until a newer rev's round has none.`];
    const lines = [
      `critique packet ${sceneName} rev ${record.revision}: ${viewer ? `the viewer's ${plural(first, "sheet")} and heard.txt, then ` : ""}${plural(pages.length, "page")} (${plural(seams.length, "seam")}, ${plural(moments.length, "moment")}) and packet.txt in ${folder}; page ${pageNumber} shown${all.length > 1 ? `, look {mode:"critique", page} for others` : ""}`,
      "Start one fresh subagent that never saw this chat; give it only this prompt:", "---", prompt, "---",
      ...record_,
      "packet.txt:", ...shown.slice(0, 40), ...(shown.length > 40 ? [`... ${shown.length - 40} more lines in packet.txt`] : []),
      `image ${file}`,
    ];
    const viewerFields = viewer ? { matches: intents.beats.map((_, index) => ({ beat: index + 1, got: "<yes|partly|no>", note: "<what its answer shows>" })), bugs: [] } : {};
    return done(projectId, { text: lines.join("\n"), images,
      nextCall: nextOf("notes", { action: "critique", rev: record.revision, lines: ["<the critic's lines, as it wrote them>"], ...viewerFields, ...sceneField }),
      data: { rev: record.revision, mode: "critique", folder, packet: written.heard, pages: written.sheets, page: pageNumber, seams: seams.length, moments: moments.length, prompt, ...(viewer ? { viewer: { sheets: first, heard: heardFile } } : {}) } },
    { change(draft) {
      draft.critique ??= {};
      const entry = draft.critique[scene.id] ?? { packets: [], rounds: [] };
      entry.packets = [...entry.packets.filter((item) => item.rev !== record.revision), { rev: record.revision, at: now(), ...(bar ? { bar: true } : {}), ...(viewer ? { viewer: true, sheets: all.length } : {}) }].slice(-4);
      draft.critique[scene.id] = entry;
      if (!viewer) return;
      // The viewer's packet too, so notes viewer accepts this rev as well.
      draft.story ??= {};
      const kept = (draft.story.packets ?? []).filter((item) => !(item.rev === record.revision && item.sceneId === scene.id));
      draft.story.packets = [...kept, { rev: record.revision, sceneId: scene.id, at: now(), critique: true }].slice(-6);
    } });
  }

  // notes {action:"critique", rev, lines}: a fresh critic's lines on the rev-`rev` packet.
  async function notesCritique(record, input, codes) {
    const state = await agentState.read(record.document.id);
    const scene = sceneFor(record.document, codes, input.scene, state.focus);
    const sceneName = refName(scene.id, codes);
    const sceneField = record.document.scenes.length > 1 ? { scene: sceneName } : {};
    const kept = critiqueOf(state, scene.id);
    const rev = Number(input.rev);
    if (!kept.packets.some((packet) => packet.rev === rev))
      throw Object.assign(new AgentError("bad_input", `There is no critique packet of ${sceneName} at rev ${input.rev ?? "?"}: rev is the revision look {mode:"critique"} made the packet of.`), { nextCall: critiqueCall(sceneField) });
    const last = kept.last ?? kept.rounds.at(-1);
    if (last && last.rev >= rev && last.lines.some(blocksRender))
      throw Object.assign(new AgentError("bad_input", `rev ${last.rev}'s critic found P0 lines: fix them, then a new packet (look {mode:"critique"}) for a fresh critic to re-read.`), { nextCall: critiqueCall(sceneField) });
    const rounds = kept.rounds.filter((round) => round.rev !== rev);
    if (rounds.length >= CRITIQUE_ROUNDS) throw Object.assign(new AgentError("critique_rounds", `${sceneName} already had ${CRITIQUE_ROUNDS} critic rounds: the rest goes to the person.`), { nextCall: critiqueStopCall() });
    // A packet that carried the viewer's sheets: the helper's viewer part is in viewer.txt.
    const packetEntry = kept.packets.find((packet) => packet.rev === rev);
    const carried = packetEntry?.viewer && !(state.story?.viewers ?? []).some((entry) => entry.rev === rev && entry.sceneId === scene.id);
    const folder = critiqueFolder(record.document.id, scene.id, rev);
    if (carried && input.report != null && input.lines == null) {
      // A helper that could not write files answered part 1 only: save it, free packet.txt.
      await writeFile(path.join(folder, "viewer.txt"), `${String(input.report).trim()}\n`, { mode: 0o600 });
      if (!await releasePacket(folder)) throw new AgentError("bad_input", `The rev ${rev} packet is gone: make a new one (look {mode:"critique"}).`);
      const prompt = `Read ${path.join(folder, "packet.txt")}, then ${folder}/sheet-01.jpg to sheet-${String(packetEntry.sheets ?? 1).padStart(2, "0")}.jpg in order.\n${CRITIQUE_PROTOCOL}`;
      return done(record.document.id, { text: `viewer part saved for ${sceneName} rev ${rev}; packet.txt is ready. Start one fresh subagent that never saw this chat; give it only this prompt:\n---\n${prompt}\n---\nThen record: notes {action:"critique", rev:${rev}, lines:[its answer], matches, bugs}.`,
        nextCall: nextOf("notes", { action: "critique", rev, lines: ["<the critic's lines, as it wrote them>"], matches: [{ beat: 1, got: "<yes|partly|no>", note: "<what it shows>" }], bugs: [], ...sceneField }), data: { rev, prompt } });
    }
    const fileReport = carried ? (await readFile(path.join(folder, "viewer.txt"), "utf8").catch(() => "")).trim() : "";
    let parsed;
    const moves = (Array.isArray(state.brief?.style?.moves) ? state.brief.style.moves : []).map((move) => move?.tag).filter(Boolean);
    const signatures = signatureRanges(state.brief?.style);
    try { parsed = parseCritique(input.lines, scene.duration, { moves, signatures }); } catch (error) { throw new AgentError("bad_input", error.message); }
    // A packet that showed the bar needs the critic's BAR line (a bar saved later waits at the gate).
    const bar = kept.packets.find((packet) => packet.rev === rev)?.bar ? barOf(state.verdicts) : null;
    if (bar && !parsed.some((line) => line.level === "BAR" || line.bar))
      throw Object.assign(new AgentError("bad_input", `This project has a bar (rev ${bar.rev}): the critic's first line compares with it, "BAR better|worse · <why, specifically>". Ask the critic for that line.`), { nextCall: critiqueCall(sceneField) });
    // A round with no P0 ("none", or only P1/P2 lines) clears the gate, so it must be about the
    // video as it is: not a packet edited past.
    if (!parsed.some(blocksRender) && rev !== record.revision)
      throw Object.assign(new AgentError("bad_input", `The video changed since the rev ${rev} packet (it is rev ${record.revision} now): a round with no P0 says nothing about it. Make a new packet for a fresh critic.`), { nextCall: critiqueCall(sceneField) });
    const round = { rev, lines: parsed, at: now(), direction: critiqueDirectionKey(state.brief), spine: critiqueSpine(state.brief) };
    const count = (level) => parsed.filter((line) => line.level === level).length;
    // A P0 that would delete or shrink a designed moment is a question for the person, not a gate.
    const p0 = parsed.filter(blocksRender);
    // The same answer records the viewer's report: viewer.txt, written before packet.txt was there.
    const report = fileReport || input.report;
    if (carried && report == null)
      throw Object.assign(new AgentError("bad_input", `The rev ${rev} packet carried the viewer's sheets, and ${path.join(folder, "viewer.txt")} is empty: its helper wrote no part 1. Give the packet to a new fresh subagent.`), { nextCall: critiqueCall(sceneField) });
    const viewer = report != null ? viewerReport(state, scene, sceneName, { ...input, report }, p0.length ? "critique" : "viewer") : null;
    const goAhead = viewer?.bugs.length ? "" : "A final render may go ahead.";
    const asks = parsed.filter((line) => line.ask);
    const number = rounds.length + 1;
    const head = `critique round ${number} of ${CRITIQUE_ROUNDS} saved for ${sceneName} rev ${rev}: P0 ${count("P0")} · P1 ${count("P1")} · P2 ${count("P2")}${count("UP") ? ` · UP ${count("UP")}` : ""}`;
    const after = number >= CRITIQUE_ROUNDS
      ? 'That was the last critic round, and a fix alone does not clear it: ask the person, notes {action:"checkpoint", id:"critique"}; their answer fixes or keeps the lines.'
      : "Make each P0's exact change (P1 too when cheap), keeping what it says stays; then look {mode:\"critique\"} for a fresh critic to re-read. A deliberate choice: edit waive_check {code:\"critique\", target, reason}.";
    const listedLines = [...p0, ...parsed.filter((line) => line.level === "P1" && !line.ask).slice(0, 5)].map((line) => `  ${lineText(line)}`);
    const asked = asks.length ? `\n${asks.length} ${asks.length === 1 ? "line would" : "lines would"} cut or flatten a designed moment (a transition, flash, freeze, typed text, set piece, signature, reveal or payoff): not yours to change; ask the person, notes {action:"checkpoint", id:"critique"}:\n${asks.map((line) => `  ${lineText(line)}`).join("\n")}` : "";
    // The elevation pass: suggestions that raise the edit, never a gate. They stay in the round's
    // record (state critique), and the critique stop shows them to the person.
    const ups = upLines(parsed);
    const own = parsed.find((line) => line.level === "OWN");
    const ownText = own ? `\nOnly this product: ${lineText(own)} (make it land harder, never cut it).` : parsed.some((line) => line.generic) ? "" : "\nThe critic did not say which moment only this product could have: ask it for an OWN or GENERIC line next round.";
    const raise = (ups.length ? `\nTo raise it (suggestions, not gates; act on the best one):\n${ups.slice(0, 6).map((line) => `  ${lineText(line)}`).join("\n")}` : `\nNo UP lines: the critic skipped the elevation pass${number < CRITIQUE_ROUNDS ? "; ask it for UP lines next round" : ""}.`) + ownText;
    const text = (p0.length ? `${head}; the P0s block a final render:\n${listedLines.join("\n")}\n${after}` : `${head}; ${asks.length ? "no blocking P0" : "no P0"}. ${listedLines.length ? `Worth fixing:\n${listedLines.join("\n")}\n` : ""}${goAhead}`) + raise + asked + (viewer ? `\n${viewer.text}` : "");
    const nextCall = !p0.length ? (viewer?.bugs.length ? viewerFixCall(viewer) : asks.length ? critiqueStopCall() : nextOf("render", { action: "start", quality: "final", wait: true }))
      : number >= CRITIQUE_ROUNDS ? critiqueStopCall() : nextOf("edit", { ops: [`<the edit for: ${p0[0].change}>`] });
    return done(record.document.id, { text, nextCall, data: { rev, round: number, lines: parsed, ...(viewer ? { viewer: viewer.data } : {}) } },
      { change(draft) {
        draft.critique ??= {};
        const entry = draft.critique[scene.id] ?? { packets: [], rounds: [] };
        entry.rounds = [...entry.rounds.filter((item) => item.rev !== rev), round];
        draft.critique[scene.id] = entry;
        viewer?.change(draft);
      } });
  }

  // notes {action:"verdict", of?, rev, words, wrong?, best?}: the person's verdict on a cut, in
  // their words; best:true makes it the bar the critic and viewer compare against (bar.mjs).
  async function notesVerdict(record, input, meta) {
    const projectId = record.document.id;
    if (input.rev === undefined) {
      const verdicts = (await agentState.read(projectId)).verdicts ?? [];
      const lines = anchorLines(verdicts);
      return done(projectId, { text: lines.length ? lines.join("\n") : 'No verdicts saved: notes {action:"verdict", of, rev, words, wrong?, best?} saves the person\'s words on a cut.', data: { verdicts } });
    }
    let verdict;
    try { verdict = parseVerdict(input, projectId); } catch (error) { throw new AgentError("bad_input", error.message); }
    const of = await store.getProject(verdict.of);
    if (!of) throw new AgentError("unknown_project", `No project "${verdict.of}" to hold that verdict.`);
    if (verdict.best && !(of.revision === verdict.rev || await store.getProjectRevision(of.document.id, verdict.rev)))
      throw new AgentError("not_found", `rev ${verdict.rev} of ${of.document.name} is no longer kept, so it cannot be the bar (history lists what is).`);
    const saved = { ...verdict, of: of.document.id, at: now(), by: meta.by === "you" ? "you" : "agent" };
    const text = `${verdict.best ? "bar" : "verdict"} saved: ${of.document.name} rev ${verdict.rev}: "${verdict.words}". ${verdict.best ? "The critic and the viewer now compare every cut with it; a final render needs the critic's BAR better." : "The critic reads it as an anchor."}`;
    return done(projectId, { text, data: { verdict: saved } }, { change(draft) { draft.verdicts = addVerdict(draft.verdicts, saved); } });
  }

  // The bar's cut, ready to draw ({verdict, name, prepared, duration, spine}), or null.
  async function barCut(state) {
    const verdict = barOf(state?.verdicts);
    if (!verdict) return null;
    const of = await store.getProject(verdict.of);
    const document = of && (of.revision === verdict.rev ? of.document : await store.getProjectRevision(of.document.id, verdict.rev));
    const scene = document?.scenes?.[0];
    if (!scene) return null;
    const context = styleContext((await agentState.read(of.document.id)).brief?.style ?? null);
    return { verdict, name: of.document.name, document, scene, duration: scene.duration, spine: context?.spine ?? [], prepared: await prepare(document, scene.id, await fontsFor(document)) };
  }

  // The bar's comparison pages: this cut and the bar at the same story points (one sheet each).
  async function barPages(prepared, scene, spine, bar) {
    const pairs = barPairs({ duration: scene.duration, barDuration: bar.duration, spine, barSpine: bar.spine });
    const labels = (key) => pairs.map((pair) => `${pair[key]}s ${pair.why}`.slice(0, 44));
    return {
      pairs,
      ours: (await look.sheetImage(prepared, { times: pairs.map((pair) => pair.at), longEdge: VIEWER_TILE, labels: labels("at") })).png,
      theirs: (await look.sheetImage(bar.prepared, { times: pairs.map((pair) => pair.barAt), longEdge: VIEWER_TILE, labels: labels("barAt") })).png,
    };
  }

  // The critic gate: a final render waits while a scene's latest critic round has a P0 line. The
  // person's calls, stills, cut-short renders and a waive_check {code:"critique"} go ahead.
  async function refuseOpenCritique(record, scenes, { codes, format, options }) {
    const meta = caller.getStore() ?? {};
    if (meta.reviewed || meta.approved || meta.by === "you" || format === "png") return;
    const state = await agentState.read(record.document.id);
    for (const scene of scenes) {
      if (Number.isFinite(options?.duration) && options.duration < scene.duration - 0.01) continue;
      if (critiqueWaived(record.document, scene.id)) continue;
      const open = critiqueStanding(state, record.document, scene.id, record.revision);
      // A real edit (realEdit: a brief and past a rough pass) needs one critic round before its
      // final render: skipping the critic must not be easier than heeding it.
      if (!open && critiqueWanted(scene, critiqueOf(state, scene.id)) && realEdit(state, videoFacts(record.document))) {
        const name = refName(scene.id, codes);
        throw Object.assign(new AgentError("critique_needed", `${name} has had no critic round: a fresh critic reads it before the final render.`, {
          next: `look {mode:"critique"${record.document.scenes.length > 1 ? `, scene:"${name}"` : ""}}, give its packet to a fresh subagent (the critique reference), then notes critique; or edit waive_check {code:"critique", target:"${name}", reason}. A draft render is allowed now.`,
        }), { nextCall: critiqueCall(record.document.scenes.length > 1 ? { scene: name } : {}) });
      }
      const below = !open && barGap(critiqueOf(state, scene.id), barOf(state.verdicts));
      if (below) {
        const name = refName(scene.id, codes);
        throw Object.assign(new AgentError("bar_needed", `${name}: ${below.why}.`, {
          next: `look {mode:"critique"} shows it beside the bar for a fresh critic; or edit waive_check {code:"critique", target:"${name}", reason}. A draft render is allowed now.`,
        }), { nextCall: critiqueCall(record.document.scenes.length > 1 ? { scene: name } : {}) });
      }
      if (!open) continue;
      const name = refName(scene.id, codes);
      const last = open.rounds >= CRITIQUE_ROUNDS;
      const next = open.call ? `The person asked for the fix (${open.call.id}): make it, then render.`
        : last ? 'Both critic rounds are used, so a fix alone does not clear them: ask the person, notes {action:"checkpoint", id:"critique"}.'
          : `Make the change: ${open.lines[0].change}; then look {mode:"critique"} for a fresh critic to re-read, or edit waive_check {code:"critique", target:"${name}", reason}.`;
      throw Object.assign(new AgentError("critique_open", `${name}: rev ${open.rev}'s critic found ${plural(open.lines.length, "P0 line")}: ${open.lines.slice(0, 3).map(lineText).join(" | ")}${open.lines.length > 3 ? " | ..." : ""}`, {
        next: `${next} A draft render is allowed now.`,
      }), { nextCall: open.call ? nextOf("edit", { ops: [`<the edit for: ${open.lines[0].change}>`] }) : last ? critiqueStopCall() : critiqueCall(record.document.scenes.length > 1 ? { scene: name } : {}) });
    }
  }

  // ---- needs: what the material cannot give the video (needs.mjs) ---------------------------
  // notes {action:"needs", items:[{what, why, ask, options}]} asks the person about what is
  // missing (items:[] says the material is enough); {id, answer, by:"you", quote} records their
  // answer; {id, status:"made"|"sent", layers|media} marks it done. Only the person answers: on
  // the dashboard, or in the chat recorded with their words. A final render waits while one is
  // unfinished (refuseWithoutNeeds).
  // Drafted from the picked treatment in the agent state (needs.mjs needsCall); placeholders without
  // one. With web search on it offers finding the footage too (footageSearchOn).
  const needsAskCall = (state) => nextOf("notes", needsCall(state?.brief?.treatments, { search: footageSearchOn() }).input);
  const needNextCall = (need) => (need.status === "planned"
    ? nextOf("notes", { action: "needs", id: need.id, status: "made", layers: ["<the layer that does it>"] })
    : need.status === "waiting" ? nextOf("notes", { action: "needs", id: need.id, status: "sent", media: "<its imported src, /api/media/...>" })
    : nextOf("notes", { action: "needs", id: need.id, answer: "<have|option 1|drop|your call|other>", by: "you", quote: "<their words>" }));
  const optionLines = (need) => need.options.map((option, index) => `  option ${index + 1}${option.recommended ? " (recommended)" : ""}: ${option.do} · cost: ${option.cost}`);

  async function notesNeeds(record, input, meta, resolver, codes) {
    const projectId = record.document.id;
    const you = meta.by === "you";
    const at = new Date(now()).toISOString();
    if (input.id === undefined && input.items === undefined) {
      const state = await agentState.read(projectId);
      const needs = state.needs;
      const open = openNeeds(needs);
      const head = !needs?.checked ? "needs: never checked" : open.length ? `${plural(open.length, "need")} not finished` : `needs: the material is enough (rev ${needs.checked.rev})`;
      const lines = open.flatMap((need) => [`${need.id} ${needState(need)}: ${need.ask} (${need.why})`, ...(need.status === "open" ? optionLines(need) : [])]);
      return done(projectId, { text: [head, ...lines].join("\n"), nextCall: !needs?.checked ? needsAskCall(state) : open.length ? needNextCall(open[0]) : null, data: { needs: needs ?? emptyNeeds() } });
    }
    if (input.id === undefined) {
      let items;
      try { items = parseNeedItems(input.items); } catch (error) { throw Object.assign(new AgentError("bad_input", error.message), { nextCall: needsAskCall() }); }
      let added;
      try { added = await agentState.update(projectId, (draft) => addNeeds(draft.needs ??= emptyNeeds(), items, { rev: record.revision, at })); }
      catch (error) { throw new AgentError("bad_input", error.message); }
      const text = added.length
        ? [`needs saved: ${added.map((need) => need.id).join(", ")}. Ask the person each question with its options now (they may not have it); save their answer with by:"you" and quote. A final render waits until each is answered and done.`,
          ...added.flatMap((need) => [`${need.id}: ${need.ask}`, ...optionLines(need)])].join("\n")
        : `material checked at rev ${record.revision}: enough. Ask later if the story shows a gap.`;
      return done(projectId, { text, nextCall: added.length ? needNextCall(added[0]) : null, data: { added } });
    }
    let need;
    try {
      if (input.answer !== undefined) {
        need = await agentState.update(projectId, (draft) => {
          const answered = structuredClone(answerNeed(draft.needs ??= emptyNeeds(), { id: input.id, answer: input.answer, you, by: input.by, quote: input.quote, plan: input.plan, at }));
          if (you) draft.inbox.push({ kind: "need", text: `you answered ${answered.id}: ${answered.status === "waiting" ? "you have it and will send it" : answered.status === "dropped" ? "do without it" : answered.answer.plan ?? `option ${answered.answer.option}, ${answered.options[answered.answer.option - 1].do}`}` });
          return answered;
        });
      } else {
        const refs = [input.layers ?? [], input.layer ?? []].flat().map(String);
        const layers = [];
        for (const ref of refs) { try { layers.push(resolver.resolve(ref, "layer")); } catch { /* reported below when none resolve */ } }
        if (refs.length && !layers.length) throw new AgentError("bad_input", `None of ${refs.join(", ")} is a layer of this project: layers names the layers that use it (names or codes).`);
        let media = null;
        if (input.media != null) {
          try { mediaFileOf({ src: String(input.media) }); media = String(input.media); }
          catch { throw new AgentError("bad_input", `media is the src project {action:"import"} returned (/api/media/...); ${input.media} is not in kino's media library.`); }
        }
        need = await agentState.update(projectId, (draft) => structuredClone(finishNeed(draft.needs ??= emptyNeeds(), { id: input.id, status: input.status, layers, media, at })));
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (error.code === "not_found") throw new AgentError("not_found", error.message);
      throw new AgentError("bad_input", error.message);
    }
    const left = openNeeds((await agentState.read(projectId)).needs);
    const how = need.layers ? ` (${need.layers.map((id) => refName(id, codes)).join(", ")})` : need.media ? ` (${need.media})` : need.status === "open" ? "" : ` · ${needState(need)}`;
    const nextNeed = need.status === "planned" || need.status === "waiting" ? need : left[0];
    return done(projectId, { text: `${need.id} ${need.status}${how}${left.length ? ` · ${plural(left.length, "need")} not finished` : " · all needs done"}`,
      nextCall: nextNeed ? needNextCall(nextNeed) : null, data: { need } });
  }

  // The needs gate: a final render waits while a need is unanswered, a "have" is not sent or a
  // picked option is not made (needs_open), and a whole video of 15 s or more with footage or
  // speech waits until its material was checked (needs_unchecked). The same calls go ahead as at
  // the viewer gate: the person's, stills, cut-short renders and a waive_check {code:"needs"}.
  async function refuseWithoutNeeds(record, scenes, { format, options }) {
    const meta = caller.getStore() ?? {};
    if (meta.reviewed || meta.approved || meta.by === "you" || format === "png") return;
    const whole = scenes.filter((scene) => !(Number.isFinite(options?.duration) && options.duration < scene.duration - 0.01));
    if (!whole.length) return;
    if ((record.document.checkWaivers ?? []).some((waiver) => waiver.code === NEEDS_WAIVER && (waiver.target === "*" || whole.some((scene) => scene.id === waiver.target)))) return;
    const state = await agentState.read(record.document.id);
    const open = openNeeds(state.needs);
    const skip = 'A deliberate skip: edit waive_check {code:"needs", target:"*", reason}. A draft render is allowed now.';
    if (open.length)
      throw Object.assign(new AgentError("needs_open", `Not finished: ${open.map((need) => `${need.id} ${needState(need)} (${need.what})`).join("; ")}.`, {
        next: `Unanswered: ask the person its question and options, then save their answer (answer, by:"you", quote). Waiting: status "sent" with media once they give it. Planned: make the option, then status "made" with layers. ${skip}`,
      }), { nextCall: needNextCall(open[0]) });
    if (state.needs?.checked) return;
    for (const scene of whole) {
      if (scene.duration < VIEWER_UNDER || !(await hasFootageOrSpeech(scene, record.document))) continue;
      throw Object.assign(new AgentError("needs_unchecked", "The material was never checked against the story: look for what it cannot give the video, search it for substitutes, then ask the person (notes needs), or items:[] when it is enough.", { next: `notes {action:"needs", items:[{what, why, ask, options}]}. ${skip}` }), { nextCall: needsAskCall(state) });
    }
  }

  // ---- look versus and the reference gate (judge.mjs) ---------------------------------------
  // Agents overrate their own edits. look {mode:"versus"} puts the edit's frames beside the saved
  // references' stills of the same kind of shot (versus.mjs: the pinned moment, else the same
  // kind, else "no fair match"), with the craft gaps that transfer (hero fill, contrast, and the
  // reference_drift rows on type, motion, holds and cuts) and the person's blind judge result for
  // this revision. A final render needs one for the revision it renders (refuseWithoutReference).
  // Reference stills' stats are kept here so a second versus reads no picture twice.
  const versusStatsCache = new Map();
  function saveReference(search) {
    return `library {topic:"inspire", search:${JSON.stringify(search)}}, then library {topic:"inspire", name:"save yt:<id>"}`;
  }
  async function versusLook(input, { record, codes, fonts, state }) {
    if (!deps.inspire) throw new AgentError("failed", "Inspire is not available here.");
    const document = record.document;
    const projectId = document.id;
    if (!(await judge.hasSaved(projectId))) throw new AgentError("bad_input", `versus needs a saved reference: ${saveReference(await findSearchFor(projectId))}.`);
    // A reference saved before kino kept stills is measured again first (one at a time).
    const refs = await deps.inspire.savedStills(projectId, { wait: INSPIRE_WAIT_MS });
    // The board's pinned keys are matched against every saved reference (key, id or title); only
    // the ones a shot pins, past the first five, are measured and waited for.
    let known = refs;
    const pinKeys = boardRefKeys(document.board);
    if (pinKeys.length) {
      const all = await deps.inspire.savedStills(projectId, { most: Infinity, bare: true });
      const want = [...new Set(pinKeys.map((key) => refForKey(all, key)?.id).filter((id) => id && !refs.some((ref) => ref.id === id)))];
      const more = want.length ? await deps.inspire.savedStills(projectId, { wait: INSPIRE_WAIT_MS, ids: want }) : [];
      known = all.map((ref) => [...refs, ...more].find((entry) => entry.id === ref.id) ?? ref);
    }
    const scenes = document.scenes.filter((item) => !item.isComponent);
    const total = scenes.reduce((sum, item) => sum + item.duration, 0);
    if (!(total > 0)) throw new AgentError("bad_input", "versus needs a video longer than 0 s.");
    // Fair pairs (versus.mjs): a shot's pinned moment (move.ref "phone-film@3.13") first, else the
    // reference moment of the same kind nearest the same point of the story, else no match.
    const rows = Math.min(VERSUS_ROWS, pairCount(total));
    const board = document.board?.shots?.length ? document.board : null;
    const pinned = board ? pinnedPairs(board, scenes[0].id, known, rows) : { pairs: [], missing: [], waiting: [] };
    if (!refs.length && !pinned.pairs.length) throw Object.assign(new AgentError("not_ready", 'The saved references have no stills yet: kino is measuring them again, one at a time. look {mode:"versus"} again in a minute.'), { nextCall: nextOf("look", { mode: "versus" }) });
    const prepared = new Map();
    const preparedOf = async (sceneId) => { if (!prepared.has(sceneId)) prepared.set(sceneId, await prepare(document, sceneId, fonts)); return prepared.get(sceneId); };
    const editStats = async (sceneId, t) => {
      const scene = await preparedOf(sceneId);
      return imageStats((await look.frame(scene, t, tileSize(scene.scene, VERSUS_EDGE).width)).png);
    };
    const pool = known.filter((ref) => ref.stills?.length);
    for (const ref of pool) ref.moments = await referenceMoments(ref, versusStatsCache);
    // The edit's moments to pair: the board's shots (at their middles, spread over the board), or
    // without a board, rows at even points of the story, each read from its pixels.
    const slots = [];
    const spread = (list, most) => (list.length <= most ? list : Array.from({ length: most }, (_, index) => list[Math.floor(((index + 0.5) * list.length) / most)]));
    if (board) {
      const names = await shotFileNames(board);
      const taken = new Set(pinned.pairs.map((pair) => pair.shot));
      const free = board.shots.map((shot, index) => ({ shot, index })).filter(({ shot, index }) => !taken.has(index + 1) && Number.isFinite(shot?.cue) && shot.dur > 0);
      for (const { shot, index } of spread(free, rows - pinned.pairs.length)) {
        const prev = board.shots[index - 1] ?? null, next = board.shots[index + 1] ?? null;
        const t = sec(shot.cue + shot.dur / 2);
        slots.push({ sceneId: scenes[0].id, t, at: t, shot: index + 1, kind: boardShotKind(shot, { name: names[shot.media] ?? null, prev, next, prevName: names[prev?.media] ?? null, nextName: names[next?.media] ?? null, last: index === board.shots.length - 1 }) });
      }
    } else {
      for (let index = 0; index < rows; index += 1) {
        const share = (index + 0.5) / rows;
        let at = share * total, scene = scenes[0];
        for (scene of scenes) { if (at < scene.duration) break; at -= scene.duration; }
        const t = sec(Math.min(at, scene.duration));
        slots.push({ sceneId: scene.id, t, at: sec(share * total), kind: editPixelKind(await editStats(scene.id, t), share) });
      }
    }
    const used = new Set(pinned.pairs.map((pair) => `${pair.ref}@${pair.refAt}`));
    const matched = slots.map((slot) => {
      const found = sameKindMoment(pool, slot.kind, slot.at / total, used);
      if (!found) return { ...slot, ref: null, refAt: null, still: null, nofair: true };
      used.add(`${found.ref.id}@${found.moment.at}`);
      return { ...slot, ref: found.ref.id, refAt: found.moment.at, still: path.join(found.ref.folder, found.moment.file), theirs: found.moment.stats };
    });
    const pairs = [...pinned.pairs, ...matched].sort((a, b) => a.at - b.at).map((pair, index) => ({ ...pair, n: index + 1 }));
    // The craft gaps of each fair pair (hero fill, contrast); none for a shot with no fair match.
    for (const pair of pairs) if (pair.still) pair.gaps = gapWords(await editStats(pair.sceneId, pair.t), pair.theirs ?? (await imageStats(pair.still, versusStatsCache)));
    const name = (id) => { const ref = known.find((entry) => entry.id === id); return String(ref?.keys?.[0] || ref?.channel || ref?.id || id).slice(0, 16); };
    const why = (pair) => (pair.pinned ? `pinned ${pair.pinned}` : pair.nofair ? `no fair match, no saved reference has ${KIND_WORDS[pair.kind]}` : `same kind, ${KIND_WORDS[pair.kind]}`);
    const image = await look.versusImage(pairs.map((pair) => ({ prepared: prepared.get(pair.sceneId), time: pair.t, still: pair.still,
      editLabel: `${pair.n} ${pair.shot ? `shot ${pair.shot}` : "yours"} @${pair.at}s`,
      refLabel: pair.still ? `${pair.n} ${pair.pinned ? `pin ${pair.pinned.split("@")[0]}` : name(pair.ref)} @${pair.refAt}s` : `${pair.n} no fair match` })));
    const file = await look.save(projectId, "versus", image.png);
    noteLive({ sceneId: null }, pairs.map((pair) => ({ sceneId: pair.sceneId, time: pair.t })));
    // The reference_drift rows that are off, from each scene's latest full check (check measures
    // it): only the craft that transfers (type size, motion, holds, cuts).
    const drift = [];
    for (const item of scenes) {
      const { findings, unchecked } = await findingsFor(document, { fonts, codes, sceneId: item.id, rules: ["reference_drift"] });
      const where = scenes.length > 1 ? `${refName(item.id, codes)} ` : "";
      for (const finding of findings) for (const row of String(finding.measured ?? "").split("; ").filter(craftRow)) drift.push(`${where}reference_drift off: ${row}`);
      if (unchecked === "all" || unchecked.length) drift.push(`${where}reference_drift not measured on this revision: check measures it.`);
    }
    // reference_range: the whole video against the range of the saved references (brightness, dark share, text, voice).
    const measuredRefs = ((await deps.inspire?.savedFingerprints?.(projectId).catch(() => [])) ?? []).filter((ref) => Number.isFinite(ref.fingerprint?.look?.brightness)).length;
    const range = [];
    for (const item of measuredRefs >= 2 ? scenes : []) {
      // Measured here (2 frames a second, small; no listening), not read from a check: a check is not kept while a drift measure runs.
      const { findings } = await findingsFor(document, { fonts, codes, sceneId: item.id, pixels: true, listen: false, rules: ["reference_range"] });
      const where = scenes.length > 1 ? `${refName(item.id, codes)} ` : "";
      for (const finding of findings) range.push(`${where}outside your ${measuredRefs} references: ${finding.measured} (theirs: ${String(finding.required).replace(/^inside your \d+ saved references: /, "")}). check lists each fix.`);
    }
    if (measuredRefs >= 2 && !range.length) range.push(`inside your ${measuredRefs} references in brightness, dark share, text per 10 s, voice.`);
    const fair = pairs.filter((pair) => pair.still).length;
    const lines = [
      `versus rev ${record.revision}: ${pairs.length} rows, yours (left) beside a saved reference (right) of the same kind of shot: ${fair} matched${fair < pairs.length ? `, ${pairs.length - fair} with no fair match` : ""}. Compare craft (hero size, type, motion, holds, contrast), not content or footage colors.`,
      ...pairs.map((pair) => `row ${pair.n} ${pair.shot ? `shot ${pair.shot} ` : ""}@${pair.at}s: ${why(pair)}${pair.still ? ` (${name(pair.ref)} @${pair.refAt}s)` : ""}${pair.gaps?.length ? `; ${pair.gaps.join("; ")}` : ""}${pair.far ? `; ${pair.far}` : ""}.`),
      ...(pinned.missing.length ? [`not pinned, no saved reference by that key: ${pinned.missing.join(", ")} (library inspire name:"save yt:<id> as <key>").`] : []),
      ...(pinned.waiting.length ? [`not pinned yet, that reference is saved but not measured yet: ${pinned.waiting.join(", ")} (look {mode:"versus"} again in a minute).`] : []),
      ...(drift.length ? drift : ["reference_drift: near the references in the craft measured."]),
      ...range,
      judgeLine(state, record.revision),
      `image ${file}`,
    ];
    return done(projectId, { text: lines.join("\n"), images: [{ path: file, mime: "image/png", data: input.inline === false ? undefined : image.png.toString("base64") }],
      data: { rev: record.revision, mode: "versus", path: file, rows: pairs.map((pair) => ({ n: pair.n, at: pair.at, ref: pair.ref, refAt: pair.refAt, match: pair.pinned ? "pinned" : pair.nofair ? "none" : "kind",
        ...(pair.kind ? { kind: pair.kind } : {}), ...(pair.shot ? { shot: pair.shot } : {}), ...(pair.pinned ? { pinned: pair.pinned } : {}), ...(pair.gaps?.length ? { gaps: pair.gaps } : {}), ...(pair.far ? { far: pair.far } : {}) })) } },
    { change(draft) { draft.versus = { rev: record.revision }; } });
  }

  // The reference gate: a final render of the whole video (not a still, not a cut-short stretch)
  // of 5 s or longer is refused while the project has no saved reference. With saved references it
  // needs a look versus of the revision it renders, and is refused while the person's blind judge
  // round of that revision has the references winning more pairs than yours and same together.
  // Short scenes, waive_check {code:"reference"} and calls the person made or allowed in the app
  // go ahead.
  // A final render also needs the direction locked (brief.mjs lockNeeded): a story spine and a
  // style bible the person approved, or one the agent waived with a reason. A video with no brief
  // (a change to an old one) and a rough pass of 30 layers or fewer go ahead.
  async function refuseWithoutLock(record, { format }) {
    const meta = caller.getStore() ?? {};
    if (meta.reviewed || meta.approved || meta.by === "you" || format === "png") return;
    const lock = lockNeeded(await agentState.read(record.document.id), videoFacts(record.document));
    if (!lock) return;
    throw Object.assign(new AgentError("direction_needed", `No locked direction: a final render of ${videoFacts(record.document).layers} layers needs a story spine and a style bible (notes brief style; with a picked treatment, the idea and a signature too) the person approved, or waived with a reason.`, {
      next: `${lock.step}. One notes brief call does it; a draft render is allowed now.`,
    }), { nextCall: lock.call });
  }
  // An edit builds when it adds a designed layer or an animation: "first" when the video had
  // none before, "more" after, else null. Footage and sound placed as they are (video and audio
  // layers) are material, not building.
  function buildsSomething(before, after) {
    const ids = (document) => {
      const found = new Set();
      const walk = (list) => { for (const animation of list ?? []) { found.add(animation.id); walk(animation.animations); } };
      for (const scene of document.scenes ?? []) for (const layer of scene.layers ?? []) {
        if (layer.type !== "audio" && layer.type !== "video") found.add(layer.id);
        walk(layer.animations);
      }
      return found;
    };
    const old = ids(before);
    if (![...ids(after)].some((id) => !old.has(id))) return null;
    return old.size ? "more" : "first";
  }
  // Building before the order step is done (brief.mjs orderStep) is refused with its call.
  // Calls the person made or allowed in the app go ahead, as at the other gates.
  async function refuseOutOfOrder(projectId, document) {
    const meta = caller.getStore() ?? {};
    if (meta.approved || meta.by === "you") return;
    const state = await agentState.read(projectId);
    if (!hasBrief(state.brief)) return;
    const [order, ...later] = orderSteps(state, await directionFacts(document));
    if (!order) return;
    const skip = order.call.tool === "notes" ? 'edit waive_check {code:"treatments", target:"*", reason}' : 'edit waive_check {code:"reference", target:"*", reason}';
    // Every gate still open in one answer, so a build does not find them one refusal at a time.
    const then = later.length ? ` Then: ${later.map((entry) => entry.step).join("; ")}.` : "";
    // The find step also offers the same search without the song; the study step names each saved
    // reference still to study, with its exact call.
    const also = order.alt ? ` Or without the song: ${callText(order.alt)}.` : "";
    const study = order.refs ? ` ${REFERENCES_WANTED} saved references must each be studied; still to study: ${order.refs.map((ref) => callText({ tool: "look", input: { mode: "reference", ref } })).join(", ")}.` : "";
    throw Object.assign(new AgentError("order_needed", `Nothing was built: this briefed video finds its idea before the template. Next: ${order.step}.${then}`, {
      next: `Send the call below, then build.${also}${study} Importing media, set_brand, notes, library, look and inspect work now. A deliberate skip the person sees: ${skip}.`,
    }), { nextCall: order.call });
  }
  async function refuseWithoutReference(record, scenes, { format, options }) {
    const meta = caller.getStore() ?? {};
    if (meta.reviewed || meta.approved || meta.by === "you" || format === "png") return;
    if (Number.isFinite(options?.duration) && scenes.every((item) => options.duration < item.duration - 0.01)) return;
    const waivers = (record.document.checkWaivers ?? []).filter((waiver) => waiver.code === REFERENCE_WAIVER);
    if (scenes.every((item) => waivers.some((waiver) => waiver.target === "*" || waiver.target === item.id))) return;
    const skip = `A deliberate skip: edit waive_check {code:"reference", target:"*", reason}. A draft render is allowed now.`;
    if (!(await judge.hasSaved(record.document.id))) {
      if (!deps.inspire || scenes.every((item) => item.duration < REFERENCE_SKIP_UNDER)) return;
      const search = await findSearchFor(record.document.id);
      throw Object.assign(new AgentError("reference_needed", `No saved reference edits: a final render needs ${REFERENCES_WANTED}+ reference edits like this one, saved and studied, so the video is held to something finished.`, {
        next: `${saveReference(search)}; save ${REFERENCES_WANTED}, study their strips, then render final again. ${skip}`,
      }), { nextCall: nextOf("library", { topic: "inspire", search }) });
    }
    const state = await agentState.read(record.document.id);
    // A briefed video: only references saved before its first build, or studied before it, held
    // the edit to something finished. Ones saved afterwards to pass this gate do not count.
    if (state.firstBuild) {
      const early = new Set([...state.firstBuild.saved, ...state.firstBuild.studied]);
      const saved = await savedIds(record.document.id);
      if (!saved.some((id) => early.has(id)))
        throw Object.assign(new AgentError("reference_needed", `References saved after building do not count: none of the ${saved.length} saved was saved or studied before the first build (rev ${state.firstBuild.rev}), so none shaped this edit.`, {
          next: `Tell the person the edit was built without references. ${skip}`,
        }), { nextCall: nextOf("edit", { ops: [{ op: "waive_check", code: REFERENCE_WAIVER, target: "*", reason: "<built before the references; the person knows>" }] }) });
    }
    const rev = record.revision;
    const lost = judgeLost(state, rev);
    if (lost) {
      const counts = tally(lost);
      throw Object.assign(new AgentError("reference_needed", `The person judged rev ${rev} blind: references ${counts.references} · same ${counts.same} · yours ${counts.yours}. The references looked more finished at ${counts.lost.map((pair) => `@${pair.at}s`).join(", ")}: work there, then render again.`, {
        next: `look {mode:"versus"} shows those moments beside the references; change yours, then render final again. ${skip}`,
      }), { nextCall: nextOf("look", { mode: "versus" }) });
    }
    if (!versusSeen(state, rev))
      throw Object.assign(new AgentError("reference_needed", `rev ${rev} was not seen beside the saved references. look {mode:"versus"} shows your frames next to theirs with the measured gaps; then render again.`, {
        next: `look {mode:"versus"}, change what looks less finished than the references, then render final again. ${skip}`,
      }), { nextCall: nextOf("look", { mode: "versus" }) });
  }

  // ---- look review and the review gate (review.mjs) -----------------------------------------
  // A scene's review events ({time, names, key}), from `from` to `to` when given. The key holds
  // what is on screen at the event's time, so an edit elsewhere leaves it alone.
  async function sceneReview(document, sceneId, fonts, codes, range = {}) {
    const prepared = await prepare(document, sceneId, fonts);
    const cuts = await shotsOf(prepared.scene);
    const missing = missingDocumentFonts({ scenes: [prepared.scene] }, fonts).map((entry) => `${entry.fontFamily}/${entry.fontWeight}/${entry.fontStyle}`).join(",");
    const events = reviewEvents(prepared.scene, { shots: cuts.shots, name: (id) => refName(id, codes), ...range })
      .map((event) => ({ ...event, key: reviewKey(event.time, frameSignature(prepared.scene, event.time, { fonts, missing })) }));
    return { prepared, events };
  }

  // The times the top full-frame plate changes in one frame (the motion trace's cuts), for look
  // review's seams. The model at 30 fps is kept for the last revision asked.
  let plateCutsCache = null;
  async function reviewPlateCuts(document, sceneId, fonts, revision) {
    const key = `${document.id}:${sceneId}:${revision}`;
    if (plateCutsCache?.key !== key) {
      const model = kinoTimeline(document, sceneId, { fonts, fps: 30 });
      plateCutsCache = { key, times: motionTrace(model).cuts.map((cut) => cut.time) };
    }
    return plateCutsCache.times;
  }

  // The words for one event: "8.45s cut to shot 3; hook in" (at most 3 names).
  const eventWords = (event) => `${event.time}s ${event.names.slice(0, 3).join("; ")}${event.names.length > 3 ? ` +${event.names.length - 3}` : ""}`;

  // look {mode:"motion", scene?, from?, to?}: how the scene moves, from the quality model at 30
  // samples a second (no rendering): a graph PNG and a text trace, one line a 0.5 s step
  // (backend/agent/motion-graph.mjs), with cuts, beats, cues and check findings marked.
  async function motionLook(input, { document, codes, fonts, scene }) {
    const { from, to } = stretchBounds(input, scene);
    const model = kinoTimeline(document, scene.id, { fonts, fps: 30 });
    const name = (item) => refName(item.id, codes);
    const trace = motionTrace(model, { from, to, name });
    const { findings } = await findingsFor(document, { fonts, codes, sceneId: scene.id, pixels: false });
    // The camera rules' findings are the trace's verdicts (noted in full, their span shaded on the
    // graph); the other findings are marked by code.
    const shown = findings.filter((finding) => finding.at != null && !finding.waived && finding.severity !== "info");
    const camera = shown.filter((finding) => CAMERA_RULES.has(finding.rule) && (finding.until ?? finding.at) >= from && finding.at <= to);
    const marks = [];
    for (const finding of shown) marks.push({ time: finding.at, kind: "finding", words: `${finding.severity === "error" ? "E" : "W"} ${finding.rule}` });
    // Cues (markers, beats from detect_beats); without beat cues, the document's rhythm.
    const cues = (document.cues ?? []).filter((cue) => Number.isFinite(cue.time));
    for (const cue of cues) marks.push({ time: cue.time, kind: MUSIC_CUE_KINDS.includes(cue.kind) ? "beat" : "cue", words: `cue ${cue.name}` });
    const bpm = Number(document.rhythm?.bpm);
    if (!cues.some((cue) => cue.kind === "beat") && bpm > 0) for (let time = Number(document.rhythm.offset) || 0; time <= to; time += 60 / bpm) if (time >= from) marks.push({ time, kind: "beat" });
    // A finding or cue is noted once in the text (the graph marks every one).
    const textMarks = [];
    for (const mark of marks.filter((entry) => entry.kind !== "beat" && !CAMERA_RULES.has(entry.words.slice(2)))) if (!textMarks.some((entry) => entry.words === mark.words && Math.abs(entry.time - mark.time) < 0.5)) textMarks.push(mark);
    const { text: lines, more } = traceText(trace, { marks: textMarks, findings: camera });
    const png = motionGraphImage(trace, { marks, findings: camera });
    const head = `motion ${refName(scene.id, codes)} ${sec(from)}–${sec(to)}s from the model (no render). Each 0.5 s: cover (1 = full-frame pictures cover the frame), plate (the top full-frame picture: scale rate, speed in frame widths/s), the biggest other mover, an edge sliver (0.1 s or more), notes: camera findings in full (lone_zoom, edge_linger, transition_dip, cut_mid_move; check has their fixes). look {mode:"frames", from} shows every frame.`;
    return { image: { png }, text: `${head}\n${lines}${more != null ? `\nmore: look {mode:"motion", from:${more}, to:${sec(to)}}` : ""}` };
  }

  // look {mode:"review", scene?, from?, to?}: the next moments of the scene the agent has not
  // reviewed as they are now, in time order, until the call's image budget is used: risky ones
  // at full size, quiet ones on a compact page, each with the check findings at its time. A frame
  // that looks the same as the one before it is not shown again ("same as 3"). Every moment
  // shown, or the same as one shown, counts as reviewed.
  async function reviewLook(input, { record, codes, fonts, scene, state }) {
    const document = record.document;
    const projectId = document.id;
    const range = input.from != null || input.to != null ? stretchBounds(input, scene) : null;
    const { prepared, events } = await sceneReview(document, scene.id, fonts, codes, range ?? {});
    const seen = new Set(state.reviews?.[scene.id]?.seen ?? []);
    const fresh = unreviewed(events, seen);
    const where = `${refName(scene.id, codes)}${range ? ` ${sec(range.from)}–${sec(range.to)}s` : ""}`;
    const sceneField = document.scenes.length > 1 ? { scene: refName(scene.id, codes) } : {};
    const rangeFields = range ? { from: sec(range.from), to: sec(range.to) } : {};
    noteLive({ sceneId: scene.id, range: range ? [range.from, range.to] : [0, scene.duration] }, [{ sceneId: scene.id, range: range ? [range.from, range.to] : [0, scene.duration] }]);
    if (!fresh.length) {
      return done(projectId, { text: `review ${where} rev ${record.revision}: all ${plural(events.length, "moment")} reviewed as they are now; nothing changed since.`,
        data: { rev: record.revision, mode: "review", events: events.length, shown: 0, left: 0 } });
    }
    const { findings } = await findingsFor(document, { fonts, codes, sceneId: scene.id, pixels: false });
    const shown = findings.filter((finding) => !finding.waived && finding.severity !== "info");
    const findingWords = (finding) => `${finding.severity === "error" ? "E" : "W"} ${finding.rule} ${finding.ref}`;
    const sizes = reviewSizes(events, shown);
    const edges = { full: REVIEW_FULL_EDGE, compact: REVIEW_COMPACT_EDGE };
    const rows = { full: 2, compact: 5 };
    // The image tokens of one size's page with `entries` on it (as Claude reads it, after it
    // shrinks a large image); each frame's strip holds its label and up to 3 findings.
    const pageTokens = (size, entries) => {
      if (!entries.length) return 0;
      const tile = tileSize(scene, Math.min(edges[size], Math.max(scene.width, scene.height)));
      const columns = Math.min(reviewColumns(tile.width), entries.length);
      const lines = 2 + Math.max(...entries.map((entry) => Math.min(3, entry.notes.length)));
      const pageRows = Math.ceil(entries.length / columns);
      return estimateImageTokens({ width: columns * tile.width + (columns - 1) * 8, height: pageRows * (tile.height + 15 + 28 * lines) + (pageRows - 1) * 8 });
    };
    // Each cut also gets a seam strip (SEAM_OFFSETS frames across it) on a page of its own: a cut
    // in the footage, or a change of the top full-frame plate in one frame (the motion trace's
    // cuts). A layer shown or hidden within 0.1 s of a cut is that cut's seam; elsewhere it gets
    // none. The strips' tokens count against the same budget, so a call never grows past it.
    const plateCuts = await reviewPlateCuts(document, scene.id, fonts, record.revision);
    const seamOf = (event) => {
      const near = plateCuts.find((time) => Math.abs(time - event.time) <= SEAM_MERGE + 1e-6);
      if (near != null) return sec(near);
      return (event.kinds ?? []).includes("cut") ? event.time : null;
    };
    const seamTile = tileSize(scene, SEAM_EDGE);
    const seamTokens = (count) => (count ? estimateImageTokens({ width: SEAM_OFFSETS.length * (seamTile.width + 4) - 4, height: count * (seamTile.height + 4) - 4 }) : 0);
    const picked = { full: [], compact: [] };
    const same = [];
    let previous = null;
    for (const event of fresh) {
      const size = sizes.get(event.key) ?? "full";
      const notes = findingsAt(shown, event.time).map(findingWords);
      const drawn = await look.reviewFrame(prepared, event.time, edges[size]);
      // Nothing new to see: the same picture (and no other findings) as the frame before it.
      const repeat = previous && notes.every((note) => previous.notes.includes(note))
        && nearDuplicate(drawn.thumb, previous.drawn.thumb, { strict: size === "full" });
      if (repeat) { same.push({ event, of: previous }); continue; }
      const entry = { event, size, notes, drawn };
      const tried = { ...picked, [size]: [...picked[size], entry] };
      const perPage = reviewColumns(tileSize(scene, Math.min(edges[size], Math.max(scene.width, scene.height))).width) * rows[size];
      const cuts = new Set([...tried.full, ...tried.compact].map((item) => seamOf(item.event)).filter((time) => time != null)).size;
      const cost = pageTokens("full", tried.full) + pageTokens("compact", tried.compact) + seamTokens(cuts);
      const any = picked.full.length + picked.compact.length;
      if (any && (cost > REVIEW_IMAGE_BUDGET || tried[size].length > perPage)) break;
      picked[size].push(entry);
      previous = entry;
    }
    // Numbers in time order across both pages, so the agent reads the video in sequence.
    const ordered = [...picked.full, ...picked.compact].sort((a, b) => a.event.time - b.event.time);
    for (const [index, entry] of ordered.entries()) entry.n = index + 1;
    const images = [];
    const lines = [];
    let pageNumber = 0;
    for (const size of ["full", "compact"]) {
      const entries = picked[size];
      if (!entries.length) continue;
      const pages = await look.reviewPages(prepared, entries.map((entry) => ({ time: entry.event.time, label: `${entry.n} · ${eventWords(entry.event)}`, notes: entry.notes, png: entry.drawn.png, key: entry.drawn.key })), { longEdge: edges[size], rows: rows[size] });
      for (const page of pages) {
        pageNumber += 1;
        const file = await look.save(projectId, "review", page.png);
        images.push({ path: file, mime: "image/png", data: input.inline === false ? undefined : page.png.toString("base64") });
        const members = entries.filter((entry) => page.frames.some((item) => item.time === entry.event.time));
        lines.push(`page ${pageNumber} (${size === "full" ? "full size" : "compact"}) ${file}: ${members.map((entry) => `${entry.n}=${eventWords(entry.event)}`).join(" · ")}`);
        for (const entry of members) for (const note of entry.notes.slice(0, 3)) lines.push(`  ${entry.n} @${entry.event.time}s ${note}`);
      }
    }
    // One seam a cut: events within SEAM_MERGE of the same cut share it.
    const seams = [];
    for (const entry of ordered) {
      const time = seamOf(entry.event);
      if (time != null && !seams.some((seam) => seam.time === time)) seams.push({ n: entry.n, time });
    }
    if (seams.length) {
      const seamPage = await look.seamImage(prepared, seams);
      const file = await look.save(projectId, "review", seamPage.png);
      images.push({ path: file, mime: "image/png", data: input.inline === false ? undefined : seamPage.png.toString("base64") });
      lines.push(`seams ${file}: a row a cut (${seams.map((seam) => seam.n).join(", ")}), frames at ${SEAM_OFFSETS.map((offset) => `${offset > 0 ? "+" : ""}${offset}`).join(" ")} s: look for a pop, a flash or a brightness jump across it`);
    }
    if (same.length) lines.push(`same picture as the frame before, counted as reviewed: ${same.map(({ event, of }) => `${event.time}s (as ${of.n})`).join(", ")}`);
    const covered = [...ordered.map((entry) => entry.event), ...same.map(({ event }) => event)];
    const left = fresh.length - covered.length;
    const head = `review ${where} rev ${record.revision}: ${covered.length} of ${plural(fresh.length, "unreviewed moment")} (${events.length} in all): ${picked.full.length} at full size, ${picked.compact.length} compact${same.length ? `, ${same.length} unchanged` : ""}. Each tile is the whole frame (gray outline), not a crop. Look at each frame closely: type, wrapping, overlaps, framing, empty space, artifacts.`;
    const wide = shown.filter((finding) => finding.at == null).slice(0, 3);
    if (wide.length) lines.push(`whole scene: ${wide.map(findingWords).join(", ")}`);
    lines.push(left ? `${left} more moments to review.` : "Every moment is reviewed. Fix what you saw in one edit; the next review shows only what it changed.");
    const keys = covered.map((event) => event.key);
    const nextCall = left ? { tool: "look", input: { mode: "review", ...sceneField, ...rangeFields } } : null;
    return done(projectId, { text: [head, ...lines].join("\n"), images, ...(nextCall ? { nextCall } : {}),
      data: { rev: record.revision, mode: "review", events: events.length, shown: ordered.length, same: same.length, full: picked.full.length, compact: picked.compact.length, left, pages: images.map((entry) => entry.path), times: covered.map((event) => event.time).sort((a, b) => a - b) } },
    { change(draft) {
      draft.reviews ??= {};
      const old = draft.reviews[scene.id]?.seen ?? [];
      draft.reviews[scene.id] = { rev: record.revision, seen: rememberReviewed(old, keys) };
    } });
  }

  // The review gate: a final render of a whole video (not a still, not a cut-short stretch) waits
  // until every moment of each scene was seen as it is now (look review). Short scenes, scenes
  // with a waive_check {code:"review"} and calls the person made or allowed in the app go ahead.
  async function refuseUnreviewed(record, scenes, { fonts, codes, format, options }) {
    const meta = caller.getStore() ?? {};
    if (meta.reviewed || meta.approved || format === "png") return;
    const state = await agentState.read(record.document.id);
    const waivers = record.document.checkWaivers ?? [];
    for (const scene of scenes) {
      if (scene.duration < REVIEW_SKIP_UNDER) continue;
      if (Number.isFinite(options?.duration) && options.duration < scene.duration - 0.01) continue;
      if (waivers.some((waiver) => waiver.code === REVIEW_WAIVER && (waiver.target === "*" || waiver.target === scene.id))) continue;
      const { events } = await sceneReview(record.document, scene.id, fonts, codes);
      const missed = unreviewed(events, new Set(state.reviews?.[scene.id]?.seen ?? []));
      if (!missed.length) continue;
      const name = refName(scene.id, codes);
      throw Object.assign(new AgentError("review_needed", `${missed.length} of ${plural(events.length, "moment")} in ${name} not reviewed as they are now (${missed.slice(0, 3).map(eventWords).join(", ")}${missed.length > 3 ? ", …" : ""}). look {mode:"review"} shows them (risky ones at full size); then render again.`, {
        unreviewed: missed.length,
        next: `look {mode:"review"${scenes.length > 1 ? `, scene:"${name}"` : ""}} until it says every moment is reviewed. A deliberate skip: edit waive_check {code:"review", target:"${name}", reason}. A draft render is allowed now.`,
      }), { nextCall: nextOf("look", { mode: "review", ...(record.document.scenes.length > 1 ? { scene: name } : {}) }) });
    }
  }

  // Whether the person sent sound files for this video, for the storyboard's sound column (plan
  // §5): sound files of kino's media library that belong to this project (uploaded to it, or
  // used by one of its saves: media-use.mjs) and that it does not play now as its music or
  // voice-over. The library is shared, so another video's song does not count.
  // The credit lines of the found sounds (sound search) this video plays, for the sound stop.
  async function soundCredits(document) {
    const playing = new Set((document.scenes ?? []).flatMap((scene) => scene.layers ?? []).filter((layer) => layer.type === "audio" || layer.type === "video").map((layer) => layer.src));
    const media = (await deps.listMedia?.()) ?? [];
    // Each line once: twelve found shots of one video share one credit.
    return [...new Set(media.filter((item) => item.credit?.line && playing.has(item.src ?? `/api/media/${item.id}`)).map((item) => item.credit.line))];
  }
  // Every final render's answer ends with one quiet line: the found media it plays (footage,
  // songs, sounds), kept for when the person publishes. Nothing is asked or checked here.
  async function finalSources(document) {
    const credits = await soundCredits(document);
    if (!credits.length) return "";
    return ` Sources (for when the person publishes): ${credits.slice(0, 3).join("; ")}${credits.length > 3 ? ` (+${credits.length - 3} more)` : ""}.`;
  }
  // Whether the video (its longest scene) has music, for the sound stop: the no_music rule's test
  // (hasMusic) with the songs kino heard a beat in and the saved voice transcripts.
  async function musicIn(document) {
    const scene = videoScene(document);
    if (!scene) return true;
    // waive_check {code:"no_music"}: with the person's words it is their call to keep it silent;
    // without them it is "waived", which the sound stop holds while the song search found songs.
    const waiver = (document.checkWaivers ?? []).find((entry) => entry.code === "no_music" && (entry.target === "*" || entry.target === scene.id));
    if (waiver) return String(waiver.reason ?? "").includes('(the person: "') ? true : "waived";
    return hasMusic(scene, await savedSoundKinds(scene, document));
  }
  // Each audio layer's kind as far as kino knows it without new work: {layer, music: true} for a
  // song (a beat was found), {layer, transcript} for a voice with a saved transcript.
  async function savedSoundKinds(scene, document) {
    const speech = [];
    for (const layer of scene.layers) {
      if (layer.type !== "audio" || !layer.src) continue;
      let file;
      try { file = mediaFileOf(layer); } catch { continue; }
      if (await isMusicFile(file)) { speech.push({ layer, music: true, file }); continue; }
      try {
        const transcript = await transcripts.saved?.(file, document, layer);
        if (transcript?.words) speech.push({ layer, transcript, file });
      } catch { /* no saved transcript: its length decides */ }
    }
    return speech;
  }

  // look {mode:"sound"} (sound-map.mjs): the scene's mix measured three ways (all, the music
  // alone, the rest alone), one FFmpeg run at a time, with the beats, spoken lines, song
  // sections and ducking dips. Nothing is played.
  async function soundLook({ record, codes, scene, state }) {
    const document = record.document;
    const duration = scene.duration;
    const kinds = await savedSoundKinds(scene, document);
    const music = scene.layers.filter((layer) => isMusicLayer(layer, scene, kinds.find((entry) => entry.layer === layer)));
    const musicIds = new Set(music.map((layer) => layer.id));
    // A copy of the scene where only `keep` layers are heard.
    const only = (keep) => ({ ...scene, layers: scene.layers.map((layer) => ((layer.type === "audio" || layer.type === "video") && !keep(layer)
      ? { ...layer, volume: 0, animations: (layer.animations ?? []).filter((animation) => !(animation?.to && "volume" in animation.to)) } : layer)) });
    const lines = await spokenSpans(scene, document);
    const directory = await makeTempFolder("kino-sound-");
    let map;
    try {
      const curveOf = async (version) => soundCurve(await sceneSoundClips(version, { mediaRoot: deps.mediaRoot, directory, duration }), duration);
      const mix = await curveOf(scene);
      const musicCurve = music.length ? await curveOf(only((layer) => musicIds.has(layer.id))) : null;
      const rest = music.length && lines.length ? await curveOf(only((layer) => !musicIds.has(layer.id))) : null;
      const sections = [];
      for (const layer of music) {
        const kind = kinds.find((entry) => entry.layer === layer && entry.music);
        if (!kind) continue;
        try {
          const beats = JSON.parse(await readFile(`${kind.file}.beats`, "utf8"));
          const { samples, sampleRate } = await decodeMono(kind.file);
          sections.push(...sectionsInVideo(layer, songShape(samples, sampleRate, { bpm: beats.bpm }).sections, duration).map((part) => ({ layer: refName(layer.id, codes), ...part })));
        } catch { /* no shape: the graph shows the loudness only */ }
      }
      const spine = state.brief?.style?.spine;
      const beats = scene.id === videoScene(document)?.id && Array.isArray(spine) && spine.length
        ? spine.map((beat, index) => ({ from: beat.from, to: beat.to, name: beat.role ?? `beat ${index + 1}` }))
        : (state.story?.intents?.[scene.id]?.beats ?? []).map((beat, index) => ({ from: beat.from, to: beat.to, name: `beat ${index + 1}` }));
      const dips = music.flatMap((layer) => volumeDips(layer, duration).map((dip) => ({ layer: refName(layer.id, codes), ...dip })));
      // The scene-cut list (shot changes) and each sound clip's edges, for the mix check's level jumps.
      const cuts = plateChanges(kinoTimeline(document, scene.id, { fonts: await fontsFor(document), fps: 30 })).map((change) => change.at);
      const edges = scene.layers.filter((layer) => (layer.type === "audio" || layer.type === "video") && layer.src).flatMap((layer) => {
        const range = mediaPlaybackRange(layer, duration);
        return range ? [range.start, range.end] : [];
      }).filter((at) => at > 0.2 && at < duration - 0.2);
      map = { duration, mix, music: musicCurve, rest, beats: beats.filter((beat) => Number.isFinite(beat.from) && Number.isFinite(beat.to)), lines, sections, dips, cuts, edges: [...new Set(edges.map((at) => Math.round(at * 10) / 10))] };
    } catch (error) {
      throw new AgentError("failed", `The sound could not be measured: ${String(error.message).split("\n")[0].slice(0, 200)}`);
    } finally {
      await removeTempFolder(directory);
    }
    return { image: { png: soundMapImage(map) }, text: soundMapText(map, { scene: refName(scene.id, codes) }) };
  }
  // Whether the person turned on sound search in Settings (backend/sound-search.mjs).
  const soundSearchOn = () => Boolean(deps.soundSearch?.enabled?.());
  // Songs can be found without the web search switch (YouTube through yt-dlp; index.mjs sets
  // songSearch), so the no-music fix and the sound stop push a real song.
  const songSearchOn = () => Boolean(deps.songSearch?.()) || soundSearchOn();
  // Whether a need may offer found footage: the footage finder is here, its topic is offered and
  // web search is on (the same Settings switch as sound search).
  const footageSearchOn = () => Boolean(footageActions && footageStepShown && soundSearchOn());
  async function soundFilesFor(document) {
    const playing = new Set((document.scenes ?? []).flatMap((scene) => scene.layers ?? []).filter((layer) => layer.type === "audio").map((layer) => layer.src));
    const media = (await deps.listMedia?.()) ?? [];
    return media.some((item) => String(item.mime ?? "").startsWith("audio/") && mediaAllowedIn(item, document.id) && !playing.has(item.src ?? `/api/media/${item.id}`));
  }

  // A library file's record (<mediaRoot>/<id>.json) for a layer's src, or null.
  async function mediaRecord(src) {
    const id = mediaIdFromSource(src);
    if (!id || !deps.mediaRoot || !existsSync(path.join(deps.mediaRoot, id))) return null;
    try { return JSON.parse(await readFile(path.join(deps.mediaRoot, `${id}.json`), "utf8")); }
    catch { return null; }
  }

  // {src: file name} for the board's shots' media, as the library lists them.
  async function shotFileNames(board) {
    const names = {};
    for (const shot of board.shots ?? []) {
      if (shot.media === "none" || shot.media in names) continue;
      names[shot.media] = (await mediaRecord(shot.media))?.name ?? null;
    }
    return names;
  }

  // A file's shots (backend/shot-detection.mjs): { shots } or { shots: null, reason }.
  async function fileShots(src, options) {
    if (!deps.mediaShots) return { shots: null, reason: "this kino service has no shot finder" };
    try { return await deps.mediaShots(src, options); }
    catch (error) { return { shots: null, reason: String(error?.message ?? error).split("\n")[0].slice(0, 200) }; }
  }

  // The shots of a scene (sceneShots.js), with a line for each file whose shots are unknown.
  // options.saved: only shots already saved in the media records (no FFmpeg run).
  async function shotsOf(scene, options) {
    const found = new Map();
    for (const layer of scene.layers) {
      if (layer.type === "video" && layer.visible !== false && layer.src && !found.has(layer.src)) found.set(layer.src, await fileShots(layer.src, options));
    }
    const { shots, unknown } = sceneShots(scene, (layer) => found.get(layer.src)?.shots ?? null);
    const unknownLines = [];
    for (const src of new Set(unknown.map((id) => scene.layers.find((layer) => layer.id === id)?.src))) {
      const name = (await mediaRecord(src))?.name ?? String(src).replace(/^\/api\/media\//, "");
      unknownLines.push(`shots in ${name} unknown: ${found.get(src)?.reason ?? "not found"}`);
    }
    return { shots, unknownLines };
  }

  // look {mode:"reference", ref, t?, page?}: the frame strips Inspire kept of a measured reference
  // (backend/measure/strips.mjs): with t, the strip nearest t and its neighbors; else a page of 6.
  // Without ref it lists the project's saved references, one line each, to pick from.
  async function referenceLook(input, projectId) {
    if (!deps.inspire) throw new AgentError("failed", "Inspire is not available here.");
    if (input.ref == null || String(input.ref).trim() === "") {
      const view = await deps.inspire.projectView(projectId);
      const lines = view.saved.map((saved) => view.refs[saved]).filter(Boolean).map((ref) => `${ref.id} ${JSON.stringify(ref.title ?? "")} · ${numbersLine(ref)}`);
      const how = 'look {mode:"reference", ref:"<id>", t?} shows one\'s frame strips';
      return { text: lines.length ? `saved references ${lines.length} (${how}):\n${lines.join("\n")}`
        : `saved references: none in this project. library {topic:"inspire", search:${JSON.stringify(await findSearchFor(projectId))}} finds some; name:"save yt:<id>" saves one, name:"copy <project>" copies another project's.`,
      extra: { saved: view.saved } };
    }
    const id = refId(String(input.ref ?? ""));
    if (!id) throw new AgentError("bad_input", 'reference needs ref: a measured reference from library {topic:"inspire"}, such as yt:dQw4w9WgXcQ.');
    const kept = await deps.inspire.stripsFor(id);
    if (!kept) {
      const ref = await deps.inspire.reference(id);
      if (!ref) throw new AgentError("not_found", `${id} is not in kino's references: library {topic:"inspire", name:"${id}"} adds and measures it.`);
      throw new AgentError("not_ready", `${id} has no frame strips (${ref.state === "measured" ? "measured before kino kept strips" : numbersLine(ref)}). library {topic:"inspire", name:"measure ${id}"} measures it again.`);
    }
    const { sheet } = await import("../measure/strips.mjs").then(({ referenceSheet }) => ({ sheet: referenceSheet }));
    const made = await sheet(kept.folder, kept.strips, { t: Number.isFinite(input.t) ? input.t : null, page: input.page ?? 1 });
    // Studied: the order step and the final render's reference gate count it (brief.mjs orderStep).
    await agentState.update(projectId, (draft) => { draft.studied = [...new Set([...(draft.studied ?? []), id])].slice(-20); });
    const rows = made.shown.map((strip) => `${strip.at}s ${strip.kinds.join("+")}`).join(" · ");
    const where = Number.isFinite(input.t) ? `nearest ${input.t}s` : `page ${Math.min(made.pages, input.page ?? 1)} of ${made.pages}`;
    // A studied edit whose title has the subject's origin word also leads to that footage.
    // (Without an origin word it reads nothing more: no second reference lookup.)
    const { found } = await originFootageFor(projectId);
    const origin = found ? originReferenceLine(found, (await deps.inspire.reference(id).catch(() => null))?.title) : "";
    return { image: { png: made.png }, text: `reference ${id} strips (${where}): ${rows}. Each row: 6 frames 1/12 s apart from 0.25 s before the moment, 240 px wide.\n${REFERENCE_LOOKUP}${origin ? `\n${origin}` : ""}`, extra: { ref: id, strips: made.shown } };
  }

  // look {mode:"source", layer, t?, width?}: the whole source frame of a video layer at scene time
  // t (default the middle of its Play range), with a % grid, the scene's crop on it and the
  // subject boxes (the agent's, from mark_subject, and Apple Vision's on a Mac), beside the result.
  // look {mode:"source", layer:"<an imported video's file name>"}: the whole clip before it is in
  // the video, 12 frames spread over the file (file seconds on each): one sheet, no FFmpeg sheets.
  // times:[…] (file seconds) draws those frames instead, for a video layer too.
  const sourceSrc = (item) => item.src ?? `/api/media/${item.id}`;
  // One line naming a clip's measured events (footage/events.mjs; measured once, kept beside the
  // file): "events (file s): impact 1.5 contact right · light 3.08 from 3 · …".
  async function clipEventsOf(src) {
    const id = mediaIdFromSource(src);
    if (!id || !deps.mediaRoot) return null;
    const record = ((await deps.listMedia?.()) ?? []).find((item) => item.id === id);
    if (!record) return null;
    const measured = await footageCache.video(path.join(deps.mediaRoot, id), { width: record.width, height: record.height, duration: record.duration });
    return Array.isArray(measured.events) ? measured.events : null;
  }
  async function clipEventsLine(src, record) {
    const id = mediaIdFromSource(src);
    if (!id || !deps.mediaRoot) return "events: not measured (not in kino's media folder)";
    let measured;
    try { measured = await footageCache.video(path.join(deps.mediaRoot, id), { width: record.width, height: record.height, duration: record.duration }); }
    catch (error) { return `events: not measured (${String(error?.message ?? error).split("\n")[0].slice(0, 120)})`; }
    if (!Array.isArray(measured.events)) return `events: not measured (${measured.eventsError ?? "unknown"})`;
    const shown = [...measured.events].sort((a, b) => b.confidence - a.confidence).slice(0, 12).sort((a, b) => a.t - b.t);
    const words = shown.map((event) => (event.kind === "impact" ? `impact ${sec(event.t)} ${event.how}${event.dir ? ` ${event.dir}` : ""}${event.frames ? ` ${event.frames}f` : ""}`
      : event.kind === "light" ? `light ${sec(event.t)} from ${sec(event.from)}`
        : `motion ${event.dir} ${sec(event.t)}-${sec(event.to)}`));
    const drawn = measured.drawing ? `drawn on ${measured.drawing.frames}s (${measured.drawing.perSecond} drawings a second)` : null;
    const more = measured.events.length > shown.length ? ` (the ${shown.length} surest of ${measured.events.length})` : "";
    return `events (file s)${more}: ${[...words, ...(drawn ? [drawn] : [])].join(" · ") || "no impacts, light changes or steady motion found"}.`;
  }
  async function clipOverview(input, { fonts }, src = null) {
    if (!src) {
      const wanted = String(input.layer).trim().toLowerCase();
      const bare = (name) => String(name ?? "").toLowerCase().replace(/\.[a-z0-9]+$/, "");
      const media = (await deps.listMedia?.()) ?? [];
      const item = media.find((entry) => [entry.id, entry.src, entry.name].some((value) => String(value ?? "").toLowerCase() === wanted))
        ?? media.find((entry) => bare(entry.name) === bare(wanted));
      src = item ? sourceSrc(item) : null;
    }
    const record = src ? await mediaRecord(src) : null;
    if (!(record?.width > 0 && record?.height > 0 && record?.duration > 0) || record.hasVideo === false || /^(audio|image)\//.test(String(record.mime ?? ""))) return null;
    const asked = Array.isArray(input.times) && input.times.length ? input.times : null;
    if (asked && !asked.every((time) => Number.isFinite(time) && time >= 0)) throw new AgentError("bad_input", "times are file seconds (0 or more).");
    const last = Math.max(0, record.duration - 1 / 30);
    const count = asked ? Math.min(asked.length, 24) : 12;
    const times = asked ? asked.slice(0, 24).map((time) => sec(Math.min(time, last))) : Array.from({ length: count }, (_, index) => sec(((index + 0.5) / count) * record.duration));
    const scene = parseDocument(createDocument({ id: "source-view", name: "source", scenes: [createScene({
      id: "overview", name: "overview", width: record.width, height: record.height, duration: record.duration, background: "#000000",
      layers: [createLayer("video", { id: "source", name: "source", src, x: 0, y: 0, width: record.width, height: record.height,
        mediaStart: 0, mediaOffset: 0, mediaSourceDuration: record.duration, volume: 0 })],
    })] })).scenes[0];
    const image = await look.sheetImage({ scene, fonts, key: sceneKey(scene, fonts) }, { times, labels: times.map((time, index) => `${index + 1} · ${time}s`) });
    const text = asked
      ? `source ${record.name} (${record.width}×${record.height}, ${sec(record.duration)} s): file ${times.join(", ")} s${asked.length > 24 ? " (the first 24)" : ""}.`
      : [`source ${record.name} (${record.width}×${record.height}, ${sec(record.duration)} s): the whole clip in ${count} frames, labeled with file seconds.`,
        await clipEventsLine(src, record),
        `Exact frames: times:[…] (file seconds). For a crop, add it as a layer and look {mode:"source", layer, t}.`].join("\n");
    return { image, text, extra: { file: { src, name: record.name, width: record.width, height: record.height, duration: record.duration }, times } };
  }

  // The lines a video file says (engine/speech.js clipLines), from its saved transcript only: [] for
  // a song, a file with no transcript yet or one with no line. With `make`, whisper reads it first.
  async function savedLinesOf(src, document, most = 3, make = false) {
    const id = mediaIdFromSource(src);
    if (!id || !deps.mediaRoot) return [];
    const file = path.join(deps.mediaRoot, id);
    try {
      if (!existsSync(file) || await isMusicFile(file)) return [];
      const layer = { src };
      // A transcript heard before the brief's names changed still says what the clip says.
      const saved = await transcripts.saved?.(file, document, layer, { any: true });
      return clipLines(saved ?? (make ? await transcripts.get(file, document, layer) : null), { most });
    } catch { return []; }
  }

  // Lines the video's footage says that no layer plays: from saved transcripts only (import, compose,
  // a full check or look source {layer} make them). Null when a footage layer plays speech, when
  // none says a line, or when these lines were already named (state.linesNamed). Otherwise
  // {text, key}: the line to say once, with the call that keeps one. A layer not at speed 1 is only
  // counted (keep_line refuses it). The song alone stays a valid choice: no finding, no next call.
  async function linesToName(document, codes, state) {
    const scene = videoScene(document);
    if (!scene) return null;
    const heardBy = [];
    const slowed = [];
    for (const layer of scene.layers) {
      if ((layer.type !== "video" && layer.type !== "audio") || !layer.src || layer.enabled === false) continue;
      const lines = await savedLinesOf(layer.src, document, 3);
      if (!lines.length) continue;
      // The same predicate as the speech checks (quality.mjs heardSpeech): a layer at volume 0 is not heard.
      if (Number(layer.volume ?? 1) > 0 || (layer.animations ?? []).some((animation) => animation?.to && "volume" in animation.to)) return null;
      const range = mediaPlaybackRange(layer, scene.duration);
      if (!range) continue;
      for (const line of lines) {
        if (line.start < range.offset - 1e-6 || line.end > range.offset + range.duration + 1e-6) continue;
        const at = (file) => Math.round((range.start + file - range.offset) * 10) / 10;
        (isRemapped(layer) ? slowed : heardBy).push({ layer: refName(layer.id, codes), src: layer.src, text: line.text, from: at(line.start), to: at(line.end) });
      }
    }
    if (!heardBy.length && !slowed.length) return null;
    heardBy.sort((a, b) => a.from - b.from);
    const key = createHash("sha256").update(JSON.stringify([...heardBy, ...slowed].map((line) => [line.src, line.text]))).digest("hex").slice(0, 16);
    if (state?.linesNamed === key) return null;
    const total = heardBy.length + slowed.length;
    const shown = heardBy.slice(0, 3).map((line) => `${line.layer} "${line.text.replaceAll('"', "'")}" ${line.from}-${line.to} s`);
    // The song to dip: a music layer that is not one of the clips with lines.
    const talking = new Set([...heardBy, ...slowed].map((line) => line.src));
    const song = scene.layers.find((layer) => !talking.has(layer.src) && isMusicLayer(layer, scene));
    const [first] = heardBy;
    const call = first ? JSON.stringify({ ops: [{ op: "keep_line", layer: first.layer, line: first.text, ...(song ? { duck: refName(song.id, codes) } : {}) }, { op: "isolate_voice", layer: first.layer }] }) : "";
    const keep = first ? ` Keep one under the song: edit ${call}.` : "";
    const text = `lines: your clips say ${total} line${total === 1 ? "" : "s"} and none is heard${shown.length ? `: ${shown.join(" · ")}` : ""}${slowed.length ? `${shown.length ? " " : ": "}+${slowed.length} on slowed layers (keep_line needs speed 1)` : ""}.${keep} The song alone is a choice too.`;
    return { text, key };
  }
  const nameLinesOnce = (projectId, key) => agentState.update(projectId, (draft) => { draft.linesNamed = key; });

  // look {mode:"source"} with no layer: every clip and picture of the project (imported for it or
  // on a layer), 3 to 6 frames each, laid out by clips-sheet.mjs planClips; page:n past one page.
  // The person's own files come first; found clips (footage-finder) follow, one block per video
  // they came from ("F1: 12 shots"), one frame a shot (footage-finder/sheet.mjs groupClips).
  async function clipsOverview(input, { document, codes, fonts, state }) {
    const used = new Map();
    for (const scene of document.scenes) for (const layer of scene.layers) {
      if (!["video", "image"].includes(layer.type) || typeof layer.src !== "string") continue;
      used.set(layer.src, [...(used.get(layer.src) ?? []), refName(layer.id, codes)]);
    }
    const media = ((await deps.listMedia?.().catch(() => [])) ?? []).filter((item) => /^(video|image)\//.test(String(item.mime ?? ""))
      && (mediaAllowedIn(item, document.id) || used.has(sourceSrc(item))));
    const clips = [];
    for (const item of media) {
      const record = await mediaRecord(sourceSrc(item));
      if (!(record?.width > 0 && record?.height > 0)) continue;
      const video = /^video\//.test(String(record.mime ?? item.mime)) && record.hasVideo !== false && record.duration > 0;
      // The person's own clips come first (groupClips), then found clips grouped by video.
      clips.push({ src: sourceSrc(item), name: record.name ?? item.name, record, video, layers: used.get(sourceSrc(item)) ?? [], tag: foundClipTag(item, state?.footage) });
    }
    if (!clips.length) throw new AgentError("not_found", 'No clips or pictures in this project yet: project {action:"import", file} brings one in.');
    clips.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    const entries = groupClips(clips);
    const own = entries.filter((entry) => !entry.group).length;
    const middle = (clip) => (clip.video ? sec(clip.record.duration / 2) : 0);
    const { blocks, pages } = planClips(entries.map((entry) => {
      const [clip] = entry.clips;
      return { width: clip.record.width, height: clip.record.height, duration: clip.video ? clip.record.duration : 0,
        ...(entry.group ? { times: entry.clips.slice(0, GROUP_TILES_MOST).map(middle) } : {}) };
    }));
    const pageNumber = Math.min(pages.length, Math.max(1, Math.round(Number(input.page) || 1)));
    const page = pages[pageNumber - 1];
    const clipScene = (clip) => parseDocument(createDocument({ id: "source-view", name: "source", scenes: [createScene({
      id: "clip", name: "clip", width: clip.record.width, height: clip.record.height, duration: clip.video ? clip.record.duration : 1, background: "#000000",
      layers: [clip.video
        ? createLayer("video", { id: "source", name: "source", src: clip.src, x: 0, y: 0, width: clip.record.width, height: clip.record.height, mediaStart: 0, mediaOffset: 0, mediaSourceDuration: clip.record.duration, volume: 0 })
        : createLayer("image", { id: "source", name: "source", src: clip.src, x: 0, y: 0, width: clip.record.width, height: clip.record.height })],
    })] })).scenes[0];
    const layersOf = (list) => [...new Set(list.flatMap((clip) => clip.layers))];
    const drawn = [];
    for (const place of page.places) {
      const entry = entries[place.index];
      const times = blocks[place.index].times;
      if (entry.group) {
        // One frame a found shot, from the middle of its clip.
        const tiles = [];
        for (const [index, clip] of entry.clips.slice(0, GROUP_TILES_MOST).entries()) {
          const scene = clipScene(clip);
          const [frame] = await look.frames({ scene, fonts, key: sceneKey(scene, fonts) }, [times[index]], place.tile.width);
          tiles.push({ png: frame.png, label: clip.tag.label });
        }
        const layers = layersOf(entry.clips);
        drawn[place.index] = { header: `${entry.group}: ${entry.clips.length} shot${entry.clips.length === 1 ? "" : "s"}${layers.length ? ` · ${layers.join(", ")}` : ""}`, tiles };
        continue;
      }
      const [clip] = entry.clips;
      const { record } = clip;
      const scene = clipScene(clip);
      const frames = await look.frames({ scene, fonts, key: sceneKey(scene, fonts) }, times, place.tile.width);
      drawn[place.index] = {
        header: `${place.index + 1} ${clip.name}${clip.video ? ` · ${sec(record.duration)} s` : ""}${clip.layers.length ? ` · ${clip.layers.join(", ")}` : ""}`,
        tiles: frames.map((frame, index) => ({ png: frame.png, label: clip.video ? `${times[index]}s` : "picture" })),
      };
    }
    const png = await look.clipsImage(page, drawn);
    const first = page.places[0].index + 1, last = page.places.at(-1).index + 1;
    const found = entries.filter((entry) => entry.group);
    const foundCount = found.reduce((sum, entry) => sum + entry.clips.length, 0);
    const counted = [`${own} file${own === 1 ? "" : "s"}`, ...(found.length ? [`${foundCount} found clip${foundCount === 1 ? "" : "s"} from ${found.length} video${found.length === 1 ? "" : "s"}`] : [])].join(", ");
    const lines = [`source: ${counted}${pages.length > 1 ? `, page ${pageNumber} of ${pages.length} (${first}–${last}; page:n for the rest)` : ""}. Each block: number, file, length, layers; frames labeled with file seconds${found.length ? "; found clips: one frame a shot, by shot code" : ""}.`,
      ...entries.map((entry, index) => {
        if (entry.group) {
          const layers = layersOf(entry.clips);
          return `${groupLine(entry)}${layers.length ? ` · ${layers.join(", ")}` : ""}`;
        }
        const [clip] = entry.clips;
        return `${index + 1} ${clip.name} ${clip.record.width}×${clip.record.height}${clip.video ? ` ${sec(clip.record.duration)} s` : " picture"}${clip.layers.length ? ` · ${clip.layers.join(", ")}` : ""}`;
      }),
      `Exact frames of one: look {mode:"source", layer:"<file name>", times:[…]} (file seconds).`];
    // The lines the clips say, from saved transcripts only (look source {layer} or compose made them).
    const heard = [];
    for (const clip of clips.filter((each) => each.video)) {
      for (const line of await savedLinesOf(clip.src, document, 1)) heard.push({ clip: clip.tag?.label ?? clip.name, ...line });
    }
    heard.sort((a, b) => (a.end - a.start) - (b.end - b.start));
    const heardShown = heard.slice(0, 4);
    if (heardShown.length) lines.splice(lines.length - 1, 0, `heard (shortest first): ${heardShown.map((entry) => `${entry.clip} "${entry.text.replaceAll('"', "'")}" ${entry.start.toFixed(1)}-${entry.end.toFixed(1)} s`).join(" · ")}`);
    const clipFacts = (clip) => ({ src: clip.src, name: clip.name, ...(clip.video ? { duration: clip.record.duration } : {}), layers: clip.layers });
    return { image: { png }, text: lines.join("\n"), extra: {
      ...(heardShown.length ? { heard: heardShown } : {}),
      clips: entries.map((entry, index) => (entry.group
        ? { group: entry.group, shots: entry.clips.map((clip) => ({ code: clip.tag.label, ...clipFacts(clip) })) }
        : { n: index + 1, ...clipFacts(entry.clips[0]) })),
      page: pageNumber, pages: pages.length } };
  }

  // look {mode:"source", ref:"F1"}: a scanned found video's saved shot sheet, labeled F1.<shot>.
  async function footageSheetLook(input, state) {
    if (!deps.footage) throw new AgentError("failed", "The footage finder is not available here.");
    let shown;
    try { shown = await footageSheet(input.ref, { footage: state?.footage ?? null, finder: deps.footage }); }
    catch (error) {
      if (!(error instanceof FootageError)) throw error;
      throw Object.assign(new AgentError(error.code, error.message), error.nextCall ? { nextCall: error.nextCall } : {});
    }
    const image = shown.tiles ? await look.tilesImage(shown.tiles, { tile: shown.tile, columns: shown.columns }) : {};
    return { image, text: shown.text, extra: shown.data, nextCall: shown.nextCall };
  }

  async function sourceLook(input, { document, codes, resolver, fonts, state: agentFacts }) {
    if ((input.layer == null || input.layer === "") && input.ref != null && String(input.ref).trim() !== "") return footageSheetLook(input, agentFacts);
    if (input.layer == null || input.layer === "") return clipsOverview(input, { document, codes, fonts, state: agentFacts });
    let layerId;
    try { layerId = resolver.resolve(String(input.layer), "layer"); } catch (error) {
      const overview = await clipOverview(input, { fonts });
      if (overview) return overview;
      throw error;
    }
    const layerScene = document.scenes.find((item) => item.layers.some((layer) => layer.id === layerId));
    const layer = layerScene.layers.find((item) => item.id === layerId);
    const name = refName(layerId, codes);
    if (layer.type === "video" && Array.isArray(input.times) && input.times.length) {
      const frames = await clipOverview(input, { fonts }, layer.src);
      if (frames) return frames;
    }
    if (layer.type !== "video") throw new AgentError("bad_input", `source needs a video layer; ${name} is ${/^[aeiou]/.test(layer.type) ? "an" : "a"} ${layer.type} layer (zoom shows any layer).`);
    const record = await mediaRecord(layer.src);
    if (!(record?.width > 0 && record?.height > 0)) throw new AgentError("not_found", `${name}'s file is not in kino's media library; import it with project {action:"import", file}.`);
    const range = mediaPlaybackRange(layer, layerScene.duration);
    const t = clampTime(input.t ?? sec(range ? (range.start + range.end) / 2 : layerScene.duration / 2), layerScene);
    const asked = Number(input.width ?? SOURCE_EDGE);
    const edge = Math.round(Math.min(SOURCE_EDGE_RANGE[1], Math.max(SOURCE_EDGE_RANGE[0], Number.isFinite(asked) ? asked : SOURCE_EDGE)));
    const long = Math.max(record.width, record.height);
    const panel = { width: Math.max(2, Math.round((record.width * edge) / long)), height: Math.max(2, Math.round((record.height * edge) / long)) };
    const state = mediaFrameState(layer, t);
    const fileTime = Number(state.sourceTime.toFixed(3));
    const onScreen = state.visible && layer.visible !== false;

    // The file's shot at that moment, numbered as look sheet numbers the scene's shots (a trimmed
    // clip's first shot in the scene may be its file's second); the file's own number when not.
    const found = await fileShots(layer.src);
    const index = found.shots ? found.shots.findIndex((item, at) => fileTime < item.end || at === found.shots.length - 1) : -1;
    const fileShot = index >= 0 ? found.shots[index] : null;
    const result = await prepare(document, layerScene.id, fonts);
    let shot = null;
    if (fileShot) {
      const inScene = (await shotsOf(result.scene)).shots;
      const at = inScene.findIndex((item, place) => t < item.end || place === inScene.length - 1);
      shot = { n: at + 1, of: inScene.length, file: [fileShot.start, fileShot.end], scene: [inScene[at].start, inScene[at].end],
        ...(at !== index ? { fileShot: { n: index + 1, of: found.shots.length } } : {}) };
    }

    const crop = cropOnSource(layerScene, layer, t, record);
    if (!crop) throw new AgentError("bad_input", `${name} has no size at ${t}s, so it shows no part of its file.`);
    const marked = layer.subjectBoxes;
    const onThisFile = marked?.src === layer.src ? marked.boxes : [];
    const agentBoxes = boxesAt(layer, fileTime);
    const percent = (share) => Math.round(share * 100);
    const span = ([from, to]) => `${sec(from)}–${sec(to)}`;

    // The source frame: the file alone in a scene its own size, at that moment.
    const sourceScene = parseDocument(createDocument({ id: "source-view", name: "source", scenes: [createScene({
      id: "source", name: "source", width: record.width, height: record.height, duration: 1, background: "#000000",
      layers: [createLayer("video", { id: "source", name: "source", src: layer.src, x: 0, y: 0, width: record.width, height: record.height,
        mediaStart: 0, mediaOffset: fileTime, mediaSourceDuration: layer.mediaSourceDuration || record.duration || 0, volume: 0 })],
    })] })).scenes[0];
    const header = `${name} · file ${sec(fileTime)} s · ${shot ? `shot ${shot.n} of ${shot.of}` : "shot unknown"}`;
    const image = await look.sourceImage({ scene: sourceScene, fonts, key: sceneKey(sourceScene, fonts) }, result, {
      time: t, panel, header, quad: crop.quad, caption: `result ${layerScene.width}×${layerScene.height} @${t}s`,
      boxes: agentBoxes.map((entry) => ({ by: "agent", box: entry.box })),
      vision: (picture) => visionBoxes(picture).catch((error) => ({ skipped: `Apple Vision failed: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}` })),
    });

    const boxes = [...agentBoxes.map((entry) => ({ by: "agent", at: entry.at, box: entry.box })), ...(image.vision?.boxes ?? []).map((entry) => ({ by: "vision", at: fileTime, box: entry.box }))]
      .map((entry) => ({ ...entry, inside: Number(insideShare(entry.box, crop.bounds).toFixed(2)) }));
    const listed = (entries) => entries.map((entry) => `${entry.by} [${entry.box.join(", ")}] ${percent(entry.inside)}% in the crop`).join(", ");
    let agentText;
    if (agentBoxes.length) agentText = listed(boxes.filter((entry) => entry.by === "agent"));
    else if (marked && marked.src !== layer.src) agentText = `${marked.boxes.length} marked on another file (before replace_media): mark again`;
    else {
      const inShot = fileShot ? onThisFile.filter((entry) => entry.at >= fileShot.start - 1e-6 && entry.at <= fileShot.end + 1e-6) : [];
      const times = (entries) => `${entries.slice(0, 6).map((entry) => sec(entry.at)).join(", ")}${entries.length > 6 ? ", …" : ""} s`;
      agentText = inShot.length ? `none at this frame (marked in this shot at file ${times(inShot)})`
        : onThisFile.length ? `none at this frame (marked at file ${times(onThisFile)})` : "none marked yet";
    }
    const vision = image.vision?.skipped ? { skipped: image.vision.skipped } : { boxes: image.vision?.boxes ?? [] };
    const visionText = vision.skipped ? `vision: skipped (${vision.skipped})`
      : vision.boxes.length ? listed(boxes.filter((entry) => entry.by === "vision")) : "vision: no subject found";
    const [x0, y0, x1, y1] = crop.bounds.map(Math.round);
    const lines = [
      `source ${name} @${t}s${onScreen ? "" : ` (not on screen at ${t} s)`}: file ${sec(fileTime)} s of ${record.name} (${record.width}×${record.height}), ${shot
        ? `shot ${shot.n} of ${shot.of} (file ${span(shot.file)} s, scene ${span(shot.scene)} s${shot.fileShot ? `; the file's shot ${shot.fileShot.n} of ${shot.fileShot.of}` : ""})` : `shot unknown (${found.reason})`}`,
      `crop: x ${x0}–${x1}%, y ${y0}–${y1}% of the source (dashed${crop.covers < 0.99 ? `; the clip covers ${percent(crop.covers)}% of the frame` : ""}); the result is on the right`,
      `boxes: ${agentText} · ${visionText}`,
    ];
    // What this file says (read once if needed; a song says none), and that the layer does not play it.
    const said = await savedLinesOf(layer.src, document, 3, true);
    if (said.length) lines.push(`${clipLinesText(said, 3).replace(/^heard /, "heard: ")} (file s)${Number(layer.volume ?? 1) === 0 ? " (muted here)" : ""}`);
    if (!agentBoxes.length) lines.push(`mark the subject: edit mark_subject {layer:"${name}", t:${t}, box:[x, y, w, h]} (% of the source; x, y top-left)`);
    const extra = {
      ...(said.length ? { heard: said } : {}),
      layer: name, t, file: { src: layer.src, name: record.name, width: record.width, height: record.height, time: fileTime },
      shot, crop: crop.bounds, covers: crop.covers, boxes, vision,
    };
    return { image, text: lines.join("\n"), extra };
  }

  function clampTime(value, scene) {
    const time = Number(value);
    if (!Number.isFinite(time) || time < 0) throw new AgentError("bad_input", "t is seconds from the start of the scene (0 or more).");
    return sec(Math.min(time, scene.duration));
  }

  // Sheet times from `from` to `to` (seconds; default the start and the end of the scene), spread
  // as sheetTimes spreads them over a whole scene: never exactly at its end.
  function sheetStretch(input, scene) {
    const { from, to } = stretchBounds(input, scene);
    const last = to >= scene.duration ? Math.max(from, scene.duration - Math.min(0.05, scene.duration / 100)) : to;
    return evenTimes(from, last, SHEET_FRAMES);
  }

  // from and to of a sheet (seconds; default the start and the end of the scene).
  function stretchBounds(input, scene) {
    const bound = (key, fallback) => {
      if (input[key] == null) return fallback;
      const value = Number(input[key]);
      if (!Number.isFinite(value) || value < 0) throw new AgentError("bad_input", `${key} is seconds from the start of the scene (0 or more).`);
      return Math.min(value, scene.duration);
    };
    const from = bound("from", 0);
    const to = bound("to", scene.duration);
    if (to <= from) throw new AgentError("bad_input", `from must be before to, inside the scene (0–${scene.duration}s).`);
    return { from, to };
  }

  // ---- history ----------------------------------------------------------------------------
  async function history(input, meta) {
    const record = await projectFor(input);
    const projectId = record.document.id;
    const action = input.action ?? "list";
    const codes = await syncCodes(projectId, record.document);
    if (action === "list") {
      const state = await agentState.read(projectId);
      const turns = state.turns.slice(-10);
      const lines = [`rev ${record.revision} · ${plural(state.turns.length, "turn")}${state.turns.length > 10 ? " (last 10)" : ""}`];
      for (const turn of turns) {
        const first = turn.edits[0]?.before, last = turn.edits.at(-1)?.after;
        const keep = first ? Boolean(await store.getProjectRevision(projectId, first)) : false;
        lines.push(`  ${turn.id} ${turn.startedAt.slice(11, 16)} ${plural(turn.calls, "call")}${turn.edits.length ? ` · ${plural(turn.edits.length, "edit")} rev ${first}→${last}${keep ? "" : " (too old to revert)"}` : " · no edits"}${turn.reverted ? ` · reverted at rev ${turn.reverted.rev}` : ""}`);
      }
      lines.push("history {action:\"revert\", turn} undoes a turn; {action:\"restore\", rev} brings back a saved version.");
      // The run's facts too: minutes and kino calls per step (step-log.mjs), with this call counted.
      const log = await stepLogNow(projectId);
      lines.push(...stepsTable(log));
      return done(projectId, { text: lines.join("\n"), data: { rev: record.revision, turns, ...(log ? { steps: stepRows(log) } : {}) } });
    }
    if (action === "revert") {
      const state = await agentState.read(projectId);
      const turn = input.turn ? state.turns.find((entry) => entry.id.toLowerCase() === String(input.turn).toLowerCase())
        : [...state.turns].reverse().find((entry) => entry.edits.length && !entry.reverted);
      if (!turn) throw new AgentError("not_found", input.turn ? `No turn ${input.turn}.` : "No turn with edits to revert.", { didYouMean: input.turn ? closest(String(input.turn), state.turns.map((entry) => entry.id)) : [] });
      if (!turn.edits.length) throw new AgentError("bad_input", `${turn.id} made no edits.`);
      if (turn.reverted) throw new AgentError("bad_input", `${turn.id} was already reverted (rev ${turn.reverted.rev}).`);
      const firstBefore = turn.edits[0].before, lastAfter = turn.edits.at(-1).after;
      const [beforeTurn, afterTurn] = await Promise.all([store.getProjectRevision(projectId, firstBefore), store.getProjectRevision(projectId, lastAfter)]);
      if (!beforeTurn || !afterTurn) throw new AgentError("too_old", `${turn.id} is older than the 50 kept versions, so it cannot be reverted. history {action:"restore", rev} brings back a kept version.`);
      // Undo only this turn: later edits (yours or the agent's) stay.
      const merged = record.revision === lastAfter ? { document: beforeTurn, conflicts: [] } : mergeDocuments(afterTurn, beforeTurn, record.document);
      const document = parseDocument(merged.document);
      const updated = await saveDocument(projectId, record.document, document, record.revision, { actor: meta.by === "you" ? "you" : "agent", resultMetadata: { revert: turn.id } });
      const changes = changedSince(record.document, updated.document, { byId: { ...codes.byId, ...assignCodes(codes, updated.document).byId } });
      const board = await settleBoardAfter(projectId, record.document, updated);
      const answer = { reverted: turn.id, rev: updated.revision, changed: changes, ...(board ? { board } : {}) };
      return done(projectId, { text: compact({ ...answer, conflicts: merged.conflicts?.length ?? 0 }), data: answer }, { shared: true, change(draft) {
        const stored = draft.turns.find((entry) => entry.id === turn.id);
        if (stored) stored.reverted = { at: new Date(now()).toISOString(), rev: updated.revision, by: meta.by === "you" ? "you" : "agent" };
        draft.turnBreak = true;
        if (meta.by === "you") draft.inbox.push({ kind: "revert", text: `you reverted ${turn.id} (rev ${firstBefore}→${lastAfter}); now rev ${updated.revision}` });
      } });
    }
    if (action === "restore") {
      if (!Number.isSafeInteger(input.rev)) throw new AgentError("bad_input", "restore needs rev.");
      const old = await store.getProjectRevision(projectId, input.rev);
      if (!old) throw new AgentError("too_old", `rev ${input.rev} is no longer kept (the last 50 versions are).`);
      const updated = await saveDocument(projectId, record.document, parseDocument(old), record.revision, { actor: meta.by === "you" ? "you" : "agent", resultMetadata: { restored: input.rev } });
      const changes = changedSince(record.document, updated.document, { byId: { ...codes.byId, ...assignCodes(codes, updated.document).byId } });
      const board = await settleBoardAfter(projectId, record.document, updated);
      const answer = { restored: input.rev, rev: updated.revision, changed: changes, ...(board ? { board } : {}) };
      return done(projectId, { text: compact(answer), data: answer }, { shared: true, change(draft) {
        draft.turnBreak = true;
        if (meta.by === "you") draft.inbox.push({ kind: "restore", text: `you restored rev ${input.rev}; now rev ${updated.revision}` });
      } });
    }
    // undo is revert: it undoes one turn.
    const undo = ["undo", "rollback", "back"].includes(String(action).toLowerCase()) ? ' history {action:"revert", turn:"T3"} undoes one turn (history lists them).' : "";
    throw new AgentError("bad_input", `Unknown history action "${action}".${undo}`, { didYouMean: closest(action, ["list", "revert", "restore"]) });
  }

  // notes {action:"judge", videos:[[a, b]], audio?|picture?}: an agent queues video pairs for the person's
  // blind picks (picks.mjs); the dashboard sends each pick as {action:"judge", pair_id, pick, words?, note?}.
  async function notesPicks(input, meta) {
    try {
      if (input.pair_id !== undefined) {
        // The app's own call (dashboard act) is the only one marked reviewed: an agent's by:"you" is not enough.
        if (meta.by !== "you" || !meta.reviewed) throw new Error("Only the person picks, in the app: the pairs are blind.");
        const record = await picks.pick({ pair_id: String(input.pair_id), side: input.pick, words: input.words ?? [], note: input.note ?? "" });
        // The answer names no file and no side, so the app's log stays blind too.
        return { project: null, text: `${record.pair_id} saved`, data: { pair_id: record.pair_id } };
      }
      const { added, queued } = await picks.queue(input.videos, { audio: input.audio === true, picture: input.picture === true });
      return { project: null, text: `queued ${added.length ? added.join(", ") : "nothing new"} · ${queued} waiting: the person picks blind in the app, ${SITTING_PICKS} a sitting; picks go to ${picks.picksFile}.`,
        data: { added, queued, file: picks.picksFile } };
    } catch (error) { throw new AgentError("bad_input", error.message); }
  }

  // ---- notes and the plan -----------------------------------------------------------------
  async function notes(input, meta) {
    if (input.action === "judge" && (input.videos !== undefined || input.pair_id !== undefined)) return notesPicks(input, meta);
    const record = await projectFor(input);
    const projectId = record.document.id;
    // plan_done {done:[n]} or {step:n}, and plan {steps} or {done}, are set_plan; get is list.
    if (input.action === "plan_done" || (input.action === "plan" && (input.steps !== undefined || input.done !== undefined || input.step !== undefined)))
      input = { ...input, action: "set_plan", ...(input.done === undefined && input.steps === undefined && Number.isInteger(input.step) ? { done: [input.step] } : {}) };
    if (input.action === "get") input = { ...input, action: "list" };
    const action = input.action ?? "list";
    const codes = await syncCodes(projectId, record.document);
    const resolver = createResolver(record.document, codes);
    const describe = (note) => `${note.id} ${note.status}${note.always ? " always" : ""}${note.time != null ? ` @${note.time}` : ""}${note.layerId ? ` ${refName(note.layerId, codes)}` : ""} "${note.text}"${note.replies.length ? ` · reply: "${note.replies.at(-1).text}"` : ""}`;

    if (action === "brief") return notesBrief(projectId, input, meta, await directionFacts(record.document), record.document);
    if (action === "deck") return notesDeck(projectId, record.document, input);
    if (action === "intents") return notesIntents(record, input, codes);
    if (action === "viewer") return notesViewer(record, input, codes);
    if (action === "critique") return notesCritique(record, input, codes);
    if (action === "verdict") return notesVerdict(record, input, meta);
    if (action === "needs") return notesNeeds(record, input, meta, resolver, codes);
    if (action === "checkpoint" || action === "answer") return notesStop(projectId, input, meta);
    if (action === "set_plan") {
      // done:[2] (or done:2) marks steps of the saved plan done by number, without sending the list again.
      // step:"brief" (plan_done {step}) is the one saved step whose text holds that word.
      if (input.done === undefined && input.steps === undefined && typeof input.step === "string") {
        const saved = (await agentState.read(projectId)).plan?.steps ?? [];
        const found = saved.map((entry, index) => (entry.text.toLowerCase().includes(input.step.trim().toLowerCase()) ? index + 1 : 0)).filter(Boolean);
        if (found.length !== 1) throw new AgentError("bad_input", `step "${input.step}" ${found.length ? "matches several steps" : "is not a step of the plan"}: tick one by number, notes {action:"set_plan", done:[1]}.`);
        input = { ...input, done: found };
      }
      const marked = input.done === undefined ? null : [input.done].flat();
      const saved = marked && input.steps === undefined ? (await agentState.read(projectId)).plan?.steps : null;
      if (marked && input.steps === undefined && !saved?.length) throw new AgentError("bad_input", 'There is no plan yet: send notes {action:"set_plan", steps:["Build the scene", "Check", "Render"]} first.');
      const checkMarked = (count) => {
        if (marked.some((number) => !Number.isInteger(number) || number < 1 || number > count))
          throw new AgentError("bad_input", `done lists step numbers from 1 to ${count}, such as notes {action:"set_plan", done:[1]}.`);
      };
      if (saved) checkMarked(saved.length);
      // "build, check, render" is a list of three steps.
      const steps = saved ? saved.map((step, index) => ({ text: step.text, done: step.done || marked.includes(index + 1) }))
        : Array.isArray(input.steps) ? input.steps
        : typeof input.steps === "string" ? input.steps.split(/[\n,;]+/).map((step) => step.trim()).filter(Boolean) : [];
      if (!steps.length || steps.length > 12) throw new AgentError("bad_input", 'steps lists 1 to 12 steps: strings, or {text, done}, such as notes {action:"set_plan", steps:["Build the scene", "Check", "Render"]}.');
      const plan = steps.map((step) => (typeof step === "string" ? { text: step.slice(0, 120), done: false } : { text: String(step?.text ?? "").slice(0, 120), done: step?.done === true }));
      if (plan.some((step) => !step.text)) throw new AgentError("bad_input", "Every step needs text.");
      if (marked && !saved) { checkMarked(plan.length); marked.forEach((number) => { plan[number - 1].done = true; }); }
      const finished = plan.filter((step) => step.done).length;
      const next = plan.find((step) => !step.done);
      return done(projectId, { text: `plan saved: ${finished}/${plan.length} done${next ? ` · now: ${next.text}` : ""}`, data: { plan } },
        { shared: true, change(draft) { draft.plan = { steps: plan, updatedAt: new Date(now()).toISOString() }; } });
    }
    if (action === "add") {
      // A note from you to the agent (the command line or, later, the dashboard).
      const text = String(input.text ?? "").trim();
      if (!text || text.length > 2000) throw new AgentError("bad_input", "A note needs text (at most 2000 characters).");
      const layerId = input.layer ? resolver.resolve(String(input.layer), "layer") : null;
      const time = input.t == null ? null : sec(Number(input.t));
      // From the dashboard: the scene, an area of it in scene pixels, and an urgent flag.
      const sceneId = input.scene ? sceneFor(record.document, codes, input.scene).id : null;
      const area = noteArea(input.area);
      const urgent = input.urgent === true;
      const where = `${urgent ? " URGENT" : ""}${sceneId && record.document.scenes.length > 1 ? ` ${refName(sceneId, codes)}` : ""}${time != null ? ` @${time}` : ""}${layerId ? ` ${refName(layerId, codes)}` : ""}${area ? ` area ${area.x},${area.y} ${area.width}×${area.height}` : ""}`;
      const result = await agentState.update(projectId, (state) => {
        const note = { id: `N${state.nextNote++}`, text, layerId, time, from: "you", status: "new", replies: [], createdAt: new Date(now()).toISOString(),
          ...(sceneId ? { sceneId } : {}), ...(area ? { area } : {}), ...(urgent ? { urgent } : {}) };
        state.notes.push(note);
        state.turnBreak = true;
        state.inbox.push({ kind: "note", noteId: note.id, text: `${note.id} note${where} "${text}"${replyHint(note.id)}` });
        return note;
      });
      await deps.emit?.(projectId, { kind: "note", note: result });
      // Your note may start an agent when your rules allow it and none works here (crew.mjs).
      const started = meta.by === "you" ? await deps.crew?.noteAdded(projectId, result).catch(() => null) : null;
      return { project: projectId, text: `${result.id} saved; ${started ? `${started.name} (${started.id}) started to work on it.` : "the agent gets it with its next call."}`,
        data: { note: result, ...(started ? { started: started.id } : {}) } };
    }
    if (action === "helper" || action === "release") return notesCrew(projectId, input, meta, action);
    if (action === "judge") return notesJudge(record, input, meta);
    if (action === "try") return notesTry(record, input, meta);
    if (action === "list") {
      const state = await agentState.read(projectId);
      const open = state.notes.filter((note) => note.status !== "resolved");
      const lines = [`${plural(open.length, "open note")}${state.notes.length > open.length ? ` · ${state.notes.length - open.length} resolved` : ""}`, ...open.slice(-20).map(describe)];
      return done(projectId, { text: lines.join("\n"), data: { notes: open } });
    }
    if (["reopen", "always", "keep", "stopped"].includes(action)) return notesAlways(projectId, input, meta, action, resolver, codes, record.document);
    if (action === "reply" || action === "resolve") {
      if (!input.id) throw new AgentError("bad_input", `${action} needs id (such as N2).`);
      const outcome = await agentState.update(projectId, (state) => {
        const note = state.notes.find((entry) => entry.id.toLowerCase() === String(input.id).toLowerCase());
        if (!note) return { missing: closest(String(input.id), state.notes.map((entry) => entry.id)) };
        if (input.text) note.replies.push({ from: meta.by === "you" ? "you" : "agent", text: String(input.text).slice(0, 2000), at: new Date(now()).toISOString() });
        if (action === "resolve") {
          note.status = "resolved";
          // You closing a note ends it, also one that held for the whole video.
          if (meta.by === "you") { delete note.always; delete note.keep; }
        }
        else if (note.status !== "resolved") note.status = "addressed";
        return { note: structuredClone(note) };
      });
      if (outcome.missing) throw new AgentError("not_found", `No note ${input.id}.`, { didYouMean: outcome.missing });
      if (action === "reply" && !input.text) throw new AgentError("bad_input", "reply needs text.");
      await deps.emit?.(projectId, { kind: "note", note: outcome.note });
      return done(projectId, { text: describe(outcome.note), data: { note: outcome.note } });
    }
    throw new AgentError("bad_input", `Unknown notes action "${action}".`, { didYouMean: closest(action, NOTES_ACTIONS) });
  }

  // The person's notes that hold for the whole video, and the edits they stopped:
  // - reopen {id, text?} (you): "not fixed yet", the note is new again.
  // - always {id, on} (you): the note holds for the whole video (note.always).
  // - keep {id, layers} (agent): links layers to an always note; an agent edit that would remove
  //   one is refused (keptLayersCheck) and waits in state.stopped for the person.
  // - stopped {id:"S1", answer:"keep"|"let"} (you): answers a stopped edit.
  async function notesAlways(projectId, input, meta, action, resolver, codes, document) {
    const you = meta.by === "you";
    if (action !== "keep" && !you) throw new AgentError("bad_input", `Only the person can ${action === "stopped" ? "answer a stopped edit" : `${action} a note`} (in the kino app).`);
    if (action === "keep" && you) throw new AgentError("bad_input", "The agent links the layers an always note keeps.");
    if (!input.id) throw new AgentError("bad_input", `${action} needs id (such as ${action === "stopped" ? "S1" : "N2"}).`);
    const id = String(input.id).toUpperCase();
    const at = new Date(now()).toISOString();
    if (action === "stopped") {
      if (!["keep", "let"].includes(input.answer)) throw new AgentError("bad_input", 'answer is "keep" or "let".');
      const outcome = await agentState.update(projectId, (state) => {
        const item = (state.stopped ?? []).find((entry) => entry.id === id);
        if (!item) return { missing: closest(id, (state.stopped ?? []).map((entry) => entry.id)) };
        state.stopped = state.stopped.filter((entry) => entry !== item);
        const names = keptNames(item.layers, document, codes);
        const note = state.notes.find((entry) => entry.id === item.noteId);
        if (input.answer === "let" && note?.keep) note.keep = note.keep.filter((layerId) => !item.layers.includes(layerId));
        state.turnBreak = true;
        state.inbox.push({ kind: "stopped", text: input.answer === "keep" ? `you asked to keep ${names}: leave them` : `the person let you remove ${names}: send the edit again` });
        return { item, stopped: structuredClone(state.stopped), note: note ? structuredClone(note) : null };
      });
      if (outcome.missing) throw new AgentError("not_found", `No stopped edit ${input.id}.`, { didYouMean: outcome.missing });
      await deps.emit?.(projectId, { kind: "stopped", stopped: outcome.stopped });
      if (outcome.note) await deps.emit?.(projectId, { kind: "note", note: outcome.note });
      return done(projectId, { text: `${outcome.item.id} ${input.answer === "keep" ? "kept" : "let go"}`, data: { stopped: outcome.stopped } });
    }
    if (action === "always" && typeof input.on !== "boolean") throw new AgentError("bad_input", "always needs on: true or false.");
    const layers = action === "keep" ? [input.layers ?? input.layer].flat().filter((entry) => entry != null && entry !== "") : [];
    if (action === "keep" && !layers.length) throw new AgentError("bad_input", 'keep needs layers, such as notes {action:"keep", id:"N2", layers:["logo"]}.');
    const layerIds = layers.map((entry) => resolver.resolve(String(entry), "layer"));
    const outcome = await agentState.update(projectId, (state) => {
      const note = state.notes.find((entry) => entry.id.toUpperCase() === id);
      if (!note) return { missing: closest(id, state.notes.map((entry) => entry.id)) };
      if (action === "keep") {
        if (!note.always) return { notAlways: true };
        note.keep = [...new Set([...(note.keep ?? []), ...layerIds])];
      } else if (action === "always") {
        if (input.on) note.always = true;
        else delete note.always;
        state.turnBreak = true;
        state.inbox.push({ kind: "note", text: input.on
          ? `${note.id} "${note.text}" now holds for the whole video. Link layers to keep: notes {action:"keep", id:"${note.id}", layers:["L2"]}`
          : `${note.id} "${note.text}" no longer holds for the whole video` });
      } else {
        note.status = "new";
        const text = String(input.text ?? "").trim().slice(0, 2000);
        if (text) note.replies.push({ from: "you", text, at });
        state.turnBreak = true;
        state.inbox.push({ kind: "note", noteId: note.id, text: `${note.id} not fixed yet${text ? `: ${text}` : ""}${replyHint(note.id)}` });
      }
      return { note: structuredClone(note) };
    });
    if (outcome.missing) throw new AgentError("not_found", `No note ${input.id}.`, { didYouMean: outcome.missing });
    if (outcome.notAlways) throw new AgentError("bad_input", `${id} does not hold for the whole video: only the person turns "always" on.`);
    await deps.emit?.(projectId, { kind: "note", note: outcome.note });
    // A note sent back may start an agent, like a new one (crew.mjs).
    if (action === "reopen") await deps.crew?.noteAdded(projectId, outcome.note).catch(() => null);
    const note = outcome.note;
    const text = action === "keep" ? `${note.id} keeps ${keptNames(note.keep, document, codes)}`
      : action === "always" ? `${note.id} ${note.always ? "holds for the whole video" : "is a one-time note again"}`
      : `${note.id} is new again`;
    return done(projectId, { text, data: { note } });
  }

  // Before an agent edit is saved: the layers it removes that an always note keeps. Refuses the
  // edit (code "kept", nothing saved) and records a stopped item the person answers in the app.
  async function keptLayersCheck(projectId, before, after, codes, { dryRun }) {
    if (byYou()) return;
    const state = await agentState.read(projectId);
    const kept = state.notes.filter((note) => note.always && note.keep?.length);
    if (!kept.length) return;
    const left = new Set(after.scenes.flatMap((scene) => scene.layers.map((layer) => layer.id)));
    for (const note of kept) {
      const gone = note.keep.filter((id) => !left.has(id) && before.scenes.some((scene) => scene.layers.some((layer) => layer.id === id)));
      if (!gone.length) continue;
      const names = keptNames(gone, before, codes);
      let item = null;
      if (!dryRun) {
        const agent = caller.getStore()?.live?.agent?.name ?? null;
        item = await agentState.update(projectId, (draft) => {
          draft.stopped ??= [];
          const same = draft.stopped.find((entry) => entry.noteId === note.id && entry.layers.join() === gone.join());
          if (same) return { item: structuredClone(same), stopped: structuredClone(draft.stopped) };
          const entry = { id: `S${draft.nextStopped ?? 1}`, noteId: note.id, layers: gone, summary: `delete ${keptNames(gone, before, null)}`, at: new Date(now()).toISOString(), ...(agent ? { agent } : {}) };
          draft.nextStopped = (draft.nextStopped ?? 1) + 1;
          draft.stopped.push(entry);
          return { item: entry, stopped: structuredClone(draft.stopped) };
        });
        await deps.emit?.(projectId, { kind: "stopped", stopped: item.stopped });
      }
      throw new AgentError("kept", `Not saved: ${names} ${gone.length === 1 ? "is" : "are"} kept by ${note.id} "${note.text}", which holds for the whole video.${item ? ` The person was asked (${item.item.id}); keep working on other things, the answer arrives in your inbox.` : ""}`,
        { note: note.id, layers: gone.map((id) => refName(id, codes)), ...(item ? { stopped: item.item.id } : {}), safeToRetry: false });
    }
  }

  // notes {action:"helper", text, may?}: a lead starts a helper agent on `text` (crew.mjs, within
  // the person's start rules); its final message arrives in the lead's inbox. notes
  // {action:"release"}: the agent frees the parts of this project it holds.
  async function notesCrew(projectId, input, meta, action) {
    const agent = meta.live?.agent;
    if (meta.by === "you") throw new AgentError("bad_input", action === "helper" ? "You start agents on the dashboard's crew screen." : "You free a held part on the dashboard's crew screen.");
    if (!deps.crew || !agent) throw new AgentError("unavailable", "This kino has no crew: agents cannot be started from here.");
    if (action === "release") {
      const freed = deps.crew.release(agent, projectId);
      return done(projectId, { text: freed.length ? `released ${freed.join(", ")}` : "You hold no part of this project.", data: { released: freed } });
    }
    const text = String(input.text ?? "").trim();
    if (!text) throw new AgentError("bad_input", 'helper needs text: the task, such as notes {action:"helper", text:"find 3 fast-cut walking edits", may:"look"}.');
    if (input.may !== undefined && !["all", "look"].includes(input.may)) throw new AgentError("bad_input", 'may is "all" or "look" (look and search only).');
    let helper;
    try {
      helper = await deps.crew.requestHelper(agent, { projectId, task: text, may: input.may ?? "all" });
    } catch (error) {
      if (error instanceof CrewError) throw new AgentError(error.code, error.message);
      throw error;
    }
    const data = { helper: helper.id, name: helper.name, kind: helper.kind, may: helper.may, budget: helper.budget,
      next: `${helper.name} works on its own; its final message arrives in your inbox ("handed back"). Keep working on other parts.` };
    return done(projectId, { text: `${helper.name} (${helper.id}, ${helper.kindWords}) started: "${helper.task.slice(0, 120)}" · may ${helper.mayWords} · budget ${helper.budget.calls} calls, ${helper.budget.minutes} min\n${data.next}`, data });
  }

  // notes {action:"checkpoint", id:<kind>} asks a stop; notes {action:"answer", id, rev, words,
  // read_as} records the person's chat reply to one (stops.mjs). The agent does both: the person
  // answers in the chat or on the dashboard's stop card (answerStop). An approval (Q…) the person
  // answers in the chat is recorded the same way (answerApproval). Each stop is decided inside
  // the queued update that counts the call in the
  // turn, so two agents asking at once get one round, and after the agent saves still running on
  // this project (oneAtATime), on the project as it is then. A refusal keeps what the step changed
  // before it (a stop that lapsed because the project moved on), so the agent's writes work again.
  // notes {action:"answer", id:"Q1", words, read_as} with an approval's id: the person said yes
  // or no in the chat, so it counts as their answer on the dashboard (an allowed render starts).
  // Their words are kept with it, for the dashboard and history.
  async function answerApproval(projectId, approval, input) {
    const words = String(input.words ?? "").trim();
    if (!words) throw new AgentError("bad_input", `answer needs words: what the person said about ${approval.id}, word for word.`);
    const read = String(input.read_as ?? "").trim().toLowerCase();
    const decision = ["approve", "approve with notes", "allow", "yes"].includes(read) ? "allow" : ["deny", "redo", "no"].includes(read) ? "deny" : null;
    if (!decision) throw new AgentError("bad_input", `read_as for ${approval.id} is approve or deny: what the person's words mean.`);
    if (approval.projectId && approval.projectId !== projectId)
      throw new AgentError("bad_input", `${approval.id} is for project ${approval.projectId}, not ${projectId}.`);
    if (!deps.approvals?.answer) throw new AgentError("not_available", "This kino answers approvals in the app only.");
    let answered;
    try { answered = await deps.approvals.answer(approval.id, { decision, words, via: "chat", note: read === "approve with notes" ? words : "" }); }
    catch (error) { throw new AgentError(error.status === 409 ? "answered" : "bad_input", error.message); }
    const job = answered.result?.job;
    const what = answered.status === "allowed" ? `${answered.id} allowed in the chat: ${answered.result?.text ?? answered.summary}` : `${answered.id} denied in the chat: ${answered.summary}`;
    const next = answered.status !== "allowed" ? "Do not send it again; ask the person what they want instead."
      : job ? `render {action:"wait", job:"${job}"} returns the file.` : "Go on.";
    return done(projectId, { text: `${what}\nnext: ${next}`, data: { approval: answered.id, status: answered.status, ...(job ? { job } : {}), next } });
  }

  async function notesStop(projectId, input, meta) {
    const checkpoint = input.action === "checkpoint";
    if (meta.by === "you")
      throw new AgentError("bad_input", checkpoint ? "Stops are asked by the agent; the person answers them." : "The person answers a stop on the dashboard (B2b) or in the chat, where you record it.");
    if (!checkpoint) {
      const id = String(input.id ?? "").trim();
      if (!id) throw new AgentError("bad_input", "answer needs id: the stop the person answered (C1, from its waiting_for_you answer).");
      const approval = /^Q\d+$/i.test(id) ? await deps.approvals?.get?.(id.toUpperCase()) : null;
      if (approval) return answerApproval(projectId, approval, input);
    }
    return oneAtATime(projectId, async () => {
      const steady = steadyNow();
      const record = await store.getProject(projectId);
      // The document's waivers in use go in the facts so a stop's ask says how many findings were waived.
      const video = { ...(await directionFacts(record.document)), waivers: checkpoint ? await waiversInUse(record.document) : record.document.checkWaivers ?? [], ...(checkpoint && input.id === "sound" ? { credits: await soundCredits(record.document), music: await musicIn(record.document) } : { credits: [] }) };
      const rules = stopRulesNow();
      const board = boardFacts(record.document);
      // Each shot's file name: move_needed offers a screen recording UI moves (engine/movePicks.js).
      if (checkpoint && board.board) board.mediaNames = await shotFileNames(board.board);
      const soundFiles = checkpoint ? await soundFilesFor(record.document) : false;
      const critique = checkpoint && String(input.id ?? "").trim().toLowerCase() === "critique" ? await critiqueToAsk(record) : null;
      const step = { rev: record.revision, work: workPrint(record.document), now: now(), client: meta.client ?? null, board };
      // A storyboard ask carries one style frame of the picked type direction (null: no footage, no picked type).
      const styled = checkpoint && String(input.id ?? "").trim().toLowerCase() === "board" ? await styleFrameFor(projectId, record.document) : null;
      let answer, refused;
      const finished = await done(projectId, {}, { change(draft) {
        try {
          // The approved storyboard is compared with the board now before the stops decide.
          settleBoard(draft, { ...board, rev: step.rev, now: step.now });
          if (checkpoint) {
            answer = checkpointStep(draft, { ...step, kind: input.id, video, rules, all: input.all === true, words: input.words, soundFiles, soundSearch: soundSearchOn(), songSearch: songSearchOn(), fresh: input.fresh, critique, styleFrame: styled?.facts ?? null });
            const asked = answer.data.status === "waiting_for_you" ? roundOf(draft, answer.data.id) : null;
            if (asked && !asked.steady) asked.steady = { at: steady, boot: bootedAt };
            // Which agent asked it, for the dashboard (live.mjs); older rounds, and rounds asked by
            // an agent without a session (matched by its client), have no agentId.
            if (asked && knownAgent(meta.live?.agent) && !meta.live.replay && !asked.agentId) {
              asked.agentId = meta.live.agent.id;
              asked.agentBoot = deps.live.boot ?? null;
            }
          } else {
            const asked = roundOf(draft, input.id)?.steady;
            // Text the person turned down in this reply joins the never list (rejected_text gates
            // it); checked on a scratch brief first so a bad list refuses the whole answer.
            if (input.rejected != null) {
              try { addRejected({}, input.rejected); } catch (error) { throw new StopError("bad_input", error.message); }
            }
            answer = answerStep(draft, { ...step, input, video, rules, waited: asked && sameBoot(asked.boot) ? steady - asked.at : null });
            // The never list keeps the newest 12: say which older texts left it.
            const dropped = input.rejected != null ? addRejected(draft, input.rejected) : [];
            if (dropped.length && answer?.data) answer.data.rejectedDropped = `style.rejected keeps the newest 12; dropped: ${dropped.map((text) => `"${text}"`).join(", ")}`;
          }
        } catch (error) {
          if (!(error instanceof StopError)) throw error;
          refused = new AgentError(error.code, error.message, error.details);
        }
      } });
      // The last stop answered on a built video: every gate left before the final render, at once.
      if (!checkpoint && !refused && answer?.data?.passed && hasLayers(record.document)) {
        const after = await agentState.read(projectId);
        const line = openStops(after, video, rules).length ? "" : await finalGates(await store.getProject(projectId)).then(toFinalLine, () => "");
        if (line) answer = { ...answer, text: `${answer.text}\n${line}` };
      }
      // The style frame goes with the ask as one image (saved beside the look images).
      if (styled && !refused && answer?.data?.status === "waiting_for_you" && answer.data.styleFrame) {
        const file = await look.save(projectId, "style", styled.png);
        answer = { ...answer, text: `${answer.text}\nimage ${file}`, images: [{ path: file, mime: "image/png", data: input.inline === false ? undefined : styled.png.toString("base64") }] };
      }
      return { ...finished, ...(refused ? errorReply(refused) : answer) };
    });
  }

  // The storyboard ask's style frame (board-look.mjs): { facts, png } of the picked type direction
  // (style.type, else the picked treatment's) over the first footage shot, or null: no board, no
  // footage, no picked type, no face or words to show, or the still did not render.
  async function styleFrameFor(projectId, document) {
    if (!document.board?.shots?.length) return null;
    const { brief } = await agentState.read(projectId);
    const type = brief?.style?.type ?? pickedType(brief?.treatments);
    if (!type) return null;
    const records = new Map();
    for (const shot of document.board.shots) if (typeof shot.media === "string" && shot.media !== "none" && !records.has(shot.media)) records.set(shot.media, await mediaRecord(shot.media));
    const facts = styleFrameFacts({ board: document.board, type, records, fonts: brief?.style?.fonts ?? null, message: brief?.fields?.message?.text ?? null });
    if (!facts) return null;
    try { return { facts, png: (await styleFrameImage(facts, { document, look, fontsFor, mediaRecord })).png }; } catch { return null; }
  }

  // notes {action:"brief"}: with no fields, log or no_playback it reads the brief; otherwise
  // it saves the lines and replies the agent recorded in the chat (brief.mjs). Any other key is
  // refused, so a typo ("field") is never read as a read that saved nothing. The brief comes
  // from the chat only (D9): the dashboard and kino --you may read it, never save it. The save
  // is checked inside the same queued update that counts the call in the turn, so two agents
  // saving at once each see the other's lines, and a refused save keeps nothing. `video`
  // (videoFacts) lets the next step follow the video's length and layers.
  async function notesBrief(projectId, input, meta, video, document) {
    const unknown = Object.keys(input).filter((key) => input[key] !== undefined && !BRIEF_KEYS.includes(key));
    if (unknown.length)
      throw new AgentError("bad_input", `brief takes fields, log and no_playback, not ${unknown.join(", ")}; nothing was saved.`, { didYouMean: closest(unknown[0], BRIEF_KEYS.slice(2)) });
    if (input.fields == null && input.log == null && input.no_playback == null) {
      // A settled brief reads back with its deck.
      await deckFor(projectId, document);
      const state = await agentState.read(projectId);
      return done(projectId, { text: briefText(state, video), data: briefData(state, video) });
    }
    if (meta.by === "you")
      throw new AgentError("chat_only", "The brief comes from the person's chat with their agent; the dashboard shows it read only. Tell your agent what to change.");
    let answer;
    try {
      const finished = await done(projectId, {}, { change(draft) {
        // A quote may come from what they said when they answered a stop (notes answer words).
        const said = (draft.stops ?? []).map((round) => round?.answer?.words).filter((words) => typeof words === "string" && words.trim());
        const changes = briefChanges(draft.brief, input, { said });
        applyBrief(draft, changes, { now: now(), client: meta.client ?? null });
        answer = { text: savedText(draft, changes, video), data: briefData(draft, video) };
      } });
      // The save waits for the search up to ORIGIN_WAIT_MS; a slower one finishes and stores itself later.
      await Promise.race([findOrigin(projectId), new Promise((resolve) => setTimeout(resolve, ORIGIN_WAIT_MS).unref())]);
      return { ...finished, ...answer };
    } catch (error) {
      if (error instanceof BriefError) throw new AgentError(error.code, error.message, error.details);
      throw error;
    }
  }

  // The brief's about line (who or what the video is about, quoted from the person) was saved or
  // changed: a search of that quote, and of the quote with the words beside it in the person's message
  // (originPhrase), keeps what the subject is known for in state.origin ({query, phrase, words, top}).
  // Nothing else of the person's message is sent. Offline, without
  // yt-dlp or on an error it keeps {query, skipped}; the save and its answer never change.
  // The last try per project (when, and for which quote): after a restart the first save tries again.
  const originTried = new Map();
  async function findOrigin(projectId) {
    try {
      const state = await agentState.read(projectId);
      const about = state.brief?.fields?.about;
      const query = originQuery(about?.quote ?? about?.text);
      if (!query) return;
      const ask = asksOf(state.brief).map((entry) => entry.text);
      // The quote and the words beside it in the person's message (an ask saved later searches again).
      const phrase = originPhrase(about?.quote ?? about?.text, ask);
      if (state.origin?.query === query && (state.origin.phrase ?? "") === phrase) {
        const last = originTried.get(projectId);
        const retry = state.origin.skipped && !(last?.query === query && last.phrase === phrase && now() - last.at < ORIGIN_RETRY_MS);
        if (!retry) return;
      }
      originTried.set(projectId, { query, phrase, at: now() });
      const origin = deps.inspire ? await deps.inspire.origin(about, { ask }) : { query, skipped: "kino cannot search YouTube here" };
      // Skipped when the line changed while the search ran: the next save searches the new one.
      await agentState.update(projectId, (draft) => {
        const line = draft.brief?.fields?.about;
        if (originQuery(line?.quote ?? line?.text) === query && originPhrase(line?.quote ?? line?.text, asksOf(draft.brief).map((entry) => entry.text)) === phrase) draft.origin = origin;
      });
    } catch { /* the origin is advice: a failure here must not lose the brief save */ }
  }

  // ---- the deck (engine/deck.js, deck.mjs) ----------------------------------------------------
  // What a whole-video check found the video uses, kept with the deck: later projects' deals
  // steer away from it (novelty).
  async function recordDeckUse(projectId, techniques = {}) {
    const used = Object.keys(techniques).filter((tag) => techniques[tag] > 0 && !PLAIN_TAGS.includes(tag)).sort();
    const state = await agentState.read(projectId);
    if (!state.deck || JSON.stringify(state.deck.used ?? []) === JSON.stringify(used)) return;
    await agentState.update(projectId, (draft) => { if (draft.deck) draft.deck.used = used; });
  }

  // The project's deck, dealt (or dealt again) when it is due: once the brief is settled and the
  // treatment is picked (or the treatments are waived or skipped for a short video), or when
  // notes {action:"deck"} asks (`deal`). While the treatments or their pick are open there is no
  // deck, not even one saved before, so the 5 ideas are not the dealt cards. A project with no
  // settled brief (a change to an old video) has none. Returns { deck, basis } or null.
  async function deckFor(projectId, document, { deal = false, reroll = false } = {}) {
    const state = await agentState.read(projectId);
    if (!deal && !reroll && !state.deck && !isSettled(state.brief)) return null;
    const treatmentsWaived = (document.checkWaivers ?? []).some((waiver) => waiver.code === TREATMENTS_WAIVER && waiver.target === "*");
    if (!deal && !reroll && pickOpen(state.brief, { seconds: videoFacts(document).seconds, treatmentsWaived })) return null;
    const inputs = await deckInputs(state, document);
    const picked = pickedDeck(document);
    const adopt = picked && (picked.seed !== state.deck?.seed || picked.reroll !== state.deck?.reroll);
    if (!reroll && !adopt && !dealDue(state.deck, inputs.basis)) return { deck: state.deck, basis: inputs.basis };
    const recent = await recentDecksOf(projectId);
    let deck;
    await agentState.update(projectId, (draft) => {
      const nextReroll = reroll ? (draft.deck?.reroll ?? 0) + 1 : adopt ? picked.reroll : draft.deck?.reroll ?? 0;
      deck = newDeal({ projectId, reroll: nextReroll, inputs, recent, now: now() });
      // A picked deck variant locks its deal: the person chose it.
      if (adopt && !reroll) deck.locked = true;
      draft.deck = deck;
    });
    return { deck, basis: inputs.basis };
  }

  // The last projects' decks the deal reads (deck.mjs newDeal). A deck dealt before decks saved
  // their media gets its project's media now, so a remake still sees its original as kin.
  async function recentDecksOf(projectId) {
    const recent = (await agentState.recentDecks?.(projectId, RECENT_PROJECTS)) ?? [];
    return Promise.all(recent.map(async (entry) => (entry.media ? entry
      : { ...entry, media: mediaKeys((await Promise.resolve().then(() => store.getProject(entry.projectId)).catch(() => null))?.document) })));
  }

  // The deal of a picked deck variant (variants {vary:"deck"}, pick_variant), or null.
  function pickedDeck(document) {
    return document.scenes.find((scene) => scene.variant?.picked && scene.variant.vary === "deck" && scene.variant.deck)?.variant.deck ?? null;
  }

  // The project's next `count` decks after its current one, for variants {vary:"deck"}.
  async function nextDecks(projectId, document, count) {
    const current = (await deckFor(projectId, document, { deal: true })).deck;
    const state = await agentState.read(projectId);
    const inputs = await deckInputs(state, document);
    const recent = await recentDecksOf(projectId);
    return Array.from({ length: count }, (_, index) => newDeal({ projectId, reroll: current.reroll + index + 1, inputs, recent, now: now() }));
  }

  // compose {footage}: the deck it cuts with and the brief's picked treatment. Without seed, the
  // project's deck (dealt from the footage when it has none); with seed, that deal (reroll = seed),
  // which becomes the project's deck. The deal is locked: the edit is built from it.
  async function footageDeck(document, { seed, material }) {
    const state = await agentState.read(document.id);
    const treatments = state.brief?.treatments;
    const pick = treatments?.picked ? treatments.list[treatments.picked.index] : null;
    if (seed === undefined && state.deck) return { deck: state.deck, pick };
    const inputs = await deckInputs(state, document);
    const recent = await recentDecksOf(document.id);
    const deck = { ...newDeal({ projectId: document.id, reroll: seed ?? 0, inputs: { ...inputs, material }, recent, now: now() }), locked: true };
    await agentState.update(document.id, (draft) => { draft.deck = deck; });
    return { deck, pick };
  }

  // Ops applied to a document as one edit would apply them, without saving (compose {footage}).
  async function runOps(document, ops) {
    const resolver = createResolver(document, null);
    const translation = translateAll(ops, resolver, document);
    const problems = translation.problems.map(translationProblem);
    const after = await applyAll(document, translation.operations, ops, { resolver, notes: [], reports: new Map() }, problems, translation.blocked);
    if (problems.length) throw new Error(problems.slice(0, 3).map((entry) => entry.message).join("; "));
    return after;
  }

  // compose {footage}, before its edit is saved: check fixes what it can in the new scene (up to
  // three rounds, each fix proven safe, pixels included), the fixes' layers count as the edit's
  // own (composing again replaces them), and the receipt says what is left and the call to make
  // next. Returns {document, finished}.
  async function finishFootage(document, sceneId, codes, shown = 8) {
    let fonts = await fontsFor(document);
    const options = { codes, sceneId, pixels: true, rules: null, outputFps: 30 };
    let result = await findingsFor(document, { ...options, fonts });
    const outcome = await autoFix(document, result.findings, { ...options, fonts });
    let next = document;
    if (outcome.ops.length) {
      const before = new Set(document.scenes.find((scene) => scene.id === sceneId).layers.map((layer) => layer.id));
      next = await simulateOps(document, outcome.ops, codes);
      const scene = next.scenes.find((item) => item.id === sceneId);
      if (scene.footage) scene.footage.made = [...new Set([...(scene.footage.made ?? []), ...scene.layers.filter((layer) => !before.has(layer.id) && !layer.parentId).map((layer) => layer.id)])];
      next = parseDocument(next);
      fonts = await fontsFor(next);
      result = await findingsFor(next, { ...options, fonts });
    }
    const report = checkReport(result.findings);
    const left = report.findings.slice(0, shown).map((finding) => `${finding.severity === "error" ? "E" : "W"} ${finding.rule} ${finding.ref}${finding.at != null ? ` @${sec(finding.at)}` : ""}: ${String(finding.message).slice(0, 140)}`);
    return {
      document: next,
      finished: {
        errors: report.errors, warnings: report.warnings, fixed: outcome.fixed.length, ...(outcome.fixed.length ? { fixedLines: outcome.fixed.slice(0, 6) } : {}),
        ...(left.length ? { left } : {}),
        next: report.errors ? 'check (fix the errors it lists), then look {mode:"review"}' : 'look {mode:"review"}',
      },
    };
  }

  // notes {action:"deck"}: read the hand, deal again (reroll) or swap a card.
  async function notesDeck(projectId, document, input) {
    const request = deckRequest(input);
    if (request.problem) throw new AgentError("bad_input", request.problem);
    const dealt = await deckFor(projectId, document, { deal: true, reroll: request.reroll });
    const moves = await loadMoves();
    if (request.swap === undefined)
      return done(projectId, { text: deckText(dealt.deck, { moves, said: request.reroll ? `dealt again (deal ${dealt.deck.reroll + 1}).` : "" }), data: deckData(dealt.deck) });
    let answer;
    const finished = await done(projectId, {}, { change(draft) {
      const deck = draft.deck;
      const problem = swapProblem(deck, request.swap, { moves: moves.map((move) => move.name), avoids: styleContext(draft.brief?.style)?.avoids ?? [] });
      if (problem) throw new AgentError(problem.includes("used its") ? "swap_limit" : "bad_input", problem);
      draft.deck = applySwap(deck, request.swap, { moves, at: new Date(now()).toISOString() });
      answer = { text: deckText(draft.deck, { moves, said: `swapped ${request.swap.out} for ${request.swap.in}.` }), data: deckData(draft.deck) };
    } });
    return { ...finished, ...answer };
  }

  // A note's area: {x, y, width, height} in scene pixels, whole numbers.
  function noteArea(value) {
    if (value == null) return null;
    const area = Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Math.round(Number(value?.[key]))]));
    if (Object.values(area).some((entry) => !Number.isFinite(entry)) || area.width < 1 || area.height < 1)
      throw new AgentError("bad_input", "area is {x, y, width, height} in scene pixels.");
    return area;
  }

  // ---- render -----------------------------------------------------------------------------
  // The export batch behind a job, or null once it finished and was removed (get throws then).
  function batchOf(job) {
    try { return exportBatches.get(job.batchId); } catch { return null; }
  }

  function renderSummary(job) {
    const batch = batchOf(job);
    const snapshot = batch ? exportBatches.snapshot(batch) : null;
    const items = snapshot?.jobs ?? [];
    const item = items.find(entry => entry.status === "failed") ?? items.find(entry => entry.status !== "completed") ?? items[0];
    return { snapshot, item, items, terminal: items.length > 0 && items.every(entry => ["completed", "failed", "canceled"].includes(entry.status)) };
  }

  // A restart keeps completed paths and explains interrupted jobs. A new start can
  // reuse completed scene segments; it never pretends an interrupted job succeeded.
  async function loadRenderState() {
    renderStateLoaded ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(path.join(agentDirectory, "render-jobs.json"), "utf8"));
        for (const entry of Array.isArray(saved.jobs) ? saved.jobs.slice(-RENDERS_KEPT) : []) {
          if (!/^R\d+$/.test(entry.id) || typeof entry.projectId !== "string") continue;
          const job = { ...entry, batchId: null };
          if (!["done", "failed", "canceled"].includes(job.status)) {
            job.status = "failed"; job.error = "The app stopped during this render. Start it again to reuse completed scene segments.";
          }
          renders.set(job.id, job); nextRenderId = Math.max(nextRenderId, Number(job.id.slice(1)) + 1);
        }
      } catch (error) { if (error.code !== "ENOENT") renders.clear(); }
    })();
    return renderStateLoaded;
  }

  // Only the newest RENDERS_KEPT jobs are kept, as a restart keeps them (loadRenderState): the
  // dashboard's render queue reads every kept job each second, and each holds its caption events.
  // A job still running is never dropped.
  function forgetOldRenders() {
    for (const [id, job] of renders) {
      if (renders.size <= RENDERS_KEPT) break;
      if (["done", "failed", "canceled"].includes(job.status) && !job.finishing) renders.delete(id);
    }
  }

  function saveRenderState() {
    const jobs = [...renders.values()].slice(-RENDERS_KEPT).map(({ finishing, ...job }) => job);
    const serialized = JSON.stringify({ jobs });
    renderStateWrite = renderStateWrite.catch(() => {}).then(async () => {
      await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
      const temporary = path.join(agentDirectory, `render-jobs-${randomUUID()}.tmp`);
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, path.join(agentDirectory, "render-jobs.json"));
    });
    return renderStateWrite;
  }

  function compactValidation(validation) {
    if (!validation) return undefined;
    return { ok: validation.ok, method: validation.method, facts: validation.facts,
      checks: Object.fromEntries(Object.entries(validation.checks).map(([name, check]) => [name, check.status])) };
  }

  // Saves the rendered revision's layout moments to the house memory (seen_before reads them in
  // other projects). A failure is only a warning: the render itself is done.
  async function rememberRender(job) {
    if (!deps.house) return;
    try {
      const record = await store.getProject(job.projectId);
      const document = !record ? null : job.rev === record.revision ? record.document : await store.getProjectRevision(job.projectId, job.rev);
      if (!document) return;
      const fonts = await fontsFor(document);
      await deps.house.record({ projectId: job.projectId, name: document.name, rev: job.rev, moments: houseMoments(document, { fonts }), structure: houseStructure(document, videoScene(document), { fonts }), type: houseType(document, videoScene(document), { fonts }) });
    } catch (error) { job.warnings = [...(job.warnings ?? []), `house memory not saved: ${error.message}`]; }
  }

  async function finishRender(job) {
    if (job.finishing) return job.finishing;
    // A job that cancel took over saves nothing: cancel removes its batch folder (render cancel).
    if (job.canceled) return;
    const { items, terminal } = renderSummary(job);
    if (job.status === "done" || !terminal) return;
    job.finishing = (async () => {
      const batch = batchOf(job);
      const directory = job.out ?? path.join(agentDirectory, "renders", encodeURIComponent(job.projectId));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const files = [];
      for (const item of items.filter(entry => entry.status === "completed")) {
        const file = exportBatches.file(batch, item.id);
        const suffix = items.length > 1 ? `-${files.length + 1}` : "";
        const target = path.join(directory, `${job.projectId}-r${job.rev}-${job.quality}-${job.id}${suffix}.${file.extension}`);
        const temporary = `${target}.${randomUUID()}.tmp`;
        await copyFile(file.path, temporary); await rename(temporary, target);
        files.push({ scene: item.sceneId, path: target, size: item.size, width: item.width, height: item.height,
          fps: item.fps ?? job.fps, cached: Boolean(item.cached), renderedFrames: item.cached ? 0 : file.renderedFrames,
          validation: compactValidation(item.validation ?? file.validation),
          ...(file.outputAudit ? { outputAudit: compactValidation(file.outputAudit) } : {}),
          ...(file.graphics ? { graphics: file.graphics } : {}), ...(file.videoEncoder ? { videoEncoder: file.videoEncoder } : {}),
          ...(file.loudness ? { loudness: file.loudness } : {}),
          ...(file.motion ? { motion: { stills: file.motion.stills, jumps: file.motion.jumps } } : {}), warnings: item.warnings ?? [] });
        const saved = files.at(-1);
        // Captions in the video also go into .srt and .vtt files beside it (caption-export.mjs).
        const captions = job.captions?.[item.sceneId];
        if (captions?.length) {
          try { saved.captionFiles = await writeCaptionFiles(target, captions); }
          catch (error) { saved.warnings = [...saved.warnings, `caption files not written: ${error.message}`]; }
        }
        // After a final render with sound: are the picture and the sound in step (ITU-R BT.1359)?
        if (job.quality === "final" && ["mp4", "webm", "mov"].includes(job.format)) {
          try { const finding = await avOffsetFinding(target); if (finding) saved.avOffset = finding; }
          catch (error) { saved.avOffset = { severity: "warn", rule: "av_offset", message: `The sound sync could not be measured: ${error.message}` }; }
        }
      }
      job.files = files; job.path = files.length === 1 ? files[0].path : undefined;
      job.size = files.reduce((sum, file) => sum + file.size, 0);
      job.warnings = [...files.flatMap(file => file.warnings), ...(job.captionWarnings ?? [])];
      job.cachedScenes = files.filter(file => file.cached).map(file => file.scene);
      job.redrawnScenes = files.filter(file => !file.cached).map(file => file.scene);
      job.status = items.some(item => item.status === "failed") ? "failed" : items.some(item => item.status === "canceled") ? "canceled" : "done";
      job.error = items.filter(item => item.error).map(item => item.error).join("; ");
      // What the next estimate learns from: how long this took and how much video it drew.
      job.finishedAt = now(); job.drawnSeconds = Math.round(drawnSeconds(files) * 100) / 100;
      await saveRenderState();
      if (job.status === "done") await rememberRender(job);
      await exportBatches.remove(job.batchId);
    })();
    try { await job.finishing; } finally { delete job.finishing; }
  }

  function renderData(job) {
    const { item, items } = renderSummary(job);
    return { job: job.id, status: ["done", "failed", "canceled"].includes(job.status) ? job.status : item?.status ?? "gone",
      stage: item?.stage, queuePosition: item?.queuePosition, progress: item?.progress,
      ...(job.range ? { range: job.range } : {}),
      ...(job.path ? { path: job.path, size: job.size } : {}), ...(job.files ? { files: job.files, cachedScenes: job.cachedScenes, redrawnScenes: job.redrawnScenes } : {}),
      ...(job.files?.length === 1 && job.files[0].captionFiles ? { captionFiles: job.files[0].captionFiles } : {}),
      ...(job.files?.length === 1 && job.files[0].avOffset ? { avOffset: job.files[0].avOffset } : {}),
      ...(items.length ? { scenes: items.map(entry => ({ scene: entry.sceneId, status: entry.status, cached: entry.cached, stage: entry.stage })) } : {}),
      ...(job.error || item?.error ? { error: job.error || item.error } : {}) };
  }

  // Every render job, for the dashboard's render queue.
  async function renderJobs() {
    const list = [];
    for (const job of renders.values()) {
      // finishRender saves each job's files once, however many callers ask together.
      await finishRender(job).catch(() => {});
      const data = renderData(job);
      list.push({ id: job.id, projectId: job.projectId, quality: job.quality, format: job.format, rev: job.rev, width: job.width, height: job.height,
        fps: job.fps, duration: job.duration, startedAt: new Date(job.startedAt).toISOString(), by: job.by ?? "agent", client: job.client ?? null,
        status: data.status, progress: data.status === "done" ? 1 : data.progress ?? null,
        path: job.path ?? job.files?.[0]?.path ?? null, size: job.size ?? null, files: (job.files ?? []).map(file => ({ scene: file.scene, path: file.path, size: file.size })),
        error: data.error ?? null, avOffset: job.files?.find(file => file.avOffset)?.avOffset ?? null });
    }
    return list;
  }

  // "passed", or which checks warned, such as audioPeak when the sound clips.
  function fileChecksText(validation) {
    if (!validation?.ok) return "unavailable";
    const warned = Object.entries(validation.checks ?? {}).filter(([, status]) => status === "warn").map(([name]) => name);
    return warned.length ? `passed with warnings (${warned.join(", ")})` : "passed";
  }

  // What drew a file and what encoded it (export.mjs result graphics and videoEncoder), such as
  // "drawn on Apple M3 Pro (Metal) (graphics card), 1 frame at once; encoded with h264_videotoolbox,
  // standard quality", or "encoded with libx264 (NVENC cannot encode frames this small: 128x72), standard
  // quality" when hardware could not encode it. A scene without effects that need Chromium is drawn by Resvg, on the processor.
  function drawnText(file) {
    const parts = [];
    const graphics = file.graphics;
    if (!graphics) parts.push("drawn on the processor by Resvg (no effect here needs the graphics card)");
    else {
      const where = !graphics.renderer ? "a renderer that did not say which" : rendererIsProcessor(graphics.renderer) ? `the ${graphics.renderer}`
        : `${graphics.renderer} (${graphics.card === false ? "processor" : "graphics card"})`;
      parts.push(`drawn on ${where}, ${plural(graphics.workers ?? 1, "frame")} at once`);
    }
    if (file.videoEncoder) parts.push(`encoded with ${file.videoEncoder.ffmpegEncoder}${file.videoEncoder.reason ? ` (${file.videoEncoder.reason})` : ""}, ${file.videoEncoder.quality} quality`);
    return parts.join("; ");
  }

  // The stills and brightness jumps measured on the rendered file (render-output-audit.mjs motionFacts).
  function motionText(motion, scene) {
    const stills = motion.stills.map((still) => `${sec(still.from)}-${sec(still.to)} s`);
    const jumps = motion.jumps.map((jump) => `${sec(jump.at)}-${sec(jump.until)} s (${jump.from} to ${jump.to})`);
    return `in the file${scene ? ` ${scene}` : ""}: ${[stills.length ? `still picture ${stills.join(", ")}` : "", jumps.length ? `brightness jumps off a cut ${jumps.join(", ")}` : ""].filter(Boolean).join("; ")}`;
  }

  function renderText(job) {
    const data = renderData(job);
    const parts = [`${job.id} ${job.quality} ${data.status} rev ${job.rev} ${job.width}×${job.height} ${fpsLabel(job.fps)}fps ${sec(job.duration)}s`];
    if (data.queuePosition) parts.push(`queue position ${data.queuePosition}`);
    if (data.progress != null) parts.push(`${Math.round(data.progress * 100)}%`);
    for (const file of job.files ?? []) parts.push(`${file.cached ? "reused" : "rendered"} ${file.scene}: ${file.path} (${Math.round(file.size / 1024)} KB${Number.isInteger(file.renderedFrames) ? `, ${file.renderedFrames} new frames` : ""}), file checks ${fileChecksText(file.validation)}${file.outputAudit ? `, decoded output audit ${file.outputAudit.ok ? "passed" : "failed"}` : ""}`);
    for (const file of job.files ?? []) if (file.validation?.facts?.audioLevels)
      parts.push(`sound${job.files.length > 1 ? ` ${file.scene}` : ""}: ${describeLevels(file.validation.facts.audioLevels, file.loudness)}`);
    for (const file of job.files ?? []) parts.push(`${job.files.length > 1 ? `${file.scene}: ` : ""}${drawnText(file)}`);
    for (const file of job.files ?? []) if (file.captionFiles) parts.push(`captions ${file.captionFiles.join(", ")}`);
    for (const file of job.files ?? []) if (file.motion?.stills.length || file.motion?.jumps.length) parts.push(motionText(file.motion, job.files.length > 1 ? file.scene : null));
    for (const file of job.files ?? []) if (file.avOffset) parts.push(`${file.avOffset.severity === "error" ? "E" : file.avOffset.severity === "warn" ? "W" : "ok"} av_offset${job.files.length > 1 ? ` ${file.scene}` : ""}: ${file.avOffset.message}`);
    if (data.error) parts.push(`error: ${data.error}`);
    if (job.warnings?.length) parts.push(`warnings: ${job.warnings.map(entry => typeof entry === "string" ? entry : entry.message).join("; ")}`);
    return parts.join(" · ");
  }

  async function render(input) {
    await loadRenderState();
    const action = input.action ?? "start";
    if (action === "queue") {
      const record = await projectFor(input);
      const jobs = [...renders.values()].filter(job => job.projectId === record.document.id).slice(-20);
      for (const job of jobs) await finishRender(job);
      return done(record.document.id, { text: jobs.map(job => {
        const data = renderData(job);
        return `${job.id} ${job.quality} ${data.status}${data.queuePosition ? ` · queue ${data.queuePosition}` : ""}${job.files ? ` · ${job.files.length} file(s), ${job.cachedScenes?.length ?? 0} reused` : ""}${data.error ? ` · ${data.error.slice(0, 180)}` : ""}`;
      }).join("\n") || "No render jobs yet.",
        data: { jobs: jobs.map(job => { const data = renderData(job); return { job: data.job, status: data.status, stage: data.stage, queuePosition: data.queuePosition, progress: data.progress }; }) } });
    }
    if (action === "start") {
      const record = await projectFor(input);
      const projectId = record.document.id;
      const codes = await syncCodes(projectId, record.document);
      const scenes = input.scene === "all" ? record.document.scenes.filter(scene => !scene.isComponent) : [sceneFor(record.document, codes, input.scene)];
      if (!scenes.length || scenes.length > 20) throw new AgentError("bad_input", "Render between 1 and 20 scenes at a time.");
      const scene = scenes[0];
      const quality = input.quality ?? "draft";
      if (!["draft", "final"].includes(quality)) throw new AgentError("bad_input", "quality is draft or final.");
      if (input.options != null && (typeof input.options !== "object" || Array.isArray(input.options)))
        throw new AgentError("bad_input", "options must be an export-settings object.");
      checkOutFolder(input.out);
      // Your export defaults from the dashboard settings fill in what the agent leaves out.
      const defaults = deps.renderDefaults?.() ?? {};
      let fast;
      try { fast = fastPreviewOptions(input, defaults); }
      catch (error) { throw new AgentError("bad_input", error.message); }
      const format = input.options?.profile ? exportProfile(input.options.profile).format : input.format ?? input.options?.format ?? defaults.format ?? "mp4";
      if (!["mp4", "webm", "mov", "gif", "png", "apng", "png-sequence", "lottie"].includes(format)) throw new AgentError("bad_input", "Use mp4, webm, mov, gif, png, apng, png-sequence or lottie.");
      const fonts = await fontsFor(record.document);
      // Ordinary drafts retain motion fidelity. An explicit fast review trades that for a
      // 15fps cap; source timing stays unchanged. fps may be fractional (frameRate.js).
      const asked = readFps(input.fps ?? input.options?.fps ?? (input.preview === "fast" ? 15 : defaults.fps ?? 30), (message) => new AgentError("bad_input", message));
      const fps = quality === "draft" ? Math.min(input.preview === "fast" ? 15 : 30, asked) : asked;
      const options = { ...input.options, format, renderQuality: quality, fps, ...(format === "png-sequence" ? { sequenceArchive: true } : {}),
        ...(quality === "draft" && defaults.draftWidth && input.options?.draftWidth === undefined ? { draftWidth: defaults.draftWidth } : {}),
        ...(quality === "draft" ? { draftFps: fps } : {}),
        ...(input.motionBlur !== undefined ? { motionBlur: input.motionBlur } : {}), ...(input.dither !== undefined ? { dither: input.dither } : {}),
        ...fast, ...(input.preview === "fast" ? { shutterAngle: 0 } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}), ...(input.to !== undefined ? { to: input.to } : {}) };
      let range;
      try {
        range = renderRange(scene, options);
        if (range && scenes.length !== 1) throw new Error("Choose one scene for a render range.");
      } catch (error) { throw new AgentError("bad_input", error.message); }
      // The final render's gates, in the order they refuse. A refusal keeps its code and next call
      // and names every gate still open, in finalGates' order, so the agent plans them at once.
      if (quality === "final") try {
        // The direction lock comes before the stops: they are judged against the locked story.
        await refuseWithoutLock(record, { format });
        await refuseFinalWhileStopsOpen(record);
        // The final-render gate: no final render while an error is open (not fixed, not waived with
        // a reason), nor in a real edit a warning. Advice (info) does not hold it. A still (one PNG
        // frame) is held as a sketch is: the video's motion warnings are not in it.
        const real = format !== "png" && await isRealEdit(record.document);
        for (const scene of scenes) {
          const { findings } = await findingsFor(record.document, { fonts, codes, sceneId: scene.id, pixels: true, outputFps: fps });
          const blocking = findings.filter((finding) => blocksFinal(finding, real));
          if (blocking.length)
            throw new AgentError("check_failed", `${plural(blocking.length, "open finding")} in ${refName(scene.id, codes)} block a final render (fix each or waive it with a reason):\n${openFindingLines(blocking).map((line) => `  ${line}`).join("\n")}`, {
              next: 'check {fix:"auto"} applies the safe fixes; fix the rest with edit, or waive_check {code, target, reason} for a deliberate exception. A draft render is allowed now.',
            });
        }
        // The review gate: every moment of the video seen at full size as it is now (look review).
        await refuseUnreviewed(record, scenes, { fonts, codes, format, options });
        // The reference gate: your frames seen beside the saved references (look versus).
        await refuseWithoutReference(record, scenes, { format, options });
        // The viewer gate: a fresh viewer's report with no open story bugs (look viewer, notes viewer).
        await refuseWithoutViewer(record, scenes, { codes, format, options });
        // The critic gate: no open P0 line from a fresh critic (look critique, notes critique).
        await refuseOpenCritique(record, scenes, { codes, format, options });
        // The needs gate: every need answered and done (notes needs).
        await refuseWithoutNeeds(record, scenes, { format, options });
      } catch (error) {
        throw await withOpenGates(error, record, scenes, options);
      }
      // Your approval (D3): a final render above the frame limit, or one that overwrites a file.
      const outFolder = input.out ?? (defaults.folder || null);
      const directory = outFolder ? path.resolve(String(outFolder)) : path.join(agentDirectory, "renders", encodeURIComponent(projectId));
      const id = `R${nextRenderId}`;
      const extension = { "png-sequence": "zip", lottie: "json" }[format] ?? format;
      // The same names finishRender gives the files.
      const targets = scenes.map((entry, index) => path.join(directory, `${projectId}-r${record.revision}-${quality}-${id}${scenes.length > 1 ? `-${index + 1}` : ""}.${extension}`));
      // The frames the exporter will draw, with options.duration and playback direction.
      const frames = quality === "final" ? scenes.reduce((sum, entry) => sum + plannedFrameCount(entry, options), 0) : 0;
      const frameLimit = deps.approvals?.limits?.().finalRenderFrames ?? Infinity;
      const existing = [];
      for (const target of targets) if (await access(target).then(() => true, () => false)) existing.push(target);
      const waiting = await approvalFor([
        quality === "final" && frames > frameLimit ? { kind: "final-render", summary: `a final ${format} of ${scenes.length > 1 ? plural(scenes.length, "scene") : refName(scene.id, codes)} at rev ${record.revision} (${frames} frames, over ${frameLimit})`,
          // What the dashboard's action strip says about the render it asks for ("02:50 1080p60 mp4").
          spec: { seconds: Math.round((frames / fps) * 100) / 100, frames, fps, format, width: scenes[0].width, height: scenes[0].height, scenes: scenes.length } } : null,
        existing.length ? { kind: "overwrite-export", summary: `overwriting ${existing.join(", ")} with rev ${record.revision}` } : null,
      ], projectId, "render", input, record.revision);
      if (waiting) return waiting;
      const batch = await exportBatches.create({ document: record.document, sceneIds: scenes.map(scene => scene.id), options, fonts, grantId: null });
      const snapshot = exportBatches.snapshot(batch).jobs[0];
      nextRenderId += 1;
      const job = { id, batchId: batch.id, projectId, rev: record.revision, quality, format, startedAt: now(), status: "queued",
        width: snapshot.width, height: snapshot.height, fps: snapshot.fps ?? fps, duration: snapshot.duration, ...(range ? { range } : {}), out: outFolder ? directory : null,
        by: caller.getStore()?.by === "you" ? "you" : "agent", client: caller.getStore()?.client ?? null };
      // Captions in each scene also go into .srt and .vtt files beside its video (caption-export.mjs),
      // cut at options.duration. Only videos get them: a still, GIF, APNG or Lottie file has no
      // caption track, and a reversed or boomerang GIF does not follow the scene's clock.
      const writesCaptions = ["mp4", "webm", "mov"].includes(format) && (options.playbackDirection ?? "normal") === "normal";
      if (writesCaptions) for (const entry of scenes) {
        try {
          const captions = rangeCaptions(captionEvents(record.document, entry.id, { fonts, fps, duration: range?.to ?? options.duration }), range);
          if (captions.length) (job.captions ??= {})[entry.id] = captions;
        } catch (error) { (job.captionWarnings ??= []).push(`caption files not made for ${refName(entry.id, codes)}: ${error.message}`); }
      }
      renders.set(job.id, job);
      forgetOldRenders();
      await saveRenderState();
      // Save finished files even when the client disconnects before calling wait.
      void Promise.resolve(batch.running).then(() => finishRender(job)).catch(async error => {
        job.status = "failed"; job.error = `Could not save the rendered files: ${error.message}`;
        await saveRenderState().catch(() => {});
      });
      // Learned from this computer's last finished renders of the same quality (render-estimate.mjs).
      const estimate = renderEstimate([...renders.values()], quality, scenes.reduce((sum, scene) => sum + scene.duration, 0)).seconds;
      const others = record.document.scenes.filter(entry => !scenes.some(scene => entry.id === scene.id) && !entry.isComponent).length;
      const note = (others ? ` The other ${plural(others, "scene")} ${others === 1 ? "is" : "are"} not in this file; scene:"all" exports each scene as its own file.` : scenes.length > 1 ? " Each scene produces its own file." : "")
        + (quality === "final" ? await finalSources(record.document) + await waivedNote(record.document) : "");
      // wait:true: one call starts the render and answers like wait (up to 55 s); a render that is
      // still running then says so, and render {action:"wait", job} picks it up.
      if (input.wait === true) {
        const waited = await render({ ...input, action: "wait", job: job.id });
        const running = !["done", "failed", "canceled"].includes(job.status) && !renderSummary(job).terminal;
        const extra = [running ? `Still running: render {action:"wait", job:"${job.id}"} returns the files.` : "", note.trim()].filter(Boolean);
        return extra.length ? { ...waited, text: `${waited.text}\n${extra.join(" ")}` } : waited;
      }
      return done(projectId, { text: `${job.id} queued: ${quality} ${format}, ${estimateWords(estimate)}. render {action:"wait", job:"${job.id}"} returns checked files.${note}`,
        data: { job: job.id, eta_s: estimate, ...(range ? { range } : {}), ...(others ? { otherScenes: others } : {}) } });
    }
    // wait blocks up to timeout_s (55 s at most) for the job, or for the person's answer first.
    let waitUntil = null;
    if (action === "wait") {
      const timeout = Number(input.timeout_s ?? 55);
      if (!Number.isFinite(timeout) || timeout < 0) throw new AgentError("bad_input", "timeout_s must be a nonnegative number.");
      waitUntil = now() + Math.min(timeout * 1000, RENDER_WAIT_MS);
    }
    if (/^q\d+$/i.test(String(input.job ?? "")) && deps.approvals?.get) {
      let approval = deps.approvals.get(String(input.job));
      if (!approval) throw new AgentError("not_found", `No approval ${input.job}.`);
      // wait on a request the person has not answered: block until they answer (or it is allowed
      // and its render starts), instead of answering at once. The server log showed agents polling
      // one request hundreds of times; only the person's click moves it.
      const unanswered = (entry) => entry.status === "pending" || (entry.status === "allowed" && !entry.result);
      while (waitUntil !== null && unanswered(approval) && now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        approval = deps.approvals.get(approval.id) ?? approval;
      }
      // Cancel withdraws a request that still waits for the person: the dashboard stops asking.
      if (action === "cancel" && approval.status === "pending") {
        const canceled = await deps.approvals.cancel?.(approval.id);
        if (canceled) return done(approval.projectId, { text: `${approval.id} canceled: the person is no longer asked about ${approval.summary}.`, data: { id: approval.id, status: "canceled" } });
        approval = deps.approvals.get(approval.id);
      }
      if (approval.status !== "allowed" || !approval.result?.job || !renders.has(approval.result.job)) {
        // Nothing renders for it (yet): say why, and leave a share link's URL for wait.
        if (action === "cancel") {
          const why = approval.status === "allowed" && !approval.result ? "was just allowed and its call is still starting; cancel it again in a moment"
            : `is ${approval.status}${approval.result ? ` (${approval.result.text})` : ""}`;
          return done(approval.projectId, { text: `Nothing to cancel: ${approval.id} ${why}.`, data: { id: approval.id, status: approval.status } });
        }
        const data = { id: approval.id, status: approval.status === "pending" ? "awaiting_approval" : approval.status, summary: approval.summary,
          ...(approval.rev === undefined ? {} : { rev: approval.rev }),
          ...(approval.note ? { note: approval.note } : {}), ...(approval.result ? { result: approval.result.text } : {}) };
        if (approval.status === "pending") {
          const asked = Date.parse(approval.createdAt ?? "");
          const minutes = Number.isFinite(asked) ? Math.max(0, Math.round((now() - asked) / 60_000)) : null;
          data.next = `Only the person can answer it, in the kino app or in the chat${minutes === null ? "" : ` (asked ${minutes} min ago)`}; asking again does not speed it up. Tell them it waits for them, then keep working or end your turn: the answer arrives in your inbox. When they answer in the chat, record their words: notes {action:"answer", id:"${approval.id}", words:"<their words>", read_as:"approve"}. Do not poll; one wait blocks up to 55 s.`;
        }
        // An allowed share link: this answer is the one place its URL appears (it is never saved).
        if ((approval.kinds ?? [approval.kind]).includes("share-link") && approval.result && !approval.result.isError) {
          const link = deps.approvals.takeShareLink?.(approval.id);
          if (link) Object.assign(data, link);
          else data.next = `Its URL is given once, in the first wait answer, and not kept after a restart. If it was lost: project {action:"manage", id:"${approval.projectId}", options:{resource:"shares", action:"list"}}, revoke that link, and ask for a new one.`;
        }
        return done(approval.projectId, { text: compact(data), data });
      }
      input = { ...input, job: approval.result.job };
    }
    const job = renders.get(String(input.job ?? [...renders.keys()].at(-1) ?? ""));
    if (!job) throw new AgentError("not_found", input.job ? `No render job ${input.job}.` : "No render jobs yet.", { didYouMean: input.job ? closest(String(input.job), [...renders.keys()]) : [] });
    if (action === "cancel") {
      // Cancel and finishRender never overlap: cancel removes the batch folder that finishRender
      // copies the files out of. A save that already started ends first.
      while (job.finishing) await job.finishing.catch(() => {});
      // Every scene already ended: the render is saved as it is, and the answer says so.
      if (["done", "failed", "canceled"].includes(job.status) || renderSummary(job).terminal) {
        await finishRender(job);
        return done(job.projectId, { text: `Nothing to cancel: ${renderText(job)}`, data: renderData(job) });
      }
      // Still rendering: cancel wins. job.canceled is set before any await, so finishRender
      // (called when the batch stops, or by wait) never starts copying.
      job.canceled = true;
      const batch = batchOf(job);
      if (batch) { await exportBatches.action(batch, { type: "cancel" }).catch(() => {}); await exportBatches.remove(job.batchId).catch(() => {}); }
      job.status = "canceled"; await saveRenderState();
      return { text: `${job.id} canceled.`, data: { job: job.id, status: "canceled" } };
    }
    if (action === "wait") {
      for (;;) {
        const { item, terminal } = renderSummary(job);
        if (["done", "failed", "canceled"].includes(job.status) || !item || terminal) break;
        if (now() > waitUntil) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } else if (action !== "status" && action !== "list") throw new AgentError("bad_input", `Unknown render action "${action}".`, { didYouMean: closest(action, ["start", "status", "wait", "cancel"]) });
    await finishRender(job);
    // A final render that came out gets the step line (minutes and calls per step) and marks the
    // video finished, so its log counts in the ranges (step-log.mjs stepRanges).
    const finalDone = job.quality === "final" && renderData(job).status === "done";
    const steps = finalDone ? stepsLine(await stepLogNow(job.projectId)) : "";
    return done(job.projectId, { text: steps ? `${renderText(job)} · ${steps}` : renderText(job), data: renderData(job) },
      finalDone ? { change(draft) { draft.stepLog = finishLog(draft.stepLog, new Date(now()).toISOString()); } } : undefined);
  }

  // The project's step log with the call being answered added (it is logged when the call ends).
  async function stepLogNow(projectId) {
    const log = (await agentState.read(projectId).catch(() => null))?.stepLog ?? null;
    const open = caller.getStore()?.openStep;
    return open && !open.logged ? logCall(log, open.name, open.at, now()) : log;
  }

  // ---- library ----------------------------------------------------------------------------
  async function library(input) {
    let topic = input.topic ?? "topics";
    // footage: found video (backend/footage-finder/actions.mjs); project import takes its shots (take.mjs).
    if (topic === "footage") return footage(input);
    // A topic one letter off ("effect", "ops") is that topic; a rules name ("render") is rules {name}.
    let topicNote = "";
    if (!LIBRARY_TOPICS.includes(topic) && typeof topic === "string") {
      const near = LIBRARY_TOPICS.find((name) => name === `${topic}s` || `${name}s` === topic) ?? nearMiss(topic, LIBRARY_TOPICS);
      if (near) { topicNote = `(topic "${topic}" read as "${near}")\n`; topic = near; input = { ...input, topic }; }
      else if (input.name === undefined && (RULES_OWN.includes(topic) || guideTopics().some((entry) => entry.id === topic))) {
        topicNote = `(topic "${topic}" read as rules {name:"${topic}"})\n`;
        input = { ...input, topic: "rules", name: topic };
        topic = "rules";
      }
    }
    if (topicNote) { const reply = await library(input); return { ...reply, text: `${topicNote}${reply.text}` }; }
    // `query` is another name for `search` (kino library topic=fonts query=Roboto).
    const search = String(input.search ?? input.query ?? "");
    if (topic === "topics")
      return { text: `library topics: op {name} (exact rules for one operation), rules {name, search?} (a guide topic; search keeps only its lines that mention a word; workspace covers projects, media, presets, comments and exports), search {search}, easings, presets, fonts {search: a name, or one character such as \"∞\" for the fonts that have it}, media, sounds {search, full?} (kino's built-in CC0 sound effects, sfx:<id>; name:\"openverse\" searches Openverse instead, 10 s or less, full:true up to 60 s, only when the person turned on sound search), music {search: moods, energy, bpm} (built-in mood-tagged tracks, music:<id>, a fallback), effects, blocks {name?} (recipes, looks, slots, timing, tokens), moves {name?} (designed set pieces: zoom-through, whip-pan, caption-words, …), formats {name?} (whole videos to fill: product-launch, app-demo, social-promo, feature-announcement, testimonial; format {name, slots} builds one), guide {name?} (the kino skill, for agents without it; name: one of its references, such as edits or sound), inspire {search?, kind?, name?} (YouTube edits: kino measures their cuts, beat and fingerprint, and keeps frame strips; kind:\"shorts\" finds short vertical edits (YouTube Shorts); kind:\"sounds\" finds sound effects of 60 s or less instead, importable as project {action:\"import\", file:\"yt:…\"}; name: one ref, or \"save yt:…\", \"unsave yt:…\", \"measure yt:…\", \"forget <search n>\", \"copy <project>\" (its saved refs), \"cancel\"), soundtrack {song?, search?, explore?, like?, measure?, note?} (real songs from YouTube first, found by name with song:\"<title> by <artist>\"; Openverse and the Archive fill in when sound search is on; measured, lined up against the story beats and ranked by fit to the person's taste; like:\"yt:…\" adds YouTube's mix for a song; library {topic:\"guide\", name:\"soundtrack\"}), ${FOOTAGE_TOPIC_LINE}, techniques {name?} (the named editing techniques check finds and the style spec uses).`, data: { topics: LIBRARY_TOPICS.filter((name) => name !== "topics") } };
    // op and rules take several names at once (a list, or "a, b"), answered one after another.
    const names = (Array.isArray(input.name) ? input.name : String(input.name ?? "").split(",")).map((name) => String(name).trim()).filter(Boolean);
    if ((topic === "op" || topic === "rules") && names.length > 1) {
      if (names.length > LIBRARY_NAMES) throw new AgentError("bad_input", `name lists at most ${LIBRARY_NAMES} names per call.`);
      const parts = [];
      for (const name of names) {
        try { parts.push((await library({ ...input, name })).text); }
        catch (error) { parts.push(`${name}: ${error.message}${error.details?.didYouMean?.length ? ` Did you mean ${error.details.didYouMean.join(", ")}?` : ""}`); }
      }
      return { text: parts.join("\n\n") };
    }
    if (Array.isArray(input.name)) input = { ...input, name: names[0] };
    if (topic === "op") {
      if (!input.name) throw new AgentError("bad_input", "op needs name, such as add_layer.");
      if (String(input.name) === "borrow_rhythm") return { text: BORROW_HELP };
      // addLayer, add_text or move (an animation preset): the op it stands for.
      const guess = opFromWord(String(input.name), AGENT_OPERATION_TYPES);
      if (guess) {
        const said = guess.preset ? `${input.name} is an animation preset: send it with add_animation {layer, preset:"${guess.preset}", start, duration}.`
          : `${input.name} is ${guess.type}${guess.layerType ? ` with layerType "${guess.layerType}"` : ""}.`;
        return { text: `${said}\n\n${(await library({ ...input, name: guess.type })).text}` };
      }
      const type = String(input.name);
      const notOp = notAnOp(type);
      if (notOp) throw new AgentError("not_found", notOp);
      if (type === "set_font") return { text: withExample(type, SET_FONT_RULES) };
      // move is also an animation preset: say so, for an agent that wants to move a layer.
      if (type === "move") return { text: `${withExample(type, blockRules(type))}\nTo move one layer instead: move is also an animation preset, sent with add_animation {layer, preset:"move", start, duration}.` };
      if (isBlockOperation(type)) return { text: withExample(type, blockRules(type)) };
      if (REACH_HELP[type]) return { text: withExample(type, REACH_HELP[type]) };
      const text = withExample(type, operationHelp(type, Boolean(input.full)));
      return { text: type === "add_animation" ? `${text}\n${propertyPresetHelp()}` : text };
    }
    // rules render, quality and workspace are written here, not in the guide; search narrows them too.
    const ownRules = { render: () => RENDER_RULES, quality: qualityRulesText, workspace: () => WORKSPACE_HELP };
    if (topic === "rules" && Object.hasOwn(ownRules, input.name)) {
      const text = ownRules[input.name](Boolean(search));
      return { text: search ? linesMentioning({ id: input.name, title: input.name, text }, search) : text };
    }
    // rules {name, search}: only the lines of that topic that mention the word (one recipe, say).
    if (topic === "rules") {
      try { return { text: guideText(describeOperation(input.name ? { topic: String(input.name), search: search || undefined } : {})) }; }
      catch (error) {
        if (!/^Unknown topic/.test(error.message)) throw error;
        // Not a rules topic: a guide of that name, its own library topic, or the topics that mention the word.
        const guide = deps.guideText ? await deps.guideText(String(input.name)).catch(() => null) : null;
        if (guide) return { text: `(rules "${input.name}" is library {topic:"guide", name:"${input.name}"})\n${guide}` };
        if (LIBRARY_TOPICS.includes(input.name)) return { text: `${input.name} is its own topic: library {topic:"${input.name}"}.` };
        return { text: `No rules topic "${input.name}"; what mentions it:\n${guideText(searchGuide(String(input.name)))}` };
      }
    }
    if (topic === "search") return { text: guideText(searchGuide(search || input.name)) };
    if (topic === "easings") {
      const saved = await store.listEasings();
      return { text: `easings: ${EASINGS.map((easing) => easing.id).join(", ")}. intensity 0–100 (default 50) for the named curves (expo-out, quart-out and in-out are fixed); for steps it is the count of held poses ("steps-4" sends both). Presets default to smooth both ways (fades linear; snap is expo-out); "custom" takes cubic-bezier points. library {topic:"rules", name:"easing"} has the details.\nsaved: ${JSON.stringify(saved)}`, data: { easings: saved } };
    }
    if (topic === "presets") {
      const kinds = {};
      for (const preset of PRESETS) (kinds[preset.kind] ??= []).push(preset.id);
      const catalog = Object.values(PRESET_DEFINITIONS).map((definition) => `${definition.id}${Object.keys(definition.parameters).length ? `(${Object.entries(definition.parameters).map(([key, value]) => `${key} ${value}`).join(", ")})` : ""}`);
      return { text: [`add_animation preset: ${Object.entries(kinds).map(([kind, ids]) => `${kind}: ${ids.join(" ")}`).join(" · ")}`,
        `catalog presets ({preset:{id, mode:"in"|"out", parameters}}): ${catalog.join(", ")}`,
        "library {topic:\"rules\", name:\"presets\"} has the details."].join("\n") };
    }
    if (topic === "fonts")
      return { text: await fontsLibraryText(search || input.name, { fonts: await loadFonts(), catalog: fontCatalog }) };
    if (topic === "media") {
      const media = await deps.listMedia();
      // The search matches a file's name or its id (in its src), as uploads of one file share a name.
      const matches = (item) => [item.name, item.src ?? item.id].some((value) => String(value ?? "").toLowerCase().includes(search.toLowerCase()));
      const found = media.filter((item) => !search || matches(item));
      const { items: shown, page, pages, left } = pageOf(found, input.page);
      const isVideo = (item) => String(item.mime ?? "").startsWith("video/");
      const lines = shown.map((item) => `${item.src ?? `/api/media/${item.id}`} '${item.name}' ${item.mime}${item.width ? ` ${item.width}×${item.height}` : ""}${item.duration ? ` ${sec(item.duration)}s` : ""}${isVideo(item) && Array.isArray(item.shots) ? ` · ${plural(item.shots.length, "shot")}` : ""}${item.credit?.line ? ` · credit: ${item.credit.line}` : ""}`);
      // One video: all of its shots (found now when it was imported before kino found shots).
      if (shown.length === 1 && isVideo(shown[0])) {
        const found = await fileShots(shown[0].src ?? `/api/media/${shown[0].id}`);
        lines.push(shotsLine(found.shots ? { ...shown[0], shots: found.shots } : { ...shown[0], shots: undefined, shotsError: found.reason }, { all: true }));
      } else if (search && shown.filter(isVideo).length > 1) lines.push("search a video's id (after /api/media/) to list all its shots");
      if (left > 0) lines.push(`${left} more: library {topic:"media", page:${page + 1}${search ? `, search:${JSON.stringify(search)}` : ""}}`);
      return { text: shown.length ? lines.join("\n") : "No media matches. project {action:\"import\", file} adds a local file.", data: { media: shown, page, pages, total: found.length } };
    }
    // sounds: kino's built-in CC0 effects (backend/sound-library.mjs); name:"openverse" searches
    // Openverse instead (backend/sound-search.mjs), only with the Settings switch on.
    if (topic === "sounds" && names[0] !== "openverse") {
      if (!deps.soundLibrary) throw new AgentError("failed", "The sound library is not available here.");
      try {
        const found = deps.soundLibrary.searchSounds(search || input.name, { maxSeconds: input.full === true ? SOUND_LIMITS.maxSeconds : SOUND_LIMITS.defaultSeconds });
        return { text: librarySoundsText(found, { searchOn: soundSearchOn() }), data: { sounds: found.results.slice(0, 10).map(({ id, words, seconds, lufs }) => ({ id: `sfx:${id}`, words, seconds, lufs })) } };
      } catch (error) { throw soundError(error); }
    }
    // music: the built-in mood-tagged tracks, in this project's own order (never one default song).
    if (topic === "music") {
      if (!deps.soundLibrary) throw new AgentError("failed", "The sound library is not available here.");
      const record = await projectFor(input);
      const fields = (await agentState.read(record.document.id)).brief?.fields ?? {};
      const found = deps.soundLibrary.listMusic({ mood: input.mood ?? names, energy: input.energy, bpm: input.bpm, search }, { seed: record.document.id });
      // No music answer in the brief yet: the person picks the feel first (or sends a song).
      const ask = fields.look_sound?.text ? "" : "The brief has no music answer (look_sound): ask the person for a mood or their own song before you pick.\n";
      const songs = deps.soundtrack ? '\nA real song fits most videos better: library {topic:"soundtrack", song:"<title> by <artist>"}, search or explore:true.' : "";
      return { text: ask + musicText(found) + songs, data: { music: found.results.slice(0, 8).map(({ url, sha256, bytes, credit, ...track }) => ({ ...track, id: `music:${track.id}` })) } };
    }
    if (topic === "sounds") {
      if (!deps.soundSearch) throw new AgentError("failed", "Sound search is not available here.");
      try {
        const found = await deps.soundSearch.search(search || input.name, { maxSeconds: input.max_seconds ?? input.maxSeconds ?? (input.full === true ? SOUND_LIMITS.maxSeconds : undefined) });
        return { text: soundsText(found), data: { sounds: found.results.map(({ url, line, filetype, ...entry }) => entry) } };
      } catch (error) { throw soundError(error); }
    }
    if (topic === "effects") {
      const effects = await store.listTextEffects();
      return { text: effects.length ? effects.map((effect) => `${effect.id} '${effect.name}'`).join("\n") : "No saved text effects.", data: { effects: effects.map(({ id, name }) => ({ id, name })) } };
    }
    // guide: the kino skill (SKILL.md); with a name, one of its references (edits, sound, …).
    if (topic === "guide") {
      try {
        const text = await deps.guideText(names[0]);
        return { text: names[0] ? text : `${text}\n\n(Read this once; do not call library guide again without a name.)` };
      } catch (error) {
        if (!error.guides) throw error;
        throw new AgentError("not_found", error.message, { didYouMean: closest(names[0], error.guides) });
      }
    }
    if (topic === "blocks") {
      try { return { text: blocksLibraryText(input.name) }; }
      catch (error) { throw new AgentError("not_found", error.message, { didYouMean: error.suggestions ?? [] }); }
    }
    if (topic === "formats") {
      try { return { text: videoFormatsText(input.name) }; }
      catch (error) { throw new AgentError("not_found", error.message, { didYouMean: closest(String(input.name), VIDEO_FORMAT_NAMES) }); }
    }
    if (topic === "moves") {
      try { return { text: movesLibraryText(input.name) }; }
      catch (error) { throw new AgentError("not_found", error.message, { didYouMean: error.suggestions ?? [] }); }
    }
    if (topic === "inspire") return inspire(input, names[0] ?? "", search);
    if (topic === "soundtrack") return soundtrack(input, names[0] ?? "", search);
    if (topic === "techniques") {
      // The technique vocabulary (engine/techniques.js): every tag by group, or one in full.
      if (!names[0]) return { text: techniquesText() };
      const one = techniquesText(names[0]);
      if (!one) throw new AgentError("not_found", `"${names[0]}" is not a technique.`, { didYouMean: closest(names[0], TECHNIQUE_TAGS) });
      return { text: one };
    }
    throw new AgentError("bad_input", `Unknown library topic "${topic}".`, { didYouMean: closest(topic, LIBRARY_TOPICS) });
  }

  // ---- inspire (backend/inspire.mjs): YouTube edits, measured -------------------------------
  // library {topic:"inspire"}: search {search}, one reference {name}, save/unsave/measure/cancel
  // by name, or (nothing) the project's searches and saved references. Searches and saved
  // references belong to the project; the measured numbers are shared by every project.
  async function inspire(input, name, search) {
    if (!deps.inspire) throw new AgentError("failed", "Inspire is not available here.");
    const record = await projectFor(input);
    const projectId = record.document.id;
    const asked = caller.getStore();
    const agent = asked?.live?.agent;
    const by = byYou() ? "you" : agent ? { id: agent.id, name: agent.name, color: agent.color } : { id: null, name: "agent", color: null };
    // A YouTube link (or yt:<id>) in search is that one video, as name would be.
    const typed = String(search ?? "").trim();
    if (!name && (isYouTubeUrl(typed) || typed.startsWith("yt:")) && refId(typed)) { name = typed; search = ""; }
    if (closedPlatform(typed) || closedPlatform(name)) throw new AgentError("bad_input", CLOSED_PLATFORM);
    // Ideas: the agent proposes them (ideas: {ref, take, skip}); only the person turns them on or
    // off ("idea 2 off") and answers ("allow ideas", "hold ideas", with an optional note).
    if (input.ideas !== undefined) {
      if (byYou()) throw new AgentError("chat_only", "Ideas come from your agent; you turn them on or off and allow them on the inspire screen.");
      let ideas;
      try { ideas = await deps.inspire.setIdeas(projectId, input.ideas, by); }
      catch (error) { throw new AgentError("bad_input", `ideas: ${error.message}. ${IDEAS_HELP}`); }
      return { project: projectId, text: ideasProposedText(ideas), data: { ideas: ideas.id, take: ideas.take.length, skip: ideas.skip.length, status: ideas.status } };
    }
    const ideaWords = /^(?:idea\s+(\d+)(?:\s+(on|off))?|(allow|hold)\s+ideas)$/i.exec(String(name ?? "").trim());
    if (ideaWords) {
      if (!byYou()) throw new AgentError("chat_only", "Only the person turns ideas on or off and allows them, on the inspire screen. Propose ideas with library {topic:\"inspire\", ideas:{ref, take, skip}}.");
      try {
        if (ideaWords[1]) {
          const ideas = await deps.inspire.toggleIdea(projectId, Number(ideaWords[1]), ideaWords[2] ? ideaWords[2].toLowerCase() === "on" : undefined);
          const idea = [...ideas.take, ...ideas.skip].find((entry) => entry.n === Number(ideaWords[1]));
          return { project: projectId, text: `${idea.n} ${idea.title}: ${idea.on ? "on" : "off"}.`, data: { n: idea.n, on: idea.on } };
        }
        const ideas = await deps.inspire.answerIdeas(projectId, ideaWords[3].toLowerCase() === "allow" ? "allowed" : "held", input.note);
        const text = ideasAnswerText(ideas);
        await agentState.update(projectId, (state) => { state.inbox.push({ kind: "ideas", text }); });
        const on = [...ideas.take, ...ideas.skip].filter((idea) => idea.on).length;
        return { project: projectId, text: ideas.status === "allowed" ? `Allowed ${on} idea${on === 1 ? "" : "s"}: the agent adds them to the brief and plans them, and hears it on its next call.` : "Not yet: the agent hears it on its next call.",
          data: { ideas: ideas.id, status: ideas.status, on } };
      } catch (error) { throw new AgentError("bad_input", error.message); }
    }
    const [word, rest] = /^(save|unsave|cancel|measure|forget|copy|sounds|use|no)\b\s*(.*)$/i.exec(name)?.slice(1) ?? [null, name];
    const verb = word?.toLowerCase() ?? null;
    // sounds <n>: a sounds search ranked by how each sound matches its words and the person's taste.
    if (verb === "sounds") {
      const n = /^\d+$/.test(rest.trim()) ? Number(rest.trim()) : null;
      const view = n ? await deps.inspire.searchView(projectId, n) : null;
      if (!view || view.search.kind !== "sounds") throw new AgentError("bad_input", 'sounds names a sounds search by its number: library {topic:"inspire", name:"sounds 2"} (library {topic:"inspire"} lists them).');
      return { project: projectId, text: rankedSoundsText(view), data: { search: n, ranks: view.ranks } };
    }
    // use / no yt:<id> on a sound: the person's taste in sounds (kept across projects).
    if (verb === "use" || verb === "no") {
      const id = refId(rest);
      const entry = id ? await deps.inspire.soundTasteEntry(id) : null;
      if (!entry) throw new AgentError("bad_input", `${verb} names a measured sound effect: library {topic:"inspire", name:"${verb} yt:<id>"}.`);
      if (!byYou()) throw new AgentError("chat_only", `Only the person marks a sound ${verb === "use" ? "to use" : "as no"}, on the inspire screen.`);
      if (deps.soundTaste) await (verb === "use" ? deps.soundTaste.like(entry) : deps.soundTaste.reject(entry));
      const text = `${verb === "use" ? "use" : "no"} sound ${id} "${entry.title}"`;
      await agentState.update(projectId, (state) => { state.inbox.push({ kind: "note", text }); });
      return { project: projectId, text: `${verb === "use" ? "Use" : "No"}: ${entry.title}. Kept as your sound taste; the agent hears it on its next call.`, data: { id, taste: verb } };
    }
    // copy <project>: every reference another project saved is saved in this one too.
    if (verb === "copy") return copyReferences(projectId, rest.trim());
    // forget <n>: the project's search n goes (its references stay in kino's cache).
    if (verb === "forget") {
      const n = /^\d+$/.test(rest.trim()) ? Number(rest.trim()) : null;
      if (!n) throw new AgentError("bad_input", 'forget names a search by its number: library {topic:"inspire", name:"forget 2"} (library {topic:"inspire"} lists them).');
      let gone;
      try { gone = await deps.inspire.forget(projectId, n); } catch (error) { throw new AgentError("not_found", error.message); }
      return { project: projectId, text: `Forgot search ${n} ("${gone.query}").`, data: { forgot: n } };
    }
    if (verb === "cancel") {
      const id = rest ? refId(rest) : null;
      if (rest && !id) throw new AgentError("bad_input", `"${rest}" is not a YouTube reference (yt:<id> or a youtube.com link).`);
      const stopped = deps.inspire.cancel(id);
      return { project: projectId, text: stopped ? `Stopped measuring ${id ?? `${stopped} reference${stopped === 1 ? "" : "s"}`}.` : "Nothing was being measured.", data: { stopped } };
    }
    if (name) {
      // save yt:<id> as phone-film: the key a board's move.ref ("phone-film@3.13") and look versus use.
      const keyed = verb === "save" ? /^(.*?)\s+as\s+(\S+)$/i.exec(rest.trim()) : null;
      const key = keyed?.[2] ?? null;
      if (key && !/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(key)) throw new AgentError("bad_input", `"${key}" is not a reference key: letters, digits, - and _ (up to 48), such as phone-film or teaser-2026.`);
      const id = refId(keyed ? keyed[1] : rest);
      if (!id) throw new AgentError("bad_input", `"${rest}" is not a YouTube reference: use an id from the search, such as yt:dQw4w9WgXcQ, or a youtube.com link.`);
      let known = await deps.inspire.reference(id);
      // A video no search found yet (a link the person gave): kino reads its title and length
      // with yt-dlp (nothing is downloaded) and measures it like a search result.
      if (!known && verb !== "unsave") {
        try { known = await deps.inspire.add(projectId, id, { by }); }
        catch (error) { throw new AgentError(error.code === "NO_YTDLP" ? "unavailable" : "failed", `kino could not read ${id} from YouTube: ${error.message}`); }
      }
      if (!known) throw new AgentError("not_found", `${id} is not in kino's references.`);
      if (verb === "save" || verb === "unsave") {
        const count = await deps.inspire.setSaved(projectId, id, verb === "save", { key });
        const as = key ? ` as ${key.toLowerCase()} (a board move.ref "${key.toLowerCase()}@<seconds>" pins its moment for look versus)` : "";
        return { project: projectId, text: `${verb === "save" ? "Saved" : "Unsaved"} ${id}${as} in ${projectId} (${count} saved).`, data: { saved: count, ...(key ? { key: key.toLowerCase() } : {}) } };
      }
      if (verb === "measure") await deps.inspire.remeasure(id);
      if (!byYou() && agent) await deps.inspire.setLooking(projectId, id, by);
      const ref = await deps.inspire.reference(id, { wait: byYou() ? 0 : INSPIRE_WAIT_MS, full: true });
      // The text has the whole fingerprint; the data keeps the numbers and the suggested lines
      // (the brief's style line shape), not the long curves.
      const { fingerprint, stripList, ...short } = ref;
      return { project: projectId, text: referenceText(ref, { full: input.full === true }),
        data: { ref: short, ...(fingerprint ? { suggestions: suggestStyleLines(fingerprint, ref.numbers, ref.id) } : {}) } };
    }
    if (search) {
      const kind = input.kind ?? "videos";
      if (!SEARCH_KINDS.includes(kind)) throw new AgentError("bad_input", `kind is "videos" (edits to learn from), "shorts" (short vertical edits: YouTube Shorts) or "sounds" (sound effects, ${MAX_SOUND_SECONDS} s or less), not ${JSON.stringify(kind)}.`);
      // For a briefed video, its length (the brief's, else the scene's unless it is create's
      // default) drops results far longer than it; the search the step filled in offers its
      // song-free twin. A search for no video in particular drops by title only.
      const state = await agentState.read(projectId);
      const briefed = hasBrief(state.brief);
      const facts = briefed ? await videoFactsFor(record.document) : null;
      const seconds = briefed ? lengthTarget(state.brief)?.seconds ?? (facts.seconds > 0 && facts.seconds !== state.defaultLength ? facts.seconds : undefined) : undefined;
      const filled = kind === "videos" && briefed ? referenceSearches(state.brief, await songTitleFor(projectId)) : null;
      const alsoTry = songFreeTwin(filled, typed);
      let found;
      try { found = await deps.inspire.search(projectId, search, { by, count: input.count, kind, seconds }); }
      catch (error) { throw new AgentError(error.code === "NO_YTDLP" ? "unavailable" : "failed", error.message); }
      return { project: projectId, text: searchText(found.search.query, found.results, { kind, collapsed: found.collapsed ?? [], dropped: found.dropped ?? {}, droppedItems: found.droppedItems ?? [], alsoTry }), data: { search: found.search.n, kind, ...(Object.keys(found.dropped ?? {}).length ? { dropped: found.dropped, droppedIds: (found.droppedItems ?? []).map((item) => item.id) } : {}), results: found.results.map(({ numbers, ...ref }) => ref) } };
    }
    const view = await deps.inspire.projectView(projectId);
    return { project: projectId, text: projectText(view), data: { searches: view.searches.length, saved: view.saved } };
  }

  // library {topic:"inspire", name:"copy <project>"}: saves in this project each reference the
  // other project saved (an id or a name), so a new video of the same kind starts with them.
  async function copyReferences(projectId, from) {
    const projects = await store.listProjects();
    const source = projects.find((project) => project.id === from) ?? projects.find((project) => project.name === from);
    if (!from || !source) throw new AgentError("unknown_project", `copy names the project to copy saved references from: library {topic:"inspire", name:"copy <project>"}${from ? `; there is no project "${from}"` : ""}.`,
      { didYouMean: closest(from || "", projects.flatMap((project) => [project.id, project.name])).slice(0, 3) });
    const ids = (await deps.inspire.projectView(source.id)).saved;
    const copied = [];
    const missing = [];
    for (const id of ids) {
      // A reference kino no longer keeps is skipped and named; any other failure is reported.
      if (!(await deps.inspire.reference(id))) { missing.push(id); continue; }
      await deps.inspire.setSaved(projectId, id, true);
      copied.push(id);
    }
    const count = await deps.inspire.savedCount(projectId);
    return { project: projectId, text: `Copied ${copied.length} saved reference${copied.length === 1 ? "" : "s"} from ${source.id} to ${projectId} (${count} saved)${copied.length ? `: ${copied.join(", ")}` : ""}.${missing.length ? ` Skipped ${missing.join(", ")}: kino no longer keeps ${missing.length === 1 ? "it" : "them"}.` : ""}`,
      data: { copied, saved: count, ...(missing.length ? { missing } : {}) } };
  }

  // ---- soundtrack (backend/soundtrack.mjs): songs measured against the story -----------------
  // library {topic:"soundtrack"}: search {search, source?}, like:"<yt id>" (YouTube's mix for it;
  // "" uses the person's liked songs), measure:"<id>", note:{id, why, verdict}, name:"use <id>" or
  // "no <id>" (the person, from the inspire screen; kept as their taste in backend/songTaste.mjs),
  // or nothing (every candidate by fit). Candidates live in the project's agent state
  // (`soundtrack`), with the story they were compared against and each measured song's fit, so
  // the inspire screen draws them (dashboard agentSlice).
  // The video's spoken lines ([[from, to]] seconds) from saved transcripts only (no new
  // transcribing): sung vocals over them count against a song's fit.
  async function spokenSpans(scene, document) {
    const words = [];
    for (const layer of scene.layers ?? []) {
      if (!["audio", "video"].includes(layer.type) || !layer.src || layer.enabled === false) continue;
      let file;
      try { file = mediaFileOf(layer); } catch { continue; }
      if (await isMusicFile(file)) continue;
      const transcript = await transcripts.saved?.(file, document, layer);
      if (!transcript) continue;
      try { words.push(...speechWords(scene, [layer], transcript).filter((word) => !word.unclear)); } catch { /* not speech kino can place */ }
    }
    const spans = [];
    for (const word of words.sort((a, b) => a.start - b.start)) {
      const last = spans.at(-1);
      if (last && word.start - last[1] < 0.6) last[1] = Math.max(last[1], word.end);
      else spans.push([word.start, word.end]);
    }
    return spans;
  }

  // Songs an explore queued, measured one at a time after its answer (soundtrack.measure keeps its
  // own one-at-a-time queue). Each lands in the project's candidates with its measure and preview.
  // exploring holds the job per project, so a test or the next call can wait for it.
  const exploring = new Map();
  function measureQueued(projectId, ids) {
    const job = (exploring.get(projectId) ?? Promise.resolve()).then(async () => {
      for (const id of ids) {
        const entry = (await agentState.read(projectId)).soundtrack?.candidates?.find((item) => item.id === id);
        if (!entry || entry.measure) continue;
        let measure = null;
        let failed = null;
        try { measure = await deps.soundtrack.measure(entry); } catch (error) { failed = String(error.message ?? error).slice(0, 160); }
        await agentState.update(projectId, (draft) => {
          const item = draft.soundtrack?.candidates?.find((candidate) => candidate.id === id);
          if (!item) return;
          delete item.queued;
          if (measure) item.measure = measure;
          else item.failed = failed;
        });
      }
    }).catch(() => {});
    exploring.set(projectId, job);
    return job;
  }

  // library {topic:"footage"}: the project's found videos (search, scan, note). The answer's
  // update is applied to the saved footage state inside the call's own state update.
  async function footage(input) {
    if (!footageActions) throw new AgentError("failed", "The footage finder is not available here.");
    if (byYou()) throw new AgentError("chat_only", "The agent searches and scans footage.");
    const record = await projectFor(input);
    const projectId = record.document.id;
    const state = await agentState.read(projectId);
    const media = (await deps.listMedia?.().catch(() => [])) ?? [];
    let reply;
    const song = ({ signal } = {}) => songNeeds(record.document, media, signal);
    const personClips = personClipCount(record.document, media);
    const word = state.origin?.words?.[0]?.word;
    const origin = word && !personClips ? { word, about: state.brief?.fields?.about?.quote ?? state.brief?.fields?.about?.text ?? "" } : null;
    try { reply = await footageOrigin.run(origin, () => footageActions.handle(input, { footage: state.footage ?? null, personClips, song })); }
    catch (error) {
      if (!(error instanceof FootageError)) throw error;
      throw Object.assign(new AgentError(error.code, error.message), error.nextCall ? { nextCall: error.nextCall } : {});
    }
    const { update, ...answer } = reply;
    return done(projectId, answer, update ? { change(draft) { draft.footage = update(draft.footage ?? null); } } : undefined);
  }

  // Found-footage imports running now, by project, candidate and the shots or stretch asked (like
  // a footage scan): a repeated call joins the running one or collects its finished result.
  const footageTakes = new Map();

  // The lines each imported clip says in its own sound, for a clip of SAYS_MIN_SECONDS or more
  // that has sound (over -55 LUFS) and that the video's captions say nothing about: whisper reads
  // it once and keeps the transcript beside the file, so compose, checks and keep_line reuse it.
  // Returns {byId: {mediaId: lines}, missing} or null when there is nothing to say (take.mjs takeText).
  async function hearClips(media, captions, document) {
    const byId = {};
    let missing = null;
    for (const item of media) {
      const seconds = Number(item.duration) || 0;
      if (!(seconds >= SAYS_MIN_SECONDS) || item.hasAudio === false || !deps.mediaRoot) continue;
      if (captions?.lines && saysOf(captions.lines, Number(item.footage?.cutAt ?? item.footage?.start) || 0, seconds).length) continue;
      const file = path.join(deps.mediaRoot, item.id);
      if (!existsSync(file)) continue;
      try {
        if (!((await footageCache.sound(file)).loud > -55)) continue;
        const lines = clipLines(await transcripts.get(file, document, { src: item.src }));
        if (lines.length) byId[item.id] = lines;
      } catch (error) {
        if (/install/i.test(String(error?.message))) missing = "no speech model";
      }
    }
    return Object.keys(byId).length || missing ? { byId, missing } : null;
  }

  // project {action:"import", file:"F1", options:{shots}} (or F1.37, clip:<id>, from/to): shots of a
  // scanned found video become clips for this project (footage-finder/take.mjs), each with its
  // credit and code; the candidate keeps what it imported, for the 15 min a project cap.
  async function footageImport(input) {
    if (!deps.footage?.take) throw new AgentError("failed", "The footage finder is not available here.");
    const footageError = (error) => Object.assign(new AgentError(error.code, error.message), error.nextCall ? { nextCall: error.nextCall } : {});
    const record = await projectFor(input);
    const projectId = record.document.id;
    const state = await agentState.read(projectId);
    const file = input.file.trim();
    const asked = parseFootageRef(file);
    const candidate = asked && !asked.top ? (state.footage?.candidates ?? []).find((entry) => (asked.code ? entry.code === asked.code : entry.id === asked.id)) : null;
    if (!candidate) {
      throw Object.assign(new AgentError("not_found", `${file} is not one of this video's found videos: search and scan first, then import the scan's shots.`),
        { nextCall: asked?.id ? nextOf("library", { topic: "footage", scan: file }) : nextOf("library", { topic: "footage" }) });
    }
    const options = input.options && typeof input.options === "object" ? input.options : {};
    const from = input.from ?? options.from;
    const to = input.to ?? options.to;
    // A repeated call (the agent's tool call timed out or was cancelled) joins the import still
    // running, or collects its finished result, instead of downloading and adding the clips twice.
    const shotsAsked = (Array.isArray(options.shots) ? options.shots : options.shots === undefined ? [] : [options.shots]).map(String).sort();
    const key = `${projectId}\n${candidate.id}\n${JSON.stringify({ file, shots: shotsAsked, from: from ?? null, to: to ?? null })}`;
    let job = footageTakes.get(key);
    if (!job) {
      const scan = candidate.scan ? await deps.footage.readScan(scanIdOf(candidate)).catch(() => null) : null;
      let pieces;
      try { pieces = planTake(candidate, scan, { file, shots: options.shots, from, to, used: importedSeconds(state.footage) }); }
      catch (error) { if (error instanceof FootageError) throw footageError(error); throw error; }
      job = { pieces: pieces.length };
      // The job saves what it imported itself, so the 15 min cap counts it even when no call
      // collects the answer.
      job.promise = deps.footage.take(candidate, pieces, { projectId }).then(async (result) => {
        const seconds = result.media.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
        const shots = result.media.map((item) => item.footage?.shot).filter((n) => n !== null && n !== undefined);
        if (result.media.length) {
          await agentState.update(projectId, (draft) => {
            const entry = draft.footage?.candidates?.find((each) => each.id === candidate.id);
            if (!entry) return;
            entry.imported = { shots: [...new Set([...(entry.imported?.shots ?? []), ...shots])], seconds: Math.round(((Number(entry.imported?.seconds) || 0) + seconds) * 100) / 100 };
          });
        }
        // What the clips say: the video's captions (kept since the scan, so usually no new request).
        // Only for a clip long enough to carry a line; no captions, or a failure, adds nothing.
        const captions = result.media.some((item) => Number(item.duration) >= SAYS_MIN_SECONDS)
          ? await deps.footage.captions?.(candidate).catch(() => null) : null;
        // And, for a clip the captions say nothing about, what its own sound says (whisper).
        const heard = await hearClips(result.media, captions, record.document);
        return { value: { ...result, ...(captions?.lines ? { captions } : {}), ...(heard ? { heard } : {}) } };
      }).catch((error) => ({ error }));
      job.promise.finally(() => { setTimeout(() => { if (footageTakes.get(key) === job) footageTakes.delete(key); }, FOOTAGE_RESULT_KEEP_MS).unref?.(); });
      footageTakes.set(key, job);
    }
    let timer;
    const waited = await Promise.race([job.promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), deps.footageWaitMs ?? FOOTAGE_WAIT_MS); })]);
    clearTimeout(timer);
    const repeat = nextOf("project", { action: "import", file, ...(input.options !== undefined ? { options: input.options } : {}), ...(input.from !== undefined ? { from: input.from } : {}), ...(input.to !== undefined ? { to: input.to } : {}) });
    if (!waited) {
      return done(projectId, { text: `${candidate.code} is still importing ${job.pieces} piece${job.pieces === 1 ? "" : "s"} (download, then an exact cut and encode each). Send the same call again: it joins this import and waits for it.`,
        data: { importing: candidate.code }, nextCall: repeat });
    }
    // The answer is told once: the next same call imports again.
    if (footageTakes.get(key) === job) footageTakes.delete(key);
    if (waited.error) {
      const error = waited.error;
      if (error?.code === "BOT_CHECK") throw new AgentError("bot_check", 'YouTube asked for a bot check, so kino pauses YouTube downloads for 15 minutes (no cookies are ever sent). Use the person\'s own clips, or Commons: library {topic:"footage", search, source:"commons"}.');
      throw new AgentError("failed", `${candidate.code} could not be imported: ${String(error?.message ?? error).split("\n")[0].slice(0, 240)}`);
    }
    const result = waited.value;
    if (!result.media.length) throw new AgentError("failed", takeText(candidate, result));
    const media = (await deps.listMedia?.().catch(() => [])) ?? [];
    const lead = personClipsLine(personClipCount(record.document, media));
    const answer = { text: [lead, takeText(candidate, result)].filter(Boolean).join("\n"),
      data: { code: candidate.code, media: result.media.map(({ id, src, name, duration, width, height, footage }) => ({ id, src, name, duration, width, height, shot: footage?.shot ?? null })), failed: result.failed },
      nextCall: nextOf("look", { mode: "source" }) };
    return done(projectId, answer);
  }

  // The shots the video's song needs (footage-finder/needs.mjs): the first audio layer of the video
  // scene that plays like music and whose saved beats are a song's (steadyBeat: a voice scores
  // lower), over the stretch it plays; else the longest credited song of 20 s or more imported for
  // this project (not a library sound effect) with such beats, the whole song. Only the saved
  // .beats and .song files are read, never a decode: a finished scan answers at once, and
  // detect_beats or fit_music measure a song. Null without a measured song.
  async function songNeeds(document, media, signal) {
    const measured = async (file) => {
      if (signal?.aborted) return null;
      const analysis = await beatAnalysis.saved?.(file).catch(() => null);
      if (!steadyBeat(analysis)) return null;
      const shape = await songShapes.saved?.(file).catch(() => null);
      return shape ? { bpm: analysis.bpm, sections: shape.sections, seconds: shape.seconds } : null;
    };
    const scene = videoScene(document);
    const tried = new Set();
    for (const layer of scene?.layers ?? []) {
      if (!isMusicLayer(layer, scene)) continue;
      let file;
      try { file = mediaFileOf(layer); } catch { continue; }
      tried.add(file);
      const song = await measured(file);
      if (!song) continue;
      const range = mediaPlaybackRange(layer, scene.duration);
      return shotsNeeded({ ...song, ...(range && !range.remapped ? { from: range.offset, to: range.offset + range.duration } : {}) });
    }
    const songs = media.filter((item) => mediaAllowedIn(item, document.id) && String(item.mime ?? "").startsWith("audio/") && item.credit
      && !/^sfx:/.test(String(item.credit?.id ?? "")) && item.duration >= 20).sort((a, b) => b.duration - a.duration);
    for (const item of songs) {
      let file;
      try { file = mediaFileOf({ src: item.src ?? `/api/media/${item.id}` }); } catch { continue; }
      if (tried.has(file)) continue;
      const song = await measured(file);
      if (song) return shotsNeeded(song);
    }
    return null;
  }

  async function soundtrack(input, name, search) {
    if (!deps.soundtrack) throw new AgentError("failed", "Soundtrack search is not available here.");
    const record = await projectFor(input);
    const projectId = record.document.id;
    const state = await agentState.read(projectId);
    const scene = sceneFor(record.document, state.codes, input.scene, state.focus) ?? record.document.scenes[0];
    const intents = state.story?.intents?.[scene.id]?.beats ?? [];
    const story = { length: sec(scene.duration), beats: intents.map(({ from, to }) => ({ from, to })) };
    // YouTube junk kept from before the junk filter (type beats, BPM tracks, game levels) leaves the
    // list, unless the person picked it.
    const junk = (entry) => entry.source === "youtube" && !entry.picked && junkTitle(entry.title);
    if ((state.soundtrack?.candidates ?? []).some(junk)) {
      await agentState.update(projectId, (draft) => { draft.soundtrack.candidates = draft.soundtrack.candidates.filter((entry) => !junk(entry)); });
    }
    const kept = (state.soundtrack?.candidates ?? []).filter((entry) => !junk(entry));
    const find = (id) => {
      const wanted = String(id ?? "").trim();
      return kept.find((entry) => entry.id === wanted || entry.id === wanted.toLowerCase());
    };
    let taste = deps.songTaste ? await deps.songTaste.read() : { liked: [], rejected: [] };
    // Songs measured (or marked) before embeddings existed get one from their kept preview, once, so
    // earlier likes and rejects count by sound too.
    if (deps.soundtrack?.embedSaved && deps.musicEmbed && !deps.musicEmbed.failed?.()) {
      const missing = [...new Set([...kept.filter((entry) => entry.measure && !entry.measure.embedding), ...taste.liked, ...taste.rejected]
        .filter((entry) => !(entry.measure ? entry.measure.embedding : entry.embedding)).map((entry) => entry.id))].slice(0, 30);
      const found = {};
      for (const id of missing) {
        const embedding = await deps.soundtrack.embedSaved(id).catch(() => null);
        if (embedding) found[id] = embedding;
      }
      if (Object.keys(found).length) {
        for (const entry of kept) if (entry.measure && !entry.measure.embedding && found[entry.id]) entry.measure.embedding = found[entry.id];
        await agentState.update(projectId, (draft) => {
          for (const entry of draft.soundtrack?.candidates ?? []) if (entry.measure && !entry.measure.embedding && found[entry.id]) entry.measure.embedding = found[entry.id];
        });
        if (deps.songTaste?.fill) taste = await deps.songTaste.fill(found);
      }
    }
    const spoken = await spokenSpans(scene, record.document);
    // The brief (library soundtrack brief:{want, not}): CLAP text prompts, saved with the soundtrack.
    let brief = state.soundtrack?.brief ?? null;
    if (input.brief !== undefined) {
      if (byYou()) throw new AgentError("chat_only", "The agent writes the soundtrack brief from your words.");
      const want = String(input.brief?.want ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      const not = [input.brief?.not ?? []].flat().map((word) => String(word).replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 6);
      if (input.brief !== null && !want) throw new AgentError("bad_input", 'brief is {want:"upbeat, playful, modern electronic", not:["cinematic", "vocals"]}: want is the sound in words (a lane, mood, instruments), each not one thing to avoid. brief:null clears it.');
      brief = input.brief === null ? null : { want, not };
    }
    // Lane and brief vectors from CLAP's text model (backend/music-embed.mjs); null when it is off.
    // The text model loads only once a song has an embedding to compare with.
    const embed = deps.musicEmbed ?? null;
    const prompts = [...LANES.map((lane) => lane.prompt), ...(brief ? [brief.want, ...brief.not] : [])];
    let textJob = null;
    let scored = false;
    const textFor = (list) => {
      const any = [...list.map((entry) => entry.measure?.embedding), ...taste.liked.map((entry) => entry.embedding), ...taste.rejected.map((entry) => entry.embedding)].some(Boolean);
      if (!embed || !any) return Promise.resolve(null);
      textJob ??= embed.text(prompts).catch(() => null);
      return textJob;
    };
    // Every measured song's fit and the shortlist's order (backend/songTaste.mjs rankSongs): taste,
    // lane and brief first, story fit inside that.
    const rankAll = async (list) => {
      const vectors = await textFor(list);
      const lanes = vectors ? LANES.map((lane, index) => ({ id: lane.id, vector: vectors[index] })) : null;
      scored = Boolean(vectors && brief);
      const briefVectors = scored ? { want: vectors[LANES.length], not: vectors.slice(LANES.length + 1) } : null;
      return rankSongs(list, { taste, compare: (measure) => compareToStory(measure, story), spoken, length: story.length, lanes, brief: briefVectors });
    };
    const fitWords = (entry) => (entry.fit ? `  fit ${entry.fit.fit}${entry.fit.why ? ` (${entry.fit.why})` : ""}` : null);
    // Said once when the model could not load (no network on first use).
    const withNotice = (reply) => { const line = embed?.notice?.(); return line ? { ...reply, text: `${reply.text}\n${line}` } : reply; };
    // shared: the person's "use" and "no" are saved too (the list is theirs as much as the agent's).
    const save = async (candidates, reply) => {
      const ranked = await rankAll(keepCandidates(candidates));
      return done(projectId, withNotice(reply), { shared: true, change(draft) {
        draft.soundtrack = { candidates: ranked, story, ...(brief ? { brief } : {}) };
      } });
    };
    const storyLine = `story: ${story.beats.length ? `${plural(story.beats.length, "beat")} from notes intents` : "no intents yet, so the whole scene is one beat"} · ${story.length}s`;
    const briefLine = () => (brief ? `brief: want "${brief.want}"${brief.not.length ? `, not ${brief.not.map((word) => `"${word}"`).join(", ")}` : ""}${scored ? "" : " (scored once songs are measured with embeddings)"}` : null);
    if (input.brief !== undefined) {
      return save(kept, { text: brief ? `brief saved: want "${brief.want}"${brief.not.length ? `, not ${brief.not.map((word) => `"${word}"`).join(", ")}` : ""}. Measured songs rank by it; search with its words.` : "Brief cleared.", data: { brief } });
    }
    // The person marks one "use" on the inspire screen: the agent hears it in its inbox.
    const used = /^(use|no)\s+(\S+)$/i.exec(String(name ?? "").trim());
    if (used) {
      const yes = used[1].toLowerCase() === "use";
      if (!byYou()) throw new AgentError("chat_only", `Only the person marks a song ${yes ? "to use" : "as no"}, on the inspire screen. Note your verdict with library {topic:"soundtrack", note:{id, why, verdict}}.`);
      const entry = find(used[2]);
      if (!entry) throw new AgentError("not_found", `${used[2]} is not one of this video's soundtrack candidates.`);
      // Kept as the person's taste across projects: more like the liked ones, fewer like the rest.
      if (deps.songTaste) taste = await (yes ? deps.songTaste.like(entry) : deps.songTaste.reject(entry));
      const text = !yes
        ? `you said no to ${entry.id} '${entry.title}': songs like it now rank lower (library {topic:"soundtrack"})`
        : entry.source === "youtube"
          ? `you liked ${entry.id} '${entry.title}' for the soundtrack: project {action:"import", file:"${entry.id}"}, or more like it (library {topic:"soundtrack", like:"${entry.id}"})`
          : `you picked ${entry.id} '${entry.title}' for the soundtrack: project {action:"import", file:"${entry.id}"}`;
      await agentState.update(projectId, (draft) => { draft.inbox.push({ kind: "soundtrack", text }); });
      const next = kept.map((item) => (yes ? { ...item, picked: item.id === entry.id, ...(item.id === entry.id ? { rejected: false } : {}) }
        : item.id === entry.id ? { ...item, picked: false, rejected: true } : item));
      return save(next, { text: yes ? `Marked ${entry.title} to use: the agent hears it on its next call.` : `No to ${entry.title}: songs like it rank lower.`, data: { [yes ? "picked" : "rejected"]: entry.id } });
    }
    if (input.note !== undefined) {
      if (byYou()) throw new AgentError("chat_only", "The agent writes why a song fits; you mark one to use.");
      const note = input.note ?? {};
      const entry = find(note.id);
      if (!entry) throw new AgentError("not_found", "note.id is one of this video's candidates (library {topic:\"soundtrack\"} lists them).");
      if (!["pick", "maybe", "no"].includes(note.verdict)) throw new AgentError("bad_input", 'note.verdict is "pick", "maybe" or "no".');
      const why = String(note.why ?? "").replace(/\s+/g, " ").trim();
      if (why.length < 8 || why.length > 300) throw new AgentError("bad_input", "note.why says in 8 to 300 characters why the song fits this story or not (where its drop lands, how its energy follows the beats).");
      const next = kept.map((item) => (item.id === entry.id ? { ...item, note: { verdict: note.verdict, why } } : item));
      return save(next, { text: `${entry.id}: ${note.verdict} saved. The person sees it on the inspire screen.`, data: { id: entry.id, verdict: note.verdict } });
    }
    if (input.measure !== undefined) {
      const entry = find(input.measure);
      if (!entry) throw new AgentError("not_found", `${input.measure} is not a candidate yet: library {topic:"soundtrack", search} finds some.`);
      let measure;
      try { measure = await deps.soundtrack.measure(entry); } catch (error) { throw soundError(error); }
      const measured = { ...entry, measure };
      const compare = compareToStory(measure, story);
      const next = kept.map((item) => (item.id === entry.id ? measured : item));
      const sections = measure.sections.map((part) => `${part.kind} ${part.at}s`).join(", ") || "no clear sections";
      const { fit } = (await rankAll(next)).find((item) => item.id === entry.id);
      const f = measure.features;
      const sound = f ? `  sound: ${f.groove} · bass ${f.bass} · bright ${f.brightness} · dense ${f.density} · dynamic ${f.dynamics} · vocals ${f.vocals}${measure.vocalsBy === "guess" ? " (guessed: whisper is not installed)" : ""}: ${measure.vocals.map(([from, to]) => `${from}-${to}s`).slice(0, 8).join(", ") || "none"}` : null;
      return save(next, {
        text: [`measured ${entry.id}: ${measure.bpm ? `${Math.round(measure.bpm)} bpm (beat confidence ${measure.confidence})` : "no steady beat"} · ${measure.seconds}s · ${sections}`, sound, storyLine, compareText(measured, compare), fitWords({ fit }),
          `Write why it fits or not: library {topic:"soundtrack", note:{id:"${entry.id}", why, verdict:"pick"|"maybe"|"no"}}.`].filter(Boolean).join("\n"),
        data: { id: entry.id, bpm: measure.bpm, sections: measure.sections, features: measure.features, vocals: measure.vocals, compare, fit },
      });
    }
    if (input.song !== undefined) {
      // A song the person named ("Melatonin by Tinashe", or a YouTube link): found on YouTube,
      // marked picked (the person chose it), and measured in the background.
      if (!deps.soundtrack.findSong) throw new AgentError("failed", "Finding a song by name is not available here.");
      let hit;
      try { hit = await deps.soundtrack.findSong(input.song); } catch (error) { throw soundError(error); }
      const old = find(hit.id);
      const entry = { ...(old ?? hit), picked: true, rejected: false, named: String(input.song).trim().slice(0, 120), ...(old?.measure ? {} : { queued: true }) };
      const next = [...kept.filter((item) => item.id !== entry.id).map((item) => ({ ...item, picked: false })), entry];
      const text = [`found ${entry.id} '${entry.title}' by ${entry.creator} · ${entry.seconds}s for "${entry.named}": picked, since the person named it.`,
        `Import it: project {action:"import", file:"${entry.id}"}${old?.measure ? "" : `; its beats and drop are measured in the background (library {topic:"soundtrack"} shows them)`}.`].join("\n");
      const reply = await save(next, { text, data: { picked: entry.id, title: entry.title, creator: entry.creator, seconds: entry.seconds }, nextCall: nextOf("project", { action: "import", file: entry.id }) });
      if (!old?.measure) measureQueued(projectId, [entry.id]);
      return reply;
    }
    if (input.like !== undefined) {
      // More like a song: YouTube's mix for it, or for the person's liked YouTube songs.
      const asked = typeof input.like === "string" ? input.like.trim() : "";
      const seeds = asked ? [asked] : taste.liked.filter((entry) => entry.source === "youtube" || /^yt:/.test(entry.id)).slice(0, 3).map((entry) => entry.id);
      if (!seeds.length) throw new AgentError("bad_input", 'like is a YouTube song id (like:"yt:<id>"); with no id it uses the songs the person marked "use", and there are none yet.');
      const skip = new Set([...kept.map((entry) => entry.id), ...taste.rejected.map((entry) => entry.id), ...seeds]);
      const fresh = [];
      const notes = [];
      for (const seed of seeds) {
        let found;
        try { found = await deps.soundtrack.mix(seed); } catch (error) { if (asked) throw soundError(error); notes.push(`${seed}: ${error.message}`); continue; }
        for (const entry of found) if (!skip.has(entry.id)) { skip.add(entry.id); fresh.push({ ...entry, like: seed }); }
      }
      const lines = [`${plural(fresh.length, "new song")} like ${seeds.join(", ")} (YouTube's mix):`,
        ...fresh.map((entry) => `${entry.id} '${entry.title}' by ${entry.creator} · ${entry.seconds}s`), ...notes,
        fresh.length ? 'Measure the likely ones (library {topic:"soundtrack", measure:"<id>"}): measured songs rank by fit to the person\'s taste and the story.' : "Nothing new: try another seed song."];
      return save([...kept, ...fresh], { text: lines.join("\n"), data: { seeds, results: fresh.map(({ url, filetype, ...entry }) => entry), notes } });
    }
    if (input.explore !== undefined && input.explore !== false) {
      // Songs by lane from a music catalog (ListenBrainz genre tags, found on YouTube by artist and
      // title), then measured in the background one at a time so the music tab shows previews.
      if (!deps.soundtrack.explore) throw new AgentError("failed", "Explore is not available here.");
      const excluded = [...new Set(kept.filter((entry) => entry.fit?.excluded && entry.fit.lane).map((entry) => entry.fit.lane))];
      let scores = null;
      const vectors = brief ? await textFor(kept) : null;
      if (vectors) {
        const want = vectors[LANES.length];
        const nots = vectors.slice(LANES.length + 1);
        scores = Object.fromEntries(LANES.map((lane, index) => [lane.id, dot(vectors[index], want) - Math.max(0, ...nots.map((not) => dot(vectors[index], not)))]));
      }
      const lanes = exploreLanes({ brief, scores, excluded, count: Number(input.explore?.lanes) || 5 });
      const perLane = Math.max(2, Math.min(3, Number(input.explore?.per) || 2));
      const skip = new Set([...kept.map((entry) => entry.id), ...kept.map((entry) => `${entry.creator} - ${entry.title}`.toLowerCase()), ...taste.rejected.map((entry) => entry.id)]);
      let found;
      try { found = await deps.soundtrack.explore(lanes, { perLane, skip }); } catch (error) { throw soundError(error); }
      const fresh = found.results.filter((entry) => !find(entry.id)).map((entry) => ({ ...entry, queued: true }));
      const lines = [`explored ${lanes.join(", ")}${excluded.length ? ` (closed: ${excluded.join(", ")})` : ""}: ${plural(fresh.length, "song")} queued to measure:`,
        ...fresh.map((entry) => `${entry.id} '${entry.title}' by ${entry.creator} · ${entry.lane} (${entry.tags.join(", ")})`), ...found.notes.slice(0, 6),
        fresh.length ? `Measuring in the background, one at a time (about 20 s each). Wait, then list them ranked: library {topic:"soundtrack"}; a song still "not measured" is not done yet.` : "Nothing new: explore again with other lanes, or a brief."];
      const reply = await save([...kept, ...fresh], { text: lines.join("\n"), data: { lanes, queued: fresh.map((entry) => entry.id), notes: found.notes } });
      measureQueued(projectId, fresh.map((entry) => entry.id));
      return reply;
    }
    if (search) {
      let found;
      try { found = await deps.soundtrack.search(search, { source: input.source }); } catch (error) { throw soundError(error); }
      const fresh = found.results.filter((entry) => !find(entry.id));
      const lines = [`${plural(found.results.length, "song")} for "${found.query}":`,
        ...found.results.map((entry) => `${entry.id} '${entry.title}' by ${entry.creator} · ${entry.seconds}s${licenseTag(entry)}`),
        ...found.notes,
        found.results.length ? 'Measure the likely ones: library {topic:"soundtrack", measure:"<id>"}.' : 'Try other mood, genre or tempo words, or a song by name (song:"<title> by <artist>").'];
      if (found.results.some((entry) => entry.source === "openverse")) lines.push("Made using Openverse. Not endorsed or certified by Openverse.");
      return save([...kept, ...fresh], { text: lines.join("\n"), data: { results: found.results.map(({ url, filetype, ...entry }) => entry), notes: found.notes } });
    }
    const measuredRows = (await rankAll(kept)).filter((entry) => entry.fit).sort((a, b) => a.fit.order - b.fit.order);
    const rows = measuredRows.map((entry) => [compareText(entry, compareToStory(entry.measure, story)), fitWords(entry)].join("\n"));
    const tasteLine = `taste: ${plural(taste.liked.length, "liked song")}, ${plural(taste.rejected.length, "rejected song")}${taste.liked.length ? ` (more like them: library {topic:"soundtrack", like:""})` : ""}`;
    return done(projectId, withNotice({ text: kept.length ? [storyLine, briefLine(), tasteLine, ...rows, ...kept.filter((entry) => !entry.measure).map((entry) => `${entry.id} '${entry.title}'${licenseTag(entry)} · not measured`)].join("\n")
      : 'No soundtrack candidates yet: library {topic:"soundtrack", song:"<title> by <artist>"} (a song the person named), search:"<mood, genre, tempo words>", explore:true or like:"yt:<a song the person likes>".', data: { candidates: kept.length, measured: rows.length, ...(brief ? { brief } : {}), ranked: measuredRows.map((entry) => ({ id: entry.id, fit: entry.fit.fit, ...(entry.fit.lane ? { lane: entry.fit.lane } : {}) })) } }));
  }

  // edit {ops:[{op:"borrow_rhythm", ref, fit?, at?, scene?}]}: the reference's cut times as
  // set_cues marks (rhythm-1, …). Only the times come in; the reference is saved in the project.
  async function withBorrowedRhythm(ops, document, { dryRun = false } = {}) {
    if (!Array.isArray(ops) || !ops.some((op) => (op?.op ?? op?.type) === "borrow_rhythm")) return ops;
    if (!deps.inspire) throw new AgentError("failed", "Inspire is not available here.");
    const out = [];
    for (const op of ops) {
      if ((op?.op ?? op?.type) !== "borrow_rhythm") { out.push(op); continue; }
      const id = refId(op.ref);
      if (!id) throw new AgentError("bad_input", `borrow_rhythm needs ref: a reference from library {topic:"inspire"}, such as yt:dQw4w9WgXcQ. ${BORROW_HELP}`);
      const ref = await deps.inspire.reference(id);
      if (!ref) throw new AgentError("not_found", `${id} is not in kino's references: search for it first (library {topic:"inspire", search}).`);
      if (!ref.numbers) throw new AgentError("not_ready", `${id} is not measured yet (${numbersLine(ref)}). library {topic:"inspire", name:"${id}"} waits for its numbers.`);
      const wanted = op.scene ?? op.sceneId;
      const scene = wanted === undefined ? document.scenes[0] : document.scenes.find((entry) => entry.id === wanted || entry.name === wanted);
      if (!scene) throw new AgentError("bad_input", `No scene "${wanted}".`, { didYouMean: closest(String(wanted), document.scenes.flatMap((entry) => [entry.id, entry.name].filter(Boolean))) });
      const length = Number(scene.duration) || 0;
      const at = Math.max(0, Number(op.at) || 0);
      const fit = op.fit === true ? Math.max(0, length - at) : Number(op.fit) > 0 ? Number(op.fit) : null;
      // The song's seams (fit_music marks them song-...) are the sections the reference's pace maps onto.
      const seams = (document.cues ?? []).filter((cue) => cue.kind === "marker" && String(cue.name ?? "").startsWith("song-") && Number.isFinite(cue.time)).map((cue) => cue.time);
      const { cues } = rhythmCues(ref.numbers, { length, fit, at, seams });
      const remove = (document.cues ?? []).filter((cue) => cue.kind === "marker" && /^rhythm-\d+$/.test(cue.name) && !cues.some((entry) => entry.name === cue.name)).map((cue) => cue.name);
      out.push({ op: "set_cues", cues, ...(remove.length ? { remove } : {}) });
      if (!dryRun) await deps.inspire.setSaved(document.id, id, true).catch(() => {});
    }
    return ops.wrapped ? Object.assign(out, { wrapped: true }) : out;
  }

  // ---- project ----------------------------------------------------------------------------
  async function project(input) {
    const action = input.action ?? "list";
    if (action === "manage") {
      const options = input.options ?? {};
      const needsProject = ["comments", "shares", "csv", "exports"].includes(options.resource) || options.action === "move" || options.sourceAnimation || (options.resource === "document" && options.action === "export");
      const record = needsProject ? await projectFor({ project: input.id ?? input.project }) : null;
      if (options.resource === "exports" && (options.action ?? "start") === "start") {
        checkOutFolder(options.out);
        if (options.quality === "final") await refuseFinalWhileStopsOpen(record);
      }
      // The same approvals (D3) as render, project share and archive.
      const approvals = await manageApprovals(options, record);
      const waiting = await approvalFor(approvals.kinds, approvals.projectId ?? record?.document.id ?? String(options.id ?? ""), "project", input, approvals.rev);
      if (waiting) return waiting;
      const reply = options.resource === "exports" ? await manageExports(options, record) : await manageWorkspace(options, record);
      return record ? done(record.document.id, reply) : reply;
    }
    if (action === "list") return listProjects();
    // record {options:{step, …}}: screen recordings on this Mac (backend/recorder/recorder.mjs).
    if (action === "record") {
      if (!deps.recorder) throw new AgentError("failed", "Screen recording is not set up in this kino service.");
      const options = input.options ?? {};
      let result;
      try { result = await deps.recorder.step(options, { project: input.project ?? await readCurrent() }); }
      catch (error) { throw new AgentError(error.code === "permission" ? "permission" : /^(step|mark needs|Nothing is|A recording is already|folder|area|codec|keys|No such window|The area)/.test(error.message) ? "bad_input" : "failed", error.message); }
      const { text, ...data } = result;
      return { text: text ?? compact(data), data };
    }
    if (action === "create") {
      const id = input.id == null ? undefined : String(input.id);
      if (id !== undefined && !PROJECT_ID.test(id)) throw new AgentError("bad_input", "id is lowercase letters, digits and dashes, at most 63 characters (such as orbit-launch).");
      const width = input.width ?? 1920, height = input.height ?? 1080, duration = input.duration ?? 5;
      const document = createDocument({ ...(id ? { id } : {}), name: String(input.name ?? id ?? "New video").slice(0, 120) });
      document.scenes[0] = { ...document.scenes[0], name: String(input.scene ?? "Scene 1").slice(0, 120), width, height, duration, background: input.background ?? "#ffffff" };
      let created;
      try { created = await deps.createProject(parseDocument(document)); }
      catch (error) {
        if (error?.code === "ERR_DUPLICATE_PROJECT") throw new AgentError("exists", `Project "${id}" already exists. project open {id} opens it.`);
        throw new AgentError("bad_input", error.message);
      }
      await setCurrent(created.document.id);
      const codes = await syncCodes(created.document.id, created.document);
      const scene = created.document.scenes[0];
      // Without a duration the 5 s is kino's, not the video's length: the brief's next step does
      // not count the video as short while the scene keeps it (brief.mjs questionLimit).
      return done(created.document.id, { text: `created ${created.document.id} rev ${created.revision} and opened it · ${refName(scene.id, codes)} ${scene.width}×${scene.height} ${sec(scene.duration)}s bg ${scene.background}`, data: { project: created.document.id, rev: created.revision, scene: refName(scene.id, codes) } },
        { shared: true, change(draft) { draft.defaultLength = input.duration == null ? duration : null; } });
    }
    if (action === "open") {
      const record = await projectFor({ project: input.id ?? input.project });
      await setCurrent(record.document.id);
      return status({ project: record.document.id });
    }
    if (action === "duplicate") {
      const record = await projectFor({ project: input.id ?? input.project });
      const copy = await deps.duplicateProject(record.document.id);
      return { text: `duplicated ${record.document.id} as ${copy.document.id} ('${copy.document.name}'); project open {id:"${copy.document.id}"} switches to it.`, data: { project: copy.document.id } };
    }
    if (action === "archive") {
      const record = await projectFor({ project: input.id ?? input.project }, { open: false });
      const waiting = await approvalFor([{ kind: "delete-project", summary: `archiving ${record.document.id} ('${record.document.name}')` }], record.document.id, "project", input);
      if (waiting) return waiting;
      await deps.archiveProject(record.document.id);
      if (current === record.document.id) { current = null; await setCurrent(null); }
      return { text: `${record.document.id} moved to Trash; restore it with project {action:"manage", options:{resource:"trash", action:"restore", id:"${record.document.id}"}}, or the person can on the dashboard's projects screen.`, data: { archived: record.document.id } };
    }
    if (action === "share") {
      // A file capability link (view, comment or edit) for the person to send. Needs approval (D3).
      const record = await projectFor({ project: input.id ?? input.project }, { open: false });
      const role = input.role ?? "view";
      if (!["view", "comment", "edit"].includes(role)) throw new AgentError("bad_input", "role is view, comment or edit.");
      if (!deps.createShare) throw new AgentError("failed", "Share links are not available here.");
      const waiting = await approvalFor([{ kind: "share-link", summary: `a ${role} link to ${record.document.id}` }], record.document.id, "project", input);
      if (waiting) return waiting;
      const link = await deps.createShare(record.document.id, { role, label: String(input.name ?? "made by an agent").slice(0, 100) });
      return done(record.document.id, { text: `${role} link to ${record.document.id}: ${link.url} (anyone with it can ${role === "view" ? "watch" : role}; revoke it with project {action:"manage", id:"${record.document.id}", options:{resource:"shares", action:"revoke", id:"${link.id}"}}, or the person can on the dashboard's shares screen)`, data: { url: link.url, role, grant: link.id } });
    }
    // The MCP tool and the kino command ask first ({name, size}) and upload only on {ok:true}:
    // an import over your size limit needs approval (D3), and hold pauses imports.
    if (action === "import" && input.size !== undefined) {
      const size = Number(input.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new AgentError("bad_input", "size is the file's size in bytes.");
      const megabytes = deps.approvals?.limits?.().importMegabytes ?? Infinity;
      const projectId = input.project ?? await readCurrent();
      if (size > megabytes * 1024 * 1024 && projectId) {
        const record = await projectFor({ project: projectId }, { open: false });
        const waiting = await approvalFor([{ kind: "large-import", summary: `importing ${String(input.name ?? "a file").slice(0, 80)} (${Math.round(size / 1024 / 1024)} MB, over ${megabytes} MB)` }], record.document.id, "project",
          { action: "import", name: input.name, size, project: record.document.id });
        if (waiting) return waiting;
      }
      // The upload belongs to the open project (as the app's imports do), so look source lists it.
      let owner = null;
      if (projectId) try { const found = await projectFor({ project: projectId }, { open: false }); owner = found.trashedAt ? null : found.document.id; } catch { /* no such project: a library file */ }
      return { text: "import ok", data: { ok: true, ...(owner ? { project: owner } : {}) } };
    }
    // A YouTube sound effect from library {topic:"inspire", search, kind:"sounds"}, measured: its
    // short preview comes in with its credit. source or file names it.
    if (action === "import" && input.file === undefined && typeof input.source === "string") input = { ...input, file: input.source };
    // Found footage: F1 or F1.37 (with options {shots} or from/to), or clip:yt-<id> (footage-finder/take.mjs).
    if (action === "import" && typeof input.file === "string" && /^(?:clip:|F\d{1,3}(?:\.\d+)?$)/i.test(input.file.trim())) return footageImport(input);
    if (action === "import" && typeof input.file === "string" && /^yt:/i.test(input.file.trim()) && deps.inspire) {
      const id = refId(input.file.trim());
      let ref = id ? await deps.inspire.reference(id) : null;
      // Not measured yet: it goes to the front of the queue and the import waits for it (a sound
      // effect measures in a few seconds; a long video queue never holds it back).
      if (ref?.kind === "sound" && !ref.sound) ref = await deps.inspire.reference(id, { wait: 60_000 });
      if (ref?.kind === "sound") {
        if (!ref.sound) throw new AgentError("not_ready", `${id} is not measured yet (${numbersLine(ref)}). library {topic:"inspire", name:"${id}"} waits for it.`);
        let media;
        try { media = await deps.inspire.importSound(id); } catch (error) { throw new AgentError("failed", error.message); }
        if (media) return { text: `${importedText(media)}\ncredit kept with the file: ${media.credit.line}.`, data: { media } };
      }
    }
    // A soundtrack candidate: an Openverse or Internet Archive song keeps its license and credit; a YouTube
    // song comes in whole. The credit stays with the file as metadata (the final render lists sources).
    if (action === "import" && typeof input.file === "string" && /^(yt|openverse|archive):/i.test(input.file.trim())) {
      const record = await projectFor(input);
      let song;
      try { song = importableId(input.file, (await agentState.read(record.document.id)).soundtrack?.candidates ?? []); } catch (error) { throw soundError(error); }
      if (song && deps.soundtrack) {
        let media;
        try { media = await deps.soundtrack.importCandidate(song); } catch (error) { throw soundError(error); }
        // The song is measured once, now (its beat, in .beats): check knows it is music and never
        // transcribes it; detect_beats and fit_music read the same file.
        if (media?.id && deps.mediaRoot) await beatAnalysis.get(path.join(deps.mediaRoot, media.id)).catch(() => null);
        return { text: `${importedText(media)}\ncredit kept with the file: ${media.credit.line}.`, data: { media } };
      }
      if (/^yt:/i.test(input.file.trim())) {
        const ref = input.file.trim();
        throw Object.assign(new AgentError("reference_only", `${ref} is not one of this video's songs yet. As the song: library {topic:"soundtrack", song:"${ref}"}, then import it; as footage: library {topic:"footage", scan:"${ref}"}`), { nextCall: nextOf("library", { topic: "soundtrack", song: ref }) });
      }
      if (/^archive:/i.test(input.file.trim())) throw new AgentError("not_found", `${input.file.trim()} is not one of this video's songs: find it first (library {topic:"soundtrack", search}).`);
    }
    // A built-in library sound or track (sfx:<id>, music:<id>): downloaded once, kept with its credit.
    if (action === "import" && isLibraryId(input.file)) {
      if (!deps.soundLibrary) throw new AgentError("failed", "The sound library is not available here.");
      let media;
      try { media = await deps.soundLibrary.importItem(input.file); } catch (error) { throw soundError(error); }
      // A track is measured once, now (its beat), as a soundtrack import is.
      if (media?.id && deps.mediaRoot && input.file.trim().startsWith("music:")) await beatAnalysis.get(path.join(deps.mediaRoot, media.id)).catch(() => null);
      return { text: `${importedText(media)}\ncredit kept with the file: ${media.credit.line}.`, data: { media } };
    }
    // An Openverse sound (openverse:<id> from library sounds name:"openverse"): kino downloads it with its credit.
    if (action === "import" && (isOpenverseId(input.file) || isFreesoundId(input.file))) {
      if (!deps.soundSearch) throw new AgentError("failed", "Sound search is not available here.");
      let media;
      try { media = await deps.soundSearch.importSound(input.file); } catch (error) { throw soundError(error); }
      return { text: `${importedText(media)}\ncredit kept with the file: ${media.credit.line} (${media.credit.file}).`, data: { media } };
    }
    if (action === "import") throw new AgentError("bad_input", "Import reads a local file, so the MCP tool or the kino command does it: project {action:\"import\", file}.");
    // new, make and add are create.
    const create = ["new", "make", "add", "start", "init"].includes(String(action).toLowerCase())
      ? ' project {action:"create", id:"spring-launch", name:"Spring launch", width:1920, height:1080, duration:6} makes a new one.' : "";
    throw new AgentError("bad_input", `Unknown project action "${action}".${create}`, { didYouMean: closest(action, ["list", "create", "open", "duplicate", "archive", "import", "share", "manage"]) });
  }

  // Which manage actions the person approves first: a share link, deleting a file forever,
  // deleting a folder (its projects go to Trash), and a final export over their frame limit.
  // Returns { kinds, projectId?, rev? }; projectId is where the approval shows when no project is
  // named, and rev is the revision a final export draws.
  async function manageApprovals({ resource, action, ...options }, record) {
    if (resource === "shares" && action === "create") return { kinds: [{ kind: "share-link", summary: `a ${options.role ?? "view"} link to ${record.document.id}` }] };
    if (resource === "trash" && action === "delete") return { kinds: [{ kind: "delete-project", summary: `deleting ${options.id} forever` }] };
    if (resource === "folders" && action === "delete") {
      const folder = (await store.listFolders()).find((entry) => entry.id === options.id);
      const projects = await store.listProjects();
      const inside = folder ? projects.filter((entry) => entry.folderId === folder.id) : [];
      if (!inside.length) return { kinds: [] };
      const names = inside.slice(0, 5).map((entry) => `${entry.id} ('${entry.name}')`).join(", ");
      // The answer goes to the inbox of the project the agent has open, if it is still there. The
      // approval keeps the projects' ids: if more are in the folder when you allow it, it asks again.
      const open = await readCurrent();
      return { projectId: projects.some((entry) => entry.id === open) ? open : inside[0].id, kinds: [{ kind: "delete-project", targets: inside.map((entry) => entry.id),
        summary: `archiving ${plural(inside.length, "project")} by deleting folder '${folder.name}': ${names}${inside.length > 5 ? `, and ${inside.length - 5} more` : ""}` }] };
    }
    if (resource !== "exports" || (action ?? "start") !== "start" || options.quality !== "final") return { kinds: [] };
    const settings = options.options;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { kinds: [] };
    const frameLimit = deps.approvals?.limits?.().finalRenderFrames ?? Infinity;
    // The scenes the exporter will draw (the same choice: every scene named in sceneIds, a main
    // component too, or every scene but the components), with options.duration, fps (60 for
    // Lottie when left out) and playback.
    const scenes = selectedScenes(record.document, options.sceneIds).map((id) => record.document.scenes.find((scene) => scene.id === id));
    const frames = scenes.reduce((sum, scene) => sum + plannedFrameCount(scene, settings), 0);
    return { rev: record.revision, kinds: frames > frameLimit ? [{ kind: "final-render", summary: `a final ${settings.format ?? settings.profile ?? "export"} of ${plural(scenes.length, "scene")} at rev ${record.revision} (${frames} frames, over ${frameLimit})` }] : [] };
  }

  // ---- entry point ------------------------------------------------------------------------
  const handlers = { status, edit, check, look: lookAt, inspect, render, library, history, notes, project };

  /**
   * Runs one verb. `meta.by` is "you" when a person (not the agent) acted, such as a revert
   * from the command line with --you; `meta.client` names the caller for the event log.
   */
  // An answer longer than this many tokens is saved to a file; the agent gets its first lines
  // and the path, so one call can never flood its context. A share link's URL (project share,
  // or the one render wait Q… that hands it over) is a secret given once: it stays in the
  // answer, in full, and the saved file leaves every share secret out.
  async function capAnswer(reply, verb, projectId, next = null) {
    if (estimateTextTokens(reply.text) <= ANSWER_TOKEN_LIMIT) return reply;
    const directory = path.join(agentDirectory, "out", encodeURIComponent(String(projectId ?? "_")));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${verb}-${randomUUID().slice(0, 8)}.txt`);
    const saved = hideShareSecrets(reply.text);
    await writeFile(file, saved, { mode: 0o600 });
    const link = {};
    for (const key of ["url", "desktopUrl"]) if (typeof reply.data?.[key] === "string") link[key] = reply.data[key];
    const lines = saved.split("\n");
    const shown = [...lines.slice(0, 3).map((line) => line.slice(0, 300)), ...Object.entries(link).map(([key, value]) => `${key}: ${value}`)];
    const narrower = NARROWER_CALL[verb];
    const text = `${shown.join("\n")}\n… ${lines.length} lines, about ${estimateTextTokens(reply.text)} tokens: too long to send. The whole answer${link.url ? " (without the link's secret)" : ""} is in ${file}${narrower ? `\nA smaller answer: ${narrower}` : ""}${next ? `\nnext: ${callText(next)}` : ""}`;
    return { ...reply, text, data: { file, lines: lines.length, ...link, ...(reply.isError ? { error: reply.data?.error } : {}) } };
  }

  // What the dashboard shows about a call besides its summary: tokens each way (kino's own MCP
  // traffic), the turn, the new revision, what was asked (cut short) and approval or hold state.
  // `refusedFor`: the stop that refused this write (status says waiting too, but was not refused).
  function callDetails(input, reply, finish, meta, refusedFor) {
    const imageTokens = (reply.images ?? []).reduce((sum, image) => sum + pngTokens(image.data), 0);
    const asked = input && typeof input === "object" ? compact(input) : "{}";
    return {
      tokens: estimateTextTokens(reply.text) + imageTokens,
      inTokens: estimateTextTokens(asked),
      input: asked.length > 600 ? `${asked.slice(0, 599)}…` : asked,
      ...(finish?.turn ?? reply.data?.turn ? { turn: finish?.turn ?? reply.data.turn } : {}),
      ...(Number.isSafeInteger(reply.data?.rev) ? { rev: reply.data.rev } : {}),
      ...(reply.data?.status === "awaiting_approval" ? { approval: reply.data.id } : {}),
      ...(reply.data?.held ? { held: true } : {}),
      ...(reply.data?.status === "waiting_for_you" ? { stop: reply.data.id } : {}),
      ...(refusedFor ? { waiting: refusedFor } : {}),
      // The crew refused it (crew.mjs): stopped, denied, budget, held, or waiting for a held part.
      ...(typeof reply.data?.crew === "string" ? { crew: reply.data.crew } : {}),
      ...(meta.approved ? { approved: true } : {}),
    };
  }

  // ---- the live view (milestone LIVE) ------------------------------------------------------
  // Every agent call is published twice as a presence (live.mjs): "start" before its handler
  // runs, with what its input names, and "done" after its call event, with what it read or
  // changed. Calls by the person (by:"you"), the dashboard's quiet reads and unknown verbs are not.
  // These never refuse a call, and they add no read of the project store (which reads every
  // project at once): "start" names layers from the project as the last call or save left it
  // (liveDocs), and "done" from the project the call's answer read. A failure only skips them.
  const liveDocs = new Map();
  const LIVE_DOCS_KEPT = 32;
  function rememberLive(projectId, document) {
    if (!deps.live || !projectId || !document) return;
    liveDocs.delete(String(projectId));
    liveDocs.set(String(projectId), document);
    if (liveDocs.size > LIVE_DOCS_KEPT) liveDocs.delete(liveDocs.keys().next().value);
  }
  async function liveDocument(wanted) {
    if (liveDocs.has(wanted)) return liveDocs.get(wanted);
    // The first call on a project since kino started reads it once.
    const record = await store.getProject(wanted).catch(() => null);
    if (!record || record.trashedAt) return null;
    rememberLive(record.document.id, record.document);
    return record.document;
  }

  // What a call's input names, before it runs: the scene, layers, time or range it asks about.
  function askedTarget(verb, input, document, codes, focus) {
    if (!document?.scenes?.length) return null;
    let resolver;
    try { resolver = createResolver(document, codes ?? undefined); } catch { return null; }
    const find = (ref, kind) => { try { return typeof ref === "string" && ref ? resolver.resolve(ref, kind) : null; } catch { return null; } };
    const sceneOfLayer = (id) => document.scenes.find((scene) => scene.layers.some((layer) => layer.id === id))?.id ?? null;
    const sceneId = find(input.scene, "scene") ?? (document.scenes.some((scene) => scene.id === focus) ? focus : document.scenes[0].id);
    const has = Number.isFinite;
    if (verb === "look") {
      const mode = input.mode ?? "sheet";
      const layerId = ["zoom", "source"].includes(mode) ? find(input.layer, "layer") : null;
      const duration = document.scenes.find((scene) => scene.id === sceneId)?.duration ?? 0;
      const range = mode === "sheet" && (has(input.from) || has(input.to)) ? [has(input.from) ? input.from : 0, has(input.to) ? input.to : duration] : null;
      return { sceneId: layerId ? sceneOfLayer(layerId) : sceneId, layerIds: layerId ? [layerId] : [], time: has(input.t) ? input.t : null, range };
    }
    if (verb === "inspect") {
      const layerIds = (Array.isArray(input.targets) ? input.targets : []).map((target) => find(String(target), "layer")).filter(Boolean);
      return { sceneId: sceneOfLayer(layerIds[0]) ?? sceneId, layerIds };
    }
    if (verb === "edit") {
      const ops = Array.isArray(input.ops) ? input.ops.slice(0, 50) : [];
      const layerIds = [...new Set(ops.flatMap((op) => [op?.layer, op?.layerId, ...(Array.isArray(op?.layers) ? op.layers : []), ...(Array.isArray(op?.layerIds) ? op.layerIds : [])])
        .map((ref) => find(ref, "layer")).filter(Boolean))];
      const named = ops.map((op) => find(op?.scene ?? op?.sceneId, "scene")).find(Boolean);
      return { sceneId: sceneOfLayer(layerIds[0]) ?? named ?? sceneId, layerIds };
    }
    if (verb === "status" || verb === "check") return { sceneId: verb === "check" && !input.scene ? null : sceneId };
    return null;
  }

  // An approved call that runs again when you click allow (meta.approved) is not the agent at work
  // now: it publishes no presence (no marker, no "went quiet"), but what it saves still marks
  // building ({type:"building"}).
  async function liveStart(verb, input, meta) {
    try {
      const asked = input && typeof input === "object" ? input : {};
      const replay = Boolean(meta.approved);
      const agent = replay ? meta.agent ?? null : deps.live.identify({ session: meta.session, kind: meta.client });
      const wanted = typeof asked.project === "string" ? asked.project : await readCurrent();
      const document = wanted ? await liveDocument(String(wanted)) : null;
      const state = document ? await agentState.read(document.id) : null;
      const codes = state?.codes ?? null;
      const projectId = document?.id ?? null;
      // This call starts a new turn (finishCall): the last turn's marks go before it is shown.
      const newTurn = Boolean(state && turnOver(state, now()));
      if (newTurn) deps.live.endTurn(projectId);
      const live = { agent, replay, projectId, verb, call: deps.live.nextCall(), label: callLabel(verb, asked, { document, codes }), write: isWrite(verb, asked), saves: [], where: null, covers: null, drew: null, said: meta.said ?? null };
      const target = askedTarget(verb, asked, document, codes, state?.focus);
      live.asked = target ? callTarget(document, codes, target) : null;
      if (!replay) deps.live.show(projectId, { agent, call: live.call, phase: "start", verb, label: live.label, write: live.write, target: live.asked, changed: null,
        building: deps.live.building(projectId, document), turn: newTurn ? null : deps.live.turn(projectId), isError: false, ms: null, ...(live.said ?? {}) });
      return live;
    } catch { return null; }
  }

  // `outcome`: held (you paused writes) or refused (a stop waits) when the write did not run.
  async function liveDone(live, { projectId, known, reply, finish, ms, outcome = null }) {
    const id = known && !known.trashedAt ? known.document.id : null;
    const document = id ? known.document : null;
    const state = id ? await agentState.read(id) : null;
    const codes = state?.codes ?? null;
    // An edit gives its turn in its answer; other calls in finishCall's.
    const turn = finish?.turn ?? reply.data?.turn ?? null;
    const turnWas = id ? deps.live.turn(id) : null;
    if (turn) deps.live.noteTurn(id, turn);
    let changed = null;
    if (id && live.saves.length) {
      const before = live.saves[0].before;
      const after = live.saves.at(-1).after;
      if (live.agent) deps.live.wrote(id, document, { agentId: live.agent.id, layers: touchedLayers(before, after), rev: live.saves.at(-1).rev });
      const focus = editFocus(before, after);
      if (focus) {
        const { sceneId, layerIds, range } = focus;
        changed = { sceneId, layerIds, range, text: callTarget(document, codes, { sceneId, layerIds, range }).text };
      }
    }
    if (id && live.verb === "look" && !reply.isError && live.covers && live.drew) deps.live.looked(id, live.covers, live.drew);
    // A call that ended the turn (the agent's own revert or restore: turnBreak) clears its marks
    // now, as the agent's next call would; the done presence below carries the empty list.
    const ended = Boolean(state?.turns.length && turnOver(state, now()) && deps.live.endTurn(id));
    if (live.replay) {
      if (id && (live.saves.length || ended || (turn && turn !== turnWas))) deps.live.showBuilding(id, document);
      return;
    }
    const target = live.where ? callTarget(document, codes, live.where)
      : changed ? callTarget(document, codes, changed) : live.asked;
    // `approval`: the call waits for your approval and has not run yet (approvalFor).
    const approval = reply.data?.status === "awaiting_approval" && typeof reply.data.id === "string" ? reply.data.id : null;
    deps.live.show(id ?? (projectId ? String(projectId) : null), { agent: live.agent, call: live.call, phase: "done", verb: live.verb, label: live.label, write: live.write,
      target, changed, building: deps.live.building(id, document), turn: turn ?? deps.live.turn(id), isError: Boolean(reply.isError), ms,
      ...(outcome?.held ? { held: true } : {}), ...(outcome?.refused ? { refused: outcome.refused } : {}), ...(approval ? { approval } : {}), ...(live.said ?? {}) });
  }

  // A call that threw after it was shown as started is still shown as done, failed: the marker
  // never waits for a call that is over.
  function liveFailed(live, ms) {
    if (live.replay) return;
    deps.live.show(live.projectId, { agent: live.agent, call: live.call, phase: "done", verb: live.verb, label: live.label, write: live.write,
      target: live.asked, changed: null, building: deps.live.building(live.projectId), turn: deps.live.turn(live.projectId), isError: true, ms });
  }

  // Your undo, restore or note ends the agent's turn: its building marks go at once, not on the
  // agent's next call.
  async function liveAfterYou(projectId, known) {
    if (!projectId || !known || known.trashedAt) return;
    const id = known.document.id;
    if (turnOver(await agentState.read(id), now()) && deps.live.endTurn(id)) deps.live.showBuilding(id, known.document);
  }

  // The same after your answer to a stop on the dashboard (POST stops: an answer, a reopen or
  // keep asking), which is not a call: it ends the agent's turn too (stops.mjs turnBreak).
  async function afterYourStop(projectId) {
    if (!deps.live) return;
    await liveAfterYou(projectId, await store.getProject(String(projectId)).catch(() => null)).catch(() => {});
  }

  // ---- one exact next call (next-call.mjs) -------------------------------------------------
  // Every answer ends with the most likely next call. A handler that knows it sets
  // reply.nextCall ({tool, input}); otherwise it comes from the verb, the answer and the
  // project: the direction (brief, plan, stops), then the build steps (buildNext).

  // A first compose for an empty video: its shape and length (the brief's, when it has one).
  // Never the brief's message as a text slide (that reads as cheap): with imported
  // clips, an edit cut from them; else a hero beat on the product's picture, or a beat the agent
  // picks to show its idea.
  async function composeCall(document, state) {
    const scene = document.scenes.find((entry) => !entry.isComponent) ?? document.scenes[0];
    const ratio = scene ? scene.width / scene.height : 16 / 9;
    const format = ratio > 1.2 ? "16:9" : ratio < 0.8 ? "9:16" : "1:1";
    const target = lengthTarget(state.brief)?.seconds;
    const duration = target ?? sec(scene?.duration ?? 15);
    const media = ((await deps.listMedia?.().catch(() => [])) ?? []).filter((item) => mediaAllowedIn(item, document.id) && typeof item.name === "string");
    const clips = media.filter((item) => /^video\//.test(item.mime ?? "")).slice(0, MAX_FOOTAGE).map((item) => item.name);
    // Footage sends a length only when the brief sets one: without it the planner sizes the
    // edit to the speech worth hearing (footage/plan.js), not to the empty scene's default.
    if (clips.length) return nextOf("edit", { ops: [{ op: "compose", footage: clips, format, ...(target >= 6 ? { duration: target } : {}) }] });
    const picture = await productPicture(document.id);
    const hero = picture ? { recipe: "device-slide", media: picture, text: "<what it shows>" }
      : { recipe: '<a beat that shows your idea: library {topic:"blocks"}>', text: "<its words>" };
    // No fixed closing recipe: the last beat answers this video's hook (a named end card became every ending).
    return nextOf("edit", { ops: [{ op: "compose", format, duration, beats: [hero, { recipe: '<a recipe for the beat that answers your hook: library {topic:"blocks"}>', text: "<its words>" }] }] });
  }

  // The build steps, in order: an empty video gets a compose; then check {fix:"auto"} on this
  // revision; a blocking error's own fix; the stops; look review until every moment is
  // reviewed; then the final render. The direction (brief, plan, a waiting stop) comes first.
  // advice:false (the answer to a read or a write while building) leaves out the brief's
  // advice (a playback, guessed lines, the plan, references, material, a stop before the
  // check): status and notes say it. A video with no brief, a waiting stop's answer and a
  // redo's fix still come first.
  async function buildNext(projectId, { advice = true } = {}) {
    const record = projectId ? await store.getProject(String(projectId)).catch(() => null) : null;
    if (!record || record.trashedAt) return nextOf("project", { action: "list" });
    const document = record.document;
    const state = await agentState.read(document.id);
    const video = await directionFacts(document);
    const move = statusMove(state, video, stopRulesNow());
    if (move.call && (advice || !hasBrief(state.brief) || !isAdvice(move.call))) return move.call;
    // Past a rough first pass with no locked direction: edit receipts name the lock call too.
    const lock = lockNeeded(state, video);
    if (lock) return lock.call;
    if (!hasLayers(document)) return await composeCall(document, state);
    if (state.checked?.rev !== record.revision) return nextOf("check", { fix: "auto" });
    const codes = await syncCodes(document.id, document);
    const fonts = await fontsFor(document);
    if (state.checked.errors) {
      const { findings } = await findingsFor(document, { fonts, codes });
      const blocking = findings.find((finding) => finding.severity === "error" && !finding.waived);
      if (blocking?.fix && typeof blocking.fix === "object") return nextOf("edit", { ops: Array.isArray(blocking.fix) ? blocking.fix : [blocking.fix] });
      if (blocking) return nextOf("inspect", { targets: [String(blocking.ref)] });
    }
    // A warning that holds only the final render (FINAL_GATES: signature_missing): its fix comes
    // before the passes a new edit would redo, so the next call never walks into the refusal.
    if (state.brief?.style?.idea || signatureRanges(state.brief?.style).length) {
      const { findings } = await findingsFor(document, { fonts, codes });
      const held = findings.find((finding) => finding.severity === "warn" && blocksFinal(finding) && (finding.final === true || FINAL_GATES.includes(finding.rule)));
      if (held) return nextOf("edit", { ops: [`<the edit for: ${String(held.fix?.text ?? held.message).slice(0, 160)}>`] });
    }
    // The rest are the final render's gates, in finalGates' order (the first one still open).
    const [gate] = await finalGates(record, { first: true });
    return gate?.call ?? FINAL_CALL;
  }

  const FINAL_CALL = nextOf("render", { action: "start", quality: "final", wait: true });
  // The scenes a final render of the whole video renders: not components, not other variants.
  const wholeScenes = (document) => document.scenes.filter((scene) => !scene.isComponent && !(scene.variant && scene.variant.of !== scene.id));

  // Every final-render gate still open, [{code, words, call}], in the order that redoes the least
  // work: a waiting stop, the direction lock and the needs, the stops the person's settings still
  // ask, then the passes that lead to edits (intents and the viewer, the critic), then the check
  // of the result, look review and versus on the rev that renders. The same conditions
  // as the render's refusals (refuseWithoutLock ... refuseWithoutNeeds), without the person's own
  // calls and stills, which skip them. Check errors only pixels find (contrast) show up at the
  // render's own check. `first` stops at the first gate (buildNext); `scenes` and `options` are
  // the render's (a cut-short render skips the whole-video gates).
  async function finalGates(record, { scenes = null, options = {}, first = false } = {}) {
    const document = record.document;
    const state = await agentState.read(document.id);
    const codes = await syncCodes(document.id, document);
    const fonts = await fontsFor(document);
    const rendered = scenes ?? wholeScenes(document);
    const whole = rendered.filter((scene) => !(Number.isFinite(options?.duration) && options.duration < scene.duration - 0.01));
    const sceneField = (scene) => (document.scenes.length > 1 ? { scene: refName(scene.id, codes) } : {});
    const waivers = document.checkWaivers ?? [];
    const waived = (code, scene) => waivers.some((waiver) => waiver.code === code && (waiver.target === "*" || waiver.target === scene.id));
    const gates = [];
    const add = (code, words, call) => { gates.push({ code, words, call }); return first; };
    const waiting = waitingStop(state);
    if (waiting && add("stops_open", `${waiting.id} waits: end your turn`, nextOf("notes", { action: "answer", id: waiting.id, rev: waiting.rev, words: "<their reply, word for word>", read_as: "approve" }))) return gates;
    const lock = lockNeeded(state, videoFacts(document));
    if (lock && add("direction_needed", "notes brief (lock the direction)", lock.call)) return gates;
    if (whole.length && !whole.some((scene) => waived(NEEDS_WAIVER, scene))) {
      const open = openNeeds(state.needs);
      if (open.length) { if (add("needs_open", `notes needs (${open.map((need) => need.id).join(" ")})`, needNextCall(open[0]))) return gates; }
      else if (!state.needs?.checked) {
        for (const scene of whole) {
          if (scene.duration < VIEWER_UNDER || !(await hasFootageOrSpeech(scene, document))) continue;
          if (add("needs_unchecked", "notes needs (check the material)", needsAskCall(state))) return gates;
          break;
        }
      }
    }
    // The stops this project's settings still ask (rough, color, sound): each leads to its pass's
    // edits, which the viewer, critic, review and versus would have to see again.
    const stops = openStops(state, await videoFactsFor(document), stopRulesNow()).filter((stop) => stop.kind !== waiting?.kind);
    if (stops.length && add("stops_open", `notes checkpoint ${stops.map((stop) => stop.kind).join(", ")}`, nextOf("notes", { action: "checkpoint", id: stops[0].kind }))) return gates;
    const viewer = await viewerNeeded(document, state, record.revision, whole, options);
    // When the critic asks a packet of the same scene, one look critique and one subagent serve both.
    let joined = null;
    if (viewer?.gap.fix) { if (add("viewer_needed", `fix the viewer's story bugs${viewer.gap.last ? "" : ", look viewer again"}`, viewerFixCall(viewer.gap))) return gates; }
    else if (viewer) {
      if (!viewer.intents && add("intents_needed", "notes intents", intentsCall())) return gates;
      joined = !viewer.gap.spoiler && !barOf(state.verdicts) && critiqueAsks(state, document, viewer.scene, record.revision) ? viewer.scene.id : null;
      const words = joined ? "look critique (viewer and critic), one fresh subagent, notes critique" : "look viewer, a fresh subagent, notes viewer";
      if (add("viewer_needed", words, joined ? critiqueCall(sceneField(viewer.scene)) : nextOf("look", { mode: "viewer", ...sceneField(viewer.scene) }))) return gates;
    }
    for (const scene of whole) {
      if (waived(CRITIQUE_WAIVER, scene) || scene.id === joined) continue;
      const open = critiqueStanding(state, document, scene.id, record.revision);
      if (!open && critiqueWanted(scene, critiqueOf(state, scene.id)) && realEdit(state, videoFacts(document))) {
        if (add("critique_needed", "look critique, a fresh subagent, notes critique", critiqueCall(sceneField(scene)))) return gates;
        break;
      }
      if (!open && barGap(critiqueOf(state, scene.id), barOf(state.verdicts))) {
        if (add("bar_needed", "look critique beside the bar, notes critique (BAR better)", critiqueCall(sceneField(scene)))) return gates;
        break;
      }
      if (!open) continue;
      const fix = nextOf("edit", { ops: [`<the edit for: ${open.lines[0].change}>`] });
      // The person asked for the fix: make it (their answer clears the lines once an edit follows).
      const [words, call] = open.call ? ["make the fix the person asked for", fix]
        : open.rounds >= CRITIQUE_ROUNDS ? ["notes checkpoint critique (open P0s)", critiqueStopCall()]
          : open.rev < record.revision ? ["look critique again (P0s)", critiqueCall(sceneField(scene))] : ["fix the critic's P0s, look critique again", fix];
      if (add("critique_open", words, call)) return gates;
      break;
    }
    const { findings } = await findingsFor(document, { fonts, codes });
    const real = await isRealEdit(document);
    const blocking = findings.filter((finding) => blocksFinal(finding, real));
    if (blocking.length) {
      const fixable = blocking.find((finding) => finding.severity === "error" && finding.fix && typeof finding.fix === "object");
      const call = fixable ? nextOf("edit", { ops: [fixable.fix].flat() }) : nextOf("check", { fix: "auto" });
      if (add("check_failed", `check fix:"auto", then fix ${plural(blocking.length, "finding")} (${[...new Set(blocking.map((finding) => finding.rule))].slice(0, 3).join(", ")})`, call)) return gates;
    } else if (state.checked?.rev !== record.revision && add("check", 'check fix:"auto"', nextOf("check", { fix: "auto" }))) return gates;
    for (const scene of whole) {
      if (scene.duration < REVIEW_SKIP_UNDER || waived(REVIEW_WAIVER, scene)) continue;
      const { events } = await sceneReview(document, scene.id, fonts, codes);
      const missed = unreviewed(events, new Set(state.reviews?.[scene.id]?.seen ?? [])).length;
      if (!missed) continue;
      if (add("review_needed", `look review (${missed} of ${events.length} moments)`, nextOf("look", { mode: "review", ...sceneField(scene) }))) return gates;
      break;
    }
    if (whole.length && !whole.every((scene) => waived(REFERENCE_WAIVER, scene))) {
      const versus = nextOf("look", { mode: "versus" });
      if (!(await judge.hasSaved(document.id))) {
        if (deps.inspire && whole.some((scene) => scene.duration >= REFERENCE_SKIP_UNDER) && add("reference_needed", `library inspire (save ${REFERENCES_WANTED}), look versus`, nextOf("library", { topic: "inspire", search: await findSearchFor(document.id) }))) return gates;
      } else if (state.firstBuild && !(await savedIds(document.id)).some((id) => state.firstBuild.saved.includes(id) || state.firstBuild.studied.includes(id))) {
        if (add("reference_needed", 'waive_check reference (references saved after the build)', nextOf("edit", { ops: [{ op: "waive_check", code: REFERENCE_WAIVER, target: "*", reason: "<built before the references; the person knows>" }] }))) return gates;
      } else if ((judgeLost(state, record.revision) || !versusSeen(state, record.revision)) && add("reference_needed", "look versus", versus)) return gates;
    }
    return gates;
  }

  // The gates as one line: "to final: 1) notes intents 2) look viewer, ... 3) render final".
  const toFinalLine = (gates, lead = "to final:") => `${lead} ${[...gates.map((gate) => gate.words), "render final"].map((words, index) => `${index + 1}) ${words}`).join(" ")}`;

  // A final render's refusal with every gate still open named after its own words (finalGates);
  // its code and next call stay. The refusing gate is listed even when only the render's own
  // check (with pixels) found it. Other errors pass through unchanged.
  async function withOpenGates(error, record, scenes, options) {
    const meta = caller.getStore() ?? {};
    if (!(error instanceof AgentError)) return error;
    // The person's own render, or one they approved, lists no gates, but still sees what is waived.
    // The person's own render: the dashboard shows the waived checks as chips beside this sentence.
    if (meta.by === "you") return error;
    if (meta.reviewed || meta.approved) {
      error.message = `${error.message}${await waivedNote(record.document)}`;
      return error;
    }
    let gates;
    try { gates = await finalGates(record, { scenes, options }); } catch { return error; }
    // A still waits only for the stops and the check.
    if (options.format === "png") gates = gates.filter((gate) => ["stops_open", "check_failed", "check"].includes(gate.code));
    const family = (code) => code.replace(/_(needed|open|unchecked|failed)$/, "");
    if (!gates.some((gate) => family(gate.code) === family(error.code)))
      gates.unshift({ code: error.code, words: error.code === "check_failed" ? 'check fix:"auto", then fix the findings named here' : `clear ${error.code}` });
    error.message = `${error.message} ${toFinalLine(gates, "A final render still needs:")}.${await waivedNote(record.document)}`;
    return error;
  }

  // " 39 waived (crop_no_subject 17, held_static 9).": how many findings the agent called fine, shown at
  // the last step (the final gate's refusal and the final render's receipt); "" when none is waived.
  async function waivedNote(document) {
    const line = waivedLine(await waiversInUse(document));
    return line ? ` ${line}.` : "";
  }

  // The fixed call for a refusal: the code's own step, the suggestion kino made (didYouMean)
  // put in place of what was sent, or reading the project.
  async function errorNext(verb, asked, data, projectId) {
    const suggestion = Array.isArray(data.didYouMean) ? data.didYouMean[0] : null;
    switch (data.error) {
      case "unknown_verb": return suggestion ? nextOf(suggestion, asked) : STATUS_CALL;
      case "unknown_project": case "no_project": case "archived": return nextOf("project", { action: "list" });
      case "exists": return asked.id ? nextOf("project", { action: "open", id: asked.id }) : STATUS_CALL;
      case "no_previous_look": return nextOf("look", {});
      case "check_failed": return nextOf("check", { fix: "auto" });
      case "conflict": return STATUS_CALL;
      default: break;
    }
    if (suggestion) {
      // The name kino could not find, as its reason quotes it ("box"), is swapped where it was
      // sent (targets: ["box"]); otherwise the closest top-level word (a mode, an action).
      const missing = /"([^"]+)"/.exec(data.reason ?? "")?.[1];
      const fixed = (missing && opWithName(asked, missing, suggestion)) || withSuggestion(asked, suggestion);
      if (fixed) return nextOf(verb, fixed);
    }
    if (verb === "edit" && data.type) return nextOf("library", { topic: "op", name: data.type });
    return projectId ? buildNext(projectId) : STATUS_CALL;
  }

  // The direction's advice calls (brief.mjs nextMove), not a waiting stop's answer or a redo's
  // fix. A stop to ask still comes in the build steps, after the check (openStops).
  const isAdvice = (next) => (next.tool === "notes" && ["brief", "set_plan", "needs", "checkpoint"].includes(next.input?.action))
    || (next.tool === "library" && (next.input?.topic === "inspire" || next.input?.topic === "footage"));

  // A video with something on screen (a layer that is not audio, outside components).
  const hasLayers = (document) => document.scenes.some((scene) => !scene.isComponent && (scene.layers ?? []).some((layer) => layer.type !== "audio"));

  // An edit of what the agent just read: the layer or animation `target` names first (a name,
  // code or selector), with its first field when an edit sets that field. A scene, or nothing
  // found, leaves the layer for the agent to name.
  async function changeCall(record, target, field) {
    let first = null;
    if (target != null) {
      const codes = await syncCodes(record.document.id, record.document);
      try { first = inspectTargets(createResolver(record.document, codes), codes, { targets: [target] }).first; } catch { /* not found */ }
    }
    const kind = first?.kind === "animation" ? "animation" : "layer";
    const properties = { [editableField(kind, field) ? field : "<field>"]: "<new value>" };
    if (kind === "animation") return nextOf("edit", { ops: [{ op: "update_animation", animation: first.name, properties }] });
    return nextOf("edit", { ops: [{ op: "update_layer", layer: first?.kind === "layer" ? first.name : "<the layer to change>", properties }] });
  }

  // When state.origin names a word the subject is known for and the person gave no footage of their
  // own, a footage search, a footage scan or an inspire search is followed by the footage search for
  // "<about quote> <word>" and then a scan wanting the word (next-call.mjs originFootage). Else null.
  async function originFootageFor(projectId) {
    const record = await store.getProject(String(projectId)).catch(() => null);
    if (!record) return {};
    const state = await agentState.read(record.document.id).catch(() => null);
    if (!state?.origin?.words?.length) return {};
    const media = (await deps.listMedia?.().catch(() => [])) ?? [];
    return { state, found: originFootage({ origin: state.origin, about: state.brief?.fields?.about, footage: state.footage, personClips: personClipCount(record.document, media) }) };
  }

  async function originFootageCall(input, reply, projectId) {
    if (!["footage", "inspire"].includes(input?.topic)) return null;
    const { state, found } = await originFootageFor(projectId);
    return originFootageNext({ found, topic: input.topic, input, footage: state?.footage, reply });
  }

  // The next call for an answer that did not name one.
  async function nextCallFor(verb, input, reply, projectId) {
    // The subject's origin footage comes before the answer's own next call (originFootageCall).
    if (!reply.isError && verb === "library" && projectId) {
      const origin = await originFootageCall(input, reply, projectId);
      if (origin) return origin;
    }
    if (reply.nextCall) return reply.nextCall;
    const data = reply.data ?? {};
    const asked = cleanInput(input);
    if (data.held || data.crew) return STATUS_CALL;
    // A write refused while a stop waits: the stop's own next call (record their reply).
    if (data.waiting && !reply.isError) return buildNext(projectId);
    if (data.status === "awaiting_approval") return verb === "render" && data.id ? nextOf("render", { action: "wait", job: data.id }) : STATUS_CALL;
    if (reply.isError) return errorNext(verb, asked, data, projectId);
    if (!projectId) {
      const first = data.projects?.[0];
      return first ? nextOf("project", { action: "open", id: first.id }) : nextOf("project", { action: "create", id: "<short-id>", name: "<name>", width: 1920, height: 1080, duration: 15 });
    }
    if (verb === "render") {
      const job = data.job ? renders.get(String(data.job)) : null;
      if (job && !["done", "failed", "canceled"].includes(data.status)) return nextOf("render", { action: "wait", job: job.id });
      if (job?.quality === "final" && data.status === "done") return STATUS_CALL;
    }
    if (verb === "project") {
      if (asked.action === "import" && typeof data.src === "string") {
        const layerType = data.kind === "audio" || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(data.src) ? "audio" : /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(data.src) ? "image" : "video";
        return nextOf("edit", { ops: [{ op: "add_layer", layerType, name: layerType === "audio" ? "music" : "clip",
          properties: { src: data.src, ...(layerType === "video" && typeof data.log === "string" ? { log: data.log } : {}) } }] });
      }
      if (["list", "duplicate"].includes(asked.action) && data.projects?.[0]) return nextOf("project", { action: "open", id: data.projects[0].id });
      if (asked.action === "archive") return nextOf("project", { action: "list" });
    }
    if (verb === "library" && asked.topic === "op") {
      const name = Array.isArray(asked.name) ? asked.name[0] : String(asked.name ?? "").split(",")[0].trim();
      const example = name ? exampleFor(name) : null;
      if (example) return nextOf("edit", { ops: [example] });
    }
    if (verb === "history" && (asked.action ?? "list") !== "list") return nextOf("look", { mode: "changed" });
    if (verb === "check" && data.autoFixes && !data.applied) return nextOf("check", { fix: "auto" });
    // A read leads to a change of what was read: the inspected layer, or what a look showed
    // (after a check of this revision). A review, versus, viewer or changed look follows the
    // build steps, and so does every answer while a stop waits for the person, and on a video
    // with nothing on screen yet (its brief, then a compose).
    const reads = verb === "inspect" || (verb === "look" && !["review", "versus", "viewer", "changed"].includes(asked.mode));
    const record = reads ? await store.getProject(String(projectId)).catch(() => null) : null;
    const state = record ? await agentState.read(record.document.id) : null;
    if (state && !waitingStop(state) && hasLayers(record.document)) {
      if (verb === "inspect") {
        // layer and layers name the targets too (kino inspect layer=title).
        const named = asked.targets ?? asked.layers ?? asked.layer;
        const targets = Array.isArray(named) ? named : String(named ?? "").split(",").map((name) => name.trim());
        const fields = Array.isArray(asked.fields) ? asked.fields : typeof asked.fields === "string" ? asked.fields.split(",") : [];
        return changeCall(record, targets[0], String(fields[0] ?? "").split(",")[0].trim());
      }
      if (state.checked?.rev !== record.revision) return nextOf("check", { fix: "auto" });
      return changeCall(record, asked.anim ?? asked.layer);
    }
    return buildNext(projectId, { advice: ADVICE_VERBS.includes(verb) || (verb === "library" && asked.topic === "guide") });
  }

  const SLOW_CALL_MS = 20_000;
  async function call(verb, input = {}, meta = {}) {
    const started = now();
    // why and next (said.mjs): what the agent says about this call. No handler sees them.
    const taken = takeSaid(input);
    input = taken.input;
    if (Object.keys(taken.said).length) meta = { ...meta, said: taken.said };
    // An agent's call counts as running (render-activity.mjs): background work (Inspire's
    // measuring, reference_drift, the preview cache) waits until calls have been quiet a second.
    const ended = meta.by === "you" ? null : callStarted();
    try {
      return await timedCall(verb, input, meta, started);
    } finally { ended?.(); }
  }

  async function timedCall(verb, input, meta, started) {
    const live = deps.live && Object.hasOwn(handlers, verb) && meta.by !== "you" && !meta.quiet ? await liveStart(verb, input, meta) : null;
    if (live) meta = { ...meta, live };
    try {
      const reply = await answer(verb, input, meta, live, started);
      // A slow call is named in the server log (first passes keep it), so the next slow run shows
      // which call and mode waited. Only the verb and the mode or action words: never content.
      const took = now() - started;
      if (took > SLOW_CALL_MS) console.warn(`[kino] slow call: ${verb}${input?.mode ? ` mode ${input.mode}` : ""}${input?.action ? ` ${input.action}` : ""}${input?.fix ? " fix" : ""} took ${Math.round(took / 1000)} s`);
      return reply;
    } catch (error) {
      if (live) try { liveFailed(live, now() - started); } catch { /* the live view never hides the error */ }
      throw error;
    }
  }

  // The step open when an agent call arrives, { name, at }, for the step log (step-log.mjs); null
  // when the call is not the agent's work on a project. A video with no brief is in its brief (or,
  // with layers already, in a change to it: the build); with a brief the name is the one in
  // status's `step:` line. Never makes the call fail.
  async function openStepOf(verb, input, meta, at) {
    if (meta.by === "you" || meta.quiet || !Object.hasOwn(handlers, verb)) return null;
    try {
      const action = input?.action;
      // Waiting on a final render's job is the final render step, though the wait names no quality.
      const asked = verb === "render" && input?.job && renders.get(String(input.job))?.quality === "final" ? { ...input, quality: "final" } : input;
      if (verb === "project" && ["create", "duplicate"].includes(action)) return { name: "brief", at };
      // Opening, listing or removing projects is not work on the project the agent had open.
      if (verb === "project" && ["open", "list", "archive", "trash", "delete", "restore"].includes(action)) return null;
      const id = typeof input?.project === "string" ? input.project : await readCurrent();
      const record = id ? await store.getProject(String(id)).catch(() => null) : null;
      if (!record || record.trashedAt) return null;
      const state = await agentState.read(record.document.id);
      // No brief: an empty video is still in its brief; one with layers is a change to it, whose
      // passes before the final render are named by the call.
      if (!hasBrief(state.brief)) return { name: hasLayers(record.document) ? stepNameOf(null, { verb, input: asked }) : "brief", at };
      const move = statusMove(state, await directionFacts(record.document), stopRulesNow());
      return { name: stepNameOf(move, { waiting: waitingStop(state)?.kind ?? null, verb, input: asked }), at };
    } catch { return null; }
  }

  async function answer(verb, input, meta, live, started) {
    let reply;
    let refusedFor = null;
    let held = false;
    const openStep = await openStepOf(verb, input, meta, started);
    if (openStep) meta = { ...meta, openStep };
    if (!Object.hasOwn(handlers, verb)) reply = errorReply(new AgentError("unknown_verb", `Unknown verb "${verb}".`, { didYouMean: closest(String(verb), VERBS) }));
    else {
      const safeInput = input && typeof input === "object" ? input : {};
      // A slot of kino's next call sent back as it was ("<your headline>"): nothing is saved.
      const slot = unfilledSlot(safeInput);
      // Hold: you paused agent writes. Calls from the dashboard and calls you approved go ahead.
      // A stop waiting for your answer refuses that project's writes the same way; hold wins.
      const gated = !meta.reviewed && !meta.approved && isWrite(verb, safeInput);
      let starting = null;
      try {
        // The crew's limits for this agent come first (crew.mjs): a stopped agent stays stopped.
        let crewAnswer = await crewGate(verb, safeInput, meta);
        held = gated && !crewAnswer && Boolean(deps.hold?.().on);
        const waiting = gated && !held && !crewAnswer ? await waitingFor(verb, safeInput) : null;
        refusedFor = waiting?.round.id ?? null;
        if (!crewAnswer && !held && !waiting) {
          const claimed = await renderClaim(verb, safeInput, meta);
          crewAnswer = claimed?.answer ?? null;
          starting = claimed?.starting ?? null;
        }
        if (slot) throw new AgentError("bad_input", `${slot.path} is still "${slot.value}", a slot in kino's next call: replace it with your own words and send the call again. Nothing was saved.`, { slot: slot.path });
        // Only a call that changes the project makes it the open one: a read (inspect, look,
        // status, library, notes) of another project leaves the agent's open project as it was.
        const keepCurrent = meta.keepCurrent || !opensProject(verb, safeInput);
        reply = await caller.run({ ...meta, keepCurrent }, () => (crewAnswer ? crewReply(crewAnswer, safeInput) : held ? heldReply(safeInput) : waiting ? waitingReply(waiting) : handlers[verb](safeInput, meta)));
      } catch (error) {
        // A stop asked while this write ran refused its save (saveDocument).
        if (error instanceof StopWaits) {
          refusedFor = error.waiting.round.id;
          reply = await caller.run(meta, () => waitingReply(error.waiting)).catch(errorReply);
        } else if (error instanceof LockWaits) {
          reply = await caller.run(meta, () => crewReply(error.answer, safeInput, error.projectId)).catch(errorReply);
        } else reply = errorReply(error);
      } finally {
        if (starting) renderStarted(starting);
      }
    }
    let finish = reply.finish;
    const projectId = reply.project ?? (typeof input?.project === "string" ? input.project : null) ?? await readCurrent();
    const known = projectId ? await store.getProject(String(projectId)).catch(() => null) : null;
    if (known?.trashedAt) liveDocs.delete(known.document.id);
    else if (known) rememberLive(known.document.id, known.document);
    // A refused call still counts in the turn and still hands over the inbox.
    if (!finish && reply.isError && known && !known.trashedAt) finish = await caller.run(meta, () => finishCall(String(projectId))).catch(() => null);
    // The next call (next-call.mjs): worked out before the answer is cut short, written in last.
    const next = await caller.run(meta, () => nextCallFor(verb, input, reply, known && !known.trashedAt ? known.document.id : null)).catch(() => STATUS_CALL);
    // A JSON answer (a receipt, a refusal, a held write) keeps its next in its JSON.
    const json = Boolean(reply.receipt) || Boolean(reply.data && reply.text === compact(reply.data));
    const inbox = !reply.receipt && finish?.inbox?.length ? finish.inbox : [];
    reply = { text: reply.receipt ? compact(reply.data) : reply.text, ...(reply.data ? { data: reply.data } : {}), ...(reply.images?.length ? { images: reply.images } : {}), ...(reply.isError ? { isError: true } : {}) };
    reply = { ...reply, text: answerText({ text: reply.text, data: reply.data, json }, next, inbox) };
    reply = await capAnswer(reply, verb, projectId, next);
    // meta.quiet: the dashboard's own background reads (checks) stay out of the agent's log.
    if (known && !meta.quiet) {
      const label = live?.label ?? callLabel(verb, input, { document: known.document, codes: (await agentState.read(known.document.id).catch(() => null))?.codes });
      // A call you approved keeps the agent that asked, unless it asked before a restart (its id
      // may be another agent's now): then the row names its client only.
      const agent = live?.replay ? (live.agent && (live.agent.boot ?? null) === (deps.live.boot ?? null) ? live.agent : null) : live?.agent;
      const event = { verb, client: meta.client ?? null, by: meta.by ?? "agent", ms: now() - started, chars: reply.text.length,
        images: (reply.images ?? []).map((image) => image.path), isError: Boolean(reply.isError), summary: reply.text.split("\n")[0].slice(0, 200),
        label, ...(agent ? { agent } : {}), ...callDetails(input, reply, finish, meta, refusedFor), ...(meta.said ?? {}) };
      // A few lines of the answer for the dashboard's agent pane (said.mjs).
      const details = answerDetails(reply).map(hideShareSecrets);
      if (details.length) event.details = details;
      // A share link is a secret: the event log names the link, never its URL. Any other call
      // whose answer or input repeats one (render wait Q…, an inbox line) loses the secret too.
      if (verb === "project" && typeof reply.data?.url === "string" && (input.action === "share" || (input.options?.resource === "shares" && input.options?.action === "create"))) event.summary = "Created sharing link (secret omitted from activity log).";
      event.summary = hideShareSecrets(event.summary);
      event.input = hideShareSecrets(event.input);
      const entry = await agentState.record(String(projectId), event).catch(() => null);
      if (entry) await deps.emit?.(String(projectId), { kind: "call", event: entry });
    }
    const outcome = held ? { held: true } : refusedFor ? { refused: refusedFor } : null;
    // The crew's "last" and its lanes: what the agent's call was and whether it changed something.
    if (deps.crew && live?.agent && !live.replay) {
      const refused = held || refusedFor || reply.data?.crew || reply.isError;
      deps.crew.after(live.agent, { verb, label: live.label, summary: reply.text.split("\n")[0], isError: Boolean(reply.isError), write: live.write && !refused, ms: now() - started });
    }
    if (live) await liveDone(live, { projectId, known, reply, finish, ms: now() - started, outcome }).catch(() => {});
    if (deps.live && meta.by === "you" && !meta.quiet) await liveAfterYou(projectId, known).catch(() => {});
    return reply;
  }

  // ---- the dashboard timeline's lanes -------------------------------------------------------
  // GET /api/dashboard/lanes: a scene's shots (where its footage cuts, as look sheet finds them)
  // and its spoken sentences from the voices' saved transcripts (never transcribing here), so the
  // timeline can draw a thumbnail per shot and a block per sentence.
  const SENTENCE_GAP = 0.8;
  async function voiceSentences(scene, document) {
    const sentences = [];
    const done = new Set();
    for (const layer of scene.layers) {
      if (!["audio", "video"].includes(layer.type) || !layer.src || layer.visible === false || done.has(layer)) continue;
      let pieces;
      try { pieces = speechPieces(scene, layer); } catch { continue; }
      for (const piece of pieces) done.add(piece);
      let file;
      try { file = mediaFileOf(pieces[0]); } catch { continue; }
      let transcript = null;
      try { transcript = transcripts.saved ? await transcripts.saved(file, document, pieces[0]) : null; } catch { transcript = null; }
      if (!transcript) continue;
      let words;
      try { words = speechWords(scene, pieces, transcript).filter((word) => !word.unclear); } catch { continue; }
      let open = null;
      words.forEach((word, index) => {
        open ??= { start: word.start, end: word.end, words: [], layerId: pieces[0].id, name: pieces[0].name };
        open.words.push(word.text);
        open.end = word.end;
        const next = words[index + 1];
        // A sentence ends at . ? ! or … (before closing quotes), or at a pause.
        if (!next || /[.?!…]["”')\]]*$/.test(word.text) || next.start - word.end >= SENTENCE_GAP) {
          sentences.push({ start: open.start, end: open.end, text: open.words.join(" ").replace(/\s+([,.?!…])/g, "$1"), layerId: open.layerId, name: open.name });
          open = null;
        }
      });
    }
    return sentences.sort((a, b) => a.start - b.start);
  }
  async function lanes(projectId, sceneId) {
    const record = await store.getProject(String(projectId));
    const scene = record.document.scenes.find((entry) => entry.id === sceneId);
    if (!scene) throw new AgentError("not_found", `There is no scene ${sceneId} in ${projectId}.`);
    // Saved shots only: opening a project must not start FFmpeg on its footage.
    const { shots } = await shotsOf(scene, { saved: true });
    return { rev: record.revision, sceneId, shots, voice: await voiceSentences(scene, record.document) };
  }

  return { call, verbs: VERBS, renderJobs, picks, lanes, librarySample, libraryStill, libraryWarm, soundtrackMeasuring: (projectId) => exploring.get(projectId) ?? Promise.resolve(), answerStop, reopenStop, afterYourStop, boardPage, boardData, boardShot, settleStop, currentProject: readCurrent, finalRefused };
}

/**
 * One page of a long list (library media: 30 a page keeps an answer well under 8k tokens):
 * {items, page, pages, left}. A page past the end shows the last one; `left` counts the items
 * after this page.
 */
export function pageOf(list, page, size = 30) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const at = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  return { items: list.slice((at - 1) * size, at * size), page: at, pages, left: Math.max(0, list.length - at * size) };
}

// About how many tokens a PNG costs an agent: one per 28 × 28 pixel patch after Claude's
// resize (estimateImageTokens in meter.mjs). The dashboard shows it with each call.
export function pngTokens(base64) {
  if (typeof base64 !== "string" || base64.length < 32) return 0;
  const size = pngSize(Buffer.from(base64.slice(0, 32), "base64"));
  return size ? estimateImageTokens(size) : 0;
}
