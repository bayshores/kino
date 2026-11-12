// The storyboard on the server (direction plan §5, milestone B4a), through the agent API on a
// real server: the edit op board saves every shot with every layer ("none" when empty) in the
// project document, refused when a layer is left out or the shots leave a gap in the music (when
// there is a music layer) or in the whole video; it is undone, restored and rebased like any
// edit. The board stop (notes checkpoint {id:"board"}) needs a saved board with no gap and its
// open items answered or left to the agent ("your call"); an approval freezes a copy of the board
// in the agent-state file, and later edits are measured against that copy: past kino's tolerances
// the approval lapses, smaller changes are logged.
//
// Footage: the Sintel test clip (tests/fixtures/footage/SOURCES.md), 384×216, 4.417 s, cuts at
// 1.25 s and 3.333 s. Sound: a sine tone made by FFmpeg, never played. Font downloads are off, so
// nothing here goes online. A recorded answer needs a real wait (gap(), three in the file).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SHOT_LAYERS } from "../engine/board.js";
import { evaluateLayer } from "../engine/animation.js";
import { BEAT_ANALYSIS_VERSION } from "../engine/beatDetection.js";
import { SONG_SHAPE_VERSION } from "./song-shape.mjs";
import { referenceHelp } from "./agent/blocks.mjs";
import { boardBuildOps } from "./agent/board-build.mjs";
import { boardCueLines, boardPaceFacts, boardStoryCues, builtBoard, sceneCueShows } from "./agent/board-pace.mjs";
import { cueDisagreement, cueShowLines } from "../engine/footage/cueShows.js";
import { estimateTextTokens } from "./meter.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer, withoutNext } from "./media.test.support.mjs";

const CLIP = fileURLToPath(new URL("../tests/fixtures/footage/sintel-village-dragon.mp4", import.meta.url));
const OFFLINE = { MOTION_FONT_DOWNLOADS: "off" };
const skip = skipWithoutMediaTools;

let server;
let folder;
let clip;
let song;
let key;
before(async () => {
  if (skip) return;
  server = await startTestServer({ env: OFFLINE });
  folder = await mkdtemp(path.join(tmpdir(), "kino-agent-board-"));
  clip = await upload(server, CLIP, "video/mp4");
  const tone = path.join(folder, "song.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=6", "-ac", "1", tone]);
  song = await upload(server, tone, "audio/wav");
  key = await reviewKey(server);
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function upload(target, file, type) {
  const response = await target.api("/api/media", { method: "POST", headers: { "content-type": type, "x-file-name": path.basename(file) }, body: await readFile(file) });
  assert.equal(response.status, 201, await response.clone().text());
  const media = await response.json();
  return { ...media, src: media.src ?? media.media?.src };
}

async function reviewKey(target) {
  return (await (await target.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: target.baseUrl } })).json()).key;
}

async function agent(verb, body = {}, on = server) {
  const response = await on.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function setting(body) {
  const response = await server.api("/api/dashboard/settings", { method: "PUT", headers: { "x-kino-review": key }, body });
  assert.equal(response.status, 200, await response.clone().text());
}

const record = async (project, on = server) => (await (await on.api(`/api/projects/${project}`)).json());
const savedState = async (project, root = server.dataDirectory) => JSON.parse(await readFile(path.join(root, "agent", "projects", `${project}.json`), "utf8"));
const statusLines = async (project, on = server) => (await agent("status", { project }, on)).text.split("\n").slice(1, 3);
const checkpoint = async (project, body = {}, on = server) => ({ ...(await agent("notes", { project, action: "checkpoint", id: "board", ...body }, on)), at: performance.now() });
const answer = (project, body, on = server) => agent("notes", { project, action: "answer", ...body }, on);
const clock = (at) => String(at).slice(11, 16);

// kino refuses an answer under 5 s after the ask (too_fast): wait out what is left of 5.2 s since
// the ask came back, on the steady clock (this PC's wall clock jumps by seconds).
async function gap(askedAt) {
  for (let left = askedAt + 5200 - performance.now(); left > 0; left = askedAt + 5200 - performance.now())
    await new Promise((resolve) => setTimeout(resolve, left));
}

// Shots. Footage: a 9:16 crop (h 76% of 216 px is 164 px; w 24% of 384 px is 92 px) with the
// dragon marked inside it. Motion design: no footage, a title.
const footage = (cue, dur, inPoint, x, extra = {}) => ({ cue, dur, pacing: "free", media: clip.src, in: inPoint, crop: [x, 12, 24, 76],
  subject: { what: "the dragon", box: [x + 4, 30, 14, 30] }, follow: "steady", text: "none", sound: "none", why: "the dragon over the village", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const motion = (cue, dur, extra = {}) => ({ cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: "The dragon is back", family: "Inter" }, sound: "none", why: "the line on its own", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const boardOp = (shots, extra = {}) => ({ op: "board", music: "none", shots, ...extra });
const editBoard = (project, shots, extra = {}, body = {}, on = server) => agent("edit", { project, ops: [boardOp(shots, extra)], ...body }, on);

// A refused board: op_failed with its boardError and kino's sentence.
function assertRefused(reply, boardError, message) {
  assert.equal(reply.isError, true, reply.text);
  assert.equal(reply.data.error, "op_failed", reply.text);
  assert.equal(reply.data.boardError, boardError, reply.text);
  assert.equal(reply.data.reason.replace(/^Operation \d+ \(board\) was refused: /, ""), message);
  // Never the op's usual one-shot board of another video as the retry (run 8 T244).
  assert.equal(reply.data.example, undefined, reply.text);
  assert.ok(!reply.text.includes("Ship faster"), reply.text);
}

// These tests are about the board, not the frame's shape: the person's own words name the
// vertical frame, so kino keeps 9:16 over the 16:9 clip. Without them kino gives the scene the
// footage's shape before a board is saved (agent-stops.test.mjs).
const VERTICAL = "a vertical cut of the dragon clip";
async function project(id, { width = 1080, height = 1920, duration = 6, layers = [], on = server } = {}) {
  const made = await agent("project", { action: "create", id, name: id, width, height, duration, background: "#101114" }, on);
  assert.equal(made.isError, undefined, made.text);
  if (height > width && layers.some((layer) => layer.layerType === "video")) {
    const named = await agent("notes", { project: id, action: "brief", fields: { ask: VERTICAL, plays_on: { text: "vertical", by: "you", quote: VERTICAL } } }, on);
    assert.equal(named.isError, undefined, named.text);
  }
  if (!layers.length) return made;
  const edited = await agent("edit", { project: id, ops: layers }, on);
  assert.equal(edited.isError, undefined, edited.text);
  return edited;
}
const videoLayer = () => ({ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src } });
const audioLayer = (name) => ({ op: "add_layer", layerType: "audio", name, properties: { src: song.src } });

test("look board prints the pace on each side of the song's drop and its beat times after it; board {snap:\"beats\"} moves the cuts there", { skip, timeout: 60_000 }, async () => {
  await project("pace", { width: 1920, height: 1080, layers: [audioLayer("song")] });
  const saved = await editBoard("pace", [motion(0, 1.5), motion(1.5, 1.5), motion(3, 1.2), motion(4.2, 1.8)], { music: "song" });
  assert.equal(saved.isError, undefined, saved.text);
  const plain = (await agent("look", { project: "pace", mode: "board" })).text;
  assert.doesNotMatch(plain, /pace:/, "no measured drop and no reference: the page reads as before");
  // The song's saved shape (a drop at 3 s) and beats (every 0.5 s from 0.05 s), as fit_music and detect_beats keep them.
  const file = path.join(server.dataDirectory, "media", path.basename(song.src));
  await writeFile(`${file}.song`, JSON.stringify({ version: SONG_SHAPE_VERSION, seconds: 6, whole: true, sections: [{ at: 0, kind: "intro" }, { at: 3, kind: "drop", weight: 1 }], seams: [] }));
  await writeFile(`${file}.beats`, JSON.stringify({ version: BEAT_ANALYSIS_VERSION, duration: 6, bpm: 120, period: 0.5, beats: Array.from({ length: 12 }, (_, index) => 0.05 + index * 0.5), onsets: [] }));
  const text = (await agent("look", { project: "pace", mode: "board" })).text;
  assert.ok(text.includes(plain.split("\n").slice(0, 6).join("\n")), "the header and shot lines stay as they were");
  assert.match(text, /pace: before the drop at 3\.00 s 2 shots, median 1\.50 s, 6\.7 per 10 s; after, 2 shots, median 1\.50 s, 6\.7 per 10 s/);
  assert.match(text, /the song's beats after the drop at 3\.00 s, every 2 beats \(1\.000 s; the section's range, no references\): 3\.05, 4\.05, 5\.05 · board \{snap:"beats"\}/);
  const snapped = await agent("edit", { project: "pace", ops: [{ op: "board", snap: "beats" }] });
  assert.equal(snapped.isError, undefined, snapped.text);
  assert.match(snapped.text, /snap: 2 cuts after the drop at 3(\.00)? s moved onto the beat \(every 2 beats; most 0\.15 s\)/);
  assert.deepEqual((await record("pace")).document.board.shots.map((shot) => shot.cue), [0, 1.5, 3.05, 4.05]);
  // The words an agent guesses first (snap:true), sent with a whole board: saved, then snapped, in one call.
  const both = await agent("edit", { project: "pace", ops: [boardOp([motion(0, 1.5), motion(1.5, 1.5), motion(3, 1.2), motion(4.2, 1.8)], { music: "song", snap: true })] });
  assert.equal(both.isError, undefined, both.text);
  assert.deepEqual((await record("pace")).document.board.shots.map((shot) => shot.cue), [0, 1.5, 3.05, 4.05], both.text);
  // A last shot of the 4.42 s clip from 2.6 s uses 1.8 s of it; moving its start to 4.05 would make it 1.95 s
  // and run past the file's end: that cut keeps its time and the answer says which.
  const whole = { crop: [0, 0, 100, 100], subject: { what: "the dragon", box: [30, 30, 30, 30] } };
  const past = await agent("edit", { project: "pace", ops: [boardOp([motion(0, 1.5), motion(1.5, 1.5), motion(3, 1.2), footage(4.2, 1.8, 2.6, 0, whole)], { music: "song", snap: "beats" })] });
  assert.equal(past.isError, undefined, past.text);
  assert.deepEqual((await record("pace")).document.board.shots.map((shot) => shot.cue), [0, 1.5, 3.05, 4.2], past.text);
  assert.match(past.text, /1 cut stayed because a shot would run past the end of its clip file: 4\.2 s \(the beat at 4\.05 s\)/);
  // What plays on the drop: a title is new; the clip rewound 0.5 s is a repeat (board answer, look
  // board), and the same two layers built say so in check.
  assert.match(text, /^on the drop at 3\.00 s: shot 3 new \(no footage\)$/m);
  const repeat = await editBoard("pace", [footage(0, 3, 0, 0, whole), footage(3, 1.2, 2.5, 0, whole), motion(4.2, 1.8)], { music: "song" });
  assert.equal(repeat.isError, undefined, repeat.text);
  assert.match(repeat.text, /on the drop at 3\.00 s: shot 2 \(sintel-village-dragon\.mp4\) repeats 0\.5 s of file 2\.5-3\.7 s shown at 0-3 s/);
  assert.match(repeat.text, /one take fills 70% of the edit: sintel-village-dragon\.mp4 \(4\.2 s\)/);
  // A board with footage measures the song in the background, which replaces the test's shape: write it again.
  const shape = JSON.stringify({ version: SONG_SHAPE_VERSION, seconds: 6, whole: true, sections: [{ at: 0, kind: "intro" }, { at: 3, kind: "drop", weight: 1 }], seams: [] });
  await writeFile(`${file}.song`, shape);
  assert.match((await agent("look", { project: "pace", mode: "board" })).text, /on the drop at 3\.00 s: shot 2 \(sintel-village-dragon\.mp4\) repeats 0\.5 s/);
  const take = (name, mediaStart, mediaOffset, mediaDuration) => ({ op: "add_layer", layerType: "video", name, properties: { src: clip.src, mediaStart, mediaOffset, mediaDuration } });
  assert.equal((await agent("edit", { project: "pace", ops: [take("climb", 0, 0, 3), take("again", 3, 2.5, 1.2)] })).isError, undefined);
  assert.match((await agent("check", { project: "pace" })).text, /on the drop at 3\.00 s: layer again \(sintel-village-dragon\.mp4\) repeats 0\.5 s of file 2\.5-3\.7 s shown at 0-3 s/);
  // A shot with drop:true pins the drop: fit_music with no payoff puts the song's heard drop (3 s) on that shot's cut (1.5 s).
  assert.equal((await editBoard("pace", [motion(0, 1.5), motion(1.5, 1.5, { drop: true }), motion(3, 1.2), motion(4.2, 1.8)], { music: "song" })).isError, undefined);
  // bars:null: kept as measured with the beats (no fresh measure of the tone).
  await writeFile(`${file}.song`, JSON.stringify({ ...JSON.parse(shape), bars: null }));
  const fit = await agent("edit", { project: "pace", ops: [{ op: "fit_music", layer: "song" }] });
  assert.equal(fit.isError, undefined, fit.text);
  assert.match(fit.text, /1\.5 s \(the cut of board shot 2 \(drop:true\)\)/);
  const fitted = (await record("pace")).document;
  assert.deepEqual([fitted.board.shots[1].drop, fitted.cues.find((cue) => cue.name === "song-drop-1")?.time], [true, 1.5], fit.text);
  // The other tests share this song with no drop measured.
  await rm(`${file}.song`, { force: true });
});

test("check's cue line names the clip under a cut-out of it, not the cut-out file", () => {
  const video = (id, src, mediaStart, mediaOffset, mediaDuration, extra = {}) => ({ id, name: id, type: "video", src, mediaStart, mediaOffset, mediaDuration, ...extra });
  const music = { id: "song", type: "audio", src: "/api/media/song.wav", mediaStart: 0, mediaOffset: 0, mediaDuration: 6 };
  const shape = { version: SONG_SHAPE_VERSION, seconds: 6, whole: true, sections: [{ at: 0, kind: "intro" }, { at: 3, kind: "drop", weight: 1 }], seams: [] };
  const scene = { duration: 6, layers: [music, video("head", "/api/media/a.mp4", 0, 3, 3), video("payoff", "/api/media/a.mp4", 3, 4, 3),
    video("payoff-subject", "/api/media/a-subject.webm", 3, 4, 3, { cutoutOf: "payoff" })] };
  const nameOf = (src) => src.split("/").pop();
  assert.deepEqual(cueShowLines(sceneCueShows({ scene, music, shape, media: { nameOf } })),
    ["on the drop at 3.00 s: layer payoff (a.mp4) repeats 2 s of file 4-7 s shown at 0-3 s", "one take fills 100% of the edit: a.mp4 (6 s)"]);
});

test("the payoff's cue line reads the scene's song when the board names none, and counts grouped layers on their group's clock and pictures", () => {
  const video = (id, src, mediaStart, mediaOffset, mediaDuration, extra = {}) => ({ id, name: id, type: "video", src, mediaStart, mediaOffset, mediaDuration, ...extra });
  const music = { id: "song", name: "song", type: "audio", src: "/api/media/song.wav", mediaStart: 0, mediaOffset: 0, mediaDuration: 8 };
  const shape = { version: SONG_SHAPE_VERSION, seconds: 8, whole: true, sections: [{ at: 0, kind: "intro" }, { at: 3, kind: "drop", weight: 1 }], seams: [] };
  const shot = (id, cue, dur, media, inPoint) => ({ id, cue, dur, pacing: "free", media, in: inPoint, crop: "none", subject: "none", follow: "none", text: "none", sound: "none" });
  const board = { music: "none", shots: [shot("S1", 0, 3, "/api/media/a.mp4", 1), shot("S2", 3, 3, "/api/media/b.mp4", 0), shot("S3", 6, 2, "/api/media/a.mp4", 2)] };
  const spine = [{ role: "hook", from: 0, to: 3 }, { role: "payoff", from: 6, to: 8 }];
  const scene = { id: "s1", duration: 8, layers: [music, video("board-s1", "/api/media/a.mp4", 0, 1, 3), video("board-s2", "/api/media/b.mp4", 3, 0, 3), video("board-s3", "/api/media/a.mp4", 6, 2, 2)] };
  const document = { id: "p", scenes: [scene], board };
  const nameOf = (src) => src.split("/").pop();
  // The board's music is none: the cue lines read the scene's song layer; the payoff at 6 s is on no song cue.
  const facts = boardPaceFacts({ document, shape, media: { nameOf }, music, spine });
  assert.equal(facts.turn, null);
  assert.deepEqual(boardCueLines(facts), ["on the drop at 3.00 s: shot 2 (b.mp4) new", "on the payoff beat at 6.00 s: shot 3 (a.mp4) repeats 2 s of file 2-4 s shown at 0-3 s",
    "one take fills 63% of the edit: a.mp4 (5 s)"]);
  // Without a spine the payoff is the last shot, and the line says so.
  assert.match(boardCueLines(boardPaceFacts({ document, shape, media: { nameOf }, music }))[1], /^on the last shot at 6\.00 s: shot 3/);
  // check: a clip inside a group whose play range starts at 6 s, and a picture shown again on the payoff.
  const story = boardStoryCues(board, { spine });
  const checked = (layers) => {
    const built = { ...scene, layers: [music, video("board-s1", "/api/media/a.mp4", 0, 1, 3), ...layers] };
    return cueShowLines(sceneCueShows({ scene: built, music, shape, media: { nameOf }, document: { ...document, scenes: [built] }, story }));
  };
  // The group's play range starts the clip at 6 s (file 6-8 s): new there, not on screen since 0 s.
  assert.ok(checked([{ id: "late", name: "late", type: "group", playbackWindows: [{ start: 6, end: 8 }] }, video("inner", "/api/media/a.mp4", 0, 0, 8, { parentId: "late" })])
    .includes("on the payoff beat at 6.00 s: layer inner (a.mp4) new"));
  const picture = (id, mediaStart, mediaDuration) => ({ id, name: id, type: "image", src: "/api/media/p.png", mediaStart, mediaDuration });
  assert.ok(checked([picture("pic", 3, 1), picture("pic2", 6, 2)]).includes("on the payoff beat at 6.00 s: layer pic2 (p.png) shows again the still shown at 3-4 s"));
  // compose builds a picture with Show and Hide, no Play range: it is on screen only between them,
  // so no take fills the edit and the second showing is the shot on the payoff.
  const shown = (id, from, to) => ({ id, name: id, type: "image", src: "/api/media/p.png", animations: [{ kind: "show", start: from }, ...(to < 8 ? [{ kind: "hide", start: to }] : [])] });
  assert.deepEqual(checked([shown("pic", 3, 4), shown("pic2", 6, 8)]).filter((line) => /p\.png/.test(line)),
    ["on the drop at 3.00 s: layer pic (p.png) new", "on the payoff beat at 6.00 s: layer pic2 (p.png) shows again the still shown at 3-4 s"]);
  // An animated GIF (it has a Play range) moves: the second showing reads by file time, not as the same still.
  const gif = (id, mediaStart, mediaOffset, mediaDuration) => ({ id, name: id, type: "image", src: "/api/media/g.gif", mediaStart, mediaOffset, mediaDuration, mediaSourceDuration: 6 });
  const moving = checked([gif("g1", 3, 0, 1), gif("g2", 6, 0, 2)]).filter((line) => /g\.gif/.test(line));
  assert.ok(moving.every((line) => !/still/.test(line)), moving.join(" "));
  assert.ok(checked([gif("g1", 3, 0, 1), gif("g2", 6, 3, 2)]).some((line) => /layer g2 \(g\.gif\) new/.test(line)), "a later part of the GIF is new, not the same still");
  // The saved board says the payoff repeats the opening file; the scene was edited so it plays new file time: one line names both.
  const rebuilt = { ...scene, layers: scene.layers.map((layer) => (layer.id === "board-s3" ? video("board-s3", "/api/media/a.mp4", 6, 7, 2) : layer)) };
  const edited = sceneCueShows({ scene: rebuilt, music, shape, media: { nameOf }, document: { ...document, scenes: [rebuilt] }, story: boardStoryCues(builtBoard(board, rebuilt), { spine }) });
  const apart = cueDisagreement(facts.shows, edited);
  assert.match(apart, /disagree on the payoff beat: the saved board has shot 3 repeating file time at 6\.00 s, the built scene has layer board-s3 new at 6\.00 s; compose \{from:"board"\} builds the scene from the board again/);
  assert.equal(cueDisagreement(facts.shows, sceneCueShows({ scene, music, shape, media: { nameOf }, document, story })), null, "the same plan says nothing");
  // A drawn board shot on the drop (no footage) that compose built as a text card: both have no file there, so nothing is said.
  const drawnBoard = { ...board, shots: board.shots.map((entry) => (entry.id === "S2" ? { ...entry, media: "none", in: null } : entry)) };
  const drawnScene = { ...scene, layers: [music, video("board-s1", "/api/media/a.mp4", 0, 1, 3), { id: "board-s2", name: "board-S2", type: "text", text: "Words", animations: [{ kind: "show", start: 3 }, { kind: "hide", start: 6 }] }, video("board-s3", "/api/media/a.mp4", 6, 2, 2)] };
  const drawnDocument = { ...document, board: drawnBoard, scenes: [drawnScene] };
  assert.equal(cueDisagreement(boardPaceFacts({ document: drawnDocument, shape, media: { nameOf }, music, spine }).shows,
    sceneCueShows({ scene: drawnScene, music, shape, media: { nameOf }, document: drawnDocument, story: boardStoryCues(builtBoard(drawnBoard, drawnScene), { spine }) })), null, "a drawn shot built as a card agrees with its board shot");
  // check reads the story's times off the layers compose built: board-s3 starts at 4.5 s after a later edit.
  const moved = { ...scene, layers: scene.layers.map((layer) => (layer.id === "board-s3" ? { ...layer, mediaStart: 4.5, mediaDuration: 3.5 } : layer)) };
  assert.deepEqual(boardStoryCues(builtBoard(board, moved), { spine }), [{ at: 4.5, kind: "payoff beat, the longest shot (3.5 s)" }]);
});

test("a bad move.ref says what the project accepts now: its saved keys, the fixed ref, or the call that saves one", () => {
  const saved = [{ id: "yt:mKIY0Pb2XHA", keys: ["phone-film"] }, { id: "yt:uXlWYZ022zU", keys: [] }];
  const help = referenceHelp(saved);
  // A saved id or key sent without its moment: the fixed ref, by the key when it has one.
  assert.equal(help("yt:mKIY0Pb2XHA"), '"yt:mKIY0Pb2XHA" is saved as phone-film: send ref "phone-film@<seconds>", the second of it the shot copies.');
  assert.match(referenceHelp(saved)("YT:UXLWYZ022ZU"), /saved as yt:uXlWYZ022zU: send ref "yt:uXlWYZ022zU@<seconds>"/);
  // The key is right but the seconds are malformed: it says how seconds are written, not the same fix again.
  for (const sent of ["phone-film@2.555", "phone-film@3s", "phone-film@-1", "phone-film@ 3", "yt:mKIY0Pb2XHA@12345", "phone-film@"]) {
    assert.match(referenceHelp(saved)(sent), /seconds are not valid: write digits with up to 2 decimals and no unit \(e\.g\. "phone-film@3\.2"\)/, sent);
  }
  // A near miss names the closest one; anything else lists the saved names, once per refusal.
  assert.equal(referenceHelp(saved)("phone-flim@3"), 'The closest saved reference is phone-film: send ref "phone-film@<seconds>".');
  const other = referenceHelp(saved);
  assert.equal(other(undefined), 'Saved now: phone-film, yt:uXlWYZ022zU. Send ref "<one of them>@<seconds>".');
  assert.equal(other(7), "", "the list is said once");
  // Nothing saved: the exact call that saves one. Unknown (no inspire): nothing added.
  assert.match(referenceHelp([])("launch@3"), /^No reference is saved in this project: save one with library \{topic:"inspire", name:"save yt:<id> as <key>", take:"<what this edit takes from it>"\}/);
  assert.equal(referenceHelp(null)("launch@3"), "");
});

test("every shot names every layer: one left out is refused with missing_layer, and so is a board without music", { skip, timeout: 60_000 }, async () => {
  await project("board-layers");
  const { revision } = await record("board-layers");
  for (const layer of SHOT_LAYERS) {
    const shot = motion(0, 6);
    delete shot[layer];
    assertRefused(await editBoard("board-layers", [shot]), "missing_layer", `shot 1 has no ${layer}: say "none" if there is no ${layer}.`);
  }
  const { sound, ...noSound } = motion(0, 3);
  const { text, ...noText } = motion(3, 3);
  assertRefused(await editBoard("board-layers", [noSound, noText]), "missing_layer", 'shot 1 has no sound: say "none" if there is no sound. Also: shot 2 has no text: say "none" if there is no text.');
  const { music, ...noMusic } = boardOp([motion(0, 6)]);
  assertRefused(await agent("edit", { project: "board-layers", ops: [noMusic] }), "missing_layer", 'the board has no music: name the music layer, or say "none" if there is no music.');
  const after = await record("board-layers");
  assert.equal(after.revision, revision, "a refused board saves nothing");
  assert.equal(after.document.board, undefined);
});

test("the shots cover the music when there is a music layer, else the whole video; a voice-over project with no music passes", { skip, timeout: 60_000 }, async () => {
  await project("board-music", { layers: [audioLayer("song"), { op: "add_layer", layerType: "text", name: "title", properties: { text: "Title", x: 100, y: 100, width: 800, height: 200 } }] });
  assertRefused(await editBoard("board-music", [motion(0, 2), motion(2.5, 3.5)], { music: "song" }), "gap",
    "the shots leave a gap in the music from 2 to 2.5 s (after shot 1): make shot 1 longer or start shot 2 at 2 s.");
  assertRefused(await editBoard("board-music", [motion(0, 6)], { music: "title" }), "bad_shot", 'music is an audio layer\'s name or code, an imported sound\'s src or id, or "none"; title is a text layer.');
  const saved = await editBoard("board-music", [motion(0, 2), motion(2, 4)], { music: "song" });
  assert.equal(saved.isError, undefined, saved.text);
  // Words sent with a family only take the subtitle treatment, printed with the fields that change them.
  const typed = "from scene colors (background #101114; no measured type label for this job): weight 600, size 86 px, fill #ffffff, y 57 % (text.weight, text.size, text.fill, text.y change them)";
  assert.deepEqual(saved.data.notes, ['board r1: 2 shots, 0–6 s, music song · look {mode:"board"} shows it', `board shot 1 text as subtitle ${typed}`, `board shot 2 text as subtitle ${typed}`,
    "board music: kept as laid (the song has no drop measured; update_layer mediaOffset places it)"]);
  assert.equal(saved.data.board, undefined, "no approval yet, so no board field in the answer");
  const { document } = await record("board-music");
  const songLayer = document.scenes[0].layers.find((layer) => layer.name === "song");
  assert.equal(document.board.music, songLayer.id, "music keeps the layer's id");
  assert.deepEqual(document.board.shots.map((shot) => [shot.id, shot.cue, shot.dur]), [["S1", 0, 2], ["S2", 2, 4]]);
  assert.deepEqual(document.board.shots[0].text, { text: "The dragon is back", family: "Inter", weight: 600, size: 86, y: 57, fill: "#ffffff" }, "a subtitle line: 4.5% of 1920 px, above the phone captions");
  const again = await editBoard("board-music", [motion(0, 2), motion(2, 4)], { music: "song" });
  assert.deepEqual(again.data.notes, ["board r1: no change", "board music: kept as laid (the song has no drop measured; update_layer mediaOffset places it)"]);
  assert.equal((await record("board-music")).document.board.rev, 1, "the same board keeps its rev");

  // A song that is no layer yet, named by its media src: the board adds its audio layer (0 s to
  // the shots' end) and the 3 s scene grows to 5 s; the same song by its id reuses that layer.
  await project("board-song", { width: 1920, height: 1080, duration: 3 });
  const bySrc = await editBoard("board-song", [motion(0, 2), motion(2, 3)], { music: song.src });
  assert.equal(bySrc.isError, undefined, bySrc.text);
  assert.ok(bySrc.data.notes.includes("board music: added song as an audio layer, 0–5 s; the scene grew to 5 s to hold it"), bySrc.text);
  const songScene = (await record("board-song")).document.scenes[0];
  const added = songScene.layers.filter((layer) => layer.type === "audio");
  assert.deepEqual(added.map((layer) => [layer.name, layer.src, layer.mediaDuration]), [["song", song.src, 5]]);
  assert.equal(songScene.duration, 5);
  assert.equal((await record("board-song")).document.board.music, added[0].id);
  const byId = await editBoard("board-song", [motion(0, 2.5), motion(2.5, 2.5)], { music: song.id });
  assert.equal(byId.isError, undefined, byId.text);
  assert.equal((await record("board-song")).document.scenes[0].layers.filter((layer) => layer.type === "audio").length, 1, "the same song reuses its layer");
  // On a briefed video whose board stop waits, the board op with a song by its src is the board,
  // not a build, even when fit_music places the song and fades it: it saves (run dm2-a answered
  // board_needed "save the storyboard" four times). The song's measured shape: a drop at 4 s.
  const tone = path.join(folder, "drop.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=262:sample_rate=44100:duration=12", "-ac", "1", tone]);
  const drop = await upload(server, tone, "audio/wav");
  const dropFile = path.join(server.dataDirectory, "media", path.basename(drop.src));
  await writeFile(`${dropFile}.song`, JSON.stringify({ version: SONG_SHAPE_VERSION, seconds: 12, whole: true, sections: [{ at: 0, kind: "intro" }, { at: 4, kind: "drop", weight: 1 }], seams: [], bars: null }));
  await writeFile(`${dropFile}.beats`, JSON.stringify({ version: BEAT_ANALYSIS_VERSION, duration: 12, bpm: 120, period: 0.5, beats: Array.from({ length: 24 }, (_, index) => index * 0.5), onsets: [] }));
  await stopProject("board-song-stop");
  const briefed = await editBoard("board-song-stop", [footage(0, 1.25, 0, 20), footage(1.25, 2.083, 1.25, 38), footage(3.333, 1.084, 3.333, 55), motion(4.417, 4.383)], { music: drop.src });
  assert.equal(briefed.isError, undefined, briefed.text);
  assert.ok(briefed.data.notes.some((note) => note.startsWith("board music: placed with fit_music")), briefed.text);
  const faded = (await record("board-song-stop")).document.scenes[0].layers.filter((layer) => layer.type === "audio");
  assert.ok(faded.some((layer) => layer.animations.length), "fit_music faded the song");

  await project("board-whole");
  assertRefused(await editBoard("board-whole", [motion(0, 2), motion(2, 3)]), "gap", "the shots end at 5 s, before the video ends (6 s): make the last shot 1 s longer.");
  assertRefused(await editBoard("board-whole", [motion(0.5, 5.5)]), "gap", "the shots start at 0.5 s, after the video starts (0 s): start shot 1 at 0 s.");

  // A voice-over is an audio layer that is not music: the shots cover the whole video.
  await project("board-voice", { layers: [audioLayer("voice")] });
  const voice = await editBoard("board-voice", [motion(0, 3), motion(3, 3, { text: { text: "Out now", family: "Inter", weight: 800, size: 120, y: 50, fill: "#ffd23f" } })]);
  assert.equal(voice.isError, undefined, voice.text);
  // Shot 2 names every field, so only shot 1's words are filled and printed.
  assert.deepEqual(voice.data.notes, ['board r1: 2 shots, 0–6 s, no music · look {mode:"board"} shows it', `board shot 1 text as subtitle ${typed}`]);
  assert.equal((await record("board-voice")).document.board.music, "none");
});

test("a board shot keeps its clip's own sound: the answer says what each clip holds and what a silent plan keeps; placing the layers keeps the stretch", { skip, timeout: 60_000 }, async () => {
  const id = "board-keep";
  await project(id, { width: 1920, height: 1080, duration: 4.417, layers: [audioLayer("song")] });
  // A saved loudness curve beside the clip (what kino keeps after measuring it once): -20 LUFS throughout.
  await writeFile(path.join(server.dataDirectory, "media", `${clip.src.replace("/api/media/", "")}.lufs`), JSON.stringify({ version: 1, step: 0.1, duration: 4.4, momentary: Array(44).fill(-20) }));
  const wide = (cue, dur, inPoint, sound) => ({ ...footage(cue, dur, inPoint, 0, { sound }), crop: [0, 0, 100, 100], subject: { what: "the dragon", box: [30, 30, 20, 30] } });
  const silent = await editBoard(id, [wide(0, 1.25, 0, "none"), wide(1.25, 2.083, 1.25, "none"), wide(3.333, 1.084, 3.333, "none")], { music: "song" });
  assert.equal(silent.isError, undefined, silent.text);
  assert.ok(silent.data.notes.includes("clip sound by shot (file seconds): 1 -20 LUFS; 2 -20 LUFS; 3 -20 LUFS"), silent.text);
  assert.ok(silent.data.notes.some((note) => note.startsWith("clip sound: the plan keeps 0 s of the clips' own sound in 4.42 s (every shot is the music alone)")), silent.text);
  assertRefused(await editBoard(id, [wide(0, 1.25, 0, { keep: [9, 10] }), wide(1.25, 3.167, 1.25, "none")], { music: "song" }), "bad_shot",
    "shot 1 sound.keep [9, 10] is outside what the shot plays: file 0–1.25 s.");
  // keep:true (a weak agent's guess) is read as "all".
  const kept = await editBoard(id, [wide(0, 1.25, 0, "none"), wide(1.25, 2.083, 1.25, { keep: [1.5, 2.5] }), wide(3.333, 1.084, 3.333, { keep: true })], { music: "song" });
  assert.ok(kept.data.notes.includes("clip sound by shot (file seconds): 1 -20 LUFS; 2 -20 LUFS, keeps 1.5-2.5 s; 3 -20 LUFS, keeps all"), kept.text);
  assert.ok(!kept.data.notes.some((note) => note.startsWith("clip sound: the plan keeps")));
  // The build, as run 8's scripts wrote it: one video layer a shot, every one at volume 0.
  const layer = (name, start, offset, duration) => ({ op: "add_layer", layerType: "video", name, properties: { src: clip.src, mediaStart: start, mediaOffset: offset, mediaDuration: duration, volume: 0, width: 1920, height: 1080 } });
  const built = await agent("edit", { project: id, ops: [layer("shot-1", 0, 0, 1.25), layer("shot-2", 1.25, 1.25, 2.083), layer("shot-3", 3.333, 3.333, 1.084)] });
  assert.equal(built.isError, undefined, built.text);
  assert.ok(built.data.notes.includes("board: 2 shots keep the clip's own sound (2.08 s, keep_line, subtitle off)"), built.text);
  const layers = (await record(id)).document.scenes[0].layers;
  const named = (name) => layers.find((entry) => entry.name === name);
  assert.equal(named("shot-1").volume, 0);
  assert.equal(named("shot-2").volume, 1);
  assert.deepEqual(named("shot-2").animations.filter((animation) => animation.name.startsWith("Line")).map((animation) => [animation.name, animation.start]), [["Line mute", 0], ["Line up", 1.42], ["Line down", 2.5]]);
  assert.equal(named("shot-3").volume, 1);
  // Measured, this quiet tone needs no dip: each line lifted over it reaches 6 LU with the song
  // untouched, so keep_line makes no dip and the board adds none.
  assert.equal(built.data.duck, undefined);
  assert.deepEqual(built.data.keepLine.map((entry) => entry.way), ["lift", "lift"]);
  assert.deepEqual(built.data.keepLine.map((entry) => entry.scene), [[1.5, 2.5], [3.333, 4.417]]);
  // Each lifted line is measured in the scene's mix (backend/line-peak.mjs): its ways ends with the peak.
  for (const entry of built.data.keepLine) assert.match(entry.ways, / · peak at the line -?[\d.]+ dBFS.*, measured; limiter ceiling -1\.5 dBFS/, JSON.stringify(entry));
});

test("kino checks the shots against the video, the files and the fonts: overlap, order, crop shape, the file's end, fonts and media", { skip, timeout: 60_000 }, async () => {
  await project("board-checks", { duration: 4.417, layers: [videoLayer()] });
  const { revision } = await record("board-checks");
  assertRefused(await editBoard("board-checks", [motion(0, 3), motion(2.5, 1.917)]), "overlap", "shot 2 starts at 2.5 s, inside shot 1 (0–3 s): start it at 3 s.");
  assertRefused(await editBoard("board-checks", [motion(0, 2), motion(2, 1), motion(1, 3.417)]), "overlap", "shots are in time order: shot 3 starts at 1 s, before shot 2 (2 s).");
  assertRefused(await editBoard("board-checks", [motion(0, 5)]), "overlap", "shot 1 ends at 5 s, after the video ends (4.42 s).");
  assertRefused(await editBoard("board-checks", [footage(0, 4.417, 0, 30, { crop: [30, 12, 40, 76] })]), "bad_shot",
    "shot 1 crop [30, 12, 40, 76] is 0.94 wide per 1 tall on the source; the video is 1080×1920 (0.56): with h 76, w is 24 (or crop \"whole\" when the source is shown whole).");
  // A shot that runs past its file: the refusal names the fixes with their numbers, and the retry's
  // fix is the agent's own shots with the speed that fills the shot (the cuts stay). The last shot
  // gets no shorter dur (the board takes no gap at the end).
  const past = await editBoard("board-checks", [motion(0, 2.317), footage(2.317, 2.1, 3.5, 40)]);
  assert.equal(past.data.boardError, "bad_shot", past.text);
  assert.match(past.data.reason, /shot 2 needs 2\.1 s of sintel-village-dragon\.mp4 from 3\.5 s, but the file ends at 4\.42 s\. Send speed 0\.43 \(the clip plays slower and fills the 2\.1 s shot\), or in 2\.31 \(the same 2\.1 s, from earlier in the file\)\.$/);
  assert.deepEqual(past.data.example.shots.map((shot) => shot.speed), [undefined, 0.43]);
  assert.match(JSON.parse(past.text).next, /^edit \{"retry":"E\d+","fix":\{"0":\{"op":"board".*"speed":0\.43\}/s);
  // A shot before another: a shorter dur names where the next shot starts and how much longer it runs.
  const early = await editBoard("board-checks", [footage(0, 2.317, 3.5, 40), motion(2.317, 2.1)]);
  assert.match(early.data.reason, /shot 1 needs 2\.32 s .* Send speed 0\.39 \(.*\), or in 2\.09 \(.*\), or dur 0\.91 with shot 2 starting at 0\.91 s and 1\.41 s longer\.$/);
  // Too long text and a font kino lacks: one refusal names both.
  assertRefused(await editBoard("board-checks", [motion(0, 4.417, { text: { text: "t".repeat(205), family: "Bangers" } })]), "bad_shot",
    'shot 1 text.text is 205 characters, limit 200. Also: shot 1 text family "Bangers" is not a font kino has (library {topic:"fonts", search:"Bangers"}).');
  assertRefused(await editBoard("board-checks", [footage(0, 4.417, 0, 30, { media: "nothing.mp4" })]), "bad_shot",
    'shot 1 media "nothing.mp4" is not an imported video or picture (library {topic:"media"} lists them).');
  // A ref with no moment, and nothing saved in this project: the refusal says how to save one (said once for two shots).
  const noMoment = { kind: "transition", name: "zoom-through", ref: "phone-film" };
  const refused = await editBoard("board-checks", [motion(0, 2, { move: noMoment }), motion(2, 2.417, { move: noMoment })]);
  assert.equal(refused.data.boardError, "bad_shot", refused.text);
  assert.match(refused.data.reason, /shot 1 move\.ref is "<reference key>@<seconds>".* No reference is saved in this project: save one with library \{topic:"inspire", name:"save yt:<id> as <key>", take:"<what this edit takes from it>"\}.* Also: shot 2 move\.ref is "<reference key>@<seconds>", the reference moment it copies \(e\.g\. "app-trailer@3\.2"\)\.$/);
  assertRefused(await editBoard("board-checks", [motion(0, 4.417, { crop: [0, 0, 50, 50] })]), "bad_shot", 'shot 1 has no media, so in, crop, subject and follow are "none".');
  assertRefused(await editBoard("board-checks", [motion(undefined, 4.417)]), "bad_shot", "shot 1 has no cue: its start in seconds.");
  assertRefused(await editBoard("board-checks", [motion(0, 4.417, { why: "" })]), "bad_shot", "shot 1 has no why: one line on why this shot.");
  // Every field over its limit at once, by name, length and limit.
  assertRefused(await editBoard("board-checks", [footage(0, 4.417, 0, 30, { subject: { what: "w".repeat(45), box: [34, 30, 14, 30] }, why: "y".repeat(101) })], { calls: ["ok", "c".repeat(112)] }), "bad_shot",
    "calls[1] is 112 characters, limit 100. Also: shot 1 why is 101 characters, limit 100: one line. shot 1 subject.what is 45 characters, limit 40.");
  assert.equal((await record("board-checks")).revision, revision, "nothing refused was saved");
  // A slowed clip uses less of its file: dur 2.1 at speed 0.4 needs 0.84 s from 3.5 s, which fits.
  const slow = await editBoard("board-checks", [motion(0, 2.317), footage(2.317, 2.1, 3.5, 40, { speed: 0.4 })]);
  assert.equal(slow.isError, undefined, slow.text);
  assert.equal((await record("board-checks")).document.board.shots[1].speed, 0.4);
  const fast = await editBoard("board-checks", [motion(0, 2.317), footage(2.317, 2.1, 0, 40, { speed: 3 })]);
  assert.match(fast.data.reason, /shot 2 needs 6\.3 s of sintel-village-dragon\.mp4 from 0 s, but the file ends at 4\.42 s\. Send speed 2\.1 /);

  // media is a video layer's name, a file's name or its src; all three are kept as the src.
  // A craft move built as an edit op (frame), a move (type-on) or a scene setting (drift) is known: no planned:true.
  const shots = [footage(0, 1.25, 0, 20, { media: "footage", move: { kind: "camera", name: "frame", ref: "phone-film@3.13" } }),
    footage(1.25, 2.083, 1.25, 38, { media: "sintel-village-dragon.mp4", move: { kind: "type", name: "type-on", ref: "agent-launch@2" } }), footage(3.333, 1.084, 3.333, 55, { move: { kind: "camera", name: "drift", ref: "teaser-2026@8.9" } })];
  const saved = await editBoard("board-checks", shots, { calls: ["the dragon in every shot"], open: ["the village or the sky last?"] });
  assert.equal(saved.isError, undefined, saved.text);
  const { board } = (await record("board-checks")).document;
  assert.deepEqual(board.shots.map((shot) => shot.media), [clip.src, clip.src, clip.src]);
  assert.deepEqual(board.shots[0].subject, { what: "the dragon", boxes: [[24, 30, 14, 30]] }, "box is read as boxes: [box]");
  assert.deepEqual([board.calls, board.open], [["the dragon in every shot"], ["the village or the sky last?"]]);

  // look {mode:"board"} runs through the service (its pages are backend/look-board.test.mjs's):
  // a board look is beside the scene's frames, so it is not the look `changed` compares with.
  const frame = await agent("look", { project: "board-checks", mode: "frame", time: 1 });
  assert.equal(frame.isError, undefined, frame.text);
  const { lastLook, looks } = await savedState("board-checks");
  const sceneId = (await record("board-checks")).document.scenes[0].id;
  assert.equal(looks[sceneId].mode, "frame");
  const page = await agent("look", { project: "board-checks", mode: "board" });
  assert.equal(page.isError, undefined, page.text);
  assert.deepEqual([page.data.mode, page.data.page, page.data.pages], ["board", 1, 1]);
  // The board's stills share the scene's key: they must not replace the frame look kept there.
  const after = await savedState("board-checks");
  assert.equal(after.lastLook, lastLook);
  assert.deepEqual(after.looks[sceneId], looks[sceneId], "the frame look `changed` compares with is kept");
  await project("board-empty");
  const none = await agent("look", { project: "board-empty", mode: "board" });
  assert.equal(none.data.error, "not_found", none.text);
  assert.equal(none.data.reason, 'No storyboard yet: edit {ops:[{op:"board", music, shots}]} (library {topic:"op", name:"board"}).');
  assert.ok((await agent("look", { project: "board-checks", mode: "bord" })).data.didYouMean.includes("board"));
});

test("the board is part of the document: revert and restore bring back the earlier board, and an old rev that no longer applies conflicts", { skip, timeout: 60_000 }, async () => {
  await project("board-history", { layers: [audioLayer("song")] });
  const first = await editBoard("board-history", [motion(0, 6)], { music: "song" });
  assert.equal(first.isError, undefined, first.text);
  const firstBoard = (await record("board-history")).document.board;
  // A note from the person starts a new turn, so the next edit can be reverted on its own.
  await agent("notes", { project: "board-history", action: "add", text: "two shots, please", by: "you" });
  const second = await editBoard("board-history", [motion(0, 3), motion(3, 3)], { music: "song" });
  assert.equal(second.isError, undefined, second.text);
  assert.notEqual(second.data.turn, first.data.turn);
  const secondBoard = (await record("board-history")).document.board;
  assert.equal(secondBoard.rev, 2);

  const reverted = await agent("history", { project: "board-history", action: "revert", turn: second.data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  assert.deepEqual((await record("board-history")).document.board, firstBoard, "the revert brings back board r1");
  const restored = await agent("history", { project: "board-history", action: "restore", rev: second.data.rev });
  assert.equal(restored.isError, undefined, restored.text);
  assert.deepEqual((await record("board-history")).document.board, secondBoard, "the restore brings back board r2");

  // An edit written against an older version: its board names a layer another edit deleted.
  const old = (await record("board-history")).revision;
  assert.equal((await agent("edit", { project: "board-history", ops: [{ op: "delete_layer", layer: "song" }] })).isError, undefined);
  const late = await editBoard("board-history", [motion(0, 2), motion(2, 4)], { music: "song" }, { rev: old });
  assert.equal(late.data.error, "conflict", late.text);
  assert.deepEqual((await record("board-history")).document.board, secondBoard, "the conflict saved nothing");
});

// The board the stop tests show: the clip's three shots cropped to 9:16, then a title to 8.8 s.
const STOP_SHOTS = () => [footage(0, 1.25, 0, 20), footage(1.25, 2.083, 1.25, 38), footage(3.333, 1.084, 3.333, 55), motion(4.417, 4.383)];
const OPEN = ["Which ending: the dragon or the title?", "Music, or the village sound?"];
// The agent's decisions on OPEN after the person said "your call".
const DECIDED = { calls: ["End on the title", "The village sound, no music"] };

// An 8.8 s 1080×1920 project with the clip on a video layer (so the board stop asks) and a
// brief settled with no playback ("just start").
async function stopProject(id, on = server) {
  await project(id, { duration: 8.8, layers: [videoLayer()], on });
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" }, on)).isError, undefined);
}

const LAPSE_NEXT = (stop) => `${stop} approved the board as it was; this change lapses that approval: ask again (notes checkpoint {id:"board"}); kino lists only the changed shots.`;
const withShot = (shots, index, change) => shots.map((shot, at) => (at === index ? { ...shot, ...change } : shot));

test("the board stop: board first, no gap, open items or \"your call\"; an approval freezes the board; small changes are logged, bigger ones lapse it", { skip, timeout: 120_000 }, async () => {
  const id = "board-stop";
  await stopProject(id);
  const first = await checkpoint(id);
  assert.equal(first.data.error, "board_first", first.text);
  assert.equal(first.data.reason, 'Save the storyboard first: edit {ops:[{op:"board", music, shots}]} (library {topic:"op", name:"board"}; library guide storyboard).');

  assert.equal((await editBoard(id, STOP_SHOTS(), { open: OPEN })).isError, undefined);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "update_scene", properties: { duration: 9.5 } }] })).isError, undefined);
  const gapped = await checkpoint(id);
  assert.equal(gapped.data.error, "board_gap", gapped.text);
  assert.equal(gapped.data.reason, "the shots end at 8.8 s, before the video ends (9.5 s): make the last shot 0.7 s longer. Fix the board (edit board), then ask again.");
  assert.deepEqual(gapped.data.at.map((time) => Number(time.toFixed(3))), [8.8, 9.5]);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "update_scene", properties: { duration: 8.8 } }] })).isError, undefined);

  // Open items: the person answers them first, or leaves them to the agent ("your call").
  const open = await checkpoint(id);
  assert.equal(open.data.error, "open_items", open.text);
  assert.equal(open.data.reason, 'The board has 2 open items: ask the person in one message, fold their answers into the board (edit board, open emptied), then ask again: notes checkpoint {id:"board", fresh}. If they say "your call", send their words: notes {action:"checkpoint", id:"board", words}.');
  assert.deepEqual([open.data.open_items, open.data.open], [2, OPEN]);
  const theirs = await checkpoint(id, { words: "the dragon, I think" });
  assert.equal(theirs.data.error, "open_items");
  assert.equal(theirs.data.reason, 'Their words do not say "your call": fold their answers into the board (edit board), then ask again: notes checkpoint {id:"board", fresh}.');
  // Review round 1 of B4a: "not your call" leaves nothing to the agent.
  const notMine = await checkpoint(id, { words: "No, that's not your call: end on the dragon." });
  assert.equal(notMine.data.error, "open_items", notMine.text);
  assert.equal(notMine.data.reason, theirs.data.reason);
  assert.equal((await savedState(id)).stops.length, 0, "a refused ask saves no round");

  // "your call": kino logs their words, and the agent writes its decisions in the board's calls
  // (review round 1 of B4a), so the ask shows what it chose.
  // Every way back to the ask names fresh (review round 1 of B4b): the round made then is the one shown.
  const decide = 'decide each, write your decisions in calls and empty open (edit board), then ask again: notes checkpoint {id:"board", fresh}.';
  const left = await checkpoint(id, { words: "Your call on both." });
  assert.deepEqual(left.data, { status: "your_call", open: OPEN, next: decide }, left.text);
  assert.equal(withoutNext(left.text), `recorded: they left 2 open items to you ("your call").\nstep: ${decide}`);
  let state = await savedState(id);
  const { q, a, kind } = state.brief.log.at(-1);
  assert.deepEqual({ q, a, kind }, { q: `Open: ${OPEN.join(" · ")}`, a: "Your call on both.", kind: "question" }, "their words are logged word for word");
  assert.deepEqual({ ...state.leftToAgent, at: "at" }, { open: OPEN, words: "Your call on both.", at: "at" });
  const undecided = await checkpoint(id);
  assert.equal(undecided.data.error, "open_items");
  assert.equal(undecided.data.reason, `They left these to you ("your call"): ${decide}`);
  assert.equal((await editBoard(id, STOP_SHOTS(), DECIDED)).isError, undefined);

  const asked = await checkpoint(id);
  const rev = (await record(id)).revision;
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.deepEqual([asked.data.id, asked.data.kind, asked.data.rev], ["C1", "board", rev]);
  assert.deepEqual({ ...asked.data.board, flagged: 0 }, { rev: 2, shots: 4, listed: 4, flagged: 0 });
  assert.ok(asked.data.ask.startsWith("The storyboard is ready (C1): 4 shots, 8.8 s, 1080×1920, no music.\n"), asked.data.ask);
  assert.ok(asked.data.ask.includes(`\nMy calls (say no to any): ${DECIDED.calls.join(" · ")}\n`), asked.data.ask);
  // The library's song belongs to other videos (review round 2 of B4a): no sound files for this one.
  assert.ok(asked.data.ask.includes("\nNo sound effects. Send me sound files, or say so and I add a few from kino's library.\n"), asked.data.ask);
  assert.ok(asked.data.ask.endsWith("Reply: approve · approve with notes: ... · redo: ..."), asked.data.ask);
  assert.equal(asked.data.next, `send it as written, end your turn, then notes {action:"answer", id:"C1", rev:${rev}, words, read_as}.`);
  assert.ok(estimateTextTokens(asked.text) - estimateTextTokens(asked.data.ask) <= 120, "the waiting answer is the ask and at most 120 tokens more");
  state = await savedState(id);
  assert.deepEqual(await statusLines(id), [`direction: C1 board waiting since ${clock(state.stops[0].askedAt)} · replies 1/10`, "step: end your turn until they answer"], "the reply counts");
  assert.equal((await agent("edit", { project: id, ops: [{ op: "update_scene", properties: { duration: 9 } }] })).data.waiting, "C1", "the project waits for the person");
  // look is a read: look source of a clip no layer plays, by its src, still answers while C1 waits.
  const source = await agent("look", { project: id, mode: "source", layer: clip.src });
  assert.match(source.text, /^source \S+ \(\d+×\d+, [\d.]+ s\): the whole clip in 12 frames/, source.text);

  // Approved: the agent-state file keeps a copy of the board as it was shown.
  await gap(asked.at);
  const approved = await answer(id, { id: "C1", rev, words: "looks great, go", read_as: "approve" });
  assert.equal(approved.data.passed, true, approved.text);
  state = await savedState(id);
  const shown = (await record(id)).document.board;
  assert.equal(state.boards.length, 1);
  assert.deepEqual({ ...state.boards[0], at: "at" }, { stop: "C1", board: 2, rev, at: "at", by: "chat", read_as: "approve", musicFile: null, copy: shown, lapsed: null, revisions: [] });
  const copy = structuredClone(state.boards[0].copy);

  // The cut into shot 2 moves 3 frames: logged, and the approval stands.
  const nudged = withShot(withShot(STOP_SHOTS(), 0, { dur: 1.35 }), 1, { cue: 1.35, dur: 1.983 });
  const nudge = await editBoard(id, nudged, DECIDED);
  assert.equal(nudge.isError, undefined, nudge.text);
  assert.deepEqual(nudge.data.board, { rev: 3, approval: "C1", revisions: ["revision: shot 2 cut moved 3 frames"] });
  const other = await agent("edit", { project: id, ops: [{ op: "update_layer", layer: "footage", properties: { opacity: 0.9 } }] });
  assert.equal(other.data.board, undefined, "an edit that leaves the board alone has no board field");
  const passed = await checkpoint(id);
  assert.deepEqual(passed.data, { status: "passed", id: "C1", kind: "board", rev, revisions: ["revision: shot 2 cut moved 3 frames"] });
  assert.equal(withoutNext(passed.text), `C1 board passed at rev ${rev} (approve, ${clock(state.stops[0].answer.at)}); board changes since are within kino's tolerances (1 revision logged). Go on.`);

  // A new title lapses it. A note from the person first starts a new turn, so this edit can be
  // reverted on its own below.
  await agent("notes", { project: id, action: "add", text: "a stronger last line", by: "you" });
  const retitled = withShot(nudged, 3, { text: { text: "The dragon returns", family: "Inter" } });
  const lapse = await editBoard(id, retitled, DECIDED);
  assert.deepEqual(lapse.data.board, { rev: 4, approval: "C1", lapsed: ["shot 4 text changed"], next: LAPSE_NEXT("C1") });
  assert.deepEqual(await statusLines(id), ["direction: C1 board lapsed · replies 2/10", "step: ask board again (changed shots)"]);
  state = await savedState(id);
  assert.deepEqual(state.boards[0].copy, copy, "the frozen copy is unchanged by later edits");
  assert.deepEqual({ ...state.boards[0].lapsed, at: "at" }, { at: "at", rev: lapse.data.rev, why: ["shot 4 text changed"] });
  assert.deepEqual(state.boards[0].revisions.map((entry) => entry.line), ["revision: shot 2 cut moved 3 frames"]);
  const lapsedEntry = structuredClone(state.boards[0]);

  // A lapsed board is not approved: a later stop waits for it.
  try {
    await setting({ limits: { skipRoughUnder: 0 } });
    const rough = await agent("notes", { project: id, action: "checkpoint", id: "rough" });
    assert.equal(rough.data.error, "out_of_order", rough.text);
    assert.equal(rough.data.reason, 'rough refused: board is not approved yet; run notes checkpoint {id:"board"} first.');
  } finally {
    await setting({ limits: { skipRoughUnder: 15 } });
  }

  // Asked again: only the changed shot, and why.
  const again = await checkpoint(id);
  assert.equal(again.data.status, "waiting_for_you", again.text);
  assert.equal(again.data.id, "C2");
  assert.ok(again.data.ask.startsWith("The storyboard changed since you approved it (C1); asking again (C2): shot 4 text changed.\n"), again.data.ask);
  assert.equal(again.data.board.listed, 1, again.data.ask);
  // The last short line, sent with a family only, takes the payoff weight Inter really has (engine/typeRoles.js jobFace: no 900 installed).
  assert.ok(again.data.ask.includes('Shot 4, 4.42–8.8 s: no footage; "The dragon returns" in Inter 700.'), again.data.ask);
  assert.ok(!again.data.ask.includes("Shot 1,"), "the unchanged shots are not listed again");
  await gap(again.at);
  const second = await answer(id, { id: "C2", rev: again.data.rev, words: "yes, better", read_as: "approve" });
  assert.equal(second.data.passed, true, second.text);
  state = await savedState(id);
  assert.equal(state.boards.length, 2);
  assert.deepEqual(state.boards[0], lapsedEntry, "the first approval's entry stays as it was");
  assert.deepEqual(state.boards[1].copy, (await record(id)).document.board);
  assert.equal(state.boards[1].stop, "C2");

  // Reverting the turn that made the approved title brings the old one back: that lapses C2.
  const reverted = await agent("history", { project: id, action: "revert", turn: lapse.data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  assert.deepEqual(reverted.data.board, { rev: 3, approval: "C2", lapsed: ["shot 4 text changed"], next: LAPSE_NEXT("C2") });
  assert.deepEqual(await statusLines(id), ["direction: C2 board lapsed · replies 3/10", "step: ask board again (changed shots)"]);
  assert.deepEqual((await savedState(id)).boards[1].copy, state.boards[1].copy, "the revert leaves the copy alone");
});

test("after the approval, next: is compose {from:\"board\"}: it builds the shots in board order, and a footage compose refusal offers it, never an unrelated promo", { skip, timeout: 60_000 }, async () => {
  const id = "board-build";
  await stopProject(id);
  // The direction's own steps (references, treatments, needs) are other tests' subject.
  await agent("edit", { project: id, ops: ["reference", "treatments", "needs"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a board build test" })) });
  const fields = { about: { text: "the dragon", by: "you", quote: "the dragon" }, message: "The dragon is back", look_sound: "dusk, the village sound", never: "none said", made_from: "the dragon clip" };
  assert.equal((await agent("notes", { project: id, action: "brief", fields })).isError, undefined);
  await agent("notes", { project: id, action: "set_plan", steps: ["Board", "Ask board", "Build the approved board", "Render final"] });
  // The first shot carries lift (a mean luma to reach): the build runs lift_dark on its layer.
  const saved = await editBoard(id, STOP_SHOTS().map((shot, index) => (index === 0 ? { ...shot, lift: 200 } : shot)), DECIDED);
  assert.equal(saved.isError, undefined);
  // Saved, not asked yet: the receipt names the ask, not a build kino would refuse (run 8 T254, T299).
  assert.equal(JSON.parse(saved.text).next, 'notes {"action":"checkpoint","id":"board"}', saved.text);
  const asked = await checkpoint(id);
  await gap(asked.at);
  const approved = await answer(id, { id: "C1", rev: asked.data.rev, words: "looks good, keep going", read_as: "approve" });
  assert.equal(approved.data.passed, true, approved.text);
  const BUILD = 'edit {"ops":[{"op":"compose","from":"board"}]}';
  assert.equal(approved.text.match(/^next: (.*)$/m)?.[1], BUILD, approved.text);
  // A footage compose with a shot under 1 s (run 8 T324): the fix is the board build.
  const refused = await agent("edit", { project: id, ops: [{ op: "compose", footage: [{ media: clip.src, in: 0, out: 0.5 }] }] });
  assert.deepEqual(refused.data.fix?.["0"] ?? refused.data.example, { op: "compose", from: "board" }, refused.text);
  assert.ok(!refused.text.includes("Orbit"), refused.text);
  const wrong = await agent("edit", { project: id, ops: [{ op: "compose", from: "board", duration: 15 }] });
  assert.ok(wrong.data.reason.endsWith('compose {from:"board"} takes no duration: the board holds the shots, text and music. Send {op:"compose", from:"board"}; change the board itself (edit board) to change them.'), wrong.text);
  assert.deepEqual(wrong.data.example, { op: "compose", from: "board" }, "the retry is the call without the extra field");
  const word = await agent("edit", { project: id, ops: [{ op: "compose", from: "storyboard" }] });
  assert.equal(JSON.parse(word.text).next, 'edit {"retry":"' + word.data.retry + '","fix":{"0":{"op":"compose","from":"board"}}}', word.text);
  const built = await agent("edit", { project: id, ops: [{ op: "compose", from: "board" }] });
  assert.equal(built.isError, undefined, built.text);
  assert.ok(built.text.includes("compose from board r1: 4 shots in board order (3 footage, 1 text cards), 0–8.8 s"), built.text);
  assert.ok(built.text.includes("removed the source clip footage"), built.text);
  const { document } = await record(id);
  const shots = document.board.shots;
  const layers = document.scenes[0].layers.filter((layer) => layer.name.startsWith("board-"));
  assert.deepEqual(layers.filter((layer) => layer.type === "video").map((layer) => [layer.mediaStart, layer.mediaOffset, layer.mediaDuration]).sort((a, b) => a[0] - b[0]),
    shots.slice(0, 3).map((shot) => [shot.cue, shot.in, shot.dur]));
  assert.equal(layers.find((layer) => layer.type === "text")?.text, "The dragon is back");
  // The lifted shot's layer has the curve, and the receipt prints its numbers from the render.
  const lifted = layers.find((layer) => layer.mediaStart === shots[0].cue && layer.type === "video");
  assert.ok(lifted.animations.some((animation) => animation.id === `${lifted.id}.lift`), JSON.stringify(lifted.animations.map((animation) => animation.id)));
  assert.match(built.text, /lift_dark target 200 \(full range 0-255; video range 16-235: \d+\): \S+ mean \d+ to \d+[^,]*, contrast \(p90-p10\) \d+ to \d+/, built.text);
  assert.equal(document.scenes.length, 1, "no stray scene");
  const after = await agent("check", { project: id, pixels: false, rules: ["assertions"] });
  assert.notEqual(after.text.match(/^next: (.*)$/m)?.[1], BUILD, "built once, next: moves on");
});

test("words held to the last shot (text.until) are built above the footage they run across: all 4 show at the last shot, and check finds nothing covered", { skip, timeout: 60_000 }, async () => {
  const id = "board-hold";
  await project(id, { duration: 4.4, layers: [videoLayer()] });
  await agent("edit", { project: id, ops: ["reference", "treatments", "needs"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a board build test" })) });
  const plain = { none: "plain cuts" };
  const word = (n, extra = {}) => ({ text: "kill", family: "Inter", weight: 700, size: 90, y: 20 + 12 * n, fill: "#ffffff", until: "w4", ...extra });
  const shots = [0, 1, 2, 3].map((n) => footage(n * 1.1, 1.1, n * 1.1, 20 + n * 10, { id: `w${n + 1}`, move: plain, text: word(n) }));
  const wrong = await editBoard(id, shots.map((shot, n) => (n === 0 ? { ...shot, text: word(0, { until: "w9" }) } : shot)), {});
  assert.match(wrong.data.reason, /shot 1 text until "w9" is not this shot or a later one: ids are w1, w2, w3, w4\./, wrong.text);
  assert.equal((await editBoard(id, shots)).isError, undefined);
  const built = await agent("edit", { project: id, ops: [{ op: "compose", from: "board" }] });
  assert.equal(built.isError, undefined, built.text);
  assert.ok(built.text.includes("3 words held past their shot, drawn above the footage"), built.text);
  const layers = (await record(id)).document.scenes[0].layers;
  const order = (name) => layers.findIndex((layer) => layer.name === name);
  const words = layers.filter((layer) => layer.type === "text");
  assert.equal(words.length, 4);
  // Every word is above every clip, and the three held words hide at the video's end (no hide), the last with its own shot.
  assert.ok(words.every((layer) => layers.filter((other) => other.type === "video").every((clipLayer) => order(layer.name) > order(clipLayer.name))), "words above all footage");
  assert.deepEqual(words.map((layer) => (layer.animations ?? []).filter((animation) => animation.kind === "hide").length), [0, 0, 0, 0]);
  // At 4.2 s (the last shot) all 4 words are shown and every shown layer above the shown clip is a word.
  const shown = layers.filter((layer) => evaluateLayer(layer, 4.2).visible);
  assert.equal(shown.filter((layer) => layer.type === "text").length, 4);
  const clipAt = shown.findLastIndex((layer) => layer.type === "video");
  assert.ok(clipAt >= 0 && shown.slice(clipAt + 1).every((layer) => layer.type === "text") && shown.slice(clipAt + 1).length === 4, shown.map((layer) => layer.name).join(", "));
  const frame = await agent("look", { project: id, mode: "frame", time: 4.2 });
  assert.equal(frame.isError, undefined, frame.text);
  const found = await agent("check", { project: id, pixels: false, rules: ["covered_layer"] });
  assert.ok(!JSON.stringify(found.data.findings ?? []).includes("covered_layer"), found.text);
});

test("a board move named slow-push is a push; compose places a camera push toward the subject and an impact-accent on the shot's cue, and says what it chose", { skip, timeout: 60_000 }, async () => {
  const id = "board-moves";
  await project(id, { width: 1920, height: 1080, duration: 4.417, layers: [videoLayer()] });
  const whole = { crop: [0, 0, 100, 100], subject: { what: "the dragon", box: [60, 30, 20, 40] } };
  const saved = await editBoard(id, [
    footage(0, 2, 0, 0, { ...whole, move: { kind: "camera", name: "slow-push", ref: "phone-film@7.27" } }),
    footage(2, 2.417, 2, 0, { ...whole, move: { kind: "transition", name: "impact-accent", ref: "phone-film@7.27" } }),
  ]);
  assert.equal(saved.isError, undefined, saved.text);
  assert.ok(saved.data.notes.includes('shot 1 move "slow-push" → push'), saved.text);
  assert.equal((await record(id)).document.board.shots[0].move.name, "push");
  const built = await agent("edit", { project: id, ops: [{ op: "compose", from: "board" }] });
  assert.equal(built.isError, undefined, built.text);
  const placed = built.data.notes.find((note) => note.startsWith("moves placed: "));
  // The crop is the whole source: 90% of it, centered on the subject (70, 50) as far as the crop allows.
  assert.match(placed, /push \(shot 1: frame rect \[10, 5, 90, 90\] over 2 s, toward the subject box; \{"op":"frame","layer":"board-S1","rect":\[10,5,90,90\],"at":0,"dur":2\} changes it\)/);
  assert.match(placed, /impact-accent \(shot 2: hit at 2 s \(no song seam or accent within 3 frames\)/);
  const layers = (await record(id)).document.scenes[0].layers;
  const shot = layers.find((layer) => layer.name === "board-S1");
  assert.ok(layers.find((layer) => layer.id === shot.parentId)?.animations.some((animation) => animation.start === 0 && animation.duration === 2), "the camera group pushes over the whole shot");
  // Built again: one camera group, one accent, the same layer count.
  const again = await agent("edit", { project: id, ops: [{ op: "compose", from: "board" }] });
  assert.equal(again.isError, undefined, again.text);
  const rebuilt = (await record(id)).document.scenes[0];
  assert.deepEqual([rebuilt.layers.length, rebuilt.layers.filter((layer) => / camera$/.test(layer.name ?? "")).length, (rebuilt.moves ?? []).filter((move) => move.name === "impact-accent").length], [layers.length, 1, 1]);
  // In a music edit (an accent cue elsewhere) check reads the cut under that hit as its reason: no untriggered.
  assert.equal((await agent("edit", { project: id, ops: [{ op: "set_cues", cues: [{ name: "a-1", kind: "accent", time: 1 }] }] })).isError, undefined);
  const fit = await agent("check", { project: id, rules: ["effect_fit"], pixels: false });
  assert.doesNotMatch(fit.text, /effect_fit/, fit.text);
  // 9:16 from a 16:9 file, a crop 2% narrower than the frame at the file's left edge: the end
  // rect takes the frame's exact shape and stays on the file (no sliver past its edge).
  const tall = boardBuildOps({ music: "none", shots: [{ cue: 0, dur: 2, media: "/m.mp4", in: 0, crop: [0, 0, 31, 100], text: "none",
    subject: { what: "a face", box: [0, 40, 10, 20] }, move: { kind: "camera", name: "push" } }] }, { width: 1080, height: 1920, duration: 2 }, () => ({ width: 1920, height: 1080, duration: 5, kind: "video" }));
  const [left, top, width, height] = tall.moves[0].op.rect;
  assert.deepEqual([left, top, height], [0, 5, 90]);
  assert.ok(Math.abs((width * 1920) / (height * 1080) - 1080 / 1920) < 0.001, `the end rect has the frame's shape (${width} x ${height})`);
});

test("the person's settings can allow the board: kino keeps that board as the approved one", { skip, timeout: 60_000 }, async () => {
  const id = "board-allowed";
  await stopProject(id);
  assert.equal((await editBoard(id, STOP_SHOTS())).isError, undefined);
  const rev = (await record(id)).revision;
  const next = "say in one line that the storyboard passed by their settings, then build.";
  try {
    await setting({ approvals: { "checkpoint-board": "allow" } });
    const allowed = await checkpoint(id);
    assert.deepEqual(allowed.data, { status: "allowed", id: "C1", kind: "board", rev, by: "settings", next });
    assert.equal(withoutNext(allowed.text), `C1 board allowed (the person's settings): kino keeps this board as the approved one.\nstep: ${next}`);
    const state = await savedState(id);
    assert.deepEqual({ ...state.boards[0], at: "at" }, { stop: "C1", board: 1, rev, at: "at", by: "settings", read_as: null, musicFile: null, copy: (await record(id)).document.board, lapsed: null, revisions: [] });
    const passed = await checkpoint(id);
    assert.equal(withoutNext(passed.text), `C1 board passed at rev ${rev} (allowed by the person's settings, ${clock(state.stops[0].allowedAt)}); nothing changed since. Go on.`);
    const words = await checkpoint(id, { words: "your call" });
    assert.equal(words.data.status, "passed", "a board that passed answers passed first");
  } finally {
    await setting({ approvals: { "checkpoint-board": "ask" } });
  }
  // A board with no open items takes no words.
  await stopProject("board-no-open");
  assert.equal((await editBoard("board-no-open", STOP_SHOTS())).isError, undefined);
  const refused = await checkpoint("board-no-open", { words: "your call" });
  assert.equal(refused.data.error, "bad_input");
  assert.equal(refused.data.reason, "words goes with the board's open items, and this board has none: ask without words.");
});

test("a restart keeps the frozen copy and its lapse", { skip, timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kino-board-restart-"));
  const id = "board-restart";
  let first;
  let second;
  try {
    first = await startTestServer({ env: { ...OFFLINE, MOTION_DATA_DIR: root } });
    const media = await upload(first, CLIP, "video/mp4");
    const shots = STOP_SHOTS().map((shot) => (shot.media === "none" ? shot : { ...shot, media: media.src }));
    await project(id, { duration: 8.8, layers: [{ ...videoLayer(), properties: { src: media.src } }], on: first });
    assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" }, first)).isError, undefined);
    assert.equal((await editBoard(id, shots, {}, {}, first)).isError, undefined);
    const asked = await checkpoint(id, {}, first);
    assert.equal(asked.data.status, "waiting_for_you", asked.text);
    await gap(asked.at);
    assert.equal((await answer(id, { id: "C1", rev: asked.data.rev, words: "approve", read_as: "approve" }, first)).data.passed, true);
    const lapse = await editBoard(id, withShot(shots, 2, { follow: "track" }), {}, {}, first);
    assert.deepEqual(lapse.data.board.lapsed, ["shot 3 follow changed"]);
    const before = (await savedState(id, root)).boards;
    await first.stop();
    first = null;

    second = await startTestServer({ env: { ...OFFLINE, MOTION_DATA_DIR: root } });
    assert.deepEqual((await savedState(id, root)).boards, before);
    assert.deepEqual(await statusLines(id, second), ["direction: C1 board lapsed · replies 1/10", "step: ask board again (changed shots)"]);
    const again = await checkpoint(id, {}, second);
    assert.ok(again.data.ask.startsWith("The storyboard changed since you approved it (C1); asking again (C2): shot 3 follow changed.\n"), again.data.ask);
  } finally {
    await first?.stop();
    await second?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

// Review round 1 of B4a: the approval is measured wherever the board changes: a history restore
// answers with the lapse, and a board changed some other way (the app's own save, the dashboard's
// undo) is compared before status and before the board stop decide.
test("a restore lapses the approval in its answer; a board saved outside edit lapses it for status and for the board stop", { skip, timeout: 120_000 }, async () => {
  const titled = (shots, words) => withShot(shots, 3, { text: { text: words, family: "Inter" } });
  const ids = ["board-restore", "board-outside-status", "board-outside-stop"];
  for (const id of ids) {
    await stopProject(id);
    assert.equal((await editBoard(id, STOP_SHOTS())).isError, undefined);
  }
  // board-restore: a second board (a new title) is the one approved.
  const firstRev = (await record(ids[0])).revision;
  assert.equal((await editBoard(ids[0], titled(STOP_SHOTS(), "The dragon returns"))).isError, undefined);
  const asked = [];
  for (const id of ids) asked.push(await checkpoint(id));
  await gap(Math.max(...asked.map((entry) => entry.at)));
  for (const [index, id] of ids.entries()) {
    const reply = await answer(id, { id: "C1", rev: asked[index].data.rev, words: "approve", read_as: "approve" });
    assert.equal(reply.data.passed, true, reply.text);
  }

  const restored = await agent("history", { project: ids[0], action: "restore", rev: firstRev });
  assert.equal(restored.isError, undefined, restored.text);
  assert.deepEqual(restored.data.board, { rev: 1, approval: "C1", lapsed: ["shot 4 text changed"], next: LAPSE_NEXT("C1") });

  // The app saves a new title straight into the project (PUT /api/projects/<id>).
  for (const id of ids.slice(1)) {
    const { document, revision } = await record(id);
    const board = { ...document.board, rev: document.board.rev + 1, shots: document.board.shots.map((shot, index) => (index === 3 ? { ...shot, text: { ...shot.text, text: "Saved in the app" } } : shot)) };
    const response = await server.api(`/api/projects/${id}`, { method: "PUT", body: { document: { ...document, board }, revision } });
    assert.equal(response.status, 200, await response.clone().text());
  }
  assert.deepEqual(await statusLines(ids[1]), ["direction: C1 board lapsed · replies 1/10", "step: ask board again (changed shots)"]);
  // Asked with no status first: the board stop compares the board itself.
  const again = await checkpoint(ids[2]);
  assert.equal(again.data.status, "waiting_for_you", again.text);
  assert.ok(again.data.ask.startsWith("The storyboard changed since you approved it (C1); asking again (C2): shot 4 text changed.\n"), again.data.ask);
});

test("a board sent again without ids keeps each shot's id: a title card added first is named as added, the footage shots as moved", { skip, timeout: 60_000 }, async () => {
  const id = "board-ids";
  await project(id, { duration: 8.8, layers: [videoLayer()] });
  assert.equal((await editBoard(id, STOP_SHOTS())).isError, undefined);
  assert.deepEqual((await record(id)).document.board.shots.map((shot) => shot.id), ["S1", "S2", "S3", "S4"]);
  // A title card first; the footage shots after it; the end title shorter.
  const shots = [motion(0, 1, { text: { text: "Sintel", family: "Inter" } }), ...STOP_SHOTS().slice(0, 3).map((shot) => ({ ...shot, cue: shot.cue + 1 })), motion(5.417, 3.383)];
  assert.equal((await editBoard(id, shots)).isError, undefined);
  assert.deepEqual((await record(id)).document.board.shots.map((shot) => shot.id), ["S5", "S1", "S2", "S3", "S4"]);
  // An id the agent sends is kept as sent.
  assert.equal((await editBoard(id, shots.map((shot, index) => (index === 0 ? { ...shot, id: "title" } : shot)))).isError, undefined);
  assert.deepEqual((await record(id)).document.board.shots.map((shot) => shot.id), ["title", "S1", "S2", "S3", "S4"]);
});

// ---- review round 2 of B4a -------------------------------------------------------------------

// The person's settings allow the board, so each approval here is made without the 5 s wait.
async function allowBoard(run) {
  await setting({ approvals: { "checkpoint-board": "allow" } });
  try { return await run(); } finally { await setting({ approvals: { "checkpoint-board": "ask" } }); }
}

test("a gap the video made lapses the approval only while it lasts, and an edit that lengthens the video answers with the lapse", { skip, timeout: 60_000 }, async () => {
  const id = "board-gap-edit";
  await stopProject(id);
  assert.equal((await editBoard(id, STOP_SHOTS())).isError, undefined);
  await allowBoard(async () => assert.equal((await checkpoint(id)).data.status, "allowed"));
  const longer = await agent("edit", { project: id, ops: [{ op: "update_scene", properties: { duration: 8.9 } }] });
  assert.deepEqual(longer.data.board, { rev: 1, approval: "C1", lapsed: ["a gap at 8.8–8.9 s"], next: LAPSE_NEXT("C1") });
  assert.deepEqual(await statusLines(id), ["direction: C1 board lapsed · replies 0/10", "step: ask board again (changed shots)"]);
  // The last shot 3 frames longer covers the video again: within the tolerances, so it is logged
  // and the approval stands, as if both changes were one edit.
  const covered = await editBoard(id, withShot(STOP_SHOTS(), 3, { dur: 4.483 }));
  assert.deepEqual(covered.data.board, { rev: 2, approval: "C1", revisions: ["revision: shot 4 end moved 3 frames"],
    next: "the board covers the video again within kino's tolerances: C1 stands; no need to ask again." });
  assert.equal((await savedState(id)).boards[0].lapsed, null);
  assert.equal((await checkpoint(id)).data.status, "passed");
  // A video made much longer: the edit's answer says the approval lapsed.
  const far = await agent("edit", { project: id, ops: [{ op: "update_scene", properties: { duration: 20 } }] });
  assert.deepEqual(far.data.board.lapsed, ["a gap at 8.9–20 s"]);
});

test("the music layer's file is part of the approval: another file or no music layer lapses it", { skip, timeout: 60_000 }, async () => {
  const tone = path.join(folder, "other.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=9", "-ac", "1", tone]);
  const other = await upload(server, tone, "audio/wav");
  for (const id of ["board-music-swap", "board-music-gone"]) {
    // 8.8 s, so the board stop asks (none under 8 s); the song plays the whole video.
    await project(id, { duration: 8.8, layers: [videoLayer(), audioLayer("song")] });
    assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
    const music = (await record(id)).document.scenes[0].layers.find((layer) => layer.name === "song").id;
    const saved = await editBoard(id, STOP_SHOTS(), { music });
    assert.equal(saved.isError, undefined, saved.text);
  }
  await allowBoard(async () => {
    for (const id of ["board-music-swap", "board-music-gone"]) assert.equal((await checkpoint(id)).data.status, "allowed");
  });
  assert.equal((await savedState("board-music-swap")).boards[0].musicFile, song.src);
  const swapped = await agent("edit", { project: "board-music-swap", ops: [{ op: "update_layer", layer: "song", properties: { src: other.src } }] });
  assert.equal(swapped.isError, undefined, swapped.text);
  assert.deepEqual(swapped.data.board.lapsed, ["music file changed"]);
  const gone = await agent("edit", { project: "board-music-gone", ops: [{ op: "delete_layer", layer: "song" }] });
  assert.equal(gone.isError, undefined, gone.text);
  assert.deepEqual(gone.data.board.lapsed, ["music removed"]);
  assert.deepEqual(await statusLines("board-music-gone"), ["direction: C1 board lapsed · replies 0/10", "step: ask board again (changed shots)"]);
});

test("sound files count only for their own video: another video's song is not 'the person sent sound files'", { skip, timeout: 60_000 }, async () => {
  // Another video plays the library's song as its music.
  await project("board-sound-other", { duration: 6, layers: [audioLayer("song")] });
  for (const id of ["board-sound-none", "board-sound-sent"]) {
    await stopProject(id);
    assert.equal((await editBoard(id, STOP_SHOTS())).isError, undefined);
  }
  // The person sends a sound file for one video (uploaded to it).
  const cheer = path.join(folder, "cheer.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1", "-ac", "1", cheer]);
  const response = await server.api("/api/media?project=board-sound-sent", { method: "POST", headers: { "content-type": "audio/wav", "x-file-name": "cheer.wav" }, body: await readFile(cheer) });
  assert.equal(response.status, 201, await response.clone().text());
  const none = await checkpoint("board-sound-none");
  assert.ok(none.data.ask.includes("\nNo sound effects. Send me sound files, or say so and I add a few from kino's library.\n"), none.data.ask);
  const sent = await checkpoint("board-sound-sent");
  assert.ok(sent.data.ask.includes("\nNo sound effects.\n"), sent.data.ask);
});

// The person answers the board stop on the dashboard's stop card (B2b with B4a): approve, or
// approve with notes, freezes the board the stop showed, as a chat answer does (by "dashboard");
// a later change past kino's tolerances lapses it, a smaller one is logged; a redo freezes
// nothing; a reopen takes the approval back (the frozen copies stay), so the board is asked again
// whole. The card's pictures come from GET /api/dashboard/board: the pages look board draws, of
// the revision the stop showed. No chat answer here, so nothing waits for too_fast.
test("the board stop answered on the dashboard: approve and approve with notes freeze the board, a bigger change lapses it, a reopen takes it back", { skip, timeout: 120_000 }, async () => {
  const id = "board-dashboard";
  const stops = async (body) => {
    const response = await server.api("/api/dashboard/stops", { method: "POST", headers: { "x-kino-review": key }, body: { project: id, ...body } });
    return { status: response.status, body: await response.json() };
  };
  const boardPage = (query) => server.api(`/api/dashboard/board?${new URLSearchParams({ project: id, ...query })}`);
  const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  const repliesOf = (lines) => lines[0].match(/replies (\d+)\/10/)[1];
  await stopProject(id);
  assert.equal((await editBoard(id, STOP_SHOTS(), DECIDED)).isError, undefined);
  const asked = await checkpoint(id);
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  const rev = asked.data.rev;

  // The stop card shows the board: the waiting stop carries it (with the ask), and its one page
  // is the PNG the agent's look board draws, 4 rows of 273 px.
  const { waiting } = (await (await server.api(`/api/dashboard/snapshot?project=${id}`)).json()).agent.stops;
  assert.deepEqual([waiting.id, waiting.kind, waiting.rev, waiting.ask, waiting.board], ["C1", "board", rev, asked.data.ask, asked.data.board]);
  const page = await boardPage({ rev, page: 1 });
  assert.equal(page.status, 200, await page.clone().text());
  assert.deepEqual([page.headers.get("content-type"), page.headers.get("x-board-pages")], ["image/png", "1"]);
  assert.match(page.headers.get("cache-control"), /immutable/, "a page of a revision never changes");
  const png = Buffer.from(await page.arrayBuffer());
  assert.deepEqual(pngSize(png), { width: 1092, height: 4 * 273 });
  const look = await agent("look", { project: id, mode: "board" });
  assert.deepEqual(png, Buffer.from(look.images[0].data, "base64"), "the card's page is the agent's look board");
  assert.deepEqual([(await boardPage({ rev, page: 2 })).status, (await (await boardPage({ rev, page: 2 })).json()).error], [400, "page is 1 to 1 (4 shots, 4 a page)."]);
  assert.equal((await boardPage({ rev: rev + 1, page: 1 })).status, 400, "a revision the project does not have yet");
  assert.equal((await server.api("/api/dashboard/board?project=no-such-project&page=1")).status, 404);

  // Approved on the dashboard: kino keeps a copy of the board it showed, as for a chat answer.
  const approved = await stops({ action: "answer", id: "C1", rev, read_as: "approve" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  let state = await savedState(id);
  const shown = (await record(id)).document.board;
  assert.deepEqual({ ...state.boards[0], at: "at" }, { stop: "C1", board: shown.rev, rev, at: "at", by: "dashboard", read_as: "approve", musicFile: null, copy: shown, lapsed: null, revisions: [] });
  assert.deepEqual(approved.body.stops.board, { approved: { stop: "C1", board: shown.rev, rev, at: state.boards[0].at, by: "dashboard", lapsed: null, revisions: [] } });
  const passed = await checkpoint(id);
  // The agent hears the answer with its next call, here the board stop, which has passed.
  assert.equal(withoutNext(passed.text), `C1 board passed at rev ${rev} (approve in kino, ${clock(state.stops[0].answer.at)}); nothing changed since. Go on.\ninbox ◆1\n  C1 board approved by the person in kino. Go on.`);

  // A new title lapses it; asked again, only that shot is listed.
  const retitled = withShot(STOP_SHOTS(), 3, { text: { text: "The dragon returns", family: "Inter" } });
  const lapse = await editBoard(id, retitled, DECIDED);
  assert.deepEqual(lapse.data.board, { rev: shown.rev + 1, approval: "C1", lapsed: ["shot 4 text changed"], next: LAPSE_NEXT("C1") });
  const lapsedLines = await statusLines(id);
  assert.deepEqual(lapsedLines, [`direction: C1 board lapsed · replies ${repliesOf(lapsedLines)}/10`, "step: ask board again (changed shots)"]);
  const again = await checkpoint(id);
  assert.equal(again.data.id, "C2", again.text);
  assert.ok(again.data.ask.startsWith("The storyboard changed since you approved it (C1); asking again (C2): shot 4 text changed.\n"), again.data.ask);

  // Approved with notes on the dashboard: a second copy, read as approve with notes. The noted
  // change is past the tolerances (the title moves), so it lapses C2 and the person sees it
  // again; a cut moved 3 frames first is only logged.
  const noted = await stops({ action: "answer", id: "C2", rev: again.data.rev, read_as: "approve with notes", words: "the last line a little higher" });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  state = await savedState(id);
  assert.equal(state.boards.length, 2);
  assert.deepEqual({ ...state.boards[1], at: "at" }, { stop: "C2", board: shown.rev + 1, rev: again.data.rev, at: "at", by: "dashboard", read_as: "approve with notes", musicFile: null,
    copy: (await record(id)).document.board, lapsed: null, revisions: [] });
  assert.equal(state.boards[0].stop, "C1", "the first approval's entry stays");
  const nudged = withShot(withShot(retitled, 0, { dur: 1.35 }), 1, { cue: 1.35, dur: 1.983 });
  const nudge = await editBoard(id, nudged, DECIDED);
  assert.deepEqual(nudge.data.board, { rev: shown.rev + 2, approval: "C2", revisions: ["revision: shot 2 cut moved 3 frames"] });
  const higher = await editBoard(id, withShot(nudged, 3, { text: { text: "The dragon returns", family: "Inter", y: 15 } }), DECIDED);
  assert.deepEqual(higher.data.board, { rev: shown.rev + 3, approval: "C2", lapsed: ["shot 4 text changed"], next: LAPSE_NEXT("C2") });
  state = await savedState(id);
  assert.deepEqual(state.boards[1].revisions.map((entry) => entry.line), ["revision: shot 2 cut moved 3 frames"]);
  assert.equal(state.boards[1].lapsed.why[0], "shot 4 text changed");

  // Asked again and approved: then the person reopens that approval on the dashboard. It no
  // longer stands (the copies stay as they were), status says to ask the board again (no check:
  // the board is shown before anything is built), later stops wait, and the next ask shows the
  // whole board, not only changed shots.
  const third = await checkpoint(id);
  assert.equal(third.data.id, "C3", third.text);
  assert.equal((await stops({ action: "answer", id: "C3", rev: third.data.rev, read_as: "approve" })).status, 200);
  const frozen = (await savedState(id)).boards;
  assert.deepEqual(frozen.map((entry) => [entry.stop, entry.by, entry.read_as]), [["C1", "dashboard", "approve"], ["C2", "dashboard", "approve with notes"], ["C3", "dashboard", "approve"]]);
  await agent("status", { project: id });
  const reopened = await stops({ action: "reopen", id: "C3" });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.deepEqual(reopened.body.stops.board, { approved: null });
  assert.equal(reopened.body.stops.rounds.at(-1).status, "reopened");
  assert.deepEqual((await savedState(id)).boards, frozen, "a reopen changes no frozen copy");
  const status = await agent("status", { project: id });
  assert.ok(status.text.includes('C3 board reopened by the person in kino: they take back their answer (approve). Ask again: notes {action:"checkpoint", id:"board"}.'), status.text);
  const reopenLines = status.text.split("\n").slice(1, 3);
  assert.deepEqual(reopenLines, [`direction: C3 board reopened · replies ${repliesOf(reopenLines)}/10`, "step: ask board again"]);
  try {
    await setting({ limits: { skipRoughUnder: 0 } });
    const rough = await agent("notes", { project: id, action: "checkpoint", id: "rough" });
    assert.equal(rough.data.error, "out_of_order", rough.text);
  } finally {
    await setting({ limits: { skipRoughUnder: 15 } });
  }
  assert.deepEqual((await stops({ action: "reopen", id: "C2" })).body, { error: "C2 has a newer round (C3) of the storyboard: reopen that one." });
  const fourth = await checkpoint(id);
  assert.equal(fourth.data.id, "C4", fourth.text);
  assert.ok(fourth.data.ask.startsWith("The storyboard is ready (C4): 4 shots, 8.8 s, 1080×1920, no music.\n"), fourth.data.ask);
  assert.equal(fourth.data.board.listed, 4, "every shot again");

  // A redo on the dashboard freezes nothing, and asks again without a check.
  const redo = await stops({ action: "answer", id: "C4", rev: fourth.data.rev, read_as: "redo", words: "start on the dragon" });
  assert.equal(redo.status, 200, JSON.stringify(redo.body));
  assert.deepEqual((await savedState(id)).boards, frozen);
  assert.deepEqual(redo.body.stops.board, { approved: null });
  const heard = await agent("status", { project: id });
  assert.ok(heard.text.includes('C4 board: the person asked for a redo in kino: "start on the dragon". Fix only what they named, then ask again: notes {action:"checkpoint", id:"board"}.'), heard.text);
  assert.equal(heard.text.split("\n")[2], "step: fix what they named, ask board again");
});

test("with a clip imported, the first compose hint cuts it, at the brief's length only when the brief sets one", { skip, timeout: 60_000 }, async () => {
  const made = await agent("project", { action: "create", id: "board-hint", name: "board-hint", width: 1080, height: 1920, duration: 24 });
  assert.equal(made.isError, undefined, made.text);
  await agent("edit", { project: "board-hint", ops: ["reference", "treatments"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a hint test" })) });
  const sent = await server.api("/api/media?project=board-hint", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "dragon.mp4" }, body: await readFile(CLIP) });
  assert.equal(sent.status, 201, await sent.clone().text());
  await agent("notes", { project: "board-hint", action: "brief", fields: { message: { text: "The dragon is back", by: "guessed" } } });
  const next = async () => (await agent("check", { project: "board-hint", pixels: false, rules: ["assertions"] })).text.match(/^next: (.*)$/m)?.[1];
  // No length in the brief: the footage planner picks one (not the empty scene's 24 s).
  assert.equal(await next(), 'edit {"ops":[{"op":"compose","footage":["dragon.mp4"],"format":"9:16"}]}');
  await agent("notes", { project: "board-hint", action: "brief", fields: { length: 30 } });
  assert.equal(await next(), 'edit {"ops":[{"op":"compose","footage":["dragon.mp4"],"format":"9:16","duration":30}]}');
});

test("a shot or layer whose span of its file runs across the file's own cut: a crossing under 0.25 s is slid off, a longer one is stated with the scene second", { skip, timeout: 60_000 }, async () => {
  await project("board-cut", { duration: 6, layers: [videoLayer()] });
  // The clip cuts at 1.25 s and 3.333 s. Shot 1 plays file 0.1-1.3 s (0.05 s of the next shot at its end);
  // shot 3 plays 2.7-3.789 s at speed 0.33, so file 3.333 s lands at scene 4.62 s and 1.38 s of the next shot shows.
  const saved = await editBoard("board-cut", [footage(0, 1.2, 0.1, 30), footage(1.2, 1.5, 1.4, 30), footage(2.7, 3.3, 2.7, 30, { speed: 0.33 })]);
  assert.equal(saved.isError, undefined, saved.text);
  const shots = (await record("board-cut")).document.board.shots;
  assert.deepEqual(shots.map((shot) => [shot.cue, shot.dur, shot.in]), [[0, 1.2, 0.04], [1.2, 1.5, 1.4], [2.7, 3.3, 2.7]]);
  const notes = saved.data.notes.join("\n");
  assert.match(notes, /board shot 1: its span of sintel-village-dragon\.mp4 crossed a cut by 0\.05 s \(file 1\.25 s lands at 1\.15 s\), so in moved 0\.1→0\.04 s and the span ends before it; cue and length stay/);
  assert.match(notes, /board shot 3 \(sintel-village-dragon\.mp4\) plays across a cut of its file.*file 3\.33 s lands at 4\.62 s of the scene \(1\.92 s of the shot before it, 1\.38 s of the next\): out 3\.323 s ends before it/);
  assert.doesNotMatch(notes, /board shot 2/);
  // A layer given a span across the cut says so in its receipt; moving its offset off the cut says nothing.
  const layer = await agent("edit", { project: "board-cut", ops: [{ op: "update_layer", layer: "footage", properties: { mediaStart: 1, mediaOffset: 2.2, mediaDuration: 1.2 } }] });
  assert.equal(layer.isError, undefined, layer.text);
  assert.match(layer.data.notes.join("\n"), /footage plays across a cut of its file.*file 3\.33 s lands at 2\.13 s of the scene \(1\.13 s of the shot before it, 0\.07 s of the next\): out 3\.323 s ends before it \(mediaDuration 1\.123\)/);
  const off = await agent("edit", { project: "board-cut", ops: [{ op: "update_layer", layer: "footage", properties: { mediaDuration: 1.1 } }] });
  assert.doesNotMatch((off.data.notes ?? []).join("\n"), /across a cut/);
  // A board saved before this default (an old document; maybe the approved one) keeps its in-point
  // when the same shot is sent again: the crossing is stated, not slid.
  const { document, revision } = await record("board-cut");
  const old = { ...document.board, rev: document.board.rev + 1, shots: document.board.shots.map((shot, index) => (index === 0 ? { ...shot, in: 0.1 } : shot)) };
  assert.equal((await server.api("/api/projects/board-cut", { method: "PUT", body: { document: { ...document, board: old }, revision } })).status, 200);
  const again = await editBoard("board-cut", [footage(0, 1.2, 0.1, 30), footage(1.2, 1.5, 1.4, 30), footage(2.7, 3.3, 2.7, 30, { speed: 0.33 })]);
  assert.equal((await record("board-cut")).document.board.shots[0].in, 0.1, again.text);
  assert.match(again.data.notes.join("\n"), /board shot 1 \(sintel-village-dragon\.mp4\) plays across a cut.*file 1\.25 s lands at 1\.15 s.*out 1\.24 s ends before it \(not moved: the saved board has this shot as sent\)/);
});

test("a layer slowed over drawn footage says in its receipt which interpolation plays, why, and the file's measured hold", { skip, timeout: 60_000 }, async () => {
  // A copy of the clip whose record says it is drawn on 3s at 24 fps.
  const drawn = await upload(server, CLIP, "video/mp4");
  const file = path.join(server.dataDirectory, "media", `${drawn.src.replace("/api/media/", "")}.json`);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), holds: { repeated: 0.67, frames: 3, stills: [], fps: 24 } }));
  await project("drawn-slow", { width: 1920, height: 1080, layers: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: drawn.src } }] });
  const notes = async (properties) => ((await agent("edit", { project: "drawn-slow", ops: [{ op: "update_layer", layer: "footage", properties }] })).data.notes ?? []).join("\n");
  assert.match(await notes({ mediaSpeed: 0.5 }), /footage slows drawn footage to 0\.5x: interpolation nearest \(kino's default: each drawing shows whole, held longer\); the file holds each drawing 3 frames \(0\.13 s\), 0\.25 s on screen/);
  assert.match(await notes({ mediaInterpolation: "blend" }), /footage slows drawn footage to 0\.5x: interpolation blend \(set on the layer: cross-fades two drawings where one changes to the next\)/);
  assert.doesNotMatch(await notes({ mediaSpeed: 1 }), /drawn footage/);
});
