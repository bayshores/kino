// Milestone A5, the dashboard's server side, on a real server with a temporary data folder:
// review keys, the snapshot, the event stream and its replay, stage frames from the export
// renderer, notes (queued → delivered → addressed), approvals (D3) that never block the agent,
// hold, turn undo reported to the agent, settings, the frame cache and pointing.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createAgentClient } from "./agent/client.mjs";
import { startTestServer } from "./media.test.support.mjs";
import { createSegmentCache } from "./render-segment-cache.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server;
let key;
before(async () => {
  server = await startTestServer();
  // What a dashboard page's fetch() sends: the browser sets these headers itself.
  const response = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  assert.equal(response.status, 200);
  key = (await response.json()).key;
});
after(() => server?.stop());

// One call by the agent (the MCP tools and the kino command use this same route).
async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "test-agent", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

// One request from the dashboard window, which holds the review key.
async function dashboard(route, { method = "POST", body, review = true } = {}) {
  const response = await server.api(`/api/dashboard/${route}`, { method, body, headers: review ? { "x-kino-review": key } : {} });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const inboxText = (reply) => (reply.data?.inbox ?? []).map((entry) => (typeof entry === "string" ? entry : entry.text)).join("\n") || reply.text;

// Reads the event stream until `count` events match `wanted`, or the time runs out.
async function streamEvents(query, wanted, { count = 1, timeout = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const found = [];
  const all = [];
  try {
    const response = await server.api(`/api/dashboard/stream${query}`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data:"));
        if (!data) continue;
        const event = JSON.parse(data.slice(5));
        all.push(event);
        if (wanted(event)) found.push(event);
        if (found.length >= count) return { found, all };
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { found, all };
}

test("a review key is given to a same-origin browser page only, and changes need it", async () => {
  const refused = await server.api("/api/dashboard/review-key", { method: "POST" });
  assert.equal(refused.status, 403);
  const crossSite = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "cross-site", origin: "https://example.com" } });
  assert.equal(crossSite.status, 403);
  const noKey = await dashboard("hold", { body: { on: true }, review: false });
  assert.equal(noKey.status, 403);
  const wrongKey = await server.api("/api/dashboard/hold", { method: "POST", body: { on: true }, headers: { "x-kino-review": "not-a-key" } });
  assert.equal(wrongKey.status, 403);
  // Owner only: without the owner token the whole dashboard API is closed.
  const stranger = await server.api("/api/dashboard/snapshot", { owner: false });
  assert.equal(stranger.status, 403);
});

test("the snapshot shows the agent's project, its turns and the call log", async () => {
  const created = await agent("project", { action: "create", id: "dash", name: "Dash", width: 640, height: 360, duration: 1 });
  assert.equal(created.isError, undefined);
  const edit = await agent("edit", { ops: [{ op: "add_layer", type: "rectangle", name: "card", properties: { x: 220, y: 130, width: 200, height: 100, fill: "#3CC8B4" } }] });
  assert.equal(edit.data.rev, 2);
  const { status, body } = await dashboard("snapshot?project=dash", { method: "GET", review: false });
  assert.equal(status, 200);
  assert.equal(body.projectId, "dash");
  assert.equal(body.current, "dash");
  assert.equal(body.record.revision, 2);
  assert.equal(body.agent.turns.at(-1).edits.length, 1);
  const editCall = body.events.find((event) => event.verb === "edit");
  assert.equal(editCall.client, "test-agent");
  assert.equal(editCall.rev, 2);
  assert.equal(editCall.turn, "T1");
  assert.ok(editCall.tokens > 0 && editCall.inTokens > 0);
  assert.match(editCall.input, /add_layer/);
  assert.equal(body.settings.limits.finalRenderFrames, 600);
  assert.equal(body.hold.on, false);
  assert.ok(body.agents.some((entry) => entry.kind === "test-agent" && entry.lastVerb === "edit"));
});

test("the event stream says hello, replays what a reconnecting window missed, and asks for a resync after a restart", async () => {
  const first = await streamEvents("", (event) => event.type === "hello");
  const { boot, seq } = first.found[0];
  assert.ok(boot && Number.isSafeInteger(seq));
  await agent("look", { mode: "frame", t: 0.5 });
  await agent("status");
  const replayed = await streamEvents(`?since=${seq}&boot=${boot}`, (event) => event.type === "replayed");
  const calls = replayed.all.filter((event) => event.type === "call");
  assert.deepEqual(calls.map((event) => event.event.verb), ["look", "status"]);
  assert.equal(replayed.found[0].count, replayed.all.length - 1);
  // The look call carries the image it returned and the agent slice for the session pane.
  assert.match(calls[0].event.images[0], /frame-[a-f0-9]{12}\.png$/);
  assert.ok(calls[0].agent.turns.length >= 1);
  const restarted = await streamEvents(`?since=${seq}&boot=another-boot`, (event) => event.type === "resync");
  assert.equal(restarted.found.length, 1);
  const tooOld = await streamEvents(`?since=999999&boot=${boot}`, (event) => event.type === "resync");
  assert.equal(tooOld.found.length, 1);
});

test("the images the agent saw are served for pane [3]", async () => {
  const look = await agent("look", { mode: "frame", t: 0.2, inline: false });
  const file = path.basename(look.images[0].path);
  const response = await server.api(`/api/dashboard/seen/dash/${file}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()).subarray(0, 8), PNG_SIGNATURE);
  const traversal = await server.api("/api/dashboard/seen/dash/..%2F..%2Fdashboard.json");
  assert.equal(traversal.status, 400);
  // A picture that is gone (or never was) is missing, not a server failure.
  assert.equal((await server.api("/api/dashboard/seen/dash/frame-000000000000.png")).status, 404);
});

test("stage frames come from the export renderer and are cached by content", async () => {
  const snapshot = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body;
  const scene = snapshot.record.document.scenes[0].id;
  const url = `/api/dashboard/frame?project=dash&scene=${scene}&t=0.5&w=320`;
  const fresh = await server.api(url);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("content-type"), "image/png");
  const png = Buffer.from(await fresh.arrayBuffer());
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(png.readUInt32BE(16), 320);
  assert.equal(png.readUInt32BE(20), 180);
  const again = await server.api(url);
  assert.equal(again.headers.get("x-frame-cached"), "1");
  assert.equal(again.headers.get("etag"), fresh.headers.get("etag"));
  const unchanged = await server.api(url, { headers: { "if-none-match": fresh.headers.get("etag") } });
  assert.equal(unchanged.status, 304);
  // A saved revision is immutable, so the browser keeps it.
  const old = await server.api(`${url}&rev=1`);
  assert.equal(old.status, 200);
  assert.match(old.headers.get("cache-control"), /immutable/);
  assert.notEqual(old.headers.get("etag"), fresh.headers.get("etag"), "rev 1 has no card, so it is a different frame");
  const usage = (await dashboard("cache", { method: "GET", review: false })).body.cache;
  assert.ok(usage.frames >= 2 && usage.bytes > 0);
  const cleared = await dashboard("cache/clear");
  assert.equal(cleared.body.cache.frames, 0);
  const bad = await server.api(`/api/dashboard/frame?project=dash&scene=${scene}&t=-1`);
  assert.equal(bad.status, 400);
  // A thumbnail (low=1) is the same frame, drawn only while no stage frame is being drawn: one
  // asked for while the stage's frame draws comes back after it.
  const thumb = await server.api(`${url}&low=1`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("etag"), fresh.headers.get("etag"));
  const done = [];
  const stageFrame = server.api(`/api/dashboard/frame?project=dash&scene=${scene}&t=1.25&w=1920`).then((response) => { done.push("stage"); return response; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const lowFrame = server.api(`/api/dashboard/frame?project=dash&scene=${scene}&t=1.5&w=320&low=1`).then((response) => { done.push("thumbnail"); return response; });
  assert.deepEqual((await Promise.all([stageFrame, lowFrame])).map((response) => response.status), [200, 200]);
  assert.deepEqual(done, ["stage", "thumbnail"]);
});

test("a note goes queued → delivered → addressed, and the agent gets it in its inbox", async () => {
  const listening = streamEvents("", (event) => event.type === "note", { count: 3 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const added = await dashboard("act/notes", { body: { project: "dash", action: "add", text: "Make the card bigger", t: 0.4, layer: "card", urgent: true, area: { x: 200, y: 120, width: 240, height: 120 } } });
  assert.equal(added.status, 200);
  const note = added.body.data.note;
  assert.equal(note.status, "new");
  assert.equal(note.urgent, true);
  assert.deepEqual(note.area, { x: 200, y: 120, width: 240, height: 120 });
  // The agent's next call delivers it.
  const status = await agent("status");
  assert.match(inboxText(status), new RegExp(`${note.id} note URGENT @0.4 card area 200,120 240×120 "Make the card bigger"`));
  const resolved = await agent("notes", { action: "resolve", id: note.id, text: "Card is now 280 wide" });
  assert.equal(resolved.isError, undefined);
  const { found } = await listening;
  assert.deepEqual(found.map((event) => event.note.status), ["new", "seen", "resolved"]);
  assert.equal(found[2].note.replies.at(-1).text, "Card is now 280 wide");
});

test("approvals (D3) never block: the agent gets awaiting_approval at once, and the answer reaches its inbox", async () => {
  // A share link: the agent asks, you allow from the dashboard, the agent reads the link.
  const asked = await agent("project", { action: "share", id: "dash", role: "view" });
  assert.equal(asked.data.status, "awaiting_approval");
  const id = asked.data.id;
  assert.match(id, /^Q\d+$/);
  assert.equal((await agent("project", { action: "share", id: "dash", role: "view" })).data.id, id, "the same request is one approval");
  const waiting = await agent("render", { action: "wait", job: id });
  assert.equal(waiting.data.status, "awaiting_approval");
  assert.match((await agent("status")).text, new RegExp(`awaiting the person's approval: ${id} a view link to dash`));
  const listed = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.approvals;
  assert.equal(listed.find((entry) => entry.id === id).status, "pending");
  assert.equal(listed.find((entry) => entry.id === id).input, undefined, "the stored call stays on the server");

  const noKey = await dashboard(`approvals/${id}`, { body: { decision: "allow" }, review: false });
  assert.equal(noKey.status, 403);
  const allowed = await dashboard(`approvals/${id}`, { body: { decision: "allow", note: "ok for the client" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.approval.status, "allowed");
  assert.equal(allowed.body.approval.result.text, "Created sharing link (secret omitted)");
  const twice = await dashboard(`approvals/${id}`, { body: { decision: "allow" } });
  assert.equal(twice.status, 409);
  const next = await agent("status");
  assert.match(inboxText(next), new RegExp(`${id} allowed · your note: "ok for the client": Created sharing link \\(secret omitted\\); render \\{action:"wait", job:"${id}"\\} gives you its URL, once`));

  // Denied: the agent is told not to send it again.
  const archive = await agent("project", { action: "archive", id: "dash" });
  assert.equal(archive.data.status, "awaiting_approval");
  await dashboard(`approvals/${archive.data.id}`, { body: { decision: "deny" } });
  assert.match(inboxText(await agent("status")), new RegExp(`${archive.data.id} denied by the person: archiving dash`));
  assert.ok((await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.projects.some((project) => project.id === "dash"), "nothing was archived");

  // A final render over the frame limit; "always deny" becomes a rule.
  assert.equal((await dashboard("settings", { method: "PUT", body: { limits: { finalRenderFrames: 10 } } })).status, 200);
  await agent("check", { fix: "auto" });
  const final = await agent("render", { action: "start", quality: "final" });
  assert.equal(final.data.status, "awaiting_approval", final.text);
  assert.match(final.data.summary, /30 frames, over 10/);
  await dashboard(`approvals/${final.data.id}`, { body: { decision: "deny", always: true } });
  assert.equal((await dashboard("settings", { method: "GET", review: false })).body.settings.approvals["final-render"], "deny");
  const ruled = await agent("render", { action: "start", quality: "final" });
  assert.equal(ruled.isError, true);
  assert.equal(ruled.data.error, "denied");
  await dashboard("settings", { method: "PUT", body: { approvals: { "final-render": "ask" }, limits: { finalRenderFrames: 600 } } });
});

test("an allowed share link's URL reaches only the agent's own wait answer: not the saved files, the snapshot, the stream, a viewer or the inbox", async () => {
  // Someone watching through a view link gets the agent's activity log live.
  const viewLink = await (await server.api("/api/projects/dash/shares", { method: "POST", body: { role: "view", label: "watcher" } })).json();
  const viewer = new WebSocket(`${server.baseUrl.replace("http", "ws")}/collaboration?share=${encodeURIComponent(viewLink.token)}`, { origin: server.baseUrl });
  const heard = [];
  viewer.on("message", (data) => heard.push(data.toString()));
  await once(viewer, "open");
  viewer.send(JSON.stringify({ type: "join", projectId: "dash", clientId: "watcher", name: "Watcher" }));
  const { boot, seq } = (await streamEvents("", (event) => event.type === "hello")).found[0];
  try {
    // project share, and manage shares create (whose own answer also has the bare token).
    const secrets = [];
    for (const ask of [{ action: "share", id: "dash", role: "comment" }, { action: "manage", id: "dash", options: { resource: "shares", action: "create", role: "comment" } }]) {
      const asked = await agent("project", ask);
      assert.equal(asked.data.status, "awaiting_approval", asked.text);
      const allowed = await dashboard(`approvals/${asked.data.id}`, { body: { decision: "allow" } });
      assert.equal(allowed.body.approval.result.text, "Created sharing link (secret omitted)");
      // The call the skill tells the agent to make after an approval.
      const waited = await agent("render", { action: "wait", job: asked.data.id });
      assert.match(waited.data.url, /^http:\/\/127\.0\.0\.1:\d+\/\?project=dash#share=/, waited.text);
      assert.ok(waited.text.includes(waited.data.url), "the agent's own answer carries the URL");
      assert.match(waited.text, new RegExp(`${asked.data.id} allowed: Created sharing link \\(secret omitted\\); render`), "its inbox line does not");
      const again = await agent("render", { action: "wait", job: asked.data.id });
      assert.equal(again.data.url, undefined, "the URL is given once");
      assert.match(again.data.next, /given once/);
      assert.ok(again.data.next.includes('project {action:"manage", id:"dash", options:{resource:"shares", action:"list"}}'), "the hint names the link's project");
      secrets.push(new URLSearchParams(new URL(waited.data.url).hash.slice(1)).get("share").split(".")[1]);
    }
    assert.match((await agent("project", { action: "manage", id: "dash", options: { resource: "shares", action: "list" } })).text, /"role":"comment"/);

    // The viewer hears every call, the wait calls included.
    const deadline = Date.now() + 5000;
    const renderCalls = () => heard.filter((message) => message.includes('"type":"agent-event"') && message.includes('"verb":"render"')).length;
    while (renderCalls() < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(renderCalls(), 4, "the viewer heard the four wait calls");
    const snapshot = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body;
    // The log says "created" for the approved calls only, not for the asks that wait.
    const shareCalls = snapshot.events.filter((event) => event.verb === "project" && (event.approval || event.approved));
    assert.ok(shareCalls.length >= 4);
    for (const event of shareCalls) assert.equal(event.summary === "Created sharing link (secret omitted from activity log).", Boolean(event.approved), event.summary);
    const places = {
      "the dashboard stream": JSON.stringify((await streamEvents(`?since=${seq}&boot=${boot}`, (event) => event.type === "replayed")).all),
      "the snapshot": JSON.stringify(snapshot),
      "the view-link viewer": heard.join("\n"),
    };
    // Every saved file: dashboard.json, the event log, the agent's state and inbox, the share grants.
    for (const entry of await readdir(server.dataDirectory, { withFileTypes: true, recursive: true }))
      if (entry.isFile()) places[path.relative(server.dataDirectory, path.join(entry.parentPath, entry.name))] = await readFile(path.join(entry.parentPath, entry.name), "latin1");
    assert.ok(Object.keys(places).some((place) => place.endsWith("dashboard.json")) && Object.keys(places).some((place) => place.endsWith(".events.jsonl")));
    for (const [place, text] of Object.entries(places)) {
      for (const secret of secrets) assert.equal(text.includes(secret), false, `${place} holds a share secret`);
      assert.doesNotMatch(text, /#share=(?!\(secret omitted\))/, `${place} shows a share URL`);
    }
    assert.match(places["the view-link viewer"], /#share=\(secret omitted\)/, "the viewer saw the wait calls, without the secret");
  } finally {
    viewer.terminate();
  }
});

test("a share link's wait answer that is too long to send keeps its URL, and the saved file leaves the secret out", async () => {
  const asked = await agent("project", { action: "share", id: "dash", role: "edit" });
  assert.equal(asked.data.status, "awaiting_approval", asked.text);
  // Long notes from you come with the wait answer and push it past 8,000 tokens.
  const notes = [];
  for (let index = 0; index < 15; index += 1)
    notes.push((await dashboard("act/notes", { body: { project: "dash", action: "add", text: `note ${index} ${"x".repeat(1990)}` } })).body.data.note.id);
  assert.equal((await dashboard(`approvals/${asked.data.id}`, { body: { decision: "allow", note: "n".repeat(500) } })).status, 200);
  const waited = await agent("render", { action: "wait", job: asked.data.id });
  assert.ok(waited.data.file, "the answer was cut and saved to a file");
  assert.match(waited.data.url, /^http:\/\/127\.0\.0\.1:\d+\/\?project=dash#share=[a-f0-9-]{36}\.[\w-]{43}$/, waited.text);
  assert.ok(waited.text.includes(`url: ${waited.data.url}`), "the agent can read the URL in the answer");
  const secret = waited.data.url.split(".").at(-1);
  const saved = await readFile(waited.data.file, "utf8");
  assert.match(saved, /note 14 x{1990}/, "the file holds the whole answer");
  assert.match(saved, /#share=\(secret omitted\)/);
  for (const entry of await readdir(server.dataDirectory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) assert.equal((await readFile(path.join(entry.parentPath, entry.name), "latin1")).includes(secret), false, `${entry.name} holds the share secret`);
  const again = await agent("render", { action: "wait", job: asked.data.id });
  assert.equal(again.data.url, undefined, "the URL is still given once");
  for (const id of notes) await agent("notes", { action: "resolve", id });
});

test("deleting a scene waits for approval, then the approved edit runs in the agent's turn", async () => {
  const added = await agent("edit", { ops: [{ op: "add_scene", name: "outro", duration: 1 }] });
  assert.equal(added.isError, undefined, added.text);
  const before = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.record;
  assert.equal(before.document.scenes.length, 2);
  const asked = await agent("edit", { ops: [{ op: "delete_scene", scene: "outro" }] });
  assert.equal(asked.data.status, "awaiting_approval");
  // A dry run changes nothing, so it needs no approval.
  assert.notEqual((await agent("edit", { dry_run: true, ops: [{ op: "delete_scene", scene: "outro" }] })).data?.status, "awaiting_approval");
  const allowed = await dashboard(`approvals/${asked.data.id}`, { body: { decision: "allow" } });
  assert.equal(allowed.body.approval.result.isError, false, allowed.body.approval.result.text);
  const after = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body;
  assert.equal(after.record.document.scenes.length, 1);
  assert.equal(after.record.revision, before.revision + 1);
  assert.match(inboxText(await agent("status")), new RegExp(`${asked.data.id} allowed: `));
});

test("a large import asks first; once allowed, the same import goes through once", async () => {
  await dashboard("settings", { method: "PUT", body: { limits: { importMegabytes: 1 } } });
  const check = { action: "import", name: "big.mov", size: 5 * 1024 * 1024 };
  const asked = await agent("project", check);
  assert.equal(asked.data.status, "awaiting_approval");
  assert.match(asked.data.summary, /importing big\.mov \(5 MB, over 1 MB\)/);
  await dashboard(`approvals/${asked.data.id}`, { body: { decision: "allow" } });
  assert.match(inboxText(await agent("status")), /allowed: send the same import again/);
  assert.equal((await agent("project", check)).data.ok, true);
  assert.equal((await agent("project", check)).data.status, "awaiting_approval", "an approval is used once");
  assert.equal((await agent("project", { ...check, size: 1000 })).data.ok, true, "small files need no approval");
  await dashboard("settings", { method: "PUT", body: { limits: { importMegabytes: 200 } } });
});

test("hold pauses agent writes, keeps reads working, and tells the agent when it is released", async () => {
  const rev = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.record.revision;
  const held = await dashboard("hold", { body: { on: true, note: "wait while I look" } });
  assert.equal(held.body.hold.on, true);
  const edit = await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { width: 260 } }] });
  assert.equal(edit.data.held, true);
  assert.equal(edit.data.note, "wait while I look");
  const status = await agent("status");
  assert.match(status.text, /HOLD: the person paused agent writes/);
  assert.equal(status.data.rev, rev, "nothing was saved");
  // The command line's import asks first, so a held agent uploads nothing.
  const folder = await mkdtemp(path.join(tmpdir(), "kino-dash-import-"));
  const file = path.join(folder, "dot.png");
  await writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  const imported = await client.importFile(file);
  assert.equal(imported.refused.data.held, true);
  await rm(folder, { recursive: true, force: true });
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "dot.png", "x-kino-agent": "1" }, body: Buffer.from([0]) });
  assert.equal(upload.status, 423);
  // The dashboard itself still works.
  const yours = await dashboard("act/edit", { body: { project: "dash", ops: [{ op: "update_layer", layer: "card", properties: { width: 240 } }] } });
  assert.equal(yours.body.data.rev, rev + 1);
  await dashboard("hold", { body: { on: false } });
  const released = await agent("status");
  assert.match(inboxText(released), /hold released: agent writes work again/);
  assert.match(inboxText(released), /you edited 1 op/);
});

test("undo reverts a turn and every later one, newest first, and each revert reaches the agent", async () => {
  await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { x: 100 } }] });
  const firstTurn = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.agent.turns.at(-1).id;
  // A note from you starts a new turn.
  await dashboard("act/notes", { body: { project: "dash", action: "add", text: "now move it down" } });
  await agent("status");
  await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { y: 200 } }] });
  const turns = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.agent.turns;
  const secondTurn = turns.at(-1).id;
  assert.notEqual(firstTurn, secondTurn);
  const review = await dashboard(`turn?project=dash&turn=${secondTurn}`, { method: "GET", review: false });
  assert.deepEqual(review.body.changes.changed, ["card"]);
  assert.ok(review.body.calls.some((call) => call.verb === "edit"));
  const undone = await dashboard("undo", { body: { project: "dash", turn: firstTurn } });
  assert.equal(undone.status, 200);
  assert.deepEqual(undone.body.reverted.map((entry) => entry.turn), [secondTurn, firstTurn]);
  const record = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.record;
  const card = record.document.scenes[0].layers.find((layer) => layer.name === "card");
  assert.equal(card.x, 220);
  assert.equal(card.y, 130);
  const told = inboxText(await agent("status"));
  assert.match(told, new RegExp(`you reverted ${secondTurn}`));
  assert.match(told, new RegExp(`you reverted ${firstTurn}`));
  const nothing = await dashboard("undo", { body: { project: "dash", turn: firstTurn } });
  assert.equal(nothing.status, 400);
});

test("settings are checked, saved, and fill in the agent's render defaults", async () => {
  const bad = await dashboard("settings", { method: "PUT", body: { exports: { fps: 29 } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /23\.976, 24, 25, 29\.97, 30, 50, 60/);
  // 29.97 in any spelling is saved as frames a second (30000/1001).
  const ntsc = await dashboard("settings", { method: "PUT", body: { exports: { fps: "30000/1001" } } });
  assert.equal(ntsc.body.settings?.exports.fps, 30000 / 1001);
  const relative = await dashboard("settings", { method: "PUT", body: { exports: { folder: "relative/path" } } });
  assert.equal(relative.status, 400);
  const changed = await dashboard("settings", { method: "PUT", body: { exports: { format: "webm", fps: 25 }, compute: { draftWidth: 480, frameCacheMegabytes: 128 }, channels: true } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.settings.exports, { format: "webm", fps: 25, folder: "", videoEncoder: "auto", videoQuality: "standard" });
  assert.equal(changed.body.settings.channels, true);
  assert.equal((await dashboard("cache", { method: "GET", review: false })).body.cache.limitBytes, 128 * 1024 * 1024);
  await dashboard("settings", { method: "PUT", body: { exports: { format: "mp4", fps: 30 }, compute: { draftWidth: 640, frameCacheMegabytes: 1024 }, channels: false } });
});

test("the cache report includes the render cache, its size changes live, and only the dashboard window can clear it", async () => {
  // A finished render in the server's render cache: the folder export batches use.
  const segments = createSegmentCache({ directory: path.join(server.dataDirectory, "render-segments") });
  const file = path.join(server.dataDirectory, "segment.bin");
  await writeFile(file, Buffer.alloc(4096, 3));
  assert.equal(await segments.store("9".repeat(64), file, { extension: "mp4" }), true);
  await segments.close();
  await rm(file);
  const report = (await dashboard("cache", { method: "GET", review: false })).body;
  assert.ok(Number.isSafeInteger(report.cache.frames), "the stage frame cache is still reported");
  assert.equal(report.renderCache.entries, 1);
  assert.ok(report.renderCache.bytes > 4096);
  assert.equal(report.renderCache.limitBytes, 512 * 1024 * 1024, "the default render cache size");
  const smaller = await dashboard("settings", { method: "PUT", body: { compute: { renderCacheMegabytes: 64 } } });
  assert.equal(smaller.status, 200);
  assert.equal(smaller.body.settings.compute.renderCacheMegabytes, 64);
  assert.equal((await dashboard("cache", { method: "GET", review: false })).body.renderCache.limitBytes, 64 * 1024 * 1024);
  const tooSmall = await dashboard("settings", { method: "PUT", body: { compute: { renderCacheMegabytes: 32 } } });
  assert.equal(tooSmall.status, 400);
  assert.equal(tooSmall.body.error, "The render cache size (in megabytes) must be a whole number from 64 to 65536.");
  const unknown = await dashboard("settings", { method: "PUT", body: { compute: { renderThreads: 4 } } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /^Unknown setting "compute\.renderThreads"\./);
  // Clearing needs the window's review key.
  const refused = await dashboard("render-cache/clear", { review: false });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /review key/);
  assert.equal((await dashboard("cache", { method: "GET", review: false })).body.renderCache.entries, 1);
  const cleared = await dashboard("render-cache/clear");
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { renderCache: { entries: 0, bytes: 0, limitBytes: 64 * 1024 * 1024 }, removed: 1, inUse: 0 });
  await dashboard("settings", { method: "PUT", body: { compute: { renderCacheMegabytes: 512 } } });
});

test("pointing at a layer in the dashboard shows up in the agent's status", async () => {
  const record = (await dashboard("snapshot?project=dash", { method: "GET", review: false })).body.record;
  const scene = record.document.scenes[0];
  const card = scene.layers.find((layer) => layer.name === "card");
  // What you point at is what the agent reads as yours: only the dashboard window (its review
  // key) sets it (milestone LIVE review round 2).
  const refused = await dashboard("point", { body: { project: "dash", sceneId: scene.id, layerIds: [card.id] }, review: false });
  assert.equal(refused.status, 403);
  assert.doesNotMatch((await agent("status")).text, /you selected it/);
  const pointed = await dashboard("point", { body: { project: "dash", sceneId: scene.id, layerIds: [card.id] } });
  assert.equal(pointed.status, 200);
  assert.match((await agent("status")).text, /card \(you selected it in the dashboard\)/);
  await dashboard("point", { body: { project: "dash", layerIds: [] } });
});

test("a note sent through a Claude Code channel is marked, and the stream carries it", async () => {
  const added = await dashboard("act/notes", { body: { project: "dash", action: "add", text: "channel note" } });
  const marked = await dashboard("channel-sent", { body: { project: "dash", note: added.body.data.note.id }, review: false });
  assert.ok(marked.body.note.channelAt);
});

test("the library lists every kind with its count, and a sample is built through the edit path (or says why not)", async () => {
  const catalog = (await dashboard("library", { method: "GET" })).body;
  assert.deepEqual(catalog.kinds.map((kind) => kind.label), ["moves", "effects", "animations", "layer styles", "recipes", "looks", "video formats"]);
  assert.equal(catalog.total, catalog.kinds.reduce((sum, kind) => sum + kind.count, 0));
  assert.ok(catalog.entries.find((entry) => entry.id === "move:zoom-through").groups.includes("transition"));
  const sample = async (kind, name) => (await dashboard(`library-sample?kind=${kind}&name=${name}`, { method: "GET" })).body;
  const zoom = await sample("move", "zoom-through");
  assert.deepEqual(zoom.document.scenes[0].moves.map((move) => move.name), ["zoom-through"]);
  assert.ok((await sample("effect", "glow")).document.scenes[0].layers.some((layer) => layer.animations.some((animation) => animation.effect === "glow")));
  // A move that needs pictures or footage plays on kino's own sample pictures and clip, which
  // the app loads like any upload; a transition recipe and a plain edit have samples too.
  const swipe = await sample("move", "swipe-cards");
  const pictures = JSON.stringify(swipe.document).match(/\/api\/media\/[a-f0-9-]+\.png/g);
  assert.ok(pictures?.length, "swipe-cards plays on the sample's pictures");
  assert.equal((await server.api(pictures[0])).status, 200, "the app can load a sample picture");
  assert.ok((await sample("move", "freeze-shutter")).document.scenes[0].layers.some((layer) => layer.type === "video"));
  { const pushed = await sample("recipe", "push"); assert.ok(pushed.document, JSON.stringify(pushed).slice(0, 400)); }
  // The preview loops where the entry acts, not the whole sample: a move's own span, padded.
  const [from, to] = zoom.loop;
  assert.ok(from > 0 && to < zoom.document.scenes[0].duration && to - from >= 1.5, JSON.stringify(zoom.loop));
  // A cut's card is a strip of moments.
  assert.deepEqual((await sample("technique", "beat-cut")).strip?.length, 4);
  const cuts = await server.api("/api/dashboard/library-still?kind=technique&name=beat-cut");
  assert.equal(cuts.status, 200, "the beat cut strip is drawn");
  assert.ok((await sample("technique", "dissolve")).document);
  assert.equal((await sample("format", "app-demo")).document, null);
  const still = await server.api("/api/dashboard/library-still?kind=effect&name=glow");
  assert.deepEqual(Buffer.from(await still.arrayBuffer()).subarray(0, 8), PNG_SIGNATURE, "a card's still is drawn by the renderer");
  assert.equal((await server.api("/api/dashboard/library-still?kind=format&name=app-demo")).status, 404);
  assert.ok(!(await agent("project", { action: "list" })).text.includes("library-sample"), "a sample is never a project");
});
