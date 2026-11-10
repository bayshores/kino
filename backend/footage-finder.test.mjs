// The footage finder: from a prompt alone to found, scanned and imported clips. No network here:
// yt-dlp, fetch, the embedder and Vision are stubs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKinoMcpServer } from "./mcp.mjs";
import { createWebCache } from "./web-cache.mjs";
import { createFootageFinder } from "./footage-finder/index.mjs";
import { candidateLine, droppedLine, nothingFoundText } from "./footage-finder/search.mjs";
import { createCommonsSource, parseCommonsSearch } from "./footage-finder/licensed.mjs";

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
    assert.equal(candidateLine(answer.candidates[1], "F2"), 'F2 Big Studio (verified) · 10:00 · "Episode 1" · license unknown');
    assert.equal(droppedLine(answer.dropped), "Dropped 5: 1 yours: region, 1 edits, 1 reactions, 1 live, 1 over 3 h.");
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

test("Commons: a 3840x2160 original yields its 1080p copy (360p to scan), credited; a CC BY-NC file is dropped", () => {
  const found = parseCommonsSearch({ query: { pages: [commonsPage(7, { license: "CC BY-NC-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0" }), commonsPage(5)] } });
  assert.deepEqual(found.map((clip) => clip.id), ["clip:commons-5"]);
  const [clip] = found;
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
