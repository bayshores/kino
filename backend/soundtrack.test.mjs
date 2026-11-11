// Soundtrack search (backend/soundtrack.mjs): Openverse and Archive answer parsing from fixtures, the
// loudness sections and the comparison against story beats on a made-up curve, and the refusal
// to import a reference-only song. No network, no sound played.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSongTaste, rankSongs, storyScore, tasteEntry, tasteScore, tempoCloseness } from "./songTaste.mjs";
import { createMusicEmbed, decodeVector, encodeVector, songWindows } from "./music-embed.mjs";
import { attackNear, createSongShapeCache, joinSpans, songShape, sungSegments, vocalShare } from "./song-shape.mjs";
import { songKey as clientSongKey } from "../frontend/dashboard/inspireView.js";
import { catalogQuery, compareToStory, createSoundtrack, energyCurve, archiveQuery, exploreLanes, importableId, junkTitle, keepCandidates, licenseTag, namedSong, parseRecordings, parseTagRecordings, pickRecording, licenseFromUrl, parseArchiveFiles, parseArchiveSearch, parseOpenverseMusic, previewStretch, SONG_KEY, songKey, SOUNDTRACK_LIMITS, songSections, youtubeCandidates } from "./soundtrack.mjs";

test("Openverse music: usable licenses and songs of 20 s or more, with a credit line", async () => {
  const body = JSON.parse(await readFile(new URL("../tests/fixtures/soundtrack/openverse-music.json", import.meta.url), "utf8"));
  const found = parseOpenverseMusic(body);
  assert.deepEqual(found.map((entry) => entry.title), ["Rising Lights", "Open Road"], "no NC license, no 4 s blip");
  assert.equal(found[0].id, "openverse:1f2e3d4c-0000-4000-8000-000000000001");
  assert.equal(found[0].license, "CC BY 4.0");
  assert.equal(found[0].seconds, 132);
  assert.equal(found[0].provider, "jamendo");
  assert.equal(found[0].filetype, "mp3", "Jamendo's mp32 label is an mp3");
  assert.equal(found[0].credit, '"Rising Lights" by Ana Ruiz (https://www.jamendo.com/track/1), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)');
  assert.equal(found[1].id, "openverse:1f2e3d4c-0000-4000-8000-000000000004", "ids are lowercase");
  assert.equal(found[1].filetype, "ogg", "the type comes from the file name when Openverse has none");
  assert.equal(found[1].license, "CC0 1.0");
  assert.deepEqual(parseOpenverseMusic({ nothing: true }), []);
});

test("Archive music: CC BY, BY-SA, CC0 and public domain items only; one candidate per song, the largest mp3 under the limit, 20 s or more", async () => {
  const search = JSON.parse(await readFile(new URL("../tests/fixtures/soundtrack/archive-search.json", import.meta.url), "utf8"));
  const files = JSON.parse(await readFile(new URL("../tests/fixtures/soundtrack/archive-files.json", import.meta.url), "utf8"));
  const items = parseArchiveSearch(search);
  assert.deepEqual(items.map((item) => item.identifier), ["nullbomb", "JOAT022", "breaknorth"], "no NC, no ND, no item without a license");
  assert.deepEqual([items[0].creator, items[1].license], ["unknown", "CC BY-SA 3.0"]);
  const joat = parseArchiveFiles(items[1], files.JOAT022, "winter build");
  assert.deepEqual(joat.map((entry) => entry.title), ["Winter I", "Winter II (Safe Passage)", "Spring I", "Spring II"], "titles with a word first, then track order; the 16 MB song is left out");
  assert.deepEqual([joat[0].id, joat[0].source, joat[0].seconds, joat[0].filetype, joat[0].creator], ["archive:JOAT022/10WinterI.mp3", "archive", 165, "mp3", "Memphis"]);
  assert.equal(joat[0].url, "https://archive.org/download/JOAT022/10WinterI.mp3");
  assert.equal(joat[0].credit, '"Winter I" by Memphis (from "The Four Seasons", https://archive.org/details/JOAT022), CC BY-SA 3.0 (http://creativecommons.org/licenses/by-sa/3.0/)');
  const breaknorth = parseArchiveFiles(items[2], files.breaknorth);
  assert.deepEqual(breaknorth.map((entry) => [entry.id, entry.seconds]), [["archive:breaknorth/breaknorth.mp3", 439]], "three mp3s of one wav are one song (07:19)");
  const short = { result: [{ name: "sting.mp3", format: "VBR MP3", source: "original", length: "12.5", size: "200000" }, { name: "a b/c.mp3", format: "VBR MP3", source: "original", length: "61", size: "900000" }] };
  assert.deepEqual(parseArchiveFiles(items[0], short).map((entry) => [entry.id, entry.url]), [["archive:nullbomb/a%20b%2Fc.mp3", "https://archive.org/download/nullbomb/a%20b/c.mp3"]], "no 12 s sting; a folder and a space are safe in the id");
  const swears = { result: [{ name: "Fuck Winter Mix 1.mp3", format: "VBR MP3", source: "original", length: "61", size: "900000" }, ...short.result.slice(1)] };
  assert.equal(parseArchiveFiles(items[0], swears).length, 1, "a title that swears is left out (the Archive marks nothing explicit)");
  assert.equal(parseArchiveSearch({ response: { docs: [{ ...search.response.docs.find((doc) => doc.identifier === "breaknorth"), title: "Shit Mix" }] } }).length, 0);
  assert.match(archiveQuery("driving electronic build, 120 bpm"), /^collection:netlabels AND mediatype:audio AND \(title:\(driving OR electronic OR build\) OR subject/);
  assert.ok(!/by-nc|by-nd/.test(archiveQuery("x")), "the search asks for usable licenses only");
  assert.deepEqual(parseArchiveSearch({ error: "[BACKEND_ERROR] Invalid or no response from Elasticsearch" }), []);
  assert.equal(songKey("archive:nullbomb/a%20b%2Fc.mp3"), "ia-nullbomb_a_20b_2Fc_mp3");
  // A shell keeps the id whole (no parentheses or quotes); a name too long to read back is left out;
  // two long names in one item keep their own previews, named as the inspire screen names them.
  const odd = { result: ["01 Don't (Original Mix).mp3", `${"long name ".repeat(15)}A.mp3`, `${"long name ".repeat(15)}B.mp3`, `${"\u00e9".repeat(50)}.mp3`]
    .map((name) => ({ name, format: "VBR MP3", source: "original", length: "61", size: "900000" })) };
  const oddIds = parseArchiveFiles(items[0], odd).map((entry) => entry.id);
  assert.deepEqual([oddIds.length, oddIds[0]], [3, "archive:nullbomb/01%20Don%27t%20%28Original%20Mix%29.mp3"]);
  const keys = oddIds.map(songKey);
  assert.ok(keys.every((key) => SONG_KEY.test(key)) && new Set(keys).size === 3 && keys[1].length <= 123);
  assert.deepEqual(oddIds.map(clientSongKey), keys);
  assert.ok(SONG_KEY.test(songKey(joat[0].id)) && !SONG_KEY.test("ia-../x"));
  assert.equal(importableId(joat[0].id, joat), joat[0]);
  assert.equal(importableId("archive:JOAT022/nothing.mp3", joat), null);
  assert.deepEqual(["by-nc/4.0", "by-nd/4.0", "by-nc-sa/3.0", "sampling+/1.0", "by-sa/3.0"].map((tail) => licenseFromUrl(`http://creativecommons.org/licenses/${tail}/`)?.license ?? null),
    ["by-nc", "by-nd", "by-nc-sa", null, "by-sa"]);
  assert.equal(licenseFromUrl("https://creativecommons.org/publicdomain/mark/1.0/").license, "pdm");
});

test("sections and comparison: the drop lands on the payoff, energy is read per beat", () => {
  // 60 s: quiet intro (20), a build from 20 s to 30 s, a drop at 30 s (90), a break at 45 s (20).
  const curve = Array.from({ length: 60 }, (_, t) => (t < 20 ? 20 : t < 30 ? 20 + (t - 20) * 3 : t < 45 ? 90 : 20));
  const sections = songSections(curve);
  const drop = sections.find((entry) => entry.kind === "drop");
  assert.ok(drop && drop.at >= 28 && drop.at <= 31, JSON.stringify(sections));
  assert.ok(sections.some((entry) => entry.kind === "build" && entry.at < drop.at));
  assert.ok(sections.some((entry) => entry.kind === "break" && entry.at >= 45 && entry.at <= 47));

  const measure = { seconds: 60, bpm: 120, energy: curve, sections: [{ at: 30, kind: "drop" }, { at: 45, kind: "break" }] };
  const beats = [{ from: 0, to: 6 }, { from: 6, to: 12 }, { from: 12, to: 20 }];
  const fit = compareToStory(measure, { beats, length: 20 });
  assert.equal(fit.payoff, 12);
  assert.equal(fit.start, 18, "the song starts 18 s in so its drop at 30 s lands at 12 s");
  assert.equal(fit.dropAt, 12);
  assert.equal(fit.dropOff, 0);
  assert.deepEqual(fit.beats.map((beat) => beat.energy), [23, 40, 90]);
  assert.equal(fit.rise, 67);
  assert.equal(fit.short, 0);
  assert.deepEqual(fit.breaks, []);
  // A video longer than what is left of the song: kino says how short it is.
  const long = compareToStory(measure, { beats: [], length: 80 });
  assert.equal(long.start, 0);
  assert.equal(long.short, 20);
});

test("energy curve: 0 to 100 per second, the loudest second is 100", () => {
  const rate = 100;
  const samples = new Float32Array(300);
  for (let i = 0; i < 300; i += 1) samples[i] = (i < 100 ? 0.01 : i < 200 ? 0.5 : 0) * Math.sin(i);
  const curve = energyCurve(samples, rate, 1);
  assert.equal(curve.length, 3);
  assert.equal(curve[1], 100);
  assert.ok(curve[0] > 0 && curve[0] < 50);
  assert.equal(curve[2], 0);
});

test("a YouTube song is a candidate with no license claimed or shown; only the video's candidates import", () => {
  const [song] = youtubeCandidates([{ id: "yt:dQw4w9WgXcQ", title: "Epic trailer music", channel: "x", duration: 150, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]);
  assert.deepEqual([song.license, song.use, licenseTag(song), licenseTag({ license: "license unknown" }), licenseTag({ license: "CC BY 4.0" })], [null, undefined, "", "", " · CC BY 4.0"]);
  assert.equal(importableId("yt:dQw4w9WgXcQ", [song]), song);
  assert.equal(importableId("yt:aaaaaaaaaaa", [song]), null);
  const licensed = { id: "openverse:1f2e3d4c-0000-4000-8000-000000000001", source: "openverse" };
  assert.equal(importableId("openverse:1F2E3D4C-0000-4000-8000-000000000001", [licensed]), licensed);
  assert.equal(importableId("openverse:1f2e3d4c-0000-4000-8000-000000000009", [licensed]), null, "not a candidate: library sounds handles it");
});

test("song search keeps songs only, once each, and a video keeps its measured songs", () => {
  const row = (id, title) => ({ id: `yt:${id.padEnd(11, "x")}`, title, channel: "c", duration: 200 });
  const found = youtubeCandidates([row("a", "Artist - Song (Official Video)"), row("b", "Artist - Song [Lyrics]"), row("c", "Artist - Song ALBUM REVIEW"),
    row("d", "Artist - Song (Live at Boiler Room)"), row("e", "Artist - Song"), row("f", "Artist - Song (Remix)"), { ...row("g", "Best of Artist"), duration: 4000 }], "artist song");
  assert.deepEqual(found.map((entry) => entry.title), ["Artist - Song (Official Video)", "Artist - Song (Remix)"]);
  assert.equal(youtubeCandidates([row("d", "Artist - Song (Live at Boiler Room)")], "artist song live").length, 1, "asked for live");
  const list = [{ id: "m", measure: {} }, ...Array.from({ length: 5 }, (_, i) => ({ id: `u${i}` })), { id: "n", note: {} }];
  assert.deepEqual(keepCandidates(list, 4).map((entry) => entry.id), ["m", "u3", "u4", "n"]);
  const full = [{ id: "r", measure: {}, rejected: true }, { id: "m", measure: {} }, { id: "q1", queued: true }, { id: "q2", queued: true }];
  assert.deepEqual(keepCandidates(full, 3).map((entry) => entry.id), ["m", "q1", "q2"], "a rejected song makes room for queued ones");
});

test("a measured song keeps a preview: the whole song when short, 90 s from its build when long; only the newest 24 stay", async () => {
  assert.deepEqual(previewStretch(60, []), { from: 0, seconds: 60 });
  assert.deepEqual(previewStretch(200, [{ at: 100, kind: "build" }, { at: 110, kind: "drop" }]), { from: 95, seconds: 90 });
  assert.deepEqual(previewStretch(200, [{ at: 195, kind: "drop" }]), { from: 110, seconds: 90 }, "never past the end");
  assert.deepEqual(previewStretch(200, []), { from: 0, seconds: 90 });
  const directory = await mkdtemp(path.join(tmpdir(), "kino-test-songs-"));
  try {
    const stretches = [];
    const soundtrack = createSoundtrack({
      directory, enabled: () => true,
      downloadYouTube: async (id, folder) => { const file = path.join(folder, "song.webm"); await writeFile(file, id); return file; },
      decode: async () => ({ samples: new Float32Array(100 * 30).fill(0.5), sampleRate: 100 }),
      analyze: () => ({ bpm: 120, confidence: 1, beats: [] }),
      preview: async (file, target, { start, end }) => { stretches.push([start, end]); await writeFile(target, "m4a"); },
      embed: async (samples, rate) => ({ model: "m", vector: encodeVector([samples.length / rate, 0]) }),
    });
    const ids = Array.from({ length: SOUNDTRACK_LIMITS.previews + 1 }, (_, n) => `yt:song${String(n).padStart(7, "0")}`);
    for (const id of ids) assert.deepEqual((await soundtrack.measure({ id, source: "youtube" })).preview, { from: 0, seconds: 30 });
    assert.deepEqual(stretches[0], [0, 30]);
    assert.deepEqual([...decodeVector((await soundtrack.measure({ id: ids[0], source: "youtube" })).embedding.vector)], [30, 0], "the song's embedding is kept with it");
    assert.equal((await readdir(path.join(directory, "songs"))).length, SOUNDTRACK_LIMITS.previews);
    assert.equal(soundtrack.songFile(ids.at(-1)), path.join(directory, "songs", `yt-${ids.at(-1).slice(3)}.m4a`));
    assert.equal(soundtrack.songFile("yt-../../x"), null);
    // A song measured before embeddings gets one from its kept preview; none without a preview.
    assert.deepEqual([...decodeVector((await soundtrack.embedSaved(ids.at(-1))).vector)], [30, 0]);
    assert.equal(await soundtrack.embedSaved("yt:nothing0000"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("more like a song: YouTube's mix for it, filtered like a search, without the seed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-mix-"));
  const asked = [];
  const row = (id, title, channel = "Artist - Topic") => ({ id: `yt:${id.padEnd(11, "x")}`, title, channel, duration: 190 });
  const soundtrack = createSoundtrack({ directory, enabled: () => false, mixYouTube: async (videoId) => {
    asked.push(videoId);
    return [row("seed", "Seed song"), row("a", "Never Knew"), row("b", "Never Knew (Live)"), row("c", "Flights", "Release")];
  } });
  try {
    const found = await soundtrack.mix("yt:seedxxxxxxx");
    assert.deepEqual(found.map((entry) => [entry.title, entry.creator]), [["Never Knew", "Artist"], ["Flights", "Release"]]);
    await soundtrack.mix("yt:seedxxxxxxx");
    assert.deepEqual(asked, ["seedxxxxxxx"], "cached for a day");
    await assert.rejects(soundtrack.mix("openverse:x"), /like is a YouTube song id/);
    // Two of the same search at once (two agents) both answer: each writes the cache under its own temporary name.
    const both = await Promise.all([soundtrack.mix("yt:twicexxxxxx"), soundtrack.mix("yt:twicexxxxxx")]);
    assert.equal(both[0].length, 3);
    assert.deepEqual(both[1], both[0]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("taste and fit: likes and rejects kept in one file; tempo close at half or double; vocals over speech count against", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-taste-"));
  try {
    const taste = createSongTaste({ file: path.join(directory, "song-taste.json") });
    const song = (id, bpm, extra = {}) => ({ id, title: id, creator: "c", source: "youtube", measure: { bpm, energy: [40, 60, 80], sections: [], ...extra } });
    await taste.reject(song("yt:likedxxxxx", 90));
    await taste.like(song("yt:likedxxxxx", 125));
    const saved = await taste.like(song("yt:otherxxxxx", 124));
    assert.deepEqual([saved.liked.map((entry) => [entry.id, entry.bpm]), saved.rejected.length], [[["yt:otherxxxxx", 124], ["yt:likedxxxxx", 125]], 0], "newest first; a like leaves the rejects");
    assert.deepEqual(await taste.read(), saved);
    assert.deepEqual([tempoCloseness(125, 125), tempoCloseness(62.5, 125), tempoCloseness(250, 125), tempoCloseness(80, 125)], [1, 1, 1, 0]);
    const quiet = { energy: [5, 5, 5] };
    const kept = { liked: saved.liked, rejected: [tasteEntry(song("yt:slowxxxxxxx", 70, quiet))] };
    assert.ok(tasteScore(song("yt:newxxxxxxxx", 62), kept).score > 90, "half time of a liked song");
    assert.ok(tasteScore(song("yt:newxxxxxxxx", 71, quiet), kept).score < 10, "like the rejected one, far from the likes");
    assert.deepEqual([tasteScore(song("yt:otherxxxxx", 90), kept).score, tasteScore(song("yt:slowxxxxxxx", 124), kept).score], [100, 0], "the person's own verdict wins");
    // Story: the drop on the payoff; sung vocals over the spoken line lower the fit.
    const energy = Array.from({ length: 20 }, (_, t) => (t < 10 ? 30 : 90));
    const measure = { bpm: 124, seconds: 20, energy, sections: [{ at: 10, kind: "drop" }] };
    const comparison = compareToStory(measure, { beats: [{ from: 0, to: 4 }, { from: 4, to: 8 }], length: 8 });
    const clear = storyScore({ ...measure, vocals: [[2, 5]] }, comparison, { spoken: [[0, 3]], length: 8 });
    const sung = storyScore({ ...measure, vocals: [[6, 9]] }, comparison, { spoken: [[0, 3]], length: 8 });
    assert.ok(clear.drop >= 0.75 && clear.rise >= 0.8 && clear.clash === 0, JSON.stringify(clear));
    assert.ok(sung.clash >= 0.25 && sung.score < clear.score - 10, `${clear.score} vs ${sung.score}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ranking over song embeddings: centered taste, lanes, two rejects exclude a lane, the brief, spread fits, a varied shortlist", () => {
  // 6 numbers a song: a shared part (as CLAP's songs all have) plus its lane's direction.
  const axis = (n, w = 1) => Array.from({ length: 6 }, (_, i) => (i === n ? w : 0));
  const sound = (lane, wobble = 0) => ({ model: "m", vector: encodeVector(axis(5, 2).map((value, i) => value + axis(lane)[i] + (i === 4 ? wobble : 0))) });
  const lanes = ["house", "cinematic", "hip-hop", "ambient"].map((id, n) => ({ id, vector: Float32Array.from(axis(n)) }));
  const flat = { energy: Array(30).fill(50), sections: [] };
  const song = (id, lane, wobble) => ({ id, title: id, measure: { ...flat, embedding: sound(lane, wobble) } });
  const songs = [song("house1", 0, 0.1), song("house2", 0, -0.1), song("film1", 1, 0.1), song("film2", 1, -0.1), song("beat1", 2, 0.1), song("beat2", 2, -0.1), { id: "plain", title: "plain", measure: { ...flat, bpm: 120 } }];
  const entry = (id, lane) => tasteEntry({ id, title: id, measure: { embedding: sound(lane) } });
  const taste = { liked: [entry("liked", 0)], rejected: [entry("no1", 1), entry("no2", 1)] };
  const options = { taste, compare: (measure) => compareToStory(measure, { beats: [], length: 10 }), length: 10, lanes, model: "m" };
  const fit = Object.fromEntries(rankSongs(songs, options).map((item) => [item.id, item.fit]));
  assert.deepEqual(Object.values(fit).map((item) => item.lane), ["house", "house", "cinematic", "cinematic", "hip-hop", "hip-hop", null]);
  assert.match(fit.film1.why, /^cinematic, you said no to 2 cinematic songs/);
  assert.ok(fit.house1.fit > fit.beat1.fit && fit.beat1.fit > fit.film1.fit, JSON.stringify(fit));
  assert.ok(fit.house1.fit - fit.film1.fit >= 40, "fits spread out");
  assert.equal(fit.house1.order, 1);
  assert.ok(fit.beat1.order < fit.house2.order, "the next pick is another lane before the other house song");
  assert.ok(fit.film1.order >= 6 && fit.film2.order >= 6, "an excluded lane ranks last");
  assert.deepEqual([fit.plain.taste, fit.plain.lane], [null, null], "no embedding and nothing to compare: no taste, no lane");
  // The brief: want scores, each "not" subtracts on its own.
  const brief = (want, not = []) => Object.fromEntries(rankSongs(songs, { ...options, taste: {}, brief: { want: Float32Array.from(axis(want)), not: not.map((n) => Float32Array.from(axis(n))) } }).map((item) => [item.id, item.fit]));
  const beats = brief(2);
  assert.ok(beats.beat1.fit > beats.house1.fit && beats.beat1.fit > beats.film1.fit, JSON.stringify(beats));
  assert.match(beats.beat1.why, /matches the brief/);
  const notBeats = brief(0, [2]);
  assert.ok(notBeats.beat1.fit < notBeats.film1.fit, "not hip-hop pushes those down");
});

test("song embeddings: float16 round trip, 3 windows at 48 kHz, and a model that cannot load says so once", async () => {
  const vector = [0.5, -0.25, 0.125, 0];
  assert.deepEqual([...decodeVector(encodeVector(vector))], vector);
  assert.deepEqual(songWindows(new Float32Array(22050 * 40), 22050).map((window) => window.length), [480000, 480000, 480000]);
  const off = createMusicEmbed({ load: async () => { throw new Error("no network"); } });
  assert.equal(await off.audio(new Float32Array(100), 100), null);
  assert.equal(await off.text(["house"]), null);
  assert.match(off.notice(), /song embeddings are off \(no network\)/);
  assert.equal(off.notice(), null, "said once");
  // A stub model: each window's vector is its length; text vectors are cached on disk by prompt.
  const directory = await mkdtemp(path.join(tmpdir(), "kino-embed-"));
  let texts = 0;
  const fake = { from_pretrained: async () => fakeNet };
  const fakeNet = Object.assign(async (input) => (input.texts ? (texts += 1, { text_embeds: { data: new Float32Array(512 * input.texts.length).fill(1) } }) : { audio_embeds: { data: new Float32Array(512).fill(input.size) } }),
    { from_pretrained: async () => fakeNet });
  const load = async () => ({ AutoProcessor: { from_pretrained: async () => async (window) => ({ size: window.length }) }, AutoTokenizer: { from_pretrained: async () => (list) => ({ texts: list }) },
    ClapAudioModelWithProjection: fake, ClapTextModelWithProjection: fake });
  try {
    const on = createMusicEmbed({ modelDir: directory, load });
    const song = await on.audio(new Float32Array(48000 * 30), 48000);
    assert.equal(song.model, "Xenova/clap-htsat-unfused");
    assert.ok(Math.abs(decodeVector(song.vector)[0] - 1 / Math.sqrt(512)) < 1e-3, "normalized");
    await on.text(["house", "lo-fi"]);
    await createMusicEmbed({ modelDir: directory, load }).text(["house"]);
    assert.equal(texts, 1, "a cached prompt needs no model");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("song shape: the kick and bass coming in is a drop, leaving at the end an outro; kicks on every beat are four-on-the-floor", () => {
  const rate = 8000;
  const samples = new Float32Array(rate * 48);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    samples[i] = 0.1 * Math.sin(2 * Math.PI * 600 * t);
    const sinceKick = t % 0.5; // 120 bpm
    if (t >= 16 && t < 36) samples[i] += 0.8 * Math.exp(-sinceKick * 12) * Math.sin(2 * Math.PI * 60 * t);
  }
  const shape = songShape(samples, rate, { bpm: 120 });
  const drop = shape.sections.find((part) => part.kind === "drop");
  assert.ok(drop && Math.abs(drop.at - 16) <= 1 / 30 && drop.weight > 0.5, JSON.stringify(shape.sections));
  assert.ok(shape.sections.some((part) => part.kind === "outro" && Math.abs(part.at - 36) <= 1), JSON.stringify(shape.sections));
  assert.equal(shape.features.groove, "four-on-the-floor");
  assert.ok(songShape(samples, rate, { bpm: 120, whole: false }).sections.some((part) => part.kind === "break"), "a cut-off song has no outro");
  // A one-beat stop before the drop: a dropout, and the sound coming back is the drop's one cue (no return beside it).
  const stopped = samples.map((value, i) => (i >= 15.5 * rate && i < 16 * rate ? 0 : value));
  const { sections, seams } = songShape(stopped, rate, { bpm: 120 });
  const hit = sections.find((part) => part.kind === "drop");
  assert.ok(hit && Math.abs(hit.at - 16) <= 1 / 30, JSON.stringify(sections));
  assert.ok(seams.some((seam) => seam.kind === "dropout" && Math.abs(seam.at - 15.5) <= 1 / 30), JSON.stringify(seams));
  assert.ok(!seams.some((seam) => Math.abs(seam.at - hit.at) < 0.05), JSON.stringify(seams));
});

// 56 s at 8 kHz: kicks at 120 bpm under a tone, the highs filtered out 14 to 22 s, a one-beat stop
// at 30 s, a voice 35.3 to 40 s, the kicks switching to every 0.75 s from 46.25 s.
function seamSong(rate = 8000) {
  const samples = new Float32Array(rate * 56);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    if (t >= 30 && t < 30.5) continue; // the one-beat stop
    // Kicks every 0.5 s to 45.5, then every 0.75 s from 46.25 (the switch).
    const since = t < 46.25 ? t - Math.min(45.5, Math.floor(t * 2) / 2) : (t - 46.25) % 0.75;
    let value = 0.1 * Math.sin(2 * Math.PI * 600 * t) + 0.8 * Math.exp(-since * 12) * Math.sin(2 * Math.PI * 60 * t);
    if (t < 14 || t >= 22) value += 0.05 * Math.sin(2 * Math.PI * 3000 * t); // filtered out 14 to 22
    if (t >= 35.3 && t < 40) value += 0.15 * (Math.sin(2 * Math.PI * 400 * t) + Math.sin(2 * Math.PI * 800 * t));
    samples[i] = value;
  }
  return samples;
}

test("song seams: a filter return, a one-beat stop and its return, a voice coming in and a beat switch, each within one video frame", () => {
  const rate = 8000;
  const samples = seamSong(rate);
  const { seams } = songShape(samples, rate, { bpm: 120, vocals: [[35, 40]] });
  const expected = [[22, "return"], [30, "dropout"], [30.5, "return"], [35.3, "vocal-in"], [46.25, "switch"]];
  assert.deepEqual(seams.map((seam) => seam.kind), expected.map(([, kind]) => kind), JSON.stringify(seams));
  for (const [index, [at]] of expected.entries()) assert.ok(Math.abs(seams[index].at - at) <= 1 / 30, JSON.stringify(seams[index]));
  assert.ok(seams.every((seam) => seam.weight > 0 && seam.weight <= 1));
  assert.ok(!songShape(samples, rate, { bpm: 120 }).seams.some((seam) => seam.kind === "vocal-in"), "no vocal-in without whisper's spans");
});

// 120 bpm (a bar is 2 s) under a steady tone: kicks from 16 s on, the kicks (and bass) stopping for the
// last half of bar 14 (29 to 30 s) while the tone plays on, and the sound ending at `end` (`fade`: a
// 6 s fade before it).
function barSong({ end = 48, fade = 0, rate = 8000 } = {}) {
  const samples = new Float32Array(rate * 48);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    if (t >= end) continue;
    let value = 0.1 * Math.sin(2 * Math.PI * 600 * t);
    if (t >= 16 && !(t >= 29 && t < 30)) value += 0.8 * Math.exp(-(t % 0.5) * 12) * Math.sin(2 * Math.PI * 60 * t);
    samples[i] = value * (fade && t > end - fade ? (end - t) / fade : 1);
  }
  return samples;
}
const steady = (seconds = 48) => ({ duration: seconds, bpm: 120, period: 0.5, beats: Array.from({ length: seconds * 2 }, (_, i) => i * 0.5) });

test("song bars: a one-bar stop where a tone plays on is out, the loudest bar is 0 dB, and sections and seams carry their bar", () => {
  const { bars, sections, seams } = songShape(barSong(), 8000, { bpm: 120, beats: steady() });
  assert.equal(bars.lines.length, 24);
  assert.deepEqual(bars.out.filter((bar) => bar >= 8), [14], "in the kicks, only the stop is out");
  assert.ok(bars.out.includes(2) && !bars.out.includes(bars.last.bar), "the bars before the kicks are out, the last bar never");
  assert.equal(bars.voice, undefined, "no per-bar voice");
  assert.equal(Math.max(...bars.low), 0);
  assert.equal(Math.max(...bars.all), 0);
  const drop = sections.find((part) => part.kind === "drop");
  assert.ok(drop && drop.bar === 8 && Math.abs(drop.at - 16) <= 1 / 30, JSON.stringify(sections));
  assert.ok(seams.every((seam) => Number.isInteger(seam.bar)));
  assert.equal(songShape(barSong(), 8000, { bpm: 120 }).bars, undefined, "no beat analysis, no bars");
});

test("song bars: the hit on a bar line is its attack to 2 ms, and a line with no hit is null", () => {
  const rate = 8000;
  const samples = new Float32Array(rate * 20);
  // A quiet tone, and a 5 ms burst on the bar lines at 2, 4, 6, 8 and 10 s (not on 0 or 12 s), each 10 ms late.
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.01 * Math.sin(2 * Math.PI * 300 * (i / rate));
  const bursts = [2, 4, 6, 8, 10];
  for (const line of bursts) {
    for (let i = 0; i < 0.005 * rate; i += 1) samples[Math.round((line + 0.01) * rate) + i] += 0.8 * Math.sin(2 * Math.PI * 1000 * (i / rate)) * (1 - i / (0.005 * rate));
  }
  for (const line of bursts) assert.ok(Math.abs(attackNear(samples, rate, line) - (line + 0.01)) <= 0.002, `line ${line}: ${attackNear(samples, rate, line)}`);
  assert.equal(attackNear(samples, rate, 12), null, "no burst near the line");
  assert.equal(attackNear(samples, rate, 2.1), null, "a burst further than 35 ms from the line is not on it");
  const { bars } = songShape(barSong(), 8000, { bpm: 120, beats: steady() });
  assert.ok(bars.hits.length === 24 && bars.hits[2] === null && Math.abs(bars.hits[8] - 16) <= 0.02, JSON.stringify(bars.hits.slice(0, 10)));
});

test("song bars: the last bar with sound, and whether the song stops by itself or fades", () => {
  const own = songShape(barSong({ end: 40 }), 8000, { bpm: 120, beats: steady() }).bars.last;
  assert.deepEqual(own, { bar: 19, at: 38, ends: "own" });
  const faded = songShape(barSong({ end: 40, fade: 6 }), 8000, { bpm: 120, beats: steady() }).bars.last;
  assert.deepEqual([faded.bar, faded.ends], [19, "fade"]);
});

test("song shape cache: whisper's spans give a vocal-in seam kept in the .song; a failed whisper still keeps the seams and is tried again after 10 minutes", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-song-"));
  try {
    const samples = seamSong();
    let decodes = 0;
    let clock = 0;
    let fail = true;
    const decode = async () => { decodes += 1; return { samples, sampleRate: 8000 }; };
    const sung = createSongShapeCache({ decode, vocals: async () => [[35, 40]] });
    const file = path.join(folder, "song.mp3");
    const first = await sung.get(file, 120);
    assert.ok(first.version === 3 && first.vocals === "whisper" && first.seams.some((seam) => seam.kind === "vocal-in"), JSON.stringify(first));
    assert.deepEqual(JSON.parse(await readFile(`${file}.song`, "utf8")), first);
    assert.deepEqual(await sung.get(file, 120), first);
    assert.equal(decodes, 1, "the kept .song is read back, not measured again");

    const flaky = createSongShapeCache({ decode, now: () => clock, vocals: async () => { if (fail) throw new Error("whisper-cli failed: exit 3"); return [[35, 40]]; } });
    const other = path.join(folder, "other.mp3");
    const failed = await flaky.get(other, 120);
    assert.ok(failed.vocals === "failed" && failed.seams.some((seam) => seam.kind === "return") && !failed.seams.some((seam) => seam.kind === "vocal-in"), JSON.stringify(failed));
    clock = 60_000;
    assert.equal((await flaky.get(other, 120)).vocals, "failed", "not tried again within 10 minutes");
    [clock, fail] = [11 * 60_000, false];
    assert.ok((await flaky.get(other, 120)).seams.some((seam) => seam.kind === "vocal-in"), "tried again after 10 minutes");
    assert.equal(decodes, 3);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("song shape cache with the beat analysis: bars are kept in the .song, and a record without bars is measured again", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-song-"));
  try {
    let decodes = 0;
    const samples = barSong();
    const cache = createSongShapeCache({ decode: async () => { decodes += 1; return { samples, sampleRate: 8000 }; } });
    const file = path.join(folder, "song.mp3");
    assert.equal((await cache.get(file, 120)).bars, undefined, "a tempo alone gives no bars");
    const withBars = await cache.get(file, steady());
    assert.ok(withBars.version === 3 && withBars.bars.lines.length === 24 && withBars.sections.every((part) => Number.isInteger(part.bar)), JSON.stringify(withBars.bars));
    assert.deepEqual(JSON.parse(await readFile(`${file}.song`, "utf8")), withBars);
    assert.deepEqual(await cache.get(file, steady()), withBars);
    assert.deepEqual((await cache.get(file, 120)).bars, withBars.bars, "read back with a tempo, bars kept");
    assert.equal(decodes, 2, "measured for the tempo, again for the bars, then read back");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("vocal spans: whisper's sound labels and one-word guesses are not singing; near spans join", () => {
  const heard = sungSegments([{ from: 0, to: 4, text: "[Music]", p: 0.9 }, { from: 5, to: 9, text: "pull me out of this", p: 0.7 },
    { from: 10, to: 11, text: "Thank you.", p: 0.9 }, { from: 12, to: 14, text: "la la", p: 0.2 }]);
  assert.deepEqual(heard.map((segment) => segment.text), ["pull me out of this"]);
  assert.deepEqual(joinSpans([[5, 9], [10.5, 14], [30, 31]]), [[5, 14]], "a 1.5 s gap joins, a 1 s span is dropped");
  assert.equal(vocalShare([[5, 14]], 90), 10);
});

test("Openverse search: a slow answer keeps going into the cache for the same search again; a long ask that finds nothing tries its first two words", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-ov-"));
  const body = await readFile(new URL("../tests/fixtures/soundtrack/openverse-music.json", import.meta.url), "utf8");
  const asked = [];
  const answer = (json) => ({ ok: true, status: 200, json: async () => JSON.parse(json) });
  try {
    let answerLate;
    const slow = createSoundtrack({ directory, enabled: () => true, searchMs: 50, fetch: () => new Promise((resolve) => { answerLate = () => resolve(answer(body)); }) });
    const started = Date.now();
    const none = await slow.search("tense build", { source: "openverse" });
    assert.ok(Date.now() - started < 2000);
    assert.match(none.notes[0], /slow right now.*same search again/);
    answerLate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok((await slow.search("tense build", { source: "openverse" })).results.length > 0, "the search kept going and landed in the cache");
    const soundtrack = createSoundtrack({ directory: path.join(directory, "b"), enabled: () => true, fetch: async (url) => {
      const q = new URL(url).searchParams.get("q"); asked.push(q);
      return answer(q === "energetic electronic" ? body : '{"results":[]}');
    } });
    const found = await soundtrack.search("energetic electronic hype 120 bpm", { source: "openverse" });
    assert.deepEqual(asked, ["energetic electronic hype 120 bpm", "energetic electronic"]);
    assert.ok(found.results.length > 0);
    assert.match(found.notes[0], /these are for "energetic electronic"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("search with no source: Openverse and the Archive at once; a failed or slow Openverse puts the Archive first; source archive asks only it; an Archive import reads its license again", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-ia-"));
  const openverseBody = await readFile(new URL("../tests/fixtures/soundtrack/openverse-music.json", import.meta.url), "utf8");
  const searchBody = await readFile(new URL("../tests/fixtures/soundtrack/archive-search.json", import.meta.url), "utf8");
  const files = JSON.parse(await readFile(new URL("../tests/fixtures/soundtrack/archive-files.json", import.meta.url), "utf8"));
  const answer = (json) => ({ ok: true, status: 200, json: async () => JSON.parse(json) });
  // The Archive stub: the search, two items' file lists (nullbomb's is missing: that item is skipped).
  const archive = (url, searchAnswer = searchBody) => {
    const { pathname } = new URL(url);
    if (pathname === "/advancedsearch.php") return answer(searchAnswer);
    const item = /^\/metadata\/([^/]+)\/files$/.exec(pathname)?.[1];
    return files[item] ? answer(JSON.stringify(files[item])) : { ok: false, status: 404 };
  };
  const make = (folder, openverse, asked = [], searchAnswer) => createSoundtrack({ directory: path.join(directory, folder), enabled: () => true, searchMs: 2000, graceMs: 30,
    fetch: async (url) => { asked.push(new URL(url).host); return new URL(url).host === "archive.org" ? archive(url, searchAnswer) : openverse(); } });
  try {
    const failed = await make("a", async () => ({ ok: false, status: 504 })).search("driving electronic build");
    assert.deepEqual(failed.results.map((entry) => entry.id), ["archive:JOAT022/01SpringI.mp3", "archive:breaknorth/breaknorth.mp3", "archive:JOAT022/02SpringII.mp3"], "round by round: one track from each item, then a second");
    assert.deepEqual(failed.notes, ["YouTube: not available here.", "Openverse: Openverse answered 504."], "YouTube first");
    const started = Date.now();
    const slow = await make("b", () => new Promise(() => {})).search("driving electronic build");
    assert.ok(Date.now() - started < 1500, "the Archive answered, so Openverse got only the grace time");
    assert.equal(slow.results[0].source, "archive");
    assert.match(slow.notes.join("\n"), /Openverse is slow right now/);
    const iaSlow = createSoundtrack({ directory: path.join(directory, "f"), enabled: () => true, searchMs: 2000, graceMs: 30,
      fetch: async (url) => (new URL(url).host === "archive.org" ? new Promise(() => {}) : answer(openverseBody)) });
    const iaStarted = Date.now();
    const ovOnly = await iaSlow.search("driving electronic build");
    assert.ok(Date.now() - iaStarted < 1500 && ovOnly.results[0].source === "openverse", "Openverse answered, so the Archive got only the grace time");
    assert.match(ovOnly.notes.join("\n"), /Internet Archive is slow right now/);
    const both = await make("c", async () => answer(openverseBody)).search("driving electronic build");
    assert.deepEqual([...new Set(both.results.map((entry) => entry.source))], ["openverse", "archive"], "Openverse first when it answers");
    const asked = [];
    const only = await make("d", async () => answer(openverseBody), asked).search("driving electronic build", { source: "archive" });
    assert.deepEqual([[...new Set(asked)], only.results.length], [["archive.org"], 3]);
    const broken = await make("g", async () => answer(openverseBody), [], '{"error":"[BACKEND_ERROR] Invalid or no response from Elasticsearch"}').search("driving", { source: "archive" });
    assert.deepEqual([broken.results.length, broken.notes], [0, ["Internet Archive: Internet Archive search failed ([BACKEND_ERROR] Invalid or no response from Elasticsearch)."]]);
    await assert.rejects(make("e", async () => answer(openverseBody)).search("x", { source: "jamendo" }), /"openverse", "archive" or "youtube"/);

    // Import: the item's license is read again; the download may redirect to an archive.org file server only.
    let license = "http://creativecommons.org/licenses/by-sa/3.0/";
    let landed = "https://ia800100.us.archive.org/0/items/JOAT022/01SpringI.mp3";
    const added = [];
    const importer = createSoundtrack({ directory: path.join(directory, "h"), enabled: () => true, searchMs: 2000,
      addMedia: async (file, options) => { added.push(options); return { id: "m1", credit: options.extra.credit }; },
      fetch: async (url) => {
        if (new URL(url).pathname === "/metadata/JOAT022/metadata") return answer(JSON.stringify({ result: { licenseurl: license } }));
        return { ok: true, status: 200, url: landed, arrayBuffer: async () => new Uint8Array(8).buffer };
      } });
    const song = failed.results[0];
    await importer.importCandidate(song);
    assert.deepEqual([added[0].name, added[0].mime, added[0].extra.credit.line], ["Spring I.mp3", "audio/mpeg", song.credit]);
    landed = "https://elsewhere.example/01SpringI.mp3";
    await assert.rejects(importer.importCandidate(song), /elsewhere\.example, which kino does not download from/);
    license = "http://creativecommons.org/licenses/by-nc-sa/3.0/";
    landed = "https://ia800100.us.archive.org/0/items/JOAT022/01SpringI.mp3";
    await importer.importCandidate(song);
    assert.equal(added[1].extra.credit.license, "CC BY-NC-SA 3.0", "a changed license is kept as metadata, not a refusal");
    // A YouTube song comes in whole, its credit kept as metadata.
    const pulled = [];
    const tube = createSoundtrack({ directory: path.join(directory, "y"), enabled: () => false,
      downloadYouTube: async (id, folder, options) => { pulled.push([id, options]); const file = path.join(folder, "song.wav"); await writeFile(file, "wav"); return file; },
      addMedia: async (file, options) => ({ id: "m2", credit: options.extra.credit, mime: options.mime }) });
    const [ytSong] = youtubeCandidates([{ id: "yt:dQw4w9WgXcQ", title: "Epic", channel: "Band", duration: 150, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]);
    const media = await tube.importCandidate(ytSong);
    assert.deepEqual([pulled[0], media.mime, media.credit.license, media.credit.line], [["dQw4w9WgXcQ", { whole: true }], "audio/wav", "unknown", '"Epic" by Band (https://www.youtube.com/watch?v=dQw4w9WgXcQ)']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("YouTube junk never counts as a song: type beats, free beats, BPM drum tracks, game levels, stock uploads, hour mixes; a dance track's Original Mix stays", () => {
  for (const title of ['[FREE] Pop Guitar x EDM Type Beat - "Heaven"', "DRUMS INDIE ROCK 120BPM", "Geometry Dash - Future Funk (Level)", "Royalty Free Music for Commercials", "Synthwave 1 Hour Mix", "Song (slowed + reverb)", "Song - Piano Cover"])
    assert.ok(junkTitle(title), title);
  const row = (id, title) => ({ id: `yt:${id.padEnd(11, "x")}`, title, channel: "c", duration: 200 });
  assert.deepEqual(youtubeCandidates([row("a", "Breakbot - Baby I'm Yours (Original Mix)"), row("b", "DRUMS INDIE ROCK 120BPM")], "french house").map((entry) => entry.id), ["yt:axxxxxxxxxx"]);
});

test("explore: lanes from the brief skip what it rules out and closed lanes; ListenBrainz tag songs found on YouTube by artist and title, Topic uploads first", async () => {
  const brief = { want: "bright, driving, upbeat electronic pop, playful and confident, modern", not: ["cinematic orchestral piano", "hip-hop beat", "lo-fi chill", "singing vocals"] };
  const lanes = exploreLanes({ brief, excluded: ["synthwave"] });
  assert.equal(lanes[0], "electronic pop");
  assert.equal(lanes.length, 5);
  for (const gone of ["cinematic", "hip-hop", "lo-fi", "folk", "synthwave"]) assert.ok(!lanes.includes(gone), gone);
  assert.deepEqual(exploreLanes({}).slice(0, 4), ["electronic pop", "guitar", "hip-hop", "cinematic"], "no brief: clearly different lanes");

  const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  assert.deepEqual(parseTagRecordings([{ recording_mbid: id(1), source: "artist", tag_count: 9 }, { recording_mbid: id(2), source: "recording", tag_count: 1 }, { recording_mbid: "bad" }]), [id(2), id(1)]);
  const meta = { [id(1)]: { artist: { name: "Breakbot", artists: [{ name: "Breakbot" }] }, recording: { name: "Baby I'm Yours (feat. Irfane)", length: 200000 } }, [id(2)]: { artist: { name: "X" }, recording: { name: "Intro", length: 30000 } } };
  const songs = parseRecordings(meta, [id(1), id(2)], "nu disco");
  assert.deepEqual(songs.map((song) => [song.artist, song.title, song.seconds, song.tags]), [["Breakbot", "Baby I'm Yours (feat. Irfane)", 200, ["nu disco"]]], "a 30 s intro is not a song");
  assert.equal(catalogQuery(songs[0]), "Breakbot - Baby I'm Yours");
  const row = (n, title, channel, duration = 201) => ({ id: `yt:${String(n).padEnd(11, "y")}`, title, channel, duration });
  const results = [row(1, "Breakbot - Baby I'm Yours (Live)", "Breakbot"), row(2, "Baby I'm Yours [FREE] type beat", "Breakbot"), row(3, "Breakbot - Baby I'm Yours", "Ed Banger"), row(4, "Baby I'm Yours", "Breakbot - Topic"), row(5, "Breakbot - Baby I'm Yours", "Breakbot", 420)];
  assert.equal(pickRecording(results, songs[0]).id, "yt:4yyyyyyyyyy");
  assert.equal(pickRecording([row(6, "Other Artist - Baby I'm Yours", "Someone")], songs[0]), null, "another artist's song of the same name");

  const directory = await mkdtemp(path.join(tmpdir(), "kino-explore-"));
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    const body = String(url).includes("/lb-radio/tags") ? [{ recording_mbid: id(1), source: "recording", tag_count: 3 }] : meta;
    return { ok: true, status: 200, json: async () => body };
  };
  const searches = [];
  const soundtrack = createSoundtrack({ directory, enabled: () => false, fetch, listenbrainzApi: "https://lb.test/1", searchYouTube: async (words) => { searches.push(words); return results; } });
  try {
    const found = await soundtrack.explore(["house"], { perLane: 2 });
    assert.deepEqual(found.results.map((entry) => [entry.id, entry.creator, entry.lane, entry.tags[0], entry.source, entry.license]), [["yt:4yyyyyyyyyy", "Breakbot", "house", "french house", "youtube", null]]);
    assert.deepEqual(searches, ["Breakbot - Baby I'm Yours"], "the same song from three tags is searched once");
    assert.ok(asked.every((url) => url.startsWith("https://lb.test/1/")));
    const again = await soundtrack.explore(["house"], { skip: new Set(["breakbot - baby i'm yours (feat. irfane)"]) });
    assert.equal(again.results.length, 0, "a kept song is skipped");
    // named song: "Title by Artist", "Artist - Title" or a pasted link (taken as it is).
    assert.deepEqual([namedSong("Melatonin by Tinashe").song, namedSong("Tinashe - Melatonin").words, namedSong("https://youtu.be/dQw4w9WgXcQ?t=3").id], [{ title: "Melatonin", artist: "Tinashe" }, "Tinashe - Melatonin", "yt:dQw4w9WgXcQ"]);
    const named = await soundtrack.findSong("Baby I'm Yours by Breakbot");
    assert.deepEqual([named.id, named.title, named.creator, named.license], ["yt:4yyyyyyyyyy", "Baby I'm Yours", "Breakbot", null], "the label's Topic upload");
    assert.equal((await soundtrack.findSong("yt:1yyyyyyyyyy")).id, "yt:1yyyyyyyyyy", "a link is the person's choice, live or not");
    await assert.rejects(soundtrack.findSong("Melatonin by Tinashe"), /YouTube has no song for "Tinashe - Melatonin"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
