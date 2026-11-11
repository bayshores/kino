// A final render waits for the video's stops (direction plan milestone B2c): while a stop the
// video has is not answered (or allowed by the person's settings, or switched off with "stop
// asking"), kino refuses a final render on every path: the agent's render and project exports,
// the person's own render on the dashboard, and the older export-batches and export routes. Drafts still
// render. A video with no brief has no stops, so nothing waits.
//
// Every project here has no footage and a 3600 s board skip-under (no storyboard stop,
// stops.test.support.mjs): 24 s has rough, color and sound.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { finalRefusal } from "./agent/stops.mjs";
import { openStops, skipBoardOn } from "./stops.test.support.mjs";
import { startTestServer } from "./media.test.support.mjs";

let server;
let key;
before(async () => {
  server = await startTestServer();
  key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
  await skipBoardOn(server);
  // A final render past the stops then asks the person (pastStops below) instead of drawing.
  assert.equal((await setting({ limits: { finalRenderFrames: 1 } })).status, 200);
});
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
async function dashboard(route, { method = "POST", body } = {}) {
  const response = await server.api(`/api/dashboard/${route}`, { method, body, headers: { "x-kino-review": key } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const setting = (body) => dashboard("settings", { method: "PUT", body });

const TITLE = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
async function video(id, { seconds = 24, brief = true } = {}) {
  assert.equal((await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: seconds, background: "#101820" })).isError, undefined);
  const edited = await agent("edit", { project: id, ops: [TITLE] });
  assert.equal(edited.isError, undefined, edited.text);
  if (brief) assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
  const checked = await agent("check", { project: id });
  assert.equal(checked.data.errors, 0, checked.text);
  return edited.data.rev;
}
const finalRender = (project) => agent("render", { project, quality: "final", format: "png" });

// A final render over the frame limit asks the person (awaiting_approval) before anything is
// drawn: a final that gets that far went past the stops.
const pastStops = (reply) => reply.data?.status === "awaiting_approval" || (!reply.isError && reply.data?.job);

test("the agent's final render and final export wait for rough, color and sound; a draft renders", async () => {
  await video("final-waits");
  const refused = await finalRender("final-waits");
  assert.equal(refused.isError, true);
  assert.equal(refused.data.error, "stops_open");
  // Every gate still open is named at once (a still waits only for the stops and the check),
  // in the order that redoes the least work; the first gate keeps its code and next call.
  assert.equal(refused.data.reason, "A final render waits for this video's stops: rough, color, sound. A draft render works now. A final render still needs: 1) notes checkpoint rough, color, sound 2) render final.");
  const mp4 = await agent("render", { project: "final-waits", quality: "final", format: "mp4" });
  assert.equal(mp4.data.error, "stops_open");
  assert.match(mp4.data.reason, /still needs: 1\) notes checkpoint rough, color, sound 2\) look review \(6 of 6 moments\) 3\) library inspire \(save 2\), look versus 4\) render final\.$/);
  // status names the same gates on one line once the video is built and checked.
  const status = await agent("status", { project: "final-waits" });
  assert.ok(status.text.includes("\nto final: 1) notes checkpoint rough, color, sound 2) look review (6 of 6 moments) 3) library inspire (save 2), look versus 4) render final\n"), status.text);
  assert.equal(refused.data.next, 'Ask them in order: notes {action:"checkpoint", id:"rough"}.');
  assert.deepEqual(refused.data.stops, [{ kind: "rough" }, { kind: "color" }, { kind: "sound" }]);

  const exported = await agent("project", { action: "manage", id: "final-waits", options: { resource: "exports", action: "start", quality: "final", options: { profile: "png", width: 32, height: 56 } } });
  assert.equal(exported.data.error, "stops_open", exported.text);

  const draft = await agent("render", { project: "final-waits", quality: "draft", format: "png" });
  assert.equal(draft.isError, undefined, draft.text);
  assert.ok(draft.data.job, "the draft started");
});

test("past a rough pass with no locked direction, status names the lock first on its to final line", async () => {
  const id = "final-lock";
  assert.equal((await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 24, background: "#101820" })).isError, undefined);
  const dots = Array.from({ length: 31 }, (unused, index) => ({ op: "add_layer", layerType: "rectangle", name: `dot${index}`, properties: { x: 100 + (index % 6) * 140, y: 200 + Math.floor(index / 6) * 140, width: 80, height: 80, fill: "#ffffff" } }));
  assert.equal((await agent("edit", { project: id, ops: dots })).isError, undefined);
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
  await agent("check", { project: id });
  const status = await agent("status", { project: id });
  assert.match(status.text, /\nto final: 1\) notes brief \(lock the direction\) 2\) /, status.text);
});

test("the person's own final render on the dashboard waits too, with words for the person", async () => {
  await video("final-yours");
  const reply = await dashboard("act/render", { body: { project: "final-yours", quality: "final", format: "png" } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.error, "stops_open");
  assert.equal(reply.body.data.next, "Answer them when your agent asks, or set them to allow in settings › stops.");
});

test("the older export-batches route refuses a final while stops are open and lets a draft through", async () => {
  await video("final-batches");
  const document = (await (await server.api("/api/projects/final-batches")).json()).document;
  const sceneIds = [document.scenes[0].id];
  const final = await server.api("/api/export-batches", { method: "POST", body: { document, sceneIds, options: { profile: "png", width: 32, height: 56 } } });
  assert.equal(final.status, 409);
  const body = await final.json();
  assert.equal(body.code, "stops_open");
  assert.match(body.error, /^A final render waits for this video's stops: rough, color, sound\./);
  const draft = await server.api("/api/export-batches", { method: "POST", body: { document, sceneIds, options: { profile: "png", width: 32, height: 56, renderQuality: "draft" } } });
  assert.equal(draft.status, 202, await draft.text());

  // The single-file route the older export_animation tool uses: the same rule.
  const single = (options) => server.api("/api/export", { method: "POST", body: { document, sceneId: sceneIds[0], options: { format: "png", width: 32, height: 56, ...options } } });
  const refused = await single({});
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /^A final render waits for this video's stops: rough, color, sound\./);
  const drafted = await single({ renderQuality: "draft" });
  assert.equal(drafted.status, 200, await drafted.text());
});

test("a waiting stop is named: the agent's render waits like every write, the person's final says which stop", async () => {
  await video("final-waiting");
  const asked = await agent("notes", { project: "final-waiting", action: "checkpoint", id: "rough" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.equal((await finalRender("final-waiting")).data.waiting, asked.data.id, "the agent's calls wait for the answer (B2a)");
  const yours = await dashboard("act/render", { body: { project: "final-waiting", quality: "final", format: "png" } });
  assert.equal(yours.body.data.reason, `A final render waits for this video's stops: rough (${asked.data.id} waiting), color, sound. A draft render works now.`);
  // Without the person's words (the older route), the agent is told to end its turn.
  const open = [{ kind: "rough", round: { id: "C1", status: "waiting" } }, { kind: "color" }];
  assert.equal(finalRefusal(open).next, "C1 waits for the person's answer: end your turn.");
});

test("the person's settings and \"stop asking\" release the stops; a video with no brief has none", async () => {
  // Allowed in settings: rough, color and sound pass without asking, so the final goes on.
  await video("final-allowed");
  assert.equal((await setting({ approvals: { "checkpoint-rough": "allow", "checkpoint-color": "allow", "checkpoint-sound": "allow" } })).status, 200);
  try {
    const reply = await finalRender("final-allowed");
    assert.ok(pastStops(reply), reply.text);
  } finally {
    assert.equal((await setting({ approvals: { "checkpoint-rough": "ask", "checkpoint-color": "ask", "checkpoint-sound": "ask" } })).status, 200);
  }

  // "stop asking" on the rough cut: color and sound are switched off for this video.
  await video("final-stop-asking");
  const asked = await agent("notes", { project: "final-stop-asking", action: "checkpoint", id: "rough" });
  const askedAt = performance.now();
  await sleep(Math.max(0, 5200 - (performance.now() - askedAt)));
  const answered = await agent("notes", { project: "final-stop-asking", action: "answer", id: asked.data.id, rev: asked.data.rev, words: "looks good, stop asking", read_as: "stop asking" });
  assert.equal(answered.isError, undefined, answered.text);
  assert.ok(pastStops(await finalRender("final-stop-asking")));

  await video("final-no-brief", { brief: false });
  assert.ok(pastStops(await finalRender("final-no-brief")), "no brief: no stops to wait for");

  // Under 15 s the video has no rough, color or sound stop.
  await video("final-short", { seconds: 6 });
  assert.ok(pastStops(await finalRender("final-short")));
});

// The rules on plain states (stops.mjs).
test("openStops: a redo, a reopened answer and a lapsed storyboard approval stay open; the board's words", () => {
  const VIDEO = { seconds: 24, layers: 1, footage: true };
  const brief = { rev: 0, fields: {}, log: [], noPlayback: { reason: "just start", rev: 0 } };
  const round = (id, kind, status, read_as) => ({ id, kind, rev: 3, status, ...(read_as ? { answer: { read_as } } : {}) });
  const state = { brief, stops: [round("C1", "board", "answered", "approve"), round("C2", "rough", "answered", "redo")], boards: [{ stop: "C1", lapsed: true }] };
  const open = openStops(state, VIDEO);
  assert.deepEqual(open.map((entry) => entry.kind), ["board", "rough", "color", "sound"]);
  assert.equal(finalRefusal(open).message, "A final render waits for this video's stops: board (C1 changed since approved), rough (C2 redo), color, sound. A draft render works now.");
  assert.equal(finalRefusal(open).next, 'Ask them in order: notes {action:"checkpoint", id:"board"}.');
  const reopened = { brief, stops: [round("C1", "rough", "reopened")] };
  assert.equal(finalRefusal(openStops(reopened, { ...VIDEO, footage: false })).message.split(": ")[1], "rough (C1 reopened), color, sound. A draft render works now.");
  assert.deepEqual(openStops({ brief: null }, VIDEO), []);
  // A round "stop asking" let through, after the person said "keep asking" again.
  const again = { brief, stops: [{ ...round("C1", "rough", "allowed"), allowedBy: "chat" }] };
  assert.equal(finalRefusal(openStops(again, { ...VIDEO, footage: false })).message.split(": ")[1], "rough (C1 asking again), color, sound. A draft render works now.");
});
