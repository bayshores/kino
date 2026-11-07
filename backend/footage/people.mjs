// Where the people are in a clip, for the people checks (engine/quality/rules/people.js): the faces
// and each person's whole-body box, and whether the body pose found the head. Measured on this
// computer with Apple Vision (the kino-measure helper, job 16 faces and 32 people) and kept beside
// the file as a .people-v1 file, so a clip is measured once.
//
// How a video is measured:
//   1. FFmpeg decodes it at PEOPLE_FPS frames a second (fewer for a long clip, at most MAX_FRAMES
//      pictures in all), at most 480 pixels on the long side (never the full size).
//   2. The helper finds the faces and the people in each picture.
// Without the helper (not a Mac, macOS older than 12, no Xcode command line tools to build it,
// or KINO_MEASURE_HELPER=none) nothing is measured and the answer says why: the checks then say
// they did not run, and never guess.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { ffmpegCommand } from "../media-probe.mjs";
import { helperSession, measureAbilities, measureHelperPath, measureSize } from "../measure/measure.mjs";
import { round as round3 } from "../../engine/numbers.js";

export const PEOPLE_VERSION = 1;
const PEOPLE_FPS = 2;
const MAX_FRAMES = 600;
const SIDE = 480;
// The helper's job bits (kino-measure.swift): 16 faces, 32 people.
const FACES = 16, PEOPLE = 32;

/** Why people cannot be found on this computer, or null when they can (and the helper to use). */
export async function peopleHelper() {
  const abilities = await measureAbilities();
  if (!abilities.helper) return { helper: null, why: abilities.flow };
  if (abilities.people === true) return { helper: abilities.helper, why: null };
  if (abilities.people === false) return { helper: null, why: "finding people needs macOS 12 or later" };
  // A helper built before job 32 existed: build this one from source when the tools are here.
  const built = await measureHelperPath({ fromSource: true });
  if (built && built !== abilities.helper) return { helper: built, why: null };
  return { helper: null, why: "the kino-measure helper is too old to find people (npm run desktop:tools)" };
}

/**
 * Measures a video file. Resolves to {version, fps, samples: [{t, faces: [[x, y, w, h]],
 * people: [{box: [x, y, w, h], head, top}]}]} in fractions of the frame (top left origin): head is
 * how many head joints (nose, eyes, ears) the body pose found, top the highest one's y. Or to
 * {version, unavailable: "why"} when this computer cannot find people.
 */
export async function measurePeople(file, { width, height, duration, signal } = {}) {
  const { helper, why } = await peopleHelper();
  if (!helper) return { version: PEOPLE_VERSION, unavailable: why };
  const size = measureSize(width, height, SIDE);
  const fps = duration > 0 ? Math.min(PEOPLE_FPS, MAX_FRAMES / duration) : PEOPLE_FPS;
  const session = helperSession(helper, { ...size, signal });
  const frameBytes = size.width * size.height * 4;
  const decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-i", file, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `fps=${round3(fps)},scale=${size.width}:${size.height}:flags=area,format=bgra`, "-frames:v", String(MAX_FRAMES), "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  const onAbort = () => decode.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  let decodeError = "";
  decode.stderr.setEncoding("utf8").on("data", (chunk) => { decodeError = (decodeError + chunk).slice(-1000); });
  let count = 0;
  let current = Buffer.alloc(frameBytes), filled = 0;
  for await (const chunk of decode.stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(frameBytes - filled, chunk.length - offset);
      chunk.copy(current, filled, offset, offset + take);
      filled += take; offset += take;
      if (filled < frameBytes) continue;
      await session.send(FACES | PEOPLE, current);
      count += 1;
      current = Buffer.alloc(frameBytes); filled = 0;
    }
  }
  const code = decode.exitCode ?? await new Promise((resolve) => decode.once("close", resolve));
  signal?.removeEventListener("abort", onAbort);
  if (signal?.aborted) throw Object.assign(new Error("Finding people was cancelled."), { name: "AbortError" });
  if (code !== 0 && !count) throw new Error(`FFmpeg could not decode the video: ${decodeError.trim().split("\n").at(-1) || `exit ${code}`}`);
  const { answers, error } = await session.finish();
  if (error && !answers.length) return { version: PEOPLE_VERSION, unavailable: `the kino-measure helper stopped: ${error}` };
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const answer = answers[index] ?? {};
    if (!Array.isArray(answer.people)) continue;
    samples.push({ t: round3(index / fps), faces: answer.faces ?? [], people: answer.people });
  }
  return { version: PEOPLE_VERSION, fps: round3(fps), samples };
}

/** Finds the people in each file once and keeps the answer beside it (`.people-v1`). */
export function createPeopleCache({ measure = measurePeople } = {}) {
  const pending = new Map();
  const sidecar = (file) => `${file}.people-v${PEOPLE_VERSION}`;
  async function saved(file) {
    try {
      const found = JSON.parse(await readFile(sidecar(file), "utf8"));
      return found?.version === PEOPLE_VERSION && Array.isArray(found.samples) ? found : null;
    } catch { return null; }
  }
  async function make(file, info) {
    const found = await saved(file);
    if (found) return found;
    const result = await measure(file, info);
    // A computer that cannot find people keeps nothing: another one (or a later macOS) can.
    if (result.unavailable) return result;
    const temporary = `${sidecar(file)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar(file));
    } catch { /* The answer still counts when the folder cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return result;
  }
  return {
    /** The saved answer for a file, or null (a quick check does not measure). */
    saved,
    /** The answer for a file, measured now when none is saved; `info` is {width, height, duration}. */
    get(file, info) {
      if (!pending.has(file)) pending.set(file, make(file, info).finally(() => pending.delete(file)));
      return pending.get(file);
    },
  };
}
