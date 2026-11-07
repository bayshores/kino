// Subject cut-out for the edit op cut_out (backend/agent/cutout-operation.mjs). It turns a media
// file's matte (cutout.mjs) into a new file in kino's media library, so a layer shows it like any
// imported file. Saving, history undo, exports and the dashboard then work without anything new:
// they only see a layer whose src points at another library file.
//
//   video → "<name> (subject).webm"     the subject on a transparent background (VP9 with alpha)
//           "<name> (matte).mp4"        white subject on black (H.264), for create_mask
//           "<name> (silhouette).webm"  the subject's shape in one colour, transparent elsewhere
//   image → the same as PNG files
//
// Which library file was made with which settings is kept in the matte's cache folder
// (media.json), so running cut_out again with the same settings reuses the same library file
// while it is still there. A cut-out whose matte and library file are both kept answers at once.
// Making one runs one at a time (Vision uses the whole Neural Engine): a second one waits its
// turn, and the same one asked for twice is made once.
//
// Work in progress is kept in the cache folder: ".work-…" (cutout.mjs, a matte being made) and
// ".media-…" (an output being written). A server stopped part-way (killed, or the computer
// turned off) leaves them behind; the next one removes those left alone for an hour
// (leftover-work.mjs).
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { removeLeftoverWork } from "../leftover-work.mjs";
import { dirname, join } from "node:path";
import { makeStabilized } from "./stabilize.mjs";
import { mediaBaseName } from "../voice/media.mjs";
import { cutoutEngines, cutoutError, findMatte, makeMatte, writeCutoutOutput } from "./cutout.mjs";

// Bump when an output made from the same matte and settings would change (subject 2: a clip's
// edge is cleaned of its background, cutout/edges.mjs).
const OUTPUT_FORMAT = { subject: 2, matte: 1, silhouette: 1 };

/**
 * Makes library media from subject mattes. Options:
 *   mediaRoot  kino's media folder (to check that a remembered file is still there)
 *   cacheDir   the matte cache (cutout.mjs); media.json files go in its matte folders
 *   addMedia   async (file, { name, mime }) → the new media record ({ id, src, name, mime, … });
 *              it moves `file` into the library (backend/index.mjs)
 *   waitSeconds  how long an edit waits for its cut-outs, all of them together, before answering
 *              CUTOUT_RUNNING (default 50, under the 60 seconds some agents give a tool call)
 */
export function createCutoutMedia({ mediaRoot, cacheDir, addMedia, waitSeconds = 50 }) {
  const jobs = new Map();
  let turn = Promise.resolve();
  // Cut-outs start once the work folders a stopped server left behind are gone.
  const swept = removeLeftoverWork(cacheDir);

  // Runs `job` after the cut-outs started before it.
  function inTurn(job) {
    const run = turn.then(job, job);
    turn = run.catch(() => {});
    return run;
  }

  async function remembered(folder) {
    try { return JSON.parse(await readFile(join(folder, "media.json"), "utf8")); } catch { return {}; }
  }

  async function libraryRecord(id) {
    if (typeof id !== "string" || !/^[a-f0-9-]+\.[a-z0-9]+$/.test(id) || !existsSync(join(mediaRoot, id))) return null;
    try {
      const record = JSON.parse(await readFile(join(mediaRoot, `${id}.json`), "utf8"));
      return record.id === id ? record : null;
    } catch { return null; }
  }

  // Where media.json keeps the library file of one output of a matte.
  function outputSlot({ output: kind, grow, feather, color, invert }) {
    return JSON.stringify({ v: OUTPUT_FORMAT[kind] ?? 1, output: kind, grow, feather, ...(kind === "silhouette" ? { color } : {}), ...(kind === "matte" ? { invert } : {}) });
  }

  // The library file for one output of one matte, made the first time.
  async function makeOutput({ matte, file, name, settings, onFraction }) {
    const { output: kind, grow, feather, color, invert } = settings;
    const slot = outputSlot(settings);
    const reused = await libraryRecord((await remembered(matte.folder))[slot]);
    if (reused) return { record: reused, made: false };
    await mkdir(cacheDir, { recursive: true });
    const work = await mkdtemp(join(cacheDir, ".media-"));
    try {
      const extension = matte.info.kind === "video" ? (kind === "matte" ? "mp4" : "webm") : "png";
      const target = join(work, `out.${extension}`);
      const { mime } = await writeCutoutOutput({ source: file, folder: matte.folder, info: matte.info, output: kind,
        grow, feather, color, invert, target, onFraction });
      const record = await addMedia(target, { name: `${mediaBaseName(name)} (${kind}).${extension}`, mime });
      // Read again just before writing: another output of this matte may have been added meanwhile.
      const list = { ...(await remembered(matte.folder)), [slot]: record.id };
      await writeFile(join(matte.folder, ".media.json.tmp"), `${JSON.stringify(list, null, 2)}\n`);
      await rename(join(matte.folder, ".media.json.tmp"), join(matte.folder, "media.json"));
      return { record, made: true };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Starts (or joins) the cut-out of library file `file` (named `name`, a "video" or "image") and
   * returns { done, progress }: `done` resolves with { record, engine, frames, empty, seconds,
   * cached, note } (record is the new library media; cached: the subject was found before and its
   * matte reused), and progress() gives { fraction, seconds } so far. Settings: output, engine,
   * grow and feather (in the file's pixels), color, invert. A cut-out made before resolves at
   * once; one that needs Vision or FFmpeg first waits for the ones started before it.
   */
  function start({ file, name, kind, output = "subject", engine = "auto", grow = 0, feather = 0, color = "#ffffff", invert = false }) {
    const settings = { output, engine, grow, feather, color, invert };
    const key = JSON.stringify({ file, kind, ...settings });
    if (jobs.has(key)) return jobs.get(key).handle;
    const state = { fraction: 0, started: performance.now() };
    const result = (matte, record) => ({ record, engine: matte.engine, frames: matte.info.frames, empty: matte.info.empty,
      matteSeconds: matte.info.seconds, seconds: (performance.now() - state.started) / 1000, cached: matte.cached, note: matte.note });
    const done = (async () => {
      await swept;
      // A finished cut-out (its matte and library file both kept) answers at once, even while
      // another one is being made: only finding a subject and writing a file wait their turn.
      const kept = await findMatte({ source: file, kind, engine, cacheDir });
      if (kept) {
        if (kept.info.empty === kept.info.frames) throw noSubject(kept);
        const record = await libraryRecord((await remembered(kept.folder))[outputSlot(settings)]);
        if (record) {
          state.fraction = 1;
          return result(kept, record);
        }
      }
      return inTurn(async () => {
        state.started = performance.now();
        const matte = await makeMatte({ source: file, kind, engine, cacheDir, onProgress: (fraction) => { state.fraction = 0.8 * fraction; } });
        if (matte.info.empty === matte.info.frames) throw noSubject(matte);
        const made = await makeOutput({ matte, file, name, settings, onFraction: (fraction) => { state.fraction = 0.8 + 0.2 * fraction; } });
        state.fraction = 1;
        return result(matte, made.record);
      });
    })();
    const handle = {
      done,
      progress: () => ({ fraction: state.fraction, seconds: (performance.now() - state.started) / 1000 }),
    };
    jobs.set(key, { handle });
    // A finished job is forgotten (its result is in the cache); a failed one can be tried again.
    done.finally(() => jobs.delete(key)).catch(() => {});
    return handle;
  }

  // stabilize: the steadied copy (backend/cutout/stabilize.mjs), added to the library once; its
  // media id is kept beside it, so the same file and settings answer with the same media.
  async function stabilize({ file, name, smooth, zoom, signal }) {
    const made = await makeStabilized({ source: file, cacheDir: join(cacheDir, "stabilize"), smooth, zoom, signal });
    // A copy that jerks more than the file is never added: the op keeps the original.
    if (made.info.worse) return { record: null, info: made.info, cached: made.cached };
    const folder = dirname(made.file);
    const known = await readFile(join(folder, "media.json"), "utf8").then(JSON.parse).catch(() => null);
    if (known?.id && existsSync(join(mediaRoot, known.id))) return { record: known, info: made.info, cached: true };
    const work = await mkdtemp(join(cacheDir, ".media-"));
    try {
      const target = join(work, "steady.mp4");
      await copyFile(made.file, target);
      const record = await addMedia(target, { name: `${mediaBaseName(name)} (steady).mp4`, mime: "video/mp4" });
      await writeFile(join(folder, "media.json"), `${JSON.stringify({ id: record.id, src: record.src })}\n`);
      return { record, info: made.info, cached: made.cached };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  // The track op keeps its tracks beside the mattes (backend/cutout/track.mjs).
  return { start, stabilize, engines: cutoutEngines, waitSeconds, trackCacheDir: join(cacheDir, "tracks") };
}

function noSubject(matte) {
  const { info } = matte;
  const who = matte.engine === "person" ? "no person" : "no subject";
  return cutoutError(`Apple Vision found ${who} in ${info.frames === 1 ? "the picture" : `any of its ${info.frames} frames`}.`, "CUTOUT_NO_SUBJECT");
}

