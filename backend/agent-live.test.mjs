// The live view's server side (milestone LIVE, backend/agent/live.mjs and its use in service.mjs):
// agent names and colors from the thin client's x-kino-session header, presence events (start and
// done) on the dashboard stream, building marks cleared by a covering look or a new turn, pointing
// at a time range, the snapshot's new fields, and the session header the MCP client and the kino
// command line send by themselves. Most of it runs on a real server with a temporary data folder;
// the turn test runs the service in this process with a clock it moves.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDocument, createScene } from "../engine/model.js";
import { createAgentClient } from "./agent/client.mjs";
import { agentSession, parseProcessTable, processChain } from "./agent/agent-session.mjs";
import { agentToolList } from "./agent/tool-sync.mjs";
import { cleanKind, coveredLayers, createLiveAgents, layerWindow, NAMES, PALETTE } from "./agent/live.mjs";
import { defaultSettings, mergeSettings } from "./agent/dashboard.mjs";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { stopsSummary } from "./agent/stops.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { startTestServer } from "./media.test.support.mjs";
import { openStore } from "./store.mjs";
import { SKIP_BOARD_APPROVALS, skipBoardOn } from "./stops.test.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOVA = "test-nova-1";
const JUNO = "test-juno-2";

let server;
let key;
before(async () => {
  server = await startTestServer();
  const response = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  key = (await response.json()).key;
  // The stops asked here are the rough cut's: the storyboard is skipped (stops.test.support.mjs).
  await skipBoardOn(server);
});
after(() => server?.stop());

// One agent call, as the thin client sends it: its kind in `client`, its session in the header.
async function agent(verb, body = {}, { session = NOVA, client = "claude-code" } = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client, ...body }, headers: session ? { "x-kino-session": session } : {} });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function dashboard(route, { method = "POST", body } = {}) {
  const response = await server.api(`/api/dashboard/${route}`, { method, body, headers: { "x-kino-review": key } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const snapshot = async (project = "live") => (await dashboard(`snapshot?project=${project}`, { method: "GET" })).body;

// Runs `work`, then returns every stream event published while it ran (the stream's replay).
async function eventsDuring(work) {
  const { boot, seq } = await snapshot();
  await work();
  const response = await server.api(`/api/dashboard/stream?since=${seq}&boot=${boot}`);
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data:"));
        if (!data) continue;
        const event = JSON.parse(data.slice(5));
        if (event.type === "replayed") return events;
        events.push(event);
      }
    }
  } finally {
    await response.body.cancel().catch(() => {});
  }
  return events;
}
const presences = (events) => events.filter((event) => event.type === "presence").map((event) => event.presence);

// WCAG contrast, hue and HSV saturation of a #rrggbb color.
const channels = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
function hueOf(hex) {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (hue * 60 + 360) % 360;
}
const saturation = (hex) => { const values = channels(hex); const max = Math.max(...values); return max ? (max - Math.min(...values)) / max : 0; };
const hueGap = (a, b) => { const gap = Math.abs(a - b) % 360; return Math.min(gap, 360 - gap); };

test("each session gets the next name and color and keeps it; no session, or a bad one, is \"agent\"; the kind is cleaned", () => {
  const live = createLiveAgents();
  assert.deepEqual(live.identify({ session: "session-one", kind: "claude-code" }), { id: "a1", name: "Nova", color: "#42c0b6", kind: "claude-code" });
  assert.deepEqual(live.identify({ session: "session-two", kind: "codex" }), { id: "a2", name: "Juno", color: "#6cb6ff", kind: "codex" });
  assert.deepEqual(live.identify({ session: "session-one", kind: "claude-code" }), { id: "a1", name: "Nova", color: "#42c0b6", kind: "claude-code" }, "the same session keeps its name");
  assert.deepEqual(live.identify({ kind: "claude-code" }), { id: "legacy-claude-code", name: "agent", color: PALETTE[0], kind: "claude-code" });
  for (const bad of ["ab", "has space", "x".repeat(33), "semi;colon", 42])
    assert.equal(live.identify({ session: bad, kind: "cli" }).name, "agent", `${String(bad)} counts as no session`);
  for (let index = 3; index <= NAMES.length + 1; index += 1) live.identify({ session: `session-${index}`, kind: "cli" });
  assert.equal(live.identify({ session: `session-${NAMES.length + 1}` }).name, "Nova 2", "the 13th agent is Nova 2");
  const hostile = cleanKind(`<b>x‮y</b>${"z".repeat(40)}`);
  assert.ok(hostile.length <= 32, hostile);
  assert.match(hostile, /^[A-Za-z0-9 ._-]+$/);
  assert.equal(cleanKind("‮\u0000<>"), "agent");
});

test("the agent colors read on every dark background, none is purple, and each is clear of the state colors", () => {
  for (const color of PALETTE) {
    for (const background of ["#0b0e12", "#151921", "#181d25"])
      assert.ok(contrast(color, background) >= 4.5, `${color} on ${background}: ${contrast(color, background).toFixed(2)}`);
    if (saturation(color) < 0.25) continue;
    const hue = hueOf(color);
    assert.ok(hue < 260 || hue > 320, `${color} (hue ${hue.toFixed(0)}) is not purple`);
    for (const state of ["#ff7d3d", "#f4673a", "#ef5350", "#e5b454", "#5fd89a"])
      assert.ok(hueGap(hue, hueOf(state)) >= 15, `${color} is at least 15° of hue from ${state}`);
  }
});

test("a look covers the layers it names, the layers on screen at its time, or those on screen during its range", () => {
  const scene = { id: "s1", duration: 10, layers: [
    { id: "always", animations: [] },
    { id: "late", animations: [{ id: "a1", kind: "in", start: 6, duration: 1 }] },
    { id: "early", animations: [{ id: "a2", kind: "out", start: 2, duration: 1 }, { id: "a3", kind: "in", start: 8, duration: 1, enabled: false }] },
  ] };
  assert.deepEqual(layerWindow(scene.layers[2], scene), [0, 3], "an exit ends the window; a disabled entrance does not count");
  assert.deepEqual([...coveredLayers(scene, { time: 4 })].sort(), ["always"]);
  assert.deepEqual([...coveredLayers(scene, { time: 7 })].sort(), ["always", "late"]);
  assert.deepEqual([...coveredLayers(scene, { range: [2.5, 6] })].sort(), ["always", "early", "late"]);
  assert.deepEqual([...coveredLayers(scene, { range: [4, 5] })].sort(), ["always"]);
  assert.deepEqual([...coveredLayers(scene, { layerIds: ["late"] })], ["late"], "zoom, source or strip on a layer covers that layer");
  assert.deepEqual([...coveredLayers(scene, null)], []);
});

test("two agents on one server are Nova and Juno, a call without a session is \"agent\", and the snapshot keys them by id", async () => {
  const events = await eventsDuring(async () => {
    const created = await agent("project", { action: "create", id: "live", name: "Live", width: 640, height: 360, duration: 4 });
    assert.equal(created.isError, undefined, created.text);
    await agent("status", {}, { session: JUNO, client: "codex" });
    await agent("status", {}, { session: null, client: "older-client" });
  });
  const [nova, juno, legacy] = ["project", "status", "status"].map((verb, index) => presences(events).filter((presence) => presence.phase === "done")[index]);
  assert.deepEqual(nova.agent, { id: "a1", name: "Nova", color: "#42c0b6", kind: "claude-code" });
  assert.deepEqual(juno.agent, { id: "a2", name: "Juno", color: "#6cb6ff", kind: "codex" });
  assert.deepEqual(legacy.agent, { id: "legacy-older-client", name: "agent", color: PALETTE[0], kind: "older-client" });
  const calls = events.filter((event) => event.type === "call");
  assert.equal(calls[0].event.agent.name, "Nova", "the call log row keeps the agent's name");
  assert.equal(calls[0].event.label, "create project Live");
  const shot = await snapshot();
  assert.ok(Number.isFinite(Date.parse(shot.now)), "the snapshot has the server's time");
  const rows = Object.fromEntries(shot.agents.map((row) => [row.id, row]));
  assert.equal(rows.a1.name, "Nova");
  assert.equal(rows.a1.color, "#42c0b6");
  assert.equal(rows.a2.kind, "codex");
  assert.equal(rows["legacy-older-client"].name, "agent");
  for (const row of shot.agents) assert.deepEqual(Object.keys(row).sort(), ["color", "id", "isError", "kind", "lastAt", "lastVerb", "name", "projectId"]);
  assert.deepEqual(shot.presence.latest.map((presence) => presence.agent.id), ["legacy-older-client", "a2", "a1"], "one per agent, newest first");
  assert.ok(shot.presence.latest.every((presence) => presence.phase === "done" && presence.at));
  assert.deepEqual(shot.presence.building, []);
});

test("a look is published as start, then done, with the same call number, a plain label and what it looked at", async () => {
  const events = await eventsDuring(() => agent("look", { mode: "sheet", from: 1, to: 2 }));
  const seen = presences(events);
  assert.deepEqual(seen.map((presence) => presence.phase), ["start", "done"]);
  const [start, done] = seen;
  assert.equal(start.call, done.call);
  assert.equal(done.label, "look at 1.0–2.0 s");
  assert.equal(start.label, done.label);
  assert.equal(done.write, false);
  assert.deepEqual(done.target.range, [1, 2]);
  assert.deepEqual(start.target.range, [1, 2]);
  assert.match(done.target.text, /1\.0–2\.0 s/);
  assert.equal(typeof done.ms, "number");
  assert.equal(start.ms, null);
  // The presence comes after the call's own row in the log.
  const order = events.filter((event) => event.type === "call" || event.type === "presence").map((event) => event.type === "call" ? "call" : event.presence.phase);
  assert.deepEqual(order, ["start", "call", "done"]);
});

test("calls by the person and the dashboard's quiet reads publish no presence", async () => {
  const events = await eventsDuring(async () => {
    await agent("render", { by: "you", action: "status" });
    const quiet = await dashboard("act/check", { body: { project: "live", quiet: true } });
    assert.equal(quiet.status, 200);
    await agent("no_such_verb", {});
  });
  assert.deepEqual(presences(events), []);
});

test("an edit marks the layers it changed as building; a look that covers one clears it, and one that does not leaves it", async () => {
  let edit;
  const events = await eventsDuring(async () => {
    edit = await agent("edit", { ops: [
      { op: "add_layer", type: "rectangle", name: "card", properties: { x: 20, y: 20, width: 200, height: 100, fill: "#3CC8B4" } },
      { op: "add_layer", type: "rectangle", name: "badge", properties: { x: 300, y: 20, width: 80, height: 80, fill: "#E5B454" } },
      { op: "add_animation", layer: "badge", preset: "preset-fade", start: 3, duration: 0.4 },
    ] });
  });
  assert.equal(edit.isError, undefined, edit.text);
  const done = presences(events).find((presence) => presence.phase === "done");
  assert.equal(done.write, true);
  assert.equal(done.label, "add rectangle card +2 more");
  const { document } = (await snapshot()).record;
  const scene = document.scenes[0];
  const card = scene.layers.find((layer) => layer.name === "card");
  const badge = scene.layers.find((layer) => layer.name === "badge");
  assert.deepEqual(new Set(done.changed.layerIds), new Set([card.id, badge.id]));
  assert.equal(done.changed.sceneId, scene.id);
  assert.deepEqual(layerWindow(badge, scene), [3, 4], "the badge is on screen from its entrance at 3 s");
  const building = () => snapshot().then((shot) => shot.presence.building.map((entry) => entry.layerId).sort());
  assert.deepEqual(await building(), [card.id, badge.id].sort());
  assert.ok(done.building.every((entry) => entry.agentId === "a1" && entry.sceneId === scene.id && entry.at));

  // A frame at 0.5 s shows the card but not the badge.
  const frame = await agent("look", { mode: "frame", t: 0.5 }, { session: JUNO, client: "codex" });
  assert.equal(frame.isError, undefined, frame.text);
  assert.deepEqual(await building(), [badge.id], "any agent's covering look clears a mark");
  // A sheet of 3–4 s covers the badge.
  const events2 = await eventsDuring(() => agent("look", { mode: "sheet", from: 3, to: 4 }));
  assert.deepEqual(await building(), []);
  assert.deepEqual(presences(events2).at(-1).building, []);
});

test("pointing at a time range reads in the agent's status exactly as the dashboard shows it; bad ranges are refused", async () => {
  const { document } = (await snapshot()).record;
  const scene = document.scenes[0];
  const card = scene.layers.find((layer) => layer.name === "card");
  let pointed;
  const events = await eventsDuring(async () => {
    pointed = await dashboard("point", { body: { project: "live", sceneId: scene.id, layerIds: [], range: [2, 3.5] } });
  });
  assert.equal(pointed.status, 200, JSON.stringify(pointed.body));
  const line = pointed.body.pointing.line;
  assert.match(line, /^2\.0–3\.5 s in \S+ \(you selected it in the dashboard\)$/);
  assert.deepEqual(pointed.body.pointing.range, [2, 3.5]);
  assert.equal(events.find((event) => event.type === "pointing").pointing.line, line);
  assert.ok((await agent("status")).text.includes(`pointing ${line}`), "status reads the dashboard's line word for word");

  const both = await dashboard("point", { body: { project: "live", sceneId: scene.id, layerIds: [card.id], range: [2.004, 3.5] } });
  assert.match(both.body.pointing.line, /^card at 2\.0–3\.5 s in \S+ \(you selected it in the dashboard\)$/);
  assert.ok((await agent("status")).text.includes(`pointing ${both.body.pointing.line}`));
  const layers = await dashboard("point", { body: { project: "live", sceneId: scene.id, layerIds: [card.id] } });
  assert.equal(layers.body.pointing.line, "card (you selected it in the dashboard)");
  assert.equal(layers.body.pointing.range, null);
  assert.match((await agent("status")).text, /pointing card \(you selected it in the dashboard\)/);

  for (const range of [[3, 2], [2, 2], [-1, 1], [0, 40_000], [1], [1, "2"], "1-2", { start: 1, end: 2 }]) {
    const refused = await dashboard("point", { body: { project: "live", sceneId: scene.id, layerIds: [], range } });
    assert.equal(refused.status, 400, `${JSON.stringify(range)} is refused`);
    assert.match(refused.body.error, /range is \[start, end\] in seconds, start before end\./);
  }
  const noScene = await dashboard("point", { body: { project: "live", layerIds: [], range: [1, 2] } });
  assert.equal(noScene.status, 400);
  const otherScene = await dashboard("point", { body: { project: "live", sceneId: "nope", layerIds: [], range: [1, 2] } });
  assert.equal(otherScene.status, 400);
  const cleared = await dashboard("point", { body: { project: "live", layerIds: [] } });
  assert.equal(cleared.body.pointing, null);
  assert.doesNotMatch((await agent("status")).text, /pointing /);
});

test("an approval keeps the agent that asked for it, with this server run's boot", async () => {
  let asked;
  const events = await eventsDuring(async () => {
    asked = await agent("project", { action: "share", id: "live", role: "view" }, { session: JUNO, client: "codex" });
  });
  assert.equal(asked.data?.status, "awaiting_approval", asked.text);
  // Review round 2: the call has not run; its done presence says it waits for your approval.
  const done = presences(events).find((presence) => presence.phase === "done");
  assert.equal(done.approval, asked.data.id, "the marker and the log say it waits, not that it ran");
  assert.equal(done.isError, false);
  const shot = await snapshot();
  const approval = shot.approvals.find((entry) => entry.id === asked.data.id);
  // The boot: after a restart "a2" may be another agent, so the dashboard matches the wait to
  // this agent only while the boot is the same (state.js waitingFor).
  assert.deepEqual(approval.agent, { id: "a2", name: "Juno", color: "#6cb6ff", kind: "codex", boot: shot.boot });
  assert.equal(approval.client, "codex");
  const withdrawn = await agent("render", { action: "cancel", job: asked.data.id }, { session: JUNO, client: "codex" });
  assert.equal(withdrawn.isError, undefined, withdrawn.text);
});

test("a call you approve runs again without a marker: no presence, and its log row keeps the agent that asked", async () => {
  const asked = await agent("project", { action: "share", id: "live", role: "view" }, { session: JUNO, client: "codex" });
  assert.equal(asked.data?.status, "awaiting_approval", asked.text);
  let allowed;
  const events = await eventsDuring(async () => {
    allowed = await dashboard(`approvals/${asked.data.id}`, { body: { decision: "allow" } });
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual(presences(events), [], "the replay is not the agent at work now");
  const row = events.find((event) => event.type === "call" && event.event?.approved)?.event;
  assert.ok(row, "the approved call is in the log");
  assert.equal(row.agent?.id, "a2");
  assert.equal(row.agent?.name, "Juno");
  // The snapshot's agents keep Juno's own last call, not the replay.
  const juno = (await snapshot()).agents.find((entry) => entry.id === "a2");
  assert.ok(!juno || !juno.approved);
});

test("a write you hold is shown as held, not as a change", async () => {
  assert.equal((await dashboard("hold", { body: { on: true } })).status, 200);
  try {
    const events = await eventsDuring(async () => {
      const held = await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { x: 30 } }] });
      assert.equal(held.data?.held, true, held.text);
    });
    const done = presences(events).find((presence) => presence.phase === "done");
    assert.equal(done.held, true);
    assert.equal(done.changed, null);
    const row = events.find((event) => event.type === "call")?.event;
    assert.equal(row.held, true);
  } finally {
    assert.equal((await dashboard("hold", { body: { on: false } })).status, 200);
  }
});

test("a new turn empties the building marks", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-live-turn-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id: "turns", name: "turns", scenes: [createScene({ id: "s1", duration: 4 })] }));
  const fonts = await loadBundledFonts();
  const wall = { at: Date.parse("2026-10-25T10:00:00.000Z") };
  let seq = 0;
  const published = [];
  const live = createLiveAgents({ now: () => wall.at, publish: (event) => { const entry = { seq: ++seq, at: new Date(wall.at).toISOString(), ...event }; published.push(entry); return entry; } });
  const service = createAgentService({
    store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts, operationContext: async () => ({}),
    quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
    saveDocument: (projectId, before, document, expectedRevision, { request, resultMetadata } = {}) => store.updateProject(projectId, document, expectedRevision, { request, resultMetadata }),
    now: () => wall.at, live,
  });
  const meta = { client: "claude-code", session: "turn-session" };
  const edited = await service.call("edit", { project: "turns", ops: [{ op: "add_layer", type: "rectangle", name: "box", properties: { width: 50, height: 50 } }] }, meta);
  assert.equal(edited.isError, undefined, edited.text);
  assert.deepEqual(live.building("turns").map((entry) => entry.layerId), ["box"]);
  const firstTurn = live.turn("turns");
  // A call a minute later is the same turn: the mark stays.
  wall.at += 60_000;
  await service.call("status", { project: "turns" }, meta);
  assert.equal(live.turn("turns"), firstTurn);
  assert.equal(live.building("turns").length, 1);
  // After more than two quiet minutes the next call starts a new turn: the marks go.
  wall.at += 121_000;
  await service.call("status", { project: "turns" }, meta);
  assert.notEqual(live.turn("turns"), firstTurn);
  assert.deepEqual(live.building("turns"), []);
  assert.deepEqual(published.at(-1).presence.building, []);
  assert.equal(published.at(-1).presence.agent.name, "Nova");
  // A call by the person publishes nothing.
  const count = published.length;
  await service.call("status", { project: "turns" }, { by: "you", client: "dashboard" });
  await service.call("status", { project: "turns" }, { ...meta, quiet: true });
  assert.equal(published.length, count);
});

// A service of its own (no HTTP), with a wall clock the test moves and every published event
// kept. `look` stands in for the renderer: frameImage waits for `gate` when one is set.
async function liveService(t, { id = "turns", width = 1920, height = 1080, duration = 4, emit, boot = "boot-1" } = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-live-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id, name: id, scenes: [createScene({ id: "s1", width, height, duration })] }));
  const fonts = await loadBundledFonts();
  const wall = { at: Date.parse("2026-10-25T10:00:00.000Z") };
  let seq = 0;
  const published = [];
  const live = createLiveAgents({ now: () => wall.at, boot, publish: (event) => { const entry = { seq: ++seq, at: new Date(wall.at).toISOString(), ...event }; published.push(entry); return entry; } });
  const gates = { frame: null };
  const look = {
    async frameImage() { await gates.frame; return { png: null, frames: [] }; },
    async save() { return path.join(dataRoot, "look.png"); },
  };
  const agentState = createAgentStateStore(dataRoot);
  const service = createAgentService({
    store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"), look,
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts, operationContext: async () => ({}),
    quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
    saveDocument: (projectId, before, document, expectedRevision, { request, resultMetadata } = {}) => store.updateProject(projectId, document, expectedRevision, { request, resultMetadata }),
    now: () => wall.at, live, ...(emit ? { emit } : {}),
    // The stops asked here are the rough cut's: the storyboard is skipped (stops.test.support.mjs).
    approvals: SKIP_BOARD_APPROVALS,
  });
  const as = (session) => ({ client: "claude-code", session });
  return { service, live, published, wall, gates, agentState, as, id };
}
const presencesOf = (published) => published.filter((event) => event.type === "presence").map((event) => event.presence);
const box = (name, x = 0) => ({ op: "add_layer", type: "rectangle", name, properties: { x, y: 0, width: 50, height: 50 } });

test("the first call of a new turn starts with no marks from the last turn", async (t) => {
  const { service, live, published, wall, as } = await liveService(t);
  assert.equal((await service.call("edit", { project: "turns", ops: [box("box")] }, as("nova"))).isError, undefined);
  assert.equal(live.building("turns").length, 1);
  wall.at += 121_000;
  const from = published.length;
  await service.call("status", { project: "turns" }, as("nova"));
  const [start] = presencesOf(published.slice(from));
  assert.equal(start.phase, "start");
  assert.deepEqual(start.building, [], "the last turn's marks are not shown again");
  assert.equal(start.turn, null);
});

test("your undo ends the agent's turn: its building marks go at once, with a building event", async (t) => {
  const { service, live, published, as } = await liveService(t);
  assert.equal((await service.call("edit", { project: "turns", ops: [box("box")] }, as("nova"))).isError, undefined);
  const turn = live.turn("turns");
  assert.equal(live.building("turns").length, 1);
  const from = published.length;
  const undone = await service.call("history", { project: "turns", action: "revert", turn }, { by: "you", client: "dashboard" });
  assert.equal(undone.isError, undefined, undone.text);
  assert.deepEqual(live.building("turns"), []);
  const told = published.slice(from).filter((event) => event.type === "building");
  assert.equal(told.length, 1, "one building event tells the dashboard");
  assert.deepEqual(told[0], { ...told[0], projectId: "turns", building: [] });
  assert.deepEqual(presencesOf(published.slice(from)), [], "the person's call is no agent's presence");
});

// Review round 2: the agent's own revert ends its turn (turnBreak), as your undo does. Its marks
// went only with its next call, so the dashboard kept outlines on work that was gone.
test("the agent's own revert ends its turn: its building marks go with that call", async (t) => {
  const { service, live, published, wall, as } = await liveService(t);
  const call = (verb, input) => service.call(verb, { project: "turns", ...input }, as("nova"));
  assert.equal((await call("edit", { ops: [box("box")] })).isError, undefined);
  assert.equal((await call("look", { mode: "frame", t: 1 })).isError, undefined);
  assert.deepEqual(live.building("turns"), [], "the look covered the box");
  wall.at += 121_000;
  const moved = await call("edit", { ops: [{ op: "update_layer", layer: "box", properties: { x: 300 } }] });
  assert.equal(moved.isError, undefined, moved.text);
  assert.deepEqual(live.building("turns").map((entry) => entry.layerId), ["box"], "the move marks the box, which stays in the video");
  const from = published.length;
  const reverted = await call("history", { action: "revert", turn: moved.data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  assert.deepEqual(live.building("turns"), [], "the reverted turn's marks are gone");
  const done = presencesOf(published.slice(from)).find((presence) => presence.phase === "done");
  assert.deepEqual(done.building, [], "the revert's own done presence shows no marks");
});

// Review round 2: a save's marks are set when its call is done, after its call event. A look of
// the same (or a later) revision that finished in between covered those layers already.
test("a look that finished before its save's marks were set still covers them", () => {
  const live = createLiveAgents();
  const document = createDocument({ id: "p", name: "p", scenes: [createScene({ id: "s1", duration: 4 })] });
  live.looked("p", [{ sceneId: "s1", layerIds: ["box"] }], { document, rev: 2 });
  live.wrote("p", null, { agentId: "a1", layers: [{ sceneId: "s1", layerId: "box" }, { sceneId: "s1", layerId: "other" }], rev: 2 });
  assert.deepEqual(live.building("p").map((entry) => entry.layerId), ["other"], "the box was drawn at revision 2; the other layer was not looked at");
  live.looked("p", [{ sceneId: "s1", layerIds: ["late"] }], { document, rev: 2 });
  live.wrote("p", null, { agentId: "a1", layers: [{ sceneId: "s1", layerId: "late" }], rev: 3 });
  assert.deepEqual(live.building("p").map((entry) => entry.layerId), ["other", "late"], "a look of an older revision does not cover a newer save");
});

// Review round 2: the live view reads no project of its own. Before, every agent call read (and
// parsed) the whole project store once more for its start presence.
test("the live view adds no read of the project store to a call", async (t) => {
  const reads = async (withLive) => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-live-reads-"));
    t.after(() => rm(dataRoot, { recursive: true, force: true }));
    const store = await openStore(dataRoot);
    await store.createProject(createDocument({ id: "reads", name: "reads", scenes: [createScene({ id: "s1", duration: 4 })] }));
    let count = 0;
    const counted = Object.create(store);
    counted.getProject = (...args) => { count += 1; return store.getProject(...args); };
    const fonts = await loadBundledFonts();
    const service = createAgentService({
      store: counted, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
      exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts, operationContext: async () => ({}),
      quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
      saveDocument: (projectId, before, document, expectedRevision, options = {}) => store.updateProject(projectId, document, expectedRevision, options),
      ...(withLive ? { live: createLiveAgents() } : {}),
    });
    const meta = { client: "claude-code", session: "reads-1" };
    assert.equal((await service.call("edit", { project: "reads", ops: [box("box")] }, meta)).isError, undefined);
    const counts = [];
    for (const verb of ["status", "check", "status"]) {
      count = 0;
      assert.equal((await service.call(verb, { project: "reads" }, meta)).isError, undefined);
      counts.push(count);
    }
    return counts;
  };
  assert.deepEqual(await reads(true), await reads(false));
});

test("a look that drew an older revision leaves another agent's newer save building", async (t) => {
  const { service, live, gates, as } = await liveService(t);
  assert.equal((await service.call("edit", { project: "turns", ops: [box("box")] }, as("nova"))).isError, undefined);
  let release;
  gates.frame = new Promise((resolve) => { release = resolve; });
  // Nova's frame reads the project (rev 1: the box), then waits in the renderer.
  const looking = service.call("look", { project: "turns", mode: "frame", t: 1 }, as("nova"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Juno saves a new layer, on screen at 1 s, while the frame renders the older revision.
  const juno = await service.call("edit", { project: "turns", ops: [box("late", 100)] }, as("juno"));
  assert.equal(juno.isError, undefined, juno.text);
  release();
  const looked = await looking;
  assert.equal(looked.isError, undefined, looked.text);
  assert.deepEqual(live.building("turns").map((entry) => entry.layerId), ["late"], "the box was drawn and is checked; the late layer was not drawn");
});

test("each presence says how many of the agent's calls still run, so a quiet agent is one with none", async (t) => {
  const { service, published, gates, as } = await liveService(t);
  let release;
  gates.frame = new Promise((resolve) => { release = resolve; });
  const looking = service.call("look", { project: "turns", mode: "frame", t: 1 }, as("nova"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await service.call("status", { project: "turns" }, as("nova"));
  const statusDone = presencesOf(published).find((presence) => presence.verb === "status" && presence.phase === "done");
  assert.equal(statusDone.running, 1, "the look still runs");
  release();
  await looking;
  const lookDone = presencesOf(published).find((presence) => presence.verb === "look" && presence.phase === "done");
  assert.equal(lookDone.running, 0);
});

test("a call that fails after its handler (the log could not be told) is still shown as done", async (t) => {
  const { service, published, as } = await liveService(t, { emit: async () => { throw new Error("disk full"); } });
  await assert.rejects(service.call("status", { project: "turns" }, as("nova")), /disk full/);
  const shown = presencesOf(published);
  assert.deepEqual(shown.map((presence) => presence.phase), ["start", "done"]);
  assert.equal(shown[1].isError, true);
  assert.equal(shown[1].running, 0);
});

test("a stop round keeps the agent that asked and this server run's boot, for the dashboard", async (t) => {
  const { service, agentState, as } = await liveService(t, { id: "stopped", width: 1080, height: 1920, duration: 24, boot: "boot-7" });
  const call = (verb, input) => service.call(verb, { project: "stopped", ...input }, as("nova"));
  const title = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
  assert.equal((await call("edit", { ops: [title] })).isError, undefined);
  assert.equal((await call("notes", { action: "brief", no_playback: "just start" })).isError, undefined);
  assert.equal((await call("check", {})).data.errors, 0);
  const asked = await call("notes", { action: "checkpoint", id: "rough" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  const waiting = stopsSummary(await agentState.read("stopped")).waiting;
  assert.equal(waiting.agentId, "a1");
  assert.equal(waiting.agentBoot, "boot-7");
});

test("the quiet notification is off by default and takes only true or false", async () => {
  assert.deepEqual(defaultSettings().notify, { quiet: false });
  assert.equal(mergeSettings(defaultSettings(), { notify: { quiet: true } }).notify.quiet, true);
  assert.throws(() => mergeSettings(defaultSettings(), { notify: { quiet: "yes" } }), /notify\.quiet is true or false\./);
  assert.throws(() => mergeSettings(defaultSettings(), { notify: { loud: true } }), /Unknown setting "notify\.loud"/);
  const saved = await server.api("/api/dashboard/settings", { method: "PUT", body: { notify: { quiet: true } }, headers: { "x-kino-review": key } });
  assert.equal(saved.status, 200);
  assert.equal((await snapshot()).settings.notify.quiet, true);
  await server.api("/api/dashboard/settings", { method: "PUT", body: { notify: { quiet: false } }, headers: { "x-kino-review": key } });
});

// A stand-in kino server that answers every agent call with "ok" and keeps each call's session.
async function stubServer(t) {
  const sessions = [];
  const stub = createServer((req, res) => {
    if (req.url.startsWith("/api/agent/")) sessions.push(req.headers["x-kino-session"] ?? null);
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: "ok" })); });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  return { url: `http://127.0.0.1:${stub.address().port}`, sessions };
}

test("one MCP client sends the same session on every call, and two clients send different ones", async (t) => {
  const stub = await stubServer(t);
  const first = createAgentClient({ url: stub.url });
  const second = createAgentClient({ url: stub.url });
  await first.call("status");
  await first.call("look", { mode: "frame", t: 1 });
  await second.call("status");
  const [a, b, c] = stub.sessions;
  assert.match(a, /^[A-Za-z0-9_-]{3,32}$/);
  assert.equal(a, b, "one client, one session");
  assert.notEqual(a, c, "another client, another session");
});

// An MCP server started before kino was updated reloads its tools when this hash changes (tool-sync.mjs).
test("every agent answer carries kino's tool-list hash, and GET /api/agent/tools gives that list", async () => {
  const client = createAgentClient({ url: server.baseUrl, ownerToken: "kino-test-owner" }, { name: "cli" });
  await client.call("status");
  const own = await agentToolList();
  assert.equal(client.toolsHash, own.hash);
  const list = await client.tools();
  assert.equal(list.hash, own.hash);
  assert.deepEqual(list.tools.map((tool) => tool.name), own.tools.map((tool) => tool.name));
});

// Runs `node bin/kino.mjs status` against the stand-in, with a temporary HOME (never the real one).
// `launch` runs it some other way: [program, ...args] with the kino command line in KINO_COMMAND.
function runKinoStatus(stubUrl, home, extra = {}, launch = null) {
  const env = { ...process.env };
  for (const name of ["MOTION_API_URL", "KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "KINO_RUNTIME_FILE", "KINO_METER_FILE", "KINO_SETUP_HOME", "KINO_AGENT_SESSION"]) delete env[name];
  const command = [process.execPath, path.join(root, "bin", "kino.mjs"), "status"];
  Object.assign(env, { MOTION_API_URL: stubUrl, KINO_RUNTIME_FILE: "/nonexistent", HOME: home, KINO_COMMAND: JSON.stringify(command) }, extra);
  const [program, ...args] = launch ?? command;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, pid: child.pid }));
  });
}

// Milestone LIVE review round 2: every `kino` command is a new process, so a fixed "cli" made all
// command-line agents one Nova. The session names the program that runs the command (here this
// test's process, or another one), past the shells in between; KINO_AGENT_SESSION still wins.
test("the kino command line sends one session per program that runs it, past shells; KINO_AGENT_SESSION wins", async (t) => {
  const stub = await stubServer(t);
  const home = await mkdtemp(path.join(tmpdir(), "kino-live-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const quote = (word) => `'${word.replace(/'/g, "'\\''")}'`;
  const shellLine = [process.execPath, path.join(root, "bin", "kino.mjs"), "status"].map(quote).join(" ");
  const runs = [
    await runKinoStatus(stub.url, home),
    await runKinoStatus(stub.url, home, {}, ["/bin/sh", "-c", `${shellLine}; true`]),
    // Another program (a second agent) that runs the same command.
    await runKinoStatus(stub.url, home, {}, [process.execPath, "-e", "const [p, ...a] = JSON.parse(process.env.KINO_COMMAND); require('node:child_process').spawnSync(p, a, { stdio: 'inherit' });"]),
    await runKinoStatus(stub.url, home, { KINO_AGENT_SESSION: "shell-two" }),
  ];
  for (const run of runs) assert.equal(run.code, 0, run.output);
  const [plain, throughShell, other, named] = stub.sessions;
  assert.equal(plain, `agent-${process.pid}`, "the program that ran it: this test");
  assert.equal(throughShell, plain, "a shell in between is passed over: still this test");
  assert.equal(other, `agent-${runs[2].pid}`, "another program is another session");
  assert.notEqual(other, plain);
  assert.equal(named, "shell-two");
  // The MCP server this program starts sends the same session, so one
  // agent's CLI and MCP calls are one crew member and never wait for each other's holds.
  const env = { ...process.env };
  delete env.KINO_AGENT_SESSION;
  const mcpSession = execFileSync(process.execPath, ["--input-type=module", "-e", "import { agentSession } from './backend/agent/agent-session.mjs'; console.log(agentSession());"], { cwd: root, env, encoding: "utf8" }).trim();
  assert.equal(mcpSession, plain);
});

// Stems study 2026-11-12: `/usr/bin/time -p env ... kino edit` named the session after `time`, so
// each call was a new crew member and the next call waited 2 minutes for the last one's hold.
test("a per-call launcher above the kino command is walked past like a shell", () => {
  const table = [
    "  100     1 /Applications/agent", "  200   100 /bin/zsh -c kino edit", "  300   200 /usr/bin/time -p env MOTION_API_URL=x node bin/kino.mjs edit",
    "  301   200 perl -e alarm shift; exec @ARGV 90 node bin/kino.mjs", "  400   100 /bin/zsh -c other", "  500   400 /usr/local/bin/other-agent",
  ].join("\n");
  assert.deepEqual(processChain(parseProcessTable(table), 300).map((entry) => `${entry.program}${entry.passes ? "" : "*"}`), ["time", "zsh", "agent*"]);
  const env = {};
  assert.equal(agentSession({ env, table, ppid: 300, platform: "darwin" }), "agent-100");
  assert.equal(agentSession({ env, table, ppid: 301, platform: "darwin" }), "agent-100", "a perl one-liner launcher too");
  assert.equal(agentSession({ env, table, ppid: 200, platform: "darwin" }), "agent-100", "the same agent without a launcher");
  assert.equal(agentSession({ env, table, ppid: 500, platform: "darwin" }), "agent-500", "another agent keeps its own session");
});

// Review round 2: your answer to a stop on the dashboard ends the agent's turn, as your undo does,
// so its building marks go at once (they stayed until the agent's next call).
test("your answer to a stop on the dashboard clears the agent's building marks at once", async () => {
  const project = "live-stop";
  const call = async (verb, input) => agent(verb, { project, ...input });
  assert.equal((await agent("project", { action: "create", id: project, name: project, width: 1080, height: 1920, duration: 24, background: "#101820" })).isError, undefined);
  const title = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
  const edited = await call("edit", { ops: [title] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal((await call("notes", { action: "brief", no_playback: "just start" })).isError, undefined);
  assert.equal((await call("check", {})).data.errors, 0);
  const asked = await call("notes", { action: "checkpoint", id: "rough" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.deepEqual((await snapshot(project)).presence.building.map((entry) => entry.layerId), ["title"], "the title is building");
  let answered;
  const events = await eventsDuring(async () => {
    answered = await dashboard("stops", { body: { project, action: "answer", id: asked.data.id, rev: edited.data.rev, read_as: "approve" } });
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const told = events.filter((event) => event.type === "building" && event.projectId === project);
  assert.equal(told.length, 1, "one building event tells the dashboard");
  assert.deepEqual(told[0].building, []);
  assert.deepEqual((await snapshot(project)).presence.building, []);
});

// Review round 2: pointing changes what every agent's status says, so only the dashboard window
// (its review key) can set it, like the other dashboard changes.
test("pointing needs the dashboard window's review key", async () => {
  const body = { project: "live", sceneId: "s1", layerIds: [] };
  const without = await server.api("/api/dashboard/point", { method: "POST", body });
  assert.equal(without.status, 403, "a page without the key cannot point");
  const wrong = await server.api("/api/dashboard/point", { method: "POST", body, headers: { "x-kino-review": "not-the-key" } });
  assert.equal(wrong.status, 403);
  assert.equal((await dashboard("point", { body })).status, 200, "the dashboard window can");
});
