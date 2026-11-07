// Decoded GIF frames on disk, one folder per uploaded GIF:
//   <cacheRoot>/<file>/000000.png, 000001.png, ... and timeline.json
// A GIF is decoded the first time someone asks for its frames, and only once:
// requests that arrive while it is decoding wait for the same decode.
// Each decode writes into a private temporary folder that is renamed into place
// when complete, so a failed or interrupted decode never leaves half a cache.
// Decodes wait for one of the server's shared GIF decode slots (gif-decode-slots.mjs, also used by
// exports), and a decode that runs too long is stopped. A decode is shared by every request for that
// GIF, so one client leaving never stops it.
//
// timeline.json records which decoder version wrote the folder; frames from another version
// are decoded again. It also records the folder's size in bytes. The cache keeps to a byte budget
// (2 GiB unless KINO_GIF_FRAME_CACHE_BYTES sets another number) by removing the folders that were
// requested least recently. Folders requested in the last minute may take it over the budget, up to
// twice the budget, and the first request after they stop being recent trims it back. A folder that
// disappears (removed to stay within the budget, or by a disk cleanup) is decoded again the next time
// one of its frames is requested.
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GIF_DECODER_VERSION } from "../engine/gifDecode.js";
import { gifDecodeSlots } from "./gif-decode-slots.mjs";
import { decodeGifFrames, gifFrameFileName } from "./media-probe.mjs";

const TIMELINE_FILE = "timeline.json";
const PARTIAL_FOLDER = ".partial";
// Temporary folders older than this belong to a decode that was interrupted by a crash.
const ABANDONED_AFTER_MS = 60 * 60 * 1000;
const DECODE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CACHE_BYTES = 2 * 1024 ** 3;
// The last time a folder was requested is also saved as timeline.json's modification time, so the
// order survives a restart. It is saved at most this often per folder.
const SAVE_USE_EVERY_MS = 60 * 1000;
// A folder requested within this time is kept even when the cache is over its budget, so two GIFs
// that do not fit together are not decoded again and again while someone switches between them.
const RECENTLY_USED_MS = 60 * 1000;
// Recently requested folders never take the cache past this many times its budget.
const MAX_OVER_BUDGET = 2;

/** The cache's byte budget: KINO_GIF_FRAME_CACHE_BYTES when it is a positive whole number, otherwise 2 GiB. */
export function frameCacheBudget(value = process.env.KINO_GIF_FRAME_CACHE_BYTES) {
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : DEFAULT_CACHE_BYTES;
}

/** Writes a duration exactly: "1.5 seconds", "1 second", "120 seconds". */
function secondsText(milliseconds) {
  const seconds = milliseconds / 1000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function cacheError(message, code, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

/** Reads the pixel size stored in a PNG file's header. */
async function pngSize(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

/** Total size in bytes of the files directly inside `folder`. */
async function folderBytes(folder) {
  let total = 0;
  for (const name of await readdir(folder)) total += (await stat(join(folder, name))).size;
  return total;
}

/** The part of timeline.json that callers see. */
function publicTimeline({ count, durations, width, height }) {
  return { count, durations, width, height };
}

/**
 * @param cacheRoot folder that holds one sub-folder of frames per GIF (not the media folder).
 * @param decode replaceable for tests; defaults to decodeGifFrames from media-probe.mjs.
 *   It is called as decode(sourcePath, outDir, { signal, maxBytes }).
 * @param slots the decode slot limit; defaults to the process-wide gifDecodeSlots. Tests pass their own.
 * @param decodeTimeoutMs, maxBytes (the cache's byte budget) and recentlyUsedMs are replaceable for tests.
 */
export function createGifFrameCache(cacheRoot, {
  decode = decodeGifFrames,
  slots = gifDecodeSlots,
  decodeTimeoutMs = DECODE_TIMEOUT_MS,
  maxBytes = frameCacheBudget(),
  recentlyUsedMs = RECENTLY_USED_MS,
} = {}) {
  const partialRoot = join(cacheRoot, PARTIAL_FOLDER);
  // One timeline promise per GIF, so concurrent requests share one decode.
  const timelines = new Map();
  // GIFs whose folder is being read, decoded or replaced right now. Their folders are never removed.
  const building = new Set();
  // For each GIF: { at, savedAt }, when it was last requested and when that was last saved to disk (ms).
  const uses = new Map();
  // GIFs that can never be decoded (too large or undecodable), by file, with their error.
  // The media file never changes, so asking again would only repeat the same failed decode.
  const failures = new Map();
  let swept = false;
  // Budget checks run one at a time.
  let trimming = Promise.resolve();
  // When the next request should check the budget again (ms): at once after a start, then only while
  // recently requested folders keep the cache over its budget.
  let trimAgainAt = 0;

  /** Decodes with a time limit; a decode that runs too long is stopped and reported as timed out. */
  async function decodeWithTimeout(sourcePath, outDir) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), decodeTimeoutMs);
    try {
      return await decode(sourcePath, outDir, { signal: controller.signal, maxBytes });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      throw cacheError(`Decoding the GIF took longer than ${secondsText(decodeTimeoutMs)}.`, "GIF_DECODE_TIMEOUT", error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function removeAbandonedDecodes() {
    if (swept) return;
    swept = true;
    for (const name of await readdir(partialRoot).catch(() => [])) {
      const folder = join(partialRoot, name);
      const info = await stat(folder).catch(() => null);
      if (info && Date.now() - info.mtimeMs > ABANDONED_AFTER_MS) await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * Reads a finished folder's timeline.json. Resolves with null when the folder has no usable timeline:
   * it is missing or damaged, or was written by another decoder version.
   */
  async function readSaved(file) {
    try {
      const saved = JSON.parse(await readFile(join(cacheRoot, file, TIMELINE_FILE), "utf8"));
      return saved?.decoder === GIF_DECODER_VERSION && Number.isSafeInteger(saved.bytes) ? saved : null;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /**
   * Remembers a timeline promise. A failed decode is forgotten, so the next request tries again,
   * unless the GIF is too large or undecodable: that answer is kept until the server restarts.
   */
  function remember(file, promise) {
    timelines.set(file, promise);
    promise.catch((error) => {
      if (timelines.get(file) === promise) timelines.delete(file);
      if (error?.code === "GIF_TOO_LARGE" || error?.code === "GIF_UNREADABLE") failures.set(file, error);
    });
    return promise;
  }

  /**
   * Resolves with the GIF's timeline, decoding its frames first when there is no usable folder.
   * `replace` decodes again even when a folder exists (some of its files went missing).
   */
  async function build(file, sourcePath, { replace = false } = {}) {
    building.add(file);
    try {
      if (!replace) {
        const saved = await readSaved(file);
        if (saved) return publicTimeline(saved);
      }
      // Whatever is there cannot be used: frames from an older decoder, or a folder with missing files.
      await rm(join(cacheRoot, file), { recursive: true, force: true });
      await mkdir(partialRoot, { recursive: true, mode: 0o700 });
      await removeAbandonedDecodes();
      const temporary = await mkdtemp(join(partialRoot, `${file}-`));
      try {
        const { durations } = await slots.run(() => decodeWithTimeout(sourcePath, temporary));
        const { width, height } = await pngSize(join(temporary, gifFrameFileName(0)));
        const bytes = await folderBytes(temporary);
        const saved = { decoder: GIF_DECODER_VERSION, count: durations.length, durations, width, height, bytes };
        // The timeline is written last, so a folder with a timeline always has every frame.
        await writeFile(join(temporary, TIMELINE_FILE), JSON.stringify(saved), { mode: 0o600 });
        try {
          await rename(temporary, join(cacheRoot, file));
        } catch (error) {
          // Another server process finished the same GIF first. Its frames are identical, so use them.
          if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
          const theirs = await readSaved(file);
          if (!theirs) throw error;
          return publicTimeline(theirs);
        }
        // This GIF is still in `building`, so the budget check never removes the folder just made.
        await keepWithinBudget();
        return publicTimeline(saved);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    } finally {
      building.delete(file);
    }
  }

  /** Removes one GIF's folder unless it is being built. Requests that already opened a frame keep reading it. */
  async function removeFolder(file) {
    if (building.has(file)) return false;
    timelines.delete(file);
    uses.delete(file);
    await rm(join(cacheRoot, file), { recursive: true, force: true });
    return true;
  }

  /**
   * Removes the folders requested least recently until the cache fits its budget.
   * Folders without a usable timeline are removed too, since they are never served as they are.
   */
  async function removeLeastRecentlyUsed() {
    const candidates = [];
    let total = 0;
    const files = await readdir(cacheRoot).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files) {
      if (file === PARTIAL_FOLDER) continue;
      const saved = await readSaved(file);
      if (!saved) {
        await removeFolder(file);
        continue;
      }
      total += saved.bytes;
      if (building.has(file)) continue;
      const savedUse = await stat(join(cacheRoot, file, TIMELINE_FILE)).then((info) => info.mtimeMs, () => 0);
      candidates.push({ file, bytes: saved.bytes, usedAt: uses.get(file)?.at ?? savedUse });
    }
    candidates.sort((first, second) => first.usedAt - second.usedAt);
    const recent = Date.now() - recentlyUsedMs;
    // The oldest recently requested folder that keeps the cache over its budget.
    let keptRecent = null;
    for (const { file, bytes, usedAt } of candidates) {
      if (total <= maxBytes) break;
      if (usedAt > recent && total <= maxBytes * MAX_OVER_BUDGET) {
        keptRecent = usedAt;
        break;
      }
      if (await removeFolder(file)) total -= bytes;
    }
    trimAgainAt = keptRecent === null ? Infinity : keptRecent + recentlyUsedMs;
  }

  function keepWithinBudget() {
    trimming = trimming.then(removeLeastRecentlyUsed).catch((error) => {
      // The decode itself succeeded, so the request still gets its frames. A later request tries again.
      trimAgainAt = Date.now() + recentlyUsedMs;
      console.warn(`[kino] Could not trim the GIF frame cache: ${error.message}`);
    });
    return trimming;
  }

  function markUsed(file) {
    const now = Date.now();
    const use = uses.get(file) ?? { at: now, savedAt: 0 };
    use.at = now;
    if (now - use.savedAt > SAVE_USE_EVERY_MS) {
      use.savedAt = now;
      // A folder that does not exist yet gets its time when it is written.
      utimes(join(cacheRoot, file, TIMELINE_FILE), now / 1000, now / 1000).catch(() => {});
    }
    uses.set(file, use);
  }

  /**
   * Resolves with { count, durations, width, height } for an uploaded GIF,
   * decoding its frames first when they are not cached yet.
   */
  function timeline(file, sourcePath) {
    if (failures.has(file)) return Promise.reject(failures.get(file));
    markUsed(file);
    if (Date.now() >= trimAgainAt) {
      trimAgainAt = Infinity;
      keepWithinBudget();
    }
    return timelines.get(file) ?? remember(file, build(file, sourcePath));
  }

  /** Path of one decoded frame. Call timeline() first so the frame exists. */
  function framePath(file, index) {
    return join(cacheRoot, file, gifFrameFileName(index));
  }

  /**
   * Opens one decoded frame for reading and resolves with its FileHandle (the caller closes it),
   * or with null when the GIF has no frame `index`. When the frame's folder was removed after its
   * timeline was read (to stay within the budget, or by a disk cleanup), the GIF is decoded again, once.
   * If the frame is still missing after that, it rejects with code GIF_FRAMES_MISSING.
   */
  async function openFrame(file, sourcePath, index) {
    for (let attempt = 1; ; attempt += 1) {
      const promise = timeline(file, sourcePath);
      const { count } = await promise;
      if (!Number.isInteger(index) || index < 0 || index >= count) return null;
      try {
        return await open(framePath(file, index), "r");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (attempt > 1) throw cacheError(`Frame ${index} of ${file} is missing even after decoding the GIF again.`, "GIF_FRAMES_MISSING", error);
      }
      // Another request may have started the new decode already; then this one waits for it.
      if (timelines.get(file) === promise) remember(file, build(file, sourcePath, { replace: true }));
    }
  }

  return { timeline, framePath, openFrame };
}
