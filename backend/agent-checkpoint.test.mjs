// The stop rules on the server (direction plan §6, milestone B2a). A stop (notes checkpoint) is
// asked only after the brief and a full check of the revision it shows, in the order board,
// rough, color, sound, and only for the stops this video has (no footage: no board; under 15 s:
// no rough, color or sound). It answers waiting_for_you at once; until the person's reply is
// recorded with notes answer, writes to that project answer {waiting:"C1"} and change nothing,
// while reads, look, check and notes still work. Allowed and skipped stops count as passed. kino
// refuses an answer under 5 s after the ask, to an id it never issued, to a revision the person
// was not shown, and to a render approval (those are answered in kino). "Stop asking" sets rough,
// color and sound to allow for this video, with an undo on the dashboard. Stops are saved in the
// project's agent-state file and survive a restart; a hold wins over a stop; two agents asking at
// once get one stop.
//
// Every project here has no footage. A recorded answer needs a real wait (gap(), six in the file).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { READ_AS, STOP_KINDS } from "./agent/stops.mjs";
import { STEP_NAMES } from "./agent/step-log.mjs";
import { estimateTextTokens } from "./meter.mjs";
import { nextCallOf, startTestServer, withoutNext } from "./media.test.support.mjs";
import { BOARD_SKIP_UNDER, skipBoardOn, statusLines } from "./stops.test.support.mjs";

let server;
let key;
before(async () => {
  server = await startTestServer();
  key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
  // These tests are about rough, color and sound: the storyboard, asked for every video of 8 s
  // or more since 2026-11-11, is skipped by the person's board skip-under (stops.test.support.mjs).
  await skipBoardOn(server);
});
after(() => server?.stop());

async function agent(verb, body = {}, on = server) {
  const response = await on.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function dashboard(route, { method = "POST", body, review = true } = {}) {
  const response = await server.api(`/api/dashboard/${route}`, { method, body, headers: review && method !== "GET" ? { "x-kino-review": key } : {} });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const setting = (body) => dashboard("settings", { method: "PUT", body });
const revision = async (project) => (await (await server.api(`/api/projects/${project}`)).json()).revision;
const statusOf = async (project, on = server) => {
  const reply = await agent("status", { project }, on);
  return { lines: reply.text.split("\n").slice(1, 3), data: reply.data };
};
// The project's agent-state file, where stops are kept.
const savedState = async (project, folder = server.dataDirectory) => JSON.parse(await readFile(path.join(folder, "agent", "projects", `${project}.json`), "utf8"));
// A saved round as the design's F2 shape has it: without `steady`, the service's own clock stamp
// for too_fast (milliseconds since boot, so it holds across a restart; never shown), and `work`,
// the fingerprint of the work it showed (review round 2; never shown).
const designShape = ({ steady, work, ...round }) => round;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;

// The fixture the design measured: a 24 s 1080×1920 card with one 96 px title passes check with
// 0 errors and 2 warnings; at 24 px the title is one error (type_min).
const TITLE = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
const move = (y) => ({ op: "update_layer", layer: "title", properties: { y } });
const fontSize = (size) => ({ op: "update_layer", layer: "title", properties: { fontSize: size } });

// The reference step and gate are tested in agent-brief and agent-review; these stops tests waive them.
const REF_WAIVER = { op: "waive_check", code: "reference", target: "*", reason: "a stops test" };
const TREATMENTS_WAIVER = { ...REF_WAIVER, code: "treatments" };
// A project with no footage: the fixture, a brief settled with no playback ("just start"), and
// the agent's full check of its revision, unless told otherwise.
async function stopProject(id, { seconds = 24, brief = true, check = true, on = server } = {}) {
  const made = await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: seconds, background: "#101820" }, on);
  assert.equal(made.isError, undefined, made.text);
  const edited = await agent("edit", { project: id, ops: [TITLE, REF_WAIVER, TREATMENTS_WAIVER] }, on);
  assert.equal(edited.isError, undefined, edited.text);
  if (brief) assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" }, on)).isError, undefined);
  const checked = check ? await agent("check", { project: id }, on) : null;
  if (checked) assert.equal(checked.data.errors, 0, checked.text);
  // The setup's agent is done with what it made: it lets go of the parts it holds (crew locks),
  // so the agents in each test can change them.
  await agent("notes", { project: id, action: "release" }, on);
  return { rev: edited.data.rev, turn: edited.data.turn, checked: checked?.data };
}

// notes checkpoint. `at` is when its answer came back, on the steady clock: the ask was saved
// before that.
async function checkpoint(project, kind, body = {}, on = server) {
  const reply = await agent("notes", { project, action: "checkpoint", ...(kind === undefined ? {} : { id: kind }), ...body }, on);
  return { ...reply, at: performance.now() };
}
// look review until every moment is reviewed: a final render of a whole video needs it (review.mjs).
async function reviewAll(project) {
  for (let round = 0; round < 40; round += 1) if (!(await agent("look", { project, mode: "review", inline: false })).data.left) return;
}
const answer = (project, body, on = server) => agent("notes", { project, action: "answer", ...body }, on);

// kino refuses an answer under 5 s after the ask (too_fast), so a test that records one waits
// out what is left of 5.2 s since the ask came back. The file has six of these waits. They are
// timed on the steady clock, as the server times them: this PC's wall clock (WSL 2) jumps by up
// to 8 s against it every few seconds (measured).
async function gap(askedAt) {
  for (let left = askedAt + 5200 - performance.now(); left > 0; left = askedAt + 5200 - performance.now())
    await new Promise((resolve) => setTimeout(resolve, left));
}

// The texts the design fixes (F4, F5, F6).
const LABELS = { board: "the storyboard", rough: "the rough cut", color: "the color pass", sound: "the sound pass" };
const HEADLINES = { board: "The storyboard is ready", rough: "The rough cut is ready", color: "The color pass is ready", sound: "The sound pass is ready" };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
// The open rules the check found, the 3 with the most findings, follow the warning count.
const openRules = (check) => Object.entries(check.byRule ?? {}).map(([rule, row]) => [rule, row.errors + row.warnings]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
const counts = (check) => `${plural(check.errors, "error")} · ${plural(check.warnings, "warning")}${openRules(check).length ? ` (${openRules(check).map(([rule, count]) => `${rule} ${count}`).join(", ")})` : ""}`;
const offerLine = (offer) => `Or say "stop asking" to skip the ${offer.join(" and ")} ${offer.length === 1 ? "check" : "checks"} for this video.`;
const askText = (kind, id, check, offer, waived = true) => [
  `${HEADLINES[kind]} (${id}): 24 s, 1080×1920.`,
  // The fixture waives two gates for every layer; the person sees that count.
  `Checked: ${counts(check)}${waived ? " · 2 waived (reference all, treatments all)" : ""}.`,
  // These test videos have no sound, and this service has no song search.
  ...(kind === "sound" ? ["No music yet: name a song or artist, send a track, or keep it silent."] : []),
  "What did you notice, and what would you change?",
  "Reply: approve · approve with notes: ... · redo: ...",
  ...(offer.length ? [offerLine(offer)] : []),
].join("\n");
const askNext = (id, rev) => `send the ask (up to 3 lines of yours after its first; attach look {mode:"sheet"} if you can), end your turn, then notes {action:"answer", id:"${id}", rev:${rev}, words, read_as}.`;
const ALLOWED_NEXT = "say in one line what you checked, then go on.";
const ANSWER_NEXT = {
  approve: 'say "Read as: approve" in one line, then go on.',
  "approve with notes": 'say "Read as: approve with notes (<what>)" in one line, make those changes, then go on.',
  redo: (kind) => `say "Read as: redo (<what>)" in one line; fix only what they named, check, then ask again: notes {action:"checkpoint", id:"${kind}"}.`,
  "stop asking": "say in one line that you go on without stopping for rough, color and sound; go on.",
};
const waitingData = (id, kind) => ({ waiting: id, kind, next: `Nothing was changed. ${id} (${LABELS[kind]}) waits for the person's answer: end your turn. Reads, look, check and notes still work.${kind === "board" ? " A revised board (an edit of board ops only, music by a sound's src or id included) saves and refreshes this ask." : ""}` });

function assertAsked(reply, { id, kind, rev, check, offer, waived }) {
  assert.equal(reply.isError, undefined, reply.text);
  const ask = askText(kind, id, check, offer, waived);
  const next = askNext(id, rev);
  assert.deepEqual(reply.data, { status: "waiting_for_you", id, kind, rev, ask, offer, next });
  assert.deepEqual(withoutNext(reply.text).split("\n").map((line) => line.trim()), [`waiting_for_you ${id} ${kind} · rev ${rev}`, "ask:", ...ask.split("\n"), `step: ${next}`]);
  // The next call records the person's reply to this stop.
  assert.deepEqual(nextCallOf(reply), { tool: "notes", input: { action: "answer", id, rev, words: "<their reply, word for word>", read_as: "approve" } });
}

// A write refused while a stop waits: not an error, and nothing was changed.
function assertWaiting(reply, id, kind, what) {
  assert.equal(reply.isError, undefined, `${what}: ${reply.text}`);
  assert.deepEqual(reply.data, waitingData(id, kind), `${what}: ${reply.text}`);
  // The answer's JSON keeps the prose as hint and ends with the call that records their reply.
  const { next: hint, ...rest } = waitingData(id, kind);
  const { inbox, ...text } = JSON.parse(reply.text.split("\n")[0]);
  assert.deepEqual({ ...text, next: undefined }, { ...rest, hint, next: undefined }, what);
  assert.match(text.next, new RegExp(`^notes \\{"action":"answer","id":"${id}"`), what);
}

function assertRefused(reply, code, reason, what = "") {
  assert.equal(reply.isError, true, `${what} ${reply.text}`);
  assert.equal(reply.data.error, code, `${what} ${reply.text}`);
  if (reason instanceof RegExp) assert.match(reply.data.reason, reason, what);
  else if (reason !== undefined) assert.equal(reply.data.reason, reason, what);
}

const replies = (count, stops) => ({ count, limit: 10, questions: count - stops, playbacks: 0, stops });

// The order test's video, used again: C2 is answered; C3 (color) waits until the allowed test sets color to allow.
const ORDER = "stops-order";

test("a video with no footage asks only its own stops, in order; notes answer records the reply and releases the writes", async () => {
  const project = ORDER;
  const { rev, checked } = await stopProject(project);
  assert.deepEqual((await statusOf(project)).lines, ["direction: no brief lines, no playback · replies 0/10", "step: save ask and about"], "with no stop asked, status shows B1's lines");
  const board = await checkpoint(project, "board");
  assert.equal(board.isError, undefined, board.text);
  assert.deepEqual(board.data, { status: "skipped", kind: "board", reason: "under 3600 s" });
  assert.equal(withoutNext(board.text), "board skipped: this video is 24 s, under 3600 s.");

  // The rough cut is this video's first stop: it waits for the person, and offers "stop asking".
  const first = await checkpoint(project, "rough");
  assertAsked(first, { id: "C1", kind: "rough", rev, check: checked, offer: ["color", "sound"] });
  // 200 for the answer (plan §12) plus up to 20 each for the open and the waived rules (at most 3 each).
  assert.ok(estimateTextTokens(withoutNext(first.text)) <= 240, `the waiting answer is about ${estimateTextTokens(withoutNext(first.text))} tokens (limit 240)`);
  assert.ok(estimateTextTokens(first.data.ask) <= 140, `the ask is about ${estimateTextTokens(first.data.ask)} tokens (limit 120, plus 20 for the open rules)`);
  const state = await savedState(project);
  assert.equal(state.nextStop, 2);
  assert.equal(state.stops.length, 1);
  const [round] = state.stops;
  assert.match(round.askedAt, ISO);
  assert.deepEqual({ ...designShape(round), askedAt: "…" }, { id: "C1", kind: "rough", rev, askedAt: "…", client: "claude-code", status: "waiting", offer: ["color", "sound"], ask: first.data.ask, answer: null });
  const waiting = await statusOf(project);
  assert.deepEqual(waiting.lines, [`direction: C1 rough waiting since ${round.askedAt.slice(11, 16)} · replies 0/10`, "step: end your turn until they answer"]);
  assert.equal(waiting.data.waiting, "C1");
  // Asked again at the same revision: the same stop, nothing new saved.
  assertAsked(await checkpoint(project, "rough"), { id: "C1", kind: "rough", rev, check: checked, offer: ["color", "sound"] });
  assert.equal((await savedState(project)).stops.length, 1);
  // Another stop while C1 waits answers like a refused write.
  assertWaiting(await checkpoint(project, "color"), "C1", "rough", "color while C1 waits");

  // A 12 s video has no rough, color or sound stop; a 6 s one has none at all.
  await stopProject("stops-12s", { seconds: 12, check: false });
  for (const kind of ["rough", "color", "sound"]) {
    const skipped = await checkpoint("stops-12s", kind);
    assert.equal(skipped.isError, undefined, skipped.text);
    assert.deepEqual(skipped.data, { status: "skipped", kind, reason: "under 15 s" });
    assert.equal(withoutNext(skipped.text), `${kind} skipped: this video is 12 s, under 15 s.`);
  }
  await stopProject("stops-6s", { seconds: 6, check: false });
  for (const kind of STOP_KINDS) {
    const skipped = await checkpoint("stops-6s", kind);
    assert.deepEqual(skipped.data, { status: "skipped", kind, reason: kind === "board" ? "under 3600 s" : "under 15 s" });
    if (kind !== "board") assert.equal(withoutNext(skipped.text), `${kind} skipped: this video is 6 s, under 15 s.`);
  }
  assert.deepEqual((await savedState("stops-12s")).stops, [], "a skipped stop is not saved");
  assert.deepEqual((await savedState("stops-6s")).stops, []);

  // A redo is an answer: it releases the writes, and the rough cut is asked again.
  await gap(first.at);
  const redoWords = "the title comes in too late; bring it in at 1 s";
  // A bad rejected list refuses the whole answer; a good one joins the never list (rejected_text).
  assertRefused(await answer(project, { id: "C1", rev, words: redoWords, read_as: "redo", rejected: [""] }), "bad_input", /rejected is the text the person turned down/);
  const redo = await answer(project, { id: "C1", rev, words: redoWords, read_as: "redo", rejected: ["Seven open-weight models."] });
  assert.equal(redo.isError, undefined, redo.text);
  assert.deepEqual((await savedState(project)).brief.style.rejected, ["Seven open-weight models."]);
  const redoAfter = redo.data.afterSeconds;
  assert.ok(Number.isInteger(redoAfter) && redoAfter >= 5, `recorded ${redoAfter} s after asking`);
  assert.deepEqual(redo.data, { id: "C1", kind: "rough", rev, read_as: "redo", passed: false, afterSeconds: redoAfter, replies: replies(1, 1), next: ANSWER_NEXT.redo("rough") });
  assert.equal(withoutNext(redo.text), [`C1 rough: redo, recorded ${redoAfter} s after asking · replies 1 of 10`, `step: ${ANSWER_NEXT.redo("rough")}`].join("\n"));
  assert.doesNotMatch(JSON.stringify(redo), /too late/, "their words are not sent back to the agent");
  assert.deepEqual((await statusOf(project)).lines, ["direction: C1 rough redo · replies 1/10", "step: fix what they named, check, ask rough again"]);
  const outOfOrder = await checkpoint(project, "color");
  assertRefused(outOfOrder, "out_of_order", 'color refused: rough is not approved yet; run notes checkpoint {id:"rough"} first.');
  assert.equal(outOfOrder.data.first, "rough");
  const fixed = await agent("edit", { project, ops: [move(700)] });
  assert.equal(fixed.isError, undefined, fixed.text);
  assert.equal(fixed.data.waiting, undefined, "the answer released the writes");
  const recheck = await agent("check", { project });
  const second = await checkpoint(project, "rough");
  assertAsked(second, { id: "C2", kind: "rough", rev: fixed.data.rev, check: recheck.data, offer: ["color", "sound"] });

  // An approval passes the rough cut, its words are kept word for word, and color is next.
  await gap(second.at);
  const words = "looks good, go";
  const approved = await answer(project, { id: "C2", rev: fixed.data.rev, words, read_as: "approve" });
  assert.equal(approved.isError, undefined, approved.text);
  const approveAfter = approved.data.afterSeconds;
  assert.ok(Number.isInteger(approveAfter) && approveAfter >= 5, `recorded ${approveAfter} s after asking`);
  assert.deepEqual(approved.data, { id: "C2", kind: "rough", rev: fixed.data.rev, read_as: "approve", passed: true, afterSeconds: approveAfter, replies: replies(2, 2), next: ANSWER_NEXT.approve });
  assert.equal(withoutNext(approved.text), [`C2 rough: approve, recorded ${approveAfter} s after asking · replies 2 of 10`, `step: ${ANSWER_NEXT.approve}`].join("\n"));
  const saved = (await savedState(project)).stops;
  assert.deepEqual(saved.map((entry) => [entry.id, entry.status, entry.answer?.read_as]), [["C1", "answered", "redo"], ["C2", "answered", "approve"]]);
  assert.match(saved[1].answer.at, ISO);
  assert.deepEqual({ ...saved[1].answer, at: "…" }, { via: "chat", words, read_as: "approve", at: "…", client: "claude-code", afterSeconds: approveAfter });
  assert.equal(saved[0].answer.words, redoWords, "the redo is kept word for word");
  assert.deepEqual((await statusOf(project)).lines, ["direction: C2 rough approved · replies 2/10", "step: follow the plan, then ask color"]);
  assert.deepEqual((await agent("notes", { project, action: "brief" })).data.replies, replies(2, 2), "each answer counts as a reply");

  // Writes work again; color is asked after a new check, with no "stop asking" offer.
  const changed = await agent("edit", { project, ops: [move(720)] });
  assert.equal(changed.isError, undefined, changed.text);
  assert.equal(changed.data.rev, fixed.data.rev + 1);
  const colorCheck = await agent("check", { project });
  const color = await checkpoint(project, "color");
  assertAsked(color, { id: "C3", kind: "color", rev: changed.data.rev, check: colorCheck.data, offer: [] });
  // The step log (step-log.mjs): the rough cut's ask, its wait and its redo are the rough step;
  // after the approval the edit is the build; the color step is the refused early ask and the real one.
  const { steps } = (await savedState(project)).stepLog;
  assert.deepEqual([steps.color.calls, steps.rough.calls >= 8], [2, true]);
  assert.ok(steps.build.calls > 0);
});

test("allowed and skipped stops count as passed; a passed stop at the same revision says so, and a new revision opens a new round", async () => {
  try {
    const defaults = (await dashboard("settings", { method: "GET" })).body.settings;
    for (const kind of STOP_KINDS) assert.equal(defaults.approvals[`checkpoint-${kind}`], "ask");
    const { skipBoardUnder, skipRoughUnder, skipColorUnder, skipSoundUnder } = defaults.limits;
    assert.deepEqual([skipBoardUnder, skipRoughUnder, skipColorUnder, skipSoundUnder], [BOARD_SKIP_UNDER, 15, 15, 15], "the board's is this file's (before)");
    const denied = await setting({ approvals: { "checkpoint-color": "deny" } });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error, "A stop is ask or allow.");
    for (const length of [3601, -1, 7.5, "15"]) {
      const refused = await setting({ limits: { skipColorUnder: length } });
      assert.equal(refused.status, 400, `skipColorUnder ${JSON.stringify(length)}`);
      assert.match(refused.body.error, /skip-under length is a whole number of seconds from 0 to 3600\.$/);
    }

    // Color allowed: the first stop's "stop asking" offer names only the sound check. The order
    // test's C3 (color), waiting until now, passes at once: allowed by the person's settings.
    assert.equal((await savedState(ORDER)).stops[2]?.status, "waiting", "the order test ran first");
    assert.equal((await setting({ approvals: { "checkpoint-color": "allow" } })).status, 200);
    assert.deepEqual([(await savedState(ORDER)).stops[2].status, (await savedState(ORDER)).stops[2].allowedBy], ["allowed", "settings"], "the settings change closed C3");
    const soundOnly = await stopProject("stops-offer-sound");
    assertAsked(await checkpoint("stops-offer-sound", "rough"), { id: "C1", kind: "rough", rev: soundOnly.rev, check: soundOnly.checked, offer: ["sound"] });

    // Rough and color allowed: each answers allowed with an id and a saved round; sound asks next.
    assert.equal((await setting({ approvals: { "checkpoint-rough": "allow" } })).status, 200);
    const { rev, checked } = await stopProject("stops-allowed");
    const rough = await checkpoint("stops-allowed", "rough");
    assert.equal(rough.isError, undefined, rough.text);
    assert.deepEqual(rough.data, { status: "allowed", id: "C1", kind: "rough", rev, by: "settings", next: ALLOWED_NEXT });
    assert.equal(withoutNext(rough.text), [`C1 rough allowed (the person's settings) · checked: ${counts(checked)}`, `step: ${ALLOWED_NEXT}`].join("\n"));
    assert.deepEqual((await statusOf("stops-allowed")).lines, ["direction: C1 rough allowed · replies 0/10", "step: follow the plan, then ask color"]);
    const color = await checkpoint("stops-allowed", "color");
    assert.deepEqual(color.data, { status: "allowed", id: "C2", kind: "color", rev, by: "settings", next: ALLOWED_NEXT });
    assertAsked(await checkpoint("stops-allowed", "sound"), { id: "C3", kind: "sound", rev, check: checked, offer: [] });
    assert.deepEqual((await savedState("stops-allowed")).stops.map((entry) => [entry.id, entry.kind, entry.status, entry.allowedBy]),
      [["C1", "rough", "allowed", "settings"], ["C2", "color", "allowed", "settings"], ["C3", "sound", "waiting", undefined]]);

    // Sound skipped under 30 s: nothing waits, so asking a passed stop again says it passed.
    assert.equal((await setting({ limits: { skipSoundUnder: 30 } })).status, 200);
    const skip = await stopProject("stops-skip");
    assert.equal((await checkpoint("stops-skip", "rough")).data.status, "allowed");
    assert.equal((await checkpoint("stops-skip", "color")).data.status, "allowed");
    const sound = await checkpoint("stops-skip", "sound");
    assert.equal(sound.isError, undefined, sound.text);
    assert.deepEqual(sound.data, { status: "skipped", kind: "sound", reason: "under 30 s" });
    assert.equal(withoutNext(sound.text), "sound skipped: this video is 24 s, under 30 s.");
    for (const [id, kind] of [["C2", "color"], ["C1", "rough"]]) {
      const passed = await checkpoint("stops-skip", kind);
      assert.equal(passed.isError, undefined, passed.text);
      assert.deepEqual(passed.data, { status: "passed", id, kind, rev: skip.rev });
      assert.ok(passed.text.startsWith(`${id} ${kind} passed at rev ${skip.rev} (`), passed.text);
      assert.ok(withoutNext(passed.text).endsWith("); nothing changed since. Go on."), passed.text);
    }
    // A new revision is new work: checked again, color opens a new round.
    const edited = await agent("edit", { project: "stops-skip", ops: [move(700)] });
    await agent("check", { project: "stops-skip" });
    const newer = await checkpoint("stops-skip", "color");
    assert.deepEqual(newer.data, { status: "allowed", id: "C3", kind: "color", rev: edited.data.rev, by: "settings", next: ALLOWED_NEXT });
    assert.deepEqual((await savedState("stops-skip")).stops.map((entry) => [entry.id, entry.kind, entry.rev]), [["C1", "rough", skip.rev], ["C2", "color", skip.rev], ["C3", "color", edited.data.rev]]);
  } finally {
    await setting({ approvals: { "checkpoint-rough": "ask", "checkpoint-color": "ask" }, limits: { skipSoundUnder: 15 } });
  }
});

test("a stop shows only work the agent checked in full on this revision: otherwise check_first", async () => {
  const project = "stops-check";
  const { rev } = await stopProject(project, { check: false });
  const none = await checkpoint(project, "rough");
  assertRefused(none, "check_first", `Run check first: a stop shows work kino checked on this revision (rev ${rev}; no full check yet).`);
  assert.equal(none.data.rev, rev);
  assert.equal(none.data.checked, null);

  await agent("check", { project });
  const edited = await agent("edit", { project, ops: [move(700)] });
  const stale = await checkpoint(project, "rough");
  assertRefused(stale, "check_first", `Run check first: a stop shows work kino checked on this revision (rev ${edited.data.rev}; last full check: rev ${rev}).`);
  assert.equal(stale.data.rev, edited.data.rev);
  assert.equal(stale.data.checked.rev, rev);

  const small = await agent("edit", { project, ops: [fontSize(24)] });
  const errors = await agent("check", { project });
  assert.equal(errors.data.errors, 1, errors.text);
  assertRefused(await checkpoint(project, "rough"), "check_first", `check found 1 error on rev ${small.data.rev}: fix it first, then check again.`);

  // A check of one scene, a check without pixels, or the person's check from the dashboard is
  // not the agent's full check.
  const restored = await agent("edit", { project, ops: [fontSize(96)] });
  assert.equal((await agent("check", { project, scene: "s1" })).isError, undefined);
  assert.equal((await agent("check", { project, pixels: false })).isError, undefined);
  assert.equal((await dashboard("act/check", { body: { project } })).status, 200);
  assertRefused(await checkpoint(project, "rough"), "check_first", `Run check first: a stop shows work kino checked on this revision (rev ${restored.data.rev}; last full check: rev ${small.data.rev}).`);

  const full = await agent("check", { project, rules: true });
  assert.equal(full.data.errors, 0, full.text);
  const { checked } = await savedState(project);
  assert.match(checked.at, ISO);
  assert.deepEqual({ ...checked, at: "…" }, { rev: restored.data.rev, errors: 0, warnings: full.data.warnings, at: "…", client: "claude-code", ...(openRules(full.data).length ? { top: openRules(full.data) } : {}) });
  assertAsked(await checkpoint(project, "rough"), { id: "C1", kind: "rough", rev: restored.data.rev, check: full.data, offer: ["color", "sound"] });
});

test("a stop needs the brief first, is asked by the agent, and names a kind", async () => {
  const project = "stops-no-brief";
  await stopProject(project, { brief: false });
  assertRefused(await checkpoint(project, "rough"), "brief_first", "Save the brief first (library guide direction): a stop checks the work against it.");
  // A stop this video does not have is skipped before the brief is needed.
  assert.deepEqual((await checkpoint(project, "board")).data, { status: "skipped", kind: "board", reason: "under 3600 s" });
  for (const id of [undefined, "C1", "storyboard", "rouhg"]) assertRefused(await checkpoint(project, id), "bad_input", "id is board, rough, color, sound or critique.");
  assert.equal((await checkpoint(project, "rouhg")).data.didYouMean[0], "rough");
  // An id that is a property of every object names no step; the refused ask leaves the project working.
  for (const id of ["__proto__", "toString"]) assertRefused(await checkpoint(project, id), "bad_input", "id is board, rough, color, sound or critique.");
  assert.ok((await agent("status", { project })).text, "status still answers");
  assert.ok((await savedState(project)).stepLog.order.every((name) => STEP_NAMES.includes(name)), "only real step names are saved");
  assertRefused(await checkpoint(project, "rough", { by: "you" }), "bad_input", "Stops are asked by the agent; the person answers them.");
  const fromDashboard = await dashboard("act/notes", { body: { project, action: "checkpoint", id: "rough" } });
  assert.equal(fromDashboard.status, 200);
  assert.equal(fromDashboard.body.data.error, "bad_input");
  assert.deepEqual((await savedState(project)).stops, [], "nothing was saved");
  // A judge round (agent/judge.mjs): only the person picks, and a round needs a saved reference.
  assert.match((await agent("notes", { project, action: "judge", round: "J1", pair: 1, pick: "left" })).text, /Only the person picks/);
  assert.match((await agent("notes", { project, action: "judge" })).text, /judge needs a saved reference/);
});

test("while a stop waits, every write to its project answers {waiting} and changes nothing; reads, look, check and notes work", async () => {
  const project = "stops-writes";
  const { rev, turn, checked } = await stopProject(project, { brief: false });
  // Asked before the stop, so render wait and cancel have an approval to read. Since B2c a
  // final render waits for the video's stops, so it is asked before the brief (no brief: no stops).
  await reviewAll(project);
  const final = await agent("render", { project, action: "start", quality: "final" });
  assert.equal(final.data.status, "awaiting_approval", final.text);
  assert.equal((await agent("notes", { project, action: "brief", no_playback: "just start" })).isError, undefined);
  assert.equal((await checkpoint(project, "rough")).data.status, "waiting_for_you");

  const writes = [
    ["edit", { project, ops: [move(700)] }],
    ["check", { project, fix: "auto" }],
    ["check", { project, fix: true }],
    ["history", { project, action: "revert", turn }],
    ["history", { project, action: "restore", rev: 1 }],
    ["render", { project, action: "start", quality: "draft" }],
    ["render", { project, action: "start", quality: "final" }],
    ["render", { project, quality: "draft" }],
    ["project", { action: "duplicate", id: project, name: "copy" }],
    ["project", { action: "archive", id: project }],
    ["project", { action: "share", id: project }],
    // The size probe of a media import (the MCP and command-line import asks it first).
    ["project", { action: "import", project, name: "clip.mp4", size: 1000 }],
    ["project", { action: "manage", project, options: { resource: "folders", action: "create", name: "stops" } }],
    ["project", { action: "manage", project, options: { resource: "comments", action: "add", text: "a comment" } }],
  ];
  for (const [verb, body] of writes) assertWaiting(await agent(verb, body), "C1", "rough", `${verb} ${JSON.stringify(body)}`);
  assert.equal(await revision(project), rev, "no refused write changed the project");
  // The activity log names the stop on its ask and on each refused write.
  const events = (await readFile(path.join(server.dataDirectory, "agent", "projects", `${project}.events.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.stop).map((event) => [event.verb, event.stop]), [["notes", "C1"]]);
  assert.equal(events.filter((event) => event.waiting === "C1").length, writes.length);

  const refusedNext = waitingData("C1", "rough").next;
  const reads = [
    ["status", { project }],
    ["look", { project }],
    ["inspect", { project, targets: ["title"] }],
    ["library", { project, topic: "easings" }],
    ["check", { project }],
    ["history", { project, action: "list" }],
    ["render", { project, action: "queue" }],
    ["render", { project, action: "wait", job: final.data.id }],
    ["render", { project, action: "cancel", job: final.data.id }],
    ["notes", { project, action: "list" }],
    ["notes", { project, action: "brief" }],
    ["notes", { project, action: "set_plan", steps: ["Rough cut", "Color", "Sound", "Render"] }],
    ["project", { action: "list" }],
    ["project", { action: "open", id: project }],
    ["project", { action: "manage", project, options: { resource: "folders", action: "list" } }],
    ["project", { action: "manage", project, options: { resource: "comments", action: "list" } }],
    ["edit", { project, dry_run: true, ops: [move(700)] }],
  ];
  for (const [verb, body] of reads) {
    const reply = await agent(verb, body);
    assert.equal(reply.isError, undefined, `${verb} ${JSON.stringify(body)}: ${reply.text}`);
    assert.notEqual(reply.data?.next, refusedNext, `${verb} ${JSON.stringify(body)} is not refused`);
  }
  assert.equal((await statusOf(project)).data.waiting, "C1");
  assertAsked(await checkpoint(project, "rough"), { id: "C1", kind: "rough", rev, check: checked, offer: ["color", "sound"] });
  assert.equal(await revision(project), rev, "the dry run changed nothing");
  // Only refused writes carry waiting in the activity log: status and project open say a stop
  // waits, but nothing was refused.
  const logged = (await readFile(path.join(server.dataDirectory, "agent", "projects", `${project}.events.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(logged.filter((event) => event.waiting).map((event) => event.verb), writes.map(([verb]) => verb), "reads are not logged as refused");

  // A .json project import (MCP project import) is refused, and the client says so.
  const folder = await mkdtemp(path.join(tmpdir(), "kino-stops-import-"));
  try {
    const file = path.join(folder, "copy.json");
    await writeFile(file, JSON.stringify((await (await server.api(`/api/projects/${project}`)).json()).document));
    const before = (await agent("project", { action: "list" })).text;
    const imported = await createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "mcp" }).importFile(file);
    assert.deepEqual(imported.refused?.data, waitingData("C1", "rough"), JSON.stringify(imported));
    assert.equal((await agent("project", { action: "list" })).text, before, "nothing was imported");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }


  // A new project, and writes to another project, are not held up. project create names a new
  // project even without an id, while the open project's stop waits (review round 2).
  assert.equal((await agent("project", { action: "open", id: project })).isError, undefined);
  const unnamed = await agent("project", { action: "create", name: "no id", width: 1080, height: 1920, duration: 6 });
  assert.equal(unnamed.isError, undefined, unnamed.text);
  assert.equal(unnamed.data.waiting, undefined, unnamed.text);
  assert.match(withoutNext(unnamed.text), /^created \S+ rev 1 and opened it/);
  const other = await agent("project", { action: "create", id: "stops-writes-other", name: "other", width: 1080, height: 1920, duration: 24 });
  assert.equal(other.isError, undefined, other.text);
  const elsewhere = await agent("edit", { project: "stops-writes-other", ops: [TITLE] });
  assert.equal(elsewhere.isError, undefined, elsewhere.text);
  assert.equal(elsewhere.data.waiting, undefined);
  // The project a write names is the one it is refused for, even while another one is open.
  assertWaiting(await agent("project", { action: "duplicate", id: project, name: "copy" }), "C1", "rough", "a duplicate naming the waiting project");
  assertWaiting(await agent("edit", { project, ops: [move(700)] }), "C1", "rough", "an edit naming it");
  const before = await revision("stops-writes-other");
  const open = await agent("edit", { ops: [move(700)] });
  assert.equal(open.isError, undefined, open.text);
  assert.equal(open.data.waiting, undefined);
  assert.equal(await revision("stops-writes-other"), before + 1, "an edit without a project changes the open one");
  assert.equal(await revision(project), rev, "the waiting project did not change");

  // The person's own edit from the dashboard goes through.
  const byYou = await dashboard("act/edit", { body: { project, ops: [move(720)] } });
  assert.equal(byYou.status, 200);
  assert.equal(byYou.body.isError, undefined, byYou.body.text);
  assert.equal(byYou.body.data.rev, rev + 1);
  assert.equal(await revision(project), rev + 1);
});

test("notes answer refuses a reply under 5 s, a revision the person was not shown, an id kino never issued, a second answer and bad input; a render approval reads its own words", async () => {
  const project = "stops-refusals";
  const { rev, turn } = await stopProject(project, { brief: false });
  // A final render of the fixture asks for approval (720 frames, over 600), before the brief
  // and the stop (since B2c a final render waits for the stops of a video with a brief).
  await reviewAll(project);
  const final = await agent("render", { project, action: "start", quality: "final" });
  assert.equal(final.data.status, "awaiting_approval", final.text);
  assert.equal(final.data.summary, `a final mp4 of s1 at rev ${rev} (720 frames, over 600)`);
  assert.equal((await agent("notes", { project, action: "brief", no_playback: "just start" })).isError, undefined);
  assert.equal((await checkpoint(project, "rough")).data.id, "C1");
  const reply = { id: "C1", rev, words: "looks good", read_as: "approve" };

  const fast = await answer(project, reply);
  assertRefused(fast, "too_fast", /^C1 was asked \d s ago: nobody reads a stop that fast\. Send the ask and record the reply they send\.$/);
  assert.ok(fast.data.seconds < 5, `${fast.data.seconds} s`);
  assertRefused(await answer(project, { ...reply, rev: rev - 1 }), "stale_rev");
  // An approval answered in the chat is read as allow or deny (agent-render-approval.test.mjs
  // renders an allowed one): "no" denies it, and it is answered once.
  const denied = await answer(project, { ...reply, id: final.data.id, words: "no, not yet", read_as: "deny" });
  assert.equal(denied.data.status, "denied", denied.text);
  assertRefused(await answer(project, { ...reply, id: final.data.id.toLowerCase() }), "answered");
  for (const id of ["C9", "Q99", "M1", "V1"]) assertRefused(await answer(project, { ...reply, id }), "not_found", `kino never asked ${id} in this project.`);
  assert.equal((await answer(project, { ...reply, id: "C9" })).data.didYouMean?.[0], "C1");
  for (const body of [{ words: "" }, { words: "   " }, { words: "a".repeat(2001) }, { read_as: "aprove" }, { read_as: undefined }, { rev: undefined }, { rev: "2" }, { rev: 2.5 }, { id: undefined }])
    assertRefused(await answer(project, { ...reply, ...body }), "bad_input", undefined, JSON.stringify(body));
  assert.equal((await answer(project, { ...reply, read_as: "aprove" })).data.didYouMean[0], "approve");
  assertRefused(await answer(project, { ...reply, by: "you" }), "bad_input", "The person answers a stop on the dashboard (B2b) or in the chat, where you record it.");
  assert.equal((await savedState(project)).stops[0].status, "waiting", "no refused answer was recorded");
  assert.equal((await agent("render", { project, action: "cancel", job: final.data.id })).isError, undefined);

  // The person undid the agent's turn in the dashboard: C1 showed a revision that is gone.
  const undone = await dashboard("undo", { body: { project, turn } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const now = await revision(project);
  assert.notEqual(now, rev);
  const stale = await answer(project, reply);
  assertRefused(stale, "stale_rev", `C1 showed rev ${rev}, and the project is rev ${now} now. Ask again: notes {action:"checkpoint", id:"rough"}.`);
  assert.equal(stale.data.asked, rev);
  assert.equal(stale.data.now, now);
  // Asked again after a check: the old round lapses and the new one has a new id.
  const recheck = await agent("check", { project });
  assert.equal(recheck.data.errors, 0, recheck.text);
  // The undo took the fixture's two waivers with it, so this ask has no waived count.
  assertAsked(await checkpoint(project, "rough"), { id: "C2", kind: "rough", rev: now, check: recheck.data, offer: ["color", "sound"], waived: false });
  const [lapsed] = (await savedState(project)).stops;
  assert.equal(lapsed.status, "lapsed");
  assert.equal(lapsed.lapsedRev, now);
  assert.match(lapsed.lapsedAt, ISO);
  assertRefused(await answer(project, reply), "stale_rev");

  // The order test's video: C2 is answered (approve); C3 (color) was allowed by the person's
  // settings when the allowed test set color to allow, so it is answered too. (A stop that
  // offered no "stop asking" refuses it, not_offered: server/agent-stops.test.mjs.)
  const [, approved, color] = (await savedState(ORDER)).stops;
  assert.deepEqual([approved?.id, approved?.status, color?.id, color?.status], ["C2", "answered", "C3", "allowed"], "the order test ran first");
  assertRefused(await answer(ORDER, { id: "C2", rev: approved.rev, words: "yes", read_as: "approve" }), "answered",
    /^C2 is already answered \(approve, \d\d:\d\d\)\. If they changed their mind, make the change and ask again\.$/);
  assertRefused(await answer(ORDER, { id: "C3", rev: color.rev, words: "stop asking", read_as: "stop asking" }), "answered",
    /^C3 is already answered \(allowed, \d\d:\d\d\)\. If they changed their mind, make the change and ask again\.$/);
  // An allowed stop is answered too: the person's settings answered it.
  assertRefused(await answer("stops-allowed", { id: "C1", rev: (await savedState("stops-allowed")).stops[0].rev, words: "yes", read_as: "approve" }), "answered");
});

test("at 10 replies kino does not ask a first rough, color or sound stop, and the agent makes the call; a re-ask is still asked", async () => {
  const questions = (count) => Array.from({ length: count }, (_, index) => ({ q: `Question ${index + 1}?`, a: `answer ${index + 1}` }));
  const logReplies = async (project, sizes) => {
    for (const size of sizes) assert.equal((await agent("notes", { project, action: "brief", log: questions(size) })).isError, undefined);
  };
  // At 9 replies the rough cut is asked, and its answer is the 10th reply.
  const nine = "stops-nine";
  const { rev } = await stopProject(nine);
  await logReplies(nine, [4, 4, 1]);
  const asked = await checkpoint(nine, "rough");
  assert.equal(asked.data.status, "waiting_for_you", asked.text);

  const ten = "stops-ten";
  await stopProject(ten);
  await logReplies(ten, [4, 4, 2]);
  for (const kind of ["rough", "color", "sound"]) {
    const limited = await checkpoint(ten, kind);
    assertRefused(limited, "ask_limit", `10 of 10 replies used: kino does not ask the person about ${kind} for this video.`);
    assert.equal(limited.data.kind, kind);
    assert.equal(limited.data.replies, 10);
    assert.equal(limited.data.next, `Make the ${kind} call yourself, say "my call: …" in your message, and go on.`);
  }
  assert.deepEqual((await savedState(ten)).stops, [], "nothing was saved");

  await gap(asked.at);
  const redo = await answer(nine, { id: "C1", rev, words: "too slow at the start", read_as: "redo" });
  assert.equal(redo.isError, undefined, redo.text);
  assert.match(withoutNext(redo.text), /^C1 rough: redo, recorded \d+ s after asking · replies 10 of 10\n/);
  assert.deepEqual(redo.data.replies, replies(10, 1));
  const again = await checkpoint(nine, "rough");
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.data.status, "waiting_for_you");
  assert.equal(again.data.id, "C2", "a re-ask after a redo is asked at 10 replies");
});

// Reads the dashboard's event stream from `since` until an event matches, or the time runs out.
async function firstEvent(query, wanted, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await server.api(`/api/dashboard/stream${query}`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer.slice(0, end).split("\n").find((line) => line.startsWith("data:"));
        buffer = buffer.slice(end + 2);
        if (data && wanted(JSON.parse(data.slice(5)))) return JSON.parse(data.slice(5));
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return null;
}

test("\"stop asking\" in answer to the first stop allows rough, color and sound for this video only; the person can undo it on the dashboard", async () => {
  const project = "stops-stop-asking";
  const { rev, checked } = await stopProject(project);
  const asked = await checkpoint(project, "rough");
  assert.deepEqual(asked.data.offer, ["color", "sound"], asked.text);
  await gap(asked.at);
  const words = "stop asking me, just make it";
  const stopped = await answer(project, { id: "C1", rev, words, read_as: "stop asking" });
  assert.equal(stopped.isError, undefined, stopped.text);
  assert.deepEqual([stopped.data.read_as, stopped.data.passed], ["stop asking", true]);
  assert.deepEqual(withoutNext(stopped.text).split("\n"), [
    `C1 rough: stop asking, recorded ${stopped.data.afterSeconds} s after asking · replies 1 of 10`,
    "rough, color and sound are set to allow for this video (set in chat, recorded by the agent; the person can undo it in kino).",
    `step: ${ANSWER_NEXT["stop asking"]}`,
    // The last stop passed on a built video: every gate left before the final render, at once.
    "to final: 1) render final",
  ]);
  const { stopAsking } = await savedState(project);
  assert.match(stopAsking.at, ISO);
  assert.deepEqual({ ...stopAsking, at: "…" }, { stop: "C1", words, at: "…", client: "claude-code", undoneAt: null });
  assert.deepEqual((await statusOf(project)).lines, ["direction: C1 rough allowed in chat · replies 1/10", "step: follow the plan, then ask color"]);

  const color = await checkpoint(project, "color");
  assert.equal(color.isError, undefined, color.text);
  assert.deepEqual(color.data, { status: "allowed", id: "C2", kind: "color", rev, by: "chat", next: ALLOWED_NEXT });
  assert.equal(color.text.split("\n")[0], `C2 color allowed (set in chat) · checked: ${counts(checked)}`);
  assert.equal((await savedState(project)).stops[1].allowedBy, "chat");
  assert.deepEqual((await statusOf(project)).lines, ["direction: C2 color allowed in chat · replies 1/10", "step: follow the plan, then ask sound"]);
  // Render approvals and the board are never switched off in chat.
  await reviewAll(project);
  const final = await agent("render", { project, action: "start", quality: "final" });
  assert.equal(final.data.status, "awaiting_approval", final.text);
  assert.equal((await agent("render", { project, action: "cancel", job: final.data.id })).isError, undefined);
  assert.deepEqual((await checkpoint(project, "board")).data, { status: "skipped", kind: "board", reason: "under 3600 s" });

  // The person undoes it on the dashboard: the agent hears it, and color asks again.
  const { boot, seq } = (await dashboard(`snapshot?project=${project}`, { method: "GET" })).body;
  assert.equal((await dashboard("stops", { body: { project, action: "keep_asking" }, review: false })).status, 403, "only an open dashboard window can undo it");
  const undone = await dashboard("stops", { body: { project, action: "keep_asking" } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.match(undone.body.stops.stopAsking.undoneAt, ISO);
  const event = await firstEvent(`?since=${seq}&boot=${boot}`, (entry) => entry.type === "stops" && entry.projectId === project);
  assert.deepEqual(event?.stops, undone.body.stops, "the dashboard hears the change");
  const told = await agent("status", { project });
  assert.match(withoutNext(told.text), /\n {2}you turned the rough, color and sound stops back on for this video \(undid "stop asking" from C1\)/);
  const edited = await agent("edit", { project, ops: [move(700)] });
  const recheck = await agent("check", { project });
  assertAsked(await checkpoint(project, "color"), { id: "C3", kind: "color", rev: edited.data.rev, check: recheck.data, offer: [] });
  const twice = await dashboard("stops", { body: { project, action: "keep_asking" } });
  assert.equal(twice.status, 400);
  assert.equal(twice.body.error, "Nothing to undo: stops were not turned off in chat for this video.");
  assert.equal((await dashboard("stops", { body: { project, action: "stop_asking" } })).status, 400);

  // The dashboard's data: the waiting stop, the rounds with the person's words and without the
  // ask, and the undone "stop asking".
  const panel = (await dashboard(`snapshot?project=${project}`, { method: "GET" })).body.agent.stops;
  const saved = await savedState(project);
  assert.deepEqual(panel.waiting, { id: "C3", kind: "color", rev: edited.data.rev, askedAt: saved.stops[2].askedAt, client: "claude-code", ask: saved.stops[2].ask, offer: [] });
  assert.deepEqual(panel.rounds, saved.stops.map(designShape).map(({ ask, ...round }) => round));
  assert.equal(panel.rounds[0].answer.words, words);
  assert.deepEqual(panel.stopAsking, { stop: "C1", words, at: saved.stopAsking.at, undoneAt: saved.stopAsking.undoneAt });
});

test("a restart keeps the waiting stop: writes stay refused, status says so, and the answer still works", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-stops-restart-"));
  const project = "stops-restart";
  let first;
  let second;
  try {
    first = await startTestServer({ env: { MOTION_DATA_DIR: folder } });
    await skipBoardOn(first);
    const { rev } = await stopProject(project, { on: first });
    const asked = await checkpoint(project, "rough", {}, first);
    assert.equal(asked.data.status, "waiting_for_you", asked.text);
    await first.stop();
    first = null;
    second = await startTestServer({ env: { MOTION_DATA_DIR: folder } });
    assertWaiting(await agent("edit", { project, ops: [move(700)] }, second), "C1", "rough", "an edit after the restart");
    const { askedAt } = (await savedState(project, folder)).stops[0];
    const status = await statusOf(project, second);
    assert.deepEqual(status.lines, [`direction: C1 rough waiting since ${askedAt.slice(11, 16)} · replies 0/10`, "step: end your turn until they answer"]);
    assert.equal(status.data.waiting, "C1");
    // 5.2 s after the ask on the steady clock is long enough in a new server process too, even
    // though this PC's wall clock jumps by seconds.
    await gap(asked.at);
    const approved = await answer(project, { id: "C1", rev, words: "yes", read_as: "approve" }, second);
    assert.equal(approved.isError, undefined, approved.text);
    assert.equal(approved.data.passed, true);
    const edited = await agent("edit", { project, ops: [move(700)] }, second);
    assert.equal(edited.isError, undefined, edited.text);
    assert.equal(edited.data.rev, rev + 1);
  } finally {
    await first?.stop();
    await second?.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("two agents asking at once get one stop; a hold wins over it, and neither one releases the other", async () => {
  const project = "stops-two-agents";
  const { rev } = await stopProject(project);
  const [a, b] = await Promise.all([checkpoint(project, "rough", { client: "claude-a" }), checkpoint(project, "rough", { client: "codex-b" })]);
  for (const asked of [a, b]) {
    assert.equal(asked.data.status, "waiting_for_you", asked.text);
    assert.equal(asked.data.id, "C1");
  }
  assert.equal((await savedState(project)).stops.length, 1, "one saved round");
  const edit = (client) => agent("edit", { client, project, ops: [move(700)] });
  for (const client of ["claude-a", "codex-b"]) assertWaiting(await edit(client), "C1", "rough", `${client}'s edit`);
  try {
    assert.equal((await dashboard("hold", { body: { on: true } })).status, 200);
    const held = await edit("claude-a");
    assert.equal(held.data.held, true, "the hold answers first");
    assert.equal(held.data.waiting, undefined);
    assert.equal((await agent("check", { client: "claude-a", project, fix: true })).data.held, true, "check fix:true is a write");
    assert.equal((await checkpoint(project, "rough", { client: "codex-b" })).data.id, "C1", "a stop is asked during a hold");
    await dashboard("hold", { body: { on: false } });
    assertWaiting(await edit("codex-b"), "C1", "rough", "releasing the hold answers no stop");

    await dashboard("hold", { body: { on: true } });
    await gap(Math.max(a.at, b.at));
    const words = "yes, but make the title warmer";
    const recorded = await answer(project, { client: "codex-b", id: "C1", rev, words, read_as: "approve_with_notes" });
    assert.equal(recorded.isError, undefined, `an answer is recorded during a hold: ${recorded.text}`);
    assert.equal(recorded.data.read_as, "approve with notes");
    assert.equal(withoutNext(recorded.text).split("\n").at(-1), `step: ${ANSWER_NEXT["approve with notes"]}`);
    const [round] = (await savedState(project)).stops;
    assert.deepEqual([round.status, round.answer.read_as, round.answer.words, round.answer.client], ["answered", "approve with notes", words, "codex-b"]);
    assert.equal((await edit("claude-a")).data.held, true, "answering a stop releases no hold");
  } finally {
    await dashboard("hold", { body: { on: false } });
  }
  assert.deepEqual((await statusOf(project)).lines, ["direction: C1 rough approved (notes) · replies 1/10", "step: follow the plan, then ask color"]);
  for (const client of ["claude-a", "codex-b"]) {
    const edited = await edit(client);
    assert.equal(edited.isError, undefined, edited.text);
    assert.deepEqual([edited.data.waiting, edited.data.held], [undefined, undefined], `${client} writes again`);
    // Each lets go of the title after its edit (crew locks), so the other one can change it too.
    await agent("notes", { client, project, action: "release" });
  }
});

// Review round 1 of B2a: kino closes a waiting stop the person can no longer answer, so the
// project's writes never stay refused for it (each of these used to wait for ever).
test("a stop nobody can answer any more never holds up the writes: after an undo, a shorter video, an allow in settings", async () => {
  // The person undoes the agent's turn on the dashboard: the version C1 showed is gone.
  const project = "stops-lapse";
  const { turn } = await stopProject(project);
  assert.equal((await checkpoint(project, "rough")).data.id, "C1");
  assert.equal((await dashboard("undo", { body: { project, turn } })).status, 200);
  const edited = await agent("edit", { project, ops: [TITLE, REF_WAIVER, TREATMENTS_WAIVER] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal(edited.data.waiting, undefined, "the agent's next write goes through");
  assert.deepEqual((await statusOf(project)).lines, ["direction: C1 rough lapsed · replies 0/10", "step: check, then ask rough again"]);

  // A 6 s video made 24 s in one turn, then undone: it has no rough stop now.
  const short = "stops-shorter";
  assert.equal((await agent("project", { action: "create", id: short, name: short, width: 1080, height: 1920, duration: 6, background: "#101820" })).isError, undefined);
  const longer = await agent("edit", { project: short, ops: [{ op: "update_scene", properties: { duration: 24 } }, TITLE] });
  assert.equal(longer.isError, undefined, longer.text);
  await agent("notes", { project: short, action: "brief", no_playback: "just start" });
  assert.equal((await agent("check", { project: short })).data.errors, 0);
  assert.equal((await checkpoint(short, "rough")).data.id, "C1");
  assert.equal((await dashboard("undo", { body: { project: short, turn: longer.data.turn } })).status, 200);
  // status, the agent's first call after the undo, does not say to wait for C1.
  const status = await statusOf(short);
  assert.deepEqual(status.lines, ["direction: C1 rough lapsed · replies 0/10", "step: save ask and about"], "not: end your turn");
  assert.equal(status.data.waiting, undefined);
  const skipped = await checkpoint(short, "rough");
  assert.deepEqual(skipped.data, { status: "skipped", kind: "rough", reason: "under 15 s" });
  assert.ok(skipped.text.startsWith("rough skipped: this video is 6 s, under 15 s."), skipped.text);
  const shortEdit = await agent("edit", { project: short, ops: [TITLE, REF_WAIVER, TREATMENTS_WAIVER] });
  assert.equal(shortEdit.isError, undefined, shortEdit.text);
  assert.equal(shortEdit.data.waiting, undefined);

  // The person sets rough to allow while C1 waits: their settings answer it.
  const allowed = "stops-allow-later";
  await stopProject(allowed);
  assert.equal((await checkpoint(allowed, "rough")).data.id, "C1");
  try {
    assert.equal((await setting({ approvals: { "checkpoint-rough": "allow" } })).status, 200);
    const passed = await checkpoint(allowed, "rough");
    assert.equal(passed.data.status, "passed", passed.text);
    const write = await agent("edit", { project: allowed, ops: [move(700)] });
    assert.equal(write.isError, undefined, write.text);
    assert.equal(write.data.waiting, undefined);
    assert.deepEqual((await savedState(allowed)).stops.map((round) => [round.id, round.status, round.allowedBy]), [["C1", "allowed", "settings"]]);
  } finally {
    await setting({ approvals: { "checkpoint-rough": "ask" } });
  }

});

// Review round 2 of B2a: only the person lets a stop pass. The agent saving a brief that says no
// one can answer, while its stop waits, releases nothing, and the next stops still ask.
test("a brief saved as \"no one can answer\" while a stop waits releases nothing: writes stay refused until the person answers", async () => {
  const project = "stops-no-one";
  const { rev } = await stopProject(project);
  const asked = await checkpoint(project, "rough");
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  const saved = await agent("notes", { project, action: "brief", no_playback: "no one can answer" });
  assert.equal(saved.isError, undefined, saved.text);
  assertWaiting(await agent("edit", { project, ops: [move(700)] }), "C1", "rough", "an edit after that brief save");
  assert.equal((await statusOf(project)).lines[1], "step: end your turn until they answer");
  assert.equal(await revision(project), rev);
  await gap(asked.at);
  assert.equal((await answer(project, { id: "C1", rev, words: "looks good", read_as: "approve" })).data.passed, true);
  // Color asked on the same unchanged revision would merge into the answered rough stop, so the
  // work changes first (a new revision): then the next stop still asks.
  const edited = await agent("edit", { project, ops: [move(700)] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal((await agent("check", { project })).isError, undefined);
  const color = await checkpoint(project, "color");
  assert.equal(color.data.status, "waiting_for_you", color.text);
});

// Review round 2 of B2a: moving the project to Trash and back, or renaming it, raises the
// revision but not the work the stop showed, so the stop still waits and the reply still counts.
test("Trash and back, or a new name, while a stop waits: it still waits, and the person's reply is recorded", async () => {
  const project = "stops-trash";
  const { rev } = await stopProject(project);
  const asked = await checkpoint(project, "rough");
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.equal((await server.api(`/api/projects/${project}`, { method: "DELETE" })).status, 200);
  assert.equal((await server.api(`/api/projects/${project}/restore`, { method: "POST" })).status, 200);
  assert.equal((await server.api(`/api/projects/${project}`, { method: "PATCH", body: { name: "Park reopens" } })).status, 200);
  assert.equal(await revision(project), rev + 3, "each one raised the revision");
  assertWaiting(await agent("edit", { project, ops: [move(700)] }), "C1", "rough", "an edit after Trash, restore and rename");
  assert.equal((await statusOf(project)).lines[1], "step: end your turn until they answer");
  assert.equal((await checkpoint(project, "rough")).data.status, "waiting_for_you", "asking again shows the same stop");
  await gap(asked.at);
  const approved = await answer(project, { id: "C1", rev, words: "looks good", read_as: "approve" });
  assert.equal(approved.isError, undefined, approved.text);
  assert.equal(approved.data.passed, true);
  const again = await agent("edit", { project, ops: [move(700)] });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.data.rev, rev + 4, "answered: the agent writes again");
});

// Review round 1 of B2a: the agent's normal path leads to the first stop.
test("once the brief is settled, status says which stop to ask after building", async () => {
  const project = "stops-next";
  await stopProject(project, { check: false });
  // No person in this test: ask "none", so the subject may be a guess too.
  const fields = Object.fromEntries(["about", "message", "plays_on", "made_from", "look_sound", "never"].map((name) => [name, { text: "a guess", by: "guessed" }]));
  fields.ask = "none";
  assert.equal((await agent("notes", { project, action: "brief", fields })).isError, undefined);
  assert.equal((await statusOf(project)).lines[1], "step: notes set_plan, build, then ask rough");
  await agent("notes", { project, action: "set_plan", steps: ["Build", "Check"] });
  assert.equal((await statusOf(project)).lines[1], "step: follow the plan, then ask rough");
});

// The storyboard comes before the cut and before drafts (service.mjs refuseBeforeBoard). This file
// skips the board for its other tests, so this one asks for it again (8 s) and puts the skip back.
const CUT = [0, 12].map((start, index) => ({ op: "add_layer", layerType: "video", name: `cut${index + 1}`, properties: { src: "/api/media/none.mp4", mediaStart: start, mediaDuration: 12 } }));
const BOARD = { op: "board", music: "none", shots: [{ cue: 0, dur: 24, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: "Park reopens Saturday", family: "Inter" }, sound: "none", why: "the title on its own", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" } }] };

test("a cut waits for the storyboard, so does a draft; the approved board lets the same edit save, and the person's own call passes", async () => {
  await skipBoardOn(server, 8);
  try {
    const project = "stops-board-first";
    const { rev } = await stopProject(project);
    const refused = await agent("edit", { project, ops: CUT });
    assertRefused(refused, "board_needed", /^Nothing was built: the storyboard comes before the cut, so the person can still change it\. Next: save the storyboard\.$/);
    assert.equal(nextCallOf(refused).tool, "edit");
    assert.equal(nextCallOf(refused).input.ops[0].op, "board");
    // Clips placed to see and hear them: the answer names the look that does it with no layer.
    assert.match(refused.data.next, /To see a clip with its sound before the board, no layer needed: look \{mode:"source", layer:"<clip code>"\}\.$/);
    assert.equal(await revision(project), rev, "nothing was saved");
    // The second clip placed on top of an untrimmed first one (both run to the end) is a cut too.
    const stacked = CUT.map(({ properties: { mediaDuration, ...rest }, ...op }) => ({ ...op, properties: rest }));
    assertRefused(await agent("edit", { project, ops: stacked }), "board_needed", /Next: save the storyboard\.$/);
    assertRefused(await agent("render", { project, action: "start", quality: "draft" }), "board_needed", /^A draft waits for the storyboard \(never asked\): ask board first; look shows frames now\./);

    // The board is saved but not asked: the cut still waits, and the next call asks it.
    assert.equal((await agent("edit", { project, ops: [BOARD] })).isError, undefined);
    const saved = await revision(project);
    const asking = await agent("edit", { project, ops: CUT });
    assertRefused(asking, "board_needed", /Next: ask board\.$/);
    assert.deepEqual(nextCallOf(asking), { tool: "notes", input: { action: "checkpoint", id: "board" } });
    assert.equal(await revision(project), saved);

    // Approved: the same edit saves.
    const asked = await checkpoint(project, "board");
    assert.equal(asked.data.status, "waiting_for_you", asked.text);

    // While it waits, a revised board saves and the same stop shows it; every other write waits.
    const retitled = { ...BOARD, shots: [{ ...BOARD.shots[0], text: { text: "Park reopens Sunday", family: "Inter" } }] };
    const revised = await agent("edit", { project, ops: [retitled] });
    assert.equal(revised.isError, undefined, revised.text);
    assert.equal(revised.data.rev, asked.data.rev + 1, revised.text);
    assert.deepEqual([revised.data.stop.status, revised.data.stop.id, revised.data.stop.rev, revised.data.stop.revised], ["waiting_for_you", asked.data.id, revised.data.rev, true]);
    assert.ok(revised.data.stop.ask.includes("Park reopens Sunday"), revised.data.stop.ask);
    assert.deepEqual(nextCallOf(revised).input, { action: "answer", id: asked.data.id, rev: revised.data.rev, words: "<their reply, word for word>", read_as: "approve" });
    const stillAsks = await checkpoint(project, "board");
    assert.deepEqual([stillAsks.data.status, stillAsks.data.id, stillAsks.data.rev], ["waiting_for_you", asked.data.id, revised.data.rev], "one stop, now on the revised board");
    const held = await agent("edit", { project, ops: CUT });
    assert.equal(held.data.waiting, asked.data.id, "a cut still waits for the answer");
    assert.match(held.data.next, /A revised board \(an edit of board ops only, music by a sound's src or id included\) saves and refreshes this ask\.$/);
    assert.equal(await revision(project), revised.data.rev);
    // A refused revised board resent with retry and fix saves the same way (its ops are board ops).
    const short = await agent("edit", { project, ops: [{ ...retitled, shots: [{ ...retitled.shots[0], dur: 20 }] }] });
    assertRefused(short, "op_failed", /the shots end at 20 s, before the video ends \(24 s\)/);
    const retried = await agent("edit", { project, retry: short.data.retry, fix: { 0: { shots: retitled.shots.map((shot) => ({ ...shot, text: { text: "Park reopens Monday", family: "Inter" } })) } } });
    assert.equal(retried.isError, undefined, retried.text);
    assert.deepEqual([retried.data.stop.id, retried.data.stop.rev], [asked.data.id, revised.data.rev + 1], retried.text);
    assert.ok(retried.data.stop.ask.includes("Park reopens Monday"), retried.data.stop.ask);

    const approved = await dashboard("stops", { body: { project, action: "answer", id: asked.data.id, rev: retried.data.stop.rev, read_as: "approve" } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const built = await agent("edit", { project, ops: CUT });
    assert.equal(built.isError, undefined, built.text);

    // The person's own call passes without a board.
    await stopProject("stops-board-person");
    const byYou = await dashboard("act/edit", { body: { project: "stops-board-person", ops: CUT } });
    assert.equal(byYou.body.isError, undefined, byYou.body.text);
  } finally {
    await skipBoardOn(server);
  }
});

// Plan §4 and §12: the direction and next lines are at most 40 tokens (kino's estimate,
// backend/meter.mjs) in every state, now with stops.
test("the direction and next lines fit in 40 tokens with stops in every state", () => {
  assert.deepEqual(STOP_KINDS, ["board", "rough", "color", "sound"]);
  assert.deepEqual(READ_AS, ["approve", "approve with notes", "redo", "stop asking"]);
  const askedAt = "2026-10-21T14:02:11.000Z";
  const at = "2026-10-21T14:05:40.000Z";
  const brief = (count) => ({ rev: 0, savedAt: at, confirmedRev: null, noPlayback: { reason: "just start", rev: 0, client: "claude-code", at }, fields: {},
    log: Array.from({ length: count }, () => ({ q: "q?", a: "a", kind: "question", rev: 0, client: "claude-code", at })) });
  const rules = (policy) => ({ policy: Object.fromEntries(STOP_KINDS.map((kind) => [kind, policy])), skipUnder: { board: 8, rough: 15, color: 15, sound: 15 } });
  const video = (footage) => ({ seconds: 24, layers: 1, footage, width: 1080, height: 1920 });
  const answered = (read_as) => ({ status: "answered", answer: { via: "chat", words: "w", read_as, at, client: "claude-code", afterSeconds: 42 } });
  const round = (number, kind, how) => ({ id: `C${number}`, kind, rev: 4, askedAt, client: "claude-code", offer: [], ask: "…", answer: null, ...how });
  const ends = [{ status: "waiting" }, ...READ_AS.map(answered), { status: "allowed", allowedBy: "settings" }, { status: "allowed", allowedBy: "chat" }, { status: "lapsed", lapsedAt: at, lapsedRev: 5 }];
  const state = (count, stops, extra = {}) => ({ brief: brief(count), plan: { steps: [] }, stops, nextStop: stops.length + 1, checked: null, stopAsking: null, ...extra });

  // No stop asked: B1's lines, unchanged.
  assert.deepEqual(statusLines(state(0, []), video(false), rules("ask")), ["direction: no brief lines, no playback · replies 0/10", "step: save ask and about"]);
  // The F9 lines the API cannot reach (a lapsed round is replaced by the re-ask).
  assert.deepEqual(statusLines(state(5, [round(2, "rough", { status: "lapsed", lapsedAt: at, lapsedRev: 5 })]), video(false), rules("ask")),
    ["direction: C2 rough lapsed · replies 5/10", "step: check, then ask rough again"]);
  assert.deepEqual(statusLines(state(5, [round(2, "rough", { status: "waiting" })]), video(false), rules("ask")),
    ["direction: C2 rough waiting since 14:02 · replies 5/10", "step: end your turn until they answer"]);

  // Every kind, every way a round ends, ids up to C999, 0 to 200 replies, both rules, footage or
  // not, "stop asking" or not, a plan or not, with or without earlier stops passed.
  let widest = "";
  let shapes = 0;
  for (const [index, kind] of STOP_KINDS.entries()) for (const end of ends) for (const number of [1, 9, 99, 999]) for (const count of [0, 1, 9, 10, 99, 100, 200])
    for (const policy of ["ask", "allow"]) for (const footage of [false, true]) for (const stopping of [false, true]) for (const planned of [false, true]) for (const earlier of [false, true]) {
      const before = earlier ? STOP_KINDS.slice(0, index).map((other, place) => round(place + 1, other, answered("approve"))) : [];
      const latest = round(Math.max(number, before.length + 1), kind, end);
      const extra = { plan: { steps: planned ? [{ text: "Build", done: false }] : [] }, stopAsking: stopping ? { stop: "C1", words: "stop asking", at, client: "claude-code", undoneAt: null } : null };
      const lines = statusLines(state(count, [...before, latest], extra), video(footage), rules(policy));
      assert.equal(lines.length, 2);
      assert.ok(lines[0].startsWith("direction: ") && lines[1].startsWith("step: "), lines.join("\n"));
      const text = lines.join("\n");
      assert.ok(estimateTextTokens(text) <= 40, `about ${estimateTextTokens(text)} tokens (limit 40):\n${text}`);
      if (text.length > widest.length) widest = text;
      shapes += 1;
    }
  console.log(`direction and next with stops: widest ${widest.length} characters, about ${estimateTextTokens(widest)} tokens over ${shapes} states:\n${widest}`);
});
