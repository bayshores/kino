// Milestone A2, the agent service over HTTP (POST /api/agent/<verb>) on a real server with a
// temporary data folder: projects, edit receipts, refusals that save nothing, turns and revert,
// notes in the inbox, look images, draft renders and owner-only access.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createDocument } from "../engine/model.js";
import { pngSize } from "./meter.mjs";
import { nextCallOf, skipWithoutMediaTools, startTestServer, withoutNext } from "./media.test.support.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

// One agent call. The route always answers 200 with { text, data?, images?, isError? }.
async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

// The saved project as the editor sees it: { document, revision }.
async function saved(projectId) {
  const response = await server.api(`/api/projects/${projectId}`);
  assert.equal(response.status, 200);
  return response.json();
}

const layerIds = (record) => record.document.scenes[0].layers.map((layer) => layer.id);
const layer = (record, id) => record.document.scenes[0].layers.find((entry) => entry.id === id);

test("status with no open project lists the projects", async () => {
  const empty = await agent("status");
  assert.equal(withoutNext(empty.text), "No projects yet. project create {id, name, width, height, duration} makes one.");
  assert.equal(nextCallOf(empty).input.action, "create");
  assert.deepEqual(empty.data, { projects: [] });

  const created = await server.api("/api/projects", { method: "POST", body: { document: createDocument({ id: "listed", name: "Listed" }) } });
  assert.equal(created.status, 201);
  const listed = await agent("status");
  const [head, row] = listed.text.split("\n");
  assert.equal(head, "1 project (none open; project open {id} or status {project})");
  assert.match(row, /^ {2}listed 'Listed' 1 scene updated \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(listed.data.projects[0].id, "listed");
  assert.equal(listed.isError, undefined);
});

test("project create opens the new project; a taken or malformed ID is refused", async () => {
  const created = await agent("project", { action: "create", id: "alpha", name: "Alpha", width: 640, height: 360, duration: 3 });
  assert.equal(withoutNext(created.text), "created alpha rev 1 and opened it · s1 640×360 3s bg #ffffff");
  assert.deepEqual(created.data, { project: "alpha", rev: 1, scene: "s1" });

  const taken = await agent("project", { action: "create", id: "alpha" });
  assert.equal(taken.isError, true);
  assert.equal(taken.data.error, "exists");
  const malformed = await agent("project", { action: "create", id: "Not An ID" });
  assert.equal(malformed.data.error, "bad_input");

  // The open project is now alpha, so status shows its outline.
  const status = await agent("status");
  assert.match(status.text, /^Alpha \(alpha\) rev 1 · 1 scene · 0 layers · 0 anims$/m);
  assert.deepEqual(status.data, { project: "alpha", rev: 1, focus: "s1" });

  // A project's name works like its ID when one project has it.
  assert.equal((await agent("status", { project: "Listed" })).data.project, "listed");
  assert.equal((await agent("status", { project: "Nope" })).data.error, "unknown_project");

  // Reading another project (inspect, look, status) leaves alpha open, so the next call without project still means alpha.
  for (const [verb, body] of [["inspect", { targets: ["text"] }], ["status", {}]]) assert.notEqual((await agent(verb, { ...body, project: "listed" })).isError, true);
  assert.equal((await agent("status")).data.project, "alpha");
});

test("edit answers with a receipt of new names and codes, times and check counts", async () => {
  const reply = await agent("edit", { project: "alpha", ops: [
    { op: "add_layer", type: "rectangle", name: "card", properties: { x: 100, y: 100, width: 200, height: 100 } },
    { op: "add_layer", type: "text", name: "title", properties: { text: "Hello", x: 10, y: 10, fontSize: 48 } },
    { op: "add_animation", layer: "title", preset: "preset-fade", start: 0.2, duration: 0.6 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data, {
    rev: 2, created: { card: "L1", title: "L2", "title.in": "A1" }, changed: [], removed: [],
    times: { A1: [0.2, 0.8] }, fixed: ["type → layerType"],
    // The title at (10, 10) is outside the 5% safe margin; nothing moves after the fade (held_static);
    // the default white background is pure #fff. The receipt does not render frames, so it says
    // contrast and flashing are not counted.
    check: "1 err · 3 warn (safe_zone title, held_static card) · unchecked: contrast, flashing, luma_jump, frozen_picture",
    // The findings that came up in the stretch the edit changed (backend/agent/review.mjs).
    newFindings: "E safe_zone title @0.8s, held_static card @1.27s, default_font title", turn: "T1", inbox: [],
  });
  // The text is the same receipt as compact JSON, without the empty lists.
  assert.deepEqual(JSON.parse(reply.text), { rev: 2, created: { card: "L1", title: "L2", "title.in": "A1" }, times: { A1: [0.2, 0.8] }, fixed: ["type → layerType"], check: "1 err · 3 warn (safe_zone title, held_static card) · unchecked: contrast, flashing, luma_jump, frozen_picture", newFindings: "E safe_zone title @0.8s, held_static card @1.27s, default_font title", turn: "T1", next: 'check {"fix":"auto"}' });

  const record = await saved("alpha");
  assert.equal(record.revision, 2);
  assert.deepEqual(layerIds(record), ["card", "title"]);
  assert.equal(layer(record, "title").animations.length, 1);
});

test("a near-miss layer name is fixed and reported; a far miss gets did-you-mean and saves nothing", async () => {
  const fixed = await agent("edit", { project: "alpha", ops: [{ op: "update_layer", layer: "titel", properties: { fontSize: 60 } }] });
  assert.equal(fixed.data.rev, 3);
  assert.deepEqual(fixed.data.changed, ["title"]);
  assert.ok(fixed.data.fixed.includes("titel → title"));

  const far = await agent("edit", { project: "alpha", ops: [
    { op: "update_layer", layer: "card", properties: { x: 5 } },
    { op: "update_layer", layer: "zzzzzz", properties: { x: 5 } },
  ] });
  assert.equal(far.isError, true);
  assert.equal(far.data.error, "unknown_ref");
  assert.equal(far.data.op, 1);
  assert.match(far.data.reason, /^Operation 1 \(update_layer\): No layer "zzzzzz"\. Did you mean /);
  assert.ok(far.data.didYouMean.length > 0);
  assert.equal(far.data.safeToRetry, true);
  const record = await saved("alpha");
  assert.equal(record.revision, 3, "nothing was saved");
  assert.equal(layer(record, "card").x, 100, "the first operation was not applied either");
});

test("an operation the engine refuses names its number and rules, and the whole edit saves nothing", async () => {
  const reply = await agent("edit", { project: "alpha", ops: [
    { op: "update_layer", layer: "card", properties: { x: 5 } },
    { op: "add_animation", layer: "card", preset: "no-such-preset" },
  ] });
  assert.equal(reply.isError, true);
  assert.equal(reply.data.error, "op_failed");
  assert.equal(reply.data.op, 1);
  assert.equal(reply.data.type, "add_animation");
  assert.match(reply.data.reason, /unknown animation preset "no-such-preset"/);
  assert.match(reply.data.rules, /^add_animation \{/);
  const record = await saved("alpha");
  assert.equal(record.revision, 3);
  assert.equal(layer(record, "card").x, 100);

  const unknownOp = await agent("edit", { project: "alpha", ops: [{ op: "add_layr" }] });
  assert.equal(unknownOp.data.error, "op_failed");
  assert.ok(unknownOp.data.didYouMean.includes("add_layer"));
  assert.equal((await saved("alpha")).revision, 3);
});

test("rev: a stale edit that still applies is rebased; one that no longer applies is a conflict and saves nothing", async () => {
  const current = (await saved("alpha")).revision;
  const fresh = await agent("edit", { project: "alpha", rev: current, ops: [{ op: "update_layer", layer: "card", properties: { y: 120 } }] });
  assert.equal(fresh.data.rev, current + 1);
  assert.equal(fresh.data.rebased, undefined);

  const rebased = await agent("edit", { project: "alpha", rev: current, ops: [{ op: "update_layer", layer: "title", properties: { y: 20 } }] });
  assert.equal(rebased.data.rev, current + 2);
  assert.equal(rebased.data.rebased, true);

  // Someone deletes the card; an edit written before that cannot apply any more.
  const deleted = await agent("edit", { project: "alpha", ops: [{ op: "delete_layer", layer: "card" }] });
  assert.deepEqual(deleted.data.removed, ["card"]);
  const conflict = await agent("edit", { project: "alpha", rev: current, ops: [{ op: "update_layer", layer: "card", properties: { y: 0 } }] });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.data.error, "conflict");
  assert.equal(conflict.data.currentRev, current + 3);
  assert.ok(conflict.data.changedIds.includes("card"));
  assert.equal(conflict.data.safeToRetry, false);
  assert.equal((await saved("alpha")).revision, current + 3, "the conflict saved nothing");

  const ahead = await agent("edit", { project: "alpha", rev: 999, ops: [{ op: "update_layer", layer: "title", properties: { y: 0 } }] });
  assert.equal(ahead.data.error, "bad_input");
  assert.equal(ahead.data.currentRev, current + 3);
  const zero = await agent("edit", { project: "alpha", rev: 0, ops: [{ op: "update_layer", layer: "title", properties: { y: 0 } }] });
  assert.equal(zero.data.error, "bad_input");
  assert.equal((await saved("alpha")).revision, current + 3);
});

test("the same request_id is saved once, and dry_run saves nothing", async () => {
  const before = (await saved("alpha")).revision;
  const first = await agent("edit", { project: "alpha", request_id: "move-title-1", ops: [{ op: "update_layer", layer: "title", properties: { x: 7 } }] });
  assert.equal(first.data.rev, before + 1);
  const again = await agent("edit", { project: "alpha", request_id: "move-title-1", ops: [{ op: "update_layer", layer: "title", properties: { x: 7 } }] });
  assert.equal(again.data.repeated, true);
  assert.equal(again.data.rev, before + 1);
  assert.equal((await saved("alpha")).revision, before + 1, "the repeat saved nothing");

  const dry = await agent("edit", { project: "alpha", dry_run: true, ops: [{ op: "update_layer", layer: "title", properties: { x: 400 } }] });
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.wouldBeRev, before + 2);
  assert.deepEqual(dry.data.changed, ["title"]);
  assert.match(dry.data.check, /unchecked: contrast, flashing, luma_jump, frozen_picture$/, "a dry run names the gates it skipped");
  const record = await saved("alpha");
  assert.equal(record.revision, before + 1);
  assert.equal(layer(record, "title").x, 7);
});

test("check and inspect answer about the saved project", async () => {
  const edit = await agent("edit", { project: "alpha", ops: [{ op: "add_animation", layer: "title", preset: "preset-fade", mode: "out", start: 2.8, duration: 1 }] });
  assert.match(edit.data.check, /^1 err · 4 warn \(safe_zone title, past_scene_end A\d+\) · unchecked: contrast, flashing, luma_jump, frozen_picture$/);
  const check = await agent("check", { project: "alpha" });
  const lines = check.text.split("\n");
  assert.match(lines[0], /^rev \d+ · 1 err · 4 warn · 1 info · \d+ ms$/);
  assert.match(lines[1], /^E safe_zone title/);
  assert.ok(lines.some((line) => /^W past_scene_end A\d+ @2\.8: A\d+ runs 2\.8–3\.8s but s1 ends at 3s, so it is cut off\. fix: \{"op":"update_animation","animationId":"A\d+","properties":\{"duration":0\.2\}\}$/.test(line)));
  assert.equal(check.data.errors, 1);
  assert.equal(check.data.warnings, 4);
  // Order (answers-first): the counts, the errors, then the advice and the fix hint, then the warnings.
  assert.ok(lines.findIndex((line) => line.startsWith("advice (does not block)")) < lines.findIndex((line) => line.startsWith("W ")), check.text);
  // The next call ends the answer; a long answer also carries it early, as a short next, within the first 8 lines.
  assert.match(lines.at(-1), /^next: /);
  assert.ok(lines.slice(0, 8).some((line) => line.startsWith("next: ")), check.text);
  // The same check again on the same revision answers in one line; rules:true lists them again.
  const again = await agent("check", { project: "alpha", why: "again" });
  assert.match(withoutNext(again.text), /^rev \d+ · 1 err · 4 warn · 1 info · \d+ ms\nUnchanged since your same check \d+ s ago at this rev: the same findings\. check \{rules:true\} lists them again\.$/);
  assert.equal(again.data.unchanged, true);
  assert.match((await agent("check", { project: "alpha", rules: true })).text, /^E safe_zone title/m);

  const inspect = await agent("inspect", { project: "alpha", targets: ["text"], fields: ["fontSize", "x"] });
  assert.match(inspect.text, /^rev \d+\nL2 title text in s1\n {2}fontSize 60\n {2}x 7\nnext: /);
  assert.deepEqual([inspect.data.count, inspect.data.matched], [1, 1]);
  // fields as text (`kino inspect title fields=name`) was dropped, and every field came back.
  const one = await agent("inspect", { project: "alpha", targets: ["text"], fields: "fontSize" });
  assert.match(one.text, /^rev \d+\nL2 title text in s1\n {2}fontSize 60\nnext: /);
  const two = await agent("inspect", { project: "alpha", targets: ["text"], fields: "fontSize, x" });
  assert.equal(two.text, inspect.text);
  // A list item with commas is split: ["fontSize,x"] was one field that answered null.
  const joined = await agent("inspect", { project: "alpha", targets: ["text"], fields: ["fontSize,x"] });
  assert.equal(joined.text, inspect.text);
  // layer and layers name the targets too (`kino inspect layer=title` was refused), and one
  // string holds several names with commas.
  const byLayer = await agent("inspect", { project: "alpha", layer: "title", fields: "fontSize,x" });
  assert.equal(byLayer.text, inspect.text);
  const byLayers = await agent("inspect", { project: "alpha", layers: "title,L2", fields: "fontSize,x" });
  assert.equal(byLayers.data.count, 1, byLayers.text);
  // A name that is not a field is said so with the closest field names (it printed "fontSise null"
  // as if the field were only unset); a real field that is not set is still null.
  const typo = await agent("inspect", { project: "alpha", targets: ["text"], fields: ["fontSise", "role"] });
  assert.match(typo.text, /^rev \d+\nL2 title text in s1\n {2}role null\nfontSise: not a layer field\. Did you mean fontSize, [^\n]*\?\nnext: /);
  const step = await agent("inspect", { project: "alpha", targets: ["animation[kind=out]"], fields: ["durtion", "motionPath"] });
  assert.match(step.text, /\n {2}motionPath null\ndurtion: not an animation field\. Did you mean duration, [^\n]*\?\nnext: /);
  const wrong = await agent("inspect", { project: "alpha", targets: ["text"], fields: 3 });
  assert.equal(wrong.data.error, "bad_input");
  assert.match(wrong.data.reason, /^fields is a list of field names/);
  const none = await agent("inspect", { project: "alpha" });
  assert.equal(none.data.error, "bad_input");
});

test("history lists turns, and reverting an earlier turn keeps later edits", async () => {
  await agent("project", { action: "create", id: "turns", name: "Turns", width: 320, height: 180, duration: 2 });
  await agent("edit", { project: "turns", ops: [{ op: "add_layer", layerType: "rectangle", name: "first" }] });
  // A note from you ends the agent's turn; its next call starts a new one.
  await agent("notes", { project: "turns", action: "add", text: "Add a second box", by: "you" });
  const second = await agent("edit", { project: "turns", ops: [{ op: "add_layer", layerType: "ellipse", name: "second" }] });
  assert.equal(second.data.turn, "T2");

  const list = await agent("history", { project: "turns" });
  const lines = list.text.split("\n");
  assert.equal(lines[0], "rev 3 · 2 turns");
  assert.match(lines[1], /^ {2}T1 \d\d:\d\d \d+ calls · 1 edit rev 1→2$/);
  assert.match(lines[2], /^ {2}T2 \d\d:\d\d 1 call · 1 edit rev 2→3$/);
  assert.deepEqual(list.data.turns.map((turn) => turn.id), ["T1", "T2"]);

  // Reverting the first turn removes the first box and keeps the second.
  const reverted = await agent("history", { project: "turns", action: "revert", turn: "T1" });
  assert.deepEqual(reverted.data, { reverted: "T1", rev: 4, changed: ["first"] });
  assert.deepEqual(layerIds(await saved("turns")), ["second"]);
  const after = await agent("history", { project: "turns" });
  assert.match(after.text, /^ {2}T1 .* · reverted at rev 4$/m);

  const twice = await agent("history", { project: "turns", action: "revert", turn: "T1" });
  assert.equal(twice.data.error, "bad_input");
  assert.match(twice.data.reason, /already reverted/);
  const missing = await agent("history", { project: "turns", action: "revert", turn: "T9" });
  assert.equal(missing.data.error, "not_found");

  // restore brings back a saved revision as a new one.
  const restored = await agent("history", { project: "turns", action: "restore", rev: 2 });
  assert.equal(restored.data.restored, 2);
  assert.equal(restored.data.rev, 5);
  assert.deepEqual(layerIds(await saved("turns")), ["first"]);
});

test("a revert you make arrives in the agent's next reply", async () => {
  await agent("project", { action: "create", id: "you-revert", name: "You revert", width: 320, height: 180, duration: 2 });
  await agent("edit", { project: "you-revert", ops: [{ op: "add_layer", layerType: "rectangle", name: "first" }] });
  const reverted = await agent("history", { project: "you-revert", action: "revert", by: "you" });
  assert.equal(reverted.data.reverted, "T1");
  assert.doesNotMatch(reverted.text, /inbox/, "your own reply does not take the agent's inbox");
  const next = await agent("status", { project: "you-revert" });
  // The inbox sits right after the checks line, before the layer rows (answers-first).
  assert.match(withoutNext(next.text), /\nchecks [^\n]*\ninbox ◆1\n {2}you reverted T1 \(rev 1→2\); now rev 3\ns1 /);
});

test("a call you make leaves the agent's inbox for the agent", async () => {
  await agent("project", { action: "create", id: "you-read", name: "You read", width: 320, height: 180, duration: 2 });
  await agent("notes", { project: "you-read", action: "add", text: "Slower intro", by: "you" });
  const yours = await agent("notes", { project: "you-read", action: "list", by: "you" });
  assert.doesNotMatch(yours.text, /inbox/);
  const next = await agent("status", { project: "you-read" });
  assert.match(withoutNext(next.text), /\ninbox ◆1\n {2}N1 note "Slower intro" · when done: notes \{action:"reply", id:"N1", text\}\ns1 /);
});

test("a note you send arrives once in the agent's next reply, then can be replied to and resolved", async () => {
  await agent("project", { action: "create", id: "noted", name: "Noted", width: 320, height: 180, duration: 2 });
  const added = await agent("notes", { project: "noted", action: "add", text: "Make the logo bigger", t: 1.5, by: "you" });
  assert.equal(withoutNext(added.text), "N1 saved; the agent gets it with its next call.");
  assert.equal(added.data.note.status, "new");

  const status = await agent("status", { project: "noted" });
  assert.match(withoutNext(status.text), /\ninbox ◆1\n {2}N1 note @1\.5 "Make the logo bigger" · when done: notes \{action:"reply", id:"N1", text\}\ns1 /);
  const again = await agent("status", { project: "noted" });
  assert.doesNotMatch(again.text, /inbox/, "the inbox is handed over once");

  const list = await agent("notes", { project: "noted" });
  assert.equal(withoutNext(list.text), '1 open note\nN1 seen @1.5 "Make the logo bigger"');
  const reply = await agent("notes", { project: "noted", action: "reply", id: "n1", text: "Done: 20% bigger" });
  assert.equal(withoutNext(reply.text), 'N1 addressed @1.5 "Make the logo bigger" · reply: "Done: 20% bigger"');
  const resolved = await agent("notes", { project: "noted", action: "resolve", id: "N1" });
  assert.equal(resolved.data.note.status, "resolved");
  assert.equal(withoutNext((await agent("notes", { project: "noted" })).text), "0 open notes · 1 resolved");

  const plan = await agent("notes", { project: "noted", action: "set_plan", steps: [{ text: "Logo", done: true }, "Title", "Render"] });
  assert.equal(withoutNext(plan.text), "plan saved: 1/3 done · now: Title");
  assert.match((await agent("status", { project: "noted" })).text, /^plan ▸ Title \(1\/3\)$/m);
  // done:[n] ticks off a step of the saved plan without sending the list again.
  const ticked = await agent("notes", { project: "noted", action: "set_plan", done: 2 });
  assert.equal(withoutNext(ticked.text), "plan saved: 2/3 done · now: Render");
  assert.deepEqual(ticked.data.plan.map((step) => step.done), [true, true, false]);
  const wrong = await agent("notes", { project: "noted", action: "set_plan", done: [4] });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /done lists step numbers from 1 to 3/);
});

test("a note sent back is new again; an always note keeps its layers until you let the agent remove them", async () => {
  await agent("project", { action: "create", id: "kept", name: "Kept", width: 320, height: 180, duration: 2 });
  await agent("edit", { project: "kept", ops: [{ op: "add_layer", layerType: "rectangle", name: "logo" }] });
  await agent("notes", { project: "kept", action: "add", text: "Keep the logo", by: "you" });
  await agent("notes", { project: "kept", action: "reply", id: "N1", text: "kept" });
  // Only you send a note back or make it hold for the whole video.
  assert.equal((await agent("notes", { project: "kept", action: "reopen", id: "N1" })).isError, true);
  const back = await agent("notes", { project: "kept", action: "reopen", id: "N1", text: "still gone at 1s", by: "you" });
  assert.equal(back.data.note.status, "new");
  assert.match((await agent("status", { project: "kept" })).text, /\n {2}N1 not fixed yet: still gone at 1s · when done: notes/);

  await agent("notes", { project: "kept", action: "always", id: "N1", on: true, by: "you" });
  const status = await agent("status", { project: "kept" });
  assert.match(status.text, /^always ▸ N1 "Keep the logo"$/m);
  assert.match(status.text, /N1 "Keep the logo" now holds for the whole video\. Link layers to keep: notes \{action:"keep"/);
  assert.equal(withoutNext((await agent("notes", { project: "kept", action: "keep", id: "N1", layers: ["logo"] })).text), "N1 keeps L1 logo");

  // An edit that removes a kept layer saves nothing and waits for you as S1.
  const refused = await agent("edit", { project: "kept", ops: [{ op: "delete_layer", layer: "logo" }] });
  assert.equal(refused.data.error, "kept");
  assert.match(refused.data.reason, /^Not saved: L1 logo is kept by N1 "Keep the logo".* The person was asked \(S1\)/);
  assert.equal(layerIds(await saved("kept")).length, 1);
  const [item] = (await (await server.api("/api/dashboard/snapshot?project=kept")).json()).agent.stopped;
  assert.deepEqual({ ...item, at: typeof item.at, agent: typeof item.agent }, { id: "S1", noteId: "N1", layers: layerIds(await saved("kept")), summary: "delete logo", at: "string", agent: "string" });

  const let_ = await agent("notes", { project: "kept", action: "stopped", id: "S1", answer: "let", by: "you" });
  assert.deepEqual(let_.data.stopped, []);
  assert.match((await agent("status", { project: "kept" })).text, /\n {2}the person let you remove L1 logo: send the edit again/);
  assert.equal((await agent("edit", { project: "kept", ops: [{ op: "delete_layer", layer: "logo" }] })).isError, undefined);

  // You closing an always note ends it: it no longer holds or shows as open.
  const closed = await agent("notes", { project: "kept", action: "resolve", id: "N1", by: "you" });
  assert.deepEqual([closed.data.note.status, closed.data.note.always], ["resolved", undefined]);
  assert.doesNotMatch((await agent("status", { project: "kept" })).text, /always ▸/);
});

test("look returns PNG images for a sheet and a frame, saved as files", async () => {
  const sheet = await agent("look", { project: "alpha" });
  assert.equal(sheet.isError, undefined);
  assert.match(withoutNext(sheet.text), /^sheet s1: 1=0s 2=\S+ .* 12=\S+\nimage \S+\.png$/);
  assert.equal(sheet.images.length, 1);
  const [image] = sheet.images;
  assert.equal(image.mime, "image/png");
  assert.deepEqual(Buffer.from(image.data, "base64").subarray(0, 8), PNG_SIGNATURE);
  assert.ok(image.path.startsWith(server.dataDirectory), "the image is saved in kino's data folder");
  assert.deepEqual((await readFile(image.path)).subarray(0, 8), PNG_SIGNATURE);
  assert.equal(sheet.data.path, image.path);

  // changed compares with the last look at this scene.
  const same = await agent("look", { project: "alpha", mode: "changed" });
  assert.match(same.text, /^nothing visible changed in s1 since your last look \(12 frames compared\)/);
  assert.equal(same.images, undefined);
  await agent("edit", { project: "alpha", ops: [{ op: "add_layer", layerType: "rectangle", name: "backdrop", properties: { x: 0, y: 0, width: 640, height: 360, fill: "#ff0000" } }] });
  const changed = await agent("look", { project: "alpha", mode: "changed" });
  assert.match(changed.text, /^changed since your last look at s1: \S+s/);
  assert.deepEqual(Buffer.from(changed.images[0].data, "base64").subarray(0, 8), PNG_SIGNATURE);

  const frame = await agent("look", { project: "alpha", mode: "frame", t: 1, width: 320 });
  assert.match(frame.text, /^frame s1 @1s 320px\nimage /);
  const bytes = Buffer.from(frame.images[0].data, "base64");
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE);
  assert.deepEqual(pngSize(bytes), { width: 320, height: 180 });

  const onDisk = await agent("look", { project: "alpha", mode: "frame", t: 2, inline: false });
  assert.equal(onDisk.images[0].data, undefined, "inline:false sends only the path");
  assert.ok(existsSync(onDisk.images[0].path));

  const unknown = await agent("look", { project: "alpha", mode: "shet" });
  assert.equal(unknown.data.error, "bad_input");
  assert.equal(unknown.data.didYouMean[0], "sheet");
});

test("render draft makes a video file", { skip: skipWithoutMediaTools }, async () => {
  const started = await agent("render", { project: "alpha", action: "start", quality: "draft" });
  assert.match(started.text, /^R\d+ queued: draft mp4, about \d+s\./);
  const done = await agent("render", { action: "wait", job: started.data.job, timeout_s: 55 });
  assert.equal(done.isError, undefined, done.text);
  assert.equal(done.data.status, "done", done.text);
  assert.ok(done.data.path.startsWith(server.dataDirectory));
  const file = await readFile(done.data.path);
  assert.ok(file.length > 1000);
  assert.equal(file.subarray(4, 8).toString("latin1"), "ftyp", "the file is an MP4");
  assert.match(done.text, /^R\d+ draft done rev \d+ 320×180 30fps 3s/);
  assert.equal(done.data.files[0].validation.ok, true);
  assert.equal(done.data.files[0].width, 320);
  assert.equal(done.data.files[0].height, 180);
});

test("the agent route is for the owner only: a sharing link or no key gets 403", async () => {
  const link = await server.api("/api/projects/alpha/shares", { method: "POST", body: { role: "edit", label: "editor" } });
  assert.equal(link.status, 201);
  const { token } = await link.json();
  const shared = await server.api("/api/agent/status", { method: "POST", owner: false, share: token, body: {} });
  assert.equal(shared.status, 403);
  const anonymous = await server.api("/api/agent/edit", { method: "POST", owner: false, body: { project: "alpha", ops: [{ op: "delete_layer", layer: "title" }] } });
  assert.equal(anonymous.status, 403);
  assert.ok(layer(await saved("alpha"), "title"), "the refused edit changed nothing");
});

test("an unknown verb is a readable answer with did-you-mean", async () => {
  const reply = await agent("stauts");
  assert.equal(reply.isError, true);
  assert.equal(reply.data.error, "unknown_verb");
  assert.equal(reply.data.didYouMean[0], "status");
});
