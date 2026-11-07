// The stage's picture comes first. The timeline's shot thumbnails are frames from the same
// export renderer as the stage's picture, so on a slow computer (drawing on the CPU) a lane of
// them could keep the stage waiting. They load only once the stage has shown its first frame,
// and only while it is not waiting for a new frame and not playing, a few at a time, at the
// browser's low priority; the server draws them only while it draws no other frame (low=1, see
// GET /api/dashboard/frame). Plain code, tested in frontend/dashboardLanes.test.js; StagePane
// (panes.jsx) tells the queue about the stage, TimelineLanes (lanes.jsx) asks for the thumbnails.

// Thumbnails loading at once, at most.
export const MOST_LOADING = 2;
// Loaded addresses remembered, at most (each names a revision, so they never go stale).
const MOST_REMEMBERED = 2000;

/**
 * A queue of thumbnail addresses. `load(url)` loads one (a promise). The stage's state:
 * stage({ready, waiting, playing}); the thumbnails wanted now, in order: want(urls).
 * has(url) says whether one has loaded; subscribe(listener) hears each one that finishes.
 */
export function createThumbnailQueue({ load, most = MOST_LOADING }) {
  const stage = { ready: false, waiting: false, playing: false };
  const loaded = new Set();
  const failed = new Set();
  const active = new Set();
  const listeners = new Set();
  let wanted = [];
  const free = () => stage.ready && !stage.waiting && !stage.playing;
  const finish = (url, done) => {
    active.delete(url);
    done.add(url);
    if (done.size > MOST_REMEMBERED) done.delete(done.values().next().value);
    for (const listener of listeners) listener();
    pump();
  };
  function pump() {
    while (free() && active.size < most) {
      const url = wanted.find((entry) => !loaded.has(entry) && !failed.has(entry) && !active.has(entry));
      if (!url) return;
      active.add(url);
      Promise.resolve().then(() => load(url)).then(() => finish(url, loaded), () => finish(url, failed));
    }
  }
  return {
    stage(change) { Object.assign(stage, change); pump(); },
    want(urls) { wanted = [...urls]; pump(); },
    has: (url) => loaded.has(url),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    status: () => ({ ...stage, loading: active.size }),
  };
}

/** Loads one image at the browser's low priority; resolves once it is decoded. */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.fetchPriority = "low";
    image.decoding = "async";
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The thumbnail could not be drawn."));
    image.src = url;
  });
}

/** The dashboard's one queue. */
export const thumbnails = createThumbnailQueue({ load: loadImage });
