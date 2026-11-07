// What compose needs to know about a clip before it cuts it (compose {footage}, engine/footage/):
// where the faces are, how much moves, where text is on screen and how bright each moment is,
// measured on this computer and kept beside the file as a .footage-v1 file, so a clip is measured
// once. Sound files get their loudness instead.
//
// How a video is measured:
//   1. FFmpeg decodes it at 4 frames a second, at most 480 pixels on the long side (never the
//      full size: a 4K clip costs the same as a 1080p one).
//   2. kino works out each frame's brightness and how much it differs from the frame before.
//   3. The kino-measure helper (backend/measure/kino-measure.swift, Apple Vision) gets each frame
//      with jobs: optical flow every frame (motion), faces and text twice a second.
// Without the helper (not a Mac, or KINO_MEASURE_HELPER=none) faces and text are null (unknown)
// and motion comes from the frame differences.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { ffmpegCommand } from "../media-probe.mjs";
import { endWithService } from "../child-exit.mjs";
import { helperSession, measureAbilities, measureSize } from "../measure/measure.mjs";
import { decodeMono } from "../audio-analysis.mjs";
import { energyFrames, silenceLevel } from "../speech/transcribe.mjs";
import { round as round3 } from "../../engine/numbers.js";

export const FOOTAGE_VERSION = 1;
export const FOOTAGE_FPS = 4;
const SIDE = 480;
// The helper's job bits (kino-measure.swift): 1 flow, 2 text, 16 faces.
const FLOW = 1, TEXT = 2, FACES = 16;

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
 * Measures a video file. Resolves to {version, duration, width, height, fps, vision, samples:[{t,
 * luma, change, motion, faces, text}]}: faces [[x, y, w, h]] and text [{box, s}] in fractions of
 * the frame (null when not measured at that frame or not on this computer), motion in frame
 * widths a second (null without the helper), change the mean brightness difference to the frame
 * before (0 to 1).
 */
export async function measureFootage(file, { width, height, duration, signal } = {}) {
  const size = measureSize(width, height, SIDE);
  const abilities = await measureAbilities();
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
      if (index % 2 === 0) jobs |= TEXT | FACES;
      await session.send(jobs, current);
      current = Buffer.alloc(frameBytes); filled = 0;
    }
  }
  const code = decode.exitCode ?? await new Promise((resolve) => decode.once("close", resolve));
  if (code !== 0 && !samples.length) throw new Error(`FFmpeg could not decode the video: ${decodeError.trim().split("\n").at(-1) || `exit ${code}`}`);
  const { answers, error } = await session.finish();
  let faces = false, text = false;
  samples.forEach((sample, index) => {
    const answer = answers[index] ?? {};
    const speed = flowSpeed(answer.flow, size.width);
    sample.motion = speed === null ? null : round3(speed);
    if (Array.isArray(answer.faces)) { sample.faces = answer.faces; faces = true; }
    if (Array.isArray(answer.text)) { sample.text = answer.text.filter((line) => line.c >= 0.3).map((line) => ({ box: line.box, s: String(line.s).slice(0, 80) })); text = true; }
  });
  return {
    version: FOOTAGE_VERSION, duration: round3(duration || samples.length / FOOTAGE_FPS), width, height, fps: FOOTAGE_FPS,
    vision: { faces, text, flow: samples.some((sample) => sample.motion !== null), ...(error ? { error } : {}) },
    samples,
  };
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
  return { version: FOOTAGE_VERSION, loud: Math.round((count ? sum / count : -60) * 10) / 10, curve };
}

/** Measures each file once and keeps the answer beside it (`.footage-v1`, `.loudness-v1`). */
export function createFootageCache({ measureVideo = measureFootage, measureSound = measureLoudness } = {}) {
  const pending = new Map();
  async function readOrMake(sidecar, make) {
    try {
      const saved = JSON.parse(await readFile(sidecar, "utf8"));
      if (saved?.version === FOOTAGE_VERSION) return saved;
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
  const once = (key, make) => {
    if (!pending.has(key)) pending.set(key, readOrMake(key, make).finally(() => pending.delete(key)));
    return pending.get(key);
  };
  return {
    /** The measures of a video file; `info` is {width, height, duration} from the media record. */
    video: (file, info) => once(`${file}.footage-v${FOOTAGE_VERSION}`, () => measureVideo(file, info)),
    /** The loudness of a sound (or a video's sound). */
    sound: (file) => once(`${file}.loudness-v${FOOTAGE_VERSION}`, () => measureSound(file)),
  };
}
