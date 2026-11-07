// why and next on every agent call (backend/agent/said.mjs): no handler sees them, the call's
// event keeps them with up to three lines of its answer (details), and the dashboard's lanes
// route answers a scene's shots. Unit tests for the two helpers, then a real server.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { callDetails, SAID_LIMIT, takeSaid } from "./agent/said.mjs";
import { AGENT_TOOLS } from "./agent/tools.mjs";
import { startTestServer } from "./media.test.support.mjs";

test("takeSaid splits why and next out of the input, as one trimmed line each", () => {
  const { input, said } = takeSaid({ ops: [], why: "  the title\n crowded the caption ", next: "run the checks", project: "p" });
  assert.deepEqual(input, { ops: [], project: "p" });
  assert.deepEqual(said, { why: "the title crowded the caption", next: "run the checks" });
  assert.equal(takeSaid({ why: "x".repeat(500) }).said.why.length, SAID_LIMIT);
  assert.deepEqual(takeSaid({ why: 3, next: "" }), { input: {}, said: {} }, "anything that is not text is dropped");
  const plain = { ops: [] };
  assert.equal(takeSaid(plain).input, plain, "an input without them is passed on as it is");
  assert.deepEqual(takeSaid(null), { input: null, said: {} });
});

test("callDetails gives a receipt's fields, or a text answer's lines without paths and advice", () => {
  const receipt = { text: JSON.stringify({ rev: 4, turn: "T1", created: { title: "L1" }, changed: ["s1"], check: "0 err", next: "do more", inbox: [] }) };
  assert.deepEqual(callDetails(receipt), ["created title → L1", "changed s1", "check 0 err"]);
  const text = { text: "frame s1 @18s 480px\nimage /Users/x/frame.png\nW contrast title @60: too low\nnote: something\n  indented\nmore words" };
  assert.deepEqual(callDetails(text), ["W contrast title @60: too low", "more words"]);
  assert.equal(callDetails({ text: "one line" }).length, 0);
  // A text answer's advice to the agent is left out too, as a receipt's is.
  assert.deepEqual(callDetails({ text: "Q16 waits\nnext The person answers in the kino dashboard. Allow it there.\nrules: ask first\nframes 10200" }), ["frames 10200"]);
  assert.ok(callDetails({ text: `x\n${"y".repeat(200)}` })[0].length <= 90);
});

test("every agent tool takes why and next", () => {
  for (const tool of AGENT_TOOLS) {
    const shape = tool.inputSchema?.shape ?? tool.input?.shape ?? tool.inputSchema ?? tool.input;
    assert.ok(shape && "why" in shape && "next" in shape, `${tool.name} takes why and next`);
  }
});

let server;
let key;
before(async () => {
  server = await startTestServer();
  const response = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  key = (await response.json()).key;
});
after(() => server?.stop());

async function agent(verb, body) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body }, headers: { "x-kino-session": "said-1" } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
async function dashboard(route) {
  const response = await server.api(`/api/dashboard/${route}`, { headers: { "x-kino-review": key } });
  return { status: response.status, body: await response.json() };
}

test("a call's why and next reach the dashboard with its answer's lines; the edit never sees them", async () => {
  await agent("project", { action: "create", id: "said", name: "Said", duration: 4, why: "start", next: "add a title" });
  const edit = await agent("edit", { project: "said", ops: [{ op: "add_layer", layerType: "text", name: "title", properties: { text: "Hi" } }], why: "a title first", next: "look at it" });
  assert.equal(edit.isError ?? false, false, JSON.stringify(edit).slice(0, 300));
  const { body } = await dashboard("snapshot?project=said");
  const events = body.events ?? body.calls ?? [];
  const call = events.filter((event) => event.verb === "edit").at(-1);
  assert.ok(call, "the edit is in the snapshot's events");
  assert.equal(call.why, "a title first");
  assert.equal(call.next, "look at it");
  assert.ok(call.details.some((line) => line.startsWith("created title")), call.details.join(" | "));
  assert.ok(!JSON.stringify(call.input ?? {}).includes("a title first"), "why is not kept in the input");

  const scene = body.record.document.scenes[0].id;
  const lanes = await dashboard(`lanes?project=said&scene=${scene}`);
  assert.equal(lanes.status, 200);
  assert.equal(lanes.body.sceneId, scene);
  assert.ok(Array.isArray(lanes.body.shots) && Array.isArray(lanes.body.voice));
  assert.equal((await dashboard("lanes?project=said&scene=nope")).status, 404);
});
