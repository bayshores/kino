// The footage finder: from a prompt alone to found, scanned and imported clips. No network here:
// yt-dlp, fetch, the embedder and Vision are stubs.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKinoMcpServer } from "./mcp.mjs";
import { createWebCache } from "./web-cache.mjs";
import { downloadScanCopy, parseProbe, pickWindows, probeFootage } from "./footage-finder/scan.mjs";
import { pruneScans, rankShots, readScan, scanFootage, scansFolder } from "./footage-finder/score.mjs";
import { encodeVector, normalize } from "./music-embed.mjs";
import { findShots } from "./shot-detection.mjs";
import { botCheckError, createYouTubeGate } from "./process-slots.mjs";
import { removeTempFolder } from "./temp-folders.mjs";

test("library passes the fields its listed schema leaves out (scan, want, note, measure) on to kino", async () => {
  const calls = [];
  const client = { async call(name, input) { calls.push({ name, input }); return { text: "ok" }; }, async importFile() { return {}; } };
  const server = createKinoMcpServer({ client });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "footage-test", version: "1" });
  await Promise.all([server.connect(serverSide), agent.connect(clientSide)]);
  try {
    const sent = { topic: "music", scan: "top", want: "white hair, fight", note: { id: "F3", verdict: "no", why: "a reaction" }, measure: "S1" };
    const result = await agent.callTool({ name: "library", arguments: sent });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const input = calls.find((call) => call.name === "library").input;
    for (const key of ["scan", "want", "note", "measure"]) assert.deepEqual(input[key], sent[key], key);
  } finally {
    await agent.close();
    await server.close();
  }
});

test("the web cache answers a fresh key without asking again, and asks again once it is old", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-times-"));
  try {
    let clock = 1000;
    const cache = createWebCache({ directory: path.join(directory, "cache"), ttlMs: 500, now: () => clock });
    let asked = 0;
    const make = async () => ({ answer: ++asked });
    assert.deepEqual(await cache.cached("ytsearch20:x", make), { answer: 1 });
    clock += 499;
    assert.deepEqual(await cache.cached("ytsearch20:x", make), { answer: 1 });
    clock += 1;
    assert.deepEqual(await cache.cached("ytsearch20:x", make), { answer: 2 });
    await assert.rejects(cache.cached("other", async () => { throw new Error("offline"); }), /offline/);
    assert.deepEqual(await cache.cached("other", make), { answer: 3 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scan looks at heatmap peaks and matching chapters, 8 min at most, else 6 even minutes", () => {
  const heatmap = Array.from({ length: 100 }, (_, index) => ({ start_time: index * 14.4, end_time: (index + 1) * 14.4, value: index === 40 ? 1 : index === 70 ? 0.8 : 0.1 }));
  const fixture = { id: "abcdefghijk", title: "Episode 5", duration: 1440, heatmap, availability: "public",
    chapters: [{ start_time: 0, end_time: 90, title: "Opening" }, { start_time: 900, end_time: 960, title: "The Fight" }],
    formats: [{ height: 360, vcodec: "vp9" }, { height: 1080, vcodec: "vp9" }, { height: null, vcodec: "none" }] };
  const probe = parseProbe(JSON.stringify(fixture));
  assert.equal(probe.height, 1080);
  assert.equal(probe.cannotPlay, null);
  assert.equal(parseProbe(JSON.stringify({ ...fixture, availability: "subscriber_only" })).cannotPlay, "members only");
  // Peak 40 is 576-590.4 (middle 583.2), peak 70 is 1008-1022.4; the flat 0.1 parts are no peaks.
  const peaks = pickWindows({ ...probe, chapters: [] });
  assert.deepEqual(peaks.slice(0, 2), [{ start: 568.2, end: 598.2 }, { start: 1000.2, end: 1030.2 }]);
  assert.deepEqual(pickWindows(probe, { want: "white hair, fight" }).slice(0, 3), [{ start: 568.2, end: 598.2 }, { start: 900, end: 960 }, { start: 1000.2, end: 1030.2 }]);
  // Many peaks: never more than 8 minutes in all.
  const spiky = pickWindows({ duration: 3600, heatmap: Array.from({ length: 100 }, (_, index) => ({ start: index * 36, end: (index + 1) * 36, value: index % 2 ? 0.2 : 0.9 })) });
  assert.ok(Math.abs(spiky.reduce((sum, window) => sum + window.end - window.start, 0) - 480) < 1);
  const even = pickWindows({ duration: 1440, heatmap: [], chapters: [] });
  assert.equal(even.length, 6);
  assert.deepEqual(even[0], { start: 90, end: 150 });
  assert.deepEqual(pickWindows({ duration: 300 }), [{ start: 0, end: 300 }]);
  // from/to limit the scan to that stretch (8 min at most); a time outside the video or no time at all is an error.
  assert.deepEqual(pickWindows(probe, { from: "3:00", to: "3:20" }), [{ start: 180, end: 200 }]);
  assert.deepEqual(pickWindows(probe, { from: 60 }), [{ start: 60, end: 540 }]);
  assert.throws(() => pickWindows(probe, { from: 2000, to: 2100 }), /"from" \(33:20\) is past the end of this video \(24:00\)/);
  assert.throws(() => pickWindows(probe, { from: "abc" }), /"from" \(abc\) is not a time/);
  assert.throws(() => pickWindows(probe, { to: 0 }), /^Error: "to" \(0:00\) must come after "from" \(0:00\)\.$/);
  // whole:true stops at 30 min and names from/to instead.
  assert.equal(pickWindows({ duration: 1440 }, { whole: true })[0].end, 1440);
  assert.throws(() => pickWindows({ duration: 10800 }, { whole: true }), /3:00:00 long.*from and to/);
});

test("a probe that meets YouTube's bot check pauses the shared gate, so the next download refuses", async () => {
  const youtube = createYouTubeGate({ now: () => 1000 });
  const runtime = { name: "node", path: process.execPath };
  await assert.rejects(probeFootage("abcdefghijk", { youtube, runtime, run: async () => { throw botCheckError(); } }), { code: "BOT_CHECK" });
  assert.equal(youtube.paused(), true);
  await assert.rejects(downloadScanCopy("abcdefghijk", [{ start: 0, end: 60 }], { youtube, runtime, run: async () => "" }), { code: "BOT_CHECK" });
  await assert.rejects(probeFootage("abcdefghijk", { youtube, runtime, run: async () => "{}" }), { code: "BOT_CHECK" });
});

test("the scan copy is 360p, one section per stretch, through the gate, with no cookies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-times-"));
  // A stub yt-dlp: it saves its arguments and writes an empty file for each section asked for.
  const stub = path.join(directory, "yt-dlp");
  await writeFile(stub, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(directory, "args.json"))}, JSON.stringify(args));
const out = args[args.indexOf("-o") + 1];
args.forEach((arg, index) => { if (arg === "--download-sections") fs.writeFileSync(out.replace("%(section_start)s", args[index + 1].slice(1).split("-")[0]).replace("%(ext)s", "webm"), ""); });
`);
  await chmod(stub, 0o755);
  let gated = 0;
  const youtube = (work) => { gated += 1; return work(); };
  const windows = [{ start: 95, end: 125 }, { start: 900, end: 960 }];
  try {
    const copy = await downloadScanCopy("abcdefghijk", windows, { youtube, command: stub, runtime: { name: "node", path: process.execPath } });
    try {
      const args = JSON.parse(await readFile(path.join(directory, "args.json"), "utf8"));
      assert.equal(gated, 1);
      assert.equal(args[args.indexOf("-S") + 1], "res:360");
      assert.deepEqual(args.filter((_, index) => args[index - 1] === "--download-sections"), ["*95-125", "*900-960"]);
      assert.ok(args.includes("--no-cookies") && args.includes("--ignore-config"));
      assert.ok(!args.some((arg) => /^--cookies/.test(arg)));
      assert.ok(path.basename(copy.folder).startsWith("kino-footage-"));
      assert.deepEqual(copy.files.map((file) => [file.start, path.basename(file.file)]), [[95, "scan.95.webm"], [900, "scan.900.webm"]]);
    } finally {
      await removeTempFolder(copy.folder);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scan puts dark and title shots last, joins 0.96-alike neighbors, gives match as a z-score and removes the copy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-times-"));
  const copyFolder = path.join(directory, "copy");
  await mkdir(copyFolder);
  // Five 2 s shots: A moves with a face; B and C are one held picture (0.96 alike); D is dark; E is a title card.
  const looks = { A: [1, 0, 0, 0], B: [0, 1, 0, 0], C: [0, 0.96, 0.28, 0], D: [0, 0, 1, 0], E: [0, 0, 0, 1] };
  const shotAt = (t) => "ABCDE"[Math.min(4, Math.floor(t / 2))];
  const samples = Array.from({ length: 40 }, (_, index) => {
    const t = index / 4;
    const shot = shotAt(t);
    return { t, luma: shot === "D" ? 0.05 : 0.5, change: shot === "B" || shot === "C" ? 0.01 : 0.1, motion: null,
      faces: shot === "A" ? [[0.4, 0.3, 0.2, 0.3]] : [], text: shot === "E" ? [{ box: [0.2, 0.4, 0.6, 0.2], s: "EPISODE 5" }] : [] };
  });
  let sheetStills = null;
  const tools = {
    probe: async () => ({ duration: 10, width: 640, height: 360 }),
    findShots: async (file, { maxSeconds }) => {
      assert.equal(maxSeconds, 1800);
      return { shots: [0, 2, 4, 6, 8].map((start) => ({ start, end: start + 2 })) };
    },
    measure: async () => ({ samples, vision: { faces: true, text: true, flow: false } }),
    stills: async (file, times) => times.map((time) => `still-${shotAt(time)}`),
    sheet: async (stills, out) => { sheetStills = stills; await writeFile(out, "jpg"); },
  };
  const embed = {
    images: async (files) => ({ model: "test", vectors: files.map((file) => encodeVector(normalize(looks[file.slice(-1)]))) }),
    text: async () => [Float32Array.from([1, 0, 0, 0])],
  };
  try {
    const copy = { folder: copyFolder, files: [{ start: 60, end: 70, file: path.join(copyFolder, "scan.60.webm") }] };
    const scan = await scanFootage("yt-abcdefghijk", copy, { dataRoot: directory, want: "white hair", embed, tools });
    await assert.rejects(stat(copyFolder), { code: "ENOENT" });
    assert.deepEqual(scan.skipped, { dark: 1, text: 1, short: 0, repeats: 1 });
    // Numbers follow time (A 1, B+C 2, D 3, E 4); the clean shots rank first, the dark and title shots last.
    assert.deepEqual(scan.shots.map((shot) => shot.n), [1, 2, 3, 4]);
    assert.deepEqual(scan.shots.map((shot) => [shot.start, shot.end]), [[60, 62], [62, 66], [66, 68], [68, 70]]);
    assert.deepEqual(scan.shots.slice(2).map((shot) => shot.flags), [["dark"], ["text"]]);
    assert.equal(scan.shots[0].face, 100);
    // Closeness 1, 0, 0, 0 as z-scores; 1.7 is under 2, so match does not count.
    assert.deepEqual(scan.shots.map((shot) => shot.match), [1.7, -0.6, -0.6, -0.6]);
    assert.equal(scan.matchShown, false);
    assert.deepEqual(sheetStills, ["still-A", "still-B", "still-D", "still-E"]);
    assert.deepEqual((await readScan(directory, "yt-abcdefghijk")).shots.length, 4);
    // Ten even shots, one of them close to the words: a z-score of 3 counts, and that shot leads.
    const ten = Array.from({ length: 10 }, (_, index) => ({ start: index, end: index + 1, motion: index === 7 ? 10 : 60, face: 0, luma: 0.5, text: 0, logo: 0,
      vector: normalize(index === 7 ? [1, 0, 0, 0] : [0, 1, 0, 0]) }));
    const ranked = rankShots(ten, { wantVector: Float32Array.from([1, 0, 0, 0]) });
    assert.equal(ranked.matchShown, true);
    assert.deepEqual([ranked.shots[0].start, ranked.shots[0].match], [7, 3]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // Without the footage finder's allowance, a 25 min file is still too long to look in.
  await assert.rejects(findShots("none.webm", { duration: 1500 }), { code: "TOO_LONG" });
  await assert.rejects(findShots("none.webm", { duration: 2000, maxSeconds: 1800 }), /up to 30 min/);
});

test("the scans folder keeps its cap by removing the least recently used scans, never a kept one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-times-"));
  try {
    const folder = scansFolder(directory);
    await mkdir(folder, { recursive: true });
    for (const [index, id] of ["a", "b", "c", "d"].entries()) {
      for (const extension of ["json", "jpg"]) {
        const file = path.join(folder, `${id}.${extension}`);
        await writeFile(file, "{}");
        await utimes(file, 1000 + index, 1000 + index);
      }
    }
    await readScan(directory, "b");
    // 8 files, at most 4: a is the oldest but kept, b was just read; c and d go.
    assert.deepEqual(await pruneScans(directory, { keep: ["a"], maxFiles: 4 }), ["c", "d"]);
    assert.deepEqual(await pruneScans(directory, { keep: ["a"], maxFiles: 4 }), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
