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
import { createCommonsSource, parseCommonsSearch } from "./footage-finder/licensed.mjs";

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
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
