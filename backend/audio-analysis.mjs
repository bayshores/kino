// Beat and onset analysis of an uploaded audio or video file. FFmpeg decodes the first audio
// track to mono 22,050 Hz samples on the same timeline as the waveform (audio-peaks.mjs), and
// engine/beatDetection.js finds the beats. Results are saved next to the upload as a .beats file,
// so the same file is analysed once. Nothing leaves this computer.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { BEAT_ANALYSIS_VERSION, analyzeBeats } from "../engine/beatDetection.js";
import { ffmpegCommand } from "./media-probe.mjs";
import { lowerIfBackground } from "./render-activity.mjs";
import { MAX_TIME } from "../engine/schema.js";

export const ANALYSIS_SAMPLE_RATE = 22_050;
/** Only the first ten minutes of a file are analysed: the longest scene (MAX_TIME in engine/schema.js). */
export const MAX_ANALYSIS_SECONDS = MAX_TIME;

/** Decodes the first audio track of `filename` to mono samples. Rejects with a plain reason. */
export function decodeMono(filename, { command = ffmpegCommand(), timeoutMs = 120_000, sampleRate = ANALYSIS_SAMPLE_RATE } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-copyts", "-start_at_zero", "-i", filename,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-map_metadata", "-1",
      "-af", `aresample=${sampleRate}:async=1:first_pts=0:min_hard_comp=0.001`,
      "-t", String(MAX_ANALYSIS_SECONDS), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1",
    ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    lowerIfBackground(child);
    const chunks = [];
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(error.code === "ENOENT" ? "FFmpeg is not installed, so the sound cannot be analysed." : `FFmpeg could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error("Analysing the sound took longer than two minutes."));
      if (code !== 0) return reject(new Error(/matches no streams|does not contain any stream/i.test(stderr) ? "The file has no sound." : "FFmpeg could not decode the sound."));
      const bytes = Buffer.concat(chunks);
      const samples = new Float32Array(Math.floor(bytes.length / 4));
      for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readFloatLE(i * 4);
      resolve({ samples, sampleRate });
    });
  });
}

/** Decodes and analyses one file (no cache). */
export async function analyzeAudioFile(filename, options = {}) {
  const { samples, sampleRate } = await decodeMono(filename, options);
  if (!samples.length) throw new Error("The file has no sound.");
  return analyzeBeats(samples, sampleRate);
}

// A layer named as music ("music", "song", "soundtrack bed") is music.
const MUSIC_NAME = /\b(music|song|soundtrack|bgm|instrumental)\b/i;
// Speech gets a beat grid too: measured 2026-10-29, voices (say, a leveled app voice) scored 0.30
// to 0.58 and songs 0.71 to 0.91, so a song needs more than the grid's own 0.5 ("check it by ear").
const SONG_CONFIDENCE = 0.65;
/** A song: a tempo the beat analysis is sure of, beyond what a speaking voice reaches. */
export const steadyBeat = (beats) => Number(beats?.bpm) > 0 && Number(beats?.confidence ?? 1) >= SONG_CONFIDENCE;

/**
 * Whether the sound of `layer` (playing `file`) is music, so it is never transcribed: its name says
 * so, or its saved .beats has a steady beat. With `listen` (a full check), an audio layer with no
 * .beats yet is analyzed once by `beats` (a createBeatAnalysisCache: a few seconds, kept for
 * detect_beats and fit_music), where whisper would take half a minute or more on a song.
 */
export async function soundIsMusic(layer, file, { listen = false, beats = null } = {}) {
  if (MUSIC_NAME.test(String(layer?.name ?? ""))) return true;
  try { return steadyBeat(JSON.parse(await readFile(`${file}.beats`, "utf8"))); } catch { /* not analyzed yet */ }
  if (!listen || !beats || layer?.type !== "audio" || existsSync(`${file}.beats`)) return false;
  try { return steadyBeat(await beats.get(file)); } catch { return false; }
}

/** Analyses each file once and keeps the result in a .beats file beside it. */
export function createBeatAnalysisCache({ analyze = analyzeAudioFile } = {}) {
  const pending = new Map();
  async function readOrAnalyze(filename) {
    const sidecar = `${filename}.beats`;
    try {
      const saved = JSON.parse(await readFile(sidecar, "utf8"));
      if (saved?.version === BEAT_ANALYSIS_VERSION && Array.isArray(saved.beats)) return saved;
    } catch { /* Missing or old results are made again. */ }
    const result = await analyze(filename);
    const temporary = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar);
    } catch { /* The result still counts when the folder cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return result;
  }
  function get(filename) {
    if (!pending.has(filename)) pending.set(filename, readOrAnalyze(filename).finally(() => pending.delete(filename)));
    return pending.get(filename);
  }
  return { get };
}
