// Inspire's live view (backend/inspire.mjs): while a reference is measured, the screen gets its cuts
// as soon as they are found and about 4 frames a second with their flow arrows and the text Vision
// read, as small JPEGs that are sent and never saved.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { LIVE_WIDTH, createInspire, encodeLiveFrame, liveFlow } from "./inspire.mjs";

let folder;
before(async () => { folder = await mkdtemp(path.join(tmpdir(), "kino-inspire-live-")); });
after(async () => { await rm(folder, { recursive: true, force: true }); });

function memoryProjects() {
  const states = new Map();
  return {
    read: async (id) => states.get(id) ?? null,
    update: async (id, change) => {
      const { state, value } = change(structuredClone(states.get(id) ?? null));
      states.set(id, state);
      return value;
    },
  };
}

const waitFor = async (check) => { for (let tries = 0; tries < 400 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(check()); };

test("flow arrows become fractions of the picture; a frame without flow has none", () => {
  const flow = { cols: 2, rows: 1, u: [64, -32], v: [0, 36], rev: 1 };
  assert.deepEqual(liveFlow(flow, 640, 360), { cols: 2, rows: 1, u: [0.1, -0.05], v: [0, 0.1] });
  assert.equal(liveFlow(null, 640, 360), null);
  assert.equal(liveFlow({ cols: 2, rows: 2, u: [1], v: [1] }, 640, 360), null, "a short grid is left out");
});

test("a live frame is a small JPEG with the frame's colors", () => {
  const width = 640, height = 360;
  const bgra = Buffer.alloc(width * height * 4);
  // Blue in BGRA order is the first byte: a pure blue frame.
  for (let index = 0; index < bgra.length; index += 4) { bgra[index] = 255; bgra[index + 3] = 255; }
  const bytes = encodeLiveFrame({ bgra, width, height }, createCanvas);
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8, "a JPEG");
  assert.ok(bytes.length < 20_000, "small enough to send 4 times a second");
  assert.equal(LIVE_WIDTH, 320);
});

test("while measuring, the cuts arrive before the fingerprint, live frames are thinned and never saved", async () => {
  const directory = path.join(folder, "live");
  const events = [];
  let clock = 1000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const projects = memoryProjects();
  const inspire = createInspire({
    directory,
    projectState: projects,
    now: () => clock,
    publish: (event) => events.push(event),
    lookup: async (videoId) => ({ id: `yt:${videoId}`, videoId, title: "a walk", channel: "someone", duration: 30, url: `https://www.youtube.com/watch?v=${videoId}`, thumbnail: "" }),
    async download(videoId, work) { const file = path.join(work, "clip.mp4"); await writeFile(file, "x"); return file; },
    probe: async () => ({ duration: 30 }),
    findShots: async () => ({ shots: [{ start: 0 }, { start: 10 }, { start: 20 }] }),
    findBeats: async () => ({ beats: [0, 10, 20.5], bpm: 120 }),
    fetchThumb: async () => null,
    encodeFrame: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    async fingerprint(file, { onFrame }) {
      const frame = (t) => ({ t, seconds: 30, width: 640, height: 360, bgra: Buffer.alloc(16), flow: { cols: 1, rows: 1, u: [64], v: [0] }, text: [{ box: [0.1, 0.8, 0.5, 0.1], s: "we get these depth maps", c: 0.9 }] });
      onFrame(frame(0));
      onFrame(frame(0.25)); // too soon: left out
      clock += 300;
      onFrame(frame(0.5));
      await gate;
      return { fingerprint: { version: 1, seconds: 30 }, prints: [] };
    },
  });
  await inspire.add("p1", "yt:tgEWNHVbk3U");
  await inspire.remeasure("yt:tgEWNHVbk3U");
  await waitFor(() => events.filter((event) => event.type === "inspire-live").length === 2);
  const live = events.filter((event) => event.type === "inspire-live").map((event) => event.live);
  assert.deepEqual(live.map((frame) => frame.t), [0, 0.5]);
  assert.equal(live[0].image, "data:image/jpeg;base64,/9j/2Q==");
  assert.deepEqual(live[0].flow, { cols: 1, rows: 1, u: [0.1], v: [0] });
  assert.deepEqual(live[0].text, [{ box: [0.1, 0.8, 0.5, 0.1], s: "we get these depth maps" }]);
  // The screen opened now gets the latest frame, and the cuts and beat found so far.
  const view = await inspire.projectView("p1");
  assert.equal(view.live.t, 0.5);
  const ref = view.refs["yt:tgEWNHVbk3U"];
  assert.equal(ref.state, "measuring");
  assert.deepEqual(ref.partial.cuts, [10, 20]);
  assert.deepEqual(ref.partial.onBeat, [true, false]);
  assert.equal(ref.partial.bpm, 120);
  release();
  await waitFor(() => events.some((event) => event.type === "inspire-ref" && event.ref.state === "measured"));
  const done = await inspire.projectView("p1");
  assert.equal(done.live, null, "no live frame once nothing is measured");
  assert.equal(done.refs["yt:tgEWNHVbk3U"].partial, undefined);
  // Live frames are never written down.
  const files = await readdir(directory);
  for (const name of files.filter((file) => file.endsWith(".json"))) {
    const text = await (await import("node:fs/promises")).readFile(path.join(directory, name), "utf8");
    assert.ok(!text.includes("image/jpeg") && !text.includes("depth maps"), name);
  }
});
