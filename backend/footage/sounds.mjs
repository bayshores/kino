// What a clip's own sound holds besides words: a laugh, steps, a door, a thud. Measured on this
// computer with Apple's built-in sound classifier (the kino-measure helper's --sounds mode; nothing
// is downloaded) and kept beside the file as a .sounds-v1 file, so a clip is measured once.
// engine/speech.js soundEvents turns the windows into named events for the clip readout and
// keep_line {sound}.
//
// How a clip is measured: FFmpeg decodes its first sound track to mono 16 kHz float samples (at
// most DECODE_CAP seconds) straight into the helper, which answers one line per 1 s window, half
// overlapped: {t, d, top: [[label, confidence]], db}. Without the helper (not a Mac, macOS older
// than 12, no Xcode command line tools to build it, or KINO_MEASURE_HELPER=none) nothing is measured
// and the answer says why; nothing is guessed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { ffmpegCommand } from "../media-probe.mjs";
import { endWithService } from "../child-exit.mjs";
import { measureAbilities, measureHelperPath } from "../measure/measure.mjs";
import { heavyDecodeSlot } from "../process-slots.mjs";

export const SOUNDS_VERSION = 1;
const RATE = 16000;
// A guess: footage clips run seconds, a long take a few minutes; 10 minutes of 16 kHz floats is
// 38 MB in the helper. The proof (.scratch/barwave/wave/scene-sounds/RESULT.md) read clips of 1 to
// 10 s, so this cap was never reached there.
export const DECODE_CAP = 600;

/** The helper that can classify sounds, or {helper: null, why}. */
export async function soundHelper() {
  const abilities = await measureAbilities();
  if (!abilities.helper) return { helper: null, why: abilities.flow };
  if (abilities.sounds === true) return { helper: abilities.helper, why: null };
  if (abilities.sounds === false) return { helper: null, why: "the sound classifier needs macOS 12 or later" };
  // A helper built before --sounds existed: build this one from source when the tools are here.
  const built = await measureHelperPath({ fromSource: true });
  if (built && built !== abilities.helper) return { helper: built, why: null };
  return { helper: null, why: "the kino-measure helper is too old to classify sounds (npm run desktop:tools)" };
}

/** Measures a file's sound: {version, windows: [{t, d, top, db}]} or {version, unavailable: "why"}. */
export function measureSounds(file, options = {}) {
  return heavyDecodeSlot(() => measureSoundsNow(file, options));
}

async function measureSoundsNow(file, { signal } = {}) {
  const cancelled = () => Object.assign(new Error("Measuring sounds was cancelled."), { name: "AbortError" });
  if (signal?.aborted) throw cancelled();
  const { helper, why } = await soundHelper();
  if (!helper) return { version: SOUNDS_VERSION, unavailable: why };
  const decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(RATE), "-t", String(DECODE_CAP), "-f", "f32le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  endWithService(decode);
  const child = spawn(helper, ["--sounds", "--rate", String(RATE)], { stdio: ["pipe", "pipe", "pipe"] });
  endWithService(child);
  const onAbort = () => { decode.kill("SIGTERM"); child.kill("SIGTERM"); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let decodeError = "", helperError = "", out = "", bytes = 0;
  decode.stderr.setEncoding("utf8").on("data", (chunk) => { decodeError = (decodeError + chunk).slice(-1000); });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { helperError = (helperError + chunk).slice(-1000); });
  child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
  child.stdin.on("error", () => {});
  decode.stdout.on("data", (chunk) => { bytes += chunk.length; });
  decode.stdout.pipe(child.stdin);
  const ended = (proc) => new Promise((resolve) => { proc.once("error", () => resolve(-1)); proc.once("close", resolve); });
  const [decoded, classified] = await Promise.all([ended(decode), ended(child)]);
  signal?.removeEventListener("abort", onAbort);
  if (signal?.aborted) throw cancelled();
  if (decoded !== 0 && !bytes) {
    if (/matches no streams|does not contain any stream/i.test(decodeError)) return { version: SOUNDS_VERSION, windows: [] };
    throw new Error(`FFmpeg could not decode the sound: ${decodeError.trim().split("\n").at(-1) || `exit ${decoded}`}`);
  }
  if (classified !== 0) return { version: SOUNDS_VERSION, unavailable: `the kino-measure helper stopped: ${helperError.trim().split("\n").at(-1) || `exit ${classified}`}` };
  const windows = [];
  for (const line of out.split("\n")) {
    try { const window = JSON.parse(line); if (Number.isFinite(window.t) && Array.isArray(window.top)) windows.push(window); } catch { /* a blank line */ }
  }
  return { version: SOUNDS_VERSION, windows };
}

/** Measures each file's sounds once and keeps the answer beside it (.sounds-v1). */
export function createSoundsCache({ measure = measureSounds } = {}) {
  const pending = new Map();
  const sidecar = (file) => `${file}.sounds-v${SOUNDS_VERSION}`;
  async function saved(file) {
    try {
      const found = JSON.parse(await readFile(sidecar(file), "utf8"));
      return found?.version === SOUNDS_VERSION && Array.isArray(found.windows) ? found : null;
    } catch { return null; }
  }
  async function keep(file, value) {
    const temporary = `${sidecar(file)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar(file));
    } catch { /* The answer still counts when the folder cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  function get(file, options) {
    if (!pending.has(file)) pending.set(file, saved(file).then(async (found) => {
      if (found) return found;
      const result = await measure(file, options);
      // Unavailable is not kept: another computer, or a later macOS, can classify.
      if (!result.unavailable) await keep(file, result);
      return result;
    }).finally(() => pending.delete(file)));
    return pending.get(file);
  }
  return {
    /** The saved sounds answer for a file, or null (a quick look does not measure). */
    saved,
    /** The sounds answer for a file, measured now when none is saved. */
    get,
  };
}
