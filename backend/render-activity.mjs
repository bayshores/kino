// Which renders and agent calls run now, so background work waits for them. exportScene and
// renderSceneFrames (export.mjs) count themselves: agent renders, exports, looks, checks and the
// stage's frames all go through them; the agent service's call() counts each agent call.
// Background jobs (Inspire's measuring, reference_drift, the preview cache) start each heavy step
// (a download, an FFmpeg or yt-dlp run, a measure batch) only once nothing has run for QUIET_MS
// (waitForQuiet). A job that a call is waiting for passes `urgent` and goes at once.
// Work run inside inBackground() does not count, and the programs it starts (FFmpeg, yt-dlp, the
// Chromium raster workers) run at a lower priority, FFmpeg with fewer threads, so calls stay quick.
import { AsyncLocalStorage } from "node:async_hooks";
import { setPriority } from "node:os";

// Unix niceness for background programs (0 is normal, 19 the lowest).
const BACKGROUND_NICE = 15;
// FFmpeg threads for background-only work (the agent's own calls keep FFmpeg's default).
export const BACKGROUND_THREADS = 2;
// Background work starts its next heavy step this long after the last render or call (ms).
export const QUIET_MS = 1000;
// The longest a background step waits for quiet (ms): a busy agent slows background work but never
// stops it for good.
export const MAX_WAIT_MS = 60_000;
const background = new AsyncLocalStorage();
const listeners = new Set();
let running = 0;
let calls = 0;
// When a render or call last started or ended (ms since 1970).
let lastBusyAt = 0;

function heard(kind) {
  lastBusyAt = Date.now();
  for (const listener of listeners) listener(kind);
}

function counter(kinds, add) {
  add(1);
  heard(kinds[0]);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    add(-1);
    heard(kinds[1]);
  };
}

/** Counts a render as running until the returned function is called; listeners hear "start" and "end". */
export function renderStarted() {
  return counter(["start", "end"], (step) => { running += step; });
}

export function rendersRunning() {
  return running;
}

/** Counts an agent call as running until the returned function is called; listeners hear "call-start" and "call-end". */
export function callStarted() {
  return counter(["call-start", "call-end"], (step) => { calls += step; });
}

export function callsRunning() {
  return calls;
}

/** Calls `listener(kind)` as renders ("start", "end") and calls ("call-start", "call-end") come and go; returns a function that stops it. */
export function onRenderActivity(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Resolves once no render or agent call has run for `quietMs`, at once while `urgent()` is true
 * (a call is waiting for this job), or after `maxWaitMs` at the latest. Rejects with an AbortError
 * when `signal` aborts.
 */
export async function waitForQuiet({ urgent = () => false, signal, quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS } = {}) {
  const giveUpAt = Date.now() + maxWaitMs;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error("Background work was stopped."), { name: "AbortError" });
    if (urgent()) return;
    const left = Math.min(running + calls > 0 ? quietMs : lastBusyAt + quietMs - Date.now(), giveUpAt - Date.now());
    if (left <= 0) return;
    // Looked at again at least every quarter second, so a job that turns urgent goes soon.
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 250)));
  }
}

/**
 * One heavy step of a background job: it waits for quiet (waitForQuiet), then runs `work` as
 * background work. An urgent step runs at once, at normal priority with all threads.
 */
export async function backgroundStep(work, options = {}) {
  await waitForQuiet(options);
  return options.urgent?.() ? work() : inBackground(work);
}

/** Runs `work` as background work: its renders do not count, and its programs run at low priority. */
export function inBackground(work) {
  return background.run(true, work);
}

export function isBackground() {
  return background.getStore() === true;
}

/** FFmpeg's arguments, with BACKGROUND_THREADS decode and filter threads when background work runs it. */
export function ffmpegArgs(args) {
  if (!isBackground() || args.includes("-threads")) return args;
  return ["-threads", String(BACKGROUND_THREADS), "-filter_threads", String(BACKGROUND_THREADS), ...args];
}

/** Lowers a just-started program's priority when it was started by background work. */
export function lowerIfBackground(child) {
  if (!isBackground() || !child?.pid) return;
  try { setPriority(child.pid, BACKGROUND_NICE); } catch { /* It ended already, or this system refuses. */ }
}
