// Inspire (backend/inspire.mjs): parsing yt-dlp's search output, the measured numbers, the cue
// marks a borrowed rhythm makes, the one-at-a-time queue, and a whole measure of a generated
// video through a stub yt-dlp and the real shot and beat finders. Nothing here goes online.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  BOT_CHECK, NO_JS_RUNTIME, NO_YTDLP, clock, createInspire, jsRuntime, toolPath, downloadArgs, inspireTools, isYouTubeUrl, measureNumbers, numbersLine, parseSearchLines, rankResults, doubtOf,
  dropNonEdits, dropReason, droppedText, originOf, originPhrase, originQuery, sharedLine, sharedWords, closedPlatform, lookupYouTube, parseVideoInfo, projectText, refId, referenceText, lentSections, rhythmCues, runYtDlp, searchText, searchYouTube, ytDlpCommand,
  cannotPlayLine, cannotPlayReason, fingerprintLines,
} from "./inspire.mjs";
import { botCheckError, createYouTubeGate, heavyDecodeSlot } from "./process-slots.mjs";
import { copiedRun } from "../engine/quality/rules/reference.js";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";
import { encodeVector, normalize } from "./music-embed.mjs";
import { LOOK_MODEL, rankLooks, sameFrames, shotMiddles } from "./look-embed.mjs";
import { callStarted } from "./render-activity.mjs";

const FIXTURES = fileURLToPath(new URL("../tests/fixtures/inspire/", import.meta.url));
const STUB = path.join(FIXTURES, "stub-yt-dlp.mjs");
const RECORDED = path.join(FIXTURES, "ytsearch-fast-cut-walking-edit.jsonl");

let folder;
before(async () => { folder = await mkdtemp(path.join(tmpdir(), "kino-inspire-")); });
after(async () => { await rm(folder, { recursive: true, force: true }); });

test("a recorded yt-dlp search becomes references with a YouTube link and an i.ytimg.com thumbnail", async () => {
  const results = parseSearchLines(await readFile(RECORDED, "utf8"));
  assert.equal(results.length, 6);
  assert.deepEqual(results[0], {
    id: "yt:tgEWNHVbk3U", videoId: "tgEWNHVbk3U", title: "5 Fast Tips for Fast-Cut Editing", channel: "Brandon Li", duration: 259,
    url: "https://www.youtube.com/watch?v=tgEWNHVbk3U", thumbnail: results[0].thumbnail, views: 682054,
  });
  assert.match(results[0].thumbnail, /^https:\/\/i\.ytimg\.com\/vi\/tgEWNHVbk3U\/hq720\.jpg/);
  assert.ok(results.every((result) => isYouTubeUrl(result.url) && result.duration > 0));
});

test("live streams, premieres, bad ids, repeats and broken lines are left out", () => {
  const lines = [
    JSON.stringify({ id: "AAAAAAAAAAA", title: "live", duration: null, live_status: "is_live" }),
    JSON.stringify({ id: "BBBBBBBBBBB", title: "soon", duration: 30, live_status: "is_upcoming" }),
    JSON.stringify({ id: "short", title: "bad id", duration: 30 }),
    "{not json",
    JSON.stringify({ id: "CCCCCCCCCCC", title: "kept", duration: 12.4, uploader: "Someone", thumbnails: [{ url: "https://evil.example/x.jpg", width: 100 }] }),
    JSON.stringify({ id: "CCCCCCCCCCC", title: "again", duration: 12 }),
    JSON.stringify({ id: "DDDDDDDDDDD", title: "elsewhere", duration: 12, url: "https://example.com/watch?v=DDDDDDDDDDD" }),
  ].join("\n");
  const results = parseSearchLines(lines);
  assert.deepEqual(results.map((result) => result.title), ["kept"]);
  assert.equal(results[0].channel, "Someone");
  assert.equal(results[0].duration, 12);
  // A thumbnail elsewhere than i.ytimg.com is never used.
  assert.equal(results[0].thumbnail, "https://i.ytimg.com/vi/CCCCCCCCCCC/hqdefault.jpg");
});

test("a result keeps its views and verified channel; doubt says why it may be slop, never by language", () => {
  const line = (id, fields) => JSON.stringify({ id: id.repeat(11), duration: 30, view_count: 50_000, ...fields });
  const results = parseSearchLines([
    line("A", { title: "Neon city | AI generated short film", channel_is_verified: true }),
    line("B", { title: "Dreamscape", description: "Made with Sora 2 #aivideo" }),
    line("C", { title: "edit #a #b #c #d" }),
    line("D", { title: "first edit", view_count: 120 }),
    line("E", { title: "studio reel", view_count: 300, channel_is_verified: true }),
    line("F", { title: "モーショングラフィックス #デザイン #映像", view_count: 2_000_000 }),
    line("G", { title: "Sora and Riku | fan edit", view_count: null }),
  ].join("\n"));
  assert.deepEqual(results.map((ref) => [ref.videoId[0], ref.views, ref.verified, ref.doubt]), [
    ["A", 50_000, true, "ai title"], ["B", 50_000, undefined, "ai description"], ["C", 50_000, undefined, "hashtags"], ["D", 120, undefined, "few views"],
    ["E", 300, true, undefined], ["F", 2_000_000, undefined, undefined], ["G", undefined, undefined, undefined],
  ]);
  const text = searchText("edit", results.slice(3, 5));
  assert.match(text, /, best first \(views, verified channel, how the frames match the words and the saved references; doubt: likely slop/);
  assert.match(text, /'first edit' · \? · 0:30 · 120 views · doubt: few views ·/);
  assert.match(text, /'studio reel' · \? · 0:30 · 300 views · verified ·/);
});

test("ranking: clean results by log views, a verified channel and YouTube's place; doubtful after, made with AI last", () => {
  const ref = (id, fields) => ({ id, ...fields });
  const ranked = rankResults([
    ref("ai", { views: 9e6, doubt: "ai title" }), ref("few", { views: 200, doubt: "few views" }), ref("small", { views: 20_000 }),
    ref("big", { views: 3e6 }), ref("verified", { views: 20_000, verified: true }), ref("unknown", {}),
  ]);
  assert.deepEqual(ranked.map((item) => item.id), ["big", "verified", "small", "unknown", "few", "ai"]);
  // Asked for 4: the doubtful and the AI-made ones are dropped while clean ones fill the list.
  assert.deepEqual(rankResults(ranked, 4).map((item) => item.id), ["big", "verified", "small", "unknown"]);
  // One channel fills at most 2 places while other channels have results.
  const agency = ["a1", "a2", "a3"].map((id) => ref(id, { views: 4e5, channel: "Agency" }));
  assert.deepEqual(rankResults([...agency, ref("other", { views: 5e4, channel: "Other" })], 3).map((item) => item.id), ["a1", "a2", "other"]);
  assert.equal(doubtOf({ title: "Best SaaS Product Launch Ad Video | AcmeApp", views: 4e5 }), "seo title");
  assert.equal(doubtOf({ title: "Introducing Studio 2", views: 7e5 }), "");
  // A template shop's or stock library's upload, and one too short to learn a cut from.
  assert.equal(doubtOf({ title: "Product Promo | Video Template", views: 4e5 }), "template");
  assert.equal(doubtOf({ title: "City timelapse", description: "Royalty free stock footage", views: 4e5 }), "stock");
  assert.equal(doubtOf({ title: "logo sting", views: 4e5, duration: 4 }), "very short");
  assert.equal(doubtOf({ title: "Typography Animation - Motion Tutorial", views: 8e5 }), "tutorial");
});

test("results that are not edits to learn from are dropped and counted; the shared words of the rest are one line", () => {
  const ref = (n, title, duration, fields = {}) => ({ id: `yt:${String(n).repeat(11)}`, title, duration, channel: "Chan", views: 50_000, ...fields });
  const found = [
    ref(1, "Hero stairs climb edit", 21), ref(2, "Hero climbs the stairs | cut", 113), ref(3, "Hero stairs scene edit", 30),
    ref(4, "Song Name (Official Audio)", 100), ref(5, "Song Name 1 hour", 3600), ref(6, "Lyric video motion design", 150, { views: 90 }),
    ref(7, "Song Name slowed + reverb", 100, { channel: "Artist - Topic" }), ref(8, "Song Name edit official audio", 40), ref(9, "Hero montage", 900),
  ];
  // A 15 s video keeps the 21 s and 113 s edits; the 15 minute montage is over 150 s; only a release
  // (official audio, a Topic channel) goes by title, never a style such as lyric videos; an edit word keeps one.
  const { kept, dropped, items } = dropNonEdits(found, { seconds: 15 });
  assert.deepEqual(kept.map((item) => item.title), ["Hero stairs climb edit", "Hero climbs the stairs | cut", "Hero stairs scene edit", "Lyric video motion design", "Song Name edit official audio"]);
  assert.deepEqual(dropped, { "song uploads": 2, "over 150 s (the video is 15 s)": 2 });
  // The line names the first few dropped, so a wrong drop can be seen and opened with name:"yt:<id>".
  assert.equal(droppedText(dropped, items), `Dropped 4: 2 song uploads, 2 over 150 s (the video is 15 s). First: "Song Name (Official Audio)" ${found[3].id}, "Song Name 1 hour" ${found[4].id}, "Song Name slowed + reverb" ${found[6].id}.`);
  // Without a video length only a release drops; low views alone never do.
  assert.equal(dropNonEdits(found).kept.length, 7);
  assert.equal(dropReason(ref(0, "Hero walk", 30, { views: 3 })), null);
  for (const title of ["Interview audio", "Kinetic type lyric video", "Product ad with audio reactive visuals", "Fast cut moments lyrics"]) assert.equal(dropReason(ref(0, title, 60), { seconds: 15 }), null, title);
  // "stairs" is in 3 of 5 titles and not in the search; "hero" is in the search, so it is left out; a contraction is no word.
  assert.deepEqual(sharedWords(kept, "Hero edit"), [{ word: "stairs", count: 3 }]);
  assert.deepEqual(sharedWords(["Don't kill", "Don't kill", "Don’t kill"].map((title) => ({ title })), ""), [{ word: "kill", count: 3 }]);
  const text = searchText("Hero edit", kept.map((item) => ({ ...item, state: "found" })), { dropped, droppedItems: items, alsoTry: "Hero edit" });
  assert.match(text, /\nDropped 4: 2 song uploads, 2 over 150 s \(the video is 15 s\)\. First: "Song Name \(Official Audio\)" yt:4{11}, .*\nshared: "name" in 4 of 9 titles, "song" in 4, "stairs" in 3\. If one names something you could film: library \{topic:"footage", search:"<that word>"\}\.\nWithout the song: library \{topic:"inspire", search:"Hero edit"\}\./);
  // The dropped titles count too: 3 kept titles share nothing, the 3 dropped ones share two words.
  const plain = ["Alpha run", "Beta walk", "Gamma jog"].map((title) => ({ title }));
  const long = ["Stairs run long", "Stairs walk long", "Stairs jog long"].map((title) => ({ title }));
  assert.deepEqual(sharedWords(plain, ""), []);
  assert.deepEqual(sharedWords(plain, "", long), [{ word: "long", count: 3 }, { word: "stairs", count: 3 }]);
  assert.match(sharedLine(plain, "", long), /^shared: "long" in 3 of 6 titles, "stairs" in 3\./);
  // Under a third of the titles, or under 3, shows no line.
  assert.equal(sharedLine(kept.slice(0, 2), ""), "");
  assert.equal(sharedLine([...kept, ...kept, ...kept].slice(0, 12).map((item, k) => ({ ...item, title: k < 2 ? item.title : `${"abcdefghij"[k]}${"abcdefghij"[k]}${"abcdefghij"[k]}` })), ""), "");
});

test("origin: words many relevant titles share, the most viewed relevant results at any length, a failed search is skipped", async () => {
  const row = (n, title, duration, views) => ({ id: `yt:${String(n).repeat(11)}`, title, duration, views });
  const found = [
    row(1, "Keeper tower climb", 190, 5_000_000), row(2, "keeper tower scene edit", 20, 300_000), row(3, "Keeper at the tower", 30, 120_000),
    row(4, "The keeper in the tower AMV", 25, 90_000), row(5, "Keeper theme remix", 200, 40_000), row(6, "keeper wallpaper compilation", 60, 10_000),
    row(7, "Cooking pasta fast", 30, 9_000_000), row(8, "Tower defense gameplay", 60, 8_000_000),
  ];
  const about = { text: "the keeper", by: "you", quote: "keeper" };
  // "tower" is in 4 of the 6 titles with the subject; the unrelated hits (9M and 8M views) count for nothing,
  // and the 190 s result is a top result like any other. "keeper" is the person's word, "scene" and "amv" mark edits.
  assert.deepEqual(originOf(found, about), {
    words: [{ word: "tower", count: 4, of: 6 }],
    top: [{ id: found[0].id, title: "Keeper tower climb", views: 5_000_000, seconds: 190 }, { id: found[1].id, title: "keeper tower scene edit", views: 300_000, seconds: 20 },
      { id: found[2].id, title: "Keeper at the tower", views: 120_000, seconds: 30 }],
  });
  // Under 6 relevant titles: no words, but the top results stay.
  assert.deepEqual(originOf(found.slice(0, 5), about).words, []);
  assert.equal(originOf(found.slice(0, 5), about).top.length, 3);
  // A word the person said is not an origin; a quote of 2 words needs both in a title (only 4 titles have both).
  assert.deepEqual(originOf(found, about, { ask: ["a climb up the tower"] }).words, []);
  assert.deepEqual(originOf(found, { quote: "keeper tower" }).words, []);
  assert.deepEqual(originOf(found, { quote: "keeper tower" }).top.map((item) => item.id), found.slice(0, 3).map((item) => item.id));
  // A title with one of three subject words counts when it shares a word with a title that has two: the most
  // viewed upload often shortens the name. "ladders" is in 3 of 9 relevant titles (under 40%) but in 3 of the 5
  // most viewed, and "ladder" is the same word. The 9M festival upload shares nothing, so it is not relevant.
  const known = [
    row(1, "Keeper climbs the ladders", 190, 5_000_000), row(2, "keeper going up a ladder", 19, 1_100_000), row(3, "Marlo Keeper lantern", 57, 1_000),
    row(4, "Lantern keeper explained", 53, 300_000), row(5, "marlo keeper lantern remake", 18, 20_000), row(6, "The lantern keeper: book version", 52, 40_000),
    row(7, "Keeper lantern ladders, but real", 21, 270_000), row(8, "Lantern festival vlog", 60, 9_000_000), row(9, "keeper lantern wallpaper", 30, 5_000),
    row(0, "Lantern keeper theme", 40, 8_000),
  ];
  const three = originOf(known, { quote: "marlo keeper lantern" });
  assert.deepEqual(three.words, [{ word: "ladders", count: 3, of: 9 }]);
  assert.deepEqual(three.top.map((item) => item.id), [known[0].id, known[1].id, known[3].id]);
  assert.equal(originQuery("a very long quote about the keeper climbing the tower again"), "a very long quote about the keeper");
  assert.equal(originQuery("keeper"), "keeper");

  // inspire.origin searches the quote only, at any length, and stores nothing; an error is {skipped}.
  const asked = [];
  const inspire = createInspire({ directory: path.join(folder, "origin"), projectState: memoryProjects(), search: async (query, options) => { asked.push([query, options.count, options.dropped]); return found; } });
  assert.deepEqual(await inspire.origin(about, { ask: [] }), { query: "keeper", ...originOf(found, about) });
  assert.deepEqual(asked, [["keeper", 20, undefined]]);
  await inspire.origin(about, { ask: ["a long message about the keeper climbing the tower and nothing else"] });
  assert.deepEqual(asked.map((entry) => entry[0]), ["keeper", "keeper", "keeper climbing"], "the person's whole message is never searched, only the quote and the words beside it");

  // originPhrase: the quote and up to 6 words in all from the message, after it first, before it only when none follow.
  const phraseOf = (ask, quote = "keeper") => originPhrase(quote, [ask]);
  assert.equal(phraseOf("make a keeper lantern ladder edit please"), "keeper lantern ladder");
  assert.equal(phraseOf("a glowing keeper edit"), "glowing keeper");
  assert.equal(phraseOf("the glowing keeper ladder edit"), "keeper ladder");
  assert.equal(phraseOf("the keeper. call me later"), "", "a sentence mark stops it");
  assert.equal(phraseOf("keeper 42 elm"), "", "letters only");
  assert.equal(phraseOf("keeper trailer"), "", "a video-kind word is not a subject word");
  assert.equal(phraseOf("nothing about it"), "");
  assert.equal(phraseOf("marlo keeper lantern ladder tower climb run", "marlo keeper"), "marlo keeper lantern ladder tower climb");
  assert.deepEqual(originPhrase("keeper", ["no match here", "make a keeper lantern edit"]), "keeper lantern", "the first message that has the quote");

  // Both searches run, the phrase's words come first (with the words that found them); one failing leaves the other.
  const near = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((name, k) => row(`abcdef`[k], `Keeper rooftop ${name}`, 30, 2_000_000 - k));
  const split = createInspire({ directory: path.join(folder, "origin-phrase"), projectState: memoryProjects(), search: async (query) => (query === "keeper" ? found : near) });
  const lantern = ["make a keeper lantern ladder edit please"];
  const both = await split.origin(about, { ask: lantern });
  assert.equal(both.phrase, "keeper lantern ladder");
  assert.deepEqual(both.words, [{ word: "rooftop", count: 6, of: 6, query: "keeper lantern ladder" }, { word: "tower", count: 4, of: 6 }]);
  assert.deepEqual(both.top.map((item) => item.id), [near[0].id, near[1].id, near[2].id]);
  const brokenPhrase = createInspire({ directory: path.join(folder, "origin-phrase-fail"), projectState: memoryProjects(), search: async (query) => { if (query !== "keeper") throw new Error("boom"); return found; } });
  assert.deepEqual((await brokenPhrase.origin(about, { ask: lantern })).words, originOf(found, about, { ask: lantern }).words);
  const failing = createInspire({ directory: path.join(folder, "origin-fail"), projectState: memoryProjects(), search: async () => { throw Object.assign(new Error("not found"), { code: "NO_YTDLP" }); } });
  assert.deepEqual(await failing.origin(about), { query: "keeper", skipped: "yt-dlp is not installed" });
  assert.deepEqual(await failing.origin(about, { ask: lantern }), { query: "keeper", phrase: "keeper lantern ladder", skipped: "yt-dlp is not installed" }, "a skipped search keeps its phrase");
});

test("the video's length reaches the search: far longer results are dropped and counted, and fewer than wanted asks once more", async () => {
  const log = path.join(folder, "drop.log");
  process.env.STUB_YTDLP_LOG = log;
  const inspire = createInspire({ directory: path.join(folder, "drop"), projectState: memoryProjects(), search: (words, options) => searchYouTube(words, { ...options, command: STUB }) });
  let found;
  try { found = await inspire.search("p1", "fast cut walking edit", { count: 3, seconds: 3 }); }
  finally { delete process.env.STUB_YTDLP_LOG; }
  // The recorded results are 10 s, 60 s, 114 s, 259 s, 564 s and 701 s: 90 s is the limit for a 3 s video.
  assert.deepEqual(found.results.map((ref) => ref.id).sort(), ["yt:CGzyD_54ajU", "yt:ghBpKLARE_8"]);
  assert.deepEqual(found.dropped, { "over 90 s (the video is 3 s)": 4 });
  assert.deepEqual(found.droppedItems.map((item) => item.id).sort(), ["yt:J0ydlAqg6_8", "yt:OAH0MoAv2CI", "yt:RpowN_JNIsQ", "yt:tgEWNHVbk3U"]);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line).at(-1)), ["ytsearch6:fast cut walking edit", "ytsearch20:fast cut walking edit"]);
  // Without a length nothing is dropped by it, and there is no second request.
  const plain = await inspire.search("p2", "fast cut walking edit", { count: 3 });
  assert.deepEqual([plain.results.length, plain.dropped], [3, {}]);
});

// A look vector pointing mostly along one axis (dimension 8), stored as a measured record keeps it.
const axis = (k, wobble = 0) => normalize(Array.from({ length: 8 }, (_, i) => (i === k ? 1 : 0) + (i === (k + 1) % 8 ? wobble : 0)));
const looked = (id, k, fields = {}) => ({ id, title: id, duration: 30, thumbLook: { model: LOOK_MODEL, vector: encodeVector(axis(k, fields.wobble ?? 0)) }, ...fields });

test("looks: copies collapse into the most viewed, the words and taste order the rest, MMR keeps it varied", () => {
  // b is a re-upload of a (the same frames): a has more views, so b collapses into it.
  const results = [looked("b", 0, { views: 10 }), looked("a", 0, { views: 900, wobble: 0.05 }), looked("c", 1, { views: 50 }), looked("d", 2, { views: 40 })];
  const plain = rankLooks(results);
  assert.deepEqual(plain.collapsed, [{ id: "b", into: "a" }]);
  assert.deepEqual(plain.results.map((ref) => ref.id), ["a", "c", "d"]);
  // The words look like d: d comes first.
  assert.equal(rankLooks(results, { query: axis(2) }).results[0].id, "d");
  // Taste: liked like c, rejected like a.
  assert.deepEqual(rankLooks(results, { liked: [axis(1), axis(1, 0.1)], rejected: [axis(0)] }).results.map((ref) => ref.id), ["c", "d", "a"]);
  // Variety: two near-identical looks (not copies) are not picked one after the other.
  const twins = [looked("e", 3, { views: 500 }), looked("f", 3, { views: 400, wobble: 0.45 }), looked("g", 4, { views: 300 })];
  assert.deepEqual(rankLooks(twins).results.map((ref) => ref.id), ["e", "g", "f"]);
  // A doubtful one stays behind clean ones whatever its look.
  assert.equal(rankLooks([looked("h", 2, { doubt: "template" }), looked("i", 5)], { query: axis(2) }).results[0].id, "i");
  // Keyframes: the middle of each shot, at most 12; a reference that shows one picture throughout.
  assert.deepEqual(shotMiddles([2, 6], 10), [1, 4, 8]);
  assert.equal(shotMiddles(Array.from({ length: 30 }, (_, k) => k + 1), 31).length, 12);
  assert.equal(sameFrames({ vectors: [0, 0, 0, 0].map((k) => encodeVector(axis(k))) }), true);
  assert.equal(sameFrames({ vectors: [0, 1, 2, 3].map((k) => encodeVector(axis(k))) }), false);
});

test("a vetted search asks YouTube for twice as many and keeps the best", async () => {
  const log = path.join(folder, "vet.log");
  process.env.STUB_YTDLP_LOG = log;
  let results;
  try { results = await searchYouTube("fast cut walking edit", { count: 3, vet: true, command: STUB }); }
  finally { delete process.env.STUB_YTDLP_LOG; }
  assert.equal(JSON.parse((await readFile(log, "utf8")).trim()).at(-1), "ytsearch6:fast cut walking edit");
  // Cuts & Transitions 101 (4.5M views, sixth on YouTube's list) comes first.
  assert.deepEqual(results.map((ref) => ref.videoId), ["OAH0MoAv2CI", "tgEWNHVbk3U", "ghBpKLARE_8"]);
});

test("reference ids come from an id, yt:<id> or a YouTube link; open the source takes YouTube https links only", () => {
  assert.equal(refId("tgEWNHVbk3U"), "yt:tgEWNHVbk3U");
  assert.equal(refId("yt:tgEWNHVbk3U"), "yt:tgEWNHVbk3U");
  assert.equal(refId("https://www.youtube.com/watch?v=tgEWNHVbk3U&t=4"), "yt:tgEWNHVbk3U");
  assert.equal(refId("https://youtu.be/tgEWNHVbk3U"), "yt:tgEWNHVbk3U");
  assert.equal(refId("https://www.youtube.com/shorts/tgEWNHVbk3U"), "yt:tgEWNHVbk3U");
  assert.equal(refId("https://www.youtube.com/shorts/tgEWNHVbk3U/"), "yt:tgEWNHVbk3U");
  assert.equal(refId("https://example.com/watch?v=tgEWNHVbk3U"), null);
  assert.equal(refId("yt:../../etc"), null);
  assert.equal(isYouTubeUrl("http://www.youtube.com/watch?v=tgEWNHVbk3U"), false);
  assert.equal(isYouTubeUrl("https://user:pw@youtube.com/"), false);
  assert.equal(isYouTubeUrl("https://youtube.com.example.com/"), false);
  assert.equal(isYouTubeUrl("javascript:alert(1)"), false);
  // TikTok and Instagram links are refused with a plain reason (reading them needs a faked browser or a login).
  assert.equal(closedPlatform("https://www.tiktok.com/@scout2015/video/6718335390845095173"), true);
  assert.equal(closedPlatform("save https://www.instagram.com/reel/Chunk8-jurw/"), true);
  assert.equal(closedPlatform("https://www.youtube.com/shorts/tgEWNHVbk3U"), false);
  assert.equal(closedPlatform("tiktok.com style edit"), false);
  for (const link of ["www.tiktok.com/@a/video/123", "https://www.tiktok.com:443/@a/video/1", "https://instagr.am/p/x"]) assert.equal(closedPlatform(link), true, link);
});

test("a shorts search: YouTube's Shorts filter first, then a plain search's videos of 60 s or less; a Short is vertical with its /shorts/ link and a tall thumbnail", async () => {
  const log = path.join(folder, "shorts.log");
  process.env.STUB_YTDLP_LOG = log;
  let results;
  try { results = await searchYouTube("app launch animation", { shorts: true, count: 5, command: STUB }); }
  finally { delete process.env.STUB_YTDLP_LOG; }
  const runs = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line).at(-1)).sort();
  assert.deepEqual(runs, ["https://www.youtube.com/results?search_query=app%20launch%20animation&sp=EgIQCQ%3D%3D", "ytsearch10:app launch animation shorts"]);
  assert.deepEqual(results.map((result) => [result.videoId, result.duration, Boolean(result.vertical)]),
    [["OfYFgNX5Fb4", 7, true], ["-JUdWtzC1PY", 12, true], ["BDzufeEPQl0", 12, true], ["ghBpKLARE_8", 10, false], ["CGzyD_54ajU", 60, false]]);
  assert.equal(results[0].url, "https://www.youtube.com/shorts/OfYFgNX5Fb4");
  assert.equal(results[0].thumbnail, "https://i.ytimg.com/vi/OfYFgNX5Fb4/frame0.jpg");
  // A full description says vertical by its picture; the Shorts filter failing leaves the plain search.
  assert.equal(parseVideoInfo(JSON.stringify({ id: "OfYFgNX5Fb4", duration: 7, width: 1080, height: 1920 }), "OfYFgNX5Fb4").vertical, true);
  process.env.STUB_YTDLP_FAIL = "shorts";
  try {
    assert.deepEqual((await searchYouTube("app launch animation", { shorts: true, count: 5, command: STUB })).map((result) => result.videoId), ["ghBpKLARE_8", "CGzyD_54ajU"]);
    // The other run found only long videos: the failed run's error, not a quiet "nothing found".
    process.env.STUB_YTDLP_LONG = "1";
    await assert.rejects(searchYouTube("app launch animation", { shorts: true, count: 5, command: STUB }), /HTTP Error 429/);
  } finally { delete process.env.STUB_YTDLP_FAIL; delete process.env.STUB_YTDLP_LONG; }
  // The project keeps it as a shorts search; the agent's lines mark the vertical ones.
  const asked = [];
  // One was measured square before: the download's answer stays, not the /shorts/ link's guess.
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(folder, "shorts"), { recursive: true });
  await writeFile(path.join(folder, "shorts", "-JUdWtzC1PY.json"), JSON.stringify({ id: "yt:-JUdWtzC1PY", videoId: "-JUdWtzC1PY", title: "square", state: "measured", vertical: false, thumb: true, url: "https://www.youtube.com/watch?v=-JUdWtzC1PY" }));
  const inspire = createInspire({ directory: path.join(folder, "shorts"), projectState: memoryProjects(), search: async (words, options) => { asked.push(options.shorts); return results; } });
  const found = await inspire.search("p1", "app launch animation", { kind: "shorts", count: 5 });
  assert.deepEqual([asked, found.search.kind, found.results[0].vertical, found.results[3].vertical], [[true], "shorts", true, undefined]);
  assert.deepEqual([found.results[1].vertical, found.results[1].thumb], [undefined, true], "measured square: not vertical, its thumbnail kept");
  const text = searchText("app launch animation", found.results, { kind: "shorts" });
  assert.match(text, /^inspire shorts "app launch animation": 5 found on YouTube \(Shorts/);
  assert.match(text, /yt:OfYFgNX5Fb4 'Sh-ort launch screen animation' · Mirko_ddd · 0:07 · Short 9:16 ·/);
  await assert.rejects(inspire.search("p1", "walk", { kind: "tiktok" }), /"videos", "shorts" or "sounds"/);
});

test("the numbers: shots, cuts a second, the longest shot and where, cuts on the beat", () => {
  const numbers = measureNumbers({ cuts: [2, 4, 4.5, 9, 0, 12], beats: [0, 1, 2.05, 3, 4, 5, 6, 7, 8, 9.1], seconds: 10 });
  assert.deepEqual(numbers.cuts, [2, 4, 4.5, 9], "cuts at 0 and past the end are not cuts");
  assert.equal(numbers.shots, 5);
  assert.equal(numbers.cutsPerSecond, 0.4);
  assert.deepEqual(numbers.longest, { seconds: 4.5, start: 4.5, where: null });
  // 2 is 0.05 from a beat (on), 4 is on one, 4.5 is half a beat off, 9 is 0.1 off (more than 0.08).
  assert.deepEqual(numbers.onBeat, [true, true, false, false]);
  assert.equal(numbers.onBeatCount, 2);
  // In frames at 24 fps: 2 is 1 early (0.05 s), 4 is on it, 9 is 2 early, 4.5 is 12 off.
  assert.deepEqual([numbers.beatFit.onBeat, numbers.beatFit.offsets, numbers.beatFit.further], [0.5, { "-3": 0, "-2": 1, "-1": 1, 0: 1, 1: 0, 2: 0, 3: 0 }, 1]);
  assert.ok(numbers.beatFit.random > 0 && numbers.beatFit.random < 0.3, "a random placement lands within a frame of a 1 s beat about 1 time in 8");
  assert.deepEqual(measureNumbers({ cuts: [2, 4, 4.5, 9, 0, 12], beats: [0, 1, 2.05, 3, 4, 5, 6, 7, 8, 9.1], seconds: 10 }).beatFit, numbers.beatFit, "the same baseline every run");
  assert.equal(measureNumbers({ cuts: [1], beats: [], seconds: 8 }).onBeat, null, "no beat: no on-the-beat count");
  assert.equal(measureNumbers({ cuts: [1], beats: [], seconds: 8 }).beatFit, null);
  assert.equal(measureNumbers({ cuts: [6], beats: [], seconds: 8 }).longest.where, "the start");
  assert.equal(measureNumbers({ cuts: [1], beats: [], seconds: 8 }).longest.where, "the end");
  assert.equal(measureNumbers({ cuts: [], beats: [], seconds: 8 }).longest.where, "the whole clip");
});

test("the median shot: one long shot moves the mean cuts a second but not the median", () => {
  // Five 1 s shots and one 25 s shot: the mean shot is 5 s (0.17 cuts/s), the usual shot is 1 s.
  const beats = Array.from({ length: 61 }, (_, index) => index * 0.5);
  const long = measureNumbers({ cuts: [1, 2, 3, 4, 5], beats, seconds: 30 });
  assert.deepEqual([long.cutsPerSecond, long.median, long.longest.seconds], [0.17, 1, 25]);
  // The reference's own beat is 0.5 s: the median is 2 beats exactly, kept unrounded beside the nearest of 1, 2, 4, 8.
  assert.deepEqual(long.medianBeats, { exact: 2, near: 2, beatSeconds: 0.5 });
  assert.equal(numbersLine({ state: "measured", numbers: long }), "0.17 cuts/s · 6 shots in 30 s · median shot 1 s · longest 25 s · on the beat 5 of 5");
  // Cuts that are not whole beats keep the exact value (1.4 s at 1 s a beat) and round by ratio.
  const odd = measureNumbers({ cuts: [1.4, 2.8, 4.2], beats: [0, 1, 2, 3, 4, 5, 6], seconds: 5.6 });
  assert.deepEqual(odd.medianBeats, { exact: 1.4, near: 1, beatSeconds: 1 });
  // No sound, no beat: seconds only. A reference saved before medians were kept still shows one.
  const quiet = measureNumbers({ cuts: [1, 2, 3, 4, 5], beats: [], seconds: 30 });
  assert.deepEqual([quiet.median, quiet.medianBeats], [1, null]);
  const { median, medianBeats, ...before } = quiet;
  assert.match(numbersLine({ state: "measured", numbers: before }), /median shot 1 s · longest 25 s · no steady beat$/);
  // An unsure beat grid (a voice gets one too) keeps the median in seconds only, never in made-up beats.
  const voice = measureNumbers({ cuts: [3, 6, 9, 12], beats, seconds: 20, steady: false });
  assert.deepEqual([voice.median, voice.medianBeats], [3, null]);
  // A saved record without a longest shot still reads: the line leaves that part out instead of throwing.
  const partial = { state: "measured", numbers: { cuts: [1, 2], seconds: 3, shots: 3, cutsPerSecond: 0.67 } };
  assert.equal(numbersLine(partial), "0.67 cuts/s · 3 shots in 3 s · median shot 1 s · no steady beat");
  assert.match(referenceText({ id: "yt:p", title: "p", duration: 3, url: "u", ...partial }), /3 shots · 0\.67 cuts\/s · median shot 1 s · no steady beat/);
});

test("a borrowed rhythm: each section's pace in a new order, scaled to fit, cut on the song's seams", () => {
  const numbers = measureNumbers({ cuts: [2, 4, 6, 8], beats: [], seconds: 10 });
  assert.deepEqual(rhythmCues(numbers, { length: 5 }).cues.map((cue) => cue.time), [2, 4]);
  assert.equal(rhythmCues(numbers, { length: 5 }).dropped, 2);
  const fitted = rhythmCues(numbers, { length: 5, fit: 5 });
  assert.deepEqual(fitted.cues, [1, 2, 3, 4].map((time, index) => ({ name: `rhythm-${index + 1}`, time, kind: "marker" })));
  assert.deepEqual(rhythmCues(numbers, { length: 20, fit: 5, at: 10 }).cues.map((cue) => cue.time), [11, 12, 13, 14]);
  // Uneven shots: the same lengths per section, never in the reference's order; the song's seams are cuts.
  const odd = measureNumbers({ cuts: [0.5, 1.7, 2.1, 3.4, 3.8, 5.3, 5.6, 7.2], beats: [], seconds: 8, fps: 24 });
  const lent = rhythmCues(odd, { length: 8 }).cues.map((cue) => cue.time);
  const gaps = (times) => times.slice(1).map((time, index) => Math.round((time - times[index]) * 100) / 100);
  assert.notDeepEqual(lent, odd.cuts, "not the reference's cut times");
  assert.deepEqual(lentSections(odd).map((part) => part.shots.length), [6, 3]);
  assert.ok(gaps([0, ...lent]).every((gap) => lentSections(odd).some((part) => part.shots.includes(gap))), "every shot length is one the reference has");
  assert.deepEqual(rhythmCues(odd, { length: 8 }).cues, rhythmCues(odd, { length: 8 }).cues, "the same order every time");
  assert.ok(rhythmCues(odd, { length: 8, seams: [4.5] }).cues.some((cue) => cue.time === 4.5));
  // A reference cut on 1 and 2 beats at 120 BPM: what it lends, fitted to 12 s, is no copy of it.
  const beat = measureNumbers({ cuts: [0.5, 1.5, 2, 3, 3.5, 4, 5, 5.5, 6.5, 7, 8, 8.5, 9.5, 10, 11, 12, 12.5, 13.5, 14, 15], beats: [], seconds: 16, fps: 24 });
  const borrowed = rhythmCues(beat, { length: 12, fit: 12 }).cues.map((cue) => cue.time);
  assert.equal(copiedRun(borrowed, beat.cuts, { tolerance: 1 / 30 + 0.01 }), null);
  // A reference cut in 2-frame shots lends no cut under 6 frames after the last one lent (25 fps: 0.24 s).
  const dense = measureNumbers({ cuts: [1, 1.08, 1.16, 1.24, 1.32, 2], beats: [], seconds: 10, fps: 25 });
  assert.deepEqual(lentSections(dense)[0].shots, [0.24, 0.76, 1, 8]);
  const text = referenceText({ id: "yt:a", title: "A", duration: 10, url: "u", numbers: dense });
  assert.match(text, /\ncuts \(s\): 1 1\.24 2 \(3 under 6 frames apart not listed or borrowed\)\n/);
  assert.match(text, /\nlend: pace per section \(0-5 s 4 shots median 1 s · 5-10 s 0 shots\); avoid: its shot lengths in order/);
});

test("clock and the agent's lines", () => {
  assert.equal(clock(39), "0:39");
  assert.equal(clock(259), "4:19");
  assert.equal(clock(3725), "1:02:05");
  const ref = { id: "yt:tgEWNHVbk3U", title: "Fast", channel: "Brandon Li", duration: 259, url: "https://www.youtube.com/watch?v=tgEWNHVbk3U", state: "measured", bpm: 120,
    numbers: measureNumbers({ cuts: [2, 4, 4.5, 9], beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], seconds: 90 }) };
  assert.equal(numbersLine(ref), "0.04 cuts/s · 5 shots in 90 s · median shot 2 s · longest 81 s · on the beat 3 of 4");
  assert.equal(numbersLine({ state: "measuring", phase: "reading cuts" }), "measuring (reading cuts)");
  assert.equal(numbersLine({ state: "queued", place: 2 }), "waiting to be measured (2 in line)");
  const text = referenceText(ref);
  assert.match(text, /measured the first 90 s of 4:19: 5 shots · 0\.04 cuts\/s · median shot 2 s \(2 beats, about 2 at 120 bpm\) · longest 81 s \(the end\) · cuts on the beat 3 of 4 \(120 bpm\)/);
  assert.match(text, /cuts \(s\): 2\* 4\* 4\.5 9\* \(\* on the beat\)/);
  assert.match(text, /\ncuts 4 · 75% within 1 frame of a beat \(random \d+%\) · frames off the beat \(- early\) 0:3 more:1\n/);
  assert.match(searchText("walk", [ref]), /^inspire "walk": 1 found on YouTube/);
  assert.match(projectText({ searches: [{ query: "walk", state: "done", count: 6, by: { name: "juno" } }], saved: [ref.id], refs: { [ref.id]: ref }, queue: {} }), /"walk" 6 found · by juno/);
});

test("yt-dlp runs without the person's config or cookies, and says plainly when it is missing", async () => {
  assert.equal(ytDlpCommand({ KINO_YTDLP: "/x/yt-dlp" }), "/x/yt-dlp");
  assert.equal(ytDlpCommand({}, () => false), "yt-dlp");
  const log = path.join(folder, "args.log");
  process.env.STUB_YTDLP_LOG = log;
  try { await runYtDlp(["--flat-playlist", "--dump-json", "ytsearch2:walk"], { command: STUB }); }
  finally { delete process.env.STUB_YTDLP_LOG; }
  const args = JSON.parse((await readFile(log, "utf8")).trim());
  for (const flag of ["--ignore-config", "--no-cookies", "--no-cache-dir"]) assert.ok(args.includes(flag), flag);
  await assert.rejects(runYtDlp(["--version"], { command: path.join(folder, "no-such-yt-dlp") }), (error) => error.message === NO_YTDLP && error.code === "NO_YTDLP");
  // The small copy: 360p at most, the first 90 s at most.
  const download = downloadArgs("tgEWNHVbk3U", folder);
  // "res" is the short side: a tall Short comes down at 324x720 like a wide video at 640x360.
  assert.deepEqual(download.slice(download.indexOf("-f"), download.indexOf("-f") + 4), ["-f", "b/bv*+ba/w", "-S", "res:360"]);
  assert.equal(download[download.indexOf("--download-sections") + 1], "*0-90");
  assert.equal(download.at(-1), "https://www.youtube.com/watch?v=tgEWNHVbk3U");
});

test("one video's metadata from its link: the watch page, not the file's address; a private or live one is refused", async () => {
  const log = path.join(folder, "lookup.log");
  process.env.STUB_YTDLP_LOG = log;
  let found;
  try { found = await lookupYouTube("G9wj1YA0DYI", { command: STUB }); }
  finally { delete process.env.STUB_YTDLP_LOG; }
  assert.deepEqual(found, {
    id: "yt:G9wj1YA0DYI", videoId: "G9wj1YA0DYI", title: "Stub video G9wj1YA0DYI", channel: "Stub channel", duration: 57,
    url: "https://www.youtube.com/watch?v=G9wj1YA0DYI", thumbnail: "https://i.ytimg.com/vi/G9wj1YA0DYI/hqdefault.jpg",
  });
  const args = JSON.parse((await readFile(log, "utf8")).trim());
  for (const flag of ["--ignore-config", "--no-cookies", "--skip-download", "--no-playlist"]) assert.ok(args.includes(flag), flag);
  assert.equal(args.includes("--download-sections"), false, "nothing is downloaded");
  await assert.rejects(lookupYouTube("../etc", { command: STUB }), /not a YouTube video id/);
  process.env.STUB_YTDLP_FAIL = "lookup";
  try { await assert.rejects(lookupYouTube("G9wj1YA0DYI", { command: STUB }), /yt-dlp failed: \[youtube\] Video unavailable\. This video is private/); }
  finally { delete process.env.STUB_YTDLP_FAIL; }
  assert.throws(() => parseVideoInfo(JSON.stringify({ id: "G9wj1YA0DYI", title: "live", live_status: "is_live" }), "G9wj1YA0DYI"), /live stream or premiere/);
  assert.throws(() => parseVideoInfo("not json", "G9wj1YA0DYI"), /did not describe/);
});

// A project state kept in memory, as the agent state keeps it on the server.
function memoryProjects() {
  const states = new Map();
  return {
    states,
    read: async (id) => states.get(id) ?? null,
    update: async (id, change) => {
      const { state, value } = change(structuredClone(states.get(id) ?? null));
      states.set(id, state);
      return value;
    },
  };
}

test("the queue measures one reference at a time, keeps only the numbers and the thumbnail, and can be cancelled", async () => {
  const directory = path.join(folder, "queue");
  const events = [];
  let busy = 0;
  let most = 0;
  const releases = [];
  const projects = memoryProjects();
  const inspire = createInspire({
    directory,
    projectState: projects,
    publish: (event) => events.push(event),
    search: async (query, { count }) => parseSearchLines(await readFile(RECORDED, "utf8")).slice(0, count),
    async download(videoId, workFolder) {
      busy += 1;
      most = Math.max(most, busy);
      await new Promise((resolve) => releases.push(resolve));
      busy -= 1;
      const file = path.join(workFolder, "clip.mp4");
      await (await import("node:fs/promises")).writeFile(file, "not really a video");
      return file;
    },
    probe: async () => ({ duration: 30, width: 202, height: 360 }),
    findShots: async (file, { minShotFrames }) => (minShotFrames === 2 ? { shots: [{ start: 0 }, { start: 10 }, { start: 20 }], flashes: [{ start: 15, end: 15.08 }], fps: 25 } : { shots: [] }),
    findBeats: async () => ({ beats: [0, 10, 20.5], bpm: 6 }),
    fetchThumb: async () => Buffer.from("jpeg bytes"),
  });
  const found = await inspire.search("p1", "walking tour edit", { by: { id: "a1", name: "juno", color: "#5ab0ff" }, count: 3 });
  assert.equal(found.results.length, 3);
  assert.deepEqual(found.search, { n: 1, query: "walking tour edit", kind: "videos", by: { id: "a1", name: "juno", color: "#5ab0ff" }, at: found.search.at, state: "done", wanted: 3, ids: found.results.map((ref) => ref.id), count: 3 });
  const waitFor = async (check) => { for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(check()); };
  await waitFor(() => releases.length === 1);
  let view = await inspire.projectView("p1");
  assert.equal(view.refs["yt:tgEWNHVbk3U"].state, "measuring");
  assert.equal(view.refs["yt:ghBpKLARE_8"].state, "queued");
  assert.equal(view.refs["yt:ghBpKLARE_8"].place, 1);
  // A saved one goes ahead of the results nobody picked.
  await inspire.setSaved("p1", "yt:J0ydlAqg6_8");
  view = await inspire.projectView("p1");
  assert.deepEqual([view.refs["yt:J0ydlAqg6_8"].place, view.refs["yt:ghBpKLARE_8"].place], [1, 2]);
  await inspire.setSaved("p1", "yt:J0ydlAqg6_8", false);
  // The third is cancelled while it waits; the first finishes.
  assert.equal(inspire.cancel("yt:J0ydlAqg6_8"), 1);
  releases.shift()();
  await waitFor(() => releases.length === 1);
  view = await inspire.projectView("p1");
  const first = view.refs["yt:tgEWNHVbk3U"];
  assert.equal(first.state, "measured");
  const { beatFit, ...numbers } = first.numbers;
  assert.deepEqual(numbers, { seconds: 30, shots: 3, cuts: [10, 20], cutsPerSecond: 0.07, median: 10, medianBeats: { exact: 0.98, near: 1, beatSeconds: 10.25 }, longest: { seconds: 10, start: 0, where: "the start" }, onBeat: [true, false], onBeatCount: 1, flashes: 1, fps: 25 });
  assert.deepEqual([beatFit.cuts, beatFit.fps, beatFit.onBeat, beatFit.offsets["0"], beatFit.further], [2, 25, 0.5, 1, 1], "frames at the file's rate; 20 is 12 frames before 20.5");
  assert.equal(first.thumb, true);
  assert.equal(first.vertical, true, "the downloaded picture, taller than wide, says it is vertical");
  assert.equal(view.refs["yt:J0ydlAqg6_8"].state, "found", "a cancelled one waits to be asked again");
  // Cancelling the running one stops it.
  assert.equal(inspire.cancel(), 1);
  releases.shift()();
  await waitFor(() => !releases.length && busy === 0);
  assert.equal(most, 1, "never two at once");
  // Only numbers and thumbnails stay; the work folder is empty.
  const files = (await readdir(directory)).sort();
  assert.ok(files.includes("tgEWNHVbk3U.json") && files.includes("tgEWNHVbk3U.jpg"));
  // A cancelled measure deletes its copy as it stops: wait for that, never longer than a second.
  let left = await readdir(path.join(directory, "work"));
  for (let tries = 0; tries < 200 && left.length; tries += 1) { await new Promise((resolve) => setTimeout(resolve, 5)); left = await readdir(path.join(directory, "work")); }
  assert.deepEqual(left, []);
  assert.ok(events.some((event) => event.type === "inspire" && event.projectId === "p1"));
  assert.ok(events.some((event) => event.type === "inspire-ref" && event.ref.state === "measured"));
  // Saved references belong to the project.
  assert.equal(await inspire.setSaved("p1", "yt:tgEWNHVbk3U"), 1);
  assert.deepEqual((await inspire.projectView("p1")).saved, ["yt:tgEWNHVbk3U"]);
  // A key (save yt:<id> as phone-film) names it for a board's move.ref; unsaving drops the key.
  assert.equal(await inspire.setSaved("p1", "yt:tgEWNHVbk3U", true, { key: "Phone-Film" }), 1);
  assert.deepEqual((await inspire.projectView("p1")).keys, { "phone-film": "yt:tgEWNHVbk3U" });
  assert.equal(await inspire.setSaved("p1", "yt:tgEWNHVbk3U", false), 0);
  assert.deepEqual((await inspire.projectView("p1")).keys, {});
  await assert.rejects(inspire.setSaved("p1", "yt:zzzzzzzzzzz"), /search first/);
  // A failed search is kept with its reason.
  const failing = createInspire({ directory: path.join(folder, "failing"), projectState: projects, search: async () => { throw new Error("yt-dlp failed: HTTP Error 429"); } });
  await assert.rejects(failing.search("p2", "walk"), /429/);
  assert.deepEqual((await failing.projectView("p2")).searches.map((search) => [search.state, search.error]), [["failed", "yt-dlp failed: HTTP Error 429"]]);
});

test("while an agent call runs, measuring waits, but a ref a call waits for goes at once, with the one ahead of it", async () => {
  const ended = callStarted();
  try {
    const inspire = createInspire({
      directory: path.join(folder, "wanted"),
      projectState: memoryProjects(),
      search: async (query, { count }) => parseSearchLines(await readFile(RECORDED, "utf8")).slice(0, count),
      async download(videoId, workFolder) {
        const file = path.join(workFolder, "clip.mp4");
        await (await import("node:fs/promises")).writeFile(file, "not really a video");
        return file;
      },
      probe: async () => ({ duration: 30 }),
      findShots: async () => ({ shots: [{ start: 0 }, { start: 10 }] }),
      findBeats: async () => ({ beats: [0, 10], bpm: 6 }),
      fetchThumb: async () => Buffer.from("jpeg bytes"),
    });
    const found = await inspire.search("p1", "walking tour edit", { count: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await inspire.projectView("p1")).refs[found.results[0].id].state, "measuring", "the first waits for the call to end");
    // The second is behind it: the call waiting for it must not wait for quiet (it is the busy call).
    assert.equal((await inspire.reference(found.results[1].id, { wait: 3000 })).state, "measured");
  } finally { ended(); }
});

test("a measured reference keeps what was heard in it (loudest change, voice) and savedFingerprints hands it on; a failed listen leaves it out", async () => {
  const asked = [];
  const make = (name, heard) => createInspire({
    directory: path.join(folder, name), projectState: memoryProjects(),
    search: async (query, { count }) => parseSearchLines(await readFile(RECORDED, "utf8")).slice(0, count),
    async download(videoId, workFolder) {
      const file = path.join(workFolder, "clip.mp4");
      await (await import("node:fs/promises")).writeFile(file, "not really a video");
      return file;
    },
    probe: async () => ({ duration: 30 }),
    findShots: async () => ({ shots: [{ start: 0 }, { start: 10 }] }),
    findBeats: async () => ({ beats: [0, 10], bpm: 6 }),
    fingerprint: async () => ({ fingerprint: { seconds: 30, look: { brightness: 0.2, darkShare: 0.1 } }, prints: [] }),
    heard,
    fetchThumb: async () => Buffer.from("jpeg bytes"),
  });
  const listen = make("heard", async (file, options) => { asked.push([options.seconds, options.bpm]); return { change: { at: 12, kind: "drop" }, voice: [[0, 2]], by: "whisper" }; });
  const found = await listen.search("p1", "walking tour edit", { count: 1 });
  const id = found.results[0].id;
  assert.equal((await listen.reference(id, { wait: 3000 })).state, "measured");
  await listen.setSaved("p1", id);
  const [saved] = await listen.savedFingerprints("p1");
  assert.deepEqual(saved.heard, { change: { at: 12, kind: "drop" }, voice: [[0, 2]], by: "whisper" });
  assert.deepEqual(asked, [[30, 6]]);
  assert.deepEqual(saved.seen, [], "the on-screen labels (seen) travel with each saved fingerprint; none yet");
  // The fingerprint text says what reference_range compares: dark share and what was heard.
  const lines = fingerprintLines({ id: "yt:x", fingerprint: { look: { brightness: 0.2, darkShare: 0.1, palette: [] } }, heard: saved.heard }).join("\n");
  assert.match(lines, /look: brightness 0\.2 · dark 10%/);
  assert.match(lines, /heard: loudest change 12 s \(drop\) · voice 0-2 s/);
  let tries = 0;
  const failed = make("heard-failed", async () => { tries += 1; if (tries === 1) throw new Error("no sound"); return { change: { at: 5, kind: "drop" }, voice: [], by: "whisper" }; });
  const second = (await failed.search("p1", "walking tour edit", { count: 1 })).results[0].id;
  assert.equal((await failed.reference(second, { wait: 3000 })).state, "measured");
  await failed.setSaved("p1", second);
  const [left] = await failed.savedFingerprints("p1");
  assert.ok(left.heard === undefined && !left.heardPending, "left out, and not measured unless a full check asks");
  // A full check asks: it is measured in the background (pending until then), once.
  assert.equal((await failed.savedFingerprints("p1", { heardLater: true }))[0].heardPending, true);
  assert.match((await failed.reference(second)).state, /^(queued|measuring)$/, "it waits in the measuring queue, never beside a measure");
  let later;
  for (let wait = 0; wait < 60 && !later?.heard; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    [later] = await failed.savedFingerprints("p1", { heardLater: true });
  }
  assert.deepEqual(later.heard, { change: { at: 5, kind: "drop" }, voice: [], by: "whisper" });
  assert.equal(tries, 2);
  assert.equal((await failed.reference(second)).state, "measured", "only its voice facts were measured again");
});

test("a sounds search keeps sound effects of 60 s or less, measures their shape, keeps a preview, imports it with credit; forget drops a search", async () => {
  const { writeFile } = await import("node:fs/promises");
  const directory = path.join(folder, "sounds");
  const projects = memoryProjects();
  const asked = [];
  const added = [];
  // 1000 samples a second: 0.5 s of silence, a 1 s burst loudest 0.8 s into it, then silence.
  const samples = new Float32Array(3000);
  for (let index = 500; index < 1500; index += 1) samples[index] = 0.2 * Math.sin(index);
  samples[1300] = 0.9;
  const inspire = createInspire({
    directory, projectState: projects,
    search: async (query, { count }) => { asked.push([query, count]); return parseSearchLines(await readFile(RECORDED, "utf8")); },
    downloadSound: async (videoId, work) => { const file = path.join(work, "sound.webm"); await writeFile(file, "audio"); return file; },
    decodeSound: async () => ({ samples, sampleRate: 1000 }),
    soundPreview: async (file, target, { start, end }) => writeFile(target, `aac ${start}-${end}`),
    soundLoudness: async () => -18.04,
    addMedia: async (file, options) => { added.push({ bytes: await readFile(file, "utf8"), ...options }); return { id: "m.m4a", src: "/api/media/m.m4a", ...options.extra }; },
    // A stub CLAP: each sound's vector from its sounding stretch's length; the words point at it.
    embedSound: async (part) => ({ model: "stub", vector: encodeVector(normalize(Float32Array.from({ length: 4 }, (_, i) => (i === 0 ? 1 : part.length / 4000)))) }),
    embedText: async (prompts) => prompts.map(() => normalize(Float32Array.from([1, 0.25, 0.25, 0.25]))),
    embedModel: "stub", soundTaste: { read: async () => ({ liked: [], rejected: [] }) },
  });
  const found = await inspire.search("p1", "whoosh", { kind: "sounds" });
  assert.deepEqual(asked, [["whoosh sound effect", 20]], "8 spare results for the junk filter");
  assert.equal(found.search.kind, "sounds");
  assert.deepEqual(found.results.map((ref) => [ref.id, ref.kind]), [["yt:ghBpKLARE_8", "sound"]], "only 60 s or less, and a 60 s upload is junk when a whoosh is asked");
  const ref = await inspire.reference("yt:ghBpKLARE_8", { wait: 2000 });
  assert.equal(ref.state, "measured");
  assert.equal(ref.sound.peaks.length, 64);
  assert.ok(ref.sound.peaks.every((value) => value >= 0 && value <= 1) && ref.sound.peaks.includes(1));
  assert.deepEqual([ref.sound.start, ref.sound.end, ref.sound.length, ref.sound.peakAt, ref.sound.loudness], [0.5, 1.5, 1, 0.8, -18]);
  assert.equal(await readFile(await inspire.soundFile("yt:ghBpKLARE_8"), "utf8"), "aac 0.5-1.5");
  assert.equal(await inspire.soundFile("yt:tgEWNHVbk3U"), null);
  // Its CLAP embedding is kept (not sent to the screen) and ranks it against the search words.
  assert.equal(ref.sound.embedded, true);
  assert.equal(ref.sound.embedding, undefined);
  const ranks = (await inspire.projectView("p1")).searches[0].ranks;
  assert.deepEqual([ranks["yt:ghBpKLARE_8"].match, ranks["yt:ghBpKLARE_8"].order], [75, 1], "a lone sound: full marks absolute, the middle of its pool");
  assert.equal((await inspire.searchView("p1", 1)).ranks["yt:ghBpKLARE_8"].order, 1);
  assert.equal((await inspire.soundTasteEntry("yt:ghBpKLARE_8")).measure.embedding.model, "stub");
  assert.match(searchText("whoosh", [ref], { kind: "sounds" }), /^1\) yt:ghBpKLARE_8 "Fast Cuts SFX[^"]*" 1 s, peak 0\.8 s, -18 LUFS/m);
  // Import: the preview with its credit (YouTube does not say its license).
  const media = await inspire.importSound("yt:ghBpKLARE_8");
  assert.equal(added[0].bytes, "aac 0.5-1.5");
  assert.equal(added[0].mime, "audio/mp4");
  assert.deepEqual([media.credit.title, media.credit.channel, media.credit.url, media.credit.license], ["Fast Cuts SFX - Cinematic Sound Effects for Fast Edit Sequences", "Lens Distortions", "https://www.youtube.com/watch?v=ghBpKLARE_8", "unknown"]);
  assert.equal(await inspire.importSound("yt:tgEWNHVbk3U"), null, "a video is never imported");
  // forget drops the search; the measured sound stays in the cache.
  await inspire.search("p1", "riser", { kind: "sounds" });
  await inspire.forget("p1", 1);
  assert.deepEqual((await inspire.projectView("p1")).searches.map((search) => search.n), [2]);
  await assert.rejects(inspire.forget("p1", 9), /no search 9/);
  assert.ok((await inspire.reference("yt:ghBpKLARE_8")).sound);
  inspire.cancel();
});

test("with looks, a search ranks by thumbnails, collapses copies, learns from unsaved ones, and a measure keeps one vector a shot", async () => {
  const directory = path.join(folder, "looks");
  const projects = memoryProjects();
  // Each thumbnail's bytes are its video id; the stub model gives each id a look.
  const axes = { tgEWNHVbk3U: 0, ghBpKLARE_8: 0, J0ydlAqg6_8: 1 };
  const embedded = [];
  const look = {
    model: LOOK_MODEL,
    failed: () => null,
    images: async (files) => {
      embedded.push(...files);
      return { model: LOOK_MODEL, vectors: await Promise.all(files.map(async (file) => encodeVector(axis(axes[(await readFile(file, "utf8")).trim()] ?? 4)))) };
    },
    text: async (prompts) => prompts.map(() => axis(1)),
  };
  let releaseDownload;
  const inspire = createInspire({
    directory, projectState: projects, look,
    search: async (query, { count }) => parseSearchLines(await readFile(RECORDED, "utf8")).slice(0, count),
    fetchThumb: async (url) => Buffer.from(/\/vi\/([^/]+)\//.exec(url)[1]),
    download: async (videoId, workFolder) => {
      await new Promise((resolve) => { releaseDownload = resolve; });
      const file = path.join(workFolder, "clip.mp4");
      await (await import("node:fs/promises")).writeFile(file, "clip");
      return file;
    },
    probe: async () => ({ duration: 30, width: 640, height: 360 }),
    findShots: async () => ({ shots: [{ start: 0 }, { start: 10 }, { start: 20 }] }),
    findBeats: async () => ({ beats: [], bpm: null }),
    stills: async (file, seconds, stillFolder) => {
      await (await import("node:fs/promises")).mkdir(stillFolder, { recursive: true });
      const made = [];
      for (let at = 0; at < 30; at += 1) {
        const name = `${String(at).padStart(2, "0")}.jpg`;
        await (await import("node:fs/promises")).writeFile(path.join(stillFolder, name), "J0ydlAqg6_8");
        made.push({ at, file: name });
      }
      return made;
    },
  });
  // The words look like J0ydlAqg6_8; ghBpKLARE_8 has the same thumbnail as tgEWNHVbk3U, which has fewer views.
  const found = await inspire.search("p1", "story cuts", { count: 3 });
  assert.deepEqual(found.results.map((ref) => ref.id), ["yt:J0ydlAqg6_8", "yt:ghBpKLARE_8"]);
  assert.deepEqual(found.collapsed, [{ id: "yt:tgEWNHVbk3U", into: "yt:ghBpKLARE_8" }]);
  assert.deepEqual(found.results[1].copies, ["yt:tgEWNHVbk3U"]);
  assert.deepEqual(found.search.collapsed, found.collapsed);
  assert.match(searchText("story cuts", found.results, { collapsed: found.collapsed }), /1 near-identical copy hidden \(yt:tgEWNHVbk3U = yt:ghBpKLARE_8\)/);
  // Unsaving a reference rejects its look; saving it again takes that back.
  await inspire.setSaved("p1", "yt:J0ydlAqg6_8");
  await inspire.setSaved("p1", "yt:J0ydlAqg6_8", false);
  assert.deepEqual(projects.states.get("p1").rejected, ["yt:J0ydlAqg6_8"]);
  // The measure: one vector a shot, from the still nearest each shot's middle (5, 15, 25 s).
  for (let tries = 0; tries < 200 && !releaseDownload; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  releaseDownload();
  await inspire.reference("yt:J0ydlAqg6_8", { wait: 2000 });
  const saved = JSON.parse(await readFile(path.join(directory, "J0ydlAqg6_8.json"), "utf8"));
  assert.deepEqual(saved.look.at, [5, 15, 25]);
  assert.equal(saved.look.vectors.length, 3);
  assert.equal(saved.same, false);
  inspire.cancel();
});

test("a sound effect search waits only behind other sounds, never behind queued videos", async () => {
  const directory = path.join(folder, "sound-first");
  const releases = [];
  const inspire = createInspire({
    directory, projectState: memoryProjects(),
    search: async (query, { count }) => parseSearchLines(await readFile(RECORDED, "utf8")).slice(0, count),
    download: async () => new Promise((resolve, reject) => releases.push(reject)),
    downloadSound: async () => new Promise((resolve, reject) => releases.push(reject)),
  });
  const videos = await inspire.search("p1", "trailer");
  const sounds = await inspire.search("p1", "whoosh", { kind: "sounds" });
  const sound = await inspire.reference(sounds.results[0].id);
  const lastVideo = await inspire.reference(videos.results.at(-1).id);
  assert.equal(sound.place, 1, "next after the video being measured");
  assert.ok(lastVideo.place > sound.place);
  inspire.cancel();
  for (const reject of releases) reject(new Error("stopped"));
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("a whole measure through a stub yt-dlp: the generated video's cuts and beat are found, and the copy is deleted", { skip: skipWithoutMediaTools }, async () => {
  // 6 s: cuts at 1, 2, 3.24 and 4.52 s; a kick and a click every 0.5 s (120 bpm). The cuts at 1,
  // 2 and 4.5 are on the beat, the one at 3.24 is not.
  const video = path.join(folder, "generated.mp4");
  await run(ffmpeg, ["-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=1", "-f", "lavfi", "-i", "smptebars=s=320x180:r=25:d=1",
    "-f", "lavfi", "-i", "mandelbrot=s=320x180:r=25", "-f", "lavfi", "-i", "rgbtestsrc=s=320x180:r=25:d=1.25",
    "-f", "lavfi", "-i", "cellauto=s=320x180:r=25:rule=110",
    "-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*70*t)*exp(-25*mod(t,0.5))+0.3*sin(2*PI*1500*t)*exp(-80*mod(t,0.5))':s=22050:d=6",
    "-filter_complex", "[2:v]trim=duration=1.25,setpts=PTS-STARTPTS[m];[4:v]trim=duration=1.5,setpts=PTS-STARTPTS[c];[0:v][1:v][m][3:v][c]concat=n=5:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "5:a", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", video]);
  process.env.STUB_YTDLP_VIDEO = video;
  process.env.KINO_INSPIRE_THUMBS = "off";
  try {
    const directory = path.join(folder, "whole");
    const inspire = createInspire({ directory, projectState: memoryProjects(), ...(await inspireTools({ command: STUB })) });
    const found = await inspire.search("p1", "fast cut walking edit", { by: "you", count: 1 });
    const ref = await inspire.reference(found.results[0].id, { wait: 60_000 });
    assert.equal(ref.state, "measured", ref.error);
    assert.equal(ref.numbers.shots, 5);
    assert.deepEqual(ref.numbers.cuts.map((time) => Math.round(time * 4) / 4), [1, 2, 3.25, 4.5]);
    assert.deepEqual(ref.numbers.onBeat, [true, true, false, true]);
    assert.equal(ref.bpm, 120);
    assert.equal(ref.thumb, false, "no thumbnail when they are off");
    // The fingerprint and the small frame strips stay (Vision numbers only where Vision runs).
    assert.equal(ref.fingerprintError, undefined);
    assert.ok(ref.print && ref.strips > 0, JSON.stringify(ref.print));
    const full = await inspire.reference(found.results[0].id, { full: true });
    assert.equal(full.fingerprint.shots.count, 5);
    assert.deepEqual((await readdir(path.join(directory, "strips", found.results[0].id.slice(3)))).length, ref.strips);
    assert.deepEqual(await readdir(path.join(directory, "work")), [], "the downloaded copy is gone");
    // 10 stills at the copy's own size stay for judge rounds.
    await inspire.setSaved("p1", found.results[0].id);
    const [kept] = await inspire.savedStills("p1");
    assert.equal(kept.stills.length, 10);
    const { loadImage } = await import("@napi-rs/canvas");
    const still = await loadImage(await readFile(path.join(kept.folder, kept.stills[0].file)));
    assert.deepEqual([still.width, still.height], [320, 180]);
  } finally {
    delete process.env.STUB_YTDLP_VIDEO;
    delete process.env.KINO_INSPIRE_THUMBS;
  }
});

test("a saved reference measured before stills were kept is measured again when a judge round needs them", async () => {
  const directory = path.join(folder, "stills-again");
  const projects = memoryProjects();
  const fake = {
    search: async (query, { count }) => parseSearchLines(await readFile(RECORDED, "utf8")).slice(0, count),
    download: async (videoId, workFolder) => path.join(workFolder, "clip.mp4"),
    probe: async () => ({ duration: 20 }),
    findShots: async () => ({ shots: [{ start: 0 }] }),
    findBeats: async () => ({ beats: [], bpm: null }),
  };
  const old = createInspire({ directory, projectState: projects, ...fake });
  const found = await old.search("p1", "walking tour edit", { by: "you", count: 1 });
  const id = found.results[0].id;
  assert.equal((await old.reference(id, { wait: 5000 })).state, "measured");
  await old.setSaved("p1", id);
  assert.deepEqual(await old.savedStills("p1"), [], "no stills yet");
  // bare lists it anyway (a board's ref key can match it); ids picks which saved ones are read.
  assert.deepEqual((await old.savedStills("p1", { bare: true })).map((ref) => [ref.id, ref.stills]), [[id, []]]);
  assert.deepEqual(await old.savedStills("p1", { bare: true, ids: ["yt:other"] }), []);
  const asked = [];
  const now = createInspire({ directory, projectState: projects, ...fake, stills: async (file, seconds) => { asked.push(seconds); return [{ at: 1, file: "00.jpg" }]; } });
  const [kept] = await now.savedStills("p1", { wait: 5000 });
  assert.deepEqual(asked, [20]);
  assert.deepEqual(kept.stills, [{ at: 1, file: "00.jpg" }]);
});

test("yt-dlp gets a JavaScript runtime for YouTube's challenge: deno, else node, else bun, or says plainly there is none", async () => {
  const has = (...paths) => (candidate) => paths.includes(candidate);
  assert.deepEqual(jsRuntime({ PATH: "/usr/bin" }, has("/opt/homebrew/bin/deno", "/opt/homebrew/bin/node"), null), { name: "deno", path: "/opt/homebrew/bin/deno" });
  assert.deepEqual(jsRuntime({ PATH: "/x" }, has("/x/bun", "/usr/local/bin/node"), null), { name: "node", path: "/usr/local/bin/node" });
  assert.deepEqual(jsRuntime({ PATH: "/x" }, has("/x/bun"), null), { name: "bun", path: "/x/bun" });
  assert.deepEqual(jsRuntime({ PATH: "/x" }, has(), "/kino/node"), { name: "node", path: "/kino/node" }, "kino's own node when nothing else");
  assert.equal(jsRuntime({ PATH: "/x" }, has(), null), null);
  assert.deepEqual(jsRuntime({ KINO_YTDLP_JS: "bun:/opt/bun" }, has(), null), { name: "bun", path: "/opt/bun" });
  assert.deepEqual(jsRuntime({ KINO_YTDLP_JS: "/somewhere/deno" }, has(), null), { name: "deno", path: "/somewhere/deno" });
  assert.match(NO_JS_RUNTIME, /deno, node or bun.*KINO_YTDLP_JS/);
  // The PATH yt-dlp runs with includes the usual install folders even when kino's is short.
  assert.ok(toolPath({ PATH: "/usr/bin" }).split(path.delimiter).includes("/opt/homebrew/bin"));
  // A download names the runtime.
  const log = path.join(folder, "js.log");
  process.env.STUB_YTDLP_LOG = log;
  process.env.STUB_YTDLP_FAIL = "download";
  process.env.KINO_YTDLP_JS = "node:/kino/test/node";
  try {
    const tools = await inspireTools({ command: STUB });
    await assert.rejects(tools.download("tgEWNHVbk3U", folder), /Video unavailable/);
  } finally {
    delete process.env.STUB_YTDLP_LOG;
    delete process.env.STUB_YTDLP_FAIL;
    delete process.env.KINO_YTDLP_JS;
  }
  const args = JSON.parse((await readFile(log, "utf8")).trim());
  assert.equal(args[args.indexOf("--js-runtimes") + 1], "node:/kino/test/node");
});

test("a search cut off when kino stopped shows as failed, not as searching forever", async () => {
  const projects = memoryProjects();
  projects.states.set("p1", { searches: [{ n: 1, query: "walk", by: "you", state: "searching", wanted: 8, ids: [] }], saved: [], nextSearch: 2 });
  const inspire = createInspire({ directory: path.join(folder, "restart"), projectState: projects });
  assert.deepEqual((await inspire.projectView("p1")).searches.map((search) => [search.state, search.error]), [["failed", "kino stopped before this search finished"]]);
});

test("YouTube's bot check is said plainly, and kino stops asking YouTube until told to try again", async () => {
  const log = path.join(folder, "bot.log");
  process.env.STUB_YTDLP_FAIL = "bot";
  process.env.STUB_YTDLP_LOG = log;
  process.env.KINO_INSPIRE_THUMBS = "off";
  try {
    const inspire = createInspire({ directory: path.join(folder, "bot"), projectState: memoryProjects(), ...(await inspireTools({ command: STUB })) });
    const found = await inspire.search("p1", "walk", { by: "you", count: 3 });
    const last = await inspire.reference(found.results[2].id, { wait: 20_000 });
    assert.equal(last.state, "failed");
    assert.equal(last.error, BOT_CHECK);
    for (const ref of found.results) assert.equal((await inspire.reference(ref.id)).error, BOT_CHECK);
    const downloads = () => readFile(log, "utf8").then((text) => text.trim().split("\n").filter((line) => line.includes("--download-sections")).length);
    assert.equal(await downloads(), 1, "after the bot check, the others are not asked for");
    // Asking for one again tries it at once.
    await inspire.remeasure(found.results[1].id);
    await inspire.reference(found.results[1].id, { wait: 20_000 });
    assert.equal(await downloads(), 2);
  } finally {
    delete process.env.STUB_YTDLP_FAIL;
    delete process.env.STUB_YTDLP_LOG;
    delete process.env.KINO_INSPIRE_THUMBS;
  }
});

test("a bot check in inspire pauses every YouTube download through the shared gate, footage too", async () => {
  const youtube = createYouTubeGate({ gapMs: 0 });
  const inspire = createInspire({ directory: path.join(folder, "gate"), projectState: memoryProjects(), youtube,
    search: async (query, { count }) => parseSearchLines(await readFile(RECORDED, "utf8")).slice(0, count),
    download: async () => { throw botCheckError(); }, probe: async () => ({ duration: 1 }), findShots: async () => ({ shots: [] }), findBeats: async () => ({ beats: [] }) });
  const found = await inspire.search("p1", "walk", { by: "you", count: 1 });
  assert.equal((await inspire.reference(found.results[0].id, { wait: 5000 })).error, BOT_CHECK);
  let footage = 0;
  await assert.rejects(youtube(async () => { footage += 1; }), { code: "BOT_CHECK" });
  assert.equal(footage, 0, "the footage download is not tried while the pause lasts");
  await youtube(async () => { footage += 1; }, { force: true });
  assert.equal(footage, 1);
});

test("two YouTube downloads never overlap and the next waits the gap after the last one ends", async () => {
  const spans = [];
  const slotWhileWaiting = [];
  const youtube = createYouTubeGate({ gapMs: 40, wait: (ms) => {
    slotWhileWaiting.push(heavyDecodeSlot.running());
    return new Promise((resolve) => setTimeout(resolve, ms));
  } });
  const download = () => youtube(async () => {
    const span = { start: performance.now() };
    assert.equal(heavyDecodeSlot.running(), 1, "a download holds the heavy decode slot");
    await new Promise((resolve) => setTimeout(resolve, 20));
    span.end = performance.now();
    spans.push(span);
  });
  await Promise.all([download(), download()]);
  assert.ok(spans[1].start - spans[0].end >= 35, `gap ${spans[1].start - spans[0].end} ms`);
  assert.ok(slotWhileWaiting.length > 0 && slotWhileWaiting.every((held) => held === 0), "the gap is waited out with the heavy decode slot free");
  // A download aborted before it starts never reaches YouTube, so the next one waits no new gap.
  await new Promise((resolve) => setTimeout(resolve, 45));
  const aborted = AbortSignal.abort();
  await assert.rejects(youtube(async () => { throw aborted.reason; }, { signal: aborted }));
  slotWhileWaiting.length = 0;
  await download();
  assert.equal(slotWhileWaiting.length, 0, "no gap after an aborted download");
});

test("region, members-only, age and private videos are dropped with one line, not taken for a bot check", () => {
  assert.equal(cannotPlayReason("ERROR: [youtube] abc: The uploader has not made this video available in your country"), "region");
  assert.equal(cannotPlayReason("ERROR: [youtube] abc: Join this channel to get access to members-only content like this video"), "members only");
  assert.equal(cannotPlayReason("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users."), "age");
  assert.equal(cannotPlayReason("ERROR: [youtube] abc: Sign in to confirm you're not a bot"), null);
  assert.equal(cannotPlayLine("F3", "region", "F4"), "F3 cannot play from here (region). Dropped; F4 is next.");
});
