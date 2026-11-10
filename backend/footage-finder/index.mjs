// The footage finder: from a prompt alone to found, scanned and imported clips. This file joins
// its parts: search.mjs finds candidate videos, scan.mjs and score.mjs scan one, licensed.mjs is
// Commons, actions.mjs is the agent's library {topic:"footage"}. Wired into kino by backend/index.mjs.
import path from "node:path";
import { runYtDlp } from "../inspire.mjs";
import { createWebCache } from "../web-cache.mjs";
import { makeTempFolder, removeTempFolder } from "../temp-folders.mjs";
import { downloadScanCopy, pickWindows, probeFootage } from "./scan.mjs";
import { readScan, readScanSheet, scanFootage } from "./score.mjs";
import { searchFootage } from "./search.mjs";

/** A footage search answer lasts this long (ms): the same search within a day asks YouTube nothing. */
export const FOOTAGE_CACHE_MS = 24 * 60 * 60 * 1000;

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
 * keep() (scan ids the cap leaves alone), modelReady() (false: the image model still downloads).
 * Returns {search(words, {count, signal}) → {words, tried?, candidates, dropped, cached},
 * scan(candidate, options), readScan(id), readSheet(id) → the scan's sheet jpg or null, searchCommons(words)}.
 */
export function createFootageFinder(deps) {
  const { directory, ytDlp = (args, options) => runYtDlp(args, options), now = Date.now,
    dataRoot = null, youtube = null, embed = null, commons = null, keep = () => [], modelReady = () => true } = deps;
  if (!directory) throw new Error("createFootageFinder needs a directory.");
  const { cached } = createWebCache({ directory: path.join(directory, "cache"), ttlMs: FOOTAGE_CACHE_MS, now });
  // The same search running twice at once (two agents) asks YouTube once. The shared job has its
  // own cancel: it stops only when every caller waiting on it has cancelled.
  const searching = new Map();

  async function search(words, { count, signal } = {}) {
    if (signal?.aborted) throw abortError();
    const key = `youtube\n${count ?? ""}\n${String(words ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
    let job = searching.get(key);
    if (!job) {
      const controller = new AbortController();
      let asked = false;
      const promise = cached(key, async () => {
        asked = true;
        const answer = await searchFootage(words, { run: ytDlp, count, signal: controller.signal });
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
      onProgress?.(`Downloading ${windows.length} stretch${windows.length === 1 ? "" : "es"} at 360p.`);
      copy = await downloadScanCopy(candidate.videoId, windows, { youtube, signal });
      if (!candidate.title) candidate = { ...candidate, title: probe.title };
    }
    return scanFootage(id, copy, { dataRoot, want, embed, title: candidate.title ?? "", keep: keep(), onProgress, modelReady: modelReady(), signal });
  }

  return {
    search,
    scan,
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
