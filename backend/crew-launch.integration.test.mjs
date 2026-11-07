// kino starting agents itself (plan section C): a real kino server with a temporary data folder
// and a temporary home, and stub `claude` and `codex` programs on its PATH
// (crew-stub-agent.test.support.mjs) that start kino's MCP server the way the real programs
// would and make real tool calls. Never the real claude or codex, never the real home folder.
// Covers: the person starting an agent from the dashboard, look-only refusals, a lead's helper
// whose final message reaches only that lead's inbox, held parts between two agents, stop
// ending the process, a budget that holds the agent and asks the person, and a note that
// starts an agent.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { writeStubPrograms } from "./crew-stub-agent.test.support.mjs";
import { startTestServer } from "./media.test.support.mjs";

let server;
let key;
let home;

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kino-crew-home-"));
  const bin = path.join(home, "stub-bin");
  const programs = await writeStubPrograms(bin);
  server = await startTestServer({ env: { HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...programs } });
  const response = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  key = (await response.json()).key;
  await agent("project", { action: "create", id: "crew-test", name: "Crew test", width: 640, height: 360, duration: 4 });
});
after(async () => {
  await server?.stop();
  if (home) await rm(home, { recursive: true, force: true });
});

// One agent call with a session (one of the person's own agents).
async function agent(verb, body = {}, { session = "test-lead-nova", client = "codex-mcp-client" } = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client, ...body }, headers: { "x-kino-session": session } });
  assert.equal(response.status, 200);
  return response.json();
}

async function dashboard(route, { method = "POST", body } = {}) {
  const response = await server.api(`/api/dashboard/${route}`, { method, body, headers: { "x-kino-review": key } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const crewView = async () => (await dashboard("crew", { method: "GET" })).body.crew;
const memberOf = async (id) => (await crewView()).members.find((member) => member.id === id);

async function until(read, check, what) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test("the person starts a look-only Claude Code agent: its edit is refused and its final message is kept", async () => {
  const before = await crewView();
  assert.deepEqual(before.canStart, { "claude-code": true, codex: true });
  const { status, body } = await dashboard("crew/start", { body: { kind: "claude-code", task: "look only check", may: "look", project: "crew-test" } });
  assert.equal(status, 200, JSON.stringify(body));
  const id = body.member.id;
  assert.match(id, /^k\d+$/);
  assert.equal(body.member.startedBy.type, "you");
  const done = await until(() => memberOf(id), (member) => member?.state === "done", "the agent to finish");
  assert.equal(done.process.running, false);
  assert.equal(done.process.exitCode, 0);
  assert.match(done.handedBack.text, /^stub claude done/);
  assert.match(done.handedBack.text, /edit: .*look and search only/);
  // Its calls carry its crew identity, and the refused edit says why.
  const snapshot = (await dashboard("snapshot?project=crew-test", { method: "GET" })).body;
  const calls = snapshot.events.filter((event) => event.agent?.id === id);
  assert.deepEqual(calls.map((call) => call.verb), ["status", "edit"]);
  assert.equal(calls[1].crew, "denied");
  assert.equal(calls[1].isError, true);
  assert.ok(!snapshot.record.document.scenes[0].layers.some((layer) => layer.name === "should not exist"));
  // The log route shows what it printed.
  const log = await dashboard(`crew/${id}/log`, { method: "GET" });
  assert.match(log.body.out, /"result"/);
});

test("a lead asks for a Codex helper; the hand-back reaches that lead only", async () => {
  await agent("status", { project: "crew-test" }, { session: "test-other-juno", client: "claude-code" });
  const asked = await agent("notes", { action: "helper", text: "make a title", project: "crew-test" });
  assert.ok(!asked.isError, asked.text);
  const id = asked.data.helper;
  assert.equal(asked.data.kind, "codex", "a Codex lead gets a Codex helper");
  const done = await until(() => memberOf(id), (member) => member?.state === "done", "the helper to finish");
  assert.equal(done.startedBy.type, "agent");
  assert.equal(done.role, "helper");
  assert.match(done.handedBack.text, /^stub codex done/);
  const document = (await dashboard("snapshot?project=crew-test", { method: "GET" })).body.record.document;
  assert.ok(document.scenes[0].layers.some((layer) => layer.name === "stub title"), "the helper's edit saved");
  // Juno (another agent) does not get Nova's hand-back; Nova does.
  const juno = await agent("status", { project: "crew-test" }, { session: "test-other-juno", client: "claude-code" });
  assert.ok(!juno.text.includes("handed back"));
  const nova = await agent("status", { project: "crew-test" });
  assert.match(nova.text, new RegExp(`◆ ${done.name} \\(${id}\\) handed back: stub codex done`));
});

test("held parts: an edit of a part another agent holds answers waiting and saves nothing", async () => {
  const made = await agent("edit", { project: "crew-test", ops: [{ op: "add_layer", layerType: "rectangle", name: "held box", properties: { width: 50, height: 50 } }] });
  assert.ok(!made.isError, made.text);
  const rev = made.data?.rev ?? (await dashboard("snapshot?project=crew-test", { method: "GET" })).body.record.revision;
  const blocked = await agent("edit", { project: "crew-test", ops: [{ op: "update_layer", layer: "held box", properties: { width: 80 } }] }, { session: "test-other-juno", client: "claude-code" });
  assert.equal(blocked.data.crew, "waiting");
  assert.equal(blocked.data.waiting, "held box");
  assert.match(blocked.data.holder, /\(a1\)$/);
  const view = await crewView();
  const lock = view.locks.find((entry) => entry.label === "held box");
  assert.equal(lock.holder, "a1");
  assert.deepEqual(lock.waiting.map((waiter) => waiter.agentId), ["a2"]);
  assert.equal((await dashboard("snapshot?project=crew-test", { method: "GET" })).body.record.revision, rev, "nothing saved");
  // The person's own edit is never blocked.
  const yours = await dashboard("act/edit", { body: { project: "crew-test", ops: [{ op: "update_layer", layer: "held box", properties: { height: 60 } }] } });
  assert.ok(!yours.body.isError, yours.body.text);
  // Nova releases it; Juno's edit saves.
  const released = await agent("notes", { action: "release", project: "crew-test" });
  assert.match(released.text, /released held box/);
  const saved = await agent("edit", { project: "crew-test", ops: [{ op: "update_layer", layer: "held box", properties: { width: 80 } }] }, { session: "test-other-juno", client: "claude-code" });
  assert.ok(!saved.data?.crew, saved.text);
  // "render" is held while a render runs: once Nova's is done, Juno's render starts at once.
  const nova = await agent("render", { project: "crew-test", action: "start", format: "gif", wait: true });
  assert.ok(!nova.data?.crew && !nova.isError, nova.text);
  await until(() => agent("render", { project: "crew-test", action: "wait", job: nova.data.job }), (reply) => /\bdone\b/.test(reply.text), "Nova's render");
  const juno = await agent("render", { project: "crew-test", action: "start", format: "gif" }, { session: "test-other-juno", client: "claude-code" });
  assert.equal(juno.data?.crew, undefined, juno.text);
});

test("stop ends a started agent's process; a budget holds an agent and asks the person", async () => {
  const started = (await dashboard("crew/start", { body: { kind: "claude-code", task: "wait forever", project: "crew-test" } })).body.member;
  const working = await until(() => memberOf(started.id), (member) => member?.spent.calls >= 1, "the agent's first call");
  assert.equal(working.process.running, true);
  const pid = working.process.pid;
  const stopped = await dashboard(`crew/${started.id}/stop`);
  assert.equal(stopped.body.member.state, "stopped");
  const gone = await until(() => memberOf(started.id), (member) => member?.process?.running === false, "the process to end");
  assert.equal(gone.state, "stopped");
  assert.throws(() => process.kill(pid, 0), "the process is gone");

  assert.equal((await dashboard("crew/rules", { method: "PUT", body: { budget: { calls: 2, minutes: 15 } } })).status, 200);
  const spender = (await dashboard("crew/start", { body: { kind: "codex", task: "spend", project: "crew-test" } })).body.member;
  assert.deepEqual(spender.budget, { calls: 2, minutes: 15 });
  const done = await until(() => memberOf(spender.id), (member) => member?.state === "done", "the spender to finish");
  assert.equal(done.spent.calls, 2);
  assert.match(done.handedBack.text, /Your budget is spent/);
  const approvals = (await dashboard("snapshot?project=crew-test", { method: "GET" })).body.approvals;
  const ask = approvals.find((approval) => approval.kind === "crew-budget" && approval.status === "pending");
  assert.ok(ask, "the person is asked");
  assert.equal(ask.agent.id, spender.id);
  const answered = await dashboard(`approvals/${ask.id}`, { body: { decision: "allow" } });
  assert.equal(answered.body.approval.status, "allowed");
  // The rules' budget (2 calls, 15 min) is added.
  assert.deepEqual((await memberOf(spender.id)).budget, { calls: 4, minutes: 30 });
  const activity = (await crewView()).activity.map((entry) => entry.type);
  for (const type of ["started", "handed-back", "stopped", "needs-you", "released", "rules"]) assert.ok(activity.includes(type), type);
});

test("rules are strict, and a note starts an agent only when your notes may", async () => {
  assert.equal((await dashboard("crew/rules", { method: "PUT", body: { anyone: true } })).status, 400);
  assert.equal((await dashboard("crew/start", { body: { kind: "unknown-agent", task: "x" } })).status, 400);
  // A project the person made: no agent works on it.
  const made = await dashboard("act/project", { body: { action: "create", id: "crew-notes", name: "Notes", width: 320, height: 180, duration: 2 } });
  assert.ok(!made.body.isError, made.body.text);
  // Notes may not start agents yet.
  let note = await dashboard("act/notes", { body: { project: "crew-notes", action: "add", text: "look only check" } });
  assert.match(note.body.text, /the agent gets it with its next call/);
  await dashboard("crew/rules", { method: "PUT", body: { notes: true, budget: { calls: 60 } } });
  note = await dashboard("act/notes", { body: { project: "crew-notes", action: "add", text: "look only check" } });
  const id = note.body.data.started;
  assert.match(note.body.text, new RegExp(`\\(${id}\\) started to work on it`));
  const done = await until(() => memberOf(id), (member) => member?.state === "done", "the note's agent to finish");
  assert.equal(done.startedBy.type, "notes");
  assert.equal(done.because.by, "your notes");
  assert.equal(done.kind, "claude-code");
  // Another note while it worked would not start a second one; now it is done, the rules hold.
  assert.equal((await crewView()).rules.notes, true);
  // A timer is added, listed and removed.
  const timer = await dashboard("crew/timers", { body: { task: "nightly look", daily: "06:00", project: "crew-notes" } });
  assert.equal(timer.status, 200);
  assert.equal(timer.body.member.scheduleWords, "06:00");
  assert.equal((await dashboard(`crew/timers/${timer.body.member.id}/remove`)).status, 200);
  // Without the review key nothing changes.
  const refused = await server.api("/api/dashboard/crew/start", { method: "POST", body: { task: "x" } });
  assert.equal(refused.status, 403);
});
