import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_RASTER_WORKERS, createChromiumRasterizer, frameTimeLimitMs, rasterWorkerStarts, rasterWorkersRunning } from "./chromium-raster.mjs";

const READY = { type: "ready", version: 3, electron: "44.7.1", chromium: "152.0" };
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function png(width, height) {
  const buffer = Buffer.alloc(24);
  SIGNATURE.copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

class FakeStdin extends EventEmitter {
  constructor(child, { backpressure = false, drainDelayMs = 5 } = {}) {
    super();
    this.child = child;
    this.backpressure = backpressure;
    this.drainDelayMs = drainDelayMs;
    this.writableNeedDrain = false;
  }

  write(line, callback) {
    const request = JSON.parse(line);
    this.child.requests.push(request);
    if (this.backpressure) this.writableNeedDrain = true;
    queueMicrotask(() => {
      callback?.();
      if (this.child.onRequest) this.child.onRequest(request);
    });
    if (this.backpressure) {
      setTimeout(() => {
        this.writableNeedDrain = false;
        this.emit("drain");
      }, this.drainDelayMs);
      return false;
    }
    return true;
  }
}

class FakeChild extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.requests = [];
    this.kills = [];
    this.closed = false;
    this.ignoreTerm = options.ignoreTerm ?? false;
    this.stdin = new FakeStdin(this, options);
    if (options.ready !== false) setImmediate(() => this.send(options.readyMessage ?? READY));
    this.onRequest = options.onRequest ?? ((request) => {
      this.send({ id: request.id, width: request.width, height: request.height, png: png(request.width, request.height) });
    });
  }

  send(message, { chunks = false } = {}) {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    if (chunks) {
      const split = Math.min(7, bytes.length);
      this.stdout.emit("data", bytes.subarray(0, split));
      this.stdout.emit("data", bytes.subarray(split));
    } else this.stdout.emit("data", bytes);
  }

  kill(signal) {
    this.kills.push(signal);
    if (signal === "SIGKILL" || (signal === "SIGTERM" && !this.ignoreTerm)) setImmediate(() => this.finish());
    return true;
  }

  finish(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.emit("end");
    this.stderr.emit("end");
    this.emit("close", code, signal);
  }
}

function fixture(t, options = {}) {
  const children = [];
  const launches = [];
  const directories = [];
  t.after(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const dependencies = {
    electronExecutable: "/test/electron",
    workerEntry: "/test/raster-worker.cjs",
    isPackaged: false,
    startupTimeoutMs: 100,
    frameTimeoutMs: 100,
    terminateGraceMs: 10,
    // Linux with "auto" adds nothing to the worker's launch, so the exact launch below is the same
    // on every computer; the graphics tests give their own platform.
    platform: "linux",
    ...options.dependencies,
    spawn(executable, args, spawnOptions) {
      launches.push({ executable, args, spawnOptions });
      const childOptions = typeof options.childOptions === "function"
        ? options.childOptions(children.length)
        : options.childOptions;
      const child = new FakeChild(childOptions ?? {});
      children.push(child);
      return child;
    },
  };
  return {
    children,
    launches,
    async create(signal, options = {}) {
      const directory = await mkdtemp(join(tmpdir(), "kino-raster-client-test-"));
      directories.push(directory);
      return createChromiumRasterizer({ directory, signal, dependencies, ...options });
    },
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(predicate(), message);
}

function assertDetached(child) {
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
  assert.equal(child.stdin.listenerCount("drain"), 0);
}

test("Chromium client serializes frames through backpressure and keeps per-frame errors recoverable", async (t) => {
  const f = fixture(t, {
    childOptions: {
      backpressure: true,
      onRequest(request) {
        if (request.svg.includes("bad-frame")) this.send({ id: request.id, error: "this frame is invalid" }, { chunks: true });
        else this.send({ id: request.id, width: request.width, height: request.height, png: png(request.width, request.height) }, { chunks: true });
      },
    },
  });
  const client = await f.create();
  const child = f.children[0];
  const directory = f.launches[0].args.find((argument) => argument.startsWith("--kino-raster-directory=")).slice("--kino-raster-directory=".length);
  assert.equal(f.launches[0].executable, "/test/electron");
  assert.deepEqual(f.launches[0].args, [
    "/test/raster-worker.cjs",
    "--kino-raster-worker",
    `--kino-raster-directory=${directory}`,
    `--user-data-dir=${join(directory, "profile")}`,
    `--disk-cache-dir=${join(directory, "profile", "cache")}`,
    `--crash-dumps-dir=${join(directory, "crashes")}`,
  ]);

  let firstSettled = false;
  const first = client.render("<svg/>", 12, 8).finally(() => { firstSettled = true; });
  const second = client.render("<svg/>", 7, 9);
  await waitFor(() => child.requests.length === 1, "the first frame was written");
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(firstSettled, false, "the caller waits until the worker drains the request");
  assert.equal(child.requests.length, 1, "a second frame waits behind the in-flight write and response");
  await first;
  const secondFrame = await second;
  assert.deepEqual([secondFrame.width, secondFrame.height, secondFrame.buffer.readUInt32BE(16), secondFrame.buffer.readUInt32BE(20)], [7, 9, 7, 9]);

  await assert.rejects(client.render("bad-frame", 2, 2), /this frame is invalid/);
  assert.equal(child.kills.length, 0, "a worker-reported frame error does not discard the client");
  assert.equal(f.children.length, 1, "nor is the frame drawn again by another worker");
  assert.deepEqual([...(await client.render("<svg/>", 3, 4)).buffer.subarray(0, 8)], [...SIGNATURE]);
  await client.close();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assertDetached(child);
});

test("invalid frame dimensions fail before launch and malformed PNG headers close the worker", async (t) => {
  const f = fixture(t, { childOptions: { onRequest(request) {
    this.send({ id: request.id, width: request.width + 1, height: request.height, png: png(request.width, request.height) });
  } } });
  const client = await f.create();
  await assert.rejects(client.render("<svg/>", 16385, 1), /dimensions/);
  assert.equal(f.children[0].requests.length, 0);
  await assert.rejects(client.render("<svg/>", 4, 4), /dimensions/);
  await waitFor(() => f.children[0].closed, "the malformed response worker exited");
  assert.deepEqual(f.children[0].kills, ["SIGTERM"]);
  assertDetached(f.children[0]);
});

// The line the worker sends after a frame's pixels, so bytes that do not belong are noticed.
const pixelsEnd = (id) => Buffer.from(`${JSON.stringify({ id, end: true })}\n`);

// A pixel response: the JSON line with the byte count, the RGBA bytes and the end line, cut into
// pieces at `cuts` (byte offsets into the whole response) as a pipe may deliver them.
function sendPixels(child, message, pixels, cuts = []) {
  const bytes = Buffer.concat([Buffer.from(`${JSON.stringify(message)}\n`), pixels, pixelsEnd(message.id)]);
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    child.stdout.emit("data", bytes.subarray(start, cut));
    start = cut;
  }
}

test("raw pixel frames arrive whole however the pipe cuts them, and a wrong byte count closes the worker", async (t) => {
  const frameBytes = (request) => Buffer.alloc(request.width * request.height * 4, request.id);
  const f = fixture(t, { childOptions: { onRequest(request) {
    assert.equal(request.pixels, request.svg !== "<svg/>");
    if (!request.pixels) return this.send({ id: request.id, width: request.width, height: request.height, png: png(request.width, request.height) });
    const message = { id: request.id, width: request.width, height: request.height, pixelBytes: request.width * request.height * 4 };
    if (request.svg === "wrong-size") return sendPixels(this, { ...message, pixelBytes: message.pixelBytes - 4 }, frameBytes(request).subarray(4));
    const header = Buffer.byteLength(`${JSON.stringify(message)}\n`);
    // First the header with a few pixel bytes, then one byte, then the rest of the pixels with a
    // few bytes of the end line, then the end of that line.
    sendPixels(this, message, frameBytes(request), [header + 5, header + 6, header + message.pixelBytes + 3]);
  } } });
  const client = await f.create();
  // Closed even when an assertion fails, so the worker slot is free for the next test.
  t.after(() => client.close());
  const first = await client.renderPixels("<svg>one</svg>", 3, 2);
  assert.deepEqual([first.width, first.height, first.pixels.length], [3, 2, 24]);
  assert.ok(first.pixels.every((byte) => byte === 1));
  // A PNG request after a pixel one still reads its own line.
  const still = await client.render("<svg/>", 4, 4);
  assert.deepEqual([...still.buffer.subarray(0, 8)], [...SIGNATURE]);
  const third = await client.renderPixels("<svg>three</svg>", 5, 1);
  assert.ok(third.pixels.length === 20 && third.pixels.every((byte) => byte === 3));

  await assert.rejects(client.renderPixels("wrong-size", 2, 2), /invalid pixel data/);
  await waitFor(() => f.children[0].closed, "the worker with the wrong byte count exited");
  assertDetached(f.children[0]);
});

test("bytes that do not belong inside the last frame's pixels fail it instead of shifting its picture", async (t) => {
  const f = fixture(t, { childOptions: { onRequest(request) {
    const message = { id: request.id, width: request.width, height: request.height, pixelBytes: request.width * request.height * 4 };
    const pixels = Buffer.alloc(message.pixelBytes, request.id), half = pixels.length / 2;
    // Something else writes "ok\n" into the middle of the second frame, the last one asked for.
    const stray = request.id === 2 ? Buffer.from("ok\n") : Buffer.alloc(0);
    this.stdout.emit("data", Buffer.concat([Buffer.from(`${JSON.stringify(message)}\n`),
      pixels.subarray(0, half), stray, pixels.subarray(half), pixelsEnd(request.id)]));
  } } });
  const client = await f.create();
  // Closed even when an assertion fails, so the worker slot is free for the next test.
  t.after(() => client.close());
  assert.ok((await client.renderPixels("<svg>one</svg>", 4, 4)).pixels.every((byte) => byte === 1));
  await assert.rejects(client.renderPixels("<svg>two</svg>", 4, 4), /pixels with bytes that do not belong/);
  await waitFor(() => f.children[0].closed, "the worker with stray bytes exited");
  assertDetached(f.children[0]);
});

test("a worker from another kino version is refused with a message that says to restart kino", async (t) => {
  const f = fixture(t, { childOptions: { readyMessage: { ...READY, version: 2 } } });
  await assert.rejects(f.create(), /worker is version 2, but this kino needs version 3\. Restart kino/);
  await waitFor(() => f.children[0].closed, "the old worker exited");
  assertDetached(f.children[0]);
});

test("a worker that ends partway through a frame's pixels fails that frame, after a second worker did the same", async (t) => {
  const f = fixture(t, { childOptions: { onRequest(request) {
    const message = { id: request.id, width: request.width, height: request.height, pixelBytes: request.width * request.height * 4 };
    this.stdout.emit("data", Buffer.concat([Buffer.from(`${JSON.stringify(message)}\n`), Buffer.alloc(10)]));
    this.finish(0);
  } } });
  const client = await f.create();
  // Closed even when an assertion fails, so the worker slot is free for the next test.
  t.after(() => client.close());
  await assert.rejects(client.renderPixels("<svg>cut</svg>", 4, 4), /^Error: Chromium raster worker ended during a response\. This was the frame's second try, on another worker\.$/);
  assert.equal(f.children.length, 2);
  await waitFor(() => f.children.every((child) => child.closed), "both workers exited");
  for (const child of f.children) assertDetached(child);
});

test("a worker's error names why its page's renderer stopped, after any amount of Chromium's own log lines", async (t) => {
  const f = fixture(t, { childOptions: { onRequest() {
    // Chromium logs lines like these on some machines before anything goes wrong.
    for (let line = 0; line < 200; line += 1) this.stderr.emit("data", Buffer.from(`[${line}:ERROR:bus.cc(407)] Failed to connect to the bus: no such file\n`));
    this.stderr.emit("data", Buffer.from("page renderer gone: oom (exit code 5)\n"));
    this.finish(1);
  } } });
  const client = await f.create();
  t.after(() => client.close());
  await assert.rejects(client.render("<svg/>", 4, 4), /exited with code 1\. page renderer gone: oom \(exit code 5\) \[0:ERROR/);
});

test("queued cancellation never launches a third child and closing releases a slot", async (t) => {
  const f = fixture(t);
  const first = await f.create();
  const second = await f.create();
  const controller = new AbortController();
  const third = f.create(controller.signal);
  const rejected = assert.rejects(third, { name: "AbortError" });
  controller.abort(new Error("cancel queued rasterizer"));
  await rejected;
  assert.equal(f.children.length, 2, "the cancelled queue entry never spawned Electron");

  await Promise.all([first.close(), second.close()]);
  const next = await f.create();
  assert.equal(f.children.length, 3, "a closed worker returns its process-wide slot");
  await next.close();
  for (const child of f.children) assertDetached(child);
});

test("startup and frame watchdogs kill their own child and detach process listeners", async (t) => {
  const startup = fixture(t, {
    dependencies: { startupTimeoutMs: 10, terminateGraceMs: 5 },
    childOptions: { ready: false, ignoreTerm: true },
  });
  await assert.rejects(startup.create(), /did not become ready/);
  await waitFor(() => startup.children[0].closed, "the startup timeout worker exited");
  assert.deepEqual(startup.children[0].kills, ["SIGTERM", "SIGKILL"]);
  assertDetached(startup.children[0]);

  const frame = fixture(t, {
    dependencies: { frameTimeoutMs: 10, terminateGraceMs: 5 },
    childOptions: { ignoreTerm: true, onRequest() {} },
  });
  const client = await frame.create();
  await assert.rejects(client.render("<svg/>", 10, 10), /0\.01 second time limit/);
  assert.equal(frame.children.length, 2, "a new worker tried the frame once more");
  await waitFor(() => frame.children.every((child) => child.closed), "the frame timeout workers exited");
  for (const child of frame.children) {
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
    assertDetached(child);
  }
});

test("a frame's time limit grows with its pixels, and the worker is told it", async (t) => {
  assert.equal(frameTimeLimitMs(1920, 1080), 45_000);
  assert.equal(frameTimeLimitMs(1080, 1920), 45_000);
  assert.equal(frameTimeLimitMs(640, 360), 45_000, "never less than for 1920x1080");
  assert.equal(frameTimeLimitMs(3840, 2160), 180_000, "4K has four times the pixels");
  assert.equal(frameTimeLimitMs(2160, 3840), 180_000);
  assert.equal(frameTimeLimitMs(3840, 2160, 1000), 4000);
  const f = fixture(t, { dependencies: { frameTimeoutMs: 1000 } });
  const client = await f.create();
  t.after(() => client.close());
  await client.render("<svg/>", 3840, 2160);
  await client.render("<svg/>", 4, 4);
  assert.deepEqual(f.children[0].requests.map((request) => request.timeoutMs), [4000, 1000]);
});

test("a frame that runs out of time names its frame, time limit, size and SVG length; a new worker tries it once more, then it and the frames queued after it fail", async (t) => {
  const f = fixture(t, { dependencies: { frameTimeoutMs: 10, terminateGraceMs: 5 }, childOptions: { onRequest() {} } });
  const stops = [];
  const client = await f.create(undefined, { onWorkerStopped: (stop) => stops.push(stop) });
  const slow = client.renderPixels(`<svg>${"x".repeat(2 * 1048576)}</svg>`, 12, 8, { label: "frame 152 of 720 at 5.033 s" });
  const queued = client.renderPixels("<svg/>", 12, 8, { label: "frame 153 of 720 at 5.067 s" });
  await assert.rejects(slow, /^Error: Chromium raster frame exceeded the 0\.01 second time limit \(frame 152 of 720 at 5\.033 s, 12x8, SVG 2\.0 MB\)\. This was the frame's second try, on another worker\.$/);
  // The frame after it never reached Chromium: it fails with the slow frame's message.
  await assert.rejects(queued, /frame 152 of 720 at 5\.033 s/);
  assert.deepEqual(f.children.map((child) => child.requests.map((request) => request.svg.length)), [[2 * 1048576 + 11], [2 * 1048576 + 11]], "each worker got the slow frame, and only it");
  assert.deepEqual(stops.map((stop) => [stop.label, stop.reason.message]),
    [["frame 152 of 720 at 5.033 s", "Chromium raster frame exceeded the 0.01 second time limit (frame 152 of 720 at 5.033 s, 12x8, SVG 2.0 MB)."]]);
  await waitFor(() => f.children.every((child) => child.closed), "the timed-out workers exited");
});

// The folder a launch was given (--kino-raster-directory=…).
const launchDirectory = (launch) => launch.args.find((argument) => argument.startsWith("--kino-raster-directory=")).slice("--kino-raster-directory=".length);

test("a pool of three workers starts three Electron children, draws three frames at once and gives each frame its own answer", async (t) => {
  let drawing = 0, most = 0;
  const f = fixture(t, {
    // The first child answers slowly, so answers come back in another order than the requests.
    childOptions: (index) => ({ onRequest(request) {
      drawing += 1;
      most = Math.max(most, drawing);
      setTimeout(() => {
        drawing -= 1;
        this.send({ id: request.id, width: request.width, height: request.height, png: png(request.width, request.height) });
      }, index === 0 ? 30 : 5);
    } }),
  });
  const startsBefore = rasterWorkerStarts.count;
  const pool = await f.create(undefined, { workers: 3 });
  t.after(() => pool.close());
  assert.equal(pool.workers, 3, "the workers still starting are counted");
  const sizes = Array.from({ length: 12 }, (_, index) => [index + 1, 20 - index]);
  const frames = await Promise.all(sizes.map(([width, height]) => pool.render("<svg/>", width, height)));
  assert.deepEqual(frames.map((frame) => [frame.width, frame.height, frame.buffer.readUInt32BE(16), frame.buffer.readUInt32BE(20)]),
    sizes.map(([width, height]) => [width, height, width, height]), "each frame gets the answer to its own request");
  assert.equal(f.children.length, 3);
  assert.equal(rasterWorkerStarts.count - startsBefore, 3);
  assert.equal(most, 3, "three frames were drawn at the same time");
  assert.equal(pool.memory().workers, 3, "the answer's frames at once");
  for (const child of f.children) assert.ok(child.requests.length >= 1, "every worker drew frames");
  assert.equal(f.children.reduce((sum, child) => sum + child.requests.length, 0), 12, "each frame was drawn once");
  // Each worker has a profile of its own.
  const first = launchDirectory(f.launches[0]);
  assert.deepEqual(f.launches.map(launchDirectory).sort(), [first, join(first, "worker-1"), join(first, "worker-2")].sort());
  assert.equal(rasterWorkersRunning(), 3);
  await pool.close();
  assert.equal(rasterWorkersRunning(), 0, "closing the pool returns every worker's slot");
  for (const child of f.children) {
    assert.deepEqual(child.kills, ["SIGTERM"]);
    assertDetached(child);
  }
});

test("cancelling a pool's export stops every worker and fails every frame, the ones drawing and the ones waiting", async (t) => {
  const f = fixture(t, { dependencies: { frameTimeoutMs: 5000 }, childOptions: { onRequest() {} } });
  const controller = new AbortController();
  const pool = await f.create(controller.signal, { workers: 3 });
  const frames = Array.from({ length: 5 }, () => pool.render("<svg/>", 4, 4));
  const settled = Promise.allSettled(frames);
  await waitFor(() => f.children.length === 3 && f.children.every((child) => child.requests.length === 1), "three frames are drawing");
  controller.abort(new Error("the person cancelled the export"));
  const results = await settled;
  assert.deepEqual(results.map((result) => [result.status, result.reason?.name]), Array(5).fill(["rejected", "AbortError"]));
  await waitFor(() => f.children.every((child) => child.closed), "every worker exited");
  for (const child of f.children) {
    assert.deepEqual(child.kills, ["SIGTERM"]);
    assertDetached(child);
  }
  assert.equal(rasterWorkersRunning(), 0);
  await assert.rejects(pool.render("<svg/>", 4, 4), { name: "AbortError" });
  await pool.close();
});

// A child that writes why its page's renderer went and exits, as desktop/raster-worker.cjs does.
function crash(child) {
  child.stderr.emit("data", Buffer.from("page renderer gone: oom (exit code 5)\n"));
  setImmediate(() => child.finish(1));
}
const answer = (child, request) => child.send({ id: request.id, width: request.width, height: request.height, png: png(request.width, request.height) });

test("a frame whose worker stops is drawn again by a new worker, which draws on", async (t) => {
  const f = fixture(t, { childOptions: (index) => ({ onRequest(request) { if (index === 0) crash(this); else answer(this, request); } }) });
  const stops = [];
  const raster = await f.create(undefined, { onWorkerStopped: (stop) => stops.push(stop) });
  t.after(() => raster.close());
  const frame = await raster.render("<svg/>", 4, 3, { label: "frame 3 of 9 at 0.067 s" });
  assert.deepEqual([frame.width, frame.height], [4, 3]);
  assert.equal(f.children.length, 2);
  assert.equal(f.children[1].requests.length, 1, "the new worker drew the frame");
  assert.deepEqual(stops.map((stop) => stop.label), ["frame 3 of 9 at 0.067 s"]);
  assert.match(stops[0].reason.message, /^Chromium raster worker exited with code 1\. page renderer gone: oom \(exit code 5\)/);
  assert.equal(launchDirectory(f.launches[1]), join(launchDirectory(f.launches[0]), "worker-1"), "in a folder of its own");
  assert.equal((await raster.render("<svg/>", 5, 5)).width, 5);
  assert.equal(f.children.length, 2, "the next frames go to the new worker");
  assert.equal(raster.workers, 1);
  assert.equal(raster.memory().workers, 1, "the worker started in place of the stopped one does not count as a frame at once");
  assert.equal(rasterWorkersRunning(), 1, "the stopped worker gave back its place");
  await raster.close();
  assert.equal(rasterWorkersRunning(), 0);
  for (const child of f.children) assertDetached(child);
});

test("a worker that stops between frames is replaced for the next frame", async (t) => {
  const f = fixture(t, { childOptions: (index) => ({ onRequest(request) {
    answer(this, request);
    if (index === 0) crash(this);
  } }) });
  const stops = [];
  const raster = await f.create(undefined, { onWorkerStopped: (stop) => stops.push(stop) });
  t.after(() => raster.close());
  assert.equal((await raster.render("<svg/>", 2, 2)).width, 2);
  await waitFor(() => f.children[0].closed, "the first worker exited");
  assert.equal((await raster.render("<svg/>", 3, 3)).width, 3);
  assert.equal(f.children.length, 2);
  assert.deepEqual(stops.map((stop) => stop.label), [null], "no frame was drawn again");
  assert.match(stops[0].reason.message, /exited with code 1\. page renderer gone: oom/);
});

test("a frame the page did not show in time names the frame, and a new worker draws it", async (t) => {
  const late = (child, request) => child.send({ id: request.id, error: "Chromium did not draw the export frame in time." });
  const once = fixture(t, { childOptions: (index) => ({ onRequest(request) { if (index === 0) late(this, request); else answer(this, request); } }) });
  const stops = [];
  const raster = await once.create(undefined, { onWorkerStopped: (stop) => stops.push(stop) });
  t.after(() => raster.close());
  assert.equal((await raster.render("<svg/>", 4, 4, { label: "frame 7 of 9 at 0.200 s" })).width, 4);
  assert.deepEqual(stops.map((stop) => [stop.label, stop.reason.message]),
    [["frame 7 of 9 at 0.200 s", "Chromium did not draw the export frame in time (frame 7 of 9 at 0.200 s, 4x4, SVG 0.0 MB)."]]);
  await waitFor(() => once.children[0].closed, "the worker that answered late was stopped");
  assert.deepEqual(once.children[0].kills, ["SIGTERM"]);

  const always = fixture(t, { childOptions: { onRequest(request) { late(this, request); } } });
  const failing = await always.create();
  t.after(() => failing.close());
  await assert.rejects(failing.render("<svg/>", 4, 4, { label: "frame 7 of 9 at 0.200 s" }),
    /^Error: Chromium did not draw the export frame in time \(frame 7 of 9 at 0\.200 s, 4x4, SVG 0\.0 MB\)\. This was the frame's second try, on another worker\.$/);
  assert.equal(always.children.length, 2);
});

test("a frame that stops two workers fails the export with that reason, and so do the frames waiting", async (t) => {
  const f = fixture(t, { childOptions: { onRequest(request) {
    if (request.svg.includes("crash")) crash(this);
    else setTimeout(() => answer(this, request), 20);
  } } });
  const pool = await f.create(undefined, { workers: 3 });
  t.after(() => pool.close());
  const first = pool.render("<svg>a</svg>", 4, 4);
  const second = pool.render("<svg>b</svg>", 4, 4);
  const results = Promise.allSettled([first, second]);
  await waitFor(() => f.children.length === 3 && f.children.filter((child) => child.requests.length).length === 2, "two frames are drawing");
  const crashing = pool.render("<svg>crash</svg>", 4, 4, { label: "frame 3" });
  const waiting = pool.render("<svg>d</svg>", 4, 4);
  const final = /^Error: Chromium raster worker exited with code 1\. page renderer gone: oom \(exit code 5\) This was the frame's second try, on another worker\.$/;
  await assert.rejects(crashing, final);
  await assert.rejects(waiting, final);
  for (const result of await results) assert.ok(result.status === "fulfilled" || final.test(String(result.reason)), String(result.reason));
  assert.equal(f.children.filter((child) => child.requests.some((request) => request.svg.includes("crash"))).length, 2, "two workers tried it");
  assert.equal(f.children.length, 3, "another worker was running, so no new one started");
  await waitFor(() => f.children.every((child) => child.closed), "every worker exited");
  assert.equal(rasterWorkersRunning(), 0);
  await assert.rejects(pool.render("<svg/>", 4, 4), final);
});

test("an export stops starting new workers after MAX_NEW_WORKERS, and when a new one cannot start", async (t) => {
  // Each worker draws one frame and stops while drawing its second.
  const f = fixture(t, { childOptions: { onRequest(request) { if (this.requests.length === 2) crash(this); else answer(this, request); } } });
  const raster = await f.create();
  t.after(() => raster.close());
  for (let frame = 1; frame <= 9; frame += 1) assert.equal((await raster.render("<svg/>", frame, 1)).width, frame);
  await assert.rejects(raster.render("<svg/>", 10, 1), /exited with code 1\. page renderer gone: oom \(exit code 5\) 8 new workers had already been started for this export\.$/);
  assert.equal(f.children.length, 9);
  await waitFor(() => f.children.every((child) => child.closed), "every worker exited");
  assert.equal(rasterWorkersRunning(), 0);

  const refused = fixture(t, { childOptions: (index) => index === 0 ? { onRequest() { crash(this); } } : { readyMessage: { ...READY, version: 2 } } });
  const second = await refused.create();
  t.after(() => second.close());
  await assert.rejects(second.render("<svg/>", 4, 4), /exited with code 1\. page renderer gone: oom \(exit code 5\) A new worker could not start: The Chromium export worker is version 2/);
});

test("a pool draws with the workers that started when one of them cannot start", async (t) => {
  const f = fixture(t, {
    childOptions: (index) => index === 1 ? { readyMessage: { ...READY, version: 2 } } : {},
  });
  const pool = await f.create(undefined, { workers: 3 });
  t.after(() => pool.close());
  await waitFor(() => f.children.length === 3 && f.children[1].closed && pool.workers === 2, "the refused worker is left out");
  const frames = await Promise.all(Array.from({ length: 6 }, (_, index) => pool.render("<svg/>", index + 1, 2)));
  assert.deepEqual(frames.map((frame) => frame.width), [1, 2, 3, 4, 5, 6]);
  assert.equal(f.children[1].requests.length, 0);
  assert.equal(f.children[0].requests.length + f.children[2].requests.length, 6);
});

test("a pool's size is a whole number from 1 to the most workers, and extra workers stop at the process-wide limit", async (t) => {
  const f = fixture(t);
  for (const workers of [0, 1.5, MAX_RASTER_WORKERS + 1]) {
    await assert.rejects(f.create(undefined, { workers }), RangeError);
  }
  assert.equal(f.children.length, 0, "no worker started");
  const big = await f.create(undefined, { workers: MAX_RASTER_WORKERS });
  t.after(() => big.close());
  await waitFor(() => rasterWorkersRunning() === MAX_RASTER_WORKERS, "the whole pool started");
  // A second export still gets its first worker, but no extra one while eight are running.
  const second = await f.create(undefined, { workers: 3 });
  t.after(() => second.close());
  await waitFor(() => second.workers === 1, "the second pool's extra workers were refused");
  assert.equal(rasterWorkersRunning(), MAX_RASTER_WORKERS + 1);
  assert.equal(f.children.length, MAX_RASTER_WORKERS + 1, "the refused extra workers never started Electron");
  assert.equal((await second.render("<svg/>", 3, 3)).width, 3);
});

test("the graphics setting steers the worker's launch: switches, and variables the person did not set", async (t) => {
  const workerArgs = (launch) => launch.args.filter((argument) => argument.startsWith("--kino-raster-gpu"));
  const mac = fixture(t, { dependencies: { platform: "darwin" } });
  await (await mac.create()).close();
  assert.deepEqual(workerArgs(mac.launches[0]), ["--kino-raster-gpu=high-performance"]);
  const processor = fixture(t, { dependencies: { platform: "darwin" } });
  await (await processor.create(undefined, { graphics: "processor" })).close();
  assert.deepEqual(workerArgs(processor.launches[0]), ["--kino-raster-gpu=off"]);

  // WSL: the cards are detected first, and every worker of the export gets the same variables.
  let detections = 0;
  const wsl = fixture(t, { dependencies: {
    platform: "wsl",
    env: { PATH: "/usr/bin", GALLIUM_DRIVER: "d3d12", ELECTRON_RUN_AS_NODE: "1" },
    files: (file) => file === "/dev/dxg" || file === "/tmp/.X11-unix/X0",
    listGraphics: async () => { detections += 1; return { cards: [{ name: "NVIDIA GeForce RTX 4090", vendor: "NVIDIA" }] }; },
  } });
  const pool = await wsl.create(undefined, { workers: 2, claim: () => {} });
  await waitFor(() => wsl.launches.length === 2, "the second worker started");
  await pool.close();
  assert.equal(detections, 1);
  for (const launch of wsl.launches) {
    const env = launch.spawnOptions.env;
    assert.deepEqual([env.DISPLAY, env.GALLIUM_DRIVER, env.MESA_D3D12_DEFAULT_ADAPTER_NAME, env.PATH, env.ELECTRON_RUN_AS_NODE],
      [":0", "d3d12", "NVIDIA GeForce RTX 4090", "/usr/bin", undefined]);
    assert.deepEqual(workerArgs(launch), []);
  }
  // Under xvfb-run the person's DISPLAY stays, and the d3d12 variables (no help there) are not added.
  const xvfb = fixture(t, { dependencies: {
    platform: "wsl", env: { PATH: "/usr/bin", DISPLAY: ":99" }, files: (file) => file === "/dev/dxg" || file === "/tmp/.X11-unix/X0",
    listGraphics: async () => ({ cards: [{ name: "NVIDIA GeForce RTX 4090", vendor: "NVIDIA" }] }),
  } });
  await (await xvfb.create()).close();
  assert.deepEqual(xvfb.launches[0].spawnOptions.env, { PATH: "/usr/bin", DISPLAY: ":99" });
  // Plain Linux with auto detects nothing and changes nothing.
  const linux = fixture(t, { dependencies: { env: { PATH: "/bin" }, listGraphics: async () => assert.fail("no detection on plain Linux with auto") } });
  await (await linux.create()).close();
  assert.deepEqual(linux.launches[0].spawnOptions.env, { PATH: "/bin" });
  await assert.rejects(linux.create(undefined, { graphics: "" }), /graphics setting/);
});

test("the ready line may say what the worker draws with; the pool lists each renderer once", async (t) => {
  const named = { ...READY, renderer: "Apple M3 Pro (Metal)", card: true };
  const f = fixture(t, { childOptions: (index) => ({ readyMessage: index === 2 ? READY : named }) });
  const pool = await f.create(undefined, { workers: 3, claim: () => {} });
  await waitFor(() => pool.workers === 3 && f.children.length === 3, "three workers started");
  await Promise.all([1, 2, 3].map(() => pool.render("<svg/>", 4, 4)));
  assert.deepEqual(pool.renderers(), [{ renderer: "Apple M3 Pro (Metal)", card: true }, { renderer: null, card: null }]);
  assert.match(pool.graphicsKey, /"auto"/);
  await pool.close();

  const old = fixture(t);
  const alone = await old.create();
  assert.deepEqual(alone.renderers(), [{ renderer: null, card: null }], "an older worker says nothing: nothing is claimed");
  await alone.close();
  const software = fixture(t, { childOptions: { readyMessage: { ...READY, renderer: "processor (software)", card: false } } });
  const drawn = await software.create();
  assert.deepEqual(drawn.renderers(), [{ renderer: "processor (software)", card: false }]);
  await drawn.close();

  for (const readyMessage of [{ ...READY, renderer: "x".repeat(201) }, { ...READY, renderer: 3 }, { ...READY, card: "yes" }]) {
    const bad = fixture(t, { childOptions: { readyMessage } });
    await assert.rejects(bad.create(), /invalid startup message/, JSON.stringify(readyMessage).slice(0, 80));
  }
});

// On WSLg Chromium's GPU process reported 3 to 5 s after the start, after the ready line, so the
// worker says what draws in the frame's answer after the report (desktop/raster-worker.cjs).
test("a renderer said in a frame's answer, after the ready line, is what the pool lists", async (t) => {
  const card = "D3D12 (NVIDIA GeForce RTX 4090)";
  const f = fixture(t, { childOptions: { onRequest(request) {
    const said = this.requests.length === 1 ? { renderer: card, card: true } : {};
    this.send({ id: request.id, width: request.width, height: request.height, png: png(request.width, request.height), ...said });
  } } });
  const raster = await f.create();
  assert.deepEqual(raster.renderers(), [{ renderer: null, card: null }], "not known at the ready line");
  await raster.render("<svg/>", 4, 4);
  assert.deepEqual(raster.renderers(), [{ renderer: card, card: true }]);
  await raster.render("<svg/>", 4, 4);
  assert.deepEqual(raster.renderers(), [{ renderer: card, card: true }], "an answer that says nothing changes nothing");
  await raster.close();

  const bad = fixture(t, { childOptions: { onRequest(request) {
    this.send({ id: request.id, width: request.width, height: request.height, png: png(request.width, request.height), renderer: 3, card: true });
  } } });
  const refused = await bad.create();
  await assert.rejects(refused.render("<svg/>", 4, 4), /invalid renderer/);
  await refused.close();
});
