// Video pictures kept between check renders (renderSceneFrames: check's contrast and flashing
// rules and reference_drift) and look renders (renderStills: sheets, frames and strips). Nearly all of a check's time is FFmpeg decoding footage: each
// render runs it again for every video layer, from the keyframe before each stretch (8 s apart in
// phone footage), even when the video and its timing have not changed (an agent moved a caption).
// The pictures a check render drew are kept in memory, keyed by everything that decides them,
// and the next render with the same key reads them instead.
import { stat } from "node:fs/promises";

// The most picture bytes kept (PNG files at check sizes: tens of KB each).
const MAX_BYTES = 256 * 1024 * 1024;
// The most one video layer's pictures may take to be kept: a look at full size draws uncompressed
// 6 MB pictures, and a strip of 36 of them would push everything else out.
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/** A cache of check and look pictures, newest last, within `maxBytes`. */
export function createCheckPictures({ maxBytes = MAX_BYTES, maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
  // key → { end, pictures: Map(sampleKey → PNG bytes), bytes }
  const entries = new Map();
  let total = 0;

  /**
   * The key for a video layer's pictures: the file (its path, size and change time), the picture
   * size and decoding, and the source times the layer shows with whether each plays.
   */
  async function keyFor(videoPath, { needed, width, height, fps, decoderArgs, design, limits }) {
    const info = await stat(videoPath);
    return JSON.stringify([videoPath, info.size, info.mtimeMs, width, height, fps, decoderArgs, design, limits ?? null,
      needed.map((item) => [item.time, item.playing])]);
  }

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  function set(key, end, pictures) {
    if (entries.has(key)) { total -= entries.get(key).bytes; entries.delete(key); }
    let bytes = 0;
    for (const buffer of pictures.values()) bytes += buffer.byteLength;
    if (bytes > Math.min(maxBytes, maxEntryBytes)) return;
    entries.set(key, { end, pictures, bytes });
    total += bytes;
    for (const [oldKey, old] of entries) {
      if (total <= maxBytes) break;
      entries.delete(oldKey);
      total -= old.bytes;
    }
  }

  return { keyFor, get, set, maxEntryBytes: Math.min(maxBytes, maxEntryBytes) };
}

// The one cache the server's check renders share.
export const checkPictures = createCheckPictures();
