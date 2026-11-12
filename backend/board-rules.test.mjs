// The approved storyboard's rules (backend/agent/board.mjs): what lapses an approval and what is
// only logged, measured field by field against the frozen copy; which round's approval stands;
// and that the copy never changes after it is written.
import assert from "node:assert/strict";
import test from "node:test";
import { activeApproval, BOARD_FPS, boardChanges, boardFacts, boardSummary, CROP_SHARE, CUT_FRAMES, freezeBoard, lapsedChanges, leavesItToYou, reframeApproved, settleBoard, YOUR_CALL } from "./agent/board.mjs";
import { boardAsk } from "./agent/board-text.mjs";
import { keepShotIds, reframeBoard } from "../engine/board.js";
import { reopenStep, stopRules } from "./agent/stops.mjs";
import { answerStep, checkpointStep, dashboardAnswerStep, settleWaiting, stopPlan, statusLines } from "./stops.test.support.mjs";
import { emptyAgentState } from "./agent/state.mjs";
import { boardBuilt } from "./agent/board-build.mjs";

const FRAME = { width: 1080, height: 1920 };
const clip = "/api/media/clip.mp4";
const footage = (id, cue, dur, inPoint, crop, extra = {}) => ({ id, cue, dur, pacing: "free", media: clip, in: inPoint, crop,
  subject: { what: "the dragon", boxes: [[crop[0] + 4, 30, 12, 30]] }, follow: "steady", text: "none", sound: "none", why: "the dragon flies in", alts: [], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const card = (id, cue, dur) => ({ id, cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: "Orbit", family: "Inter", weight: 700, size: 96, y: 20, fill: "#ffffff" }, sound: "none", why: "the title alone", alts: [], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" } });
// The approved board: 1080×1920, 6 s, no music, two shots of footage and a title card.
const COPY = Object.freeze({ rev: 2, music: "none", calls: ["the dragon first"], open: [],
  shots: [footage("S1", 0, 1.4, 0, [10, 12, 24, 76]), footage("S2", 1.4, 2, 2, [49, 12, 24, 76]), card("S3", 3.4, 2.6)] });
const edited = (change) => { const board = structuredClone(COPY); change(board); return board; };
const compare = (change, beats = []) => boardChanges(COPY, edited(change), { frame: FRAME, beats });

test("the tolerances: 30 frames a second, 6 frames, 5% of the frame width", () => {
  assert.deepEqual([BOARD_FPS, CUT_FRAMES, CROP_SHARE], [30, 6, 5]);
  assert.ok(YOUR_CALL.test("Your call on both") && YOUR_CALL.test("it's your call.") && !YOUR_CALL.test("you call it") && !YOUR_CALL.test("yourcall"));
});

// Review round 1 of B4a: a reply that says it is not the agent's call leaves nothing to it.
test("'your call' leaves the open items to the agent; 'not your call' does not", () => {
  for (const words of ["Your call on both", "it's your call.", "No idea, your call!", "Not sure. Your call", "that's really your call"]) assert.equal(leavesItToYou(words), true, words);
  for (const words of ["No, that's not your call: end on the dragon.", "It isn't your call.", "Not your call.", "it is not really your call", "never your call", "That isn’t your call", "you call it"])
    assert.equal(leavesItToYou(words), false, words);
});

test("the same board lapses nothing and logs nothing", () => {
  assert.deepEqual(boardChanges(COPY, structuredClone(COPY), { frame: FRAME }), { lapse: [], revisions: [], changed: [] });
  assert.deepEqual(compare((board) => { board.rev = 7; }), { lapse: [], revisions: [], changed: [] }, "a new rev of the same shots is no change");
});

test("each field that lapses an approval is named, with the shot's place", () => {
  assert.deepEqual(compare((board) => { board.music = "song-id"; }).lapse, ["music changed"]);
  assert.deepEqual(compare((board) => { board.shots[1].media = "/api/media/other.mp4"; }), { lapse: ["shot 2 media changed"], revisions: [], changed: ["S2"] });
  assert.deepEqual(compare((board) => { board.shots[2].text.text = "Orbit now"; }).lapse, ["shot 3 text changed"]);
  assert.deepEqual(compare((board) => { board.shots[2].text.fill = "#ffd23f"; }).lapse, ["shot 3 text changed"], "any part of the text");
  assert.deepEqual(compare((board) => { board.shots[0].sound = { media: "/api/media/cheer.wav", what: "crowd cheer" }; }).lapse, ["shot 1 sound changed"]);
  assert.deepEqual(compare((board) => { board.shots[0].pacing = "beat_cut"; }).lapse, ["shot 1 pacing changed"]);
  assert.deepEqual(compare((board) => { board.shots[1].follow = "track"; }).lapse, ["shot 2 follow changed"]);
  assert.deepEqual(compare((board) => { board.shots[1].move = { none: "the footage carries it" }; }).lapse, ["shot 2 move changed"], "a move, added or changed");
  assert.deepEqual(compare((board) => { board.shots[0].crop = "none"; }).lapse, ["shot 1 crop changed"], "a crop to none");
  assert.deepEqual(compare((board) => { board.shots[2].crop = [0, 0, 50, 50]; }).lapse, ["shot 3 crop changed"], "a crop from none");
  assert.deepEqual(boardChanges(COPY, null, { frame: FRAME }).lapse, ["board removed"]);
});

test("shots added, removed or moved in order lapse the approval", () => {
  // The shot made shorter to make room is named and listed too (review round 1 of B4a).
  const added = compare((board) => { board.shots[2].dur = 1.3; board.shots.push({ ...card("S4", 4.7, 1.3), why: "the end card" }); });
  assert.deepEqual(added.lapse, ["shot 3 end moved 39 frames", "shot 4 added"]);
  assert.deepEqual(added.changed, ["S3", "S4"]);
  const removed = compare((board) => { board.shots[0].dur = 3.4; board.shots.splice(1, 1); });
  // Review round 2 of B4a: a removed shot is named by its time in the approved board, so its old
  // place is not read as the shot now there.
  assert.deepEqual(removed.lapse, ["the shot at 1.4–3.4 s removed", "shot 1 end moved 60 frames"]);
  assert.deepEqual(removed.changed, ["S1"]);
  const swapped = compare((board) => { board.shots = [board.shots[1], board.shots[0], board.shots[2]]; board.shots[0].cue = 0; board.shots[1].cue = 2; });
  assert.ok(swapped.lapse.includes("shot order changed"));
  // A shot renamed (a new id) is one removed and one added.
  assert.deepEqual(compare((board) => { board.shots[2].id = "end"; }).lapse, ["the shot at 3.4–6 s removed", "shot 3 added"]);
});

test("a cut, in-point or end that moved 6 frames is logged; 7 frames lapses", () => {
  // The cut between shots 1 and 2 is shot 2's cue (shot 1's dur moves with it).
  const near = compare((board) => { board.shots[1].cue = 1.6; board.shots[0].dur = 1.6; board.shots[1].dur = 1.8; });
  assert.deepEqual(near, { lapse: [], revisions: ["revision: shot 2 cut moved 6 frames"], changed: [] });
  const far = compare((board) => { board.shots[1].cue = 1.6334; board.shots[0].dur = 1.6334; board.shots[1].dur = 1.7666; });
  // Both shots of the cut changed length: both are shown again; the cut is named once.
  assert.deepEqual(far, { lapse: ["shot 2 cut moved 7 frames"], revisions: [], changed: ["S1", "S2"] });
  assert.deepEqual(compare((board) => { board.shots[1].in = 2.2; }).revisions, ["revision: shot 2 in-point moved 6 frames"]);
  assert.deepEqual(compare((board) => { board.shots[1].in = 2.2334; }).lapse, ["shot 2 in-point moved 7 frames"]);
  assert.deepEqual(compare((board) => { board.shots[2].dur = 2.8; }).revisions, ["revision: shot 3 end moved 6 frames"]);
  assert.deepEqual(compare((board) => { board.shots[2].dur = 2.8334; }).lapse, ["shot 3 end moved 7 frames"]);
  assert.deepEqual(compare((board) => { board.shots[1].in = 2.01; }).revisions, [], "under half a frame is no change");
  assert.deepEqual(compare((board) => { board.shots[1].in = 2.034; }).revisions, ["revision: shot 2 in-point moved 1 frame"]);
});

test("a cut that now lands on a beat says so", () => {
  const onto = compare((board) => { board.shots[1].cue = 1.5; board.shots[0].dur = 1.5; board.shots[1].dur = 1.9; }, [1.5]);
  assert.deepEqual(onto.revisions, ["revision: shot 2 cut moved 3 frames onto a beat"]);
  const within = compare((board) => { board.shots[1].cue = 1.52; board.shots[0].dur = 1.52; board.shots[1].dur = 1.88; }, [1.5]);
  assert.deepEqual(within.revisions, ["revision: shot 2 cut moved 4 frames onto a beat"], "within a frame of the beat");
  const off = compare((board) => { board.shots[1].cue = 1.5; board.shots[0].dur = 1.5; board.shots[1].dur = 1.9; }, [2.5]);
  assert.deepEqual(off.revisions, ["revision: shot 2 cut moved 3 frames"]);
  // Already on a beat before the move: no "onto".
  const cut = boardChanges({ ...COPY, shots: COPY.shots.map((shot) => shot.id === "S2" ? { ...shot, cue: 1.42 } : shot) }, edited((board) => { board.shots[1].cue = 1.45; }), { frame: FRAME, beats: [1.43] });
  assert.deepEqual(cut.revisions, ["revision: shot 2 cut moved 1 frame"]);
});

test("a crop is measured in the video's frame: an edge that moved over 5% of its width lapses", () => {
  // The copy's shot 2 crop is [49, 12, 24, 76] of 16:9 footage: a 9:16 crop.
  assert.deepEqual(compare((board) => { board.shots[1].crop = [50.2, 12, 24, 76]; }), { lapse: [], revisions: ["revision: shot 2 crop moved 5% of the frame width"], changed: [] });
  assert.deepEqual(compare((board) => { board.shots[1].crop = [50.3, 12, 24, 76]; }), { lapse: ["shot 2 crop moved 5.4% of the frame width"], revisions: [], changed: ["S2"] });
  // Up 0.5% of the source is 0.5 / 76 of the crop's height, times 1920 / 1080 in the frame's width.
  assert.deepEqual(compare((board) => { board.shots[1].crop = [49, 12.5, 24, 76]; }).revisions, ["revision: shot 2 crop moved 1.2% of the frame width"]);
  // Resized from one side: the right edge moves by the change of width.
  assert.deepEqual(compare((board) => { board.shots[1].crop = [49, 12, 25.3, 76]; }).lapse, ["shot 2 crop moved 5.4% and resized 5.4% of the frame width"]);
  assert.deepEqual(compare((board) => { board.shots[1].crop = [49.001, 12, 24, 76]; }).revisions, [], "0% is no change");
});

test("smaller changes are only logged: the subject, the reason, the options, the calls and answered open items", () => {
  const logged = compare((board) => {
    board.shots[0].subject.boxes = [[15, 30, 12, 30]];
    board.shots[1].why = "the dragon turns";
    board.shots[2].alts = [{ media: clip, why: "footage under the title" }];
    board.calls = ["the dragon last"];
  });
  assert.deepEqual(logged, { lapse: [], changed: [], revisions: ["revision: shot 1 subject changed", "revision: shot 2 reason changed", "revision: shot 3 options changed",
    "revision: my calls changed"] });
  const asked = { ...structuredClone(COPY), open: ["which ending?", "logo last?"] };
  assert.deepEqual(boardChanges(asked, { ...structuredClone(COPY), open: ["logo last?"] }, { frame: FRAME }).revisions, ["revision: open items changed"], "an answered item");
});

// Review round 1 of B4a: a question added after the approval reaches the person (the board stop
// asks its open items before it asks again), so it lapses the approval.
test("an open item added after the approval lapses it, and the board stop then asks the open items", () => {
  assert.deepEqual(compare((board) => { board.open = ["Should the title be red?"]; }), { lapse: ["1 open item added"], revisions: [], changed: [] });
  const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] } };
  state.stops.push({ id: "C1", kind: "board", rev: 3, status: "answered", answer: { read_as: "approve", at: "2026-10-21T14:05:00.000Z" } });
  state.nextStop = 2;
  freezeBoard(state, state.stops[0], { board: COPY, by: "chat", now: 0 });
  const asked = { ...structuredClone(COPY), open: ["Should the title be red?"] };
  const facts = boardFacts({ scenes: [{ id: "s", width: 1080, height: 1920, duration: 6, layers: [] }], board: asked });
  settleBoard(state, { ...facts, rev: 4, now: 1000 });
  const video = { footage: true, seconds: 10 };
  assert.throws(() => checkpointStep(state, { kind: "board", video, rev: 4, now: 2000, board: facts }), { code: "open_items" });
});

// A project's agent state with board rounds: [{status, read_as?}], each with a frozen entry when it passed.
function stateWith(...rounds) {
  const state = { stops: [], boards: [] };
  rounds.forEach(({ status, read_as: readAs }, index) => {
    const round = { id: `C${index + 1}`, kind: "board", rev: index + 2, status, ...(readAs ? { answer: { read_as: readAs } } : {}) };
    state.stops.push(round);
    if (status === "allowed" || ["approve", "approve with notes"].includes(readAs)) freezeBoard(state, round, { board: COPY, by: status === "allowed" ? "settings" : "chat", now: 0 });
  });
  return state;
}

test("the approval that stands is the latest board round's, when that round passed", () => {
  assert.equal(activeApproval({ stops: [], boards: [] }), null);
  assert.equal(activeApproval(stateWith({ status: "allowed" })).stop, "C1");
  assert.equal(activeApproval(stateWith({ status: "answered", read_as: "approve" })).by, "chat");
  assert.equal(activeApproval(stateWith({ status: "answered", read_as: "approve with notes" })).read_as, "approve with notes");
  assert.equal(activeApproval(stateWith({ status: "answered", read_as: "redo" })), null);
  assert.equal(activeApproval(stateWith({ status: "answered", read_as: "approve" }, { status: "answered", read_as: "redo" })), null, "a later redo leaves no approval");
  assert.equal(activeApproval(stateWith({ status: "answered", read_as: "approve" }, { status: "waiting" })), null, "a board asked again has none until it is answered");
  assert.equal(activeApproval(stateWith({ status: "answered", read_as: "redo" }, { status: "answered", read_as: "approve" })).stop, "C2");
  const rough = stateWith({ status: "allowed" });
  rough.stops.push({ id: "C2", kind: "rough", rev: 9, status: "answered", answer: { read_as: "redo" } });
  assert.equal(activeApproval(rough).stop, "C1", "only board rounds count");
});

test("an approval keeps a copy of the board that later changes never touch", () => {
  const board = structuredClone(COPY);
  const state = { stops: [{ id: "C1", kind: "board", rev: 4, status: "answered", answer: { read_as: "approve" } }], boards: [] };
  const entry = freezeBoard(state, state.stops[0], { board: boardFacts({ scenes: [{ id: "s", width: 1080, height: 1920, duration: 6, layers: [] }], board }), by: "chat", now: Date.UTC(2026, 9, 21, 14, 5) });
  assert.deepEqual(entry, { stop: "C1", board: 2, rev: 4, at: "2026-10-21T14:05:00.000Z", by: "chat", read_as: "approve", musicFile: null, copy: COPY, lapsed: null, revisions: [] });
  board.shots[0].text = { text: "changed", family: "Inter", weight: 700, size: 96, y: 20, fill: "#ffffff" };
  assert.deepEqual(state.boards[0].copy, COPY, "the copy is not the document's board");
  // Asking again adds an entry; the first stays as it was.
  state.stops.push({ id: "C2", kind: "board", rev: 6, status: "allowed" });
  freezeBoard(state, state.stops[1], { board, by: "settings", now: 0 });
  assert.equal(state.boards.length, 2);
  assert.deepEqual(state.boards[0].copy, COPY);
  assert.equal(state.boards[1].copy.shots[0].text.text, "changed");
});

test("settleBoard logs each revision once, and a lapse sticks even when the board goes back", () => {
  const state = stateWith({ status: "answered", read_as: "approve" });
  const nudged = edited((board) => { board.shots[1].in = 2.1; });
  const first = settleBoard(state, { board: nudged, frame: FRAME, rev: 5, now: 1000 });
  assert.deepEqual(first.revisions, ["revision: shot 2 in-point moved 3 frames"]);
  assert.equal(first.lapsed, null);
  assert.deepEqual(settleBoard(state, { board: nudged, frame: FRAME, rev: 6, now: 2000 }).revisions, [], "a line already logged is not logged again");
  assert.deepEqual(state.boards[0].revisions, [{ at: "1970-01-01T00:00:01.000Z", rev: 5, line: "revision: shot 2 in-point moved 3 frames" }]);

  const retitled = edited((board) => { board.shots[2].text.text = "Orbit now"; });
  const lapsed = settleBoard(state, { board: retitled, frame: FRAME, rev: 7, now: 3000 });
  assert.deepEqual(lapsed.lapsed, ["shot 3 text changed"]);
  assert.deepEqual(state.boards[0].lapsed, { at: "1970-01-01T00:00:03.000Z", rev: 7, why: ["shot 3 text changed"] });
  const back = settleBoard(state, { board: structuredClone(COPY), frame: FRAME, rev: 8, now: 4000 });
  assert.deepEqual(back.lapsed, ["changed, then changed back to what you approved"], "an undo back to the copy does not restore the approval");
  assert.equal(back.earlier, true);
  assert.equal(state.boards[0].lapsed.rev, 7);
  assert.deepEqual(state.boards[0].copy, COPY, "settling never changes the copy");

  assert.deepEqual(boardSummary(state), { approved: { stop: "C1", board: 2, rev: 2, at: "1970-01-01T00:00:00.000Z", by: "chat",
    lapsed: { at: "1970-01-01T00:00:03.000Z", rev: 7, why: ["changed, then changed back to what you approved"] }, revisions: ["revision: shot 2 in-point moved 3 frames"] } });
  assert.equal(settleBoard({ stops: [], boards: [] }, { board: COPY, frame: FRAME, rev: 1 }), null, "nothing to settle without an approval");
  assert.deepEqual(boardSummary({ stops: [], boards: [] }), { approved: null });
});

test("kino reshapes the scene after an approval: the copy takes the re-framed crops, one revision is logged and the approval stands", () => {
  const state = stateWith({ status: "answered", read_as: "approve" });
  const wide = { width: 1920, height: 1080 };
  const sizeOf = (src) => (src === clip ? { width: 1920, height: 1080 } : null);
  const line = reframeApproved(state, { frame: wide, sizeOf, label: "16:9", rev: 9, now: 1000 });
  assert.equal(line, "revision: 2 shots (1, 2) re-framed to 16:9: kino gave the scene that shape; each crop is the widest window around its old center");
  assert.deepEqual(state.boards[0].copy.shots.map((shot) => shot.crop), [[0, 0, 100, 100], [0, 0, 100, 100], "none"]);
  // The document's board re-framed the same way settles with no lapse and nothing more to log.
  const settled = settleBoard(state, { board: reframeBoard(COPY, wide, sizeOf).board, frame: wide, rev: 9, now: 1000 });
  assert.deepEqual([settled.lapsed, settled.revisions], [null, []]);
  assert.deepEqual(state.boards[0].revisions.map((entry) => entry.line), [line]);
  assert.equal(reframeApproved({ stops: [], boards: [] }, { frame: wide, sizeOf, label: "16:9", rev: 9 }), "", "no approval, nothing to re-frame");
});

test("once the person answered a later stop, the board's approval no longer lapses: changes are logged, a redo still blocks its own stop", () => {
  const retitled = edited((board) => { board.shots[2].text.text = "Orbit now"; });
  // Allowed by settings, the rough cut was never shown: the board still lapses.
  const allowed = stateWith({ status: "answered", read_as: "approve" });
  allowed.stops.push({ id: "C2", kind: "rough", rev: 3, status: "allowed", allowedBy: "settings", answer: null });
  assert.deepEqual(settleBoard(allowed, { board: retitled, frame: FRAME, rev: 4, now: 1000 }).lapsed, ["shot 3 text changed"]);
  // A lapse from before the person answered rough (an older project) ends at the next settle.
  allowed.stops.push({ id: "C3", kind: "rough", rev: 4, status: "answered", answer: { read_as: "redo" } });
  const settled = settleBoard(allowed, { board: retitled, frame: FRAME, rev: 5, now: 2000 });
  assert.equal(settled.lapsed, null);
  assert.deepEqual(settled.revisions, ["after C3 rough: shot 3 text changed"], "shown on the dashboard as information");
  assert.equal(allowed.boards[0].lapsed, null);
  const plan = stopPlan(allowed, { seconds: 60, footage: true });
  assert.deepEqual(plan.slice(0, 2).map((entry) => entry.passed), [true, false], "the board stands; the rough redo still blocks");
  // Another shot list is not a fix: a removed shot still lapses it, the text change only logged.
  const fewer = edited((board) => { board.shots[2].text.text = "Orbit now"; board.shots.splice(1, 1); });
  const major = settleBoard(structuredClone(allowed), { board: fewer, frame: FRAME, rev: 6, now: 2500 }).lapsed;
  assert.ok(major.length === 1 && /removed/.test(major[0]), major.join("; "));
  // A board asked again after the rough answer needs a later answer of its own.
  allowed.stops.push({ id: "C4", kind: "board", rev: 6, status: "answered", answer: { read_as: "approve" } });
  freezeBoard(allowed, allowed.stops[3], { board: COPY, by: "chat", now: 0 });
  assert.deepEqual(settleBoard(allowed, { board: retitled, frame: FRAME, rev: 7, now: 3000 }).lapsed, ["shot 3 text changed"]);
});

test("a board approved with only 'your call' was handed over: a removed shot is logged, never asked again; other words still lapse", () => {
  const fewer = edited((board) => { board.shots.splice(1, 1); });
  const handed = stateWith({ status: "answered", read_as: "approve" });
  handed.stops[0].answer = { via: "chat", words: "Your call.", read_as: "approve" };
  const settled = settleBoard(handed, { board: fewer, frame: FRAME, rev: 4, now: 1000 });
  assert.equal(settled.lapsed, null);
  assert.ok(settled.revisions.some((line) => /^after "Your call\.": the shot at .* removed$/.test(line)), settled.revisions.join("; "));
  const said = stateWith({ status: "answered", read_as: "approve" });
  said.stops[0].answer = { via: "chat", words: "yes, your call on the font", read_as: "approve" };
  assert.ok(/removed/.test(settleBoard(said, { board: fewer, frame: FRAME, rev: 4, now: 1000 }).lapsed.join()));
});

test("boardFacts reads the board, the video's frame and length, the gap and the beats", () => {
  const document = { scenes: [{ id: "s", width: 1080, height: 1920, duration: 6, layers: [] }], board: COPY,
    cues: [{ name: "beat-1", time: 1.5, kind: "beat" }, { name: "onset-1", time: 2, kind: "onset" }, { name: "hit", time: 3, kind: "marker" }] };
  const facts = boardFacts(document);
  assert.deepEqual({ ...facts, board: facts.board === COPY }, { board: true, frame: FRAME, seconds: 6, span: { start: 0, end: 6, music: null, length: 6 }, coverage: null, beats: [1.5], audio: [], musicFile: null });
  // A voice-over: the audio layers that are not the board's music.
  const voiced = boardFacts({ ...document, scenes: [{ ...document.scenes[0], layers: [{ id: "a1", type: "audio", name: "voice" }, { id: "t1", type: "text", name: "title" }] }] });
  assert.deepEqual(voiced.audio, ["voice"]);
  const short = boardFacts({ ...document, scenes: [{ ...document.scenes[0], duration: 7 }] });
  assert.equal(short.coverage.message, "the shots end at 6 s, before the video ends (7 s): make the last shot 1 s longer.");
  assert.deepEqual(boardFacts({ scenes: [] }), { board: null, frame: { width: 0, height: 0 }, seconds: 0, span: null, coverage: null, beats: [], audio: [], musicFile: null });
});

// ---- review round 1 of B4a ----------------------------------------------------------------

const VIDEO = { footage: true, seconds: 8.8, width: 1080, height: 1920 };
const documentWith = (board, duration = 8.8) => ({ scenes: [{ id: "s", width: 1080, height: 1920, duration, layers: [] }], board });
// The four shots of the stop tests: the clip's three shots, then a title to 8.8 s.
const FOUR = () => ({ rev: 1, music: "none", calls: [], open: [], shots: [footage("A", 0, 1.25, 0, [20, 12, 24, 76]), footage("B", 1.25, 2.083, 1.25, [38, 12, 24, 76]),
  footage("C", 3.333, 1.084, 3.333, [55, 12, 24, 76]), { ...card("D", 4.417, 4.383) }] });
// An agent state with a brief and board round C1 approved on FOUR (or `copy`).
function approved(copy = FOUR(), readAs = "approve") {
  const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] }, nextStop: 2 };
  state.stops.push({ id: "C1", kind: "board", rev: 3, status: "answered", answer: { read_as: readAs, at: "2026-10-21T14:05:00.000Z" } });
  freezeBoard(state, state.stops[0], { board: copy, by: "chat", now: 0 });
  return state;
}

test("a shot removed or added: its neighbor that got longer or shorter is named and shown again, not called unchanged", () => {
  const copy = FOUR();
  const board = structuredClone(copy);
  board.shots.splice(2, 1);
  board.shots[1].dur = 2.083 + 1.084;
  const changes = boardChanges(copy, board, { frame: FRAME });
  assert.deepEqual(changes, { lapse: ["the shot at 3.33–4.42 s removed", "shot 2 end moved 33 frames"], revisions: [], changed: ["B"] });
  const ask = boardAsk({ id: "C2", board, frame: FRAME, seconds: 8.8, changed: { why: changes.lapse, ids: changes.changed, approved: "C1" } }).text.split("\n");
  assert.equal(ask[0], "The storyboard changed since you approved it (C1); asking again (C2): the shot at 3.33–4.42 s removed; shot 2 end moved 33 frames.");
  assert.ok(ask.some((line) => line.startsWith("Shot 2, 1.25–4.42 s:")), ask.join("\n"));
  assert.ok(ask.includes('2 unchanged: say "all shots".'), ask.join("\n"));
  // Guessed bans are asked, not applied.
  const banned = boardAsk({ id: "C2", board, frame: FRAME, seconds: 8.8, bans: ["never: maps"] }).text;
  assert.match(banned, /\nBans I guessed \(which are yours\?\): never: maps\n/);
  // Inserted by shortening B: B is shown with the new shot.
  const inserted = structuredClone(copy);
  inserted.shots[1].dur = 0.5;
  inserted.shots.splice(2, 0, { ...card("X", 1.75, 1.583) });
  assert.deepEqual(boardChanges(copy, inserted, { frame: FRAME }).changed, ["B", "X"]);
});

test("after a lapse, the reasons are the board's now: a change put back is no longer given, a later one is", () => {
  const state = approved();
  const facts = (board) => ({ ...boardFacts(documentWith(board)), rev: 9, now: 1000 });
  const retitled = FOUR();
  retitled.shots[3].text = { ...retitled.shots[3].text, text: "Orbit now" };
  assert.deepEqual(settleBoard(state, facts(retitled)).lapsed, ["shot 4 text changed"]);
  // Shot 4's text back as approved; shot 1's crop moved 10 points.
  const moved = FOUR();
  moved.shots[0].crop = [30, 12, 24, 76];
  const settled = settleBoard(state, facts(moved));
  assert.deepEqual([settled.lapsed, settled.earlier], [["shot 1 crop moved 41.7% of the frame width"], true]);
  assert.deepEqual(lapsedChanges(state, boardFacts(documentWith(moved))), { why: ["shot 1 crop moved 41.7% of the frame width"], ids: ["A"], approved: "C1" });
  assert.equal(state.boards[0].lapsed.rev, 9, "the lapse keeps when it first happened");
});

test("a longer video or a moved music layer lapses the approval: the new part was never on a board", () => {
  const state = approved();
  const longer = boardFacts(documentWith(FOUR(), 20));
  const settled = settleBoard(state, { ...longer, rev: 9, now: 1000 });
  assert.deepEqual(settled.lapsed, ["a gap at 8.8–20 s"]);
  assert.equal(stopPlan(state, { ...VIDEO, seconds: 20 })[0].passed, false);
  assert.throws(() => checkpointStep(state, { kind: "board", video: { ...VIDEO, seconds: 20 }, rev: 9, now: 2000, board: longer }), { code: "board_gap" });
});

test("move_needed: a board is refused only while its hook and payoff are both plain; plain cuts between them are fine", () => {
  const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] } };
  const board = FOUR();
  for (const shot of board.shots) delete shot.move;
  const ask = () => checkpointStep(state, { kind: "board", video: VIDEO, rev: 3, now: 1000, board: boardFacts(documentWith(board)) });
  // Only the key beats are named, each with moves that fit it.
  assert.throws(ask, { code: "move_needed", message: /no designed move on the hook or payoff \(shots 1, 4\)\. Give one of shots 1, 4 a designed move.*every other shot can stay a plain cut.*Fits: shot 1 \(hook, footage\): camera window-punch-in \(phone-film@3\.13\) or .*; shot 4 \(payoff, last shot\): type logo-settle a quiet end \(agent-launch@50\.4\)/ });
  // One designed move on the payoff is enough: shots 1 to 3 stay plain cuts.
  board.shots[3].move = { kind: "type", name: "logo-settle", ref: "agent-launch@50.4" };
  assert.equal(ask().data.status, "waiting_for_you");
});

test("the board stop switched to allow while it waits: kino freezes the board it showed, so later changes are measured", () => {
  const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] } };
  const facts = boardFacts(documentWith(FOUR()));
  assert.equal(checkpointStep(state, { kind: "board", video: VIDEO, rev: 3, now: 0, board: facts }).data.status, "waiting_for_you");
  const rules = stopRules({ "checkpoint-board": "allow" });
  settleWaiting(state, { video: VIDEO, rules, rev: 3, now: 1000, board: facts });
  assert.deepEqual([state.stops[0].status, state.stops[0].allowedBy], ["allowed", "settings"]);
  assert.deepEqual([state.boards.length, state.boards[0].by, state.boards[0].stop], [1, "settings", "C1"]);
  assert.deepEqual(state.boards[0].copy, FOUR());
  const retitled = FOUR();
  retitled.shots[3].text = { ...retitled.shots[3].text, text: "Orbit now" };
  assert.deepEqual(settleBoard(state, { ...boardFacts(documentWith(retitled)), rev: 4, now: 2000 }).lapsed, ["shot 4 text changed"]);
  assert.equal(stopPlan(state, VIDEO, rules)[0].passed, false);
  // A storyboard round that passed with no frozen copy (an older kino) is not an approval.
  const old = { ...emptyAgentState(), stops: [{ id: "C1", kind: "board", rev: 3, status: "allowed", allowedBy: "settings" }] };
  assert.equal(stopPlan(old, VIDEO)[0].passed, false);
});

test("'approve with notes' on the board freezes a copy, as 'approve' does", () => {
  const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] } };
  const facts = boardFacts(documentWith(FOUR()));
  checkpointStep(state, { kind: "board", video: VIDEO, rev: 3, now: 0, board: facts });
  const answer = answerStep(state, { input: { id: "C1", rev: 3, words: "approve, but a bigger title", read_as: "approve with notes" }, video: VIDEO, rev: 3, now: 30_000, board: facts });
  assert.equal(answer.data.passed, true);
  assert.deepEqual([state.boards.length, state.boards[0].read_as, state.boards[0].by], [1, "approve with notes", "chat"]);
  assert.deepEqual(state.boards[0].copy, FOUR());
  assert.equal(activeApproval(state).stop, "C1");
});

// B2b with B4a: the person's answer on the dashboard's stop card.
test("the board answered on the dashboard: approve and approve with notes freeze a copy by dashboard, a redo none; a reopen takes the approval back", () => {
  const facts = boardFacts(documentWith(FOUR()));
  for (const [input, frozen] of [[{ read_as: "approve" }, true], [{ read_as: "approve with notes", words: "a bigger title" }, true], [{ read_as: "redo", words: "start on the dragon" }, false]]) {
    const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] } };
    checkpointStep(state, { kind: "board", video: VIDEO, rev: 3, now: 0, board: facts });
    dashboardAnswerStep(state, { input: { id: "C1", rev: 3, ...input }, video: VIDEO, rev: 3, now: 30_000, board: facts });
    assert.equal(stopPlan(state, VIDEO)[0].passed, frozen, input.read_as);
    if (!frozen) {
      assert.deepEqual([state.boards ?? [], activeApproval(state)], [[], null]);
      assert.equal(state.inbox.at(-1).text, 'C1 board: the person asked for a redo in kino: "start on the dragon". Fix only what they named, then ask again: notes {action:"checkpoint", id:"board"}.');
      assert.equal(statusLines(state, VIDEO)[1], "step: fix what they named, ask board again", "the board is asked again without a check");
      continue;
    }
    assert.deepEqual([state.boards.length, state.boards[0].stop, state.boards[0].by, state.boards[0].read_as], [1, "C1", "dashboard", input.read_as]);
    assert.deepEqual(state.boards[0].copy, FOUR());
    // A later change past the tolerances lapses it, as for a chat answer.
    const retitled = FOUR();
    retitled.shots[3].text = { ...retitled.shots[3].text, text: "Orbit now" };
    assert.deepEqual(settleBoard(state, { ...boardFacts(documentWith(retitled)), rev: 4, now: 40_000 }).lapsed, ["shot 4 text changed"]);
    assert.equal(stopPlan(state, VIDEO)[0].passed, false);
    assert.equal(statusLines(state, VIDEO)[1], "step: ask board again (changed shots)");
  }
  // Reopened: no approval stands, the copy stays, and the next ask shows the whole board.
  const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] } };
  checkpointStep(state, { kind: "board", video: VIDEO, rev: 3, now: 0, board: facts });
  dashboardAnswerStep(state, { input: { id: "C1", rev: 3, read_as: "approve" }, video: VIDEO, rev: 3, now: 30_000, board: facts });
  const copy = structuredClone(state.boards);
  reopenStep(state, { input: { id: "C1" }, now: 50_000 });
  assert.equal(activeApproval(state), null);
  assert.deepEqual(boardSummary(state), { approved: null });
  assert.deepEqual(state.boards, copy, "a reopen changes no frozen copy");
  assert.equal(stopPlan(state, VIDEO)[0].passed, false);
  assert.deepEqual(statusLines(state, VIDEO).map((line) => line.replace(/replies \d+/, "replies N")), ["direction: C1 board reopened · replies N/10", "step: ask board again"]);
  assert.equal(settleBoard(state, { ...facts, rev: 4, now: 60_000 }), null, "nothing is measured against a copy no approval stands on");
  const again = checkpointStep(state, { kind: "board", video: VIDEO, rev: 4, now: 70_000, board: facts });
  assert.deepEqual([again.data.status, again.data.id, again.data.board.listed], ["waiting_for_you", "C2", 4]);
  assert.ok(again.data.ask.startsWith("The storyboard is ready (C2): "), again.data.ask);
});

test("status stops saying 'ask board again' once the video has no storyboard stop (under 8 s, or its skip-under)", () => {
  const state = approved();
  const short = FOUR();
  short.shots[3].dur = 7 - 4.417;
  settleBoard(state, { ...boardFacts(documentWith(short, 7)), rev: 9, now: 1000 });
  assert.deepEqual(statusLines(state, VIDEO), ["direction: C1 board lapsed · replies 1/10", "step: ask board again (changed shots)"]);
  for (const [video, rules] of [[{ ...VIDEO, seconds: 7 }], [VIDEO, stopRules({}, { skipBoardUnder: 3600 })]]) {
    const [direction, next] = statusLines(state, video, rules);
    assert.equal(direction, "direction: C1 board approved · replies 1/10", JSON.stringify(video));
    assert.notEqual(next, "step: ask board again (changed shots)");
    assert.equal(checkpointStep(state, { kind: "board", video, rules, rev: 9, now: 2000, board: boardFacts(documentWith(short, 7)) }).data.status, "skipped");
  }
});

test("a board sent again without ids: a title card added first is 'shot 1 added', not every shot changed", () => {
  const copy = FOUR();
  const again = [{ ...card(undefined, 0, 1), text: { ...card("x", 0, 1).text, text: "Sintel" } },
    ...copy.shots.slice(0, 3).map(({ id, ...shot }) => ({ ...shot, cue: shot.cue + 1 })), { ...copy.shots[3], id: undefined, cue: 5.417, dur: 3.383 }];
  keepShotIds(again, copy.shots);
  const changes = boardChanges(copy, { ...copy, shots: again }, { frame: FRAME });
  assert.equal(changes.lapse[0], "shot 1 added");
  assert.ok(!changes.lapse.some((line) => /media|text|follow|crop/.test(line)), changes.lapse.join("; "));
  assert.deepEqual(changes.lapse.slice(1), ["shot 2 cut moved 30 frames", "shot 3 cut moved 30 frames", "shot 4 cut moved 30 frames", "shot 5 cut moved 30 frames"]);
});

// ---- review round 2 of B4a ----------------------------------------------------------------

test("a gap the video made lapses the approval only while it lasts: closed within the tolerances, the approval stands and the change is logged", () => {
  const settle = (state, board, duration, rev) => settleBoard(state, { ...boardFacts(documentWith(board, duration)), rev, now: rev * 1000 });
  const longer = FOUR();
  longer.shots[3].dur = 4.483;
  // In two edits: the video 0.1 s longer, then the last shot 3 frames longer.
  const state = approved();
  assert.deepEqual(settle(state, FOUR(), 8.9, 4).lapsed, ["a gap at 8.8–8.9 s"]);
  assert.deepEqual(state.boards[0].lapsed, { at: new Date(4000).toISOString(), rev: 4, why: ["a gap at 8.8–8.9 s"], gap: true });
  assert.deepEqual(statusLines(state, VIDEO)[0].startsWith("direction: C1 board lapsed"), true);
  const closed = settle(state, longer, 8.9, 5);
  assert.deepEqual([closed.lapsed, closed.revisions, closed.stands], [null, ["revision: shot 4 end moved 3 frames"], true]);
  assert.equal(state.boards[0].lapsed, null);
  assert.equal(activeApproval(state).stop, "C1");
  assert.equal(lapsedChanges(state, boardFacts(documentWith(longer, 8.9))), null);
  // In one edit: the same result, so it does not depend on how the agent splits its edits.
  const once = approved();
  assert.deepEqual(settle(once, longer, 8.9, 4), { approval: once.boards[0], lapsed: null, revisions: ["revision: shot 4 end moved 3 frames"] });
  assert.deepEqual(once.boards[0].revisions.map((entry) => entry.line), state.boards[0].revisions.map((entry) => entry.line));

  // A gap closed by a change past the tolerances lapses for good, and so does a field changed
  // during the gap: those stick as any lapse does.
  const far = approved();
  settle(far, FOUR(), 20, 4);
  const stretched = FOUR();
  stretched.shots[3].dur = 15.583;
  assert.deepEqual(settle(far, stretched, 20, 5).lapsed, ["shot 4 end moved 336 frames"]);
  assert.deepEqual(settle(far, FOUR(), 8.8, 6).lapsed, ["changed, then changed back to what you approved"]);
  const during = approved();
  settle(during, FOUR(), 8.9, 4);
  const retitled = structuredClone(longer);
  retitled.shots[3].text = { ...retitled.shots[3].text, text: "Orbit now" };
  assert.deepEqual(settle(during, retitled, 8.9, 5).lapsed, ["shot 4 text changed"]);
  assert.equal(during.boards[0].lapsed.gap, undefined);
  assert.deepEqual(settle(during, longer, 8.9, 6).lapsed, ["changed, then changed back to what you approved"]);
});

test("a crop resized past 5% of the frame width lapses, even when the zoom stays centered", () => {
  const wide = { width: 1920, height: 1080 };
  const shot = (crop) => ({ rev: 1, music: "none", calls: [], open: [], shots: [footage("A", 0, 1, 0, crop)] });
  // A 9% zoom in, centered: each edge moves 4.5%, the width changes 9%.
  assert.deepEqual(boardChanges(shot([0, 0, 100, 100]), shot([4.5, 4.5, 91, 91]), { frame: wide }).lapse, ["shot 1 crop moved 4.5% and resized 9% of the frame width"]);
  assert.deepEqual(boardChanges(shot([0, 0, 100, 100]), shot([2, 2, 96, 96]), { frame: wide }).revisions[0], "revision: shot 1 crop moved 2% and resized 4% of the frame width");
  // 9:16 from 16:9: a 31.6-wide crop 5.5% smaller around its center.
  const lapse = boardChanges(shot([34.2, 0, 31.6, 100]), shot([35.069, 2.75, 29.862, 94.5]), { frame: FRAME }).lapse;
  assert.equal(lapse.length, 1);
  assert.match(lapse[0], /^shot 1 crop moved [\d.]+% and resized 5\.5% of the frame width$/);
});

test("the music layer's file is frozen with the board: another file, or the layer deleted, lapses the approval", () => {
  const board = { ...FOUR(), music: "song" };
  const withMusic = (src) => ({ scenes: [{ id: "s", width: 1080, height: 1920, duration: 8.8, layers: src ? [{ id: "song", type: "audio", name: "song", src, mediaStart: 0, mediaDuration: 8.8 }] : [] }], board });
  const state = { ...emptyAgentState(), nextStop: 2, stops: [{ id: "C1", kind: "board", rev: 3, status: "answered", answer: { read_as: "approve" } }] };
  freezeBoard(state, state.stops[0], { board: boardFacts(withMusic("/api/media/song.wav")), by: "chat", now: 0 });
  assert.equal(state.boards[0].musicFile, "/api/media/song.wav");
  const settle = (document) => settleBoard(structuredClone(state), { ...boardFacts(document), rev: 4, now: 1000 });
  assert.deepEqual(settle(withMusic("/api/media/song.wav")).lapsed, null);
  assert.deepEqual(settle(withMusic("/api/media/other.wav")).lapsed, ["music file changed"]);
  assert.deepEqual(settle(withMusic(null)).lapsed, ["music removed"]);
});

// Found making the smokescreen promo: footage added after the rough cut's redo made the
// storyboard due, and checkpoint refused rough, while status still said "ask rough again".
test("a redo of a later stop names the storyboard first when footage made it due", () => {
  const state = { ...emptyAgentState(), brief: { noPlayback: { reason: "just start" }, fields: {}, log: [] },
    stops: [{ id: "C1", kind: "rough", rev: 3, status: "answered", answer: { read_as: "redo", words: "less AI" } }] };
  assert.equal(statusLines(state, VIDEO)[1], "step: fix what they named, check, ask board, then rough");
  assert.equal(statusLines(state, { ...VIDEO, footage: false })[1], "step: fix what they named, check, ask rough again");
});

// A board of pictures has no mediaStart to match: after compose {from:"board"} its next: named
// the build again, forever (skeptic run, a 4-shot promo of one screenshot).
test("a board counts as built by its shots' show times, pictures and text cards too", () => {
  const picture = "/api/media/screen.png";
  const shots = [card("S1", 0, 2), { ...footage("S2", 2, 3, 0, [10, 12, 24, 76]), media: picture }, { ...footage("S3", 5, 1, 0, [10, 12, 24, 76]), media: picture }];
  const shown = (start) => [{ kind: "show", start }, { kind: "hide", start: start + 1 }];
  const document = (layers) => ({ board: { shots }, scenes: [{ id: "s1", layers }] });
  assert.equal(boardBuilt(document([])), false);
  assert.equal(boardBuilt(document([{ type: "image", src: picture, animations: shown(2) }, { type: "text", text: "Orbit", animations: shown(0) }])), true);
  assert.equal(boardBuilt(document([{ type: "image", src: picture, animations: shown(4) }])), false, "a picture shown at another time is not the shot");
});
