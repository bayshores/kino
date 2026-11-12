// look {mode:"motion", ref:"lines"}: "lines heard". Each line keep_line kept is listened to in the
// scene's own mix (the export's mix graph and master limiter, export.mjs soundMixArgs), only over
// the line's stretch, with whisper on this computer in the language of the line's own clip
// (listenLanguages: its stored language, else a sure guess, else English and the unsure guess).
// Each line prints the words heard there, their confidence and how many of the line's own words
// (its clip's transcript over the stretch) are among them, and the words that differ, so a
// director can see a buried or misheard line without ears. The render's own sound steps (voice leveling, cleanup) run first, then one FFmpeg run writes
// the mix (up to the last line's end) and one decodes it, one run at a time; one whisper
// run per language hears every line in it. Nothing is played.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { keepLineStretches } from "../engine/audioDucking.js";
import { round } from "../engine/numbers.js";
import { mediaPlaybackRange } from "../engine/playback.js";
import { GLOSS_LABEL, NO_SPACE_LANGUAGES, speechWords } from "../engine/speech.js";
import { decodeMono } from "./audio-analysis.mjs";
import { sceneSoundClips, soundMixArgs } from "./export.mjs";
import { runExportProcess } from "./export-process.mjs";
import { ffmpegCommand } from "./media-probe.mjs";
import { LANG_SURE, LANGUAGE_MODEL, SAMPLE_RATE, languageSetup, whisperSegments, whisperSetup, whisperTurn } from "./speech/transcribe.mjs";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";

// A line counts as heard only when every one of its own words is among the words heard in the mix
// (round 4: "Kill you" heard as "Thank you" matched 1 of 2 and used to count). Otherwise the row
// prints the words that differ.
// A line of this many words or fewer is short: whisper-cli has no way to score a given text (no
// forced alignment; --grammar only pushes other tokens down, so its p would not be the line's own),
// and the row says so instead of a probability for the line's own words.
const SHORT_LINE = 3;
// Seconds of the mix kept around each line, so its first and last word are not clipped.
const MARGIN = 0.15;
// The call that fetches the multilingual model (service.mjs savedLinesOf, transcribe.mjs heard): look
// source on a clip whose voice whisper tags as another language starts its one download.
const FETCH_CALL = `look {mode:"source", layer:"<clip>"} on a clip whose voice whisper tags as another language fetches it once (${Math.round(LANGUAGE_MODEL.bytes / 1e6)} MB)`;

const plain = (text) => String(text ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}']/gu, "");

/** The units a line is compared by: its words, or its characters for a language written without spaces. */
export function unitsOf(text, language = "en") {
  if (NO_SPACE_LANGUAGES.has(language)) return [...plain(String(text ?? "").replace(/\s+/g, ""))];
  return String(text ?? "").split(/\s+/).map(plain).filter(Boolean);
}

/**
 * {found, of, missed, extra}: how many of the line's own units are among the units heard (each heard
 * one used once); `missed` the line's own units not heard, `extra` the heard units not in the line.
 */
export function unitsMatched(own, heard, language = "en") {
  const left = unitsOf(heard, language);
  const mine = unitsOf(own, language);
  const missed = [];
  for (const unit of mine) {
    const at = left.indexOf(unit);
    if (at >= 0) left.splice(at, 1); else missed.push(unit);
  }
  return { found: mine.length - missed.length, of: mine.length, missed, extra: left };
}

/**
 * The languages a line is listened in, and why: [language of its own words, ...also]. The clip's
 * stored language (its transcript was read in it) wins; else a sure guess that is not English
 * (whose own-language transcript is not made yet) adds the guess; else an unsure guess of another
 * language adds it beside English. `guess` is the clip's saved {language, p}.
 */
export function listenLanguages(transcript, guess) {
  const stored = typeof transcript?.language === "string" ? transcript.language : null;
  const p = Number.isFinite(transcript?.languageP) ? ` p ${round(transcript.languageP, 2)}` : "";
  if (stored && stored !== "en") return { language: stored, also: [], why: `the clip's stored language ${stored}${p}` };
  const said = guess && Number.isFinite(guess.p) ? `language guess ${guess.language} p ${round(guess.p, 2)}` : null;
  if (!said) return { language: "en", also: [], why: "no language guess saved for the clip: English" };
  if (guess.language === "en") return { language: "en", also: [], why: `${said}${guess.p < LANG_SURE ? ` (under ${LANG_SURE}: unsure)` : ""}` };
  if (guess.p >= LANG_SURE) return { language: "en", also: [guess.language], why: `${said} (sure) but the clip has no ${guess.language} transcript yet: heard in ${guess.language} and en` };
  return { language: "en", also: [guess.language], why: `${said} (under ${LANG_SURE}: unsure): heard in en and ${guess.language}` };
}

/**
 * The lines keep_line kept on `layer` (its "Line up"/"Line down" stretches), each with its own words
 * from `transcript` (the clip's, as kino heard it): [{layer, start, end, text, words, language,
 * also, why, gloss?, guess?}] in scene seconds (listenLanguages gives language, also and why). `gloss` is whisper's English for a line heard in another language;
 * `guess` the clip's language guess ({language, p}) when it was unsure (under LANG_SURE).
 */
export function keptLines(scene, layer, transcript, { name = layer.name, guess = null } = {}) {
  // Only the "Line up"/"Line down" stretches: a "Sound up"/"Sound down" stretch keeps a sound, not words.
  const lineMarks = { animations: (layer.animations ?? []).filter((animation) => /^Line (?:up|down)$/.test(animation?.name ?? "")) };
  const stretches = keepLineStretches(lineMarks).map((stretch) => ({ start: Math.max(0, stretch.start), end: Math.min(scene.duration, stretch.end) }))
    .filter((stretch) => stretch.end - stretch.start >= 0.2);
  const { language, also, why } = listenLanguages(transcript, guess);
  let words = [];
  try { words = Array.isArray(transcript?.words) ? speechWords(scene, [layer], transcript).filter((word) => !word.unclear) : []; } catch { words = []; }
  const join = (list) => list.join(NO_SPACE_LANGUAGES.has(language) ? "" : " ").trim();
  const range = mediaPlaybackRange(layer, scene.duration);
  const offset = range ? range.start - range.offset : 0;
  return stretches.map((stretch) => {
    const own = words.filter((word) => word.start < stretch.end && word.end > stretch.start);
    const gloss = (transcript?.english ?? []).filter((segment) => segment.start + offset < stretch.end && segment.end + offset > stretch.start).map((segment) => segment.text);
    return {
      layer: name, start: round(stretch.start, 2), end: round(stretch.end, 2), text: join(own.map((word) => word.text)), words: own.length, language, also, why,
      ...(gloss.length ? { gloss: gloss.join(" ") } : {}),
      ...(guess && Number.isFinite(guess.p) && guess.p < LANG_SURE ? { guess: { language: guess.language, p: guess.p } } : {}),
    };
  });
}

/** The language whisper guessed for a file ({language, p}, saved beside it by the clip readout), or null. */
export async function languageGuessOf(file, { languages = () => languageSetup() } = {}) {
  const found = languages();
  if (!found) return null;
  try { return JSON.parse(await readFile(`${file}.lang-${found.modelName}`, "utf8")); } catch { return null; }
}

/**
 * Whisper over `pieces` (16 kHz mono) in `language`: {model, heard: [{text, p}]}, or {missing} when
 * this computer has no model for it (the file and where it goes).
 */
export async function listenPieces(pieces, language, { english = () => whisperSetup(), other = () => languageSetup() } = {}) {
  let setup;
  try { setup = language === "en" ? english() : other(); } catch (error) { return { missing: String(error.message).split(". ")[0] }; }
  if (!setup) return { missing: `${LANGUAGE_MODEL.file} is not in ~/.kino/models/ (or KINO_WHISPER_LANG_MODEL), so ${language} cannot be heard; ${FETCH_CALL}` };
  const lists = await whisperTurn(() => whisperSegments(pieces, setup, { language }));
  return {
    model: setup.modelName,
    heard: lists.map((segments) => {
      const said = segments.filter((segment) => /[\p{L}\p{N}]/u.test(segment.text) && !/^[[(*].*[\])*]$/.test(segment.text));
      const tokens = said.length ? said.reduce((sum, segment) => sum + segment.p, 0) / said.length : null;
      return { text: said.map((segment) => segment.text).join(NO_SPACE_LANGUAGES.has(language) ? "" : " ").trim(), p: tokens === null ? null : round(tokens, 2) };
    }),
  };
}

/** The scene's mix up to `until` seconds as 16 kHz mono samples (two FFmpeg runs, one after the other), or null when nothing is heard. */
export async function sceneMixSamples(scene, { mediaRoot, until = scene.duration, signal } = {}) {
  const directory = await makeTempFolder("kino-mix-");
  try {
    const clips = await sceneSoundClips(scene, { mediaRoot, directory, duration: scene.duration, signal });
    const output = path.join(directory, "mix.wav");
    const args = soundMixArgs(clips, Math.min(scene.duration, until), output);
    if (!args) return null;
    await runExportProcess(ffmpegCommand(), args, signal);
    return (await decodeMono(output, { sampleRate: SAMPLE_RATE })).samples;
  } finally {
    await removeTempFolder(directory);
  }
}

/**
 * Hears each line of `lines` (keptLines) in the scene's mix: [{...line, heard?, p?, found?, of?,
 * model?, missing?}]. `mix(until)` gives the mix's 16 kHz samples (sceneMixSamples); `listen(pieces,
 * language)` hears them (listenPieces).
 */
export async function hearKeptLines(lines, { mix, listen = listenPieces }) {
  if (!lines.length) return [];
  const samples = await mix(round(Math.max(...lines.map((line) => line.end)) + MARGIN, 2));
  const out = lines.map((line) => ({ ...line }));
  if (!samples?.length) return out.map((line) => ({ ...line, heard: "", p: null, ...unitsMatched(line.text, "", line.language) }));
  // One listen per language: a line is heard in its own words' language, and in each of its `also`.
  for (const language of new Set(lines.flatMap((line) => [line.language, ...(line.also ?? [])]))) {
    const group = out.filter((line) => line.language === language || (line.also ?? []).includes(language));
    const pieces = group.map((line) => samples.subarray(Math.max(0, Math.floor((line.start - MARGIN) * SAMPLE_RATE)), Math.min(samples.length, Math.ceil((line.end + MARGIN) * SAMPLE_RATE))));
    const result = await listen(pieces, language);
    for (const [index, line] of group.entries()) {
      const heard = result.missing ? null : result.heard[index] ?? { text: "", p: null };
      if (line.language !== language) {
        // Heard in another language than its words were read in: printed beside, not compared.
        line.alsoHeard = [...(line.alsoHeard ?? []), result.missing ? { language, missing: result.missing } : { language, heard: heard.text, p: heard.p, model: result.model }];
        continue;
      }
      if (result.missing) { line.missing = result.missing; continue; }
      Object.assign(line, { heard: heard.text, p: heard.p, model: result.model }, unitsMatched(line.text, heard.text, language));
    }
  }
  return out;
}

const quote = (text) => `"${String(text).replaceAll('"', "'").slice(0, 120)}"`;

/**
 * The answer: one line per kept line. `languageModel: false` (languageSetup found no multilingual
 * model) adds a line: every line was read and heard in English, no clip's language was checked.
 */
export function linesHeardText(lines, { scene = "the scene", languageModel = true } = {}) {
  if (!lines.length) return `lines heard ${scene}: no kept lines here (keep_line keeps one; this listens to each in the mix)`;
  const models = [...new Set(lines.flatMap((line) => [line.model, ...(line.alsoHeard ?? []).map((also) => also.model)]).filter(Boolean))];
  const head = `lines heard ${scene}: each kept line's stretch of the scene's mix, heard by whisper on this computer${models.length ? ` (${models.join(", ")})` : ""} in the language of the line's own clip; a line counts as heard only when all its own words are among the words heard`;
  const noModel = languageModel ? [] : [`  ${LANGUAGE_MODEL.file} is not in ~/.kino/models/: each line was read and heard in English and no clip's language was checked (speech in another language reads as English sound-alikes); ${FETCH_CALL}`];
  const rows = lines.slice(0, 16).map((line) => {
    const unit = NO_SPACE_LANGUAGES.has(line.language) ? "characters" : "words";
    const why = line.why ?? (line.guess ? `language guess ${line.guess.language} p ${line.guess.p} (under ${LANG_SURE}: unsure)` : "");
    const sureNote = line.guess ? "; the line's words may be sound-alikes" : "";
    const own = `line ${line.text ? quote(line.text) : "(no words read)"} (${line.language}${why ? `; listened in ${[line.language, ...(line.also ?? [])].join(" and ")}: ${why}` : ""}${sureNote})${line.gloss ? ` [${GLOSS_LABEL}: ${quote(line.gloss)}]` : ""}`;
    const also = (line.alsoHeard ?? []).map((item) => item.missing ? ` · in ${item.language} not heard: ${item.missing}`
      : ` · in ${item.language} heard ${item.heard ? quote(item.heard) : "nothing"}${item.p !== null && item.p !== undefined ? ` p ${item.p}` : ""} (not compared: the line's words are ${line.language})`).join("");
    if (line.missing) return `  ${line.layer} ${line.start}-${line.end} s: ${own} · not heard: ${line.missing}${also}`;
    const heard = line.heard ? `heard ${quote(line.heard)}${line.p !== null ? ` p ${line.p}` : ""}` : "nothing heard";
    const join = (list) => quote(list.join(NO_SPACE_LANGUAGES.has(line.language) ? "" : " "));
    let match;
    if (!line.of) match = "no words of its own to compare (kept by from and to)";
    else if (line.found === line.of) match = `${line.found} of ${line.of} ${unit} match: the line is heard`;
    else if (!line.heard) match = `0 of ${line.of} ${unit} match: not heard (buried or cut)`;
    else match = `${line.found} of ${line.of} ${unit} match: heard other words (differ: line ${join(line.missed ?? [])}, heard ${line.extra?.length ? join(line.extra) : "nothing in their place"}; buried, cut or misheard)`;
    const short = line.of && line.words >= 1 && line.words <= SHORT_LINE ? " · p of its own words: none (whisper-cli cannot score a given text: it has no forced alignment)" : "";
    return `  ${line.layer} ${line.start}-${line.end} s: ${heard} · ${own} · ${match}${short}${also}`;
  });
  return [head, ...noModel, ...rows, ...(lines.length > 16 ? [`  and ${lines.length - 16} more`] : [])].join("\n");
}
