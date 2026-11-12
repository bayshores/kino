// The footage finder: from a prompt alone to found, scanned and imported clips. This file joins
// its parts: search.mjs finds candidate videos, scan.mjs and score.mjs scan one, licensed.mjs is
// Commons, actions.mjs is the agent's library {topic:"footage"}. Wired into kino by backend/index.mjs.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runYtDlp } from "../inspire.mjs";
import { createWebCache } from "../web-cache.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";
import { downloadScanCopy, pickWindows, probeFootage } from "./scan.mjs";
import { readScan, readScanSheet, scanFootage } from "./score.mjs";
import { searchFootage } from "./search.mjs";
import { takeFootage } from "./take.mjs";
import { defaultLanguages, fetchCaptions } from "./words.mjs";

/** A footage search answer lasts this long (ms): the same search within a day asks YouTube nothing. */
export const FOOTAGE_CACHE_MS = 24 * 60 * 60 * 1000;
/** A video's captions (or the fact that it has none) are kept this long (ms). */
export const CAPTIONS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** After YouTube could not be asked for captions (a rate limit), kino does not ask again for this long (ms). */
export const CAPTIONS_RETRY_MS = 15 * 60 * 1000;

// Thrown inside the cache's make() so an empty answer is never saved: YouTube once answered
// nothing for a search that worked minutes later.
class NothingFound extends Error {
  constructor(answer) { super("nothing found"); this.answer = answer; }
}

/**
 * Makes the finder. deps: directory (the private footage folder; search answers are kept in its
 * cache/), ytDlp(args, {signal}) → yt-dlp's output (default runYtDlp: KINO_YTDLP, no cookies),
 * now() (the clock); for scans: dataRoot (scans are kept in <data>/footage/scans), youtube (the
 * shared gate), embed (look-embed.mjs, or null), commons (licensed.mjs createCommonsSource),
 * keep() (scan ids the cap leaves alone), modelReady() (false: the image model still downloads);
 * for imports: addMedia(file, {name, mime, extra}) (backend/index.mjs addGeneratedMedia), takeTools (tests);
 * for captions: languages (the person's, best first; default the computer's language, then English),
 * runtime (the JavaScript runtime yt-dlp needs; default the one inspire.mjs finds; tests pass one).
 * Returns {search(words, {count, signal}) → {words, tried?, candidates, dropped, cached},
 * scan(candidate, options), take(candidate, pieces, {projectId}), readScan(id),
 * readSheet(id) → the scan's sheet jpg or null, searchCommons(words),
 * captions(candidate, {signal}) → words.mjs fetchCaptions' answer, kept in <directory>/captions}.
 */
export function createFootageFinder(deps) {
  const { directory, ytDlp = (args, options) => runYtDlp(args, options), now = Date.now,
    dataRoot = null, youtube = null, embed = null, commons = null, keep = () => [], modelReady = () => true, addMedia = null, takeTools,
    languages = defaultLanguages(), runtime = null } = deps;
  if (!directory) throw new Error("createFootageFinder needs a directory.");
  const { cached } = createWebCache({ directory: path.join(directory, "cache"), ttlMs: FOOTAGE_CACHE_MS, now });
  // The same search running twice at once (two agents) asks YouTube once. The shared job has its
  // own cancel: it stops only when every caller waiting on it has cancelled.
  const searching = new Map();

  async function search(words, { count, signal, origin = null } = {}) {
    if (signal?.aborted) throw abortError();
    // The origin word is part of the key: an answer made without it dropped edit uploads this one keeps.
    const key = `youtube\n${count ?? ""}\n${origin?.word ? String(origin.word).toLowerCase() : ""}\n${String(words ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
    let job = searching.get(key);
    if (!job) {
      const controller = new AbortController();
      let asked = false;
      const promise = cached(key, async () => {
        asked = true;
        const answer = await searchFootage(words, { run: ytDlp, count, signal: controller.signal, origin });
        if (!answer.candidates.length) throw new NothingFound(answer);
        return answer;
      })
        .then((answer) => ({ ...answer, cached: !asked }))
        .catch((error) => { if (error instanceof NothingFound) return { ...error.answer, cached: false }; throw error; })
        .finally(() => { if (searching.get(key) === job) searching.delete(key); });
      job = { controller, promise, waiting: 0 };
      searching.set(key, job);
    }
    job.waiting += 1;
    try {
      return await untilAborted(job.promise, signal);
    } finally {
      job.waiting -= 1;
      // The last caller cancelled: stop yt-dlp, and let a later search start afresh.
      if (signal?.aborted && job.waiting === 0) {
        if (searching.get(key) === job) searching.delete(key);
        job.controller.abort();
      }
    }
  }

  // Captions: kept per video in <directory>/captions/<video id>.json (lines, or that the video has
  // none), so a video's captions are asked of YouTube once. An answer that says YouTube could not be
  // asked now (retry) is not kept: it is remembered for CAPTIONS_RETRY_MS in memory, so a rate
  // limit is not pushed on by more requests.
  const captionJobs = new Map();
  const captionFailed = new Map();

  /**
   * One candidate's captions: {lang, auto, lines}, {none: true}, or {none: true, why, retry: true}.
   * Commons clips and drawn-only sources have none. Never throws except for a cancel.
   */
  async function captions(candidate, { signal } = {}) {
    const videoId = candidate?.source === "commons" ? null : candidate?.videoId;
    if (!videoId) return { none: true };
    const file = path.join(directory, "captions", `${videoId}.json`);
    const saved = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (saved && now() - Number(saved.at) < CAPTIONS_KEEP_MS && (saved.lines || saved.languages?.join() === languages.join())) {
      return saved.lines ? { lang: saved.lang, auto: saved.auto, lines: saved.lines } : { none: true };
    }
    const failed = captionFailed.get(videoId);
    if (failed && failed.until > now()) return failed.answer;
    let job = captionJobs.get(videoId);
    if (!job) {
      job = fetchCaptions(videoId, { youtube, run: ytDlp, languages, ...(runtime ? { runtime } : {}) })
        .then(async (answer) => {
          if (answer.retry) { captionFailed.set(videoId, { until: now() + CAPTIONS_RETRY_MS, answer }); return answer; }
          captionFailed.delete(videoId);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(`${file}.part`, JSON.stringify({ at: now(), languages, ...(answer.none ? {} : { lang: answer.lang, auto: answer.auto, lines: answer.lines }) }));
          await rename(`${file}.part`, file);
          return answer;
        })
        .catch((error) => ({ none: true, why: String(error?.message ?? error).slice(0, 120), retry: true }))
        .finally(() => { if (captionJobs.get(videoId) === job) captionJobs.delete(videoId); });
      captionJobs.set(videoId, job);
    }
    return untilAborted(job, signal);
  }

  /**
   * Scans one candidate (scan.mjs, then score.mjs): YouTube through the probe, the chosen windows
   * and a 360p copy; Commons through its 360p copy, whole. Answers the saved scan. A video that
   * cannot play here throws {code: "UNPLAYABLE", reason}.
   */
  async function scan(candidate, { want = "", from, to, whole = false, onProgress, signal } = {}) {
    if (!dataRoot) throw new Error("The footage finder has no data folder to keep scans in.");
    const id = String(candidate.id).replace(/^clip:/, "");
    let copy;
    if (candidate.source === "commons") {
      if (!commons) throw new Error("Commons is not available here.");
      const folder = await makeTempFolder("kino-footage-");
      try {
        onProgress?.("Downloading the 360p copy from Commons.");
        const file = await commons.download(candidate, folder, { use: "scan" });
        copy = { folder, files: [{ start: 0, end: Number(candidate.seconds) || 0, file }] };
      } catch (error) {
        await removeTempFolder(folder);
        throw error;
      }
    } else {
      const probe = await probeFootage(candidate.videoId, { youtube, signal });
      if (probe.cannotPlay) throw Object.assign(new Error(`This video cannot play from here (${probe.cannotPlay}).`), { code: "UNPLAYABLE", reason: probe.cannotPlay });
      const windows = pickWindows(probe, { want, from, to, whole });
      // Captions are read once per video and kept; a failure here never stops the scan.
      onProgress?.("Reading captions.");
      await captions(candidate, { signal }).catch((error) => { if (error?.name === "AbortError") throw error; });
      onProgress?.(`Downloading ${windows.length} stretch${windows.length === 1 ? "" : "es"} at 360p.`);
      copy = await downloadScanCopy(candidate.videoId, windows, { youtube, signal });
      if (!candidate.title) candidate = { ...candidate, title: probe.title };
    }
    return scanFootage(id, copy, { dataRoot, want, embed, title: candidate.title ?? "", keep: keep(), onProgress, modelReady: modelReady(), signal });
  }

  /**
   * Imports `pieces` (take.mjs planTake) of a scanned candidate into the media library for
   * `projectId`: one 1080p download through the gate, then each shot cut and re-encoded to H.264.
   * Answers {media, failed}.
   */
  function take(candidate, pieces, { projectId, marks, signal } = {}) {
    if (!addMedia) throw new Error("The footage finder cannot add clips here.");
    return takeFootage(candidate, pieces, { addMedia, projectId, marks, youtube, commons, run: ytDlp, tools: takeTools, signal });
  }

  return {
    search,
    scan,
    take,
    captions,
    readScan: (id) => (dataRoot ? readScan(dataRoot, id) : Promise.resolve(null)),
    readSheet: (id) => (dataRoot ? readScanSheet(dataRoot, id) : Promise.resolve(null)),
    searchCommons: async (words) => {
      if (!commons) throw new Error("Commons is not available here.");
      return commons.search(words);
    },
  };
}

function abortError() {
  const error = new Error("Cancelled.");
  error.name = "AbortError";
  return error;
}

// The shared promise for one caller: rejects with "Cancelled." as soon as this caller's signal aborts.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
