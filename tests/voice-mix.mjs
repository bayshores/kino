// Test sound for voice isolation: a real speech clip (tests/fixtures/voice, CC BY 4.0) mixed with
// music and hiss that are made here from a fixed seed, so every run hears the same mixture and the
// clean speech is known exactly. SI-SDR (scale-invariant signal-to-distortion ratio, in dB) says
// how close a sound is to the clean speech; isolation should raise it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ffmpegCommand } from "../backend/media-probe.mjs";

export const SAMPLE_RATE = 48000;
export const SPEECH_CLIP = fileURLToPath(new URL("./fixtures/voice/2277-149896-0005.flac", import.meta.url));

function runFfmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${stderr}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? null);
  });
}

/** Decodes any sound file to 48 kHz samples, mono unless `channels` says otherwise (interleaved). */
export async function decodeSamples(file, channels = 1) {
  const bytes = await runFfmpeg(["-i", file, "-f", "f32le", "-ac", String(channels), "-ar", String(SAMPLE_RATE), "-"]);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Writes mono or interleaved samples to a 48 kHz 32-bit float WAV file. */
export async function writeWav(file, samples, channels = 1) {
  await runFfmpeg(["-y", "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", String(channels), "-i", "-", "-c:a", "pcm_f32le", file],
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
}

function random(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function rms(samples, from = 0, to = samples.length) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/**
 * A short band at 120 beats per minute: plucked bass, a chord pad, kick, snare and hi-hat.
 * It has the parts that make music hard to tell from a voice: pitched notes in the voice's range,
 * steady harmonics and sharp drum hits.
 */
export function makeMusic(length, seed = 11) {
  const music = new Float32Array(length);
  const noise = random(seed);
  const roots = [110, 98, 87.31, 98]; // A2, G2, F2, G2, one bar each
  const chords = [[220, 261.63, 329.63], [196, 246.94, 293.66], [174.61, 220, 261.63], [196, 246.94, 293.66]];
  let previousNoise = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const bar = Math.floor(t / 2) % 4;
    const beat = Math.floor(t / 0.5);
    const sinceBeat = t - beat * 0.5;
    const sinceEighth = t - Math.floor(t / 0.25) * 0.25;
    let value = 0;
    for (let h = 1; h <= 5; h += 1) value += (0.9 * Math.sin(2 * Math.PI * roots[bar] * h * t) * Math.exp(-sinceBeat * 5)) / h;
    for (const f of chords[bar]) for (let h = 1; h <= 4; h += 1) value += (0.25 * Math.sin(2 * Math.PI * f * h * t + h)) / h;
    if (beat % 2 === 0) value += 1.6 * Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-sinceBeat * 30)) * sinceBeat) * Math.exp(-sinceBeat * 12);
    const white = noise() * 2 - 1;
    if (beat % 2 === 1) value += (0.7 * white + 0.4 * Math.sin(2 * Math.PI * 180 * sinceBeat)) * Math.exp(-sinceBeat * 20);
    value += 0.35 * (white - previousNoise) * Math.exp(-sinceEighth * 60);
    previousNoise = white;
    music[i] = value;
  }
  return music;
}

/**
 * Speech with half a second of room on each side, music 6 dB under the speech and white hiss
 * 20 dB under it, scaled so the mixture peaks at 0.9. Returns { mixture, speech, background }.
 */
export function buildMixture(speechClip, { musicDb = -6, hissDb = -20, seed = 11 } = {}) {
  const pad = Math.round(0.5 * SAMPLE_RATE);
  const length = speechClip.length + 2 * pad;
  const speech = new Float32Array(length);
  speech.set(speechClip, pad);
  const music = makeMusic(length, seed);
  const noise = random(seed + 1);
  const hiss = Float32Array.from({ length }, () => noise() * 2 - 1);
  const speechLevel = rms(speech, pad, pad + speechClip.length);
  const musicGain = (speechLevel / rms(music)) * 10 ** (musicDb / 20);
  const hissGain = (speechLevel / rms(hiss)) * 10 ** (hissDb / 20);
  const mixture = new Float32Array(length);
  const background = new Float32Array(length);
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    background[i] = musicGain * music[i] + hissGain * hiss[i];
    mixture[i] = speech[i] + background[i];
    peak = Math.max(peak, Math.abs(mixture[i]));
  }
  const scale = 0.9 / peak;
  for (let i = 0; i < length; i += 1) {
    mixture[i] *= scale;
    speech[i] *= scale;
    background[i] *= scale;
  }
  return { mixture, speech, background };
}

/** Scale-invariant signal-to-distortion ratio of `estimate` against `reference`, in dB. */
export function siSdr(reference, estimate) {
  const n = Math.min(reference.length, estimate.length);
  let referenceMean = 0, estimateMean = 0;
  for (let i = 0; i < n; i += 1) { referenceMean += reference[i]; estimateMean += estimate[i]; }
  referenceMean /= n;
  estimateMean /= n;
  let dot = 0, referenceEnergy = 0;
  for (let i = 0; i < n; i += 1) {
    dot += (estimate[i] - estimateMean) * (reference[i] - referenceMean);
    referenceEnergy += (reference[i] - referenceMean) ** 2;
  }
  const scale = dot / referenceEnergy;
  let target = 0, error = 0;
  for (let i = 0; i < n; i += 1) {
    const part = scale * (reference[i] - referenceMean);
    target += part * part;
    error += (estimate[i] - estimateMean - part) ** 2;
  }
  return 10 * Math.log10(target / error);
}
