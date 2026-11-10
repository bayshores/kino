// Shared limits on how many media programs this process runs at once, so opening several projects
// (each checking its sounds and clips) queues the work instead of loading the computer.
// heavyDecode: a full decode of a file's sound or picture (beats, waveform peaks): one at a time.
// probe: a short ffprobe read of a file's streams: a few at a time.
// Wrap only the run of one program (or one pipe of programs), never work that waits for another
// slot, so a slot holder can never wait on itself.

/** A limit of `max` runs at once: `slot(work)` waits for a free run, then calls work(). */
export function createSlots(max) {
  let running = 0;
  const waiting = [];
  async function slot(work) {
    if (running >= max) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
    try { return await work(); } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }
  slot.running = () => running;
  slot.waiting = () => waiting.length;
  return slot;
}

/** One full media decode at a time in this process. */
export const heavyDecodeSlot = createSlots(1);
/** At most three ffprobe runs at once in this process. */
export const probeSlot = createSlots(3);

// ---- YouTube downloads ------------------------------------------------------------------------

export const BOT_CHECK = "YouTube asked to sign in to prove this is not a bot. kino never signs in or sends cookies, so it cannot read this video's cuts from this network now.";
/** After YouTube's bot check, kino waits this long before it downloads again (unless asked to). */
export const BOT_CHECK_PAUSE_MS = 15 * 60 * 1000;
/** The quiet time between one YouTube download's end and the next one's start. */
export const YOUTUBE_GAP_MS = 5000;

export const botCheckError = () => Object.assign(new Error(BOT_CHECK), { code: "BOT_CHECK" });

/**
 * The one gate every YouTube download goes through (inspire, soundtrack, footage), so YouTube sees
 * one careful visitor: one download at a time inside `slot` (yt-dlp runs FFmpeg itself, so it takes
 * the heavy decode slot), `gapMs` between downloads, and after a bot check no download for
 * `pauseMs` unless one is forced. `run(work, {force})` runs one download.
 */
export function createYouTubeGate({ slot = heavyDecodeSlot, gapMs = YOUTUBE_GAP_MS, pauseMs = BOT_CHECK_PAUSE_MS, now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let pausedUntil = 0;
  let lastEnd = -Infinity;
  async function run(work, { force = false } = {}) {
    return slot(async () => {
      if (!force && now() < pausedUntil) throw botCheckError();
      const gap = lastEnd + gapMs - now();
      if (gap > 0) await wait(gap);
      try { return await work(); } catch (error) {
        // A forced try that meets the check again does not stretch the pause.
        if (error?.code === "BOT_CHECK" && now() >= pausedUntil) pausedUntil = now() + pauseMs;
        throw error;
      } finally { lastEnd = now(); }
    });
  }
  run.paused = () => now() < pausedUntil;
  return run;
}
