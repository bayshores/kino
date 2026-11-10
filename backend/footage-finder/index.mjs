// The footage finder: from a prompt alone to found, scanned and imported clips. This file joins
// its parts; search.mjs finds candidate videos. Wired into kino by backend/index.mjs (a later step).
import path from "node:path";
import { runYtDlp } from "../inspire.mjs";
import { createWebCache } from "../web-cache.mjs";
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
 * now() (the clock).
 * Returns {search(words, {count, signal}) → {words, tried?, candidates, dropped, cached}}.
 */
export function createFootageFinder(deps) {
  const { directory, ytDlp = (args, options) => runYtDlp(args, options), now = Date.now } = deps;
  if (!directory) throw new Error("createFootageFinder needs a directory.");
  const { cached } = createWebCache({ directory: path.join(directory, "cache"), ttlMs: FOOTAGE_CACHE_MS, now });
  // The same search running twice at once (two agents) asks YouTube once.
  const searching = new Map();

  async function search(words, { count, signal } = {}) {
    const key = `youtube\n${count ?? ""}\n${String(words ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
    let job = searching.get(key);
    if (!job) {
      let asked = false;
      job = cached(key, async () => {
        asked = true;
        const answer = await searchFootage(words, { run: ytDlp, count, signal });
        if (!answer.candidates.length) throw new NothingFound(answer);
        return answer;
      })
        .then((answer) => ({ ...answer, cached: !asked }))
        .catch((error) => { if (error instanceof NothingFound) return { ...error.answer, cached: false }; throw error; })
        .finally(() => searching.delete(key));
      searching.set(key, job);
    }
    return job;
  }

  return { search };
}
