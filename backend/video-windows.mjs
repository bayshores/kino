// A long export's video pictures, made a window of output frames at a time.
//
// An export draws a video layer from PNG pictures that FFmpeg extracts from the file
// (export.mjs extractVideoFrames). Extracting every picture first filled the temporary folder
// with the whole video: five minutes of full-frame 1080p is thousands of large PNG files. Here the
// output frames are cut into windows (say 180 frames each). A window's pictures are extracted into
// a folder of their own just before its frames are drawn, and the folder is deleted as soon as its
// last frame is drawn. While one window is drawn, FFmpeg already extracts the next, so drawing does
// not wait for it. At most two windows are on disk at once.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bookkeeping for the windows of an export of `frameCount` frames.
 * `extract(first, end, folder)` makes the pictures that output frames first … end − 1 show in
 * `folder` (already made) and returns what the renderer reads for them.
 * - `picturesFor(index)` returns (a promise of) that for the window that holds output frame `index`.
 *   Ask for frames in order, at most `windowFrames` at a time (export.mjs orderedFrames draws one
 *   more frame than there are raster workers, and never more than a window holds); the next window
 *   starts as soon as the one before this one is gone.
 * - `done(index)` says frame `index` is drawn. When every frame of a window is drawn, its folder is
 *   deleted and the window after the next one starts.
 * - `close()` waits for extractions and deletions still running (after a cancel, for example), so
 *   the export can remove its temporary folder.
 */
export function videoWindows({ directory, frameCount, windowFrames, extract }) {
  const count = Math.ceil(frameCount / windowFrames);
  // Window number → { ready (promise of what extract returned), left (frames not drawn yet), folder }.
  const windows = new Map();
  const removals = new Set();
  let closed = false;

  function start(number) {
    if (closed || number < 0 || number >= count || windows.has(number)) return;
    const first = number * windowFrames;
    const end = Math.min(frameCount, first + windowFrames);
    const folder = join(directory, `video-window-${number}`);
    // A window starts once the folders of the windows before it are deleted, so there are never
    // more than two on disk, and once the window before it is extracted, so FFmpeg extracts one
    // window at a time and the first frames do not wait for the second window.
    const before = windows.get(number - 1)?.ready;
    const ready = Promise.allSettled([...removals, ...(before ? [before] : [])])
      .then(() => mkdir(folder, { mode: 0o700 }))
      .then(() => extract(first, end, folder));
    // A failure is reported to the frame that waits for this window, not as an unhandled rejection.
    ready.catch(() => {});
    windows.set(number, { ready, left: end - first, folder });
  }

  return {
    picturesFor(index) {
      const number = Math.floor(index / windowFrames);
      start(number);
      if (!windows.has(number - 1)) start(number + 1);
      return windows.get(number)?.ready ?? Promise.reject(new Error(`No video window for frame ${index}.`));
    },

    done(index) {
      const number = Math.floor(index / windowFrames);
      const window = windows.get(number);
      if (!window || --window.left > 0) return;
      windows.delete(number);
      const removal = window.ready.catch(() => {}).then(() => rm(window.folder, { recursive: true, force: true }));
      removals.add(removal);
      removal.finally(() => removals.delete(removal)).catch(() => {});
      if (windows.has(number + 1)) start(number + 2);
    },

    async close() {
      closed = true;
      await Promise.allSettled([...[...windows.values()].map((window) => window.ready), ...removals]);
    },
  };
}
