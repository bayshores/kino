// The person's answers to the stops on the dashboard (direction plan §6, milestone B2b), through
// POST /api/dashboard/stops on a real server: answer a waiting stop (approve, approve with notes,
// redo), reopen an answer the agent recorded from the chat (or their own), and the B2a undo of
// "stop asking". A dashboard answer is saved as via:"dashboard", releases the project's writes,
// counts as a reply, and reaches the agent in its inbox with its next call; the agent cannot
// record it again. A reopened stop no longer passes: the agent asks it again with a new id. The
// route needs the window's review key, is not refused by hold, answers each refusal with the
// message the dashboard shows, and publishes the new stops (also after a refusal that closed a
// stop nobody can answer any more). Answers survive a restart.
//
// Every project here has no footage, so the rough cut is the first stop. A chat answer needs a
// real wait (too_fast): this file waits once (gap()), for two projects at the same time.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { createDocument, createScene } from "../engine/model.js";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { startTestServer } from "./media.test.support.mjs";
import { openStore } from "./store.mjs";

let server;
let key;
const reviewKey = async (on) => (await (await on.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: on.baseUrl } })).json()).key;
before(async () => {
  server = await startTestServer();
  key = await reviewKey(server);
});
after(() => server?.stop());

async function agent(verb, body = {}, on = server) {
  const response = await on.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function dashboard(route, { method = "POST", body, review = true, on = server, withKey = key } = {}) {
  const response = await on.api(`/api/dashboard/${route}`, { method, body, headers: review && method !== "GET" ? { "x-kino-review": withKey } : {} });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const stops = (project, body, options) => dashboard("stops", { body: { project, ...body }, ...options });
const answerIn = (project, body, options) => stops(project, { action: "answer", ...body }, options);
const reopen = (project, id, options) => stops(project, { action: "reopen", id }, options);
const snapshot = async (project) => (await dashboard(`snapshot?project=${project}`, { method: "GET" })).body;
const savedState = async (project, folder = server.dataDirectory) => JSON.parse(await readFile(path.join(folder, "agent", "projects", `${project}.json`), "utf8"));
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;
// The inbox lines an agent answer carries (service.mjs call(), next-call.mjs answerText()): a JSON
// answer keeps them in its inbox field; a text answer lists them indented, then its next: line.
const inboxOf = (reply) => reply.text.startsWith("{") ? JSON.parse(reply.text).inbox ?? []
  : reply.text.split("\ninbox ◆")[1]?.split("\n").slice(1).filter((line) => line.startsWith("  ")).map((line) => line.trim()) ?? [];

// The B2a fixture: a 24 s 1080×1920 card with one 96 px title passes check with 0 errors.
const TITLE = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
const move = (y) => ({ op: "update_layer", layer: "title", properties: { y } });

// A project with no footage: the fixture, a brief settled with no playback ("just start"), and
// the agent's full check of its revision.
async function stopProject(id, on = server) {
  const made = await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 24, background: "#101820" }, on);
  assert.equal(made.isError, undefined, made.text);
  const edited = await agent("edit", { project: id, ops: [TITLE] }, on);
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" }, on)).isError, undefined);
  assert.equal((await agent("check", { project: id }, on)).data.errors, 0);
  return { rev: edited.data.rev, turn: edited.data.turn };
}

// notes checkpoint; `at` is when its answer came back, on the steady clock.
async function checkpoint(project, kind, on = server) {
  const reply = await agent("notes", { project, action: "checkpoint", id: kind }, on);
  return { ...reply, at: performance.now() };
}

// kino refuses a chat answer under 5 s after the ask (too_fast): wait out 5.2 s since the ask on
// the steady clock (this PC's wall clock jumps by up to 8 s).
async function gap(askedAt) {
  for (let left = askedAt + 5200 - performance.now(); left > 0; left = askedAt + 5200 - performance.now())
    await new Promise((resolve) => setTimeout(resolve, left));
}

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

test("the person answers stops on the dashboard: saved as via dashboard, the agent hears it, its writes work again, and replies count", async () => {
  const project = "dstops-answer";
  const { rev } = await stopProject(project);
  const asked = await checkpoint(project, "rough");
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  // The stop card's data: the waiting stop with the ask the agent sends.
  const before = await snapshot(project);
  const saved = await savedState(project);
  assert.deepEqual(before.agent.stops.waiting, { id: "C1", kind: "rough", rev, askedAt: saved.stops[0].askedAt, client: "claude-code", ask: asked.data.ask, offer: ["color", "sound"] });
  assert.equal((await agent("edit", { project, ops: [move(700)] })).data.waiting, "C1");
  assert.equal((await answerIn(project, { id: "C1", rev, read_as: "approve" }, { review: false })).status, 403, "only an open dashboard window answers");

  // Hold is for the agent's writes: the person's answer still goes through, and the hold stays.
  assert.equal((await dashboard("hold", { body: { on: true } })).status, 200);
  try {
    const approved = await answerIn(project, { id: "C1", rev, read_as: "approve" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.stops.rounds[0].answer.heardAt, undefined, "the agent has not heard it yet");
    const event = await firstEvent(`?since=${before.seq}&boot=${before.boot}`, (entry) => entry.type === "stops" && entry.projectId === project);
    assert.deepEqual(event?.stops, approved.body.stops, "the dashboard hears the answer");
    assert.equal(approved.body.stops.waiting, null);
    assert.deepEqual(approved.body.stops, (await snapshot(project)).agent.stops);
    // The agent's next call, held, hands over the inbox: the answer reaches it.
    const held = await agent("edit", { project, ops: [move(700)] });
    assert.equal(held.data.held, true, "the hold stays on");
    assert.deepEqual(inboxOf(held), ["C1 rough approved by the person in kino. Go on."], held.text);
  } finally {
    await dashboard("hold", { body: { on: false } });
  }
  const { answer } = (await savedState(project)).stops[0];
  assert.match(answer.at, ISO);
  assert.ok(Number.isInteger(answer.afterSeconds) && answer.afterSeconds >= 0, JSON.stringify(answer));
  // The call that took the inbox marked the answer heard: the dashboard's line says so from this.
  assert.match(answer.heardAt ?? "", ISO, "heardAt");
  assert.deepEqual(answer, { via: "dashboard", words: null, read_as: "approve", at: answer.at, client: "dashboard", afterSeconds: answer.afterSeconds, heardAt: answer.heardAt });

  // The agent cannot record the same stop from the chat.
  const recorded = await agent("notes", { project, action: "answer", id: "C1", rev, words: "ok", read_as: "approve" });
  assert.deepEqual([recorded.isError, recorded.data.error], [true, "answered"]);
  assert.equal(recorded.data.reason, `C1 is already answered (approve in kino, ${answer.at.slice(11, 16)}). If they changed their mind, make the change and ask again.`);
  const status = await agent("status", { project });
  assert.deepEqual(status.text.split("\n").slice(1, 3), ["direction: C1 rough approved · replies 1/10", "step: follow the plan, then ask color"]);
  const edited = await agent("edit", { project, ops: [move(690)] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal(edited.data.rev, rev + 1, "writes work again");

  // Color: two answers at once, one wins; the agent hears that one.
  assert.equal((await agent("check", { project })).data.errors, 0);
  const color = await checkpoint(project, "color");
  assert.equal(color.data.id, "C2", color.text);
  const both = await Promise.all([
    answerIn(project, { id: "C2", rev: rev + 1, read_as: "approve with notes", words: "warmer" }),
    answerIn(project, { id: "C2", rev: rev + 1, read_as: "approve" }),
  ]);
  assert.deepEqual(both.map((reply) => reply.status).sort(), [200, 409], JSON.stringify(both.map((reply) => reply.body)));
  const won = both.find((reply) => reply.status === 200);
  const lost = both.find((reply) => reply.status === 409);
  const read = won.body.stops.rounds.at(-1).answer.read_as;
  assert.equal(lost.body.error, `C2 no longer waits: it is already answered (${read}, on the dashboard).`);
  const heard = inboxOf(await agent("status", { project }));
  assert.deepEqual(heard, [read === "approve" ? "C2 color approved by the person in kino. Go on." : 'C2 color approved by the person in kino, with notes: "warmer". Make those changes, then go on.']);

  // Sound: a redo with a note; the agent fixes it and asks again.
  const sound = await checkpoint(project, "sound");
  assert.equal(sound.data.id, "C3", sound.text);
  const redo = await answerIn(project, { id: "C3", rev: rev + 1, read_as: "redo", words: "the ding is too loud" });
  assert.equal(redo.status, 200, JSON.stringify(redo.body));
  const after = await agent("status", { project });
  assert.deepEqual(inboxOf(after), ['C3 sound: the person asked for a redo in kino: "the ding is too loud". Fix only what they named, check, then ask again: notes {action:"checkpoint", id:"sound"}.']);
  assert.deepEqual(after.text.split("\n").slice(1, 3), ["direction: C3 sound redo · replies 3/10", "step: fix what they named, check, ask sound again"]);
  assert.equal((await checkpoint(project, "sound")).data.id, "C4", "a redo asks again with a new id");
});

test("the stops route refuses with the message the dashboard shows: 400, 404, 409, and a refusal that closed a stop is published", async () => {
  const project = "dstops-refusals";
  const { rev, turn } = await stopProject(project);
  assert.equal((await stops(project, { action: "approve" })).body.error, "action is answer, reopen or keep_asking.");
  assert.equal((await stops(project, { action: "stop_asking" })).status, 400);
  assert.deepEqual(await stops("no such project!", { action: "answer" }), { status: 400, body: { error: "Choose a project." } });
  assert.equal((await checkpoint(project, "rough")).data.id, "C1");

  const refusals = [
    [{ id: "" }, 400, "Choose a stop: id is its C id, such as C2."],
    [{ read_as: "maybe" }, 400, "read_as is approve, approve with notes or redo."],
    [{ read_as: "stop asking" }, 400, '"Stop asking" is said in the chat. In kino, set a stop to allow in settings.'],
    [{ read_as: "approve", words: "warmer" }, 400, "approve takes no note: send approve with notes."],
    [{ read_as: "approve with notes", words: " " }, 400, "approve with notes needs a note (1–2000 characters)."],
    [{ read_as: "redo", words: "x".repeat(2001) }, 400, "A redo needs a note: say what to change (1–2000 characters)."],
    [{ read_as: "approve", rev: "latest" }, 400, `rev is the revision C1 showed (rev ${rev}).`],
    [{ id: "C9" }, 404, "kino never asked C9 in this project."],
    [{ read_as: "approve", rev: rev - 1 }, 409, `C1 showed rev ${rev}, not rev ${rev - 1}: look again.`],
  ];
  for (const [body, status, error] of refusals) {
    const reply = await answerIn(project, { id: "C1", rev, read_as: "approve", ...body });
    assert.deepEqual(reply, { status, body: { error } }, JSON.stringify(body));
  }
  assert.deepEqual(await reopen(project, "C1"), { status: 409, body: { error: "C1 is not answered yet: answer it instead." } });
  assert.deepEqual(await reopen(project, "C8"), { status: 404, body: { error: "kino never asked C8 in this project." } });
  assert.equal((await savedState(project)).stops[0].status, "waiting", "nothing was saved");

  // The person undoes the agent's turn on the dashboard: the stop showed work that is gone, so it
  // closed with the undo, and their answer is refused.
  const undone = await dashboard("undo", { body: { project, turn } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const now = (await (await server.api(`/api/projects/${project}`)).json()).revision;
  assert.equal((await snapshot(project)).agent.stops.waiting, null, "the undo closed C1");
  const late = await answerIn(project, { id: "C1", rev, read_as: "approve" });
  assert.deepEqual(late, { status: 409, body: { error: `C1 no longer waits: the work changed after it was asked (rev ${rev}, now rev ${now}). The agent asks again.` } });
  assert.deepEqual(await reopen(project, "C1"), { status: 409, body: { error: "C1 lapsed: nothing to reopen." } });

  // A write that does not go through the agent service (the project route) leaves C1 waiting
  // until an answer reads it: the refusal closes it, and the dashboard hears that.
  const put = "dstops-refusals-put";
  const putRev = (await stopProject(put)).rev;
  assert.equal((await checkpoint(put, "rough")).data.id, "C1");
  const record = await (await server.api(`/api/projects/${put}`)).json();
  record.document.scenes[0].duration = 20;
  assert.equal((await server.api(`/api/projects/${put}`, { method: "PUT", body: { document: record.document, revision: record.revision } })).status, 200);
  const { boot, seq } = await snapshot(put);
  const changed = await answerIn(put, { id: "C1", rev: putRev, read_as: "approve" });
  assert.deepEqual(changed, { status: 409, body: { error: `C1 no longer waits: the work changed after it was asked (rev ${putRev}, now rev ${putRev + 1}). The agent asks again.` } });
  const event = await firstEvent(`?since=${seq}&boot=${boot}`, (entry) => entry.type === "stops" && entry.projectId === put);
  assert.equal(event?.stops.waiting, null, "the settled stop is published");
  assert.equal(event.stops.rounds[0].status, "lapsed");

  // The person's settings allow the rough cut while it waits.
  const allowed = "dstops-allowed";
  await stopProject(allowed);
  assert.equal((await checkpoint(allowed, "rough")).data.id, "C1");
  try {
    assert.equal((await dashboard("settings", { method: "PUT", body: { approvals: { "checkpoint-rough": "allow" } } })).status, 200);
    const reply = await answerIn(allowed, { id: "C1", rev: (await savedState(allowed)).stops[0].rev, read_as: "approve" });
    assert.deepEqual(reply, { status: 409, body: { error: "C1 no longer waits: your settings allow the rough cut now." } });
    assert.deepEqual(await reopen(allowed, "C1"), { status: 409, body: { error: "C1 was allowed by your settings: set the rough cut to ask in settings." } });
  } finally {
    await dashboard("settings", { method: "PUT", body: { approvals: { "checkpoint-rough": "ask" } } });
  }
});

test("reopen: a chat answer that is not what the person meant is asked again; reopening \"stop asking\" turns the stops back on", async () => {
  const project = "dstops-reopen";
  const stopped = "dstops-stop-asking";
  const { rev } = await stopProject(project);
  const other = await stopProject(stopped);
  const asked = await checkpoint(project, "rough");
  const askedToo = await checkpoint(stopped, "rough");
  assert.deepEqual([asked.data.id, askedToo.data.id], ["C1", "C1"]);
  await gap(Math.max(asked.at, askedToo.at));

  const words = "approve but make the title a little bigger";
  const recorded = await agent("notes", { project, action: "answer", id: "C1", rev, words, read_as: "approve with notes" });
  assert.equal(recorded.isError, undefined, recorded.text);
  assert.equal((await reopen(project, "C1", { review: false })).status, 403);
  const reopened = await reopen(project, "C1");
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  const round = reopened.body.stops.rounds[0];
  assert.equal(round.status, "reopened");
  assert.match(round.reopenedAt, ISO);
  assert.deepEqual([round.answer.via, round.answer.words, round.answer.read_as], ["chat", words, "approve with notes"], "the agent's record is kept");
  assert.deepEqual(reopened.body.stops, (await snapshot(project)).agent.stops);

  const status = await agent("status", { project });
  assert.deepEqual(inboxOf(status), [`C1 rough reopened by the person in kino: your record "${words}" (approve with notes) is not what they meant. Ask again: notes {action:"checkpoint", id:"rough"}.`]);
  assert.deepEqual(status.text.split("\n").slice(1, 3), ["direction: C1 rough reopened · replies 1/10", "step: check, then ask rough again"]);
  const again = await agent("notes", { project, action: "answer", id: "C1", rev, words, read_as: "approve with notes" });
  assert.deepEqual([again.data.error, again.data.reason], ["reopened", 'C1 was reopened by the person in kino. Ask again: notes {action:"checkpoint", id:"rough"}.']);
  assert.equal((await checkpoint(project, "color")).data.error, "out_of_order", "later stops wait for the rough cut");
  const edited = await agent("edit", { project, ops: [move(640)] });
  assert.equal(edited.isError, undefined, "the agent's writes are not refused while it is reopened");
  assert.equal((await agent("check", { project })).data.errors, 0);
  const askedAgain = await checkpoint(project, "rough");
  assert.deepEqual([askedAgain.data.status, askedAgain.data.id], ["waiting_for_you", "C2"]);
  assert.deepEqual(await reopen(project, "C1"), { status: 409, body: { error: "C1 is already reopened." } });
  // A redo on the dashboard, asked again: the older round cannot be reopened.
  assert.equal((await answerIn(project, { id: "C2", rev: edited.data.rev, read_as: "redo", words: "bigger still" })).status, 200);
  assert.equal((await checkpoint(project, "rough")).data.id, "C3");
  assert.deepEqual(await reopen(project, "C2"), { status: 409, body: { error: "C2 has a newer round (C3) of the rough cut: reopen that one." } });
  assert.deepEqual(await answerIn(project, { id: "C1", rev, read_as: "approve" }), { status: 409, body: { error: "C1 was reopened: the agent asks again with a new id." } });
  // The person's own answer on the dashboard, taken back.
  assert.equal((await answerIn(project, { id: "C3", rev: edited.data.rev, read_as: "approve" })).status, 200);
  await agent("status", { project });
  assert.equal((await reopen(project, "C3")).status, 200);
  assert.deepEqual(inboxOf(await agent("status", { project })), ['C3 rough reopened by the person in kino: they take back their answer (approve). Ask again: notes {action:"checkpoint", id:"rough"}.']);

  // "stop asking" from the chat: color is allowed by it (keep asking undoes that, not reopen);
  // reopening the answer undoes "stop asking" too.
  const stopWords = "stop asking me, just make it";
  assert.equal((await agent("notes", { project: stopped, action: "answer", id: "C1", rev: other.rev, words: stopWords, read_as: "stop asking" })).isError, undefined);
  assert.equal((await checkpoint(stopped, "color")).data.by, "chat");
  assert.deepEqual(await reopen(stopped, "C2"), { status: 409, body: { error: 'C2 was allowed by "stop asking": use keep asking.' } });
  const undid = await reopen(stopped, "C1");
  assert.equal(undid.status, 200, JSON.stringify(undid.body));
  assert.match(undid.body.stops.stopAsking.undoneAt, ISO);
  assert.deepEqual(inboxOf(await agent("status", { project: stopped })), [`C1 rough reopened by the person in kino: your record "${stopWords}" (stop asking) is not what they meant. Ask again: notes {action:"checkpoint", id:"rough"}. Rough, color and sound ask again for this video.`]);
  assert.deepEqual(await stops(stopped, { action: "keep_asking" }), { status: 400, body: { error: "Nothing to undo: stops were not turned off in chat for this video." } });
  const roughAgain = await checkpoint(stopped, "rough");
  assert.deepEqual([roughAgain.data.status, roughAgain.data.id], ["waiting_for_you", "C3"]);
});

test("a restart keeps a dashboard answer: it still passes, the agent still hears it, and still cannot record it again", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-dashboard-stops-restart-"));
  const project = "dstops-restart";
  let first;
  let second;
  try {
    first = await startTestServer({ env: { MOTION_DATA_DIR: folder } });
    const { rev } = await stopProject(project, first);
    assert.equal((await checkpoint(project, "rough", first)).data.id, "C1");
    const approved = await answerIn(project, { id: "C1", rev, read_as: "approve with notes", words: "warmer" }, { on: first, withKey: await reviewKey(first) });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    await first.stop();
    first = null;
    second = await startTestServer({ env: { MOTION_DATA_DIR: folder } });
    const saved = (await savedState(project, folder)).stops[0];
    assert.deepEqual([saved.status, saved.answer.via, saved.answer.words], ["answered", "dashboard", "warmer"]);
    const edited = await agent("edit", { project, ops: [move(700)] }, second);
    assert.equal(edited.isError, undefined, edited.text);
    assert.deepEqual(edited.data.inbox, ['C1 rough approved by the person in kino, with notes: "warmer". Make those changes, then go on.']);
    const recorded = await agent("notes", { project, action: "answer", id: "C1", rev, words: "warmer", read_as: "approve with notes" }, second);
    assert.equal(recorded.data.error, "answered");
    assert.equal(recorded.data.reason, `C1 is already answered (approve with notes in kino, ${saved.answer.at.slice(11, 16)}). If they changed their mind, make the change and ask again.`);
  } finally {
    await first?.stop();
    await second?.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("a stop waiting in a project that is not open is in the snapshot of another project (waitingStops), so needs you shows it", async () => {
  const project = "dstops-elsewhere";
  const other = "dstops-elsewhere-open";
  await stopProject(other);
  await stopProject(project);
  const asked = await checkpoint(project, "rough");
  assert.equal(asked.data.id, "C1");
  // The person opened the other project (follow off); the agent's project is still current.
  const shown = await snapshot(other);
  assert.equal(shown.projectId, other);
  assert.equal(shown.agent.stops.waiting, null, "the open project has no stop");
  const { ask, ...rest } = shown.waitingStops[project];
  assert.deepEqual(rest, { id: "C1", kind: "rough", rev: asked.data.rev, askedAt: rest.askedAt, client: "claude-code", offer: ["color", "sound"] });
  assert.equal(ask, asked.data.ask);
  assert.equal(shown.waitingStops[other], undefined, "only waiting stops are listed");
  // Answered, it leaves the list.
  assert.equal((await answerIn(project, { id: "C1", rev: asked.data.rev, read_as: "approve" })).status, 200);
  assert.deepEqual((await snapshot(other)).waitingStops, {});
});

// A service of its own on a project with a stop waiting (C1 rough), with a wall clock and a
// steady clock the test moves (boot 0: this service's steady clock counts from boot 0).
async function clockService(t, id) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-dstops-clock-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id, name: id, scenes: [createScene({ id: "s1", width: 1080, height: 1920, duration: 24 })] }));
  const fonts = await loadBundledFonts();
  const wall = { at: Date.parse("2026-10-21T14:00:00.000Z") };
  const steady = { at: 50_000 };
  const agentState = createAgentStateStore(dataRoot);
  const service = createAgentService({
    store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts, operationContext: async () => ({}),
    quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
    saveDocument: (projectId, before, document, expectedRevision, { request, resultMetadata } = {}) => store.updateProject(projectId, document, expectedRevision, { request, resultMetadata }),
    now: () => wall.at, steadyNow: () => steady.at,
  });
  const call = (verb, input) => service.call(verb, { project: id, ...input }, { client: "claude-code" });
  const edited = await call("edit", { ops: [TITLE] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal((await call("notes", { action: "brief", no_playback: "just start" })).isError, undefined);
  assert.equal((await call("check", {})).data.errors, 0);
  const asked = await call("notes", { action: "checkpoint", id: "rough" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  return { service, agentState, wall, steady, rev: asked.data.rev };
}

test("a dashboard answer's afterSeconds is measured on the steady clock: a wall clock jump changes nothing", async (t) => {
  const id = "dstops-clock";
  const { service, wall, steady, rev } = await clockService(t, id);
  // 6.4 s pass; the wall clock jumps 15 s ahead (as WSL 2 steps it here).
  steady.at += 6400;
  wall.at += 15_000;
  const summary = await service.answerStop(id, { id: "C1", rev, read_as: "approve" });
  assert.equal(summary.rounds[0].answer.afterSeconds, 6, "6.4 s on the steady clock, not 15 s on the wall clock");
});

test("after a reboot a dashboard answer's afterSeconds is the time since askedAt: the old boot's steady stamp is not used", async (t) => {
  const id = "dstops-reboot";
  const { service, agentState, wall, steady, rev } = await clockService(t, id);
  // The stop was asked before a reboot a day ago: its steady stamp counts from that boot.
  await agentState.update(id, (draft) => { draft.stops[0].steady.boot = -86_400_000; });
  steady.at += 6400;
  wall.at += 40_000;
  const summary = await service.answerStop(id, { id: "C1", rev, read_as: "approve" });
  assert.equal(summary.rounds[0].answer.afterSeconds, 40, "40 s since askedAt, not 6 s from another boot's stamp");
});

test("your undo, or a longer skip-under length, closes a waiting stop at once: the snapshot and the stream stop showing it", async () => {
  const project = "dstops-settle";
  const { rev, turn } = await stopProject(project);
  assert.equal((await checkpoint(project, "rough")).data.id, "C1");
  const before = await snapshot(project);
  assert.equal(before.agent.stops.waiting?.id, "C1");
  // Undo the agent's turn: the work C1 showed is gone, so C1 can no longer be answered.
  const undone = await dashboard("undo", { body: { project, turn } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const call = await firstEvent(`?since=${before.seq}&boot=${before.boot}`, (entry) => entry.type === "call" && entry.projectId === project && entry.event?.verb === "history");
  assert.equal(call?.agent?.stops?.waiting, null, "the undo's call event carries no waiting stop");
  const after = await snapshot(project);
  assert.equal(after.record.revision, rev + 1);
  assert.equal(after.agent.stops.waiting, null);
  assert.deepEqual([after.agent.stops.rounds[0].status, after.agent.stops.rounds[0].lapsedRev], ["lapsed", rev + 1]);
  assert.equal(after.waitingStops[project], undefined);

  // A skip-under length longer than the video (24 s): this video has no rough cut stop now.
  const skip = "dstops-settle-skip";
  await stopProject(skip);
  assert.equal((await checkpoint(skip, "rough")).data.id, "C1");
  const shown = await snapshot(skip);
  try {
    assert.equal((await dashboard("settings", { method: "PUT", body: { limits: { skipRoughUnder: 30 } } })).status, 200);
    const event = await firstEvent(`?since=${shown.seq}&boot=${shown.boot}`, (entry) => entry.type === "stops" && entry.projectId === skip);
    assert.equal(event?.stops?.waiting, null, "the dashboard hears that C1 closed");
    const round = (await snapshot(skip)).agent.stops.rounds[0];
    assert.deepEqual([round.status, round.lapsedFor], ["lapsed", "under 30 s"]);
  } finally {
    await dashboard("settings", { method: "PUT", body: { limits: { skipRoughUnder: 15 } } });
  }
});
