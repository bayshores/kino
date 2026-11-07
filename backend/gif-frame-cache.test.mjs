// The server's cache of decoded GIF frames (gif-frame-cache.mjs): shared decode slots, time limit,
// decoder versions, frames that disappear, and the disk budget. GIFs are decoded by kino's own
// decoder, so these tests need no FFmpeg.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIF_DECODER_VERSION } from "../engine/gifDecode.js";
import { createDecodeSlots, gifDecodeSlots } from "./gif-decode-slots.mjs";
import { createGifFrameCache, frameCacheBudget } from "./gif-frame-cache.mjs";
import { decodeGifFrames } from "./media-probe.mjs";
import { makeAnimatedGif, readImage } from "./media.test.support.mjs";

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-gif-frame-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Writes a small GIF with one solid color per frame and returns its path. */
async function writeGif(root, name, colors, { width = 6, height = 4 } = {}) {
  const path = join(root, name);
  await writeFile(path, makeAnimatedGif({ width, height, frames: colors.map((color) => ({ delayCs: 10, color })) }));
  return path;
}

/** Reads one frame through openFrame, the way the server sends it, and returns the picture. */
async function openedPicture(cache, file, source, index) {
  const handle = await cache.openFrame(file, source, index);
  assert.ok(handle, `frame ${index} of ${file} exists`);
  try {
    return await readImage(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/** Counts calls and wraps the real decoder. */
function countingDecoder() {
  const calls = [];
  const decode = async (path, outDir, options) => {
    calls.push(path);
    return decodeGifFrames(path, outDir, options);
  };
  return { decode, calls };
}

async function savedTimeline(cacheRoot, file) {
  return JSON.parse(await readFile(join(cacheRoot, file, "timeline.json"), "utf8"));
}

async function cachedFolders(cacheRoot) {
  return (await readdir(cacheRoot)).filter((name) => name !== ".partial").sort();
}

test("decodes wait for the GIF decode slots that exports share, unless a test passes its own", async (t) => {
  const root = await folder(t);
  const gif = await writeGif(root, "source.gif", [RED]);

  // Two exports holding both process-wide slots make the cache wait.
  let releaseExports;
  const exportsFinish = new Promise((resolve) => { releaseExports = resolve; });
  const exportDecodes = [1, 2].map(() => gifDecodeSlots.run(() => exportsFinish));
  let started = false;
  const cache = createGifFrameCache(join(root, "media-frames"), {
    decode: (path, outDir, options) => {
      started = true;
      return decodeGifFrames(path, outDir, options);
    },
  });
  const waiting = cache.timeline("shared.gif", gif);
  await wait(50);
  assert.equal(started, false, "the cache does not decode while exports use every slot");
  releaseExports();
  await Promise.all(exportDecodes);
  assert.equal((await waiting).count, 1);
  assert.equal(started, true);

  // A cache given its own slots uses only those: one slot means one decode at a time.
  let running = 0;
  let mostAtOnce = 0;
  const single = createGifFrameCache(join(root, "single-frames"), {
    slots: createDecodeSlots(1),
    decode: async (path, outDir, options) => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await wait(10);
      try {
        return await decodeGifFrames(path, outDir, options);
      } finally {
        running -= 1;
      }
    },
  });
  await Promise.all(["a.gif", "b.gif", "c.gif", "d.gif"].map((file) => single.timeline(file, gif)));
  assert.equal(mostAtOnce, 1);
});

test("a decode that runs too long is stopped, and the message gives the limit in exact seconds", async (t) => {
  const root = await folder(t);
  const gif = await writeGif(root, "source.gif", [RED]);
  // Waits until the cache cancels it, like a very large GIF would.
  const endless = (_path, _outDir, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
  const slots = createDecodeSlots(3);
  const limits = [[30, "0.03 seconds"], [1000, "1 second"], [1500, "1.5 seconds"]];
  await Promise.all(limits.map(async ([decodeTimeoutMs, text], index) => {
    const cacheRoot = join(root, `frames-${index}`);
    const cache = createGifFrameCache(cacheRoot, { decode: endless, slots, decodeTimeoutMs });
    await assert.rejects(cache.timeline("slow.gif", gif), {
      code: "GIF_DECODE_TIMEOUT",
      message: `Decoding the GIF took longer than ${text}.`,
    });
    assert.deepEqual(await readdir(join(cacheRoot, ".partial")), [], "a stopped decode leaves no temporary folder");
  }));
});

test("concurrent requests share one decode, and a restarted cache reads the finished folder", async (t) => {
  const root = await folder(t);
  const gif = await writeGif(root, "cached.gif", [RED, GREEN]);
  const cacheRoot = join(root, "media-frames");
  const { decode, calls } = countingDecoder();
  const cache = createGifFrameCache(cacheRoot, { decode });
  const timelines = await Promise.all(Array.from({ length: 5 }, () => cache.timeline("cached.gif", gif)));
  assert.equal(calls.length, 1, "five simultaneous first requests share one decode");
  for (const timeline of timelines) assert.deepEqual(timeline, { count: 2, durations: [0.1, 0.1], width: 6, height: 4 });
  assert.deepEqual((await readdir(cacheRoot)).sort(), [".partial", "cached.gif"]);
  assert.deepEqual(await readdir(join(cacheRoot, ".partial")), [], "the temporary folder was renamed into place");
  assert.deepEqual((await openedPicture(cache, "cached.gif", gif, 1)).pixel(0, 0), [...GREEN, 255]);
  assert.equal(await cache.openFrame("cached.gif", gif, 2), null, "a frame past the end does not exist");

  // timeline.json records the decoder version and the folder's size in bytes.
  const saved = await savedTimeline(cacheRoot, "cached.gif");
  const pngSizes = await Promise.all(["000000.png", "000001.png"].map(async (name) => (await stat(join(cacheRoot, "cached.gif", name))).size));
  assert.deepEqual(saved, {
    decoder: GIF_DECODER_VERSION, count: 2, durations: [0.1, 0.1], width: 6, height: 4, bytes: pngSizes[0] + pngSizes[1],
  });

  const restarted = createGifFrameCache(cacheRoot, { decode: () => assert.fail("a cached GIF is not decoded again") });
  assert.deepEqual(await restarted.timeline("cached.gif", gif), timelines[0]);

  const broken = join(root, "broken.gif");
  await writeFile(broken, Buffer.from("this is not a GIF"));
  await assert.rejects(cache.timeline("broken.gif", broken), { code: "GIF_UNREADABLE" });
  assert.deepEqual(await cachedFolders(cacheRoot), ["cached.gif"], "a failed decode leaves no frame folder");
  assert.deepEqual(await readdir(join(cacheRoot, ".partial")), []);
});

test("frames saved by an older decoder, or without a version, are decoded again", async (t) => {
  const root = await folder(t);
  const gif = await writeGif(root, "colors.gif", [RED, BLUE]);
  const cacheRoot = join(root, "media-frames");
  // Folders as an earlier decoder left them: wrong pixels (one green frame) and an old or missing version.
  const oldGreen = await writeGif(root, "old.gif", [GREEN]);
  const staleTimelines = {
    "no-version.gif": { count: 2, durations: [0.1, 0.1], width: 6, height: 4 },
    "old-version.gif": { decoder: GIF_DECODER_VERSION - 1, count: 2, durations: [0.1, 0.1], width: 6, height: 4, bytes: 10 },
    "newer-version.gif": { decoder: GIF_DECODER_VERSION + 1, count: 2, durations: [0.1, 0.1], width: 6, height: 4, bytes: 10 },
    "damaged.gif": "{ not json",
  };
  for (const [file, timeline] of Object.entries(staleTimelines)) {
    await mkdir(join(cacheRoot, file), { recursive: true });
    await decodeGifFrames(oldGreen, join(cacheRoot, file));
    await writeFile(join(cacheRoot, file, "000001.png"), await readFile(join(cacheRoot, file, "000000.png")));
    await writeFile(join(cacheRoot, file, "timeline.json"), typeof timeline === "string" ? timeline : JSON.stringify(timeline));
  }
  const { decode, calls } = countingDecoder();
  const cache = createGifFrameCache(cacheRoot, { decode });
  for (const file of Object.keys(staleTimelines)) {
    assert.deepEqual(await cache.timeline(file, gif), { count: 2, durations: [0.1, 0.1], width: 6, height: 4 });
    assert.deepEqual((await openedPicture(cache, file, gif, 0)).pixel(1, 1), [...RED, 255], `${file} shows the new decode`);
    assert.deepEqual((await openedPicture(cache, file, gif, 1)).pixel(1, 1), [...BLUE, 255]);
    assert.equal((await savedTimeline(cacheRoot, file)).decoder, GIF_DECODER_VERSION);
  }
  assert.equal(calls.length, 4, "each stale folder was decoded once");
});

test("a frame whose folder disappeared is decoded again once; a frame still missing after that is an error", async (t) => {
  const root = await folder(t);
  const gif = await writeGif(root, "colors.gif", [RED, GREEN, BLUE]);
  const cacheRoot = join(root, "media-frames");
  const { decode, calls } = countingDecoder();
  const cache = createGifFrameCache(cacheRoot, { decode });
  await cache.timeline("colors.gif", gif);
  // A disk cleanup removes the folder while the timeline is still remembered in memory.
  await rm(join(cacheRoot, "colors.gif"), { recursive: true });
  const pictures = await Promise.all([2, 1].map((index) => openedPicture(cache, "colors.gif", gif, index)));
  assert.deepEqual(pictures.map((picture) => picture.pixel(0, 0)), [[...BLUE, 255], [...GREEN, 255]]);
  assert.equal(calls.length, 2, "the two requests shared one new decode");

  // A decoder that reports two frames but writes only the first one.
  let decodes = 0;
  const lying = createGifFrameCache(join(root, "lying-frames"), {
    decode: async (path, outDir, options) => {
      decodes += 1;
      await decodeGifFrames(await writeGif(root, `one-${decodes}.gif`, [RED]), outDir, options);
      return { durations: [0.1, 0.1] };
    },
  });
  assert.deepEqual((await openedPicture(lying, "two.gif", gif, 0)).pixel(0, 0), [...RED, 255]);
  await assert.rejects(lying.openFrame("two.gif", gif, 1), { code: "GIF_FRAMES_MISSING" });
  assert.equal(decodes, 2, "the missing frame was decoded again once, not over and over");
});

test("the cache keeps within its byte budget by removing the folders requested least recently", async (t) => {
  const root = await folder(t);
  const sources = {
    "a.gif": await writeGif(root, "a.gif", [RED, GREEN]),
    "b.gif": await writeGif(root, "b.gif", [GREEN, BLUE]),
    "c.gif": await writeGif(root, "c.gif", [BLUE, RED]),
  };
  // Measure one folder, then allow a little more than two of them.
  const measure = createGifFrameCache(join(root, "measure"));
  await measure.timeline("a.gif", sources["a.gif"]);
  const folderBytes = (await savedTimeline(join(root, "measure"), "a.gif")).bytes;
  assert.ok(folderBytes > 0);

  const cacheRoot = join(root, "media-frames");
  const { decode, calls } = countingDecoder();
  // recentlyUsedMs 0: every folder may be removed, however recently it was requested.
  const cache = createGifFrameCache(cacheRoot, { decode, maxBytes: Math.floor(folderBytes * 2.5), recentlyUsedMs: 0 });
  await cache.timeline("a.gif", sources["a.gif"]);
  await wait(5);
  await cache.timeline("b.gif", sources["b.gif"]);
  await wait(5);
  await cache.timeline("a.gif", sources["a.gif"]);
  await wait(5);
  // c.gif does not fit beside a.gif and b.gif; b.gif was requested least recently.
  await cache.timeline("c.gif", sources["c.gif"]);
  assert.deepEqual(await cachedFolders(cacheRoot), ["a.gif", "c.gif"]);

  // A removed GIF is decoded again when it is requested, and its frames are right.
  assert.deepEqual((await openedPicture(cache, "b.gif", sources["b.gif"], 1)).pixel(0, 0), [...BLUE, 255]);
  assert.deepEqual(calls.length, 4);
  assert.deepEqual(await cachedFolders(cacheRoot), ["b.gif", "c.gif"], "a.gif was now the least recent");

  // After a restart the order comes from timeline.json's modification time.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(join(cacheRoot, "c.gif", "timeline.json"), old, old);
  const restarted = createGifFrameCache(cacheRoot, { maxBytes: Math.floor(folderBytes * 2.5), recentlyUsedMs: 0 });
  await restarted.timeline("a.gif", sources["a.gif"]);
  assert.deepEqual(await cachedFolders(cacheRoot), ["a.gif", "b.gif"]);
});

test("GIFs requested in the last minute are kept over the budget, so switching between them does not decode again", async (t) => {
  const root = await folder(t);
  const a = await writeGif(root, "a.gif", [RED, GREEN]);
  const b = await writeGif(root, "b.gif", [GREEN, BLUE]);
  const measure = createGifFrameCache(join(root, "measure"));
  await measure.timeline("a.gif", a);
  const folderBytes = (await savedTimeline(join(root, "measure"), "a.gif")).bytes;

  const cacheRoot = join(root, "media-frames");
  const { decode, calls } = countingDecoder();
  // Room for one folder only.
  const cache = createGifFrameCache(cacheRoot, { decode, maxBytes: Math.floor(folderBytes * 1.5) });
  // Both at the same time, then switching back and forth like an editor showing both GIFs.
  await Promise.all([cache.timeline("a.gif", a), cache.timeline("b.gif", b)]);
  for (let round = 0; round < 3; round += 1) {
    for (const [file, source] of [["a.gif", a], ["b.gif", b]]) (await cache.openFrame(file, source, 1)).close();
  }
  assert.equal(calls.length, 2, "each GIF was decoded once");
  assert.deepEqual(await cachedFolders(cacheRoot), ["a.gif", "b.gif"]);
});

test("recent GIFs take the cache to at most twice its budget, and a request after they stop being recent trims it back", async (t) => {
  const root = await folder(t);
  const sources = {};
  for (const name of ["a.gif", "b.gif", "c.gif"]) sources[name] = await writeGif(root, name, [RED, GREEN]);
  const measure = createGifFrameCache(join(root, "measure"));
  await measure.timeline("a.gif", sources["a.gif"]);
  const folderBytes = (await savedTimeline(join(root, "measure"), "a.gif")).bytes;

  const cacheRoot = join(root, "media-frames");
  const recentlyUsedMs = 300;
  // The budget holds one folder, so recent GIFs may fill two.
  const cache = createGifFrameCache(cacheRoot, { maxBytes: folderBytes, recentlyUsedMs });
  for (const name of ["a.gif", "b.gif"]) await cache.timeline(name, sources[name]);
  assert.deepEqual(await cachedFolders(cacheRoot), ["a.gif", "b.gif"], "two recent GIFs fit in twice the budget");
  await cache.timeline("c.gif", sources["c.gif"]);
  assert.deepEqual(await cachedFolders(cacheRoot), ["b.gif", "c.gif"], "a third removes the oldest even though it is recent");

  await wait(recentlyUsedMs + 50);
  await cache.timeline("c.gif", sources["c.gif"]);
  for (let tries = 0; tries < 40 && (await cachedFolders(cacheRoot)).length > 1; tries += 1) await wait(25);
  assert.deepEqual(await cachedFolders(cacheRoot), ["c.gif"], "without a new decode, the cache is back within its budget");
});

test("a GIF that is too large is not decoded again on every request", async (t) => {
  const root = await folder(t);
  const source = await writeGif(root, "a.gif", [RED, GREEN]);
  let decodes = 0;
  const decode = async () => {
    decodes += 1;
    const error = new Error("This GIF's decoded frames need more than 10 bytes of disk space.");
    error.code = "GIF_TOO_LARGE";
    throw error;
  };
  const cache = createGifFrameCache(join(root, "media-frames"), { decode });
  for (let request = 0; request < 3; request += 1) await assert.rejects(cache.timeline("a.gif", source), { code: "GIF_TOO_LARGE" });
  assert.equal(decodes, 1);
});

test("a GIF whose frames alone need more than the budget is stopped while decoding and leaves nothing", async (t) => {
  const root = await folder(t);
  // Noisy frames, so their PNG files cannot be compressed much.
  let seed = 1;
  const noise = () => Array.from({ length: 40 * 40 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return [RED, GREEN, BLUE][seed % 3];
  });
  const big = join(root, "big.gif");
  await writeFile(big, makeAnimatedGif({ width: 40, height: 40, frames: Array.from({ length: 6 }, () => ({ delayCs: 10, pixels: noise() })) }));
  const small = await writeGif(root, "small.gif", [RED]);
  const cacheRoot = join(root, "media-frames");
  // An abandoned temporary folder from a crash long ago is cleaned up by the next decode.
  const abandoned = join(cacheRoot, ".partial", "crashed.gif-abc123");
  await mkdir(abandoned, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(abandoned, old, old);

  const measure = createGifFrameCache(join(root, "measure"));
  await measure.timeline("small.gif", small);
  const smallBytes = (await savedTimeline(join(root, "measure"), "small.gif")).bytes;
  const cache = createGifFrameCache(cacheRoot, { maxBytes: smallBytes * 2 });
  await cache.timeline("small.gif", small);
  await assert.rejects(cache.timeline("big.gif", big), { code: "GIF_TOO_LARGE" });
  assert.deepEqual(await cachedFolders(cacheRoot), ["small.gif"], "the over-budget GIF has no folder, and the small one stays");
  assert.deepEqual(await readdir(join(cacheRoot, ".partial")), [], "the partial folder and the abandoned one are gone");
});

test("the budget is 2 GiB unless KINO_GIF_FRAME_CACHE_BYTES gives a positive whole number", () => {
  assert.equal(frameCacheBudget(undefined), 2 * 1024 ** 3);
  assert.equal(frameCacheBudget("500000000"), 500_000_000);
  for (const value of ["", "0", "-5", "1.5", "lots", "1e400"]) assert.equal(frameCacheBudget(value), 2 * 1024 ** 3, value);
});
