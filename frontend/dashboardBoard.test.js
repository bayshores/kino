// The storyboard screen (direction plan §5 "You see", milestone B4b), as plain data: the header,
// each shot's layer lines and its one sentence, where the crop and boxes go, what changed after a
// redo, the phone's order, the c key, the answer with notes on shots, :board and the requests.
// The board data is the server's own (backend/agent/board-data.mjs), so the words are tested on
// the shape the screen really gets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardData as serverBoardData } from "../backend/agent/board-data.mjs";
import { normalizeBoard } from "../engine/board.js";
import { answerStop, boardData, boardShotUrl } from "./dashboard/api.js";
import {
  aspectWords, boardHeader, changeLines, changeWords, clockWords, freshLine, headChips, measureWords, overlayBoxes, seconds, shotIndexAt,
  shotLines, shotList, shotSentence, shotTags, statusWords,
  directedShots, directionChips, directionWords, footageBox, steppedLength, withoutDirection,
} from "./dashboard/boardRows.js";
import { KEY_HELP, keyAction, parseCommand } from "./dashboard/keys.js";
import { fromSnapshot, stopAnswer, stopRows } from "./dashboard/state.js";

const press = (key, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
const PARK = "/api/media/park.mp4";

const footage = (fields) => ({ pacing: "free", media: PARK, follow: "steady", text: "none", sound: "none", why: "the dragon over the village", ...fields });
const title = (fields) => ({ pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", sound: "none", why: "the line on its own", ...fields });

// A 9:16 video of 8.8 s with five shots: two of park.mp4 (the second touches the crop's edge),
// a title card, a file kino no longer has and a picture.
function documentWith(shots = SHOTS, extra = {}) {
  const document = {
    scenes: [{ id: "main", width: 1080, height: 1920, duration: 8.8, layers: [] }],
    board: { rev: 3, music: "none", calls: ["the dragon first: it is the news"], open: [], shots, ...extra },
  };
  return normalizeBoard(document);
}
const SHOTS = [
  footage({ id: "S1", cue: 0, dur: 1.3, in: 0, crop: [20, 12, 24, 76], subject: { what: "the dragon", boxes: [[24, 30, 14, 30]], eyes: 40 } }),
  footage({ id: "S2", cue: 1.3, dur: 2, in: 1.3, crop: [38, 12, 24, 76], subject: { what: "the dragon", boxes: [[38, 30, 14, 30]] },
    text: { text: "The dragon is back", family: "Inter", weight: 700, size: 96, y: 20, fill: "#ffffff" }, alts: [{ media: PARK, in: 2, crop: [30, 12, 24, 76], subject: "none", why: "wider, the roofs too" }] }),
  title({ id: "S3", cue: 3.3, dur: 2.2, text: { text: "Look up", family: "Inter", weight: 800, size: 120, y: 30, fill: "#ffffff" } }),
  footage({ id: "S4", cue: 5.5, dur: 1.5, in: 0, media: "/api/media/gone.mp4", crop: "none", subject: "none" }),
  footage({ id: "S5", cue: 7, dur: 1.8, in: "none", media: "/api/media/roofs.png", crop: "none", subject: "none", follow: "none", pacing: "beat_cut" }),
];
const RECORDS = new Map([
  [PARK, { name: "park.mp4", width: 384, height: 216, mime: "video/mp4" }],
  ["/api/media/gone.mp4", null],
  ["/api/media/roofs.png", { name: "roofs.png", width: 1080, height: 1920, mime: "image/png" }],
]);
const STATE = { brief: { fields: { plays_on: { text: "TikTok" }, message: { text: "the dragon is back over the village" } } } };
const ROUND = { id: "C1", kind: "board", rev: 7, status: "waiting", fresh: "ran" };

function board({ document = documentWith(), round = ROUND, state = STATE } = {}) {
  return serverBoardData(document, { state, round, rev: 7, project: "p1", records: RECORDS });
}
const lines = (shot, data) => Object.fromEntries(shotLines(shot, data).map((line) => [line.name, line.text]));

test("the header names the stop, the board, the shots, the length, the shape and the platform", () => {
  const data = board();
  assert.equal(boardHeader(data), "C1 · board r3 · 5 shots · 8.8 s · 9:16 · TikTok");
  assert.equal(boardHeader(board({ state: { brief: null }, round: null })), "not asked yet · board r3 · 5 shots · 8.8 s · 9:16 · platform not set");
  assert.equal(freshLine(data), "fresh-eyes check: ran (a second agent read the board before you)");
  assert.equal(freshLine({ ...data, fresh: "skipped" }), "fresh-eyes check: skipped (the agent's app cannot start a second agent)");
  assert.equal(freshLine({ ...data, fresh: "not reported" }), "fresh-eyes check: not reported by the agent");
  assert.equal(freshLine({ ...data, stop: null }), null, "a board not asked yet has no fresh-eyes line");
});

test("the shape is said in words: the four kino names, else width×height", () => {
  assert.equal(aspectWords({ width: 1080, height: 1920 }), "9:16");
  assert.equal(aspectWords({ width: 1920, height: 1080 }), "16:9");
  assert.equal(aspectWords({ width: 1080, height: 1080 }), "1:1");
  assert.equal(aspectWords({ width: 1080, height: 1350 }), "4:5");
  assert.equal(aspectWords({ width: 1000, height: 1300 }), "1000×1300");
  assert.equal(aspectWords({ aspect: "9:16", width: 1, height: 1 }), "9:16", "the server's word wins");
  assert.equal(aspectWords({}), "shape not set");
  assert.deepEqual([seconds(1.25), seconds(8.8), seconds(0), seconds("x")], ["1.3", "8.8", "0", "?"]);
  assert.deepEqual([shotList([2]), shotList([2, 4]), shotList([2, 4, 5])], ["shot 2", "shots 2 and 4", "shots 2, 4 and 5"]);
});

test("every layer of a shot has a line, none where it is empty, sound none (the built-in library needs no switch)", () => {
  const data = board();
  const [one, two, three, four, five] = data.shots;
  assert.deepEqual(lines(one, data), {
    footage: "park.mp4 from 0 s · crop 24 × 76% at 20, 12", subject: "the dragon · box by the agent", measured: "100% in the crop · edge 17% · eyes 37% from the top",
    follow: "steady", pacing: "free", text: "none", sound: "none", why: "the dragon over the village",
  });
  assert.deepEqual(lines(two, data), {
    footage: "park.mp4 from 1.3 s · crop 24 × 76% at 38, 12", subject: "the dragon · box by the agent", measured: "100% in the crop · touches the edge · eyes not marked",
    "look at": "subject touches the crop edge", follow: "steady", pacing: "free", text: "\"The dragon is back\" · Inter 700 · 96 px · y 20%", sound: "none",
    why: "the dragon over the village", options: "1: wider, the roofs too",
  });
  assert.equal(shotLines(two, data).find((line) => line.name === "look at").tone, "look");
  assert.deepEqual(lines(three, data), {
    footage: "none", subject: "none", follow: "none", pacing: "free", text: "\"Look up\" · Inter 800 · 120 px · y 30%", sound: "none", why: "the line on its own",
  });
  assert.equal(lines(four, data).footage, "missing: gone.mp4 is not in the media library");
  assert.equal(lines(four, data).measured, undefined, "no numbers for a file kino does not have");
  assert.deepEqual([lines(five, data).footage, lines(five, data).pacing], ["roofs.png (a picture) · shown whole", "beat cut"]);
  assert.equal(measureWords(five), "no subject box to measure · eyes not marked");
  // With a sound file sent, an empty sound is just none.
  assert.equal(lines(one, { ...data, audio: ["rain.wav"] }).sound, "none");
});

test("a screen reader hears each shot as one sentence: a full shot, a none shot and a missing file", () => {
  const data = board();
  const [one, two, three, four, five] = data.shots;
  assert.equal(shotSentence(two, data), "Shot 2 of 5, 1.3 to 3.3 seconds: park.mp4 from 1.3 s, cropped to 24 by 76 percent; subject the dragon, 100 percent in the crop, "
    + "touching the edge, marked by the agent; text \"The dragon is back\" in Inter 700; no sound effect; follow steady; why: the dragon over the village. "
    + "Look at: subject touches the crop edge. 1 other option.");
  assert.equal(shotSentence(one, data), "Shot 1 of 5, 0 to 1.3 seconds: park.mp4 from 0 s, cropped to 24 by 76 percent; subject the dragon, 100 percent in the crop, "
    + "17 percent from the edge, eyes 37 percent from the top, marked by the agent; no text; no sound effect; follow steady; why: the dragon over the village.");
  assert.equal(shotSentence(three, data), "Shot 3 of 5, 3.3 to 5.5 seconds: no footage; text \"Look up\" in Inter 800; no sound effect; why: the line on its own.");
  assert.equal(shotSentence(four, data), "Shot 4 of 5, 5.5 to 7 seconds: gone.mp4 is missing from the media library; no subject marked; no text; no sound effect; "
    + "follow steady; why: the dragon over the village. Look at: no subject marked.");
  assert.match(shotSentence(five, data), /^Shot 5 of 5, 7 to 8\.8 seconds: roofs\.png, a picture, shown whole; no subject marked; no text;/);
});

test("the crop, the subject boxes and the eye line are drawn in % of the source frame", () => {
  const [one, , three, four, five] = board().shots;
  assert.deepEqual(overlayBoxes(one), {
    crop: { left: 20, top: 12, width: 24, height: 76 }, subjects: [{ left: 24, top: 30, width: 14, height: 30 }], eyes: { top: 40, left: 20, width: 24 },
    labels: [
      { kind: "crop", text: "crop", style: { left: "20%", top: "12%" } },
      { kind: "subject", text: "agent", style: { left: "24%", top: "60%" } },
      { kind: "eyes", text: "eyes", style: { left: "20%", bottom: "60%" } },
    ],
  });
  // A box that reaches the bottom of the frame has its label inside it (review round 1 of B4b):
  // below it, the frame's edge would cut the label off.
  const subjectLabel = (box) => overlayBoxes({ ...one, subject: { ...one.subject, boxes: [box] } }).labels[1].style;
  assert.deepEqual([[26, 40, 18, 60], [26, 30, 18, 58], [26, 30, 18, 59], [24, 30, 14, 30]].map((box) => "bottom" in subjectLabel(box)), [true, false, true, false]);
  assert.equal(overlayBoxes(three), null, "nothing to draw on for a title card");
  assert.equal(overlayBoxes(four), null, "nor for a missing file");
  assert.deepEqual(overlayBoxes(five), { crop: null, subjects: [], eyes: null, labels: [] });
});

// Review round 2 of B4b: by the frame's top or right edge a label was cut off (the eye line at
// 3%, a box at 86% across), and the crop's label could cover a subject box at the crop's corner.
test("the labels stay inside the frame, and the crop's label goes to a corner clear of the boxes and labels", () => {
  const [one] = board().shots;
  const shot = (crop, boxes, eyes) => overlayBoxes({ ...one, crop, subject: { what: "the dragon", by: "agent", boxes, ...(eyes == null ? {} : { eyes }) } }).labels;
  const style = (labels, kind) => labels.find((label) => label.kind === kind).style;
  // By the right edge: the subject's and the eye line's labels run back from the box's and the
  // line's right end; the eye line by the top has its label under it. The crop's label leaves
  // the top corners (the eye label is there) and the bottom left is clear.
  const right = shot([74, 12, 24, 76], [[86, 40, 12, 25]], 3);
  assert.deepEqual(style(right, "subject"), { right: "2%", top: "65%" });
  assert.deepEqual(style(right, "eyes"), { right: "2%", top: "3%" });
  assert.deepEqual(style(right, "crop"), { left: "74%", bottom: "12%" });
  // A box at the crop's top left: the crop's label goes to the top right corner.
  const corner = shot([0, 0, 31.6, 100], [[1, 1, 12, 20]]);
  assert.deepEqual(corner.map((label) => [label.kind, label.style]), [["crop", { right: "68.4%", top: "0%" }], ["subject", { left: "1%", top: "21%" }]]);
  // The eye line ending in the frame's left half: its label at the line's left end, above it.
  assert.deepEqual(style(shot([2, 12, 24, 76], [[4, 30, 14, 30]], 40), "eyes"), { left: "2%", bottom: "60%" });
  // A box over the whole crop: no corner is clear, so the top left one.
  assert.deepEqual(style(shot([20, 12, 24, 76], [[20, 12, 24, 76]]), "crop"), { left: "20%", top: "12%" });
});

test("after a redo the board says what changed as asked, without being asked, and what was named but not changed", () => {
  const data = board();
  const redone = { stop: "C1", named: ["S2", "S3"], asked: ["S2"], unasked: [{ id: "S1", what: ["crop"] }], missed: ["S3"], removed: [{ id: "S9", start: 8, end: 9 }],
    changed: [{ id: "S1", what: ["crop"] }, { id: "S2", what: ["text"] }] };
  const after = { ...data, redone, shots: data.shots.map((shot) => ({ ...shot, change: shot.id === "S1" ? { asked: false, what: ["crop"] } : shot.id === "S2" ? { asked: true, what: ["text"] } : null })) };
  assert.deepEqual(changeLines(after), ["changed as you asked in C1: shot 2", "changed without being asked: shot 1 (crop), the shot at 8–9 s (removed)", "named but not changed: shot 3"]);
  assert.deepEqual(after.shots.slice(0, 4).map((shot) => changeWords(shot, after)), ["changed without being asked: crop", "changed as you asked: text", "named but not changed", null]);
  assert.match(shotSentence(after.shots[0], after), / Changed without being asked: crop\.$/);
  assert.equal(shotLines(after.shots[1], after).at(-1).tone, "change");
  // Nothing named: every change; none at all.
  const unnamed = { ...after, redone: { ...redone, named: [], asked: [], unasked: [], missed: [], removed: [] } };
  assert.deepEqual(changeLines(unnamed), ["changed since C1: shot 1 (crop), shot 2 (text)"]);
  assert.equal(changeWords(unnamed.shots[0], unnamed), "changed since C1: crop");
  assert.deepEqual(changeLines({ ...data, redone: { stop: "C1", named: [], asked: [], unasked: [], missed: [], removed: [] } }), ["nothing changed since C1"]);
  // A new shot order or new music is a change too: after the shots, or on its own line.
  assert.deepEqual(changeLines({ ...data, redone: { stop: "C1", named: [], asked: [], unasked: [], missed: [], removed: [], order: true, music: true } }), ["changed since C1: the shot order and the music"]);
  assert.deepEqual(changeLines({ ...unnamed, redone: { ...unnamed.redone, music: true } }), ["changed since C1: shot 1 (crop), shot 2 (text), the music"]);
  assert.deepEqual(changeLines({ ...after, redone: { ...redone, order: true } }).at(-1), "also changed: the shot order");
  assert.deepEqual(changeLines({ ...data, lapsed: { why: ["shot 2's crop changed"], approved: "C1" } }), ["changed since you approved C1: shot 2's crop changed"]);
  // The phone's card: the changed and named shots first, then the flagged one, then the rest; 2 at
  // most (review round 1 of B4b: with 4 rows the answers were 4 phone screens down).
});

test("the read-only board says where it stands", () => {
  const data = board();
  const time = () => "14:05";
  assert.equal(statusWords(data, time), "waits for you");
  assert.equal(statusWords({ ...data, status: "answered", answer: { via: "dashboard", read_as: "approve with notes", at: "x" } }, time), "answered: approved with notes on the dashboard at 14:05");
  assert.equal(statusWords({ ...data, status: "answered", answer: { via: "chat", read_as: "approve", at: "x" } }, time), "answered: approved in chat at 14:05");
  assert.equal(statusWords({ ...data, status: "not asked yet" }), "not asked yet: the agent has not shown you this board");
});

test("c on a shot row that takes a note opens it, on the stop screen and the phone's stack; elsewhere c keeps its job", () => {
  assert.equal(keyAction(press("c"), { screen: "stop", shot: true }), "stop-shot-note");
  assert.equal(keyAction(press("c"), { screen: "main", shot: true }), "stop-shot-note");
  assert.equal(keyAction(press("c"), { screen: "stop" }), "stop-shot-pick", "no row focused: the dashboard says to pick a shot");
  assert.equal(keyAction(press("c"), { screen: "board" }), null, "the read-only board takes no notes");
  // Tab on a shot row itself (after Esc in its note) goes to the card's note, not back into the shot's.
  assert.equal(keyAction(press("Tab"), { screen: "stop", shot: true, row: true }), "stop-note");
  assert.equal(keyAction(press("Tab"), { screen: "main", shot: true, row: true }), "stop-note", "the phone's stack");
  assert.equal(keyAction(press("Tab", { shiftKey: true }), { screen: "stop", shot: true, row: true }), null, "Shift+Tab keeps its job");
  assert.equal(keyAction(press("Tab"), { screen: "stop", shot: true }), null, "a button in the row: the browser's Tab");
  assert.equal(keyAction(press("Tab"), { screen: "stop", shot: true, row: true, typing: true }), null, "typing in the note");
  assert.equal(keyAction(press("c"), { screen: "main" }), "note", "the note at the playhead");
  assert.equal(keyAction(press("c"), { screen: "stop", shot: true, typing: true }), null, "typing in a field");
  // a, Tab and d keep their jobs on a focused row; j and k move between rows.
  assert.equal(keyAction(press("a"), { screen: "stop", shot: true }), "stop-approve");
  assert.equal(keyAction(press("d"), { screen: "stop", shot: true }), "stop-redo");
  assert.equal(keyAction(press("j"), { screen: "stop", shot: true }), "down");
  assert.equal(keyAction(press("k"), { screen: "board" }), "up");
  assert.deepEqual(KEY_HELP.find(([key]) => key === "a Tab d c"), ["a Tab d c", "on a stop: approve, approve with a note, redo with a note, a note on one shot (A, D off)"]);
  assert.deepEqual(parseCommand("board"), { action: "board" });
  assert.deepEqual(parseCommand(":storyboard"), { action: "board" });
});

test("notes on shots go with the answer: a approves with notes, Tab, d and Enter send without words", () => {
  const round = { id: "C1", kind: "board", rev: 7 };
  const shots = [{ id: "S2", words: "  tighter " }, { id: "S4", words: "   " }];
  const noted = [{ id: "S2", words: "tighter" }];
  assert.deepEqual(stopAnswer(round, { press: "approve", shots }), { send: { id: "C1", rev: 7, read_as: "approve with notes", shots: noted } });
  assert.deepEqual(stopAnswer(round, { press: "notes", shots }), { send: { id: "C1", rev: 7, read_as: "approve with notes", shots: noted } });
  assert.deepEqual(stopAnswer(round, { press: "redo", shots }), { send: { id: "C1", rev: 7, read_as: "redo", shots: noted } });
  assert.deepEqual(stopAnswer(round, { press: "enter", mode: "redo", text: "warmer", shots }), { send: { id: "C1", rev: 7, read_as: "redo", words: "warmer", shots: noted } });
  assert.deepEqual(stopAnswer(round, { press: "approve", text: "warmer", shots }), { send: { id: "C1", rev: 7, read_as: "approve with notes", words: "warmer", shots: noted } });
  // Without notes on shots, as before.
  assert.deepEqual(stopAnswer(round, { press: "approve", shots: [{ id: "S2", words: " " }] }), { send: { id: "C1", rev: 7, read_as: "approve" } });
  assert.deepEqual(stopAnswer(round, { press: "redo" }), stopAnswer(round, { press: "redo", shots: [] }));
  // A no on the agent's calls is a note too: its words follow the note's.
  const noCalls = ["Inter 700 for every line"];
  assert.deepEqual(stopAnswer(round, { press: "approve", noCalls }), { send: { id: "C1", rev: 7, read_as: "approve with notes", words: 'no to your call "Inter 700 for every line"' } });
  assert.equal(stopAnswer(round, { press: "redo", text: "warmer", noCalls: [...noCalls, "no music"] }).send.words, 'warmer; no to your call "Inter 700 for every line"; no to your call "no music"');
});

test("the playhead's shot and clock; the head's chips and each shot's tags say the shot in a few words", () => {
  const data = board();
  assert.deepEqual([shotIndexAt(data, 0), shotIndexAt(data, 1.3), shotIndexAt(data, 5), shotIndexAt(data, 99)], [0, 1, 2, 4]);
  assert.deepEqual([clockWords(0), clockWords(4.42), clockWords(65.5)], ["0:00.0", "0:04.4", "1:05.5"]);
  assert.deepEqual(headChips(data), ["5 shots", "8.8 s", "9:16", "TikTok", "no music", "fresh eyes: ran"]);
  assert.deepEqual(headChips({ ...data, stop: null, header: { ...data.header, platform: null } }), ["5 shots", "8.8 s", "9:16", "no music"]);
  const [, two, three] = data.shots;
  assert.deepEqual(shotTags(two, data).map((tag) => [tag.kind, tag.text, tag.tone ?? null]), [
    ["text", '"The dragon is back"', null], ["look", "subject touches the crop edge", "look"], ["options", "1 other option", null],
  ]);
  assert.deepEqual(shotTags({ ...three, move: { kind: "transition", name: "zoom-through", ref: "a@1" }, follow: "track" }, data).map((tag) => tag.text), ['"Look up"', "zoom through", "track"]);
  assert.deepEqual(shotTags({ ...three, text: "none", move: { none: "cut" } }, data), [], "a plain cut has no move tag");
});

test("an answered storyboard's stop line names the notes on shots", () => {
  const at = new Date(2026, 9, 21, 14, 5).toISOString();
  const data = fromSnapshot({
    boot: "b1", seq: 1, projects: [{ id: "p1" }], current: "p1", projectId: "p1", events: [], approvals: [], agents: [], renders: [],
    agent: { plan: null, notes: [], turns: [], codes: {}, brief: null, stops: { waiting: null, stopAsking: null, rounds: [
      { id: "C1", kind: "board", rev: 7, askedAt: at, status: "answered", offer: [],
        answer: { via: "dashboard", read_as: "redo", words: "warmer", at, client: "dashboard", shots: [{ id: "S2", n: 2, words: "tighter" }, { id: "S4", n: 4, words: "later" }] } },
    ] } },
  });
  const [row] = stopRows(data);
  assert.equal(row.kind, "board");
  assert.equal(row.text, 'C1 storyboard · redo on the dashboard: "warmer" · notes on shots 2 and 4 · 14:05');
});

test("the requests: the board's data, a shot's picture and an answer with notes on shots", async () => {
  const calls = [];
  const original = { fetch: globalThis.fetch, location: globalThis.location };
  globalThis.location = new URL("http://127.0.0.1:4173/");
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
    const body = String(url).includes("review-key") ? { key: "k" } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await boardData("p 1", { stop: "C1" });
    await boardData("p1", { rev: 7 });
    await boardData("p1");
    await answerStop("p1", { id: "C1", rev: 7, read_as: "redo", words: "warmer", shots: [{ id: "S2", words: "tighter" }] });
    await answerStop("p1", { id: "C1", rev: 7, read_as: "approve", shots: [] });
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.location = original.location;
  }
  assert.deepEqual(calls.filter((call) => call.method === "GET").map((call) => call.url), [
    "/api/dashboard/board-data?project=p+1&stop=C1", "/api/dashboard/board-data?project=p1&rev=7", "/api/dashboard/board-data?project=p1",
  ]);
  const answers = calls.filter((call) => call.url === "/api/dashboard/stops").map((call) => call.body);
  assert.deepEqual(answers, [
    { project: "p1", action: "answer", id: "C1", rev: 7, read_as: "redo", words: "warmer", shots: [{ id: "S2", words: "tighter" }] },
    { project: "p1", action: "answer", id: "C1", rev: 7, read_as: "approve" },
  ], "shots only when there are some");
  assert.equal(boardShotUrl({ projectId: "p1", rev: 7, shot: "S2", part: "source", width: 480 }), "/api/dashboard/board-shot?project=p1&rev=7&shot=S2&part=source&w=480");
});

test("directions on shots: an option, a length and remove become the shot's note, a chip each, and the board as directed", () => {
  const data = board();
  const notes = {
    S2: { n: 2, text: " tighter ", pick: { n: 1, letter: "B", why: "wider, the roofs too" }, length: { to: 1.8, was: 2 } },
    S3: { n: 3, text: "", remove: true },
    S1: { n: 1, text: "", noteOpen: true },
  };
  assert.equal(directionWords(notes.S2), "use option B: wider, the roofs too; make it 1.8 s (was 2 s); tighter");
  assert.equal(directionWords(notes.S3), "remove this shot");
  assert.equal(directionWords(notes.S1), "", "an empty open note says nothing");
  assert.deepEqual(directionChips(notes).map((chip) => [chip.id, chip.field, chip.text]), [
    ["S2", "pick", "shot 2: wider, the roofs too"], ["S2", "length", "shot 2: 1.8 s"], ["S2", "text", "shot 2: note"], ["S3", "remove", "shot 3: remove"],
  ]);
  assert.deepEqual(withoutDirection(notes.S2, "pick"), { n: 2, text: " tighter ", length: { to: 1.8, was: 2 } });
  assert.equal(withoutDirection(notes.S3, "remove"), null, "nothing left");
  assert.deepEqual([steppedLength(2, 0.1), steppedLength(0.3, -0.1), steppedLength(20, 0.1), steppedLength(1.25, -0.1)], [2.1, 0.3, 20, 1.2]);
  // The board as directed: shot 2 takes option B's footage and crop at 1.8 s, shot 3 has no length.
  const shots = directedShots(data, notes);
  assert.deepEqual(shots.map((shot) => [shot.id, Number(shot.start.toFixed(2)), Number(shot.dur.toFixed(2)), shot.picked, shot.removed]),
    [["S1", 0, 1.3, 0, false], ["S2", 1.3, 1.8, 1, false], ["S3", 3.1, 0, 0, true], ["S4", 3.1, 1.5, 0, false], ["S5", 4.6, 1.8, 0, false]]);
  assert.deepEqual([shots[1].in, shots[1].crop, shots[1].subject, shots[1].why], [2, [30, 12, 24, 76], "none", data.shots[1].why], "the option's fields; the shot keeps its reason");
  // The footage placed as the still places it: a 9:16 crop of 384×216 fills the 1080×1920 frame.
  const box = footageBox(data.shots[0], data.header);
  assert.deepEqual(Object.values(box).map((value) => Number(value.toFixed(1))), [-83.3, -15.9, 416.7, 131.8]);
  assert.deepEqual(footageBox(data.shots[2], data.header), null, "a title card has no footage");
});
