// The footage finder's import: chosen shots of a scanned video become clips in the media library.
// 1. planTake (pure): what project {action:"import", file:"F1", options:{shots}} asks for, checked:
//    only a scanned candidate imports; shots by their scan numbers (F1.37), or one stretch
//    (from, to, 60 s at most); 5 min a call and 15 min a project at most.
// 2. joinStretches (pure): shots under 20 s apart share one stretch, padded 0.5 s, so one yt-dlp
//    call downloads every stretch once (takeArgs: 1080p at most, picture and sound).
// 3. takeFootage: the download into a kino-footage- temp folder through the shared YouTube gate
//    (a Commons clip is its 1080p copy, whole), then each shot cut locally, one at a time: the
//    exact first and last frame from FFmpeg's scene score within 0.5 s, re-encoded to H.264 (the
//    1080p copies are VP9). Each clip joins the media library with its credit and its F code.
import path from "node:path";
import { readdir } from "node:fs/promises";
import { call } from "../agent/next-call.mjs";
import { jsRuntime, NO_JS_RUNTIME, runYtDlp, ytDlpCommand } from "../inspire.mjs";
import { botCheckError, heavyDecodeSlot } from "../process-slots.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";
import { FootageError, stamp } from "./actions.mjs";
import { readTime } from "./scan.mjs";
import { scanCall } from "./step.mjs";

/** Seconds kept before and after each shot in its download. */
export const TAKE_PAD_SECONDS = 0.5;
/** Shots closer than this (end to start) share one downloaded stretch. */
export const TAKE_JOIN_SECONDS = 20;
/** The tallest picture an import downloads. */
export const TAKE_HEIGHT = 1080;
/** The longest stretch (from, to) one import takes. */
export const STRETCH_MOST_SECONDS = 60;
/** The most footage one import call takes, and one project in all. */
export const CALL_MOST_SECONDS = 5 * 60;
export const PROJECT_MOST_SECONDS = 15 * 60;
/** How far from a shot's scanned start or end the exact cut is looked for. */
export const EXACT_SECONDS = 0.5;
// A frame whose scene score is at least this starts a new shot.
const CUT_SCORE = 0.3;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const round2 = (value) => Math.round(value * 100) / 100;
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const short = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const given = (value) => value !== undefined && value !== null && value !== "";
const clockOf = (seconds) => stamp(seconds).replace(/\.\d$/, "");

/** The shot number a file ref names ("F1.37" → 37), or null. */
export function refShot(ref) {
  const match = /^f\d{1,3}\.(\d+)$/i.exec(oneLine(ref));
  return match ? Number(match[1]) : null;
}

// options.shots as numbers: 37, "37" and "F1.37" all name shot 37.
function shotNumbers(list) {
  return (Array.isArray(list) ? list : [list]).map((entry) => {
    const text = oneLine(entry);
    const match = /^(?:f\d{1,3}\.)?(\d+)$/i.exec(text);
    return match ? Number(match[1]) : NaN;
  });
}

/** Footage seconds a project has imported so far (each candidate's imported.seconds). */
export function importedSeconds(footage) {
  return (footage?.candidates ?? []).reduce((sum, entry) => sum + (Number(entry.imported?.seconds) || 0), 0);
}

/**
 * What one import takes: [{n (shot number, or null for a stretch), start, end, exact}] in the
 * video's seconds; exact pieces are snapped to the real cut. candidate: the project's footage
 * entry; scan: its saved scan (or null); asked: {file, shots, from, to}; used: seconds the project
 * imported before. A refusal is a FootageError the agent reads, with the call that fixes it.
 */
export function planTake(candidate, scan, { file, shots, from, to, used = 0 } = {}) {
  const { code } = candidate;
  const duration = Number(candidate.seconds) > 0 ? Number(candidate.seconds) : null;
  const scanned = Boolean(scan);
  const fromFile = refShot(file);
  const numbers = [...(fromFile !== null ? [fromFile] : []), ...(given(shots) ? shotNumbers(shots) : [])];
  const stretch = given(from) || given(to);
  if (!numbers.length && !stretch) {
    // A whole clip only when it is short and scanned; else shots or a stretch.
    if (scanned && duration && duration <= STRETCH_MOST_SECONDS) return [{ n: null, start: 0, end: duration, exact: false }];
    throw new FootageError("bad_input", `${code} is ${duration ? `${clockOf(duration)} long` : "a whole video"}: import shots (${code}.${scan?.shots?.[0]?.n ?? 37}) or a stretch (from, to, ${STRETCH_MOST_SECONDS} s at most).${scanned ? "" : " Scan it first."}`,
      scanCall(code));
  }
  if (!scanned) throw new FootageError("not_ready", `${code} is not scanned yet: only scanned footage imports. The scan names its shots.`, scanCall(code));
  let pieces;
  if (numbers.length) {
    if (stretch) throw new FootageError("bad_input", "Import shots or a stretch (from, to), not both.", scanCall(code));
    const byNumber = new Map((scan.shots ?? []).map((shot) => [shot.n, shot]));
    const missing = [...new Set(numbers)].filter((n) => !byNumber.has(n));
    if (missing.length) {
      throw new FootageError("not_found", `${missing.slice(0, 5).map((n) => (Number.isFinite(n) ? `${code}.${n}` : "a shot that is no number")).join(", ")} ${missing.length === 1 ? "is" : "are"} not in ${code}'s scan: its shots are numbered 1 to ${Math.max(0, ...byNumber.keys())}.`,
        call("look", { mode: "source", ref: code }));
    }
    pieces = [...new Set(numbers)].map((n) => byNumber.get(n)).sort((a, b) => a.start - b.start)
      .map((shot) => ({ n: shot.n, start: shot.start, end: shot.end, exact: true }));
  } else {
    const read = (name, value) => {
      if (!given(value)) return null;
      const time = readTime(value);
      if (time === null || time < 0) throw new FootageError("bad_input", `"${name}" (${short(oneLine(value), 20)}) is not a time: use seconds (197) or minutes and seconds ("3:17").`, scanCall(code));
      return time;
    };
    const start = read("from", from) ?? Math.max(0, read("to", to) - STRETCH_MOST_SECONDS);
    let end = read("to", to) ?? start + STRETCH_MOST_SECONDS;
    if (duration) end = Math.min(end, duration);
    if (end <= start) throw new FootageError("bad_input", `"to" must come after "from"${duration ? ` and before the end (${clockOf(duration)})` : ""}.`, scanCall(code));
    if (end - start > STRETCH_MOST_SECONDS + 0.05) throw new FootageError("bad_input", `A stretch is ${STRETCH_MOST_SECONDS} s at most; ${stamp(start)} to ${stamp(end)} is ${Math.round(end - start)} s. Import its best shots instead.`, scanCall(code));
    pieces = [{ n: null, start: round2(start), end: round2(end), exact: false }];
  }
  const seconds = pieces.reduce((sum, piece) => sum + piece.end - piece.start, 0);
  if (seconds > CALL_MOST_SECONDS) throw new FootageError("bad_input", `That is ${clockOf(seconds)} of footage; one import takes ${CALL_MOST_SECONDS / 60} min at most. Import fewer shots.`, scanCall(code));
  if (used + seconds > PROJECT_MOST_SECONDS) {
    throw new FootageError("limit", `This video has ${clockOf(used)} of found footage; ${PROJECT_MOST_SECONDS / 60} min is the most a project takes. Import ${used >= PROJECT_MOST_SECONDS ? "no more" : `at most ${clockOf(PROJECT_MOST_SECONDS - used)} more`}.`, null);
  }
  return pieces;
}

/**
 * Pieces sorted by start as downloaded stretches: [{start, end, pieces}]. A piece joins the stretch
 * before it when it starts less than `join` s after that stretch's last piece ends; each stretch
 * is padded by `pad` on both sides, within 0 and `duration` (when known).
 */
export function joinStretches(pieces, { duration = null, pad = TAKE_PAD_SECONDS, join = TAKE_JOIN_SECONDS } = {}) {
  const stretches = [];
  for (const piece of [...pieces].sort((a, b) => a.start - b.start)) {
    const last = stretches.at(-1);
    if (last && piece.start - last.reach < join) {
      last.pieces.push(piece);
      last.reach = Math.max(last.reach, piece.end);
    } else stretches.push({ pieces: [piece], from: piece.start, reach: piece.end });
  }
  return stretches.map(({ pieces: list, from, reach }) => ({
    start: round2(Math.max(0, from - pad)),
    end: round2(duration ? Math.min(duration, reach + pad) : reach + pad),
    pieces: list,
  }));
}

/**
 * The yt-dlp arguments that download `stretches` of one video at 1080p at most (picture and sound)
 * into `folder`, one file per stretch named take.<its start>.<ext>. runYtDlp adds the private
 * arguments (no config, no cookies, no cache).
 */
export function takeArgs(videoId, folder, stretches, { ffmpeg, runtime } = {}) {
  return [
    ...(runtime ? ["--js-runtimes", `${runtime.name}:${runtime.path}`] : []),
    "--no-playlist", "--no-part", "--no-mtime", "--no-write-thumbnail", "--no-write-info-json",
    "-f", `bv*[height<=${TAKE_HEIGHT}]+ba/b[height<=${TAKE_HEIGHT}]`, "-S", `res:${TAKE_HEIGHT}`,
    ...stretches.flatMap((stretch) => ["--download-sections", `*${stretch.start}-${stretch.end}`]),
    ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
    "-o", path.join(folder, "take.%(section_start)s.%(ext)s"),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

/** The credit a found clip keeps: "license unknown" for YouTube, Commons' own license and line. */
export function takeCredit(candidate) {
  const title = oneLine(candidate.title) || candidate.id;
  const creator = oneLine(candidate.creator) || "unknown";
  if (candidate.source === "commons") {
    return { source: "commons", id: candidate.id, title, creator, page: candidate.page ?? null, license: candidate.license, licenseUrl: candidate.licenseUrl ?? null,
      line: candidate.credit ?? `"${title}" by ${creator}, ${candidate.license}`, file: "H.264 cut from Wikimedia Commons" };
  }
  return { source: "youtube", id: candidate.id, title, creator, page: candidate.page ?? null, license: "unknown",
    line: `"${title}" by ${creator} (${candidate.page ?? "YouTube"})`, file: "H.264 cut from YouTube" };
}

// ---- FFmpeg (the default tools; tests pass their own) ----------------------------------------

// Scene scores of the frames in [from, from + seconds) of a file: [{t, score}], t in file seconds.
async function sceneScores(file, from, seconds, { signal } = {}) {
  const { runMediaTool } = await import("../media-probe.mjs");
  const out = await heavyDecodeSlot(() => runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-ss", String(round2(from)), "-t", String(round2(seconds)),
    "-i", file, "-an", "-sn", "-dn", "-vf", "select='gte(scene,0)',metadata=print:file=-", "-f", "null", "-"], { signal }));
  const frames = [];
  let time = null;
  for (const line of String(out).split("\n")) {
    const pts = /pts_time:(-?[\d.]+)/.exec(line);
    if (pts) { time = Number(pts[1]); continue; }
    const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score && time !== null) frames.push({ t: round2(from + time), score: Number(score[1]) });
  }
  return frames;
}

// One clip: [start, start + seconds) of a file as H.264 (sound as AAC), 1080 tall at most.
async function encodeClip(file, out, { start, seconds, signal } = {}) {
  const { runMediaTool } = await import("../media-probe.mjs");
  await heavyDecodeSlot(() => runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", String(round2(start)), "-i", file, "-t", String(round2(seconds)),
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", `scale=-2:'min(ih,${TAKE_HEIGHT})'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", out], { signal }));
  return out;
}

async function defaultTools() {
  const { probeMedia } = await import("../media-probe.mjs");
  return { probe: probeMedia, sceneScores, encode: encodeClip };
}

// The exact cut near `time` (file seconds): the frame with the highest scene score within
// EXACT_SECONDS, when it scores as a cut; else `time` itself.
async function exactCut(use, file, time, { signal } = {}) {
  const from = Math.max(0, time - EXACT_SECONDS);
  const frames = await use.sceneScores(file, from, time + EXACT_SECONDS - from, { signal }).catch(() => []);
  const best = frames.filter((frame) => frame.t > from + 0.01).reduce((top, frame) => (!top || frame.score > top.score ? frame : top), null);
  return best && best.score >= CUT_SCORE ? best.t : time;
}

function needRuntime(runtime) {
  if (!runtime) throw Object.assign(new Error(NO_JS_RUNTIME), { code: "NO_JS_RUNTIME" });
  return runtime;
}

/**
 * Downloads and cuts `pieces` (planTake) of `candidate`, then adds each clip to the media library
 * with addMedia(file, {name, mime, extra}). options: projectId (the clips belong to it), youtube
 * (the shared gate), commons (licensed.mjs; for a Commons clip), run/command/runtime (yt-dlp;
 * tests pass a stub), tools ({probe, sceneScores, encode}; tests), signal.
 * Answers {media: [record], failed: [{n, why}]}; the temp folder is removed whatever happens.
 */
export async function takeFootage(candidate, pieces, { addMedia, projectId = null, youtube, commons, run, command, runtime = jsRuntime(), ffmpeg, tools, signal } = {}) {
  if (!addMedia) throw new Error("The footage finder cannot add clips here.");
  const use = tools ?? await defaultTools();
  const folder = await makeTempFolder("kino-footage-");
  try {
    let stretches;
    if (candidate.source === "commons") {
      if (!commons) throw new Error("Commons is not available here.");
      const file = await commons.download(candidate, folder, { use: "import", signal });
      stretches = [{ start: 0, end: Number(candidate.seconds) || 0, pieces, file }];
    } else {
      if (!VIDEO_ID.test(String(candidate.videoId ?? ""))) throw new Error(`"${candidate.videoId}" is not a YouTube video id.`);
      if (youtube?.paused?.()) throw botCheckError();
      stretches = joinStretches(pieces, { duration: Number(candidate.seconds) > 0 ? Number(candidate.seconds) : null });
      const runner = run ?? ((args, options) => runYtDlp(args, { ...options, command: command ?? ytDlpCommand() }));
      const args = takeArgs(candidate.videoId, folder, stretches, { ffmpeg, runtime: needRuntime(runtime) });
      const gate = youtube ?? ((work) => work());
      const timeoutMs = Math.max(600_000, Math.round(stretches.reduce((sum, each) => sum + each.end - each.start, 0) * 4000));
      await gate(() => runner(args, { signal, timeoutMs }), { signal });
      const names = (await readdir(folder)).filter((name) => name.startsWith("take."));
      for (const stretch of stretches) {
        // yt-dlp writes the section start as it was asked ("95" or "95.0").
        const name = names.find((each) => {
          const match = /^take\.(\d+(?:\.\d+)?)\.[a-z0-9]+$/i.exec(each);
          return match && Math.abs(Number(match[1]) - stretch.start) < 0.5;
        });
        stretch.file = name ? path.join(folder, name) : null;
      }
    }
    const credit = takeCredit(candidate);
    const title = short(oneLine(candidate.title) || candidate.id, 60);
    const media = [];
    const failed = [];
    for (const stretch of stretches) {
      if (!stretch.file) { for (const piece of stretch.pieces) failed.push({ n: piece.n, why: "yt-dlp downloaded nothing for it" }); continue; }
      // The file starts at the keyframe before the stretch: its lead-in comes first.
      const facts = await use.probe(stretch.file, { signal }).catch(() => ({}));
      const span = stretch.end - stretch.start;
      const lead = facts.duration > span ? facts.duration - span : 0;
      const local = (time) => Math.max(0, time - stretch.start + lead);
      for (const [index, piece] of stretch.pieces.entries()) {
        if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
        const label = piece.n === null ? `${candidate.code} ${stamp(piece.start)}-${stamp(piece.end)}` : `${candidate.code}.${piece.n}`;
        try {
          const start = piece.exact ? await exactCut(use, stretch.file, local(piece.start), { signal }) : local(piece.start);
          const end = piece.exact ? await exactCut(use, stretch.file, local(piece.end), { signal }) : local(piece.end);
          const seconds = end - start > 0.2 ? end - start : piece.end - piece.start;
          const out = path.join(folder, `clip-${media.length + failed.length}-${index}.mp4`);
          await use.encode(stretch.file, out, { start, seconds, signal });
          media.push(await addMedia(out, { name: `${label} ${title}.mp4`.slice(0, 200), mime: "video/mp4",
            extra: { ...(projectId ? { projectId } : {}), credit, footage: { candidate: candidate.id, code: candidate.code, shot: piece.n, start: piece.start, end: piece.end } } }));
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          failed.push({ n: piece.n, label, why: short(oneLine(error?.message ?? error), 160) });
        }
      }
    }
    return { media, failed };
  } finally {
    await removeTempFolder(folder);
  }
}

/**
 * The import answer's lines: each clip by its code and file, the credit, and the license line.
 * code: F1; candidate: its footage entry; result: takeFootage's answer.
 */
export function takeText(candidate, { media, failed }) {
  const total = media.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  const lines = [`Imported ${media.length} clip${media.length === 1 ? "" : "s"} of ${candidate.code} "${short(oneLine(candidate.title) || candidate.id, 60)}" (${round2(total)} s in all, H.264) for this video:`];
  for (const item of media) {
    const label = item.footage?.shot === null || item.footage?.shot === undefined ? `${candidate.code} ${stamp(item.footage?.start)}` : `${candidate.code}.${item.footage.shot}`;
    lines.push(`${label} ${round2(Number(item.duration) || 0)}s ${item.width}×${item.height} ${item.src}`);
  }
  if (failed.length) lines.push(`Not imported: ${failed.slice(0, 5).map((each) => `${each.label ?? each.n} (${each.why})`).join("; ")}.`);
  const [first] = media;
  if (first) {
    lines.push(`Add one: edit {ops:[{op:"add_layer", layerType:"video", name, properties:{src:"${first.src}", x:0, y:0, width:${first.width}, height:${first.height}, mediaSourceDuration:${round2(Number(first.duration) || 0)}}}]}, or compose {footage} cuts them all by name.`);
  }
  const credit = media[0]?.credit ?? takeCredit(candidate);
  lines.push(`credit kept with each file: ${credit.line}. Put it in the end credits.`);
  if (credit.license === "unknown") lines.push("License unknown: fine for a private video; the person checks the rights before publishing.");
  return lines.join("\n");
}
