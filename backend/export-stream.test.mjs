import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runExportStream } from "./export-process.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tempDirectory(t, label) {
  const directory = await mkdtemp(path.join(tmpdir(), `kino-export-stream-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitForPid(marker, signal, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason ?? new Error("The producer was cancelled.");
    try {
      const pid = Number(await readFile(marker, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
    await delay(10);
  }
  throw new Error("The encoder did not reach its ready barrier.");
}

function assertProcessGone(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "encoder was reaped before the runner returned");
}

test("encoder stream preserves binary frame order", async () => {
  const frames = [
    Buffer.from([0, 1, 2, 0xff, 0xfe]),
    Buffer.from([0x80, 0x81, 0, 0x7f]),
    Buffer.from("last frame\0binary", "utf8"),
  ];
  const input = async function* () {
    for (const frame of frames) yield frame;
  };
  const script = "const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('base64')))";

  const output = await runExportStream(process.execPath, ["-e", script], { input });
  assert.equal(output, Buffer.concat(frames).toString("base64"));
});

test("a slow reader backpressures the producer to one outstanding frame", { timeout: 10_000 }, async () => {
  const firstYield = deferred();
  let yielded = 0;
  const input = async function* () {
    for (let index = 0; index < 8; index += 1) {
      yielded += 1;
      if (yielded === 1) firstYield.resolve();
      yield Buffer.alloc(1024 * 1024, index);
    }
  };
  const script = "process.stdin.pause();setTimeout(()=>{let bytes=0;process.stdin.on('data',chunk=>bytes+=chunk.length);process.stdin.on('end',()=>process.stdout.write(String(bytes)));process.stdin.resume()},300)";

  const completion = runExportStream(process.execPath, ["-e", script], { input });
  await firstYield.promise;
  await delay(80);
  assert.equal(yielded, 1, "the producer waits for the current child pipe write before asking for another frame");
  assert.equal(await completion, String(8 * 1024 * 1024));
});

test("a non-byte frame rejects and reaps its encoder", { timeout: 8000 }, async (t) => {
  const directory = await tempDirectory(t, "invalid-frame");
  const marker = path.join(directory, "pid");
  const pidReady = deferred();
  let completion;
  t.after(async () => { await completion?.catch(() => {}); });
  const input = async function* (signal) {
    const pid = await waitForPid(marker, signal);
    pidReady.resolve(pid);
    yield "not a byte buffer";
  };
  const child = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));process.stdin.on('data',()=>{});setInterval(()=>{},100)";

  completion = runExportStream(process.execPath, ["-e", child, marker], { input });
  const outcome = completion.then(() => null, (error) => error);
  const pid = await pidReady.promise;
  const error = await outcome;
  assert.ok(error instanceof Error);
  assert.match(error.message, /Encoder input must contain byte buffers/);
  assertProcessGone(pid);
});

test("producer failure cancels and reaps an encoder that ignores SIGTERM", { timeout: 8000 }, async (t) => {
  const directory = await tempDirectory(t, "producer-failure");
  const marker = path.join(directory, "pid");
  const pidReady = deferred();
  let completion;
  t.after(async () => { await completion?.catch(() => {}); });
  const input = async function* (signal) {
    const pid = await waitForPid(marker, signal);
    pidReady.resolve(pid);
    yield Buffer.from("first rendered frame");
    throw new Error("synthetic frame producer failure");
  };
  const child = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));process.stdin.on('data',()=>{});setInterval(()=>{},100)";

  completion = runExportStream(process.execPath, ["-e", child, marker], { input });
  const outcome = completion.then(() => null, (error) => error);
  const pid = await pidReady.promise;
  const error = await outcome;
  assert.ok(error instanceof Error);
  assert.match(error.message, /synthetic frame producer failure/);
  assertProcessGone(pid);
});

test("an early encoder exit aborts the frame producer", { timeout: 6000 }, async (t) => {
  const directory = await tempDirectory(t, "early-exit");
  const marker = path.join(directory, "pid");
  let producerStopped = false;
  let producerSawAbort = false;
  let completion;
  t.after(async () => { await completion?.catch(() => {}); });
  const input = async function* (signal) {
    try {
      yield Buffer.alloc(1024 * 1024, 0x5a);
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      producerSawAbort = signal.aborted;
      yield Buffer.from("must not reach the closed encoder");
    } finally {
      producerStopped = true;
      producerSawAbort ||= signal.aborted;
    }
  };
  const child = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));process.stdin.once('data',()=>process.exit(23))";

  completion = runExportStream(process.execPath, ["-e", child, marker], { input });
  const outcome = completion.then(() => null, (error) => error);
  const pid = await waitForPid(marker, new AbortController().signal);
  const error = await outcome;
  assert.ok(error instanceof Error);
  assert.match(error.message, /exit code 23/);
  assert.equal(producerStopped, true);
  assert.equal(producerSawAbort, true);
  assertProcessGone(pid);
});

test("external abort terminates and reaps an encoder that ignores SIGTERM", { timeout: 8000 }, async (t) => {
  const directory = await tempDirectory(t, "external-abort");
  const marker = path.join(directory, "pid");
  const pidReady = deferred();
  const producerWaiting = deferred();
  const controller = new AbortController();
  let producerStopped = false;
  let producerSawAbort = false;
  let completion;
  t.after(async () => {
    controller.abort();
    await completion?.catch(() => {});
  });
  const input = async function* (signal) {
    try {
      const pid = await waitForPid(marker, signal);
      pidReady.resolve(pid);
      yield Buffer.from("frame before cancellation");
      producerWaiting.resolve();
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      producerSawAbort = signal.aborted;
    } finally {
      producerStopped = true;
      producerSawAbort ||= signal.aborted;
    }
  };
  const child = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));process.stdin.on('data',()=>{});setInterval(()=>{},100)";

  completion = runExportStream(process.execPath, ["-e", child, marker], { input, signal: controller.signal });
  const outcome = completion.then(() => null, (error) => error);
  const pid = await pidReady.promise;
  await producerWaiting.promise;
  controller.abort();
  const error = await outcome;
  assert.equal(error?.name, "AbortError");
  assert.equal(producerStopped, true);
  assert.equal(producerSawAbort, true);
  assertProcessGone(pid);
});
