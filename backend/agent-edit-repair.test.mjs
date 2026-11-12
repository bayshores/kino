// Milestone A2, how a refused edit gets repaired without resending it: one refusal lists every
// failing operation, `edit {retry, fix}` resends the kept operations with only the fixes, and
// common spellings (color words, CSS easing names, codes and names of things made earlier in
// the same edit) are accepted and reported in `fixed`. Runs on a real server with a temporary
// data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { nextCallOf, skipWithoutMediaTools, startTestServer, withoutNext } from "./media.test.support.mjs";
import { skillSection } from "./skill.test.support.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { coverNotes, liftFootage, liftNotes, textUnderNotes } from "./agent/silent-receipts.mjs";
import { seeThrough } from "./agent/picture-alpha.mjs";

let server;
before(async () => {
  server = await startTestServer();
  await agent("project", { action: "create", id: "repair", name: "Repair", width: 640, height: 360, duration: 4 });
});
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "repair", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function saved() {
  const response = await server.api("/api/projects/repair");
  return response.json();
}

const findLayer = (record, id) => record.document.scenes.flatMap((scene) => scene.layers).find((layer) => layer.id === id);

test("one refusal lists every failing op, tries the ops that use a refused layer, and saves nothing", async () => {
  const before = await saved();
  const reply = await agent("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 10, y: 10, width: 50, height: 50 } },
    { op: "add_animation", layer: "box", preset: "preset-fade", start: 0, duration: 0.5, easing: "wiggly" },
    { op: "update_layer", layer: "nothing-here", properties: { x: 1 } },
    { op: "add_layer", layerType: "rectangle", name: "frame", properties: { x: 0, y: 0, width: 10, height: 10, strokeWidth: -4 } },
    { op: "add_animation", layer: "frame", preset: "no-such-preset", start: 0, duration: 0.5 },
    { op: "add_scene", name: "outro", properties: { duration: -2 } },
    { op: "add_layer", scene: "outro", layerType: "ellipse", name: "dot" },
  ] });
  assert.equal(reply.isError, true);
  assert.equal(reply.data.op, 1, "the first problem comes first");
  assert.match(reply.data.reason, /^5 operations refused\. Operation 1 \(add_animation\): Unknown easing "wiggly"\. Easings: smooth, natural/);
  // Op 4 uses the layer op 3 would make. A plain stand-in for that layer lets op 4 be tried in
  // the same edit, so its own problem is listed now instead of after the next retry.
  assert.deepEqual(reply.data.alsoRefused.map((problem) => problem.op), [2, 3, 4, 5]);
  assert.equal(reply.data.alsoRefused[0].type, "update_layer");
  assert.ok(reply.data.alsoRefused[0].didYouMean.length > 0);
  assert.match(reply.data.alsoRefused[2].reason, /no-such-preset/);
  // A refused scene has no stand-in: the op that adds a layer to it is not tried.
  assert.equal(reply.data.notTried, "ops 6 use what a refused op makes");
  assert.match(reply.data.retry, /^E\d+$/);
  assert.match(reply.data.next, /^Nothing was saved\. edit \{retry:"E\d+", fix:\{"1": \{fields to change\}\}\}/);
  assert.equal((await saved()).revision, before.revision, "nothing was saved");
  // The next call fills in the fixes kino knows: the unknown easing and the bad property are left
  // out (not replaced by an unrelated example op); the refusal names the layers not made yet.
  const filled = nextCallOf(reply).input.fix;
  assert.deepEqual(filled["1"], { easing: null });
  assert.deepEqual(filled["3"], { properties: { x: 0, y: 0, width: 10, height: 10 } });
  assert.match(reply.data.notMade, /^Nothing was saved: box, frame, dot do not exist yet\. The next call resends every op\.$/);

  // Send only the fixes: change one field of op 1, drop op 2, replace op 3, fix op 4, drop 5 and 6.
  const retried = await agent("edit", { retry: reply.data.retry, fix: {
    1: { easing: "smooth" },
    2: null,
    3: { op: "add_layer", layerType: "rectangle", name: "frame", properties: { x: 0, y: 0, width: 10, height: 10 } },
    4: { preset: "preset-fade" },
    5: null,
    6: null,
  } });
  assert.equal(retried.isError, undefined, retried.text);
  assert.deepEqual(retried.data.created, { box: "L1", "box.in": "A1", frame: "L2", "frame.in": "A2" });
  const record = await saved();
  assert.equal(record.revision, before.revision + 1);
  assert.equal(record.document.scenes[0].layers.find((layer) => layer.id === "box").animations[0].easing, "smooth");

  // A refusal ends with the call that fixes it (next-call.mjs): a misspelled name gets kino's
  // suggestion, and that call works as sent.
  const typo = await agent("edit", { ops: [{ op: "update_layer", layer: "bxo", properties: { x: 20 } }] });
  const next = nextCallOf(typo);
  assert.deepEqual(next, { tool: "edit", input: { retry: typo.data.retry, fix: { 0: { op: "update_layer", layer: "box", properties: { x: 20 } } } } });
  assert.equal((await agent(next.tool, next.input)).isError, undefined);
  // A slot of a next call sent back unfilled is refused, and nothing is saved.
  const slot = await agent("edit", { ops: [{ op: "update_layer", layer: "box", properties: { name: "<your headline>" } }] });
  assert.match(slot.data.reason, /^ops\[0\]\.properties\.name is still "<your headline>", a slot in kino's next call/);
});

test("a refusal names every layer it did not find in `missing`, past the five problems it lists", async () => {
  const before = await saved();
  // A rebuild script deleting what an earlier pass built, after some of it was deleted already.
  const gone = Array.from({ length: 14 }, (_, index) => `gone${index}`);
  const reply = await agent("edit", { ops: gone.map((layer) => ({ op: "delete_layer", layer })) });
  assert.equal(reply.isError, true);
  assert.equal(reply.data.alsoRefused.length, 4);
  assert.equal(reply.data.moreRefused, 9, "only five problems are listed one by one");
  assert.deepEqual(reply.data.missing, { layer: gone }, "but every missing name is");
  // Two missing names are both listed; one alone is the reason itself.
  const two = await agent("edit", { ops: [{ op: "delete_layer", layer: "vignette" }, { op: "update_layer", layer: "box", properties: { x: 12 } }, { op: "delete_layer", layer: "ghost" }] });
  assert.deepEqual(two.data.missing, { layer: ["vignette", "ghost"] });
  const one = await agent("edit", { ops: [{ op: "delete_layer", layer: "ghost" }] });
  assert.equal(one.data.missing, undefined);
  // A list in one op (delete_layers, or delete_layer {layers}) is one op per layer, and each is
  // looked for: before, the first missing name stopped it and there was no missing list.
  for (const op of [{ op: "delete_layers", layers: ["vignette", "box", "fog"] }, { op: "delete_layer", layers: ["vignette", "box", "fog"] }]) {
    const list = await agent("edit", { ops: [op] });
    assert.equal(list.isError, true);
    assert.match(list.data.reason, /^Operation 0 \(delete_layer\): No layer "vignette"\..* 1 more of its 3 parts were refused too \(see missing\)\.$/);
    assert.deepEqual(list.data.missing, { layer: ["vignette", "fog"] });
  }
  assert.equal((await saved()).revision, before.revision, "nothing was saved");
});

test("a rebuild in place lists every name the way edits.md says, even with 120 layers", async () => {
  // edits.md said to list what exists with `status` or `inspect {targets:["*"], fields:["name"]}`.
  // inspect shows at most 10 names, so a script that deleted those kept 110 layers, and its next
  // adds got "-2" names.
  const advice = skillSection("Rebuilding").split("\n- ").find((bullet) => bullet.startsWith("In place:"));
  // The review: "while its last line offers a page" was followed with status {page:2}, which
  // skipped layers 41-80; and it named only the first scene.
  assert.match(advice, /for each scene, `status \{scene, full:true\}`\s+and on while it offers `status \{full:true, page:N\}`/);
  assert.doesNotMatch(advice, /targets:\["\*"\]/, "the inspect form is not offered");
  assert.match(advice, /`inspect` shows at most 10/);

  await agent("project", { action: "create", id: "many", name: "Many", width: 640, height: 360, duration: 4 });
  const names = Array.from({ length: 120 }, (_, index) => `r${String(index).padStart(3, "0")}`);
  const built = await agent("edit", { project: "many", ops: names.map((name, index) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: (index % 12) * 50, y: Math.floor(index / 12) * 30, width: 40, height: 20 } })) });
  assert.equal(built.isError, undefined, built.text);
  const inspected = await agent("inspect", { project: "many", targets: ["*"], fields: ["name"] });
  assert.equal(inspected.data.count, 10, "inspect shows 10 of them");
  // Following each page's footer as written: status lists every name once, with full:true and
  // without it. Before, page 2 left out the 40 layers just read and showed layers 81-120, and
  // the footer of a full:true page said status {page:2}, without full:true.
  const follow = async (first) => {
    const listed = [];
    for (let body = first; body; ) {
      const status = await agent("status", { project: "many", ...body });
      listed.push(...[...status.text.matchAll(/^ {2}L\d+ (\S+) rectangle /gm)].map((match) => match[1]));
      const next = status.text.match(/status \{((?:full:true, )?page:\d+)\} for more/);
      body = next ? Object.fromEntries(next[1].split(", ").map((pair) => pair.split(":")).map(([key, value]) => [key, JSON.parse(value)])) : null;
    }
    return listed;
  };
  assert.deepEqual(await follow({}), names, "every name, once each, the first time");
  const listed = await follow({ full: true });
  assert.deepEqual(listed, names, "every name, once each, with full:true");
  const cleared = await agent("edit", { project: "many", ops: listed.map((layer) => ({ op: "delete_layer", layer })) });
  assert.equal(cleared.isError, undefined, cleared.text);
  const rebuilt = await agent("edit", { project: "many", ops: [{ op: "add_layer", layerType: "rectangle", name: "r000", properties: { width: 40, height: 20 } }] });
  assert.deepEqual(rebuilt.data.created, { r000: "L121" }, "a name added again is the name, not r000-2");
});

test("a rebuild in place that deletes every listed name works with groups: a group's layers go with it", async () => {
  // Before, status lists a group and then its layers (indented under it), so deleting every
  // listed name was refused with "Layer r010 was not found": r010 had gone with its group g1
  // earlier in the same edit, and the refusal's example was the same delete_layer again.
  const advice = skillSection("Rebuilding").split("\n- ").find((bullet) => bullet.startsWith("In place:"));
  assert.match(advice, /indented under a group go with it/);
  await agent("project", { action: "create", id: "nest", name: "Nest", width: 640, height: 360, duration: 4 });
  const names = Array.from({ length: 120 }, (_, index) => `r${String(index).padStart(3, "0")}`);
  const range = (from, count) => names.slice(from, from + count);
  const built = await agent("edit", { project: "nest", ops: [
    ...names.map((name, index) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: (index % 12) * 50, y: Math.floor(index / 12) * 30, width: 40, height: 20 } })),
    { op: "group_layers", layers: range(10, 30), name: "g1" },
    { op: "group_layers", layers: range(15, 10), name: "g2" },
    { op: "group_layers", layers: range(70, 25), name: "g3" },
  ] });
  assert.equal(built.isError, undefined, built.text);
  const listed = [];
  for (let body = { full: true }; body; ) {
    const status = await agent("status", { project: "nest", ...body });
    listed.push(...[...status.text.matchAll(/^ +L\d+ (\S+) (?:rectangle|group) /gm)].map((match) => match[1]));
    const next = status.text.match(/status \{full:true, page:(\d+)\}/);
    body = next ? { full: true, page: Number(next[1]) } : null;
  }
  assert.equal(listed.length, 123, "every rectangle and group is listed once");
  assert.ok(listed.indexOf("g1") < listed.indexOf("r010"), "a group comes before its layers");
  const cleared = await agent("edit", { project: "nest", ops: listed.map((layer) => ({ op: "delete_layer", layer })) });
  assert.equal(cleared.isError, undefined, cleared.text);
  assert.equal(cleared.data.removed.length + (cleared.data.removedMore ?? 0), 123);
  assert.ok(cleared.data.notes.some((note) => /^r010, r011, r012, r013, r014, g2 and \d+ more went with g1 \(op \d+\): deleting a group deletes its layers, so those deletes were skipped\.$/.test(note)), JSON.stringify(cleared.data.notes));
  const record = await (await server.api("/api/projects/nest")).json();
  assert.deepEqual(record.document.scenes.flatMap((scene) => scene.layers), [], "nothing is left");
  // A name sent twice is deleted once, and the second delete is a note too.
  await agent("edit", { project: "nest", ops: [{ op: "add_layer", layerType: "rectangle", name: "plate", properties: { width: 40, height: 20 } }] });
  const twice = await agent("edit", { project: "nest", ops: [{ op: "delete_layer", layer: "plate" }, { op: "delete_layer", layer: "plate" }] });
  assert.equal(twice.isError, undefined, twice.text);
  assert.deepEqual(twice.data.notes, ["plate was already deleted by op 0; the second delete was skipped."]);
  // A layer that never was there is still refused.
  const ghost = await agent("edit", { project: "nest", ops: [{ op: "delete_layer", layer: "ghost" }] });
  assert.equal(ghost.isError, true);
});

test("the receipt lists every taken name in renamed and counts the changed and removed it leaves out", async () => {
  // Before: created stopped at 30 names, so "r80": "r80-2" among 40 adds was hidden behind
  // createdMore, and changed and removed were cut at 30 without a word.
  await agent("project", { action: "create", id: "receipt", name: "Receipt", width: 640, height: 360, duration: 4 });
  const add = (name, index) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: index * 10, y: 10, width: 20, height: 20 } });
  const names = Array.from({ length: 80 }, (_, index) => `r${index + 1}`);
  const built = await agent("edit", { project: "receipt", ops: names.map(add) });
  assert.equal(built.isError, undefined, built.text);
  assert.equal(built.data.renamed, undefined, "no name was taken");
  const again = await agent("edit", { project: "receipt", ops: [
    ...Array.from({ length: 38 }, (_, index) => add(`n${index + 1}`, index)), add("r80", 1), add("r3", 2), add("r3", 3)] });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(Object.keys(again.data.created).length, 30);
  assert.equal(again.data.createdMore, 11);
  assert.deepEqual(again.data.renamed, { r80: "r80-2", r3: ["r3-2", "r3-3"] });
  // Each renamed ID is the layer the agent sent.
  const status = await agent("status", { project: "receipt", full: true, page: 3 });
  assert.match(status.text, / r80-2 rectangle /);

  const edited = await agent("edit", { project: "receipt", ops: [
    ...names.slice(0, 35).map((layer) => ({ op: "update_layer", layer, properties: { fill: "#ff0000" } })),
    ...names.slice(40).map((layer) => ({ op: "delete_layer", layer }))] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal(edited.data.changed.length, 30);
  assert.equal(edited.data.changedMore, 5, "35 changed: 30 listed and 5 more");
  assert.equal(edited.data.removed.length, 30);
  assert.equal(edited.data.removedMore, 10, "40 removed: 30 listed and 10 more");
});

test("a slow push written with scale becomes scaleX and scaleY, listed in fixed", async () => {
  // taste.md's slow push said "scale 1 to 1.12 over 3 s"; from:{scale:1}, to:{scale:1.12} was
  // refused with 'cannot animate unsupported property "scale"' and a preset-slide example.
  await agent("project", { action: "create", id: "push", name: "Push", width: 1280, height: 720, duration: 4 });
  const push = { name: "Push", start: 0, duration: 3, easing: "linear", from: { scale: 1 }, to: { scale: 1.12 } };
  const reply = await agent("edit", { project: "push", ops: [
    { op: "add_layer", layerType: "rectangle", name: "plate", properties: { width: 1280, height: 720, fill: "#203040", role: "background" }, animations: [push] },
    { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 400, y: 200, width: 480, height: 320, fill: "#ffffff" } },
    { op: "add_animation", layer: "card", animation: { kind: "custom", name: "Grow", start: 0.2, duration: 0.6, easing: "ease-out", from: { scale: 0.9, opacity: 0 }, to: { scale: { x: 1, y: 1.05 } } } },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.ok(reply.data.fixed.includes("animation.from/to scale → scaleX, scaleY"), JSON.stringify(reply.data.fixed));
  const animations = (await (await server.api("/api/projects/push")).json()).document.scenes[0].layers.map((layer) => layer.animations[0]);
  assert.deepEqual(animations.map(({ from, to }) => ({ from, to })), [
    { from: { scaleX: 1, scaleY: 1 }, to: { scaleX: 1.12, scaleY: 1.12 } },
    { from: { opacity: 0, scaleX: 0.9, scaleY: 0.9 }, to: { opacity: 1, scaleX: 1, scaleY: 1.05 } },
  ]);
  // The push is slow enough to be linear: check finds no linear_motion on it.
  const check = await agent("check", { project: "push", pixels: false });
  assert.deepEqual(check.data.findings.filter((finding) => finding.ref === "plate" && finding.rule === "linear_motion"), []);
  // update_animation and update_animations take it the same way.
  const changed = await agent("edit", { project: "push", ops: [{ op: "update_animation", animation: "plate.custom", properties: { to: { scale: 1.08 } } }] });
  assert.deepEqual(changed.data.fixed, ["properties.to scale → scaleX, scaleY"]);
  const many = await agent("edit", { project: "push", dry_run: true, ops: [{ op: "update_animations", animationIds: ["plate.custom"], properties: { from: { scale: 1.02 } } }] });
  assert.deepEqual(many.data.fixed, ["properties.from scale → scaleX, scaleY"]);
  // A scale that is not a number is refused with a push that works.
  const refused = await agent("edit", { project: "push", ops: [{ op: "add_animation", layer: "card", animation: { kind: "custom", start: 0, duration: 3, to: { scale: true } } }] });
  assert.equal(refused.isError, true);
  assert.match(refused.data.reason, /an animation has no scale: animate scaleX and scaleY/);
  assert.deepEqual(refused.data.example.animation.to, { scaleX: 1.12, scaleY: 1.12 });
});

test("add_layer takes an inline animation written as edits.md writes one, {kind:\"custom\", …}", async () => {
  // It was refused: 'animations[0]: "kind" is not a field of add_animation. Did you mean id, at,
  // easing?' with a badge rectangle as the example; without kind it was fixed, and only
  // {animation:{…}} was taken as written.
  await agent("project", { action: "create", id: "inline", name: "Inline", width: 1920, height: 1080, duration: 6 });
  const move = { kind: "custom", name: "Move", start: 1, duration: 1.5, to: { x: 200 } };
  const reply = await agent("edit", { project: "inline", ops: [
    { op: "add_layer", layerType: "rectangle", name: "dot", properties: { x: 460, y: 900, width: 40, height: 40 },
      animations: [{ preset: "preset-fade", start: 0, duration: 0.5 }, move] },
    { op: "add_layer", layerType: "rectangle", name: "twin", properties: { x: 460, y: 900, width: 40, height: 40 } },
    { op: "add_animation", layer: "twin", animation: move },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.fixed, undefined, "the shape the docs show needs no fixing");
  const [dot, twin] = (await (await server.api("/api/projects/inline")).json()).document.scenes[0].layers;
  const plain = ({ id, ...rest }) => rest;
  assert.equal(dot.animations.length, 2);
  assert.deepEqual(plain(dot.animations[1]), plain(twin.animations[0]), "the same animation as add_animation {animation} makes");
  assert.deepEqual([dot.animations[1].kind, dot.animations[1].to], ["custom", { x: 200 }]);
});

test("retry needs a kept refused edit of this project, and fix goes with retry", async () => {
  const unknown = await agent("edit", { retry: "E999" });
  assert.equal(unknown.data.error, "not_found");
  assert.match(unknown.data.reason, /No refused edit E999 in this project/);
  const loose = await agent("edit", { ops: [{ op: "update_layer", layer: "box", properties: { x: 20 } }], fix: { 0: null } });
  assert.equal(loose.data.error, "bad_input");
  assert.match(loose.data.reason, /fix goes with retry/);

  const refused = await agent("edit", { ops: [{ op: "update_layer", layer: "box", properties: { x: "far" } }] });
  assert.equal(refused.isError, true);
  const badKey = await agent("edit", { retry: refused.data.retry, fix: { 5: null } });
  assert.match(badKey.data.reason, /fix key "5" is not an op number of E\d+ \(0 to 0\)/);
  // ops given with retry are added after the kept ones.
  const extended = await agent("edit", { retry: refused.data.retry, fix: { 0: { properties: { x: 30 } } }, ops: [{ op: "update_layer", layer: "frame", properties: { y: 40 } }] });
  assert.equal(extended.isError, undefined, extended.text);
  const record = await saved();
  assert.equal(findLayer(record, "box").x, 30);
  assert.equal(findLayer(record, "frame").y, 40);
  // A field fixed to null is removed from the kept op.
  const stray = await agent("edit", { ops: [{ op: "update_layer", layer: "box", properties: { x: 50 }, wobble: 3 }] });
  assert.equal(stray.isError, true, stray.text);
  const cleaned = await agent("edit", { retry: stray.data.retry, fix: { 0: { wobble: null } } });
  assert.equal(cleaned.isError, undefined, cleaned.text);
  assert.equal(findLayer(await saved(), "box").x, 50);
  // ...but source text:null keeps its meaning: it removes the source.
  assert.equal((await agent("edit", { ops: [{ op: "source", name: "brief", text: "hello" }] })).isError, undefined);
  assert.equal((await saved()).document.sources.length, 1);
  const both = await agent("edit", { ops: [{ op: "source", name: "brief", text: "again" }, { op: "update_layer", layer: "box", properties: { x: "far" } }] });
  assert.equal(both.isError, true, both.text);
  const removed = await agent("edit", { retry: both.data.retry, fix: { 0: { text: null }, 1: null } });
  assert.equal(removed.isError, undefined, removed.text);
  assert.deepEqual((await saved()).document.sources ?? [], []);
});

test("color words, rgba() and CSS easing names become kino values and are reported", async () => {
  const reply = await agent("edit", { ops: [
    { op: "update_layer", layer: "box", properties: { fill: "white", stroke: "rgba(255, 0, 0, 0.5)", strokeWidth: 2 } },
    { op: "update_layer", layer: "frame", properties: { fill: "transparent" } },
    { op: "add_animation", layer: "frame", preset: "move", start: 1, duration: 0.5, easing: "easeOutBack" },
    { op: "add_animation", layer: "box", preset: "scale", start: 1, duration: 0.5, easing: "power2.inOut" },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.fixed, [
    'fill "white" → #ffffff', 'stroke "rgba(255, 0, 0, 0.5)" → #ff000080',
    'fill "transparent" → #00000000', 'easing "power2.inOut" → smooth',
  ]);
  const record = await saved();
  assert.equal(findLayer(record, "box").fill, "#ffffff");
  assert.equal(findLayer(record, "box").stroke, "#ff000080");
  assert.equal(findLayer(record, "frame").fill, "#00000000");
  assert.equal(findLayer(record, "frame").animations.at(-1).easing, "back-out");
});

test("a scene or layer made earlier in an edit can be used by the code it will get, or by a new name", async () => {
  const reply = await agent("edit", { ops: [
    { op: "update_scene", scene: "s1", properties: { name: "intro" } },
    { op: "add_layer", scene: "intro", layerType: "ellipse", properties: { x: 5, y: 5, width: 20, height: 20 } },
    { op: "update_layer", layer: "L3", properties: { x: 50 } },
    { op: "add_scene", properties: { width: 640, height: 360, duration: 2 } },
    { op: "add_layer", scene: "s2", layerType: "rectangle", name: "outro-card", properties: { x: 0, y: 0, width: 100, height: 100 } },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.created, { "outro-card": "L4" });
  assert.equal(reply.data.createdCodes, "L3, s2", "things without a readable name are listed once, by code");
  const record = await saved();
  assert.equal(record.document.scenes[0].name, "intro");
  const dot = record.document.scenes[0].layers.find((layer) => layer.type === "ellipse");
  assert.equal(dot.x, 50, "L3 named the ellipse made two ops earlier");
  assert.equal(record.document.scenes[1].layers[0].id, "outro-card", "s2 named the scene made one op earlier");
  const status = await agent("status", { scene: "s2" });
  assert.match(status.text, /L4 outro-card rectangle/);
});

test("after a sheet of every scene, look changed compares every scene", async () => {
  const sheet = await agent("look", { mode: "sheet" });
  assert.equal(sheet.isError, undefined, sheet.text);
  assert.match(sheet.text, /^sheet: one frame \(at 60%\) from each of 2 scenes/);
  const same = await agent("look", { mode: "changed" });
  assert.equal(same.isError, undefined, same.text);
  assert.equal(withoutNext(same.text), "nothing visible changed in the scenes since your last look (2 frames compared)");

  await agent("edit", { ops: [{ op: "update_layer", layer: "outro-card", properties: { fill: "#ff0000" } }] });
  const changed = await agent("look", { mode: "changed" });
  assert.equal(changed.isError, undefined, changed.text);
  assert.match(changed.text, /^changed since your last look at the scenes: s2 · 1\.2s\nimage /);
});

test("an edit you make from the command line reaches the agent's inbox", async () => {
  const yours = await agent("edit", { by: "you", ops: [{ op: "update_layer", layer: "box", properties: { y: 60 } }] });
  assert.equal(yours.isError, undefined, yours.text);
  assert.equal(yours.data.turn, undefined, "your edit is not part of the agent's turn");
  const status = await agent("status");
  assert.match(status.text, /inbox ◆1\n {2}you edited 1 op \(rev \d+→\d+\): box/);
});


test("a card built once as a component is inserted by name, with its own text", async () => {
  // The same ops as the components example in skills/kino/references/building-blocks.md.
  const reply = await agent("edit", { ops: [
    { op: "add_scene", name: "card", width: 560, height: 320 },
    { op: "add_layer", scene: "card", layerType: "text", name: "card-title", properties: { text: "Title", x: 32, y: 32, width: 496, height: 60, fontSize: 44 } },
    { op: "create_component", scene: "card" },
    { op: "insert_component", scene: "s1", component: "card", name: "feature-1", properties: { x: 120, y: 400, componentOverrides: { "card-title": { text: "Shared calendars" } } } },
    { op: "add_animation", layer: "feature-1", preset: "preset-fade", start: 0.2, duration: 0.5 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.fixed, undefined, "component is the documented short name, not a fix");
  assert.equal(reply.data.created["feature-1"], "L6");
  const instance = findLayer(await saved(), "feature-1");
  assert.equal(instance.type, "component");
  assert.equal(instance.componentSceneId, "card");
  assert.deepEqual(instance.componentOverrides, { "card-title": { text: "Shared calendars" } });
  const status = await agent("status", { scene: "s1" });
  assert.match(status.text, /L6 feature-1 component of card 120,400 560×320 \| A\d+ in fade 0\.2–0\.7/);
});

test("a group's name becomes its ID, so the same edit can animate the group", async () => {
  const reply = await agent("edit", { ops: [
    { op: "add_layer", scene: "s2", layerType: "rectangle", name: "chip-a", properties: { x: 0, y: 200, width: 40, height: 40 } },
    { op: "add_layer", scene: "s2", layerType: "rectangle", name: "chip-b", properties: { x: 60, y: 200, width: 40, height: 40 } },
    { op: "group_layers", scene: "s2", layers: ["chip-a", "chip-b"], name: "Chip Row" },
    { op: "add_animation", layer: "chip-row", preset: "preset-fade", start: 0.1, duration: 0.4 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.created["chip-row"], "L9");
  const group = findLayer(await saved(), "chip-row");
  assert.equal(group.type, "group");
  assert.equal(group.name, "Chip Row");
  assert.equal(group.animations[0].preset.id, "fade");
});

test("an answer over 8,000 tokens is saved to a file and the agent gets its first lines", async () => {
  // In a project of its own: every edit of a project lays out all its text again, so long texts
  // would slow the tests after this one. Ten texts of 3,240 characters lay out much faster than
  // four of 13,500 (the time grows faster than the length).
  const project = "long-answer";
  await agent("project", { action: "create", id: project, name: "Long answer", width: 640, height: 360, duration: 4 });
  const words = "Plan the week in one view. ".repeat(120);
  const ops = Array.from({ length: 10 }, (_, index) => ({ op: "add_layer", layerType: "text", name: `long-${index}`, properties: { text: words, x: 0, y: 0, width: 400, height: 100 } }));
  assert.equal((await agent("edit", { project, ops })).isError, undefined);
  const reply = await agent("inspect", { project, targets: ops.map((op) => op.name) });
  assert.equal(reply.isError, undefined, reply.text);
  assert.ok(reply.text.length < 1500, `capped answer is ${reply.text.length} characters`);
  assert.match(withoutNext(reply.text), /\n… \d+ lines, about \d+ tokens: too long to send\. The whole answer is in .*inspect-[0-9a-f]{8}\.txt(\nA smaller answer: .+)?$/);
  assert.match(reply.text, /\nnext: \w+ \{.*\}$/, "a cut-short answer keeps its next call");
  const { readFile } = await import("node:fs/promises");
  const whole = await readFile(reply.data.file, "utf8");
  assert.ok(whole.length > 28_000);
  assert.ok(whole.includes("long-9"));
});

test("library search answers one short line per topic, not the topics' text", async () => {
  const reply = await agent("library", { topic: "search", search: "stagger" });
  assert.equal(reply.isError, undefined, reply.text);
  assert.match(reply.text, /^ops: stagger_animations \(library \{topic:"op", name\}\)\ntopics \(library \{topic:"rules", name\} reads one\):\n/);
  assert.match(reply.text, /^stagger \(Staggering animations\): /m);
  assert.ok(reply.text.split("\n").every((line) => line.length <= 220), "every line is short");
  assert.ok(reply.text.length < 3000, `search answer is ${reply.text.length} characters`);
  // A phrase is split into words; the topics holding the most of them come first.
  const phrase = await agent("library", { topic: "search", search: "crop video layer and word by word text reveal synced to speech" });
  // Moves and effects named by the phrase come first ("kino names for it:"), then ops, then topics.
  const lines = phrase.text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("topics (")) + 1;
  const shown = lines.slice(first, first + 8).map((line) => line.split(" ")[0]);
  for (const id of ["captions", "text-animation", "speech"]) assert.ok(shown.includes(id), `${id} is near the top: ${shown}`);
  // A move is found by the words an agent types for what it does.
  assert.match((await agent("library", { topic: "search", search: "color flash behind subject" })).text, /backdrop-flash/);
  const none = await agent("library", { topic: "search", search: "zzqx" });
  assert.equal(withoutNext(none.text), 'Nothing mentions "zzqx". library {topic:"rules"} lists every topic.');
});

test("render says when the project has scenes the file leaves out", { skip: skipWithoutMediaTools }, async () => {
  const started = await agent("render", { action: "start", quality: "draft", scene: "s2" });
  // s1 is the other scene; the component's scene "card" is drawn inside s1, so it is not counted.
  assert.match(started.text, /The other 1 scene is not in this file/);
  assert.equal(started.data.otherScenes, 1);
  await agent("render", { action: "cancel", job: started.data.job });
});

test("CSS corner names become radius, and a property no layer has is refused", async () => {
  const scene = (await saved()).document.scenes[0].id;
  const made = await agent("edit", { ops: [
    { op: "add_layer", sceneId: scene, layerType: "rectangle", name: "corner-card", properties: { x: 0, y: 0, width: 80, height: 40, cornerRadius: 12 } },
    { op: "add_layer", sceneId: scene, layerType: "rectangle", name: "corner-tile", properties: { x: 0, y: 50, width: 80, height: 40, borderRadius: [4, 4, 0, 0] } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  assert.deepEqual(made.data.fixed, ["cornerRadius → radius", "borderRadius → cornerRadii"]);
  const record = await saved();
  assert.equal(findLayer(record, "corner-card").radius, 12);
  assert.equal(findLayer(record, "corner-card").cornerRadius, undefined, "the CSS name is not saved");
  assert.deepEqual(findLayer(record, "corner-tile").cornerRadii, [4, 4, 0, 0]);

  const refused = await agent("edit", { ops: [{ op: "update_layer", layer: "corner-card", properties: { opacty: 0.5 } }] });
  assert.equal(refused.isError, true);
  assert.match(JSON.parse(refused.text).reason, /"opacty" is not a layer property\. Did you mean opacity/);
  assert.equal((await saved()).revision, record.revision, "nothing was saved");
});

test("a scene may last ten minutes; a longer scene or an animation ending later is refused with the limit named", async () => {
  const before = await saved();
  const tooLong = await agent("edit", { ops: [{ op: "add_scene", name: "too-long", properties: { duration: 600.5 } }] });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.data.reason, /600/, tooLong.data.reason);
  assert.equal((await saved()).revision, before.revision, "nothing was saved");

  const made = await agent("edit", { ops: [
    { op: "add_scene", name: "song", properties: { duration: 600 } },
    { op: "add_layer", scene: "song", layerType: "rectangle", name: "last-flash", properties: { x: 0, y: 0, width: 640, height: 360 },
      animations: [{ preset: "show", start: 599 }, { preset: "hide", start: 599.5 }] },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const song = (await saved()).document.scenes.find((scene) => scene.name === "song");
  assert.equal(song.duration, 600);

  const late = await agent("edit", { ops: [{ op: "add_animation", layer: "last-flash", preset: "preset-fade", start: 599.8, duration: 0.5 }] });
  assert.equal(late.isError, true);
  assert.match(late.data.reason, /600 seconds/, late.data.reason);

  // A sheet of the whole song has frames almost a minute apart, and says how to see a stretch of
  // it; from and to spread the 12 frames over that stretch.
  const whole = await agent("look", { mode: "sheet", scene: "song", inline: false });
  assert.equal(whole.isError, undefined, whole.text);
  assert.match(whole.text, /^sheet [^:]+: 1=0s 2=54\.54s .* 12=599\.95s \(54\.54s apart; look \{mode:"sheet", from, to\} spreads 12 over a stretch\)\n/);
  const end = await agent("look", { mode: "sheet", scene: "song", from: 594, to: 600, inline: false });
  assert.equal(end.isError, undefined, end.text);
  assert.match(end.text, /^sheet [^:]+: 1=594s 2=594\.54s .* 12=599\.95s\n/);
  const backwards = await agent("look", { mode: "sheet", scene: "song", from: 30, to: 20 });
  assert.equal(backwards.isError, true);
  assert.match(backwards.text, /from must be before to/);
  const removed = await agent("edit", { ops: [{ op: "delete_scene", scene: "song" }] });
  assert.equal(removed.isError, undefined, removed.text);
});

test("a name given to add_animation and import_svg is kept and found later; a preset on a repeater is said in the receipt", async () => {
  const made = await agent("edit", { ops: [{ op: "add_scene", name: "naming", properties: { duration: 3 } }, { op: "add_layer", scene: "naming", layerType: "rectangle", name: "tile", properties: { x: 10, y: 10, width: 100, height: 100 } }] });
  assert.equal(made.isError, undefined, made.text);
  const named = await agent("edit", { ops: [{ op: "add_animation", layer: "tile", preset: "preset-fade", name: "intro", start: 0, duration: 0.5 }] });
  assert.equal(named.isError, undefined, named.text);
  assert.ok(findLayer(await saved(), "tile").animations.some((animation) => animation.name === "intro"), "the animation keeps its name");

  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect id='a' width='30' height='30' fill='#FF6B4A'/><circle id='b' cx='45' cy='45' r='10' fill='#00f'/></svg>";
  const imported = await agent("edit", { ops: [{ op: "import_svg", scene: "naming", name: "logo", svg }] });
  assert.equal(imported.isError, undefined, imported.text);
  assert.match((imported.data.notes ?? []).join(" "), /import_svg made "logo" \(.+\), "logo 2" \(.+\)/);
  const used = await agent("edit", { ops: [{ op: "update_layer", layer: "logo 2", properties: { x: 50 } }, { op: "update_layer", layer: "logo", properties: { x: 40 } }] });
  assert.equal(used.isError, undefined, `the names logo and logo 2 are found: ${used.text}`);

  const repeater = await agent("edit", { ops: [
    { op: "add_layer", scene: "naming", layerType: "rectangle", name: "dot", properties: { x: 300, y: 100, width: 20, height: 20, repeatCopies: 8, repeatX: 30 } },
    { op: "add_animation", layer: "dot", preset: "preset-pixel", start: 0.2, duration: 1 },
  ] });
  assert.match((repeater.data.warnings ?? []).join(" "), /preset-pixel on dot showed no visible state on a repeater/);
});

test("a full-frame clip made over text that shows at the same time is said with its one reorder call; nothing is reordered", () => {
  const scene = { id: "s", width: 960, height: 540, duration: 4, layers: [
    { id: "title", type: "text", parentId: null, x: 100, y: 200, width: 600, height: 100, opacity: 1, animations: [] },
    { id: "shot", type: "video", parentId: null, x: 0, y: 0, width: 960, height: 540, opacity: 1, animations: [] },
  ] };
  const [cover] = coverNotes({ scenes: [] }, { scenes: [scene] }, ["shot"], (id) => id);
  assert.deepEqual(cover.call.input.ops[0], { op: "move_layers", layers: ["shot"], position: "below", referenceId: "title" });
  assert.match(cover.note, /shot is full-frame and now draws over title .*Nothing was reordered/);
  // A clip that fills half the frame, or text that ends before the clip shows, is not said.
  assert.equal(coverNotes({}, { scenes: [{ ...scene, layers: [scene.layers[0], { ...scene.layers[1], width: 480 }] }] }, ["shot"], (id) => id).length, 0);
  const shown = { ...scene.layers[1], animations: [{ kind: "show", start: 2 }] };
  const gone = { ...scene.layers[0], animations: [{ kind: "hide", start: 1 }] };
  assert.equal(coverNotes({}, { scenes: [{ ...scene, layers: [gone, shown] }] }, ["shot"], (id) => id).length, 0);
});

test("a text given a longer span under footage already above it is said: which footage, from which second, and the one call that keeps the words on top", () => {
  const word = (hide) => ({ id: "word", type: "text", parentId: null, x: 100, y: 200, width: 600, height: 100, opacity: 1, animations: [{ kind: "show", start: 1 }, { kind: "hide", start: hide }] });
  const clipLayer = (id, start, end) => ({ id, type: "video", src: `/api/media/${id}.mp4`, parentId: null, x: 0, y: 0, width: 960, height: 540, opacity: 1, animations: [{ kind: "show", start }, { kind: "hide", start: end }] });
  const scene = (hide) => ({ id: "s", width: 960, height: 540, duration: 12, layers: [word(hide), clipLayer("shot2", 2, 4), clipLayer("shot3", 4, 8)] });
  const [said] = textUnderNotes({ scenes: [scene(2)] }, { scenes: [scene(11.6)] }, [], (id) => id);
  assert.match(said.note, /^word \(on screen 1-11\.6 s\) is under full-frame footage in layer order: shot2 from 2 s to 4 s; shot3 from 4 s to 8 s, so the words do not show there\. Nothing was reordered\./);
  assert.deepEqual(said.call.input.ops[0], { op: "move_layers", layers: ["word"], position: "above", referenceId: "shot3" });
  // A span that did not change, a text above the footage, and footage made in the same edit (coverNotes names it) give no note.
  assert.equal(textUnderNotes({ scenes: [scene(11.6)] }, { scenes: [scene(11.6)] }, [], (id) => id).length, 0);
  assert.equal(textUnderNotes({ scenes: [scene(2)] }, { scenes: [{ ...scene(11.6), layers: scene(11.6).layers.reverse() }] }, [], (id) => id).length, 0);
  assert.equal(textUnderNotes({ scenes: [scene(2)] }, { scenes: [scene(11.6)] }, ["shot2", "shot3"], (id) => id).length, 0);
  // Footage with an alpha channel lets the words show through.
  assert.equal(textUnderNotes({ scenes: [scene(2)] }, { scenes: [scene(11.6)] }, [], (id) => id, { seeThrough: new Set(["/api/media/shot2.mp4", "/api/media/shot3.mp4"]) }).length, 0);
  // So does footage blended over them (screen, multiply): it mixes with the words instead of hiding them.
  const blended = scene(11.6);
  blended.layers = blended.layers.map((layer) => (layer.type === "video" ? { ...layer, blendMode: "screen" } : layer));
  assert.equal(textUnderNotes({ scenes: [scene(2)] }, { scenes: [blended] }, [], (id) => id).length, 0);
});

test("opaque full-frame footage added or moved over words that show at the same time goes under them; a title between a clip and its cut-out stays", () => {
  const video = (id, start, end, extra = {}) => ({ id, type: "video", src: `/api/media/${id}.mp4`, parentId: null, x: 0, y: 0, width: 960, height: 540, opacity: 1, animations: [{ kind: "show", start }, { kind: "hide", start: end }], ...extra });
  const title = { id: "title", type: "text", parentId: null, x: 100, y: 200, width: 600, height: 100, opacity: 1, animations: [] };
  const doc = (...layers) => ({ scenes: [{ id: "s", width: 960, height: 540, duration: 8, layers }] });
  const old = doc(video("shot1", 0, 3), title);
  // A shot added later sits above the held title: it moves below the title, and the note says which layer moved.
  const added = doc(video("shot1", 0, 3), title, video("shot2", 3, 6));
  const lift = liftFootage(old, added);
  assert.deepEqual(lift.ops, [{ type: "move_layers", sceneId: "s", layerIds: ["shot2"], position: "below", referenceId: "title" }]);
  assert.deepEqual(lift.sources, ["/api/media/shot2.mp4"]);
  assert.match(liftNotes(lift.moves, (id) => id)[0], /^shot2 \(full-frame footage, 3-6 s\) covers title at the same time, so kino moved shot2 below title \(the only layer moved\).* move_layers \{layers:\["shot2"\], position:"above", referenceId:"title"\}/);
  // Footage moved above the title in this edit counts too; footage that was already above it, or that shows at another time, does not.
  assert.equal(liftFootage(doc(title, video("shot2", 3, 6)), doc(title, video("shot2", 3, 6))).ops.length, 0, "unchanged order: nothing");
  assert.equal(liftFootage(doc(video("shot2", 3, 6), title), doc(title, video("shot2", 3, 6))).ops.length, 1, "moved above the title");
  assert.equal(liftFootage(old, doc(video("shot1", 0, 3), { ...title, animations: [{ kind: "hide", start: 2 }] }, video("shot2", 3, 6))).ops.length, 0, "title gone before the shot");
  // Alpha files, blended footage, a title an order op names, and a title with a cut-out of a clip above it stay as they are.
  assert.equal(liftFootage(old, added, { seeThrough: new Set(["/api/media/shot2.mp4"]) }).ops.length, 0);
  assert.equal(liftFootage(old, doc(video("shot1", 0, 3), title, video("shot2", 3, 6, { blendMode: "screen" }))).ops.length, 0);
  assert.equal(liftFootage(old, added, { kept: new Set(["title"]) }).ops.length, 0);
  assert.equal(liftFootage(old, added, { kept: new Set(["shot2"]) }).ops.length, 0, "footage an order op named stays");
  // A plate under the title is still covered by the lifted shot: its cover note does not say nothing was reordered.
  const plate = { id: "plate", type: "rectangle", parentId: null, x: 80, y: 190, width: 640, height: 120, opacity: 1, animations: [] };
  const [plateNote] = coverNotes(old, doc(video("shot1", 0, 3), plate, video("shot2", 3, 6), title), ["shot2"], (id) => id, { lifted: new Set(["shot2"]) });
  assert.match(plateNote.note, /draws over plate .*kino moved it under the words only\./);
  // Footage playing through a mask word (masked-type's fill) stays on its mask; a mask word is not words to lift over.
  const word = { ...title, id: "word", isMask: true };
  assert.equal(liftFootage(old, doc(video("shot1", 0, 3), title, word, video("fill", 0, 3))).ops.length, 0, "fill stays on its mask");
  assert.equal(liftFootage(old, doc(video("shot1", 0, 3), word, title, video("shot2", 0, 3))).ops.length, 0, "a title a mask cuts stays on its mask");
  const sandwich = doc(video("clip", 0, 8), title, video("clip-cutout", 0, 8, { cutoutOf: "clip" }));
  assert.equal(liftFootage(doc(video("clip", 0, 8)), sandwich).ops.length, 0, "the cut-out copy is not lifted");
  assert.equal(liftFootage(doc(video("clip", 0, 8), title, video("clip-cutout", 0, 8, { cutoutOf: "clip" })), doc(video("clip", 0, 8), title, video("clip-cutout", 0, 8, { cutoutOf: "clip" }), video("late", 2, 5))).ops.length, 0, "title behind a subject stays");
  // Other opaque footage between the title and the new shot at the same time: the title is not lifted over it.
  assert.equal(liftFootage(doc(title, video("mid", 3, 6)), doc(title, video("mid", 3, 6), video("shot2", 3, 6))).ops.length, 0);
  // A duplicated scene has fresh layer IDs: it takes the order of the scene it matches, so words covered on purpose there stay covered.
  const named = (layer, id, name) => ({ ...layer, id, name });
  const source = { id: "s", width: 960, height: 540, duration: 8, layers: [named(title, "title", "Words"), named(video("x", 0, 3), "shot", "Shot")] };
  const copy = (layers) => ({ id: "s-copy", width: 960, height: 540, duration: 8, layers });
  const duplicate = copy([named(title, "t2", "Words"), named(video("x", 0, 3), "v2", "Shot")]);
  assert.equal(liftFootage({ scenes: [source] }, { scenes: [source, duplicate] }).ops.length, 0, "a duplicate keeps the clip over the words");
  const plain = { ...source, layers: [named(video("x", 0, 3), "shot", "Shot"), named(title, "title", "Words")] };
  assert.equal(liftFootage({ scenes: [plain] }, { scenes: [plain, copy([named(video("x", 0, 3), "v2", "Shot"), named(title, "t2", "Words")])] }).ops.length, 0, "and the words over the clip");
  const extra = copy([duplicate.layers[0], named(video("y", 1, 3), "late2", "Late"), duplicate.layers[1]]);
  assert.deepEqual(liftFootage({ scenes: [source] }, { scenes: [source, extra] }).moves.map((move) => move.footage), ["late2"], "a clip added to the duplicate is still lifted");
});

test("a picture added full-frame over a held title goes under it in the saved order, and the receipt says so", async () => {
  await agent("project", { action: "create", id: "lift", name: "Lift", width: 640, height: 360, duration: 4 });
  const canvas = createCanvas(64, 36);
  canvas.getContext("2d").fillRect(0, 0, 64, 36);
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "solid-lift.png" }, body: canvas.toBuffer("image/png") });
  assert.equal(upload.status, 201);
  const media = await upload.json();
  const src = media.src ?? media.media?.src;
  const made = await agent("edit", { project: "lift", ops: [{ op: "add_layer", layerType: "text", name: "title", properties: { x: 40, y: 100, width: 400, height: 60, text: "Held words", fontFamily: "Inter" } }] });
  assert.equal(made.isError, undefined, made.text);
  const added = await agent("edit", { project: "lift", ops: [{ op: "add_layer", layerType: "image", name: "backdrop", properties: { src, x: 0, y: 0, width: 640, height: 360 } }] });
  assert.equal(added.isError, undefined, added.text);
  assert.match((added.data.notes ?? []).join(" "), /backdrop \(full-frame footage, 0-4 s\) covers title at the same time, so kino moved backdrop below title/);
  assert.ok(!(added.data.notes ?? []).join(" ").includes("Nothing was reordered"), "no cover note for a pair that was lifted");
  const names = (await (await server.api("/api/projects/lift")).json()).document.scenes[0].layers.map((layer) => layer.name);
  assert.deepEqual(names.filter((name) => ["title", "backdrop"].includes(name)), ["backdrop", "title"]);
  // An explicit move_layers that names the title is the agent's own order: it is kept.
  const own = await agent("edit", { project: "lift", ops: [{ op: "add_layer", layerType: "image", name: "second", properties: { src, x: 0, y: 0, width: 640, height: 360 } }, { op: "move_layers", layers: ["second"], position: "above", referenceId: "title" }] });
  assert.equal(own.isError, undefined, own.text);
  assert.ok(!(own.data.notes ?? []).join(" ").includes("kino moved"), own.text);
});

test("a full-frame file with an alpha channel (an alpha WebM, a picture with a clear part) gets no cover note", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kino-alpha-"));
  try {
    // A WebM track header with AlphaMode 1, one without it, a picture with a clear half and an opaque one.
    await writeFile(path.join(root, "glow.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xae, 0x53, 0xc0, 0x81, 0x01]));
    await writeFile(path.join(root, "plain.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xae, 0x53, 0xb0, 0x81, 0x01]));
    const png = (clear) => { const canvas = createCanvas(64, 36); const context = canvas.getContext("2d"); context.fillStyle = "#336699"; context.fillRect(0, 0, clear ? 32 : 64, 36); return canvas.toBuffer("image/png"); };
    await writeFile(path.join(root, "half.png"), png(true));
    await writeFile(path.join(root, "solid.png"), png(false));
    const found = await Promise.all(["glow.webm", "plain.webm", "half.png", "solid.png"].map((name) => seeThrough(root, `/api/media/${name}`)));
    assert.deepEqual(found, [true, false, true, false]);
    const scene = { id: "s", width: 960, height: 540, duration: 4, layers: [
      { id: "title", type: "text", parentId: null, x: 100, y: 200, width: 600, height: 100, opacity: 1, animations: [] },
      { id: "glow", type: "video", src: "/api/media/glow.webm", parentId: null, x: 0, y: 0, width: 960, height: 540, opacity: 1, animations: [] },
    ] };
    assert.equal(coverNotes({}, { scenes: [scene] }, ["glow"], (id) => id, { seeThrough: new Set(["/api/media/glow.webm"]) }).length, 0);
    assert.equal(coverNotes({}, { scenes: [scene] }, ["glow"], (id) => id).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("animation codes hold through a refused edit that tries match_references; delete_animation needs no layer", async () => {
  await agent("project", { action: "create", id: "codes", name: "Codes", width: 640, height: 360, duration: 4 });
  const made = await agent("edit", { project: "codes", ops: ["one", "two"].flatMap((name) => [
    { op: "add_layer", layerType: "rectangle", name, properties: { x: 1, y: 1, width: 10, height: 10 } },
    { op: "add_animation", layer: name, preset: "preset-fade", start: 0, duration: 0.5 }]) });
  const [one, two] = [made.data.created["one.in"], made.data.created["two.in"]];
  assert.match(two, /^A\d+$/);
  // delete_animation runs before match_references, which looks at the document as the edit has it
  // so far: that document lacks the code's animation and must not make its code forgotten.
  const refused = await agent("edit", { project: "codes", ops: [{ op: "delete_animation", animation: one }, { op: "match_references" }, { op: "update_layer", layer: "none-here", properties: { x: 1 } }] });
  assert.equal(refused.isError, true, refused.text);
  assert.equal(refused.data.op, 2, "only the update_layer is refused: the delete_animation by code alone works");
  const read = await agent("inspect", { project: "codes", targets: ["one", "two"] });
  assert.match(read.text, new RegExp(`${one} 'Fade In'`), read.text);
  assert.match(read.text, new RegExp(`${two} 'Fade In'`), read.text);
  assert.match(refused.data.next, /op numbers count from 0 as in "Operation N".* key 3 adds an op after them/);
  // Op numbers count from 0; the key after the last op adds an op (and a list of ops adds several).
  const dropped = await agent("edit", { project: "codes", retry: refused.data.retry, fix: { 2: null, 3: { op: "update_layer", layer: "two", properties: { x: 7 } }, 4: [{ op: "update_layer", layer: "two", properties: { y: 8 } }] } });
  assert.equal(dropped.isError, undefined, dropped.text);
  const placed = (await (await server.api("/api/projects/codes")).json()).document.scenes[0].layers.find((layer) => layer.name === "two");
  assert.deepEqual([placed.x, placed.y], [7, 8]);
  const wrong = await agent("edit", { project: "codes", retry: refused.data.retry, fix: { 3: null } });
  assert.match(wrong.data.reason, /fix key "3" is not an op number of E\d+ \(0 to 2\)\. Op numbers count from 0.* A key from 3 on adds ops/);
  assert.deepEqual(dropped.data.removed, [one]);
});

test("after a check fix:auto that applied nothing, next: names a plain check, not fix:auto again", async () => {
  await agent("edit", { ops: [{ op: "add_scene", name: "quiet", properties: { duration: 2 } }] });
  await agent("check", { fix: "auto" });
  const second = await agent("check", { fix: "auto" });
  assert.equal(second.data.applied?.ops, 0, second.text);
  const edited = await agent("edit", { ops: [{ op: "add_layer", scene: "quiet", layerType: "rectangle", name: "calm", properties: { x: 20, y: 20, width: 40, height: 40 } }] });
  assert.deepEqual(nextCallOf(edited), { tool: "check", input: {} }, edited.text);
});
