// The dashboard's live view of the agents (milestone LIVE, panes part): presence in the data,
// agents keyed by id, waits matched to the right agent, the status line's words for several
// agents, the quiet notification's rule, the pointing line, and the ruler's time range.
import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAgents, activeAgentsText, agentRows, applyEvent, dragPoint, fromSnapshot, pointingLine, pointRange,
  quietAgents, quietToTell, rangeText, rulerSeconds, stepPoint, timeText, WORKING_MS,
} from "./dashboard/state.js";

const T0 = Date.parse("2026-10-25T10:42:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const nova = { id: "a1", name: "Nova", color: "#42c0b6", kind: "claude-code" };
const juno = { id: "a2", name: "Juno", color: "#6cb6ff", kind: "claude-code" };

const presence = (agent, call, phase, extra = {}) => ({
  agent, call, phase, verb: "look", label: "look at 1.0–2.0 s", write: false,
  target: { sceneId: "intro", sceneName: "intro", layerIds: [], time: null, range: [1, 2], text: "1.0–2.0 s" },
  changed: null, building: [], turn: "T1", isError: false, ms: null, ...extra,
});

function snapshot(extra = {}) {
  return {
    boot: "b1", seq: 1, projects: [{ id: "p1", name: "p1" }], current: "p1", projectId: "p1",
    record: null, events: [], approvals: [], renders: [], agents: [],
    agent: { plan: null, notes: [], turns: [{ id: "T1", calls: 1, edits: [] }], codes: {}, brief: null, stops: null },
    now: iso(T0), presence: { latest: [], building: [] }, ...extra,
  };
}

test("the snapshot's presence becomes data.live: one per agent (the newest), with its time and the clock skew", () => {
  const latest = [
    { ...presence(nova, 5, "done"), at: iso(T0 - 1000) },
    { ...presence(juno, 4, "start"), at: iso(T0 - 2000) },
    { ...presence(nova, 3, "done"), at: iso(T0 - 3000) },
    presence({ id: "a3", name: "Atlas", color: "#a8d95b", kind: "codex" }, 2, "done"),
  ];
  const building = [{ sceneId: "intro", layerId: "k1", agentId: "a1", at: iso(T0 - 1000) }];
  const state = fromSnapshot(snapshot({ presence: { latest, building } }), null, T0 + 2500);
  assert.deepEqual(Object.keys(state.live.latest).sort(), ["a1", "a2"], "an entry without a time is left out");
  assert.equal(state.live.latest.a1.call, 5, "the newest presence of Nova");
  assert.equal(state.live.latest.a1.at, iso(T0 - 1000));
  assert.equal(state.live.skew, 2500, "this computer's clock is 2.5 s ahead of the server's");
  assert.deepEqual(state.live.building, building);
  // An older server sends no presence and no time: live is empty, with no skew.
  const old = fromSnapshot({ ...snapshot(), now: undefined, presence: undefined }, null, T0);
  assert.deepEqual(old.live, { latest: {}, building: [], skew: 0 });
});

test("a presence event replaces the agent's older one, keeps the building marks of the open project, and leaves with the agent", () => {
  let state = fromSnapshot(snapshot(), null, T0);
  const building = [{ sceneId: "intro", layerId: "k1", agentId: "a1", at: iso(T0) }];
  state = applyEvent(state, { type: "presence", seq: 2, at: iso(T0 + 100), projectId: "p1", presence: presence(nova, 7, "start") });
  assert.equal(state.live.latest.a1.phase, "start");
  assert.equal(state.live.latest.a1.at, iso(T0 + 100), "stamped with the event's time");
  assert.equal(agentRows(state, T0 + 200)[0].status, "working", "a call that started is work");
  state = applyEvent(state, { type: "presence", seq: 3, at: iso(T0 + 900), projectId: "p1", presence: presence(nova, 7, "done", { building }) });
  assert.equal(state.live.latest.a1.phase, "done");
  assert.deepEqual(state.live.building, building);
  // Calls side by side: an older call that ends while a newer one runs leaves the newer one on
  // screen, with the agent's count of running calls from the older one's end.
  const side = applyEvent(state, { type: "presence", seq: 4, at: iso(T0 + 920), projectId: "p1", presence: presence(nova, 8, "start", { running: 2 }) });
  const late = applyEvent(side, { type: "presence", seq: 5, at: iso(T0 + 950), projectId: "p1", presence: presence(nova, 6, "done", { running: 1 }) });
  assert.equal(late.live.latest.a1.call, 8);
  assert.equal(late.live.latest.a1.phase, "start");
  assert.equal(late.live.latest.a1.running, 1);
  // Once the newer one is done too, the event that came last is shown.
  const after = applyEvent(late, { type: "presence", seq: 6, at: iso(T0 + 990), projectId: "p1", presence: presence(nova, 8, "done", { running: 0 }) });
  assert.equal(after.live.latest.a1.call, 8);
  assert.equal(after.live.latest.a1.running, 0);
  // A call with no project (project list) shows, and leaves the building marks alone.
  state = applyEvent(state, { type: "presence", seq: 5, at: iso(T0 + 1000), projectId: null, presence: presence(juno, 8, "start", { target: null, building: [] }) });
  assert.equal(state.live.latest.a2.call, 8);
  assert.deepEqual(state.live.building, building);
  // Juno moves to another project: it leaves this stage.
  state = applyEvent(state, { type: "presence", seq: 6, at: iso(T0 + 1100), projectId: "p2", presence: presence(juno, 9, "start") });
  assert.equal(state.live.latest.a2, undefined);
  assert.deepEqual(state.live.building, building, "another project's marks never come here");
  // An event with no agent changes nothing in live.
  assert.equal(applyEvent(state, { type: "presence", seq: 7, at: iso(T0), projectId: "p1", presence: {} }).live, state.live);
});

test("agents are keyed by id: two sessions of one client are two agents; an entry without an id is its client's", () => {
  let state = fromSnapshot(snapshot(), null, T0);
  const call = (seq, agent, extra = {}) => applyEvent(state, { type: "call", seq, projectId: "p1", event: { verb: "look", at: iso(T0 + seq), client: "claude-code", turn: "T1", ...(agent ? { agent } : {}), ...extra } });
  state = call(2, nova);
  state = call(3, juno);
  state = call(4, nova);
  state = call(5, null, { client: "codex" });
  assert.deepEqual(state.agents.map((agent) => agent.id), ["a1", "a2", "legacy-codex"]);
  assert.deepEqual(state.agents.map((agent) => agent.name), ["Nova", "Juno", "codex"]);
  assert.equal(state.agents[0].lastAt, iso(T0 + 4), "the same session updates its row");
  assert.equal(state.agents[0].color, "#42c0b6");
  assert.equal(state.agents[0].kind, "claude-code");
  // The server's own legacy identity (no session) keeps its kind for the waits below.
  state = call(6, { id: "legacy-test-agent", name: "agent", color: "#42c0b6", kind: "test-agent" }, { client: "test-agent" });
  assert.equal(state.agents.at(-1).kind, "test-agent");
  // Rows of an older snapshot ({name, lastAt}) get an id and a kind.
  const old = fromSnapshot(snapshot({ agents: [{ name: "claude", lastAt: iso(T0), lastVerb: "look" }] }), null, T0);
  assert.deepEqual([old.agents[0].id, old.agents[0].kind], ["legacy-claude", "claude"]);
});

test("waits are matched by the agent's id when they carry one, and by client = kind when they do not", () => {
  const agents = [{ ...nova, lastAt: iso(T0), lastVerb: "look" }, { ...juno, lastAt: iso(T0 - 1), lastVerb: "edit" }];
  const statusOf = (state) => Object.fromEntries(agentRows(state, T0 + 1000).map((agent) => [agent.name, agent.status]));
  const approval = { id: "R1", status: "pending", client: "claude-code", summary: "share" };
  assert.deepEqual(statusOf(fromSnapshot(snapshot({ agents, approvals: [{ ...approval, agent: juno }] }), null, T0)), { Nova: "working", Juno: "needs-you" });
  assert.deepEqual(statusOf(fromSnapshot(snapshot({ agents, approvals: [approval] }), null, T0)), { Nova: "needs-you", Juno: "needs-you" }, "an older approval names only the client");
  const stops = (round) => ({ waiting: round, rounds: [round] });
  const round = { id: "C1", kind: "brief", status: "waiting", client: "claude-code", askedAt: iso(T0) };
  const withStop = (value) => fromSnapshot(snapshot({ agents, agent: { ...snapshot().agent, stops: stops(value) } }), null, T0);
  assert.deepEqual(statusOf(withStop({ ...round, agentId: "a1" })), { Nova: "needs-you", Juno: "working" });
  assert.deepEqual(statusOf(withStop(round)), { Nova: "needs-you", Juno: "needs-you" });
  // In another project too.
  const elsewhere = fromSnapshot(snapshot({ agents, waitingStops: { p2: { ...round, agentId: "a2" } }, projects: [{ id: "p1" }, { id: "p2", name: "other" }] }), null, T0);
  assert.deepEqual(statusOf(elsewhere), { Nova: "working", Juno: "needs-you" });
});

test("a wait saved in another server run is matched by client, not by an id another agent may have now", () => {
  const agents = [{ ...nova, lastAt: iso(T0), lastVerb: "look" }, { ...juno, lastAt: iso(T0 - 1), lastVerb: "edit" }];
  const statusOf = (state) => Object.fromEntries(agentRows(state, T0 + 1000).map((agent) => [agent.name, agent.status]));
  const approval = { id: "R1", status: "pending", client: "claude-code", summary: "share" };
  // The snapshot's boot is "b1".
  assert.deepEqual(statusOf(fromSnapshot(snapshot({ agents, approvals: [{ ...approval, agent: { ...juno, boot: "b1" } }] }), null, T0)), { Nova: "working", Juno: "needs-you" });
  assert.deepEqual(statusOf(fromSnapshot(snapshot({ agents, approvals: [{ ...approval, agent: { ...juno, boot: "b0" } }] }), null, T0)), { Nova: "needs-you", Juno: "needs-you" },
    "asked before a restart: a2 may be another agent now");
  const round = { id: "C1", kind: "brief", status: "waiting", client: "claude-code", askedAt: iso(T0), agentId: "a1" };
  const withStop = (value) => fromSnapshot(snapshot({ agents, agent: { ...snapshot().agent, stops: { waiting: value, rounds: [value] } } }), null, T0);
  assert.deepEqual(statusOf(withStop({ ...round, agentBoot: "b1" })), { Nova: "needs-you", Juno: "working" });
  assert.deepEqual(statusOf(withStop({ ...round, agentBoot: "b0" })), { Nova: "needs-you", Juno: "needs-you" });
});

test("a call you approved is not the agent calling, and a building event replaces the open project's marks", () => {
  let state = fromSnapshot(snapshot({ agents: [{ ...juno, lastAt: iso(T0 - 5000), lastVerb: "look" }] }), null, T0);
  state = applyEvent(state, { type: "call", seq: 2, projectId: "p1", event: { verb: "project", at: iso(T0), client: "dashboard", turn: "T1", approved: "R1", agent: juno } });
  assert.equal(state.agents.find((agent) => agent.id === "a2").lastAt, iso(T0 - 5000), "the replay does not make Juno look busy");
  const building = [{ sceneId: "intro", layerId: "k1", agentId: "a1", at: iso(T0) }];
  state = applyEvent(state, { type: "presence", seq: 3, at: iso(T0 + 100), projectId: "p1", presence: presence(nova, 7, "done", { building }) });
  assert.deepEqual(state.live.building, building);
  assert.deepEqual(applyEvent(state, { type: "building", seq: 4, projectId: "p2", building: [] }).live.building, building, "another project's");
  state = applyEvent(state, { type: "building", seq: 5, projectId: "p1", building: [] });
  assert.deepEqual(state.live.building, [], "your undo ended the turn");
});

test("the status line names the agents when more than one called in the last 20 s", () => {
  const atlas = { id: "a3", name: "Atlas", color: "#a8d95b", kind: "codex" };
  const agents = [{ ...nova, lastAt: iso(T0) }, { ...juno, lastAt: iso(T0 - 5000) }, { ...atlas, lastAt: iso(T0 - WORKING_MS - 1000) }];
  const state = fromSnapshot(snapshot({ agents }), null, T0);
  const active = activeAgents(state, T0 + 1000);
  assert.deepEqual(active.map((agent) => agent.name), ["Nova", "Juno"], "Atlas called 21 s ago: not active");
  assert.equal(activeAgentsText(active), "2 agents · Nova · Juno");
  assert.equal(activeAgentsText(active.slice(0, 1)), null, "one agent keeps today's line");
  assert.equal(activeAgentsText([]), null);
  assert.deepEqual(activeAgents(state, T0 + WORKING_MS + 1).map((agent) => agent.name), [], "all quiet 20 s later");
  // Review round 2: an agent that waits for you or failed says so after its name; the line never
  // reads as if every agent were at work.
  const blocked = fromSnapshot(snapshot({
    agents: [{ ...nova, lastAt: iso(T0) }, { ...juno, lastAt: iso(T0 - 5000), isError: true }],
    approvals: [{ id: "R1", status: "pending", client: "claude-code", agent: nova }],
  }), null, T0);
  const shown = activeAgents(blocked, T0 + 1000);
  assert.deepEqual(shown.map((agent) => agent.status), ["needs-you", "failed"]);
  assert.equal(activeAgentsText(shown), "2 agents · Nova needs you · Juno failed");
  assert.equal(activeAgentsText([{ ...shown[0], status: "working" }, shown[1]]), "2 agents · Nova · Juno failed", "a working agent shows only its name");
});

test("an agent goes quiet 30 s after its last call in this turn ended, once, and not while it runs or waits, nor after 2 min", () => {
  const done = { ...presence(nova, 9, "done"), at: iso(T0) };
  const state = fromSnapshot(snapshot({ presence: { latest: [done], building: [] } }), null, T0);
  assert.deepEqual(quietAgents(state, T0 + 29_000), [], "29 s: not yet");
  const [row] = quietAgents(state, T0 + 31_000);
  assert.equal(row.agent.id, "a1");
  assert.equal(row.text, "Nova went quiet · look at 1.0–2.0 s");
  assert.deepEqual(quietAgents(state, T0 + 120_000), [], "2 min: the turn is over");
  // Once per quiet spell: the same call is told one time.
  const told = new Set();
  assert.equal(quietToTell(state, T0 + 31_000, told).length, 1);
  assert.equal(quietToTell(state, T0 + 36_000, told).length, 0);
  // Review round 2: ids and call numbers start over when the server restarts, so the same a1 and
  // call 9 under a new boot is another call: it is told.
  const restarted = fromSnapshot(snapshot({ boot: "b2", presence: { latest: [done], building: [] } }), null, T0);
  assert.equal(quietToTell(restarted, T0 + 31_000, told).length, 1, "a new server run's call is told");
  // The skew moves the clock to the server's: 31 s on the server is 33 s here when this clock is 2 s ahead.
  const ahead = fromSnapshot(snapshot({ presence: { latest: [done], building: [] } }), null, T0 + 2000);
  assert.deepEqual(quietAgents(ahead, T0 + 31_000), [], "31 s here is 29 s on the server");
  assert.equal(quietAgents(ahead, T0 + 33_000).length, 1);
  // Running: its newest presence is a start.
  const running = fromSnapshot(snapshot({ presence: { latest: [{ ...presence(nova, 10, "start"), at: iso(T0) }], building: [] } }), null, T0);
  assert.deepEqual(quietAgents(running, T0 + 60_000), [], "a long call is not quiet");
  // Its newest call is done, but another one it runs side by side is not.
  const beside = fromSnapshot(snapshot({ presence: { latest: [{ ...done, running: 1 }], building: [] } }), null, T0);
  assert.deepEqual(quietAgents(beside, T0 + 60_000), [], "a call still runs beside it");
  // Waiting: an approval or a stop waits for it.
  const asked = fromSnapshot(snapshot({ presence: { latest: [done], building: [] }, approvals: [{ id: "R1", status: "pending", client: "claude-code", agent: nova }] }), null, T0);
  assert.deepEqual(quietAgents(asked, T0 + 60_000), [], "it waits for you, it is not quiet");
  const stop = { waiting: { id: "C1", kind: "brief", status: "waiting", client: "claude-code", agentId: "a1" }, rounds: [] };
  const stopped = fromSnapshot(snapshot({ presence: { latest: [done], building: [] }, agent: { ...snapshot().agent, stops: stop } }), null, T0);
  assert.deepEqual(quietAgents(stopped, T0 + 60_000), []);
  // A call from an older turn is not this turn's.
  const older = fromSnapshot(snapshot({ presence: { latest: [{ ...done, turn: "T0" }], building: [] } }), null, T0);
  assert.deepEqual(quietAgents(older, T0 + 60_000), []);
});

test("the pointing line is the server's line, word for word, and the times read as the agent reads them", () => {
  assert.equal(pointingLine({ sceneId: "intro", layerIds: ["k1"], range: null, line: "card (you selected it in the dashboard)" }), 'the agent sees "pointing card (you selected it in the dashboard)"');
  assert.equal(pointingLine({ sceneId: "intro", layerIds: [], range: [2, 3.5], line: "2.0–3.5 s in S1 (you selected it in the dashboard)" }), 'the agent sees "pointing 2.0–3.5 s in S1 (you selected it in the dashboard)"');
  assert.equal(pointingLine(null), null);
  assert.equal(pointingLine({ sceneId: "intro", layerIds: [] }), null, "no line: nothing is claimed");
  assert.deepEqual([timeText(2), timeText(1.25), timeText(3.5), timeText(0), timeText(0.1 + 0.2)], ["2.0", "1.25", "3.5", "0.0", "0.3"]);
  assert.equal(rangeText([2, 3.5]), "2.0–3.5 s");
});

test("the ruler: a drag of 4 px or more points at a range, in seconds inside the scene; Shift+arrows move its end from the playhead", () => {
  // A ruler 600 px wide at x 100, for a 6 s scene: 100 px a second.
  assert.equal(rulerSeconds(300, 100, 600, 6), 2);
  assert.equal(rulerSeconds(350.4, 100, 600, 6), 2.5, "to 0.01 s");
  assert.equal(rulerSeconds(40, 100, 600, 6), 0, "left of the ruler is 0");
  assert.equal(rulerSeconds(900, 100, 600, 6), 6, "right of it is the scene's end");
  assert.equal(rulerSeconds(300, 100, 0, 6), 0, "a ruler not laid out yet");
  assert.equal(dragPoint(300, 303, 100, 600, 6), null, "3 px is a click: it sets the time");
  assert.deepEqual(dragPoint(300, 304, 100, 600, 6), { anchor: 2, end: 2.04 });
  assert.deepEqual(dragPoint(450, 250, 100, 600, 6), { anchor: 3.5, end: 1.5 });
  assert.deepEqual(pointRange({ anchor: 3.5, end: 1.5 }), [1.5, 3.5], "in order");
  assert.deepEqual(pointRange(dragPoint(650, 1200, 100, 600, 6)), [5.5, 6], "clamped to the scene");
  assert.equal(pointRange({ anchor: 2, end: 2 }), null, "no width, no range");
  assert.equal(pointRange(null), null);
  // Shift+→ from the playhead at 2 s, three times; Shift+← once.
  let point = null;
  for (let index = 0; index < 3; index += 1) point = stepPoint(point, { time: 2, duration: 6, step: 0.1 });
  assert.deepEqual(pointRange(point), [2, 2.3]);
  point = stepPoint(point, { time: 4, duration: 6, step: -0.1 });
  assert.deepEqual(pointRange(point), [2, 2.2], "the end moves; the playhead only starts a range");
  assert.deepEqual(stepPoint({ anchor: 5.95, end: 5.95 }, { time: 0, duration: 6, step: 0.1 }), { anchor: 5.95, end: 6 }, "never past the end");
  assert.deepEqual(stepPoint(null, { time: 0, duration: 6, step: -0.1 }), { anchor: 0, end: 0 }, "never before 0");
});
