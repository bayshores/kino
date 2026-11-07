import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { AUDIO_PEAK_VERSION, AUDIO_PEAKS_PER_SECOND, MAX_AUDIO_PEAKS, downsamplePeaks, normalizePeaks, validAudioPeaks } from "../engine/audioPeaks.js";
import { ffmpegCommand } from "./media-probe.mjs";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const unavailable = (reason) => ({ version: AUDIO_PEAK_VERSION, available: false, reason, duration: 0, secondsPerPeak: 1 / AUDIO_PEAKS_PER_SECOND, peaks: [] });

/** Stream PCM without retaining decoded audio. At the cap, merge pairs of complete bins. */
export function createPeakAccumulator({ sampleRate = SAMPLE_RATE, channels = CHANNELS, peaksPerSecond = AUDIO_PEAKS_PER_SECOND, maxPeaks = MAX_AUDIO_PEAKS } = {}) {
  let framesPerPeak = Math.max(1, Math.round(sampleRate / peaksPerSecond));
  let peaks = [];
  let tail = Buffer.alloc(0);
  let totalFrames = 0;
  let framesInPeak = 0;
  let peak = 0;
  const frameBytes = channels * 4;
  function write(bytes) {
    const buffer = tail.length ? Buffer.concat([tail, bytes]) : bytes;
    const end = buffer.length - buffer.length % frameBytes;
    for (let offset = 0; offset < end; offset += frameBytes) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = buffer.readFloatLE(offset + channel * 4);
        if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
      }
      totalFrames++;
      if (++framesInPeak === framesPerPeak) {
        peaks.push(peak);
        framesInPeak = 0;
        peak = 0;
        if (peaks.length >= maxPeaks) {
          peaks = downsamplePeaks(peaks, 2);
          framesPerPeak *= 2;
        }
      }
    }
    // Copy only the unfinished frame; never keep a large stdout buffer alive for its tail.
    tail = Buffer.from(buffer.subarray(end));
  }
  function finish() {
    if (!totalFrames) return unavailable("no-audio");
    const values = framesInPeak ? [...peaks, peak] : peaks;
    return {
      version: AUDIO_PEAK_VERSION, available: true,
      duration: totalFrames / sampleRate,
      secondsPerPeak: framesPerPeak / sampleRate,
      peaks: normalizePeaks(values),
    };
  }
  return { write, finish };
}

/** Read FFmpeg's float WAV header so peak bins use the source rate without another tool. */
export function createWavPeakAccumulator() {
  let header = Buffer.alloc(0);
  let accumulator;
  let invalid = false;
  function write(bytes) {
    if (invalid) return;
    if (accumulator) return accumulator.write(bytes);
    const buffer = Buffer.concat([header, bytes]);
    if (buffer.length < 12) { header = buffer; return; }
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
      invalid = true;
      return;
    }
    let format;
    for (let offset = 12; offset + 8 <= buffer.length;) {
      const kind = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (kind === "data") {
        if (!format) { invalid = true; return; }
        accumulator = createPeakAccumulator(format);
        accumulator.write(buffer.subarray(start));
        header = null;
        return;
      }
      // Metadata is stripped by the command below; bound incomplete/malformed headers.
      if (start + size > 4096) { invalid = true; return; }
      if (start + size > buffer.length) break;
      if (kind === "fmt ") {
        if (size < 16) { invalid = true; return; }
        const tag = buffer.readUInt16LE(start);
        const channels = buffer.readUInt16LE(start + 2);
        const sampleRate = buffer.readUInt32LE(start + 4);
        const bits = buffer.readUInt16LE(start + 14);
        if (![3, 0xfffe].includes(tag) || channels !== CHANNELS || !sampleRate || bits !== 32) {
          invalid = true;
          return;
        }
        format = { sampleRate, channels };
      }
      offset = start + size + (size % 2);
    }
    header = Buffer.from(buffer);
  }
  return { write, finish: () => accumulator?.finish() ?? unavailable("decode-failed") };
}

/** FFmpeg's first audio track, including video sound. Expected failures produce no diagnostics. */
export function extractAudioPeaks(filename, { command = ffmpegCommand(), timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const accumulator = createWavPeakAccumulator();
    const child = spawn(command, [
      // Rebase the container origin, not the audio track's first packet, to media time zero.
      "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-copyts", "-start_at_zero", "-i", filename,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", String(CHANNELS), "-map_metadata", "-1",
      // Fill gaps and trim negative encoder preroll while retaining the native bandwidth.
      "-af", "aresample=async=1:first_pts=0:min_hard_comp=0.001",
      "-threads", "1", "-c:a", "pcm_f32le", "-f", "wav", "pipe:1",
    ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => accumulator.write(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve(unavailable(error.code === "ENOENT" ? "missing-tool" : "decode-failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolve(accumulator.finish());
      else resolve(unavailable(/matches no streams|does not contain any stream/i.test(stderr) ? "no-audio" : "decode-failed"));
    });
  });
}

/** Versioned JSON in a .peaks sidecar, deliberately excluded from media-record *.json scans. */
export function createAudioPeaksCache({ extract = extractAudioPeaks, maxParallel = 2 } = {}) {
  const pending = new Map();
  const waiting = [];
  let active = 0;
  async function withSlot(work) {
    if (active >= maxParallel) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try { return await work(); }
    finally { active--; waiting.shift()?.(); }
  }
  async function readOrExtract(filename, metadata) {
    const sidecar = `${filename}.peaks`;
    try {
      const saved = JSON.parse(await readFile(sidecar, "utf8"));
      if (validAudioPeaks(saved.data) && (!saved.retryAt || saved.retryAt > Date.now())) return saved.data;
    } catch { /* Missing, old or incomplete caches are safe to regenerate. */ }
    let data;
    if (metadata?.hasAudio === false) data = unavailable("no-audio");
    else {
      try { data = await withSlot(() => extract(filename)); }
      catch { data = unavailable("decode-failed"); }
    }
    if (!validAudioPeaks(data)) data = unavailable("decode-failed");
    // A missing tool or failed decode can recover after a minute; immediate repeats still hit disk.
    const retryAt = !data.available && data.reason !== "no-audio" ? Date.now() + 60_000 : 0;
    const temporary = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ data, retryAt }), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar);
    } catch { /* Drawing is optional even when the cache directory cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return data;
  }
  function get(filename, metadata) {
    if (!pending.has(filename)) {
      const promise = readOrExtract(filename, metadata).finally(() => pending.delete(filename));
      pending.set(filename, promise);
    }
    return pending.get(filename);
  }
  // The saved peaks only (null when none are saved yet): never decodes.
  async function saved(filename) {
    try {
      const data = JSON.parse(await readFile(`${filename}.peaks`, "utf8")).data;
      return validAudioPeaks(data) ? data : null;
    } catch { return null; }
  }
  return { get, saved };
}
