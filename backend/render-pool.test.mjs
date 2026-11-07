import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { serialize } from "node:v8";
import { Resvg } from "@resvg/resvg-js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createRenderPool, processWorkerFactory, waitingPool } from "./render-pool.mjs";
import { frameReference } from "./render-output-audit.mjs";
import { blendRenderSamples } from "./render-quality.mjs";
import { encodeRenderPng } from "./render-png.mjs";
import { flattenTilts } from "./flatten-tilts.mjs";
import { createLayer, createScene } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#202431"/><circle cx="32" cy="24" r="13" fill="#ef476f" fill-opacity=".5"/></svg>';
const SECOND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#202431"/><circle cx="38" cy="24" r="13" fill="#ef476f" fill-opacity=".5"/></svg>';
const ALPHA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><circle cx="30" cy="24" r="13" fill="#ef476f" fill-opacity=".5"/></svg>';
const ALPHA_SECOND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><circle cx="38" cy="24" r="13" fill="#3769d1" fill-opacity=".5"/></svg>';
const OPTIONS = { font: { loadSystemFonts: false }, imageRendering: 0 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mockWorkers(onPost, beforeReady) {
  const workers = [];
  return {
    workers,
    factory() {
      const worker = new EventEmitter();
      worker.postMessage = (message) => {
        worker.lastRequest = message;
        worker.emit("mock-post", message);
        onPost(worker, message, workers.length);
      };
      worker.ref = () => {};
      worker.unref = () => {};
      worker.terminate = () => {
        queueMicrotask(() => worker.emit("exit", 1));
        return Promise.resolve(1);
      };
      workers.push(worker);
      queueMicrotask(() => {
        beforeReady?.(worker);
        worker.emit("message", { type: "ready", version: 1 });
      });
      return worker;
    },
  };
}

function mockImageReply(worker, request, bytes = [1, 2, 3]) {
  const buffer = Uint8Array.from(bytes).buffer;
  const message = { id: request.id, buffer, width: 1, height: 1 };
  if (request.samples?.length || request.dither) message.reference = new Uint8Array(32 * 18 * 3).buffer;
  worker.emit("message", message);
}

async function decodePixels(buffer, width, height) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return Buffer.from(context.getImageData(0, 0, width, height).data);
}

function asUint8(pixels) {
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

test("worker PNG and premultiplied raw pixels exactly match inline Resvg", async (t) => {
  const pool = createRenderPool({ size: 1, idleMs: 10_000 });
  t.after(() => pool.close());

  const expected = new Resvg(SVG, OPTIONS).render();
  const png = await pool.render(SVG, OPTIONS);
  assert.deepEqual(png, { buffer: expected.asPng(), width: expected.width, height: expected.height });

  const raw = await pool.render(SVG, OPTIONS, { raw: true });
  assert.deepEqual(raw, { pixels: Buffer.from(expected.pixels), width: expected.width, height: expected.height });
  assert.deepEqual(await pool.render(SVG, OPTIONS), png, "reusing a worker keeps the PNG bytes identical");
});

test("drafts and finals draw a tilted layer's flat drawing once (flatten-tilts.mjs) and look as its triangles do", async (t) => {
  const pool = createRenderPool({ size: 1, idleMs: 10_000 });
  t.after(() => pool.close());
  // A clipping group with a blurred, partly transparent child: its clip and filter are defined
  // outside the tilted drawing, in the frame's own <defs>.
  const scene = createScene({ id: "s", width: 320, height: 180, background: "#202431", layers: [
    createLayer("group", { id: "g", x: 60, y: 30, width: 200, height: 120, rotateX: 35, rotateY: -25, clipContent: true }),
    createLayer("rectangle", { id: "a", parentId: "g", x: 0, y: 0, width: 200, height: 120, fill: "#3769d1" }),
    createLayer("rectangle", { id: "b", parentId: "g", x: 120, y: 60, width: 120, height: 90, fill: "#ef476f", blur: 3, opacity: 0.6 })] });
  for (const draft of [true, false]) {
    const svg = renderSceneSvg(scene, 0, { draft, raster: true });
    const flat = await flattenTilts(svg, OPTIONS, { draft });
    assert.ok(svg.includes("data-kino-flatten=") && !/<pattern [^>]*><use /.test(flat), "every triangle holds a piece of one bitmap");
    const triangles = new Resvg(svg, OPTIONS).render().pixels;
    const flattened = await pool.render(svg, OPTIONS, { raw: true, draft });
    let sum = 0;
    for (let index = 0; index < triangles.length; index += 1) sum += Math.abs(triangles[index] - flattened.pixels[index]);
    assert.ok(sum / triangles.length < (draft ? 1 : 0.5), `${draft ? "draft" : "final"} mean difference ${sum / triangles.length} of 255`);
  }
  // No seams along the triangles' edges: inside a partly transparent solid card every pixel is the
  // card's color (overlapping triangles painted it twice there, a bright line).
  const card = createScene({ id: "c", width: 320, height: 180, background: "#101010", layers: [
    createLayer("group", { id: "g", x: 50, y: 25, width: 200, height: 117, rotateX: 20, rotateY: -30 }),
    createLayer("rectangle", { id: "a", parentId: "g", x: 0, y: 0, width: 200, height: 117, fill: "#ff3fa4", opacity: 0.6 })] });
  for (const draft of [true, false]) {
    const { pixels, width } = await pool.render(renderSceneSvg(card, 0, { draft, raster: true }), OPTIONS, { raw: true, draft });
    let worst = 0;
    for (let y = 55; y < 115; y += 1) for (let x = 100; x < 225; x += 1) {
      const index = (y * width + x) * 4;
      worst = Math.max(worst, ...[159, 44, 104].map((value, channel) => Math.abs(pixels[index + channel] - value)));
    }
    assert.ok(worst <= 4, `${draft ? "draft" : "final"} card is off by up to ${worst} of 255 inside`);
  }
});

test("default workers ignore parent eval and input-type execution flags", () => {
  const poolUrl = new URL("./render-pool.mjs", import.meta.url).href;
  const source = [
    `(async () => {`,
    `  const { createRenderPool } = await import(${JSON.stringify(poolUrl)});`,
    `  const pool = createRenderPool({ size: 1, idleMs: 10000 });`,
    `  try {`,
    `    const frame = await pool.render(${JSON.stringify(SVG)}, ${JSON.stringify(OPTIONS)});`,
    `    const signature = frame.buffer.subarray(0, 8).toString("hex");`,
    `    if (signature !== "89504e470d0a1a0a") throw new Error("bad PNG signature");`,
    `    console.log(JSON.stringify({ width: frame.width, height: frame.height, signature }));`,
    `  } finally { await pool.close(); }`,
    `})().catch(error => { console.error(error); process.exitCode = 1; });`,
  ].join("\n");
  const variants = [
    ["equals form", ["--input-type=module", "--eval", source]],
    ["two-argument form", ["--input-type", "module", "-e", source]],
    ["eval-only form", ["--eval", source]],
  ];

  for (const [label, args] of variants) {
    const child = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 20_000,
      env: process.env,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${label}: ${child.stderr}`);
    assert.deepEqual(JSON.parse(child.stdout.trim()), {
      width: 64,
      height: 48,
      signature: "89504e470d0a1a0a",
    });
  }
});

test("ignores exact Node watch dependency notifications without weakening the response protocol", async (t) => {
  const mocked = mockWorkers((worker, request) => mockImageReply(worker, request), (worker) => {
    worker.emit("message", { "watch:import": ["file:///tmp/render-worker.mjs", "node:worker_threads"] });
    worker.emit("message", { "watch:require": [undefined, "/tmp/render-native-binding.cjs"] });
  });
  const pool = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: mocked.factory });
  t.after(() => pool.close());

  assert.deepEqual(await pool.render(SVG), { buffer: Buffer.from([1, 2, 3]), width: 1, height: 1 });
  assert.equal(pool.stats().workers, 1);
  assert.equal(pool.stats().active, 0);

  const malformed = mockWorkers(() => {}, (worker) => {
    worker.emit("message", { "watch:import": [null] });
  });
  const malformedPool = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: malformed.factory });
  t.after(() => malformedPool.close());
  await assert.rejects(malformedPool.render(SVG), { code: "RENDER_WORKER_PROTOCOL" });
});

test("renders under Node watch mode and forwards worker dependencies when watch IPC is enabled", async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "render-pool-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probePath = join(directory, "watch-probe.mjs");
  const poolUrl = new URL("./render-pool.mjs", import.meta.url).href;
  const source = [
    `let forwardedWorker = false;`,
    `const originalSend = process.send;`,
    `const watchIpc = process.env.WATCH_REPORT_DEPENDENCIES === "1" && typeof originalSend === "function";`,
    `if (watchIpc) {`,
    `  process.send = function (message, ...args) {`,
    `    const dependencies = [...(message?.["watch:import"] ?? []), ...(message?.["watch:require"] ?? [])];`,
    `    if (dependencies.some((file) => typeof file === "string" && file.endsWith("/backend/render-worker.mjs"))) forwardedWorker = true;`,
    `    return originalSend.call(process, message, ...args);`,
    `  };`,
    `}`,
    `const { createRenderPool } = await import(${JSON.stringify(poolUrl)});`,
    `const pool = createRenderPool({ size: 1, idleMs: 10000 });`,
    `let result;`,
    `try { result = await pool.render(${JSON.stringify(SVG)}, ${JSON.stringify(OPTIONS)}); }`,
    `finally { await pool.close(); }`,
    `console.log("WATCH_RENDER_RESULT " + JSON.stringify({ width: result.width, height: result.height,`,
    `  signature: result.buffer.subarray(0, 8).toString("hex"), watchIpc, forwardedWorker }));`,
  ].join("\n");
  await writeFile(probePath, source);

  const child = spawn(process.execPath, ["--watch", "--watch-preserve-output", probePath], {
    cwd: directory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let stopped = false;
  let timedOut = false;
  let timeout;
  let forceTimeout;
  await new Promise((resolve, reject) => {
    const stopWatch = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      forceTimeout = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const collect = (target, chunk) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout = (stdout + text).slice(-32_000);
      else stderr = (stderr + text).slice(-32_000);
      if (stdout.includes("WATCH_RENDER_RESULT ")) stopWatch();
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
    timeout = setTimeout(() => {
      timedOut = true;
      stopWatch();
    }, 3000);
  });
  clearTimeout(timeout);
  clearTimeout(forceTimeout);

  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("WATCH_RENDER_RESULT "));
  assert.ok(line, `watch child did not render successfully: ${stderr}`);
  const result = JSON.parse(line.slice("WATCH_RENDER_RESULT ".length));
  assert.deepEqual({ width: result.width, height: result.height, signature: result.signature }, {
    width: 64,
    height: 48,
    signature: "89504e470d0a1a0a",
  });
  if (result.watchIpc) assert.equal(result.forwardedWorker, true, "worker imports reach the Node watch supervisor");
  assert.equal(timedOut, false, `bounded Node watch probe expired: ${stderr}`);
});

test("blends two raw samples and returns the matching canvas PNG and 32 by 18 reference", async (t) => {
  const pool = createRenderPool({ size: 1, idleMs: 10_000 });
  t.after(() => pool.close());

  const rendered = [ALPHA_SVG, ALPHA_SECOND_SVG].map(svg => new Resvg(svg, OPTIONS).render());
  const blended = blendRenderSamples(rendered.map(image => ({
    pixels: image.pixels, width: image.width, height: image.height, premultiplied: true,
  })));
  const expectedPng = await encodeRenderPng(blended.pixels, blended.width, blended.height);
  const actual = await pool.render(ALPHA_SVG, OPTIONS, { samples: [ALPHA_SECOND_SVG] });

  assert.equal(actual.width, blended.width);
  assert.equal(actual.height, blended.height);
  assert.deepEqual(actual.buffer, expectedPng);
  const decoded = await decodePixels(actual.buffer, actual.width, actual.height);
  for (let offset = 0; offset < blended.pixels.length; offset += 4) {
    assert.equal(decoded[offset + 3], blended.pixels[offset + 3], `decoded alpha at pixel ${offset / 4}`);
  }
  assert.ok(blended.pixels.some((value, offset) => offset % 4 === 3 && value === 0), "transparent pixels are retained");
  assert.ok(blended.pixels.some((value, offset) => offset % 4 === 3 && value > 0 && value < 255), "partial alpha is retained");
  assert.deepEqual(actual.reference, Buffer.from(frameReference(asUint8(blended.pixels), blended.width, blended.height)));
});

test("blends many shutter samples one at a time in the worker, the same as blending them all at once", async (t) => {
  const pool = createRenderPool({ size: 1, idleMs: 10_000 });
  t.after(() => pool.close());
  // A circle sliding 2 px per sample, eight samples (motionSamples 8).
  const svgs = Array.from({ length: 8 }, (_, index) => ALPHA_SVG.replace('cx="30"', `cx="${24 + index * 2}"`));
  const blended = blendRenderSamples(svgs.map((svg) => new Resvg(svg, OPTIONS).render()).map((image) => ({
    pixels: image.pixels, width: image.width, height: image.height, premultiplied: true,
  })), { dither: true });
  const actual = await pool.render(svgs[0], OPTIONS, { samples: svgs.slice(1), dither: true });
  assert.deepEqual(actual.buffer, await encodeRenderPng(blended.pixels, blended.width, blended.height));
  await assert.rejects(pool.render(SVG, OPTIONS, { samples: Array(16).fill(SECOND_SVG) }), /at most 15 additional/);
});

test("dithers in the worker and rejects invalid quality combinations and input bounds", async (t) => {
  const pool = createRenderPool({
    size: 1,
    maxBytes: Buffer.byteLength(SVG, "utf8") + serialize(OPTIONS).byteLength,
    idleMs: 10_000,
  });
  t.after(() => pool.close());

  const raw = new Resvg(SVG, OPTIONS).render();
  const expected = blendRenderSamples([
    { pixels: raw.pixels, width: raw.width, height: raw.height, premultiplied: true },
  ], { dither: true });
  const expectedPng = await encodeRenderPng(expected.pixels, expected.width, expected.height);
  const actual = await pool.render(SVG, OPTIONS, { dither: true });
  assert.deepEqual(actual.buffer, expectedPng);
  assert.deepEqual(actual.reference, Buffer.from(frameReference(asUint8(expected.pixels), expected.width, expected.height)));

  await assert.rejects(pool.render(SVG, OPTIONS, { samples: [SECOND_SVG] }), { code: "RENDER_POOL_FULL" });
  await assert.rejects(pool.render(SVG, OPTIONS, { samples: Array(16).fill(SECOND_SVG) }), RangeError);
  await assert.rejects(pool.render(SVG, OPTIONS, { raw: true, samples: [SECOND_SVG] }), TypeError);
  await assert.rejects(pool.render(SVG, OPTIONS, { raw: true, dither: true }), TypeError);
  await assert.rejects(pool.render(SVG, OPTIONS, { dither: 1 }), TypeError);
});

test("two workers run concurrently and count and byte queue limits reject promptly", async (t) => {
  const twoStarted = deferred();
  const thirdStarted = deferred();
  const fourthStarted = deferred();
  const pending = [];
  const mocked = mockWorkers((worker, request) => {
    pending.push({ worker, request });
    if (pending.length === 2) twoStarted.resolve();
    if (pending.length === 3) thirdStarted.resolve();
    if (pending.length === 4) fourthStarted.resolve();
  });
  const pool = createRenderPool({ size: 2, maxQueue: 1, maxBytes: 4096, idleMs: 10_000, workerFactory: mocked.factory });
  t.after(() => pool.close());

  const first = pool.render(SVG);
  const second = pool.render(SVG);
  await twoStarted.promise;
  assert.equal(pool.stats().workers, 2);
  assert.equal(pool.stats().active, 2);
  const third = pool.render(SVG);
  assert.equal(pool.stats().queued, 1);
  await assert.rejects(pool.render(SVG), { code: "RENDER_POOL_FULL" });
  // The shared pool (a look during a render) waits for room instead of failing.
  const patient = waitingPool(pool, 5).render(SVG);

  const firstRequest = pending[0];
  mockImageReply(firstRequest.worker, firstRequest.request);
  await thirdStarted.promise;
  const thirdRequest = pending[2];
  mockImageReply(pending[1].worker, pending[1].request);
  mockImageReply(thirdRequest.worker, thirdRequest.request);
  await Promise.all([first, second, third]);
  await fourthStarted.promise;
  mockImageReply(pending[3].worker, pending[3].request);
  await patient;

  const requestBytes = Buffer.byteLength(SVG, "utf8") + serialize({}).byteLength;
  const bytePending = deferred();
  const byteMock = mockWorkers((worker, request) => bytePending.resolve({ worker, request }));
  const bytePool = createRenderPool({ size: 1, maxQueue: 4, maxBytes: requestBytes + 1, idleMs: 10_000, workerFactory: byteMock.factory });
  t.after(() => bytePool.close());
  const active = bytePool.render(SVG);
  const activeRequest = await bytePending.promise;
  const waiting = bytePool.render(SVG);
  assert.equal(bytePool.stats().queuedBytes, requestBytes);
  await assert.rejects(bytePool.render(SVG), { code: "RENDER_POOL_FULL" });
  const waitingStarted = deferred();
  byteMock.workers[0].on("mock-post", (request) => {
    if (request.id !== activeRequest.request.id) waitingStarted.resolve(request);
  });
  mockImageReply(activeRequest.worker, activeRequest.request);
  const waitingRequest = await waitingStarted.promise;
  mockImageReply(byteMock.workers[0], waitingRequest);
  await Promise.all([active, waiting]);
});

test("queued byte accounting includes every SVG sample", async (t) => {
  const firstStarted = deferred();
  const secondStarted = deferred();
  const mocked = mockWorkers((worker, request) => {
    if (request.id === 1) firstStarted.resolve({ worker, request });
    else secondStarted.resolve({ worker, request });
  });
  const sampleBytes = Buffer.byteLength(SVG, "utf8") + Buffer.byteLength(SECOND_SVG, "utf8") + serialize(OPTIONS).byteLength;
  const pool = createRenderPool({ size: 1, maxQueue: 1, maxBytes: sampleBytes, idleMs: 10_000, workerFactory: mocked.factory });
  t.after(() => pool.close());

  const first = pool.render(SVG, OPTIONS);
  const firstRequest = await firstStarted.promise;
  const sampled = pool.render(SVG, OPTIONS, { samples: [SECOND_SVG] });
  assert.equal(pool.stats().queuedBytes, sampleBytes);
  assert.equal(pool.stats().queued, 1);
  mockImageReply(firstRequest.worker, firstRequest.request);
  const secondRequest = await secondStarted.promise;
  mockImageReply(secondRequest.worker, secondRequest.request);
  await Promise.all([first, sampled]);
});

test("aborting active work waits for worker termination and clears its listeners", async (t) => {
  const started = deferred();
  const mocked = mockWorkers((worker, request) => started.resolve({ worker, request }));
  const pool = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: mocked.factory });
  t.after(() => pool.close());

  const controller = new AbortController();
  const rendering = pool.render(SVG, {}, { signal: controller.signal, samples: [SECOND_SVG] });
  const { worker, request } = await started.promise;
  assert.deepEqual(request.samples, [SECOND_SVG]);
  controller.abort();
  await assert.rejects(rendering, { name: "AbortError" });
  assert.equal(pool.stats().active, 0);
  assert.equal(pool.stats().workers, 0);
  assert.equal(worker.listenerCount("message"), 0);
  assert.equal(worker.listenerCount("error"), 0);
  assert.equal(worker.listenerCount("exit"), 0);
});

test("aborting queued work removes it and its AbortSignal listener", async (t) => {
  const started = deferred();
  const mocked = mockWorkers((worker, request) => started.resolve({ worker, request }));
  const pool = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: mocked.factory });
  t.after(() => pool.close());

  const active = pool.render(SVG);
  const activeRequest = await started.promise;
  const controller = new AbortController();
  const waiting = pool.render(SVG, {}, { signal: controller.signal });
  assert.equal(pool.stats().queued, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);

  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(pool.stats().queued, 0);
  assert.equal(pool.stats().queuedBytes, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  mockImageReply(activeRequest.worker, activeRequest.request);
  await active;
});

test("close is idempotent and reaps active and queued work", async (t) => {
  const started = deferred();
  const mocked = mockWorkers((worker, request) => started.resolve({ worker, request }));
  const pool = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: mocked.factory });
  t.after(() => pool.close());

  const active = pool.render(SVG);
  const { worker } = await started.promise;
  const waiting = pool.render(SVG);
  const firstClose = pool.close();
  assert.equal(pool.close(), firstClose);
  await Promise.all([
    assert.rejects(active, { code: "RENDER_POOL_CLOSED" }),
    assert.rejects(waiting, { code: "RENDER_POOL_CLOSED" }),
    firstClose,
  ]);
  assert.equal(pool.stats().workers, 0);
  assert.equal(pool.stats().active, 0);
  assert.equal(pool.stats().queued, 0);
  assert.equal(worker.listenerCount("message"), 0);
});

test("a worker crash rejects its frame and the next frame starts on a replacement", async (t) => {
  const mocked = mockWorkers((worker, request, workerCount) => {
    if (workerCount === 1) queueMicrotask(() => worker.emit("error", new Error("synthetic worker failure")));
    else queueMicrotask(() => mockImageReply(worker, request));
  });
  const pool = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: mocked.factory });
  t.after(() => pool.close());

  await assert.rejects(pool.render(SVG), { code: "RENDER_WORKER_CRASH" });
  const result = await pool.render(SVG);
  assert.deepEqual(result, { buffer: Buffer.from([1, 2, 3]), width: 1, height: 1 });
  assert.equal(mocked.workers.length, 2);
});

test("a worker process that dies mid-frame (a Resvg panic aborts it) fails only that frame; the service lives on", async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "render-pool-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dying = join(directory, "dying-worker.mjs");
  await writeFile(dying, 'process.on("message", () => process.kill(process.pid, "SIGKILL")); process.send({ type: "ready", version: 1 });\n');
  const pool = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: () => processWorkerFactory(pathToFileURL(dying)) });
  t.after(() => pool.close());
  await assert.rejects(pool.render(SVG), { code: "RENDER_WORKER_CRASH" });
  await assert.rejects(pool.render(SVG), { code: "RENDER_WORKER_CRASH" }, "the next frame gets a new worker process");
  const unstartable = createRenderPool({ size: 1, idleMs: 10_000, workerFactory: (url) => processWorkerFactory(url, { execPath: join(directory, "no-such-node") }) });
  t.after(() => unstartable.close());
  await assert.rejects(unstartable.render(SVG), { code: "RENDER_WORKER_CRASH" }, "a worker that cannot start fails its frame instead of hanging");
  const real = createRenderPool({ size: 1, idleMs: 10_000 });
  t.after(() => real.close());
  const frame = await real.render(SVG, OPTIONS);
  assert.equal(frame.buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "default workers are processes that draw");
});
