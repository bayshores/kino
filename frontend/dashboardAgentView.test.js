// The F1 agent pane's facts (frontend/dashboard/agentView.js): which agent it shows, its task and plan
// step, its log of calls with their answers' lines, what it said (why, next), and the words of
// the orange "needs you" line and the action strip under the stage.
import test from "node:test";
import assert from "node:assert/strict";
import { agentLabels, withAgentLabels } from "./dashboard/agentLabels.js";
import { agentGoal, canWake, agentLog, asAsk, asSentence, agentOfCalls, agentSaid, agentTask, CREW_MS, crewAgents, crewFeed, currentCall, DETAIL_CHARS, leftWords, paneIdle, railAgents, renderDock, SEEN_MS, seenNow, minutes, needWords, planStep, shownAgent, specWords, stepWords, turnWords, usefulDetails, verbKind, voiceLine } from "./dashboard/agentView.js";

const NOW = Date.parse("2026-10-26T10:00:30Z");
const nova = { id: "a1", name: "Nova", kind: "claude-code", color: "#42c0b6", lastAt: "2026-10-26T10:00:20Z" };
const juno = { id: "a2", name: "Juno", kind: "codex", color: "#e0b050", lastAt: "2026-10-26T09:00:00Z" };
const by = (agent) => ({ agent: { id: agent.id, name: agent.name, color: agent.color, kind: agent.kind } });

function data(extra = {}) {
  return {
    projectId: "walk", agents: [nova, juno], approvals: [],
    agent: { plan: { steps: [{ text: "lay the footage", done: true }, { text: "cut walk + phone", done: false }, { text: "render", done: false }] }, turns: [{ id: "T19", edits: [{ before: 4, after: 5, ops: 56 }] }] },
    calls: [
      { verb: "edit", label: "footage behind 4 sections", rev: 5, at: "2026-10-26T10:00:01Z", why: "lay it down", next: "look at it", details: ["created clip-1 → L1"], ...by(nova) },
      { verb: "look", label: "sheet 0:00–1:00", at: "2026-10-26T10:00:10Z", ...by(nova) },
      { verb: "check", label: "the video", isError: true, at: "2026-10-26T10:00:15Z", ...by(nova) },
      { verb: "look", label: "frame", at: "2026-10-26T10:00:16Z", ...by(juno) },
      { verb: "edit", label: "my own", by: "you", at: "2026-10-26T10:00:17Z", ...by(nova) },
    ],
    live: { latest: {} },
    ...extra,
  };
}

test("the pane shows the agent at work now: the newest presence, else the newest call", () => {
  assert.equal(shownAgent(data(), NOW).id, "a1");
  const live = { latest: { a2: { agent: { id: "a2" }, at: "2026-10-26T10:00:29Z", seq: 9, phase: "start", verb: "look", label: "frame at 2 s" } } };
  assert.equal(shownAgent(data({ live }), NOW).id, "a2");
  assert.equal(shownAgent({ agents: [] }, NOW), null);
  // After a restart no agent is connected, but the saved calls still name who worked here
  // (the newest call by an agent, never one of yours), shown as idle.
  const restarted = data({ agents: [] });
  assert.deepEqual(shownAgent(restarted, NOW), { id: "a2", name: "Juno", color: "#e0b050", kind: "codex", status: "idle", lastAt: "2026-10-26T10:00:16Z" });
  assert.equal(agentOfCalls(restarted, "a1").name, "Nova");
  assert.equal(agentOfCalls(restarted, "nobody"), null);
});

test("the task is the plan's step now, 'step 2 of 3', and 'ready for you' while its ask waits", () => {
  const step = planStep(data().agent.plan);
  assert.deepEqual(step, { index: 2, count: 3, text: "cut walk + phone", done: false });
  assert.equal(stepWords(step), "step 2 of 3");
  assert.equal(stepWords(planStep({ steps: [{ text: "a", done: true }] })), "all 1 steps done");
  assert.equal(stepWords(null), "");
  assert.equal(agentTask(data(), nova), "cut walk + phone");
  const asking = data({ approvals: [{ id: "Q1", status: "pending", kind: "final-render", agent: { id: "a1", name: "Nova" } }] });
  assert.equal(agentTask(asking, nova), "ready for you");
  // Without a plan step: working or idle, never the newest call (the log shows it).
  const live = { latest: { a1: { phase: "end", label: "check the video" } } };
  assert.equal(agentTask(data({ agent: {}, live }), nova, NOW), "working");
  assert.equal(agentTask(data({ agent: {}, live }), nova, NOW + 3_600_000), "idle");
  assert.equal(agentTask(data(), null), "no agent yet");
  assert.equal(turnWords(data()), "turn 19");
});

test("the log lists the agent's own calls with their results and answer lines, and the running call last", () => {
  const rows = agentLog(data(), nova);
  assert.deepEqual(rows.map((row) => row.verb), ["edit", "look", "check"], "not another agent's calls, not yours");
  assert.deepEqual(rows[0].result, { mark: "ops", text: "+56" });
  assert.deepEqual(rows[0].details, ["created clip-1 → L1"]);
  assert.equal(rows[0].kind, "write");
  assert.deepEqual(rows[1].result, { mark: "done", text: "✓" });
  assert.equal(rows[1].kind, "read");
  assert.deepEqual(rows[2].result, { mark: "failed", text: "✕" });
  assert.equal(rows[2].kind, "err");
  const live = { latest: { a1: { agent: { id: "a1" }, call: 7, at: "2026-10-26T10:00:29Z", phase: "start", verb: "edit", label: "walk + phone to one list" } } };
  const running = agentLog(data({ live }), nova).at(-1);
  assert.equal(running.current, true);
  assert.equal(running.text, "walk + phone to one list");
  assert.equal(running.result.mark, "running");
  assert.deepEqual(agentLog(data(), null), []);
  assert.equal(verbKind("render"), "write");
  assert.equal(verbKind("look", true), "err");
});

test("a run of the same call is one row with its count and time span; the label says what it waits for", () => {
  // As on the real project: the agent asked again and again while its render waited (Q16).
  const local = (hours, minutes) => new Date(2026, 9, 26, hours, minutes, 0).toISOString();
  const waits = Array.from({ length: 18 }, (_, index) => ({
    verb: "render", label: "wait for Q16", approval: "Q16", at: local(22, 27 + Math.floor(index / 6)), details: ["status awaiting_approval", "next The person answers in the kino dashboard. Allow it there."],
    summary: '{"id":"Q16","status":"awaiting_approval"}', ...by(nova),
  }));
  const calls = [{ verb: "look", label: "the whole scene", at: local(22, 26), ...by(nova) }, ...waits, { verb: "look", label: "the whole scene", at: local(22, 31), ...by(nova) }];
  const rows = agentLog(data({ calls }), nova);
  assert.equal(rows.length, 3, "18 waits are one row");
  assert.deepEqual([rows[1].at, rows[1].verb, rows[1].text, rows[1].count, rows[1].result.text], ["22:27–22:29", "render", "wait for Q16", 18, "waits"]);
  assert.deepEqual(rows[1].details, [], "a run shows no answer lines");
  assert.equal(rows[0].count, 1);
  assert.equal(rows[0].at, "22:26");
  // One wait alone: no span, its label without "· waits for your approval Q16" (the result says it),
  // and no advice lines ("next …").
  const one = agentLog(data({ calls: [waits[0]] }), nova)[0];
  assert.deepEqual([one.at, one.text, one.count, one.details], ["22:27", "wait for Q16", 1, []]);
  // Two calls of the same verb with other words stay two rows; the row cap counts rows, not calls.
  assert.equal(agentLog(data({ calls: [...waits, ...waits.map((call) => ({ ...call, label: "wait for Q17", approval: "Q17" }))] }), nova).length, 2);
  assert.equal(agentLog(data({ calls: Array.from({ length: 60 }, (_, index) => ({ verb: "look", label: `at ${index} s`, at: local(22, 0), ...by(nova) })) }), nova, 40).length, 40);
});

test("answer lines under a call are short facts: no advice to the agent, no lines without a number", () => {
  assert.deepEqual(usefulDetails(["beeps matched 158 / 158", "offset +1.04 s", "confidence 0.62", "more"]), ["beeps matched 158 / 158", "offset +1.04 s", "confidence 0.62"]);
  assert.deepEqual(usefulDetails(["next The person answers in the kino dashboard. Allow it there 2", "rules 3 of them", "warnings none", "created title → L1"]), ["created title → L1"]);
  const long = usefulDetails([`summary a final mp4 of s1 at rev 249 (10200 frames, over 600) and more words`])[0];
  assert.equal(long.length, DETAIL_CHARS);
  assert.ok(long.endsWith("…"));
  assert.deepEqual(usefulDetails(null), []);
});

test("an agent known from saved calls needs you while its approval waits, else it is idle", () => {
  const restarted = data({ agents: [], approvals: [{ id: "Q16", status: "pending", kind: "final-render", agent: { id: "a1", name: "Nova" } }] });
  assert.equal(agentOfCalls(restarted, "a1").status, "needs-you");
  assert.equal(agentOfCalls(restarted, "a2").status, "idle", "Juno did not ask");
});

test("why and next come from the running call, else the newest call that said them", () => {
  assert.deepEqual(agentSaid(data(), nova), { why: "lay it down", next: "look at it", at: "2026-10-26T10:00:01Z" });
  const live = { latest: { a1: { agent: { id: "a1" }, phase: "start", at: "2026-10-26T10:00:29Z", why: "one list for both", next: "ask you" } } };
  assert.deepEqual(agentSaid(data({ live }), nova), { why: "one list for both", next: "ask you", at: "2026-10-26T10:00:29Z" });
  assert.deepEqual(agentSaid(data(), juno), { why: "", next: "", at: null });
});

test("a waiting render reads as who asks, what to do, the keys' words and the render's facts", () => {
  assert.equal(minutes(170), "02:50");
  assert.equal(minutes(-1), "00:00");
  const spec = { seconds: 170, frames: 5100, fps: 30, format: "mp4", width: 1920, height: 1080 };
  assert.equal(specWords(spec), "02:50 1080p30 mp4 5,100 frames");
  assert.equal(specWords(null), "");
  const words = needWords({ type: "approval", approval: { id: "Q1", kind: "final-render", summary: "a final mp4", agent: { id: "a1", name: "Nova", color: "#42c0b6" }, spec } });
  assert.equal(words.who, "Nova");
  assert.equal(words.todo, "watch the preview, then allow the render");
  assert.equal(words.allow, "allow render");
  assert.equal(words.deny, "not yet");
  assert.equal(words.spec, "02:50 1080p30 mp4 5,100 frames");
  // A render and a stop are watched on the stage first; a share link is only answered.
  assert.equal(words.watch, true);
  assert.equal(needWords({ type: "approval", approval: { id: "Q2", kind: "share-link" } }).watch, false);
  const stop = needWords({ type: "stop", round: { id: "C1", kind: "storyboard", agentId: "a1", ask: "Look at the board\nmore" } }, (id) => (id === "a1" ? "Nova" : null));
  assert.equal(stop.who, "Nova");
  assert.equal(stop.deny, "redo");
  assert.equal(stop.summary, "Look at the board");
  assert.equal(stop.watch, true);
  // A storyboard has nothing built to watch: a opens the board, where it is approved.
  const board = needWords({ type: "stop", round: { id: "C1", kind: "board", ask: "The storyboard is ready (C1)" } });
  assert.deepEqual([board.allow, board.key, board.deny], ["review storyboard", "review", "redo"]);
  const elsewhere = needWords({ type: "elsewhere", name: "Other", round: { kind: "storyboard" } });
  assert.equal(elsewhere.allow, null, "a stop in another project is answered there");
  // A sketch round asks its own question; "see the sketches" opens them, and there is nothing to deny.
  const sketch = needWords({ type: "try", round: { id: "T1", sketch: true, question: "Three ways to open. Pick one." } });
  assert.deepEqual([sketch.todo, sketch.allow, sketch.deny], ["Three ways to open. Pick one.", "see the sketches", null]);
  assert.equal(needWords(null), null);
});

test("crew view: who works now, the idle rail, each card's goal and call, one merged feed", () => {
  // Nova called 10 s ago, Juno an hour ago: one agent at work, the pane stays open.
  assert.deepEqual(crewAgents(data(), NOW).map((agent) => agent.id), ["a1"]);
  assert.equal(paneIdle(data(), NOW), false);
  const later = NOW + CREW_MS + 1000;
  assert.equal(paneIdle(data(), later), true, "no call for 2 min: the pane folds to its rail");
  assert.equal(paneIdle(data({ approvals: [{ id: "Q1", status: "pending", kind: "final-render" }] }), later), false, "something waits for you");
  assert.deepEqual(railAgents(data()).map((agent) => [agent.name, agent.lastAt]), [["Juno", "2026-10-26T10:00:16Z"], ["Nova", "2026-10-26T10:00:15Z"]]);
  // A running call is the card's live line; without one, the newest call.
  const live = { latest: { a1: { agent: { id: "a1" }, at: "2026-10-26T10:00:28Z", phase: "start", verb: "edit", label: "edit add sound-16" } } };
  assert.deepEqual(currentCall(data({ live }), nova), { verb: "edit", text: "add sound-16", since: "2026-10-26T10:00:28Z", running: true });
  assert.equal(currentCall(data(), juno).running, false);
  // The goal: what it said, or the plan's step when it set the plan.
  assert.equal(agentGoal(data(), nova), "lay it down");
  const planned = data();
  planned.calls.push({ verb: "notes", label: "set_plan 3 steps", at: "2026-10-26T10:00:18Z", ...by(nova) });
  assert.equal(agentGoal(planned, nova), "cut walk + phone");
  const feed = crewFeed(data());
  assert.deepEqual(feed.map((row) => [row.agent.name, row.verb, row.mark]), [["Juno", "look", "✓"], ["Nova", "check", "✕"], ["Nova", "look", "✓"], ["Nova", "edit", "✓"]]);
  assert.equal(crewFeed(data(), "a2").length, 1);
});

test("live panels: the seen drawer while a look runs or just ended, the render dock while a render runs", () => {
  const looked = data();
  looked.calls.push({ verb: "look", label: "frame 44 s", images: ["f1.png", "f2.png"], at: "2026-10-26T10:00:27Z", ...by(nova) });
  assert.deepEqual(seenNow(looked, NOW).files, ["f1.png", "f2.png"]);
  assert.equal(seenNow(looked, NOW + SEEN_MS + 4000), null, "closes a few seconds after the look");
  const live = { latest: { a2: { agent: { id: "a2", name: "Juno" }, at: "2026-10-26T10:01:00Z", phase: "start", verb: "look", label: "look frame" } } };
  assert.equal(seenNow({ ...looked, live }, NOW + 60_000).running, true);
  const job = { id: "R3", projectId: "walk", status: "running", progress: 0.5, duration: 10, fps: 30, startedAt: "2026-10-26T10:00:10Z", by: "agent" };
  const renders = data({ renders: [job] });
  renders.calls.push({ verb: "render", label: "draft", at: "2026-10-26T10:00:09Z", ...by(nova) });
  const dock = renderDock(renders, NOW);
  assert.deepEqual([dock.total, dock.done, dock.left, dock.agent.name], [300, 150, 20, "Nova"]);
  assert.equal(leftWords(dock.left), "0:20");
  assert.equal(renderDock(data({ renders: [{ ...job, status: "done" }] }), NOW), null);
});

test("people never see the names kino gives agents: one is Agent, several are Agent 1, Agent 2 in the order they joined", () => {
  assert.deepEqual([...agentLabels(data({ agents: [nova], calls: [] }))], [["a1", "Agent"]]);
  // Juno connected first (its crew start), so it is Agent 1 although Nova called first.
  const crew = { members: [{ id: "a2", name: "Juno", startedAt: "2026-10-26T09:59:00Z", startedBy: { type: "you", name: "you" } }, { id: "a1", name: "Nova", startedBy: { type: "agent", id: "a2", name: "Juno" } }],
    locks: [{ key: "render", holder: "a1", holderName: "Nova", waiting: [{ agentId: "a2", name: "Juno" }] }], activity: [{ id: 1, agentId: "a1", name: "Nova", text: "Nova started by Juno: cut the walk" }] };
  const shown = withAgentLabels(data({ crew, live: { latest: { a1: { agent: { id: "a1", name: "Nova" }, at: "2026-10-26T10:00:20Z" } } }, agent: { stopped: [{ id: "S1", agent: "Nova" }] } }));
  assert.deepEqual(shown.agents.map((agent) => [agent.name, agent.agentName]), [["Agent 2", "Nova"], ["Agent 1", "Juno"]], "the real name stays for notes to one agent");
  assert.deepEqual([shown.calls[0].agent.name, shown.live.latest.a1.agent.name, shown.crew.members[1].startedBy.name, shown.crew.locks[0].holderName, shown.crew.locks[0].waiting[0].name], ["Agent 2", "Agent 2", "Agent 1", "Agent 2", "Agent 1"]);
  assert.equal(shown.crew.activity[0].text, "Agent 2 started by Agent 1: cut the walk");
  assert.equal(shown.agent.stopped[0].agent, "Agent 2");
  // A number never moves while the project is open: the order so far comes first.
  assert.deepEqual([...agentLabels(data(), ["a1"])], [["a1", "Agent 1"], ["a2", "Agent 2"]]);
  // An older server's agent has no id of its own: it keeps its client's name.
  assert.equal(withAgentLabels({ agents: [{ id: "legacy-codex", name: "codex" }], calls: [] }).agents[0].name, "codex");
});

test("the line under the frame: the call as a sentence, the line before it, and what waits for you first", () => {
  assert.equal(asSentence("look at the source of smirk", { running: true }), "Looking at the source of smirk.");
  assert.equal(asSentence("sheet 0:00 to 1:00", { verb: "look" }), "Looked at sheet 0:00 to 1:00.");
  assert.equal(asSentence("at 0.0 s", { verb: "look" }), "Looked at the frame at 0.0 s.");
  assert.equal(asSentence("Which cut?"), "Which cut?");
  assert.equal(asAsk("look at the stop, then approve it …"), "Look at the stop, then approve it.", "a request stays in the present tense");
  const recording = voiceLine(data({ recording: { id: "R1", startedAt: NOW - 65_000 } }), nova, NOW);
  assert.deepEqual([recording.state, recording.text, recording.facts[0]], ["recording", "Recording the screen.", "1:05"]);
  const idle = voiceLine(data(), nova, NOW);
  assert.equal(idle.verb, "check");
  assert.equal(idle.text, "Checked the video. It failed.");
  assert.equal(idle.before.text, "Looked at sheet 0:00–1:00.");
  // The dashboard draws its data with agent labels (agentLabels.js): one agent is "the agent".
  const alone = withAgentLabels(data({ agents: [nova], calls: data().calls.filter((call) => call.agent.id === "a1") }));
  assert.equal(voiceLine({ ...alone, hold: { on: true } }, alone.agents[0], NOW).text, "On hold. The agent waits for you.");
  // Its session ended: that nothing is lost, and how to go on.
  const away = voiceLine({ ...alone, agents: [] }, alone.agents[0], NOW);
  assert.deepEqual([away.state, away.text, away.facts], ["away", "Your agent last worked on this just now. Everything is saved.", []]);
  // Continue started it again: "Starting your agent." until it calls; a run that ended first says why.
  const run = (fields) => voiceLine({ ...alone, agents: [], resume: { possible: true, run: { called: false, stopped: false, error: null, ...fields } } }, alone.agents[0], NOW);
  assert.deepEqual([run({ state: "starting" }).state, run({ state: "starting" }).text], ["starting", "Starting your agent."]);
  assert.deepEqual([run({ state: "ended" }).text, run({ state: "ended" }).failed], ["Your agent stopped before it reached kino.", true]);
  assert.equal(run({ state: "failed", error: "Your agent is not signed in. Open it once to sign in." }).text, "Your agent is not signed in. Open it once to sign in.");
  assert.equal(run({ state: "ended", stopped: true }).text, away.text, "after your Stop, the plain away line");
  // A run that reached kino and ended with words for you: its last paragraph is the line, until the agent calls again.
  const said = run({ state: "ended", called: true, reply: "All done.\n\nWhat should the title say?", endedAt: new Date(NOW).toISOString() });
  assert.deepEqual([said.state, said.text, said.full], ["said", "What should the title say?", "All done.\n\nWhat should the title say?"]);
  // A note you send starts the agent when kino can continue its chat and no agent called in the last 90 s.
  const quiet = { ...alone, agents: [{ ...alone.agents[0], lastAt: new Date(NOW - 120_000).toISOString() }], resume: { possible: true, run: null } };
  assert.deepEqual([canWake(quiet, NOW), canWake({ ...quiet, hold: { on: true } }, NOW), canWake({ ...quiet, agents: alone.agents }, NOW), canWake({ ...quiet, resume: { possible: false } }, NOW)], [true, false, false, false]);
  const two = withAgentLabels(data());
  // Juno was seen first (its last call at 09:00), so Nova is Agent 2.
  assert.equal(voiceLine({ ...two, agents: [] }, two.agents[0], NOW).text, "Agent 2 last worked on this just now. Everything is saved.");
  // A render that ended under a minute ago is said to be ready, with its facts.
  const ready = voiceLine(data({ renders: [{ id: "R2", projectId: "walk", status: "done", quality: "final", format: "mp4", width: 1920, height: 1080, duration: 14, size: 12_400_000, finishedAt: new Date(NOW - 5_000).toISOString() }] }), nova, NOW);
  assert.deepEqual([ready.state, ready.text, ready.facts], ["ready", "The final is ready.", ["14 s, 1920 by 1080", "12 MB, MP4"]]);
  assert.notEqual(voiceLine(data({ renders: [{ id: "R2", projectId: "walk", status: "done", finishedAt: new Date(NOW - 90_000).toISOString() }] }), nova, NOW).state, "ready");
  const asked = voiceLine(data({ approvals: [{ id: "Q16", status: "pending", kind: "final-render", agent: { id: "a1", name: "Nova" } }] }), nova, NOW);
  assert.equal(asked.state, "need");
  assert.equal(asked.need.row.approval.id, "Q16");
  assert.deepEqual(voiceLine(data({ calls: [] }), null, NOW), { state: "empty", verb: "plug", text: "Waiting for an agent.", facts: [], before: null });
});
