// Object tracking: follows one object (a box on one frame) through a stretch of a video file, on
// this computer only, with Apple Vision's VNTrackObjectRequest in the kino-cutout helper
// (kino-cutout.swift --track). The edit op track (backend/agent/track-operation.mjs) turns the
// result into a scene track that pin follows.
//
// What happens, in order:
//   1. The file's bytes, the helper's version, this Mac's version, the box and the stretch make a
//      cache key; a finished track for that key is used at once.
//   2. Forward: FFmpeg decodes from `at` to `to` (small BGRA frames, at most 30 a second, at most
//      TRACK_SIDE pixels on the long side) straight into the helper, which prints one box a frame.
//   3. Backward (when the stretch starts before `at`): FFmpeg decodes from `from` to `at` into a
//      raw file first, then the helper is fed those frames last to first. Only one FFmpeg runs.
//   4. track.json is written in a ".work-" folder that is renamed into place last, so a
//      half-written track is never found (the same way cut_out keeps its mattes).
//
// Measured on an M-series Mac: 8 to 18 ms a frame, no download. Vision's
// confidence falls when the object has little texture (a box on plain dark fabric fell to 0.57),
// so every frame keeps its confidence and pin's check warns where it is low.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegCommand } from "../media-probe.mjs";
import { sha256File } from "../voice/model.mjs";
import { cutoutEngines, cutoutError, cutoutHelperPath, probeVideo } from "./cutout.mjs";

const TRACK_FORMAT = 1;
// Vision's tracker works on small pictures; this keeps a 1080p clip quick and never decodes 4K.
export const TRACK_SIDE = 960;
const MAX_FPS = 30;
// The longest stretch one track follows (seconds), so one edit never runs for minutes.
export const MAX_TRACK_SECONDS = 60;

function trackSize(width, height) {
  const scale = Math.min(1, TRACK_SIDE / Math.max(width, height));
  const even = (value) => Math.max(2, 2 * Math.round((value * scale) / 2));
  return { width: even(width), height: even(height) };
}

function finished(child, label) {
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (${code}): ${stderr.trim() || "no message"}`))));
  });
}

function decodeArgs(source, seconds, frames, fps, size) {
  return ["-hide_banner", "-nostdin", "-v", "error", "-ss", seconds.toFixed(3), "-i", source, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `fps=fps=${fps}:round=near,scale=${size.width}:${size.height}:flags=area,format=bgra`, "-frames:v", String(frames),
    "-f", "rawvideo", "-pix_fmt", "bgra"];
}

// Starts the helper on `box` and collects its lines; returns { child, lines: Promise<[{x,y,w,h,c}]> }.
function startHelper(helper, size, box, signal) {
  const child = spawn(helper, ["--track", "--width", String(size.width), "--height", String(size.height), "--box", box.map((value) => value.toFixed(5)).join(",")],
    { stdio: ["pipe", "pipe", "pipe"] });
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin.on("error", () => {});
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
  const lines = finished(child, "kino-cutout --track")
    .then(() => text.split("\n").filter(Boolean).map((line) => JSON.parse(line)))
    .finally(() => signal?.removeEventListener("abort", onAbort));
  return { child, lines };
}

async function forward({ source, helper, size, fps, box, at, to, signal }) {
  const frames = Math.max(1, Math.round((to - at) * fps) + 1);
  const decode = spawn(ffmpegCommand(), [...decodeArgs(source, at, frames, fps, size), "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  const { child, lines } = startHelper(helper, size, box, signal);
  decode.stdout.on("error", () => {});
  decode.stdout.pipe(child.stdin);
  const [, found] = await Promise.all([finished(decode, "FFmpeg"), lines]);
  return found.map((entry, index) => [at + index / fps, entry]);
}

async function backward({ source, helper, size, fps, box, from, at, work, signal }) {
  const frames = Math.round((at - from) * fps) + 1;
  if (frames < 2) return [];
  const start = Math.max(0, at - (frames - 1) / fps);
  const raw = join(work, "back.bgra");
  await finished(spawn(ffmpegCommand(), [...decodeArgs(source, start, frames, fps, size), "-y", raw], { stdio: ["ignore", "ignore", "pipe"] }), "FFmpeg");
  const bytes = size.width * size.height * 4;
  const file = await open(raw, "r");
  const { child, lines } = startHelper(helper, size, box, signal);
  // True once the helper has stopped (it may die while frames are still being read and written).
  // Handling `lines` here also keeps a failure from being an unhandled rejection before `await lines`.
  const ended = lines.then(() => true, () => true);
  try {
    const { size: length } = await file.stat();
    const count = Math.floor(length / bytes);
    for (let index = count - 1; index >= 0; index -= 1) {
      if (signal?.aborted) break;
      const frame = Buffer.allocUnsafe(bytes);
      await file.read(frame, 0, bytes, index * bytes);
      if (!child.stdin.write(frame)) {
        // A helper that died never drains: stop writing and let `lines` say why.
        let onDrain;
        const drained = new Promise((resolve) => { onDrain = () => resolve(false); child.stdin.once("drain", onDrain); });
        const stopped = await Promise.race([drained, ended]);
        child.stdin.off("drain", onDrain);
        if (stopped) break;
      }
    }
    child.stdin.end();
    const found = await lines;
    // The first line is the `at` frame again (forward has it); the rest go back in time.
    return found.slice(1).map((entry, index) => [start + (count - 2 - index) / fps, entry]);
  } finally {
    await file.close();
    await rm(raw, { force: true });
  }
}

/**
 * Follows `box` ([x, y, w, h] fractions of the picture, top-left origin, where the object is at
 * file second `at`) from file second `from` to `to`. Resolves { folder, info, cached }; info is
 * track.json: { fps, at, from, to, box, source: {width, height}, frames: [[t, x, y, w, h, c]]
 * (file seconds, fractions, confidence 0 to 1) in time order, seconds (time taken) }.
 */
export async function makeTrack({ source, cacheDir, at, from = at, to, box, signal } = {}) {
  if (!(to > from) || at < from || at > to) throw new RangeError("makeTrack needs from <= at <= to and from < to.");
  if (to - from > MAX_TRACK_SECONDS) throw cutoutError(`A track follows at most ${MAX_TRACK_SECONDS} seconds of the clip.`, "TRACK_TOO_LONG");
  const helper = cutoutHelperPath();
  if (!helper) {
    const [first] = await cutoutEngines();
    throw cutoutError(`Object tracking uses Apple Vision through the kino-cutout helper. ${first.reason ?? ""}`.trim(), "CUTOUT_ENGINE_UNAVAILABLE");
  }
  const engines = await cutoutEngines();
  const sourceHash = await sha256File(source, signal);
  const round = (value) => Math.round(value * 1000) / 1000;
  const key = createHash("sha256").update(JSON.stringify({ format: TRACK_FORMAT, source: sourceHash, helper: engines[0].helper ?? null,
    macOS: String(engines[0].macOS ?? "").split(".")[0], at: round(at), from: round(from), to: round(to), box: box.map((value) => round(value)), side: TRACK_SIDE }))
    .digest("hex").slice(0, 32);
  const folder = join(cacheDir, key);
  try { return { folder, info: JSON.parse(await readFile(join(folder, "track.json"), "utf8")), cached: true }; } catch { /* make it */ }

  await mkdir(cacheDir, { recursive: true });
  const work = await mkdtemp(join(cacheDir, ".work-"));
  const started = performance.now();
  try {
    const video = await probeVideo(source, signal);
    const size = trackSize(video.width, video.height);
    const fps = Math.min(MAX_FPS, video.fps || MAX_FPS);
    const ahead = await forward({ source, helper, size, fps, box, at, to, signal });
    const behind = from < at ? await backward({ source, helper, size, fps, box, from, at, work, signal }) : [];
    const frames = [...behind, ...ahead].sort((a, b) => a[0] - b[0])
      .map(([time, entry]) => [round(time), ...[entry.x, entry.y, entry.w, entry.h].map((value) => Math.round(value * 10000) / 10000), Math.round(entry.c * 100) / 100]);
    if (!frames.length) throw cutoutError("The clip has no frames in that stretch to track.", "CUTOUT_NO_PICTURE");
    const info = { format: TRACK_FORMAT, fps, at, from, to, box, source: { width: video.width, height: video.height }, frames,
      seconds: Math.round((performance.now() - started) / 100) / 10, credit: "Apple Vision VNTrackObjectRequest (macOS)" };
    await writeFile(join(work, "track.json"), `${JSON.stringify(info)}\n`);
    try { await rename(work, folder); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      await rm(work, { recursive: true, force: true });
    }
    return { folder, info, cached: false };
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
