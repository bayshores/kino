// A stand-in for whisper.cpp's whisper-cli, for tests that cannot ship a speech model. It "hears"
// test tones instead of speech: each tone of 50 ms or more in a chunk file is one word, and its
// pitch says which (300 + 40·k Hz is word k of the JSON list in FAKE_WHISPER_WORDS). A tone whose
// pitch is no word on the list is not written down, as whisper leaves out a mumble. It answers
// what whisper-cli -ojf --dtw writes: <file>.json with tokens, their offsets (ms) and DTW times
// (centiseconds, 0.14 s late as whisper's are, which kino corrects).
//
// writeFakeWhisper(folder) writes it into a folder as an executable, so a server
// started with KINO_WHISPER_CLI pointing at it runs the real transcription path.
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

export const FAKE_WHISPER_SOURCE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const words = JSON.parse(process.env.FAKE_WHISPER_WORDS || "[]");
const files = process.argv.slice(2).filter((arg) => arg.endsWith(".wav"));
if (!process.argv.includes("-m")) { console.error("no model"); process.exit(2); }
// -dl (detect the language only): FAKE_WHISPER_LANG ("ja 0.9") in the JSON and the log line.
if (process.argv.includes("-dl")) {
  const [language, p] = (process.env.FAKE_WHISPER_LANG || "en 0.99").split(" ");
  console.error("whisper_full_with_state: auto-detected language: " + language + " (p = " + p + ")");
  for (const file of files) writeFileSync(file + ".json", JSON.stringify({ result: { language }, transcription: [] }));
  process.exit(0);
}
// -tr (whisper's English): one segment per file, FAKE_WHISPER_ENGLISH, over the whole file.
if (process.argv.includes("-tr")) {
  for (const file of files) {
    const seconds = (readFileSync(file).length - 44) / 2 / 16000;
    writeFileSync(file + ".json", JSON.stringify({ transcription: [{ offsets: { from: 0, to: Math.round(seconds * 1000) }, text: " " + (process.env.FAKE_WHISPER_ENGLISH || ""), tokens: [] }] }));
  }
  process.exit(0);
}
for (const file of files) {
  const data = readFileSync(file);
  const rate = data.readUInt32LE(24);
  const samples = new Float32Array((data.length - 44) / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(44 + i * 2) / 32768;
  const frame = Math.round(rate / 100);
  const loud = [];
  for (let at = 0; at + frame <= samples.length; at += frame) {
    let sum = 0;
    for (let i = at; i < at + frame; i += 1) sum += samples[i] * samples[i];
    loud.push(Math.sqrt(sum / frame) > 0.01);
  }
  const runs = [];
  for (let i = 0; i < loud.length; i += 1) {
    if (!loud[i]) continue;
    const last = runs.at(-1);
    if (last && i - last.end <= 3) last.end = i + 1;
    else runs.push({ start: i, end: i + 1 });
  }
  const tokens = [{ text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 1 }];
  for (const run of runs) {
    if (run.end - run.start < 5) continue;
    let crossings = 0;
    const from = run.start * frame + frame, to = run.end * frame - frame;
    for (let i = from + 1; i < to; i += 1) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings += 1;
    const hz = crossings / 2 / ((to - from) / rate);
    const k = Math.round((hz - 300) / 40);
    if (k < 0 || k >= words.length) continue;
    const start = run.start / 100, end = run.end / 100;
    tokens.push({ text: " " + words[k], offsets: { from: Math.round(start * 1000), to: Math.round(end * 1000) }, t_dtw: Math.round((start + 0.14) * 100), p: 0.9 });
  }
  writeFileSync(file + ".json", JSON.stringify({ transcription: [{ tokens }] }));
}
`;

/** The pitch (Hz) of word `index` for the stand-in. */
export const wordPitch = (index) => 300 + 40 * index;

/**
 * Writes the stand-in as <folder>/whisper-cli and a dummy model <folder>/ggml-small.en.bin;
 * answers the server env that uses them.
 */
export async function writeFakeWhisper(folder, words) {
  const command = path.join(folder, "whisper-cli");
  const model = path.join(folder, "ggml-small.en.bin");
  await writeFile(command, FAKE_WHISPER_SOURCE);
  await chmod(command, 0o755);
  await writeFile(model, "not a real model");
  return { KINO_WHISPER_CLI: command, KINO_WHISPER_MODEL: model, FAKE_WHISPER_WORDS: JSON.stringify(words) };
}

/**
 * 48 kHz samples: each [index, start, end] is a tone for word `index` (seconds), with 5 ms ramps,
 * over very quiet noise.
 */
export function toneWords(parts, duration, rate = 48_000) {
  const samples = new Float32Array(Math.round(duration * rate));
  let seed = 7;
  for (let i = 0; i < samples.length; i += 1) { seed = (seed * 1103515245 + 12345) % 2147483648; samples[i] = (seed / 2147483648 - 0.5) * 2e-4; }
  for (const [index, start, end] of parts) {
    const hz = wordPitch(index);
    for (let i = Math.round(start * rate); i < Math.round(end * rate); i += 1) {
      const t = i / rate;
      const ramp = Math.min(1, (t - start) / 0.005, (end - t) / 0.005);
      samples[i] += 0.3 * ramp * Math.sin(2 * Math.PI * hz * (t - start));
    }
  }
  return samples;
}
