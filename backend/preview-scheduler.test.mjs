import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLayer } from "../engine/model.js";
import { createPreviewCache } from "./preview-segments.mjs";
import { createPreviewScheduler } from "./preview-scheduler.mjs";
import { backgroundStep, callStarted, ffmpegArgs, isBackground } from "./render-activity.mjs";

// A 5 s scene (three segments): "late" shows only from 4.2 s.
function document(lateFill = "#00ff00") {
  return { id: "p1", scenes: [{
    id: "s1", name: "Scene", width: 160, height: 90, duration: 5, background: "#101010",
    layers: [
      createLayer("rectangle", { id: "always", x: 10, y: 10, width: 40, height: 30, fill: "#ff0000" }),
      createLayer("rectangle", { id: "late", x: 80, y: 40, width: 40, height: 30, fill: lateFill, opacity: 0,
        animations: [{ id: "a1", start: 4.2, duration: 0.5, from: {}, to: { opacity: 1 }, easing: "linear" }] }),
    ],
  }] };
}

// A scheduler on a real preview cache, with fake renders and a fake render counter.
async function setup(t, render, more = {}) {
  const data = await mkdtemp(join(tmpdir(), "kino-test-times-scheduler-"));
  const cache = createPreviewCache({ dataDirectory: data, maxBytes: 1024 * 1024 });
  const listeners = new Set();
  const activity = { count: 0, running: () => activity.count, listen: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit(kind) { activity.count += kind === "start" ? 1 : -1; listeners.forEach((listener) => listener(kind)); } };
  const state = { revision: 1, document: document() };
  const scheduler = createPreviewScheduler({ cache, activity, idleMs: 10, enabled: () => true, render: (scene, segment, options) => render(segment, options, cache, data),
    project: async () => state, prepare: async (_id, _revision, value) => ({ scene: value.scenes[0] }), ...more });
  t.after(async () => {
    scheduler.close();
    await cache.close();
    await rm(data, { recursive: true, force: true });
  });
  return { scheduler, activity, state, cache };
}

// A finished segment: a small file stored under its key.
async function store(segment, cache, data) {
  const file = join(data, `${segment.key}.mp4`);
  await writeFile(file, "fake segment");
  await cache.store(segment.key, file, {});
}

const until = async (check) => { for (let tries = 0; !(await check()); tries += 1) { if (tries > 200) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); } };

test("a render that starts stops the background segment at once, and nothing half-made is kept", async (t) => {
  const started = [];
  let aborted = 0;
  const { scheduler, activity, state, cache } = await setup(t, (segment, { signal }, cacheIn, data) => new Promise((resolve, reject) => {
    started.push(segment.index);
    // The first try waits until it is stopped; the second finishes.
    if (started.length > 1) return store(segment, cacheIn, data).then(resolve, reject);
    signal.addEventListener("abort", () => { aborted += 1; reject(new Error("stopped")); }, { once: true });
  }));
  const before = await scheduler.list("p1", "s1", state);
  assert.deepEqual(before.segments.map((segment) => segment.ready), [false, false, false]);
  await until(() => scheduler.running());
  // Heaviest first: the last segment holds both layers.
  assert.equal(started[0], 2);
  activity.emit("start");
  await until(() => !scheduler.running());
  assert.equal(aborted, 1);
  assert.equal(await cache.locate(before.segments[2].key), null, "nothing stored for the stopped segment");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(started.length, 1, "nothing renders while the other render runs");
  activity.emit("end");
  await until(async () => (await scheduler.list("p1", "s1", state)).segments.every((segment) => segment.ready));
  assert.deepEqual(started.slice(0, 2), [2, 2]);
  const after = await scheduler.list("p1", "s1", state);
  assert.equal(after.segments[2].url, `/api/dashboard/preview/${after.segments[2].key}.mp4`);
  assert.equal(await scheduler.file(after.segments[2].key), (await cache.locate(after.segments[2].key)).path);
});

test("after an edit, only the segments it touched are not ready", async (t) => {
  const { scheduler, state } = await setup(t, (segment, _options, cache, data) => store(segment, cache, data));
  await scheduler.list("p1", "s1", state);
  await until(async () => (await scheduler.list("p1", "s1", state)).segments.every((segment) => segment.ready));
  const old = await scheduler.list("p1", "s1", state);
  // Revision 2 recolors "late", which shows only in the last segment.
  Object.assign(state, { revision: 2, document: document("#0000ff") });
  scheduler.close();
  const now = await scheduler.list("p1", "s1", state);
  assert.equal(now.rev, 2);
  assert.deepEqual(now.segments.map((segment) => segment.ready), [true, true, false]);
  assert.deepEqual(now.segments.slice(0, 2).map((segment) => segment.key), old.segments.slice(0, 2).map((segment) => segment.key));
  assert.equal(now.segments[2].url, undefined);
});

test("a failed segment is said once and not tried again; turned off, drawing stops at once; a deleted project's segments go", async (t) => {
  const warnings = [];
  let on = true;
  let tries = 0;
  const kept = new Set(["p1"]);
  const { scheduler, state, cache } = await setup(t, (segment, { signal }) => new Promise((_resolve, reject) => {
    tries += 1;
    if (tries === 1) return reject(new Error("The media file resolves outside the media directory."));
    signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  }), { warn: (message) => warnings.push(message), enabled: () => on, projectIds: async () => [...kept] });
  await scheduler.list("p1", "s1", state);
  await until(() => tries === 2 && scheduler.running());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[kino\] Preview segment 3 \(4-5 s\) could not be drawn: The media file resolves outside the media directory\.$/);
  on = false;
  scheduler.refresh();
  await until(() => !scheduler.running());
  assert.equal(warnings.length, 1, "a stop is not a failure");
  // Segments stored for p1 and for p2; p2 goes to the trash.
  for (const [index, projectId] of [[1, "p1"], [2, "p2"]]) {
    const file = join(tmpdir(), `kino-test-times-prune-${process.pid}-${index}.mp4`);
    await writeFile(file, "fake segment");
    await cache.store(String(index).repeat(64), file, { projectId });
    await rm(file);
  }
  assert.equal(await scheduler.prune(), 1);
  assert.ok(await cache.locate("1".repeat(64)));
  assert.equal(await cache.locate("2".repeat(64)), null);
});

test("a background step waits while an agent call runs and goes a moment after it ends (or after its longest wait); one a call waits for goes at once", async () => {
  const ran = [];
  const ended = callStarted();
  const step = backgroundStep(() => { ran.push({ background: isBackground(), args: ffmpegArgs(["-i", "a.mp4"]) }); }, { quietMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ran.length, 0, "the call is still running");
  // A busy agent slows background work but never stops it for good: maxWaitMs.
  await backgroundStep(() => { ran.push("late"); }, { quietMs: 30, maxWaitMs: 60 });
  assert.deepEqual(ran, ["late"], "it went after its longest wait, the call still running");
  ran.length = 0;
  let wanted = false;
  const urgent = backgroundStep(() => { ran.push({ urgent: true, background: isBackground() }); }, { quietMs: 30, urgent: () => wanted });
  wanted = true;
  await urgent;
  assert.deepEqual(ran, [{ urgent: true, background: false }]);
  const endedAt = Date.now();
  ended();
  await step;
  assert.ok(Date.now() - endedAt >= 25, "it waited for quiet after the call");
  assert.deepEqual(ran[1], { background: true, args: ["-threads", "2", "-filter_threads", "2", "-i", "a.mp4"] });
});

test("an edit in another project does not take the worker away from the watched project", async (t) => {
  const drawn = [];
  const { scheduler, state } = await setup(t, (segment, options, cache, data) => { drawn.push(options.projectId); return store(segment, cache, data); });
  await scheduler.list("p1", "s1", state);
  scheduler.changed("p2");
  await until(async () => (await scheduler.list("p1", "s1", state)).segments.every((segment) => segment.ready));
  assert.ok(drawn.length > 0);
  assert.deepEqual([...new Set(drawn)], ["p1"]);
});
