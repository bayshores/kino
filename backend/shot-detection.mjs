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
import { endWithService } from "./child-exit.mjs";
import { sec } from "./agent/describe.mjs";
import { ffmpegArgs, lowerIfBackground } from "./render-activity.mjs";
import { heavyDecodeSlot } from "./process-slots.mjs";
import { round as round3 } from "../engine/numbers.js";
import { frameLevel } from "../engine/cutFacts.js";

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
// A frame that scores under LOW_SCORE starts a new picture too when its jump stands out the same
// way (SPIKE), is at least UNLIKE_JUMP (of 255), and the frames either side are not ALIKE, neither
// of them black: scdet scores a cut between two dim drawn shots low (2.2 for a dim stairway into a
// darker face, jump 7.3 against at most 0.9 around it, correlation 0.36), while a new drawing in a
// held shot keeps its layout (correlation 0.75 and more). Only in drawn footage (the file holds
// each drawing 2 frames or more, shotsFromRun): in a live film trailer a fast move or a flaring
// fire in the dark jumps the same way inside one shot (5 of 7 such jumps in one trailer).
export const UNLIKE_JUMP = 5;
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
// Saved with the shots (shotsFound.version), so a better finder can tell old results apart. 2: cuts
// between dim drawn shots (UNLIKE_JUMP) and held drawings under a camera drift (DRIFT_MAX). 3: a
// shot's edge frames (shotEdges), so a file found before them is measured once more.
export const SHOTS_VERSION = 3;
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
 *      With `drawn` (the file holds its drawings), under LOW_SCORE too when the jump is UNLIKE_JUMP
 *      or more into a picture not alike the one before, neither frame black (dim drawn shots).
 *   3. It ends a dip to black (DARK) that does not open the file: two frames of black or more, or
 *      one between two different pictures (the nearest frames that are not flat are not alike).
 */
export function cutsFromScores(scores, frames, mad, brightness, { at = (frame) => frame, flat = () => false, alike = () => true, drawn = false } = {}) {
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
    const spike = jump >= SPIKE * around;
    const unlike = () => drawn && jump >= UNLIKE_JUMP && !dark(frame - 1) && !dark(frame) && !alike(frame - 1, frame);
    if (score >= SCDET_THRESHOLD || (spike && (score >= LOW_SCORE || unlike()))) cuts.push(frame);
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
 * `minShotFrames` replaces MIN_SHOT_FRAMES in rules 2 and 3: a reference edit cut in 2-frame shots
 * (inspire) keeps them. A flash (rule 1) is still judged at MIN_SHOT_FRAMES, so an impact frame
 * inside a held shot stays a flash, and one more rule keeps a flash from becoming a shot:
 *   4. Seam flash: with minShotFrames under MIN_SHOT_FRAMES, a cut c followed less than
 *      MIN_SHOT_FRAMES on by a cut to another picture, every frame between them looking like a
 *      flash, is one cut (c) and one flash. The default drops that sliver by rule 2 and counts none.
 * `onFlash(c, e)` hears each flash.
 */
export function shotsFromCuts(cuts, frames, mad, { at = (frame) => frame, flashLike = () => false, minShotFrames = MIN_SHOT_FRAMES, onFlash = () => {} } = {}) {
  const kept = [];
  let flashes = 0;
  // The index of the last cut that ends a seam flash starting at cuts[index], or -1.
  const seamEnd = (index) => {
    const cut = cuts[index];
    let end = -1;
    for (let next = index + 1, inside = cut; next < cuts.length && at(cuts[next]) - at(cut) < MIN_SHOT_FRAMES - EPSILON; next += 1) {
      for (; inside < cuts[next]; inside += 1) if (!flashLike(inside, cut - 1, cuts[next])) return end;
      end = next;
    }
    return end;
  };
  for (let index = 0; index < cuts.length; index += 1) {
    const cut = cuts[index];
    const back = flashEnd(cut, frames, mad, at, flashLike);
    if (back < 0) {
      kept.push(cut);
      const seam = minShotFrames < MIN_SHOT_FRAMES && cut > 0 ? seamEnd(index) : -1;
      if (seam >= 0) {
        flashes += 1;
        onFlash(cut, cuts[seam]);
        index = seam;
      }
      continue;
    }
    flashes += 1;
    onFlash(cut, back);
    while (index + 1 < cuts.length && cuts[index + 1] <= back) index += 1; // every cut from c to e belongs to the flash
  }
  const long = (from, to) => at(to) - at(from) >= minShotFrames - EPSILON;
  const starts = [0];
  for (const cut of kept) if (long(starts.at(-1), cut)) starts.push(cut);
  if (starts.length > 1 && !long(starts.at(-1), frames)) starts.pop();
  return { starts, flashes };
}

/**
 * The edge frames of each shot: a cut the shot rules dropped (a sliver under MIN_SHOT_FRAMES, or a
 * last stretch too short to be a shot) that lies within MIN_SHOT_FRAMES of a shot's start or end
 * leaves frames of another picture at that edge (a whip, a flash frame, a black frame, a one-frame
 * card). `cuts` are every cut found, `starts` the shots' first frames (shotsFromCuts), `flashes`
 * [[cut, back]] frame spans of flashes (their cuts are not edges). Returns [{head, tail}] per
 * shot, in frames: how many frames at its start and its end show another picture (0 for none).
 */
export function shotEdges(cuts, starts, frames, { at = (frame) => frame, flashes = [] } = {}) {
  const inFlash = (cut) => flashes.some(([from, to]) => cut >= from && cut <= to);
  return starts.map((start, index) => {
    const next = starts[index + 1] ?? frames;
    const dropped = cuts.filter((cut) => cut > start && cut < next && !inFlash(cut));
    let head = 0, tail = 0;
    for (const cut of dropped) {
      if (at(cut) - at(start) < MIN_SHOT_FRAMES - EPSILON) head = cut - start;
      else if (at(next) - at(cut) < MIN_SHOT_FRAMES - EPSILON && !tail) tail = next - cut;
    }
    // The body between the edges must stay a shot; else the edges are not told apart from it.
    if (next - start - head - tail < MIN_SHOT_FRAMES) return { head: 0, tail: 0 };
    return { head, tail };
  });
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

// Two frames in a row this alike (mean difference of their 32×18 gray copies, of 255) show one
// held picture: drawn footage "on 3s" repeats each drawing for 3 frames; compression noise in a
// held drawing stays under it.
export const HOLD_DIFF = 0.5;
// The longest run that is the drawing step (on 2s, 3s or 4s); a longer run is a held pose.
const STEP_FRAMES = 4;
// A held picture this long in the file is a still pose (file seconds).
export const STILL_POSE = 0.3;
const MOST_STILLS = 40;
// A camera drifting (a slow pan, zoom or glow) over a held drawing changes every frame a little.
// In one shot, changes up to DRIFT_MAX (of 255) count as drift, not new drawings, when the shot's
// next larger changes are at least DRIFT_GAP times as big and come every 2 to STEP_FRAMES frames
// (the median run between them): a drawing on 4s under a drift measured 0.55 to 1.1 between its
// drawings and 12.3 to 12.7 at them. Live footage changes by similar amounts on every frame, so
// no gap is found and HOLD_DIFF stays the limit.
export const DRIFT_MAX = 2;
export const DRIFT_GAP = 4;

// The largest change that still repeats a picture in the shot of frames from…to (exclusive):
// HOLD_DIFF, or its drift (see DRIFT_MAX).
function holdLimit(from, to, mad) {
  const moving = [];
  for (let frame = from + 1; frame < to; frame += 1) {
    const change = mad(frame - 1, frame);
    if (change > HOLD_DIFF) moving.push(change);
  }
  moving.sort((a, b) => a - b);
  let limit = HOLD_DIFF, gap = 0;
  for (let index = 0; index + 1 < moving.length && moving[index] <= DRIFT_MAX; index += 1) {
    const ratio = moving[index + 1] / moving[index];
    if (ratio >= DRIFT_GAP && ratio > gap) [limit, gap] = [moving[index], ratio];
  }
  if (limit === HOLD_DIFF) return limit;
  const runs = [];
  for (let frame = from + 1, start = from; frame <= to; frame += 1) {
    if (frame < to && mad(frame - 1, frame) <= limit) continue;
    runs.push(frame - start);
    start = frame;
  }
  runs.sort((a, b) => a - b);
  const usual = runs[Math.floor(runs.length / 2)];
  return usual >= 2 && usual <= STEP_FRAMES ? limit : HOLD_DIFF;
}

/**
 * A video's held-frame pattern from its frame differences: {repeated, frames, stills}. `repeated`
 * is the share of frames that repeat the frame before (0 for live footage, about 0.67 on 3s);
 * `frames` the usual hold in frames (the median run of one picture among runs up to STEP_FRAMES
 * long: 1 for live footage, 3 on 3s); `stills` the held poses of STILL_POSE or longer, [{start,
 * end}] file seconds (at most 40). `mad(i, j)` is how much frames i and j differ (0-255), `times[i]`
 * where frame i starts and `length` where the file ends. `starts` are the first frames of the
 * file's shots: each shot gets its own drift limit (holdLimit), and `drift` (the largest limit
 * over HOLD_DIFF, when one is) says a drift was set aside.
 */
export function holdPattern(frames, mad, times, length, starts = [0]) {
  const runs = [];
  let start = 0, drift = 0;
  const limits = new Float64Array(frames + 1).fill(HOLD_DIFF);
  starts.forEach((from, index) => {
    const to = starts[index + 1] ?? frames;
    const limit = holdLimit(from, to, mad);
    if (limit > HOLD_DIFF) limits.fill(limit, from + 1, to);
    drift = Math.max(drift, limit > HOLD_DIFF ? limit : 0);
  });
  for (let frame = 1; frame <= frames; frame += 1) {
    if (frame < frames && mad(frame - 1, frame) <= limits[frame]) continue;
    runs.push([start, frame]);
    start = frame;
  }
  const repeated = frames > 1 ? (frames - runs.length) / (frames - 1) : 0;
  const steps = runs.map(([from, to]) => to - from).filter((count) => count <= STEP_FRAMES).sort((a, b) => a - b);
  const timeOf = (frame) => (frame < frames ? times[frame] : length);
  const stills = runs
    .filter(([from, to]) => Number.isFinite(timeOf(from)) && Number.isFinite(timeOf(to)) && timeOf(to) - timeOf(from) >= STILL_POSE - 1e-6)
    .slice(0, MOST_STILLS)
    .map(([from, to]) => ({ start: round3(from === 0 ? 0 : times[from]), end: round3(timeOf(to)) }));
  return {
    repeated: Math.round(repeated * 100) / 100,
    frames: steps.length ? steps[Math.floor(steps.length / 2)] : 1,
    stills,
    ...(drift ? { drift: Math.round(drift * 100) / 100 } : {}),
  };
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
// One video decode at a time in this process (process-slots.mjs): finding the shots of many new
// videos queues instead of starting FFmpeg for each at once.
function analyse(command, file, signal, maxFrames, levels = false) {
  return heavyDecodeSlot(() => analyseNow(command, file, signal, maxFrames, levels));
}

// Each frame's mean color, from a 32×18 rgb24 copy streamed in whole frames: only {y, hue} of each
// frame is kept (frameLevel), never the pixels. `push(chunk)` takes any slicing of the stream.
function levelReader() {
  const size = THUMBNAIL_BYTES * 3;
  const found = [];
  let left = Buffer.alloc(0);
  return {
    found,
    push(chunk) {
      let data = left.length ? Buffer.concat([left, chunk]) : chunk;
      let offset = 0;
      for (; offset + size <= data.length; offset += size) {
        let r = 0, g = 0, b = 0;
        for (let pixel = offset; pixel < offset + size; pixel += 3) {
          r += data[pixel];
          g += data[pixel + 1];
          b += data[pixel + 2];
        }
        found.push(frameLevel(r / THUMBNAIL_BYTES, g / THUMBNAIL_BYTES, b / THUMBNAIL_BYTES));
      }
      left = data.subarray(offset);
    },
  };
}

function analyseNow(command, file, signal, maxFrames, levels) {
  const picture = `scale=${ANALYSIS_WIDTH}:-2,scdet=threshold=${SCDET_THRESHOLD},metadata=mode=print:key=lavfi.scd.score`;
  const small = `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:flags=area`;
  // With levels the same graph is split after scdet: the gray output on pipe:1 is the one the cuts
  // come from, unchanged; the rgb24 copy on pipe:3 only feeds the brightness and hue of each frame.
  const args = levels
    ? [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", file, "-an", "-sn", "-dn",
      "-filter_complex", `[0:v:0]${picture},split=2[a][b];[a]${small},format=gray[gray];[b]${small},format=rgb24[rgb]`,
      "-map", "[gray]", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1",
      "-map", "[rgb]", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:3",
    ]
    : [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info",
      "-i", file, "-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode", "passthrough",
      "-vf", `${picture},${small},format=gray`,
      "-f", "rawvideo", "pipe:1",
    ];
  const reader = levels ? levelReader() : null;
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(abortError(signal));
      return;
    }
    const child = endWithService(spawn(command, ffmpegArgs(args), { shell: false, stdio: levels ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] }));
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
    child.stdio[3]?.on("data", (chunk) => { if (!tooLong) reader.push(chunk); });
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
      else if (code === 0) resolvePromise({ times, scores, thumbnails: Buffer.concat(chunks), levels: reader?.found });
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
function tooLongError(why, maxSeconds = MAX_VIDEO_SECONDS) {
  const error = new Error(`${TOO_LONG}: ${why}; kino looks in videos up to ${maxSeconds / 60} min and ${MAX_VIDEO_FRAMES} frames`);
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
 * `maxSeconds` (MAX_VIDEO_SECONDS unless the caller allows more: the footage finder's 360p scan of
 * a whole 30 min episode), or with more than `maxFrames` frames, fails with a "too long" error.
 * Also resolves with `flashes` ([{start, end}] file seconds, not saved with a record) and `fps` (the
 * file's usual frame rate). `minShotFrames` goes to shotsFromCuts (inspire reads 2-frame shots).
 */
export async function findShots(file, { duration, signal, maxFrames = MAX_VIDEO_FRAMES, maxSeconds = MAX_VIDEO_SECONDS, minShotFrames = MIN_SHOT_FRAMES, levels = false } = {}) {
  const started = performance.now();
  if (duration > maxSeconds) throw tooLongError(`it is ${Math.round(duration / 60)} min`, maxSeconds);
  const { ffmpegCommand, probeFrameRate } = await mediaProbe();
  const command = ffmpegCommand();
  const run = await analyse(command, file, signal, maxFrames, levels);
  const frames = Math.floor(run.thumbnails.length / THUMBNAIL_BYTES);
  if (!frames) throw new Error("FFmpeg decoded no frames from this file.");
  // A file that does not say how long it is (some recorded WebM) ends at its last frame.
  const length = duration > 0 ? duration : frames / await probeFrameRate(file, { signal });
  return shotsFromRun(run, { duration, length, minShotFrames, started });
}

/**
 * The shots, held frames and flashes of one FFmpeg run ({times, scores, thumbnails, levels?}: each
 * frame's file time, scdet score and 32×18 gray copy). `length` is where the file ends (seconds).
 * findShots without FFmpeg, so a saved run can be measured again.
 */
export function shotsFromRun(run, { duration, length, minShotFrames = MIN_SHOT_FRAMES, started = performance.now() } = {}) {
  const frames = Math.floor(run.thumbnails.length / THUMBNAIL_BYTES);
  const mad = (first, second) => meanDifference(run.thumbnails, first, second);
  const stats = frameStats(run.thumbnails, frames);
  const clock = frameClock(run.times, frames, duration);
  const at = (frame) => clock[frame];
  const flat = (frame) => stats.spread[frame] <= FLAT;
  const alike = (first, second) => correlation(run.thumbnails, stats, first, second) >= ALIKE;
  const flashLike = (frame, before, after) => flat(frame) || alike(frame, before) || alike(frame, after);
  const find = (drawn) => {
    // A frame FFmpeg printed no time for cannot start a shot.
    const cuts = cutsFromScores(run.scores, frames, mad, stats.brightness, { at, flat, alike, drawn }).filter((frame) => Number.isFinite(run.times[frame]));
    const flashSpans = [], flashFrames = [];
    const onFlash = (cut, back) => { flashSpans.push({ start: round3(run.times[cut]), end: round3(run.times[back]) }); flashFrames.push([cut, back]); };
    const { starts, flashes } = shotsFromCuts(cuts, frames, mad, { at, flashLike, minShotFrames, onFlash });
    const edges = shotEdges(cuts, starts, frames, { at, flashes: flashFrames });
    return { starts, flashes, flashSpans, edges, holds: holdPattern(frames, mad, run.times, length, starts) };
  };
  // Drawn footage (each drawing held 2 frames or more in the shots found without it) is looked at
  // once more for cuts between dim drawn shots (UNLIKE_JUMP).
  let found = find(false);
  if (found.holds.frames >= 2) found = find(true);
  const { starts, flashes, flashSpans, edges } = found;
  const span = run.times[frames - 1] - run.times[0];
  const times = starts.map((frame) => (frame === 0 ? 0 : run.times[frame]));
  const shots = times.map((start, index) => {
    const end = Math.max(start, times[index + 1] ?? length);
    const { head = 0, tail = 0 } = edges[index] ?? {};
    // A shot's edge frames (shotEdges): edge {head, tail} frames and the body between them,
    // {start, end} file seconds, which imports and board shots keep to by default.
    const inner = (frame) => run.times[frame];
    const edge = head || tail ? { head, tail, start: round3(head ? inner(starts[index] + head) : start), end: round3(tail ? inner((starts[index + 1] ?? frames) - tail) : end) } : null;
    return { start: round3(start), end: round3(end), ...(edge && Number.isFinite(edge.start) && Number.isFinite(edge.end) ? { edge } : {}) };
  });
  return {
    shots,
    // How the file holds its pictures (drawn footage on 2s or 3s, held poses): holdPattern.
    holds: { ...found.holds, ...(span > 0 ? { fps: round3(clock[frames - 1] / span) } : {}) },
    found: { version: SHOTS_VERSION, frames, cuts: shots.length - 1, flashes, ms: Math.round(performance.now() - started) },
    flashes: flashSpans.filter((flash) => Number.isFinite(flash.start) && Number.isFinite(flash.end)),
    fps: span > 0 ? round3(clock[frames - 1] / span) : null,
    // With `levels: true`: every frame's { t, y, hue } (file seconds; y of 255; hue in degrees or null).
    ...(run.levels ? { levels: run.levels.slice(0, frames).flatMap((level, frame) => (Number.isFinite(run.times[frame]) ? [{ t: round3(run.times[frame]), ...level }] : [])) } : {}),
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
    // Shots found before held frames were measured stay the answer when that run cannot happen.
    const known = Array.isArray(record.shots) ? record.shots : null;
    const filters = await shotFilters();
    // Nothing is being imported here, so the message ends after what to install.
    if (!filters.ok) return known ? { shots: known } : { shots: null, reason: filters.message.replace(/; nothing was imported\.$/, ".") };
    let result;
    try {
      result = await findShots(join(mediaRoot, id), { duration: record.duration });
    } catch (error) {
      const line = firstErrorLine(error);
      // Saved, so later looks do not run FFmpeg on this file again.
      await saveRecord(id, { shotsError: line });
      return known ? { shots: known } : { shots: null, reason: shotsErrorReason(line) };
    }
    await saveRecord(id, { shots: result.shots, holds: result.holds, shotsFound: result.found });
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
    // A video found before kino measured held frames (record.holds), or by an older finder
    // (shotsFound.version), is measured once more.
    const current = record.holds && (record.shotsFound?.version ?? 0) >= SHOTS_VERSION;
    if (Array.isArray(record.shots) && (current || saved || record.shotsError)) return { shots: record.shots };
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
  const held = holdsLine(record.holds);
  if (shots.length <= 1) return `shots: 1 (no cuts found)${crop}${held}`;
  const limit = all ? 200 : 12;
  const listed = shots.slice(0, limit).map((shot, index) => `${index + 1}) ${sec(shot.start)}–${sec(shot.end)} s`).join(" ");
  const more = shots.length <= limit ? ""
    : all ? ` … (${shots.length} in all)`
    : ` … (${shots.length} in all; library {topic:"media", search:${JSON.stringify(String(record.id ?? record.name ?? ""))}} lists them)`;
  return `shots: ${shots.length}: ${listed}${more}${crop}${held}`;
}

/**
 * The held-frame facts of drawn footage (holdPattern) for shotsLine: " · drawn on 3s (67% repeated
 * frames, 10 drawings a second; slowed, nearest keeps whole drawings, blend overlays two; still
 * poses 0–0.49 s)", or "" for live footage (a drawing step of 1 frame).
 */
export function holdsLine(holds) {
  if (!(holds?.frames >= 2)) return "";
  const stills = (holds.stills ?? []).slice(0, 4).map((still) => `${sec(still.start)}–${sec(still.end)} s`);
  const posed = stills.length ? `; still poses ${stills.join(" ")}${holds.stills.length > 4 ? ` +${holds.stills.length - 4}` : ""}` : "";
  return ` · drawn on ${holds.frames}s (${Math.round(holds.repeated * 100)}% repeated frames${holds.fps > 0 ? `, ${sec(holds.fps / holds.frames)} drawings a second` : ""}; slowed, nearest keeps whole drawings, blend overlays two${posed})`;
}
