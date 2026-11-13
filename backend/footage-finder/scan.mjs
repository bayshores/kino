// The footage finder's scan, part 1: what to look at in a found video, and a small copy of it.
// 1. probeFootage: yt-dlp's description of the video (-j, nothing downloaded): its length, the
//    "most replayed" heatmap, its chapters, the tallest picture it offers, and whether it can play.
// 2. pickWindows (pure): the stretches worth scanning. The agent's from/to, when given, is the
//    only stretch (8 minutes at most). Otherwise a video of 8 minutes or less is scanned whole; a
//    longer one by its heatmap peaks (15 s either side) and the chapters whose names match the
//    agent's `want` words, 8 minutes in total. With no heatmap and no chapter to go by, 6 evenly
//    spaced 60 s stretches. whole:true scans all of a video up to 30 minutes long.
// 3. downloadScanCopy: those stretches at 360p (one file each) into a kino-footage- temp folder,
//    through the YouTube gate every download shares (process-slots.mjs). The caller measures them
//    and removes the folder (removeTempFolder).
import { readdir } from "node:fs/promises";
import path from "node:path";
import { jsRuntime, NO_JS_RUNTIME, runYtDlp, ytDlpCommand } from "../inspire.mjs";
import { peakParts } from "../measure/replay-graph.mjs";
import { botCheckError } from "../process-slots.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";

/** A video this long or shorter is scanned whole. */
export const WHOLE_SECONDS = 8 * 60;
/** The most a scan of a longer video looks at, in total. */
export const SCAN_BUDGET_SECONDS = 8 * 60;
/** The longest video whole:true scans (a 24 min episode fits; a 3 hour stream does not). */
export const WHOLE_MAX_SECONDS = 30 * 60;
/** Seconds kept on either side of a heatmap peak. */
export const PEAK_PAD_SECONDS = 15;
/** With nothing to go by: this many evenly spaced stretches of EVEN_SECONDS. */
export const EVEN_COUNT = 6;
export const EVEN_SECONDS = 60;
/** The analysis copy's picture size (the short side). */
export const SCAN_HEIGHT = 360;
// A stretch shorter than this is not worth a download of its own.
const MIN_WINDOW_SECONDS = 5;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
const round1 = (value) => Math.round(value * 10) / 10;

// yt-dlp's availability values for videos this visitor (no account, no cookies) cannot play.
const UNPLAYABLE = { subscriber_only: "members only", premium_only: "premium only", needs_auth: "age", private: "private" };

/**
 * The facts a scan needs from yt-dlp's -j description of one video: {id, title, duration,
 * heatmap: [{start, end, value}], chapters: [{start, end, title}], height (the tallest picture
 * offered, or null), cannotPlay (a reason, or null)}.
 */
export function parseProbe(text) {
  let entry;
  try { entry = JSON.parse(String(text ?? "").trim().split("\n").at(-1)); }
  catch { throw new Error("yt-dlp did not describe the video."); }
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const heatmap = (Array.isArray(entry.heatmap) ? entry.heatmap : [])
    .map((part) => ({ start: number(part.start_time), end: number(part.end_time), value: number(part.value) }))
    .filter((part) => part.start !== null && part.end > part.start && part.value !== null);
  const chapters = (Array.isArray(entry.chapters) ? entry.chapters : [])
    .map((part) => ({ start: number(part.start_time), end: number(part.end_time), title: String(part.title ?? "") }))
    .filter((part) => part.start !== null && part.end > part.start);
  const heights = (Array.isArray(entry.formats) ? entry.formats : [])
    .filter((format) => format.vcodec !== "none" && number(format.height))
    .map((format) => number(format.height));
  const live = entry.live_status === "is_live" || entry.live_status === "is_upcoming" || entry.is_live === true;
  return {
    id: String(entry.id ?? ""),
    title: String(entry.title ?? ""),
    duration: number(entry.duration),
    heatmap,
    chapters,
    height: heights.length ? Math.max(...heights) : null,
    cannotPlay: live ? "live" : UNPLAYABLE[entry.availability] ?? null,
  };
}

/** "3:17", "1:02:03", "197" or 197 → seconds; null when it is none of those. */
export function readTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parts = String(value).trim().split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

// 197 → "3:17", 10800 → "3:00:00".
function clock(value) {
  const total = Math.round(value);
  const pad = (part) => String(part).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

const given = (value) => value !== undefined && value !== null && value !== "";

// The stretch the agent asked for with from/to ({start, end}), or null when it gave neither. A
// missing end is filled in up to SCAN_BUDGET_SECONDS, and the stretch is cut to that length.
// A value that is no time, or lies outside the video, is an error the agent reads.
function askedStretch(duration, from, to) {
  if (!given(from) && !given(to)) return null;
  const read = (name, value) => {
    if (!given(value)) return null;
    const time = readTime(value);
    if (time === null || time < 0) throw new Error(`"${name}" (${value}) is not a time: use seconds (197) or minutes and seconds ("3:17").`);
    if (time > duration + 1) throw new Error(`"${name}" (${clock(time)}) is past the end of this video (${clock(duration)}).`);
    return Math.min(time, duration);
  };
  const askedFrom = read("from", from);
  const askedTo = read("to", to);
  const start = askedFrom ?? Math.max(0, askedTo - SCAN_BUDGET_SECONDS);
  const end = askedTo ?? Math.min(duration, start + SCAN_BUDGET_SECONDS);
  if (end <= start) throw new Error(`"to" (${clock(end)}) must come after "from" (${clock(start)}).`);
  return { start: round1(start), end: round1(Math.min(end, start + SCAN_BUDGET_SECONDS)) };
}

// The seconds a set of stretches covers, overlaps counted once.
function covered(windows) {
  let total = 0;
  let reach = -Infinity;
  for (const { start, end } of [...windows].sort((a, b) => a.start - b.start)) {
    const from = Math.max(start, reach);
    if (end > from) total += end - from;
    reach = Math.max(reach, end);
  }
  return total;
}

// Sorted, with touching or overlapping stretches joined.
function merged(windows) {
  const out = [];
  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else out.push({ ...window });
  }
  return out.map((window) => ({ start: round1(window.start), end: round1(window.end) }));
}

// The words of `want` that can name a chapter ("white hair, fight" → white, hair, fight).
const wantWords = (want) => String(want ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);

// Heatmap parts no lower than either neighbor and higher than one (a flat stretch has no peak),
// the most replayed first.
// (Shared with inspire's replay graph, backend/measure/replay-graph.mjs.)
const heatmapPeaks = peakParts;

/**
 * The stretches of a video to scan: [{start, end}] in seconds, sorted, not overlapping.
 * probe: parseProbe's answer; want: the agent's visual words; from/to: the one stretch the agent
 * asked for (seconds or "m:ss"), which limits the scan to it; whole: scan all of a video up to
 * WHOLE_MAX_SECONDS long.
 */
export function pickWindows(probe, { want, from, to, whole = false } = {}) {
  const duration = Number(probe?.duration);
  if (!(duration > 0)) throw new Error("This video has no length yet (a live stream or premiere), so kino cannot scan it.");
  const asked = askedStretch(duration, from, to);
  if (asked) return [asked];
  if (whole && duration > WHOLE_MAX_SECONDS) {
    throw new Error(`This video is ${clock(duration)} long and whole:true scans ${WHOLE_MAX_SECONDS / 60} min at most. Scan a stretch of it instead: from and to (${SCAN_BUDGET_SECONDS / 60} min at most).`);
  }
  if (whole || duration <= WHOLE_SECONDS) return [{ start: 0, end: round1(duration) }];
  const clamp = (window) => ({ start: Math.max(0, window.start), end: Math.min(duration, window.end) });
  const chosen = [];
  // Adds a stretch while the total stays within the budget; the one that overflows is shortened.
  const add = (window) => {
    let next = clamp(window);
    const over = covered([...chosen, next]) - SCAN_BUDGET_SECONDS;
    if (over > 0) next = { start: next.start, end: next.end - over };
    if (next.end - next.start < MIN_WINDOW_SECONDS || covered([...chosen, next]) > SCAN_BUDGET_SECONDS + 0.01) return;
    chosen.push(next);
  };
  const words = wantWords(want);
  for (const chapter of probe.chapters ?? []) {
    const title = chapter.title.toLowerCase();
    if (words.some((word) => title.includes(word))) add(chapter);
  }
  for (const peak of heatmapPeaks(probe.heatmap ?? [])) {
    const middle = (peak.start + peak.end) / 2;
    add({ start: middle - PEAK_PAD_SECONDS, end: middle + PEAK_PAD_SECONDS });
  }
  if (!chosen.length) {
    for (let index = 0; index < EVEN_COUNT; index += 1) {
      const middle = (duration * (index + 0.5)) / EVEN_COUNT;
      add({ start: middle - EVEN_SECONDS / 2, end: middle + EVEN_SECONDS / 2 });
    }
  }
  return merged(chosen);
}

/** The yt-dlp arguments that describe one video (nothing is downloaded). */
export function probeArgs(videoId, { runtime } = {}) {
  return [...(runtime ? ["--js-runtimes", `${runtime.name}:${runtime.path}`] : []), "--no-playlist", "--skip-download", "-j", watchUrl(videoId)];
}

/**
 * The yt-dlp arguments that download a 360p analysis copy of `windows` into `folder`, one file per
 * stretch named scan.<its start>.<ext>. Picture only: a scan measures shots, not sound.
 * (runYtDlp adds the private arguments: no config, no cookies, no cache.)
 */
export function analysisArgs(videoId, folder, windows, { ffmpeg, runtime } = {}) {
  return [
    ...(runtime ? ["--js-runtimes", `${runtime.name}:${runtime.path}`] : []),
    "--no-playlist", "--no-part", "--no-mtime", "--no-write-thumbnail", "--no-write-info-json",
    "-f", "bv*/b", "-S", `res:${SCAN_HEIGHT}`,
    ...windows.flatMap((window) => ["--download-sections", `*${round1(window.start)}-${round1(window.end)}`]),
    ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
    "-o", path.join(folder, "scan.%(section_start)s.%(ext)s"),
    watchUrl(videoId),
  ];
}

// The runtime yt-dlp answers YouTube's challenge with (inspire.mjs explains why kino names one).
function needRuntime(runtime) {
  if (!runtime) throw Object.assign(new Error(NO_JS_RUNTIME), { code: "NO_JS_RUNTIME" });
  return runtime;
}

/**
 * Reads one YouTube video's scan facts (parseProbe). options: run(args, {signal, timeoutMs})
 * (runYtDlp by default; tests pass a stub), command, runtime, signal.
 */
export async function probeFootage(videoId, { youtube, run, command, runtime = jsRuntime(), signal } = {}) {
  if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
  // The probe downloads nothing, so it skips the gate's slot and gap, but it shares its pause:
  // it waits out a bot check like any download, and its own bot check pauses the rest.
  if (youtube?.paused?.()) throw botCheckError();
  const runner = run ?? ((args, options) => runYtDlp(args, { ...options, command: command ?? ytDlpCommand() }));
  const args = probeArgs(videoId, { runtime: needRuntime(runtime) });
  let text;
  try { text = await runner(args, { signal, timeoutMs: 60_000 }); } catch (error) {
    if (error?.code === "BOT_CHECK") youtube?.noteBotCheck?.();
    throw error;
  }
  return parseProbe(text);
}

/**
 * Downloads the 360p analysis copy of `windows` through `youtube` (the shared gate; a direct call
 * when none is given) into a new kino-footage- folder. Resolves to {folder, files: [{start, end,
 * file}]}; on failure the folder is removed. The caller removes it once the scan is measured.
 */
export async function downloadScanCopy(videoId, windows, { youtube, run, command, runtime = jsRuntime(), ffmpeg, signal } = {}) {
  if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
  if (!windows?.length) throw new Error("A scan needs at least one stretch to download.");
  const runner = run ?? ((args, options) => runYtDlp(args, { ...options, command: command ?? ytDlpCommand() }));
  const gate = youtube ?? ((work) => work());
  if (youtube?.paused?.()) throw botCheckError();
  const folder = await makeTempFolder("kino-footage-");
  try {
    const args = analysisArgs(videoId, folder, windows, { ffmpeg, runtime: needRuntime(runtime) });
    // 10 min, or as long as the stretches play (a whole 30 min video) when that is longer.
    const timeoutMs = Math.max(600_000, Math.round(covered(windows) * 1000));
    await gate(() => runner(args, { signal, timeoutMs }), { signal });
    const names = (await readdir(folder)).filter((name) => name.startsWith("scan."));
    const files = [];
    for (const window of windows) {
      // yt-dlp writes the section start as it was asked ("95" or "95.0").
      const name = names.find((candidate) => {
        const match = /^scan\.(\d+(?:\.\d+)?)\.[a-z0-9]+$/i.exec(candidate);
        return match && Math.abs(Number(match[1]) - window.start) < 0.5;
      });
      if (name) files.push({ start: window.start, end: window.end, file: path.join(folder, name) });
    }
    if (!files.length) throw new Error("yt-dlp downloaded nothing to scan.");
    return { folder, files };
  } catch (error) {
    await removeTempFolder(folder);
    throw error;
  }
}
