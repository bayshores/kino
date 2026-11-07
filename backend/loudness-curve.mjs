// A sound file's loudness over time, in LUFS: FFmpeg's ebur128 momentary loudness (400 ms window)
// every 0.1 s. Measured once and kept beside the file as <file>.lufs, so duck_audio, the export's
// voice leveling and the measured sound rules read the same numbers (engine/mixLevels.js).
// One measurement runs at a time; a file's curve is measured once even when asked twice.
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runExportProcess } from "./export-process.mjs";
import { ffmpegCommand } from "./media-probe.mjs";
import { heavyDecodeSlot } from "./process-slots.mjs";

export const LOUDNESS_CURVE_VERSION = 1;
const STEP = 0.1;
const round1 = (value) => Math.round(value * 10) / 10;

/** Reads ebur128's printout into {version, step, duration, momentary: [LUFS or null]}. */
export function readMomentary(printed, step = STEP) {
  const momentary = [];
  let time = 0;
  for (const line of String(printed).split("\n")) {
    const frame = line.match(/pts_time:(\S+)/);
    if (frame) time = Number(frame[1]);
    else if (line.startsWith("lavfi.r128.M=")) {
      const value = Number(line.slice("lavfi.r128.M=".length));
      // ebur128 stamps each 100 ms frame with the 400 ms window that ends where the frame ends
      // (time - 0.3 to time + 0.1), so the value belongs to the window's middle, 0.1 s earlier.
      const index = Math.max(0, Math.round((time - 0.1) / step));
      momentary[index] = Number.isFinite(value) && value > -70 ? round1(value) : null;
    }
  }
  for (let index = 0; index < momentary.length; index += 1) if (momentary[index] === undefined) momentary[index] = momentary[index - 1] ?? null;
  return { version: LOUDNESS_CURVE_VERSION, step, duration: round1(momentary.length * step), momentary };
}

/**
 * Measures a file's first sound stream (an FFmpeg job, sound only). It is a full decode, so it
 * takes the one decode slot of this process (process-slots.mjs).
 */
export async function measureLoudnessCurve(file, signal) {
  const printed = await heavyDecodeSlot(() => {
    if (signal?.aborted) throw cancelled();
    return runExportProcess(ffmpegCommand(), ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-map", "0:a:0", "-vn",
      "-af", "ebur128=metadata=1,ametadata=mode=print:file=-", "-f", "null", "-"], signal);
  });
  return readMomentary(printed);
}

// How long a file the measurement failed on (no sound, a broken file) waits before another try.
const FAILED_RETRY_MS = 10 * 60_000;

function cancelled() {
  const error = new Error("Measuring the loudness was cancelled.");
  error.name = "AbortError";
  return error;
}

const valid = (curve) => curve?.version === LOUDNESS_CURVE_VERSION && Array.isArray(curve.momentary) && curve.step > 0;

/** {get(file), saved(file)}: the curve, measured once and kept as <file>.lufs. */
export function createLoudnessCurves({ measure = measureLoudnessCurve, now = () => Date.now() } = {}) {
  const pending = new Map();
  // Files the measurement failed on: full checks ask for every sound's curve each time, and a
  // file with no sound stream would otherwise start FFmpeg on every check.
  const failed = new Map();
  let queue = Promise.resolve();
  async function saved(file) {
    try { const curve = JSON.parse(await readFile(`${file}.lufs`, "utf8")); return valid(curve) ? curve : null; } catch { return null; }
  }
  // A measurement asked by several callers runs with its own signal: one caller cancelling stops
  // only its own wait, and the measurement stops when every caller has cancelled. A caller
  // without a signal waits to the end.
  async function get(file, signal) {
    const kept = await saved(file);
    if (kept) return kept;
    const failure = failed.get(file);
    if (failure && now() - failure.at < FAILED_RETRY_MS) throw failure.error;
    let entry = pending.get(file);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      const made = { controller, waiting: 0 };
      made.job = queue.then(async () => {
        if (controller.signal.aborted) throw cancelled();
        let curve;
        try { curve = await measure(file, controller.signal); } catch (error) {
          // A cancel or a missing FFmpeg is not the file's fault: not remembered.
          if (error?.name !== "AbortError" && !controller.signal.aborted && error?.code !== "ENOENT") {
            failed.delete(file);
            failed.set(file, { error, at: now() });
            if (failed.size > 512) failed.delete(failed.keys().next().value);
          }
          throw error;
        }
        const temporary = `${file}.lufs.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(curve));
        await rename(temporary, `${file}.lufs`);
        return curve;
      }).finally(() => { if (pending.get(file) === made) pending.delete(file); });
      queue = made.job.catch(() => null);
      pending.set(file, made);
      entry = made;
    }
    entry.waiting += 1;
    if (!signal) return entry.job;
    if (signal.aborted) { leave(entry); throw cancelled(); }
    let stop;
    const stopped = new Promise((resolve, reject) => {
      stop = () => { leave(entry); reject(cancelled()); };
      signal.addEventListener("abort", stop, { once: true });
    });
    try { return await Promise.race([entry.job, stopped]); }
    finally { signal.removeEventListener("abort", stop); }
  }
  function leave(entry) {
    entry.waiting -= 1;
    if (entry.waiting === 0) entry.controller.abort();
  }
  return { get, saved };
}

/**
 * The words of the newest saved transcript beside `file` (<file>.words-<model>,
 * backend/speech/transcribe.mjs sidecarPath), or null. A song (<file>.beats with a tempo) has none.
 */
export async function savedWordsOf(file) {
  try { if (Number(JSON.parse(await readFile(`${file}.beats`, "utf8"))?.bpm) > 0) return null; } catch { /* no beats: not a song */ }
  let names;
  try { names = (await readdir(dirname(file))).filter((name) => name.startsWith(`${basename(file)}.words-`) && !name.endsWith(".tmp")); } catch { return null; }
  for (const name of names.sort().reverse()) {
    try {
      const saved = JSON.parse(await readFile(join(dirname(file), name), "utf8"));
      if (Array.isArray(saved?.words)) return saved.words;
    } catch { /* unreadable: the next one */ }
  }
  return null;
}
