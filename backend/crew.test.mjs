// The crew (backend/agent/crew.mjs) and its held parts (crew-locks.mjs), in this process with a
// clock the tests move and a launcher that only records what it was asked to start: the start
// rules, the limits every agent call goes through (look only, hold, stop, budget), the parts an
// edit holds, timers, the person's notes, hand-backs and what is saved across a restart.
// The launcher itself, with stub claude and codex programs, is in crew-launch.integration.test.mjs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedParts, createLocks, LOCK_QUIET_MS, MUSIC } from "./agent/crew-locks.mjs";
import { createCrew, crewKind, defaultRules, mergeRules, nextRun, scheduleFrom } from "./agent/crew.mjs";
import { agentCommand, agentEnvironment, findProgram } from "./agent/launcher.mjs";
import { crewDetail, crewHolds, crewMarks, crewTable } from "../frontend/dashboard/crewRows.js";

const START = Date.parse("2026-10-26T10:00:00Z");

function fakeLauncher({ installed = { "claude-code": true, codex: true } } = {}) {
  const started = [];
  const stopped = [];
  return {
    started, stopped,
    available: () => ({ ...installed }),
    find: async (kind) => (installed[kind] ? `/fake/${kind}` : null),
    async start(member, { prompt }) {
      started.push({ id: member.id, kind: member.kind, prompt, session: member.session });
      return { pid: 4000 + started.length, folder: `/fake/crew/${member.id}`, startedAt: new Date().toISOString(), exitedAt: null, exitCode: null };
    },
    async stop(id) { stopped.push(id); },
    async adopt() {},
  };
}

async function makeCrew(options = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(tmpdir(), "kino-crew-"));
  const clock = options.clock ?? { now: START };
  const launcher = options.launcher ?? fakeLauncher();
  const asked = [];
  const inboxes = [];
  const events = [];
  const crew = await createCrew({
    directory, now: () => clock.now, launcher, tickMs: 0,
    publish: (event) => events.push(event),
    approvals: {
      async request(request) { asked.push(request); return options.answer?.(request) ?? { status: "pending", id: `Q${asked.length}` }; },
      pendingFor: (id) => asked.some((request) => request.agent?.id === id && !request.answered),
    },
    inbox: async (projectId, item) => { inboxes.push({ projectId, ...item }); },
    liveNames: () => options.liveNames ?? [],
    hold: () => options.hold ?? { on: false },
  });
  return { crew, clock, launcher, asked, inboxes, events, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const NOVA = { id: "a1", name: "Nova", color: "#42c0b6", kind: "claude-code" };

test("start rules: defaults, strict changes, kinds and schedules", () => {
  const rules = defaultRules();
  assert.deepEqual(rules, { notes: false, leads: { on: true, helpers: 3 }, timers: false, atOnce: 4, budget: { calls: 60, minutes: 15 }, kind: "claude-code" });
  const next = mergeRules(rules, { notes: true, leads: { helpers: 2 }, atOnce: 6, budget: { minutes: 20 } });
  assert.deepEqual(next, { ...rules, notes: true, leads: { on: true, helpers: 2 }, atOnce: 6, budget: { calls: 60, minutes: 20 } });
  assert.throws(() => mergeRules(rules, { anyone: true }), /Unknown start rule "anyone"/);
  assert.throws(() => mergeRules(rules, { atOnce: 0 }), /atOnce is a whole number from 1 to 12/);
  assert.throws(() => mergeRules(rules, { leads: { helpers: 9 } }), /from 0 to 8/);
  assert.throws(() => mergeRules(rules, { kind: "other" }), /kind is claude-code or codex/);
  assert.throws(() => mergeRules(rules, { budget: { tokens: 5 } }), /Unknown budget field/);
  assert.equal(crewKind("claude-code"), "claude-code");
  assert.equal(crewKind("codex-mcp-client"), "codex");
  assert.equal(crewKind("cli"), "other");
  assert.deepEqual(scheduleFrom({ daily: "06:00" }), { daily: "06:00" });
  assert.throws(() => scheduleFrom({ daily: "6am" }), /24-hour/);
  assert.throws(() => scheduleFrom({ everyHours: 0 }), /from 1 to 168/);
  // Daily: the next 06:00 on this computer's clock after `from`.
  const from = new Date(2026, 9, 26, 7, 30).getTime();
  assert.equal(nextRun({ daily: "06:00" }, from), new Date(2026, 9, 27, 6, 0).getTime());
  assert.equal(nextRun({ daily: "08:15" }, from), new Date(2026, 9, 26, 8, 15).getTime());
  // Every 6 hours from the last run, never in the past.
  assert.equal(nextRun({ everyHours: 6 }, from, from - 3_600_000), from + 5 * 3_600_000);
  assert.equal(nextRun({ everyHours: 6 }, from, from - 13 * 3_600_000), from + 5 * 3_600_000);
});

test("changedParts: a layer is held by its top-level group, sound is music, scene settings are the scene", () => {
  const scene = (layers, extra = {}) => ({ id: "s1", name: "Intro", duration: 5, layers, ...extra });
  const group = { id: "g1", name: "card-5", type: "group", parentId: null, x: 0 };
  const caption = { id: "t1", name: "caption", type: "text", parentId: "g1", text: "hi" };
  const music = { id: "m1", name: "song", type: "audio", parentId: null, volume: 1 };
  const title = { id: "t2", name: "title", type: "text", parentId: null, text: "a" };
  const before = { scenes: [scene([group, caption, music, title])] };
  assert.deepEqual(changedParts(before, structuredClone(before)), []);
  const after = { scenes: [scene([group, { ...caption, text: "hello" }, { ...music, volume: 0.5 }, title])] };
  assert.deepEqual(changedParts(before, after), [{ key: "layer:s1/g1", label: "card-5" }, MUSIC]);
  // A new layer, and a removed one, are parts too; a scene's own settings are the scene.
  const added = { scenes: [scene([group, caption, music, title, { id: "n1", name: "logo", type: "image", parentId: null }], { duration: 6 })] };
  assert.deepEqual(changedParts(before, added), [{ key: "scene:s1", label: "scene Intro" }, { key: "layer:s1/n1", label: "logo" }]);
  const removed = { scenes: [scene([group, caption, music])] };
  assert.deepEqual(changedParts(before, removed), [{ key: "layer:s1/t2", label: "title" }]);
});

test("locks: a held part answers waiting, lists the waiter, and frees after 2 quiet minutes or a release", () => {
  const clock = { now: START };
  const locks = createLocks({ now: () => clock.now });
  const part = { key: "layer:s1/g1", label: "card-5 caption" };
  assert.deepEqual(locks.claim("p", "a1", [part]), { ok: true, taken: ["layer:s1/g1"] });
  assert.deepEqual(locks.claim("p", "a2", [part, MUSIC]), { waiting: [{ key: "layer:s1/g1", label: "card-5 caption", holder: "a1" }] });
  // Nothing new was taken by the refused claim (music stays free).
  assert.equal(locks.list().length, 1);
  assert.deepEqual(locks.list()[0].waiting.map((entry) => entry.agentId), ["a2"]);
  // Another project's part with the same key is another part.
  assert.ok(locks.claim("q", "a2", [part]).ok);
  // The holder keeps calling: its hold lasts.
  clock.now += LOCK_QUIET_MS - 1000;
  locks.touch("a1");
  clock.now += 60_000;
  assert.ok(locks.claim("p", "a2", [part]).waiting);
  // Quiet for 2 minutes: free.
  clock.now += LOCK_QUIET_MS;
  locks.touch("a2");
  assert.ok(locks.claim("p", "a2", [part]).ok);
  assert.deepEqual(locks.release("a2", { projectId: "p" }), ["card-5 caption"]);
  assert.equal(locks.list().filter((entry) => entry.projectId === "p").length, 0);
});

test("gate: agents join as leads; look only, hold, stop and budget limit every call", async () => {
  const { crew, asked, inboxes, launcher, clock, cleanup } = await makeCrew();
  try {
    // The person's own agent joins on its first call, with no budget.
    assert.equal(await crew.gate({ agent: NOVA, verb: "status", write: false, projectId: "p" }), null);
    let nova = crew.member("a1");
    assert.equal(nova.role, "lead");
    assert.equal(nova.startedBy.type, "you");
    assert.equal(nova.budget, null);
    assert.equal(nova.spent.calls, 1);
    // A helper that may only look.
    const juno = await crew.start({ kind: "codex", task: "find fast-cut walking edits", may: "look", projectId: "p", by: { type: "agent", id: "a1", name: "Nova" }, leadId: "a1", budget: { calls: 3, minutes: 10 } });
    assert.equal(juno.role, "helper");
    assert.equal(juno.mayWords, "look and search only; no edits");
    assert.match(launcher.started[0].prompt, /look and search only/);
    const junoAgent = crew.identityFor(launcher.started[0].session);
    assert.deepEqual(junoAgent, { id: juno.id, name: juno.name, color: juno.color, kind: "codex" });
    assert.equal(crew.identityFor("someone-else"), null);
    const denied = await crew.gate({ agent: junoAgent, verb: "edit", write: true, projectId: "p" });
    assert.equal(denied.crew, "denied");
    assert.equal(await crew.gate({ agent: junoAgent, verb: "look", write: false, projectId: "p" }), null);
    // Hold: writes refused, reads go on; release tells the agent.
    await crew.setHold("a1", true);
    assert.equal((await crew.gate({ agent: NOVA, verb: "edit", write: true, projectId: "p" })).crew, "held");
    assert.equal(await crew.gate({ agent: NOVA, verb: "look", write: false, projectId: "p" }), null);
    assert.equal(crew.member("a1").state, "held");
    await crew.setHold("a1", false);
    assert.equal(await crew.gate({ agent: NOVA, verb: "edit", write: true, projectId: "p" }), null);
    assert.deepEqual(inboxes.map((item) => [item.agentId, item.text.split(":")[0]]), [["a1", "you are held by the person"], ["a1", "released"]]);
    // Budget: 3 calls (the refused edit did not count). Two more reads are fine; the next is
    // held and the person is asked.
    assert.equal(await crew.gate({ agent: junoAgent, verb: "look", write: false, projectId: "p" }), null);
    assert.equal(await crew.gate({ agent: junoAgent, verb: "look", write: false, projectId: "p" }), null);
    const past = await crew.gate({ agent: junoAgent, verb: "look", write: false, projectId: "p" });
    assert.equal(past.crew, "budget");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].kinds[0].kind, "crew-budget");
    assert.deepEqual(asked[0].input, { agent: juno.id, round: 1 });
    assert.equal(crew.member(juno.id).state, "held");
    assert.equal(crew.member(juno.id).budgetApproval, "Q1");
    // Every call is refused while it waits, and the person is asked once.
    assert.equal((await crew.gate({ agent: junoAgent, verb: "status", write: false, projectId: "p" })).crew, "budget");
    assert.equal(asked.length, 1);
    // Allowed: the rules' budget is added.
    crew.extend(juno.id);
    assert.deepEqual(crew.member(juno.id).budget, { calls: 63, minutes: 25 });
    assert.equal(await crew.gate({ agent: junoAgent, verb: "look", write: false, projectId: "p" }), null);
    // Minutes count too.
    clock.now += 26 * 60_000;
    assert.equal((await crew.gate({ agent: junoAgent, verb: "look", write: false, projectId: "p" })).crew, "budget");
    // Stop: the process ends, every call is refused, and it holds nothing.
    assert.equal(crew.claim(junoAgent, "p", [{ key: "x", label: "x" }]), null);
    const stopped = await crew.stop(juno.id);
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(launcher.stopped, [juno.id]);
    assert.deepEqual(stopped.holding, []);
    assert.equal((await crew.gate({ agent: junoAgent, verb: "status", write: false, projectId: "p" })).crew, "stopped");
  } finally { crew.close(); await cleanup(); }
});

test("start rules decide who may start agents, how many helpers and how many at once", async () => {
  const { crew, launcher, cleanup } = await makeCrew({ launcher: fakeLauncher({ installed: { "claude-code": true, codex: false } }) });
  try {
    await crew.gate({ agent: NOVA, verb: "status", write: false, projectId: "p" });
    await assert.rejects(crew.start({ kind: "codex", task: "x", by: { type: "you" } }), (error) => error.code === "not_installed" && error.status === 424 && /codex was not found/.test(error.message));
    await assert.rejects(crew.start({ task: "", by: { type: "you" } }), /1 to 2000 characters/);
    await assert.rejects(crew.start({ task: "x", may: "edit", by: { type: "you" } }), /may is "all" or "look"/);
    await assert.rejects(crew.start({ task: "x", by: { type: "notes" } }), (error) => error.code === "not_allowed");
    // Each lead: up to 3 helpers (the default) at work at once.
    for (let index = 0; index < 3; index += 1) await crew.requestHelper(NOVA, { projectId: "p", task: `helper ${index}` });
    await assert.rejects(crew.requestHelper(NOVA, { projectId: "p", task: "one more" }), /already have 3 helpers/);
    // Helpers start no helpers.
    const helper = crew.identityFor(launcher.started[0].session);
    await crew.gate({ agent: helper, verb: "status", write: false, projectId: "p" });
    await assert.rejects(crew.requestHelper(helper, { projectId: "p", task: "x" }), /Only a lead agent may start helpers/);
    // At most 4 at once: Nova and three helpers are at work.
    await assert.rejects(crew.start({ task: "fifth", by: { type: "you" } }), (error) => error.code === "at_limit" && /4 agents are at work/.test(error.message));
    await crew.updateRules({ atOnce: 5, leads: { on: false } });
    const fifth = await crew.start({ task: "fifth", by: { type: "you" }, projectId: "p" });
    assert.equal(fifth.startedBy.name, "you");
    assert.equal(fifth.role, "lead");
    await crew.stop(fifth.id);
    await assert.rejects(crew.requestHelper(NOVA, { projectId: "p", task: "x" }), /do not let agents start helpers/);
    // Names: no two agents at work share one, and the live view's names are taken too.
    const names = crew.view().members.map((member) => member.name);
    assert.equal(new Set(names).size, names.length);
  } finally { crew.close(); await cleanup(); }
});

test("hand back: a helper's final message goes to its lead's inbox; a timer sleeps until its next run", async () => {
  const { crew, inboxes, launcher, clock, cleanup } = await makeCrew();
  try {
    await crew.gate({ agent: NOVA, verb: "status", write: false, projectId: "p" });
    const helper = await crew.requestHelper(NOVA, { projectId: "p", task: "find 3 references" });
    assert.equal(helper.startedBy.name, "Nova");
    assert.match(launcher.started[0].prompt, /kino hands it to Nova/);
    await crew.exited(helper.id, { code: 0, message: "found 3: walk-a, walk-b, walk-c" });
    const done = crew.member(helper.id);
    assert.equal(done.state, "done");
    assert.equal(done.handedBack.text, "found 3: walk-a, walk-b, walk-c");
    assert.deepEqual(inboxes.at(-1), { projectId: "p", agentId: "a1", kind: "crew", text: `◆ ${helper.name} (${helper.id}) handed back: found 3: walk-a, walk-b, walk-c` });
    // Timers: off by default, so a due timer does not run.
    const timer = crew.addTimer({ task: "check the render queue", projectId: "p", schedule: { everyHours: 1 }, name: "Orion" });
    assert.equal(timer.state, "asleep");
    assert.equal(timer.startedBy.name, "every 1 h");
    assert.equal(timer.nextRunAt, null, "no next run while timers are off");
    clock.now += 61 * 60_000;
    await crew.tick();
    assert.equal(launcher.started.length, 1);
    assert.match(crew.view().activity.at(-1).text, /did not run: Your rules do not let timers start agents/);
    await crew.updateRules({ timers: true });
    assert.ok(crew.member(timer.id).nextRunAt);
    clock.now += 61 * 60_000;
    await crew.tick();
    assert.equal(launcher.started.length, 2);
    assert.equal(crew.member(timer.id).state, "working");
    await crew.exited(timer.id, { code: 0, message: "queue empty" });
    const asleep = crew.member(timer.id);
    assert.equal(asleep.state, "asleep");
    assert.equal(asleep.handedBack.text, "queue empty");
    assert.equal(Date.parse(asleep.nextRunAt) - clock.now, 60 * 60_000);
    // The activity has the marks the crew screen's lanes show.
    const types = crew.view().activity.map((entry) => entry.type);
    for (const type of ["started", "handed-back"]) assert.ok(types.includes(type), type);
    await crew.removeTimer(timer.id);
    assert.equal(crew.member(timer.id), null);
  } finally { crew.close(); await cleanup(); }
});

test("your notes start an agent only when allowed and nobody works on that project", async () => {
  const { crew, launcher, clock, cleanup } = await makeCrew();
  try {
    assert.equal(await crew.noteAdded("p", { id: "N1", text: "make the title bigger" }), null);
    await crew.updateRules({ notes: true });
    await crew.gate({ agent: NOVA, verb: "status", write: false, projectId: "p" });
    assert.equal(await crew.noteAdded("p", { id: "N2", text: "make the title bigger" }), null, "Nova works on p");
    const started = await crew.noteAdded("q", { id: "N3", text: "add a logo sting" });
    assert.equal(started.startedBy.type, "notes");
    assert.equal(started.because.by, "your notes");
    assert.equal(launcher.started.length, 1);
    // Nova went quiet more than 2 minutes ago: a note on p starts an agent now.
    clock.now += 3 * 60_000;
    assert.ok(await crew.noteAdded("p", { id: "N4", text: "tighten the cut" }));
    const notes = crew.view().activity.filter((entry) => entry.type === "note");
    assert.equal(notes.length, 4);
    assert.ok(notes.every((entry) => entry.by === "you"));
  } finally { crew.close(); await cleanup(); }
});

test("restart: started agents that were running are stopped, the person's leads leave, timers stay", async () => {
  const first = await makeCrew();
  await first.crew.gate({ agent: NOVA, verb: "status", write: false, projectId: "p" });
  const helper = await first.crew.requestHelper(NOVA, { projectId: "p", task: "x" });
  first.crew.addTimer({ task: "nightly check", schedule: { daily: "06:00" } });
  await first.crew.updateRules({ atOnce: 7 });
  await first.crew.flush();
  first.crew.close();
  const second = await makeCrew({ directory: first.directory });
  try {
    const view = second.crew.view();
    assert.equal(view.rules.atOnce, 7);
    assert.equal(second.crew.member("a1"), null);
    assert.equal(second.crew.member(helper.id).state, "stopped");
    assert.equal(second.crew.member(helper.id).endReason, "kino restarted");
    assert.ok(view.members.some((member) => member.role === "timer" && member.state === "asleep"));
  } finally { second.crew.close(); await second.cleanup(); }
});

test("the crew screen's rows: tree, detail, holds, marks and counts", async () => {
  const { crew, clock, cleanup } = await makeCrew();
  try {
    await crew.gate({ agent: NOVA, verb: "edit", write: true, projectId: "p" });
    crew.after(NOVA, { verb: "edit", label: "edit card-5 caption", summary: "rev 4", write: true, ms: 800 });
    crew.claim(NOVA, "p", [{ key: "layer:s1/g1", label: "card-5 caption" }]);
    const juno = await crew.requestHelper(NOVA, { projectId: "p", task: "find fast-cut walking edits", may: "look", budget: undefined });
    const junoAgent = { id: juno.id, name: juno.name, color: juno.color, kind: juno.kind };
    await crew.gate({ agent: junoAgent, verb: "library", write: false, projectId: "p" });
    crew.after(junoAgent, { verb: "library", label: "search \"walking tour, fast cuts\"", summary: "14 found", write: false });
    crew.claim(NOVA, "p", [{ key: "music", label: "music" }]);
    crew.claim(junoAgent, "p", [{ key: "music", label: "music" }]);
    crew.addTimer({ task: "nightly", schedule: { daily: "06:00" }, name: "Orion" });
    clock.now += 60_000;
    const data = { projectId: "p", crew: crew.view() };
    const table = crewTable(data);
    assert.deepEqual(table.map((row) => [row.name, row.depth, row.startedBy, row.doing, row.holding]), [
      ["you", 0, "", "", ""],
      ["Nova", 1, "you", "editing", "card-5 caption, music"],
      [juno.name, 2, "Nova", "looking", "-"],
      ["Orion", 1, "06:00", "asleep", "-"],
    ]);
    const detail = crewDetail(data.crew.members[1], clock.now);
    assert.equal(detail.title, "find fast-cut walking edits");
    assert.equal(detail.started, "started by Nova, 1 min ago");
    assert.equal(detail.because, 'Nova: "find fast-cut walking edits"');
    assert.equal(detail.may, "look and search only; no edits");
    assert.equal(detail.spent.callsText, "1 / 60 calls");
    assert.equal(detail.spent.timeText, "1:00 / 15 min");
    assert.equal(detail.last, 'library search "walking tour, fast cuts"');
    assert.equal(detail.lastAnswer, "14 found");
    const holds = crewHolds(data);
    assert.deepEqual(holds.map((row) => [row.label, row.holder?.name ?? "free", row.waiting.map((waiter) => waiter.name)]), [
      ["card-5 caption", "Nova", []], ["music", "Nova", [juno.name]], ["render", "free", []],
    ]);
    const marks = crewMarks(data, clock.now);
    assert.ok(marks.agents[juno.id].some((mark) => mark.type === "started"));
  } finally { crew.close(); await cleanup(); }
});

test("launcher: finds programs, builds each command line, and keeps kino's secrets out of the agent's environment", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-crew-bin-"));
  try {
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(path.join(folder, "claude"), "#!/bin/sh\n");
    await chmod(path.join(folder, "claude"), 0o755);
    const env = { PATH: folder, HOME: folder, KINO_OWNER_TOKEN: "secret", MOTION_API_URL: "http://x", KEEP: "1" };
    assert.equal(findProgram("claude-code", env), path.join(folder, "claude"));
    assert.equal(findProgram("codex", env), null);
    assert.equal(findProgram("codex", { ...env, KINO_CODEX: path.join(folder, "claude") }), path.join(folder, "claude"));
    const clean = agentEnvironment(env);
    assert.equal(clean.KINO_OWNER_TOKEN, undefined);
    assert.equal(clean.MOTION_API_URL, undefined);
    assert.equal(clean.KEEP, "1");
    assert.ok(clean.PATH.split(path.delimiter).includes("/opt/homebrew/bin"));
    const mcp = { command: "/usr/bin/node", args: ["/kino/backend/crew-mcp.mjs", "/data/crew/k1/agent.json"], env: {} };
    const claude = agentCommand("claude-code", { program: "/bin/claude", prompt: "do it", folder: "/data/crew/k1", mcp });
    assert.deepEqual(claude.args, ["-p", "do it", "--mcp-config", "/data/crew/k1/mcp.json", "--strict-mcp-config", "--allowedTools", "mcp__kino", "--output-format", "json"]);
    const codex = agentCommand("codex", { program: "/bin/codex", prompt: "do it", folder: "/data/crew/k1", mcp });
    assert.deepEqual(codex.args.slice(0, 6), ["exec", "--skip-git-repo-check", "-C", "/data/crew/k1/work", "-o", "/data/crew/k1/last.txt"]);
    assert.ok(codex.args.includes('mcp_servers.kino.args=["/kino/backend/crew-mcp.mjs","/data/crew/k1/agent.json"]'));
    assert.ok(codex.args.includes('mcp_servers.kino.default_tools_approval_mode="approve"'));
    assert.ok(!codex.args.join(" ").includes("secret"));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
