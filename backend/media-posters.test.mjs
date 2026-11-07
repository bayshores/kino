import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeLottiePng } from "./lottie-png.mjs";
import { createMediaPosterCache } from "./media-posters.mjs";

function png(color = 20) {
  return encodeLottiePng(Buffer.from([color, 40, 80, 255]), 1, 1);
}

async function sourceFixture({ bytes = Buffer.from("source"), options = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kino-media-poster-"));
  const file = join(root, "source.mp4");
  await writeFile(file, bytes);
  return {
    root,
    file,
    metadata: { mime: "video/mp4", width: 1, height: 1, size: bytes.length },
    cache: (overrides = {}) => createMediaPosterCache(join(root, "decode-tmp"), { ...options, ...overrides }),
    async close() { await rm(root, { recursive: true, force: true }); },
  };
}

function abortableDecode(signal) {
  return new Promise((_, reject) => {
    const stop = () => {
      const error = new Error("aborted by test");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

function observeAbortListener(signal) {
  let resolveAdded;
  const added = new Promise((resolve) => { resolveAdded = resolve; });
  const original = signal.addEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", { configurable: true, value(type, listener, options) {
    const result = original(type, listener, options);
    if (type === "abort") {
      Object.defineProperty(signal, "addEventListener", { configurable: true, value: original });
      resolveAdded();
    }
    return result;
  } });
  return added;
}

test("returns a static PNG for the exact source millisecond and memoizes the same file version", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  const calls = [];
  const cache = fixture.cache({ decode: async (source, options) => {
    calls.push({ mime: source.mime, bytes: source.buffer.toString(), time: options.time });
    return { buffer: png(), mime: "image/png" };
  } });

  const first = await cache.get(fixture.file, fixture.metadata, 12_345);
  const second = await cache.get(fixture.file, fixture.metadata, 12_345);
  assert.deepEqual(first.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(first, second);
  assert.deepEqual(calls, [{ mime: "video/mp4", bytes: "source", time: 12.345 }]);
});

test("same-time callers share one decode and one caller abort does not stop the other", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  let started, finish, decoderSignal, decodes = 0;
  const began = new Promise((resolve) => { started = resolve; });
  const cache = fixture.cache({ decode: async (_source, { signal }) => {
    decodes += 1;
    decoderSignal = signal;
    started();
    return new Promise((resolve, reject) => {
      finish = () => resolve({ buffer: png(30), mime: "image/png" });
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  } });
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  let first, second;
  t.after(async () => {
    firstAbort.abort(); secondAbort.abort(); finish?.();
    await Promise.allSettled([first, second].filter(Boolean));
  });
  first = cache.get(fixture.file, fixture.metadata, 700, { signal: firstAbort.signal });
  await began;
  const secondAttached = observeAbortListener(secondAbort.signal);
  second = cache.get(fixture.file, fixture.metadata, 700, { signal: secondAbort.signal });
  await secondAttached;
  firstAbort.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(decoderSignal.aborted, false);
  finish();
  await second;
  assert.equal(decodes, 1);
});

test("cancels a shared decode when its final waiter aborts", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  let began, decoderSignal, decodes = 0;
  const started = new Promise((resolve) => { began = resolve; });
  const cache = fixture.cache({ decode: async (_source, { signal }) => {
    decodes += 1;
    decoderSignal = signal;
    began();
    return abortableDecode(signal);
  } });
  const a = new AbortController(), b = new AbortController();
  let first, second;
  t.after(async () => {
    a.abort(); b.abort();
    await Promise.allSettled([first, second].filter(Boolean));
  });
  first = cache.get(fixture.file, fixture.metadata, 701, { signal: a.signal });
  await started;
  const secondAttached = observeAbortListener(b.signal);
  second = cache.get(fixture.file, fixture.metadata, 701, { signal: b.signal });
  await secondAttached;
  a.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(decoderSignal.aborted, false);
  b.abort();
  await assert.rejects(second, { name: "AbortError" });
  await new Promise(setImmediate);
  assert.equal(decoderSignal.aborted, true);
  assert.equal(decodes, 1);
});

test("serializes jobs and rejects work beyond the 32-job waiting queue", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  let finishFirst, decodes = 0;
  const firstStarted = new Promise((resolve) => {
    const cacheDecode = async (_source, { time }) => {
      decodes += 1;
      if (time === 0) return new Promise((resolveFrame) => { finishFirst = () => resolveFrame({ buffer: png(50), mime: "image/png" }); });
      return { buffer: png(60), mime: "image/png" };
    };
    // Store the constructor result below; this promise is resolved by the first call's decoder.
    fixture.decode = cacheDecode;
    fixture.startFirst = resolve;
  });
  const cache = fixture.cache({ decode: async (source, options) => {
    fixture.startFirst?.();
    return fixture.decode(source, options);
  } });
  let first;
  const controllers = Array.from({ length: 33 }, () => new AbortController());
  let queued = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    finishFirst?.();
    await Promise.allSettled([...queued, first].filter(Boolean));
  });
  first = cache.get(fixture.file, fixture.metadata, 0);
  await firstStarted;
  queued = controllers.map((controller, index) => cache.get(fixture.file, fixture.metadata, index + 1, { signal: controller.signal }));
  const overflow = await Promise.race(queued.map((promise) => promise.then(() => null, (error) => error)));
  assert.equal(overflow?.code, "MEDIA_POSTER_QUEUE_FULL");
  assert.equal(decodes, 1, "the active decoder keeps the queued work waiting");
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(queued);
  finishFirst();
  await first;
  assert.equal(decodes, 1);
});

test("LRU and source stat changes invalidate the right cached frame", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  let decodes = 0;
  const cache = fixture.cache({ maxEntries: 2, decode: async () => {
    decodes += 1;
    return { buffer: png(decodes), mime: "image/png" };
  } });
  await cache.get(fixture.file, fixture.metadata, 0);
  await cache.get(fixture.file, fixture.metadata, 1);
  await cache.get(fixture.file, fixture.metadata, 0); // Refresh this entry's LRU position.
  await cache.get(fixture.file, fixture.metadata, 2); // Evicts time 1.
  await cache.get(fixture.file, fixture.metadata, 0); // Still resident.
  await cache.get(fixture.file, fixture.metadata, 1); // Must decode again.
  assert.equal(decodes, 4);

  const replacement = Buffer.from("changed");
  await writeFile(fixture.file, replacement);
  fixture.metadata.size = replacement.length;
  const future = new Date(Date.now() + 5_000);
  await utimes(fixture.file, future, future);
  await cache.get(fixture.file, fixture.metadata, 0);
  assert.equal(decodes, 5, "a new source stat gets a new cache key");
});

test("validates source time, MIME, input size, dimensions, and encoded output size", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  const cache = fixture.cache({ maxInputBytes: 2, maxOutputBytes: 1,
    decode: async () => ({ buffer: png(), mime: "image/png" }) });
  for (const value of [-1, 1.5, 86_400_001, Infinity])
    await assert.rejects(cache.get(fixture.file, fixture.metadata, value), /integer from 0 to 86400000/);
  await assert.rejects(cache.get(fixture.file, { ...fixture.metadata, mime: "audio/mp4" }, 0), /media type/);
  await assert.rejects(cache.get(fixture.file, { ...fixture.metadata, width: 4_001, height: 4_000 }, 0), { code: "MEDIA_POSTER_DIMENSIONS" });
  await assert.rejects(cache.get(fixture.file, fixture.metadata, 0), { code: "MEDIA_POSTER_INPUT_TOO_LARGE" });

  const smallInput = await sourceFixture({ bytes: Buffer.from("x") });
  t.after(() => smallInput.close());
  const outputLimited = smallInput.cache({ maxOutputBytes: 1, decode: async () => ({ buffer: png(), mime: "image/png" }) });
  await assert.rejects(outputLimited.get(smallInput.file, smallInput.metadata, 0), { code: "MEDIA_POSTER_OUTPUT_TOO_LARGE" });
});

test("a decode timeout rejects callers and decoder failures are not cached", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  let attempts = 0, observedAbort = false;
  const cache = fixture.cache({ timeoutMs: 15, decode: async (_source, { signal }) => {
    attempts += 1;
    if (attempts === 1) {
      signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      return abortableDecode(signal);
    }
    throw new Error("controlled decoder failure");
  } });
  await assert.rejects(cache.get(fixture.file, fixture.metadata, 0), { code: "MEDIA_POSTER_TIMEOUT" });
  assert.equal(observedAbort, true);
  await assert.rejects(cache.get(fixture.file, fixture.metadata, 0), /controlled decoder failure/);
  assert.equal(attempts, 2);
});

test("an output larger than the byte cache budget is served but not retained", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.close());
  let decodes = 0;
  const cache = fixture.cache({ maxCacheBytes: 1, decode: async () => {
    decodes += 1;
    return { buffer: png(), mime: "image/png" };
  } });
  await cache.get(fixture.file, fixture.metadata, 4);
  await cache.get(fixture.file, fixture.metadata, 4);
  assert.equal(decodes, 2);
});
