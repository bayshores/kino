import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { startTestServer, readImage } from "./media.test.support.mjs";
import { createAgentClient } from "./agent/client.mjs";
import { renderFrame } from "../tests/golden/render.mjs";
import { createTemplateDocument } from "../engine/templates.js";
import { createPieces } from "./pieces.mjs";
import { openPieceFile } from "./piece-file.mjs";
// These tests are about reaching features; approvals (D3) are tested in dashboard tests and
// in agent-reach-workspace's approval test, so the person here allows them.
const REACH_ALLOW = ["delete-scene", "delete-project", "share-link", "final-render", "overwrite-export", "large-import"];

let server;
before(async () => { server = await startTestServer({ allow: REACH_ALLOW }); });
after(() => server?.stop());
async function call(verb, body, error = false) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(Boolean(result.isError), error, result.text);
  return result;
}
const manage = (id, resource, action, fields = {}, error = false) => call("project", { action: "manage", id, options: { resource, action, ...fields } }, error);
const create = (id) => call("project", { action: "create", id, width: 320, height: 180, duration: 2, background: "#15191e" });
const edit = (project, ops, extra = {}, error = false) => call("edit", { project, ops, ...extra }, error);
async function saved(id) { return (await server.api(`/api/projects/${id}`)).json(); }
async function pixels(id, t = 1) {
  const result = await call("look", { project: id, mode: "frame", t, width: 320 });
  return readFile(result.images[0].path);
}
const box = (id = "box") => ({ op: "add_layer", layerType: "rectangle", name: id, properties: { x: 40, y: 40, width: 100, height: 60, fill: "#ff6b4a" } });

test("Editing basics: cross-project copy and paste replace preserve pixels, source and revision recovery", async () => {
  await create("copy-source"); await create("copy-dest");
  await edit("copy-source", [box()]);
  const source = await saved("copy-source");
  await edit("copy-dest", [{ op: "copy_layers", fromProject: "copy-source", layers: ["box"] }], { request_id: "copy-once" });
  const copied = await saved("copy-dest");
  assert.notEqual(copied.document.scenes[0].layers[0].id, "box");
  assert.deepEqual(await pixels("copy-source"), await pixels("copy-dest"));
  const repeat = await edit("copy-dest", [{ op: "copy_layers", fromProject: "copy-source", layers: ["box"] }], { request_id: "copy-once" });
  assert.equal(repeat.data.repeated, true);
  assert.deepEqual(await saved("copy-source"), source);
  const dry = await edit("copy-dest", [{ op: "copy_layers", fromProject: "copy-source", layers: ["box"] }], { dry_run: true });
  assert.equal(dry.data.dryRun, true);
  assert.equal((await saved("copy-dest")).revision, copied.revision);
  await edit("copy-dest", [{ op: "copy_layers", fromProject: "copy-source", layers: ["missing"] }, box("never-saved")], {}, true);
  assert.equal((await saved("copy-dest")).revision, copied.revision);
  await edit("copy-dest", [{ op: "update_layer", layer: "L1", properties: { fill: "#3cc8b4" } }]);
  await edit("copy-dest", [{ op: "copy_layers", fromProject: "copy-source", layers: ["box"], replaceLayers: ["L1"] }]);
  assert.deepEqual(await pixels("copy-source"), await pixels("copy-dest"));
});

test("Scenes and animation clipboard: copy scene and animation across projects render the same", async () => {
  await create("scene-source"); await create("scene-target");
  await edit("scene-source", [box(), { op: "add_animation", layer: "box", preset: "move", start: 0, duration: 1, easing: "smooth", from: { x: 40 }, to: { x: 120 } }]);
  await edit("scene-target", [{ op: "copy_scene", fromProject: "scene-source", fromScene: "s1", replace: true }]);
  assert.deepEqual(await pixels("scene-source", 0.5), await pixels("scene-target", 0.5));
  await create("anim-target"); await edit("anim-target", [box()]);
  await edit("anim-target", [{ op: "copy_animations", fromProject: "scene-source", sourceAnimations: ["A1"], layers: ["box"], time: 0 }]);
  assert.deepEqual(await pixels("scene-source", 0.5), await pixels("anim-target", 0.5));
});

test("Animation: saved easing and text effect names reach durable presets and rendered frames", async () => {
  await create("saved-presets");
  await edit("saved-presets", [{ op: "add_layer", layerType: "text", name: "title", properties: { text: "Hello", x: 40, y: 60, width: 240, height: 80, fontSize: 40, fill: "#ffffff" } }, { op: "add_animation", layer: "title", preset: "preset-fade", start: 0, duration: 1 }]);
  const easing = await manage(null, "easings", "save", { name: "Coral ease", easing: [0.2, 0, 0.4, 1] });
  await edit("saved-presets", [{ op: "apply_easing", name: "Coral ease", animationIds: ["A1"] }]);
  assert.deepEqual((await saved("saved-presets")).document.scenes[0].layers[0].animations[0].easing, [0.2, 0, 0.4, 1]);
  const original = await pixels("saved-presets", 0.5);
  const effect = await manage("saved-presets", "effects", "save", { name: "Gentle reveal", sourceAnimation: "A1" });
  await edit("saved-presets", [{ op: "delete_animation", animation: "A1" }, { op: "apply_text_effect", name: "Gentle reveal", layers: ["title"], time: 0 }]);
  assert.deepEqual(await pixels("saved-presets", 0.5), original);
  assert.ok((await call("library", { topic: "text-effects" })).text.includes("Gentle reveal"));
  const catalog = (await call("library", { topic: "effects" })).text;
  assert.ok(catalog.includes("vignette") && !catalog.includes("Gentle reveal") && !catalog.includes("No saved"), "effects lists the catalog, saved text effects are their own topic");
  assert.match((await call("library", { topic: "effects", name: "speed-lines" })).text, /^speed-lines \(Speed Lines, Post FX\)[\s\S]*\n {2}taper number /);
  const missing = await call("library", { topic: "effects", name: "vinjette" }, true);
  assert.match(missing.text, /No effect \\"vinjette\\"\./);
  assert.ok((await call("library", { topic: "easings" })).text.includes("Coral ease"));
  await manage(null, "easings", "rename", { id: easing.data.id, name: "Changed ease" });
  await manage(null, "effects", "rename", { id: effect.data.id, name: "Changed reveal" });
  await manage(null, "easings", "delete", { id: easing.data.id });
  await manage(null, "effects", "delete", { id: effect.data.id });
  const before = await saved("saved-presets");
  await edit("saved-presets", [{ op: "apply_text_effect", name: "Changed reveal", layers: ["title"] }], {}, true);
  assert.equal((await saved("saved-presets")).revision, before.revision);
});

test("Comments and presence metadata: pins, replies, mentions, edits and resolve persist without changing render", async () => {
  await create("comments-reach"); await edit("comments-reach", [box()]);
  const before = await pixels("comments-reach");
  const root = await manage("comments-reach", "comments", "add", { text: "Check @Ada", author: "Agent", scene: "s1", x: 70, y: 70, time: 0.5, mentions: ["Ada"] });
  assert.equal(root.data.time, 0.5);
  assert.equal(root.data.authorKeyHash, undefined);
  const reply = await manage("comments-reach", "comments", "add", { text: "Adjusted", parentId: root.data.id });
  await manage("comments-reach", "comments", "update", { id: reply.data.id, patch: { text: "Ready for review" } });
  await manage("comments-reach", "comments", "resolve", { id: root.data.id });
  const list = await manage("comments-reach", "comments", "list");
  assert.equal(list.data.comments.length, 2);
  assert.equal(list.data.comments[0].resolved, true);
  assert.deepEqual(await pixels("comments-reach"), before);
  const key = await readFile(`${server.dataDirectory}/agent/comment-author-key`, "utf8");
  assert.ok(!JSON.stringify(list).includes(key));
  await manage("comments-reach", "comments", "delete", { id: root.data.id });
  assert.equal((await manage("comments-reach", "comments", "list")).data.comments.length, 0);
});

test("Workspace: folders, Drafts, Trash, restore and permanent deletion preserve live documents", async () => {
  await create("folder-reach"); await edit("folder-reach", [box()]);
  const before = await pixels("folder-reach");
  const folder = await manage(null, "folders", "create", { name: "Client" });
  await manage(null, "folders", "rename", { id: folder.data.id, name: "Delivery" });
  await manage("folder-reach", "folders", "move", { folderId: folder.data.id });
  assert.equal((await saved("folder-reach")).folderId, folder.data.id);
  await manage("folder-reach", "folders", "move", { folderId: null });
  assert.equal((await saved("folder-reach")).folderId, null);
  await manage(null, "folders", "delete", { id: folder.data.id });
  await call("project", { action: "archive", id: "folder-reach" });
  assert.ok((await manage(null, "trash", "list")).data.projects.some((p) => p.id === "folder-reach"));
  await manage(null, "trash", "restore", { id: "folder-reach" });
  assert.deepEqual(await pixels("folder-reach"), before);
  await manage(null, "trash", "delete", { id: "folder-reach", confirm: true }, true);
  await call("project", { action: "archive", id: "folder-reach" });
  await manage(null, "trash", "delete", { id: "folder-reach" }, true);
  await manage(null, "trash", "delete", { id: "folder-reach", confirm: true });
  assert.equal((await server.api("/api/projects/folder-reach")).status, 404);
});

test("Sharing: agent creates and revokes capability links with enforced roles and unchanged pixels", async () => {
  await create("share-reach"); await edit("share-reach", [box()]);
  const before = await pixels("share-reach");
  for (const role of ["view", "comment", "edit"]) {
    const share = await manage("share-reach", "shares", "create", { role, label: "Proof", scene: "s1", layer: "box" });
    const token = share.data.token;
    assert.ok(token, share.text);
    const url = new URL(share.data.url);
    assert.equal(url.searchParams.has("share"), false);
    assert.equal(new URLSearchParams(url.hash.slice(1)).get("share"), token);
    assert.equal(url.searchParams.get("layer"), "box");
    assert.equal(new URL(share.data.desktopUrl).protocol, "kino:");
    const events = await readFile(`${server.dataDirectory}/agent/projects/share-reach.events.jsonl`, "utf8");
    assert.ok(!events.includes(token), "activity log never receives capability secrets");
    const access = await server.api("/api/projects/share-reach", { owner: false, share: token });
    assert.equal(access.status, 200);
    assert.equal((await access.json()).access.role, role);
    const denied = await server.api("/api/agent/edit", { owner: false, share: token, method: "POST", body: { project: "share-reach", ops: [box("forbidden")] } });
    assert.equal(denied.status, 403);
    await manage("share-reach", "shares", "revoke", { id: share.data.grant.id });
    assert.equal((await server.api("/api/projects/share-reach", { owner: false, share: token })).status, 403);
  }
  assert.deepEqual(await pixels("share-reach"), before);
});

test("Approvals: manage share links, deleting from Trash forever and big final exports ask the person first, and hold pauses manage writes", async () => {
  // A server with the default approval rules (every kind asks).
  const asking = await startTestServer();
  try {
    const ask = async (verb, body) => (await (await asking.api(`/api/agent/${verb}`, { method: "POST", body })).json());
    await ask("project", { action: "create", id: "ask-reach", width: 320, height: 180, duration: 30, background: "#15191e" });
    const share = await ask("project", { action: "manage", id: "ask-reach", options: { resource: "shares", action: "create", role: "comment" } });
    assert.equal(share.data?.status, "awaiting_approval", share.text);
    assert.equal(share.data?.token, undefined, "no link is made before the person allows it");
    const listed = await ask("project", { action: "manage", id: "ask-reach", options: { resource: "shares", action: "list" } });
    assert.equal(listed.isError, undefined, listed.text);
    assert.deepEqual(JSON.parse(JSON.stringify(listed.data?.shares ?? listed.data?.grants ?? [])), []);
    const final = await ask("project", { action: "manage", id: "ask-reach", options: { resource: "exports", action: "start", quality: "final", options: { format: "mp4", fps: 30 } } });
    assert.equal(final.data?.status, "awaiting_approval", final.text);
    assert.match(final.data.summary, /900 frames, over 600/);
    await ask("project", { action: "create", id: "ask-trash", width: 320, height: 180, duration: 2, background: "#15191e" });
    const archived = await ask("project", { action: "archive", id: "ask-trash" });
    assert.equal(archived.data?.status, "awaiting_approval", archived.text);
    const forever = await ask("project", { action: "manage", options: { resource: "trash", action: "delete", id: "ask-trash", confirm: true } });
    assert.equal(forever.data?.status, "awaiting_approval", forever.text);
    assert.equal((await asking.api("/api/projects/ask-trash")).status, 200, "nothing was deleted");
    // Hold (H in the dashboard): a manage write answers held, a manage read still works.
    const { key } = await (await asking.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: asking.baseUrl } })).json();
    await asking.api("/api/dashboard/hold", { method: "POST", headers: { "x-kino-review": key }, body: { on: true } });
    const held = await ask("project", { action: "manage", options: { resource: "folders", action: "create", name: "Held" } });
    assert.equal(held.data?.held, true, held.text);
    const folders = await ask("project", { action: "manage", options: { resource: "folders", action: "list" } });
    assert.equal(folders.isError, undefined, folders.text);
    assert.ok(!JSON.stringify(folders.data).includes("Held"));
  } finally {
    await asking.stop();
  }
});

test("Approvals: Bulk Create deleteMissing, deleting a folder with projects in it and finals longer than the scene ask first", async () => {
  // A server with the default approval rules (every kind asks).
  const asking = await startTestServer();
  try {
    const ask = async (verb, body) => (await (await asking.api(`/api/agent/${verb}`, { method: "POST", body })).json());
    const read = async (id) => (await asking.api(`/api/projects/${id}`)).json();
    await ask("project", { action: "create", id: "ask-bulk", width: 320, height: 180, duration: 2, background: "#15191e" });
    await ask("edit", { project: "ask-bulk", ops: [{ op: "add_layer", layerType: "text", name: "Title", properties: { text: "Base", x: 40, y: 40, width: 240, height: 80, fontSize: 36, fill: "#ffffff" } }] });
    const made = await ask("edit", { project: "ask-bulk", ops: [{ op: "bulk_create", scene: "s1", csv: "id,Title\none,One\ntwo,Two\n" }] });
    assert.equal(made.isError, undefined, made.text);
    const before = await read("ask-bulk");
    // The CSV leaves out "two", so deleteMissing would delete that variant's scene.
    const leaveOutTwo = [{ op: "bulk_create", scene: "s1", csv: "id,Title\none,One\n", deleteMissing: true }];
    const preview = await ask("edit", { project: "ask-bulk", ops: leaveOutTwo, dry_run: true });
    assert.equal(preview.isError, undefined, preview.text);
    assert.notEqual(preview.data?.status, "awaiting_approval", "a dry run only shows the plan");
    const removing = await ask("edit", { project: "ask-bulk", ops: leaveOutTwo });
    assert.equal(removing.data?.status, "awaiting_approval", removing.text);
    assert.match(removing.data.summary, /deleting 1 scene in ask-bulk: \S+ \('[^']* - two'\)/);
    const after = await read("ask-bulk");
    assert.equal(after.revision, before.revision, "nothing was saved");
    assert.deepEqual(after.document.scenes.map((scene) => scene.id), before.document.scenes.map((scene) => scene.id));
    // deleteMissing with every variant still in the CSV removes nothing, so it does not ask.
    const keepBoth = await ask("edit", { project: "ask-bulk", ops: [{ op: "bulk_create", scene: "s1", csv: "id,Title\none,One\ntwo,Two\n", deleteMissing: true }] });
    assert.equal(keepBoth.isError, undefined, keepBoth.text);
    assert.notEqual(keepBoth.data?.status, "awaiting_approval", keepBoth.text);

    // Deleting a folder moves its projects to Trash, so it asks; an empty folder does not.
    const client = await ask("project", { action: "manage", options: { resource: "folders", action: "create", name: "Client" } });
    await ask("project", { action: "manage", id: "ask-bulk", options: { resource: "folders", action: "move", folderId: client.data.id } });
    const deleting = await ask("project", { action: "manage", options: { resource: "folders", action: "delete", id: client.data.id } });
    assert.equal(deleting.data?.status, "awaiting_approval", deleting.text);
    assert.match(deleting.data.summary, /archiving 1 project by deleting folder 'Client': ask-bulk/);
    assert.equal((await asking.api("/api/projects/ask-bulk")).status, 200);
    assert.equal((await read("ask-bulk")).folderId, client.data.id, "the project is still in its folder");
    const empty = await ask("project", { action: "manage", options: { resource: "folders", action: "create", name: "Empty" } });
    const emptied = await ask("project", { action: "manage", options: { resource: "folders", action: "delete", id: empty.data.id } });
    assert.equal(emptied.isError, undefined, emptied.text);
    assert.notEqual(emptied.data?.status, "awaiting_approval", emptied.text);
    const folders = await ask("project", { action: "manage", options: { resource: "folders", action: "list" } });
    assert.ok(JSON.stringify(folders.data).includes("Client") && !JSON.stringify(folders.data).includes("Empty"), folders.text);

    // The frame count is what the exporter draws: a 2 s scene exported for 30 s at 30 fps is 900 frames.
    await ask("project", { action: "create", id: "ask-long", width: 320, height: 180, duration: 2, background: "#15191e" });
    const longer = await ask("render", { action: "start", project: "ask-long", quality: "final", options: { format: "mp4", fps: 30, duration: 30 } });
    assert.equal(longer.data?.status, "awaiting_approval", longer.text);
    assert.match(longer.data.summary, /900 frames, over 600/);
    const exported = await ask("project", { action: "manage", id: "ask-long", options: { resource: "exports", action: "start", quality: "final", options: { format: "mp4", duration: 30 } } });
    assert.equal(exported.data?.status, "awaiting_approval", exported.text);
    assert.match(exported.data.summary, /900 frames, over 600/);
    // Lottie is 60 fps when fps is left out: a 12 s scene is 720 frames.
    await ask("project", { action: "create", id: "ask-lottie", width: 320, height: 180, duration: 12, background: "#15191e" });
    const lottie = await ask("project", { action: "manage", id: "ask-lottie", options: { resource: "exports", action: "start", quality: "final", options: { format: "lottie" } } });
    assert.equal(lottie.data?.status, "awaiting_approval", lottie.text);
    assert.match(lottie.data.summary, /a final lottie of 1 scene at rev \d+ \(720 frames, over 600\)/);
    // A main component named in sceneIds is exported too, so its frames count.
    await ask("project", { action: "create", id: "ask-component", width: 320, height: 180, duration: 2, background: "#15191e" });
    await ask("edit", { project: "ask-component", ops: [{ op: "create_component", scene: "s1" }] });
    const component = (await read("ask-component")).document.scenes[0];
    assert.equal(component.isComponent, true);
    const named = await ask("project", { action: "manage", id: "ask-component", options: { resource: "exports", action: "start", quality: "final", sceneIds: [component.id], options: { format: "mp4", fps: 30, duration: 30 } } });
    assert.equal(named.data?.status, "awaiting_approval", named.text);
    assert.match(named.data.summary, /a final mp4 of 1 scene at rev \d+ \(900 frames, over 600\)/);
  } finally {
    await asking.stop();
  }
});

test("Approvals: an allowed bulk or folder delete removes only what it named, and asks again before removing more", async () => {
  // A server with the default approval rules (every kind asks), answered from a dashboard window.
  const asking = await startTestServer();
  try {
    const ask = async (verb, body) => (await (await asking.api(`/api/agent/${verb}`, { method: "POST", body })).json());
    const read = async (id) => (await asking.api(`/api/projects/${id}`)).json();
    const { key } = await (await asking.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: asking.baseUrl } })).json();
    const allow = async (id) => (await (await asking.api(`/api/dashboard/approvals/${id}`, { method: "POST", headers: { "x-kino-review": key }, body: { decision: "allow" } })).json()).approval;
    const variants = async () => (await read("named-bulk")).document.scenes.filter((scene) => scene.bulkVariant).map((scene) => scene.bulkVariant.key).sort();
    await ask("project", { action: "create", id: "named-bulk", width: 320, height: 180, duration: 2, background: "#15191e" });
    await ask("edit", { project: "named-bulk", ops: [{ op: "add_layer", layerType: "text", name: "Title", properties: { text: "Base", x: 40, y: 40, width: 240, height: 80, fontSize: 36, fill: "#ffffff" } }] });
    await ask("edit", { project: "named-bulk", ops: [{ op: "bulk_create", scene: "s1", csv: "id,Title\none,One\ntwo,Two\n" }] });

    // The approval names "two". The agent keeps working and adds "three" before the person answers.
    const first = await ask("edit", { project: "named-bulk", ops: [{ op: "bulk_create", scene: "s1", csv: "id,Title\none,One\n", deleteMissing: true }] });
    assert.equal(first.data?.status, "awaiting_approval", first.text);
    assert.match(first.data.summary, /deleting 1 scene in named-bulk: \S+ \('[^']* - two'\)$/);
    // The approval keeps the id of the scene it names in dashboard.json (so it survives a
    // restart); the dashboard and its stream get only the summary.
    const two = (await read("named-bulk")).document.scenes.find((scene) => scene.bulkVariant?.key === "two");
    const stored = JSON.parse(await readFile(`${asking.dataDirectory}/agent/dashboard.json`, "utf8")).approvals.find((entry) => entry.id === first.data.id);
    assert.deepEqual(stored.targets, { "delete-scene": [two.id] });
    const shown = (await (await asking.api("/api/dashboard/snapshot?project=named-bulk")).json()).approvals.find((entry) => entry.id === first.data.id);
    assert.equal(shown.summary, first.data.summary);
    assert.equal(shown.targets, undefined);
    const added = await ask("edit", { project: "named-bulk", ops: [{ op: "bulk_create", scene: "s1", csv: "id,Title\none,One\ntwo,Two\nthree,Three\n" }] });
    assert.equal(added.isError, undefined, added.text);
    const revision = (await read("named-bulk")).revision;
    // Allowing it now would also delete "three", which the person never saw named: nothing is
    // deleted and a new approval names both.
    const allowed = await allow(first.data.id);
    assert.equal(allowed.status, "allowed");
    assert.equal(allowed.result.isError, false, allowed.result.text);
    const again = allowed.result.text.match(/^Not run: it would now do more than the approval named, so it asks again as (Q\d+): (.*)$/);
    assert.ok(again, allowed.result.text);
    assert.match(again[2], /^deleting 2 scenes in named-bulk: /);
    assert.match(again[2], /- two'/);
    assert.match(again[2], /- three'/);
    assert.equal((await read("named-bulk")).revision, revision, "nothing was saved");
    assert.deepEqual(await variants(), ["one", "three", "two"]);
    const told = await ask("status", { project: "named-bulk" });
    assert.match(told.text, new RegExp(`${first.data.id} allowed: Not run: .*asks again as ${again[1]}`));
    // Allowing the new approval deletes the two scenes it named.
    const second = await allow(again[1]);
    assert.equal(second.result.isError, false, second.result.text);
    assert.doesNotMatch(second.result.text, /Not run/);
    assert.deepEqual(await variants(), ["one"]);

    // A folder: the approval names pa. The agent then moves pb into the folder.
    const trashed = async () => (await ask("project", { action: "manage", options: { resource: "trash", action: "list" } })).data.projects.map((entry) => entry.id).sort();
    for (const id of ["pa", "pb"]) await ask("project", { action: "create", id, width: 320, height: 180, duration: 2, background: "#15191e" });
    const folder = await ask("project", { action: "manage", options: { resource: "folders", action: "create", name: "F" } });
    const moveTo = (id, folderId) => ask("project", { action: "manage", id, options: { resource: "folders", action: "move", folderId } });
    await moveTo("pa", folder.data.id);
    const deleting = await ask("project", { action: "manage", options: { resource: "folders", action: "delete", id: folder.data.id } });
    assert.equal(deleting.data?.status, "awaiting_approval", deleting.text);
    assert.match(deleting.data.summary, /archiving 1 project by deleting folder 'F': pa/);
    await moveTo("pb", folder.data.id);
    const folderAllowed = await allow(deleting.data.id);
    const folderAgain = folderAllowed.result.text.match(/asks again as (Q\d+): (archiving 2 projects by deleting folder 'F': .*)$/);
    assert.ok(folderAgain, folderAllowed.result.text);
    assert.deepEqual(await trashed(), [], "no project went to Trash");
    assert.equal((await read("pb")).folderId, folder.data.id);
    // pb leaves the folder again: the new approval named pa and pb, so deleting the folder with
    // only pa in it goes ahead and moves just pa to Trash.
    await moveTo("pb", null);
    const folderSecond = await allow(folderAgain[1]);
    assert.equal(folderSecond.result.isError, false, folderSecond.result.text);
    assert.doesNotMatch(folderSecond.result.text, /Not run/);
    assert.deepEqual(await trashed(), ["pa"]);
    assert.equal((await read("pb")).folderId, null);
    const folders = await ask("project", { action: "manage", options: { resource: "folders", action: "list" } });
    assert.ok(!folders.data.folders.some((entry) => entry.id === folder.data.id), folders.text);
  } finally {
    await asking.stop();
  }
});

test("Import compatibility: local JSON and motion files migrate versions 1 through 5 without overwriting source", async () => {
  await create("legacy-source"); await edit("legacy-source", [box()]);
  const original = await saved("legacy-source");
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken });
  for (let version = 1; version <= 5; version += 1) {
    const legacy = { ...original.document, version, futureMetadata: { retained: true } };
    const file = `${server.dataDirectory}/legacy-v${version}.${version % 2 ? "motion" : "json"}`;
    await writeFile(file, JSON.stringify(legacy));
    const imported = await client.importFile(file);
    assert.notEqual(imported.project, "legacy-source");
    const record = await saved(imported.project);
    assert.equal(record.document.version, 6);
    assert.deepEqual(record.document.futureMetadata, { retained: true });
    assert.deepEqual(await pixels(imported.project), await pixels("legacy-source"));
  }
  assert.deepEqual(await saved("legacy-source"), original);
});

test("Import and Bulk Create: project roundtrip and CSV review use saved state and real frames", async () => {
  await create("document-reach");
  await edit("document-reach", [{ op: "add_layer", layerType: "text", name: "Title", properties: { text: "Original", x: 40, y: 40, width: 240, height: 80, fontSize: 36, fill: "#ffffff" } }]);
  const exported = await manage("document-reach", "document", "export");
  const doc = { ...exported.data.document, id: "document-roundtrip" };
  await manage(null, "document", "import", { document: doc });
  assert.deepEqual(await pixels("document-roundtrip"), await pixels("document-reach"));
  const csv = await manage("document-reach", "csv", "template");
  assert.match(csv.data.csv, /id,Title,info_log/);
  assert.match((await manage("document-reach", "csv", "template", { variants: true })).data.csv, /Base scene \(not created\)/);
  const before = await saved("document-reach");
  const review = await manage("document-reach", "csv", "review", { csv: "id,Title\none,Changed\n" });
  assert.match(review.data.csv, /Preview:/);
  assert.equal((await saved("document-reach")).revision, before.revision);
  const image = await readImage(await pixels("document-reach"));
  assert.equal(image.width, 320);
  const preview = await edit("document-reach", [{ op: "bulk_create", csv: "id,Title\none,Changed\n" }], { dry_run: true });
  assert.equal(preview.data.summaries[0].preview, true);
  assert.equal((await saved("document-reach")).revision, before.revision);
  const applied = await edit("document-reach", [{ op: "bulk_create", csv: "id,Title\none,Changed\n" }]);
  assert.match(applied.data.summaries[0].csv, /id,Title,info_log/);
  assert.match(applied.data.summaries[0].csv, /one,Changed,Created/);
  assert.equal(applied.data.summaries[0].preview, undefined);
});

test("Templates: every original template creates independent saved projects with matching rendered pixels", async () => {
  const catalog = await manage(null, "templates", "list");
  assert.equal(catalog.data.templates.length, 4);
  for (const template of catalog.data.templates) {
    const first = await manage(null, "templates", "create", { id: template.id });
    const second = await manage(null, "templates", "create", { id: template.id });
    assert.notEqual(first.data.project, second.data.project);
    const expected = await renderFrame({ document: createTemplateDocument(template.id), width: 320 }, 1);
    assert.deepEqual(await pixels(first.data.project), expected, `${template.id} pixels match the original factory`);
    assert.deepEqual(await pixels(second.data.project), expected);
  }
});

// ---- Pieces: saved layers or scenes, used in other projects and passed on as one .kinopiece file ----
const require = createRequire(import.meta.url);
function hasElectron() {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try { return existsSync(require("electron")); } catch { return false; }
}
const BAR_SCRIPT = `export default function setup(layer) {
  const ctx = layer.canvas.getContext("2d");
  return function draw(frame) { ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, frame.width * frame.values.reveal, frame.height); };
}`;
const near = (pixel, [r, g, b]) => Math.abs(pixel[0] - r) < 30 && Math.abs(pixel[1] - g) < 30 && Math.abs(pixel[2] - b) < 30;

test("Pieces: saved from project A, A deleted, used in B and in a second workspace after export and import, drawing the same pixels", { timeout: 120_000 }, async () => {
  const scripts = hasElectron();
  await create("piece-a");
  const png = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#00ff00"/></svg>').render().asPng());
  const upload = await server.api("/api/media?project=piece-a", { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "green.png" }, body: png });
  assert.equal(upload.status, 201);
  const { src } = await upload.json();
  await edit("piece-a", [
    { op: "add_layer", layerType: "rectangle", name: "badge", properties: { x: 10, y: 10, width: 60, height: 40, fill: "#0000ff" } },
    { op: "add_animation", layer: "badge", preset: "move", start: 0, duration: 0.5, easing: "linear", from: { x: -50 }, to: { x: 10 } },
    { op: "add_layer", layerType: "text", name: "caption", properties: { text: "Hi", x: 100, y: 10, width: 200, height: 40, fontSize: 30, fill: "#ffffff" } },
    { op: "add_layer", layerType: "image", name: "logo", properties: { src, x: 10, y: 70, width: 64, height: 64 } },
    ...(scripts ? [{ op: "add_layer", layerType: "script", name: "bar", properties: { x: 100, y: 70, width: 200, height: 60, script: BAR_SCRIPT,
      inputs: [{ key: "reveal", type: "number", min: 0, max: 1 }, { key: "pic", type: "image" }], values: { reveal: 1, pic: src } } }] : []),
  ]);
  const names = ["badge", "caption", "logo", ...(scripts ? ["bar"] : [])];

  // Save, list: one short line each; a taken name is refused with replace:true named.
  const savedPiece = await manage("piece-a", "pieces", "save", { name: "Hero card", layers: names, description: "badge, caption, logo" });
  assert.match(savedPiece.text, /^Saved piece Hero card \(layers /);
  const again = await manage("piece-a", "pieces", "save", { name: "hero card", layers: ["badge"] }, true);
  assert.match(again.text, /already exists.*replace:true/);
  const listed = await manage(null, "pieces", "list");
  assert.ok(listed.text.split("\n")[0].length <= 120, listed.text);
  assert.match(listed.text, /320x180, [\d.]+s, \d layers, needs 0 fonts and 1 media/);
  await create("piece-b");
  const hint = await edit("piece-b", [{ op: "use_piece", piece: "Hero crad" }], {}, true);
  assert.match(hint.text, /No piece .{1,3}Hero crad.{1,3}\. Did you mean .{1,3}Hero card.{1,3}\?/);

  // A's project is deleted for good; the piece keeps its picture.
  await call("project", { action: "archive", id: "piece-a" });
  await manage(null, "trash", "delete", { id: "piece-a", confirm: true });
  assert.equal((await server.api("/api/projects/piece-a")).status, 404);
  assert.equal((await server.api(src)).status, 200, "the piece's picture outlives its project");

  // Use it in B: one undoable revision, shifted to start at 0.5 s with its top left at 20,20.
  await edit("piece-b", [{ op: "use_piece", piece: "Hero card", at: 0.5, x: 20, y: 20 }]);
  assert.equal((await saved("piece-b")).document.scenes[0].layers.length, names.length);
  const framePath = async (id, t) => (await call("look", { project: id, mode: "frame", t, width: 320 })).images[0].path;
  const late = await readImage(await readFile(await framePath("piece-b", 1.5)));
  const early = await readImage(await readFile(await framePath("piece-b", 0.75)));
  assert.ok(near(late.pixel(50, 40), [0, 0, 255]), `the badge is blue at 1.5 s: ${late.pixel(50, 40)}`);
  assert.ok(near(late.pixel(50, 110), [0, 255, 0]), `the picture is green: ${late.pixel(50, 110)}`);
  if (scripts) assert.ok(near(late.pixel(200, 110), [255, 0, 0]), `the script layer draws its red bar: ${late.pixel(200, 110)}`);
  const badge = (await saved("piece-b")).document.scenes[0].layers.find((layer) => layer.name === "badge");
  assert.equal(badge.animations[0].start, 0.5, "the piece's first animation starts at 0.5 s");
  // Halfway through the shifted move (0.75 s) the badge spans -10 to 50; unshifted it would be at rest, spanning 20 to 80.
  assert.ok(!near(early.pixel(60, 40), [0, 0, 255]) && near(late.pixel(60, 40), [0, 0, 255]), `the move runs from 0.5 s: ${early.pixel(60, 40)}`);

  // One file out, into a second workspace, used there: the same pixels.
  const exported = await manage(null, "pieces", "export", { piece: "Hero card" });
  assert.match(exported.text, /^Wrote .*Hero card\.kinopiece \(\d+ bytes, 1 media file\)/);
  const other = await startTestServer({ allow: REACH_ALLOW });
  try {
    const otherCall = async (verb, body) => {
      const result = await (await other.api(`/api/agent/${verb}`, { method: "POST", body })).json();
      assert.equal(result.isError, undefined, result.text);
      return result;
    };
    const client = createAgentClient({ url: other.baseUrl, ownerToken: other.ownerToken });
    const imported = await client.importFile(exported.data.path);
    assert.match(imported.reply.text, /^Imported piece Hero card \(layers /);
    assert.equal((await other.api(src)).status, 200, "its picture came along under the same name");
    await otherCall("project", { action: "create", id: "piece-c", width: 320, height: 180, duration: 2, background: "#15191e" });
    await otherCall("edit", { project: "piece-c", ops: [{ op: "use_piece", piece: "Hero card", at: 0.5, x: 20, y: 20 }] });
    const reply = await otherCall("look", { project: "piece-c", mode: "frame", t: 1.5, width: 320 });
    assert.deepEqual(await readFile(reply.images[0].path), await readFile(await framePath("piece-b", 1.5)), "the imported piece draws the same frame");
    const twice = await client.importFile(exported.data.path);
    assert.match(twice.refused.text, /already exists/);
  } finally { await other.stop(); }
});

// A zip written by hand, so a test can make the files a careless or hostile maker would.
function rawZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0), link = false, declared } of entries) {
    const nameBytes = Buffer.from(name), body = Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(link ? 0x031e : 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(body), 16); central.writeUInt32LE(declared ?? body.length, 20); central.writeUInt32LE(declared ?? body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(link ? 0xa1ff0000 : 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("Pieces: a hostile or broken .kinopiece file is refused with a sentence saying what is wrong", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-piece-hostile-"));
  try {
    const stored = [];
    const pieces = createPieces({ directory: path.join(directory, "pieces"), mediaRoot: directory, workDirectory: path.join(directory, "work"), importMedia: async (files) => { stored.push(...files); } });
    const refused = async (name, entries, pattern) => {
      const file = path.join(directory, `${name}.kinopiece`);
      await writeFile(file, Buffer.isBuffer(entries) ? entries : rawZip(entries));
      await assert.rejects(pieces.importFrom(file), pattern, name);
      return file;
    };
    const json = Buffer.from("{}");
    await refused("slip", [{ name: "piece.json", data: json }, { name: "media/../../evil.png", data: "x" }], /unsafe path/);
    await refused("absolute", [{ name: "piece.json", data: json }, { name: "/etc/passwd", data: "x" }], /unsafe path/);
    await refused("backslash", [{ name: "piece.json", data: json }, { name: "media\\a.png", data: "x" }], /unsafe path/);
    await refused("other", [{ name: "piece.json", data: json }, { name: "script.sh", data: "x" }], /"script.sh" is not allowed/);
    await refused("link", [{ name: "piece.json", data: json }, { name: "media/0a.png", data: "/etc/passwd", link: true }], /is a link/);
    const twice = await refused("twice", [{ name: "piece.json", data: json }, { name: "piece.json", data: json }], /appears twice/);
    await refused("noJson", [{ name: "media/0a.png", data: "x" }], /no piece\.json/);
    await refused("notZip", Buffer.from("this is not a zip file at all, just text"), /not a zip file/);
    await refused("broken", [{ name: "piece.json", data: Buffer.from("{ nope") }], /piece\.json is not valid JSON/);
    await refused("wrongFormat", [{ name: "piece.json", data: Buffer.from('{"format":"other"}') }], /not a kino piece file/);
    await refused("badContents", [{ name: "piece.json", data: Buffer.from(JSON.stringify({ format: "kino.piece", version: 1, name: "x", kind: "layers", envelope: { format: "kino.clipboard", kind: "layers", layers: [{ id: "a", type: "banana" }] } })) }], /contents are not valid/);
    await refused("oversized", rawZip([{ name: "piece.json", data: json }, { name: "media/0a.png", data: "x", declared: 2 ** 31 }]), /"media\/0a\.png" is \d+ bytes; the limit/);
    await assert.rejects(openPieceFile(twice, { entries: 1, mediaBytes: 10, jsonBytes: 10, totalBytes: 100 }), /holds 2 entries; at most 1/);
    assert.equal(stored.length, 0, "nothing was stored for any refused file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Pieces: a media file of the wrong kind inside a piece file is refused and leaves nothing in the library", async () => {
  const other = await startTestServer({ allow: REACH_ALLOW });
  const directory = await mkdtemp(path.join(tmpdir(), "kino-piece-kind-"));
  try {
    const id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a.png";
    const envelope = { format: "kino.clipboard", version: 6, kind: "layers", source: { documentId: "d", sceneId: "s" }, layers: [{ id: "p", type: "image", name: "pic", src: `/api/media/${id}`, x: 0, y: 0, width: 10, height: 10, animations: [] }], roots: [{ id: "p", parentId: null }], masks: [], components: [], media: [], fonts: [] };
    const piece = { format: "kino.piece", version: 1, name: "Fake", kind: "layers", envelope, canvas: { width: 320, height: 180 }, files: [{ id, name: "pic.png", mime: "image/png" }] };
    const file = path.join(directory, "fake.kinopiece");
    await writeFile(file, rawZip([{ name: "piece.json", data: JSON.stringify(piece) }, { name: `media/${id}`, data: "MZ this is a program, not a picture" }]));
    const client = createAgentClient({ url: other.baseUrl, ownerToken: other.ownerToken });
    assert.match((await client.importFile(file)).refused.text, /is not really image\/png: its first bytes do not match/);
    assert.equal((await other.api(`/api/media/${id}`)).status, 404);
    const kinds = { ...piece, files: [{ ...piece.files[0], mime: "application/x-msdownload" }] };
    await writeFile(file, rawZip([{ name: "piece.json", data: JSON.stringify(kinds) }, { name: `media/${id}`, data: "x" }]));
    assert.match((await client.importFile(file)).refused.text, /is not a kind kino accepts/);
    assert.equal(await stat(path.join(other.dataDirectory, "pieces")).then(() => true, () => false), false, "no piece was saved");
  } finally { await other.stop(); await rm(directory, { recursive: true, force: true }); }
});
