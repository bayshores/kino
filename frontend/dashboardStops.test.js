// The stops on the dashboard (direction plan §6, milestone B2b), as plain data: the stop screen's
// keys, the "needs you" order, every stop line, which rounds can be reopened, what each answer
// sends, and how the stream's stops events and a waiting stop reach the title and agents.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STOP_RULES, SKIP_FIELDS, STOP_KINDS as SERVER_STOP_KINDS, STOP_LABELS } from "../backend/agent/stops.mjs";
import { answerStop, boardPageUrl, keepAsking, reopenStop } from "./dashboard/api.js";
import { timeOfDay } from "./dashboard/format.js";
import { KEY_HELP, keyAction } from "./dashboard/keys.js";
import { agentRows, applyEvent, attention, fromSnapshot, keyTarget, movedNeedWords, needKey, needsShift, needsYouRows, offerWords, otherStops, stopAnswer, stopAnswered, stopChanges, stopFootnote, stopRows, typedSeconds, waitingStopOf } from "./dashboard/state.js";
import { READ_WORDS, STOP_DEFAULT_SKIP, STOP_KINDS, STOP_SKIP_FIELDS, STOP_WORDS } from "./dashboard/words.js";

const press = (key, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
// Times on this computer's clock, so the HH:MM the lines show do not depend on the time zone.
const at = (hours, minutes, seconds = 0) => new Date(2026, 9, 21, hours, minutes, seconds).toISOString();

const round = (fields = {}) => ({ id: "C2", kind: "rough", rev: 4, askedAt: at(14, 2), client: "claude-code", status: "waiting", offer: [], answer: null, ...fields });
const chat = (fields = {}) => ({ via: "chat", words: "looks good", read_as: "approve", at: at(14, 5), client: "claude-code", afterSeconds: 42, ...fields });
const dashboard = (fields = {}) => ({ via: "dashboard", words: null, read_as: "approve", at: at(14, 5), client: "dashboard", afterSeconds: 42, ...fields });
const ask = "The rough cut is ready (C2): 24 s, 1080×1920.\nChecked: 0 errors · 0 warnings.\nWhat did you notice, and what would you change?\nReply: approve · approve with notes: ... · redo: ...";

// The dashboard's data for project p1 with these stops (agent.stops, stopsSummary on the server).
function withStops(stops, { calls = [], approvals = [], agents = [], waitingStops = undefined } = {}) {
  return fromSnapshot({
    boot: "b1", seq: 1, projects: [{ id: "p1" }, { id: "p2", name: "Park video" }], current: "p1", projectId: "p1",
    agent: { plan: null, notes: [], turns: [], codes: {}, brief: null, stops: { waiting: null, rounds: [], stopAsking: null, ...stops } },
    events: calls, approvals, agents, renders: [], waitingStops,
  });
}
const waitingOn = (fields = {}) => {
  const waiting = round({ ask, ...fields });
  const { ask: _ask, ...listed } = waiting;
  return { waiting, rounds: [listed] };
};

test("on the stop screen a approves, idle Tab adds a note, d asks for a redo, and A and D only say they are off", () => {
  const stop = (key, context = {}) => keyAction(press(key.key ?? key, key.key ? key : {}), { screen: "stop", ...context });
  assert.equal(stop("a"), "stop-approve");
  assert.equal(stop("d"), "stop-redo");
  assert.equal(stop("Tab", { idle: true }), "stop-note", "Tab with nothing focused goes to the note");
  assert.equal(stop({ key: "Tab", shiftKey: true }, { idle: true }), null, "Shift+Tab keeps its own job");
  assert.equal(stop("Tab", { idle: false }), null, "Tab from a button goes on to the next one");
  assert.equal(stop("A"), "stop-always-off");
  assert.equal(stop("D"), "stop-always-off");
  // Typing in the note turns the letters off; Esc leaves the field, then the screen.
  assert.equal(stop("a", { typing: true }), null);
  assert.equal(stop("d", { typing: true }), null);
  assert.equal(stop("Tab", { typing: true, idle: false }), null);
  assert.equal(stop("Escape", { typing: true }), "back");
  assert.equal(stop("Escape"), "back");
  assert.equal(stop("?"), "help");
  assert.equal(stop("u"), null, "undo is not a stop key");
  assert.equal(stop("1"), null, "pane keys only on the main screen");
});

test("the other screens' keys are unchanged: no clash with the stop screen", () => {
  const expected = {
    main: { a: "allow", A: "allow-always", d: "deny", D: "deny-always", Tab: null, Enter: "open", j: "down" },
    approval: { a: "allow", A: "allow-always", d: "deny", D: "deny-always", Tab: "approval-note", Enter: "open" },
    variants: { a: null, d: null, 1: "pick-1", r: "reject", Tab: null },
    projects: { a: null, d: null, y: "duplicate", Delete: "archive", Tab: null },
    turn: { a: null, d: null, u: "undo", Tab: null },
  };
  for (const [screen, keys] of Object.entries(expected)) {
    for (const [key, action] of Object.entries(keys)) assert.equal(keyAction(press(key), { screen, idle: true }), action, `${screen} ${key}`);
  }
});

test("the keys screen lists the stop keys after d D", () => {
  const keys = KEY_HELP.map(([key]) => key);
  assert.equal(keys.indexOf("a Tab d c"), keys.indexOf("d D") + 1);
  assert.deepEqual(KEY_HELP[keys.indexOf("a Tab d c")], ["a Tab d c", "on a stop: approve, approve with a note, redo with a note, a note on one shot (A, D off)"]);
  assert.equal(new Set(keys).size, keys.length, "each key row once");
});

test("the dashboard's stop kinds, words, settings fields and defaults are the server's", () => {
  assert.deepEqual(STOP_KINDS, [...SERVER_STOP_KINDS]);
  assert.deepEqual(STOP_SKIP_FIELDS, { ...SKIP_FIELDS });
  assert.deepEqual(STOP_DEFAULT_SKIP, { ...DEFAULT_STOP_RULES.skipUnder });
  for (const kind of STOP_KINDS) assert.equal(`the ${STOP_WORDS[kind]}`, STOP_LABELS[kind]);
  assert.deepEqual(Object.keys(READ_WORDS), ["approve", "approve with notes", "redo", "stop asking"]);
});

test("timeOfDay is this computer's 24-hour clock", () => {
  assert.equal(timeOfDay(at(14, 2)), "14:02");
  assert.equal(timeOfDay(at(9, 5, 59)), "09:05");
  assert.equal(timeOfDay(at(0, 0)), "00:00");
  assert.equal(timeOfDay(null), "");
  assert.equal(timeOfDay("not a time"), "");
});

test("needs you lists the waiting stop first, then the requests; the title and the agents count it", () => {
  const approvals = [{ id: "Q1", status: "pending", client: "codex" }, { id: "Q2", status: "allowed", client: "codex" }];
  const agents = [{ name: "claude-code", lastAt: at(13, 0), lastVerb: "notes" }, { name: "codex", lastAt: at(13, 1), lastVerb: "render" }, { name: "other", lastAt: at(12, 0), lastVerb: "look" }];
  const state = withStops(waitingOn(), { approvals, agents });
  assert.deepEqual(needsYouRows(state).map((row) => [row.type, row.round?.id ?? row.approval.id]), [["stop", "C2"], ["approval", "Q1"]]);
  assert.equal(needsYouRows(state)[0].round.ask, ask, "the row has the ask for its dim line");
  assert.equal(waitingStopOf(state).id, "C2");
  const needs = attention(state);
  assert.equal(needs.count, 2, "the stop and the pending request");
  assert.equal(needs.stop.id, "C2");
  const status = Object.fromEntries(agentRows(state, Date.parse(at(13, 2))).map((agent) => [agent.name, agent.status]));
  assert.deepEqual(status, { "claude-code": "needs-you", codex: "needs-you", other: "idle" });
  // No stop waiting: only the requests.
  const answered = withStops({ rounds: [round({ status: "answered", answer: chat() })] }, { approvals, agents });
  assert.deepEqual(needsYouRows(answered).map((row) => row.type), ["approval"]);
  assert.equal(attention(answered).count, 1);
  assert.equal(attention(answered).stop, null);
  assert.equal(agentRows(answered, Date.parse(at(13, 2))).find((agent) => agent.name === "claude-code").status, "idle");
  assert.deepEqual(needsYouRows(withStops({})), []);
});

test("a stops event replaces the open project's stops only", () => {
  const state = withStops({});
  const stops = waitingOn();
  const here = applyEvent(state, { seq: 2, type: "stops", projectId: "p1", stops });
  assert.equal(here.agent.stops, stops);
  assert.equal(here.agent.plan, state.agent.plan, "the rest of the agent data stays");
  const other = applyEvent(state, { seq: 3, type: "stops", projectId: "p2", stops });
  assert.equal(other.agent, state.agent, "another project's stops do not show here");
  assert.equal(other.seq, 3);
  assert.equal(applyEvent(here, { seq: 2, type: "stops", projectId: "p1", stops: { waiting: null, rounds: [], stopAsking: null } }), here, "an old event is skipped");
  // A snapshot without agent data (no project) has no stops.
  assert.equal(fromSnapshot({ boot: "b", seq: 0 }).agent.stops, null);
  assert.deepEqual(stopRows(fromSnapshot({ boot: "b", seq: 0 })), []);
});

test("every stop line reads as the plan says, newest first", () => {
  const line = (fields, extra) => stopRows(withStops({ rounds: [round(fields)] }, extra))[0];
  assert.equal(line({}).text, "C2 rough cut · waits for you since 14:02");
  assert.equal(line({ status: "answered", answer: chat() }).text, 'C2 rough cut · approved in chat: "looks good" · 42 s after asking · 14:05 · recorded by the agent');
  assert.equal(line({ kind: "sound", status: "answered", answer: chat({ words: "looks good, but keep the title a little higher", read_as: "approve with notes" }) }).text,
    'C2 sound pass · approved with notes in chat: "looks good, but keep the title a little higher" · 42 s after asking · 14:05 · recorded by the agent');
  assert.equal(line({ status: "answered", answer: chat({ words: "the title is too small", read_as: "redo" }) }).text,
    'C2 rough cut · redo in chat: "the title is too small" · 42 s after asking · 14:05 · recorded by the agent');
  assert.equal(line({ status: "answered", answer: chat() }).note, null, "a chat answer was recorded by the agent's own call");
  // A dashboard answer: no quote without a note, and whether the agent has heard it yet.
  const approved = line({ status: "answered", answer: dashboard() });
  assert.equal(approved.text, "C2 rough cut · approved on the dashboard · 42 s after asking · 14:05");
  assert.equal(approved.note, 'tell your agent "go on": it hears your answer with its next call');
  assert.equal(line({ status: "answered", answer: dashboard({ read_as: "redo", words: "the ding is too loud", afterSeconds: 3 }) }).text,
    'C2 rough cut · redo on the dashboard: "the ding is too loud" · 3 s after asking · 14:05');
  // The server marks the answer heardAt when the agent's next call takes it from the inbox.
  assert.equal(line({ status: "answered", answer: dashboard({ heardAt: at(14, 7) }) }).note, "the agent has your answer (14:07)");
  // Allowed, lapsed and reopened.
  assert.equal(line({ id: "C3", kind: "color", status: "allowed", allowedBy: "settings", allowedAt: at(14, 10) }).text, "C3 color pass · allowed by your settings · 14:10");
  assert.equal(line({ id: "C3", kind: "color", status: "allowed", allowedBy: "chat", allowedAt: at(14, 10) }).text, 'C3 color pass · allowed by "stop asking" · 14:10');
  assert.equal(line({ id: "C1", status: "lapsed", lapsedAt: at(14, 3), lapsedRev: 5 }).text, "C1 rough cut · lapsed: the work changed after it was asked (rev 4, then rev 5)");
  assert.equal(line({ id: "C1", status: "lapsed", lapsedAt: at(14, 3), lapsedRev: 4, lapsedFor: "under 15 s" }).text, "C1 rough cut · lapsed: this video has no rough cut stop now (under 15 s)");
  assert.equal(line({ status: "reopened", reopenedAt: at(14, 9), answer: chat() }).text, 'C2 rough cut · reopened 14:09 (was: approved in chat: "looks good"); the agent asks again');
  assert.equal(line({ status: "reopened", reopenedAt: at(14, 9), answer: dashboard() }).text, "C2 rough cut · reopened 14:09 (was: approved on the dashboard); the agent asks again");
  // At most 5 rounds, newest first.
  const many = Array.from({ length: 7 }, (_, index) => round({ id: `C${index + 1}`, kind: STOP_KINDS[index % 4], status: "allowed", allowedBy: "settings", allowedAt: at(14, index) }));
  assert.deepEqual(stopRows(withStops({ rounds: many })).map((row) => row.id), ["C7", "C6", "C5", "C4", "C3"]);
});

test('"stop asking" shows at the top while it is on, with keep asking, and says when it was undone', () => {
  const rounds = [round({ id: "C1", status: "answered", answer: chat({ words: "just go, stop asking", read_as: "stop asking" }) }), round({ id: "C2", kind: "color", status: "allowed", allowedBy: "chat", allowedAt: at(14, 10) })];
  const on = stopRows(withStops({ rounds, stopAsking: { stop: "C1", words: "just go, stop asking", at: at(14, 5), undoneAt: null } }));
  assert.equal(on[0].text, 'stop asking: rough, color and sound pass for this video · said in chat: "just go, stop asking" · recorded by the agent');
  assert.equal(on[0].keepAsking, true);
  assert.deepEqual(on.slice(1).map((row) => row.id), ["C2", "C1"]);
  assert.ok(on.slice(1).every((row) => !row.keepAsking));
  const undone = stopRows(withStops({ rounds, stopAsking: { stop: "C1", words: "just go, stop asking", at: at(14, 5), undoneAt: at(14, 12) } }));
  assert.equal(undone[0].text, "stop asking undone 14:12: rough, color and sound ask again");
  assert.equal(undone[0].keepAsking, false);
  assert.ok(!stopRows(withStops({ rounds })).some((row) => row.key === "stop-asking"), "no line when it was never said");
});

test("reopen is on an answered round with no later round of its kind, and says what it does", () => {
  const rounds = [
    round({ id: "C1", status: "answered", answer: chat({ words: "the title is too small", read_as: "redo" }) }),
    round({ id: "C2", status: "answered", answer: chat({ words: "warmer, but fine", read_as: "approve with notes" }) }),
    round({ id: "C3", kind: "color", status: "allowed", allowedBy: "settings", allowedAt: at(14, 10) }),
    round({ id: "C4", kind: "sound", status: "answered", answer: dashboard() }),
  ];
  const rows = Object.fromEntries(stopRows(withStops({ rounds })).map((row) => [row.id, row]));
  assert.equal(rows.C1.reopen, null, "C2 is a later round of the rough cut");
  assert.equal(rows.C3.reopen, null, "an allowed round is not reopened (settings decide it)");
  assert.deepEqual(rows.C2.reopen, {
    label: 'Reopen C2: the agent recorded "warmer, but fine" as approve with notes. kino tells it to ask you again.',
    question: 'Reopen C2 (the rough cut)? The agent recorded "warmer, but fine" as approve with notes. kino tells it to ask you again.',
  });
  assert.deepEqual(rows.C4.reopen, {
    label: "Reopen C4: take back your answer (approve). kino tells the agent to ask you again.",
    question: "Reopen C4 (the sound pass)? You take back your answer (approve). kino tells the agent to ask you again.",
  });
  for (const status of [{}, { status: "lapsed", lapsedRev: 5 }, { status: "reopened", reopenedAt: at(14, 9), answer: chat() }, { status: "allowed", allowedBy: "chat" }]) {
    assert.equal(stopRows(withStops({ rounds: [round(status)] }))[0].reopen, null, JSON.stringify(status));
  }
  // Reopening "stop asking" also turns the stops back on, and the question says so.
  const asking = stopRows(withStops({ rounds: [round({ status: "answered", answer: chat({ words: "stop asking", read_as: "stop asking" }) })] }))[0];
  assert.match(asking.reopen.question, / The rough cut, color and sound stops ask again for this video\.$/);
  // A long chat answer is cut in the question, never in its line.
  const long = "x".repeat(600);
  const cut = stopRows(withStops({ rounds: [round({ status: "answered", answer: chat({ words: long }) })] }))[0];
  assert.ok(cut.text.includes(long));
  assert.ok(cut.reopen.label.length < 400 && cut.reopen.question.length < 400);
});

test("what each answer sends: approve, approve with a note and redo with a note", () => {
  const waiting = round();
  assert.deepEqual(stopAnswer(waiting, { press: "approve" }), { send: { id: "C2", rev: 4, read_as: "approve" } });
  assert.deepEqual(stopAnswer(waiting, { press: "approve", text: "  warmer  " }), { send: { id: "C2", rev: 4, read_as: "approve with notes", words: "warmer" } },
    "typed words are never dropped");
  assert.deepEqual(stopAnswer(waiting, { press: "approve", mode: "redo", text: "redo the title" }), { send: { id: "C2", rev: 4, read_as: "approve with notes", words: "redo the title" } });
  // The note buttons (and Tab, d) send when the note has text, else put the cursor in it.
  assert.deepEqual(stopAnswer(waiting, { press: "notes", text: "warmer" }), { send: { id: "C2", rev: 4, read_as: "approve with notes", words: "warmer" } });
  assert.deepEqual(stopAnswer(waiting, { press: "notes", text: "  " }), { focus: "notes" });
  assert.deepEqual(stopAnswer(waiting, { press: "redo", text: "the ding is too loud" }), { send: { id: "C2", rev: 4, read_as: "redo", words: "the ding is too loud" } });
  assert.deepEqual(stopAnswer(waiting, { press: "redo", mode: "notes", text: "" }), { focus: "redo" });
  // Enter in the note sends in the note's mode; an empty note says what is missing.
  assert.deepEqual(stopAnswer(waiting, { press: "enter", mode: "notes", text: "warmer" }), { send: { id: "C2", rev: 4, read_as: "approve with notes", words: "warmer" } });
  assert.deepEqual(stopAnswer(waiting, { press: "enter", mode: "redo", text: "louder" }), { send: { id: "C2", rev: 4, read_as: "redo", words: "louder" } });
  assert.deepEqual(stopAnswer(waiting, { press: "enter", mode: "redo", text: "" }), { error: "Say what to redo first: type it in the note, then press Enter." });
  assert.ok(stopAnswer(waiting, { press: "enter", mode: "notes", text: " " }).error);
  // What the dashboard says after kino took it.
  const go = ' Tell your agent "go on": it hears your answer with its next call.';
  assert.equal(stopAnswered({ id: "C2", read_as: "approve" }), `C2 approved.${go}`);
  assert.equal(stopAnswered({ id: "C2", read_as: "approve with notes" }), `C2 approved with your note.${go}`);
  assert.equal(stopAnswered({ id: "C2", read_as: "redo" }), `C2: redo sent with your note.${go}`);
});

test("the stop requests go to POST /api/dashboard/stops with the review key", async () => {
  const sent = [];
  const original = { fetch: globalThis.fetch, location: globalThis.location };
  globalThis.location = new URL("http://127.0.0.1:4173/");
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    const reply = String(url).endsWith("/review-key") ? { key: "k1" } : { stops: { waiting: null, rounds: [], stopAsking: null } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await answerStop("p1", stopAnswer(round(), { press: "approve" }).send);
    await answerStop("p1", stopAnswer(round(), { press: "redo", text: "louder" }).send);
    await reopenStop("p1", "C2");
    await keepAsking("p1");
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.location = original.location;
  }
  const stops = sent.filter((entry) => entry.url === "/api/dashboard/stops");
  assert.ok(stops.every((entry) => entry.method === "POST" && entry.headers["x-kino-review"] === "k1"));
  assert.deepEqual(stops.map((entry) => entry.body), [
    { project: "p1", action: "answer", id: "C2", rev: 4, read_as: "approve" },
    { project: "p1", action: "answer", id: "C2", rev: 4, read_as: "redo", words: "louder" },
    { project: "p1", action: "reopen", id: "C2" },
    { project: "p1", action: "keep_asking" },
  ]);
});

test("a storyboard stop's card asks for the board's pages of the revision the stop showed", () => {
  assert.equal(boardPageUrl({ projectId: "p 1", rev: 4, page: 2 }), "/api/dashboard/board?project=p+1&rev=4&page=2");
});

test("a stop that starts waiting and an answer recorded from the chat are news; the first load is not", () => {
  const first = stopChanges(null, withStops(waitingOn()));
  assert.equal(first.asked, null, "the first load says nothing");
  assert.deepEqual(first.chat, []);
  let known = stopChanges(null, withStops({})).known;
  const asked = stopChanges(known, withStops(waitingOn()));
  assert.equal(asked.asked.id, "C2");
  assert.equal(asked.asked.ask, ask);
  known = asked.known;
  assert.equal(stopChanges(known, withStops(waitingOn())).asked, null, "the same waiting stop is not news twice");
  const words = `looks good, but keep the title a little higher ${"and more ".repeat(20)}`;
  const answered = stopChanges(known, withStops({ rounds: [round({ status: "answered", answer: chat({ words, read_as: "approve with notes" }) })] }));
  assert.equal(answered.asked, null);
  assert.equal(answered.chat.length, 1);
  assert.match(answered.chat[0].text, /^C2 approved with notes in chat \(recorded by the agent\): "looks good, but keep the title a little higher and more/);
  assert.ok(answered.chat[0].text.length <= 120 + 60, "the words are cut to 120");
  // A dashboard answer is yours: not announced as the agent's record.
  assert.deepEqual(stopChanges(known, withStops({ rounds: [round({ status: "answered", answer: dashboard() })] })).chat, []);
  // Another project's waiting stop is news when it first shows (follow agent, or opening it).
  const elsewhere = { ...withStops(waitingOn()), projectId: "p2" };
  assert.equal(stopChanges(known, elsewhere).asked.id, "C2");
});

test("the ask's offer is named in words", () => {
  assert.equal(offerWords([]), "");
  assert.equal(offerWords(["sound"]), "the sound check");
  assert.equal(offerWords(["color", "sound"]), "the color and sound checks");
});

// ---- review round 1 of B2b ---------------------------------------------------------------------

test("whether the agent heard a dashboard answer comes from the server (heardAt), never from the times of its calls", () => {
  const heard = (answer, calls) => stopRows(withStops({ rounds: [round({ status: "answered", answer })] }, { calls }))[0].note;
  const go = 'tell your agent "go on": it hears your answer with its next call';
  // A call stamped after the answer (the wall clock jumped ahead here) does not mean it took the inbox.
  assert.equal(heard(dashboard(), [{ verb: "status", at: at(14, 7), client: "claude-code" }]), go);
  // A call stamped before the answer (the wall clock stepped back) that took it does.
  assert.equal(heard(dashboard({ heardAt: at(14, 4) }), [{ verb: "status", at: at(14, 4), client: "claude-code" }]), "the agent has your answer (14:04)");
});

test("a stop waiting in a project that is not open shows in needs you, the title, the agents and the stream keeps it", () => {
  const p2 = round({ id: "C1", ask });
  const agents = [{ name: "claude-code", lastAt: at(14, 1), lastVerb: "notes", projectId: "p2" }];
  const approvals = [{ id: "Q1", status: "pending", client: "codex" }];
  // From the snapshot (another project open).
  const state = withStops({}, { waitingStops: { p2 }, agents, approvals });
  assert.deepEqual(otherStops(state), [{ projectId: "p2", name: "Park video", round: p2 }]);
  assert.deepEqual(needsYouRows(state).map((row) => [row.type, row.round?.id ?? row.approval.id, row.projectId ?? null]), [["elsewhere", "C1", "p2"], ["approval", "Q1", null]]);
  assert.equal(waitingStopOf(state), null, "not the open project's stop: it is answered once that project is open");
  assert.equal(attention(state).count, 2);
  assert.equal(agentRows(state, Date.parse(at(14, 2)))[0].status, "needs-you");
  // The open project's own stop is not listed twice.
  assert.deepEqual(otherStops(withStops(waitingOn(), { waitingStops: { p1: round({ ask }) } })), []);
  // From the stream: a call in p2 carries p2's stops, then a stops event answers it.
  const fresh = withStops({}, { agents });
  const asked = applyEvent(fresh, { seq: 2, type: "call", projectId: "p2", event: { verb: "notes", at: at(14, 1), client: "claude-code" }, agent: { stops: { waiting: p2, rounds: [], stopAsking: null } } });
  assert.equal(asked.agent, fresh.agent, "the open project's agent data stays");
  assert.deepEqual(needsYouRows(asked).map((row) => row.type), ["elsewhere"]);
  assert.equal(attention(asked).count, 1);
  const answered = applyEvent(asked, { seq: 3, type: "stops", projectId: "p2", stops: { waiting: null, rounds: [], stopAsking: null } });
  assert.deepEqual(needsYouRows(answered), []);
  assert.equal(attention(answered).count, 0);
});

test("reopening while a later stop waits says that stop closes; a stop closed by a reopen says so", () => {
  const rounds = [round({ id: "C1", status: "answered", answer: dashboard() }), round({ id: "C2", kind: "color" })];
  const waiting = round({ id: "C2", kind: "color", ask });
  const rows = Object.fromEntries(stopRows(withStops({ waiting, rounds })).map((row) => [row.id, row]));
  assert.equal(rows.C1.reopen.question, "Reopen C1 (the rough cut)? You take back your answer (approve). kino tells the agent to ask you again. C2 color pass, which waits now, closes.");
  const closed = stopRows(withStops({ rounds: [round({ id: "C1", status: "reopened", reopenedAt: at(14, 9), answer: dashboard() }), round({ id: "C2", kind: "color", status: "lapsed", lapsedAt: at(14, 9), lapsedBy: "C1" })] }));
  assert.equal(closed[0].text, "C2 color pass · lapsed: you reopened C1");
});

test("the stop lines say that answers in chat are recorded by the agent and cannot be checked", () => {
  const chatRows = stopRows(withStops({ rounds: [round({ status: "answered", answer: chat({ words: "looks good but warmer", read_as: "approve with notes" }) })] }));
  assert.equal(chatRows[0].recorded, true);
  assert.equal(stopFootnote(chatRows), "answers in chat are recorded by the agent; kino cannot check them: reopen one that is not what you said");
  const stopped = stopRows(withStops({ rounds: [round({ status: "allowed", allowedBy: "settings", allowedAt: at(14, 10) })], stopAsking: { stop: "C1", words: "stop asking", at: at(14, 5), undoneAt: null } }));
  assert.ok(stopFootnote(stopped), '"stop asking" was recorded by the agent too');
  assert.equal(stopFootnote(stopRows(withStops({ rounds: [round({ status: "answered", answer: dashboard() })] }))), null, "your own answers need no footnote");
  assert.equal(stopFootnote([]), null);
});

test("the round that stopped waiting is news (closed): answered here or in the chat, or closed", () => {
  const known = stopChanges(null, withStops(waitingOn())).known;
  assert.equal(stopChanges(known, withStops({ rounds: [round({ status: "answered", answer: chat() })] })).closed.id, "C2");
  assert.equal(stopChanges(known, withStops({ rounds: [round({ status: "answered", answer: dashboard() })] })).closed.id, "C2");
  assert.equal(stopChanges(known, withStops({ rounds: [round({ status: "lapsed", lapsedRev: 5 })] })).closed.id, "C2");
  assert.equal(stopChanges(known, withStops(waitingOn())).closed, null, "still waiting");
  assert.equal(stopChanges(null, withStops({ rounds: [round({ status: "answered", answer: chat() })] })).closed, null, "the first load says nothing");
});

// ---- review round 2 of B2b ---------------------------------------------------------------------

test("a, d, A and D skip a stop in another project when pane 1 does not have the focus: they reach the requests", () => {
  const approvals = [{ id: "Q1", status: "pending", client: "codex", summary: "render final mp4, 720 frames" }];
  const rows = needsYouRows(withStops({}, { waitingStops: { p2: round({ id: "C2", ask }) }, approvals }));
  assert.deepEqual(rows.map(needKey), ["elsewhere/p2/C2", "approval/Q1"]);
  assert.equal(keyTarget(rows), 1, "the request, not the stop that is answered in p2");
  assert.equal(keyTarget(rows, 0), 0, "pane 1's cursor row when it has the focus");
  assert.equal(keyTarget([rows[0]]), 0, "only a stop elsewhere: that row says to open p2");
  assert.equal(keyTarget([]), -1);
  // The open project's stop is still first.
  assert.deepEqual(needsYouRows(withStops(waitingOn(), { approvals })).map(needKey), ["stop/p1/C2", "approval/Q1"]);
});

test("when needs you changes under the person, the cursor keeps its row, and a row the keys did not act on before is named first", () => {
  const stop = (id) => ({ type: "stop", projectId: "p1", round: round({ id }) });
  const request = (id) => ({ type: "approval", approval: { id, status: "pending", summary: "render final mp4, 720 frames" } });
  // The stop is answered in the chat: the request moves up under the key.
  assert.deepEqual(needsShift([stop("C5"), request("Q2")], [request("Q2")], 0), { cursor: 0, moved: "approval/Q2" });
  assert.deepEqual(needsShift([stop("C5"), request("Q2")], [request("Q2")]), { cursor: null, moved: "approval/Q2" });
  // A new stop comes first: the cursor stays on the request it was on; without the cursor, the
  // first row is the stop now, which the person did not choose.
  assert.deepEqual(needsShift([request("Q1")], [stop("C6"), request("Q1")], 0), { cursor: 1, moved: null });
  assert.deepEqual(needsShift([request("Q1")], [stop("C6"), request("Q1")]), { cursor: null, moved: "stop/p1/C6" });
  // A change below the row the keys act on, or a first row in an empty list, moves nothing.
  assert.deepEqual(needsShift([request("Q1")], [request("Q1"), request("Q3")]), { cursor: null, moved: null });
  assert.deepEqual(needsShift([], [request("Q1")]), { cursor: null, moved: null });
  assert.deepEqual(needsShift([stop("C5")], [], 0), { cursor: 0, moved: null }, "nothing left to act on");
  // What the key says instead of answering.
  assert.equal(movedNeedWords(request("Q2"), "allow"), '"needs you" changed, so nothing was answered: a now acts on Q2 (render final mp4, 720 frames). Press a again to allow it once.');
  assert.equal(movedNeedWords(request("Q2"), "allow-always"), '"needs you" changed, so nothing was answered: A now acts on Q2 (render final mp4, 720 frames). Press A again to always allow it.');
  assert.equal(movedNeedWords(stop("C6"), "allow"), '"needs you" changed, so nothing was answered: a now acts on C6 rough cut. Press a again to approve it.');
});

test("opening another project announces no stop that was already waiting: not the one left behind, nor the one opened", () => {
  const p1Waits = withStops(waitingOn({ id: "C1" }));
  let known = stopChanges(null, p1Waits).known;
  known = stopChanges(known, p1Waits).known;
  // p2 opened: p1's C1, which was on screen, now shows as a stop in another project.
  const p2Open = { ...withStops({}, { waitingStops: { p1: round({ id: "C1", ask }) } }), projectId: "p2" };
  const left = stopChanges(known, p2Open);
  assert.deepEqual([left.asked, left.elsewhere], [null, []], "C1 in p1 is not news");
  // p2's own C2 was announced as a stop elsewhere; opening p2 does not announce it again.
  const p1WithP2 = withStops(waitingOn({ id: "C1" }), { waitingStops: { p2: round({ id: "C2", ask }) } });
  const seen = stopChanges(known, p1WithP2);
  assert.deepEqual(seen.elsewhere.map((entry) => entry.round.id), ["C2"], "a stop elsewhere is news when it first shows");
  const p2Waits = { ...withStops(waitingOn({ id: "C2" }), { waitingStops: { p1: round({ id: "C1", ask }) } }), projectId: "p2" };
  const opened = stopChanges(seen.known, p2Waits);
  assert.deepEqual([opened.asked, opened.elsewhere], [null, []], "nothing is announced as new");
});

test("a skip-under length is sent as typed: a decimal is never rounded, so the server's refusal shows", () => {
  assert.equal(typedSeconds("7.5"), 7.5);
  assert.equal(typedSeconds("20"), 20);
  assert.equal(typedSeconds(""), "");
  assert.equal(typedSeconds("abc"), "abc");
});
