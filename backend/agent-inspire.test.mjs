// Inspire through the agent service on a real server (POST /api/agent/<verb>) and the dashboard
// routes, with a stub yt-dlp (tests/fixtures/inspire/stub-yt-dlp.mjs) and a generated video, so
// nothing goes online: library {topic:"inspire"} searches, measures and saves; edit
// borrow_rhythm turns the cuts into cue marks; the dashboard's snapshot carries it all.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const STUB = fileURLToPath(new URL("../tests/fixtures/inspire/stub-yt-dlp.mjs", import.meta.url));
// Best first: the most viewed of the recorded search, sixth on YouTube's own list.
const FIRST = "yt:OAH0MoAv2CI";
const LAST = "yt:RpowN_JNIsQ";

let server;
let folder;
before(async () => {
  if (skipWithoutMediaTools) return;
  folder = await mkdtemp(path.join(tmpdir(), "kino-agent-inspire-"));
  // 6 s with cuts at 1, 2, 3.24 and 4.52 s and a beat every 0.5 s (see inspire.test.mjs).
  const video = path.join(folder, "generated.mp4");
  await run(ffmpeg, ["-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=1", "-f", "lavfi", "-i", "smptebars=s=320x180:r=25:d=1",
    "-f", "lavfi", "-i", "mandelbrot=s=320x180:r=25", "-f", "lavfi", "-i", "rgbtestsrc=s=320x180:r=25:d=1.25",
    "-f", "lavfi", "-i", "cellauto=s=320x180:r=25:rule=110",
    "-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*70*t)*exp(-25*mod(t,0.5))+0.3*sin(2*PI*1500*t)*exp(-80*mod(t,0.5))':s=22050:d=6",
    "-filter_complex", "[2:v]trim=duration=1.25,setpts=PTS-STARTPTS[m];[4:v]trim=duration=1.5,setpts=PTS-STARTPTS[c];[0:v][1:v][m][3:v][c]concat=n=5:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "5:a", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", video]);
  server = await startTestServer({ env: { KINO_YTDLP: STUB, KINO_INSPIRE_THUMBS: "off", STUB_YTDLP_VIDEO: video } });
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function asYou(verb, body) {
  const keyed = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  const { key } = await keyed.json();
  const response = await server.api(`/api/dashboard/act/${verb}`, { method: "POST", headers: { "x-kino-review": key }, body });
  assert.equal(response.status, 200);
  return response.json();
}

test("an agent searches YouTube, reads one reference's cuts and borrows its rhythm as cue marks", { skip: skipWithoutMediaTools }, async () => {
  await agent("project", { action: "create", id: "insp", name: "Inspire", width: 640, height: 360, duration: 3 });
  const found = await agent("library", { topic: "inspire", project: "insp", search: "fast cut walking edit" });
  assert.match(found.text, /^inspire "fast cut walking edit": 6 found on YouTube/);
  assert.match(found.text, /1\) yt:OAH0MoAv2CI 'Cuts & Transitions 101' · RocketJump Film School · 11:41 · 4\.5M views/);
  assert.ok(found.text.length < 8000 * 2, "small answer");

  // The last result still waits its turn: its rhythm cannot be borrowed yet.
  const early = await agent("edit", { project: "insp", ops: [{ op: "borrow_rhythm", ref: LAST, fit: true }] });
  assert.equal(early.isError, true);
  assert.match(early.text, /not measured yet/);

  const one = await agent("library", { topic: "inspire", project: "insp", name: FIRST });
  assert.match(one.text, /measured the first 6 s of 11:41: 5 shots · 0\.67 cuts\/s · longest 1\.5 s \(the end\) · cuts on the beat 3 of 4 \(120 bpm\)/);
  // The fingerprint and the frame strips kept around its cuts; look shows them.
  assert.match(one.text, /^fingerprint \(numbers only/m);
  assert.match(one.text, /^frame strips kept: \d+ .*look \{mode:"reference", ref:"yt:OAH0MoAv2CI", t:/m);
  const strips = await agent("look", { project: "insp", mode: "reference", ref: FIRST, t: 2 });
  assert.match(strips.text, /^reference yt:OAH0MoAv2CI strips \(nearest 2s\): .*2(\.\d+)?s cut/);
  assert.equal(strips.images.length, 1);
  assert.equal((await agent("look", { project: "insp", mode: "reference", ref: "yt:dQw4w9WgXcQ" })).isError, true);

  const borrowed = await agent("edit", { project: "insp", ops: [{ op: "borrow_rhythm", ref: FIRST, fit: true }] });
  assert.notEqual(borrowed.isError, true, borrowed.text);
  const record = await (await server.api("/api/projects/insp")).json();
  const cues = record.document.cues.filter((cue) => cue.name.startsWith("rhythm-"));
  assert.deepEqual(cues.map((cue) => cue.kind), ["marker", "marker", "marker", "marker"]);
  // The 6 s measured fit the 3 s scene: each cut at half its time.
  assert.deepEqual(cues.map((cue) => Math.round(cue.time * 8) / 8), [0.5, 1, 1.625, 2.25]);
  // Borrowing again (as measured, no fit) replaces them: only the cuts inside the 3 s scene stay.
  await agent("edit", { project: "insp", ops: [{ op: "borrow_rhythm", ref: FIRST }] });
  const again = (await (await server.api("/api/projects/insp")).json()).document.cues.filter((cue) => cue.name.startsWith("rhythm-"));
  assert.deepEqual(again.map((cue) => cue.time), [1, 2]);
  // The borrowed reference is saved in the project; nothing of the video is in it.
  const listed = await agent("library", { topic: "inspire", project: "insp" });
  assert.match(listed.text, /inspire searches \(name:"forget <n>" removes one\): 1\) "fast cut walking edit" 6 found · by agent/);
  assert.match(listed.text, /saved 1:\nyt:OAH0MoAv2CI/);
  assert.equal(JSON.stringify(record.document).includes("youtube"), false);
  // look reference without ref lists the saved ones; a new project copies them in one call.
  assert.match((await agent("look", { project: "insp", mode: "reference" })).text, /^saved references 1 \(.*\):\nyt:OAH0MoAv2CI "/);
  await agent("project", { action: "create", id: "insp-copy", name: "Inspire copy", width: 640, height: 360, duration: 3 });
  assert.match((await agent("look", { project: "insp-copy", mode: "reference" })).text, /^saved references: none/);
  const copied = await agent("library", { topic: "inspire", project: "insp-copy", name: "copy insp" });
  assert.match(copied.text, /^Copied 1 saved reference from insp to insp-copy \(1 saved\): yt:OAH0MoAv2CI\.\n/);
  const help = await agent("library", { topic: "op", name: "borrow_rhythm" });
  assert.match(help.text, /^borrow_rhythm \{ref, fit\?, at\?, scene\?\}/);
});

test("an agent proposes ideas from a reference; only the person turns them on or off and allows them", { skip: skipWithoutMediaTools }, async () => {
  const ideas = { ref: FIRST, take: [
    { title: "a quiet ending", from: 4.6, to: 6, what: "the last shot holds", why: "the stop lands after the speed", use: "end on a 2 s hold", place: { at: 1 } },
    { title: "fast cuts", from: 1, to: 3.3, what: "3 cuts in 2.3 s", why: "it wakes you up", use: "cut the opening fast", tags: ["fast-cuts"] },
  ], skip: [{ title: "the beat", why: "only 3 of 4 cuts land on it" }] };
  // The person cannot propose ideas, and an agent cannot answer them.
  assert.match((await asYou("library", { topic: "inspire", project: "insp", ideas })).text, /come from your agent/);
  await assert.rejects(agent("library", { topic: "inspire", project: "insp", ideas: { ref: FIRST, take: [{ title: "x", from: 99, what: "a", why: "b", use: "c" }] } }).then((reply) => { if (reply.isError) throw new Error(reply.text); }), /from is a time in the reference, 0 to 6 s/);
  const proposed = await agent("library", { topic: "inspire", project: "insp", ideas });
  assert.notEqual(proposed.isError, true, proposed.text);
  assert.match(proposed.text, /^I1: 2 ideas from yt:OAH0MoAv2CI wait for the person on the inspire screen \(F3\), with 1 skipped\.$/m);
  assert.match(proposed.text, /^1\) fast cuts \(0:01 to 0:03\): cut the opening fast$/m, "numbered in time order");
  assert.match(proposed.text, /^3\) skipped: the beat: only 3 of 4 cuts land on it$/m);
  assert.equal((await agent("library", { topic: "inspire", project: "insp", name: "allow ideas" })).isError, true);
  // The dashboard snapshot carries them, with the strips the screen draws.
  const snapshot = await (await server.api("/api/dashboard/snapshot?project=insp")).json();
  assert.equal(snapshot.inspire.ideas.status, "waiting");
  assert.deepEqual(snapshot.inspire.ideas.take.map((idea) => [idea.n, idea.title, idea.on]), [[1, "fast cuts", true], [2, "a quiet ending", true]]);
  assert.ok(snapshot.inspire.ideas.strips.length > 0 && snapshot.inspire.ideas.seconds === 6);
  const strip = await server.api(`/api/dashboard/inspire/strip/OAH0MoAv2CI/${snapshot.inspire.ideas.strips[0].file}`);
  assert.equal(strip.status, 200);
  assert.equal(strip.headers.get("content-type"), "image/jpeg");
  assert.equal((await server.api("/api/dashboard/inspire/strip/OAH0MoAv2CI/..%2Fx.json")).status, 404);
  // The person turns 2 off and 3 (skipped) on, then allows.
  assert.match((await asYou("library", { topic: "inspire", project: "insp", name: "idea 2 off" })).text, /a quiet ending: off/);
  assert.match((await asYou("library", { topic: "inspire", project: "insp", name: "idea 3" })).text, /the beat: on/);
  const allowed = await asYou("library", { topic: "inspire", project: "insp", name: "allow ideas", note: "keep it short" });
  assert.match(allowed.text, /^Allowed 2 ideas/);
  assert.equal((await asYou("library", { topic: "inspire", project: "insp", name: "allow ideas" })).isError, true, "answered once");
  // The agent hears it on its next call.
  const next = await agent("status", { project: "insp" });
  assert.match(next.text, /I1 allowed by the person: use 1 "fast cuts" \(0:01 to 0:03\): cut the opening fast; 3 "the beat" \(you skipped it; the person wants it anyway\)\. Not using: 2 "a quiet ending"\. Their note: "keep it short"\./);
});

test("the person searches and unsaves from the dashboard; the snapshot carries searches, refs and numbers", { skip: skipWithoutMediaTools }, async () => {
  const searched = await asYou("library", { topic: "inspire", project: "insp", search: "vlog hyperlapse" });
  assert.match(searched.text, /"vlog hyperlapse": 6 found/);
  const unsaved = await asYou("library", { topic: "inspire", project: "insp", name: `unsave ${FIRST}` });
  assert.match(unsaved.text, /Unsaved yt:OAH0MoAv2CI in insp \(0 saved\)/);
  const snapshot = await (await server.api("/api/dashboard/snapshot?project=insp")).json();
  const { inspire } = snapshot;
  assert.deepEqual(inspire.searches.map((search) => [search.query, search.count, search.by === "you" ? "you" : search.by.name]),
    [["fast cut walking edit", 6, "agent"], ["vlog hyperlapse", 6, "you"]]);
  assert.deepEqual(inspire.saved, []);
  assert.equal(inspire.refs[FIRST].numbers.shots, 5);
  assert.equal((await server.api("/api/dashboard/inspire/thumb/OAH0MoAv2CI")).status, 404, "thumbnails are off in this test");
  assert.equal((await server.api("/api/dashboard/inspire/thumb/..%2Fx")).status, 404);
  // cancel stops what still waits; the work folder holds no video afterwards.
  const cancelled = await asYou("library", { topic: "inspire", project: "insp", name: "cancel" });
  assert.match(cancelled.text, /^(Stopped measuring|Nothing was being measured)/);
  for (let tries = 0; tries < 100; tries += 1) {
    const work = await readdir(path.join(server.dataDirectory, "inspire", "work")).catch(() => []);
    if (!work.length) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await readdir(path.join(server.dataDirectory, "inspire", "work")).catch(() => []), []);
});

test("an agent given a YouTube link measures it directly, as name or as search, with no search first", { skip: skipWithoutMediaTools }, async () => {
  // Not in the recorded search: kino reads its title and length with yt-dlp, then measures it.
  const one = await agent("library", { topic: "inspire", project: "insp", name: "measure yt:G9wj1YA0DYI" });
  assert.notEqual(one.isError, true, one.text);
  assert.match(one.text, /^yt:G9wj1YA0DYI 'Stub video G9wj1YA0DYI' · Stub channel · 0:57 · https:\/\/www\.youtube\.com\/watch\?v=G9wj1YA0DYI/);
  assert.match(one.text, /measured the first 6 s of 0:57: 5 shots/);
  // A full link in search is that one video too (here youtu.be, and one the recorded search knows).
  const linked = await agent("library", { topic: "inspire", project: "insp", search: "https://youtu.be/ghBpKLARE_8" });
  assert.notEqual(linked.isError, true, linked.text);
  assert.match(linked.text, /^yt:ghBpKLARE_8 'Fast Cuts SFX/);
  assert.match(linked.text, /measured all 6 s|measured the first 6 s/);
  // The screen shows each as a one-video search whose query is the link.
  const { inspire } = await (await server.api("/api/dashboard/snapshot?project=insp")).json();
  const link = inspire.searches.find((search) => search.ids?.[0] === "yt:G9wj1YA0DYI");
  assert.deepEqual([link.query, link.count, link.state], ["https://www.youtube.com/watch?v=G9wj1YA0DYI", 1, "done"]);
  assert.equal(inspire.refs["yt:G9wj1YA0DYI"].numbers.shots, 5);
  // Plain words that happen to be 11 letters stay a search.
  const words = await agent("library", { topic: "inspire", project: "insp", search: "walkingtour" });
  assert.match(words.text, /^inspire "walkingtour": 6 found/);
  // kind:"shorts" finds YouTube Shorts (vertical, /shorts/ links); a TikTok link is refused plainly.
  const shorts = await agent("library", { topic: "inspire", project: "insp", search: "app launch animation", kind: "shorts", count: 2 });
  // Best first: the 618-view Short (few views) is pushed below these two.
  assert.deepEqual(shorts.data.results.map((ref) => [ref.id, ref.vertical, ref.url.startsWith("https://www.youtube.com/shorts/")]), [["yt:-JUdWtzC1PY", true, true], ["yt:BDzufeEPQl0", true, true]]);
  const tiktok = await agent("library", { topic: "inspire", project: "insp", search: "https://www.tiktok.com/@scout2015/video/6718335390845095173" });
  assert.equal(tiktok.isError, true);
  assert.match(tiktok.text, /paste a YouTube Shorts link instead/);
  await agent("library", { topic: "inspire", project: "insp", name: "cancel" });
});

test("sound effects: a sounds search measures each, the dashboard plays its preview, import keeps the credit, forget drops the search", { skip: skipWithoutMediaTools }, async () => {
  const found = await asYou("library", { topic: "inspire", project: "insp", search: "fast cut", kind: "sounds" });
  assert.match(found.text, /^inspire sounds "fast cut": 2 sound effects on YouTube \(60 s or less\)/);
  const SOUND = "yt:ghBpKLARE_8";
  const one = await agent("library", { topic: "inspire", project: "insp", name: SOUND });
  assert.match(one.text, /^sound effect: [\d.]+ s, peak [\d.]+ s, -?[\d.]+ LUFS · sounds from [\d.]+ s to [\d.]+ s/m, one.text);
  assert.equal(one.data.ref.kind, "sound");
  assert.equal(one.data.ref.sound.peaks.length, 64);
  const preview = await server.api("/api/dashboard/inspire/sound/ghBpKLARE_8");
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "audio/mp4");
  assert.equal((await server.api("/api/dashboard/inspire/sound/OAH0MoAv2CI")).status, 404);
  const { inspire } = await (await server.api("/api/dashboard/snapshot?project=insp")).json();
  const search = inspire.searches.at(-1);
  assert.equal(search.kind, "sounds");
  // Import keeps the credit; a YouTube video stays refused.
  const imported = await agent("project", { action: "import", project: "insp", file: SOUND });
  assert.notEqual(imported.isError, true, imported.text);
  assert.equal(imported.data.media.mime, "audio/mp4");
  assert.deepEqual([imported.data.media.credit.channel, imported.data.media.credit.license], ["Lens Distortions", "unknown"]);
  const video = await agent("project", { action: "import", project: "insp", source: FIRST });
  assert.equal(video.isError, true);
  assert.match(video.text, /is not one of this video's songs yet\. As the song: .*; as footage: library \{topic/);
  const forgot = await asYou("library", { topic: "inspire", project: "insp", name: `forget ${search.n}` });
  assert.match(forgot.text, new RegExp(`^Forgot search ${search.n} \\("fast cut"\\)`));
  const after = (await (await server.api("/api/dashboard/snapshot?project=insp")).json()).inspire;
  assert.equal(after.searches.some((entry) => entry.n === search.n), false);
  await agent("library", { topic: "inspire", project: "insp", name: "cancel" });
});

test("without yt-dlp the search says how to install it",{ skip: skipWithoutMediaTools }, async () => {
  const missing = await startTestServer({ env: { KINO_YTDLP: path.join(folder, "no-yt-dlp"), KINO_INSPIRE_THUMBS: "off" } });
  try {
    const response = await missing.api("/api/agent/project", { method: "POST", body: { action: "create", id: "p", name: "p", width: 64, height: 64, duration: 1 } });
    assert.equal(response.status, 200);
    const answer = await (await missing.api("/api/agent/library", { method: "POST", body: { topic: "inspire", project: "p", search: "walk" } })).json();
    assert.equal(answer.isError, true);
    assert.match(answer.text, /yt-dlp is not installed, so kino cannot search YouTube\. Install it \(brew install yt-dlp\) or set KINO_YTDLP/);
    const link = await (await missing.api("/api/agent/library", { method: "POST", body: { topic: "inspire", project: "p", name: "measure yt:G9wj1YA0DYI" } })).json();
    assert.equal(link.isError, true);
    assert.match(link.text, /kino could not read yt:G9wj1YA0DYI from YouTube: yt-dlp is not installed/);
  } finally { await missing.stop(); }
});

test("the skill's inspire example runs as written (references/inspire.md)", { skip: skipWithoutMediaTools }, async () => {
  await agent("project", { action: "create", id: "skill-inspire", name: "Skill inspire", width: 1920, height: 1080, duration: 6, background: "#0b1020" });
  for (const { tool, ...call } of jsonBlocks(skillSection("Borrowing a rhythm from YouTube")).flat()) {
    const reply = await agent(tool, { project: "skill-inspire", ...call });
    assert.notEqual(reply.isError, true, `${tool} ${JSON.stringify(call)}: ${reply.text}`);
    if (tool === "edit") assert.equal(reply.data?.fixed, undefined, `kino had to fix ${JSON.stringify(call)}`);
  }
  const record = await (await server.api("/api/projects/skill-inspire")).json();
  assert.ok(record.document.cues.some((cue) => cue.name === "rhythm-3"));
  for (const { tool, ...call } of jsonBlocks(skillSection("Short vertical edits (YouTube Shorts)")).flat()) {
    const reply = await agent(tool, { project: "skill-inspire", ...call });
    assert.notEqual(reply.isError, true, `${tool} ${JSON.stringify(call)}: ${reply.text}`);
    assert.equal(reply.data.results[0].vertical, true, "the Shorts filter comes first");
  }
  for (const { tool, ...call } of jsonBlocks(skillSection("Fingerprint and frame strips")).flat()) {
    const reply = await agent(tool, { project: "skill-inspire", ...call });
    assert.notEqual(reply.isError, true, `${tool} ${JSON.stringify(call)}: ${reply.text}`);
  }
  for (const { tool, ...call } of jsonBlocks(skillSection("Proposing ideas to the person")).flat()) {
    const reply = await agent(tool, { project: "skill-inspire", ...call });
    assert.notEqual(reply.isError, true, `${tool} ${JSON.stringify(call)}: ${reply.text}`);
  }
});
