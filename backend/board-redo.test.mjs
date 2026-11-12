// After a storyboard redo (direction plan §5, milestone B4b): kino reads which shots the
// person's words name, keeps the board it showed, and on the next ask says what changed as they
// asked, what changed without being asked, and what they named but did not change. The board's
// ask also says whether a second agent read the board first (the fresh-eyes check), and the
// person's notes on single shots (the dashboard's c key) reach the agent with their answer.
//
// The first part is plain data in and out (board.mjs, board-text.mjs, stops.mjs). The second
// runs a real server with the Sintel test clip (tests/fixtures/footage/SOURCES.md, CC BY 3.0),
// 384×216, 4.417 s, through the agent API and the dashboard's stops route. Font downloads are
// off, so nothing here goes online. A recorded chat answer needs a real wait (gap()).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { boardFacts, namedShots, shotChanges } from "./agent/board.mjs";
import { ASK_SHOTS, ASK_TOKENS, boardAsk, CHANGED_TOKENS, FRESH_TOKENS, SHOT_TOKENS } from "./agent/board-text.mjs";
import { emptyAgentState } from "./agent/state.mjs";
import { StopError, stopsSummary } from "./agent/stops.mjs";
import { answerStep, checkpointStep, dashboardAnswerStep } from "./stops.test.support.mjs";
import { estimateTextTokens } from "./meter.mjs";
import { skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

const PORTRAIT = { width: 1080, height: 1920 };
const IDS = ["S1", "S2", "S3", "S4"];

// ---- the shots the person's words name (F3) -------------------------------------------------

test("namedShots reads shot numbers, lists, ranges, ids and the first and last shot, in board order", () => {
  const seven = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"];
  for (const [words, ids, named] of [
    ["redo shots 2 to 3 and the last shot", IDS, ["S2", "S3", "S4"]],
    ["shot 3 is too dark", IDS, ["S3"]],
    ["Shots 3 and 5 are slow", seven, ["S3", "S5"]],
    ["shots 3, 5 and 7", seven, ["S3", "S5", "S7"]],
    ["shots 3, 5, and 7", seven, ["S3", "S5", "S7"]],
    ["SHOTS 2-4 please", seven, ["S2", "S3", "S4"]],
    ["shots 2–4", seven, ["S2", "S3", "S4"]],
    ["shots 4 to 2", seven, ["S2", "S3", "S4"]],
    ["shot #6", seven, ["S6"]],
    ["s3 needs a closer crop", IDS, ["S3"]],
    ["the first shot and the LAST SHOT", IDS, ["S1", "S4"]],
    ["shot 4, then shot 1", IDS, ["S1", "S4"]],
    ["shot 2 and S2 again", IDS, ["S2"]],
  ]) assert.deepEqual(namedShots(words, ids), named, words);
});

test("namedShots ignores a number past the board, words that are not shots and ids without a digit", () => {
  assert.deepEqual(namedShots("shot 9", IDS), []);
  assert.deepEqual(namedShots("shots 3 to 9", IDS), ["S3", "S4"], "a range is cut at the last shot");
  assert.deepEqual(namedShots("a warmer look overall", IDS), []);
  assert.deepEqual(namedShots("2 seconds shorter, 3 cuts", IDS), [], "a number needs the word shot");
  assert.deepEqual(namedShots("the intro is slow", ["intro", "S2"]), [], "an id with no digit is never read from the words");
  assert.deepEqual(namedShots("last shot", []), []);
  assert.deepEqual(namedShots(null, IDS), []);
});

test("namedShots: a length or a count after a shot number is not another shot, and 'to' makes a range only after 'shots'", () => {
  const six = ["S1", "S2", "S3", "S4", "S5", "S6"];
  for (const [words, named] of [
    ["redo: shorten shot 5 to 1 second, the rest is fine", ["S5"]],
    ["trim shot 4 to 2 seconds", ["S4"]],
    ["redo: trim shot 4 to 2 s", ["S4"]],
    ["cut shot 3 to 2 seconds", ["S3"]],
    ["cut shot 6 to 3 s", ["S6"]],
    ["shot 6 to 1.5 s please", ["S6"]],
    ["redo shot 2, 1.5 s shorter", ["S2"]],
    ["in shot 4, 2 things: crop and text", ["S4"]],
    ["shot 3 20% tighter", ["S3"]],
    ["shots 2 and 4, 2 seconds each", ["S2", "S4"]],
    ["trim shots 3 and 4 to 2 s", ["S3", "S4"]],
    ["make the shots 2 seconds longer", []],
    ["shots 2 to 4 seconds", ["S2"]],
    ["shot 3 and 5", ["S3", "S5"]],
    ["shot 2-4", ["S2", "S3", "S4"]],
  ]) assert.deepEqual(namedShots(words, six), named, words);
});

// Review round 2 of B4b: with ids "1" to "4" (the board op takes them), the "2" of "2 seconds"
// was read as shot 2's id, so "redo: shot 4 should be 2 seconds longer" named shots 2 and 4.
test("namedShots: a plain number or a length is never read as an id, only as a place after 'shot'", () => {
  const numbers = ["1", "2", "3", "4"];
  for (const [words, named] of [
    ["redo: shot 4 should be 2 seconds longer", ["4"]],
    ["make it 2 seconds shorter overall", []],
    ["3 cuts are too fast", []],
    ["shots 2 and 3", ["2", "3"]],
    ["the last shot, 1.5 s", ["4"]],
  ]) assert.deepEqual(namedShots(words, numbers), named, words);
  // An id that reads as a length or a count is not read either; one with a letter and a digit is.
  assert.deepEqual(namedShots("cut 2s, at 30fps", ["2s", "30fps", "S3"]), []);
  assert.deepEqual(namedShots("2b and S3 tighter", ["2b", "30fps", "S3"]), ["2b", "S3"]);
});

// ---- what changed since the board they answered (F4, shotChanges) -----------------------------

const clipShot = (id, cue, dur, extra = {}) => ({ id, cue, dur, pacing: "free", media: "/api/media/clip.mp4", in: cue, crop: [20, 12, 24, 76],
  subject: { what: "the dragon", boxes: [[24, 30, 14, 30]] }, follow: "steady", text: "none", sound: "none", why: "the dragon", alts: [], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const titleShot = (id, cue, dur, extra = {}) => ({ id, cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: "The dragon is back", family: "Inter", weight: 700, size: 96, y: 40, fill: "#ffffff" }, sound: "none", why: "the line", alts: [], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const boardWith = (shots) => ({ rev: 1, music: "none", calls: [], open: [], shots });
const BEFORE = boardWith([clipShot("S1", 0, 1.25), clipShot("S2", 1.25, 1.25), titleShot("S3", 2.5, 2)]);
const changes = (shots) => shotChanges(BEFORE, boardWith(shots), { frame: PORTRAIT });
const whatOf = (shots, id = "S1") => changes(shots).shots.find((entry) => entry.id === id)?.what ?? [];

test("shotChanges names each changed layer past kino's tolerances: 6 frames for times, 5% for a crop", () => {
  const [one, two, three] = BEFORE.shots;
  assert.deepEqual(changes(BEFORE.shots), { shots: [], removed: [], order: false, music: false }, "the same board: nothing");
  assert.deepEqual(whatOf([{ ...one, in: 6 / 30 }, two, three]), [], "in-point 6 frames later");
  assert.deepEqual(whatOf([{ ...one, in: 7 / 30 }, two, three]), ["in-point"], "7 frames");
  assert.deepEqual(whatOf([{ ...one, in: "none" }, two, three]), ["in-point"], "a time to none");
  assert.deepEqual(whatOf([{ ...one, dur: 1.25 + 6 / 30 }, { ...two, cue: 1.25 + 6 / 30, dur: 1.25 - 6 / 30 }, three]), []);
  assert.deepEqual(whatOf([{ ...one, dur: 1.25 + 7 / 30 }, two, three]), ["length"]);
  // Crop [20, 12, 24, 76]: an edge 1.2 points of 24 is 5.0%; 1.3 points is 5.4%.
  assert.deepEqual(whatOf([{ ...one, crop: [21.2, 12, 24, 76] }, two, three]), [], "crop moved 5.0%");
  assert.deepEqual(whatOf([{ ...one, crop: [21.3, 12, 24, 76] }, two, three]), ["crop"], "crop moved 5.4%");
  assert.deepEqual(whatOf([{ ...one, crop: "none" }, two, three]), ["crop"], "a box to none");
  assert.deepEqual(whatOf([one, two, { ...three, crop: [0, 0, 50, 50] }], "S3"), ["crop"], "none to a box");
  for (const [field, value] of [["media", "/api/media/other.mp4"], ["follow", "track"], ["pacing", "beat"], ["text", titleShot().text], ["sound", "a whoosh"]])
    assert.deepEqual(whatOf([{ ...one, [field]: value }, two, three]), [field === "media" ? "footage" : field], field);
  for (const [field, value] of [["subject", { what: "the village", boxes: [[0, 0, 10, 10]] }], ["why", "another reason"], ["alts", ["a wider crop"]]])
    assert.deepEqual(whatOf([{ ...one, [field]: value }, two, three]), [], `${field} is not counted`);
});

test("shotChanges: every word in order, a cue moved by the shot before is not a change, an added and a removed shot", () => {
  const [one, two, three] = BEFORE.shots;
  const everything = { ...one, media: "/api/media/other.mp4", in: 0.5, dur: 2, crop: [40, 12, 24, 76], follow: "track", pacing: "beat", text: titleShot().text, sound: "a whoosh" };
  assert.deepEqual(whatOf([everything, { ...two, cue: 2, dur: 0.5 }, three]), ["footage", "in-point", "length", "crop", "follow", "pacing", "text", "sound"]);
  // Shot 1 is 0.5 s longer, so shot 2 starts 0.5 s later: only shot 1 changed.
  const longer = changes([{ ...one, dur: 1.75 }, { ...two, cue: 1.75 }, { ...three, cue: 3, dur: 1.5 }]);
  assert.deepEqual(longer.shots.map(({ id, what }) => [id, what]), [["S1", ["length"]], ["S3", ["length"]]]);
  // A title card added first; shot 2 removed (named by its time on the board they answered).
  const swapped = changes([titleShot("S4", 0, 1), { ...one, cue: 1 }, { ...three, cue: 2.25 }]);
  assert.deepEqual(swapped, { shots: [{ id: "S4", n: 1, what: ["added"] }], removed: [{ id: "S2", start: 1.25, end: 2.5 }], order: false, music: false });
});

test("shotChanges: a new shot order is the named shots that moved when only they moved, else order; new music is music", () => {
  const [one, two, three] = BEFORE.shots;
  const after = (shots, named) => shotChanges(BEFORE, boardWith(shots), { frame: PORTRAIT, named });
  assert.deepEqual(after([two, one, three]), { shots: [], removed: [], order: true, music: false }, "swapped, nothing named");
  assert.deepEqual(after([two, one, three], ["S1"]), { shots: [{ id: "S1", n: 2, what: ["moved"] }], removed: [], order: false, music: false }, "shot 1 moved after shot 2");
  assert.deepEqual(after([{ ...three, text: title("New") }, one, two], ["S3"]).shots, [{ id: "S3", n: 1, what: ["moved", "text"] }], "the title moved first and changed");
  assert.equal(after([three, two, one], ["S3"]).order, true, "shots 1 and 2 swapped too: not only the named shot moved");
  assert.equal(after([one, two, three], ["S2"]).order, false, "the same order");
  assert.equal(shotChanges(BEFORE, { ...BEFORE, music: "song" }).music, true);
});

// ---- the ask's new lines (F2, F4) -------------------------------------------------------------

const title = (words, y = 40) => ({ text: words, family: "Inter", weight: 700, size: 80, y, fill: "#ffffff" });
// Title cards a second long; a flagged one has its line under the app's captions.
const card = (n, { low = false } = {}) => titleShot(`S${n}`, n - 1, 1, { text: title(`${low ? "Low" : "Line"} ${n}`, low ? 80 : 40) });
const cards = (count, low = []) => boardWith(Array.from({ length: count }, (_, index) => card(index + 1, { low: low.includes(index + 1) })));
const askOf = (board, fields = {}) => boardAsk({ id: "C2", board, frame: PORTRAIT, seconds: board.shots.length, ...fields });
const lines = (result) => result.text.split("\n");
const listedShots = (result) => lines(result).filter((line) => line.startsWith("Shot ")).map((line) => Number(line.match(/^Shot (\d+)/)[1]));
const redo = (fields) => ({ stop: "C1", named: [], asked: [], unasked: [], missed: [], removed: [], changed: [], ...fields });

test("the fresh-eyes line: ran, skipped or not reported, after the agent's calls and before Look at", () => {
  const board = { ...cards(3, [2]), calls: ["Inter 700 for every line"] };
  const at = (fresh) => lines(askOf(board, { fresh, message: "the dragon is back" }));
  assert.deepEqual(at("ran").slice(0, 5), ["The storyboard is ready (C2): 3 shots, 3 s, 1080×1920, no music.", "Brief: the dragon is back",
    "My calls (say no to any): Inter 700 for every line", "Fresh-eyes check: ran.", "Look at: shot 2 (text under the app's captions)."]);
  const said = { ran: "Fresh-eyes check: ran.", skipped: "Fresh-eyes check: skipped (no second agent in this app).", "not reported": "Fresh-eyes check: not reported." };
  for (const [fresh, line] of Object.entries(said)) {
    assert.equal(at(fresh)[3], line);
    assert.ok(estimateTextTokens(line) <= FRESH_TOKENS, `${line}: ${estimateTextTokens(line)} tokens`);
  }
  assert.deepEqual([estimateTextTokens(said.ran), estimateTextTokens(said.skipped), estimateTextTokens(said["not reported"])], [9, 23, 13]);
  assert.ok(!at(null).some((line) => line.startsWith("Fresh-eyes")), "no line when nothing is to be said");
});

test("after a redo: changed as asked, changed without being asked, named but not changed, and those shots listed first", () => {
  const board = { ...cards(12, [5, 9]), calls: ["Inter 700"] };
  const redone = redo({ named: ["S3", "S5", "S4", "S20"], asked: ["S3", "S5", "S20"], unasked: [{ id: "S7", what: ["crop"] }, { id: "S9", what: ["added"] }], missed: ["S4"],
    removed: [{ id: "S20", start: 2, end: 3 }, { id: "S21", start: 8, end: 9 }],
    changed: [{ id: "S3", what: ["text"] }, { id: "S5", what: ["crop"] }, { id: "S7", what: ["crop"] }, { id: "S9", what: ["added"] }] });
  const result = askOf(board, { redone, fresh: "ran" });
  assert.deepEqual(lines(result).slice(0, 7), [
    "The storyboard is ready (C2): 12 shots, 12 s, 1080×1920, no music.",
    "Changed as you asked in C1: shot 3, shot 5, the shot at 2–3 s (removed).",
    "Changed without being asked: shot 7 (crop), shot 9 (added), the shot at 8–9 s (removed).",
    "Named but not changed: shot 4.",
    "My calls (say no to any): Inter 700",
    "Fresh-eyes check: ran.",
    "Look at: shots 5 and 9 (text under the app's captions).",
  ]);
  // Asked (flagged first), then unasked (flagged first), then missed; the rest are counted.
  assert.deepEqual(listedShots(result), [5, 3, 9, 7, 4]);
  assert.ok(result.text.includes('\n7 unchanged: say "all shots".\n'), result.text);
  assert.equal(result.listed, 5);

  // F4's own examples.
  const plain = askOf(cards(9), { redone: redo({ named: ["S3", "S5", "S4"], asked: ["S3", "S5"], missed: ["S4"],
    unasked: [{ id: "S7", what: ["crop"] }, { id: "S9", what: ["added"] }], removed: [{ id: "S10", start: 8, end: 9 }], changed: [{ id: "S7", what: ["crop"] }, { id: "S9", what: ["added"] }] }) });
  assert.deepEqual(lines(plain).slice(1, 4), ["Changed as you asked in C1: shots 3 and 5.", "Changed without being asked: shot 7 (crop), shot 9 (added), the shot at 8–9 s (removed).",
    "Named but not changed: shot 4."]);
  assert.equal(lines(askOf(cards(9), { redone: redo({ named: ["S3", "S5", "S7"], asked: ["S3", "S5", "S7"] }) }))[1], "Changed as you asked in C1: shots 3, 5 and 7.");

  // Every shot with all shots: the redo's shots first, then the rest in board order.
  const all = askOf(board, { redone, all: true });
  assert.deepEqual(listedShots(all), [5, 3, 9, 7, 4, 1, 2, 6, 8, 10, 11, 12]);
  assert.ok(!all.text.includes('say "all shots"'));
});

test("after a redo naming no shot: what changed since, or nothing changed and the board listed as on a first ask", () => {
  const board = cards(10, [8]);
  const since = askOf(board, { redone: redo({ changed: [{ id: "S2", what: ["crop"] }, { id: "S3", what: ["text"] }] }) });
  assert.equal(lines(since)[1], "Changed since C1: shot 2 (crop), shot 3 (text).");
  assert.deepEqual(listedShots(since), [2, 3]);
  assert.ok(since.text.includes('\n8 unchanged: say "all shots".\n'), since.text);
  const removedToo = askOf(board, { redone: redo({ changed: [{ id: "S2", what: ["crop"] }], removed: [{ id: "S11", start: 10, end: 11.5 }] }) });
  assert.equal(lines(removedToo)[1], "Changed since C1: shot 2 (crop), the shot at 10–11.5 s (removed).");

  const nothing = askOf(board, { redone: redo({}) });
  assert.equal(lines(nothing)[1], "Nothing changed since C1.");
  // A new shot order or new music is not "nothing": after the shots, or alone.
  assert.equal(lines(askOf(board, { redone: redo({ order: true }) }))[1], "Changed since C1: the shot order.");
  assert.equal(lines(askOf(board, { redone: redo({ music: true }) }))[1], "Changed since C1: the music.");
  assert.equal(lines(askOf(board, { redone: redo({ order: true, music: true, changed: [{ id: "S2", what: ["crop"] }] }) }))[1], "Changed since C1: shot 2 (crop); also the shot order and the music.");
  assert.deepEqual(listedShots(askOf(board, { redone: redo({ order: true }) })), [8, 1, 2, 3, 4, 5, 6, 7], "no shot changed: listed as on a first ask");
  // Shots named: a line of its own, never "without being asked" (their words may have asked for it).
  assert.deepEqual(lines(askOf(board, { redone: redo({ named: ["S3"], asked: ["S3"], changed: [{ id: "S3", what: ["text"] }], order: true, music: true }) })).slice(1, 3),
    ["Changed as you asked in C1: shot 3.", "Also changed: the shot order and the music."]);
  const first = askOf(board);
  assert.deepEqual(listedShots(nothing), listedShots(first));
  assert.deepEqual(listedShots(first), [8, 1, 2, 3, 4, 5, 6, 7]);
  // Only named shots, none changed: the named one is said, and the board listed as on a first ask.
  const missed = askOf(board, { redone: redo({ named: ["S3"], missed: ["S3"] }) });
  assert.equal(lines(missed)[1], "Named but not changed: shot 3.");
  assert.deepEqual(listedShots(missed), listedShots(first));
});

test("each change line names at most 3 shots and 2 what-words a shot; more than 8 shots are counted", () => {
  const board = cards(20);
  const many = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => `S${from + index}`);
  const what = ["footage", "in-point", "length", "crop", "follow", "pacing", "text", "sound"];
  const unasked = many(8, 11).map((id, index) => ({ id, what: what.slice(0, index + 1) }));
  const redone = redo({ named: [...many(1, 5), ...many(15, 19)], asked: many(1, 5), missed: many(15, 19), unasked, changed: [...many(1, 5).map((id) => ({ id, what: ["text"] })), ...unasked] });
  const result = askOf(board, { redone });
  assert.deepEqual(lines(result).slice(1, 4), [
    "Changed as you asked in C1: shots 1, 2, 3, and 2 more.",
    "Changed without being asked: shot 8 (footage), shot 9 (footage and in-point), shot 10 (footage, in-point and 1 more), and 1 more.",
    "Named but not changed: shots 15, 16, 17, and 2 more.",
  ]);
  assert.deepEqual(listedShots(result), [1, 2, 3, 4, 5, 8, 9, 10]);
  assert.equal(result.listed, ASK_SHOTS);
  assert.ok(result.text.includes('\n1 more changed shot and 5 more named shots and 6 unchanged: say "all shots".\n'), result.text);
  assert.equal(lines(askOf(board, { redone: redo({ changed: [{ id: "S4", what }] }) }))[1], "Changed since C1: shot 4 (footage, in-point and 6 more).");
});

test("the change lines fit CHANGED_TOKENS: F4's example, and the widest lists narrowed to fit", () => {
  const every = ["footage", "in-point", "length", "crop", "follow", "pacing", "text", "sound"];
  const changeLines = (result) => lines(result).filter((line) => /^(Changed|Named but|Nothing changed|Also changed)/.test(line));
  const changeTokens = (result) => estimateTextTokens(changeLines(result).join("\n"));
  const typical = askOf(cards(9), { redone: redo({ named: ["S3", "S5", "S4"], asked: ["S3", "S5"], missed: ["S4"],
    unasked: [{ id: "S7", what: ["crop"] }, { id: "S9", what: ["added"] }], removed: [{ id: "S10", start: 8, end: 9 }] }) });
  // Every list full, on boards of 9 to 99 shots and stops up to C999: a third of the shots asked
  // and changed, a third changed without being asked (every what-word), a third named but not
  // changed, and removed shots (named or not) named by their times.
  let widest = { tokens: 0, text: "" };
  for (const count of [9, 30, 99]) for (const stop of ["C9", "C99", "C999"]) for (const gone of [0, 3, 5]) for (const time of [8.25, 88.25, 888.25]) {
    const ids = Array.from({ length: count }, (_, index) => `S${index + 1}`);
    const third = Math.floor(count / 3);
    const removed = (tag) => Array.from({ length: gone }, (_, index) => ({ id: `${tag}${index}`, start: time + index * 1.33, end: time + index * 1.33 + 1.25 }));
    const [named, unnamed] = [removed("A"), removed("U")];
    for (const removedFirst of [false, true]) {
      const asked = ids.slice(count - third);
      const redone = redo({ stop, named: [...asked, ...ids.slice(0, third), ...named.map((entry) => entry.id)], asked: removedFirst ? named.map((entry) => entry.id) : [...asked, ...named.map((entry) => entry.id)],
        unasked: ids.slice(third, 2 * third).map((id) => ({ id, what: every })), missed: ids.slice(0, third), removed: [...named, ...unnamed], order: true, music: true });
      const result = boardAsk({ id: `${stop}1`, board: cards(count), frame: PORTRAIT, seconds: count, redone });
      const tokens = changeTokens(result);
      if (tokens > widest.tokens) widest = { tokens, text: changeLines(result).join("\n") };
    }
  }
  console.log(`# change lines: F4's example ${changeTokens(typical)} tokens, the widest ${widest.tokens} (limit ${CHANGED_TOKENS}):\n${widest.text}`);
  assert.ok(changeTokens(typical) <= CHANGED_TOKENS);
  assert.ok(widest.tokens <= CHANGED_TOKENS, widest.text);

  // Five removed shots named by their times on each list: one shot a list, the rest counted.
  const times = (tag) => Array.from({ length: 5 }, (_, index) => ({ id: `${tag}${index}`, start: 88.25 + index, end: 89.25 + index }));
  const gone = askOf(cards(30), { redone: redo({ stop: "C99", named: [...times("A").map((entry) => entry.id), "S20", "S21", "S22", "S23"], asked: times("A").map((entry) => entry.id),
    missed: ["S20", "S21", "S22", "S23"], removed: [...times("A"), ...times("U")] }) });
  assert.deepEqual(changeLines(gone), ["Changed as you asked in C99: the shot at 88.25–89.25 s (removed), and 4 more.", "Changed without being asked: the shot at 88.25–89.25 s (removed), and 4 more.",
    "Named but not changed: shot 20 and 3 more."]);
});

test("a lapsed approval after approve with notes: the lapse header stays, the change lines follow it", () => {
  const board = cards(4);
  const result = askOf(board, { changed: { why: ["shot 2 text changed", "shot 3 crop moved 8%"], ids: ["S2", "S3"], approved: "C1" },
    redone: redo({ named: ["S2"], asked: ["S2"], unasked: [{ id: "S3", what: ["crop"] }], changed: [{ id: "S2", what: ["text"] }, { id: "S3", what: ["crop"] }] }) });
  assert.deepEqual(lines(result).slice(0, 3), ["The storyboard changed since you approved it (C1); asking again (C2): shot 2 text changed; shot 3 crop moved 8%.",
    "Changed as you asked in C1: shot 2.", "Changed without being asked: shot 3 (crop)."]);
  assert.deepEqual(listedShots(result), [2, 3]);
  // A shot the lapse names that the redo lists do not (a cut moved) is listed after them.
  const cut = askOf(board, { changed: { why: ["shot 4 cut moved 9 frames"], ids: ["S2", "S4"], approved: "C1" },
    redone: redo({ named: ["S2"], asked: ["S2"], changed: [{ id: "S2", what: ["text"] }] }) });
  assert.deepEqual(listedShots(cut), [2, 4]);
});

// ---- the stops, as plain data (F1, F4, F5) -----------------------------------------------------

// A 24 s video with footage (a shorter one skips the storyboard stop), four 6 s title cards.
const FOOTAGE = { seconds: 24, layers: 1, footage: true, width: 1080, height: 1920 };
const T0 = Date.parse("2026-10-25T08:00:00.000Z");
const factsOf = (shots) => boardFacts({ scenes: [{ id: "s", width: 1080, height: 1920, duration: 24, layers: [] }], board: { rev: 1, music: "none", calls: [], open: [], shots } });
const FOUR = () => [1, 2, 3, 4].map((n) => titleShot(`S${n}`, (n - 1) * 6, 6, { text: title(`Line ${n}`) }));
function ready(rev = 4) {
  const state = emptyAgentState();
  state.brief = { rev: 0, savedAt: null, confirmedRev: null, noPlayback: { reason: "just start", rev: 0 }, fields: {}, log: [] };
  state.checked = { rev, errors: 0, warnings: 0, at: new Date(T0).toISOString(), client: "claude-code" };
  return state;
}
const refusal = (run) => {
  try { run(); } catch (error) { if (error instanceof StopError) return [error.code, error.message]; throw error; }
  assert.fail("the call was not refused");
};
const ask = (state, fields = {}) => checkpointStep(state, { kind: "board", video: FOOTAGE, rev: 4, now: T0, board: factsOf(FOUR()), ...fields });

test("fresh is ran or skipped, on the storyboard stop only; the first ask without it says not reported, a later ask nothing", () => {
  const state = ready();
  assert.deepEqual(refusal(() => ask(state, { fresh: "maybe" })), ["bad_input", 'fresh is "ran" (a second agent checked the board) or "skipped" (your app cannot start one).']);
  assert.deepEqual(refusal(() => checkpointStep(state, { kind: "rough", video: FOOTAGE, rev: 4, now: T0, fresh: "ran" })), ["bad_input", "fresh goes with the storyboard stop."]);
  assert.equal(state.stops.length, 0, "a refused ask saves no round");

  const first = ask(state);
  assert.ok(first.data.ask.includes("\nFresh-eyes check: not reported.\n"), first.data.ask);
  assert.deepEqual(state.stops[0].shown, IDS, "the round keeps the shots in the order it showed them");
  assert.equal(state.boardAnswered, undefined, "kino keeps the board when they answer with notes");
  assert.equal(state.stops[0].fresh, undefined);
  // Asked again while it waits: the agent reports the check now; a plain ask again keeps it.
  const reported = ask(state, { fresh: "skipped", now: T0 + 1000 });
  assert.equal(reported.data.id, "C1");
  assert.ok(reported.data.ask.includes("\nFresh-eyes check: skipped (no second agent in this app).\n"), reported.data.ask);
  assert.equal(state.stops[0].fresh, "skipped");
  assert.equal(ask(state, { now: T0 + 2000 }).data.ask, reported.data.ask);
  const summary = stopsSummary(state);
  assert.ok(!("shown" in summary.rounds[0]) && !("redone" in summary.rounds[0]), "the dashboard summary leaves shown and redone out");
  assert.equal(summary.rounds[0].fresh, "skipped");

  // A redo, then the next ask (no fresh): no fresh line.
  answerStep(state, { input: { id: "C1", rev: 4, words: "make the second line bigger", read_as: "redo" }, video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(FOUR()) });
  assert.deepEqual(state.boardAnswered, { stop: "C1", rev: 4, copy: factsOf(FOUR()).board, musicFile: null });
  const later = ask(state, { rev: 5, now: T0 + 60_000 });
  assert.equal(later.data.id, "C2");
  assert.ok(!later.data.ask.includes("Fresh-eyes"), later.data.ask);
  assert.ok(later.data.ask.includes("\nNothing changed since C1.\n"), later.data.ask);
  assert.ok(ask(state, { rev: 5, now: T0 + 61_000, fresh: "ran" }).data.ask.includes("\nFresh-eyes check: ran.\n"));
});

test("a chat redo naming shots: next names them, and the next ask says what changed as asked, without being asked, and not at all", () => {
  const state = ready();
  ask(state);
  const answered = answerStep(state, { input: { id: "C1", rev: 4, words: "redo shots 2 and 4: bigger", read_as: "redo" }, video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(FOUR()) });
  assert.equal(answered.data.next, 'say "Read as: redo (<what>)" in one line; fix only what they named (shots 2 and 4), then ask again: notes {action:"checkpoint", id:"board"}.');
  assert.deepEqual(state.stops[0].answer.named, ["S2", "S4"]);
  const [one, two, three, four] = FOUR();
  const changed = [one, { ...two, text: title("Line 2", 30) }, { ...three, sound: "a whoosh" }, four];
  const again = ask(state, { rev: 5, now: T0 + 60_000, board: factsOf(changed) });
  assert.equal(again.data.id, "C2");
  assert.deepEqual(again.data.ask.split("\n").slice(1, 4), ["Changed as you asked in C1: shot 2.", "Changed without being asked: shot 3 (sound).", "Named but not changed: shot 4."]);
  assert.deepEqual(state.stops[1].redone, { stop: "C1", named: ["S2", "S4"], asked: ["S2"], unasked: [{ id: "S3", what: ["sound"] }], missed: ["S4"], removed: [],
    changed: [{ id: "S2", what: ["text"] }, { id: "S3", what: ["sound"] }] });
  assert.equal(again.data.board.listed, 3);

  // Approve with notes naming shot 1: the round keeps the named shot (the lapse ask that
  // follows is on the server, below).
  answerStep(state, { input: { id: "C2", rev: 5, words: "approve, but shot 1 a bit lower", read_as: "approve with notes" }, video: FOOTAGE, rev: 5, now: T0 + 90_000, board: factsOf(changed) });
  assert.deepEqual(state.stops[1].answer.named, ["S1"]);

  // Ids "1" to "4": the "2" of "2 seconds" is not shot 2 (review round 2 of B4b).
  const numbered = ready();
  const NUMBERED = () => [1, 2, 3, 4].map((n) => titleShot(String(n), (n - 1) * 6, 6, { text: title(`Line ${n}`) }));
  ask(numbered, { board: factsOf(NUMBERED()) });
  const longer = answerStep(numbered, { input: { id: "C1", rev: 4, words: "redo: shot 4 should be 2 seconds longer", read_as: "redo" }, video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(NUMBERED()) });
  assert.deepEqual(numbered.stops[0].answer.named, ["4"]);
  assert.ok(longer.data.next.includes("fix only what they named (shot 4)"), longer.data.next);

  // A chat answer naming no shot keeps every text as before B4b.
  const plain = ready();
  ask(plain);
  const before = answerStep(plain, { input: { id: "C1", rev: 4, words: "warmer colors", read_as: "approve with notes" }, video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(FOUR()) });
  assert.equal(before.data.next, 'say "Read as: approve with notes (<what>)" in one line, make those changes, then go on.');
  assert.equal("named" in plain.stops[0].answer, false);
});

test("after a redo the next ask says a new shot order and new music, and never 'Nothing changed' then", () => {
  const state = ready();
  ask(state);
  answerStep(state, { input: { id: "C1", rev: 4, words: "redo: the last line first", read_as: "redo" }, video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(FOUR()) });
  const [one, two, three, four] = FOUR();
  // The cards moved, each cue moved with it (a cue alone is not a change).
  const swapped = factsOf([four, one, two, three].map((shot, index) => ({ ...shot, cue: index * 6 })));
  const again = ask(state, { rev: 5, now: T0 + 60_000, board: { ...swapped, musicFile: "/api/media/song.mp3" } });
  assert.equal(again.data.ask.split("\n")[1], "Changed since C1: the shot order and the music.", again.data.ask);
  assert.deepEqual([state.stops[1].redone.order, state.stops[1].redone.music], [true, true]);

  // Named shots that moved (and only they): changed as asked.
  const named = ready();
  ask(named);
  answerStep(named, { input: { id: "C1", rev: 4, words: "redo: shot 4 first", read_as: "redo" }, video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(FOUR()) });
  const moved = ask(named, { rev: 5, now: T0 + 60_000, board: swapped });
  assert.equal(moved.data.ask.split("\n")[1], "Changed as you asked in C1: shot 1.", moved.data.ask);
  assert.deepEqual(named.stops[1].redone.changed, [{ id: "S4", what: ["moved"] }]);
});

test("a round that lapses after a redo: the next ask still says what changed since the board they answered", () => {
  const state = ready();
  ask(state);
  answerStep(state, { input: { id: "C1", rev: 4, words: "redo shot 2: bigger", read_as: "redo" }, video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(FOUR()) });
  const [one, two, three, four] = FOUR();
  const changed = factsOf([one, { ...two, text: title("Line 2", 30) }, { ...three, sound: "a whoosh" }, four]);
  const second = ask(state, { rev: 5, now: T0 + 60_000, board: changed });
  const said = ["Changed as you asked in C1: shot 2.", "Changed without being asked: shot 3 (sound)."];
  assert.deepEqual(second.data.ask.split("\n").slice(1, 3), said);
  // The agent saves again while C2 waits: C2 lapses, and C3 says the same, against C1's board.
  const third = ask(state, { rev: 6, now: T0 + 90_000, board: changed });
  assert.deepEqual([third.data.id, state.stops[1].status], ["C3", "lapsed"]);
  assert.deepEqual(third.data.ask.split("\n").slice(1, 3), said, third.data.ask);
  assert.deepEqual(state.stops[2].redone, state.stops[1].redone);
});

test("a storyboard round asked before kino kept its shots (no round.shown): the board now stands in for it", () => {
  for (const via of ["chat", "dashboard"]) {
    const state = ready();
    ask(state);
    delete state.stops[0].shown;
    const step = { video: FOOTAGE, rev: 4, now: T0 + 30_000, board: factsOf(FOUR()) };
    if (via === "chat") {
      const answered = answerStep(state, { ...step, input: { id: "C1", rev: 4, words: "redo shot 2: bigger", read_as: "redo" } });
      assert.ok(answered.data.next.includes("(shot 2)"), answered.data.next);
    } else {
      dashboardAnswerStep(state, { ...step, input: { id: "C1", rev: 4, read_as: "redo", shots: [{ id: "S2", words: "bigger" }] } });
      assert.ok(state.inbox.at(-1).text.includes('on shot 2 (S2): "bigger". Fix only what they named (shot 2)'), state.inbox.at(-1).text);
    }
    assert.deepEqual(state.stops[0].answer.named, ["S2"], via);
  }
});

test("notes on single shots from the dashboard: every refusal in order, then the agent's inbox text", () => {
  const answerOn = (state, input) => dashboardAnswerStep(state, { input: { id: "C1", rev: 4, ...input }, video: FOOTAGE, rev: 4, now: T0 + 42_000, board: factsOf(FOUR()) });
  const asking = () => {
    const state = ready();
    ask(state);
    return state;
  };
  const state = asking();
  for (const [input, message] of [
    [{ read_as: "redo", words: "x", shots: "tighter" }, "shots is a list of {id, words}: a note on one shot of the board."],
    [{ read_as: "redo", words: "x", shots: [{ id: "S2" }] }, "shots is a list of {id, words}: a note on one shot of the board."],
    [{ read_as: "redo", words: "x", shots: [null] }, "shots is a list of {id, words}: a note on one shot of the board."],
    [{ read_as: "approve", shots: [{ id: "S2", words: "tighter" }] }, "approve takes no note: send approve with notes."],
    [{ read_as: "redo", shots: [{ id: "S9", words: "tighter" }] }, "shot S9 is not on the board C1 showed."],
    [{ read_as: "redo", shots: [{ id: "S3", words: "tighter" }, { id: "s3", words: "darker" }] }, "shot S3 has two notes: send one."],
    [{ read_as: "redo", shots: [{ id: "S3", words: "   " }] }, "A note on shot 3 is 1–500 characters."],
    [{ read_as: "redo", shots: [{ id: "S3", words: "x".repeat(501) }] }, "A note on shot 3 is 1–500 characters."],
    [{ read_as: "redo", words: "y".repeat(1600), shots: [{ id: "S3", words: "x".repeat(401) }] }, "The notes together are at most 2000 characters."],
    [{ read_as: "redo", words: "", shots: [] }, "A redo needs a note: say what to change (1–2000 characters)."],
    [{ read_as: "approve with notes" }, "approve with notes needs a note (1–2000 characters)."],
  ]) assert.deepEqual(refusal(() => answerOn(state, input)), ["bad_input", message], JSON.stringify(input).slice(0, 80));
  assert.equal(state.stops[0].status, "waiting", "a refusal answers nothing");
  answerOn(state, { read_as: "redo", words: "y".repeat(1600), shots: [{ id: "S3", words: "x".repeat(400) }] });

  // A rough cut takes no notes on shots.
  const rough = ready();
  rough.stops.push({ id: "C1", kind: "rough", rev: 4, askedAt: new Date(T0).toISOString(), status: "waiting", offer: [], ask: "…", answer: null });
  assert.deepEqual(refusal(() => answerOn(rough, { read_as: "redo", words: "x", shots: [{ id: "S1", words: "y" }] })), ["bad_input", "Notes on shots go with a storyboard stop."]);

  // A redo with a note and a shot note (F5's example).
  const redone = asking();
  answerOn(redone, { read_as: "redo", words: "warmer", shots: [{ id: "s3", words: " tighter " }] });
  assert.equal(redone.inbox.at(-1).text, 'C1 board: the person asked for a redo in kino: "warmer"; on shot 3 (S3): "tighter". Fix only what they named (shot 3), then ask again: notes {action:"checkpoint", id:"board"}.');
  const { words, shots, named } = redone.stops[0].answer;
  assert.deepEqual({ words, shots, named }, { words: "warmer", shots: [{ id: "S3", n: 3, words: "tighter" }], named: ["S3"] });
  // Notes on two shots and words naming another: in board order.
  const both = asking();
  answerOn(both, { read_as: "redo", words: "the first shot is slow", shots: [{ id: "S4", words: "end sooner" }, { id: "S2", words: "closer" }] });
  assert.equal(both.inbox.at(-1).text, 'C1 board: the person asked for a redo in kino: "the first shot is slow"; on shot 2 (S2): "closer"; on shot 4 (S4): "end sooner". Fix only what they named (shots 1, 2 and 4), then ask again: notes {action:"checkpoint", id:"board"}.');
  assert.deepEqual(both.stops[0].answer.named, ["S1", "S2", "S4"]);

  // Approve with notes, only a shot note: the board is frozen, the words are null.
  const noted = asking();
  answerOn(noted, { read_as: "approve with notes", shots: [{ id: "S3", words: "tighter" }] });
  assert.equal(noted.inbox.at(-1).text, 'C1 board approved by the person in kino, with notes: on shot 3 (S3): "tighter". Make those changes (shot 3), then go on.');
  assert.equal(noted.stops[0].answer.words, null);
  assert.deepEqual(noted.boards.map((entry) => [entry.stop, entry.read_as]), [["C1", "approve with notes"]]);

  // No shot named: every text as before B4b, and no new fields on the answer.
  const plain = asking();
  answerOn(plain, { read_as: "redo", words: "start on the dragon" });
  assert.equal(plain.inbox.at(-1).text, 'C1 board: the person asked for a redo in kino: "start on the dragon". Fix only what they named, then ask again: notes {action:"checkpoint", id:"board"}.');
  assert.equal("shots" in plain.stops[0].answer || "named" in plain.stops[0].answer, false);
  const approved = asking();
  answerOn(approved, { read_as: "approve with notes", words: "warmer", shots: [] });
  assert.equal(approved.inbox.at(-1).text, 'C1 board approved by the person in kino, with notes: "warmer". Make those changes, then go on.');
});

// ---- on a real server ------------------------------------------------------------------------

const CLIP = fileURLToPath(new URL("../tests/fixtures/footage/sintel-village-dragon.mp4", import.meta.url));
const skip = skipWithoutMediaTools;
let server;
let clip;
let key;
before(async () => {
  if (skip) return;
  server = await startTestServer({ env: { MOTION_FONT_DOWNLOADS: "off" } });
  const response = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": path.basename(CLIP) }, body: await readFile(CLIP) });
  assert.equal(response.status, 201, await response.clone().text());
  const media = await response.json();
  clip = { ...media, src: media.src ?? media.media?.src };
  key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
});
after(async () => {
  await server?.stop();
});

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const savedState = async (project) => JSON.parse(await readFile(path.join(server.dataDirectory, "agent", "projects", `${project}.json`), "utf8"));
const checkpoint = async (project, body = {}) => ({ ...(await agent("notes", { project, action: "checkpoint", id: "board", ...body })), at: performance.now() });
const answer = (project, body) => agent("notes", { project, action: "answer", ...body });
async function stops(project, body) {
  const response = await server.api("/api/dashboard/stops", { method: "POST", headers: { "x-kino-review": key }, body: { project, ...body } });
  return { status: response.status, body: await response.json() };
}
// kino refuses an answer under 5 s after the ask (too_fast): wait out what is left of 5.2 s.
async function gap(askedAt) {
  for (let left = askedAt + 5200 - performance.now(); left > 0; left = askedAt + 5200 - performance.now())
    await new Promise((resolve) => setTimeout(resolve, left));
}

// The shots of agent-board.test.mjs: three footage shots of the clip, a 9:16 crop with the
// dragon marked, then a title card.
const footage = (cue, dur, inPoint, x, extra = {}) => ({ cue, dur, pacing: "free", media: clip.src, in: inPoint, crop: [x, 12, 24, 76],
  subject: { what: "the dragon", box: [x + 4, 30, 14, 30] }, follow: "steady", text: "none", sound: "none", why: "the dragon over the village", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const motion = (cue, dur, extra = {}) => ({ cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: "The dragon is back", family: "Inter" }, sound: "none", why: "the line on its own", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const STOP_SHOTS = () => [footage(0, 1.25, 0, 20), footage(1.25, 2.083, 1.25, 38), footage(3.333, 1.084, 3.333, 55), motion(4.417, 4.383)];
const CALLS = { calls: ["End on the title", "The village sound, no music"] };
const withShot = (shots, index, change) => shots.map((shot, at) => (at === index ? { ...shot, ...change } : shot));
const editBoard = async (project, shots) => {
  const edited = await agent("edit", { project, ops: [{ op: "board", music: "none", shots, ...CALLS }] });
  assert.equal(edited.isError, undefined, edited.text);
  return edited;
};
async function stopProject(id) {
  assert.equal((await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 8.8, background: "#101114" })).isError, undefined);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src } }] })).isError, undefined);
  // The person named the shape, so these stops carry no shape guess line.
  const shape = await agent("notes", { project: id, action: "brief", fields: { ask: "a vertical for my phone", plays_on: { text: "vertical, 9:16", by: "you", quote: "vertical for my phone" } } });
  assert.equal(shape.isError, undefined, shape.text);
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
  await editBoard(id, STOP_SHOTS());
}

test("on the server: fresh skipped, a chat redo of shot 2, then what changed as asked and without being asked", { skip, timeout: 120_000 }, async () => {
  const id = "redo-chat";
  await stopProject(id);
  const maybe = await checkpoint(id, { fresh: "maybe" });
  assert.deepEqual([maybe.data.error, maybe.data.reason], ["bad_input", 'fresh is "ran" (a second agent checked the board) or "skipped" (your app cannot start one).']);
  const rough = await agent("notes", { project: id, action: "checkpoint", id: "rough", fresh: "ran" });
  assert.deepEqual([rough.data.error, rough.data.reason], ["bad_input", "fresh goes with the storyboard stop."]);

  const asked = await checkpoint(id, { fresh: "skipped" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.ok(asked.data.ask.includes("\nMy calls (say no to any): End on the title · The village sound, no music\nFresh-eyes check: skipped (no second agent in this app).\n"), asked.data.ask);
  let state = await savedState(id);
  assert.equal(state.stops[0].fresh, "skipped");
  assert.deepEqual(state.stops[0].shown, IDS);

  await gap(asked.at);
  const redo = await answer(id, { id: "C1", rev: asked.data.rev, words: "redo: shot 2 tighter", read_as: "redo" });
  assert.equal(redo.data.next, 'say "Read as: redo (<what>)" in one line; fix only what they named (shot 2), then ask again: notes {action:"checkpoint", id:"board"}.', redo.text);
  state = await savedState(id);
  assert.deepEqual(state.stops[0].answer.named, ["S2"]);
  assert.equal(state.boardAnswered.stop, "C1", "kino keeps the board they answered");

  // The agent tightens shot 2's crop, and also changes shot 4's title nobody asked about.
  const changed = withShot(withShot(STOP_SHOTS(), 1, { crop: [40, 18, 18, 57], subject: { what: "the dragon", box: [42, 30, 12, 30] } }), 3, { text: { text: "The dragon returns", family: "Inter" } });
  await editBoard(id, changed);
  const again = await checkpoint(id);
  assert.equal(again.data.id, "C2", again.text);
  assert.ok(again.data.ask.startsWith("The storyboard is ready (C2): 4 shots, 8.8 s, 1080×1920, no music.\nChanged as you asked in C1: shot 2.\nChanged without being asked: shot 4 (text).\nMy calls"), again.data.ask);
  assert.ok(!again.data.ask.includes("Fresh-eyes"), "a later ask without fresh has no fresh line");
  assert.deepEqual(again.data.ask.split("\n").filter((line) => line.startsWith("Shot ")).map((line) => line.split(",")[0]), ["Shot 2", "Shot 4"]);
  assert.ok(again.data.ask.includes('\n2 unchanged: say "all shots".\n'), again.data.ask);
  state = await savedState(id);
  assert.deepEqual(state.stops[1].redone, { stop: "C1", named: ["S2"], asked: ["S2"], unasked: [{ id: "S4", what: ["text"] }], missed: [], removed: [],
    changed: [{ id: "S2", what: ["crop"] }, { id: "S4", what: ["text"] }] });
  const summary = (await (await server.api(`/api/dashboard/snapshot?project=${id}`)).json()).agent.stops;
  assert.ok(summary.rounds.every((round) => !("shown" in round) && !("redone" in round)), "the dashboard's summary leaves them out");

  // A redo naming shot 3, and nothing changed: kino says so and lists the board as on a first ask.
  await gap(again.at);
  await answer(id, { id: "C2", rev: again.data.rev, words: "shot 3 should hold longer", read_as: "redo" });
  const same = await checkpoint(id);
  assert.equal(same.data.id, "C3", same.text);
  assert.ok(same.data.ask.includes("\nNamed but not changed: shot 3.\n"), same.data.ask);
  assert.equal(same.data.board.listed, 4);
});

test("on the server: a dashboard redo with a note on one shot, approve with notes on shots only, and no shot named as before", { skip, timeout: 120_000 }, async () => {
  const id = "redo-dashboard";
  await stopProject(id);
  const asked = await checkpoint(id);
  assert.ok(asked.data.ask.includes("\nFresh-eyes check: not reported.\n"), asked.data.ask);
  const rev = asked.data.rev;
  for (const [body, error] of [
    [{ shots: "tighter", words: "x" }, "shots is a list of {id, words}: a note on one shot of the board."],
    [{ shots: [{ id: "S9", words: "tighter" }] }, "shot S9 is not on the board C1 showed."],
    [{ shots: [{ id: "S3", words: "a" }, { id: "S3", words: "b" }] }, "shot S3 has two notes: send one."],
    [{ shots: [{ id: "S3", words: "" }] }, "A note on shot 3 is 1–500 characters."],
    [{ words: "w".repeat(1999), shots: [{ id: "S3", words: "ab" }] }, "The notes together are at most 2000 characters."],
  ]) {
    const refused = await stops(id, { action: "answer", id: "C1", rev, read_as: "redo", ...body });
    assert.deepEqual([refused.status, refused.body.error], [400, error]);
  }
  const approve = await stops(id, { action: "answer", id: "C1", rev, read_as: "approve", shots: [{ id: "S3", words: "tighter" }] });
  assert.deepEqual([approve.status, approve.body.error], [400, "approve takes no note: send approve with notes."]);

  const redo = await stops(id, { action: "answer", id: "C1", rev, read_as: "redo", words: "warmer", shots: [{ id: "S3", words: "tighter" }] });
  assert.equal(redo.status, 200, JSON.stringify(redo.body));
  const round = (await savedState(id)).stops[0];
  assert.deepEqual([round.answer.words, round.answer.shots, round.answer.named], ["warmer", [{ id: "S3", n: 3, words: "tighter" }], ["S3"]]);
  const heard = await agent("status", { project: id });
  assert.ok(heard.text.includes('C1 board: the person asked for a redo in kino: "warmer"; on shot 3 (S3): "tighter". Fix only what they named (shot 3), then ask again: notes {action:"checkpoint", id:"board"}.'), heard.text);

  // The agent changes shot 3's crop; asked again, the person approves with a note on shot 1 only.
  await editBoard(id, withShot(STOP_SHOTS(), 2, { crop: [50, 12, 24, 76], subject: { what: "the dragon", box: [54, 30, 14, 30] } }));
  const again = await checkpoint(id);
  assert.ok(again.data.ask.includes("\nChanged as you asked in C1: shot 3.\n"), again.data.ask);
  const noted = await stops(id, { action: "answer", id: "C2", rev: again.data.rev, read_as: "approve with notes", shots: [{ id: "S1", words: "start a beat later" }] });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  const state = await savedState(id);
  assert.deepEqual(state.boards.map((entry) => [entry.stop, entry.read_as]), [["C2", "approve with notes"]], "the board is frozen");
  assert.equal(state.stops[1].answer.words, null);
  const told = await agent("status", { project: id });
  assert.ok(told.text.includes('C2 board approved by the person in kino, with notes: on shot 1 (S1): "start a beat later". Make those changes (shot 1), then go on.'), told.text);
  // Shot 1 starts 0.5 s later in the clip: past the tolerances, so the approval lapses, and the
  // ask again keeps the lapse header and says the change was the one asked for.
  const later = withShot(withShot(STOP_SHOTS(), 2, { crop: [50, 12, 24, 76], subject: { what: "the dragon", box: [54, 30, 14, 30] } }), 0, { in: 0.5 });
  const lapse = await editBoard(id, later);
  assert.equal(lapse.data.board.lapsed[0].startsWith("shot 1 "), true, JSON.stringify(lapse.data.board));
  const third = await checkpoint(id);
  assert.equal(third.data.id, "C3", third.text);
  assert.deepEqual(third.data.ask.split("\n").slice(0, 2), [`The storyboard changed since you approved it (C2); asking again (C3): ${lapse.data.board.lapsed.join("; ")}.`, "Changed as you asked in C2: shot 1."]);

  // Another video, no shot named: the texts B4a pins (agent-board.test.mjs), byte for byte.
  const plain = "redo-plain";
  await stopProject(plain);
  const first = await checkpoint(plain);
  assert.equal((await stops(plain, { action: "answer", id: "C1", rev: first.data.rev, read_as: "redo", words: "start on the dragon" })).status, 200);
  const before = await agent("status", { project: plain });
  assert.ok(before.text.includes('C1 board: the person asked for a redo in kino: "start on the dragon". Fix only what they named, then ask again: notes {action:"checkpoint", id:"board"}.'), before.text);
  const second = await checkpoint(plain);
  assert.ok(second.data.ask.startsWith("The storyboard is ready (C2): 4 shots, 8.8 s, 1080×1920, no music.\nNothing changed since C1.\nMy calls"), second.data.ask);
  assert.equal(second.data.next, `send it as written, end your turn, then notes {action:"answer", id:"C2", rev:${second.data.rev}, words, read_as}.`);
  await gap(second.at);
  const chat = await answer(plain, { id: "C2", rev: second.data.rev, words: "warmer, then go", read_as: "approve with notes" });
  assert.equal(chat.data.next, 'say "Read as: approve with notes (<what>)" in one line, make those changes, then go on.', chat.text);
});

test("on the server: a 30-shot board, all shots while it waits, fits the token budgets", { skip, timeout: 120_000 }, async () => {
  const id = "redo-thirty";
  assert.equal((await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 30, background: "#101114" })).isError, undefined);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src } }] })).isError, undefined);
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
  const shots = Array.from({ length: 30 }, (_, index) => (index % 3 === 2 ? motion(index, 1, { text: { text: `Line ${index + 1} of the dragon story`, family: "Inter" } })
    : footage(index, 1, (index % 4) * 0.8, 20 + (index % 5) * 8)));
  await editBoard(id, shots);
  const asked = await checkpoint(id, { fresh: "ran" });
  assert.equal(asked.data.board.listed, 8, asked.text);
  const all = await checkpoint(id, { all: true });
  assert.equal(all.data.ask.split("\n").filter((line) => line.startsWith("Shot ")).length, 30);
  assert.equal(all.data.board.listed, 30);
  assert.ok(all.data.ask.includes("\nFresh-eyes check: ran.\n"), "the check reported before stays on the round");
  const own = all.text.split("\n").filter((line) => line.startsWith("My calls") || line.startsWith("Brief: ")).join("\n");
  const kino = estimateTextTokens(all.text) - estimateTextTokens(own);
  const whole = estimateTextTokens(all.text);
  console.log(`# 30-shot board, all shots: ${whole} tokens, ${kino} besides the agent's calls (limit ${ASK_TOKENS + SHOT_TOKENS * 30 + FRESH_TOKENS + 10}); 8 shots ${estimateTextTokens(asked.text)}`);
  assert.ok(kino <= ASK_TOKENS + SHOT_TOKENS * 30 + FRESH_TOKENS + 10, `${kino} tokens`);
  assert.ok(whole <= 1400, `${whole} tokens`);
});
