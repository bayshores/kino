// look {mode:"motion", ref:"lines"}: "lines heard". Each line keep_line kept is listened to in the
// scene's own mix (the export's mix graph and master limiter, export.mjs soundMixArgs), only over
// the line's stretch, with whisper on this computer in the language the line was heard in. Each
// line prints the words heard there, their confidence and how many of the line's own words (its
// clip's transcript over the stretch) are among them, so a director can see a buried line without
// ears. One FFmpeg run writes the mix (up to the last line's end) and one decodes it; one whisper
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

// A line counts as heard when at least this share of its own words is among the words heard in the
// mix. A starting guess, not measured; the counts are printed beside it.
export const MATCH_SHARE = 0.5;
// Seconds of the mix kept around each line, so its first and last word are not clipped.
const MARGIN = 0.15;

const plain = (text) => String(text ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}']/gu, "");

/** The units a line is compared by: its words, or its characters for a language written without spaces. */
export function unitsOf(text, language = "en") {
  if (NO_SPACE_LANGUAGES.has(language)) return [...plain(String(text ?? "").replace(/\s+/g, ""))];
  return String(text ?? "").split(/\s+/).map(plain).filter(Boolean);
}

/** {found, of}: how many of the line's own units are among the units heard (each heard one used once). */
export function unitsMatched(own, heard, language = "en") {
  const left = unitsOf(heard, language);
  const mine = unitsOf(own, language);
  let found = 0;
  for (const unit of mine) {
    const at = left.indexOf(unit);
    if (at >= 0) { left.splice(at, 1); found += 1; }
  }
  return { found, of: mine.length };
}

/**
 * The lines keep_line kept on `layer` (its "Line up"/"Line down" stretches), each with its own words
 * from `transcript` (the clip's, as kino heard it): [{layer, start, end, text, language, gloss?,
 * guess?}] in scene seconds. `gloss` is whisper's English for a line heard in another language;
 * `guess` the clip's language guess ({language, p}) when it was unsure (under LANG_SURE).
 */
export function keptLines(scene, layer, transcript, { name = layer.name, guess = null } = {}) {
  const stretches = keepLineStretches(layer).map((stretch) => ({ start: Math.max(0, stretch.start), end: Math.min(scene.duration, stretch.end) }))
    .filter((stretch) => stretch.end - stretch.start >= 0.2);
  const language = typeof transcript?.language === "string" ? transcript.language : "en";
  let words = [];
  try { words = Array.isArray(transcript?.words) ? speechWords(scene, [layer], transcript).filter((word) => !word.unclear) : []; } catch { words = []; }
  const join = (list) => list.join(NO_SPACE_LANGUAGES.has(language) ? "" : " ").trim();
  const range = mediaPlaybackRange(layer, scene.duration);
  const offset = range ? range.start - range.offset : 0;
  return stretches.map((stretch) => {
    const own = words.filter((word) => word.start < stretch.end && word.end > stretch.start);
    const gloss = (transcript?.english ?? []).filter((segment) => segment.start + offset < stretch.end && segment.end + offset > stretch.start).map((segment) => segment.text);
    return {
      layer: name, start: round(stretch.start, 2), end: round(stretch.end, 2), text: join(own.map((word) => word.text)), language,
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
  if (!setup) return { missing: `${LANGUAGE_MODEL.file} is not in ~/.kino/models/ (or KINO_WHISPER_LANG_MODEL), so ${language} cannot be heard` };
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
  for (const language of new Set(lines.map((line) => line.language))) {
    const group = out.filter((line) => line.language === language);
    const pieces = group.map((line) => samples.subarray(Math.max(0, Math.floor((line.start - MARGIN) * SAMPLE_RATE)), Math.min(samples.length, Math.ceil((line.end + MARGIN) * SAMPLE_RATE))));
    const result = await listen(pieces, language);
    for (const [index, line] of group.entries()) {
      if (result.missing) { line.missing = result.missing; continue; }
      const heard = result.heard[index] ?? { text: "", p: null };
      Object.assign(line, { heard: heard.text, p: heard.p, model: result.model }, unitsMatched(line.text, heard.text, language));
    }
  }
  return out;
}

const quote = (text) => `"${String(text).replaceAll('"', "'").slice(0, 120)}"`;

/** The answer: one line per kept line. */
export function linesHeardText(lines, { scene = "the scene" } = {}) {
  if (!lines.length) return `lines heard ${scene}: no kept lines here (keep_line keeps one; this listens to each in the mix)`;
  const models = [...new Set(lines.map((line) => line.model).filter(Boolean))];
  const head = `lines heard ${scene}: each kept line's stretch of the scene's mix, heard by whisper on this computer${models.length ? ` (${models.join(", ")})` : ""}; a line counts as heard when ${Math.round(MATCH_SHARE * 100)}% of its own words are among the words heard (a starting guess)`;
  const rows = lines.slice(0, 16).map((line) => {
    const unit = NO_SPACE_LANGUAGES.has(line.language) ? "characters" : "words";
    const guess = line.guess ? `; language guess ${line.guess.language} p ${line.guess.p} (under ${LANG_SURE}: unsure, the line's words may be sound-alikes)` : "";
    const own = `line ${line.text ? quote(line.text) : "(no words read)"} (${line.language}${guess})${line.gloss ? ` [${GLOSS_LABEL}: ${quote(line.gloss)}]` : ""}`;
    if (line.missing) return `  ${line.layer} ${line.start}-${line.end} s: ${own} · not heard: ${line.missing}`;
    const heard = line.heard ? `heard ${quote(line.heard)}${line.p !== null ? ` p ${line.p}` : ""}` : "nothing heard";
    const match = !line.of ? "no words of its own to compare (kept by from and to)"
      : `${line.found} of ${line.of} ${unit} match: ${line.found / line.of >= MATCH_SHARE ? "the line is heard" : "other sound than the line (buried, cut or misheard)"}`;
    return `  ${line.layer} ${line.start}-${line.end} s: ${heard} · ${own} · ${match}`;
  });
  return [head, ...rows, ...(lines.length > 16 ? [`  and ${lines.length - 16} more`] : [])].join("\n");
}
