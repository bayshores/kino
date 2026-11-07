import test from "node:test";
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import {
  MAX_EMBEDDED_GIF_PIXELS,
  createGifFrameCache,
  createRetryTimer,
  decodeEmbeddedGif,
  frameTimeline,
  hasFrameTimeline,
  hasServerFrames,
  preloadCount,
} from "./gifFrames.js";
import { renderSceneSvg } from "../engine/render.js";
import { createLayer, createScene } from "../engine/model.js";

const SRC = "/api/media/0f8fad5b-d9cb-469f-a165-70867728950e.gif";
const OTHER = "/api/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.gif";

test("a frame timeline lists one PNG URL per frame and rejects incomplete data", () => {
  const timeline = frameTimeline(SRC, { durations: [0.1, 0.2], count: 2, width: 4, height: 4 }, (url) => `${url}?share=abc`);
  assert.deepEqual(timeline, {
    durations: [0.1, 0.2],
    frames: [`${SRC}/frames/0.png?share=abc`, `${SRC}/frames/1.png?share=abc`],
    width: 4,
    height: 4,
  });
  assert.throws(() => frameTimeline(SRC, { durations: [0.1], count: 2, width: 4, height: 4 }), /every frame/);
  assert.throws(() => frameTimeline(SRC, { durations: [], count: 0, width: 4, height: 4 }), /every frame/);
  assert.throws(() => frameTimeline(SRC, { durations: [-1], count: 1, width: 4, height: 4 }), /invalid frame delay/);
  assert.throws(() => frameTimeline(SRC, { durations: [0.1], count: 1 }), /picture size/, "the size is needed for the preload budget");
  assert.throws(() => frameTimeline(SRC, { durations: [0.1], count: 1, width: 0, height: 4 }), /picture size/);
  assert.equal(hasServerFrames(SRC), true);
  assert.equal(hasServerFrames("data:image/gif;base64,R0lGOD"), false);
  assert.equal(hasServerFrames("/api/media/still.png"), false);
  assert.equal(hasFrameTimeline(SRC), true);
  assert.equal(hasFrameTimeline("data:image/gif;base64,R0lGOD"), true, "embedded GIFs are decoded in the editor");
  assert.equal(hasFrameTimeline("data:image/png;base64,iVBOR"), false);
});

test("the GIF frame cache fetches each source once, preloads every frame, and retries failures after a delay", async () => {
  const fetched = [];
  const preloaded = [];
  let clock = 0;
  let broken = true;
  const cache = createGifFrameCache({
    fetchTimeline: async (src) => {
      fetched.push(src);
      if (src.includes("broken") && broken) throw new Error("missing");
      return { durations: [0.1, 0.1, 0.3], count: 3, width: 10, height: 10 };
    },
    preloadFrame: async (url) => { preloaded.push(url); },
    now: () => clock,
  });
  const first = cache.load(SRC);
  const second = cache.load(SRC);
  assert.equal(cache.get(SRC), undefined, "still loading");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.deepEqual(fetched, [SRC], "concurrent requests share one fetch");
  assert.deepEqual(preloaded, [0, 1, 2].map((index) => `${SRC}/frames/${index}.png`));
  assert.equal(cache.get(SRC), a);
  await cache.load(SRC);
  assert.equal(fetched.length, 1, "a loaded timeline is reused");

  const BROKEN = "/api/media/broken.gif";
  assert.equal(await cache.load(BROKEN), null, "a failed source keeps the original GIF for now");
  assert.equal(cache.get(BROKEN), undefined, "a failure is not cached as a result");
  assert.equal(cache.retryDelay(BROKEN), 1000);
  assert.equal(cache.retryAt(BROKEN), 1000);
  assert.equal(await cache.load(BROKEN), null);
  assert.equal(fetched.filter((src) => src === BROKEN).length, 1, "no new request before the retry delay");
  clock = 1000;
  assert.equal(await cache.load(BROKEN), null);
  assert.equal(fetched.filter((src) => src === BROKEN).length, 2, "tried again after the delay");
  assert.equal(cache.retryDelay(BROKEN), 2000, "the delay doubles after each failure");
  clock = 3000;
  broken = false;
  const recovered = await cache.load(BROKEN);
  assert.deepEqual(recovered.durations, [0.1, 0.1, 0.3], "a source that works again gets its frames");
  assert.equal(cache.get(BROKEN), recovered);
  assert.equal(cache.retryDelay(BROKEN), 0);
  assert.equal(cache.retryAt(BROKEN), undefined);

  let frameFails = true;
  const failingFrames = createGifFrameCache({
    fetchTimeline: async () => ({ durations: [0.1, 0.1], count: 2, width: 10, height: 10 }),
    preloadFrame: async (url) => { if (url.endsWith("1.png") && frameFails) throw new Error("frame failed"); },
    now: () => clock,
  });
  assert.equal(await failingFrames.load(SRC), null, "a frame that cannot load falls back to the GIF");
  clock += 1000;
  frameFails = false;
  assert.equal((await failingFrames.load(SRC)).frames.length, 2, "and loads on the next attempt");

  let slowClock = 0;
  const capped = createGifFrameCache({ fetchTimeline: async () => { throw new Error("down"); }, preloadFrame: async () => {}, now: () => slowClock });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await capped.load(SRC);
    slowClock += capped.retryDelay(SRC);
  }
  assert.equal(capped.retryDelay(SRC) || 30_000, 30_000);
  await capped.load(SRC);
  assert.equal(capped.retryDelay(SRC), 30_000, "retries are at most 30 s apart");
});

test("only a GIF's first frames up to the preload pixel budget are preloaded; the rest load when shown", async () => {
  assert.equal(preloadCount({ frames: Array(10), width: 4000, height: 4000 }), 4, "4 x 16 million pixels fit in 64 million");
  assert.equal(preloadCount({ frames: Array(3), width: 10, height: 10 }), 3);
  assert.equal(preloadCount({ frames: Array(5), width: 100, height: 100 }, 5_000), 1, "at least the first frame");

  const preloaded = [];
  const cache = createGifFrameCache({
    fetchTimeline: async () => ({ durations: Array(10).fill(0.1), count: 10, width: 4000, height: 4000 }),
    preloadFrame: async (url) => { preloaded.push(url); },
  });
  const timeline = await cache.load(SRC);
  assert.equal(timeline.frames.length, 10, "the timeline still lists every frame");
  assert.deepEqual(preloaded, [0, 1, 2, 3].map((index) => `${SRC}/frames/${index}.png`));
});

// A GIF with a `width` x `height` canvas and `count` frames that each paint one red pixel at the top left.
// The file stays tiny however large its canvas is, like the GIFs that blew up the editor's memory.
function pixelFramesGif(width, height, count) {
  const u16 = (value) => [value & 255, value >> 8];
  const frame = [
    0x21, 0xf9, 4, 0x04, 10, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
  ];
  const bytes = [
    ..."GIF89a".split("").map((char) => char.charCodeAt(0)), ...u16(width), ...u16(height), 0x80, 0, 0,
    255, 0, 0, 0, 0, 255,
    ...Array.from({ length: count }, () => frame).flat(),
    0x3b,
  ];
  return `data:image/gif;base64,${Buffer.from(bytes).toString("base64")}`;
}

// Browser-style object URLs (blob:<origin>/<uuid>) for real Blobs, so the renderer accepts them.
// resolveObjectURL reads Node's own blob: URLs, which shows whether a URL has been revoked.
function browserUrls() {
  const node = new Map();
  return {
    createUrl: (blob) => {
      const url = `blob:http://localhost:5173/${crypto.randomUUID()}`;
      node.set(url, URL.createObjectURL(blob));
      return url;
    },
    revokeUrl: (url) => URL.revokeObjectURL(node.get(url)),
    isLive: (url) => resolveObjectURL(node.get(url)) !== undefined,
  };
}

// A 2 x 1 GIF: frame 0 is red then a clear pixel, frame 1 draws blue over the clear pixel only.
const EMBEDDED = `data:image/gif;base64,${Buffer.from([
  ..."GIF89a".split("").map((char) => char.charCodeAt(0)), 2, 0, 1, 0, 0x81, 0, 0,
  255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0,
  0x21, 0xf9, 4, 0x05, 50, 0, 3, 0, 0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x44, 0x0b, 0,
  0x21, 0xf9, 4, 0x05, 1, 0, 3, 0, 0x2c, 1, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0,
  0x3b,
]).toString("base64")}`;

test("an embedded data: GIF is decoded in the editor into blob: frame URLs the renderer draws", async () => {
  const urls = browserUrls();
  const encoded = [];
  const timeline = await decodeEmbeddedGif(EMBEDDED, async (rgba, width, height) => {
    encoded.push([width, height, [...rgba]]);
    return new Blob([Uint8Array.from(rgba)], { type: "image/png" });
  }, urls);
  assert.deepEqual(timeline.durations, [0.5, 0.1]);
  assert.equal(timeline.frames.length, 2);
  assert.deepEqual([timeline.width, timeline.height], [2, 1]);
  for (const url of timeline.frames) {
    assert.match(url, /^blob:/, "frames are object URLs, not base64 data: strings");
    assert.equal(urls.isLive(url), true);
  }
  assert.deepEqual(encoded[0], [2, 1, [255, 0, 0, 255, 0, 0, 0, 0]]);
  assert.deepEqual(encoded[1], [2, 1, [255, 0, 0, 255, 0, 0, 255, 255]], "frame 1 keeps frame 0 underneath");

  const preloaded = [];
  const cache = createGifFrameCache({
    fetchTimeline: () => assert.fail("embedded GIFs never ask the server"),
    preloadFrame: async (url) => { preloaded.push(url); },
    decodeEmbedded: (src, signal) => decodeEmbeddedGif(src, async () => new Blob(["png"]), { signal, ...urls }),
  });
  const loaded = await cache.load(EMBEDDED);
  assert.equal(loaded.frames.length, 2);
  assert.deepEqual(preloaded, loaded.frames);
  assert.equal(cache.get(EMBEDDED), loaded);

  const layer = createLayer("image", { id: "gif", src: EMBEDDED, width: 2, height: 1, mediaStart: 1, mediaDuration: 2 });
  const scene = createScene({ duration: 5, layers: [layer] });
  const href = (time) => /href="([^"]+)"/.exec(renderSceneSvg(scene, time, { imageFrames: new Map([["gif", timeline]]) }))?.[1];
  assert.equal(href(1.2), timeline.frames[0]);
  assert.equal(href(1.55), timeline.frames[1], "frame 1 starts after frame 0's 0.5 s delay");
  assert.equal(href(1.65), timeline.frames[0], "the GIF loops by its delays (0.6 s total)");
});

test("an embedded GIF over the editor budget is never decoded and keeps showing the GIF file", async () => {
  // 2000 x 2000 x 12 frames is 48 million pixels: inside the budget. One more frame is over it.
  assert.ok(2000 * 2000 * 12 <= MAX_EMBEDDED_GIF_PIXELS && 2000 * 2000 * 13 > MAX_EMBEDDED_GIF_PIXELS);
  let encodes = 0;
  const encode = async () => { encodes += 1; return new Blob(["png"]); };
  const urls = browserUrls();
  const inside = await decodeEmbeddedGif(pixelFramesGif(2000, 2000, 12), encode, urls);
  assert.equal(inside.frames.length, 12);
  assert.equal(encodes, 12);

  encodes = 0;
  assert.equal(await decodeEmbeddedGif(pixelFramesGif(2000, 2000, 13), encode, urls), null);
  // The memory repro: a few kilobytes of file for 1000 frames of 400 x 400 (160 million pixels).
  assert.equal(await decodeEmbeddedGif(pixelFramesGif(400, 400, 1000), encode, urls), null);
  assert.equal(encodes, 0, "no frame was composed or encoded");

  let clock = 0;
  let decodes = 0;
  const cache = createGifFrameCache({
    fetchTimeline: () => assert.fail("embedded GIFs never ask the server"),
    preloadFrame: async () => {},
    decodeEmbedded: (src, signal) => { decodes += 1; return decodeEmbeddedGif(src, encode, { signal, ...urls }); },
    now: () => clock,
  });
  const LARGE = pixelFramesGif(400, 400, 1000);
  const BROKEN = "data:image/gif;base64,AAAA";
  assert.equal(await cache.load(LARGE), null);
  assert.equal(await cache.load(BROKEN), null, "a data: URL that is not a GIF is not decoded either");
  assert.equal(cache.get(LARGE), undefined, "no frame timeline: the canvas shows the GIF file");
  assert.equal(cache.retryAt(LARGE), undefined, "this is not a failure that waits for a retry");
  assert.equal(cache.retryAt(BROKEN), undefined);
  clock = 60_000;
  assert.equal(await cache.load(LARGE), null);
  assert.equal(await cache.load(BROKEN), null);
  assert.equal(decodes, 2, "the decision is kept: the same bytes are not parsed again");
  assert.equal(encodes, 0);
});

test("keepOnly releases GIFs the document no longer uses, revokes blob: URLs, and cancels an unfinished decode", async () => {
  const urls = browserUrls();
  const released = [];
  let gate;
  let encodes = 0;
  let waitAtFrame = -1;
  const cache = createGifFrameCache({
    fetchTimeline: async () => ({ durations: [0.1, 0.1, 0.1], count: 3, width: 10, height: 10 }),
    preloadFrame: async () => {},
    releaseFrame: (url) => {
      released.push(url);
      if (url.startsWith("blob:")) urls.revokeUrl(url);
    },
    decodeEmbedded: (src, signal) => decodeEmbeddedGif(src, async () => {
      encodes += 1;
      if (encodes - 1 === waitAtFrame) await new Promise((resolve) => { gate = resolve; });
      return new Blob(["png"]);
    }, { signal, ...urls }),
  });

  // A loaded embedded GIF and a loaded uploaded GIF.
  const SMALL = pixelFramesGif(4, 4, 3);
  const embedded = await cache.load(SMALL);
  const uploaded = await cache.load(SRC);
  assert.ok(embedded.frames.every(urls.isLive));
  cache.keepOnly(new Set([SRC]));
  assert.equal(cache.get(SMALL), undefined, "the released GIF has no frames now");
  assert.deepEqual(released, embedded.frames);
  assert.equal(embedded.frames.some(urls.isLive), false, "its blob: URLs are revoked");
  assert.equal(cache.get(SRC), uploaded, "a GIF the document still uses is kept");

  released.length = 0;
  cache.keepOnly(new Set());
  assert.deepEqual(released, uploaded.frames, "the uploaded GIF's preloaded frames are dropped too");
  assert.equal(cache.get(SRC), undefined);

  // A decode that is still running when its layer is removed stops between frames.
  encodes = 0;
  waitAtFrame = 2;
  const LONG = pixelFramesGif(4, 4, 8);
  const loading = cache.load(LONG);
  while (!gate) await new Promise((resolve) => setTimeout(resolve, 1));
  cache.keepOnly(new Set());
  gate();
  assert.equal(await loading, null);
  assert.equal(encodes, 3, "frames 3 to 7 were never decoded");
  assert.equal(cache.get(LONG), undefined);
  assert.equal(cache.retryAt(LONG), undefined, "a cancelled decode is not a failure");

  // Removing a layer and adding it back (undo) decodes the GIF again.
  encodes = 0;
  waitAtFrame = -1;
  const again = await cache.load(LONG);
  assert.equal(again.frames.length, 8);
  assert.equal(encodes, 8);
});

test("a decode that is cancelled or fails revokes the blob: URLs it already made", async () => {
  const urls = browserUrls();
  const made = [];
  const tracked = { ...urls, createUrl: (blob) => { const url = urls.createUrl(blob); made.push(url); return url; } };
  const controller = new AbortController();
  await assert.rejects(decodeEmbeddedGif(pixelFramesGif(4, 4, 5), async () => {
    if (made.length === 2) controller.abort();
    return new Blob(["png"]);
  }, { signal: controller.signal, ...tracked }), { name: "AbortError" });
  assert.equal(made.length, 3);
  assert.equal(made.some(urls.isLive), false);

  made.length = 0;
  await assert.rejects(decodeEmbeddedGif(pixelFramesGif(4, 4, 5), async () => {
    if (made.length === 3) throw new Error("A GIF frame could not be encoded.");
    return new Blob(["png"]);
  }, tracked), /could not be encoded/);
  assert.equal(made.length, 3);
  assert.equal(made.some(urls.isLive), false);
});

test("keepOnly stops preloading an uploaded GIF's frames and cancels its timeline request", async () => {
  const started = [];
  const released = [];
  let finishPreloads;
  const preloadsWait = new Promise((resolve) => { finishPreloads = resolve; });
  const cache = createGifFrameCache({
    fetchTimeline: async () => ({ durations: Array(10).fill(0.1), count: 10, width: 10, height: 10 }),
    preloadFrame: async (url) => { started.push(url); await preloadsWait; },
    releaseFrame: (url) => released.push(url),
  });
  const loading = cache.load(SRC);
  while (started.length < 6) await new Promise((resolve) => setTimeout(resolve, 1));
  cache.keepOnly(new Set());
  finishPreloads();
  assert.equal(await loading, null);
  assert.equal(started.length, 6, "the first six were already loading; no frame started after the release");
  assert.equal(released.length, 10, "every frame URL of the released GIF is let go");

  let requestSignal;
  const pending = createGifFrameCache({
    fetchTimeline: (src, signal) => {
      requestSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    },
    preloadFrame: async () => assert.fail("nothing is preloaded after the release"),
  });
  const request = pending.load(OTHER);
  pending.keepOnly(new Set());
  assert.equal(requestSignal.aborted, true);
  assert.equal(await request, null);
  assert.equal(pending.retryAt(OTHER), undefined);
});

test("one retry timer fires at the earliest retry time among all failing GIF sources", async () => {
  let clock = 0;
  const timers = [];
  let retries = 0;
  const retryTimer = createRetryTimer(() => { retries += 1; }, {
    now: () => clock,
    setTimer: (run, delay) => {
      const timer = { run, at: clock + delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
  });
  const live = () => timers.filter((timer) => !timer.cleared);
  const cache = createGifFrameCache({ fetchTimeline: async () => { throw new Error("down"); }, preloadFrame: async () => {}, now: () => clock });

  // The first GIF has failed three times, so it waits 4 s (1 s, 2 s, 4 s backoff).
  await cache.load(SRC);
  clock = 1000;
  await cache.load(SRC);
  clock = 3000;
  await cache.load(SRC);
  assert.equal(cache.retryAt(SRC), 7000);
  retryTimer.schedule(cache.retryAt(SRC));
  assert.deepEqual(live().map((timer) => timer.at), [7000]);

  // A newly failing GIF may retry after 1 s: the timer moves earlier for it.
  await cache.load(OTHER);
  assert.equal(cache.retryAt(OTHER), 4000);
  retryTimer.schedule(cache.retryAt(OTHER));
  assert.deepEqual(live().map((timer) => timer.at), [4000], "one timer, at the earliest retry time");

  // A later time does not delay it.
  retryTimer.schedule(7000);
  assert.deepEqual(live().map((timer) => timer.at), [4000]);

  clock = 4000;
  live()[0].run();
  assert.equal(retries, 1);
  // After it fires, the next failure starts a new timer.
  retryTimer.schedule(7000);
  assert.deepEqual(live().filter((timer) => timer.at > 4000).map((timer) => timer.at), [7000]);
  retryTimer.cancel();
  assert.equal(live().filter((timer) => timer.at > 4000).length, 0, "cancel stops it");
});

test("a loaded timeline drives the GIF frame shown by the shared scene clock", async () => {
  const cache = createGifFrameCache({
    fetchTimeline: async () => ({ durations: [0.5, 0.5], count: 2, width: 10, height: 10 }),
    preloadFrame: async () => {},
  });
  const timeline = await cache.load(SRC);
  const layer = createLayer("image", { id: "gif", src: SRC, width: 10, height: 10, mediaStart: 1, mediaDuration: 3, mediaFreeze: "both" });
  const scene = createScene({ duration: 5, layers: [layer] });
  const at = (time, options = {}) => renderSceneSvg(scene, time, { imageFrames: new Map([["gif", timeline]]), ...options });
  assert.match(at(0), /frames\/0\.png/, "before Play the first frame is frozen");
  assert.match(at(1.6), /frames\/1\.png/);
  assert.match(at(2.2), /frames\/0\.png/, "the GIF loops by its delays");
  const still = createScene({ duration: 5, layers: [{ ...layer, mediaDuration: 0 }] });
  assert.match(renderSceneSvg(still, 1.6, { imageFrames: new Map([["gif", timeline]]) }), /frames\/0\.png/, "without Play the first frame shows");
});

test("frame URLs carry the server's decoder version, and GIFs the server refuses keep showing the GIF file", async () => {
  assert.deepEqual(frameTimeline(SRC, { durations: [0.1], count: 1, width: 4, height: 4, decoder: 1 }).frames, [`${SRC}/frames/0.png?decoder=1`]);
  assert.deepEqual(frameTimeline(SRC, { durations: [0.1], count: 1, width: 4, height: 4, decoder: "1" }).frames, [`${SRC}/frames/0.png`], "only a whole number is used");

  for (const status of [413, 422]) {
    let calls = 0;
    const cache = createGifFrameCache({
      fetchTimeline: async () => { calls += 1; throw Object.assign(new Error("refused"), { status }); },
      preloadFrame: async () => {},
      now: () => 1_000_000,
    });
    assert.equal(await cache.load(SRC), null);
    assert.equal(await cache.load(SRC), null);
    assert.equal(calls, 1, `${status} is not retried`);
    assert.equal(cache.retryAt(SRC), undefined, `${status} sets no retry time`);
  }
  for (const status of [500, 503]) {
    const busy = createGifFrameCache({
      fetchTimeline: async () => { throw Object.assign(new Error("busy"), { status }); },
      preloadFrame: async () => {},
      now: () => 0,
    });
    await busy.load(SRC);
    assert.equal(busy.retryAt(SRC), 1000, `a server problem (${status}) is retried later`);
  }
});
