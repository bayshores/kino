// What compose needs to know about a clip before it cuts it (compose {footage}, engine/footage/):
// where the faces are, how much moves, where text is on screen and how bright each moment is,
// measured on this computer and kept beside the file as a .footage-v2 file, so a clip is measured
// once. Sound files get their loudness instead (.loudness-v1).
//
// How a video is measured:
//   1. FFmpeg decodes it at 4 frames a second, at most 480 pixels on the long side (never the
//      full size: a 4K clip costs the same as a 1080p one).
//   2. kino works out each frame's brightness and how much it differs from the frame before.
//   3. The kino-measure helper (backend/measure/kino-measure.swift, Apple Vision) gets each frame
//      with jobs: optical flow every frame (motion), faces and text twice a second.
//   4. A tiny gray copy of every frame finds the biggest changes; around them (and 3 spread
//      moments) FFmpeg decodes short windows at the clip's own rate, 480 px, and
//      footage/events.mjs finds impacts, light and motion (with direction) at the frame, and how
//      many frames each drawing is held.
// Without the helper (not a Mac, or KINO_MEASURE_HELPER=none) faces and text are null (unknown)
// and motion comes from the frame differences. Version 2 added the events: clips measured before
// are measured again once.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { ffmpegCommand, probeFrameRate } from "../media-probe.mjs";
import { eventWindows, footageEvents, reduceGray } from "./events.mjs";
import { endWithService } from "../child-exit.mjs";
import { helperSession, measureAbilities, measureSize } from "../measure/measure.mjs";
import { decodeMono } from "../audio-analysis.mjs";
import { energyFrames, silenceLevel } from "../speech/transcribe.mjs";
import { round as round3 } from "../../engine/numbers.js";
import { heavyDecodeSlot } from "../process-slots.mjs";

export const FOOTAGE_VERSION = 2;
export const LOUDNESS_VERSION = 1;
export const FOOTAGE_FPS = 4;
const SIDE = 480;
// The helper's job bits (kino-measure.swift): 1 flow, 2 text, 8 saliency, 16 faces, 32 people.
const FLOW = 1, TEXT = 2, SALIENCY = 8, FACES = 16, PEOPLE = 32;

/** Average brightness (0 to 1) and a small gray copy of a BGRA frame, for differences. */
function frameNumbers(bgra, width, height) {
  const step = 8;
  const gray = [];
  let sum = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * 4;
      const value = (0.114 * bgra[at] + 0.587 * bgra[at + 1] + 0.299 * bgra[at + 2]) / 255;
      gray.push(value);
      sum += value;
    }
  }
  return { luma: gray.length ? sum / gray.length : 0, gray };
}

/** How fast the picture moves, in frame widths a second, from the helper's flow grid. */
function flowSpeed(flow, width) {
  if (!flow?.u?.length) return null;
  let total = 0;
  for (let index = 0; index < flow.u.length; index += 1) total += Math.hypot(flow.u[index], flow.v[index]);
  return (total / flow.u.length / width) * FOOTAGE_FPS;
}

/**
 * How fast the frame as a whole moves, in frame widths a second: the median cell of the flow grid.
 * A pan or a push moves most cells alike, so the median is near the mean; a figure moving over a
 * still background moves a few cells, so the median stays near 0.
 */
export function flowCamera(flow, width) {
  if (!flow?.u?.length) return null;
  const speeds = flow.u.map((u, index) => Math.hypot(u, flow.v[index])).sort((a, b) => a - b);
  const middle = speeds.length >> 1;
  const median = speeds.length % 2 ? speeds[middle] : (speeds[middle - 1] + speeds[middle]) / 2;
  return (median / width) * FOOTAGE_FPS;
}

/**
 * Measures a video file. Resolves to {version, duration, width, height, fps, vision, samples:[{t,
 * luma, change, motion, faces, text}]}: faces [[x, y, w, h]] and text [{box, s}] in fractions of
 * the frame (null when not measured at that frame or not on this computer), motion in frame
 * widths a second (null without the helper), change the mean brightness difference to the frame
 * before (0 to 1). Also events [{t, kind: impact|light|motion, confidence, ...}], drawing
 * ({frames, perSecond, sure} or null) and rate (the clip's frames a second): footage/events.mjs.
 * options.events false skips them (the footage finder's scan); options.subjects true adds, where
 * faces are read, saliency [[x, y, w, h]] (where the eye goes) and people [[x, y, w, h]] (each
 * whole-body box) when this computer's Vision has them, and camera (flowCamera) where motion is.
 */
export function measureFootage(file, options = {}) {
  // One video decode at a time in this process (process-slots.mjs).
  return heavyDecodeSlot(() => measureFootageNow(file, options));
}

async function measureFootageNow(file, { width, height, duration, signal, events = true, subjects = false } = {}) {
  const size = measureSize(width, height, SIDE);
  const abilities = await measureAbilities();
  // Where the eye goes (Vision saliency), with the faces, when asked and this computer can.
  const salient = subjects && abilities.saliency === true ? SALIENCY : 0;
  // Each person's whole-body box too (a figure on the stairs, not only a face), where Vision has it.
  const bodies = subjects && abilities.people === true ? PEOPLE : 0;
  const helper = abilities.flow === true || abilities.text === true ? abilities.helper : null;
  const session = helperSession(helper, { ...size, signal });
  const frameBytes = size.width * size.height * 4;
  const decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-i", file, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `fps=${FOOTAGE_FPS},scale=${size.width}:${size.height}:flags=area,format=bgra`, "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  endWithService(decode);
  let decodeError = "";
  decode.stderr.setEncoding("utf8").on("data", (chunk) => { decodeError = (decodeError + chunk).slice(-1000); });
  const samples = [];
  let previous = null;
  let current = Buffer.alloc(frameBytes), filled = 0;
  for await (const chunk of decode.stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(frameBytes - filled, chunk.length - offset);
      chunk.copy(current, filled, offset, offset + take);
      filled += take; offset += take;
      if (filled < frameBytes) continue;
      const index = samples.length;
      const numbers = frameNumbers(current, size.width, size.height);
      let change = 0;
      if (previous) {
        for (let i = 0; i < numbers.gray.length; i += 1) change += Math.abs(numbers.gray[i] - previous.gray[i]);
        change /= numbers.gray.length;
      }
      previous = numbers;
      samples.push({ t: round3(index / FOOTAGE_FPS), luma: round3(numbers.luma), change: round3(change) });
      let jobs = index > 0 ? FLOW : 0;
      if (index % 2 === 0) jobs |= TEXT | FACES | salient | bodies;
      await session.send(jobs, current);
      current = Buffer.alloc(frameBytes); filled = 0;
    }
  }
  const code = decode.exitCode ?? await new Promise((resolve) => decode.once("close", resolve));
  if (code !== 0 && !samples.length) throw new Error(`FFmpeg could not decode the video: ${decodeError.trim().split("\n").at(-1) || `exit ${code}`}`);
  const { answers, error } = await session.finish();
  let faces = false, text = false, people = false;
  samples.forEach((sample, index) => {
    const answer = answers[index] ?? {};
    const speed = flowSpeed(answer.flow, size.width);
    sample.motion = speed === null ? null : round3(speed);
    if (subjects && speed !== null) sample.camera = round3(flowCamera(answer.flow, size.width));
    if (Array.isArray(answer.faces)) { sample.faces = answer.faces; faces = true; }
    if (salient && Array.isArray(answer.saliency)) sample.saliency = answer.saliency;
    if (bodies && Array.isArray(answer.people)) { sample.people = answer.people.map((person) => person.box).filter(Array.isArray); people = true; }
    if (Array.isArray(answer.text)) { sample.text = answer.text.filter((line) => line.c >= 0.3).map((line) => ({ box: line.box, s: String(line.s).slice(0, 80) })); text = true; }
  });
  const length = duration || samples.length / FOOTAGE_FPS;
  const found = events ? await clipEvents(file, length, size, signal) : {};
  return {
    version: FOOTAGE_VERSION, duration: round3(length), width, height, fps: FOOTAGE_FPS,
    vision: { faces, text, flow: samples.some((sample) => sample.motion !== null), ...(bodies ? { people } : {}), ...(error ? { error } : {}) },
    samples, ...found,
  };
}

// The clip's events (footage/events.mjs) from short windows decoded at its own rate:
// {events, drawing, rate}, or {events: null, eventsError} when they could not be read.
async function clipEvents(file, duration, size, signal) {
  try {
    const rate = await probeFrameRate(file, { signal });
    // Every frame, tiny, finds the moments (a 1-frame flash falls between the 4 a second samples).
    // Worked out while decoding, keeping only the last 5 tiny frames: 3 numbers a frame in memory.
    const luma = [], change = [], back = [], recent = [];
    const differ = (a, b) => { let diff = 0; for (let i = 0; i < a.length; i += 1) diff += Math.abs(a[i] - b[i]); return diff / a.length / 255; };
    await decodeGray(file, 0, null, { width: 64, height: 36 }, signal, (gray) => {
      const index = luma.length;
      let sum = 0;
      for (let i = 0; i < gray.length; i += 1) sum += gray[i];
      luma.push(sum / gray.length / 255);
      change.push(recent.length ? differ(gray, recent.at(-1)) : 0);
      back.push(null);
      // back[k]: the least difference between frame k - 1 and frames k + 1 to k + 4 (recent holds index - 5 to index - 1).
      for (let k = Math.max(1, index - 4); k < index; k += 1) {
        const before = recent[recent.length - (index - (k - 1))];
        if (before) back[k] = Math.min(back[k] ?? Infinity, differ(gray, before));
      }
      recent.push(gray);
      if (recent.length > 5) recent.shift();
    });
    const windows = [];
    for (const [start, end] of eventWindows({ luma, change, back }, rate, duration)) {
      // Start on a frame: the first decoded frame is the one at or after start.
      const first = Math.ceil(start * rate - 1e-6);
      const frames = await decodeGray(file, Math.max(0, (first - 0.5) / rate), end - first / rate, size, signal);
      windows.push({ start: first / rate, fps: rate, frames });
    }
    const { events, drawing } = footageEvents(windows);
    return { events, drawing, rate: round3(rate) };
  } catch (error) {
    return { events: null, drawing: null, eventsError: String(error?.message ?? error).split("\n")[0].slice(0, 200) };
  }
}

// Gray frames of `length` seconds (null: to the end) from `start`, every frame, each kept as
// keep(gray bytes) (default: footage/events.mjs reduceGray grids); a keep that answers undefined
// keeps nothing (the scan works out its numbers as frames arrive).
async function decodeGray(file, start, length, size, signal, keep = (gray) => reduceGray(gray, size.width, size.height)) {
  const span = length === null ? [] : ["-t", String(round3(length))];
  const decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-ss", String(round3(start)), "-i", file, ...span,
    "-map", "0:V:0", "-an", "-sn", "-dn", "-fps_mode", "passthrough", "-vf", `scale=${size.width}:${size.height}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"],
  { stdio: ["ignore", "pipe", "pipe"], signal });
  endWithService(decode);
  let decodeError = "";
  decode.stderr.setEncoding("utf8").on("data", (chunk) => { decodeError = (decodeError + chunk).slice(-1000); });
  decode.on("error", () => {});
  const frameBytes = size.width * size.height;
  const frames = [];
  let current = Buffer.alloc(frameBytes), filled = 0, read = 0;
  for await (const chunk of decode.stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(frameBytes - filled, chunk.length - offset);
      chunk.copy(current, filled, offset, offset + take);
      filled += take; offset += take;
      if (filled < frameBytes) continue;
      const kept = keep(current);
      if (kept !== undefined) frames.push(kept);
      read += 1;
      current = Buffer.alloc(frameBytes); filled = 0;
    }
  }
  const code = decode.exitCode ?? await new Promise((resolve) => decode.once("close", resolve));
  if (code !== 0 && !read) throw new Error(`FFmpeg could not decode a window: ${decodeError.trim().split("\n").at(-1) || `exit ${code}`}`);
  return frames;
}

/**
 * The loudness of a sound file: {version, loud (dB of the sounding 10 ms frames, on average),
 * curve: dB every half second (for finding the louder part of a song)}.
 */
export async function measureLoudness(file) {
  const { samples } = await decodeMono(file, { sampleRate: 16_000 });
  if (!samples.length) throw new Error("The file has no sound.");
  const db = energyFrames(samples);
  const level = silenceLevel(db);
  let sum = 0, count = 0;
  for (const value of db) if (value >= level) { sum += value; count += 1; }
  const curve = [];
  for (let start = 0; start < db.length; start += 50) {
    let power = 0;
    const end = Math.min(db.length, start + 50);
    for (let frame = start; frame < end; frame += 1) power += 10 ** (db[frame] / 10);
    curve.push(Math.round(10 * Math.log10(power / Math.max(1, end - start) + 1e-10) * 10) / 10);
  }
  return { version: LOUDNESS_VERSION, loud: Math.round((count ? sum / count : -60) * 10) / 10, curve };
}

/** Measures each file once and keeps the answer beside it (`.footage-v2`, `.loudness-v1`). */
export function createFootageCache({ measureVideo = measureFootage, measureSound = measureLoudness } = {}) {
  const pending = new Map();
  async function readOrMake(sidecar, version, make) {
    try {
      const saved = JSON.parse(await readFile(sidecar, "utf8"));
      if (saved?.version === version) return saved;
    } catch { /* Missing or old answers are made again. */ }
    const result = await make();
    const temporary = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar);
    } catch { /* The answer still counts when the folder cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return result;
  }
  const once = (key, version, make) => {
    if (!pending.has(key)) pending.set(key, readOrMake(key, version, make).finally(() => pending.delete(key)));
    return pending.get(key);
  };
  return {
    /** The measures of a video file; `info` is {width, height, duration} from the media record. */
    video: (file, info) => once(`${file}.footage-v${FOOTAGE_VERSION}`, FOOTAGE_VERSION, () => measureVideo(file, info)),
    /** The loudness of a sound (or a video's sound). */
    sound: (file) => once(`${file}.loudness-v${LOUDNESS_VERSION}`, LOUDNESS_VERSION, () => measureSound(file)),
  };
}
