// A word-by-word transcript of a voice file, made on this computer with whisper.cpp's
// `whisper-cli` (Homebrew: brew install whisper-cpp). No sound leaves the computer and nothing is
// downloaded: the model file is one the person put there (KINO_WHISPER_MODEL, or the default
// place below).
//
// Whisper's own word times drift (a segment can start seconds early), so the transcript is made
// in four steps:
//   1. FFmpeg decodes the file to 16 kHz mono samples, and a loudness curve in 10 ms frames finds
//      the silences (energyFrames, silences).
//   2. The sound is split at silences into chunks of a few seconds (chunks), so a timing error
//      inside one chunk cannot drift into the next.
//   3. whisper-cli reads every chunk in one run (the model loads once) with token times from its
//      attention (--dtw), and a prompt full of "um" and repeats, so slips are written down too.
//   4. Each word's start is moved to the nearest place the sound starts (an onset) within a small
//      window, and never left inside silence; its end is where the sound stops before the next
//      word (snapWords).
//   5. A sentence whisper was unsure of (a word under 50% confidence, or unclear sound inside it)
//      is heard again alone, as a short clip, and the reading with the higher mean confidence is
//      kept (unsureSentences, betterReadings); the transcript's `reheard` lists them.
//   6. A short word whisper wrote over and over on noise ("Yeah. Yeah. Yeah.") is unclear sound,
//      not speech (markLoops).
// The prompt also names the project's own names (backend/speech/name-hint.mjs), so whisper spells
// a product's name instead of hearing a common one. The result is kept beside the file
// (<file>.words-<model>, plus -<hash> of the names when there are any), so a file is transcribed
// once per model and names.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NO_SPACE_LANGUAGES, readClipSound } from "../../engine/speech.js";
import { decodeMono } from "../audio-analysis.mjs";
import { endWithService } from "../child-exit.mjs";
import { createSlots } from "../process-slots.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";
import { round } from "../../engine/numbers.js";

// 2: the second listen to unsure sentences. Version 1 files are still read, never made again:
// a voice cut before then has its cut words as positions in them.
export const TRANSCRIPT_VERSION = 2;
export const SAMPLE_RATE = 16_000;
const FRAME = 0.01; // seconds per loudness frame
const FRAME_SAMPLES = SAMPLE_RATE * FRAME;
// Whisper's attention times run about 0.14 s late; a start then moves to an onset from 0.15 s
// earlier to 0.1 s later. Measured on four recorded voiceovers against a forced alignment.
const DTW_SHIFT = -0.14;
const SNAP_BEFORE = 0.15;
const SNAP_AFTER = 0.1;
// Asks whisper to write down fillers and repeats instead of tidying them away.
const VERBATIM_PROMPT = "Um, uh, I I mean, like, we we went there.";
// A sound shorter than this holds no words worth a transcript (a click or a swish): it gets an
// empty one without running whisper, which also fails on clips this short.
export const MIN_SPEECH_SECONDS = 0.5;
// whisper.cpp reads a clip shorter than a second badly: each chunk is padded with silence to this.
const MIN_CHUNK_SECONDS = 1;
// At most this many whisper-cli runs at once in this process (each uses 4 threads and up to 1 GB),
// so many files transcribed together queue instead of loading the computer.
const MAX_WHISPER_RUNS = 2;
// How long a file whisper failed on waits before it is tried again (createTranscriptCache).
const FAILED_RETRY_MS = 10 * 60_000;
let whisperRuns = 0;
const whisperQueue = [];
async function whisperSlot(work) {
  if (whisperRuns >= MAX_WHISPER_RUNS) await new Promise((resolve) => whisperQueue.push(resolve));
  whisperRuns += 1;
  try { return await work(); } finally {
    whisperRuns -= 1;
    whisperQueue.shift()?.();
  }
}

/**
 * whisper's prompt: the verbatim one, then the project's names. Names after it work better than
 * before it: whisper reads the prompt as the words said just before, and the last ones count most.
 * The second listen (verbatim false) gives only the names: there the content counts, and the
 * verbatim prompt made whisper hear "go on" in crowd noise.
 */
export function whisperPrompt(names = [], { verbatim = true } = {}) {
  const list = names.length ? `${names.join(", ")}.` : "";
  return verbatim ? `${VERBATIM_PROMPT}${list ? ` ${list}` : ""}` : list;
}

/** Where the model is looked for when KINO_WHISPER_MODEL is not set. */
export function defaultModelPaths(home = homedir()) {
  return [
    path.join(home, ".kino", "models", "ggml-small.en.bin"),
    path.join(home, ".kino", "models", "ggml-base.en.bin"),
    "/opt/homebrew/share/whisper-cpp/ggml-small.en.bin",
    "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
    "/usr/local/share/whisper-cpp/ggml-small.en.bin",
  ];
}

const INSTALL_HELP = "Install whisper.cpp (macOS: brew install whisper-cpp) and put a model file such as ggml-small.en.bin (from huggingface.co/ggerganov/whisper.cpp) in ~/.kino/models/, or set KINO_WHISPER_MODEL to its path. For other languages, also put ggml-small.bin in ~/.kino/models/ (kino fetches it once when a clip needs it). kino transcribes on this computer.";

// ---- other languages ---------------------------------------------------------------------------
// The English model (small.en) writes sound-alike English words for speech in another language
// ("I see." on run 8's clip F4.13, sung in Japanese). A clip whose English transcript has voice is
// heard once more by the multilingual small model: its language, its words as said and whisper's
// English for them (-tr). The voiceover path (whisperSetup, cut_speech) stays on the English model.

/** The multilingual model kino fetches once, the first time a clip in another language needs it. */
export const LANGUAGE_MODEL = Object.freeze({
  file: "ggml-small.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  // Measured on the file the lead fetched (2026-11-12): its sha1 55356645… matches whisper.cpp's models table.
  bytes: 487_601_967,
  sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
});
const MODEL_HOSTS = /(^|\.)(huggingface\.co|hf\.co)$/;
// Languages written without spaces between words (engine/speech.js).
export const NO_SPACE = NO_SPACE_LANGUAGES;
// A language whisper names with less confidence than this is not trusted: the English transcript
// stays. A guess: F4.13 (sung Japanese over music) read ja at p 0.76.
export const LANG_SURE = 0.5;

/** Where the multilingual model is looked for when KINO_WHISPER_LANG_MODEL is not set. */
export function languageModelPaths(home = homedir()) {
  return [
    path.join(home, ".kino", "models", LANGUAGE_MODEL.file),
    path.join(home, ".kino", "models", "ggml-base.bin"),
    "/opt/homebrew/share/whisper-cpp/ggml-small.bin",
  ];
}

/** {command, model, modelName, dtw} for the multilingual model, or null when there is none (never throws). */
export function languageSetup({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  const model = env.KINO_WHISPER_LANG_MODEL || languageModelPaths(home).find((file) => exists(file));
  if (!model || !exists(model)) return null;
  const modelName = path.basename(model).replace(/^ggml-/, "").replace(/\.bin$/, "");
  const dtw = /^(tiny|base|small|medium|large-v[123])/.exec(modelName)?.[0] ?? null;
  return { command: env.KINO_WHISPER_CLI || "whisper-cli", model, modelName, dtw };
}

/**
 * Fetches the multilingual model into ~/.kino/models once (488 MB): written to a .part file beside
 * it and renamed into place only when its size and SHA-256 match. Answers its path.
 */
export async function fetchLanguageModel({ home = homedir(), fetchFile = fetch } = {}) {
  const folder = path.join(home, ".kino", "models");
  const target = path.join(folder, LANGUAGE_MODEL.file);
  if (existsSync(target)) return target;
  await mkdir(folder, { recursive: true });
  const partial = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.part`;
  try {
    const response = await fetchFile(LANGUAGE_MODEL.url, { redirect: "follow" });
    const host = response.url ? new URL(response.url).hostname : "huggingface.co";
    if (!response.ok || !response.body || !MODEL_HOSTS.test(host)) throw new Error(`the download failed (HTTP ${response.status}, ${host})`);
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; hash.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: "wx", mode: 0o644 }));
    if (received !== LANGUAGE_MODEL.bytes || hash.digest("hex") !== LANGUAGE_MODEL.sha256) throw new Error(`the download did not match (${received} bytes)`);
    await rename(partial, target);
    return target;
  } finally {
    await rm(partial, { force: true }).catch(() => {});
  }
}

/** {command, model, modelName, dtw} for this computer, or throws an error that says how to install. */
export function whisperSetup({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  const command = env.KINO_WHISPER_CLI || "whisper-cli";
  const model = env.KINO_WHISPER_MODEL || defaultModelPaths(home).find((file) => exists(file));
  if (!model || !exists(model)) {
    const error = new Error(`No whisper model file${env.KINO_WHISPER_MODEL ? ` at ${env.KINO_WHISPER_MODEL}` : ""}. ${INSTALL_HELP}`);
    error.code = "SPEECH_MODEL_MISSING";
    throw error;
  }
  const modelName = path.basename(model).replace(/^ggml-/, "").replace(/\.bin$/, "");
  // --dtw needs the model's name (tiny, base, small, medium, large-v3 …, with .en when English only).
  const dtw = /^(tiny|base|small|medium|large-v[123])(\.en)?/.exec(modelName)?.[0] ?? null;
  return { command, model, modelName, dtw };
}

// ---- loudness ----------------------------------------------------------------------------------

/** Loudness in dB of each 10 ms frame. */
export function energyFrames(samples) {
  const count = Math.floor(samples.length / FRAME_SAMPLES);
  const db = new Float32Array(count);
  for (let frame = 0; frame < count; frame += 1) {
    let sum = 0;
    for (let i = frame * FRAME_SAMPLES; i < (frame + 1) * FRAME_SAMPLES; i += 1) sum += samples[i] * samples[i];
    db[frame] = 10 * Math.log10(sum / FRAME_SAMPLES + 1e-10);
  }
  return db;
}

function percentile(values, share) {
  const sorted = Float32Array.from(values).sort();
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] : -100;
}

/** The level under which a frame is silence: a third of the way from the noise floor to the voice. */
export function silenceLevel(db) {
  const floor = percentile(db, 0.1);
  const voice = percentile(db, 0.9);
  return floor + Math.max(6, (voice - floor) / 3);
}

/** The runs of silent frames, as [{start, end}] in seconds, each at least `min` seconds long. */
export function silences(db, level, min = 0.1) {
  const runs = [];
  let from = null;
  for (let frame = 0; frame <= db.length; frame += 1) {
    const quiet = frame < db.length && db[frame] < level;
    if (quiet && from === null) from = frame;
    if (!quiet && from !== null) {
      if ((frame - from) * FRAME >= min - 1e-9) runs.push({ start: from * FRAME, end: frame * FRAME });
      from = null;
    }
  }
  return runs;
}

/**
 * Where the sound starts after a quieter moment, in seconds: a frame that crosses `level` after at
 * least 30 ms below it, or a rise of 9 dB within 40 ms out of a dip inside speech.
 */
export function onsets(db, level) {
  const found = [];
  let quietFor = 0;
  for (let frame = 0; frame < db.length; frame += 1) {
    if (db[frame] < level) { quietFor += 1; continue; }
    if (quietFor >= 3) found.push(frame * FRAME);
    else if (frame >= 1 && frame + 4 < db.length) {
      const dip = db[frame - 1] <= db[frame] && db[frame - 1] < (frame >= 2 ? db[frame - 2] : Infinity);
      if (dip && Math.max(db[frame + 1], db[frame + 2], db[frame + 3], db[frame + 4]) - db[frame - 1] >= 9) found.push(frame * FRAME);
    }
    quietFor = 0;
  }
  return found;
}

// ---- chunks ------------------------------------------------------------------------------------

/**
 * Splits `duration` seconds at the middles of silences of `minSilence` seconds or longer into
 * [{start, end}] chunks: each grows to about `target` seconds, and one never passes `max` when a
 * silence lets it end sooner. Chunks that are all silence are left out.
 */
export function chunks(duration, quiet, { minSilence = 0.2, target = 5, max = 15 } = {}) {
  const cuts = quiet.filter((run) => run.end - run.start >= minSilence && run.start > 0 && run.end < duration)
    .map((run) => ({ at: (run.start + run.end) / 2, length: run.end - run.start }));
  const parts = [];
  let start = 0;
  // A leading silence is skipped: the first chunk starts 0.1 s before the first sound.
  const lead = quiet.find((run) => run.start === 0);
  if (lead) start = Math.max(0, lead.end - 0.1);
  while (start < duration - 0.05) {
    const ahead = cuts.filter((cut) => cut.at > start + 0.5);
    // The first silence after `target` seconds, else the longest one before `max`.
    let next = ahead.find((cut) => cut.at - start >= target && cut.at - start <= max);
    if (!next) {
      const within = ahead.filter((cut) => cut.at - start <= max);
      next = within.length && duration - start > max ? within.reduce((a, b) => (b.length > a.length ? b : a)) : null;
    }
    const end = next ? next.at : duration;
    parts.push({ start, end });
    start = end;
  }
  // A chunk that is all silence (a long pause between two cuts) gives whisper nothing to hear.
  return parts.filter((part) => !quiet.some((run) => run.start <= part.start + 0.02 && run.end >= part.end - 0.02));
}

// Chunks of about 5 s give whisper enough words around each one to spell names right; chunks of
// one phrase (about 1.5 s) keep more of the slips, which whisper tends to tidy away in longer ones.
const COARSE = { minSilence: 0.2, target: 5, max: 15 };
const FINE = { minSilence: 0.15, target: 1.5, max: 8 };

const plain = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const FILLER_WORDS = new Set(["um", "uh", "er", "erm", "ah", "hmm", "mm", "uhm", "umm"]);

/** The words without fillers and with each word or 2-3-word run said twice in a row said once. */
export function withoutSlips(texts) {
  let list = texts.map(plain).filter((word) => word && !FILLER_WORDS.has(word));
  for (let changed = true; changed;) {
    changed = false;
    for (let size = 3; size >= 1 && !changed; size -= 1) {
      for (let i = 0; i + 2 * size <= list.length; i += 1) {
        if (list.slice(i, i + size).join(" ") === list.slice(i + size, i + 2 * size).join(" ")) {
          list = [...list.slice(0, i), ...list.slice(i + size)];
          changed = true;
          break;
        }
      }
    }
  }
  return list.join(" ");
}

/**
 * The coarse words, with each fine chunk's words used instead where the fine chunk heard the same
 * words plus slips the coarse pass left out (a repeat, an "um"): the content matches, so only the
 * slips are new.
 */
export function mergePasses(coarse, fine, fineParts) {
  let words = coarse;
  for (const [index, part] of fineParts.entries()) {
    const extra = fine[index];
    const inside = (word) => word.at >= part.start && word.at < part.end;
    const mine = words.filter(inside);
    if (extra.length <= mine.length || withoutSlips(extra.map((word) => word.text)) !== withoutSlips(mine.map((word) => word.text))) continue;
    const first = words.findIndex(inside);
    words = first < 0 ? [...words.filter((word) => word.at < part.start), ...extra, ...words.filter((word) => word.at >= part.end)]
      : [...words.slice(0, first), ...extra, ...words.slice(first + mine.length)];
  }
  return words;
}

// ---- whisper -----------------------------------------------------------------------------------

function pcm16Wav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVEfmt ", 8, "latin1");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "latin1");
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buffer;
}

function run(command, args, options) {
  return whisperSlot(() => runNow(command, args, options));
}

function runNow(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = endWithService(spawn(command, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] }));
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timer.unref?.();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        const missing = new Error(`whisper-cli was not found (${command}). ${INSTALL_HELP}`);
        missing.code = "SPEECH_TOOL_MISSING";
        reject(missing);
      } else reject(new Error(`whisper-cli could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Transcribing took longer than five minutes."));
      else if (code !== 0) reject(new Error(`whisper-cli failed: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) || `exit ${code}`}`));
      else resolve(stderr);
    });
  });
}

/**
 * The words of whisper-cli's full JSON (-ojf): tokens that start with a space start a word, the
 * others (punctuation, word pieces) join the word before. Special tokens ([_BEG_], [_TT_…]) are
 * skipped. Times are seconds into the chunk: the DTW time when there is one, else the token's own.
 */
export function wordsFromWhisper(json, { segmentWords = false } = {}) {
  const words = [];
  // An opening bracket token (" [", " (", " *") starts whisper's sound tag ("[Singing in Japanese]"):
  // it belongs to the next word. Glued to the word before, the tag lost its start and its words read
  // as a line ("Singing in", run 8's clip F4.13).
  let open = "";
  for (const segment of json?.transcription ?? []) {
    // segmentWords (a language written without spaces): a segment's first token starts a word too,
    // so segments do not glue into one word.
    let first = segmentWords;
    for (const token of segment.tokens ?? []) {
      const text = String(token.text ?? "");
      if (!text || /^\[_/.test(text.trim()) || /^<\|/.test(text.trim())) continue;
      const own = (token.offsets?.from ?? 0) / 1000;
      const dtw = typeof token.t_dtw === "number" && token.t_dtw >= 0 ? token.t_dtw / 100 : null;
      const p = typeof token.p === "number" ? token.p : 1;
      const startsWord = /^\s/.test(text) || !words.length || first;
      first = false;
      const letters = /[\p{L}\p{N}]/u.test(text);
      if (startsWord && !letters && /^[[(*]+$/.test(text.trim())) { open += text.trim(); continue; }
      if (open && letters) {
        words.push({ text: `${open}${text.trim()}`, at: dtw ?? own, dtw: dtw !== null, own, end: (token.offsets?.to ?? 0) / 1000, p: [p] });
        open = "";
      } else if (startsWord && letters) words.push({ text: text.trim(), at: dtw ?? own, dtw: dtw !== null, own, end: (token.offsets?.to ?? 0) / 1000, p: [p] });
      else if (words.length) {
        const last = words.at(-1);
        last.text += text.trim();
        last.end = Math.max(last.end, (token.offsets?.to ?? 0) / 1000);
        if (letters) last.p.push(p);
      }
    }
  }
  // A segment-word holds a whole phrase of tokens: its p is their mean (as whisperSegments'), since the
  // least sure of 10+ tokens says little (run 8's F4.13: its main phrase had min 0.36 and was dropped).
  const pOf = (list) => (segmentWords ? list.reduce((sum, p) => sum + p, 0) / list.length : Math.min(...list));
  return words.map((word) => ({ text: word.text, at: word.at, dtw: word.dtw, own: word.own, end: word.end, p: pOf(word.p) }));
}

/**
 * Runs whisper-cli over chunk files, one run per group side by side (the model loads once per
 * run); resolves with one word list per file, in order. A group's `args` are added to its run.
 */
async function whisperChunks(groups, setup, { timeoutMs = 300_000, prompt = VERBATIM_PROMPT, language = "en" } = {}) {
  const args = ["-m", setup.model, "-l", language, "-ojf", "-np", "-nfa", "-t", "4", ...(prompt ? ["--prompt", prompt] : [])];
  if (setup.dtw) args.push("--dtw", setup.dtw);
  const used = groups.filter((group) => group.files.length);
  await Promise.all(used.map((group) => run(setup.command, [...args, ...(group.args ?? []), ...group.files], { timeoutMs })));
  return Promise.all(groups.flatMap((group) => group.files).map(async (file) => {
    let json;
    try { json = JSON.parse(await readFile(`${file}.json`, "utf8")); }
    catch { throw new Error("whisper-cli wrote no transcript (is it whisper.cpp 1.7 or newer?)."); }
    return wordsFromWhisper(json, { segmentWords: NO_SPACE.has(language) });
  }));
}

/**
 * whisper-cli over pieces of 16 kHz mono samples in one run (the model loads once): the segments
 * of each piece, [{from, to, text, p}] (seconds into the piece; p: the mean word-token confidence).
 * `args` are added to the run. The songs' vocal spans use it (backend/song-shape.mjs).
 */
export async function whisperSegments(pieces, setup, { args = [], timeoutMs = 300_000, language = "en" } = {}) {
  const folder = await makeTempFolder("kino-speech-");
  try {
    const files = [];
    for (const [index, samples] of pieces.entries()) {
      const file = path.join(folder, `piece-${index}.wav`);
      await writeFile(file, pcm16Wav(samples));
      files.push(file);
    }
    if (files.length) await run(setup.command, ["-m", setup.model, "-l", language, "-ojf", "-np", "-nfa", "-t", "4", ...args, ...files], { timeoutMs });
    return Promise.all(files.map(async (file) => {
      let json;
      try { json = JSON.parse(await readFile(`${file}.json`, "utf8")); }
      catch { throw new Error("whisper-cli wrote no transcript (is it whisper.cpp 1.7 or newer?)."); }
      return (json.transcription ?? []).map((segment) => {
        const tokens = (segment.tokens ?? []).filter((token) => /[\p{L}]/u.test(String(token.text ?? "")) && !/^\s*\[_|^\s*<\|/.test(String(token.text ?? "")));
        return { from: (segment.offsets?.from ?? 0) / 1000, to: (segment.offsets?.to ?? 0) / 1000, text: String(segment.text ?? "").trim(),
          p: tokens.length ? tokens.reduce((sum, token) => sum + (typeof token.p === "number" ? token.p : 1), 0) / tokens.length : 0 };
      });
    }));
  } finally {
    await removeTempFolder(folder);
  }
}

// ---- word times --------------------------------------------------------------------------------

/**
 * Final word times in seconds from whisper's: each start moves to the nearest onset from
 * SNAP_BEFORE earlier to SNAP_AFTER later (never before the previous word), a start inside
 * silence moves to where the sound comes back, and each end is where the sound stops before the
 * next word starts. `quiet` is the silence list.
 */
export function snapWords(words, { db, level, quiet, duration }) {
  const starts = onsets(db, level);
  const silentAt = (time) => { const frame = Math.floor(time / FRAME); return frame < db.length && db[frame] < level; };
  const out = [];
  let floor = 0;
  for (const word of words) {
    let start = Math.max(floor, word.at + (word.dtw ? DTW_SHIFT : 0));
    const near = starts.filter((time) => time >= Math.max(floor, start - SNAP_BEFORE) && time <= start + SNAP_AFTER);
    if (near.length) start = near.reduce((best, time) => (Math.abs(time - start) < Math.abs(best - start) ? time : best));
    else if (silentAt(start)) {
      const run = quiet.find((item) => item.start <= start + 1e-9 && item.end > start);
      if (run && run.end - start <= 1) start = run.end;
    }
    start = Math.min(duration, Math.max(floor, start));
    out.push({ text: word.text, start, p: word.p });
    floor = start + 0.05;
  }
  for (let i = 0; i < out.length; i += 1) {
    const next = i + 1 < out.length ? out[i + 1].start : duration;
    // Where the sound stops: the first silence of 0.1 s or more that starts before the next word.
    const stop = quiet.find((run) => run.start > out[i].start + 0.05 && run.start < next);
    out[i].end = Math.min(next, stop ? stop.start : next);
    if (out[i].end - out[i].start < 0.05) out[i].end = Math.min(next, out[i].start + 0.05);
  }
  return out;
}

/**
 * Sound of 0.25 s or more, clearly above the silence level, that no word covers (a mumble, a
 * cough, a word whisper did not write down) becomes an entry {text: "(unclear)", unclear: true},
 * so it can be cut like a word.
 */
export function withUnclear(words, { db, level, quiet, duration }) {
  const loud = [];
  let from = 0;
  for (const run of [...quiet, { start: duration, end: duration }]) {
    if (run.start - from >= 0.25) loud.push({ start: from, end: run.start });
    from = run.end;
  }
  const extra = loud.filter((part) => !words.some((word) => word.start < part.end && word.end > part.start))
    .filter((part) => {
      let peak = -Infinity;
      for (let frame = Math.floor(part.start / FRAME); frame < Math.min(db.length, Math.ceil(part.end / FRAME)); frame += 1) peak = Math.max(peak, db[frame]);
      return peak >= level + 6;
    })
    .map((part) => ({ text: "(unclear)", start: part.start, end: part.end, p: 0, unclear: true }));
  return [...words, ...extra].sort((a, b) => a.start - b.start);
}

/**
 * Adds each word's `cut`: the quietest 10 ms frame in the 0.12 s before its start (not before the
 * end of the word before, unless they touch), so a cut there lands in the gap and not in a sound.
 * The list's `tail` is the same point after the last word (within 0.3 s).
 */
export function withCuts(words, { db, duration }) {
  const quietest = (from, to) => {
    let best = to;
    let low = Infinity;
    for (let frame = Math.max(0, Math.floor(from / FRAME)); frame <= Math.min(db.length - 1, Math.floor(to / FRAME)); frame += 1) {
      if (db[frame] < low) { low = db[frame]; best = frame * FRAME + FRAME / 2; }
    }
    return Math.min(Math.max(best, from), to);
  };
  const out = words.map((word, index) => {
    // Close to the word (0.12 s at most), so a cut keeps the pause before the words it removes.
    let from = Math.max(index ? words[index - 1].end : 0, word.start - 0.12);
    if (word.start - from < 0.05) from = Math.max(index ? words[index - 1].start + 0.02 : 0, word.start - 0.05);
    return { ...word, cut: quietest(Math.max(0, from), word.start) };
  });
  const last = words.at(-1);
  out.tail = last ? quietest(last.end, Math.min(duration, last.end + 0.3)) : duration;
  return out;
}

// ---- loops -------------------------------------------------------------------------------------

const LOOP_RUN = 4; // a word (or pair of words) this many times in a row may be whisper looping
const LOOP_LONG = 7; // this many times in a row is a loop however sure whisper was
const LOOP_SURE = 0.7; // a run under this mean confidence is a loop
const LOOP_STEP = 0.15; // seconds: words closer together than this (median) are too fast to be said
const PHRASE = 3; // a phrase of this many words or more (up to PHRASE_LONGEST) said
const PHRASE_RUN = 3; // this many times in a row is a loop ("I think that's what we're talking about" x9)
const PHRASE_LONGEST = 12;

/**
 * Whisper, hearing noise (street sound, a crowd), can write one short word over and over ("Yeah.
 * Yeah. Yeah.", "Mm hmm. Mm hmm."), each time a little surer. A word or pair of words 4 or more
 * times in a row is such a loop when it runs 7 or more times, its mean confidence is under 0.7, or
 * its words come faster than one per 0.15 s. Its words become unclear sound ({text: "(unclear)",
 * unclear: true, heard: whisper's text}), which captions, speech checks and ducking leave out. A
 * real repeat ("no, no, no, no", sure and spaced) stays words. A phrase of 3 to 12 words 3 or
 * more times in a row is a loop however sure (whisper repeating a sentence over other speech).
 * Positions never change, so a cut voice's word indices still name the same words; saved
 * transcripts get it when they are read.
 */
export function markLoops(words) {
  const out = words.slice();
  const key = (word) => (word?.unclear ? "" : plain(String(word?.text ?? "")));
  const unitAt = (at, size) => words.slice(at, at + size).map(key);
  for (let at = 0; at < words.length;) {
    let best = null;
    for (let size = 1; size <= PHRASE_LONGEST; size += 1) {
      const unit = unitAt(at, size);
      if (unit.length < size || unit.some((text) => !text) || (size === 2 && unit[0] === unit[1])) continue;
      let count = 1;
      while (unitAt(at + count * size, size).join(" ") === unit.join(" ")) count += 1;
      if (count >= (size >= PHRASE ? PHRASE_RUN : LOOP_RUN) && (!best || count * size > best.length)) best = { count, length: count * size, phrase: size >= PHRASE };
    }
    if (!best) { at += 1; continue; }
    const run = words.slice(at, at + best.length);
    const mean = run.reduce((sum, word) => sum + (word.p ?? 1), 0) / run.length;
    const steps = run.slice(1).map((word, index) => word.start - run[index].start).sort((a, b) => a - b);
    const step = steps[Math.floor(steps.length / 2)];
    if (best.phrase || best.count >= LOOP_LONG || mean < LOOP_SURE || step < LOOP_STEP) {
      for (let index = at; index < at + best.length; index += 1) out[index] = { ...words[index], text: "(unclear)", unclear: true, heard: words[index].text };
    }
    at += best.length;
  }
  return out;
}

// A saved transcript as it is read: whisper's loops marked (made before markLoops, or after).
const asRead = (saved) => ({ ...saved, words: markLoops(saved.words), cached: true });

// ---- second listen -----------------------------------------------------------------------------

const UNSURE_P = 0.5; // a word under this confidence makes its sentence worth hearing again
const SENTENCE_GAP = 0.7; // a pause this long (seconds) ends a sentence without a full stop
const REHEAR_MARGIN = 0.15; // seconds of sound kept around a sentence heard alone
const REHEAR_SHORTEST = 0.5; // a shorter clip gives whisper too little to hear
const REHEAR_LONGEST = 12; // a longer sentence was a chunk of its own already
const LONG_FILE = 8; // a shorter file was heard as one clip already
const KEEP_SHARE = 0.75; // a second reading keeps this share of the words (dropping words looks surer)
const SAME_SHARE = 0.4; // and shares this many of them with the first (else it heard other sound)

/**
 * The sentences of a long file worth hearing again alone: those with a word under 50% confidence
 * or unclear sound inside. `words` are snapped words, each heard one with `index` (its place in
 * the heard list; unclear entries have none). A sentence ends at . ? ! or a pause of 0.7 s.
 * Answers [{start, end, from, to}]: the clip in file seconds (a little margin, never into the
 * words around it) and the indices of its first and last heard word.
 */
export function unsureSentences(words, duration) {
  if (duration < LONG_FILE) return [];
  const sentences = [];
  let current = [];
  for (const [i, word] of words.entries()) {
    if (current.length && word.start - words[i - 1].end >= SENTENCE_GAP) { sentences.push(current); current = []; }
    current.push(word);
    if (!word.unclear && /[.?!]["'”]?$/.test(word.text)) { sentences.push(current); current = []; }
  }
  if (current.length) sentences.push(current);
  return sentences.flatMap((sentence) => {
    const heard = sentence.filter((word) => !word.unclear);
    if (!heard.length || (!sentence.some((word) => word.unclear) && !heard.some((word) => word.p < UNSURE_P))) return [];
    const before = words[words.indexOf(sentence[0]) - 1];
    const after = words[words.indexOf(sentence.at(-1)) + 1];
    const start = Math.max(0, before?.end ?? 0, sentence[0].start - REHEAR_MARGIN);
    const end = Math.min(duration, after?.start ?? duration, sentence.at(-1).end + REHEAR_MARGIN);
    return end - start > REHEAR_LONGEST || end - start < REHEAR_SHORTEST ? [] : [{ start, end, from: heard[0].index, to: heard.at(-1).index }];
  });
}

/**
 * Puts each sentence's second reading (`readings[i]`, words in file seconds) in place of the
 * first in `heard` (the word list before snapping) when its mean confidence is higher, it keeps
 * at least 75% as many words and 40% of the first reading's words are in it (a reading with
 * other words heard noise as speech, often surely). A first reading that is mostly a whisper loop
 * (markLoops) is wrong whatever it says: a surer second reading with no loop of its own wins
 * without the word tests. Answers {heard, reheard: [{start, end, first, second, p: [first,
 * second], kept: "first" | "second"}]}.
 */
export function betterReadings(heard, sentences, readings) {
  const mean = (list) => (list.length ? list.reduce((sum, word) => sum + word.p, 0) / list.length : 0);
  const textOf = (list) => list.map((word) => word.text).join(" ");
  const shared = (first, second) => {
    const left = second.map((word) => plain(word.text));
    return first.filter((word) => { const at = left.indexOf(plain(word.text)); if (at >= 0) left.splice(at, 1); return at >= 0; }).length;
  };
  let words = heard;
  const reheard = [];
  // From the last sentence back, so the indices of the earlier ones stay right.
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i];
    const first = heard.slice(sentence.from, sentence.to + 1);
    const second = (readings[i] ?? []).filter((word) => word.at >= sentence.start - 0.05 && word.at < sentence.end);
    const looped = (list) => markLoops(list).filter((word) => word.unclear).length;
    const like = looped(first) * 2 >= first.length && first.length > 0 ? second.length > 0 && !looped(second)
      : second.length >= Math.ceil(first.length * KEEP_SHARE) && shared(first, second) >= Math.ceil(first.length * SAME_SHARE);
    const better = like && mean(second) > mean(first);
    if (better) words = [...words.slice(0, sentence.from), ...second, ...words.slice(sentence.to + 1)];
    reheard.unshift({ start: round(sentence.start, 2), end: round(sentence.end, 2), first: textOf(first), second: textOf(second),
      p: [round(mean(first), 2), round(mean(second), 2)], kept: better ? "second" : "first" });
  }
  return { heard: words, reheard };
}

function clipOf(samples, part) {
  const clip = samples.subarray(Math.floor(part.start * SAMPLE_RATE), Math.ceil(part.end * SAMPLE_RATE));
  const least = MIN_CHUNK_SECONDS * SAMPLE_RATE;
  if (clip.length >= least) return pcm16Wav(clip);
  const padded = new Float32Array(least);
  padded.set(clip);
  return pcm16Wav(padded);
}

/**
 * Transcribes one file: {version, model, duration, words: [{text, start, end, p, cut, unclear?, heard?}],
 * tail, names?, reheard?}.
 * Times are seconds into the file. `setup` is whisperSetup()'s answer; `names` the project's names
 * for the prompt (backend/speech/name-hint.mjs).
 */
export function transcribeFile(filename, setup, options = {}) {
  // As many files at once as whisper runs: a file is decoded only when it can be transcribed, so
  // ten files asked for together do not each hold their decoded sound (up to 38 MB) in a queue.
  return transcribeSlot(() => transcribeFileNow(filename, setup, options));
}
const transcribeSlot = createSlots(MAX_WHISPER_RUNS);
/** Other whisper work (a song's vocal spans) waits its turn with the transcriptions, decoding included. */
export function whisperTurn(work) {
  return transcribeSlot(work);
}

const DETECT_PAD = 0.2; // seconds of sound kept around each heard span for language detection
const DETECT_MOST = 30; // whisper decides the language from its first 30 s window

/**
 * The language whisper hears in `spans` ([{start, end}] file seconds, the voice the English pass
 * found; the first 30 s when there are none) of 16 kHz `samples`: {language, p} or null. One run of
 * `whisper-cli -l auto -dl` (detect only: about 0.2 s on small, measured on F4.13).
 */
export async function detectLanguage(samples, setup, spans = []) {
  const parts = [];
  let total = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const from = Math.max(0, Math.floor((span.start - DETECT_PAD) * SAMPLE_RATE));
    const to = Math.min(samples.length, Math.ceil((span.end + DETECT_PAD) * SAMPLE_RATE));
    if (to <= from || total >= DETECT_MOST * SAMPLE_RATE) continue;
    const piece = samples.subarray(from, Math.min(to, from + DETECT_MOST * SAMPLE_RATE - total));
    parts.push(piece);
    total += piece.length;
  }
  const joined = parts.length ? new Float32Array(total) : samples.subarray(0, DETECT_MOST * SAMPLE_RATE);
  if (parts.length) { let at = 0; for (const piece of parts) { joined.set(piece, at); at += piece.length; } }
  const folder = await makeTempFolder("kino-speech-");
  try {
    const file = path.join(folder, "detect.wav");
    await writeFile(file, clipOf(joined, { start: 0, end: joined.length / SAMPLE_RATE }));
    // Without -np: the detected language's probability is only in the log line.
    const stderr = await run(setup.command, ["-m", setup.model, "-l", "auto", "-dl", "-oj", "-t", "4", file], { timeoutMs: 120_000 });
    const logged = /auto-detected language: (\w+) \(p = ([\d.]+)\)/.exec(String(stderr ?? ""));
    let language = logged?.[1] ?? null;
    try { language = JSON.parse(await readFile(`${file}.json`, "utf8"))?.result?.language ?? language; } catch { /* the log line is enough */ }
    return language ? { language, p: logged ? round(Number(logged[2]), 2) : null } : null;
  } finally {
    await removeTempFolder(folder);
  }
}

/**
 * A file in another language: one coarse pass in that language (no fine pass or second listen:
 * both were tuned on English voiceovers) and, side by side, whisper's English for the same chunks
 * (-tr), as english: [{start, end, text}] in file seconds.
 */
async function transcribeInLanguage(samples, sound, setup, { names, language, folder }) {
  const { duration } = sound;
  const parts = chunks(duration, sound.quiet, COARSE);
  const files = [];
  for (const [index, part] of parts.entries()) {
    const file = path.join(folder, `chunk-${index}.wav`);
    await writeFile(file, clipOf(samples, part));
    files.push(file);
  }
  const pieces = parts.map((part) => samples.subarray(Math.floor(part.start * SAMPLE_RATE), Math.ceil(part.end * SAMPLE_RATE)));
  const [lists, glosses] = await Promise.all([
    whisperChunks([{ files }], setup, { prompt: whisperPrompt(names, { verbatim: false }), language }),
    whisperSegments(pieces, setup, { language, args: ["-tr"] }),
  ]);
  const heard = lists.flatMap((list, index) => list.map((word) => ({ ...word, at: word.at + parts[index].start, own: word.own + parts[index].start }))).filter((word) => word.at < duration);
  const english = glosses.flatMap((segments, index) => segments.filter((segment) => /\p{L}/u.test(segment.text) && !/^[[(*].*[\])*]$/.test(segment.text))
    .map((segment) => ({ start: round(segment.from + parts[index].start), end: round(Math.min(duration, segment.to + parts[index].start)), text: segment.text })));
  return { heard, english };
}

async function transcribeFileNow(filename, setup, { decode = decodeMono, debug = false, names = [], language = "en" } = {}) {
  const { samples } = await decode(filename, { sampleRate: SAMPLE_RATE });
  if (!samples.length) throw new Error("The file has no sound.");
  const duration = samples.length / SAMPLE_RATE;
  if (duration < MIN_SPEECH_SECONDS) return { version: TRANSCRIPT_VERSION, model: setup.modelName, duration: round(duration), words: [], tail: round(duration), short: true, ...(names.length ? { names } : {}) };
  const db = energyFrames(samples);
  const level = silenceLevel(db);
  const quiet = silences(db, level, 0.1);
  const sound = { db, level, quiet, duration };
  if (language !== "en") {
    const folder = await makeTempFolder("kino-speech-");
    try {
      const { heard, english } = await transcribeInLanguage(samples, sound, setup, { names, language, folder });
      const words = withCuts(withUnclear(snapWords(heard, sound), sound), { db, duration });
      return {
        version: TRANSCRIPT_VERSION, model: setup.modelName, language, duration: round(duration),
        words: markLoops(words.map((word) => ({ text: word.text, start: round(word.start), end: round(word.end), p: round(word.p, 2), cut: round(word.cut), ...(word.unclear ? { unclear: true } : {}) }))),
        tail: round(words.tail ?? duration), english, ...(names.length ? { names } : {}),
      };
    } finally {
      await removeTempFolder(folder);
    }
  }
  const parts = chunks(duration, quiet, COARSE);
  const fineParts = chunks(duration, quiet, FINE);
  const prompt = whisperPrompt(names);
  const folder = await makeTempFolder("kino-speech-");
  try {
    const all = [...parts, ...fineParts];
    const files = [];
    for (const [index, part] of all.entries()) {
      const file = path.join(folder, `chunk-${index}.wav`);
      await writeFile(file, clipOf(samples, part));
      files.push(file);
    }
    // The two passes run side by side.
    const lists = await whisperChunks([{ files: files.slice(0, parts.length) }, { files: files.slice(parts.length) }], setup, { prompt });
    const placeIn = (part) => (word) => ({ ...word, at: word.at + part.start, own: word.own + part.start });
    const placed = lists.map((list, index) => list.map(placeIn(all[index])).filter((word) => word.at < duration));
    const coarse = placed.slice(0, parts.length).flat();
    const firstHeard = mergePasses(coarse, placed.slice(parts.length), fineParts);
    // 5. The unsure sentences, heard again alone in one more run.
    const snapped = snapWords(firstHeard, sound).map((word, index) => ({ ...word, index }));
    const sentences = unsureSentences(withUnclear(snapped, sound), duration);
    let heard = firstHeard;
    let reheard = [];
    if (sentences.length) {
      const clips = [];
      for (const [index, sentence] of sentences.entries()) {
        const file = path.join(folder, `again-${index}.wav`);
        await writeFile(file, clipOf(samples, sentence));
        clips.push(file);
      }
      const again = await whisperChunks([{ files: clips }], setup, { prompt: whisperPrompt(names, { verbatim: false }) });
      ({ heard, reheard } = betterReadings(firstHeard, sentences, again.map((list, index) => list.map(placeIn(sentences[index])))));
    }
    const words = withCuts(withUnclear(snapWords(heard, sound), sound), { db, duration });
    return {
      version: TRANSCRIPT_VERSION, model: setup.modelName, duration: round(duration),
      words: markLoops(words.map((word) => ({
        text: word.text, start: round(word.start), end: round(word.end), p: round(word.p, 2), cut: round(word.cut),
        ...(word.unclear ? { unclear: true } : {}),
      }))),
      tail: round(words.tail ?? duration),
      ...(names.length ? { names } : {}),
      ...(reheard.length ? { reheard } : {}),
      ...(debug ? { debug: { heard, coarse, parts, fineParts, fine: placed.slice(parts.length), level, db, quiet } } : {}),
    };
  } finally {
    await removeTempFolder(folder);
  }
}

/**
 * Where a transcript is kept: <file>.words-<model>, plus -<8 hex> of the names when there are any.
 * Not .json: the library reads <file>.json files as media records.
 */
export function sidecarPath(filename, modelName, names = []) {
  const hint = names.length ? `-${createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 8)}` : "";
  return `${filename}.words-${modelName.replace(/[^a-z0-9.-]/gi, "_")}${hint}`;
}

/**
 * Transcribes each file once per model and names, and keeps the result beside it. get and saved
 * take {names}: the project's names for whisper's prompt (backend/speech/name-hint.mjs).
 */
async function detectFile(filename, setup, spans) {
  const { samples } = await decodeMono(filename, { sampleRate: SAMPLE_RATE });
  return samples.length ? detectLanguage(samples, setup, spans) : null;
}

export function createTranscriptCache({
  setup = () => whisperSetup(), transcribe = transcribeFile, now = () => Date.now(),
  languages = () => languageSetup(), detect = detectFile,
  // Never from a test process (node --test sets NODE_TEST_CONTEXT, as backend/index.mjs reads it): tests make no web requests.
  fetchModel = () => (process.env.NODE_TEST_CONTEXT ? Promise.reject(new Error("no downloads in tests")) : fetchLanguageModel()),
} = {}) {
  const pending = new Map();
  // A file whisper failed on is not tried again for a while: checks ask for the same transcripts
  // over and over, and each failed try costs a whisper run. A missing tool is not remembered.
  const failed = new Map();
  // The multilingual model's one fetch: null, "fetching" or "failed" (not tried again this run).
  let fetchState = null;
  async function readOrMake(filename, found, names, language = "en") {
    const sidecar = sidecarPath(filename, found.modelName, names);
    try {
      const saved = JSON.parse(await readFile(sidecar, "utf8"));
      // An older version is kept, not made again: cut_speech's cut words are positions in it.
      if (saved?.version >= 1 && saved.version <= TRANSCRIPT_VERSION && Array.isArray(saved.words)) return asRead(saved);
    } catch { /* Missing transcripts are made. */ }
    const result = await transcribe(filename, found, { names, ...(language !== "en" ? { language } : {}) });
    const temporary = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar);
    } catch { /* The transcript still counts when the folder cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return { ...result, cached: false };
  }
  /** The transcript of `filename` heard with these names, made when there is none yet. */
  async function get(filename, { names = [] } = {}) {
    const found = setup();
    const key = sidecarPath(filename, found.modelName, names);
    const failure = failed.get(key);
    if (failure && now() - failure.at < FAILED_RETRY_MS) throw failure.error;
    if (!pending.has(key)) pending.set(key, readOrMake(filename, found, names).catch((error) => {
      if (error?.code !== "SPEECH_TOOL_MISSING") failed.set(key, { error, at: now() });
      if (failed.size > 512) failed.delete(failed.keys().next().value);
      throw error;
    }).finally(() => pending.delete(key)));
    return pending.get(key);
  }
  /**
   * The saved transcript of `filename`, or null when there is none yet (or no speech model is set
   * up): the one heard with these names, else (unless `exact`) the one heard without names (an
   * older version counts). Never transcribes: the dashboard's voice lane only shows what is
   * already known. `exact` is for a cut voice, whose cut words point into one transcript only.
   * `any` also takes one heard with other names (the brief's names changed since): enough to
   * say what a clip says, not to cut by.
   */
  /** The language whisper heard in a file ({language, p}), kept in <file>.lang-<model>; null when not checked yet. */
  async function guessOf(filename, found) {
    try { return JSON.parse(await readFile(`${filename}.lang-${found.modelName}`, "utf8")); } catch { return null; }
  }
  const otherLanguage = (guess) => Boolean(guess?.language) && guess.language !== "en" && !(guess.p < LANG_SURE);
  /**
   * The transcript of a clip as said: `english` (get's answer) when it holds no voice, no
   * multilingual model is set up, or whisper hears English (or is unsure, LANG_SURE); else the
   * clip heard in its language, with `english` segments (whisper's English for it) and languageP.
   * A clip the English model tagged as another language starts the model's one fetch when it is
   * missing; the answer then has languageModel: "fetching".
   */
  async function heard(filename, { names = [], english } = {}) {
    const read = readClipSound(english);
    if (!read.lines.length && !read.voice.length) return english;
    const found = languages();
    if (!found) {
      if (read.otherLanguage && fetchState === null) {
        fetchState = "fetching";
        fetchModel().then(() => { fetchState = null; }, () => { fetchState = "failed"; });
      }
      return fetchState === "fetching" ? { ...english, languageModel: "fetching" } : english;
    }
    let guess = await guessOf(filename, found);
    if (!guess) {
      // The clip's first 30 s, not only the spans the English pass heard: on run 8's F4.13 those spans
      // (0.2 s padded) read es at p 0.21, the whole 10 s clip ja at p 0.76 (lines-any-language RESULT.md).
      guess = await detect(filename, found, []);
      if (!guess) return english;
      await writeFile(`${filename}.lang-${found.modelName}`, JSON.stringify(guess), { mode: 0o600 }).catch(() => {});
    }
    if (!otherLanguage(guess)) return english;
    const key = sidecarPath(filename, found.modelName, names);
    if (!pending.has(key)) pending.set(key, readOrMake(filename, found, names, guess.language).finally(() => pending.delete(key)));
    return { ...(await pending.get(key)), language: guess.language, languageP: guess.p };
  }
  async function saved(filename, { names = [], exact = false, any = false } = {}) {
    // A clip heard in its own language (heard) reads that way first.
    if (any && !exact) {
      const found = languages();
      const guess = found ? await guessOf(filename, found) : null;
      if (otherLanguage(guess)) {
        for (const file of new Set([sidecarPath(filename, found.modelName, names), sidecarPath(filename, found.modelName)])) {
          try {
            const value = JSON.parse(await readFile(file, "utf8"));
            if (value?.version >= 1 && Array.isArray(value.words)) return { ...asRead(value), language: guess.language, languageP: guess.p };
          } catch { /* not made yet */ }
        }
      }
    }
    let found;
    try { found = setup(); } catch { return null; }
    if (!found?.modelName) return null;
    const files = [sidecarPath(filename, found.modelName, names), ...(exact ? [] : [sidecarPath(filename, found.modelName)])];
    if (any && !exact) {
      const prefix = `${path.basename(sidecarPath(filename, found.modelName))}-`;
      const others = await readdir(path.dirname(filename)).catch(() => []);
      files.push(...others.filter((name) => name.startsWith(prefix) && !name.endsWith(".tmp")).sort().map((name) => path.join(path.dirname(filename), name)));
    }
    for (const file of new Set(files)) {
      try {
        const value = JSON.parse(await readFile(file, "utf8"));
        if (value?.version >= 1 && value.version <= TRANSCRIPT_VERSION && Array.isArray(value.words)) return asRead(value);
      } catch { /* not made yet */ }
    }
    return null;
  }
  return { get, saved, heard };
}
