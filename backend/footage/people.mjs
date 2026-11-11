// Where the people are in a clip, for the people checks (engine/quality/rules/people.js): the faces
// and each person's whole-body box, and whether the body pose found the head. Measured on this
// computer with Apple Vision (the kino-measure helper, job 16 faces and 32 people) and kept beside
// the file as a .people-v1 file, so a clip is measured once.
//
// The same pass also writes a .subjects-v1 file: the same samples plus, in each, `subjects`, the
// boxes that show where the eye goes: the faces, or (a shot with no face) where Vision's saliency
// says the eye goes. Each box is tagged kind "face" or "saliency", so a reader never takes a
// saliency box for a face. The faces and people stay in the sample, so a reader of .people-v1
// reads it too.
//
// How a video is measured:
//   1. FFmpeg decodes it at PEOPLE_FPS frames a second (fewer for a long clip, at most MAX_FRAMES
//      pictures in all), at most 480 pixels on the long side (never the full size).
//   2. The helper finds the faces, the people and the saliency boxes in each picture.
// Without the helper (not a Mac, macOS older than 12, no Xcode command line tools to build it,
// or KINO_MEASURE_HELPER=none) nothing is measured and the answer says why: the checks then say
// they did not run, and never guess.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { ffmpegCommand } from "../media-probe.mjs";
import { endWithService } from "../child-exit.mjs";
import { helperSession, measureAbilities, measureHelperPath, measureSize } from "../measure/measure.mjs";
import { round as round3 } from "../../engine/numbers.js";
import { heavyDecodeSlot } from "../process-slots.mjs";

export const PEOPLE_VERSION = 1;
export const SUBJECTS_VERSION = 1;
// How long a file that failed waits before it is measured again (createPeopleCache).
const FAILED_RETRY_MS = 10 * 60_000;
const PEOPLE_FPS = 2;
const MAX_FRAMES = 600;
const SIDE = 480;
// The helper's job bits (kino-measure.swift): 8 saliency, 16 faces, 32 people.
const SALIENCY = 8, FACES = 16, PEOPLE = 32;

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
 * The boxes that show where the eye goes in one picture: its faces, and only when it has none the
 * saliency boxes, each as {box: [x, y, w, h], kind: "face" | "saliency"} (fractions of the frame).
 */
export function subjectBoxes(answer) {
  const faces = answer.faces ?? [];
  if (faces.length) return faces.map((box) => ({ box, kind: "face" }));
  return (answer.saliency ?? []).map((box) => ({ box, kind: "saliency" }));
}

/**
 * Measures a video file. Resolves to {version, fps, samples: [{t, faces: [[x, y, w, h]],
 * people: [{box: [x, y, w, h], head, top}]}]} in fractions of the frame (top left origin): head is
 * how many head joints (nose, eyes, ears) the body pose found, top the highest one's y. Also
 * `subjects`: the same, each sample with `subjects: [{box, kind}]` added (subjectBoxes), for the
 * .subjects-v1 file. Or {version, unavailable: "why"} when this computer cannot find people.
 */
export function measurePeople(file, options = {}) {
  // One video decode at a time in this process (process-slots.mjs).
  return heavyDecodeSlot(() => measurePeopleNow(file, options));
}

async function measurePeopleNow(file, { width, height, duration, signal } = {}) {
  if (signal?.aborted) throw Object.assign(new Error("Finding people was cancelled."), { name: "AbortError" });
  const { helper, why } = await peopleHelper();
  if (!helper) return { version: PEOPLE_VERSION, unavailable: why };
  const size = measureSize(width, height, SIDE);
  const fps = duration > 0 ? Math.min(PEOPLE_FPS, MAX_FRAMES / duration) : PEOPLE_FPS;
  const session = helperSession(helper, { ...size, signal });
  const frameBytes = size.width * size.height * 4;
  const decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-i", file, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `fps=${round3(fps)},scale=${size.width}:${size.height}:flags=area,format=bgra`, "-frames:v", String(MAX_FRAMES), "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  endWithService(decode);
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
      await session.send(FACES | PEOPLE | SALIENCY, current);
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
  const samples = [], withSubjects = [];
  for (let index = 0; index < count; index += 1) {
    const answer = answers[index] ?? {};
    if (!Array.isArray(answer.people)) continue;
    const sample = { t: round3(index / fps), faces: answer.faces ?? [], people: answer.people };
    samples.push(sample);
    withSubjects.push({ ...sample, subjects: subjectBoxes(answer) });
  }
  return { version: PEOPLE_VERSION, fps: round3(fps), samples, subjects: { version: SUBJECTS_VERSION, fps: round3(fps), samples: withSubjects } };
}

/**
 * Finds the people in each file once and keeps the answer beside it: `.people-v1` (faces and
 * people) and `.subjects-v1` (the same plus a tagged box per subject), both from one measure.
 */
export function createPeopleCache({ measure = measurePeople, now = () => Date.now() } = {}) {
  const pending = new Map();
  // A file that failed (FFmpeg could not decode it, or the helper stopped on it) is not measured
  // again for a while: each full check asks again, and each try decodes the whole video.
  const failed = new Map();
  const remember = (file, outcome) => {
    failed.delete(file);
    failed.set(file, { ...outcome, at: now() });
    if (failed.size > 512) failed.delete(failed.keys().next().value);
  };
  const versions = { people: PEOPLE_VERSION, subjects: SUBJECTS_VERSION };
  const sidecar = (file, kind) => `${file}.${kind}-v${versions[kind]}`;
  async function read(file, kind) {
    try {
      const found = JSON.parse(await readFile(sidecar(file, kind), "utf8"));
      return found?.version === versions[kind] && Array.isArray(found.samples) ? found : null;
    } catch { return null; }
  }
  async function keep(file, kind, value) {
    const temporary = `${sidecar(file, kind)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar(file, kind));
    } catch { /* The answer still counts when the folder cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  // One measure makes both answers: {people, subjects}, or {unavailable} (kept for neither: another
  // computer, or a later macOS, can find people).
  async function measureBoth(file, info) {
    const result = await measure(file, info);
    if (result.unavailable) return { unavailable: result };
    const { subjects, ...people } = result;
    await keep(file, "people", people);
    if (subjects) await keep(file, "subjects", subjects);
    return { people, subjects: subjects ?? { version: SUBJECTS_VERSION, unavailable: "this measure made no subject boxes" } };
  }
  function measuring(file, info) {
    if (!pending.has(file)) pending.set(file, measureBoth(file, info).then((both) => {
      if (/helper stopped/.test(String(both.unavailable?.unavailable ?? ""))) remember(file, { result: both.unavailable });
      return both;
    }, (error) => {
      if (error?.name !== "AbortError") remember(file, { error });
      throw error;
    }).finally(() => pending.delete(file)));
    return pending.get(file);
  }
  function get(file, info, kind) {
    const failure = failed.get(file);
    if (failure && now() - failure.at < FAILED_RETRY_MS) return failure.error ? Promise.reject(failure.error) : Promise.resolve(failure.result);
    return read(file, kind).then((found) => found ?? measuring(file, info).then((both) => both.unavailable ?? both[kind]));
  }
  return {
    /** The saved people answer for a file, or null (a quick check does not measure). */
    saved: (file) => read(file, "people"),
    /** The people answer for a file, measured now when none is saved; `info` is {width, height, duration}. */
    get: (file, info) => get(file, info, "people"),
    /** The saved subjects answer for a file, or null. */
    savedSubjects: (file) => read(file, "subjects"),
    /** The subjects answer (faces, else saliency, each box tagged `kind`), measured now when none is saved. */
    subjects: (file, info) => get(file, info, "subjects"),
  };
}
