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
import { createFootageFinder } from "./footage-finder/index.mjs";
import { candidateLine, droppedLine, nothingFoundText, parseFootageLines } from "./footage-finder/search.mjs";
import { createCommonsSource, parseCommonsSearch } from "./footage-finder/licensed.mjs";
import { addCandidates, createFootageActions, FOOTAGE_TOPIC_LINE, logoLast, scanText } from "./footage-finder/actions.mjs";
import { LOOK_MODEL, lookModelReady } from "./look-embed.mjs";
import { createAgentService } from "./agent/service.mjs";
import { LIBRARY_TOPICS } from "./agent/actions.mjs";
import { footageLed } from "./footage-finder/step.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { withAsk } from "./agent-ask.test.support.mjs";
import { openStore } from "./store.mjs";
import { createDocument, createLayer, createScene } from "../engine/model.js";

// One flat search line as yt-dlp prints it.
const ytLine = (id, title, extra = {}) => JSON.stringify({ id: id.padEnd(11, "x"), title, channel: "Some Fan", duration: 600, url: `https://www.youtube.com/watch?v=${id.padEnd(11, "x")}`, ...extra });

// One Commons search answer page (formatversion 2): a video file with its copies and license.
function commonsPage(pageid, { license = "CC BY-SA 4.0", licenseUrl = "https://creativecommons.org/licenses/by-sa/4.0", width = 3840, height = 2160 } = {}) {
  const base = `https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Clip${pageid}.webm/Clip${pageid}.webm`;
  return {
    pageid, index: pageid, title: `File:Clip${pageid}.webm`,
    videoinfo: [{
      mediatype: "VIDEO", width, height, duration: 42.5, url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/Clip${pageid}.webm`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:Clip${pageid}.webm`,
      extmetadata: { LicenseShortName: { value: license }, LicenseUrl: { value: licenseUrl }, Artist: { value: "<a href=\"//commons.wikimedia.org/wiki/User:Ann\">Ann</a>" } },
      derivatives: [
        { src: `https://upload.wikimedia.org/wikipedia/commons/a/ab/Clip${pageid}.webm`, type: "video/webm; codecs=\"vp9\"", width, height },
        { src: `${base}.2160p.vp9.webm`, type: "video/webm; codecs=\"vp9\"", width: 3840, height: 2160 },
        { src: `${base}.1080p.vp9.webm`, type: "video/webm; codecs=\"vp9\"", width: 1920, height: 1080 },
        { src: `${base}.720p.vp9.webm`, type: "video/webm; codecs=\"vp9\"", width: 1280, height: 720 },
        { src: `${base}.360p.vp9.webm`, type: "video/webm; codecs=\"vp9\"", width: 640, height: 360 },
        { src: `${base}.360p.webm`, type: "video/webm; codecs=\"vp8\"", width: 640, height: 360 },
        { src: `${base}.ogg`, type: "audio/ogg", width: 0, height: 0 },
      ],
    }],
  };
}
import { downloadScanCopy, parseProbe, pickWindows, probeFootage } from "./footage-finder/scan.mjs";
import { matchBar, numberShots, pruneScans, rankShots, readScan, SCAN_VERSION, scanFootage, scanMarks, scansFolder, shotFacts, stillPicks, stillsAt } from "./footage-finder/score.mjs";
import { encodeVector, normalize } from "./music-embed.mjs";
import { findShots } from "./shot-detection.mjs";
import { botCheckError, createYouTubeGate } from "./process-slots.mjs";
import { removeTempFolder } from "./temp-folders.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createLook } from "./agent/look.mjs";
import { foundClipTag, groupClips, groupLine } from "./footage-finder/sheet.mjs";
import { shotsNeeded, wantBySection } from "./footage-finder/needs.mjs";
import { joinStretches, planTake, takeCredit, takeFootage, takeText } from "./footage-finder/take.mjs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const FOOTAGE_STUB = fileURLToPath(new URL("../tests/fixtures/footage/stub-yt-dlp.mjs", import.meta.url));

test("library and project pass the fields their listed schemas leave out (scan, want, note, measure; import from/to) on to kino", async () => {
  const calls = [];
  const imports = [];
  const client = { async call(name, input) { calls.push({ name, input }); return { text: "ok" }; },
    async importFile(file, { input }) { imports.push(input); return { reply: { text: "ok" } }; } };
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
    const imported = await agent.callTool({ name: "project", arguments: { action: "import", file: "F1", from: "3:00", to: "3:40" } });
    assert.equal(imported.isError, undefined, imported.content?.[0]?.text);
    assert.deepEqual([imports[0].from, imports[0].to], ["3:00", "3:40"]);
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

test("a footage search puts the pasted link and then verified channels first, drops edits, reactions and live, and runs plain ytsearch20", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  const calls = [];
  const ytDlp = async (args) => {
    calls.push(args);
    if (args.includes("--skip-download") && args.at(-1).endsWith("blocked1xxx")) {
      throw Object.assign(new Error("yt-dlp cannot play this video from here (region)."), { code: "UNPLAYABLE", reason: "region" });
    }
    if (args.includes("--skip-download")) return ytLine("given1", "My own pick", { channel: "Me" });
    return [
      ytLine("fan1", "Gojo vs Sukuna 4K scenepack clips for edits"),
      ytLine("amv1", "Gojo AMV - Hype"),
      ytLine("react1", "Reacting to Gojo vs Sukuna"),
      ytLine("live1", "24/7 stream", { live_status: "is_live", duration: null }),
      ytLine("long1", "Every episode marathon", { duration: 4 * 3600 }),
      ytLine("official1", "Episode 1", { channel: "Big Studio", channel_is_verified: true }),
    ].join("\n");
  };
  try {
    const finder = createFootageFinder({ directory, ytDlp });
    const answer = await finder.search("gojo fight https://youtu.be/given1xxxxx https://youtu.be/blocked1xxx");
    assert.deepEqual(answer.candidates.map((candidate) => candidate.id), ["clip:yt-given1xxxxx", "clip:yt-official1xx", "clip:yt-fan1xxxxxxx"]);
    assert.equal(answer.candidates[0].given, true);
    assert.equal(answer.candidates[2].doubt, "upscaled?");
    assert.deepEqual(answer.dropped, { "yours: region": 1, edits: 1, reactions: 1, live: 1, "over 3 h": 1 });
    const search = calls.find((args) => args.includes("--flat-playlist"));
    assert.ok(search.includes("ytsearch20:gojo fight"), search.join(" "));
    assert.equal(candidateLine(answer.candidates[1], "F2"), 'F2 Big Studio (verified) · 10:00 · "Episode 1"', "no license column for YouTube");
    assert.equal(droppedLine(answer.dropped), "Dropped 5: 1 yours: region, 1 edits, 1 reactions, 1 live, 1 over 3 h.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an edit upload with the origin word and an about word is kept and labeled; without the origin, or without both words, it is dropped", () => {
  const lines = [
    ytLine("keep1", "Keeper climbs the tower edit"),
    ytLine("noword", "Keeper rests edit"),
    ytLine("noabout", "Tower at night edit"),
    ytLine("raw1", "Keeper tower scene"),
    ytLine("react1", "Keeper tower reaction edit"),
  ].join("\n");
  const origin = { word: "tower", about: "the keeper" };
  const kept = parseFootageLines(lines, origin);
  assert.deepEqual(kept.candidates.map((candidate) => [candidate.id, candidate.doubt ?? ""]), [["clip:yt-keep1xxxxxx", "edit upload"], ["clip:yt-raw1xxxxxxx", ""]]);
  assert.deepEqual(kept.dropped, { edits: 2, reactions: 1 });
  assert.equal(candidateLine(kept.candidates[0], "F1"), 'F1 Some Fan · 10:00 · "Keeper climbs the tower edit" · doubt: edit upload');
  assert.deepEqual(parseFootageLines(lines).dropped, { edits: 4 }, "no origin: every edit upload stays dropped");
});

test("the real finder passes the origin to the search and keeps its answer apart from one made without it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  const ytDlp = async () => [ytLine("keep1", "Keeper climbs the tower edit"), ytLine("raw1", "Keeper tower scene")].join("\n");
  try {
    const finder = createFootageFinder({ directory, ytDlp });
    const plain = await finder.search("keeper tower");
    assert.deepEqual(plain.candidates.map((candidate) => candidate.id), ["clip:yt-raw1xxxxxxx"]);
    assert.deepEqual(plain.dropped, { edits: 1 });
    // Same words, now with the origin: not the cached answer above.
    const withOrigin = await finder.search("keeper tower", { origin: { word: "tower", about: "the keeper" } });
    assert.deepEqual(withOrigin.candidates.map((candidate) => [candidate.id, candidate.doubt ?? ""]), [["clip:yt-keep1xxxxxx", "edit upload"], ["clip:yt-raw1xxxxxxx", ""]]);
    assert.equal(withOrigin.dropped.edits, undefined);
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

test("two identical searches at once share one yt-dlp call, and one caller cancelling leaves the other its answer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  let calls = 0;
  let answer;
  const ytDlp = (args, { signal }) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      answer = () => resolve(ytLine("hit1", "Gojo fight scene"));
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("Cancelled."), { name: "AbortError" })), { once: true });
    });
  };
  try {
    const finder = createFootageFinder({ directory, ytDlp });
    const cancel = new AbortController();
    const first = finder.search("gojo fight", { signal: cancel.signal });
    const second = finder.search("gojo fight");
    while (!answer) await new Promise((resolve) => setImmediate(resolve));
    cancel.abort();
    await assert.rejects(first, { name: "AbortError" });
    answer();
    assert.equal((await second).candidates.length, 1);
    assert.equal(calls, 1);
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
    // The words look like the title card (E) only.
    text: async () => [Float32Array.from([0, 0, 0, 1])],
  };
  try {
    const copy = { folder: copyFolder, files: [{ start: 60, end: 70, file: path.join(copyFolder, "scan.60.webm") }] };
    const scan = await scanFootage("yt-abcdefghijk", copy, { dataRoot: directory, want: "white hair", embed, tools });
    await assert.rejects(stat(copyFolder), { code: "ENOENT" });
    assert.deepEqual(scan.skipped, { dark: 1, text: 1, subtitles: 0, short: 0, repeats: 1 });
    // Numbers follow time (A 1, B+C 2, D 3, E 4); the clean shots rank first, the dark and title shots last.
    assert.deepEqual(scan.shots.map((shot) => shot.n), [1, 2, 3, 4]);
    assert.deepEqual(scan.shots.map((shot) => [shot.start, shot.end]), [[60, 62], [62, 66], [66, 68], [68, 70]]);
    assert.deepEqual(scan.shots.slice(2).map((shot) => shot.flags), [["dark"], ["text"]]);
    assert.equal(scan.shots[0].face, 100);
    // Closeness 0, 0, 0, 1 as z-scores; only the title card matches, and a flagged shot never shows a match.
    assert.deepEqual(scan.shots.map((shot) => shot.match), [-0.6, -0.6, -0.6, 1.7]);
    assert.equal(scan.matchShown, false);
    assert.deepEqual(sheetStills, ["still-A", "still-B", "still-D", "still-E"]);
    assert.deepEqual((await readScan(directory, "yt-abcdefghijk")).shots.length, 4);
    // Ten even shots, one of them close to the words: a z-score of 3 counts, and that shot leads.
    const ten = Array.from({ length: 10 }, (_, index) => ({ start: index, end: index + 1, motion: index === 7 ? 10 : 60, face: 0, luma: 0.5, text: 0, logo: 0,
      vector: normalize(index === 7 ? [1, 0, 0, 0] : [0, 1, 0, 0]) }));
    const ranked = rankShots(ten, { wantVector: Float32Array.from([1, 0, 0, 0]) });
    assert.equal(ranked.matchShown, true);
    assert.deepEqual([ranked.shots[0].start, ranked.shots[0].match], [7, 3]);
    // 150 shots of noise: the best z-score tops 2 by chance, but not the bar for 150 shots.
    let seed = 12345;
    const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const gauss = () => Math.sqrt(-2 * Math.log(noise())) * Math.cos(2 * Math.PI * noise());
    const many = Array.from({ length: 150 }, (_, index) => ({ ...ten[0], start: index, end: index + 1, vector: normalize([0.2 * gauss(), 1, 0, 0]) }));
    const noisy = rankShots(many, { wantVector: Float32Array.from([1, 0, 0, 0]) });
    const best = Math.max(...noisy.shots.map((shot) => shot.match));
    assert.ok(best >= 2 && best < matchBar(150), `best ${best}`);
    assert.equal(noisy.matchShown, false);
    // Four shots can reach a z-score of 1.73 at most, so one clear match still shows.
    assert.equal(rankShots(ten.slice(4, 8), { wantVector: Float32Array.from([1, 0, 0, 0]) }).matchShown, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // Without the footage finder's allowance, a 25 min file is still too long to look in.
  await assert.rejects(findShots("none.webm", { duration: 1500 }), { code: "TOO_LONG" });
  await assert.rejects(findShots("none.webm", { duration: 2000, maxSeconds: 1800 }), /up to 30 min/);
});

test("drawn footage: a logo on every shot is said once and is no text, subtitles go last, faces are not read, and a 2.4 match shows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-drawn-"));
  const copyFolder = path.join(directory, "copy");
  await mkdir(copyFolder);
  // Twelve 1 s shots. A corner logo the OCR reads as two lines or one, in four spellings and sizes, on all
  // but shots 4 and 9 (0-based); a copyright line bottom-right on all; subtitles on shots 3 and 7;
  // a title card on shot 11; the face detector fires on shot 5 (noise on a drawing).
  const logo = (k) => (k % 2 ? [k === 3 ? { box: [0.02, 0.02, 0.03, 0.04], s: "LO" } : { box: [0.021, 0.021, 0.081, 0.04], s: "L0G0" }]
    : [{ box: [0.02, 0.02, 0.08, 0.04], s: k ? "LOG0" : "LOGO" }, { box: [0.02, 0.065, 0.1, 0.03], s: "studio" }]);
  const samples = Array.from({ length: 48 }, (_, index) => {
    const [shot, k] = [Math.floor(index / 4), index % 4];
    const text = [...(shot === 4 || shot === 9 ? [] : logo(k)), { box: [0.8, 0.95, 0.18, 0.02], s: `(c) studio ${k}` }];
    if ((shot === 3 || shot === 7) && k === 0) text.push({ box: [0.4, 0.88, 0.2, 0.05], s: "Behind you!" });
    if (shot === 11) text.push({ box: [0.2, 0.4, 0.6, 0.2], s: "EPISODE 5" });
    return { t: index / 4, luma: 0.5, change: 0.1, motion: null, faces: shot === 5 ? [[0.4, 0.3, 0.2, 0.3]] : [], text };
  });
  const tools = {
    probe: async () => ({ duration: 12, width: 640, height: 360 }),
    findShots: async () => ({ shots: Array.from({ length: 12 }, (_, index) => ({ start: index, end: index + 1 })) }),
    measure: async () => ({ samples, vision: { faces: true, text: true, flow: false } }),
    stills: async (file, times) => times.map((time) => `still-${Math.floor(time)}`),
    sheet: async (stills, out) => { await writeFile(out, "jpg"); },
  };
  // Dimensions: the wanted look, two kinds of other content, drawn, photo. Every still is drawn; shot 6 is the wanted one.
  const stillVector = (index) => normalize([index === 6 ? 0.9 : 0, index % 2 ? 0.6 : 0, index % 2 ? 0 : 0.6, 0.6, 0.1]);
  const words = { "white hair": [1, 0, 0, 0, 0], "an anime screenshot or a cartoon": [0, 0, 0, 1, 0], "a photo": [0, 0, 0, 0, 1] };
  const embed = {
    images: async (files) => ({ model: "test", vectors: files.map((file) => encodeVector(stillVector(Number(file.split("-")[1])))) }),
    text: async (prompts) => prompts.map((prompt) => Float32Array.from(words[prompt])),
  };
  try {
    const copy = { folder: copyFolder, files: [{ start: 0, end: 12, file: path.join(copyFolder, "scan.0.webm") }] };
    const scan = await scanFootage("yt-abcdefghijk", copy, { dataRoot: directory, want: "white hair", embed, tools });
    assert.equal(scan.drawn, true);
    assert.deepEqual(scan.marks.map((mark) => [mark.where, mark.share]), [["bottom-right", 1], ["top-left", 0.833]]);
    assert.deepEqual(scan.skipped, { dark: 0, text: 1, subtitles: 2, short: 0, repeats: 0 });
    const flagsOf = Object.fromEntries(scan.shots.map((shot) => [shot.n, shot.flags.join(" ")]));
    assert.deepEqual([flagsOf[4], flagsOf[8], flagsOf[12], flagsOf[1], flagsOf[6]], ["subtitles", "subtitles", "text", "", ""]);
    assert.ok(scan.shots.every((shot) => shot.face === null));
    assert.deepEqual([scan.matchShown, scan.shots[0].n], [true, 7]);
    const text = scanText({ code: "F1", title: "Fight", license: "unknown" }, scan);
    assert.match(text, /\nLogo bottom-right and top-left on every shot: crop or cover it\.\nFaces: not read on drawn footage\./);
    assert.match(text, /\nF1\.7 0:06\.0-0:07\.0 1\.0s motion \d+ match \+3\.3\n/);
    assert.equal(text.match(/Logo/g).length, 1);
    // The video with a logo lists after one without; a scan without the model says so; a miss says how close it came.
    assert.deepEqual(logoLast([{ code: "F1", scan: { logo: "top-left" } }, { code: "F2" }]).map((entry) => entry.code), ["F2", "F1"]);
    assert.match(scanText({ code: "F2", title: "x", license: "unknown" }, { want: "white hair", model: null, shots: [] }), /The image model did not run, so "white hair" was not looked for/);
    assert.match(scanText({ code: "F2", title: "x", license: "unknown" }, { want: "white hair", model: "m", matchBest: 1.4, matchBar: 2, shots: [] }), /No visual match for "white hair" \(closest \+1\.4, a match needs \+2\.0\): shots rank on motion, faces/);
    // Drawn footage keeps the bar at 2, so a recurring character's best shot (z 2.4) shows; on photos 20 shots need 2.45.
    // The same shot as a 0.3 s flash is too short to import, so it decides nothing.
    const twenty = (flash) => Array.from({ length: 20 }, (_, index) => {
      const c = index === 19 ? 0.22 : 0.1 + 0.02 * ((index * 7) % 5);
      return { start: index, end: index + (index === 19 && flash ? 0.3 : 1), motion: 50, face: null, luma: 0.5, text: 0, subs: 0, logo: 0, vector: Float32Array.from([c, Math.sqrt(1 - c * c)]) };
    });
    const want = Float32Array.from([1, 0]);
    assert.deepEqual([rankShots(twenty(false), { wantVector: want, drawn: true }).matchShown, rankShots(twenty(false), { wantVector: want }).matchShown,
      rankShots(twenty(true), { wantVector: want, drawn: true }).matchShown], [true, false, false]);
    assert.equal(matchBar(77, { drawn: true }), 2);
    // Two-line subtitles, mid-frame captions and fansubs of varying width on 12 of 20 shots are no mark: they stay text.
    const corner = [0.02, 0.02, 0.08, 0.04];
    const kinds = {
      subtitles: () => [[0.3, 0.7, 0.4, 0.05], [0.3, 0.8, 0.4, 0.05]],
      captions: (index) => [[0.5 - (0.15 + 0.02 * (index % 6)) / 2, 0.5, 0.15 + 0.02 * (index % 6), 0.08]],
      fansubs: (index) => [[0.5 - (0.15 + 0.02 * (index % 6)) / 2, 0.85, 0.15 + 0.02 * (index % 6), 0.05]],
    };
    for (const [kind, lines] of Object.entries(kinds)) {
      const shotLines = Array.from({ length: 20 }, (_, index) => [corner, ...(index % 5 < 3 ? lines(index) : [])]);
      const marks = scanMarks(shotLines);
      assert.deepEqual(marks.map((mark) => mark.where), ["top-left"], kind);
      const facts = shotFacts(0, 1, [{ t: 0, luma: 0.5, change: 0.1, text: shotLines[0].map((box) => ({ box })) }], [], marks);
      assert.deepEqual([facts.text, facts.subs], [1, kind === "captions" ? 0 : 1], kind);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scan copy that starts at the keyframe before its stretch saves shot times in the video's seconds", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-times-"));
  const copyFolder = path.join(directory, "copy");
  await mkdir(copyFolder);
  // The stretch 60 to 70 s comes as a 12 s file: its first 2 s are 58 to 60.
  const tools = {
    probe: async () => ({ duration: 12, width: 640, height: 360 }),
    findShots: async () => ({ shots: [{ start: 0, end: 5 }, { start: 5, end: 12 }] }),
    measure: async () => ({ samples: [] }),
    stills: async (file, times) => times.map(() => null),
    sheet: async () => {},
  };
  try {
    const copy = { folder: copyFolder, files: [{ start: 60, end: 70, file: path.join(copyFolder, "scan.60.webm") }] };
    const scan = await scanFootage("yt-abcdefghijk", copy, { dataRoot: directory, tools });
    assert.deepEqual(scan.shots.map((shot) => [shot.start, shot.end]).sort((a, b) => a[0] - b[0]), [[58, 63], [63, 70]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scan again keeps the numbers shown before: the same range keeps its code, new shots count on, and earlier shots stay", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-numbers-"));
  const copyFolder = path.join(directory, "copy");
  await mkdir(copyFolder);
  const scanOf = async (start, end, shots) => {
    const tools = {
      probe: async () => ({ duration: end - start, width: 640, height: 360 }),
      findShots: async () => ({ shots: shots.map(([from, to]) => ({ start: from - start, end: to - start })) }),
      measure: async () => ({ samples: [] }),
      stills: async (file, times) => times.map(() => null),
      sheet: async () => {},
    };
    const copy = { folder: copyFolder, files: [{ start, end, file: path.join(copyFolder, "scan.webm") }] };
    return scanFootage("yt-abcdefghijk", copy, { dataRoot: directory, tools });
  };
  const ranges = (scan) => Object.fromEntries(scan.shots.map((shot) => [shot.n, [shot.start, shot.end]]));
  try {
    const first = await scanOf(0, 30, [[0, 10], [10, 20], [20, 30]]);
    assert.deepEqual(ranges(first), { 1: [0, 10], 2: [10, 20], 3: [20, 30] });
    // 15 to 45 cuts shot 2 at its window (15 to 20): still shot 2, with its range of 10 to 20.
    const second = await scanOf(15, 45, [[15, 20], [20, 30], [30, 45]]);
    assert.deepEqual(ranges(second), { 1: [0, 10], 2: [10, 20], 3: [20, 30], 4: [30, 45] });
    // Shots that match nothing known are new numbers, in time order, never 1 or 2 again.
    const third = await scanOf(50, 60, [[50, 54], [54, 60]]);
    assert.deepEqual(ranges(third), { 1: [0, 10], 2: [10, 20], 3: [20, 30], 4: [30, 45], 5: [50, 54], 6: [54, 60] });
    assert.deepEqual(ranges(await readScan(directory, "yt-abcdefghijk")), ranges(third));
    assert.equal(third.windows.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("numbering: a shot a window edge cut keeps its code and grows to the whole shot, a shot split keeps its code on its larger part, and no two codes list the same footage", () => {
  // Old 20 to 30 was cut at its window's end; the next window finds the whole shot (25 to 40 after its own cut).
  assert.deepEqual(numberShots([{ n: 1, start: 20, end: 30 }], [{ start: 25, end: 40 }]), [{ n: 1, start: 20, end: 40 }]);
  // Old 0 to 20 is now two shots: the first keeps code 1 with its own range, the second is new.
  assert.deepEqual(numberShots([{ n: 1, start: 0, end: 20 }], [{ start: 0, end: 10 }, { start: 10, end: 20 }]), [{ n: 1, start: 0, end: 10 }, { n: 2, start: 10, end: 20 }]);
  // Old 10 to 20 split into 10 to 14 and 14 to 30: the larger part keeps code 2 on its own range, the others are new.
  // Every saved range holds its shot's own range, so a sheet still from the shot's middle lies inside it.
  const known = [{ n: 1, start: 0, end: 10 }, { n: 2, start: 10, end: 20 }];
  const shots = [{ start: 10, end: 14 }, { start: 14, end: 30 }, { start: 40, end: 41 }];
  const numbered = numberShots(known, shots);
  assert.deepEqual(numbered, [{ n: 3, start: 10, end: 14 }, { n: 2, start: 14, end: 30 }, { n: 4, start: 40, end: 41 }]);
  numbered.forEach((shot, index) => assert.ok(shot.start <= shots[index].start && shot.end >= shots[index].end));
});

test("a scan again with other words matches every saved shot to the newest words: no old z-score or boost stays", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-rematch-"));
  const copyFolder = path.join(directory, "copy");
  const looks = { A: [1, 0, 0, 0], B: [0, 1, 0, 0], C: [0, 0, 1, 0], D: [0, 0, 0, 1], E: [0, 1, 0, 0], F: [0, 0, 1, 0] };
  const embed = {
    images: async (files) => ({ model: "test", vectors: files.map((file) => encodeVector(normalize(looks[file.slice(-1)]))) }),
    text: async (prompts) => prompts.map((prompt) => Float32Array.from(prompt === "dog" ? [1, 0, 0, 0] : prompt === "cat" ? [0, 0, 0, 1] : [0, 0, 0, 0])),
  };
  const scanOf = async (start, letters, want) => {
    await mkdir(copyFolder, { recursive: true });
    const tools = {
      probe: async () => ({ duration: 60, width: 640, height: 360 }),
      findShots: async () => ({ shots: [...letters].map((_, index) => ({ start: index * 20, end: index * 20 + 20 })) }),
      measure: async () => ({ samples: Array.from({ length: 12 }, (_, index) => ({ t: index * 5, luma: 0.5, change: 0.1, motion: null, faces: [], text: [] })) }),
      stills: async () => [...letters].map((letter) => `still-${letter}`),
      sheet: async () => {},
    };
    const copy = { folder: copyFolder, files: [{ start, end: start + 60, file: path.join(copyFolder, "scan.webm") }] };
    return scanFootage("yt-abcdefghijk", copy, { dataRoot: directory, want, embed, tools });
  };
  try {
    const dog = await scanOf(0, "ABC", "dog");
    assert.deepEqual([dog.matchShown, dog.shots.find((shot) => shot.n === 1).match], [true, 1.4]);
    const cat = await scanOf(100, "DEF", "cat");
    assert.equal(cat.want, "cat");
    assert.equal(cat.shots.length, 6);
    // Shot 1 was the dog shot: now it is one of five shots that look nothing like a cat.
    const byNumber = Object.fromEntries(cat.shots.map((shot) => [shot.n, shot]));
    assert.deepEqual([byNumber[4].match, byNumber[1].match, byNumber[2].match], [2.2, -0.4, -0.4]);
    assert.equal(cat.matchShown, true);
    assert.equal(cat.shots[0].n, 4);
    // Same base for both, so the old dog shot scores by the cat words like every other non-match.
    assert.equal(byNumber[1].score, byNumber[2].score);
    assert.ok(cat.shots.every((shot) => shot.match !== 1.4));
    // Cat words only on the saved vectors: a rescan with no words clears every match.
    const none = await scanOf(200, "ABC", "");
    assert.ok(none.shots.every((shot) => shot.match === null));
    assert.equal(none.matchShown, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stills of a 250-time scan come from two ffmpeg passes and land as files 000 to 249 under their times' places", { skip: skipWithoutMediaTools, timeout: 30_000 }, async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-test-stills-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const video = path.join(folder, "clip.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=4:d=65", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", video]);
  // One time a frame (a quarter second), a hair after each frame: 250 times, so 200 and then 50.
  const times = Array.from({ length: 250 }, (_, index) => index * 0.25 + 0.01);
  const stills = await stillsAt(video, times, path.join(folder, "stills"));
  assert.equal(stills.length, 250);
  assert.deepEqual(stills.map((file, index) => (file === null ? index : null)).filter((index) => index !== null), []);
  assert.equal(path.basename(stills[0]), "000.jpg");
  assert.equal(path.basename(stills[249]), "249.jpg");
  // The second pass starts at 200 and does not write over the first: still 200 shows another frame than 199 and 0.
  const bytes = async (index) => (await readFile(stills[index])).toString("base64");
  assert.notEqual(await bytes(200), await bytes(199));
  assert.notEqual(await bytes(200), await bytes(0));
});

test("the stills of a video with 300 shots are picked in passes of at most 200 times, each a shallow expression", () => {
  const times = Array.from({ length: 300 }, (_, index) => index * 0.5 + 0.1);
  const passes = stillPicks(times);
  assert.deepEqual(passes.map((pass) => pass.from), [0, 200]);
  assert.deepEqual(passes.map((pass) => pass.pick.match(/gte\(/g).length), [200, 100]);
  for (const { pick } of passes) {
    // ffmpeg stops parsing a sum nested about 99 deep (measured); a balanced tree nests about log2(200).
    let depth = 0;
    let deepest = 0;
    for (const character of pick) {
      if (character === "(") deepest = Math.max(deepest, ++depth);
      else if (character === ")") depth--;
    }
    assert.ok(deepest <= 20, `nested ${deepest} deep`);
  }
  assert.match(passes[0].pick, /gte\(t\\,0\.1\)/);
  assert.match(passes[1].pick, /gte\(t\\,100\.1\)/);
  assert.deepEqual(stillPicks([]), []);
});

test("an empty footage search is tried once without 4k, and the same search again asks yt-dlp nothing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  const searched = [];
  const ytDlp = async (args) => {
    const words = args.at(-1);
    searched.push(words);
    return words === "ytsearch20:gojo fight 4k" ? "" : ytLine("hit1", "Gojo fight scene");
  };
  try {
    const finder = createFootageFinder({ directory, ytDlp });
    const first = await finder.search("gojo fight 4k");
    assert.deepEqual(searched, ["ytsearch20:gojo fight 4k", "ytsearch20:gojo fight"]);
    assert.equal(first.tried, "gojo fight");
    assert.equal(first.candidates.length, 1);
    assert.equal(first.cached, false);
    const again = await finder.search("gojo fight 4k");
    assert.equal(searched.length, 2);
    assert.equal(again.cached, true);
    assert.equal(nothingFoundText("x 4k", "x"), 'Nothing for "x 4k" (also tried "x"). Try the English title, a character name, or source:"commons".');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("Commons: a 3840x2160 original yields its 1080p copy (360p to scan), credited; a CC BY-NC file is kept with its license as metadata", () => {
  const found = parseCommonsSearch({ query: { pages: [commonsPage(7, { license: "CC BY-NC-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0" }), commonsPage(5)] } });
  assert.deepEqual(found.map((clip) => [clip.id, clip.license]), [["clip:commons-5", "CC BY-SA 4.0"], ["clip:commons-7", "CC BY-NC-SA 4.0"]]);
  const clip = found[0];
  assert.match(clip.files.import.url, /\.1080p\.vp9\.webm$/);
  assert.equal(clip.files.import.height, 1080);
  assert.match(clip.files.scan.url, /\.360p\.vp9\.webm$/);
  assert.equal(clip.license, "CC BY-SA 4.0");
  assert.equal(clip.credit, "\"Clip5\" by Ann (https://commons.wikimedia.org/wiki/File:Clip5.webm), CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)");
});

test("Commons asks only with the web search switch on, and a file redirected off wikimedia.org is refused", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-test-commons-"));
  try {
    let on = false;
    const asked = [];
    const fetch = async (url, options) => {
      asked.push({ url, agent: options.headers["user-agent"] });
      if (url.startsWith("https://commons.wikimedia.org/")) return Response.json({ query: { pages: [commonsPage(5)] } });
      if (url.endsWith(".360p.vp9.webm")) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/clip.webm" } });
      return new Response(new Uint8Array(4096));
    };
    const commons = createCommonsSource({ enabled: () => on, fetch });
    await assert.rejects(commons.search("ocean waves"), { code: "web_search_off" });
    assert.equal(asked.length, 0);
    on = true;
    const [clip] = await commons.search("ocean waves");
    assert.match(asked[0].url, /gsrsearch=ocean\+waves\+filetype%3Avideo/);
    assert.match(asked[0].agent, /^kino /);
    await assert.rejects(commons.download(clip, folder), /elsewhere\.example, which kino does not download from/);
    assert.equal(asked.length, 2, "the redirect target is never asked");
    const file = await commons.download(clip, folder, { use: "import" });
    assert.equal(path.basename(file), "import.webm");
    await assert.rejects(commons.download(clip, folder, { use: "../escaped" }), { code: "bad_input" });
    assert.equal(asked.length, 3, "an unknown use asks nothing and names no file outside the folder");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// A found candidate as search.mjs makes it.
const found = (n, extra = {}) => ({ id: `clip:yt-${String(n).padStart(11, "v")}`, source: "youtube", videoId: String(n).padStart(11, "v"), title: `Episode ${n}`, creator: "Big Studio", seconds: 1420, license: "unknown", ...extra });

test("library footage: the person's clips lead every answer, search's next is scan top, scan's next is the full import call, all under 1.5k tokens", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  const layers = [createLayer("video", { id: "own", src: "/api/media/own1" }), createLayer("video", { id: "own2", src: "/api/media/own1" })];
  await store.createProject(createDocument({ id: "anime-edit", name: "Anime edit", scenes: [createScene({ id: "s1", layers })] }));
  const scanned = [];
  const finder = {
    search: async () => ({ words: "show fight", candidates: Array.from({ length: 10 }, (_, index) => found(index + 1, { title: `Episode ${index + 1} ${"long title words ".repeat(8)}` })), dropped: { edits: 3, reactions: 2 }, cached: false }),
    readScan: async () => null,
    scan: async (candidate, options) => {
      scanned.push([candidate.code, options.want]);
      return { want: options.want, windows: [{ start: 0, end: 480 }], matchShown: true, skipped: { dark: 1, text: 2, short: 0, repeats: 4 },
        shots: [
          ...Array.from({ length: 14 }, (_, index) => ({ n: 37 - index, start: 197.2 + index, end: 199 + index, motion: 82, face: 40, match: 3.1, flags: [] })),
          { n: 2, start: 5, end: 7, motion: 10, face: 0, match: 0, flags: ["text"] },
        ] };
    },
  };
  const service = createAgentService({ store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], footage: finder });
  const searched = await service.call("library", { project: "anime-edit", topic: "footage", search: "show fight", want: "white hair, blindfold" });
  assert.equal(searched.isError, undefined, searched.text);
  const lines = searched.text.split("\n");
  assert.equal(lines[0], "This video has 1 clip of the person's: they lead; found clips fill the gaps.");
  assert.match(lines[2], /^F1 Big Studio · 23:40 · "Episode 1 long title/);
  assert.match(searched.text, /Dropped 5: 3 edits, 2 reactions\./);
  assert.equal(lines.at(-1), 'next: library {"topic":"footage","scan":"top"}');
  assert.ok(searched.text.length / 4 < 1500, `${searched.text.length} characters`);
  const scan = await service.call("library", { project: "anime-edit", topic: "footage", scan: "top" });
  assert.equal(scan.isError, undefined, scan.text);
  assert.deepEqual(scanned, [["F1", "white hair, blindfold"]]);
  const shown = scan.text.split("\n");
  assert.equal(shown[0], "This video has 1 clip of the person's: they lead; found clips fill the gaps.");
  assert.equal(shown[2], "F1.37 3:17.2-3:19.0 1.8s motion 82 face 40 match +3.1");
  assert.equal(shown.filter((line) => /^F1\.\d+ /.test(line)).length, 12);
  assert.match(scan.text, /Skipped: 2 text, 1 dark, 4 repeats\./);
  assert.ok(shown.includes('Stills: look {mode:"source", ref:"F1"}'), scan.text);
  assert.equal(shown.at(-1), 'next: project {"action":"import","file":"F1","options":{"shots":[37,36,35,34,33,32]}}');
  assert.ok(scan.text.length / 4 < 1500, `${scan.text.length} characters`);
  // The list remembers F1 as scanned, and the next "top" is F2.
  const list = await service.call("library", { project: "anime-edit", topic: "footage" });
  assert.match(list.text, /F1 Big Studio .* · scanned, 15 shots/);
  assert.equal(list.text.split("\n").at(-1), 'next: library {"topic":"footage","scan":"F2"}');
});

test("library footage with an origin word and no clips of theirs: next is the footage search for the quote and the word, the finder is told the word; with their own clip: unchanged", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id: "bare", name: "Bare", scenes: [createScene({ id: "s1", layers: [] })] }));
  await store.createProject(createDocument({ id: "own", name: "Own", scenes: [createScene({ id: "s1", layers: [createLayer("video", { id: "v", src: "/api/media/own1" })] })] }));
  const agentState = createAgentStateStore(dataRoot);
  for (const id of ["bare", "own"]) {
    await agentState.update(id, (draft) => {
      draft.origin = { query: "the keeper", words: [{ word: "tower", count: 11, of: 15 }], top: [] };
      draft.brief = { rev: 1, fields: { about: { text: "the keeper", by: "you", quote: "the keeper" } }, log: [] };
    });
  }
  const asked = [];
  const finder = { search: async (words, options) => { asked.push([words, options.origin ?? null]); return { words, candidates: [found(1, { title: "Keeper at rest" })], dropped: {}, cached: false }; }, readScan: async () => null };
  const service = createAgentService({ store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], footage: finder });
  const bare = await service.call("library", { project: "bare", topic: "footage", search: "keeper fight" });
  assert.equal(bare.text.split("\n").at(-1), 'next: library {"topic":"footage","search":"the keeper tower"}');
  assert.deepEqual(asked.at(-1), ["keeper fight", { word: "tower", about: "the keeper" }]);
  const origin = await service.call("library", { project: "bare", topic: "footage", search: "the keeper tower" });
  assert.equal(origin.text.split("\n").at(-1), 'next: library {"topic":"footage","scan":"top","want":"tower"}');
  const own = await service.call("library", { project: "own", topic: "footage", search: "keeper fight" });
  assert.equal(own.text.split("\n").at(-1), 'next: library {"topic":"footage","scan":"top"}');
  assert.equal(asked.at(-1)[1], null, "their own footage: the finder gets no origin");
});

test("look reference: a studied edit whose title has the origin word ends with the footage search line; one without the word, or a project without an origin, does not", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const stripsFolder = path.join(dataRoot, "strips");
  await mkdir(stripsFolder, { recursive: true });
  await writeFile(path.join(stripsFolder, "s1.png"), createCanvas(24, 16).toBuffer("image/png"));
  const titles = { "yt:aaaaaaaaaaa": "Keeper tower edit", "yt:bbbbbbbbbbb": "Keeper at rest" };
  let lookups = 0;
  const inspire = { stripsFor: async () => ({ folder: stripsFolder, strips: [{ at: 1, kinds: ["cut"], file: "s1.png" }] }), reference: async (id) => { lookups += 1; return { id, title: titles[id] }; } };
  const store = await openStore(dataRoot);
  const agentState = createAgentStateStore(dataRoot);
  for (const id of ["with", "without"]) {
    await store.createProject(createDocument({ id, name: id, scenes: [createScene({ id: "s1", layers: [] })] }));
  }
  await agentState.update("with", (draft) => {
    draft.origin = { query: "the keeper", words: [{ word: "tower", count: 11, of: 15 }], top: [] };
    draft.brief = { rev: 1, fields: { about: { text: "the keeper", by: "you", quote: "the keeper" } }, log: [] };
  });
  const service = createAgentService({ store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], inspire,
    look: { save: async () => path.join(dataRoot, "look.png") } });
  const line = 'to find the footage it shows: library {topic:"footage", search:"the keeper tower"}';
  const hit = await service.call("look", { project: "with", mode: "reference", ref: "yt:aaaaaaaaaaa", t: 1 });
  assert.equal(hit.text.split("\n")[2], line, hit.text);
  const rest = await service.call("look", { project: "with", mode: "reference", ref: "yt:bbbbbbbbbbb", t: 1 });
  assert.ok(!rest.text.includes("to find the footage it shows"), "no origin word in its title");
  lookups = 0;
  const none = await service.call("look", { project: "without", mode: "reference", ref: "yt:aaaaaaaaaaa", t: 1 });
  assert.ok(!none.text.includes("to find the footage it shows"), none.text);
  assert.equal(lookups, 0, "no origin: no second reference lookup");
});

test("footage codes: at most 24 kept, the oldest go first but never a scanned, noted or imported one, and a code stays with its video", () => {
  let footage = addCandidates(null, Array.from({ length: 20 }, (_, index) => found(index + 1)));
  footage.candidates[0].scan = { id: "yt-x", shots: 3 };
  footage.candidates[1].note = { verdict: "no", why: "a watermark" };
  footage = addCandidates(footage, [found(3), ...Array.from({ length: 10 }, (_, index) => found(index + 30))]);
  assert.equal(footage.candidates.length, 24);
  assert.deepEqual(footage.candidates.slice(0, 4).map((entry) => entry.code), ["F1", "F2", "F3", "F10"]);
  assert.deepEqual(footage.order.slice(0, 2), ["F3", "F21"]);
});

const line = (text) => ({ text, by: "you", quote: text });
const footageBrief = (message, never = "none said") => ({ rev: 1, confirmedRev: 1, log: [], fields: withAsk({ message: line(message), plays_on: line("phone, vertical"), made_from: line("whatever fits"), look_sound: line("a hype song"), never: line(never) }) });

test("a footage-led brief is an edit of an existing subject; product briefs and the never line do not count", () => {
  for (const message of ["make an anime edit of Frieren to a hype song", "basketball highlights from last season", "an AMV of my favorite show", "a gaming montage of my clutch rounds"])
    assert.equal(footageLed(footageBrief(message)), true, message);
  for (const message of ["product highlights for the holiday season sale", "a recap of our Series A raise", "a recap of this week's podcast episode",
    "an edit showing the user journey in our app", "a launch edit for our game", "a 3 second logo sting for our studio"])
    assert.equal(footageLed(footageBrief(message)), false, message);
  assert.equal(footageLed(footageBrief("a 20 s launch promo for our budgeting app", "no anime montage style, no movie clips")), false);
});

test("status names the footage search for an anime edit with nothing of theirs, until it is built, planned or waived; edit receipts never do", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-step-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  const agentState = createAgentStateStore(dataRoot);
  const anime = "make an anime edit of Frieren to a hype song";
  const projects = {
    anime: [anime, []], sting: ["a 3 second logo sting for our studio", []], photos: [anime, []], planned: [anime, []], waived: [anime, []],
    own: [anime, [createLayer("video", { id: "own", src: "/api/media/own1" })]],
    built: [anime, [createLayer("text", { id: "title", text: "Frieren" })]],
  };
  for (const [id, [message, layers]] of Object.entries(projects)) {
    const document = createDocument({ id, name: id, scenes: [createScene({ id: "s1", duration: 20, layers })] });
    if (id === "waived") document.checkWaivers = [{ code: "footage", target: "*", reason: "the person said no found footage" }];
    await store.createProject(document);
    await agentState.update(id, (draft) => { draft.brief = footageBrief(message); });
  }
  await agentState.update("planned", (draft) => { draft.plan = { steps: [{ text: "Build it" }] }; });
  const deps = { store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"), exportBatches: {}, fontCatalog: { async loadInto() {} },
    loadFonts: async () => [], listMedia: async () => [{ id: "p1", projectId: "photos", mime: "image/jpeg", name: "us.jpg" }], footage: { search: async () => ({ candidates: [] }) } };
  const service = createAgentService({ ...deps, footageStep: true });
  const step = async (id, from = service) => (await from.call("status", { project: id })).text.split("\n").find((each) => each.startsWith("step: "));
  assert.equal(await step("anime"), 'step: no clips of theirs: find footage (library footage), or waive_check {code:"footage"}');
  assert.match((await service.call("status", { project: "anime" })).text, /next: library \{"topic":"footage","search":"<series or subject> <scene words>"/);
  for (const id of ["sting", "own", "photos", "planned", "waived", "built"]) assert.doesNotMatch(String(await step(id)), /footage/, id);
  // A check's receipt names the build, not the search (the step is advice, as references are).
  assert.doesNotMatch((await service.call("check", { project: "anime" })).text, /"topic":"footage"/);
  // Off until the tool schema takes the footage topic.
  if (!LIBRARY_TOPICS.includes("footage")) assert.doesNotMatch(await step("anime", createAgentService(deps)), /footage/);
  // Found, none scanned: scan the first one; scanned: its scan again names the shots; all imported: search again.
  await agentState.update("anime", (draft) => { draft.footage = addCandidates(null, [found(1), found(2)]); });
  assert.match((await service.call("status", { project: "anime" })).text, /step: scan the found footage[^]*next: library \{"topic":"footage","scan":"F1"\}/);
  await agentState.update("anime", (draft) => { draft.footage.candidates[0].scan = { id: "yt-x", shots: 9 }; });
  assert.equal(await step("anime"), "step: import found shots (scan F1 names them)");
  await agentState.update("anime", (draft) => { for (const each of draft.footage.candidates) each.imported = true; });
  assert.match(await step("anime"), /^step: found footage used up: find footage/);
});

test("a scan longer than the wait answers with its progress, and the same call again joins it", async () => {
  let finish;
  let started = 0;
  const finder = {
    readScan: async () => null,
    scan: (candidate, { onProgress }) => { started += 1; onProgress("Downloading 3 stretches at 360p."); return new Promise((resolve) => { finish = resolve; }); },
  };
  const actions = createFootageActions({ finder, waitMs: 5 });
  const footage = addCandidates(null, [found(1), found(2)]);
  const first = await actions.handle({ scan: "F1" }, { footage, personClips: 0 });
  assert.equal(first.text, "F1 is still scanning. Downloading 3 stretches at 360p.\nSend the same call again: it joins this scan and waits for it.");
  assert.deepEqual(first.nextCall, { tool: "library", input: { topic: "footage", scan: "F1" } });
  const again = actions.handle({ scan: "F1" }, { footage, personClips: 0 });
  finish({ want: "", windows: [{ start: 0, end: 60 }], shots: [{ n: 1, start: 1, end: 3, motion: 50, face: 0, flags: [] }], skipped: {} });
  assert.match((await again).text, /^F1 "Episode 1" · scanned 1:00 of 23:40 · 1 shot:\nF1\.1 0:01\.0-0:03\.0 2\.0s motion 50 face 0\n/);
  assert.equal(started, 1);
  // A video that cannot play here is dropped, and the next one is named.
  const blocked = createFootageActions({ finder: { readScan: async () => null, scan: async () => { throw Object.assign(new Error("x"), { code: "UNPLAYABLE", reason: "region" }); } } });
  const answer = await blocked.handle({ scan: "top" }, { footage, personClips: 0 });
  assert.equal(answer.text, "F1 cannot play from here (region). Dropped; F2 is next.");
  assert.deepEqual(answer.update(footage).candidates.map((entry) => entry.code), ["F2"]);
  assert.ok(FOOTAGE_TOPIC_LINE.length <= 150, FOOTAGE_TOPIC_LINE.length);
  // A scan that failed names the next video, never "top" (the one that just failed).
  const broken = createFootageActions({ finder: { readScan: async () => null, scan: async () => { throw new Error("ffmpeg exited 1"); } } });
  await assert.rejects(broken.handle({ scan: "top" }, { footage, personClips: 0 }),
    (error) => error.message === "F1 could not be scanned: ffmpeg exited 1" && error.nextCall.input.scan === "F2");
  // A from/to that is no time is refused before anything downloads.
  await assert.rejects(broken.handle({ scan: "F1", from: "soon" }, { footage, personClips: 0 }), (error) => error.code === "bad_input");
  // A from/to scan that finishes between the progress answer and the repeat is collected, not started again.
  started = 0;
  const stretch = createFootageActions({ finder, waitMs: 5 });
  assert.match((await stretch.handle({ scan: "F1", from: 60, to: 120 }, { footage, personClips: 0 })).text, /still scanning/);
  finish({ want: "", windows: [{ start: 60, end: 120 }], shots: [], skipped: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match((await stretch.handle({ scan: "F1", from: 60, to: 120 }, { footage, personClips: 0 })).text, /scanned 1:00/);
  assert.equal(started, 1);
});

test("song to footage: a 30 s drop at 140 bpm cut every 2 beats needs 35 shots, and the scan answer asks for 1.5x", async () => {
  const need = shotsNeeded({ bpm: 140, sections: [{ at: 0, kind: "build" }, { at: 12, kind: "drop" }], seconds: 60, from: 0, to: 42 });
  assert.deepEqual(need.parts, [{ kind: "build", from: 0, to: 12, beats: 28, every: 4, shots: 7 }, { kind: "drop", from: 12, to: 42, beats: 70, every: 2, shots: 35 }]);
  assert.equal(need.shots, 42);
  assert.equal(need.import, 63);
  assert.deepEqual(wantBySection("white hair", need.parts), { build: "white hair, close-up face, calm, still", drop: "white hair, fast action, motion, impact" });
  const finder = { readScan: async () => null, scan: async () => ({ want: "", windows: [{ start: 0, end: 60 }], skipped: {},
    shots: Array.from({ length: 14 }, (_, index) => ({ n: index + 1, start: index * 2, end: index * 2 + 1.5, motion: 60, face: 10, flags: [] })) }) };
  const answer = await createFootageActions({ finder }).handle({ scan: "F1" }, { footage: addCandidates(null, [found(1)]), personClips: 0, song: async () => need });
  assert.match(answer.text, /\nThe song \(140 bpm\) needs about 42 shots: 35 on the drop \(a cut every 2 beats, high motion\), 7 on builds and lyrics \(every 4 to 8 beats, calm faces\)\. Import 1\.5x: about 63\.$/);
  assert.equal(answer.nextCall.input.options.shots.length, 12);
  assert.equal(answer.data.song.want.drop, "fast action, motion, impact");
});

test("the scan's song line counts the music layer, not a voice listed first, from saved beats only", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-song-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const mediaRoot = path.join(dataRoot, "media");
  await mkdir(mediaRoot, { recursive: true });
  const voice1 = "00000000-0000-4000-8000-000000000001.m4a";
  const song1 = "00000000-0000-4000-8000-000000000002.mp3";
  await writeFile(path.join(mediaRoot, voice1), "");
  await writeFile(path.join(mediaRoot, song1), "");
  const store = await openStore(dataRoot);
  const layers = [createLayer("audio", { id: "voice", src: `/api/media/${voice1}` }), createLayer("audio", { id: "music", src: `/api/media/${song1}` })];
  await store.createProject(createDocument({ id: "song-edit", name: "Song edit", scenes: [createScene({ id: "s1", duration: 20, layers })] }));
  // A voice gets a beat grid too, but an unsure one (steadyBeat needs 0.65). get() would decode: never asked.
  const saved = { [voice1]: { bpm: 96, confidence: 0.45, beats: [] }, [song1]: { bpm: 140, confidence: 0.85, beats: [] } };
  const decode = async () => { throw new Error("decoded on the scan path"); };
  const beatAnalysis = { get: decode, saved: async (file) => saved[path.basename(file)] ?? null };
  const songShapes = { get: decode, saved: async () => ({ seconds: 60, sections: [{ at: 0, kind: "drop" }] }) };
  const finder = {
    search: async () => ({ words: "show fight", candidates: [found(1)], dropped: {}, cached: false }),
    readScan: async () => null,
    scan: async () => ({ want: "", windows: [{ start: 0, end: 60 }], skipped: {}, shots: [{ n: 1, start: 1, end: 3, motion: 50, face: 0, flags: [] }] }),
  };
  const service = createAgentService({ store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot,
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], footage: finder, beatAnalysis, songShapes });
  await service.call("library", { project: "song-edit", topic: "footage", search: "show fight" });
  const scan = await service.call("library", { project: "song-edit", topic: "footage", scan: "F1" });
  assert.equal(scan.isError, undefined, scan.text);
  assert.match(scan.text, /\nThe song \(140 bpm\) needs about \d+ shots/);
  // Without saved song files there is no song line, and still no decode.
  delete saved[song1];
  const unmeasured = await service.call("library", { project: "song-edit", topic: "footage", scan: "F1" });
  assert.doesNotMatch(unmeasured.text, /The song/);
});

test("the look model counts as ready where transformers.js keeps it: <data>/models/hf/<model id>", async () => {
  const models = await mkdtemp(path.join(tmpdir(), "kino-look-model-"));
  assert.equal(lookModelReady(models), false);
  await mkdir(path.join(models, "hf", LOOK_MODEL), { recursive: true });
  assert.equal(lookModelReady(models), true);
  await rm(models, { recursive: true, force: true });
});

test("look source ref F1 draws a saved scan's sheet as one image, each still labeled F1.<shot> and its start", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id: "anime-edit", name: "Anime edit", scenes: [createScene({ id: "s1" })] }));
  // A saved scan of yt:AAAAAAAAAAA and its sheet: 5 stills of 320x180 in a 4 by 3 grid.
  await mkdir(scansFolder(dataRoot), { recursive: true });
  const shots = [12, 37, 5, 20, 8].map((n, index) => ({ n, start: n * 10, end: n * 10 + 2, motion: 80 - index, face: 0, match: 0, flags: [] }));
  await writeFile(path.join(scansFolder(dataRoot), "yt-AAAAAAAAAAA.json"), JSON.stringify({ version: SCAN_VERSION, id: "yt-AAAAAAAAAAA", title: "Episode 1", want: "", windows: [{ start: 0, end: 480 }], skipped: {}, sheet: shots.map((shot) => shot.n), shots }));
  const canvas = createCanvas(1280, 540);
  const context = canvas.getContext("2d");
  shots.forEach((_, index) => { context.fillStyle = `hsl(${index * 70}, 80%, 50%)`; context.fillRect((index % 4) * 320, Math.floor(index / 4) * 180, 320, 180); });
  await writeFile(path.join(scansFolder(dataRoot), "yt-AAAAAAAAAAA.jpg"), canvas.toBuffer("image/jpeg"));
  const real = createLook({ cache: { get: async () => null, set: async () => {} }, outDirectory: path.join(dataRoot, "out") });
  let drawn = null;
  const look = { ...real, tilesImage: async (tiles, options) => { drawn = { labels: tiles.map((tile) => tile.label), options }; return real.tilesImage(tiles, options); } };
  const service = createAgentService({ store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], look,
    footage: createFootageFinder({ directory: path.join(dataRoot, "footage"), dataRoot }) });
  // Not a candidate yet: the answer names the list.
  assert.equal((await service.call("look", { project: "anime-edit", mode: "source", ref: "F1" })).isError, true);
  const scanned = await service.call("library", { project: "anime-edit", topic: "footage", scan: "yt:AAAAAAAAAAA" });
  assert.equal(scanned.isError, undefined, scanned.text);
  const sheet = await service.call("look", { project: "anime-edit", mode: "source", ref: "F1" });
  assert.equal(sheet.isError, undefined, sheet.text);
  assert.deepEqual(drawn.labels, ["F1.12 2:00.0", "F1.37 6:10.0", "F1.5 0:50.0", "F1.20 3:20.0", "F1.8 1:20.0"]);
  assert.deepEqual(drawn.options.tile, { width: 320, height: 180 });
  assert.equal(sheet.images.length, 1);
  assert.match(sheet.text, /^F1 "Episode 1" shot sheet: the best 5 shots/);
  assert.match(sheet.text, /next: project \{"action":"import","file":"F1","options":\{"shots":\[12,37,5,20,8\]\}\}/);
});

test("look source puts the person's clips first and untagged, and 30 found clips as 3 groups by video", () => {
  const footage = addCandidates(null, [found(1), found(2), found(3)]);
  const own = ["beach.mp4", "intro.mov"].map((name) => ({ name, tag: foundClipTag({ id: name }, footage) }));
  // P9 saves the candidate's stable id (or its code) and the shot number with each imported clip.
  const clips = Array.from({ length: 30 }, (_, index) => ({ name: `shot${index}.mp4`,
    tag: foundClipTag({ footage: { candidate: index === 1 ? "F2" : footage.candidates[index % 3].id, shot: 30 - index } }, footage) }));
  const entries = groupClips([...clips.slice(0, 15), own[0], ...clips.slice(15), own[1]]);
  assert.deepEqual(entries.map((entry) => entry.group), [null, null, "F1", "F2", "F3"]);
  assert.deepEqual(entries.slice(0, 2).map((entry) => [entry.clips[0].name, entry.clips[0].tag]), [["beach.mp4", null], ["intro.mov", null]]);
  assert.deepEqual(entries.slice(2).map((entry) => entry.clips.length), [10, 10, 10]);
  assert.equal(groupLine(entries[2]), "F1: 10 shots (F1.3, F1.6, F1.9, F1.12, F1.15, F1.18, …)");
});

test("import: 3 near shots are one 1080p download padded 0.5 s, each cut at its exact frame to H.264, credited (license unknown as metadata), and shown under F1", async () => {
  const candidate = { ...found(1), code: "F1", scan: { id: "yt-vvvvvvvvvv1", shots: 3 } };
  const scan = { shots: [{ n: 37, start: 197.2, end: 199 }, { n: 38, start: 201, end: 203 }, { n: 40, start: 210, end: 212 }] };
  const pieces = planTake(candidate, scan, { file: "F1.37", shots: [38, "F1.40"] });
  assert.deepEqual(joinStretches(pieces).map(({ start, end, pieces: list }) => [start, end, list.map((piece) => piece.n)]), [[196.7, 212.5, [37, 38, 40]]]);
  const runs = [];
  // A stub yt-dlp: one file a section, named by its start, as yt-dlp names it.
  const run = async (args) => {
    runs.push(args);
    const out = args[args.indexOf("-o") + 1];
    args.forEach((arg, index) => { if (arg === "--download-sections") writeFileSync(out.replace("%(section_start)s", args[index + 1].slice(1).split("-")[0]).replace("%(ext)s", "webm"), ""); });
    return "";
  };
  const encoded = [];
  // The file starts 1.3 s early (the keyframe before 196.7); each cut is found 0.1 s after the scanned time.
  const tools = {
    probe: async () => ({ duration: 15.8 + 1.3 }),
    sceneScores: async (_file, from, seconds) => [{ t: from, score: 0 }, { t: Math.round((from + seconds / 2 + 0.1) * 100) / 100, score: 0.8 }],
    encode: async (file, out, { start, seconds }) => { encoded.push([path.basename(file), start, Math.round(seconds * 100) / 100]); await writeFile(out, ""); return out; },
  };
  const added = [];
  const addMedia = async (file, { name, mime, extra }) => { added.push({ name, mime, ...extra }); return { id: `m${added.length}.mp4`, src: `/api/media/m${added.length}.mp4`, name, mime, duration: 1.8, width: 1920, height: 1080, ...extra }; };
  const result = await takeFootage(candidate, pieces, { addMedia, projectId: "anime-edit", run, tools, runtime: { name: "node", path: process.execPath } });
  assert.equal(runs.length, 1);
  const args = runs[0];
  assert.equal(args[args.indexOf("-f") + 1], "bv*[height<=1080]+ba/b[height<=1080]");
  assert.deepEqual(args.filter((_, index) => args[index - 1] === "--download-sections"), ["*196.7-212.5"]);
  assert.ok(!args.some((arg) => /cookies/.test(arg)));
  // 197.2 in the video is 1.8 s into the file (0.5 pad + 1.3 lead-in); the cut comes 0.1 s later.
  assert.deepEqual(encoded, [["take.196.7.webm", 1.9, 1.8], ["take.196.7.webm", 5.7, 2], ["take.196.7.webm", 14.7, 2]]);
  assert.deepEqual(added.map((each) => [each.name, each.mime, each.projectId, each.credit.license, each.footage.shot]),
    [37, 38, 40].map((n) => [`F1.${n} Episode 1.mp4`, "video/mp4", "anime-edit", "unknown", n]));
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.media.map((item) => foundClipTag(item, { candidates: [candidate] }).label), ["F1.37", "F1.38", "F1.40"]);
  assert.doesNotMatch(takeText(candidate, result), /license|rights|end credits/i);
});

test("import refuses a bare F1 of a 23 min video, an unscanned video and a stretch over 60 s; yt: names the footage scan", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id: "anime-edit", name: "Anime edit", scenes: [createScene({ id: "s1" })] }));
  const agentState = createAgentStateStore(dataRoot);
  await agentState.update("anime-edit", (draft) => { draft.footage = addCandidates(null, [found(1), found(2)]); draft.footage.candidates[0].scan = { id: "yt-vvvvvvvvvv1", shots: 1 }; });
  const taken = [];
  const finder = { readScan: async () => ({ shots: [{ n: 4, start: 30, end: 32 }] }),
    captions: async () => ({ lang: "en", auto: false, lines: [{ start: 0.2, end: 1.5, text: "Hold on." }] }),
    take: async (candidate, pieces, { projectId }) => { taken.push([candidate.code, pieces.map((piece) => piece.n), projectId]); return { media: [{ id: "m1.mp4", src: "/api/media/m1.mp4", duration: 2, width: 1920, height: 1080, credit: takeCredit(candidate), footage: { shot: 4 } }], failed: [] }; } };
  const service = createAgentService({ store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], footage: finder });
  const importing = (input) => service.call("project", { project: "anime-edit", action: "import", ...input });
  const bare = await importing({ file: "F2" });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /"F2 is 23:40 long: import shots \(F2\.37\) or a stretch \(from, to, 60 s at most\)\. Scan it first\./);
  assert.match((await importing({ file: "F2", options: { shots: [3] } })).text, /F2 is not scanned yet/);
  assert.match((await importing({ file: "F1", from: "1:00", to: "2:30" })).text, /A stretch is 60 s at most/);
  assert.equal(JSON.parse((await importing({ file: "yt:abcdefghijk" })).text).reason, 'yt:abcdefghijk is not one of this video\'s songs yet. As the song: library {topic:"soundtrack", song:"yt:abcdefghijk"}, then import it; as footage: library {topic:"footage", scan:"yt:abcdefghijk"}');
  const imported = await importing({ file: "F1", options: { shots: [4] } });
  assert.equal(imported.isError, undefined, imported.text);
  assert.deepEqual(taken, [["F1", [4], "anime-edit"]]);
  assert.match(imported.text, /^Imported 1 clip of F1 "Episode 1" \(2 s in all, H\.264\)/);
  assert.match(imported.text, /^F1\.4 2s 1920×1080 \/api\/media\/m1\.mp4 says "Hold on\." 0\.2-1\.5 s$/m);
  assert.deepEqual((await agentState.read("anime-edit")).footage.candidates[0].imported, { shots: [4], seconds: 2 });
});

test("a slow import answers with a repeat call, and the repeat joins it: one download, the seconds counted once", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-footage-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id: "anime-edit", name: "Anime edit", scenes: [createScene({ id: "s1" })] }));
  const agentState = createAgentStateStore(dataRoot);
  await agentState.update("anime-edit", (draft) => { draft.footage = addCandidates(null, [found(1)]); draft.footage.candidates[0].scan = { id: "yt-vvvvvvvvvv1", shots: 1 }; });
  let takes = 0;
  let finish;
  const finder = { readScan: async () => ({ shots: [{ n: 4, start: 30, end: 32 }] }),
    take: () => { takes += 1; return new Promise((resolve) => { finish = () => resolve({ media: [{ id: "m1.mp4", src: "/api/media/m1.mp4", duration: 2, footage: { shot: 4 } }], failed: [] }); }); } };
  const service = createAgentService({ store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], footage: finder, footageWaitMs: 20 });
  const importing = () => service.call("project", { project: "anime-edit", action: "import", file: "F1", options: { shots: [4] } });
  const first = await importing();
  assert.match(first.text, /^F1 is still importing 1 piece .*Send the same call again/);
  const second = importing();
  setTimeout(() => finish(), 5);
  assert.match((await second).text, /^Imported 1 clip of F1/);
  assert.equal(takes, 1);
  assert.deepEqual((await agentState.read("anime-edit")).footage.candidates[0].imported, { shots: [4], seconds: 2 });
});

// The whole path on a real server, never online: a stub yt-dlp (tests/fixtures/footage) serves a
// generated 8 s clip of 4 shots as the found video. The footage reference's own calls search,
// scan and import; one clip goes in with add_layer and a final frame shows it, credited.
test("the skill's footage calls search, scan and import a stub video's shots; a final frame shows one and its answer names the credit", { skip: skipWithoutMediaTools, timeout: 60_000 }, async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-footage-proof-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const video = path.join(folder, "found.mp4");
  await run(ffmpeg, ["-v", "error", "-y",
    "-f", "lavfi", "-i", "mandelbrot=s=640x360:r=25", "-f", "lavfi", "-i", "smptebars=s=640x360:r=25:d=2",
    "-f", "lavfi", "-i", "cellauto=s=640x360:r=25:rule=110", "-f", "lavfi", "-i", "rgbtestsrc=s=640x360:r=25:d=2",
    "-filter_complex", "[0:v]trim=duration=2,setpts=PTS-STARTPTS[a];[2:v]trim=duration=2,setpts=PTS-STARTPTS[c];[a][1:v][c][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-g", "25", video]);
  const server = await startTestServer({ env: { KINO_YTDLP: FOOTAGE_STUB, STUB_YTDLP_VIDEO: video, KINO_YTDLP_JS: `node:${process.execPath}`, KINO_LOOK_DOWNLOAD: "off", KINO_YOUTUBE_GAP_MS: "0" } });
  t.after(() => server.stop());
  const agent = async (verb, body) => (await server.api(`/api/agent/${verb}`, { method: "POST", body })).json();
  await agent("project", { action: "create", id: "found", name: "Found", width: 640, height: 360, duration: 4 });

  const replies = [];
  for (const { tool, ...call } of jsonBlocks(skillSection("Three calls")).flat()) {
    const reply = await agent(tool, { project: "found", ...call });
    assert.notEqual(reply.isError, true, `${tool} ${JSON.stringify(call)}: ${reply.text}`);
    replies.push(reply);
  }
  const [search, scan, take] = replies;
  assert.match(search.text, /^F1 Stub Studio \(verified\) · 0:08 · "Stub Series episode 1 fight scene"$/m);
  assert.match(search.text, /^Dropped 1: 1 edits\.$/m);
  assert.match(scan.text, /^F1 "Stub Series episode 1 fight scene" · scanned 0:08 of 0:08 · 4 shots:$/m);
  assert.match(scan.text, /^F1\.1 0:00\.0-0:02\.0 /m);
  assert.deepEqual(take.data.media.map((item) => item.shot), [1, 2]);
  assert.doesNotMatch(take.text, /license|end credits/i);
  for (const { tool, ...call } of jsonBlocks(skillSection("Note a video")).flat()) {
    const reply = await agent(tool, { project: "found", ...call });
    assert.notEqual(reply.isError, true, `${tool} ${JSON.stringify(call)}: ${reply.text}`);
  }
  assert.equal((await agent("library", { topic: "guide", name: "footage" })).isError, undefined);

  // The import answer's own add_layer call (compose of a whole scene is the slow path: a hand-run script).
  const [clip] = take.data.media;
  const added = await agent("edit", { project: "found", ops: [{ op: "add_layer", layerType: "video", name: "found shot", properties: { src: clip.src, x: 0, y: 0, width: 640, height: 360, mediaSourceDuration: 2 } }] });
  assert.equal(added.isError, undefined, added.text);
  // Every final render's answer names its sources in one quiet line.
  const started = await agent("render", { project: "found", action: "start", quality: "final", format: "png", options: { time: 1 } });
  assert.notEqual(started.isError, true, started.text);
  assert.match(started.text, / Sources \(for when the person publishes\): "Stub Series episode 1 fight scene" by Stub Studio \(.*\)\./);
  assert.doesNotMatch(started.text, /rights|license/i);
  const done = await agent("render", { project: "found", action: "wait", job: started.data.job, timeout_s: 30 });
  assert.equal(done.data.status, "done", done.text);
  // The frame is the found footage, not an empty scene: many different colors.
  const pixels = await run(ffmpeg, ["-v", "error", "-i", done.data.files[0].path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const colors = new Set();
  for (let at = 0; at < pixels.length; at += 3 * 97) colors.add(`${pixels[at] >> 4},${pixels[at + 1] >> 4},${pixels[at + 2] >> 4}`);
  assert.ok(colors.size > 20, `${colors.size} colors in the rendered frame`);
});

// ---- what is said: captions (footage-finder/words.mjs) ----------------------------------------
import { applySaid, captionArgs, fetchCaptions, parseCaptions, saidMatches, saysOf, saysText } from "./footage-finder/words.mjs";
import { importLineCall } from "./footage-finder/actions.mjs";

// An uploaded caption file as YouTube serves it: a cue can wrap one sentence over two rows.
const MANUAL_VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.200 --> 00:00:03.360
All right, so here we are, in front of the
elephants

00:00:05.318 --> 00:00:07.974
the cool thing about these guys is that they
have really...

00:00:07.974 --> 00:00:12.616
really really long trunks

00:00:14.421 --> 00:00:15.733
(baaaaaaaaaaahhh!!)
`;

// Auto captions roll: each cue repeats the row before it, and a 0.01 s cue repeats the finished line.
const ROLLING_VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.500 align:start position:0%
<SP>
all<00:00:01.500><c> right</c><00:00:02.000><c> so</c>

00:00:03.500 --> 00:00:03.510 align:start position:0%
all right so
<SP>


00:00:03.510 --> 00:00:05.000 align:start position:0%
all right so
here<00:00:04.000><c> we</c><c> are</c>

00:00:05.000 --> 00:00:05.010 align:start position:0%
here we are
<SP>


00:00:05.010 --> 00:00:07.000 align:start position:0%
here we are
in front of the &amp; more
`.replaceAll("<SP>", " "); // YouTube's blank-looking rows hold one space (an editor may trim them, so they are marked)

test("parseCaptions reads uploaded cues (rows joined, times to the millisecond) and rolling auto cues (repeats dropped, tags removed)", () => {
  assert.deepEqual(parseCaptions(MANUAL_VTT).map((each) => [each.start, each.end, each.text]), [
    [1.2, 3.36, "All right, so here we are, in front of the elephants"],
    [5.318, 7.974, "the cool thing about these guys is that they have really..."],
    [7.974, 12.616, "really really long trunks"],
    [14.421, 15.733, "(baaaaaaaaaaahhh!!)"],
  ]);
  assert.deepEqual(parseCaptions(ROLLING_VTT).map((each) => [each.start, each.end, each.text]), [
    [1, 3.5, "all right so"], [3.51, 5, "here we are"], [5.01, 7, "in front of the & more"],
  ]);
});

// A stub yt-dlp for captions: writes the file a scenario names into the -o folder, counts the calls.
function captionRun(scenario, calls = []) {
  return async (args) => {
    calls.push(args);
    if (scenario.fail) throw new Error("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests");
    const auto = args.includes("--write-auto-subs");
    const text = auto ? scenario.auto : scenario.manual;
    if (text) await writeFile(args[args.indexOf("-o") + 1].replace("%(id)s", "jNQXAC9IVRw").replace("%(ext)s", `${auto ? "en-orig" : "en"}.vtt`), text);
    return "";
  };
}
const withRuntime = { runtime: { name: "node", path: process.execPath }, languages: ["en"] };

test("fetchCaptions asks for uploaded captions first and for the video's own auto captions only when there are none; no captions and a rate limit are answers, not errors", async () => {
  const calls = [];
  const manual = await fetchCaptions("jNQXAC9IVRw", { ...withRuntime, run: captionRun({ manual: MANUAL_VTT, auto: ROLLING_VTT }, calls) });
  assert.deepEqual([manual.lang, manual.auto, manual.lines.length, calls.length], ["en", false, 4, 1]);
  assert.ok(calls[0].includes("--write-subs") && !calls[0].includes("--write-auto-subs") && calls[0].includes("--skip-download"));
  const autoCalls = [];
  const auto = await fetchCaptions("jNQXAC9IVRw", { ...withRuntime, run: captionRun({ auto: ROLLING_VTT }, autoCalls) });
  assert.deepEqual([auto.lang, auto.auto, auto.lines.length, autoCalls.length], ["en", true, 3, 2]);
  assert.equal(autoCalls[1][autoCalls[1].indexOf("--sub-langs") + 1], "en-orig");
  assert.ok(!autoCalls.flat().some((arg) => /cookies/.test(arg)));
  assert.deepEqual(await fetchCaptions("jNQXAC9IVRw", { ...withRuntime, run: captionRun({}) }), { none: true });
  const limited = await fetchCaptions("jNQXAC9IVRw", { ...withRuntime, run: captionRun({ fail: true }) });
  assert.deepEqual([limited.none, limited.retry], [true, true]);
  assert.match(limited.why, /429/);
  const args = captionArgs("jNQXAC9IVRw", "/x", { languages: ["de", "en"] });
  assert.equal(args[args.indexOf("--sub-langs") + 1], "de(-.+)?,en(-.+)?");
});

test("the finder keeps a video's captions (or that it has none) so YouTube is asked once; a rate limit is not kept but is not asked again for 15 minutes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-captions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 1_000_000;
  const calls = [];
  const make = (scenario) => createFootageFinder({ directory, now: () => clock, languages: ["en"], runtime: withRuntime.runtime, ytDlp: captionRun(scenario, calls) });
  const video = { source: "youtube", videoId: "jNQXAC9IVRw" };
  const first = make({ manual: MANUAL_VTT });
  assert.equal((await first.captions(video)).lines.length, 4);
  assert.equal(calls.length, 1);
  assert.equal((await make({}).captions(video)).lines.length, 4);
  assert.equal(calls.length, 1, "a second finder reads the saved file");
  assert.deepEqual(await first.captions({ source: "commons", id: "clip:commons-1" }), { none: true });
  const quiet = make({});
  const none = { source: "youtube", videoId: "aqz-KE-bpKQ" };
  assert.deepEqual(await quiet.captions(none), { none: true });
  const asked = calls.length;
  assert.deepEqual(await quiet.captions(none), { none: true });
  assert.equal(calls.length, asked, "no captions is asked once");
  const busy = make({ fail: true });
  const limited = { source: "youtube", videoId: "aB3dE5fG7hJ" };
  assert.equal((await busy.captions(limited)).retry, true);
  const afterLimit = calls.length;
  assert.equal((await busy.captions(limited)).retry, true);
  assert.equal(calls.length, afterLimit, "not asked again inside 15 minutes");
  clock += 16 * 60_000;
  await busy.captions(limited);
  assert.ok(calls.length > afterLimit, "asked again after 15 minutes");
});

test("applySaid: the shot that says the words goes first and a burned-in subtitle on it is its line, not a flaw; saidMatches reads words in any order", () => {
  const spoken = [{ start: 1, end: 2.5, text: "All right, so here we are" }, { start: 5.2, end: 7, text: "I will protect them all" }];
  const shots = [
    { n: 1, start: 0, end: 3, flags: [] },
    { n: 2, start: 5, end: 7.5, flags: ["subtitles"] },
    { n: 3, start: 30, end: 32, flags: ["subtitles"] },
  ];
  const { shots: ranked, hits } = applySaid(shots, spoken, "protect them");
  assert.equal(hits, 1);
  assert.deepEqual(ranked.map((shot) => shot.n), [2, 1, 3]);
  assert.deepEqual([ranked[0].said, ranked[0].hasSubs, ranked[0].flags], [true, true, []]);
  assert.equal(ranked[0].says, "I will protect them all");
  assert.deepEqual(ranked[2].flags, ["subtitles"]);
  assert.equal(applySaid(shots, spoken, "").hits, 0);
  assert.equal(saidMatches("I will protect them all", "all protect"), true);
  assert.equal(saidMatches("I will protect them all", "defend"), false);
  // Letters are not matched across word boundaries or inside other words (Latin text), but a phrase without spaces is.
  assert.equal(saidMatches("Have a nice vacation", "a cat"), false);
  assert.equal(saidMatches("I know that", "no"), false);
  assert.equal(saidMatches("also it was", "so"), false);
  assert.equal(saidMatches("so it was", "so it"), true);
  assert.equal(saidMatches("今日はいい天気ですね", "いい天気"), true);
});

// A scan of three shots over a video that says two lines (what a finder's captions() answers).
const SAID_LINES = [{ start: 1, end: 2.5, text: "All right, so here we are" }, { start: 5.2, end: 7, text: "I will protect them all" }];
const saidFinder = (captions) => ({
  readScan: async () => null,
  scan: async (_candidate, options) => ({ want: options.want, windows: [{ start: 0, end: 40 }], matchShown: false, skipped: {},
    shots: [{ n: 1, start: 0, end: 3, motion: 50, face: 10, flags: [] }, { n: 2, start: 5, end: 7.5, motion: 60, face: 20, flags: ["subtitles"] }, { n: 3, start: 30, end: 32, motion: 70, face: 0, flags: [] }] }),
  captions: async () => captions,
});

test("a scan prints what each shot says and the Lines list; said:\"words\" puts that shot first, says it has subtitles, and the next call imports the line by its time range", async () => {
  const footage = addCandidates(null, [found(1)]);
  const actions = createFootageActions({ finder: saidFinder({ lang: "en", auto: true, lines: SAID_LINES }) });
  const plain = await actions.handle({ scan: "F1" }, { footage, personClips: 0 });
  assert.match(plain.text, /^F1\.1 0:00\.0-0:03\.0 3\.0s motion 50 face 10 says: "All right, so here we are"$/m);
  assert.match(plain.text, /^F1\.2 0:05\.0-0:07\.5 2\.5s motion 60 face 20 subtitles says: "I will protect them all"$/m);
  assert.match(plain.text, /^Lines \(en, auto captions\):\n0:01 "All right, so here we are" \(F1\.1\)\n0:05 "I will protect them all" \(F1\.2\)$/m);
  assert.deepEqual(plain.nextCall, { tool: "project", input: { action: "import", file: "F1", options: { shots: [1, 3] } } });
  const asked = await actions.handle({ scan: "F1", said: "protect them" }, { footage, personClips: 0 });
  assert.match(asked.text, /^F1\.2 0:05\.0-0:07\.5 2\.5s motion 60 face 20 has subtitles says: "I will protect them all"$/m);
  assert.ok(asked.text.indexOf("F1.2 ") < asked.text.indexOf("F1.1 "), asked.text);
  assert.match(asked.text, /^0:05 "I will protect them all" \(F1\.2\) says it$/m);
  assert.deepEqual(asked.nextCall, importLineCall("F1", SAID_LINES[1]));
  assert.deepEqual(asked.nextCall.input.options, { from: 4.9, to: 7.3 });
  assert.equal(asked.update(footage).said, "protect them");
  const nobody = await actions.handle({ scan: "F1", said: "dragon" }, { footage, personClips: 0 });
  assert.match(nobody.text, /^Nobody says "dragon" in the scanned part\.$/m);
  assert.deepEqual(nobody.nextCall.input.options.shots, [1, 3]);
  // The words alone, with no scan, are kept for later scans.
  const saved = await actions.handle({ said: "protect them" }, { footage, personClips: 0 });
  assert.equal(saved.update(footage).said, "protect them");
});

test("a video with no captions is said once, and asked-for words say they were not looked for; a rate limit says so only when words were asked", async () => {
  const footage = addCandidates(null, [found(1)]);
  const none = createFootageActions({ finder: saidFinder({ none: true }) });
  const first = await none.handle({ scan: "F1" }, { footage, personClips: 0 });
  assert.match(first.text, /^No captions on this video\.$/m);
  const again = first.update(footage);
  assert.equal(again.candidates[0].noCaptions, true);
  assert.doesNotMatch((await none.handle({ scan: "F1" }, { footage: again, personClips: 0 })).text, /No captions/);
  assert.match((await none.handle({ scan: "F1", said: "hello there" }, { footage: again, personClips: 0 })).text, /^No captions, so "hello there" was not looked for: shots rank on the picture\.$/m);
  const limited = createFootageActions({ finder: saidFinder({ none: true, why: "HTTP Error 429", retry: true }) });
  const quiet = await limited.handle({ scan: "F1" }, { footage, personClips: 0 });
  assert.doesNotMatch(quiet.text, /aption/);
  assert.equal(quiet.update(footage).candidates[0].noCaptions, undefined);
  assert.match((await limited.handle({ scan: "F1", said: "hello" }, { footage, personClips: 0 })).text, /^Captions could not be read now \(HTTP Error 429\), so "hello" was not looked for\.$/m);
});

test("an import answer says what a clip of 1.5 s or more says, in the clip's own seconds, from where the cut really starts; a tiny clip says nothing", () => {
  const candidate = { ...found(1), code: "F1" };
  const clip = (cutAt, duration, shot) => ({ id: `m${shot}.mp4`, src: `/api/media/m${shot}.mp4`, duration, width: 1920, height: 1080, credit: takeCredit(candidate), footage: { shot, start: cutAt - 0.1, end: cutAt + duration, cutAt } });
  const text = takeText(candidate, { media: [clip(4.9, 2.4, 2), clip(30, 1.2, 3)], failed: [], captions: { lang: "en", auto: false, lines: SAID_LINES } });
  assert.match(text, /^F1\.2 2\.4s 1920×1080 \/api\/media\/m2\.mp4 says "I will protect them all" 0\.3-2\.1 s$/m);
  assert.match(text, /^F1\.3 1\.2s 1920×1080 \/api\/media\/m3\.mp4$/m);
  assert.doesNotMatch(takeText(candidate, { media: [clip(4.9, 2.4, 2)], failed: [] }), /says/);
  assert.deepEqual(saysOf(SAID_LINES, 4.9, 1.4), []);
  assert.equal(saysText(saysOf(SAID_LINES, 0, 8)), 'says "All right, so here we are" 1.0-2.5 s, "I will protect them all" 5.2-7.0 s');
});
