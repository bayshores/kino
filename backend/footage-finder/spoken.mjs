// The footage finder's local ears: what is SAID in the scanned stretch of a video that has no
// captions. words.mjs reads YouTube's captions; when there are none and the agent asked for
// words (library footage said:"..."), this listens to the scanned stretch on this computer with
// kino's own speech code (speech/transcribe.mjs, called as it is) and answers lines in the same
// shape captions do, so applySaid ranks the shots that say them first.
// Bounded: only the stretches the scan already looked at, at most SPOKEN_MAX_SECONDS of them in
// one call, one audio-only download of those stretches, and every listened stretch is kept
// (<footage>/spoken/<video id>.json) so a second ask for it costs nothing.
// The English model reads other languages as sound-alike words, so index.mjs hears each stretch
// once more in its own language when the multilingual model file is already in ~/.kino/models
// (hearInOwnLanguage, the pass the clip readout uses; never fetched here). Without that file a
// stretch in another language gives no lines (clipLines wants two words and a sure reading).
import { readdir } from "node:fs/promises";
import path from "node:path";
import { clipLines } from "../../engine/speech.js";
import { jsRuntime, NO_JS_RUNTIME, runYtDlp, ytDlpCommand } from "../inspire.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";

/**
 * The most seconds of a video one call listens to. A guess, checked by the measurement in
 * .scratch/run8/wave/said-local/RESULT.md (seconds of listening per minute of speech): a 60 s
 * stretch is well inside it, and a scan waits about 50 s before it answers with progress.
 */
export const SPOKEN_MAX_SECONDS = 120;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const round1 = (value) => Math.round(value * 10) / 10;

/** The yt-dlp arguments for the sound alone of `windows`, one file each: said.<start>.<ext> in `folder`. */
export function spokenArgs(videoId, folder, windows, { ffmpeg, runtime } = {}) {
  return [
    ...(runtime ? ["--js-runtimes", `${runtime.name}:${runtime.path}`] : []),
    "--no-playlist", "--no-part", "--no-mtime", "--no-write-thumbnail", "--no-write-info-json",
    "-f", "wa/ba/b",
    ...windows.flatMap((window) => ["--download-sections", `*${round1(window.start)}-${round1(window.end)}`]),
    ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
    "-o", path.join(folder, "said.%(section_start)s.%(ext)s"),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

/** The windows to listen to, in order, whole ones only, up to `most` seconds in all: {listen, left} (left: seconds not listened to). */
export function spokenBudget(windows = [], most = SPOKEN_MAX_SECONDS) {
  const listen = [];
  let used = 0;
  let left = 0;
  for (const window of windows) {
    const length = Math.max(0, window.end - window.start);
    if (used + length <= most || !listen.length) { listen.push(window); used += length; } else left += length;
  }
  return { listen, left: Math.round(left) };
}

/**
 * A transcript's lines as captions give them: [{start, end, text}] in the video's seconds (offset:
 * where the stretch starts). A stretch heard in another language (hearInOwnLanguage) gives the
 * words as said, and `gloss`: whisper's English for the line, a machine guess the readout marks.
 */
export function spokenLines(transcript, offset = 0) {
  return clipLines(transcript, { most: Infinity })
    .map((line) => ({ start: round1(line.start + offset), end: round1(line.end + offset), text: line.text, ...(line.english ? { gloss: line.english } : {}) }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Listens to `windows` ([{start, end}] of the video, seconds) of one YouTube video. Answers {lang:
 * "en", auto: true, local: true, lines, listened: seconds, left: seconds not listened to}, or
 * {none: true, why} when it could not (no speech model, no yt-dlp, a download that failed). Never
 * throws except for a cancel. options: transcribe(file) → a speech transcript (required), kept
 * (stretches already listened to: [{start, end, lines}]), save(stretch) (called with each new one),
 * youtube (the shared gate), run(args, {signal, timeoutMs}) (runYtDlp by default; tests pass a
 * stub), command, runtime, ffmpeg, signal.
 */
export async function listenToVideo(videoId, windows, { transcribe, kept = [], save, youtube, run, command, runtime = jsRuntime(), ffmpeg, signal } = {}) {
  if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
  const { listen, left } = spokenBudget(windows);
  const have = (window) => kept.find((each) => Math.abs(each.start - window.start) < 0.5 && Math.abs(each.end - window.end) < 0.5);
  const missing = listen.filter((window) => !have(window));
  const done = listen.map(have).filter(Boolean);
  const listened = Math.round(listen.reduce((sum, window) => sum + window.end - window.start, 0));
  if (missing.length) {
    if (!runtime) return { none: true, why: NO_JS_RUNTIME };
    if (youtube?.paused?.()) return { none: true, why: "YouTube is paused after a bot check" };
    const runner = run ?? ((args, options) => runYtDlp(args, { ...options, command: command ?? ytDlpCommand() }));
    const gate = youtube ?? ((work) => work());
    const folder = await makeTempFolder("kino-footage-");
    try {
      try {
        await gate(() => runner(spokenArgs(videoId, folder, missing, { ffmpeg, runtime }), { signal, timeoutMs: 300_000 }), { signal });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        return { none: true, why: String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 120) };
      }
      const names = await readdir(folder);
      for (const window of missing) {
        const name = names.find((each) => {
          const match = /^said\.(\d+(?:\.\d+)?)\.[a-z0-9]+$/i.exec(each);
          return match && Math.abs(Number(match[1]) - window.start) < 0.5;
        });
        if (!name) continue;
        let transcript;
        try { transcript = await transcribe(path.join(folder, name)); } catch (error) {
          if (error?.name === "AbortError") throw error;
          // No speech model or no whisper: said once, with how to fix it (the error's own words).
          return { none: true, why: String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 160) };
        }
        const stretch = { start: window.start, end: window.end, lines: spokenLines(transcript, window.start), ...(transcript?.language && transcript.language !== "en" ? { language: transcript.language } : {}) };
        done.push(stretch);
        await save?.(stretch);
      }
    } finally {
      await removeTempFolder(folder);
    }
  }
  const lines = done.flatMap((stretch) => stretch.lines).sort((a, b) => a.start - b.start);
  // The language of the stretches heard in another one (the first), else English.
  const lang = done.find((stretch) => stretch.language)?.language ?? "en";
  return { lang, auto: true, local: true, lines, listened, left };
}
