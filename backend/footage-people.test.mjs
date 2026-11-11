import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPeopleCache, saliencyStatus } from "./footage/people.mjs";
import { makeVideo, skipWithoutMediaTools } from "./media.test.support.mjs";

test("a clip that failed is not measured again for ten minutes; a cancelled one is", async () => {
  let tries = 0;
  let clock = 0;
  const cache = createPeopleCache({ now: () => clock, measure: async () => { tries += 1; throw new Error("FFmpeg could not decode the video: broken"); } });
  const file = path.join(tmpdir(), "kino-people-never-written.mp4");
  await assert.rejects(cache.get(file, {}), /could not decode/);
  await assert.rejects(cache.get(file, {}), /could not decode/);
  assert.equal(tries, 1);
  clock = 11 * 60_000;
  await assert.rejects(cache.get(file, {}));
  assert.equal(tries, 2);

  let cancels = 0;
  const cancelled = createPeopleCache({ measure: async () => { cancels += 1; throw Object.assign(new Error("cancelled"), { name: "AbortError" }); } });
  await assert.rejects(cancelled.get(file, {}));
  await assert.rejects(cancelled.get(file, {}));
  assert.equal(cancels, 2);
});

test("a helper that stopped on a clip is remembered; a computer without the helper is not", async () => {
  let tries = 0;
  const stopped = createPeopleCache({ measure: async () => { tries += 1; return { version: 1, unavailable: "the kino-measure helper stopped: crash" }; } });
  const file = path.join(tmpdir(), "kino-people-never-written-2.mp4");
  await stopped.get(file, {});
  assert.match((await stopped.get(file, {})).unavailable, /helper stopped/);
  assert.equal(tries, 1);

  let asks = 0;
  const none = createPeopleCache({ measure: async () => { asks += 1; return { version: 1, unavailable: "finding people needs macOS 12 or later" }; } });
  await none.get(file, {});
  await none.get(file, {});
  assert.equal(asks, 2);
});

// A stand-in for the kino-measure helper: frame 0 has a face, the later frames do not, and every
// frame has a saliency box and one person. It answers only the jobs it is asked (8, 16, 32).
const STUB_HELPER = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--abilities")) { console.log(JSON.stringify({ version: "stub", macOS: "15.0", flow: true, text: true, print: true, saliency: true, faces: true, people: true })); process.exit(0); }
const size = Number(args[args.indexOf("--width") + 1]) * Number(args[args.indexOf("--height") + 1]) * 4;
let buffer = Buffer.alloc(0), index = 0;
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 1 + size) {
    const jobs = buffer[0];
    buffer = buffer.subarray(1 + size);
    const line = { i: index };
    if (jobs & 8) line.saliency = [[0.4, 0.3, 0.2, 0.2]];
    if (jobs & 16) line.faces = index === 0 ? [[0.1, 0.1, 0.2, 0.3]] : [];
    if (jobs & 32) line.people = [{ box: [0.1, 0.1, 0.3, 0.8], head: 0 }];
    console.log(JSON.stringify(line));
    index += 1;
  }
});
`;

test("subjects-v1 uses faces when a shot has one and saliency when it has none; people-v1 is unchanged", { skip: skipWithoutMediaTools }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-subjects-"));
  const previous = process.env.KINO_MEASURE_HELPER;
  try {
    const helper = path.join(folder, "stub-measure.mjs");
    await writeFile(helper, STUB_HELPER, { mode: 0o755 });
    process.env.KINO_MEASURE_HELPER = helper;
    const clip = await makeVideo(path.join(folder, "clip.mp4"), { width: 64, height: 48, fps: 2, frames: 4, frameColor: () => [90, 90, 90] });
    const cache = createPeopleCache();
    const subjects = await cache.subjects(clip, { width: 64, height: 48, duration: 2 });
    assert.equal(subjects.samples.length, 4);
    assert.deepEqual(subjects.samples[0].subjects, [{ box: [0.1, 0.1, 0.2, 0.3], kind: "face" }]);
    assert.deepEqual(subjects.samples[1].subjects, [{ box: [0.4, 0.3, 0.2, 0.2], kind: "saliency" }]);
    // The same pass kept both files, and people-v1 has no subjects and no saliency in it.
    const people = await cache.saved(clip);
    assert.equal(people.samples[1].subjects, undefined);
    assert.deepEqual(people.samples[1].faces, []);
    assert.deepEqual(await cache.savedSubjects(clip), subjects);
    assert.equal(subjects.saliency, true);
  } finally {
    if (previous === undefined) delete process.env.KINO_MEASURE_HELPER; else process.env.KINO_MEASURE_HELPER = previous;
    await rm(folder, { recursive: true, force: true });
  }
});

test("the subjects header says saliency did not run, so an empty list is not read as 'nothing stands out'", () => {
  // Looked and found nothing: an empty list still counts as having run.
  assert.equal(saliencyStatus([{ faces: [], people: [], saliency: [] }], true), true);
  // The helper has no saliency (older helper): the ability's own reason is kept.
  assert.equal(saliencyStatus([{ faces: [], people: [] }], "saliency is missing"), "saliency is missing");
  // Vision failed on every picture.
  assert.equal(saliencyStatus([{ faces: [], people: [], errors: { saliency: "boom" } }], true), "Vision could not: boom");
  // No answers at all (or holes in the list) still gives a reason, never true.
  assert.notEqual(saliencyStatus([undefined], true), true);
});
