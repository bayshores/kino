// Unit tests of the stop rules (backend/agent/stops.mjs) on plain agent states: the choices the
// B2a build made where the design left room. backend/agent-checkpoint.test.mjs runs the stops
// through a real server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSettings, defaultSettings } from "./agent/dashboard.mjs";
import { emptyAgentState } from "./agent/state.mjs";
import { estimateTextTokens } from "./meter.mjs";
import { keepAsking, reopenStep, StopError, stopRules, stopsSummary, waitingStop, workPrint } from "./agent/stops.mjs";
import * as stops from "./agent/stops.mjs";
import { answerStep, checkpointStep, dashboardAnswerStep, settleWaiting, stopPlan, statusLines } from "./stops.test.support.mjs";
import { boardFacts, freezeBoard } from "./agent/board.mjs";
import { personCall } from "./agent/critique.mjs";
import { cleanTreatments } from "./agent/treatments.mjs";
import { videoFacts } from "./agent/brief.mjs";
import { ASK_SHOTS, ASK_TOKENS, FRESH_TOKENS, SHOT_TOKENS } from "./agent/board-text.mjs";
import { serviceFor, withAsk } from "./agent-ask.test.support.mjs";
import { createDocument, createLayer, createScene } from "../engine/model.js";

const VIDEO = { seconds: 24, layers: 1, footage: false, width: 1080, height: 1920 };
// Since B4a the storyboard stop asks about the board saved in the document: one title card a
// shot, covering the video (boardFacts of a 24 s 1080×1920 document; `seconds` to cover another).
const card = (n, cue, dur) => ({ id: `S${n}`, cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: `Line ${n}`, family: "Inter", weight: 700, size: 96, y: 40, fill: "#ffffff" }, sound: "none", why: "the line on its own", alts: [], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" } });
function boardOf({ seconds = 24, shots = 2, width = 1080, height = 1920 } = {}) {
  const board = { rev: 1, music: "none", calls: [], open: [], shots: Array.from({ length: shots }, (_, index) => card(index + 1, (seconds / shots) * index, seconds / shots)) };
  return boardFacts({ scenes: [{ id: "s", width, height, duration: seconds, layers: [] }], board });
}
const BOARD = boardOf();
const T0 = Date.parse("2026-10-21T14:00:00.000Z");

// An agent state with a brief and a full check of `rev` with no errors.
function ready(rev = 4) {
  const state = emptyAgentState();
  state.brief = { rev: 0, savedAt: null, confirmedRev: null, noPlayback: { reason: "just start", rev: 0 }, fields: {}, log: [] };
  state.checked = { rev, errors: 0, warnings: 1, at: new Date(T0).toISOString(), client: "claude-code" };
  return state;
}

const refusal = (run) => {
  try { run(); } catch (error) { if (error instanceof StopError) return error; throw error; }
  assert.fail("the call was not refused");
};

test("a waiting stop lapses when the project moved on, and stays lapsed when the new ask is refused", () => {
  const state = ready(4);
  assert.equal(checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 }).data.id, "C1");
  // The person undid a turn (rev 5); the agent has not checked rev 5 yet.
  const error = refusal(() => checkpointStep(state, { kind: "rough", video: VIDEO, rev: 5, now: T0 + 60_000 }));
  assert.equal(error.code, "check_first");
  assert.equal(state.stops[0].status, "lapsed", "the service saves this draft, so the project's writes work again");
  assert.equal(state.stops[0].lapsedRev, 5);
  assert.deepEqual(statusLines(state, VIDEO), ["direction: C1 rough lapsed · replies 0/10", "step: check, then ask rough again"]);
});

test("a stop ask names the open rules (top 3), the waived count and the top waived rules; a rule waived on * shows all; none waived adds nothing", () => {
  const waivers = [...Array.from({ length: 17 }, (_, n) => ({ code: "crop_no_subject", target: `shot-${n}`, reason: "meant" })),
    ...Array.from({ length: 9 }, (_, n) => ({ code: "held_static", target: `card-${n}`, reason: "meant" })),
    { code: "no_music", target: "*", reason: "silent" }, { code: "overlap", target: "a", reason: "x" }, { code: "overlap", target: "b", reason: "x" }];
  const asked = checkpointStep(ready(4), { kind: "rough", video: VIDEO, rev: 4, now: T0, waivers });
  assert.match(asked.data.ask, /^Checked: 0 errors · 1 warning · 29 waived \(crop_no_subject 17, held_static 9, overlap 2\)\.$/m);
  // The check saved its open rules: the 3 with the most findings, most first.
  const top = stops.topRules({ shape_guess: { errors: 0, warnings: 1 }, ask_unmet: { errors: 0, warnings: 2 }, contrast: { errors: 1, warnings: 2 }, hold: { errors: 0, warnings: 1 } });
  assert.deepEqual(top, [["contrast", 3], ["ask_unmet", 2], ["hold", 1]]);
  const named = ready(4);
  named.checked = { ...named.checked, errors: 0, warnings: 6, top };
  const pointed = 'Your ask points to "tower" (in 11 of 15 titles about what you asked for): keeper shows it at 1.2 s.';
  const roughAsk = checkpointStep(named, { kind: "rough", video: { ...VIDEO, askLine: pointed }, rev: 4, now: T0, waivers }).data.ask;
  assert.match(roughAsk, /^Checked: 0 errors · 6 warnings \(contrast 3, ask_unmet 2, hold 1\) · 29 waived \(crop_no_subject 17, held_static 9, overlap 2\)\.$/m);
  // The rough cut also says what the person's ask points to and which shot shows it (ask.js askLine).
  assert.ok(roughAsk.split("\n").includes(pointed), roughAsk);
  assert.match(stops.waivedLine([{ code: "no_music", target: "*", reason: "silent" }]), /^1 waived \(no_music all\)$/);
  assert.doesNotMatch(checkpointStep(ready(4), { kind: "rough", video: VIDEO, rev: 4, now: T0 }).data.ask, /waived/);
  // The service can hand the waivers over inside the video facts instead.
  assert.match(checkpointStep(ready(4), { kind: "rough", video: { ...VIDEO, waivers: waivers.slice(0, 2) }, rev: 4, now: T0 }).data.ask, /2 waived \(crop_no_subject 2\)/);
});

test("the service's stop ask carries the document's waivers: the person's rough cut ask shows the waived line", async (t) => {
  const title = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#101010" } };
  const waive = { op: "waive_check", code: "default_font", target: "title", reason: "the brand's font" };
  const { call } = await serviceFor(t, { document: createDocument({ id: "waived", name: "waived", scenes: [createScene({ id: "s1", width: 1080, height: 1920, duration: 24 })] }) });
  const edited = await call("edit", { ops: [title, waive] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal((await call("notes", { action: "brief", no_playback: "just start" })).isError, undefined);
  const checked = await call("check");
  assert.equal(checked.data.errors, 0, checked.text);
  const asked = await call("notes", { action: "checkpoint", id: "rough" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.match(asked.data.ask, /^Checked: 0 errors · \d+ warnings? \([a-z_]+ \d+(, [a-z_]+ \d+){0,2}\) · 1 waived \(default_font 1\)\.$/m, asked.data.ask);
});

test("the service follows the footage itself: 'looks good' on a built 9:16 scene of 16:9 clips makes it 16:9 and re-frames both shots, even when they share a name, and the board's crops", async (t) => {
  const fileId = "11111111-2222-3333-4444-555555555555.mp4";
  const clip = (id, start) => createLayer("video", { id, name: "clip", src: `/api/media/${fileId}`, x: 0, y: 0, width: 3413, height: 1920, start, duration: 8 });
  // A board saved before the footage was placed, its crops 9:16 windows of the 16:9 file.
  const shot = (id, cue, crop) => ({ id, cue, dur: 8, pacing: "free", media: `/api/media/${fileId}`, in: 0, crop, subject: "none", follow: "steady", text: "none", sound: "none", why: "the clip" });
  const board = { rev: 1, music: "none", shots: [shot("S1", 0, [20, 12, 24, 76]), shot("S2", 8, [70, 0, 30, 100])] };
  let clock = 1_000;
  const { call, agentState, store } = await serviceFor(t, { steadyNow: () => clock,
    document: createDocument({ id: "follow", name: "follow", board, scenes: [createScene({ id: "s1", width: 1080, height: 1920, duration: 16, layers: [clip("v1", 0), clip("v2", 8)] })] }),
    media: [{ id: fileId, name: "keeper", mime: "video/mp4", width: 1920, height: 1080, duration: 16 }],
  });
  await agentState.update("follow", (draft) => { draft.brief = { rev: 1, fields: withAsk({ plays_on: { text: "a phone", by: "guessed" } }), log: [], noPlayback: { reason: "just start", rev: 1 } }; });
  await call("check");
  const asked = await call("notes", { action: "checkpoint", id: "rough" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  clock += 60_000;
  const answered = await call("notes", { action: "answer", id: asked.data.id, rev: asked.data.rev, words: "looks good", read_as: "approve" });
  assert.match(answered.text, /shape: no shape named: kino made s1 16:9 \(1920x1080\) like the footage and re-framed 2 shots \(frame_shot\)/, answered.text);
  assert.equal(answered.shapeFollow, undefined, "the follow intent stays inside kino");
  const { document } = await store.getProject("follow");
  assert.deepEqual([document.scenes[0].width, document.scenes[0].height], [1920, 1080]);
  assert.doesNotMatch((await call("check")).text, /shape_guess/);
  assert.match(answered.text, /board: 2 shots \(1, 2\) re-framed to 16:9, each the widest window around its old crop's center \(board r2/, answered.text);
  assert.deepEqual(document.board.shots.map((entry) => entry.crop), [[0, 0, 100, 100], [0, 0, 100, 100]]);
});

test("a board saved on a guessed 9:16 scene over the person's own 16:9 clip: kino makes the scene 16:9 first, so the 9:16 crops are refused with the new numbers", async (t) => {
  const fileId = "21111111-2222-3333-4444-555555555555.mp4";
  // A clip the person imported themselves (allowed in this project, not placed): shapeAtImport never saw it.
  const { call, agentState, store } = await serviceFor(t, {
    document: createDocument({ id: "shape-board", name: "shape-board", scenes: [createScene({ id: "s1", width: 1080, height: 1920, duration: 4, layers: [] })] }),
    media: [{ id: fileId, name: "theirs", mime: "video/mp4", width: 1920, height: 1080, duration: 8, projectId: "shape-board" }],
  });
  const shot = (crop) => ({ cue: 0, dur: 4, pacing: "free", media: `/api/media/${fileId}`, in: 0, crop, subject: "none", follow: "steady", text: "none", sound: "none", why: "their clip" });
  const refused = await call("edit", { ops: [{ op: "board", music: "none", shots: [shot([38, 12, 24, 76])] }] });
  assert.equal(refused.data.boardError, "bad_shot", refused.text);
  assert.match(refused.data.reason, /crop \[38, 12, 24, 76\] is 0\.56 wide per 1 tall on the source; the video is 1920×1080 \(1\.78\): with h 76, w is 76/);
  assert.match(refused.data.shape, /^shape: s1 is now 16:9 \(1920x1080\) like your footage \(1 of 1\), before the storyboard is saved/);
  const scene = (await store.getProject("shape-board")).document.scenes[0];
  assert.deepEqual([scene.width, scene.height], [1920, 1080], "the shape stays settled though the board was refused");
  assert.deepEqual((await agentState.read("shape-board")).shapeFollowed.from, [1080, 1920]);
  // Sent again with a 16:9 crop: saved, and nothing more to settle.
  const saved = await call("edit", { ops: [{ op: "board", music: "none", shots: [shot("whole")] }] });
  assert.equal(saved.isError, undefined, saved.text);
  assert.equal(saved.data.shape, undefined);
});

test("a board ask names a guessed shape against the footage's; an answer that names none saves the footage's shape as plays_on", () => {
  const state = ready(4);
  state.brief.fields.plays_on = { text: "a phone feed", by: "guessed", rev: 0 };
  const wide = { width: 1920, height: 1080 };
  const pointed = 'Your ask points to "tower" (in 11 of 15 titles about what you asked for): no shot is marked as showing it yet.';
  const video = { ...VIDEO, footage: true, footageSizes: [wide, wide, wide], askLine: pointed };
  const asked = checkpointStep(state, { kind: "board", video, rev: 4, now: T0, board: BOARD });
  assert.match(asked.data.ask, /^Shape: 9:16 \(1080x1920\) is my guess; your footage is 16:9 \(3 of 3\)\. Name a shape or a place to keep 9:16; any other reply makes it 16:9 like the footage\.$/m);
  assert.equal(asked.data.ask.split("\n")[2], pointed, "the board says what the ask points to, right after the shape");
  assert.deepEqual(state.stops[0].shape, { scene: "9:16", footage: "16:9", size: [1920, 1080] });
  const answered = answerStep(state, { input: { id: "C1", rev: 4, words: "looks good, keep going", read_as: "approve" }, video, rev: 4, now: T0 + 30_000, board: BOARD });
  assert.match(answered.text, /shape: no shape named: kino follows the footage \(16:9\)/);
  assert.deepEqual(answered.shapeFollow, { shape: null }, "the service then makes the scene the footage's shape itself");
  // The label is the most common aspect of the majority shape, and its size is the one the finding names.
  const mixed = ready(4);
  mixed.brief.fields.plays_on = { text: "a phone feed", by: "guessed", rev: 0 };
  const ultra = { width: 1280, height: 588 };
  const mixedAsk = checkpointStep(mixed, { kind: "board", video: { ...video, footageSizes: [ultra, ultra, wide, wide, wide] }, rev: 4, now: T0, board: BOARD });
  assert.match(mixedAsk.data.ask, /your footage is 16:9 \(5 of 5\)/);
  assert.deepEqual(mixed.stops[0].shape.size, [1920, 1080]);
  // kino already followed the footage at the import: the ask says so, once, and how to name another.
  const followed = ready(4);
  followed.brief.fields.plays_on = { text: "a phone feed", by: "guessed", rev: 0 };
  const wideVideo = { ...video, width: 1920, height: 1080, shapeFollowed: true };
  const followAsk = checkpointStep(followed, { kind: "board", video: wideVideo, rev: 4, now: T0, board: BOARD });
  assert.match(followAsk.data.ask, /^Shape: 16:9 like your footage \(3 of 3\)\. Name a shape or a place if it plays somewhere else\.$/m);
  const followAnswer = answerStep(followed, { input: { id: "C1", rev: 4, words: "looks good", read_as: "approve" }, video: wideVideo, rev: 4, now: T0 + 30_000, board: BOARD });
  assert.equal(followAnswer.shapeFollow, undefined, "nothing to change: the scene has the footage's shape");
  assert.equal(followed.brief.fields.plays_on.by, "you");
  const plays = state.brief.fields.plays_on;
  assert.deepEqual([plays.by, plays.named, plays.quote], ["you", false, "looks good, keep going"]);
  assert.match(plays.text, /16:9, like the footage/);
  assert.equal(state.brief.rev, 1, "applyBrief raised the revision");
  // Their own answer keeps a confirmed brief confirmed: no second playback.
  const confirmed = ready(4);
  confirmed.brief = { ...confirmed.brief, rev: 2, confirmedRev: 2, noPlayback: null, fields: { plays_on: { text: "a phone feed", by: "guessed", rev: 1 } } };
  checkpointStep(confirmed, { kind: "board", video, rev: 4, now: T0, board: BOARD });
  answerStep(confirmed, { input: { id: "C1", rev: 4, words: "looks good", read_as: "approve" }, video, rev: 4, now: T0 + 30_000, board: BOARD });
  assert.deepEqual([confirmed.brief.rev, confirmed.brief.confirmedRev], [3, 3]);
  // A shape named in the words is saved with the sentence that names it, and the next ask no longer carries the line.
  const named = ready(4);
  named.brief.fields.plays_on = { text: "a phone feed", by: "guessed", rev: 0 };
  checkpointStep(named, { kind: "board", video, rev: 4, now: T0, board: BOARD });
  answerStep(named, { input: { id: "C1", rev: 4, words: "Fine. Keep it vertical for my phone feed. Thanks.", read_as: "approve" }, video, rev: 4, now: T0 + 30_000, board: BOARD });
  assert.deepEqual([named.brief.fields.plays_on.named, named.brief.fields.plays_on.quote], ["portrait", "Keep it vertical for my phone feed."]);
});

test("rough passed on a revision also passes color on the same work; the board never merges", () => {
  const state = ready(5);
  checkpointStep(state, { kind: "rough", video: VIDEO, rev: 5, work: "W", now: T0 });
  answerStep(state, { input: { id: "C1", rev: 5, words: "looks good", read_as: "approve" }, video: VIDEO, rev: 5, work: "W", now: T0 + 30_000 });
  const color = checkpointStep(state, { kind: "color", video: VIDEO, rev: 5, work: "W", now: T0 + 40_000 });
  assert.match(color.text, /^C2 color passed with C1 rough: the person answered this same revision \(rev 5\) and nothing changed since\. Change the color first to ask it on its own\.$/);
  assert.deepEqual([state.stops[1].status, state.stops[1].covers], ["allowed", "C1"]);
  assert.equal(state.inbox.at(-1).text, color.text);
  // The merged round is reopened through the one it passed with.
  assert.match(refusal(() => reopenStep(state, { input: { id: "C2" }, now: T0 + 45_000 })).message, /C2 passed with C1: reopen C1 instead\./);
  // A sound stop with no music keeps its own question.
  assert.equal(refusal(() => checkpointStep(state, { kind: "sound", video: { ...VIDEO, music: false }, rev: 5, work: "W", now: T0 + 50_000, songSearch: true })).code, "music_first");
  // Other work asks on its own.
  assert.equal(checkpointStep(state, { kind: "sound", video: VIDEO, rev: 5, work: "other", now: T0 + 50_000 }).data.status, "waiting_for_you");
  // An approve with notes asked for changes: the next stop on the same work asks on its own.
  const notes = ready(5);
  checkpointStep(notes, { kind: "rough", video: VIDEO, rev: 5, work: "W", now: T0 });
  answerStep(notes, { input: { id: "C1", rev: 5, words: "ok, but the colors are too dark", read_as: "approve with notes" }, video: VIDEO, rev: 5, work: "W", now: T0 + 30_000 });
  assert.equal(checkpointStep(notes, { kind: "color", video: VIDEO, rev: 5, work: "W", now: T0 + 40_000 }).data.status, "waiting_for_you");
});

test("a stop ask prints the crop line the service filled", () => {
  const video = { ...VIDEO, cropLine: "Crops: 3 of 4 shots keep the face whole." };
  assert.match(stops.askText({ id: "C1", kind: "rough", video, checked: { errors: 0, warnings: 0 } }), /^Crops: 3 of 4 shots keep the face whole\.$/m);
});

test("the sound stop of a video with no music: the person's three choices, or 2 songs measured first", () => {
  const rules = stopRules({ "checkpoint-rough": "allow", "checkpoint-color": "allow" });
  const silent = { ...VIDEO, music: false };
  const upToSound = () => {
    const state = ready(4);
    for (const kind of ["rough", "color"]) checkpointStep(state, { kind, video: silent, rules, rev: 4, now: T0 });
    return state;
  };
  // No song search: the ask says so in one line, and a plain approval is recorded as silence by their call.
  const off = upToSound();
  const asked = checkpointStep(off, { kind: "sound", video: silent, rules, rev: 4, now: T0 });
  assert.match(asked.data.ask, /^No music yet: name a song or artist, send a track, or keep it silent\.$/m);
  const answered = answerStep(off, { input: { id: asked.data.id, rev: 4, words: "your call", read_as: "approve" }, video: silent, rules, rev: 4, now: T0 + 30_000 });
  assert.equal(answered.data.silent, "silent by the person's call");
  assert.match(answered.text, /never that they asked for silence/);
  // With music the ask has no such line.
  assert.doesNotMatch(checkpointStep(upToSound(), { kind: "sound", video: { ...VIDEO, music: true }, rules, rev: 4, now: T0 }).data.ask, /No music/);
  // Song search (YouTube, no Settings switch): refused until 2 songs are measured, with the next call.
  const on = upToSound();
  const error = refusal(() => checkpointStep(on, { kind: "sound", video: silent, rules, rev: 4, now: T0, songSearch: true }));
  assert.deepEqual([error.code, error.details.next], ["music_first", 'library {topic:"soundtrack", search:"<mood, tempo>"}']);
  on.soundtrack = { candidates: [{ id: "ov-a", measure: {} }, { id: "ov-b", measure: {} }] };
  assert.match(error.message, /waive_check \{code:"no_music"/, "a way out when the search finds nothing");
  // The agent's own no_music waiver (music "waived") holds while the search found songs, as in fp-10.
  const waived = { ...VIDEO, music: "waived" };
  on.soundtrack = { candidates: [{ id: "ov-a" }, { id: "ov-b" }] };
  assert.equal(refusal(() => checkpointStep(on, { kind: "sound", video: waived, rules, rev: 4, now: T0, soundSearch: true })).code, "music_first");
  on.soundtrack = { candidates: [] };
  assert.equal(checkpointStep(upToSound(), { kind: "sound", video: waived, rules, rev: 4, now: T0, soundSearch: true }).data.kind, "sound", "nothing found: the waiver stands");
  on.soundtrack = { candidates: [{ id: "ov-a", measure: {} }, { id: "ov-b", measure: {} }] };
  const picked = checkpointStep(on, { kind: "sound", video: silent, rules, rev: 4, now: T0, soundSearch: true });
  assert.match(picked.data.ask, /No music yet: 2 songs measured/);
  assert.match(answerStep(on, { input: { id: picked.data.id, rev: 4, words: "fine", read_as: "approve" }, video: silent, rules, rev: 4, now: T0 + 30_000 }).text, /silent by the person's call \(they picked none of the measured songs\)/);
  // Allowed by the settings: the reply still says why the video is silent.
  const allowed = upToSound();
  assert.match(checkpointStep(allowed, { kind: "sound", video: silent, rules: stopRules({ "checkpoint-rough": "allow", "checkpoint-color": "allow", "checkpoint-sound": "allow" }), rev: 4, now: T0 }).text, /^No music: silent because no track was sent and no song search is available\./m);
});

test("undoing \"stop asking\" makes the stops it allowed ask again; the stop the person answered stays passed", () => {
  const state = ready(4);
  const asked = checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  assert.deepEqual(asked.data.offer, ["color", "sound"]);
  answerStep(state, { input: { id: "C1", rev: 4, words: "stop asking", read_as: "stop-asking" }, video: VIDEO, rev: 4, now: T0 + 30_000 });
  assert.equal(checkpointStep(state, { kind: "color", video: VIDEO, rev: 4, now: T0 + 31_000 }).data.by, "chat");
  assert.deepEqual(stopPlan(state, VIDEO).map((entry) => entry.passed), [true, true, true, false]);

  keepAsking(state, { now: T0 + 40_000 });
  assert.equal(state.inbox.at(-1).text, 'you turned the rough, color and sound stops back on for this video (undid "stop asking" from C1)');
  assert.deepEqual(stopPlan(state, VIDEO).map((entry) => entry.passed), [true, true, false, false]);
  const again = checkpointStep(state, { kind: "color", video: VIDEO, rev: 4, now: T0 + 41_000 });
  assert.equal(again.data.status, "waiting_for_you");
  assert.deepEqual(again.data.offer, [], "only the first switchable stop offers \"stop asking\"");
  assert.equal(refusal(() => keepAsking(state, { now: T0 + 42_000 })).message, "Nothing to undo: stops were not turned off in chat for this video.");
});

test("too_fast uses the time the service measured on a steady clock when it has one", () => {
  const state = ready(4);
  checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  // The wall clock jumped back 2 s while 6 s really passed (WSL 2 steps its clock): the answer counts.
  const input = { id: "c1", rev: 4, words: "looks good", read_as: "Approve" };
  assert.equal(refusal(() => answerStep(state, { input, rev: 4, now: T0 + 4000 })).code, "too_fast");
  const answer = answerStep(state, { input, rev: 4, now: T0 + 4000, waited: 6000 });
  assert.equal(answer.data.afterSeconds, 6);
  assert.equal(state.stops[0].answer.words, "looks good");
  assert.equal(state.stops[0].answer.read_as, "approve");
});

test("the critique stop: the open critic lines wait as one ask; the person's fix or keep is their call, outside the video's stops", () => {
  const state = ready(4);
  assert.equal(refusal(() => checkpointStep(state, { kind: "critique", video: VIDEO, rev: 4, now: T0 })).code, "nothing_open");
  const lines = ["P0 t=6 · cut · the frame flashes → fade in over 0.3 s · the cut time"];
  const asked = checkpointStep(state, { kind: "critique", video: VIDEO, rev: 4, now: T0, critique: { sceneId: "s", scene: "s1", rev: 3, lines } });
  assert.equal(asked.data.status, "waiting_for_you");
  assert.match(asked.data.ask, /^A fresh critic still sees problems \(C1\): s1, 24 s[\s\S]*1\. P0 t=6[\s\S]*Reply: fix \(all, or the numbers\) · keep: <why they stay>$/);
  assert.equal(statusLines(state, VIDEO)[1], "step: end your turn until they answer");
  const answer = answerStep(state, { input: { id: "C1", rev: 4, words: "fix it", read_as: "redo" }, rev: 4, now: T0 + 30_000 });
  assert.match(answer.text, /step: make each change they asked for/);
  assert.deepEqual(personCall(state, "s", { rev: 3 }), { id: "C1", rev: 4, fix: true, words: "fix it" });
  assert.equal(stopPlan(state, VIDEO).some((entry) => entry.kind === "critique"), false, "not one of the video's ordered stops");
  assert.doesNotMatch(statusLines(state, VIDEO)[0], /C1/, "an answered critique round is not the status line");
});

test("the stop settings: ask or allow only, whole skip-under seconds, defaults for anything missing", () => {
  const settings = defaultSettings();
  assert.equal(settings.approvals["checkpoint-rough"], "ask");
  assert.deepEqual(stopRules(settings.approvals, settings.limits), { policy: { board: "ask", rough: "ask", color: "ask", sound: "ask" }, skipUnder: { board: 8, rough: 15, color: 15, sound: 15 } });
  assert.throws(() => mergeSettings(settings, { approvals: { "checkpoint-color": "deny" } }), { message: "A stop is ask or allow." });
  assert.throws(() => mergeSettings(settings, { limits: { skipSoundUnder: 3601 } }), { message: "The sound pass skip-under length is a whole number of seconds from 0 to 3600." });
  const changed = mergeSettings(settings, { approvals: { "checkpoint-color": "allow" }, limits: { skipBoardUnder: 0 } });
  assert.deepEqual(stopRules(changed.approvals, changed.limits).policy.color, "allow");
  assert.equal(stopRules(changed.approvals, changed.limits).skipUnder.board, 0);
  assert.deepEqual(stopRules({ "checkpoint-rough": "deny" }, { skipRoughUnder: -1 }).skipUnder.rough, 15);
});

// Review round 1 of B2a: a waiting stop that no longer stands is closed, so writes never stay
// refused for a stop nobody can answer.
test("a waiting stop the video no longer has is closed: shorter after an undo, a longer skip-under length, footage removed", () => {
  // The person undid the turn that made the video 24 s: it is 6 s at rev 5.
  const state = ready(4);
  assert.equal(checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 }).data.status, "waiting_for_you");
  const short = { ...VIDEO, seconds: 6 };
  const skipped = checkpointStep(state, { kind: "rough", video: short, rev: 5, now: T0 + 60_000 });
  assert.deepEqual(skipped.data, { status: "skipped", kind: "rough", reason: "under 15 s" });
  assert.equal(skipped.text, "rough skipped: this video is 6 s, under 15 s. C1 no longer waits.");
  assert.equal(waitingStop(state), null, "nothing waits, so the project's writes work again");
  assert.deepEqual([state.stops[0].status, state.stops[0].lapsedRev, state.stops[0].lapsedFor], ["lapsed", 5, "under 15 s"]);
  const stale = refusal(() => answerStep(state, { input: { id: "C1", rev: 4, words: "ok", read_as: "approve" }, video: short, rev: 5, now: T0 + 70_000 }));
  assert.equal(stale.code, "stale_rev");
  assert.equal(stale.message, "C1 no longer waits: this video has no rough stop now (under 15 s). Nothing to record; go on.");
  const [direction, next] = statusLines(state, short);
  assert.equal(direction, "direction: C1 rough lapsed · replies 0/10");
  assert.notEqual(next, "step: check, then ask rough again", "rough is not asked again: this video has no rough stop now");

  // The person raised the rough skip-under length to 30 s while C1 waited, at the same revision:
  // the next stop asked goes on from color.
  const longer = ready(4);
  checkpointStep(longer, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  const rules = stopRules({}, { skipRoughUnder: 30 });
  const color = checkpointStep(longer, { kind: "color", video: VIDEO, rules, rev: 4, now: T0 + 1000 });
  assert.equal(color.data.status, "waiting_for_you", color.text);
  assert.equal(color.data.id, "C2");
  assert.deepEqual(longer.stops.map((round) => [round.id, round.status, round.lapsedFor]), [["C1", "lapsed", "under 30 s"], ["C2", "waiting", undefined]]);

  // The storyboard waits; an undo makes the video 6 s, under its 8 s skip-under length.
  const board = ready(4);
  const footage = { ...VIDEO, footage: true };
  assert.equal(checkpointStep(board, { kind: "board", video: footage, rev: 4, now: T0, board: BOARD }).data.id, "C1");
  assert.equal(checkpointStep(board, { kind: "board", video: { ...footage, seconds: 6 }, rev: 5, now: T0 + 1000, board: BOARD }).text, "board skipped: this video is 6 s, under 8 s. C1 no longer waits.");
  assert.equal(waitingStop(board), null);
});

test("a graphics-only video of 8 s or more asks the storyboard; its title-card board is shown; a 6 s one skips it", () => {
  // stops.checkpointStep: the plain rules, not this file's board skip-under for videos with no footage.
  const graphics = { ...VIDEO, seconds: 20, footage: false };
  const asked = stops.checkpointStep(ready(4), { kind: "board", video: graphics, rev: 4, now: T0, board: boardOf({ seconds: 20 }) });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.match(asked.data.ask, /^The storyboard is ready \(C1\): 2 shots, 20 s/);
  assert.match(asked.data.ask, /Shot 1, 0–10 s: no footage; "Line 1" in Inter 700\./);
  const short = stops.checkpointStep(ready(4), { kind: "board", video: { ...graphics, seconds: 6 }, rev: 4, now: T0, board: boardOf({ seconds: 6 }) });
  assert.deepEqual(short.data, { status: "skipped", kind: "board", reason: "under 8 s" });
  // Without a board saved, the stop asks for one: kino never skips it for want of footage.
  assert.equal(refusal(() => stops.checkpointStep(ready(4), { kind: "board", video: graphics, rev: 4, now: T0 })).code, "board_first");
});

test("the brief's controls: a skip_under skips the board; rough set to go passes with an inbox line in the person's words; back to wait asks it again", () => {
  // stops.checkpointStep: the plain rules, so only the brief's controls skip the board here.
  const state = ready(4);
  state.brief.controls = { stops: { rough: "go" }, skipUnder: { board: 30 }, quote: "no storyboard or rough cut, just make it" };
  assert.deepEqual(stops.checkpointStep(state, { kind: "board", video: VIDEO, rev: 4, now: T0 }).data, { status: "skipped", kind: "board", reason: "under 30 s" });
  const went = stops.checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  assert.deepEqual([went.data.status, went.data.by], ["allowed", "controls"], went.text);
  assert.match(went.text, /^C1 rough allowed \(the person's controls\)/);
  assert.equal(state.inbox.at(-1).text, 'C1 rough goes on: the brief\'s controls say go ("no storyboard or rough cut, just make it").');
  state.brief.controls.stops.rough = "wait";
  assert.equal(stops.stopPlan(state, VIDEO).find((entry) => entry.kind === "rough").passed, false, "back to wait: the round no longer passes");
  assert.equal(stops.checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 + 60_000 }).data.status, "waiting_for_you");
});

test("a stop the person's settings now allow is allowed by them, and asking it again says it passed", () => {
  const state = ready(4);
  checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  const rules = stopRules({ "checkpoint-rough": "allow" }, {});
  const again = checkpointStep(state, { kind: "rough", video: VIDEO, rules, rev: 4, now: T0 + 90_000 });
  assert.deepEqual(again.data, { status: "passed", id: "C1", kind: "rough", rev: 4 });
  assert.equal(again.text, "C1 rough passed at rev 4 (allowed by the person's settings, 14:01); nothing changed since. Go on.");
  assert.deepEqual([state.stops[0].status, state.stops[0].allowedBy], ["allowed", "settings"]);
  assert.equal(waitingStop(state), null);
});

test("a storyboard the settings allow still waits while it carries a treatment pick only the person can make", () => {
  const state = ready(4);
  Object.assign(state.brief, { rev: 1, noPlayback: null });
  state.brief.treatments = cleanTreatments(["hook", "list", "loop", "split", "type"].map((idea, index) => ({ idea, move: "push in", rhythm: "fast", p: index / 5 })));
  const rules = stopRules({ "checkpoint-board": "allow" }, {});
  const video = { ...VIDEO, footage: true };
  const held = checkpointStep(state, { kind: "board", video, rules, rev: 4, now: T0, board: BOARD });
  assert.equal(held.data.status, "waiting_for_you");
  assert.match(held.data.ask, /Pick a direction[\s\S]*Your settings pass this stop: it waits only for the question above\.$/);
  // Picked: the next ask passes by the settings, as a stop with nothing to ask always did.
  state.brief.treatments = cleanTreatments({ pick: "A" }, state.brief.treatments);
  assert.equal(settleWaiting(state, { video, rules, rev: 4, board: BOARD }).status, "allowed");
});

// Review round 2 of B2a: only the person lets a stop pass. A brief that says no one can answer
// is the agent's own words, so every stop still asks, and saving it while a stop waits releases
// nothing.
test("a brief that says no one can answer lets no stop pass, and saving it while a stop waits releases nothing", () => {
  const state = ready(4);
  state.brief.noPlayback = { reason: "no one can answer", rev: 0 };
  const footage = { ...VIDEO, footage: true };
  const board = checkpointStep(state, { kind: "board", video: footage, rev: 4, now: T0, board: BOARD });
  assert.equal(board.data.status, "waiting_for_you", board.text);
  // A stop asked first; then the agent saves no_playback "no one can answer".
  const asked = ready(4);
  checkpointStep(asked, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  asked.brief.noPlayback = { reason: "No one can answer (eval run)", rev: 0 };
  assert.equal(settleWaiting(asked, { video: VIDEO, rev: 4, now: T0 + 1000 }), null, "nothing closes it");
  assert.equal(checkpointStep(asked, { kind: "rough", video: VIDEO, rev: 4, now: T0 + 1000 }).data.status, "waiting_for_you");
  assert.equal(waitingStop(asked).id, "C1");
  assert.deepEqual(statusLines(asked, VIDEO), ["direction: C1 rough waiting since 14:00 · replies 0/10", "step: end your turn until they answer"]);
});

// Review round 2 of B2a: "stop asking" switches off rough, color and sound only, so the
// storyboard never offers it, and an answer read as "stop asking" never passes a storyboard.
test("with footage the storyboard offers no \"stop asking\"; the rough cut offers color and sound", () => {
  const state = ready(4);
  const footage = { ...VIDEO, footage: true };
  const board = checkpointStep(state, { kind: "board", video: footage, rev: 4, now: T0, board: BOARD });
  assert.deepEqual(board.data.offer, []);
  assert.equal(board.data.ask.split("\n").at(-1), "Reply: approve · approve with notes: ... · redo: ...");
  const refused = refusal(() => answerStep(state, { input: { id: "C1", rev: 4, words: "looks good, stop asking", read_as: "stop asking" }, video: footage, rev: 4, now: T0 + 30_000, board: BOARD }));
  assert.equal(refused.code, "not_offered");
  assert.equal(refused.message, 'C1 did not offer "stop asking" (only the first of rough, color and sound does). Read their reply as approve, approve with notes or redo, or ask once what they meant.');
  assert.equal(waitingStop(state).id, "C1", "the storyboard still waits for the person");
  assert.equal(checkpointStep(state, { kind: "rough", video: footage, rev: 4, now: T0 + 31_000 }).data.waiting, "C1", "rough waits for the storyboard's answer");
  answerStep(state, { input: { id: "C1", rev: 4, words: "ok", read_as: "approve" }, video: footage, rev: 4, now: T0 + 32_000, board: BOARD });
  const rough = checkpointStep(state, { kind: "rough", video: footage, rev: 4, now: T0 + 33_000 });
  assert.deepEqual(rough.data.offer, ["color", "sound"]);
  answerStep(state, { input: { id: "C2", rev: 4, words: "stop asking", read_as: "stop asking" }, video: footage, rev: 4, now: T0 + 60_000 });
  for (const kind of ["color", "sound"]) assert.equal(checkpointStep(state, { kind, video: footage, rev: 4, now: T0 + 61_000 }).data.by, "chat", kind);
  // A storyboard round read as "stop asking" (saved by an older kino) is no approval.
  const old = ready(4);
  old.stops.push({ id: "C1", kind: "board", rev: 4, askedAt: new Date(T0).toISOString(), status: "answered", offer: ["rough"], ask: "…",
    answer: { via: "chat", words: "stop asking", read_as: "stop asking", at: new Date(T0 + 30_000).toISOString(), client: null, afterSeconds: 30 } });
  assert.deepEqual(stopPlan(old, footage).map((entry) => entry.passed), [false, false, false, false]);
});

// Review round 2 of B2a: moving the project to Trash and back, or renaming it, raises the
// revision but leaves the work as it was: the stop still waits, and the answer still counts.
test("a stop still waits when only the revision moved, not the work; a change to the work lapses it", () => {
  const document = { version: 1, id: "p", name: "Launch", scenes: [{ id: "s1", duration: 24, layers: [] }] };
  const work = workPrint(document);
  assert.equal(workPrint({ ...document, name: "Launch v2" }), work, "a new name is the same work");
  assert.notEqual(workPrint({ ...document, scenes: [{ id: "s1", duration: 20, layers: [] }] }), work);
  const state = ready(4);
  checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, work, now: T0 });
  assert.equal(state.stops[0].work, work);
  assert.equal(settleWaiting(state, { video: VIDEO, rev: 6, work, now: T0 + 1000 }), null, "Trash and back: rev 6, same work");
  const answer = answerStep(state, { input: { id: "C1", rev: 4, words: "looks good", read_as: "approve" }, video: VIDEO, rev: 6, work, now: T0 + 30_000 });
  assert.equal(answer.data.passed, true);
  const changed = ready(4);
  checkpointStep(changed, { kind: "rough", video: VIDEO, rev: 4, work, now: T0 });
  const stale = refusal(() => answerStep(changed, { input: { id: "C1", rev: 4, words: "ok", read_as: "approve" }, video: VIDEO, rev: 5, work: "another", now: T0 + 30_000 }));
  assert.equal(stale.code, "stale_rev");
  assert.equal(changed.stops[0].status, "lapsed");
});

// Plan §12: a notes checkpoint answer, its ask included, is at most 200 tokens for rough, color
// and sound, and for the storyboard (B4a: kino lists the shots) 120 plus 35 a shot listed, plus
// the fresh-eyes line (B4b: "not reported" on the video's first storyboard ask).
test("waiting_for_you answers fit plan §12: 120 plus 35 a shot listed for the storyboard, 200 for the others", () => {
  let widest = { board: "", other: "" };
  for (const kind of ["board", "rough", "color", "sound"]) for (const footage of [false, true]) for (const number of [1, 99, 999]) for (const rev of [1, 99999]) for (const shots of kind === "board" ? [1, 4, 30] : [0]) {
    if (kind === "board" && !footage) continue;
    const state = ready(rev);
    state.nextStop = number;
    // Every earlier kind passed, so this one is asked: the first one asked carries the offer.
    const video = { seconds: 123.5, layers: 9, footage, width: 3840, height: 2160 };
    const board = boardOf({ seconds: 123.5, shots: Math.max(shots, 1), width: 3840, height: 2160 });
    const kinds = ["board", "rough", "color", "sound"].filter((entry) => footage || entry !== "board");
    for (const earlier of kinds.slice(0, kinds.indexOf(kind))) {
      const round = { id: `C0${earlier}`, kind: earlier, rev, status: "allowed", allowedBy: "settings" };
      state.stops.push(round);
      if (earlier === "board") freezeBoard(state, round, { board, by: "settings", now: T0 });
    }
    state.checked = { rev, errors: 0, warnings: 12 };
    const answer = checkpointStep(state, { kind, video, rev, now: T0, board });
    assert.equal(answer.data.status, "waiting_for_you", answer.text);
    const limit = kind === "board" ? ASK_TOKENS + SHOT_TOKENS * Math.min(shots, ASK_SHOTS) + FRESH_TOKENS : 200;
    assert.ok(estimateTextTokens(answer.text) <= limit, `${kind}: about ${estimateTextTokens(answer.text)} tokens (limit ${limit}):\n${answer.text}`);
    const slot = kind === "board" ? "board" : "other";
    if (answer.text.length > widest[slot].length) widest[slot] = answer.text;
  }
  for (const [slot, text] of Object.entries(widest)) console.log(`${slot}: widest waiting_for_you ${text.length} characters, about ${estimateTextTokens(text)} tokens:\n${text}`);
});

test("before any stop, status names the first stop to ask once the brief is settled", () => {
  const state = ready(4);
  assert.deepEqual(statusLines(state, VIDEO), ["direction: no brief lines, no playback · replies 0/10", "step: save ask and about"], "the brief comes first");
  const fields = Object.fromEntries(["message", "plays_on", "made_from", "look_sound", "never", "about"].map((name) => [name, { text: "x", by: "guessed" }]));
  state.brief = { ...state.brief, rev: 1, fields: withAsk(fields) };
  assert.equal(statusLines(state, VIDEO)[1], "step: write 5 treatments", "the idea comes before the plan (T3)");
  const IDEA = { ...VIDEO, treatmentsWaived: true };
  assert.equal(statusLines(state, IDEA)[1], "step: notes set_plan, build, then ask rough");
  // The storyboard comes before building (plan §2, §5).
  // It reminds the agent to board a move per shot (craft plan section 3).
  assert.equal(statusLines(state, { ...IDEA, footage: true })[1], 'step: notes set_plan, board a move per shot (library {topic:"moves"}), ask board, then build');
  assert.equal(statusLines(state, { ...IDEA, seconds: 12 })[1], "step: notes set_plan, then build", "a 12 s video without footage has no stop");
  state.plan = { steps: [{ text: "Build", done: true }] };
  assert.equal(statusLines(state, IDEA)[1], "step: follow the plan, then ask rough");
  assert.equal(statusLines(state, { ...IDEA, footage: true })[1], "step: ask board, then follow the plan");
  state.brief.noPlayback = { reason: "no one can answer", rev: 1 };
  assert.equal(statusLines(state, IDEA)[1], "step: follow the plan, then ask rough", "the person still answers the stops");
  for (const lines of [statusLines(state, IDEA), statusLines({ ...state, brief: { ...state.brief, noPlayback: { reason: "just start" } } }, { ...IDEA, footage: true })])
    assert.ok(estimateTextTokens(lines.join("\n")) <= 40, lines.join("\n"));
});

test("a clip imported into the project but not placed yet is footage: the board asks before the build; short videos still skip", () => {
  const document = (seconds, layers = [{ type: "audio" }]) => ({ id: "p1", scenes: [{ id: "s", width: 1080, height: 1920, duration: seconds, layers }] });
  const media = [{ id: "m1", mime: "video/mp4", projectId: "p1" }, { id: "m2", mime: "video/mp4", projectId: "other", usedInProjects: ["p1"] }];
  assert.equal(videoFacts(document(24)).footage, false, "no library: only placed video layers count");
  assert.equal(videoFacts(document(24), media.slice(1)).footage, false, "a clip uploaded elsewhere, even once used here, is not this video's");
  assert.equal(videoFacts(document(24), [{ ...media[0], hasVideo: false }]).footage, false, "a sound-only file is not footage");
  assert.equal(videoFacts(document(24, [{ type: "text" }]), media).footage, false, "built, its clips removed: no footage, so a waiting board lapses");
  const imported = { ...videoFacts(document(24), media), treatmentsWaived: true };
  assert.equal(imported.footage, true);
  const state = ready(4);
  state.brief = { ...state.brief, rev: 1, fields: withAsk(Object.fromEntries(["message", "plays_on", "made_from", "look_sound", "never", "about"].map((name) => [name, { text: "x", by: "guessed" }]))) };
  assert.equal(statusLines(state, imported)[1], 'step: notes set_plan, board a move per shot (library {topic:"moves"}), ask board, then build');
  assert.equal(stopPlan(state, videoFacts(document(6), media))[0].skipped, "under 8 s");
});

// ---- B2b: answers on the dashboard's stop card, and reopen ----------------------------------

// A state with C1 rough waiting at rev 4, asked at T0 by claude-code.
function asking(kind = "rough", rev = 4) {
  const state = ready(rev);
  checkpointStep(state, { kind, video: VIDEO, rev, now: T0, client: "claude-code" });
  return state;
}
const answerOn = (state, input, more = {}) => dashboardAnswerStep(state, { input: { id: "C1", rev: 4, ...input }, video: VIDEO, rev: 4, now: T0 + 42_000, ...more });

test("a dashboard answer is saved as via dashboard, the agent hears it in its inbox, and the stop passes or asks again", () => {
  for (const [input, words, line, passed] of [
    [{ read_as: "approve" }, null, "C1 rough approved by the person in kino. Go on.", true],
    [{ read_as: "approve with notes", words: "  warmer  " }, "warmer", 'C1 rough approved by the person in kino, with notes: "warmer". Make those changes, then go on.', true],
    [{ read_as: "redo", words: "the title is too small" }, "the title is too small", 'C1 rough: the person asked for a redo in kino: "the title is too small". Fix only what they named, check, then ask again: notes {action:"checkpoint", id:"rough"}.', false],
  ]) {
    const state = asking();
    const summary = answerOn(state, input, { waited: 41_600 });
    assert.deepEqual(state.stops[0].answer, { via: "dashboard", words, read_as: input.read_as, at: new Date(T0 + 42_000).toISOString(), client: "dashboard", afterSeconds: 41 });
    assert.equal(state.stops[0].status, "answered");
    assert.deepEqual(state.inbox, [{ kind: "stop", stopId: "C1", text: line }], "stopId: the call that takes it marks the answer heard");
    assert.equal(state.turnBreak, true, "the agent's next call starts a new turn");
    assert.equal(waitingStop(state), null, "writes work again");
    assert.deepEqual(summary, stopsSummary(state));
    assert.equal(stopPlan(state, VIDEO)[1].passed, passed, input.read_as);
    assert.equal(statusLines(state, VIDEO)[0], `direction: C1 rough ${{ approve: "approved", "approve with notes": "approved (notes)", redo: "redo" }[input.read_as]} · replies 1/10`, "it counts as a reply");
    // The agent records the same reply from the chat: already answered, in kino.
    const again = refusal(() => answerStep(state, { input: { id: "C1", rev: 4, words: "ok", read_as: "approve" }, video: VIDEO, rev: 4, now: T0 + 60_000 }));
    assert.deepEqual([again.code, again.message], ["answered", `C1 is already answered (${input.read_as} in kino, 14:00). If they changed their mind, make the change and ask again.`]);
  }
  // Without a steady clock: the time since askedAt, never below 0 (the wall clock went back).
  const back = asking();
  answerOn(back, { read_as: "approve" }, { now: T0 - 3000 });
  assert.equal(back.stops[0].answer.afterSeconds, 0);
  // read_as as the dashboard or a person might write it.
  const loose = asking();
  answerOn(loose, { read_as: "Approve_With-Notes", words: "ok" });
  assert.equal(loose.stops[0].answer.read_as, "approve with notes");
});

test("a dashboard answer refuses bad input with the messages the dashboard shows (400, 404)", () => {
  const cases = [
    [{ id: "" }, "bad_input", "Choose a stop: id is its C id, such as C2."],
    [{ id: 2 }, "bad_input", "Choose a stop: id is its C id, such as C2."],
    [{ id: "C9" }, "not_found", "kino never asked C9 in this project."],
    [{ read_as: "ok" }, "bad_input", "read_as is approve, approve with notes or redo."],
    [{ read_as: "stop asking" }, "bad_input", '"Stop asking" is said in the chat. In kino, set a stop to allow in settings.'],
    [{ read_as: "approve", words: "warmer" }, "bad_input", "approve takes no note: send approve with notes."],
    [{ read_as: "approve with notes" }, "bad_input", "approve with notes needs a note (1–2000 characters)."],
    [{ read_as: "approve with notes", words: "   " }, "bad_input", "approve with notes needs a note (1–2000 characters)."],
    [{ read_as: "approve with notes", words: "x".repeat(2001) }, "bad_input", "approve with notes needs a note (1–2000 characters)."],
    [{ read_as: "redo", words: "" }, "bad_input", "A redo needs a note: say what to change (1–2000 characters)."],
    [{ read_as: "redo", words: 7 }, "bad_input", "A redo needs a note: say what to change (1–2000 characters)."],
    [{ read_as: "approve", rev: "4" }, "bad_input", "rev is the revision C1 showed (rev 4)."],
  ];
  for (const [input, code, message] of cases) {
    const state = asking();
    const error = refusal(() => answerOn(state, input));
    assert.deepEqual([error.code, error.message], [code, message], JSON.stringify(input));
    assert.equal(waitingStop(state).id, "C1", "nothing was saved");
    assert.deepEqual(state.inbox, []);
  }
  // Empty words with approve is no note; 2,000 characters is a note.
  answerOn(asking(), { read_as: "approve", words: " " });
  answerOn(asking(), { read_as: "redo", words: "x".repeat(2000) });
});

test("a dashboard answer to a stop that no longer waits is refused (409), and a stop it closed comes with the refusal", () => {
  const conflict = (state, input, more) => refusal(() => answerOn(state, { read_as: "approve", ...input }, more));
  // Answered in the chat, on the dashboard, allowed by settings or by "stop asking".
  const chat = asking();
  answerStep(chat, { input: { id: "C1", rev: 4, words: "looks good", read_as: "approve" }, video: VIDEO, rev: 4, now: T0 + 30_000 });
  let error = conflict(chat);
  assert.deepEqual([error.code, error.message, error.details], ["not_waiting", "C1 no longer waits: it is already answered (approve, in chat).", {}]);
  const twice = asking();
  answerOn(twice, { read_as: "redo", words: "bigger" });
  assert.equal(conflict(twice).message, "C1 no longer waits: it is already answered (redo, on the dashboard).");
  const allowed = asking();
  const rules = stopRules({ "checkpoint-rough": "allow" }, {});
  error = conflict(allowed, {}, { rules });
  assert.deepEqual([error.code, error.message], ["not_waiting", "C1 no longer waits: your settings allow the rough cut now."]);
  assert.deepEqual(error.details.stops, stopsSummary(allowed), "settling closed it: the dashboard hears that");
  assert.equal(conflict(allowed, {}, { rules }).message, "C1 no longer waits: your settings allow the rough cut now.", "also once it is closed");
  assert.deepEqual(conflict(allowed, {}, { rules }).details, {}, "nothing changed this time");
  const chatAllowed = ready(4);
  chatAllowed.stopAsking = { stop: "C0", words: "stop asking", at: new Date(T0).toISOString(), client: null, undoneAt: null };
  checkpointStep(chatAllowed, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  assert.equal(conflict(chatAllowed).message, 'C1 no longer waits: it is already answered (allowed by "stop asking").');

  // The work changed under it (the person undid a turn): lapsed, and the dashboard hears it.
  const moved = asking();
  error = conflict(moved, {}, { rev: 5 });
  assert.deepEqual([error.code, error.message], ["not_waiting", "C1 no longer waits: the work changed after it was asked (rev 4, now rev 5). The agent asks again."]);
  assert.equal(moved.stops[0].status, "lapsed");
  assert.equal(error.details.stops.waiting, null);
  // The video is now shorter than the rough cut's skip-under length.
  const short = asking();
  error = conflict(short, {}, { video: { ...VIDEO, seconds: 9 }, rev: 5 });
  assert.equal(error.message, "C1 no longer waits: this video has no rough cut stop now (under 15 s).");
  // Reopened; and a revision the person was not shown.
  const reopened = asking();
  answerOn(reopened, { read_as: "approve" });
  reopenStep(reopened, { input: { id: "C1" }, now: T0 + 50_000 });
  assert.equal(conflict(reopened).message, "C1 was reopened: the agent asks again with a new id.");
  const stale = asking();
  error = conflict(stale, { rev: 3 });
  assert.deepEqual([error.code, error.message], ["stale_rev", "C1 showed rev 4, not rev 3: look again."]);
  assert.equal(waitingStop(stale).id, "C1", "it still waits");
});

test("reopen: the round no longer passes, the agent hears why and asks again with a new id", () => {
  const state = asking();
  answerStep(state, { input: { id: "C1", rev: 4, words: "approve but make the title a little bigger", read_as: "approve with notes" }, video: VIDEO, rev: 4, now: T0 + 30_000 });
  const summary = reopenStep(state, { input: { id: "c1" }, now: T0 + 90_000 });
  const round = state.stops[0];
  assert.deepEqual([round.status, round.reopenedAt, round.answer.words], ["reopened", new Date(T0 + 90_000).toISOString(), "approve but make the title a little bigger"], "the answer is kept");
  const { ask, ...shown } = round;
  assert.deepEqual(summary.rounds[0], shown, "the dashboard sees the reopened round and its answer");
  assert.deepEqual(state.inbox, [{ kind: "stop", text: 'C1 rough reopened by the person in kino: your record "approve but make the title a little bigger" (approve with notes) is not what they meant. Ask again: notes {action:"checkpoint", id:"rough"}.' }]);
  assert.equal(state.turnBreak, true);
  assert.equal(waitingStop(state), null, "writes are not refused meanwhile");
  assert.deepEqual(statusLines(state, VIDEO), ["direction: C1 rough reopened · replies 1/10", "step: check, then ask rough again"]);
  // The agent records the reply again: refused. A later stop: out_of_order.
  const again = refusal(() => answerStep(state, { input: { id: "C1", rev: 4, words: "ok", read_as: "approve" }, video: VIDEO, rev: 4, now: T0 + 95_000 }));
  assert.deepEqual([again.code, again.message], ["reopened", 'C1 was reopened by the person in kino. Ask again: notes {action:"checkpoint", id:"rough"}.']);
  assert.equal(refusal(() => checkpointStep(state, { kind: "color", video: VIDEO, rev: 4, now: T0 + 96_000 })).code, "out_of_order");
  const asked = checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 + 97_000 });
  assert.deepEqual([asked.data.status, asked.data.id], ["waiting_for_you", "C2"]);
  assert.deepEqual(asked.data.offer, ["color", "sound"]);
  // C1 is now an older round of the rough cut.
  const newer = refusal(() => reopenStep(state, { input: { id: "C1" }, now: T0 + 98_000 }));
  assert.deepEqual([newer.code, newer.message], ["not_answered", "C1 is already reopened."]);

  // A long chat record is cut to 200 characters in the inbox line.
  const long = asking();
  answerStep(long, { input: { id: "C1", rev: 4, words: "y".repeat(500), read_as: "approve" }, video: VIDEO, rev: 4, now: T0 + 30_000 });
  reopenStep(long, { input: { id: "C1" }, now: T0 + 40_000 });
  assert.ok(long.inbox[0].text.includes(`"${"y".repeat(200)}…"`), long.inbox[0].text);
});

test("reopen of a dashboard answer takes it back; reopen of \"stop asking\" turns the stops back on", () => {
  const mine = asking();
  answerOn(mine, { read_as: "approve" });
  mine.inbox = [];
  reopenStep(mine, { input: { id: "C1" }, now: T0 + 60_000 });
  assert.deepEqual(mine.inbox, [{ kind: "stop", text: 'C1 rough reopened by the person in kino: they take back their answer (approve). Ask again: notes {action:"checkpoint", id:"rough"}.' }]);

  const stopped = asking();
  answerStep(stopped, { input: { id: "C1", rev: 4, words: "stop asking, just make it", read_as: "stop asking" }, video: VIDEO, rev: 4, now: T0 + 30_000 });
  assert.equal(checkpointStep(stopped, { kind: "color", video: VIDEO, rev: 4, now: T0 + 31_000 }).data.by, "chat");
  // C2 color was allowed by "stop asking": keep asking undoes that, not reopen.
  const viaChat = refusal(() => reopenStep(stopped, { input: { id: "C2" }, now: T0 + 32_000 }));
  assert.deepEqual([viaChat.code, viaChat.message], ["not_answered", 'C2 was allowed by "stop asking": use keep asking.']);
  reopenStep(stopped, { input: { id: "C1" }, now: T0 + 33_000 });
  assert.equal(stopped.stopAsking.undoneAt, new Date(T0 + 33_000).toISOString());
  assert.equal(stopped.inbox.at(-1).text, 'C1 rough reopened by the person in kino: your record "stop asking, just make it" (stop asking) is not what they meant. Ask again: notes {action:"checkpoint", id:"rough"}. Rough, color and sound ask again for this video.');
  assert.deepEqual(stopPlan(stopped, VIDEO).map((entry) => entry.passed), [true, false, false, false], "rough, color and sound ask again");
  assert.equal(checkpointStep(stopped, { kind: "rough", video: VIDEO, rev: 4, now: T0 + 34_000 }).data.status, "waiting_for_you");
});

test("reopen refuses what is not an answer it can take back", () => {
  const reopen = (state, id) => refusal(() => reopenStep(state, { input: { id }, now: T0 + 60_000 }));
  const state = asking();
  assert.deepEqual([reopen(state, "C1").code, reopen(state, "C1").message], ["not_answered", "C1 is not answered yet: answer it instead."]);
  assert.deepEqual([reopen(state, "C7").code, reopen(state, "C7").message], ["not_found", "kino never asked C7 in this project."]);
  assert.deepEqual([reopen(state, " ").code, reopen(state, " ").message], ["bad_input", "Choose a stop: id is its C id, such as C2."]);
  settleWaiting(state, { video: VIDEO, rev: 5, now: T0 + 1000 });
  assert.equal(reopen(state, "C1").message, "C1 lapsed: nothing to reopen.");
  const allowed = ready(4);
  checkpointStep(allowed, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
  allowed.stops.push({ id: "C2", kind: "color", rev: 4, askedAt: new Date(T0).toISOString(), status: "allowed", allowedBy: "settings", offer: [], ask: null, answer: null });
  assert.equal(reopen(allowed, "C2").message, "C2 was allowed by your settings: set the color pass to ask in settings.");
  // A redo, then the rough cut asked again: only the newest round of a kind can be reopened.
  const redone = asking();
  answerOn(redone, { read_as: "redo", words: "bigger" });
  checkpointStep(redone, { kind: "rough", video: VIDEO, rev: 4, now: T0 + 50_000 });
  answerOn(redone, { id: "C2", read_as: "approve" });
  const newer = reopen(redone, "C1");
  assert.deepEqual([newer.code, newer.message], ["superseded", "C1 has a newer round (C2) of the rough cut: reopen that one."]);
});

test("reopening an earlier stop while a later one waits closes the later one: the agent asks again in order", () => {
  // C1 rough approved on the dashboard; after a check at rev 5 the agent asks color: C2 waits.
  const state = asking();
  answerOn(state, { read_as: "approve" });
  state.checked = { ...state.checked, rev: 5 };
  assert.equal(checkpointStep(state, { kind: "color", video: VIDEO, rev: 5, now: T0 + 60_000 }).data.id, "C2");
  state.inbox = [];
  const summary = reopenStep(state, { input: { id: "C1" }, now: T0 + 70_000 });
  assert.deepEqual(state.stops.map((round) => [round.id, round.status, round.lapsedBy ?? null]), [["C1", "reopened", null], ["C2", "lapsed", "C1"]]);
  assert.equal(summary.waiting, null, "nothing waits: the color pass built on the rough cut reopened");
  assert.deepEqual(state.inbox, [{ kind: "stop", text: 'C1 rough reopened by the person in kino: they take back their answer (approve). C2 color no longer waits. Ask again: notes {action:"checkpoint", id:"rough"}.' }]);
  assert.deepEqual(statusLines(state, VIDEO), ["direction: C1 rough reopened · replies 1/10", "step: check, then ask rough again"]);
  // The person cannot approve C2 now, nor the agent record it; asking rough again is what works.
  const dash = refusal(() => dashboardAnswerStep(state, { input: { id: "C2", rev: 5, read_as: "approve" }, video: VIDEO, rev: 5, now: T0 + 71_000 }));
  assert.deepEqual([dash.code, dash.message], ["not_waiting", "C2 no longer waits: you reopened C1. The agent asks again."]);
  const chat = refusal(() => answerStep(state, { input: { id: "C2", rev: 5, words: "ok", read_as: "approve" }, video: VIDEO, rev: 5, now: T0 + 72_000 }));
  assert.deepEqual([chat.code, chat.message], ["reopened", 'C2 no longer waits: the person reopened C1 in kino. Ask again: notes {action:"checkpoint", id:"rough"}.']);
  assert.equal(refusal(() => checkpointStep(state, { kind: "color", video: VIDEO, rev: 5, now: T0 + 73_000 })).code, "out_of_order");
  const again = checkpointStep(state, { kind: "rough", video: VIDEO, rev: 5, now: T0 + 74_000 });
  assert.deepEqual([again.data.status, again.data.id], ["waiting_for_you", "C3"]);

  // A rough cut asked again (C3 waits) after the color pass C2 was approved: reopening C2 closes
  // C3, and the agent asks the rough cut, the earlier of the two, first.
  const back = asking();
  answerOn(back, { read_as: "approve" });
  checkpointStep(back, { kind: "color", video: VIDEO, rev: 4, now: T0 + 50_000 });
  answerOn(back, { id: "C2", read_as: "approve" }, { now: T0 + 60_000 });
  back.checked = { ...back.checked, rev: 5 };
  assert.equal(checkpointStep(back, { kind: "rough", video: VIDEO, rev: 5, now: T0 + 70_000 }).data.id, "C3");
  back.inbox = [];
  reopenStep(back, { input: { id: "C2" }, now: T0 + 80_000 });
  assert.equal(back.stops[2].lapsedBy, "C2");
  assert.equal(back.inbox[0].text, 'C2 color reopened by the person in kino: they take back their answer (approve). C3 rough no longer waits. Ask again: notes {action:"checkpoint", id:"rough"}.');
});

test("the waiting stop in the dashboard's summary carries its ask, offer and client", () => {
  const state = asking();
  const round = state.stops[0];
  assert.deepEqual(stopsSummary(state).waiting, { id: "C1", kind: "rough", rev: 4, askedAt: round.askedAt, client: "claude-code", ask: round.ask, offer: ["color", "sound"] });
  const old = ready(4);
  old.stops.push({ id: "C1", kind: "rough", rev: 4, askedAt: round.askedAt, status: "waiting", ask: "…", answer: null });
  assert.deepEqual(stopsSummary(old).waiting, { id: "C1", kind: "rough", rev: 4, askedAt: round.askedAt, client: null, ask: "…", offer: [] }, "a round saved without client or offer");
});

// Plan §12: status's two direction lines are at most 40 tokens in every round state; the inbox
// lines of B2b are small too (design G4).
test("status lines stay within 40 tokens in every round state, reopened included; the inbox lines are small", () => {
  const rounds = [];
  const video = { ...VIDEO, seconds: 3599.5, footage: true };
  const at = new Date(T0).toISOString();
  const answer = (via, read_as) => ({ via, words: via === "dashboard" && read_as === "approve" ? null : "w", read_as, at, client: via === "dashboard" ? "dashboard" : "claude-code", afterSeconds: 42 });
  for (const kind of ["board", "rough", "color", "sound"]) for (const round of [
    { status: "waiting" }, { status: "lapsed", lapsedRev: 5 }, { status: "lapsed", lapsedFor: "under 15 s" },
    { status: "allowed", allowedBy: "settings" }, { status: "allowed", allowedBy: "chat" },
    ...["approve", "approve with notes", "redo", "stop asking"].flatMap((read) => [{ status: "answered", answer: answer("chat", read) }, { status: "answered", answer: answer("dashboard", read) }]),
    { status: "reopened", reopenedAt: at, answer: answer("chat", "approve with notes") },
  ]) rounds.push({ id: "C999", kind, rev: 99999, askedAt: at, offer: [], ask: null, ...round });
  let widest = "";
  for (const round of rounds) {
    const state = ready(99999);
    state.brief.log = Array.from({ length: 9 }, () => ({ kind: "question" }));
    state.stops = [round];
    const lines = statusLines(state, video).join("\n");
    assert.ok(estimateTextTokens(lines) <= 40, `${round.status}: about ${estimateTextTokens(lines)} tokens:\n${lines}`);
    if (estimateTextTokens(lines) > estimateTextTokens(widest)) widest = lines;
  }
  console.log(`widest status direction lines, about ${estimateTextTokens(widest)} tokens:\n${widest}`);

  const lines = [];
  for (const input of [{ read_as: "approve" }, { read_as: "approve with notes", words: "warmer" }, { read_as: "redo", words: "the ding is too loud" }, { read_as: "redo", words: "x".repeat(2000) }]) {
    const state = ready(4);
    state.nextStop = 999;
    checkpointStep(state, { kind: "rough", video: VIDEO, rev: 4, now: T0 });
    dashboardAnswerStep(state, { input: { id: "C999", rev: 4, ...input }, video: VIDEO, rev: 4, now: T0 + 9000 });
    reopenStep(state, { input: { id: "C999" }, now: T0 + 10_000 });
    lines.push(...state.inbox.map((item) => item.text));
  }
  for (const line of lines) assert.ok(estimateTextTokens(line) < 1000, line);
  console.log(`B2b inbox lines, about ${lines.map((line) => estimateTextTokens(line)).join(", ")} tokens`);
});
