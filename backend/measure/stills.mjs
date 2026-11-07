// Stills of a reference: one a second over the measured part (10 at least, 90 at most), at the
// downloaded copy's own size (360p at most, never wider than 640 px). Inspire keeps them after it
// deletes the copy, so a judge round (agent/judge.mjs) can set a reference frame beside a frame of
// the edit at the same pixel size, and look versus can pin a board shot to a reference second
// ("phone-film@7.27") within half a second. The strips (strips.mjs) are 240 px wide: too small for that.
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../media-probe.mjs";
import { ffmpegArgs, lowerIfBackground } from "../render-activity.mjs";

export const STILL_COUNT = 10;
export const STILL_MOST = 90;
export const STILL_MAX_WIDTH = 640;

const round = (value) => Math.round(value * 100) / 100;

/** How many stills a video of `seconds` keeps: one a second, 10 to 90. */
export const stillCount = (seconds) => Math.min(STILL_MOST, Math.max(STILL_COUNT, Math.ceil(seconds)));

/** The times of the stills: the middle of each of `count` equal parts of `seconds`. */
export function stillTimes(seconds, count = stillCount(seconds)) {
  return Array.from({ length: count }, (_, index) => round(((index + 0.5) * seconds) / count));
}

/**
 * The FFmpeg arguments for every still in one pass: from the middle of the first part, `count`
 * frames a part apart (the fps filter), written as 00.jpg, 01.jpg, ...
 */
export function stillArgs(file, seconds, folder, count = stillCount(seconds)) {
  const every = seconds / count;
  return ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", String(round(every / 2)), "-i", file, "-an", "-sn", "-dn",
    "-vf", `fps=${count}/${round(seconds)}:eof_action=pass,scale='min(${STILL_MAX_WIDTH},iw)':-2:flags=area`, "-frames:v", String(count), "-q:v", "3",
    "-start_number", "0", path.join(folder, "%02d.jpg")];
}

function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand(), ffmpegArgs(args), { stdio: ["ignore", "ignore", "pipe"], signal });
    lowerIfBackground(child);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-500); });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg could not keep the stills: ${stderr.trim().split("\n").at(-1) || code}`))));
  });
}

/**
 * Keeps the stills of `file` (measured for `seconds`) in `folder`, replacing what was there, in
 * one FFmpeg pass. Returns [{at, file}] for the stills made (none when FFmpeg fails).
 */
export async function makeStills(file, seconds, folder, { signal } = {}) {
  const building = `${folder}.building`;
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { recursive: true, mode: 0o700 });
  try {
    const times = stillTimes(seconds);
    try { await runFfmpeg(stillArgs(file, seconds, building, times.length), signal); }
    catch (error) { if (signal?.aborted) throw error; }
    const names = new Set(await readdir(building));
    const made = times.map((at, index) => ({ at, file: `${String(index).padStart(2, "0")}.jpg` })).filter((still) => names.has(still.file));
    await rm(folder, { recursive: true, force: true });
    await rename(building, folder);
    return made;
  } catch (error) {
    await rm(building, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
