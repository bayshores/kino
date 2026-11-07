// How many Chromium raster workers an export draws its frames with (backend/chromium-raster.mjs).
//
// One, unless the dashboard's "frames at once" (compute.framesAtOnce) or KINO_RASTER_WORKERS asks
// for more: several workers do not yet give exactly the pixels of one on every scene
// (chromium-raster.mjs createPool says where they differ).
// More workers draw more frames at the same time, but each one is a whole Electron app (a main
// process, a GPU process and a page renderer), so the count is the smallest of:
// - KINO_RASTER_WORKERS, when it is set to a whole number; else "frames at once": a number from 1
//   to MAX_RASTER_WORKERS, or "auto" for MAX_RASTER_WORKERS (1 when neither is given);
// - half the processor cores (cores / 2, at most 8);
// - the memory free now, less the share of all memory kept free for everything else (the
//   dashboard's "memory to leave free", compute.keepFreePercent: a fifth unless it says), divided by
//   what one worker uses at the export's size (workerMemoryMB). A fixed share of all memory would
//   ignore what other apps already use, so kino reads what is free now;
// - one worker for every MIN_FRAMES_PER_WORKER frames (starting a worker costs about a second);
// - MAX_RASTER_WORKERS.
// Workers that other exports run, or have chosen to start (claimRasterWorkers), already count
// against the cores, the memory and MAX_RASTER_WORKERS (kino runs two exports at once). Their
// memory is taken off even though the free memory may already show it: a worker that is still
// starting has not used it yet, and counting it twice errs toward fewer workers. An export claims
// its count in the same step as it chooses it (export.mjs), so two exports that start together do
// not both choose as if the other were not there.
import os from "node:os";
import { execFileSync } from "node:child_process";
import { MAX_RASTER_WORKERS, rasterWorkersRunning } from "./chromium-raster.mjs";

// What one worker's processes (Electron's main process, GPU process, page renderer and helper)
// used together at most, as macOS memory footprint (the number Activity Monitor shows), rounded up
// to the next 100 MB. Measured on 2026-10-20 with the agent's final render (motion blur 0.5,
// dither) of a 24 s, 1080x1920 project whose video sits in one 5837x3168 group with about 60
// effects: 1547 MB with one worker, 1560 MB a worker with four (6240 MB in all), both near frame
// 623. Drawn without the GPU (KINO_RASTER_GPU=off) a worker used at most 943 MB over 0 to 12 s.
export const WORKER_MEMORY_MB = 1600;
// What a worker uses more for each further 1080x1920 pixels of output. The same render at 4K
// (2160x3840, four times the pixels) used 7630 MB for two workers at once, 3815 MB a worker (near
// frame 577 of 630); at 1080x1920 two workers used 3037 MB, 1519 MB a worker. So a worker grew by
// (3815 - 1519) / 3 = 765 MB for each further 1080x1920 pixels: 1600 MB plus 800 MB for each is
// 4000 MB at 4K.
export const WORKER_MEMORY_MB_PER_FRAME = 800;
const FRAME_PIXELS = 1080 * 1920;
export const MIN_FRAMES_PER_WORKER = 30;
// The share of all memory left free for the rest of the computer (percent), unless the dashboard
// says another, and the shares it may say.
export const KEEP_FREE_PERCENT = 20;
const KEEP_FREE_RANGE = [5, 60];

// The KINO_RASTER_WORKERS setting: a whole number from 1, or null when it is not set (or not valid).
export function workerCap(env = process.env) {
  const text = env.KINO_RASTER_WORKERS;
  if (typeof text !== "string" || !/^\s*\d+\s*$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 ? value : null;
}

// Memory free now, in MB. macOS gives most of its free memory to the file cache and counts it as
// used (os.freemem() is far too small there), so on a Mac this reads the share the system itself
// calls free (kern.memorystatus_level, the "free percentage" memory_pressure prints). On Linux and
// Windows os.freemem() already gives the memory available to new programs.
export function freeMemoryMB({ platform = process.platform, total = os.totalmem(), free = os.freemem(), level } = {}) {
  if (platform === "darwin") {
    level ??= macFreePercent();
    if (Number.isFinite(level) && level >= 0 && level <= 100) return (total * level) / 100 / 1048576;
  }
  return free / 1048576;
}

function macFreePercent() {
  try { return Number(execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 }).trim()); }
  catch { return Number.NaN; }
}

// What one worker uses (MB) to draw frames of width x height: WORKER_MEMORY_MB up to 1080x1920
// pixels (smaller frames were not measured, so they count as much), and WORKER_MEMORY_MB_PER_FRAME
// more for each further 1080x1920 pixels.
export function workerMemoryMB(width, height) {
  const pixels = Number.isFinite(width * height) ? width * height : 0;
  return WORKER_MEMORY_MB + Math.max(0, pixels / FRAME_PIXELS - 1) * WORKER_MEMORY_MB_PER_FRAME;
}

// The most workers "frames at once" allows: a whole number from 1 to MAX_RASTER_WORKERS, "auto"
// for MAX_RASTER_WORKERS, or 1 for anything else (or nothing).
export function framesAtOnceCap(framesAtOnce) {
  if (framesAtOnce === "auto") return MAX_RASTER_WORKERS;
  return Number.isSafeInteger(framesAtOnce) && framesAtOnce >= 1 ? Math.min(framesAtOnce, MAX_RASTER_WORKERS) : 1;
}

// The share of memory to leave free as a fraction: a whole percent from 5 to 60, else 20.
function keepFreeShare(percent) {
  const valid = Number.isSafeInteger(percent) && percent >= KEEP_FREE_RANGE[0] && percent <= KEEP_FREE_RANGE[1];
  return (valid ? percent : KEEP_FREE_PERCENT) / 100;
}

/**
 * How many raster workers to draw `frames` frames of `width` x `height` with (1 to
 * MAX_RASTER_WORKERS). `framesAtOnce` and `keepFreePercent` are the dashboard's machine settings
 * (export.mjs takes them from exportScene's context.render).
 */
export function chooseRasterWorkers({
  frames,
  width = 0,
  height = 0,
  framesAtOnce = 1,
  keepFreePercent = KEEP_FREE_PERCENT,
  env = process.env,
  cpus = os.availableParallelism(),
  totalMB = os.totalmem() / 1048576,
  freeMB = freeMemoryMB(),
  running = rasterWorkersRunning(),
} = {}) {
  const limits = [
    workerCap(env) ?? framesAtOnceCap(framesAtOnce),
    Math.floor(cpus / 2) - running,
    Math.floor((freeMB - totalMB * keepFreeShare(keepFreePercent)) / workerMemoryMB(width, height)) - running,
    Math.ceil(frames / MIN_FRAMES_PER_WORKER),
    MAX_RASTER_WORKERS - running,
  ];
  return Math.max(1, Math.min(...limits.map((value) => Number.isFinite(value) ? value : 1)));
}
