// A final render that waits for the person's approval (D3), on a real server answered from a
// dashboard window: the request names the revision it renders, render cancel withdraws it (the
// dashboard stops asking), the same render after an edit replaces the request for the older
// revision, and allowing a request after an edit asks again instead of rendering a revision the
// person never saw on the card.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestServer } from "./media.test.support.mjs";

let server;
let key;
before(async () => {
  server = await startTestServer();
  // What a dashboard page's fetch() sends: the browser sets these headers itself.
  key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
  // A 1 s scene is 30 final frames: over a limit of 10, so it asks, and small enough to render.
  const saved = await server.api("/api/dashboard/settings", { method: "PUT", headers: { "x-kino-review": key }, body: { limits: { finalRenderFrames: 10 } } });
  assert.equal(saved.status, 200);
});
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "test-agent", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const answer = async (id, decision = "allow") => {
  const response = await server.api(`/api/dashboard/approvals/${id}`, { method: "POST", headers: { "x-kino-review": key }, body: { decision } });
  return { status: response.status, body: await response.json() };
};
const approvals = async (project) => (await (await server.api(`/api/dashboard/snapshot?project=${project}`)).json()).approvals;
const revision = async (project) => (await (await server.api(`/api/projects/${project}`)).json()).revision;
const edit = (project, background) => agent("edit", { project, ops: [{ op: "update_scene", properties: { background } }] });

async function project(id) {
  await agent("project", { action: "create", id, width: 320, height: 180, duration: 1, background: "#15191e" });
  await agent("check", { project: id, fix: "auto" });
  return id;
}

test("a final render waiting for approval names its revision, and render cancel withdraws it so the dashboard stops asking", async () => {
  const id = await project("ask-cancel");
  const rev = await revision(id);
  const asked = await agent("render", { project: id, action: "start", quality: "final" });
  assert.equal(asked.data.status, "awaiting_approval", asked.text);
  assert.equal(asked.data.rev, rev);
  assert.match(asked.data.summary, new RegExp(`^a final mp4 of s1 at rev ${rev} \\(30 frames, over 10\\)$`));
  const q = asked.data.id;
  assert.equal((await approvals(id)).find((entry) => entry.id === q).summary, asked.data.summary, "the dashboard card shows the revision");
  // wait blocks for the person's answer instead of answering at once, and says not to poll.
  const started = Date.now();
  const pending = await agent("render", { project: id, action: "wait", job: q, timeout_s: 0.6 });
  assert.ok(Date.now() - started >= 500, "wait blocked");
  assert.equal(pending.data.status, "awaiting_approval", pending.text);
  assert.match(pending.text, /Only the person can answer it, in the kino app or in the chat \(asked \d+ min ago\).*notes \{action:\\?"answer.*Do not poll/);

  const canceled = await agent("render", { project: id, action: "cancel", job: q });
  assert.equal(canceled.isError, undefined, canceled.text);
  assert.equal(canceled.data.status, "canceled", canceled.text);
  assert.match(canceled.text, new RegExp(`^${q} canceled: the person is no longer asked about a final mp4 of s1 at rev ${rev}`));
  const shown = (await approvals(id)).find((entry) => entry.id === q);
  assert.equal(shown.status, "canceled");
  assert.equal(shown.result.text, "the agent withdrew it");
  assert.doesNotMatch((await agent("status", { project: id })).text, /awaiting the person's approval/);
  const late = await answer(q);
  assert.equal(late.status, 409);
  assert.match(late.body.error ?? JSON.stringify(late.body), new RegExp(`${q} no longer waits: the agent withdrew it`));

  const again = await agent("render", { project: id, action: "cancel", job: q });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.text.split("\n")[0], `Nothing to cancel: ${q} is canceled (the agent withdrew it).`);
  const waited = await agent("render", { project: id, action: "wait", job: q });
  assert.equal(waited.data.status, "canceled", waited.text);
  assert.equal(waited.data.rev, rev);
  assert.deepEqual((await agent("render", { project: id, action: "queue" })).data.jobs, [], "nothing rendered");
});

test("the same final render after an edit replaces the request for the older revision", async () => {
  const id = await project("ask-replace");
  const first = await agent("render", { project: id, action: "start", quality: "final" });
  assert.equal(first.data.status, "awaiting_approval", first.text);
  const same = await agent("render", { project: id, action: "start", quality: "final" });
  assert.equal(same.data.id, first.data.id, "the same request at the same revision is one approval");
  assert.equal(same.data.replaced, undefined);

  await edit(id, "#223344");
  const rev = await revision(id);
  assert.ok(rev > first.data.rev);
  const second = await agent("render", { project: id, action: "start", quality: "final" });
  assert.equal(second.data.status, "awaiting_approval", second.text);
  assert.notEqual(second.data.id, first.data.id);
  assert.equal(second.data.replaced, first.data.id);
  assert.equal(second.data.rev, rev);
  assert.match(second.data.summary, new RegExp(`at rev ${rev} `));

  const listed = await approvals(id);
  assert.deepEqual(listed.filter((entry) => entry.status === "pending").map((entry) => entry.id), [second.data.id], "the dashboard asks only about the current revision");
  const old = listed.find((entry) => entry.id === first.data.id);
  assert.equal(old.status, "replaced");
  assert.equal(old.result.text, `${second.data.id} asks for rev ${rev} instead`);
  assert.equal((await answer(first.data.id)).status, 409);
  assert.equal((await agent("render", { project: id, action: "wait", job: first.data.id })).data.status, "replaced");
  await agent("render", { project: id, action: "cancel", job: second.data.id });
});

test("allowing a render after the project changed asks again for the new revision; allowed at the same revision, it renders that revision", async () => {
  const id = await project("ask-stale");
  const asked = await agent("render", { project: id, action: "start", quality: "final" });
  assert.equal(asked.data.status, "awaiting_approval", asked.text);
  await edit(id, "#334455");
  const rev = await revision(id);

  // The card said rev asked.data.rev: the newer revision is not rendered without asking.
  const allowed = await answer(asked.data.id);
  assert.equal(allowed.status, 200);
  const result = allowed.body.approval.result;
  assert.equal(result.job, null, result.text);
  const again = result.text.match(new RegExp(`^Not run: the project changed since ${asked.data.id} \\(rev ${asked.data.rev}, now rev ${rev}\\), so it asks again as (Q\\d+): a final mp4 of s1 at rev ${rev} `));
  assert.ok(again, result.text);
  const queue = await agent("render", { project: id, action: "queue" });
  assert.deepEqual(queue.data.jobs, [], "nothing rendered");
  assert.match(queue.text, new RegExp(`${asked.data.id} allowed: Not run: the project changed`), "the agent hears it in its inbox");
  const pending = (await approvals(id)).filter((entry) => entry.status === "pending");
  assert.deepEqual(pending.map((entry) => [entry.id, entry.rev]), [[again[1], rev]]);

  // Nothing changed since the new request: allowing it renders the revision it named, and a
  // wait already blocking on the request picks up that render.
  const waiting = agent("render", { project: id, action: "wait", job: again[1], timeout_s: 30 });
  const second = await answer(again[1]);
  assert.match((await waiting).text, new RegExp(`^${second.body.approval.result.job} final `));
  assert.equal(second.body.approval.result.isError, false, second.body.approval.result.text);
  assert.match(second.body.approval.result.job ?? "", /^R\d+$/, second.body.approval.result.text);
  const status = await agent("render", { project: id, action: "status", job: again[1] });
  assert.match(status.text, new RegExp(`^${second.body.approval.result.job} final \\S+ rev ${rev} `));
  // An allowed request's cancel stops its render.
  const canceled = await agent("render", { project: id, action: "cancel", job: again[1] });
  assert.equal(canceled.isError, undefined, canceled.text);
  assert.ok(["canceled", "done"].includes(canceled.data.status), canceled.text);
});

test("the person's yes in the chat allows a final render: notes answer with the Q id renders it and keeps their words", async () => {
  const id = await project("ask-chat");
  const asked = await agent("render", { project: id, action: "start", quality: "final" });
  assert.equal(asked.data.status, "awaiting_approval", asked.text);
  assert.match(asked.data.next, /in the kino app or in the chat/);
  const q = asked.data.id;
  const reply = { project: id, action: "answer", id: q, words: "yes, render it", read_as: "approve" };
  assert.equal((await agent("notes", { ...reply, words: " " })).data.error, "bad_input", "their words are kept");
  assert.equal((await agent("notes", { ...reply, read_as: "maybe" })).data.error, "bad_input");
  const allowed = await agent("notes", reply);
  assert.equal(allowed.isError, undefined, allowed.text);
  assert.equal(allowed.data.status, "allowed", allowed.text);
  assert.ok(allowed.data.job, allowed.text);
  const card = (await approvals(id)).find((entry) => entry.id === q);
  assert.equal(card.via, "chat");
  assert.equal(card.words, "yes, render it");
  const done = await agent("render", { project: id, action: "wait", job: allowed.data.job });
  assert.equal(done.data.status, "done", done.text);
  assert.equal((await agent("notes", reply)).data.error, "answered", "one answer per approval");
});
