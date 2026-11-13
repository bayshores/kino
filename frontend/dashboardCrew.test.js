// The crew screen's data (frontend/dashboard/crewRows.js): the tree in "1 crew", the bots' moods,
// the detail's words, the lanes of "3 last 10 min" built from the crew's own data, your own
// marks, and the screen's keys. backend/crew.test.mjs checks crewTable, crewDetail, crewHolds,
// crewMarks and crewCounts against a real crew.
import assert from "node:assert/strict";
import test from "node:test";
import {
  agoWords, clockOf, crewDetail, crewLaneRows, crewLanesSummary, crewMembers, crewMood, crewCard, crewTable, crewTree, LANE_MS, planOf, plainSummary, RUN_GAP_MS, withSavedAgents, yourMarks,
} from "./dashboard/crewRows.js";
import { parseCommand, keyAction } from "./dashboard/keys.js";

const NOW = Date.parse("2026-10-25T10:42:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const ago = (seconds) => iso(NOW - seconds * 1000);

// A crew as backend/agent/crew.mjs view() gives it: Nova (your own lead), Juno and Atlas (her
// helpers), Orion (a timer).
function member(id, name, color, extra = {}) {
  return {
    id, name, color, kind: "claude-code", kindWords: "claude code", role: "lead", leadId: null, launched: false,
    startedBy: { type: "you", id: null, name: "you" }, startedAt: ago(300), task: "", because: null, may: "all", mayWords: "everything",
    budget: null, spent: { calls: 0, ms: null }, state: "idle", stateWords: "idle", heldBy: null, holding: [], waitingFor: [],
    projectId: "p", last: null, lastAt: null, handedBack: null, endedAt: null, endReason: null, process: null, calls: [], ...extra,
  };
}
const call = (seconds, write, extra = {}) => ({ at: ago(seconds), ms: 1000, write, error: false, ...extra });

function crewData(extra = {}) {
  const nova = member("a1", "Nova", "#42c0b6", {
    state: "working", stateWords: "editing", holding: [{ projectId: "p", key: "layer:s1/g1", label: "hero-5 caption" }],
    // Three edits close together (one run), a look, then a later edit after a long gap.
    calls: [call(500, true), call(495, true), call(488, true), call(480, false), call(100, true), call(700, true)],
    last: { verb: "edit", label: "edit hero-5 caption", summary: "rev 4", write: true },
  });
  const juno = member("k2", "Juno", "#6cb6ff", {
    role: "helper", leadId: "a1", launched: true, startedBy: { type: "agent", id: "a1", name: "Nova" }, startedAt: ago(240),
    task: "looking for 3 reference edits", because: { by: "Nova", text: "find fast-cut walking edits" }, may: "look", mayWords: "look and search only; no edits",
    budget: { calls: 40, minutes: 10 }, spent: { calls: 12, ms: 130_000 }, state: "looking", stateWords: "looking",
    calls: [call(200, false, { verb: "library" }), call(190, false, { verb: "look" }), call(20, false, { verb: "render" })], last: { verb: "library", label: "search \"walking tour, fast cuts\"", summary: "{\"status\":\"awaiting_approval\",\"id\":\"Q2\",\"summary\":\"x" },
  });
  const atlas = member("k3", "Atlas", "#a8d95b", {
    role: "helper", leadId: "a1", launched: true, startedBy: { type: "agent", id: "a1", name: "Nova" }, startedAt: ago(200),
    state: "needs-you", stateWords: "needs you", holding: [{ projectId: "p", key: "music", label: "music" }], handedBack: { at: ago(30), text: "found 14" },
  });
  const orion = member("k4", "Orion", "#efe3c2", { role: "timer", launched: true, state: "asleep", stateWords: "asleep", schedule: { daily: "06:00" }, scheduleWords: "06:00", nextRunAt: "2026-10-26T06:00:00" });
  return {
    projectId: "p",
    calls: [],
    approvals: [
      { id: "Q1", status: "pending", agent: { id: "k3" }, createdAt: ago(60) },
      { id: "Q0", status: "allowed", agent: { id: "a1" }, createdAt: ago(400), answeredAt: ago(380) },
    ],
    agent: { turns: [], stops: null },
    hold: { on: false },
    crew: {
      now: iso(NOW), rules: { you: true, notes: false, leads: { on: true, helpers: 3 }, timers: true, atOnce: 4, budget: { calls: 60, minutes: 15 }, kind: "claude-code" },
      members: [nova, juno, atlas, orion], locks: [], counts: { working: 2, needsYou: 1, held: 0 }, canStart: { "claude-code": true, codex: false },
      activity: [
        { id: 1, at: ago(240), type: "started", agentId: "k2", text: "Juno started by Nova" },
        { id: 2, at: ago(200), type: "started", agentId: "k3", text: "Atlas started by Nova" },
        { id: 3, at: ago(150), type: "note", agentId: null, by: "you", text: "keep the caption off the faces" },
        { id: 4, at: ago(120), type: "held", agentId: "k2", by: "you", text: "you held Juno" },
        { id: 5, at: ago(90), type: "released", agentId: "k2", by: "you", text: "you released Juno" },
        { id: 6, at: ago(30), type: "handed-back", agentId: "k3", text: "found 14" },
      ],
    },
    ...extra,
  };
}

test("the crew tree: leads and timers on the first level, helpers under their lead", () => {
  const rows = crewTable(crewData());
  assert.deepEqual(rows.map((row) => row.name), ["you", "Nova", "Juno", "Atlas", "Orion"]);
  assert.deepEqual(crewTree(rows), ["", "├", "│ ├", "│ └", "└"]);
  // Under the last lead there is no line down the left.
  assert.deepEqual(crewTree([{ depth: 0 }, { depth: 1, last: true }, { depth: 2, last: true }]), ["", "└", "  └"]);
  assert.equal(rows[4].startedBy, "06:00");
  assert.equal(rows[3].doing, "needs you");
});

test("each crew state has a bot mood; the hold of all writes holds the agents at work", () => {
  const moods = crewData().crew.members.map((entry) => crewMood(entry));
  assert.deepEqual(moods, ["work", "look", "wait", "sleep"]);
  assert.equal(crewMood({ state: "working" }, true), "held");
  assert.equal(crewMood({ state: "asleep" }, true), "sleep");
  assert.equal(crewMood({ state: "held" }), "held");
  assert.equal(crewMood(null), "idle");
});

test("the detail says who started it how long ago, its budget as shares, and its last call in words", () => {
  const data = crewData();
  const juno = crewDetail(data.crew.members[1], NOW);
  assert.equal(juno.title, "looking for 3 reference edits");
  assert.equal(juno.started, "started by Nova, 4 min ago");
  assert.equal(juno.because, 'Nova: "find fast-cut walking edits"');
  assert.equal(juno.spent.callsText, "12 / 40 calls");
  assert.equal(juno.spent.callsShare, 0.3);
  assert.equal(juno.spent.timeText, "2:10 / 10 min");
  assert.ok(Math.abs(juno.spent.timeShare - 130 / 600) < 1e-9);
  // The last line names the call; its answer (JSON, cut short, still read as words) is the tooltip.
  assert.equal(juno.last, 'library search "walking tour, fast cuts"');
  assert.equal(juno.lastAnswer, "waits for you (Q2)");
  assert.equal(crewDetail(data.crew.members[3], NOW).started, "a timer, daily at 06:00");
  assert.equal(crewDetail(data.crew.members[2], NOW).handedBack, "found 14");
  assert.equal(crewDetail(null), null);
  assert.equal(plainSummary("rev 4"), "rev 4");
  assert.equal(plainSummary('{"text":"done"}'), "done");
  assert.deepEqual(["just now", "40 s ago", "4 min ago", "2 h ago", "3 d ago"],
    [5, 40, 245, 7300, 3 * 86_400].map((seconds) => agoWords(ago(seconds), NOW)));
  assert.match(clockOf("2026-10-26T06:00:00"), /^06:00$/);
});

test("the lanes: runs of calls, requests to you, held stretches, starts and hand-backs", () => {
  const data = crewData();
  const lanes = crewLaneRows(data, crewTable(data), NOW);
  assert.equal(lanes.end - lanes.start, LANE_MS);
  assert.deepEqual(lanes.lanes.map((lane) => lane.name), ["Nova", "Juno", "Atlas", "Orion"]);
  const [nova, juno, atlas, orion] = lanes.lanes;
  // 700 s ago is outside the window; the three edits 500–488 s ago are one run (gaps under
  // RUN_GAP_MS), the look on its own, the edit 100 s ago another run.
  assert.ok(RUN_GAP_MS >= 8000);
  assert.deepEqual(nova.blocks.map((block) => block.kind), ["edit", "look", "edit"]);
  assert.ok(Math.abs(nova.blocks[0].x - 99 / 600) < 1e-9, "the run starts when its first call started (501 s ago)");
  assert.ok(Math.abs(nova.blocks[0].width - 13 / 600) < 1e-9, "and ends when its last call ended (488 s ago)");
  // A run is labeled by its verbs; a render is its own kind (a thin bar on the lane).
  assert.deepEqual(juno.blocks.map((block) => [block.kind, block.label]), [["look", "library · look"], ["render", "render"]]);
  // Atlas's open request runs to now and says "needs you"; Nova's answered one is faint.
  assert.deepEqual(atlas.waits.map((wait) => [wait.open, wait.label]), [[true, "needs you"]]);
  assert.ok(Math.abs(atlas.waits[0].x + atlas.waits[0].width - 1) < 1e-9);
  assert.deepEqual(nova.waits.map((wait) => [wait.open, wait.label]), [[false, "allowed"]]);
  // You held Juno from 120 s to 90 s ago.
  assert.equal(juno.held.length, 1);
  assert.ok(Math.abs(juno.held[0].x - 480 / 600) < 1e-9);
  assert.ok(Math.abs(juno.held[0].width - 30 / 600) < 1e-9);
  // Started marks on the helpers' lanes, with a line from Nova's lane; Atlas's hand-back is a ◆
  // on Nova's lane, with a line from Atlas's.
  assert.deepEqual(juno.marks.map((mark) => mark.type), ["started"]);
  assert.deepEqual(atlas.marks.map((mark) => mark.type), ["started"]);
  assert.deepEqual(nova.marks.map((mark) => [mark.type, mark.color]), [["handed-back", "#a8d95b"]]);
  assert.deepEqual(lanes.links.map((link) => [link.type, link.from, link.to]), [["started", 0, 1], ["started", 0, 2], ["handed-back", 2, 0]]);
  assert.match(orion.note, /^Orion runs again at \d\d:\d\d$/);
  // Your lane: the note, the hold and release of Juno, and the request you allowed.
  assert.deepEqual(lanes.you.map((mark) => mark.word), ["allow", "note", "hold", "release"]);
  assert.equal(crewLanesSummary(lanes),
    "Last 10 minutes. you: allow, note, hold, release; Nova: 2 edit runs, 1 look run, a helper handed back; Juno: 1 look run, 1 render; Atlas: needs you; Orion: Orion runs again at 06:00".replace("06:00", clockOf("2026-10-26T06:00:00")) + ".");
});

test("a timer shows why it will not run while timers may not start agents", () => {
  const data = crewData();
  data.crew.rules.timers = false;
  data.crew.members[3].nextRunAt = null;
  const lanes = crewLaneRows(data, crewTable(data), NOW);
  assert.equal(lanes.lanes[3].note, "Orion waits: timers may not start agents");
});

test("your marks: your calls, your answers, your stop answers and the hold", () => {
  const extra = {
    calls: [{ at: ago(50), by: "you", verb: "notes" }, { at: ago(40), by: "you", verb: "history" }],
    approvals: [
      { id: "Q1", status: "allowed", answeredAt: ago(30) },
      { id: "Q2", status: "canceled", answeredAt: ago(20) },
      { id: "Q3", status: "denied", answeredAt: ago(900) },
    ],
    agent: { turns: [], stops: { rounds: [{ id: "C1", answer: { via: "dashboard", at: ago(15) } }, { id: "C2", answer: { via: "chat", at: ago(12) } }] } },
    hold: { on: true, since: ago(10) },
  };
  const marks = yourMarks(extra, NOW - LANE_MS, NOW);
  assert.deepEqual(marks.map((mark) => mark.word), ["note", "undo", "allow", "stop", "hold"]);
});

test("F2 opens the crew screen and F1 the stage, from any screen; the command line knows crew", () => {
  assert.equal(keyAction({ key: "F2" }), "crew");
  assert.equal(keyAction({ key: "F1" }, { screen: "crew" }), "stage");
  assert.equal(keyAction({ key: "F2" }, { screen: "projects" }), "crew");
  assert.equal(keyAction({ key: "F2" }, { typing: true }), "crew"); // F keys type nothing, so they work from a text field too
  assert.equal(keyAction({ key: "Escape" }, { screen: "crew" }), "back");
  // The crew screen's own letters (h x s t r H) are not the dashboard's there.
  for (const key of ["h", "x", "s", "t", "r", "H"]) assert.equal(keyAction({ key }, { screen: "crew" }), null);
  assert.deepEqual(parseCommand("crew"), { action: "crew" });
});

test("after a restart the crew shows the agents of the project's saved calls, and the counts agree with the F2 tab", () => {
  // kino restarted: the crew knows no agent (it keeps only the ones it started), but the project
  // saved Nova's and Juno's calls, and Nova's final render (Q16) still waits for you.
  const nova = { id: "a1", name: "Nova", color: "#42c0b6", kind: "cli" };
  const juno = { id: "a2", name: "Juno", color: "#6cb6ff", kind: "cli" };
  const data = {
    projectId: "promo-demo", agents: [],
    crew: { members: [], locks: [], activity: [], counts: { working: 0, needsYou: 0, held: 0 }, rules: null },
    approvals: [{ id: "Q16", status: "pending", kind: "final-render", client: "cli", agent: { ...nova, boot: "old" } }],
    calls: [
      { verb: "look", label: "look at 163.0 s", summary: "frame s1 @163s", at: ago(3 * 3600), agent: juno },
      { verb: "render", label: "wait for Q16", approval: "Q16", summary: "{\"id\":\"Q16\",\"status\":\"awaiting_approval\"}", at: ago(3500), agent: nova },
      { verb: "edit", label: "move title-card", at: ago(200), ms: 1500, agent: nova },
      { verb: "notes", label: "my note", by: "you", at: ago(100), agent: { id: "you", name: "you" } },
    ],
  };
  const members = crewMembers(data, NOW);
  assert.deepEqual(members.map((entry) => [entry.name, entry.state, entry.fromCalls]), [["Nova", "needs-you", true], ["Juno", "idle", true]], "newest call first; not you; Juno (same client) did not ask");
  const rows = crewTable(withSavedAgents(data, NOW));
  assert.deepEqual(rows.map((row) => [row.name, row.startedBy, row.doing, row.holding]), [["you", "", "", ""], ["Nova", "you", "needs you", "-"], ["Juno", "you", "idle", "-"]]);
  // Its detail: what F1 says, started by you (it connected on its own), its saved calls, its last call and when.
  const detail = crewDetail(members[0], NOW);
  assert.equal(detail.title, "ready for you");
  assert.equal(detail.started, "started by you");
  assert.equal(detail.spent.callsText, "2 calls");
  assert.equal(detail.spent.timeText, "");
  assert.equal(detail.last, "edit move title-card, 3 min ago");
  // Its lane has its calls of the last 10 minutes.
  const lanes = crewLaneRows(withSavedAgents(data, NOW), rows, NOW);
  assert.deepEqual(lanes.lanes.map((lane) => [lane.name, lane.blocks.length]), [["Nova", 1], ["Juno", 0]]);
  // An agent the crew knows (connected again, or started by kino) is not listed twice.
  const known = { ...data, crew: { ...data.crew, members: [member("a1", "Nova", "#42c0b6", { state: "working", stateWords: "editing" })] } };
  assert.deepEqual(crewMembers(known, NOW).map((entry) => entry.name), ["Nova", "Juno"]);
  // No crew data (an older server): nothing to add to.
  assert.equal(withSavedAgents({ calls: data.calls }, NOW).crew, undefined);
});

test("an agent card: the plan's step bars for a lead on the open project, and what it does now", () => {
  const data = crewData({ agent: { turns: [], stops: null, plan: { steps: [{ text: "brief", done: true }, "sound pass", "render"] } } });
  const [nova, juno] = data.crew.members;
  const plan = planOf(nova, data);
  assert.deepEqual(plan.map((step) => step.done), [true, false, false]);
  assert.equal(planOf(juno, data), null, "a helper has no plan of its own");
  assert.equal(planOf({ ...nova, projectId: "other" }, data), null, "nor a lead on another project");
  assert.deepEqual(crewCard(nova, plan), { steps: ["done", "now", "next"], stepText: "step 2/3", now: "edit: edit hero-5 caption" });
  assert.deepEqual(crewCard({ ...nova, state: "idle", stateWords: "idle" }, null), { steps: null, stepText: "", now: "idle" });
});
