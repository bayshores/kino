// Sound search (direction plan fix 8, milestone B8): CC0 sound effects from Openverse behind the
// Settings switch. Openverse is a local stub here (KINO_OPENVERSE_API): the tests never reach the
// network, and no sound is ever played.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { boardAsk } from "./agent/board-text.mjs";
import { askText } from "./agent/stops.mjs";
import { defaultSettings, mergeSettings } from "./agent/dashboard.mjs";
import { startTestServer } from "./media.test.support.mjs";
import { musicDrop, reversedWav } from "./sound-library.mjs";
import { createSoundSearch, freesoundLicense } from "./sound-search.mjs";
import { askedShape, junkSound, rankSounds, sfxPrompt } from "./sfx-rank.mjs";
import { countOnsets } from "./inspire.mjs";
import { encodeVector, normalize } from "./music-embed.mjs";

const run = promisify(execFile);
const DOOR = "0a1b2c3d-0000-4000-8000-000000000001";
const RAIN = "0a1b2c3d-0000-4000-8000-000000000002";
const CCBY = "0a1b2c3d-0000-4000-8000-000000000003";
const CHANGED = "0a1b2c3d-0000-4000-8000-000000000004";

let stub;
let base;
let server;
let key;
let folder;
let wav;
const requests = [];
let limited = false;

const record = (id, { license = "cc0", duration = 1200, title = "Door slam", file = "door.wav" } = {}) => ({
  id, title, creator: "someone", license, license_version: "1.0", provider: "freesound", source: "freesound", filetype: "wav", duration,
  url: `${base}/files/${file}`, foreign_landing_url: `https://freesound.org/people/someone/sounds/${id.slice(-1)}`,
});

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "kino-sound-search-"));
  // A 1.2 s tone made by FFmpeg, served as the sound's file (never played).
  const file = path.join(folder, "door.wav");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=1.2", "-ar", "44100", "-ac", "1", file]);
  wav = await readFile(file);
  stub = createServer((req, res) => {
    requests.push({ url: req.url, agent: req.headers["user-agent"] });
    if (limited) { res.writeHead(429, { "retry-after": "120" }); return res.end("{}"); }
    const url = new URL(req.url, base);
    const send = (value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    // Openverse answers 401 to a page of more than 20 without an account.
    if (url.pathname === "/v1/audio/" && Number(url.searchParams.get("page_size")) > 20) { res.writeHead(401); return res.end("{}"); }
    if (url.pathname === "/v1/audio/") return send({ result_count: 3, results: [
      record(RAIN, { duration: 30_000, title: "Rain on a roof" }), record(CCBY, { license: "by", title: "Door slam (CC BY)" }), record(DOOR), record(CHANGED, { license: "by-nc", title: "Door slam (NC)" }),
    ] });
    if (url.pathname === `/v1/audio/${DOOR}/`) return send(record(DOOR));
    if (url.pathname === `/v1/audio/${RAIN}/`) return send(record(RAIN, { duration: 30_000, title: "Rain on a roof" }));
    if (url.pathname === `/v1/audio/${CHANGED}/`) return send(record(CHANGED, { license: "by-nc" }));
    if (url.pathname === "/files/door.wav") { res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length }); return res.end(wav); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${stub.address().port}`;
  // yt-dlp is a stub: YouTube's mix for a song (the seed, a song like it, a live set).
  const ytdlp = path.join(folder, "yt-dlp");
  const line = (id, title) => JSON.stringify({ id, title, channel: "Apex - Topic", duration: 200, url: `https://www.youtube.com/watch?v=${id}` });
  await writeFile(ytdlp, `#!/bin/sh\ncat <<'END'\n${[line("L2_yy-B2eC4", "START IT ALL OVER"), line("r60ok-Za8cg", "Never Knew"), line("liveliveliv", "Never Knew (Live)")].join("\n")}\nEND\n`);
  await chmod(ytdlp, 0o755);
  // The built-in sound library's catalog, stubbed: its one file comes from the stub server.
  const sha256 = createHash("sha256").update(wav).digest("hex");
  const library = path.join(folder, "sound-library.json");
  const CC0 = { license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" };
  await writeFile(library, JSON.stringify({
    sources: { tones: { title: "Tones", author: "kino tests", page: "https://example.org/tones", url: `${base}/files/door.wav`, sha256, ...CC0 } },
    sounds: [{ id: "whoosh-1", words: "whoosh swoosh transition", seconds: 1.2, lufs: -20, peak: -3, source: "tones" }, { id: "click-1", words: "click tap button ui", seconds: 0.2, lufs: -18, peak: -2, source: "tones" }],
    music: ["one", "two", "three", "four"].map((id, index) => ({ id, title: `Track ${id}`, moods: index % 2 ? ["calm"] : ["uplifting", "bright"], energy: index % 2 ? "low" : "high", bpm: 100 + index * 10, genre: "electronic", instruments: "Synths",
      seconds: 120, lufs: -14, peak: -1, drop: index === 0 ? 32.5 : null, url: `${base}/files/door.wav`, sha256, page: "https://example.org/track", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", credit: `"Track ${id}" Kevin MacLeod (incompetech.com), CC BY 4.0` })),
  }));
  server = await startTestServer({ env: { KINO_OPENVERSE_API: `${base}/v1/audio/`, KINO_ARCHIVE_API: base, KINO_YTDLP: ytdlp, KINO_SOUND_LIBRARY_CATALOG: library } });
  key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
  await agent("project", { action: "create", id: "sounds", name: "Sounds", width: 1280, height: 720, duration: 4 });
});
after(async () => {
  await server?.stop();
  await new Promise((resolve) => (stub ? stub.close(resolve) : resolve()));
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "sounds", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const setSearch = (search) => server.api("/api/dashboard/settings", { method: "PUT", body: { sounds: { search } }, headers: { "x-kino-review": key } });

test("the switch is off by default and strict about its value", () => {
  assert.deepEqual(defaultSettings().sounds, { search: false });
  assert.equal(mergeSettings(defaultSettings(), { sounds: { search: true } }).sounds.search, true);
  assert.throws(() => mergeSettings(defaultSettings(), { sounds: { search: "yes" } }), /sounds\.search is true or false\./);
});

test("with the switch off, library sounds and an Openverse import say so and reach nothing", async () => {
  const searched = await agent("library", { topic: "sounds", name: "openverse", search: "door slam" });
  assert.equal(searched.isError, true);
  assert.match(searched.text, /Sound search is off: the person turns it on in kino Settings/);
  const imported = await agent("project", { action: "import", file: `openverse:${DOOR}` });
  assert.equal(imported.isError, true);
  assert.match(imported.text, /Sound search is off/);
  assert.equal(requests.length, 0, "nothing was sent to Openverse");
});

test("the built-in library: effects by description words and mood-tagged music, imported once with their credit, switch off", async () => {
  const found = await agent("library", { topic: "sounds", search: "whooshes for a transition" });
  assert.equal(found.isError, undefined, found.text);
  assert.match(found.text, /^sfx:whoosh-1 1\.2s -20 LUFS: whoosh swoosh transition$/m);
  assert.doesNotMatch(found.text, /click-1|openverse/);
  const sound = await agent("project", { action: "import", file: "sfx:whoosh-1" });
  assert.match(sound.text, /credit kept with the file: "whoosh-1" from Tones by kino tests, CC0 1\.0 \(https:\/\/example\.org\/tones\)\.$/m);
  const fetched = requests.length;
  await agent("project", { action: "import", file: "sfx:click-1" });
  assert.equal(requests.length, fetched, "the source downloads once, then comes from kino's data folder");

  // Asked about first: no music answer in the brief yet. Filters by mood, energy and bpm words.
  const music = await agent("library", { topic: "music", search: "uplifting high 95-125 bpm" });
  assert.match(music.text, /^The brief has no music answer \(look_sound\): ask the person/);
  assert.deepEqual(music.data.music.map((track) => track.id).sort(), ["music:one", "music:three"]);
  assert.match(music.text, /music:one 'Track one' uplifting\/bright high 100 bpm 120s electronic, drop at 32\.5s/);
  // Varied per project: another project's order is its own.
  await agent("project", { action: "create", id: "sounds-2", name: "Sounds 2", width: 1280, height: 720, duration: 4 });
  const orders = new Set();
  for (const project of ["sounds", "sounds-2"]) orders.add((await agent("library", { project, topic: "music" })).data.music.map((track) => track.id).join());
  assert.equal(orders.size, 2, "two projects do not list the tracks in the same order");
  const track = await agent("project", { action: "import", file: "music:two" });
  assert.match(track.text, /"Track two" Kevin MacLeod \(incompetech\.com\), CC BY 4\.0\. Put it in the end credits\.$/m);
  const bad = await agent("project", { action: "import", file: "music:nope" });
  assert.match(bad.text, /no music:nope/);
});

test("on: commercial-use results only (CC0, CC BY; never NC), short ones by default, and an import keeps the credit", async () => {
  assert.equal((await setSearch(true)).status, 200);
  const searched = await agent("library", { topic: "sounds", name: "openverse", search: "door slam" });
  assert.equal(searched.isError, undefined, searched.text);
  assert.match(searched.text, new RegExp(`openverse:${DOOR} 'Door slam' 1\\.2s by someone \\(freesound, CC0 1\\.0\\)`));
  assert.match(searched.text, new RegExp(`openverse:${CCBY} 'Door slam \\(CC BY\\)' 1\\.2s by someone \\(freesound, CC BY 1\\.0\\)`));
  assert.doesNotMatch(searched.text, /\(NC\)|Rain on a roof/, "not for commercial use, or longer than 10 s");
  assert.match(searched.text, /^Freesound is not searched: no Freesound API key in kino Settings/m);
  assert.match(searched.text, /Made using Openverse\. Not endorsed or certified by Openverse\./);
  assert.match(requests.at(-1).url, /q=door\+slam/);
  assert.match(requests.at(-1).url, /license_type=commercial/);
  assert.equal(requests.at(-1).agent, "kino (https://github.com/bayshores/kino)", "kino's own name only");

  const longer = await agent("library", { topic: "sounds", name: "openverse", search: "rain", full: true });
  assert.match(longer.text, /Rain on a roof' 30s/);

  const imported = await agent("project", { action: "import", file: `openverse:${DOOR}` });
  assert.equal(imported.isError, undefined, imported.text);
  assert.match(imported.text, /imported Door slam\.wav \(duration 1\.2\d*s\) as \/api\/media\/[0-9a-f-]+\.wav/);
  assert.match(imported.text, /layerType:"audio"/);
  assert.match(imported.text, /credit kept with the file: "Door slam" by someone, CC0 1\.0 \(https:\/\/freesound\.org\//);
  const media = await agent("library", { topic: "media", search: "Door slam" });
  assert.match(media.text, /credit: "Door slam" by someone, CC0 1\.0/);
  assert.equal(media.data.media[0].credit.license, "CC0 1.0");
  assert.equal(media.data.media[0].credit.id, `openverse:${DOOR}`);

  // The sound reference's example runs as written with the imported file (skill.test.mjs).
  const guide = await readFile(new URL("../skills/kino/references/sound.md", import.meta.url), "utf8");
  const example = guide.split("## Sound effects: finding and placing them")[1].split("```json\n")[1].split("```")[0].trim();
  const src = imported.text.match(/\/api\/media\/[0-9a-f-]+\.wav/)[0];
  const placed = await agent("edit", { ops: [JSON.parse(example.replace(/\/api\/media\/<id>\.mp3/, src))] });
  assert.equal(placed.isError, undefined, placed.text);
  assert.equal(placed.data.fixed, undefined, "kino did not have to fix the example");
});

test("the license is read again at import: a sound no longer CC0 is refused", async () => {
  await setSearch(true);
  const refused = await agent("project", { action: "import", file: `openverse:${CHANGED}` });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /no longer allows commercial use/);
});

test("a 429 stops every call until its retry-after time, with no retry", async () => {
  await setSearch(true);
  limited = true;
  try {
    const first = await agent("library", { topic: "sounds", name: "openverse", search: "camera shutter" });
    assert.equal(first.isError, true);
    assert.match(first.text, /Openverse limits searches \(20 a minute, 200 a day without an account\)\. Try again in 1[12]\d s/);
    const count = requests.length;
    const second = await agent("library", { topic: "sounds", name: "openverse", search: "phone vibrate" });
    assert.match(second.text, /Try again in/);
    assert.equal(requests.length, count, "the second call did not reach Openverse");
  } finally { limited = false; }
});

test("musicDrop marks a hard rise to the loud part, never a soft swell back from a quiet break; reversedWav swells into the hit", () => {
  // [t, short-term, momentary] every 0.1 s: a level line with a stretch from `at` to `until`.
  const curve = (base, level, at, until = 200, ramp = 0) => Array.from({ length: 2000 }, (_, i) => {
    const t = i / 10, share = ramp ? Math.min(1, Math.max(0, (t - at) / ramp)) : t >= at ? 1 : 0;
    const value = t < until ? base + (level - base) * share : base;
    return [t, value, value];
  });
  assert.ok(Math.abs(musicDrop(curve(-24, -10, 40)) - 40) <= 0.2, "the drop is placed where the music hits");
  // A soft swell: the same rise spread over 6 s (Bittersweet's return after its quiet break) is no drop.
  assert.equal(musicDrop(curve(-24, -10, 40, 200, 6)), null);
  assert.equal(musicDrop(curve(-120, -12, 0)), null, "the first 3 s, before the window fills, never make a drop");
  // 16-bit mono: a hit (32000) that rings down; reversed, it starts silent and ends on the hit.
  const rate = 1000, frames = 2000, pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(32000 * (1 - i / frames)), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  const out = reversedWav(Buffer.concat([header, pcm]), 1);
  assert.equal(out.readUInt32LE(40), 2000, "its first 1 s: 1000 frames of 16-bit mono");
  assert.deepEqual([out.readInt16LE(44), out.readInt16LE(44 + 999 * 2)], [0, 32000]);
});

test("the board's sound line offers files or the built-in library, never the switch", () => {
  const board = { rev: 1, music: "none", shots: [{ id: "S1", cue: 0, dur: 2, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", text: "none", sound: "none", why: "the hook" }], calls: [], open: [] };
  const ask = (soundSearch) => boardAsk({ id: "C1", board, frame: { width: 1920, height: 1080 }, seconds: 2, soundSearch, offerSound: true }).text;
  assert.match(ask(false), /^No sound effects\. Send me sound files, or say so and I add a few from kino's library\.$/m);
  assert.equal(ask(true), ask(false));
});

test("the sound stop names where found sounds came from", () => {
  const credits = ['"Door slam" by someone, CC0 1.0', '"Buzz" by b, CC0 1.0', '"Tap" by c, CC0 1.0', '"Rain" by d, CC0 1.0'];
  const ask = askText({ id: "C5", kind: "sound", video: { seconds: 20, credits }, checked: { errors: 0, warnings: 0 } });
  assert.match(ask, /^Sounds: "Door slam" by someone, CC0 1\.0; "Buzz" by b, CC0 1\.0; "Tap" by c, CC0 1\.0; and 1 more\.$/m);
  assert.doesNotMatch(askText({ id: "C4", kind: "color", video: { seconds: 20, credits }, checked: {} }), /Sounds:/);
  assert.doesNotMatch(askText({ id: "C5", kind: "sound", video: { seconds: 20 }, checked: {} }), /Sounds:/);
});

test("soundtrack: search, measure against the intents, note, the person's use, import with credit; YouTube songs never import", async () => {
  await setSearch(true);
  await agent("notes", { action: "intents", beats: [{ from: 0, to: 2, intent: "the viewer feels the quiet before" }, { from: 2, to: 4, intent: "the viewer feels the payoff land" }] });
  // The reference's examples run as written, in order (skills/kino/references/soundtrack.md).
  const guide = await readFile(new URL("../skills/kino/references/soundtrack.md", import.meta.url), "utf8");
  const [searchCall, measureCall, noteCall, likeCall, briefCall] = [...guide.matchAll(/```json\n(.+?)\n```/g)].map((match) => {
    const { tool, ...call } = JSON.parse(match[1]);
    assert.equal(tool, "library");
    return call;
  });
  const found = await agent("library", { ...searchCall, source: "openverse" });
  assert.equal(found.isError, undefined, found.text);
  assert.match(found.text, new RegExp(`openverse:${RAIN} 'Rain on a roof' by someone · 30s · CC0 1\\.0`));
  assert.match(requests.at(-1).url, /category=music/);
  const measured = await agent("library", { ...measureCall, measure: `openverse:${RAIN}` });
  assert.equal(measured.isError, undefined, measured.text);
  assert.match(measured.text, /story: 2 beats from notes intents · 4s/);
  assert.match(measured.text, /energy by beat: 1 0-2s \d+ · 2 2-4s \d+/);
  // The person can listen: a small preview is kept and served; nothing else is.
  const song = await server.api(`/api/dashboard/inspire/song/ov-${RAIN}`);
  assert.equal(song.status, 200);
  assert.equal(song.headers.get("content-type"), "audio/mp4");
  for (const wrong of ["ov-0a1b2c3d-0000-4000-8000-000000000009", "yt-..%2F..%2Fx", "openverse:x"]) assert.equal((await server.api(`/api/dashboard/inspire/song/${wrong}`)).status, 404, wrong);
  const noted = await agent("library", { ...noteCall, note: { ...noteCall.note, id: `openverse:${RAIN}` } });
  assert.equal(noted.isError, undefined, noted.text);
  const used = await server.api("/api/dashboard/act/library", { method: "POST", headers: { "x-kino-review": key }, body: { project: "sounds", topic: "soundtrack", name: `use openverse:${RAIN}` } });
  assert.match((await used.json()).text, /Marked Rain on a roof to use/);
  const listed = await agent("library", { topic: "soundtrack" });
  assert.match(JSON.stringify(listed), /you picked openverse:/, "the agent hears the person's pick");
  assert.match(listed.text, /taste: 1 liked song, 0 rejected songs/);
  assert.match(listed.text, /^ {2}fit \d+ \(/m, "a measured song's fit, with why");
  // The brief is saved with the soundtrack and shown in its answer.
  assert.match((await agent("library", briefCall)).text, /brief saved: want "upbeat, playful, confident, modern electronic", not "cinematic", "vocals"/);
  assert.match((await agent("library", { topic: "soundtrack" })).text, /^brief: want "upbeat/m);
  // More like a song: YouTube's mix for it, without the seed or the live set.
  const liked = await agent("library", likeCall);
  assert.equal(liked.isError, undefined, liked.text);
  assert.deepEqual(liked.data.results.map((entry) => [entry.id, entry.creator]), [["yt:r60ok-Za8cg", "Apex"]]);
  // "no" is the person's: the agent cannot press it.
  const no = { topic: "soundtrack", name: "no yt:r60ok-Za8cg" };
  assert.equal((await agent("library", no)).isError, true);
  const said = await server.api("/api/dashboard/act/library", { method: "POST", headers: { "x-kino-review": key }, body: { project: "sounds", ...no } });
  assert.match((await said.json()).text, /No to Never Knew/);
  const taste = JSON.parse(await readFile(path.join(server.dataDirectory, "song-taste.json"), "utf8"));
  assert.deepEqual([taste.liked.map((entry) => entry.id), taste.rejected.map((entry) => entry.id)], [[`openverse:${RAIN}`], ["yt:r60ok-Za8cg"]]);
  // The music tab shows both marks: the person's calls are saved in the project's list too.
  const { candidates } = JSON.parse(await readFile(path.join(server.dataDirectory, "agent", "projects", "sounds.json"), "utf8")).soundtrack;
  assert.deepEqual(candidates.filter((entry) => entry.picked || entry.rejected).map((entry) => [entry.id, Boolean(entry.picked), Boolean(entry.rejected)]),
    [[`openverse:${RAIN}`, true, false], ["yt:r60ok-Za8cg", false, true]]);
  const imported = await agent("project", { action: "import", file: `openverse:${RAIN}` });
  assert.equal(imported.isError, undefined, imported.text);
  assert.match(imported.text, /credit kept with the file: "Rain on a roof" by someone \(https:\/\/freesound\.org\/[^)]+\), CC0 1\.0/);
  const refused = await agent("project", { action: "import", file: "yt:dQw4w9WgXcQ" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /reference only.*one of this video's measured songs/);
});

test("Freesound with a key: its results join Openverse's (token header, previews, never NC); no key, no request", async () => {
  const asked = [];
  const answer = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
  const fetch = async (url, options) => {
    asked.push({ url: String(url), auth: options.headers.authorization });
    if (String(url).includes("freesound")) return answer({ results: [
      { id: 7, name: "Card slide", username: "maker", license: "https://creativecommons.org/licenses/by/4.0/", duration: 0.8, url: "https://freesound.org/s/7/", previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/7-hq.mp3" } },
      { id: 8, name: "Card slide NC", username: "maker", license: "https://creativecommons.org/licenses/by-nc/4.0/", duration: 0.8, previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/8-hq.mp3" } }] });
    return answer({ result_count: 0, results: [] });
  };
  let key = null;
  const search = createSoundSearch({ enabled: () => true, fetch, addMedia: async () => null, freesoundKey: () => key });
  assert.equal((await search.search("card slide")).freesound, false);
  assert.equal(asked.length, 1, "Openverse only");
  key = "abcdef123456";
  const found = await search.search("card slide");
  assert.deepEqual(found.results.map((entry) => [entry.id, entry.license]), [["freesound:7", "CC BY"]]);
  assert.equal(asked.at(-1).auth, "Token abcdef123456");
  assert.equal(freesoundLicense("http://creativecommons.org/publicdomain/zero/1.0/"), "cc0");
});

test("sound ranking: junk titles out, the closest to the words first, taste, near-duplicates folded", () => {
  assert.equal(junkSound("100 Whoosh Sound Effects Pack", { words: "soft whoosh" }), "compilation");
  assert.equal(junkSound("Vine Boom EARRAPE", { words: "impact hit" }), "meme");
  assert.equal(junkSound("City ambience 1 hour", { words: "phone screen tap" }), "long");
  assert.equal(junkSound("Sci-fi laser whoosh", { words: "soft whoosh" }), "sci-fi");
  assert.equal(junkSound("Sci-fi laser whoosh", { words: "sci-fi laser" }), null);
  assert.equal(junkSound("Paper whoosh", { words: "soft whoosh card slide", seconds: 1.2 }), null);
  assert.equal(sfxPrompt("soft whoosh card slide"), "the sound of a soft whoosh card slide");
  const v = (...values) => normalize(Float32Array.from(values));
  const entries = [
    { id: "a", title: "A", vector: v(1, 0, 0, 0.1) }, { id: "a2", title: "A again", vector: v(1, 0, 0, 0.1) },
    { id: "b", title: "B", vector: v(0, 1, 0, 0) }, { id: "c", title: "C", vector: v(0, 0, 1, 0) }, { id: "d", title: "not measured" },
  ];
  const plain = rankSounds(entries, { query: v(1, 0.2, 0, 0) });
  assert.deepEqual(plain.map((row) => row.id), ["a", "b", "c", "d"], "a2 folds into a; unmeasured last");
  assert.deepEqual([plain[0].match, plain[0].alike, plain[3].match], [87, ["a2"], null], "half absolute, half against the pool: not 100");
  // A hit asked: a clean single sound beats a long clip of several hits, even one matching closer.
  const hits = rankSounds([{ id: "clip", title: "clip", vector: v(1, 0, 0, 0), seconds: 9, onsets: 4 }, { id: "one", title: "one", vector: v(0.9, 0.3, 0, 0), seconds: 0.6, onsets: 1 }], { query: v(1, 0, 0, 0), words: "soft whoosh" });
  assert.deepEqual(hits.map((row) => [row.id, row.why ?? ""]), [["one", ""], ["clip", "9 s long, 4 hits"]]);
  assert.deepEqual([askedShape("crowd cheer short"), askedShape("phone screen tap")], [{ hit: false, short: true }, { hit: true, short: true }]);
  // Onsets: three separate bursts are 3 hits; one swell is 1.
  const burst = [0, 0, 0, 0, 0, 0, 1, 0.9, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  assert.deepEqual([countOnsets(burst, 1), countOnsets([0.1, 0.3, 0.6, 1, 0.7, 0.4, 0.2], 1)], [3, 1]);
  // The person said no to a and used one like c: c leads.
  const taste = { liked: [{ id: "x", title: "X", embedding: { model: "m", vector: encodeVector(v(0, 0, 1, 0.05)) } }], rejected: [{ id: "a", title: "A", embedding: { model: "m", vector: encodeVector(v(1, 0, 0, 0.1)) } }] };
  const mine = rankSounds(entries.map((entry) => ({ ...entry })), { query: v(1, 0.2, 0, 0), taste, model: "m" });
  // The words come first (70%); between two sounds that miss them, taste decides (c like the used X over b).
  assert.deepEqual(mine.map((row) => row.id), ["a2", "c", "b", "d"], "a (said no) sinks and folds into a2");
  assert.match(mine[0].why, /near rejected A/);
  assert.equal(mine[1].why, "like X");
});
