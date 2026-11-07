// Finds the shots in a video file: the places where one picture cuts to the next (plan fix 12).
// kino needs them so a look sheet gives every shot its tiles and the agent can crop footage shot
// by shot.
//
// One FFmpeg run per file. FFmpeg's scdet filter scores each frame against the one before and
// prints every score; the same run writes a 32×18 gray copy of every frame to standard output.
// With those small copies kino finds the hard cuts scdet scores low (between two dark shots, or
// into fast action) and the end of a dip to black, tells a short flash (a white frame, a lightning
// strike that fades: the same picture before and after) from a real cut or a short cutaway, and
// drops shots too short to be one. Lengths are in the file's usual frames (its median frame
// time), so a picture a variable-frame-rate file holds as one long frame counts for as long as it
// shows. Gradual dissolves are not found.
// The Mac app ships an FFmpeg 9 with scdet and signalstats; another FFmpeg may lack them or be
// older than 5.1 (no -fps_mode, which every video frame kino draws uses), and then video import is
// refused with a message that says what to install (shotFilters).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseMediaSource } from "../engine/mediaSource.js";
import { sec } from "./agent/describe.mjs";
import { ffmpegArgs, lowerIfBackground } from "./render-activity.mjs";
import { round as round3 } from "../engine/numbers.js";

// FFmpeg's helpers (media-probe.mjs), loaded the first time FFmpeg runs. They load the canvas
// library, and the kino command and the MCP client import this file only for shotsLine.
const mediaProbe = () => import("./media-probe.mjs");

// scdet's score runs 0–100. A frame that scores SCDET_THRESHOLD or more starts a new picture.
export const SCDET_THRESHOLD = 10;
// A frame that scores LOW_SCORE or more does too when its jump from the frame before is at least
// SPIKE times the change on either side of it: the Sintel trailer's cut between two dark shots
// scores 3.9 (jump 10.7, at most 0.5 around it) and its cut into a sword fight 6.6 (36.8 against
// 15.9 before and 9.7 after), while a wing sweeping across a shot scores 3.5 (38.7 against 27.5
// and 29.1).
export const LOW_SCORE = 3;
export const SPIKE = 2;
// A frame at most this bright (mean gray, 0–255) is black. A picture after two black frames starts
// a new shot (a fade through black), unless the black opens the file; after one black frame, only
// when the pictures either side of it differ (ALIKE).
export const DARK = 4;
// Frames are scaled down to this width before scdet scores them: fast, and enough to see a cut.
export const ANALYSIS_WIDTH = 320;
const THUMBNAIL_WIDTH = 32;
const THUMBNAIL_HEIGHT = 18;
const THUMBNAIL_BYTES = THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT;
// A cut followed within this many frames by the same picture as before it is a flash.
export const FLASH_FRAMES = 15;
// "The same picture": the frames on both sides of a flash differ by less than half the jump into
// it, and by at most SAME_MOTION times what the shot itself changes over as many frames, plus
// SAME_SLACK (of 255) for noise.
const SAME_MOTION = 2;
const SAME_SLACK = 3;
// The shortest shot kept. Shorter stretches join a neighbor. Six frames, not PySceneDetect's 15
// (an idea only), because the flash rule above already handles flashes up to 15 frames and a real
// half-second shot keeps its tile. A stretch of this many frames or more between the same picture
// is a flash only when every frame of it looks like one (flat, or ALIKE the picture either side):
// otherwise it is a cutaway (A, then B, then A again), three shots.
export const MIN_SHOT_FRAMES = 6;
// A frame is flat (white, black, one color) when its 32×18 gray copy spreads at most FLAT (its
// standard deviation, of 255).
const FLAT = 8;
// Two frames show the same picture, maybe brighter or darker (a flash over it, a fade), when their
// gray copies correlate at least ALIKE (−1 to 1). Sintel's city and its flying dragon: 0.46; the
// flying dragon 4 frames apart: 0.8.
const ALIKE = 0.6;
// Lengths in frames are compared with this much slack for timestamps that are not exact.
const EPSILON = 0.01;
// The longest video kino looks for shots in: the run keeps every frame's gray copy (576 bytes) and
// an upload waits for it. A longer one is imported with "shots: not found (too long …)".
export const MAX_VIDEO_SECONDS = 20 * 60;
export const MAX_VIDEO_FRAMES = 72_000;
const TOO_LONG = "too long to look for shots in";
// Saved with the shots (shotsFound.version), so a better finder can tell old results apart.
export const SHOTS_VERSION = 1;
// What kino keeps of FFmpeg's messages for an error: the end, where FFmpeg says what went wrong.
const MAX_ERROR_LENGTH = 4000;
// Each frame as the metadata filter prints it: "frame:30   pts:15360   pts_time:1.25", then
// "lavfi.scd.score=12.3".
const FRAME_LINE = /frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)/;
const SCORE_LINE = /lavfi\.scd\.score=([\d.]+)/;

const isVideo = (record) => String(record?.mime ?? record?.type ?? "").startsWith("video/");

function abortError(signal) {
  const error = new Error("Finding the shots was cancelled.", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}

// Waits for a run that other callers share. The caller's signal stops only its own wait.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The first line of an error, at most 200 characters, as a media record keeps it (shotsError). */
export function firstErrorLine(error) {
  return String(error?.message ?? error).split("\n")[0].slice(0, 200);
}

/**
 * The frames where a new picture starts, sorted. `scores[i]` is scdet's score for frame i, `mad(i, j)`
 * how much frames i and j differ (0–255) and `brightness[i]` frame i's mean gray (0–255). `at(i)` is
 * where frame i starts, in the file's usual frames; `flat(i)` and `alike(i, j)` are FLAT and ALIKE.
 *   1. scdet's score is SCDET_THRESHOLD or more.
 *   2. Its score is LOW_SCORE or more and its jump is at least SPIKE times the change on either side.
 *   3. It ends a dip to black (DARK) that does not open the file: two frames of black or more, or
 *      one between two different pictures (the nearest frames that are not flat are not alike).
 */
export function cutsFromScores(scores, frames, mad, brightness, { at = (frame) => frame, flat = () => false, alike = () => true } = {}) {
  const cuts = [];
  const dark = (frame) => brightness[frame] <= DARK;
  // The nearest frame from `frame` on (step 1) or back (step −1) that is not flat, or -1.
  const shown = (frame, step) => {
    for (let near = frame; near >= 0 && near < frames && Math.abs(at(near) - at(frame)) < FLASH_FRAMES; near += step) if (!flat(near)) return near;
    return -1;
  };
  const differ = (before, after) => {
    const [first, second] = [shown(before, -1), shown(after, 1)];
    return first >= 0 && second >= 0 && !alike(first, second);
  };
  let blackFrom = -1; // the first frame of the black stretch before this frame
  for (let frame = 1; frame < frames; frame += 1) {
    if (!dark(frame - 1)) blackFrom = -1;
    else if (blackFrom < 0) blackFrom = frame - 1;
    const score = scores[frame] ?? 0;
    const jump = mad(frame - 1, frame);
    const around = Math.max(frame > 1 ? mad(frame - 2, frame - 1) : 0, frame + 1 < frames ? mad(frame, frame + 1) : 0, 0.5);
    if (score >= SCDET_THRESHOLD || (score >= LOW_SCORE && jump >= SPIKE * around)) cuts.push(frame);
    else if (!dark(frame) && blackFrom > 0 && (at(frame) - at(blackFrom) >= 2 - EPSILON || differ(blackFrom - 1, frame))) cuts.push(frame);
  }
  return cuts;
}

/**
 * Turns the cuts into shots. `cuts` are the sorted frame numbers where a new picture starts,
 * `frames` is how many frames the file has, and `mad(i, j)` is how much frames i and j differ
 * (0–255). `at(i)` is where frame i starts in the file's usual frames (`at(frames)` where the file
 * ends), and `flashLike(i, before, after)` says frame i looks like part of a flash between frames
 * `before` and `after` (flat, or alike either). Returns { starts, flashes }: the first frame of
 * each shot (the first is 0) and how many flashes were left inside a shot.
 *   1. Flash: a cut c and the first frame e less than FLASH_FRAMES frames on that shows the picture
 *      before c again (see flashEnd) make c … e one flash: no cut from c to e counts. A flash that
 *      fades out, or a lightning strike, has no hard cut back. When c … e is MIN_SHOT_FRAMES or
 *      longer, every frame of it must look like a flash; else it is a cutaway and its cuts stay.
 *   2. Sliver: a cut less than MIN_SHOT_FRAMES after the shot's start is dropped (the shot runs on).
 *   3. End: a last shot shorter than MIN_SHOT_FRAMES joins the one before.
 */
export function shotsFromCuts(cuts, frames, mad, { at = (frame) => frame, flashLike = () => false } = {}) {
  const kept = [];
  let flashes = 0;
  for (let index = 0; index < cuts.length; index += 1) {
    const cut = cuts[index];
    const back = flashEnd(cut, frames, mad, at, flashLike);
    if (back < 0) {
      kept.push(cut);
      continue;
    }
    flashes += 1;
    while (index + 1 < cuts.length && cuts[index + 1] <= back) index += 1; // every cut from c to e belongs to the flash
  }
  const long = (from, to) => at(to) - at(from) >= MIN_SHOT_FRAMES - EPSILON;
  const starts = [0];
  for (const cut of kept) if (long(starts.at(-1), cut)) starts.push(cut);
  if (starts.length > 1 && !long(starts.at(-1), frames)) starts.pop();
  return { starts, flashes };
}

// The first frame after `cut` (within FLASH_FRAMES) that shows the picture from before it, or -1.
// The same picture: closer to frame cut − 1 than half the jump at the cut, and within SAME_MOTION
// times what the shot changes over as many frames just before the flash and just after it (the
// smaller, as the other may cross another cut), so a white flash over a real cut (two different
// shots, both far from white) stays a cut. A stretch as long as a shot must look like a flash too.
function flashEnd(cut, frames, mad, at, flashLike) {
  if (cut < 1) return -1;
  const before = cut - 1;
  const jump = mad(before, cut);
  for (let frame = cut + 1; frame < frames && at(frame) - at(cut) < FLASH_FRAMES - EPSILON; frame += 1) {
    const apart = mad(before, frame);
    if (2 * apart >= jump) continue;
    const span = frame - before;
    const motion = Math.min(mad(Math.max(0, before - span), before), mad(frame, Math.min(frames - 1, frame + span)));
    if (apart > SAME_MOTION * motion + SAME_SLACK) continue;
    if (at(frame) - at(cut) < MIN_SHOT_FRAMES - EPSILON) return frame;
    for (let inside = cut; inside < frame; inside += 1) if (!flashLike(inside, before, frame)) return -1;
    return frame;
  }
  return -1;
}

// The mean absolute difference of two 32×18 gray frames, 0 (the same) to 255.
function meanDifference(thumbnails, first, second) {
  const a = first * THUMBNAIL_BYTES;
  const b = second * THUMBNAIL_BYTES;
  let total = 0;
  for (let offset = 0; offset < THUMBNAIL_BYTES; offset += 1) total += Math.abs(thumbnails[a + offset] - thumbnails[b + offset]);
  return total / THUMBNAIL_BYTES;
}

// The mean gray of each 32×18 frame, 0–255, and how far its pixels spread from it (standard deviation).
function frameStats(thumbnails, frames) {
  const brightness = new Float64Array(frames);
  const spread = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0, squares = 0;
    for (let offset = frame * THUMBNAIL_BYTES; offset < (frame + 1) * THUMBNAIL_BYTES; offset += 1) {
      total += thumbnails[offset];
      squares += thumbnails[offset] * thumbnails[offset];
    }
    brightness[frame] = total / THUMBNAIL_BYTES;
    spread[frame] = Math.sqrt(Math.max(0, squares / THUMBNAIL_BYTES - brightness[frame] ** 2));
  }
  return { brightness, spread };
}

// How alike two 32×18 gray frames are, −1 to 1 (their correlation): 1 for the same picture, even
// one made brighter or darker; 0 when either is flat.
function correlation(thumbnails, stats, first, second) {
  const a = first * THUMBNAIL_BYTES;
  const b = second * THUMBNAIL_BYTES;
  const spread = stats.spread[first] * stats.spread[second];
  if (!(spread > 0)) return 0;
  let total = 0;
  for (let offset = 0; offset < THUMBNAIL_BYTES; offset += 1) total += thumbnails[a + offset] * thumbnails[b + offset];
  return (total / THUMBNAIL_BYTES - stats.brightness[first] * stats.brightness[second]) / spread;
}

// Where each frame starts, in the file's usual frames (its median frame time), and where the
// file ends (one more entry): a frame without a time is one usual frame after the one before.
function frameClock(times, frames, duration) {
  const steps = [];
  for (let frame = 1; frame < frames; frame += 1) {
    const step = times[frame] - times[frame - 1];
    if (step > 0) steps.push(step);
  }
  steps.sort((a, b) => a - b);
  const usual = steps[Math.floor(steps.length / 2)];
  const clock = new Float64Array(frames + 1);
  for (let frame = 1; frame < frames; frame += 1) {
    const step = times[frame] - times[frame - 1];
    clock[frame] = clock[frame - 1] + (usual > 0 && step > 0 ? step / usual : 1);
  }
  const end = usual > 0 && duration > 0 && Number.isFinite(times[0]) ? (duration - times[0]) / usual : 0;
  clock[frames] = Math.max(clock[frames - 1] + 1, end);
  return clock;
}

// One FFmpeg run: each frame's time in the file and scdet score, and its gray copy.
// -fps_mode passthrough keeps each decoded frame once, so the frames on standard output are the
// frames scdet scored, in the same order. They are counted in order, not by the number the
// metadata filter prints: that starts again from 0 when the picture size changes (FFmpeg then
// rebuilds the filters), as in a WebM recording that changes size partway.
// More than `maxFrames` frames stop the run with a "too long" error.
function analyse(command, file, signal, maxFrames) {
  const args = [
    "-hide_banner", "-nostdin", "-nostats", "-v", "info",
    "-i", file, "-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode", "passthrough",
    "-vf", `scale=${ANALYSIS_WIDTH}:-2,scdet=threshold=${SCDET_THRESHOLD},metadata=mode=print:key=lavfi.scd.score,` +
      `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:flags=area,format=gray`,
    "-f", "rawvideo", "pipe:1",
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(abortError(signal));
      return;
    }
    const child = spawn(command, ffmpegArgs(args), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    lowerIfBackground(child);
    // Every frame's gray copy is kept (MAX_VIDEO_FRAMES of them are 41 MB): a file's frame count,
    // not its size in bytes, sets this, as a long, small file compresses well.
    const chunks = [];
    let received = 0;
    let tooLong = false;
    const times = [];
    const scores = [];
    let current = -1;
    let partLine = "";
    let errorText = "";
    let killTimer;
    const readLine = (line) => {
      const frame = FRAME_LINE.exec(line);
      const score = frame ? null : SCORE_LINE.exec(line);
      if (frame) {
        current += 1;
        times[current] = Number(frame[2]);
      } else if (score) {
        if (current >= 0) scores[current] = Number(score[1]);
      } else if (line.trim()) errorText = `${errorText}${line}\n`.slice(-MAX_ERROR_LENGTH);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      if (tooLong) return;
      received += chunk.length;
      if (received > maxFrames * THUMBNAIL_BYTES) {
        tooLong = true;
        onAbort();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      const lines = `${partLine}${text}`.split(/\r?\n/);
      partLine = lines.pop();
      for (const line of lines) readLine(line);
    });
    const cleanUp = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanUp();
      rejectPromise(error);
    });
    child.once("close", (code, terminatingSignal) => {
      cleanUp();
      readLine(partLine);
      if (signal?.aborted) rejectPromise(abortError(signal));
      else if (tooLong) rejectPromise(tooLongError(`it has more than ${maxFrames} frames`));
      else if (code === 0) resolvePromise({ times, scores, thumbnails: Buffer.concat(chunks) });
      else {
        // FFmpeg's last lines say what went wrong; the file's folder is left out of them.
        const lines = errorText.split(file).join(basename(file)).trim().split("\n");
        const last = lines.at(-1) || `${basename(command)} failed with exit code ${code ?? terminatingSignal}`;
        rejectPromise(new Error(last, { cause: lines.join("\n") }));
      }
    });
  });
}

// The error for a video too long to look for shots in; its message is the reason the record keeps.
function tooLongError(why) {
  const error = new Error(`${TOO_LONG}: ${why}; kino looks in videos up to ${MAX_VIDEO_SECONDS / 60} min and ${MAX_VIDEO_FRAMES} frames`);
  error.code = "TOO_LONG";
  return error;
}

/** Why a video's shots are not known, from the first line of the error its record keeps. */
export function shotsErrorReason(line) {
  return line.startsWith(TOO_LONG) ? line : `FFmpeg could not read its frames: ${line}`;
}

/**
 * Finds the shots in a video file. `duration` (seconds, from the media record) ends the last shot.
 * Resolves with { shots: [{start, end}], found: {version, frames, cuts, flashes, ms} }: times in
 * file seconds with 3 decimals, `cuts` = shots − 1, `ms` how long it took. A video longer than
 * MAX_VIDEO_SECONDS, or with more than `maxFrames` frames, fails with a "too long" error.
 */
export async function findShots(file, { duration, signal, maxFrames = MAX_VIDEO_FRAMES } = {}) {
  const started = performance.now();
  if (duration > MAX_VIDEO_SECONDS) throw tooLongError(`it is ${Math.round(duration / 60)} min`);
  const { ffmpegCommand, probeFrameRate } = await mediaProbe();
  const command = ffmpegCommand();
  const run = await analyse(command, file, signal, maxFrames);
  const frames = Math.floor(run.thumbnails.length / THUMBNAIL_BYTES);
  if (!frames) throw new Error("FFmpeg decoded no frames from this file.");
  const mad = (first, second) => meanDifference(run.thumbnails, first, second);
  const stats = frameStats(run.thumbnails, frames);
  const clock = frameClock(run.times, frames, duration);
  const at = (frame) => clock[frame];
  const flat = (frame) => stats.spread[frame] <= FLAT;
  const alike = (first, second) => correlation(run.thumbnails, stats, first, second) >= ALIKE;
  const flashLike = (frame, before, after) => flat(frame) || alike(frame, before) || alike(frame, after);
  // A frame FFmpeg printed no time for cannot start a shot.
  const cuts = cutsFromScores(run.scores, frames, mad, stats.brightness, { at, flat, alike }).filter((frame) => Number.isFinite(run.times[frame]));
  const { starts, flashes } = shotsFromCuts(cuts, frames, mad, { at, flashLike });
  // A file that does not say how long it is (some recorded WebM) ends at its last frame.
  const length = duration > 0 ? duration : frames / await probeFrameRate(file, { signal });
  const times = starts.map((frame) => (frame === 0 ? 0 : run.times[frame]));
  const shots = times.map((start, index) => ({
    start: round3(start),
    end: round3(Math.max(start, times[index + 1] ?? length)),
  }));
  return {
    shots,
    found: { version: SHOTS_VERSION, frames, cuts: shots.length - 1, flashes, ms: Math.round(performance.now() - started) },
  };
}

// FFmpeg command → its check. Only a check that passed is kept: after "no FFmpeg there" or "too
// old", the next upload checks again, so installing or upgrading FFmpeg needs no restart.
const filterChecks = new Map();
const NEEDED_FILTERS = ["scdet", "signalstats"];
// FFmpeg 5.1 added -fps_mode, which kino uses for every video frame it draws (media-probe.mjs).
const NEEDED_OPTION = "-fps_mode";

async function checkFilters(command) {
  const { runMediaTool } = await mediaProbe();
  const [list, about, options] = await Promise.all([
    runMediaTool("ffmpeg", ["-hide_banner", "-filters"]),
    runMediaTool("ffmpeg", ["-version"]),
    runMediaTool("ffmpeg", ["-hide_banner", "-h", "long"]),
  ]);
  // "ffmpeg version 6.1.1-3ubuntu5 Copyright …" → "6.1.1-3ubuntu5"
  const version = /^ffmpeg version (\S+)/m.exec(about)?.[1] ?? "unknown version";
  // A filter line is its flags, its name and its inputs: " ... scdet   V->V   Detect video scene change".
  const missing = NEEDED_FILTERS.filter((name) => !new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(list));
  // An option line starts with its name: "-fps_mode           set framerate mode …" (9.0 adds "[:<stream_spec>]").
  if (!new RegExp(`^${NEEDED_OPTION}\\b`, "m").test(options)) missing.push(NEEDED_OPTION);
  if (!missing.length) return { ok: true, version };
  return {
    ok: false,
    missing,
    version,
    message: `kino needs FFmpeg 5.1 or newer, with the scdet and signalstats filters, to find the shots in a video and draw its frames, and ` +
      `${basename(command)} (${version}) has no ${missing.join(" or ")}. Install a newer FFmpeg or set KINO_FFMPEG to one; nothing was imported.`,
  };
}

/**
 * Checks that the FFmpeg kino uses (KINO_FFMPEG, else ffmpeg) has the scdet and signalstats
 * filters and the -fps_mode option. Resolves with {ok: true, version} or {ok: false, missing, version, message}; with no
 * FFmpeg at all the message is the one that says how to install it.
 */
export async function shotFilters({ signal } = {}) {
  const command = (await mediaProbe()).ffmpegCommand();
  let check = filterChecks.get(command);
  if (!check) {
    check = checkFilters(command)
      .catch((error) => ({ ok: false, missing: NEEDED_FILTERS, version: null, message: firstErrorLine(error) }))
      .then((answer) => {
        if (!answer.ok && filterChecks.get(command) === check) filterChecks.delete(command);
        return answer;
      });
    filterChecks.set(command, check);
  }
  return untilAborted(check, signal);
}

/**
 * Shots for the layers that need them (look sheet, library media). forSource(src) answers
 * {shots} or {shots: null, reason}. A video imported before kino found shots on upload gets them
 * now, saved into its record with saveRecord(id, fields), which logs its own failures; two calls
 * for one file share one run.
 */
export function createShotFinder({ mediaRoot, saveRecord }) {
  const running = new Map(); // media ID → its run

  async function findAndSave(id, record) {
    const filters = await shotFilters();
    // Nothing is being imported here, so the message ends after what to install.
    if (!filters.ok) return { shots: null, reason: filters.message.replace(/; nothing was imported\.$/, ".") };
    let result;
    try {
      result = await findShots(join(mediaRoot, id), { duration: record.duration });
    } catch (error) {
      const line = firstErrorLine(error);
      // Saved, so later looks do not run FFmpeg on this file again.
      await saveRecord(id, { shotsError: line });
      return { shots: null, reason: shotsErrorReason(line) };
    }
    await saveRecord(id, { shots: result.shots, shotsFound: result.found });
    return { shots: result.shots };
  }

  // saved: true answers only what the record has and never runs FFmpeg (the dashboard's lanes).
  async function forSource(src, { signal, saved = false } = {}) {
    // An upload's file name: hex, dashes and an extension, so it is safe in a path.
    const id = parseMediaSource(src)?.id;
    let record = null;
    try {
      if (id) record = JSON.parse(await readFile(join(mediaRoot, `${id}.json`), "utf8"));
    } catch { /* no readable record: not in the library */ }
    if (!record || record.id !== id) return { shots: null, reason: "not in kino's media library" };
    if (!isVideo(record)) return { shots: null, reason: "not a video" };
    if (Array.isArray(record.shots)) return { shots: record.shots };
    if (record.shotsError) return { shots: null, reason: shotsErrorReason(record.shotsError) };
    if (saved) return { shots: null, reason: "not found yet" };
    let run = running.get(id);
    if (!run) {
      run = findAndSave(id, record).finally(() => running.delete(id));
      running.set(id, run);
    }
    return untilAborted(run, signal);
  }

  return { forSource };
}

/**
 * The line about a video's shots in the import answer and library media, in file seconds:
 * `shots: 3: 1) 0–1.25 s 2) 1.25–3.33 s 3) 3.33–4.42 s · crop with look {mode:"source", layer}`.
 * At most 12 shots are listed (200 with `all`). '' for anything but a video.
 */
export function shotsLine(record, { all = false } = {}) {
  if (!isVideo(record)) return "";
  const crop = ' · crop with look {mode:"source", layer}';
  const shots = record.shots;
  if (!Array.isArray(shots)) {
    return record.shotsError ? `shots: not found (${record.shotsError})` : "shots: not found yet (look sheet or library media finds them)";
  }
  if (shots.length <= 1) return `shots: 1 (no cuts found)${crop}`;
  const limit = all ? 200 : 12;
  const listed = shots.slice(0, limit).map((shot, index) => `${index + 1}) ${sec(shot.start)}–${sec(shot.end)} s`).join(" ");
  const more = shots.length <= limit ? ""
    : all ? ` … (${shots.length} in all)`
    : ` … (${shots.length} in all; library {topic:"media", search:${JSON.stringify(String(record.id ?? record.name ?? ""))}} lists them)`;
  return `shots: ${shots.length}: ${listed}${more}${crop}`;
}
