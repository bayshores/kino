// The sound of a clip on a time map (engine/mediaTime.js): a video or audio layer with a speed or
// played backwards. Before the mix, each such clip's part of the file is made into a WAV that
// already plays on the scene's clock, so the mix (export.mjs audioMixGraph) places it like any
// other clip, from offset 0. Exports and the dashboard's mix (GET /api/dashboard/mix) both get
// their clips from export.mjs soundClipMaker, so they hear the same thing.
//
// How the sound is made:
//   constant speed, mediaPitch "keep" (the default)  FFmpeg's atempo: the same pitch, faster or
//                                                    slower (chained, as one atempo goes from 0.5×)
//   constant speed, mediaPitch "follow"              FFmpeg's asetrate + aresample: like a tape
//                                                    or record, faster is higher
//   a Speed animation (a ramp)                       read here, sample by sample, along the time
//                                                    map: always tape-style, so pitch follows speed
// mediaReverse plays the part backwards in all three (FFmpeg's areverse, or reading backwards).
// The result is exactly as many samples as the clip lasts on the scene, so the mix keeps its length.
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { ffmpegCommand } from "./media-probe.mjs";
import { runExportProcess as runProcess } from "./export-process.mjs";
import { animatesSpeed, speedAnimations } from "../engine/animation.js";
import { constantSpeed, isReversed, mediaPitchOf } from "../engine/mediaTime.js";
import { mediaSoundTime } from "../engine/playback.js";

// Room read on each side of the part, so the first and last samples have neighbours.
const READ_MARGIN = 0.05;
// A ramp's sound is made this many samples at a time (0.68 s at 48 kHz). The file is read at its
// own rate as FFmpeg decodes it, and only the stretch of it the next samples need is kept, so a
// ramp over any length of file holds a few MB of sound, not the whole part.
const BLOCK = 32_768;
// The time map is smooth, so it is looked up every STEP samples (1/3 ms at 48 kHz) and drawn
// straight in between.
const STEP = 16;
// File samples kept before the stretch a block reads, in case the next block starts a little
// behind it (a box filter that widens where the speed jumps).
const KEEP_BEHIND = 4096;

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** FFmpeg atempo filters for `speed` (one atempo goes from 0.5 to 100, so slower speeds chain). */
export function atempoChain(speed) {
  const stages = [];
  let left = speed;
  while (left < 0.5 - 1e-9) { stages.push(0.5); left /= 0.5; }
  while (left > 100 + 1e-9) { stages.push(100); left /= 100; }
  if (Math.abs(left - 1) > 1e-9 || !stages.length) stages.push(left);
  return stages.map((value) => `atempo=${round6(value)}`).join(",");
}

/** What decides a clip's sound on the time map, as text (the dashboard's mix cache uses it). */
export function soundTiming(layer) {
  return JSON.stringify([layer.mediaStart ?? 0, layer.mediaOffset ?? 0, layer.mediaDuration ?? null, layer.mediaSourceDuration ?? null,
    layer.mediaFreeze ?? null, constantSpeed(layer), isReversed(layer), mediaPitchOf(layer), speedAnimations(layer)]);
}

/** The 44-byte header of a 32-bit float WAV file of `sampleCount` interleaved samples. */
function floatWavHeader(sampleCount, channels, sampleRate) {
  const header = Buffer.alloc(44);
  const bytes = sampleCount * 4;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

/** The stretch of the file the clip's part plays: {from, to} in file seconds. */
function fileSpan(layer, clip) {
  const [first, last] = [mediaSoundTime(layer, clip.start), mediaSoundTime(layer, clip.start + clip.duration)];
  return { from: Math.min(first, last), to: Math.max(first, last) };
}

/**
 * Constant speed: FFmpeg cuts the part, plays it backwards when the layer is reversed, and changes
 * its speed (atempo keeps the pitch; asetrate + aresample lets it follow), padded or cut to
 * exactly `frames` samples.
 */
async function constantSound(layer, clip, { path, output, sampleRate, frames, signal }) {
  const speed = constantSpeed(layer);
  const { from, to } = fileSpan(layer, clip);
  const change = speed === 1 ? [] : mediaPitchOf(layer) === "keep"
    ? [atempoChain(speed)]
    : [`asetrate=${Math.max(1, Math.round(sampleRate * speed))}`, `aresample=${sampleRate}`];
  const filters = [
    `atrim=start=${round6(from)}:end=${round6(to)}`, "asetpts=PTS-STARTPTS",
    ...(isReversed(layer) ? ["areverse"] : []),
    ...change,
    `apad=whole_len=${frames}`, `atrim=end_sample=${frames}`,
  ];
  await runProcess(ffmpegCommand(), ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", path, "-map", "0:a:0",
    "-af", filters.join(","), "-ar", String(sampleRate), "-ac", String(clip.channels), "-c:a", "pcm_f32le", "-f", "wav", output], signal);
}

function canceled() {
  const error = new Error("Export was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * The sound FFmpeg decodes with `args` (32-bit float samples, `channels` interleaved, on its
 * stdout), read only as far as asked. `ensure(frame)` reads until that sample is in memory or the
 * sound ends; `drop(frame)` lets go of the samples before it. `samples` holds `count` samples
 * from sample number `start`. `close()` stops FFmpeg if it is still writing and reports a
 * failure; cancelling `signal` stops it too.
 */
function decodedSound(args, channels, signal) {
  if (signal?.aborted) throw canceled();
  const child = spawn(ffmpegCommand(), args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stderr = "", killTimer;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-12000); });
  const closed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, terminatingSignal) => resolve({ code, terminatingSignal }));
  });
  const stop = () => {
    child.stdout.destroy();
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const reader = child.stdout[Symbol.asyncIterator]();
  const frameBytes = channels * 4;
  let leftover = Buffer.alloc(0); // the bytes of a sample FFmpeg has not finished writing
  const sound = { samples: new Float32Array(channels * BLOCK * 4), start: 0, count: 0, ended: false, closed: false };

  function append(chunk) {
    const bytes = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const whole = Math.floor(bytes.length / frameBytes);
    leftover = Buffer.from(bytes.subarray(whole * frameBytes));
    if (!whole) return;
    const used = sound.count * channels;
    if (used + whole * channels > sound.samples.length) {
      const bigger = new Float32Array(Math.max(sound.samples.length * 2, used + whole * channels));
      bigger.set(sound.samples.subarray(0, used));
      sound.samples = bigger;
    }
    new Uint8Array(sound.samples.buffer, used * 4, whole * frameBytes).set(bytes.subarray(0, whole * frameBytes));
    sound.count += whole;
  }

  sound.ensure = async (frame) => {
    while (!sound.ended && sound.start + sound.count <= frame) {
      let next;
      try { next = await reader.next(); }
      catch (error) { throw signal?.aborted ? canceled() : error; }
      if (signal?.aborted) throw canceled();
      if (next.done) sound.ended = true;
      else append(next.value);
    }
  };
  sound.drop = (frame) => {
    const cut = Math.min(Math.floor(frame) - sound.start, sound.count);
    if (cut <= 0) return;
    sound.samples.copyWithin(0, cut * channels, sound.count * channels);
    sound.start += cut;
    sound.count -= cut;
  };
  sound.close = async () => {
    if (sound.closed) return;
    sound.closed = true;
    const finished = sound.ended;
    if (!finished) stop(); // every sample needed is made; the rest of the margin is not
    const result = await closed;
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
    if (signal?.aborted) throw canceled();
    if (result.error) throw result.error;
    if (finished && result.code !== 0)
      throw new Error(`${basename(ffmpegCommand())} failed with exit code ${result.code ?? result.terminatingSignal}: ${stderr.trim() || "no diagnostic output"}`);
  };
  return sound;
}

/**
 * A Speed animation: each output sample is the file at the time the time map gives for it
 * (linear interpolation between file samples, read at the file's own rate). Where the clip plays
 * faster than 1.25×, several neighbouring samples are averaged (a box filter as wide as the
 * speed), so a fast stretch does not alias into a whistle. The output is made BLOCK samples at a
 * time in the order that reads the file forwards (the last block first for a reversed clip), each
 * block written to its place in the WAV, and the file is read only as far as each block needs.
 */
async function rampSound(layer, clip, { path, output, sampleRate, frames, signal }) {
  const { from, to } = fileSpan(layer, clip);
  const readFrom = Math.max(0, from - READ_MARGIN);
  const channels = clip.channels;
  // Where output sample `frame` reads the file, in file samples from readFrom.
  const positionAt = (frame) => (mediaSoundTime(layer, clip.start + frame / sampleRate) - readFrom) * sampleRate;
  const backwards = positionAt(frames) < positionAt(0);
  // positions[i] is where output sample b0 - 1 + i reads (b0 is the block's first sample);
  // widths[i] how many file samples sample b0 + i moves past, the width to average over.
  const positions = new Float64Array(BLOCK + 1);
  const widths = new Float64Array(BLOCK);
  const out = new Float32Array(BLOCK * channels);
  const outBytes = new Uint8Array(out.buffer);
  const sound = decodedSound(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", path, "-map", "0:a:0",
    "-af", `atrim=start=${round6(readFrom)}:end=${round6(to + READ_MARGIN)},asetpts=PTS-STARTPTS`,
    "-ar", String(sampleRate), "-ac", String(channels), "-f", "f32le", "pipe:1"], channels, signal);
  let file;
  try {
    file = await open(output, "w", 0o600);
    await file.write(floatWavHeader(frames * channels, channels, sampleRate), 0, 44, 0);
    const blocks = Math.ceil(frames / BLOCK);
    for (let n = 0; n < blocks; n += 1) {
      const b0 = (backwards ? blocks - 1 - n : n) * BLOCK;
      const b1 = Math.min(frames, b0 + BLOCK);
      // The time map every STEP samples, straight in between (the same positions whichever block
      // comes first).
      let step = Math.floor(Math.max(0, b0 - 1) / STEP);
      let [stepFrom, stepTo] = [positionAt(step * STEP), positionAt((step + 1) * STEP)];
      for (let frame = Math.max(0, b0 - 1); frame < b1; frame += 1) {
        if (frame >= (step + 1) * STEP) [step, stepFrom, stepTo] = [step + 1, stepTo, positionAt((step + 2) * STEP)];
        positions[frame - b0 + 1] = stepFrom + (stepTo - stepFrom) * ((frame - step * STEP) / STEP);
      }
      let [low, high] = [Infinity, -Infinity];
      for (let frame = b0; frame < b1; frame += 1) {
        const position = positions[frame - b0 + 1];
        const width = frame === 0 ? 1 : Math.abs(position - positions[frame - b0]);
        widths[frame - b0] = width;
        const reach = width > 1.25 ? width / 2 : 0;
        low = Math.min(low, position - reach);
        high = Math.max(high, position + reach);
      }
      await sound.ensure(Math.ceil(high) + 1);
      sound.drop(Math.floor(low) - KEEP_BEHIND);
      const { samples, start, count } = sound;
      const sampleAt = (position, channel) => {
        const local = position - start;
        if (local <= 0) return count ? samples[channel] : 0;
        const before = Math.floor(local);
        if (before >= count - 1) return count ? samples[(count - 1) * channels + channel] : 0;
        const part = local - before;
        return samples[before * channels + channel] * (1 - part) + samples[(before + 1) * channels + channel] * part;
      };
      for (let frame = b0; frame < b1; frame += 1) {
        const position = positions[frame - b0 + 1];
        const width = widths[frame - b0];
        const taps = width > 1.25 ? Math.min(64, Math.ceil(width)) : 1;
        const at = (frame - b0) * channels;
        for (let channel = 0; channel < channels; channel += 1) {
          if (taps === 1) { out[at + channel] = sampleAt(position, channel); continue; }
          let sum = 0;
          for (let tap = 0; tap < taps; tap += 1) sum += sampleAt(position + (tap - (taps - 1) / 2) * (width / taps), channel);
          out[at + channel] = sum / taps;
        }
      }
      await file.write(outBytes, 0, (b1 - b0) * channels * 4, 44 + b0 * channels * 4);
    }
    await sound.close();
  } finally {
    await sound.close().catch(() => {});
    await file?.close();
  }
}

/**
 * Makes a clip on a time map (clip.remapped, from playback.js mediaPlaybackRange or videoSound.js
 * audibleRanges) into a WAV in `directory` that plays on the scene's clock, and returns the clip
 * that mixes it: the same start, duration and volume, offset 0, and `source` naming the file and
 * timing it came from. `index` keeps the files of several clips apart.
 */
export async function remappedSoundClip(layer, clip, { directory, index, sampleRate, signal }) {
  const frames = Math.max(1, Math.round(clip.duration * sampleRate));
  const output = join(directory, `speed-${index}.wav`);
  const options = { path: clip.path, output, sampleRate, frames, directory, index, signal };
  if (animatesSpeed(layer)) await rampSound(layer, clip, options);
  else await constantSound(layer, clip, options);
  const { remapped, ...rest } = clip;
  return { ...rest, path: output, offset: 0, source: { path: clip.path, offset: clip.offset, timing: soundTiming(layer) } };
}
