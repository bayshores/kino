// Video stabilization: steadies a shaky video file on this computer only, with Apple Vision and
// Core Image in the kino-cutout helper (kino-cutout.swift --stabilize). The edit op stabilize
// (backend/agent/stabilize-operation.mjs) points a video layer at the steadied copy.
//
// What happens, in order:
//   1. The file's bytes, the helper's version, smooth and zoom make a cache key; a finished copy
//      for that key is used at once.
//   2. Motion: the helper measures how the picture moved from each frame to the next (a move, a
//      turn and a scale about the center; VNHomographicImageRegistrationRequest at 640 px), with
//      people painted out (VNGeneratePersonSegmentationRequest), so a walker in front of the
//      camera does not move the camera path. Moves far off their neighbors are rejected (rejectJumps).
//   3. Plan (planStabilize, pure math): the moves add up to the camera's path; a Gaussian over
//      `smooth` seconds gives the path it should have taken; the correction is smooth minus raw.
//      Each correction is shrunk where needed so one fixed zoom (at most MAX_ZOOM, or `zoom`)
//      hides the picture's edges for the whole clip.
//   4. Render: the helper moves every frame by its correction, zooms, and writes H.264 at the
//      file's size and frame times; the sound is copied unchanged. The motion of the result is
//      measured again, so the receipt's jerk numbers are both measured, not predicted. A copy
//      whose worst jerk is above the file's own is marked worse, and the op keeps the original.
//   5. Everything is written in a ".work-" folder that is renamed into place last.
// Only files up to 1080p are read (no 4K decoding), and one stabilization runs at a time.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256File } from "../voice/model.mjs";
import { cutoutEngines, cutoutError, cutoutHelperPath, probeVideo } from "./cutout.mjs";

const STABILIZE_FORMAT = 3;
export const MAX_ZOOM = 1.15;
export const DEFAULT_SMOOTH = 1;
const MOTION_SIDE = 640;

/** Gaussian smoothing of `values` (numbers) with `sigma` in samples; the kernel is cut at `radius`. */
export function gaussianSmooth(values, sigma, radius = Math.ceil(3 * sigma)) {
  if (!(sigma > 0) || values.length < 2) return values.slice();
  const weights = Array.from({ length: radius + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  return values.map((_, i) => {
    let sum = 0, total = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      sum += values[j] * weights[Math.abs(k)]; total += weights[Math.abs(k)];
    }
    return sum / total;
  });
}

/**
 * The zoom (1 or more) that hides the edges of a frame moved by `correction` [x, y, turn, scale]
 * (about the center, file pixels) in a width × height picture; Infinity when no zoom can.
 */
export function zoomNeeded([x, y, turn, scale], width, height) {
  const cos = Math.cos(-turn), sin = Math.sin(-turn);
  const halves = [width / 2, height / 2];
  // A corner p of the output comes from q = R(-turn)(p / zoom - t) / scale; with u = 1 / zoom each
  // axis of q is linear in u, and |q| must stay inside the picture.
  const rotate = ([px, py]) => [cos * px - sin * py, sin * px + cos * py];
  const t = rotate([x, y]);
  let most = 1;
  for (const p of [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => rotate([a * halves[0], b * halves[1]]))) {
    for (const axis of [0, 1]) {
      const alpha = p[axis], beta = t[axis], room = halves[axis] * scale;
      if (Math.abs(alpha) < 1e-9) { if (Math.abs(beta) > room) return Infinity; continue; }
      const bound = alpha > 0 ? (room + beta) / alpha : (beta - room) / alpha;
      if (bound <= 0) return Infinity;
      most = Math.min(most, bound);
    }
  }
  return 1 / most;
}

const shrink = ([x, y, turn, scale], k) => [x * k, y * k, turn * k, Math.exp(Math.log(scale) * k)];

/** The mean distance (px at 1080p) between each frame-to-frame move and its smoothed trend. */
export function shakeOf(moves, { fps, height, smooth = DEFAULT_SMOOTH }) {
  if (moves.length < 3) return 0;
  const sigma = (smooth * fps) / 2;
  const xs = moves.map((move) => move[0]), ys = moves.map((move) => move[1]);
  const gx = gaussianSmooth(xs, sigma), gy = gaussianSmooth(ys, sigma);
  const total = xs.reduce((sum, value, i) => sum + Math.hypot(value - gx[i], ys[i] - gy[i]), 0);
  return (total / moves.length) * (1080 / height);
}

/**
 * Frame-to-frame jerk of the background (people are left out by the helper): how much each
 * frame's move differs from the one before, in px at 1080p. { mean, worst, at (frame index) }.
 */
export function jerkOf(moves, { height }) {
  let total = 0, worst = 0, at = 0;
  for (let i = 2; i < moves.length; i += 1) {
    const jerk = Math.hypot(moves[i][0] - moves[i - 1][0], moves[i][1] - moves[i - 1][1]) * (1080 / height);
    total += jerk;
    if (jerk > worst) { worst = jerk; at = i; }
  }
  return { mean: total / Math.max(1, moves.length - 2), worst, at };
}

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Vision now and then answers a move far off the moves around it (a frame it could not match).
 * A move more than 3 times the local median size (half a second either side, and at least
 * `floor` px) away from the local median move is replaced by that median move.
 */
export function rejectJumps(moves, { fps, floor = 3 }) {
  const reach = Math.max(2, Math.round(fps / 2));
  let rejected = 0;
  const kept = moves.map((move, i) => {
    if (i === 0) return move;
    const near = moves.slice(Math.max(1, i - reach), i + reach + 1);
    const center = [0, 1, 2, 3].map((axis) => median(near.map((item) => item[axis])));
    const spread = median(near.map((item) => Math.hypot(item[0] - center[0], item[1] - center[1])));
    if (Math.hypot(move[0] - center[0], move[1] - center[1]) <= Math.max(floor, 3 * spread)) return move;
    rejected += 1;
    return center;
  });
  return { moves: kept, rejected };
}

/**
 * From the helper's frame-to-frame moves ([x, y, turn, scale] a frame), the correction for every
 * frame and the one zoom for the clip: { corrections, zoom, shrunk } (shrunk: the share of frames
 * whose correction had to be made smaller to stay inside the zoom).
 */
export function planStabilize(moves, { width, height, fps, smooth = DEFAULT_SMOOTH, zoom } = {}) {
  const sigma = Math.max(0.5, (smooth * fps) / 2);
  const path = [[0, 0, 0, 0]];
  for (let i = 1; i < moves.length; i += 1) {
    const [x, y, turn, scale] = moves[i], last = path[i - 1];
    path.push([last[0] + x, last[1] + y, last[2] + turn, last[3] + Math.log(scale > 0 ? scale : 1)]);
  }
  const cap = zoom ?? MAX_ZOOM;
  // How much of a correction fits inside the zoom (bisection).
  const fit = (correction) => {
    if (zoomNeeded(correction, width, height) <= cap) return 1;
    let low = 0, high = 1;
    for (let step = 0; step < 20; step += 1) {
      const mid = (low + high) / 2;
      if (zoomNeeded(shrink(correction, mid), width, height) <= cap) low = mid; else high = mid;
    }
    return low;
  };
  const toCorrections = (target) => path.map((point, i) => [0, 1, 2, 3].map((axis) => target[axis][i] - point[axis]))
    .map(([x, y, turn, logScale]) => [x, y, turn, Math.exp(logScale)]);
  // Where the smooth path strays further from the real one than the zoom allows (a fast pan), it
  // is pulled back inside and smoothed again, a few times, so the path itself bends gently there.
  // Shrinking the corrections alone would jerk: a 300 px correction cut to half in a few frames.
  let target = [0, 1, 2, 3].map((axis) => gaussianSmooth(path.map((point) => point[axis]), sigma));
  for (let round = 0; round < 8; round += 1) {
    const inside = toCorrections(target).map((correction, i) => {
      const [x, y, turn, scale] = shrink(correction, fit(correction));
      return [path[i][0] + x, path[i][1] + y, path[i][2] + turn, path[i][3] + Math.log(scale)];
    });
    target = [0, 1, 2, 3].map((axis) => gaussianSmooth(inside.map((point) => point[axis]), sigma));
  }
  const raw = toCorrections(target);
  // What still does not fit: a moving minimum of the share and a Gaussian no wider than it, so
  // the share changes gently and never goes over what fits.
  const fits = raw.map(fit);
  const reach = Math.max(1, Math.round(sigma));
  const floor = fits.map((_, i) => Math.min(...fits.slice(Math.max(0, i - reach), i + reach + 1)));
  const share = gaussianSmooth(floor, reach / 2, reach).map((value, i) => Math.min(value, fits[i]));
  const corrections = raw.map((correction, i) => shrink(correction, share[i]));
  const needed = corrections.reduce((most, correction) => Math.max(most, zoomNeeded(correction, width, height)), 1);
  const used = zoom ?? Math.min(cap, Math.ceil(needed * 1000) / 1000);
  return { corrections, zoom: used, shrunk: share.filter((value) => value < 0.95).length / Math.max(1, share.length) };
}

function run(helper, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    let text = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(text);
      else reject(cutoutError(`kino-cutout --stabilize failed (${code}): ${stderr.trim() || "no message"}`, "STABILIZE_FAILED"));
    });
  });
}

async function motionOf(helper, file, signal) {
  const text = await run(helper, ["--stabilize", "motion", "--input", file, "--side", String(MOTION_SIDE)], signal);
  // Only "m x y r s" lines: Vision sometimes prints its own messages on standard output. A move
  // Vision got badly wrong (over a quarter of the picture, a 10% zoom or 0.2 rad in one frame)
  // counts as no move.
  return text.split("\n").filter((line) => line.startsWith("m ")).map((line) => {
    const move = line.slice(2).split(" ").map(Number);
    const sane = move.length === 4 && move.every(Number.isFinite) && Math.abs(move[0]) < 480 && Math.abs(move[1]) < 270 && Math.abs(move[2]) < 0.2 && Math.abs(move[3] - 1) < 0.1;
    return sane ? move : [0, 0, 0, 1];
  });
}

// One stabilization at a time (each decodes a whole clip and encodes one).
let queue = Promise.resolve();

/**
 * Steadies `source` (a video file up to 1080p). Options: cacheDir, smooth (seconds, default 1),
 * zoom (1 to 1.15; automatic when left out), signal. Resolves { file, info, cached }; info is
 * { width, height, fps, frames, smooth, zoom, shrunk, rejected, jerk: {before, after: {mean, worst, at}} (px at 1080p,
 * at in seconds), worse, seconds }.
 */
export function makeStabilized(options) {
  const job = queue.then(() => stabilizeNow(options));
  queue = job.catch(() => {});
  return job;
}

async function stabilizeNow({ source, cacheDir, smooth = DEFAULT_SMOOTH, zoom, signal } = {}) {
  if (zoom !== undefined && !(zoom >= 1 && zoom <= MAX_ZOOM)) throw new RangeError(`zoom is from 1 to ${MAX_ZOOM}.`);
  const video = await probeVideo(source, signal);
  if (Math.max(video.width, video.height) > 1920 || Math.min(video.width, video.height) > 1080)
    throw cutoutError(`The clip is ${video.width}x${video.height}; stabilize reads files up to 1080p (no 4K decoding). Import a 1080p copy and stabilize that.`, "STABILIZE_TOO_LARGE");
  const helper = cutoutHelperPath();
  const engines = helper ? await cutoutEngines() : [];
  if (!helper || !engines[0]?.helper) throw cutoutError(`Stabilization uses Apple Vision through the kino-cutout helper. ${engines[0]?.reason ?? "Build it with npm run desktop:cutout."}`.trim(), "CUTOUT_ENGINE_UNAVAILABLE");
  if (Number(engines[0].helper) < 4) throw cutoutError("The kino-cutout helper is older than stabilize; rebuild it with npm run desktop:cutout.", "CUTOUT_ENGINE_UNAVAILABLE");
  const key = createHash("sha256").update(JSON.stringify({ format: STABILIZE_FORMAT, source: await sha256File(source, signal), helper: engines[0].helper,
    macOS: String(engines[0].macOS ?? "").split(".")[0], smooth, zoom: zoom ?? null })).digest("hex").slice(0, 32);
  const folder = join(cacheDir, key);
  try { return { file: join(folder, "stabilized.mp4"), info: JSON.parse(await readFile(join(folder, "stabilized.json"), "utf8")), cached: true }; } catch { /* make it */ }

  await mkdir(cacheDir, { recursive: true });
  const work = await mkdtemp(join(cacheDir, ".work-"));
  const started = performance.now();
  try {
    const moves = await motionOf(helper, source, signal);
    if (moves.length < 2) throw cutoutError("The clip has fewer than 2 frames, so there is nothing to steady.", "CUTOUT_NO_PICTURE");
    const fps = video.fps || 30;
    const steady = rejectJumps(moves, { fps });
    const plan = planStabilize(steady.moves, { width: video.width, height: video.height, fps, smooth, zoom });
    await writeFile(join(work, "transforms.txt"), plan.corrections.map((c) => c.map((value, i) => value.toFixed(i < 2 ? 3 : 6)).join(" ")).join("\n"));
    const output = join(work, "stabilized.mp4");
    await run(helper, ["--stabilize", "render", "--input", source, "--output", output, "--transforms", join(work, "transforms.txt"), "--zoom", plan.zoom.toFixed(4)], signal);
    const after = await motionOf(helper, output, signal);
    const round = (value) => Math.round(value * 100) / 100;
    // Both measured the same way (people left out, nothing rejected). A copy whose worst jerk is
    // above the file's own is not used: worse is true and the op keeps the original.
    const jerk = (list) => { const found = jerkOf(list, { height: video.height }); return { mean: round(found.mean), worst: round(found.worst), at: round(found.at / fps) }; };
    const before = jerk(moves), later = jerk(after);
    const info = { format: STABILIZE_FORMAT, width: video.width, height: video.height, fps, frames: moves.length, smooth, zoom: plan.zoom,
      shrunk: round(plan.shrunk), rejected: steady.rejected, jerk: { before, after: later }, worse: later.worst > before.worst,
      seconds: Math.round((performance.now() - started) / 100) / 10, credit: "Apple Vision VNHomographicImageRegistrationRequest, Core Image, AVFoundation (macOS)" };
    await writeFile(join(work, "stabilized.json"), `${JSON.stringify(info)}\n`);
    await rm(join(work, "transforms.txt"), { force: true });
    try { await rename(work, folder); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      await rm(work, { recursive: true, force: true });
    }
    return { file: join(folder, "stabilized.mp4"), info, cached: false };
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
