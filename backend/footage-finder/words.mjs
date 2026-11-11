// The footage finder's captions: what is SAID in a found video, so an agent can pick a shot or a
// line by its words and not only by its picture.
// 1. fetchCaptions: one video's caption file through yt-dlp (subtitles only, no video), through the
//    shared YouTube gate. Uploaded captions first (the person's languages, then English); if the
//    video has none, the auto captions in the video's own spoken language ("<lang>-orig", never a
//    machine translation). Marked auto. No captions is a normal answer: {none: true}.
// 2. parseCaptions (pure): a WebVTT file as lines [{start, end, text}] in seconds. Auto captions
//    repeat their last line in every rolling cue; the repeats are dropped.
// 3. The pure half the scan and the import answers use: which lines a shot or a clip holds
//    (linesOverlapping, shotSays, saysOf), whether words are said (saidMatches, applySaid), and the
//    list of spoken lines with the shots each covers (spokenLines, linesBlock).
// Caption times are the uploader's (about 0.1 to 0.3 s) or the recognizer's (a line starts near its
// first word and stays until the next line): read them as to the nearest half second.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { jsRuntime, NO_JS_RUNTIME, runYtDlp, ytDlpCommand } from "../inspire.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";

/** A shot or a clip shares at least this many seconds with a line to hold it (less for a tiny shot). */
export const MIN_OVERLAP_SECONDS = 0.1;
/** A line is cut to this many characters in an answer. */
export const SAYS_SHOWN = 60;
/** An import answer says what a clip says only when the clip runs this long (seconds). */
export const SAYS_MIN_SECONDS = 1.5;
/** Lines listed at the end of a scan answer. */
export const LINES_SHOWN = 8;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const round1 = (value) => Math.round(value * 10) / 10;
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const trimTo = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const clockOf = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * The languages to look for, best first: the computer's own language, then English. Two letters
 * each (a caption track "en-US" counts as "en").
 */
export function defaultLanguages(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const own = String(locale ?? "").split(/[-_]/)[0].toLowerCase();
  return [...new Set([/^[a-z]{2,3}$/.test(own) ? own : null, "en"].filter(Boolean))];
}

// ---- parsing -------------------------------------------------------------------------------------

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };
const cleanRow = (row) => oneLine(String(row).replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm|#39);/g, (entity) => ENTITIES[entity] ?? ""));

const CUE_TIME = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const seconds = (hours, minutes, whole, fraction) => Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(whole) + Number(fraction.padEnd(3, "0")) / 1000;

/**
 * A WebVTT file as [{start, end, text}] in seconds, in time order. Tags and entities are removed.
 * A cue's first row that repeats the last row of the cue before it (YouTube's rolling auto
 * captions) is dropped, and so is a cue under 0.05 s (their "finished line" repeat); a line the
 * same as the one before it that starts within 0.5 s of its end is joined to it.
 */
export function parseCaptions(text) {
  const lines = [];
  let previousLast = null;
  for (const block of String(text ?? "").replace(/\r/g, "").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const at = rows.findIndex((row) => row.includes("-->"));
    if (at < 0) continue;
    const time = CUE_TIME.exec(rows[at]);
    if (!time) continue;
    const start = seconds(time[1], time[2], time[3], time[4]);
    const end = seconds(time[5], time[6], time[7], time[8]);
    const body = rows.slice(at + 1).map(cleanRow).filter(Boolean);
    const carried = body.length > 1 && body[0] === previousLast ? body.slice(1) : body;
    if (body.length) previousLast = body.at(-1);
    const words = carried.join(" ");
    if (!words || end - start < 0.05 || end <= start) continue;
    const last = lines.at(-1);
    if (last && last.text === words && start - last.end <= 0.5) last.end = Math.max(last.end, end);
    else lines.push({ start: round1000(start), end: round1000(end), text: words });
  }
  return lines;
}

const round1000 = (value) => Math.round(value * 1000) / 1000;

// ---- fetching ------------------------------------------------------------------------------------

/**
 * The yt-dlp arguments that write one video's captions (no video) into `folder`, as
 * cap.<id>.<language>.vtt. auto false: uploaded tracks in `languages` ("en" and "en-US"); auto
 * true: the auto track of each language's original speech ("en-orig"). runYtDlp adds the private
 * arguments (no config, no cookies, no cache).
 */
export function captionArgs(videoId, folder, { languages = ["en"], auto = false, runtime } = {}) {
  const wanted = languages.filter((language) => /^[a-z]{2,3}$/.test(language));
  return [
    ...(runtime ? ["--js-runtimes", `${runtime.name}:${runtime.path}`] : []),
    "--no-playlist", "--skip-download", "--no-write-thumbnail", "--no-write-info-json",
    auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs", (auto ? wanted.map((language) => `${language}-orig`) : wanted.map((language) => `${language}(-.+)?`)).join(","),
    "--sub-format", "vtt",
    "-o", path.join(folder, "cap.%(id)s.%(ext)s"),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

/** The caption file to read among `names`: the first language in `languages` that has one. Answers {name, lang} or null. */
export function pickCaptionFile(names, languages, { auto = false } = {}) {
  const tracks = names.map((name) => {
    const match = /^cap\.[^.]+\.(.+)\.vtt$/.exec(name);
    return match ? { name, lang: auto ? match[1].replace(/-orig$/, "") : match[1] } : null;
  }).filter(Boolean);
  for (const language of languages) {
    const found = tracks.filter((track) => track.lang === language || track.lang.startsWith(`${language}-`)).sort((a, b) => a.lang.length - b.lang.length)[0];
    if (found) return found;
  }
  return null;
}

/**
 * Reads one YouTube video's captions. Answers {lang, auto, lines} (lines: parseCaptions), or
 * {none: true} when the video has none, or {none: true, why, retry: true} when YouTube could not
 * be asked now (a rate limit, a bot check, no yt-dlp): the caller does not save that answer.
 * Uploaded captions are asked first; only a video without them asks for its auto captions (two
 * requests at most, one after the other through the gate). options: youtube (the shared gate),
 * run(args, {signal, timeoutMs}) (runYtDlp by default; tests pass a stub), command, runtime,
 * languages, signal.
 */
export async function fetchCaptions(videoId, { youtube, run, command, runtime = jsRuntime(), languages = defaultLanguages(), signal } = {}) {
  if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
  if (!runtime) return { none: true, why: NO_JS_RUNTIME, retry: true };
  if (youtube?.paused?.()) return { none: true, why: "YouTube is paused after a bot check", retry: true };
  const runner = run ?? ((args, options) => runYtDlp(args, { ...options, command: command ?? ytDlpCommand() }));
  const gate = youtube ?? ((work) => work());
  for (const auto of [false, true]) {
    const folder = await makeTempFolder("kino-footage-");
    try {
      try {
        await gate(() => runner(captionArgs(videoId, folder, { languages, auto, runtime }), { signal, timeoutMs: 90_000 }), { signal });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        return { none: true, why: trimTo(oneLine(error?.message ?? error), 120), retry: true };
      }
      const picked = pickCaptionFile(await readdir(folder), languages, { auto });
      if (picked) {
        const lines = parseCaptions(await readFile(path.join(folder, picked.name), "utf8"));
        if (lines.length) return { lang: picked.lang, auto, lines };
      }
    } finally {
      await removeTempFolder(folder);
    }
  }
  return { none: true };
}

// ---- which lines a shot holds --------------------------------------------------------------------

/** The lines that share at least MIN_OVERLAP_SECONDS (less for a very short stretch) with [start, end). */
export function linesOverlapping(lines = [], start, end) {
  const need = Math.max(1e-6, Math.min(MIN_OVERLAP_SECONDS, (end - start) / 2));
  return lines.filter((line) => Math.min(line.end, end) - Math.max(line.start, start) >= need);
}

// Quotes inside a line would break the answer's own quotes.
const quoted = (text) => trimTo(oneLine(text).replace(/"/g, "'"), SAYS_SHOWN);

/** What a shot says: its overlapping lines joined by " / ", cut to about 60 characters; "" when none. */
export function shotSays(shot, lines) {
  const near = linesOverlapping(lines, shot.start, shot.end);
  return near.length ? quoted(near.map((line) => line.text).join(" / ")) : "";
}

const compact = (text) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
const wordsOf = (text) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Scripts written without spaces between words: their phrases are matched letter by letter.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function inARow(have, wanted) {
  for (let from = 0; from + wanted.length <= have.length; from += 1)
    if (wanted.every((word, index) => have[from + index] === word)) return true;
  return false;
}

/**
 * True when `text` says `said`: the same words in a row (marks ignored; a Japanese, Chinese or Thai
 * phrase is matched by its letters in a row instead, since it has no spaces), or every word of it
 * (three quarters of the words when there are more than 3), in any order.
 */
export function saidMatches(text, said) {
  const wanted = wordsOf(said);
  if (!wanted.length) return false;
  if (UNSPACED.test(said) ? compact(text).includes(compact(said)) : inARow(wordsOf(text), wanted)) return true;
  const have = new Set(wordsOf(text));
  const found = wanted.filter((word) => have.has(word)).length;
  return found >= (wanted.length <= 3 ? wanted.length : Math.ceil(wanted.length * 0.75));
}

/**
 * The scan's shots with what each says, and `said` applied. Every shot with a caption line gets
 * `says`. With `said`, a shot whose lines say it gets `said: true`; a clean one (a flag of logo
 * only, or just "subtitles": its burned-in text is the line itself) goes before every other shot
 * and no longer counts as a subtitles shot, but `hasSubs: true` says so on its line. Answers
 * {shots, hits (shots that say it)}.
 */
export function applySaid(shots, lines, said = "") {
  const clean = (shot) => (shot.flags ?? []).every((flag) => flag === "logo");
  const marked = shots.map((shot) => {
    const says = shotSays(shot, lines);
    const out = says ? { ...shot, says } : { ...shot };
    if (!said || !says) return out;
    const near = linesOverlapping(lines, shot.start, shot.end);
    if (!saidMatches(near.map((line) => line.text).join(" "), said)) return out;
    const subtitled = (shot.flags ?? []).includes("subtitles");
    return { ...out, said: true, flags: (shot.flags ?? []).filter((flag) => flag !== "subtitles"), ...(subtitled ? { hasSubs: true } : {}) };
  });
  const front = marked.filter((shot) => shot.said && clean(shot));
  return { shots: [...front, ...marked.filter((shot) => !(shot.said && clean(shot)))], hits: marked.filter((shot) => shot.said).length };
}

/**
 * The spoken lines of the scanned stretches with the shots each covers: [{start, end, text, hit,
 * shots: [n...] in time order}], in time order. Only lines that share time with a shot count. With
 * more than `most`, the lines that say `said` stay first, then the earliest.
 */
export function spokenLines(lines, shots, said = "", most = LINES_SHOWN) {
  const byTime = [...shots].sort((a, b) => a.start - b.start);
  const all = lines.map((line) => ({
    start: line.start, end: line.end, text: quoted(line.text), hit: Boolean(said) && saidMatches(line.text, said),
    shots: byTime.filter((shot) => linesOverlapping([line], shot.start, shot.end).length).map((shot) => shot.n),
  })).filter((line) => line.shots.length);
  if (all.length <= most) return all;
  const chosen = new Set([...all.filter((line) => line.hit), ...all.filter((line) => !line.hit)].slice(0, most));
  return all.filter((line) => chosen.has(line));
}

/** The "Lines" list: `Lines (en, auto captions):` and one `0:41 "..." (F1.12-F1.13)` a line. */
export function linesBlock(code, spoken, { lang, auto } = {}) {
  if (!spoken.length) return "";
  const head = `Lines (${[lang, auto ? "auto captions" : "captions"].filter(Boolean).join(", ")}):`;
  const rows = spoken.map((line) => {
    const first = line.shots[0];
    const last = line.shots.at(-1);
    const covered = first === last ? `${code}.${first}` : `${code}.${first}-${code}.${last}`;
    return `${clockOf(line.start)} "${line.text}" (${covered})${line.hit ? " says it" : ""}`;
  });
  return [head, ...rows].join("\n");
}

/** The import call's stretch for one line: its start and end, 0.3 s wider each side, 60 s at most. */
export function lineStretch(line, duration = null) {
  const from = Math.max(0, round1(line.start - 0.3));
  const to = Math.min(round1(line.end + 0.3), from + 60);
  return { from, to: duration ? Math.min(to, round1(duration)) : to };
}

/**
 * What a clip says, for the import answer: the lines inside [at, at + length) of the video as
 * [{text, from, to}] in the clip's own seconds. Empty for a clip under SAYS_MIN_SECONDS (not worth
 * a line) or with no line inside.
 */
export function saysOf(lines, at, length) {
  if (!(length >= SAYS_MIN_SECONDS)) return [];
  return linesOverlapping(lines, at, at + length).map((line) => ({
    text: quoted(line.text), from: round1(Math.max(0, line.start - at)), to: round1(Math.min(length, line.end - at)),
  }));
}

/** `says "I'll go." 0.3-2.1 s, "Now." 2.4-3.0 s` for saysOf's answer, or "". */
export function saysText(says = []) {
  if (!says.length) return "";
  return `says ${says.slice(0, 2).map((line) => `"${line.text}" ${line.from.toFixed(1)}-${line.to.toFixed(1)} s`).join(", ")}${says.length > 2 ? ", …" : ""}`;
}
